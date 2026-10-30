/**
 * Futures chain and basis history (stream S15), ported read-only from OptionsDesk's FuturesChain page.
 *
 *   GET /v1/analytics/futures?underlying=[&expiries=3]                        each upcoming future: ltp, oi, volume, basis, carry; calendar spreads; roll cost
 *   GET /v1/analytics/basis-history?underlying=&expiry=[&interval=1d&countback=30]  future minus spot per candle, with mean, min, max, z-score
 *
 * Read-only. Partial failures (one expiry with no quote, one leg of the history) go in `errors`, never a throw.
 */
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { daysBetween } from "../../lib/blackScholes.mjs";
import { futuresBasis, nowMsOf, upcomingExpiries } from "./math.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const round = (n, d) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const INTERVALS = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d"];

function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}
function underlyingParam(q) {
  const u = opt(q, "underlying");
  if (!u) throw invalid("underlying", "underlying is required, for example NIFTY.");
  if (!/^[A-Za-z0-9][A-Za-z0-9&_-]{0,29}$/.test(u)) throw invalid("underlying", "underlying is not a valid symbol.");
  return u.toUpperCase();
}

/** Mean, min, max, population standard deviation and the z-score of the last value. */
export function seriesStats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { count: 0, mean: null, min: null, max: null, stdDev: null, latest: null, zScore: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const latest = v.at(-1);
  return {
    count: v.length,
    mean: round(mean, 4),
    min: round(Math.min(...v), 4),
    max: round(Math.max(...v), 4),
    stdDev: round(sd, 4),
    latest: round(latest, 4),
    zScore: v.length >= 2 && sd > 0 ? round((latest - mean) / sd, 3) : null,
  };
}

/** @param {object} deps */
export function futuresChainRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const meta = (ctx, opts, freshness) => ({ requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) });

  async function chain(ctx) {
    const underlying = underlyingParam(ctx.query);
    const count = intParam(ctx.query, "expiries", 1, 6, 3);
    const opts = readOptions(ctx);
    const fx = defaultOptionExchange(underlying);
    const spotSym = `${fx === "BFO" ? "BSE" : "NSE"}:${underlying}`;
    const list = await md().expiries(underlying, opts);
    const nowMs = nowMsOf(deps);
    const picked = upcomingExpiries(list.expiries, nowMs).slice(0, count);
    if (picked.length === 0) throw new BridgeError("SYMBOL_NOT_FOUND", `No upcoming futures expiries were found for ${underlying}.`);
    const futSyms = picked.map((e) => `${fx}:${underlying}-${e}-FUT`);
    const r = await md().quotes([spotSym, ...futSyms], opts);
    const byMap = new Map(r.items.map((i) => [i.symbol, i]));
    const spot = byMap.get(spotSym)?.ltp ?? null;

    const futures = picked.map((expiry, i) => {
      const q = byMap.get(futSyms[i]);
      const days = daysBetween(new Date(nowMs), expiry);
      const ltp = q?.ltp ?? null;
      return {
        expiry,
        symbol: futSyms[i],
        ltp,
        oi: q?.oi ?? null,
        volume: q?.volume ?? null,
        daysToExpiry: round(days, 2),
        ...futuresBasis({ spot, future: ltp, daysToExpiry: days }),
      };
    });

    const calendarSpreads = [];
    for (let i = 0; i + 1 < futures.length; i += 1) {
      const a = futures[i];
      const b = futures[i + 1];
      const gap = (Date.parse(b.expiry) - Date.parse(a.expiry)) / 86_400_000;
      if (!(a.ltp > 0) || !(b.ltp > 0)) {
        calendarSpreads.push({ near: a.expiry, far: b.expiry, spread: null, spreadPct: null, daysBetween: round(gap, 2), annualisedPct: null });
        continue;
      }
      const spread = b.ltp - a.ltp;
      const pct = (spread / a.ltp) * 100;
      calendarSpreads.push({ near: a.expiry, far: b.expiry, spread: round(spread, 2), spreadPct: round(pct, 3), daysBetween: round(gap, 2), annualisedPct: gap > 0 ? round(pct * (365 / gap), 2) : null });
    }
    const first = calendarSpreads[0];
    return {
      data: {
        underlying,
        spotSymbol: spotSym,
        spot,
        futures,
        calendarSpreads,
        rollCostPct: first?.spreadPct ?? null,
        rollCostAnnualisedPct: first?.annualisedPct ?? null,
      },
      errors: r.errors,
      meta: meta(ctx, opts, list.freshness),
    };
  }

  async function basisHistory(ctx) {
    const q = ctx.query;
    const underlying = underlyingParam(q);
    const expiry = opt(q, "expiry");
    if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw invalid("expiry", "expiry is required as YYYY-MM-DD.");
    const interval = opt(q, "interval") ?? "1d";
    if (!INTERVALS.includes(interval)) throw invalid("interval", `interval must be one of ${INTERVALS.join(", ")}.`);
    const countback = intParam(q, "countback", 1, 1000, 30);
    const opts = readOptions(ctx);
    const fx = defaultOptionExchange(underlying);
    const spotSym = `${fx === "BFO" ? "BSE" : "NSE"}:${underlying}`;
    const futSym = `${fx}:${underlying}-${expiry}-FUT`;
    const [f, s] = await Promise.allSettled([
      md().history({ symbol: futSym, interval, countback }, opts),
      md().history({ symbol: spotSym, interval, countback }, opts),
    ]);
    const errors = [];
    for (const [res, symbol] of [[f, futSym], [s, spotSym]]) {
      if (res.status === "rejected") {
        if (res.reason?.name === "AbortError") throw res.reason;
        errors.push({ symbol, code: res.reason?.code ?? "INTERNAL", message: res.reason?.detail ?? res.reason?.message ?? "History failed." });
      }
    }
    const spotByTime = new Map(s.status === "fulfilled" ? s.value.candles.map((c) => [c.time, c]) : []);
    const series = [];
    if (f.status === "fulfilled") {
      for (const c of f.value.candles) {
        const sc = spotByTime.get(c.time);
        if (!sc || !(c.close > 0) || !(sc.close > 0)) continue;
        const basis = c.close - sc.close;
        series.push({ time: c.time, future: c.close, spot: sc.close, basis: round(basis, 2), basisPct: round((basis / sc.close) * 100, 3) });
      }
    }
    return {
      data: {
        underlying,
        expiry,
        interval,
        spotSymbol: spotSym,
        futureSymbol: futSym,
        series,
        basis: seriesStats(series.map((p) => p.basis)),
        basisPct: seriesStats(series.map((p) => p.basisPct)),
      },
      errors,
      meta: meta(ctx, opts, f.status === "fulfilled" ? f.value.freshness : undefined),
    };
  }

  return [
    ["GET", "/v1/analytics/futures", { scope: "read" }, chain],
    ["GET", "/v1/analytics/basis-history", { scope: "read" }, basisHistory],
  ];
}
