import { describe, expect, it } from "vitest";
import { BOOK_NOTES, aggregate, legPnl, markOf, noDataReason, priceHolder, priceLeg, selectLeg, underlyingGreeks } from "./book-core.js";
import { greeks76 } from "./pricing.js";

// §7.13 worked example: per-unit Greeks given, so the aggregation is checked on its own.
const SELF = {
  holder: "self",
  label: "Me",
  relationship: "self",
  inFamily: true,
  priceSource: { kind: "account", broker: "zerodha" },
  accounts: [
    { account: "zerodha-main", broker: "zerodha", mode: "live", margin: { used: 145200, available: 310000, asOf: "t", source: "broker" }, error: null },
    { account: "dhan-main", broker: "dhan", mode: "live", margin: { used: 38400, available: 120000, asOf: "t", source: "broker" }, error: null },
  ],
  underlyings: [
    {
      underlying: "NIFTY",
      spot: 25120,
      lot: 65,
      legs: [
        { account: "zerodha-main", symbol: "NFO:NIFTY-2026-11-03-25600-CE", kind: "OPT", q: -130, avg: 82.4, mark: 120, greeks: { delta: 0.42, gamma: 0.00031, theta: -9.8, vega: 11.2 } },
        { account: "dhan-main", symbol: "NFO:NIFTY-2026-11-24-FUT", kind: "FUT", q: 65, avg: 25150, mark: 25190, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } },
      ],
    },
  ],
};
const SPOUSE = {
  holder: "spouse",
  label: "Asha",
  relationship: "spouse",
  inFamily: true,
  priceSource: { kind: "account", broker: "upstox" },
  accounts: [{ account: "upstox-asha", broker: "upstox", mode: "live", margin: { used: 62000, available: 82340, asOf: "t", source: "broker" }, error: null }],
  underlyings: [
    { underlying: "SENSEX", spot: 82300, lot: 20, legs: [{ account: "upstox-asha", symbol: "BFO:SENSEX-2026-11-05-83500-CE", kind: "OPT", q: -40, avg: 245, mark: 210, greeks: { delta: 0.3, gamma: 0.0001, theta: -14.5, vega: 18 } }] },
  ],
};
const FRIEND = {
  holder: "friend",
  label: "friend",
  relationship: "other",
  inFamily: false,
  priceSource: { kind: "account", broker: "dhan" },
  accounts: [{ account: "dhan-friend", broker: "dhan", mode: "live", margin: { used: 1000, available: 2000 }, error: null }],
  underlyings: [{ underlying: "NIFTY", spot: 25120, lot: 65, legs: [{ account: "dhan-friend", symbol: "NFO:NIFTY-2026-11-24-FUT", kind: "FUT", q: 65, avg: 25100, mark: 25190, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } }] }],
};

describe("book aggregation (§7.13)", () => {
  it("self NIFTY: Δ 10.4 units = 0.16 lots, ₹Δ 2,61,248, Θ +1,274, Vega −1,456, P&L −2,288", () => {
    const s = priceHolder(SELF);
    expect(s.underlyings[0].greeks).toEqual({ delta: 10.4, deltaLots: 0.16, rupeeDelta: 261248, gamma: -0.0403, theta: 1274, vega: -1456, missing: 0 });
    expect(s.underlyings[0].legs.map((l) => l.pnl)).toEqual([-4888, 2600]);
    expect(s.accounts.map((a) => [a.account, a.pnl, a.positions])).toEqual([["zerodha-main", -4888, 1], ["dhan-main", 2600, 1]]);
    expect(s.totals).toEqual({ pnl: -2288, theta: 1274, vega: -1456, rupeeDelta: 261248, marginUsed: 183600, marginAvailable: 430000 });
  });

  it("spouse SENSEX: P&L +1,400, Δ −12, ₹Δ −9,87,600, Θ +580, Vega −720", () => {
    const s = priceHolder(SPOUSE);
    expect(s.underlyings[0].greeks).toMatchObject({ delta: -12, rupeeDelta: -987600, theta: 580, vega: -720 });
    expect(s.totals.pnl).toBe(1400);
  });

  it("family: P&L −888, Θ +1,854, Vega −2,176, ₹Δ −7,26,352, margin used 2,45,600; outside holders listed, not added", () => {
    const holders = [SELF, SPOUSE, FRIEND].map(priceHolder);
    const body = aggregate(holders, { view: "family", family: { name: "Family", relationships: ["self", "spouse"] }, asOf: "2026-10-29T11:15:04+05:30" });
    expect(body.family.totals).toEqual({ pnl: -888, realised: 0, unrealised: -888, theta: 1854, vega: -2176, rupeeDelta: -726352, marginUsed: 245600, marginAvailable: 512340, accounts: 3, partial: false });
    expect(body.family.holders).toEqual(["self", "spouse"]);
    expect(body.holders.map((h) => h.holder)).toEqual(["self", "spouse"]);
    expect(body.outsideFamily).toEqual([{ holder: "friend", label: "friend", relationship: "other", accounts: 1, note: BOOK_NOTES.outside }]);
    expect(body.family.notes).toEqual([BOOK_NOTES.family]);
    // Totals equal the sum of the family holders' totals.
    expect(body.family.totals.pnl).toBe(body.holders.reduce((s, h) => s + h.totals.pnl, 0));
    // Every leg keeps its account.
    expect(body.holders.flatMap((h) => h.underlyings.flatMap((u) => u.legs)).every((l) => typeof l.account === "string")).toBe(true);
  });

  it("view=holders: every visible holder, no family block, outsideFamily empty", () => {
    const body = aggregate([SELF, FRIEND].map(priceHolder), { view: "holders", family: { name: "Family", relationships: ["self"] }, asOf: "t" });
    expect(body.family).toBeNull();
    expect(body.holders.map((h) => h.holder)).toEqual(["self", "friend"]);
    expect(body.outsideFamily).toEqual([]);
  });

  it("Δ in units is not summed across underlyings (only ₹Δ, Θ and Vega are)", () => {
    const two = {
      ...SELF,
      underlyings: [...SELF.underlyings, { underlying: "BANKNIFTY", spot: 56000, lot: 35, legs: [{ account: "zerodha-main", symbol: "NFO:BANKNIFTY-2026-11-24-FUT", kind: "FUT", q: 35, avg: 56000, mark: 56000, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } }] }],
    };
    const s = priceHolder(two);
    expect(s.totals).not.toHaveProperty("delta");
    expect(s.totals.rupeeDelta).toBe(261248 + 35 * 56000);
  });

  it("partial totals for a key limited to some accounts", () => {
    const body = aggregate([priceHolder(SELF)], { view: "family", family: { name: "Family", relationships: ["self"] }, partial: true, asOf: "t" });
    expect(body.family.totals.partial).toBe(true);
    expect(body.partial).toBe(true);
  });

  it("a holder without a data account: Greeks null, P&L from the broker", () => {
    const h = priceHolder({
      ...SPOUSE,
      priceSource: { kind: "none", reason: noDataReason("Asha") },
      underlyings: [{ underlying: "SENSEX", spot: null, lot: 20, legs: [{ account: "upstox-asha", symbol: "BFO:SENSEX-2026-11-05-83500-CE", kind: "OPT", q: -40, avg: 245, mark: null, brokerPnl: 1350, greeks: null }] }],
    });
    expect(h.underlyings[0].greeks).toBeNull();
    expect(h.totals).toMatchObject({ pnl: 1350, theta: null, vega: null, rupeeDelta: null });
    expect(h.priceSource.reason).toBe("No market-data account for Asha; Greeks need spot and IV from that holder's own data.");
  });

  it("an account that could not be read has null P&L and does not fail the holder", () => {
    const h = priceHolder({ ...SELF, accounts: [SELF.accounts[0], { ...SELF.accounts[1], error: { code: "BROKER_UNAVAILABLE", message: "x" }, margin: null }], underlyings: [{ ...SELF.underlyings[0], legs: [SELF.underlyings[0].legs[0]] }] });
    expect(h.accounts[1].pnl).toBeNull();
    expect(h.totals.pnl).toBe(-4888);
  });

  it("underlyingGreeks counts unpriced legs as missing and is null when none is priced", () => {
    expect(underlyingGreeks([{ q: 1, greeks: null }], { spot: 1, lot: 1 })).toBeNull();
    expect(underlyingGreeks([{ q: 65, greeks: { delta: 1, gamma: 0, theta: 0, vega: 0 } }, { q: 1, greeks: null }], { spot: 100, lot: 65 })).toMatchObject({ delta: 65, deltaLots: 1, missing: 1 });
  });
});

describe("marks and leg pricing", () => {
  it("mid within the 15 % spread cap, else LTP", () => {
    expect(markOf({ bid: 160.1, ask: 160.7, ltp: 160.5 })).toEqual({ mark: 160.4, basis: "mid" });
    expect(markOf({ bid: 1, ask: 2, ltp: 1.6 })).toEqual({ mark: 1.6, basis: "ltp" });
    expect(markOf({ bid: null, ask: null, ltp: 0 })).toEqual({ mark: null, basis: null });
  });

  it("legPnl: realised + q·(mark − avg), else the broker figure", () => {
    expect(legPnl({ q: -130, avg: 82.4, mark: 120 })).toBeCloseTo(-4888, 6);
    expect(legPnl({ q: -130, avg: 82.4, mark: null, brokerPnl: -4000 })).toBe(-4000);
    expect(legPnl({ q: 10, avg: 100, mark: 110, realised: 50 })).toBe(150);
  });

  it("priceLeg solves IV from the mark on the forward and matches pricing.js Greeks", () => {
    const env = { spot: 25120, T: 0.02, Tcal: 0.0137, rate: 0.065, yearBasis: 269 };
    const F = 25120 * Math.exp(0.065 * 0.0137);
    const r = priceLeg({ kind: "OPT", right: "CE", strike: 25600, mark: 120 }, env);
    expect(r.iv).toBeGreaterThan(5);
    expect(r.iv).toBeLessThan(40);
    const g = greeks76(F, 25600, 0.02, r.iv, "CE", { yearBasis: 269 });
    expect(r.greeks.delta).toBeCloseTo(g.delta, 10);
    expect(r.greeks.theta).toBeLessThan(0);
    expect(priceLeg({ kind: "FUT", mark: 25190 }, env).greeks).toEqual({ delta: 1, gamma: 0, theta: 0, vega: 0 });
    expect(priceLeg({ kind: "OPT", right: "CE", strike: 25600, mark: 120 }, { ...env, spot: null }).greeks).toBeNull();
  });
});

describe("one-account bulk selection", () => {
  it("selecting a leg of another account clears the selection", () => {
    let s = selectLeg([], { account: "a", symbol: "x" });
    expect(s).toEqual({ selected: [{ account: "a", symbol: "x" }], cleared: false });
    s = selectLeg(s.selected, { account: "a", symbol: "y" });
    expect(s.selected).toHaveLength(2);
    s = selectLeg(s.selected, { account: "b", symbol: "z" });
    expect(s).toEqual({ selected: [{ account: "b", symbol: "z" }], cleared: true });
    s = selectLeg(s.selected, { account: "b", symbol: "z" });
    expect(s).toEqual({ selected: [], cleared: false });
  });
});
