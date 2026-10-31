/**
 * applySmoothing: the reference platform's oscillator "Smoothing" block. Adds a moving
 * average (any MaType) and optional Bollinger-style bands to any indicator
 * series, null prefix and all.
 */
import { maByType } from './maByType.js';
import { clampLength, finiteOr, fromNums, stdevN, toNums, } from './seriesMath.js';
/**
 * ma = MA(type, length) of the series; with bbMult > 0, upper/lower =
 * ma +/- bbMult * population stdev of the series over the same length.
 * Warm-up counts from the series' own first value, so a series that already
 * has a null prefix (RSI, MACD, ...) stays honest.
 */
export function applySmoothing(series, options = {}) {
    const src = toNums(series);
    const length = clampLength(options.length, 14);
    const ma = maByType(options.type ?? 'sma', src, length, options.volume);
    const mult = finiteOr(options.bbMult, 0);
    if (!(mult > 0)) {
        const none = src.map(() => null);
        return { ma, upper: none, lower: none };
    }
    const dev = stdevN(src, length);
    const band = (sign) => fromNums(ma.map((m, i) => (m === null ? NaN : m + sign * mult * dev[i])));
    return { ma, upper: band(1), lower: band(-1) };
}
