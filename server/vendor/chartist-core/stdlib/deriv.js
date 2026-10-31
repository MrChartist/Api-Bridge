// `fut.*` and `opt.*` (S31, stage 2): end-of-day derivative readings as one number per candlestick.
//
// Each candlestick is matched to the derivative file of the SAME trading day, by date. A candlestick with no file that day has no
// value (missing, not carried forward from an earlier day). Nothing here looks at a later day, so the values are causal: a
// reading on day t is what the exchange's file for day t says. `iv_rank` looks back over earlier days only.
//
// The data is supplied by the host as `deriv` (a `DerivInput`). A host that did not supply any stops the run with MissingData,
// and a stock that has no derivatives (`own: null`) has missing values everywhere; neither is read as zero.
import { atmIvOf, atmIvSeries, futBasisPct, futBuildup, futClose, futOi, futOiChange, futRollover, ivRankAt, maxPainOf, pcrOiOf, pcrVolumeOf, } from '../derivatives/series.js';
import { MissingData, RuntimeError } from '../runtime/errors.js';
const U = Number.NaN;
const textAt = (ctx, k) => {
    const a = ctx.args[k];
    if (!a || !('t' in a))
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} needs text as argument ${k + 1}`);
    return a.t;
};
const numberAt = (ctx, k) => {
    const a = ctx.args[k];
    if (!a || !('c' in a))
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} needs a fixed number as argument ${k + 1}`);
    return a.c;
};
/** The series for the underlying named in argument `k` (empty text: the stock itself). */
function seriesFor(ctx, k) {
    const d = ctx.deriv;
    if (d === undefined)
        throw new MissingData('options and futures data');
    const u = textAt(ctx, k).trim().toUpperCase();
    if (u === '')
        return d.own;
    const named = d.named;
    if (named === undefined || !Object.hasOwn(named, u))
        throw new MissingData(`options and futures data for ${u}`);
    return named[u];
}
/**
 * Each candlestick's day in the series, by exact date, or -1. Both lists ascend, so one pass finds them all.
 * (A date that appears twice in `dates` is the host's mistake and gets the same day twice, not a crash.)
 */
export function alignDays(series, dates) {
    const out = new Int32Array(dates.length).fill(-1);
    let j = 0;
    for (let i = 0; i < dates.length; i++) {
        while (j < series.days.length && series.days[j].date < dates[i])
            j++;
        if (j < series.days.length && series.days[j].date === dates[i])
            out[i] = j;
    }
    return out;
}
/** A reading of one day, matched to the candlesticks. `u` is argument 0 unless the function says otherwise. */
function daily(read, uArg = 0) {
    return (ctx) => {
        const s = seriesFor(ctx, uArg);
        const out = new Float64Array(ctx.n).fill(U);
        if (!s)
            return out;
        ctx.touch(ctx.n + s.days.length);
        const at = alignDays(s, ctx.bars.date);
        for (let i = 0; i < ctx.n; i++) {
            if (at[i] < 0)
                continue;
            const v = read(s.days[at[i]], ctx);
            if (v !== null && Number.isFinite(v))
                out[i] = v;
        }
        return out;
    };
}
const expiryOf = (ctx) => numberAt(ctx, 1);
export const DERIV_RUNTIME = {
    'fut.close': daily((d) => futClose(d)),
    'fut.basis': daily((d) => futBasisPct(d)),
    'fut.oi': daily((d) => futOi(d)),
    'fut.oi_chg': daily((d) => futOiChange(d)),
    'fut.rollover': daily((d) => futRollover(d)),
    // True or false on a day that has a reading; missing on a day that has none (so "not a long build-up" is never claimed for no data).
    'fut.buildup': (ctx) => {
        const kind = textAt(ctx, 0);
        const read = daily((d) => {
            const b = futBuildup(d);
            return b === null ? null : b === kind ? 1 : 0;
        }, 1);
        return read(ctx);
    },
    'opt.pcr_oi': daily((d, ctx) => pcrOiOf(d, expiryOf(ctx))),
    'opt.pcr_vol': daily((d, ctx) => pcrVolumeOf(d, expiryOf(ctx))),
    'opt.max_pain': daily((d, ctx) => maxPainOf(d, expiryOf(ctx))),
    'opt.atm_iv': (ctx) => {
        const dte = numberAt(ctx, 1);
        const rate = ctx.deriv?.rate ?? 0;
        return daily((d) => atmIvOf(d, dte, rate))(ctx);
    },
    'opt.iv_rank': (ctx) => {
        const s = seriesFor(ctx, 0);
        const n = numberAt(ctx, 1);
        const out = new Float64Array(ctx.n).fill(U);
        if (!s)
            return out;
        ctx.touch(ctx.n + s.days.length * (n + 1));
        const history = atmIvSeries(s, IV_RANK_DTE, ctx.deriv?.rate ?? 0);
        const at = alignDays(s, ctx.bars.date);
        for (let i = 0; i < ctx.n; i++) {
            if (at[i] < 0)
                continue;
            const v = ivRankAt(history, at[i], n);
            if (v !== null && Number.isFinite(v))
                out[i] = v;
        }
        return out;
    },
};
/** The expiry distance (days) of the volatility that `opt.iv_rank` ranks. */
export const IV_RANK_DTE = 30;
