/**
 * Shared TypeSafe client resolver used by `jevBody` and `semanticRouter`.
 * Kept in its own file so both callers stay in sync with the env contract.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";

import { JevBodyError } from "./errors.js";

export function resolveClient(provided: TypeSafeClient | undefined): TypeSafeClient {
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
