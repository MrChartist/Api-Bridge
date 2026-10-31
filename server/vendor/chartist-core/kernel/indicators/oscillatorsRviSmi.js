import { clampLength, emaN, highestN, lowestN, nanSeries, smaN, swmaN, toNums, } from './seriesMath.js';
/**
 * RVI = SMA(swma(close - open), length) / SMA(swma(high - low), length);
 * signal = swma(RVI) (weights 1-2-2-1). First RVI on bar `length + 2`,
 * signal three bars later.
 */
export function calcRVI(candles, length = 10) {
    const len = clampLength(length, 10);
    const body = toNums(candles.map(c => c.close - c.open));
    const range = toNums(candles.map(c => c.high - c.low));
    const num = smaN(swmaN(body), len);
    const den = smaN(swmaN(range), len);
    const rvi = num.map((v, i) => (den[i] !== 0 ? v / den[i] : NaN));
    const signal = swmaN(rvi);
    return rvi.map((v, i) => ({
        rvi: Number.isFinite(v) ? v : null,
        signal: Number.isFinite(signal[i]) ? signal[i] : null,
    }));
}
/**
 * Stochastic Momentum Index (reference-platform definition):
 *   rel  = close - (highest(high,k) + lowest(low,k)) / 2
 *   diff = highest(high,k) - lowest(low,k)
 *   smi  = 100 * EMA(EMA(rel,d),d) / (EMA(EMA(diff,d),d) / 2)
 *   ema  = EMA(smi, emaLength)
 * A zero smoothed range gives null. Range about -100..100.
 */
export function calcSMI(highs, lows, closes, kLength = 10, dLength = 3, emaLength = 3) {
    const h = toNums(highs);
    const l = toNums(lows);
    const c = toNums(closes);
    const k = clampLength(kLength, 10);
    const d = clampLength(dLength, 3);
    const hh = highestN(h, k);
    const ll = lowestN(l, k);
    const rel = nanSeries(c.length);
    const diff = nanSeries(c.length);
    for (let i = 0; i < c.length; i++) {
        rel[i] = c[i] - (hh[i] + ll[i]) / 2;
        diff[i] = hh[i] - ll[i];
    }
    const avgRel = emaN(emaN(rel, d), d);
    const avgDiff = emaN(emaN(diff, d), d);
    const smi = avgRel.map((v, i) => (avgDiff[i] !== 0 ? (100 * v) / (avgDiff[i] / 2) : NaN));
    const signal = emaN(smi, clampLength(emaLength, 3));
    return smi.map((v, i) => ({
        smi: Number.isFinite(v) ? v : null,
        ema: Number.isFinite(signal[i]) ? signal[i] : null,
    }));
}
