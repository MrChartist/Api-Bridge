// `levels.*(side)` (S10): the nightly support and resistance record of one symbol, as numbers for the latest candlestick.
// The record is read by the kernel's `deriveLevelFields` (the same function the screener's level fields use), so
// `levels.touches("support") >= 4` and the older `supportTouches >= 4` are one question.
//
// Honesty rules:
// - The record is stamped with the last bar it read. It is used only when that is the date of the latest candlestick of
//   the run; for any other date every `levels.*` is missing (a record from a later bar would look into the future).
// - "No level on that side" and "no break to date" are missing values, not 0 and not a large number.
// - They exist for the latest candlestick only. The checker already refuses them inside a window or a shift.
import { NO_BREAK_BARS, NO_LEVEL_DISTANCE, deriveLevelFields } from '../kernel/levels.js';
import { MissingData, RuntimeError } from '../runtime/errors.js';
const U = Number.NaN;
const ymdOfMs = (ms) => {
    const d = new Date(ms);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
/** A snapshot value as a series: missing everywhere except the latest candlestick. */
export function snapshotSeries(n, value) {
    const a = new Float64Array(n).fill(U);
    if (n > 0)
        a[n - 1] = Number.isFinite(value) ? value : U;
    return a;
}
function sideOf(ctx) {
    const a = ctx.args[0];
    const t = a && 't' in a ? a.t : undefined;
    if (t !== 'support' && t !== 'resistance')
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} needs "support" or "resistance"`);
    return t;
}
/** The flat fields for this run, or null when there is no usable record for the latest candlestick. */
function fieldsFor(ctx) {
    const rec = ctx.snapshots.levels;
    if (rec === undefined)
        throw new MissingData('the nightly support and resistance levels');
    if (rec === null || ctx.n === 0)
        return null;
    if (!(ymdOfMs(rec.asOf) === ctx.bars.date[ctx.n - 1]))
        return null;
    return deriveLevelFields(rec);
}
const pick = (side, support, resistance) => (side === 'support' ? support : resistance);
/** `tf="D"` (the default) or `"W"`. The checker has already limited it to these two. */
function weekly(ctx) {
    const a = ctx.args[1];
    return !!a && 't' in a && a.t === 'W';
}
function levelFunction(read) {
    return (ctx) => {
        const side = sideOf(ctx);
        ctx.touch(ctx.n + 1);
        const f = fieldsFor(ctx);
        return snapshotSeries(ctx.n, f ? read(f, side, weekly(ctx)) : U);
    };
}
/** A level exists on a side when its price is positive (the flat fields use 0 for none). */
const hasLevel = (f, side) => pick(side, f.supportPrice, f.resistancePrice) > 0;
export const LEVEL_FUNCTIONS = {
    'levels.nearest': levelFunction((f, side) => (hasLevel(f, side) ? pick(side, f.supportPrice, f.resistancePrice) : U)),
    'levels.dist_pct': levelFunction((f, side, w) => {
        const d = w ? pick(side, f.nearestSupportPctW, f.nearestResistancePctW) : pick(side, f.nearestSupportPct, f.nearestResistancePct);
        return d === NO_LEVEL_DISTANCE ? U : d;
    }),
    // A strength of 0 is "no level on that side" in the flat fields, so it reads as missing, never as a weak level.
    'levels.strength': levelFunction((f, side, w) => {
        const v = w ? pick(side, f.supportStrengthW, f.resistanceStrengthW) : pick(side, f.supportStrength, f.resistanceStrength);
        return v > 0 ? v : U;
    }),
    'levels.range_pct': (ctx) => {
        ctx.touch(ctx.n + 1);
        const f = fieldsFor(ctx);
        return snapshotSeries(ctx.n, f && f.levelRangePct > 0 ? f.levelRangePct : U);
    },
    'levels.broken_bars': levelFunction((f, side) => {
        const b = pick(side, f.supportBreakBars, f.resistanceBreakBars);
        return b === NO_BREAK_BARS ? U : b;
    }),
    'levels.broken_held_bars': levelFunction((f, side) => {
        const b = pick(side, f.supportBreakBars, f.resistanceBreakBars);
        return b === NO_BREAK_BARS ? U : pick(side, f.brokenSupportHeldBars, f.brokenResistanceHeldBars);
    }),
    'levels.touches': levelFunction((f, side) => (hasLevel(f, side) ? pick(side, f.supportTouches, f.resistanceTouches) : U)),
    'levels.confluence': levelFunction((f, side) => (hasLevel(f, side) ? pick(side, f.supportConfluence, f.resistanceConfluence) : U)),
};
