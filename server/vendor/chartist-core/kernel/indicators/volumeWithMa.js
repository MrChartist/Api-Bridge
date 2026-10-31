import { clampLength, isFiniteNumber } from './priceBarGuards.js';
const VOLUME_MA_DEFAULT_LENGTH = 20;
export function calcVolumeWithMa(candles, maLength = VOLUME_MA_DEFAULT_LENGTH) {
    const n = clampLength(maLength, VOLUME_MA_DEFAULT_LENGTH);
    const out = [];
    let sum = 0;
    let bad = 0; // non-finite volumes currently inside the window
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const add = c.volume;
        if (isFiniteNumber(add))
            sum += add;
        else
            bad++;
        if (i >= n) {
            const drop = candles[i - n].volume;
            if (isFiniteNumber(drop))
                sum -= drop;
            else
                bad--;
        }
        out.push({
            volume: isFiniteNumber(c.volume) ? c.volume : null,
            ma: i >= n - 1 && bad === 0 ? sum / n : null,
            up: c.close >= c.open,
        });
    }
    return out;
}
