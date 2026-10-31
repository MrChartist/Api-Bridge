// Which kernel functions look into the future (S07). Data only: no calculations.
//
// The question asked of every function is: "is the value written on candlestick i a function of candlesticks 0..i
// alone?" The test `__tests__/kernel.causality.test.ts` answers it by experiment: it cuts the series after
// candlestick k (and, separately, replaces everything after k with other candlesticks) and checks whether any value
// up to k changes. A tag here that the experiment contradicts fails the test, in either direction.
//
//   causal      Value i depends on candlesticks 0..i. Nothing changes when later candlesticks arrive.
//   lag         As `causal`, but the information is late by design: the value written on candlestick i describes
//               what happened `lag` candlesticks earlier (a pivot is known only `right` candlesticks after it).
//   noncausal   Value i depends on candlesticks after i, or the whole result is re-decided as candlesticks arrive.
//               Fit for drawing; refused by hosts that must not look ahead (the screener, a backtest).
//   unavailable Cannot be offered as a value per candlestick at all (it lives beyond the last candlestick).
//   na          Not a value per candlestick: a guard, a conversion, a setting reader, a table builder. Causality
//               does not apply; what it feeds is tested through the functions that use it.
const C = (why) => ({ tag: 'causal', why });
const NA = (why) => ({ tag: 'na', why });
const TRAILING = 'Looks only at the current candlestick and the ones before it.';
const ONE_STAMP = 'A function of one candlestick’s own time stamp.';
const GUARD = 'A guard or converter: no series goes in or out.';
/** Every function the kernel exports. The test fails if one is missing here or listed here but not exported. */
export const KERNEL_FUNCTIONS = {
    // ---- candle.ts, exchangeClock.ts
    isValidCandle: C('A check on one candlestick’s own four prices.'),
    setExchangeClockProvider: NA('Registers which exchange is active.'),
    exchangeClock: NA('Reads which exchange is active.'),
    // ---- candlePatterns.ts (S10)
    calcCandlePattern: C('Pattern i is decided by the candlestick it ends on and the ones before it (a 5-candlestick reference window, up to 14 for the doji average range, and up to 3 candlesticks of pattern).'),
    candlePatternAt: NA('One value at one index; the series form is calcCandlePattern.'),
    candlePatternIdsAt: NA('Every pattern at one index (candlePatternAt for the whole book); the series form is calcCandlePattern.'),
    isInsideBarShape: C('A check on one candlestick and the one before it.'),
    isNarrowestRange: C('A check on a window of ranges ending on the current candlestick.'),
    candlePatternFrame: NA('A helper: the reference window before a pattern, for one start index.'),
    isReadablePatternCandle: C('A check on one candlestick’s own prices.'),
    classifyDoji: C('A check on one candlestick’s own prices and an average range the caller measured before it.'),
    isHammerShape: C('A check on one candlestick’s own prices.'),
    isShootingStarShape: C('A check on one candlestick’s own prices.'),
    hammerFamilyShape: C('A check on one candlestick’s own prices.'),
    hammerFamilyAt: C('Bar i is decided by its own prices and the 5 candlesticks before it (the reference window for the prior trend).'),
    averageRangeBefore: C('Reads only the candlesticks before index i.'),
    // ---- levels.ts (S10): readers of the nightly levels record. No candlestick series goes in or out; the record is stamped
    // with the last bar it read, and the runtime refuses it for any other date.
    deriveLevelFields: NA('Reads one symbol’s levels record (stamped with the last bar it read), not a candlestick series.'),
    deriveAllLevelFields: NA('Reads the whole levels artifact, not a candlestick series.'),
    isLevelRow: NA('A check on one stored row.'),
    levelKind: NA('Reads one column of a stored level row.'),
    levelPrice: NA('Reads one column of a stored level row.'),
    levelStrength: NA('Reads one column of a stored level row.'),
    levelTouches: NA('Reads one column of a stored level row.'),
    levelIsActive: NA('Reads one column of a stored level row.'),
    levelDistPct: NA('Reads one column of a stored level row.'),
    levelConfluence: NA('Reads one column of a stored level row.'),
    levelHeldBars: NA('Reads one column of a stored level row.'),
    levelLastTouchBars: NA('Reads one column of a stored level row.'),
    levelBreakBars: NA('Reads one column of a stored level row.'),
    levelIsSupport: NA('Reads one column of a stored level row.'),
    // ---- exchangeTime.ts: every function is a function of one time stamp (and of the active exchange's calendar)
    sessionOpenMinute: NA('Reads the active exchange’s session time.'),
    sessionCloseMinute: NA('Reads the active exchange’s session time.'),
    exchangeTimeZone: NA('Reads the active exchange’s time zone.'),
    exchangeZoneLabel: NA('Reads the active exchange’s zone label.'),
    resolveChartZone: NA('Chooses a display zone.'),
    exchangeOffsetMs: C(ONE_STAMP),
    exchangeLocalToEpoch: C(ONE_STAMP),
    istParts: C(ONE_STAMP),
    istDayNumber: C(ONE_STAMP),
    istCalendarKey: C(ONE_STAMP),
    istMinuteOfDay: C(ONE_STAMP),
    istMidnightMs: C(ONE_STAMP),
    sessionOpenMs: C(ONE_STAMP),
    istDateKey: C(ONE_STAMP),
    isWeekendIST: C(ONE_STAMP),
    isSessionBucketStart: C(ONE_STAMP),
    alignToSessionBucket: C(ONE_STAMP),
    istWeekKey: C(ONE_STAMP),
    istMonthKey: C(ONE_STAMP),
    formatISTTime: C(ONE_STAMP),
    formatISTDayMonth: C(ONE_STAMP),
    formatISTMonthShort: C(ONE_STAMP),
    formatISTDate: C(ONE_STAMP),
    formatISTDateTime: C(ONE_STAMP),
    periodKey: C(ONE_STAMP),
    isIntradaySeries: NA('Answers one yes/no for a whole series (is it intraday?), not a value per candlestick.'),
    // ---- sanitize.ts, priceBarGuards.ts, seriesMath.ts helpers
    isFiniteNum: NA(GUARD),
    isFiniteNumber: NA(GUARD),
    clampPeriod: NA(GUARD),
    clampLength: NA(GUARD),
    seriesClampLength: NA(GUARD),
    finiteOr: NA(GUARD),
    nanSeries: NA('Makes a series of missing values.'),
    toNums: NA('Converts a series between the two encodings of “no value”.'),
    fromNums: NA('Converts a series between the two encodings of “no value”.'),
    robustIndicator: NA('Wraps a calculation so that bad candlesticks give no value; it adds no dependence on later candlesticks (tested through every wrapped function on data with gaps).'),
    nonFiniteMask: C('Marks, candlestick by candlestick, whether that candlestick’s own number is missing.'),
    sanitizeSeries: {
        tag: 'noncausal',
        why: 'Fills a gap at the very start with the first value that appears later. Every study blanks those candlesticks again, so no study shows the borrowed value.',
        causalForm: 'Use a study (calcEMA and the others), which blanks candlesticks whose own input is missing.',
    },
    hasFiniteHlc: C('A check on one candlestick’s own high, low and close.'),
    // ---- classic.ts
    calcVWAP: C('Running total from the first candlestick given. Depends on where the data starts, never on later candlesticks.'),
    calcVWAPBands: C('Running total with deviation bands from the first candlestick given.'),
    calcPivotPoints: NA('Three numbers in, one set of levels out. Whether it is safe depends on which period’s high, low and close the caller passes; previousPeriodHLC passes the last completed period.'),
    calcHA: C('Each Heikin-Ashi candlestick is built from its own prices and the previous Heikin-Ashi candlestick.'),
    calcRenko: C('A brick is added when the close has moved a full brick past the end of the last brick, or two bricks back for a reversal. Bricks already added never change. The result is a list of bricks, not one value per candlestick.'),
    calcEMA: C(TRAILING),
    calcSMA: C(TRAILING),
    calcBB: C(TRAILING),
    calcRSI: C(TRAILING),
    calcMACD: C(TRAILING),
    calcStochastic: C(TRAILING),
    calcADX: C(TRAILING),
    calcATR: C(TRAILING),
    calcSuperTrend: C('Each value depends on the previous value and the current candlestick.'),
    calcDonchian: C(TRAILING),
    calcOBV: C(TRAILING),
    calcWilliamsR: C(TRAILING),
    calcWMA: C(TRAILING),
    calcHMA: C(TRAILING),
    calcDEMA: C(TRAILING),
    calcTEMA: C(TRAILING),
    calcKeltner: C(TRAILING),
    calcCMF: C(TRAILING),
    calcDPO: C('Compares the close with an average ending earlier; it uses no candlestick after the one it is written on.'),
    calcTRIX: C(TRAILING),
    calcTSI: C(TRAILING),
    calcPPO: C(TRAILING),
    calcPPOFull: C(TRAILING),
    calcCMO: C(TRAILING),
    calcAroon: C(TRAILING),
    calcBBW: C(TRAILING),
    calcCHOP: C(TRAILING),
    calcEWO: C(TRAILING),
    calcSAR: C('Each value depends on the previous value and the current candlestick.'),
    calcStochRSI: C(TRAILING),
    calcCCI: C(TRAILING),
    calcMFI: C(TRAILING),
    calcROC: C(TRAILING),
    calcKDJ: C(TRAILING),
    calcADLine: C(TRAILING),
    calcAO: C(TRAILING),
    calcVROC: C(TRAILING),
    calcUltimateOsc: C(TRAILING),
    calcConnorsRSI: C('Ranks today’s change among the changes before it.'),
    calcFisher: C(TRAILING),
    calcCoppock: C(TRAILING),
    calcVortex: C(TRAILING),
    calcStdDev: C(TRAILING),
    calcMassIndex: C(TRAILING),
    calcKST: C(TRAILING),
    calcChaikinOsc: C(TRAILING),
    calcForceIndex: C(TRAILING),
    calcEOM: C(TRAILING),
    calcElderRay: C(TRAILING),
    // ---- ichimoku.ts
    calcIchimoku: {
        tag: 'noncausal',
        why: 'The lagging line on candlestick i is the close of candlestick i + 25. The two leading lines are late by 25 (they are computed from candlestick i - 25) and are safe; tenkan and kijun are causal.',
        causalForm: 'Use tenkan, kijun, senkouA and senkouB (senkouA and senkouB are lag(kijun period - 1)); leave chikou to the chart.',
    },
    ichimokuFutureCloud: {
        tag: 'unavailable',
        why: 'The slots lie beyond the last candlestick, so there is no candlestick to write them on. They are computed only from candlesticks that exist, so nothing leaks; they are for drawing.',
    },
    // ---- klingerOscillator.ts, linRegChannel.ts, maByType.ts
    calcKlinger: C(TRAILING),
    linearRegressionFit: NA('One line fitted to the values given; the caller chooses which values.'),
    rollingSlope: C(TRAILING),
    rollingR2: C(TRAILING),
    calcLinRegChannel: C('Each value is the line fitted to the last N candlesticks ending at the current one.'),
    isMaType: NA(GUARD),
    maByType: C(TRAILING),
    // ---- momentumExtra.ts, movingAverageEnvelope.ts, movingAveragesAdaptive.ts, movingAveragesBasic.ts
    calcMomentum: C(TRAILING),
    calcAroonOsc: C(TRAILING),
    calcBOP: C(TRAILING),
    calcEnvelope: C(TRAILING),
    calcKAMA: C(TRAILING),
    calcMcGinley: C(TRAILING),
    calcRMA: C(TRAILING),
    calcVWMA: C(TRAILING),
    calcLSMA: C('The fitted line ends at the current candlestick; an offset moves the point read along that line and never uses later candlesticks.'),
    calcALMA: C(TRAILING),
    applySmoothing: C('An average (and optional bands) of the series given, ending at the current candlestick.'),
    // ---- oscillatorsRviSmi.ts, periodBreaks.ts, periodPivots.ts
    calcRVI: C(TRAILING),
    calcSMI: C(TRAILING),
    periodBreakFlags: C('A candlestick starts a new period when its period key differs from the previous candlestick’s.'),
    defaultPivotAnchor: NA('Chooses session, week, month or year from the kind of series.'),
    previousPeriodHLC: C('Reads the last completed period before the candlestick asked about.'),
    steppedPivotPoints: C('Each candlestick carries the levels of the last completed period before its own; its own period never enters.'),
    // ---- pivotHighLow.ts, zigZag.ts, anchoredVwap.ts
    calcPivotHL: {
        tag: 'noncausal',
        why: 'A pivot is written on the candlestick that formed it, but it can only be known `right` candlesticks later.',
        causalForm: 'pivotsAtConfirmation: the same pivots written on the candlestick where they became known (lag(right)).',
    },
    pivotsAtConfirmation: { tag: 'lag', lag: { setting: 'right', default: 10 }, why: 'Writes each pivot on the candlestick where it became known, `right` candlesticks after it formed.' },
    calcZigZagConfirmed: {
        tag: 'noncausal',
        why: 'The last point can still be replaced by a more extreme one of the same kind, so the list is not final as candlesticks arrive. Earlier points do not move.',
    },
    calcZigZag: {
        tag: 'noncausal',
        why: 'Adds a provisional last leg that is redrawn on every new candlestick, and the last confirmed point can be replaced.',
    },
    calcAnchoredVwap: {
        tag: 'noncausal',
        why: 'The anchor is chosen from the latest candlestick (its session, week or month, or the extreme of the last N candlesticks), so every earlier value changes as candlesticks arrive. Right for “now”, wrong as a history.',
        causalForm: 'Use only the latest value (a snapshot), or vwapWithAnchor, which restarts at each period start.',
    },
    // ---- priceBarGuards.ts, relativeVolume.ts, rolling.ts
    rollingHighest: C('Highest of the last N values ending at the current one.'),
    rollingLowest: C('Lowest of the last N values ending at the current one.'),
    calcRelativeVolume: C('Compares the volume so far today with the same time of day in earlier sessions.'),
    rollingMean: C(TRAILING),
    rollingMeanStd: C(TRAILING),
    slidingExtremeIndex: C(TRAILING),
    rollingMax: C(TRAILING),
    rollingMin: C(TRAILING),
    rollingMeanStrict: C(TRAILING),
    // ---- seriesMath.ts
    smaN: C(TRAILING),
    recursiveN: C('Each value depends on the previous value and the current one.'),
    emaN: C(TRAILING),
    rmaN: C(TRAILING),
    wmaN: C(TRAILING),
    stdevN: C(TRAILING),
    highestN: C(TRAILING),
    lowestN: C(TRAILING),
    swmaN: C('Weights the current and the three previous candlesticks.'),
    changeN: C('The current value minus the value N candlesticks earlier.'),
    // ---- sessionVolumeProfile.ts, sessionVwap.ts, taAtr.ts, volume and volatility
    buildSessions: NA('A table of sessions over the whole series, read through the two accessors below; the study that uses it (calcRelativeVolume) is tested.'),
    cumulativeAt: NA('Reads the session table built above.'),
    barVolumeAt: NA('Reads the session table built above.'),
    vwapSessionSupported: NA('Answers one yes/no for a whole series.'),
    vwapWithAnchor: C('Restarts at each period start and accumulates forward.'),
    calcTaAtr: C(TRAILING),
    calcPercentB: C(TRAILING),
    calcHistoricalVol: C(TRAILING),
    calcUlcerIndex: C(TRAILING),
    calcADR: C(TRAILING),
    calcADRPercent: C(TRAILING),
    calcPVT: C(TRAILING),
    calcNVI: C(TRAILING),
    calcPVI: C(TRAILING),
    calcNetVolume: C(TRAILING),
    calcVolumeWithMa: C(TRAILING),
    emptyVwapPoint: NA('Makes an empty point.'),
    vwapSourcePrice: C('The price of one candlestick by the chosen rule (close, hl2, hlc3, ohlc4).'),
    resolveBandMultipliers: NA(GUARD),
    createVwapAccumulator: NA('A running total that is fed one candlestick at a time; it cannot see ahead.'),
    sessionAwareVwap: C('Restarts at each session (month on daily bars, year on weekly and monthly) and accumulates forward.'),
    sessionAwareVwapBands: C('Restarts at each session (month on daily bars, year on weekly and monthly) and accumulates forward.'),
    classicVwapAnchor: NA('Chooses the reset period from the kind of series and the setting.'),
    seriesSpacing: NA('Answers one word for a whole series (intraday, daily, weekly or monthly), not a value per candlestick.'),
    // ---- periodLevels.ts (2026-10-26)
    levelAnchor: NA('Chooses the period from the kind of series and the setting.'),
    pivotLevelsFor: NA('Levels from one period\'s high, low and close; no series.'),
    cprFor: NA('Levels from one period\'s high, low and close; no series.'),
    steppedPeriodValues: C('Each candlestick carries values from the last completed period before its own; its own period never enters.'),
    steppedPivotLevels: C('Each candlestick carries the levels of the last completed period before its own; its own period never enters.'),
    steppedCpr: C('Each candlestick carries the range of the last completed period before its own; its own period never enters.'),
    steppedPreviousHLC: C('Each candlestick carries the last completed period\'s high, low and close.'),
    rollingWeeksHighLow: C('Highest high and lowest low of the candlesticks up to and including this one.'),
    openingRange: C('Shown only from the candlestick that completes the range; reads the session\'s earlier candlesticks.'),
    calcSqueeze: C(TRAILING),
    // ---- studyVariants.ts (2026-10-26)
    macdWithSignalType: C(TRAILING),
    bbWithMaType: C(TRAILING),
    keltnerWithMaType: C(TRAILING),
    slowStochastic: C(TRAILING),
    // ---- transformProblem.ts
    ChartTransformError: NA('An error type.'),
};
/** Studies built only from trailing windows and recursions: nothing after the current candlestick is read. */
export const CAUSAL_STUDY_IDS = [
    'ema', 'sma', 'vwap', 'bb', 'rsi', 'macd', 'stoch', 'adx', 'atr', 'supertrend', 'vwapbands', 'donchian',
    'obv', 'williamsr', 'wma', 'hma', 'dema', 'tema', 'keltner', 'cmf', 'dpo', 'trix', 'tsi', 'ppo', 'cmo', 'aroon', 'bbw', 'chop',
    'ewo', 'sar', 'stochrsi', 'cci', 'mfi', 'roc', 'kdj', 'adline', 'ao', 'vroc', 'uo', 'crsi', 'fisher', 'coppock', 'vortex',
    'stddev', 'massindex', 'kst', 'chaikinosc', 'forceindex', 'eom', 'elderray',
    'rma', 'vwma', 'lsma', 'alma', 'kama', 'mcginley', 'envelope', 'percentb', 'historicalvol', 'ulcer', 'adr', 'adrpercent',
    'momentum', 'aroonosc', 'rvi', 'bop', 'smi', 'pvt', 'nvi', 'pvi', 'klinger', 'netvolume',
    'chandelier', 'linregchannel', 'volumema', 'rvol', 'sessionvwap',
    // 2026-10-26 (I1): previous-period levels, the 52-week window and the opening range read only bars at or before the
    // candlestick; Squeeze is built from trailing windows.
    'cpr', 'prevhl', 'hl52', 'orb', 'squeeze',
];
const SPECIAL_STUDIES = {
    pivot: {
        tag: 'causal',
        why: 'Floor-trader levels per candlestick from the last completed period before it (steppedPivotPoints); the chart draws them stepped.',
    },
    ichimoku: {
        tag: 'noncausal',
        why: 'The lagging line (chikou) is the close of the candlestick 25 later. The other four lines are safe.',
        fields: {
            tenkan: { tag: 'causal', why: 'Midpoint of the last 9 highs and lows.' },
            kijun: { tag: 'causal', why: 'Midpoint of the last 26 highs and lows.' },
            senkouA: { tag: 'lag', lag: { setting: 'kijun period - 1', default: 25 }, why: 'Computed from candlestick i - 25 and drawn on i.' },
            senkouB: { tag: 'lag', lag: { setting: 'kijun period - 1', default: 25 }, why: 'Computed from candlestick i - 25 and drawn on i.' },
            chikou: { tag: 'noncausal', why: 'The close of candlestick i + 25 drawn on i.' },
        },
        causalForm: 'tenkan, kijun, senkouA, senkouB',
    },
    pivothl: {
        tag: 'noncausal',
        why: 'A pivot is drawn on the candlestick that formed it but is known only `right` candlesticks later.',
        causalForm: 'The same pivots on the candlestick where they became known: lag(right), pivotsAtConfirmation.',
    },
    zigzag: {
        tag: 'noncausal',
        why: 'The last leg is redrawn as candlesticks arrive, and the last confirmed point can be replaced.',
    },
    fractals: {
        tag: 'noncausal',
        why: 'A fractal is drawn on the middle candlestick of the pattern, which needs `n` candlesticks after it (2 by default).',
        causalForm: 'The same flag moved `n` candlesticks later: lag(n).',
    },
    avwap: {
        tag: 'noncausal',
        why: 'The anchor is chosen from the latest candlestick, so every earlier value changes as candlesticks arrive.',
        causalForm: 'Use only the latest value (a snapshot), or the session VWAP, which restarts at each period start.',
    },
};
/** Tag of every chart study id. */
export const STUDY_CAUSALITY = {
    ...Object.fromEntries(CAUSAL_STUDY_IDS.map((id) => [id, { tag: 'causal' }])),
    ...SPECIAL_STUDIES,
};
/** The studies and functions a screener or backtest must refuse (the “noncausal list” for owner review). */
export function noncausalNames() {
    return {
        functions: Object.entries(KERNEL_FUNCTIONS).filter(([, v]) => v.tag === 'noncausal').map(([k]) => k).sort(),
        studies: Object.entries(STUDY_CAUSALITY).filter(([, v]) => v.tag === 'noncausal').map(([k]) => k).sort(),
    };
}
