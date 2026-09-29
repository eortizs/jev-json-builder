/**
 * OpenRouter image-generation probe for JJB.
 *
 * Validates that `openai/gpt-image-2.5-flare` and
 * `google/gemini-3.1-flash-lite-image` are reachable, generates one image
 * per model via /api/v1/chat/completions, and saves the output to
 * demo/output/. Optionally compares against the dedicated /api/v1/images
 * endpoint.
 *
 * Chat calls follow the official Playground pattern: send
 * `modalities: ["image", "text"]` on the first attempt; if a 200 response
 * comes back without images, retry once without the parameter.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npx tsx demo/image-probe.ts                       # one call per model (default `each`)
 *   OPENROUTER_API_KEY=... npx tsx demo/image-probe.ts --model google/gemini-3.1-flash-lite-image
 *   OPENROUTER_API_KEY=... npx tsx demo/image-probe.ts --chain                # one call with the [a, b] fallback array
 *   OPENROUTER_API_KEY=... npx tsx demo/image-probe.ts --images-api           # hit /api/v1/images (per model, no native fallback)
 *   OPENROUTER_API_KEY=... npx tsx demo/image-probe.ts --catalog              # free: just validate the model slugs exist
 *   npx tsx demo/image-probe.ts "your own image prompt"
 *
 * Exits with code 1 if any call failed.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MODELS = [
  "openai/gpt-image-2.5-flare",
  "google/gemini-3.1-flash-lite-image",
] as const;

type ModelSlug = (typeof MODELS)[number];

const APP_TITLE = "JJB image probe";
const APP_REFERER = "https://github.com/eortizs/jev-json-builder";
const DEFAULT_PROMPT =
  "Generate an image of the world's tallest skyscraper at golden hour, cinematic wide shot, hyperrealistic.";

const OUTPUT_DIR = join(process.cwd(), "demo", "output");
const REQUEST_TIMEOUT_MS = 180_000;
const CATALOG_TIMEOUT_MS = 30_000;

type Args = {
  prompt: string;
  mode: "each" | "chain";
  endpoint: "chat" | "images";
  catalogOnly: boolean;
  model: ModelSlug | null;
  help: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    prompt: DEFAULT_PROMPT,
    mode: "each",
    endpoint: "chat",
    catalogOnly: false,
    model: null,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chain") out.mode = "chain";
    else if (a === "--images-api") out.endpoint = "images";
    else if (a === "--catalog") out.catalogOnly = true;
    else if (a === "--model") {
      const slug = argv[++i];
      if (!slug) throw new Error("--model requires a slug");
      if (!MODELS.includes(slug as ModelSlug)) {
        throw new Error(`--model must be one of: ${MODELS.join(", ")}`);
      }
      out.model = slug as ModelSlug;
    } else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  if (positional.length > 0) out.prompt = positional.join(" ");
  return out;
}

function printHelp(): void {
  console.log(
    [
      "JJB OpenRouter image probe",
      "",
      "Usage:",
      "  tsx demo/image-probe.ts [prompt] [--model <slug>] [--chain] [--images-api] [--catalog] [--help]",
      "",
      "Flags:",
      "  --model <slug>  test only this model (" + MODELS.join(" | ") + ")",
      "  --chain       single call using models fallback array [a, b] (default: one call per model)",
      "  --images-api  hit the dedicated POST /api/v1/images endpoint instead of chat/completions",
      "  --catalog     only validate that the two model slugs are listed in /api/v1/models?output_modalities=image",
      "  --help        show this help",
      "",
      "Env:",
      "  OPENROUTER_API_KEY   required (loaded from --env-file or the shell)",
    ].join("\n"),
  );
}

type CatalogModel = {
  id: string;
  name?: string;
  architecture?: { input_modalities?: readonly string[]; output_modalities?: readonly string[] };
  pricing?: Record<string, string>;
};

async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs: number }): Promise<{ status: number; body: T | string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs) });
  const text = await res.text();
  let body: T | string = text;
  try {
    body = JSON.parse(text) as T;
  } catch {
    /* leave as text */
  }
  return { status: res.status, body };
}

type ImageOutput = { url: string; mime: string };

type OpenRouterImageItem = { type: "image_url"; image_url: { url: string } };

type OpenRouterChatChoice = {
  message?: { content?: string | null; images?: readonly OpenRouterImageItem[] };
};

type OpenRouterChatResponse = {
  id?: string;
  model?: string;
  provider?: string;
  choices?: readonly OpenRouterChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
};

type OpenRouterImagesResponse = {
  data?: readonly { b64_json?: string; media_type?: string }[];
  usage?: { cost?: number };
};

function extForMime(mime: string | undefined): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("svg")) return "svg";
  if (m.startsWith("data:image/")) {
    const sub = m.slice("data:image/".length).split(/[;,]/)[0];
    if (sub === "jpeg" || sub === "jpg") return "jpg";
    if (sub === "svg+xml") return "svg";
    return sub || "img";
  }
  return "png";
}

function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function writeImage(
  model: string,
  index: number,
  out: ImageOutput,
): Promise<{ file: string; bytes: number }> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = nowStamp();
  if (out.url.startsWith("data:")) {
    const comma = out.url.indexOf(",");
    if (comma < 0) throw new Error("Malformed data URI (no comma)");
    const header = out.url.slice(5, comma);
    const payload = out.url.slice(comma + 1);
    const mime = `image/${header.split(";")[0] ?? "png"}`;
    const ext = extForMime(mime);
    const file = join(OUTPUT_DIR, `${safeSlug(model)}-${stamp}-${index}.${ext}`);
    if (!/;base64$/i.test(header)) {
      await writeFile(file, decodeURIComponent(payload), "utf8");
    } else {
      await writeFile(file, Buffer.from(payload, "base64"));
    }
    const s = await stat(file);
    return { file, bytes: s.size };
  }
  const res = await fetch(out.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`image url fetch ${res.status}`);
  const ct = res.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = extForMime(ct);
  const file = join(OUTPUT_DIR, `${safeSlug(model)}-${stamp}-${index}.${ext}`);
  await writeFile(file, buf);
  const s = await stat(file);
  return { file, bytes: s.size };
}

async function callChatCompletions(
  apiKey: string,
  models: readonly string[],
  prompt: string,
  withModalities: boolean,
): Promise<{ status: number; body: OpenRouterChatResponse | string }> {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  const payload: Record<string, unknown> = {
    models: [...models],
    messages: [{ role: "user", content: prompt }],
  };
  if (withModalities) payload.modalities = ["image", "text"];
  const res = await fetchJson<OpenRouterChatResponse>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": APP_REFERER,
      "X-OpenRouter-Title": APP_TITLE,
    },
    body: JSON.stringify(payload),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return { status: res.status, body: res.body };
}

async function callImagesApi(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ status: number; body: OpenRouterImagesResponse | string }> {
  const url = "https://openrouter.ai/api/v1/images";
  const res = await fetchJson<OpenRouterImagesResponse>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": APP_REFERER,
      "X-OpenRouter-Title": APP_TITLE,
    },
    body: JSON.stringify({ model, prompt }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return { status: res.status, body: res.body };
}

async function runCatalogCheck(apiKey: string): Promise<boolean> {
  const url =
    "https://openrouter.ai/api/v1/models?output_modalities=image";
  const res = await fetchJson<{ data: CatalogModel[] }>(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: CATALOG_TIMEOUT_MS,
  });
  if (res.status !== 200) {
    console.error(`[catalog] HTTP ${res.status}`);
    console.error(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2));
    return false;
  }
  const data = res.body;
  if (typeof data !== "object" || !data || !Array.isArray(data.data)) {
    console.error("[catalog] unexpected response shape");
    return false;
  }
  const ids = new Set(data.data.map((m) => m.id));
  let ok = true;
  for (const slug of MODELS) {
    const present = ids.has(slug);
    console.log(`[catalog] ${slug} ${present ? "FOUND" : "MISSING"}`);
    if (!present) ok = false;
  }
  const sample = data.data.find((m) => MODELS.includes(m.id as ModelSlug));
  if (sample?.pricing) {
    console.log(`[catalog] pricing for ${sample.id}:`);
    for (const [k, v] of Object.entries(sample.pricing)) {
      console.log(`  - ${k}: ${v}`);
    }
  }
  return ok;
}

function printUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.prompt_tokens !== undefined) parts.push(`prompt=${usage.prompt_tokens}`);
  if (usage.completion_tokens !== undefined) parts.push(`completion=${usage.completion_tokens}`);
  if (usage.total_tokens !== undefined) parts.push(`total=${usage.total_tokens}`);
  if (usage.cost !== undefined) parts.push(`cost=$${usage.cost}`);
  return parts.length ? ` usage{${parts.join(" ")}}` : "";
}

function renderBodyJson(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

async function handleChatCall(
  apiKey: string,
  models: readonly string[],
  prompt: string,
): Promise<{ ok: boolean; note: string }> {
  console.log(`\n→ chat/completions models=[${models.join(", ")}]`);
  let r = await callChatCompletions(apiKey, models, prompt, true);
  if (r.status !== 200) {
    console.error(`  ✗ HTTP ${r.status}`);
    console.error(renderBodyJson(r.body));
    return { ok: false, note: `http_${r.status}` };
  }
  if (typeof r.body !== "object" || !r.body || !Array.isArray(r.body.choices)) {
    console.error("  ✗ unexpected response shape");
    console.error(renderBodyJson(r.body));
    return { ok: false, note: "bad_shape" };
  }
  const body = r.body;
  const choice = body.choices?.[0];
  const rawImages = choice?.message?.images ?? [];
  let note = "images_with_modalities";
  if (rawImages.length === 0) {
    console.log("  ! no images with modalities:['image','text'], retrying without the parameter");
    r = await callChatCompletions(apiKey, models, prompt, false);
    if (r.status !== 200) {
      console.error(`  ✗ retry HTTP ${r.status}`);
      console.error(renderBodyJson(r.body));
      return { ok: false, note: "retry_http_error" };
    }
    if (typeof r.body !== "object" || !r.body || !Array.isArray(r.body.choices)) {
      console.error("  ✗ retry bad shape");
      console.error(renderBodyJson(r.body));
      return { ok: false, note: "retry_bad_shape" };
    }
    const choice2 = r.body.choices?.[0];
    const imgs2 = choice2?.message?.images ?? [];
    if (imgs2.length === 0) {
      const text = choice2?.message?.content;
      console.log("  ! still no images. Text reply preview:");
      console.log("   ", String(text ?? "(empty)").slice(0, 400).replace(/\n/g, " "));
      return { ok: false, note: "no_images_text_only" };
    }
    note = "images_without_modalities_retry";
    console.log(`  ✓ retry (no modalities) returned ${imgs2.length} image(s); model=${r.body.model} provider=${r.body.provider ?? "?"}${printUsage(r.body.usage)}`);
    return await saveAndReport(r.body, imgs2, note);
  }
  console.log(`  ✓ ${rawImages.length} image(s); model=${body.model} provider=${body.provider ?? "?"}${printUsage(body.usage)}`);
  return await saveAndReport(body, rawImages, note);
}

async function saveAndReport(
  body: OpenRouterChatResponse,
  imgs: readonly OpenRouterImageItem[],
  note: string,
): Promise<{ ok: boolean; note: string }> {
  let saved = 0;
  let totalBytes = 0;
  for (let i = 0; i < imgs.length; i++) {
    const u = imgs[i]?.image_url?.url;
    if (!u) continue;
    const mime = u.startsWith("data:") ? u : "image/png";
    try {
      const r = await writeImage(body.model ?? "unknown", i, { url: u, mime });
      saved++;
      totalBytes += r.bytes;
      console.log(`  ↳ saved ${r.file} (${r.bytes} bytes)`);
    } catch (e) {
      console.error(`  ✗ save failed for image #${i}: ${(e as Error).message}`);
    }
  }
  if (saved === 0) {
    return { ok: false, note: note || "save_failed" };
  }
  console.log(`  summary: ${saved} image(s), ${totalBytes} bytes`);
  return { ok: true, note };
}

async function handleImagesApiCall(apiKey: string, model: string, prompt: string): Promise<{ ok: boolean }> {
  console.log(`\n→ /api/v1/images model=${model}`);
  const r = await callImagesApi(apiKey, model, prompt);
  if (r.status !== 200) {
    console.error(`  ✗ HTTP ${r.status}`);
    console.error(renderBodyJson(r.body));
    return { ok: false };
  }
  if (typeof r.body !== "object" || !r.body || !Array.isArray(r.body.data)) {
    console.error("  ✗ bad shape");
    console.error(renderBodyJson(r.body));
    return { ok: false };
  }
  const data = r.body.data ?? [];
  if (data.length === 0) {
    console.log("  ! no images in data[]");
    return { ok: false };
  }
  console.log(`  ✓ ${data.length} image(s)${printUsage(r.body.usage)}`);
  let saved = 0;
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!item?.b64_json) continue;
    try {
      const r = await writeImage(model, i, {
        url: `data:${item.media_type ?? "image/png"};base64,${item.b64_json}`,
        mime: item.media_type ?? "image/png",
      });
      saved++;
      console.log(`  ↳ saved ${r.file} (${r.bytes} bytes)`);
    } catch (e) {
      console.error(`  ✗ save failed: ${(e as Error).message}`);
    }
  }
  return { ok: saved > 0 };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "error: OPENROUTER_API_KEY is not set.\n" +
        "  hint: `node --env-file=.env --import tsx/esm demo/image-probe.ts` (Node 20+)",
    );
    return 1;
  }
  const targets: readonly ModelSlug[] = args.model ? [args.model] : MODELS;
  console.log(`models under test: ${targets.join(", ")}`);
  console.log(`endpoint: ${args.endpoint === "chat" ? "POST /api/v1/chat/completions" : "POST /api/v1/images"}`);
  console.log(`mode: ${args.mode}`);
  console.log(`prompt: ${args.prompt}`);

  const catalogOk = await runCatalogCheck(apiKey);
  if (!catalogOk) {
    console.error("\naborting: at least one model slug is missing from the catalog. Re-run after fixing the slugs.");
    return 1;
  }
  if (args.catalogOnly) {
    console.log("\n[ok] catalog only; no calls performed.");
    return 0;
  }

  let failures = 0;
  if (args.endpoint === "chat") {
    if (args.mode === "chain" && !args.model) {
      const r = await handleChatCall(apiKey, MODELS, args.prompt);
      if (!r.ok) failures++;
    } else {
      for (const m of targets) {
        const r = await handleChatCall(apiKey, [m], args.prompt);
        if (!r.ok) failures++;
      }
    }
  } else {
    for (const m of targets) {
      const r = await handleImagesApiCall(apiKey, m, args.prompt);
      if (!r.ok) failures++;
    }
  }

  console.log("");
  if (failures > 0) {
    console.log(`done with ${failures} failure(s).`);
    return 1;
  }
  console.log("done ok.");
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    console.error("fatal:", err);
    process.exit(1);
  },
);
