import { clampLength, isFiniteNumber } from './priceBarGuards.js';
import { isIntradaySeries } from './anchorKeys.js';
import { barVolumeAt, buildSessions, cumulativeAt } from './sessionVolumeProfile.js';
const RVOL_DEFAULTS = { length: 10, mode: 'cumulative' };
const MAX_LOOKBACK_FACTOR = 4;
const EMPTY = { rvol: null, value: null, baseline: null };
function point(value, baseline) {
    const rvol = value !== null && baseline !== null && baseline > 0 ? value / baseline : null;
    return { rvol, value, baseline };
}
function dailyRvol(candles, length) {
    // Baseline = mean of the PREVIOUS `length` bars, the current bar excluded (I1-3, 2026-10-26), the same rule as the
    // intraday path (the current session is never part of its own baseline). Including the bar capped RVOL at `length`
    // and diluted a spike with itself.
    let sum = 0;
    let bad = 0;
    return candles.map((c, i) => {
        const baseline = i >= length && bad === 0 ? sum / length : null;
        const value = isFiniteNumber(c.volume) ? c.volume : null;
        if (isFiniteNumber(c.volume))
            sum += c.volume;
        else
            bad++;
        if (i >= length) {
            const drop = candles[i - length].volume;
            if (isFiniteNumber(drop))
                sum -= drop;
            else
                bad--;
        }
        return point(value, baseline);
    });
}
export function calcRelativeVolume(candles, opts = {}) {
    const length = clampLength(opts.length ?? RVOL_DEFAULTS.length, RVOL_DEFAULTS.length);
    const mode = opts.mode ?? RVOL_DEFAULTS.mode;
    if (candles.length === 0)
        return [];
    if (!isIntradaySeries(candles))
        return dailyRvol(candles, length);
    const sessions = buildSessions(candles);
    const out = candles.map(() => EMPTY);
    const maxWalk = MAX_LOOKBACK_FACTOR * length;
    sessions.forEach((s, si) => {
        // Baseline depends only on (session, minute); bars are visited in order.
        for (let k = 0; k < s.minutes.length; k++) {
            const t = s.minutes[k];
            const value = mode === 'cumulative' ? s.cumulative[k] : (Number.isNaN(s.volumes[k]) ? null : s.volumes[k]);
            let total = 0;
            let used = 0;
            for (let back = 1; back <= maxWalk && si - back >= 0 && used < length; back++) {
                const hist = sessions[si - back];
                const v = mode === 'cumulative' ? cumulativeAt(hist, t) : barVolumeAt(hist, t);
                if (v === null)
                    continue;
                total += v;
                used++;
            }
            out[s.indices[k]] = point(value, used === length ? total / length : null);
        }
    });
    return out;
}
