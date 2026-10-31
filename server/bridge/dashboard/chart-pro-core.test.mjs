// The chart tools' pure maths (chart-pro-core.js): intervals and ranges, the viewport, price scales, chart types,
// browser studies, drawing geometry, R:R and hit-testing.
import { describe, expect, it } from "vitest";
import * as P from "./chart-pro-core.js";
import { layoutPanes, layoutX, buildModel, linePath, ohlcPaths } from "./chart-lite-core.js";

const IST = 330 * 60_000;
/** Epoch ms of an IST wall time. */
const ist = (y, mo, d, hh = 0, mm = 0) => Date.UTC(y, mo - 1, d, hh, mm) - IST;
const bar = (t, o, h, l, c, v = 100) => ({ t, open: o, high: h, low: l, close: c, volume: v });
/** n 5-minute bars a session from 09:15 IST, closes rising by 1 from `start`. */
function session(day, n, start = 100) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const c = start + k;
    out.push(bar(ist(2026, 10, day, 9, 15 + 5 * k), c - 0.5, c + 1, c - 1, c));
  }
  return out;
}
const close = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("intervals and quick ranges", () => {
  it("lists the Bridge's intervals and names them", () => {
    expect(P.INTERVALS.map((x) => x.id)).toEqual(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w", "1M"]);
    expect(P.intervalInfo("60m").label).toBe("1h");
    expect(P.isDailyInterval("1d")).toBe(true);
    expect(P.isDailyInterval("15m")).toBe(false);
    expect(P.barsPerSession("5m")).toBe(75);
    expect(P.barsPerSession("1d")).toBe(1);
  });
  it("asks history for a range's span plus warm-up, capped at 5000", () => {
    expect(P.historyParams({ range: "1D" })).toEqual({ interval: "1m", countback: 375 + P.WARM_BARS });
    expect(P.historyParams({ range: "5D" })).toEqual({ interval: "5m", countback: 375 + P.WARM_BARS });
    expect(P.historyParams({ range: "1Y" }).interval).toBe("1d");
    expect(P.historyParams({ range: "5Y" }).interval).toBe("1w");
    expect(P.historyParams({ interval: "15m" })).toEqual({ interval: "15m", countback: 600 });
    expect(P.historyParams({ interval: "bogus" }).interval).toBe("5m");
    for (const r of P.RANGES) expect(P.historyParams({ range: r.id }).countback).toBeLessThanOrEqual(5000);
  });
  it("starts a day range at the n-th last session and a month range on the same calendar day", () => {
    const t = [...session(27, 3), ...session(28, 3), ...session(29, 3)].map((c) => c.t);
    expect(P.rangeStart(t, "1D")).toBe(6);
    expect(P.rangeStart(t, "5D")).toBe(0);
    const days = [];
    for (let d = 1; d <= 31; d++) days.push(ist(2026, 9, d, 9, 15));
    for (let d = 1; d <= 30; d++) days.push(ist(2026, 10, d, 9, 15));
    expect(P.rangeStart(days, "1M")).toBe(29); // 30 Sep, the same day a month before 30 Oct
  });
  it("guesses an interval from bar spacing", () => {
    expect(P.guessInterval(session(29, 10).map((c) => c.t))).toBe("5m");
    expect(P.guessInterval([0, 86_400_000, 2 * 86_400_000])).toBe("1d");
    expect(P.guessInterval([0])).toBe(null);
  });
});

describe("viewport", () => {
  it("opens on the last bars", () => {
    expect(P.initialView(500, 100)).toEqual({ from: 400, to: 499 });
    expect(P.initialView(50, 100)).toEqual({ from: 0, to: 49 });
  });
  it("zooms around the anchor, keeping it in place", () => {
    const v = P.zoomView({ from: 100, to: 199 }, 0.5, 150, 1000);
    expect(v.to - v.from).toBeCloseTo(49.5, 6);
    // 150 was 50 / 99 of the way across; it still is.
    expect((150 - v.from) / (v.to - v.from)).toBeCloseTo(50 / 99, 6);
  });
  it("never zooms below the minimum or beyond twice the data, and pans within half a screen of the ends", () => {
    const tight = P.zoomView({ from: 100, to: 110 }, 0.01, 105, 1000);
    expect(tight.to - tight.from).toBe(7);
    const wide = P.zoomView({ from: 0, to: 99 }, 100, 50, 100);
    expect(wide.to - wide.from).toBe(198);
    const right = P.panView({ from: 50, to: 99 }, 1000, 100);
    expect(right.to).toBeCloseTo(99 + 24.5, 6);
    const left = P.panView({ from: 50, to: 99 }, -1000, 100);
    expect(left.from).toBeCloseTo(-24.5, 6);
  });
  it("lists the whole bars in a fractional view", () => {
    expect(P.visibleRange({ from: 10.2, to: 20.7 }, 100)).toEqual([10, 21]);
    expect(P.visibleRange({ from: -5, to: 120 }, 100)).toEqual([0, 99]);
  });
  it("maps time to bar index and back, past either end too", () => {
    const t = [0, 10, 20, 40];
    expect(P.indexOfTime(t, 20)).toBe(2);
    expect(P.indexOfTime(t, 30)).toBe(2.5);
    expect(P.indexOfTime(t, 80)).toBe(5);
    expect(P.indexOfTime(t, -5)).toBe(-0.5);
    for (const i of [-1, 0.25, 2.5, 4.5]) close(P.indexOfTime(t, P.timeOfIndex(t, i)), i);
    expect(P.nearestIndex(t, 31)).toBe(3);
    expect(P.nearestIndex(t, 1000)).toBe(-1);
  });
});

describe("price scales", () => {
  it("linear maps the domain to the pane and back", () => {
    const s = P.priceScale("linear", 100, 200, 0, 100);
    expect(s.yOf(150)).toBe(50);
    close(s.vOf(25), 175);
  });
  it("log spaces equal ratios equally", () => {
    const s = P.priceScale("log", 100, 400, 0, 100);
    close(s.yOf(200), 50);
    close(s.vOf(50), 200, 1e-9);
    expect(s.ticks.every((v) => v > 100 && v < 400)).toBe(true);
    expect(s.ticks.length).toBeGreaterThan(1);
  });
  it("percent puts its ticks on round percents from the base", () => {
    const s = P.priceScale("percent", 95, 110, 0, 100, 100, 5);
    const pct = s.ticks.map((v) => Math.round(P.pctFrom(v, 100) * 1000) / 1000);
    expect(pct.every((p) => Math.abs(p / s.pctStep - Math.round(p / s.pctStep)) < 1e-9)).toBe(true);
    expect(pct).toContain(0);
  });
  it("lays a pane out on the chosen scale and gives the inverse", () => {
    const m = buildModel({ series: [{ type: "candles", data: [bar(1, 100, 110, 90, 105), bar(2, 105, 400, 100, 380)] }] });
    const [pane] = layoutPanes(m, 300, { scale: { pane: "main", mode: "log" } });
    expect(pane.scaleMode).toBe("log");
    close(pane.vOf(pane.yOf(200)), 200, 1e-6);
    const [lin] = layoutPanes(m, 300, { range: [0, 0] });
    expect(lin.hi).toBeLessThan(120); // only the first bar sets the domain
  });
  it("lays x out over a view", () => {
    const m = buildModel({ series: [{ type: "line", data: Array.from({ length: 100 }, (_, i) => ({ t: i, v: i })) }] });
    const X = layoutX(m, 1008, 0, { from: 50, to: 99 });
    expect(X.slot).toBe(20);
    expect(X.xOf(50)).toBe(8 + 10);
    expect(X.indexAt(X.xOf(70) + 4)).toBe(70);
    close(X.iOf(X.xOf(63.5)), 63.5);
  });
});

describe("chart types", () => {
  it("Heikin Ashi averages the bar and opens at the last body's middle", () => {
    const ha = P.heikinAshi([bar(1, 10, 12, 9, 11), bar(2, 11, 14, 10, 13)]);
    expect(ha[0].close).toBe((10 + 12 + 9 + 11) / 4);
    expect(ha[0].open).toBe(10.5);
    expect(ha[1].open).toBe((ha[0].open + ha[0].close) / 2);
    expect(ha[1].close).toBe(12);
    expect(ha[1].high).toBe(14);
    expect(ha[1].low).toBe(Math.min(10, ha[1].open, ha[1].close));
  });
  it("Renko lays a brick per box and needs two boxes to turn", () => {
    const c = [100, 101, 103, 104.5, 103, 101.9, 101].map((v, i) => bar(i * 1000, v, v, v, v));
    const b = P.renko(c, 1);
    expect(b.map((x) => [x.open, x.close])).toEqual([[100, 101], [101, 102], [102, 103], [103, 104], [103, 102], [102, 101]]);
    // Bricks completed by one candle keep distinct, rising times.
    expect(b[1].t).toBeLessThan(b[2].t);
    expect(P.renko(c, 0)).toEqual([]);
  });
  it("maps the chart types to what the engine draws", () => {
    const c = [bar(1, 1, 2, 0, 1.5)];
    expect(P.typedCandles(c, "hollow").style).toBe("hollow");
    expect(P.typedCandles(c, "bars").style).toBe("ohlc");
    expect(P.typedCandles(c, "line").line).toBe("line");
    expect(P.typedCandles(c, "area").line).toBe("area");
    expect(P.typedCandles(c, "ha").data[0].close).toBe(1.125);
  });
  it("draws OHLC bars as two crisp paths", () => {
    const p = ohlcPaths([{ center: 0, open: 1, high: 3, low: 0, close: 2, up: true }], (i) => 10 + i, (v) => 100 - v * 10, 9, 1);
    expect(p.up).toMatch(/^M10\.5 70V100M/);
    expect(p.down).toBe("");
  });
  it("breaks a line where a point is marked as a gap", () => {
    expect(linePath([{ i: 0, v: 1 }, { i: 1, v: 1 }, { i: 2, v: 2, gap: true }, { i: 3, v: 2 }], (i) => i, (v) => v)).toBe("M0 1L1 1M2 2L3 2");
  });
});

describe("browser studies", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it("moving averages", () => {
    expect(P.sma(x, 3).slice(2, 4)).toEqual([2, 3]);
    expect(Number.isNaN(P.sma(x, 3)[1])).toBe(true);
    const e = P.ema(x, 3);
    expect(e[2]).toBe(2); // seeded by the SMA
    expect(e[3]).toBe(0.5 * 4 + 0.5 * 2);
    expect(P.wma([1, 2, 3], 3)[2]).toBeCloseTo((1 + 4 + 9) / 6, 10);
    expect(P.rma(x, 2)[2]).toBe(0.5 * 3 + 0.5 * 1.5);
  });
  it("RSI is 100 on a rising series and 50 on an even zigzag", () => {
    expect(P.rsi(x, 3)[9]).toBe(100);
    const z = Array.from({ length: 40 }, (_, i) => (i % 2 ? 11 : 10));
    expect(P.rsi(z, 14)[39]).toBeGreaterThan(40);
    expect(P.rsi(z, 14)[39]).toBeLessThan(60);
  });
  it("MACD's histogram is the line less its signal", () => {
    const m = P.macd(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5), 12, 26, 9);
    expect(m.hist[59]).toBeCloseTo(m.macd[59] - m.signal[59], 10);
  });
  it("Bollinger bands sit k deviations either side of the mean", () => {
    const b = P.bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(b.basis[7]).toBe(5);
    expect(b.upper[7]).toBe(9);
    expect(b.lower[7]).toBe(1);
  });
  it("session VWAP resets each day and weights by volume", () => {
    const c = [bar(ist(2026, 10, 28, 9, 15), 10, 10, 10, 10, 1), bar(ist(2026, 10, 28, 9, 20), 20, 20, 20, 20, 3), bar(ist(2026, 10, 29, 9, 15), 50, 50, 50, 50, 2)];
    const v = P.sessionVwap(c);
    expect(v[1]).toBe(17.5);
    expect(v[2]).toBe(50);
  });
  it("floor pivots and CPR from one session", () => {
    const L = P.pivotLevels(110, 90, 105);
    close(L.p, 101.666666667, 1e-6);
    expect(L.bc).toBe(100);
    close(L.tc, 103.333333333, 1e-6);
    close(L.r1, 113.333333333, 1e-6);
    close(L.s1, 93.333333333, 1e-6);
    expect(L.tc).toBeGreaterThanOrEqual(L.bc);
  });
  it("intraday CPR reads the previous session and breaks between sessions", () => {
    const c = [...session(28, 3, 100), ...session(29, 3, 200)];
    const r = P.cprSeries(c);
    expect(Number.isNaN(r.p[0])).toBe(true);
    close(r.p[3], (103 + 99 + 102) / 3);
    expect(r.gap[3]).toBe(true);
    expect(r.p[4]).toBe(r.p[3]);
  });
  it("the opening range holds the first minutes' extremes from the end of the window", () => {
    const c = session(29, 6, 100); // 5-minute bars: the first three make a 15-minute range
    const o = P.openingRange(c, 15, 5);
    expect(Number.isNaN(o.high[2])).toBe(true);
    expect(o.high[3]).toBe(103);
    expect(o.low[5]).toBe(99);
    expect(o.gap[3]).toBe(true);
  });
  it("Supertrend flips with a break of its band and colours each side", () => {
    const up = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const down = Array.from({ length: 30 }, (_, i) => bar(30 + i, 130 - 3 * i, 131 - 3 * i, 127 - 3 * i, 128 - 3 * i));
    const s = P.supertrend([...up, ...down], 10, 3);
    expect(s.dir[25]).toBe(1);
    expect(s.dir[59]).toBe(-1);
    expect(s.line[25]).toBeLessThan(up[25].low);
    const r = P.runLocalStudy("supertrend", [...up, ...down], {});
    expect(r.outputs.map((o) => o.tone)).toEqual(["pos", "neg"]);
  });
  it("says why a study draws nothing", () => {
    const noVol = session(29, 30).map((c) => ({ ...c, volume: 0 }));
    expect(P.runLocalStudy("vwap", noVol).note).toMatch(/volume/i);
    expect(P.runLocalStudy("orb", session(29, 30), {}, { daily: true }).note).toMatch(/Intraday/);
    expect(P.runLocalStudy("nope", session(29, 3)).outputs).toEqual([]);
  });
  it("checks settings against their ranges", () => {
    const defs = P.localStudy("ema").params;
    expect(P.studyParams(defs, { length: 50 })).toEqual({ length: 50, src: "close" });
    expect(P.studyParams(defs, { length: 0, src: "bad" })).toEqual({ length: 20, src: "close" });
    expect(P.studyTitle("bb", { length: 20, multiplier: 2 }, P.localStudy("bb").params)).toBe("BB 20 2");
  });
  it("covers the studies traders reach for, each in a category", () => {
    for (const id of ["vwap", "cpr", "supertrend", "orb", "ema", "sma", "rsi", "macd", "bb", "volume"]) expect(P.localStudy(id), id).toBeTruthy();
    for (const s of P.LOCAL_STUDIES) expect(P.STUDY_CATEGORIES).toContain(s.cat);
    expect(P.studyCategory("ichimoku")).toBe("Trend");
    expect(P.studyCategory("unknown_thing")).toBe("More");
    const c = session(29, 60);
    for (const s of P.LOCAL_STUDIES) expect(P.runLocalStudy(s.id, c).outputs.length, s.id).toBeGreaterThan(0);
  });
});

describe("drawings", () => {
  it("Fibonacci levels run from the end back to the start", () => {
    const l = P.fibLevels(100, 200);
    expect(l[0]).toEqual({ r: 0, price: 200 });
    expect(l.find((x) => x.r === 0.5).price).toBe(150);
    close(l.find((x) => x.r === 0.618).price, 138.2);
    expect(l[l.length - 1].price).toBe(100);
  });
  it("a channel's offset passes the parallel through the third point", () => {
    expect(P.channelOffset({ i: 0, p: 10 }, { i: 10, p: 20 }, { i: 5, p: 25 })).toBe(10);
  });
  it("long and short positions: reward, risk, R:R and P&L", () => {
    const L = P.positionMath({ side: "long", entry: 100, target: 110, stop: 95, qty: 50 });
    expect([L.reward, L.risk, L.rr, L.pnlTarget, L.pnlStop, L.valid]).toEqual([10, 5, 2, 500, -250, true]);
    const S = P.positionMath({ side: "short", entry: 100, target: 85, stop: 105 });
    expect([S.reward, S.risk, S.rr, S.pctTarget]).toEqual([15, 5, 3, 15]);
    expect(P.positionMath({ side: "long", entry: 100, target: 90, stop: 95 }).valid).toBe(false);
    const d = P.positionDefaults("short", 100, 50);
    expect(d.target).toBeLessThan(100);
    expect(d.stop).toBeGreaterThan(100);
    expect(P.positionMath({ side: "short", entry: 100, ...d }).rr).toBeCloseTo(2, 10);
  });
  it("measures change, percent and bars", () => {
    expect(P.measureMath({ i: 2, p: 200 }, { i: 12, p: 210 })).toEqual({ change: 10, pct: 5, bars: 10 });
  });
  it("hit-tests segments, rays, horizontal lines, rectangles and handles", () => {
    const X = (i) => i * 10;
    const Y = (p) => 200 - p;
    expect(P.segDist(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(P.segDist(15, 0, 0, 0, 10, 0)).toBe(5);
    const ds = [
      { id: "a", type: "trend", pts: [{ i: 0, p: 100 }, { i: 10, p: 100 }] },
      { id: "b", type: "hline", pts: [{ i: 3, p: 50 }] },
      { id: "c", type: "rect", pts: [{ i: 20, p: 20 }, { i: 30, p: 0 }] },
      { id: "d", type: "ray", pts: [{ i: 0, p: -50 }, { i: 1, p: -50 }] },
    ];
    expect(P.hitTest(ds, 50, 101, X, Y, 1000)).toEqual({ id: "a", handle: -1 });
    expect(P.hitTest(ds, 100, 101, X, Y, 1000)).toEqual({ id: "a", handle: 1 });
    expect(P.hitTest(ds, 900, 152, X, Y, 1000)).toEqual({ id: "b", handle: -1 });
    expect(P.hitTest(ds, 250, 190, X, Y, 1000)).toEqual({ id: "c", handle: -1 });
    expect(P.hitTest(ds, 800, 252, X, Y, 1000)).toEqual({ id: "d", handle: -1 });
    expect(P.hitTest(ds, 600, 20, X, Y, 1000)).toBe(null);
  });
  it("the position tool hits on both zones", () => {
    const d = { id: "p", type: "long", pts: [{ i: 0, p: 100 }, { i: 10, p: 100 }, { i: 0, p: 110 }, { i: 0, p: 95 }] };
    const sh = P.drawingShapes(d, (i) => i * 10, (p) => 200 - p, 1000);
    expect(sh).toHaveLength(2);
    expect(P.hitTest([d], 50, 95, (i) => i * 10, (p) => 200 - p, 1000)?.id).toBe("p");
  });
  it("the magnet snaps to the nearest O/H/L/C within reach", () => {
    const Y = (p) => 200 - p;
    expect(P.magnet(103.5, bar(0, 100, 104, 98, 102), Y, 2)).toBe(104);
    expect(P.magnet(110, bar(0, 100, 104, 98, 102), Y, 2)).toBe(110);
  });
  it("keeps only well-formed drawings from storage", () => {
    const raw = JSON.stringify([{ id: "x", type: "trend", pts: [{ t: 1, p: 2 }, { t: 3, p: 4 }] }, { type: "evil", pts: [] }, { id: "m", type: "measure", pts: [{ t: 1, p: 1 }] }, { id: "y", type: "hline", pts: [{ t: "x", p: 1 }] }]);
    expect(P.cleanDrawings(raw).map((d) => d.id)).toEqual(["x"]);
    expect(P.cleanDrawings("not json")).toEqual([]);
  });
});
