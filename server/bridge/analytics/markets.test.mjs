import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { NIFTY50 } from "../scanner/universes.mjs";
import { BENCHMARK, SECTORS, SNAPSHOT_TTL_MS, advanceDecline, createMarkets, marketsRoutes, pearson, quadrant, rangePosition, rotationSeries } from "./markets.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse("2026-10-30T05:00:00Z");
const LAST_BAR = Date.parse("2026-10-29T00:00:00+05:30") / 1000;
const FNO = ["NSE:AAA", "NSE:BBB", "NSE:CCC", "NSE:DDD"];
const B = "/v1/analytics/markets";

/** n daily candles ending the day before the fake "today", closes from f(i). */
function candles(n, f) {
  return Array.from({ length: n }, (_, i) => {
    const close = f(i);
    return { time: LAST_BAR - (n - 1 - i) * 86_400, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 };
  });
}

function setup({ prices = {}, symbols, withDir = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "markets-"));
  dirs.push(dir);
  const clock = { t: NOW, now: () => clock.t };
  const marketData = createFakeMarketData({ prices, clock });
  const universes = { resolve: async (n) => (n === "FNO" ? [...FNO] : [...NIFTY50]) };
  const deps = { marketData, clock, universes, paths: withDir ? { dataDir: dir } : undefined, symbols };
  const handlers = {};
  for (const [m, p, o, h] of marketsRoutes(deps)) handlers[`${m} ${p.slice(B.length)}`] = { o, h };
  const call = (key, query = "", ctx = {}) => handlers[key].h({ requestId: "q", params: {}, query: new URLSearchParams(query), principal: { kind: "local" }, ...ctx });
  return { dir, clock, marketData, deps, handlers, call, deps };
}
const quotesCalls = (md) => md.calls.filter((c) => c[0] === "quotes");
const historyCalls = (md) => md.calls.filter((c) => c[0] === "history");
const noNaN = (v) => expect(JSON.stringify(v)).not.toMatch(/NaN|Infinity|undefined/);
const body = (r) => JSON.parse(r.body);

describe("routes", () => {
  it("lists seven routes, all read scope, refresh with body none", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers)).toEqual(["GET /indices", "GET /movers", "GET /sectors", "GET /breadth", "POST /breadth/refresh", "GET /rotation", "GET /correlation"]);
    for (const k of Object.keys(handlers)) expect(handlers[k].o.scope).toBe("read");
    expect(handlers["POST /breadth/refresh"].o).toEqual({ scope: "read", body: "none" });
  });

  it("turns a raw error into INTERNAL and lets BridgeErrors through", async () => {
    const { marketData, call } = setup({ prices: { "NSE:NIFTY": 25000 } });
    marketData.quotes = async () => {
      throw new TypeError("boom");
    };
    await expect(call("GET /indices")).rejects.toMatchObject({ code: "INTERNAL" });
    marketData.quotes = async () => {
      throw new BridgeError("UPSTREAM_RATE_LIMITED", "slow down");
    };
    await expect(call("GET /indices")).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
  });
});

describe("indices", () => {
  it("makes ONE batched quotes call and computes the day-range position", async () => {
    const { marketData, call } = setup();
    marketData.setQuote("NSE:NIFTY", { ltp: 25100, close: 25000, high: 25200, low: 25000 });
    marketData.setQuote("NSE:INDIAVIX", { ltp: 14, close: 15, high: 15, low: 14 });
    marketData.setQuote("BSE:SENSEX", { ltp: 82000, close: 82000, high: 82000, low: 82000 });
    const r = await call("GET /indices");
    expect(quotesCalls(marketData)).toHaveLength(1);
    expect(r.data.items.map((i) => i.symbol)).toEqual(["NSE:NIFTY", "BSE:SENSEX", "NSE:INDIAVIX"]);
    const nifty = r.data.items[0];
    expect(nifty).toMatchObject({ name: "NIFTY 50", ltp: 25100, change: 100, changePct: 0.4, dayHigh: 25200, dayLow: 25000, rangePosition: 0.5 });
    expect(r.data.items[1].rangePosition).toBeNull();
    expect(r.data.items[2].rangePosition).toBe(0);
    expect(r.errors.map((e) => e.symbol)).toContain("NSE:BANKNIFTY");
    expect(r.meta.cost).toMatchObject({ quoteCalls: 1, historyCalls: 0 });
    noNaN(r);
  });

  it("uses the index symbols the instrument master knows", async () => {
    const symbols = { search: async ({ q }) => ({ items: q === "NIFTY" ? [{ canonical: "NSE:NIFTY", kind: "INDEX" }, { canonical: "NSE:NIFTYIT", kind: "INDEX", name: "Nifty IT" }, { canonical: "NFO:NIFTY-2026-11-24-FUT", kind: "FUT" }] : [] }) };
    const { marketData, call } = setup({ symbols, prices: { "NSE:NIFTY": 25000, "NSE:NIFTYIT": 40000 } });
    const r = await call("GET /indices");
    expect(r.data.items.map((i) => i.symbol)).toEqual(["NSE:NIFTY", "NSE:NIFTYIT"]);
    expect(r.data.items[1].name).toBe("Nifty IT");
    expect(r.errors).toEqual([]);
    expect(quotesCalls(marketData)[0][1]).toEqual(["NSE:NIFTY", "NSE:NIFTYIT"]);
  });
});

describe("rangePosition and counts", () => {
  it("clamps and nulls", () => {
    expect(rangePosition(110, 100, 120)).toBe(0.5);
    expect(rangePosition(130, 100, 120)).toBe(1);
    expect(rangePosition(90, 100, 120)).toBe(0);
    expect(rangePosition(100, 100, 100)).toBeNull();
    expect(rangePosition(NaN, 1, 2)).toBeNull();
    expect(rangePosition(1, null, 2)).toBeNull();
  });
  it("counts advances, declines and unchanged", () => {
    const s = advanceDecline([{ changePct: 1 }, { changePct: 0.001 }, { changePct: -2 }, { changePct: 0 }, { changePct: null }]);
    expect(s).toMatchObject({ advances: 1, declines: 1, unchanged: 2, total: 4, ratio: 1, advancePct: 25 });
  });
});

function moversSetup() {
  const s = setup();
  const q = (sym, ltp, close, volume, oi) => s.marketData.setQuote(sym, { ltp, close, high: Math.max(ltp, close), low: Math.min(ltp, close), volume, ...(oi ? { oi } : {}) });
  q("NSE:AAA", 110, 100, 1000);
  q("NSE:BBB", 90, 100, 5000);
  q("NSE:CCC", 100, 100, 200);
  q("NSE:DDD", 205, 200, 100_000, 7000);
  return s;
}

describe("movers", () => {
  it("sorts server-side by every key and respects limit", async () => {
    const { call } = moversSetup();
    const sym = (r) => r.data.items.map((i) => i.symbol.slice(4));
    expect(sym(await call("GET /movers", "by=gainers&limit=2"))).toEqual(["AAA", "DDD"]);
    expect(sym(await call("GET /movers", "by=losers"))).toEqual(["BBB", "CCC", "DDD", "AAA"]);
    expect(sym(await call("GET /movers", "by=volume&limit=1"))).toEqual(["DDD"]);
    expect(sym(await call("GET /movers", "by=turnover&limit=2"))).toEqual(["DDD", "BBB"]);
    const oi = await call("GET /movers", "by=oi");
    expect(sym(oi)).toEqual(["DDD"]);
    expect(oi.data.items[0]).toMatchObject({ rank: 1, oi: 7000, turnover: 20_500_000 });
    const r = await call("GET /movers", "");
    expect(r.data).toMatchObject({ universe: "FNO", by: "gainers", limit: 10, summary: { advances: 2, declines: 1, unchanged: 1 } });
    noNaN(r);
  });

  it("shares one quote pass: cache for 15s and in-flight dedupe", async () => {
    const { marketData, call, clock } = moversSetup();
    const [a, b, c] = await Promise.all([call("GET /movers"), call("GET /movers", "by=losers"), call("GET /movers", "by=volume")]);
    expect(quotesCalls(marketData)).toHaveLength(1);
    expect(a.meta.cost.quoteCalls + b.meta.cost.quoteCalls + c.meta.cost.quoteCalls).toBe(1);
    clock.t += SNAPSHOT_TTL_MS - 1;
    const hit = await call("GET /movers");
    expect(hit.meta.cache).toMatchObject({ hit: true, ttlMs: SNAPSHOT_TTL_MS });
    expect(quotesCalls(marketData)).toHaveLength(1);
    clock.t += 2;
    const miss = await call("GET /movers");
    expect(miss.meta.cache.hit).toBe(false);
    expect(quotesCalls(marketData)).toHaveLength(2);
  });

  it("does not share between callers limited to different accounts", async () => {
    const { marketData, call } = moversSetup();
    const key = (accounts) => ({ principal: { kind: "key" }, key: { id: "k", accounts }, scopes: new Set(["read"]) });
    await call("GET /movers", "", key(["a"]));
    await call("GET /movers", "", key(["b"]));
    expect(quotesCalls(marketData)).toHaveLength(2);
  });

  it("validates parameters and reports per-symbol errors", async () => {
    const { call, marketData } = moversSetup();
    await expect(call("GET /movers", "by=sideways")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /movers", "universe=INDICES")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /movers", "limit=0")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /movers", "limit=51")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    marketData.fail("NSE:BBB");
    const r = await call("GET /movers", "by=losers");
    expect(r.errors.map((e) => e.symbol)).toEqual(["NSE:BBB"]);
    expect(r.meta).toMatchObject({ requested: 4, quoted: 3 });
  });
});

function sectorSetup() {
  const s = setup();
  s.marketData.setCandles(BENCHMARK, "1d", candles(260, (i) => 20000 + i * 10 + Math.sin(i / 3) * 40));
  s.marketData.setQuote(BENCHMARK, { ltp: 22600, close: 22590 });
  SECTORS.forEach((sec, k) => {
    s.marketData.setCandles(sec.symbol, "1d", candles(260, (i) => 1000 + i * (1 + k / 10) + Math.sin(i / (3 + k)) * 15));
    s.marketData.setQuote(sec.symbol, { ltp: 1000 + k * 10, close: 1000 });
  });
  return s;
}

describe("sectors", () => {
  it("1d comes from one quote call and ranks by changePct", async () => {
    const { call, marketData } = sectorSetup();
    const r = await call("GET /sectors");
    expect(quotesCalls(marketData)).toHaveLength(1);
    expect(historyCalls(marketData)).toHaveLength(0);
    expect(r.data.items).toHaveLength(SECTORS.length);
    expect(r.data.items[0]).toMatchObject({ key: "MEDIA", rank: 1 });
    expect(r.data.items.at(-1)).toMatchObject({ key: "BANK", changePct: 0 });
    noNaN(r);
  });

  it("1w and 1m use daily candles at background priority and cache them for the day", async () => {
    const { call, marketData, clock } = sectorSetup();
    const w = await call("GET /sectors", "tf=1w");
    expect(historyCalls(marketData)).toHaveLength(SECTORS.length);
    for (const c of historyCalls(marketData)) expect(c[2]).toMatchObject({ priority: "background" });
    const bank = w.data.items.find((i) => i.key === "BANK");
    const base = marketData.history({ symbol: "NSE:BANKNIFTY", interval: "1d", countback: 260 });
    const closes = (await base).candles.map((c) => c.close);
    expect(bank.changePct).toBeCloseTo(((closes.at(-1) - closes.at(-6)) / closes.at(-6)) * 100, 1);
    const before = historyCalls(marketData).length;
    const m = await call("GET /sectors", "tf=1m");
    expect(historyCalls(marketData)).toHaveLength(before);
    expect(m.meta.cost.historyCalls).toBe(0);
    expect(m.data.items.every((i) => i.changePct !== null)).toBe(true);
    clock.t += 24 * 3600_000;
    await call("GET /sectors", "tf=1m");
    expect(historyCalls(marketData).length).toBeGreaterThan(before);
  });

  it("a sector whose candles fail is null with an error, never a failed call", async () => {
    const { call, marketData } = sectorSetup();
    marketData.fail("NSE:NIFTYIT");
    const r = await call("GET /sectors", "tf=1w");
    expect(r.data.items.find((i) => i.key === "IT").changePct).toBeNull();
    expect(r.errors.some((e) => e.symbol === "NSE:NIFTYIT")).toBe(true);
  });

  it("drills into constituents from the shared snapshot and validates the key", async () => {
    const { call, marketData } = sectorSetup();
    for (const m of ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM"]) marketData.setQuote(`NSE:${m}`, { ltp: 110, close: 100 + (m === "TCS" ? 0 : 5) });
    const r = await call("GET /sectors", "drill=it");
    expect(r.data.drill).toMatchObject({ key: "IT", tf: "1d" });
    expect(r.data.drill.constituents.map((c) => c.symbol)).toEqual(["NSE:TCS", "NSE:HCLTECH", "NSE:INFY", "NSE:TECHM", "NSE:WIPRO"]);
    expect(r.data.drill.constituents[0]).toMatchObject({ symbol: "NSE:TCS", changePct: 10 });
    const again = await call("GET /sectors", "drill=IT");
    expect(again.meta.cost.cacheHits).toBeGreaterThan(0);
    await expect(call("GET /sectors", "drill=NOPE")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /sectors", "tf=2w")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

function breadthSetup(opts) {
  const s = setup(opts);
  s.marketData.setCandles("NSE:AAA", "1d", candles(260, (i) => 100 + i));
  s.marketData.setCandles("NSE:BBB", "1d", candles(260, (i) => 500 - i));
  s.marketData.setCandles("NSE:CCC", "1d", candles(260, (i) => 50 + i * 0.5));
  s.marketData.setCandles("NSE:DDD", "1d", candles(260, (i) => 80 + i));
  s.marketData.setQuote("NSE:AAA", { ltp: 110, close: 100 });
  s.marketData.setQuote("NSE:BBB", { ltp: 90, close: 100 });
  s.marketData.setQuote("NSE:CCC", { ltp: 100, close: 100 });
  s.marketData.setQuote("NSE:DDD", { ltp: 101, close: 100 });
  return s;
}

describe("breadth", () => {
  it("answers pending with live advance/decline, then runs the job in the background and persists it", async () => {
    const { call, marketData, dir, deps, clock } = breadthSetup();
    const first = await call("GET /breadth");
    expect(first.data).toMatchObject({ status: "pending", computedAt: null, breadth: null });
    expect(first.data.advanceDecline).toMatchObject({ universe: "FNO", advances: 2, declines: 1, unchanged: 1 });
    expect(historyCalls(marketData)).toHaveLength(0);

    marketData.fail("NSE:DDD");
    const r = await call("POST /breadth/refresh");
    expect(r.status).toBe(202);
    expect(body(r).data).toMatchObject({ started: true, status: "pending" });
    const again = await call("POST /breadth/refresh");
    expect(body(again).data).toMatchObject({ started: false, reason: "already running" });
    await marketsRegistryIdle(deps);

    for (const c of historyCalls(marketData)) expect(c[2]).toMatchObject({ priority: "background" });
    const done = await call("GET /breadth");
    expect(done.data.status).toBe("partial");
    expect(done.data.computedAt).toBe(new Date(NOW).toISOString());
    const b = done.data.breadth;
    expect(b.symbols).toMatchObject({ total: 4, used: 3, failed: 1 });
    expect(b.newHighs52w).toMatchObject({ count: 2, of: 3 });
    expect(b.newHighs52w.symbols).toEqual(["AAA", "CCC"]);
    expect(b.newLows52w).toMatchObject({ count: 1, symbols: ["BBB"] });
    expect(b.pctAbove.dma20).toMatchObject({ count: 2, of: 3, pct: 66.67 });
    expect(b.pctAbove.dma200).toMatchObject({ count: 2, of: 3 });
    expect(b.advanceDeclineLine).toHaveLength(60);
    expect(b.advanceDeclineLine.at(-1)).toMatchObject({ advances: 2, declines: 1, net: 1, line: 60 });
    noNaN(done);

    const file = join(dir, "analytics", "breadth.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "partial", universe: "FNO" });

    // a new process reads the disk cache without any candle call
    const fresh = setup({ withDir: false });
    const svc = createMarkets({ ...deps, marketData: fresh.marketData });
    const loaded = await svc.handlers.breadthGet({ requestId: "q", query: new URLSearchParams(), principal: { kind: "local" } });
    expect(loaded.data).toMatchObject({ status: "partial", computedAt: new Date(NOW).toISOString() });
    expect(historyCalls(fresh.marketData)).toHaveLength(0);

    // the next day the cached numbers are stale and the status falls back to pending
    clock.t += 24 * 3600_000;
    const next = await call("GET /breadth");
    expect(next.data).toMatchObject({ status: "pending", stale: true });
    expect(next.data.breadth).not.toBeNull();
  });

  it("is ready when every symbol reads, and a fresh result is not recomputed", async () => {
    const { call, deps, marketData, clock } = breadthSetup();
    await call("POST /breadth/refresh");
    await marketsRegistryIdle(deps);
    const r = await call("GET /breadth");
    expect(r.data.status).toBe("ready");
    expect(r.data.breadth.symbols).toMatchObject({ used: 4, failed: 0 });
    const calls = historyCalls(marketData).length;
    const skip = await call("POST /breadth/refresh");
    expect(skip.status).toBe(200);
    expect(body(skip).data).toMatchObject({ started: false, reason: "fresh" });
    clock.t += 31 * 60_000;
    await call("POST /breadth/refresh");
    await marketsRegistryIdle(deps);
    expect(historyCalls(marketData).length).toBe(calls); // candles still cached for the day
  });

  it("a job that reads nothing keeps the old result and reports lastError", async () => {
    const { call, deps, marketData } = breadthSetup({ withDir: false });
    for (const s of FNO) marketData.fail(s);
    await call("POST /breadth/refresh");
    await marketsRegistryIdle(deps);
    const r = await call("GET /breadth");
    expect(r.data).toMatchObject({ status: "pending", breadth: null });
    expect(r.data.job.running).toBe(false);
    expect(r.data.job.lastError).toMatch(/No daily candles/);
  });
});

/** Wait for the breadth job of the markets service the routes were built on. */
async function marketsRegistryIdle(deps) {
  const { marketsFor } = await import("./markets.mjs");
  await marketsFor(deps).whenBreadthIdle();
}

describe("rotation", () => {
  it("labels quadrants and keeps every number finite", () => {
    expect(quadrant(101, 101)).toBe("leading");
    expect(quadrant(101, 99)).toBe("weakening");
    expect(quadrant(99, 99)).toBe("lagging");
    expect(quadrant(99, 101)).toBe("improving");
  });

  it("an accelerating relative strength is leading, a decelerating one lagging", () => {
    const params = { stride: 1, span: 10, window: 60, mom: 5 };
    const up = rotationSeries(Array.from({ length: 150 }, (_, t) => ({ d: `d${t}`, rs: 100 + 0.0008 * t * t })), params);
    const down = rotationSeries(Array.from({ length: 150 }, (_, t) => ({ d: `d${t}`, rs: 100 - 0.0008 * t * t })), params);
    expect(quadrant(up.at(-1).ratio, up.at(-1).momentum)).toBe("leading");
    expect(quadrant(down.at(-1).ratio, down.at(-1).momentum)).toBe("lagging");
    expect(rotationSeries(Array.from({ length: 150 }, (_, t) => ({ d: `d${t}`, rs: 100 })), params).at(-1)).toMatchObject({ ratio: 100, momentum: 100 });
    expect(rotationSeries([{ d: "x", rs: 100 }], params)).toEqual([]);
  });

  it("returns sectors with tails from cached candles, background priority only", async () => {
    const { call, marketData } = sectorSetup();
    const r = await call("GET /rotation", "tf=1w&tail=4");
    expect(r.data.count).toBe(SECTORS.length);
    expect(r.data.benchmark).toBe("NSE:NIFTY");
    expect(r.data.method).toMatch(/proxy/);
    for (const it of r.data.items) {
      expect(it.tail).toHaveLength(4);
      expect(["leading", "weakening", "lagging", "improving"]).toContain(it.quadrant);
      expect(it.tail.at(-1).date <= it.asOf).toBe(true);
    }
    expect(historyCalls(marketData)).toHaveLength(SECTORS.length + 1);
    for (const c of historyCalls(marketData)) expect(c[2]).toMatchObject({ priority: "background" });
    const daily = await call("GET /rotation", "tf=1d&tail=0");
    expect(daily.data.items[0].tail).toEqual([]);
    expect(historyCalls(marketData)).toHaveLength(SECTORS.length + 1);
    noNaN(r);
    noNaN(daily);
    await expect(call("GET /rotation", "tf=1m")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /rotation", "tail=13")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("flags a sector with too little history instead of failing", async () => {
    const { call, marketData } = sectorSetup();
    marketData.setCandles("NSE:NIFTYIT", "1d", candles(30, (i) => 1000 + i));
    const r = await call("GET /rotation", "tf=1d");
    expect(r.data.items.find((i) => i.key === "IT")).toBeUndefined();
    expect(r.errors.find((e) => e.symbol === "NSE:NIFTYIT")).toMatchObject({ code: "INSUFFICIENT_HISTORY" });
  });
});

function corrSetup() {
  const s = setup();
  const rets = Array.from({ length: 260 }, (_, i) => Math.sin(i * 0.7) * 0.01 + Math.cos(i * 0.31) * 0.004);
  const series = (k) => {
    let p = 100;
    return rets.map((r) => (p *= Math.exp(k * r)));
  };
  s.marketData.setCandles("NSE:AAA", "1d", candles(260, (i) => series(1)[i]));
  s.marketData.setCandles("NSE:BBB", "1d", candles(260, (i) => series(2)[i]));
  s.marketData.setCandles("NSE:CCC", "1d", candles(260, (i) => series(-1)[i]));
  s.marketData.setCandles("NSE:EEE", "1d", candles(260, () => 100));
  return s;
}

describe("correlation", () => {
  it("builds a Pearson matrix with most and least correlated pairs", async () => {
    const { call, marketData } = corrSetup();
    const r = await call("GET /correlation", "universe=NSE:AAA,bbb,NSE:CCC&days=120");
    expect(r.data.symbols).toEqual(["NSE:AAA", "NSE:BBB", "NSE:CCC"]);
    expect(r.data.matrix[0][1]).toBeCloseTo(1, 3);
    expect(r.data.matrix[0][2]).toBeCloseTo(-1, 3);
    expect(r.data.matrix[1][0]).toBe(r.data.matrix[0][1]);
    expect(r.data.matrix[1][1]).toBe(1);
    expect(r.data.observations).toBe(120);
    expect(r.data.mostCorrelated[0]).toMatchObject({ a: "NSE:AAA", b: "NSE:BBB", observations: 120 });
    expect(r.data.leastCorrelated[0].correlation).toBeCloseTo(-1, 3);
    expect(r.data.mostCorrelated.length).toBeLessThanOrEqual(5);
    expect(historyCalls(marketData)).toHaveLength(3);
    for (const c of historyCalls(marketData)) expect(c[2]).toMatchObject({ priority: "background" });
    noNaN(r);
  });

  it("a flat series gives null, not NaN; failures are listed and excluded", async () => {
    const { call, marketData } = corrSetup();
    marketData.fail("NSE:CCC");
    const r = await call("GET /correlation", "universe=NSE:AAA,NSE:CCC,NSE:EEE,NSE:BBB&days=60&pairs=2");
    expect(r.data.symbols).toEqual(["NSE:AAA", "NSE:EEE", "NSE:BBB"]);
    expect(r.data.matrix[0][1]).toBeNull();
    expect(r.errors.map((e) => e.symbol)).toEqual(["NSE:CCC"]);
    expect(r.data.mostCorrelated).toHaveLength(1);
    noNaN(r);
  });

  it("validates days, symbol count and symbols", async () => {
    const { call } = corrSetup();
    await expect(call("GET /correlation", "days=30")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /correlation", "universe=NSE:AAA")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const many = Array.from({ length: 61 }, (_, i) => `NSE:S${i}`).join(",");
    await expect(call("GET /correlation", `universe=${many}`)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("GET /correlation", "universe=NSE:AAA,NFO:BAD!")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("NIFTY50 stays within the 60-symbol cap", async () => {
    const { call, marketData } = corrSetup();
    await expect(call("GET /correlation", "universe=NIFTY50")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(historyCalls(marketData)).toHaveLength(50);
  }, 20_000);

  it("pearson guards short and constant input", () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeNull();
    const a = Array.from({ length: 30 }, (_, i) => i);
    expect(pearson(a, a.map(() => 1))).toBeNull();
    expect(pearson(a, a)).toBeCloseTo(1, 10);
  });
});
