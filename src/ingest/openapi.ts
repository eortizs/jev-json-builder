/**
 * OpenAPI / Swagger -> JJB schema sources.
 *
 * Supports:
 *   - OpenAPI 3.x  `components.schemas`  (+ `components.requestBodies`)
 *   - Swagger 2.0  `definitions`         (+ operation body parameters)
 *
 * Every object-shaped definition becomes one `SchemaSource`; `$ref`s resolve
 * against the whole document. Request bodies reference their parent operation
 * via `x-jev-operation`.
 */

import {
  jsonSchemaToSchema,
  resolveNode,
  type JsonSchemaToSchemaResult,
} from "./jsonSchema.js";
import type { IngestDiagnostic, IngestOutput, JsonSchemaNode, SchemaSource } from "./types.js";

export type OpenApiIngestOptions = {
  /**
   * Only ingest these definition names (case-sensitive). Omit to ingest
   * every object-shaped schema in the document.
   */
  names?: string[];
  /** Also map operation request bodies (default: true). */
  requestBodies?: boolean;
};

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openApiRoot(doc: JsonSchemaNode): {
  version: "3" | "2" | "unknown";
  definitions: Record<string, JsonSchemaNode>;
  refPrefix: string;
} {
  const rawVersion = doc["openapi"] ?? doc["swagger"];
  const version =
    typeof rawVersion === "string" && rawVersion.startsWith("3")
      ? "3"
      : typeof rawVersion === "string" && rawVersion.startsWith("2")
        ? "2"
        : "unknown";

  if (version === "2") {
    const defs = doc["definitions"];
    return {
      version,
      definitions: isNode(defs) ? (defs as Record<string, JsonSchemaNode>) : {},
      refPrefix: "#/definitions/",
    };
  }

  const components = doc["components"];
  const schemas =
    isNode(components) && isNode(components["schemas"])
      ? (components["schemas"] as Record<string, JsonSchemaNode>)
      : {};
  return { version, definitions: schemas, refPrefix: "#/components/schemas/" };
}

function bodySchemaOf(
  node: JsonSchemaNode,
  root: JsonSchemaNode,
): JsonSchemaNode | undefined {
  if (typeof node["$ref"] === "string") {
    const resolved = resolveNode(node, root);
    return isNode(resolved) ? resolved : undefined;
  }
  if (isNode(node["content"])) {
    const content = node["content"] as Record<string, unknown>;
    const media =
      content["application/json"] ?? content["*/*"] ?? Object.values(content)[0];
    if (isNode(media) && isNode(media["schema"])) return media["schema"];
    return undefined;
  }
  return isNode(node["schema"]) ? node["schema"] : undefined;
}

function collectRequestBodies(
  doc: JsonSchemaNode,
  root: JsonSchemaNode,
  want: OpenApiIngestOptions["names"],
): { name: string; node: JsonSchemaNode }[] {
  const out: { name: string; node: JsonSchemaNode }[] = [];
  const paths = doc["paths"];
  if (!isNode(paths)) return out;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isNode(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isNode(operation)) continue;
      const opName =
        typeof operation["operationId"] === "string"
          ? operation["operationId"]
          : `${method} ${path}`;
      if (want && !want.includes(opName)) continue;

      const candidates: unknown[] = [];
      if (operation["requestBody"] !== undefined) candidates.push(operation["requestBody"]);
      const params = operation["parameters"];
      if (Array.isArray(params)) {
        for (const param of params) {
          if (isNode(param) && param["in"] === "body") candidates.push(param);
        }
      }

      for (const candidate of candidates) {
        if (!isNode(candidate)) continue;
        const schema = bodySchemaOf(candidate, root);
        if (!schema) continue;
        const flat = resolveNode(schema, root);
        if (!isNode(flat["properties"]) && !isNode(flat["allOf"])) continue;
        out.push({ name: opName, node: schema });
      }
    }
  }
  return out;
}

export function ingestOpenApi(
  doc: unknown,
  options: OpenApiIngestOptions = {},
): IngestOutput {
  if (!isNode(doc)) {
    throw new Error("ingestOpenApi: expected a JSON object (OpenAPI/Swagger document).");
  }

  const { version, definitions, refPrefix } = openApiRoot(doc);
  const diagnostics: IngestDiagnostic[] = [];
  const sources: SchemaSource[] = [];
  const want = options.names;

  if (version === "unknown") {
    diagnostics.push({
      path: "",
      message:
        "document has no `openapi`/`swagger` version field; parsing as OpenAPI 3-style `components.schemas`",
      level: "heuristic",
    });
  }

  for (const [name, node] of Object.entries(definitions)) {
    if (want && !want.includes(name)) continue;
    const flat = resolveNode(node, doc);
    if (!isNode(flat["properties"]) && !isNode(flat["allOf"])) {
      diagnostics.push({
        path: `${refPrefix}${name}`,
        message:
          "skipped: definition is not an object schema (enums/scalars can only appear as property refs)",
        level: "skipped",
      });
      continue;
    }

    const result: JsonSchemaToSchemaResult = jsonSchemaToSchema(node, { root: doc });
    sources.push({
      name,
      origin: `components.schemas.${name}`,
      schema: result.schema,
      diagnostics: result.diagnostics,
    });
  }

  if (options.requestBodies ?? true) {
    for (const { name, node } of collectRequestBodies(doc, doc, want)) {
      const result = jsonSchemaToSchema(node, { root: doc });
      sources.push({
        name,
        origin: `requestBody:${name}`,
        schema: result.schema,
        diagnostics: result.diagnostics.map((d) => ({
          ...d,
          path: d.path ? `requestBody.${d.path}` : "requestBody",
        })),
      });
    }
  }

  diagnostics.push({
    path: "",
    message: `ingested ${String(sources.length)} schema source(s) from ${
      version === "2" ? "Swagger 2.0" : version === "3" ? "OpenAPI 3.x" : "unversioned document"
    }`,
    level: "heuristic",
  });

  return { sources, diagnostics: [...diagnostics] };
}

/** Convenience: ingest a single named definition (throws when absent). */
export function ingestOpenApiSchema(
  doc: unknown,
  name: string,
  options: Omit<OpenApiIngestOptions, "names"> = {},
): SchemaSource {
  const out = ingestOpenApi(doc, { ...options, names: [name] });
  const source = out.sources.find((s) => s.name === name);
  if (!source) {
    const hints = out.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ");
    throw new Error(
      `ingestOpenApiSchema: no object schema named "${name}" found.${hints ? ` (${hints})` : ""}`,
    );
  }
  return source;
}