/**
 * maByType: one entry point for the "MA type" input every smoothing block and
 * Source/MA-type setting needs. Aligned 1:1 with the input, null warm-up.
 */
import { clampLength, emaN, fromNums, rmaN, smaN, toNums, wmaN, } from './seriesMath.js';
import { calcVWMA } from './movingAveragesBasic.js';
const MA_TYPES = ['sma', 'ema', 'rma', 'wma', 'vwma', 'hma'];
export function isMaType(value) {
    return typeof value === 'string' && MA_TYPES.includes(value);
}
/** Hull MA on a NaN-encoded series: WMA(2*WMA(floor(n/2)) - WMA(n), round(sqrt(n))) (Pine / chart HMA). */
function hmaN(x, length) {
    const half = Math.max(1, Math.floor(length / 2));
    const root = Math.max(1, Math.round(Math.sqrt(length)));
    const a = wmaN(x, half);
    const b = wmaN(x, length);
    return wmaN(a.map((v, i) => 2 * v - b[i]), root);
}
/**
 * Moving average of `values` by name. Unknown types fall back to SMA. `vwma`
 * needs `volume`; without it the result is all null (undefined, not zero).
 */
export function maByType(type, values, length, volume) {
    const src = toNums(values);
    const len = clampLength(length, 14);
    switch (type) {
        case 'ema': return fromNums(emaN(src, len));
        case 'rma': return fromNums(rmaN(src, len));
        case 'wma': return fromNums(wmaN(src, len));
        case 'hma': return fromNums(hmaN(src, len));
        case 'vwma': return volume ? calcVWMA(values, volume, len) : src.map(() => null);
        default: return fromNums(smaN(src, len));
    }
}
