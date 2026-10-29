/**
 * The server clock context (vol/context.mjs) and the vol service skeleton (P1-3a): reference calendar, session and
 * rate in; weekends-only fallback without reference data; the vol contract, module routes (501 until P1-3b) and fake.
 */
import { describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS, assertService, notImplementedService } from "../core/contracts.mjs";
import { volTime } from "../dashboard/pricing.js";
import { createFakeMarketData } from "../market/fake.mjs";
import { buildClockContext, holidayDates, kindOf, pricingContext } from "./context.mjs";
import { createFakeVol } from "./fake.mjs";
import vol, { ROUTES } from "./module.mjs";
import { createVolService } from "./volService.mjs";

const at = (s) => Date.parse(`${s}+05:30`);
const fakeReference = ({ holidays = [], open = "09:15", close = "15:30", rate = 0.07 } = {}) => ({
  session: () => ({ open, close, source: "test" }),
  calendar: () => ({ holidays }),
  rate: () => ({ value: rate, quality: "user", source: "test" }),
});

describe("pricingContext", () => {
  it("takes holidays, session and rate from the reference service", () => {
    const ref = fakeReference({ holidays: [{ date: "2026-11-09", exchanges: ["NSE", "BSE"] }, { date: "2026-11-12", exchanges: ["BSE"] }] });
    const ctx = pricingContext({ config: {}, reference: ref, exchange: "NFO", kind: "index", now: at("2026-11-06T15:00:00") });
    expect(ctx).toMatchObject({ version: "vt1", mode: "weighted", settlementWindowMinutes: 30, session: { open: "09:15", close: "15:30" }, holidays: ["2026-11-09"], holidaysSource: "reference", rate: { value: 0.07, quality: "user" } });
    expect(ctx.effectiveYearBasis).toBeCloseTo(268.95, 10);
    // Example 3 of the spec with the fixture holiday.
    expect(volTime(ctx, at("2026-11-06T15:00:00"), "2026-11-10").units).toBeCloseTo(1.47133, 5);
    expect(pricingContext({ config: {}, reference: ref, exchange: "BFO" }).holidays).toEqual(["2026-11-09", "2026-11-12"]);
  });

  it("uses config vol.clock and the stock window for stocks", () => {
    const ctx = pricingContext({ config: { vol: { clock: { mode: "calendar", settlementWindowMinutes: { index: 30, stock: 20 } } } }, reference: fakeReference(), kind: "stock" });
    expect(ctx.mode).toBe("calendar");
    expect(ctx.settlementWindowMinutes).toBe(20);
  });

  it("falls back to weekends only, the default session and the default rate without reference data", () => {
    for (const reference of [undefined, notImplementedService("reference")]) {
      const ctx = pricingContext({ config: {}, reference, exchange: "NFO" });
      expect(ctx).toMatchObject({ holidays: [], holidaysSource: "unknown", session: { open: "09:15", close: "15:30" }, rate: { value: 0.065, quality: "default" } });
    }
  });

  it("helpers", () => {
    expect(kindOf("NIFTY")).toBe("index");
    expect(kindOf("reliance")).toBe("stock");
    expect(holidayDates([{ date: "a", exchanges: ["NSE"] }, { date: "b", exchanges: ["BSE"] }], "BFO")).toEqual(["b"]);
    expect(buildClockContext({ settings: { mode: "trading", nonTradingDayWeight: 0.1, overnightShare: 0, eventDays: {}, settlementWindowMinutes: { index: 15, stock: 30 }, yearBasis: null }, session: { open: "09:15", close: "15:30" } })).toMatchObject({ mode: "trading", settlementWindowMinutes: 15, effectiveYearBasis: 252 });
  });
});

describe("vol service skeleton (P1-3a)", () => {
  it("has the contract, ten routes and a fake that satisfies it", () => {
    expect(SERVICE_CONTRACTS.vol).toMatchObject({ stream: "S18", requires: ["marketData", "reference", "symbols", "scheduler"] });
    expect(SERVICE_CONTRACTS.vol.methods).toContain("logPredictions");
    expect(vol).toMatchObject({ name: "vol", stream: "S18", configKey: "vol" });
    expect(ROUTES).toHaveLength(10);
    expect(ROUTES.filter(([, , o]) => o.loopbackOnly).map(([m, p]) => `${m} ${p}`)).toEqual(["POST /v1/vol/capture", "POST /v1/vol/backfill", "DELETE /v1/vol/backfill"]);
    expect(() => assertService("vol", createFakeVol())).not.toThrow();
  });

  it("clock() returns settings, holidays and T per expiry with the breakdown; the rest is not built yet", async () => {
    const md = createFakeMarketData();
    md.setExpiries("NIFTY", ["2026-11-03", "2026-11-17"]);
    // The clock costs 0 broker calls (§7): listed expiries come from the instrument master, never marketData.
    md.expiries = () => {
      throw new Error("the clock must not call marketData.expiries");
    };
    const searches = [];
    const symbols = {
      search: async (q) => {
        searches.push(q);
        const rows = ["2026-10-27", "2026-11-03", "2026-11-17", "2027-01-26", "2027-03-30"].flatMap((e) => [{ underlying: "NIFTY", expiry: e }, { underlying: "NIFTYNXT50", expiry: "2026-11-04" }]);
        return { items: rows, nextCursor: null };
      },
    };
    const holidays = [
      { date: "2026-10-02", label: "Past", exchanges: ["NSE", "BSE"], verified: true },
      { date: "2026-11-24", label: "Guru Nanak Jayanti", exchanges: ["NSE", "BSE"], verified: false },
      { date: "2026-12-25", label: "BSE only", exchanges: ["BSE"], verified: true },
      { date: "2028-01-26", label: "Too far", exchanges: ["NSE", "BSE"], verified: true },
    ];
    const svc = createVolService({ config: {}, clock: { now: () => at("2026-10-29T10:00:00") }, marketData: md, symbols, reference: fakeReference({ rate: 0.065, holidays }) });
    assertService("vol", svc);
    const c = await svc.clock({ underlying: "nifty" });
    expect(searches[0]).toMatchObject({ underlying: "NIFTY", kind: "OPT", exchange: "NFO" });
    // Listed expiries from today to 100 calendar days ahead (past and later ones dropped, other underlyings ignored).
    expect(c.expiries.map((e) => e.expiry)).toEqual(["2026-11-03", "2026-11-17", "2027-01-26"]);
    // Holidays in [at, at + 400 days] for the exchange, with label and verified.
    expect(c.holidays).toEqual([{ date: "2026-11-24", label: "Guru Nanak Jayanti", verified: false }]);
    expect((await svc.clock({ underlying: "NIFTY", expiries: ["2026-11-03"] })).expiries).toHaveLength(1);
    expect(c).toMatchObject({ underlying: "NIFTY", exchange: "NFO", at: "2026-10-29T10:00:00.000+05:30", settings: { version: "vt1", mode: "weighted", nonTradingDayWeight: 0.15, overnightShare: 0.2, settlementWindowMinutes: 30 } });
    expect(c.settings.yearBasis).toBeCloseTo(268.95, 10);
    expect(c.expiries[0]).toMatchObject({ expiry: "2026-11-03" });
    // The fixture holiday (24 Nov) is after this expiry, so example 1 holds.
    expect(c.expiries[0].T).toBeCloseTo(0.0147289, 7);
    expect(c.expiries[0].units).toBeCloseTo(3.96133, 5);
    expect(c.expiries[0].parts.length).toBeGreaterThan(4);
    await expect(svc.clock({ underlying: "NIFTY", at: "not a time" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(() => svc.rank({ underlying: "NIFTY" })).toThrow(/not implemented|P1-3b/i);
  });
});
