/**
 * The fno config section (docs/spec/p1-06-stocks.md §2.5): defaults, ranges and strictness.
 */
import { describe, expect, it } from "vitest";
import { parseFnoConfig } from "./config.mjs";

describe("fno config", () => {
  it("defaults", () => {
    const c = parseFnoConfig(undefined);
    expect(c.sweep).toMatchObject({ budgetShare: 0.5, maxMinutes: 10, method: "auto", stockStrikes: 15, indexStrikes: 30, stockExpiries: 1, minIntervalSeconds: 120, leaseSeconds: 180 });
    expect(c.expiry).toEqual({ warnFromTradingDays: 4, closeToMoneyStrikes: 1 });
    expect(c.ban.blockOpening).toBe(true);
    expect(c.universe).toEqual({ indices: null, exchanges: ["NFO"], maxStocks: 400 });
  });
  it.each([
    [{ sweep: { budgetShare: 0.6 } }],
    [{ sweep: { budgetShare: 0.05 } }],
    [{ sweep: { stockStrikes: 4 } }],
    [{ sweep: { stockStrikes: 31 } }],
    [{ sweep: { indexStrikes: 9 } }],
    [{ sweep: { stockExpiries: 3 } }],
    [{ sweep: { minIntervalSeconds: 30 } }],
    [{ universe: { exchanges: ["BFO"] } }],
    [{ unknown: true }],
    [{ sweep: { nope: 1 } }],
  ])("refuses %j", (raw) => {
    expect(() => parseFnoConfig(raw)).toThrow();
  });
});
