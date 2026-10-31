/**
 * Settings variants of classic studies (2026-10-26), composed from the existing kernel calculators so there is one
 * engine: an average-type choice on a signal line or a band centre, and the slow stochastic's %K smoothing.
 * Each variant at its default setting is not called (the chart calls the classic calculator), so the classic
 * numbers are unchanged.
 */
import { calcMACD, calcStochastic, calcATR } from './classic.js';
import { maByType } from './maByType.js';
import { rollingMeanStd } from './rolling.js';
/** MACD whose signal line is an average of `signalType` (SMA, EMA, RMA, WMA, HMA) of the MACD line. */
export function macdWithSignalType(closes, fast, slow, signal, signalType) {
    const base = calcMACD(closes, fast, slow, signal);
    if (signalType === 'ema')
        return base;
    const line = base.map(r => r.macd);
    const sig = maByType(signalType === 'vwma' ? 'sma' : signalType, line, signal);
    return base.map((r, i) => {
        const s = r.macd === null ? null : sig[i];
        return { macd: r.macd, signal: s ?? null, hist: r.macd !== null && s !== null && s !== undefined ? r.macd - s : null };
    });
}
/** Bollinger Bands whose basis is an average of `maType`; the width stays mult x population stdev of the source. */
export function bbWithMaType(values, length, mult, maType, volumes) {
    const { std } = rollingMeanStd(values, length);
    const mid = maByType(maType, values, length, volumes);
    return values.map((_, i) => {
        const m = mid[i], sd = std[i];
        if (m === null || m === undefined || sd === null)
            return { upper: null, mid: null, lower: null };
        return { upper: m + mult * sd, mid: m, lower: m - mult * sd };
    });
}
/** Keltner Channel with an SMA (or other) centre line and its own ATR length. */
export function keltnerWithMaType(highs, lows, closes, length, mult, atrLength, maType) {
    const mid = maByType(maType, closes, length);
    const atr = calcATR(highs, lows, closes, atrLength);
    return closes.map((_, i) => {
        const m = mid[i], a = atr[i];
        if (m === null || m === undefined || a === null || a === undefined)
            return { upper: null, mid: null, lower: null };
        return { upper: m + mult * a, mid: m, lower: m - mult * a };
    });
}
/**
 * Slow stochastic: %K = SMA(raw %K, kSmooth), %D = SMA(%K, dLength). kSmooth 1 is the fast stochastic, exactly the
 * classic `calcStochastic`.
 */
export function slowStochastic(highs, lows, closes, length, kSmooth, dLength) {
    if (!(kSmooth > 1))
        return calcStochastic(highs, lows, closes, length, dLength);
    const raw = calcStochastic(highs, lows, closes, length, 1).map(r => r.k);
    const k = maByType('sma', raw, kSmooth);
    const d = maByType('sma', k, dLength);
    return k.map((v, i) => ({ k: v ?? null, d: v === null ? null : d[i] ?? null }));
}
