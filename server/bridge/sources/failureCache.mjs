/**
 * Failure cache: remembers that a source just failed (or does not know a symbol) so a recalculating spreadsheet does
 * not hit the same failing call again and again. It is keyed by (source id, kind of read, key) and holds the error, not
 * a value; it never feeds an answer. Pure: time from the injected clock, jitter from the injected random.
 *
 *   upstream error (timeout, network, 5xx, unreadable answer)   2 s, jittered +-25%
 *   symbol not found at that source                             10 min
 *   capability or segment unsupported at that source            60 min
 *
 * Never cached: 429 (the shared bucket backs off by itself and failover is the retry), a login or key problem (the
 * account state owns it), a caller that went away, a validation error.
 */

export const FAILURE_TTL = Object.freeze({ upstreamMs: 2000, upstreamJitter: 0.25, notFoundMs: 600_000, unsupportedMs: 3_600_000 });

/** The cache lifetime for an error code in ms (before jitter), or 0 when it must not be cached. */
export function failureTtlMs(err) {
  if (!err || err.name === "AbortError") return 0;
  switch (err.code) {
    case "UPSTREAM_ERROR":
    case "UPSTREAM_TIMEOUT":
    case "BROKER_UNAVAILABLE":
      return FAILURE_TTL.upstreamMs;
    case "SYMBOL_NOT_FOUND":
      return FAILURE_TTL.notFoundMs;
    case "CAPABILITY_UNSUPPORTED":
      return FAILURE_TTL.unsupportedMs;
    default:
      return 0;
  }
}

/**
 * @param {{ clock?: { now(): number }, random?: () => number, maxEntries?: number }} [opts]
 */
export function createFailureCache({ clock, random = Math.random, maxEntries = 5000 } = {}) {
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  /** key -> { until, code, message } ; a Map keeps insertion order, so the oldest entries go first when full */
  const rows = new Map();
  const keyOf = (sourceId, kind, key) => `${sourceId}\u0000${kind}\u0000${key}`;

  return {
    /**
     * Remember a failure if its kind may be cached. @returns {boolean} whether it was stored
     * @param {string} sourceId
     * @param {string} kind     "quote", "ltp", "depth", "history", "expiries", "chain"
     * @param {string} key      symbol, or the request's identifying parts
     * @param {{ code?: string, detail?: string, message?: string, name?: string }} err
     */
    note(sourceId, kind, key, err) {
      const base = failureTtlMs(err);
      if (!base) return false;
      const ttl = base === FAILURE_TTL.upstreamMs ? Math.round(base * (1 + (random() * 2 - 1) * FAILURE_TTL.upstreamJitter)) : base;
      const k = keyOf(sourceId, kind, key);
      rows.delete(k);
      rows.set(k, { until: now() + ttl, code: err.code, message: String(err.detail ?? err.message ?? "").slice(0, 500) });
      if (rows.size > maxEntries) rows.delete(rows.keys().next().value);
      return true;
    },
    /** The remembered failure `{ code, message, untilMs }` while it is still valid, else null. */
    get(sourceId, kind, key) {
      const k = keyOf(sourceId, kind, key);
      const row = rows.get(k);
      if (!row) return null;
      if (now() >= row.until) {
        rows.delete(k);
        return null;
      }
      return { code: row.code, message: row.message, untilMs: row.until };
    },
    /** Forget one entry, or everything for a source. */
    clear(sourceId, kind, key) {
      if (kind === undefined) {
        const prefix = `${sourceId}\u0000`;
        for (const k of rows.keys()) if (k.startsWith(prefix)) rows.delete(k);
      } else rows.delete(keyOf(sourceId, kind, key));
    },
    size: () => rows.size,
  };
}
