/**
 * backfill/proxy.mjs (docs/spec/p1-03-pricing-vol.md §6.10, §9.1): forward source order (future, future carried,
 * parity on closes); the minContracts filter; non-standard contracts excluded; THIN; a fixture day whose closes are
 * Black-76 prices at 13 % gives proxy ATM IV 13.00 ± 0.02.
 */
import { describe, expect, it } from "vitest";
import { black76, volTime } from "../../dashboard/pricing.js";
import { buildClockContext } from "../context.mjs";
import { proxyRows, tradingDte } from "./proxy.mjs";

const IST = (s) => Date.parse(`${s}+05:30`);
const ctx = buildClockContext({ settings: null, session: { open: "09:15", close: "15:30" }, rate: { value: 0.065, quality: "default" } });
const DATE = "2026-10-29";
const CLOSE = IST(`${DATE}T15:30:00`);

/** A parsed day priced at a flat σ: futures settle at the forward, option closes at discounted Black-76. */
function fixtureDay({ sigma = 13, spot = 25120, expiries = ["2026-11-17", "2026-12-01"], futures = "all", contracts = 5000, step = 50 } = {}) {
  const options = [];
  const futs = [];
  for (const e of expiries) {
    const vt = volTime(ctx, CLOSE, e);
    const df = Math.exp(-0.065 * vt.Tcal);
    const F = spot / df;
    if (futures === "all" || (futures === "first" && e === expiries[0])) futs.push({ expiry: e, settle: F });
    const centre = Math.round(spot / step) * step;
    for (let i = -6; i <= 6; i += 1) {
      const k = centre + i * step;
      for (const right of ["CE", "PE"]) options.push({ expiry: e, strike: k, right, close: df * black76(F, k, vt.T, sigma, right), contracts });
    }
  }
  return { underlying: "NIFTY", exchange: "NFO", date: DATE, spot, futures: futs, options };
}

describe("proxy ATM IV (§6.10)", () => {
  it("a 13 % fixture day gives 13.00 ± 0.02 with the same-expiry future as the forward", () => {
    const { rows, dropped } = proxyRows(fixtureDay(), { ctx, closeMs: CLOSE, minContracts: 500 });
    expect(dropped).toEqual([]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Math.abs(r.atmIv - 13)).toBeLessThanOrEqual(0.02);
      expect(r).toMatchObject({ quality: "backfill-eod", forwardSource: "future", trigger: "backfill", source: "nse-bhavcopy-udiff" });
      expect(Object.keys(r.contracts).length).toBeGreaterThanOrEqual(2);
      expect(r.tv).toBeCloseTo((r.atmIv / 100) ** 2 * r.clock.T, 8);
    }
  });

  it("forward source order: future, then the near future carried, then parity on closes", () => {
    const carried = proxyRows(fixtureDay({ futures: "first" }), { ctx, closeMs: CLOSE });
    expect(carried.rows.map((r) => r.forwardSource)).toEqual(["future", "future-carried"]);
    expect(Math.abs(carried.rows[1].atmIv - 13)).toBeLessThanOrEqual(0.02);
    const parity = proxyRows(fixtureDay({ futures: "none" }), { ctx, closeMs: CLOSE });
    expect(parity.rows.map((r) => r.forwardSource)).toEqual(["parity-close", "parity-close"]);
    expect(Math.abs(parity.rows[0].atmIv - 13)).toBeLessThanOrEqual(0.02);
  });

  it("drops strikes under minContracts, non-standard contracts and thin days; keeps 2–70 trading days to expiry", () => {
    expect(proxyRows(fixtureDay({ contracts: 100 }), { ctx, closeMs: CLOSE, minContracts: 500 }).dropped).toEqual([
      { expiry: "2026-11-17", reason: "THIN" },
      { expiry: "2026-12-01", reason: "THIN" },
    ]);
    const day = fixtureDay();
    for (const o of day.options) o.nonStandard = true;
    expect(proxyRows(day, { ctx, closeMs: CLOSE }).rows).toEqual([]);
    // One day to expiry is too short; far expiries beyond 70 trading days are skipped.
    expect(proxyRows(fixtureDay({ expiries: ["2026-10-30", "2027-06-29"] }), { ctx, closeMs: CLOSE }).rows).toEqual([]);
    expect(tradingDte(ctx, "2026-10-29", "2026-11-03")).toBe(3);
  });
});
