/**
 * Shared types for schema ingestion (OpenAPI / JSON Schema / Prisma -> JJB).
 */

import type { Schema } from "../core/schema.js";

/** Loose JSON Schema / OpenAPI schema-object view. */
export type JsonSchemaNode = Record<string, unknown>;

export type IngestDiagnostic = {
  /** Location of the node, e.g. `properties.tags`. */
  path: string;
  message: string;
  /** `skipped` = field omitted; `heuristic` = mapped with a caveat. */
  level: "skipped" | "heuristic";
};

export type SchemaSource = {
  /** Source-level name (component key, operation id, model name, ...). */
  name: string;
  /** Provenance string, e.g. `components.schemas.CreateOrder`. */
  origin: string;
  /** Runtime JJB schema, ready for `jevBody` / `jevRouter`. */
  schema: Schema;
  /** Per-field mapping notes. */
  diagnostics: IngestDiagnostic[];
};

export type IngestOutput = {
  sources: SchemaSource[];
  diagnostics: IngestDiagnostic[];
};