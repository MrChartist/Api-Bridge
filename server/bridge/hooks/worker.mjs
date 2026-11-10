/**
 * Signal worker. A bounded in-memory queue between the webhook receivers (which must answer within
 * milliseconds) and the order path (which may wait on safety checks, rate limits and the broker).
 *
 * For each signal it applies the hook's fixed mapping and caps, then calls OrderService with source "webhook":
 *   - side: the hook's side when set (a signal asking for the other side is refused), else the signal's side;
 *   - symbol: resolved through SymbolService to a canonical symbol and lot size; must be in allowedSymbols if any;
 *   - size: lots from the signal, else quantity / lot size (must divide exactly), else one lot; above
 *     maxLotsPerSignal is refused, never trimmed;
 *   - product: the hook's product when set (a signal asking for another is refused), else the signal's; required;
 *   - order type: the hook's (LIMIT needs a price in the alert; MARKET orders get the configured protection);
 *   - mode: the hook's mode. "live" still needs every live opt-in in the config; OrderService refuses otherwise;
 *   - confirmation: hooks with requireConfirmation only PREVIEW, which opens a ticket in the dashboard's Pending
 *     confirmations panel; nothing is placed without a human.
 *
 * Nothing is retried blindly. The one exception is an order refused by the per-account order-rate cap (ORDER_RATE_LIMITED):
 * that refusal happens before anything reaches a broker, so the signal waits (queued, bounded by `burstWaitSec` and the
 * queue size) and is tried again; past the wait it is reported as rejected. The age of the alert is checked again on
 * every try (hook.maxAgeSec). Each signal gets a deterministic Idempotency-Key (and, for TradingView, a derived
 * clientOrderId), so a duplicate that slips past the receiver's dedupe window still cannot become a second order
 * (OrderService keeps keys for the IST day).
 *
 * A signal that does not end well after the 202 (rejected, failed, outcome unknown, dropped) is announced on the event
 * bus as `hook.rejected` (payload below), so a notifier can tell the person; a test alert is never announced.
 *   hook.rejected { hookId, label, source, signalId, stage: "order"|"receive", outcome, code, reason, symbol, side,
 *                   accountId, mode, at }
 *
 * @typedef {"queued"|"processing"|"placed"|"duplicate"|"awaiting_confirmation"|"rejected"|"failed"|"outcome_unknown"|"dropped"} SignalStatus
 * @typedef {{ signalId: string, hookId: string, index: number, status: SignalStatus, receivedAt: number, finishedAt: number | null,
 *   symbol: string, side: string | null, orderId: string | null, ticketId: string | null, mode: string | null,
 *   code: string | null, reason: string | null }} SignalRecord
 * @typedef {{ signalId: string, hookId: string, index: number, signal: import("./receivers/common.mjs").Signal,
 *   idempotencyKey: string, receivedAt: number, clientOrderId?: string, test?: boolean, attempt?: number,
 *   firstTriedAt?: number }} Job
 */
import { createCallContext } from "../core/context.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { isDatedCanonical } from "./receivers/tradingview.mjs";

const RECENT_MAX = 500;
const RATE_RETRY_MAX_DELAY_MS = 2000;

/** A refusal decided by the worker (not an HTTP error: the 202 was already sent). */
class SignalRefused extends Error {
  /** @param {string} code @param {string} reason */
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

/**
 * @param {{ deps: any, store: ReturnType<typeof import("./hookStore.mjs").createHookStore>, logger: any,
 *   queueSize: number, concurrency: number, now?: () => number, burstWaitSec?: number,
 *   onUpdate?: (rec: SignalRecord) => void }} opts
 */
export function createSignalWorker({ deps, store, logger, queueSize, concurrency, now = () => Date.now(), burstWaitSec = 0, onUpdate }) {
  /** @type {Job[]} */
  const queue = [];
  /** Jobs waiting for an order-rate slot: job -> timer. They count against the queue size. @type {Map<Job, any>} */
  const delayed = new Map();
  /** @type {Map<string, SignalRecord>} insertion-ordered, bounded */
  const recent = new Map();
  let active = 0;
  let accepting = true;
  /** @type {Array<() => void>} */
  let idleWaiters = [];

  /**
   * Signals waiting for a person to confirm their ticket: ticketId -> what is needed to finish them. Bounded; a ticket
   * that is never confirmed expires in the order service and its entry ages out here.
   * @type {Map<string, { hookId: string, order: object, idempotencyKey: string, rec: SignalRecord, at: number }>}
   */
  const awaiting = new Map();
  const AWAITING_TTL_MS = 10 * 60_000;

  const record = (rec) => {
    recent.set(`${rec.signalId}#${rec.index}`, rec);
    while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
    try {
      onUpdate?.(rec);
    } catch (err) {
      logger.warn("hook signal log failed", { message: err?.message });
    }
  };

  /** Tell the event bus about a signal that did not end well (never for a test alert). */
  const announce = (hook, rec, job) => {
    if (job?.test || !["rejected", "failed", "outcome_unknown", "dropped"].includes(rec.status) || rec.code === "TICKET_REJECTED") return;
    try {
      deps.bus?.emit?.("hook.rejected", {
        hookId: rec.hookId,
        label: hook?.label ?? null,
        source: hook?.source ?? null,
        signalId: rec.signalId,
        stage: "order",
        outcome: rec.code === "ALERT_STALE" ? "stale" : rec.status,
        code: rec.code,
        reason: rec.reason,
        symbol: rec.symbol,
        side: rec.side,
        accountId: hook?.account ?? null,
        mode: rec.mode ?? hook?.mode ?? null,
        at: rec.finishedAt ?? now(),
      });
    } catch (err) {
      logger.warn("hook.rejected could not be announced", { message: err?.message });
    }
  };

  const audit = async (hook, rec) => {
    if (!deps.audit || isStub(deps.audit)) return;
    try {
      await deps.audit.append({
        type: "hook.signal",
        actor: { kind: "hook", id: rec.hookId },
        source: "webhook",
        accountId: hook?.account ?? null,
        requestId: rec.signalId,
        data: { hookId: rec.hookId, signalId: rec.signalId, index: rec.index, status: rec.status, symbol: rec.symbol, side: rec.side, orderId: rec.orderId, ticketId: rec.ticketId, code: rec.code, reason: rec.reason },
      });
    } catch (err) {
      logger.warn("hook signal could not be audited", { signalId: rec.signalId, code: err?.code });
    }
  };

  const settleIdle = () => {
    if (active === 0 && queue.length === 0 && delayed.size === 0) {
      const w = idleWaiters;
      idleWaiters = [];
      for (const f of w) f();
    }
  };

  /**
   * Resolve symbol + lot size. A charting ticker (from "chart": NSE:M_M, NSE:NIFTY1!) goes through the chart mapping.
   * When the symbol service can explain how it read a name (candidates) and the name fits more than one instrument,
   * the signal is refused instead of guessed.
   * @param {string} symbol @param {string | null | undefined} from
   */
  async function resolveInstrument(symbol, from) {
    if (!deps.symbols || isStub(deps.symbols)) throw new SignalRefused("SYMBOL_NOT_FOUND", "Instrument data is not available yet, so the lot size cannot be checked.");
    const options = from === "chart" && !isDatedCanonical(symbol) ? { from: "chart" } : {};
    try {
      if (typeof deps.symbols.explain === "function") {
        const ex = await Promise.resolve().then(() => deps.symbols.explain(symbol, options)).catch(() => null);
        const cands = Array.isArray(ex?.candidates) ? ex.candidates : [];
        if (cands.length > 1 && !ex?.canonical) {
          throw new SignalRefused("SYMBOL_AMBIGUOUS", `${symbol} could mean more than one instrument (${cands.slice(0, 4).map((c) => c?.canonical ?? c).join(", ")}). Nothing was guessed: send the full exchange:symbol.`);
        }
      }
      const r = await deps.symbols.resolve(symbol, options);
      return { canonical: r.canonical, lotSize: Number(r.lotSize) || 1 };
    } catch (err) {
      if (err instanceof SignalRefused) throw err;
      throw new SignalRefused(err?.code === "VALIDATION_FAILED" ? "SYMBOL_NOT_FOUND" : (err?.code ?? "SYMBOL_NOT_FOUND"), `${symbol} could not be resolved: ${err?.detail ?? err?.message ?? "unknown symbol"}`);
    }
  }

  /**
   * Build the OrderRequest a signal is allowed to make under its hook.
   * @param {import("./hookStore.mjs").HookRecord} hook
   * @param {import("./receivers/common.mjs").Signal} s
   */
  async function buildOrder(hook, s, job) {
    if (hook.side && s.side && s.side !== hook.side) throw new SignalRefused("SIDE_NOT_ALLOWED", `This hook only places ${hook.side} orders; the alert asked to ${s.side}.`);
    const side = hook.side ?? s.side;
    if (!side) throw new SignalRefused("VALIDATION_FAILED", "The alert does not say buy or sell, and the hook has no fixed side.");
    const inst = await resolveInstrument(s.symbol, s.symbolFrom);
    if (hook.allowedSymbols.length && !hook.allowedSymbols.includes(inst.canonical)) {
      throw new SignalRefused("SYMBOL_NOT_ALLOWED", `${inst.canonical} is not in this hook's allowed symbols.`);
    }
    let lots;
    if (s.lots !== null) lots = s.lots;
    else if (s.quantity !== null) {
      if (s.quantity % inst.lotSize !== 0) throw new SignalRefused("INVALID_ORDER", `quantity ${s.quantity} is not a multiple of the lot size ${inst.lotSize} for ${inst.canonical}.`);
      lots = s.quantity / inst.lotSize;
    } else lots = 1;
    if (lots > hook.maxLotsPerSignal) {
      throw new SignalRefused("LOTS_CAP_EXCEEDED", `The alert asked for ${lots} lot(s); this hook allows at most ${hook.maxLotsPerSignal} per signal. Nothing was placed.`);
    }
    if (hook.product && s.product && s.product !== hook.product) throw new SignalRefused("PRODUCT_NOT_ALLOWED", `This hook places ${hook.product} orders; the alert asked for ${s.product}.`);
    const product = hook.product ?? s.product;
    if (!product) throw new SignalRefused("VALIDATION_FAILED", "No product: set it on the hook (CNC, INTRADAY or MARGIN) or send it in the alert.");
    if (s.orderType && s.orderType !== hook.orderType) throw new SignalRefused("ORDER_TYPE_NOT_ALLOWED", `This hook places ${hook.orderType} orders; the alert asked for ${s.orderType}.`);
    const order = { account: hook.account, symbol: inst.canonical, side, lots, product, orderType: hook.orderType, mode: hook.mode, tag: hook.id };
    if (job?.clientOrderId) order.clientOrderId = job.clientOrderId;
    if (hook.orderType === "LIMIT") {
      if (s.price === null) throw new SignalRefused("VALIDATION_FAILED", "This hook places LIMIT orders, so the alert must carry a price.");
      order.price = s.price;
    }
    return order;
  }

  function hookContext(hook, requestId) {
    return createCallContext({
      source: "webhook",
      principal: { kind: "hook", id: hook.id, label: hook.label },
      scopes: [hook.mode === "live" ? "live" : "paper"],
      hookAccounts: [hook.account],
      log: logger,
      requestId,
      confirmationRequired: hook.requireConfirmation === true,
    });
  }

  /** Finish a signal whose ticket a person has just confirmed: place exactly the prepared order, once. */
  async function finishConfirmed(ticketId, entry) {
    const hook = store.get(entry.hookId);
    const rec = { ...entry.rec, status: "processing", finishedAt: null };
    record(rec);
    try {
      if (!hook) throw new SignalRefused("NOT_FOUND", "The hook was deleted before its ticket was confirmed.");
      const r = await deps.orders.place(hookContext(hook, rec.signalId), entry.order, { ticketId, idempotencyKey: entry.idempotencyKey });
      rec.status = r.replayed ? "duplicate" : "placed";
      rec.orderId = r.order?.orderId ?? null;
      rec.mode = r.order?.mode ?? rec.mode;
      rec.code = null;
      rec.reason = null;
    } catch (err) {
      rec.status = err instanceof BridgeError && err.code === "OUTCOME_UNKNOWN" ? "outcome_unknown" : err instanceof BridgeError && err.status < 500 ? "rejected" : "failed";
      rec.code = err?.code ?? "INTERNAL";
      rec.reason = err instanceof BridgeError ? err.detail : err instanceof SignalRefused ? err.message : "The confirmed signal could not be placed.";
      if (!(err instanceof BridgeError) && !(err instanceof SignalRefused)) logger.error("confirmed hook signal failed", { signalId: rec.signalId, err });
    }
    rec.finishedAt = now();
    record(rec);
    logger.info("hook signal confirmed", { signalId: rec.signalId, hookId: rec.hookId, status: rec.status, orderId: rec.orderId ?? undefined });
    await audit(hook, rec);
    announce(hook, rec, null);
  }

  const offConfirmed =
    deps.bus?.on?.("ticket.confirmed", (p) => {
      const entry = awaiting.get(p?.ticketId);
      if (!entry || p.principal !== `hook:${entry.hookId}`) return;
      awaiting.delete(p.ticketId);
      active += 1;
      setImmediate(() => {
        finishConfirmed(p.ticketId, entry)
          .catch((err) => logger.error("hook worker crashed", { err }))
          .finally(() => {
            active -= 1;
            settleIdle();
          });
      });
    }) ?? (() => {});

  // A person declined the ticket: the signal is over (status "rejected"), nothing was or will be sent.
  const offRejected =
    deps.bus?.on?.("ticket.rejected", (p) => {
      const entry = awaiting.get(p?.ticketId);
      if (!entry || p.principal !== `hook:${entry.hookId}`) return;
      awaiting.delete(p.ticketId);
      const rec = entry.rec;
      rec.status = "rejected";
      rec.code = "TICKET_REJECTED";
      rec.reason = "You declined this order in the Bridge. Nothing was sent.";
      rec.finishedAt = now();
      record(rec);
      logger.info("hook signal declined", { signalId: rec.signalId, hookId: rec.hookId });
      audit(store.get(entry.hookId), rec).catch((err) => logger.warn("declined hook signal could not be audited", { code: err?.code }));
    }) ?? (() => {});

  /** A hook as one job sees it: a test alert always runs as a paper order that needs no confirmation. */
  const effectiveHook = (hook, job) => (hook && job.test ? { ...hook, mode: "paper", requireConfirmation: false } : hook);

  /** Put a job back for another try after `delayMs`; false when its waiting budget is used up. */
  function scheduleRetry(job, err, rec) {
    if (!accepting || !burstWaitSec) return false;
    const attempt = (job.attempt ?? 0) + 1;
    const delay = Math.min(RATE_RETRY_MAX_DELAY_MS, Math.max(100, Number(err?.retryAfterMs) || 250 * 2 ** (attempt - 1)));
    const first = job.firstTriedAt ?? now();
    if (now() + delay - first > burstWaitSec * 1000) return false;
    job.attempt = attempt;
    job.firstTriedAt = first;
    rec.status = "queued";
    rec.finishedAt = null;
    rec.code = "ORDER_RATE_LIMITED";
    rec.reason = `Waiting for a free order slot on the account (try ${attempt}). Orders are paced so a burst of alerts is not lost.`;
    record(rec);
    const timer = setTimeout(() => {
      delayed.delete(job);
      queue.unshift(job);
      setImmediate(pump);
    }, delay);
    timer.unref?.();
    delayed.set(job, timer);
    return true;
  }

  /** @param {Job} job */
  async function run(job) {
    const storedHook = store.get(job.hookId);
    const hook = effectiveHook(storedHook, job);
    /** @type {SignalRecord} */
    const rec = {
      signalId: job.signalId,
      hookId: job.hookId,
      index: job.index,
      status: "processing",
      receivedAt: job.receivedAt,
      finishedAt: null,
      symbol: job.signal.symbol,
      side: job.signal.side,
      orderId: null,
      ticketId: null,
      mode: hook?.mode ?? null,
      code: null,
      reason: null,
    };
    record(rec);
    try {
      if (!hook) throw new SignalRefused("NOT_FOUND", "The hook was deleted before the signal was processed.");
      if (hook.maxAgeSec && job.signal.timeMs && !job.test) {
        const age = now() - job.signal.timeMs;
        if (age > hook.maxAgeSec * 1000) throw new SignalRefused("ALERT_STALE", `The alert is ${Math.round(age / 1000)} seconds old and this hook only accepts alerts up to ${hook.maxAgeSec} seconds old. Nothing was placed.`);
      }
      const ctx = hookContext(hook, job.signalId);
      const order = await buildOrder(hook, job.signal, job);
      rec.symbol = order.symbol;
      rec.side = order.side;
      if (hook.requireConfirmation) {
        const pv = await deps.orders.preview(ctx, order);
        if (pv.ticketId) {
          rec.status = "awaiting_confirmation";
          rec.ticketId = pv.ticketId;
          rec.reason = "Waiting for your confirmation in the Bridge (Pending confirmations).";
          const t = now();
          for (const [id, a] of awaiting) if (t - a.at > AWAITING_TTL_MS || awaiting.size >= RECENT_MAX) awaiting.delete(id);
          awaiting.set(pv.ticketId, { hookId: hook.id, order, idempotencyKey: job.idempotencyKey, rec, at: t });
        } else {
          const block = (pv.checks ?? []).find((c) => c.severity === "block");
          throw new SignalRefused(block?.code ?? "INVALID_ORDER", block?.message ?? "The order failed its checks.");
        }
      } else {
        const r = await deps.orders.place(ctx, order, { idempotencyKey: job.idempotencyKey });
        rec.status = r.replayed ? "duplicate" : "placed";
        rec.orderId = r.order?.orderId ?? null;
        rec.mode = r.order?.mode ?? rec.mode;
      }
    } catch (err) {
      if (err?.code === "ORDER_RATE_LIMITED" && (err instanceof SignalRefused || err instanceof BridgeError) && scheduleRetry(job, err, rec)) return;
      if (err instanceof SignalRefused) {
        rec.status = "rejected";
        rec.code = err.code;
        rec.reason = err.message;
      } else if (err instanceof BridgeError && err.code === "IDEMPOTENCY_IN_PROGRESS") {
        // Another copy of this very signal is being placed right now; that copy decides the outcome.
        rec.status = "duplicate";
        rec.code = err.code;
        rec.reason = "The same signal is already being processed.";
      } else if (err instanceof BridgeError) {
        rec.status = err.code === "OUTCOME_UNKNOWN" ? "outcome_unknown" : err.status >= 500 ? "failed" : "rejected";
        rec.code = err.code;
        rec.reason = err.detail;
      } else {
        rec.status = "failed";
        rec.code = "INTERNAL";
        rec.reason = "The signal could not be processed.";
        logger.error("hook signal failed", { signalId: job.signalId, err });
      }
    }
    rec.finishedAt = now();
    record(rec);
    const level = rec.status === "placed" || rec.status === "awaiting_confirmation" || rec.status === "duplicate" ? "info" : "warn";
    logger[level]("hook signal", { signalId: rec.signalId, hookId: rec.hookId, index: rec.index, status: rec.status, code: rec.code ?? undefined, orderId: rec.orderId ?? undefined });
    await audit(storedHook, rec);
    announce(storedHook, rec, job);
  }

  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      run(job)
        .catch((err) => logger.error("hook worker crashed", { err }))
        .finally(() => {
          active -= 1;
          if (queue.length) setImmediate(pump);
          else settleIdle();
        });
    }
  };

  return {
    /**
     * Queue the jobs of one alert, all or none. Processing starts on the next turn of the event loop, after the
     * receiver has sent its 202.
     * With `delayMs` the jobs are held first (the hook is over its alerts-per-minute limit) and then run; while held they
     * show as queued with the reason, count against the queue size, and are dropped and audited if the Bridge stops.
     * @param {Job[]} jobs
     * @param {{ delayMs?: number, reason?: string }} [hold]
     * @throws {BridgeError} RATE_LIMITED when the queue cannot take them all; BROKER_UNAVAILABLE while stopping
     */
    enqueue(jobs, { delayMs = 0, reason = null } = {}) {
      if (!accepting) throw new BridgeError("BROKER_UNAVAILABLE", "The Bridge is shutting down; send the alert again shortly.", { retryAfterMs: 5000 });
      if (queue.length + delayed.size + jobs.length > queueSize) {
        throw new BridgeError("RATE_LIMITED", `The alert queue is full (${queueSize} alerts are waiting to be processed), so this alert was refused and nothing was placed. Try again shortly.`, { retryAfterMs: 2000 });
      }
      for (const j of jobs) {
        record({ signalId: j.signalId, hookId: j.hookId, index: j.index, status: "queued", receivedAt: j.receivedAt, finishedAt: null, symbol: j.signal.symbol, side: j.signal.side, orderId: null, ticketId: null, mode: null, code: delayMs > 0 ? "HOOK_RATE_HELD" : null, reason: delayMs > 0 ? reason : null });
        if (delayMs > 0) {
          const timer = setTimeout(() => {
            delayed.delete(j);
            queue.push(j);
            setImmediate(pump);
          }, delayMs);
          timer.unref?.();
          delayed.set(j, timer);
        } else queue.push(j);
      }
      if (delayMs <= 0) setImmediate(pump);
    },

    /** Recent signal records, newest last (diagnostics, tests). @param {{ hookId?: string }} [f] */
    recent({ hookId } = {}) {
      return [...recent.values()].filter((r) => !hookId || r.hookId === hookId).map((r) => ({ ...r }));
    },

    /** Records of one signal (one per order the alert produced). */
    get(signalId) {
      return [...recent.values()].filter((r) => r.signalId === signalId).map((r) => ({ ...r }));
    },

    /** Resolves when the queue is empty and nothing is running. */
    idle() {
      if (active === 0 && queue.length === 0 && delayed.size === 0) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },

    stats() {
      return { queued: queue.length, waitingForSlot: delayed.size, active, capacity: queueSize };
    },

    /**
     * Stop accepting; let running signals finish (up to `timeoutMs`); signals still queued are dropped and audited
     * as such (they were acknowledged, so the user must see that they did not run).
     */
    async stop({ timeoutMs = 5000 } = {}) {
      accepting = false;
      offConfirmed();
      offRejected();
      const left = queue.splice(0);
      for (const [j, timer] of delayed) {
        clearTimeout(timer);
        left.push(j);
      }
      delayed.clear();
      for (const j of left) {
        const rec = { signalId: j.signalId, hookId: j.hookId, index: j.index, status: "dropped", receivedAt: j.receivedAt, finishedAt: now(), symbol: j.signal.symbol, side: j.signal.side, orderId: null, ticketId: null, mode: null, code: "SHUTDOWN", reason: "The Bridge stopped before this signal was processed." };
        record(rec);
        logger.warn("hook signal dropped at shutdown", { signalId: j.signalId, hookId: j.hookId });
        await audit(store.get(j.hookId), rec);
      }
      if (active > 0) {
        let timer;
        await Promise.race([this.idle(), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
        clearTimeout(timer);
      }
    },
  };
}
