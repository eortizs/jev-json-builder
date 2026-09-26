/**
 * `jevBody(spec)` Express middleware.
 *
 * Reads natural-language text from the request (configurable extractor),
 * compiles Jev questions, sends a single `systemOne` call, runs the
 * dual gates (hazard noul + ambiguity confidence), assembles the typed
 * payload via code (closed-set answers, optional fields omitted), and
 * exposes the result on `req.jev`.
 *
 * On any failure, raises a `JevBodyError` with a stable HTTP status so the
 * default error middleware can render a JSON diagnostics body.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import { assemble } from "../core/assemble.js";
import { evaluateGates, defaultGateOptions } from "../core/gates.js";
import { JevBodyError } from "../core/errors.js";
import { buildQuestions } from "../core/questions.js";
import {
  DEFAULT_AMBIGUITY_THRESHOLD,
  DEFAULT_HAZARD_THRESHOLD,
  type DefinedSchema,
  type PayloadOf,
  type Schema,
} from "../core/schema.js";
import { resolveDefined } from "../core/schema.js";
import type { AnswerMap, JevMeta } from "../core/types.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      jev: unknown;
      jevMeta: JevMeta | undefined;
    }
  }
}

export type JevBodyOptions = {
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
  /** Custom input extractor. Default: req.body?.prompt || req.body?.text. */
  input?: (req: Request) => string | undefined;
  /** Optional hook called when a gate rejects. Can throw or return a payload. */
  onReject?: (
    err: JevBodyError,
    req: Request,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
};

/**
 * Create an Express middleware that builds a typed JSON payload from NL input.
 *
 * Use `getPayload(req, spec)` in your handler to get the typed result.
 */
export function jevBody<const S extends DefinedSchema>(
  spec: S,
  options: JevBodyOptions = {},
): RequestHandler {
  return async function jevBodyMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const text = (options.input ?? defaultInput)(req);
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
      const { questions, numericCandidates } = buildQuestions({
        defined: spec,
        inputText: text,
        hazardEnabled,
      });

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
        if (err instanceof JevBodyError && options.onReject) {
          const fallback = await options.onReject(err, req);
          if (fallback) {
            req.jev = fallback;
            req.jevMeta = meta;
            return next();
          }
        }
        throw err;
      }

      const payload = assemble(
        schema as Schema,
        meta.answers,
        numericCandidates,
        meta,
        { statedThreshold: options.statedThreshold ?? 0.7 },
      );

      req.jev = payload;
      req.jevMeta = meta;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function defaultInput(req: Request): string | undefined {
  const body = req.body as { prompt?: unknown; text?: unknown } | undefined;
  if (!body) return undefined;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.text === "string") return body.text;
  return undefined;
}

function resolveClient(provided: TypeSafeClient | undefined): TypeSafeClient {
  if (provided) return provided;
  if (!process.env.TYPESAFE_API_KEY) {
    throw new JevBodyError(
      502,
      "jev_upstream_error",
      "No TypeSafe client configured and TYPESAFE_API_KEY is unset.",
    );
  }
  return new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY });
}

/**
 * Typed accessor for `req.jev`. Pair with `PayloadOf<S>` to get the schema-
 * inferred type in your route handlers.
 */
export function getPayload<S extends Schema>(
  req: Request,
  _spec: S,
): PayloadOf<S> {
  if (req.jev === undefined) {
    throw new Error("getPayload called before jevBody middleware ran.");
  }
  return req.jev as PayloadOf<S>;
}
