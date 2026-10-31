/**
 * Technical readouts for stream S15: the indicator values a chart would show, computed by the Bridge from any broker's
 * daily candles (GET /v1/history) and one live quote. Works with every adapter that serves candles and in demo mode;
 * no broker-specific "technical data" API is needed. Read scope only: nothing here can place an order.
 *
 *   GET /v1/analytics/technicals?symbols=NSE:RELIANCE,NSE:TCS[..max 25][&account=]
 *
 * Every value comes from the ChartistScript kernel (server/vendor/chartist-core/kernel), the same functions the
 * dashboard's charts draw with: EMA and SMA (20, 50, 200), RSI 14 (Wilder), MACD 12/26/9, ADX 14 with +DI/-DI,
 * Stochastic 14/3, ATR 14, Bollinger 20/2, Supertrend 10/3, and classic floor pivots from the previous session's
 * high, low and close. The 52-week range is the highest high and lowest low of the last 250 sessions.
 *
 * Cost: one cached daily-candle read per symbol (300 bars, background priority, cached for the IST day and shared by
 * every caller with the same account scope; a failed read is remembered for 5 minutes), plus ONE batched quote call
 * for all symbols so the latest session follows the live price. A quote that opens a new session (its previous close
 * equals the last daily close) adds that session as a bar; otherwise it updates the last bar.
 *
 * `facts` are plain statements of what the numbers show ("RSI 14 is above 70", "Close crossed above the 50-day EMA"),
 * never advice. Every number is finite or null.
 *
 * deps: marketData (required), clock, logger.
 */
import * as kernel from "../../vendor/chartist-core/kernel/index.js";
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";

export const MAX_SYMBOLS = 25;
export const BARS = 300;
export const RANGE_BARS = 250;
export const CANDLE_CONCURRENCY = 3;
export const FAILED_TTL_MS = 5 * 60_000;
const MAX_CACHE = 400;
const IST_MS = 5.5 * 3_600_000;
/** Moving averages read: [key, kind, length]. */
export const AVERAGES = Object.freeze([
  ["ema20", "ema", 20],
  ["ema50", "ema", 50],
  ["ema200", "ema", 200],
  ["sma20", "sma", 20],
  ["sma50", "sma", 50],
  ["sma200", "sma", 200],
]);

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rnd = (v, dp = 2) => {
  const n = fin(v);
  if (n === null) return null;
  const f = 10 ** dp;
  const out = Math.round(n * f) / f;
  return Number.isFinite(out) ? out : null;
};
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const pct = (a, b) => (fin(a) !== null && fin(b) !== null && b !== 0 ? ((a - b) / b) * 100 : null);
const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

/** Contract candles -> finite OHLCV rows, one per IST day (a later row for the same day wins), oldest first. */
export function cleanCandles(list) {
  const byDay = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    const close = fin(c?.close);
    const time = fin(c?.time);
    if (close === null || !(close > 0) || time === null) continue;
    const open = fin(c.open) > 0 ? c.open : close;
    const high = Math.max(fin(c.high) > 0 ? c.high : close, open, close);
    const low = Math.min(fin(c.low) > 0 ? c.low : close, open, close);
    byDay.set(istDay(time * 1000), { time, day: istDay(time * 1000), open, high, low, close, volume: fin(c.volume) ?? 0 });
  }
  return [...byDay.values()].sort((a, b) => a.time - b.time);
}

/**
 * Lay a live quote over daily candles (pure). Same IST day as the last bar: that bar takes the quote's price, high,
 * low and volume. A later day whose previous close matches the last bar's close (0.05 % tolerance): the quote is a new
 * session and becomes a bar. Anything else (a weekend quote that repeats the last close) leaves the candles alone.
 * @returns {{ candles: object[], live: boolean }}
 */
export function overlayQuote(candles, quote, nowMs) {
  const ltp = fin(quote?.ltp);
  if (!candles.length || ltp === null || !(ltp > 0)) return { candles, live: false };
  const today = istDay(nowMs);
  const tail = candles[candles.length - 1];
  const hi = fin(quote.high) > 0 ? quote.high : ltp;
  const lo = fin(quote.low) > 0 ? quote.low : ltp;
  if (tail.day === today) {
    const bar = { ...tail, close: ltp, high: Math.max(tail.high, hi, ltp), low: Math.min(tail.low, lo, ltp), volume: Math.max(tail.volume, fin(quote.volume) ?? 0) };
    return { candles: [...candles.slice(0, -1), bar], live: true };
  }
  const prevClose = fin(quote.close);
  if (tail.day < today && prevClose !== null && Math.abs(prevClose - tail.close) <= tail.close * 0.0005 && (Math.abs(ltp - tail.close) > 1e-9 || (fin(quote.volume) ?? 0) > 0)) {
    const open = fin(quote.open) > 0 ? quote.open : ltp;
    const bar = { time: Math.floor(nowMs / 1000), day: today, open, high: Math.max(hi, open, ltp), low: Math.min(lo, open, ltp), close: ltp, volume: fin(quote.volume) ?? 0 };
    return { candles: [...candles, bar], live: true };
  }
  return { candles, live: false };
}

/** The bar (counting back from the last) at which `a` crossed `b`, within `within` bars: { dir: "up"|"down", barsAgo } | null. */
export function lastCross(a, b, within = 3) {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < within && n - 1 - k >= 1; k += 1) {
    const i = n - 1 - k;
    const [a0, b0, a1, b1] = [a[i - 1], b[i - 1], a[i], b[i]].map(fin);
    if ([a0, b0, a1, b1].some((v) => v === null)) continue;
    if (a0 <= b0 && a1 > b1) return { dir: "up", barsAgo: k };
    if (a0 >= b0 && a1 < b1) return { dir: "down", barsAgo: k };
  }
  return null;
}

const agoText = (k) => (k === 0 ? "today" : k === 1 ? "1 session ago" : `${k} sessions ago`);

/**
 * Every readout for one symbol's daily candles (oldest first, already overlaid with the live quote). Pure.
 * @param {object[]} candles cleanCandles() rows
 */
export function technicalSummary(candles) {
  const n = candles.length;
  if (n < 2) return null;
  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);
  const lastBar = candles[n - 1];
  const prevBar = candles[n - 2];
  const ltp = lastBar.close;

  // Moving averages, and how price sits against each.
  const series = {};
  const ma = {};
  for (const [key, kind, len] of AVERAGES) {
    series[key] = kind === "ema" ? kernel.calcEMA(close, len) : kernel.calcSMA(close, len);
    ma[key] = rnd(last(series[key]));
  }
  const maRows = AVERAGES.map(([key, kind, len]) => ({ key, kind, length: len, value: ma[key], above: ma[key] === null ? null : ltp > ma[key], distancePct: rnd(pct(ltp, ma[key])) }));
  const known = maRows.filter((r) => r.above !== null);
  const aboveCount = known.filter((r) => r.above).length;

  const rsiS = kernel.calcRSI(close, 14);
  const rsi = rnd(last(rsiS));
  const macdS = kernel.calcMACD(close, 12, 26, 9);
  const m = last(macdS) ?? {};
  const macdCross = lastCross(macdS.map((x) => x?.macd ?? null), macdS.map((x) => x?.signal ?? null));
  const adx = last(kernel.calcADX(high, low, close, 14)) ?? {};
  const stoch = last(kernel.calcStochastic(high, low, close, 14, 3)) ?? {};
  const atr = fin(last(kernel.calcATR(high, low, close, 14)));
  const bb = last(kernel.calcBB(close, 20, 2)) ?? {};
  const stS = kernel.calcSuperTrend(high, low, close, 10, 3);
  const st = last(stS) ?? {};
  const stPrev = stS.length > 1 ? stS[stS.length - 2] : null;
  const stDir = (x) => (x?.direction === 1 ? "up" : x?.direction === -1 ? "down" : null);

  // 52-week range over the last 250 sessions, including today.
  const from = Math.max(0, n - RANGE_BARS);
  let hi52 = -Infinity;
  let lo52 = Infinity;
  for (let i = from; i < n; i += 1) {
    hi52 = Math.max(hi52, high[i]);
    lo52 = Math.min(lo52, low[i]);
  }
  const position = hi52 > lo52 ? (ltp - lo52) / (hi52 - lo52) : null;
  // A new 52-week high or low today: today's bar set it, against the bars before.
  let priorHi = -Infinity;
  let priorLo = Infinity;
  for (let i = from; i < n - 1; i += 1) {
    priorHi = Math.max(priorHi, high[i]);
    priorLo = Math.min(priorLo, low[i]);
  }
  const fullYear = n - 1 - from >= 200;

  const pv = kernel.calcPivotPoints(prevBar.high, prevBar.low, prevBar.close);
  const vAvg = (() => {
    const xs = volume.slice(Math.max(0, n - 21), n - 1).filter((v) => v > 0);
    return xs.length >= 5 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  })();
  const volRatio = vAvg && lastBar.volume > 0 ? lastBar.volume / vAvg : null;
  const ret = (k) => (n > k ? rnd(pct(ltp, close[n - 1 - k])) : null);

  // Plain facts, most notable first. tone: "up" | "down" | "info" (colour only).
  const facts = [];
  const add = (id, text, tone = "info") => facts.push({ id, text, tone });
  if (lastBar.high >= hi52 && fullYear && lastBar.high > priorHi) add("high52", "New 52-week high", "up");
  else if (lastBar.low <= lo52 && fullYear && lastBar.low < priorLo) add("low52", "New 52-week low", "down");
  else if (fullYear && hi52 > 0 && (hi52 - ltp) / hi52 <= 0.02) add("near-high52", "Within 2% of the 52-week high", "up");
  else if (fullYear && lo52 > 0 && (ltp - lo52) / lo52 <= 0.02) add("near-low52", "Within 2% of the 52-week low", "down");
  for (const key of ["ema50", "ema200"]) {
    const x = lastCross(close, series[key]);
    if (x) add(`cross-${key}`, `Close crossed ${x.dir === "up" ? "above" : "below"} the ${key.slice(3)}-day EMA ${agoText(x.barsAgo)}`, x.dir);
  }
  const golden = lastCross(series.sma50, series.sma200, 5);
  if (golden) add("cross-50-200", `50-day SMA crossed ${golden.dir === "up" ? "above" : "below"} the 200-day SMA ${agoText(golden.barsAgo)}`, golden.dir);
  if (rsi !== null && rsi >= 70) add("rsi-high", "RSI 14 is above 70", "up");
  if (rsi !== null && rsi <= 30) add("rsi-low", "RSI 14 is below 30", "down");
  if (macdCross) add("macd-cross", `MACD crossed ${macdCross.dir === "up" ? "above" : "below"} its signal line ${agoText(macdCross.barsAgo)}`, macdCross.dir);
  if (stDir(st) && stDir(stPrev) && stDir(st) !== stDir(stPrev)) add("st-flip", `Supertrend turned ${stDir(st)} today`, stDir(st));
  if (volRatio !== null && volRatio >= 2) add("volume", `Volume ${rnd(volRatio, 1)}× its 20-day average`, "info");
  if (fin(bb.upper) !== null && ltp > bb.upper) add("bb-upper", "Close above the upper Bollinger band", "up");
  if (fin(bb.lower) !== null && ltp < bb.lower) add("bb-lower", "Close below the lower Bollinger band", "down");
  if (fin(adx.adx) !== null && adx.adx >= 25) add("adx", `ADX ${rnd(adx.adx, 0)}: a strong directional move by the usual 25 reading`, "info");

  return {
    asOf: lastBar.day,
    bars: n,
    price: { ltp: rnd(ltp), open: rnd(lastBar.open), high: rnd(lastBar.high), low: rnd(lastBar.low), prevClose: rnd(prevBar.close), change: rnd(ltp - prevBar.close), changePct: rnd(pct(ltp, prevBar.close)) },
    averages: maRows,
    trend: { above: aboveCount, of: known.length, state: known.length ? (aboveCount === known.length ? "above-all" : aboveCount === 0 ? "below-all" : "mixed") : null },
    rsi14: rsi,
    macd: { macd: rnd(m.macd, 3), signal: rnd(m.signal, 3), hist: rnd(m.hist, 3), cross: macdCross },
    adx14: { adx: rnd(adx.adx), plusDI: rnd(adx.plusDI), minusDI: rnd(adx.minusDI) },
    stochastic: { k: rnd(stoch.k), d: rnd(stoch.d) },
    atr14: rnd(atr),
    atrPct: rnd(atr === null ? null : (atr / ltp) * 100),
    bollinger: { upper: rnd(bb.upper), mid: rnd(bb.mid), lower: rnd(bb.lower), percentB: rnd(fin(bb.upper) !== null && bb.upper > bb.lower ? (ltp - bb.lower) / (bb.upper - bb.lower) : null, 3), widthPct: rnd(fin(bb.mid) ? ((bb.upper - bb.lower) / bb.mid) * 100 : null) },
    supertrend: { value: rnd(st.value), direction: stDir(st) },
    range52w: { high: rnd(hi52), low: rnd(lo52), fromHighPct: rnd(pct(ltp, hi52)), fromLowPct: rnd(pct(ltp, lo52)), position: rnd(position, 3), sessions: n - from, complete: fullYear },
    pivots: { basis: "Classic floor pivots from the previous session's high, low and close", session: prevBar.day, pp: rnd(pv.pp), r1: rnd(pv.r1), r2: rnd(pv.r2), r3: rnd(pv.r3), s1: rnd(pv.s1), s2: rnd(pv.s2), s3: rnd(pv.s3) },
    volume: { last: lastBar.volume || null, avg20: rnd(vAvg, 0), ratio: rnd(volRatio) },
    returns: { d5: ret(5), d20: ret(20), d60: ret(60), d250: ret(250) },
    facts,
  };
}

/** Run fn over items with at most `limit` in flight; results keep order. */
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

const errEntry = (symbol, err) => ({ symbol, code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? (err.detail ?? err.message) : "The read failed." });

/** The technicals service: a per-IST-day candle cache shared by the route and the MCP tool. */
export function createTechnicals(deps) {
  const clock = extra(deps, "clock");
  const now = () => (clock?.now ? clock.now() : Date.now());
  const md = () => deps.marketData;
  const cache = new Map();
  const inflight = new Map();

  async function candlesFor(symbol, scopeKey, histOpts, stats) {
    const key = `${scopeKey}|${symbol}`;
    const day = istDay(now());
    const hit = cache.get(key);
    if (hit && hit.day === day && (!hit.error || now() - hit.at < FAILED_TTL_MS)) {
      stats.cacheHits += 1;
      if (hit.error) throw hit.error;
      return hit.candles;
    }
    const running = inflight.get(key);
    if (running) {
      stats.shared += 1;
      return running;
    }
    const p = (async () => {
      try {
        stats.historyCalls += 1;
        const h = await md().history({ symbol, interval: "1d", countback: BARS }, { ...histOpts, priority: "background" });
        const candles = cleanCandles(h?.candles);
        if (candles.length < 2) throw new BridgeError("SYMBOL_NOT_FOUND", `Not enough daily candles for ${symbol}.`);
        cache.set(key, { day, at: now(), candles });
        return candles;
      } catch (err) {
        const wrapped = err instanceof BridgeError ? err : new BridgeError("INTERNAL", "The candle read failed.");
        cache.set(key, { day, at: now(), error: wrapped });
        throw wrapped;
      } finally {
        for (const k of [...cache.keys()].slice(0, Math.max(0, cache.size - MAX_CACHE))) cache.delete(k);
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * Readouts for up to MAX_SYMBOLS symbols. `opts` are market read options (accountId, allowedAccounts, allowBackup);
   * the caller's abort signal is not used for the shared candle reads.
   * @returns {Promise<{ items: object[], errors: object[], stats: object }>}
   */
  async function read(symbols, opts = {}) {
    const { signal: _s, maxAgeMs: _m, staleWhileRevalidate: _w, priority: _p, ...base } = opts;
    const scopeKey = JSON.stringify([base.accountId ?? null, base.allowedAccounts ?? null, Boolean(base.allowBackup)]);
    const stats = { quoteCalls: 0, historyCalls: 0, cacheHits: 0, shared: 0 };
    const errors = [];
    const sets = await mapLimit(symbols, CANDLE_CONCURRENCY, async (s) => {
      try {
        return await candlesFor(s, scopeKey, base, stats);
      } catch (err) {
        errors.push(errEntry(s, err));
        return null;
      }
    });
    const quotes = new Map();
    const wanted = symbols.filter((_, i) => sets[i]);
    if (wanted.length) {
      try {
        stats.quoteCalls += 1;
        const r = await md().quotes(wanted, { ...base, priority: opts.priority ?? "interactive" });
        for (const q of r?.items ?? []) quotes.set(q.symbol, q);
        // Quote keys are canonical: match the asked symbol case-insensitively too.
        for (const q of r?.items ?? []) quotes.set(String(q.symbol).toUpperCase(), q);
      } catch {
        /* no live overlay: the readouts use the cached daily candles */
      }
    }
    const items = [];
    symbols.forEach((symbol, i) => {
      if (!sets[i]) return;
      const q = quotes.get(symbol) ?? quotes.get(symbol.toUpperCase()) ?? null;
      const { candles, live } = overlayQuote(sets[i], q, now());
      const summary = technicalSummary(candles);
      if (!summary) return void errors.push({ symbol, code: "SYMBOL_NOT_FOUND", message: `Not enough daily candles for ${symbol}.` });
      items.push({ symbol, live, ...summary });
    });
    return { items, errors, stats };
  }

  return { read, clear: () => cache.clear() };
}

const services = new WeakMap();
/** One service per deps, so the route and the MCP tool share the candle cache. */
export function technicalsFor(deps) {
  let s = services.get(deps);
  if (!s) services.set(deps, (s = createTechnicals(deps)));
  return s;
}

/** Comma-separated symbols, trimmed, de-duplicated, 1 to MAX_SYMBOLS. */
export function parseTechnicalSymbols(raw) {
  const list = [...new Set(String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!list.length) throw invalid("symbols", "symbols is required: a comma-separated list such as NSE:RELIANCE,NSE:TCS.");
  if (list.length > MAX_SYMBOLS) throw invalid("symbols", `Ask for at most ${MAX_SYMBOLS} symbols at a time.`);
  if (list.some((s) => s.length > 64)) throw invalid("symbols", "Each symbol is at most 64 characters.");
  return list;
}

/** @returns {Array<[string, string, object, (ctx: any) => Promise<object>]>} */
export function technicalsRoutes(deps) {
  const svc = technicalsFor(deps);
  async function technicals(ctx) {
    const symbols = parseTechnicalSymbols(ctx.query.get("symbols"));
    const opts = readOptionsBase(ctx, { maxAge: false, autoBackup: autoBackupFor(deps) });
    try {
      const r = await svc.read(symbols, opts);
      if (!r.items.length && r.errors.length) {
        const e = r.errors[0];
        throw new BridgeError(e.code, e.message);
      }
      return {
        data: { items: r.items, basis: "Daily candles from your broker through the Bridge, the last session following the live quote. Indicators from the ChartistScript kernel." },
        errors: r.errors,
        meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, cost: r.stats },
      };
    } catch (err) {
      if (err instanceof BridgeError || err?.name === "AbortError") throw err;
      throw new BridgeError("INTERNAL", "The technical readouts could not be computed.");
    }
  }
  return [["GET", "/v1/analytics/technicals", { scope: "read" }, technicals]];
}
