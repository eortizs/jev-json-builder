/**
 * Schema ingestion facade: OpenAPI / Swagger / JSON Schema / Prisma -> JJB.
 *
 * `ingest(text)` auto-detects the input format and returns `IngestOutput`.
 * The runtime `Schema` objects plug straight into `jevBody` / `jevRouter`;
 * `renderSchemaSource(s)` emits the equivalent `defineSchema` TypeScript.
 */

import { ingestOpenApi, type OpenApiIngestOptions } from "./openapi.js";
import { ingestPrisma, type PrismaIngestOptions } from "./prisma.js";
import { jsonSchemaToSchema, type JsonSchemaToSchemaOptions } from "./jsonSchema.js";
import type { IngestOutput, SchemaSource } from "./types.js";

export type IngestFormat = "openapi" | "json-schema" | "prisma";

export type IngestOptions = {
  /** Force the input format instead of auto-detection. */
  format?: IngestFormat;
} & OpenApiIngestOptions &
  PrismaIngestOptions;

/**
 * Heuristic format detection:
 *   `.prisma`-style text (model/enum blocks, `datasource` blocks) -> prisma
 *   JSON with `openapi`/`swagger`/`paths`/`definitions`           -> openapi
 *   any other JSON object                                        -> json-schema
 */
export function detectFormat(text: string, filename?: string): IngestFormat {
  if (filename && /\.prisma$/i.test(filename)) return "prisma";
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return "prisma";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "prisma";
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const doc = parsed as Record<string, unknown>;
    if (
      typeof doc["openapi"] === "string" ||
      typeof doc["swagger"] === "string" ||
      doc["paths"] !== undefined ||
      doc["definitions"] !== undefined ||
      (doc["components"] as Record<string, unknown> | undefined)?.["schemas"] !== undefined
    ) {
      return "openapi";
    }
  }
  return "json-schema";
}

export function ingest(text: string, options: IngestOptions = {}): IngestOutput {
  const format = options.format ?? detectFormat(text);
  const names = options.names;

  switch (format) {
    case "prisma":
      return ingestPrisma(text, names ? { names } : {});
    case "openapi": {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `ingest: openapi input is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      return ingestOpenApi(
        doc,
        names || options.requestBodies !== undefined
          ? {
              ...(names ? { names } : {}),
              ...(options.requestBodies !== undefined
                ? { requestBodies: options.requestBodies }
                : {}),
            }
          : {},
      );
    }
    case "json-schema": {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `ingest: json-schema input is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error("ingest: json-schema input must be a JSON object.");
      }
      const result = jsonSchemaToSchema(doc as Record<string, unknown>);
      const source: SchemaSource = {
        name: "schema",
        origin: "json-schema",
        schema: result.schema,
        diagnostics: result.diagnostics,
      };
      return { sources: [source], diagnostics: [] };
    }
  }
}

export {
  ingestOpenApi,
  ingestOpenApiSchema,
  type OpenApiIngestOptions,
} from "./openapi.js";

export {
  ingestPrisma,
  ingestPrismaModel,
  parsePrisma,
  type PrismaIngestOptions,
} from "./prisma.js";

export {
  jsonSchemaToSchema,
  resolveNode,
  resolveJsonPointer,
  type JsonSchemaToSchemaOptions,
  type JsonSchemaToSchemaResult,
} from "./jsonSchema.js";

export {
  renderSchemaSource,
  renderSchemaSources,
  type RenderOptions,
} from "./render.js";

export {
  exportNameFor,
  toCamelIdent,
  defaultQuestion,
} from "./util.js";

export type {
  IngestDiagnostic,
  IngestOutput,
  JsonSchemaNode,
  SchemaSource,
} from "./types.js";