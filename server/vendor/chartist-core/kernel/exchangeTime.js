/**
 * Exchange-time math for candles. The file keeps its historical `ist*` names;
 * every function reads the ACTIVE market's zone at call time (Asia/Kolkata for
 * India, America/New_York for the US), so a market switch changes every bucket
 * boundary and label at once. For India the fixed +05:30 fast path is used and
 * the output is identical to what it always was.
 *
 * (Original note, India:) IST (Asia/Kolkata) time math for NSE/BSE candles.
 *
 * Every bucket boundary, session filter and calendar grouping in the charting
 * stack has to be expressed in exchange time, not in the *browser's* time.
 * `Date#getHours()` / `getDay()` / `getMonth()` are local-time reads: they are
 * accidentally correct for a user sitting in India and silently wrong for
 * everyone else. This module is the single place that knows about +05:30, so
 * no caller ever has to reach for a local-time getter again.
 *
 * India has no DST, so a fixed offset is exact — no timezone database needed.
 */
import { exchangeClock } from './exchangeClock.js';
/** Asia/Kolkata is UTC+05:30 year-round (no DST). */
export const IST_OFFSET_MINUTES = 330;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * MINUTE_MS;
/**
 * NSE/BSE continuous session, as minutes past IST midnight. These two constants
 * are the INDIA values and are kept for importers that are India-only; anything
 * market-aware must call `sessionOpenMinute()` / `sessionCloseMinute()`.
 */
export const SESSION_OPEN_MINUTE = 9 * 60 + 15; // 09:15
export const SESSION_CLOSE_MINUTE = 15 * 60 + 30; // 15:30
/** Regular-session open of the active market, minutes past exchange midnight (IN 555, US 570). */
export function sessionOpenMinute() { return exchangeClock().sessionOpenMinute; }
/** Regular-session close of the active market, minutes past exchange midnight (IN 930, US 960). */
export function sessionCloseMinute() { return exchangeClock().sessionCloseMinute; }
/** IANA zone of the active market's exchange. */
export function exchangeTimeZone() { return exchangeClock().timeZone; }
/** Short label for the exchange clock: "IST" or "ET". */
export function exchangeZoneLabel() { return exchangeClock().zoneLabel; }
/**
 * The IANA zone a chart should DISPLAY in. 'Asia/Kolkata' is the legacy default
 * stored in every chart-settings blob, and means "the exchange's own clock":
 * it follows the active market (New York when the US is active). Any other
 * explicit zone (UTC, London, New York) is kept as chosen.
 */
export function resolveChartZone(zone) {
    if (!zone || zone === 'Asia/Kolkata')
        return exchangeTimeZone();
    return zone;
}
const zoneFormatters = new Map();
const HOUR_MS = 3_600_000;
function wallClockFormatter(tz) {
    let f = zoneFormatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        zoneFormatters.set(tz, f);
    }
    return f;
}
/** The zone's UTC offset at the START of whole UTC hour `hour`, read from `Intl` (slow: one `formatToParts`). */
function intlOffsetAtHour(tz, hour) {
    const start = hour * HOUR_MS;
    const v = {};
    for (const part of wallClockFormatter(tz).formatToParts(start)) {
        if (part.type !== 'literal')
            v[part.type] = Number(part.value);
    }
    return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - start;
}
/**
 * Offset table, per zone, in fixed blocks of `BLOCK_HOURS` whole UTC hours (about 24 weeks). A block holds the
 * hours at which the offset changes inside it and the offset from each change on, found once: `Intl` is sampled
 * every `SAMPLE_HOURS` (one week) and each pair of samples that disagree is narrowed to the exact hour by binary
 * search. Blocks are built on first use and never evicted (a block is a few numbers; a century is ~215 blocks).
 *
 * Honesty note: a change undone within the same week (A -> B -> A between two samples) would be missed. No zone
 * the app uses does that; the equality test checks New York and Kolkata hour by hour over 1970-2035.
 */
const BLOCK_HOURS = 4096;
const SAMPLE_HOURS = 168;
const offsetBlocks = new Map();
function buildOffsetBlock(tz, block) {
    const first = block * BLOCK_HOURS, last = first + BLOCK_HOURS - 1;
    const starts = [first], offsets = [intlOffsetAtHour(tz, first)];
    let lo = first, loOff = offsets[0];
    for (let probe = Math.min(last, first + SAMPLE_HOURS);; probe = Math.min(last, probe + SAMPLE_HOURS)) {
        const probeOff = intlOffsetAtHour(tz, probe);
        // Every change inside (lo, probe]: the first hour that no longer reads `loOff`, then on from there.
        while (loOff !== probeOff) {
            let l = lo, r = probe;
            while (r - l > 1) {
                const m = Math.floor((l + r) / 2);
                if (intlOffsetAtHour(tz, m) === loOff)
                    l = m;
                else
                    r = m;
            }
            lo = r;
            loOff = intlOffsetAtHour(tz, r);
            starts.push(r);
            offsets.push(loOff);
        }
        lo = probe;
        loOff = probeOff;
        if (probe === last)
            break;
    }
    return { starts, offsets };
}
/** The last answer's run of hours `[from, to)`: consecutive bars almost always share it, so most reads stop here. */
const lastRun = { tz: '', from: 0, to: 0, offset: 0 };
/**
 * UTC offset of the active exchange zone at an instant, in ms (IST +19800000,
 * New York -14400000 in summer / -18000000 in winter). Resolved at the start of
 * the instant's whole UTC hour (DST changes fall on whole UTC hours) from the
 * per-zone change table above, so a pan over decades of daily bars makes no
 * `Intl` call per bar. Equal, hour for hour, to reading `Intl` at the hour's start.
 */
export function exchangeOffsetMs(epochMs) {
    const tz = exchangeTimeZone();
    if (tz === 'Asia/Kolkata')
        return IST_OFFSET_MS;
    const hour = Math.floor(epochMs / HOUR_MS);
    if (lastRun.tz === tz && hour >= lastRun.from && hour < lastRun.to)
        return lastRun.offset;
    if (!Number.isFinite(hour))
        return intlOffsetAtHour(tz, hour); // throws RangeError, as it always has
    let blocks = offsetBlocks.get(tz);
    if (!blocks) {
        blocks = new Map();
        offsetBlocks.set(tz, blocks);
    }
    const b = Math.floor(hour / BLOCK_HOURS);
    let table = blocks.get(b);
    if (!table) {
        // A block reaching past the range `Intl` accepts (year ±275760) cannot be sampled: answer that hour directly.
        try {
            table = buildOffsetBlock(tz, b);
        }
        catch {
            return intlOffsetAtHour(tz, hour);
        }
        blocks.set(b, table);
    }
    const { starts, offsets } = table;
    let k = starts.length - 1;
    while (k > 0 && starts[k] > hour)
        k--;
    lastRun.tz = tz;
    lastRun.from = starts[k];
    lastRun.to = k + 1 < starts.length ? starts[k + 1] : (b + 1) * BLOCK_HOURS;
    lastRun.offset = offsets[k];
    return offsets[k];
}
/**
 * Epoch of an exchange wall-clock time given as "local ms" (the wall clock read
 * as if it were UTC, e.g. `Date.UTC(2026, 2, 9, 9, 30)` for 09:30 on 9 Mar).
 * DST-safe: the offset is resolved at the instant itself, twice, so a time
 * either side of a transition lands on the right UTC instant.
 */
export function exchangeLocalToEpoch(localMs) {
    const first = localMs - exchangeOffsetMs(localMs - exchangeOffsetMs(localMs));
    return localMs - exchangeOffsetMs(first);
}
/**
 * Decompose an epoch into IST calendar parts.
 *
 * Implemented by shifting the instant and then reading the *UTC* getters —
 * which are the only getters that behave identically on every machine.
 */
export function istParts(epochMs) {
    const shifted = new Date(epochMs + exchangeOffsetMs(epochMs));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        weekday: shifted.getUTCDay(),
    };
}
/** Whole days elapsed since the epoch, counted in IST. Stable across timezones. */
export function istDayNumber(epochMs) {
    return Math.floor((epochMs + exchangeOffsetMs(epochMs)) / DAY_MS);
}
/**
 * The IST calendar date packed as `yyyymmdd` (e.g. `20260909`), with no Date
 * or object allocated. The chart's time axis reads this for every visible bar
 * on every frame of a pan, so it uses the days-to-civil arithmetic instead of
 * `istParts`. Read it back with `Math.floor(k / 10000)` (year),
 * `Math.floor(k / 100) % 100` (month) and `k % 100` (day).
 */
export function istCalendarKey(epochMs) {
    // Howard Hinnant's civil_from_days, on the IST day number.
    const z = istDayNumber(epochMs) + 719_468;
    const era = Math.floor(z / 146_097);
    const doe = z - era * 146_097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    return year * 10_000 + month * 100 + day;
}
/** Minutes past IST midnight, 0-1439. */
export function istMinuteOfDay(epochMs) {
    const shifted = epochMs + exchangeOffsetMs(epochMs);
    return Math.floor((shifted - Math.floor(shifted / DAY_MS) * DAY_MS) / MINUTE_MS);
}
/** Epoch of 00:00 IST on the IST calendar day containing `epochMs`. */
export function istMidnightMs(epochMs) {
    return exchangeLocalToEpoch(istDayNumber(epochMs) * DAY_MS);
}
/** Epoch of 09:15 IST on the IST calendar day containing `epochMs`. */
export function sessionOpenMs(epochMs) {
    return exchangeLocalToEpoch(istDayNumber(epochMs) * DAY_MS + sessionOpenMinute() * MINUTE_MS);
}
/** `YYYY-MM-DD` in IST — the key the EOD corpus and the UI both think in. */
export function istDateKey(epochMs) {
    const p = istParts(epochMs);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
/** True for Saturday/Sunday in IST. Says nothing about trading holidays. */
export function isWeekendIST(epochMs) {
    const wd = istParts(epochMs).weekday;
    return wd === 0 || wd === 6;
}
/**
 * Is this a legal *bucket start* for a bar inside the continuous session?
 *
 * The window is inclusive of 15:30 on purpose: indices publish a closing print
 * stamped exactly 15:30 (verified — `^NSEI` 5m returns 376 bars where a stock
 * returns 375). Excluding it would throw away the real close; anything strictly
 * after it is a phantom and is dropped.
 */
export function isSessionBucketStart(epochMs) {
    if (isWeekendIST(epochMs))
        return false;
    const m = istMinuteOfDay(epochMs);
    return m >= sessionOpenMinute() && m <= sessionCloseMinute();
}
/**
 * Floor an instant onto the intraday bucket grid **anchored at 09:15 IST**.
 *
 * Anchoring matters for 30m and 60m. 09:15 IST is 03:45 UTC, which is not a
 * multiple of 30 or 60 minutes from the epoch, so a naive
 * `floor(ms / bucket)` produces 09:00/09:30 and 09:00/10:00 buckets — the
 * first bar of every session would cover 15 minutes while claiming 30, and
 * every later bar would straddle two real ones. The data feed itself anchors at the
 * session open (verified: 30m bars land on 09:15, 09:45 … 15:15), so this is
 * also what keeps our buckets mergeable with theirs.
 */
export function alignToSessionBucket(epochMs, bucketMinutes) {
    if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0)
        return epochMs;
    const anchor = sessionOpenMs(epochMs);
    const size = bucketMinutes * MINUTE_MS;
    // Math.floor (not trunc) so instants before the open still land on a
    // deterministic grid rather than snapping forwards.
    return anchor + Math.floor((epochMs - anchor) / size) * size;
}
/**
 * Key identifying the IST week containing `epochMs`, as the day-number of that
 * week's Monday. Used to group daily bars into weekly ones.
 *
 * Grouping by key rather than by "start a new bar when I see a Monday" is what
 * makes a holiday-shortened week correct: if Monday is a trading holiday the
 * week simply starts on Tuesday instead of being swallowed by the week before.
 */
export function istWeekKey(epochMs) {
    const dayNum = istDayNumber(epochMs);
    const weekday = istParts(epochMs).weekday; // 0 = Sunday
    const daysSinceMonday = (weekday + 6) % 7; // Monday → 0, Sunday → 6
    return dayNum - daysSinceMonday;
}
/** Key identifying the IST calendar month, e.g. `2026-09`. */
export function istMonthKey(epochMs) {
    const p = istParts(epochMs);
    return `${p.year}-${String(p.month).padStart(2, '0')}`;
}
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `HH:MM` in IST — for intraday axis labels and tooltips. */
export function formatISTTime(epochMs) {
    const p = istParts(epochMs);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
/** `9 Sep` in IST — the intraday axis' day-change marker. */
export function formatISTDayMonth(epochMs) {
    const p = istParts(epochMs);
    return `${p.day} ${MONTH_ABBR[p.month - 1]}`;
}
/** `Sep` — the IST calendar month abbreviation for daily/weekly axis labels. */
export function formatISTMonthShort(epochMs) {
    return MONTH_ABBR[istParts(epochMs).month - 1];
}
/** `09 Sep 2026` in IST — the date readout for daily and longer bars. */
export function formatISTDate(epochMs) {
    const p = istParts(epochMs);
    return `${String(p.day).padStart(2, '0')} ${MONTH_ABBR[p.month - 1]} ${p.year}`;
}
/** `09 Sep 2026 15:25` in IST — the crosshair readout. */
export function formatISTDateTime(epochMs) {
    const p = istParts(epochMs);
    return `${String(p.day).padStart(2, '0')} ${MONTH_ABBR[p.month - 1]} ${p.year} ` +
        `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
