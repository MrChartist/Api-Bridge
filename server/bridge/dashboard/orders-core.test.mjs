import { describe, expect, it } from "vitest";
import { filterOrders, filterTrades, openByMode, orderBucket, orderCounts, tradeTotals } from "./orders-core.js";

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
