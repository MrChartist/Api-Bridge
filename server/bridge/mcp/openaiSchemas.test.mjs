import { describe, expect, it } from "vitest";
import { createNullLogger } from "../core/logger.mjs";
import { createCallContext } from "../core/context.mjs";
import { toOpenAITools, toStrictSchema } from "./openaiSchemas.mjs";
import { createToolRegistry } from "./tools.mjs";

const ORDERS_ON = { mcp: { toolsets: ["market", "analytics", "account", "orders"], orderAccounts: ["paper"] } };

/** Walk a schema and assert OpenAI strict-mode rules. */
function assertStrict(s, path) {
  if (s.anyOf) s.anyOf.forEach((x, i) => assertStrict(x, `${path}.anyOf[${i}]`));
  if (s.items) assertStrict(s.items, `${path}.items`);
  if (s.type === "object") {
    expect(s.additionalProperties, path).toBe(false);
    expect([...(s.required ?? [])].sort(), path).toEqual(Object.keys(s.properties ?? {}).sort());
    for (const [k, v] of Object.entries(s.properties ?? {})) assertStrict(v, `${path}.${k}`);
  }
  for (const k of Object.keys(s)) expect(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "description", "pattern", "format", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"], `${path}.${k}`).toContain(k);
}

describe("OpenAI function export", () => {
  it("exports the same tools, in the same order, as the MCP registry", () => {
    const fns = toOpenAITools({ config: {} });
    const registry = createToolRegistry({ deps: { config: {} } });
    const ctx = createCallContext({ source: "mcp", scopes: ["read"], log: createNullLogger() });
    expect(fns.map((f) => f.name)).toEqual(registry.listTools(ctx).map((t) => t.name));
  });

  it("every function is strict: all properties required, no extra keys, supported keywords only", () => {
    for (const f of toOpenAITools({ config: ORDERS_ON, scopes: ["live"] })) {
      expect(f).toMatchObject({ type: "function", strict: true });
      expect(f.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(f.description.length).toBeLessThanOrEqual(1024);
      assertStrict(f.parameters, f.name);
    }
  });

  it("a read-only key gets no order functions; a paper key gets them only when config allows", () => {
    expect(toOpenAITools({ config: ORDERS_ON }).map((f) => f.name)).not.toContain("prepare_order");
    expect(toOpenAITools({ config: {}, scopes: ["paper"] }).map((f) => f.name)).not.toContain("prepare_order");
    expect(toOpenAITools({ config: ORDERS_ON, scopes: ["paper"] }).map((f) => f.name)).toContain("prepare_order");
    expect(toOpenAITools({ config: ORDERS_ON, scopes: ["paper"], accounts: ["dhan-main"] }).map((f) => f.name)).not.toContain("prepare_order");
  });

  it("supports the Chat Completions shape too", () => {
    const [f] = toOpenAITools({ config: {}, format: "chat" });
    expect(f.type).toBe("function");
    expect(f.function).toMatchObject({ name: "get_ltp", strict: true });
  });

  it("toStrictSchema forces strictness and refuses untyped schemas", () => {
    expect(toStrictSchema({ type: "object", properties: { a: { type: "string", $comment: "x" } } })).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false });
    expect(() => toStrictSchema({ description: "anything" })).toThrow();
  });
});
