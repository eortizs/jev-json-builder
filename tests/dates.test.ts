import { describe, expect, it } from "vitest";

import {
  extractDateCandidates,
  normalizeDate,
  validateDateParts,
} from "../src/core/dates.js";
import { JevBodyError } from "../src/core/errors.js";

// Fixed clock: Sunday 2026-09-27, 10:00 local.
const NOW = new Date(2026, 8, 27, 10, 0, 0);

function normalize(span: string): { iso: string; hasTime: boolean } {
  return normalizeDate(span, NOW);
}

describe("extractDateCandidates", () => {
  it("finds ISO dates with and without time", () => {
    expect(extractDateCandidates("para 2026-09-27")).toEqual(["2026-09-27"]);
    expect(extractDateCandidates("meeting 2026-09-27T15:00")).toEqual([
      "2026-09-27T15:00",
    ]);
    expect(extractDateCandidates("meeting 2026-09-27 15:00")).toContain(
      "2026-09-27 15:00",
    );
  });

  it("finds numeric dates with 2- or 4-digit years", () => {
    expect(extractDateCandidates("el 27/09/2026")).toContain("27/09/2026");
    expect(extractDateCandidates("el 27-09-26")).toContain("27-09-26");
  });

  it("finds times and relative words", () => {
    const pool = extractDateCandidates("hoy a las 15:00 o mañana a las 3pm");
    expect(pool).toContain("15:00");
    expect(pool).toContain("3pm");
    expect(pool.some((c) => c.startsWith("hoy"))).toBe(true);
    expect(pool.some((c) => c.startsWith("mañana"))).toBe(true);
  });

  it("finds combined weekday + time spans", () => {
    expect(extractDateCandidates("next monday 10:00")).toContain(
      "next monday 10:00",
    );
  });

  it("dedupes and preserves document order", () => {
    const pool = extractDateCandidates("15:00 luego 15:00");
    expect(pool.filter((c) => c === "15:00").length).toBe(1);
    expect(pool[0]).toBe("15:00");
  });

  it("returns no candidates for plain text without dates", () => {
    expect(extractDateCandidates("quiero una pizza grande")).toEqual([]);
  });
});

describe("normalizeDate", () => {
  it("normalizes ISO dates with and without time", () => {
    expect(normalize("2026-09-27")).toEqual({ iso: "2026-09-27", hasTime: false });
    expect(normalize("2026-09-27T15:00")).toEqual({
      iso: "2026-09-27T15:00",
      hasTime: true,
    });
    expect(normalize("2026-09-27 15:00")).toEqual({
      iso: "2026-09-27T15:00",
      hasTime: true,
    });
  });

  it("normalizes numeric dates day-first with 2- or 4-digit years", () => {
    expect(normalize("27/09/2026")).toEqual({ iso: "2026-09-27", hasTime: false });
    expect(normalize("27-09-26")).toEqual({ iso: "2026-09-27", hasTime: false });
  });

  it("resolves relative days against the injectable now", () => {
    expect(normalize("hoy")).toEqual({ iso: "2026-09-27", hasTime: false });
    expect(normalize("today")).toEqual({ iso: "2026-09-27", hasTime: false });
    expect(normalize("mañana")).toEqual({ iso: "2026-09-28", hasTime: false });
    expect(normalize("tomorrow")).toEqual({ iso: "2026-09-28", hasTime: false });
    expect(normalize("pasado mañana")).toEqual({ iso: "2026-09-29", hasTime: false });
    expect(normalize("day after tomorrow")).toEqual({
      iso: "2026-09-29",
      hasTime: false,
    });
  });

  it("resolves next weekday strictly after today", () => {
    // Today is Sunday (0): next sunday is +7, next monday is +1.
    expect(normalize("next sunday")).toEqual({ iso: "2026-10-04", hasTime: false });
    expect(normalize("next monday")).toEqual({ iso: "2026-09-28", hasTime: false });
    expect(normalize("próximo viernes")).toEqual({ iso: "2026-10-02", hasTime: false });
  });

  it("resolves a bare weekday to the nearest upcoming occurrence (today counts)", () => {
    expect(normalize("domingo")).toEqual({ iso: "2026-09-27", hasTime: false });
    expect(normalize("lunes")).toEqual({ iso: "2026-09-28", hasTime: false });
  });

  it("normalizes combined spans as one", () => {
    expect(normalize("mañana a las 3pm")).toEqual({
      iso: "2026-09-28T15:00",
      hasTime: true,
    });
    expect(normalize("tomorrow at 3:30pm")).toEqual({
      iso: "2026-09-28T15:30",
      hasTime: true,
    });
    expect(normalize("next monday 10:00")).toEqual({
      iso: "2026-09-28T10:00",
      hasTime: true,
    });
    expect(normalize("hoy a las 15:00")).toEqual({
      iso: "2026-09-27T15:00",
      hasTime: true,
    });
  });

  it("normalizes 12am/12pm and standalone times to today", () => {
    expect(normalize("12am")).toEqual({ iso: "2026-09-27T00:00", hasTime: true });
    expect(normalize("12pm")).toEqual({ iso: "2026-09-27T12:00", hasTime: true });
    expect(normalize("3:30 pm")).toEqual({ iso: "2026-09-27T15:30", hasTime: true });
    expect(normalize("15:00")).toEqual({ iso: "2026-09-27T15:00", hasTime: true });
  });

  it("throws jev_invalid_date for impossible calendar parts", () => {
    expect(() => normalize("32/01/2026")).toThrowError(JevBodyError);
    try {
      normalize("32/01/2026");
    } catch (err) {
      expect((err as JevBodyError).code).toBe("jev_invalid_date");
      expect((err as JevBodyError).status).toBe(422);
    }
    expect(() => normalize("2026-02-30")).toThrowError(JevBodyError);
    expect(() => normalize("2026-13-01")).toThrowError(JevBodyError);
  });

  it("is leap-year aware", () => {
    expect(() => validateDateParts(2028, 2, 29)).not.toThrow();
    expect(() => validateDateParts(2026, 2, 29)).toThrowError(JevBodyError);
  });

  it("throws jev_invalid_date for impossible clock parts", () => {
    expect(() => normalize("2026-09-27 25:00")).toThrowError(JevBodyError);
    expect(() => normalize("2026-09-27 10:99")).toThrowError(JevBodyError);
    try {
      normalize("2026-09-27 25:00");
    } catch (err) {
      expect((err as JevBodyError).code).toBe("jev_invalid_date");
    }
  });

  it("throws jev_invalid_date for unrecognized spans", () => {
    expect(() => normalize("pastel de limón")).toThrowError(JevBodyError);
  });

  it("uses the current time when now is omitted", () => {
    const today = new Date();
    const out = normalizeDate("hoy");
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(out.hasTime).toBe(false);
    expect(out.iso).toBe(expected);
  });
});
