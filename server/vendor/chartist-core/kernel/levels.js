// The levels artifact contract and the flat numbers read off it (S10). Moved here from the app's levels-scan domain, which
// re-exports it, so the screener's level fields and the language's `levels.*` are one calculation. Pure: no detectors,
// no file access (the nightly batch that finds the levels stays in the app; this file only reads what it wrote).
//
/** Column order of a `LevelRow`. Written into the artifact so the file is self-describing. */
export const COLUMNS = [
    'kind', 'price', 'strength', 'touches', 'status',
    'distPct', 'confluence', 'heldBars', 'lastTouchBars', 'breakBars',
];
/**
 * Kind ↔ code. Frozen in this order forever: the artifact stores the INDEX, so reordering this
 * array silently relabels every level in every file written before the change.
 */
export const KIND_CODES = [
    'horizontal-support', 'horizontal-resistance',
    'diagonal-support', 'diagonal-resistance',
    'curve-support', 'curve-resistance',
];
export const STATUS_ACTIVE = 0;
export const STATUS_BROKEN = 1;
/** `breakBars` for a level that has not been broken. Never a real reading: a break cannot be -1 candles old. */
export const NOT_BROKEN = -1;
/**
 * "No level to measure against", as a distance.
 *
 * Deliberately the same value as `UNKNOWN_DISTANCE` in engines/derivedFields — both mean the
 * same thing and both are only ever tested with `<`, so a large finite number fails every
 * proximity test while never poisoning a sum or a sort the way NaN would. Kept as a local
 * constant rather than an import so this module stays free of the scanner's feed layer; a
 * test asserts the two agree.
 */
export const NO_LEVEL_DISTANCE = 999;
/** "No break to date", as a candle count. Large enough that every `< N` recency test fails. */
export const NO_BREAK_BARS = 9999;
/** Named accessors, so no reader has to remember that column 7 is `heldBars`. */
export const levelKind = (row) => KIND_CODES[row[0]] ?? 'unknown';
export const levelPrice = (row) => row[1];
export const levelStrength = (row) => row[2];
export const levelTouches = (row) => row[3];
export const levelIsActive = (row) => row[4] === STATUS_ACTIVE;
export const levelDistPct = (row) => row[5];
export const levelConfluence = (row) => row[6];
export const levelHeldBars = (row) => row[7];
export const levelLastTouchBars = (row) => row[8];
export const levelBreakBars = (row) => row[9];
export const levelIsSupport = (row) => levelKind(row).endsWith('-support');
/** A row read off disk is untrusted: ten finite numbers with a known kind, or it is not a level. */
export function isLevelRow(value) {
    if (!Array.isArray(value) || value.length !== 10)
        return false;
    if (!value.every((n) => typeof n === 'number' && Number.isFinite(n)))
        return false;
    return value[0] >= 0 && value[0] < KIND_CODES.length;
}
/** What every field reads when the symbol has no levels at all. No number here is a measurement. */
export const NO_LEVEL_FIELDS = Object.freeze({
    nearestSupportPct: NO_LEVEL_DISTANCE,
    nearestResistancePct: NO_LEVEL_DISTANCE,
    supportPrice: 0,
    resistancePrice: 0,
    supportStrength: 0,
    resistanceStrength: 0,
    supportTouches: 0,
    resistanceTouches: 0,
    supportConfluence: 0,
    resistanceConfluence: 0,
    supportHeldBars: 0,
    resistanceHeldBars: 0,
    levelRangePct: 0,
    resistanceBreakBars: NO_BREAK_BARS,
    supportBreakBars: NO_BREAK_BARS,
    brokenResistanceHeldBars: 0,
    brokenSupportHeldBars: 0,
    brokenResistanceStrength: 0,
    brokenSupportStrength: 0,
    nearestSupportPctW: NO_LEVEL_DISTANCE,
    nearestResistancePctW: NO_LEVEL_DISTANCE,
    supportStrengthW: 0,
    resistanceStrengthW: 0,
});
/** Every key this module owns — the overlay uses it to reset a row before writing. */
export const LEVEL_FIELD_KEYS = Object.keys(NO_LEVEL_FIELDS);
const round2 = (value) => Math.round(value * 100) / 100;
/**
 * The nearest active level of one side.
 * `support` picks from levels at or below the close (distPct ≤ 0), `resistance` from at or above.
 */
function nearestActive(rows, side) {
    let best = null;
    let bestGap = Infinity;
    for (const row of rows) {
        if (!levelIsActive(row))
            continue;
        if (levelIsSupport(row) !== (side === 'support'))
            continue;
        const dist = levelDistPct(row);
        if (side === 'support' ? dist > 0 : dist < 0)
            continue;
        const gap = Math.abs(dist);
        if (gap < bestGap) {
            bestGap = gap;
            best = row;
        }
    }
    return best;
}
/** The most recently broken level of one side — the freshest break, not the strongest. */
function freshestBreak(rows, side) {
    let best = null;
    let bestAge = Infinity;
    for (const row of rows) {
        if (levelIsActive(row))
            continue;
        if (levelIsSupport(row) !== (side === 'support'))
            continue;
        const age = levelBreakBars(row);
        if (age === NOT_BROKEN || age < 0)
            continue;
        if (age < bestAge) {
            bestAge = age;
            best = row;
        }
    }
    return best;
}
/**
 * Flatten one symbol's record. A missing record, or one with no rows, yields NO_LEVEL_FIELDS —
 * the whole point being that "this symbol has no level" is an answer, not a gap to be filled.
 */
export function deriveLevelFields(record) {
    if (!record || !(record.close > 0))
        return { ...NO_LEVEL_FIELDS };
    const daily = Array.isArray(record.d) ? record.d : [];
    const weekly = Array.isArray(record.w) ? record.w : [];
    const support = nearestActive(daily, 'support');
    const resistance = nearestActive(daily, 'resistance');
    const brokeSupport = freshestBreak(daily, 'support');
    const brokeResistance = freshestBreak(daily, 'resistance');
    const supportW = nearestActive(weekly, 'support');
    const resistanceW = nearestActive(weekly, 'resistance');
    const supportPrice = support ? levelPrice(support) : 0;
    const resistancePrice = resistance ? levelPrice(resistance) : 0;
    return {
        nearestSupportPct: support ? round2(Math.abs(levelDistPct(support))) : NO_LEVEL_DISTANCE,
        nearestResistancePct: resistance ? round2(Math.abs(levelDistPct(resistance))) : NO_LEVEL_DISTANCE,
        supportPrice,
        resistancePrice,
        supportStrength: support ? levelStrength(support) : 0,
        resistanceStrength: resistance ? levelStrength(resistance) : 0,
        supportTouches: support ? levelTouches(support) : 0,
        resistanceTouches: resistance ? levelTouches(resistance) : 0,
        supportConfluence: support ? levelConfluence(support) : 0,
        resistanceConfluence: resistance ? levelConfluence(resistance) : 0,
        supportHeldBars: support ? levelHeldBars(support) : 0,
        resistanceHeldBars: resistance ? levelHeldBars(resistance) : 0,
        // Both sides or nothing: half a box is not a range, and reporting one side's distance as the
        // width would read as a very tight consolidation on a stock that simply has no ceiling.
        levelRangePct: supportPrice > 0 && resistancePrice > supportPrice
            ? round2(((resistancePrice - supportPrice) / record.close) * 100)
            : 0,
        resistanceBreakBars: brokeResistance ? levelBreakBars(brokeResistance) : NO_BREAK_BARS,
        supportBreakBars: brokeSupport ? levelBreakBars(brokeSupport) : NO_BREAK_BARS,
        brokenResistanceHeldBars: brokeResistance ? levelHeldBars(brokeResistance) : 0,
        brokenSupportHeldBars: brokeSupport ? levelHeldBars(brokeSupport) : 0,
        brokenResistanceStrength: brokeResistance ? levelStrength(brokeResistance) : 0,
        brokenSupportStrength: brokeSupport ? levelStrength(brokeSupport) : 0,
        nearestSupportPctW: supportW ? round2(Math.abs(levelDistPct(supportW))) : NO_LEVEL_DISTANCE,
        nearestResistancePctW: resistanceW ? round2(Math.abs(levelDistPct(resistanceW))) : NO_LEVEL_DISTANCE,
        supportStrengthW: supportW ? levelStrength(supportW) : 0,
        resistanceStrengthW: resistanceW ? levelStrength(resistanceW) : 0,
    };
}
/** Flatten a whole artifact into the per-symbol payload the scanner overlays. */
export function deriveAllLevelFields(symbols) {
    const out = {};
    for (const [symbol, record] of Object.entries(symbols)) {
        out[symbol] = deriveLevelFields(record);
    }
    return out;
}
