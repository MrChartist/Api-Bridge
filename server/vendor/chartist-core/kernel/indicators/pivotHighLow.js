import { clampLength, isFiniteNumber } from './priceBarGuards.js';
const PIVOT_HL_DEFAULTS = { left: 10, right: 10 };
function isPivot(values, i, left, right, kind) {
    const centre = values[i];
    if (!isFiniteNumber(centre))
        return false;
    for (let j = i - left; j <= i + right; j++) {
        const v = values[j];
        if (!isFiniteNumber(v))
            return false;
        if (kind === 'high' ? v > centre : v < centre)
            return false;
    }
    return true;
}
export function calcPivotHL(candles, opts = {}) {
    const left = clampLength(opts.left ?? PIVOT_HL_DEFAULTS.left, PIVOT_HL_DEFAULTS.left, 0);
    const right = clampLength(opts.right ?? PIVOT_HL_DEFAULTS.right, PIVOT_HL_DEFAULTS.right, 0);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const out = candles.map(() => ({ high: null, low: null, confirmedAt: null }));
    for (let i = left; i + right < candles.length; i++) {
        const isHigh = isPivot(highs, i, left, right, 'high');
        const isLow = isPivot(lows, i, left, right, 'low');
        if (!isHigh && !isLow)
            continue;
        out[i] = {
            high: isHigh ? highs[i] : null,
            low: isLow ? lows[i] : null,
            confirmedAt: i + right,
        };
    }
    return out;
}
/**
 * Re-key `calcPivotHL` output onto the confirmation bar (Pine's own timing:
 * `ta.pivothigh` returns the pivot `right` bars late). Use this when an alert or
 * signal must fire only on the bar that could actually have known about it.
 */
export function pivotsAtConfirmation(points) {
    const out = points.map(() => ({ high: null, highIndex: null, low: null, lowIndex: null }));
    points.forEach((p, i) => {
        if (p.confirmedAt === null || p.confirmedAt >= out.length)
            return;
        const slot = out[p.confirmedAt];
        if (p.high !== null) {
            slot.high = p.high;
            slot.highIndex = i;
        }
        if (p.low !== null) {
            slot.low = p.low;
            slot.lowIndex = i;
        }
    });
    return out;
}
