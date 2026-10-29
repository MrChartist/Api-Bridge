// OI snapshots: the OI Analysis page records the chain it shows at most once a minute per (underlying, expiry, IST
// day), so 5m / 15m / 30m / 1h / since-open windows can be read without any server change. Snapshots live in this
// browser only (IndexedDB "mcb-oi"; memory when storage is unavailable), 400 per key, and are dropped after 3 IST days.
//
// When the Bridge's recorder (GET /v1/options/recorder, stream S17) records a chain, the OI page reads that chain's
// minutes from GET /v1/options/snapshots instead: fromServerSnapshot() maps them to this record shape (src "server")
// and markServerBacked(key) makes the key a cache of the server series. A server-backed key takes no snapshots from
// the page (no mixed series) and keeps its first snapshot of the day when it trims to the cap ("Since open").
//
// Pure apart from the IndexedDB backend: Node tests run it with memoryBackend().
import { istClock, marketSession } from "./options.js";

export const SNAP_EVERY_MS = 60_000;
export const SNAP_CAP = 400;
export const SNAP_KEEP_DAYS = 3;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The store key for a chain: "NIFTY|2026-11-03|2026-10-29" (the IST date the snapshot was taken). */
export const snapKey = (underlying, expiry, nowMs) => `${underlying}|${expiry}|${istClock(nowMs).date}`;

/**
 * A chain as a compact, columnar snapshot: { key, t, istDate, asOf, spot, lot, k, co, po, cl, pl, cv, pv } (calls /
 * puts OI, last price and cumulative day volume, aligned to the strikes `k`; missing values are null). Null when the
 * chain carries no OI at all (nothing worth recording).
 */
export function snapshotOf(chain, nowMs) {
  const rows = chain?.rows ?? [];
  if (!rows.length || !rows.some((r) => num(r.ce?.oi) !== null || num(r.pe?.oi) !== null)) return null;
  const pick = (side, f) => rows.map((r) => num(r[side]?.[f]));
  return {
    key: snapKey(chain.underlying, chain.expiry, nowMs),
    t: nowMs,
    istDate: istClock(nowMs).date,
    asOf: chain.freshness?.asOf ?? null,
    spot: num(chain.underlyingLtp),
    lot: num(chain.lotSize) || 1,
    k: rows.map((r) => r.strike),
    co: pick("ce", "oi"),
    po: pick("pe", "oi"),
    cl: pick("ce", "ltp"),
    pl: pick("pe", "ltp"),
    cv: pick("ce", "volume"),
    pv: pick("pe", "volume"),
  };
}

/**
 * One recorded snapshot from GET /v1/options/snapshots (fields oi, ltp, volume) as a store record: the slot minute is
 * `t`, the read time is `asOf`, src "server". Null when it has no strikes.
 * @param {object} s  one item of data.snapshots
 */
export function fromServerSnapshot(s, underlying, expiry) {
  const t = Date.parse(s?.slot);
  const k = Array.isArray(s?.strikes) ? s.strikes : [];
  if (!Number.isFinite(t) || !k.length) return null;
  const col = (side, f) => k.map((_, i) => num(s[side]?.[f]?.[i]));
  return {
    key: snapKey(underlying, expiry, t),
    t,
    istDate: istClock(t).date,
    asOf: s.ts ?? null,
    spot: num(s.spot),
    lot: num(s.lotSize) || 1,
    k: [...k],
    co: col("ce", "oi"),
    po: col("pe", "oi"),
    cl: col("ce", "ltp"),
    pl: col("pe", "ltp"),
    cv: col("ce", "volume"),
    pv: col("pe", "volume"),
    src: "server",
  };
}

/** "HH:MM" IST of an epoch-ms time or an IST ISO string; "" when neither. */
const hmOf = (v) => {
  const ms = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  if (!Number.isFinite(ms)) return "";
  const m = istClock(ms).mins;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
/** "10:41–10:43" (one minute: "10:41"). */
const gapHm = (g) => {
  const x = hmOf(g?.from);
  const y = hmOf(g?.to ?? g?.from) || x;
  return x === y ? x : `${x}–${y}`;
};
const GAP_WORDS = { "stream-down": "feed down", budget: "REST budget used", "broker-error": "broker error", "session-expired": "session expired", "not-subscribed-yet": "subscribing", "bridge-down": "Bridge not running", "disk-full": "disk full", paused: "paused" };

/**
 * The OI page's coverage line for a server-backed chain (docs/spec/p1-01-recorder.md §7.2): "Server recording since
 * 09:15 · 58 of 61 minutes · 3 missing (feed down 10:41–10:43)". The latest gap is named; more are counted.
 * @param {{ coverage?: object, gaps?: object[] }} page  coverage { expectedSlots, recordedSlots, gapSlots, firstSlot } and
 *   gaps [{ from, to, reason }] (times as epoch ms or IST ISO strings: the status and the snapshots route differ)
 * @param {(n: number) => string} fmt  whole-number formatter (format.js formatInt)
 */
export function serverCoverageText(page, fmt) {
  const c = page?.coverage ?? {};
  const first = hmOf(c.firstSlot);
  const since = first ? ` since ${first}` : "";
  const parts = [`Server recording${since}`];
  // Minutes, not slots: a 5-minute chain's slot is 5 minutes (the status sends *Minutes; else slots × everyMinutes).
  const per = Number(c.everyMinutes) > 0 ? Number(c.everyMinutes) : 1;
  const mins = (m, slots) => (Number.isFinite(Number(m)) && m !== null && m !== undefined ? Number(m) : (Number(slots) || 0) * per);
  const expected = mins(c.expectedMinutes, c.expectedSlots);
  const recorded = mins(c.recordedMinutes, c.recordedSlots);
  const missing = mins(c.gapMinutes, c.gapSlots);
  if (expected > 0) parts.push(`${fmt(recorded)} of ${fmt(expected)} ${expected === 1 ? "minute" : "minutes"}`);
  const gaps = page?.gaps ?? [];
  if (missing > 0 && gaps.length) {
    const g = gaps[gaps.length - 1];
    const more = gaps.length > 1 ? `; ${fmt(gaps.length - 1)} more` : "";
    parts.push(`${fmt(missing)} missing (${GAP_WORDS[g.reason] ?? g.reason ?? "gap"} ${gapHm(g)}${more})`);
  }
  return parts.join(" · ");
}

/**
 * This chain's coverage from the recorder status (GET /v1/options/recorder `coverage[]`): the server's own count for
 * the whole day so far, so repeated polls never add up (incremental snapshot reads re-list the same gaps while the
 * feed is down). Null when the status has no row for the chain.
 * @returns {{ coverage: object, gaps: object[], everyMinutes: number } | null}
 */
export function serverCoverageFor(status, underlying, expiry) {
  const row = (status?.coverage ?? []).find((c) => c.underlying === underlying && c.expiry === expiry);
  if (!row) return null;
  const { gaps = [], ...coverage } = row;
  return { coverage, gaps, everyMinutes: Number(row.everyMinutesNow ?? row.everyMinutes) || 1 };
}

/** Snapshots kept in this tab only (the Node tests' backend, and the fallback when IndexedDB fails). */
export function memoryBackend() {
  const recs = new Map(); // key -> Map(t -> rec)
  return {
    persistent: false,
    async list(key) {
      return [...(recs.get(key)?.values() ?? [])].sort((a, b) => a.t - b.t);
    },
    async put(rec) {
      if (!recs.has(rec.key)) recs.set(rec.key, new Map());
      recs.get(rec.key).set(rec.t, rec);
    },
    async remove(key, ts) {
      const m = recs.get(key);
      for (const t of ts) m?.delete(t);
    },
    async clearKey(key) {
      recs.delete(key);
    },
    async evictBefore(istDate) {
      for (const [key, m] of recs) {
        for (const [t, r] of m) if (r.istDate < istDate) m.delete(t);
        if (!m.size) recs.delete(key);
      }
    },
  };
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

/** IndexedDB database "mcb-oi" v1, store "snaps" (keyPath [key, t], index "key"). Rejects when IndexedDB is unavailable. */
export function indexedDbBackend() {
  let dbP = null;
  const db = () =>
    (dbP ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
      const req = indexedDB.open("mcb-oi", 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore("snaps", { keyPath: ["key", "t"] });
        s.createIndex("key", "key");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    }));
  const store = async (mode) => {
    const tx = (await db()).transaction("snaps", mode);
    return { tx, s: tx.objectStore("snaps") };
  };
  return {
    persistent: true,
    async list(key) {
      const { s } = await store("readonly");
      const all = await reqP(s.index("key").getAll(IDBKeyRange.only(key)));
      return all.sort((a, b) => a.t - b.t);
    },
    async put(rec) {
      const { tx, s } = await store("readwrite");
      s.put(rec);
      await txDone(tx);
    },
    async remove(key, ts) {
      const { tx, s } = await store("readwrite");
      for (const t of ts) s.delete([key, t]);
      await txDone(tx);
    },
    async clearKey(key) {
      const { tx, s } = await store("readwrite");
      const keys = await reqP(s.index("key").getAllKeys(IDBKeyRange.only(key)));
      for (const k of keys) s.delete(k);
      await txDone(tx);
    },
    async evictBefore(istDate) {
      const { tx, s } = await store("readwrite");
      await new Promise((resolve, reject) => {
        const req = s.openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          if (!(c.value?.istDate >= istDate)) c.delete();
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
      await txDone(tx);
    },
  };
}

/** The IST date `days` before the one `nowMs` falls on ("YYYY-MM-DD"). */
const istDateBefore = (nowMs, days) => istClock(nowMs - days * 86400000).date;

/**
 * The recorder. `offer(chain, nowMs, { demo })` writes a snapshot when the session is open (or in demo mode), at least
 * 60 s after the last one for that key, and only for a new quote time (`freshness.asOf`). `list(key)` returns the
 * key's snapshots oldest first (cached in memory after the first read). Every storage call is guarded: on a failure
 * the store moves to memory and `persistent` turns false.
 * @param {{ backend?: object, nowMs?: number }} [o]
 */
export function openStore({ backend = memoryBackend(), nowMs = Date.now() } = {}) {
  let be = backend;
  const cache = new Map(); // key -> sorted snapshots
  const loading = new Map();
  const listeners = new Set();
  const server = new Set(); // keys that are a cache of the Bridge recorder's series
  const self = {
    persistent: Boolean(be.persistent),
    failed: false,
  };
  async function guard(fn, fallback) {
    try {
      return await fn(be);
    } catch {
      if (be.persistent) {
        be = memoryBackend();
        self.persistent = false;
        self.failed = true;
        for (const snaps of cache.values()) for (const s of snaps) await be.put(s);
        try {
          return await fn(be);
        } catch {
          return fallback;
        }
      }
      return fallback;
    }
  }
  const ready = guard((b) => b.evictBefore(istDateBefore(nowMs, SNAP_KEEP_DAYS)), null);

  async function list(key) {
    if (cache.has(key)) return cache.get(key);
    if (!loading.has(key)) {
      loading.set(
        key,
        (async () => {
          await ready;
          const got = await guard((b) => b.list(key), []);
          // Snapshots offered while the read was in flight are already in the cache entry: merge.
          const mine = cache.get(key) ?? [];
          const byT = new Map([...got, ...mine].map((s) => [s.t, s]));
          const out = [...byT.values()].sort((a, b) => a.t - b.t);
          cache.set(key, out);
          loading.delete(key);
          return out;
        })(),
      );
    }
    return loading.get(key);
  }
  /** Add a snapshot (the recorder's write, and the Playwright seeding hook). Keeps the newest SNAP_CAP per key. */
  async function put(snap) {
    const snaps = await list(snap.key);
    const i = snaps.findIndex((s) => s.t === snap.t);
    if (i >= 0) snaps[i] = snap;
    else {
      snaps.push(snap);
      snaps.sort((a, b) => a.t - b.t);
    }
    await guard((b) => b.put(snap), null);
    await trim(snap.key, snaps);
    for (const fn of listeners) fn(snap.key);
    return true;
  }
  /** Keep the newest SNAP_CAP; a server-backed key also keeps its first snapshot of the day ("Since open"). */
  async function trim(key, snaps) {
    if (snaps.length <= SNAP_CAP) return;
    const keep = server.has(key) ? 1 : 0;
    const drop = snaps.splice(keep, snaps.length - SNAP_CAP);
    await guard((b) => b.remove(key, drop.map((s) => s.t)), null);
  }
  /** Add many snapshots of one key (a server page): one sort, one trim, one change event. */
  async function putMany(recs) {
    const recsOk = (recs ?? []).filter(Boolean);
    if (!recsOk.length) return 0;
    const key = recsOk[0].key;
    const snaps = await list(key);
    const byT = new Map(snaps.map((s) => [s.t, s]));
    for (const r of recsOk) if (r.key === key) byT.set(r.t, r);
    const merged = [...byT.values()].sort((a, b) => a.t - b.t);
    snaps.splice(0, snaps.length, ...merged);
    for (const r of recsOk) if (r.key === key) await guard((b) => b.put(r), null);
    await trim(key, snaps);
    for (const fn of listeners) fn(key);
    return recsOk.length;
  }
  /** Is this key a cache of the recorder's series? */
  const serverBacked = (key) => server.has(key);
  /**
   * Make a key a cache of the recorder's series: the page stops recording it (offer() returns false) and drops the
   * snapshots it recorded itself, so the windows never mix two sources.
   */
  async function markServerBacked(key) {
    if (server.has(key)) return;
    server.add(key);
    const snaps = await list(key);
    const mine = snaps.filter((s) => s.src !== "server");
    if (!mine.length) return;
    snaps.splice(0, snaps.length, ...snaps.filter((s) => s.src === "server"));
    await guard((b) => b.remove(key, mine.map((s) => s.t)), null);
    for (const fn of listeners) fn(key);
  }
  /** Whether a chain would be recorded now (without reading the store). */
  /** `session` / `isTradingDay`: the page's reference session and calendar (holidays record nothing). */
  const allowed = (nowMs, demo, session, isTradingDay) => Boolean(demo) || marketSession(nowMs, session ?? undefined, { isTradingDay }).phase === "open";
  async function offer(chain, nowMs = Date.now(), { demo = false, session = null, isTradingDay = null } = {}) {
    if (!allowed(nowMs, demo, session, isTradingDay)) return false;
    const snap = snapshotOf(chain, nowMs);
    if (!snap || server.has(snap.key)) return false;
    const snaps = await list(snap.key);
    const last = snaps[snaps.length - 1];
    if (last && nowMs - last.t < SNAP_EVERY_MS) return false;
    if (last && snap.asOf !== null && last.asOf === snap.asOf) return false;
    return put(snap);
  }
  async function latest(key) {
    const s = await list(key);
    return s[s.length - 1] ?? null;
  }
  async function clearKey(key) {
    cache.set(key, []);
    await guard((b) => b.clearKey(key), null);
    for (const fn of listeners) fn(key);
  }
  /** Cached snapshots for a key, synchronously (empty until list() has run once). */
  const peek = (key) => cache.get(key) ?? null;
  const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
  return Object.assign(self, { ready, offer, put, putMany, list, latest, clearKey, peek, allowed, onChange, serverBacked, markServerBacked });
}

let shared = null;
/** The page's store (IndexedDB, falling back to memory): one per tab, so seeding from a test reaches the page. */
export function oiStore() {
  shared ??= openStore({ backend: indexedDbBackend() });
  return shared;
}
