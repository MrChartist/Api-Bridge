/**
 * readExpiryCosts and cached quotes (docs/spec/p1-06-stocks.md §3.5): a missing spot, bid or ask is filled only from a
 * cached quote at most CACHED_QUOTE_MAX_AGE_MS old, and the response notes when it did so. No broker call either way.
 */
import { describe, expect, it } from "vitest";
import { createCalendar } from "../reference/calendar.mjs";
import { SHIPPED_CHARGES, SHIPPED_DELIVERY_MARGIN, shippedHolidayRows } from "../reference/shipped.mjs";
import { CACHED_QUOTE_MAX_AGE_MS, expiryCostsRequest, readExpiryCosts } from "./routes.mjs";

const NOW = Date.parse("2026-11-19T10:00:00+05:30");
const EXP = "2026-11-24";
const LEG = `NFO:RELIANCE-${EXP}-1420-CE`;

function setup(entries) {
  const cache = {
    getStale: (key, maxStaleMs) => {
      const e = entries[key];
      return e && NOW - e.at <= maxStaleMs ? e : null;
    },
  };
  const f = {
    now: () => NOW,
    cfg: { expiry: { warnFromTradingDays: 4, closeToMoneyStrikes: 1 } },
    universe: { detail: async () => ({ item: { underlying: "RELIANCE", kind: "stock", spot: "NSE:RELIANCE", settlement: "physical", strikeStep: 20 }, facts: { perExpiry: [{ date: EXP, strikeStep: 20 }] } }) },
    heldShares: async () => null,
  };
  const deps = {
    reference: { charges: () => ({ ...structuredClone(SHIPPED_CHARGES), brokerage: { kind: "flat", perOrder: 20 } }), calendar: () => createCalendar({ holidays: shippedHolidayRows() }), deliveryMargin: () => ({ items: SHIPPED_DELIVERY_MARGIN?.items ?? [] }) },
    symbols: { resolve: async () => ({ canonical: LEG, kind: "OPT", underlying: "RELIANCE", expiry: EXP, strike: 1420, right: "CE", exchange: "NFO" }) },
    marketData: { cache },
  };
  return { f, deps };
}
const quote = (at, fields) => ({ at, value: { fields } });
const req = () => expiryCostsRequest({ underlying: "RELIANCE", legs: [{ symbol: LEG, qty: 500 }] });

describe("expiry costs from cached quotes", () => {
  it("a recent cached spot and bid/ask are used and labelled with their time", async () => {
    const { f, deps } = setup({ "q|NSE:RELIANCE": quote(NOW - 5 * 60_000, { ltp: 1452.3 }), [`q|${LEG}`]: quote(NOW - 2 * 60_000, { bid: 33.8, ask: 34.2 }) });
    const r = await readExpiryCosts(f, deps, req());
    expect(r.spot).toBe(1452.3);
    expect(r.legs[0].moneyness).toBe("ITM");
    expect(r.legs[0].squareOff).not.toBeNull();
    expect(r.notes).toContain("Spot from a cached quote at 09:55 IST.");
    expect(r.notes).toContain("Bid and ask from cached quotes (oldest at 09:58 IST).");
  });

  it("an old cached quote is ignored: no spot, no moneyness, and the response says spot is missing", async () => {
    const old = NOW - CACHED_QUOTE_MAX_AGE_MS - 60_000;
    const { f, deps } = setup({ "q|NSE:RELIANCE": quote(old, { ltp: 1452.3 }), [`q|${LEG}`]: quote(old, { bid: 33.8, ask: 34.2 }) });
    const r = await readExpiryCosts(f, deps, req());
    expect(r.spot).toBeNull();
    expect(r.notes).toContain("No spot price was given or cached: moneyness and delivery figures need spot.");
    expect(r.notes.some((n) => /cached quote/.test(n))).toBe(false);
  });
});
