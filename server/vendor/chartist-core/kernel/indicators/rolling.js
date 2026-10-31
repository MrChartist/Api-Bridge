/**
 * Rolling-window primitives: O(n) replacements for the slice-per-bar loops.
 * Inputs must be finite (callers sanitise first). Every result matches the
 * naive per-window implementation to well under 1e-9 (asserted in tests).
 */
/** Simple rolling mean. Running sum, re-summed exactly once per window length. */
export function rollingMean(values, period) {
    const n = values.length;
    const out = new Array(n).fill(null);
    if (period < 1 || period > n)
        return out;
    let sum = 0;
    for (let j = 0; j < period; j++)
        sum += values[j];
    out[period - 1] = sum / period;
    for (let i = period; i < n; i++) {
        if ((i - (period - 1)) % period === 0) {
            sum = 0; // drift guard: exact re-sum, amortised O(1) per bar
            for (let j = i - period + 1; j <= i; j++)
                sum += values[j];
        }
        else {
            sum += values[i] - values[i - period];
        }
        out[i] = sum / period;
    }
    return out;
}
/**
 * Rolling mean + population standard deviation (sliding Welford update).
 * A flat window is exactly 0: whenever the running M2 collapses versus its
 * recent peak (or every `period` bars) it is recomputed exactly two-pass, so no
 * cancellation residue survives a volatility spike leaving the window.
 */
export function rollingMeanStd(values, period) {
    const n = values.length;
    const mean = new Array(n).fill(null);
    const std = new Array(n).fill(null);
    if (period < 1 || period > n)
        return { mean, std };
    let m = 0, m2 = 0, peak = 0;
    const exact = (end) => {
        let s = 0;
        for (let j = end - period + 1; j <= end; j++)
            s += values[j];
        m = s / period;
        m2 = 0;
        for (let j = end - period + 1; j <= end; j++)
            m2 += (values[j] - m) ** 2;
        peak = m2;
    };
    // A flat window (spread within 1e-12 of its size) has a deviation of exactly 0, as ta.stdev gives (2026-10-25, B2-7).
    const hiIdx = slidingExtremeIndex(values, period, 'max');
    const loIdx = slidingExtremeIndex(values, period, 'min');
    const flat = (i) => {
        const hi = values[hiIdx[i]], lo = values[loIdx[i]];
        return hi - lo <= 1e-12 * Math.max(1, Math.abs(hi), Math.abs(lo));
    };
    exact(period - 1);
    mean[period - 1] = m;
    std[period - 1] = flat(period - 1) ? 0 : Math.sqrt(m2 / period);
    for (let i = period; i < n; i++) {
        const xo = values[i - period], xn = values[i];
        const oldMean = m;
        m = oldMean + (xn - xo) / period;
        m2 += (xn - xo) * (xn - m + xo - oldMean);
        if (m2 > peak)
            peak = m2;
        if ((i - (period - 1)) % period === 0 || m2 < 0 || m2 < 1e-4 * peak)
            exact(i);
        mean[i] = m;
        std[i] = flat(i) ? 0 : Math.sqrt(m2 / period);
    }
    return { mean, std };
}
/**
 * Monotonic-deque sliding extreme. Returns, per bar, the index of the extreme
 * inside the trailing `span` bars (LAST occurrence on ties, matching a
 * forward `>=`/`<=` scan), or -1 until the span has filled.
 */
export function slidingExtremeIndex(values, span, mode) {
    const n = values.length;
    const out = new Array(n).fill(-1);
    const dq = new Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        while (tail > head && (mode === 'max' ? values[dq[tail - 1]] <= v : values[dq[tail - 1]] >= v))
            tail--;
        dq[tail++] = i;
        if (dq[head] <= i - span)
            head++;
        if (i >= span - 1)
            out[i] = dq[head];
    }
    return out;
}
export function rollingMax(values, span) {
    return slidingExtremeIndex(values, span, 'max').map(k => (k < 0 ? null : values[k]));
}
export function rollingMin(values, span) {
    return slidingExtremeIndex(values, span, 'min').map(k => (k < 0 ? null : values[k]));
}
/**
 * Pine-style SMA over a series that may hold nulls anywhere: a window that
 * contains any null is null (ta.sma propagates na).
 */
export function rollingMeanStrict(values, period) {
    const n = values.length;
    const out = new Array(n).fill(null);
    if (period < 1)
        return out;
    let sum = 0, nulls = 0;
    for (let i = 0; i < n; i++) {
        const v = values[i];
        if (v === null)
            nulls++;
        else
            sum += v;
        if (i >= period) {
            const o = values[i - period];
            if (o === null)
                nulls--;
            else
                sum -= o;
        }
        if (i >= period - 1 && nulls === 0) {
            if ((i - (period - 1)) % period === 0) { // drift guard
                sum = 0;
                for (let j = i - period + 1; j <= i; j++)
                    sum += values[j];
            }
            out[i] = sum / period;
        }
    }
    return out;
}
