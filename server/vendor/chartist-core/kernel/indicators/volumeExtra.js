/**
 * Extra volume studies: Price Volume Trend, Negative/Positive Volume Index
 * and Net Volume. Aligned 1:1 with the input; bar 0 has no prior bar, so the
 * change-based studies are null there (NVI/PVI start at their seed value).
 */
import { finiteOr, fromNums, nanSeries, toNums } from './seriesMath.js';
/** PVT = running sum of (close - close[1]) / close[1] * volume. First value on bar 1. */
export function calcPVT(closes, volumes) {
    const c = toNums(closes);
    const v = toNums(volumes);
    const out = nanSeries(c.length);
    let acc = 0;
    for (let i = 1; i < c.length; i++) {
        const step = ((c[i] - c[i - 1]) / c[i - 1]) * v[i];
        if (Number.isFinite(step)) {
            acc += step;
            out[i] = acc;
        }
        else {
            out[i] = NaN;
        }
    }
    return fromNums(out);
}
/**
 * Shared engine for NVI / PVI: the index only moves on bars whose volume
 * moved in the tracked direction versus the previous bar, by that bar's
 * percentage price change. A bar (or previous bar) with unusable data holds
 * the index flat; an unusable current bar prints null.
 */
function volumeIndex(closes, volumes, start, tracksLower) {
    const c = toNums(closes);
    const v = toNums(volumes);
    const out = nanSeries(c.length);
    let idx = finiteOr(start, 1000);
    if (c.length > 0)
        out[0] = Number.isFinite(c[0]) ? idx : NaN;
    for (let i = 1; i < c.length; i++) {
        if (!Number.isFinite(c[i]) || !Number.isFinite(v[i]))
            continue;
        const hasPrev = Number.isFinite(c[i - 1]) && c[i - 1] !== 0 && Number.isFinite(v[i - 1]);
        const moved = hasPrev && (tracksLower ? v[i] < v[i - 1] : v[i] > v[i - 1]);
        if (moved)
            idx += (idx * (c[i] - c[i - 1])) / c[i - 1];
        out[i] = idx;
    }
    return fromNums(out);
}
/** Negative Volume Index: moves only when volume falls. Seed 1000. */
export function calcNVI(closes, volumes, start = 1000) {
    return volumeIndex(closes, volumes, start, true);
}
/** Positive Volume Index: moves only when volume rises. Seed 1000. */
export function calcPVI(closes, volumes, start = 1000) {
    return volumeIndex(closes, volumes, start, false);
}
/** Net Volume: +volume on an up close, -volume on a down close, 0 when unchanged. */
export function calcNetVolume(closes, volumes) {
    const c = toNums(closes);
    const v = toNums(volumes);
    const out = nanSeries(c.length);
    for (let i = 1; i < c.length; i++) {
        const d = c[i] - c[i - 1];
        if (!Number.isFinite(d) || !Number.isFinite(v[i]))
            continue;
        out[i] = d > 0 ? v[i] : d < 0 ? -v[i] : 0;
    }
    return fromNums(out);
}
