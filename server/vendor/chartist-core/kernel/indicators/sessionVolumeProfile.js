import { istCalendarKey, istMinuteOfDay } from '../exchangeTime.js';
import { isFiniteNumber } from './priceBarGuards.js';
export function buildSessions(candles) {
    const sessions = [];
    let currentKey = null;
    let cur = null;
    candles.forEach((c, i) => {
        if (!isFiniteNumber(c.date))
            return;
        const key = istCalendarKey(c.date);
        if (cur === null || key !== currentKey) {
            cur = { indices: [], minutes: [], volumes: [], cumulative: [] };
            sessions.push(cur);
            currentKey = key;
        }
        const vol = isFiniteNumber(c.volume) ? c.volume : NaN;
        const prev = cur.cumulative.length ? cur.cumulative[cur.cumulative.length - 1] : 0;
        cur.indices.push(i);
        cur.minutes.push(istMinuteOfDay(c.date));
        cur.volumes.push(vol);
        cur.cumulative.push(prev + (Number.isNaN(vol) ? 0 : vol));
    });
    return sessions;
}
/** Position of the last element <= t in an ascending array, or -1. */
function lastAtOrBefore(sorted, t) {
    let lo = 0, hi = sorted.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] <= t) {
            ans = mid;
            lo = mid + 1;
        }
        else
            hi = mid - 1;
    }
    return ans;
}
/**
 * Cumulative volume of `s` up to and including minute `t`, or null when the
 * session cannot answer reliably: it had not opened by `t`, or it ended before
 * `t` (partial / truncated session — its total would understate the norm).
 */
export function cumulativeAt(s, t) {
    if (s.minutes.length === 0 || s.minutes[0] > t || s.minutes[s.minutes.length - 1] < t)
        return null;
    const pos = lastAtOrBefore(s.minutes, t);
    return pos < 0 ? null : s.cumulative[pos];
}
/** Volume of the bar that starts exactly at minute `t`, or null when that bar is missing / has no volume. */
export function barVolumeAt(s, t) {
    const pos = lastAtOrBefore(s.minutes, t);
    if (pos < 0 || s.minutes[pos] !== t)
        return null;
    const v = s.volumes[pos];
    return Number.isNaN(v) ? null : v;
}
