import { robustIndicator, sanitizeSeries, clampPeriod, isFiniteNum } from './sanitize.js';
import { ChartTransformError, MAX_RENKO_BRICKS } from '../transformProblem.js';
import { rollingMean, rollingMeanStd, rollingMeanStrict, slidingExtremeIndex } from './rolling.js';
import { calcIchimoku, ichimokuFutureCloud } from './ichimoku.js';
// Public robustness + parity helpers (see indicators/*.ts).
export { sanitizeSeries, clampPeriod, calcIchimoku, ichimokuFutureCloud };
// Every calc* below is authored as `calcXCore` (raw maths on finite input) and
// exported through `robustIndicator` at the bottom of the file: non-finite bars
// become null outputs without poisoning later bars, and window lengths are
// clamped to integers >= 1. Public names / signatures / result shapes unchanged.
// ─── EMA ────────────────────────────────────────────────────
// Convention: SMA seed — first EMA value at index period-1 is the simple
// mean of the first `period` inputs; subsequent values use k = 2/(period+1).
function calcEMACore(closes, period) {
    if (closes.length < period)
        return closes.map(() => null);
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result = new Array(period - 1).fill(null);
    result.push(ema);
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}
// ─── SMA ────────────────────────────────────────────────────
function calcSMACore(closes, period) {
    return rollingMean(closes, period); // O(n) running sum, exact re-sum guard
}
// ─── Null-aware smoothing helpers ───────────────────────────
// Apply EMA/SMA/WMA to a series with a leading-null prefix (e.g. the output
// of another indicator) WITHOUT contaminating the seed with fake zeros.
// Output stays index-aligned with the input; the null prefix grows by the
// smoother's own warm-up. Assumes non-null values are contiguous after the
// first non-null index (true for every series produced in this module).
function emaOfSeries(values, period) {
    const first = values.findIndex(v => v !== null);
    if (first === -1)
        return values.map(() => null);
    const tail = values.slice(first).map(v => v ?? NaN);
    return [...new Array(first).fill(null), ...calcEMACore(tail, period)];
}
function smaOfSeries(values, period) {
    const first = values.findIndex(v => v !== null);
    if (first === -1)
        return values.map(() => null);
    const tail = values.slice(first).map(v => v ?? NaN);
    return [...new Array(first).fill(null), ...calcSMACore(tail, period)];
}
function wmaOfSeries(values, period) {
    const first = values.findIndex(v => v !== null);
    if (first === -1)
        return values.map(() => null);
    const tail = values.slice(first).map(v => v ?? NaN);
    return [...new Array(first).fill(null), ...calcWMACore(tail, period)];
}
// ─── VWAP (no session reset for EOD data) ───────────────────
export function calcVWAP(candles) {
    const result = [];
    let cumPV = 0, cumV = 0;
    for (const c of candles) {
        const tp = (c.high + c.low + c.close) / 3;
        // A bar with non-finite price/volume contributes nothing and plots null.
        if (!isFiniteNum(tp) || !isFiniteNum(c.volume)) {
            result.push(null);
            continue;
        }
        cumPV += tp * c.volume;
        cumV += c.volume;
        result.push(cumV === 0 ? null : cumPV / cumV);
    }
    return result;
}
function calcBBCore(closes, period = 20, mult = 2) {
    const { mean, std } = rollingMeanStd(closes, period); // population sigma, rolling
    return closes.map((_, i) => {
        const mid = mean[i], sd = std[i];
        if (mid === null || sd === null)
            return { upper: null, mid: null, lower: null };
        return { upper: mid + mult * sd, mid, lower: mid - mult * sd };
    });
}
// ─── RSI (Wilder) ───────────────────────────────────────────
// First average = simple mean of the first `period` gains/losses;
// then Wilder smoothing: avg = (prevAvg*(period-1) + current) / period.
// 100*g/(g+l) is algebraically identical to 100 - 100/(1+RS) and stays
// exact at the boundaries: all-gains → 100, all-losses → 0, flat → 50.
function calcRSICore(closes, period = 14) {
    const result = [null];
    if (closes.length < period + 1)
        return closes.map(() => null);
    const rsiFrom = (g, l) => (g + l === 0 ? 50 : (g / (g + l)) * 100);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0)
            avgGain += d;
        else
            avgLoss -= d;
        result.push(null);
    }
    avgGain /= period;
    avgLoss /= period;
    result[period] = rsiFrom(avgGain, avgLoss);
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const gain = Math.max(0, d);
        const loss = Math.max(0, -d);
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        result.push(rsiFrom(avgGain, avgLoss));
    }
    return result;
}
function calcMACDCore(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = calcEMACore(closes, fast);
    const emaSlow = calcEMACore(closes, slow);
    const macdLine = closes.map((_, i) => {
        const f = emaFast[i], s = emaSlow[i];
        return f !== null && s !== null ? f - s : null;
    });
    // Signal = EMA(macd, signal period), index-aligned with the MACD line
    const sigLine = emaOfSeries(macdLine, signal);
    return closes.map((_, i) => {
        const m = macdLine[i], sig = sigLine[i];
        return { macd: m, signal: sig, hist: m !== null && sig !== null ? m - sig : null };
    });
}
function calcStochasticCore(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
    const result = [];
    const kVals = [];
    const hiIdx = slidingExtremeIndex(highs, kPeriod, 'max');
    const loIdx = slidingExtremeIndex(lows, kPeriod, 'min');
    for (let i = 0; i < closes.length; i++) {
        if (i < kPeriod - 1) {
            kVals.push(null);
            result.push({ k: null, d: null });
            continue;
        }
        const hh = highs[hiIdx[i]], ll = lows[loIdx[i]];
        const k = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
        kVals.push(k);
        // %D = SMA of %K
        let d = null;
        if (i >= kPeriod - 1 + dPeriod - 1) {
            let sum = 0, cnt = 0;
            for (let j = i - dPeriod + 1; j <= i; j++) {
                if (kVals[j] !== null) {
                    sum += kVals[j];
                    cnt++;
                }
            }
            d = cnt > 0 ? sum / cnt : null;
        }
        result.push({ k, d });
    }
    return result;
}
function calcADXCore(highs, lows, closes, period = 14) {
    const len = closes.length;
    if (len < 2)
        return closes.map(() => ({ adx: null, plusDI: null, minusDI: null }));
    const result = [{ adx: null, plusDI: null, minusDI: null }];
    const tr = [0];
    const plusDM = [0];
    const minusDM = [0];
    for (let i = 1; i < len; i++) {
        const h = highs[i], l = lows[i], pc = closes[i - 1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const upMove = h - highs[i - 1], downMove = lows[i - 1] - l;
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    // Smoothed TR, +DM, -DM
    let sTR = 0, sPDM = 0, sMDM = 0;
    for (let i = 1; i <= period; i++) {
        sTR += tr[i];
        sPDM += plusDM[i];
        sMDM += minusDM[i];
    }
    const dxVals = [];
    for (let i = 1; i < len; i++) {
        if (i < period) {
            result.push({ adx: null, plusDI: null, minusDI: null });
            continue;
        }
        if (i > period) {
            sTR = sTR - sTR / period + tr[i];
            sPDM = sPDM - sPDM / period + plusDM[i];
            sMDM = sMDM - sMDM / period + minusDM[i];
        }
        const pDI = sTR === 0 ? 0 : (sPDM / sTR) * 100;
        const mDI = sTR === 0 ? 0 : (sMDM / sTR) * 100;
        const diSum = pDI + mDI;
        const dx = diSum === 0 ? 0 : (Math.abs(pDI - mDI) / diSum) * 100;
        dxVals.push(dx);
        let adx = null;
        if (dxVals.length >= period) {
            if (dxVals.length === period) {
                adx = dxVals.reduce((a, b) => a + b, 0) / period;
            }
            else {
                const prevADX = result[i - 1]?.adx;
                adx = prevADX !== null ? (prevADX * (period - 1) + dx) / period : dx;
            }
        }
        result.push({ adx, plusDI: pDI, minusDI: mDI });
    }
    return result;
}
// ─── ATR (Average True Range) ────────────────────────────────
// Matches Pine ta.atr = rma(tr, period): tr[0] = high - low (no previous
// close), first ATR at index period-1 = mean(tr[0..period-1]), then Wilder
// smoothing atr = (prev*(period-1) + tr) / period.
function calcATRCore(highs, lows, closes, period = 14) {
    const len = closes.length;
    const result = new Array(len).fill(null);
    if (len < period)
        return result;
    let atr = 0;
    for (let i = 0; i < len; i++) {
        const tr = i === 0
            ? highs[0] - lows[0]
            : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        if (i < period) {
            atr += tr;
            if (i === period - 1) {
                atr /= period;
                result[i] = atr;
            }
        }
        else {
            atr = (atr * (period - 1) + tr) / period;
            result[i] = atr;
        }
    }
    return result;
}
function calcSuperTrendCore(highs, lows, closes, period = 10, multiplier = 3) {
    const atrVals = calcATRCore(highs, lows, closes, period);
    const len = closes.length;
    const result = [];
    let prevUpper = 0, prevLower = 0, prevST = 0;
    for (let i = 0; i < len; i++) {
        const atr = atrVals[i];
        if (atr === null) {
            result.push({ value: null, direction: 1 });
            continue;
        }
        const hl2 = (highs[i] + lows[i]) / 2;
        let upper = hl2 + multiplier * atr;
        let lower = hl2 - multiplier * atr;
        if (i > 0) {
            upper = upper < prevUpper || closes[i - 1] > prevUpper ? upper : prevUpper;
            lower = lower > prevLower || closes[i - 1] < prevLower ? lower : prevLower;
        }
        let pineDir; // Pine convention: 1 = bearish, -1 = bullish
        if (i === 0 || atrVals[i - 1] === null)
            pineDir = 1;
        else if (prevST === prevUpper)
            pineDir = closes[i] > upper ? -1 : 1;
        else
            pineDir = closes[i] < lower ? 1 : -1;
        const st = pineDir === -1 ? lower : upper;
        result.push({ value: st, direction: pineDir === -1 ? 1 : -1 });
        prevUpper = upper;
        prevLower = lower;
        prevST = st;
    }
    return result;
}
export function calcPivotPoints(high, low, close) {
    const pp = (high + low + close) / 3;
    return {
        pp, r1: 2 * pp - low, r2: pp + (high - low), r3: 2 * pp + (high - 2 * low),
        s1: 2 * pp - high, s2: pp - (high - low), s3: 2 * pp - (2 * high - low),
    };
}
export function calcVWAPBands(candles) {
    const result = [];
    let cumPV = 0, cumV = 0, cumPV2 = 0;
    for (const c of candles) {
        const tp = (c.high + c.low + c.close) / 3;
        if (!isFiniteNum(tp) || !isFiniteNum(c.volume)) {
            result.push({ vwap: null, upper1: null, lower1: null, upper2: null, lower2: null });
            continue;
        }
        cumPV += tp * c.volume;
        cumV += c.volume;
        cumPV2 += tp * tp * c.volume;
        if (cumV === 0) {
            result.push({ vwap: null, upper1: null, lower1: null, upper2: null, lower2: null });
            continue;
        }
        const vwap = cumPV / cumV;
        const variance = cumPV2 / cumV - vwap * vwap;
        const sd = Math.sqrt(Math.max(0, variance));
        result.push({ vwap, upper1: vwap + sd, lower1: vwap - sd, upper2: vwap + 2 * sd, lower2: vwap - 2 * sd });
    }
    return result;
}
function calcDonchianCore(highs, lows, period = 20) {
    const hiIdx = slidingExtremeIndex(highs, period, 'max');
    const loIdx = slidingExtremeIndex(lows, period, 'min');
    return highs.map((_, i) => {
        if (hiIdx[i] < 0)
            return { upper: null, lower: null, mid: null };
        const hh = highs[hiIdx[i]], ll = lows[loIdx[i]];
        return { upper: hh, lower: ll, mid: (hh + ll) / 2 };
    });
}
// ─── OBV (On Balance Volume) ─────────────────────────────────
function calcOBVCore(closes, volumes) {
    if (closes.length === 0)
        return [];
    const result = [0];
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1])
            result.push(result[i - 1] + volumes[i]);
        else if (closes[i] < closes[i - 1])
            result.push(result[i - 1] - volumes[i]);
        else
            result.push(result[i - 1]);
    }
    return result;
}
// ─── Williams %R ─────────────────────────────────────────────
function calcWilliamsRCore(highs, lows, closes, period = 14) {
    const hiIdx = slidingExtremeIndex(highs, period, 'max');
    const loIdx = slidingExtremeIndex(lows, period, 'min');
    return closes.map((c, i) => {
        if (hiIdx[i] < 0)
            return null;
        const hh = highs[hiIdx[i]], ll = lows[loIdx[i]];
        return hh === ll ? -50 : ((hh - c) / (hh - ll)) * -100;
    });
}
// ─── Renko Bricks ────────────────────────────────────────────
/**
 * Standard (traditional) close-based Renko on a fixed grid of `brickSize`.
 *
 * - The grid is anchored at the first close FLOORED to a brick (2026-10-18; it was
 *   rounded). The tiny epsilon keeps a close that sits on a grid line in binary
 *   floating point (0.3 / 0.1 = 2.9999...) on that line.
 * - No brick ever starts from 0 when price never traded there (2026-10-18): when the
 *   floor is 0 (a first close below one brick, e.g. a ₹4 stock with a brick of 10),
 *   the first close's own brick [0, brick] is taken as the starting brick, undrawn,
 *   so the first brick drawn is [brick, 2 x brick]. Before, a rise to 10 drew a
 *   brick from 0.00 and the price axis stretched down to zero.
 * - Continuation: a new brick in the current direction once the close has moved a
 *   full brick past the END of the last brick.
 * - Reversal: TWO bricks. The first opposite brick starts at the far side of the
 *   last brick (the bottom of the last up brick, the top of the last down brick),
 *   so the close must travel two brick sizes from the last brick's end. This is the
 *   standard (traditional) definition in the charting literature (Nison).
 *   Until 2026-10-17 a single brick back reversed (a one-brick pullback after an
 *   up run drew a down brick that overlapped the last up brick).
 *
 * Both rules fall out of one state: the last brick's [lo, hi]. Up bricks need
 * close >= hi + brick, down bricks need close <= lo - brick. After an up brick
 * lo = hi - brick, so a reversal down needs close <= hi - 2 x brick.
 */
export function calcRenko(candles, brickSize) {
    if (candles.length === 0 || !isFiniteNum(brickSize) || brickSize <= 0)
        return [];
    const usable = candles.filter(c => isFiniteNum(c.close));
    if (usable.length === 0)
        return [];
    const bricks = [];
    const first = usable[0].close;
    const anchor = Math.floor(first / brickSize + 1e-9) * brickSize;
    if (!Number.isFinite(anchor))
        throw new ChartTransformError('precision');
    // The last brick's bottom and top (both the anchor before the first brick), or
    // the first close's own brick when the floored grid would start a brick at 0.
    let lo = anchor, hi = anchor;
    if (anchor === 0 && first > 0)
        hi = brickSize;
    for (const c of usable) {
        // Imported preferences can request a brick smaller than a representable step
        // at this price; adding it would never advance either while loop below.
        if (!(hi + brickSize > hi) || !(lo - brickSize < lo))
            throw new ChartTransformError('precision');
        // Reject clearly oversized requests before allocating their bricks. The loop
        // check below keeps the exact cap at floating-point boundaries as well.
        const span = c.close >= hi ? c.close - hi : lo - c.close;
        if (span / brickSize > MAX_RENKO_BRICKS - bricks.length + 1)
            throw new ChartTransformError('limit');
        while (c.close >= hi + brickSize) {
            if (bricks.length >= MAX_RENKO_BRICKS)
                throw new ChartTransformError('limit');
            if (!(hi + brickSize > hi))
                throw new ChartTransformError('precision');
            bricks.push({ date: c.date, open: hi, high: hi + brickSize, low: hi, close: hi + brickSize, volume: c.volume });
            lo = hi;
            hi += brickSize;
        }
        while (c.close <= lo - brickSize) {
            if (bricks.length >= MAX_RENKO_BRICKS)
                throw new ChartTransformError('limit');
            if (!(lo - brickSize < lo))
                throw new ChartTransformError('precision');
            bricks.push({ date: c.date, open: lo, high: lo, low: lo - brickSize, close: lo - brickSize, volume: c.volume });
            hi = lo;
            lo -= brickSize;
        }
    }
    return bricks;
}
// ─── Heikin-Ashi ─────────────────────────────────────────────
export function calcHA(candles) {
    const result = [];
    let prevHA; // last HA candle built from a fully finite bar
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (![c.open, c.high, c.low, c.close].every(isFiniteNum)) {
            // Bad bar: stay aligned by repeating the last good HA body; state is not poisoned.
            result.push(prevHA ? { ...c, open: prevHA.open, high: prevHA.high, low: prevHA.low, close: prevHA.close } : { ...c });
            continue;
        }
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        const haOpen = prevHA
            ? (prevHA.open + prevHA.close) / 2
            : (c.open + c.close) / 2;
        const haHigh = Math.max(c.high, haOpen, haClose);
        const haLow = Math.min(c.low, haOpen, haClose);
        prevHA = { ...c, open: haOpen, high: haHigh, low: haLow, close: haClose };
        result.push(prevHA);
    }
    return result;
}
// ─── WMA (Weighted Moving Average) ───────────────────────────
function calcWMACore(closes, period) {
    const result = [];
    const denom = (period * (period + 1)) / 2;
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            result.push(null);
            continue;
        }
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += closes[i - period + 1 + j] * (j + 1);
        }
        result.push(sum / denom);
    }
    return result;
}
// ─── HMA (Hull Moving Average) ──────────────────────────────
function calcHMACore(closes, period) {
    const halfP = Math.max(1, Math.floor(period / 2));
    const sqrtP = Math.max(1, Math.round(Math.sqrt(period))); // Pine: round(sqrt(len))
    const wmaHalf = calcWMACore(closes, halfP);
    const wmaFull = calcWMACore(closes, period);
    // 2 * WMA(half) - WMA(full), then WMA(sqrt(period)) of that.
    // Leading values stay null (padding with raw closes would fabricate points).
    const diff = closes.map((_, i) => {
        const h = wmaHalf[i], f = wmaFull[i];
        return h !== null && f !== null ? 2 * h - f : null;
    });
    return wmaOfSeries(diff, sqrtP);
}
// ─── DEMA (Double Exponential Moving Average) ────────────────
function calcDEMACore(closes, period) {
    const ema1 = calcEMACore(closes, period);
    const ema2 = emaOfSeries(ema1, period); // EMA-of-EMA seeded on real values only
    return closes.map((_, i) => {
        const e1 = ema1[i], e2 = ema2[i];
        if (e1 === null || e2 === null)
            return null;
        return 2 * e1 - e2;
    });
}
// ─── TEMA (Triple Exponential Moving Average) ────────────────
function calcTEMACore(closes, period) {
    const ema1 = calcEMACore(closes, period);
    const ema2 = emaOfSeries(ema1, period);
    const ema3 = emaOfSeries(ema2, period);
    return closes.map((_, i) => {
        const e1 = ema1[i], e2 = ema2[i], e3 = ema3[i];
        if (e1 === null || e2 === null || e3 === null)
            return null;
        return 3 * e1 - 3 * e2 + e3;
    });
}
// `atrPeriod` (I1-11, 2026-10-26): the ATR length on its own; left out it follows `period`, as before.
function calcKeltnerCore(highs, lows, closes, period = 20, mult = 1.5, atrPeriod) {
    const emaVals = calcEMACore(closes, period);
    const atrVals = calcATRCore(highs, lows, closes, atrPeriod ?? period);
    return closes.map((_, i) => {
        const mid = emaVals[i];
        const atr = atrVals[i];
        if (mid === null || atr === null)
            return { upper: null, mid: null, lower: null };
        return { upper: mid + mult * atr, mid, lower: mid - mult * atr };
    });
}
// ─── CMF (Chaikin Money Flow) ────────────────────────────────
function calcCMFCore(highs, lows, closes, volumes, period = 20) {
    const result = [];
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            result.push(null);
            continue;
        }
        let mfvSum = 0, volSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const hl = highs[j] - lows[j];
            const mfm = hl === 0 ? 0 : ((closes[j] - lows[j]) - (highs[j] - closes[j])) / hl;
            mfvSum += mfm * volumes[j];
            volSum += volumes[j];
        }
        result.push(volSum === 0 ? 0 : mfvSum / volSum);
    }
    return result;
}
// ─── DPO (Detrended Price Oscillator) ────────────────────────
// Non-centered variant: DPO[i] = close[i] − SMA[i − (period/2 + 1)]
// (same series as the centered StockCharts plot, aligned to the current bar)
function calcDPOCore(closes, period = 20) {
    const sma = calcSMACore(closes, period);
    const shift = Math.floor(period / 2) + 1;
    return closes.map((c, i) => {
        const smaIdx = i - shift;
        if (smaIdx < 0 || sma[smaIdx] === null)
            return null;
        return c - sma[smaIdx];
    });
}
// ─── TRIX ────────────────────────────────────────────────────
// Reference platform: 10000 * change(ema(ema(ema(log(close), len), len), len)).
// Default length 18 (reference-platform default). Non-positive closes have no logarithm: they
// carry the previous log forward and yield null at that bar.
function calcTRIXCore(closes, period = 18) {
    const logs = sanitizeSeries(closes.map(c => (c > 0 ? Math.log(c) : NaN)));
    const ema1 = calcEMACore(logs, period);
    const ema2 = emaOfSeries(ema1, period);
    const ema3 = emaOfSeries(ema2, period);
    return ema3.map((v, i) => {
        if (i === 0 || v === null || ema3[i - 1] === null || !(closes[i] > 0))
            return null;
        return 10000 * (v - ema3[i - 1]);
    });
}
function calcTSICore(closes, longP = 25, shortP = 13, signalP = 7) {
    if (closes.length < 2)
        return closes.map(() => ({ tsi: null, signal: null }));
    // Momentum is undefined at bar 0 — keep it null so EMA seeds exclude it.
    const pc = [null];
    const abspc = [null];
    for (let i = 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        pc.push(d);
        abspc.push(Math.abs(d));
    }
    const ds2 = emaOfSeries(emaOfSeries(pc, longP), shortP);
    const as2 = emaOfSeries(emaOfSeries(abspc, longP), shortP);
    const tsiVals = closes.map((_, i) => {
        const d = ds2[i], a = as2[i];
        if (d === null || a === null || a === 0)
            return null;
        return (d / a) * 100;
    });
    const sigVals = emaOfSeries(tsiVals, signalP); // index-aligned signal
    return closes.map((_, i) => {
        const t = tsiVals[i];
        return { tsi: t, signal: t === null ? null : sigVals[i] ?? null };
    });
}
// ─── PPO (Percentage Price Oscillator) ───────────────────────
function calcPPOCore(closes, fast = 12, slow = 26, _signal = 9) {
    const emaFast = calcEMACore(closes, fast);
    const emaSlow = calcEMACore(closes, slow);
    return closes.map((_, i) => {
        const f = emaFast[i], s = emaSlow[i];
        if (f === null || s === null || s === 0)
            return null;
        return ((f - s) / s) * 100;
    });
}
function calcPPOFullCore(closes, fast = 12, slow = 26, signal = 9) {
    const ppo = calcPPOCore(closes, fast, slow);
    const sig = emaOfSeries(ppo, signal);
    return ppo.map((p, i) => {
        const sg = sig[i];
        return { ppo: p, signal: sg, hist: p !== null && sg !== null ? p - sg : null };
    });
}
// ─── CMO (Chande Momentum Oscillator) ────────────────────────
function calcCMOCore(closes, period = 14) {
    const result = [null];
    if (closes.length < period + 1)
        return closes.map(() => null);
    let sumUp = 0, sumDown = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0)
            sumUp += d;
        else
            sumDown -= d;
        result.push(null);
    }
    const total = sumUp + sumDown;
    result[period] = total === 0 ? 0 : ((sumUp - sumDown) / total) * 100;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const oldD = closes[i - period] - closes[i - period - 1];
        if (d > 0)
            sumUp += d;
        else
            sumDown -= d;
        if (oldD > 0)
            sumUp -= oldD;
        else
            sumDown += oldD;
        sumUp = Math.max(0, sumUp);
        sumDown = Math.max(0, sumDown);
        const t = sumUp + sumDown;
        result.push(t === 0 ? 0 : ((sumUp - sumDown) / t) * 100);
    }
    return result;
}
function calcAroonCore(highs, lows, period = 25) {
    // Window = period + 1 bars; ties resolve to the most recent extreme.
    const hiIdx = slidingExtremeIndex(highs, period + 1, 'max');
    const loIdx = slidingExtremeIndex(lows, period + 1, 'min');
    return highs.map((_, i) => {
        if (hiIdx[i] < 0)
            return { up: null, down: null };
        return {
            up: ((period - (i - hiIdx[i])) / period) * 100,
            down: ((period - (i - loIdx[i])) / period) * 100,
        };
    });
}
// ─── BBW (Bollinger Bandwidth) ───────────────────────────────
function calcBBWCore(closes, period = 20, mult = 2) {
    const bb = calcBBCore(closes, period, mult);
    return bb.map(b => {
        if (b.upper === null || b.lower === null || b.mid === null || b.mid === 0)
            return null;
        return ((b.upper - b.lower) / b.mid) * 100;
    });
}
// ─── CHOP (Choppiness Index) ─────────────────────────────────
function calcCHOPCore(highs, lows, closes, period = 14) {
    const atr1 = calcATRCore(highs, lows, closes, 1);
    const hiIdx = slidingExtremeIndex(highs, period, 'max');
    const loIdx = slidingExtremeIndex(lows, period, 'min');
    const result = [];
    for (let i = 0; i < closes.length; i++) {
        // First value on bar period-1 (I1-9): TR of bar 0 is its high - low, a real value, as the reference platform.
        if (i < period - 1) {
            result.push(null);
            continue;
        }
        let atrSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            atrSum += atr1[j] ?? (highs[j] - lows[j]);
        }
        const hlDiff = highs[hiIdx[i]] - lows[loIdx[i]];
        if (hlDiff === 0) {
            result.push(50);
            continue;
        }
        result.push(100 * Math.log10(atrSum / hlDiff) / Math.log10(period));
    }
    return result;
}
// ─── EWO (Elliott Wave Oscillator) ───────────────────────────
// EMA(5) − EMA(34) of closes (EMA variant; classic EWO uses SMA of hl2 —
// signature takes closes only, so this variant is intentional)
function calcEWOCore(closes, fast = 5, slow = 34) {
    const emaFast = calcEMACore(closes, fast);
    const emaSlow = calcEMACore(closes, slow);
    return closes.map((_, i) => {
        const f = emaFast[i], s = emaSlow[i];
        if (f === null || s === null)
            return null;
        return f - s;
    });
}
/**
 * Parabolic SAR, rule order as the reference platform's `ta.sar` (I1-4, 2026-10-26):
 *  1. seed on bar 1: long when close[1] > close[0] (SAR = low[0], EP = high[1]), else short (SAR = high[0], EP = low[1]);
 *  2. every bar: SAR += AF * (EP - SAR);
 *  3. penetration is tested against that UNCLAMPED SAR: a long whose SAR is above the bar's low (a short whose SAR is
 *     below the bar's high) reverses. The new SAR is the old EP pushed outside the reversal bar's own range
 *     (max(EP, high) for a flip short, min(EP, low) for a flip long), EP = that bar's low (high), AF = start;
 *  4. otherwise a new extreme moves EP and steps AF by `step` up to `max`;
 *  5. last, the SAR is clamped against the previous two bars (below their lows when long, above their highs when
 *     short), on reversal bars too, so the dot never sits inside the last two bars' range.
 * Before: Wilder's clamp-then-test order, a reversal SAR set to the old EP without the reversal bar's own extreme
 * (it could land inside that bar), and a seed from high[1] > high[0]. `start` defaults to `step`.
 */
function calcSARCore(highs, lows, step = 0.02, max = 0.2, start, closes) {
    const n = highs.length;
    if (n < 2)
        return Array(n).fill(null);
    const af0 = Number.isFinite(start) && start > 0 ? start : step;
    const up0 = closes && Number.isFinite(closes[1]) && Number.isFinite(closes[0]) ? closes[1] > closes[0] : highs[1] > highs[0];
    const result = [null];
    let isUp = up0;
    let af = af0;
    let ep = isUp ? highs[1] : lows[1];
    let sar = isUp ? lows[0] : highs[0];
    for (let i = 1; i < n; i++) {
        sar = sar + af * (ep - sar);
        let reversed = false;
        if (isUp) {
            if (sar > lows[i]) {
                reversed = true;
                isUp = false;
                sar = Math.max(highs[i], ep);
                ep = lows[i];
                af = af0;
            }
        }
        else if (sar < highs[i]) {
            reversed = true;
            isUp = true;
            sar = Math.min(lows[i], ep);
            ep = highs[i];
            af = af0;
        }
        if (!reversed) {
            if (isUp) {
                if (highs[i] > ep) {
                    ep = highs[i];
                    af = Math.min(af + step, max);
                }
            }
            else if (lows[i] < ep) {
                ep = lows[i];
                af = Math.min(af + step, max);
            }
        }
        if (isUp) {
            sar = Math.min(sar, lows[i - 1]);
            if (i > 1)
                sar = Math.min(sar, lows[i - 2]);
        }
        else {
            sar = Math.max(sar, highs[i - 1]);
            if (i > 1)
                sar = Math.max(sar, highs[i - 2]);
        }
        result.push({ value: sar, isUp });
    }
    return result;
}
function calcStochRSICore(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    const rsi = calcRSICore(closes, rsiPeriod);
    const result = [];
    const kVals = [];
    for (let i = 0; i < rsi.length; i++) {
        if (i < rsiPeriod + stochPeriod - 1 || rsi[i] === null) {
            kVals.push(null);
            result.push({ k: null, d: null });
            continue;
        }
        let minR = Infinity, maxR = -Infinity;
        for (let j = i - stochPeriod + 1; j <= i; j++) {
            const v = rsi[j];
            if (v !== null) {
                minR = Math.min(minR, v);
                maxR = Math.max(maxR, v);
            }
        }
        const raw = maxR !== minR ? ((rsi[i] - minR) / (maxR - minR)) * 100 : 50;
        kVals.push(raw);
        result.push({ k: null, d: null });
    }
    // %K = SMA(raw, kSmooth), %D = SMA(%K, dSmooth) — null-aware so the first
    // smoothed values average only real stochastic-RSI values, never zeros.
    const smoothK = smaOfSeries(kVals, kSmooth);
    const smoothD = smaOfSeries(smoothK, dSmooth);
    for (let i = 0; i < result.length; i++) {
        result[i].k = smoothK[i];
        result[i].d = smoothD[i];
    }
    return result;
}
// ─── CCI (Commodity Channel Index — Lambert) ────────────────
function calcCCICore(highs, lows, closes, period = 20) {
    const result = [];
    const tp = [];
    for (let i = 0; i < closes.length; i++) {
        tp.push((highs[i] + lows[i] + closes[i]) / 3);
    }
    for (let i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            result.push(null);
            continue;
        }
        let sum = 0, lo = tp[i], hi = tp[i];
        for (let j = i - period + 1; j <= i; j++) {
            sum += tp[j];
            if (tp[j] < lo)
                lo = tp[j];
            if (tp[j] > hi)
                hi = tp[j];
        }
        const mean = sum / period;
        let meanDev = 0;
        for (let j = i - period + 1; j <= i; j++)
            meanDev += Math.abs(tp[j] - mean);
        meanDev /= period;
        // A flat window (spread within 1e-12 of its size, the runtime's own rule) is 0: the floating mean of equal values is
        // off by an ulp, and dividing that by itself gave +/-66.67 (2026-10-25, B2-7).
        const flat = hi - lo <= 1e-12 * Math.max(1, Math.abs(hi), Math.abs(lo));
        result.push(flat || meanDev === 0 ? 0 : (tp[i] - mean) / (0.015 * meanDev));
    }
    return result;
}
// ─── MFI (Money Flow Index — Quong & Soudack) ───────────────
function calcMFICore(highs, lows, closes, volumes, period = 14) {
    const result = [];
    const tp = [];
    for (let i = 0; i < closes.length; i++)
        tp.push((highs[i] + lows[i] + closes[i]) / 3);
    for (let i = 0; i < closes.length; i++) {
        if (i < period) {
            result.push(null);
            continue;
        }
        let posFlow = 0, negFlow = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const mf = tp[j] * volumes[j];
            if (tp[j] > tp[j - 1])
                posFlow += mf;
            else if (tp[j] < tp[j - 1])
                negFlow += mf;
        }
        // 100*pos/(pos+neg) ≡ 100 - 100/(1+ratio); exact at the boundaries:
        // all positive flow → 100, all negative → 0, no directional flow → 50.
        const total = posFlow + negFlow;
        result.push(total === 0 ? 50 : (posFlow / total) * 100);
    }
    return result;
}
// ─── ROC (Rate of Change) ────────────────────────────────────
function calcROCCore(closes, period = 12) {
    return closes.map((c, i) => {
        if (i < period)
            return null;
        const prev = closes[i - period];
        // No change can be measured from 0 (2026-10-25, B2-4): missing, as ta.roc gives, not a definite 0%.
        return prev === 0 ? null : ((c - prev) / prev) * 100;
    });
}
function calcKDJCore(highs, lows, closes, period = 9, kSmooth = 3, dSmooth = 3) {
    const n = closes.length;
    const hiIdx = slidingExtremeIndex(highs, period, 'max');
    const loIdx = slidingExtremeIndex(lows, period, 'min');
    const rawK = closes.map((c, i) => {
        if (hiIdx[i] < 0)
            return null;
        const hh = highs[hiIdx[i]], ll = lows[loIdx[i]];
        return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
    });
    // K = SMA of rawK, D = SMA of K, J = 3K - 2D (null-aware: no fake 50s
    // before the first full period window)
    const kLine = smaOfSeries(rawK, kSmooth);
    const dLine = smaOfSeries(kLine, dSmooth);
    const result = [];
    for (let i = 0; i < n; i++) {
        const k = kLine[i], d = dLine[i];
        result.push({ k, d, j: k !== null && d !== null ? 3 * k - 2 * d : null });
    }
    return result;
}
// ─── A/D Line (Accumulation/Distribution) ────────────────────
function calcADLineCore(highs, lows, closes, volumes) {
    const result = [];
    let ad = 0;
    for (let i = 0; i < closes.length; i++) {
        const hl = highs[i] - lows[i];
        const mfm = hl === 0 ? 0 : ((closes[i] - lows[i]) - (highs[i] - closes[i])) / hl;
        ad += mfm * volumes[i];
        result.push(ad);
    }
    return result;
}
// ─── Awesome Oscillator (Bill Williams) ──────────────────────
function calcAOCore(highs, lows) {
    const mp = highs.map((h, i) => (h + lows[i]) / 2);
    const sma5 = calcSMACore(mp, 5);
    const sma34 = calcSMACore(mp, 34);
    return mp.map((_, i) => {
        const s5 = sma5[i], s34 = sma34[i];
        return s5 !== null && s34 !== null ? s5 - s34 : null;
    });
}
// ─── VROC (Volume Rate of Change) ────────────────────────────
function calcVROCCore(volumes, period = 14) {
    return volumes.map((v, i) => {
        if (i < period)
            return null;
        const prev = volumes[i - period];
        return prev === 0 ? null : ((v - prev) / prev) * 100;
    });
}
// ═══════════════ ADDED INDICATORS (2026-06) ═══════════════
// Helpers reuse existing calcEMA / calcSMA / calcRSI / calcROC in this module.
// Ultimate Oscillator (7,14,28) — single line 0..100
function calcUltimateOscCore(highs, lows, closes, p1 = 7, p2 = 14, p3 = 28) {
    const n = closes.length, bp = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        const pc = closes[i - 1];
        bp[i] = closes[i] - Math.min(lows[i], pc);
        tr[i] = Math.max(highs[i], pc) - Math.min(lows[i], pc);
    }
    const win = (a, i, p) => { let s = 0; for (let k = i - p + 1; k <= i; k++)
        s += a[k]; return s; };
    const out = new Array(n).fill(null);
    for (let i = p3; i < n; i++) {
        const t1 = win(tr, i, p1), t2 = win(tr, i, p2), t3 = win(tr, i, p3);
        if (t1 === 0 || t2 === 0 || t3 === 0)
            continue;
        out[i] = 100 * (4 * (win(bp, i, p1) / t1) + 2 * (win(bp, i, p2) / t2) + (win(bp, i, p3) / t3)) / 7;
    }
    return out;
}
// Connors RSI (3,2,100) — single line 0..100
function calcConnorsRSICore(closes, rsiP = 3, streakP = 2, rankP = 100) {
    const n = closes.length;
    const rsi = calcRSICore(closes, rsiP);
    const streak = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        if (closes[i] > closes[i - 1])
            streak[i] = streak[i - 1] > 0 ? streak[i - 1] + 1 : 1;
        else if (closes[i] < closes[i - 1])
            streak[i] = streak[i - 1] < 0 ? streak[i - 1] - 1 : -1;
        else
            streak[i] = 0;
    }
    const streakRsi = calcRSICore(streak, streakP);
    const roc = new Array(n).fill(0);
    for (let i = 1; i < n; i++)
        roc[i] = closes[i - 1] !== 0 ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : 0;
    const out = new Array(n).fill(null);
    // From bar rankP + 1 (I1-9): the window of the PREVIOUS rankP one-bar ROCs must not include bar 0, which has none.
    for (let i = rankP + 1; i < n; i++) {
        if (rsi[i] == null || streakRsi[i] == null)
            continue;
        // Pine ta.percentrank: share of the PREVIOUS rankP one-bar ROCs that are
        // <= the current one (inclusive, so ties count).
        let cnt = 0;
        for (let k = i - rankP; k < i; k++)
            if (roc[k] <= roc[i])
                cnt++;
        out[i] = (rsi[i] + streakRsi[i] + (cnt / rankP) * 100) / 3;
    }
    return out;
}
function calcFisherCore(highs, lows, period = 9) {
    // Pine Fisher Transform: extremes of hl2 (not high/low) over the window,
    //   x    = clamp(.66 * ((hl2 - lo) / max(hi - lo, .001) - .5) + .67 * x[1])   (|x| > .99 -> +-.999)
    //   fish = .5 * ln((1 + x) / (1 - x)) + .5 * fish[1];  trigger = fish[1]
    const n = highs.length;
    const out = new Array(n).fill(null).map(() => ({ fisher: null, trigger: null }));
    const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
    const hiIdx = slidingExtremeIndex(hl2, period, 'max');
    const loIdx = slidingExtremeIndex(hl2, period, 'min');
    let x = 0, fish = 0;
    for (let i = period - 1; i < n; i++) {
        const hi = hl2[hiIdx[i]], lo = hl2[loIdx[i]];
        x = 0.66 * ((hl2[i] - lo) / Math.max(hi - lo, 0.001) - 0.5) + 0.67 * x;
        x = x > 0.99 ? 0.999 : x < -0.99 ? -0.999 : x;
        // trigger = fish[1]: none on the first Fisher bar (I1-9; it printed a made-up 0 there).
        const prev = i === period - 1 ? null : fish;
        fish = 0.5 * Math.log((1 + x) / (1 - x)) + 0.5 * fish;
        out[i] = { fisher: fish, trigger: prev };
    }
    return out;
}
// Coppock Curve — WMA(10) of ROC(14)+ROC(11)
function calcCoppockCore(closes, rocLong = 14, rocShort = 11, wmaP = 10) {
    const n = closes.length;
    const r1 = calcROCCore(closes, rocLong), r2 = calcROCCore(closes, rocShort);
    const sum = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++)
        if (r1[i] != null && r2[i] != null)
            sum[i] = r1[i] + r2[i];
    const out = new Array(n).fill(null);
    for (let i = wmaP - 1; i < n; i++) {
        let ws = 0, wd = 0, ok = true;
        for (let k = 0; k < wmaP; k++) {
            const val = sum[i - k];
            if (isNaN(val)) {
                ok = false;
                break;
            }
            const w = wmaP - k;
            ws += val * w;
            wd += w;
        }
        if (ok && wd > 0)
            out[i] = ws / wd;
    }
    return out;
}
function calcVortexCore(highs, lows, closes, period = 14) {
    const n = highs.length, out = new Array(n).fill(null).map(() => ({ plus: null, minus: null }));
    const vmP = new Array(n).fill(0), vmM = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        vmP[i] = Math.abs(highs[i] - lows[i - 1]);
        vmM[i] = Math.abs(lows[i] - highs[i - 1]);
        tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    for (let i = period; i < n; i++) {
        let sP = 0, sM = 0, sT = 0;
        for (let k = i - period + 1; k <= i; k++) {
            sP += vmP[k];
            sM += vmM[k];
            sT += tr[k];
        }
        if (sT > 0)
            out[i] = { plus: sP / sT, minus: sM / sT };
    }
    return out;
}
// Standard Deviation (20)
function calcStdDevCore(closes, period = 20) {
    return rollingMeanStd(closes, period).std; // population sigma, O(n)
}
// Mass Index (9,25)
function calcMassIndexCore(highs, lows, emaP = 9, sumP = 25) {
    const n = highs.length;
    const range = highs.map((h, i) => h - lows[i]);
    const e1 = calcEMACore(range, emaP);
    const e2 = emaOfSeries(e1, emaP); // seed on real EMA values, not zero-fill
    const ratio = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++)
        if (e1[i] != null && e2[i] != null && e2[i] !== 0)
            ratio[i] = e1[i] / e2[i];
    const out = new Array(n).fill(null);
    for (let i = sumP - 1; i < n; i++) {
        let s = 0, ok = true;
        for (let k = i - sumP + 1; k <= i; k++) {
            if (isNaN(ratio[k])) {
                ok = false;
                break;
            }
            s += ratio[k];
        }
        if (ok)
            out[i] = s;
    }
    return out;
}
function calcKSTCore(closes) {
    const n = closes.length;
    // RCMA = SMA(ROC) — null-aware so SMA windows never include fake 0% ROCs
    const rcma = (rocP, smaP) => smaOfSeries(calcROCCore(closes, rocP), smaP);
    const a = rcma(10, 10), b = rcma(15, 10), c = rcma(20, 10), d = rcma(30, 15);
    const kst = new Array(n).fill(null);
    for (let i = 0; i < n; i++)
        if (a[i] != null && b[i] != null && c[i] != null && d[i] != null)
            kst[i] = a[i] + 2 * b[i] + 3 * c[i] + 4 * d[i];
    const sig = smaOfSeries(kst, 9);
    const out = new Array(n).fill(null).map(() => ({ kst: null, signal: null }));
    for (let i = 0; i < n; i++)
        out[i] = { kst: kst[i], signal: kst[i] == null ? null : sig[i] ?? null };
    return out;
}
// Chaikin Oscillator (3,10)
function calcChaikinOscCore(highs, lows, closes, volumes, fast = 3, slow = 10) {
    const n = closes.length, adl = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const rng = highs[i] - lows[i];
        const mfm = rng > 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / rng : 0;
        adl[i] = (i > 0 ? adl[i - 1] : 0) + mfm * volumes[i];
    }
    const ef = calcEMACore(adl, fast), es = calcEMACore(adl, slow);
    const out = new Array(n).fill(null);
    for (let i = 0; i < n; i++)
        if (ef[i] != null && es[i] != null)
            out[i] = ef[i] - es[i];
    return out;
}
// Force Index (13) — EMA of (close-change × volume); bar 0 has no change,
// so it stays null and is excluded from the EMA seed.
function calcForceIndexCore(closes, volumes, period = 13) {
    const n = closes.length, raw = new Array(n).fill(null);
    for (let i = 1; i < n; i++)
        raw[i] = (closes[i] - closes[i - 1]) * volumes[i];
    return emaOfSeries(raw, period);
}
// Ease of Movement (14) — Pine: SMA(10000 * change(hl2) * (high - low) / volume, len).
// Bar 0 has no midpoint move and zero-volume bars are undefined: both are null,
// and (like ta.sma) any window containing a null is null.
function calcEOMCore(highs, lows, volumes, period = 14) {
    const n = highs.length, raw = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
        if (!(volumes[i] > 0))
            continue;
        const dm = (highs[i] + lows[i]) / 2 - (highs[i - 1] + lows[i - 1]) / 2;
        raw[i] = (10000 * dm * (highs[i] - lows[i])) / volumes[i];
    }
    return rollingMeanStrict(raw, period);
}
function calcElderRayCore(highs, lows, closes, period = 13) {
    const n = closes.length, ema = calcEMACore(closes, period);
    const out = new Array(n).fill(null).map(() => ({ bull: null, bear: null }));
    for (let i = 0; i < n; i++)
        if (ema[i] != null)
            out[i] = { bull: highs[i] - ema[i], bear: lows[i] - ema[i] };
    return out;
}
// ═══════════════════════════════════════════════════════════════
// PUBLIC EXPORTS — robust wrappers around the raw `calcXCore` maths.
// kinds: p = price series (non-finite bar -> null output, carried forward for
// later bars), v = volume series (non-finite -> 0). periods = absolute arg
// indices clamped to integers >= 1.
// ═══════════════════════════════════════════════════════════════
export const calcEMA = robustIndicator(calcEMACore, { kinds: 'p', periods: [1] });
export const calcSMA = robustIndicator(calcSMACore, { kinds: 'p', periods: [1] });
export const calcBB = robustIndicator(calcBBCore, { kinds: 'p', periods: [1] });
export const calcRSI = robustIndicator(calcRSICore, { kinds: 'p', periods: [1] });
export const calcMACD = robustIndicator(calcMACDCore, { kinds: 'p', periods: [1, 2, 3] });
export const calcStochastic = robustIndicator(calcStochasticCore, { kinds: 'ppp', periods: [3, 4] });
export const calcADX = robustIndicator(calcADXCore, { kinds: 'ppp', periods: [3] });
export const calcATR = robustIndicator(calcATRCore, { kinds: 'ppp', periods: [3] });
export const calcSuperTrend = robustIndicator(calcSuperTrendCore, { kinds: 'ppp', periods: [3], keep: ['direction'] });
export const calcDonchian = robustIndicator(calcDonchianCore, { kinds: 'pp', periods: [2] });
export const calcOBV = robustIndicator(calcOBVCore, { kinds: 'pv', nullable: false });
export const calcWilliamsR = robustIndicator(calcWilliamsRCore, { kinds: 'ppp', periods: [3] });
export const calcWMA = robustIndicator(calcWMACore, { kinds: 'p', periods: [1] });
export const calcHMA = robustIndicator(calcHMACore, { kinds: 'p', periods: [1] });
export const calcDEMA = robustIndicator(calcDEMACore, { kinds: 'p', periods: [1] });
export const calcTEMA = robustIndicator(calcTEMACore, { kinds: 'p', periods: [1] });
export const calcKeltner = robustIndicator(calcKeltnerCore, { kinds: 'ppp', periods: [3, 5] });
export const calcCMF = robustIndicator(calcCMFCore, { kinds: 'pppv', periods: [4] });
export const calcDPO = robustIndicator(calcDPOCore, { kinds: 'p', periods: [1] });
export const calcTRIX = robustIndicator(calcTRIXCore, { kinds: 'p', periods: [1] });
export const calcTSI = robustIndicator(calcTSICore, { kinds: 'p', periods: [1, 2, 3] });
export const calcPPO = robustIndicator(calcPPOCore, { kinds: 'p', periods: [1, 2, 3] });
export const calcPPOFull = robustIndicator(calcPPOFullCore, { kinds: 'p', periods: [1, 2, 3] });
export const calcCMO = robustIndicator(calcCMOCore, { kinds: 'p', periods: [1] });
export const calcAroon = robustIndicator(calcAroonCore, { kinds: 'pp', periods: [2] });
export const calcBBW = robustIndicator(calcBBWCore, { kinds: 'p', periods: [1] });
export const calcCHOP = robustIndicator(calcCHOPCore, { kinds: 'ppp', periods: [3] });
export const calcEWO = robustIndicator(calcEWOCore, { kinds: 'p', periods: [1, 2] });
export const calcSAR = robustIndicator(calcSARCore, { kinds: 'pp', whole: true });
export const calcStochRSI = robustIndicator(calcStochRSICore, { kinds: 'p', periods: [1, 2, 3, 4] });
export const calcCCI = robustIndicator(calcCCICore, { kinds: 'ppp', periods: [3] });
export const calcMFI = robustIndicator(calcMFICore, { kinds: 'pppv', periods: [4] });
export const calcROC = robustIndicator(calcROCCore, { kinds: 'p', periods: [1] });
export const calcKDJ = robustIndicator(calcKDJCore, { kinds: 'ppp', periods: [3, 4, 5] });
export const calcADLine = robustIndicator(calcADLineCore, { kinds: 'pppv' });
export const calcAO = robustIndicator(calcAOCore, { kinds: 'pp' });
// 'w': a missing volume counts as 0 for the sums but makes that candlestick's own VROC missing (B2-4).
export const calcVROC = robustIndicator(calcVROCCore, { kinds: 'w', periods: [1] });
export const calcUltimateOsc = robustIndicator(calcUltimateOscCore, { kinds: 'ppp', periods: [3, 4, 5] });
export const calcConnorsRSI = robustIndicator(calcConnorsRSICore, { kinds: 'p', periods: [1, 2, 3] });
export const calcFisher = robustIndicator(calcFisherCore, { kinds: 'pp', periods: [2] });
export const calcCoppock = robustIndicator(calcCoppockCore, { kinds: 'p', periods: [1, 2, 3] });
export const calcVortex = robustIndicator(calcVortexCore, { kinds: 'ppp', periods: [3] });
export const calcStdDev = robustIndicator(calcStdDevCore, { kinds: 'p', periods: [1] });
export const calcMassIndex = robustIndicator(calcMassIndexCore, { kinds: 'pp', periods: [2, 3] });
export const calcKST = robustIndicator(calcKSTCore, { kinds: 'p' });
export const calcChaikinOsc = robustIndicator(calcChaikinOscCore, { kinds: 'pppv', periods: [4, 5] });
export const calcForceIndex = robustIndicator(calcForceIndexCore, { kinds: 'pv', periods: [2] });
export const calcEOM = robustIndicator(calcEOMCore, { kinds: 'ppv', periods: [3] });
export const calcElderRay = robustIndicator(calcElderRayCore, { kinds: 'ppp', periods: [3] });
