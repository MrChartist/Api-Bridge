/**
 * vol-context.js (docs/spec/p1-03-pricing-vol.md §5.1): the client clock context from GET /v1/vol/clock, the 10-minute
 * cache and the fallback, the method-note lines, and the next-session decay in trading days.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as O from "./options.js";
import { readFileSync } from "node:fs";
import { checkSource, findBanned } from "./copyRules.mjs";
import { CLOCK_RETRY_MS, clearClockCache, clockNote, contextFromClock, loadPricingContext, nextSessionUnits } from "./vol-context.js";

const at = (s) => Date.parse(`${s}+05:30`);
const PAYLOAD = {
  underlying: "NIFTY",
  settings: { version: "vt1", mode: "weighted", nonTradingDayWeight: 0.15, overnightShare: 0.2, eventDays: {}, yearBasis: 268.95, settlementWindowMinutes: 30, session: { open: "09:15", close: "15:30" }, holidays: "reference" },
  rate: { value: 0.065, quality: "default" },
  holidays: [{ date: "2026-11-24", label: "Guru Nanak Jayanti", verified: false }],
  expiries: [],
};

afterEach(() => {
  O.setPricingContext(null);
  clearClockCache();
});

describe("vol-context", () => {
  it("builds the context from the clock payload and makes it the page's clock (cached 10 minutes)", async () => {
    expect(contextFromClock(PAYLOAD)).toMatchObject({ mode: "weighted", yearBasis: 268.95, settlementWindowMinutes: 30, session: { open: "09:15", close: "15:30" }, holidays: ["2026-11-24"], loaded: true });
    expect(contextFromClock({})).toBeNull();
    const calls = [];
    const get = async (p) => (calls.push(p), PAYLOAD);
    const ctx = await loadPricingContext("nifty", { get, now: 0 });
    expect(calls).toEqual(["/v1/vol/clock?underlying=NIFTY"]);
    expect(ctx.loaded).toBe(true);
    expect(O.getPricingContext()).toBe(ctx);
    await loadPricingContext("NIFTY", { get, now: 5 * 60_000 });
    expect(calls).toHaveLength(1);
    await loadPricingContext("NIFTY", { get, now: 11 * 60_000 });
    expect(calls).toHaveLength(2);
  });

  it("keeps the weekends-only default when the route fails, and asks again after a minute", async () => {
    const calls = [];
    const get = async (p) => {
      calls.push(p);
      throw new Error("404");
    };
    const ctx = await loadPricingContext("NIFTY", { get, now: 0 });
    expect(ctx).toMatchObject({ holidaysSource: "not-loaded" });
    expect(clockNote(ctx).at(-1)).toBe("Holidays not loaded yet: weekends only.");
    await loadPricingContext("NIFTY", { get, now: CLOCK_RETRY_MS - 1 });
    expect(calls).toHaveLength(1);
    await loadPricingContext("NIFTY", { get, now: CLOCK_RETRY_MS + 1 });
    expect(calls).toHaveLength(2);
  });

  it("a failed load for another underlying drops the previous underlying's clock (weekends-only, labelled)", async () => {
    await loadPricingContext("NIFTY", { get: async () => PAYLOAD, now: 0 });
    expect(O.getPricingContext()).toMatchObject({ underlying: "NIFTY", loaded: true });
    const ctx = await loadPricingContext("SENSEX", { get: async () => { throw new Error("503"); }, now: 1000 });
    expect(ctx).toMatchObject({ holidaysSource: "not-loaded" });
    expect(ctx.loaded).toBeFalsy();
    expect(clockNote(ctx).at(-1)).toBe("Holidays not loaded yet: weekends only.");
    // Back on NIFTY (still cached) its clock returns; a failed refresh of the same underlying keeps it.
    expect(await loadPricingContext("NIFTY", { get: async () => PAYLOAD, now: 2000 })).toMatchObject({ underlying: "NIFTY", loaded: true });
    expect(await loadPricingContext("NIFTY", { force: true, get: async () => { throw new Error("503"); }, now: 3000 })).toMatchObject({ underlying: "NIFTY", loaded: true });
  });

  it("method-note lines state the clock, its weights, the settlement window and calendar interest; neutral copy", () => {
    const lines = clockNote(contextFromClock(PAYLOAD));
    expect(lines).toEqual([
      "Time: weighted vol-time clock (trading day 1, weekend/holiday day 0.15, overnight share 0.20, 268.95 units a year). The weights are assumptions, not measured.",
      "Expiry day: the 30-minute settlement window counts one third.",
      "Interest (discounting, parity forward, carry) uses calendar days.",
    ]);
    expect(clockNote({ mode: "calendar", session: { open: "09:15", close: "15:30" }, loaded: true })[0]).toMatch(/ACT\/365/);
    expect(clockNote({ mode: "trading", session: { open: "09:15", close: "15:30" }, loaded: true })[0]).toMatch(/252 days a year/);
    for (const l of lines) expect(findBanned(l)).toEqual([]);
    expect(checkSource(readFileSync(new URL("./vol-context.js", import.meta.url), "utf8"))).toEqual([]);
  });

  it("the next session decays 1.0 trading day on a weekday and 1.3 from Friday to Monday", () => {
    const ctx = contextFromClock(PAYLOAD);
    expect(nextSessionUnits(ctx, at("2026-10-29T15:00:00"))).toBeCloseTo(1, 9);
    expect(nextSessionUnits(ctx, at("2026-10-30T15:00:00"))).toBeCloseTo(1.3, 9);
  });
});
