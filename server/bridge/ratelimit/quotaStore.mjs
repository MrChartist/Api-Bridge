/**
 * Per-key quotas that can change while the Bridge runs (routes PUT/DELETE /v1/quotas/{keyId}).
 *
 * Three layers, strongest first, merged field by field:
 *
 *   override   a record in <dataDir>/quotas.json, set through the API (atomic write, mode 0600)
 *   config     ratelimit.client.keys.<keyId> in bridge.config.json
 *   default    ratelimit.client (perSecond, burst, perDay) and the built-in weights
 *
 * resolve(keyId) answers { perSecond, burst, perDay, weight, source } where `source` names the strongest layer that
 * set anything for this key: "override", else "config", else "default". `weight` is null when no layer sets one (the
 * scheduler then uses the weight of the key's clientKind). `perDay` is null when there is no daily cap; an override
 * may set `perDay: null` to lift a daily cap that the config sets.
 *
 * Unlike the broker limits (which a config may only lower), a client quota protects the Bridge from its own callers,
 * so the owner may raise or lower it. Values are checked here as well as in the routes: positive finite numbers,
 * burst a whole number of at least 1, and sane maxima (QUOTA_MAX).
 *
 * Nothing secret is stored: key ids and numbers only. A damaged quotas.json is ignored (and logged); the next
 * successful write replaces it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { QUOTA_MAX } from "./config.mjs";

export const QUOTAS_FILE = "quotas.json";
const FORMAT = "mcb-quotas";
const VERSION = 1;
const KEY_ID = /^[a-z0-9]{4,32}$/;
/** Overrides kept at most (one per API key, and a Bridge has a handful). */
const MAX_OVERRIDES = 1000;

const FIELDS = ["perSecond", "burst", "perDay", "weight"];

/**
 * Validate a quota record (the body of PUT /v1/quotas/{keyId}, or a stored override).
 * @param {unknown} body
 * @returns {{ ok: true, value: { perSecond?: number, burst?: number, perDay?: number | null, weight?: number } } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export function validateQuota(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: [{ path: "(root)", message: "send a JSON object such as { \"perSecond\": 5 }" }] };
  const value = {};
  for (const [k, v] of Object.entries(body)) {
    if (!FIELDS.includes(k)) {
      errors.push({ path: k, message: `unknown field; use ${FIELDS.join(", ")}` });
      continue;
    }
    if (k === "perDay" && v === null) {
      value.perDay = null;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push({ path: k, message: "must be a finite number" });
      continue;
    }
    if (v <= 0) {
      errors.push({ path: k, message: "must be above 0" });
      continue;
    }
    if (v > QUOTA_MAX[k]) {
      errors.push({ path: k, message: `must be at most ${QUOTA_MAX[k]}` });
      continue;
    }
    if (k === "burst" && (!Number.isInteger(v) || v < 1)) {
      errors.push({ path: k, message: "must be a whole number of at least 1" });
      continue;
    }
    if (k === "weight" && v < 1) {
      errors.push({ path: k, message: "must be from 1 to 16" });
      continue;
    }
    value[k] = v;
  }
  if (!errors.length && Object.keys(value).length === 0) errors.push({ path: "(root)", message: `set at least one of ${FIELDS.join(", ")}` });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * @param {{ dir?: string | null, config?: { perSecond: number, burst?: number, perDay?: number, keys?: Record<string, object> },
 *   logger?: { warn?: Function }, now?: () => number }} opts
 *   dir: the data folder (omit for a store that lives in memory only: tests, no dataDir).
 */
export function createQuotaStore({ dir = null, config = { perSecond: 50 }, logger = null } = {}) {
  const file = dir ? join(dir, QUOTAS_FILE) : null;
  /** @type {Map<string, object>} */
  const overrides = new Map();
  let version = 0;
  /** @type {Map<string, { v: number, q: object }>} */
  const cache = new Map();
  const listeners = new Set();

  const defaultBurst = () => config.burst ?? Math.max(1, Math.ceil(config.perSecond));

  function load() {
    if (!file) return;
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") logger?.warn?.("could not read quotas.json; ignoring it", { err: err?.message });
      return;
    }
    try {
      const doc = JSON.parse(raw);
      if (doc?.format !== FORMAT || doc?.version !== VERSION || typeof doc.keys !== "object" || !doc.keys) throw new Error("not a quotas file of this version");
      for (const [id, rec] of Object.entries(doc.keys)) {
        const v = KEY_ID.test(id) ? validateQuota(rec) : { ok: false };
        if (v.ok) overrides.set(id, v.value);
        else logger?.warn?.("ignoring an invalid quota override in quotas.json", { keyId: id });
      }
    } catch (err) {
      logger?.warn?.("quotas.json is damaged; ignoring it", { err: err?.message });
    }
  }

  function persist() {
    if (!file) return;
    const keys = Object.fromEntries([...overrides].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileAtomic(file, `${JSON.stringify({ format: FORMAT, version: VERSION, keys }, null, 2)}\n`);
  }

  function changed(keyId) {
    version += 1;
    for (const fn of listeners) {
      try {
        fn(keyId);
      } catch {
        // a listener must never break a quota change
      }
    }
  }

  function compute(keyId) {
    const cfgKey = config.keys?.[keyId] ?? null;
    const ov = overrides.get(keyId) ?? null;
    const perSecond = ov?.perSecond ?? cfgKey?.perSecond ?? config.perSecond;
    // A burst that was not set for this key follows the rate that applies (so a lower rate does not keep a big burst).
    const ownRate = ov?.perSecond ?? cfgKey?.perSecond;
    const burst = ov?.burst ?? cfgKey?.burst ?? (ownRate !== undefined ? Math.max(1, Math.ceil(ownRate)) : defaultBurst());
    const perDay = ov && "perDay" in ov ? ov.perDay : (cfgKey?.perDay ?? config.perDay ?? null);
    const weight = ov?.weight ?? cfgKey?.weight ?? null;
    return { perSecond, burst, perDay, weight, source: ov ? "override" : cfgKey ? "config" : "default" };
  }

  load();

  return {
    /** The quota that applies to a key now. Cached until something changes; the result must not be modified. */
    resolve(keyId) {
      const hit = cache.get(keyId);
      if (hit && hit.v === version) return hit.q;
      const q = Object.freeze(compute(keyId));
      if (cache.size > 5000) cache.clear();
      cache.set(keyId, { v: version, q });
      return q;
    },

    /** Default budget every key without its own settings gets. */
    defaults: () => ({ perSecond: config.perSecond, burst: defaultBurst(), perDay: config.perDay ?? null, maxConcurrent: config.maxConcurrent ?? null }),

    /** The override record for a key, or null. */
    override: (keyId) => (overrides.has(keyId) ? { ...overrides.get(keyId) } : null),

    /** Key ids that have an override. */
    overrideIds: () => [...overrides.keys()],

    /** Key ids that have a config entry. */
    configIds: () => Object.keys(config.keys ?? {}),

    /**
     * Replace a key's override with `body` (validated here). Writes quotas.json before returning; when the write
     * fails nothing changes and the error is thrown.
     * @returns {{ ok: true } | { ok: false, errors: Array<{ path: string, message: string }> }}
     */
    set(keyId, body) {
      if (!KEY_ID.test(keyId)) return { ok: false, errors: [{ path: "keyId", message: "not a key id" }] };
      const v = validateQuota(body);
      if (!v.ok) return v;
      if (!overrides.has(keyId) && overrides.size >= MAX_OVERRIDES) return { ok: false, errors: [{ path: "(root)", message: `at most ${MAX_OVERRIDES} overrides` }] };
      const before = overrides.get(keyId);
      overrides.set(keyId, v.value);
      try {
        persist();
      } catch (err) {
        if (before) overrides.set(keyId, before);
        else overrides.delete(keyId);
        throw err;
      }
      changed(keyId);
      return { ok: true };
    },

    /** Remove a key's override. Returns true when there was one. */
    clear(keyId) {
      const before = overrides.get(keyId);
      if (!before) return false;
      overrides.delete(keyId);
      try {
        persist();
      } catch (err) {
        overrides.set(keyId, before);
        throw err;
      }
      changed(keyId);
      return true;
    },

    /** Be told when any quota changes (the limiter and the scheduler drop what they cached). Returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    get version() {
      return version;
    },
  };
}
