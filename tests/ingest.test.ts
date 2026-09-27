import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  detectFormat,
  exportNameFor,
  getPayload,
  ingest,
  ingestOpenApi,
  ingestOpenApiSchema,
  ingestPrisma,
  ingestPrismaModel,
  jevBody,
  jsonSchemaToSchema,
  parsePrisma,
  renderSchemaSource,
  renderSchemaSources,
  resolveJsonPointer,
} from "../src/index.js";
import { ans, createMockClient } from "../src/testing/mockClient.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
const ordersSpec = readFileSync(join(examplesDir, "orders.openapi.json"), "utf8");
const ticketPrisma = readFileSync(join(examplesDir, "ticket.prisma"), "utf8");

describe("jsonSchemaToSchema", () => {
  it("maps enums, integers, and optional fields", () => {
    const { schema, diagnostics } = jsonSchemaToSchema({
      type: "object",
      required: ["effect", "sizePx"],
      properties: {
        effect: {
          type: "string",
          description: "Which animation effect?",
          enum: ["fadein", "fadeout", "bounce"],
        },
        sizePx: { type: "integer", description: "Size in pixels" },
        color: { type: "string", enum: ["red", "green", "blue"] },
      },
    });

    expect(Object.keys(schema)).toEqual(["effect", "sizePx", "color"]);
    expect(schema.effect?.kind).toBe("enum");
    expect(schema.effect?.options.optional).toBeUndefined();
    expect(schema.sizePx?.kind).toBe("int");
    expect(schema.color?.options.optional).toBe(true);
    expect(schema.effect?.options.question).toBe("Which animation effect?");
    expect(diagnostics).toHaveLength(0);
  });

  it("maps free-text strings to stringField and skips nested structures", () => {
    const { schema, diagnostics } = jsonSchemaToSchema({
      type: "object",
      required: [],
      properties: {
        note: { type: "string", description: "Free text" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", properties: { a: { type: "string" } } },
        ok: { type: "boolean" },
      },
    });

    expect(Object.keys(schema)).toEqual(["note", "ok"]);
    expect(schema.note?.kind).toBe("string");
    expect(schema.note?.options.question).toBe("Free text");
    expect(schema.ok?.kind).toBe("enum");
    const skipped = diagnostics.filter((d) => d.level === "skipped");
    expect(skipped.map((d) => d.path)).toEqual([
      "properties.tags",
      "properties.meta",
    ]);
    expect(diagnostics.some((d) => d.level === "heuristic")).toBe(true);
  });

  it("maps date formats to dateField ahead of the string mapping", () => {
    const { schema, diagnostics } = jsonSchemaToSchema({
      type: "object",
      properties: {
        when: { type: "string", format: "date-time", description: "When?" },
        day: { type: "string", format: "date" },
        clock: { type: "string", format: "time" },
      },
    });
    expect(schema.when?.kind).toBe("date");
    expect(schema.day?.kind).toBe("date");
    expect(schema.clock?.kind).toBe("date");
    expect(diagnostics.filter((d) => d.level === "heuristic").length).toBe(3);
    expect(diagnostics.some((d) => d.message.includes('format "date-time"'))).toBe(true);
  });

  it("honors x-jev vendor extensions", () => {
    const { schema } = jsonSchemaToSchema({
      type: "object",
      required: ["severity"],
      properties: {
        severity: {
          type: "string",
          "x-jev-question": "How severe is the issue?",
          "x-jev-levels": ["cosmetic", "degraded", "blocking"],
        },
        amount: {
          type: "number",
          "x-jev-threshold": 0.9,
          "x-jev-question": "Refund amount?",
        },
        secret: { type: "string", "x-jev-skip": true },
      },
    });

    expect(schema.severity?.kind).toBe("score");
    expect(schema.severity?.options.question).toBe("How severe is the issue?");
    expect(schema.amount?.options.threshold).toBe(0.9);
    expect(schema.secret).toBeUndefined();
  });

  it("resolves $ref and allOf compositions", () => {
    const root = {
      components: {
        schemas: {
          Effect: { type: "string", enum: ["fadein", "bounce"] },
          Base: {
            type: "object",
            required: ["effect"],
            properties: { effect: { $ref: "#/components/schemas/Effect" } },
          },
          Extended: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              {
                type: "object",
                required: ["sizePx"],
                properties: { sizePx: { type: "integer" } },
              },
            ],
          },
        },
      },
    };
    const target = resolveJsonPointer(root, "#/components/schemas/Extended");
    expect(target).toBeDefined();

    const { schema } = jsonSchemaToSchema(target!, { root });
    expect(Object.keys(schema).sort()).toEqual(["effect", "sizePx"]);
    expect(schema.effect?.kind).toBe("enum");
    expect(schema.sizePx?.kind).toBe("int");
  });

  it("treats nullable and oneOf-null idioms as optional", () => {
    const { schema } = jsonSchemaToSchema({
      type: "object",
      required: ["quantity", "amount"],
      properties: {
        quantity: { type: "integer", nullable: true },
        amount: {
          oneOf: [{ type: "number" }, { type: "null" }],
        },
      },
    });

    expect(schema.quantity?.options.optional).toBe(true);
    expect(schema.amount?.options.optional).toBe(true);
    expect(schema.amount?.kind).toBe("number");
  });

  it("merges oneOf const variants into a closed set", () => {
    const { schema } = jsonSchemaToSchema({
      type: "object",
      required: ["status"],
      properties: {
        status: {
          oneOf: [
            { const: "open", description: "Still open" },
            { const: "closed", description: "Resolved" },
          ],
        },
      },
    });

    expect(schema.status?.kind).toBe("enum");
    if (schema.status?.kind === "enum") {
      expect(Object.keys(schema.status.criteria)).toEqual(["open", "closed"]);
      expect(schema.status.criteria.closed).toBe("Resolved");
    }
  });

  it("returns empty schema with a diagnostic for non-object roots", () => {
    const { schema, diagnostics } = jsonSchemaToSchema({ type: "string", enum: ["a", "b"] });
    expect(Object.keys(schema)).toHaveLength(0);
    expect(diagnostics[0]?.level).toBe("skipped");
  });
});

describe("ingestOpenApi", () => {
  it("ingests object definitions and skips scalar enums", () => {
    const output = ingestOpenApi(JSON.parse(ordersSpec));

    const names = output.sources.map((s) => s.name);
    expect(names).toContain("CreateOrder");
    expect(names).toContain("createOrder");
    expect(names).not.toContain("GiftWrapChoice");

    const createOrder = output.sources.find((s) => s.name === "CreateOrder")!;
    expect(Object.keys(createOrder.schema)).toEqual([
      "product",
      "shipping",
      "quantity",
      "giftWrap",
      "note",
    ]);
    expect(createOrder.schema.giftWrap?.options.optional).toBe(true);
    expect(createOrder.schema.quantity?.options.optional).toBeUndefined();
    expect(createOrder.schema.note?.kind).toBe("string");
    if (createOrder.schema.product?.kind === "enum") {
      expect(createOrder.schema.product.criteria.laptop).toBe("A laptop computer (portátil)");
    }

    expect(
      output.diagnostics.some((d) => d.path.includes("GiftWrapChoice")),
    ).toBe(true);
  });

  it("filters by name and reports missing definitions", () => {
    const output = ingestOpenApi(JSON.parse(ordersSpec), { names: ["CreateOrder"] });
    expect(output.sources.map((s) => s.name)).toEqual(["CreateOrder"]);

    expect(() => ingestOpenApiSchema(JSON.parse(ordersSpec), "Nope")).toThrow(
      /no object schema named "Nope"/,
    );
  });

  it("parses Swagger 2.0 definitions and body parameters", () => {
    const swagger = {
      swagger: "2.0",
      info: { title: "Legacy", version: "1.0.0" },
      paths: {
        "/pets": {
          post: {
            operationId: "addPet",
            parameters: [
              {
                name: "body",
                in: "body",
                schema: { $ref: "#/definitions/NewPet" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      definitions: {
        NewPet: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            tag: { type: "string", enum: ["cat", "dog"] },
          },
        },
      },
    };

    const output = ingestOpenApi(swagger);
    const names = output.sources.map((s) => s.name);
    expect(names).toContain("NewPet");
    expect(names).toContain("addPet");

    const newPet = output.sources.find((s) => s.name === "NewPet")!;
    expect(Object.keys(newPet.schema)).toEqual(["name", "tag"]);
    expect(newPet.schema.name?.kind).toBe("string");
  });
});

describe("ingestPrisma", () => {
  it("parses models, enums, docs, and optionality", () => {
    const { models, enums } = parsePrisma(ticketPrisma);
    expect(models.map((m) => m.name)).toEqual(["Ticket"]);
    expect(enums.map((e) => e.name)).toEqual(["TicketCategory"]);
    expect(enums[0]?.values).toEqual(["bug", "billing", "account", "feature"]);
    expect(enums[0]?.docs.get("billing")).toBe(
      "Charges, invoices, refunds, subscriptions",
    );
  });

  it("maps scalars and skips generated keys", () => {
    const output = ingestPrisma(ticketPrisma);
    const ticket = output.sources.find((s) => s.name === "Ticket")!;

    expect(Object.keys(ticket.schema).sort()).toEqual([
      "amount",
      "category",
      "createdAt",
      "refund",
      "title",
    ]);
    expect(ticket.schema.category?.kind).toBe("enum");
    expect(ticket.schema.amount?.kind).toBe("int");
    expect(ticket.schema.amount?.options.optional).toBe(true);
    expect(ticket.schema.refund?.kind).toBe("enum");
    expect(ticket.schema.title?.kind).toBe("string");
    expect(ticket.schema.title?.options.optional).toBeUndefined();
    expect(ticket.schema.createdAt?.kind).toBe("date");
    expect(ticket.schema.createdAt?.options.optional).toBe(true);

    const skipped = ticket.diagnostics.filter((d) => d.level === "skipped");
    const skippedPaths = skipped.map((d) => d.path);
    expect(skippedPaths).toContain("models.Ticket.id");
    expect(skippedPaths).not.toContain("models.Ticket.title");
    expect(skippedPaths).not.toContain("models.Ticket.createdAt");
  });

  it("uses doc comments as question text", () => {
    const ticket = ingestPrismaModel(ticketPrisma, "Ticket");
    expect(ticket.schema.category?.options.question).toBe(
      "Which broad category should handle this ticket?",
    );
    expect(ticket.schema.amount?.options.question).toBe(
      "Refund or charge amount in dollars (if any)",
    );
  });
});

describe("renderSchemaSource", () => {
  it("emits a compilable defineSchema block", () => {
    const source = ingestOpenApiSchema(JSON.parse(ordersSpec), "CreateOrder");
    const code = renderSchemaSource(source);

    expect(code).toContain(
      'import { defineSchema, enumField, intField, stringField } from "jev-json-builder";',
    );
    expect(code).toContain("export const createOrderSchema = defineSchema({");
    expect(code).toContain("product: enumField(");
    expect(code).toContain('"laptop": "A laptop computer (portátil)"');
    expect(code).toContain("quantity: intField({ question:");
    expect(code).toContain("note: stringField({");
    expect(code).toContain("optional: true");
    expect(code).toContain("Source: components.schemas.CreateOrder");
  });

  it("renders multiple sources with one deduplicated import", () => {
    const output = ingest(ticketPrisma);
    const code = renderSchemaSources(output.sources, { header: false });
    expect(code).toContain(
      'import { defineSchema, enumField, intField, stringField, dateField } from "jev-json-builder";',
    );
    expect(code).toContain("export const ticketSchema = defineSchema({");
  });

  it("exportNameFor follows the <name>Schema convention", () => {
    expect(exportNameFor("CreateOrder")).toBe("createOrderSchema");
    expect(exportNameFor("orderSchema")).toBe("orderSchema");
    expect(exportNameFor("createOrder")).toBe("createOrderSchema");
  });
});

describe("detectFormat + ingest facade", () => {
  it("auto-detects openapi, json-schema, and prisma", () => {
    expect(detectFormat(ordersSpec)).toBe("openapi");
    expect(detectFormat(ticketPrisma)).toBe("prisma");
    expect(detectFormat('{"type":"object","properties":{}}')).toBe("json-schema");
    expect(detectFormat("model X { id Int }", "schema.prisma")).toBe("prisma");
  });

  it("ingests each format through the facade", () => {
    const openapiOut = ingest(ordersSpec);
    expect(openapiOut.sources.length).toBeGreaterThan(0);

    const prismaOut = ingest(ticketPrisma);
    expect(prismaOut.sources.map((s) => s.name)).toEqual(["Ticket"]);

    const jsonOut = ingest(
      JSON.stringify({
        type: "object",
        required: ["effect"],
        properties: { effect: { type: "string", enum: ["fadein", "bounce"] } },
      }),
    );
    expect(jsonOut.sources[0]?.schema.effect?.kind).toBe("enum");
  });

  it("rejects malformed JSON for openapi format", () => {
    expect(() => ingest("not json at all", { format: "openapi" })).toThrow(/not valid JSON/);
  });
});

describe("end-to-end: ingest -> jevBody roundtrip", () => {
  it("serves natural language through an ingested OpenAPI schema", async () => {
    const source = ingestOpenApiSchema(JSON.parse(ordersSpec), "CreateOrder");
    const schema = source.schema;

    const app = express();
    app.use(express.json());
    app.post(
      "/orders",
      jevBody(schema, {
        client: createMockClient({
          product: ans.choice("laptop"),
          shipping: ans.choice("express"),
          quantity: ans.choice("n0"),
          giftWrap: ans.choice("yes"),
          giftWrap_stated: ans.noul(0.9),
          _hazard: ans.noul(0.02),
        }),
      }),
      (req, res) => {
        res.json(getPayload(req, schema));
      },
    );

    const res = await request(app)
      .post("/orders")
      .send({ prompt: "order 2 laptops with express shipping and gift wrap" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      product: "laptop",
      shipping: "express",
      quantity: 2,
      giftWrap: "yes",
    });
  });

  it("serves natural language through an ingested Prisma model", async () => {
    const source = ingestPrismaModel(ticketPrisma, "Ticket");
    const schema = source.schema;

    const app = express();
    app.use(express.json());
    app.post(
      "/tickets",
      jevBody(schema, {
        client: createMockClient({
          category: ans.choice("billing"),
          amount: ans.choice("n0"),
          amount_stated: ans.noul(0.95),
          refund: ans.choice("true"),
          refund_stated: ans.noul(0.9),
          title: ans.choice("n0"),
          title_candidates: ans.choice("n0"),
          createdAt_stated: ans.noul(0.1),
          _hazard: ans.noul(0.01),
        }),
      }),
      (req, res) => {
        res.json(getPayload(req, schema));
      },
    );

    const res = await request(app)
      .post("/tickets")
      .send({ prompt: "billing complaint, they want a refund of 50 dollars" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      category: "billing",
      amount: 50,
      refund: "true",
      title: "billing complaint",
    });
  });
});