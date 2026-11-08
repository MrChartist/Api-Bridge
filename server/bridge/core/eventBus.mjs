/**
 * In-process event bus. Synchronous, ordered fan-out; a throwing handler is logged and never breaks the emitter
 * or the other handlers. Topics are a closed list (TOPICS) so a typo fails loudly instead of going nowhere.
 *
 * Payloads must already be safe to log (no secrets). Handlers that do slow work must hand it off (queueMicrotask,
 * setImmediate or their own queue); the bus does not await.
 */

/**
 * Topic -> payload shape (JSDoc only; the bus does not validate payloads).
 *  tick                { symbol, accountId, broker, ltp, bid?, ask?, volume?, oi?, exchangeTs?, receivedAt }
 *  stream.status       { accountId, broker, connected, state: "up"|"stale"|"down", detail?, reason?, subscriptions }
 *  account.status      { accountId, broker, session: "connected"|"expired"|"missing"|"error", expiresAt?, message? }
 *  account.session_rejected { accountId, broker, code }   scheduler saw a session error; AccountManager marks it expired
 *  order.updated       { orderId, clientOrderId?, accountId, mode, status, brokerStatus?, filledQuantity, avgPrice?, source,
 *                        realisedPnl? }   realisedPnl: P&L realised by this fill (paper), for daily-loss tracking
 *  order.outcome_unknown { orderId, accountId, clientOrderId?, since }
 *  safety.kill_switch  { engaged, reason, by, at, cancelOpenOrders }   OrderService listens and runs cancelAll when asked
 *  safety.limit        { accountId, limit, value, threshold }
 *  limits.throttled    { accountId, endpointClass, retryAfterMs, upstream: boolean }
 *  audit.appended      { seq, type, accountId? }
 *  config.warning      { message }
 *  key.revoked         { keyId }                    StreamHub closes WS/SSE connections opened with this key
 *  ticket.confirmed    { ticketId, accountId, principal }   a person confirmed an order ticket (no token in the payload)
 *  position.converted  { accountId, mode, symbol, from, to, quantity, at }   units moved between products (the trigger
 *                        engine carries a position's stops and targets with them)
 *  scan.progress       { keyId, jobId, savedId, status, progress: { total, done, matched, errors } }   scanner, at most 1/s per job
 *  scan.completed      { keyId, jobId, savedId, status, matched: string[], progress }
 *  scan.alert          { keyId, savedId, name, jobId, newMatches: string[], at }   a saved scan found symbols its last run did not
 *
 * Options-platform topics (each owning module defines its payload):
 *  recorder.status       recorder state change, at most 1/s
 *  recorder.snapshot     a recorded chain snapshot was written
 *  reference.updated     { dataset, asOf, source, changed: boolean }
 *  vol.captured          one per underlying per daily capture run
 *  trading.readiness     account readiness change; notify only when `notify: true`
 *  fno.sweep.progress    { jobId, status, progress }, at most 1/s
 *  fno.sweep.completed   { jobId, status, chains, failed, durationMs }
 *  exposure.levels       gamma levels, emitted only on change
 *  settlement.update     running / final settlement estimate
 *  charges.plan_changed  { accountId }
 *  option.alert          an alert rule fired
 *  strategy.guard        guard state change
 *  participants.updated  { date, source, changed }
 *  market.event          { type: "new" | "update", event }   a live event record or a repeat inside its cool-down
 */
export const TOPICS = Object.freeze([
  "tick",
  "stream.status",
  "account.status",
  "account.session_rejected",
  "order.updated",
  "order.outcome_unknown",
  "safety.kill_switch",
  "safety.limit",
  "limits.throttled",
  "audit.appended",
  "config.warning",
  "key.revoked",
  "ticket.confirmed",
  "position.converted",
  "scan.progress",
  "scan.completed",
  "scan.alert",
  "recorder.status",
  "recorder.snapshot",
  "reference.updated",
  "vol.captured",
  "trading.readiness",
  "fno.sweep.progress",
  "fno.sweep.completed",
  "exposure.levels",
  "settlement.update",
  "charges.plan_changed",
  "option.alert",
  "strategy.guard",
  "participants.updated",
  "market.event",
  "analytics.alert",
]);

/**
 * @typedef {{ on(topic: string, handler: (payload: any) => void): () => void, once(topic: string, handler: (payload: any) => void): () => void,
 *   emit(topic: string, payload: any): number, listenerCount(topic?: string): number }} EventBus
 */

/**
 * @param {{ logger?: { error(msg: string, f?: object): void }, topics?: readonly string[] }} [opts]
 * @returns {EventBus}
 */
export function createEventBus({ logger, topics = TOPICS } = {}) {
  const known = new Set(topics);
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  const check = (topic) => {
    if (!known.has(topic)) throw new Error(`Unknown event topic "${topic}". Known: ${[...known].join(", ")}`);
  };
  const on = (topic, handler) => {
    check(topic);
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic).add(handler);
    return () => handlers.get(topic)?.delete(handler);
  };
  return {
    on,
    once(topic, handler) {
      const off = on(topic, (p) => {
        off();
        handler(p);
      });
      return off;
    },
    emit(topic, payload) {
      check(topic);
      const set = handlers.get(topic);
      if (!set || set.size === 0) return 0;
      let n = 0;
      for (const h of [...set]) {
        try {
          h(payload);
          n += 1;
        } catch (err) {
          logger?.error("event handler failed", { topic, err });
        }
      }
      return n;
    },
    listenerCount(topic) {
      if (topic === undefined) return [...handlers.values()].reduce((s, x) => s + x.size, 0);
      return handlers.get(topic)?.size ?? 0;
    },
  };
}
