import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRIEF_LEVEL_NAMES,
  CHANGE_FLOORS,
  INDEX_SYMBOL,
  TREND_RULE,
  breadthFact,
  briefLevels,
  changeSentences,
  classicPivots,
  ema,
  istDateOf,
  istHm,
  ivRange,
  macd,
  macdFact,
  mergeLevels,
  oiShift,
  oiWindow,
  pickWindow,
  prevSession,
  rsi,
  rsiFact,
  sessionStart,
  sessionVwap,
  snapOfChain,
  snapTime,
  trendRegime,
  trendWords,
  vwapCross,
} from "./brief-core.js";
import { checkSource } from "./copyRules.mjs";

// 2026-10-30 09:15 IST in epoch seconds, and five-minute candles from there.
const OPEN = Date.UTC(2026, 9, 30, 3, 45) / 1000;
const bar = (i, close, { range = 4, volume = 0, day = 0 } = {}) => ({ time: OPEN + day * 86_400 + i * 300, open: close, high: close + range / 2, low: close - range / 2, close, volume });
/** Closes as candles of one session (day offset 0 unless given). */
const series = (closes, opts) => closes.map((c, i) => bar(i, c, opts));

describe("time helpers", () => {
  it("reads IST dates and clock times", () => {
    expect(istDateOf(OPEN)).toBe("2026-10-30");
    expect(istHm(OPEN)).toBe("09:15");
    expect(istHm(OPEN + 65 * 60)).toBe("10:20");
    expect(istHm(null)).toBe("");
  });
  it("finds the first candle of the last session", () => {
    const two = [...series([1, 2, 3], { day: -1 }), ...series([4, 5])];
    expect(sessionStart(two)).toBe(3);
    expect(sessionStart([])).toBe(-1);
  });
});

describe("indicators", () => {
  it("EMA is seeded with the simple average and null before it", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2);
    expect(e[3]).toBe(3);
    expect(e[4]).toBe(4);
  });
  it("RSI is 100 on a rising run, 0 on a falling run, 50 when flat", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(up).at(-1)).toBe(100);
    expect(rsi(up.slice().reverse()).at(-1)).toBe(0);
    expect(rsi(Array(20).fill(5)).at(-1)).toBe(50);
    expect(rsi(up)[13]).toBeNull();
    expect(rsi(up)[14]).not.toBeNull();
  });
  it("RSI matches Wilder's worked example within rounding", () => {
    // The classic 14-period worked example (Wilder, 1978), first RSI about 70.5.
    const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsi(c)[14]).toBeCloseTo(70.5, 0);
  });
  it("MACD line, its 9-period average and the histogram line up", () => {
    const xs = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const m = macd(xs);
    expect(m.line[24]).toBeNull();
    expect(m.line[25]).not.toBeNull();
    expect(m.avg[32]).toBeNull();
    expect(m.avg[33]).not.toBeNull();
    expect(m.hist[40]).toBeCloseTo(m.line[40] - m.avg[40], 10);
  });
  it("macdFact says which side and when the last cross was", () => {
    const m = { line: [null, 1, 2, -1, -2, 1, 2], avg: [null, 0, 0, 0, 0, 0, 0], hist: [null, 1, 2, -1, -2, 1, 2] };
    const t = [10, 20, 30, 40, 50, 60, 70];
    expect(macdFact(m, t)).toEqual({ above: true, since: 60, hist: 2, line: 2 });
    expect(macdFact({ line: [null, 1, 2], avg: [null, 0, 0], hist: [null, 1, 2] }, [1, 2, 3]).since).toBeNull();
    expect(macdFact({ line: [], avg: [], hist: [] }, [])).toBeNull();
  });
  it("rsiFact names the zone", () => {
    expect(rsiFact(72).zone).toBe("70 or above");
    expect(rsiFact(25).zone).toBe("30 or below");
    expect(rsiFact(50).zone).toBe("between 30 and 70");
    expect(rsiFact(null)).toBeNull();
  });
});

describe("trend regime", () => {
  // Yesterday flat (EMA warm-up), today flat for 12 candles, then a steady climb.
  const flatPrev = series(Array(20).fill(100), { day: -1 });
  const wiggle = (i) => 100 + (i % 2 ? 0.5 : -0.5);
  it("reads Sideways from the open while price only wiggles", () => {
    const t = trendRegime([...flatPrev, ...series(Array.from({ length: 12 }, (_, i) => wiggle(i)))]);
    expect(t.state).toBe("flat");
    expect(t.fromOpen).toBe(true);
    expect(istHm(t.since)).toBe("09:15");
    expect(trendWords(t).title).toBe("Sideways since 09:15, the open");
  });
  it("reads Rising from the first of two confirming candles", () => {
    const closes = [...Array.from({ length: 12 }, (_, i) => wiggle(i)), ...Array.from({ length: 10 }, (_, i) => 101 + i * 3)];
    const t = trendRegime([...flatPrev, ...series(closes)]);
    expect(t.state).toBe("up");
    expect(t.fromOpen).toBe(false);
    // The climb starts at candle 12 (10:15); EMA slope needs a candle or two to clear 0.5 noise units.
    expect(t.sinceIndex).toBeGreaterThanOrEqual(12);
    expect(t.sinceIndex).toBeLessThanOrEqual(14);
    expect(t.move).toBeGreaterThan(0);
    const w = trendWords(t);
    expect(w.word).toBe("Rising");
    expect(w.tone).toBe("up");
    expect(w.title).toMatch(/^Rising since 10:(15|20|25)$/);
    expect(w.detail).toMatch(/^\+[\d,.]+ points since then; the last close is above the EMA 9\.$/);
  });
  it("reads Falling on a steady decline", () => {
    const closes = Array.from({ length: 15 }, (_, i) => 100 - i * 3);
    const t = trendRegime([...flatPrev, ...series(closes)]);
    expect(t.state).toBe("down");
    expect(trendWords(t).tone).toBe("down");
  });
  it("one odd candle does not flip the regime (2 candles confirm)", () => {
    const closes = [...Array.from({ length: 15 }, (_, i) => 100 + i * 3), 120];
    const t = trendRegime([...flatPrev, ...series(closes)]);
    expect(t.state).toBe("up");
  });
  it("is null with too few candles today, and says so", () => {
    expect(trendRegime([...flatPrev, ...series([100, 101])])).toBeNull();
    expect(trendWords(null).title).toBe("Too early to read");
    expect(TREND_RULE.confirm).toBe(2);
  });
});

describe("VWAP", () => {
  it("is volume-weighted through today and says the side", () => {
    const cs = [bar(0, 100, { range: 0, volume: 10 }), bar(1, 110, { range: 0, volume: 30 })];
    const v = sessionVwap(cs);
    expect(v.last).toBeCloseTo(107.5, 10);
    expect(v.side).toBe("above");
  });
  it("is null for candles without volume (an index)", () => {
    expect(sessionVwap(series([1, 2, 3]))).toBeNull();
  });
  it("finds a cross in the last 15 minutes, at the close of the crossing candle", () => {
    const cs = [100, 100, 100, 100, 99, 98, 101].map((c, i) => bar(i, c, { range: 0, volume: 10 }));
    const x = vwapCross(sessionVwap(cs));
    expect(x.dir).toBe("above");
    expect(istHm(x.at)).toBe("09:50");
    const old = [100, 98, 101, 102, 103, 104, 105].map((c, i) => bar(i, c, { range: 0, volume: 10 }));
    expect(vwapCross(sessionVwap(old))).toBeNull();
  });
});

describe("levels", () => {
  it("classic pivots and CPR", () => {
    const p = classicPivots({ high: 110, low: 90, close: 106 });
    expect(p.pp).toBeCloseTo(102, 10);
    expect(p.r1).toBeCloseTo(114, 10);
    expect(p.s1).toBeCloseTo(94, 10);
    expect(p.bc).toBeCloseTo(100, 10);
    expect(p.tc).toBeCloseTo(104, 10);
    expect(classicPivots({ high: 1 })).toBeNull();
  });
  it("prevSession picks the session before a date", () => {
    const d = [{ time: OPEN - 86_400 }, { time: OPEN }];
    expect(prevSession(d, "2026-10-30")).toBe(d[0]);
    expect(prevSession(d, "2026-10-31")).toBe(d[1]);
    expect(prevSession([], "2026-10-31")).toBeNull();
  });
  it("briefLevels keeps only levels with a figure, named as Home names them", () => {
    const l = briefLevels({ callWall: 25200, putWall: 24800, maxPain: null, pivots: { pp: 25000 } });
    expect(l.map((x) => x.label)).toEqual(["Call wall", "Put wall", "Pivot"]);
    expect(BRIEF_LEVEL_NAMES.ce).toBe("Call wall");
  });
  it("mergeLevels sorts high to low, merges close levels and puts spot in place", () => {
    const l = briefLevels({ callWall: 25200, putWall: 24800, maxPain: 25000, dayHigh: 25204, dayLow: 24700, pivots: { pp: 24995, r1: 25100, s1: 24900, tc: 25030, bc: 24960 } });
    const { rows, off } = mergeLevels(l, 25050);
    expect(off).toEqual([]);
    expect(rows.map((r) => r.price)).toEqual([25200, 25100, 25050, 25030, 25000, 24960, 24900, 24800, 24700]);
    expect(rows[0].labels).toEqual(["Call wall", "Day high"]);
    expect(rows[2].spot).toBe(true);
    expect(rows.find((r) => r.price === 25000).labels).toEqual(["Max pain", "Pivot"]);
    expect(rows.at(-1).dist).toBe(-350);
  });
  it("mergeLevels leaves levels beyond the span off and names them", () => {
    const { rows, off } = mergeLevels([{ kind: "ce", label: "Call wall", price: 30000 }, { kind: "pe", label: "Put wall", price: 24900 }], 25000, { span: 1000 });
    expect(off).toEqual(["Call wall"]);
    expect(rows.map((r) => r.labels[0])).toEqual(["Spot", "Put wall"]);
  });
});

describe("what changed in the last 15 minutes", () => {
  const snap = (slot, ce, pe, spot = 25000) => ({ slot, spot, atm: 25000, strikes: [24900, 24950, 25000, 25050, 25100], ce: { oi: ce }, pe: { oi: pe } });
  const a = snap("2026-10-30T14:00:00+05:30", [100, 100, 100, 100, 100], [100, 100, 100, 100, 100]);
  const b = snap("2026-10-30T14:15:00+05:30", [100, 100, 95, 100, 100], [100, 130, 100, 100, 100]);
  it("oiWindow sums the strikes around ATM and its PCR", () => {
    const w = oiWindow(a, { strikes: 1 });
    expect(w.strikes).toEqual([24950, 25000, 25050]);
    expect(w.ceOi).toBe(300);
    expect(w.pcr).toBe(1);
    expect(oiWindow({ strikes: [] })).toBeNull();
  });
  it("pickWindow finds the snapshot 15 minutes before the latest", () => {
    const mid = snap("2026-10-30T14:05:00+05:30", [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]);
    const w = pickWindow([a, mid, b]);
    expect(w.before).toBe(a);
    expect(w.after).toBe(b);
    expect(w.minutes).toBe(15);
    expect(pickWindow([mid, b])).toBeNull();
    expect(pickWindow([b])).toBeNull();
  });
  it("times a recorder snapshot by its slot, never by its `t` (years to expiry)", () => {
    const x = { ...a, t: 0.0084 };
    const y = { ...b, t: 0.0083 };
    expect(snapTime(x)).toBe(Date.parse("2026-10-30T14:00:00+05:30"));
    expect(pickWindow([x, y]).minutes).toBe(15);
    expect(snapTime({ at: 5 })).toBe(5);
    expect(Number.isNaN(snapTime({}))).toBe(true);
  });
  it("oiShift measures each side and its largest strike", () => {
    const s = oiShift(oiWindow(a), oiWindow(b));
    expect(s.dPe).toBe(30);
    expect(s.dCe).toBe(-5);
    expect(s.dPePct).toBeCloseTo(6, 10);
    expect(s.topPe).toEqual({ strike: 24950, d: 30 });
    expect(s.topCe).toEqual({ strike: 25000, d: -5 });
    expect(s.pcrFrom).toBe(1);
    expect(s.pcrTo).toBeCloseTo(530 / 495, 10);
  });
  it("sentences: VWAP cross first, then OI by size, then PCR; at most three; tones by sign", () => {
    const s = oiShift(oiWindow(a), oiWindow(b));
    const out = changeSentences({ shift: s, cross: { dir: "below", at: OPEN + 300 * 60, vwap: 25012.5 }, vwapSide: "below" });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ text: "The near future crossed below its VWAP (25,012.50) at 14:15.", tone: "down" });
    expect(out[1].text).toBe("Put OI rose by 30 (6.0%) across the 5 strikes around ATM, most at 24950 (+30).");
    expect(out[1].tone).toBe("up");
    expect(out[2]).toEqual({ text: "Call OI fell by 5 (1.0%) across the 5 strikes around ATM, most at 25000 (−5).", tone: "down" });
    // Without a cross: the OI moves by size, then the PCR shift.
    const noCross = changeSentences({ shift: s, vwapSide: "above" });
    expect(noCross.map((x) => x.text.split(" ")[0])).toEqual(["Put", "Call", "PCR"]);
    expect(noCross[1].tone).toBe("down");
    expect(noCross[2].text).toBe("PCR around ATM moved from 1.00 to 1.07.");
  });
  it("says little changed when nothing passes the floors, and nothing without data", () => {
    const s = oiShift(oiWindow(a), oiWindow(a));
    expect(changeSentences({ shift: s })[0].text).toBe(`Little changed in the last 15 minutes: OI moved less than ${CHANGE_FLOORS.oiPct}% on each side.`);
    expect(changeSentences({})).toEqual([]);
    expect(changeSentences({ vwapSide: "above" })).toEqual([{ text: "The near future stayed above its VWAP.", tone: "up" }]);
  });
  it("snapOfChain reads a chain like a snapshot", () => {
    const c = { spot: 25010, atm: 25000, freshness: { asOf: "2026-10-30T14:15:00+05:30" }, rows: [{ strike: 25000, ce: { oi: 5 }, pe: { oi: 6 } }] };
    const s = snapOfChain(c, 0);
    expect(s.strikes).toEqual([25000]);
    expect(oiWindow(s).pcr).toBeCloseTo(1.2, 10);
    expect(snapOfChain({ rows: [] }, 0)).toBeNull();
  });
});

describe("breadth and IV range", () => {
  it("breadthFact", () => {
    expect(breadthFact({ advances: 28, declines: 21, unchanged: 1 })).toMatchObject({ tone: "up", text: "28 up · 21 down · 1 unchanged", total: 50 });
    expect(breadthFact({ advances: 10, declines: 20 }).tone).toBe("down");
    expect(breadthFact(null)).toBeNull();
  });
  it("ivRange takes the longest lookback with a range", () => {
    const r = ivRange({ available: true, current: { iv: 17.7 }, lookbacks: [{ days: 30, n: 29, min: { iv: 16 }, max: { iv: 26 }, ivr: 17 }, { days: 252, n: 251, min: { iv: 13.5 }, max: { iv: 31.9 }, ivr: 22.8, ivp: 30.3 }] });
    expect(r).toMatchObject({ iv: 17.7, lo: 13.5, hi: 31.9, days: 251, rank: 22.8, pct: 30.3 });
    expect(r.at).toBeCloseTo((17.7 - 13.5) / (31.9 - 13.5), 10);
    expect(ivRange({ available: false })).toBeNull();
  });
  it("knows the index symbol of each underlying", () => {
    expect(INDEX_SYMBOL.SENSEX).toBe("BSE:SENSEX");
  });
});

describe("copy", () => {
  it("brief-core.js and brief.js use neutral words only", () => {
    for (const f of ["brief-core.js", "brief.js"]) expect(checkSource(readFileSync(new URL(`./${f}`, import.meta.url), "utf8")), f).toEqual([]);
  });
});
