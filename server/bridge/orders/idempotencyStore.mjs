/**
 * Idempotency records and the clientOrderId map.
 *
 * Idempotency (docs/ARCHITECTURE.md §7, openapi parameter IdempotencyKey):
 *  - begin(key, fingerprint) is synchronous, so two concurrent requests with one key can never both start: the
 *    second sees IDEMPOTENCY_IN_PROGRESS (409, retryable) while the first runs.
 *  - The first request links its order id as soon as the order record exists (before any broker call), then
 *    completes. A retry with the same key and the same body replays (the caller returns that order with
 *    Idempotency-Replayed: true); a different body gets 409 IDEMPOTENCY_KEY_REUSED (or the code the caller names,
 *    e.g. DUPLICATE_CLIENT_ORDER_ID when the key came from clientOrderId).
 *  - A request refused before anything reached a broker or the paper engine releases its key, so it may be retried.
 *  - Records live until the end of the IST trading day and at least 24 hours (idempotencyExpiry).
 *  - After a restart, a record that was in progress with an order id becomes done (the order store marks that order
 *    outcome_unknown); one without an order id never reached a broker and is dropped.
 *
 * clientOrderId map: your own id → { accountId, orderId, mode, tag } per account per IST day. Brokers only take short
 * tags (Kite 20 alphanumerics, Upstox 40, Dhan correlationId), so the Bridge keeps the mapping and sends a short
 * derived tag (brokerTag) where the broker supports one.
 *
 * The store is in memory; the order service persists dump() through its state file after every change.
 */
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { idempotencyExpiry, istDay } from "./time.mjs";

/**
 * @typedef {{ key: string, fingerprint: string, state: "in_progress"|"done", orderId: string | null,
 *   accountId: string | null, mode: "paper"|"live" | null, createdAt: number, expiresAt: number }} IdempotencyRecord
 * @typedef {{ accountId: string, clientOrderId: string, day: string, orderId: string | null, mode: "paper"|"live" | null,
 *   tag: string, fingerprint: string, createdAt: number, expiresAt: number }} ClientIdRecord
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Short, alphanumeric broker tag for a clientOrderId (16 characters, fits every broker's tag field we know of).
 * Deterministic per account, IST day and clientOrderId.
 */
export function brokerTag(accountId, clientOrderId, day) {
  const h = createHash("sha256").update(`${accountId}|${day}|${clientOrderId}`).digest();
  let out = "MCB";
  for (let i = 0; out.length < 16; i += 1) out += B32[h[i] % 32];
  return out;
}

/**
 * @param {{ now: () => number }} opts
 */
export function createIdempotencyStore({ now }) {
  /** @type {Map<string, IdempotencyRecord>} */
  const records = new Map();
  /** @type {Map<string, ClientIdRecord>} keyed `${accountId}|${day}|${clientOrderId}` */
  const clientIds = new Map();

  const live = (r) => r && r.expiresAt > now();
  const cidKey = (accountId, clientOrderId, day) => `${accountId}|${day}|${clientOrderId}`;

  const store = {
    /**
     * Start (or replay) a write. Synchronous on purpose.
     * @param {string} key  already namespaced by the caller
     * @param {string} fp   fingerprint of the request
     * @param {{ reuseCode?: string, reuseMessage?: string }} [opts]
     * @returns {{ replay: false } | { replay: true, record: IdempotencyRecord }}
     */
    begin(key, fp, { reuseCode = "IDEMPOTENCY_KEY_REUSED", reuseMessage } = {}) {
      const r = records.get(key);
      if (live(r)) {
        if (r.fingerprint !== fp) {
          throw new BridgeError(reuseCode, reuseMessage ?? "This idempotency key was already used for a different request. Use a new key for a new order.");
        }
        if (r.state === "in_progress") {
          throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", "The first request with this idempotency key is still running. Check the order book or retry in a moment.", { retryAfterMs: 1000 });
        }
        return { replay: true, record: { ...r } };
      }
      const t = now();
      records.set(key, { key, fingerprint: fp, state: "in_progress", orderId: null, accountId: null, mode: null, createdAt: t, expiresAt: idempotencyExpiry(t) });
      return { replay: false };
    },
    /** Link the order this write created (call before the broker call). */
    attach(key, { orderId, accountId, mode }) {
      const r = records.get(key);
      if (r) Object.assign(r, { orderId, accountId, mode });
    },
    /** Mark done; later begin() calls with the same body replay. */
    complete(key, { orderId, accountId, mode } = {}) {
      const r = records.get(key);
      if (!r) return;
      r.state = "done";
      if (orderId !== undefined) Object.assign(r, { orderId, accountId: accountId ?? r.accountId, mode: mode ?? r.mode });
    },
    /** Forget a write that never reached a broker or the paper engine. */
    release(key) {
      records.delete(key);
    },
    /** @returns {IdempotencyRecord | null} */
    get(key) {
      const r = records.get(key);
      return live(r) ? { ...r } : null;
    },

    // ── clientOrderId map ──

    /**
     * Reserve a clientOrderId for today on this account. Throws DUPLICATE_CLIENT_ORDER_ID when it is taken.
     * @returns {ClientIdRecord}
     */
    reserveClientId(accountId, clientOrderId, fp) {
      const t = now();
      const day = istDay(t);
      const k = cidKey(accountId, clientOrderId, day);
      const existing = clientIds.get(k);
      if (live(existing)) {
        throw new BridgeError("DUPLICATE_CLIENT_ORDER_ID", `clientOrderId ${clientOrderId} was already used on ${accountId} today. Use a new one for a new order.`);
      }
      const rec = { accountId, clientOrderId, day, orderId: null, mode: null, tag: brokerTag(accountId, clientOrderId, day), fingerprint: fp, createdAt: t, expiresAt: idempotencyExpiry(t) };
      clientIds.set(k, rec);
      return { ...rec };
    },
    /** Link a reserved clientOrderId to its order. */
    linkClientId(accountId, clientOrderId, day, { orderId, mode }) {
      const r = clientIds.get(cidKey(accountId, clientOrderId, day));
      if (r) Object.assign(r, { orderId, mode });
    },
    releaseClientId(accountId, clientOrderId, day) {
      clientIds.delete(cidKey(accountId, clientOrderId, day));
    },
    /**
     * The newest live mapping for a clientOrderId among the given accounts (that has an order).
     * @param {string} clientOrderId
     * @param {(accountId: string) => boolean} [allowed]
     * @returns {ClientIdRecord | null}
     */
    findClientId(clientOrderId, allowed = () => true) {
      let best = null;
      for (const r of clientIds.values()) {
        if (r.clientOrderId !== clientOrderId || !live(r) || !r.orderId || !allowed(r.accountId)) continue;
        if (!best || r.createdAt > best.createdAt) best = r;
      }
      return best ? { ...best } : null;
    },

    // ── housekeeping and persistence ──

    /** Drop expired records. @returns {number} how many were removed */
    prune() {
      let n = 0;
      for (const [k, r] of records) if (!live(r)) (records.delete(k), (n += 1));
      for (const [k, r] of clientIds) if (!live(r)) (clientIds.delete(k), (n += 1));
      return n;
    },
    /** Plain data for the state file. */
    dump() {
      return { records: [...records.values()].map((r) => ({ ...r })), clientIds: [...clientIds.values()].map((r) => ({ ...r })) };
    },
    /**
     * Restore from the state file. In-progress records with an order id become done; without one they are dropped
     * (nothing was sent for them).
     */
    load(data) {
      records.clear();
      clientIds.clear();
      for (const r of data?.records ?? []) {
        if (!r || typeof r.key !== "string" || !live(r)) continue;
        if (r.state === "in_progress") {
          if (!r.orderId) continue;
          r.state = "done";
        }
        records.set(r.key, { ...r });
      }
      for (const r of data?.clientIds ?? []) {
        if (!r || typeof r.clientOrderId !== "string" || !live(r)) continue;
        if (!r.orderId) continue;
        clientIds.set(cidKey(r.accountId, r.clientOrderId, r.day), { ...r });
      }
    },
    /** Counts, for tests and diagnostics. */
    size() {
      return { records: records.size, clientIds: clientIds.size };
    },
  };
  return store;
}
