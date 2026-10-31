/**
 * Input hygiene for the pure indicator maths.
 *
 * - clampPeriod: every window length is coerced to an integer >= 1 (never
 *   throws on 0 / negative / NaN / fractional lengths).
 * - sanitizeSeries: carries the last finite value forward (leading gaps are
 *   back-filled from the first finite value) so one bad bar cannot poison the
 *   recursive state (EMA / Wilder / running sums) of every later bar.
 * - robustIndicator: wraps a raw `calcXCore` so that a bar whose own inputs
 *   were non-finite yields a null output, while later bars are computed from
 *   the carried series. Non-finite numbers never leak into an output.
 */
export function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
/**
 * Integer window length in [1, max]. Non-finite / non-numeric input -> 1,
 * fractions are floored. `max` (default unbounded) stops absurd lengths from
 * ever allocating huge arrays.
 */
export function clampPeriod(p, max = Number.MAX_SAFE_INTEGER) {
    if (!isFiniteNum(p))
        return 1;
    return Math.min(Math.max(1, Math.floor(p)), Math.max(1, max));
}
function toArrayLike(v) {
    return Array.isArray(v) ? v : [];
}
/** True where `values[i]` is not a finite number (missing indices count as bad). */
export function nonFiniteMask(values, length = values.length) {
    let mask = null;
    for (let i = 0; i < length; i++) {
        if (!isFiniteNum(values[i])) {
            if (!mask)
                mask = new Array(length).fill(false);
            mask[i] = true;
        }
    }
    return mask;
}
/**
 * Finite copy of `values` (length `length`): non-finite bars take the last
 * finite value; a leading gap takes the first finite value; a series with no
 * finite value at all becomes zeros (callers mask those bars to null anyway).
 */
export function sanitizeSeries(values, length = values.length) {
    const out = new Array(length);
    let last = NaN;
    let firstFinite = NaN;
    for (let i = 0; i < length; i++) {
        const v = values[i];
        if (isFiniteNum(v)) {
            last = v;
            if (Number.isNaN(firstFinite))
                firstFinite = v;
        }
        out[i] = last;
    }
    const fallback = Number.isNaN(firstFinite) ? 0 : firstFinite;
    for (let i = 0; i < length && Number.isNaN(out[i]); i++)
        out[i] = fallback;
    return out;
}
/** Volumes: a missing/garbage volume contributes nothing (0), it is not carried. */
function sanitizeVolume(values, length = values.length) {
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
        const v = values[i];
        out[i] = isFiniteNum(v) && v >= 0 ? v : 0;
    }
    return out;
}
function nullOut(el, spec) {
    if (spec.whole || el === null || typeof el !== 'object')
        return null;
    const o = { ...el };
    for (const k of Object.keys(o))
        if (!spec.keep?.includes(k))
            o[k] = null;
    return o;
}
function scrubElement(el) {
    if (typeof el === 'number')
        return Number.isFinite(el) ? el : null;
    if (el && typeof el === 'object') {
        const o = el;
        for (const k of Object.keys(o))
            if (typeof o[k] === 'number' && !Number.isFinite(o[k]))
                o[k] = null;
    }
    return el;
}
export function robustIndicator(core, spec) {
    const arrays = spec.kinds.length;
    const periodIdx = new Set(spec.periods ?? []);
    const wrapped = (...args) => {
        const n = toArrayLike(args[0]).length;
        const cleaned = [];
        let bad = null;
        for (let k = 0; k < arrays; k++) {
            const src = toArrayLike(args[k]);
            if (spec.kinds[k] === 'v') {
                cleaned.push(sanitizeVolume(src, n));
                continue;
            }
            if (spec.kinds[k] === 'w') {
                cleaned.push(sanitizeVolume(src, n));
                const m = nonFiniteMask(src, n);
                if (m) {
                    bad = bad ?? new Array(n).fill(false);
                    for (let i = 0; i < n; i++)
                        if (m[i])
                            bad[i] = true;
                }
                continue;
            }
            cleaned.push(sanitizeSeries(src, n));
            const m = nonFiniteMask(src, n);
            if (m) {
                bad = bad ?? new Array(n).fill(false);
                for (let i = 0; i < n; i++)
                    if (m[i])
                        bad[i] = true;
            }
        }
        // A period the caller left out keeps the core's default; only a REQUIRED
        // period (no default => idx < core.length) is filled in with 1.
        const rest = args.slice(arrays).map((a, j) => (periodIdx.has(arrays + j) && (a !== undefined || arrays + j < core.length) ? clampPeriod(a, n + 1) : a));
        for (let idx = arrays + rest.length; idx < core.length; idx++)
            if (periodIdx.has(idx))
                rest.push(1);
        const out = core(...cleaned, ...rest);
        if (!Array.isArray(out) || spec.nullable === false)
            return out;
        const res = out;
        for (let i = 0; i < res.length; i++)
            res[i] = bad && bad[i] ? nullOut(res[i], spec) : scrubElement(res[i]);
        return res;
    };
    return wrapped;
}
