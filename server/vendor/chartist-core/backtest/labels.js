// Server-stamped result labels (docs/adr/0004). Draft until the owner accepts the ADR.
//
// The server works the labels out from the facts of the run. No client or tool parameter can add a fact that removes a label:
// the only inputs are what the data and the compiled script say.
export const LABELS = [
    'HYPOTHETICAL', 'SURVIVORS_ONLY', 'UNIVERSE_LOOKAHEAD', 'PRICE_BREAK_EXCLUDED', 'NOT_DIVIDEND_ADJUSTED', 'ADJUSTED_PRICE_LEVEL',
    'CIRCUIT_PROXY', 'EOD_FILLS', 'MARGIN_ESTIMATE', 'STALE_DATA',
];
/** Days from yyyymmdd `a` to `b`, calendar days. */
export function daysBetween(a, b) {
    const ms = (n) => Date.UTC(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100);
    return Math.round((ms(b) - ms(a)) / 86_400_000);
}
/** The labels that apply, in taxonomy order. HYPOTHETICAL always applies to a backtest. */
export function stampLabels(f) {
    const on = new Set(['HYPOTHETICAL']);
    if (!f.pitHasDelistings)
        on.add('SURVIVORS_ONLY');
    if (f.universeFromSnapshot)
        on.add('UNIVERSE_LOOKAHEAD');
    if ((f.priceBreakExcluded ?? 0) > 0)
        on.add('PRICE_BREAK_EXCLUDED');
    if (!f.dividendAdjusted)
        on.add('NOT_DIVIDEND_ADJUSTED');
    if (f.absolutePriceLevel)
        on.add('ADJUSTED_PRICE_LEVEL');
    if (!f.circuitFromBands)
        on.add('CIRCUIT_PROXY');
    if (f.eodFills)
        on.add('EOD_FILLS');
    if (f.marginModelled)
        on.add('MARGIN_ESTIMATE');
    if (daysBetween(f.asOf, f.today) > f.freshnessDays)
        on.add('STALE_DATA');
    return LABELS.filter((l) => on.has(l));
}
/** While survivors only, absolute return headlines (total return, CAGR) are not shown (ADR-0004). */
export const headlinesAllowed = (labels) => !labels.includes('SURVIVORS_ONLY');
/** What each label says to a reader, in plain words (one sentence each). */
export const LABEL_TEXT = {
    HYPOTHETICAL: 'A simulation on past data. No order was placed and no money was at risk.',
    SURVIVORS_ONLY: 'Only stocks that still trade today are included; stocks that were delisted are missing, which flatters results.',
    UNIVERSE_LOOKAHEAD: 'The list of stocks (or index members) is today’s, applied to the past.',
    PRICE_BREAK_EXCLUDED: 'Stocks with a very large one-day move anywhere in their history were left out (the count is under the stocks left out); the rule looks at later days too, so it can flatter results.',
    NOT_DIVIDEND_ADJUSTED: 'Prices are adjusted for splits and bonuses only; dividends are not counted.',
    ADJUSTED_PRICE_LEVEL: 'The script compares with an absolute price level, which means different things on adjusted history.',
    CIRCUIT_PROXY: 'Circuit locks are guessed from candlesticks, not read from exchange bands.',
    EOD_FILLS: 'Trades are assumed at the next day’s open from end-of-day data.',
    MARGIN_ESTIMATE: 'Margin is modelled, not computed by the exchange.',
    STALE_DATA: 'The newest candlestick is older than the freshness window.',
};
