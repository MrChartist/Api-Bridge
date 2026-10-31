import { exchangeClock } from '../exchangeClock.js';
import { istCalendarKey, istMinuteOfDay, istWeekKey, sessionCloseMinute, sessionOpenMinute } from '../exchangeTime.js';
/** Numeric key identifying the IST period containing `epochMs`. Equal keys = same period. */
export function periodKey(anchor, epochMs) {
    const day = istCalendarKey(epochMs); // yyyymmdd
    switch (anchor) {
        case 'session': return day;
        case 'week': return istWeekKey(epochMs);
        case 'month': return Math.floor(day / 100);
        case 'year': return Math.floor(day / 10_000);
    }
}
/**
 * True when the series is intraday. Decided by BAR SPACING, not by the time printed on a bar (I1-1, 2026-10-26):
 * - two adjacent bars on one IST date: intraday (every intraday timeframe up to the session length has them);
 * - two or more bars and every bar on its own date: daily or higher, whatever the stamp. The NSE corpus stamps daily
 *   bars at 09:15 IST (the open), a few at 09:00 / 09:55 and Muhurat sessions at 17:15 / 18:15; the US feed stamps them
 *   at the 09:30 ET open. Reading the stamp classified every Indian daily, weekly and monthly series as intraday, so
 *   Pivot Points used the previous DAY on a daily chart and RVOL took the time-of-day path;
 * - a single bar (nothing to measure a spacing from): by its stamp, as before: inside the session window is intraday
 *   (in the US a bar exactly AT the open is not, since US daily bars are stamped at the open). A live Indian intraday
 *   chart's first 09:15 bar therefore stays intraday and does not flip at its second tick.
 * Every test reads a bar and the one before it, so the answer for a prefix extends to a longer series by looking at
 * the new bars only (the incremental VWAP path relies on that); a one-bar series is the single exception.
 */
export function isIntradaySeries(candles) {
    let finite = 0;
    let only = NaN;
    let previous = NaN;
    for (let i = 0; i < candles.length; i++) {
        const t = candles[i].date;
        if (!Number.isFinite(t))
            continue;
        finite++;
        only = t;
        if (Number.isFinite(previous) && istCalendarKey(t) === istCalendarKey(previous))
            return true;
        previous = t;
    }
    if (finite !== 1)
        return false;
    const m = istMinuteOfDay(only);
    const afterOpen = exchangeClock().dailyBarAtOpen ? m > sessionOpenMinute() : m >= sessionOpenMinute();
    return afterOpen && m <= sessionCloseMinute();
}
const DAY_MS = 86_400_000;
/**
 * What one bar of the series spans, from its spacing (I1-1/I1-2, 2026-10-26): intraday by `isIntradaySeries`, else
 * the median gap between the newest (up to 64) consecutive bars: up to 3.5 days is daily (a weekend gap is 3), up to
 * 12 days weekly, longer monthly (or above). Fewer than two bars and not intraday: daily.
 */
export function seriesSpacing(candles) {
    if (isIntradaySeries(candles))
        return 'intraday';
    const gaps = [];
    let next = NaN;
    for (let i = candles.length - 1; i >= 0 && gaps.length < 64; i--) {
        const t = candles[i].date;
        if (!Number.isFinite(t))
            continue;
        if (Number.isFinite(next))
            gaps.push((next - t) / DAY_MS);
        next = t;
    }
    if (!gaps.length)
        return 'daily';
    gaps.sort((a, b) => a - b);
    // Lower median: with two gaps (a daily week split by a weekend), the shorter one decides.
    const median = gaps[Math.floor((gaps.length - 1) / 2)];
    return median <= 3.5 ? 'daily' : median <= 12 ? 'weekly' : 'monthly';
}
