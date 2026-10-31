import { NotYetSupported, RuntimeError } from './errors.js';
import * as K from './kernels.js';
import { CANDLE_FUNCTIONS } from '../stdlib/candle.js';
import { DERIV_RUNTIME } from '../stdlib/deriv.js';
import { LEVEL_FUNCTIONS } from '../stdlib/levels.js';
import { STATE_FUNCTIONS } from '../stdlib/state.js';
import { PRICE_KERNELS } from '../stdlib/price.js';
import { STUDY_FUNCTIONS } from '../stdlib/studies/compute.js';
const series = (ctx, k) => {
    const a = ctx.args[k];
    if (!a)
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} was called without argument ${k + 1}`);
    if ('s' in a)
        return a.s;
    if ('c' in a)
        return a.c;
    throw new RuntimeError('E-RT-ARGS', `${ctx.fn} got text where a number was expected`);
};
/** An argument that must be a series (a whole array), for the kernels that walk it. */
const array = (ctx, k) => {
    const o = series(ctx, k);
    return typeof o === 'number' ? new Float64Array(ctx.n).fill(o) : o;
};
const fixed = (ctx, k) => {
    const a = ctx.args[k];
    if (!a || !('c' in a))
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} needs a fixed number as argument ${k + 1}`);
    return a.c;
};
/** Window functions touch the window at every candlestick. */
const windowed = (ctx, len) => ctx.touch(ctx.n * len);
/**
 * 'window' kernels add their whole window at every candlestick (n * len). 'one' kernels read each value a bounded
 * number of times whatever the window: the monotonic-queue extremes, and ema / rma, whose starting average is worked
 * out once per stretch of known values (kernels.ts `smooth`), so n is an honest charge.
 */
const rolling = (kernel, cost) => (ctx) => {
    const len = fixed(ctx, 1);
    if (cost === 'window')
        windowed(ctx, len);
    return kernel(array(ctx, 0), len);
};
export const CORE_FUNCTIONS = {
    ...STUDY_FUNCTIONS,
    ...CANDLE_FUNCTIONS,
    ...LEVEL_FUNCTIONS,
    ...DERIV_RUNTIME,
    ...Object.fromEntries(Object.entries(PRICE_KERNELS).map(([k, f]) => [`price.${k}`, ((c) => { c.touch(c.n); return f(c.bars); })])),
    abs: (c) => K.map1(c.n, series(c, 0), Math.abs),
    min: (c) => K.map2(c.n, series(c, 0), series(c, 1), Math.min),
    max: (c) => K.map2(c.n, series(c, 0), series(c, 1), Math.max),
    nz: (c) => K.map2(c.n, series(c, 0), series(c, 1), K.nz),
    near: (c) => K.map3(c.n, series(c, 0), series(c, 1), series(c, 2), K.near),
    'ta.sma': rolling(K.sma, 'window'),
    'ta.wma': rolling(K.wma, 'window'),
    'ta.ema': rolling(K.ema, 'one'),
    'ta.rma': rolling(K.rma, 'one'),
    'ta.highest': rolling(K.highest, 'one'),
    'ta.lowest': rolling(K.lowest, 'one'),
    'ta.highest_all': (c) => { c.touch(c.n); return K.highestAll(array(c, 0)); },
    'ta.lowest_all': (c) => { c.touch(c.n); return K.lowestAll(array(c, 0)); },
    'ta.change': (c) => K.change(array(c, 0), fixed(c, 1)),
    // True range plus one smoothing pass; ups, downs, two smoothing passes and the ratio.
    'ta.atr': (c) => { c.touch(c.n * 2); return K.atr(c.bars, fixed(c, 0)); },
    'ta.rsi': (c) => { c.touch(c.n * 4); return K.rsi(array(c, 0), fixed(c, 1)); },
    'ta.crossover': (c) => K.crossover(series(c, 0), series(c, 1), c.n),
    'ta.crossunder': (c) => K.crossunder(series(c, 0), series(c, 1), c.n),
    'ta.bars_since': (c) => K.barsSince(array(c, 0)),
    'ta.latch': (c) => K.latch(series(c, 0), series(c, 1), c.n),
    'ta.count': (c) => K.count(array(c, 0), fixed(c, 1)),
    'ta.cum_sum': (c) => K.cumSum(array(c, 0)),
    'ta.highest_since': (c) => K.highestSince(array(c, 0), series(c, 1)),
    'ta.lowest_since': (c) => K.lowestSince(array(c, 0), series(c, 1)),
    // WP1 (2026-10-17). Window statistics read their window afresh at every candlestick (n * length); a median or a
    // percentile keeps its window sorted, at most length moves per candlestick (n * length); a pivot reads left + right + 1
    // values per candlestick.
    'ta.stdev': rolling(K.stdev, 'window'),
    'ta.variance': rolling(K.variance, 'window'),
    'ta.dev': rolling(K.dev, 'window'),
    'ta.cci': rolling(K.cci, 'window'),
    'ta.median': (c) => { const len = fixed(c, 1); windowed(c, len); return K.median(array(c, 0), len); },
    'ta.percentile': (c) => { const len = fixed(c, 1); windowed(c, len); return K.percentile(array(c, 0), len, fixed(c, 2)); },
    'ta.linreg': (c) => { const len = fixed(c, 1); windowed(c, len); return K.linreg(array(c, 0), len, fixed(c, 2)); },
    'ta.correlation': (c) => { const len = fixed(c, 2); windowed(c, 2 * len); return K.correlation(array(c, 0), array(c, 1), len); },
    'ta.roc': (c) => K.roc(array(c, 0), fixed(c, 1)),
    'ta.mom': (c) => K.change(array(c, 0), fixed(c, 1)),
    'ta.rising': (c) => { const len = fixed(c, 1); windowed(c, len); return K.rising(array(c, 0), len); },
    'ta.falling': (c) => { const len = fixed(c, 1); windowed(c, len); return K.falling(array(c, 0), len); },
    'ta.cross': (c) => K.cross(series(c, 0), series(c, 1), c.n),
    'ta.pivothigh': (c) => { const l = fixed(c, 1); const r = fixed(c, 2); windowed(c, l + r + 1); return K.pivotHigh(array(c, 0), l, r); },
    'ta.pivotlow': (c) => { const l = fixed(c, 1); const r = fixed(c, 2); windowed(c, l + r + 1); return K.pivotLow(array(c, 0), l, r); },
    'math.sqrt': (c) => K.map1(c.n, series(c, 0), K.mathSqrt),
    'math.log': (c) => K.map1(c.n, series(c, 0), K.mathLog),
    'math.exp': (c) => K.map1(c.n, series(c, 0), K.mathExp),
    'math.round': (c) => K.map2(c.n, series(c, 0), series(c, 1), K.mathRound),
    'math.floor': (c) => K.map1(c.n, series(c, 0), K.mathFloor),
    'math.ceil': (c) => K.map1(c.n, series(c, 0), K.mathCeil),
    'math.sign': (c) => K.map1(c.n, series(c, 0), K.mathSign),
    'math.clamp': (c) => K.map3(c.n, series(c, 0), series(c, 1), series(c, 2), K.mathClamp),
    is_na: (c) => K.map1(c.n, series(c, 0), K.isNa),
    ...STATE_FUNCTIONS,
    'candle.inside': (c) => K.candleInside(c.bars),
    'candle.nr': (c) => {
        windowed(c, fixed(c, 0));
        return K.candleNr(c.bars, fixed(c, 0));
    },
};
export function lookup(table, ctx, node, line) {
    const f = table[ctx.fn];
    if (!f)
        throw new NotYetSupported(`\`${ctx.out ? `${ctx.fn}.${ctx.out}` : ctx.fn}\``, node, line);
    return f;
}
