import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  JevBodyError,
  defineSchema,
  enumField,
  getPayload,
  getRouteDecision,
  intField,
  jevBody,
  jevRouter,
  scoreField,
  type JevMeta,
} from "../src/index.js";

export const animationSchema = defineSchema({
  effect: enumField(
    {
      fadein: "The shape appears on screen (fade in, appear, show, aparecer)",
      fadeout: "The shape disappears from screen (fade out, hide, desaparecer)",
      bounce: "The shape bounces or jumps (rebotar)",
    },
    { question: "What animation effect does the user want for the shape?" },
  ),
  shape: enumField(
    { circle: "A circle (círculo)", square: "A square or rectangle (cuadrado)", triangle: "A triangle (triángulo)" },
    { question: "Which shape does the user want to animate?" },
  ),
  color: enumField(
    { red: "Red (rojo)", green: "Green (verde)", blue: "Blue (azul)" },
    { question: "Which color is the shape?" },
  ),
  sizePx: intField({ question: "Size of the shape in pixels", optional: true }),
});

export const triageSchema = defineSchema({
  category: enumField(
    {
      bug: "A bug report (something is broken or producing errors)",
      billing: "Charges, invoices, refunds, subscriptions",
      account: "Login, permissions, profile, security",
      feature: "A feature request",
    },
    { question: "Which broad category should handle this ticket?" },
  ),
  severity: scoreField(
    [
      "Cosmetic; no impact to functionality",
      "Broken or degraded feature; workaround exists",
      "Blocking issue; no workaround exists",
    ],
    { question: "How severe is the issue?" },
  ),
  frustration: scoreField(
    ["Calm, matter-of-fact", "Frustrated but civil", "Very angry or threatening to leave"],
    { question: "How frustrated does the customer appear?" },
  ),
  refundRequested: enumField(
    { yes: "The customer explicitly asks for a refund or credit", no: "No explicit refund request" },
    { question: "Is the customer explicitly asking for a refund or credit?" },
  ),
  amount: intField({ question: "Refund or charge amount in dollars (if any)", optional: true }),
});

export const orderSchema = defineSchema({
  product: enumField(
    {
      laptop: "A laptop computer (portátil)",
      phone: "A smartphone (teléfono)",
      tablet: "A tablet",
      headphones: "Headphones or earbuds (audífonos)",
    },
    { question: "Which product does the user want to order?" },
  ),
  shipping: enumField(
    {
      standard: "Standard shipping (envío estándar, normal)",
      express: "Express or fast shipping (envío rápido)",
      overnight: "Overnight or next-day delivery (para mañana)",
    },
    { question: "Which shipping speed does the user want?" },
  ),
  quantity: intField({ question: "How many units of the product to order" }),
  giftWrap: enumField(
    {
      yes: "The order should be gift-wrapped (envuelto para regalo)",
      no: "No gift wrap",
    },
    { question: "Does the user want the order gift-wrapped?", optional: true },
  ),
});

type RouteMeta = Pick<JevMeta, "model" | "usage" | "elapsedMs" | "answers">;

function metaView(meta: JevMeta): RouteMeta {
  return {
    model: meta.model,
    usage: meta.usage,
    elapsedMs: meta.elapsedMs,
    answers: meta.answers,
  };
}

export function buildDemoApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.get("/playground", (_req, res) => {
    const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "playground.html");
    res.type("html").send(readFileSync(htmlPath, "utf8"));
  });

  app.post("/api/animation", jevBody(animationSchema), (req, res) => {
    const payload = getPayload(req, animationSchema);
    res.json({ payload, meta: metaView(req.jevMeta!) });
  });

  app.post("/api/triage", jevBody(triageSchema), (req, res) => {
    const payload = getPayload(req, triageSchema);
    res.json({ payload, meta: metaView(req.jevMeta!) });
  });

  app.post("/api/orders", jevBody(orderSchema), (req, res) => {
    const payload = getPayload(req, orderSchema);
    res.json({ payload, meta: metaView(req.jevMeta!) });
  });

  app.post(
    "/api/orchestrate",
    jevRouter(animationSchema, {
      onComplex: (req, res) => {
        // In production this would call your heavy LLM (OpenAI, Anthropic,
        // an in-house agent, ...). The router sets req.jevRoute so you can
        // apply per-destination restrictions or telemetry.
        const route = getRouteDecision(req);
        res.json({
          destination: route.destination,
          fallback: route.fallback,
          confidence: route.confidence,
          hazard: route.hazard ?? null,
          reply:
            "Stub agent reply: this prompt was routed to the heavy LLM agent because it was ambiguous or creative.",
          routeMeta: metaView(route.meta),
        });
      },
    }),
    (req, res) => {
      const payload = getPayload(req, animationSchema);
      res.json({ destination: "FAST_JSON_PAYLOAD", payload, routeMeta: metaView(req.jevMeta!) });
    },
  );

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof JevBodyError) {
      return res.status(err.status).json(err.body);
    }
    return res.status(500).json({ error: "internal_error", message: (err as Error).message });
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
  const port = Number(process.env.PORT ?? 3000);
  buildDemoApp().listen(port, () => {
    console.log(`JJB demo listening on http://localhost:${port}`);
    console.log(`  GET  /playground`);
    console.log("  POST /api/animation");
    console.log("  POST /api/triage");
    console.log("  POST /api/orders");
    console.log("  POST /api/orchestrate  (semantic router: FAST → JJB, COMPLEX → onComplex)");
  });
}
