import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findRemovedSettings, loadConfig } from "./config.mjs";
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
  it("every contract's requires exist and its methods are unique", () => {
    for (const [name, spec] of Object.entries(SERVICE_CONTRACTS)) {
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

  it("stubs satisfy their contract and throw NOT_IMPLEMENTED", () => {
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
    const m = defineModule({ name: "safety", services: { audit: () => notImplementedService("audit") }, register() {} });
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("refuses non-contract services and core config keys", () => {
    expect(() => defineModule({ name: "xx", services: { cache: () => ({}) } })).toThrow(/not a contract service/);
    expect(() => defineModule({ name: "xx", configKey: "safety", configSchema: z.object({}) })).toThrow(/belongs to core/);
    expect(() => defineModule({ name: "xx", configKey: "x" })).toThrow(/configSchema/);
    expect(() => defineModule({ name: "X" })).toThrow(/name/);
  });

  it("refuses two providers for one service and duplicate names", () => {
    const a = defineModule({ name: "aa", services: { audit: () => ({}) } });
    const b = defineModule({ name: "bb", services: { audit: () => ({}) } });
    expect(() => validateModules([a, b])).toThrow(/provided by both/);
    expect(() => validateModules([a, a])).toThrow(/Duplicate module/);
  });
});

describe("module config sections", () => {
  const hooks = defineModule({ name: "hooks", configKey: "hooks", configSchema: z.object({ ackTimeoutMs: z.number().default(500) }).strict() });

  it("parses module sections with defaults and rejects unknown sections", () => {
    const base = loadConfig({ raw: {}, env: {} }).config;
    expect(applyModuleConfig(base, [hooks]).hooks).toEqual({ ackTimeoutMs: 500 });
    const withUnknown = loadConfig({ raw: { hookz: {} }, env: {} }).config;
    expect(() => applyModuleConfig(withUnknown, [hooks])).toThrow(/Unknown config section "hookz"/);
    // Inside a section it knows, a typo or a wrong value is still refused.
    const bad = loadConfig({ raw: { hooks: { nope: 1 } }, env: {} }).config;
    expect(() => applyModuleConfig(bad, [hooks])).toThrow(/hooks/);
    const wrong = loadConfig({ raw: { hooks: { ackTimeoutMs: "soon" } }, env: {} }).config;
    expect(() => applyModuleConfig(wrong, [hooks])).toThrow(/hooks\.ackTimeoutMs/);
  });
});

describe("settings that v2 removed", () => {
  it("ignore every removed setting with one friendly note, and still start", () => {
    const old = loadConfig({ raw: { alerts: { max: 5 }, vol: {}, stream: { candles: { maxBars: 100 } }, mcp: { toolsets: ["market", "options"] } }, env: {} }).config;
    const warnings = [];
    const out = applyModuleConfig(old, BUILTIN_MODULES, warnings);
    expect(warnings).toHaveLength(1);
    for (const k of ["alerts", "vol", "stream.candles", 'mcp.toolsets "options"']) expect(warnings[0]).toContain(`${k}: this setting was removed in v2`);
    expect(out.alerts).toBeUndefined();
    expect(out.vol).toBeUndefined();
    expect(out.stream.candles).toBeUndefined();
    expect(out.mcp.toolsets).toEqual(["market"]);
  });

  it("ignore the fallback-source settings an older release kept under backup, and old notify targets", () => {
    const old = loadConfig({ raw: { backup: { enabled: true, autoFallback: true, providers: { yahoo: { perSecond: 4 } }, keep: 3 }, notify: { targets: [{ kind: "telegram" }] } }, env: {} }).config;
    const warnings = [];
    const out = applyModuleConfig(old, BUILTIN_MODULES, warnings);
    for (const k of ["backup.enabled", "backup.autoFallback", "backup.providers", "notify.targets"]) expect(warnings[0]).toContain(`${k}: this setting was removed in v2`);
    // What v2 does know in the same section is kept, and nothing switches a data source on.
    expect(out.backup.keep).toBe(3);
    expect(out.backup.enabled).toBeUndefined();
    expect(out.notify.targets).toBeUndefined();
    expect(out.sources?.autoFallback ?? false).toBe(false);
    // A real mistake in the same section is still an error.
    const typo = loadConfig({ raw: { backup: { kep: 3 } }, env: {} }).config;
    expect(() => applyModuleConfig(typo, BUILTIN_MODULES)).toThrow(/backup/);
  });

  it("leave a config that has none of them alone", () => {
    const ok = loadConfig({ raw: { stream: { heartbeatMs: 20000 }, mcp: { toolsets: ["market"] } }, env: {} }).config;
    expect(findRemovedSettings(ok)).toEqual([]);
    expect(() => applyModuleConfig(ok, BUILTIN_MODULES)).not.toThrow();
  });
});

describe("buildServices", () => {
  it("fills unprovided services with stubs and checks provided ones", async () => {
    const deps = await buildServices(coreDeps(), []);
    for (const name of Object.keys(SERVICE_CONTRACTS)) expect(isStub(deps[name])).toBe(true);
    const broken = defineModule({ name: "audit-mod", services: { audit: () => ({ append() {} }) } });
    await expect(buildServices(coreDeps(), [broken])).rejects.toThrow(/missing/);
  });

  it("factories only see what they declared (plus core deps)", async () => {
    let seen;
    const mod = defineModule({
      name: "acc",
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
  it("every contract service has exactly one built-in provider", () => {
    const { providers } = validateModules(BUILTIN_MODULES);
    for (const name of Object.keys(SERVICE_CONTRACTS)) {
      if (SERVICES_NOT_IN_V2.includes(name)) continue;
      expect(BUILTIN_MODULES.find((m) => m.name === providers.get(name)), name).toBeDefined();
    }
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
