import { periodKey } from './anchorKeys.js';
import { levelAnchor } from './periodLevels.js';
import { calcPivotPoints } from './classic.js';
import { isFiniteNumber } from './priceBarGuards.js';
/**
 * The period the pivots come from, by bar spacing (2026-10-26): intraday bars use the previous session, daily bars
 * the previous week, weekly bars the previous month, monthly bars the previous year. Before, every daily-or-higher
 * series used the week (a weekly chart's pivots were just the previous bar's), and Indian daily bars stamped 09:15 IST
 * were read as intraday, so a daily chart used the previous DAY (I1-1).
 */
export function defaultPivotAnchor(candles) {
    return levelAnchor(candles, 'auto');
}
export function previousPeriodHLC(candles, endExclusive = candles.length, anchor = defaultPivotAnchor(candles)) {
    const last = Math.min(endExclusive, candles.length) - 1;
    if (last < 0 || !Number.isFinite(candles[last].date))
        return null;
    const currentKey = periodKey(anchor, candles[last].date);
    let i = last;
    while (i >= 0 && (!Number.isFinite(candles[i].date) || periodKey(anchor, candles[i].date) === currentKey))
        i--;
    return i < 0 ? null : periodHLCEndingAt(candles, i, anchor);
}
/** High, low and last close of the period whose last bar is `end`, walking back while bars share its key. */
function periodHLCEndingAt(candles, end, anchor) {
    const prevKey = periodKey(anchor, candles[end].date);
    let high = -Infinity, low = Infinity, close = null;
    for (let i = end; i >= 0 && Number.isFinite(candles[i].date) && periodKey(anchor, candles[i].date) === prevKey; i--) {
        const c = candles[i];
        if (isFiniteNumber(c.high))
            high = Math.max(high, c.high);
        if (isFiniteNumber(c.low))
            low = Math.min(low, c.low);
        if (close === null && isFiniteNumber(c.close))
            close = c.close;
    }
    return close !== null && Number.isFinite(high) && Number.isFinite(low) ? { high, low, close } : null;
}
/**
 * Pivot levels per bar, STEPPED by period (B3, 2026-10-17): bar `i` carries the floor-trader levels of the last
 * completed period before its own (`previousPeriodHLC(candles, i + 1, anchor)`, exactly). Every bar of today's
 * session shows yesterday's levels; the levels change only on the first bar of a new period, and never use the
 * period the bar is in, so today's own high and low cannot move today's pivots (no look-ahead). Appending bars
 * never changes an earlier value. Null before the first completed period and on a bar with no usable time stamp.
 *
 * One pass: the previous period's high/low/close is aggregated once per period, not once per bar, so years of
 * one-minute bars cost the same as one `previousPeriodHLC` call per period. Bars of one period share one result
 * object; treat it as read-only.
 */
export function steppedPivotPoints(candles, anchor = defaultPivotAnchor(candles)) {
    const out = new Array(candles.length).fill(null);
    let lastFinite = -1;
    let lastKey = null;
    let prevEnd = -1;
    let memoEnd = -2;
    let memo = null;
    for (let i = 0; i < candles.length; i++) {
        const t = candles[i].date;
        if (!Number.isFinite(t))
            continue;
        const key = periodKey(anchor, t);
        // A new period starts here: the period before it ends at the previous bar with a time stamp.
        if (key !== lastKey)
            prevEnd = lastFinite;
        lastFinite = i;
        lastKey = key;
        if (prevEnd < 0)
            continue;
        if (prevEnd !== memoEnd) {
            memoEnd = prevEnd;
            const hlc = periodHLCEndingAt(candles, prevEnd, anchor);
            memo = hlc ? calcPivotPoints(hlc.high, hlc.low, hlc.close) : null;
        }
        out[i] = memo;
    }
    return out;
}
