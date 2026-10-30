import { describe, expect, it } from "vitest";
import { charges } from "./options.js";
import { refCharges } from "./reference.js";

const FALLBACK_RATES = refCharges(null);
import { tradeTotals } from "./orders-core.js";
import { byFinancialYear, fifoRealised, fillChargesWith, fillTotals, financialYear, statement } from "./statement-core.js";

const OPT = "NFO:NIFTY-2026-11-03-25000-CE";
const T = (at, side, qty, price, o = {}) => ({ tradedAt: at, side, qty, price, symbol: OPT, product: "MARGIN", ...o });
const trades = [
  T("2026-03-20T10:00:00+05:30", "BUY", 130, 100), // FY 2025-26
  T("2026-03-27T10:00:00+05:30", "SELL", 65, 120), // +1300 in FY 2025-26
  T("2026-04-02T10:00:00+05:30", "SELL", 65, 90), // −650 in FY 2026-27
  T("2026-04-02T11:00:00+05:30", "SELL", 65, 80), // opens a short
  T("2026-04-03T11:00:00+05:30", "BUY", 65, 70), // +650 on the short
  T("2026-04-06T10:00:00+05:30", "BUY", 10, 1400, { symbol: "NSE:RELIANCE", product: "INTRADAY" }),
  T("2026-04-06T14:00:00+05:30", "SELL", 10, 1390, { symbol: "NSE:RELIANCE", product: "INTRADAY" }), // −100 intraday
  T("2025-01-10T10:00:00+05:30", "BUY", 5, 1000, { symbol: "NSE:INFY", product: "CNC" }),
  T("2026-04-10T10:00:00+05:30", "SELL", 5, 1500, { symbol: "NSE:INFY", product: "CNC" }), // +2500 held > 12 months
];

describe("statement", () => {
  it("realises first in, first out, per contract and product, longs and shorts", () => {
    const { closed, open } = fifoRealised(trades);
    expect(closed.map((c) => [c.day, c.side, c.qty, c.pnl, c.segment])).toEqual([
      ["2026-03-27", "long", 65, 1300, "fno"],
      ["2026-04-02", "long", 65, -650, "fno"],
      ["2026-04-03", "short", 65, 650, "fno"],
      ["2026-04-06", "long", 10, -100, "intraday"],
      ["2026-04-10", "long", 5, 2500, "ltcg"],
    ]);
    expect(open).toEqual([]);
  });

  it("knows the financial year (April to March)", () => {
    expect(financialYear("2026-03-31")).toEqual({ from: "2025-04-01", to: "2026-03-31", label: "FY 2025-26" });
    expect(financialYear("2026-04-01").label).toBe("FY 2026-27");
  });

  it("FY 2026-27: realised by segment, F&O turnover as the sum of absolute settled differences, the net after charges", () => {
    const s = statement(trades, { from: "2026-04-01", to: "2027-03-31" });
    expect(s.segments.fno).toEqual({ realised: 0, turnover: 1300, trades: 2, wins: 1 });
    expect(s.segments.intraday.realised).toBe(-100);
    expect(s.segments.ltcg.realised).toBe(2500);
    expect(s.realised).toBe(2400);
    expect(s.turnover).toBe(1300);
    expect(byFinancialYear(trades).map((y) => [y.label, y.segments.fno, y.segments.intraday, y.segments.ltcg])).toEqual([
      ["FY 2026-27", 0, -100, 2500],
      ["FY 2025-26", 1300, 0, 0],
    ]);
  });

  it("charges are itemised from the ticket's model and add up to the Trades tab's totals for the same days", () => {
    const chargesOf = fillChargesWith(charges, FALLBACK_RATES);
    const from = "2026-04-01";
    const to = "2026-04-30";
    const s = statement(trades, { from, to, chargesOf });
    const inRange = trades.filter((t) => t.tradedAt.slice(0, 10) >= from && t.tradedAt.slice(0, 10) <= to);
    const tab = fillTotals(inRange, { chargesOf }); // what Orders › Trades shows for these rows
    expect(s.fills).toEqual(tab);
    expect(s.charges.total).toBeCloseTo(tab.charges.total, 9);
    const values = tradeTotals(inRange);
    expect([s.fills.count, s.fills.buyValue, s.fills.sellValue]).toEqual([values.count, values.buyValue, values.sellValue]);
    expect(s.charges.total).toBeCloseTo(["brokerage", "stt", "txn", "sebi", "stamp", "gst"].reduce((a, k) => a + s.charges[k], 0), 9);
    expect(s.charges.stt).toBeGreaterThan(0);
    expect(s.fills.unpriced).toBe(3); // equity fills are not priced by the F&O model
    expect(s.net).toBeCloseTo(s.realised - s.charges.total, 9);
  });

  it("paper ledger: opening cash, realised and charges by day, closing", () => {
    const s = statement(trades, { from: "2026-04-01", to: "2026-04-03", opening: 100000, chargesOf: () => ({ total: 10 }) });
    expect(s.ledger.map((r) => [r.day, r.opening, r.realised, r.charges, r.closing])).toEqual([
      ["2026-04-02", 100000, -650, 20, 99330],
      ["2026-04-03", 99330, 650, 10, 99970],
    ]);
  });
});
