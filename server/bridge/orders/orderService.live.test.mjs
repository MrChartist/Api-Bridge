/**
 * OrderService live path, over published fakes (accounts, scheduler, symbols, market data), stub safety/audit/paper
 * and stub adapters whose order methods use the REAL order gate. Fake clock; no network.
 *
 * Acceptance: the same Idempotency-Key never reaches the adapter twice (concurrency test); a
 * timed-out live call is never retried and becomes outcome_unknown, then resolves from a fixture order book; a live
 * request without each opt-in fails with the right code.
 */
import { describe, expect, it } from "vitest";
import { BridgeError } from "../core/errors.mjs";
import { BrokerInputError } from "../../brokers/contract.mjs";
import { bookRow, buildHarness, createStubSafety, liveOrder } from "./__fixtures__/helpers.mjs";

/** Attach a handler at once (the rejection may happen while the fake clock advances). */
const caught = (p) => p.then(
  () => {
    throw new Error("expected a rejection");
  },
  (e) => e,
);

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("mode decision: paper by default, live only with every opt-in", () => {
  it("an order without mode goes to the paper engine, never the adapter", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx("live"), liveOrder({ mode: undefined }));
    expect(order.mode).toBe("paper");
    expect(order.orderId).toMatch(/^PAPER-/);
    expect(h.zerodha.placed).toHaveLength(0);
    expect(h.paper.calls[0][0]).toBe("place");
  });

  it("safety.liveTrading off -> PAPER_ONLY", async () => {
    const h = buildHarness({ raw: { safety: { liveTrading: false } } });
    const e = await reject(h.svc.place(h.ctx("live"), liveOrder()));
    expect(e).toMatchObject({ code: "PAPER_ONLY", status: 403 });
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("account without live.enabled -> PAPER_ONLY", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.place(h.ctx("live"), liveOrder({ account: "zerodha-2" })))).toMatchObject({ code: "PAPER_ONLY" });
  });

  it("key without the live scope -> SCOPE_REQUIRED", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.place(h.ctx("paper"), liveOrder()))).toMatchObject({ code: "SCOPE_REQUIRED", status: 403 });
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("source not in allowedSources -> PAPER_ONLY", async () => {
    const h = buildHarness();
    const e = await reject(h.svc.place(h.ctx("live", { source: "webhook" }), liveOrder({ account: "dhan-main" })));
    expect(e.code).toBe("PAPER_ONLY");
    expect(e.detail).toMatch(/webhooks/);
  });

  it("a paper account cannot go live", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.place(h.ctx("live"), liveOrder({ account: "paper" })))).toMatchObject({ code: "PAPER_ONLY" });
  });

  it("an AI-sourced order without a confirmed ticket never reaches the adapter", async () => {
    const h = buildHarness();
    const e = await reject(h.svc.place(h.ctx("mcp", { source: "mcp" }), liveOrder()));
    expect(e).toMatchObject({ code: "CONFIRMATION_REQUIRED", status: 422 });
    expect(e.detail).toMatch(/human confirmation/);
    const forged = await reject(h.svc.place(h.ctx("mcp", { source: "mcp" }), liveOrder({ confirmToken: "mct_forged_token_000000000000" })));
    expect(forged.code).toBe("CONFIRMATION_REQUIRED");
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("a hook marked confirmation-required needs a ticket too", async () => {
    const h = buildHarness();
    const e = await reject(h.svc.place(h.ctx("live", { source: "webhook", confirmationRequired: true }), liveOrder()));
    expect(e.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("the key's account list is enforced before anything else", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.place(h.ctx("dhanOnly"), liveOrder()))).toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
  });
});

describe("live placement", () => {
  it("passes safety, takes an order slot, schedules with order priority and mints one gate per call", async () => {
    const h = buildHarness();
    const { order, replayed } = await h.svc.place(h.ctx("live"), liveOrder({ clientOrderId: "strat-1", tag: "ema" }));
    expect(replayed).toBe(false);
    expect(order).toMatchObject({ mode: "live", status: "open", accountId: "zerodha-main", broker: "zerodha", symbol: "NSE:RELIANCE", quantity: 10, clientOrderId: "strat-1", tag: "ema", source: "rest" });
    expect(order.orderId).toMatch(/^ord_[0-9a-f]{24}$/);
    expect(order.legs).toEqual([{ brokerOrderId: "ZERODHA-1001", quantity: 10, status: "open", error: null }]);
    expect(order.placedAt).toMatch(/\+05:30$/);
    expect(h.zerodha.placed).toHaveLength(1);
    expect(h.zerodha.placed[0]).toMatchObject({ lotSize: 1, order: { tradingsymbol: "RELIANCE", exchange: "NSE", transactionType: "BUY", orderType: "LIMIT", product: "CNC", price: 1400, lots: 10 } });
    expect(h.zerodha.placed[0].order.tag).toMatch(/^MCB[A-Z2-7]{13}$/); // short tag derived from clientOrderId
    expect(h.scheduler.calls.filter((c) => c.endpointClass === "order")).toEqual([expect.objectContaining({ accountId: "zerodha-main", priority: "order" })]);
    expect(h.safety.calls.map((c) => c[0])).toEqual(["check", "acquireOrderSlot"]);
    expect(h.safety.calls[0][1]).toMatchObject({ mode: "live", action: "place", quantity: 10, value: 14000, ltp: 1402.3, keyId: "livekey0001" });
    expect(h.safety.events).toContainEqual(["zerodha-main", { action: "place", mode: "live", status: "open" }]);
    expect(h.audit.types()).toEqual(["order.requested", "order.placed"]);
  });

  it("emits order.updated", async () => {
    const h = buildHarness();
    const seen = [];
    h.bus.on("order.updated", (p) => seen.push(p));
    await h.svc.place(h.ctx("live"), liveOrder());
    expect(seen).toEqual([expect.objectContaining({ mode: "live", status: "open", accountId: "zerodha-main", source: "rest" })]);
  });

  it("maps Dhan orders (STOP_LOSS, segment, security id) and converts MARKET to a protected LIMIT", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx("live"), liveOrder({ account: "dhan-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: undefined, lots: 2, product: "INTRADAY", orderType: "SL", price: 121, triggerPrice: 120 }));
    expect(h.dhan.placed[0]).toMatchObject({ lotSize: 65, order: { exchangeSegment: "NSE_FNO", securityId: "51440", orderType: "STOP_LOSS", lots: 2, price: 121, triggerPrice: 120 } });
    const { order } = await h.svc.place(h.ctx("live"), liveOrder({ account: "dhan-main", orderType: "MARKET", price: undefined }));
    expect(h.dhan.placed[1].order).toMatchObject({ orderType: "LIMIT", price: 1430.3 });
    expect(order).toMatchObject({ orderType: "LIMIT", price: 1430.3 });
    expect(order.warnings.join(" ")).toMatch(/converted to LIMIT at 1430.3/);
  });

  it("keeps MARKET with native protection where the broker has it", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx("live"), liveOrder({ orderType: "MARKET", price: undefined, marketProtectionPct: 1 }));
    expect(h.zerodha.placed[0].order).toMatchObject({ orderType: "MARKET", marketProtection: 1 });
  });

  it("refuses MARKET orders when the policy is reject", async () => {
    const h = buildHarness({ raw: { safety: { liveTrading: true, marketOrders: "reject" } } });
    expect(await reject(h.svc.place(h.ctx("live"), liveOrder({ orderType: "MARKET", price: undefined })))).toMatchObject({ code: "INVALID_ORDER" });
  });

  it("refuses brokers whose live payload is not wired, before anything is sent", async () => {
    const h = buildHarness();
    const e = await reject(h.svc.place(h.ctx("live"), liveOrder({ account: "angel-main" })));
    expect(e.code).toBe("CAPABILITY_UNSUPPORTED");
    expect(h.angelone.placed).toHaveLength(0);
    const { order } = await h.svc.place(h.ctx("live"), liveOrder({ account: "angel-main", mode: "paper" }));
    expect(order.mode).toBe("paper");
  });

  it("pre-trade checks: lot multiple, tick size, freeze quantity, index", async () => {
    const h = buildHarness();
    const ce = { account: "zerodha-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", product: "INTRADAY", orderType: "LIMIT", price: 120.5, side: "BUY", mode: "live" };
    expect((await reject(h.svc.place(h.ctx(), { ...ce, quantity: 100 }))).detail).toMatch(/lot size 65/);
    expect((await reject(h.svc.place(h.ctx(), { ...ce, lots: 1, price: 120.52 }))).detail).toMatch(/tick size/);
    expect((await reject(h.svc.place(h.ctx(), { ...ce, lots: 30 }))).detail).toMatch(/freeze quantity 1800/);
    expect((await reject(h.svc.place(h.ctx(), liveOrder({ symbol: "NSE:NIFTY" })))).detail).toMatch(/index/);
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("slices above the freeze quantity when configured: one gated call per leg", async () => {
    const h = buildHarness({ orders: { sliceAboveFreeze: true } });
    const { order } = await h.svc.place(h.ctx(), { account: "zerodha-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", lots: 30, product: "INTRADAY", orderType: "LIMIT", price: 120.5, side: "BUY", mode: "live" });
    expect(order.quantity).toBe(1950);
    expect(order.legs.map((l) => l.quantity)).toEqual([1755, 195]);
    expect(h.zerodha.placed.map((p) => p.order.lots)).toEqual([27, 3]);
    expect(h.safety.calls.filter((c) => c[0] === "acquireOrderSlot")).toHaveLength(2);
  });

  it("safety refusals come back with all reasons, kill switch first", async () => {
    const safety = createStubSafety({ refuse: [{ code: "DAILY_LIMIT_REACHED", message: "100 orders today." }, { code: "KILL_SWITCH_ACTIVE", message: "Kill switch is on." }] });
    const h = buildHarness({ safety });
    const e = await reject(h.svc.place(h.ctx(), liveOrder()));
    expect(e).toMatchObject({ code: "KILL_SWITCH_ACTIVE", status: 423 });
    expect(e.errors.map((x) => x.path)).toEqual(["KILL_SWITCH_ACTIVE", "DAILY_LIMIT_REACHED"]);
    expect(h.zerodha.placed).toHaveLength(0);
    expect(h.audit.types()).toEqual(["order.refused"]);
  });

  it("order-rate cap -> ORDER_RATE_LIMITED with Retry-After, nothing sent, key released", async () => {
    const safety = createStubSafety({ slots: 0, retryAfterMs: 400 });
    const h = buildHarness({ safety });
    const e = await reject(h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "rate-key-0001" }));
    expect(e).toMatchObject({ code: "ORDER_RATE_LIMITED", status: 429, retryAfterMs: 400 });
    expect(h.zerodha.placed).toHaveLength(0);
    safety.slots = 5;
    const { order, replayed } = await h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "rate-key-0001" });
    expect(replayed).toBe(false);
    expect(order.status).toBe("open");
  });

  it("does not send a live order when the audit log is down", async () => {
    const h = buildHarness();
    h.audit.fail = true;
    expect(await reject(h.svc.place(h.ctx(), liveOrder()))).toMatchObject({ code: "INTERNAL" });
    expect(h.zerodha.placed).toHaveLength(0);
  });

  it("a clear broker refusal is not outcome_unknown: rejected, key and clientOrderId released", async () => {
    const h = buildHarness();
    h.zerodha.next = new BrokerInputError("Zerodha: invalid order id.");
    const e = await reject(h.svc.place(h.ctx(), liveOrder({ clientOrderId: "c-1" }), { idempotencyKey: "refused-key-1" }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(h.audit.types()).toContain("order.rejected");
    h.zerodha.next = "ack";
    const again = await h.svc.place(h.ctx(), liveOrder({ clientOrderId: "c-1" }), { idempotencyKey: "refused-key-1" });
    expect(again.order.status).toBe("open");
    expect(h.zerodha.placed).toHaveLength(2);
  });

  it("a session error before the call refuses cleanly (nothing sent)", async () => {
    const h = buildHarness();
    h.accounts.setState("zerodha-main", "expired");
    expect(await reject(h.svc.place(h.ctx(), liveOrder()))).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(h.zerodha.placed).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("the same Idempotency-Key never reaches the adapter twice, even under concurrency", async () => {
    const h = buildHarness();
    h.zerodha.next = "hang";
    const ctx = h.ctx();
    const first = h.svc.place(ctx, liveOrder(), { idempotencyKey: "conc-key-0001" });
    const rest = await Promise.allSettled(Array.from({ length: 20 }, () => h.svc.place(ctx, liveOrder(), { idempotencyKey: "conc-key-0001" })));
    expect(rest.every((r) => r.status === "rejected" && r.reason.code === "IDEMPOTENCY_IN_PROGRESS")).toBe(true);
    await h.clock.flush();
    expect(h.zerodha.pendingCount()).toBe(1);
    h.zerodha.release();
    const { order } = await first;
    const replays = await Promise.all(Array.from({ length: 5 }, () => h.svc.place(ctx, liveOrder(), { idempotencyKey: "conc-key-0001" })));
    expect(replays.every((r) => r.replayed && r.order.orderId === order.orderId)).toBe(true);
    expect(h.zerodha.placed).toHaveLength(1);
  });

  it("a different body with the same key -> 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "reuse-key-001" });
    expect(await reject(h.svc.place(h.ctx(), liveOrder({ quantity: 11 }), { idempotencyKey: "reuse-key-001" }))).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("keys are per client: another key may use the same Idempotency-Key value", async () => {
    const h = buildHarness();
    const live = h.ctx("live");
    const other = h.ctx("dhanOnly");
    await h.svc.place(live, liveOrder(), { idempotencyKey: "shared-value-1" });
    const r = await h.svc.place(other, liveOrder({ account: "dhan-main" }), { idempotencyKey: "shared-value-1" });
    expect(r.replayed).toBe(false);
  });

  it("clientOrderId works as the key when the header is absent; a different order with it is a duplicate", async () => {
    const h = buildHarness();
    const a = await h.svc.place(h.ctx(), liveOrder({ clientOrderId: "my-1" }));
    const b = await h.svc.place(h.ctx(), liveOrder({ clientOrderId: "my-1" }));
    expect(b).toMatchObject({ replayed: true, order: { orderId: a.order.orderId } });
    expect(await reject(h.svc.place(h.ctx(), liveOrder({ clientOrderId: "my-1", price: 1399 })))).toMatchObject({ code: "DUPLICATE_CLIENT_ORDER_ID", status: 409 });
    expect(await reject(h.svc.place(h.ctx(), liveOrder({ clientOrderId: "my-1" }), { idempotencyKey: "fresh-key-0001" }))).toMatchObject({ code: "DUPLICATE_CLIENT_ORDER_ID" });
    expect(h.zerodha.placed).toHaveLength(1);
    expect((await h.svc.getByClientId(h.ctx("read"), "my-1")).orderId).toBe(a.order.orderId);
  });

  it("validates the Idempotency-Key format", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "short" }))).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("OUTCOME_UNKNOWN and reconciliation", () => {
  it("a timed-out call is never retried, becomes outcome_unknown, then resolves from the order book", async () => {
    const h = buildHarness();
    const unknownEvents = [];
    h.bus.on("order.outcome_unknown", (p) => unknownEvents.push(p));
    h.zerodha.next = "hang";
    const p = caught(h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "timeout-key-01" }));
    await h.clock.advance(15_000);
    const e = await p;
    expect(e).toMatchObject({ code: "OUTCOME_UNKNOWN", status: 504, retryable: false });
    const orderId = e.detail.match(/ord_[0-9a-f]+/)[0];
    expect(unknownEvents).toEqual([expect.objectContaining({ orderId, accountId: "zerodha-main" })]);
    expect(h.audit.types()).toContain("order.outcome_unknown");

    // A client retry with the same key replays the unknown order; nothing is sent again.
    const replay = await h.svc.place(h.ctx(), liveOrder(), { idempotencyKey: "timeout-key-01" });
    expect(replay).toMatchObject({ replayed: true, order: { orderId, status: "outcome_unknown" } });
    await h.clock.advance(60_000);
    expect(h.zerodha.placed).toHaveLength(1);

    // The order shows up in the broker's book: the reconciliation job resolves it.
    const updates = [];
    h.bus.on("order.updated", (u) => updates.push(u));
    h.zerodha.book = [bookRow({ orderId: "Z-777", qty: 10, price: 1400, status: "OPEN", placedAt: new Date(h.clock.now() - 70_000).toISOString() })];
    await h.clock.advance(3000);
    const order = await h.svc.get(h.ctx("read"), orderId);
    expect(order.status).toBe("open");
    expect(order.legs[0]).toMatchObject({ brokerOrderId: "Z-777", status: "open" });
    expect(updates.some((u) => u.orderId === orderId && u.status === "open")).toBe(true);
    expect(h.audit.types()).toContain("order.reconciled");
    expect(h.scheduler.calls.some((c) => c.endpointClass === "portfolio" && c.priority === "live")).toBe(true);
  });

  it("a late answer from the adapter resolves the unknown leg", async () => {
    const h = buildHarness();
    h.zerodha.next = "hang";
    const p = caught(h.svc.place(h.ctx(), liveOrder()));
    await h.clock.advance(15_000);
    const e = await p;
    const orderId = e.detail.match(/ord_[0-9a-f]+/)[0];
    h.zerodha.release({ orderId: "Z-LATE", orderStatus: "OPEN" });
    await h.clock.flush();
    h.zerodha.book = [bookRow({ orderId: "Z-LATE", status: "OPEN" })];
    const order = await h.svc.get(h.ctx("read"), orderId);
    expect(order).toMatchObject({ status: "open", legs: [expect.objectContaining({ brokerOrderId: "Z-LATE" })] });
  });

  it("an ambiguous upstream failure on a write is outcome_unknown, not a refusal", async () => {
    const h = buildHarness();
    h.zerodha.next = Object.assign(new Error("socket hang up"), { code: "UPSTREAM_ERROR", statusCode: 502 });
    const e = await reject(h.svc.place(h.ctx(), liveOrder()));
    expect(e.code).toBe("OUTCOME_UNKNOWN");
    expect(e.broker).toMatchObject({ id: "zerodha", code: "UPSTREAM_ERROR" });
  });

  it("gives up after the configured time but never claims the order failed", async () => {
    const h = buildHarness({ orders: { reconcileGiveUpMs: 60_000 } });
    h.zerodha.next = "hang";
    const p = caught(h.svc.place(h.ctx(), liveOrder()));
    await h.clock.advance(15_000);
    const orderId = (await p).detail.match(/ord_[0-9a-f]+/)[0];
    await h.clock.advance(70_000);
    const order = await h.svc.get(h.ctx("read"), orderId);
    expect(order.status).toBe("outcome_unknown");
    expect(order.statusMessage).toMatch(/may or may not have been placed/);
    expect(h.audit.types()).toContain("order.reconcile_gave_up");
    expect(await h.svc.reconcileNow()).toEqual({ accounts: 0, unknown: 0 });
  });

  it("does not resolve when several book rows match (ambiguous)", async () => {
    const h = buildHarness();
    h.zerodha.next = "hang";
    const p = caught(h.svc.place(h.ctx(), liveOrder()));
    await h.clock.advance(15_000);
    const orderId = (await p).detail.match(/ord_[0-9a-f]+/)[0];
    h.zerodha.book = [bookRow({ orderId: "A" }), bookRow({ orderId: "B" })];
    await h.svc.reconcileNow();
    const order = await h.svc.get(h.ctx("read"), orderId);
    expect(order.status).toBe("outcome_unknown");
    expect(order.statusMessage).toMatch(/2 broker orders look like this one/);
  });
});

describe("modify and cancel (live)", () => {
  it("modifies through the gate with the full field set and counts modifications", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    const r = await h.svc.modify(h.ctx(), order.orderId, { price: 1401 }, { idempotencyKey: "mod-key-00001" });
    expect(r.order.price).toBe(1401);
    expect(h.zerodha.modified[0]).toEqual({ orderId: "ZERODHA-1001", changes: { orderType: "LIMIT", validity: "DAY", quantity: 10, price: 1401 } });
    const replay = await h.svc.modify(h.ctx(), order.orderId, { price: 1401 }, { idempotencyKey: "mod-key-00001" });
    expect(replay.replayed).toBe(true);
    expect(h.zerodha.modified).toHaveLength(1);
    await h.svc.modify(h.ctx(), order.orderId, { price: 1402 });
    // The fake policy allows 2 modifications per order.
    expect(await reject(h.svc.modify(h.ctx(), order.orderId, { price: 1403 }))).toMatchObject({ code: "INVALID_ORDER" });
    expect(h.safety.calls.filter((c) => c[0] === "check").map((c) => c[1].action)).toEqual(["place", "modify", "modify"]);
  });

  it("checks a live change with the order's lot size and its new value (per-order lots and value limits)", async () => {
    const safety = createStubSafety();
    const h = buildHarness({ safety });
    const { order } = await h.svc.place(h.ctx(), liveOrder({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: 130, product: "INTRADAY", price: 120.5 }));
    // Refuse what SafetyGuard would refuse at 10 lots / ₹2,00,000, from the intent the service sends.
    safety.refuse = (i) => (i.action === "modify" && (i.lots > 10 || i.value > 200_000) ? [{ code: "INVALID_ORDER", message: `lots ${i.lots} value ${i.value}` }] : []);
    const e = await reject(h.svc.modify(h.ctx(), order.orderId, { quantity: 1300 }));
    expect(e).toMatchObject({ code: "INVALID_ORDER", detail: "lots 20 value 156650" });
    const intent = safety.calls.filter((c) => c[0] === "check").at(-1)[1];
    expect(intent).toMatchObject({ mode: "live", action: "modify", quantity: 1300, lots: 20, lotSize: 65, value: 156_650, ltp: 120.5 });
    expect(h.zerodha.modified).toHaveLength(0);
    // Above the freeze quantity (1800): a change cannot be sliced, so it is refused before the safety check.
    expect((await reject(h.svc.modify(h.ctx(), order.orderId, { quantity: 1820 }))).detail).toMatch(/freeze quantity 1800/);
    const ok = await h.svc.modify(h.ctx(), order.orderId, { quantity: 650, price: 121 });
    expect(ok.order.quantity).toBe(650);
    expect(safety.calls.filter((c) => c[0] === "check").at(-1)[1]).toMatchObject({ lots: 10, value: 78_650 });
    expect(h.zerodha.modified).toHaveLength(1);
  });

  it("validates changes (tick, lot, SL ordering) and refuses AI changes to live orders", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    expect((await reject(h.svc.modify(h.ctx(), order.orderId, { price: 1401.05 }))).detail).toMatch(/tick size/);
    expect((await reject(h.svc.modify(h.ctx(), order.orderId, { orderType: "SL" }))).detail).toMatch(/triggerPrice is required/);
    expect(await reject(h.svc.modify(h.ctx("mcp", { source: "mcp" }), order.orderId, { price: 1401 }))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(await reject(h.svc.modify(h.ctx("paper"), order.orderId, { price: 1401 }))).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(h.zerodha.modified).toHaveLength(0);
  });

  it("cancels through the gate; cancels are allowed even when the safety check would refuse", async () => {
    const safety = createStubSafety();
    const h = buildHarness({ safety });
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    safety.refuse = [{ code: "KILL_SWITCH_ACTIVE", message: "on" }];
    const r = await h.svc.cancel(h.ctx(), order.orderId);
    expect(r.order.status).toBe("cancelled");
    expect(h.zerodha.cancelled).toEqual([{ orderId: "ZERODHA-1001" }]);
    expect(await reject(h.svc.cancel(h.ctx(), order.orderId))).toMatchObject({ code: "INVALID_ORDER" });
  });

  it("other accounts' orders are invisible", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    expect(await reject(h.svc.get(h.ctx("dhanOnly"), order.orderId))).toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(await reject(h.svc.cancel(h.ctx("dhanOnly"), order.orderId))).toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});

describe("cancel-all and the kill switch", () => {
  it("cancels open broker orders (including ones placed outside the Bridge) and paper orders", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    const paper = await h.svc.place(h.ctx(), liveOrder({ mode: "paper" }));
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "OPEN" }), bookRow({ orderId: "MANUAL-9", status: "TRIGGER_PENDING" }), bookRow({ orderId: "DONE-1", status: "COMPLETE" })];
    const r = await h.svc.cancelAll(h.ctx(), { accountId: "zerodha-main" });
    expect(r.failed).toEqual([]);
    expect(r.cancelled.sort()).toEqual([order.orderId, "MANUAL-9", paper.order.orderId].sort());
    expect(h.zerodha.cancelled.map((c) => c.orderId).sort()).toEqual(["MANUAL-9", "ZERODHA-1001"]);
  });

  it("bridgeOnly leaves orders placed outside the Bridge open, and the answer says what was cancelled in each group", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    const paper = await h.svc.place(h.ctx(), liveOrder({ mode: "paper" }));
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "OPEN" }), bookRow({ orderId: "MANUAL-9", status: "TRIGGER_PENDING", side: "SELL", qty: 5, pendingQty: 5 }), bookRow({ orderId: "DONE-1", status: "COMPLETE" })];
    // A dry run lists both groups and cancels nothing.
    const dry = await h.svc.cancelAll(h.ctx(), { accountId: "zerodha-main", dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, cancelled: [], failed: [] });
    expect(dry.bridge.open.map((o) => o.orderId).sort()).toEqual([order.orderId, paper.order.orderId].sort());
    expect(dry.external.open).toEqual([{ orderId: "MANUAL-9", accountId: "zerodha-main", mode: "live", symbol: "NSE:RELIANCE", side: "SELL", quantity: 5, status: "trigger_pending", external: true }]);
    expect(h.zerodha.cancelled).toHaveLength(0);
    expect(h.audit.records.filter((r) => r.type === "order.cancel_all")).toHaveLength(0);
    // Bridge orders only.
    const r = await h.svc.cancelAll(h.ctx(), { accountId: "zerodha-main", bridgeOnly: true });
    expect(r.failed).toEqual([]);
    expect(r.cancelled.sort()).toEqual([order.orderId, paper.order.orderId].sort());
    expect(r.bridge.cancelled.sort()).toEqual([order.orderId, paper.order.orderId].sort());
    expect(r.external).toEqual({ cancelled: [], left: ["MANUAL-9"] });
    expect(h.zerodha.cancelled.map((c) => c.orderId)).toEqual(["ZERODHA-1001"]);
    // Then the outside one too, when asked.
    h.zerodha.book = [bookRow({ orderId: "MANUAL-9", status: "TRIGGER_PENDING" })];
    const all = await h.svc.cancelAll(h.ctx(), { accountId: "zerodha-main", bridgeOnly: false });
    expect(all).toMatchObject({ cancelled: ["MANUAL-9"], bridge: { cancelled: [] }, external: { cancelled: ["MANUAL-9"], left: [] } });
  });

  it("a key without the live scope cancels only paper orders", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx(), liveOrder());
    const r = await h.svc.cancelAll(h.ctx("paper"), { accountId: "zerodha-main", mode: "live" });
    expect(r.failed[0]).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(h.zerodha.cancelled).toHaveLength(0);
  });

  it("runs cancel-all when safety.kill_switch asks for it", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx(), liveOrder());
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "OPEN" })];
    h.bus.emit("safety.kill_switch", { engaged: true, reason: "test", by: "me", at: null, cancelOpenOrders: true });
    await h.clock.flush();
    await h.clock.flush();
    expect(h.zerodha.cancelled).toEqual([{ orderId: "ZERODHA-1001" }]);
    expect(h.audit.records.find((r) => r.type === "order.cancel_all")).toMatchObject({ actor: { kind: "system", id: "bridge" }, source: "system" });
  });

  it("ignores kill-switch events without cancelOpenOrders, and stops listening after close()", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx(), liveOrder());
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "OPEN" })];
    h.bus.emit("safety.kill_switch", { engaged: true, cancelOpenOrders: false });
    h.svc.close();
    h.bus.emit("safety.kill_switch", { engaged: true, cancelOpenOrders: true });
    await h.clock.flush();
    expect(h.zerodha.cancelled).toHaveLength(0);
  });
});

describe("restart", () => {
  it("keeps idempotency, clientOrderIds and live orders across a restart", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder({ clientOrderId: "keep-1" }), { idempotencyKey: "restart-key-1" });
    h.svc.close();
    const h2 = buildHarness({ dataDir: h.dataDir });
    const r = await h2.svc.place(h2.ctx(), liveOrder({ clientOrderId: "keep-1" }), { idempotencyKey: "restart-key-1" });
    expect(r).toMatchObject({ replayed: true, order: { orderId: order.orderId } });
    expect(await reject(h2.svc.place(h2.ctx(), liveOrder({ clientOrderId: "keep-1", price: 1390 }), { idempotencyKey: "other-key-001" }))).toMatchObject({ code: "DUPLICATE_CLIENT_ORDER_ID" });
    expect(h2.zerodha.placed).toHaveLength(0);
  });

  it("an order that was being sent when the Bridge stopped becomes outcome_unknown and is reconciled", async () => {
    const h = buildHarness();
    h.zerodha.next = "hang";
    h.svc.place(h.ctx(), liveOrder()).catch(() => {});
    await h.clock.flush();
    expect(h.zerodha.pendingCount()).toBe(1);
    h.svc.close();
    const h2 = buildHarness({ dataDir: h.dataDir });
    const page = await h2.svc.list(h2.ctx("read"), { mode: "live" });
    expect(page.items[0]).toMatchObject({ status: "outcome_unknown" });
    h2.zerodha.book = [bookRow({ orderId: "Z-AFTER", status: "COMPLETE", filledQty: 10, avgPrice: 1399.5 })];
    await h2.clock.advance(3000);
    const order = await h2.svc.get(h2.ctx("read"), page.items[0].orderId);
    expect(order).toMatchObject({ status: "filled", filledQuantity: 10, avgPrice: 1399.5 });
  });
});

describe("no secrets anywhere", () => {
  it("credentials never appear in logs, audit records, results or the state file", async () => {
    const h = buildHarness();
    h.zerodha.next = "hang";
    const p = caught(h.svc.place(h.ctx(), liveOrder()));
    await h.clock.advance(15_000);
    await p;
    h.zerodha.next = "ack";
    const { order } = await h.svc.place(h.ctx(), liveOrder({ price: 1399 }));
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const haystack = [h.lines.join("\n"), JSON.stringify(h.audit.records), JSON.stringify(order), readFileSync(join(h.dataDir, "orders", "state.json"), "utf8")].join("\n");
    for (const secret of ["kite-access-token-secret", "kite-api-key", "dhan-access-token-secret"]) expect(haystack).not.toContain(secret);
    // The adapter got credentials (by key) — the service passed them through without keeping them.
    expect(h.zerodha.placed[0].creds).toEqual(["apiKey", "accessToken"]);
  });
});

describe("errors keep their codes", () => {
  it("BridgeErrors thrown by the scheduler before the call are refusals", async () => {
    const h = buildHarness();
    h.scheduler.throttle("zerodha-main", "order", 5000);
    const e = await reject(h.svc.place(h.ctx(), liveOrder()));
    expect(e).toBeInstanceOf(BridgeError);
    expect(e.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(h.zerodha.placed).toHaveLength(0);
  });
});
