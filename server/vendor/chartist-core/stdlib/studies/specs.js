// The 83 chart studies as script functions `ind.<id>(...)` (S09): their settings, the names of what they give back, and
// how much history they need. Data only (no calculation), so the checker and the reference page can read it without
// loading the kernel. The calculations are in `compute.ts`; the manifest turns these rows into `FnSpec`s.
//
// Rules:
// - Every setting is optional and its default is what a fresh study on the chart starts with, so `ind.rsi()` and the
//   chart's RSI agree. A setting is a whole number written in the script (or set by `input()`), as for `ta.*`.
// - A study reads the price it is defined on (close for averages, high/low/close/volume for the rest, HLC3 for the
//   VWAPs). A study that reads the close alone takes an optional `src=` series instead (SOURCE_STUDY_IDS, 2026-10-17).
// - `warm` is the number of earlier candlesticks a call needs before its latest value exists (tested against the
//   calculations on clean data, so it cannot be too small).
// - Eight studies are listed but unavailable (the five added on 2026-10-26, cpr, prevhl, hl52, orb and squeeze, are chart-only for now): `pivot` (a set of levels for the chart, not a value per candlestick;
//   use `levels.*`), and `chandelier` and `fractals` (their calculation stays in the app until the owner decides; see
//   the package PROVENANCE).
const len = (name, def, min = 1, max = 500) => ({ name, kind: 'len', min, max, default: def });
const num = (name, def, min, max) => ({ name, kind: 'num', min, max, default: def });
const pick = (name, def, values) => ({ name, kind: 'choice', values, default: def });
const V = ['value'];
const BAND = ['upper', 'mid', 'lower'];
const L = (...terms) => ({ terms, add: -1 });
const spec = (id, pane, summary, params, fields, warm, extra = {}) => ({ id, pane, summary, params, fields, ...(warm ? { warm } : {}), ...extra });
const MA_TYPES = ['sma', 'ema', 'rma', 'wma', 'vwma', 'hma'];
const VWAP_ANCHORS = ['session', 'week', 'month', 'year', 'none'];
const AVWAP_ANCHORS = ['session', 'week', 'month', 'year', 'highestHigh', 'lowestLow', 'highestVolume'];
const RAW_SPECS = [
    // Averages and overlays
    spec('ema', 'price', 'Exponential moving average of the close.', [len('length', 9)], V, L('length')),
    spec('sma', 'price', 'Simple moving average of the close.', [len('length', 50)], V, L('length')),
    spec('wma', 'price', 'Weighted moving average of the close; the newest candlestick weighs most.', [len('length', 20)], V, L('length')),
    spec('hma', 'price', 'Hull moving average of the close: smooth, and quicker to turn than a simple average.', [len('length', 14)], V, { terms: ['length'], mult: 1.05, add: 3 }),
    spec('dema', 'price', 'Double exponential moving average of the close.', [len('length', 20)], V, { terms: ['length'], mult: 2, add: -2 }),
    spec('tema', 'price', 'Triple exponential moving average of the close.', [len('length', 20)], V, { terms: ['length'], mult: 3, add: -3 }),
    spec('rma', 'price', 'Wilder moving average (RMA) of the close: very smooth and slow.', [len('length', 7)], V, L('length')),
    spec('vwma', 'price', 'Volume-weighted moving average of the close: busy candlesticks count more.', [len('length', 20)], V, L('length')),
    spec('lsma', 'price', 'Least-squares moving average: the end of a straight line fitted to recent closes.', [len('length', 25), num('offset', 0, -100, 100)], V, L('length')),
    spec('alma', 'price', 'Arnaud Legoux moving average: smooth, weighted toward recent closes.', [len('window', 9), num('offset', 0.85, 0, 1), num('sigma', 6, 0.5, 50)], V, L('window')),
    spec('kama', 'price', 'Kaufman adaptive moving average: speeds up in clean trends, flattens in choppy markets.', [len('er', 10), len('fast', 2, 1, 100), len('slow', 30, 2, 200)], V, { terms: ['er'] }),
    spec('mcginley', 'price', 'McGinley dynamic: a self-adjusting average that stays close to price.', [len('length', 14), num('k', 0.6, 0.05, 5)], V, L('length')),
    spec('envelope', 'price', 'A moving average with lines a fixed percent above and below it.', [len('length', 20), num('pct', 10, 0.1, 50), pick('ma_type', 'sma', MA_TYPES)], BAND, { terms: ['length'], mult: 1.05, add: 3 }),
    spec('vwap', 'price', 'Volume-weighted average price. It starts again each session on intraday candlesticks, each month on daily ones and each year on weekly and monthly ones.', [], V),
    spec('vwapbands', 'price', 'VWAP with bands one and two standard deviations away; it starts again each session (intraday), month (daily) or year (weekly, monthly).', [], ['vwap', 'upper1', 'lower1', 'upper2', 'lower2']),
    spec('bb', 'price', 'Bollinger bands: a moving average with bands k standard deviations away.', [
        { name: 'length', kind: 'len', min: 2, max: 5000, default: 20 }, { name: 'k', kind: 'num', min: 0.1, max: 10, default: 2 },
    ], BAND, L('length')),
    spec('keltner', 'price', 'Keltner channel: an EMA of the close with bands mult average true ranges away (EMA 20, ATR 10, 2 by default).', [len('length', 20), num('mult', 2, 0.1, 20), len('atr_length', 10)], BAND, { terms: ['length', 'atr_length'], add: -1 }),
    spec('donchian', 'price', 'Donchian channel: the highest high and lowest low of the last length candlesticks.', [len('length', 20)], ['upper', 'lower', 'mid'], L('length')),
    spec('supertrend', 'price', 'Supertrend line and direction: direction is 1 in an up trend (the line below the price) and -1 in a down trend, the opposite sign of Pine\'s ta.supertrend (where -1 is up). Both are missing until the line has its first value.', [
        { name: 'period', kind: 'len', min: 1, max: 500, default: 10 }, { name: 'mult', kind: 'num', min: 0.1, max: 20, default: 3 },
    ], ['value', 'direction'], L('period'), { fieldTypes: { direction: 'int' } }),
    spec('sar', 'price', 'Parabolic SAR: trailing dots that speed up as a trend continues.', [num('step', 0.02, 0.001, 0.5), num('max', 0.2, 0.05, 1)], ['value', 'up'], { add: 1 }, { fieldTypes: { up: 'bool' } }),
    spec('ichimoku', 'price', 'Ichimoku cloud. The lagging line is drawn from a later close, so scans and backtests refuse the study as a whole (SPEC section 13).', [len('tenkan', 9), len('kijun', 26), len('senkou_b', 52)], ['tenkan', 'kijun', 'senkou_a', 'senkou_b', 'chikou'], { terms: ['senkou_b', 'kijun'], add: -2 }),
    spec('linregchannel', 'price', 'Linear-regression channel: a best-fit line through recent closes with bands deviations standard deviations away.', [len('length', 100), num('deviations', 2, 0.1, 10)], BAND, L('length')),
    spec('sessionvwap', 'price', 'VWAP that starts again at each period (session, week, month or year). On daily candlesticks a session anchor becomes month.', [pick('anchor', 'session', VWAP_ANCHORS)], ['vwap', 'upper1', 'lower1', 'upper2', 'lower2', 'upper3', 'lower3']),
    spec('avwap', 'price', 'Anchored VWAP from a chosen candlestick. The anchor is picked from the latest data, so earlier values change as candlesticks arrive (chart only).', [pick('anchor', 'session', AVWAP_ANCHORS), len('lookback', 50), len('periods_back', 0, 0, 100)], ['vwap', 'upper1', 'lower1', 'upper2', 'lower2', 'upper3', 'lower3']),
    spec('pivothl', 'price', 'Swing highs and lows over left and right candlesticks. A pivot is shown on the candlestick that formed it, which is known only right candlesticks later (chart only).', [len('left', 10), len('right', 10)], ['high', 'low']),
    spec('zigzag', 'price', 'ZigZag line through the main swings: each must move at least deviation percent, and beat legs candlesticks on each side to count as a swing. The last leg is redrawn as candlesticks arrive (chart only).', [num('deviation', 5, 0.1, 50), len('legs', 10, 2, 500)], ['points']),
    spec('pivot', 'price', 'Floor-trader pivot levels.', [], V, undefined, { unavailable: 'Pivot levels are a set of levels for the chart, not a value per candlestick. Use levels.* for support and resistance.' }),
    spec('fractals', 'price', 'Williams fractals.', [len('periods', 2, 1, 20)], ['up', 'down'], undefined, { unavailable: 'The calculation stays in the app until the owner decides (see PROVENANCE). Once available it will need `periods` candlesticks after each fractal.' }),
    // 2026-10-26 (I1): chart studies added after release A's list; listed so the registry stays complete, not yet script
    // functions (their warm-up on non-daily data and the period choice need a script-side rule first).
    spec('cpr', 'price', 'Central pivot range from the previous period.', [pick('timeframe', 'auto', ['auto', 'D', 'W', 'M', 'Y'])], ['tc', 'pivot', 'bc'], undefined, { unavailable: 'A chart level set (added 2026-10-26), not yet a script function. Use levels.* or compute it from tf("W") highs, lows and closes.' }),
    spec('prevhl', 'price', 'Previous period high, low and close.', [pick('timeframe', 'auto', ['auto', 'D', 'W', 'M', 'Y'])], ['high', 'low', 'close'], undefined, { unavailable: 'A chart level set (added 2026-10-26), not yet a script function. Use ta.highest(high, n)[1] or tf("W") instead.' }),
    spec('hl52', 'price', '52-week high and low.', [len('weeks', 52, 1, 260)], ['high', 'low'], undefined, { unavailable: 'A chart level set (added 2026-10-26), not yet a script function. Use ta.highest(high, 252) and ta.lowest(low, 252) on daily candlesticks.' }),
    spec('orb', 'price', 'Opening range high and low.', [len('minutes', 15, 1, 375)], ['high', 'low'], undefined, { unavailable: 'An intraday chart study (added 2026-10-26); scripts read one candlestick per session, so there is no opening range to take.' }),
    spec('squeeze', 'panel', 'Squeeze momentum: Bollinger Bands inside the Keltner Channel, and a momentum histogram.', [len('bb_length', 20), num('bb_mult', 2, 0.1, 10), len('kc_length', 20), num('kc_mult', 1.5, 0.1, 10)], ['mom', 'on', 'off'], undefined, { unavailable: 'A chart study (added 2026-10-26), not yet a script function; its result fields are being settled with the alerts work.' }),
    spec('chandelier', 'price', 'Chandelier exit.', [len('length', 22), len('atr_length', 22), num('mult', 3, 0.1, 20), len('use_close', 1, 0, 1)], ['long', 'short'], undefined, { unavailable: 'The calculation stays in the app until the owner decides (see PROVENANCE).' }),
    // Oscillators and strength
    spec('rsi', 'panel', 'Relative strength index of the close (Wilder).', [len('length', 14)], V, { terms: ['length'] }),
    spec('macd', 'panel', 'MACD line, signal line and histogram.', [len('fast', 12), len('slow', 26), len('signal', 9)], ['macd', 'signal', 'hist'], { terms: ['slow', 'signal'], add: -2 }),
    spec('stoch', 'panel', 'Stochastic oscillator %K and %D.', [len('length', 14), len('smooth', 3)], ['k', 'd'], { terms: ['length', 'smooth'], add: -2 }),
    spec('adx', 'panel', 'Average directional index with +DI and -DI.', [len('length', 14)], ['adx', 'plus_di', 'minus_di'], { terms: ['length'], mult: 2, add: -1 }),
    spec('atr', 'panel', 'Average true range (Wilder).', [len('length', 14)], V, L('length')),
    spec('obv', 'panel', 'On-balance volume: volume added on up closes and taken off on down closes.', [], V),
    spec('williamsr', 'panel', 'Williams %R: where the close sits in the recent high-low range, from -100 to 0.', [len('length', 14)], V, L('length')),
    spec('cmf', 'panel', 'Chaikin money flow.', [len('length', 20)], V, L('length')),
    spec('dpo', 'panel', 'Detrended price oscillator.', [len('length', 20)], V, { terms: ['length'], mult: 1.5 }),
    spec('trix', 'panel', 'TRIX: 10000 times the one-candlestick change of the logarithm of a triple-smoothed average (about 100 times its change in percent).', [len('length', 18)], V, { terms: ['length'], mult: 3, add: -2 }),
    spec('tsi', 'panel', 'True strength index and its signal line.', [len('long', 25), len('short', 13), len('signal', 13)], ['tsi', 'signal'], { terms: ['long', 'short', 'signal'], add: -2 }),
    spec('ppo', 'panel', 'Percentage price oscillator, signal and histogram.', [len('fast', 12), len('slow', 26), len('signal', 9)], ['ppo', 'signal', 'hist'], { terms: ['slow', 'signal'], add: -2 }),
    spec('cmo', 'panel', 'Chande momentum oscillator.', [len('length', 14)], V, { terms: ['length'] }),
    spec('aroon', 'panel', 'Aroon up and down: how recently the highest high and lowest low happened.', [len('length', 25)], ['up', 'down'], { terms: ['length'] }),
    spec('bbw', 'panel', 'Bollinger band width as a percent of the middle line.', [
        { name: 'length', kind: 'len', min: 2, max: 5000, default: 20 }, { name: 'k', kind: 'num', min: 0.1, max: 10, default: 2 },
    ], V, L('length')),
    spec('chop', 'panel', 'Choppiness index: high when price is moving sideways, low when it is trending.', [len('length', 14)], V, L('length')),
    spec('ewo', 'panel', 'Elliott wave oscillator: the gap between a fast and a slow average.', [len('fast', 5), len('slow', 34)], V, L('slow')),
    spec('stochrsi', 'panel', 'Stochastic RSI %K and %D.', [len('length', 14), len('k_smooth', 3), len('d_smooth', 3)], ['k', 'd'], { terms: ['length', 'length', 'k_smooth', 'd_smooth'], add: -3 }),
    spec('cci', 'panel', 'Commodity channel index.', [len('length', 14)], V, L('length')),
    spec('mfi', 'panel', 'Money flow index: a volume-weighted RSI.', [len('length', 14)], V, { terms: ['length'] }),
    spec('roc', 'panel', 'Rate of change of the close, in percent.', [len('length', 14)], V, { terms: ['length'] }),
    spec('kdj', 'panel', 'KDJ: stochastic K, D and J.', [len('length', 14), len('k_smooth', 3), len('d_smooth', 3)], ['k', 'd', 'j'], { terms: ['length', 'k_smooth', 'd_smooth'], add: -3 }),
    spec('adline', 'panel', 'Accumulation/distribution line.', [], V),
    spec('ao', 'panel', 'Awesome oscillator: 5-candlestick minus 34-candlestick average of the midpoint.', [], V, { add: 33 }),
    spec('vroc', 'panel', 'Volume rate of change, in percent.', [len('length', 14)], V, { terms: ['length'] }),
    spec('uo', 'panel', 'Ultimate oscillator over three windows.', [len('p1', 7), len('p2', 14), len('p3', 28)], V, { terms: ['p3'] }),
    spec('crsi', 'panel', 'Connors RSI: the average of a short RSI, a streak RSI and a percent rank.', [len('rsi_length', 3), len('streak_length', 2), len('rank_length', 100)], V, { terms: ['rank_length'], add: 1 }),
    spec('fisher', 'panel', 'Fisher transform and its trigger line.', [len('length', 9)], ['fisher', 'trigger'], { terms: ['length'] }),
    spec('coppock', 'panel', 'Coppock curve.', [len('roc_long', 14), len('roc_short', 11), len('wma', 10)], V, { terms: ['roc_long', 'roc_short', 'wma'], add: -1 }),
    spec('vortex', 'panel', 'Vortex indicator: +VI and -VI.', [len('length', 14)], ['plus', 'minus'], { terms: ['length'] }),
    spec('stddev', 'panel', 'Standard deviation of the close.', [len('length', 20)], V, L('length')),
    spec('massindex', 'panel', 'Mass index: widening of the high-low range, read for reversal bulges.', [len('ema_length', 9), len('sum_length', 25)], V, { terms: ['ema_length', 'ema_length', 'sum_length'], add: -3 }),
    spec('kst', 'panel', 'Know sure thing and its signal line.', [], ['kst', 'signal'], { add: 52 }),
    spec('chaikinosc', 'panel', 'Chaikin oscillator: fast minus slow average of the accumulation/distribution line.', [len('fast', 3), len('slow', 10)], V, L('slow')),
    spec('forceindex', 'panel', 'Force index: price change times volume, smoothed.', [len('length', 13)], V, { terms: ['length'] }),
    spec('eom', 'panel', 'Ease of movement.', [len('length', 14)], V, { terms: ['length'] }),
    spec('elderray', 'panel', 'Elder ray: bull power and bear power around an exponential average.', [len('length', 13)], ['bull', 'bear'], L('length')),
    spec('percentb', 'panel', 'Bollinger %B: where the close sits between the bands (1 at the upper band, 0 at the lower).', [len('length', 20), num('mult', 2, 0.1, 10)], V, L('length')),
    spec('historicalvol', 'panel', 'Historical volatility as a yearly percentage.', [len('length', 10), len('annualisation', 252, 1, 366)], V, { terms: ['length'] }),
    spec('ulcer', 'panel', 'Ulcer index: how deep and how long price has been below recent highs.', [len('length', 14)], V, { terms: ['length'], mult: 2, add: -2 }),
    spec('adr', 'panel', 'Average high-to-low range, in price.', [len('length', 14)], V, L('length')),
    spec('adrpercent', 'panel', 'Average high-to-low range as a percent of price.', [len('length', 14)], V, L('length')),
    spec('momentum', 'panel', 'Close minus the close length candlesticks earlier.', [len('length', 10)], V, { terms: ['length'] }),
    spec('aroonosc', 'panel', 'Aroon oscillator: Aroon up minus Aroon down.', [len('length', 14)], V, { terms: ['length'] }),
    spec('rvi', 'panel', 'Relative vigor index and its signal line.', [len('length', 10)], ['rvi', 'signal'], { terms: ['length'], add: 5 }),
    spec('bop', 'panel', 'Balance of power: who controls each candlestick, smoothed.', [len('smooth', 14)], V, L('smooth')),
    spec('smi', 'panel', 'Stochastic momentum index and its average.', [len('k_length', 10), len('d_length', 3), len('ema_length', 3)], ['smi', 'ema'], { terms: ['k_length', 'd_length', 'd_length', 'ema_length'], add: -4 }),
    spec('pvt', 'panel', 'Price volume trend.', [], V, { add: 1 }),
    spec('nvi', 'panel', 'Negative volume index.', [num('start', 1000, 1, 1000000)], V),
    spec('pvi', 'panel', 'Positive volume index.', [num('start', 1000, 1, 1000000)], V),
    spec('klinger', 'panel', 'Klinger volume oscillator and its signal line.', [len('fast', 34), len('slow', 55), len('signal', 13)], ['kvo', 'signal'], { terms: ['slow', 'signal'], add: -1 }),
    spec('netvolume', 'panel', 'Volume counted positive on up candlesticks and negative on down ones.', [], V, { add: 1 }),
    spec('volumema', 'panel', 'Volume and its moving average.', [len('ma_length', 20)], ['volume', 'ma'], L('ma_length')),
    spec('rvol', 'panel', 'Relative volume: volume against the average of the previous length sessions (today excluded). Intraday it compares volume so far today with the same time of day; on daily candlesticks it is volume / ta.sma(volume, length)[1].', [len('length', 10), pick('mode', 'cumulative', ['cumulative', 'regular'])], V, { terms: ['length'] }),
];
/**
 * Studies that read the close and nothing else (two also weight by volume: vwma, and envelope with ma_type="vwma"). They
 * take an optional `src=` series in place of the close (WP1, 2026-10-17): `ind.rsi(14, src=volume)`. Left out, the study
 * reads the close, exactly as before. Studies that need the high, low or volume keep their own inputs.
 */
export const SOURCE_STUDY_IDS = new Set([
    'ema', 'sma', 'wma', 'hma', 'dema', 'tema', 'rma', 'vwma', 'lsma', 'alma', 'kama', 'mcginley', 'envelope', 'bb',
    'rsi', 'macd', 'dpo', 'trix', 'tsi', 'ppo', 'cmo', 'bbw', 'ewo', 'stochrsi', 'roc', 'crsi', 'coppock', 'stddev', 'kst',
    'percentb', 'historicalvol', 'ulcer', 'momentum',
]);
export const STUDY_SPECS = RAW_SPECS.map((s) => (SOURCE_STUDY_IDS.has(s.id) ? { ...s, source: true } : s));
export const STUDY_SPEC_BY_ID = new Map(STUDY_SPECS.map((s) => [s.id, s]));
