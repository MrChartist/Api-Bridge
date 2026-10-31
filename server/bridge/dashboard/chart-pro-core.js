// chart-pro-core.js: the pure half of the chart tools (chart-pro.js draws them). Intervals and quick ranges, the
// viewport (zoom and pan), price scales (linear, log, percent), chart types (Heikin Ashi, Renko, bars, line, area),
// the studies that run in the browser on any interval (moving averages, VWAP, CPR and pivots, Supertrend, opening
// range, Bollinger, RSI, MACD, ATR, stochastic, volume), drawing geometry (Fibonacci, channel, position R:R, measure)
// and hit-testing. No DOM, no fetch, no clock: everything comes in as arguments (chart-pro-core.test.mjs).
//
// Candles here are { t (epoch ms), open, high, low, close, volume } sorted by t, as chart-specs.js candlesOf gives.

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** Minutes in an NSE cash session (09:15 to 15:30). */
export const SESSION_MIN = 375;
const fin = (v) => typeof v === "number" && Number.isFinite(v);

// ── Intervals and quick ranges ──

/** Intervals the Bridge's /v1/history serves, finest first. `min`: minutes per bar (a session for daily and up). */
export const INTERVALS = Object.freeze([
  { id: "1m", label: "1m", name: "1 minute", min: 1 },
  { id: "3m", label: "3m", name: "3 minutes", min: 3 },
  { id: "5m", label: "5m", name: "5 minutes", min: 5 },
  { id: "10m", label: "10m", name: "10 minutes", min: 10 },
  { id: "15m", label: "15m", name: "15 minutes", min: 15 },
  { id: "30m", label: "30m", name: "30 minutes", min: 30 },
  { id: "60m", label: "1h", name: "1 hour", min: 60 },
  { id: "1d", label: "1D", name: "1 day", min: SESSION_MIN, daily: true },
  { id: "1w", label: "1W", name: "1 week", min: SESSION_MIN * 5, daily: true },
  { id: "1M", label: "1M", name: "1 month", min: SESSION_MIN * 21, daily: true },
]);
const IV = new Map(INTERVALS.map((x) => [x.id, x]));
export const intervalInfo = (id) => IV.get(id) ?? null;
export const isDailyInterval = (id) => Boolean(IV.get(id)?.daily);

/**
 * Quick ranges: the interval each one reads and how many sessions (or calendar months) it shows. The finest interval
 * that keeps the bar count readable; 5Y reads weekly candles.
 */
export const RANGES = Object.freeze([
  { id: "1D", interval: "1m", sessions: 1, name: "1 day" },
  { id: "5D", interval: "5m", sessions: 5, name: "5 days" },
  { id: "1M", interval: "30m", months: 1, name: "1 month" },
  { id: "3M", interval: "60m", months: 3, name: "3 months" },
  { id: "6M", interval: "1d", months: 6, name: "6 months" },
  { id: "1Y", interval: "1d", months: 12, name: "1 year" },
  { id: "5Y", interval: "1w", months: 60, name: "5 years" },
]);
export const rangeInfo = (id) => RANGES.find((r) => r.id === id) ?? null;

/** Bars in one session of an interval (one for daily and coarser). */
export function barsPerSession(interval) {
  const x = IV.get(interval);
  if (!x) return 1;
  return x.daily ? 1 : Math.ceil(SESSION_MIN / x.min);
}

/** Extra bars fetched before a range so studies are warmed up when the range starts. */
export const WARM_BARS = 200;

/**
 * The /v1/history request for an interval or a quick range: { interval, countback }. A range asks for its own span
 * plus WARM_BARS; a bare interval asks for about 600 bars. Never more than the history service's 5000.
 */
export function historyParams({ interval = null, range = null } = {}) {
  const r = range ? rangeInfo(range) : null;
  const iv = r ? r.interval : IV.has(interval) ? interval : "5m";
  const x = IV.get(iv);
  let bars = 600;
  if (r) {
    const sessions = r.sessions ?? Math.ceil((r.months ?? 1) * 21.5);
    bars = x.id === "1w" ? Math.ceil(sessions / 5) + 4 : x.id === "1M" ? Math.ceil(sessions / 21) + 2 : sessions * barsPerSession(iv);
    bars += WARM_BARS;
  }
  return { interval: iv, countback: Math.max(10, Math.min(5000, Math.round(bars))) };
}

const istDay = (t) => Math.floor((t + IST_MS) / DAY_MS);

/**
 * The first index a quick range shows: the start of the n-th last session for day ranges, the bar on or after the
 * same calendar day `months` earlier for month ranges. 0 when the data is shorter than the range.
 */
export function rangeStart(times, range) {
  const r = rangeInfo(range);
  const n = times?.length ?? 0;
  if (!r || n < 2) return 0;
  if (r.sessions) {
    let seen = 1;
    let d = istDay(times[n - 1]);
    for (let i = n - 2; i >= 0; i--) {
      const di = istDay(times[i]);
      if (di !== d) {
        if (seen === r.sessions) return i + 1;
        seen++;
        d = di;
      }
    }
    return 0;
  }
  const last = new Date(times[n - 1] + IST_MS);
  const from = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - r.months, last.getUTCDate()) - IST_MS;
  for (let i = 0; i < n; i++) if (times[i] >= from) return i;
  return 0;
}

/** The bar spacing of a list of times in minutes (median gap), for the interval picker's default. */
export function medianGapMin(times) {
  if (!times || times.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] / 60_000;
}

/** The interval id a list of candle times was drawn at (closest INTERVALS entry), else null. */
export function guessInterval(times) {
  const m = medianGapMin(times);
  if (m === null) return null;
  if (m >= 20 * 24 * 60) return "1M";
  if (m >= 4 * 24 * 60) return "1w";
  if (m >= 20 * 60) return "1d";
  let best = null;
  for (const x of INTERVALS) if (!x.daily && (!best || Math.abs(x.min - m) < Math.abs(best.min - m))) best = x;
  return best?.id ?? null;
}

// ── Viewport: which slots of the time axis are on screen ──
// A view is { from, to } in bar indices (fractions allowed, so a drag pans smoothly). It may run past the last bar
// (empty room on the right for drawings) and before the first, by up to half its span.

/** The view a chart opens with: the last `maxBars` bars, or all of them. */
export function initialView(count, maxBars = 160, from = null) {
  if (count < 1) return { from: 0, to: 0 };
  const start = from !== null ? Math.max(0, Math.min(count - 1, from)) : Math.max(0, count - maxBars);
  return { from: start, to: count - 1 };
}

/** Keep a view sane: at least `minBars` wide, at most every bar plus half a screen either side. */
export function clampView(v, count, { minBars = 8 } = {}) {
  if (count < 1) return { from: 0, to: 0 };
  let span = Math.max(Math.min(minBars, count) - 1, v.to - v.from);
  span = Math.min(span, Math.max(1, (count - 1) * 2));
  const pad = Math.max(1, span * 0.5);
  let from = v.from;
  from = Math.max(-pad, Math.min(count - 1 + pad - span, from));
  return { from, to: from + span };
}

/** Zoom by `factor` (> 1 zooms out) keeping bar index `anchor` where it is on screen. */
export function zoomView(v, factor, anchor, count, opts) {
  const span = v.to - v.from;
  const a = fin(anchor) ? anchor : v.to;
  const k = span > 0 ? (a - v.from) / span : 1;
  const next = Math.max(1, span * factor);
  return clampView({ from: a - k * next, to: a - k * next + next }, count, opts);
}

/** Pan by `bars` (positive moves later in time). */
export const panView = (v, bars, count, opts) => clampView({ from: v.from + bars, to: v.to + bars }, count, opts);

/** The whole bars inside a view: [first, last], clamped to the data. */
export function visibleRange(v, count) {
  return [Math.max(0, Math.ceil(v.from - 0.5)), Math.min(count - 1, Math.floor(v.to + 0.5))];
}

// ── Time ↔ bar index (drawings are stored by time so they survive a change of interval) ──

/** The fractional bar index of time `t`: exact on a bar, interpolated between bars, extrapolated past either end. */
export function indexOfTime(times, t) {
  const n = times?.length ?? 0;
  if (!n || !fin(t)) return NaN;
  if (n === 1) return 0;
  const step = (times[n - 1] - times[0]) / (n - 1) || 1;
  if (t <= times[0]) return (t - times[0]) / (times[1] - times[0] || step);
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / (times[n - 1] - times[n - 2] || step);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - times[lo]) / (times[hi] - times[lo] || 1);
}

/** The time of a fractional bar index (inverse of indexOfTime). */
export function timeOfIndex(times, i) {
  const n = times?.length ?? 0;
  if (!n || !fin(i)) return NaN;
  if (n === 1) return times[0];
  if (i <= 0) return times[0] + i * (times[1] - times[0]);
  if (i >= n - 1) return times[n - 1] + (i - (n - 1)) * (times[n - 1] - times[n - 2]);
  const a = Math.floor(i);
  return times[a] + (i - a) * (times[a + 1] - times[a]);
}

/** The index of the bar nearest time t (for crosshair sync between charts), or -1 when t is outside the data. */
export function nearestIndex(times, t) {
  const n = times?.length ?? 0;
  if (!n || !fin(t)) return -1;
  const gap = n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 0;
  if (t < times[0] - gap || t > times[n - 1] + gap) return -1;
  const f = indexOfTime(times, t);
  return Math.max(0, Math.min(n - 1, Math.round(f)));
}

// ── Price scales ──

/**
 * A price scale over [lo, hi] mapped to [top, bottom]: { yOf, vOf, ticks, mode }. "log" spaces prices by ratio,
 * "percent" labels the axis as change from `base` (the first close on screen) and its ticks fall on round percents.
 */
export function priceScale(mode, lo, hi, top, bottom, base = null, tickCount = 5) {
  const h = bottom - top;
  if (mode === "log" && lo > 0 && hi > lo) {
    const a = Math.log(lo);
    const b = Math.log(hi);
    return {
      mode,
      yOf: (v) => (v > 0 ? top + (1 - (Math.log(v) - a) / (b - a)) * h : NaN),
      vOf: (y) => Math.exp(a + (1 - (y - top) / h) * (b - a)),
      ticks: logTicks(lo, hi, tickCount),
    };
  }
  const yOf = (v) => top + (1 - (v - lo) / (hi - lo)) * h;
  const vOf = (y) => lo + (1 - (y - top) / h) * (hi - lo);
  if (mode === "percent" && fin(base) && base > 0) {
    const pct = niceStep((hi - lo) / base * 100, tickCount);
    const ticks = [];
    const p0 = Math.ceil(((lo / base - 1) * 100) / pct - 1e-9) * pct;
    for (let p = p0; base * (1 + p / 100) <= hi + 1e-9 && ticks.length < 40; p += pct) ticks.push(base * (1 + Math.round(p / pct) * pct / 100));
    return { mode, yOf, vOf, ticks, base, pctStep: pct };
  }
  return { mode: "linear", yOf, vOf, ticks: null };
}

/** A round step (1, 2, 2.5, 5 × 10ⁿ) that splits `span` into about `count` parts. */
export function niceStep(span, count = 5) {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).reduce((best, s) => (Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw)) ? s : best));
}

/** Ticks for a log scale: round prices spread by ratio (each a nice number near a geometric step). */
export function logTicks(lo, hi, count = 5) {
  if (!(lo > 0 && hi > lo)) return [];
  const out = [];
  const r = (hi / lo) ** (1 / Math.max(1, count));
  for (let v = lo * Math.sqrt(r), k = 0; v < hi && k < 20; v *= r, k++) {
    const p = 10 ** Math.floor(Math.log10(v));
    const m = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10].reduce((b, x) => (Math.abs(x * p - v) < Math.abs(b * p - v) ? x : b));
    const t = Math.round(m * p * 1e6) / 1e6;
    if (t > lo && t < hi && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Percent change of v from base (axis labels in percent mode). */
export const pctFrom = (v, base) => (fin(v) && fin(base) && base !== 0 ? (v / base - 1) * 100 : NaN);

// ── Chart types ──

export const CHART_TYPES = Object.freeze([
  { id: "candles", name: "Candles" },
  { id: "hollow", name: "Hollow candles" },
  { id: "ha", name: "Heikin Ashi" },
  { id: "bars", name: "Bars" },
  { id: "line", name: "Line" },
  { id: "area", name: "Area" },
  { id: "renko", name: "Renko" },
]);

/** Heikin Ashi candles: close = OHLC average, open = mid of the last HA body, extremes include both. */
export function heikinAshi(candles) {
  const out = new Array(candles.length);
  let po = NaN;
  let pc = NaN;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (po + pc) / 2;
    out[i] = { ...c, open, close, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close) };
    po = open;
    pc = close;
  }
  return out;
}

/** A Renko box size from the data: ATR(14) of the last bars rounded to a nice step, at least one tick. */
export function renkoBox(candles) {
  const a = atr(candles, 14);
  let v = NaN;
  for (let i = a.length - 1; i >= 0 && !fin(v); i--) v = a[i];
  if (!fin(v) || v <= 0) return null;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = [1, 2, 2.5, 5, 10].reduce((b, x) => (Math.abs(x * p - v) < Math.abs(b * p - v) ? x : b));
  return Math.max(0.05, Math.round(m * p * 100) / 100);
}

/**
 * Renko bricks from closes: a brick per `box` moved, a reversal needs two boxes. Each brick takes the time of the
 * candle that completed it (bricks completed together are a millisecond apart so the axis keeps them in order).
 */
export function renko(candles, box) {
  if (!(box > 0) || !candles.length) return [];
  const out = [];
  let base = Math.floor(candles[0].close / box) * box;
  let dir = 0;
  for (const c of candles) {
    let k = 0;
    for (;;) {
      if (c.close >= base + box * (dir >= 0 ? 1 : 2)) {
        const open = dir >= 0 ? base : base + box;
        base = open + box;
        out.push({ t: c.t + k++, open, close: base, high: base, low: open, volume: 0 });
        dir = 1;
      } else if (c.close <= base - box * (dir <= 0 ? 1 : 2)) {
        const open = dir <= 0 ? base : base - box;
        base = open - box;
        out.push({ t: c.t + k++, open, close: base, high: open, low: base, volume: 0 });
        dir = -1;
      } else break;
      if (k > 500) break;
    }
  }
  return out;
}

/**
 * The candles of a spec drawn as a chart type: { data, style, line } where style is "candles" | "hollow" | "ohlc",
 * and `line` ("line" | "area") means draw the closes as one series instead.
 */
export function typedCandles(candles, type, { box = null } = {}) {
  switch (type) {
    case "ha":
      return { data: heikinAshi(candles), style: "candles" };
    case "hollow":
      return { data: candles, style: "hollow" };
    case "bars":
      return { data: candles, style: "ohlc" };
    case "line":
    case "area":
      return { data: candles, style: "candles", line: type };
    case "renko": {
      const b = box ?? renkoBox(candles);
      return b ? { data: renko(candles, b), style: "candles", box: b } : { data: candles, style: "candles" };
    }
    default:
      return { data: candles, style: "candles" };
  }
}

// ── Studies that run in the browser (any interval) ──

/** A source series of the candles: close, open, high, low, hl2, hlc3, ohlc4. */
export function source(candles, src = "close") {
  const n = candles.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    out[i] = src === "open" ? c.open : src === "high" ? c.high : src === "low" ? c.low : src === "hl2" ? (c.high + c.low) / 2 : src === "hlc3" ? (c.high + c.low + c.close) / 3 : src === "ohlc4" ? (c.open + c.high + c.low + c.close) / 4 : c.close;
  }
  return out;
}

export function sma(x, len) {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    k++;
    if (k > len) {
      s -= x[i - len];
      k = len;
    }
    if (k === len) out[i] = s / len;
  }
  return out;
}

/** EMA seeded with the SMA of its first `len` values; NaN inputs before the seed are skipped. */
export function ema(x, len, alpha = 2 / (len + 1)) {
  const out = new Array(x.length).fill(NaN);
  let prev = NaN;
  let seed = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!fin(v)) continue;
    if (!fin(prev)) {
      seed += v;
      k++;
      if (k === len) prev = seed / len;
      else continue;
    } else prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}
/** Wilder's smoothing (RMA): EMA with alpha 1/len. */
export const rma = (x, len) => ema(x, len, 1 / len);

export function wma(x, len) {
  const out = new Array(x.length).fill(NaN);
  const den = (len * (len + 1)) / 2;
  for (let i = len - 1; i < x.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = 0; j < len; j++) {
      const v = x[i - j];
      if (!fin(v)) {
        ok = false;
        break;
      }
      s += v * (len - j);
    }
    if (ok) out[i] = s / den;
  }
  return out;
}

export function hma(x, len) {
  const a = wma(x, Math.max(1, Math.round(len / 2)));
  const b = wma(x, len);
  return wma(a.map((v, i) => 2 * v - b[i]), Math.max(1, Math.round(Math.sqrt(len))));
}
export function dema(x, len) {
  const e1 = ema(x, len);
  const e2 = ema(e1, len);
  return e1.map((v, i) => 2 * v - e2[i]);
}
export function tema(x, len) {
  const e1 = ema(x, len);
  const e2 = ema(e1, len);
  const e3 = ema(e2, len);
  return e1.map((v, i) => 3 * v - 3 * e2[i] + e3[i]);
}
export function vwma(candles, len, src = "close") {
  const x = source(candles, src);
  const out = new Array(x.length).fill(NaN);
  for (let i = len - 1; i < x.length; i++) {
    let pv = 0;
    let v = 0;
    for (let j = 0; j < len; j++) {
      pv += x[i - j] * (candles[i - j].volume || 0);
      v += candles[i - j].volume || 0;
    }
    if (v > 0) out[i] = pv / v;
  }
  return out;
}

export function stdev(x, len) {
  const m = sma(x, len);
  return m.map((mu, i) => {
    if (!fin(mu)) return NaN;
    let s = 0;
    for (let j = 0; j < len; j++) s += (x[i - j] - mu) ** 2;
    return Math.sqrt(s / len);
  });
}

export function trueRange(candles) {
  return candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
}
export const atr = (candles, len) => rma(trueRange(candles), len);

/** RSI (Wilder). */
export function rsi(x, len) {
  const up = new Array(x.length).fill(NaN);
  const dn = new Array(x.length).fill(NaN);
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    up[i] = Math.max(0, d);
    dn[i] = Math.max(0, -d);
  }
  const au = rma(up, len);
  const ad = rma(dn, len);
  return au.map((u, i) => (!fin(u) || !fin(ad[i]) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
}

export function macd(x, fast = 12, slow = 26, signal = 9) {
  const f = ema(x, fast);
  const s = ema(x, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

export function bollinger(x, len = 20, mult = 2) {
  const basis = sma(x, len);
  const sd = stdev(x, len);
  return { basis, upper: basis.map((b, i) => b + mult * sd[i]), lower: basis.map((b, i) => b - mult * sd[i]) };
}

export function stochastic(candles, k = 14, d = 3, smooth = 3) {
  const raw = candles.map((c, i) => {
    if (i < k - 1) return NaN;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = 0; j < k; j++) {
      hi = Math.max(hi, candles[i - j].high);
      lo = Math.min(lo, candles[i - j].low);
    }
    return hi > lo ? ((c.close - lo) / (hi - lo)) * 100 : 50;
  });
  const kk = sma(raw.map((v) => (fin(v) ? v : 0)), smooth).map((v, i) => (i < k + smooth - 2 ? NaN : v));
  const dd = sma(kk.map((v) => (fin(v) ? v : 0)), d).map((v, i) => (i < k + smooth + d - 3 ? NaN : v));
  return { k: kk, d: dd };
}

/**
 * Supertrend: ATR bands around hl2 that ratchet with the trend; `dir` is +1 (up, the line under price) or −1.
 * Returns { line, dir }.
 */
export function supertrend(candles, len = 10, mult = 3) {
  const a = atr(candles, len);
  const n = candles.length;
  const line = new Array(n).fill(NaN);
  const dir = new Array(n).fill(0);
  let upper = NaN;
  let lower = NaN;
  let d = 1;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!fin(a[i])) continue;
    const mid = (c.high + c.low) / 2;
    const bu = mid + mult * a[i];
    const bl = mid - mult * a[i];
    const pc = i > 0 ? candles[i - 1].close : c.close;
    upper = !fin(upper) || bu < upper || pc > upper ? bu : upper;
    lower = !fin(lower) || bl > lower || pc < lower ? bl : lower;
    if (d === 1 && c.close < lower) d = -1;
    else if (d === -1 && c.close > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

/** Session VWAP (resets each IST day; the running Σ price × volume ÷ Σ volume of hlc3). NaN while no volume. */
export function sessionVwap(candles, src = "hlc3") {
  const x = source(candles, src);
  const out = new Array(candles.length).fill(NaN);
  let day = null;
  let pv = 0;
  let v = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = istDay(candles[i].t);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
    }
    const vol = candles[i].volume || 0;
    pv += x[i] * vol;
    v += vol;
    if (v > 0) out[i] = pv / v;
  }
  return out;
}

/** Floor pivots and CPR from one session's high, low and close. */
export function pivotLevels(high, low, close) {
  const p = (high + low + close) / 3;
  const bc = (high + low) / 2;
  const tc = 2 * p - bc;
  return { p, tc: Math.max(tc, bc), bc: Math.min(tc, bc), r1: 2 * p - low, s1: 2 * p - high, r2: p + (high - low), s2: p - (high - low), r3: high + 2 * (p - low), s3: low - 2 * (high - p) };
}

/** Session summaries of intraday candles: [{ day, first, last, high, low, close }] (indices into candles). */
export function sessions(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = istDay(c.t);
    const s = out[out.length - 1];
    if (!s || s.day !== d) out.push({ day: d, first: i, last: i, high: c.high, low: c.low, open: c.open, close: c.close });
    else {
      s.last = i;
      s.high = Math.max(s.high, c.high);
      s.low = Math.min(s.low, c.low);
      s.close = c.close;
    }
  }
  return out;
}

/**
 * CPR and pivots per bar. Intraday: each session reads the previous session's high, low and close (the first session
 * on the chart has none). Daily and coarser: each bar reads the bar before it. `gap` marks where a new level starts so
 * the lines break between sessions instead of joining with a slope.
 */
export function cprSeries(candles, { daily = false } = {}) {
  const keys = ["p", "tc", "bc", "r1", "s1", "r2", "s2", "r3", "s3"];
  const out = Object.fromEntries(keys.map((k) => [k, new Array(candles.length).fill(NaN)]));
  const gap = new Array(candles.length).fill(false);
  if (daily) {
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i - 1];
      const L = pivotLevels(c.high, c.low, c.close);
      for (const k of keys) out[k][i] = L[k];
      gap[i] = true;
    }
    return { ...out, gap };
  }
  const ss = sessions(candles);
  for (let s = 1; s < ss.length; s++) {
    const L = pivotLevels(ss[s - 1].high, ss[s - 1].low, ss[s - 1].close);
    for (let i = ss[s].first; i <= ss[s].last; i++) for (const k of keys) out[k][i] = L[k];
    gap[ss[s].first] = true;
  }
  return { ...out, gap };
}

/** The CPR of the next session from a daily chart's last completed bar (`lastDone`: its index). */
export function nextCpr(candles, lastDone = candles.length - 1) {
  const c = candles[lastDone];
  return c ? pivotLevels(c.high, c.low, c.close) : null;
}

/**
 * Opening range: the high and low of each session's first `minutes`, drawn from the end of that window to the
 * session's close. Bars inside the window have no value. Intraday only.
 */
export function openingRange(candles, minutes = 15, barMin = 5) {
  const hi = new Array(candles.length).fill(NaN);
  const lo = new Array(candles.length).fill(NaN);
  const gap = new Array(candles.length).fill(false);
  for (const s of sessions(candles)) {
    const start = candles[s.first].t;
    const end = start + minutes * 60_000;
    let h = -Infinity;
    let l = Infinity;
    let i = s.first;
    for (; i <= s.last && candles[i].t + barMin * 60_000 <= end; i++) {
      h = Math.max(h, candles[i].high);
      l = Math.min(l, candles[i].low);
    }
    if (i === s.first || !Number.isFinite(h)) continue;
    for (let j = i; j <= s.last; j++) {
      hi[j] = h;
      lo[j] = l;
    }
    if (i <= s.last) gap[i] = true;
  }
  return { high: hi, low: lo, gap };
}

/** Moving-average studies share one shape: id → function(source series, length, candles). */
const MA = {
  sma: (x, n) => sma(x, n),
  ema: (x, n) => ema(x, n),
  wma: (x, n) => wma(x, n),
  hma: (x, n) => hma(x, n),
  dema: (x, n) => dema(x, n),
  tema: (x, n) => tema(x, n),
  rma: (x, n) => rma(x, n),
};
const MA_NAMES = { sma: "Simple moving average", ema: "Exponential moving average", wma: "Weighted moving average", hma: "Hull moving average", dema: "Double EMA", tema: "Triple EMA", rma: "Smoothed moving average (RMA)", vwma: "Volume-weighted moving average" };

const len = (d, min = 1, max = 500, name = "length") => ({ name, type: "int", min, max, default: d });
const num = (d, min, max, name) => ({ name, type: "number", min, max, default: d });
const src = { name: "src", type: "source", values: ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"], default: "close" };

/**
 * The studies drawn in the browser. `pane`: "price" (over the candles) or "panel" (a pane of its own). `needs`:
 * "intraday" when a study only means something within sessions, "volume" when it needs volume.
 */
export const LOCAL_STUDIES = Object.freeze([
  ...Object.keys(MA).map((id) => ({ id, name: MA_NAMES[id], cat: "Moving averages", pane: "price", params: [len(id === "sma" || id === "ema" ? 20 : 21), src] })),
  { id: "vwma", name: MA_NAMES.vwma, cat: "Moving averages", pane: "price", needs: "volume", params: [len(20), src] },
  { id: "vwap", name: "VWAP, session", cat: "Levels and VWAP", pane: "price", needs: "volume", params: [{ ...src, default: "hlc3" }] },
  { id: "cpr", name: "CPR and floor pivots", cat: "Levels and VWAP", pane: "price", params: [{ name: "pivots", type: "choice", values: ["CPR only", "CPR and R1-S1", "CPR and R1-S3"], default: "CPR and R1-S1" }] },
  { id: "orb", name: "Opening range", cat: "Levels and VWAP", pane: "price", needs: "intraday", params: [len(15, 1, 180, "minutes")] },
  { id: "supertrend", name: "Supertrend", cat: "Trend", pane: "price", params: [len(10, 1, 200), num(3, 0.5, 10, "multiplier")] },
  { id: "bb", name: "Bollinger Bands", cat: "Volatility", pane: "price", params: [len(20, 2, 500), num(2, 0.5, 5, "multiplier"), src] },
  { id: "atr", name: "Average true range", cat: "Volatility", pane: "panel", params: [len(14, 1, 200)] },
  { id: "rsi", name: "Relative strength index", cat: "Momentum", pane: "panel", params: [len(14, 2, 200), src] },
  { id: "macd", name: "MACD", cat: "Momentum", pane: "panel", params: [len(12, 1, 200, "fast"), len(26, 1, 400, "slow"), len(9, 1, 100, "signal"), src] },
  { id: "stoch", name: "Stochastic", cat: "Momentum", pane: "panel", params: [len(14, 1, 200, "k"), len(3, 1, 50, "d"), len(3, 1, 50, "smooth")] },
  { id: "volume", name: "Volume", cat: "Volume", pane: "panel", needs: "volume", params: [len(20, 1, 200, "average")] },
]);
const LOCAL = new Map(LOCAL_STUDIES.map((s) => [s.id, s]));
export const localStudy = (id) => LOCAL.get(id) ?? null;

/** Categories for the Bridge's own (daily) studies, by id; anything not listed goes under "More". */
const BRIDGE_CATS = {
  "Moving averages": "alma dema ema hma kama lsma mcginley rma sma tema vwma wma",
  Trend: "adx aroon aroonosc ichimoku sar supertrend vortex zigzag linregchannel dpo pivothl",
  Momentum: "ao bop cci cmo coppock crsi elderray ewo fisher kdj kst macd momentum ppo roc rsi rvi smi stoch stochrsi trix tsi uo williamsr",
  Volatility: "adr adrpercent atr bb bbw chop donchian envelope historicalvol keltner massindex percentb stddev ulcer",
  Volume: "adline chaikinosc cmf eom forceindex klinger mfi netvolume nvi obv pvi pvt rvol volumema vroc",
  "Levels and VWAP": "avwap sessionvwap vwap vwapbands",
};
const CAT_OF = new Map(Object.entries(BRIDGE_CATS).flatMap(([c, ids]) => ids.split(" ").map((id) => [id, c])));
export const studyCategory = (id) => LOCAL.get(id)?.cat ?? CAT_OF.get(id) ?? "More";
/** Category order in the library. */
export const STUDY_CATEGORIES = Object.freeze(["Moving averages", "Levels and VWAP", "Trend", "Momentum", "Volatility", "Volume", "More"]);

/** A study's settings with defaults filled and values checked against their ranges. */
export function studyParams(defs, given = {}) {
  const out = {};
  for (const p of defs ?? []) {
    const v = given?.[p.name];
    if (p.type === "int" || p.type === "number") {
      const x = Number(v);
      out[p.name] = fin(x) && (p.min === undefined || x >= p.min) && (p.max === undefined || x <= p.max) ? (p.type === "int" ? Math.round(x) : x) : p.default;
    } else if (p.type === "choice" || p.type === "source") out[p.name] = (p.values ?? []).includes(v) ? v : p.default;
    else out[p.name] = v ?? p.default;
  }
  return out;
}

/** "ema 20", "bb 20 2", "macd 12 26 9": a study's short name with its settings. */
export function studyTitle(id, params, defs) {
  const vals = (defs ?? []).filter((p) => p.type === "int" || p.type === "number").map((p) => params?.[p.name]).filter((v) => v !== undefined);
  return [id.toUpperCase(), ...vals.map(String)].join(" ");
}

/**
 * Run a browser study over candles. Returns { outputs: [{ key, label, pane: "price"|"panel", kind: "line"|"bars"|
 * "band", values, tone?, tones?, gap?, lo?, hi?, levels? }], note? }. `daily` says the candles are one per session.
 */
export function runLocalStudy(id, candles, params = {}, { daily = false } = {}) {
  const def = LOCAL.get(id);
  if (!def || !candles.length) return { outputs: [] };
  const p = studyParams(def.params, params);
  const hasVol = candles.some((c) => c.volume > 0);
  if (def.needs === "volume" && !hasVol) return { outputs: [], note: "No volume for this symbol" };
  if (def.needs === "intraday" && daily) return { outputs: [], note: "Intraday intervals only" };
  const x = p.src ? source(candles, p.src) : null;
  const line = (key, label, values, extra = {}) => ({ key, label, pane: def.pane, kind: "line", values, ...extra });
  if (MA[id]) return { outputs: [line("value", studyTitle(id, p, def.params), MA[id](x, p.length))] };
  switch (id) {
    case "vwma":
      return { outputs: [line("value", studyTitle(id, p, def.params), vwma(candles, p.length, p.src))] };
    case "vwap":
      return { outputs: [line("value", "VWAP", sessionVwap(candles, p.src))], ...(daily ? { note: "Daily candles: each bar is its own session" } : {}) };
    case "cpr": {
      const c = cprSeries(candles, { daily });
      const tiers = p.pivots === "CPR only" ? 0 : p.pivots === "CPR and R1-S1" ? 1 : 3;
      const out = [line("tc", "TC", c.tc, { gap: c.gap, tone: "iv" }), line("p", "Pivot", c.p, { gap: c.gap, tone: "iv" }), line("bc", "BC", c.bc, { gap: c.gap, tone: "iv" })];
      for (let k = 1; k <= tiers; k++) out.push(line(`r${k}`, `R${k}`, c[`r${k}`], { gap: c.gap, tone: "neg", dash: true }), line(`s${k}`, `S${k}`, c[`s${k}`], { gap: c.gap, tone: "pos", dash: true }));
      return { outputs: out };
    }
    case "orb": {
      const barMin = Math.max(1, Math.round(medianGapMin(candles.map((c) => c.t)) ?? 5));
      const o = openingRange(candles, p.minutes, barMin);
      return { outputs: [line("high", "OR high", o.high, { gap: o.gap, tone: "pos" }), line("low", "OR low", o.low, { gap: o.gap, tone: "neg" })] };
    }
    case "supertrend": {
      const s = supertrend(candles, p.length, p.multiplier);
      // Two lines so the direction colours hold: green while the trend is up, red while it is down.
      const up = s.line.map((v, i) => (s.dir[i] === 1 ? v : NaN));
      const dn = s.line.map((v, i) => (s.dir[i] === -1 ? v : NaN));
      const gap = s.dir.map((d, i) => i > 0 && d !== s.dir[i - 1]);
      return { outputs: [line("up", "Supertrend up", up, { tone: "pos", gap }), line("down", "Supertrend down", dn, { tone: "neg", gap })], value: s.line };
    }
    case "bb": {
      const b = bollinger(x, p.length, p.multiplier);
      return { outputs: [{ key: "band", label: "BB band", pane: "price", kind: "band", lo: b.lower, hi: b.upper }, line("upper", "Upper", b.upper), line("basis", "Basis", b.basis), line("lower", "Lower", b.lower)] };
    }
    case "atr":
      return { outputs: [line("value", studyTitle(id, p, def.params), atr(candles, p.length))] };
    case "rsi":
      return { outputs: [line("value", studyTitle(id, p, def.params), rsi(x, p.length))], levels: [70, 30], include: [0, 100] };
    case "macd": {
      const m = macd(x, p.fast, p.slow, p.signal);
      return { outputs: [{ key: "hist", label: "Histogram", pane: "panel", kind: "bars", values: m.hist, signed: true }, line("macd", "MACD", m.macd), line("signal", "Signal", m.signal)], levels: [0] };
    }
    case "stoch": {
      const s = stochastic(candles, p.k, p.d, p.smooth);
      return { outputs: [line("k", "%K", s.k), line("d", "%D", s.d)], levels: [80, 20], include: [0, 100] };
    }
    case "volume": {
      const v = candles.map((c) => c.volume || 0);
      return {
        outputs: [
          { key: "vol", label: "Volume", pane: "panel", kind: "bars", values: v, tones: candles.map((c) => (c.close >= c.open ? "pos" : "neg")) },
          line("avg", `Average ${p.average}`, sma(v, p.average)),
        ],
        include: [0],
      };
    }
    default:
      return { outputs: [] };
  }
}

// ── Drawings: geometry and hit-testing ──

/** Fibonacci retracement ratios drawn by default. */
export const FIB_RATIOS = Object.freeze([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);

/** Levels of a retracement from price a (start) to b (end): ratio r sits at b − (b − a) × r. */
export const fibLevels = (a, b, ratios = FIB_RATIOS) => ratios.map((r) => ({ r, price: b - (b - a) * r }));

/** The price on the line through (x1, p1) and (x2, p2) at x (any units). */
export const lineAt = (x1, p1, x2, p2, x) => (x2 === x1 ? p2 : p1 + ((p2 - p1) * (x - x1)) / (x2 - x1));

/** A parallel channel: the base line a→b and its copy shifted so it passes through c. Returns the offset in price. */
export const channelOffset = (a, b, c) => c.p - lineAt(a.i, a.p, b.i, b.p, c.i);

/**
 * A long or short position: risk and reward in points, the reward-to-risk ratio and the P&L at target and stop for
 * `qty` units. A long wins above entry; a short wins below. `valid` is false when target and stop are on the wrong
 * sides of entry.
 */
export function positionMath({ side = "long", entry, target, stop, qty = 1 }) {
  const dir = side === "short" ? -1 : 1;
  const reward = (target - entry) * dir;
  const risk = (entry - stop) * dir;
  const ok = [entry, target, stop].every(fin) && reward > 0 && risk > 0;
  const q = fin(qty) && qty > 0 ? qty : 1;
  return {
    reward,
    risk,
    rr: ok ? reward / risk : NaN,
    pnlTarget: reward * q,
    pnlStop: -risk * q,
    pctTarget: entry ? (reward / entry) * 100 : NaN,
    pctStop: entry ? (-risk / entry) * 100 : NaN,
    valid: ok,
  };
}

/** Default target and stop for a new position tool at `entry`: `pct` of the visible price span either side, 2:1. */
export function positionDefaults(side, entry, span) {
  const r = Math.max(Math.abs(entry) * 0.001, span * 0.1);
  return side === "short" ? { target: entry - 2 * r, stop: entry + r } : { target: entry + 2 * r, stop: entry - r };
}

/** A measure between two points: price change, percent and bars. */
export function measureMath(a, b) {
  const change = b.p - a.p;
  return { change, pct: a.p ? (change / a.p) * 100 : NaN, bars: Math.round(b.i - a.i) };
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Extend the segment a→b past b to the edge x = xEdge (a ray). Returns the far point. */
export function rayTo(ax, ay, bx, by, xEdge) {
  if (bx === ax) return { x: bx, y: by > ay ? 1e6 : -1e6 };
  const x = bx > ax ? Math.max(xEdge, bx) : Math.min(0, bx);
  return { x, y: ay + ((by - ay) * (x - ax)) / (bx - ax) };
}

/**
 * A drawing in pixels as hit shapes: [{ kind: "seg"|"rect"|"hline", ... }]. `X(i)` and `Y(p)` map a point to pixels;
 * `W` is the plot's right edge (rays and horizontal lines run to it). Points are { i, p } (bar index, price).
 */
export function drawingShapes(d, X, Y, W) {
  const P = (d.pts ?? []).map((q) => ({ x: X(q.i), y: Y(q.p) }));
  const seg = (a, b) => ({ kind: "seg", ax: a.x, ay: a.y, bx: b.x, by: b.y });
  switch (d.type) {
    case "trend":
    case "measure":
      return P.length > 1 ? [seg(P[0], P[1])] : [];
    case "ray": {
      if (P.length < 2) return [];
      const e = rayTo(P[0].x, P[0].y, P[1].x, P[1].y, W);
      return [seg(P[0], e)];
    }
    case "hline":
      return P.length ? [{ kind: "hline", y: P[0].y }] : [];
    case "channel": {
      if (P.length < 2) return [];
      const out = [seg(P[0], P[1])];
      if (P.length > 2) {
        const off = channelOffset(d.pts[0], d.pts[1], d.pts[2]);
        out.push(seg({ x: P[0].x, y: Y(d.pts[0].p + off) }, { x: P[1].x, y: Y(d.pts[1].p + off) }));
      }
      return out;
    }
    case "fib": {
      if (P.length < 2) return [];
      const x0 = Math.min(P[0].x, P[1].x);
      const x1 = Math.max(P[0].x, P[1].x);
      return [seg(P[0], P[1]), ...fibLevels(d.pts[0].p, d.pts[1].p).map((l) => ({ kind: "seg", ax: x0, ay: Y(l.price), bx: x1, by: Y(l.price) }))];
    }
    case "rect":
      return P.length > 1 ? [{ kind: "rect", x0: Math.min(P[0].x, P[1].x), y0: Math.min(P[0].y, P[1].y), x1: Math.max(P[0].x, P[1].x), y1: Math.max(P[0].y, P[1].y) }] : [];
    case "long":
    case "short": {
      // pts: [entry (with the left edge), right edge on the entry line, target, stop]
      if (P.length < 4) return [];
      const x0 = Math.min(P[0].x, P[1].x);
      const x1 = Math.max(P[0].x, P[1].x);
      return [{ kind: "rect", x0, x1, y0: Math.min(P[0].y, P[2].y), y1: Math.max(P[0].y, P[2].y) }, { kind: "rect", x0, x1, y0: Math.min(P[0].y, P[3].y), y1: Math.max(P[0].y, P[3].y) }];
    }
    case "text":
      return P.length ? [{ kind: "rect", x0: P[0].x - 4, y0: P[0].y - 16, x1: P[0].x + Math.max(24, (d.text?.length ?? 4) * 7.5), y1: P[0].y + 6 }] : [];
    default:
      return [];
  }
}

/** Distance from a point to one hit shape (0 inside a rectangle). */
export function shapeDist(s, x, y) {
  if (s.kind === "seg") return segDist(x, y, s.ax, s.ay, s.bx, s.by);
  if (s.kind === "hline") return Math.abs(y - s.y);
  if (s.kind === "rect") {
    const dx = Math.max(s.x0 - x, 0, x - s.x1);
    const dy = Math.max(s.y0 - y, 0, y - s.y1);
    return Math.hypot(dx, dy);
  }
  return Infinity;
}

/**
 * The drawing under (x, y): its id and, when the pointer is on one of its points, that point's index (a handle to
 * drag). Later drawings win (they are on top). `tol` is the reach in pixels. Returns null when nothing is hit.
 */
export function hitTest(drawings, x, y, X, Y, W, tol = 6) {
  for (let k = drawings.length - 1; k >= 0; k--) {
    const d = drawings[k];
    const pts = d.pts ?? [];
    // A horizontal line has no handle of its own: the whole line drags.
    if (d.type !== "hline") for (let j = 0; j < pts.length; j++) if (Math.hypot(X(pts[j].i) - x, Y(pts[j].p) - y) <= tol + 2) return { id: d.id, handle: j };
    if (drawingShapes(d, X, Y, W).some((s) => shapeDist(s, x, y) <= tol)) return { id: d.id, handle: -1 };
  }
  return null;
}

/** How many points each tool takes from clicks (the position tool fills in the rest itself). */
export const TOOL_POINTS = Object.freeze({ trend: 2, ray: 2, hline: 1, channel: 3, fib: 2, rect: 2, long: 1, short: 1, text: 1, measure: 2 });

/**
 * Snap a price to the nearest of a candle's open, high, low and close when it is within `px` pixels (the magnet).
 * `Y` maps price to pixels. Returns the price to use.
 */
export function magnet(p, candle, Y, px = 8) {
  if (!candle) return p;
  const y = Y(p);
  let best = p;
  let bd = px;
  for (const v of [candle.open, candle.high, candle.low, candle.close]) {
    const d = Math.abs(Y(v) - y);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/** Drawings kept per symbol in this browser, cleaned: known types, finite points, at most `max`. */
export function cleanDrawings(raw, max = 200) {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((d) => d && typeof d === "object" && Object.hasOwn(TOOL_POINTS, d.type) && d.type !== "measure" && Array.isArray(d.pts) && d.pts.length >= 1 && d.pts.every((q) => fin(q?.t) && fin(q?.p)))
    .slice(-max)
    .map((d) => ({ id: String(d.id ?? Math.random().toString(36).slice(2)), type: d.type, pts: d.pts.map((q) => ({ t: q.t, p: q.p })), tone: typeof d.tone === "string" ? d.tone : undefined, dash: d.dash === true, text: typeof d.text === "string" ? d.text.slice(0, 120) : undefined, qty: fin(d.qty) ? d.qty : undefined }));
}
