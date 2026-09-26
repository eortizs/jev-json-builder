import express from "express";
import request from "supertest";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import { jevBody, type Schema } from "../src/index.js";
import { ans, createMockClient, type MockAnswers } from "../src/testing/mockClient.js";
import { animationSchema, orderSchema, triageSchema } from "./server.js";

type Case = {
  name: string;
  route: string;
  schema: Schema;
  prompt: string;
  fields: string;
  mock: MockAnswers;
};

const SUITE: Case[] = [
  {
    name: "animation/es",
    route: "animation",
    schema: animationSchema,
    prompt:
      "Dame la animación de un cuadrado que aparezca por fading de color rojo y que tenga un tamaño de 1200 píxeles.",
    fields: 'effect: "fadein"|"fadeout"|"bounce", shape: "circle"|"square"|"triangle", color: "red"|"green"|"blue", sizePx: number',
    mock: {
      effect: ans.choice("fadein"),
      shape: ans.choice("square"),
      color: ans.choice("red"),
      sizePx_stated: ans.noul(0.95),
      _hazard: ans.noul(0.05),
    },
  },
  {
    name: "animation/en",
    route: "animation",
    schema: animationSchema,
    prompt: "A bounce animation for a blue triangle",
    fields: 'effect: "fadein"|"fadeout"|"bounce", shape: "circle"|"square"|"triangle", color: "red"|"green"|"blue", sizePx?: number',
    mock: {
      effect: ans.choice("bounce"),
      shape: ans.choice("triangle"),
      color: ans.choice("blue"),
      sizePx_stated: ans.noul(0.1),
      _hazard: ans.noul(0.05),
    },
  },
  {
    name: "triage/refund",
    route: "triage",
    schema: triageSchema,
    prompt:
      "I was charged twice for order #98423 and I want a refund of 49 dollars. This is the third time I'm writing in.",
    fields:
      'category: "bug"|"billing"|"account"|"feature", severity: number 0-2, frustration: number 0-2, refundRequested: "yes"|"no", amount?: number',
    mock: {
      category: ans.choice("billing"),
      severity: ans.score(1.43, 1),
      frustration: ans.score(1.28, 1),
      refundRequested: ans.choice("yes"),
      amount_candidates: ans.choice("n1"),
      amount_stated: ans.noul(0.95),
      _hazard: ans.noul(0.05),
    },
  },
  {
    name: "triage/bug",
    route: "triage",
    schema: triageSchema,
    prompt: "The export button crashes the settings page in Safari. It works in Chrome.",
    fields:
      'category: "bug"|"billing"|"account"|"feature", severity: number 0-2, frustration: number 0-2, refundRequested: "yes"|"no", amount?: number',
    mock: {
      category: ans.choice("bug"),
      severity: ans.score(1.43, 1),
      frustration: ans.score(0.5, 1),
      refundRequested: ans.choice("no"),
      amount_stated: ans.noul(0.1),
      _hazard: ans.noul(0.05),
    },
  },
  {
    name: "orders/es",
    route: "orders",
    schema: orderSchema,
    prompt: "Quiero pedir 2 laptops con envío express y que venga envuelto para regalo",
    fields:
      'product: "laptop"|"phone"|"tablet"|"headphones", shipping: "standard"|"express"|"overnight", quantity: number, giftWrap?: "yes"|"no"',
    mock: {
      product: ans.choice("laptop"),
      shipping: ans.choice("express"),
      giftWrap: ans.choice("yes"),
      giftWrap_stated: ans.noul(0.95),
      _hazard: ans.noul(0.05),
    },
  },
  {
    name: "orders/en",
    route: "orders",
    schema: orderSchema,
    prompt: "Order 5 pairs of headphones with standard shipping",
    fields:
      'product: "laptop"|"phone"|"tablet"|"headphones", shipping: "standard"|"express"|"overnight", quantity: number, giftWrap?: "yes"|"no"',
    mock: {
      product: ans.choice("headphones"),
      shipping: ans.choice("standard"),
      giftWrap_stated: ans.noul(0.1),
      _hazard: ans.noul(0.05),
    },
  },
  {
    name: "orders/mixed-numbers",
    route: "orders",
    schema: orderSchema,
    prompt: "I need an overnight tablet, just one, from order 4711",
    fields:
      'product: "laptop"|"phone"|"tablet"|"headphones", shipping: "standard"|"express"|"overnight", quantity: number, giftWrap?: "yes"|"no"',
    mock: {
      product: ans.choice("tablet"),
      shipping: ans.choice("overnight"),
      giftWrap_stated: ans.noul(0.1),
      _hazard: ans.noul(0.05),
    },
  },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function fmt(ms: number): string {
  return `${ms.toFixed(0)}ms`;
}

function avg(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
}

type RunResult = {
  name: string;
  attempts: number;
  wallMs: number[];
  jevMs: number[];
  inTok: number[];
  outTok: number[];
  ok: number;
};

async function runJjb(
  makeClient: (c: Case) => TypeSafeClient,
  iterations: number,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const c of SUITE) {
    const client = makeClient(c);
    const app = express();
    app.use(express.json());
    app.post(
      `/api/${c.route}`,
      jevBody(c.schema, { client }),
      (req, res) => res.json({ meta: req.jevMeta }),
    );
    const wallMs: number[] = [];
    const jevMs: number[] = [];
    const inTok: number[] = [];
    const outTok: number[] = [];
    let ok = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await request(app).post(`/api/${c.route}`).send({ prompt: c.prompt });
      const wall = performance.now() - t0;
      if (res.status === 200 && res.body?.meta) {
        ok++;
        wallMs.push(wall);
        jevMs.push(res.body.meta.elapsedMs ?? wall);
        inTok.push(res.body.meta.usage?.input_tokens ?? 0);
        outTok.push(res.body.meta.usage?.output_tokens ?? 0);
      }
    }
    results.push({ name: c.name, attempts: iterations, wallMs, jevMs, inTok, outTok, ok });
  }
  return results;
}

type LlmResult = {
  name: string;
  attempts: number;
  wallMs: number[];
  outTok: number[];
  jsonOk: number;
  fieldsOk: number;
};

async function runLlm(iterations: number): Promise<LlmResult[]> {
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const results: LlmResult[] = [];

  for (const c of SUITE) {
    const wallMs: number[] = [];
    const outTok: number[] = [];
    let jsonOk = 0;
    let fieldsOk = 0;
    const expected = c.fields
      .split(",")
      .map((f) => (f.split(":")[0] ?? "").trim().replace("?", ""));
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Extract a JSON object from the user message. Use exactly these fields: ${c.fields}. Omit optional fields when not stated. Return ONLY the JSON object.`,
            },
            { role: "user", content: c.prompt },
          ],
        }),
      });
      const wall = performance.now() - t0;
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content ?? "";
      outTok.push(body.usage?.completion_tokens ?? 0);
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        jsonOk++;
        const present = expected.filter((k) => k in parsed);
        if (present.length >= expected.length - 1) fieldsOk++;
      } catch {
        // non-JSON output counts as a parse failure
      }
      wallMs.push(wall);
    }
    results.push({ name: c.name, attempts: iterations, wallMs, outTok, jsonOk, fieldsOk });
  }
  return results;
}

function printJjb(results: RunResult[], mode: string): void {
  console.log(`\n=== JJB (System One) — ${mode} ===`);
  console.log("case                  wall p50   wall p95   jev p50   in tok   out tok   ok");
  for (const r of results) {
    const wall = [...r.wallMs].sort((a, b) => a - b);
    const jev = [...r.jevMs].sort((a, b) => a - b);
    console.log(
      `${r.name.padEnd(21)} ${fmt(percentile(wall, 50)).padEnd(10)} ${fmt(
        percentile(wall, 95),
      ).padEnd(10)} ${fmt(percentile(jev, 50)).padEnd(9)} ${String(avg(r.inTok)).padEnd(
        8,
      )} ${String(avg(r.outTok)).padEnd(10)} ${r.ok}/${r.attempts}`,
    );
  }
}

function printLlm(results: LlmResult[]): void {
  console.log(
    `\n=== LLM baseline (${process.env.LLM_MODEL ?? "gpt-4o-mini"}, JSON mode) ===`,
  );
  console.log("case                  wall p50   wall p95   out tok   json ok   fields ok");
  for (const r of results) {
    const wall = [...r.wallMs].sort((a, b) => a - b);
    console.log(
      `${r.name.padEnd(21)} ${fmt(percentile(wall, 50)).padEnd(10)} ${fmt(
        percentile(wall, 95),
      ).padEnd(10)} ${String(avg(r.outTok)).padEnd(9)} ${`${r.jsonOk}/${r.attempts}`.padEnd(
        10,
      )} ${r.fieldsOk}/${r.attempts}`,
    );
  }
}

function printEstimate(): void {
  console.log("\n=== LLM baseline (heuristic estimate, LLM_API_KEY not set) ===");
  console.log(
    [
      "A generative model must emit the JSON syntax token by token.",
      "Typical output size for these payloads: 35-80 tokens.",
      "Typical decode speed: 25-60 tok/s -> 0.6s-3.2s generation + network + parsing.",
      "Set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL) to measure a real baseline.",
    ].join("\n  "),
  );
}

function printSummary(jjb: RunResult[], llm: LlmResult[] | undefined): void {
  const allWall = jjb.flatMap((r) => r.wallMs).sort((a, b) => a - b);
  const jjbP50 = percentile(allWall, 50);
  console.log("\n=== Summary ===");
  console.log(`JJB end-to-end p50: ${fmt(jjbP50)}`);
  if (llm) {
    const llmWall = llm.flatMap((r) => r.wallMs).sort((a, b) => a - b);
    const llmP50 = percentile(llmWall, 50);
    const jjbOut = jjb.flatMap((r) => r.outTok);
    const llmOut = llm.flatMap((r) => r.outTok);
    console.log(
      `LLM end-to-end p50: ${fmt(llmP50)}  (speedup ${(llmP50 / Math.max(1, jjbP50)).toFixed(1)}x)`,
    );
    console.log(
      `Output tokens — JJB: ${avg(jjbOut)}/response · LLM: ${avg(llmOut)}/response`,
    );
    const parseFail = llm.reduce((acc, r) => acc + (r.attempts - r.jsonOk), 0);
    console.log(
      `LLM non-JSON outputs: ${parseFail}  (JJB: 0 — format is compiled in code)`,
    );
  }
}

async function main(): Promise<void> {
  const mockMode = process.env.JJB_BENCH_MOCK === "1";
  const iterations = Number(process.env.JJB_BENCH_N ?? 5);
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
  const useMock = mockMode || !hasKey;

  if (!mockMode && !hasKey) {
    console.log(
      "TYPESAFE_API_KEY not set — falling back to mock mode (pipeline overhead only).",
    );
  }

  const makeClient = useMock
    ? (c: Case) => createMockClient(c.mock)
    : () => new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  const mode = useMock
    ? "MOCK: pipeline overhead only, no model latency"
    : `live jev, n=${iterations}`;

  const jjb = await runJjb(makeClient, iterations);
  printJjb(jjb, mode);

  let llm: LlmResult[] | undefined;
  if (process.env.LLM_API_KEY) {
    llm = await runLlm(Math.min(iterations, 3));
    printLlm(llm);
  } else {
    printEstimate();
  }

  printSummary(jjb, llm);
}

await main();