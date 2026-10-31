import { isInsideBarShape, isNarrowestRange } from '../kernel/candlePatterns.js';
export const U = Number.NaN;
export const isU = (x) => x !== x;
// ---- three-valued logic (SPEC section 4) -----------------------------------------------------------------------------
export const not3 = (a) => (isU(a) ? U : a ? 0 : 1);
/** False wins, then unknown. */
export function and3(xs) {
    let unknown = false;
    for (const x of xs) {
        if (isU(x))
            unknown = true;
        else if (!x)
            return 0;
    }
    return unknown ? U : 1;
}
/** True wins, then unknown. */
export function or3(xs) {
    let unknown = false;
    for (const x of xs) {
        if (isU(x))
            unknown = true;
        else if (x)
            return 1;
    }
    return unknown ? U : 0;
}
// ---- pointwise -------------------------------------------------------------------------------------------------------
/** Arithmetic with the language's rule that an impossible result is unknown. */
export function arith(op, a, b) {
    if (isU(a) || isU(b))
        return U;
    let v;
    switch (op) {
        case 'add':
            v = a + b;
            break;
        case 'sub':
            v = a - b;
            break;
        case 'mul':
            v = a * b;
            break;
        case 'div':
            v = b === 0 ? U : a / b;
            break;
        case 'floordiv':
            v = b === 0 ? U : Math.floor(a / b);
            break;
        case 'mod':
            v = b === 0 ? U : a - b * Math.floor(a / b);
            break;
        case 'pow':
            v = a ** b;
            break;
        default: throw new Error(`unknown operator ${op}`);
    }
    return Number.isFinite(v) ? v : U;
}
export function compare(op, a, b) {
    if (isU(a) || isU(b))
        return U;
    switch (op) {
        case 'lt': return a < b ? 1 : 0;
        case 'le': return a <= b ? 1 : 0;
        case 'gt': return a > b ? 1 : 0;
        case 'ge': return a >= b ? 1 : 0;
        case 'eq': return a === b ? 1 : 0;
        case 'ne': return a !== b ? 1 : 0;
        default: throw new Error(`unknown comparison ${op}`);
    }
}
export const near = (a, b, pct) => (isU(a) || isU(b) || isU(pct) || b === 0 ? U : (Math.abs(a - b) / Math.abs(b)) * 100 <= pct ? 1 : 0);
export const nz = (x, d) => (isU(x) ? d : x);
const at = (o, i) => (typeof o === 'number' ? o : o[i]);
export function map1(n, a, f) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++)
        out[i] = f(at(a, i));
    return out;
}
export function map2(n, a, b, f) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++)
        out[i] = f(at(a, i), at(b, i));
    return out;
}
export function map3(n, a, b, c, f) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++)
        out[i] = f(at(a, i), at(b, i), at(c, i));
    return out;
}
export function mapN(n, args, f) {
    const out = new Float64Array(n);
    const xs = new Array(args.length);
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < args.length; k++)
            xs[k] = at(args[k], i);
        out[i] = f(xs);
    }
    return out;
}
/** `x[k]`: the value k candlesticks ago; unknown for the first k. A negative k would read the future, so it is refused
 * here as well as by the checker and validateIr. */
export function shift(x, k, n) {
    if (!Number.isInteger(k) || k < 0)
        throw new RangeError(`runtime: x[${k}] is not a whole number of candlesticks back`);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++)
        out[i] = i - k < 0 ? U : at(x, i - k);
    return out;
}
// ---- rolling windows -------------------------------------------------------------------------------------------------
/** Calls `emit(i, windowIsComplete)` after sliding a window of `len` over the series; tracks missing values exactly. */
function eachWindow(x, len, emit) {
    const n = x.length;
    let missing = 0;
    for (let i = 0; i < n; i++) {
        if (isU(x[i]))
            missing++;
        if (i - len >= 0 && isU(x[i - len]))
            missing--;
        emit(i, i >= len - 1 && missing === 0);
    }
}
export function sma(x, len) {
    const out = new Float64Array(x.length).fill(U);
    eachWindow(x, len, (i, ok) => {
        if (!ok)
            return;
        let s = 0;
        for (let k = i - len + 1; k <= i; k++)
            s += x[k];
        out[i] = s / len;
    });
    return out;
}
export function wma(x, len) {
    const out = new Float64Array(x.length).fill(U);
    const denom = (len * (len + 1)) / 2;
    eachWindow(x, len, (i, ok) => {
        if (!ok)
            return;
        let num = 0;
        for (let k = 0; k < len; k++)
            num += x[i - len + 1 + k] * (k + 1);
        out[i] = num / denom;
    });
    return out;
}
/** Highest or lowest of the last `len` values, by a monotonic queue (exact, whatever the window). */
function extreme(x, len, better) {
    const n = x.length;
    const out = new Float64Array(n).fill(U);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    let lastMissing = -1;
    for (let i = 0; i < n; i++) {
        if (isU(x[i])) {
            lastMissing = i;
            head = tail = 0;
            continue;
        }
        while (tail > head && !better(x[queue[tail - 1]], x[i]))
            tail--;
        queue[tail++] = i;
        while (queue[head] <= i - len)
            head++;
        if (i >= len - 1 && lastMissing < i - len + 1)
            out[i] = x[queue[head]];
    }
    return out;
}
export const highest = (x, len) => extreme(x, len, (a, b) => a > b);
export const lowest = (x, len) => extreme(x, len, (a, b) => a < b);
/** Highest (or lowest) value from the first candlestick to each one, that candlestick included. A missing value is skipped, so a gap does not erase the extreme so far. */
function runningExtreme(x, better) {
    const out = new Float64Array(x.length).fill(U);
    let cur = U;
    for (let i = 0; i < x.length; i++) {
        if (!isU(x[i]) && (isU(cur) || better(x[i], cur)))
            cur = x[i];
        out[i] = cur;
    }
    return out;
}
export const highestAll = (x) => runningExtreme(x, (a, b) => a > b);
export const lowestAll = (x) => runningExtreme(x, (a, b) => a < b);
/**
 * Exponential average: starts from the average of the first `len` values; a missing value restarts it.
 *
 * The starting average is `sma(x, len)` at that candlestick, added the same way (left to right, afresh), so the numbers
 * are exactly those of `sma`. It is worked out only where it is used, never for every candlestick: once per stretch of
 * `len` known values after a gap, so the whole run reads each value at most twice (O(n), whatever `len`). That is what
 * makes the budget's flat charge for ta.ema / ta.rma honest. (With finite inputs a start can only fail to give a number
 * when a value is missing; the language never makes an infinity, so a start is not recomputed candlestick by candlestick.)
 */
function smooth(x, len, alpha) {
    const n = x.length;
    const out = new Float64Array(n).fill(U);
    let missing = 0;
    for (let i = 0; i < n; i++) {
        // The same window bookkeeping as eachWindow, so "the window is complete" means what it means for sma.
        if (isU(x[i]))
            missing++;
        if (i - len >= 0 && isU(x[i - len]))
            missing--;
        if (isU(x[i]))
            continue;
        const prev = i > 0 ? out[i - 1] : U;
        if (!isU(prev))
            out[i] = alpha * x[i] + (1 - alpha) * prev;
        else if (i >= len - 1 && missing === 0) {
            let s = 0;
            for (let k = i - len + 1; k <= i; k++)
                s += x[k];
            out[i] = s / len;
        }
    }
    return out;
}
export const ema = (x, len) => smooth(x, len, 2 / (len + 1));
export const rma = (x, len) => smooth(x, len, 1 / len);
export function change(x, len) {
    const n = x.length;
    const out = new Float64Array(n).fill(U);
    for (let i = len; i < n; i++)
        out[i] = x[i] - x[i - len];
    return out;
}
export function crossover(a, b, n) {
    const out = new Float64Array(n).fill(U);
    for (let i = 1; i < n; i++)
        out[i] = and3([compare('gt', at(a, i), at(b, i)), compare('le', at(a, i - 1), at(b, i - 1))]);
    return out;
}
export function crossunder(a, b, n) {
    const out = new Float64Array(n).fill(U);
    for (let i = 1; i < n; i++)
        out[i] = and3([compare('lt', at(a, i), at(b, i)), compare('ge', at(a, i - 1), at(b, i - 1))]);
    return out;
}
export function count(c, len) {
    const n = c.length;
    const out = new Float64Array(n).fill(U);
    let missing = 0;
    let truthy = 0;
    for (let i = 0; i < n; i++) {
        if (isU(c[i]))
            missing++;
        else if (c[i])
            truthy++;
        if (i - len >= 0) {
            if (isU(c[i - len]))
                missing--;
            else if (c[i - len])
                truthy--;
        }
        if (i >= len - 1 && missing === 0)
            out[i] = truthy;
    }
    return out;
}
// ---- WP1 (2026-10-17): statistics over a window, momentum, pivots ---------------------------------------------------
// Each mirrors the oracle's definition (src/__tests__/reference/kernels.ts) operation for operation, so the numbers are
// identical, not merely close: a window is read afresh at every candlestick, left to right. Any missing value inside the
// window makes the answer unknown, as for sma.
/** The values of the window ending at i, oldest first, when it is complete and has no missing value; else null. */
function windowAt(x, i, len) {
    if (i < len - 1)
        return null;
    for (let k = i - len + 1; k <= i; k++)
        if (isU(x[k]))
            return null;
    return x.subarray(i - len + 1, i + 1);
}
function meanOf(w) {
    let s = 0;
    for (let k = 0; k < w.length; k++)
        s += w[k];
    return s / w.length;
}
/**
 * True when the window does not vary: its spread (highest - lowest) is at most 1e-12 of its size. The floating average
 * of equal values is not exact (25 x 100.1 averages to 100.1 + 1.4e-14), so the distances from it are not zero either;
 * this decides "flat" from the values themselves (review fix 2026-10-17). The oracle uses the same rule.
 */
function isFlat(w) {
    let lo = w[0];
    let hi = w[0];
    for (let k = 1; k < w.length; k++) {
        if (w[k] < lo)
            lo = w[k];
        else if (w[k] > hi)
            hi = w[k];
    }
    return hi - lo <= 1e-12 * Math.max(1, Math.abs(hi), Math.abs(lo));
}
/** Population variance (divided by n, not n - 1), worked out from the window's own average; exactly 0 on a flat window. */
function varianceOf(w) {
    if (isFlat(w))
        return 0;
    const m = meanOf(w);
    let s = 0;
    for (let k = 0; k < w.length; k++) {
        const d = w[k] - m;
        s += d * d;
    }
    return s / w.length;
}
/** Mean absolute deviation from the window's average; exactly 0 on a flat window. */
function devOf(w) {
    if (isFlat(w))
        return 0;
    const m = meanOf(w);
    let s = 0;
    for (let k = 0; k < w.length; k++)
        s += Math.abs(w[k] - m);
    return s / w.length;
}
const finiteOrU = (v) => (Number.isFinite(v) ? v : U);
function overWindow(x, len, f) {
    const out = new Float64Array(x.length).fill(U);
    for (let i = len - 1; i < x.length; i++) {
        const w = windowAt(x, i, len);
        if (w)
            out[i] = finiteOrU(f(w, i));
    }
    return out;
}
export const variance = (x, len) => overWindow(x, len, varianceOf);
export const stdev = (x, len) => overWindow(x, len, (w) => Math.sqrt(varianceOf(w)));
export const dev = (x, len) => overWindow(x, len, devOf);
/** First index in sorted `s` whose value is not below v. */
function lowerBound(s, v) {
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (s[mid] < v)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
/**
 * Percentile of a sliding window, keeping the window sorted as it slides (one insert and one removal per candlestick)
 * instead of sorting it afresh. The sorted values are the same, so the answer is `percentileOf` of the window, number
 * for number; a missing value empties the window, which refills from the next known value.
 */
export function percentile(x, len, pct) {
    const out = new Float64Array(x.length).fill(U);
    const s = [];
    let lastMissing = -1;
    for (let i = 0; i < x.length; i++) {
        if (isU(x[i])) {
            lastMissing = i;
            s.length = 0;
            continue;
        }
        s.splice(lowerBound(s, x[i]), 0, x[i]);
        const old = i - len;
        if (old > lastMissing)
            s.splice(lowerBound(s, x[old]), 1);
        if (i - lastMissing >= len) {
            const rank = (pct / 100) * (len - 1);
            const lo = Math.floor(rank);
            const hi = Math.ceil(rank);
            out[i] = finiteOrU(s[lo] + (s[hi] - s[lo]) * (rank - lo));
        }
    }
    return out;
}
export const median = (x, len) => percentile(x, len, 50);
/** (x - its average) / (0.015 * its mean absolute deviation); unknown when the deviation is 0. */
export const cci = (x, len) => overWindow(x, len, (w, i) => {
    const d = devOf(w);
    return d === 0 ? U : (x[i] - meanOf(w)) / (0.015 * d);
});
/** End value of the least-squares line through the window (x = 0 for the oldest), read `offset` candlesticks back from the newest. */
export const linreg = (x, len, offset) => overWindow(x, len, (w) => {
    const n = w.length;
    const my = meanOf(w);
    const mx = (n - 1) / 2;
    let sxx = 0;
    let sxy = 0;
    for (let k = 0; k < n; k++) {
        const dx = k - mx;
        sxx += dx * dx;
        sxy += dx * (w[k] - my);
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    return my - slope * mx + slope * (n - 1 - offset);
});
/** Pearson correlation of a and b over the window; unknown when either is flat (no variation) or a value is missing. */
export function correlation(a, b, len) {
    const out = new Float64Array(a.length).fill(U);
    for (let i = len - 1; i < a.length; i++) {
        const wa = windowAt(a, i, len);
        const wb = windowAt(b, i, len);
        if (!wa || !wb || isFlat(wa) || isFlat(wb))
            continue;
        const ma = meanOf(wa);
        const mb = meanOf(wb);
        let sab = 0;
        let saa = 0;
        let sbb = 0;
        for (let k = 0; k < len; k++) {
            const da = wa[k] - ma;
            const db = wb[k] - mb;
            sab += da * db;
            saa += da * da;
            sbb += db * db;
        }
        if (saa === 0 || sbb === 0)
            continue;
        out[i] = finiteOrU(Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb))));
    }
    return out;
}
/** 100 * (x - x[len]) / x[len]; unknown when the earlier value is 0 or missing. */
export function roc(x, len) {
    const out = new Float64Array(x.length).fill(U);
    for (let i = len; i < x.length; i++) {
        const p = x[i - len];
        if (isU(p) || isU(x[i]) || p === 0)
            continue;
        out[i] = finiteOrU((100 * (x[i] - p)) / p);
    }
    return out;
}
/** Each of the last `len` steps went up (rising) or down (falling), strictly; three-valued, so one clear step the wrong way decides false. */
function steps(x, len, op) {
    const out = new Float64Array(x.length).fill(U);
    const parts = new Array(len);
    for (let i = len; i < x.length; i++) {
        for (let k = 0; k < len; k++)
            parts[k] = compare(op, x[i - k], x[i - k - 1]);
        out[i] = and3(parts);
    }
    return out;
}
export const rising = (x, len) => steps(x, len, 'gt');
export const falling = (x, len) => steps(x, len, 'lt');
/** a crossed b in either direction on this candlestick (crossover or crossunder, three-valued). */
export function cross(a, b, n) {
    const up = crossover(a, b, n);
    const dn = crossunder(a, b, n);
    const out = new Float64Array(n).fill(U);
    for (let i = 1; i < n; i++)
        out[i] = or3([up[i], dn[i]]);
    return out;
}
/**
 * Pivot high (low): the value of x at candlestick p = i - right, written on candlestick i, when no value in the window
 * from p - left to p + right is higher (lower) than it; ties count as a pivot, as in the chart's pivot study. Late by
 * design: candlestick p is known to be a pivot only `right` candlesticks after it. Unknown where there is no pivot,
 * before the window exists, and when the window has a missing value.
 */
function pivot(x, left, right, beats) {
    const out = new Float64Array(x.length).fill(U);
    for (let i = left + right; i < x.length; i++) {
        const p = i - right;
        const centre = x[p];
        if (isU(centre))
            continue;
        let ok = true;
        for (let k = p - left; k <= p + right; k++) {
            if (isU(x[k]) || beats(x[k], centre)) {
                ok = false;
                break;
            }
        }
        if (ok)
            out[i] = centre;
    }
    return out;
}
export const pivotHigh = (x, left, right) => pivot(x, left, right, (v, c) => v > c);
export const pivotLow = (x, left, right) => pivot(x, left, right, (v, c) => v < c);
// ---- WP1 (2026-10-17): maths, one value at a time. A result with no meaning (square root of a negative, logarithm of
// zero or less, an overflow) is unknown, never a number that reads as false.
export const mathSqrt = (x) => (isU(x) || x < 0 ? U : Math.sqrt(x));
export const mathLog = (x) => (isU(x) || x <= 0 ? U : Math.log(x));
export const mathExp = (x) => (isU(x) ? U : finiteOrU(Math.exp(x)));
const noNegZero = (v) => (v === 0 ? 0 : v);
/** Half away from zero (2.5 gives 3, -2.5 gives -3), to `digits` decimals. */
export const mathRound = (x, digits) => {
    if (isU(x) || isU(digits))
        return U;
    const f = 10 ** digits;
    return noNegZero(finiteOrU((Math.sign(x) * Math.round(Math.abs(x) * f)) / f));
};
export const mathFloor = (x) => (isU(x) ? U : noNegZero(Math.floor(x)));
export const mathCeil = (x) => (isU(x) ? U : noNegZero(Math.ceil(x)));
export const mathSign = (x) => (isU(x) ? U : x > 0 ? 1 : x < 0 ? -1 : 0);
export const mathClamp = (x, lo, hi) => (isU(x) || isU(lo) || isU(hi) || lo > hi ? U : Math.min(Math.max(x, lo), hi));
/** True (1) when the value is missing, false (0) otherwise: never unknown. */
export const isNa = (x) => (isU(x) ? 1 : 0);
// ---- state carried from one candlestick to the next (the "scan kernels") ----------------------------------------------
/** Candlesticks since the condition was last true: 0 where true; unknown before the first time and, after an unknown, until the next true. */
export function barsSince(c) {
    const n = c.length;
    const out = new Float64Array(n).fill(U);
    for (let i = 0; i < n; i++) {
        const now = c[i];
        if (isU(now))
            continue;
        if (now)
            out[i] = 0;
        else {
            const prev = i > 0 ? out[i - 1] : U;
            out[i] = isU(prev) ? U : prev + 1;
        }
    }
    return out;
}
/** The value of x where the condition was last true; unknown before the first time and, after an unknown, until the next true. */
export function valueWhen(c, x) {
    const n = c.length;
    const out = new Float64Array(n).fill(U);
    for (let i = 0; i < n; i++) {
        const now = c[i];
        if (isU(now))
            continue;
        out[i] = now ? at(x, i) : i > 0 ? out[i - 1] : U;
    }
    return out;
}
/** True from where `set` is true until `reset` is true; set wins on the same candlestick. Three-valued, starts false. */
export function latch(set, reset, n) {
    const out = new Float64Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
        prev = or3([at(set, i), and3([prev, not3(at(reset, i))])]);
        out[i] = prev;
    }
    return out;
}
/**
 * Running total from the first candlestick given. A missing value is unknown at its own candlestick and adds nothing;
 * the total carries on after it. Needs verification (SPEC section 12.3).
 */
export function cumSum(x) {
    const n = x.length;
    const out = new Float64Array(n).fill(U);
    let total = 0;
    for (let i = 0; i < n; i++) {
        if (isU(x[i]))
            continue;
        total += x[i];
        out[i] = total;
    }
    return out;
}
/** Highest (or lowest) x since the condition was last true, that candlestick included. Unknown before the first time and, after an unknown, until the next true. */
function extremeSince(c, x, pick) {
    const n = c.length;
    const out = new Float64Array(n).fill(U);
    for (let i = 0; i < n; i++) {
        const now = c[i];
        if (isU(now))
            continue;
        if (now)
            out[i] = at(x, i);
        else {
            const prev = i > 0 ? out[i - 1] : U;
            out[i] = isU(prev) ? U : pick(prev, at(x, i));
        }
    }
    return out;
}
export const highestSince = (c, x) => extremeSince(c, x, Math.max);
export const lowestSince = (c, x) => extremeSince(c, x, Math.min);
// ---- candlestick-shaped functions ------------------------------------------------------------------------------------
/** Wilder-smoothed true range. */
export function atr(bars, len) {
    const n = bars.n;
    const tr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const h = bars.high[i];
        const l = bars.low[i];
        if (i === 0)
            tr[i] = h - l;
        else {
            const pc = bars.close[i - 1];
            tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
    }
    return rma(tr, len);
}
export function rsi(x, len) {
    const n = x.length;
    const up = new Float64Array(n).fill(U);
    const dn = new Float64Array(n).fill(U);
    for (let i = 1; i < n; i++) {
        up[i] = Math.max(x[i] - x[i - 1], 0);
        dn[i] = Math.max(x[i - 1] - x[i], 0);
    }
    const au = rma(up, len);
    const ad = rma(dn, len);
    const out = new Float64Array(n).fill(U);
    for (let i = 0; i < n; i++) {
        const a = au[i];
        const d = ad[i];
        if (isU(a) || isU(d))
            continue;
        // No gain and no loss (a flat series) is 50, as ind.rsi and the chart give it (2026-10-25, B2-2); Pine's built-in gives 100.
        out[i] = a === 0 && d === 0 ? 50 : d === 0 ? 100 : 100 - 100 / (1 + a / d);
    }
    return out;
}
/**
 * `candle.inside()`: the kernel's inside-bar shape (`isInsideBarShape`): high not above and low not below yesterday's, and
 * a smaller range (a twin with the same high and low is not inside). Since 2026-10-25 (PC-11) the language and the chart
 * read the same rule; `candle.pattern("inside_bar")` adds the mother-candle size test.
 */
export function candleInside(bars) {
    const n = bars.n;
    const out = new Float64Array(n).fill(U);
    for (let i = 1; i < n; i++) {
        const h = bars.high[i];
        const l = bars.low[i];
        const ph = bars.high[i - 1];
        const pl = bars.low[i - 1];
        if (isU(h) || isU(l) || isU(ph) || isU(pl))
            continue;
        out[i] = isInsideBarShape({ open: ph, high: ph, low: pl, close: pl }, { open: h, high: h, low: l, close: l }) ? 1 : 0;
    }
    return out;
}
/** `candle.nr(len)`: the kernel's `isNarrowestRange` over the last `len` candlesticks, today included (ties count). */
export function candleNr(bars, len) {
    const n = bars.n;
    const out = new Float64Array(n).fill(U);
    const ranges = new Array(len);
    for (let i = len - 1; i < n; i++) {
        let bad = false;
        for (let k = i - len + 1, j = 0; k <= i; k++, j++) {
            const r = bars.high[k] - bars.low[k];
            if (isU(r)) {
                bad = true;
                break;
            }
            ranges[j] = r;
        }
        if (bad)
            continue;
        out[i] = isNarrowestRange(ranges) ? 1 : 0;
    }
    return out;
}
