/**
 * Sweep feasibility (docs/spec/p1-06-stocks.md §6.9): every row of the worked table from a frozen policy snapshot
 * (__fixtures__/policies.json), N = 180 stocks, 12 index chains, ±15 strikes (L = 62), 50 % budget, 375 session
 * minutes. Index chains served by a chain endpoint carry their own spot (indexSpots 0).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoIntervalSeconds, perMinuteOf, planSweep, rateOf, sameBudget } from "./plan.mjs";

const { policies } = JSON.parse(readFileSync(new URL("./__fixtures__/policies.json", import.meta.url), "utf8"));
const cfg = { budgetShare: 0.5, maxMinutes: 10, stockStrikes: 15, indexStrikes: 30, minIntervalSeconds: 120 };
const plan = (broker, over = {}) =>
  planSweep({ broker, policy: policies[broker], caps: { optionChain: true }, quotesVerified: true, indexKeys: 12, indexSpots: 0, stocks: 180, stockExpiries: 1, cfg, sessionMinutes: 375, ...over });
const group = (p, kind) => p.groups.find((g) => g.kind === kind);

describe("rates (R per class)", () => {
  it("Dhan chain 20/min, quote 1/s; Upstox standard min(3000, 500, 66.7); Fyers dataApis 50/min", () => {
    expect(perMinuteOf(policies.dhan, "chain")).toBe(20);
    expect(rateOf(policies.dhan, "chain", 0.5)).toBe(10);
    expect(rateOf(policies.dhan, "quote", 0.5)).toBe(30);
    expect(rateOf(policies.upstox, "chain", 0.5)).toBeCloseTo(33.333, 2);
    expect(rateOf(policies.fyers, "chain", 0.5)).toBe(25);
    expect(rateOf(policies.zerodha, "quote", 0.5)).toBe(30);
    expect(sameBudget(policies.zerodha, "quote", "chain")).toBe(true);
    expect(sameBudget(policies.dhan, "quote", "chain")).toBe(false);
  });
});

describe("§6.9 worked table", () => {
  it("Dhan: index chains 12 calls / 1.2 min; stocks by quotes (chain would be 18 min): 12 calls / 0.4 min; 1.6 min; 120 s", () => {
    const p = plan("dhan");
    expect(group(p, "index")).toMatchObject({ method: "chain", calls: 12, class: "chain", minutes: 1.2 });
    expect(group(p, "stock")).toMatchObject({ method: "quotes", calls: 12, class: "quote", minutes: 0.4 });
    expect(p).toMatchObject({ fits: true, limited: false, minutes: 1.6, autoIntervalSec: 120, maxStocksThatFit: 180 });
    expect(p.message).toMatch(/all 180 stocks/);
    expect(p.basis).toMatch(/^dhan policy: chain 20\/min \(unverified\), quote 1\/s × 1000 instruments/);
  });

  it("Zerodha: no chain endpoint, index chains built from quotes (2 calls each = 24); stocks 23 quote calls; 1.6 min; 120 s", () => {
    const p = plan("zerodha", { caps: { optionChain: false } });
    expect(group(p, "index")).toMatchObject({ calls: 24, class: "quote" });
    expect(group(p, "stock")).toMatchObject({ method: "quotes", calls: 23 });
    expect(p).toMatchObject({ fits: true, minutes: 1.6, autoIntervalSec: 120 });
  });

  it("Upstox: chain for all 180 stocks (broker ΔOI): 192 calls, 5.8 min; the 30-minute window raises the interval to 360 s", () => {
    const p = plan("upstox");
    expect(group(p, "stock")).toMatchObject({ method: "chain", calls: 180 });
    expect(p).toMatchObject({ fits: true, minutes: 5.8, autoIntervalSec: 360 });
  });

  it("Upstox, expiry week: chain would be 11.2 min, so quotes: 45 calls; 57 calls 1.7 min; 120 s", () => {
    const p = plan("upstox", { stockExpiries: 2 });
    expect(group(p, "stock")).toMatchObject({ method: "quotes", calls: 45 });
    expect(p).toMatchObject({ fits: true, minutes: 1.7, autoIntervalSec: 120 });
  });

  it("Fyers: chain 192 calls, 7.7 min; the 5,000/day cap raises the interval to 1,728 s", () => {
    const p = plan("fyers", { quotesVerified: false });
    expect(group(p, "stock")).toMatchObject({ method: "chain", calls: 180 });
    expect(p).toMatchObject({ fits: true, minutes: 7.7, autoIntervalSec: 1728 });
  });

  it("Fyers, expiry week: neither path fits; chain covers floor((10 × 25 − 12) / 2) = 119 stocks", () => {
    const p = plan("fyers", { quotesVerified: false, stockExpiries: 2, optIn: 180 });
    expect(p).toMatchObject({ fits: false, limited: true, maxStocksThatFit: 119 });
    expect(group(p, "stock")).toMatchObject({ method: "chain", stocks: 119, calls: 238 });
    expect(p.message).toMatch(/can sweep 119 stocks in 10 minutes with 2 expiries each/);
    expect(p.autoIntervalSec).toBeGreaterThanOrEqual(1728);
  });

  it("conservative defaults (unknown broker: 1/s shared by quote and chain, B = 1, no chain endpoint): a few stocks only", () => {
    const policy = { limits: { quote: { perSecond: 1 }, chain: { perSecond: 1 } }, groups: { quoteFamily: { perSecond: 1, classes: ["quote", "depth", "chain"] } }, maxQuoteBatch: 1 };
    const p = planSweep({ broker: "unknownbroker", policy, caps: { optionChain: false }, quotesVerified: false, indexKeys: 0, indexSpots: 0, stocks: 180, stockExpiries: 1, cfg, sessionMinutes: 375 });
    expect(p.limited).toBe(true);
    expect(p.maxStocksThatFit).toBeGreaterThan(0);
    expect(p.maxStocksThatFit).toBeLessThanOrEqual(20);
    expect(p.message).toMatch(/can sweep \d+ stocks in 10 minutes/);
  });

  it("demo: quotes for stocks (both methods on screen), everything fits in well under a minute", () => {
    const p = plan("demo", { stocks: 50, indexKeys: 6, preferQuotes: true });
    expect(group(p, "index")).toMatchObject({ method: "chain", class: "chain" });
    expect(group(p, "stock")).toMatchObject({ method: "quotes", calls: Math.ceil((50 * 62 + 50) / 200) });
    expect(p.fits).toBe(true);
    expect(p.minutes).toBeLessThan(1);
    expect(p.autoIntervalSec).toBe(120);
  });
});

describe("method choices", () => {
  it("an unverified quote path falls back to chain", () => {
    const p = plan("dhan", { quotesVerified: false });
    expect(group(p, "stock").method).toBe("chain");
    expect(p.limited).toBe(true);
    expect(p.maxStocksThatFit).toBe(Math.floor(10 * 10 - 12));
  });
  it("method forced to quotes on an unverified broker → CAPABILITY_UNSUPPORTED", () => {
    expect(plan("fyers", { quotesVerified: false, method: "quotes" }).error.code).toBe("CAPABILITY_UNSUPPORTED");
  });
  it("auto interval from a daily window alone", () => {
    expect(autoIntervalSeconds(policies.fyers, { chain: 192 }, { share: 0.5, minIntervalSeconds: 120, sessionMinutes: 375 })).toBe(1728);
    expect(autoIntervalSeconds(policies.dhan, { chain: 12, quote: 12 }, { share: 0.5, minIntervalSeconds: 120, sessionMinutes: 375 })).toBe(120);
  });
});
