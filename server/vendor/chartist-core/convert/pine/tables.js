// Data tables of the Pine Script importer: old (v4 and earlier) names, colours, marker shapes and places, plot styles, symbols.
// Each row says what is written here and whether a note is owed. Written from the public Pine Script reference manual.
/** Pine Script v4 and earlier wrote most functions without a namespace. Mapped to their v5 names before anything else. */
export const V4_ALIASES = {
    study: 'indicator',
    security: 'request.security',
    sma: 'ta.sma',
    ema: 'ta.ema',
    rma: 'ta.rma',
    wma: 'ta.wma',
    vwma: 'ta.vwma',
    hma: 'ta.hma',
    alma: 'ta.alma',
    swma: 'ta.swma',
    linreg: 'ta.linreg',
    rsi: 'ta.rsi',
    atr: 'ta.atr',
    highest: 'ta.highest',
    lowest: 'ta.lowest',
    highestbars: 'ta.highestbars',
    lowestbars: 'ta.lowestbars',
    change: 'ta.change',
    mom: 'ta.mom',
    roc: 'ta.roc',
    cross: 'ta.cross',
    crossover: 'ta.crossover',
    crossunder: 'ta.crossunder',
    rising: 'ta.rising',
    falling: 'ta.falling',
    barssince: 'ta.barssince',
    valuewhen: 'ta.valuewhen',
    cum: 'ta.cum',
    stdev: 'ta.stdev',
    variance: 'ta.variance',
    dev: 'ta.dev',
    median: 'ta.median',
    percentrank: 'ta.percentrank',
    correlation: 'ta.correlation',
    cci: 'ta.cci',
    cmo: 'ta.cmo',
    mfi: 'ta.mfi',
    tsi: 'ta.tsi',
    macd: 'ta.macd',
    bb: 'ta.bb',
    bbw: 'ta.bbw',
    kc: 'ta.kc',
    kcw: 'ta.kcw',
    stoch: 'ta.stoch',
    supertrend: 'ta.supertrend',
    dmi: 'ta.dmi',
    sar: 'ta.sar',
    vwap: 'ta.vwap',
    wpr: 'ta.wpr',
    pivothigh: 'ta.pivothigh',
    pivotlow: 'ta.pivotlow',
    obv: 'ta.obv',
    tr: 'ta.tr',
    accdist: 'ta.accdist',
    pvt: 'ta.pvt',
    abs: 'math.abs',
    max: 'math.max',
    min: 'math.min',
    avg: 'math.avg',
    sum: 'math.sum',
    sqrt: 'math.sqrt',
    log: 'math.log',
    log10: 'math.log10',
    exp: 'math.exp',
    pow: 'math.pow',
    round: 'math.round',
    floor: 'math.floor',
    ceil: 'math.ceil',
    sign: 'math.sign',
    tostring: 'str.tostring',
};
/** v4 `input(..., type=input.integer)` type words. */
export const V4_INPUT_TYPES = {
    'input.integer': 'int',
    'input.int': 'int',
    'input.float': 'float',
    'input.bool': 'bool',
    'input.string': 'string',
    'input.source': 'source',
    'input.symbol': 'symbol',
    'input.resolution': 'timeframe',
    'input.timeframe': 'timeframe',
    'input.session': 'session',
    'input.color': 'color',
};
/** Pine's named colours to this language's theme tones (there is no purple here, a house rule). */
export const NAMED_COLORS = {
    'color.green': { tone: 'color.up' },
    'color.lime': { tone: 'color.up' },
    'color.red': { tone: 'color.down' },
    'color.maroon': { tone: 'color.down' },
    'color.blue': { tone: 'color.blue' },
    'color.navy': { tone: 'color.blue' },
    'color.teal': { tone: 'color.teal' },
    'color.aqua': { tone: 'color.teal' },
    'color.orange': { tone: 'color.amber' },
    'color.yellow': { tone: 'color.amber', note: 'color.yellow is drawn amber' },
    'color.olive': { tone: 'color.amber', note: 'color.olive is drawn amber' },
    'color.gray': { tone: 'color.gray' },
    'color.silver': { tone: 'color.gray' },
    'color.white': { tone: 'color.neutral', note: 'color.white is drawn in the neutral tone' },
    'color.black': { tone: 'color.neutral', note: 'color.black is drawn in the neutral tone' },
    'color.purple': { tone: 'color.blue', note: 'there is no purple here; color.purple is drawn blue' },
    'color.fuchsia': { tone: 'color.blue', note: 'there is no purple here; color.fuchsia is drawn blue' },
};
/** Nearest theme tone of a written colour, by hue. */
export function toneOfRgb(r, g, b) {
    const R = r / 255;
    const G = g / 255;
    const B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (s < 0.15 || d < 0.08)
        return 'color.gray';
    let h;
    if (max === R)
        h = 60 * (((G - B) / d) % 6);
    else if (max === G)
        h = 60 * ((B - R) / d + 2);
    else
        h = 60 * ((R - G) / d + 4);
    if (h < 0)
        h += 360;
    if (h < 20 || h >= 340)
        return 'color.down';
    if (h < 70)
        return 'color.amber';
    if (h < 160)
        return 'color.up';
    if (h < 200)
        return 'color.teal';
    return 'color.blue';
}
export function toneOfHex(hex) {
    const v = hex.replace('#', '');
    return toneOfRgb(parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16));
}
/** plotshape style to a marker shape; `note` when the drawing differs. */
export const SHAPES = {
    'shape.triangleup': { shape: 'triangle_up' },
    'shape.triangledown': { shape: 'triangle_down' },
    'shape.circle': { shape: 'dot' },
    'shape.square': { shape: 'square' },
    'shape.diamond': { shape: 'diamond' },
    'shape.labelup': { shape: 'triangle_up', note: true },
    'shape.labeldown': { shape: 'triangle_down', note: true },
    'shape.arrowup': { shape: 'triangle_up', note: true },
    'shape.arrowdown': { shape: 'triangle_down', note: true },
    'shape.flag': { shape: 'triangle_up', note: true },
    'shape.xcross': { shape: 'diamond', note: true },
    'shape.cross': { shape: 'diamond', note: true },
};
export const LOCATIONS = {
    'location.abovebar': { where: 'above' },
    'location.belowbar': { where: 'below' },
    'location.top': { where: 'above', note: true },
    'location.bottom': { where: 'below', note: true },
    'location.absolute': { where: 'above', note: true },
};
/** plot style to ours; `note` when the drawing differs. */
export const PLOT_STYLES = {
    'plot.style_line': { style: null },
    'plot.style_linebr': { style: null, note: 'plot.style_linebr is drawn as a line; it already breaks where the value is missing.' },
    'plot.style_stepline': { style: 'step' },
    'plot.style_stepline_diamond': { style: 'step', note: 'plot.style_stepline_diamond is drawn as a step line.' },
    'plot.style_steplinebr': { style: 'step', note: 'plot.style_steplinebr is drawn as a step line.' },
    'plot.style_histogram': { style: 'histogram' },
    'plot.style_columns': { style: 'histogram', note: 'plot.style_columns is drawn as a histogram.' },
    'plot.style_area': { style: 'area' },
    'plot.style_areabr': { style: 'area', note: 'plot.style_areabr is drawn as an area.' },
    'plot.style_circles': { style: null, note: 'plot.style_circles is drawn as a line.' },
    'plot.style_cross': { style: null, note: 'plot.style_cross is drawn as a line.' },
};
/** Pine symbols of indices to the names the data here uses. Needs verification against the index registry. */
export const TICKERS = {
    'NSE:NIFTY': 'NIFTY 50',
    'NSE:NIFTY50': 'NIFTY 50',
    'NSE:BANKNIFTY': 'NIFTY BANK',
    'NSE:CNXIT': 'NIFTY IT',
    'NSE:NIFTYIT': 'NIFTY IT',
    'NSE:CNXFINANCE': 'NIFTY FIN SERVICE',
    'NSE:FINNIFTY': 'NIFTY FIN SERVICE',
    'NSE:CNXPHARMA': 'NIFTY PHARMA',
    'NSE:CNXAUTO': 'NIFTY AUTO',
    'NSE:CNXFMCG': 'NIFTY FMCG',
    'NSE:CNXMETAL': 'NIFTY METAL',
    'NSE:CNXREALTY': 'NIFTY REALTY',
    'NSE:CNXENERGY': 'NIFTY ENERGY',
    'NSE:NIFTYMIDCAP150': 'NIFTY MIDCAP 150',
    'NSE:CNX500': 'NIFTY 500',
};
/** Calendar and session values: not available here (no calendar values in the language). */
export const CALENDAR_NAMES = new Set([
    'time',
    'time_close',
    'timenow',
    'time_tradingday',
    'year',
    'month',
    'weekofyear',
    'dayofmonth',
    'dayofweek',
    'hour',
    'minute',
    'second',
    'last_bar_time',
]);
/** Python keywords and the names this language keeps for itself (E-NAME-SHADOW); a Pine name equal to one gets a trailing _. */
export const TAKEN_NAMES = new Set([
    // Python keywords
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
    'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
    'return', 'try', 'while', 'with', 'yield', 'match', 'case',
    // candlestick fields and built-ins
    'open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'abs', 'min', 'max', 'nz', 'near', 'all', 'any', 'input',
    'show', 'plot', 'mark', 'alert', 'tf', 'ref', 'range', 'is_na', 'na', 'sum', 'avg', 'fill', 'bgcolor',
    // groups
    'bench', 'breadth', 'candle', 'color', 'fund', 'fut', 'ind', 'info', 'levels', 'opt', 'pattern', 'price', 'strategy', 'ta', 'xs',
    'flow', 'deriv', 'math',
]);
/** Prices a Pine source setting can choose here, in the order offered. */
export const SOURCE_CHOICES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];
