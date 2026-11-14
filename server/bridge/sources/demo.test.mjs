import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinSources } from "./builtin.mjs";
import { DEMO_DELAY_SEC, demoDelayedSource, demoEodSource, lastCloseAtOrBefore, registerDemoSources } from "./demo.mjs";
import { createSourceRegistry } from "./registry.mjs";
import { sourcesConfigSchema } from "./config.mjs";

// A Tuesday, 11:00 IST, so "15 minutes ago" is inside the session and the last close is yesterday 15:30.
const NOW = Date.UTC(2026, 10, 10, 5, 30);
const ctx = { now: NOW, signal: new AbortController().signal };

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the demo sources must not use the network");
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("demo sources", () => {
  it("registers demo, demo-delayed and demo-eod with valid descriptors", () => {
    const reg = createSourceRegistry();
    registerDemoSources(reg);
    expect(reg.list().map((p) => p.descriptor.id)).toEqual(["demo", "demo-delayed", "demo-eod"]);
    const [demo, delayed, eod] = reg.list().map((p) => p.descriptor);
    expect(demo).toMatchObject({ kind: "broker", tier: "builtin", class: "realtime", official: true });
    expect(delayed).toMatchObject({ kind: "free", tier: "opt-in", class: "delayed", delaySec: 900, official: false, noticeVersion: "demo-1" });
    expect(eod).toMatchObject({ kind: "free", tier: "byok", class: "eod", needsKey: true });
  });

  it("registers only in demo mode", async () => {
    const real = createSourceRegistry();
    await registerBuiltinSources(real, { config: { demo: false } });
    expect(real.has("demo-delayed")).toBe(false);
    expect(real.has("demo-eod")).toBe(false);
    const demo = createSourceRegistry();
    await registerBuiltinSources(demo, { config: { demo: true } });
    expect(demo.list().map((p) => p.descriptor.id)).toEqual(["demo", "demo-delayed", "demo-eod"]);
  });

  it("serves deterministic delayed quotes from 15 minutes ago", async () => {
    const p = demoDelayedSource();
    const a = await p.quotes(["NSE:RELIANCE", "NSE:NIFTY", "NSE:NOPE", "NFO:NIFTY-2026-11-26-25000-CE"], ctx);
    const b = await p.quotes(["NSE:RELIANCE", "NSE:NIFTY"], ctx);
    expect(a.items.map((i) => i.symbol)).toEqual(["NSE:RELIANCE", "NSE:NIFTY"]);
    expect(a.items).toEqual(b.items);
    expect(a.items[0].at).toBe(NOW - DEMO_DELAY_SEC * 1000);
    expect(a.items[0].fields).toMatchObject({ ltp: expect.any(Number), open: expect.any(Number), close: expect.any(Number) });
    expect(a.items[0].fields.ltp).toBeGreaterThan(0);
    // a different instant gives a different price
    const later = await p.quotes(["NSE:RELIANCE"], { ...ctx, now: NOW + 3_600_000 });
    expect(later.items[0].at).toBe(NOW + 3_600_000 - DEMO_DELAY_SEC * 1000);
  });

  it("serves history clipped to the delay, expiries and an option chain", async () => {
    const p = demoDelayedSource();
    const h = await p.history({ symbol: "NSE:RELIANCE", interval: "15m", fromMs: NOW - 86_400_000, toMs: NOW + 1000 }, ctx);
    expect(h.candles.length).toBeGreaterThan(0);
    expect(h.partial).toBe(true);
    expect(Math.max(...h.candles.map((c) => c.time)) * 1000).toBeLessThanOrEqual(NOW - DEMO_DELAY_SEC * 1000);
    await expect(p.history({ symbol: "NSE:NOPE", interval: "1d", fromMs: 0, toMs: 1 }, ctx)).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    const ex = await p.expiries("NIFTY", ctx);
    expect(ex.expiries).toHaveLength(4);
    expect(ex.expiries.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    const chain = await p.optionChain("NIFTY", ex.expiries[0], ctx);
    expect(chain.rows.length).toBeGreaterThan(20);
    expect(chain.rows[0]).toMatchObject({ strike: expect.any(Number), ce: expect.objectContaining({ ltp: expect.any(Number) }), pe: expect.any(Object) });
    expect(chain.underlyingLtp).toBeGreaterThan(0);
    expect((await p.optionChain("NIFTY", undefined, ctx)).expiry).toBe(ex.expiries[0]);
    await expect(p.expiries("NOSUCH", ctx)).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    expect(await p.test(ctx)).toMatchObject({ ok: true });
  });

  it("serves end-of-day data stamped at the last close, daily candles only", async () => {
    const p = demoEodSource();
    const close = lastCloseAtOrBefore(NOW);
    // Monday 10 Nov 2026 is the day before; its close is 15:30 IST
    expect(new Date(close).toISOString()).toBe("2026-11-09T10:00:00.000Z");
    const q = await p.quotes(["NSE:RELIANCE"], ctx);
    expect(q.items[0].at).toBe(close);
    expect(q.items[0].fields.bid).toBeNull();
    expect(q.items[0].fields.ltp).toBe(q.items[0].fields.close);
    const h = await p.history({ symbol: "NSE:RELIANCE", interval: "1d", fromMs: NOW - 10 * 86_400_000, toMs: NOW }, ctx);
    expect(h.candles.length).toBeGreaterThan(3);
    await expect(p.history({ symbol: "NSE:RELIANCE", interval: "5m", fromMs: 0, toMs: 1 }, ctx)).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(await p.test({ ...ctx, apiKey: "abcd" })).toMatchObject({ ok: true });
    expect((await p.test(ctx)).ok).toBe(false);
  });

  it("the last close skips weekends", () => {
    // Monday 09:00 IST: the last close is Friday 15:30
    const monMorning = Date.UTC(2026, 10, 9, 3, 30);
    expect(new Date(lastCloseAtOrBefore(monMorning)).toISOString()).toBe("2026-11-06T10:00:00.000Z");
    // Saturday noon IST: still Friday
    expect(new Date(lastCloseAtOrBefore(Date.UTC(2026, 10, 7, 6, 30))).toISOString()).toBe("2026-11-06T10:00:00.000Z");
    // Tuesday 16:00 IST: today's close
    expect(new Date(lastCloseAtOrBefore(Date.UTC(2026, 10, 10, 10, 30))).toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });
});

describe("builtin registration", () => {
  it("tolerates absent provider and plugin parts and never throws for them", async () => {
    const reg = createSourceRegistry();
    const warnings = [];
    await expect(registerBuiltinSources(reg, { config: { demo: false }, logger: { warn: (m, f) => warnings.push([m, f]) } })).resolves.toBe(reg);
    expect(warnings).toEqual([]);
  });
});

describe("sources config", () => {
  it("defaults are safe", () => {
    expect(sourcesConfigSchema.parse({})).toEqual({ autoFallback: false, timeoutMs: 5000, providers: {}, plugins: [] });
  });

  it("accepts providers and plugins and keeps their own keys", () => {
    const sha = "a".repeat(64);
    const c = sourcesConfigSchema.parse({ autoFallback: true, timeoutMs: 15_000, providers: { "demo-eod": { enabled: false, note: "x" } }, plugins: [{ path: "p/x.mjs", sha256: sha, granted: true, hosts: ["a.example"] }] });
    expect(c.providers["demo-eod"]).toEqual({ enabled: false, note: "x" });
    expect(c.plugins[0]).toMatchObject({ path: "p/x.mjs", sha256: sha, granted: true, hosts: ["a.example"] });
    expect(sourcesConfigSchema.parse({ plugins: [{ path: "p", sha256: sha }] }).plugins[0].granted).toBe(false);
  });

  it("rejects what could do harm", () => {
    expect(() => sourcesConfigSchema.parse({ timeoutMs: 15_001 })).toThrow();
    expect(() => sourcesConfigSchema.parse({ timeoutMs: 10 })).toThrow();
    expect(() => sourcesConfigSchema.parse({ autoFallback: "yes" })).toThrow();
    expect(() => sourcesConfigSchema.parse({ unknown: 1 })).toThrow();
    expect(() => sourcesConfigSchema.parse({ providers: { "Bad Id": {} } })).toThrow();
    expect(() => sourcesConfigSchema.parse({ plugins: [{ path: "p", sha256: "short", granted: true }] })).toThrow();
  });
});
