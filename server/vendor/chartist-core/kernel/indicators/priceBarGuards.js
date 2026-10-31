/** Finite-number check that also narrows the type. */
export function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
/** Integer length >= `min`. Non-finite input falls back to `fallback` (clamped too). */
export function clampLength(len, fallback, min = 1) {
    const raw = isFiniteNumber(len) ? Math.floor(len) : fallback;
    return Math.max(min, raw);
}
/** High, low and close are all finite (open/volume are checked where used). */
export function hasFiniteHlc(c) {
    return isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}
/** Highest value of `values[i-len+1..i]`, or null while warming up / when the window holds a non-finite value. */
export function rollingHighest(values, len) {
    return rolling(values, len, (a, b) => (b > a ? b : a));
}
/** Lowest value of `values[i-len+1..i]`, or null while warming up / when the window holds a non-finite value. */
export function rollingLowest(values, len) {
    return rolling(values, len, (a, b) => (b < a ? b : a));
}
function rolling(values, len, pick) {
    const n = clampLength(len, 1);
    const out = new Array(values.length).fill(null);
    for (let i = n - 1; i < values.length; i++) {
        let acc = values[i - n + 1];
        let ok = isFiniteNumber(acc);
        for (let j = i - n + 2; ok && j <= i; j++) {
            const v = values[j];
            if (!isFiniteNumber(v))
                ok = false;
            else
                acc = pick(acc, v);
        }
        out[i] = ok ? acc : null;
    }
    return out;
}
