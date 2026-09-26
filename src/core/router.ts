/**
 * Level-1 semantic router.
 *
 * Wraps a single `systemOne` call that asks Jev to classify the user's prompt
 * into one of N destination labels (default `FAST_JSON_PAYLOAD` /
 * `COMPLEX_LLM_AGENT`). When the chosen label's confidence is below
 * `threshold`, the decision falls back to `fallbackDestination` instead of
 * surfacing the raw uncertainty. An optional `_hazard` noul question is sent
 * in the same call to act as a perimeter guardrail.
 *
 * The router never invokes any heavy LLM itself; consumers compose it with
 * their own agent for non-FAST destinations. See `jevRouter` for the
 * Express middleware that wires the fast path through `jevBody`.
 */

import {
  choice,
  noul,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";

import { resolveClient } from "./client.js";
import { JevBodyError } from "./errors.js";
import {
  DEFAULT_HAZARD_QUESTION,
  DEFAULT_HAZARD_THRESHOLD,
} from "./schema.js";
import type { AnswerMap, JevMeta } from "./types.js";

/** Destination label (criteria key) -> human-readable description. */
export type RouteDestinations = Record<string, string>;

export const DEFAULT_ROUTE_DESTINATIONS: RouteDestinations = {
  FAST_JSON_PAYLOAD:
    "A direct request that supplies explicit, machine-readable parameters for a known operation (e.g. sizes, colors, named actions).",
  COMPLEX_LLM_AGENT:
    "An open-ended conversation, a theoretical question, a creative or ambiguous design request, or anything that does not map cleanly to a known structured payload.",
};

export const DEFAULT_ROUTE_THRESHOLD = 0.85;
export const DEFAULT_FALLBACK_DESTINATION = "COMPLEX_LLM_AGENT";
export const DEFAULT_FAST_DESTINATION = "FAST_JSON_PAYLOAD";

const ROUTE_INSTRUCTIONS =
  "Classify the user's message as either a direct, parameter-explicit request for a known structured operation, or an open conversation / ambiguous / creative request that needs human-like reasoning.";

export type SemanticRouterOptions = {
  /** Inject a client (e.g. mock for tests). Defaults to env-backed `TypeSafeClient`. */
  client?: TypeSafeClient;
  /** Map of destination label -> description. Keys ARE the criteria keys. */
  destinations?: RouteDestinations;
  /** Confidence threshold for the chosen destination (default 0.85). */
  threshold?: number;
  /** Destination to use when the model's confidence is below `threshold`. */
  fallbackDestination?: string;
  /** Hazard noul policy (default true; use `false` to disable the perimeter check). */
  hazard?: boolean | { question?: string; threshold?: number };
  /** Override the elapsed timer (tests). */
  _now?: () => number;
};

export type RouteDecision = {
  prompt: string;
  /** Destination label actually chosen (after fallback policy). */
  destination: string;
  /** Raw confidence reported by the model for `destination`. */
  confidence: number;
  /** Per-destination probabilities from the choice question. */
  probabilities: Record<string, number>;
  /** True when the fallback policy rewrote the raw choice. */
  fallback: boolean;
  /** Raw `_hazard` noul when hazard was enabled. */
  hazard: number | undefined;
  /** Meta of the router's own systemOne call. */
  meta: JevMeta;
};

function resolveHazard(
  hazard: SemanticRouterOptions["hazard"],
): { enabled: true; question: string; threshold: number } | { enabled: false } {
  if (hazard === false) return { enabled: false };
  if (hazard === undefined || hazard === true) {
    return { enabled: true, question: DEFAULT_HAZARD_QUESTION, threshold: DEFAULT_HAZARD_THRESHOLD };
  }
  return {
    enabled: true,
    question: hazard.question ?? DEFAULT_HAZARD_QUESTION,
    threshold: hazard.threshold ?? DEFAULT_HAZARD_THRESHOLD,
  };
}

export async function semanticRouter(
  prompt: string,
  options: SemanticRouterOptions = {},
): Promise<RouteDecision> {
  if (!prompt || prompt.trim() === "") {
    throw new JevBodyError(
      400,
      "jev_missing_input",
      "No natural-language input found in request.",
    );
  }

  const client = resolveClient(options.client);
  const destinations = options.destinations ?? DEFAULT_ROUTE_DESTINATIONS;
  const threshold = options.threshold ?? DEFAULT_ROUTE_THRESHOLD;
  const fallbackDestination =
    options.fallbackDestination ?? DEFAULT_FALLBACK_DESTINATION;
  const fastDestination =
    Object.keys(destinations).find((k) => k === DEFAULT_FAST_DESTINATION) ??
    Object.keys(destinations)[0] ??
    DEFAULT_FALLBACK_DESTINATION;

  if (!Object.hasOwn(destinations, fallbackDestination)) {
    throw new Error(
      `semanticRouter: fallbackDestination "${fallbackDestination}" must be a key in destinations.`,
    );
  }
  for (const key of Object.keys(destinations)) {
    if (typeof destinations[key] !== "string") {
      throw new Error(
        `semanticRouter: destination "${key}" description must be a string.`,
      );
    }
  }

  const hazard = resolveHazard(options.hazard);

  const questions: Record<string, unknown> = {
    route: choice(ROUTE_INSTRUCTIONS, destinations) as unknown,
  };
  if (hazard.enabled) {
    questions["_hazard"] = noul(hazard.question) as unknown;
  }

  let raw: { model: string; answers: Record<string, unknown>; usage: unknown };
  let elapsedMs = 0;
  const now = options._now ?? (() => performance.now());
  const t0 = now();
  try {
    const result = await client.systemOne({
      state: prompt,
      questions: questions as Parameters<typeof client.systemOne>[0]["questions"],
    });
    elapsedMs = Math.round(now() - t0);
    raw = result as unknown as typeof raw;
  } catch (err) {
    throw new JevBodyError(
      502,
      "jev_upstream_error",
      err instanceof Error ? err.message : "Upstream TypeSafe request failed.",
    );
  }

  const answers = raw.answers as AnswerMap;
  const routeAnswer = answers["route"];
  const hazardAnswer = answers["_hazard"];

  const meta: JevMeta = {
    model: raw.model,
    answers,
    usage: raw.usage as JevMeta["usage"],
    elapsedMs,
  };

  if (hazard.enabled && hazardAnswer && hazardAnswer.type === "noul") {
    if (hazardAnswer.noul > hazard.threshold) {
      throw new JevBodyError(
        422,
        "jev_hazard",
        "Adversarial input detected.",
        { gate: "hazard", meta: { model: meta.model, usage: meta.usage } },
      );
    }
  }

  if (!routeAnswer || routeAnswer.type !== "choice") {
    throw new JevBodyError(
      502,
      "jev_upstream_error",
      "Router response did not include a choice answer for `route`.",
    );
  }

  const rawDestination = String(routeAnswer.choice);
  const confidence = routeAnswer.confidence;
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(routeAnswer.probabilities)) {
    probabilities[k] = v;
  }

  const fallback = confidence < threshold;
  const destination = fallback ? fallbackDestination : rawDestination;

  return {
    prompt,
    destination,
    confidence,
    probabilities,
    fallback,
    hazard: hazard.enabled && hazardAnswer && hazardAnswer.type === "noul"
      ? hazardAnswer.noul
      : undefined,
    meta,
  };
}

/**
 * Convenience: returns true when the decision points at the fast JSON pipeline.
 * Useful for tests and for callers that want to branch on the outcome without
 * hardcoding the `FAST_JSON_PAYLOAD` label.
 */
export function isFastRoute(
  decision: RouteDecision,
  fastDestination: string = DEFAULT_FAST_DESTINATION,
): boolean {
  return decision.destination === fastDestination;
}

export const _internal = { ROUTE_INSTRUCTIONS };
