/**
 * PaperEngine — stream S8 (docs/STREAMS.md §S8). The contract (methods, argument and return types, rules) is
 * SERVICE_CONTRACTS.paper in ../core/contracts.mjs; app.mjs refuses to boot an implementation that misses a method.
 *
 * A local order simulator, one book per account:
 *  - Prices come from deps.marketData (LTP, depth) and from `tick` events on deps.bus, never from a broker order
 *    endpoint. The fill rules are in fillModel.mjs (docs/ARCHITECTURE.md §7).
 *  - Order states: open, trigger_pending, filled, cancelled, rejected, expired. Fills are whole (v1).
 *  - Positions per (symbol, product) with average price and realised/unrealised P&L; funds with approximate margin
 *    blocking: F&O legs are margined together per underlying (dashboard/span-margin.js, an approximate SPAN-like scan
 *    plus exposure, so hedges get their benefit), equity by percentage; INTRADAY positions and orders are squared off at the configured IST time (15:20 for NSE/BSE).
 *  - State per account in <dataDir>/paper/<accountId>.json, written atomically after every change (paperStore.mjs),
 *    and restored on start, including pending orders, which keep being evaluated.
 *  - Order ids: PAPER-<yyyymmdd>-<seq> (IST day, one sequence for all accounts, persisted). Trade ids: <orderId>-T1.
 *  - Every state change is published on deps.bus as `order.updated` with mode "paper". Fill events also carry
 *    `realisedPnl` (the P&L that fill realised) so daily-loss tracking can use it.
 *
 * Input checks here are defensive: OrderService (S7) runs the full pre-trade validation and SafetyGuard (S9) first.
 * Structural problems throw (INVALID_ORDER / VALIDATION_FAILED, and no order is created); business refusals such as
 * insufficient paper funds create an order in status "rejected" with a statusMessage, as a broker would.
 *
 * Not modelled in v1 (documented): partial fills, queue position, market impact, option expiry settlement,
 * corporate actions, statutory charges (only the simple brokerage model in config).
 *
 * Extra methods beyond the contract (internal; other streams must not call them): start(), stop(), runOnce(),
 * handleTick(tick).
 */
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { CAPITAL_MAX, CAPITAL_MIN, DEMO_STARTING_CAPITAL, EXCHANGE_SESSION_END, EXCHANGE_SQUARE_OFF, PAPER_DEFAULTS, paperConfig } from "./config.mjs";
import { DEFAULT_SESSIONS, defaultSessionFor } from "../reference/defaults.mjs";
import { isStub } from "../core/contracts.mjs";
import { applyFill, brokerageFor, evaluate, isTickMultiple, marginFor, marketFillPrice, round2, round4, stopTriggered } from "./fillModel.mjs";
import { ACCOUNT_ID_RE, STATE_VERSION, createFileStore } from "./paperStore.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { SPAN_METHOD, SPAN_PARAMS, marginRequired, portfolioMargin, standaloneMargin } from "../dashboard/span-margin.js";
import { istDay, istDayCompact, istTimeOnDay, toIstIso } from "./time.mjs";

export const PENDING = Object.freeze(["open", "trigger_pending"]);
export const ORDER_STATUSES = Object.freeze(["pending", "open", "trigger_pending", "partially_filled", "filled", "cancelled", "rejected", "expired", "outcome_unknown"]);
const SIDES = new Set(["BUY", "SELL"]);
const PRODUCTS = new Set(["CNC", "INTRADAY", "MARGIN", "MTF"]);
const ORDER_TYPES = new Set(["LIMIT", "MARKET", "SL", "SL-M"]);
const VALIDITIES = new Set(["DAY", "IOC"]);
const SOURCES = new Set(["rest", "webhook", "mcp", "cli", "system", "guard", "alert"]);
const DELIVERY = new Set(["CNC", "MTF"]);
const MODIFIABLE = Object.freeze(["price", "triggerPrice", "quantity", "orderType"]);
export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 500;
/** A reset can be undone for this long (ms). */
export const UNDO_RESET_MS = 120_000;
/** Daily P&L snapshots kept per paper account (about three years of trading days). */
export const DAILY_KEPT = 800;
/** Prices fetched for a new order must be at most this old (ms). */
const FRESH_MS = 1000;

const isPending = (o) => PENDING.includes(o.status);
const isStop = (type) => type === "SL" || type === "SL-M";
const posKey = (symbol, product) => `${symbol}|${product}`;
const positiveNumber = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const rupees = (n) => `₹${round2(Math.max(0, n)).toLocaleString("en-IN")}`;
const invalid = (detail, path) => new BridgeError("INVALID_ORDER", detail, path ? { errors: [{ path, message: detail }] } : {});
const badInput = (detail, path) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

const encodeCursor = (n) => Buffer.from(`o:${n}`, "utf8").toString("base64url");
function decodeCursor(c) {
  if (c === undefined || c === null || c === "") return 0;
  const m = /^o:(\d{1,9})$/.exec(Buffer.from(String(c), "base64url").toString("utf8"));
  if (!m) throw badInput("cursor is not valid. Use nextCursor from the previous page.", "cursor");
  return Number(m[1]);
}

/**
 * Newest-first page over `list` (stored oldest first). Cursors are opaque offsets.
 * @param {any[]} list
 * @param {{ limit?: number, cursor?: string }} [opts]
 * @returns {{ items: any[], nextCursor: string | null }}
 */
export function paginate(list, { limit, cursor } = {}) {
  const n = limit === undefined ? PAGE_DEFAULT : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > PAGE_MAX) throw badInput(`limit must be a whole number from 1 to ${PAGE_MAX}.`, "limit");
  const start = decodeCursor(cursor);
  const newestFirst = list.slice().reverse();
  const items = newestFirst.slice(start, start + n);
  return { items, nextCursor: start + n < newestFirst.length ? encodeCursor(start + n) : null };
}

/** Text for a stop order whose trigger is already crossed. */
const stopCrossedText = (side, ltp) =>
  side === "BUY"
    ? `The trigger price for a stop-loss buy must be above the last traded price (${ltp}).`
    : `The trigger price for a stop-loss sell must be below the last traded price (${ltp}).`;

/**
 * @param {object} deps  Core deps (config, logger, bus, clock, paths) plus marketData and symbols.
 * @param {{ store?: import("./paperStore.mjs").PaperStore, timers?: { setInterval: Function, clearInterval: Function },
 *   accountKnown?: (accountId: string) => boolean, paper?: object }} [options]
 *   store: persistence (default: files under <dataDir>/paper). timers: injectable for fake-clock tests.
 *   accountKnown: which account ids exist (default: config.accounts). paper: config section override.
 * @returns {object} PaperEngine
 */
export function createPaperEngine(deps, options = {}) {
  const { config, logger, bus, clock } = deps;
  const base = options.paper ?? config?.paper ?? paperConfig();
  // Demo: a healthy float unless the config chose its own starting capital.
  const cfg = config?.demo && base.startingCapital === PAPER_DEFAULTS.startingCapital ? { ...base, startingCapital: DEMO_STARTING_CAPITAL } : base;
  const log = typeof logger?.child === "function" ? logger.child({ module: "paper" }) : logger;
  const now = () => clock.now();
  const store = options.store ?? createFileStore(join(deps.paths.dataDir, "paper"), { now });
  const timers = options.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h) };
  const accountKnown = options.accountKnown ?? ((id) => (config?.accounts ?? []).some((a) => a.id === id));
  const squareOffTimes = { ...EXCHANGE_SQUARE_OFF, ...(cfg.squareOff.times ?? {}) };
  const sessionEndTimes = { ...EXCHANGE_SESSION_END, ...(cfg.sessionEnd.times ?? {}) };
  const squareOffLabel = (exchange) => squareOffTimes[exchange] ?? cfg.squareOff.time;
  const squareOffAt = (exchange, t) => istTimeOnDay(t, squareOffLabel(exchange));
  /** Optional (stream S16): the reference session close; absent in tests that build the engine by hand. */
  const reference = (() => {
    try {
      const r = deps.reference;
      return r && !isStub(r) && typeof r.session === "function" ? r : null;
    } catch {
      return null;
    }
  })();
  /** Session close for an exchange on the IST day of t: config, else the reference session, else the S5 default. */
  const referenceClose = (exchange, t) => {
    try {
      const close = reference?.session(exchange, t)?.close;
      if (typeof close === "string" && /^\d{2}:\d{2}$/.test(close)) return close;
    } catch {
      // fall back to the default below
    }
    return (defaultSessionFor(exchange) ?? DEFAULT_SESSIONS.NSE).close;
  };
  const sessionEndAt = (exchange, t) => istTimeOnDay(t, sessionEndTimes[exchange] ?? cfg.sessionEnd.time ?? referenceClose(exchange, t));

  /** accountId -> state */
  const books = new Map();
  /** accountId -> { state, at }: the book before its last reset, for undoReset. */
  const undo = new Map();
  /** canonical symbol -> { ltp, bid, ask, at }, only for symbols some book cares about */
  const lastPrice = new Map();
  /** symbols with a pending order or an open position in a loaded book */
  let interest = new Set();
  let ids = store.loadIds() ?? { day: "", seq: 0 };
  let interval = null;
  let offTick = null;
  let running = false;

  // ───────────────────────────── state ─────────────────────────────

  function freshState(accountId, startingCapital, createdAt, resetAt = null) {
    return {
      v: STATE_VERSION,
      accountId,
      startingCapital,
      createdAt,
      resetAt,
      day: istDay(now()),
      ordersToday: 0,
      realisedTotal: 0,
      charges: 0,
      orders: [],
      trades: [],
      positions: {},
      marks: {},
    };
  }

  function warn(message, fields) {
    log?.warn?.(message, fields);
    bus?.emit("config.warning", { message });
  }

  function recomputeInterest() {
    const next = new Set();
    for (const st of books.values()) {
      for (const o of st.orders) if (isPending(o)) next.add(o.symbol);
      for (const p of Object.values(st.positions)) if (p.netQty !== 0) next.add(p.symbol);
    }
    for (const s of [...lastPrice.keys()]) if (!next.has(s)) lastPrice.delete(s);
    interest = next;
  }

  function save(st) {
    // Keep the last known price of every open position so unrealised P&L survives a restart.
    st.marks = {};
    for (const p of Object.values(st.positions)) {
      const lp = lastPrice.get(p.symbol);
      if (p.netQty !== 0 && lp) st.marks[p.symbol] = { ltp: lp.ltp, at: lp.at };
    }
    try {
      store.save(st.accountId, st);
    } catch (err) {
      log?.error?.("paper state could not be saved", { accountId: st.accountId, err });
    }
    recomputeInterest();
  }

  function checkAccountId(accountId) {
    if (typeof accountId !== "string" || !ACCOUNT_ID_RE.test(accountId)) throw new BridgeError("ACCOUNT_NOT_FOUND", "No account with this id.");
    if (!accountKnown(accountId)) throw new BridgeError("ACCOUNT_NOT_FOUND", `No account ${accountId} in the Bridge config.`);
  }

  /**
   * The account's book: loaded (and rolled to today) on first use, or created and saved when there is none.
   * @param {string} accountId
   * @param {{ onlyIfSaved?: boolean }} [opts] onlyIfSaved: return null instead of creating a new book (start-up restore).
   */
  function book(accountId, { onlyIfSaved = false } = {}) {
    checkAccountId(accountId);
    let st = books.get(accountId);
    if (!st) {
      const loaded = store.load(accountId);
      if (onlyIfSaved && !loaded.state && !loaded.corrupt) return null;
      if (loaded.corrupt) warn(`Paper account ${accountId}: the saved state could not be read and was moved aside (${loaded.corrupt}). Starting a fresh paper book.`, { accountId });
      st = loaded.state ?? freshState(accountId, cfg.startingCapital, toIstIso(now()));
      books.set(accountId, st);
      for (const [symbol, m] of Object.entries(st.marks ?? {})) if (!lastPrice.has(symbol)) lastPrice.set(symbol, { ltp: m.ltp, bid: null, ask: null, at: m.at });
      const rolled = rollDay(st);
      if (!loaded.state || rolled) save(st);
      else recomputeInterest();
    } else if (rollDay(st)) save(st);
    return st;
  }

  /** New IST day: expire earlier pending orders, drop flat positions, start the day's counters. */
  function rollDay(st) {
    const today = istDay(now());
    if (st.day === today) return false;
    const t = now();
    // The day that ends gets its end-of-day snapshot from the last marks, if the session-end pass did not take one.
    if (st.day && !(st.daily ?? []).some((x) => x.day === st.day && x.source === "eod")) takeSnapshot(st, "eod", t, st.day);
    for (const o of st.orders) if (isPending(o)) setStatus(o, "expired", "Expired at the end of the trading day.", t);
    for (const [k, p] of Object.entries(st.positions)) {
      if (p.netQty === 0) delete st.positions[k];
      // Carried into the new day: the quantity and the last mark become the day's starting point (the Day view's P&L
      // is measured from the previous close, as brokers do).
      else Object.assign(p, { realisedPnl: 0, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0, overnightQty: p.netQty, prevClose: lastPrice.get(p.symbol)?.ltp ?? st.marks?.[p.symbol]?.ltp ?? p.avgPrice });
    }
    st.day = today;
    st.ordersToday = 0;
    return true;
  }

  // ───────────────────────────── daily P&L snapshots ─────────────────────────────
  // One row per IST day in st.daily: { day, at, source ("eod" | "manual"), equity, realised, unrealised, charges,
  // pnl (the day's change in equity), usedMargin, openPositions }. End of day: the first maintenance pass after the
  // session end, or the day roll; on demand: snapshot(). A later snapshot of the same day replaces an earlier one,
  // except that a manual one never replaces the end-of-day row. Kept for DAILY_KEPT days.
  function equityOf(st) {
    const unrealised = Object.values(st.positions).reduce((a, p) => a + unrealisedOf(p).unrealised, 0);
    return { equity: st.startingCapital + st.realisedTotal - st.charges + unrealised, unrealised };
  }
  function takeSnapshot(st, source, t, day = istDay(t)) {
    const list = (st.daily = Array.isArray(st.daily) ? st.daily : []);
    const prev = [...list].reverse().find((x) => x.day < day) ?? null;
    const { equity, unrealised } = equityOf(st);
    // After a reset the day is measured from the new starting capital, not from the old book's equity.
    const resetSince = st.resetAt && (!prev || Date.parse(st.resetAt) > Date.parse(prev.at));
    const base = prev && !resetSince ? prev.equity : resetSince || !prev ? st.startingCapital : prev.equity;
    let usedMarginNow = null;
    try {
      usedMarginNow = usedMargin(st);
    } catch {
      usedMarginNow = null;
    }
    const row = {
      day,
      at: toIstIso(t),
      source,
      equity: round2(equity),
      realised: round2(st.realisedTotal),
      unrealised: round2(unrealised),
      charges: round2(st.charges),
      pnl: round2(equity - base),
      usedMargin: usedMarginNow === null ? null : round2(usedMarginNow),
      openPositions: Object.values(st.positions).filter((p) => p.netQty !== 0).length,
    };
    const i = list.findIndex((x) => x.day === day);
    if (i >= 0) {
      if (list[i].source === "eod" && source !== "eod") return list[i];
      list[i] = row;
    } else {
      list.push(row);
      list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    }
    if (list.length > DAILY_KEPT) list.splice(0, list.length - DAILY_KEPT);
    return row;
  }

  function nextOrderId() {
    const day = istDayCompact(now());
    ids = { day, seq: (ids.day === day ? ids.seq : 0) + 1 };
    try {
      store.saveIds(ids);
    } catch (err) {
      log?.error?.("paper id sequence could not be saved", { err });
    }
    return `PAPER-${day}-${String(ids.seq).padStart(6, "0")}`;
  }

  function trim(st) {
    const limit = cfg.historyLimit;
    const done = st.orders.filter((o) => !isPending(o));
    if (done.length > limit) {
      const drop = new Set(done.slice(0, done.length - limit).map((o) => o.orderId));
      st.orders = st.orders.filter((o) => !drop.has(o.orderId));
    }
    if (st.trades.length > limit) st.trades = st.trades.slice(st.trades.length - limit);
  }

  // ───────────────────────────── projection and events ─────────────────────────────

  /** Internal order -> OrderResult (contract shape). */
  function project(o) {
    return {
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      accountId: o.accountId,
      broker: "paper",
      mode: "paper",
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      filledQuantity: o.filledQuantity,
      avgPrice: o.avgPrice,
      price: o.price,
      triggerPrice: o.triggerPrice,
      orderType: o.orderType,
      product: o.product,
      validity: o.validity,
      status: o.status,
      brokerStatus: null,
      statusMessage: o.statusMessage,
      legs: [
        {
          brokerOrderId: null,
          quantity: o.quantity,
          status: o.status,
          error: o.status === "rejected" ? { code: "PAPER_REJECTED", message: o.statusMessage ?? "Rejected." } : null,
        },
      ],
      source: o.source,
      tag: o.tag,
      placedAt: o.placedAt,
      updatedAt: o.updatedAt,
    };
  }

  function emit(o, extra = {}) {
    const payload = {
      orderId: o.orderId,
      accountId: o.accountId,
      mode: "paper",
      status: o.status,
      brokerStatus: null,
      filledQuantity: o.filledQuantity,
      avgPrice: o.avgPrice,
      source: o.source,
      ...extra,
    };
    if (o.clientOrderId) payload.clientOrderId = o.clientOrderId;
    bus?.emit("order.updated", payload);
  }

  function setStatus(o, status, message, t, extra) {
    o.status = status;
    if (message !== undefined) o.statusMessage = message;
    o.updatedAt = toIstIso(t);
    emit(o, extra);
  }

  // ───────────────────────────── money ─────────────────────────────

  const instOf = (x) => ({ kind: x.kind, strike: x.strike ?? null });
  const portfolio = cfg.margin.model !== "simple";
  const spanParams = { ...SPAN_PARAMS, simple: { optionSellPct: cfg.margin.optionSellPct, futuresPct: cfg.margin.futuresPct } };
  /** underlying -> { ltp, at }: the spot used as the forward of the margin scan. */
  const spots = new Map();
  const partsCache = new Map();

  /** F&O parts of a canonical NFO/BFO symbol, or null (equity, MCX, CDS and anything unreadable use the percentages). */
  function derivParts(symbol) {
    if (partsCache.has(symbol)) return partsCache.get(symbol);
    let p = null;
    try {
      const x = parseSymbol(symbol, { lenient: false });
      if ((x.kind === "OPT" || x.kind === "FUT") && (x.exchange === "NFO" || x.exchange === "BFO")) p = x;
    } catch {
      p = null;
    }
    if (partsCache.size > 5000) partsCache.clear();
    partsCache.set(symbol, p);
    return p;
  }
  const spotSymbol = (p) => `${p.exchange === "BFO" ? "BSE" : "NSE"}:${p.underlying}`;

  /** A margin leg for a symbol and signed quantity, or null when it is not an F&O contract. */
  function legOf(symbol, qty, cost) {
    const p = portfolio ? derivParts(symbol) : null;
    if (!p) return null;
    const mark = lastPrice.get(symbol)?.ltp ?? cost ?? null;
    return { underlying: p.underlying, kind: p.kind, right: p.right, strike: p.strike, expiry: p.expiry, qty, cost: cost ?? mark, mark };
  }

  /** Forward per underlying: its spot when known, else the price of a future on it, else none (simple model). */
  function forwardsFor(legs) {
    const out = {};
    for (const l of legs) {
      if (out[l.underlying]) continue;
      const s = spots.get(l.underlying)?.ltp;
      if (s > 0) out[l.underlying] = s;
      else {
        const f = legs.find((x) => x.underlying === l.underlying && x.kind === "FUT" && x.mark > 0);
        if (f) out[l.underlying] = f.mark;
      }
    }
    return out;
  }
  const marginCtx = (legs) => ({ nowMs: now(), forwards: forwardsFor(legs), params: spanParams });

  /** Fetch the spot of every underlying these symbols need (one batched call; a failure leaves the simple model). */
  async function ensureSpots(symbols) {
    if (!portfolio) return;
    const want = new Map();
    for (const sym of symbols) {
      const p = derivParts(sym);
      if (!p) continue;
      const have = spots.get(p.underlying);
      if (!have || now() - have.at > cfg.pollIntervalMs) want.set(spotSymbol(p), p.underlying);
    }
    if (!want.size) return;
    try {
      const r = await deps.marketData.ltp([...want.keys()], { maxAgeMs: cfg.pollIntervalMs, priority: "interactive" });
      for (const item of r?.items ?? []) {
        const u = want.get(item?.symbol);
        if (u && positiveNumber(item.ltp)) spots.set(u, { ltp: item.ltp, at: now() });
      }
    } catch (err) {
      log?.debug?.("paper margin spot fetch failed", { code: err?.code });
    }
  }
  const bookSymbols = (st, extra = []) => [...Object.values(st.positions).filter((p) => p.netQty !== 0).map((p) => p.symbol), ...st.orders.filter(isPending).map((o) => o.symbol), ...extra];

  function positionBlock(p) {
    if (p.netQty === 0) return 0;
    return marginFor(instOf(p), { side: p.netQty > 0 ? "BUY" : "SELL", product: p.product, quantity: Math.abs(p.netQty), price: p.avgPrice }, cfg.margin);
  }

  /** Price used to size a pending order's margin. */
  function estimatePrice(o) {
    if (o.orderType === "LIMIT" || o.orderType === "SL") return o.price;
    if (o.orderType === "SL-M") return o.triggerPrice;
    return lastPrice.get(o.symbol)?.ltp ?? 0;
  }

  /** Margin for the part of an order that adds exposure to the current position (closing quantity blocks nothing). */
  function orderBlock(st, o, price = estimatePrice(o)) {
    const net = st.positions[posKey(o.symbol, o.product)]?.netQty ?? 0;
    const signed = o.side === "BUY" ? o.quantity : -o.quantity;
    const adds = net !== 0 && Math.sign(net) !== Math.sign(signed) ? Math.max(0, o.quantity - Math.abs(net)) : o.quantity;
    if (adds === 0) return 0;
    return marginFor(instOf(o), { side: o.side, product: o.product, quantity: adds, price }, cfg.margin);
  }

  /**
   * F&O legs held and pending, plus the margin of everything else (equity, MCX, CDS) by percentage.
   * @param {{ order: object, price: number }[]} extra  orders not yet in the book (a new order, a preview)
   */
  function bookLegs(st, except, extra = []) {
    let other = 0;
    const held = [];
    const pend = [];
    for (const p of Object.values(st.positions)) {
      if (p.netQty === 0) continue;
      const leg = legOf(p.symbol, p.netQty, p.avgPrice);
      if (leg) held.push(leg);
      else other += positionBlock(p);
    }
    const pendingOrders = st.orders.filter((o) => isPending(o) && o !== except).map((o) => ({ order: o, price: estimatePrice(o) }));
    for (const { order: o, price } of [...pendingOrders, ...extra]) {
      const leg = legOf(o.symbol, o.side === "BUY" ? o.quantity : -o.quantity, price);
      if (leg) pend.push(leg);
      else other += orderBlock(st, o, price);
    }
    return { held, pend, other };
  }

  /**
   * Blocked margin. Portfolio model: the larger of what the held legs need and what they would need with every
   * pending order filled (a pending hedge never lowers the block before it fills).
   */
  function usedMargin(st, except, extra = []) {
    if (!portfolio) {
      let used = 0;
      for (const p of Object.values(st.positions)) used += positionBlock(p);
      for (const o of st.orders) if (isPending(o) && o !== except) used += orderBlock(st, o);
      for (const { order, price } of extra) used += orderBlock(st, order, price);
      return used;
    }
    const { held, pend, other } = bookLegs(st, except, extra);
    if (!held.length && !pend.length) return other;
    const ctx = marginCtx([...held, ...pend]);
    const a = marginRequired(held, ctx);
    const b = pend.length ? marginRequired([...held, ...pend], ctx) : a;
    return other + Math.max(a, b);
  }

  /** Margin `o` adds to the book at `price` (0 when it closes or hedges). */
  const marginToAdd = (st, o, price) => (portfolio ? Math.max(0, usedMargin(st, o, [{ order: o, price }]) - usedMargin(st, o)) : orderBlock(st, o, price));

  const availableCash = (st, except) => st.startingCapital + st.realisedTotal - st.charges - usedMargin(st, except);

  function unrealisedOf(p) {
    const ltp = lastPrice.get(p.symbol)?.ltp ?? null;
    if (p.netQty === 0 || ltp === null) return { ltp, unrealised: 0 };
    return { ltp, unrealised: (ltp - p.avgPrice) * p.netQty };
  }

  function marketPriceFor(side, market, tickSize) {
    return marketFillPrice({ side, ltp: market.ltp, bid: market.bid, ask: market.ask, depth: market.depth, slippageBps: cfg.slippageBps, tickSize })?.price ?? market.ltp;
  }

  // ───────────────────────────── prices ─────────────────────────────

  /**
   * Remember a price. `at` is when the price was true, not when we heard of it: a market-data item carries
   * freshness.asOf (a cached value may be seconds or minutes old under budget pressure), a tick carries receivedAt.
   */
  function notePrice(symbol, item, at = priceTime(item)) {
    const { ltp, bid = null, ask = null } = item ?? {};
    if (!positiveNumber(ltp)) return null;
    const prev = lastPrice.get(symbol);
    const entry = { ltp, bid: positiveNumber(bid) ? bid : null, ask: positiveNumber(ask) ? ask : null, at, stale: item?.freshness?.stale === true };
    // Never let an older price replace a newer one.
    if (prev && prev.at > at) return entry;
    lastPrice.set(symbol, entry);
    return entry;
  }

  /** When a price was true: freshness.asOf, else the tick's receivedAt, else now. Never in the future. */
  function priceTime(item) {
    const t = now();
    const asOf = typeof item?.freshness?.asOf === "string" ? Date.parse(item.freshness.asOf) : NaN;
    if (Number.isFinite(asOf)) return Math.min(asOf, t);
    if (Number.isFinite(item?.receivedAt)) return Math.min(item.receivedAt, t);
    return t;
  }

  /** A price recent enough to fill, check margin or trigger on. */
  const usableNow = (entry, maxAgeMs) => Boolean(entry) && !entry.stale && now() - entry.at <= maxAgeMs;

  /**
   * Current market for one symbol: a recent tick or a fetched LTP, plus depth when asked for.
   * @returns {Promise<{ ltp: number, bid: number|null, ask: number|null, depth?: object } | null>}
   */
  async function marketFor(symbol, { depth = false, maxAgeMs = FRESH_MS } = {}) {
    let market = null;
    const lp = lastPrice.get(symbol);
    if (usableNow(lp, maxAgeMs)) market = { ...lp };
    if (!market) {
      try {
        const r = await deps.marketData.ltp([symbol], { maxAgeMs, priority: "interactive" });
        const item = r?.items?.find((i) => i.symbol === symbol) ?? r?.items?.[0];
        const entry = item ? notePrice(symbol, item) : null;
        // A stale-labelled or old value (served from cache under budget pressure) is no basis for a fill.
        if (usableNow(entry, Math.max(maxAgeMs, FRESH_MS))) market = { ...entry };
        else if (entry) log?.debug?.("paper price too old to use", { symbol, ageMs: now() - entry.at, stale: entry.stale });
      } catch (err) {
        log?.debug?.("paper price fetch failed", { symbol, code: err?.code });
      }
    }
    if (market && depth && cfg.useDepth) {
      try {
        const d = await deps.marketData.depth(symbol, { maxAgeMs, priority: "interactive" });
        if (d) market.depth = d;
      } catch (err) {
        log?.debug?.("paper depth fetch failed", { symbol, code: err?.code });
      }
    }
    return market;
  }

  /** Refresh prices for open positions with no recent price (one batched LTP call). */
  async function markPositions(st) {
    const stale = [...new Set(Object.values(st.positions).filter((p) => p.netQty !== 0).map((p) => p.symbol))].filter((s) => {
      const lp = lastPrice.get(s);
      return !lp || now() - lp.at > cfg.pollIntervalMs;
    });
    if (!stale.length) return;
    try {
      const r = await deps.marketData.ltp(stale, { maxAgeMs: cfg.pollIntervalMs, priority: "interactive" });
      for (const item of r?.items ?? []) notePrice(item.symbol, item);
    } catch (err) {
      log?.debug?.("paper mark-to-market fetch failed", { code: err?.code });
    }
  }

  // ───────────────────────────── fills ─────────────────────────────

  function fill(st, o, price, t) {
    const key = posKey(o.symbol, o.product);
    const today = istDay(t);
    const prev = st.positions[key] ?? {
      symbol: o.symbol,
      product: o.product,
      exchange: o.exchange,
      kind: o.kind,
      strike: o.strike ?? null,
      tickSize: o.tickSize,
      netQty: 0,
      avgPrice: 0,
      realisedPnl: 0,
      buyQty: 0,
      sellQty: 0,
      buyValue: 0,
      sellValue: 0,
      openedDay: today,
    };
    const { position, realised } = applyFill(prev, { side: o.side, quantity: o.quantity, price });
    if (prev.netQty === 0 || (position.netQty !== 0 && Math.sign(position.netQty) !== Math.sign(prev.netQty))) position.openedDay = today;
    st.positions[key] = position;
    const charge = brokerageFor(price * o.quantity, cfg.brokerage);
    st.realisedTotal += realised;
    st.charges += charge;
    o.filledQuantity = o.quantity;
    o.avgPrice = price;
    st.trades.push({
      tradeId: `${o.orderId}-T1`,
      orderId: o.orderId,
      accountId: o.accountId,
      mode: "paper",
      symbol: o.symbol,
      side: o.side,
      product: o.product,
      qty: o.quantity,
      price,
      charges: charge,
      tradedAt: toIstIso(t),
      clientOrderId: o.clientOrderId ?? null,
      tag: o.tag ?? null,
    });
    setStatus(o, "filled", o.statusMessage ?? null, t, { realisedPnl: round2(realised) });
  }

  /**
   * Evaluate one pending order against a market snapshot and apply the result.
   * @returns {boolean} whether the order changed (and an event was emitted)
   */
  function apply(st, o, market, { immediate = false, t = now() } = {}) {
    const r = evaluate(o, market, { slippageBps: cfg.slippageBps, tickSize: o.tickSize, immediate });
    if (r.action === "fill") {
      o.triggered = r.triggered;
      fill(st, o, r.price, t);
      return true;
    }
    if (r.action === "trigger") {
      o.triggered = true;
      setStatus(o, "open", "Trigger price reached; working as a limit order.", t);
      return true;
    }
    return false;
  }

  /** Evaluate every pending order on `symbol` in every loaded book. Synchronous (safe inside a bus handler). */
  function evaluateSymbol(symbol, market) {
    const t = now();
    for (const st of books.values()) {
      let changed = false;
      for (const o of st.orders) if (isPending(o) && o.symbol === symbol && apply(st, o, market, { t })) changed = true;
      if (changed) save(st);
    }
  }

  // ───────────────────────────── validation ─────────────────────────────

  function checkShape(o) {
    if (o.orderType === "LIMIT" || o.orderType === "SL") {
      if (!positiveNumber(o.price)) throw invalid(`${o.orderType} orders need a price above zero.`, "price");
    }
    if (isStop(o.orderType) && !positiveNumber(o.triggerPrice)) throw invalid(`${o.orderType} orders need a triggerPrice above zero.`, "triggerPrice");
    if (o.orderType === "SL") {
      if (o.side === "BUY" && o.price < o.triggerPrice) throw invalid("For a stop-loss buy, the price must be at or above the trigger price.", "price");
      if (o.side === "SELL" && o.price > o.triggerPrice) throw invalid("For a stop-loss sell, the price must be at or below the trigger price.", "price");
    }
    for (const f of ["price", "triggerPrice"]) {
      if (o[f] !== null && !isTickMultiple(o[f], o.tickSize)) throw invalid(`${f} ${o[f]} is not a multiple of the tick size ${o.tickSize}.`, f);
    }
    if (!Number.isInteger(o.quantity) || o.quantity <= 0) throw invalid("quantity must be a whole number above zero.", "quantity");
    if (o.quantity % o.lotSize !== 0) throw invalid(`quantity ${o.quantity} is not a multiple of the lot size ${o.lotSize}.`, "quantity");
  }

  function normalise(order, inst) {
    if (!order || typeof order !== "object") throw badInput("order is required.", "order");
    const side = String(order.side ?? "").toUpperCase();
    if (!SIDES.has(side)) throw badInput("side must be BUY or SELL.", "side");
    if (!PRODUCTS.has(order.product)) throw badInput("product must be CNC, INTRADAY, MARGIN or MTF.", "product");
    if (!ORDER_TYPES.has(order.orderType)) throw badInput("orderType must be LIMIT, MARKET, SL or SL-M.", "orderType");
    const validity = order.validity ?? "DAY";
    if (!VALIDITIES.has(validity)) throw badInput("validity must be DAY or IOC.", "validity");
    const lotSize = positiveNumber(inst.lotSize) ? inst.lotSize : 1;
    const quantity = order.quantity ?? (Number.isInteger(order.lots) ? order.lots * lotSize : undefined);
    const o = {
      symbol: inst.canonical,
      exchange: inst.exchange,
      kind: inst.kind,
      strike: inst.strike ?? null,
      lotSize,
      tickSize: positiveNumber(inst.tickSize) ? inst.tickSize : 0.05,
      side,
      quantity,
      product: order.product,
      orderType: order.orderType,
      price: order.orderType === "LIMIT" || order.orderType === "SL" ? (order.price ?? null) : null,
      triggerPrice: isStop(order.orderType) ? (order.triggerPrice ?? null) : null,
      validity,
      clientOrderId: typeof order.clientOrderId === "string" ? order.clientOrderId : null,
      tag: typeof order.tag === "string" ? order.tag : null,
      source: SOURCES.has(order.source) ? order.source : "rest",
    };
    checkShape(o);
    return o;
  }

  /** Business refusal text (the order is stored as rejected), or null. */
  function refusal(st, o, market, t) {
    if (o.kind === "INDEX") return "An index cannot be traded directly. Trade its futures or options.";
    if (DELIVERY.has(o.product) && (o.kind === "FUT" || o.kind === "OPT")) return `${o.product} is for equity delivery. Use MARGIN or INTRADAY for futures and options.`;
    if (o.product === "INTRADAY" && cfg.squareOff.enabled && t >= squareOffAt(o.exchange, t)) {
      return `Intraday orders are not accepted after the ${squareOffLabel(o.exchange)} IST square-off.`;
    }
    if (DELIVERY.has(o.product) && o.side === "SELL") {
      const held = Math.max(0, st.positions[posKey(o.symbol, o.product)]?.netQty ?? 0);
      const pendingSells = st.orders.filter((x) => isPending(x) && x.symbol === o.symbol && x.product === o.product && x.side === "SELL").reduce((s, x) => s + x.quantity, 0);
      const free = Math.max(0, held - pendingSells);
      if (o.quantity > free) return `Not enough ${o.product} quantity to sell (${free} available). Short selling needs the INTRADAY product.`;
    }
    if (isStop(o.orderType) && market && stopTriggered(o.side, o.triggerPrice, market.ltp)) return stopCrossedText(o.side, market.ltp);
    if (o.orderType === "MARKET" && !market) return "No market price is available for this symbol right now, so the paper order could not be filled.";
    const est = o.orderType === "MARKET" ? marketPriceFor(o.side, market, o.tickSize) : estimatePrice(o);
    const need = marginToAdd(st, o, est);
    const have = availableCash(st, o);
    if (need > have + 1e-6) return `Insufficient paper funds: this order needs about ${rupees(need)} and ${rupees(have)} is available.`;
    return null;
  }

  function findOrder(st, orderId) {
    const o = st.orders.find((x) => x.orderId === orderId);
    if (!o) throw new BridgeError("ORDER_NOT_FOUND", `No paper order ${String(orderId)} on account ${st.accountId}.`);
    return o;
  }

  async function resolveInstrument(order) {
    const r = order?.resolved;
    if (r && typeof r.canonical === "string") return r;
    if (typeof order?.symbol !== "string" || !order.symbol) throw badInput("symbol is required.", "symbol");
    return deps.symbols.resolve(order.symbol);
  }

  // ───────────────────────────── time-based work ─────────────────────────────

  function expireDayOrders(st, t) {
    // Demo: the sample market ticks at any hour, so a resting DAY order stays open until the day rolls (rollDay) instead
    // of expiring the moment it is placed after the close (a basket would be left part-filled).
    if (config?.demo) return false;
    let changed = false;
    for (const o of st.orders) {
      if (isPending(o) && t >= sessionEndAt(o.exchange, t)) {
        setStatus(o, "expired", "Expired at the end of the trading session.", t);
        changed = true;
      }
    }
    return changed;
  }

  /** Square off due INTRADAY orders and positions. Async only to fetch prices that are missing. */
  async function squareOff(st) {
    if (!cfg.squareOff.enabled) return false;
    const t0 = now();
    const today = istDay(t0);
    const due = (exchange, openedDay) => t0 >= squareOffAt(exchange, t0) || (openedDay !== undefined && openedDay < today);
    let changed = false;
    for (const o of st.orders) {
      if (isPending(o) && o.product === "INTRADAY" && due(o.exchange)) {
        setStatus(o, "cancelled", "Cancelled by the intraday square-off.", t0);
        changed = true;
      }
    }
    const open = Object.values(st.positions).filter((p) => p.product === "INTRADAY" && p.netQty !== 0 && due(p.exchange, p.openedDay));
    for (const p of open) {
      const market = (await marketFor(p.symbol, { maxAgeMs: cfg.pollIntervalMs })) ?? lastPrice.get(p.symbol) ?? null;
      if (books.get(st.accountId) !== st) return changed; // reset while we waited
      const pos = st.positions[posKey(p.symbol, p.product)];
      if (!pos || pos.netQty === 0) continue;
      if (!market) {
        log?.warn?.("paper square-off is waiting for a price", { accountId: st.accountId, symbol: p.symbol });
        continue;
      }
      const side = pos.netQty > 0 ? "SELL" : "BUY";
      const tickSize = pos.tickSize ?? 0.05;
      const price = marketPriceFor(side, { ...market, depth: null }, tickSize);
      const t = now();
      const o = {
        orderId: nextOrderId(),
        accountId: st.accountId,
        symbol: pos.symbol,
        exchange: pos.exchange,
        kind: pos.kind,
        strike: pos.strike ?? null,
        lotSize: 1,
        tickSize,
        side,
        quantity: Math.abs(pos.netQty),
        product: "INTRADAY",
        orderType: "MARKET",
        price: null,
        triggerPrice: null,
        validity: "DAY",
        clientOrderId: null,
        tag: "square-off",
        source: "system",
        status: "open",
        statusMessage: "Intraday square-off.",
        filledQuantity: 0,
        avgPrice: null,
        triggered: false,
        placedAt: toIstIso(t),
        updatedAt: toIstIso(t),
      };
      st.orders.push(o);
      fill(st, o, price, t);
      changed = true;
    }
    return changed;
  }

  /** Re-price pending orders that have had no recent tick (one batched LTP call across all books). */
  async function pollPending() {
    const t = now();
    const want = new Set();
    for (const st of books.values()) for (const o of st.orders) if (isPending(o)) want.add(o.symbol);
    const stale = [...want].filter((s) => {
      const lp = lastPrice.get(s);
      return !lp || t - lp.at >= cfg.pollIntervalMs;
    });
    if (!stale.length) return;
    let r;
    try {
      r = await deps.marketData.ltp(stale, { maxAgeMs: cfg.pollIntervalMs, priority: "interactive" });
    } catch (err) {
      log?.debug?.("paper poll failed", { code: err?.code });
      return;
    }
    for (const item of r?.items ?? []) {
      const entry = notePrice(item.symbol, item);
      // Pending orders trigger and fill only on a current price, never on a stale-labelled cached one.
      if (entry && !entry.stale && lastPrice.get(item.symbol) === entry) evaluateSymbol(item.symbol, entry);
    }
  }

  // ───────────────────────────── engine ─────────────────────────────

  const engine = {
    /**
     * Place a paper order. `order.quantity` is in units; `order.resolved` is the instrument (resolved here if absent).
     * @param {string} accountId
     * @param {object} order  OrderRequest & { quantity, resolved, source? }
     * @returns {Promise<object>} OrderResult
     */
    async place(accountId, order) {
      book(accountId);
      const inst = await resolveInstrument(order);
      const o = normalise(order, inst);
      const market = await marketFor(o.symbol, { depth: o.orderType === "MARKET" });
      await ensureSpots(bookSymbols(book(accountId), [o.symbol]));
      const st = book(accountId); // re-read: a reset may have replaced the book while we waited
      const t = now();
      Object.assign(o, {
        orderId: nextOrderId(),
        accountId,
        status: isStop(o.orderType) ? "trigger_pending" : "open",
        statusMessage: null,
        filledQuantity: 0,
        avgPrice: null,
        triggered: false,
        placedAt: toIstIso(t),
        updatedAt: toIstIso(t),
      });
      st.ordersToday += 1;
      const why = refusal(st, o, market, t);
      st.orders.push(o);
      if (why) {
        o.status = "rejected";
        o.statusMessage = why;
        emit(o);
      } else if (!(market && apply(st, o, market, { immediate: true, t }))) {
        if (o.validity === "IOC" && o.status === "open") {
          o.status = "cancelled";
          o.statusMessage = "IOC order could not be matched immediately.";
        }
        emit(o);
      }
      trim(st);
      save(st);
      return project(o);
    },

    /**
     * Modify a pending order. Changes: price, triggerPrice, quantity, orderType. A change that makes the order
     * marketable fills it at once.
     * @returns {Promise<object>} OrderResult
     */
    async modify(accountId, orderId, changes = {}) {
      const st0 = book(accountId);
      const current = findOrder(st0, orderId);
      if (!isPending(current)) throw invalid(`Order ${orderId} is ${current.status}; only open or trigger-pending orders can be modified.`);
      if (!changes || typeof changes !== "object") throw badInput("changes must be an object.", "changes");
      const unknown = Object.keys(changes).filter((k) => !MODIFIABLE.includes(k) && changes[k] !== undefined);
      if (unknown.length) throw badInput(`These fields cannot be modified: ${unknown.join(", ")}.`, unknown[0]);
      if (changes.orderType !== undefined && !ORDER_TYPES.has(changes.orderType)) throw badInput("orderType must be LIMIT, MARKET, SL or SL-M.", "orderType");
      const next = { ...current };
      for (const k of MODIFIABLE) if (changes[k] !== undefined) next[k] = changes[k];
      if (!(next.orderType === "LIMIT" || next.orderType === "SL")) next.price = null;
      if (!isStop(next.orderType)) next.triggerPrice = null;
      if (next.orderType !== current.orderType) next.triggered = false;
      checkShape(next);
      const market = await marketFor(next.symbol, { depth: next.orderType === "MARKET" });
      await ensureSpots(bookSymbols(book(accountId)));
      const st = book(accountId);
      const o = st.orders.find((x) => x.orderId === orderId);
      if (!o || !isPending(o)) throw invalid(`Order ${orderId} is ${o?.status ?? "no longer available"}; it can no longer be modified.`);
      if (isStop(next.orderType) && !next.triggered && market && stopTriggered(next.side, next.triggerPrice, market.ltp)) {
        throw invalid(stopCrossedText(next.side, market.ltp), "triggerPrice");
      }
      if (next.orderType === "MARKET" && !market) throw invalid("No market price is available right now, so the order cannot be changed to MARKET.");
      const est = next.orderType === "MARKET" ? marketPriceFor(next.side, market, next.tickSize) : estimatePrice(next);
      const need = marginToAdd(st, next, est);
      const have = availableCash(st, o);
      if (need > have + 1e-6) throw invalid(`Insufficient paper funds for this change: it needs about ${rupees(need)} and ${rupees(have)} is available.`);
      const t = now();
      Object.assign(o, { price: next.price, triggerPrice: next.triggerPrice, quantity: next.quantity, orderType: next.orderType, triggered: next.triggered });
      o.status = isStop(o.orderType) && !o.triggered ? "trigger_pending" : "open";
      o.statusMessage = "Modified.";
      o.updatedAt = toIstIso(t);
      if (!(market && apply(st, o, market, { immediate: true, t }))) emit(o);
      save(st);
      return project(o);
    },

    /**
     * Convert part or all of a position between products (Intraday MIS and carry NRML), as brokers do: no order, no
     * fill, no charge. The moved quantity keeps its average price; it joins a position already held in the other
     * product at the weighted average. Refused when the other product holds the opposite side, when the quantity is
     * more than is held, and into Intraday at or after the square-off time (it would be squared off at once).
     * @param {string} accountId
     * @param {{ symbol: string, from: string, to: string, quantity: number }} c
     * @returns {Promise<{ from: object, to: object, quantity: number, at: string }>}
     */
    async convert(accountId, { symbol, from, to, quantity }) {
      const st = book(accountId);
      const PRODUCTS = ["INTRADAY", "MARGIN", "CNC"];
      if (!PRODUCTS.includes(from) || !PRODUCTS.includes(to) || from === to) throw badInput("from and to must be two different products: INTRADAY, MARGIN or CNC.", "to");
      if (!(Number.isInteger(quantity) && quantity > 0)) throw badInput("quantity must be a whole number above zero.", "quantity");
      const src = st.positions[posKey(symbol, from)];
      if (!src || src.netQty === 0) throw invalid(`There is no open ${from} position in ${symbol} to convert.`, "symbol");
      if (quantity > Math.abs(src.netQty)) throw invalid(`Only ${Math.abs(src.netQty)} is held in ${from}; ${quantity} cannot be converted.`, "quantity");
      const t = now();
      if (to === "INTRADAY" && cfg.squareOff.enabled && t >= squareOffAt(src.exchange, t)) throw invalid("It is past the intraday square-off time, so a position cannot be converted to Intraday now.", "to");
      const dir = Math.sign(src.netQty);
      const key = posKey(symbol, to);
      const dst = st.positions[key] ?? { symbol, product: to, exchange: src.exchange, kind: src.kind, strike: src.strike ?? null, tickSize: src.tickSize, netQty: 0, avgPrice: 0, realisedPnl: 0, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0, openedDay: src.openedDay };
      if (dst.netQty !== 0 && Math.sign(dst.netQty) !== dir) throw invalid(`The ${to} position in ${symbol} is on the other side; close it first, then convert.`, "to");
      const value = quantity * src.avgPrice;
      dst.avgPrice = (Math.abs(dst.netQty) * dst.avgPrice + value) / (Math.abs(dst.netQty) + quantity);
      dst.netQty += dir * quantity;
      // The day's figures move with the units so each product's Day P&L stays right: carried units first (with the
      // previous close), then today's buys (or sells) at today's average.
      const carried = Math.sign(src.overnightQty ?? 0) === dir ? Math.min(quantity, Math.abs(src.overnightQty ?? 0)) : 0;
      if (carried) {
        src.overnightQty -= dir * carried;
        dst.overnightQty = (dst.overnightQty ?? 0) + dir * carried;
        dst.prevClose = src.prevClose;
      }
      const today = quantity - carried;
      if (today) {
        const side = dir > 0 ? "buy" : "sell";
        const q = `${side}Qty`;
        const v = `${side}Value`;
        const avg = src[q] > 0 ? src[v] / src[q] : src.avgPrice;
        const moved = Math.min(today, src[q]);
        src[q] -= moved;
        src[v] = Math.max(0, src[v] - moved * avg);
        dst[q] += moved;
        dst[v] += moved * avg;
      }
      if (dst.openedDay === undefined || (src.openedDay !== undefined && src.openedDay < dst.openedDay)) dst.openedDay = src.openedDay;
      src.netQty -= dir * quantity;
      if (src.netQty === 0) src.avgPrice = 0;
      st.positions[key] = dst;
      const at = toIstIso(t);
      (st.conversions ??= []).push({ at, symbol, from, to, quantity: dir * quantity });
      if (st.conversions.length > 500) st.conversions.splice(0, st.conversions.length - 500);
      save(st);
      return { from: { ...src }, to: { ...dst }, quantity, at };
    },

    /** Cancel a pending order. Throws ORDER_NOT_FOUND, or INVALID_ORDER when it is already final. */
    async cancel(accountId, orderId) {
      const st = book(accountId);
      const o = findOrder(st, orderId);
      if (!isPending(o)) throw invalid(`Order ${orderId} is already ${o.status} and cannot be cancelled.`);
      setStatus(o, "cancelled", "Cancelled by request.", now());
      save(st);
      return project(o);
    },

    /**
     * The margin this order would block if it were placed now: the same model as a fill (marginFor on the part of the
     * order that adds exposure; the quantity that closes an open position blocks nothing). Nothing is stored.
     * @param {string} accountId
     * @param {object} order  OrderRequest & { quantity, resolved? }
     * @param {number} [price]  price to size it at (default: the limit / trigger, else the last price)
     * @returns {Promise<number>} rupees
     */
    async estimateOrderMargin(accountId, order, price) {
      const st = book(accountId);
      const inst = await resolveInstrument(order);
      const o = normalise(order, inst);
      if (!Number.isFinite(o.quantity) || o.quantity <= 0) return 0;
      const px = Number.isFinite(price) ? price : o.orderType === "MARKET" ? (lastPrice.get(o.symbol)?.ltp ?? (await marketFor(o.symbol, { depth: false }).catch(() => null))?.ltp ?? 0) : estimatePrice(o);
      await ensureSpots(bookSymbols(st, [o.symbol]));
      return round2(marginToAdd(book(accountId), o, Number.isFinite(px) ? px : 0));
    },

    /**
     * Margin of a basket against this account's book (nothing is stored): what the book blocks now, after the
     * basket, the change, the basket on its own, and each leg on its own with no hedge benefit (`standalone`).
     * @param {string} accountId
     * @param {Array<object>} orders  OrderRequest & { quantity, resolved?, price? } (price: the limit, else the last price)
     */
    async estimateBasketMargin(accountId, orders) {
      book(accountId);
      const list = [];
      for (const order of orders ?? []) {
        const inst = await resolveInstrument(order);
        const o = normalise({ orderType: "LIMIT", product: "MARGIN", ...order }, inst);
        let px = Number.isFinite(order.price) ? order.price : lastPrice.get(o.symbol)?.ltp;
        if (!Number.isFinite(px)) px = (await marketFor(o.symbol).catch(() => null))?.ltp ?? 0;
        list.push({ order: o, price: px });
      }
      await ensureSpots(bookSymbols(book(accountId), list.map((x) => x.order.symbol)));
      const st = book(accountId);
      const before = usedMargin(st);
      const after = usedMargin(st, null, list);
      const legs = list.map(({ order: o, price }) => legOf(o.symbol, o.side === "BUY" ? o.quantity : -o.quantity, price)).filter(Boolean);
      const ctx = marginCtx(legs);
      const alone = portfolioMargin(legs, ctx);
      const nonFo = list.filter(({ order: o }) => !legOf(o.symbol, 1, 0)).reduce((a, { order, price }) => a + orderBlock(st, order, price), 0);
      const naked = portfolio ? standaloneMargin(legs, ctx) + nonFo : list.reduce((a, { order, price }) => a + orderBlock(st, order, price), 0);
      const r = round2;
      return {
        model: portfolio ? "portfolio" : "simple",
        before: r(before),
        after: r(after),
        change: r(after - before),
        alone: r(portfolio ? alone.required + nonFo : naked),
        standalone: r(naked),
        breakdown: { premium: r(alone.premium), span: r(alone.span), exposure: r(alone.exposure), calendar: r(alone.calendar), elm: r(alone.elm) },
        forwards: Object.fromEntries(Object.entries(ctx.forwards).map(([k, v]) => [k, r(v)])),
        fallback: alone.groups.filter((g) => g.fallback).map((g) => g.underlying),
        available: r(availableCash(st)),
        method: portfolio ? SPAN_METHOD : "Simple per-leg model: premium for buys, a percentage of contract value for sells and futures.",
      };
    },


    /** One order, or null. */
    async order(accountId, orderId) {
      const st = book(accountId);
      const o = st.orders.find((x) => x.orderId === orderId);
      return o ? project(o) : null;
    },

    /** Orders, newest first, with an optional status filter. */
    async orders(accountId, { status, limit, cursor } = {}) {
      const st = book(accountId);
      if (status !== undefined && !ORDER_STATUSES.includes(status)) throw badInput(`status must be one of ${ORDER_STATUSES.join(", ")}.`, "status");
      const list = status ? st.orders.filter((o) => o.status === status) : st.orders;
      const page = paginate(list, { limit, cursor });
      return { items: page.items.map(project), nextCursor: page.nextCursor };
    },

    /** Trades, newest first. */
    async trades(accountId, { limit, cursor } = {}) {
      const st = book(accountId);
      const page = paginate(st.trades, { limit, cursor });
      return { items: page.items.map((tr) => ({ ...tr })), nextCursor: page.nextCursor };
    },

    /** Today's positions (open, and closed during the day), marked to the latest price. */
    async positions(accountId) {
      await markPositions(book(accountId));
      const st = book(accountId);
      return Object.values(st.positions).map((p) => {
        const { ltp, unrealised } = unrealisedOf(p);
        return {
          accountId,
          mode: "paper",
          symbol: p.symbol,
          exchange: p.exchange,
          product: p.product,
          netQty: p.netQty,
          avgPrice: round4(p.avgPrice),
          ltp,
          pnl: round2(p.realisedPnl + unrealised),
          realisedPnl: round2(p.realisedPnl),
          unrealisedPnl: round2(unrealised),
          buyQty: p.buyQty,
          sellQty: p.sellQty,
          buyAvg: p.buyQty ? round4(p.buyValue / p.buyQty) : null,
          sellAvg: p.sellQty ? round4(p.sellValue / p.sellQty) : null,
          // Day view: buys and sells today, what was carried in and its previous close, and today's P&L from them.
          overnightQty: p.overnightQty ?? 0,
          prevClose: p.overnightQty ? (p.prevClose ?? null) : null,
          dayPnl: p.netQty !== 0 && (ltp === null || ltp === undefined) ? null : round2(p.sellValue - p.buyValue + p.netQty * (ltp ?? 0) - (p.overnightQty ?? 0) * (p.prevClose ?? 0)),
        };
      });
    },

    /** Funds: cash, blocked margin and P&L since the last reset (realised is cumulative; charges are separate). */
    async funds(accountId) {
      await markPositions(book(accountId));
      await ensureSpots(bookSymbols(book(accountId)));
      const st = book(accountId);
      const used = usedMargin(st);
      const unrealised = Object.values(st.positions).reduce((s, p) => s + unrealisedOf(p).unrealised, 0);
      const available = st.startingCapital + st.realisedTotal - st.charges - used;
      return {
        availableCash: round2(available),
        usedMargin: round2(used),
        totalBalance: round2(st.startingCapital + st.realisedTotal - st.charges + unrealised),
        realisedPnl: round2(st.realisedTotal),
        unrealisedPnl: round2(unrealised),
        charges: round2(st.charges),
        collateral: null,
        withdrawable: round2(Math.max(0, available)),
      };
    },

    /**
     * Take today's P&L snapshot now (marked to the latest prices). It replaces an earlier manual one for today; it
     * never replaces today's end-of-day row, which it returns instead.
     */
    async snapshot(accountId) {
      await markPositions(book(accountId));
      await ensureSpots(bookSymbols(book(accountId)));
      const st = book(accountId);
      const row = takeSnapshot(st, "manual", now());
      save(st);
      return { ...row };
    },

    /** The daily P&L snapshots, oldest first (up to DAILY_KEPT days). */
    async daily(accountId) {
      const st = book(accountId);
      return (st.daily ?? []).map((x) => ({ ...x }));
    },

    /** Account summary (PaperAccount without funds and fillModel, which the route adds). */
    async account(accountId) {
      const st = book(accountId);
      return { accountId, startingCapital: st.startingCapital, createdAt: st.createdAt, resetAt: st.resetAt, ordersToday: st.ordersToday };
    },

    /** Clear orders, trades and positions and start again. Pending orders are reported as cancelled first. */
    async reset(accountId, { startingCapital } = {}) {
      const st = book(accountId);
      const capital = startingCapital ?? cfg.startingCapital;
      if (typeof capital !== "number" || !Number.isFinite(capital) || capital < CAPITAL_MIN || capital > CAPITAL_MAX) {
        throw badInput(`startingCapital must be from ${CAPITAL_MIN} to ${CAPITAL_MAX} rupees.`, "startingCapital");
      }
      const t = now();
      // Kept for UNDO_RESET_MS so the dashboard's Undo can put the book back (pending orders stay cancelled).
      const before = structuredClone(st);
      for (const o of st.orders) if (isPending(o)) setStatus(o, "cancelled", "Cancelled by a paper account reset.", t);
      for (const o of before.orders) if (isPending(o)) Object.assign(o, { status: "cancelled", statusMessage: "Cancelled by a paper account reset.", updatedAt: toIstIso(t) });
      undo.set(accountId, { state: before, at: t });
      const fresh = freshState(accountId, capital, st.createdAt, toIstIso(t));
      // The daily P&L history is a record of what happened, not part of the book: it survives a reset.
      fresh.daily = [...(st.daily ?? [])];
      books.set(accountId, fresh);
      save(fresh);
    },

    /**
     * Put back the book from before the last reset, within UNDO_RESET_MS and only while the fresh book is untouched
     * (no order placed since). Orders that were pending stay cancelled. Throws INVALID_ORDER otherwise.
     */
    async undoReset(accountId) {
      const st = book(accountId);
      const u = undo.get(accountId);
      if (!u || now() - u.at > UNDO_RESET_MS) throw invalid("There is no recent reset to undo on this paper account.");
      if (st.orders.length || st.trades.length) throw invalid("Orders were placed after the reset, so it can no longer be undone.");
      undo.delete(accountId);
      const back = { ...u.state, resetAt: u.state.resetAt ?? null };
      rollDay(back);
      books.set(accountId, back);
      save(back);
    },

    // ── internal (not part of the contract) ──

    /** Restore every configured account that has a saved book, listen to ticks and start the poll timer. Idempotent. */
    start() {
      for (const a of config?.accounts ?? []) {
        try {
          if (ACCOUNT_ID_RE.test(a.id) && accountKnown(a.id)) book(a.id, { onlyIfSaved: true });
        } catch (err) {
          log?.error?.("paper book could not be loaded", { accountId: a.id, err });
        }
      }
      if (!offTick && bus) offTick = bus.on("tick", (tick) => engine.handleTick(tick));
      if (!interval) interval = timers.setInterval(() => void engine.runOnce(), cfg.pollIntervalMs);
    },

    /** Stop listening and polling, and save each book once more so the latest position marks survive a restart. */
    stop() {
      for (const st of books.values()) save(st);
      if (offTick) offTick();
      offTick = null;
      if (interval) timers.clearInterval(interval);
      interval = null;
    },

    /**
     * Apply a `tick` event: remember the price for symbols a book cares about and evaluate pending orders on it.
     * @param {{ symbol: string, ltp: number, bid?: number, ask?: number }} tick
     */
    handleTick(tick) {
      if (!tick || typeof tick.symbol !== "string" || !interest.has(tick.symbol)) return;
      const entry = notePrice(tick.symbol, tick);
      if (entry) evaluateSymbol(tick.symbol, entry);
    },

    /** One maintenance pass: day roll, square-off, session-end expiry, then re-price pending orders. */
    async runOnce() {
      if (running) return;
      running = true;
      try {
        for (const st of [...books.values()]) {
          let changed = rollDay(st);
          if (await squareOff(st)) changed = true;
          if (expireDayOrders(st, now())) changed = true;
          const t = now();
          if (t >= sessionEndAt("NSE", t) && !(st.daily ?? []).some((x) => x.day === istDay(t) && x.source === "eod") && (st.trades.length || Object.keys(st.positions).length)) {
            takeSnapshot(st, "eod", t);
            changed = true;
          }
          if (changed && books.get(st.accountId) === st) save(st);
        }
        await pollPending();
      } catch (err) {
        log?.error?.("paper maintenance failed", { err });
      } finally {
        running = false;
      }
    },
  };
  return engine;
}
