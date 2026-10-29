/**
 * OrderService: preview, human-confirmation tickets, the paper path, listings and portfolio reads.
 */
import { describe, expect, it } from "vitest";
import { bookRow, buildHarness, liveOrder } from "./__fixtures__/helpers.mjs";

const reject = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
};

describe("preview", () => {
  it("resolves, sizes and checks without sending anything", async () => {
    const h = buildHarness();
    const r = await h.svc.preview(h.ctx(), liveOrder({ symbol: "nfo:nifty-2026-10-27-25000-ce", quantity: undefined, lots: 2, product: "INTRADAY", price: 120.5 }));
    expect(r).toMatchObject({ ok: true, mode: "live", quantity: 130, estimatedValue: 15665, ltp: 120.5, requiresHumanConfirmation: false, ticketId: null, confirmToken: null });
    expect(r.resolved).toMatchObject({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", lotSize: 65, tickSize: 0.05, freezeQty: 1800, kind: "OPT" });
    expect(r.resolved.refs).toBeUndefined();
    expect(h.zerodha.placed).toHaveLength(0);
    expect(h.safety.calls.map((c) => c[0])).toEqual(["check"]);
  });

  it("returns every problem as a check instead of throwing", async () => {
    const h = buildHarness({ raw: { safety: { liveTrading: false } } });
    const r = await h.svc.preview(h.ctx("paper"), liveOrder({ quantity: 10, price: 1400.05 }));
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => c.code)).toEqual(expect.arrayContaining(["PAPER_ONLY", "SCOPE_REQUIRED", "INVALID_ORDER"]));
    const unknown = await h.svc.preview(h.ctx(), liveOrder({ symbol: "NSE:NOSUCHSTOCK", mode: "paper" }));
    expect(unknown).toMatchObject({ ok: false, resolved: null, quantity: null });
    expect(unknown.checks[0].code).toBe("SYMBOL_NOT_FOUND");
  });

  it("still validates the body shape strictly (400)", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.preview(h.ctx(), { account: "zerodha-main" }))).toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });
});

describe("LOT_SIZE_STALE (p1-02 §3.6)", () => {
  const staleRef = ({ block = false, conflict = null, stale = true } = {}) => {
    const calls = [];
    return {
      calls,
      lotFor: async (underlying, expiry, o) => {
        calls.push([underlying, expiry, o]);
        return { lot: 65, asOf: "2026-10-27", stale, staleTradingDays: 2, conflict, staleAfterTradingDays: 1, blockWhenStale: block };
      },
    };
  };
  const inLots = (over = {}) => liveOrder({ symbol: "NFO:NIFTY-2026-10-27-25000-CE", quantity: undefined, lots: 1, product: "INTRADAY", price: 120.5, mode: "paper", ...over });

  it("is a warning by default, with the date and age of the lot data", async () => {
    const reference = staleRef();
    const h = buildHarness({ reference });
    const r = await h.svc.preview(h.ctx(), inLots());
    expect(r.ok).toBe(true);
    const c = r.checks.find((x) => x.code === "LOT_SIZE_STALE");
    expect(c).toEqual({ code: "LOT_SIZE_STALE", severity: "warn", message: "Lot size for NIFTY is from 27 Oct (2 trading days old). Confirm 65 units per lot or send quantity in units." });
    expect(reference.calls[0]).toEqual(["NIFTY", "2026-10-27", { exchange: "NFO" }]);
  });

  it("blocks when reference.blockLotsWhenStale is on; lotSizeConfirmed equal to the lot clears it", async () => {
    const h = buildHarness({ reference: staleRef({ block: true }) });
    const blocked = await h.svc.preview(h.ctx(), inLots());
    expect(blocked.ok).toBe(false);
    expect(blocked.checks.find((x) => x.code === "LOT_SIZE_STALE").severity).toBe("block");
    const wrong = await h.svc.preview(h.ctx(), inLots({ lotSizeConfirmed: 75 }));
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.find((x) => x.code === "LOT_SIZE_STALE").message).toMatch(/lotSizeConfirmed 75 does not match/);
    const ok = await h.svc.preview(h.ctx(), inLots({ lotSizeConfirmed: 65 }));
    expect(ok.ok).toBe(true);
    expect(ok.checks.some((x) => x.code === "LOT_SIZE_STALE")).toBe(false);
    const placed = await h.svc.place(h.ctx(), inLots({ lotSizeConfirmed: 65 }));
    expect(placed.order).toMatchObject({ mode: "paper", quantity: 65 });
  });

  it("a master/reference conflict needs the same confirmation", async () => {
    const h = buildHarness({ reference: staleRef({ block: true, stale: false, conflict: { master: 65, reference: 75 } }) });
    const r = await h.svc.preview(h.ctx(), inLots());
    expect(r.checks.find((x) => x.code === "LOT_SIZE_STALE").message).toMatch(/differs between the broker master \(65\) and the reference file \(75\)/);
  });

  it("orders sent as quantity, fresh lot data and equity orders are never checked", async () => {
    const reference = staleRef({ block: true });
    const h = buildHarness({ reference });
    expect((await h.svc.preview(h.ctx(), inLots({ lots: undefined, quantity: 65 }))).checks.some((x) => x.code === "LOT_SIZE_STALE")).toBe(false);
    expect((await h.svc.preview(h.ctx(), liveOrder({ mode: "paper" }))).checks.some((x) => x.code === "LOT_SIZE_STALE")).toBe(false);
    const fresh = buildHarness({ reference: staleRef({ block: true, stale: false }) });
    expect((await fresh.svc.preview(fresh.ctx(), inLots())).checks.some((x) => x.code === "LOT_SIZE_STALE")).toBe(false);
  });
});

describe("human confirmation tickets (AI assistants)", () => {
  const mcp = (h) => h.ctx("mcp", { source: "mcp" });

  it("preview opens a ticket; an admin on this computer confirms; the token places exactly that order once", async () => {
    const h = buildHarness();
    const body = liveOrder();
    const pv = await h.svc.preview(mcp(h), body);
    expect(pv).toMatchObject({ ok: true, requiresHumanConfirmation: true, ticketId: expect.stringMatching(/^tkt_/) });

    const pending = await h.svc.tickets(h.ctx("admin"));
    expect(pending).toEqual([expect.objectContaining({ ticketId: pv.ticketId, source: "mcp", client: "Claude", order: body, estimatedValue: 14000 })]);

    expect(await reject(h.svc.tickets(h.ctx("live")))).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(await reject(h.svc.confirmTicket(h.ctx("admin", { source: "mcp" }), pv.ticketId))).toMatchObject({ code: "SCOPE_REQUIRED" });
    // The Phase 1 automations (strategy guards, alert actions) are never a person, even on loopback with admin.
    for (const source of ["guard", "alert", "webhook"]) {
      expect(await reject(h.svc.confirmTicket(h.ctx("admin", { source }), pv.ticketId)), source).toMatchObject({ code: "SCOPE_REQUIRED" });
    }
    expect(await reject(h.svc.confirmTicket(h.ctx("admin", { principal: { kind: "guard", id: "g1" } }), pv.ticketId))).toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(await reject(h.svc.confirmTicket(h.ctx("admin", { loopback: false }), pv.ticketId))).toMatchObject({ code: "LOOPBACK_ONLY" });

    const { confirmToken, expiresAt } = await h.svc.confirmTicket(h.ctx("admin"), pv.ticketId);
    expect(expiresAt).toMatch(/\+05:30$/);
    expect(await h.svc.tickets(h.ctx("admin"))).toEqual([]);

    // A different order, or another client, cannot use the token.
    expect(await reject(h.svc.place(mcp(h), { ...body, quantity: 20, confirmToken }))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(await reject(h.svc.place(h.ctx("live", { source: "mcp" }), { ...body, confirmToken }))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(h.zerodha.placed).toHaveLength(0);

    const { order } = await h.svc.place(mcp(h), { ...body, confirmToken });
    expect(order).toMatchObject({ mode: "live", source: "mcp", status: "open" });
    expect(await reject(h.svc.place(mcp(h), { ...body, confirmToken }, { idempotencyKey: "second-try-01" }))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(h.zerodha.placed).toHaveLength(1);
    expect(h.audit.types()).toEqual(expect.arrayContaining(["ticket.created", "ticket.confirmed", "order.placed"]));
  });

  it("two concurrent places with one token: only one is sent", async () => {
    const h = buildHarness();
    const body = liveOrder();
    const pv = await h.svc.preview(mcp(h), body);
    const { confirmToken } = await h.svc.confirmTicket(h.ctx("admin"), pv.ticketId);
    const results = await Promise.allSettled([
      h.svc.place(mcp(h), { ...body, confirmToken }, { idempotencyKey: "tok-race-0001" }),
      h.svc.place(mcp(h), { ...body, confirmToken }, { idempotencyKey: "tok-race-0002" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe("CONFIRMATION_REQUIRED");
    expect(h.zerodha.placed).toHaveLength(1);
  });

  it("tickets expire after about a minute", async () => {
    const h = buildHarness();
    const pv = await h.svc.preview(mcp(h), liveOrder());
    await h.clock.advance(61_000);
    expect(await reject(h.svc.confirmTicket(h.ctx("admin"), pv.ticketId))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("AI paper orders need a confirmation too, unless orders.confirmPaperFromMcp is false", async () => {
    const h = buildHarness();
    expect(await reject(h.svc.place(mcp(h), liveOrder({ mode: "paper" })))).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const relaxed = buildHarness({ orders: { confirmPaperFromMcp: false } });
    const { order } = await relaxed.svc.place(mcp(relaxed), liveOrder({ mode: "paper" }));
    expect(order.mode).toBe("paper");
  });

  it("does not open a ticket for an order that would be refused anyway", async () => {
    const h = buildHarness();
    const pv = await h.svc.preview(mcp(h), liveOrder({ account: "dhan-main" })); // mcp not allowed on dhan-main
    expect(pv).toMatchObject({ ok: false, ticketId: null });
    expect(await h.svc.tickets(h.ctx("admin"))).toEqual([]);
  });
});

describe("paper path", () => {
  it("places, modifies and cancels through the paper engine, with idempotency", async () => {
    const h = buildHarness();
    const placed = await h.svc.place(h.ctx("paper"), liveOrder({ mode: "paper", account: "paper", clientOrderId: "p-1" }), { idempotencyKey: "paper-key-001" });
    expect(placed.order).toMatchObject({ mode: "paper", accountId: "paper", clientOrderId: "p-1", source: "rest" });
    expect(h.paper.calls[0][2]).toMatchObject({ symbol: "NSE:RELIANCE", quantity: 10, resolved: "NSE:RELIANCE", mode: "paper", tag: expect.stringMatching(/^MCB/) });
    const again = await h.svc.place(h.ctx("paper"), liveOrder({ mode: "paper", account: "paper", clientOrderId: "p-1" }), { idempotencyKey: "paper-key-001" });
    expect(again).toMatchObject({ replayed: true, order: { orderId: placed.order.orderId } });
    expect(h.paper.calls.filter((c) => c[0] === "place")).toHaveLength(1);

    const mod = await h.svc.modify(h.ctx("paper"), placed.order.orderId, { price: 1401 });
    expect(mod.order.price).toBe(1401);
    const can = await h.svc.cancel(h.ctx("paper"), placed.order.orderId);
    expect(can.order.status).toBe("cancelled");
    expect(h.safety.events.map((e) => e[1].action)).toEqual(["place", "modify", "cancel"]);
    expect((await h.svc.getByClientId(h.ctx("read"), "p-1")).orderId).toBe(placed.order.orderId);
  });

  it("MARKET orders go to the paper engine as MARKET (it simulates the fill)", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx("paper"), liveOrder({ mode: "paper", orderType: "MARKET", price: undefined }));
    expect(h.paper.calls[0][2].orderType).toBe("MARKET");
  });

  it("finds paper orders it did not place itself (after a restart) by searching accessible accounts", async () => {
    const h = buildHarness();
    const o = await h.paper.place("paper", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, orderType: "LIMIT", product: "CNC", price: 1 });
    expect((await h.svc.get(h.ctx("read"), o.orderId)).orderId).toBe(o.orderId);
    expect(await reject(h.svc.get(h.ctx("read"), "PAPER-NOPE"))).toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});

describe("listings", () => {
  it("lists both modes newest first with cursor pagination, filtered by account access", async () => {
    const h = buildHarness();
    await h.svc.place(h.ctx(), liveOrder());
    await h.clock.advance(1000);
    await h.svc.place(h.ctx(), liveOrder({ mode: "paper" }));
    await h.clock.advance(1000);
    await h.svc.place(h.ctx(), liveOrder({ account: "dhan-main" }));
    const all = await h.svc.list(h.ctx("read"), { limit: 2 });
    expect(all.items.map((o) => `${o.accountId}/${o.mode}`)).toEqual(["dhan-main/live", "zerodha-main/paper"]);
    const next = await h.svc.list(h.ctx("read"), { limit: 2, cursor: all.nextCursor });
    expect(next.items.map((o) => `${o.accountId}/${o.mode}`)).toEqual(["zerodha-main/live"]);
    expect(next.nextCursor).toBeNull();
    expect((await h.svc.list(h.ctx("read"), { mode: "live" })).items).toHaveLength(2);
    expect((await h.svc.list(h.ctx("read"), { mode: "paper", accountId: "zerodha-main" })).items).toHaveLength(1);
    expect((await h.svc.list(h.ctx("dhanOnly"), {})).items.map((o) => o.accountId)).toEqual(["dhan-main"]);
    expect(await reject(h.svc.list(h.ctx("read"), { cursor: "garbage!" }))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await reject(h.svc.list(h.ctx("dhanOnly"), { accountId: "zerodha-main" }))).toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
  });

  it("refreshes live orders from the order book (fills show up)", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    h.zerodha.book = [bookRow({ orderId: "ZERODHA-1001", status: "COMPLETE", filledQty: 10, avgPrice: 1399.9 })];
    const page = await h.svc.list(h.ctx("read"), { mode: "live", status: "filled" });
    expect(page.items).toEqual([expect.objectContaining({ orderId: order.orderId, status: "filled", filledQuantity: 10, avgPrice: 1399.9, brokerStatus: "COMPLETE" })]);
  });

  it("trades: broker trade book mapped to canonical symbols and Bridge order ids, plus paper trades", async () => {
    const h = buildHarness();
    const { order } = await h.svc.place(h.ctx(), liveOrder());
    h.zerodha.trades = [
      { tradeId: "T1", orderId: "ZERODHA-1001", tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", side: "BUY", qty: 10, price: 1400, tradedAt: "2026-10-19T09:31:00+05:30" },
      { tradeId: "T2", orderId: "MANUAL-1", tradingSymbol: "WEIRD", exchange: "NSE", token: "999", side: "SELL", qty: 1, price: 5, tradedAt: "2026-10-19T09:30:00+05:30" },
    ];
    h.paper.seed("paper", { trades: [{ tradeId: "PT1", orderId: "PAPER-1", symbol: "NSE:INFY", side: "BUY", qty: 1, price: 1500, tradedAt: "2026-10-19T09:32:00+05:30" }] });
    const page = await h.svc.trades(h.ctx("read"), {});
    expect(page.items[0]).toMatchObject({ tradeId: "PT1", mode: "paper", accountId: "paper" });
    expect(page.items[1]).toMatchObject({ tradeId: "T1", orderId: order.orderId, brokerOrderId: "ZERODHA-1001", symbol: "NSE:RELIANCE", mode: "live", accountId: "zerodha-main" });
    expect(page.items[2]).toMatchObject({ tradeId: "T2", orderId: "MANUAL-1", symbol: "NSE:WEIRD", symbolResolved: false });
  });
});

describe("portfolio reads", () => {
  it("positions, holdings and funds come fresh from the broker every time, with canonical symbols and freshness", async () => {
    const h = buildHarness();
    h.zerodha.positions = [{ tradingSymbol: "NIFTY26OCTFUT", exchange: "NFO", token: "9001", product: "MARGIN", netQty: 65, avgPrice: 25000, ltp: 25060, pnl: 3900, realisedPnl: 0, unrealisedPnl: 3900 }];
    h.zerodha.holdings = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", isin: "INE002A01018", qty: 5, avgPrice: 1300, ltp: 1402.3, pnl: 511.5 }];
    const pos = await h.svc.positions(h.ctx("read"), "zerodha-main");
    expect(pos.items).toEqual([{ symbol: "NFO:NIFTY-2026-10-27-FUT", product: "MARGIN", netQty: 65, avgPrice: 25000, ltp: 25060, pnl: 3900, realisedPnl: 0, unrealisedPnl: 3900 }]);
    expect(pos.freshness).toMatchObject({ source: "broker", ageMs: 0, stale: false, accountId: "zerodha-main", broker: "zerodha", asOf: expect.stringMatching(/\+05:30$/) });
    await h.svc.positions(h.ctx("read"), "zerodha-main");
    expect(h.zerodha.reads.filter((r) => r === "positions")).toHaveLength(2); // never cached
    const hold = await h.svc.holdings(h.ctx("read"), "zerodha-main");
    expect(hold.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", isin: "INE002A01018", qty: 5 });
    const f = await h.svc.funds(h.ctx("read"), "zerodha-main");
    expect(f.funds).toMatchObject({ availableCash: 500000, usedMargin: 12000, totalBalance: 512000, withdrawable: 480000 });
    expect(h.scheduler.calls.filter((c) => c.endpointClass === "portfolio").every((c) => c.priority === "interactive")).toBe(true);
  });

  it("paper accounts read the paper book; live reads of a paper account are refused", async () => {
    const h = buildHarness();
    h.paper.seed("paper", { positions: [{ symbol: "NSE:INFY", product: "CNC", netQty: 1, avgPrice: 1500, pnl: 0 }] });
    expect((await h.svc.positions(h.ctx("read"), "paper")).freshness.source).toBe("paper");
    expect((await h.svc.positions(h.ctx("read"), "paper")).items).toHaveLength(1);
    expect((await h.svc.funds(h.ctx("read"), "zerodha-main", { mode: "paper" })).funds.availableCash).toBe(1_000_000);
    expect((await h.svc.holdings(h.ctx("read"), "paper")).items).toEqual([]);
    expect(await reject(h.svc.positions(h.ctx("read"), "paper", { mode: "live" }))).toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("maps session problems and unknown accounts to the right codes", async () => {
    const h = buildHarness();
    h.accounts.setState("zerodha-main", "expired");
    expect(await reject(h.svc.positions(h.ctx("read"), "zerodha-main"))).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(await reject(h.svc.funds(h.ctx("read"), "nope-account"))).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    expect(await reject(h.svc.holdings(h.ctx("dhanOnly"), "zerodha-main"))).toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
  });
});
