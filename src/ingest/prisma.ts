/**
 * Prisma schema -> JJB schema sources.
 *
 * Parses `model` and `enum` blocks from a `.prisma` file with a small
 * line-oriented parser (no dependency on @prisma/internals). Scalar mapping:
 *
 *   field typed with a parsed `enum`  -> enumField (values = enum members)
 *   Boolean                           -> enumField("true"/"false"; heuristic)
 *   Int / BigInt                      -> intField
 *   Float / Decimal                   -> numberField
 *   String / DateTime / Json / ...    -> SKIPPED (free text is not JJB's job)
 *   lists, relations, composites      -> SKIPPED
 *
 * Optionality: `Type?` or `@default(...)` -> `optional: true`. Primary keys
 * with generated defaults (`@id` + `@default(autoincrement|uuid|cuid)`) are
 * skipped as server-generated. Doc comments (`///`) become question text.
 */

import {
  enumField,
  intField,
  numberField,
  type Field,
  type FieldOptions,
  type Schema,
} from "../core/schema.js";

import type { IngestDiagnostic, IngestOutput, SchemaSource } from "./types.js";
import { defaultQuestion } from "./util.js";

export type PrismaIngestOptions = {
  /** Only ingest these model names (case-sensitive). */
  names?: string[];
};

type PrismaEnum = { name: string; values: string[]; docs: Map<string, string> };
type PrismaField = {
  name: string;
  type: string;
  isList: boolean;
  isOptional: boolean;
  attributes: string;
  doc: string | undefined;
};
type PrismaModel = { name: string; fields: PrismaField[]; doc: string };

const BLOCK_START = /^(model|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/;
const FIELD_LINE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s+((?:[A-Za-z_][A-Za-z0-9_]*)(?:\s*\[\s*\])?)(\??)(.*)$/;

function stripLineComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inString = !inString;
    if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

export function parsePrisma(source: string): {
  models: PrismaModel[];
  enums: PrismaEnum[];
} {
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];

  let current:
    | { kind: "model"; name: string; fields: PrismaField[]; doc: string }
    | { kind: "enum"; name: string; values: string[]; docs: Map<string, string> }
    | undefined;

  let pendingDoc = "";

  for (const rawLine of source.split(/\r?\n/)) {
    const docMatch = /^\s*\/\/\/\s?(.*)$/.exec(rawLine);
    if (docMatch) {
      pendingDoc = pendingDoc ? `${pendingDoc} ${docMatch[1]!.trim()}` : docMatch[1]!.trim();
      continue;
    }

    const line = stripLineComment(rawLine).trim();
    if (line === "") {
      pendingDoc = "";
      continue;
    }

    const start = BLOCK_START.exec(line);
    if (start) {
      const [, kind, name] = start;
      pendingDoc = pendingDoc.trim();
      if (kind === "model") {
        current = { kind: "model", name: name!, fields: [], doc: pendingDoc };
      } else {
        current = { kind: "enum", name: name!, values: [], docs: new Map() };
      }
      pendingDoc = "";
      continue;
    }

    if (line === "}") {
      if (current) {
        if (current.kind === "model") models.push(current);
        else enums.push(current);
      }
      current = undefined;
      pendingDoc = "";
      continue;
    }

    if (!current) {
      pendingDoc = "";
      continue;
    }

    if (current.kind === "enum") {
      const value = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(line);
      if (value) {
        current.values.push(value[0]);
        if (pendingDoc) current.docs.set(value[0], pendingDoc);
      }
      pendingDoc = "";
      continue;
    }

    const fieldMatch = FIELD_LINE.exec(line);
    if (!fieldMatch) {
      // Unknown construct (@@ block attrs, composite type refs): ignore.
      pendingDoc = "";
      continue;
    }

    const [, name, rawType, questionMark, rest] = fieldMatch;
    const isList = rawType!.includes("[");
    const type = rawType!.replace(/\s*\[\s*\]/g, "").trim();
    current.fields.push({
      name: name!,
      type,
      isList,
      isOptional: questionMark === "?" || /\@default\s*\(/.test(rest!),
      attributes: rest ?? "",
      doc: pendingDoc || undefined,
    });
    pendingDoc = "";
  }

  return { models, enums };
}

function buildOptions(
  field: PrismaField,
  kind: "enum" | "boolean" | "int" | "number",
  optional: boolean,
): FieldOptions {
  const question =
    field.doc && field.doc.length > 0
      ? field.doc
      : defaultQuestion(field.name, kind);
  const options: FieldOptions = { question };
  if (optional) options.optional = true;
  return options;
}

function mapField(
  field: PrismaField,
  enums: Map<string, PrismaEnum>,
  model: PrismaModel,
): { field: Field | undefined; diagnostics: IngestDiagnostic[] } {
  const path = `models.${model.name}.${field.name}`;
  const skip = (message: string) => ({
    field: undefined,
    diagnostics: [{ path, message, level: "skipped" as const }],
  });

  if (field.isList) return skip("skipped: list fields are not flat payload slots");

  const enumDef = enums.get(field.type);
  if (enumDef) {
    const criteria: Record<string, string> = {};
    for (const value of enumDef.values) {
      criteria[value] = enumDef.docs.get(value) ?? value;
    }
    return {
      field: enumField(criteria, buildOptions(field, "enum", field.isOptional)),
      diagnostics: [],
    };
  }

  if (field.type === "Boolean") {
    return {
      field: enumField(
        { true: "The user affirms this", false: "The user negates this" },
        buildOptions(field, "boolean", field.isOptional),
      ),
      diagnostics: [
        {
          path,
          message:
            'boolean emitted as enumField with "true"/"false" string keys (JJB enum payloads are strings)',
          level: "heuristic",
        },
      ],
    };
  }

  if (field.type === "Int" || field.type === "BigInt") {
    return {
      field: intField(buildOptions(field, "int", field.isOptional)),
      diagnostics: [],
    };
  }

  if (field.type === "Float" || field.type === "Decimal") {
    return {
      field: numberField(buildOptions(field, "number", field.isOptional)),
      diagnostics: [],
    };
  }

  return skip(
    `skipped: scalar "${field.type}" has no closed set (free text is not JJB's job)`,
  );
}

export function ingestPrisma(
  source: string,
  options: PrismaIngestOptions = {},
): IngestOutput {
  const { models, enums } = parsePrisma(source);
  const enumMap = new Map(enums.map((e) => [e.name, e]));
  const diagnostics: IngestDiagnostic[] = [];
  const sources: SchemaSource[] = [];
  const want = options.names;

  for (const model of models) {
    if (want && !want.includes(model.name)) continue;

    const schema: Schema = {};
    const modelDiagnostics: IngestDiagnostic[] = [];

    for (const field of model.fields) {
      const path = `models.${model.name}.${field.name}`;

      const isGeneratedKey =
        /\@id\b/.test(field.attributes) &&
        /\@default\s*\(\s*(autoincrement|uuid|cuid)\s*\(/.test(field.attributes);
      if (isGeneratedKey) {
        modelDiagnostics.push({
          path,
          message: "skipped: primary key with generated default (server-assigned)",
          level: "skipped",
        });
        continue;
      }

      const mapped = mapField(field, enumMap, model);
      for (const diag of mapped.diagnostics) modelDiagnostics.push(diag);
      if (mapped.field) schema[field.name] = mapped.field;
    }

    sources.push({
      name: model.name,
      origin: `models.${model.name}`,
      schema,
      diagnostics: modelDiagnostics,
    });
  }

  diagnostics.push({
    path: "",
    message: `ingested ${String(sources.length)} model(s), ${String(enums.length)} enum(s) from Prisma schema`,
    level: "heuristic",
  });

  return { sources, diagnostics };
}

/** Convenience: ingest a single named model (throws when absent). */
export function ingestPrismaModel(
  source: string,
  name: string,
  options: Omit<PrismaIngestOptions, "names"> = {},
): SchemaSource {
  const out = ingestPrisma(source, { ...options, names: [name] });
  const found = out.sources.find((s) => s.name === name);
  if (!found) {
    throw new Error(`ingestPrismaModel: no model named "${name}" found.`);
  }
  return found;
}