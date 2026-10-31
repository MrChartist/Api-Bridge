import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "./config.mjs";
import { SERVICE_CONTRACTS, SERVICES_NOT_IN_V2, assertService, isStub, notImplementedService } from "./contracts.mjs";
import { BUILTIN_MODULES } from "./builtinModules.mjs";
import { SERVICE_ORDER, applyModuleConfig, buildServices, defineModule, scopedDeps, validateModules } from "./modules.mjs";
import { createNullLogger } from "./logger.mjs";
import { createEventBus } from "./eventBus.mjs";
import { SCOPES } from "./context.mjs";

const coreDeps = () => ({
  config: loadConfig({ raw: {}, env: {} }).config,
  logger: createNullLogger(),
  bus: createEventBus(),
  clock: { now: () => 0 },
  paths: { root: "/", dataDir: "/tmp" },
  brokers: { list: () => [], has: () => false, get: () => null },
});

describe("service contracts", () => {
  it("every contract names an owning stream, its requires exist and methods are unique", () => {
    for (const [name, spec] of Object.entries(SERVICE_CONTRACTS)) {
      expect(spec.stream, name).toMatch(/^S(\d|1\d|2[0-7])$/);
      for (const r of spec.requires) expect(SERVICE_CONTRACTS[r], `${name} requires ${r}`).toBeDefined();
      expect(new Set(spec.methods).size).toBe(spec.methods.length);
    }
  });

  it("construction order respects requires and has no cycles", () => {
    for (const [name, spec] of Object.entries(SERVICE_CONTRACTS)) {
      for (const r of spec.requires) expect(SERVICE_ORDER.indexOf(r)).toBeLessThan(SERVICE_ORDER.indexOf(name));
    }
    expect(SERVICE_ORDER.length).toBe(Object.keys(SERVICE_CONTRACTS).length);
  });

  it("stubs satisfy their contract and throw NOT_IMPLEMENTED naming the stream", () => {
    for (const name of Object.keys(SERVICE_CONTRACTS)) {
      const stub = notImplementedService(name);
      expect(() => assertService(name, stub)).not.toThrow();
      expect(isStub(stub)).toBe(true);
      const first = SERVICE_CONTRACTS[name].methods[0];
      expect(() => stub[first]()).toThrow(expect.objectContaining({ code: "NOT_IMPLEMENTED", status: 501 }));
    }
    expect(() => notImplementedService("nope")).toThrow();
  });

  it("assertService lists missing methods", () => {
    expect(() => assertService("audit", { append() {} })).toThrow(/missing: query, verify/);
    expect(() => assertService("audit", null)).toThrow(/object/);
  });
});

describe("defineModule and validateModules", () => {
  it("accepts a well-formed module", () => {
    const m = defineModule({ name: "safety", stream: "S9", services: { audit: () => notImplementedService("audit") }, register() {} });
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("refuses services from another stream, non-contract services and core config keys", () => {
    expect(() => defineModule({ name: "xx", stream: "S1", services: { audit: () => ({}) } })).toThrow(/belongs to stream S9/);
    expect(() => defineModule({ name: "xx", stream: "S1", services: { cache: () => ({}) } })).toThrow(/not a contract service/);
    expect(() => defineModule({ name: "xx", stream: "S1", configKey: "safety", configSchema: z.object({}) })).toThrow(/belongs to core/);
    expect(() => defineModule({ name: "xx", stream: "S1", configKey: "x" })).toThrow(/configSchema/);
    expect(() => defineModule({ name: "X", stream: "S1" })).toThrow(/name/);
    expect(() => defineModule({ name: "xy", stream: "S99x" })).toThrow(/stream/);
  });

  it("refuses two providers for one service and duplicate names", () => {
    const a = defineModule({ name: "aa", stream: "S9", services: { audit: () => ({}) } });
    const b = defineModule({ name: "bb", stream: "S9", services: { audit: () => ({}) } });
    expect(() => validateModules([a, b])).toThrow(/provided by both/);
    expect(() => validateModules([a, a])).toThrow(/Duplicate module/);
  });
});

describe("module config sections", () => {
  const hooks = defineModule({ name: "hooks", stream: "S11", configKey: "hooks", configSchema: z.object({ ackTimeoutMs: z.number().default(500) }).strict() });

  it("parses module sections with defaults and rejects unknown sections", () => {
    const base = loadConfig({ raw: {}, env: {} }).config;
    expect(applyModuleConfig(base, [hooks]).hooks).toEqual({ ackTimeoutMs: 500 });
    const withUnknown = loadConfig({ raw: { hookz: {} }, env: {} }).config;
    expect(() => applyModuleConfig(withUnknown, [hooks])).toThrow(/Unknown config section "hookz"/);
    const bad = loadConfig({ raw: { hooks: { nope: 1 } }, env: {} }).config;
    expect(() => applyModuleConfig(bad, [hooks])).toThrow(/hooks/);
  });
});

describe("buildServices", () => {
  it("fills unprovided services with stubs and checks provided ones", async () => {
    const deps = await buildServices(coreDeps(), []);
    for (const name of Object.keys(SERVICE_CONTRACTS)) expect(isStub(deps[name])).toBe(true);
    const broken = defineModule({ name: "audit-mod", stream: "S9", services: { audit: () => ({ append() {} }) } });
    await expect(buildServices(coreDeps(), [broken])).rejects.toThrow(/missing/);
  });

  it("factories only see what they declared (plus core deps)", async () => {
    let seen;
    const mod = defineModule({
      name: "acc",
      stream: "S1",
      services: {
        accounts: (deps) => {
          seen = deps;
          return notImplementedService("accounts");
        },
      },
    });
    await buildServices(coreDeps(), [mod]);
    expect(() => seen.secrets).not.toThrow();
    expect(() => seen.config).not.toThrow();
    expect(() => seen.orders).toThrow(/without declaring it/);
    expect(seen.then).toBeUndefined();
  });

  it("overrides win", async () => {
    const fake = { append: async () => ({}), query: async () => ({ items: [], nextCursor: null }), verify: async () => ({ ok: true }) };
    const deps = await buildServices(coreDeps(), [], { audit: fake });
    expect(deps.audit).toBe(fake);
  });

  it("scopedDeps is read-only", () => {
    const d = scopedDeps({ config: 1 }, [], "t");
    expect(() => {
      d.config = 2;
    }).toThrow(/read-only/);
  });
});

describe("built-in modules", () => {
  it("every contract service has exactly one built-in provider in its own stream", () => {
    const { providers } = validateModules(BUILTIN_MODULES);
    for (const [name, spec] of Object.entries(SERVICE_CONTRACTS)) {
      if (SERVICES_NOT_IN_V2.includes(name)) continue;
      const mod = BUILTIN_MODULES.find((m) => m.name === providers.get(name));
      expect(mod, name).toBeDefined();
      expect(mod.stream).toBe(spec.stream);
    }
  });

  it("all eleven streams are represented", () => {
    const streams = new Set(BUILTIN_MODULES.map((m) => m.stream));
    for (let i = 1; i <= 11; i += 1) expect(streams.has(`S${i}`), `S${i}`).toBe(true);
  });

  it("route options use only known values", async () => {
    const mods = await Promise.all(["accounts", "auth", "ratelimit", "symbols", "market", "stream", "orders", "paper", "safety", "integrations", "hooks", "mcp"].map((d) => import(`../${d}/module.mjs`)));
    for (const m of mods) {
      for (const [method, path, o] of m.ROUTES) {
        expect(["GET", "POST", "PATCH", "DELETE", "PUT"]).toContain(method);
        expect(path.startsWith("/")).toBe(true);
        if (o.scope) expect(SCOPES).toContain(o.scope);
        if (o.auth) expect(["key", "none", "custom"]).toContain(o.auth);
        if (o.allowQueryKey) expect(o.scope).toBe("read");
        if (o.public) expect(o.auth).toBe("custom");
        if (o.scope === "admin") expect(o.loopbackOnly).toBe(true);
      }
    }
  });
});
