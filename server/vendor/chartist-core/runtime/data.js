export const toF64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a));
export function dailyBars(d) {
    const n = d.date.length;
    for (const k of ['open', 'high', 'low', 'close', 'volume']) {
        if (d[k].length !== n)
            throw new RangeError(`runtime: ${k} has ${d[k].length} values for ${n} dates`);
    }
    return { n, date: toF64(d.date), open: toF64(d.open), high: toF64(d.high), low: toF64(d.low), close: toF64(d.close), volume: toF64(d.volume) };
}
const ymdOf = (ms) => {
    const d = new Date(ms);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
const msOf = (ymd) => Date.UTC(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100) - 1, ymd % 100);
/** The Monday of the week that holds the date, as `yyyymmdd`. */
export const weekKey = (ymd) => ymdOf(msOf(ymd) - ((new Date(msOf(ymd)).getUTCDay() + 6) % 7) * 86_400_000);
export const monthKey = (ymd) => Math.floor(ymd / 100);
/** The next weekday after a date. */
export function nextWeekday(ymd) {
    let ms = msOf(ymd);
    let wd;
    do {
        ms += 86_400_000;
        wd = new Date(ms).getUTCDay();
    } while (wd === 0 || wd === 6);
    return ymdOf(ms);
}
/**
 * Rules from a list of weekdays the exchange was shut (`yyyymmdd`). A date is the last session of its week (month) when every
 * weekday after it in that week (month) is on the list. Dates the list does not cover are treated as sessions, which is the
 * weekday rule: the list can only make a candlestick complete EARLIER, and only for a closure that is on it.
 */
export function rulesFromHolidays(holidays) {
    const shut = new Set(holidays);
    const nextSession = (ymd) => {
        let d = nextWeekday(ymd);
        for (let guard = 0; shut.has(d) && guard < 40; guard++)
            d = nextWeekday(d);
        return d;
    };
    return {
        isLastOfWeek: (d) => weekKey(nextSession(d)) !== weekKey(d),
        isLastOfMonth: (d) => monthKey(nextSession(d)) !== monthKey(d),
    };
}
/**
 * Group the sessions into weeks and months. A coarse candlestick is complete at the close of its last session in the
 * calendar; one cut off by the end of the data is never complete.
 */
export function buildCalendar(date, rules = {}) {
    const n = date.length;
    const lastOfWeek = rules.isLastOfWeek ?? ((d) => weekKey(nextWeekday(d)) !== weekKey(d));
    const lastOfMonth = rules.isLastOfMonth ?? ((d) => monthKey(nextWeekday(d)) !== monthKey(d));
    const group = (key, isLast) => {
        const first = [];
        const last = [];
        let cur = Number.NaN;
        for (let i = 0; i < n; i++) {
            const k = key(date[i]);
            if (k !== cur) {
                if (i > 0)
                    last.push(i - 1);
                first.push(i);
                cur = k;
            }
        }
        if (n > 0)
            last.push(n - 1);
        // The first daily index at which each candlestick is known to be complete: its own last session when the calendar says it
        // is the last of its week (month), else the first session of the next one. The one cut off by the end of the data and not
        // known to be last never becomes visible. Never decreasing, so a plain scan finds the newest visible one.
        const visible = last.map((l, g) => (isLast(date[l]) ? l : g + 1 < first.length ? first[g + 1] : Number.POSITIVE_INFINITY));
        const asOf = new Int32Array(n);
        let j = -1;
        for (let t = 0; t < n; t++) {
            while (j + 1 < last.length && visible[j + 1] <= t)
                j++;
            asOf[t] = j;
        }
        return { first: Int32Array.from(first), last: Int32Array.from(last), asOf };
    };
    const W = group(weekKey, lastOfWeek);
    const M = group(monthKey, lastOfMonth);
    return { n, len: { D: n, W: W.first.length, M: M.first.length }, first: { W: W.first, M: M.first }, last: { W: W.last, M: M.last }, asOf: { W: W.asOf, M: M.asOf } };
}
/** Weekly or monthly candlesticks from the daily ones. A candlestick with any missing value in any of its sessions is missing. */
export function aggregateBars(daily, cal, frame) {
    const first = cal.first[frame];
    const last = cal.last[frame];
    const n = first.length;
    const out = { n, date: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n) };
    for (let g = 0; g < n; g++) {
        const a = first[g];
        const b = last[g];
        out.date[g] = daily.date[b];
        let bad = false;
        for (let i = a; i <= b && !bad; i++) {
            bad = Number.isNaN(daily.open[i]) || Number.isNaN(daily.high[i]) || Number.isNaN(daily.low[i]) || Number.isNaN(daily.close[i]) || Number.isNaN(daily.volume[i]);
        }
        if (bad) {
            out.open[g] = out.high[g] = out.low[g] = out.close[g] = out.volume[g] = Number.NaN;
            continue;
        }
        let hi = daily.high[a];
        let lo = daily.low[a];
        let vol = 0;
        for (let i = a; i <= b; i++) {
            hi = Math.max(hi, daily.high[i]);
            lo = Math.min(lo, daily.low[i]);
            vol += daily.volume[i];
        }
        out.open[g] = daily.open[a];
        out.high[g] = hi;
        out.low[g] = lo;
        out.close[g] = daily.close[b];
        out.volume[g] = vol;
    }
    return out;
}
/**
 * Index in `from` (the coarser size) for index `i` in `to` (the finer size), or -1 where no complete candlestick exists yet.
 * With `partial`, the LATEST candlestick of `to` sees the candlestick of `from` that is still forming (or the newest, when it
 * is complete); every earlier one sees completed candlesticks only, so the past never changes when a week fills.
 */
export function alignIndex(cal, from, to, i, partial = false) {
    if (from === to)
        return i;
    if (from === 'D')
        throw new RangeError('runtime: cannot line daily candlesticks up with a coarser size');
    if (from !== 'W' && from !== 'M')
        throw new RangeError(`runtime: candlestick size ${from} is not supported`);
    if (to === 'D') {
        if (i < 0)
            return -1;
        return partial && i === cal.n - 1 ? cal.len[from] - 1 : cal.asOf[from][i];
    }
    if (to === 'W' && from === 'M') {
        if (i < 0)
            return -1;
        return partial && i === cal.len.W - 1 ? cal.len.M - 1 : cal.asOf.M[cal.last.W[i]];
    }
    throw new RangeError(`runtime: cannot line ${from} up with ${to}`);
}
