/**
 * `jevRouter(spec, options)` Express middleware.
 *
 * Composes a Level-1 semantic router (see `semanticRouter`) with the
 * existing `jevBody` pipeline for the FAST destination and an
 * injected `onComplex` RequestHandler for everything else.
 *
 *   POST -> [router: systemOne(route + _hazard)] -> FAST -> jevBody pipeline
 *                                                     -> COMPLEX -> options.onComplex
 *
 * On the FAST path, `req.jev`, `req.jevMeta`, and `getPayload(req, spec)`
 * keep the same contract as `jevBody`. On the COMPLEX path, `req.jevRoute`
 * exposes the decision so `onComplex` can apply its own restrictions.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { JevBodyError } from "../core/errors.js";
import {
  DEFAULT_FAST_DESTINATION,
  type RouteDecision,
  type RouteDestinations,
  semanticRouter,
} from "../core/router.js";
import type { DefinedSchema } from "../core/schema.js";

import { jevBody, type JevBodyOptions } from "./jevBody.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      jevRoute: RouteDecision | undefined;
    }
  }
}

export type JevRouterOptions = JevBodyOptions & {
  /** Handler invoked when the router picks a non-FAST destination. Required. */
  onComplex: RequestHandler;
  /** Override destination map. */
  destinations?: RouteDestinations;
  /** Confidence threshold for the FAST destination (default 0.85). */
  routeThreshold?: number;
  /** Override the fallback destination (default `COMPLEX_LLM_AGENT`). */
  fallbackDestination?: string;
  /** Override the label treated as the fast path (default `FAST_JSON_PAYLOAD`). */
  fastDestination?: string;
  /** Hazard policy for the router call. */
  routeHazard?: boolean | { question?: string; threshold?: number };
};

export function jevRouter<const S extends DefinedSchema>(
  spec: S,
  options: JevRouterOptions,
): RequestHandler {
  if (typeof options.onComplex !== "function") {
    throw new TypeError(
      "jevRouter: `onComplex` is required and must be an Express RequestHandler.",
    );
  }

  const fastDestination = options.fastDestination ?? DEFAULT_FAST_DESTINATION;
  const bodyHandler = jevBody(spec, options);

  return async function jevRouterMiddleware(
    req: Request,
    res: Response,
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

      let decision: RouteDecision;
      try {
        const routerOpts: Parameters<typeof semanticRouter>[1] = {};
        if (options.client !== undefined) routerOpts.client = options.client;
        if (options.destinations !== undefined) routerOpts.destinations = options.destinations;
        if (options.routeThreshold !== undefined) routerOpts.threshold = options.routeThreshold;
        if (options.fallbackDestination !== undefined) routerOpts.fallbackDestination = options.fallbackDestination;
        if (options.routeHazard !== undefined) routerOpts.hazard = options.routeHazard;
        decision = await semanticRouter(text, routerOpts);
      } catch (err) {
        return next(err);
      }

      req.jevRoute = decision;

      if (decision.destination === fastDestination) {
        await bodyHandler(req, res, next);
        return;
      }

      await options.onComplex(req, res, next);
      return;
    } catch (err) {
      return next(err);
    }
  };
}

/** Typed accessor for `req.jevRoute`. */
export function getRouteDecision(req: Request): RouteDecision {
  if (!req.jevRoute) {
    throw new Error("getRouteDecision called before jevRouter middleware ran.");
  }
  return req.jevRoute;
}

function defaultInput(req: Request): string | undefined {
  const body = req.body as { prompt?: unknown; text?: unknown } | undefined;
  if (!body) return undefined;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.text === "string") return body.text;
  return undefined;
}
