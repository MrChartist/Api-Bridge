import { describe, expect, it } from "vitest";
import { black76 } from "./pricing.js";
import { INDEX_UNDERLYINGS, SPAN_METHOD, istDate, marginImpact, portfolioMargin, scenarios, simpleLegMargin, standaloneMargin, yearsLeft } from "./span-margin.js";

const NOW = Date.parse("2026-10-30T10:00:00+05:30");
const F = 25000;
const EXP = "2026-11-06";
const T = yearsLeft(EXP, NOW);
const opt = (right, strike, qty, { iv = 13, expiry = EXP, underlying = "NIFTY", fwd = F } = {}) => {
  const px = black76(fwd, strike, yearsLeft(expiry, NOW), iv, right);
  return { underlying, kind: "OPT", right, strike, expiry, qty, mark: px, cost: px };
};
const fut = (qty, { expiry = "2026-11-24", underlying = "NIFTY", mark = F } = {}) => ({ underlying, kind: "FUT", expiry, qty, mark, cost: mark });
const ctx = { nowMs: NOW, forwards: { NIFTY: F, RELIANCE: 1400 } };
const req = (legs, c = ctx) => portfolioMargin(legs, c).required;

describe("span-margin basics", () => {
  it("states that it is an approximation", () => {
    expect(SPAN_METHOD).toMatch(/^Approximate, not the exchange's SPAN/);
  });
  it("has 16 scenarios with two weighted extremes", () => {
    const s = scenarios(0.09);
    expect(s).toHaveLength(16);
    expect(s.filter((x) => x.weight < 1).map((x) => x.move)).toEqual([0.18, -0.18]);
  });
  it("time to expiry runs to 15:30 IST and stops at 0", () => {
    expect(yearsLeft("2026-10-30", Date.parse("2026-10-30T15:30:00+05:30"))).toBe(0);
    expect(yearsLeft("2026-10-30", Date.parse("2026-10-30T14:30:00+05:30"))).toBeCloseTo(1 / (365 * 24), 8);
    expect(istDate(Date.parse("2026-10-30T23:00:00+05:30"))).toBe("2026-10-30");
  });
  it("knows the index underlyings", () => {
    expect(INDEX_UNDERLYINGS).toContain("BANKNIFTY");
  });
  it("ignores legs it cannot read", () => {
    const r = portfolioMargin([{ kind: "OPT", underlying: "NIFTY", expiry: "x", qty: 1 }, null, { kind: "EQ", qty: 5 }], ctx);
    expect(r.required).toBe(0);
    expect(r.groups).toEqual([]);
  });
});

describe("single legs", () => {
  it("an option buy needs exactly its premium", () => {
    const l = opt("CE", 25000, 65);
    expect(req([l])).toBeCloseTo(l.cost * 65, 6);
  });
  it("a naked short index option needs scan risk plus 2 % exposure", () => {
    const r = portfolioMargin([opt("CE", 25000, -65)], ctx);
    expect(r.exposure).toBeCloseTo(65 * F * 0.02, 6);
    expect(r.span).toBeGreaterThan(65 * F * 0.06);
    expect(r.required).toBeCloseTo(r.span + r.exposure, 6);
    expect(r.groups[0].worst.move).toBeGreaterThan(0); // a short call loses on the way up
  });
  it("a long future needs about the price range plus exposure", () => {
    const r = portfolioMargin([fut(65)], ctx);
    expect(r.span).toBeCloseTo(65 * F * 0.09, 0);
    expect(r.exposure).toBeCloseTo(65 * F * 0.02, 6);
  });
  it("stocks use the wider range and 3.5 % exposure", () => {
    const r = portfolioMargin([fut(500, { underlying: "RELIANCE", mark: 1400 })], ctx);
    expect(r.span).toBeCloseTo(500 * 1400 * 0.15, 0);
    expect(r.exposure).toBeCloseTo(500 * 1400 * 0.035, 6);
  });
  it("falls back to the simple per-leg model without a forward", () => {
    const l = opt("PE", 24800, -65);
    const r = portfolioMargin([l], { nowMs: NOW, forwards: {} });
    expect(r.groups[0].fallback).toBe(true);
    expect(r.required).toBeCloseTo(simpleLegMargin({ ...l }), 6);
    expect(r.required).toBeCloseTo(65 * 24800 * 0.15, 6);
  });
});

describe("hedges get their benefit", () => {
  const condor = [opt("PE", 24800, -65), opt("CE", 25200, -65), opt("PE", 24600, 65), opt("CE", 25400, 65)];
  it("an iron condor needs about its max loss plus exposure, far below its legs one by one", () => {
    const r = portfolioMargin(condor, ctx);
    const credit = (condor[0].cost + condor[1].cost - condor[2].cost - condor[3].cost) * 65;
    const maxLoss = 200 * 65 - credit;
    expect(r.premium + r.span).toBeGreaterThan(maxLoss * 0.95);
    expect(r.premium + r.span).toBeLessThan(maxLoss * 1.05);
    expect(r.required).toBeLessThan(r.standalone * 0.3);
    expect(r.benefit).toBeCloseTo(r.standalone - r.required, 6);
    expect(r.standalone).toBeCloseTo(standaloneMargin(condor, ctx), 6);
  });
  it("a straddle needs less than its two shorts apart", () => {
    const s = [opt("CE", 25000, -65), opt("PE", 25000, -65)];
    expect(req(s)).toBeLessThan(req([s[0]]) + req([s[1]]));
  });
  it("a credit spread needs less than the naked short", () => {
    expect(req([opt("PE", 24800, -65), opt("PE", 24600, 65)])).toBeLessThan(req([opt("PE", 24800, -65)]) * 0.4);
  });
  it("a short call covered by a long future needs less than both apart", () => {
    const both = req([fut(65), opt("CE", 25200, -65)]);
    expect(both).toBeLessThan(req([fut(65)]) + req([opt("CE", 25200, -65)]));
  });
  it("a calendar spread pays a calendar charge", () => {
    const r = portfolioMargin([opt("CE", 25000, -65), opt("CE", 25000, 65, { expiry: "2026-11-24" })], ctx);
    expect(r.calendar).toBeGreaterThan(0);
    expect(r.required).toBeLessThan(req([opt("CE", 25000, -65)]));
  });
  it("different underlyings do not offset", () => {
    const a = opt("CE", 25000, -65);
    const b = { ...opt("CE", 1400, 500, { underlying: "RELIANCE", fwd: 1400 }) };
    expect(req([a, b])).toBeCloseTo(req([a]) + req([b]), 6);
  });
});

describe("expiry day", () => {
  const day = Date.parse("2026-11-06T10:00:00+05:30");
  const c = { nowMs: day, forwards: { NIFTY: F } };
  it("short index options expiring today carry 2 % ELM", () => {
    const r = portfolioMargin([{ underlying: "NIFTY", kind: "OPT", right: "CE", strike: 25000, expiry: "2026-11-06", qty: -65, mark: 60, cost: 60 }], c);
    expect(r.elm).toBeCloseTo(65 * F * 0.02, 6);
  });
  it("legs expiring today get no offset against later expiries", () => {
    const near = { underlying: "NIFTY", kind: "OPT", right: "CE", strike: 25000, expiry: "2026-11-06", qty: -65, mark: 60, cost: 60 };
    const far = { underlying: "NIFTY", kind: "OPT", right: "CE", strike: 25000, expiry: "2026-11-24", qty: 65, mark: 260, cost: 260 };
    const r = portfolioMargin([near, far], c);
    const r0 = portfolioMargin([near], c);
    expect(r.span).toBeGreaterThanOrEqual(r0.span - 1e-6);
  });
});

describe("marginImpact", () => {
  it("adding the hedge to a held short lowers the requirement", () => {
    const held = [opt("CE", 25200, -65)];
    const m = marginImpact(held, [opt("CE", 25400, 65)], ctx);
    expect(m.change).toBeLessThan(0);
    expect(m.after).toBeCloseTo(m.before + m.change, 6);
    expect(m.alone).toBeGreaterThan(0);
  });
  it("closing a held leg is the same as removing it", () => {
    const held = [opt("CE", 25200, -65)];
    const m = marginImpact(held, [opt("CE", 25200, 65)], ctx);
    expect(m.after).toBe(0);
    expect(m.change).toBeCloseTo(-m.before, 6);
  });
});
