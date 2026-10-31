/**
 * OI tracker for stream S15: an in-memory snapshot ring fed by chain reads, plus pure functions for
 *   (a) OI change over a window by strike, with build-up classification from option price vs OI change, and
 *   (b) OI spurts: strikes whose latest OI jump is biggest against a rolling baseline of earlier jumps.
 * Read-only. Snapshots live in memory only (lost on restart); history builds up as the routes are called.
 *
 *   GET /v1/analytics/oi-change?underlying=&expiry=[&windowMin=15][&strikes=][&top=]
 *   GET /v1/analytics/oi-spurts?underlying=&expiry=[&lookbackMin=60][&minChangePct=5][&top=10][&strikes=]
 */
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}
function numParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(name, `${name} must be a number from ${min} to ${max}.`);
  return n;
}
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : 0);
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

export const BUILD_UP = Object.freeze({ LONG_BUILD_UP: "long_build_up", SHORT_BUILD_UP: "short_build_up", LONG_UNWINDING: "long_unwinding", SHORT_COVERING: "short_covering" });

/** Price up + OI up = long build-up; price down + OI up = short build-up; price down + OI down = long unwinding; price up + OI down = short covering. Null when either is flat or unknown. */
export function classifyBuildUp(priceChange, oiChange) {
  if (!Number.isFinite(priceChange) || !Number.isFinite(oiChange) || priceChange === 0 || oiChange === 0) return null;
  if (oiChange > 0) return priceChange > 0 ? BUILD_UP.LONG_BUILD_UP : BUILD_UP.SHORT_BUILD_UP;
  return priceChange < 0 ? BUILD_UP.LONG_UNWINDING : BUILD_UP.SHORT_COVERING;
}

/** Reduce a chain to a compact snapshot: { ts, spot, strikes: [{ strike, ceOi, peOi, ceLtp, peLtp }] }. */
export function snapshotFromChain(chain, ts) {
  const strikes = [];
  for (const r of chain?.rows ?? []) {
    if (!Number.isFinite(Number(r?.strike))) continue;
    const ltp = (leg) => (leg?.ltp != null && Number.isFinite(Number(leg.ltp)) ? Number(leg.ltp) : null);
    strikes.push({ strike: Number(r.strike), ceOi: num(r.ce?.oi), peOi: num(r.pe?.oi), ceLtp: ltp(r.ce), peLtp: ltp(r.pe) });
  }
  strikes.sort((a, b) => a.strike - b.strike);
  return { ts, spot: chain?.underlyingLtp ?? null, strikes };
}

/**
 * Bounded snapshot ring per underlying+expiry.
 * @param {{ clock?: { now(): number }, maxSnapshots?: number, maxKeys?: number, minIntervalMs?: number }} [o]
 *   Reads closer together than minIntervalMs replace the newest snapshot instead of adding one.
 */
export function createOiSnapshotStore({ clock = { now: () => Date.now() }, maxSnapshots = 500, maxKeys = 64, minIntervalMs = 15_000 } = {}) {
  /** @type {Map<string, object[]>} insertion order doubles as least-recently-used order */
  const rings = new Map();
  const keyOf = (underlying, expiry) => `${String(underlying).toUpperCase()}|${expiry}`;
  return {
    clock,
    record(underlying, expiry, chain) {
      const key = keyOf(underlying, expiry);
      const snap = snapshotFromChain(chain, clock.now());
      const ring = rings.get(key) ?? [];
      rings.delete(key);
      rings.set(key, ring);
      const last = ring.at(-1);
      if (last && snap.ts - last.ts < minIntervalMs) ring[ring.length - 1] = snap;
      else ring.push(snap);
      while (ring.length > maxSnapshots) ring.shift();
      while (rings.size > maxKeys) rings.delete(rings.keys().next().value);
      return snap;
    },
    snapshots(underlying, expiry) {
      return [...(rings.get(keyOf(underlying, expiry)) ?? [])];
    },
    clear() {
      rings.clear();
    },
  };
}

const bySide = (snap) => {
  const m = new Map();
  for (const s of snap.strikes) m.set(s.strike, s);
  return m;
};
const SIDES = [
  ["CE", "ceOi", "ceLtp"],
  ["PE", "peOi", "peLtp"],
];

/**
 * OI change by strike between the newest snapshot and the one closest to `windowMs` earlier (the newest snapshot at
 * or before latest.ts - windowMs; else the oldest one, with windowCovered false). One row per strike and side.
 * @param {object[]} snapshots oldest first
 */
export function oiChange(snapshots, { windowMs = 15 * 60_000, top } = {}) {
  const latest = snapshots.at(-1);
  if (!latest || snapshots.length < 2) return { snapshots: snapshots.length, from: null, to: latest?.ts ?? null, windowMs, windowCovered: false, totals: null, rows: [] };
  const target = latest.ts - windowMs;
  let base = snapshots[0];
  for (const s of snapshots) if (s.ts <= target && s !== latest) base = s;
  const windowCovered = base.ts <= target;
  const before = bySide(base);
  const rows = [];
  for (const cur of latest.strikes) {
    const prev = before.get(cur.strike);
    if (!prev) continue;
    for (const [side, oiKey, pxKey] of SIDES) {
      const oiNow = cur[oiKey];
      const oiThen = prev[oiKey];
      const priceChange = cur[pxKey] != null && prev[pxKey] != null ? cur[pxKey] - prev[pxKey] : null;
      const delta = oiNow - oiThen;
      rows.push({
        strike: cur.strike,
        side,
        oi: oiNow,
        oiBefore: oiThen,
        oiChange: delta,
        oiChangePct: oiThen > 0 ? round((delta / oiThen) * 100) : null,
        priceChange: round(priceChange, 4),
        buildUp: classifyBuildUp(priceChange, delta),
      });
    }
  }
  const sum = (side) => rows.filter((r) => r.side === side).reduce((t, r) => t + r.oiChange, 0);
  const ceOiChange = sum("CE");
  const peOiChange = sum("PE");
  const ranked = rows.sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange) || a.strike - b.strike);
  return {
    snapshots: snapshots.length,
    from: base.ts,
    to: latest.ts,
    windowMs,
    windowCovered,
    totals: { ceOiChange, peOiChange, netOiChange: peOiChange - ceOiChange },
    rows: top ? ranked.slice(0, top) : ranked,
  };
}

/**
 * OI spurts: for each strike and side, the newest interval's OI jump versus the mean absolute jump of the earlier
 * intervals in the lookback (the rolling baseline). `multiple` is |jump| / baseline (null with no baseline yet, or a
 * flat one). A spurt needs |change| of at least minChangePct of the previous OI; ranked by multiple, then by |jump|.
 * @param {object[]} snapshots oldest first
 */
export function oiSpurts(snapshots, { lookbackMs = 60 * 60_000, minChangePct = 5, top = 10 } = {}) {
  const latest = snapshots.at(-1);
  if (!latest || snapshots.length < 2) return { snapshots: snapshots.length, baselineIntervals: 0, minChangePct, spurts: [] };
  const windowed = snapshots.filter((s) => s.ts >= latest.ts - lookbackMs);
  const series = windowed.length >= 2 ? windowed : snapshots.slice(-2);
  const maps = series.map(bySide);
  const prev = maps.at(-2);
  const cur = maps.at(-1);
  const prevSnap = series.at(-2);
  const spurts = [];
  for (const [strike, now] of cur) {
    const was = prev.get(strike);
    if (!was) continue;
    for (const [side, oiKey, pxKey] of SIDES) {
      const delta = now[oiKey] - was[oiKey];
      if (delta === 0 || !(was[oiKey] > 0)) continue;
      const pct = (delta / was[oiKey]) * 100;
      if (Math.abs(pct) < minChangePct) continue;
      let sumAbs = 0;
      let n = 0;
      for (let i = 1; i < maps.length - 1; i++) {
        const a = maps[i - 1].get(strike);
        const b = maps[i].get(strike);
        if (!a || !b) continue;
        sumAbs += Math.abs(b[oiKey] - a[oiKey]);
        n++;
      }
      const baseline = n > 0 ? sumAbs / n : null;
      const priceChange = now[pxKey] != null && was[pxKey] != null ? now[pxKey] - was[pxKey] : null;
      spurts.push({
        strike,
        side,
        oi: now[oiKey],
        oiChange: delta,
        oiChangePct: round(pct),
        baselineAvgChange: round(baseline),
        multiple: baseline > 0 ? round(Math.abs(delta) / baseline) : null,
        priceChange: round(priceChange, 4),
        buildUp: classifyBuildUp(priceChange, delta),
      });
    }
  }
  spurts.sort((a, b) => (b.multiple ?? -1) - (a.multiple ?? -1) || Math.abs(b.oiChange) - Math.abs(a.oiChange) || a.strike - b.strike);
  return { snapshots: snapshots.length, baselineIntervals: Math.max(0, maps.length - 2), from: prevSnap.ts, to: latest.ts, minChangePct, spurts: spurts.slice(0, top) };
}

/**
 * Routes for the lead to register: [method, path, { scope: "read" }, handler].
 * @param {object} deps needs marketData; optional oiTracker (a store from createOiSnapshotStore) and clock ({ now() })
 */
export function oiTrackerRoutes(deps) {
  const store = deps.oiTracker ?? createOiSnapshotStore({ clock: deps.clock ?? { now: () => Date.now() } });

  async function read(ctx, extra) {
    const q = ctx.query;
    const underlying = opt(q, "underlying");
    if (!underlying) throw invalid("underlying", "underlying is required, for example NIFTY.");
    const expiry = opt(q, "expiry");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const top = intParam(q, "top", 1, 200, extra.defaultTop);
    const strikes = intParam(q, "strikes", 1, 100);
    const params = { underlying, expiry };
    if (strikes !== undefined) params.strikes = strikes;
    const parsed = extra.parse(q);
    const opts = readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
    const chain = await deps.marketData.optionChain(params, opts);
    store.record(underlying, expiry, chain);
    const snaps = store.snapshots(underlying, expiry);
    return {
      data: { underlying: underlying.toUpperCase(), expiry, underlyingLtp: chain?.underlyingLtp ?? null, ...extra.compute(snaps, { ...parsed, top }) },
      meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(chain?.freshness ? { freshness: chain.freshness } : {}) },
    };
  }

  return [
    ["GET", "/v1/analytics/oi-change", { scope: "read" }, (ctx) =>
      read(ctx, { defaultTop: undefined, parse: (q) => ({ windowMs: numParam(q, "windowMin", 1, 1440, 15) * 60_000 }), compute: oiChange })],
    ["GET", "/v1/analytics/oi-spurts", { scope: "read" }, (ctx) =>
      read(ctx, {
        defaultTop: 10,
        parse: (q) => ({ lookbackMs: numParam(q, "lookbackMin", 1, 1440, 60) * 60_000, minChangePct: numParam(q, "minChangePct", 0, 10_000, 5) }),
        compute: oiSpurts,
      })],
  ];
}
