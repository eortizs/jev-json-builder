/**
 * Structured error raised by the JJB middleware. Carries an HTTP status,
 * a stable error code, and per-field diagnostics so the error middleware
 * can render a useful JSON response without losing context.
 */

import type { JevMeta } from "./types.js";

export type JevErrorCode =
  | "jev_missing_input"
  | "jev_hazard"
  | "jev_ambiguous"
  | "jev_missing_candidate"
  | "jev_invalid_number"
  | "jev_upstream_error";

export type GateKind = "hazard" | "ambiguity";

export type FieldDiagnostic = {
  field: string;
  confidence: number;
  threshold: number;
};

export type JevErrorBody = {
  error: "jev_gate_failed" | "jev_missing_input" | "jev_upstream_error";
  code: JevErrorCode;
  message: string;
  gate: GateKind | undefined;
  fields: FieldDiagnostic[] | undefined;
  field: string | undefined;
  meta: Pick<JevMeta, "usage" | "model"> | undefined;
};

export class JevBodyError extends Error {
  readonly status: number;
  readonly code: JevErrorCode;
  readonly body: JevErrorBody;

  constructor(
    status: number,
    code: JevErrorCode,
    message: string,
    extras: Partial<JevErrorBody> = {},
  ) {
    super(message);
    this.name = "JevBodyError";
    this.status = status;
    this.code = code;
    this.body = {
      error:
        code === "jev_missing_input"
          ? "jev_missing_input"
          : code === "jev_upstream_error"
            ? "jev_upstream_error"
            : "jev_gate_failed",
      code,
      message,
      gate: extras.gate,
      fields: extras.fields,
      field: extras.field,
      meta: extras.meta,
    };
  }
}
