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
 *  account.login_needed { accountId, label, broker, method, reason, kind, endsAt? }   morning reminder (accounts/morningLogin.mjs):
 *                        reason missing|expired|error|ends_before_close, kind preopen|ending_soon; no secrets, label only
 *  order.updated       { orderId, clientOrderId?, accountId, mode, status, brokerStatus?, filledQuantity, avgPrice?, source,
 *                        realisedPnl? }   realisedPnl: P&L realised by this fill (paper), for daily-loss tracking
 *  order.outcome_unknown { orderId, accountId, clientOrderId?, since }
 *  safety.kill_switch  { engaged, reason, by, at, cancelOpenOrders }   OrderService listens and runs cancelAll when asked
 *  safety.limit        { accountId, limit, value, threshold }
 *  limits.throttled    { accountId, endpointClass, retryAfterMs, upstream: boolean }
 *  audit.appended      { seq, type, accountId? }
 *  config.warning      { message }
 *  backup.completed    { kind, at, path, bytes, files, includesSecrets }   a backup was written (no file contents)
 *  backup.failed       { kind, at, message }                               a backup could not be written
 *  download.progress   { id, name, status, reason, total, done, failed, rows, bytes, etaSec, current, dataset }   a download job moved (throttled)
 *  download.done       { id, name, files, rows, bytes, dataClass, source, dataset }   a download job finished
 *  download.failed     { id, name, reason, message, failed, dataset }   a download job ended with failed items, or stopped (disk limit)
 *  key.revoked         { keyId }                    StreamHub closes WS/SSE connections opened with this key
 *  ticket.confirmed    { ticketId, accountId, principal }   a person confirmed an order ticket (no token in the payload)
 *  ticket.rejected     { ticketId, accountId, principal }   a person declined an order ticket (principal: who prepared it)
 *  hook.rejected       { hookId, label, source, signalId, stage: "order"|"receive", outcome, code, reason, symbol, side, accountId, mode, at }
 *                      a webhook alert that was accepted (202) but did not end in an order (rejected, failed, outcome unknown,
 *                      dropped), or was refused at the door as stale, unreadable or because the queue was full; never a test alert
 *                      and never a wrong passphrase. No alert body, token or passphrase is in it.
 *  position.converted  { accountId, mode, symbol, from, to, quantity, at }   units moved between products
 *  trading.readiness   account readiness change; notify only when `notify: true`
 *  ticket.prepared     { ticketId, accountId, mode, symbol, side, quantity, estimatedValue, source, client, expiresAt }   an order waits for a
 *                      person to approve it (never carries a confirm token)
 *  hook.rejected       { hookId?, label?, source?, reason, code?, symbol?, side? }   a webhook alert did not become an order (after the 202)
 *  hook.stale          { hookId?, label?, source?, reason?, symbol?, side? }          an alert was too old to trade on
 *  hook.failed         { hookId?, label?, source?, reason, code?, symbol?, side? }    an accepted alert's order could not be made
 *  collection.changed  { action: "created"|"updated"|"renamed"|"deleted", id, name, kind, tags, from?, imported? }   a collection was written (no symbol lists)
 *  download.progress   { id, name, status, progress }  throttled; download.done / download.failed { id, name, status, reason? }   (downloads module)
 *  recording.started|stopped|gap|disk_low  { id, name, kind, ... }                                                              (recorder module)
 *  The events module (events/catalog.mjs) offers most of these topics to other programs; ticks and key events are never offered.
 */
export const TOPICS = Object.freeze([
  "tick",
  "stream.status",
  "account.status",
  "account.session_rejected",
  "account.login_needed",
  "order.updated",
  "order.outcome_unknown",
  "safety.kill_switch",
  "safety.limit",
  "limits.throttled",
  "audit.appended",
  "config.warning",
  "backup.completed",
  "backup.failed",
  "download.progress",
  "download.done",
  "download.failed",
  "key.revoked",
  "ticket.confirmed",
  "ticket.rejected",
  "hook.rejected",
  "position.converted",
  "trading.readiness",
  "ticket.prepared",
  "hook.rejected",
  "hook.stale",
  "hook.failed",
  "collection.changed",
  "download.progress",
  "download.done",
  "download.failed",
  "recording.started",
  "recording.stopped",
  "recording.gap",
  "recording.disk_low",
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
