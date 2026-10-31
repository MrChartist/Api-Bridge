// The range of a setting made with input(): shared by the checker and the lowering so they agree.
/** Largest history a value may need, in daily candlesticks (also the checker's limit). */
const LONGEST = 2_500;
/**
 * Range of a whole-number setting when the script gives no min/max: from 1 (or the default, if lower)
 * up to the larger of 500 and five times the default, never above 2500 (and never below the default).
 * Reason: a setting used as a length must be provably inside the allowed range, and two stacked
 * averages must still fit the 5,000-candlestick history limit.
 */
export function defaultIntRange(value) {
    return { lo: Math.min(1, value), hi: Math.max(value, Math.min(LONGEST, Math.max(500, 5 * value))) };
}
/** Effective range of a setting: explicit min/max win; whole numbers get the default range; decimals stay open. */
export function settingRange(type, value, min, max) {
    if (type !== 'int' && type !== 'float')
        return {};
    const d = type === 'int' && typeof value === 'number' ? defaultIntRange(value) : undefined;
    const out = {};
    const lo = min ?? d?.lo;
    const hi = max ?? d?.hi;
    if (lo !== undefined)
        out.lo = lo;
    if (hi !== undefined)
        out.hi = hi;
    return out;
}
