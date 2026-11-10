import { describe, expect, it } from "vitest";
import { loadSpec } from "./openapi-model.mjs";
import { validate } from "./json-schema-lite.mjs";

const spec = { components: { schemas: { Id: { type: "string", pattern: "^id_" }, Box: { type: "object", required: ["id"], properties: { id: { $ref: "#/components/schemas/Id" } } } } } };
const msgs = (schema, value) => validate(spec, schema, value).map((e) => `${e.path}: ${e.message}`);

describe("json-schema-lite", () => {
  it("checks types, including integer, null and type lists", () => {
    expect(msgs({ type: "integer" }, 3)).toEqual([]);
    expect(msgs({ type: "integer" }, 3.5)).toEqual(["(root): must be integer (got number)"]);
    expect(msgs({ type: ["string", "null"] }, null)).toEqual([]);
    expect(msgs({ type: "object" }, [])).toEqual(["(root): must be object (got array)"]);
    expect(msgs({ type: "number" }, Number.NaN)).toHaveLength(1);
  });

  it("follows $ref and names the path of a bad field", () => {
    expect(msgs({ $ref: "#/components/schemas/Box" }, { id: "id_1" })).toEqual([]);
    expect(msgs({ type: "array", items: { $ref: "#/components/schemas/Box" } }, [{ id: "id_1" }, { id: "x" }, {}])).toEqual([
      "[1].id: does not match ^id_",
      '[2]: is missing the required field "id"',
    ]);
  });

  it("handles enum, const, ranges, lengths, formats and items", () => {
    expect(msgs({ enum: ["a", "b"] }, "c")[0]).toMatch(/must be one of/);
    expect(msgs({ const: 1 }, 2)).toEqual(["(root): must be 1"]);
    expect(msgs({ type: "number", minimum: 1, maximum: 3 }, 4)).toEqual(["(root): is above 3"]);
    expect(msgs({ type: "string", minLength: 2, maxLength: 3 }, "abcd")).toEqual(["(root): is longer than 3"]);
    expect(msgs({ type: "string", format: "date-time" }, "2026-11-10T09:15:00+05:30")).toEqual([]);
    expect(msgs({ type: "string", format: "date-time" }, "yesterday")).toHaveLength(1);
    expect(msgs({ type: "array", minItems: 1, uniqueItems: true }, [1, 1])).toEqual(["(root): has repeated items"]);
  });

  it("handles oneOf, anyOf, allOf and not", () => {
    expect(msgs({ oneOf: [{ type: "string" }, { type: "integer" }] }, 1)).toEqual([]);
    expect(msgs({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1)[0]).toMatch(/matches 2 of the 2/);
    expect(msgs({ anyOf: [{ type: "string" }, { type: "integer" }] }, true)[0]).toMatch(/does not match any/);
    expect(msgs({ allOf: [{ type: "object", required: ["a"] }, { type: "object", required: ["b"] }] }, { a: 1 })).toEqual(['(root): is missing the required field "b"']);
    expect(msgs({ not: { type: "string" } }, "x")).toHaveLength(1);
  });

  it("applies additionalProperties the standard way: allOf siblings do not count (the trap the spec once had)", () => {
    const strict = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
    expect(msgs(strict, { a: "x", b: 1 })).toEqual(['(root): has the field "b", which this schema does not list']);
    expect(msgs({ allOf: [strict, { type: "object", properties: { b: { type: "integer" } } }] }, { a: "x", b: 1 })).toHaveLength(1);
    expect(msgs({ type: "object", additionalProperties: { type: "integer" } }, { x: 1, y: "no" })).toEqual(["y: must be integer (got string)"]);
  });

  it("stops at maxErrors", () => {
    expect(validate(spec, { type: "array", items: { type: "string" } }, [1, 2, 3, 4, 5], { maxErrors: 2 })).toHaveLength(2);
  });
});

describe("docs/openapi.yaml as this reader sees it", () => {
  const s = loadSpec();
  const walk = (node, visit, path = "") => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
    else if (node && typeof node === "object") {
      visit(node, path);
      for (const [k, v] of Object.entries(node)) walk(v, visit, `${path}.${k}`);
    }
  };

  it("has no string enum with a boolean in it (YAML 1.1 readers turn bare off and on into booleans: quote them)", () => {
    const bad = [];
    walk(s, (n, path) => {
      if (Array.isArray(n.enum) && n.type === "string" && n.enum.some((v) => typeof v === "boolean")) bad.push(path);
    });
    expect(bad).toEqual([]);
  });

  it("no schema is an allOf over a schema that forbids extra fields (the extra fields would never validate)", () => {
    const bad = [];
    walk(s, (n, path) => {
      for (const part of n.allOf ?? []) {
        const target = part?.$ref ? part.$ref.split("/").reduce((acc, k) => acc?.[k], { "#": s }) : part;
        if (target?.additionalProperties === false) bad.push(`${path} extends a closed schema (${part.$ref ?? "inline"})`);
      }
    });
    expect(bad).toEqual([]);
  });
});
