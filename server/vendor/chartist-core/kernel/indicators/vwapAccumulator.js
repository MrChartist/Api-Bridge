import { isFiniteNumber } from './priceBarGuards.js';
const DEFAULT_BAND_MULTIPLIERS = [1, 2, 3];
export function emptyVwapPoint() {
    return { vwap: null, upper1: null, lower1: null, upper2: null, lower2: null, upper3: null, lower3: null };
}
/** Bar price for the chosen source, or NaN when a leg is not finite. */
export function vwapSourcePrice(c, source) {
    switch (source) {
        case 'close': return c.close;
        case 'hl2': return (c.high + c.low) / 2;
        case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
        case 'hlc3': return (c.high + c.low + c.close) / 3;
    }
}
/** Resolve user multipliers, falling back to 1/2/3 for anything not a finite number >= 0. */
export function resolveBandMultipliers(m) {
    const pick = (i) => (m && isFiniteNumber(m[i]) && m[i] >= 0 ? m[i] : DEFAULT_BAND_MULTIPLIERS[i]);
    return [pick(0), pick(1), pick(2)];
}
export function createVwapAccumulator() {
    let pv = 0;
    let v = 0;
    let p2v = 0;
    return {
        add(price, volume) {
            if (!isFiniteNumber(price) || !isFiniteNumber(volume) || volume < 0)
                return false;
            pv += price * volume;
            p2v += price * price * volume;
            v += volume;
            return true;
        },
        reset() { pv = 0; v = 0; p2v = 0; },
        read(mults) {
            if (v <= 0)
                return emptyVwapPoint();
            const vwap = pv / v;
            const dev = Math.sqrt(Math.max(p2v / v - vwap * vwap, 0));
            return {
                vwap,
                upper1: vwap + mults[0] * dev, lower1: vwap - mults[0] * dev,
                upper2: vwap + mults[1] * dev, lower2: vwap - mults[1] * dev,
                upper3: vwap + mults[2] * dev, lower3: vwap - mults[2] * dev,
            };
        },
    };
}
