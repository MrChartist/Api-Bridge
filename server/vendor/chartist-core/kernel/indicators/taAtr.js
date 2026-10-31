import { clampLength, hasFiniteHlc } from './priceBarGuards.js';
export function calcTaAtr(candles, length = 14) {
    const n = clampLength(length, 14);
    const out = new Array(candles.length).fill(null);
    let prevClose = null;
    let atr = null;
    let seedSum = 0;
    let seedCount = 0;
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!hasFiniteHlc(c))
            continue;
        const tr = prevClose === null
            ? c.high - c.low
            : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
        prevClose = c.close;
        if (atr === null) {
            seedSum += tr;
            seedCount++;
            if (seedCount === n)
                atr = seedSum / n;
        }
        else {
            atr = (atr * (n - 1) + tr) / n;
        }
        out[i] = atr;
    }
    return out;
}
