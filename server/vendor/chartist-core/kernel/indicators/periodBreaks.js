import { isIntradaySeries, periodKey } from './anchorKeys.js';
/** `flags[i]` is true when bar `i` opens a period different from bar `i - 1`'s. */
export function periodBreakFlags(candles, anchor) {
    const flags = new Array(candles.length).fill(false);
    if (anchor === 'none' || candles.length < 2)
        return flags;
    if (anchor === 'session' && !isIntradaySeries(candles))
        return flags;
    let previous = null;
    for (let i = 0; i < candles.length; i++) {
        const t = candles[i].date;
        if (!Number.isFinite(t))
            continue;
        const key = periodKey(anchor, t);
        if (previous !== null && key !== previous)
            flags[i] = true;
        previous = key;
    }
    return flags;
}
