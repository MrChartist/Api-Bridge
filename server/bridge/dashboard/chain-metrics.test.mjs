/** Option chain column maths (chain-metrics.js): the extra columns' figures, missing inputs, expiry day, both sides. */
import { describe, expect, it } from "vitest";
import { black76 } from "./pricing.js";
import { annualisedPct, breakevenPct, intrinsicValue, ltpChange, pctOfStrike, quotePrice, quoteQty, relativeDistance, rho76, spreadAbs, theoPrice, volumeOiRatio, windowBuildup, windowRef } from "./chain-metrics.js";

const F = 25_000;
const T = 7 / 252;
const TCAL = 7 / 365;

describe("price and volume", () => {
  it("LTP change: LTP − previous close, else the chain's change, else null", () => {
    expect(ltpChange({ ltp: 120, close: 100, change: 5 })).toBe(20);
    expect(ltpChange({ ltp: 80, close: 100 })).toBe(-20);
    expect(ltpChange({ ltp: 80, change: -3 })).toBe(-3);
    expect(ltpChange({ ltp: 80 })).toBeNull();
    expect(ltpChange(null)).toBeNull();
  });
  it("volume ÷ OI, null without OI", () => {
    expect(volumeOiRatio({ volume: 50, oi: 200 })).toBe(0.25);
    expect(volumeOiRatio({ volume: 0, oi: 200 })).toBe(0);
    expect(volumeOiRatio({ volume: 50, oi: 0 })).toBeNull();
    expect(volumeOiRatio({ volume: null, oi: 10 })).toBeNull();
  });
});

describe("market depth", () => {
  it("spread in rupees needs a two-sided quote", () => {
    expect(spreadAbs({ bid: 10, ask: 10.5 })).toBeCloseTo(0.5, 9);
    expect(spreadAbs({ bid: 0, ask: 10.5 })).toBeNull();
    expect(spreadAbs({ bid: 11, ask: 10.5 })).toBeNull();
    expect(spreadAbs({ ask: 10.5 })).toBeNull();
  });
  it("a zero or missing price or size is no quote", () => {
    expect(quotePrice(12.5)).toBe(12.5);
    expect(quotePrice(0)).toBeNull();
    expect(quotePrice(null)).toBeNull();
    expect(quoteQty(750)).toBe(750);
    expect(quoteQty(0)).toBeNull();
    expect(quoteQty(undefined)).toBeNull();
  });
});

describe("model figures", () => {
  it("rho: −Tcal × price / 100, negative for calls and puts, 0 at expiry, null without IV", () => {
    const c = black76(F, 25_200, T, 14, "CE");
    expect(rho76(F, 25_200, T, 14, "CE", TCAL)).toBeCloseTo((-TCAL * c) / 100, 10);
    const p = black76(F, 24_800, T, 14, "PE");
    expect(rho76(F, 24_800, T, 14, "PE", TCAL, 0.999)).toBeCloseTo((-TCAL * p * 0.999) / 100, 10);
    // In the money is worth more, so its rho is larger in size.
    expect(Math.abs(rho76(F, 24_500, T, 14, "CE", TCAL))).toBeGreaterThan(Math.abs(rho76(F, 25_500, T, 14, "CE", TCAL)));
    expect(rho76(F, 25_000, 0, 14, "CE", 0)).toBe(0);
    expect(rho76(F, 25_000, T, null, "CE", TCAL)).toBeNull();
    expect(rho76(F, 25_000, T, 14, "CE", null)).toBeNull();
  });
  it("theoretical price: Black-76 at the ATM IV, not the leg's; intrinsic at expiry", () => {
    expect(theoPrice(F, 25_200, T, 14, "CE")).toBeCloseTo(black76(F, 25_200, T, 14, "CE"), 9);
    expect(theoPrice(F, 24_800, T, 14, "PE", 0.99)).toBeCloseTo(black76(F, 24_800, T, 14, "PE") * 0.99, 9);
    // Put-call parity at one volatility: C − P = F − K (df = 1).
    expect(theoPrice(F, 25_200, T, 14, "CE") - theoPrice(F, 25_200, T, 14, "PE")).toBeCloseTo(F - 25_200, 6);
    expect(theoPrice(F, 24_800, 0, 14, "CE")).toBe(200);
    expect(theoPrice(F, 24_800, 0, null, "PE")).toBe(0);
    expect(theoPrice(F, 25_000, T, null, "CE")).toBeNull();
    expect(theoPrice(null, 25_000, T, 14, "CE")).toBeNull();
  });
  it("intrinsic value on the forward, both sides", () => {
    expect(intrinsicValue(24_800, "CE", F)).toBe(200);
    expect(intrinsicValue(25_200, "CE", F)).toBe(0);
    expect(intrinsicValue(25_200, "PE", F)).toBe(200);
    expect(intrinsicValue(24_800, "PE", F)).toBe(0);
    expect(intrinsicValue(24_800, "PE", null)).toBeNull();
  });
  it("breakeven %: the move from spot the breakeven needs", () => {
    expect(breakevenPct(25_000, "CE", 250, 25_000)).toBeCloseTo(1, 9);
    expect(breakevenPct(25_000, "PE", 250, 25_000)).toBeCloseTo(-1, 9);
    // In the money call: breakeven below spot.
    expect(breakevenPct(24_500, "CE", 300, 25_000)).toBeCloseTo(-0.8, 9);
    expect(breakevenPct(25_000, "CE", null, 25_000)).toBeNull();
    expect(breakevenPct(25_000, "CE", 250, null)).toBeNull();
  });
  it("relative distance in σ: OTM positive, ITM negative, null at expiry", () => {
    const sd = 0.14 * Math.sqrt(T);
    expect(relativeDistance(25_500, "CE", F, 14, T)).toBeCloseTo(Math.log(25_500 / F) / sd, 9);
    expect(relativeDistance(24_500, "CE", F, 14, T)).toBeLessThan(0);
    expect(relativeDistance(24_500, "PE", F, 14, T)).toBeGreaterThan(0);
    expect(relativeDistance(25_500, "CE", F, 14, 0)).toBeNull();
    expect(relativeDistance(25_500, "CE", F, null, T)).toBeNull();
  });
});

describe("premium yield", () => {
  it("bid / ask as % of the strike", () => {
    expect(pctOfStrike(250, 25_000)).toBeCloseTo(1, 9);
    expect(pctOfStrike(0, 25_000)).toBeNull();
    expect(pctOfStrike(250, null)).toBeNull();
  });
  it("annualised on calendar time; null with under a day left", () => {
    expect(annualisedPct(1, 7 / 365)).toBeCloseTo(365 / 7, 9);
    expect(annualisedPct(1, 0.5 / 365)).toBeNull();
    expect(annualisedPct(1, 0)).toBeNull();
    expect(annualisedPct(null, 7 / 365)).toBeNull();
    expect(annualisedPct(1, null)).toBeNull();
  });
});

describe("5 / 15 minute build-up", () => {
  const now = Date.UTC(2026, 9, 29, 6, 0);
  const snap = (agoMin, cl, co) => ({ t: now - agoMin * 60_000, k: [25_000, 25_100], cl, co, pl: [90, 140], po: [5000, 3000] });
  const snaps = [snap(20, [100, 60], [1000, 800]), snap(6, [110, 70], [1200, 800]), snap(3, [115, 72], [1300, 810])];

  it("picks the latest snapshot between W and 1.5 W old", () => {
    expect(windowRef(snaps, now, 5).t).toBe(now - 6 * 60_000);
    expect(windowRef(snaps, now, 15).t).toBe(now - 20 * 60_000);
    expect(windowRef([snap(3, [1, 1], [1, 1])], now, 5)).toBeNull();
    expect(windowRef([snap(40, [1, 1], [1, 1])], now, 15)).toBeNull();
    expect(windowRef([], now, 5)).toBeNull();
    expect(windowRef(null, now, 5)).toBeNull();
  });
  it("classifies price and OI change over the window, calls and puts", () => {
    const r5 = windowRef(snaps, now, 5);
    expect(windowBuildup({ ltp: 120, oi: 1300 }, r5, 25_000, "ce")).toEqual({ code: "LB", dPx: 10, dOi: 100, pct: (100 / 1200) * 100 });
    expect(windowBuildup({ ltp: 60, oi: 900 }, r5, 25_100, "ce")).toMatchObject({ code: "SB" });
    expect(windowBuildup({ ltp: 95, oi: 4000 }, r5, 25_000, "pe")).toMatchObject({ code: "SC" });
    expect(windowBuildup({ ltp: 130, oi: 2000 }, r5, 25_100, "pe")).toMatchObject({ code: "LU" });
  });
  it("null without history, a strike the snapshot lacks, a missing figure or no change", () => {
    const r5 = windowRef(snaps, now, 5);
    expect(windowBuildup({ ltp: 120, oi: 1300 }, null, 25_000, "ce")).toBeNull();
    expect(windowBuildup({ ltp: 120, oi: 1300 }, r5, 25_200, "ce")).toBeNull();
    expect(windowBuildup({ ltp: null, oi: 1300 }, r5, 25_000, "ce")).toBeNull();
    expect(windowBuildup({ ltp: 110, oi: 1300 }, r5, 25_000, "ce")).toBeNull();
    expect(windowBuildup({ ltp: 120, oi: 1200 }, r5, 25_000, "ce")).toBeNull();
  });
});
