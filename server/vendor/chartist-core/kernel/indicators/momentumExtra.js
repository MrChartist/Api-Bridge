import { changeN, clampLength, fromNums, nanSeries, smaN, toNums, } from './seriesMath.js';
/** Momentum = close - close[length]. First value on bar `length`. */
export function calcMomentum(closes, length = 10) {
    return fromNums(changeN(toNums(closes), clampLength(length, 10)));
}
/**
 * Aroon Oscillator = Aroon Up - Aroon Down (range -100..100), where
 * up = 100 * (length - barsSinceHighestHigh) / length over the last
 * `length + 1` bars (ties resolve to the most recent bar).
 */
export function calcAroonOsc(highs, lows, length = 14) {
    const h = toNums(highs);
    const l = toNums(lows);
    const len = clampLength(length, 14);
    const out = nanSeries(h.length);
    for (let i = len; i < h.length; i++) {
        let hiIdx = i;
        let loIdx = i;
        let ok = true;
        for (let j = i - len; j <= i; j++) {
            if (!Number.isFinite(h[j]) || !Number.isFinite(l[j])) {
                ok = false;
                break;
            }
            if (h[j] >= h[hiIdx])
                hiIdx = j;
            if (l[j] <= l[loIdx])
                loIdx = j;
        }
        if (ok)
            out[i] = (100 * ((i - loIdx) - (i - hiIdx))) / len;
    }
    return fromNums(out);
}
/**
 * Balance of Power = (close - open) / (high - low), optionally smoothed with
 * an SMA. `smooth <= 1` returns the raw value. A zero-range bar has no
 * defined value (null, and it blanks any smoothing window it sits in).
 */
export function calcBOP(candles, smooth = 14) {
    const raw = nanSeries(candles.length);
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const range = c.high - c.low;
        const v = range !== 0 ? (c.close - c.open) / range : NaN;
        if (Number.isFinite(v))
            raw[i] = v;
    }
    const len = clampLength(smooth, 14);
    return fromNums(len <= 1 ? raw : smaN(raw, len));
}
