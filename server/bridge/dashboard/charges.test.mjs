import { describe, expect, it } from "vitest";
import { chargeLines, fillCharges, fillTotals, isFno, istDayOf } from "./charges.js";
import { REF_DEFAULTS, refCharges } from "./reference.js";

const OPT = "NFO:NIFTY-2026-11-03-25000-CE";
const T = (at, side, qty, price, o = {}) => ({ tradedAt: at, side, qty, price, symbol: OPT, product: "MARGIN", ...o });
const KEYS = ["brokerage", "stt", "txn", "sebi", "stamp", "gst"];

describe("charge table", () => {
  it("reads the shipped defaults and hands out copies", () => {
    const r = refCharges();
    expect(r.brokeragePerOrder).toBe(REF_DEFAULTS.charges.brokerage.perOrder);
    expect(r.opt.txn.NSE).toBe(REF_DEFAULTS.charges.opt.txn.NSE);
    r.opt.txn.NSE = 1;
    expect(refCharges().opt.txn.NSE).toBe(REF_DEFAULTS.charges.opt.txn.NSE);
  });
});

describe("charges of one order", () => {
  it("prices the worked conversion line by line: ₹226.90 for a future and two options, 3.03 points a unit", () => {
    const legs = [
      ["FUT", "BUY", 26600.5, 75, "NSE"],
      ["OPT", "SELL", 450.15, 75, "NSE"],
      ["OPT", "BUY", 254.45, 75, "NSE"],
    ].map(([kind, side, price, qty, exch]) => chargeLines(kind, side, price * qty, exch));
    const sum = (k) => legs.reduce((s, l) => s + l[k], 0);
    expect(sum("brokerage")).toBeCloseTo(60, 6);
    expect(sum("stt")).toBeCloseTo(50.64, 2);
    expect(sum("txn")).toBeCloseTo(53.03, 2);
    expect(sum("sebi")).toBeCloseTo(2.05, 2);
    expect(sum("stamp")).toBeCloseTo(40.47, 2);
    expect(sum("gst")).toBeCloseTo(20.71, 2);
    const total = ["brokerage", "stt", "txn", "sebi", "ipft", "stamp", "gst"].reduce((s, k) => s + sum(k), 0);
    expect(total).toBeCloseTo(226.9, 2);
    expect(total / 75).toBeCloseTo(3.03, 2);
  });

  it("BSE options pay the BSE exchange rate and BSE futures none", () => {
    expect(chargeLines("OPT", "BUY", 4000, "BSE").txn).toBeCloseTo(4000 * 0.000325, 9);
    expect(chargeLines("FUT", "BUY", 1_600_000, "BSE").txn).toBe(0);
  });

  it("charges GST on brokerage, exchange and SEBI only (not STT or stamp), STT on sells, stamp on buys", () => {
    const sell = chargeLines("OPT", "SELL", 7500, "NSE");
    expect(sell.gst).toBeCloseTo(0.18 * (sell.brokerage + sell.txn + sell.sebi), 9);
    expect(sell.stt).toBeGreaterThan(0);
    expect(sell.stamp).toBe(0);
    const buy = chargeLines("OPT", "BUY", 7500, "NSE");
    expect(buy.stt).toBe(0);
    expect(buy.stamp).toBeGreaterThan(0);
    expect(chargeLines("OPT", "BUY", 0, "NSE").brokerage).toBe(0);
  });
});

describe("charges of a fill", () => {
  it("knows futures and options from equity", () => {
    expect(isFno("NFO:NIFTY-2026-11-24-FUT")).toBe(true);
    expect(isFno(OPT)).toBe(true);
    expect(isFno("NSE:RELIANCE")).toBe(false);
  });

  it("itemises an option fill and adds the lines up", () => {
    const c = fillCharges(T("2026-04-02T10:00:00+05:30", "SELL", 65, 90));
    for (const k of KEYS) expect(c[k], k).toBeGreaterThanOrEqual(0);
    expect(c.stt).toBeCloseTo(90 * 65 * 0.0015, 9);
    expect(c.total).toBeCloseTo(KEYS.reduce((s, k) => s + c[k], 0), 9);
  });

  it("does not price equity fills, or a fill without a price or quantity", () => {
    expect(fillCharges(T("2026-04-06T10:00:00+05:30", "BUY", 10, 1400, { symbol: "NSE:RELIANCE" }))).toBeNull();
    expect(fillCharges(T("2026-04-06T10:00:00+05:30", "BUY", 10, null))).toBeNull();
    expect(fillCharges(T("2026-04-06T10:00:00+05:30", "BUY", 0, 100))).toBeNull();
  });

  it("reads the quantity from either field, and prices a BFO fill at the BSE rate", () => {
    const a = fillCharges(T("2026-04-02T10:00:00+05:30", "BUY", 20, 200, { symbol: "BFO:SENSEX-2026-11-06-80000-PE" }));
    const b = fillCharges({ side: "BUY", quantity: 20, price: 200, symbol: "BFO:SENSEX-2026-11-06-80000-PE" });
    expect(a).toEqual(b);
    expect(a.txn).toBeCloseTo(4000 * 0.000325, 9);
  });
});

describe("trade book totals", () => {
  const trades = [
    T("2026-03-20T10:00:00+05:30", "BUY", 130, 100),
    T("2026-04-02T10:00:00+05:30", "SELL", 65, 90),
    T("2026-04-02T11:00:00+05:30", "SELL", 65, 80),
    T("2026-04-06T10:00:00+05:30", "BUY", 10, 1400, { symbol: "NSE:RELIANCE", product: "INTRADAY" }),
  ];

  it("sums count, bought and sold value and charges, and counts what the model does not price", () => {
    const t = fillTotals(trades);
    expect(t.count).toBe(4);
    expect(t.buyValue).toBe(130 * 100 + 10 * 1400);
    expect(t.sellValue).toBe(65 * 90 + 65 * 80);
    expect(t.turnoverValue).toBe(t.buyValue + t.sellValue);
    expect(t.unpriced).toBe(1);
    expect(t.charges.total).toBeCloseTo(KEYS.reduce((s, k) => s + t.charges[k], 0), 9);
    expect(t.charges.stt).toBeGreaterThan(0);
  });

  it("limits the sums to a period of IST days, and takes the charges from the function it is given", () => {
    const t = fillTotals(trades, { from: "2026-04-01", to: "2026-04-30", chargesOf: () => ({ total: 10, brokerage: 10 }) });
    expect(t.count).toBe(3);
    expect(t.charges.total).toBe(30);
    expect(t.unpriced).toBe(0);
    expect(istDayOf("2026-04-02T00:30:00+05:30")).toBe("2026-04-02");
    expect(istDayOf(Date.parse("2026-04-01T20:00:00Z"))).toBe("2026-04-02");
  });

  it("totals nothing for no trades", () => {
    expect(fillTotals(null)).toMatchObject({ count: 0, buyValue: 0, sellValue: 0, unpriced: 0 });
  });
});
