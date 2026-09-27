import { describe, expect, it } from "vitest";

import { defaultGateOptions, evaluateGates } from "../src/core/gates.js";
import { JevBodyError } from "../src/core/errors.js";
import type { AnswerMap, JevMeta } from "../src/core/types.js";

const meta: JevMeta = { model: "mock", answers: {}, usage: undefined, elapsedMs: 0 };

describe("evaluateGates", () => {
  it("passes when hazard is below threshold and confidence is high", () => {
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 0.9, probabilities: {} },
      _hazard: { type: "noul", noul: 0.1 },
    };
    expect(() =>
      evaluateGates(answers, meta, defaultGateOptions(true, 0.85, {}, ["effect"])),
    ).not.toThrow();
  });

  it("rejects when hazard fires", () => {
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 1, probabilities: {} },
      _hazard: { type: "noul", noul: 0.9 },
    };
    let caught: unknown;
    try {
      evaluateGates(answers, meta, defaultGateOptions(true, 0.85, {}, ["effect"]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JevBodyError);
    expect((caught as JevBodyError).code).toBe("jev_hazard");
    expect((caught as JevBodyError).status).toBe(422);
  });

  it("rejects when a field's confidence is below threshold (ambiguity)", () => {
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 0.6, probabilities: {} },
      shape: { type: "choice", choice: "square", confidence: 1, probabilities: {} },
      _hazard: { type: "noul", noul: 0.1 },
    };
    let caught: unknown;
    try {
      evaluateGates(answers, meta, defaultGateOptions(true, 0.85, {}, ["effect", "shape"]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JevBodyError);
    expect((caught as JevBodyError).code).toBe("jev_ambiguous");
    const body = (caught as JevBodyError).body;
    expect(body.fields).toEqual([
      { field: "effect", confidence: 0.6, threshold: 0.85 },
    ]);
  });

  it("respects per-field thresholds", () => {
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 0.7, probabilities: {} },
      _hazard: { type: "noul", noul: 0.1 },
    };
    // global threshold is 0.85, but per-field override allows 0.5
    expect(() =>
      evaluateGates(
        answers,
        meta,
        defaultGateOptions(true, 0.85, { effect: 0.5 }, ["effect"]),
      ),
    ).not.toThrow();
  });

  it("gates low-confidence candidate selectors (int/string/date fields)", () => {
    const answers: AnswerMap = {
      size_candidates: { type: "choice", choice: "n1", confidence: 0.35, probabilities: {} },
      _hazard: { type: "noul", noul: 0.1 },
    };
    let caught: unknown;
    try {
      evaluateGates(answers, meta, defaultGateOptions(true, 0.85, {}, ["size"]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JevBodyError);
    expect((caught as JevBodyError).code).toBe("jev_ambiguous");
    const body = (caught as JevBodyError).body;
    expect(body.fields).toEqual([
      { field: "size_candidates", confidence: 0.35, threshold: 0.85 },
    ]);
  });

  it("passes when the candidate selector confidence is high", () => {
    const answers: AnswerMap = {
      size_candidates: { type: "choice", choice: "n1", confidence: 0.92, probabilities: {} },
      _hazard: { type: "noul", noul: 0.1 },
    };
    expect(() =>
      evaluateGates(answers, meta, defaultGateOptions(true, 0.85, {}, ["size"])),
    ).not.toThrow();
  });

  it("honors per-field thresholds for candidate selectors", () => {
    const answers: AnswerMap = {
      size_candidates: { type: "choice", choice: "n0", confidence: 0.6, probabilities: {} },
      _hazard: { type: "noul", noul: 0.1 },
    };
    expect(() =>
      evaluateGates(
        answers,
        meta,
        defaultGateOptions(true, 0.85, { size: 0.5 }, ["size"]),
      ),
    ).not.toThrow();
  });

  it("skips hazard when disabled", () => {
    const answers: AnswerMap = {
      effect: { type: "choice", choice: "fadein", confidence: 1, probabilities: {} },
      _hazard: { type: "noul", noul: 0.99 },
    };
    expect(() =>
      evaluateGates(answers, meta, defaultGateOptions(false, 0.85, {}, ["effect"])),
    ).not.toThrow();
  });
});
