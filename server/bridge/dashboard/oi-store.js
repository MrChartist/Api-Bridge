// OI snapshots: the OI Analysis page records the chain it shows at most once a minute per (underlying, expiry, IST
// day), so 5m / 15m / 30m / 1h / since-open windows can be read without any server change. Snapshots live in this
// browser only (IndexedDB "mcb-oi"; memory when storage is unavailable), 400 per key, and are dropped after 3 IST days.
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
    if (snaps.length > SNAP_CAP) {
      const drop = snaps.splice(0, snaps.length - SNAP_CAP);
      await guard((b) => b.remove(snap.key, drop.map((s) => s.t)), null);
    }
    for (const fn of listeners) fn(snap.key);
    return true;
  }
  /** Whether a chain would be recorded now (without reading the store). */
  /** `session` / `isTradingDay`: the page's reference session and calendar (holidays record nothing). */
  const allowed = (nowMs, demo, session, isTradingDay) => Boolean(demo) || marketSession(nowMs, session ?? undefined, { isTradingDay }).phase === "open";
  async function offer(chain, nowMs = Date.now(), { demo = false, session = null, isTradingDay = null } = {}) {
    if (!allowed(nowMs, demo, session, isTradingDay)) return false;
    const snap = snapshotOf(chain, nowMs);
    if (!snap) return false;
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
  return Object.assign(self, { ready, offer, put, list, latest, clearKey, peek, allowed, onChange });
}

let shared = null;
/** The page's store (IndexedDB, falling back to memory): one per tab, so seeding from a test reaches the page. */
export function oiStore() {
  shared ??= openStore({ backend: indexedDbBackend() });
  return shared;
}
