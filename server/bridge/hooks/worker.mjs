/**
 * Signal worker — stream S11. A bounded in-memory queue between the webhook receivers (which must answer within
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
 *     confirmations panel; nothing is placed without a human (see "needs" in the S11 report for the hand-off).
 *
 * Nothing is retried automatically. Each signal gets a deterministic Idempotency-Key, so a duplicate that slips past
 * the receiver's dedupe window still cannot become a second order (OrderService keeps keys for the IST day).
 *
 * @typedef {"queued"|"processing"|"placed"|"duplicate"|"awaiting_confirmation"|"rejected"|"failed"|"outcome_unknown"|"dropped"} SignalStatus
 * @typedef {{ signalId: string, hookId: string, index: number, status: SignalStatus, receivedAt: number, finishedAt: number | null,
 *   symbol: string, side: string | null, orderId: string | null, ticketId: string | null, mode: string | null,
 *   code: string | null, reason: string | null }} SignalRecord
 * @typedef {{ signalId: string, hookId: string, index: number, signal: import("./receivers/common.mjs").Signal,
 *   idempotencyKey: string, receivedAt: number }} Job
 */
import { createCallContext } from "../core/context.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";

const RECENT_MAX = 500;

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
 *   queueSize: number, concurrency: number, now?: () => number }} opts
 */
export function createSignalWorker({ deps, store, logger, queueSize, concurrency, now = () => Date.now() }) {
  /** @type {Job[]} */
  const queue = [];
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
    if (active === 0 && queue.length === 0) {
      const w = idleWaiters;
      idleWaiters = [];
      for (const f of w) f();
    }
  };

  /** Resolve symbol + lot size. */
  async function resolveInstrument(symbol) {
    if (!deps.symbols || isStub(deps.symbols)) throw new SignalRefused("SYMBOL_NOT_FOUND", "Instrument data is not available yet, so the lot size cannot be checked.");
    try {
      const r = await deps.symbols.resolve(symbol, {});
      return { canonical: r.canonical, lotSize: Number(r.lotSize) || 1 };
    } catch (err) {
      throw new SignalRefused(err?.code === "VALIDATION_FAILED" ? "SYMBOL_NOT_FOUND" : (err?.code ?? "SYMBOL_NOT_FOUND"), `${symbol} could not be resolved: ${err?.detail ?? err?.message ?? "unknown symbol"}`);
    }
  }

  /**
   * Build the OrderRequest a signal is allowed to make under its hook.
   * @param {import("./hookStore.mjs").HookRecord} hook
   * @param {import("./receivers/common.mjs").Signal} s
   */
  async function buildOrder(hook, s) {
    if (hook.side && s.side && s.side !== hook.side) throw new SignalRefused("SIDE_NOT_ALLOWED", `This hook only places ${hook.side} orders; the alert asked to ${s.side}.`);
    const side = hook.side ?? s.side;
    if (!side) throw new SignalRefused("VALIDATION_FAILED", "The alert does not say buy or sell, and the hook has no fixed side.");
    const inst = await resolveInstrument(s.symbol);
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

  /** @param {Job} job */
  async function run(job) {
    const hook = store.get(job.hookId);
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
      const ctx = hookContext(hook, job.signalId);
      const order = await buildOrder(hook, job.signal);
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
    await audit(hook, rec);
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
     * @param {Job[]} jobs
     * @throws {BridgeError} RATE_LIMITED when the queue cannot take them all; BROKER_UNAVAILABLE while stopping
     */
    enqueue(jobs) {
      if (!accepting) throw new BridgeError("BROKER_UNAVAILABLE", "The Bridge is shutting down; send the alert again shortly.", { retryAfterMs: 5000 });
      if (queue.length + jobs.length > queueSize) throw new BridgeError("RATE_LIMITED", "Too many alerts are waiting to be processed. Try again shortly.", { retryAfterMs: 2000 });
      for (const j of jobs) {
        queue.push(j);
        record({ signalId: j.signalId, hookId: j.hookId, index: j.index, status: "queued", receivedAt: j.receivedAt, finishedAt: null, symbol: j.signal.symbol, side: j.signal.side, orderId: null, ticketId: null, mode: null, code: null, reason: null });
      }
      setImmediate(pump);
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
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },

    stats() {
      return { queued: queue.length, active, capacity: queueSize };
    },

    /**
     * Stop accepting; let running signals finish (up to `timeoutMs`); signals still queued are dropped and audited
     * as such (they were acknowledged, so the user must see that they did not run).
     */
    async stop({ timeoutMs = 5000 } = {}) {
      accepting = false;
      offConfirmed();
      const left = queue.splice(0);
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
