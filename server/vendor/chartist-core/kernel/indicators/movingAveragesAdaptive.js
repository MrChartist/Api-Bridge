/**
 * Adaptive moving averages: Kaufman's KAMA and McGinley Dynamic. Both react
 * faster when price trends and slower when it chops.
 */
import { clampLength, finiteOr, fromNums, nanSeries, recursiveN, toNums, } from './seriesMath.js';
/**
 * Kaufman Adaptive MA. Efficiency ratio ER = |close - close[er]| / sum of the
 * last `er` absolute bar changes; smoothing constant
 * sc = (ER * (2/(fast+1) - 2/(slow+1)) + 2/(slow+1))^2;
 * kama = kama[1] + sc * (src - kama[1]).
 * First value on bar `er`, seeded with the previous bar's source.
 */
export function calcKAMA(values, er = 10, fast = 2, slow = 30) {
    const src = toNums(values);
    const len = clampLength(er, 10);
    const fastAlpha = 2 / (clampLength(fast, 2) + 1);
    const slowAlpha = 2 / (clampLength(slow, 30) + 1);
    const out = nanSeries(src.length);
    let prev = NaN;
    for (let i = len; i < src.length; i++) {
        let path = 0;
        for (let j = i - len + 1; j <= i; j++)
            path += Math.abs(src[j] - src[j - 1]);
        if (!Number.isFinite(path)) {
            prev = NaN;
            continue;
        }
        const ratio = path === 0 ? 0 : Math.abs(src[i] - src[i - len]) / path;
        const sc = (ratio * (fastAlpha - slowAlpha) + slowAlpha) ** 2;
        if (Number.isNaN(prev))
            prev = src[i - 1];
        prev = prev + sc * (src[i] - prev);
        out[i] = prev;
    }
    return fromNums(out);
}
/**
 * McGinley Dynamic: md = md[1] + (src - md[1]) / (k * length * (src / md[1])^4).
 * Seeded with the SMA of the first `length` bars (the same seed as calcEMA).
 *
 * Gap guard (I1-5, 2026-10-26): the divisor is held at 1 or more, so one step never carries the line past the source
 * (|step| <= |src - md[1]|). After a fall of about 40% or more the raw divisor goes far below 1 and the line used to
 * overshoot to about -1e97 and then freeze there for good (the divisor underflowed to 0 and the old guard held that
 * value). With the guard the line moves onto the source on such a bar and carries on from there. On ordinary data the
 * divisor is far above 1 (k * length = 8.4 at the defaults), so nothing else changes. A non-finite step (missing
 * source, zero or missing previous value) re-seeds the line at the source.
 */
export function calcMcGinley(values, length = 14, k = 0.6) {
    const src = toNums(values);
    const len = clampLength(length, 14);
    const factor = finiteOr(k, 0.6) > 0 ? finiteOr(k, 0.6) : 0.6;
    const out = recursiveN(src, len, (prev, v) => {
        const divisor = factor * len * Math.pow(v / prev, 4);
        if (!Number.isFinite(divisor))
            return v;
        return prev + (v - prev) / Math.max(1, divisor);
    });
    return fromNums(out);
}
