import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  JevBodyError,
  jevBody,
  getPayload,
  assemble,
  buildQuestions,
  defineSchema,
  stringField,
  dateField,
  intField,
} from "../src/index.js";
import { ans, createMockClient } from "../src/testing/mockClient.js";

const leadSchema = defineSchema({
  name: stringField({ question: "What is the customer's name?" }),
  complaint: stringField({ question: "What is the complaint?", optional: true }),
  followUpAt: dateField({ question: "When is the follow-up?", optional: true }),
  sizePx: intField({ question: "size in pixels", optional: true }),
});

const happyAnswers = {
  name: ans.choice("n2"),
  name_candidates: ans.choice("n0"),
  complaint: ans.choice("n0"),
  complaint_candidates: ans.choice("n3"),
  complaint_stated: ans.noul(0.9),
  followUpAt: ans.choice("n0"),
  followUpAt_candidates: ans.choice("n0"),
  followUpAt_stated: ans.noul(0.9),
  sizePx: ans.choice("n0"),
  sizePx_stated: ans.noul(0.9),
  _hazard: ans.noul(0.05),
};

function buildApp(
  answers: Record<string, ReturnType<typeof ans.choice>> = happyAnswers,
  now: () => Date = () => new Date(2026, 8, 27, 10, 0, 0),
) {
  const app = express();
  app.use(express.json());
  app.post(
    "/lead",
    jevBody(leadSchema, { client: createMockClient(answers), now }),
    (req, res) => {
      res.json(getPayload(req, leadSchema));
    },
  );
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof JevBodyError) {
      return res.status(err.status).json(err.body);
    }
    return res.status(500).json({ error: "internal" });
  });
  return app;
}

describe("stringField / dateField questions", () => {
  it("adds a text candidate Choice only when the span pool has >= 2", () => {
    const s = defineSchema({
      name: stringField({ question: "What is the name?" }),
    });
    const multi = buildQuestions({
      defined: s,
      inputText: "se llama Ana, luego viene Bruja",
      hazardEnabled: false,
    });
    expect(multi.questions.name_candidates?.type).toBe("choice");
    expect(multi.spanCandidates.length).toBeGreaterThanOrEqual(2);

    const single = buildQuestions({
      defined: s,
      inputText: "Ana",
      hazardEnabled: false,
    });
    expect(single.questions.name_candidates).toBeUndefined();
    expect(single.spanCandidates).toEqual(["Ana"]);
  });

  it("adds a date candidate Choice only when the date pool has >= 2", () => {
    const s = defineSchema({
      followUpAt: dateField({ question: "When?" }),
    });
    const multi = buildQuestions({
      defined: s,
      inputText: "para el 27/09/2026 o el 28/09/2026",
      hazardEnabled: false,
    });
    expect(multi.questions.followUpAt_candidates?.type).toBe("choice");
    expect(multi.dateCandidates.length).toBe(2);

    const single = buildQuestions({
      defined: s,
      inputText: "para el 27/09/2026",
      hazardEnabled: false,
    });
    expect(single.questions.followUpAt_candidates).toBeUndefined();
    expect(single.dateCandidates).toEqual(["27/09/2026"]);
  });

  it("labels candidate options as The text/The date", () => {
    const s = defineSchema({
      name: stringField({ question: "What is the name?" }),
      followUpAt: dateField({ question: "When?" }),
    });
    const { questions } = buildQuestions({
      defined: s,
      inputText: "Ana y Bruja, 27/09/2026 o 28/09/2026",
      hazardEnabled: false,
    });
    const textQ = questions.name_candidates as { criteria?: Record<string, string> };
    expect(textQ.criteria?.n0).toMatch(/^The text /);
    const dateQ = questions.followUpAt_candidates as {
      criteria?: Record<string, string>;
    };
    expect(dateQ.criteria?.n0).toMatch(/^The date /);
  });
});

describe("stringField / dateField assembly", () => {
  const meta = {
    model: "mock",
    answers: {} as never,
    usage: undefined,
    elapsedMs: 0,
  };

  it("uses a single string candidate directly and trims it", () => {
    const s = defineSchema({ name: stringField({ question: "name" }) });
    const payload = assemble(s, {}, {}, meta, { statedThreshold: 0.7, spanCandidates: ["  Ana  "] });
    expect(payload.name).toBe("Ana");
  });

  it("selects a string candidate via n{idx} choice keys", () => {
    const s = defineSchema({ name: stringField({ question: "name" }) });
    const payload = assemble(
      s,
      { name_candidates: { type: "choice", choice: "n1", confidence: 1, probabilities: {} } },
      {},
      meta,
      { statedThreshold: 0.7, spanCandidates: ["Ana", "Bruja"] },
    );
    expect(payload.name).toBe("Bruja");
  });

  it("throws jev_missing_candidate when a stated string field has an empty pool", () => {
    const s = defineSchema({ name: stringField({ question: "name" }) });
    expect(() =>
      assemble(s, {}, {}, meta, { statedThreshold: 0.7, spanCandidates: [] }),
    ).toThrowError(/No text candidate/);
  });

  it("normalizes a single date candidate with the injected now", () => {
    const s = defineSchema({ followUpAt: dateField({ question: "when" }) });
    const payload = assemble(s, {}, {}, meta, {
      statedThreshold: 0.7,
      dateCandidates: ["mañana"],
      now: () => new Date(2026, 8, 27, 10, 0, 0),
    });
    expect(payload.followUpAt).toBe("2026-09-28");
  });

  it("throws jev_invalid_date when the chosen span is not a valid date", () => {
    const s = defineSchema({ followUpAt: dateField({ question: "when" }) });
    try {
      assemble(s, {}, {}, meta, {
        statedThreshold: 0.7,
        dateCandidates: ["2026-02-30"],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as JevBodyError).code).toBe("jev_invalid_date");
    }
  });
});

describe("stringField / dateField middleware roundtrip", () => {
  it("builds a lead payload with free text, optional fields, and a date", async () => {
    const app = buildApp();
    const res = await request(app).post("/lead").send({
      prompt:
        "Mi nombre es Ana García, queja: pantalla rota, seguimiento mañana a las 3pm, 1200 píxeles",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: "Ana García",
      complaint: "pantalla rota",
      followUpAt: "2026-09-28T15:00",
      sizePx: 1200,
    });
  });

  it("omits optional string/date fields when not stated", async () => {
    const app = buildApp({
      ...happyAnswers,
      complaint_stated: ans.noul(0.1),
      followUpAt_stated: ans.noul(0.1),
      sizePx_stated: ans.noul(0.1),
    });
    const res = await request(app)
      .post("/lead")
      .send({ prompt: "se llama Ana García" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "Ana García" });
  });

  it("returns 400 when a stated required date field has no candidates", async () => {
    const schema = defineSchema({
      followUpAt: dateField({ question: "When is the follow-up?" }),
    });
    const app = express();
    app.use(express.json());
    app.post(
      "/lead",
      jevBody(schema, { client: createMockClient({ _hazard: ans.noul(0.05) }) }),
      (req, res) => res.json(getPayload(req, schema)),
    );
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof JevBodyError) return res.status(err.status).json(err.body);
      return res.status(500).json({ error: "internal" });
    });
    const res = await request(app).post("/lead").send({ prompt: "hola" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("jev_missing_candidate");
  });

  it("returns 422 jev_invalid_date when the chosen date span is impossible", async () => {
    const schema = defineSchema({
      followUpAt: dateField({ question: "When is the follow-up?" }),
    });
    const app = express();
    app.use(express.json());
    app.post(
      "/lead",
      jevBody(schema, {
        client: createMockClient({ followUpAt: ans.choice("n0"), _hazard: ans.noul(0.05) }),
      }),
      (req, res) => res.json(getPayload(req, schema)),
    );
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof JevBodyError) return res.status(err.status).json(err.body);
      return res.status(500).json({ error: "internal" });
    });
    const res = await request(app).post("/lead").send({ prompt: "para el 30/02/2026" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("jev_invalid_date");
  });
});
