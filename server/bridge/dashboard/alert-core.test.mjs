import { describe, expect, it } from "vitest";
import { black76 } from "./pricing.js";
import { ALERT_KINDS, bookGroups, evalCondition, groupMetrics, ruleProblems, spotSymbolOf, step, symbolParts } from "./alert-core.js";

const NOW = Date.parse("2026-11-03T10:00:00+05:30");
const CE = "NFO:NIFTY-2026-11-03-26500-CE";
const PE = "NFO:NIFTY-2026-11-03-26000-PE";
const FUT = "NFO:NIFTY-2026-11-24-FUT";
const T = (Date.parse("2026-11-03T15:30:00+05:30") - NOW) / (365 * 86_400_000);
const pos = [
  { symbol: CE, netQty: -65, avgPrice: 40, ltp: 80, pnl: -2600 },
  { symbol: PE, netQty: -65, avgPrice: 50, ltp: 20, pnl: 1950 },
  { symbol: "NFO:BANKNIFTY-2026-11-03-60000-CE", netQty: 30, avgPrice: 100, ltp: 90, pnl: -300 },
];
const rule = (conditions, extra = {}) => ({ account: "demo-paper", underlying: "NIFTY", conditions, match: "all", repeat: "every", cooldownMin: 15, ...extra });

describe("alert-core: symbols", () => {
  it("parses options, futures and cash, and names the spot symbol", () => {
    expect(symbolParts(CE)).toEqual({ exchange: "NFO", underlying: "NIFTY", expiry: "2026-11-03", kind: "OPT", strike: 26500, right: "CE" });
    expect(symbolParts(FUT)).toMatchObject({ kind: "FUT", strike: null, right: null });
    expect(symbolParts("NSE:M&M")).toMatchObject({ kind: "EQ", underlying: "M&M" });
    expect(symbolParts("nope")).toBeNull();
    expect(spotSymbolOf("SENSEX")).toBe("BSE:SENSEX");
    expect(spotSymbolOf("NIFTY")).toBe("NSE:NIFTY");
  });
});

describe("alert-core: rules", () => {
  it("accepts a good rule and names each problem in a bad one", () => {
    expect(ruleProblems(rule([{ kind: "pnl_below", value: -5000 }]))).toEqual([]);
    expect(ruleProblems(rule([]))).toContain("Add at least one condition.");
    expect(ruleProblems(rule([{ kind: "delta_outside", value: 10, value2: 5 }]))[0]).toMatch(/upper delta/);
    expect(ruleProblems(rule([{ kind: "premium_multiple", value: 1 }]))[0]).toMatch(/multiple above 1/);
    expect(ruleProblems(rule([{ kind: "spot_above", value: 0 }]))[0]).toMatch(/above zero/);
    expect(ruleProblems(rule([{ kind: "x", value: 1 }]))[0]).toMatch(/unknown kind/);
    expect(ruleProblems(rule([{ kind: "pnl_above", value: 1 }], { symbols: ["NFO:BANKNIFTY-2026-11-03-60000-CE"] }))[0]).toMatch(/contracts on the underlying/);
    expect(ruleProblems({ ...rule([{ kind: "pnl_above", value: 1 }]), account: "" })).toContain("Choose an account.");
    expect(ALERT_KINDS).toHaveLength(7);
  });
});

describe("alert-core: metrics", () => {
  it("adds P&L of the underlying's legs only, finds the nearest expiry and the biggest premium multiple", () => {
    const m = groupMetrics(pos, { underlying: "NIFTY", spot: 26300, nowMs: NOW });
    expect(m).toMatchObject({ legs: 2, pnl: -650, spot: 26300, nearestExpiry: "2026-11-03", premiumMultiple: 2, premiumLeg: CE });
    expect(m.minutesToExpiry).toBe(330);
  });
  it("net delta from Black-76 at each leg's implied vol", () => {
    const px = black76(26300, 26500, T, 12, "CE");
    const m = groupMetrics([{ symbol: CE, netQty: -65, avgPrice: px, ltp: px, pnl: 0 }, { symbol: FUT, netQty: 65, avgPrice: 26300, ltp: 26300, pnl: 0 }], { underlying: "NIFTY", spot: 26300, nowMs: NOW });
    expect(m.delta).toBeGreaterThan(0);
    expect(m.delta).toBeLessThan(65);
  });
  it("groups open F&O positions by account and underlying, biggest P&L first", () => {
    const g = bookGroups([...pos.map((p) => ({ ...p, accountId: "a" })), { accountId: "b", symbol: CE, netQty: 65, avgPrice: 10, ltp: 12, pnl: 130 }, { accountId: "a", symbol: "NSE:RELIANCE", netQty: 5, pnl: 9 }, { accountId: "a", symbol: PE, netQty: 0, pnl: 0 }], { spots: { NIFTY: 26300 }, nowMs: NOW });
    expect(g.map((x) => `${x.account} ${x.underlying} ${x.legs} ${x.shorts}`)).toEqual(["a NIFTY 2 2", "a BANKNIFTY 1 0", "b NIFTY 1 0"]);
    expect(g[0]).toMatchObject({ pnl: -650, spot: 26300, premiumMultiple: 2 });
    expect(g[1].delta).toBeNull();
  });
  it("a chosen set of symbols narrows the legs; no spot means no delta", () => {
    const m = groupMetrics(pos, { underlying: "NIFTY", symbols: [PE], nowMs: NOW });
    expect(m).toMatchObject({ legs: 1, pnl: 1950, delta: null, spot: null });
  });
});

describe("alert-core: conditions and edges", () => {
  const m = groupMetrics(pos, { underlying: "NIFTY", spot: 26300, nowMs: NOW });
  it("evaluates each kind", () => {
    expect(evalCondition({ kind: "pnl_below", value: -500 }, m).met).toBe(true);
    expect(evalCondition({ kind: "pnl_above", value: 0 }, m).met).toBe(false);
    expect(evalCondition({ kind: "spot_above", value: 26250 }, m).met).toBe(true);
    expect(evalCondition({ kind: "spot_below", value: 26250 }, m).met).toBe(false);
    expect(evalCondition({ kind: "expiry_within", value: 360 }, m).met).toBe(true);
    expect(evalCondition({ kind: "premium_multiple", value: 2 }, m).met).toBe(true);
    expect(evalCondition({ kind: "delta_outside", value: -1e6, value2: 1e6 }, m).met).toBe(false);
    expect(evalCondition({ kind: "pnl_below", value: 0 }, { ...m, legs: 0 }).met).toBeNull();
  });
  it("fires once on the edge, stays quiet while true, re-arms when false, and respects the cool-down", () => {
    const r = rule([{ kind: "pnl_below", value: -500 }], { cooldownMin: 10 });
    const a = step(r, m, null, NOW);
    expect(a.fire).toBe(true);
    const b = step(r, m, a.state, NOW + 60_000);
    expect(b.fire).toBe(false);
    const ok = { ...m, pnl: 100 };
    const c = step(r, ok, b.state, NOW + 120_000);
    expect(c.state.armed).toBe(true);
    expect(step(r, m, c.state, NOW + 180_000).fire).toBe(false); // inside the 10 minute cool-down
    expect(step(r, m, c.state, NOW + 11 * 60_000).fire).toBe(true);
  });
  it("all needs every condition; any needs one; missing data is blind, not a fire", () => {
    const both = [{ kind: "pnl_below", value: -500 }, { kind: "spot_above", value: 27000 }];
    expect(step(rule(both), m, null, NOW).fire).toBe(false);
    expect(step(rule(both, { match: "any" }), m, null, NOW).fire).toBe(true);
    const blind = step(rule(both), { ...m, spot: null }, null, NOW);
    expect(blind).toMatchObject({ fire: false, met: null, state: { blind: true } });
  });
});
