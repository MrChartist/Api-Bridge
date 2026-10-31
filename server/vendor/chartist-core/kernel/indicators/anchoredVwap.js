import { clampLength, isFiniteNumber } from './priceBarGuards.js';
import { periodKey } from './anchorKeys.js';
import { createVwapAccumulator, emptyVwapPoint, resolveBandMultipliers, vwapSourcePrice, } from './vwapAccumulator.js';
const ANCHORED_VWAP_DEFAULT_LOOKBACK = 50;
function periodAnchorIndex(candles, anchor, periodsBack) {
    const back = Math.max(0, Math.floor(periodsBack));
    let end = candles.length - 1;
    for (let step = 0;; step++) {
        if (end < 0 || !isFiniteNumber(candles[end].date))
            return null;
        const key = periodKey(anchor, candles[end].date);
        let start = end;
        while (start > 0 && isFiniteNumber(candles[start - 1].date) && periodKey(anchor, candles[start - 1].date) === key)
            start--;
        if (step === back)
            return start;
        end = start - 1;
    }
}
function extremeAnchorIndex(candles, anchor, lookback) {
    const from = Math.max(0, candles.length - lookback);
    let best = null;
    let bestVal = 0;
    for (let i = from; i < candles.length; i++) {
        const v = anchor === 'highestHigh' ? candles[i].high : anchor === 'lowestLow' ? candles[i].low : candles[i].volume;
        if (!isFiniteNumber(v))
            continue;
        const better = best === null || (anchor === 'lowestLow' ? v <= bestVal : v >= bestVal);
        if (better) {
            best = i;
            bestVal = v;
        }
    }
    return best;
}
function resolveAnchorIndex(candles, opts = {}) {
    const anchor = opts.anchor ?? 'session';
    if (candles.length === 0)
        return null;
    switch (anchor) {
        case 'customIndex':
            return isFiniteNumber(opts.customIndex) ? Math.min(candles.length - 1, Math.max(0, Math.floor(opts.customIndex))) : null;
        case 'highestHigh':
        case 'lowestLow':
        case 'highestVolume':
            return extremeAnchorIndex(candles, anchor, clampLength(opts.lookback ?? ANCHORED_VWAP_DEFAULT_LOOKBACK, ANCHORED_VWAP_DEFAULT_LOOKBACK));
        default:
            return periodAnchorIndex(candles, anchor, opts.periodsBack ?? 0);
    }
}
export function calcAnchoredVwap(candles, opts = {}) {
    const source = opts.source ?? 'hlc3';
    const mults = resolveBandMultipliers(opts.bandMultipliers);
    const anchorIndex = resolveAnchorIndex(candles, opts);
    const provisional = (opts.anchor ?? 'session') !== 'customIndex';
    const points = candles.map(emptyVwapPoint);
    if (anchorIndex === null)
        return { points, anchorIndex, provisional };
    const acc = createVwapAccumulator();
    for (let i = anchorIndex; i < candles.length; i++) {
        const c = candles[i];
        const price = vwapSourcePrice(c, source);
        if (!isFiniteNumber(price) || !isFiniteNumber(c.volume))
            continue;
        acc.add(price, c.volume);
        points[i] = acc.read(mults);
    }
    return { points, anchorIndex, provisional };
}
