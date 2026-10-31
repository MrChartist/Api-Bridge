/**
 * Extra volatility studies: Bollinger %B, Historical Volatility, Ulcer Index
 * and Average Daily Range. Aligned 1:1 with the input, null warm-up.
 */
import { clampLength, finiteOr, fromNums, highestN, nanSeries, smaN, stdevN, toNums, } from './seriesMath.js';
/**
 * Bollinger %B = (close - lower) / (upper - lower), bands = SMA(length) +/-
 * mult * population stdev. Unbounded like the reference platform (below 0 / above 1 when
 * price is outside the bands). Zero-width bands (flat price) give null.
 */
export function calcPercentB(closes, length = 20, mult = 2) {
    const src = toNums(closes);
    const len = clampLength(length, 20);
    const m = finiteOr(mult, 2);
    const basis = smaN(src, len);
    const dev = stdevN(src, len);
    const out = nanSeries(src.length);
    for (let i = 0; i < src.length; i++) {
        const width = 2 * m * dev[i];
        // Flat price: rounding noise leaves a ~1e-13 width, which would give a bogus %B; treat as zero width.
        if (!(width > 1e-9 * Math.abs(basis[i])))
            continue;
        const v = (src[i] - (basis[i] - m * dev[i])) / width;
        if (Number.isFinite(v))
            out[i] = v;
    }
    return fromNums(out);
}
/**
 * Historical volatility in percent: 100 * stdev(ln(close / close[1]), length)
 * * sqrt(annualisation). The stdev is the population one (`ta.stdev`).
 * First value on bar `length` (log returns start on bar 1).
 */
export function calcHistoricalVol(closes, length = 10, annualisation = 252) {
    const src = toNums(closes);
    const len = clampLength(length, 10);
    const ann = finiteOr(annualisation, 252) > 0 ? finiteOr(annualisation, 252) : 252;
    const logRet = nanSeries(src.length);
    for (let i = 1; i < src.length; i++) {
        const r = Math.log(src[i] / src[i - 1]);
        if (Number.isFinite(r))
            logRet[i] = r;
    }
    const sd = stdevN(logRet, len);
    return fromNums(sd.map(v => 100 * v * Math.sqrt(ann)));
}
/**
 * Ulcer Index: sqrt(SMA(drawdown^2, length)) where drawdown is the percent
 * distance of the close below the highest close of the last `length` bars.
 * First value on bar `2 * length - 2`.
 */
export function calcUlcerIndex(closes, length = 14) {
    const src = toNums(closes);
    const len = clampLength(length, 14);
    const peak = highestN(src, len);
    const dd2 = nanSeries(src.length);
    for (let i = 0; i < src.length; i++) {
        if (!(peak[i] > 0))
            continue;
        const d = (100 * (src[i] - peak[i])) / peak[i];
        if (Number.isFinite(d))
            dd2[i] = d * d;
    }
    return fromNums(smaN(dd2, len).map(Math.sqrt));
}
/** Average Daily Range: SMA(high - low, length) on the chart's own bars. */
export function calcADR(highs, lows, length = 14) {
    const h = toNums(highs);
    const l = toNums(lows);
    const range = h.map((v, i) => v - l[i]);
    return fromNums(smaN(range, clampLength(length, 14)));
}
/** ADR as a percentage: 100 * (SMA(high / low, length) - 1). Needs positive lows. */
export function calcADRPercent(highs, lows, length = 14) {
    const h = toNums(highs);
    const l = toNums(lows);
    const ratio = h.map((v, i) => (l[i] > 0 ? v / l[i] : NaN));
    return fromNums(smaN(ratio, clampLength(length, 14)).map(v => 100 * (v - 1)));
}
