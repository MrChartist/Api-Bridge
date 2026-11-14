import { describe, expect, it } from "vitest";
import { loadSpec, operations, sample } from "./lib/openapi-model.mjs";
import { parseYaml } from "./lib/yaml-lite.mjs";

describe("yaml-lite", () => {
  it("reads block maps, lists and scalars", () => {
    const y = parseYaml(["a: 1", "b: text with spaces", "c: true", "d: null", "e:", "  - x", "  - y: 2", "    z: 3", "f:", "- p", "- q", "g: \"quoted: colon\"", "h: 'it''s'"].join("\n"));
    expect(y).toEqual({ a: 1, b: "text with spaces", c: true, d: null, e: ["x", { y: 2, z: 3 }], f: ["p", "q"], g: "quoted: colon", h: "it's" });
  });

  it("reads flow maps and lists, including nested ones and symbols with a colon", () => {
    const y = parseYaml('s: { type: array, items: { $ref: "#/c/X" }, enum: [NSE:RELIANCE, "a, b", 3], t: [string, "null"] }');
    expect(y.s).toEqual({ type: "array", items: { $ref: "#/c/X" }, enum: ["NSE:RELIANCE", "a, b", 3], t: ["string", "null"] });
  });

  it("reads literal and folded block scalars with their chomping", () => {
    const y = parseYaml(["lit: |", "  one", "  two", "", "  three", "fold: >-", "  a", "  b", "", "  c", "keep: |+", "  x", "", "next: 1"].join("\n"));
    expect(y.lit).toBe("one\ntwo\n\nthree\n");
    expect(y.fold).toBe("a b\nc");
    expect(y.keep).toBe("x\n\n");
    expect(y.next).toBe(1);
  });

  it("ignores comments but keeps # inside quotes and after a non-space", () => {
    const y = parseYaml(['a: 1 # note', '# whole line', 'b: "x # y"', 'c: "#/components/x"', "d: a#b"].join("\n"));
    expect(y).toEqual({ a: 1, b: "x # y", c: "#/components/x", d: "a#b" });
  });

  it("joins a plain scalar that continues on the next lines, and keeps apostrophes in plain text", () => {
    expect(parseYaml("a: one\n  two\n  three\nb: Today's P&L")).toEqual({ a: "one two three", b: "Today's P&L" });
  });

  it("reads keys that are paths or status codes", () => {
    expect(parseYaml('paths:\n  /v1/x/{id}:\n    get:\n      responses:\n        "200": { description: ok }\n        4XX: { description: bad }')).toEqual({
      paths: { "/v1/x/{id}": { get: { responses: { 200: { description: "ok" }, "4XX": { description: "bad" } } } } },
    });
  });

  it("throws on a line it cannot place instead of guessing", () => {
    expect(() => parseYaml("a:\n  b: 1\n c: 2\n")).toThrow(/yaml-lite/);
  });
});

describe("the OpenAPI model", () => {
  const spec = loadSpec();
  const ops = operations(spec);

  it("reads every operation with a unique id, a tag and a module", () => {
    expect(ops.length).toBeGreaterThan(100);
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
    expect(ops.every((o) => o.tag && o.module && o.summary)).toBe(true);
    expect(ops.filter((o) => o.loopbackOnly).length).toBeGreaterThan(20);
    expect(ops.find((o) => o.id === "placeOrder")).toMatchObject({ method: "POST", path: "/v1/orders", scope: "paper", idempotent: true });
  });

  it("the sample generator gives a valid minimal order for the demo paper account", () => {
    const order = ops.find((o) => o.id === "placeOrder");
    expect(sample(spec, order.requestBody.schema)).toMatchObject({ account: "demo-paper", side: "BUY", quantity: 1 });
  });
});
