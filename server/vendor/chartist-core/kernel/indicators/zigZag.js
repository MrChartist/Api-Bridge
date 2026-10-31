import { isFiniteNumber } from './priceBarGuards.js';
import { calcPivotHL } from './pivotHighLow.js';
const ZIGZAG_DEFAULTS = { deviation: 5, legs: 10 };
function resolve(opts) {
    const deviation = isFiniteNumber(opts.deviation) && opts.deviation >= 0 ? opts.deviation : ZIGZAG_DEFAULTS.deviation;
    const legs = isFiniteNumber(opts.legs) ? Math.max(1, Math.floor(opts.legs)) : ZIGZAG_DEFAULTS.legs;
    return { deviation, legs };
}
function movePct(from, to) {
    return from === 0 ? Infinity : (Math.abs(to - from) / Math.abs(from)) * 100;
}
export function calcZigZagConfirmed(candles, opts = {}) {
    const { deviation, legs } = resolve(opts);
    const pivots = calcPivotHL(candles, { left: legs, right: legs });
    const points = [];
    const consider = (index, price, kind, confirmedAt) => {
        const last = points[points.length - 1];
        const point = { index, price, kind, provisional: false, confirmedAt };
        if (!last) {
            points.push(point);
            return;
        }
        if (last.index === index)
            return; // an outside bar is both a pivot high and low: keep one vertical leg
        if (last.kind === kind) {
            if (kind === 'high' ? price > last.price : price < last.price)
                points[points.length - 1] = point;
            return;
        }
        const rightSide = kind === 'high' ? price > last.price : price < last.price;
        if (rightSide && movePct(last.price, price) >= deviation)
            points.push(point);
    };
    pivots.forEach((p, i) => {
        if (p.confirmedAt === null)
            return;
        // An outside bar can be both; try the side that continues from the last point first.
        const lowFirst = points[points.length - 1]?.kind === 'high';
        if (lowFirst && p.low !== null)
            consider(i, p.low, 'low', p.confirmedAt);
        if (p.high !== null)
            consider(i, p.high, 'high', p.confirmedAt);
        if (!lowFirst && p.low !== null)
            consider(i, p.low, 'low', p.confirmedAt);
    });
    return points;
}
/** Running extreme of `kind` strictly after `after`; first occurrence wins ties. */
function tailExtreme(candles, after, kind) {
    let best = null;
    for (let i = after + 1; i < candles.length; i++) {
        const v = kind === 'high' ? candles[i].high : candles[i].low;
        if (!isFiniteNumber(v))
            continue;
        if (best === null || (kind === 'high' ? v > best.price : v < best.price))
            best = { index: i, price: v };
    }
    return best;
}
export function calcZigZag(candles, opts = {}) {
    const { deviation } = resolve(opts);
    const points = calcZigZagConfirmed(candles, opts);
    const last = points[points.length - 1];
    if (!last)
        return points;
    const sameKind = tailExtreme(candles, last.index, last.kind);
    const displaces = sameKind !== null && (last.kind === 'high' ? sameKind.price > last.price : sameKind.price < last.price);
    if (displaces && sameKind) {
        points.pop();
        points.push({ ...sameKind, kind: last.kind, provisional: true, confirmedAt: null, replacesIndex: last.index });
        return points;
    }
    const otherKind = last.kind === 'high' ? 'low' : 'high';
    const opposite = tailExtreme(candles, last.index, otherKind);
    if (opposite && movePct(last.price, opposite.price) >= deviation) {
        points.push({ ...opposite, kind: otherKind, provisional: true, confirmedAt: null });
    }
    return points;
}
