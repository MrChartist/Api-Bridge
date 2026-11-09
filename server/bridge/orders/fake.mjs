/**
 * In-memory OrderService for OTHER modules' tests (integrations, webhooks and MCP). It satisfies
 * SERVICE_CONTRACTS.orders exactly, needs no other service, makes no broker call and touches no disk. It keeps the
 * behaviour those modules depend on, using the orders module's real building blocks:
 *  - the real OrderRequest/OrderChanges zod schemas (VALIDATION_FAILED with field errors);
 *  - the real idempotency store (Idempotency-Key or clientOrderId; replay, 409 IDEMPOTENCY_KEY_REUSED /
 *    IDEMPOTENCY_IN_PROGRESS / DUPLICATE_CLIENT_ORDER_ID);
 *  - the real ticket book: orders from source "mcp" (or a ctx with confirmationRequired) need a ticket confirmed
 *    through confirmTicket() and the resulting confirmToken, bound to the exact body; preview() opens the ticket;
 *  - paper by default; mode "live" only for accounts listed in `liveAccounts` and keys with the "live" scope,
 *    otherwise PAPER_ONLY / SCOPE_REQUIRED (never a silent downgrade);
 *  - ctx.requireAccountAccess() on every account.
 *
 *   import { createFakeOrderService } from "../orders/fake.mjs";
 *   const orders = createFakeOrderService({ accounts: ["dhan-main", "paper"], liveAccounts: ["dhan-main"], lotSizes: { "NFO:NIFTY-2026-10-27-25000-CE": 65 } });
 *   await orders.place(ctx, { account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400 });
 *   orders.calls        // [["place", body, { idempotencyKey }], ...]
 *   orders.failNext(new BridgeError("KILL_SWITCH_ACTIVE"))   // the next place() throws it
 *   orders.fill(orderId, 1401)                               // mark an order filled (emits order.updated when given a bus)
 *
 * Orders are accepted as "open" at once; nothing fills unless the test calls fill().
 */
import { randomBytes } from "node:crypto";
import { assertService } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { isAutomatedContext } from "../core/context.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { createBatchOrders } from "./batchOrders.mjs";
import { createIdempotencyStore } from "./idempotencyStore.mjs";
import { IDEMPOTENCY_KEY_RE, TERMINAL_STATUSES, fingerprint, orderBody, parseOrderChanges, parseOrderRequest } from "./orderValidation.mjs";
import { createTargetOrders } from "./targetOrders.mjs";
import { createTicketBook } from "./tickets.mjs";
import { istDay, istIso } from "./time.mjs";

/**
 * @param {{ accounts?: string[], liveAccounts?: string[], lotSizes?: Record<string, number>, prices?: Record<string, number>,
 *   clock?: { now(): number }, bus?: { emit: Function }, ticketTtlMs?: number }} [opts]
 */
export function createFakeOrderService({ accounts = ["paper"], liveAccounts = [], lotSizes = {}, prices = {}, clock = { now: () => Date.now() }, bus, ticketTtlMs = 60_000 } = {}) {
  const now = () => clock.now();
  const idem = createIdempotencyStore({ now });
  const tickets = createTicketBook({ now, ticketTtlMs, confirmTokenTtlMs: 60_000 });
  /** @type {Map<string, any>} */
  const orders = new Map();
  const calls = [];
  let nextFailure = null;
  let seq = 0;

  const principal = (ctx) => `${ctx.principal?.kind ?? "anonymous"}:${ctx.principal?.id ?? "anonymous"}`;
  const needsHuman = (ctx) => ctx.source === "mcp" || ctx.confirmationRequired === true;
  const known = (id) => {
    if (!accounts.includes(id)) throw new BridgeError("ACCOUNT_NOT_FOUND", `No account with id ${id}.`);
  };
  const canAccess = (ctx, id) => {
    try {
      ctx.requireAccountAccess(id);
      return true;
    } catch {
      return false;
    }
  };
  const emit = (o) => bus?.emit("order.updated", { orderId: o.orderId, accountId: o.accountId, mode: o.mode, status: o.status, filledQuantity: o.filledQuantity, avgPrice: o.avgPrice ?? undefined, source: o.source });
  const freshness = (accountId) => ({ source: "paper", asOf: istIso(now()), ageMs: 0, stale: false, accountId, broker: "paper" });
  const canonical = (s) => {
    try {
      return parseSymbol(s).canonical;
    } catch {
      throw new BridgeError("SYMBOL_NOT_FOUND", `${s} could not be resolved.`);
    }
  };

  function decide(ctx, req) {
    const mode = req.mode === "live" ? "live" : "paper";
    if (mode === "live") {
      if (!liveAccounts.includes(req.account)) throw new BridgeError("PAPER_ONLY", `Live trading is not enabled for ${req.account}.`);
      if (!ctx.scopes?.has("live")) throw new BridgeError("SCOPE_REQUIRED", 'This API key does not have the "live" scope.');
    }
    return mode;
  }

  function sized(req) {
    const symbol = canonical(req.symbol);
    const lot = lotSizes[symbol] ?? 1;
    const quantity = req.lots !== undefined ? req.lots * lot : req.quantity;
    if (quantity % lot !== 0) throw new BridgeError("INVALID_ORDER", `quantity ${quantity} is not a multiple of the lot size ${lot}.`);
    return { symbol, lot, quantity };
  }

  function mustOrder(ctx, orderId) {
    const o = orders.get(String(orderId));
    if (!o || !canAccess(ctx, o.accountId)) throw new BridgeError("ORDER_NOT_FOUND", "No order with this id.");
    return o;
  }

  const page = (items, limit = 100, cursor) => {
    const off = cursor ? Number(cursor) || 0 : 0;
    return { items: items.slice(off, off + limit), nextCursor: off + limit < items.length ? String(off + limit) : null };
  };

  const svc = {
    async preview(ctx, raw) {
      calls.push(["preview", structuredClone(raw)]);
      const req = parseOrderRequest(raw);
      ctx.requireAccountAccess(req.account);
      known(req.account);
      const body = orderBody(req);
      const checks = [];
      let mode = req.mode === "live" ? "live" : "paper";
      try {
        mode = decide(ctx, req);
      } catch (e) {
        checks.push({ code: e.code, message: e.detail, severity: "block" });
      }
      let s = null;
      try {
        s = sized(req);
      } catch (e) {
        checks.push({ code: e.code, message: e.detail, severity: "block" });
      }
      const ltp = s ? prices[s.symbol] ?? null : null;
      const unit = req.price ?? req.triggerPrice ?? ltp;
      const estimatedValue = s && Number.isFinite(unit) ? unit * s.quantity : null;
      const confirmed = req.confirmToken ? tickets.verify(req.confirmToken, { fingerprint: fingerprint(body), accountId: req.account, principalId: principal(ctx) }).ok : false;
      const requiresHumanConfirmation = needsHuman(ctx) && !confirmed;
      let ticketId = null;
      if (requiresHumanConfirmation && checks.length === 0) {
        ticketId = tickets.open({ order: body, accountId: req.account, fingerprint: fingerprint(body), source: ctx.source === "mcp" || ctx.source === "webhook" ? ctx.source : "rest", client: ctx.key?.label ?? "unknown", principalId: principal(ctx), checks, estimatedValue }).ticketId;
      }
      return { ok: checks.length === 0, mode, checks, resolved: null, quantity: s?.quantity ?? null, estimatedValue, ltp, confirmToken: null, confirmExpiresAt: null, requiresHumanConfirmation, ticketId };
    },

    async place(ctx, raw, opts = {}) {
      calls.push(["place", structuredClone(raw), { ...opts }]);
      const req = parseOrderRequest(raw);
      ctx.requireAccountAccess(req.account);
      known(req.account);
      if (opts.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(opts.idempotencyKey)) throw new BridgeError("VALIDATION_FAILED", "Idempotency-Key is not valid.");
      const body = orderBody(req);
      const fp = fingerprint({ action: "place", body });
      const viaCid = opts.idempotencyKey === undefined && req.clientOrderId !== undefined;
      const key = opts.idempotencyKey !== undefined ? `key:${principal(ctx)}:${opts.idempotencyKey}` : viaCid ? `coid:${req.account}:${istDay(now())}:${req.clientOrderId}` : null;
      if (key) {
        const b = idem.begin(key, fp, viaCid ? { reuseCode: "DUPLICATE_CLIENT_ORDER_ID" } : {});
        if (b.replay) return { order: structuredClone(orders.get(b.record.orderId)), replayed: true };
      }
      let cid = null;
      try {
        if (req.clientOrderId !== undefined) cid = idem.reserveClientId(req.account, req.clientOrderId, fp);
        if (nextFailure) {
          const e = nextFailure;
          nextFailure = null;
          throw e;
        }
        const mode = decide(ctx, req);
        const s = sized(req);
        if (needsHuman(ctx)) {
          const token = opts.confirmToken ?? req.confirmToken;
          if (!token || !tickets.consume(token, { fingerprint: fingerprint(body), accountId: req.account, principalId: principal(ctx) })) {
            throw new BridgeError("CONFIRMATION_REQUIRED", "This order needs a human confirmation first.");
          }
        }
        seq += 1;
        const t = istIso(now());
        const o = {
          orderId: mode === "paper" ? `PAPER-FAKE-${String(seq).padStart(4, "0")}` : `ord_${randomBytes(12).toString("hex")}`,
          clientOrderId: req.clientOrderId ?? null,
          accountId: req.account,
          broker: mode === "paper" ? "paper" : "fake",
          mode,
          symbol: s.symbol,
          side: req.side,
          quantity: s.quantity,
          filledQuantity: 0,
          avgPrice: null,
          price: req.price ?? null,
          triggerPrice: req.triggerPrice ?? null,
          orderType: req.orderType,
          product: req.product,
          validity: req.validity ?? "DAY",
          status: "open",
          brokerStatus: mode === "live" ? "OPEN" : null,
          statusMessage: null,
          legs: [{ brokerOrderId: mode === "live" ? `FAKE-${seq}` : null, quantity: s.quantity, status: "open", error: null }],
          source: ctx.source,
          tag: req.tag ?? null,
          placedAt: t,
          updatedAt: t,
        };
        orders.set(o.orderId, o);
        if (key) idem.complete(key, { orderId: o.orderId, accountId: o.accountId, mode });
        if (cid) idem.linkClientId(cid.accountId, cid.clientOrderId, cid.day, { orderId: o.orderId, mode });
        emit(o);
        return { order: structuredClone(o), replayed: false };
      } catch (err) {
        if (key) idem.release(key);
        if (cid) idem.releaseClientId(cid.accountId, cid.clientOrderId, cid.day);
        throw err;
      }
    },

    async modify(ctx, orderId, raw, opts = {}) {
      calls.push(["modify", orderId, structuredClone(raw), { ...opts }]);
      const changes = parseOrderChanges(raw);
      const o = mustOrder(ctx, orderId);
      if (TERMINAL_STATUSES.has(o.status)) throw new BridgeError("INVALID_ORDER", `Order ${orderId} is ${o.status} and cannot be changed.`);
      if (o.mode === "live" && needsHuman(ctx)) throw new BridgeError("CONFIRMATION_REQUIRED", "AI assistants cannot change live orders.");
      Object.assign(o, changes, { updatedAt: istIso(now()) });
      if (changes.quantity !== undefined) o.legs[0].quantity = changes.quantity;
      emit(o);
      return { order: structuredClone(o), replayed: false };
    },

    async cancel(ctx, orderId, opts = {}) {
      calls.push(["cancel", orderId, { ...opts }]);
      const o = mustOrder(ctx, orderId);
      if (TERMINAL_STATUSES.has(o.status)) throw new BridgeError("INVALID_ORDER", `Order ${orderId} is ${o.status} and cannot be cancelled.`);
      o.status = "cancelled";
      o.legs[0].status = "cancelled";
      o.updatedAt = istIso(now());
      emit(o);
      return { order: structuredClone(o), replayed: false };
    },

    async cancelAll(ctx, { accountId, mode, dryRun = false } = {}) {
      calls.push(["cancelAll", { accountId, mode }]);
      if (accountId) ctx.requireAccountAccess(accountId);
      const cancelled = [];
      const open = [];
      for (const o of orders.values()) {
        if ((accountId && o.accountId !== accountId) || (mode && o.mode !== mode) || !canAccess(ctx, o.accountId) || TERMINAL_STATUSES.has(o.status)) continue;
        if (dryRun) {
          open.push({ orderId: o.orderId, accountId: o.accountId, mode: o.mode, symbol: o.symbol, side: o.side, quantity: o.quantity, status: o.status, external: false });
          continue;
        }
        o.status = "cancelled";
        o.legs[0].status = "cancelled";
        cancelled.push(o.orderId);
        emit(o);
      }
      // Every order here was placed through the Bridge; there are none placed outside it.
      if (dryRun) return { dryRun: true, cancelled, failed: [], bridge: { cancelled: [], open }, external: { cancelled: [], left: [], open: [] } };
      return { cancelled, failed: [], bridge: { cancelled: [...cancelled] }, external: { cancelled: [], left: [] } };
    },

    async get(ctx, orderId) {
      return structuredClone(mustOrder(ctx, orderId));
    },

    async getByClientId(ctx, clientOrderId) {
      const rec = idem.findClientId(String(clientOrderId), (a) => canAccess(ctx, a));
      if (!rec) throw new BridgeError("ORDER_NOT_FOUND", `No order with clientOrderId ${clientOrderId}.`);
      return structuredClone(orders.get(rec.orderId));
    },

    async list(ctx, { accountId, status, mode, limit, cursor } = {}) {
      if (accountId) ctx.requireAccountAccess(accountId);
      const items = [...orders.values()]
        .filter((o) => (!accountId || o.accountId === accountId) && (!status || o.status === status) && (!mode || o.mode === mode) && canAccess(ctx, o.accountId))
        .reverse()
        .map((o) => structuredClone(o));
      return page(items, limit, cursor);
    },

    async trades(ctx, { accountId, mode, limit, cursor } = {}) {
      if (accountId) ctx.requireAccountAccess(accountId);
      const items = [...orders.values()]
        .filter((o) => o.status === "filled" && (!accountId || o.accountId === accountId) && (!mode || o.mode === mode) && canAccess(ctx, o.accountId))
        .map((o) => ({ tradeId: `T-${o.orderId}`, orderId: o.orderId, accountId: o.accountId, mode: o.mode, symbol: o.symbol, side: o.side, qty: o.quantity, price: o.avgPrice, tradedAt: o.updatedAt }));
      return page(items, limit, cursor);
    },

    async positions(ctx, accountId) {
      ctx.requireAccountAccess(accountId);
      known(accountId);
      const net = new Map();
      for (const o of orders.values()) {
        if (o.accountId !== accountId || o.status !== "filled") continue;
        const k = `${o.symbol}|${o.product}`;
        const p = net.get(k) ?? { symbol: o.symbol, product: o.product, netQty: 0, avgPrice: o.avgPrice, ltp: prices[o.symbol] ?? null, pnl: 0, realisedPnl: null, unrealisedPnl: null };
        p.netQty += o.side === "BUY" ? o.quantity : -o.quantity;
        net.set(k, p);
      }
      return { items: [...net.values()], freshness: freshness(accountId) };
    },

    async holdings(ctx, accountId) {
      ctx.requireAccountAccess(accountId);
      known(accountId);
      return { items: [], freshness: freshness(accountId) };
    },

    async funds(ctx, accountId) {
      ctx.requireAccountAccess(accountId);
      known(accountId);
      return { funds: { availableCash: 1_000_000, usedMargin: 0, totalBalance: 1_000_000, collateral: null, withdrawable: null, realisedPnl: 0, unrealisedPnl: 0 }, freshness: freshness(accountId) };
    },

    async tickets(ctx, { state = "open" } = {}) {
      if (ctx.principal?.kind !== "local" && !ctx.scopes?.has("admin")) throw new BridgeError("SCOPE_REQUIRED", 'This needs an API key with the "admin" scope.');
      return state === "rejected" ? tickets.listRejected() : tickets.list();
    },

    async rejectTicket(ctx, ticketId, { reason } = {}) {
      if (ctx.principal?.kind !== "local" && !ctx.scopes?.has("admin")) throw new BridgeError("SCOPE_REQUIRED", 'This needs an API key with the "admin" scope.');
      if (isAutomatedContext(ctx)) throw new BridgeError("SCOPE_REQUIRED", "Only a person using the Bridge on this computer can decline an order.");
      return tickets.reject(String(ticketId), principal(ctx), reason).ticket;
    },

    async ticketStatus(ctx, ticketId) {
      const st = tickets.statusOf(ticketId);
      if (!st || (st.principalId !== principal(ctx) && !ctx.scopes?.has("admin"))) return { ticketId: String(ticketId), status: "unknown", reason: null, expiresAt: null };
      return { ticketId: st.ticketId, status: st.status, reason: st.reason, expiresAt: st.expiresAt };
    },

    async confirmTicket(ctx, ticketId) {
      if (ctx.principal?.kind !== "local" && !ctx.scopes?.has("admin")) throw new BridgeError("SCOPE_REQUIRED", 'This needs an API key with the "admin" scope.');
      if (isAutomatedContext(ctx)) throw new BridgeError("SCOPE_REQUIRED", "Only a person using the Bridge on this computer can confirm an order.");
      const r = tickets.confirm(String(ticketId), principal(ctx));
      return { confirmToken: r.confirmToken, expiresAt: r.expiresAt };
    },

    // ── test helpers (not part of the contract) ──
    calls,
    /** Make the next place() throw this error (after validation and idempotency). */
    failNext(err) {
      nextFailure = err;
    },
    /** Mark an order filled at `price`. */
    fill(orderId, price) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`fake orders: no order ${orderId}`);
      Object.assign(o, { status: "filled", filledQuantity: o.quantity, avgPrice: price, updatedAt: istIso(now()) });
      o.legs[0].status = "filled";
      emit(o);
    },
    /** Every order, newest last. */
    all: () => [...orders.values()].map((o) => structuredClone(o)),
  };
  // placeToTarget and placeBatch: the real implementations over this fake (extras.mjs does the same over the real service).
  const extraDeps = {
    accounts: { get: (id) => (known(id), { id, broker: liveAccounts.includes(id) ? "fake" : "paper" }) },
    symbols: {
      async resolve(symbol) {
        const p = parseSymbol(symbol);
        return { canonical: p.canonical, underlying: p.underlying, kind: p.kind, lotSize: lotSizes[p.canonical] ?? 1 };
      },
    },
  };
  svc.placeToTarget = createTargetOrders({ deps: extraDeps, svc, now }).toTarget;
  svc.placeBatch = createBatchOrders({ deps: extraDeps, svc, now }).batch;
  assertService("orders", svc);
  return svc;
}
