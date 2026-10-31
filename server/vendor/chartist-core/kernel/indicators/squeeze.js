/**
 * Squeeze Momentum (2026-10-26): John Carter's TTM Squeeze idea, BB(20, 2 sigma) inside KC(20, 1.5 x SMA true range),
 * with LazyBear's momentum line. Not identical to the published LazyBear script (V3-7, checked 2026-10-26): its
 * code computes the BB deviation as multKC x stdev, i.e. 1.5 sigma, a typo its author's page acknowledges; this
 * study uses the BB multiplier input (2.0 default). Set bbMult to 1.5 to reproduce the published script.
 *
 * - Bollinger Bands: SMA(close, bbLength) +/- bbMult x population stdev(close, bbLength).
 * - Keltner Channel: SMA(close, kcLength) +/- kcMult x SMA(true range, kcLength). True range of the first bar is its
 *   high - low.
 * - `on` = the squeeze is ON (both Bollinger bands inside the Keltner channel: volatility is compressed);
 *   `off` = released (both outside); neither = no clear state. Exactly one of on / off / neither per bar; null warm-up.
 * - Momentum `mom` = the end point of the least-squares line through the last kcLength values of
 *   close - ((highest(high, kcLength) + lowest(low, kcLength)) / 2 + SMA(close, kcLength)) / 2.
 * Causal: each value reads bars at or before its own.
 */
import { highestN, lowestN, nanSeries, smaN, stdevN, clampLength, finiteOr } from './seriesMath.js';
const fin = (v) => (Number.isFinite(v) ? v : null);
function linregEnd(x, n) {
    const out = nanSeries(x.length);
    const sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6;
    const den = n * sxx - sx * sx;
    for (let i = n - 1; i < x.length; i++) {
        let sy = 0, sxy = 0;
        for (let j = 0; j < n; j++) {
            const y = x[i - n + 1 + j];
            sy += y;
            sxy += j * y;
        }
        if (!Number.isFinite(sy) || !Number.isFinite(sxy))
            continue;
        const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
        out[i] = (sy - slope * sx) / n + slope * (n - 1);
    }
    return out;
}
export function calcSqueeze(highs, lows, closes, opts = {}) {
    const bbLen = clampLength(opts.bbLength ?? 20, 20), kcLen = clampLength(opts.kcLength ?? 20, 20);
    const bbMult = Math.max(0, finiteOr(opts.bbMult ?? 2, 2)), kcMult = Math.max(0, finiteOr(opts.kcMult ?? 1.5, 1.5));
    const n = closes.length;
    const c = Array.from(closes, v => (Number.isFinite(v) ? v : NaN));
    const h = Array.from(highs, v => (Number.isFinite(v) ? v : NaN)), l = Array.from(lows, v => (Number.isFinite(v) ? v : NaN));
    const tr = c.map((_, i) => (i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
    const bbMid = smaN(c, bbLen), bbDev = stdevN(c, bbLen);
    const kcMid = smaN(c, kcLen), kcRange = smaN(tr, kcLen);
    const hh = highestN(h, kcLen), ll = lowestN(l, kcLen);
    const delta = c.map((v, i) => v - ((hh[i] + ll[i]) / 2 + kcMid[i]) / 2);
    const mom = linregEnd(delta, kcLen);
    const out = [];
    for (let i = 0; i < n; i++) {
        const ub = bbMid[i] + bbMult * bbDev[i], lb = bbMid[i] - bbMult * bbDev[i];
        const uk = kcMid[i] + kcMult * kcRange[i], lk = kcMid[i] - kcMult * kcRange[i];
        if (![ub, lb, uk, lk].every(Number.isFinite)) {
            out.push({ mom: fin(mom[i]), on: null, off: null });
            continue;
        }
        const on = lb > lk && ub < uk;
        const off = lb < lk && ub > uk;
        out.push({ mom: fin(mom[i]), on, off });
    }
    return out;
}
