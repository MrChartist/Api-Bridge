import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRY_RUN_REUSE_MS, VALIDITY, bucketTone, cancelAllBody, cancelAllBridgeLine, cancelAllButton, cancelAllGroups, cancelAllTitle, cancelAllReport, dayRows, depthView, filterOrders, fundsView, filterTrades, openByMode, orderBucket, orderCounts, quoteHead, shortMemo, sideView, stepLots, tradeTotals, validityApplies } from "./orders-core.js";

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

describe("funds per account", () => {
  it("free, used, collateral and how much of the total is in use, with a level", () => {
    expect(fundsView({ availableCash: 2_206_000, usedMargin: 294_000, collateral: null })).toEqual({ available: 2_206_000, used: 294_000, collateral: null, total: 2_500_000, util: 0.1176, level: "ok" });
    expect(fundsView({ availableCash: 20_000, usedMargin: 80_000 }).level).toBe("warn");
    expect(fundsView({ availableCash: 5_000, usedMargin: 95_000, collateral: 150_000 })).toMatchObject({ util: 0.95, level: "neg", collateral: 150_000 });
    expect(fundsView({ availableCash: -1000, usedMargin: 51_000 }).util).toBe(1);
  });
  it("leaves what the source did not send empty", () => {
    expect(fundsView(null)).toEqual({ available: null, used: null, collateral: null, total: null, util: null, level: "none" });
    expect(fundsView({ totalBalance: 100 })).toMatchObject({ total: 100, util: null });
  });
});

describe("Cancel all: Bridge orders and orders placed outside the Bridge", () => {
  const dry = {
    dryRun: true,
    cancelled: [],
    failed: [],
    bridge: { cancelled: [], open: [{ orderId: "PAPER-1", mode: "paper", external: false }, { orderId: "BR-2", mode: "live", external: false }] },
    external: { cancelled: [], left: [], open: [{ orderId: "MANUAL-9", mode: "live", external: true }] },
  };
  it("counts and lists both groups from the dry run", () => {
    const g = cancelAllGroups(dry);
    expect(g.bridge.map((o) => o.orderId)).toEqual(["PAPER-1", "BR-2"]);
    expect(g.external.map((o) => o.orderId)).toEqual(["MANUAL-9"]);
    expect(g).toMatchObject({ total: 3, paper: 1, live: 1 });
    expect(cancelAllGroups(null)).toEqual({ bridge: [], external: [], total: 0, paper: 0, live: 0 });
  });
  it("the button shows when anything is open in either group, counted from the dry run once it is in", () => {
    const onlyOutside = cancelAllGroups({ bridge: { open: [] }, external: { open: [{ orderId: "M1", mode: "live" }, { orderId: "M2", mode: "live" }] } });
    expect(cancelAllButton(0, onlyOutside)).toEqual({ show: true, count: 2, label: "Cancel all open (2)" });
    expect(cancelAllButton(3, null)).toEqual({ show: true, count: 3, label: "Cancel all open (3)" }); // before the dry run answers
    expect(cancelAllButton(3, cancelAllGroups(dry))).toEqual({ show: true, count: 3, label: "Cancel all open (3)" });
    expect(cancelAllButton(0, null)).toEqual({ show: false, count: 0, label: "" });
    expect(cancelAllButton(2, cancelAllGroups({ bridge: { open: [] }, external: { open: [] } }))).toEqual({ show: false, count: 0, label: "" });
  });
  it("before confirming, the Bridge group says what would be cancelled, not that it was", () => {
    expect(cancelAllBridgeLine(cancelAllGroups(dry))).toBe("Cancelled when you confirm: 1 paper and 1 live.");
    expect(cancelAllBridgeLine(cancelAllGroups({ bridge: { open: [{ orderId: "A", mode: "paper" }, { orderId: "B", mode: "paper" }] }, external: { open: [] } }))).toBe("Cancelled when you confirm: 2 paper.");
    expect(cancelAllBridgeLine(cancelAllGroups({ bridge: { open: [] }, external: { open: [{ orderId: "M", mode: "live" }] } }))).toBe("None open.");
  });
  it("the question names what would go: the Bridge's orders, or only outside ones when the Bridge has none open", () => {
    expect(cancelAllTitle(cancelAllGroups(dry))).toBe("Cancel 2 open orders?");
    expect(cancelAllTitle(cancelAllGroups({ bridge: { open: [{ orderId: "A" }] }, external: { open: [] } }))).toBe("Cancel 1 open order?");
    expect(cancelAllTitle(cancelAllGroups({ bridge: { open: [] }, external: { open: [{ orderId: "M" }] } }))).toBe("1 open order placed outside the Bridge");
  });
  it("sends bridgeOnly unless the outside orders were ticked", () => {
    expect(cancelAllBody(false)).toEqual({ bridgeOnly: true });
    expect(cancelAllBody(true)).toEqual({ bridgeOnly: false });
    expect(cancelAllBody()).toEqual({ bridgeOnly: true });
  });
  it("reports what was cancelled in each group, and what was left", () => {
    expect(cancelAllReport({ cancelled: ["A", "B"], failed: [], bridge: { cancelled: ["A", "B"] }, external: { cancelled: [], left: ["M"] } })).toEqual({ tone: "ok", text: "Cancelled 2 Bridge orders. 1 order placed outside the Bridge left open." });
    expect(cancelAllReport({ cancelled: ["A", "M"], failed: [], bridge: { cancelled: ["A"] }, external: { cancelled: ["M"], left: [] } })).toEqual({ tone: "ok", text: "Cancelled 1 Bridge order and 1 order placed outside the Bridge." });
    expect(cancelAllReport({ cancelled: [], failed: [{ orderId: "A", message: "Too late" }], bridge: { cancelled: [] }, external: { cancelled: [], left: [] } })).toEqual({ tone: "warn", text: "Cancelled 0 Bridge orders. 1 not cancelled: Too late" });
  });
});

describe("Cancel all's dry run on the Orders page (perf round 5)", () => {
  it("asks once for a render and the redraw right after it, again after a few seconds or any write", async () => {
    const memo = shortMemo(DRY_RUN_REUSE_MS);
    let calls = 0;
    const load = () => Promise.resolve({ data: { n: ++calls } });
    expect((await memo(load, { now: 1000, epoch: 0 })).data.n).toBe(1);
    expect((await memo(load, { now: 1200, epoch: 0 })).data.n).toBe(1); // the revalidation redraw
    expect((await memo(load, { now: 1000 + DRY_RUN_REUSE_MS, epoch: 0 })).data.n).toBe(1);
    expect((await memo(load, { now: 1001 + DRY_RUN_REUSE_MS, epoch: 0 })).data.n).toBe(2); // older: asks again
    expect((await memo(load, { now: 1002 + DRY_RUN_REUSE_MS, epoch: 1 })).data.n).toBe(3); // a write happened
    expect(calls).toBe(3);
    expect(DRY_RUN_REUSE_MS).toBeLessThanOrEqual(5000);
  });

  it("keeps no error, so the next render asks again", async () => {
    const memo = shortMemo(DRY_RUN_REUSE_MS);
    let calls = 0;
    const failing = () => Promise.resolve({ error: { code: "UNAVAILABLE" }, n: ++calls });
    await memo(failing, { now: 0 });
    await Promise.resolve();
    expect((await memo(failing, { now: 10 })).n).toBe(2);
  });

  it("the Cancel all question itself never reuses an earlier count", () => {
    const src = readFileSync(new URL("./orders-book.js", import.meta.url), "utf8");
    const flow = src.slice(src.indexOf("async function cancelAllFlow"));
    expect(flow).toMatch(/const dry = await optional\(api\("\/v1\/orders\/cancel-all", \{ method: "POST", body: \{ dryRun: true \} \}\)\)/);
    expect(flow.slice(0, 400)).not.toContain("buttonDryRun");
  });
});

describe("orders suite: the ticket's head and stepper, the book's colours", () => {
  it("quoteHead: LTP, change and percent from change and close; the spread and its share of mid", () => {
    const q = quoteHead({ ltp: 110, change: 10, close: 100, bid: 109.5, ask: 110.5 });
    expect(q).toMatchObject({ ltp: 110, change: 10, dir: "up", spread: 1 });
    expect(q.pct).toBeCloseTo(10, 9);
    expect(q.spreadPct).toBeCloseTo((1 / 110) * 100, 9);
  });
  it("quoteHead: change from the previous close when the source sends none; down and flat", () => {
    expect(quoteHead({ ltp: 90, prevClose: 100 })).toMatchObject({ change: -10, pct: -10, dir: "down" });
    expect(quoteHead({ ltp: 100, change: 0, close: 100 }).dir).toBe("flat");
    // Change without a close: the base is LTP − change.
    expect(quoteHead({ ltp: 120, change: 20 }).pct).toBeCloseTo(20, 9);
  });
  it("quoteHead: missing figures stay null (a dash), never an invented 0; no spread for a one-sided or crossed book", () => {
    expect(quoteHead(null)).toEqual({ ltp: null, change: null, pct: null, dir: null, spread: null, spreadPct: null });
    expect(quoteHead({ ltp: 5, bid: 0, ask: 5.5 }).spread).toBeNull();
    expect(quoteHead({ ltp: 5, bid: 6, ask: 5.5 }).spread).toBeNull();
    expect(quoteHead({ ltp: "", change: "x" }).ltp).toBeNull();
  });
  it("stepLots: whole numbers, never below one, capped when a max is given; a broken entry steps from the minimum", () => {
    expect(stepLots("3", 1)).toBe(4);
    expect(stepLots(1, -1)).toBe(1);
    expect(stepLots("2.7", 1)).toBe(3);
    expect(stepLots("", 1)).toBe(2);
    expect(stepLots("abc", -1)).toBe(1);
    expect(stepLots(9, 5, { max: 10 })).toBe(10);
    expect(stepLots(0, 0)).toBe(1);
  });
  it("validity applies to limit and market orders sent now, not to stops, GTTs or after-market orders", () => {
    expect(VALIDITY.map(([v]) => v)).toEqual(["DAY", "IOC"]);
    expect(validityApplies({ orderType: "LIMIT" })).toBe(true);
    expect(validityApplies({ orderType: "MARKET" })).toBe(true);
    expect(validityApplies({ orderType: "SL" })).toBe(false);
    expect(validityApplies({ orderType: "LIMIT", later: true })).toBe(false);
  });
  it("bucketTone and sideView: status dots by state; Buy green, Sell red", () => {
    expect(["open", "filled", "rejected", "cancelled", "all"].map(bucketTone)).toEqual(["warn", "ok", "bad", "muted", null]);
    expect(sideView("BUY")).toEqual({ text: "Buy", cls: "buy" });
    expect(sideView("sell")).toEqual({ text: "Sell", cls: "sell" });
    expect(sideView(null)).toEqual({ text: "", cls: "" });
  });
  it("the ticket sends validity only for IOC, and the book draws every side as a coloured capsule", () => {
    const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
    expect(read("./desk.js")).toMatch(/if \(ioc\(\)\) b\.validity = "IOC";/);
    expect(read("./orders-book.js")).not.toMatch(/class: "order-side"/);
    expect(read("./views.js")).toMatch(/label: "Side", cell: \(o\) => sideCell\(o\.side\)/);
  });
});
