/**
 * `jevBody(spec)` Express middleware.
 *
 * Thin Express glue over the shared `runJevPipeline` runner: extracts the
 * natural-language text from the request (configurable extractor), runs the
 * pipeline (questions, single `systemOne` call, dual gates, typed
 * assembly), and exposes the result on `req.jev`.
 *
 * On any failure, raises a `JevBodyError` with a stable HTTP status so the
 * default error middleware can render a JSON diagnostics body.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { TypeSafeClient } from "@typesafe-ai/sdk";

import { JevBodyError } from "../core/errors.js";
import { runJevPipeline } from "../core/pipeline.js";
import {
  type DefinedSchema,
  type PayloadOf,
  type Schema,
} from "../core/schema.js";
import type { JevMeta } from "../core/types.js";

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
  /** Clock for relative date resolution in dateField (default: current time). */
  now?: () => Date;
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
      const pipelineOptions: Parameters<typeof runJevPipeline>[2] = { ...options };
      if (options.onReject) {
        const onReject = options.onReject;
        pipelineOptions.onGateReject = (err) => onReject(err, req);
      }
      const { payload, meta } = await runJevPipeline(text ?? "", spec, pipelineOptions);
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
