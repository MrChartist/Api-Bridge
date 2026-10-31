// `candle.pattern(id)` and `candle.hammer()` (S10): the 24 textbook patterns (hanging man and inverted hammer retired 2026-10-18) that end on a candlestick, one 1 / 0 / missing
// per candlestick. The rules are the kernel's pattern book (kernel/candlePatterns.ts), the same code the app's Price Action
// rating uses; this file only lines them up with the runtime's arrays.
import { CANDLE_PATTERNS, calcCandlePattern } from '../kernel/candlePatterns.js';
import { RuntimeError } from '../runtime/errors.js';
/** snake_case id of the language to the camelCase id of the pattern book (`bullish_engulfing` to `bullishEngulfing`). */
const engineId = (id) => id.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const KNOWN = new Set(CANDLE_PATTERNS.map((p) => p.id));
export function candlesOf(b) {
    const out = new Array(b.n);
    for (let i = 0; i < b.n; i++)
        out[i] = { time: b.date[i], open: b.open[i], high: b.high[i], low: b.low[i], close: b.close[i], volume: b.volume[i] };
    return out;
}
function patternSeries(ctx, snake) {
    const id = engineId(snake);
    if (!KNOWN.has(id))
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} does not know the pattern "${snake}"`);
    // Each candlestick looks back over its reference window of 5 (14 for the doji average range) and up to 3 candlesticks of pattern.
    ctx.touch(ctx.n * 15);
    return Float64Array.from(calcCandlePattern(candlesOf(ctx.bars), id));
}
export const CANDLE_FUNCTIONS = {
    'candle.pattern': (ctx) => {
        const a = ctx.args[0];
        if (!a || !('t' in a))
            throw new RuntimeError('E-RT-ARGS', 'candle.pattern needs the pattern name as text');
        return patternSeries(ctx, a.t);
    },
    'candle.hammer': (ctx) => patternSeries(ctx, 'hammer'),
};
