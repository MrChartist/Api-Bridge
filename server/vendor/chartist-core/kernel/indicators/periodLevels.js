import { istMinuteOfDay, sessionOpenMinute } from '../exchangeTime.js';
import { periodKey, seriesSpacing } from './anchorKeys.js';
import { isFiniteNumber } from './priceBarGuards.js';
export const LEVEL_TIMEFRAMES = ['auto', 'D', 'W', 'M', 'Y'];
export const PIVOT_KINDS = ['classic', 'fibonacci', 'woodie', 'camarilla'];
/** The calendar anchor a timeframe setting resolves to on this series. */
export function levelAnchor(candles, timeframe = 'auto') {
    switch (timeframe) {
        case 'D': return 'session';
        case 'W': return 'week';
        case 'M': return 'month';
        case 'Y': return 'year';
        default: {
            const s = seriesSpacing(candles);
            return s === 'intraday' ? 'session' : s === 'daily' ? 'week' : s === 'weekly' ? 'month' : 'year';
        }
    }
}
/**
 * Floor-trader levels from one period's high, low and close.
 * - Classic (traditional): PP = (H+L+C)/3, R1 = 2PP-L, S1 = 2PP-H, R2 = PP+(H-L), S2 = PP-(H-L), R3 = 2PP+(H-2L),
 *   S3 = 2PP-(2H-L) (identical to `calcPivotPoints`).
 * - Fibonacci: PP as classic; R/S n = PP +/- {0.382, 0.618, 1.000} x (H-L).
 * - Woodie: PP = (H+L+2C)/4; R1 = 2PP-L, S1 = 2PP-H, R2 = PP+(H-L), S2 = PP-(H-L), R3 = H+2(PP-L), S3 = L-2(H-PP),
 *   R4 = R3+(H-L), S4 = S3-(H-L).
 * - Camarilla: PP as classic; R/S n = C +/- (H-L) x 1.1 / {12, 6, 4, 2}.
 */
export function pivotLevelsFor(kind, h) {
    const { high: H, low: L, close: C } = h;
    const range = H - L;
    switch (kind) {
        case 'fibonacci': {
            const pp = (H + L + C) / 3;
            return { pp, r1: pp + 0.382 * range, r2: pp + 0.618 * range, r3: pp + range, s1: pp - 0.382 * range, s2: pp - 0.618 * range, s3: pp - range };
        }
        case 'woodie': {
            const pp = (H + L + 2 * C) / 4;
            const r3 = H + 2 * (pp - L), s3 = L - 2 * (H - pp);
            return { pp, r1: 2 * pp - L, r2: pp + range, r3, r4: r3 + range, s1: 2 * pp - H, s2: pp - range, s3, s4: s3 - range };
        }
        case 'camarilla': {
            const pp = (H + L + C) / 3;
            const k = range * 1.1;
            return { pp, r1: C + k / 12, r2: C + k / 6, r3: C + k / 4, r4: C + k / 2, s1: C - k / 12, s2: C - k / 6, s3: C - k / 4, s4: C - k / 2 };
        }
        default: {
            const pp = (H + L + C) / 3;
            return { pp, r1: 2 * pp - L, r2: pp + range, r3: 2 * pp + (H - 2 * L), s1: 2 * pp - H, s2: pp - range, s3: 2 * pp - (2 * H - L) };
        }
    }
}
/** High, low and last close of the period whose last bar is `end`. */
function periodHLCEnding(candles, end, anchor) {
    const key = periodKey(anchor, candles[end].date);
    let high = -Infinity, low = Infinity, close = null;
    for (let i = end; i >= 0 && Number.isFinite(candles[i].date) && periodKey(anchor, candles[i].date) === key; i--) {
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
 * Per bar: `map(previous completed period's HLC)`, plus `newPeriod` (true on the first bar of each period, so a
 * painter lifts its pen there). Null before the first completed period. Bars of one period share one result.
 */
export function steppedPeriodValues(candles, anchor, map) {
    const values = new Array(candles.length).fill(null);
    const newPeriod = new Array(candles.length).fill(false);
    let lastFinite = -1, lastKey = null, prevEnd = -1, memoEnd = -2;
    let memo = null;
    for (let i = 0; i < candles.length; i++) {
        const t = candles[i].date;
        if (!Number.isFinite(t))
            continue;
        const key = periodKey(anchor, t);
        if (key !== lastKey) {
            prevEnd = lastFinite;
            newPeriod[i] = true;
        }
        lastFinite = i;
        lastKey = key;
        if (prevEnd < 0)
            continue;
        if (prevEnd !== memoEnd) {
            memoEnd = prevEnd;
            const hlc = periodHLCEnding(candles, prevEnd, anchor);
            memo = hlc ? map(hlc) : null;
        }
        values[i] = memo;
    }
    return { values, newPeriod };
}
/** Pivot levels of the chosen kind from the previous completed period. */
export function steppedPivotLevels(candles, opts = {}) {
    const kind = PIVOT_KINDS.includes(opts.kind ?? '') ? opts.kind : 'classic';
    return steppedPeriodValues(candles, levelAnchor(candles, opts.timeframe), h => pivotLevelsFor(kind, h));
}
/**
 * Central Pivot Range from the previous period: pivot = (H+L+C)/3, BC = (H+L)/2, TC = 2 x pivot - BC; the two edges
 * are reported top (`tc`) and bottom (`bc`) whichever formula gives the larger one. `width` = (tc - bc) / pivot x 100,
 * the percent width traders read as "narrow CPR, trending day ahead".
 */
export function cprFor(h) {
    const pivot = (h.high + h.low + h.close) / 3;
    const b = (h.high + h.low) / 2;
    const t = 2 * pivot - b;
    const tc = Math.max(t, b), bc = Math.min(t, b);
    return { tc, pivot, bc, width: pivot !== 0 ? ((tc - bc) / pivot) * 100 : 0 };
}
export function steppedCpr(candles, timeframe = 'auto') {
    return steppedPeriodValues(candles, levelAnchor(candles, timeframe), cprFor);
}
/** The previous period's high, low and close as flat lines. */
export function steppedPreviousHLC(candles, timeframe = 'auto') {
    return steppedPeriodValues(candles, levelAnchor(candles, timeframe), h => ({ high: h.high, low: h.low, close: h.close }));
}
const DAY_MS = 86_400_000;
/**
 * 52-week high and low: the highest high and lowest low of the bars stamped within the 364 days up to and including
 * this bar (52 x 7 days, the current bar included, as exchanges publish it). Null until the loaded history reaches back
 * that far (a bar at least 364 days older exists), so a short history never shows a "52-week" line that is really a
 * 3-month one. `weeks` changes the window (1 to 260).
 */
export function rollingWeeksHighLow(candles, weeks = 52) {
    const w = Number.isFinite(weeks) ? Math.min(260, Math.max(1, Math.round(weeks))) : 52;
    const span = w * 7 * DAY_MS;
    const out = candles.map(() => ({ high: null, low: null }));
    const hi = [], lo = [];
    let firstDate = NaN;
    let start = 0;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const t = c.date;
        if (!Number.isFinite(t))
            continue;
        if (!Number.isFinite(firstDate))
            firstDate = t;
        const from = t - span + 1;
        while (start < i && !(Number.isFinite(candles[start].date) && candles[start].date >= from))
            start++;
        if (isFiniteNumber(c.high)) {
            while (hi.length && candles[hi[hi.length - 1]].high <= c.high)
                hi.pop();
            hi.push(i);
        }
        if (isFiniteNumber(c.low)) {
            while (lo.length && candles[lo[lo.length - 1]].low >= c.low)
                lo.pop();
            lo.push(i);
        }
        while (hi.length && hi[0] < start)
            hi.shift();
        while (lo.length && lo[0] < start)
            lo.shift();
        if (t - firstDate < span - DAY_MS)
            continue;
        out[i] = { high: hi.length ? candles[hi[0]].high : null, low: lo.length ? candles[lo[0]].low : null };
    }
    return out;
}
/**
 * Opening Range: the high and low of each session's first `minutes` minutes after the exchange open (09:15 IST on
 * NSE). Shown from the bar that completes the range (its start + one bar's length reaches open + minutes) to the end
 * of that session; null on the bars still inside the range and on daily or higher series. The bar length is the most
 * common gap between bars of one session.
 *
 * Honest windows (V3-6, 2026-10-26):
 * - Bars longer than the range (30- or 60-minute bars for a 15-minute range): nothing is drawn. The first bar's
 *   high and low span more than the window, so they are not a 15-minute range; "range shorter than one bar".
 * - A session whose first bar does not start at the open (a late first print, a missing opening bar): no range for
 *   that session. The window is anchored to the session open time, and a range read from later bars would be a
 *   narrower window shown under the full window's name.
 */
export function openingRange(candles, minutes = 15) {
    const out = candles.map(() => ({ high: null, low: null }));
    const span = Number.isFinite(minutes) ? Math.min(375, Math.max(1, Math.round(minutes))) : 15;
    if (seriesSpacing(candles) !== 'intraday')
        return out;
    // Most common gap (minutes) between consecutive bars of one session.
    const counts = new Map();
    for (let i = 1; i < candles.length; i++) {
        const a = candles[i - 1].date, b = candles[i].date;
        if (!Number.isFinite(a) || !Number.isFinite(b) || periodKey('session', a) !== periodKey('session', b))
            continue;
        const g = Math.round((b - a) / 60_000);
        if (g > 0)
            counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    let bar = 1, best = -1;
    for (const [g, n] of counts)
        if (n > best || (n === best && g < bar)) {
            best = n;
            bar = g;
        }
    // Range shorter than one bar: no bar fits inside the window, so there is no honest range to draw (V3-6).
    if (bar > span)
        return out;
    const open = sessionOpenMinute(), end = open + span;
    let key = null, high = -Infinity, low = Infinity, done = false, valid = false;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!Number.isFinite(c.date))
            continue;
        const k = periodKey('session', c.date);
        const m = istMinuteOfDay(c.date);
        // The session's first bar must start at the open: a late first bar would give a narrower window (V3-6).
        if (k !== key) {
            key = k;
            high = -Infinity;
            low = Infinity;
            done = false;
            valid = m === open;
        }
        if (!valid)
            continue;
        if (!done && m < end) {
            if (isFiniteNumber(c.high))
                high = Math.max(high, c.high);
            if (isFiniteNumber(c.low))
                low = Math.min(low, c.low);
            if (m + bar >= end)
                done = true;
        }
        else
            done = true;
        if (done && Number.isFinite(high) && Number.isFinite(low))
            out[i] = { high, low };
    }
    return out;
}
