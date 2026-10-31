/**
 * Extra moving averages with Pine semantics: RMA (Wilder), VWMA, LSMA
 * (`ta.linreg`) and ALMA. Each returns a series aligned 1:1 with the input,
 * null across the warm-up prefix.
 */
import { clampLength, finiteOr, fromNums, nanSeries, rmaN, toNums, } from './seriesMath.js';
/** Wilder / SMMA moving average (`ta.rma`). First value on bar `length - 1`. */
export function calcRMA(values, length = 7) {
    return fromNums(rmaN(toNums(values), clampLength(length, 7)));
}
/** Volume-weighted MA: sum(src * volume) / sum(volume). Zero volume gives null. */
export function calcVWMA(values, volumes, length = 20) {
    const src = toNums(values);
    const vol = toNums(volumes);
    const len = clampLength(length, 20);
    const out = nanSeries(src.length);
    for (let i = len - 1; i < src.length; i++) {
        let pv = 0;
        let v = 0;
        for (let j = i - len + 1; j <= i; j++) {
            pv += src[j] * vol[j];
            v += vol[j];
        }
        if (Number.isFinite(pv) && Number.isFinite(v) && v !== 0)
            out[i] = pv / v;
    }
    return fromNums(out);
}
/**
 * Least-squares moving average: the regression line fitted through the last
 * `length` bars, read `offset` bars back from the newest (`ta.linreg`).
 * A length of 1 has no slope and returns the source itself.
 */
export function calcLSMA(values, length = 25, offset = 0) {
    const src = toNums(values);
    const len = clampLength(length, 25);
    const off = finiteOr(offset, 0);
    const out = nanSeries(src.length);
    if (len > src.length)
        return fromNums(out); // never build a window the series cannot fill
    const mid = (len - 1) / 2;
    let sxx = 0;
    for (let j = 0; j < len; j++)
        sxx += (j - mid) ** 2;
    for (let i = len - 1; i < src.length; i++) {
        let sum = 0;
        let sxy = 0;
        for (let j = 0; j < len; j++) {
            const y = src[i - len + 1 + j];
            sum += y;
            sxy += (j - mid) * y;
        }
        const slope = sxx === 0 ? 0 : sxy / sxx;
        const v = sum / len + slope * (len - 1 - off - mid);
        if (Number.isFinite(v))
            out[i] = v;
    }
    return fromNums(out);
}
/**
 * Arnaud Legoux MA (`ta.alma`): a Gaussian-weighted window whose peak sits at
 * `floor(offset * (span - 1))` (0 = oldest bar, span - 1 = newest).
 */
export function calcALMA(values, span = 9, offset = 0.85, sigma = 6) {
    const src = toNums(values);
    const len = clampLength(span, 9);
    const off = finiteOr(offset, 0.85);
    const sg = finiteOr(sigma, 6) > 0 ? finiteOr(sigma, 6) : 6;
    if (len > src.length)
        return src.map(() => null); // no full window: skip the weight table
    const m = Math.floor(off * (len - 1));
    const s = len / sg;
    const weights = [];
    let norm = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
        weights.push(w);
        norm += w;
    }
    const out = nanSeries(src.length);
    for (let i = len - 1; i < src.length; i++) {
        let sum = 0;
        for (let j = 0; j < len; j++)
            sum += src[i - len + 1 + j] * weights[j];
        const v = sum / norm;
        if (Number.isFinite(v))
            out[i] = v;
    }
    return fromNums(out);
}
