import { describe, expect, it } from "vitest";
import { clampWhatIf, daysStep, isNeutral, normWhatIf, scenarioMarginLegs, strategyBookLegs, targetOf, whatIfFigures } from "./whatif-core.js";

const NOW = Date.parse("2026-10-30T10:00:00+05:30");
const EXP = "2026-11-03";
const T = 4 / 365;
// A short NIFTY strangle, 1 lot of 65, priced like options.js priceBook does.
const strangle = [
  { kind: "OPT", strike: 26850, right: "CE", expiry: EXP, q: -65, avg: 105.8, mark: 106.3, F: 26302, iv: 12.5, T, t0: NOW, priced: true, inc: true },
  { kind: "OPT", strike: 25750, right: "PE", expiry: EXP, q: -65, avg: 127, mark: 126.8, F: 26302, iv: 14.5, T, t0: NOW, priced: true, inc: true },
];

describe("what-if state", () => {
  it("cleans a saved scenario and reads the builder's older target and IV shift", () => {
    expect(normWhatIf(null)).toEqual({ pct: 0, dIv: 0, days: 0 });
    expect(normWhatIf({ pct: 40, dIv: -3, days: 2 })).toEqual({ pct: 10, dIv: -3, days: 2 });
    expect(normWhatIf({ target: NOW + 2 * 86_400_000, ivShift: 1.5 }, NOW)).toEqual({ pct: 0, dIv: 1.5, days: 2 });
    expect(isNeutral({ pct: 0, dIv: 0, days: 0 })).toBe(true);
    expect(isNeutral({ pct: 0.25, dIv: 0, days: 0 })).toBe(false);
  });

  it("clamps to the page's range on the slider steps", () => {
    expect(clampWhatIf({ pct: 1.3, dIv: 0.7, days: 9 }, 4)).toEqual({ pct: 1.25, dIv: 0.5, days: 4 });
    expect(daysStep(2.4)).toBe(0.25);
    expect(daysStep(12)).toBe(1);
    expect(clampWhatIf({ days: 1.1 }, 2.4).days).toBe(1);
  });

  it("turns days into the builder's target time, capped at the first expiry", () => {
    expect(targetOf({ days: 0 }, NOW, NOW + 1e9)).toBeNull();
    expect(targetOf({ days: 1 }, NOW, NOW + 1e9)).toBe(NOW + 86_400_000);
    expect(targetOf({ days: 30 }, NOW, NOW + 5)).toBe(NOW + 5);
  });
});

describe("what-if figures", () => {
  it("at the neutral scenario the change is zero and P&L is the live P&L", () => {
    const f = whatIfFigures(strangle, { pct: 0, dIv: 0, days: 0 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW });
    expect(f.legs).toBe(2);
    expect(f.change).toBeCloseTo(0, 6);
    expect(f.pnl).toBeCloseTo((105.8 - 106.3) * 65 + (127 - 126.8) * 65, 4);
    expect(f.marginChange).toBeCloseTo(0, 6);
    expect(f.margin).toBeGreaterThan(50_000);
  });

  it("anchors margin to the page's own figure when given, so one screen never shows two margins", () => {
    const base = whatIfFigures(strangle, { pct: 3, dIv: 0, days: 0 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW });
    const now = whatIfFigures(strangle, { pct: 0 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW, marginNow: 87_249 });
    expect(now.margin).toBe(87_249);
    expect(now.marginChange).toBeCloseTo(0, 6);
    const up = whatIfFigures(strangle, { pct: 3, dIv: 0, days: 0 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW, marginNow: 87_249 });
    expect(up.margin0).toBe(87_249);
    expect(up.marginChange).toBeCloseTo(base.marginChange, 6);
  });

  it("a short strangle loses on a big move and on an IV rise, gains on time", () => {
    const up = whatIfFigures(strangle, { pct: 3, dIv: 0, days: 0 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW });
    expect(up.change).toBeLessThan(-10_000);
    expect(up.greeks.delta).toBeLessThan(up.greeks0.delta);
    expect(up.spot).toBeCloseTo(26302 * 1.03, 6);
    // The tested call is now nearer the money: the scan charges more.
    expect(up.marginChange).toBeGreaterThan(0);
    const vol = whatIfFigures(strangle, { pct: 0, dIv: 3, days: 0 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW });
    expect(vol.change).toBeLessThan(0);
    const time = whatIfFigures(strangle, { pct: 0, dIv: 0, days: 2 }, { underlying: "NIFTY", spot: 26302, nowMs: NOW });
    expect(time.change).toBeGreaterThan(0);
  });

  it("excluded and unpriced legs count nowhere; no forward means no margin", () => {
    const f = whatIfFigures([{ ...strangle[0], inc: false }, { ...strangle[1], priced: false }], { pct: 1 }, { underlying: "NIFTY", nowMs: NOW });
    expect(f.legs).toBe(0);
    expect(f.margin).toBeNull();
    expect(f.change).toBe(0);
  });

  it("margin legs at a scenario carry the shifted IV and keep a long's paid premium", () => {
    const long = [{ ...strangle[0], q: 65 }];
    const ml = scenarioMarginLegs(long, "NIFTY", { dS: 0.01, dIv: 2, days: 0 });
    expect(ml[0]).toMatchObject({ underlying: "NIFTY", qty: 65, cost: 105.8, iv: 14.5 });
    expect(ml[0].mark).toBeGreaterThan(106.3);
  });
});

describe("strategy legs as book legs", () => {
  it("signs quantities, prices at the leg price and keeps futures one for one", () => {
    const b = strategyBookLegs(
      [
        { kind: "OPT", side: "SELL", lots: 2, strike: 26500, right: "CE", expiry: EXP, price: 80, iv: 12, years: T },
        { kind: "FUT", side: "BUY", lots: 1, expiry: "2026-11-24", price: 26400, years: 0.07 },
        { kind: "OPT", side: "BUY", lots: 1, strike: 26000, right: "PE", expiry: EXP, price: null, iv: 12 },
        { kind: "OPT", side: "BUY", lots: 1, strike: 26000, right: "PE", expiry: EXP, price: 50, iv: 13, on: false },
      ],
      { lot: 65, forward: 26350, nowMs: NOW },
    );
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ q: -130, avg: 80, mark: 80, F: 26350, priced: true });
    expect(b[1]).toMatchObject({ kind: "FUT", q: 65, F: 26400 });
    const f = whatIfFigures(b, { pct: 1 }, { underlying: "NIFTY", spot: 26300, nowMs: NOW });
    expect(f.pnl0).toBeCloseTo(0, 6);
    // Long future +1 %: +₹17,160 on the future, less the short calls' loss.
    expect(f.change).toBeLessThan(65 * 264);
  });
});
