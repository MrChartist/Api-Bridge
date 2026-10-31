/**
 * Volatility statistics for stream S15 (docs: analytics/volStats.openapi.yaml). Read-only.
 *
 *   GET /v1/analytics/vol-stats?underlying=NIFTY[&days=250]   HV (10/20/30/60 close-to-close, Parkinson), ATM IV,
 *                                                             IV vs HV20, IV rank and percentile, expected move
 *   GET /v1/analytics/vol-stats/term?underlying=NIFTY         ATM IV for the next 4 expiries
 *
 * Volatilities are in percent, annualised: HV with sqrt(252) trading days, IV as the chain reports it. HV comes from
 * daily candles (marketData.history). ATM IV comes from the nearest expiry with at least 3 days left. One ATM-IV
 * point per underlying per IST day is kept in <deps.paths.dataDir>/analytics/iv-history.json (loaded lazily, newest 400
 * days, atomic 0600 writes; a corrupt file is moved aside and disk errors are logged, never surfaced). Until 20 days
 * of IV history exist, ivRank and ivPercentile are null and HV20 rank/percentile is returned as a labelled fallback.
 *
 * Labels (IV / HV20): above 1.15 "rich", below 0.85 "cheap", otherwise "fair".
 */
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { expiryCutoffMs, ivSkew, upcomingExpiries } from "./math.mjs";

export const HV_WINDOWS = Object.freeze([10, 20, 30, 60]);
export const RICH_RATIO = 1.15;
export const CHEAP_RATIO = 0.85;
export const MIN_IV_DAYS = 20;
export const MAX_IV_DAYS = 400;
export const MIN_DTE = 3;
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
const TRADING_DAYS = 252;
const MAX_LOOKBACK = 1000;
const MIN_LOOKBACK = 30;

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

/** Sample standard deviation. */
function stdev(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Log returns of consecutive closes (non-positive closes are dropped first). */
export function logReturns(closes) {
  const c = closes.filter((x) => Number.isFinite(x) && x > 0);
  const out = [];
  for (let i = 1; i < c.length; i++) out.push(Math.log(c[i] / c[i - 1]));
  return out;
}

/** Close-to-close HV in percent over the last n returns (needs n+1 closes), else null. */
export function closeHv(closes, n) {
  const rets = logReturns(closes);
  if (rets.length < n) return null;
  const s = stdev(rets.slice(-n));
  return s === null ? null : r2(s * Math.sqrt(TRADING_DAYS) * 100);
}

/** Parkinson high-low HV in percent over the last n candles, else null. */
export function parkinsonHv(candles, n) {
  const ok = candles.filter((c) => c.high > 0 && c.low > 0 && c.high >= c.low);
  if (ok.length < n) return null;
  const sum = ok.slice(-n).reduce((s, c) => s + Math.log(c.high / c.low) ** 2, 0);
  return r2(Math.sqrt(sum / (4 * Math.log(2) * n)) * Math.sqrt(TRADING_DAYS) * 100);
}

/** Rolling HV20 series (percent), oldest first. */
export function rollingHv(closes, n = 20) {
  const c = closes.filter((x) => Number.isFinite(x) && x > 0);
  const out = [];
  for (let end = n + 1; end <= c.length; end++) out.push(closeHv(c.slice(end - n - 1, end), n));
  return out.filter((v) => v !== null);
}

/**
 * Rank (position between min and max, 0-100) and percentile (share of the window strictly below the current value,
 * 0-100) of the last value in `series`. Null when fewer than 2 points or no range.
 */
export function rankAndPercentile(series) {
  if (series.length < 2) return { rank: null, percentile: null };
  const cur = series.at(-1);
  const min = Math.min(...series);
  const max = Math.max(...series);
  const below = series.filter((v) => v < cur).length;
  return { rank: max > min ? r2(((cur - min) / (max - min)) * 100) : null, percentile: r2((below / series.length) * 100) };
}

export function labelIvHv(ratio) {
  if (!Number.isFinite(ratio)) return null;
  return ratio > RICH_RATIO ? "rich" : ratio < CHEAP_RATIO ? "cheap" : "fair";
}

/** 1-sigma expected move: spot x iv x sqrt(dte/365), iv in percent. */
export function expectedMove(spot, ivPct, dte) {
  if (!(spot > 0) || !(ivPct > 0) || !(dte > 0)) return null;
  const move = spot * (ivPct / 100) * Math.sqrt(dte / 365);
  return { oneSigma: r2(move), pct: r2((move / spot) * 100), lower: r2(spot - move), upper: r2(spot + move) };
}

/** @returns {Array<[string, string, {scope: "read"}, (ctx: any) => Promise<object>]>} */
export function volStatsRoutes(deps) {
  const md = () => deps.marketData;
  const now = () => (extra(deps, "now") instanceof Function ? deps.now() : extra(deps, "clock")?.now ? deps.clock.now() : Date.now());
  const dataDir = extra(deps, "paths")?.dataDir;
  const filePath = dataDir ? join(dataDir, "analytics", "iv-history.json") : null;
  const baseLog = extra(deps, "logger");
  const log = baseLog?.child ? baseLog.child({ module: "vol-stats" }) : baseLog;
  const warn = (msg, err) => {
    try {
      log?.warn?.({ err: err?.message ?? String(err) }, msg);
    } catch {
      /* logging must never fail a request */
    }
  };
  /** UNDERLYING -> Map(date -> iv) */
  const history = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") warn("iv history unreadable; starting empty", err);
      return;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || typeof doc.series !== "object" || doc.series === null || Array.isArray(doc.series)) throw new Error("unexpected shape");
      for (const [u, pts] of Object.entries(doc.series)) {
        if (!Array.isArray(pts)) continue;
        const m = new Map();
        for (const p of pts) if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.iv) && p.iv > 0) m.set(p.date, p.iv);
        history.set(u, m);
        trim(m);
      }
    } catch (err) {
      history.clear();
      warn("iv history file is corrupt; moving it aside", err);
      try {
        renameSync(filePath, `${filePath}.corrupt-${now()}`);
      } catch (e2) {
        warn("could not move the corrupt iv history file aside", e2);
      }
    }
  }

  function trim(m) {
    for (const k of [...m.keys()].sort().reverse().slice(MAX_IV_DAYS)) m.delete(k);
  }
  const points = (u) => [...(history.get(u) ?? new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  function save() {
    if (!filePath) return;
    try {
      const series = {};
      for (const u of history.keys()) series[u] = points(u).map(([date, iv]) => ({ date, iv }));
      writeFileAtomic(filePath, `${JSON.stringify({ version: 1, series }, null, 2)}\n`);
    } catch (err) {
      warn("could not persist iv history", err);
    }
  }

  /** One point per underlying per IST day: the latest reading of the day wins. */
  function record(u, iv, nowMs) {
    const m = history.get(u) ?? new Map();
    history.set(u, m);
    m.set(istDay(nowMs), iv);
    trim(m);
    save();
  }

  const underlyingOf = (ctx) => {
    const u = ctx.query.get("underlying");
    if (!u) throw invalid("underlying", "underlying is required, for example NIFTY.");
    if (!/^[A-Za-z0-9&_-]{1,30}$/.test(u)) throw invalid("underlying", "underlying is not a valid name.");
    return u.toUpperCase();
  };
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const dteOf = (expiry, nowMs) => (expiryCutoffMs(expiry) - nowMs) / DAY_MS;

  async function atmFor(underlying, expiry, opts) {
    const chain = await md().optionChain({ underlying, expiry, strikes: 5, greeks: true }, opts);
    const s = ivSkew(chain);
    return { atmIv: s.atmIv, atmStrike: s.atmStrike, spot: chain.underlyingLtp ?? null, freshness: chain.freshness };
  }

  async function volStats(ctx) {
    const underlying = underlyingOf(ctx);
    let days = 250;
    const rawDays = ctx.query.get("days");
    if (rawDays !== null && rawDays !== "") {
      if (!/^\d+$/.test(rawDays) || Number(rawDays) < MIN_LOOKBACK || Number(rawDays) > MAX_LOOKBACK) throw invalid("days", `days must be a whole number from ${MIN_LOOKBACK} to ${MAX_LOOKBACK}.`);
      days = Number(rawDays);
    }
    const opts = readOptions(ctx);
    const nowMs = now();
    const cash = defaultOptionExchange(underlying) === "BFO" ? "BSE" : "NSE";
    const hist = await md().history({ symbol: `${cash}:${underlying}`, interval: "1d", countback: days + 1 }, readOptionsBase(ctx, { maxAge: false, autoBackup: autoBackupFor(deps) }));
    const candles = (hist.candles ?? []).filter((c) => c && c.close > 0);
    const closes = candles.map((c) => c.close);

    const hv = {};
    for (const n of HV_WINDOWS) hv[`hv${n}`] = closeHv(closes, n);
    const parkinson = { window: 20, hv: parkinsonHv(candles, 20) };
    const series = rollingHv(closes, 20);
    const hvRank = rankAndPercentile(series);
    const hv20 = hv.hv20;

    // ATM IV from the nearest expiry with enough days left.
    const list = await md().expiries(underlying, opts);
    const expiry = upcomingExpiries(list.expiries, nowMs).find((e) => dteOf(e, nowMs) >= MIN_DTE) ?? null;
    let iv = { expiry: null, daysToExpiry: null, atmStrike: null, atmIv: null, spot: null };
    let freshness = hist.freshness;
    const notes = [];
    if (expiry) {
      const a = await atmFor(underlying, expiry, opts);
      iv = { expiry, daysToExpiry: r2(dteOf(expiry, nowMs)), atmStrike: a.atmStrike, atmIv: a.atmIv, spot: a.spot };
      freshness = a.freshness ?? freshness;
    } else notes.push(`No expiry with at least ${MIN_DTE} days left was found, so there is no ATM IV.`);
    if (expiry && iv.atmIv === null) notes.push("The chain carried no usable ATM IV.");

    load();
    if (iv.atmIv !== null) record(underlying, iv.atmIv, nowMs);
    const ivSeries = points(underlying).map(([, v]) => v);
    const ivHistoryDays = ivSeries.length;
    const enough = ivHistoryDays >= MIN_IV_DAYS && iv.atmIv !== null;
    const ivRP = enough ? rankAndPercentile(ivSeries) : { rank: null, percentile: null };
    if (!enough) notes.push(`IV rank and percentile need at least ${MIN_IV_DAYS} days of stored ATM IV; ${ivHistoryDays} so far. HV20 rank is shown instead (ivRankFallback).`);

    const spread = iv.atmIv !== null && hv20 !== null ? r2(iv.atmIv - hv20) : null;
    const ratio = iv.atmIv !== null && hv20 ? r4(iv.atmIv / hv20) : null;
    const move = expectedMove(iv.spot, iv.atmIv, iv.daysToExpiry);
    const data = {
      underlying,
      lookbackDays: days,
      candles: candles.length,
      hv: { ...hv, parkinson20: parkinson.hv, annualisation: `sqrt(${TRADING_DAYS})`, unit: "percent" },
      hv20Rank: { ...hvRank, observations: series.length, current: hv20 },
      iv: { ...iv, unit: "percent" },
      ivVsHv: { spread, ratio, label: labelIvHv(ratio), thresholds: { rich: `ratio > ${RICH_RATIO}`, cheap: `ratio < ${CHEAP_RATIO}`, fair: "otherwise" } },
      ivRank: ivRP.rank,
      ivPercentile: ivRP.percentile,
      ivHistoryDays,
      ivRankFallback: enough ? null : { basis: "hv20", rank: hvRank.rank, percentile: hvRank.percentile },
      expectedMove: move ? { ...move, expiry, sigma: 1, formula: "spot x iv x sqrt(dte/365)" } : null,
      note: notes.length ? notes.join(" ") : null,
    };
    return { data, meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) } };
  }

  async function term(ctx) {
    const underlying = underlyingOf(ctx);
    const opts = readOptions(ctx);
    const nowMs = now();
    const list = await md().expiries(underlying, opts);
    const picked = upcomingExpiries(list.expiries, nowMs).slice(0, 4);
    const expiries = [];
    for (const expiry of picked) {
      const a = await atmFor(underlying, expiry, opts);
      expiries.push({ expiry, daysToExpiry: r2(dteOf(expiry, nowMs)), atmStrike: a.atmStrike, atmIv: a.atmIv });
    }
    const [near, far] = [expiries[0]?.atmIv, expiries.at(-1)?.atmIv];
    const shape = expiries.length < 2 || near == null || far == null ? null : far > near ? "contango" : far < near ? "backwardation" : "flat";
    return { data: { underlying, unit: "percent", termStructure: shape, expiries }, meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(list.freshness ? { freshness: list.freshness } : {}) } };
  }

  return [
    ["GET", "/v1/analytics/vol-stats", { scope: "read" }, volStats],
    ["GET", "/v1/analytics/vol-stats/term", { scope: "read" }, term],
  ];
}
