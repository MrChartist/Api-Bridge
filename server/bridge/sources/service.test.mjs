import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceRegistry } from "./registry.mjs";
import { createSourcesService, secretNameFor } from "./service.mjs";

const SECRET = "sk-test-0123456789abcdef";

const base = (over) => ({
  name: over.id,
  kind: "free",
  tier: "byok",
  class: "eod",
  delaySec: null,
  official: true,
  capabilities: ["quotes", "history"],
  limits: { perMinute: 10 },
  terms: { url: "https://example.com/terms", note: "You hold the vendor account." },
  ...over,
});

function fakeSecrets() {
  const data = new Map();
  return {
    data,
    async get(name) {
      return data.has(name) ? structuredClone(data.get(name)) : null;
    },
    async set(name, value) {
      data.set(name, structuredClone(value));
    },
    async delete(name) {
      return data.delete(name);
    },
    async list() {
      return [...data.keys()];
    },
    status: () => ({}),
  };
}

/** A registry with an eod byok source, a delayed opt-in source, a free realtime plugin-like source and a broker. */
function setup({ config = {}, extra = [] } = {}) {
  const calls = [];
  const registry = createSourceRegistry();
  const eod = {
    descriptor: base({ id: "eod-src", tier: "byok", class: "eod" }),
    async quotes(symbols, ctx) {
      calls.push({ id: "eod-src", cap: "quotes", symbols, ctx });
      return { items: symbols.filter((s) => s !== "NSE:MISSING").map((symbol) => ({ symbol, fields: { ltp: 100 }, at: 1000 })) };
    },
    async history(req, ctx) {
      calls.push({ id: "eod-src", cap: "history", req, ctx });
      return { candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 3 }], at: 2000 };
    },
    async test(ctx) {
      return ctx.apiKey ? { ok: true, latencyMs: 12 } : { ok: false };
    },
  };
  const delayed = {
    descriptor: base({ id: "slow-src", tier: "opt-in", class: "delayed", delaySec: 900, official: false, noticeVersion: "n-1", needsKey: false, capabilities: ["quotes", "expiries", "optionChain"] }),
    async quotes(symbols, ctx) {
      calls.push({ id: "slow-src", cap: "quotes", symbols, ctx });
      return { items: symbols.map((symbol) => ({ symbol, fields: { ltp: 99 }, at: 500 })) };
    },
    async expiries(underlying, ctx) {
      calls.push({ id: "slow-src", cap: "expiries", ctx });
      return { expiries: ["2026-11-10"], at: 600 };
    },
    async optionChain(underlying, expiry, ctx) {
      calls.push({ id: "slow-src", cap: "optionChain", expiry, ctx });
      return { underlyingLtp: 100, rows: [{ strike: 100, ce: { ltp: 1 }, pe: { ltp: 2 } }], at: 700 };
    },
  };
  const broker = { descriptor: { id: "my-broker", name: "My broker", kind: "broker", tier: "builtin", class: "realtime", delaySec: null, official: true, capabilities: ["quotes"], limits: { perSecond: 1 } } };
  for (const p of [broker, eod, delayed, ...extra]) registry.register(p);
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-sources-svc-"));
  const secrets = fakeSecrets();
  const t = { now: 1_800_000_000_000 };
  const lines = [];
  const logger = { addSecret: () => {}, debug: (m, f) => lines.push(JSON.stringify([m, f])), info: (m, f) => lines.push(JSON.stringify([m, f])), warn: (m, f) => lines.push(JSON.stringify([m, f])), error: (m, f) => lines.push(JSON.stringify([m, f])) };
  const svc = createSourcesService({ registry, config: { sources: config }, logger, clock: { now: () => t.now }, paths: { dataDir }, secrets });
  return { svc, registry, secrets, dataDir, calls, t, lines, eod, delayed };
}

const enableAll = async (svc) => {
  await svc.setConfig("eod-src", { apiKey: SECRET });
  await svc.setEnabled("eod-src", true);
  await svc.setEnabled("slow-src", true, { acknowledge: "n-1" });
};

describe("management: list and describe", () => {
  it("describes every source in the documented shape, with nothing enabled by default except the broker", () => {
    const { svc } = setup();
    const list = svc.list();
    expect(list.map((s) => s.id)).toEqual(["my-broker", "eod-src", "slow-src"]);
    const eod = list.find((s) => s.id === "eod-src");
    expect(eod).toEqual({
      id: "eod-src",
      name: "eod-src",
      kind: "free",
      tier: "byok",
      enabled: false,
      configured: false,
      class: "eod",
      delaySec: null,
      official: true,
      capabilities: ["quotes", "history"],
      limits: { perMinute: 10 },
      usage: { lastMinute: 0, today: 0 },
      health: { state: "disabled", errorRate: 0, p50Ms: null, lastError: null, nextTryAt: null },
      terms: { url: "https://example.com/terms", note: "You hold the vendor account." },
      needsKey: true,
      consent: null,
    });
    const slow = list.find((s) => s.id === "slow-src");
    expect(slow).toMatchObject({ tier: "opt-in", noticeVersion: "n-1", needsKey: false, configured: true, enabled: false, delaySec: 900, official: false });
    expect(list.find((s) => s.id === "my-broker")).toMatchObject({ enabled: true, configured: true, delaySec: 0, terms: null });
  });

  it("describe of an unknown id is NOT_FOUND", () => {
    expect(() => setup().svc.describe("nope")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

describe("management: enabling rules", () => {
  it("a BYOK source cannot be enabled until a key is saved", async () => {
    const { svc } = setup();
    await expect(svc.setEnabled("eod-src", true)).rejects.toMatchObject({ code: "STATE_CONFLICT", status: 409 });
    await svc.setConfig("eod-src", { apiKey: SECRET });
    const s = await svc.setEnabled("eod-src", true);
    expect(s).toMatchObject({ enabled: true, configured: true });
  });

  it("an opt-in source needs acknowledge equal to its noticeVersion and records the consent", async () => {
    const { svc, t, dataDir } = setup();
    await expect(svc.setEnabled("slow-src", true)).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    await expect(svc.setEnabled("slow-src", true, { acknowledge: "other" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    await expect(svc.setEnabled("slow-src", true)).rejects.toThrow(/acknowledge: "n-1"/);
    expect(svc.describe("slow-src").enabled).toBe(false);
    expect(svc.consentFor("slow-src")).toBeNull();
    const s = await svc.setEnabled("slow-src", true, { acknowledge: "n-1" });
    expect(s).toMatchObject({ enabled: true, consent: { acceptedAt: new Date(t.now).toISOString(), noticeVersion: "n-1" } });
    expect(svc.consentFor("slow-src")).toEqual({ acceptedAt: new Date(t.now).toISOString(), noticeVersion: "n-1" });
    expect(JSON.parse(readFileSync(join(dataDir, "sources", "state.json"), "utf8")).sources["slow-src"].consent.noticeVersion).toBe("n-1");
  });

  it("disabling is always allowed, keeps the consent record, and re-enabling the same notice needs no new acknowledgement", async () => {
    const { svc } = setup();
    await svc.setEnabled("slow-src", true, { acknowledge: "n-1" });
    expect((await svc.setEnabled("slow-src", false)).enabled).toBe(false);
    expect(svc.consentFor("slow-src")).not.toBeNull();
    expect((await svc.setEnabled("slow-src", true)).enabled).toBe(true);
    // disabling an already disabled or unconfigured source is fine too
    expect((await svc.setEnabled("eod-src", false)).enabled).toBe(false);
  });

  it("a new notice version switches the source off until it is acknowledged again", async () => {
    const { svc, registry } = setup();
    await svc.setEnabled("slow-src", true, { acknowledge: "n-1" });
    registry.get("slow-src").descriptor.noticeVersion = "n-2";
    expect(svc.describe("slow-src").enabled).toBe(false);
    await expect(svc.setEnabled("slow-src", true)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await svc.setEnabled("slow-src", true, { acknowledge: "n-2" })).enabled).toBe(true);
  });

  it("config can force a source off, and a builtin-style default on", async () => {
    const { svc } = setup({ config: { providers: { "slow-src": { enabled: false } } } });
    await expect(svc.setEnabled("slow-src", true, { acknowledge: "n-1" })).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(svc.describe("slow-src").enabled).toBe(false);
  });

  it("config enabled:true does not bypass the opt-in notice", () => {
    const { svc } = setup({ config: { providers: { "slow-src": { enabled: true } } } });
    expect(svc.describe("slow-src").enabled).toBe(false);
  });

  it("refuses a bad enabled value, an unknown id and a broker", async () => {
    const { svc } = setup();
    await expect(svc.setEnabled("eod-src", "yes")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setEnabled("nope", true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.setEnabled("my-broker", false)).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("survives a restart: state is read back and the key is still seen", async () => {
    const a = setup();
    await a.svc.setConfig("eod-src", { apiKey: SECRET });
    await a.svc.setEnabled("eod-src", true);
    await a.svc.setEnabled("slow-src", true, { acknowledge: "n-1" });
    const b = createSourcesService({ registry: a.registry, config: { sources: {} }, clock: { now: () => a.t.now }, paths: { dataDir: a.dataDir }, secrets: a.secrets });
    await b.refresh();
    expect(b.list().filter((s) => s.enabled).map((s) => s.id)).toEqual(["my-broker", "eod-src", "slow-src"]);
  });

  it("refresh switches a source off when its key is gone from the secrets store", async () => {
    const { svc, secrets } = setup();
    await svc.setConfig("eod-src", { apiKey: SECRET });
    await svc.setEnabled("eod-src", true);
    secrets.data.clear();
    await svc.refresh();
    expect(svc.describe("eod-src")).toMatchObject({ configured: false, enabled: false });
  });
});

describe("management: keys", () => {
  it("stores the key in the secrets store under source:<id>, never in state.json, and never returns it", async () => {
    const { svc, secrets, dataDir, lines } = setup();
    const out = await svc.setConfig("eod-src", { apiKey: `  ${SECRET} ` });
    expect(out).toEqual({ configured: true });
    expect(secrets.data.get(secretNameFor("eod-src"))).toEqual({ apiKey: SECRET });
    expect(secretNameFor("eod-src")).toBe("source:eod-src");
    expect(readFileSync(join(dataDir, "sources", "state.json"), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(svc.list())).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("validates the config body", async () => {
    const { svc } = setup();
    await expect(svc.setConfig("eod-src", null)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setConfig("eod-src", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setConfig("eod-src", { apiKey: "ab" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setConfig("eod-src", { apiKey: "has space inside" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setConfig("eod-src", { apiKey: 12345678 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setConfig("eod-src", { apiKey: SECRET, extra: 1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(svc.setConfig("slow-src", { apiKey: SECRET })).rejects.toThrow(/does not take an API key/);
    await expect(svc.setConfig("nope", { apiKey: SECRET })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("null removes the key and switches the source off", async () => {
    const { svc, secrets } = setup();
    await svc.setConfig("eod-src", { apiKey: SECRET });
    await svc.setEnabled("eod-src", true);
    expect(await svc.setConfig("eod-src", { apiKey: null })).toEqual({ configured: false });
    expect(secrets.data.has("source:eod-src")).toBe(false);
    expect(svc.describe("eod-src")).toMatchObject({ configured: false, enabled: false });
  });
});

describe("facade: which sources answer", () => {
  it("uses nothing until sources are enabled, and says why per symbol", async () => {
    const { svc, calls } = setup();
    const r = await svc.quotes(["NSE:RELIANCE"]);
    expect(r.items).toEqual([]);
    expect(r.errors).toEqual([{ symbol: "NSE:RELIANCE", code: "CAPABILITY_UNSUPPORTED", message: expect.stringMatching(/No enabled data source/) }]);
    await expect(svc.history({ symbol: "NSE:X", interval: "1d", fromMs: 0, toMs: 1 })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(svc.expiries("NIFTY")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(svc.optionChain("NIFTY", "2026-11-10")).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(calls).toEqual([]);
  });

  it("labels every item with provider, class, delaySec and official, most current class first", async () => {
    const { svc, calls } = setup();
    await enableAll(svc);
    const r = await svc.quotes(["NSE:RELIANCE", "NSE:INFY"]);
    // delayed ranks ahead of eod, so slow-src answers both and eod-src is never asked
    expect(calls.map((c) => c.id)).toEqual(["slow-src"]);
    expect(r.errors).toEqual([]);
    expect(r.items).toEqual([
      { symbol: "NSE:RELIANCE", fields: { ltp: 99 }, at: 500, provider: "slow-src", class: "delayed", delaySec: 900, official: false },
      { symbol: "NSE:INFY", fields: { ltp: 99 }, at: 500, provider: "slow-src", class: "delayed", delaySec: 900, official: false },
    ]);
  });

  it("a symbol the first source lacks goes to the next, and one nobody has is a per-symbol error", async () => {
    const { svc, calls, registry } = setup();
    await enableAll(svc);
    registry.get("slow-src").quotes = async (symbols) => ({ items: symbols.filter((s) => s === "NSE:A").map((symbol) => ({ symbol, fields: { ltp: 1 }, at: 5 })) });
    const r = await svc.quotes(["NSE:A", "NSE:B", "NSE:MISSING"]);
    expect(r.items.map((i) => [i.symbol, i.provider, i.class, i.delaySec])).toEqual([
      ["NSE:A", "slow-src", "delayed", 900],
      ["NSE:B", "eod-src", "eod", null],
    ]);
    expect(r.errors).toEqual([{ symbol: "NSE:MISSING", code: "SYMBOL_NOT_FOUND", message: expect.any(String) }]);
    expect(calls.find((c) => c.id === "eod-src").symbols).toEqual(["NSE:B", "NSE:MISSING"]);
  });

  it("never uses a broker source, whatever it declares", async () => {
    const { svc, registry } = setup();
    registry.get("my-broker").quotes = async () => {
      throw new Error("must not be called");
    };
    await enableAll(svc);
    const r = await svc.quotes(["NSE:A"]);
    expect(r.items.every((i) => i.provider !== "my-broker")).toBe(true);
    expect(svc.status().providers.map((p) => p.id)).not.toContain("my-broker");
  });

  it("reads for orders, risk, paper and alerts never see a delayed or end-of-day source", async () => {
    const { svc, calls } = setup();
    await enableAll(svc);
    for (const purpose of ["order", "risk", "paper", "alert"]) {
      const r = await svc.quotes(["NSE:A"], { purpose });
      expect(r.items, purpose).toEqual([]);
      await expect(svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1, purpose })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    }
    expect(calls).toEqual([]);
    expect((await svc.quotes(["NSE:A"], { purpose: "analysis" })).items).toHaveLength(1);
  });

  it("maxAgeMs filters out sources that are too slow", async () => {
    const { svc, calls } = setup();
    await enableAll(svc);
    expect((await svc.quotes(["NSE:A"], { maxAgeMs: 1000 })).items).toEqual([]);
    expect((await svc.quotes(["NSE:A"], { maxAgeMs: 900_000 })).items.map((i) => i.provider)).toEqual(["slow-src"]);
    expect((await svc.quotes(["NSE:A"], { maxAgeMs: 24 * 3600_000 })).items).toHaveLength(1);
    expect(calls.every((c) => c.id === "slow-src")).toBe(true);
  });

  it("history, expiries and option chain carry the same labels", async () => {
    const { svc } = setup();
    await enableAll(svc);
    const h = await svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 10 });
    expect(h).toMatchObject({ symbol: "NSE:A", interval: "1d", provider: "eod-src", class: "eod", delaySec: null, official: true, partial: false, at: 2000 });
    expect(h.candles).toHaveLength(1);
    expect(await svc.expiries("NIFTY")).toEqual({ underlying: "NIFTY", expiries: ["2026-11-10"], at: 600, provider: "slow-src", class: "delayed", delaySec: 900, official: false });
    const c = await svc.optionChain("NIFTY", "2026-11-10");
    expect(c).toMatchObject({ underlying: "NIFTY", expiry: "2026-11-10", underlyingLtp: 100, provider: "slow-src", class: "delayed", delaySec: 900, official: false, at: 700 });
    expect(c.rows).toHaveLength(1);
  });

  it("a source that fails lets the next one try, and the last failure is thrown when none answers", async () => {
    const { svc, registry } = setup();
    await enableAll(svc);
    registry.get("eod-src").history = async () => {
      throw Object.assign(new Error("boom"), { code: "UPSTREAM_RATE_LIMITED" });
    };
    await expect(svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1 })).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    registry.get("slow-src").quotes = async () => {
      throw new Error("down");
    };
    const r = await svc.quotes(["NSE:A"]);
    expect(r.items.map((i) => i.provider)).toEqual(["eod-src"]);
  });

  it("treats an unreadable answer as a failure", async () => {
    const { svc, registry } = setup();
    await enableAll(svc);
    registry.get("eod-src").history = async () => ({ nothing: true });
    await expect(svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1 })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("passes { signal, now } and the key (only to a source that needs one)", async () => {
    const { svc, calls, t } = setup();
    await enableAll(svc);
    await svc.quotes(["NSE:A"], { maxAgeMs: 24 * 3600_000 });
    await svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1 });
    const slow = calls.find((c) => c.id === "slow-src");
    const eod = calls.find((c) => c.id === "eod-src");
    expect(slow.ctx.now).toBe(t.now);
    expect(slow.ctx.signal).toBeInstanceOf(AbortSignal);
    expect(slow.ctx).not.toHaveProperty("apiKey");
    expect(eod.ctx.apiKey).toBe(SECRET);
  });

  it("times out a source that never answers, aborting its signal", async () => {
    const { svc, registry, calls } = setup({ config: { timeoutMs: 100 } });
    await enableAll(svc);
    let signal;
    registry.get("eod-src").history = (req, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    };
    const started = Date.now();
    await expect(svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1 })).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal.aborted).toBe(true);
    expect(calls).toEqual([]);
    expect(svc.describe("eod-src").health.lastError).toMatch(/did not answer in time/);
  });

  it("a caller's abort stops the call and is rethrown as an AbortError", async () => {
    const { svc, registry } = setup();
    await enableAll(svc);
    registry.get("eod-src").history = () => new Promise(() => {});
    const ctrl = new AbortController();
    const p = svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1 }, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the timeout is capped at 15 s by the config schema", () => {
    expect(() => setup({ config: { timeoutMs: 15_001 } })).toThrow();
    expect(() => setup({ config: { timeoutMs: 15_000 } })).not.toThrow();
  });

  it("scrubs the key from error text a source echoes back", async () => {
    const { svc, registry, lines } = setup();
    await enableAll(svc);
    registry.get("eod-src").history = async () => {
      throw new Error(`401 for https://vendor.example/q?apikey=${SECRET}`);
    };
    let message = "";
    try {
      await svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1 });
    } catch (err) {
      message = err.message;
    }
    expect(message).toContain("apikey=***");
    expect(message).not.toContain(SECRET);
    expect(JSON.stringify(svc.list())).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});

describe("facade: the selector", () => {
  it("is one overridable function, and whatever it returns is still filtered by the rules", async () => {
    const { svc, registry, calls } = setup();
    await enableAll(svc);
    svc.setPicker((capability, req, { eligibleSources }) => {
      expect(capability).toBe("quotes");
      if (!req.purpose || req.purpose === "display") expect(eligibleSources().map((p) => p.descriptor.id)).toEqual(["slow-src", "eod-src"]);
      // a greedy picker asks for the broker and for the eod source first
      return [registry.get("my-broker"), registry.get("eod-src"), registry.get("slow-src")];
    });
    const r = await svc.quotes(["NSE:A"]);
    expect(r.items.map((i) => i.provider)).toEqual(["eod-src"]);
    expect(calls.map((c) => c.id)).toEqual(["eod-src"]);
    // ... and cannot bring back a source that is off or too slow
    await svc.setEnabled("eod-src", false);
    expect((await svc.quotes(["NSE:A"], { purpose: "order" })).items).toEqual([]);
    svc.setPicker(null);
    expect((await svc.quotes(["NSE:A"])).items.map((i) => i.provider)).toEqual(["slow-src"]);
  });

  it("accepts a picker in deps and exposes pickSources()", async () => {
    const registry = createSourceRegistry();
    const eod = { descriptor: base({ id: "only-eod", tier: "builtin", terms: undefined, needsKey: false }), quotes: async (s) => ({ items: s.map((symbol) => ({ symbol, fields: { ltp: 1 }, at: 1 })) }), history: async () => ({ candles: [], at: 1 }) };
    registry.register(eod);
    let asked = null;
    const svc = createSourcesService({ registry, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-s-")) }, pickSources: (cap, req, h) => ((asked = [cap, req.purpose]), h.eligibleSources()) });
    expect((await svc.quotes(["NSE:A"])).items).toHaveLength(1);
    expect(asked).toEqual(["quotes", "display"]);
    expect((await svc.pickSources("history", {})).map((p) => p.descriptor.id)).toEqual(["only-eod"]);
    expect(() => svc.setPicker("x")).toThrow(TypeError);
  });
});

describe("facade: status and autoFallback", () => {
  it("status lists the non-broker sources and the order they are tried in", async () => {
    const { svc } = setup({ config: { autoFallback: true } });
    expect(svc.status()).toMatchObject({ enabled: false, autoFallback: true, order: [], cacheMs: 0 });
    await enableAll(svc);
    const st = svc.status();
    expect(st.enabled).toBe(true);
    expect(st.order).toEqual(["slow-src", "eod-src"]);
    expect(st.providers.map((p) => [p.id, p.enabled, p.class])).toEqual([["eod-src", true, "eod"], ["slow-src", true, "delayed"]]);
    expect(svc.autoFallback()).toBe(true);
    expect(setup().svc.autoFallback()).toBe(false);
  });
});

describe("usage and health", () => {
  it("counts calls per minute and per day", async () => {
    const { svc, t } = setup();
    await enableAll(svc);
    await svc.quotes(["NSE:A"]);
    await svc.quotes(["NSE:B"]);
    expect(svc.describe("slow-src").usage).toEqual({ lastMinute: 2, today: 2 });
    t.now += 61_000;
    expect(svc.describe("slow-src").usage).toEqual({ lastMinute: 0, today: 2 });
    t.now += 24 * 3600_000;
    expect(svc.describe("slow-src").usage).toEqual({ lastMinute: 0, today: 0 });
    await svc.quotes(["NSE:C"]);
    expect(svc.usage("slow-src")).toEqual({ lastMinute: 1, today: 1 });
  });

  it("reports ok health with a median latency, and degraded when most calls fail", async () => {
    const { svc, registry } = setup();
    await enableAll(svc);
    await svc.quotes(["NSE:A"]);
    expect(svc.describe("slow-src").health).toMatchObject({ state: "ok", errorRate: 0, lastError: null });
    expect(typeof svc.describe("slow-src").health.p50Ms).toBe("number");
    registry.get("slow-src").quotes = async () => {
      throw new Error("down");
    };
    for (let i = 0; i < 4; i += 1) await svc.quotes(["NSE:A"]);
    const h = svc.describe("slow-src").health;
    expect(h.state).toBe("degraded");
    expect(h.errorRate).toBeGreaterThan(0.5);
    expect(h.lastError).toMatch(/down/);
  });

  it("uses an attached health tracker for state and feeds it every outcome", async () => {
    const { svc } = setup();
    await enableAll(svc);
    const seen = [];
    svc.attachHealth({ state: (id) => ({ state: "open", errorRate: 1, p50Ms: 5, lastError: "x", nextTryAt: 99, id }), record: (id, r) => seen.push([id, r.ok]) });
    await svc.quotes(["NSE:A"]);
    expect(seen).toEqual([["slow-src", true]]);
    expect(svc.describe("slow-src").health).toEqual({ state: "open", errorRate: 1, p50Ms: 5, lastError: "x", nextTryAt: new Date(99).toISOString() });
    // a disabled source is "disabled" whatever the tracker says
    expect(svc.describe("my-broker").health.state).toBe("open");
    await svc.setEnabled("slow-src", false);
    expect(svc.describe("slow-src").health.state).toBe("disabled");
  });
});

describe("test()", () => {
  it("runs the source's own test with the key and reports ok and latency", async () => {
    const { svc } = setup();
    expect(await svc.test("eod-src")).toEqual({ ok: false, latencyMs: 0, detail: "Add an API key first." });
    await svc.setConfig("eod-src", { apiKey: SECRET });
    expect(await svc.test("eod-src")).toEqual({ ok: true, latencyMs: 12 });
    expect(svc.describe("eod-src").usage.today).toBe(1);
  });

  it("says plainly when there is no test, and turns a failure into ok:false with a scrubbed detail", async () => {
    const { svc, registry } = setup();
    expect(await svc.test("slow-src")).toEqual({ ok: false, latencyMs: 0, detail: "This source has no connection test." });
    await svc.setConfig("eod-src", { apiKey: SECRET });
    registry.get("eod-src").test = async () => {
      throw new Error(`bad key ${SECRET}`);
    };
    const r = await svc.test("eod-src");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("bad key ***");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    await expect(svc.test("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("times out a hung test", async () => {
    const { svc, registry } = setup({ config: { timeoutMs: 100 } });
    await svc.setConfig("eod-src", { apiKey: SECRET });
    registry.get("eod-src").test = () => new Promise(() => {});
    const r = await svc.test("eod-src");
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/in time/) });
  });
});

describe("the read's purpose reaches the source (a plugin refuses strict purposes itself)", () => {
  it("passes purpose in the call context for quotes, history, expiries and option chains, display when none is given", async () => {
    const { svc, calls } = setup();
    await enableAll(svc);
    await svc.quotes(["NSE:A"], { purpose: "analysis" });
    expect(calls.at(-1).ctx.purpose).toBe("analysis");
    await svc.quotes(["NSE:A"]);
    expect(calls.at(-1).ctx.purpose).toBe("display");
    await svc.history({ symbol: "NSE:A", interval: "1d", fromMs: 0, toMs: 1, purpose: "analysis" });
    expect(calls.at(-1).ctx.purpose).toBe("analysis");
    await svc.expiries("NIFTY", { purpose: "analysis" });
    expect(calls.at(-1).ctx.purpose).toBe("analysis");
    await svc.optionChain("NIFTY", "2026-11-10", { purpose: "analysis" });
    expect(calls.at(-1).ctx.purpose).toBe("analysis");
  });

  it("a plugin provider built by the loader refuses the strict purposes that context now carries", async () => {
    const { providerFor } = await import("./plugin/loader.mjs");
    const { checkedDescriptor, parseManifest } = await import("./plugin/manifest.mjs");
    const { testManifest } = await import("./plugin/__fixtures__/fakeChild.mjs");
    const m = parseManifest(testManifest()).manifest;
    const hostCalls = [];
    const p = providerFor(checkedDescriptor(m).descriptor, { call: async (...a) => (hostCalls.push(a), { items: [] }), status: () => ({ state: "ready", restarts: 0 }), stop: async () => {} });
    for (const purpose of ["alert", "paper", "risk", "order"]) {
      await expect(p.quotes(["NSE:A"], { purpose })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    }
    expect(hostCalls).toEqual([]);
    await expect(p.quotes(["NSE:A"], { purpose: "analysis" })).resolves.toBeDefined();
  });
});

describe("a key a source echoes back is scrubbed in its URL-encoded and base64 forms too", () => {
  it("test() and reads scrub every form of the key from what they show", async () => {
    const key = "sk/test+0123456789=abc";
    const { svc, registry, lines } = setup();
    await svc.setConfig("eod-src", { apiKey: key });
    await svc.setEnabled("eod-src", true);
    const forms = [key, encodeURIComponent(key), Buffer.from(key).toString("base64"), Buffer.from(`user:${key}`).toString("base64"), Buffer.from(key).toString("base64url")];
    for (const form of forms) {
      registry.get("eod-src").test = async () => {
        throw new Error(`vendor says no to ${form}`);
      };
      registry.get("eod-src").quotes = async () => {
        throw new Error(`vendor says no to ${form}`);
      };
      const r = await svc.test("eod-src");
      expect(r.detail, form).toContain("***");
      expect(r.detail).not.toContain(form);
      const q = await svc.quotes(["NSE:A"]);
      expect(JSON.stringify(q.errors)).not.toContain(form);
    }
    expect(lines.join("\n")).not.toContain(encodeURIComponent(key));
  });
});
