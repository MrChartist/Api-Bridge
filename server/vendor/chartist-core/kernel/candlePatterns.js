/**
 * Every threshold the pattern rules use, in one place. All size references are
 * measured on the SAME timeframe's own candles — a weekly hammer is judged
 * against recent weekly candles, never against a daily ATR.
 *
 * Notation used in the pattern doc comments:
 *   r  = high − low (range)            B  = |close − open| (body)
 *   U  = high − max(open, close)       Lw = min(open, close) − low
 *   AR = mean r of the reference window    AB = mean B of the reference window
 *   reference window = the `refCandles` candles immediately BEFORE the
 *                      pattern's first candle (so a pattern's own tall candles
 *                      never inflate the yardstick they are measured with)
 *   long body   := B ≥ longBody × AB (and AB > 0)
 *   downtrend   := close[last ref] − close[first ref] ≤ −trendRangeMult × AR
 *   uptrend     := close[last ref] − close[first ref] ≥ +trendRangeMult × AR
 */
export const CANDLE_RULES = {
    /** Candles in the reference window before a pattern (trend + size yardstick). */
    refCandles: 5,
    /**
     * Prior trend = net close change across the reference window (4 candle-to-
     * candle steps), in units of that window's average range. Volatility-scaled
     * rather than a fixed percent, so "a decline" means the same thing for a
     * 1%-a-day bank and a 4%-a-day small cap, and on D, W and M alike. For a
     * random walk, avg range ≈ 1.6σ and a 4-step move has sd 2σ, so 1.0 × AR ≈
     * 0.8 sd: roughly one candle in five sits "after a decline" by chance.
     */
    trendRangeMult: 1.0,
    // The doji types, hammer and shooting star use the chart's thresholds (DOJI_BODY_MAX ... HAMMER_BODY_MAX below),
    // owner decision 2026-10-18; the old book-only doji / shadow thresholds were removed with it.
    /** Marubozu: each shadow ≤ 5% of the candle's own range. */
    marubozuWick: 0.05,
    /** Long body: B ≥ 1.0 × AB (TA-Lib "BodyLong" factor, on a 5-candle average). */
    longBody: 1.0,
    /** Harami / three-inside: second body ≤ 50% of the first body. */
    haramiBody: 0.5,
    /** Star (morning/evening): middle body ≤ 30% of the first body. */
    starBody: 0.3,
    /** Tweezers: extremes within 5% of AR of each other (TA-Lib "Equal"). */
    tweezerTolerance: 0.05,
    /** Tweezers: both candles need r ≥ 0.5 × AR. */
    tweezerMinRange: 0.5,
    /** Inside bar: the mother candle needs r ≥ 0.5 × AR. */
    insideMotherRange: 0.5,
    /** Soldiers / crows: close within 25% of the range from the extreme. */
    soldierCloseNear: 0.25,
    /** Soldiers / crows: open may sit beyond the prior body by ≤ 20% of AR (TA-Lib "Near"). */
    soldierOpenNear: 0.2,
    /** Level context: "near the 52W high/low" within this percent. */
    near52wPct: 2,
};
const R = CANDLE_RULES;
/**
 * A candlestick a pattern may read: finite time, positive prices, body inside the range, and not an untraded filler
 * (2026-10-25, PC-2): a candlestick with no range AND no volume (open = high = low = close, volume 0 or missing) is the
 * filler a data vendor writes for an exchange holiday or an untraded day. It is not a session, so a pattern that would
 * read it cannot be told (`candlePatternAt` gives NaN). The bar sources drop these rows first (`dropUntradedRows` on the
 * server, `dropUntradedBars` on the chart); this is the second guard. A flat candlestick that traded stays readable
 * (the four-price doji).
 */
export function isReadablePatternCandle(c) {
    return Number.isFinite(c.time) && hasReadablePrices(c) && !isUntradedFiller(c);
}
/** No range and no volume: a holiday / untraded filler row, not a session. */
function isUntradedFiller(c) {
    return c.high === c.low && !(typeof c.volume === 'number' && c.volume > 0);
}
/** The price half of `isReadablePatternCandle`: positive, finite, body inside the range. Hosts without a numeric time read it. */
function hasReadablePrices(c) {
    return (Number.isFinite(c.open) && c.open > 0 &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) && c.low > 0 &&
        Number.isFinite(c.close) && c.close > 0 &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close));
}
const range = (c) => c.high - c.low;
const body = (c) => Math.abs(c.close - c.open);
const upper = (c) => c.high - Math.max(c.open, c.close);
const lower = (c) => Math.min(c.open, c.close) - c.low;
const bodyTop = (c) => Math.max(c.open, c.close);
const bodyBottom = (c) => Math.min(c.open, c.close);
const bodyMid = (c) => (c.open + c.close) / 2;
const isBull = (c) => c.close > c.open;
const isBear = (c) => c.close < c.open;
const longBody = (c, f) => f.avgBody > 0 && body(c) >= R.longBody * f.avgBody;
// ---- Single-candlestick shapes, shared with the chart (owner decision 2026-10-18) -------------------------------------
/** Body under this share of the range is a doji body (B < 0.1 r). */
export const DOJI_BODY_MAX = 0.1;
/** Dragonfly / gravestone: the missing shadow is at most this share of the range. */
export const DOJI_TINY_SHADOW = 0.1;
/** Long-legged: both shadows at least this share of the range. */
export const LONG_LEG_SHADOW_MIN = 0.3;
/** Long-legged: the range is at least this many times the average range (when an average is known). */
export const LONG_LEG_RANGE_VS_AVG = 1;
/** Candlesticks averaged for the doji "average range" (high - low of the candlesticks before the one judged). */
export const AVERAGE_RANGE_BARS = 14;
/** Fewest candlesticks before the one judged for an average range; with fewer the size test is skipped. */
export const AVERAGE_RANGE_MIN_BARS = 5;
/** Hammer / shooting star: the long shadow is more than this many bodies. */
export const HAMMER_SHADOW_BODY = 2;
/** Hammer / shooting star: the other shadow is under this share of the range. */
export const HAMMER_OTHER_SHADOW_MAX = 0.15;
/** Hammer / shooting star: the body is under this share of the range. */
export const HAMMER_BODY_MAX = 0.35;
/** Hammer / shooting star: "high" confidence when the long shadow is more than this many bodies. */
export const HAMMER_STRONG_SHADOW_BODY = 3;
/**
 * The bar's doji type, or null when its body is not a doji's. Exclusive: the first row of the definitions table that
 * fits wins (four-price, dragonfly, gravestone, long-legged, doji). `avgRange` is the yardstick for "long" legs; null
 * or 0 skips that size test (shape only). `fourPrice: false` skips the four-price doji (quote data, where an opening
 * tick has no range yet).
 */
export function classifyDoji(c, avgRange, opts = {}) {
    const r = c.high - c.low;
    if (!Number.isFinite(r) || r < 0)
        return null;
    if (r === 0) {
        const traded = typeof c.volume === 'number' && c.volume > 0;
        return opts.fourPrice !== false && traded && c.close > 0 ? 'Four-Price Doji' : null;
    }
    const b = Math.abs(c.close - c.open);
    if (b >= DOJI_BODY_MAX * r)
        return null;
    const u = c.high - Math.max(c.open, c.close);
    const l = Math.min(c.open, c.close) - c.low;
    if (u <= DOJI_TINY_SHADOW * r)
        return 'Dragonfly Doji';
    if (l <= DOJI_TINY_SHADOW * r)
        return 'Gravestone Doji';
    const longEnough = !(avgRange && avgRange > 0) || r >= LONG_LEG_RANGE_VS_AVG * avgRange;
    if (u >= LONG_LEG_SHADOW_MIN * r && l >= LONG_LEG_SHADOW_MIN * r && longEnough)
        return 'Long-Leg Doji';
    return 'Doji';
}
/** Hammer silhouette: L > 2 B, U < 0.15 r, B < 0.35 r. Any body colour; a doji body may also be a hammer (dual label). */
export function isHammerShape(c) {
    const r = c.high - c.low;
    if (!(r > 0))
        return false;
    const b = Math.abs(c.close - c.open);
    return lower(c) > HAMMER_SHADOW_BODY * b && upper(c) < HAMMER_OTHER_SHADOW_MAX * r && b < HAMMER_BODY_MAX * r;
}
/** Shooting-star silhouette: U > 2 B, L < 0.15 r, B < 0.35 r. Any body colour (owner decision 2026-10-18). */
export function isShootingStarShape(c) {
    const r = c.high - c.low;
    if (!(r > 0))
        return false;
    const b = Math.abs(c.close - c.open);
    return upper(c) > HAMMER_SHADOW_BODY * b && lower(c) < HAMMER_OTHER_SHADOW_MAX * r && b < HAMMER_BODY_MAX * r;
}
/**
 * Mean high - low of up to `AVERAGE_RANGE_BARS` candlesticks before `i`, or null with fewer than
 * `AVERAGE_RANGE_MIN_BARS` of them. `ok(j)` stops the window at the first candlestick (going back) it rejects.
 */
export function averageRangeBefore(cs, i, ok = () => true) {
    let sum = 0;
    let n = 0;
    for (let j = i - 1; j >= 0 && n < AVERAGE_RANGE_BARS && ok(j); j--) {
        sum += cs[j].high - cs[j].low;
        n++;
    }
    return n >= AVERAGE_RANGE_MIN_BARS ? sum / n : null;
}
/**
 * Inside-bar shape (the range part of the `insideBar` pattern): b.high <= a.high, b.low >= a.low and r_b < r_a, so a
 * candlestick with the same high AND low as the one before it (a twin) is not inside. `candle.inside()` in the language
 * is this shape; `candle.pattern("inside_bar")` adds the mother-candle size test (r_a >= 0.5 x AR) and the reference
 * window (2026-10-25, PC-11).
 */
export function isInsideBarShape(a, b) {
    return b.high <= a.high && b.low >= a.low && b.high - b.low < a.high - a.low;
}
/**
 * Narrow range (NR4 / NR7, Crabel): the LAST range in `ranges` is the narrowest of them all. Ties count: a candlestick
 * whose range equals the narrowest earlier one is narrow too (documented choice, 2026-10-25; Crabel's text says
 * "narrowest", and a strict reading would never mark two equal inside days). `candle.nr(n)` is this rule over the
 * last n candlesticks, today included.
 */
export const NARROW_RANGE_TIES_COUNT = true;
export function isNarrowestRange(ranges) {
    if (ranges.length === 0)
        return false;
    const last = ranges[ranges.length - 1];
    for (let k = 0; k < ranges.length - 1; k++)
        if (ranges[k] < last || (!NARROW_RANGE_TIES_COUNT && ranges[k] === last))
            return false;
    return true;
}
/** Bullish/bearish harami core: long first body of the given colour, small second body inside it. */
function harami(a, b, f, bullish) {
    if (bullish ? !isBear(a) : !isBull(a))
        return false;
    if (!longBody(a, f) || body(b) > R.haramiBody * body(a))
        return false;
    return bodyTop(b) <= bodyTop(a) && bodyBottom(b) >= bodyBottom(a);
}
/**
 * The pattern book. Order is the stable key order (`CANDLE_PATTERN_KEYS`) and
 * the order hits are emitted in. Names follow the chart's
 * `patternRecognition.ts` where the two overlap (spelled out in full).
 *
 * Gap rules. Textbook piercing lines, dark clouds and stars are defined with
 * opening GAPS beyond the prior candle's low/high or body. A weekly or monthly
 * open is the next session's open, which almost never gaps past a whole
 * candle, so every such rule here is the standard modern relaxation: "opens
 * beyond the prior CLOSE" for piercing / dark cloud, and "star body centred
 * at or beyond the first candle's close" for stars. Stated per pattern.
 */
export const CANDLE_PATTERNS = [
    // ── Single candle ──────────────────────────────────────────────────────────
    {
        /** After a downtrend: L > 2·B, U < 0.15·r, B < 0.35·r (`isHammerShape`). Colour free; may also be a doji type. */
        id: 'hammer', name: 'hammer', direction: 'bullish', bars: 1, requiresTrend: 'down',
        match: ([c]) => hammerFamilyShape(c) === 'hammer',
    },
    {
        /** After an uptrend: U > 2·B, L < 0.15·r, B < 0.35·r (`isShootingStarShape`). Colour free; may also be a doji type. */
        id: 'shootingStar', name: 'shooting star', direction: 'bearish', bars: 1, requiresTrend: 'up',
        match: ([c]) => hammerFamilyShape(c) === 'shootingStar',
    },
    {
        /** Any trend: close > open, B ≥ 1.0·AB, U ≤ 0.05·r and Lw ≤ 0.05·r. */
        id: 'bullishMarubozu', name: 'bullish marubozu', direction: 'bullish', bars: 1, requiresTrend: null,
        match: ([c], f) => isBull(c) && longBody(c, f) && upper(c) <= R.marubozuWick * range(c) && lower(c) <= R.marubozuWick * range(c),
    },
    {
        /** Any trend: close < open, B ≥ 1.0·AB, U ≤ 0.05·r and Lw ≤ 0.05·r. */
        id: 'bearishMarubozu', name: 'bearish marubozu', direction: 'bearish', bars: 1, requiresTrend: null,
        match: ([c], f) => isBear(c) && longBody(c, f) && upper(c) <= R.marubozuWick * range(c) && lower(c) <= R.marubozuWick * range(c),
    },
    // The five doji types are exclusive (`classifyDoji`: the first type that fits wins) and need no prior trend.
    {
        /** Any trend, neutral: B < 0.1·r and none of the other doji types. */
        id: 'doji', name: 'doji', direction: 'neutral', bars: 1, requiresTrend: null,
        match: ([c], f) => classifyDoji(c, f.dojiAvgRange) === 'Doji',
    },
    {
        /** Any trend, neutral: B < 0.1·r, U ≥ 0.3·r, Lw ≥ 0.3·r and r ≥ 1.0 × the 14-candlestick average range. */
        id: 'longLeggedDoji', name: 'long-legged doji', direction: 'neutral', bars: 1, requiresTrend: null,
        match: ([c], f) => classifyDoji(c, f.dojiAvgRange) === 'Long-Leg Doji',
    },
    {
        /** Any trend: B < 0.1·r and U ≤ 0.1·r (open and close at the high). */
        id: 'dragonflyDoji', name: 'dragonfly doji', direction: 'bullish', bars: 1, requiresTrend: null,
        match: ([c], f) => classifyDoji(c, f.dojiAvgRange) === 'Dragonfly Doji',
    },
    {
        /** Any trend: B < 0.1·r and Lw ≤ 0.1·r (open and close at the low). */
        id: 'gravestoneDoji', name: 'gravestone doji', direction: 'bearish', bars: 1, requiresTrend: null,
        match: ([c], f) => classifyDoji(c, f.dojiAvgRange) === 'Gravestone Doji',
    },
    {
        /** Any trend, neutral: r = 0 (open = high = low = close) and the candlestick traded (volume > 0). */
        id: 'fourPriceDoji', name: 'four-price doji', direction: 'neutral', bars: 1, requiresTrend: null,
        match: ([c], f) => classifyDoji(c, f.dojiAvgRange) === 'Four-Price Doji',
    },
    // ── Two candles (a = prior, b = latest) ────────────────────────────────────
    {
        /**
         * After a downtrend: a bearish; b bullish with B ≥ 1.0·AB; b's body engulfs
         * a's body — b.open ≤ a.close and b.close ≥ a.open, not equal at both ends.
         */
        id: 'bullishEngulfing', name: 'bullish engulfing', direction: 'bullish', bars: 2, requiresTrend: 'down',
        match: ([a, b], f) => isBear(a) && isBull(b) && longBody(b, f) &&
            b.open <= a.close && b.close >= a.open && (b.open < a.close || b.close > a.open),
    },
    {
        /** After an uptrend: a bullish; b bearish with B ≥ 1.0·AB; b.open ≥ a.close, b.close ≤ a.open, not equal at both ends. */
        id: 'bearishEngulfing', name: 'bearish engulfing', direction: 'bearish', bars: 2, requiresTrend: 'up',
        match: ([a, b], f) => isBull(a) && isBear(b) && longBody(b, f) &&
            b.open >= a.close && b.close <= a.open && (b.open > a.close || b.close < a.open),
    },
    {
        /** After a downtrend: a bearish with B ≥ 1.0·AB; b's body (any colour) inside a's body, inclusive; B_b ≤ 0.5·B_a. */
        id: 'bullishHarami', name: 'bullish harami', direction: 'bullish', bars: 2, requiresTrend: 'down',
        match: ([a, b], f) => harami(a, b, f, true),
    },
    {
        /** After an uptrend: a bullish with B ≥ 1.0·AB; b's body inside a's body, inclusive; B_b ≤ 0.5·B_a. */
        id: 'bearishHarami', name: 'bearish harami', direction: 'bearish', bars: 2, requiresTrend: 'up',
        match: ([a, b], f) => harami(a, b, f, false),
    },
    {
        /**
         * After a downtrend: a bearish with B ≥ 1.0·AB; b bullish, b.open < a.close
         * (relaxed from "below a's low"), mid(a body) < b.close < a.open.
         */
        id: 'piercingLine', name: 'piercing line', direction: 'bullish', bars: 2, requiresTrend: 'down',
        match: ([a, b], f) => isBear(a) && longBody(a, f) && isBull(b) && b.open < a.close && b.close > bodyMid(a) && b.close < a.open,
    },
    {
        /**
         * After an uptrend: a bullish with B ≥ 1.0·AB; b bearish, b.open > a.close
         * (relaxed from "above a's high"), a.open < b.close < mid(a body).
         */
        id: 'darkCloudCover', name: 'dark cloud cover', direction: 'bearish', bars: 2, requiresTrend: 'up',
        match: ([a, b], f) => isBull(a) && longBody(a, f) && isBear(b) && b.open > a.close && b.close < bodyMid(a) && b.close > a.open,
    },
    {
        /** After a downtrend: a bearish, b bullish, |a.low − b.low| ≤ 0.05·AR, both r ≥ 0.5·AR. */
        id: 'tweezerBottom', name: 'tweezer bottom', direction: 'bullish', bars: 2, requiresTrend: 'down',
        match: ([a, b], f) => isBear(a) && isBull(b) && Math.abs(a.low - b.low) <= R.tweezerTolerance * f.avgRange &&
            range(a) >= R.tweezerMinRange * f.avgRange && range(b) >= R.tweezerMinRange * f.avgRange,
    },
    {
        /** After an uptrend: a bullish, b bearish, |a.high − b.high| ≤ 0.05·AR, both r ≥ 0.5·AR. */
        id: 'tweezerTop', name: 'tweezer top', direction: 'bearish', bars: 2, requiresTrend: 'up',
        match: ([a, b], f) => isBull(a) && isBear(b) && Math.abs(a.high - b.high) <= R.tweezerTolerance * f.avgRange &&
            range(a) >= R.tweezerMinRange * f.avgRange && range(b) >= R.tweezerMinRange * f.avgRange,
    },
    {
        /**
         * Any trend, neutral: b.high ≤ a.high, b.low ≥ a.low, r_b < r_a, and the
         * mother candle r_a ≥ 0.5·AR. (Range-inside; a harami is body-inside, so a
         * candle can be both.)
         */
        id: 'insideBar', name: 'inside bar', direction: 'neutral', bars: 2, requiresTrend: null,
        match: ([a, b], f) => isInsideBarShape(a, b) && range(a) >= R.insideMotherRange * f.avgRange,
    },
    // ── Three candles (a, b, c = latest) ───────────────────────────────────────
    {
        /**
         * After a downtrend: a bearish with B ≥ 1.0·AB; star b with B_b ≤ 0.3·B_a
         * and mid(b body) ≤ a.close (relaxed from a body gap); c bullish with
         * c.close ≥ mid(a body).
         */
        id: 'morningStar', name: 'morning star', direction: 'bullish', bars: 3, requiresTrend: 'down',
        match: ([a, b, c], f) => isBear(a) && longBody(a, f) && body(b) <= R.starBody * body(a) && bodyMid(b) <= a.close &&
            isBull(c) && c.close >= bodyMid(a),
    },
    {
        /**
         * After an uptrend: a bullish with B ≥ 1.0·AB; star b with B_b ≤ 0.3·B_a
         * and mid(b body) ≥ a.close; c bearish with c.close ≤ mid(a body).
         */
        id: 'eveningStar', name: 'evening star', direction: 'bearish', bars: 3, requiresTrend: 'up',
        match: ([a, b, c], f) => isBull(a) && longBody(a, f) && body(b) <= R.starBody * body(a) && bodyMid(b) >= a.close &&
            isBear(c) && c.close <= bodyMid(a),
    },
    {
        /**
         * Any trend (recorded in context, not required — treated as a momentum
         * pattern so the backtest sees it from bases and extensions alike): three
         * bullish candles, each B ≥ 1.0·AB and high − close ≤ 0.25·r; closes rising;
         * each open above the prior open and ≤ prior close + 0.2·AR.
         */
        id: 'threeWhiteSoldiers', name: 'three white soldiers', direction: 'bullish', bars: 3, requiresTrend: null,
        match: ([a, b, c], f) => {
            const near = R.soldierOpenNear * f.avgRange;
            const soldier = (x) => isBull(x) && longBody(x, f) && x.high - x.close <= R.soldierCloseNear * range(x);
            return soldier(a) && soldier(b) && soldier(c) &&
                b.close > a.close && c.close > b.close &&
                b.open > a.open && b.open <= a.close + near &&
                c.open > b.open && c.open <= b.close + near;
        },
    },
    {
        /**
         * Any trend (recorded, not required): three bearish candles, each
         * B ≥ 1.0·AB and close − low ≤ 0.25·r; closes falling; each open below the
         * prior open and ≥ prior close − 0.2·AR.
         */
        id: 'threeBlackCrows', name: 'three black crows', direction: 'bearish', bars: 3, requiresTrend: null,
        match: ([a, b, c], f) => {
            const near = R.soldierOpenNear * f.avgRange;
            const crow = (x) => isBear(x) && longBody(x, f) && x.close - x.low <= R.soldierCloseNear * range(x);
            return crow(a) && crow(b) && crow(c) &&
                b.close < a.close && c.close < b.close &&
                b.open < a.open && b.open >= a.close - near &&
                c.open < b.open && c.open >= b.close - near;
        },
    },
    {
        /** After a downtrend: (a, b) is a bullish harami (rules above); c bullish and c.close > a.open. */
        id: 'threeInsideUp', name: 'three inside up', direction: 'bullish', bars: 3, requiresTrend: 'down',
        match: ([a, b, c], f) => harami(a, b, f, true) && isBull(c) && c.close > a.open,
    },
    {
        /** After an uptrend: (a, b) is a bearish harami; c bearish and c.close < a.open. */
        id: 'threeInsideDown', name: 'three inside down', direction: 'bearish', bars: 3, requiresTrend: 'up',
        match: ([a, b, c], f) => harami(a, b, f, false) && isBear(c) && c.close < a.open,
    },
];
/** The reference window before `cs[start]`: yardsticks and the prior trend (the one trend rule), or null if not computable. */
function referenceWindow(cs, start) {
    const from = start - R.refCandles;
    if (from < 0)
        return null;
    let sumRange = 0;
    let sumBody = 0;
    for (let j = from; j < start; j++) {
        sumRange += cs[j].high - cs[j].low;
        sumBody += Math.abs(cs[j].close - cs[j].open);
    }
    const avgRange = sumRange / R.refCandles;
    if (!(avgRange > 0))
        return null; // a frozen / untraded stretch has no yardstick
    const first = cs[from].close;
    const move = cs[start - 1].close - first;
    const threshold = R.trendRangeMult * avgRange;
    return {
        avgRange,
        avgBody: sumBody / R.refCandles,
        move,
        movePct: (move / first) * 100,
        trend: move <= -threshold ? 'down' : move >= threshold ? 'up' : 'flat',
    };
}
/** Reference frame for a pattern whose first candle is `cs[start]`, or null if not computable. */
export function candlePatternFrame(cs, start) {
    const w = referenceWindow(cs, start);
    if (w === null)
        return null;
    // The reference candlesticks are readable (callers check), so the window holds at least 5 and is never null.
    return { ...w, dojiAvgRange: averageRangeBefore(cs, start, (j) => isReadablePatternCandle(cs[j])) ?? w.avgRange };
}
// ---- One value per candlestick (what the language needs) ---------------------------------------------------------------
/**
 * Whether the pattern `spec` ends on candlestick `i`: 1 or 0, or NaN when it cannot be told. It cannot be told while
 * there is not enough history (a pattern needs `refCandles` candlesticks before its first one) or when any candlestick
 * it reads (the reference window and the pattern) is unreadable: missing, not positive, or with a body outside its range.
 * The same rules as `detectCandlePatterns` in the app, which looks at the last 15 candlesticks: this function at `i`
 * gives what that one gives for the 15 candlesticks ending on `i` (5 reference candlesticks for the trend and size
 * yardstick, up to 14 for the doji average range).
 */
export function candlePatternAt(cs, i, spec) {
    const start = i - spec.bars + 1;
    const from = start - CANDLE_RULES.refCandles;
    if (from < 0 || i >= cs.length)
        return Number.NaN;
    for (let j = from; j <= i; j++)
        if (!isReadablePatternCandle(cs[j]))
            return Number.NaN;
    const f = candlePatternFrame(cs, start);
    if (f === null)
        return 0;
    if (spec.requiresTrend !== null && f.trend !== spec.requiresTrend)
        return 0;
    return spec.match(cs.slice(start, i + 1), f) ? 1 : 0;
}
/**
 * Every pattern of the book that ends on candlestick `i`, in book order: the ids for which `candlePatternAt` is 1. One
 * pass instead of 24 (the frame for each pattern length is measured once), the same verdicts (the parity test proves
 * it). This is what the chart's markers, the scanner rows, the screener, the scan rules and the alerts read.
 */
export function candlePatternIdsAt(cs, i) {
    const out = [];
    if (i < 0 || i >= cs.length)
        return out;
    // The longest readable run ending on i decides which pattern lengths can be told at all.
    let readableFrom = i + 1;
    while (readableFrom > 0 && isReadablePatternCandle(cs[readableFrom - 1]))
        readableFrom--;
    const frames = new Map();
    for (const spec of CANDLE_PATTERNS) {
        const start = i - spec.bars + 1;
        if (start - CANDLE_RULES.refCandles < readableFrom)
            continue;
        let f = frames.get(start);
        if (f === undefined) {
            f = candlePatternFrame(cs, start);
            frames.set(start, f);
        }
        if (f === null)
            continue;
        if (spec.requiresTrend !== null && f.trend !== spec.requiresTrend)
            continue;
        if (spec.match(cs.slice(start, i + 1), f))
            out.push(spec.id);
    }
    return out;
}
/** Which hammer-family silhouette the bar has, or null. Exclusive: no bar fits both (that would need B > 0.7 r). */
export function hammerFamilyShape(c) {
    if (isHammerShape(c))
        return 'hammer';
    if (isShootingStarShape(c))
        return 'shootingStar';
    return null;
}
/**
 * The one Hammer / Shooting Star rule: the silhouette plus the book's prior trend (the `refCandles` candlesticks before
 * the bar, net close change at least `trendRangeMult` x their average range: down for a hammer, up for a shooting star).
 * The same verdict as `candlePatternAt` for the `hammer` / `shootingStar` specs (the parity test proves it); null without
 * `refCandles` readable candlesticks before `i`. It reads prices only, so a host whose candles carry a `date` instead of
 * a numeric `time` (the chart) can call it directly.
 */
export function hammerFamilyAt(cs, i) {
    const from = i - R.refCandles;
    if (from < 0 || i >= cs.length)
        return null;
    for (let j = from; j <= i; j++)
        if (!hasReadablePrices(cs[j]))
            return null;
    const id = hammerFamilyShape(cs[i]);
    if (id === null)
        return null;
    const w = referenceWindow(cs, i);
    return w !== null && w.trend === (id === 'hammer' ? 'down' : 'up') ? id : null;
}
/** `candlePatternAt` for every candlestick. */
export function calcCandlePattern(cs, id) {
    const spec = CANDLE_PATTERNS.find((p) => p.id === id);
    if (!spec)
        throw new RangeError(`unknown candlestick pattern ${id}`);
    const out = new Array(cs.length);
    for (let i = 0; i < cs.length; i++)
        out[i] = candlePatternAt(cs, i, spec);
    return out;
}
