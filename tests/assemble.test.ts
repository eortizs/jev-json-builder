import { describe, expect, it } from "vitest";

import { assemble } from "../src/core/assemble.js";
import { JevBodyError } from "../src/core/errors.js";
import type { AnswerMap } from "../src/core/types.js";
import { defineSchema, enumField, intField, scoreField } from "../src/core/schema.js";

const meta = { model: "mock", answers: {} as AnswerMap, usage: undefined, elapsedMs: 0 };

describe("assemble", () => {
  it("builds a payload with all required enums and an optional int", () => {
    const s = defineSchema({
      effect: enumField({ fadein: "in", fadeout: "out", bounce: "b" }, { question: "effect" }),
      shape: enumField({ circle: "c", square: "s", triangle: "t" }, { question: "shape" }),
      color: enumField({ red: "r", green: "g", blue: "b" }, { question: "color" }),
      sizePx: intField({ question: "size", optional: true }),
    });
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 1, probabilities: {} },
      shape: { type: "choice", choice: "square", confidence: 1, probabilities: {} },
      color: { type: "choice", choice: "red", confidence: 1, probabilities: {} },
      sizePx_stated: { type: "noul", noul: 0.9 },
    };
    const payload = assemble(s, answers, { sizePx: ["1200"] }, meta, {
      statedThreshold: 0.7,
    });
    expect(payload).toEqual({ effect: "fadein", shape: "square", color: "red", sizePx: 1200 });
  });

  it("omits optional fields when stated noul <= threshold", () => {
    const s = defineSchema({
      effect: enumField({ fadein: "in" }, { question: "effect" }),
      sizePx: intField({ question: "size", optional: true }),
    });
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 1, probabilities: {} },
      sizePx_stated: { type: "noul", noul: 0.1 },
    };
    const payload = assemble(s, answers, { sizePx: [] }, meta, { statedThreshold: 0.7 });
    expect(payload).toEqual({ effect: "fadein" });
  });

  it("throws when an optional numeric field is stated but no candidates exist", () => {
    const s = defineSchema({
      sizePx: intField({ question: "size", optional: true }),
    });
    const answers: AnswerMap = {
      sizePx_stated: { type: "noul", noul: 0.9 },
    };
    expect(() => assemble(s, answers, { sizePx: [] }, meta)).toThrowError(JevBodyError);
  });

  it("picks the right numeric candidate when several exist", () => {
    const s = defineSchema({
      sizePx: intField({ question: "size" }),
    });
    const answers: AnswerMap = {
      sizePx: { type: "choice", choice: "n0", confidence: 1, probabilities: {} },
      sizePx_candidates: { type: "choice", choice: "n1", confidence: 1, probabilities: {} },
    };
    const payload = assemble(s, answers, { sizePx: ["1200", "30"] }, meta);
    expect(payload.sizePx).toBe(30);
  });

  it("throws when required field answer is missing", () => {
    const s = defineSchema({
      effect: enumField({ fadein: "in" }, { question: "effect" }),
    });
    expect(() => assemble(s, {}, {}, meta)).toThrowError(JevBodyError);
  });

  it("omits optional enum fields when stated noul <= threshold", () => {
    const s = defineSchema({
      product: enumField({ laptop: "l", phone: "p" }, { question: "product" }),
      giftWrap: enumField({ yes: "y", no: "n" }, { question: "gift wrap", optional: true }),
    });
    const answers: AnswerMap = {
      product: { type: "choice", choice: "laptop", confidence: 1, probabilities: {} },
      giftWrap_stated: { type: "noul", noul: 0.1 },
    };
    const payload = assemble(s, answers, {}, meta, { statedThreshold: 0.7 });
    expect(payload).toEqual({ product: "laptop" });
  });

  it("returns a float score position for scoreField", () => {
    const s = defineSchema({
      frustration: scoreField(["calm", "civil", "very angry"], { question: "anger" }),
    });
    const answers: AnswerMap = {
      frustration: {
        type: "score",
        score: 1.43,
        confidence: 1,
        probabilities: {},
        legend: {},
      },
    };
    const payload = assemble(s, answers, {}, meta);
    expect(payload.frustration).toBe(1.43);
  });
});
