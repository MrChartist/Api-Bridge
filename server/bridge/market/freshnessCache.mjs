/**
 * Freshness cache. A bounded, insertion-ordered (LRU on write and read) map of the last value the Bridge
 * fetched for a key, with the time it was fetched and the account that supplied it. It never decides what is fresh:
 * callers ask for an entry no older than a target (get) or for any entry up to a stale limit (getStale), and label
 * the result with Freshness themselves. Keys never contain credentials (they are canonical symbols and arguments).
 */

/**
 * @template T
 * @typedef {{ value: T, at: number, accountId: string | null, broker: string | null }} CacheEntry
 */

/**
 * @param {{ maxEntries?: number, now: () => number }} opts
 */
export function createFreshnessCache({ maxEntries = 20_000, now }) {
  if (typeof now !== "function") throw new TypeError("freshness cache needs now()");
  /** @type {Map<string, CacheEntry<any>>} */
  const map = new Map();

  const touch = (key, entry) => {
    map.delete(key);
    map.set(key, entry);
  };

  return {
    /**
     * Store a value fetched at `at` (default now). An older value never replaces a newer one.
     * @param {string} key
     * @param {any} value
     * @param {{ at?: number, accountId?: string | null, broker?: string | null }} [meta]
     */
    set(key, value, { at = now(), accountId = null, broker = null } = {}) {
      const prev = map.get(key);
      if (prev && prev.at > at) return prev;
      const entry = { value, at, accountId, broker };
      touch(key, entry);
      while (map.size > maxEntries) map.delete(map.keys().next().value);
      return entry;
    },
    /**
     * The entry when it is at most `maxAgeMs` old. maxAgeMs 0 never hits (the caller wants a live read).
     * @returns {CacheEntry<any> | null}
     */
    get(key, maxAgeMs) {
      const e = map.get(key);
      if (!e || !(maxAgeMs > 0) || now() - e.at > maxAgeMs) return null;
      touch(key, e);
      return e;
    },
    /** The entry when it is at most `maxStaleMs` old, for labelled-stale fallback. */
    getStale(key, maxStaleMs) {
      const e = map.get(key);
      if (!e || now() - e.at > maxStaleMs) return null;
      return e;
    },
    /** The raw entry whatever its age (tests and diagnostics). */
    peek(key) {
      return map.get(key) ?? null;
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
