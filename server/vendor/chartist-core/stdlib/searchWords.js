// Words people search the library with that are not in a name or a summary (2026-10-25, B8-5): pandas methods, Pine Script names
// and Chartink phrases, each with the names to write here. Used by `chartist stdlib <word>` (and any editor search) before the
// plain text search. Lower case; a word may be a phrase.
export const SEARCH_WORDS = {
    // pandas
    rolling: ['ta.sma', 'ta.highest', 'ta.lowest', 'ta.stdev', 'ta.median', 'ta.count'],
    shift: ['x[1] (the value one candlestick back)'],
    diff: ['ta.change', 'x - x[n]'],
    pct_change: ['ta.roc', 'x / x[n] - 1'],
    ewm: ['ta.ema', 'ta.rma'],
    iloc: ['x (the latest value)', 'x[1] (one candlestick back)'],
    cumsum: ['ta.cum_sum'],
    mean: ['ta.sma', 'avg'],
    std: ['ta.stdev'],
    // Pine Script
    security: ['tf', 'ref'],
    'request.security': ['tf', 'ref'],
    timeframe: ['tf'],
    weekly: ['tf'],
    week: ['tf'],
    monthly: ['tf'],
    month: ['tf'],
    alertcondition: ['alert'],
    plotshape: ['mark'],
    hline: ['plot'],
    barssince: ['ta.bars_since'],
    valuewhen: ['ta.value_when'],
    dmi: ['ind.adx'],
    // Chartink and everyday words
    average: ['ta.sma', 'ta.ema', 'ta.wma', 'ind.sma', 'ind.ema', 'avg'],
    'moving average': ['ta.sma', 'ta.ema', 'ta.wma', 'ind.sma', 'ind.ema'],
    dma: ['ta.sma'],
    sma: ['ta.sma', 'ind.sma'],
    ema: ['ta.ema', 'ind.ema'],
    crossed: ['ta.crossover', 'ta.crossunder', 'ta.cross'],
    'crossed above': ['ta.crossover'],
    'crossed below': ['ta.crossunder'],
    nr7: ['candle.nr'],
    nr4: ['candle.nr'],
    'narrow range': ['candle.nr'],
    'inside bar': ['candle.inside'],
    '52 week': ['ta.highest', 'ta.lowest'],
    '52 week high': ['ta.highest'],
    '52 week low': ['ta.lowest'],
    'days ago': ['x[n] (n candlesticks back)'],
    gap: ['price.gap_pct'],
    'rolling sum': ['ta.sma', 'ta.count'],
    sum: ['sum', 'ta.count', 'ta.cum_sum'],
};
/** The names listed for a search word (exact word, any case), or an empty list. */
export function searchWord(word) {
    const k = word.trim().toLowerCase();
    return Object.hasOwn(SEARCH_WORDS, k) ? SEARCH_WORDS[k] : [];
}
