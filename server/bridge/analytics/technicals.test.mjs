import { describe, expect, it } from "vitest";
import * as kernel from "../../vendor/chartist-core/kernel/index.js";
import { createFakeMarketData } from "../market/fake.mjs";
import { MAX_SYMBOLS, cleanCandles, lastCross, overlayQuote, parseTechnicalSymbols, technicalSummary, technicalsRoutes } from "./technicals.mjs";

// "Today" is Fri 30 Oct 2026, 10:30 IST; the last stored daily bar is Thu 29 Oct.
const NOW = Date.parse("2026-10-30T05:00:00Z");
const LAST_BAR = Date.parse("2026-10-29T00:00:00+05:30") / 1000;

/** n daily bars ending on LAST_BAR, closes from f(i). */
function bars(n, f, vol = () => 1000) {
  return Array.from({ length: n }, (_, i) => {
    const close = f(i);
    return { time: LAST_BAR - (n - 1 - i) * 86_400, open: close * 0.998, high: close * 1.01, low: close * 0.99, close, volume: vol(i) };
  });
}
const noNaN = (v) => expect(JSON.stringify(v)).not.toMatch(/NaN|Infinity|undefined/);

function setup() {
  const clock = { t: NOW, now: () => clock.t };
  const marketData = createFakeMarketData({ clock });
  const deps = { marketData, clock };
  const [[method, path, options, handler]] = technicalsRoutes(deps);
  const call = (query) => handler({ requestId: "r1", query: new URLSearchParams(query), principal: { kind: "local" } });
  return { clock, marketData, call, method, path, options };
}

describe("pure helpers", () => {
  it("cleanCandles keeps one finite bar per IST day, oldest first, with high/low around open and close", () => {
    const out = cleanCandles([
      { time: LAST_BAR, open: 10, high: 9, low: 11, close: 10.5, volume: 5 },
      { time: LAST_BAR - 86_400, open: 9, high: 10, low: 8, close: 9.5 },
      { time: LAST_BAR + 60, close: 10.6, open: 10, high: 10.7, low: 10 },
      { time: LAST_BAR - 2 * 86_400, close: Number.NaN },
      null,
    ]);
    expect(out.map((c) => c.day)).toEqual(["2026-10-28", "2026-10-29"]);
    expect(out[1]).toMatchObject({ close: 10.6, high: 10.7, low: 10 });
    expect(out[0].volume).toBe(0);
  });

  it("overlayQuote updates today's bar, opens a new session when the previous close matches, and ignores a repeat", () => {
    const c = cleanCandles(bars(3, (i) => 100 + i));
    // A quote for the new session (previous close = last bar's close 102).
    const a = overlayQuote(c, { ltp: 105, close: 102, open: 103, high: 106, low: 102.5, volume: 900 }, NOW);
    expect(a.live).toBe(true);
    expect(a.candles).toHaveLength(4);
    expect(a.candles[3]).toMatchObject({ day: "2026-10-30", open: 103, high: 106, low: 102.5, close: 105, volume: 900 });
    // Same day: the last bar follows the quote.
    const b = overlayQuote(a.candles, { ltp: 107, close: 102, high: 107.5, low: 102 }, NOW + 60_000);
    expect(b.candles).toHaveLength(4);
    expect(b.candles[3]).toMatchObject({ close: 107, high: 107.5, low: 102 });
    // A weekend quote that repeats the last close (its previous close is the day before): nothing changes.
    const w = overlayQuote(c, { ltp: 102, close: 101 }, NOW);
    expect(w).toEqual({ candles: c, live: false });
    expect(overlayQuote(c, null, NOW).live).toBe(false);
  });

  it("lastCross finds the most recent cross within the window", () => {
    expect(lastCross([1, 2, 3, 4], [2, 2, 2, 2])).toEqual({ dir: "up", barsAgo: 1 });
    expect(lastCross([3, 3, 1], [2, 2, 2])).toEqual({ dir: "down", barsAgo: 0 });
    expect(lastCross([5, 5, 5, 5, 5], [1, 1, 1, 1, 1])).toBeNull();
    expect(lastCross([1, null, 3], [2, 2, 2])).toBeNull();
  });

  it("parseTechnicalSymbols trims, de-duplicates and caps the list", () => {
    expect(parseTechnicalSymbols(" NSE:A, NSE:B ,NSE:A,")).toEqual(["NSE:A", "NSE:B"]);
    expect(() => parseTechnicalSymbols("")).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    const many = Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => `NSE:S${i}`).join(",");
    expect(() => parseTechnicalSymbols(many)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("technicalSummary", () => {
  it("matches the ChartistScript kernel for every average and oscillator", () => {
    const c = cleanCandles(bars(300, (i) => 100 + 10 * Math.sin(i / 9) + i * 0.1));
    const s = technicalSummary(c);
    const close = c.map((x) => x.close);
    const high = c.map((x) => x.high);
    const low = c.map((x) => x.low);
    const at = (arr) => arr[arr.length - 1];
    expect(s.averages.find((a) => a.key === "ema50").value).toBeCloseTo(at(kernel.calcEMA(close, 50)), 2);
    expect(s.averages.find((a) => a.key === "sma200").value).toBeCloseTo(at(kernel.calcSMA(close, 200)), 2);
    expect(s.rsi14).toBeCloseTo(at(kernel.calcRSI(close, 14)), 2);
    expect(s.macd.hist).toBeCloseTo(at(kernel.calcMACD(close, 12, 26, 9)).hist, 3);
    expect(s.atr14).toBeCloseTo(at(kernel.calcATR(high, low, close, 14)), 2);
    expect(s.adx14.adx).toBeCloseTo(at(kernel.calcADX(high, low, close, 14)).adx, 2);
    expect(s.bollinger.upper).toBeCloseTo(at(kernel.calcBB(close, 20, 2)).upper, 2);
    expect(["up", "down"]).toContain(s.supertrend.direction);
    // Pivots come from the previous session.
    const prev = c[c.length - 2];
    const pp = (prev.high + prev.low + prev.close) / 3;
    expect(s.pivots).toMatchObject({ session: prev.day, pp: Math.round(pp * 100) / 100 });
    expect(s.pivots.r1).toBeCloseTo(2 * pp - prev.low, 2);
    expect(s.pivots.s1).toBeCloseTo(2 * pp - prev.high, 2);
    expect(s.bars).toBe(300);
    noNaN(s);
  });

  it("states facts for a steady rise: above every average, RSI above 70, a new 52-week high", () => {
    const s = technicalSummary(cleanCandles(bars(300, (i) => 100 + i)));
    expect(s.trend).toEqual({ above: 6, of: 6, state: "above-all" });
    expect(s.rsi14).toBeGreaterThan(70);
    const ids = s.facts.map((f) => f.id);
    expect(ids).toContain("rsi-high");
    expect(ids).toContain("high52");
    expect(s.range52w).toMatchObject({ complete: true, sessions: 250 });
    expect(s.range52w.position).toBeGreaterThan(0.95);
    expect(s.returns.d5).toBeCloseTo(((399 - 394) / 394) * 100, 2);
    for (const f of s.facts) expect(f.text).not.toMatch(/\b(buy|sell|signal|support|resistance|bullish|bearish)\b/i);
  });

  it("reports a cross of the 50-day EMA and a volume spike on the last bar", () => {
    // Flat at 100 (each bar 99 to 101), then a jump on the last bar with five times the usual volume.
    const s = technicalSummary(cleanCandles(bars(120, (i) => (i < 119 ? 100 : 112), (i) => (i < 119 ? 1000 : 5000))));
    const ids = s.facts.map((f) => f.id);
    expect(ids).toContain("cross-ema50");
    expect(s.facts.find((f) => f.id === "cross-ema50").text).toBe("Close crossed above the 50-day EMA today");
    expect(ids).toContain("volume");
    expect(s.volume.ratio).toBeCloseTo(5, 1);
    // Fewer than 200 bars: no 200-day averages, and no 52-week claims.
    expect(s.averages.find((a) => a.key === "sma200").value).toBeNull();
    expect(s.trend.of).toBe(4);
    expect(s.range52w.complete).toBe(false);
    expect(ids).not.toContain("high52");
    noNaN(s);
  });

  it("is null with fewer than two bars", () => {
    expect(technicalSummary(cleanCandles(bars(1, () => 100)))).toBeNull();
  });
});

describe("GET /v1/analytics/technicals", () => {
  it("is a read-scope GET", () => {
    const { method, path, options } = setup();
    expect([method, path, options]).toEqual(["GET", "/v1/analytics/technicals", { scope: "read" }]);
  });

  it("reads daily candles once per symbol per day, overlays ONE batched quote call, and reports failures per symbol", async () => {
    const { marketData, call } = setup();
    marketData.setCandles("NSE:AAA", "1d", bars(300, (i) => 100 + i * 0.5));
    marketData.setCandles("NSE:BBB", "1d", bars(300, (i) => 300 - i * 0.5));
    marketData.setQuote("NSE:AAA", { ltp: 252, close: 249.5, open: 250, high: 253, low: 249, volume: 1200 });
    marketData.setQuote("NSE:BBB", { ltp: 149.5, close: 150.5 });
    const r = await call("symbols=NSE:AAA,NSE:BBB,NSE:NOPE");
    expect(r.data.items.map((i) => i.symbol)).toEqual(["NSE:AAA", "NSE:BBB"]);
    expect(r.errors.map((e) => e.symbol)).toEqual(["NSE:NOPE"]);
    const a = r.data.items[0];
    expect(a).toMatchObject({ live: true, asOf: "2026-10-30", price: { ltp: 252, prevClose: 249.5 } });
    expect(r.data.items[1].trend.state).toBe("below-all");
    const quoteCalls = marketData.calls.filter((c) => c[0] === "quotes").length;
    const historyCalls = marketData.calls.filter((c) => c[0] === "history").length;
    expect(quoteCalls).toBe(1);
    expect(historyCalls).toBe(3);
    expect(r.meta.cost).toMatchObject({ quoteCalls: 1, historyCalls: 3 });
    // Again the same day: candles (and the failure) come from the cache; only the quote is read again.
    const again = await call("symbols=NSE:AAA,NSE:BBB,NSE:NOPE");
    expect(marketData.calls.filter((c) => c[0] === "history").length).toBe(3);
    expect(again.meta.cost).toMatchObject({ historyCalls: 0, cacheHits: 3, quoteCalls: 1 });
    noNaN(r);
  });

  it("answers the first error when no symbol could be read, and validates symbols", async () => {
    const { call } = setup();
    await expect(call("symbols=NSE:NOPE")).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
    await expect(call("")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
