/** Finite number or NaN — the internal "no value" encoding. */
function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}
export function toNums(values) {
    if (!values)
        return [];
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++)
        out[i] = num(values[i]);
    return out;
}
export function fromNums(values) {
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++)
        out[i] = Number.isFinite(values[i]) ? values[i] : null;
    return out;
}
/** Integer length >= 1; a non-finite request falls back to `fallback`. */
export function clampLength(length, fallback) {
    const n = typeof length === 'number' && Number.isFinite(length) ? Math.floor(length) : fallback;
    return Math.max(1, n);
}
/** Finite request or `fallback` (for offsets, multipliers, percentages). */
export function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function nanSeries(n) {
    return new Array(n).fill(NaN);
}
/** Simple moving average; NaN until a full window of finite bars exists. */
export function smaN(x, length) {
    const out = nanSeries(x.length);
    for (let i = length - 1; i < x.length; i++) {
        let sum = 0;
        for (let j = i - length + 1; j <= i; j++)
            sum += x[j];
        if (Number.isFinite(sum))
            out[i] = sum / length;
    }
    return out;
}
/**
 * Recursive average with an SMA seed: the first value lands on the bar that
 * completes `length` consecutive finite inputs, then `step(prev, value)` runs.
 * A non-finite input resets the state.
 */
export function recursiveN(x, length, step) {
    const out = nanSeries(x.length);
    let prev = NaN;
    let run = 0;
    let seedSum = 0;
    for (let i = 0; i < x.length; i++) {
        const v = x[i];
        if (!Number.isFinite(v)) {
            prev = NaN;
            run = 0;
            seedSum = 0;
            continue;
        }
        if (Number.isNaN(prev)) {
            run++;
            seedSum += v;
            if (run === length) {
                prev = seedSum / length;
                out[i] = prev;
            }
            continue;
        }
        prev = step(prev, v);
        out[i] = prev;
    }
    return out;
}
/** EMA with alpha 2 / (length + 1), SMA-seeded (matches calcEMA). */
export function emaN(x, length) {
    const k = 2 / (length + 1);
    return recursiveN(x, length, (prev, v) => v * k + prev * (1 - k));
}
/** Wilder RMA (alpha 1 / length), SMA-seeded (matches ta.rma). */
export function rmaN(x, length) {
    return recursiveN(x, length, (prev, v) => (prev * (length - 1) + v) / length);
}
/** Linearly weighted MA, newest bar weighted `length`, oldest 1. */
export function wmaN(x, length) {
    const out = nanSeries(x.length);
    const denom = (length * (length + 1)) / 2;
    for (let i = length - 1; i < x.length; i++) {
        let sum = 0;
        for (let j = 0; j < length; j++)
            sum += x[i - length + 1 + j] * (j + 1);
        if (Number.isFinite(sum))
            out[i] = sum / denom;
    }
    return out;
}
/** Population standard deviation (Pine's biased `ta.stdev`). */
export function stdevN(x, length) {
    const out = nanSeries(x.length);
    for (let i = length - 1; i < x.length; i++) {
        let sum = 0;
        for (let j = i - length + 1; j <= i; j++)
            sum += x[j];
        if (!Number.isFinite(sum))
            continue;
        const mean = sum / length;
        let sq = 0;
        for (let j = i - length + 1; j <= i; j++)
            sq += (x[j] - mean) ** 2;
        out[i] = Math.sqrt(sq / length);
    }
    return out;
}
export function highestN(x, length) {
    const out = nanSeries(x.length);
    for (let i = length - 1; i < x.length; i++) {
        let best = -Infinity;
        for (let j = i - length + 1; j <= i; j++) {
            if (!Number.isFinite(x[j])) {
                best = NaN;
                break;
            }
            if (x[j] > best)
                best = x[j];
        }
        out[i] = best;
    }
    return out;
}
export function lowestN(x, length) {
    const out = nanSeries(x.length);
    for (let i = length - 1; i < x.length; i++) {
        let best = Infinity;
        for (let j = i - length + 1; j <= i; j++) {
            if (!Number.isFinite(x[j])) {
                best = NaN;
                break;
            }
            if (x[j] < best)
                best = x[j];
        }
        out[i] = best;
    }
    return out;
}
/** Pine `ta.swma`: weights 1, 2, 2, 1 over the last four bars (oldest first). */
export function swmaN(x) {
    const out = nanSeries(x.length);
    for (let i = 3; i < x.length; i++) {
        const v = (x[i - 3] + 2 * x[i - 2] + 2 * x[i - 1] + x[i]) / 6;
        if (Number.isFinite(v))
            out[i] = v;
    }
    return out;
}
/** x[i] - x[i - length], NaN until the lookback exists. */
export function changeN(x, length) {
    const out = nanSeries(x.length);
    for (let i = length; i < x.length; i++) {
        const v = x[i] - x[i - length];
        if (Number.isFinite(v))
            out[i] = v;
    }
    return out;
}
