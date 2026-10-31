/**
 * Markets overview for stream S15 (docs: analytics/markets.openapi.yaml). Read scope only: nothing here can place an
 * order. Roadmap: Terminal plan, Phase 2.
 *
 *   GET  /v1/analytics/markets/indices                          index strip: ltp, change, day range and where ltp sits in it
 *   GET  /v1/analytics/markets/movers?universe=&by=&limit=      gainers, losers, volume, turnover, oi over one quote pass
 *   GET  /v1/analytics/markets/sectors?tf=1d|1w|1m[&drill=KEY]  sector index heatmap, optional constituents of one sector
 *   GET  /v1/analytics/markets/breadth                          advance/decline now, plus the cached daily breadth job
 *   POST /v1/analytics/markets/breadth/refresh                  start the breadth job (never blocks; answers 202)
 *   GET  /v1/analytics/markets/rotation?tf=1d|1w&tail=          relative rotation proxy of sectors vs NIFTY
 *   GET  /v1/analytics/markets/correlation?universe=&days=      Pearson matrix of daily log returns
 *
 * Request cost (each answer repeats it in meta.cost, with what this call really spent):
 *   indices      1 quote call (ONE batched marketData.quotes for every index the instrument master knows, at most 60).
 *   movers       0 or 1-2 quote calls: the universe snapshot (<= 400 symbols, 200 per call) is shared by every client for
 *                15 seconds and concurrent callers join the pass in flight. Also feeds the sector drill-down and breadth.
 *   sectors      1 quote call for 1d; 1w and 1m add up to 12 daily-candle reads (background priority) cached for the IST day.
 *   breadth      GET: 0-2 quote calls (the shared snapshot). The job reads daily candles of the FNO universe at background
 *                priority (at most 250 symbols, 3 at a time), cached for the day and saved to <dataDir>/analytics/breadth.json.
 *   rotation     up to 13 cached daily-candle reads (12 sector indices and NIFTY); no quotes.
 *   correlation  up to 60 cached daily-candle reads; no quotes.
 * Candle reads are shared across routes and callers (same account scope), cached per IST day, de-duplicated while in flight,
 * and a failed read is remembered for 5 minutes so a broken symbol is not retried on every request. The last cached daily
 * bar may be the session in progress as it stood when it was first read that day.
 *
 * Numbers are rounded and never NaN or Infinity: anything that cannot be computed is null. Symbols that fail come back in
 * `errors` and never fail the call, except when a whole pass has nothing at all (then the first error is raised).
 *
 * Rotation is a labelled proxy (the official RRG formula is closed): RS = sector close / NIFTY close; smoothed with an EMA;
 * RS-Ratio = 100 + z-score of the smoothed RS over a rolling window; RS-Momentum = 100 + z-score (same window) of the
 * smoothed RS rate of change. 1d uses span 10, window 60, momentum 5 bars; 1w samples every 5th bar with span 4, window 26,
 * momentum 4 samples. Quadrants: leading (both >= 100), weakening (ratio >= 100, momentum < 100), lagging (both < 100),
 * improving (ratio < 100, momentum >= 100).
 *
 * deps: marketData (required); symbols (instrument master, optional but needed for FNO and index discovery);
 * universes (optional override of createUniverses); clock; paths.dataDir; logger; config.scanner.universes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { INDICES, createUniverses } from "../scanner/universes.mjs";
import { normaliseSymbol } from "./watchlist.mjs";

export const SNAPSHOT_TTL_MS = 15_000;
export const QUOTE_CHUNK = 200;
export const MAX_UNIVERSE = 400;
export const MAX_INDICES = 60;
export const CANDLE_BARS = 260;
export const FAILED_CANDLE_TTL_MS = 5 * 60_000;
export const BREADTH_MAX_SYMBOLS = 250;
export const BREADTH_MIN_REFRESH_MS = 30 * 60_000;
export const CANDLE_CONCURRENCY = 3;
export const MAX_CORRELATION_SYMBOLS = 60;
export const MIN_OVERLAP = 20;
const ADL_DAYS = 60;
const MAX_CANDLE_ENTRIES = 600;
const MAX_SNAPSHOTS = 8;
const IST_MS = 5.5 * 3_600_000;

/** Sector indices (NIFTY sector family) with the NIFTY 50 stocks that belong to each. Shipped list; check after rebalances. */
export const SECTORS = Object.freeze([
  { key: "BANK", name: "Nifty Bank", symbol: "NSE:BANKNIFTY", members: ["HDFCBANK", "ICICIBANK", "KOTAKBANK", "AXISBANK", "SBIN"] },
  { key: "IT", name: "Nifty IT", symbol: "NSE:NIFTYIT", members: ["TCS", "INFY", "HCLTECH", "WIPRO", "TECHM"] },
  { key: "AUTO", name: "Nifty Auto", symbol: "NSE:NIFTYAUTO", members: ["MARUTI", "M&M", "BAJAJ-AUTO", "EICHERMOT", "TMPV"] },
  { key: "FMCG", name: "Nifty FMCG", symbol: "NSE:NIFTYFMCG", members: ["HINDUNILVR", "ITC", "NESTLEIND", "TATACONSUM"] },
  { key: "PHARMA", name: "Nifty Pharma", symbol: "NSE:NIFTYPHARMA", members: ["SUNPHARMA", "CIPLA", "DRREDDY"] },
  { key: "METAL", name: "Nifty Metal", symbol: "NSE:NIFTYMETAL", members: ["TATASTEEL", "JSWSTEEL", "HINDALCO"] },
  { key: "ENERGY", name: "Nifty Energy", symbol: "NSE:NIFTYENERGY", members: ["RELIANCE", "ONGC", "NTPC", "POWERGRID", "COALINDIA"] },
  { key: "REALTY", name: "Nifty Realty", symbol: "NSE:NIFTYREALTY", members: [] },
  { key: "PSUBANK", name: "Nifty PSU Bank", symbol: "NSE:NIFTYPSUBANK", members: ["SBIN"] },
  { key: "PVTBANK", name: "Nifty Private Bank", symbol: "NSE:NIFTYPVTBANK", members: ["HDFCBANK", "ICICIBANK", "KOTAKBANK", "AXISBANK"] },
  { key: "FINSERV", name: "Nifty Financial Services", symbol: "NSE:FINNIFTY", members: ["HDFCBANK", "ICICIBANK", "KOTAKBANK", "AXISBANK", "SBIN", "BAJFINANCE", "BAJAJFINSV", "HDFCLIFE", "SBILIFE", "SHRIRAMFIN", "JIOFIN"] },
  { key: "MEDIA", name: "Nifty Media", symbol: "NSE:NIFTYMEDIA", members: [] },
]);
export const BENCHMARK = "NSE:NIFTY";

const INDEX_PRIORITY = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "INDIAVIX"]);
const INDEX_NAMES = Object.freeze({
  NIFTY: "NIFTY 50", BANKNIFTY: "NIFTY BANK", FINNIFTY: "NIFTY FIN SERVICE", MIDCPNIFTY: "NIFTY MIDCAP SELECT", NIFTYNXT50: "NIFTY NEXT 50",
  SENSEX: "SENSEX", BANKEX: "BANKEX", INDIAVIX: "INDIA VIX", SENSEX50: "SENSEX 50",
});
const ROTATION = Object.freeze({ "1d": { stride: 1, span: 10, window: 60, mom: 5 }, "1w": { stride: 5, span: 4, window: 26, mom: 4 } });
const SECTOR_BARS = Object.freeze({ "1w": 5, "1m": 21 });
const MOVER_KEYS = Object.freeze(["gainers", "losers", "volume", "turnover", "oi"]);

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rnd = (v, dp) => {
  const n = fin(v);
  if (n === null) return null;
  const f = 10 ** dp;
  const out = Math.round(n * f) / f;
  return Number.isFinite(out) ? out : null;
};
const r2 = (v) => rnd(v, 2);
const r4 = (v) => rnd(v, 4);
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};

function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

function enumParam(q, name, allowed, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  const hit = allowed.find((a) => String(a).toLowerCase() === v.toLowerCase());
  if (hit === undefined) throw invalid(name, `${name} must be one of ${allowed.join(", ")}.`);
  return hit;
}

function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}

/** Run fn over items with at most `limit` in flight; results keep order. fn must not throw. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const errEntry = (symbol, err) => ({
  symbol,
  code: err instanceof BridgeError ? err.code : "INTERNAL",
  message: err instanceof BridgeError ? (err.detail ?? err.message) : "The read failed.",
});

// ── pure maths ──

export function sma(xs, n) {
  if (xs.length < n || n < 1) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

export function ema(xs, span) {
  const a = 2 / (span + 1);
  const out = [];
  let prev = null;
  for (const x of xs) {
    prev = prev === null ? x : a * x + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

/** Rolling z-score of the last value of each full window; null where fewer than `window` finite values exist. */
export function rollingZ(xs, window) {
  return xs.map((x, t) => {
    if (t < window - 1 || !Number.isFinite(x)) return null;
    const w = xs.slice(t - window + 1, t + 1);
    if (w.some((v) => !Number.isFinite(v))) return null;
    const m = w.reduce((s, v) => s + v, 0) / window;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (window - 1 || 1));
    return sd > 0 ? (x - m) / sd : 0;
  });
}

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < MIN_OVERLAP) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) (sx += xs[i], (sy += ys[i]));
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

export const quadrant = (ratio, momentum) => (ratio >= 100 ? (momentum >= 100 ? "leading" : "weakening") : momentum >= 100 ? "improving" : "lagging");

/** Position of ltp inside the day's range, 0-1, or null when the range is missing or flat. */
export function rangePosition(ltp, low, high) {
  if (!(fin(ltp) !== null && fin(low) !== null && fin(high) !== null) || high <= low) return null;
  return r4(Math.max(0, Math.min(1, (ltp - low) / (high - low))));
}

/** Rotation points for one sector: ascending samples of { date, ratio, momentum }. series = aligned [{ d, rs }]. */
export function rotationSeries(rs, params) {
  const { stride, span, window, mom } = params;
  const sampled = [];
  for (let i = rs.length - 1; i >= 0; i -= stride) sampled.unshift(rs[i]);
  if (sampled.length < window + mom) return [];
  const sm = ema(sampled.map((p) => p.rs), span);
  const roc = sm.map((v, t) => (t >= mom && sm[t - mom] > 0 ? v / sm[t - mom] - 1 : null));
  const zr = rollingZ(sm, window);
  const zm = rollingZ(roc, window);
  const out = [];
  sampled.forEach((p, t) => {
    if (zr[t] === null || zm[t] === null) return;
    const ratio = r2(100 + zr[t]);
    const momentum = r2(100 + zm[t]);
    if (ratio !== null && momentum !== null) out.push({ date: p.d, ratio, momentum });
  });
  return out;
}

/** Advance/decline/unchanged counts from snapshot rows. */
export function advanceDecline(rows) {
  let advances = 0;
  let declines = 0;
  let unchanged = 0;
  for (const r of rows) {
    if (r.changePct === null) continue;
    if (r2(r.changePct) > 0) advances++;
    else if (r2(r.changePct) < 0) declines++;
    else unchanged++;
  }
  const total = advances + declines + unchanged;
  return { advances, declines, unchanged, total, ratio: declines > 0 ? r2(advances / declines) : null, advancePct: total ? r2((advances / total) * 100) : null };
}

/** Breadth over candle sets: [{ symbol, candles: [{ d, c, h, l }] }]. */
export function computeBreadth(sets) {
  const used = sets.filter((s) => s.candles.length >= 2);
  const high = [];
  const low = [];
  const dma = { 20: [0, 0], 50: [0, 0], 200: [0, 0] };
  let eligible52 = 0;
  const perDate = new Map();
  let asOf = null;
  for (const { symbol, candles } of used) {
    const n = candles.length;
    const last = candles[n - 1];
    if (!asOf || last.d > asOf) asOf = last.d;
    if (n >= 120) {
      eligible52++;
      const win = candles.slice(-252);
      if (last.h >= Math.max(...win.map((c) => c.h))) high.push(symbol);
      if (last.l <= Math.min(...win.map((c) => c.l))) low.push(symbol);
    }
    const closes = candles.map((c) => c.c);
    for (const k of [20, 50, 200]) {
      const m = sma(closes, k);
      if (m === null) continue;
      dma[k][1]++;
      if (last.c > m) dma[k][0]++;
    }
    for (let i = Math.max(1, n - 120); i < n; i++) {
      const e = perDate.get(candles[i].d) ?? { advances: 0, declines: 0, unchanged: 0 };
      const ch = candles[i].c - candles[i - 1].c;
      if (ch > 0) e.advances++;
      else if (ch < 0) e.declines++;
      else e.unchanged++;
      perDate.set(candles[i].d, e);
    }
  }
  const maxTotal = Math.max(0, ...[...perDate.values()].map((e) => e.advances + e.declines + e.unchanged));
  const dates = [...perDate.keys()].filter((d) => {
    const e = perDate.get(d);
    return e.advances + e.declines + e.unchanged >= maxTotal * 0.5;
  }).sort().slice(-ADL_DAYS);
  let line = 0;
  const adLine = dates.map((date) => {
    const e = perDate.get(date);
    const net = e.advances - e.declines;
    line += net;
    return { date, ...e, net, line };
  });
  const pct = ([a, of]) => ({ count: a, of, pct: of ? r2((a / of) * 100) : null });
  return {
    asOf,
    symbols: { used: used.length },
    newHighs52w: { count: high.length, of: eligible52, symbols: high.sort().slice(0, 25) },
    newLows52w: { count: low.length, of: eligible52, symbols: low.sort().slice(0, 25) },
    pctAbove: { dma20: pct(dma[20]), dma50: pct(dma[50]), dma200: pct(dma[200]) },
    advanceDeclineLine: adLine,
  };
}

// ── the service ──

export function createMarkets(deps) {
  const log = (() => {
    const l = extra(deps, "logger");
    return l?.child ? l.child({ module: "markets" }) : l;
  })();
  const warn = (msg, err) => {
    try {
      log?.warn?.({ err: err?.message ?? String(err) }, msg);
    } catch {
      /* logging must never fail a request */
    }
  };
  const clock = extra(deps, "clock");
  const now = () => (extra(deps, "now") instanceof Function ? deps.now() : clock?.now ? clock.now() : Date.now());
  const today = () => istDay(now());
  const md = () => deps.marketData;
  const dataDir = extra(deps, "paths")?.dataDir;
  const breadthFile = dataDir ? join(dataDir, "analytics", "breadth.json") : null;
  const universes = extra(deps, "universes") ?? createUniverses({ symbols: extra(deps, "symbols"), custom: extra(extra(deps, "config"), "scanner")?.universes ?? {} });
  const autoBackup = () => autoBackupFor(deps);

  const newStats = () => ({ quoteCalls: 0, historyCalls: 0, cacheHits: 0, shared: 0 });

  /** Read options for quote and history calls, minus the caller's abort signal (shared work must not die with one client). */
  function scopeOf(ctx) {
    const quote = readOptionsBase(ctx, { autoBackup: autoBackup() });
    const hist = readOptionsBase(ctx, { maxAge: false, autoBackup: autoBackup() });
    delete quote.signal;
    delete hist.signal;
    return { quote, hist, accountId: quote.accountId ?? null, key: JSON.stringify([hist.accountId ?? null, hist.allowedAccounts ?? null, Boolean(hist.allowBackup)]) };
  }

  // ── quote snapshots (movers, breadth, sector drill-down) ──
  const snapshots = new Map();
  const snapshotInflight = new Map();

  function toRow(q) {
    const ltp = fin(q.ltp);
    const close = fin(q.close);
    const changePct = fin(q.changePct) ?? (ltp !== null && close > 0 ? ((ltp - close) / close) * 100 : null);
    const change = fin(q.change) ?? (ltp !== null && close !== null ? ltp - close : null);
    const volume = fin(q.volume);
    return {
      symbol: q.symbol,
      ltp,
      change: r2(change),
      changePct: r2(changePct),
      volume,
      oi: fin(q.oi),
      turnover: ltp !== null && volume !== null ? Math.round(ltp * volume) : null,
      dayHigh: fin(q.high),
      dayLow: fin(q.low),
    };
  }

  /** Batched quotes over a list. Throws the first error when nothing at all came back. */
  async function quoteList(list, opts, stats) {
    const rows = [];
    const errors = [];
    let firstErr = null;
    let stalest = null;
    for (let i = 0; i < list.length; i += QUOTE_CHUNK) {
      const chunk = list.slice(i, i + QUOTE_CHUNK);
      try {
        stats.quoteCalls++;
        const r = await md().quotes(chunk, opts);
        for (const q of r?.items ?? []) {
          rows.push({ ...toRow(q), raw: q });
          if (q.freshness && (!stalest || q.freshness.ageMs > stalest.ageMs)) stalest = q.freshness;
        }
        for (const e of r?.errors ?? []) errors.push({ symbol: e.symbol, code: e.code ?? "INTERNAL", message: e.message ?? "No quote." });
      } catch (err) {
        firstErr ??= err;
        for (const s of chunk) errors.push(errEntry(s, err));
      }
    }
    if (!rows.length && firstErr) throw firstErr instanceof BridgeError ? firstErr : new BridgeError("INTERNAL", "The quote read failed.");
    return { rows: rows.map(({ raw: _r, ...row }) => row), errors, freshness: stalest };
  }

  async function snapshotFor(universe, scope, stats) {
    const key = `${universe}|${scope.key}|${JSON.stringify(scope.quote)}`;
    const hit = snapshots.get(key);
    if (hit && now() - hit.at < SNAPSHOT_TTL_MS) {
      stats.cacheHits++;
      return { ...hit, hit: true };
    }
    const running = snapshotInflight.get(key);
    if (running) {
      stats.shared++;
      return { ...(await running), hit: true };
    }
    const p = (async () => {
      let list = await universes.resolve(universe);
      list = [...new Set(list)].slice(0, MAX_UNIVERSE);
      const r = await quoteList(list, scope.quote, stats);
      const snap = { at: now(), universe, size: list.length, rows: r.rows, errors: r.errors, freshness: r.freshness };
      snapshots.set(key, snap);
      for (const k of [...snapshots.keys()].slice(0, Math.max(0, snapshots.size - MAX_SNAPSHOTS))) snapshots.delete(k);
      return snap;
    })().finally(() => snapshotInflight.delete(key));
    snapshotInflight.set(key, p);
    return { ...(await p), hit: false };
  }

  /** A fresh cached snapshot of any universe for this scope, else the NIFTY50 one. */
  async function constituentSnapshot(scope, stats) {
    for (const u of ["FNO", "NIFTY50"]) {
      for (const [k, s] of snapshots) {
        if (k.startsWith(`${u}|${scope.key}|`) && now() - s.at < SNAPSHOT_TTL_MS) {
          stats.cacheHits++;
          return { ...s, hit: true };
        }
      }
    }
    return snapshotFor("NIFTY50", scope, stats);
  }

  // ── daily candles, shared and cached per IST day ──
  const candleCache = new Map();
  const candleInflight = new Map();

  function normaliseCandles(list) {
    const byDay = new Map();
    for (const c of Array.isArray(list) ? list : []) {
      const close = fin(c?.close);
      const time = fin(c?.time);
      if (close === null || !(close > 0) || time === null) continue;
      const h = fin(c.high) > 0 ? c.high : close;
      const l = fin(c.low) > 0 ? c.low : close;
      byDay.set(istDay(time * 1000), { t: time, d: istDay(time * 1000), c: close, h: Math.max(h, close), l: Math.min(l, close) });
    }
    return [...byDay.values()].sort((a, b) => a.t - b.t);
  }

  async function candlesFor(symbol, scope, stats) {
    const key = `${scope.key}|${symbol}`;
    const day = today();
    const hit = candleCache.get(key);
    if (hit && hit.day === day) {
      if (!hit.error) {
        stats.cacheHits++;
        return hit.candles;
      }
      if (now() - hit.at < FAILED_CANDLE_TTL_MS) {
        stats.cacheHits++;
        throw hit.error;
      }
    }
    const running = candleInflight.get(key);
    if (running) {
      stats.shared++;
      return running;
    }
    const p = (async () => {
      try {
        stats.historyCalls++;
        const h = await md().history({ symbol, interval: "1d", countback: CANDLE_BARS }, { ...scope.hist, priority: "background" });
        const candles = normaliseCandles(h?.candles);
        if (candles.length < 2) throw new BridgeError("SYMBOL_NOT_FOUND", `Not enough daily candles for ${symbol}.`);
        candleCache.set(key, { day, at: now(), candles });
        return candles;
      } catch (err) {
        const wrapped = err instanceof BridgeError ? err : new BridgeError("INTERNAL", "The candle read failed.");
        candleCache.set(key, { day, at: now(), error: wrapped });
        throw wrapped;
      } finally {
        for (const k of [...candleCache.keys()].slice(0, Math.max(0, candleCache.size - MAX_CANDLE_ENTRIES))) candleCache.delete(k);
      }
    })().finally(() => candleInflight.delete(key));
    candleInflight.set(key, p);
    return p;
  }

  /** Candles for many symbols, background priority, bounded concurrency. Failures go to errors. */
  async function candleSets(symbols, scope, stats) {
    const errors = [];
    const sets = [];
    await mapLimit(symbols, CANDLE_CONCURRENCY, async (symbol) => {
      try {
        sets.push({ symbol, candles: await candlesFor(symbol, scope, stats) });
      } catch (err) {
        errors.push(errEntry(symbol, err));
      }
    });
    const order = new Map(symbols.map((s, i) => [s, i]));
    return { sets: sets.sort((a, b) => order.get(a.symbol) - order.get(b.symbol)), errors: errors.sort((a, b) => order.get(a.symbol) - order.get(b.symbol)) };
  }

  const meta = (ctx, scope, stats, extraMeta = {}) => ({
    requestId: ctx.requestId,
    accountId: scope.accountId,
    cost: { ...stats },
    ...extraMeta,
  });

  // ── indices ──
  let indexList = null;

  async function indexSymbols() {
    const day = today();
    if (indexList?.day === day) return indexList.symbols;
    const found = new Map();
    const symbols = extra(deps, "symbols");
    if (symbols?.search) {
      for (const q of ["NIFTY", "SENSEX", "BANKEX", "INDIAVIX", "VIX"]) {
        try {
          const res = await symbols.search({ q, kind: "INDEX", limit: 200 });
          for (const r of res?.items ?? []) {
            const canonical = r?.canonical ?? r?.symbol;
            if (typeof canonical !== "string" || (r.kind && r.kind !== "INDEX") || !/^(NSE|BSE):/.test(canonical)) continue;
            found.set(canonical, r.name ?? null);
          }
        } catch {
          /* master not loaded: fall back below */
        }
      }
    }
    const names = found.size ? [...found.keys()] : [...INDICES];
    const rank = (s) => {
      const i = INDEX_PRIORITY.indexOf(s.split(":")[1]);
      return i < 0 ? 99 : i;
    };
    const list = names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1)).slice(0, MAX_INDICES).map((symbol) => ({ symbol, name: INDEX_NAMES[symbol.split(":")[1]] ?? found.get(symbol) ?? symbol.split(":")[1] }));
    indexList = { day, symbols: list };
    return list;
  }

  async function indices(ctx) {
    const scope = scopeOf(ctx);
    const stats = newStats();
    const list = await indexSymbols();
    const r = await quoteList(list.map((i) => i.symbol), scope.quote, stats);
    const bySym = new Map(r.rows.map((row) => [row.symbol, row]));
    const items = [];
    for (const i of list) {
      const row = bySym.get(i.symbol);
      if (!row) continue;
      items.push({ symbol: i.symbol, name: i.name, ltp: row.ltp, change: row.change, changePct: row.changePct, dayHigh: row.dayHigh, dayLow: row.dayLow, rangePosition: rangePosition(row.ltp, row.dayLow, row.dayHigh) });
    }
    return { data: { count: items.length, items }, errors: r.errors, meta: meta(ctx, scope, stats, { requested: list.length, quoted: items.length, ...(r.freshness ? { freshness: r.freshness } : {}) }) };
  }

  // ── movers ──
  const SORTS = {
    gainers: [(r) => r.changePct, -1],
    losers: [(r) => r.changePct, 1],
    volume: [(r) => r.volume, -1],
    turnover: [(r) => r.turnover, -1],
    oi: [(r) => r.oi, -1],
  };

  function rank(rows, by, limit) {
    const [get, dir] = SORTS[by];
    return rows
      .filter((r) => get(r) !== null)
      .sort((a, b) => (get(a) - get(b)) * dir || (a.symbol < b.symbol ? -1 : 1))
      .slice(0, limit)
      .map((r, i) => ({ rank: i + 1, ...r }));
  }

  async function movers(ctx) {
    const q = ctx.query;
    // FNO and NIFTY50, plus INDICES and any list from config scanner.universes (the scanner's own universes).
    const universe = enumParam(q, "universe", [...new Set(["FNO", "NIFTY50", ...(typeof universes.list === "function" ? universes.list().map((u) => u.name) : [])])], "FNO");
    const by = enumParam(q, "by", MOVER_KEYS, "gainers");
    const limit = intParam(q, "limit", 1, 50, 10);
    const scope = scopeOf(ctx);
    const stats = newStats();
    const snap = await snapshotFor(universe, scope, stats);
    const items = rank(snap.rows, by, limit);
    const note = by === "oi" && !items.length ? "Cash quotes carry no open interest, so there is nothing to rank by oi in this universe." : null;
    return {
      data: { universe, by, limit, asOf: new Date(snap.at).toISOString(), summary: advanceDecline(snap.rows), items, note },
      errors: snap.errors,
      meta: meta(ctx, scope, stats, { requested: snap.size, quoted: snap.rows.length, cache: { hit: snap.hit, ageMs: Math.max(0, now() - snap.at), ttlMs: SNAPSHOT_TTL_MS }, ...(snap.freshness ? { freshness: snap.freshness } : {}) }),
    };
  }

  // ── sectors ──
  async function sectors(ctx) {
    const q = ctx.query;
    const tf = enumParam(q, "tf", ["1d", "1w", "1m"], "1d");
    const drillRaw = opt(q, "drill");
    const drill = drillRaw === undefined ? null : SECTORS.find((s) => s.key === drillRaw.toUpperCase());
    if (drillRaw !== undefined && !drill) throw invalid("drill", `drill must be one of ${SECTORS.map((s) => s.key).join(", ")}.`);
    const scope = scopeOf(ctx);
    const stats = newStats();
    const errors = [];
    let quoted = { rows: [], errors: [], freshness: null };
    try {
      quoted = await quoteList(SECTORS.map((s) => s.symbol), scope.quote, stats);
    } catch (err) {
      if (tf === "1d") throw err;
      errors.push(errEntry("sectors", err));
    }
    errors.push(...quoted.errors);
    const quote = new Map(quoted.rows.map((r) => [r.symbol, r]));
    let candles = new Map();
    if (tf !== "1d") {
      const c = await candleSets(SECTORS.map((s) => s.symbol), scope, stats);
      candles = new Map(c.sets.map((s) => [s.symbol, s.candles]));
      errors.push(...c.errors.filter((e) => !errors.some((x) => x.symbol === e.symbol)));
    }
    const items = SECTORS.map((s) => {
      const row = quote.get(s.symbol);
      let changePct = null;
      if (tf === "1d") changePct = row?.changePct ?? null;
      else {
        const list = candles.get(s.symbol);
        if (list) {
          const closes = list.map((c) => c.c);
          if (row?.ltp > 0 && list.at(-1).d === today()) closes[closes.length - 1] = row.ltp;
          const ref = closes[closes.length - 1 - SECTOR_BARS[tf]];
          if (ref > 0) changePct = r2(((closes.at(-1) - ref) / ref) * 100);
        }
      }
      return { key: s.key, name: s.name, symbol: s.symbol, ltp: row?.ltp ?? null, changePct, constituentCount: s.members.length };
    });
    items.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity) || (a.key < b.key ? -1 : 1));
    items.forEach((it, i) => {
      it.rank = it.changePct === null ? null : i + 1;
    });
    const data = { tf, basis: tf === "1d" ? "quotes" : `daily candles, ${SECTOR_BARS[tf]} sessions back`, count: items.length, items };
    if (drill) {
      const snap = await constituentSnapshot(scope, stats);
      const bySym = new Map(snap.rows.map((r) => [r.symbol, r]));
      const cons = drill.members.map((m) => {
        const r = bySym.get(`NSE:${m}`);
        return { symbol: `NSE:${m}`, ltp: r?.ltp ?? null, changePct: r?.changePct ?? null };
      });
      data.drill = { key: drill.key, name: drill.name, tf: "1d", basis: `quote snapshot of ${snap.universe}`, asOf: new Date(snap.at).toISOString(), constituents: cons.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity) || (a.symbol < b.symbol ? -1 : 1)) };
    }
    return { data, errors, meta: meta(ctx, scope, stats, { ...(quoted.freshness ? { freshness: quoted.freshness } : {}) }) };
  }

  // ── breadth ──
  let breadth = null; // { version, day, computedAt, status, universe, symbols, data } | null
  let breadthLoaded = false;
  const job = { running: false, startedAt: null, done: 0, total: 0, lastError: null, promise: null };

  function loadBreadth() {
    if (breadthLoaded) return;
    breadthLoaded = true;
    if (!breadthFile || !existsSync(breadthFile)) return;
    try {
      const doc = JSON.parse(readFileSync(breadthFile, "utf8"));
      if (doc && typeof doc.day === "string" && typeof doc.computedAt === "string" && doc.data && typeof doc.data === "object" && ["ready", "partial"].includes(doc.status)) breadth = doc;
    } catch (err) {
      warn("breadth cache is unreadable; starting empty", err);
    }
  }

  function saveBreadth() {
    if (!breadthFile || !breadth) return;
    try {
      writeFileAtomic(breadthFile, `${JSON.stringify(breadth, null, 2)}\n`);
    } catch (err) {
      warn("could not persist breadth", err);
    }
  }

  async function breadthUniverse() {
    try {
      return { name: "FNO", list: await universes.resolve("FNO") };
    } catch {
      return { name: "NIFTY50", list: await universes.resolve("NIFTY50") };
    }
  }

  async function runBreadth(scope) {
    const stats = newStats();
    try {
      const { name, list } = await breadthUniverse();
      const symbols = [...new Set(list)].slice(0, BREADTH_MAX_SYMBOLS);
      job.total = symbols.length;
      job.done = 0;
      const sets = [];
      const failed = [];
      await mapLimit(symbols, CANDLE_CONCURRENCY, async (symbol) => {
        try {
          sets.push({ symbol: symbol.replace(/^[A-Z]+:/, ""), candles: await candlesFor(symbol, scope, stats) });
        } catch (err) {
          failed.push(errEntry(symbol, err));
        } finally {
          job.done++;
        }
      });
      if (!sets.length) throw new BridgeError("UPSTREAM_ERROR", "No daily candles could be read for the breadth universe.");
      const data = computeBreadth(sets);
      data.symbols = { total: symbols.length, used: data.symbols.used, failed: failed.length, truncated: list.length > symbols.length };
      breadth = { version: 1, day: today(), computedAt: new Date(now()).toISOString(), status: failed.length ? "partial" : "ready", universe: name, data };
      job.lastError = null;
      saveBreadth();
    } catch (err) {
      job.lastError = err instanceof BridgeError ? (err.detail ?? err.message) : "The breadth job failed.";
      warn("breadth job failed", err);
    } finally {
      job.running = false;
    }
  }

  function startBreadth(scope) {
    loadBreadth();
    if (job.running) return { started: false, reason: "already running" };
    if (breadth?.day === today() && breadth.status === "ready" && now() - Date.parse(breadth.computedAt) < BREADTH_MIN_REFRESH_MS) return { started: false, reason: "fresh" };
    job.running = true;
    job.startedAt = new Date(now()).toISOString();
    job.done = 0;
    job.total = 0;
    job.promise = runBreadth(scope);
    return { started: true, reason: null };
  }

  const breadthView = () => {
    loadBreadth();
    const current = breadth?.day === today();
    return {
      status: breadth ? (current ? breadth.status : "pending") : "pending",
      computedAt: breadth?.computedAt ?? null,
      stale: Boolean(breadth && !current),
      universe: breadth?.universe ?? null,
      breadth: breadth?.data ?? null,
      job: { running: job.running, startedAt: job.startedAt, done: job.done, total: job.total, lastError: job.lastError },
    };
  };

  async function breadthGet(ctx) {
    const scope = scopeOf(ctx);
    const stats = newStats();
    const errors = [];
    let ad = null;
    let adMeta = {};
    try {
      let snap;
      try {
        snap = await snapshotFor("FNO", scope, stats);
      } catch {
        snap = await snapshotFor("NIFTY50", scope, stats);
      }
      ad = { universe: snap.universe, asOf: new Date(snap.at).toISOString(), ...advanceDecline(snap.rows) };
      adMeta = { requested: snap.size, quoted: snap.rows.length, ...(snap.freshness ? { freshness: snap.freshness } : {}) };
    } catch (err) {
      errors.push(errEntry("advanceDecline", err));
    }
    const v = breadthView();
    return { data: { advanceDecline: ad, ...v }, errors, meta: meta(ctx, scope, stats, adMeta) };
  }

  async function breadthRefresh(ctx) {
    const scope = scopeOf(ctx);
    const r = startBreadth(scope);
    const v = breadthView();
    return json({ data: { ...r, status: v.status, computedAt: v.computedAt, job: v.job }, meta: meta(ctx, scope, newStats(), { maxHistoryCalls: BREADTH_MAX_SYMBOLS }) }, { status: r.started ? 202 : 200 });
  }

  // ── rotation ──
  async function rotation(ctx) {
    const q = ctx.query;
    const tf = enumParam(q, "tf", ["1d", "1w"], "1w");
    const tail = intParam(q, "tail", 0, 12, 5);
    const params = ROTATION[tf];
    const scope = scopeOf(ctx);
    const stats = newStats();
    const c = await candleSets([BENCHMARK, ...SECTORS.map((s) => s.symbol)], scope, stats);
    const errors = [...c.errors];
    const bySym = new Map(c.sets.map((s) => [s.symbol, s.candles]));
    const bench = bySym.get(BENCHMARK);
    if (!bench) throw new BridgeError("UPSTREAM_ERROR", `No daily candles for ${BENCHMARK}, so relative rotation cannot be computed.`, {});
    const benchBy = new Map(bench.map((x) => [x.d, x.c]));
    const items = [];
    for (const s of SECTORS) {
      const list = bySym.get(s.symbol);
      if (!list) continue;
      const rs = list.filter((x) => benchBy.has(x.d)).map((x) => ({ d: x.d, rs: (x.c / benchBy.get(x.d)) * 100 })).filter((p) => Number.isFinite(p.rs) && p.rs > 0);
      const series = rotationSeries(rs, params);
      if (!series.length) {
        errors.push({ symbol: s.symbol, code: "INSUFFICIENT_HISTORY", message: `Needs at least ${params.window + params.mom} ${tf === "1w" ? "weekly samples" : "daily bars"} aligned with NIFTY; ${rs.length} bars found.` });
        continue;
      }
      const last = series.at(-1);
      items.push({ key: s.key, name: s.name, symbol: s.symbol, ratio: last.ratio, momentum: last.momentum, quadrant: quadrant(last.ratio, last.momentum), asOf: last.date, tail: tail ? series.slice(-1 - tail, -1) : [] });
    }
    items.sort((a, b) => b.ratio - a.ratio || (a.key < b.key ? -1 : 1));
    const method = `RS = sector / ${BENCHMARK.split(":")[1]} x 100; EMA(${params.span}) smoothed; RS-Ratio = 100 + rolling z-score (window ${params.window}) of smoothed RS; RS-Momentum = 100 + rolling z-score (window ${params.window}) of its ${params.mom}-step rate of change; ${tf === "1w" ? "sampled every 5th bar" : "daily bars"}. A proxy, not the official RRG formula.`;
    return { data: { tf, tail, benchmark: BENCHMARK, method, count: items.length, items }, errors, meta: meta(ctx, scope, stats, { maxHistoryCalls: SECTORS.length + 1 }) };
  }

  // ── correlation ──
  async function correlation(ctx) {
    const q = ctx.query;
    const days = intParam(q, "days", 1, 1000, 120);
    if (![60, 120, 250].includes(days)) throw invalid("days", "days must be 60, 120 or 250.");
    const pairsN = intParam(q, "pairs", 1, 20, 5);
    const raw = (opt(q, "universe") ?? "NIFTY50").trim();
    let symbols;
    if (raw.toUpperCase() === "NIFTY50") symbols = await universes.resolve("NIFTY50");
    else {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > MAX_CORRELATION_SYMBOLS) throw invalid("universe", `At most ${MAX_CORRELATION_SYMBOLS} symbols.`);
      symbols = [...new Set(parts.map((p, i) => normaliseSymbol(p, `universe.${i}`)))];
    }
    if (symbols.length < 2) throw invalid("universe", "Give NIFTY50 or at least two symbols.");
    if (symbols.length > MAX_CORRELATION_SYMBOLS) throw invalid("universe", `At most ${MAX_CORRELATION_SYMBOLS} symbols.`);
    const scope = scopeOf(ctx);
    const stats = newStats();
    const c = await candleSets(symbols, scope, stats);
    const errors = [...c.errors];
    const rets = c.sets.map(({ symbol, candles }) => {
      const m = new Map();
      for (let i = 1; i < candles.length; i++) {
        const r = Math.log(candles[i].c / candles[i - 1].c);
        if (Number.isFinite(r)) m.set(candles[i].d, r);
      }
      return { symbol, m };
    });
    if (rets.length < 2) throw new BridgeError("UPSTREAM_ERROR", "Fewer than two symbols had daily candles, so there is no correlation to compute.");
    const count = new Map();
    for (const { m } of rets) for (const d of m.keys()) count.set(d, (count.get(d) ?? 0) + 1);
    const need = Math.max(2, Math.ceil(rets.length / 2));
    const dates = [...count.keys()].filter((d) => count.get(d) >= need).sort().slice(-days);
    const names = rets.map((r) => r.symbol);
    const matrix = names.map(() => names.map(() => null));
    const pairs = [];
    for (let i = 0; i < rets.length; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < rets.length; j++) {
        const xs = [];
        const ys = [];
        for (const d of dates) {
          const a = rets[i].m.get(d);
          const b = rets[j].m.get(d);
          if (a !== undefined && b !== undefined) (xs.push(a), ys.push(b));
        }
        const r = r4(pearson(xs, ys));
        matrix[i][j] = r;
        matrix[j][i] = r;
        if (r !== null) pairs.push({ a: names[i], b: names[j], correlation: r, observations: xs.length });
      }
    }
    const byHigh = [...pairs].sort((x, y) => y.correlation - x.correlation || (x.a + x.b < y.a + y.b ? -1 : 1));
    const byLow = [...pairs].sort((x, y) => x.correlation - y.correlation || (x.a + x.b < y.a + y.b ? -1 : 1));
    return {
      data: { days, returns: "daily log returns, pairwise on common dates", observations: dates.length, symbols: names, matrix, mostCorrelated: byHigh.slice(0, pairsN), leastCorrelated: byLow.slice(0, pairsN) },
      errors,
      meta: meta(ctx, scope, stats, { requested: symbols.length, used: names.length, maxHistoryCalls: MAX_CORRELATION_SYMBOLS }),
    };
  }

  return {
    handlers: { indices, movers, sectors, breadthGet, breadthRefresh, rotation, correlation },
    /** Resolves when the breadth job that is running (if any) has finished. For tests and shutdown. */
    whenBreadthIdle: async () => {
      await job.promise;
    },
    clearCaches() {
      snapshots.clear();
      candleCache.clear();
      indexList = null;
    },
  };
}

const services = new WeakMap();
export function marketsFor(deps) {
  let s = services.get(deps);
  if (!s) services.set(deps, (s = createMarkets(deps)));
  return s;
}

/** Never let a raw error out: BridgeErrors and aborts pass, anything else becomes INTERNAL. */
const guard = (fn) => async (ctx) => {
  try {
    return await fn(ctx);
  } catch (err) {
    if (err instanceof BridgeError || err?.name === "AbortError") throw err;
    throw new BridgeError("INTERNAL", "The markets overview could not be computed.");
  }
};

/** @returns {Array<[string, string, object, (ctx: any) => Promise<object>]>} */
export function marketsRoutes(deps) {
  const h = marketsFor(deps).handlers;
  const B = "/v1/analytics/markets";
  return [
    ["GET", `${B}/indices`, { scope: "read" }, guard(h.indices)],
    ["GET", `${B}/movers`, { scope: "read" }, guard(h.movers)],
    ["GET", `${B}/sectors`, { scope: "read" }, guard(h.sectors)],
    ["GET", `${B}/breadth`, { scope: "read" }, guard(h.breadthGet)],
    ["POST", `${B}/breadth/refresh`, { scope: "read", body: "none" }, guard(h.breadthRefresh)],
    ["GET", `${B}/rotation`, { scope: "read" }, guard(h.rotation)],
    ["GET", `${B}/correlation`, { scope: "read" }, guard(h.correlation)],
  ];
}
