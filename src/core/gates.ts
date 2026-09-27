/**
 * Gate evaluation: hazard (adversarialness) and ambiguity (confidence spread).
 *
 * Returns null when all gates pass, or a list of failure reasons suitable
 * for a `JevBodyError` thrown by the middleware.
 */

import { JevBodyError, type FieldDiagnostic } from "./errors.js";
import { DEFAULT_AMBIGUITY_THRESHOLD, DEFAULT_HAZARD_THRESHOLD } from "./schema.js";
import type { AnswerMap, JevMeta } from "./types.js";

export type GateOptions = {
  hazardEnabled: boolean;
  hazardThreshold: number;
  ambiguityThreshold: number;
  fieldThresholds: Record<string, number>;
  /** Optional list of fields to gate (default: all schema fields). */
  fields: string[];
};

export function defaultGateOptions(
  hazardEnabled: boolean,
  schemaThreshold: number | undefined,
  fieldThresholds: Record<string, number> = {},
  fields: string[] = [],
): GateOptions {
  return {
    hazardEnabled,
    hazardThreshold: DEFAULT_HAZARD_THRESHOLD,
    ambiguityThreshold: schemaThreshold ?? DEFAULT_AMBIGUITY_THRESHOLD,
    fieldThresholds,
    fields,
  };
}

/**
 * Evaluate gates against the model's answers. Throws a `JevBodyError` on the
 * first failure (hazard wins over ambiguity; ambiguity is reported with the
 * full list of weak fields).
 */
export function evaluateGates(
  answers: AnswerMap,
  meta: JevMeta,
  options: GateOptions,
): void {
  if (options.hazardEnabled) {
    const hazard = answers["_hazard"];
    if (hazard && hazard.type === "noul" && hazard.noul > options.hazardThreshold) {
      throw new JevBodyError(
        422,
        "jev_hazard",
        "Adversarial input detected.",
        { gate: "hazard", meta: { model: meta.model, usage: meta.usage } },
      );
    }
  }

  const weakFields: FieldDiagnostic[] = [];
  for (const field of options.fields) {
    const threshold =
      options.fieldThresholds[field] ?? options.ambiguityThreshold;

    const ans = answers[field];
    if (ans && (ans.type === "choice" || ans.type === "score")) {
      if (ans.confidence < threshold) {
        weakFields.push({ field, confidence: ans.confidence, threshold });
      }
    }

    // int/number/string/date fields resolve their value from a paired
    // `<field>_candidates` choice selector whenever 2+ candidates exist.
    // That selector IS the field's real answer: gate it with the same
    // per-field threshold, otherwise a low-confidence pick silently
    // reaches assembly.
    const selector = answers[`${field}_candidates`];
    if (selector && selector.type === "choice") {
      if (selector.confidence < threshold) {
        weakFields.push({
          field: `${field}_candidates`,
          confidence: selector.confidence,
          threshold,
        });
      }
    }
  }

  if (weakFields.length > 0) {
    throw new JevBodyError(
      422,
      "jev_ambiguous",
      "Input semantics too ambiguous to safely build JSON.",
      {
        gate: "ambiguity",
        fields: weakFields,
        meta: { model: meta.model, usage: meta.usage },
      },
    );
  }
}
