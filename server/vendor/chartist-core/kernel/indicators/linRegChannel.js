import { clampLength, isFiniteNumber } from './priceBarGuards.js';
/** OLS fit of `values` on x = 0..n-1. Returns null for n < 1 or any non-finite value. */
export function linearRegressionFit(values) {
    const n = values.length;
    if (n < 1)
        return null;
    let sumY = 0;
    for (const v of values) {
        if (!isFiniteNumber(v))
            return null;
        sumY += v;
    }
    const meanY = sumY / n;
    const meanX = (n - 1) / 2;
    let sxx = 0, sxy = 0, syy = 0;
    for (let x = 0; x < n; x++) {
        const dx = x - meanX;
        const dy = values[x] - meanY;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = meanY - slope * meanX;
    let sse = 0;
    for (let x = 0; x < n; x++) {
        const r = values[x] - (intercept + slope * x);
        sse += r * r;
    }
    return {
        slope,
        intercept,
        endValue: intercept + slope * (n - 1),
        r2: syy === 0 ? 1 : Math.max(0, 1 - sse / syy),
        residualSd: Math.sqrt(sse / n),
    };
}
const LINREG_CHANNEL_DEFAULTS = { length: 100, deviations: 2 };
/** Rolling slope of a series (price per bar), null during warm-up. */
export function rollingSlope(values, length) {
    const n = clampLength(length, LINREG_CHANNEL_DEFAULTS.length);
    return values.map((_, i) => (i < n - 1 ? null : linearRegressionFit(values.slice(i - n + 1, i + 1))?.slope ?? null));
}
/** Rolling R² of a series against time, null during warm-up. */
export function rollingR2(values, length) {
    const n = clampLength(length, LINREG_CHANNEL_DEFAULTS.length);
    return values.map((_, i) => (i < n - 1 ? null : linearRegressionFit(values.slice(i - n + 1, i + 1))?.r2 ?? null));
}
export function calcLinRegChannel(candles, opts = {}) {
    const n = clampLength(opts.length ?? LINREG_CHANNEL_DEFAULTS.length, LINREG_CHANNEL_DEFAULTS.length);
    const mult = isFiniteNumber(opts.deviations) ? opts.deviations : LINREG_CHANNEL_DEFAULTS.deviations;
    const src = candles.map(c => c.close);
    return src.map((_, i) => {
        const empty = { mid: null, upper: null, lower: null, slope: null, r2: null };
        if (i < n - 1)
            return empty;
        const fit = linearRegressionFit(src.slice(i - n + 1, i + 1));
        if (!fit)
            return empty;
        return {
            mid: fit.endValue,
            upper: fit.endValue + mult * fit.residualSd,
            lower: fit.endValue - mult * fit.residualSd,
            slope: fit.slope,
            r2: fit.r2,
        };
    });
}
