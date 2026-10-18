/**
 * Unit tests for S5's pure helpers: IST time parsing, the freshness cache, the micro-batcher, normalisers, history
 * planning/aggregation/CSV, option-chain building and the `market` config schema.
 */
import { describe, expect, it } from "vitest";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createBatcher } from "./batcher.mjs";
import { atmStrike, defaultOptionExchange, finishLeg, rowsFromBrokerChain, rowsFromQuotes, trimStrikes } from "./chain.mjs";
import { FRESHNESS_MAX, parseMarketConfig } from "./config.mjs";
import { createFreshnessCache } from "./freshnessCache.mjs";
import { aggregate, countbackRange, historyCsvRows, planChunks, planInterval } from "./history.mjs";
import { chainLegFields, depthFields, freshness, mergeCandles, normaliseCandles, quoteFields, tickHasQuote } from "./normalise.mjs";
import { istDate, istWeekStart, parseTimeInput, toIstIso } from "./time.mjs";
import { defaultChain } from "./__fixtures__/helpers.mjs";

const ist = (s) => Date.parse(`${s}+05:30`);

describe("time", () => {
  it("formats IST", () => {
    expect(toIstIso(Date.UTC(2026, 9, 19, 4, 0, 0))).toBe("2026-10-19T09:30:00.000+05:30");
    expect(istDate(Date.UTC(2026, 9, 18, 19, 0, 0))).toBe("2026-10-19"); // 00:30 IST next day
    expect(istWeekStart(ist("2026-10-22T13:00:00"))).toBe(ist("2026-10-19T00:00:00"));
  });

  it("parses dates, date-times and epoch seconds", () => {
    expect(parseTimeInput("2026-10-19")).toBe(ist("2026-10-19T00:00:00"));
    expect(parseTimeInput("2026-10-19", { endOfDay: true })).toBe(ist("2026-10-19T23:59:59"));
    expect(parseTimeInput("2026-10-19T09:15")).toBe(ist("2026-10-19T09:15:00"));
    expect(parseTimeInput("2026-10-19 09:15:30")).toBe(ist("2026-10-19T09:15:30"));
    expect(parseTimeInput("2026-10-19T03:45:00Z")).toBe(ist("2026-10-19T09:15:00"));
    expect(parseTimeInput("2026-10-19T09:15:00+05:30")).toBe(ist("2026-10-19T09:15:00"));
    expect(parseTimeInput("1760845500")).toBe(1760845500000);
    expect(parseTimeInput(1760845500)).toBe(1760845500000);
  });

  it("rejects nonsense", () => {
    for (const bad of ["", "yesterday", "2026-02-31", "2026-10-19T25:00", "12345", "2026-10-19T09:15+99:00"]) {
      expect(() => parseTimeInput(bad, { field: "from" })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });
});

describe("freshness cache", () => {
  it("serves within the target, keeps newer values, evicts oldest", async () => {
    const clock = createManualClock(0);
    const c = createFreshnessCache({ maxEntries: 2, now: clock.now });
    c.set("a", 1, { accountId: "x", broker: "b" });
    await clock.advance(500);
    expect(c.get("a", 1000)).toMatchObject({ value: 1, at: 0, accountId: "x" });
    expect(c.get("a", 400)).toBeNull();
    expect(c.get("a", 0)).toBeNull();
    expect(c.getStale("a", 600)).toMatchObject({ value: 1 });
    c.set("a", 0, { at: -10 }); // older value never replaces newer
    expect(c.peek("a").value).toBe(1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.size).toBe(2);
    expect(c.peek("a")).toBeNull();
  });
});

describe("batcher", () => {
  it("merges a window into one run per group and delivers per-item results", async () => {
    const clock = createManualClock(0);
    const runs = [];
    const b = createBatcher({
      windowMs: 25,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
      run: async (group, ids) => {
        runs.push([group, [...ids]]);
        return new Map(ids.filter((i) => i !== "bad").map((i) => [i, { value: `${group}:${i}` }]).concat([["bad", { error: new Error("nope") }]]));
      },
    });
    const p1 = b.add("g1", "x");
    const p2 = b.add("g1", "x");
    const p3 = b.add("g1", "y");
    const p4 = b.add("g2", "x");
    const p5 = b.add("g1", "bad").then(() => null, (e) => e);
    await clock.advance(25);
    expect(await Promise.all([p1, p2, p3, p4])).toEqual(["g1:x", "g1:x", "g1:y", "g2:x"]);
    expect((await p5).message).toBe("nope");
    expect(runs).toEqual([["g1", ["x", "y", "bad"]], ["g2", ["x"]]]);
  });

  it("flushes early at maxSize and rejects everything when run throws or omits an id", async () => {
    const clock = createManualClock(0);
    let calls = 0;
    const b = createBatcher({ windowMs: 1000, maxSize: 2, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, run: async () => { calls += 1; throw new Error("down"); } });
    const ps = [b.add("g", "a"), b.add("g", "b")].map((p) => p.then(() => null, (e) => e));
    await clock.flush();
    expect(calls).toBe(1);
    for (const p of ps) expect((await p).message).toBe("down");
    const b2 = createBatcher({ windowMs: 1, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, run: async () => new Map(), missingError: (id) => new Error(`missing ${id}`) });
    const q = b2.add("g", "z").then(() => null, (e) => e);
    await clock.advance(1);
    expect((await q).message).toBe("missing z");
  });
});

describe("normalise", () => {
  it("builds Freshness", () => {
    const f = freshness({ source: "cache", at: 1000, now: 3500, targetMs: 2000, accountId: "a", broker: "b" });
    expect(f).toEqual({ source: "cache", asOf: toIstIso(1000), ageMs: 2500, stale: true, accountId: "a", broker: "b" });
    expect(freshness({ source: "stream", at: 0, now: 9000, targetMs: 1, stale: false }).stale).toBe(false);
  });

  it("normalises quotes with nulls for missing fields", () => {
    expect(quoteFields({ token: "1", exchange: "NSE", ltp: "101.5", close: 100, open: 0, volume: "5", bid: null })).toEqual({
      ltp: 101.5, open: null, high: null, low: null, close: 100, change: 1.5, changePct: 1.5, volume: 5, oi: null, bid: null, ask: null, bidQty: null, askQty: null,
    });
    expect(quoteFields({ ltp: 0 })).toBeNull();
    expect(quoteFields(null)).toBeNull();
    expect(tickHasQuote({ ltp: 1 })).toBe(false);
    expect(tickHasQuote({ ltp: 1, bid: 0.9 })).toBe(true);
  });

  it("sorts depth best first and drops malformed levels", () => {
    expect(depthFields({ bids: [{ price: 1, qty: 1 }, { price: 2, qty: 3, orders: 2.7 }, { price: "x", qty: 1 }], asks: [{ price: 4, qty: 1 }, { price: 3, quantity: 2 }] })).toEqual({
      bids: [{ price: 2, qty: 3, orders: 2 }, { price: 1, qty: 1, orders: null }],
      asks: [{ price: 3, qty: 2, orders: null }, { price: 4, qty: 1, orders: null }],
    });
  });

  it("normalises and merges candles", () => {
    const a = normaliseCandles([{ time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5 }, { time: 1_700_000_060, open: "x" }]);
    expect(a).toEqual([{ time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }]);
    const merged = mergeCandles([[{ time: 2, close: 1 }, { time: 1, close: 1 }], [{ time: 2, close: 9 }]]);
    expect(merged).toEqual([{ time: 1, close: 1 }, { time: 2, close: 9 }]);
  });

  it("reads Dhan-shaped chain legs", () => {
    expect(chainLegFields({ last_price: 10, oi: 100, previous_oi: 80, volume: 5, implied_volatility: 14.2, greeks: { delta: 0.4, gamma: 0.01, theta: -2, vega: 3 }, top_bid_price: 9.9, top_ask_price: 10.1 })).toEqual({
      ltp: 10, bid: 9.9, ask: 10.1, oi: 100, oiChange: 20, volume: 5, iv: 14.2, delta: 0.4, gamma: 0.01, theta: -2, vega: 3,
    });
    expect(chainLegFields({ ltp: 0, iv: 0 })).toMatchObject({ ltp: null, iv: null, oiChange: null, delta: null });
    expect(chainLegFields(undefined)).toBeNull();
  });
});

describe("history planning", () => {
  it("maps intervals onto what the broker offers", () => {
    expect(planInterval("5m", ["1m", "5m"])).toEqual({ base: "5m", factor: 1, aggregate: "none" });
    expect(planInterval("10m", ["1m", "5m", "15m"])).toEqual({ base: "5m", factor: 2, aggregate: "intraday" });
    expect(planInterval("30m", ["1m"])).toEqual({ base: "1m", factor: 30, aggregate: "intraday" });
    expect(planInterval("1w", undefined)).toEqual({ base: "1d", factor: 1, aggregate: "week" });
    expect(planInterval("1M", ["1d"])).toEqual({ base: "1d", factor: 1, aggregate: "month" });
    expect(() => planInterval("1d", ["1m"])).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(() => planInterval("10m", ["3m"])).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(() => planInterval("2m", undefined)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("chunks ranges by whole IST days, newest first", () => {
    const chunks = planChunks({ fromMs: ist("2026-10-01T09:15:00"), toMs: ist("2026-10-10T15:30:00"), spanDays: 4, daily: false });
    expect(chunks.map((c) => [c.from, c.to])).toEqual([
      ["2026-10-07 00:00", "2026-10-10 15:30"],
      ["2026-10-03 00:00", "2026-10-06 23:59"],
      ["2026-10-01 09:15", "2026-10-02 23:59"],
    ]);
    const d = planChunks({ fromMs: ist("2026-01-01T00:00:00"), toMs: ist("2026-10-10T00:00:00"), spanDays: 2000, daily: true });
    expect(d).toEqual([{ fromMs: ist("2026-01-01T00:00:00"), toMs: ist("2026-10-10T00:00:00"), from: "2026-01-01", to: "2026-10-10" }]);
    expect(planChunks({ fromMs: 10, toMs: 5, spanDays: 1, daily: true })).toEqual([]);
  });

  it("aggregates intraday bars aligned to the session open, and weeks from Monday", () => {
    const t = (s) => ist(s) / 1000;
    const bars = ["09:15", "09:20", "09:25", "09:30"].map((hm, i) => ({ time: t(`2026-10-19T${hm}:00`), open: 10 + i, high: 20 + i, low: 5 - i, close: 11 + i, volume: 1, oi: i }));
    const ten = aggregate(bars, { aggregate: "intraday" }, "10m", "NSE");
    expect(ten).toEqual([
      { time: t("2026-10-19T09:15:00"), open: 10, high: 21, low: 4, close: 12, volume: 2, oi: 1 },
      { time: t("2026-10-19T09:25:00"), open: 12, high: 23, low: 2, close: 14, volume: 2, oi: 3 },
    ]);
    const mcx = aggregate([{ time: t("2026-10-19T09:05:00"), open: 1, high: 1, low: 1, close: 1, volume: 1 }], { aggregate: "intraday" }, "15m", "MCX");
    expect(mcx[0].time).toBe(t("2026-10-19T09:00:00"));
    const days = ["2026-10-16", "2026-10-19", "2026-10-20"].map((d) => ({ time: t(`${d}T00:00:00`), open: 1, high: 2, low: 1, close: 2, volume: 10 }));
    expect(aggregate(days, { aggregate: "week" }, "1w").map((c) => [c.time, c.volume])).toEqual([[t("2026-10-16T00:00:00"), 10], [t("2026-10-19T00:00:00"), 20]]);
    expect(aggregate(days, { aggregate: "month" }, "1M")).toHaveLength(1);
    expect(aggregate(days, { aggregate: "none" }, "1d")).toBe(days);
  });

  it("estimates a countback range with room for holidays", () => {
    const to = ist("2026-10-19T15:30:00");
    expect(countbackRange({ toMs: to, countback: 75, interval: "5m" })).toBeLessThanOrEqual(ist("2026-10-18T00:00:00"));
    expect(countbackRange({ toMs: to, countback: 10, interval: "1d" })).toBeLessThanOrEqual(ist("2026-10-05T00:00:00"));
  });

  it("writes CSV rows with IST times", () => {
    const t = ist("2026-10-19T09:15:00") / 1000;
    expect(historyCsvRows({ interval: "5m", candles: [{ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 }] })).toEqual([
      ["time", "open", "high", "low", "close", "volume", "oi"],
      ["2026-10-19 09:15:00", 1, 2, 0.5, 1.5, 7, ""],
    ]);
    expect(historyCsvRows({ interval: "1d", candles: [{ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, oi: 3 }] })[1][0]).toBe("2026-10-19");
  });
});

describe("option chain helpers", () => {
  const now = ist("2026-10-19T10:00:00");

  it("picks ATM, trims and chooses the default exchange", () => {
    expect(atmStrike([100, 200, 300], 240)).toBe(200);
    expect(atmStrike([100, 200], 150)).toBe(100);
    expect(atmStrike([], 150)).toBeNull();
    const rows = [1, 2, 3, 4, 5].map((strike) => ({ strike }));
    expect(trimStrikes(rows, 1, 1).map((r) => r.strike)).toEqual([1, 2]);
    expect(trimStrikes(rows, 3, undefined)).toBe(rows);
    expect(defaultOptionExchange("SENSEX")).toBe("BFO");
    expect(defaultOptionExchange("NIFTY")).toBe("NFO");
  });

  it("builds rows from a broker chain with greeks sources", () => {
    const r = rowsFromBrokerChain(defaultChain(), { underlying: "NIFTY", expiry: "2026-10-27", exchange: "NFO", declared: "broker", greeks: true, nowMs: now, rate: 0.065 });
    expect(r.underlyingLtp).toBe(25012.5);
    expect(r.atmStrike).toBe(25000);
    expect(r.rows[2].ce).toMatchObject({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", greeksSource: "broker" });
    expect(r.rows[2].pe).toMatchObject({ symbol: "NFO:NIFTY-2026-10-27-25000-PE", greeksSource: "computed" });
    const computedByBroker = rowsFromBrokerChain(defaultChain(), { underlying: "NIFTY", expiry: "2026-10-27", exchange: "NFO", declared: "computed", greeks: true, nowMs: now, rate: 0.065 });
    expect(computedByBroker.rows[2].ce.greeksSource).toBe("computed");
  });

  it("leaves greeks null when they cannot be computed", () => {
    const leg = finishLeg({ ltp: null, bid: null, ask: null, oi: null, oiChange: null, volume: null, iv: null, delta: null, gamma: null, theta: null, vega: null }, { symbol: "X", declared: null, greeks: true, spot: 100, strike: 100, expiry: "2026-10-27", right: "CE", nowMs: now, rate: 0.065 });
    expect(leg).toMatchObject({ symbol: "X", iv: null, delta: null, greeksSource: null });
    expect(finishLeg(null, {})).toBeNull();
  });

  it("builds rows from quotes", () => {
    const legs = [
      { canonical: "NFO:NIFTY-2026-10-27-25000-CE", strike: 25000, right: "CE" },
      { canonical: "NFO:NIFTY-2026-10-27-25000-PE", strike: 25000, right: "PE" },
      { canonical: "NFO:NIFTY-2026-10-27-25100-CE", strike: 25100, right: "CE" },
    ];
    const quotes = new Map([["NFO:NIFTY-2026-10-27-25000-CE", { ltp: 150, bid: 149, ask: 151, oi: 10, volume: 2 }]]);
    const r = rowsFromQuotes(legs, quotes, { spot: 25010, expiry: "2026-10-27", greeks: true, nowMs: now, rate: 0.065 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].ce).toMatchObject({ ltp: 150, greeksSource: "computed" });
    expect(r.rows[0].ce.iv).toBeGreaterThan(0);
    expect(r.rows[0].pe).toBeNull();
    expect(r.atmStrike).toBe(25000);
  });
});

describe("market config", () => {
  it("defaults, tightening and loosening limits", () => {
    const d = parseMarketConfig({});
    expect(d.freshness).toEqual({ ltpMs: 1000, quoteMs: 2000, depthMs: 1000, chainMs: 3000, expiriesMs: 300_000, historyMs: 60_000 });
    expect(d.batch.windowMs).toBe(25);
    expect(parseMarketConfig({ freshness: { ltpMs: 200 } }).freshness.ltpMs).toBe(200);
    expect(parseMarketConfig({ freshness: { ltpMs: FRESHNESS_MAX.ltpMs } }).freshness.ltpMs).toBe(5000);
    expect(() => parseMarketConfig({ freshness: { ltpMs: FRESHNESS_MAX.ltpMs + 1 } })).toThrow();
    expect(() => parseMarketConfig({ unknown: true })).toThrow();
    expect(() => parseMarketConfig({ history: { brokers: { dhan: { intraday: 9999 } } } })).toThrow();
    expect(parseMarketConfig({ history: { brokers: { dhan: { intraday: 90 } } } }).history.brokers.dhan.intraday).toBe(90);
  });
});
