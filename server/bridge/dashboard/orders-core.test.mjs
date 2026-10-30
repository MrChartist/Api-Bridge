import { describe, expect, it } from "vitest";
import { dayRows, depthView, filterOrders, filterTrades, openByMode, orderBucket, orderCounts, tradeTotals } from "./orders-core.js";

const O = (o) => ({ orderId: "PAPER-1", accountId: "demo-paper", symbol: "NFO:NIFTY-2026-11-03-25850-CE", side: "BUY", status: "filled", mode: "paper", ...o });
const list = [
  O({ orderId: "A", status: "open" }),
  O({ orderId: "B", status: "trigger_pending", side: "SELL", mode: "live" }),
  O({ orderId: "C", status: "filled", symbol: "NFO:BANKNIFTY-2026-11-23-58100-CE", tag: "trigger" }),
  O({ orderId: "D", status: "rejected", side: "SELL" }),
  O({ orderId: "E", status: "expired" }),
  O({ orderId: "F", status: "outcome_unknown" }),
];

describe("order book filters", () => {
  it("buckets every status", () => {
    expect(["pending", "open", "trigger_pending", "partially_filled"].map(orderBucket)).toEqual(["open", "open", "open", "open"]);
    expect([orderBucket("filled"), orderBucket("rejected"), orderBucket("outcome_unknown"), orderBucket("cancelled"), orderBucket("expired")]).toEqual(["filled", "rejected", "rejected", "cancelled", "cancelled"]);
  });
  it("counts and filters by status, side and search (contract as shown, order id, tag or account label)", () => {
    expect(orderCounts(list)).toEqual({ all: 6, open: 2, filled: 1, rejected: 2, cancelled: 1 });
    expect(filterOrders(list, { status: "open" }).map((o) => o.orderId)).toEqual(["A", "B"]);
    expect(filterOrders(list, { status: "open", side: "SELL" }).map((o) => o.orderId)).toEqual(["B"]);
    expect(filterOrders(list, { q: "banknifty 23 nov" }).map((o) => o.orderId)).toEqual(["C"]);
    expect(filterOrders(list, { q: "trigger" }).map((o) => o.orderId)).toEqual(["C"]);
    expect(filterOrders(list, { q: "spouse", labelOf: (id) => (id === "demo-paper" ? "Paper · spouse" : id) })).toHaveLength(6);
    expect(filterOrders(list, { q: "nothing here" })).toEqual([]);
  });
  it("splits working orders by mode for Cancel all's question", () => {
    expect(openByMode(list)).toEqual({ total: 2, paper: 1, live: 1 });
  });
});

describe("trade book", () => {
  const trades = [
    { tradeId: "T1", orderId: "A", accountId: "x", symbol: "NFO:NIFTY-2026-11-03-25850-CE", side: "BUY", qty: 65, price: 100, charges: 20 },
    { tradeId: "T2", orderId: "B", accountId: "x", symbol: "NFO:NIFTY-2026-11-03-25850-CE", side: "SELL", qty: 65, price: 120, charges: 21.5 },
    { tradeId: "T3", orderId: "C", accountId: "x", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, price: 1400 },
  ];
  it("totals bought, sold, turnover and charges", () => {
    expect(tradeTotals(trades)).toEqual({ count: 3, buyQty: 75, sellQty: 65, buyValue: 20500, sellValue: 7800, turnover: 28300, charges: 41.5 });
  });
  it("filters by side and search", () => {
    expect(filterTrades(trades, { side: "SELL" }).map((t) => t.tradeId)).toEqual(["T2"]);
    expect(filterTrades(trades, { q: "reliance" }).map((t) => t.tradeId)).toEqual(["T3"]);
  });
});

describe("positions Day view", () => {
  it("measures carried units from the previous close and today's trades from their prices", () => {
    // Carried 65 long from a 100 close, bought 65 more at 110 today, now 120: (120 − 100)·65 + (120 − 110)·65 = 1950.
    const carried = { symbol: "NFO:NIFTY-2026-11-03-25000-CE", product: "MARGIN", netQty: 130, ltp: 120, overnightQty: 65, prevClose: 100, buyQty: 65, buyAvg: 110, sellQty: 0, sellAvg: null };
    // Bought 65 at 50 and sold them at 58 today: closed, +520.
    const closed = { symbol: "NFO:NIFTY-2026-11-03-26000-PE", product: "INTRADAY", netQty: 0, ltp: null, overnightQty: 0, buyQty: 65, buyAvg: 50, sellQty: 65, sellAvg: 58 };
    // The paper engine sends its own dayPnl; it wins.
    const given = { symbol: "NSE:RELIANCE", product: "CNC", netQty: 10, ltp: 1400, overnightQty: 10, prevClose: 1390, buyQty: 0, sellQty: 0, dayPnl: 100 };
    const flatOld = { symbol: "X", netQty: 0, buyQty: 0, sellQty: 0, overnightQty: 0 };
    const r = dayRows([closed, carried, given, flatOld]);
    expect(r.rows.map((x) => [x.symbol.slice(-8), x.dayPnl])).toEqual([["25000-CE", 1950], ["26000-PE", 520], ["RELIANCE", 100]]);
    expect(r.total).toBe(2570);
    expect(r.missing).toBe(0);
  });
  it("says when a source gives no day figures (a broker that reports none)", () => {
    const r = dayRows([{ symbol: "NFO:A", netQty: 65, ltp: 10, buyQty: 65, buyAvg: 9 }]);
    expect(r.rows[0].dayPnl).toBeNull();
    expect(r).toMatchObject({ total: null, missing: 1 });
  });
});

describe("market depth in the ticket", () => {
  const L = (price, qty, orders = 1) => ({ price, qty, orders });
  const depth = { bids: [L(186.2, 350, 9), L(185.9, 450), L(185.6, 600), L(185.3, 1000), L(185, 800)], asks: [L(186.5, 625), L(186.8, 400), L(187.1, 0), L(187.4, 300)] };
  it("pairs levels best first, totals each side and scales the bars to the largest level", () => {
    const v = depthView(depth);
    expect(v.rows).toHaveLength(5);
    expect(v.rows[0]).toEqual({ bid: L(186.2, 350, 9), ask: L(186.5, 625) });
    expect(v.rows[3].ask).toBeNull(); // an empty (zero) level is dropped, so asks run out first
    expect([v.totalBid, v.totalAsk, v.maxQty]).toEqual([3200, 1325, 1000]);
    expect(v.bidShare).toBeCloseTo(3200 / 4525, 9);
    expect(v.available).toBe(5);
  });
  it("shows up to twenty levels when the source sends them, five by default", () => {
    const many = { bids: Array.from({ length: 20 }, (_, i) => L(100 - i, 10)), asks: Array.from({ length: 20 }, (_, i) => L(101 + i, 10)) };
    expect(depthView(many).rows).toHaveLength(5);
    expect(depthView(many, 20).rows).toHaveLength(20);
    expect(depthView(many).available).toBe(20);
  });
  it("has nothing to draw without depth", () => {
    expect(depthView(null)).toEqual({ rows: [], totalBid: 0, totalAsk: 0, maxQty: 0, bidShare: null, available: 0 });
  });
});
