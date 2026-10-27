/**
 * Indicator series for the scanner (stream S13). Pure functions over number arrays aligned to candles: index i is
 * bar i (oldest first). A value that cannot be computed yet (not enough bars) is NaN, never 0, so a condition on it
 * is simply false. Definitions follow the usual charting conventions:
 *   sma, ema (seeded with the SMA of the first n bars), rma (Wilder), rsi (Wilder), atr (Wilder over true range),
 *   macd = ema(fast) - ema(slow), signal = ema(macd, n), stddev (population), Bollinger = sma ± k·stddev,
 *   supertrend (ATR bands, flips on close), vwap (resets each IST day), roc in percent.
 */

export const IST_OFFSET_S = 19_800;

const isNum = Number.isFinite;

export function sma(src, n) {
  const out = new Array(src.length).fill(NaN);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i += 1) {
    const v = src[i];
    if (!isNum(v)) {
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count += 1;
    if (count > n) {
      sum -= src[i - n];
      count = n;
    }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average with alpha = 2/(n+1), seeded with the SMA of the first n valid values. */
export function ema(src, n, alpha = 2 / (n + 1)) {
  const out = new Array(src.length).fill(NaN);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < src.length; i += 1) {
    const v = src[i];
    if (!isNum(v)) continue;
    if (!isNum(prev)) {
      seedSum += v;
      seedCount += 1;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's moving average (RMA), alpha = 1/n. */
export const rma = (src, n) => ema(src, n, 1 / n);

export function rsi(src, n) {
  const gains = new Array(src.length).fill(NaN);
  const losses = new Array(src.length).fill(NaN);
  for (let i = 1; i < src.length; i += 1) {
    if (!isNum(src[i]) || !isNum(src[i - 1])) continue;
    const d = src[i] - src[i - 1];
    gains[i] = Math.max(d, 0);
    losses[i] = Math.max(-d, 0);
  }
  const g = rma(gains, n);
  const l = rma(losses, n);
  return g.map((gv, i) => {
    if (!isNum(gv) || !isNum(l[i])) return NaN;
    if (l[i] === 0) return gv === 0 ? 50 : 100;
    return 100 - 100 / (1 + gv / l[i]);
  });
}

export function trueRange(high, low, close) {
  return high.map((h, i) => {
    if (i === 0) return h - low[i];
    return Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  });
}

export const atr = (high, low, close, n) => rma(trueRange(high, low, close), n);

export function highest(src, n) {
  return src.map((_, i) => (i + 1 < n ? NaN : Math.max(...src.slice(i + 1 - n, i + 1))));
}

export function lowest(src, n) {
  return src.map((_, i) => (i + 1 < n ? NaN : Math.min(...src.slice(i + 1 - n, i + 1))));
}

export function stddev(src, n) {
  const mean = sma(src, n);
  return src.map((_, i) => {
    if (!isNum(mean[i])) return NaN;
    let s = 0;
    for (let k = i + 1 - n; k <= i; k += 1) s += (src[k] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

export function roc(src, n) {
  return src.map((v, i) => (i < n || !isNum(src[i - n]) || src[i - n] === 0 ? NaN : ((v - src[i - n]) / src[i - n]) * 100));
}

export function macd(src, fast, slow) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  return f.map((v, i) => v - s[i]);
}

export const macdSignal = (src, fast, slow, signal) => ema(macd(src, fast, slow), signal);

/** Supertrend line: ATR bands around hl2 that only tighten, flipping side when close crosses the active band. */
export function supertrend(high, low, close, n, mult) {
  const a = atr(high, low, close, n);
  const out = new Array(close.length).fill(NaN);
  let upper = NaN;
  let lower = NaN;
  let up = true;
  for (let i = 0; i < close.length; i += 1) {
    if (!isNum(a[i])) continue;
    const hl2 = (high[i] + low[i]) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    const prevClose = close[i - 1];
    upper = isNum(upper) && !(bu < upper || prevClose > upper) ? upper : bu;
    lower = isNum(lower) && !(bl > lower || prevClose < lower) ? lower : bl;
    if (isNum(out[i - 1])) {
      if (up && close[i] < lower) up = false;
      else if (!up && close[i] > upper) up = true;
    } else up = close[i] >= hl2;
    out[i] = up ? lower : upper;
  }
  return out;
}

/** VWAP of typical price, reset at each IST calendar day. */
export function vwap(time, high, low, close, volume) {
  const out = new Array(close.length).fill(NaN);
  let day = null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < close.length; i += 1) {
    const d = Math.floor((time[i] + IST_OFFSET_S) / 86_400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const v = isNum(volume[i]) ? volume[i] : 0;
    pv += ((high[i] + low[i] + close[i]) / 3) * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}
