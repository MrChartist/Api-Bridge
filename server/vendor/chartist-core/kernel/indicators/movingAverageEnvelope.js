/** Moving-average envelope: a percentage band around a moving average. */
import { maByType } from './maByType.js';
import { clampLength, finiteOr } from './seriesMath.js';
/** mid = MA(type, length); upper/lower = mid * (1 +/- pct / 100). */
export function calcEnvelope(values, length = 20, pct = 10, maType = 'sma', volume) {
    const mid = maByType(maType, values, clampLength(length, 20), volume);
    const f = finiteOr(pct, 10) / 100;
    return mid.map(m => m === null ? { upper: null, mid: null, lower: null } : { upper: m * (1 + f), mid: m, lower: m * (1 - f) });
}
