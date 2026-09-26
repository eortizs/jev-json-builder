/**
 * JSON Schema -> JJB schema converter (the shared ingestion core).
 *
 * Mapping rules (per property of an object schema):
 *   string + enum/const        -> enumField (closed set; criteria keys = values)
 *   integer / number + enum    -> enumField (values stringified; heuristic diag)
 *   integer                    -> intField
 *   number                     -> numberField
 *   boolean                    -> enumField("true"/"false"; heuristic diag)
 *   string without enum        -> SKIPPED (free text is not JJB's job)
 *   array / object / others    -> SKIPPED (flat payloads only)
 *
 * Optionality: property absent from the parent `required` list, or nullable
 * (OAS `nullable: true`, JSON Schema `type: [..., "null"]`, `oneOf`/`anyOf`
 * with a null variant) -> `optional: true`.
 *
 * Vendor extensions (escape hatches):
 *   x-jev-question   string       override the generated question text
 *   x-jev-levels     string[]     map to scoreField(levels) instead
 *   x-jev-criteria   Record<...>  per-value criteria descriptions for enums
 *   x-jev-threshold  number       per-field ambiguity threshold
 *   x-jev-skip       true         drop the field silently
 */

import {
  enumField,
  intField,
  numberField,
  scoreField,
  type Field,
  type FieldOptions,
  type Schema,
} from "../core/schema.js";

import type { IngestDiagnostic, JsonSchemaNode } from "./types.js";
import { defaultQuestion, valueKey } from "./util.js";

export type JsonSchemaToSchemaOptions = {
  /** Root document used to resolve local `$ref` pointers. Defaults to the node. */
  root?: JsonSchemaNode;
};

export type JsonSchemaToSchemaResult = {
  schema: Schema;
  diagnostics: IngestDiagnostic[];
};

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve a local `#/...` JSON pointer against a document root. */
export function resolveJsonPointer(
  root: JsonSchemaNode,
  ref: string,
): JsonSchemaNode | undefined {
  if (!ref.startsWith("#")) return undefined;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const idx = Number(part);
      current = Number.isInteger(idx) ? current[idx] : undefined;
    } else if (isNode(current)) {
      current = current[part];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return isNode(current) ? current : undefined;
}

/**
 * Follow `$ref` chains (sibling keys win per JSON Schema 2019+) with a
 * cycle guard. External refs are returned unresolved (caller decides).
 */
export function resolveNode(
  node: JsonSchemaNode,
  root: JsonSchemaNode,
  seen: Set<string> = new Set(),
): JsonSchemaNode {
  const ref = node["$ref"];
  let base: JsonSchemaNode = node;
  if (typeof ref === "string") {
    if (seen.has(ref)) return {};
    seen.add(ref);
    const target = resolveJsonPointer(root, ref);
    if (target) base = resolveNode(target, root, seen);
  }
  const merged: JsonSchemaNode = { ...base };
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") continue;
    merged[key] = value;
  }
  return merged;
}

function mergeSchemaNodes(a: JsonSchemaNode, b: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = { ...a, ...b };
  const propsA = isNode(a["properties"]) ? a["properties"] : {};
  const propsB = isNode(b["properties"]) ? b["properties"] : {};
  if (Object.keys(propsA).length > 0 || Object.keys(propsB).length > 0) {
    out["properties"] = { ...propsA, ...propsB };
  }
  const reqA = Array.isArray(a["required"]) ? a["required"] : [];
  const reqB = Array.isArray(b["required"]) ? b["required"] : [];
  if (reqA.length > 0 || reqB.length > 0) {
    out["required"] = [...new Set([...reqA, ...reqB])];
  }
  return out;
}

/** Flatten `allOf` compositions into a single effective node. */
function flattenAllOf(node: JsonSchemaNode, root: JsonSchemaNode): JsonSchemaNode {
  let resolved = resolveNode(node, root);
  const allOf = resolved["allOf"];
  if (Array.isArray(allOf)) {
    let merged: JsonSchemaNode = {};
    for (const part of allOf) {
      if (!isNode(part)) continue;
      merged = mergeSchemaNodes(merged, flattenAllOf(part, root));
    }
    const { allOf: _drop, ...rest } = resolved;
    resolved = mergeSchemaNodes(merged, rest);
  }
  return resolved;
}

type VariantUnion =
  | { kind: "single"; node: JsonSchemaNode; nullable: boolean }
  | { kind: "enum"; values: { value: string; description: string }[]; nullable: boolean }
  | { kind: "unsupported"; reason: string };

/**
 * Resolve `oneOf` / `anyOf`:
 *  - the nullable idiom (exactly one real variant + null variants) -> single + nullable
 *  - all variants `const`/`enum` of scalars -> merged closed set
 */
function resolveUnion(node: JsonSchemaNode, root: JsonSchemaNode): VariantUnion {
  const variantsRaw = node["oneOf"] ?? node["anyOf"];
  if (!Array.isArray(variantsRaw)) {
    return { kind: "single", node, nullable: false };
  }

  const variants = variantsRaw.filter(isNode).map((v) => flattenAllOf(v, root));
  const nullish = (v: JsonSchemaNode): boolean => v["type"] === "null" || v["const"] === null;
  const nullable = variants.some(nullish) || node["nullable"] === true;
  const real = variants.filter((v) => !nullish(v));

  if (real.length === 0) {
    return { kind: "unsupported", reason: "oneOf/anyOf has no non-null variant" };
  }

  if (real.length === 1) {
    const { oneOf: _a, anyOf: _b, ...rest } = node;
    return {
      kind: "single",
      node: mergeSchemaNodes(real[0]!, rest),
      nullable,
    };
  }

  const values: { value: string; description: string }[] = [];
  for (const variant of real) {
    const collected = enumValuesOf(variant);
    if (!collected) {
      return {
        kind: "unsupported",
        reason: "oneOf/anyOf variant is not a const/enum scalar",
      };
    }
    const variantDescription =
      typeof variant["description"] === "string" ? (variant["description"] as string) : undefined;
    for (const entry of collected) {
      if (!values.some((v) => v.value === entry.value)) {
        values.push({
          value: entry.value,
          description: variantDescription ?? entry.description,
        });
      }
    }
  }
  return { kind: "enum", values, nullable };
}

function enumValuesOf(
  node: JsonSchemaNode,
): { value: string; description: string }[] | undefined {
  const labels = node["x-jev-criteria"];
  const labelFor = (value: string): string =>
    isNode(labels) && typeof labels[value] === "string" ? (labels[value] as string) : value;

  if ("const" in node) {
    const c = node["const"];
    if (c === null || c === undefined) return undefined;
    const key = valueKey(c);
    return [{ value: key, description: labelFor(key) }];
  }
  const enumList = node["enum"];
  if (!Array.isArray(enumList) || enumList.length === 0) return undefined;
  const out: { value: string; description: string }[] = [];
  for (const item of enumList) {
    if (item === null || item === undefined) continue;
    const key = valueKey(item);
    if (!out.some((v) => v.value === key)) {
      out.push({ value: key, description: labelFor(key) });
    }
  }
  return out.length > 0 ? out : undefined;
}

type MappedField = {
  field: Field | undefined;
  diagnostics: IngestDiagnostic[];
};

function skipped(message: string, path: string): MappedField {
  return { field: undefined, diagnostics: [{ path, message, level: "skipped" }] };
}

function buildOptions(
  name: string,
  kind: "enum" | "boolean" | "int" | "number" | "score",
  node: JsonSchemaNode,
  optional: boolean,
): { options: FieldOptions; diagnostics: IngestDiagnostic[] } {
  const diagnostics: IngestDiagnostic[] = [];
  const question =
    typeof node["x-jev-question"] === "string"
      ? (node["x-jev-question"] as string)
      : typeof node["description"] === "string"
        ? (node["description"] as string)
        : defaultQuestion(name, kind);

  const options: FieldOptions = { question };
  if (optional) options.optional = true;
  const threshold = node["x-jev-threshold"];
  if (typeof threshold === "number") {
    options.threshold = threshold;
    diagnostics.push({
      path: `properties.${name}`,
      message: "per-field threshold taken from x-jev-threshold",
      level: "heuristic",
    });
  }
  return { options, diagnostics };
}

function mapProperty(
  name: string,
  rawNode: unknown,
  root: JsonSchemaNode,
  required: boolean,
): MappedField | undefined {
  if (!isNode(rawNode)) return undefined;
  if (rawNode["x-jev-skip"] === true) return undefined;

  const flattened = flattenAllOf(rawNode, root);
  const union = resolveUnion(flattened, root);
  const path = `properties.${name}`;

  if (union.kind === "unsupported") {
    return skipped(`skipped: ${union.reason}`, path);
  }

  const effective = union.kind === "single" ? union.node : flattened;
  const nullable =
    union.nullable ||
    effective["nullable"] === true ||
    (Array.isArray(effective["type"]) && effective["type"].includes("null"));
  const optional = !required || nullable;

  if (typeof effective["x-jev-levels"] !== "undefined") {
    const levels = effective["x-jev-levels"];
    if (!Array.isArray(levels) || levels.length < 2) {
      return skipped(
        "skipped: x-jev-levels must be an array of at least 2 level labels",
        path,
      );
    }
    const levelLabels = levels.map(valueKey);
    const { options, diagnostics } = buildOptions(name, "score", effective, optional);
    return {
      field: scoreField(levelLabels, options),
      diagnostics: [
        ...diagnostics,
        {
          path,
          message: "mapped to scoreField via x-jev-levels",
          level: "heuristic",
        },
      ],
    };
  }

  const enumValues =
    union.kind === "enum" ? union.values : enumValuesOf(effective);
  const type = Array.isArray(effective["type"])
    ? effective["type"].find((t) => t !== "null")
    : effective["type"];

  if (enumValues && enumValues.length > 0) {
    const criteria: Record<string, string> = {};
    for (const entry of enumValues) criteria[entry.value] = entry.description;
    const { options, diagnostics } = buildOptions(name, "enum", effective, optional);
    const isNumericSource =
      union.kind !== "enum" &&
      (type === "integer" || type === "number" || enumValues.some((v) => /^-?\d+(\.\d+)?$/.test(v.value)));
    return {
      field: enumField(criteria, options),
      diagnostics: [
        ...diagnostics,
        ...(isNumericSource
          ? [
              {
                path,
                message:
                  "numeric enum values emitted as string keys (JJB enum payloads are strings)",
                level: "heuristic" as const,
              },
            ]
          : []),
      ],
    };
  }

  if (type === "integer") {
    const { options, diagnostics } = buildOptions(name, "int", effective, optional);
    return { field: intField(options), diagnostics };
  }

  if (type === "number") {
    const { options, diagnostics } = buildOptions(name, "number", effective, optional);
    return { field: numberField(options), diagnostics };
  }

  if (type === "boolean") {
    const { options, diagnostics } = buildOptions(name, "boolean", effective, optional);
    return {
      field: enumField(
        {
          true: "The user affirms this",
          false: "The user negates this",
        },
        options,
      ),
      diagnostics: [
        ...diagnostics,
        {
          path,
          message:
            'boolean emitted as enumField with "true"/"false" string keys (JJB enum payloads are strings)',
          level: "heuristic",
        },
      ],
    };
  }

  if (type === "string") {
    return skipped(
      "skipped: free-text string (JJB extracts closed-set/numeric values only)",
      path,
    );
  }

  return skipped(
    `skipped: unsupported type "${type === undefined ? "unknown" : String(type)}" (flat closed-set/numeric fields only)`,
    path,
  );
}

/**
 * Convert an object-shaped JSON Schema into a runtime JJB `Schema`.
 * Non-object roots yield an empty schema plus a diagnostic.
 */
export function jsonSchemaToSchema(
  node: JsonSchemaNode,
  options: JsonSchemaToSchemaOptions = {},
): JsonSchemaToSchemaResult {
  const root = options.root ?? node;
  const resolved = flattenAllOf(node, root);
  const diagnostics: IngestDiagnostic[] = [];
  const schema: Schema = {};

  const properties = resolved["properties"];
  if (!isNode(properties)) {
    diagnostics.push({
      path: "",
      message:
        "skipped: root schema is not an object with `properties` (JJB maps flat request payloads)",
      level: "skipped",
    });
    return { schema, diagnostics };
  }

  const requiredList = Array.isArray(resolved["required"]) ? resolved["required"] : [];
  const required = new Set(requiredList.map(valueKey));

  for (const [name, propNode] of Object.entries(properties)) {
    const mapped = mapProperty(name, propNode, root, required.has(name));
    if (!mapped) continue;
    for (const diag of mapped.diagnostics) diagnostics.push(diag);
    if (mapped.field) schema[name] = mapped.field;
  }

  return { schema, diagnostics };
}