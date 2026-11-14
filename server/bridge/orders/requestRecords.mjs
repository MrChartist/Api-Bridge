/**
 * Idempotency for requests that wrap more than one order decision (target-position orders and baskets).
 *
 * The order service already makes each single order idempotent. A request that reads a position first, or sends several
 * orders, needs its own record on top: a retry of a target-position request after the first one worked would read the
 * new position and answer "nothing to do", and a retry of a basket must not place a leg the first call never reached.
 * So the first request with a key runs once; a concurrent duplicate gets IDEMPOTENCY_IN_PROGRESS; a later duplicate with
 * the same body gets the first answer back (replayed); the same key with another body is refused.
 *
 * Memory only (a restart forgets it). That is safe: each order inside still carries its own persisted idempotency
 * record, so a retry after a restart can never send an order twice. A request that fails releases its key.
 */
import { BridgeError } from "../core/errors.mjs";

const TTL_MS = 24 * 60 * 60_000;
const MAX_RECORDS = 5000;

/**
 * @param {{ now: () => number }} opts
 */
export function createRequestRecords({ now }) {
  /** @type {Map<string, { fingerprint: string, state: "in_progress"|"done", result: unknown, expiresAt: number }>} */
  const records = new Map();

  function purge() {
    const t = now();
    for (const [k, r] of records) if (r.expiresAt <= t) records.delete(k);
    while (records.size >= MAX_RECORDS) records.delete(records.keys().next().value);
  }

  return {
    /**
     * @param {string} scope namespaced key
     * @param {string} fp fingerprint of the request
     * @param {{ reuseCode?: string, reuseMessage?: string }} [opts]
     * @returns {{ replay: false } | { replay: true, result: unknown }}
     */
    begin(scope, fp, { reuseCode = "IDEMPOTENCY_KEY_REUSED", reuseMessage } = {}) {
      const r = records.get(scope);
      if (r && r.expiresAt > now()) {
        if (r.fingerprint !== fp) throw new BridgeError(reuseCode, reuseMessage ?? "This idempotency key was already used for a different request. Use a new key for a new request.");
        if (r.state === "in_progress") {
          throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", "The first request with this idempotency key is still running. Check the order book or retry in a moment.", { retryAfterMs: 1000 });
        }
        return { replay: true, result: structuredClone(r.result) };
      }
      purge();
      records.set(scope, { fingerprint: fp, state: "in_progress", result: null, expiresAt: now() + TTL_MS });
      return { replay: false };
    },
    complete(scope, result) {
      const r = records.get(scope);
      if (r) Object.assign(r, { state: "done", result: structuredClone(result) });
    },
    release(scope) {
      records.delete(scope);
    },
    size: () => records.size,
  };
}
