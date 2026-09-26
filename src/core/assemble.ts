/**
 * Assemble the final typed payload from Jev's answers.
 *
 * Responsibilities:
 *  - drop optional fields when their `*_stated` noul <= statedThreshold
 *  - select the chosen numeric candidate and normalize to a finite number
 *    (Math.floor for intField, Number for numberField)
 *  - keep all SDK answer-type casts confined to this file
 *
 * Any field-construction failure raises a JevBodyError suitable for the
 * Express error middleware.
 */

import {
  DEFAULT_STATED_THRESHOLD,
  type Field,
  type Schema,
} from "./schema.js";
import { JevBodyError } from "./errors.js";
import type { AnswerMap, JevMeta } from "./types.js";

export type AssembleOptions = {
  statedThreshold: number;
};

export function assemble<S extends Schema>(
  schema: S,
  answers: AnswerMap,
  numericCandidates: Record<string, string[]>,
  meta: JevMeta,
  options: AssembleOptions = { statedThreshold: DEFAULT_STATED_THRESHOLD },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(schema)) {
    const ans = answers[name];

    // Optional fields: only include when the model confirms they were stated.
    if (field.options.optional) {
      const stated = answers[`${name}_stated`];
      const statedYes =
        stated && stated.type === "noul" && stated.noul > options.statedThreshold;
      if (!statedYes) continue;

      // For numeric fields there is no primary Choice question — the value
      // comes from pre-parsed candidates. For enum/score we need an answer.
      if (field.kind === "enum" || field.kind === "score") {
        if (!ans) continue;
        payload[name] = extractChoiceOrScore(ans, name);
        continue;
      }
      if (field.kind === "int" || field.kind === "number") {
        payload[name] = pickNumeric(
          name,
          field,
          ans,
          answers,
          numericCandidates[name] ?? [],
        );
        continue;
      }
    }

    // Required fields.
    if (field.kind === "int" || field.kind === "number") {
      payload[name] = pickNumeric(
        name,
        field,
        ans,
        answers,
        numericCandidates[name] ?? [],
      );
      continue;
    }

    if (!ans) {
      throw new JevBodyError(
        422,
        "jev_ambiguous",
        `Missing answer for required field "${name}".`,
        { field: name, meta: { model: meta.model, usage: meta.usage } },
      );
    }

    if (field.kind === "enum") {
      if (ans.type !== "choice") {
        throw new JevBodyError(
          422,
          "jev_ambiguous",
          `Unexpected answer type for enum field "${name}".`,
          { field: name, meta: { model: meta.model, usage: meta.usage } },
        );
      }
      payload[name] = ans.choice;
      continue;
    }

    if (field.kind === "score") {
      if (ans.type !== "score") {
        throw new JevBodyError(
          422,
          "jev_ambiguous",
          `Unexpected answer type for score field "${name}".`,
          { field: name, meta: { model: meta.model, usage: meta.usage } },
        );
      }
      payload[name] = ans.score;
      continue;
    }
  }

  return payload;
}

function extractChoiceOrScore(ans: AnswerMap[string], name: string): unknown {
  if (ans.type === "choice") return ans.choice;
  if (ans.type === "score") return ans.score;
  throw new JevBodyError(
    422,
    "jev_ambiguous",
    `Cannot use a noul answer for field "${name}".`,
    { field: name },
  );
}

function pickNumeric(
  name: string,
  field: Extract<Field, { kind: "int" | "number" }>,
  primary: AnswerMap[string] | undefined,
  answers: AnswerMap,
  cands: string[],
): number {
  // When no candidates exist, we cannot produce a number from Jev (Score
  // is not numeric extraction).
  if (cands.length === 0) {
    throw new JevBodyError(
      400,
      "jev_missing_candidate",
      `No numeric candidate found for field "${name}" despite being stated.`,
      { field: name },
    );
  }

  let raw: string;
  if (cands.length === 1) {
    raw = cands[0]!;
  } else {
    const c = answers[`${name}_candidates`];
    if (!c || c.type !== "choice") {
      throw new JevBodyError(
        422,
        "jev_invalid_number",
        `Multi-candidate selector missing for field "${name}".`,
        { field: name },
      );
    }
    const idx = Number(c.choice.slice(1));
    if (!Number.isInteger(idx) || idx < 0 || idx >= cands.length) {
      throw new JevBodyError(
        422,
        "jev_invalid_number",
        `Invalid candidate index for field "${name}".`,
        { field: name },
      );
    }
    raw = cands[idx]!;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new JevBodyError(
      422,
      "jev_invalid_number",
      `Candidate could not be normalized to a finite number for field "${name}".`,
      { field: name },
    );
  }

  return field.kind === "int" ? Math.floor(parsed) : parsed;
}
