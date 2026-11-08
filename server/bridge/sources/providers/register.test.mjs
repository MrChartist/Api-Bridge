import { describe, expect, it } from "vitest";
import { createSourceRegistry } from "../registry.mjs";
import { registerBuiltinSources } from "../builtin.mjs";

describe("registering the built-in providers", () => {
  it("registers Yahoo, Alpha Vantage and Twelve Data outside demo mode", async () => {
    const registry = createSourceRegistry({});
    await registerBuiltinSources(registry, { config: { demo: false }, secrets: { get: async () => null } });
    expect(registry.list().map((p) => p.descriptor.id).sort()).toEqual(["alphavantage", "twelvedata", "yahoo"]);
  });
  it("registers no network source in demo mode", async () => {
    const registry = createSourceRegistry({});
    await registerBuiltinSources(registry, { config: { demo: true } });
    expect(registry.list().some((p) => ["yahoo", "alphavantage", "twelvedata"].includes(p.descriptor.id))).toBe(false);
  });
  it("starts every free source switched off until the user enables it", async () => {
    const registry = createSourceRegistry({});
    await registerBuiltinSources(registry, { config: { demo: false }, secrets: { get: async () => null } });
    for (const p of registry.list()) expect(["opt-in", "byok"]).toContain(p.descriptor.tier);
  });
});
