/**
 * Test fixtures for stream S7: stub SafetyGuard, AuditLog and PaperEngine (S8/S9 publish their own fakes later),
 * a stub broker adapter whose order methods are wrapped with the REAL withOrderGate (so a missing, reused or stale
 * gate fails exactly as in production), and a builder that wires an OrderService over the published fakes of other
 * streams (accounts, scheduler, symbols, market data). No network, no broker.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAccountManager } from "../../accounts/fake.mjs";
import { withOrderGate } from "../../../brokers/contract.mjs";
import { createCallContext } from "../../core/context.mjs";
import { loadConfig } from "../../core/config.mjs";
import { BridgeError } from "../../core/errors.mjs";
import { createEventBus } from "../../core/eventBus.mjs";
import { createLogger } from "../../core/logger.mjs";
import { createFakeMarketData } from "../../market/fake.mjs";
import { createFakeScheduler, createManualClock } from "../../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../../symbols/fake.mjs";
import { createOrderService } from "../orderService.mjs";

export const INSTRUMENTS = Object.freeze([
  { symbol: "NSE:NIFTY", lotSize: 1, tickSize: 0.05, refs: { zerodha: { token: "256265", tradingSymbol: "NIFTY 50" }, dhan: { token: "13" } } },
  { symbol: "NSE:RELIANCE", lotSize: 1, tickSize: 0.1, isin: "INE002A01018", refs: { zerodha: { token: "738561", tradingSymbol: "RELIANCE" }, dhan: { token: "2885" }, upstox: { token: "NSE_EQ|INE002A01018", tradingSymbol: "RELIANCE" }, angelone: { token: "2885", tradingSymbol: "RELIANCE-EQ" } } },
  { symbol: "NFO:NIFTY-2026-10-27-FUT", lotSize: 65, tickSize: 0.1, refs: { zerodha: { token: "9001", tradingSymbol: "NIFTY26OCTFUT" }, dhan: { token: "35001" } } },
  { symbol: "NFO:NIFTY-2026-10-27-25000-CE", lotSize: 65, tickSize: 0.05, freezeQty: 1800, refs: { zerodha: { token: "1001", tradingSymbol: "NIFTY26O2725000CE" }, dhan: { token: "51440" } } },
  { symbol: "MCX:CRUDEOIL-2026-11-19-FUT", lotSize: 100, tickSize: 1, refs: { zerodha: { token: "7001", tradingSymbol: "CRUDEOIL26NOVFUT" }, upstox: { token: "MCX_FO|4321" } } },
]);

export const PRICES = Object.freeze({ "NSE:NIFTY": 25010, "NSE:RELIANCE": 1402.3, "NFO:NIFTY-2026-10-27-FUT": 25060, "NFO:NIFTY-2026-10-27-25000-CE": 120.5, "MCX:CRUDEOIL-2026-11-19-FUT": 6150 });

/** A logger that keeps every line (for "no secret in logs" checks). */
export function createCapturingLogger() {
  const lines = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  return { logger, lines };
}

/** Stub SafetyGuard. `refuse` = reasons to return; `slots` = how many order slots are left (Infinity by default). */
export function createStubSafety({ refuse = [], warnings = [], slots = Infinity, retryAfterMs = 200 } = {}) {
  const s = {
    calls: [],
    events: [],
    refuse,
    warnings,
    slots,
    async check(ctx, intent) {
      s.calls.push(["check", structuredClone({ ...intent, order: intent.order ? { ...intent.order, resolved: undefined } : null })]);
      const reasons = typeof s.refuse === "function" ? s.refuse(intent) : s.refuse;
      return { ok: reasons.length === 0, mode: intent.mode, reasons, warnings: s.warnings };
    },
    acquireOrderSlot(accountId) {
      s.calls.push(["acquireOrderSlot", accountId]);
      if (s.slots <= 0) return { ok: false, retryAfterMs };
      s.slots -= 1;
      return { ok: true, retryAfterMs: 0 };
    },
    recordOrderEvent(accountId, event) {
      s.events.push([accountId, event]);
    },
    killSwitchStatus: () => ({ engaged: false, reason: null, by: null, at: null }),
    async engageKillSwitch() {
      return { engaged: true, reason: "test", by: "test", at: null };
    },
    async releaseKillSwitch() {
      return { engaged: false, reason: null, by: null, at: null };
    },
    limits: () => ({ limits: {}, usage: { ordersToday: 0, realisedPnlToday: 0, ordersLastSecond: 0 } }),
  };
  return s;
}

/** Stub AuditLog that keeps records in memory; set `.fail = true` to make append throw. */
export function createStubAudit() {
  const a = {
    records: [],
    fail: false,
    async append(input) {
      if (a.fail) throw new BridgeError("INTERNAL", "audit down");
      const rec = { ...structuredClone(input), seq: a.records.length + 1, at: new Date().toISOString(), prevHash: "", hash: "" };
      a.records.push(rec);
      return rec;
    },
    async query() {
      return { items: a.records, nextCursor: null };
    },
    async verify() {
      return { ok: true, checked: a.records.length, brokenAt: null };
    },
    types: () => a.records.map((r) => r.type),
  };
  return a;
}

/** A small in-memory PaperEngine with the contract methods (whole fills are not simulated; orders stay open). */
export function createStubPaper({ clock = { now: () => Date.now() } } = {}) {
  const books = new Map();
  let seq = 0;
  const book = (id) => {
    if (!books.has(id)) books.set(id, { orders: [], trades: [], positions: [] });
    return books.get(id);
  };
  const iso = () => new Date(clock.now()).toISOString();
  const p = {
    calls: [],
    async place(accountId, order) {
      p.calls.push(["place", accountId, { ...order, resolved: order.resolved?.canonical }]);
      seq += 1;
      const o = {
        orderId: `PAPER-20261019-${String(seq).padStart(4, "0")}`,
        clientOrderId: order.clientOrderId ?? null,
        accountId,
        broker: "paper",
        mode: "paper",
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        filledQuantity: 0,
        avgPrice: null,
        price: order.price ?? null,
        triggerPrice: order.triggerPrice ?? null,
        orderType: order.orderType,
        product: order.product,
        validity: order.validity ?? "DAY",
        status: "open",
        brokerStatus: null,
        statusMessage: null,
        legs: [{ brokerOrderId: null, quantity: order.quantity, status: "open", error: null }],
        source: order.source ?? "rest",
        tag: order.tag ?? null,
        placedAt: iso(),
        updatedAt: iso(),
      };
      book(accountId).orders.push(o);
      return structuredClone(o);
    },
    async modify(accountId, orderId, changes) {
      p.calls.push(["modify", accountId, orderId, changes]);
      const o = book(accountId).orders.find((x) => x.orderId === orderId);
      if (!o) throw new BridgeError("ORDER_NOT_FOUND");
      Object.assign(o, changes, { updatedAt: iso() });
      return structuredClone(o);
    },
    async cancel(accountId, orderId) {
      p.calls.push(["cancel", accountId, orderId]);
      const o = book(accountId).orders.find((x) => x.orderId === orderId);
      if (!o) throw new BridgeError("ORDER_NOT_FOUND");
      o.status = "cancelled";
      o.legs[0].status = "cancelled";
      return structuredClone(o);
    },
    async order(accountId, orderId) {
      const o = book(accountId).orders.find((x) => x.orderId === orderId);
      return o ? structuredClone(o) : null;
    },
    async orders(accountId, { status, limit = 100, cursor } = {}) {
      const all = book(accountId).orders.filter((o) => !status || o.status === status);
      const off = cursor ? Number(cursor) : 0;
      return { items: structuredClone(all.slice(off, off + limit)), nextCursor: off + limit < all.length ? String(off + limit) : null };
    },
    async trades(accountId) {
      return { items: structuredClone(book(accountId).trades), nextCursor: null };
    },
    async positions(accountId) {
      return structuredClone(book(accountId).positions);
    },
    async funds() {
      return { availableCash: 1_000_000, usedMargin: 0, totalBalance: 1_000_000, realisedPnl: 0, unrealisedPnl: 0 };
    },
    async account(accountId) {
      return { accountId, startingCapital: 1_000_000, createdAt: iso(), resetAt: null, ordersToday: book(accountId).orders.length };
    },
    async reset(accountId) {
      books.delete(accountId);
    },
    /** Test helper: add a paper trade/position. */
    seed(accountId, { trades = [], positions = [] }) {
      book(accountId).trades.push(...trades);
      book(accountId).positions.push(...positions);
    },
  };
  return p;
}

/**
 * Stub broker adapter. Order methods are wrapped with the real withOrderGate. Behaviour per call:
 *   adapter.next = "ack" (default) | "hang" (never answers until adapter.release()) | Error to throw | (order) => ack
 */
export function stubOrderAdapter(brokerId, { book = [], trades = [], positions = [], holdings = [], funds = null } = {}) {
  let n = 0;
  const pending = [];
  const a = {
    id: brokerId,
    capabilities: { orderBook: true, tradeBook: true, positions: true, holdings: true, funds: true, placeOrder: true, modifyOrder: true, cancelOrder: true },
    placed: [],
    modified: [],
    cancelled: [],
    reads: [],
    book,
    trades,
    positions,
    holdings,
    funds,
    next: "ack",
    ackStatus: "OPEN",
    /** Resolve every hanging call with its default ack (or the given value / error). */
    release(value) {
      for (const p of pending.splice(0)) value instanceof Error ? p.reject(value) : p.resolve(value ?? p.ack);
    },
    pendingCount: () => pending.length,
  };
  const behave = (ack) => {
    const b = a.next;
    if (b === "hang") return new Promise((resolve, reject) => pending.push({ resolve, reject, ack }));
    if (b instanceof Error) throw b;
    if (typeof b === "function") return b(ack);
    return ack;
  };
  a.placeOrder = withOrderGate(
    "placeOrder",
    async (creds, order, lotSize) => {
      a.placed.push({ creds: Object.keys(creds ?? {}), order: structuredClone(order), lotSize });
      n += 1;
      return behave({ orderId: `${brokerId.toUpperCase()}-${1000 + n}`, orderStatus: a.ackStatus });
    },
    { brokerId },
  );
  a.modifyOrder = withOrderGate(
    "modifyOrder",
    async (creds, orderId, changes) => {
      a.modified.push({ orderId, changes: structuredClone(changes) });
      return behave({ orderId, orderStatus: "OPEN" });
    },
    { brokerId },
  );
  a.cancelOrder = withOrderGate(
    "cancelOrder",
    async (creds, orderId) => {
      a.cancelled.push({ orderId });
      return behave({ orderId, orderStatus: "CANCELLED" });
    },
    { brokerId },
  );
  a.fetchOrderBook = async () => (a.reads.push("orderBook"), { status: "success", data: structuredClone(a.book) });
  a.fetchTradeBook = async () => (a.reads.push("tradeBook"), { status: "success", data: structuredClone(a.trades) });
  a.fetchPositions = async () => (a.reads.push("positions"), { status: "success", data: structuredClone(a.positions) });
  a.fetchHoldings = async () => (a.reads.push("holdings"), { status: "success", data: structuredClone(a.holdings) });
  a.fetchFunds = async () => (a.reads.push("funds"), { status: "success", data: a.funds ?? { availableCash: 500000, usedMargin: 12000, totalBalance: 512000, collateral: null, withdrawable: 480000 } });
  return a;
}

/** A contract order-book row for the stub adapter. */
export function bookRow(over = {}) {
  return {
    orderId: "Z-1",
    tradingSymbol: "RELIANCE",
    exchange: "NSE",
    token: "738561",
    side: "BUY",
    qty: 10,
    filledQty: 0,
    pendingQty: 10,
    price: 1400,
    triggerPrice: 0,
    avgPrice: 0,
    orderType: "LIMIT",
    product: "CNC",
    status: "OPEN",
    statusMessage: null,
    placedAt: null,
    ...over,
  };
}

export const KEYS = Object.freeze({
  live: { id: "livekey0001", label: "my script", scopes: ["live"], accounts: "*" },
  paper: { id: "paperkey001", label: "paper script", scopes: ["paper"], accounts: "*" },
  read: { id: "readkey0001", label: "sheet", scopes: ["read"], accounts: "*" },
  admin: { id: "adminkey001", label: "Option Hub", scopes: ["admin"], accounts: "*" },
  mcp: { id: "mcpkey00001", label: "Claude", scopes: ["live"], accounts: "*", clientKind: "mcp" },
  dhanOnly: { id: "dhanonly001", label: "dhan only", scopes: ["live"], accounts: ["dhan-main"] },
});

/**
 * Wire an OrderService for tests.
 * @param {{ raw?: object, orders?: object, safety?: object, dataDir?: string | null, logger?: object, prices?: object,
 *   accounts?: object[], adapters?: Record<string, object> }} [opts]
 */
export function buildHarness(opts = {}) {
  const clock = createManualClock();
  const { logger, lines } = opts.logger ? { logger: opts.logger, lines: [] } : createCapturingLogger();
  const bus = createEventBus({ logger });
  const zerodha = opts.adapters?.zerodha ?? stubOrderAdapter("zerodha");
  const dhan = opts.adapters?.dhan ?? stubOrderAdapter("dhan");
  const angelone = opts.adapters?.angelone ?? stubOrderAdapter("angelone");
  const dataDir = opts.dataDir === null ? null : opts.dataDir ?? mkdtempSync(join(tmpdir(), "mcb-orders-"));
  const raw = {
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), "mcb-orders-")),
    safety: { liveTrading: true },
    accounts: [
      { id: "zerodha-main", broker: "zerodha", live: { enabled: true, allowedSources: ["rest", "mcp", "webhook", "cli"] } },
      { id: "dhan-main", broker: "dhan", live: { enabled: true, allowedSources: ["rest"] } },
      { id: "angel-main", broker: "angelone", live: { enabled: true, allowedSources: ["rest"] } },
      { id: "zerodha-2", broker: "zerodha" },
      { id: "paper", broker: "paper" },
    ],
    ...(opts.raw ?? {}),
  };
  const { config: base } = loadConfig({ raw, env: {} });
  const config = opts.orders ? { ...base, orders: opts.orders } : base;
  const accounts = createFakeAccountManager({
    bus,
    accounts: opts.accounts ?? [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "kite-api-key", accessToken: "kite-access-token-secret" }, liveAllowedByConfig: true },
      { id: "dhan-main", broker: "dhan", adapter: dhan, creds: { clientId: "1000", accessToken: "dhan-access-token-secret" }, liveAllowedByConfig: true },
      { id: "angel-main", broker: "angelone", adapter: angelone, creds: { apiKey: "a" } },
      { id: "zerodha-2", broker: "zerodha", adapter: stubOrderAdapter("zerodha"), creds: { apiKey: "k2" } },
      { id: "paper", broker: "paper" },
    ],
  });
  const scheduler = createFakeScheduler({ bus, policies: { zerodha: { maxModificationsPerOrder: 2 } } });
  const symbols = createFakeSymbolService({ instruments: INSTRUMENTS });
  const marketData = createFakeMarketData({ prices: opts.prices ?? PRICES, clock });
  const safety = opts.safety ?? createStubSafety();
  const audit = createStubAudit();
  const paper = createStubPaper({ clock });
  const deps = { config, logger, bus, clock, paths: { root: process.cwd(), dataDir }, brokers: null, accounts, scheduler, symbols, safety, audit, paper, marketData };
  const rawSvc = createOrderService(deps);
  // Live orders need an Idempotency-Key or a clientOrderId. Most tests are about something else, so give each call a
  // fresh key unless the test sends its own (or a clientOrderId). Tests of the rule itself use rawSvc.
  let idemSeq = 0;
  const svc = {
    ...rawSvc,
    place(ctx, body, opts = {}) {
      const needs = opts.idempotencyKey === undefined && body?.clientOrderId === undefined && body?.mode === "live";
      return rawSvc.place(ctx, body, needs ? { ...opts, idempotencyKey: `test-auto-${(idemSeq += 1)}` } : opts);
    },
  };
  const ctx = (keyName = "live", { source = "rest", loopback = true, ...extra } = {}) => {
    const c = createCallContext({ source, key: KEYS[keyName] ?? null, log: logger });
    c.loopback = loopback;
    return Object.assign(c, extra);
  };
  return { svc, rawSvc, deps, clock, bus, zerodha, dhan, angelone, accounts, scheduler, symbols, marketData, safety, audit, paper, logger, lines, ctx, config, dataDir };
}

/** A minimal valid live order on zerodha-main. */
export const liveOrder = (over = {}) => ({ account: "zerodha-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "LIMIT", price: 1400, mode: "live", ...over });
