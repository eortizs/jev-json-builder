/**
 * Shared JJB payload pipeline used by every transport glue (Express
 * middleware, NestJS interceptor).
 *
 * Runs the full loop against natural-language input text:
 *   resolve client -> build questions (candidate pools) -> single
 *   `systemOne` call -> dual gates (hazard noul + ambiguity confidence)
 *   -> assemble the typed payload via code.
 *
 * All failures are raised as `JevBodyError` with a stable HTTP status and
 * error code so transports can render a JSON diagnostics body.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";

import { assemble } from "./assemble.js";
import { resolveClient } from "./client.js";
import { JevBodyError } from "./errors.js";
import { evaluateGates, defaultGateOptions } from "./gates.js";
import { buildQuestions } from "./questions.js";
import {
  resolveDefined,
  DEFAULT_STATED_THRESHOLD,
  type DefinedSchema,
  type Schema,
} from "./schema.js";
import type { AnswerMap, JevMeta } from "./types.js";

export type JevPipelineOptions = {
  /** Override the TypeSafe client (e.g. inject a mock for tests). */
  client?: TypeSafeClient;
  /** Disable the hazard gate (default: enabled). */
  hazard?: boolean;
  /** Hazard noul threshold (default 0.5). */
  hazardThreshold?: number;
  /** Default ambiguity confidence threshold (default 0.85). */
  threshold?: number;
  /** Per-field ambiguity confidence threshold overrides. */
  fieldThresholds?: Record<string, number>;
  /** Stated-noul threshold above which an optional field is included (default 0.7). */
  statedThreshold?: number;
  /** Clock for relative date resolution in dateField (default: current time). */
  now?: () => Date;
  /** Optional hook called when a gate rejects. Return a payload to proceed with it. */
  onGateReject?: (
    err: JevBodyError,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
};

export type JevPipelineResult = {
  payload: Record<string, unknown>;
  meta: JevMeta;
};

/**
 * Run the complete JJB pipeline for one natural-language input string.
 * Transport-agnostic: throws `JevBodyError` on every failure path.
 */
export async function runJevPipeline(
  text: string,
  spec: DefinedSchema,
  options: JevPipelineOptions = {},
): Promise<JevPipelineResult> {
  if (!text || text.trim() === "") {
    throw new JevBodyError(
      400,
      "jev_missing_input",
      "No natural-language input found in request.",
    );
  }

  const client = resolveClient(options.client);
  const { schema, config } = resolveDefined(spec);

  const hazardEnabled = options.hazard ?? true;
  const built = buildQuestions({
    defined: spec,
    inputText: text,
    hazardEnabled,
  });
  const { questions, numericCandidates, spanCandidates, dateCandidates } = built;

  let result: { model: string; answers: AnswerMap; usage: JevMeta["usage"] };
  let elapsedMs = 0;
  try {
    const t0 = performance.now();
    const raw = await client.systemOne({ state: text, questions });
    elapsedMs = Math.round(performance.now() - t0);
    result = raw as unknown as { model: string; answers: AnswerMap; usage: JevMeta["usage"] };
  } catch (err) {
    throw new JevBodyError(
      502,
      "jev_upstream_error",
      err instanceof Error ? err.message : "Upstream TypeSafe request failed.",
    );
  }

  const meta: JevMeta = {
    model: result.model,
    answers: result.answers,
    usage: result.usage,
    elapsedMs,
  };

  const gateOpts = defaultGateOptions(
    hazardEnabled,
    options.threshold ?? config.threshold,
    options.fieldThresholds ?? {},
    Object.keys(schema),
  );
  if (options.hazardThreshold !== undefined) {
    gateOpts.hazardThreshold = options.hazardThreshold;
  }
  if (options.threshold !== undefined) {
    gateOpts.ambiguityThreshold = options.threshold;
  }
  if (options.fieldThresholds) {
    for (const [k, v] of Object.entries(options.fieldThresholds)) {
      gateOpts.fieldThresholds[k] = v;
    }
  }

  try {
    evaluateGates(meta.answers, meta, gateOpts);
  } catch (err) {
    if (err instanceof JevBodyError && options.onGateReject) {
      const fallback = await options.onGateReject(err);
      if (fallback) {
        return { payload: fallback, meta };
      }
    }
    throw err;
  }

  const payload = assemble(
    schema as Schema,
    meta.answers,
    numericCandidates,
    meta,
    {
      statedThreshold: options.statedThreshold ?? DEFAULT_STATED_THRESHOLD,
      spanCandidates,
      dateCandidates,
      now: options.now,
    },
  );

  return { payload, meta };
}
