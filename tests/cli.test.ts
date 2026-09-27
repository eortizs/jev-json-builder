import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseArgs, runCli } from "../src/cli.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ordersSpecPath = join(rootDir, "examples", "orders.openapi.json");
const ticketPrismaPath = join(rootDir, "examples", "ticket.prisma");

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "jjb-ingest-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runInProc(argv: string[]): { code: number; stdout: string; stderr: string } {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = runCli(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("parseArgs", () => {
  it("parses options and positionals", () => {
    const args = parseArgs([
      "spec.json",
      "-n",
      "CreateOrder",
      "--name",
      "Ticket",
      "-o",
      "out.ts",
      "-f",
      "openapi",
      "--runtime",
      "--no-header",
      "--no-bodies",
    ]);
    expect(args.file).toBe("spec.json");
    expect(args.names).toEqual(["CreateOrder", "Ticket"]);
    expect(args.out).toBe("out.ts");
    expect(args.format).toBe("openapi");
    expect(args.runtime).toBe(true);
    expect(args.header).toBe(false);
    expect(args.bodies).toBe(false);
    expect(args.errors).toEqual([]);
  });

  it("records unknown options and missing values", () => {
    const args = parseArgs(["--wat", "-n"]);
    expect(args.errors).toHaveLength(2);
    expect(args.errors[0]).toContain("unknown option");
  });
});

describe("jjb-ingest CLI", () => {
  it("prints help", () => {
    const { code, stdout } = runInProc(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("jjb-ingest");
    expect(stdout).toContain("--name");
  });

  it("emits defineSchema TypeScript to stdout", () => {
    const { code, stdout } = runInProc([ordersSpecPath, "-n", "CreateOrder"]);
    expect(code).toBe(0);
    expect(stdout).toContain("export const createOrderSchema = defineSchema({");
    expect(stdout).toContain("product: enumField(");
    expect(stdout).toContain('import { defineSchema, enumField, intField, stringField } from "jev-json-builder";');
  });

  it("writes a file and reports diagnostics on stderr", () => {
    const outPath = join(workDir, "orderSchema.ts");
    const { code, stderr } = runInProc([ordersSpecPath, "-n", "CreateOrder", "-o", outPath]);
    expect(code).toBe(0);
    expect(stderr).toContain(`wrote ${outPath}`);
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("export const createOrderSchema = defineSchema({");
  });

  it("emits runtime JSON with --runtime", () => {
    const { code, stdout } = runInProc([ticketPrismaPath, "--runtime"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { name: string; schema: Record<string, unknown> }[];
    expect(parsed.map((s) => s.name)).toEqual(["Ticket"]);
    expect(parsed[0]?.schema).toHaveProperty("category");
  });

  it("fails with a helpful message when the schema name is unknown", () => {
    const { code, stderr } = runInProc([ordersSpecPath, "-n", "Missing"]);
    expect(code).toBe(1);
    expect(stderr).toContain('no schema named "Missing"');
    expect(stderr).toContain("available:");
  });

  it("fails on missing input file", () => {
    const { code, stderr } = runInProc([join(workDir, "nope.json")]);
    expect(code).toBe(1);
    expect(stderr).toContain("cannot read");
  });

  it("ingests a bare JSON Schema object", () => {
    const schemaPath = join(workDir, "inline.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        required: ["effect"],
        properties: { effect: { type: "string", enum: ["fadein", "bounce"] } },
      }),
      "utf8",
    );
    const { code, stdout } = runInProc([schemaPath]);
    expect(code).toBe(0);
    expect(stdout).toContain("export const schemaSchema = defineSchema({");
  });

  it("runs as a node script end-to-end", () => {
    const outPath = join(workDir, "cli-out.ts");
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx/esm", join(rootDir, "src", "cli.ts"), ordersSpecPath, "-o", outPath],
      { encoding: "utf8", cwd: rootDir, stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(stdout).toBe("");
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("defineSchema({");
  });
});