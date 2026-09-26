import { describe, expect, it } from "vitest";

import { buildQuestions } from "../src/core/questions.js";
import { defineSchema, enumField, intField, scoreField } from "../src/core/schema.js";

describe("buildQuestions", () => {
  it("creates a Choice for enumField with criteria keys as values", () => {
    const s = defineSchema({
      effect: enumField({ fadein: "fade in", fadeout: "fade out", bounce: "bounce" }, {
        question: "What effect?",
      }),
    });
    const { questions, numericCandidates: nc } = buildQuestions({
      defined: s,
      inputText: "anything",
      hazardEnabled: true,
    });
    expect(questions.effect?.type).toBe("choice");
    expect(questions._hazard?.type).toBe("noul");
    expect(nc).toEqual({});
  });

  it("creates a Score for scoreField with all ordered levels", () => {
    const s = defineSchema({
      frustration: scoreField(["calm", "civil", "very angry"], { question: "How angry?" }),
    });
    const { questions } = buildQuestions({
      defined: s,
      inputText: "x",
      hazardEnabled: false,
    });
    expect(questions.frustration?.type).toBe("score");
    expect(questions._hazard).toBeUndefined();
  });

  it("adds a candidate Choice when a numeric field has >= 2 candidates", () => {
    const s = defineSchema({
      sizePx: intField({ question: "size in pixels" }),
    });
    const { questions, numericCandidates: nc } = buildQuestions({
      defined: s,
      inputText: "size 1200 also 30",
      hazardEnabled: true,
    });
    expect(questions.sizePx_candidates?.type).toBe("choice");
    expect(nc.sizePx).toEqual(["1200", "30"]);
  });

  it("does not add a candidate Choice for a single numeric candidate", () => {
    const s = defineSchema({
      sizePx: intField({ question: "size" }),
    });
    const { questions, numericCandidates: nc } = buildQuestions({
      defined: s,
      inputText: "size 1200 px",
      hazardEnabled: true,
    });
    expect(questions.sizePx_candidates).toBeUndefined();
    expect(nc.sizePx).toEqual(["1200"]);
  });

  it("adds a stated Noul per optional field", () => {
    const s = defineSchema({
      sizePx: intField({ question: "size in pixels", optional: true }),
    });
    const { questions } = buildQuestions({
      defined: s,
      inputText: "x",
      hazardEnabled: true,
    });
    expect(questions.sizePx_stated?.type).toBe("noul");
  });
});
