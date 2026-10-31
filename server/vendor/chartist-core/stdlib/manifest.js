// Draft standard-library manifest (S03). It declares names, argument rules, result shapes, the
// data each name needs, and a causality tag. It holds no calculations; those arrive in S06 to S10.
// The reference page for users is generated from this file (later step), so every entry carries a
// plain-words summary. Anything unconfirmed is marked "Needs verification".
//
// Rules the checker applies to this data (SPEC section 6 and section 10):
// - A name with no causality tag (`tag: null`) is unavailable (E-STDLIB-UNTAGGED). Today that is only `pattern.classic`: the S07 audit left it unavailable (see kernel/causality.ts and SPEC section 13).
// - A `noncausal` name is refused by hosts that do not allow it (the screener and the backtest).
// - A name that needs data the host does not have is refused with a clear message (never guessed).
import { STUDY_CAUSALITY } from '../kernel/causality.js';
import { STUDY_SPECS } from './studies/specs.js';
/** Data a name needs. A host profile (check/hosts.ts) says which of these it has. */
export const CAPABILITIES = [
    'ohlcv:daily',
    'ohlcv:weekly',
    'ohlcv:monthly',
    'ohlcv:intraday',
    'snapshot:levels',
    'snapshot:info',
    'snapshot:fundamental-current',
    'xs',
    'bench',
    'screener-output',
    'chart-output',
    'alert-output',
    'strategy-output',
    'deriv:live-user-token',
    'deriv:eod',
    'deriv:vendor',
];
// ---- Argument shorthands -------------------------------------------------------------------
const num = { t: 'num' };
const cond = { t: 'bool' };
const len = (min, max) => ({ t: 'len', min, max });
const SIDES = ['support', 'resistance'];
/** The timeframes of the nightly levels: daily (the default) and weekly. */
const LEVEL_TFS = ['D', 'W'];
const side = { t: 'choice', values: SIDES };
const p = (name, arg, optional = false, dflt) => {
    const spec = optional ? { name, arg, optional } : { name, arg };
    if (dflt !== undefined)
        spec.default = dflt;
    return spec;
};
const D = ['ohlcv:daily'];
const NONE_REQ = [];
/**
 * The 24 single and multi-candlestick patterns of the existing candle engine, written in snake_case. The five doji types
 * (`doji`, `long_legged_doji`, `dragonfly_doji`, `gravestone_doji`, `four_price_doji`) are exclusive and are the chart's
 * own definitions (owner decision 2026-10-18).
 */
export const PATTERN_IDS = [
    'hammer', 'shooting_star',
    'bullish_marubozu', 'bearish_marubozu',
    'doji', 'long_legged_doji', 'dragonfly_doji', 'gravestone_doji', 'four_price_doji',
    'bullish_engulfing', 'bearish_engulfing', 'bullish_harami', 'bearish_harami',
    'piercing_line', 'dark_cloud_cover', 'tweezer_bottom', 'tweezer_top', 'inside_bar',
    'morning_star', 'evening_star', 'three_white_soldiers', 'three_black_crows', 'three_inside_up', 'three_inside_down',
];
/** Pattern ids taken out of `candle.pattern` (owner decision 2026-10-18). A script that names one is refused with E-ARG-RETIRED. */
export const RETIRED_PATTERN_IDS = {
    hanging_man: {
        on: '2026-10-18',
        why: 'the app no longer reads a hammer shape after a rise as a pattern',
        instead: 'Use candle.pattern("shooting_star") or candle.pattern("hammer"), or write the shape as a body/wick condition, for example (min(open, close) - low) > 2 * abs(close - open).',
    },
    inverted_hammer: {
        on: '2026-10-18',
        why: 'the app no longer reads a shooting-star shape after a decline as a pattern',
        instead: 'Use candle.pattern("hammer") or candle.pattern("shooting_star"), or write the shape as a body/wick condition, for example (high - max(open, close)) > 2 * abs(close - open).',
    },
};
/** snake_case id to the engine's camelCase id (Needs owner decision, SPEC section 9). */
export function patternEngineId(id) {
    return id.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}
/** Text codes accepted by tf(...). */
export const TF_CODES = {
    D: { frame: 'D', cap: 'ohlcv:daily' },
    W: { frame: 'W', cap: 'ohlcv:weekly' },
    M: { frame: 'M', cap: 'ohlcv:monthly' },
    '1m': { frame: '1m', cap: 'ohlcv:intraday' },
    '5m': { frame: '5m', cap: 'ohlcv:intraday' },
    '15m': { frame: '15m', cap: 'ohlcv:intraday' },
    '30m': { frame: '30m', cap: 'ohlcv:intraday' },
    '1h': { frame: '1h', cap: 'ohlcv:intraday' },
};
/** Fields of a frame object (tf(...) and ref(...)). */
export const FRAME_FIELDS = ['open', 'high', 'low', 'close', 'volume'];
/** Groups of names that exist but are not built yet; using one gives E-NOT-YET with the release. */
export const PLANNED = {
    'ta.scan': 'ta.scan arrives in version 1.1 (state that carries from one candlestick to the next).',
    'strategy.size': 'strategy.size is not built yet; position size is set in the @strategy line.',
    'opt.pick': 'opt.pick arrives with option and future legs in backtests (S34); until then fut.* and opt.* give one number per candlestick.',
};
/** Groups reserved for data that does not exist yet. Refused (E-NAME-RESERVED). `fut` and `opt` left this list in S31: they are real groups now, and refused with E-DATA-STAGE where the data stage is not switched on. */
export const RESERVED_NAMESPACES = {
    flow: 'participant and flow data',
    deriv: 'derivatives data',
};
/** Names the user may not use for their own values. Filled from the data below. */
/** Option strategy legs (strategy.leg): what each written argument may be. */
export const LEG_RIGHTS = ['call', 'put', 'future'];
export const LEG_SIDES = ['buy', 'sell'];
export const LEG_EXPIRIES = ['near', 'next', 'month'];
export const MAX_LEG_LOTS = 50;
export const MAX_LEGS = 4;
/**
 * The written shape of a leg's strike: `atm`, `atm+N`, `atm-N` (N from 1 to 20 listed strikes), `delta=X` (X from 0.05 to 0.95, at
 * most two decimals) or `premium=P` (P from 0.05 to 100000 rupees, at most two decimals). The ranges are checked by `parseLegStrike`,
 * which the checker, the lowering, the backtest and the Script page's payoff preview all use.
 */
export const LEG_STRIKE = /^(?:atm(?:[+-](?:[1-9]|1[0-9]|20))?|delta=0?\.\d{1,2}|premium=\d{1,6}(?:\.\d{1,2})?)$/;
export const LEG_DELTA_MIN = 0.05;
export const LEG_DELTA_MAX = 0.95;
export const LEG_PREMIUM_MIN = 0.05;
export const LEG_PREMIUM_MAX = 100000;
/** What a written strike means, or null when the language cannot choose it (its shape or its range). */
export function parseLegStrike(text) {
    if (!LEG_STRIKE.test(text))
        return null;
    if (text.startsWith('atm'))
        return { by: 'atm', offset: text.length === 3 ? 0 : Number(text.slice(3)) };
    const at = text.indexOf('=');
    const x = Number(text.slice(at + 1));
    if (text.startsWith('delta'))
        return x >= LEG_DELTA_MIN && x <= LEG_DELTA_MAX ? { by: 'delta', delta: x } : null;
    return x >= LEG_PREMIUM_MIN && x <= LEG_PREMIUM_MAX ? { by: 'premium', premium: x } : null;
}
/** One spelling per meaning (`delta=0.30` and `delta=.3` are both `delta=0.3`), so two scripts that choose alike hash alike. */
export function canonicalLegStrike(text) {
    const s = parseLegStrike(text);
    if (!s || s.by === 'atm')
        return text;
    return s.by === 'delta' ? `delta=${s.delta}` : `premium=${s.premium}`;
}
export const BUILTIN_FUNCTIONS = ['abs', 'min', 'max', 'nz', 'near', 'all', 'any', 'input', 'show', 'plot', 'mark', 'alert', 'tf', 'ref', 'range', 'is_na'];
export const PLOT_STYLES = ['line', 'histogram', 'area', 'step'];
export const MARK_SHAPES = ['dot', 'triangle_up', 'triangle_down', 'square', 'diamond'];
export const MARK_WHERE = ['above', 'below'];
/** `plot(..., linewidth=N)`: 1 (the default) to 4 pixels. */
export const PLOT_LINEWIDTH_MAX = 4;
/** `plot(..., offset=N)`: 0 to this many candlesticks to the right. A negative offset is refused (E-PLOT-OFFSET): it would draw values earlier than they were known. */
export const PLOT_OFFSET_MAX = 500;
/**
 * The named colours (B7, 2026-10-17). `up`, `down` and `neutral` mean direction; the others only tell one drawing from another and are
 * the app's tone tokens (`--tone-blue`, `--tone-teal`, `--tone-amber`, `--tone-slate`), so a host draws them in the theme's own hue.
 * There is no purple (house rule) and no `color.rgb`: a colour written as numbers would bypass the tokens and the light/dark themes.
 */
export const COLOR_NAMES = ['up', 'down', 'neutral', 'blue', 'teal', 'amber', 'gray'];
export const REBALANCE = ['daily', 'weekly', 'monthly', 'signal'];
export const SIZING = ['equal', 'fixed_amount', 'pct_equity', 'risk_pct', 'inverse_vol', 'rank_weighted'];
// ---- Functions -----------------------------------------------------------------------------
const f = (spec) => spec;
/** What each `levels.*` gives (latest candlestick only; missing when the symbol has no such level or the nightly record is for another date). */
const LEVEL_SUMMARY = {
    nearest: 'Price of the nearest active level on that side of the close ("support": at or below it, "resistance": at or above it). Latest candlestick only.',
    dist_pct: 'How far that nearest level is from the close, in percent (always positive). tf="W" gives the distance to the weekly level instead. Latest candlestick only.',
    strength: 'Detector score of the nearest active level on that side, 0 to 100. tf="W" gives the score of the weekly level instead. Latest candlestick only.',
    range_pct: 'Width of the box between the nearest support and the nearest resistance, in percent of the close. Missing when either side has no level. Latest candlestick only.',
    broken_bars: 'Candlesticks since price closed decisively through the freshest broken level on that side. Missing when none was broken. Latest candlestick only.',
    broken_held_bars: 'How many candlesticks that freshest broken level had been respected before it gave way. Latest candlestick only.',
    touches: 'How many closes turned at the nearest active level on that side. Latest candlestick only.',
    confluence: 'How many different shapes mark the price of the nearest active level on that side (1 is ordinary, 2 or more is agreement). Latest candlestick only.',
};
/** What each `price.*` measure is (formulas from the app's derived fields, src/engines/derivedFields.ts). A broken candlestick (a missing or non-positive price, or a body outside its range) gives a missing value, not 0. */
const PRICE_SUMMARY = {
    body: 'Size of the body as a percent of the close: |close - open| / close * 100.',
    range: 'High to low as a percent of the close: (high - low) / close * 100. The app has no such field today; the definition is new (Needs verification).',
    close_pos: 'Where the close sits in the candlestick, 0 at the low and 100 at the high: (close - low) / (high - low) * 100; 50 when high and low are equal.',
    gap_pct: 'Opening gap as a percent of the previous close: (open - previous close) / previous close * 100. Missing on the first candlestick. The app reads a ready-made gap field; the exact definition behind it needs verification.',
    lower_wick_pct: 'Lower wick as a percent of the whole candlestick: (lower of open and close - low) / (high - low) * 100; 0 when high and low are equal. The app keeps this as a 0-1 ratio (lowerWickRatio); here it is a percent.',
};
/** `ind.<id>` from a study row (stdlib/studies/specs.ts): every setting optional, the default being the chart's own. */
function studyFn(s) {
    const params = s.params.map((q) => q.kind === 'len' ? p(q.name, len(q.min, q.max), true, q.default)
        : q.kind === 'num' ? p(q.name, { t: 'cnum', min: q.min, max: q.max }, true, q.default)
            : p(q.name, { t: 'choice', values: q.values }, true, q.default));
    // WP1 (2026-10-17): a study that reads the close alone takes `src=` (any number series) last, with no default, so a
    // script that leaves it out is the same program as before; the study then reads the close.
    if (s.source)
        params.push(p('src', num, true));
    const single = s.fields.length === 1 && s.fields[0] === 'value';
    const returns = single
        ? { kind: 'series', base: 'float' }
        : { kind: 'record', fields: Object.fromEntries(s.fields.map((f) => [f, s.fieldTypes?.[f] ?? 'float'])) };
    const c = STUDY_CAUSALITY[s.id];
    const tag = s.unavailable || !c || (c.tag !== 'causal' && c.tag !== 'noncausal' && c.tag !== 'lag') ? null : c.tag;
    const out = {
        name: `ind.${s.id}`, params, returns, requires: D, tag, history: true, exportable: s.id === 'macd' || s.id === 'bb' || s.id === 'supertrend',
        summary: s.source ? `${s.summary} src= takes another series in place of the close, for example src=volume or src=(high + low) / 2; left out, it reads the close.` : s.summary,
    };
    if (s.warm)
        out.warmup = { ...(s.warm.terms ? { terms: s.warm.terms } : {}), ...(s.warm.mult !== undefined ? { mult: s.warm.mult } : {}), ...(s.warm.add !== undefined ? { add: s.warm.add } : {}) };
    if (s.unavailable)
        out.reason = s.unavailable;
    return out;
}
// ---- fut and opt (stage 2) -------------------------------------------------------------------
const DERIV_REQ = ['deriv:eod'];
const underlying = p('u', { t: 'ctext' }, true, '');
const deriv = (name, params, base, summary, extra = {}) => ({
    name, params, returns: { kind: 'series', base }, requires: DERIV_REQ, tag: 'causal', history: true, exportable: false, summary, ...extra,
});
const expiryIndex = p('expiry', { t: 'cnum', min: 0, max: 2 }, true, 0);
const BUILDUPS = ['long_buildup', 'short_buildup', 'short_covering', 'long_unwinding'];
/** The stage-2 names. Each reads the exchange's end-of-day file of the same trading day as the candlestick. */
export const DERIV_FUNCTIONS = [
    deriv('fut.close', [underlying], 'float', 'Close of the near-month future (the nearest expiry on or after that day). Missing where the underlying has no future that day.'),
    deriv('fut.basis', [underlying], 'float', 'Near-month future minus the underlying price in the same file, in percent of the underlying price. Positive when the future is above the underlying.'),
    deriv('fut.oi', [underlying], 'float', 'Open interest of the near and the next month future added, in units (contracts times the lot size, as the exchange files give it). Added so that a roll (interest leaving the near month for the next) does not look like a collapse.'),
    deriv('fut.oi_chg', [underlying], 'float', 'Change in that open interest from the previous day, in units, as the exchange reports it (near and next added).'),
    deriv('fut.rollover', [underlying], 'float', 'Share of the open interest already in the next month, 0 to 100. Missing when no next month is listed or there is no open interest.'),
    deriv('fut.buildup', [p('kind', { t: 'choice', values: BUILDUPS }), underlying], 'bool', 'True when price and open interest moved together in the named way: long_buildup (price up, interest up), short_buildup (price down, interest up), short_covering (price up, interest down), long_unwinding (price down, interest down). Price is the near-month close against its previous close; interest is near and next added. No move in either is none of the four.'),
    deriv('opt.pcr_oi', [underlying, expiryIndex], 'float', 'Put open interest divided by call open interest for one expiry (expiry=0 is the nearest, 1 the next, 2 the one after). Missing when there is no call open interest.'),
    deriv('opt.pcr_vol', [underlying, expiryIndex], 'float', 'Put volume divided by call volume for one expiry (expiry=0 is the nearest). Missing when no call traded.'),
    deriv('opt.max_pain', [underlying, expiryIndex], 'float', 'The strike at which the total payout to option holders would be smallest if the contract expired there, for one expiry. A tie goes to the lower strike. A convention that many traders watch; it is not a prediction.'),
    deriv('opt.atm_iv', [underlying, p('dte', { t: 'cnum', min: 1, max: 365 }, true, 30)], 'float', 'Implied volatility at the money, as a fraction (0.16 is 16 percent), for the expiry whose days to expiry are closest to dte. Black-76 on the forward; the mean of the call and the put at the strike nearest the forward, from contracts that traded. Missing when none qualifies.'),
    deriv('opt.iv_rank', [underlying, p('n', len(20, 500), true, 252)], 'float', 'Where today\'s at-the-money implied volatility (30 days out) sits between the lowest and highest of the last n sessions that have one, 0 to 100 (a session with a file but no usable at-the-money price is skipped, not counted). Needs at least 20 such values up to that day. It is the underlying\'s own history from the files, not India VIX.', { warmup: { terms: ['n'] } }),
];
export const FUNCTIONS = [
    // Language level
    f({ name: 'abs', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Absolute value.' }),
    f({ name: 'min', params: [p('a', num), p('b', num)], returns: { kind: 'series', base: 'like', like: ['a', 'b'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'The smaller of two values. Also takes one list of numbers, min([a, b, c]) or min([x[i] for i in range(n)]): the smallest of them, missing when any of them is missing.' }),
    f({ name: 'max', params: [p('a', num), p('b', num)], returns: { kind: 'series', base: 'like', like: ['a', 'b'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'The larger of two values. Also takes one list of numbers, max([a, b, c]) or max([x[i] for i in range(n)]): the largest of them, missing when any of them is missing.' }),
    f({ name: 'nz', params: [p('x', num), p('default', num, true, 0)], returns: { kind: 'series', base: 'like', like: ['x', 'default'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Replaces a missing value (na) with a default, 0 if none is given.' }),
    f({ name: 'near', params: [p('a', num), p('b', num), p('pct', num)], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'True when a is within pct percent of b. Exact definition: Needs verification (SPEC section 9).' }),
    f({ name: 'all', params: [p('items', { t: 'list' })], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'True when every item of the list is true: all([a, b, c]) or all([cond for i in range(n)]). Three-valued: false when any item is false, otherwise missing when any item is missing.' }),
    f({ name: 'any', params: [p('items', { t: 'list' })], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'True when at least one item of the list is true: any([a, b, c]) or any([cond for i in range(n)]). Three-valued: true when any item is true, otherwise missing when any item is missing.' }),
    f({
        name: 'input',
        params: [p('default', { t: 'value' }), p('min', { t: 'cnum' }, true), p('max', { t: 'cnum' }, true), p('options', { t: 'list', of: 'text' }, true)],
        returns: { kind: 'setting' }, requires: NONE_REQ, tag: 'causal', exportable: false,
        summary: 'A setting, written only as the default of a parameter of the script-type function: n: int = input(20, min=5, max=100). min and max bound a number. options=["sma", "ema", "wma"] limits a text setting to 1 to 12 choices of at most 24 characters each, shown as a dropdown; the default must be one of them, and a value outside them is refused.',
    }),
    // List helpers over numbers (A4). Not reserved names: a value named sum or avg hides them.
    f({ name: 'avg', params: [p('items', { t: 'list', of: 'num' })], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Average of a list of numbers, avg([a, b, c]) or avg([x[i] for i in range(n)]): their sum divided by how many there are. Missing when any of them is missing (a missing value is not left out).' }),
    f({ name: 'sum', params: [p('items', { t: 'list', of: 'num' })], returns: { kind: 'series', base: 'like', like: ['items'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Sum of a list of numbers, sum([a, b, c]) or sum([x[i] for i in range(n)]). Missing when any of them is missing (a missing value is not counted as 0; wrap it in nz() for that).' }),
    f({ name: 'show', params: [p('series', { t: 'any' }), p('label', { t: 'ctext' })], returns: { kind: 'none' }, requires: ['screener-output'], tag: 'causal', exportable: false, summary: 'Adds a result column to the screener: a number or true/false (a text column is not available).' }),
    f({
        name: 'plot',
        params: [
            p('series', { t: 'any' }), p('label', { t: 'ctext' }), p('style', { t: 'choice', values: PLOT_STYLES }, true), p('color', { t: 'color' }, true),
            // Presentation only (2026-10-17): written in the script; left out, they are not written into the program, so older scripts keep their hashes.
            p('linewidth', { t: 'cnum', min: 1, max: PLOT_LINEWIDTH_MAX }, true), p('offset', { t: 'cnum', max: PLOT_OFFSET_MAX }, true),
        ],
        returns: { kind: 'none' }, requires: ['chart-output'], tag: 'causal', exportable: false, summary: `Draws a line, histogram, area or step on the chart; a true/false series is drawn as 1 and 0. linewidth=1 to ${PLOT_LINEWIDTH_MAX} sets the line's thickness in pixels; offset=N (0 to ${PLOT_OFFSET_MAX}, whole number) draws each value N candlesticks to the right, and a negative offset is refused because it would draw a value before it was known. Both are written in the script. Style names: Needs verification (S21).`,
    }),
    f({
        name: 'mark',
        params: [p('cond', cond), p('shape', { t: 'choice', values: MARK_SHAPES }, true), p('where', { t: 'choice', values: MARK_WHERE }, true), p('color', { t: 'color' }, true), p('text', { t: 'ctext' }, true)],
        returns: { kind: 'none' }, requires: ['chart-output'], tag: 'causal', exportable: false, summary: 'Marks candlesticks where the condition is true, optionally with a short text beside the marker (text="Buy", plain text, at most 12 characters). Shape names: Needs verification (S21).',
    }),
    f({
        name: 'bgcolor',
        params: [p('cond', cond), p('color', { t: 'color' }, true)],
        returns: { kind: 'none' }, requires: ['chart-output'], tag: 'causal', exportable: false, summary: 'Tints the background of the pane the indicator is drawn in (the price pane with overlay=True) on the candlesticks where the condition is true, faintly, in the colour given (the study\'s own colour when none). An unknown condition gives no tint.',
    }),
    f({
        name: 'fill',
        params: [p('a', num), p('b', num), p('color', { t: 'color' }, true)],
        returns: { kind: 'none' }, requires: ['chart-output'], tag: 'causal', exportable: false, summary: 'Fills the band between two lines the indicator plots, faintly: fill(fast, slow) where fast and slow are names given to plot(fast, ...) and plot(slow, ...). No fill where either line has no value. The colour is the first line\'s when none is given.',
    }),
    f({ name: 'alert', params: [p('cond', cond), p('message', { t: 'ctext' })], returns: { kind: 'none' }, requires: ['alert-output'], tag: 'causal', exportable: false, summary: 'Raises an alert when the condition becomes true.' }),
    f({ name: 'tf', params: [p('code', { t: 'choice', values: Object.keys(TF_CODES) }), p('partial', { t: 'cbool' }, true, false)], returns: { kind: 'frame' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Candlesticks of another size (D, W, M, or intraday on the chart). Only completed candlesticks unless partial=True: in the middle of a week tf("W").high is last week\'s high (the last completed week) and tf("W").high[1] the week before it; on the last candlestick of a week the week is complete, so it is this week\'s.' }),
    f({ name: 'ref', params: [p('symbol', { t: 'ctext' })], returns: { kind: 'frame' }, requires: ['bench'], tag: 'causal', exportable: true, summary: 'Candlesticks of another instrument, for example ref("NIFTY 50").close. Which symbols exist: Needs verification.' }),
    // price
    ...['body', 'range', 'close_pos', 'gap_pct', 'lower_wick_pct'].map((n) => f({ name: `price.${n}`, params: [], returns: { kind: 'series', base: 'float' }, requires: D, tag: 'causal', history: n === 'gap_pct', warmup: n === 'gap_pct' ? { add: 1 } : undefined, exportable: true, summary: PRICE_SUMMARY[n] })),
    // ta
    ...['sma', 'ema', 'rma', 'wma'].map((n) => f({ name: `ta.${n}`, params: [p('x', num), p('length', len(1, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: `${n.toUpperCase()} of x over length candlesticks.${n === 'ema' || n === 'rma' ? ' Its first value is on the length-th candlestick, as for ind.' + n + '; an exponential average keeps settling after that, so its first values depend on how much history came before.' : ''}` })),
    f({ name: 'ta.highest', params: [p('x', num), p('length', len(1, 5000))], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Highest value of x over the last length candlesticks, today included. Use [1] to leave today out.' }),
    f({ name: 'ta.lowest', params: [p('x', num), p('length', len(1, 5000))], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Lowest value of x over the last length candlesticks, today included.' }),
    f({ name: 'ta.highest_all', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: false, summary: 'Highest value of x from the first candlestick the run was given up to this one, today included; missing values are skipped. Use [1] to leave today out. A scan reads up to 2500 daily candlesticks, so this is the highest of those, not necessarily of the stock\'s whole life.' }),
    f({ name: 'ta.lowest_all', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: false, summary: 'Lowest value of x from the first candlestick the run was given up to this one, today included; missing values are skipped. Use [1] to leave today out. See ta.highest_all for how much history a scan reads.' }),
    f({ name: 'ta.atr', params: [p('length', len(1, 5000))], returns: { kind: 'series', base: 'float' }, requires: D, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Average true range over length candlesticks, smoothed the Wilder way (ta.rma of the true range; the first true range is high - low). The same as ind.atr(length).' }),
    f({ name: 'ta.rsi', params: [p('x', num), p('length', len(2, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: 0 }, exportable: true, summary: 'Relative strength index of x. A classic indicator, kept available.' }),
    f({ name: 'ta.crossover', params: [p('a', num), p('b', num)], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 1 }, exportable: true, summary: 'True on the candlestick where a moves above b (a > b now, a <= b before).' }),
    f({ name: 'ta.crossunder', params: [p('a', num), p('b', num)], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 1 }, exportable: true, summary: 'True on the candlestick where a moves below b.' }),
    f({ name: 'ta.bars_since', params: [p('cond', cond)], returns: { kind: 'series', base: 'int' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'Candlesticks since the condition was last true; 0 where it is true; na before the first time.' }),
    // `occurrence` has no default on purpose: left out, it is not written into the program, so scripts written before it existed keep their irHash (the lowering also drops a written 0).
    f({ name: 'ta.value_when', params: [p('cond', cond), p('x', { t: 'any' }), p('occurrence', len(0, 50), true)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'The value of x on the candlestick where the condition was last true. occurrence=1 gives the time before that, and so on (0 if left out, at most 50). Missing until the condition has been true occurrence+1 times and, after a missing condition, until it has been true occurrence+1 times again.' }),
    f({ name: 'ta.latch', params: [p('set', cond), p('reset', cond)], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'True from the candlestick where set is true until reset is true.' }),
    f({ name: 'ta.accumulate', params: [p('x', num), p('reset', cond, true, false)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'Running total of x since the last candlestick where reset was true, that candlestick included; before the first reset (or with no reset) since the first candlestick, which depends on where the data starts. A missing x adds nothing and is itself missing; after a missing reset the total is missing until reset is true again. State without a loop (ROADMAP "Bounded state").' }),
    f({ name: 'ta.cum_sum', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'Running total of x from the first candlestick. It depends on where the data starts. A missing value adds nothing and is itself missing; the total carries on after it. Needs verification (SPEC section 12.3).' }),
    f({ name: 'ta.highest_since', params: [p('cond', cond), p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'Highest x since the condition was last true, that candlestick included; missing before the first time and, after a missing condition, until it is true again.' }),
    f({ name: 'ta.lowest_since', params: [p('cond', cond), p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 0 }, exportable: true, summary: 'Lowest x since the condition was last true, that candlestick included; missing before the first time and, after a missing condition, until it is true again.' }),
    f({ name: 'ta.count', params: [p('cond', cond), p('length', len(1, 5000))], returns: { kind: 'series', base: 'int' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'How many of the last length candlesticks (today included) the condition was true.' }),
    f({ name: 'ta.change', params: [p('x', num), p('length', len(1, 5000), true, 1)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: 0 }, exportable: true, summary: 'x now minus x length candlesticks ago (1 if length is not given).' }),
    // ta, WP1 (2026-10-17): window statistics, momentum, crossings both ways, delayed pivots. Every window includes today;
    // any missing value in it makes the answer missing, and the first length - 1 candlesticks are missing (warm-up).
    f({ name: 'ta.stdev', params: [p('x', num), p('length', len(2, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Standard deviation of x over the last length candlesticks, today included: the population form (divided by length, not length - 1), as the chart\'s Bollinger bands use. Example: ta.stdev(close, 20) / close * 100 < 2.' }),
    f({ name: 'ta.variance', params: [p('x', num), p('length', len(2, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Variance of x over the last length candlesticks (population form, the square of ta.stdev). Example: ta.variance(close - close[1], 20).' }),
    f({ name: 'ta.dev', params: [p('x', num), p('length', len(2, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Mean absolute deviation: the average distance of the last length values of x from their own average. Example: ta.dev(close, 20).' }),
    f({ name: 'ta.median', params: [p('x', num), p('length', len(1, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Middle value of the last length values of x; with an even length, halfway between the two middle values (the same as ta.percentile(x, length, 50)). Example: close > ta.median(close, 50).' }),
    f({ name: 'ta.percentile', params: [p('x', num), p('length', len(1, 5000)), p('pct', { t: 'cnum', min: 0, max: 100 })], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'The value below which pct percent of the last length values of x lie, by linear interpolation between the two nearest ranks of the sorted window (rank = pct / 100 * (length - 1)); 0 is the lowest, 100 the highest. Example: volume > ta.percentile(volume, 100, 90).' }),
    f({ name: 'ta.cci', params: [p('x', num), p('length', len(2, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Commodity channel index of x: (x - ta.sma(x, length)) / (0.015 * ta.dev(x, length)); missing when the deviation is 0. On the typical price it is the usual CCI. Example: ta.cci((high + low + close) / 3, 20) > 100.' }),
    f({ name: 'ta.linreg', params: [p('x', num), p('length', len(2, 5000)), p('offset', { t: 'cnum', min: -100, max: 100 }, true, 0)], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Least-squares straight line through the last length values of x, read offset candlesticks back from today (0 is today\'s end of the line; a negative offset extends the line ahead, worked out from data up to today only). Example: close > ta.linreg(close, 50).' }),
    f({ name: 'ta.correlation', params: [p('a', num), p('b', num), p('length', len(2, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: -1 }, exportable: true, summary: 'Pearson correlation of a and b over the last length candlesticks, from -1 to 1; missing when either did not vary. Example: ta.correlation(close, volume, 20) < 0.' }),
    f({ name: 'ta.roc', params: [p('x', num), p('length', len(1, 5000))], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: 0 }, exportable: true, summary: 'Rate of change in percent: 100 * (x - x[length]) / x[length]; missing when the earlier value is 0. Example: ta.roc(close, 20) > 10.' }),
    f({ name: 'ta.mom', params: [p('x', num), p('length', len(1, 5000))], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: 0 }, exportable: true, summary: 'Momentum: x - x[length] (the same numbers as ta.change(x, length), under its common name). Example: ta.mom(close, 10) > 0.' }),
    f({ name: 'ta.rising', params: [p('x', num), p('length', len(1, 500))], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: 0 }, exportable: true, summary: 'True when x went up on each of the last length candlesticks, strictly (every value above the one before it; an equal value is not rising). One clear step down decides false even if another step is missing. Example: ta.rising(low, 3).' }),
    f({ name: 'ta.falling', params: [p('x', num), p('length', len(1, 500))], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { terms: ['length'], add: 0 }, exportable: true, summary: 'True when x went down on each of the last length candlesticks, strictly. Example: ta.falling(high, 3).' }),
    f({ name: 'ta.cross', params: [p('a', num), p('b', num)], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', history: true, warmup: { add: 1 }, exportable: true, summary: 'True on the candlestick where a crosses b in either direction: ta.crossover(a, b) or ta.crossunder(a, b), three-valued. Example: ta.cross(close, ta.sma(close, 50)).' }),
    f({ name: 'ta.pivothigh', params: [p('x', num), p('left', len(1, 500)), p('right', len(1, 500))], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'lag', lag: 1, history: true, warmup: { terms: ['left', 'right'], add: 0 }, exportable: true, summary: 'Late by design, by exactly right candlesticks (so at least 1): on candlestick i it gives x of candlestick i - right when that value is not beaten by any of the left candlesticks before it or the right candlesticks after it (ties count, as in the chart\'s pivot study); missing on every other candlestick. It never looks ahead: a pivot is reported only once the right candlesticks after it exist. Example: ph = ta.pivothigh(high, 5, 5), then ta.value_when(not is_na(ph), ph) is the last confirmed swing high.' }),
    f({ name: 'ta.pivotlow', params: [p('x', num), p('left', len(1, 500)), p('right', len(1, 500))], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'lag', lag: 1, history: true, warmup: { terms: ['left', 'right'], add: 0 }, exportable: true, summary: 'Late by design, by exactly right candlesticks (so at least 1): on candlestick i it gives x of candlestick i - right when no value from left candlesticks before it to right candlesticks after it is lower (ties count); missing on every other candlestick. Example: pl = ta.pivotlow(low, 5, 5).' }),
    f({ name: 'ta.zigzag', params: [p('pct', { t: 'cnum', min: 0.5, max: 50 })], returns: { kind: 'series', base: 'float' }, requires: D, tag: 'noncausal', history: true, exportable: false, summary: 'Zigzag legs of at least pct percent. The last leg changes as new candlesticks arrive, so it is for drawing only. Confirmed noncausal by the S07 audit.' }),
    // maths and missing values, WP1 (2026-10-17). One value at a time; a result with no meaning (square root of a
    // negative, logarithm of zero or less, an overflow) is missing, never a number. abs, min and max stay plain names.
    f({ name: 'math.sqrt', params: [p('x', num)], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Square root; missing for a negative number. Example: ta.stdev(close, 20) * math.sqrt(252).' }),
    f({ name: 'math.log', params: [p('x', num)], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Natural logarithm; missing for zero or a negative number. Example: math.log(close / close[1]) is the log return.' }),
    f({ name: 'math.exp', params: [p('x', num)], returns: { kind: 'series', base: 'float' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'e to the power x; missing when the result is too large to hold. Example: math.exp(ta.sma(math.log(close), 20)) is a geometric average.' }),
    f({ name: 'math.round', params: [p('x', num), p('digits', len(0, 10), true, 0)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'Rounds to digits decimals (0 if not given), halves away from zero: 2.5 gives 3 and -2.5 gives -3 (not Python\'s round-half-to-even). Example: math.round(close, 1).' }),
    f({ name: 'math.floor', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'The largest whole number not above x (-2.5 gives -3). Example: math.floor(close / 100) * 100 is the round hundred below.' }),
    f({ name: 'math.ceil', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'The smallest whole number not below x (2.1 gives 3). Example: math.ceil(close / 100) * 100 is the round hundred above.' }),
    f({ name: 'math.sign', params: [p('x', num)], returns: { kind: 'series', base: 'like', like: ['x'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: '1 when x is above 0, -1 when below, 0 when it is 0. Example: ta.sma(math.sign(close - close[1]), 10).' }),
    f({ name: 'math.clamp', params: [p('x', num), p('lo', num), p('hi', num)], returns: { kind: 'series', base: 'like', like: ['x', 'lo', 'hi'] }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'x held between lo and hi; missing when lo is above hi. Example: math.clamp(ta.rsi(close, 14), 30, 70).' }),
    f({ name: 'is_na', params: [p('x', { t: 'any' })], returns: { kind: 'series', base: 'bool' }, requires: NONE_REQ, tag: 'causal', exportable: true, summary: 'True when x is missing (na), false when it has a value. It is never itself missing, so it is the one test that sees a missing value (x == na is never true). Example: not is_na(ta.pivothigh(high, 5, 5)).' }),
    // ind
    ...STUDY_SPECS.map(studyFn),
    // candle
    f({ name: 'candle.inside', params: [], returns: { kind: 'series', base: 'bool' }, requires: D, tag: 'causal', history: true, warmup: { add: 1 }, exportable: true, summary: 'True when the candlestick lies within the previous candlestick (high not above, low not below, and a smaller range: a twin with the same high and low is not inside). The kernel inside-bar shape; candle.pattern("inside_bar") adds the mother-candle size test.' }),
    f({ name: 'candle.nr', params: [p('n', len(2, 252))], returns: { kind: 'series', base: 'bool' }, requires: D, tag: 'causal', history: true, warmup: { terms: ['n'], add: -1 }, exportable: true, summary: 'True when the range is the narrowest of the last n candlesticks, today included. Ties count: a range equal to the narrowest earlier one is narrow too (kernel isNarrowestRange, 2026-10-25).' }),
    f({ name: 'candle.hammer', params: [], returns: { kind: 'series', base: 'bool' }, requires: D, tag: 'causal', history: true, warmup: { add: 5 }, exportable: true, summary: 'Hammer after a decline: the same as candle.pattern("hammer"). A decline is judged over the 5 candlesticks before it (SPEC section 15); missing until there are 5 earlier candlesticks.' }),
    f({ name: 'candle.pattern', params: [p('id', { t: 'choice', values: PATTERN_IDS, retired: RETIRED_PATTERN_IDS })], returns: { kind: 'series', base: 'bool' }, requires: D, tag: 'causal', history: true, warmup: { add: 14 }, exportable: true, summary: 'True when the named pattern ends on this candlestick (24 patterns, ids in snake_case; hanging_man and inverted_hammer were retired on 2026-10-18). Needs the 5 candlesticks before the pattern for its trend and size yardstick, so it is missing for the first 5 to 7 candlesticks and wherever a candlestick it reads is missing or broken; the doji types also average the range of up to 14 candlesticks before them. Rules: SPEC section 15.' }),
    // levels (nightly artifact; latest candlestick only; the same numbers as the screener's level fields, SPEC section 15)
    f({ name: 'levels.nearest', params: [p('side', side)], returns: { kind: 'snapshot', base: 'float' }, requires: ['snapshot:levels'], tag: 'causal', exportable: false, summary: LEVEL_SUMMARY.nearest }),
    ...['dist_pct', 'strength'].map((n) => f({ name: `levels.${n}`, params: [p('side', side), p('tf', { t: 'choice', values: LEVEL_TFS }, true, 'D')], returns: { kind: 'snapshot', base: 'float' }, requires: ['snapshot:levels'], tag: 'causal', exportable: false, summary: LEVEL_SUMMARY[n] })),
    f({ name: 'levels.range_pct', params: [], returns: { kind: 'snapshot', base: 'float' }, requires: ['snapshot:levels'], tag: 'causal', exportable: false, summary: LEVEL_SUMMARY.range_pct }),
    ...['broken_bars', 'broken_held_bars', 'touches', 'confluence'].map((n) => f({ name: `levels.${n}`, params: [p('side', side)], returns: { kind: 'snapshot', base: 'int' }, requires: ['snapshot:levels'], tag: 'causal', exportable: false, summary: LEVEL_SUMMARY[n] })),
    // fut and opt, stage 2 (end-of-day derivative files; Needs a licence before real data). One number per candlestick, on the
    // trading day of the candlestick. `u` is the underlying: left out it is the stock the script is run on, or write the symbol
    // (`"NIFTY"`). Conventions are in derivatives/series.ts; each is Needs verification where a user could disagree.
    ...DERIV_FUNCTIONS,
    // pattern (classic chart patterns: causality not audited yet)
    f({ name: 'pattern.classic', params: [p('id', { t: 'ctext' })], returns: { kind: 'series', base: 'bool' }, requires: D, tag: null, history: true, exportable: false, summary: 'Classic chart pattern such as a flag. Unavailable: the S07 audit found that the detector re-decides earlier history as candlesticks arrive, so it cannot give one trustworthy value per candlestick.' }),
    // xs and breadth (across all stocks)
    f({ name: 'xs.rank', params: [p('x', num)], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'Rank of x among the stocks in the scan: 1 is the highest value. Equal values share the average of the ranks they span. Stocks with no value are left out and counted.' }),
    f({ name: 'xs.pct_rank', params: [p('x', num)], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'Percent rank of x among the stocks in the scan: 0 for the lowest value, 100 for the highest. Equal values share the average rank. Stocks with no value are left out and counted; at least two stocks need a value.' }),
    f({ name: 'xs.zscore', params: [p('x', num)], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'How many standard deviations x is from the average of the stocks in the scan (the spread over all stocks that have a value, not a sample estimate). Stocks with no value are left out and counted.' }),
    f({ name: 'xs.group_pct_rank', params: [p('x', num), p('by', { t: 'group' })], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'Percent rank of x within its group, for example its sector, worked out like xs.pct_rank. A stock with no group has no answer.' }),
    f({ name: 'xs.group_median', params: [p('x', num), p('by', { t: 'group' })], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'Median of x within the stock\'s group (the mean of the middle two for an even count). A stock with no group has no answer.' }),
    f({ name: 'breadth.pct_above_ma', params: [p('length', len(2, 500))], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'Percent of the stocks in the scan that close above their own length-candlestick average. A stock with fewer than length candlesticks, or a missing one in that window, is left out and counted. One value, the same for every stock.' }),
    f({ name: 'breadth.adv_dec', params: [], returns: { kind: 'cross', base: 'float' }, requires: ['xs'], tag: 'causal', exportable: false, summary: 'Stocks closing above their previous close divided by stocks closing below it; unchanged stocks count in neither, and there is no value when none declined. The form (a ratio, not a difference) is the draft choice: Needs verification.' }),
    // strategy outputs
    f({ name: 'strategy.entry', params: [p('cond', cond)], returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false, summary: 'Candlesticks on which a position may be opened (decided at the close; filled later by the simulator).' }),
    f({ name: 'strategy.exit', params: [p('cond', cond)], returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false, summary: 'Candlesticks on which an open position is closed.' }),
    f({ name: 'strategy.rank', params: [p('x', num)], returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false, summary: 'Orders entry candidates when there are more than the position limit.' }),
    f({
        name: 'strategy.leg',
        params: [
            p('right', { t: 'choice', values: LEG_RIGHTS }), p('side', { t: 'choice', values: LEG_SIDES }),
            p('strike', { t: 'ctext' }, true, 'atm'), p('expiry', { t: 'choice', values: LEG_EXPIRIES }, true, 'near'),
            p('lots', { t: 'cnum', min: 1, max: MAX_LEG_LOTS }, true, 1),
        ],
        returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false,
        summary: 'An option or future leg of an option strategy on one underlying (@strategy(underlying=...)): opened together with the other legs when strategy.entry turns true, closed together on strategy.exit or at expiry. strike is "atm", "atm+N" or "atm-N" (N listed strikes above or below the money), "delta=0.25" (the listed strike whose absolute Black-76 delta on the decision day is nearest 0.25; 0.05 to 0.95) or "premium=100" (the listed strike whose settlement price is nearest 100 rupees; 0.05 to 100000), a tie going to the strike further out of the money; expiry "near", "next" or "month".',
    }),
    // pct of a stop or a target may change from candlestick to candlestick (for example 2 * ta.atr(14) / close * 100): the simulator
    // reads it on the signal candlestick and keeps it for the life of that trade. A fixed pct is still checked to be 0.1 to 100 (the
    // checker's strategy rules), and an option strategy keeps a fixed pct. The trail stays a fixed percent.
    f({ name: 'strategy.stop_loss', params: [p('pct', num)], returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false, summary: 'strategy.stop_loss(pct=...): a stop, in percent below the fill price. pct may be a number (0.1 to 100) or a value that changes from candlestick to candlestick, such as 2 * ta.atr(14) / close * 100: it is read on the signal candlestick (the close where the entry turned true) and fixed for the life of that trade. An unknown, zero or negative value on that candlestick means that trade has no stop (counted as stopUnknown). In an option strategy pct is a fixed percent of the premium.' }),
    f({ name: 'strategy.take_profit', params: [p('pct', num), p('size_pct', { t: 'cnum', min: 1, max: 99 }, true)], returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false, summary: 'strategy.take_profit(pct=...): a target, in percent above the fill price, read like the stop (a number, or a value read on the signal candlestick and fixed for the trade; unknown, zero or negative means no target, counted as targetUnknown). With size_pct= (1 to 99, written in the script) it is a first target that sells that percent of the shares, rounded down to whole shares; the rest stays with the stop, the trail, the exit rule and a second take_profit without size_pct. At most one of each.' }),
    f({ name: 'strategy.trail', params: [p('pct', { t: 'cnum', min: 0.1, max: 100 })], returns: { kind: 'none' }, requires: ['strategy-output'], tag: 'causal', exportable: false, summary: 'strategy.trail(pct=...): a trailing stop, a fixed percent below the highest high of earlier candlesticks since entry.' }),
];
// ---- Values (names that are not called) -----------------------------------------------------
const v = (spec) => spec;
export const VALUES = [
    ...['open', 'high', 'low', 'close', 'volume'].map((n) => v({ name: n, base: 'float', shape: 'series', requires: D, tag: 'causal', summary: `${n} of each candlestick.` })),
    ...['open', 'high', 'low', 'close', 'volume'].map((n) => v({ name: `bench.${n}`, base: 'float', shape: 'series', requires: ['bench'], tag: 'causal', summary: `${n} of the benchmark index named in the script type line, for example benchmark="NIFTY 50".` })),
    v({ name: 'info.sector', base: 'str', shape: 'snapshot', requires: ['snapshot:info'], tag: 'causal', summary: 'Sector of the stock. Current value only.' }),
    v({ name: 'info.industry', base: 'str', shape: 'snapshot', requires: ['snapshot:info'], tag: 'causal', summary: 'Industry of the stock. Current value only. Needs verification that the field exists.' }),
    v({ name: 'info.mcap_cr', base: 'float', shape: 'snapshot', requires: ['snapshot:info'], tag: 'causal', summary: 'Market capitalisation in crore rupees. Current value only.' }),
    v({ name: 'fund.pe', base: 'float', shape: 'snapshot', requires: ['snapshot:fundamental-current'], tag: 'causal', summary: 'Price to earnings. Current value only.' }),
    v({ name: 'math.pi', base: 'float', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'The number pi, 3.141592653589793. Example: 2 * math.pi.' }),
    v({ name: 'color.up', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'The colour for rising values.' }),
    v({ name: 'color.down', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'The colour for falling values.' }),
    v({ name: 'color.neutral', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'The colour for unchanged or neutral values.' }),
    // B7 (2026-10-17): colours that only tell drawings apart, from the theme's tone tokens (no hex, no purple, no color.rgb).
    v({ name: 'color.blue', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'Blue, in the theme\'s own shade (lighter on a dark chart). For telling one drawing from another; it says nothing about direction.' }),
    v({ name: 'color.teal', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'Teal, in the theme\'s own shade. For telling one drawing from another.' }),
    v({ name: 'color.amber', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'Amber (an orange yellow), in the theme\'s own shade. For telling one drawing from another.' }),
    v({ name: 'color.gray', base: 'color', shape: 'constant', requires: NONE_REQ, tag: 'causal', summary: 'A cool grey, in the theme\'s own shade. For telling one drawing from another.' }),
];
// ---- Lookup ---------------------------------------------------------------------------------
const fnByName = new Map(FUNCTIONS.map((x) => [x.name, x]));
const valueByName = new Map(VALUES.map((x) => [x.name, x]));
/** Groups of names written with a dot, for example `ta`, `ind`. Reserved groups are listed separately. */
export const NAMESPACES = [
    ...new Set([...FUNCTIONS, ...VALUES].map((x) => x.name).filter((n) => n.includes('.')).map((n) => n.slice(0, n.indexOf('.')))),
].sort();
/**
 * Prices worked out from each candlestick (2026-10-25). `hl2` means exactly `(high + low) / 2` and compiles to the same program,
 * so the results and the hashes are the same either way. They are not reserved: a script that sets its own `hl2` keeps it.
 */
export const PRICE_BLENDS = {
    hl2: { fields: ['high', 'low'], summary: 'The middle of each candlestick: (high + low) / 2.' },
    hlc3: { fields: ['high', 'low', 'close'], summary: 'The typical price: (high + low + close) / 3.' },
    ohlc4: { fields: ['open', 'high', 'low', 'close'], summary: 'The average of the four prices: (open + high + low + close) / 4.' },
};
export function isPriceBlend(name) {
    return Object.hasOwn(PRICE_BLENDS, name);
}
/** Plain names that are values (open, high, low, close, volume). */
export const GLOBAL_VALUES = VALUES.filter((x) => !x.name.includes('.')).map((x) => x.name);
export function fnSpec(name) {
    return fnByName.get(name);
}
export function valueSpec(name) {
    return valueByName.get(name);
}
/** Every member name of a group, for "did you mean". */
export function membersOf(ns) {
    const prefix = `${ns}.`;
    const out = [];
    for (const n of [...fnByName.keys(), ...valueByName.keys(), ...Object.keys(PLANNED)]) {
        if (n.startsWith(prefix))
            out.push(n.slice(prefix.length));
    }
    return [...new Set(out)].sort();
}
/** Names a user may not assign or define: groups, reserved groups, built-in functions, built-in values. */
export function isReservedName(name) {
    return (NAMESPACES.includes(name) ||
        name in RESERVED_NAMESPACES ||
        BUILTIN_FUNCTIONS.includes(name) ||
        GLOBAL_VALUES.includes(name));
}
