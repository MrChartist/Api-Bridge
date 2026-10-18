/**
 * Regression tests for review findings on the live order path: AI keys bound to "mcp" on every route, self-confirmed
 * tickets, live idempotency, the kill switch and the order-rate slot re-checked at send time, the price band on a
 * live modify, and coalesced reads that must not share one mutable object.
 */
import { describe, expect, it } from "vitest";
import { bookRow, buildHarness, createStubSafety, liveOrder } from "./__fixtures__/helpers.mjs";

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("AI keys need a human ticket on every transport", () => {
  it("an mcp-kind key POSTing a live order over REST gets CONFIRMATION_REQUIRED and nothing is sent", async () => {
    const h = buildHarness();
    const e = await reject(h.svc.place(h.ctx("mcp", { source: "rest" }), liveOrder(), { idempotencyKey: "ai-rest-0001" }));
    expect(e).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("an mcp-kind key cannot change a live order over REST either", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "ai-rest-0002" });
    expect(await reject(h.svc.modify(h.ctx("mcp", { source: "rest" }), order.orderId, { price: 1401 }))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(h.zerodha.modified).toHaveLength(0);
  });

  it("an mcp-kind paper order over REST still needs a ticket (confirmPaperFromMcp)", async () => {
    const h = buildHarness();
    const e = await reject(h.svc.place(h.ctx("mcp", { source: "rest" }), liveOrder({ account: "paper", mode: undefined }), { idempotencyKey: "ai-rest-0003" }));
    expect(e).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });

  it("the client that prepared a ticket cannot confirm it itself", async () => {
    const h = buildHarness();
    const both = h.ctx("admin");
    // A key that prepares (as "rest" with confirmationRequired, like a hook) and then tries to confirm its own ticket.
    both.confirmationRequired = true;
    const pv = await h.svc.preview(both, liveOrder({ account: "paper", mode: undefined }));
    expect(pv.ticketId).toMatch(/^tkt_/);
    expect(await reject(h.svc.confirmTicket(h.ctx("admin"), pv.ticketId))).toMatchObject({ code: "SCOPE_REQUIRED" });
  });
});

describe("live orders need an idempotency key", () => {
  it("refuses a live order with neither Idempotency-Key nor clientOrderId (raw service)", async () => {
    const h = buildHarness();
    const e = await reject(h.rawSvc.place(h.ctx("live"), liveOrder()));
    expect(e).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(e.detail).toMatch(/Idempotency-Key/);
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("accepts a clientOrderId instead, and paper orders need neither", async () => {
    const h = buildHarness();
    const { order } = await h.rawSvc.place(h.ctx("live"), liveOrder({ clientOrderId: "strat-idem-1" }));
    expect(order.mode).toBe("live");
    const paper = await h.rawSvc.place(h.ctx("paper"), liveOrder({ account: "paper", mode: undefined }));
    expect(paper.order.mode).toBe("paper");
  });
});

describe("checks repeated at the moment of sending", () => {
  it("a kill switch engaged after the safety check (while queued) stops the order: nothing reaches the broker", async () => {
    const safety = createStubSafety();
    let engaged = false;
    safety.killSwitchStatus = () => ({ engaged, reason: engaged ? "panic" : null, by: null, at: null });
    const h = buildHarness({ safety });
    const orig = h.scheduler.schedule.bind(h.scheduler);
    h.scheduler.schedule = (opts, fn) => {
      if (opts.endpointClass === "order") engaged = true; // engaged while the order waits in the queue
      return orig(opts, fn);
    };
    const e = await reject(h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "kill-queued-01" }));
    expect(e).toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("the kill switch engaging between legs of a sliced order stops the remaining legs", async () => {
    const safety = createStubSafety();
    let sent = 0;
    safety.killSwitchStatus = () => ({ engaged: sent >= 1, reason: "panic", by: null, at: null });
    const h = buildHarness({ safety, orders: { sliceAboveFreeze: true } });
    const origPlace = h.zerodha.placeOrder?.bind(h.zerodha);
    if (origPlace) {
      h.zerodha.placeOrder = async (...a) => {
        const r = await origPlace(...a);
        sent += 1;
        return r;
      };
    }
    const { order } = await h.svc.place(h.ctx("live"), { account: "zerodha-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", lots: 30, product: "INTRADAY", orderType: "LIMIT", price: 120.5, side: "BUY", mode: "live" }, { idempotencyKey: "kill-legs-0001" });
    expect(h.zerodha.placed).toHaveLength(1);
    expect(order.legs[1]).toMatchObject({ status: "rejected", error: { code: "KILL_SWITCH_ACTIVE" } });
  });

  it("the order-rate slot is taken when the order leaves the queue, not before it waits", async () => {
    const h = buildHarness();
    const seen = [];
    const orig = h.scheduler.schedule.bind(h.scheduler);
    h.scheduler.schedule = (opts, fn) => {
      if (opts.endpointClass !== "order") return orig(opts, fn);
      seen.push("queued");
      return orig(opts, async () => {
        seen.push("run");
        return fn();
      });
    };
    const acquire = h.safety.acquireOrderSlot.bind(h.safety);
    h.safety.acquireOrderSlot = (a) => {
      seen.push("slot");
      return acquire(a);
    };
    await h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "slot-order-001" });
    expect(seen).toEqual(["queued", "run", "slot"]);
  });

  it("an order whose slot is gone by the time it leaves the queue is refused unsent", async () => {
    const h = buildHarness({ safety: createStubSafety({ slots: 0 }) });
    const e = await reject(h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "slot-gone-0001" }));
    expect(e).toMatchObject({ code: "ORDER_RATE_LIMITED" });
    expect(h.zerodha.placed).toHaveLength(0);
  });
});

describe("live modify", () => {
  it("passes the LTP to the safety check for a LIMIT price change, so the price band applies", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "mod-ltp-00001" });
    await h.svc.modify(h.ctx("live"), order.orderId, { price: 1401 });
    const modCheck = h.safety.calls.filter((c) => c[0] === "check" && c[1].action === "modify").at(-1)[1];
    expect(modCheck.ltp).toBeGreaterThan(0);
  });
});

describe("coalesced reads", () => {
  it("each caller gets its own copy of a shared portfolio read", async () => {
    const h = buildHarness();
    h.zerodha.positions = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", product: "CNC", netQty: 1, avgPrice: 1, ltp: 2, pnl: 1, realisedPnl: null, unrealisedPnl: 1 }];
    const [a, b] = await Promise.all([h.svc.positions(h.ctx("read"), "zerodha-main"), h.svc.positions(h.ctx("read"), "zerodha-main")]);
    a.items[0].symbol = "MUTATED";
    expect(b.items[0].symbol).toBe("NSE:RELIANCE");
  });
});

describe("kill-switch cancel-all is scoped", () => {
  it("cancels only orders the Bridge placed (an outside stop-loss is left) unless includeExternal", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "ks-scope-0001" });
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "OPEN" }), bookRow({ orderId: "MANUAL-SL-1", status: "TRIGGER_PENDING" })];
    h.bus.emit("safety.kill_switch", { engaged: true, reason: "t", by: "me", at: null, cancelOpenOrders: true, cancelScope: { accounts: "*", includeExternal: false } });
    await h.clock.flush();
    await h.clock.flush();
    expect(h.zerodha.cancelled).toEqual([{ orderId: "ZERODHA-1001" }]);
  });

  it("cancels nothing on accounts outside the requesting key's list", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx("live"), liveOrder(), { idempotencyKey: "ks-scope-0002" });
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "OPEN" })];
    h.bus.emit("safety.kill_switch", { engaged: true, reason: "t", by: "me", at: null, cancelOpenOrders: true, cancelScope: { accounts: ["dhan-main"], includeExternal: true } });
    await h.clock.flush();
    await h.clock.flush();
    expect(h.zerodha.cancelled).toEqual([]);
  });
});

describe("unverified live mappers warn", () => {
  it("a Zerodha live preview carries a SAFETY_WARNING; Dhan does not", async () => {
    const h = buildHarness();
    const z = await h.svc.preview(h.ctx("live"), liveOrder());
    expect(z.checks.some((c) => c.code === "SAFETY_WARNING" && /real account/.test(c.message))).toBe(true);
    const d = await h.svc.preview(h.ctx("live"), liveOrder({ account: "dhan-main" }));
    expect(d.checks.some((c) => /real account/.test(c.message))).toBe(false);
  });
});

describe("clientOrderId across clients", () => {
  it("another key reusing a clientOrderId with the same body gets DUPLICATE_CLIENT_ORDER_ID, not the other client's order", async () => {
    const h = buildHarness();
    const body = liveOrder({ account: "paper", mode: undefined, clientOrderId: "strat-shared-1" });
    const first = await h.svc.place(h.ctx("paper"), body);
    const again = await h.svc.place(h.ctx("paper"), body);
    expect(again).toMatchObject({ replayed: true, order: { orderId: first.order.orderId } });
    const other = await reject(h.svc.place(h.ctx("live"), body));
    expect(other.code).toBe("DUPLICATE_CLIENT_ORDER_ID");
  });
});
