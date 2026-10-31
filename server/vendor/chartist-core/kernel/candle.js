// The candlestick every indicator reads. Kept in the kernel so the maths has no dependency on the host's data layer.
/**
 * A bar is usable only if all four legs are positive and the range actually
 * contains the open and the close. That last clause is the assertion the 2026
 * corpus corruption violated on 58% of bars: an adjusted close spliced onto raw
 * O/H/L sits outside its own `[low, high]`.
 */
export function isValidCandle(c) {
    return (Number.isFinite(c.date) &&
        Number.isFinite(c.open) && c.open > 0 &&
        Number.isFinite(c.high) && c.high > 0 &&
        Number.isFinite(c.low) && c.low > 0 &&
        Number.isFinite(c.close) && c.close > 0 &&
        c.high >= c.low &&
        c.open <= c.high && c.open >= c.low &&
        c.close <= c.high && c.close >= c.low);
}
