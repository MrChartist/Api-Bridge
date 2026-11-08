import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRY_RUN_REUSE_MS, cancelAllBody, cancelAllBridgeLine, cancelAllButton, cancelAllGroups, cancelAllTitle, cancelAllReport, filterOrders, fundsView, filterTrades, openByMode, orderBucket, orderCounts, shortMemo } from "./orders-core.js";

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
  it("filters by side and search", () => {
    expect(filterTrades(trades, { side: "SELL" }).map((t) => t.tradeId)).toEqual(["T2"]);
    expect(filterTrades(trades, { q: "reliance" }).map((t) => t.tradeId)).toEqual(["T3"]);
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
