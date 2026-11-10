/**
 * OrderService (docs/ARCHITECTURE.md §4, §7, §8). The contract is
 * SERVICE_CONTRACTS.orders in ../core/contracts.mjs. This is the only path to an order, paper or live.
 *
 * place():
 *   validate (zod, no default product/order type) → idempotency (Idempotency-Key, or clientOrderId when the header is
 *   absent; replay / 409) → reserve clientOrderId → resolve instrument (lot, tick, freeze) → quantity → mode decision
 *   (modeDecision.mjs: triple opt-in + live scope + allowed source + explicit mode "live" + human confirmation for AI
 *   and confirmation-required hooks; a live request that misses any is refused, never downgraded) → pre-trade checks
 *   → market-order policy → SafetyGuard.check → then
 *     paper: PaperEngine.place
 *     live:  order record saved to disk first → audit (must succeed) → per leg: SafetyGuard.acquireOrderSlot →
 *            Scheduler.schedule({ endpointClass: "order", priority: "order" }) → inside the slot: creds, mint ONE gate
 *            (issueOrderGate, 5 s TTL, so it is minted right before the call rather than before the queue wait) →
 *            adapter.placeOrder(creds, payload, lotSize, gate) with a timeout → fromBrokerError(..., { write: true }).
 *   A write that times out or fails without a clear refusal is never retried: its leg becomes outcome_unknown, the
 *   caller gets 504 OUTCOME_UNKNOWN naming the order id, and the reconciliation job looks for it in the broker order
 *   book (reconcile.mjs). A late answer from the adapter also resolves it.
 *
 * modify()/cancel(): same idempotency and audit; every modify (paper and live) passes SafetyGuard.check with the
 *   same per-order inputs as a place (modifyShape: lots, value, price band, market policy, freeze); a live modify also
 *   needs the live opt-ins;
 *   cancels are never blocked by the kill switch or limits (they only reduce risk) but each counts towards the
 *   order-rate cap. AI assistants may cancel but not change live orders.
 * cancelAll(): every open order (paper book, and the broker's own order book for live) on the accounts the caller
 *   may use; run automatically when SafetyGuard emits safety.kill_switch with cancelOpenOrders.
 * Portfolio reads (positions, holdings, funds, trades, order book refreshes) go through the scheduler's "portfolio"
 *   class and are never cached (identical concurrent reads may share one in-flight call).
 *
 * Persistence: <dataDir>/orders/state.json (idempotency records, clientOrderId map, live order records) written
 * atomically after every change. Nothing here logs, stores or returns a credential.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { issueOrderGate } from "../../brokers/orderGate.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError, ERROR_CODES, fromBrokerError } from "../core/errors.mjs";
import { isAutomatedContext } from "../core/context.mjs";
import { deliveryMarginOf, expiryDay, moneynessOf, obligationOf } from "../calc/expiry-costs.js";
import { strikeStepOf } from "../market/chain.mjs";
import { trustedLtp } from "../market/trusted.mjs";
import { assertLiveSupport, liveSupport, unverifiedWarning } from "./brokerOrders.mjs";
import { ordersConfig } from "./config.mjs";
import { createIdempotencyStore } from "./idempotencyStore.mjs";
import { AUTOMATED_SOURCES, decideMode, effectiveSource } from "./modeDecision.mjs";
import {
  ACCOUNT_RE,
  IDEMPOTENCY_KEY_RE,
  TERMINAL_STATUSES,
  applyMarketPolicy,
  blocking,
  checkInstrumentOrder,
  fingerprint,
  isMultipleOf,
  orderBody,
  parseOrderChanges,
  parseOrderRequest,
  resolveQuantity,
  roundToTick,
  sortByPriority,
} from "./orderValidation.mjs";
import { bridgeStatus, mapRows, symbolFor, toFunds, toHolding, toPosition, toTrade, unwrap } from "./portfolio.mjs";
import { findLegInBook } from "./reconcile.mjs";
import { isDiskFull } from "../../lib/storageHealth.mjs";
import { createStateFile } from "./stateFile.mjs";
import { REJECT_REASON_MAX, createTicketBook } from "./tickets.mjs";
import { DAY_MS, istDay, istIso } from "./time.mjs";

const TIMEOUT = Symbol("orders.timeout");
const OPEN_BOOK_STATUSES = new Set(["OPEN", "TRIGGER_PENDING", "PARTIALLY_FILLED"]);
const MAX_PAGE = 500;
/** Epoch ms of an ISO timestamp in any offset (0 when missing or unparsable), for sorting. */
const timeOf = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
};
/** The gate verdict for cancels: cancels are deliberately not subject to SafetyGuard.check (see header). */
const CANCEL_VERDICT = Object.freeze({ ok: true, mode: "live", reasons: [], warnings: [] });

/**
 * @typedef {import("../core/contracts.mjs").OrderResult} OrderResult
 * @typedef {import("../core/context.mjs").RequestContext} RequestContext
 * @typedef {{ order: OrderResult & { warnings?: string[] }, x: {
 *   ref: { token: string, exchange: string, tradingSymbol: string | null }, lotSize: number, tickSize: number,
 *   brokerTag: string | null, keyId: string | null, principal: string, modifications: number, marketProtectionPct: number | null,
 *   legs: Array<{ invoked: boolean, sentAt: number | null, gaveUp?: boolean, ambiguous?: boolean }> } }} LiveRecord
 */

/**
 * @param {object} deps  core deps + accounts, scheduler, symbols, safety, audit, paper, marketData
 * @returns {object} OrderService (contract methods + close(), reconcileNow() helpers)
 */
export function createOrderService(deps) {
  const { config, logger, bus, clock } = deps;
  const cfg = ordersConfig(config);
  const log = logger.child({ module: "orders" });
  const now = () => clock.now();
  const timers = {
    set:
      typeof clock.setTimeout === "function"
        ? (fn, ms) => clock.setTimeout(fn, ms)
        : (fn, ms) => {
            const h = setTimeout(fn, ms);
            h.unref?.();
            return h;
          },
    clear: typeof clock.clearTimeout === "function" ? (h) => clock.clearTimeout(h) : (h) => clearTimeout(h),
  };
  const sleep = (ms) => new Promise((r) => timers.set(r, ms));

  const idem = createIdempotencyStore({ now });
  const tickets = createTicketBook({ now, ticketTtlMs: cfg.ticketTtlMs, confirmTokenTtlMs: cfg.confirmTokenTtlMs });
  const dataDir = deps.paths?.dataDir ?? config?.dataDir ?? null;
  const stateFile = dataDir ? createStateFile(join(dataDir, "orders", "state.json"), { logger: log, now }) : null;

  /** @type {Map<string, LiveRecord>} live orders by Bridge id */
  const live = new Map();
  /** paper order id -> account id (orders placed through this service) */
  const paperOwners = new Map();
  let closed = false;
  let reconcileTimer = null;

  /** The context used for work the Bridge does on its own (kill switch, reconciliation). */
  const systemCtx = {
    requestId: null,
    source: "system",
    principal: { kind: "local", id: "cli" },
    key: null,
    scopes: new Set(["read", "paper", "live", "admin"]),
    loopback: true,
    requireAccountAccess() {},
    requireScope() {},
    signal: new AbortController().signal,
    log,
  };

  // ───────────────────────────── persistence ─────────────────────────────

  function pruneOrders() {
    const cutoff = now() - cfg.orderRetentionDays * DAY_MS;
    for (const [id, rec] of live) {
      const t = Date.parse(rec.order.placedAt);
      if (Number.isFinite(t) && t < cutoff && TERMINAL_STATUSES.has(rec.order.status)) live.delete(id);
    }
    if (paperOwners.size > 20_000) for (const k of [...paperOwners.keys()].slice(0, paperOwners.size - 20_000)) paperOwners.delete(k);
  }

  /** @returns {boolean} written (true when there is no data dir: memory only) */
  function persist() {
    if (!stateFile) return true;
    idem.prune();
    pruneOrders();
    return stateFile.write({ savedAt: istIso(now()), idempotency: idem.dump(), orders: [...live.values()], paperOwners: [...paperOwners] });
  }

  function load() {
    const saved = stateFile?.read();
    if (!saved) return;
    idem.load(saved.idempotency);
    for (const [k, v] of saved.paperOwners ?? []) paperOwners.set(k, v);
    let interrupted = 0;
    for (const rec of saved.orders ?? []) {
      if (!rec?.order?.orderId || !rec.x || !Array.isArray(rec.order.legs)) continue;
      rec.x.legs ??= [];
      rec.order.legs.forEach((leg, i) => {
        const xl = rec.x.legs[i] ?? (rec.x.legs[i] = { invoked: false, sentAt: null });
        if (leg.status === "pending" && !leg.brokerOrderId) {
          if (xl.invoked) {
            leg.status = "outcome_unknown";
            leg.error = { code: "OUTCOME_UNKNOWN", message: "The Bridge stopped while this order was being sent." };
          } else {
            leg.status = "rejected";
            leg.error = { code: "INTERNAL", message: "The Bridge stopped before this order was sent. Nothing was sent." };
          }
          interrupted += 1;
        }
      });
      recompute(rec);
      live.set(rec.order.orderId, rec);
    }
    pruneOrders();
    if (interrupted) log.warn("orders interrupted by a restart were marked", { count: interrupted });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  const principalKey = (ctx) => `${ctx.principal?.kind ?? "anonymous"}:${ctx.principal?.id ?? "anonymous"}`;
  const actorOf = (ctx) => (ctx.source === "system" ? { kind: "system", id: "bridge" } : { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" });
  const clone = (o) => structuredClone(o);

  function canAccess(ctx, accountId) {
    try {
      ctx.requireAccountAccess(accountId);
      return true;
    } catch {
      return false;
    }
  }

  function accountFor(ctx, accountId) {
    ctx.requireAccountAccess(accountId);
    const summary = deps.accounts.get(accountId);
    const accountCfg = (config?.accounts ?? []).find((a) => a.id === accountId);
    return { summary, accountCfg };
  }

  function accessibleAccounts(ctx) {
    return deps.accounts.list().filter((a) => canAccess(ctx, a.id));
  }

  /** Append to the audit log. `required`: throw (so a live order is not sent) when the log is unavailable. */
  async function audit(ctx, type, { accountId = null, data, required = false } = {}) {
    try {
      await deps.audit.append({ type, actor: actorOf(ctx), source: ctx.source, accountId, requestId: ctx.requestId ?? null, data });
      return true;
    } catch (err) {
      log.error("audit append failed", { type, code: err?.code ?? "ERROR" });
      // A live order is never sent without its audit record: if it cannot be written, nothing goes out.
      if (required) throw saveFailure("The audit log could not be written, so the live order was not sent.", err);
      return false;
    }
  }

  function emitUpdate(order) {
    try {
      bus.emit("order.updated", {
        orderId: order.orderId,
        clientOrderId: order.clientOrderId ?? undefined,
        accountId: order.accountId,
        mode: order.mode,
        status: order.status,
        brokerStatus: order.brokerStatus ?? undefined,
        filledQuantity: order.filledQuantity ?? 0,
        avgPrice: order.avgPrice ?? undefined,
        source: order.source,
      });
    } catch (err) {
      log.warn("order.updated emit failed", { err: String(err?.message ?? err) });
    }
  }

  function recordEvent(accountId, event) {
    try {
      deps.safety.recordOrderEvent(accountId, event);
    } catch (err) {
      log.warn("safety.recordOrderEvent failed", { code: err?.code ?? "ERROR" });
    }
  }

  /**
   * The last price an order may be checked against (price band, market protection, strike choice): a trusted real-time
   * value only. The read says purpose "order", so the market service never answers it from a stale cache entry, a data
   * source or a revalidating answer; trustedLtp() then refuses anything still labelled stale, delayed, end-of-day,
   * unofficial or from a plugin. Null means "no price I can rely on", and the callers treat that as unchecked, never as a price.
   */
  async function ltpOf(symbol) {
    try {
      const r = await deps.marketData.ltp([symbol], { maxAgeMs: 2000, priority: "live", purpose: "order" });
      return trustedLtp(r?.items?.find((i) => i?.symbol === symbol) ?? r?.items?.[0]);
    } catch {
      return null;
    }
  }

  /**
   * Read today's P&L for a live account from the broker's positions (realised plus open mark-to-market) and hand it
   * to SafetyGuard, so dailyMaxLoss works for live accounts. When it cannot be read the order is not blocked, but
   * the caller is told plainly that the loss limit was not checked.
   */
  async function syncLivePnl(summary, checks, readPositions = null) {
    if (typeof deps.safety.syncDayPnl !== "function") return;
    let adapter = null;
    try {
      adapter = deps.accounts.adapter(summary.id);
    } catch {
      /* reported elsewhere */
    }
    const unchecked = (why) => checks.push({ code: "SAFETY_WARNING", message: `Today's loss on ${summary.id} could not be read from the broker (${why}), so the daily loss limit was not checked for this order.`, severity: "warn" });
    if (!adapter || typeof adapter.fetchPositions !== "function") return unchecked("this adapter cannot read positions");
    try {
      const { data } = readPositions ? await readPositions() : await brokerRead(summary.id, "fetchPositions", [], "positions", { priority: "order" });
      let total = 0;
      for (const row of Array.isArray(data) ? data : []) {
        const pnl = Number(row?.pnl);
        const parts = Number(row?.realisedPnl ?? 0) + Number(row?.unrealisedPnl ?? 0);
        const v = Number.isFinite(pnl) && row?.pnl !== null && row?.pnl !== undefined ? pnl : parts;
        if (Number.isFinite(v)) total += v;
      }
      deps.safety.syncDayPnl(summary.id, "live", Math.round(total * 100) / 100);
    } catch (err) {
      unchecked(err?.code ?? "read failed");
    }
  }

  /** A BridgeError for the first (most important) block check, listing all of them. */
  function refusalError(blocks) {
    const first = blocks[0];
    const code = ERROR_CODES[first.code] ? first.code : "INVALID_ORDER";
    return new BridgeError(code, first.message, { errors: blocks.map((b) => ({ path: b.path ?? b.code, message: b.message })) });
  }

  /** deps.readiness when the readiness module runs (not a stub); null otherwise (back-compat: no readiness line). */
  const readinessService = () => {
    try {
      const r = deps.readiness;
      return r && !isStub(r) && typeof r.canTrade === "function" ? r : null;
    } catch {
      return null;
    }
  };

  /**
   * The readiness line for a LIVE order, checked before safety.check:
   *  - automated sources (webhook, system, guard, alert) with readiness.gateAutomated: refused with CANNOT_TRADE while
   *    the account cannot trade, or when its state is still unknown or stale after ensureFresh (5 s at most). No
   *    safety slot is taken and no broker call is made.
   *  - everyone else (a person): a READINESS warning when the account is cannot_trade or warn.
   * @returns {Promise<{ code: string, message: string, severity: "block"|"warn", path?: string } | null>}
   */
  async function readinessLine(ctx, accountId) {
    const r = readinessService();
    if (!r) return null;
    let v;
    try {
      v = r.canTrade(accountId, { mode: "live" });
    } catch (err) {
      log.warn("readiness could not be read for an order", { accountId, code: err?.code });
      return null;
    }
    if (!v || v.disabled) return null;
    const why = (x) => (x.reasons ?? []).filter((y) => y.severity === "fail" || x.state !== "cannot_trade").map((y) => y.message).slice(0, 3).join("; ") || "no reason given";
    const label = (state) => (state === "cannot_trade" ? "cannot trade" : state === "unknown" ? "not checked" : state);
    const gate = config?.readiness?.gateAutomated !== false;
    if (gate && AUTOMATED_SOURCES.includes(effectiveSource(ctx))) {
      if (v.stale || v.state === "unknown") {
        try {
          v = await r.ensureFresh(accountId, { timeoutMs: 5000 });
        } catch (err) {
          log.warn("readiness could not be refreshed for an automated order", { accountId, code: err?.code });
        }
      }
      if (v.state === "cannot_trade" || v.state === "unknown" || v.stale) {
        const first = (v.reasons ?? []).find((y) => y.severity === "fail") ?? (v.reasons ?? [])[0];
        const message =
          v.state === "cannot_trade"
            ? `Readiness: ${accountId} cannot trade right now (${why(v)}). Automated live orders are paused for this account; nothing was sent.`
            : `Readiness: ${accountId} could not be checked just now, so this automated live order was not sent.`;
        return { code: "CANNOT_TRADE", message, severity: "block", path: `readiness.${first?.check ?? "state"}` };
      }
      if (v.state === "warn") return { code: "READINESS", message: `Readiness: ${label(v.state)}: ${why(v)}`, severity: "warn" };
      return null;
    }
    if (v.state === "cannot_trade" || v.state === "warn") return { code: "READINESS", message: `Readiness: ${label(v.state)}: ${why(v)}`, severity: "warn" };
    return null;
  }

  const verdictError = (verdict) => refusalError(sortByPriority((verdict?.reasons?.length ? verdict.reasons : [{ code: "INVALID_ORDER", message: "The safety check did not pass." }]).map((r) => ({ ...r, severity: "block" }))));

  /** Race a promise against the live-call timeout. Late outcomes go to onLate(value, error). */
  function withTimeout(promise, ms, onLate) {
    return new Promise((resolve, reject) => {
      let done = false;
      const h = timers.set(() => {
        if (done) return;
        done = true;
        reject(TIMEOUT);
      }, ms);
      Promise.resolve(promise).then(
        (v) => {
          if (done) return onLate?.(v, null);
          done = true;
          timers.clear(h);
          resolve(v);
        },
        (e) => {
          if (done) return onLate?.(null, e);
          done = true;
          timers.clear(h);
          reject(e);
        },
      );
    });
  }

  /** Take an order-rate slot, waiting up to maxWaitMs in total. */
  async function acquireSlot(accountId, maxWaitMs) {
    let waited = 0;
    for (;;) {
      const s = deps.safety.acquireOrderSlot(accountId);
      if (s?.ok) return { ok: true, retryAfterMs: 0 };
      const wait = Math.max(50, Number(s?.retryAfterMs) || 200);
      if (waited + wait > maxWaitMs) return { ok: false, retryAfterMs: wait };
      await sleep(wait);
      waited += wait;
    }
  }

  /**
   * Re-check, at the moment of sending, what may have changed while a write waited in the scheduler queue: the kill
   * switch, and then take the order-rate slot. Taking the slot HERE (not before the queue wait) means the cap counts
   * actual sends: orders that piled up behind a broker 429 back-off cannot all go out together above the cap.
   * Throws a BridgeError (nothing has been sent yet).
   * @param {string} accountId
   * @param {{ killSwitch: boolean, slotWaitMs: number }} opts
   */
  async function sendGate(accountId, { killSwitch, slotWaitMs }) {
    if (killSwitch) {
      const ks = deps.safety.killSwitchStatus?.();
      if (ks?.engaged) throw new BridgeError("KILL_SWITCH_ACTIVE", `The kill switch was turned on while this order was waiting${ks.reason ? ` (${ks.reason})` : ""}. It was not sent.`);
    }
    const slot = await acquireSlot(accountId, slotWaitMs);
    if (!slot.ok) throw new BridgeError("ORDER_RATE_LIMITED", `The order-rate cap for ${accountId} was reached. Try again in a moment.`, { retryAfterMs: slot.retryAfterMs });
  }

  const freshness = (source, at, accountId, broker) => ({ source, asOf: istIso(at), ageMs: 0, stale: false, accountId, broker });

  // ───────────────────────────── order records ─────────────────────────────

  /** Recompute order-level fields from the legs. @returns {boolean} whether status/fill changed */
  function recompute(rec) {
    const o = rec.order;
    const before = `${o.status}|${o.filledQuantity}|${o.avgPrice}|${o.brokerStatus}`;
    const legs = o.legs;
    let filled = 0;
    let value = 0;
    let valueQty = 0;
    for (const l of legs) {
      const fq = l.filledQuantity ?? (l.status === "filled" ? l.quantity : 0);
      filled += fq;
      if (fq > 0 && Number.isFinite(l.avgPrice)) {
        value += fq * l.avgPrice;
        valueQty += fq;
      }
    }
    o.filledQuantity = filled;
    o.avgPrice = valueQty > 0 ? Number((value / valueQty).toFixed(4)) : null;
    const st = legs.map((l) => l.status);
    const open = ["pending", "open", "trigger_pending", "partially_filled"];
    if (st.includes("outcome_unknown")) o.status = "outcome_unknown";
    else if (st.some((s) => open.includes(s))) {
      if (filled > 0) o.status = "partially_filled";
      else if (st.includes("open")) o.status = "open";
      else if (st.includes("trigger_pending")) o.status = "trigger_pending";
      else o.status = "pending";
    } else if (st.every((s) => s === "filled")) o.status = "filled";
    else o.status = st.find((s) => s !== "filled") ?? "rejected";
    const bs = [...new Set(legs.map((l) => l.brokerStatus).filter(Boolean))];
    o.brokerStatus = bs.length ? bs.join(",") : null;
    const msg = legs.map((l) => l.statusMessage ?? l.error?.message).find(Boolean);
    if (msg) o.statusMessage = msg;
    const after = `${o.status}|${o.filledQuantity}|${o.avgPrice}|${o.brokerStatus}`;
    if (after !== before) o.updatedAt = istIso(now());
    return after !== before;
  }

  /** Public view of a live order (internal leg fields stripped). */
  const publicOrder = (rec) => {
    const o = clone(rec.order);
    o.legs = o.legs.map(({ brokerOrderId, quantity, status, error }) => ({ brokerOrderId, quantity, status, error }));
    return o;
  };

  function applyBookRow(rec, i, row) {
    const leg = rec.order.legs[i];
    leg.status = bridgeStatus(row.status);
    leg.brokerStatus = row.status ?? null;
    leg.filledQuantity = Number.isFinite(Number(row.filledQty)) ? Number(row.filledQty) : leg.filledQuantity ?? 0;
    leg.avgPrice = Number(row.avgPrice) > 0 ? Number(row.avgPrice) : leg.avgPrice ?? null;
    leg.statusMessage = row.statusMessage ?? null;
    leg.error = leg.status === "rejected" ? { code: "UPSTREAM_ERROR", message: row.statusMessage ?? "Rejected by the broker." } : null;
  }

  // ───────────────────────────── broker reads ─────────────────────────────

  async function brokerRead(accountId, method, aliases, what, { priority = "interactive", coalesce = true } = {}) {
    const summary = deps.accounts.get(accountId);
    try {
      // Coalesced reads hand the SAME result to every waiter: give each caller its own copy so one caller that sorts
      // or annotates rows cannot change what another caller sees.
      return structuredClone(await deps.scheduler.schedule(
        { accountId, endpointClass: "portfolio", priority, coalesceKey: coalesce ? `${method}:${accountId}` : undefined },
        async () => {
          const adapter = deps.accounts.adapter(accountId);
          const name = [method, ...aliases].find((m) => typeof adapter[m] === "function");
          if (!name) throw new BridgeError("CAPABILITY_UNSUPPORTED", `The ${summary.broker} adapter cannot read ${what}.`);
          const creds = await deps.accounts.creds(accountId);
          return { data: unwrap(await adapter[name](creds), what), at: now(), broker: summary.broker };
        },
      ));
    } catch (err) {
      throw fromBrokerError(err, { brokerId: summary.broker });
    }
  }

  const readBook = (accountId, priority) => brokerRead(accountId, "fetchOrderBook", ["getOrders"], "the order book", { priority });

  /** Index broker order id -> Bridge order id for one account. */
  function brokerIndex(accountId) {
    const m = new Map();
    for (const rec of live.values()) {
      if (rec.order.accountId !== accountId) continue;
      for (const l of rec.order.legs) if (l.brokerOrderId) m.set(String(l.brokerOrderId), rec.order.orderId);
    }
    return m;
  }

  /** Apply a fresh order book to this account's Bridge orders and reconcile outcome_unknown legs. */
  function applyBook(accountId, book) {
    const rows = new Map((Array.isArray(book) ? book : []).map((r) => [String(r.orderId), r]));
    const claimed = new Set(brokerIndex(accountId).keys());
    let dirty = false;
    for (const rec of live.values()) {
      if (rec.order.accountId !== accountId) continue;
      let changed = false;
      rec.order.legs.forEach((leg, i) => {
        if (leg.brokerOrderId && rows.has(String(leg.brokerOrderId))) {
          applyBookRow(rec, i, rows.get(String(leg.brokerOrderId)));
          changed = true;
          return;
        }
        const xl = rec.x.legs[i];
        if (leg.status !== "outcome_unknown" || xl?.gaveUp || !xl?.sentAt) return;
        const { match, candidates } = findLegInBook(
          { ref: rec.x.ref, side: rec.order.side, quantity: leg.quantity, orderType: rec.order.orderType, price: rec.order.price, sentAt: xl.sentAt, tickSize: rec.x.tickSize },
          book,
          claimed,
        );
        if (match) {
          leg.brokerOrderId = String(match.orderId);
          claimed.add(leg.brokerOrderId);
          applyBookRow(rec, i, match);
          xl.ambiguous = false;
          changed = true;
          log.info("outcome_unknown order found in the broker order book", { orderId: rec.order.orderId, leg: i });
          audit(systemCtx, "order.reconciled", { accountId, data: { orderId: rec.order.orderId, leg: i, brokerOrderId: leg.brokerOrderId, status: leg.status } });
        } else if (candidates > 1 && !xl.ambiguous) {
          xl.ambiguous = true;
          leg.statusMessage = `${candidates} broker orders look like this one, so the Bridge cannot tell which it is. Check the broker app.`;
          changed = true;
        }
      });
      if (changed) {
        dirty = true;
        if (recompute(rec)) emitUpdate(rec.order);
      }
    }
    if (dirty) persist();
  }

  async function refreshAccount(accountId, priority = "interactive") {
    const { data } = await readBook(accountId, priority);
    applyBook(accountId, data);
    return data;
  }

  // ───────────────────────────── reconciliation job ─────────────────────────────

  const unknownAccounts = () => {
    const s = new Set();
    for (const rec of live.values()) {
      rec.order.legs.forEach((l, i) => {
        if (l.status === "outcome_unknown" && !rec.x.legs[i]?.gaveUp) s.add(rec.order.accountId);
      });
    }
    return s;
  };

  function scheduleReconcile() {
    if (reconcileTimer || closed) return;
    reconcileTimer = timers.set(async () => {
      reconcileTimer = null;
      try {
        await reconcileNow();
      } catch (err) {
        log.warn("reconciliation pass failed", { code: err?.code ?? "ERROR" });
      }
      if (unknownAccounts().size) scheduleReconcile();
    }, cfg.reconcileIntervalMs);
  }

  /**
   * One reconciliation pass over every account with outcome_unknown legs (also run by the timer).
   * @returns {Promise<{ accounts: number, unknown: number }>}
   */
  async function reconcileNow() {
    const accounts = [...unknownAccounts()];
    for (const accountId of accounts) {
      try {
        await refreshAccount(accountId, "live");
      } catch (err) {
        log.warn("order book read for reconciliation failed", { accountId, code: err?.code ?? "ERROR" });
      }
    }
    const t = now();
    let unknown = 0;
    for (const rec of live.values()) {
      rec.order.legs.forEach((leg, i) => {
        const xl = rec.x.legs[i];
        if (leg.status !== "outcome_unknown" || xl.gaveUp) return;
        if (xl.sentAt && t - xl.sentAt > cfg.reconcileGiveUpMs) {
          xl.gaveUp = true;
          leg.statusMessage = "The Bridge could not find this order in the broker's order book. It may or may not have been placed: check the broker app before sending it again.";
          recompute(rec);
          persist();
          audit(systemCtx, "order.reconcile_gave_up", { accountId: rec.order.accountId, data: { orderId: rec.order.orderId, leg: i } });
        } else unknown += 1;
      });
    }
    return { accounts: accounts.length, unknown };
  }

  // ───────────────────────────── preparation (shared by preview and place) ─────────────────────────────

  /**
   * Resolve, size and check an order. Never sends anything.
   * @param {RequestContext} ctx
   * @param {object} body  OrderRequest without confirmToken
   * @param {{ confirmToken?: string, forPlace: boolean }} opts
   */
  async function prepare(ctx, body, { confirmToken, ticketId, forPlace }) {
    const { summary, accountCfg } = accountFor(ctx, body.account);
    const decision = decideMode({ config, accountCfg, summary, requested: body.mode, ctx, confirmPaperFromMcp: cfg.confirmPaperFromMcp });
    const checks = [...decision.refusals];
    const wantsLive = decision.requested === "live" && summary.broker !== "paper";
    const p = {
      summary,
      accountCfg,
      decision,
      mode: decision.mode,
      checks,
      fp: fingerprint(body),
      resolved: null,
      ref: null,
      quantity: null,
      legs: [],
      ltp: null,
      effective: null,
      marketProtectionPct: null,
      estimatedValue: null,
      mapper: null,
      verdict: null,
      needsConfirmation: decision.needsConfirmation,
      confirmed: false,
      blocks: [],
    };
    const finish = () => {
      p.blocks = sortByPriority(blocking(checks));
      return p;
    };

    if (decision.mode === "live") {
      const line = await readinessLine(ctx, summary.id);
      if (line) checks.push(line);
      // Refused before anything else: no symbol lookup at the broker, no P&L read, no safety slot, no broker call.
      if (line?.severity === "block" && forPlace) return finish();
    }

    try {
      p.resolved = await deps.symbols.resolve(body.symbol, wantsLive ? { broker: summary.broker } : {});
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : "SYMBOL_NOT_FOUND";
      checks.push({ code: code === "VALIDATION_FAILED" ? "SYMBOL_NOT_FOUND" : code, message: err?.detail ?? `${body.symbol} could not be resolved.`, severity: "block" });
      return finish();
    }
    const resolved = p.resolved;
    const q = resolveQuantity(body, resolved);
    checks.push(...q.checks);
    p.quantity = q.quantity;
    if (q.quantity === null) return finish();
    const inst = checkInstrumentOrder(body, resolved, q.quantity, cfg);
    checks.push(...inst.checks);
    p.legs = inst.legs;
    const lotCheck = await lotSizeCheck(body, resolved);
    if (lotCheck) checks.push(lotCheck);
    // One live positions read per prepare, shared by the ban gate and syncLivePnl.
    let livePositions = null;
    const readLivePositions = () => (livePositions ??= brokerRead(summary.id, "fetchPositions", [], "positions", { priority: "order" }));
    const stock = await stockDerivativeContext(body, resolved, summary, { wantsLive, readLivePositions, checks });

    if (wantsLive) {
      let adapter = null;
      try {
        adapter = deps.accounts.adapter(summary.id);
      } catch (err) {
        checks.push({ code: "CAPABILITY_UNSUPPORTED", message: err?.detail ?? `No broker adapter for ${summary.id}.`, severity: "block" });
      }
      if (adapter) {
        const s = liveSupport(summary.broker, adapter, "placeOrder");
        if (s.problem) checks.push({ code: "CAPABILITY_UNSUPPORTED", message: s.problem, severity: "block" });
        p.mapper = s.mapper;
        const unverified = unverifiedWarning(s.mapper);
        if (unverified) checks.push({ code: "SAFETY_WARNING", message: unverified, severity: "warn" });
      }
      try {
        p.ref = resolved.refs?.[summary.broker] ?? (await deps.symbols.toBroker(resolved.canonical, summary.broker));
      } catch (err) {
        checks.push({ code: "SYMBOL_NOT_FOUND", message: err?.detail ?? `${resolved.canonical} is not in ${summary.broker}'s instrument list.`, severity: "block" });
      }
      if (p.mapper && p.ref) {
        const problem = p.mapper.unsupported({ exchange: resolved.exchange, ref: p.ref });
        if (problem) checks.push({ code: "CAPABILITY_UNSUPPORTED", message: problem, severity: "block" });
        if (body.disclosedQuantity && !p.mapper.disclosedQuantity) checks.push({ code: "DISCLOSED_QTY_NOT_SENT", message: "disclosedQuantity is not sent to this broker; the full quantity will be visible.", severity: "warn" });
      }
    }

    if (wantsLive) await syncLivePnl(summary, checks, readLivePositions);
    p.ltp = await ltpOf(resolved.canonical);
    const policy = config?.safety?.marketOrders ?? "protect";
    const defaultPct = config?.safety?.marketProtectionPct ?? 2;
    const { lots, quantity, lotSizeConfirmed, ...rest } = body;
    void lots;
    void quantity;
    void lotSizeConfirmed;
    if (wantsLive) {
      const m = applyMarketPolicy(rest, { policy, defaultPct, nativeProtection: Boolean(p.mapper?.nativeMarketProtection), ltp: p.ltp, tickSize: resolved.tickSize });
      checks.push(...m.checks);
      p.effective = m.order;
      p.marketProtectionPct = m.marketProtectionPct;
    } else {
      // Paper: the paper engine simulates MARKET orders itself; only the "reject" policy applies.
      const m = policy === "reject" ? applyMarketPolicy(rest, { policy, defaultPct, nativeProtection: true, ltp: p.ltp, tickSize: resolved.tickSize }) : { order: rest, checks: [] };
      checks.push(...m.checks);
      p.effective = m.order;
    }
    const unitPrice = p.effective.price ?? p.effective.triggerPrice ?? p.ltp;
    p.estimatedValue = Number.isFinite(unitPrice) ? Number((unitPrice * q.quantity).toFixed(2)) : null;

    if (p.needsConfirmation && (confirmToken || ticketId)) {
      const expect = { fingerprint: p.fp, accountId: summary.id, principalId: principalKey(ctx) };
      const v = confirmToken ? tickets.verify(confirmToken, expect) : tickets.verifyTicket(ticketId, expect);
      p.confirmed = v.ok;
      if (!v.ok && forPlace) checks.push({ code: "CONFIRMATION_REQUIRED", message: v.message, severity: "block" });
    } else if (p.needsConfirmation && forPlace) {
      checks.push({
        code: "CONFIRMATION_REQUIRED",
        message: "This order needs a human confirmation first. Preview it to open a ticket, confirm it in the Bridge on this computer, then send it with the confirmToken.",
        severity: "block",
      });
    }

    if (!(forPlace && blocking(checks).length)) {
      const intent = {
        accountId: summary.id,
        mode: wantsLive ? "live" : "paper",
        action: "place",
        order: { ...body, ...p.effective, quantity: q.quantity, symbol: resolved.canonical },
        source: effectiveSource(ctx),
        keyId: ctx.key?.id ?? null,
        quantity: q.quantity,
        lots: q.quantity / resolved.lotSize,
        lotSize: resolved.lotSize,
        value: p.estimatedValue,
        ltp: p.ltp,
        // A passing place check reserves a daily-count slot at once (released when the order is recorded).
        reserve: forPlace,
        // Stock derivatives carry the underlying kind; heldQty and ban only when the underlying is in ban.
        ...(stock ? { underlyingKind: stock.underlyingKind, underlying: resolved.underlying, ban: stock.ban, heldQty: stock.heldQty } : {}),
      };
      const verdict = await deps.safety.check(ctx, intent);
      p.verdict = verdict;
      // SafetyGuard re-checks live enablement; do not repeat a refusal the mode decision already reported.
      const reported = new Set(decision.refusals.map((r) => r.code));
      for (const r of verdict?.reasons ?? []) if (!reported.has(r.code)) checks.push({ code: r.code, message: r.message, severity: "block" });
      for (const w of verdict?.warnings ?? []) checks.push({ code: "SAFETY_WARNING", message: String(w), severity: "warn" });
      for (const w of verdict?.checks ?? []) checks.push({ code: w.code, message: w.message, severity: "warn" });
      if (!verdict || (verdict.ok !== true && !(verdict.reasons ?? []).length)) checks.push({ code: "INVALID_ORDER", message: "The safety check did not pass.", severity: "block" });
    }
    return finish();
  }

  // ───────────────────────────── stock derivatives ─────────────────────────────

  const kindCache = new Map();
  /** An unknown kind (master still loading, reference not built) is retried after this long, never kept for good. */
  const UNKNOWN_KIND_TTL_MS = 60_000;
  /**
   * "stock" | "index" | null for an underlying, from the master's spot row (INDEX vs EQ), else the reference universe.
   * The spot search names its cash exchange: free text alone would read an underlying named BSE or MCX as an
   * exchange filter and find nothing.
   */
  async function underlyingKindOf(underlying, exchange) {
    const key = `${exchange}|${underlying}`;
    const hit = kindCache.get(key);
    if (hit && (hit.kind !== null || now() - hit.at < UNKNOWN_KIND_TTL_MS)) return hit.kind;
    let kind = null;
    try {
      const res = await deps.symbols.search({ q: underlying, underlying, exchange: exchange === "BFO" ? "BSE" : "NSE", limit: 5 });
      const spot = (res?.items ?? []).find((r) => r?.underlying === underlying && (r.kind === "INDEX" || r.kind === "EQ"));
      if (spot) kind = spot.kind === "INDEX" ? "index" : "stock";
    } catch {
      kind = null;
    }
    if (!kind) {
      try {
        const r = referenceService();
        kind = r?.universe?.({ kind: "all" })?.items?.find((i) => i.symbol === underlying)?.kind ?? null;
      } catch {
        kind = null;
      }
    }
    kindCache.delete(key);
    kindCache.set(key, { kind, at: now() });
    if (kindCache.size > 500) kindCache.delete(kindCache.keys().next().value);
    return kind;
  }

  const referenceService = () => {
    try {
      const r = deps.reference;
      return r && !isStub(r) ? r : null;
    } catch {
      return null;
    }
  };

  /** Net held quantity of one contract in this account: paper engine (memory) or the live positions read. */
  async function heldQtyOf(summary, canonical, { wantsLive, readLivePositions }) {
    try {
      if (!wantsLive) {
        const items = await deps.paper.positions(summary.id);
        return (items ?? []).filter((x) => x.symbol === canonical).reduce((a, x) => a + (Number(x.netQty) || 0), 0);
      }
      const res = await readLivePositions();
      let n = 0;
      for (const row of Array.isArray(res?.data) ? res.data : []) {
        const { symbol } = await symbolFor(deps.symbols, summary.broker, row);
        if (symbol === canonical) n += Number(row?.netQty ?? row?.quantity ?? 0) || 0;
      }
      return n;
    } catch {
      return null;
    }
  }

  /**
   * Ban gate inputs and the delivery warnings for an NFO/BFO derivative of a stock. Index and cash orders, and
   * stocks not in ban, cost nothing extra: the positions are read only when the
   * underlying is in ban. Adds BAN_DATA_UNAVAILABLE and PHYSICAL_SETTLEMENT warnings to `checks`.
   * @returns {Promise<{ underlyingKind: string, ban: object|null, heldQty: number|null } | null>}
   */
  async function stockDerivativeContext(body, resolved, summary, { wantsLive, readLivePositions, checks, physical = true }) {
    if ((resolved.kind !== "OPT" && resolved.kind !== "FUT") || (resolved.exchange !== "NFO" && resolved.exchange !== "BFO")) return null;
    const kind = await underlyingKindOf(resolved.underlying, resolved.exchange);
    if (kind !== "stock") return kind ? { underlyingKind: kind, ban: null, heldQty: null } : null;
    const ref = referenceService();
    let ban = null;
    try {
      ban = typeof ref?.banStatus === "function" ? ref.banStatus(resolved.underlying) : null;
    } catch {
      ban = null;
    }
    if (!ban || ban.available === false) {
      checks.push({ code: "BAN_DATA_UNAVAILABLE", message: "Ban list not loaded (NSE archive downloads are off); the exchange may refuse fresh positions.", severity: "warn" });
      ban = null;
    }
    let heldQty = null;
    const inBan = ban?.inBan === true;
    if (inBan) heldQty = await heldQtyOf(summary, resolved.canonical, { wantsLive, readLivePositions });
    // The delivery warning is for opening orders only. Inside the window, a paper order's holding is read from
    // the engine (memory, no broker cost); a live order's stays unknown unless the ban already read it.
    const heldForWarning = async () => (heldQty !== null || wantsLive ? heldQty : heldQtyOf(summary, resolved.canonical, { wantsLive, readLivePositions }));
    if (physical && resolved.kind === "OPT") await physicalSettlementCheck(body, resolved, heldForWarning, checks).catch(() => {});
    return { underlyingKind: "stock", ban: inBan ? { inBan: true, mwplPct: ban.mwplPct ?? null, forDate: ban.forDate ?? null, band: ban.band ?? "ban", source: ban.source ?? null } : ban ? { inBan: false } : null, heldQty };
  }

  /**
   * Ban inputs for a modify that raises the quantity of an order in a stock derivative, the same rule on
   * paper and live. The held quantity already includes the order's filled part, so the order's signed effect is its
   * unfilled remainder: new quantity − filled quantity (banQuantity). Empty when the quantity does not rise, nothing
   * is left to fill, the order is not a stock derivative, or nothing can be read.
   */
  async function modifyBanIntent(ctx, accountId, orderId, quantity, live, liveOrder = null) {
    try {
      const o = liveOrder ?? (await deps.paper.order(accountId, orderId));
      if (!o?.symbol) return {};
      if (!(Number(quantity) > Number(o.quantity))) return {};
      const remaining = Number(quantity) - (Number(o.filledQuantity) || 0);
      if (!(remaining > 0)) return {};
      const resolved = await deps.symbols.resolve(o.symbol);
      const summary = deps.accounts.get(accountId);
      let livePositions = null;
      const readLivePositions = () => (livePositions ??= brokerRead(accountId, "fetchPositions", [], "positions", { priority: "order" }));
      const stock = await stockDerivativeContext({ side: o.side, quantity: remaining }, resolved, summary, { wantsLive: live, readLivePositions, checks: [], physical: false });
      if (!stock) return {};
      return { order: { symbol: o.symbol, side: o.side, quantity }, extra: { underlyingKind: stock.underlyingKind, underlying: resolved.underlying, ban: stock.ban, heldQty: stock.heldQty, banQuantity: remaining } };
    } catch {
      return {};
    }
  }

  /** PHYSICAL_SETTLEMENT (warn): from E-4, an opening order in an ITM or close-to-money stock option. */
  async function physicalSettlementCheck(body, resolved, heldFor, checks) {
    const ref = referenceService();
    if (!ref || typeof ref.calendar !== "function") return;
    const warnFrom = config?.fno?.expiry?.warnFromTradingDays ?? 4;
    const ctmStrikes = config?.fno?.expiry?.closeToMoneyStrikes ?? 1;
    const d = expiryDay({ asOf: istDay(now()), expiry: resolved.expiry, cal: ref.calendar(), warnFrom });
    if (!d.inWindow) return;
    const qty = Number(body.quantity ?? (body.lots ?? 0) * resolved.lotSize) || 0;
    const x = body.side === "BUY" ? qty : -qty;
    const heldQty = await heldFor();
    // Closing (the ban rule's reading): |n| ≤ |h| without crossing zero. A flip from long to short opens.
    if (heldQty !== null) {
      const n = heldQty + x;
      if (Math.abs(n) <= Math.abs(heldQty) && (n === 0 || Math.sign(n) === Math.sign(heldQty))) return;
    }
    const spot = await ltpOf(`${resolved.exchange === "BFO" ? "BSE" : "NSE"}:${resolved.underlying}`);
    if (spot === null) return;
    let step = null;
    try {
      const res = await deps.symbols.search({ q: resolved.underlying, underlying: resolved.underlying, exchange: resolved.exchange, kind: "OPT", expiry: resolved.expiry, limit: 500 });
      step = strikeStepOf((res?.items ?? []).filter((r) => r.underlying === resolved.underlying).map((r) => r.strike));
    } catch {
      step = null;
    }
    const m = moneynessOf({ strike: resolved.strike, right: resolved.right, spot, step, ctmStrikes });
    if (m.moneyness !== "ITM" && m.moneyness !== "CTM") return;
    const ob = obligationOf({ strike: resolved.strike, right: resolved.right, qty: (heldQty ?? 0) + x, underlying: resolved.underlying });
    if (!ob) return;
    let pct = null;
    try {
      pct = deliveryMarginOf({ day: d.day, schedule: ref.deliveryMargin(resolved.expiry, resolved.exchange)?.items ?? [], spot, qty: ob.shares }).pct;
    } catch {
      pct = null;
    }
    const what = ob.buyer ? `you buy ${ob.shares} ${resolved.underlying} at ${resolved.strike}` : `you deliver ${ob.shares} ${resolved.underlying} shares at ${resolved.strike}`;
    const margin = pct !== null ? ` Delivery margin today: ${pct} % (${d.day}).` : "";
    // Unknown holding (live, not in ban): the order may be closing, so the obligation is stated as conditional.
    const lead = heldQty === null ? "Physically settled: if this order opens a position and it is ITM at expiry," : "Physically settled: if ITM at expiry";
    checks.push({ code: "PHYSICAL_SETTLEMENT", message: `${lead} ${what} (₹${Math.round(ob.value)}).${margin}`, severity: "warn" });
  }

  const publicInstrument = (r) =>
    r && {
      symbol: r.canonical,
      exchange: r.exchange,
      kind: r.kind,
      underlying: r.underlying,
      name: r.name ?? null,
      expiry: r.expiry ?? null,
      strike: r.strike ?? null,
      right: r.right ?? null,
      lotSize: r.lotSize,
      tickSize: r.tickSize,
      freezeQty: r.freezeQty ?? null,
      isin: r.isin ?? null,
    };

  // ───────────────────────────── place ─────────────────────────────

  async function replayOrder(ctx, record) {
    if (!record.orderId) throw new BridgeError("ORDER_NOT_FOUND", "The earlier request with this key did not create an order.");
    if (record.mode === "live") {
      const rec = live.get(record.orderId);
      if (!rec) throw new BridgeError("ORDER_NOT_FOUND", `Order ${record.orderId} is no longer kept by the Bridge.`);
      return publicOrder(rec);
    }
    const o = await deps.paper.order(record.accountId, record.orderId);
    if (!o) throw new BridgeError("ORDER_NOT_FOUND", `Paper order ${record.orderId} was not found.`);
    return o;
  }

  /** The error for "could not be saved": DISK_FULL when the disk is full (the fix is different), else INTERNAL. */
  function saveFailure(message, err = stateFile?.lastError?.() ?? null) {
    return isDiskFull(err) || isDiskFull(err?.cause) ? new BridgeError("DISK_FULL", `${message} The disk is full: free some space and try again.`) : new BridgeError("INTERNAL", message);
  }

  /** A damaged order-records file was set aside (stateFile.mjs): no live order until the owner has checked the order book. */
  function assertOrderStateUsable() {
    const d = stateFile?.damage();
    if (d) {
      throw new BridgeError("ORDER_STATE_DAMAGED", "The Bridge's record of the orders it sent was damaged and set aside, so it cannot tell whether a live order was already sent. Nothing was sent. Check your broker's order book, then acknowledge: mc-bridge orders acknowledge-state.", {
        fields: { damagedAt: d.at },
      });
    }
  }

  const auditOrder = (o) => ({ symbol: o.symbol, side: o.side, quantity: o.quantity, product: o.product, orderType: o.orderType, price: o.price, triggerPrice: o.triggerPrice, validity: o.validity, clientOrderId: o.clientOrderId, tag: o.tag });

  async function place(ctx, raw, opts = {}) {
    const req = parseOrderRequest(raw);
    ctx.requireAccountAccess(req.account);
    if (opts.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(String(opts.idempotencyKey))) {
      throw new BridgeError("VALIDATION_FAILED", "Idempotency-Key must be 8-255 letters, digits or _ . : -", { errors: [{ path: "Idempotency-Key", message: "not valid" }] });
    }
    const confirmToken = opts.confirmToken ?? req.confirmToken;
    // A confirmed ticket id works only for the client that prepared the ticket (webhooks never see the token).
    const ticketId = confirmToken ? undefined : opts.ticketId;
    const body = orderBody(req);
    const fp = fingerprint({ action: "place", body });
    const day = istDay(now());
    const viaClientId = opts.idempotencyKey === undefined && req.clientOrderId !== undefined;
    const scopeKey = opts.idempotencyKey !== undefined ? `key:${principalKey(ctx)}:place:${opts.idempotencyKey}` : viaClientId ? `coid:${req.account}:${day}:${req.clientOrderId}` : null;
    if (scopeKey) {
      // clientOrderId is account-wide, but a replay only ever returns the order to the client that placed it: the
      // principal is part of the fingerprint, so another key reusing the id (even with the same body) gets
      // DUPLICATE_CLIENT_ORDER_ID and never sees the other client's order.
      const scopeFp = viaClientId ? fingerprint({ action: "place", body, principal: principalKey(ctx) }) : fp;
      const b = idem.begin(scopeKey, scopeFp, viaClientId ? { reuseCode: "DUPLICATE_CLIENT_ORDER_ID", reuseMessage: `clientOrderId ${req.clientOrderId} was already used on ${req.account} today, by another order or another client.` } : {});
      if (b.replay) return { order: await replayOrder(ctx, b.record), replayed: true };
    }
    let cid = null;
    let committed = false;
    let audited = false;
    let liveRec = null;
    try {
      if (req.clientOrderId !== undefined) cid = idem.reserveClientId(req.account, req.clientOrderId, fp);
      const p = await prepare(ctx, body, { confirmToken, ticketId, forPlace: true });
      if (p.blocks.length) throw refusalError(p.blocks);
      if (p.mode === "live") assertOrderStateUsable();
      if (p.mode === "live" && !scopeKey) {
        // A client that retries a live order after a timeout must not be able to send it twice.
        throw new BridgeError("VALIDATION_FAILED", "Live orders need an Idempotency-Key header or a clientOrderId, so a retry cannot place the order twice.", {
          errors: [{ path: "Idempotency-Key", message: "required for mode live (or send clientOrderId)" }],
        });
      }
      const expect = { fingerprint: p.fp, accountId: p.summary.id, principalId: principalKey(ctx) };
      if (p.needsConfirmation && !(confirmToken ? tickets.consume(confirmToken, expect) : tickets.consumeTicket(ticketId, expect))) {
        throw new BridgeError("CONFIRMATION_REQUIRED", "The confirmToken was already used or has expired. Prepare the order again and confirm it.");
      }
      const tag = cid?.tag ?? body.tag ?? null;
      const warnings = p.checks.filter((c) => c.severity === "warn").map((c) => c.message);
      if (p.mode === "paper") {
        const out = await placePaper(ctx, body, p, { tag, warnings });
        committed = true;
        if (scopeKey) idem.complete(scopeKey, { orderId: out.orderId, accountId: p.summary.id, mode: "paper" });
        if (cid) idem.linkClientId(cid.accountId, cid.clientOrderId, cid.day, { orderId: out.orderId, mode: "paper" });
        persist();
        recordEvent(p.summary.id, { action: "place", mode: "paper", status: out.status });
        emitUpdate(out);
        audited = true;
        await audit(ctx, "order.placed", { accountId: p.summary.id, data: { orderId: out.orderId, mode: "paper", status: out.status, symbol: out.symbol, side: out.side, quantity: out.quantity, clientOrderId: out.clientOrderId ?? null } });
        return { order: out, replayed: false };
      }

      // ── live ──
      liveRec = newLiveRecord(ctx, body, p, { tag, warnings });
      live.set(liveRec.order.orderId, liveRec);
      if (scopeKey) idem.attach(scopeKey, { orderId: liveRec.order.orderId, accountId: p.summary.id, mode: "live" });
      if (cid) idem.linkClientId(cid.accountId, cid.clientOrderId, cid.day, { orderId: liveRec.order.orderId, mode: "live" });
      if (!persist()) throw saveFailure("The order record could not be saved to disk, so the live order was not sent.");
      audited = true;
      await audit(ctx, "order.requested", { accountId: p.summary.id, required: true, data: { orderId: liveRec.order.orderId, mode: "live", order: auditOrder(liveRec.order), legs: p.legs, warnings } });

      const results = [];
      for (let i = 0; i < liveRec.order.legs.length; i += 1) {
        const r = await sendLeg(liveRec, i, p, tag);
        results.push(r);
        if (r.state !== "rejected") committed = true;
        if (r.state === "rejected" && i === 0) break; // nothing went out: do not try the rest
        if (r.error?.code === "KILL_SWITCH_ACTIVE") break; // the kill switch came on between legs: send no more
      }
      liveRec.order.legs.forEach((leg, i) => {
        if (!results[i]) {
          leg.status = "rejected";
          leg.error = results.some((r) => r.error?.code === "KILL_SWITCH_ACTIVE")
            ? { code: "KILL_SWITCH_ACTIVE", message: "Not sent because the kill switch was turned on." }
            : { code: "INVALID_ORDER", message: "Not sent because the first part of the order was refused." };
        }
      });
      recompute(liveRec);
      const firstError = results.find((r) => r.error)?.error ?? null;
      if (!committed) {
        persist();
        recordEvent(p.summary.id, { action: "place", mode: "live", status: "rejected" });
        emitUpdate(liveRec.order);
        await audit(ctx, "order.rejected", { accountId: p.summary.id, data: { orderId: liveRec.order.orderId, code: firstError?.code, message: firstError?.detail } });
        throw firstError ?? new BridgeError("UPSTREAM_ERROR", "The broker refused the order.");
      }
      if (scopeKey) idem.complete(scopeKey, { orderId: liveRec.order.orderId, accountId: p.summary.id, mode: "live" });
      persist();
      // Every slice the broker received is an order towards today's count.
      const sentLegs = Math.max(1, results.filter((r) => r.state !== "rejected").length);
      for (let k = 0; k < sentLegs; k += 1) recordEvent(p.summary.id, { action: "place", mode: "live", status: liveRec.order.status });
      emitUpdate(liveRec.order);
      const unknown = liveRec.order.legs.some((l) => l.status === "outcome_unknown");
      await audit(ctx, unknown ? "order.outcome_unknown" : "order.placed", {
        accountId: p.summary.id,
        data: { orderId: liveRec.order.orderId, mode: "live", status: liveRec.order.status, legs: liveRec.order.legs.map((l) => ({ brokerOrderId: l.brokerOrderId, status: l.status, code: l.error?.code ?? null })) },
      });
      if (unknown) {
        bus.emit("order.outcome_unknown", { orderId: liveRec.order.orderId, accountId: p.summary.id, clientOrderId: liveRec.order.clientOrderId ?? undefined, since: liveRec.order.placedAt });
        scheduleReconcile();
        if (results.every((r) => r.state !== "sent")) {
          throw new BridgeError(
            "OUTCOME_UNKNOWN",
            `The broker did not confirm order ${liveRec.order.orderId}. Do not send it again: the Bridge is checking the broker's order book and will update the order (GET /v1/orders/${liveRec.order.orderId}).`,
            { broker: firstError?.broker },
          );
        }
      }
      return { order: publicOrder(liveRec), replayed: false };
    } catch (err) {
      if (!committed) {
        if (scopeKey) idem.release(scopeKey);
        if (cid) idem.releaseClientId(cid.accountId, cid.clientOrderId, cid.day);
        if (liveRec) {
          for (const leg of liveRec.order.legs) {
            if (leg.status === "pending") {
              leg.status = "rejected";
              leg.error = { code: err?.code ?? "INTERNAL", message: "Not sent." };
            }
          }
          recompute(liveRec);
          persist();
        }
        if (!audited && err instanceof BridgeError && err.code !== "VALIDATION_FAILED") {
          await audit(ctx, "order.refused", { accountId: req.account, data: { code: err.code, message: err.detail, mode: req.mode ?? "paper", symbol: req.symbol, side: req.side, reasons: err.errors?.map((e) => e.path) } });
        }
      }
      throw err;
    }
  }

  /** Paper orders take a slot from their own order-rate window, so a paper strategy meets the same cap as live. */
  function paperSlot(accountId) {
    const s = deps.safety.acquireOrderSlot(accountId, { mode: "paper" });
    if (s && s.ok === false) throw new BridgeError("ORDER_RATE_LIMITED", `The order-rate cap for ${accountId} was reached (paper orders are paced like live ones). Try again in a moment.`, { retryAfterMs: s.retryAfterMs });
  }

  /**
   * LOT_SIZE_STALE: an order sent in lots whose reference lot data is stale (more than
   * reference.staleAfterTradingDays trading days old) or disagrees with the broker master. A warning by default; a block
   * when reference.blockLotsWhenStale is true. lotSizeConfirmed equal to the resolved lot clears it; orders sent as
   * quantity are never checked. The master's lot is always the one used (orderValidation is unchanged).
   */
  async function lotSizeCheck(body, resolved) {
    if (body.lots === undefined || (resolved.kind !== "FUT" && resolved.kind !== "OPT")) return null;
    let reference = null;
    try {
      reference = deps.reference;
    } catch {
      reference = null;
    }
    if (!reference || isStub(reference) || typeof reference.lotFor !== "function") return null;
    let info;
    try {
      info = await reference.lotFor(resolved.underlying, resolved.expiry, { exchange: resolved.exchange });
    } catch {
      return null;
    }
    if (!info || !(info.stale || info.conflict)) return null;
    const lot = resolved.lotSize;
    if (body.lotSizeConfirmed === lot) return null;
    const asOf = typeof info.asOf === "string" ? info.asOf : null;
    const day = asOf ? `${Number(asOf.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(asOf.slice(5, 7)) - 1]}` : "an unknown date";
    const why = info.conflict
      ? `Lot size for ${resolved.underlying} differs between the broker master (${info.conflict.master}) and the reference file (${info.conflict.reference})`
      : `Lot size for ${resolved.underlying} is from ${day} (${info.staleTradingDays} trading day${info.staleTradingDays === 1 ? "" : "s"} old)`;
    const mismatch = body.lotSizeConfirmed !== undefined ? ` lotSizeConfirmed ${body.lotSizeConfirmed} does not match.` : "";
    return { code: "LOT_SIZE_STALE", message: `${why}. Confirm ${lot} units per lot or send quantity in units.${mismatch}`, severity: info.blockWhenStale ? "block" : "warn" };
  }

  async function placePaper(ctx, body, p, { tag, warnings }) {
    paperSlot(p.summary.id);
    const order = {
      ...p.effective,
      account: p.summary.id,
      symbol: p.resolved.canonical,
      quantity: p.quantity,
      mode: "paper",
      validity: p.effective.validity ?? "DAY",
      ...(tag ? { tag } : {}),
      resolved: p.resolved,
      source: ctx.source,
    };
    const res = await deps.paper.place(p.summary.id, order);
    const out = { ...res, source: res.source ?? ctx.source, clientOrderId: res.clientOrderId ?? body.clientOrderId ?? null, tag: res.tag ?? body.tag ?? null };
    if (warnings.length) out.warnings = [...(res.warnings ?? []), ...warnings];
    paperOwners.set(out.orderId, p.summary.id);
    return out;
  }

  function newLiveRecord(ctx, body, p, { tag, warnings }) {
    const t = istIso(now());
    const e = p.effective;
    return {
      order: {
        orderId: `ord_${randomBytes(12).toString("hex")}`,
        clientOrderId: body.clientOrderId ?? null,
        accountId: p.summary.id,
        broker: p.summary.broker,
        mode: "live",
        symbol: p.resolved.canonical,
        side: body.side,
        quantity: p.quantity,
        filledQuantity: 0,
        avgPrice: null,
        price: e.price ?? null,
        triggerPrice: e.triggerPrice ?? null,
        orderType: e.orderType,
        product: body.product,
        validity: e.validity ?? "DAY",
        status: "pending",
        brokerStatus: null,
        statusMessage: null,
        legs: p.legs.map((q) => ({ brokerOrderId: null, quantity: q, status: "pending", error: null, filledQuantity: 0, avgPrice: null, brokerStatus: null, statusMessage: null })),
        source: ctx.source,
        tag: body.tag ?? null,
        placedAt: t,
        updatedAt: t,
        ...(warnings.length ? { warnings } : {}),
      },
      x: {
        ref: { token: String(p.ref.token), exchange: p.ref.exchange ?? p.resolved.exchange, tradingSymbol: p.ref.tradingSymbol ?? null },
        lotSize: p.resolved.lotSize,
        tickSize: p.resolved.tickSize,
        brokerTag: tag,
        keyId: ctx.key?.id ?? null,
        principal: principalKey(ctx),
        modifications: 0,
        marketProtectionPct: p.marketProtectionPct,
        legs: p.legs.map(() => ({ invoked: false, sentAt: null })),
      },
    };
  }

  /**
   * Send one leg of a live order. Never throws.
   * @returns {Promise<{ state: "sent"|"unknown"|"rejected", error?: BridgeError }>}
   */
  async function sendLeg(rec, i, p, tag) {
    const leg = rec.order.legs[i];
    const xl = rec.x.legs[i];
    const accountId = rec.order.accountId;
    const brokerId = rec.order.broker;
    const refuse = (e) => {
      leg.status = "rejected";
      leg.error = { code: e.code, message: e.detail };
      return { state: "rejected", error: e };
    };
    const unknownLeg = (message, e) => {
      leg.status = "outcome_unknown";
      leg.error = { code: "OUTCOME_UNKNOWN", message };
      return { state: "unknown", error: e ?? new BridgeError("OUTCOME_UNKNOWN", message) };
    };
    try {
      const ack = await deps.scheduler.schedule({ accountId, endpointClass: "order", priority: "order" }, async () => {
        await sendGate(accountId, { killSwitch: true, slotWaitMs: i === 0 ? 0 : 2000 });
        const adapter = deps.accounts.adapter(accountId);
        const creds = await deps.accounts.creds(accountId);
        const payload = p.mapper.place({ order: p.effective, ref: rec.x.ref, lots: leg.quantity / rec.x.lotSize, tag: p.mapper.tag ? tag : null, marketProtectionPct: rec.x.marketProtectionPct });
        const gate = issueOrderGate({ verdict: p.verdict, liveArmed: true, action: "placeOrder", brokerId });
        xl.invoked = true;
        xl.sentAt = now();
        persist();
        const call = adapter.placeOrder(creds, payload, rec.x.lotSize, gate);
        return withTimeout(call, cfg.liveCallTimeoutMs, (v, e) => lateOutcome(rec, i, v, e));
      });
      if (!ack || typeof ack.orderId !== "string" || !ack.orderId) return unknownLeg("The broker answered without an order id.");
      leg.brokerOrderId = ack.orderId;
      leg.status = bridgeStatus(ack.orderStatus);
      leg.brokerStatus = ack.orderStatus ?? null;
      leg.error = null;
      return { state: "sent" };
    } catch (err) {
      if (err === TIMEOUT) return unknownLeg(`The broker did not answer within ${Math.round(cfg.liveCallTimeoutMs / 1000)} s.`);
      const e = fromBrokerError(err, { brokerId, write: true });
      if (!xl.invoked) {
        // Refused before the adapter was called (queue, session, gate): nothing was sent.
        return refuse(e.code === "OUTCOME_UNKNOWN" ? new BridgeError("INTERNAL", "The order could not be prepared for the broker. Nothing was sent.") : e);
      }
      if (e.code === "OUTCOME_UNKNOWN") return unknownLeg(e.detail, e);
      if (e.code === "UPSTREAM_RATE_LIMITED") {
        try {
          deps.scheduler.noteUpstreamThrottle(accountId, "order");
        } catch {
          /* best effort */
        }
      }
      return refuse(e);
    }
  }

  /** The adapter answered after we stopped waiting: use it to resolve an outcome_unknown leg. */
  function lateOutcome(rec, i, value, error) {
    const leg = rec.order.legs[i];
    if (leg.status !== "outcome_unknown") return;
    if (value && typeof value.orderId === "string" && value.orderId) {
      leg.brokerOrderId = value.orderId;
      leg.status = bridgeStatus(value.orderStatus);
      leg.brokerStatus = value.orderStatus ?? null;
      leg.error = null;
      leg.statusMessage = "The broker confirmed the order late.";
    } else if (error) {
      const e = fromBrokerError(error, { brokerId: rec.order.broker, write: true });
      if (e.code === "OUTCOME_UNKNOWN") return;
      leg.status = "rejected";
      leg.error = { code: e.code, message: e.detail };
    } else return;
    recompute(rec);
    persist();
    emitUpdate(rec.order);
    audit(systemCtx, "order.reconciled", { accountId: rec.order.accountId, data: { orderId: rec.order.orderId, leg: i, via: "late_answer", status: leg.status } });
  }

  // ───────────────────────────── locate / modify / cancel ─────────────────────────────

  /** Find an order the caller may see. ORDER_NOT_FOUND otherwise (also for other accounts, so ids do not leak). */
  async function locate(ctx, orderId) {
    const id = String(orderId ?? "");
    if (!id || id.length > 64) throw new BridgeError("ORDER_NOT_FOUND", "No order with this id.");
    const rec = live.get(id);
    if (rec) {
      if (!canAccess(ctx, rec.order.accountId)) throw new BridgeError("ORDER_NOT_FOUND", "No order with this id.");
      return { mode: "live", accountId: rec.order.accountId, rec };
    }
    const owner = paperOwners.get(id);
    const candidates = owner ? [owner] : accessibleAccounts(ctx).map((a) => a.id);
    for (const accountId of candidates) {
      if (!canAccess(ctx, accountId)) continue;
      let o = null;
      try {
        o = await deps.paper.order(accountId, id);
      } catch (err) {
        if (err?.code === "NOT_IMPLEMENTED") throw err;
      }
      if (o) {
        paperOwners.set(id, accountId);
        return { mode: "paper", accountId, order: o };
      }
    }
    throw new BridgeError("ORDER_NOT_FOUND", "No order with this id.");
  }

  /** Start an idempotent write on an existing order. */
  function beginWrite(ctx, action, orderId, payload, idempotencyKey) {
    if (idempotencyKey === undefined) return { key: null, replay: null };
    if (!IDEMPOTENCY_KEY_RE.test(String(idempotencyKey))) throw new BridgeError("VALIDATION_FAILED", "Idempotency-Key must be 8-255 letters, digits or _ . : -");
    const key = `key:${principalKey(ctx)}:${action}:${orderId}:${idempotencyKey}`;
    const b = idem.begin(key, fingerprint({ action, orderId, payload }));
    return { key, replay: b.replay ? b.record : null };
  }

  /** Live opt-ins for changing a live order. */
  function assertLiveAllowed(ctx, rec) {
    const summary = deps.accounts.get(rec.order.accountId);
    const accountCfg = (config?.accounts ?? []).find((a) => a.id === rec.order.accountId);
    const d = decideMode({ config, accountCfg, summary, requested: "live", ctx, confirmPaperFromMcp: cfg.confirmPaperFromMcp });
    if (d.refusals.length) throw refusalError(sortByPriority(d.refusals));
    if (d.needsConfirmation) throw new BridgeError("CONFIRMATION_REQUIRED", "AI assistants and confirmation-required hooks cannot change live orders. Change it in the Bridge dashboard or the broker app.");
    return summary;
  }

  function validateChanges(rec, changes) {
    const o = rec.order;
    const next = {
      orderType: changes.orderType ?? o.orderType,
      validity: changes.validity ?? o.validity,
      price: changes.price ?? o.price ?? undefined,
      triggerPrice: changes.triggerPrice ?? o.triggerPrice ?? undefined,
      quantity: changes.quantity ?? o.quantity,
      side: o.side,
    };
    const problems = [];
    const priced = next.orderType === "LIMIT" || next.orderType === "SL";
    const triggeredT = next.orderType === "SL" || next.orderType === "SL-M";
    if (priced && !(next.price > 0)) problems.push(`price is required for ${next.orderType} orders.`);
    if (triggeredT && !(next.triggerPrice > 0)) problems.push(`triggerPrice is required for ${next.orderType} orders.`);
    if (!priced) delete next.price;
    if (!triggeredT) delete next.triggerPrice;
    for (const f of ["price", "triggerPrice"]) {
      if (next[f] !== undefined && !isMultipleOf(next[f], rec.x.tickSize)) problems.push(`${f} ${next[f]} is not a multiple of the tick size ${rec.x.tickSize}. Try ${roundToTick(next[f], rec.x.tickSize)}.`);
    }
    if (changes.quantity !== undefined) {
      if (o.legs.length > 1) problems.push("The quantity of a sliced order cannot be changed. Cancel it and place a new one.");
      if (changes.quantity % rec.x.lotSize !== 0) problems.push(`quantity ${changes.quantity} is not a multiple of the lot size ${rec.x.lotSize}.`);
      if (changes.quantity < (o.filledQuantity ?? 0)) problems.push("The new quantity is below what has already been filled.");
    }
    if (next.orderType === "SL" && next.price !== undefined && next.triggerPrice !== undefined) {
      if (next.side === "BUY" && next.price < next.triggerPrice) problems.push("For a BUY stop-loss order the price must be at or above the trigger price.");
      if (next.side === "SELL" && next.price > next.triggerPrice) problems.push("For a SELL stop-loss order the price must be at or below the trigger price.");
    }
    if (problems.length) throw new BridgeError("INVALID_ORDER", problems[0], { errors: problems.map((m) => ({ path: "changes", message: m })) });
    return next;
  }

  /** A paper order as it would stand after `changes` (the paper engine's own merge rule). */
  function paperNext(o, changes) {
    const orderType = changes.orderType ?? o.orderType;
    const priced = orderType === "LIMIT" || orderType === "SL";
    const stop = orderType === "SL" || orderType === "SL-M";
    return {
      orderType,
      price: priced ? (changes.price ?? o.price ?? undefined) : undefined,
      triggerPrice: stop ? (changes.triggerPrice ?? o.triggerPrice ?? undefined) : undefined,
      quantity: changes.quantity ?? o.quantity,
      side: o.side,
    };
  }

  /**
   * The per-order inputs SafetyGuard needs to check a modify exactly like a new order: lots (quantity / lot size),
   * value (new quantity x the new limit or trigger price, or x LTP for a market order: the place rule), the LTP for
   * the price band, and the order itself for the market-order policy and market hours. A change that raises the
   * quantity above the exchange freeze quantity is refused here: a change cannot be split into slices.
   * @returns {Promise<{ order: object, intent: { quantity: number, lots: number | null, lotSize: number | null, value: number | null, ltp: number | null } }>}
   */
  async function modifyShape(o, next, { lotSize = null, broker = null, ltp: knownLtp, quantityChanged = false } = {}) {
    let resolved = null;
    try {
      resolved = await deps.symbols.resolve(o.symbol, broker ? { broker } : {});
    } catch {
      resolved = null;
    }
    const pos = (v) => Number.isFinite(v) && v > 0;
    const lot = pos(lotSize) ? lotSize : pos(resolved?.lotSize) ? resolved.lotSize : null;
    const quantity = Number(next.quantity);
    const freeze = resolved?.freezeQty;
    if (quantityChanged && pos(freeze) && quantity > freeze) {
      throw new BridgeError("INVALID_ORDER", `quantity ${quantity} is above the exchange freeze quantity ${freeze} for ${o.symbol}. A change cannot be split into slices: cancel this order and place a new one.`);
    }
    const ltp = knownLtp !== undefined ? knownLtp : await ltpOf(o.symbol);
    const unit = pos(next.price) ? next.price : pos(next.triggerPrice) ? next.triggerPrice : ltp;
    const value = pos(unit) && pos(quantity) ? Number((unit * quantity).toFixed(2)) : null;
    const order = { symbol: o.symbol, side: o.side, product: o.product, orderType: next.orderType, price: next.price, triggerPrice: next.triggerPrice, quantity };
    return { order, intent: { quantity, lots: lot ? quantity / lot : null, lotSize: lot, value, ltp } };
  }

  const openLeg = (l) => l.brokerOrderId && !TERMINAL_STATUSES.has(l.status) && l.status !== "outcome_unknown";

  /**
   * One gated write per leg (modify/cancel). Stops at the first refusal.
   * @returns {Promise<{ done: number, error: BridgeError | null, unknown: boolean }>}
   */
  async function writeLegs(rec, action, legIndexes, buildArgs, verdict, slotWaitMs) {
    const accountId = rec.order.accountId;
    const brokerId = rec.order.broker;
    let done = 0;
    for (const i of legIndexes) {
      let invoked = false;
      try {
        await deps.scheduler.schedule({ accountId, endpointClass: "order", priority: "order" }, async () => {
          // Cancels only reduce risk, so the kill switch never stops them; changes are re-checked.
          await sendGate(accountId, { killSwitch: action !== "cancelOrder", slotWaitMs });
          const adapter = deps.accounts.adapter(accountId);
          const creds = await deps.accounts.creds(accountId);
          const args = buildArgs(i);
          const gate = issueOrderGate({ verdict, liveArmed: true, action, brokerId });
          invoked = true;
          return withTimeout(adapter[action](creds, ...args, gate), cfg.liveCallTimeoutMs, () => {});
        });
        done += 1;
      } catch (err) {
        const what = action === "cancelOrder" ? "cancellation" : "change";
        if (err === TIMEOUT) return { done, error: new BridgeError("OUTCOME_UNKNOWN", `The broker did not answer the ${what} in time. Check the order before trying again.`), unknown: true };
        const e = fromBrokerError(err, { brokerId, write: true });
        if (!invoked && (e.code === "ORDER_RATE_LIMITED" || e.code === "KILL_SWITCH_ACTIVE")) return { done, error: e, unknown: false };
        if (!invoked && e.code === "OUTCOME_UNKNOWN") return { done, error: new BridgeError("INTERNAL", "The request could not be prepared for the broker. Nothing was sent."), unknown: false };
        return { done, error: e, unknown: invoked && e.code === "OUTCOME_UNKNOWN" };
      }
    }
    return { done, error: null, unknown: false };
  }

  async function modify(ctx, orderId, rawChanges, { idempotencyKey } = {}) {
    const changes = parseOrderChanges(rawChanges);
    const loc = await locate(ctx, orderId);
    const w = beginWrite(ctx, "modify", orderId, changes, idempotencyKey);
    if (w.replay) return { order: await replayOrder(ctx, w.replay), replayed: true };
    let committed = false;
    try {
      if (loc.mode === "paper") {
        const banIntent = changes.quantity !== undefined ? await modifyBanIntent(ctx, loc.accountId, orderId, changes.quantity, false) : {};
        // The same per-order checks as a place (lots, value, price band, market policy, market hours, freeze), on the
        // order as it would stand after the change.
        const shape = await modifyShape(loc.order, paperNext(loc.order, changes), { quantityChanged: changes.quantity !== undefined });
        const verdict = await deps.safety.check(ctx, { ...banIntent.extra, accountId: loc.accountId, mode: "paper", action: "modify", order: shape.order, orderId, source: ctx.source, keyId: ctx.key?.id ?? null, ...shape.intent });
        if (!verdict?.ok) throw verdictError(verdict);
        paperSlot(loc.accountId);
        const out = await deps.paper.modify(loc.accountId, orderId, changes);
        committed = true;
        if (w.key) idem.complete(w.key, { orderId, accountId: loc.accountId, mode: "paper" });
        persist();
        recordEvent(loc.accountId, { action: "modify", mode: "paper", status: out.status });
        emitUpdate(out);
        await audit(ctx, "order.modified", { accountId: loc.accountId, data: { orderId, mode: "paper", changes } });
        return { order: out, replayed: false };
      }
      const rec = loc.rec;
      const o = rec.order;
      if (TERMINAL_STATUSES.has(o.status)) throw new BridgeError("INVALID_ORDER", `Order ${orderId} is ${o.status.replace("_", " ")} and cannot be changed.`);
      if (o.status === "outcome_unknown") throw new BridgeError("INVALID_ORDER", `Order ${orderId} has an unknown outcome. Wait until the Bridge finds it in the broker's order book.`);
      const summary = assertLiveAllowed(ctx, rec);
      const adapter = deps.accounts.adapter(o.accountId);
      const mapper = assertLiveSupport(summary.broker, adapter, "modifyOrder");
      const max = deps.scheduler.policyFor(summary.broker)?.maxModificationsPerOrder;
      if (Number.isFinite(max) && rec.x.modifications >= max) throw new BridgeError("INVALID_ORDER", `${summary.broker} allows at most ${max} changes to one order. Cancel it and place a new one.`);
      let next = validateChanges(rec, changes);
      let mpPct = rec.x.marketProtectionPct;
      const toMarket = changes.orderType === "MARKET" || changes.orderType === "SL-M";
      // Always fetch the LTP: SafetyGuard needs it to check the price band of a changed LIMIT/SL price too.
      const ltp = await ltpOf(o.symbol);
      if (toMarket) {
        const m = applyMarketPolicy(next, { policy: config?.safety?.marketOrders ?? "protect", defaultPct: config?.safety?.marketProtectionPct ?? 2, nativeProtection: mapper.nativeMarketProtection, ltp, tickSize: rec.x.tickSize });
        const b = blocking(m.checks);
        if (b.length) throw refusalError(b);
        next = { ...next, ...m.order };
        mpPct = m.marketProtectionPct;
      }
      const banIntent = changes.quantity !== undefined ? await modifyBanIntent(ctx, o.accountId, orderId, next.quantity, true, o) : {};
      const shape = await modifyShape(o, next, { lotSize: rec.x.lotSize, broker: summary.broker, ltp, quantityChanged: changes.quantity !== undefined });
      const verdict = await deps.safety.check(ctx, {
        ...banIntent.extra,
        accountId: o.accountId,
        mode: "live",
        action: "modify",
        order: { ...auditOrder(o), ...next, account: o.accountId },
        orderId,
        source: ctx.source,
        keyId: ctx.key?.id ?? null,
        ...shape.intent,
      });
      if (!verdict?.ok) throw verdictError(verdict);
      const legs = o.legs.map((l, i) => (openLeg(l) ? i : -1)).filter((i) => i >= 0);
      if (!legs.length) throw new BridgeError("INVALID_ORDER", `Order ${orderId} has no open part to change.`);
      await audit(ctx, "order.modify_requested", { accountId: o.accountId, required: true, data: { orderId, changes, legs: legs.length } });
      const r = await writeLegs(
        rec,
        "modifyOrder",
        legs,
        (i) => [o.legs[i].brokerOrderId, mapper.modify({ next: { ...next, quantity: o.legs.length > 1 ? o.legs[i].quantity : next.quantity }, marketProtectionPct: mpPct })],
        verdict,
        2000,
      );
      if (r.done > 0 || r.unknown) {
        committed = true;
        Object.assign(o, { orderType: next.orderType, validity: next.validity, price: next.price ?? null, triggerPrice: next.triggerPrice ?? null });
        if (changes.quantity !== undefined && o.legs.length === 1) {
          o.quantity = changes.quantity;
          o.legs[0].quantity = changes.quantity;
        }
        rec.x.modifications += 1;
        rec.x.marketProtectionPct = mpPct;
        o.updatedAt = istIso(now());
        if (r.error) o.statusMessage = r.unknown ? "A change was sent but the broker did not confirm it. Check the order." : `Only part of the order was changed: ${r.error.detail}`;
      }
      if (w.key && committed) idem.complete(w.key, { orderId, accountId: o.accountId, mode: "live" });
      persist();
      recordEvent(o.accountId, { action: "modify", mode: "live", status: r.error ? "error" : "ok" });
      await audit(ctx, r.error ? "order.modify_failed" : "order.modified", { accountId: o.accountId, data: { orderId, changes, done: r.done, code: r.error?.code ?? null } });
      if (committed) emitUpdate(o);
      if (r.error && (r.done === 0 || r.unknown)) throw r.error;
      return { order: publicOrder(rec), replayed: false };
    } catch (err) {
      if (!committed && w.key) idem.release(w.key);
      throw err;
    }
  }

  async function cancelLive(ctx, rec) {
    const o = rec.order;
    if (!(ctx.scopes?.has("live") || ctx.principal?.kind === "local")) throw new BridgeError("SCOPE_REQUIRED", 'Cancelling a live order needs a key with the "live" scope.');
    const adapter = deps.accounts.adapter(o.accountId);
    assertLiveSupport(o.broker, adapter, "cancelOrder");
    const legs = o.legs.map((l, i) => (openLeg(l) ? i : -1)).filter((i) => i >= 0);
    if (!legs.length) {
      if (o.status === "outcome_unknown") throw new BridgeError("INVALID_ORDER", `Order ${o.orderId} has an unknown outcome, so it cannot be cancelled by id yet. Use cancel-all, or cancel it in the broker app.`);
      throw new BridgeError("INVALID_ORDER", `Order ${o.orderId} is ${o.status.replace("_", " ")} and cannot be cancelled.`);
    }
    await audit(ctx, "order.cancel_requested", { accountId: o.accountId, data: { orderId: o.orderId, legs: legs.length } });
    const r = await writeLegs(rec, "cancelOrder", legs, (i) => [o.legs[i].brokerOrderId], CANCEL_VERDICT, 5000);
    for (const i of legs.slice(0, r.done)) {
      o.legs[i].status = "cancelled";
      o.legs[i].brokerStatus = "CANCELLED";
    }
    if (r.done > 0) recompute(rec);
    if (r.error) o.statusMessage = r.unknown ? "A cancellation was sent but the broker did not confirm it. Check the order." : `The cancellation was refused: ${r.error.detail}`;
    o.updatedAt = istIso(now());
    persist();
    recordEvent(o.accountId, { action: "cancel", mode: "live", status: r.error ? "error" : "cancelled" });
    await audit(ctx, r.error ? "order.cancel_failed" : "order.cancelled", { accountId: o.accountId, data: { orderId: o.orderId, done: r.done, code: r.error?.code ?? null } });
    if (r.done > 0 || r.unknown) emitUpdate(o);
    return r;
  }

  async function cancel(ctx, orderId, { idempotencyKey } = {}) {
    const loc = await locate(ctx, orderId);
    const w = beginWrite(ctx, "cancel", orderId, null, idempotencyKey);
    if (w.replay) return { order: await replayOrder(ctx, w.replay), replayed: true };
    let committed = false;
    try {
      if (loc.mode === "paper") {
        paperSlot(loc.accountId);
        const out = await deps.paper.cancel(loc.accountId, orderId);
        committed = true;
        if (w.key) idem.complete(w.key, { orderId, accountId: loc.accountId, mode: "paper" });
        persist();
        recordEvent(loc.accountId, { action: "cancel", mode: "paper", status: out.status });
        emitUpdate(out);
        await audit(ctx, "order.cancelled", { accountId: loc.accountId, data: { orderId, mode: "paper" } });
        return { order: out, replayed: false };
      }
      const r = await cancelLive(ctx, loc.rec);
      if (r.done > 0 || r.unknown) committed = true;
      if (w.key && committed) idem.complete(w.key, { orderId, accountId: loc.rec.order.accountId, mode: "live" });
      persist();
      if (r.error && (r.done === 0 || r.unknown)) throw r.error;
      return { order: publicOrder(loc.rec), replayed: false };
    } catch (err) {
      if (!committed && w.key) idem.release(w.key);
      throw err;
    }
  }

  /** Cancel one broker order that may or may not have been placed through the Bridge (cancel-all). */
  async function cancelBrokerOrder(ctx, accountId, brokerId, brokerOrderId) {
    const rec = [...live.values()].find((r) => r.order.accountId === accountId && r.order.legs.some((l) => String(l.brokerOrderId) === String(brokerOrderId)));
    if (rec) {
      const r = await cancelLive(ctx, rec);
      if (r.error) throw r.error;
      return rec.order.orderId;
    }
    if (!(ctx.scopes?.has("live") || ctx.principal?.kind === "local")) throw new BridgeError("SCOPE_REQUIRED", 'Cancelling a live order needs a key with the "live" scope.');
    const adapter = deps.accounts.adapter(accountId);
    assertLiveSupport(brokerId, adapter, "cancelOrder");
    const outside = { order: { accountId, broker: brokerId } };
    const r = await writeLegs(outside, "cancelOrder", [0], () => [brokerOrderId], CANCEL_VERDICT, 5000);
    if (r.error) throw r.error;
    recordEvent(accountId, { action: "cancel", mode: "live", status: "cancelled" });
    await audit(ctx, "order.cancelled", { accountId, data: { brokerOrderId, placedOutsideBridge: true } });
    return String(brokerOrderId);
  }

  async function pagedAll(fetchPage, cap) {
    const out = [];
    let cursor;
    for (;;) {
      const pg = await fetchPage(cursor);
      out.push(...(pg?.items ?? []));
      cursor = pg?.nextCursor ?? null;
      if (!cursor || out.length >= cap) return out;
    }
  }

  /**
   * Cancel every working order on the accounts this key may use, in two groups: orders the Bridge placed (paper and
   * live) and live orders placed outside it (in the broker's app or terminal).
   * @param {RequestContext} ctx
   * @param {{ accountId?: string, mode?: "paper"|"live", bridgeOnly?: boolean, dryRun?: boolean }} [opts]
   *   bridgeOnly: leave broker orders the Bridge did not place (e.g. a stop-loss set in the broker app) alone.
   *   dryRun: cancel nothing; list what is open in each group (`bridge.open`, `external.open`).
   * @returns {Promise<{ cancelled: string[], failed: object[], bridge: { cancelled: string[], open?: object[] },
   *   external: { cancelled: string[], left: string[], open?: object[] }, dryRun?: true }>}
   */
  async function cancelAll(ctx, { accountId, mode, bridgeOnly = false, dryRun = false } = {}) {
    const accounts = accountId ? [accountFor(ctx, accountId).summary] : accessibleAccounts(ctx);
    const cancelled = [];
    const failed = [];
    const bridge = { cancelled: [], ...(dryRun ? { open: [] } : {}) };
    const external = { cancelled: [], left: [], ...(dryRun ? { open: [] } : {}) };
    const canLive = ctx.scopes?.has("live") || ctx.principal?.kind === "local";
    for (const acc of accounts) {
      if (mode !== "live") {
        try {
          const open = await pagedAll((cursor) => deps.paper.orders(acc.id, { limit: MAX_PAGE, cursor }), cfg.maxOrderLookups);
          for (const o of open.filter((x) => !TERMINAL_STATUSES.has(x.status))) {
            if (dryRun) {
              bridge.open.push({ orderId: o.orderId, accountId: acc.id, mode: "paper", symbol: o.symbol, side: o.side, quantity: o.quantity, status: o.status, external: false });
              continue;
            }
            try {
              const out = await deps.paper.cancel(acc.id, o.orderId);
              cancelled.push(o.orderId);
              bridge.cancelled.push(o.orderId);
              recordEvent(acc.id, { action: "cancel", mode: "paper", status: out?.status ?? "cancelled" });
              if (out) emitUpdate(out);
            } catch (err) {
              failed.push({ orderId: o.orderId, code: err?.code ?? "INTERNAL", message: err?.detail ?? "The paper order could not be cancelled." });
            }
          }
        } catch (err) {
          if (mode === "paper" || err?.code !== "NOT_IMPLEMENTED") failed.push({ input: acc.id, code: err?.code ?? "INTERNAL", message: err?.detail ?? "The paper order book could not be read." });
        }
      }
      if (mode !== "paper" && acc.broker !== "paper") {
        if (!canLive) {
          if (mode === "live") failed.push({ input: acc.id, code: "SCOPE_REQUIRED", message: 'Cancelling live orders needs a key with the "live" scope.' });
          continue;
        }
        let book;
        try {
          book = await refreshAccount(acc.id, "order");
        } catch (err) {
          const bridgeOpen = [...live.values()].some((r) => r.order.accountId === acc.id && !TERMINAL_STATUSES.has(r.order.status));
          if (mode === "live" || bridgeOpen || err?.code !== "CAPABILITY_UNSUPPORTED") failed.push({ input: acc.id, code: err?.code ?? "INTERNAL", message: err?.detail ?? "The broker order book could not be read." });
          continue;
        }
        const ours = brokerIndex(acc.id);
        const listed = new Set();
        for (const row of (book ?? []).filter((r) => OPEN_BOOK_STATUSES.has(r.status))) {
          const brokerId = String(row.orderId);
          const mine = ours.get(brokerId) ?? null;
          if (dryRun) {
            if (mine) {
              const rec = live.get(mine);
              if (rec && !listed.has(mine)) {
                listed.add(mine);
                bridge.open.push({ orderId: mine, accountId: acc.id, mode: "live", symbol: rec.order.symbol, side: rec.order.side, quantity: rec.order.quantity, status: rec.order.status, external: false });
              }
            } else {
              external.open.push({ orderId: brokerId, accountId: acc.id, mode: "live", symbol: row.exchange && row.tradingSymbol ? `${row.exchange}:${row.tradingSymbol}` : String(row.tradingSymbol ?? row.symbol ?? ""), side: row.side ?? null, quantity: Number(row.pendingQty ?? row.qty ?? 0) || null, status: String(row.status).toLowerCase(), external: true });
            }
            continue;
          }
          if (!mine && bridgeOnly) {
            external.left.push(brokerId);
            continue;
          }
          try {
            const id = await cancelBrokerOrder(ctx, acc.id, acc.broker, row.orderId);
            cancelled.push(id);
            (mine ? bridge : external).cancelled.push(id);
          } catch (err) {
            failed.push({ orderId: brokerId, code: err?.code ?? "INTERNAL", message: err?.detail ?? "The order could not be cancelled." });
          }
        }
      }
    }
    if (dryRun) return { dryRun: true, cancelled, failed, bridge, external };
    await audit(ctx, "order.cancel_all", { accountId: accountId ?? null, data: { mode: mode ?? "all", bridgeOnly, cancelled: cancelled.length, cancelledOutsideBridge: external.cancelled.length, leftOutsideBridge: external.left.length, failed: failed.length } });
    return { cancelled, failed, bridge, external };
  }

  // ───────────────────────────── reads ─────────────────────────────

  async function get(ctx, orderId) {
    const loc = await locate(ctx, orderId);
    if (loc.mode === "paper") return loc.order;
    try {
      await refreshAccount(loc.accountId);
    } catch (err) {
      log.debug("order refresh failed; serving the stored order", { orderId, code: err?.code ?? "ERROR" });
    }
    return publicOrder(loc.rec);
  }

  async function getByClientId(ctx, clientOrderId) {
    const id = String(clientOrderId ?? "");
    const rec = idem.findClientId(id, (a) => canAccess(ctx, a));
    if (rec) return get(ctx, rec.orderId);
    // Live orders whose clientOrderId reservation has expired but whose record is still kept.
    const found = [...live.values()].filter((r) => r.order.clientOrderId === id && canAccess(ctx, r.order.accountId)).sort((a, b) => timeOf(b.order.placedAt) - timeOf(a.order.placedAt))[0];
    if (found) return get(ctx, found.order.orderId);
    throw new BridgeError("ORDER_NOT_FOUND", `No order with clientOrderId ${id}.`);
  }

  const encodeCursor = (o) => Buffer.from(JSON.stringify({ o })).toString("base64url");
  function decodeCursor(c) {
    if (c === undefined || c === null || c === "") return 0;
    try {
      const v = JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
      if (Number.isInteger(v?.o) && v.o >= 0) return v.o;
    } catch {
      /* fall through */
    }
    throw new BridgeError("VALIDATION_FAILED", "cursor is not valid. Use meta.nextCursor from the previous page.");
  }
  function pageOf(items, limit, cursor) {
    const lim = Math.min(Math.max(1, Number(limit) || 100), MAX_PAGE);
    const off = decodeCursor(cursor);
    return { items: items.slice(off, off + lim), nextCursor: off + lim < items.length ? encodeCursor(off + lim) : null };
  }

  const listAccounts = (ctx, accountId) => (accountId ? [accountFor(ctx, accountId).summary] : accessibleAccounts(ctx));

  async function list(ctx, { accountId, status, mode, limit, cursor } = {}) {
    decodeCursor(cursor);
    const accounts = listAccounts(ctx, accountId);
    const ids = new Set(accounts.map((a) => a.id));
    const items = [];
    if (mode !== "paper") {
      const stale = new Set([...live.values()].filter((r) => ids.has(r.order.accountId) && !TERMINAL_STATUSES.has(r.order.status)).map((r) => r.order.accountId));
      await Promise.all([...stale].map((a) => refreshAccount(a).catch(() => null)));
      for (const rec of live.values()) if (ids.has(rec.order.accountId) && (!status || rec.order.status === status)) items.push(publicOrder(rec));
    }
    if (mode !== "live") {
      for (const acc of accounts) {
        try {
          items.push(...(await pagedAll((c) => deps.paper.orders(acc.id, { status, limit: MAX_PAGE, cursor: c }), cfg.maxOrderLookups)));
        } catch (err) {
          if (mode === "paper" || err?.code !== "NOT_IMPLEMENTED") throw err;
        }
      }
    }
    items.sort((a, b) => timeOf(b.placedAt) - timeOf(a.placedAt) || String(b.orderId).localeCompare(String(a.orderId)));
    return pageOf(items, limit, cursor);
  }

  async function trades(ctx, { accountId, mode, limit, cursor } = {}) {
    decodeCursor(cursor);
    const accounts = listAccounts(ctx, accountId);
    const items = [];
    if (mode !== "paper") {
      for (const acc of accounts) {
        if (acc.broker === "paper") continue;
        let res;
        try {
          res = await brokerRead(acc.id, "fetchTradeBook", [], "the trade book");
        } catch (err) {
          if (accountId || mode === "live") throw err;
          log.debug("trade book read failed", { accountId: acc.id, code: err?.code ?? "ERROR" });
          continue;
        }
        const index = brokerIndex(acc.id);
        items.push(...(await mapRows(res.data, async (row) => toTrade(row, await symbolFor(deps.symbols, acc.broker, row), { accountId: acc.id, orderId: index.get(String(row.orderId)) ?? null }))));
      }
    }
    if (mode !== "live") {
      for (const acc of accounts) {
        try {
          const rows = await pagedAll((c) => deps.paper.trades(acc.id, { limit: MAX_PAGE, cursor: c }), cfg.maxOrderLookups);
          items.push(...rows.map((t) => ({ ...t, accountId: t.accountId ?? acc.id, mode: "paper" })));
        } catch (err) {
          if (mode === "paper" || err?.code !== "NOT_IMPLEMENTED") throw err;
        }
      }
    }
    items.sort((a, b) => timeOf(b.tradedAt) - timeOf(a.tradedAt));
    return pageOf(items, limit, cursor);
  }

  /** Mode for a portfolio read: paper accounts are always paper; other accounts are live unless asked. */
  function readMode(summary, mode) {
    const m = mode ?? (summary.broker === "paper" ? "paper" : "live");
    if (m === "live" && summary.broker === "paper") throw new BridgeError("CAPABILITY_UNSUPPORTED", `${summary.id} is a paper account; read it with mode=paper.`);
    return m;
  }

  async function positions(ctx, accountId, { mode } = {}) {
    const { summary } = accountFor(ctx, accountId);
    if (readMode(summary, mode) === "paper") {
      const items = await deps.paper.positions(accountId);
      return { items, freshness: freshness("paper", now(), accountId, "paper") };
    }
    const res = await brokerRead(accountId, "fetchPositions", [], "positions");
    const items = await mapRows(res.data, async (row) => toPosition(row, await symbolFor(deps.symbols, summary.broker, row)));
    return { items, freshness: freshness("broker", res.at, accountId, summary.broker) };
  }

  /**
   * Convert a position between products (Intraday MIS and carry NRML). Paper: the paper engine moves the quantity (no
   * order, no fill). Live: no broker adapter maps a conversion yet, so it is refused with where to do it. Refused
   * while the kill switch is on (a conversion keeps risk open past the square-off). Audited.
   * @param {{ account: string, symbol: string, from: string, to: string, quantity?: number, lots?: number, mode?: string }} raw
   */
  async function convertPosition(ctx, raw) {
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const bad = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
    if (typeof body.account !== "string" || !ACCOUNT_RE.test(body.account)) throw bad("account", "account is required: the account id from your config.");
    if (typeof body.symbol !== "string" || !body.symbol) throw bad("symbol", "symbol is required.");
    const PRODUCTS = ["INTRADAY", "MARGIN", "CNC"];
    if (!PRODUCTS.includes(body.from) || !PRODUCTS.includes(body.to) || body.from === body.to) throw bad("to", "from and to must be two different products: INTRADAY, MARGIN or CNC.");
    if ((body.quantity === undefined) === (body.lots === undefined)) throw bad("quantity", "Send exactly one of quantity (units) or lots.");
    const { summary } = accountFor(ctx, body.account);
    const mode = readMode(summary, body.mode);
    if (mode === "live") {
      throw new BridgeError("CAPABILITY_UNSUPPORTED", `Converting a live position is not supported through the Bridge for ${summary.broker} yet. Convert it in your broker's app or terminal.`);
    }
    if (deps.safety.killSwitchStatus?.()?.engaged) throw new BridgeError("KILL_SWITCH_ACTIVE", "The kill switch is on, so positions are not converted. Release it on the Safety page first.");
    let resolved;
    try {
      resolved = await deps.symbols.resolve(body.symbol);
    } catch (err) {
      throw new BridgeError("SYMBOL_NOT_FOUND", err?.detail ?? `${body.symbol} could not be found.`);
    }
    const lot = Number(resolved.lotSize) > 0 ? Number(resolved.lotSize) : 1;
    const quantity = body.lots !== undefined ? Number(body.lots) * lot : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) throw bad("quantity", "quantity must be a whole number above zero.");
    if (quantity % lot !== 0) throw bad("quantity", `quantity must be a whole number of lots (lot ${lot}).`);
    if (typeof deps.paper?.convert !== "function") throw new BridgeError("CAPABILITY_UNSUPPORTED", "This Bridge's paper engine cannot convert positions.");
    const out = await deps.paper.convert(summary.id, { symbol: resolved.canonical, from: body.from, to: body.to, quantity });
    // At once, before anything else is awaited: the trigger engine moves the position's stops and targets with the units.
    try {
      bus.emit("position.converted", { accountId: summary.id, mode: "paper", symbol: resolved.canonical, from: body.from, to: body.to, quantity, at: out.at });
    } catch (err) {
      log.warn("position.converted could not be announced", { code: err?.code ?? "ERROR" });
    }
    await audit(ctx, "position.converted", { accountId: summary.id, data: { mode: "paper", symbol: resolved.canonical, from: body.from, to: body.to, quantity } });
    return { accountId: summary.id, mode: "paper", symbol: resolved.canonical, from: body.from, to: body.to, quantity, at: out.at, fromNetQty: out.from.netQty, toNetQty: out.to.netQty };
  }

  async function holdings(ctx, accountId) {
    const { summary } = accountFor(ctx, accountId);
    if (summary.broker === "paper") return { items: [], freshness: freshness("paper", now(), accountId, "paper") };
    const res = await brokerRead(accountId, "fetchHoldings", [], "holdings");
    const items = await mapRows(res.data, async (row) => toHolding(row, await symbolFor(deps.symbols, summary.broker, row)));
    return { items, freshness: freshness("broker", res.at, accountId, summary.broker) };
  }

  async function funds(ctx, accountId, { mode } = {}) {
    const { summary } = accountFor(ctx, accountId);
    if (readMode(summary, mode) === "paper") {
      const f = await deps.paper.funds(accountId);
      return { funds: toFunds(f), freshness: freshness("paper", now(), accountId, "paper") };
    }
    const res = await brokerRead(accountId, "fetchFunds", [], "funds");
    return { funds: toFunds(res.data), freshness: freshness("broker", res.at, accountId, summary.broker) };
  }

  // ───────────────────────────── preview and tickets ─────────────────────────────

  async function preview(ctx, raw) {
    const req = parseOrderRequest(raw);
    ctx.requireAccountAccess(req.account);
    const body = orderBody(req);
    const p = await prepare(ctx, body, { confirmToken: req.confirmToken, forPlace: false });
    let ticketId = null;
    const requiresHumanConfirmation = p.needsConfirmation && !p.confirmed;
    if (requiresHumanConfirmation && p.blocks.length === 0) {
      const t = tickets.open({
        order: body,
        accountId: p.summary.id,
        fingerprint: p.fp,
        source: effectiveSource(ctx) === "mcp" || ctx.source === "webhook" ? effectiveSource(ctx) : "rest",
        client: ctx.key?.label ?? ctx.principal?.label ?? ctx.principal?.id ?? "unknown",
        principalId: principalKey(ctx),
        checks: p.checks,
        estimatedValue: p.estimatedValue,
      });
      ticketId = t.ticketId;
      try {
        // A person must approve this on this computer. The announcement carries no confirm token.
        bus.emit("ticket.prepared", { ticketId, accountId: p.summary.id, mode: p.decision.requested, symbol: body.symbol, side: body.side, quantity: p.quantity, estimatedValue: p.estimatedValue, source: effectiveSource(ctx), client: ctx.key?.label ?? ctx.principal?.label ?? ctx.principal?.id ?? "unknown", expiresAt: t.expiresAt });
      } catch (err) {
        log.warn("ticket.prepared could not be announced", { code: err?.code ?? "ERROR" });
      }
      await audit(ctx, "ticket.created", { accountId: p.summary.id, data: { ticketId, order: { symbol: body.symbol, side: body.side, quantity: p.quantity, mode: p.decision.requested }, estimatedValue: p.estimatedValue } });
    }
    return {
      ok: p.blocks.length === 0,
      mode: p.decision.requested,
      checks: p.checks,
      margin: await previewMargin(p),
      resolved: publicInstrument(p.resolved),
      quantity: p.quantity,
      estimatedValue: p.estimatedValue,
      ltp: p.ltp,
      confirmToken: null,
      confirmExpiresAt: null,
      requiresHumanConfirmation,
      ticketId,
    };
  }

  /**
   * The margin a paper order would block, from the paper engine's own model (the figure its fill will use). Live
   * orders: null (the broker decides; basket-margin adapters are a later addition). Never throws: no figure → null.
   */
  async function previewMargin(p) {
    const live = p.decision.requested === "live" && p.summary.broker !== "paper";
    if (live || !p.resolved || !Number.isFinite(p.quantity) || p.quantity <= 0 || typeof deps.paper?.estimateOrderMargin !== "function") return null;
    try {
      const order = { ...p.effective, symbol: p.resolved.canonical, quantity: p.quantity, resolved: p.resolved };
      const px = p.effective?.price ?? p.effective?.triggerPrice ?? p.ltp;
      const required = await deps.paper.estimateOrderMargin(p.summary.id, order, Number.isFinite(px) ? px : undefined);
      return Number.isFinite(required) ? { required, source: "paper-model" } : null;
    } catch {
      return null;
    }
  }

  function requireAdmin(ctx) {
    if (ctx.principal?.kind === "local") return;
    if (!ctx.scopes?.has("admin")) throw new BridgeError("SCOPE_REQUIRED", 'This needs an API key with the "admin" scope.');
  }

  async function listTickets(ctx, { state = "open" } = {}) {
    requireAdmin(ctx);
    if (state === "rejected") return tickets.listRejected();
    return tickets.list();
  }

  /** Decline a pending ticket (the person's "no"). Same people-only rules as confirming; see TicketBook.reject. */
  async function rejectTicket(ctx, ticketId, { reason } = {}) {
    requireAdmin(ctx);
    if (isAutomatedContext(ctx)) throw new BridgeError("SCOPE_REQUIRED", "Only a person using the Bridge on this computer can decline an order.");
    if (!ctx.loopback) throw new BridgeError("LOOPBACK_ONLY", "Orders can only be declined from this computer.");
    if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > REJECT_REASON_MAX)) {
      throw new BridgeError("VALIDATION_FAILED", `The reason must be text of at most ${REJECT_REASON_MAX} characters.`, { errors: [{ path: "reason", message: `at most ${REJECT_REASON_MAX} characters` }] });
    }
    const by = principalKey(ctx);
    const r = tickets.reject(String(ticketId ?? ""), by, reason);
    if (!r.alreadyRejected) {
      const o = r.ticket.order;
      // No token exists for a declined ticket, so nothing secret is in the record. The reason is the person's own words.
      await audit(ctx, "ticket.rejected", { accountId: r.accountId, data: { ticketId: r.ticket.ticketId, account: r.accountId, symbol: o.symbol, side: o.side, mode: o.mode ?? "paper", by, reason: r.ticket.reason } });
      bus.emit("ticket.rejected", { ticketId: r.ticket.ticketId, accountId: r.accountId, principal: r.principalId });
    }
    return r.ticket;
  }

  /**
   * Where a ticket stands, for the client that prepared it (an admin key may ask about any). A ticket this caller did
   * not prepare, or one the Bridge no longer remembers, is "unknown": the answer never reveals other clients' tickets.
   */
  async function ticketStatus(ctx, ticketId) {
    const id = String(ticketId ?? "");
    const st = tickets.statusOf(id);
    const mine = st && (st.principalId === principalKey(ctx) || ctx.scopes?.has("admin"));
    if (!mine) return { ticketId: id, status: "unknown", reason: null, expiresAt: null };
    return { ticketId: id, status: st.status, reason: st.reason, expiresAt: st.expiresAt };
  }

  async function confirmTicket(ctx, ticketId) {
    requireAdmin(ctx);
    if (isAutomatedContext(ctx)) throw new BridgeError("SCOPE_REQUIRED", "Only a person using the Bridge on this computer can confirm an order.");
    if (!ctx.loopback) throw new BridgeError("LOOPBACK_ONLY", "Orders can only be confirmed from this computer.");
    // The client that prepared an order may not confirm it itself: a confirmation must come from someone else
    // (the person, through the dashboard, the CLI or another admin client), or it confirms nothing.
    if (ctx.principal?.kind !== "local" && tickets.principalOf(ticketId) === principalKey(ctx)) {
      throw new BridgeError("SCOPE_REQUIRED", "The client that prepared this order cannot confirm it. Confirm it in the Bridge dashboard or with a different key.");
    }
    const r = tickets.confirm(String(ticketId ?? ""), principalKey(ctx));
    await audit(ctx, "ticket.confirmed", { accountId: r.ticket.order.account, data: { ticketId, order: { symbol: r.ticket.order.symbol, side: r.ticket.order.side, mode: r.ticket.order.mode ?? "paper" } } });
    // No token on the bus: only the preparing client can act on it, and only through place(..., { ticketId }).
    bus.emit("ticket.confirmed", { ticketId: r.ticket.ticketId, accountId: r.accountId, principal: r.principalId });
    return { confirmToken: r.confirmToken, expiresAt: r.expiresAt };
  }

  // ───────────────────────────── kill switch ─────────────────────────────

  const offKill = bus.on("safety.kill_switch", (p) => {
    if (!p?.engaged || !p.cancelOpenOrders || closed) return;
    // SafetyGuard decided who may cancel and on which accounts (cancelScope). Without a scope (an older emitter),
    // cancel only orders the Bridge placed, on every account.
    const scope = p.cancelScope ?? { accounts: "*", includeExternal: false };
    const allowed = scope.accounts === "*" ? null : new Set(Array.isArray(scope.accounts) ? scope.accounts : []);
    const scopedCtx = {
      ...systemCtx,
      requireAccountAccess(accountId) {
        if (allowed && !allowed.has(accountId)) throw new BridgeError("ACCOUNT_FORBIDDEN", `The kill switch request may not use account ${accountId}.`);
      },
    };
    setImmediate(() => {
      cancelAll(scopedCtx, { bridgeOnly: scope.includeExternal !== true })
        .then((r) => log.warn("kill switch: open orders cancelled", { cancelled: r.cancelled.length, failed: r.failed.length }))
        .catch((err) => log.error("kill switch: cancel-all failed", { code: err?.code ?? "ERROR" }));
    });
  });

  load();
  if (unknownAccounts().size) scheduleReconcile();

  return {
    preview,
    place,
    modify,
    cancel,
    cancelAll,
    get,
    getByClientId,
    list,
    trades,
    positions,
    convertPosition,
    holdings,
    funds,
    tickets: listTickets,
    confirmTicket,
    rejectTicket,
    ticketStatus,
    // ── internal helpers (not part of the contract) ──
    /** The set-aside order records still waiting for the owner, or null (health, doctor, dashboard). */
    stateDamage: () => stateFile?.damage() ?? null,
    /** The owner checked the broker's order book: live orders may go again. @returns {boolean} whether there was damage */
    acknowledgeStateDamage: () => stateFile?.acknowledge() ?? false,
    /** Run one reconciliation pass now (tests, `doctor`). */
    reconcileNow,
    /** Stop timers and the kill-switch subscription (module stop). */
    close() {
      closed = true;
      offKill();
      if (reconcileTimer) timers.clear(reconcileTimer);
      reconcileTimer = null;
    },
  };
}
