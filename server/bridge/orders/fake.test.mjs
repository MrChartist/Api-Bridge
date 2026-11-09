import { describe, expect, it } from "vitest";
import { createCallContext } from "../core/context.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeOrderService } from "./fake.mjs";

const log = createNullLogger();
const ctx = (scopes = ["live"], { source = "rest", accounts = "*", id = "k1", label = "script" } = {}) => createCallContext({ source, key: { id, label, scopes, accounts }, log });
const order = (over = {}) => ({ account: "paper", symbol: "nse:reliance", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400, ...over });

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("fake OrderService", () => {
  it("places paper orders by default with canonical symbols, and replays idempotent requests", async () => {
    const bus = createEventBus();
    const seen = [];
    bus.on("order.updated", (p) => seen.push(p));
    const svc = createFakeOrderService({ bus });
    const a = await svc.place(ctx(), order(), { idempotencyKey: "fake-key-0001" });
    expect(a.order).toMatchObject({ mode: "paper", symbol: "NSE:RELIANCE", status: "open", orderId: expect.stringMatching(/^PAPER-/) });
    const b = await svc.place(ctx(), order(), { idempotencyKey: "fake-key-0001" });
    expect(b).toMatchObject({ replayed: true, order: { orderId: a.order.orderId } });
    expect(await reject(svc.place(ctx(), order({ quantity: 2 }), { idempotencyKey: "fake-key-0001" }))).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(seen).toHaveLength(1);
    expect(svc.calls.map((c) => c[0])).toEqual(["place", "place", "place"]);
  });

  it("enforces live opt-ins and account access, and validates with the real schema", async () => {
    const svc = createFakeOrderService({ accounts: ["dhan-main", "paper"], liveAccounts: ["dhan-main"], lotSizes: { "NFO:NIFTY-2026-10-27-25000-CE": 65 } });
    expect(await reject(svc.place(ctx(), order({ mode: "live" })))).toMatchObject({ code: "PAPER_ONLY" });
    expect(await reject(svc.place(ctx(["paper"]), order({ account: "dhan-main", mode: "live" })))).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect((await svc.place(ctx(), order({ account: "dhan-main", mode: "live" }))).order.mode).toBe("live");
    expect(await reject(svc.place(ctx(["live"], { accounts: ["paper"] }), order({ account: "dhan-main" })))).toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
    expect(await reject(svc.place(ctx(), { account: "paper" }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await svc.place(ctx(), order({ account: "dhan-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: undefined, lots: 2, product: "INTRADAY" }))).order.quantity).toBe(130);
    expect(await reject(svc.place(ctx(), order({ account: "dhan-main", symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: 10, product: "INTRADAY" })))).toMatchObject({ code: "INVALID_ORDER" });
  });

  it("requires a confirmed ticket for AI orders, bound to the exact body", async () => {
    const svc = createFakeOrderService();
    const ai = ctx(["paper"], { source: "mcp", id: "mcp1", label: "Claude" });
    expect(await reject(svc.place(ai, order()))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const pv = await svc.preview(ai, order());
    expect(pv).toMatchObject({ ok: true, requiresHumanConfirmation: true, ticketId: expect.stringMatching(/^tkt_/) });
    const admin = ctx(["admin"], { id: "admin1" });
    expect((await svc.tickets(admin)).map((t) => t.ticketId)).toEqual([pv.ticketId]);
    expect(await reject(svc.confirmTicket(ai, pv.ticketId))).toMatchObject({ code: "SCOPE_REQUIRED" });
    for (const source of ["guard", "alert", "webhook"]) {
      expect(await reject(svc.confirmTicket(ctx(["admin"], { source, id: "admin1" }), pv.ticketId)), source).toMatchObject({ code: "SCOPE_REQUIRED" });
    }
    const { confirmToken } = await svc.confirmTicket(admin, pv.ticketId);
    expect(await reject(svc.place(ai, order({ quantity: 5, confirmToken })))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect((await svc.place(ai, order({ confirmToken }))).order.source).toBe("mcp");
  });

  it("modify, cancel, cancelAll, fills, trades, positions and lookups", async () => {
    const svc = createFakeOrderService({ prices: { "NSE:RELIANCE": 1402 } });
    const { order: o1 } = await svc.place(ctx(), order({ clientOrderId: "c1" }));
    const { order: o2 } = await svc.place(ctx(), order());
    expect((await svc.modify(ctx(), o1.orderId, { price: 1401 })).order.price).toBe(1401);
    svc.fill(o1.orderId, 1401);
    expect(await reject(svc.cancel(ctx(), o1.orderId))).toMatchObject({ code: "INVALID_ORDER" });
    expect((await svc.cancelAll(ctx(), {})).cancelled).toEqual([o2.orderId]);
    expect((await svc.getByClientId(ctx(), "c1")).orderId).toBe(o1.orderId);
    expect((await svc.trades(ctx(), {})).items[0]).toMatchObject({ orderId: o1.orderId, price: 1401 });
    expect((await svc.positions(ctx(), "paper")).items[0]).toMatchObject({ symbol: "NSE:RELIANCE", netQty: 1, ltp: 1402 });
    expect((await svc.list(ctx(), { status: "cancelled" })).items.map((o) => o.orderId)).toEqual([o2.orderId]);
    expect((await svc.funds(ctx(), "paper")).funds.availableCash).toBe(1_000_000);
    expect(await reject(svc.get(ctx(), "nope"))).toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("placeToTarget and placeBatch run the real implementations over the fake", async () => {
    const svc = createFakeOrderService({ lotSizes: { "NFO:NIFTY-2026-10-27-FUT": 65 } });
    const t = { account: "paper", symbol: "NFO:NIFTY-2026-10-27-FUT", targetLots: 2, product: "MARGIN", orderType: "LIMIT", price: 25000 };
    const first = await svc.placeToTarget(ctx(), t, { idempotencyKey: "tt-fake-0001" });
    expect(first).toMatchObject({ status: 201, result: { currentQuantity: 0, targetQuantity: 130, delta: 130, action: "BUY", placed: true } });
    svc.fill(first.result.order.orderId, 25000);
    const again = await svc.placeToTarget(ctx(), t, { idempotencyKey: "tt-fake-0002" });
    expect(again).toMatchObject({ status: 200, result: { currentQuantity: 130, action: "NONE", order: null } });
    const batch = await svc.placeBatch(ctx(), { account: "paper", orders: [order({ account: undefined }), order({ account: undefined, product: "BAD" })] }, { idempotencyKey: "batch-fake-0001" });
    expect(batch).toMatchObject({ status: 207, result: { ok: false, summary: { placed: 1, rejected: 1 } } });
  });

  it("failNext makes the next place throw (and releases its idempotency key)", async () => {
    const svc = createFakeOrderService();
    svc.failNext(new BridgeError("KILL_SWITCH_ACTIVE", "on"));
    expect(await reject(svc.place(ctx(), order(), { idempotencyKey: "fail-key-0001" }))).toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
    expect((await svc.place(ctx(), order(), { idempotencyKey: "fail-key-0001" })).replayed).toBe(false);
  });
});
