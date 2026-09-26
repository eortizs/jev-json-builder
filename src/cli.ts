#!/usr/bin/env node
/**
 * `jjb-ingest` CLI: spec file -> JJB `defineSchema` TypeScript.
 *
 *   jjb-ingest openapi.json                     # all object schemas to stdout
 *   jjb-ingest openapi.json -n CreateOrder      # one schema only
 *   jjb-ingest schema.prisma -o orderSchema.ts  # write a file
 *   jjb-ingest openapi.json --runtime           # emit runtime JSON instead
 *
 * Exit codes: 0 ok, 1 usage/parse error.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  detectFormat,
  ingest,
  renderSchemaSources,
  type IngestFormat,
  type IngestOutput,
} from "./ingest/index.js";

const USAGE = `jjb-ingest — generate JJB defineSchema blocks from API specs

Usage:
  jjb-ingest <file> [options]

Options:
  -n, --name <name>    Ingest only this schema/model/operation (repeatable)
  -o, --out <file>     Write output to a file instead of stdout
  -f, --format <fmt>   Force input format: openapi | json-schema | prisma
      --runtime        Emit runtime schema JSON (for jevBody/jevRouter) instead of TS
      --no-header      Omit the generated-file comment header
      --no-bodies      Skip OpenAPI request-body schemas
  -h, --help           Show this help

Supported inputs:
  OpenAPI 3.x / Swagger 2.0 JSON   (components.schemas, definitions, request bodies)
  JSON Schema object               (flat request payload)
  Prisma schema text               (models + enums)
`;

type CliArgs = {
  file: string | undefined;
  names: string[];
  out: string | undefined;
  format: IngestFormat | undefined;
  runtime: boolean;
  header: boolean;
  bodies: boolean;
  help: boolean;
  errors: string[];
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    file: undefined,
    names: [],
    out: undefined,
    format: undefined,
    runtime: false,
    header: true,
    bodies: true,
    help: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-n":
      case "--name": {
        const value = argv[++i];
        if (value === undefined) args.errors.push(`${arg} requires a value`);
        else args.names.push(value);
        break;
      }
      case "-o":
      case "--out": {
        const value = argv[++i];
        if (value === undefined) args.errors.push(`${arg} requires a value`);
        else args.out = value;
        break;
      }
      case "-f":
      case "--format": {
        const value = argv[++i];
        if (value === "openapi" || value === "json-schema" || value === "prisma") {
          args.format = value;
        } else {
          args.errors.push(`unknown format "${value ?? ""}" (use openapi | json-schema | prisma)`);
        }
        break;
      }
      case "--runtime":
        args.runtime = true;
        break;
      case "--no-header":
        args.header = false;
        break;
      case "--no-bodies":
        args.bodies = false;
        break;
      default:
        if (arg.startsWith("-")) args.errors.push(`unknown option "${arg}"`);
        else if (args.file === undefined) args.file = arg;
        else args.errors.push(`unexpected extra argument "${arg}"`);
    }
  }

  return args;
}

function summarize(output: IngestOutput): string {
  const lines: string[] = [];
  for (const source of output.sources) {
    const fields = Object.keys(source.schema);
    lines.push(`${source.name} (${source.origin}) -> ${fields.length} field(s): ${fields.join(", ")}`);
    for (const diag of source.diagnostics) {
      lines.push(`  [${diag.level}] ${diag.path ? `${diag.path}: ` : ""}${diag.message}`);
    }
  }
  for (const diag of output.diagnostics) {
    lines.push(`[global] [${diag.level}] ${diag.message}`);
  }
  return lines.join("\n");
}

export function runCli(argv: string[]): number {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const err of args.errors) process.stderr.write(`error: ${err}\n`);
    process.stderr.write(USAGE);
    return 1;
  }
  if (args.file === undefined) {
    process.stderr.write("error: missing input file\n");
    process.stderr.write(USAGE);
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(args.file, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: cannot read ${args.file} (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return 1;
  }

  let output: IngestOutput;
  try {
    const options: Parameters<typeof ingest>[1] = {};
    if (args.format) options.format = args.format;
    if (!args.bodies) options.requestBodies = false;
    output = ingest(text, options);
  } catch (err) {
    process.stderr.write(
      `error: ingest failed (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return 1;
  }

  if (args.names.length > 0) {
    const missing = args.names.filter((n) => !output.sources.some((s) => s.name === n));
    if (missing.length > 0) {
      process.stderr.write(
        `error: no schema named ${missing.map((m) => `"${m}"`).join(", ")} in ${args.file}\n`,
      );
      const available = output.sources.map((s) => s.name);
      if (available.length > 0) {
        process.stderr.write(`available: ${available.join(", ")}\n`);
      }
      return 1;
    }
    output = {
      sources: output.sources.filter((s) => args.names.includes(s.name)),
      diagnostics: output.diagnostics,
    };
  }

  const body = args.runtime
    ? JSON.stringify(
        output.sources.map((s) => ({
          name: s.name,
          origin: s.origin,
          schema: s.schema,
          diagnostics: s.diagnostics,
        })),
        null,
        2,
      ) + "\n"
    : renderSchemaSources(output.sources, {
        header: args.header,
        importFrom: "jev-json-builder",
      });

  if (args.out) {
    try {
      writeFileSync(args.out, body, "utf8");
    } catch (err) {
      process.stderr.write(
        `error: cannot write ${args.out} (${err instanceof Error ? err.message : String(err)})\n`,
      );
      return 1;
    }
    process.stderr.write(
      `wrote ${args.out} (${String(output.sources.length)} schema(s); format: ${detectFormat(text, args.file)})\n`,
    );
    process.stderr.write(summarize(output) + "\n");
    return 0;
  }

  process.stdout.write(body);
  return 0;
}

const isMainModule = (() => {
  try {
    const entry = process.argv[1] ?? "";
    const self = fileURLToPath(import.meta.url);
    return self === entry || self.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  process.exit(runCli(process.argv.slice(2)));
}