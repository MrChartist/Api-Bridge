import { seriesSpacing } from './anchorKeys.js';
import { vwapWithAnchor, vwapSessionSupported } from './sessionVwap.js';
export const CLASSIC_VWAP_ANCHORS = ['auto', 'session', 'week', 'month', 'year'];
/** The anchor the classic VWAP resets on for this series and setting. */
export function classicVwapAnchor(candles, anchor = 'auto') {
    const asked = CLASSIC_VWAP_ANCHORS.includes(anchor) ? anchor : 'auto';
    if (asked !== 'auto' && asked !== 'session')
        return asked;
    if (vwapSessionSupported(candles))
        return 'session';
    const spacing = seriesSpacing(candles);
    return spacing === 'weekly' || spacing === 'monthly' ? 'year' : 'month';
}
const band = (v, def) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10 ? v : def);
const points = (candles, opts = {}) => vwapWithAnchor(candles, { anchor: classicVwapAnchor(candles, opts.anchor), bandMultipliers: [band(opts.band1, 1), band(opts.band2, 2), 3] });
export function sessionAwareVwap(candles, opts = {}) {
    return points(candles, opts).map(p => p.vwap);
}
/** Same shape the VWAP Bands drawing has always read (bands 1 and 2). */
export function sessionAwareVwapBands(candles, opts = {}) {
    return points(candles, opts).map(p => ({ vwap: p.vwap, upper1: p.upper1, lower1: p.lower1, upper2: p.upper2, lower2: p.lower2 }));
}
