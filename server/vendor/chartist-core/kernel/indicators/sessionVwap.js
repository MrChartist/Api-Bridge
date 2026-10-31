import { isFiniteNumber } from './priceBarGuards.js';
import { isIntradaySeries, periodKey } from './anchorKeys.js';
import { createVwapAccumulator, emptyVwapPoint, resolveBandMultipliers, vwapSourcePrice, } from './vwapAccumulator.js';
/**
 * False where the 'session' anchor is not meaningful: daily+ series, and (B7, 2026-10-17) any series in which
 * every session holds a single bar. A session VWAP resets at each session, so with one bar per session it resets
 * on EVERY bar and just repeats that bar's typical price, a meaningless line that looks like the close. That is
 * what a daily series stamped inside the session window (a feed that stamps daily bars at 09:15 IST, say) or an
 * interval as long as the session (a custom 8h bar on a 375-minute NSE day) produced, because they pass the
 * intraday test. They now take the daily path: the classic study accumulates over the loaded bars, Session VWAP
 * falls back to the month, Anchored VWAP to the highest high, as on any daily chart.
 *
 * One bar alone still counts as supported, so a live intraday series does not flip at its first tick. A series
 * whose history starts on a session's LAST bar reads as unsupported for the one bar until the next session has two
 * bars (Needs verification: whether any loaded window starts that way; the gateway serves whole sessions).
 */
export function vwapSessionSupported(candles) {
    if (!isIntradaySeries(candles))
        return false;
    let finite = 0;
    let previousKey = null;
    for (const c of candles) {
        if (!isFiniteNumber(c.date))
            continue;
        finite++;
        const key = periodKey('session', c.date);
        if (key === previousKey)
            return true;
        previousKey = key;
    }
    return finite <= 1;
}
export function vwapWithAnchor(candles, opts = {}) {
    const anchor = opts.anchor ?? 'session';
    const source = opts.source ?? 'hlc3';
    const mults = resolveBandMultipliers(opts.bandMultipliers);
    if (anchor === 'session' && !vwapSessionSupported(candles))
        return candles.map(emptyVwapPoint);
    const acc = createVwapAccumulator();
    let currentKey = null;
    return candles.map(c => {
        if (!isFiniteNumber(c.date))
            return emptyVwapPoint();
        if (anchor !== 'none') {
            const key = periodKey(anchor, c.date);
            if (key !== currentKey) {
                acc.reset();
                currentKey = key;
            }
        }
        const price = vwapSourcePrice(c, source);
        if (!isFiniteNumber(price) || !isFiniteNumber(c.volume))
            return emptyVwapPoint();
        acc.add(price, c.volume);
        return acc.read(mults);
    });
}
