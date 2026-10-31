/** Option chain column maths (chain-metrics.js): figures, missing inputs, expiry day, both sides, the build-up rule. */
import { describe, expect, it } from "vitest";
import { black76 } from "./pricing.js";
import * as M from "./chain-metrics.js";

const F = 25_000;
const T = 7 / 252;
const TCAL = 7 / 365;

describe("price and volume", () => {
  it("LTP change: LTP − previous close; a 0 close is no baseline (dash), never an invented 0", () => {
    expect(M.ltpChange({ ltp: 120, close: 100, change: 5 })).toBe(20);
    expect(M.ltpChange({ ltp: 80, close: 100 })).toBe(-20);
    expect(M.ltpChange({ ltp: 80, change: -3 })).toBe(-3);
    expect(M.ltpChange({ ltp: 80, close: 0, change: -80 })).toBeNull();
    expect(M.ltpChange({ ltp: 80 })).toBeNull();
    expect(M.ltpChangePct({ ltp: 64, close: 72.4 })).toBeCloseTo(-11.6022, 3);
    expect(M.ltpChangePct({ ltp: 64, close: 0 })).toBeNull();
  });
  it("day high / low fold in the live LTP; 0 or missing is a dash", () => {
    expect(M.dayHigh({ high: 76, ltp: 64 })).toBe(76);
    expect(M.dayHigh({ high: 76, ltp: 80 })).toBe(80);
    expect(M.dayLow({ low: 61.5, ltp: 64 })).toBe(61.5);
    expect(M.dayLow({ low: 61.5, ltp: 60 })).toBe(60);
    expect(M.dayHigh({ high: 0, ltp: 64 })).toBeNull();
    expect(M.dayLow({ ltp: 64 })).toBeNull();
    expect(M.rangePosition({ high: 76, low: 61.5, ltp: 64 })).toBeCloseTo(2.5 / 14.5, 9);
    expect(M.rangePosition({ ltp: 64 })).toBeNull();
  });
  it("volume ÷ OI, null without OI", () => {
    expect(M.volumeOiRatio({ volume: 50, oi: 200 })).toBe(0.25);
    expect(M.volumeOiRatio({ volume: 0, oi: 200 })).toBe(0);
    expect(M.volumeOiRatio({ volume: 50, oi: 0 })).toBeNull();
  });
});

describe("market depth", () => {
  it("spread: ask − bid; the whole ask with no bid; dash when locked, crossed or no ask", () => {
    expect(M.spreadAbs({ bid: 64, ask: 64.35 })).toBeCloseTo(0.35, 9);
    expect(M.spreadAbs({ bid: 0, ask: 10.5 })).toBe(10.5);
    expect(M.spreadAbs({ ask: 10.5 })).toBe(10.5);
    expect(M.spreadAbs({ bid: 10.5, ask: 10.5 })).toBeNull();
    expect(M.spreadAbs({ bid: 11, ask: 10.5 })).toBeNull();
    expect(M.spreadAbs({ bid: 10 })).toBeNull();
  });
  it("a zero or missing price or size is no quote", () => {
    expect(M.quotePrice(12.5)).toBe(12.5);
    expect(M.quotePrice(0)).toBeNull();
    expect(M.quoteQty(750)).toBe(750);
    expect(M.quoteQty(0)).toBeNull();
  });
});

describe("model figures", () => {
  it("rho: −Tcal × price / 100, negative for calls and puts, 0 at expiry, null without IV", () => {
    const c = black76(F, 25_200, T, 14, "CE");
    expect(M.rho76(F, 25_200, T, 14, "CE", TCAL)).toBeCloseTo((-TCAL * c) / 100, 10);
    const p = black76(F, 24_800, T, 14, "PE");
    expect(M.rho76(F, 24_800, T, 14, "PE", TCAL, 0.999)).toBeCloseTo((-TCAL * p * 0.999) / 100, 10);
    expect(Math.abs(M.rho76(F, 24_500, T, 14, "CE", TCAL))).toBeGreaterThan(Math.abs(M.rho76(F, 25_500, T, 14, "CE", TCAL)));
    expect(M.rho76(F, 25_000, 0, 14, "CE", 0)).toBe(0);
    expect(M.rho76(F, 25_000, T, null, "CE", TCAL)).toBeNull();
    expect(M.rho76(F, 25_000, T, 14, "CE", null)).toBeNull();
  });
  it("theoretical price: Black-76 at the ATM IV, not the leg's; intrinsic at expiry; no guessed volatility", () => {
    expect(M.theoPrice(F, 25_200, T, 14, "CE")).toBeCloseTo(black76(F, 25_200, T, 14, "CE"), 9);
    expect(M.theoPrice(F, 24_800, T, 14, "PE", 0.99)).toBeCloseTo(black76(F, 24_800, T, 14, "PE") * 0.99, 9);
    expect(M.theoPrice(F, 25_200, T, 14, "CE") - M.theoPrice(F, 25_200, T, 14, "PE")).toBeCloseTo(F - 25_200, 6);
    expect(M.theoPrice(F, 24_800, 0, 14, "CE")).toBe(200);
    expect(M.theoPrice(F, 25_000, T, null, "CE")).toBeNull();
    expect(M.theoPrice(null, 25_000, T, 14, "CE")).toBeNull();
  });
  it("intrinsic value against spot, both sides; out of the money a real 0", () => {
    expect(M.intrinsicValue(24_800, "CE", 25_000)).toBe(200);
    expect(M.intrinsicValue(25_200, "CE", 25_000)).toBe(0);
    expect(M.intrinsicValue(25_200, "PE", 25_000)).toBe(200);
    expect(M.intrinsicValue(24_800, "PE", 25_000)).toBe(0);
    expect(M.intrinsicValue(24_800, "PE", null)).toBeNull();
  });
  it("breakeven %: the move from spot; a 0 premium is a dash", () => {
    expect(M.breakevenPct(25_000, "CE", 250, 25_000)).toBeCloseTo(1, 9);
    expect(M.breakevenPct(25_000, "PE", 250, 25_000)).toBeCloseTo(-1, 9);
    expect(M.breakevenPct(24_500, "CE", 300, 25_000)).toBeCloseTo(-0.8, 9);
    expect(M.breakevenPct(25_000, "CE", 0, 25_000)).toBeNull();
    expect(M.breakevenPct(25_000, "CE", 250, null)).toBeNull();
  });
  it("relative distance: (strike − spot) ÷ spot, negative below; σ distance OTM positive, null at expiry", () => {
    expect(M.relativeDistance(23_400, 23_346.4)).toBeCloseTo(0.2296, 3);
    expect(M.relativeDistance(23_300, 23_346.4)).toBeLessThan(0);
    expect(M.relativeDistance(23_300, null)).toBeNull();
    const sd = 0.14 * Math.sqrt(T);
    expect(M.sigmaDist(25_500, "CE", F, 14, T)).toBeCloseTo(Math.log(25_500 / F) / sd, 9);
    expect(M.sigmaDist(24_500, "PE", F, 14, T)).toBeGreaterThan(0);
    expect(M.sigmaDist(25_500, "CE", F, 14, 0)).toBeNull();
  });
});

describe("quote as % of spot", () => {
  it("bid / ask ÷ spot × 100", () => {
    expect(M.pctOfSpot(64, 23_346.4)).toBeCloseTo(0.27413, 4);
    expect(M.pctOfSpot(0, 23_346.4)).toBeNull();
    expect(M.pctOfSpot(64, 0)).toBeNull();
  });
  it("annualised: × 365 ÷ whole days (at least 1), so expiry day still reads", () => {
    expect(M.annualDays(0.010921)).toBe(4);
    expect(M.annualisedPct(1, 0.010921)).toBeCloseTo(91.25, 9);
    expect(M.annualDays(0.5 / 365)).toBe(1);
    expect(M.annualisedPct(1, 0)).toBe(365);
    expect(M.annualisedPct(null, TCAL)).toBeNull();
    expect(M.annualisedPct(1, null)).toBeNull();
  });
});

describe("build-up rule", () => {
  it("both moves must reach their floors (exactly on passes), else Neutral", () => {
    // 23400 Call, 1 day: premium 72.40 → 64.00, OI 6523140 → 9061130.
    expect(M.classifyBuildup({ px0: 72.4, px: 64, oi0: 6_523_140, oi: 9_061_130 }, "day")).toMatchObject({ code: "SB", isNew: false });
    // 23800 Call: premium −39 %, OI −1.4 % (inside the 2 % floor).
    expect(M.classifyBuildup({ px0: 5, px: 3.05, oi0: 8_367_840, oi: 8_249_085 }, "day").code).toBe("NT");
    // Exactly on the floors: OI +2 %, premium +0.5 %.
    expect(M.classifyBuildup({ px0: 100, px: 100.5, oi0: 1000, oi: 1020 }, "day").code).toBe("LB");
    // The same moves clear the 1 % OI floor of the minute windows.
    expect(M.classifyBuildup({ px0: 100, px: 100.5, oi0: 1000, oi: 1015 }, "day").code).toBe("NT");
    expect(M.classifyBuildup({ px0: 100, px: 100.5, oi0: 1000, oi: 1015 }, "5").code).toBe("LB");
  });
  it("the two signs name it, calls and puts alike", () => {
    expect(M.classifyBuildup({ px0: 100, px: 110, oi0: 1000, oi: 1100 }).code).toBe("LB");
    expect(M.classifyBuildup({ px0: 100, px: 90, oi0: 1000, oi: 1100 }).code).toBe("SB");
    expect(M.classifyBuildup({ px0: 100, px: 110, oi0: 1000, oi: 900 }).code).toBe("SC");
    expect(M.classifyBuildup({ px0: 100, px: 90, oi0: 1000, oi: 900 }).code).toBe("LU");
  });
  it("a new strike: the premium alone decides, no floor", () => {
    expect(M.classifyBuildup({ px0: 10, px: 10.01, oi0: 0, oi: 500 })).toMatchObject({ code: "LB", isNew: true, oiPct: null });
    expect(M.classifyBuildup({ px0: 10, px: 9, oi0: 0, oi: 500 }).code).toBe("SB");
    expect(M.classifyBuildup({ px0: 10, px: 10, oi0: 0, oi: 500 }).code).toBe("NT");
  });
  it("cannot measure without both ends; conviction grows with the moves", () => {
    expect(M.classifyBuildup({ px0: null, px: 10, oi0: 100, oi: 120 })).toBeNull();
    expect(M.classifyBuildup({ px0: 0, px: 10, oi0: 100, oi: 120 })).toBeNull();
    const small = M.classifyBuildup({ px0: 100, px: 101, oi0: 1000, oi: 1030 });
    const big = M.classifyBuildup({ px0: 100, px: 130, oi0: 1000, oi: 1500 });
    expect(big.conviction).toBeGreaterThan(small.conviction);
    expect(M.buildupIntensity(big, 500)).toBeGreaterThan(M.buildupIntensity(small, 500));
    expect(M.buildupIntensity({ code: "NT", conviction: 0 }, 10)).toBe(0);
  });
  it("1 day: ends from the previous close and OI − change; no baseline without the change", () => {
    expect(M.dayBuildup({ ltp: 64, close: 72.4, oi: 9_061_130, oiChange: 2_537_990 })).toMatchObject({ state: "ok", code: "SB" });
    expect(M.dayBuildup({ ltp: 64, change: -8.4, oi: 9_061_130, oiChange: 2_537_990 })).toMatchObject({ state: "ok", code: "SB" });
    expect(M.dayBuildup({ ltp: 64, close: 72.4, oi: 9_061_130 }).state).toBe("no-baseline");
  });
  it("sort order by meaning: LB, SC, Neutral, LU, SB", () => {
    expect(["SB", "NT", "LB", "LU", "SC"].sort((a, b) => M.BUILDUP_RANK[b] - M.BUILDUP_RANK[a])).toEqual(["LB", "SC", "NT", "LU", "SB"]);
  });
});

describe("5 / 15 minute windows", () => {
  const now = Date.UTC(2026, 8, 18, 10, 9); // 15:39 IST
  const snap = (agoSec, cl, co) => ({ t: now - agoSec * 1000, k: [25_000, 25_100], cl, co, pl: [90, 140], po: [5000, 3000] });

  it("the snapshot nearest the mark within the tolerance (±90 s for 5m, ±2m 30s for 15m)", () => {
    const snaps = [snap(15 * 60 + 100, [100, 60], [1000, 800]), snap(5 * 60 + 80, [110, 70], [1200, 800]), snap(5 * 60 - 30, [111, 70], [1210, 800]), snap(60, [115, 72], [1300, 810])];
    expect(M.windowRef(snaps, now, "5")).toMatchObject({ state: "ok", t: now - (5 * 60 - 30) * 1000 });
    expect(M.windowRef(snaps, now, "15")).toMatchObject({ state: "ok", t: now - (15 * 60 + 100) * 1000 });
  });
  it("unavailable states: no snapshots, warming (with the wait), not enough history, gap", () => {
    expect(M.windowRef([], now, "5").state).toBe("no-snapshots");
    expect(M.windowRef(null, now, "15").state).toBe("no-snapshots");
    // History from 10 min ago only: 15m warms up; ready at first + 15m − 2m30s.
    const young = [snap(600, [1, 1], [1, 1])];
    expect(M.windowRef(young, now, "15")).toEqual({ state: "warming", win: "15", waitMs: (15 * 60 - 150 - 600) * 1000 });
    expect(M.windowRef(young, now, "15", { live: false }).state).toBe("not-enough-history");
    // History spans the window but nothing lies near the 5m mark.
    expect(M.windowRef([snap(20 * 60, [1, 1], [1, 1]), snap(30, [1, 1], [1, 1])], now, "5").state).toBe("gap");
  });
  it("classifies against the snapshot; cannot measure a strike it lacks or without OI / price then", () => {
    const ref = M.windowRef([snap(5 * 60, [100, 0], [1000, null])], now, "5");
    expect(M.windowBuildup({ ltp: 110, oi: 1100 }, ref, 25_000, "ce")).toMatchObject({ state: "ok", code: "LB", dPx: 10, dOi: 100 });
    expect(M.windowBuildup({ ltp: 95, oi: 4000 }, ref, 25_000, "pe")).toMatchObject({ state: "ok", code: "SC" });
    expect(M.windowBuildup({ ltp: 130, oi: 2000 }, ref, 25_100, "pe")).toMatchObject({ state: "ok", code: "LU" });
    expect(M.windowBuildup({ ltp: 110, oi: 1100 }, ref, 25_100, "ce").state).toBe("cannot-measure");
    expect(M.windowBuildup({ ltp: 110, oi: 1100 }, ref, 25_200, "ce").state).toBe("cannot-measure");
    expect(M.windowBuildup({ ltp: 110, oi: 1100 }, M.windowRef([], now, "5"), 25_000, "ce").state).toBe("no-snapshots");
    for (const s of ["no-baseline", "cannot-measure", "warming", "not-enough-history", "no-snapshots", "gap"]) expect(M.BUILDUP_STATE_TEXT[s], s).toBeTruthy();
  });
});

describe("Greek dashes", () => {
  it("value, exact zero (Delta prints 0.00), unavailable", () => {
    expect(M.greekState("gamma", 0.0018)).toBe("value");
    expect(M.greekState("gamma", 0)).toBe("zero");
    expect(M.greekState("delta", 0)).toBe("value");
    expect(M.greekState("theta", null)).toBe("unavailable");
  });
});

describe("highlights", () => {
  const leg = (oi, oiChange, volume, ltp = 100, close = 100) => ({ oi, oiChange, volume, ltp, close });
  const rows = [
    { strike: 100, ce: leg(500, 50, 10, 110), pe: leg(900, -300, 40, 90) },
    { strike: 200, ce: leg(800, 200, 30, 90), pe: leg(900, 100, 0) },
    { strike: 300, ce: leg(800, -20, 20), pe: leg(null, null, null) },
    { strike: 400, ce: leg(100, 0, 50), pe: leg(200, 150, 5, 120) },
  ];
  it("ranks the top three per side above 0; ties go to the lower strike; no figure is never ranked", () => {
    const hl = M.chainHighlights(rows);
    expect([...hl.ce.oi]).toEqual([[200, 1], [300, 2], [100, 3]]);
    expect([...hl.pe.oi]).toEqual([[100, 1], [200, 2], [400, 3]]);
    expect([...hl.ce.vol]).toEqual([[400, 1], [200, 2], [300, 3]]);
    expect([...hl.pe.vol]).toEqual([[100, 1], [400, 2]]);
    expect([...hl.ce.add]).toEqual([[200, 1], [100, 2]]);
    expect([...hl.ce.cut]).toEqual([[300, 1]]);
    expect([...hl.pe.cut]).toEqual([[100, 1]]);
    expect(hl.ce.bu.size).toBe(0);
    expect(M.rankedStrikes(hl.ce.oi)).toEqual([200, 300, 100]);
  });
  it("build-ups: only readings at or above the floor are marked", () => {
    const hl = M.chainHighlights(rows, { buildup: (r, s) => (s === "ce" ? ({ 100: 0.9, 200: 0.29, 300: 0.5 })[r.strike] ?? null : null) });
    expect([...hl.ce.bu]).toEqual([[100, 1], [300, 2]]);
    expect(hl.pe.bu.size).toBe(0);
  });
  it("rank text names the wall at #1 OI", () => {
    expect(M.rankText("oi", 1, "ce")).toBe("#1 open interest on the call side: the call wall");
    expect(M.rankText("vol", 2, "pe")).toBe("#2 volume on the put side");
    expect(M.rankText("cut", 3, "pe")).toBe("#3 OI cut on the put side");
    expect(M.rankText("bu", 1, "ce")).toBe("#1 build-up strength on the call side");
    expect(M.rankText("oi", null, "ce")).toBeNull();
  });
  it("positioning: OI-change weighted, call premium up and put premium down lean up", () => {
    // ce 100 up/+50 leans up, ce 200 down/+200 leans down, pe 100 down/-300 leans up (closing), pe 400 up/+150 leans down; flat legs cast no vote.
    const p = M.positioning(rows);
    expect(p.up).toBe(350);
    expect(p.down).toBe(350);
    expect(p.upShare).toBe(50);
    expect(p.opening).toBeCloseTo((400 / 700) * 100, 9);
    expect(p.voted).toBe(4);
    expect(M.positioning([{ strike: 1, ce: leg(10, 0, 1) }])).toBeNull();
  });
});
