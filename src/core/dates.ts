/**
 * Date/time candidate extraction and deterministic ISO-8601 normalization.
 *
 * Like numeric/spans, Jev cannot output arbitrary dates. We find candidate
 * date/time spans with regex, let Jev select which one (if more than one),
 * then code normalizes the verbatim span into an ISO-8601 string:
 *   - `YYYY-MM-DD` when the span carries no time
 *   - `YYYY-MM-DDTHH:mm` when it does (local wall-clock, no offset — spans
 *     rarely carry a timezone)
 *
 * Relative days (`hoy`, `mañana`, `next monday`, ...) resolve against an
 * injectable `now: Date` so tests are deterministic. Weekday rules:
 *   - `next X` / `próximo X` = strictly after today
 *   - bare `X` = nearest upcoming occurrence (today counts)
 *
 * Day-only spans (numeric/ISO dates) that appear next to a separate time
 * span are NOT merged; combined spans (`mañana a las 3pm`, `next monday
 * 10:00`) normalize as one.
 */

import { JevBodyError } from "./errors.js";

const MAX_DATE_CANDIDATES = 10;

/** 0 = Sunday ... 6 = Saturday (ES + EN, incl. common abbreviations). */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, domingo: 0,
  monday: 1, mon: 1, lunes: 1,
  tuesday: 2, tues: 2, tue: 2, martes: 2,
  wednesday: 3, wed: 3, "miércoles": 3, miercoles: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, jueves: 4,
  friday: 5, fri: 5, viernes: 5,
  saturday: 6, sat: 6, "sábado": 6, sabado: 6,
};

const WD_SOURCE =
  "(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)";
const REL_SOURCE =
  "(?:pasado\\s+ma[nñ]ana|day\\s+after\\s+tomorrow|ma[nñ]ana|tomorrow|hoy|today)";
const NEXT_SOURCE = `(?:el\\s+pr[oó]ximo|pr[oó]ximo|next)\\s+(?:d[ií]as?\\s+)?${WD_SOURCE}`;
const TIME_SOURCE = String.raw`(?:\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))`;

const ISO_DATE_REGEX =
  /(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}(?:\s*(?:am|pm))?))?/gi;
const NUMERIC_DATE_REGEX = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/g;
const COMBINED_DATE_REGEX = new RegExp(
  `\\b(${NEXT_SOURCE}|${REL_SOURCE}|${WD_SOURCE})\\s*(?:a\\s+las|at|@)?\\s*(${TIME_SOURCE})?(?![A-Za-z])`,
  "gi",
);
const TIME_ONLY_REGEX = new RegExp(`\\b(${TIME_SOURCE})(?![A-Za-z])`, "gi");

/** Ordered candidate with its document position for stable dedupe. */
type DateHit = { index: number; text: string };

function collectMatches(regex: RegExp, text: string): DateHit[] {
  const hits: DateHit[] = [];
  for (const m of text.matchAll(regex)) {
    const raw = m[0];
    if (raw === undefined) continue;
    const cleaned = raw.trim();
    if (cleaned === "") continue;
    hits.push({ index: m.index ?? 0, text: cleaned });
  }
  return hits;
}

/**
 * Returns ordered date/time candidates as verbatim spans, deduped,
 * document order preserved, capped at a safe pool size.
 */
export function extractDateCandidates(text: string): string[] {
  const hits: DateHit[] = [
    ...collectMatches(ISO_DATE_REGEX, text),
    ...collectMatches(NUMERIC_DATE_REGEX, text),
    ...collectMatches(COMBINED_DATE_REGEX, text),
    ...collectMatches(TIME_ONLY_REGEX, text),
  ];

  hits.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    out.push(hit.text);
    if (out.length >= MAX_DATE_CANDIDATES) break;
  }
  return out;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Validate calendar/clock parts. Month 1-12, day valid for month
 * (leap-aware), hour 0-23, minute 0-59. Throws `jev_invalid_date` on any
 * violation.
 */
export function validateDateParts(
  year: number,
  month: number,
  day: number,
  hour?: number,
  minute?: number,
  field?: string,
): void {
  const invalid = (detail: string): JevBodyError =>
    new JevBodyError(422, "jev_invalid_date", `Invalid date: ${detail}.`, {
      field,
    });

  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw invalid(`year ${year} out of range`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw invalid(`month ${month} must be 1-12`);
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw invalid(`day ${day} is not valid for month ${month} of year ${year}`);
  }
  if (hour !== undefined && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw invalid(`hour ${hour} must be 0-23`);
  }
  if (
    minute !== undefined &&
    (!Number.isInteger(minute) || minute < 0 || minute > 59)
  ) {
    throw invalid(`minute ${minute} must be 0-59`);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse the time portion ("15:00", "3:30pm", "3pm") into 24h hour/minute. */
function parseTime(raw: string): { hour: number; minute: number } {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) {
    throw new Error(`unparseable time "${raw}"`);
  }
  let hour = Number(m[1]);
  const minute = m[2] !== undefined ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

/** Days from `current` to the next `target` weekday. */
function daysUntil(target: number, current: number, strictlyAfter: boolean): number {
  let diff = (target - current + 7) % 7;
  if (strictlyAfter && diff === 0) diff = 7;
  return diff;
}

/** Strip the "next/próximo/el próximo [día]" prefix from a weekday phrase. */
function weekdayOfPhrase(phrase: string): { weekday: number; next: boolean } | undefined {
  const lower = phrase.toLowerCase().trim();
  const nextMatch = /^(?:el\s+)?(?:pr[oó]ximo|next)\s+(?:d[ií]as?\s+)?(.+)$/.exec(lower);
  if (nextMatch) {
    const wd = WEEKDAYS[nextMatch[1]!.trim()];
    return wd === undefined ? undefined : { weekday: wd, next: true };
  }
  const wd = WEEKDAYS[lower];
  return wd === undefined ? undefined : { weekday: wd, next: false };
}

function relativeOffset(core: string): number | undefined {
  const lower = core.toLowerCase();
  if (/^pasado\s+ma[nñ]ana$/.test(lower) || /^day\s+after\s+tomorrow$/.test(lower)) return 2;
  if (/^ma[nñ]ana$/.test(lower) || /^tomorrow$/.test(lower)) return 1;
  if (/^hoy$/.test(lower) || /^today$/.test(lower)) return 0;
  return undefined;
}

function formatIso(
  year: number,
  month: number,
  day: number,
  time: { hour: number; minute: number } | undefined,
): { iso: string; hasTime: boolean } {
  const datePart = `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
  if (!time) return { iso: datePart, hasTime: false };
  return {
    iso: `${datePart}T${pad2(time.hour)}:${pad2(time.minute)}`,
    hasTime: true,
  };
}

export type NormalizedDate = {
  /** ISO-8601 `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (local wall-clock). */
  iso: string;
  /** True when the span carried an explicit time of day. */
  hasTime: boolean;
};

/**
 * Normalize a date/time span into ISO-8601. Relative days resolve against
 * `now` (default: current time). Throws `jev_invalid_date` for spans with
 * out-of-range calendar/clock parts.
 */
export function normalizeDate(
  span: string,
  now: Date = new Date(),
  field?: string,
): NormalizedDate {
  const raw = span.trim();

  const invalid = (detail: string): JevBodyError =>
    new JevBodyError(422, "jev_invalid_date", `Invalid date "${raw}": ${detail}.`, {
      field,
    });

  // ISO: 2026-09-27, 2026-09-27T15:00, 2026-09-27 15:00
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/.exec(raw);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const timeRaw = isoMatch[4];
    let time: { hour: number; minute: number } | undefined;
    if (timeRaw !== undefined) {
      time = parseTime(timeRaw);
      validateDateParts(year, month, day, time.hour, time.minute, field);
    } else {
      validateDateParts(year, month, day, undefined, undefined, field);
    }
    return formatIso(year, month, day, time);
  }

  // Numeric: 27/09/2026, 27-09-2026, 27/09/26 (day-first)
  const numMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(raw);
  if (numMatch) {
    const day = Number(numMatch[1]);
    const month = Number(numMatch[2]);
    const yearRaw = numMatch[3]!;
    const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
    validateDateParts(year, month, day, undefined, undefined, field);
    return formatIso(year, month, day, undefined);
  }

  // Combined / relative / weekday core + optional connector + optional time.
  const combined = new RegExp(
    `^(${NEXT_SOURCE}|${REL_SOURCE}|${WD_SOURCE})\\s*(?:a\\s+las|at|@)?\\s*(${TIME_SOURCE})?$`,
    "i",
  ).exec(raw);
  if (combined) {
    const core = combined[1]!;
    const timeRaw = combined[2];
    let time: { hour: number; minute: number } | undefined;
    try {
      if (timeRaw !== undefined) time = parseTime(timeRaw);
    } catch {
      throw invalid(`unparseable time "${timeRaw}"`);
    }

    const offset = relativeOffset(core);
    const weekday = offset === undefined ? weekdayOfPhrase(core) : undefined;
    if (offset === undefined && weekday === undefined) {
      throw invalid("unrecognized date expression");
    }

    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const addDays = offset ?? (weekday ? daysUntil(weekday.weekday, target.getDay(), weekday.next) : 0);
    target.setDate(target.getDate() + addDays);

    if (time) {
      validateDateParts(
        target.getFullYear(),
        target.getMonth() + 1,
        target.getDate(),
        time.hour,
        time.minute,
        field,
      );
    }
    return formatIso(
      target.getFullYear(),
      target.getMonth() + 1,
      target.getDate(),
      time,
    );
  }

  // Standalone time: today at that time.
  if (/^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$/i.test(raw) && /[:ap]/i.test(raw)) {
    try {
      const time = parseTime(raw);
      validateDateParts(
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        time.hour,
        time.minute,
        field,
      );
      return formatIso(
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        time,
      );
    } catch (err) {
      if (err instanceof JevBodyError) throw err;
      throw invalid("unparseable time");
    }
  }

  throw invalid("not a recognizable date or time");
}
