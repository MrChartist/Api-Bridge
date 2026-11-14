/**
 * Order-book drift: the pure comparison (driftCompare.mjs) and the periodic, read-only service (drift.mjs) over the
 * published fakes. Fake clock (a Monday morning inside market hours); no network.
 */
import { describe, expect, it } from "vitest";
import { createOrderDriftService } from "./drift.mjs";
import { compareOrderBook } from "./driftCompare.mjs";
import { createDriftRoutes } from "./driftRoutes.mjs";
import { bookRow, buildHarness, liveOrder } from "./__fixtures__/helpers.mjs";

const leg = (over = {}) => ({
  orderId: "ord_1",
  leg: 0,
  clientOrderId: null,
  symbol: "NSE:RELIANCE",
  side: "BUY",
  orderType: "LIMIT",
  price: 1400,
  placedAt: "2026-10-19T09:30:00+05:30",
  status: "open",
  brokerOrderId: "Z-1",
  quantity: 10,
  filledQuantity: 0,
  sentAt: Date.UTC(2026, 9, 19, 4, 0, 0),
  gaveUp: false,
  ref: { token: "738561", exchange: "NSE", tradingSymbol: "RELIANCE" },
  tickSize: 0.05,
  ...over,
});

const kinds = (r) => r.differences.map((d) => d.kind);

describe("compareOrderBook", () => {
  it("reports nothing when both sides agree", () => {
    const r = compareOrderBook({ accountId: "a", legs: [leg()], book: [bookRow({ orderId: "Z-1" })] });
    expect(r.differences).toEqual([]);
    expect(r.counts).toEqual({ bridgeOpen: 1, brokerOpen: 1, externalClosed: 0 });
  });

  it("an order the Bridge has open but the broker shows complete is closed_at_broker", () => {
    const r = compareOrderBook({ accountId: "a", legs: [leg()], book: [bookRow({ orderId: "Z-1", status: "COMPLETE", filledQty: 10, pendingQty: 0 })] });
    expect(kinds(r)).toEqual(["closed_at_broker"]);
    expect(r.differences[0]).toMatchObject({ accountId: "a", orderId: "ord_1", brokerOrderId: "Z-1", bridge: { status: "open" }, broker: { status: "filled", brokerStatus: "COMPLETE" } });
    expect(r.differences[0].message).toMatch(/behind/);
  });

  it("an order the Bridge has open but the broker has no record of is missing_at_broker", () => {
    const r = compareOrderBook({ accountId: "a", legs: [leg()], book: [] });
    expect(kinds(r)).toEqual(["missing_at_broker"]);
  });

  it("a finished Bridge order that the broker's book no longer lists is not a difference", () => {
    const r = compareOrderBook({ accountId: "a", legs: [leg({ status: "filled", filledQuantity: 10 })], book: [] });
    expect(r.differences).toEqual([]);
  });

  it("different states that are not 'closed at the broker' are status_mismatch", () => {
    expect(kinds(compareOrderBook({ accountId: "a", legs: [leg({ status: "cancelled" })], book: [bookRow({ orderId: "Z-1", status: "OPEN" })] }))).toEqual(["status_mismatch"]);
    expect(kinds(compareOrderBook({ accountId: "a", legs: [leg()], book: [bookRow({ orderId: "Z-1", status: "PARTIALLY_FILLED", filledQty: 4 })] }))).toEqual(["status_mismatch"]);
  });

  it("a broker state UNKNOWN is no opinion", () => {
    expect(compareOrderBook({ accountId: "a", legs: [leg()], book: [bookRow({ orderId: "Z-1", status: "UNKNOWN" })] }).differences).toEqual([]);
  });

  it("same state, different quantity or fill", () => {
    expect(kinds(compareOrderBook({ accountId: "a", legs: [leg()], book: [bookRow({ orderId: "Z-1", qty: 20 })] }))).toEqual(["quantity_mismatch"]);
    const fill = compareOrderBook({ accountId: "a", legs: [leg({ status: "partially_filled", filledQuantity: 2 })], book: [bookRow({ orderId: "Z-1", status: "PARTIALLY_FILLED", filledQty: 5 })] });
    expect(kinds(fill)).toEqual(["fill_mismatch"]);
  });

  it("an open broker order the Bridge does not own is unknown_at_broker; finished ones are only counted", () => {
    const r = compareOrderBook({
      accountId: "a",
      legs: [leg()],
      book: [bookRow({ orderId: "Z-1" }), bookRow({ orderId: "MANUAL-9", status: "TRIGGER_PENDING", side: "SELL", qty: 5 }), bookRow({ orderId: "DONE-1", status: "COMPLETE" })],
    });
    expect(kinds(r)).toEqual(["unknown_at_broker"]);
    expect(r.differences[0]).toMatchObject({ orderId: null, brokerOrderId: "MANUAL-9", symbol: "NSE:RELIANCE", side: "SELL" });
    expect(r.differences[0].message).toMatch(/did not place/);
    expect(r.counts.externalClosed).toBe(1);
  });

  it("an id the Bridge learned of while the book was being read is not reported as unknown", () => {
    const r = compareOrderBook({ accountId: "a", legs: [], book: [bookRow({ orderId: "NEW-1" })], knownBrokerIds: ["NEW-1"] });
    expect(r.differences).toEqual([]);
  });

  it("an unknown outcome shows the broker's matching order, and that order is not also reported as external", () => {
    const unknown = leg({ orderId: "ord_u", status: "outcome_unknown", brokerOrderId: null });
    const match = bookRow({ orderId: "Z-777", qty: 10, price: 1400, placedAt: new Date(unknown.sentAt + 1000).toISOString() });
    const r = compareOrderBook({ accountId: "a", legs: [unknown], book: [match] });
    expect(kinds(r)).toEqual(["outcome_unknown"]);
    expect(r.differences[0].brokerMatches).toEqual([expect.objectContaining({ brokerOrderId: "Z-777", status: "open", quantity: 10 })]);
    expect(r.differences[0].message).toMatch(/one order that fits/);
  });

  it("an unknown outcome with no match says so; several matches are ambiguous", () => {
    const unknown = leg({ orderId: "ord_u", status: "outcome_unknown", brokerOrderId: null });
    const none = compareOrderBook({ accountId: "a", legs: [unknown], book: [] });
    expect(none.differences[0].brokerMatches).toEqual([]);
    expect(none.differences[0].message).toMatch(/shows no order that fits/);
    const many = compareOrderBook({ accountId: "a", legs: [unknown], book: [bookRow({ orderId: "A" }), bookRow({ orderId: "B" })] });
    expect(many.differences[0].brokerMatches).toHaveLength(2);
    expect(many.differences[0].message).toMatch(/cannot tell which/);
  });

  it("a write still in flight (pending, no broker id) is neither reported nor does it make its order 'unknown'", () => {
    const inflight = leg({ status: "pending", brokerOrderId: null });
    const r = compareOrderBook({ accountId: "a", legs: [inflight], book: [bookRow({ orderId: "Z-5" })] });
    expect(r.differences).toEqual([]);
  });
});

function setup(opts = {}) {
  const h = buildHarness(opts);
  const orders = h.rawSvc;
  const events = [];
  h.bus.on("orders.drift", (p) => events.push(p));
  const updates = [];
  h.bus.on("order.updated", (p) => updates.push(p));
  const drift = createOrderDriftService({ ...h.deps, orders }, opts.drift ?? {});
  return { h, orders, drift, events, updates };
}

const bookReads = (h) => h.zerodha.reads.filter((r) => r === "orderBook").length;
const MIN = 60_000;

describe("order drift service", () => {
  it("compares on its first pass, reports drift once, never changes the order and never writes to the broker", async () => {
    const { h, orders, drift, events, updates } = setup();
    const { order } = await h.svc.place(h.ctx("live"), liveOrder());
    updates.length = 0;
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "COMPLETE", filledQty: 10, pendingQty: 0, avgPrice: 1399 })];
    const reads0 = bookReads(h);
    const r = await drift.checkNow();
    expect(r.checked).toContain("zerodha-main");
    expect(bookReads(h)).toBe(reads0 + 1);

    const s = drift.status();
    expect(s).toMatchObject({ state: "drift", readOnly: true, counts: { differences: 1, closed_at_broker: 1 } });
    expect(s.summary).toMatch(/1 difference/);
    expect(s.differences[0]).toMatchObject({ kind: "closed_at_broker", orderId: order.orderId, accountId: "zerodha-main" });
    expect(s.accounts.find((a) => a.accountId === "zerodha-main")).toMatchObject({ state: "drift", differences: 1, bridgeOpen: 1, brokerOpen: 0 });

    // The Bridge's record is untouched, nothing was emitted but the drift event, nothing was sent to the broker.
    expect(orders.driftLegs("zerodha-main")[0]).toMatchObject({ status: "open", filledQuantity: 0 });
    expect(updates).toEqual([]);
    expect(h.zerodha.placed).toHaveLength(1);
    expect(h.zerodha.modified).toEqual([]);
    expect(h.zerodha.cancelled).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ accountId: "zerodha-main", state: "drift", previous: "ok", count: 1, kinds: { closed_at_broker: 1 } })]);
    expect(events[0].differences[0].message).toMatch(/behind/);
  });

  it("reads through the scheduler at background priority", async () => {
    const { h, drift } = setup();
    await h.svc.place(h.ctx("live"), liveOrder());
    h.scheduler.calls.length = 0;
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001" })];
    await drift.checkNow();
    expect(h.scheduler.calls.length).toBeGreaterThan(0);
    expect(h.scheduler.calls.every((c) => c.endpointClass === "portfolio" && c.priority === "background")).toBe(true);
    expect(h.scheduler.calls.map((c) => c.accountId)).toContain("zerodha-main");
  });

  it("agreeing books give ok and no event; the first drift then the all-clear each emit once", async () => {
    const { h, drift, events } = setup();
    await h.svc.place(h.ctx("live"), liveOrder());
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001" })];
    await drift.checkNow();
    expect(drift.status()).toMatchObject({ state: "ok", counts: { differences: 0 } });
    expect(events).toEqual([]);

    await h.clock.advance(5 * MIN);
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001" }), bookRow({ orderId: "MANUAL-9", status: "OPEN", side: "SELL", qty: 5 })];
    await drift.checkNow();
    expect(drift.status().state).toBe("drift");
    expect(events).toHaveLength(1);

    // Still the same difference five minutes later: not announced again.
    await h.clock.advance(5 * MIN);
    await drift.checkNow();
    expect(events).toHaveLength(1);

    await h.clock.advance(5 * MIN);
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001" })];
    await drift.checkNow();
    expect(drift.status().state).toBe("ok");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ state: "ok", previous: "drift", count: 0 });
  });

  it("never reads the book more often than the interval", async () => {
    const { h, drift } = setup();
    h.zerodha.book = [];
    const base = bookReads(h);
    await drift.checkNow();
    await drift.checkNow();
    await h.clock.advance(4 * MIN);
    await drift.checkNow();
    expect(bookReads(h)).toBe(base + 1);
    await h.clock.advance(1 * MIN + 1);
    await drift.checkNow();
    expect(bookReads(h)).toBe(base + 2);
  });

  it("checks on its own timer after start() and stops after close()", async () => {
    const { h, drift } = setup();
    h.zerodha.book = [];
    drift.start();
    await h.clock.advance(31_000);
    const afterFirst = bookReads(h);
    expect(afterFirst).toBe(1);
    await h.clock.advance(4 * MIN);
    expect(bookReads(h)).toBe(1);
    await h.clock.advance(1 * MIN);
    expect(bookReads(h)).toBe(2);
    drift.close();
    await h.clock.advance(20 * MIN);
    expect(bookReads(h)).toBe(2);
  });

  it("honours orders.drift.intervalMinutes", async () => {
    const { h, drift } = setup({ orders: { drift: { intervalMinutes: 20 } } });
    await drift.checkNow();
    await h.clock.advance(19 * MIN);
    await drift.checkNow();
    expect(bookReads(h)).toBe(1);
    await h.clock.advance(2 * MIN);
    await drift.checkNow();
    expect(bookReads(h)).toBe(2);
  });

  it("does not run when live trading is off, no live account exists, the account is logged out or the market is closed", async () => {
    const off = setup({ raw: { safety: { liveTrading: false } } });
    expect((await off.drift.checkNow()).checked).toEqual([]);
    expect(off.drift.status()).toMatchObject({ state: "idle", paused: { reason: "live_trading_off" } });
    expect(bookReads(off.h)).toBe(0);

    const noLive = setup({ accounts: [{ id: "zerodha-2", broker: "zerodha", adapter: undefined, creds: {} }, { id: "paper", broker: "paper" }] });
    expect(noLive.drift.eligibility().reason).toBe("no_live_account");

    const out = setup();
    out.h.accounts.disconnect?.("zerodha-main");
    await out.h.accounts.disconnect("zerodha-main");
    await out.h.accounts.disconnect("dhan-main");
    expect(out.drift.eligibility().reason).toBe("not_logged_in");

    const closed = setup();
    await closed.h.clock.set(Date.UTC(2026, 9, 19, 16, 0, 0)); // 21:30 IST
    expect(closed.drift.eligibility()).toEqual({ ids: [], reason: "market_closed" });
    expect((await closed.drift.checkNow()).checked).toEqual([]);
    const sat = setup();
    await sat.h.clock.set(Date.UTC(2026, 9, 24, 5, 0, 0)); // Saturday
    expect(sat.drift.eligibility().reason).toBe("market_closed");
  });

  it("with marketHoursOnly off it also checks outside market hours", async () => {
    const x = setup({ orders: { drift: { marketHoursOnly: false } } });
    await x.h.clock.set(Date.UTC(2026, 9, 19, 16, 0, 0));
    expect(x.drift.eligibility().ids).toEqual(["zerodha-main", "dhan-main"]);
  });

  it("is off when orders.drift.enabled is false", async () => {
    const x = setup({ orders: { drift: { enabled: false } } });
    expect(x.drift.eligibility().ids).toEqual([]);
    expect(x.drift.status()).toMatchObject({ state: "off", enabled: false });
    expect(x.drift.status().summary).toMatch(/off/);
    x.drift.start();
    await x.h.clock.advance(10 * MIN);
    expect(bookReads(x.h)).toBe(0);
  });

  it("a broker read that fails is reported as unavailable, once per interval, without a drift event", async () => {
    const { h, drift, events } = setup();
    h.zerodha.fetchOrderBook = async () => {
      h.zerodha.reads.push("orderBook");
      throw Object.assign(new Error("boom"), { code: "UPSTREAM_ERROR" });
    };
    await drift.checkNow();
    const s = drift.status();
    expect(s.state).toBe("unavailable");
    expect(s.accounts[0]).toMatchObject({ state: "unavailable", error: expect.objectContaining({ code: expect.any(String) }) });
    expect(events).toEqual([]);
    await drift.checkNow();
    expect(bookReads(h)).toBe(1);
  });

  it("a read that hangs is given up on", async () => {
    const { h, drift } = setup();
    h.zerodha.fetchOrderBook = () => new Promise(() => {});
    const p = drift.checkNow();
    await h.clock.advance(61_000);
    await p;
    expect(drift.status().accounts[0].error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("an unknown outcome is listed with the broker's matching order and the Bridge's own record stays unknown", async () => {
    const { h, orders, drift } = setup();
    h.zerodha.next = "hang";
    const p = h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "drift-unknown-1" }).catch((e) => e);
    await h.clock.advance(15_000);
    const e = await p;
    expect(e.code).toBe("OUTCOME_UNKNOWN");
    const orderId = e.detail.match(/ord_[0-9a-f]+/)[0];
    // The book has the order, but the Bridge's own reconciliation has not run on it yet: drift shows the match.
    h.zerodha.book = [bookRow({ orderId: "Z-777", qty: 10, price: 1400, status: "OPEN", placedAt: new Date(h.clock.now() - 1000).toISOString() })];
    const legsBefore = orders.driftLegs("zerodha-main");
    await drift.checkNow();
    const d = drift.status().differences.find((x) => x.kind === "outcome_unknown");
    expect(d).toMatchObject({ orderId, brokerMatches: [expect.objectContaining({ brokerOrderId: "Z-777", status: "open" })] });
    expect(drift.status().summary).toMatch(/unknown outcome/);
    expect(legsBefore).toHaveLength(1);
  });

  it("status() shows only the accounts a key may see", async () => {
    const { h, drift } = setup();
    await h.svc.place(h.ctx("live"), liveOrder());
    h.zerodha.book = [];
    h.dhan.book = [bookRow({ orderId: "D-1" })];
    await drift.checkNow();
    expect(drift.status().accounts.map((a) => a.accountId).sort()).toEqual(["dhan-main", "zerodha-main"]);
    const only = drift.status({ canSee: (id) => id === "dhan-main" });
    expect(only.accounts.map((a) => a.accountId)).toEqual(["dhan-main"]);
    expect(only.differences.every((d) => d.accountId === "dhan-main")).toBe(true);
  });

  it("an order placed while the book is being read is never reported", async () => {
    const { h, drift } = setup();
    // The read happens, and during it an order is placed and then shows in the Bridge's record (as it would in real life).
    const original = h.zerodha.fetchOrderBook;
    h.zerodha.fetchOrderBook = async (...a) => {
      const out = await original(...a);
      await h.svc.place(h.ctx("live"), liveOrder());
      return out;
    };
    h.zerodha.book = [];
    await drift.checkNow();
    expect(drift.status().differences).toEqual([]);
  });
});

describe("GET /v1/orders/drift handler", () => {
  const ctxFor = (query = "", { accounts = "*", kind = "key" } = {}) => ({
    requestId: "req_1",
    query: new URLSearchParams(query),
    principal: kind === "local" ? { kind: "local" } : { kind: "key" },
    key: { accounts },
  });

  it("answers with the service's view, limited to the key's accounts", async () => {
    const { h, drift } = setup();
    h.dhan.book = [bookRow({ orderId: "D-1" })];
    h.zerodha.book = [bookRow({ orderId: "M-1" })];
    await drift.checkNow();
    const routes = createDriftRoutes({ orderDrift: drift, config: h.config });
    const all = await routes.getDrift(ctxFor());
    expect(all.data.accounts).toHaveLength(2);
    expect(all.meta).toEqual({ requestId: "req_1", accountId: null });
    const limited = await routes.getDrift(ctxFor("", { accounts: ["dhan-main"] }));
    expect(limited.data.accounts.map((a) => a.accountId)).toEqual(["dhan-main"]);
    const one = await routes.getDrift(ctxFor("account=zerodha-main"));
    expect(one.data.accounts.map((a) => a.accountId)).toEqual(["zerodha-main"]);
    await expect(routes.getDrift(ctxFor("account=zerodha-main", { accounts: ["dhan-main"] }))).rejects.toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
    await expect(routes.getDrift(ctxFor("account=nope-nope"))).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(routes.getDrift(ctxFor("bogus=1"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(routes.getDrift(ctxFor("account=A"))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
