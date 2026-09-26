import { describe, expect, it } from "vitest";

import { candidateIndexFromKey, numericCandidates } from "../src/core/candidates.js";

describe("numericCandidates", () => {
  it("extracts 1-6 digit integers in order", () => {
    expect(numericCandidates("cuadrado 1200 píxeles y 30 fps")).toEqual(["1200", "30"]);
    expect(numericCandidates("pedir 2 laptops")).toEqual(["2"]);
  });

  it("ignores overly long numbers", () => {
    expect(numericCandidates("order 9, version 12, year 2026, code 1234567")).toEqual([
      "9",
      "12",
      "2026",
    ]);
  });

  it("returns empty when no candidates", () => {
    expect(numericCandidates("hola mundo")).toEqual([]);
  });
});

describe("candidateIndexFromKey", () => {
  it("decodes well-formed keys", () => {
    expect(candidateIndexFromKey("n3")).toBe(3);
    expect(candidateIndexFromKey("n0")).toBe(0);
  });

  it("rejects malformed keys", () => {
    expect(candidateIndexFromKey("x3")).toBeUndefined();
    expect(candidateIndexFromKey("n")).toBeUndefined();
    expect(candidateIndexFromKey("n-1")).toBeUndefined();
  });
});
