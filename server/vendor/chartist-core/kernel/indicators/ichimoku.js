/**
 * Ichimoku Cloud with reference-platform displacement.
 *
 * The two leading lines (average of tenkan and kijun; the donchian midpoint over the senkou-B period) are shifted
 * forward by displacement - 1 bars, and the lagging close is shifted back by the same amount. The displacement is 26,
 * i.e. a shift of (kijunPeriod - 1) = 25 bars.
 *
 * The output array is index-aligned with the candle array (same length):
 *   senkouA/B[i] = raw value computed at bar i - 25   (null until available)
 *   chikou[i]    = close[i + 25]                      (null for the last 25 bars)
 *   tenkan/kijun are not displaced.
 * The cloud's future part (slots beyond the last candle) is NOT in this array;
 * `ichimokuFutureCloud` returns it so the renderer can draw it as a follow-up.
 */
import { clampPeriod, nonFiniteMask, sanitizeSeries } from './sanitize.js';
import { rollingMax, rollingMin } from './rolling.js';
function midpoint(highs, lows, period) {
    const hh = rollingMax(highs, period), ll = rollingMin(lows, period);
    return hh.map((h, i) => (h === null || ll[i] === null ? null : (h + ll[i]) / 2));
}
function ichimokuRaw(highs, lows, tenkanP, kijunP, senkouBP) {
    const tenkan = midpoint(highs, lows, tenkanP);
    const kijun = midpoint(highs, lows, kijunP);
    const senkouA = tenkan.map((t, i) => (t === null || kijun[i] === null ? null : (t + kijun[i]) / 2));
    const senkouB = midpoint(highs, lows, senkouBP);
    return { tenkan, kijun, senkouA, senkouB, displacement: kijunP - 1 };
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function calcIchimoku(highs, lows, closes, tenkanP = 9, kijunP = 26, senkouBP = 52) {
    const n = Array.isArray(closes) ? closes.length : 0;
    const h = sanitizeSeries(Array.isArray(highs) ? highs : [], n);
    const l = sanitizeSeries(Array.isArray(lows) ? lows : [], n);
    const c = sanitizeSeries(closes ?? [], n);
    const bad = [nonFiniteMask(highs ?? [], n), nonFiniteMask(lows ?? [], n), nonFiniteMask(closes ?? [], n)];
    const isBad = (i) => i >= 0 && i < n && bad.some(m => m !== null && m[i]);
    const raw = ichimokuRaw(h, l, clampPeriod(tenkanP, n + 1), clampPeriod(kijunP, n + 1), clampPeriod(senkouBP, n + 1));
    const d = raw.displacement;
    const out = [];
    for (let i = 0; i < n; i++) {
        const src = i - d; // bar the cloud value was computed on
        const cloudOk = src >= 0 && !isBad(src);
        out.push({
            tenkan: isBad(i) ? null : num(raw.tenkan[i]),
            kijun: isBad(i) ? null : num(raw.kijun[i]),
            senkouA: cloudOk ? num(raw.senkouA[src]) : null,
            senkouB: cloudOk ? num(raw.senkouB[src]) : null,
            chikou: i + d < n && !isBad(i + d) ? c[i + d] : null,
        });
    }
    return out;
}
/**
 * The part of the cloud that projects past the last candle:
 * slot j (barsAhead = j + 1) shows the raw value computed at bar n - d + j.
 * Returns `kijunP - 1` slots (25 with defaults).
 */
export function ichimokuFutureCloud(highs, lows, closes, tenkanP = 9, kijunP = 26, senkouBP = 52) {
    const n = Array.isArray(closes) ? closes.length : 0;
    const h = sanitizeSeries(Array.isArray(highs) ? highs : [], n);
    const l = sanitizeSeries(Array.isArray(lows) ? lows : [], n);
    const bad = [nonFiniteMask(highs ?? [], n), nonFiniteMask(lows ?? [], n), nonFiniteMask(closes ?? [], n)];
    const raw = ichimokuRaw(h, l, clampPeriod(tenkanP, n + 1), clampPeriod(kijunP, n + 1), clampPeriod(senkouBP, n + 1));
    const d = raw.displacement;
    const slots = [];
    for (let j = 0; j < d; j++) {
        const src = n - d + j;
        const ok = src >= 0 && src < n && !bad.some(m => m !== null && m[src]);
        slots.push({ barsAhead: j + 1, senkouA: ok ? num(raw.senkouA[src]) : null, senkouB: ok ? num(raw.senkouB[src]) : null });
    }
    return slots;
}
