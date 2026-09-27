/**
 * Compile a JJB schema + per-request state into a TypeSafe questions map.
 *
 * Per-request state includes numeric candidates for numeric fields. When a
 * numeric field has >= 2 candidates we add an extra `choice` question to
 * let the model pick which one is the size (or date) we want.
 *
 * Optional fields always generate a paired `noul` `<name>_stated` question.
 *
 * A hazard `noul` is added unless explicitly disabled in the schema config
 * or middleware options.
 */

import {
  choice,
  noul,
  score,
  type Question,
  type Questions,
} from "@typesafe-ai/sdk";

import { candidateIndexFromKey, numericCandidates } from "./candidates.js";
import { spanCandidates } from "./spans.js";
import { extractDateCandidates } from "./dates.js";
import { DEFAULT_HAZARD_QUESTION } from "./schema.js";
import type { Schema } from "./schema.js";
import { resolveDefined, type DefinedSchema } from "./schema.js";

export type BuildQuestionsInput = {
  defined: DefinedSchema;
  inputText: string;
  hazardEnabled: boolean;
};

export type BuiltQuestions = {
  questions: Questions;
  /** Per-field numeric candidates (verbatim digit strings). */
  numericCandidates: Record<string, string[]>;
  /** Shared free-text span pool extracted from the input. */
  spanCandidates: string[];
  /** Shared date/time span pool extracted from the input. */
  dateCandidates: string[];
};

export function buildQuestions({
  defined,
  inputText,
  hazardEnabled,
}: BuildQuestionsInput): BuiltQuestions {
  const { schema, config } = resolveDefined(defined);
  const numericCandidatesByField: Record<string, string[]> = {};
  const spans = spanCandidates(inputText);
  const dates = extractDateCandidates(inputText);

  const questions: Record<string, Question> = {};

  for (const [name, field] of Object.entries(schema)) {
    switch (field.kind) {
      case "enum": {
        questions[name] = choice(field.options.question, field.criteria) as Question;
        break;
      }
      case "score": {
        questions[name] = score(
          field.options.question,
          field.levels as unknown as readonly [string, string, ...string[]],
        ) as Question;
        break;
      }
      case "int":
      case "number": {
        const cands = numericCandidates(inputText);
        numericCandidatesByField[name] = cands;
        if (cands.length >= 2) {
          questions[`${name}_candidates`] = candidateChoice(
            `Which stated number is ${field.options.question.toLowerCase()}?`,
            cands,
            (n) => `The number ${n}`,
          );
        }
        break;
      }
      case "string": {
        if (spans.length >= 2) {
          questions[`${name}_candidates`] = candidateChoice(
            `Which stated text is ${field.options.question.toLowerCase()}?`,
            spans,
            (span) => `The text ${span}`,
          );
        }
        break;
      }
      case "date": {
        if (dates.length >= 2) {
          questions[`${name}_candidates`] = candidateChoice(
            `Which stated date is ${field.options.question.toLowerCase()}?`,
            dates,
            (date) => `The date ${date}`,
          );
        }
        break;
      }
    }

    if (field.options.optional) {
      questions[`${name}_stated`] = noul(
        `Does the user state ${field.options.question.toLowerCase()}?`,
      ) as Question;
    }
  }

  if (hazardEnabled) {
    const hazardOverride =
      typeof config.hazard === "object" && config.hazard !== null
        ? config.hazard.question
        : DEFAULT_HAZARD_QUESTION;
    questions["_hazard"] = noul(hazardOverride) as Question;
  }

  return {
    questions,
    numericCandidates: numericCandidatesByField,
    spanCandidates: spans,
    dateCandidates: dates,
  };
}

/** Build a candidate-selector Choice question over an ordered pool. */
function candidateChoice(
  question: string,
  pool: string[],
  label: (candidate: string) => string,
): Question {
  const options: Record<string, string> = {};
  pool.forEach((candidate, i) => {
    options[`n${i}`] = label(candidate);
  });
  return choice(question, options) as Question;
}

/** Validates that a candidate choice key is well-formed and in range. */
export function isValidCandidateKey(
  field: string,
  key: string,
  candidates: string[],
): boolean {
  const idx = candidateIndexFromKey(key);
  return idx !== undefined && idx < candidates.length;
}
