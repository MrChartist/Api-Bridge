/** Klinger Volume Oscillator, the reference platform's built-in definition. */
import { clampLength, emaN, nanSeries, toNums, } from './seriesMath.js';
/**
 * Signed volume sv = +volume when hlc3 rose or held vs the prior bar, -volume
 * when it fell. KVO = EMA(sv, fast) - EMA(sv, slow); signal = EMA(KVO, signal).
 * First KVO on bar `slow`, signal `signal - 1` bars later.
 */
export function calcKlinger(highs, lows, closes, volumes, fast = 34, slow = 55, signal = 13) {
    const h = toNums(highs);
    const l = toNums(lows);
    const c = toNums(closes);
    const v = toNums(volumes);
    const sv = nanSeries(c.length);
    for (let i = 1; i < c.length; i++) {
        const change = (h[i] + l[i] + c[i]) / 3 - (h[i - 1] + l[i - 1] + c[i - 1]) / 3;
        if (Number.isFinite(change) && Number.isFinite(v[i]))
            sv[i] = change >= 0 ? v[i] : -v[i];
    }
    const fastEma = emaN(sv, clampLength(fast, 34));
    const slowEma = emaN(sv, clampLength(slow, 55));
    const kvo = fastEma.map((f, i) => f - slowEma[i]);
    const sig = emaN(kvo, clampLength(signal, 13));
    return kvo.map((k, i) => ({
        kvo: Number.isFinite(k) ? k : null,
        signal: Number.isFinite(sig[i]) ? sig[i] : null,
    }));
}
