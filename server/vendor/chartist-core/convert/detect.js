// Which trading-script language a pasted text is written in. Scored by plain evidence (patterns), never by AI. ChartistScript
// that compiles is always recognised first, so pasting our own script never shows an "import" offer.
import { compileSource } from '../compile.js';
const RULES = {
    chartist: [
        { re: /^\s*@(screener|indicator|alert|strategy)\b/m, score: 4, says: 'a script-type line (@screener, @indicator, ...)' },
        { re: /^\s*def\s+\w+\s*\([^)]*\)\s*:\s*$/m, score: 2, says: 'a def ...: line' },
        { re: /\b(ind|candle|levels|fund|info)\.\w+\s*\(/, score: 2, says: 'ChartistScript library names (ind., candle., levels.)' },
        { re: /\bta\.(bars_since|value_when|cum_sum|latch|count)\b/, score: 3, says: 'ChartistScript ta. names' },
        { re: /^\s*#/m, score: 1, says: '# comments' },
        { re: /\b(True|False)\b/, score: 1, says: 'True/False' },
    ],
    pine: [
        { re: /\/\/\s*@version\s*=\s*\d/, score: 6, says: '//@version= line' },
        { re: /^\s*(indicator|strategy|study|library)\s*\(/m, score: 4, says: 'indicator(...) / strategy(...) / study(...) declaration' },
        { re: /\binput\.(int|float|bool|string|source|symbol|timeframe|color|session)\s*\(/, score: 3, says: 'input.int / input.float settings' },
        { re: /:=/, score: 2, says: ':= reassignment' },
        { re: /\)\s*=>/, score: 2, says: 'function written with =>' },
        { re: /\b(plotshape|plotchar|hline|alertcondition|bgcolor|barcolor)\s*\(/, score: 2, says: 'Pine drawing calls (plotshape, hline, alertcondition)' },
        { re: /\brequest\.security\s*\(|\bsecurity\s*\(\s*syminfo/, score: 3, says: 'request.security' },
        { re: /\b(syminfo|barstate|timeframe)\.\w+/, score: 2, says: 'syminfo. / barstate. / timeframe. values' },
        { re: /^\s*var(ip)?\s+(int|float|bool|string|line|label|table|box)?\s*\w+\s*=/m, score: 2, says: 'var declarations' },
        { re: /\?[^:\n]+:/, score: 1, says: 'c ? a : b choices' },
        { re: /\/\//, score: 1, says: '// comments' },
        { re: /\b(true|false)\b/, score: 1, says: 'lower-case true/false' },
        { re: /\bcolor\.(new|rgb)\s*\(|\bcolor\.(green|red|orange|yellow|lime|purple)\b/, score: 1, says: 'Pine colours' },
    ],
    chartink: [
        { re: /\{\s*(cash|\d+)\s*\}/i, score: 5, says: 'a {cash} / {segment} block' },
        { re: /\b(latest|\d+\s+(day|week|month)s?\s+ago)\s+(close|open|high|low|volume|sma|ema|rsi|max|min|macd|supertrend|upper|lower|adx|avg)\b/i, score: 4, says: '"latest close" / "1 day ago high" offsets' },
        { re: /\bcrossed\s+(above|below)\b/i, score: 4, says: '"crossed above" / "crossed below"' },
        { re: /\b(greater|less)\s+than\b/i, score: 3, says: '"Greater than" / "Less than"' },
        { re: /\b(daily|weekly|monthly)\s+(close|open|high|low|volume|sma|ema|rsi|adx|max|min)\b/i, score: 2, says: '"Daily Close" / "Weekly Rsi" frames' },
        { re: /\bnumber\s+-?\d/i, score: 2, says: '"Number 25" constants' },
        { re: /\b(sma|ema|rsi|max|min)\(\s*\d*\s*,?\s*(latest|daily|weekly)?\s*(close|high|low|volume)?/i, score: 1, says: 'sma( close , n ) spacing' },
        { re: /\bmarket\s+cap\b/i, score: 2, says: '"market cap"' },
    ],
    afl: [
        { re: /^\s*(Filter|Buy|Sell|Short|Cover)\s*=\s*[^=]/m, score: 4, says: 'Filter = / Buy = / Sell = lines' },
        { re: /\b(AddColumn|Param|Optimize|HHV|LLV|ExRem|IIf|ApplyStop|PlotShapes|TimeFrameSet|Foreign|AlertIf|BarsSince|ValueWhen)\s*\(/, score: 4, says: 'AFL functions (AddColumn, Param, HHV, IIf, ApplyStop)' },
        { re: /_SECTION_BEGIN|SetChartOptions|GraphXSpace/, score: 4, says: '_SECTION_BEGIN' },
        { re: /\bRef\s*\(\s*[^,]+,\s*-\s*\d+\s*\)/, score: 3, says: 'Ref(x, -n)' },
        { re: /;\s*$/m, score: 2, says: 'statements end with ;' },
        { re: /\b(AND|OR|NOT)\b/, score: 1, says: 'upper-case AND / OR' },
        { re: /\b[CHLOV]\b\s*[<>]=?/, score: 1, says: 'short price names C, H, L, O, V' },
        { re: /\bMA\s*\(\s*[CHLOV]\b/, score: 2, says: 'MA(C, n)' },
    ],
    python: [
        { re: /^\s*(import|from)\s+(pandas|numpy|talib|pandas_ta|vectorbt|yfinance)\b/m, score: 6, says: 'import pandas / talib / numpy' },
        { re: /\bdf\s*\[\s*['"]|\bdf\.\w+/, score: 4, says: "df['close'] / df.close" },
        { re: /\.(rolling|ewm)\s*\(/, score: 4, says: '.rolling(...) / .ewm(...)' },
        { re: /\.(shift|pct_change|iloc|diff)\s*\(|\.iloc\[/, score: 3, says: '.shift() / .pct_change() / .iloc' },
        { re: /\btalib\.\w+|\bnp\.where\s*\(|\bvbt\.\w+/, score: 3, says: 'talib. / np.where / vbt.' },
        { re: /\)\s*[&|]\s*\(/, score: 1, says: '(a) & (b)' },
    ],
};
/** Evidence against a language (subtracted). */
const AGAINST = {
    pine: [
        { re: /^\s*@(screener|indicator|alert|strategy)\b/m, score: 5, says: '' },
        { re: /^\s*def\s+\w+/m, score: 3, says: '' },
    ],
    chartink: [
        { re: /^\s*def\s+\w+/m, score: 3, says: '' },
        { re: /:=|\/\/\s*@version/, score: 4, says: '' },
        { re: /;\s*$/m, score: 2, says: '' },
    ],
    afl: [
        { re: /\bta\.\w+/, score: 3, says: '' },
        { re: /:=|\/\/\s*@version/, score: 4, says: '' },
        { re: /\bdf\[/, score: 3, says: '' },
    ],
    python: [
        { re: /^\s*@(screener|indicator|alert|strategy)\b/m, score: 5, says: '' },
        { re: /\bta\.sma\(\s*close\b/, score: 2, says: '' },
        { re: /:=|\/\/\s*@version/, score: 4, says: '' },
    ],
    chartist: [
        { re: /\/\/\s*@version|:=|\{\s*cash\s*\}|\bdf\[|^\s*import\s/m, score: 4, says: '' },
    ],
};
const NAME = { chartist: 'ChartistScript', pine: 'Pine Script', chartink: 'Chartink scan text', afl: 'AmiBroker AFL', python: 'Python (pandas / TA-Lib)', unknown: 'unknown' };
export function languageName(lang) {
    return NAME[lang];
}
/**
 * Guesses for the language of `text`, best first, each with its evidence. Only guesses with confidence 0.2 or more are returned;
 * an empty text or one with no evidence gives [{ lang: 'unknown', confidence: 0 }]. ChartistScript that compiles is certain.
 */
export function detectLanguage(text) {
    const src = text.slice(0, 20000);
    if (!src.trim())
        return [{ lang: 'unknown', confidence: 0, evidence: [] }];
    let compiles = false;
    try {
        compiles = compileSource(src).ok;
    }
    catch {
        compiles = false;
    }
    const out = [];
    for (const lang of Object.keys(RULES)) {
        let score = 0;
        const evidence = [];
        for (const r of RULES[lang]) {
            if (r.re.test(src)) {
                score += r.score;
                evidence.push(r.says);
            }
        }
        for (const r of AGAINST[lang] ?? [])
            if (r.re.test(src))
                score -= r.score;
        if (lang === 'chartist' && compiles) {
            score += 20;
            evidence.unshift('it compiles as ChartistScript');
        }
        if (score <= 0)
            continue;
        const confidence = Math.round((score / (score + 4)) * 100) / 100;
        if (confidence >= 0.2)
            out.push({ lang, confidence, evidence });
    }
    out.sort((a, b) => b.confidence - a.confidence);
    if (!out.length)
        return [{ lang: 'unknown', confidence: 0, evidence: [] }];
    return out;
}
