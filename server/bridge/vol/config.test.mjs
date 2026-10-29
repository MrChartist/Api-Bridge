/** `vol` config section (docs/spec/p1-03-pricing-vol.md §2.5, §9.1). */
import { describe, expect, it } from "vitest";
import { yearBasisOf } from "../dashboard/pricing.js";
import { clockSettings, parseVolConfig } from "./config.mjs";

describe("vol config", () => {
  it("fills every default from {}", () => {
    const c = parseVolConfig({});
    expect(c.clock).toEqual({ mode: "weighted", nonTradingDayWeight: 0.15, overnightShare: 0.2, eventDays: {}, settlementWindowMinutes: { index: 30, stock: 30 }, yearBasis: null });
    expect(c.underlyings).toEqual(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);
    expect(c.capture).toEqual({ minutesBeforeClose: 5, retryMinutesAfterClose: 5, lateUntilMinutesAfterClose: 30, budgetShare: 0.5, strikesEachSide: 40 });
    expect(c.lookbacks).toEqual([30, 90, 252]);
    expect(c.minRankDays).toBe(20);
    expect(c.backfill.minContracts).toEqual({ index: 500, stock: 50 });
    expect(c.vix.symbol).toBe("NSE:INDIAVIX");
    expect(yearBasisOf(c.clock)).toBeCloseTo(268.95, 10);
  });

  it("is strict and bounds the weights", () => {
    expect(() => parseVolConfig({ nope: 1 })).toThrow();
    expect(() => parseVolConfig({ clock: { nonTradingDayWeight: 1.2 } })).toThrow();
    expect(() => parseVolConfig({ clock: { overnightShare: 1 } })).toThrow();
    expect(() => parseVolConfig({ clock: { settlementWindowMinutes: { index: 0 } } })).toThrow();
    expect(() => parseVolConfig({ capture: { budgetShare: 0.6 } })).toThrow();
    expect(() => parseVolConfig({ stocks: ["A", "B"], maxStocks: 1 })).toThrow();
  });

  it("validates eventDays keys and multipliers", () => {
    expect(parseVolConfig({ clock: { eventDays: { "2027-02-01": 1.5 } } }).clock.eventDays).toEqual({ "2027-02-01": 1.5 });
    expect(() => parseVolConfig({ clock: { eventDays: { "2027-02-30": 1.5 } } })).toThrow();
    expect(() => parseVolConfig({ clock: { eventDays: { "1 Feb": 1.5 } } })).toThrow();
    expect(() => parseVolConfig({ clock: { eventDays: { "2027-02-01": 6 } } })).toThrow();
  });

  it("clockSettings reads config.vol.clock, else the defaults", () => {
    expect(clockSettings(undefined).mode).toBe("weighted");
    expect(clockSettings({ vol: { clock: { mode: "trading" } } }).mode).toBe("trading");
    expect(clockSettings({ vol: { clock: { mode: "bogus" } } }).mode).toBe("weighted");
  });
});
