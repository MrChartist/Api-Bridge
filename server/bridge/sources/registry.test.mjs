import { describe, expect, it } from "vitest";
import { createSourceRegistry } from "./registry.mjs";

const descriptor = (over = {}) => ({
  id: "alpha",
  name: "Alpha",
  kind: "free",
  tier: "byok",
  class: "eod",
  delaySec: null,
  official: true,
  capabilities: ["history"],
  limits: { perMinute: 5 },
  terms: { url: "https://example.com/terms", note: "You hold the vendor account." },
  ...over,
});
const provider = (over = {}) => ({ descriptor: descriptor(over), history: async () => ({ candles: [], at: 0 }) });

describe("source registry", () => {
  it("registers, gets, checks and lists in registration order", () => {
    const reg = createSourceRegistry();
    reg.register(provider({ id: "bravo" }));
    reg.register(provider({ id: "alpha" }));
    expect(reg.list().map((p) => p.descriptor.id)).toEqual(["bravo", "alpha"]);
    expect(reg.has("alpha")).toBe(true);
    expect(reg.has("nope")).toBe(false);
    expect(reg.get("alpha").descriptor.name).toBe("Alpha");
    expect(reg.get("nope")).toBeNull();
  });

  it("rejects a duplicate id", () => {
    const reg = createSourceRegistry();
    reg.register(provider());
    expect(() => reg.register(provider())).toThrow(/already registered/);
    expect(reg.list()).toHaveLength(1);
  });

  it("lists every problem of a bad descriptor", () => {
    const reg = createSourceRegistry();
    let message = "";
    try {
      reg.register({ descriptor: { id: "Bad Id", name: "", kind: "x", tier: "y", class: "z", official: "yes", capabilities: [], limits: {} } });
    } catch (err) {
      message = err.message;
    }
    for (const part of ["id must match", "name is required", "kind must be", "tier must be", "class must be", "official must be", "capabilities must be", "limits must state", "terms.url"]) {
      expect(message, part).toContain(part);
    }
    expect(reg.list()).toEqual([]);
  });

  it("rejects non-objects and a missing capability method", () => {
    const reg = createSourceRegistry();
    expect(() => reg.register(null)).toThrow(/must be an object/);
    expect(() => reg.register({ descriptor: descriptor({ capabilities: ["quotes"] }) })).toThrow(/no quotes\(\) method/);
    expect(() => reg.register({})).toThrow(/descriptor must be an object/);
  });

  it("lets a broker descriptor stand without read methods", () => {
    const reg = createSourceRegistry();
    reg.register({ descriptor: { id: "demo", name: "Demo", kind: "broker", tier: "builtin", class: "realtime", delaySec: null, official: true, capabilities: ["quotes"], limits: { perSecond: 1 } } });
    expect(reg.has("demo")).toBe(true);
  });

  it("unregisters", () => {
    const reg = createSourceRegistry();
    reg.register(provider());
    expect(reg.unregister("alpha")).toBe(true);
    expect(reg.unregister("alpha")).toBe(false);
    expect(reg.has("alpha")).toBe(false);
  });
});
