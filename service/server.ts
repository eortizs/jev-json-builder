/**
 * Servicio JJB de generación de imágenes (sidecar de People EVE).
 *
 * POST /api/image  { prompt: "<mensaje natural del usuario>" }
 *   → Jev (System One, sin LLM, ~100ms) extrae {accion, sujeto, estilo, aspecto}
 *   → si accion=generar: POST /api/v1/images (OpenRouter) y devuelve la imagen.
 *
 * Respuestas:
 *   200 { status: "generada",  payload, titulo, imagen (data URI), mediaType, costo, modelo, jev }
 *   200 { status: "no-imagen", payload }        ← la intención no es generar una imagen
 *   200 { status: "aclarar",   payload }        ← pide imagen pero sin sujeto suficiente
 *   4xx/5xx { error, ... }                      ← errores Jev (JevBodyError) o OpenRouter
 *
 * Arranque: node --import tsx/esm service/server.ts   (ver .env: TYPESAFE_API_KEY,
 * OPENROUTER_API_KEY, PORT=3030, JJB_IMAGE_MODEL opcional).
 */

import express from "express";
import { fileURLToPath } from "node:url";

import {
  JevBodyError,
  defineSchema,
  enumField,
  getPayload,
  jevBody,
  stringField,
} from "../src/index.js";

const IMAGE_MODEL = process.env.JJB_IMAGE_MODEL ?? "google/gemini-3.1-flash-lite-image";
const IMAGES_URL = "https://openrouter.ai/api/v1/images";
const REQUEST_TIMEOUT_MS = 180_000;

const imageRequestSchema = defineSchema({
  accion: enumField(
    {
      generar:
        "El usuario pide crear, generar, dibujar o ilustrar una imagen nueva (genera/crea/dibuja una imagen de…)",
      otra:
        "Cualquier otra intención: conversación, preguntas, descripciones sin pedir generar, tareas sin imágenes",
    },
    { question: "¿El usuario está pidiendo que se genere una imagen?" },
  ),
  sujeto: stringField({
    question:
      "¿Qué debe mostrar la imagen? Sujeto, escena y detalles visuales concretos que pidió el usuario",
    optional: true,
  }),
  estilo: stringField({
    question:
      "¿Qué estilo visual pide? (acuarela, fotografía realista, pixel art, cartoon, óleo…)",
    optional: true,
  }),
  aspecto: enumField(
    {
      "1:1": "cuadrado / square",
      "3:4": "vertical (retrato) tres por cuatro",
      "4:3": "horizontal (paisaje) cuatro por tres",
      "16:9": "panorámico / widescreen dieciséis por nueve",
      "9:16": "vertical alto (story/reel) nueve por dieciséis",
    },
    { question: "¿Formato o proporción de la imagen que pidió?", optional: true },
  ),
});

type ImagePayload = {
  accion: "generar" | "otra";
  sujeto?: string;
  estilo?: string;
  aspecto?: "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
};

type OpenRouterImagesResponse = {
  data?: { b64_json?: string; media_type?: string }[];
  usage?: { cost?: number };
};

function cleanSujeto(raw: string): string {
  return raw
    .replace(/^\s*(por favor\s+)?(me\s+)?(puedes\s+|podrías\s+)?(genera|generar|crea|crear|haz|hacer|dibuja|dibujar|ilustra|ilustrar)\s+(una|un|la|el|los|las)?\s*(imagen|imágenes|imagenes|dibujo|ilustración|ilustracion|image|picture|foto)?\s*(de|del|que muestre|con)?\s*/i, "")
    .trim();
}

function cleanEstilo(raw: string): string {
  return raw
    .replace(/^\s*(con\s+)?estilo\s+(de\s+)?/i, "")
    .replace(/,?\s*formato\s+[0-9]{1,2}\s*:\s*[0-9]{1,2}.*$/i, "")
    .trim();
}

function composePrompt(p: ImagePayload): string {
  const sujeto = cleanSujeto(p.sujeto?.trim() ?? "");
  const estilo = cleanEstilo(p.estilo?.trim() ?? "");
  const parts = [sujeto];
  if (estilo.length > 0) parts.push(`estilo ${estilo}`);
  return parts.filter(Boolean).join(", ");
}

function titleFrom(p: ImagePayload): string {
  const base = cleanSujeto(p.sujeto?.trim() ?? "") || "imagen";
  const short = base.length > 80 ? `${base.slice(0, 77)}…` : base;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, model: IMAGE_MODEL });
  });

  app.post(
    "/api/image",
    jevBody(imageRequestSchema, { statedThreshold: 0.5 }),
    async (req, res) => {
    const payload = getPayload(req, imageRequestSchema) as ImagePayload;
    const jevMeta = {
      elapsedMs: req.jevMeta?.elapsedMs,
      usage: req.jevMeta?.usage,
    };

    if (payload.accion !== "generar") {
      res.json({ status: "no-imagen", payload, jev: jevMeta });
      return;
    }
    const sujeto = cleanSujeto(payload.sujeto?.trim() ?? "");
    if (sujeto.length < 3) {
      res.json({ status: "aclarar", payload, jev: jevMeta });
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "config", message: "OPENROUTER_API_KEY sin configurar" });
      return;
    }

    const prompt = composePrompt(payload);
    let upstream: Response;
    try {
      upstream = await fetch(IMAGES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/eortizs/jev-json-builder",
          "X-OpenRouter-Title": "JJB image service",
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt,
          ...(payload.aspecto ? { aspect_ratio: payload.aspecto } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      res.status(504).json({
        error: "openrouter_timeout",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 500);
      if (upstream.status === 402) {
        res.status(402).json({ error: "openrouter_credits", detail });
        return;
      }
      res.status(502).json({ error: "openrouter_error", status: upstream.status, detail });
      return;
    }

    const data = (await upstream.json()) as OpenRouterImagesResponse;
    const item = data.data?.[0];
    if (!item?.b64_json) {
      res.status(502).json({ error: "sin_imagen", detail: "la respuesta no trajo imagen" });
      return;
    }

    const mediaType = item.media_type ?? "image/png";
    console.log(
      `[image] prompt="${prompt.slice(0, 80)}" aspecto=${payload.aspecto ?? "auto"} ` +
        `modelo=${IMAGE_MODEL} costo=${data.usage?.cost ?? "?"} jev=${jevMeta.elapsedMs ?? "?"}ms`,
    );

    res.json({
      status: "generada",
      payload,
      titulo: titleFrom(payload),
      imagen: `data:${mediaType};base64,${item.b64_json}`,
      mediaType,
      costo: data.usage?.cost ?? null,
      modelo: IMAGE_MODEL,
      jev: jevMeta,
    });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof JevBodyError) {
      res.status(err.status).json(err.body);
      return;
    }
    res.status(500).json({ error: "internal_error", message: (err as Error).message });
  });

  return app;
}

const isMainModule = (() => {
  try {
    const entry = process.argv[1] ?? "";
    const self = fileURLToPath(import.meta.url);
    return self === entry || self.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const port = Number(process.env.PORT ?? 3030);
  buildApp().listen(port, "127.0.0.1", () => {
    console.log(`JJB image service listening on http://127.0.0.1:${port}`);
    console.log(`  POST /api/image   (Jev → JSON → OpenRouter ${IMAGE_MODEL})`);
    console.log("  GET  /healthz");
  });
}
