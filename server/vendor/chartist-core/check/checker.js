import { childrenOf, measureTree } from '../lang/ast.js';
import { errorToDiagnostic } from '../lang/errors.js';
import { formatExpr } from '../lang/format.js';
import { tryParse } from '../lang/parser.js';
import { INPUT_OPTION_MAX_CHARS, LABEL_MAX_CHARS, MAX_DIAGNOSTICS, MAX_EXPANDED_NODES, MAX_INLINE_DEPTH, MAX_INPUT_OPTIONS, MAX_INPUTS, MAX_LOOKBACK, MAX_SHOWS, MAX_UNROLL_PER_LOOP, MAX_UNROLL_TOTAL, charCount, firstChars, } from '../limits.js';
import { NAME_HABITS, PINE_HABITS } from '../lang/pythonisms.js';
import { BUILTIN_FUNCTIONS, FRAME_FIELDS, GLOBAL_VALUES, MAX_LEGS, NAMESPACES, PLANNED, PLOT_LINEWIDTH_MAX, PLOT_OFFSET_MAX, REBALANCE, RESERVED_NAMESPACES, SIZING, PATTERN_IDS, PRICE_BLENDS, TF_CODES, fnSpec, isPriceBlend, isReservedName, membersOf, parseLegStrike, valueSpec, } from '../stdlib/manifest.js';
import { HOSTS, defaultHostFor, explainMissing, kindWords, withStages } from './hosts.js';
import { settingRange } from './settings.js';
import { certainChoice, findElsewhere, suggest } from './suggest.js';
import { ANY, NONE, constant, describe, finestFrame, frameWeight, isBoolish, isNumeric, joinTy, seriesOf, words, } from './types.js';
// ---- Small tables ----------------------------------------------------------------------------
/** A helper default (A3) is a value written out: a number (signed or not), a text or True/False. */
function helperDefaultOk(e) {
    if (e.kind === 'Number' || e.kind === 'String' || e.kind === 'Bool')
        return true;
    return e.kind === 'Unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'Number';
}
const ctext = { t: 'ctext' };
/** Most sessions `@strategy(max_hold=...)` may give (a house limit, about four years of sessions). */
export const MAX_HOLD_SESSIONS = 1000;
const cnum = (min, max) => ({ t: 'cnum', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
const DECORATOR_ARGS = {
    screener: { universe: ctext, benchmark: ctext },
    indicator: { name: ctext, overlay: { t: 'cbool' }, benchmark: ctext },
    alert: { name: ctext, benchmark: ctext },
    strategy: {
        universe: ctext, benchmark: ctext, capital: cnum(1), rebalance: { t: 'choice', values: REBALANCE },
        max_positions: { t: 'len', min: 1, max: 500 }, sizing: { t: 'choice', values: SIZING },
        costs: ctext, from_: ctext, to: ctext, split: ctext, underlying: ctext, margin_pct: cnum(1, 100),
        // A time stop: a position held through this many sessions (the one it was bought in is the first) is sold at the next open.
        max_hold: { t: 'len', min: 1, max: MAX_HOLD_SESSIONS },
    },
};
const OUTPUTS_BY_KIND = {
    'bare-screener': ['show'],
    screener: ['show'],
    'bare-indicator': ['plot', 'mark', 'bgcolor', 'fill'],
    indicator: ['plot', 'mark', 'bgcolor', 'fill'],
    alert: ['alert'],
    strategy: ['strategy.entry', 'strategy.exit', 'strategy.rank', 'strategy.stop_loss', 'strategy.take_profit', 'strategy.trail', 'strategy.leg'],
};
/** Where a list may be written (E-LIST-USE). */
const LIST_PLACES = 'Lists exist only inside all([...]), any([...]), min([...]), max([...]), sum([...]) and avg([...]), for example max([a, b, c]) or all([cond for i in range(3)]).';
/** Colour names people bring from other tools (B7): what to write instead. The language has no purple and no color.rgb on purpose. */
const COLOR_HINTS = {
    green: 'Green means price direction here: write color.up (it follows the chart\'s own up colour).',
    red: 'Red means price direction here: write color.down (it follows the chart\'s own down colour).',
    orange: 'Write color.amber.',
    yellow: 'Write color.amber.',
    grey: 'Write color.gray.',
    silver: 'Write color.gray.',
    white: 'Write color.neutral (the study\'s own colour), which reads on light and dark charts.',
    black: 'Write color.neutral (the study\'s own colour), which reads on light and dark charts.',
    purple: 'There is no purple. Use color.blue, color.teal, color.amber or color.gray.',
    violet: 'There is no purple. Use color.blue, color.teal, color.amber or color.gray.',
    fuchsia: 'There is no purple. Use color.blue, color.teal, color.amber or color.gray.',
    rgb: 'Colours are named, not written as numbers, so they follow the light and dark themes. Use color.up, color.down, color.neutral, color.blue, color.teal, color.amber or color.gray.',
    new: 'Colours are named, not written as numbers, so they follow the light and dark themes. Use color.up, color.down, color.neutral, color.blue, color.teal, color.amber or color.gray.',
};
/** Names people bring from other tools; the message says what to use instead. */
const NAME_HINTS = {
    print: 'There is no printing. Use show(value, "label") in a screener to add a result column.',
    len: 'There are no lists or strings to measure. Use ta.count(cond, n) to count candlesticks.',
    round: 'Write math.round(x) or math.round(x, 2): the maths functions are in math.*.',
    sqrt: 'Write math.sqrt(x): the maths functions are in math.*.',
    pow: 'Use the ** operator, for example x ** 2.',
    log: 'Write math.log(x) for the natural logarithm: the maths functions are in math.*.',
    exp: 'Write math.exp(x): the maths functions are in math.*.',
    int: 'There are no conversion functions. Use // for whole-number division.',
    float: 'There are no conversion functions; numbers are already decimals when needed.',
    str: 'There are no conversion functions; text is only used for labels.',
    bool: 'There are no conversion functions; use a comparison such as x > 0.',
    list: 'Lists exist only as [cond for i in range(n)] inside all() or any().',
    np: 'There are no code libraries. Use the ta.* functions instead.',
    numpy: 'There are no code libraries. Use the ta.* functions instead.',
    pd: 'There are no code libraries. Use the ta.* functions instead.',
    pandas: 'There are no code libraries. Use the ta.* functions instead.',
    Close: 'Names are lower case: close.',
    Open: 'Names are lower case: open.',
    High: 'Names are lower case: high.',
    Low: 'Names are lower case: low.',
    Volume: 'Names are lower case: volume.',
    bar_index: 'There is no candlestick counter. Use ta.bars_since(cond) to count from an event.',
    time: 'There is no clock or date in a script, so results never depend on when they run.',
    timestamp: 'There is no clock or date in a script, so results never depend on when they run.',
    // Pine Script names (B8-8): what each one is written as here.
    request: 'Pine\'s request.security(...) is written another way here: a weekly or monthly value of the same stock is tf("W").high (the last completed week: a week is seen only once it has closed), and another instrument is ref("SYMBOL").close.',
    security: 'Pine\'s security(...) is written another way here: a weekly or monthly value of the same stock is tf("W").close, and another instrument is ref("SYMBOL").close.',
    syminfo: 'A script runs on every stock in turn, so it does not name its own symbol. Another instrument is read with ref("SYMBOL").close; the stock\'s sector is info.sector.',
    timeframe: 'A script reads daily candlesticks. A weekly or monthly value is read with tf("W") or tf("M"), for example tf("W").close.',
    barmerge: 'Not needed: tf("W") gives only completed weeks, so it never sees a week before it has closed, and tf("W", partial=True) adds the week in progress.',
    alertcondition: 'An alert is its own script: @alert(name="...") on one line, def check(): below, and alert(condition, "message") inside it.',
    shape: 'Shapes are named in text here: mark(cond, shape="triangle_up"). The shapes are dot, triangle_up, triangle_down, square and diamond.',
    location: 'Where a marker goes is named in text here: mark(cond, where="below") or where="above".',
    benchmark: 'The benchmark is named on the script-type line, @screener(benchmark="NIFTY 50"), and read as bench.close.',
    df: 'There are no data frames: the prices are the names open, high, low, close and volume, for example close > ta.sma(close, 20).',
};
/** pandas methods and properties written on a value (B8-4), when the whole chain says nothing more: what to write here. */
const PANDAS_WORDS = {
    iloc: '`.iloc` is pandas. Here a value such as close is already the latest candlestick\'s, and close[1] is the one before.',
    loc: '`.loc` is pandas. Here a value such as close is already the latest candlestick\'s, and close[1] is the one before.',
    values: '`.values` is pandas. Here a value such as close is used as it is.',
    rolling: '`.rolling(n)` is pandas; here a window is a function: ta.sma(x, n), ta.highest(x, n), ta.lowest(x, n), ta.stdev(x, n) or ta.median(x, n).',
    ewm: '`.ewm(...)` is pandas; here write ta.ema(x, n), or ta.rma(x, n) for Wilder\'s average.',
    shift: '`.shift(k)` is pandas; here an earlier candlestick is written with [ ]: x[k].',
    diff: '`.diff(k)` is pandas; here write x - x[k], or ta.change(x, k).',
    pct_change: '`.pct_change(k)` is pandas; here write x / x[k] - 1, or ta.roc(x, k) for the change in percent.',
    cumsum: '`.cumsum()` is pandas; here write ta.cum_sum(x).',
    mean: '`.mean()` is pandas; here the average of the last n candlesticks is ta.sma(x, n).',
    std: '`.std()` is pandas; here the deviation of the last n candlesticks is ta.stdev(x, n).',
    max: '`.max()` is pandas; here the highest of the last n candlesticks is ta.highest(x, n).',
    min: '`.min()` is pandas; here the lowest of the last n candlesticks is ta.lowest(x, n).',
    sum: '`.sum()` is pandas; there is no rolling sum here: write ta.sma(x, n) * n, or ta.count(cond, n) to count true conditions.',
};
/** Names with exactly one meaning here, rewritten by the one-click fix (true is True, Close is close). */
const NAME_REWRITES = {
    true: 'True', false: 'False', null: 'na', nan: 'na', NaN: 'na', undefined: 'na',
    Close: 'close', Open: 'open', High: 'high', Low: 'low', Volume: 'volume',
};
/** What to know when a name is moved to another group and its arguments differ (homeHint). */
const HOME_NOTES = {
    'ind.supertrend': 'Its period comes first and its multiplier second, the other way round from Pine\'s ta.supertrend(factor, atrPeriod), so write them by name: ind.supertrend(period=10, mult=3). Its direction is 1 in an up trend and -1 in a down trend, the opposite sign of Pine\'s (where -1 is up), so Pine\'s ta.change(direction) < 0 is ta.change(st.direction) > 0 here.',
};
/** Pine Script functions called by name that are written otherwise here (2026-10-25). A user's own helper of that name wins. */
const PINE_CALLS = Object.assign(Object.create(null), {
    indicator: () => PINE_HABITS.declare('indicator'),
    study: () => PINE_HABITS.declare('study'),
    strategy: () => PINE_HABITS.declare('strategy'),
    plotshape: () => PINE_HABITS.plotshape('plotshape'),
    plotchar: () => PINE_HABITS.plotshape('plotchar'),
    plotarrow: () => PINE_HABITS.plotshape('plotarrow'),
    hline: () => PINE_HABITS.hline,
});
/** Pine's names for input() arguments, and ours. */
const PINE_INPUT_ARGS = Object.assign(Object.create(null), {
    minval: 'min', maxval: 'max',
});
/** `input(...)` called by its own name. */
function isInputCall(e) {
    return e.kind === 'Call' && e.func.kind === 'Name' && e.func.id === 'input';
}
/**
 * Words that name each field of a group, for checking the order of `a, b, c = group` (lower case). A written name is split into
 * words at `_`, at digits and where a capital follows a small letter (`bbUpper` is bb, upper), and is also read whole.
 */
const FIELD_WORDS = {
    upper: ['upper', 'up', 'top', 'ub', 'upperband', 'u', 'hi', 'high', 'ubb', 'bbu'],
    mid: ['mid', 'middle', 'basis', 'base', 'center', 'centre', 'mb', 'midline', 'm', 'middleband', 'median', 'bbm'],
    lower: ['lower', 'lo', 'bottom', 'bot', 'lb', 'lowerband', 'l', 'low', 'dn', 'down', 'lbb', 'bbl'],
    macd: ['macd', 'macdline', 'dif', 'diff'],
    signal: ['signal', 'sig', 'signalline', 'sl', 'dea'],
    hist: ['hist', 'histogram', 'histo', 'h', 'histline'],
    adx: ['adx', 'adxline'],
    plus_di: ['plusdi', 'diplus', 'pdi', 'dip', 'plus', 'pos', 'positive'],
    minus_di: ['minusdi', 'diminus', 'mdi', 'ndi', 'dim', 'minus', 'neg', 'negative'],
    k: ['k', 'kline', 'fastk', 'pctk', 'percentk', 'stochk', 'pk'],
    d: ['d', 'dline', 'slowd', 'pctd', 'percentd', 'stochd', 'pd'],
    value: ['value', 'val', 'st', 'supertrend', 'line', 'level', 'stop', 'trail'],
    direction: ['direction', 'dir', 'trend', 'dirn', 'side'],
};
/** Words of a written name: `bb_upper` and `bbUpper` give bb, upper; `plusDI` gives plus, di. */
function nameWords(name) {
    return name.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Za-z])(\d)/g, '$1_$2').replace(/(\d)([A-Za-z])/g, '$1_$2')
        .toLowerCase().split('_').filter((x) => x.length > 0 && !/^\d+$/.test(x));
}
/** Every word that names field `f`: its own name (with and without _) and the words above. */
function fieldWords(f) {
    return new Set([f.toLowerCase(), f.toLowerCase().replace(/_/g, ''), ...(Object.hasOwn(FIELD_WORDS, f) ? FIELD_WORDS[f] : [])]);
}
/**
 * The field a written name stands for, if it says so: `bb_upper`, `upperBand` and `u` are upper (in a group with an upper);
 * `macd_signal` is signal (the last word that names a field wins); `a` says nothing. A short prefix is allowed (`kup`, `kmid`).
 */
export function fieldMeant(name, fields) {
    const find = (w) => fields.find((f) => fieldWords(f).has(w));
    const whole = name.toLowerCase();
    const exact = find(whole) ?? find(whole.replace(/_/g, ''));
    if (exact)
        return exact;
    const parts = nameWords(name);
    for (let i = parts.length - 1; i >= 0; i--) {
        const f = find(parts[i]);
        if (f)
            return f;
    }
    // One word with a short prefix or suffix: kup, kmid, bbup, adxv.
    if (parts.length === 1) {
        const w = parts[0];
        for (const f of fields) {
            for (const x of fieldWords(f)) {
                if (x.length < 2 || x.length >= w.length)
                    continue;
                if (w.endsWith(x) && w.length - x.length <= 3)
                    return f;
                if (x.length >= 3 && w.startsWith(x) && w.length - x.length <= 2)
                    return f;
            }
        }
    }
    return undefined;
}
/**
 * Groups whose order must be said by the names: bands (Pine gives the middle first) and ind.adx (Pine's ta.dmi gives +DI, -DI,
 * ADX). A name that says nothing would quietly get the wrong line.
 */
function mustBeNamed(fields) {
    return (fields.includes('upper') && fields.includes('mid') && fields.includes('lower')) || (fields.includes('adx') && fields.includes('plus_di'));
}
/**
 * Whether `a, b, c = group` would give a name the wrong value: a name that says it is one field (`signal`) in the place of
 * another, or (for groups that must be named) a name that does not say which field it is. A name starting with _ is not used.
 */
function unpackMismatch(fields, targets) {
    const named = mustBeNamed(fields);
    for (let i = 0; i < targets.length; i++) {
        if (targets[i].startsWith('_'))
            continue;
        const meant = fieldMeant(targets[i], fields);
        if (meant === undefined ? named : meant !== fields[i])
            return { at: i, means: meant };
    }
    return undefined;
}
/** A planned name (not built yet) still counts as living in its group. */
const PLANNED_FN = (n) => Object.prototype.hasOwnProperty.call(PLANNED, n);
const ANNOTATIONS = ['int', 'float', 'bool', 'str'];
/** A value a helper may read from the top level: fixed for the run (not a value for every candlestick, not unknown). */
function isFixedValue(ty) {
    return ty.k === 'scalar' && !ty.series && ty.base !== 'any';
}
class Scope {
    parent;
    vars = new Map();
    assigned = new Set();
    constructor(parent) {
        this.parent = parent;
    }
    lookup(name) {
        return this.vars.get(name) ?? this.parent?.lookup(name);
    }
    names() {
        return [...new Set([...this.vars.keys(), ...(this.parent?.names() ?? [])])];
    }
    set(name, b) {
        this.vars.set(name, b);
        this.assigned.add(name);
    }
}
function nodeCount(n) {
    return measureTree(n, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY).nodes;
}
const intLike = (raw, value) => Number.isInteger(value) && !/[.eE]/.test(raw);
function pyFloorDiv(a, b) {
    return Math.floor(a / b);
}
function pyMod(a, b) {
    return a - b * Math.floor(a / b);
}
const SAFE = 1e15;
// ---- The checker -----------------------------------------------------------------------------
class Checker {
    source;
    diags = [];
    seen = new Set();
    omitted = 0;
    lineLens;
    host;
    kind = 'bare-screener';
    helpers = new Map();
    helperNodes = new Map();
    recursive = new Set();
    usedHelpers = new Set();
    pending = new Set();
    condStack = [];
    seriesIf = 0;
    inHelper = 0;
    inlineStack = [];
    returns = [];
    outerScope = null;
    /** Fixed values written above the script-type function; visible to helpers and the function. */
    constScope = new Scope(null);
    inputs = [];
    outputs = [];
    outputLabels = new Set();
    /** Output calls that were placed correctly, even if their arguments had errors. */
    attemptedOutputs = new Set();
    /** Names given to plot(name, ...) as its series (fill sides must be one of these), and each fill's sides as written. */
    plottedNames = new Set();
    fillSides = [];
    /** How each stop and target was written (strategy rules): a pct that changes per candlestick, and a first target's size_pct. */
    levelArgs = [];
    usedCaps = new Set();
    usedFns = new Map();
    entryArgs = {};
    benchSpan = null;
    benchDeclared = false;
    expanded = 0;
    expandedReported = false;
    unrolled = 0;
    maxLookback = 0;
    helperCalls = 0;
    shows = 0;
    types = new WeakMap();
    calls = new WeakMap();
    constructor(source) {
        this.source = source;
        this.lineLens = source.split(/\r\n|\r|\n/).map((l) => l.length);
    }
    // ---- diagnostics
    /** Counts every error raised (even repeats), so a caller can tell whether a step found one. */
    errorSeq = 0;
    add(severity, span, code, message, hint, fix) {
        if (severity === 'error')
            this.errorSeq++;
        const key = `${code}:${span.offset}`;
        if (this.seen.has(key))
            return;
        this.seen.add(key);
        if (this.diags.length >= MAX_DIAGNOSTICS) {
            this.omitted++;
            return;
        }
        const endCol = span.endLine === span.line ? span.endCol : (this.lineLens[span.line - 1] ?? span.col) + 1;
        const d = { severity, code, message, line: span.line, col: span.col, endCol: Math.max(endCol, span.col + 1), offset: span.offset };
        if (hint !== undefined)
            d.hint = hint;
        if (fix !== undefined && fix.length > 0)
            d.fix = fix;
        this.diags.push(d);
    }
    err(span, code, message, hint, fix) {
        this.add('error', span, code, message, hint, fix);
    }
    warn(span, code, message, hint) {
        this.add('warning', span, code, message, hint);
    }
    /** A position at a line start, for problems with no better node (for example a missing return). */
    lineSpan(line, col = 1) {
        let offset = 0;
        const lines = this.source.split(/\r\n|\r|\n/);
        for (let i = 0; i < line - 1; i++)
            offset += (lines[i]?.length ?? 0) + 1;
        return { line, col, endLine: line, endCol: col + 1, offset: offset + col - 1, end: offset + col };
    }
    /**
     * An exact rewrite of `expected`, written at `from` (an offset inside `span`'s first line), with `text`. Undefined when the
     * source there is not exactly `expected` (brackets around a name widen its span, for example) or the text crosses a line.
     */
    fixAt(span, from, expected, text) {
        if (from < span.offset || this.source.slice(from, from + expected.length) !== expected)
            return undefined;
        if (/[\r\n]/.test(this.source.slice(span.offset, from + expected.length)))
            return undefined;
        const col = span.col + (from - span.offset);
        return [{ line: span.line, col, endCol: col + expected.length, text }];
    }
    /** A rewrite of a whole node written on one line. */
    fixNode(span, text) {
        if (span.endLine !== span.line)
            return undefined;
        return this.fixAt(span, span.offset, this.source.slice(span.offset, span.end), text);
    }
    /**
     * `rsi(14)` or `sma(20)`: a call with only plain numbers, which fit the settings of the study `ind.<name>` in order (the study reads
     * the close itself). Returns the study's name, or undefined when the call passes a series or the study takes other settings.
     */
    studyForSettings(e, id) {
        const spec = fnSpec(`ind.${id}`);
        if (!spec || e.args.length === 0 || e.args.some((a) => a.name !== undefined || a.value.kind !== 'Number'))
            return undefined;
        const settings = spec.params.filter((q) => q.name !== 'src');
        if (e.args.length > settings.length)
            return undefined;
        if (!e.args.every((a, i) => spec.params[i] === settings[i] && (settings[i].arg.t === 'len' || settings[i].arg.t === 'cnum')))
            return undefined;
        return spec.name;
    }
    /** `SMA` or `Rsi`: where the name in small letters lives, when it was written with capitals (B8-17). */
    caseHome(name) {
        const lower = name.toLowerCase();
        if (lower === name)
            return undefined;
        if (valueSpec(lower) && !lower.includes('.'))
            return { to: lower, sameArgs: true, isValue: true };
        if (fnSpec(lower) && !lower.includes('.'))
            return { to: lower, sameArgs: true, isValue: false };
        return this.elsewhere(lower, null);
    }
    /** Where a name lives when it is not where it was written (`rsi` is `ta.rsi`, `ta.supertrend` is `ind.supertrend`). */
    elsewhere(name, from) {
        return findElsewhere(name, from, { fn: (n) => fnSpec(n) ?? PLANNED_FN(n), value: (n) => valueSpec(n) });
    }
    /**
     * The hint for a function that lives in another group when its arguments cannot simply be kept: the place, how it is
     * written, and what it gives. Deliberately not worded "Did you mean", so an editor does not offer the name alone as a fix.
     */
    homeHint(written, to) {
        const spec = fnSpec(to);
        if (!spec)
            return `It is written ${to} here.`;
        let out = `\`${written}\` is \`${to}\` here: write ${callText(spec)}.`;
        if (to.startsWith('ind.')) {
            out += spec.params.some((q) => q.name === 'src')
                ? ' A study in ind reads the close itself; for another series give it by name, src=....'
                : ' A study in ind reads the prices itself, so no price is passed in.';
        }
        if (spec.returns.kind === 'record') {
            const fields = Object.keys(spec.returns.fields);
            out += ` It gives a group of ${fields.length} values: m = ${to}() and then ${fields.map((f) => `m.${f}`).join(', ')}.`;
        }
        if (Object.hasOwn(HOME_NOTES, to))
            out += ` ${HOME_NOTES[to]}`;
        return out;
    }
    // ---- entry point
    /** For each name a Pine input.float(...) is given to, the range the functions it is passed to accept (B1-13, see pineInputFix). */
    floatSettingRange = new Map();
    /** The offset of an `input.float(...)` call -> the name it is given to (`k = input.float(2)` or `k: float = input.float(2)`). */
    inputTarget = new Map();
    /** Fills settingRange and inputTarget before the script is checked. */
    collectSettingRanges(module) {
        const dotted = (x) => (x.kind === 'Name' ? x.id : x.kind === 'Attribute' ? ((d) => (d ? `${d}.${x.attr}` : null))(dotted(x.value)) : null);
        const isPineInput = (x) => !!x && x.kind === 'Call' && x.func.kind === 'Attribute' && x.func.value.kind === 'Name' && x.func.value.id === 'input';
        const seen = new Set();
        const visit = (n) => {
            if (!n || typeof n !== 'object' || seen.has(n))
                return;
            seen.add(n);
            if (Array.isArray(n)) {
                for (const x of n)
                    visit(x);
                return;
            }
            const node = n;
            if (node.kind === 'Assign') {
                const a = node;
                if (a.targets.length === 1 && isPineInput(a.value))
                    this.inputTarget.set(a.value.span.offset, a.targets[0].id);
            }
            else if (node.kind === 'Param') {
                const q = node;
                if (isPineInput(q.default))
                    this.inputTarget.set(q.default.span.offset, q.name);
            }
            else if (node.kind === 'Call') {
                const c = node;
                const name = dotted(c.func);
                const spec = name ? fnSpec(name) : undefined;
                if (spec) {
                    let pos = 0;
                    for (const a of c.args) {
                        const q = a.name === undefined ? spec.params[pos++] : spec.params.find((x) => x.name === a.name);
                        if (!q || q.arg.t !== 'cnum' || q.arg.min === undefined || q.arg.max === undefined || a.value.kind !== 'Name')
                            continue;
                        const was = this.floatSettingRange.get(a.value.id);
                        this.floatSettingRange.set(a.value.id, { min: Math.max(was?.min ?? -Infinity, q.arg.min), max: Math.min(was?.max ?? Infinity, q.arg.max) });
                    }
                }
            }
            for (const v of Object.values(n))
                if (v && typeof v === 'object')
                    visit(v);
        };
        visit(module);
    }
    run(module) {
        this.collectSettingRanges(module);
        const defs = module.body.filter((s) => s.kind === 'FunctionDef');
        const entries = defs.filter((d) => d.decorators.length > 0);
        const helperDefs = defs.filter((d) => d.decorators.length === 0);
        const others = module.body.filter((s) => s.kind !== 'FunctionDef');
        if (module.body.length === 0) {
            this.err(this.lineSpan(1), 'E-SCRIPT-EMPTY', 'The script is empty.', 'Write a condition such as close > ta.sma(close, 50).');
            return null;
        }
        for (const extra of entries.slice(1)) {
            this.err(extra.span, 'E-ENTRY-MULTIPLE', 'A script can have only one script-type function.', 'Keep one @screener, @indicator, @alert or @strategy; the other functions must be plain helpers without an @ line.');
        }
        const entry = entries[0];
        const entryKind = entry ? entry.decorators[0].name : null;
        if (entryKind)
            this.kind = entryKind;
        else
            this.kind = this.hasCall(module, ['plot', 'mark', 'bgcolor']) ? 'bare-indicator' : 'bare-screener';
        // A caller that names a host that does not exist is told so, not handed an internal error (2026-10-25, B2 note 7).
        if (this.hostOption !== undefined && !Object.hasOwn(HOSTS, this.hostOption)) {
            this.err(this.lineSpan(1), 'E-HOST-UNKNOWN', `There is no host called "${String(this.hostOption)}".`, `The hosts are: ${Object.keys(HOSTS).join(', ')}.`);
            return null;
        }
        this.host = withStages(HOSTS[this.hostOption ?? defaultHostFor(this.kind)], this.stagesOption);
        if (!this.host.kinds.includes(this.kind)) {
            const at = entry ? entry.decorators[0].span : this.lineSpan(1);
            this.err(at, 'E-HOST-ENTRY', `${cap1(kindWords(this.kind))} cannot run ${this.host.runsAs}.`, `Scripts that run ${this.host.runsAs} are: ${this.host.kinds.map(kindName).join(', ')}.`);
        }
        this.registerHelpers(helperDefs);
        this.findRecursion(helperDefs);
        const constScope = this.constScope;
        let locals;
        if (entry) {
            for (const s of others)
                this.moduleLevel(s, constScope);
            locals = this.checkEntry(entry, entryKind, constScope);
        }
        else {
            locals = this.checkBare(module, constScope);
        }
        this.outerScope = locals;
        // Helpers never called: check their bodies once with unknown argument types, so mistakes still show.
        for (const h of helperDefs) {
            if (this.usedHelpers.has(h.name) || this.recursive.has(h.name))
                continue;
            this.warn(h.span, 'W-UNUSED-HELPER', `The helper \`${h.name}\` is never used.`, 'Remove it, or call it from the script.');
            this.inlineHelper(h, h.params.map(() => ANY), null, false);
        }
        if (this.benchSpan && !this.benchDeclared) {
            this.err(this.benchSpan, 'E-BENCH-MISSING', '`bench` needs a benchmark, but the script does not name one.', entry ? 'Add benchmark="NIFTY 50" to the script-type line, or use ref("NIFTY 50").close.' : 'Use the @screener(benchmark="NIFTY 50") form, or ref("NIFTY 50").close.');
        }
        // A strategy names a benchmark for the measures of its backtest (beta, alpha, capture), whether or not a rule reads it.
        if (this.benchDeclared && !this.benchSpan && entry && this.kind !== 'strategy') {
            this.warn(entry.decorators[0].span, 'W-UNUSED-BENCHMARK', 'A benchmark is named but `bench` is never used.', 'Remove benchmark=..., or use bench.close.');
        }
        this.fillRules();
        const lo = {};
        for (const [name, b] of locals.vars)
            lo[name] = describe(b.ty);
        this.reportUnused(locals);
        const fns = [...this.usedFns.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
        return {
            kind: this.kind,
            host: this.host.id,
            entryName: entry ? entry.name : null,
            entryArgs: this.entryArgs,
            inputs: this.inputs,
            outputs: this.outputs,
            requires: [...this.usedCaps].sort(),
            functions: fns,
            locals: lo,
            stats: {
                nodes: nodeCount(module),
                expandedNodes: this.expanded,
                unrolled: this.unrolled,
                maxLookback: this.maxLookback,
                helperCalls: this.helperCalls,
                helpers: helperDefs.length,
            },
            types: this.types,
            calls: this.calls,
        };
    }
    hostOption;
    stagesOption;
    hasCall(root, names) {
        const stack = [root];
        while (stack.length > 0) {
            const n = stack.pop();
            if (n.kind === 'Call' && n.func.kind === 'Name' && names.includes(n.func.id))
                return true;
            for (const c of childrenOf(n))
                stack.push(c);
        }
        return false;
    }
    reportUnused(scope) {
        for (const [name, b] of scope.vars) {
            if (!b.used && b.reportUnused && !name.startsWith('_')) {
                this.warn(b.node, 'W-UNUSED-NAME', `\`${name}\` is set but never used.`, 'Remove it, or use it in the result. A name starting with _ is never reported.');
            }
        }
    }
    // ---- helpers (def without an @ line)
    registerHelpers(defs) {
        for (const d of defs) {
            if (this.helpers.has(d.name)) {
                this.err(d.span, 'E-HELPER-DUP', `The helper \`${d.name}\` is defined twice.`, 'Give each helper its own name.');
                continue;
            }
            if (isReservedName(d.name)) {
                this.err(d.span, 'E-NAME-SHADOW', `\`${d.name}\` is a built-in name and cannot be used for a helper.`, `Choose another name, for example my_${d.name}.`);
            }
            this.helpers.set(d.name, d);
            this.helperNodes.set(d.name, d.body.reduce((n, s) => n + nodeCount(s), 0));
            for (const p of d.params) {
                if (isReservedName(p.name))
                    this.err(p.span, 'E-NAME-SHADOW', `\`${p.name}\` is a built-in name and cannot be used for a parameter.`, `Choose another name, for example ${p.name}_value.`);
                // A3: a helper parameter may have a default written out (def f(x, n=14):); it is used when a call leaves the argument out.
                // The parser already refuses a parameter without a default after one with a default (E-PARSE-PARAM-ORDER).
                if (p.default !== undefined) {
                    if (!helperDefaultOk(p.default))
                        this.err(p.default.span, 'E-PARAM-HELPER-DEFAULT', 'A helper parameter\'s default must be a number, text or True/False written out.', `Write the value itself, for example def ${d.name}(x, n=14):. A setting the user can change is made with input() on the script-type function.`);
                }
                if (p.annotation !== undefined && !ANNOTATIONS.includes(p.annotation)) {
                    this.err(p.span, 'E-PARAM-TYPE', `\`${p.annotation}\` is not a type note that can be used.`, 'Use int, float, bool or str, or leave the note out.');
                }
            }
        }
    }
    findRecursion(defs) {
        const edges = new Map();
        for (const d of defs) {
            const list = [];
            const stack = [...d.body];
            while (stack.length > 0) {
                const n = stack.pop();
                if (n.kind === 'Call' && n.func.kind === 'Name' && this.helpers.has(n.func.id))
                    list.push({ to: n.func.id, call: n });
                for (const c of childrenOf(n))
                    stack.push(c);
            }
            list.sort((a, b) => a.call.span.offset - b.call.span.offset);
            edges.set(d.name, list);
        }
        const state = new Map();
        const path = [];
        const visit = (u) => {
            state.set(u, 1);
            path.push(u);
            for (const e of edges.get(u) ?? []) {
                if (state.get(e.to) === 1) {
                    const cycle = path.slice(path.indexOf(e.to));
                    for (const n of cycle)
                        this.recursive.add(n);
                    this.err(e.call.span, 'E-HELPER-RECURSION', `The helper \`${e.to}\` ends up calling itself${cycle.length > 1 ? ` (${[...cycle, e.to].join(' → ')})` : ''}.`, 'Helpers are copied into the script where they are called, so they cannot repeat themselves. Use ta.bars_since, ta.latch or ta.value_when for state.');
                }
                else if (!state.has(e.to))
                    visit(e.to);
            }
            path.pop();
            state.set(u, 2);
        };
        for (const d of defs)
            if (!state.has(d.name))
                visit(d.name);
    }
    // ---- top level
    moduleLevel(s, scope) {
        if (s.kind === 'Assign') {
            const ty = this.expr(s.value, scope);
            const isConst = ty.k === 'scalar' && !ty.series;
            if (!isConst && !(ty.k === 'scalar' && ty.base === 'any')) {
                this.err(s.value.span, 'E-CONST-REQUIRED', 'A value written above the function must be a fixed number, text or True/False.', 'Move this line inside the function, where candlestick values can be used.');
            }
            if (s.targets.length > 1) {
                this.err(s.span, 'E-CONST-REQUIRED', 'Several names cannot be set at once above the function.', 'Give each fixed value its own line.');
            }
            for (const t of s.targets)
                this.bindName(t, isConst ? ty : ANY, scope, s.span, false);
        }
        else if (s.kind === 'ExprStmt') {
            this.err(s.span, 'E-TOP-LEVEL-STMT', 'A line outside the function can only set a fixed value or define a helper.', 'Put this line inside the function.');
        }
    }
    checkBare(module, constScope) {
        const scope = new Scope(constScope);
        this.outerScope = scope;
        this.returns = [];
        const body = module.body.filter((s) => s.kind !== 'FunctionDef');
        const last = module.body[module.body.length - 1];
        const resultStmt = this.kind === 'bare-screener' && last && last.kind === 'ExprStmt' ? last : null;
        if (this.kind === 'bare-screener') {
            if (!last || last.kind !== 'ExprStmt') {
                // `close = high` (a spreadsheet's equals sign): the last line compares, so == was meant (B1-8, B8-16).
                const compares = last?.kind === 'Assign' && last.targets.length === 1 && isReservedName(last.targets[0].id) && !!valueSpec(last.targets[0].id);
                const eq = compares && last.kind === 'Assign' ? this.source.indexOf('=', last.targets[0].span.end) : -1;
                this.err(last ? last.span : this.lineSpan(1), 'E-BARE-RESULT', 'The last line of the script must be the true/false condition itself.', compares ? 'To compare, write == (a single = gives a name a value): for example close == high.' : last && last.kind === 'Assign' ? 'Remove the name and the = sign so the last line is the condition, or use the @screener form with return.' : 'End the script with a condition such as close > ta.sma(close, 50).', compares && last && eq >= 0 ? this.fixAt(last.span, eq, '=', '==') : undefined);
            }
        }
        for (const s of body) {
            if (s.kind === 'Assign' && isInputCall(s.value))
                this.bareSetting(s, scope);
            else
                this.statement(s, scope, false, resultStmt);
            // A bare script's lines are its top level: a helper sees the fixed values set there so far, as it sees the values
            // written above the function in the @screener form. The same binding, so a use in a helper counts as a use.
            for (const [name, b] of scope.vars) {
                if (isFixedValue(b.ty))
                    constScope.vars.set(name, b);
                else
                    constScope.vars.delete(name);
            }
        }
        return scope;
    }
    /** `n = input(20)` on its own line in a script without def (2026-10-25): a setting, as `n: int = input(20)` is in a def's brackets. */
    bareSetting(s, scope) {
        const call = s.value;
        if (s.targets.length !== 1) {
            this.err(s.span, 'E-INPUT-PLACE', 'A setting is given one name: n = input(20).', 'Give each setting its own line.');
            this.evalAll(call, scope);
            for (const t of s.targets)
                this.bindName(t, ANY, scope, s.span, true);
            return;
        }
        const t = s.targets[0];
        if (this.inputs.length >= MAX_INPUTS) {
            this.err(s.span, 'E-INPUT-LIMIT', `A script can have at most ${MAX_INPUTS} settings.`, 'Fix some values in the script instead of making them settings.');
            this.evalAll(call, scope);
            this.bindName(t, ANY, scope, s.span, true);
            return;
        }
        if (this.inputs.some((i) => i.name === t.id)) {
            this.err(t.span, 'E-INPUT-DUP', `\`${t.id}\` is already a setting.`, 'Give each setting its own name, and set it once.');
            this.evalAll(call, scope);
            return;
        }
        if (this.helpers.has(t.id))
            this.err(t.span, 'E-NAME-SHADOW', `\`${t.id}\` is already the name of a helper.`, 'Choose a different name for the setting.');
        this.setting({ kind: 'Param', name: t.id, default: call, span: t.span }, scope);
    }
    // ---- entry function
    checkEntry(def, kind, constScope) {
        const dec = def.decorators[0];
        this.decorator(dec, kind, constScope);
        if (isReservedName(def.name))
            this.err(this.lineSpan(def.defLine), 'E-NAME-SHADOW', `\`${def.name}\` is a built-in name and cannot be used for the function.`, `Choose another name, for example scan or my_${def.name}.`);
        if (this.helpers.has(def.name))
            this.err(this.lineSpan(def.defLine), 'E-HELPER-DUP', `\`${def.name}\` is also the name of a helper.`, 'Give the function and the helper different names.');
        const scope = new Scope(constScope);
        this.outerScope = scope;
        for (const [i, p] of def.params.entries()) {
            if (i >= MAX_INPUTS) {
                this.err(p.span, 'E-INPUT-LIMIT', `A script can have at most ${MAX_INPUTS} settings.`, 'Fix some values in the script instead of making them settings.');
                break;
            }
            this.setting(p, scope);
        }
        this.returns = [];
        this.checkBlock(def.body, scope, true, null);
        if (kind === 'screener') {
            if (!alwaysReturns(def.body)) {
                const tail = def.body[def.body.length - 1];
                this.err(this.lineSpan(def.defLine), 'E-RETURN-MISSING', this.returns.length === 0 ? `\`${def.name}\` does not return a result.` : `\`${def.name}\` does not return a result on every path.`, 'End the function with return followed by the true/false condition. When using if, give every branch (including else) its own return.');
                void tail;
            }
        }
        else {
            this.requireOutputs(def, kind);
        }
        return scope;
    }
    requireOutputs(def, kind) {
        const has = (names) => this.outputs.some((o) => names.includes(o.kind)) || names.some((n) => this.attemptedOutputs.has(n));
        if (kind === 'alert' && !has(['alert'])) {
            this.err(this.lineSpan(def.defLine), 'E-ALERT-MISSING', 'An alert script must call alert(condition, "message").', 'Add a line such as alert(close > ta.highest(high, 20)[1], "Breakout").');
        }
        else if (kind === 'strategy' && !has(['entry'])) {
            this.err(this.lineSpan(def.defLine), 'E-STRATEGY-ENTRY', 'A strategy must say when to enter.', 'Add a line such as strategy.entry(close > ta.highest(high, 20)[1]).');
        }
        if (kind === 'strategy')
            this.optionStrategyRules(def);
        if (kind === 'indicator' && !has(['plot', 'mark', 'bgcolor'])) {
            this.warn(this.lineSpan(def.defLine), 'W-NO-OUTPUT', 'The indicator draws nothing.', 'Add plot(value, "label") or mark(condition).');
        }
    }
    /** An option strategy (one with strategy.leg): one underlying, at most four legs, a margin when it sells or trades a future. */
    optionStrategyRules(def) {
        const legs = this.outputs.filter((o) => o.kind === 'leg');
        const at = this.lineSpan(def.defLine);
        const underlying = typeof this.entryArgs.underlying === 'string';
        if (legs.length === 0) {
            if (underlying)
                this.err(at, 'E-LEG-MISSING', 'underlying= is for an option strategy, but this one has no legs.', 'Add legs such as strategy.leg("call", "sell", strike="atm"), or use universe= for a strategy on stocks.');
            return;
        }
        if (!underlying)
            this.err(at, 'E-LEG-UNDERLYING', 'An option strategy must name its underlying.', 'Add it to the strategy line, for example @strategy(underlying="NIFTY", margin_pct=18).');
        if (typeof this.entryArgs.universe === 'string')
            this.err(at, 'E-LEG-UNIVERSE', 'An option strategy runs on its underlying, not on a list of stocks.', 'Remove universe= from the strategy line.');
        if (legs.length > MAX_LEGS)
            this.err(at, 'E-LEG-LIMIT', `An option strategy can have at most ${MAX_LEGS} legs; this one has ${legs.length}.`, 'Remove some strategy.leg lines.');
        const unbounded = legs.some((l) => l.leg?.side === 'sell' || l.leg?.right === 'future');
        if (unbounded && typeof this.entryArgs.margin_pct !== 'number') {
            this.err(at, 'E-LEG-MARGIN', 'A strategy that sells an option or trades a future must give its margin.', 'Add margin_pct= to the strategy line (a percentage of the notional value, for example margin_pct=18). Without it the position size would have no limit.');
        }
        // A stop and a target are measured on the position's net premium at entry; a position of futures alone has none.
        const premiumless = legs.every((l) => l.leg?.right === 'future');
        if (this.entryArgs.max_hold !== undefined) {
            this.err(at, 'E-LEG-SETTING', 'max_hold= is not used by option strategies.', 'An option strategy closes its legs on strategy.exit(condition), on its stop or target on the premium, or at expiry. Remove max_hold= from the strategy line.');
        }
        // An option strategy's stop and target are a fixed percent of the premium at entry, and it has no partial exit.
        for (const a of this.levelArgs) {
            if (a.pctSeries) {
                this.err(a.pctSpan ?? this.lineSpan(a.line), 'E-ARG-CONST', `\`pct\` of strategy.${a.kind} must be a fixed number in an option strategy, not a value that changes from candlestick to candlestick.`, 'Write a number such as 30: in an option strategy it is a percent of the premium paid or received at entry.');
            }
            if (a.sized) {
                this.err(a.sizeSpan ?? this.lineSpan(a.line), 'E-LEG-OUTPUT', 'size_pct= is not used by option strategies: all the legs close together.', 'Remove size_pct=, and keep one strategy.take_profit(pct=...) on the premium.');
            }
        }
        for (const o of this.outputs) {
            if (o.kind === 'rank') {
                this.err(this.lineSpan(o.line), 'E-LEG-OUTPUT', 'strategy.rank is not used by option strategies.', 'An option strategy has one underlying, so there is nothing to rank.');
            }
            else if (o.kind === 'trail') {
                this.err(this.lineSpan(o.line), 'E-LEG-OUTPUT', 'strategy.trail is not used by option strategies.', 'An option strategy can use strategy.stop_loss(pct=...) and strategy.take_profit(pct=...), measured on the premium of all its legs together, and strategy.exit(condition).');
            }
            else if ((o.kind === 'stop_loss' || o.kind === 'take_profit') && premiumless) {
                this.err(this.lineSpan(o.line), 'E-LEG-OUTPUT', `strategy.${o.kind} in an option strategy is a percent of the premium paid or received at entry, and futures have no premium.`, 'Add an option leg, or close the futures with strategy.exit(condition).');
            }
        }
    }
    decorator(dec, kind, scope) {
        const allowed = DECORATOR_ARGS[kind];
        const seenNames = new Set();
        for (const a of dec.args ?? []) {
            if (a.name === undefined) {
                this.err(a.span, 'E-DECORATOR-POSITIONAL', `Write the settings of @${kind} with names, for example universe="liquid".`, `Allowed names: ${Object.keys(allowed).join(', ')}.`);
                this.expr(a.value, scope);
                continue;
            }
            // Own names only: `__proto__`, `constructor` or `toString` are properties of every object, not settings.
            const spec = Object.hasOwn(allowed, a.name) ? allowed[a.name] : undefined;
            if (!spec) {
                const near = suggest(a.name, Object.keys(allowed));
                const objectName = a.name in Object.prototype || a.name === '__proto__';
                this.err(a.span, 'E-DECORATOR-ARG', objectName ? `\`${a.name}\` is a reserved name and cannot be a setting of @${kind}.` : `@${kind} has no setting called \`${a.name}\`.`, near ? `Did you mean \`${near}\`?` : `Allowed names: ${Object.keys(allowed).join(', ')}.`, near && sameLetters(near, a.name) ? this.fixAt(a.span, a.span.offset, a.name, near) : undefined);
                this.expr(a.value, scope);
                continue;
            }
            seenNames.add(a.name);
            const ty = this.expr(a.value, scope);
            const accepted = this.checkArgKind(spec, ty, a.value, `@${kind}(${a.name}=...)`, a.name, 'E-DECORATOR-VALUE');
            if (accepted && ty.k === 'scalar' && ty.value !== undefined)
                this.entryArgs[a.name] = ty.value;
        }
        this.benchDeclared = typeof this.entryArgs.benchmark === 'string';
    }
    setting(p, scope) {
        const dflt = p.default;
        if (p.annotation !== undefined && !ANNOTATIONS.includes(p.annotation)) {
            this.err(p.span, 'E-PARAM-TYPE', `\`${p.annotation}\` is not a type note that can be used.`, 'Use int, float, bool or str, or leave the note out.');
        }
        if (isReservedName(p.name))
            this.err(p.span, 'E-NAME-SHADOW', `\`${p.name}\` is a built-in name and cannot be used for a setting.`, `Choose another name, for example ${p.name}_value.`);
        const isInput = dflt !== undefined && dflt.kind === 'Call' && dflt.func.kind === 'Name' && dflt.func.id === 'input';
        // Pine's input.int(20): one problem (E-PINE-INPUT, from the call itself), not a second one for the same words.
        const pineInput = dflt !== undefined && dflt.kind === 'Call' && dflt.func.kind === 'Attribute' && dflt.func.value.kind === 'Name' && dflt.func.value.id === 'input';
        if (!isInput && pineInput) {
            this.expr(dflt, scope);
            scope.set(p.name, { ty: ANY, node: p.span, used: true, maybe: false, reportUnused: false });
            return;
        }
        if (!isInput) {
            this.err(dflt ? dflt.span : p.span, 'E-PARAM-DEFAULT', dflt ? `The setting \`${p.name}\` must get its default from input(...).` : `The setting \`${p.name}\` needs a default.`, `Write ${p.name}: int = input(20).`);
            if (dflt)
                this.expr(dflt, scope);
            scope.set(p.name, { ty: ANY, node: p.span, used: true, maybe: false, reportUnused: false });
            return;
        }
        const ty = this.inputSetting(p, dflt, scope);
        scope.set(p.name, { ty, node: p.span, used: false, maybe: false, reportUnused: true, setting: true });
    }
    /** input(default, min=, max=): returns the type of the setting. */
    inputSetting(p, call, scope) {
        const pos = call.args.filter((a) => a.name === undefined);
        const named = call.args.filter((a) => a.name !== undefined);
        let bad = false;
        const defval = named.find((a) => a.name === 'defval');
        if (pos.length === 2 && pos[1].value.kind === 'String') {
            // Pine's input(20, "Length"): the second value is the title (B1-20).
            const t = pos[1].value;
            this.err(t.span, 'E-INPUT-ARGS', 'input() takes one default value; a title is written with its name.', `Write title=${shortText(t)}, as in input(20, title="Length").`, this.fixAt(t.span, t.span.offset, '', 'title='));
            bad = true;
        }
        else if (pos.length !== 1 && !(pos.length === 0 && defval)) {
            this.err(call.span, 'E-INPUT-ARGS', pos.length === 0 ? 'input() needs a default value.' : 'input() takes one default value.', 'Write input(20), or input(20, min=5, max=100).');
            bad = true;
        }
        let min;
        let max;
        let options;
        let title;
        for (const a of named) {
            if (a.name === 'min')
                min = a;
            else if (a.name === 'max')
                max = a;
            else if (a.name === 'options')
                options = a;
            else if (a.name === 'title')
                title = a;
            else if (a.name === 'defval') {
                // Pine's input(defval=20): the default is written first, without a name (B1-20).
                const m = /^defval[ \t]*=[ \t]*/.exec(this.source.slice(a.span.offset));
                const first = call.args[0] === a && pos.length === 0;
                this.err(a.span, 'E-INPUT-ARGS', 'input() has no argument called `defval`.', 'Write the default first, without a name: input(20).', first && m ? this.fixAt(a.span, a.span.offset, m[0], '') : undefined);
                bad = true;
            }
            else {
                const argName = a.name;
                const pine = PINE_INPUT_ARGS[argName];
                this.err(a.span, 'E-INPUT-ARGS', `input() has no argument called \`${argName}\`.`, pine ? `Write ${pine}= (the names are min, max, options and title).` : 'The allowed names are min, max, options and title.', pine ? this.fixAt(a.span, a.span.offset, argName, pine) : undefined);
                bad = true;
            }
        }
        if (bad) {
            for (const a of call.args) {
                if (a === options && a.value.kind === 'List')
                    for (const x of a.value.elts)
                        this.expr(x, scope);
                else
                    this.expr(a.value, scope);
            }
            return { ...ANY };
        }
        const dv = this.expr(pos[0].value, scope);
        if (dv.k !== 'scalar' || dv.series || dv.value === undefined) {
            if (!(dv.k === 'scalar' && dv.base === 'any'))
                this.err(pos[0].value.span, 'E-INPUT-ARGS', 'The default of a setting must be a fixed number, text or True/False.', 'Write the value itself, for example input(20).');
            return { ...ANY };
        }
        const value = dv.value;
        const literal = typeof value === 'boolean' ? 'bool' : typeof value === 'string' ? 'str' : dv.base === 'int' ? 'int' : 'float';
        const wanted = p.annotation ?? literal;
        let type = wanted;
        if (!ANNOTATIONS.includes(wanted))
            type = literal;
        if (type === 'int' && literal !== 'int') {
            this.err(pos[0].value.span, 'E-INPUT-TYPE', `\`${p.name}\` is marked int but the default is not a whole number.`, 'Write a whole number such as input(20), or mark the setting float.');
        }
        else if (type === 'float' && literal !== 'int' && literal !== 'float') {
            this.err(pos[0].value.span, 'E-INPUT-TYPE', `\`${p.name}\` is marked float but the default is not a number.`, 'Write a number such as input(2.5).');
        }
        else if (type === 'bool' && literal !== 'bool') {
            this.err(pos[0].value.span, 'E-INPUT-TYPE', `\`${p.name}\` is marked bool but the default is not True or False.`, 'Write input(True) or input(False).');
        }
        else if (type === 'str' && literal !== 'str') {
            this.err(pos[0].value.span, 'E-INPUT-TYPE', `\`${p.name}\` is marked str but the default is not text.`, 'Write the default in quotes, for example input("support").');
        }
        const info = { name: p.name, type, default: value, line: p.span.line };
        const titleText = title ? this.inputTitle(title, scope) : undefined;
        if (titleText !== undefined)
            info.title = titleText;
        const choices = options ? this.inputOptions(options, type, value, pos[0].value, scope) : undefined;
        if (choices)
            info.options = choices;
        if (type === 'bool' || type === 'str') {
            for (const a of [min, max]) {
                if (a) {
                    this.err(a.span, 'E-INPUT-ARGS', 'min and max only work for numbers.', `Remove ${a.name}=.`);
                    this.expr(a.value, scope);
                }
            }
            this.inputs.push(info);
            const s = constant(type, undefined);
            s.setting = true;
            if (choices)
                s.options = choices;
            return s;
        }
        const num = value;
        const bound = (a) => {
            if (!a)
                return undefined;
            const t = this.expr(a.value, scope);
            if (t.k !== 'scalar' || t.series || typeof t.value !== 'number') {
                if (!(t.k === 'scalar' && t.base === 'any'))
                    this.err(a.value.span, 'E-INPUT-ARGS', `${a.name} must be a fixed number.`, `Write the number itself, for example ${a.name}=${a.name === 'min' ? 1 : 100}.`);
                return undefined;
            }
            if (type === 'int' && !Number.isInteger(t.value)) {
                this.err(a.value.span, 'E-INPUT-TYPE', `${a.name} of a whole-number setting must be a whole number.`, 'Mark the setting float, or use a whole number.');
                return undefined;
            }
            return t.value;
        };
        const minV = bound(min);
        const maxV = bound(max);
        if (minV !== undefined && maxV !== undefined && minV > maxV && min) {
            this.err(min.span, 'E-INPUT-RANGE', `min (${minV}) is larger than max (${maxV}).`, 'Swap them.');
        }
        if ((minV !== undefined && num < minV) || (maxV !== undefined && num > maxV)) {
            this.err(pos[0].value.span, 'E-INPUT-RANGE', `The default ${num} is outside the range${minV !== undefined ? ` from ${minV}` : ''}${maxV !== undefined ? ` to ${maxV}` : ''}.`, 'Choose a default inside min and max.');
        }
        // A whole-number setting without min and max gets the default range (see check/settings.ts).
        const { lo, hi } = settingRange(type, num, minV, maxV);
        if (minV !== undefined)
            info.min = minV;
        if (maxV !== undefined)
            info.max = maxV;
        this.inputs.push(info);
        const s = constant(type === 'int' ? 'int' : 'float', undefined, { lo, hi });
        s.setting = true;
        return s;
    }
    /** `title="Length"`: the words shown for a setting in place of its name. Text written in the script, one line, at most LABEL_MAX_CHARS. */
    inputTitle(a, scope) {
        const t = this.expr(a.value, scope);
        if (t.k !== 'scalar' || t.series || typeof t.value !== 'string' || t.setting) {
            if (!(t.k === 'scalar' && t.base === 'any'))
                this.err(a.value.span, 'E-INPUT-ARGS', 'title= must be text written in quotes.', 'Write title="Length".');
            return undefined;
        }
        if (t.value.trim() === '' || charCount(t.value) > LABEL_MAX_CHARS || /[\r\n]/.test(t.value)) {
            this.err(a.value.span, 'E-INPUT-ARGS', `title= must be one line of 1 to ${LABEL_MAX_CHARS} characters.`, 'Use a short title, for example title="Length".');
            return undefined;
        }
        return t.value;
    }
    /**
     * `options=["sma", "ema", "wma"]` (A5): a text setting restricted to a list written out in the script. Returns the choices when
     * they can be used, otherwise reports why and returns undefined (the setting then stays an open text setting).
     */
    inputOptions(a, type, value, dflt, scope) {
        const list = a.value;
        if (type !== 'str') {
            this.err(a.span, 'E-INPUT-OPTIONS-TYPE', 'options= only works for a text setting.', 'Use a text default, for example input("sma", options=["sma", "ema"]), or remove options=.');
            if (list.kind === 'List')
                for (const x of list.elts)
                    this.expr(x, scope);
            else
                this.expr(list, scope);
            return undefined;
        }
        if (list.kind !== 'List') {
            this.err(list.span, 'E-INPUT-OPTIONS-LIST', 'options= must be a list of texts written out in the script.', 'Write the choices in square brackets, for example options=["sma", "ema", "wma"].');
            if (list.kind !== 'ListComp')
                this.expr(list, scope);
            return undefined;
        }
        const out = [];
        let ok = true;
        for (const x of list.elts) {
            const t = this.expr(x, scope);
            if (t.k !== 'scalar' || t.series || typeof t.value !== 'string' || t.setting) {
                if (!(t.k === 'scalar' && t.base === 'any'))
                    this.err(x.span, 'E-INPUT-OPTIONS-LIST', 'Every choice in options= must be text written in quotes.', 'Write each choice in quotes, for example options=["sma", "ema"].');
                ok = false;
                continue;
            }
            const v = t.value;
            if (v.length === 0 || charCount(v) > INPUT_OPTION_MAX_CHARS) {
                this.err(x.span, 'E-INPUT-OPTIONS-LENGTH', v.length === 0 ? 'A choice in options= cannot be empty.' : `The choice "${firstChars(v, INPUT_OPTION_MAX_CHARS)}..." is longer than ${INPUT_OPTION_MAX_CHARS} characters.`, `Use a short word of 1 to ${INPUT_OPTION_MAX_CHARS} characters; it is shown in a dropdown.`);
                ok = false;
                continue;
            }
            if (out.includes(v)) {
                this.err(x.span, 'E-INPUT-OPTIONS-DUPLICATE', `The choice "${v}" is written twice in options=.`, 'Remove the second one.');
                ok = false;
                continue;
            }
            out.push(v);
        }
        if (ok && out.length > MAX_INPUT_OPTIONS) {
            this.err(list.elts[MAX_INPUT_OPTIONS].span, 'E-INPUT-OPTIONS-COUNT', `options= can list at most ${MAX_INPUT_OPTIONS} choices; this one lists ${out.length}.`, 'Keep the choices people really pick, or split the idea into two settings.');
            return undefined;
        }
        if (!ok)
            return undefined;
        if (typeof value === 'string' && !out.includes(value)) {
            const near = suggest(value, out);
            this.err(dflt.span, 'E-INPUT-OPTIONS-DEFAULT', `The default "${value}" is not one of the choices in options=.`, near ? `Did you mean "${near}"? Choices: ${out.join(', ')}.` : `Use one of the choices as the default: ${out.join(', ')}.`, near && dflt.kind === 'String' && certainChoice(value, out) === near ? this.fixAt(dflt.span, dflt.span.offset + 1, value, near) : undefined);
            return undefined;
        }
        return out;
    }
    // ---- statements
    /** Check a block of statements. `tail` is true when a return here would be the last thing the function does. */
    checkBlock(stmts, scope, tail, resultStmt) {
        stmts.forEach((s, i) => this.statement(s, scope, tail && i === stmts.length - 1, resultStmt));
    }
    statement(s, scope, tail, resultStmt) {
        switch (s.kind) {
            case 'Assign':
                this.assign(s, scope);
                break;
            case 'ExprStmt':
                this.exprStmt(s.value, s, scope, resultStmt === s);
                break;
            case 'Pass': break;
            case 'Return':
                this.returnStmt(s.value, s, scope, tail);
                break;
            case 'If':
                this.ifStmt(s, scope, tail);
                break;
            case 'FunctionDef':
                // The parser refuses nested functions; a def at the top of a bare script is a helper.
                break;
        }
    }
    assign(s, scope) {
        for (const t of s.targets)
            this.pending.add(t.id);
        const ty = this.expr(s.value, scope);
        for (const t of s.targets)
            this.pending.delete(t.id);
        if (s.targets.length === 1) {
            const t = s.targets[0];
            if (ty.k === 'none') {
                this.err(s.value.span, 'E-VALUE-NONE', 'This call does not give back a value, so it cannot be stored in a name.', 'Use it on a line of its own.');
                this.bindName(t, ANY, scope, s.span, true);
            }
            else if (ty.k === 'list') {
                this.err(s.value.span, 'E-LIST-USE', 'A list cannot be stored in a name.', LIST_PLACES);
                this.bindName(t, ANY, scope, s.span, true);
            }
            else {
                this.bindName(t, ty, scope, s.span, true);
            }
            return;
        }
        // a, b = value
        if (ty.k === 'tuple') {
            if (ty.items.length !== s.targets.length) {
                this.err(s.value.span, 'E-UNPACK-COUNT', `${ty.items.length} values are given back but ${s.targets.length} names are set.`, 'Use the same number of names as values.');
                for (const t of s.targets)
                    this.bindName(t, ANY, scope, s.span, true);
            }
            else {
                s.targets.forEach((t, i) => this.bindName(t, ty.items[i], scope, s.span, true));
            }
        }
        else if (ty.k === 'record') {
            // m, s, h = ind.macd(): one name for each value of the group, in the group's own order (2026-10-25).
            const names = Object.keys(ty.fields);
            const order = names.join(', ');
            if (names.length !== s.targets.length) {
                this.err(s.value.span, 'E-UNPACK-GROUP', `${ty.label} gives ${names.length} values (${order}), but ${s.targets.length} names are set.`, `Write ${names.length} names in this order, for example ${names.join(', ')} = ..., or store it in one name and pick a field, for example m.${names[0]}.`);
                for (const t of s.targets)
                    this.bindName(t, ANY, scope, s.span, false);
                return;
            }
            const wrong = unpackMismatch(names, s.targets.map((t) => t.id));
            if (wrong) {
                const who = s.targets[wrong.at].id;
                const pine = names.includes('upper') ? ' Bands come as upper, mid, lower here (Pine gives the middle first).' : names.includes('adx') ? ' ind.adx gives the ADX first (Pine\'s ta.dmi gives +DI, -DI, ADX).' : '';
                this.err(s.targets[wrong.at].span, 'E-UNPACK-ORDER', wrong.means === undefined
                    ? `${ty.label} gives ${order}, in that order, and the name \`${who}\` does not say which one it is.`
                    : `${ty.label} gives ${order}, in that order, so \`${who}\` would get its ${names[wrong.at]}, not its ${wrong.means}.`, `Name them in this order, for example ${names.join(', ')} = ..., or store the group in one name and use ${names.map((n) => `.${n}`).join(', ')}.${pine}`);
                for (const t of s.targets)
                    this.bindName(t, ANY, scope, s.span, false);
                return;
            }
            const dup = s.targets.findIndex((t, i) => !t.id.startsWith('_') && s.targets.findIndex((u) => u.id === t.id) !== i);
            if (dup >= 0) {
                this.err(s.targets[dup].span, 'E-UNPACK-DUP', `\`${s.targets[dup].id}\` is written twice, so the first value it gets is lost.`, `Give each value its own name, for example ${names.join(', ')} = ....`);
                for (const t of s.targets)
                    this.bindName(t, ANY, scope, s.span, false);
                return;
            }
            s.targets.forEach((t, i) => this.bindName(t, ty.fields[names[i]], scope, s.span, true));
        }
        else {
            if (!(ty.k === 'scalar' && ty.base === 'any'))
                this.err(s.value.span, 'E-UNPACK-TYPE', 'Only a group such as ind.macd() or a helper that returns several values (return a, b) can be split into several names.', 'Set one name per line.');
            for (const t of s.targets)
                this.bindName(t, ANY, scope, s.span, true);
        }
    }
    bindName(t, ty, scope, at, reportUnused) {
        // `n = 30` below `n = input(20)`: the settings panel would show n, but the script would use 30 (B1-1). Helpers have their own names.
        const before = this.inHelper === 0 ? scope.lookup(t.id) : undefined;
        if (before?.setting) {
            this.err(t.span, 'E-INPUT-REASSIGN', `\`${t.id}\` is a setting, so it cannot be given a new value: the value chosen in the settings would be ignored.`, `Give the new value another name, for example ${t.id}2 = ..., and use that name below.`);
            before.used = true;
            return;
        }
        if (isReservedName(t.id)) {
            this.err(t.span, 'E-NAME-SHADOW', `\`${t.id}\` is a built-in name and cannot be used for your own value.`, valueSpec(t.id) && !t.id.includes('.') ? `Choose another name, for example my_${t.id}. To compare, write == instead: ${t.id} == ....` : `Choose another name, for example my_${t.id}.`);
        }
        else if (this.helpers.has(t.id)) {
            this.err(t.span, 'E-NAME-SHADOW', `\`${t.id}\` is already the name of a helper.`, 'Choose a different name for the value.');
        }
        scope.set(t.id, { ty, node: t.span, used: false, maybe: false, reportUnused });
        void at;
    }
    exprStmt(e, s, scope, isResult) {
        const ty = this.expr(e, scope);
        if (isResult) {
            if (ty.k === 'none') {
                this.err(e.span, 'E-BARE-RESULT-TYPE', 'The last line gives no value, so the screener has no result.', 'End the script with the true/false condition itself, for example close > ta.sma(close, 50).');
            }
            else if (ty.k !== 'scalar' || !isBoolish(ty.base)) {
                this.err(e.span, 'E-BARE-RESULT-TYPE', `The last line is ${words(ty)}, but a screener needs a true/false condition.`, 'Add a comparison, for example rs > 0.');
            }
            else if (!ty.series && ty.value !== undefined) {
                this.warn(e.span, 'W-CONSTANT-RESULT', 'The result is always the same, for every stock and every candlestick.', 'Use a condition that depends on the candlesticks.');
            }
            return;
        }
        if (ty.k !== 'none' && !(ty.k === 'scalar' && ty.base === 'any')) {
            this.warn(s.span, 'W-NO-EFFECT', 'This line works out a value but does nothing with it.', 'Store it in a name, or pass it to show(), plot() or the result.');
        }
    }
    returnStmt(value, s, scope, tail) {
        const ty0 = this.expr(value, scope);
        const inHelper = this.inHelper > 0;
        if (!inHelper && this.kind !== 'screener') {
            this.err(s.span, 'E-RETURN-UNEXPECTED', `${cap1(kindWords(this.kind))} does not return a value.`, this.kind === 'indicator' ? 'Use plot() and mark() to draw.' : this.kind === 'alert' ? 'Use alert(condition, "message").' : 'Use strategy.entry(...) and strategy.exit(...).');
            return;
        }
        if (!tail) {
            this.err(s.span, 'E-RETURN-EARLY', 'A return must be the last thing on its path.', 'Put the lines that follow into the else branch, or finish the work before the if.');
        }
        let ty = ty0;
        if (ty.k === 'none') {
            this.err(value.span, 'E-VALUE-NONE', 'This call does not give back a value, so it cannot be returned.', 'Return a value instead.');
            ty = ANY;
        }
        else if (ty.k === 'list') {
            this.err(value.span, 'E-LIST-USE', 'A list cannot be returned.', LIST_PLACES);
            ty = ANY;
        }
        if (!inHelper) {
            if (ty.k !== 'scalar' || !isBoolish(ty.base)) {
                if (!(ty.k === 'scalar' && ty.base === 'any')) {
                    this.err(value.span, 'E-RETURN-TYPE', `A screener must return a true/false condition, but this is ${words(ty)}.`, ty.k === 'scalar' && isNumeric(ty.base) ? 'Add a comparison, for example rs > 0.' : 'Return a condition such as close > ta.sma(close, 50).');
                }
                ty = ANY;
            }
            else if (!ty.series && ty.value !== undefined && this.ifDepth === 0) {
                // Inside an if the result follows the if's condition (B1-9): `if c: return True else: return False` is not constant.
                this.warn(value.span, 'W-CONSTANT-RESULT', 'The result is always the same, for every stock and every candlestick.', 'Use a condition that depends on the candlesticks.');
            }
        }
        this.returns.push({ ty: this.underConditions(ty), node: s.span });
    }
    /** A value produced inside an if on a series condition differs from candlestick to candlestick. */
    underConditions(ty) {
        if (this.condStack.length === 0)
            return ty;
        const meta = this.condStack.reduce((a, c) => ({ frame: finestFrame(a.frame, c.frame), snap: a.snap || c.snap, lb: Math.max(a.lb, c.lb) }), { frame: 'D', snap: false, lb: 0 });
        const apply = (t) => {
            if (t.k === 'scalar') {
                return { ...t, series: true, frame: t.series ? finestFrame(t.frame, meta.frame) : meta.frame, snap: t.snap || meta.snap, lb: Math.max(t.lb, meta.lb), value: undefined, lo: undefined, hi: undefined, setting: undefined };
            }
            if (t.k === 'tuple')
                return { k: 'tuple', items: t.items.map(apply) };
            return t;
        };
        return apply(ty);
    }
    /** How many if blocks the statement being checked is inside. */
    ifDepth = 0;
    ifStmt(s, scope, tail) {
        this.ifDepth++;
        try {
            this.ifStmt0(s, scope, tail);
        }
        finally {
            this.ifDepth--;
        }
    }
    ifStmt0(s, scope, tail) {
        const t = this.scalarOf(this.expr(s.test, scope), s.test, 'the test of an if');
        if (!isBoolish(t.base)) {
            this.err(s.test.span, 'E-IF-COND', `An if needs a true/false condition, but this is ${words(t)}.`, 'Add a comparison, for example if x > 0:.');
        }
        const series = t.series;
        if (series) {
            this.condStack.push({ frame: t.frame, snap: t.snap, lb: t.lb });
            this.seriesIf++;
        }
        const a = new Scope(scope);
        const b = new Scope(scope);
        this.checkBlock(s.body, a, tail, null);
        this.checkBlock(s.orelse, b, tail, null);
        if (series) {
            this.condStack.pop();
            this.seriesIf--;
        }
        if (tail)
            return;
        const names = new Set([...a.assigned, ...b.assigned]);
        for (const n of names) {
            const prev = scope.lookup(n);
            const ba = a.assigned.has(n) ? a.vars.get(n) : undefined;
            const bb = b.assigned.has(n) ? b.vars.get(n) : undefined;
            const ta = ba?.ty ?? prev?.ty;
            const tb = bb?.ty ?? prev?.ty;
            const node = (bb ?? ba);
            if (ta && tb) {
                let joined = joinTy(ta, tb, series);
                if (!joined) {
                    this.err(node.node, 'E-BRANCH-TYPE', `\`${n}\` is ${words(ta)} in one branch and ${words(tb)} in the other.`, 'Both branches must give the same kind of value.');
                    joined = ANY;
                }
                else if (joined.k === 'scalar' && joined.base === 'str' && (series || t.snap)) {
                    this.textChoice(node.node);
                    joined = ANY;
                }
                else if (series && joined.k === 'scalar') {
                    joined = this.underConditionsMeta(joined, t);
                }
                scope.set(n, { ty: joined, node: node.node, used: false, maybe: false, reportUnused: true });
            }
            else {
                const only = (ta ?? tb);
                scope.set(n, { ty: only, node: node.node, used: false, maybe: true, reportUnused: true });
            }
        }
    }
    underConditionsMeta(s, test) {
        return { ...s, frame: s.series ? finestFrame(s.frame, test.frame) : test.frame, snap: s.snap || test.snap, lb: Math.max(s.lb, test.lb) };
    }
    // ---- expressions
    /** Make sure the type is a single value (or a series of them); report and fall back to `any` otherwise. */
    scalarOf(ty, node, role) {
        if (ty.k === 'scalar')
            return ty;
        switch (ty.k) {
            case 'record': {
                const f = Object.keys(ty.fields)[0];
                this.err(node.span, 'E-TYPE-GROUP', `${ty.label} is a group of values and cannot be used as ${role}.`, `Pick one value from it, for example ${shortText(node)}.${f}.`);
                break;
            }
            case 'tuple':
                this.err(node.span, 'E-TYPE-TUPLE', `A group of ${ty.items.length} values cannot be used as ${role}.`, 'Split it into names first: a, b = helper(...).');
                break;
            case 'list':
                this.err(node.span, 'E-LIST-USE', 'A list cannot be used here.', LIST_PLACES);
                break;
            case 'none':
                this.err(node.span, 'E-VALUE-NONE', 'This call does not give back a value.', 'It can only be used on a line of its own.');
                break;
        }
        return ANY;
    }
    expr(e, scope) {
        const ty = this.expr0(e, scope);
        if (this.inlineStack.length === 0 && !this.inComp)
            this.types.set(e, ty);
        if (ty.k === 'scalar' && ty.lb > this.maxLookback)
            this.maxLookback = ty.lb;
        return ty;
    }
    inComp = 0;
    /** Names written after `//` at the end of a line, which may be a Pine Script comment (B1-4). */
    commentNames = new WeakSet();
    expr0(e, scope) {
        switch (e.kind) {
            case 'Number': return constant(intLike(e.raw, e.value) ? 'int' : 'float', e.value);
            case 'String': return constant('str', e.value);
            case 'Bool': return constant('bool', e.value);
            case 'Na': return constant('na');
            case 'Name': return this.nameExpr(e, scope);
            case 'Attribute': return this.attributeExpr(e, scope);
            case 'Subscript': return this.subscriptExpr(e, scope);
            case 'Call': return this.callExpr(e, scope);
            case 'Unary': return this.unaryExpr(e, scope);
            case 'Binary': return this.binaryExpr(e, scope);
            case 'BoolOp': return this.boolOpExpr(e, scope);
            case 'Compare': return this.compareExpr(e, scope);
            case 'IfExp': return this.ifExpr(e, scope);
            case 'Tuple': return { k: 'tuple', items: e.elts.map((x) => this.expr(x, scope)) };
            case 'ListComp':
                this.err(e.span, 'E-LIST-USE', 'A list can only be used inside all, any, min, max, sum or avg.', LIST_PLACES);
                return ANY;
            case 'List':
                this.err(e.span, 'E-LIST-USE', 'A list can only be used inside all, any, min, max, sum or avg.', LIST_PLACES);
                for (const x of e.elts)
                    this.expr(x, scope);
                return ANY;
            case 'Lambda':
                this.err(e.span, 'E-LAMBDA-PLACE', 'A lambda can only be used as an argument of ta.scan, which is not built yet.', 'Use ta.bars_since, ta.value_when or ta.latch for state.');
                return ANY;
        }
    }
    // ---- names and attributes
    nameExpr(e, scope) {
        const b = scope.lookup(e.id);
        if (b) {
            b.used = true;
            if (b.maybe) {
                this.err(e.span, 'E-MAYBE-UNDEFINED', `\`${e.id}\` is set in only some branches of the if above, so it may have no value here.`, 'Set it before the if, or in every branch including else.');
                return ANY;
            }
            return b.ty;
        }
        if (this.pending.has(e.id)) {
            this.err(e.span, 'E-SELF-REFERENCE', `\`${e.id}\` is used in its own definition.`, 'A value cannot be built from itself. For state that carries forward use ta.bars_since, ta.value_when or ta.latch; otherwise give the new value a new name.');
            return ANY;
        }
        if (this.helpers.has(e.id)) {
            this.err(e.span, 'E-NAME-HELPER', `\`${e.id}\` is a helper, not a value.`, `Call it: ${e.id}(...).`);
            return ANY;
        }
        const vs = valueSpec(e.id);
        if (vs && !e.id.includes('.')) {
            this.use(vs.requires, e.id, e.span);
            this.tagged(vs.name, vs.tag, undefined, e.span);
            return seriesOf(vs.base, 'D', 0, false);
        }
        // hl2, hlc3, ohlc4: the same as writing the sum of the prices divided by their count.
        if (isPriceBlend(e.id)) {
            for (const field of PRICE_BLENDS[e.id].fields) {
                const fs = valueSpec(field);
                this.use(fs.requires, field, e.span);
                this.tagged(fs.name, fs.tag, undefined, e.span);
            }
            return seriesOf('float', 'D', 0, false);
        }
        if (e.id in RESERVED_NAMESPACES) {
            this.err(e.span, 'E-NAME-RESERVED', `\`${e.id}\` is kept for ${RESERVED_NAMESPACES[e.id]}, which is not available yet.`, 'It will be usable once the data is switched on.');
            return ANY;
        }
        if (NAMESPACES.includes(e.id)) {
            this.err(e.span, 'E-NAME-GROUP', `\`${e.id}\` is a group of names, not a value.`, `Write ${e.id}.name or ${e.id}.name(...). Available: ${membersOf(e.id).slice(0, 8).join(', ')}.`);
            return ANY;
        }
        if (BUILTIN_FUNCTIONS.includes(e.id)) {
            this.err(e.span, 'E-NAME-FUNCTION', `\`${e.id}\` is a function, not a value.`, `Call it: ${e.id}(...).`);
            return ANY;
        }
        const habit = Object.prototype.hasOwnProperty.call(NAME_HABITS, e.id) ? NAME_HABITS[e.id] : undefined;
        if (habit) {
            this.err(e.span, habit.code, habit.message, habit.hint, Object.hasOwn(NAME_REWRITES, e.id) ? this.fixNode(e.span, NAME_REWRITES[e.id]) : undefined);
            return ANY;
        }
        const local = suggest(e.id, [...scope.names(), ...this.helpers.keys()]);
        const home = local ? undefined : this.elsewhere(e.id, null);
        const near = local ?? suggest(e.id, [...GLOBAL_VALUES, ...NAMESPACES, ...BUILTIN_FUNCTIONS]);
        const hidden = this.inHelper > 0 && this.outerScope?.lookup(e.id) !== undefined;
        let fix;
        let hint;
        if (hidden) {
            hint = `A helper sees its own parameters and the fixed values set before it is called, not a value that changes from candlestick to candlestick. Pass \`${e.id}\` in as an argument.`;
        }
        else if (Object.prototype.hasOwnProperty.call(NAME_HINTS, e.id)) {
            hint = NAME_HINTS[e.id];
            if (Object.hasOwn(NAME_REWRITES, e.id))
                fix = this.fixNode(e.span, NAME_REWRITES[e.id]);
        }
        else if (home && home.isValue) {
            hint = `Did you mean \`${home.to}\`?`;
            fix = this.fixNode(e.span, home.to);
        }
        else if (home) {
            // A function used without brackets: name its place and how it is called; the brackets are the user's to write.
            hint = this.homeHint(e.id, home.to);
        }
        else {
            const lowerHome = this.caseHome(e.id);
            hint = near ? `Did you mean \`${near}\`?` : lowerHome ? `Names are lower case: did you mean \`${lowerHome.to}\`?` : 'Check the spelling. Names are case-sensitive.';
            // A near spelling is a guess, so it is a hint only; a change of case alone is certain (B1-10).
            if (near && sameLetters(near, e.id))
                fix = this.fixNode(e.span, near);
            else if (!near && lowerHome && lowerHome.isValue)
                fix = this.fixNode(e.span, lowerHome.to);
        }
        if (this.commentNames.has(e)) {
            hint = `If \`// ${e.id}\` is a note, write # in place of //: in Pine Script // starts a comment, here it divides.`;
            fix = undefined;
        }
        this.err(e.span, 'E-NAME-UNKNOWN', `\`${e.id}\` is not defined.`, hint, fix);
        return ANY;
    }
    isGroupName(id, scope) {
        return !scope.lookup(id) && (NAMESPACES.includes(id) || id in RESERVED_NAMESPACES);
    }
    attributeExpr(e, scope) {
        if (e.value.kind === 'Name' && this.isGroupName(e.value.id, scope)) {
            return this.member(e.value.id, e.attr, e, false);
        }
        const base = this.expr(e.value, scope);
        if (base.k === 'record') {
            // Own fields only: `m.constructor` or `m.__proto__` is an unknown field, not a property every object has.
            const f = Object.hasOwn(base.fields, e.attr) ? base.fields[e.attr] : undefined;
            if (f)
                return f;
            const fields = Object.keys(base.fields);
            // `m.histogram`, `m.sig`, `bb.middle`: another word for a field (certain, so it is fixed); otherwise a near spelling (a hint).
            const synonym = fieldMeant(e.attr, fields);
            const near = synonym ?? suggest(e.attr, fields);
            const certain = synonym !== undefined || (near !== undefined && sameLetters(near, e.attr));
            this.err(e.span, 'E-ATTR-UNKNOWN', `${base.label} has no field called \`${e.attr}\`.`, near ? `Did you mean \`${near}\`? Fields: ${fields.join(', ')}.` : `Fields: ${fields.join(', ')}.`, near && certain ? this.fixAt(e.span, e.span.end - e.attr.length, e.attr, near) : undefined);
            return ANY;
        }
        if (!(base.k === 'scalar' && base.base === 'any')) {
            // pandas habits (B8-4): x.rolling(20).mean(), x.shift(1), x.iloc[-1] say what to write here.
            const pandas = this.pandasNotes.get(e) ?? (Object.hasOwn(PANDAS_WORDS, e.attr) && base.k === 'scalar' && base.series ? { hint: PANDAS_WORDS[e.attr] } : undefined);
            this.err(e.span, 'E-ATTR-TARGET', `${cap1(words(base))} has no fields.`, pandas ? pandas.hint : 'Only groups such as tf("W") or ind.macd(12, 26, 9) have fields.', pandas?.fix);
        }
        return ANY;
    }
    /** Hints for pandas method chains, found from the whole call before its parts are checked (B8-4). */
    pandasNotes = new WeakMap();
    /**
     * `x.rolling(20).mean()`, `x.ewm(span=20).mean()`, `x.shift(1)`, `x.diff(5)`, `x.pct_change(5)`, `x.cumsum()`: pandas. The
     * error lands on the first `.method` of a value; this notes, for that spot, what the whole chain is written as here, with a
     * one-click rewrite when the meaning is the same (a rolling mean, max, min or median, a shift, a difference).
     */
    notePandas(e) {
        const f = e.func;
        if (f.kind !== 'Attribute')
            return;
        const wrap = (x) => (x.kind === 'Name' || x.kind === 'Attribute' || x.kind === 'Subscript' || x.kind === 'Call' ? shortText(x) : `(${shortText(x)})`);
        const argOf = (c, name) => (c.args.find((a) => a.name === undefined) ?? c.args.find((a) => a.name === name))?.value;
        const note = (at, hint, text) => {
            this.pandasNotes.set(at, { hint, ...(text && e.span.endLine === e.span.line ? { fix: this.fixNode(e.span, text) } : {}) });
        };
        const inner = f.value;
        if (inner.kind === 'Call' && inner.func.kind === 'Attribute' && inner.func.attr === 'rolling' && e.args.length === 0) {
            const x = wrap(inner.func.value);
            const nExpr = argOf(inner, 'window');
            const n = nExpr ? shortText(nExpr) : 'n';
            const same = { mean: 'ta.sma', max: 'ta.highest', min: 'ta.lowest', median: 'ta.median' };
            const written = `.rolling(${n}).${f.attr}()`;
            if (Object.hasOwn(same, f.attr))
                note(inner.func, `\`${written}\` is pandas; here write ${same[f.attr]}(${x}, ${n}).`, nExpr ? `${same[f.attr]}(${x}, ${n})` : undefined);
            else if (f.attr === 'std')
                note(inner.func, `\`${written}\` is pandas; here write ta.stdev(${x}, ${n}). It is the population deviation (pandas divides by n - 1).`);
            else if (f.attr === 'sum' && ['Compare', 'BoolOp', 'Unary'].includes(inner.func.value.kind))
                note(inner.func, `\`${written}\` is pandas; here the number of true conditions is ta.count(${shortText(inner.func.value)}, ${n}).`);
            else if (f.attr === 'sum')
                note(inner.func, `\`${written}\` is pandas; there is no rolling sum here: write ta.sma(${x}, ${n}) * ${n}, or ta.count(cond, ${n}) to count true conditions.`);
            else
                note(inner.func, `\`.rolling(${n})\` is pandas; here a window is a function: ta.sma, ta.highest, ta.lowest, ta.stdev or ta.median of (${x}, ${n}).`);
            return;
        }
        if (inner.kind === 'Call' && inner.func.kind === 'Attribute' && inner.func.attr === 'ewm' && f.attr === 'mean') {
            const x = wrap(inner.func.value);
            const span = inner.args.find((a) => a.name === 'span')?.value;
            note(inner.func, `\`.ewm(...).mean()\` is pandas; here write ta.ema(${x}, ${span ? shortText(span) : 'n'}) for span=n, or ta.rma(${x}, n) for alpha=1/n (Wilder). The first values can differ from pandas, which starts the average at the first value.`);
            return;
        }
        const x = wrap(f.value);
        const k = e.args.length === 0 ? '1' : e.args.length === 1 && e.args[0].name === undefined ? shortText(e.args[0].value) : undefined;
        if (f.attr === 'shift' && k !== undefined)
            note(f, `\`.shift(${k})\` is pandas; here an earlier candlestick is written with [ ]: ${x}[${k}].`, `${x}[${k}]`);
        else if (f.attr === 'diff' && k !== undefined)
            note(f, `\`.diff(${k})\` is pandas; here write ${x} - ${x}[${k}], or ta.change(${x}, ${k}).`, `(${x} - ${x}[${k}])`);
        else if (f.attr === 'pct_change' && k !== undefined)
            note(f, `\`.pct_change(${k})\` is pandas; here write ${x} / ${x}[${k}] - 1, or ta.roc(${x}, ${k}) for the change in percent.`);
        else if (f.attr === 'cumsum' && e.args.length === 0)
            note(f, `\`.cumsum()\` is pandas; here write ta.cum_sum(${x}).`, `ta.cum_sum(${x})`);
    }
    /** `group.name` used as a value, or (asCall) the target of a call. Returns the value type when it is a value. */
    member(ns, attr, node, asCall, call) {
        const full = `${ns}.${attr}`;
        if (ns in RESERVED_NAMESPACES) {
            this.err(node.span, 'E-NAME-RESERVED', `\`${ns}\` is kept for ${RESERVED_NAMESPACES[ns]}, which is not available yet.`, 'It will be usable once the data is switched on.');
            return ANY;
        }
        if (Object.prototype.hasOwnProperty.call(PLANNED, full)) {
            this.err(node.span, 'E-NOT-YET', `\`${full}\` is not built yet.`, PLANNED[full]);
            return ANY;
        }
        const vs = valueSpec(full);
        if (vs) {
            if (asCall) {
                this.err(node.span, 'E-CALL-TARGET', `\`${full}\` is a value, not a function.`, `Remove the brackets: ${full}.`);
                return ANY;
            }
            this.use(vs.requires, full, node.span);
            this.tagged(vs.name, vs.tag, undefined, node.span);
            if (ns === 'bench')
                this.benchSpan ??= node.span;
            if (vs.shape === 'constant')
                return constant(vs.base);
            return seriesOf(vs.base, 'D', 0, vs.shape === 'snapshot');
        }
        const fs = fnSpec(full);
        if (fs) {
            if (!asCall) {
                this.err(node.span, 'E-ATTR-CALL', `\`${full}\` is a function and needs brackets.`, `Write ${full}(${fs.params.map((p) => p.name).join(', ')}).`);
            }
            return ANY;
        }
        if (ns === 'color' && Object.prototype.hasOwnProperty.call(COLOR_HINTS, attr)) {
            this.err(node.span, 'E-ATTR-UNKNOWN', `\`color\` has no name called \`${attr}\`.`, COLOR_HINTS[attr]);
            return ANY;
        }
        const message = `\`${ns}\` has no name called \`${attr}\`.`;
        // candle.bullish_engulfing(): the 24 patterns are one function, chosen by name.
        if (ns === 'candle' && PATTERN_IDS.includes(attr)) {
            const text = `candle.pattern("${attr}")`;
            const whole = asCall ? (call && call.args.length === 0 ? call.span : undefined) : node.span;
            this.err(node.span, 'E-ATTR-UNKNOWN', message, `The 24 patterns are chosen by name: write ${text}.`, whole ? this.fixNode(whole, text) : undefined);
            return ANY;
        }
        // Exactly this name in another group: ta.supertrend is ind.supertrend, math.abs is abs. Found before a near spelling here.
        const home = this.elsewhere(attr, ns);
        if (home) {
            const full = `${ns}.${attr}`;
            const toSpec = home.isValue ? undefined : fnSpec(home.to);
            const noArgsNeeded = !!toSpec && toSpec.params.every((q) => q.optional);
            if (home.note !== undefined) {
                // ta.min, ta.sum, math.avg: the same word means something else here, so only the hint says what to write (B1-11).
                this.err(node.span, 'E-ATTR-UNKNOWN', message, home.note);
            }
            else if (home.isValue) {
                this.err(node.span, 'E-ATTR-UNKNOWN', message, `Did you mean \`${home.to}\`?${asCall ? ' It is a value: write it without brackets.' : ''}`, asCall ? undefined : this.fixNode(node.span, home.to));
            }
            else if (!asCall) {
                // Pine writes some studies without brackets (ta.vwap); here every function is called.
                if (noArgsNeeded)
                    this.err(node.span, 'E-ATTR-UNKNOWN', message, `Did you mean \`${home.to}()\`? ${this.homeHint(full, home.to)}`, this.fixNode(node.span, `${home.to}()`));
                else
                    this.err(node.span, 'E-ATTR-UNKNOWN', message, this.homeHint(full, home.to));
            }
            else if (home.sameArgs || (call && call.args.length === 0)) {
                this.err(node.span, 'E-ATTR-UNKNOWN', message, `Did you mean \`${home.to}\`?${home.sameArgs ? '' : ` ${this.homeHint(full, home.to)}`}`, this.fixNode(node.span, home.to));
            }
            else {
                this.err(node.span, 'E-ATTR-UNKNOWN', message, this.homeHint(full, home.to));
            }
            return ANY;
        }
        const near = suggest(attr, membersOf(ns));
        this.err(node.span, 'E-ATTR-UNKNOWN', message, near ? `Did you mean \`${ns}.${near}\`?` : `Available in ${ns}: ${membersOf(ns).join(', ')}.`, near && sameLetters(near, attr) ? this.fixNode(node.span, `${ns}.${near}`) : undefined);
        return ANY;
    }
    use(caps, name, span) {
        for (const c of caps) {
            this.usedCaps.add(c);
            if (!this.host.caps.has(c)) {
                const m = explainMissing(c, this.host, name);
                this.err(span, m.code, m.message, m.hint);
            }
        }
    }
    tagged(name, tag, lag, span, reason) {
        if (!this.usedFns.has(name)) {
            const u = { name, tag };
            if (lag !== undefined)
                u.lag = lag;
            this.usedFns.set(name, u);
        }
        if (tag === null) {
            this.err(span, 'E-STDLIB-UNTAGGED', `\`${name}\` is not available yet.`, reason ?? 'It has not been checked for looking into the future. It will be enabled once it has been.');
        }
        else if (tag === 'noncausal' && !this.host.allowNoncausal) {
            this.err(span, 'E-NONCAUSAL', `\`${name}\` uses candlesticks that come after the one it is drawn on, so it would look into the future ${this.host.runsAs}.`, 'Use it only on the chart for drawing.');
        }
    }
    // ---- subscripts
    subscriptExpr(e, scope) {
        const target = this.expr(e.value, scope);
        const ix = this.expr(e.index, scope);
        let k;
        let bad = false;
        if (ix.k !== 'scalar') {
            this.scalarOf(ix, e.index, 'an index');
            bad = true;
        }
        else if (ix.series) {
            this.err(e.index.span, 'E-INDEX-NONCONST', 'The number in [ ] must be fixed, not a value that changes from candlestick to candlestick.', 'Use a fixed number such as close[1], or a setting made with input().');
            bad = true;
        }
        else if (ix.base === 'any') {
            bad = true;
        }
        else if (ix.base !== 'int') {
            this.err(e.index.span, 'E-INDEX-TYPE', `The number in [ ] must be a whole number, but this is ${words(ix)}.`, e.index.kind === 'String' ? `Text in [ ] picks a column in pandas; here the column is a name of its own: write ${JSON.stringify(e.index.value).slice(1, -1)} for the latest value, and ${JSON.stringify(e.index.value).slice(1, -1)}[1] for the one before.` : 'Use a whole number of candlesticks, such as 1 or 20. For whole-number division use //.');
            bad = true;
        }
        else if (ix.lo === undefined || ix.hi === undefined) {
            this.err(e.index.span, 'E-INDEX-NONCONST', 'The size of this index is not known.', 'Write a fixed number, or give the setting min= and max=.');
            bad = true;
        }
        else if (ix.lo < 0) {
            this.err(e.index.span, 'E-INDEX-NEGATIVE', ix.value !== undefined ? `x[${ix.value}] would look into the future.` : 'This index can be negative, which would look into the future.', ix.value !== undefined ? 'Use x[0] for the current candlestick and x[1] for the previous one.' : 'Give the setting min=0 so it can never be negative.');
            bad = true;
        }
        else {
            k = ix.hi;
        }
        if (target.k !== 'scalar') {
            this.err(e.span, 'E-INDEX-TARGET', `${cap1(words(target))} cannot be indexed.`, target.k === 'record' ? `Pick a field first, for example ${exprName(e.value)}.close[1].` : 'Only a value for every candlestick can be indexed.');
            return ANY;
        }
        if (!target.series) {
            if (target.base !== 'any')
                this.err(e.value.span, 'E-INDEX-TARGET', `${cap1(words(target))} is a single value; only a value for every candlestick can be indexed.`, 'Use a series such as close, or a result of ta.sma(...).');
            return bad ? ANY : target;
        }
        if (bad || k === undefined)
            return target;
        if (k === 0)
            return target;
        if (target.snap) {
            this.err(e.span, 'E-SNAPSHOT-HISTORY', 'This value exists only for the latest candlestick, so it has no earlier values.', 'Levels, sector and fundamentals are current values. Use a price-based value for history.');
            return target;
        }
        const lb = target.lb + k * frameWeight(target.frame);
        if (lb > MAX_LOOKBACK) {
            this.err(e.index.span, 'E-LOOKBACK', `This needs ${lb} candlesticks of history, but the limit is ${MAX_LOOKBACK}.`, 'Use a shorter look-back.');
            return { ...target, lb: MAX_LOOKBACK };
        }
        return { ...target, lb };
    }
    // ---- operators
    unaryExpr(e, scope) {
        const t = this.scalarOf(this.expr(e.operand, scope), e.operand, `the operand of ${e.op}`);
        if (e.op === 'not') {
            if (!isBoolish(t.base)) {
                this.err(e.operand.span, 'E-TYPE-BOOL', `\`not\` needs a true/false value, but this is ${words(t)}.`, 'Add a comparison, for example not (x > 0), or use x <= 0.');
                return seriesOrConst('bool', t);
            }
            const out = { ...t, base: 'bool' };
            if (typeof t.value === 'boolean')
                out.value = !t.value;
            return out;
        }
        if (!isNumeric(t.base)) {
            this.err(e.operand.span, 'E-TYPE-OP', `\`${e.op}\` needs a number, but this is ${words(t)}.`, t.base === 'bool' ? 'Use ta.count(cond, n) to count true values.' : 'Use a number.');
            return seriesOrConst('float', t);
        }
        if (typeof t.value === 'number') {
            const v = e.op === '-' ? -t.value : t.value;
            return { ...t, value: v, lo: v, hi: v };
        }
        if (e.op === '-' && t.lo !== undefined && t.hi !== undefined)
            return { ...t, lo: -t.hi, hi: -t.lo };
        return { ...t, lo: e.op === '+' ? t.lo : undefined, hi: e.op === '+' ? t.hi : undefined };
    }
    /**
     * `a // b` written with spaces and ending its line, with one value on the right: in Pine Script `//` starts a comment, so
     * `n = 50 // 50` may be a number with a note after it (B1-4). Floor division is rare in trading scripts.
     */
    pineCommentLike(e) {
        if (e.op !== '//' || (e.right.kind !== 'Name' && e.right.kind !== 'Number'))
            return false;
        if (e.left.span.endLine !== e.right.span.line)
            return false;
        if (!/^[ \t]+\/\/[ \t]+$/.test(this.source.slice(e.left.span.end, e.right.span.offset)))
            return false;
        const rest = this.source.slice(e.right.span.end).split(/\r\n|\r|\n/)[0];
        return /^[ \t]*(#.*)?$/.test(rest);
    }
    binaryExpr(e, scope) {
        if (e.right.kind === 'Name' && this.pineCommentLike(e))
            this.commentNames.add(e.right);
        const l = this.scalarOf(this.expr(e.left, scope), e.left, `the left side of ${e.op}`);
        const r = this.scalarOf(this.expr(e.right, scope), e.right, `the right side of ${e.op}`);
        // A price divided and rounded down, or two numbers that round down to 0 or 1 (`50 // 50`): almost certainly a note.
        const tiny = e.left.kind === 'Number' && e.right.kind === 'Number' && e.right.value !== 0 && Math.floor(e.left.value / e.right.value) <= 1;
        if (e.right.kind === 'Number' && this.pineCommentLike(e) && ((l.series && isNumeric(l.base)) || tiny)) {
            this.warn(e.span, 'W-FLOOR-DIV', '`//` divides and rounds down here. In Pine Script `//` starts a comment.', 'If the text after // is a note, write # in place of //. To divide and round down on purpose, write math.floor(a / b).');
        }
        let ok = true;
        for (const [t, n] of [[l, e.left], [r, e.right]]) {
            if (!isNumeric(t.base)) {
                ok = false;
                this.err(n.span, 'E-TYPE-OP', `\`${e.op}\` needs numbers, but this is ${words(t)}.`, t.base === 'bool' ? 'True/false values cannot be added or multiplied. Use ta.count(cond, n) to count how often a condition was true.' : t.base === 'str' ? 'Text cannot be joined or calculated with.' : 'Use numbers.');
            }
        }
        const meta = mergeMeta(l, r);
        if (!ok)
            return { ...ANY, ...meta, base: 'any' };
        if ((e.op === '/' || e.op === '//' || e.op === '%') && !r.series && r.lo === 0 && r.hi === 0) {
            this.err(e.right.span, 'E-DIV-ZERO', 'This divides by zero.', 'Check the divisor, or use nz() on the result.');
            return { ...ANY, ...meta, base: 'any' };
        }
        const base = e.op === '/' ? 'float' : e.op === '**' ? (l.base === 'int' && r.base === 'int' && r.lo !== undefined && r.lo >= 0 ? 'int' : 'float') : joinNumeric2(l.base, r.base);
        const out = { k: 'scalar', base, ...meta };
        if (!out.series) {
            const lv = l.value;
            const rv = r.value;
            if (typeof lv === 'number' && typeof rv === 'number') {
                let v;
                switch (e.op) {
                    case '+':
                        v = lv + rv;
                        break;
                    case '-':
                        v = lv - rv;
                        break;
                    case '*':
                        v = lv * rv;
                        break;
                    case '/':
                        v = rv === 0 ? undefined : lv / rv;
                        break;
                    case '//':
                        v = rv === 0 ? undefined : pyFloorDiv(lv, rv);
                        break;
                    case '%':
                        v = rv === 0 ? undefined : pyMod(lv, rv);
                        break;
                    case '**':
                        v = lv ** rv;
                        break;
                }
                if (v !== undefined && Number.isFinite(v) && Math.abs(v) <= SAFE) {
                    out.value = v;
                    out.lo = v;
                    out.hi = v;
                }
            }
            else if (l.lo !== undefined && l.hi !== undefined && r.lo !== undefined && r.hi !== undefined) {
                if (e.op === '+') {
                    out.lo = l.lo + r.lo;
                    out.hi = l.hi + r.hi;
                }
                else if (e.op === '-') {
                    out.lo = l.lo - r.hi;
                    out.hi = l.hi - r.lo;
                }
                else if (e.op === '*') {
                    const ps = [l.lo * r.lo, l.lo * r.hi, l.hi * r.lo, l.hi * r.hi];
                    out.lo = Math.min(...ps);
                    out.hi = Math.max(...ps);
                }
            }
            if (l.setting || r.setting)
                out.setting = true;
        }
        return out;
    }
    boolOpExpr(e, scope) {
        const ts = e.values.map((v) => this.scalarOf(this.expr(v, scope), v, `a side of ${e.op}`));
        ts.forEach((t, i) => {
            if (!isBoolish(t.base)) {
                this.err(e.values[i].span, 'E-TYPE-BOOL', `\`${e.op}\` needs true/false on both sides, but this is ${words(t)}.`, 'Add a comparison, for example x > 0, so each side is true or false.');
            }
        });
        const meta = ts.reduce((m, t) => mergeMeta(m, t), { series: false, frame: 'D', snap: false, lb: 0 });
        const out = { k: 'scalar', base: 'bool', ...meta };
        if (!out.series && ts.every((t) => typeof t.value === 'boolean')) {
            out.value = e.op === 'and' ? ts.every((t) => t.value === true) : ts.some((t) => t.value === true);
        }
        return out;
    }
    /** `mode == "emaa"` where `mode` has options=[...] without "emaa": never true, so say so (A5). */
    optionWarning(setting, text) {
        const opts = setting.t.options;
        if (!opts || typeof text.t.value !== 'string' || text.t.setting || opts.includes(text.t.value))
            return false;
        const near = suggest(text.t.value, opts);
        this.warn(text.n.span, 'W-OPTION-UNKNOWN', `"${text.t.value}" is not one of the choices of this setting, so this comparison is never true.`, near ? `Did you mean "${near}"? Choices: ${opts.join(', ')}.` : `Choices: ${opts.join(', ')}.`);
        return true;
    }
    compareExpr(e, scope) {
        const first = this.scalarOf(this.expr(e.left, scope), e.left, 'a side of a comparison');
        const operands = [{ t: first, n: e.left }];
        for (const c of e.comparators)
            operands.push({ t: this.scalarOf(this.expr(c, scope), c, 'a side of a comparison'), n: c });
        let meta = mergeMeta(first, first);
        let known = true;
        for (let i = 0; i < e.ops.length; i++) {
            const a = operands[i];
            const b = operands[i + 1];
            const op = e.ops[i];
            meta = mergeMeta(meta, b.t);
            const ordered = op !== '==' && op !== '!=';
            if (!ordered && (a.t.base === 'na' || b.t.base === 'na')) {
                // Comparing with na is itself missing (SPEC section 4), so `x == na` is never true and `x != na` never true either.
                const other = a.t.base === 'na' ? b.n : a.n;
                const shown = other.kind === 'Na' ? 'x' : shortText(other);
                this.err(e.span, 'E-NA-COMPARE', `\`${op} na\` is never true: comparing with a missing value gives a missing answer, not true or false.`, `Use is_na(${shown}) to test for a missing value${op === '!=' ? `, here not is_na(${shown})` : ''}.`);
                known = false;
                continue;
            }
            const fam = (t) => (isNumeric(t.base) && t.base !== 'na' ? 'number' : t.base);
            const anyish = (t) => t.base === 'any' || t.base === 'na';
            if (ordered) {
                for (const x of [a, b]) {
                    if (!isNumeric(x.t.base)) {
                        this.err(x.n.span, 'E-TYPE-COMPARE', `\`${op}\` compares numbers, but this is ${words(x.t)}.`, x.t.base === 'str' ? 'Text can only be compared with == and !=.' : x.t.base === 'bool' ? 'Compare numbers, for example ta.count(cond, 5) >= 1.' : 'Compare numbers.');
                    }
                }
            }
            else if (!anyish(a.t) && !anyish(b.t) && fam(a.t) !== fam(b.t)) {
                this.err(b.n.span, 'E-TYPE-COMPARE', `\`${op}\` compares like with like, but this is ${words(a.t)} against ${words(b.t)}.`, 'Compare a number with a number, text with text, or true/false with true/false.');
            }
            else if ((a.t.base === 'color' || b.t.base === 'color') && !anyish(a.t) && !anyish(b.t)) {
                this.err(b.n.span, 'E-TYPE-COMPARE', 'Colours cannot be compared.', 'Compare the conditions that choose the colour instead.');
            }
            if (!ordered && (a.t.base === 'float' || b.t.base === 'float') && isNumeric(a.t.base) && isNumeric(b.t.base)) {
                const zero = (t) => t.value === 0;
                if (!zero(a.t) && !zero(b.t) && (a.t.series || b.t.series) && !windowOfItself(a.n, b.n) && !windowOfItself(b.n, a.n)) {
                    this.warn(e.span, 'W-FLOAT-EQ', `\`${op}\` on decimal numbers rarely matches exactly.`, 'Use near(a, b, pct) to allow a small difference.');
                }
            }
            if (!ordered && !this.optionWarning(a, b))
                this.optionWarning(b, a);
            this.priceLevelWarning(a.n, b.n, e);
            this.priceLevelWarning(b.n, a.n, e);
            if (!(typeof a.t.value !== 'undefined' && typeof b.t.value !== 'undefined'))
                known = false;
        }
        const out = { k: 'scalar', base: 'bool', ...meta };
        if (!out.series && known) {
            let v = true;
            for (let i = 0; i < e.ops.length; i++) {
                const x = operands[i].t.value;
                const y = operands[i + 1].t.value;
                const op = e.ops[i];
                const r = op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : op === '>=' ? x >= y : op === '==' ? x === y : x !== y;
                v = v && r;
            }
            out.value = v;
        }
        return out;
    }
    /**
     * A fixed price level compared with an earlier price, on adjusted history (today's price is the real one). In a backtest every
     * candlestick is an earlier one: the compiler gives that warning once, with the label it puts on the result (W-ABS-PRICE-LEVEL),
     * so it is not given here too (2026-10-25, B1-16). 0 is never a level: the sign of a price does not change with an adjustment.
     */
    priceLevelWarning(price, level, at) {
        if (level.kind !== 'Number' || level.value === 0 || this.host.id === 'strategy')
            return;
        let p = price;
        let shifted = false;
        if (p.kind === 'Subscript' && p.index.kind === 'Number' && p.index.value > 0) {
            shifted = true;
            p = p.value;
        }
        if (p.kind !== 'Name' || !['open', 'high', 'low', 'close'].includes(p.id))
            return;
        if (shifted) {
            this.warn(at.span, 'W-ADJUSTED-PRICE-LEVEL', 'A fixed price level may not match old prices, which are adjusted for splits and bonuses.', 'Compare with a level built from candlesticks, such as ta.highest(high, 20), or use a ratio.');
        }
    }
    ifExpr(e, scope) {
        const t = this.scalarOf(this.expr(e.test, scope), e.test, 'the test of a conditional value');
        if (!isBoolish(t.base))
            this.err(e.test.span, 'E-IF-COND', `The test of a conditional value must be true/false, but this is ${words(t)}.`, 'Add a comparison, for example x if y > 0 else z.');
        const a = this.expr(e.body, scope);
        const b = this.expr(e.orelse, scope);
        const joined = joinTy(a, b, t.series);
        if (!joined) {
            this.err(e.orelse.span, 'E-BRANCH-TYPE', `The two sides of the conditional value differ: ${words(a)} and ${words(b)}.`, 'Both sides must give the same kind of value.');
            return ANY;
        }
        if (joined.k === 'scalar' && joined.base === 'str' && (t.series || t.snap)) {
            this.textChoice(e.span);
            return ANY;
        }
        if (joined.k === 'scalar')
            return t.series ? this.underConditionsMeta(joined, t) : joined;
        return joined;
    }
    /** A text can be chosen only by a fixed value or a setting: the runtime has no text that changes from candlestick to candlestick. */
    textChoice(at) {
        this.err(at, 'E-TEXT-CHOICE', 'A text cannot be chosen per candlestick.', 'Compare instead, for example show(close > open, "Up"), or choose the text with a setting.');
    }
    // ---- calls
    callExpr(e, scope) {
        const f = e.func;
        let ty;
        // Pine's na(x): here na is only the missing value, and is_na(x) asks whether x is missing.
        if (f.kind === 'Na') {
            this.pine(f.span, PINE_HABITS.na, this.fixNode(f.span, 'is_na'));
            this.evalAll(e, scope);
            return ANY;
        }
        // Pine's input.int(20), input.float(1.5): one input() here, its type taken from the default.
        if (f.kind === 'Attribute' && f.value.kind === 'Name' && f.value.id === 'input' && !scope.lookup('input')) {
            this.pine(f.span, PINE_HABITS.input(f.attr), this.pineInputFix(e, f));
            // The arguments are looked at for their own problems; a list of options is the setting's choices, not a list value (B1-14).
            for (const a of e.args) {
                if (a.value.kind === 'List')
                    for (const x of a.value.elts)
                        this.expr(x, scope);
                else
                    this.expr(a.value, scope);
            }
            return ANY;
        }
        // NOT(x) or Not(x): the capital NOT followed by brackets reads as a call (B1-6).
        if (f.kind === 'Name' && (f.id === 'NOT' || f.id === 'Not') && !scope.lookup(f.id) && !this.helpers.has(f.id)) {
            this.pine(f.span, PINE_HABITS.logic(f.id), this.fixNode(f.span, 'not'));
            this.evalAll(e, scope);
            return ANY;
        }
        if (f.kind === 'Name')
            ty = this.callByName(e, f, scope);
        else if (f.kind === 'Attribute' && f.value.kind === 'Name' && this.isGroupName(f.value.id, scope))
            ty = this.callMember(e, f, scope);
        else {
            const before = this.errorSeq;
            this.notePandas(e);
            this.expr(f, scope);
            if (this.errorSeq === before) {
                this.err(f.span, 'E-CALL-TARGET', 'Only a named function can be called.', 'Functions look like ta.sma(close, 20) or abs(x). A group such as m = ind.macd(...) is used as m.hist, not called.');
            }
            for (const a of e.args)
                this.expr(a.value, scope);
            ty = ANY;
        }
        return ty;
    }
    /**
     * The one-click rewrite of Pine's input.int(20, "Length", minval=1) into input(20, title="Length", min=1) (B1-13, B1-20): the name,
     * a title given second without its name, Pine's names for min and max, and a whole-number default of input.float written with
     * a decimal point so the setting stays a decimal one. No fix when an argument has no counterpart here.
     */
    pineInputFix(e, f) {
        if (!['int', 'float', 'bool', 'string'].includes(f.attr))
            return undefined;
        const pos = e.args.filter((a) => a.name === undefined);
        if (pos.length < 1 || pos.length > 2 || (pos.length === 2 && pos[1].value.kind !== 'String'))
            return undefined;
        const edits = [this.fixNode(f.span, 'input')];
        if (pos.length === 2)
            edits.push(this.fixAt(e.span, pos[1].value.span.offset, '', 'title='));
        for (const a of e.args) {
            if (a.name === undefined || a.name === 'title' || a.name === 'options' || a.name === 'min' || a.name === 'max')
                continue;
            const ours = PINE_INPUT_ARGS[a.name];
            if (!ours || a.name === 'defval')
                return undefined;
            edits.push(this.fixAt(e.span, a.span.offset, a.name, ours));
        }
        const d = pos[0].value;
        // the number itself is rewritten (not a zero-width insertion after it), so it never touches the range added before the `)`
        if (f.attr === 'float' && d.kind === 'Number' && intLike(d.raw, d.value))
            edits.push(this.fixNode(d.span, `${d.raw}.0`));
        // B1-13 (verify, 2026-10-25): a decimal setting has no range of its own here. When it is given to functions that accept a
        // range (ind.bb's k is 0.1 to 10), the fix writes that range, so the fixed script checks clean.
        const hasRange = e.args.some((a) => a.name !== undefined && ['min', 'max', 'minval', 'maxval'].includes(a.name));
        const target = this.inputTarget.get(e.span.offset);
        const range = target !== undefined ? this.floatSettingRange.get(target) : undefined;
        if (f.attr === 'float' && !hasRange && range && range.min <= range.max) {
            if (d.kind !== 'Number' || d.value < range.min || d.value > range.max)
                return undefined;
            edits.push(this.fixAt(e.span, e.span.end - 1, ')', `, min=${range.min}, max=${range.max})`));
        }
        if (edits.some((x) => x === undefined))
            return undefined;
        return edits.flatMap((x) => x).sort((a, b) => a.line - b.line || a.col - b.col);
    }
    callByName(e, f, scope) {
        const id = f.id;
        if (scope.lookup(id)) {
            scope.lookup(id).used = true;
            this.err(f.span, 'E-CALL-TARGET', `\`${id}\` is a value, not a function.`, 'Remove the brackets, or call a function such as abs(x).');
            this.evalAll(e, scope);
            return ANY;
        }
        if (this.helpers.has(id))
            return this.callHelper(e, this.helpers.get(id), scope);
        // Pine habits: naming the script with a call, and drawing functions that have another name here.
        const pineHabit = PINE_CALLS[id]?.();
        if (pineHabit) {
            this.pine(f.span, pineHabit);
            this.evalAll(e, scope);
            return ANY;
        }
        if (id === 'input') {
            this.err(f.span, 'E-INPUT-PLACE', 'input() can only be used on a line of its own as name = input(...) in a script without def, or as the default of a parameter of the script-type function.', this.kind.startsWith('bare') ? 'Write n = input(20) on its own line at the top, and use n below.' : 'Write def scan(n: int = input(20)): and use n inside.');
            this.evalAll(e, scope);
            return ANY;
        }
        if (id === 'range') {
            this.err(f.span, 'E-RANGE-USE', 'range() can only be used inside [ ... for i in range(n)].', 'Write all([cond for i in range(3)]).');
            this.evalAll(e, scope);
            return ANY;
        }
        if ((id === 'min' || id === 'max') && e.args.length === 1 && e.args[0].name === undefined && (e.args[0].value.kind === 'List' || e.args[0].value.kind === 'ListComp')) {
            return this.listMinMax(e, id, scope);
        }
        const spec = fnSpec(id);
        if (spec)
            return this.callSpec(e, spec, id, scope);
        if (valueSpec(id) && !id.includes('.')) {
            this.err(f.span, 'E-CALL-TARGET', `\`${id}\` is a value, not a function.`, `Remove the brackets: ${id}. For an earlier candlestick use ${id}[1].`);
            this.evalAll(e, scope);
            return ANY;
        }
        if (NAMESPACES.includes(id) || id in RESERVED_NAMESPACES) {
            this.err(f.span, id in RESERVED_NAMESPACES ? 'E-NAME-RESERVED' : 'E-CALL-TARGET', id in RESERVED_NAMESPACES ? `\`${id}\` is kept for ${RESERVED_NAMESPACES[id]}, which is not available yet.` : `\`${id}\` is a group of functions and cannot be called itself.`, id in RESERVED_NAMESPACES ? 'It will be usable once the data is switched on.' : `Write ${id}.name(...). Available: ${membersOf(id).slice(0, 8).join(', ')}.`);
            this.evalAll(e, scope);
            return ANY;
        }
        const habit = Object.prototype.hasOwnProperty.call(NAME_HABITS, id) ? NAME_HABITS[id] : undefined;
        if (habit) {
            this.err(f.span, habit.code, habit.message, habit.hint);
        }
        else {
            const named = Object.prototype.hasOwnProperty.call(NAME_HINTS, id);
            const local = suggest(id, [...this.helpers.keys()]);
            const home = local || named ? undefined : this.elsewhere(id, null);
            const near = local ?? suggest(id, BUILTIN_FUNCTIONS);
            let hint;
            let fix;
            const study = home && !home.isValue && home.to.startsWith('ta.') ? this.studyForSettings(e, id) : undefined;
            if (named)
                hint = NAME_HINTS[id];
            else if (home && home.isValue)
                hint = `Did you mean \`${home.to}\`? It is a value: write it without brackets.`;
            else if (study) {
                // rsi(14), Chartink's way: only settings are written, so it is the study that reads the close itself (B8-6).
                hint = `Did you mean \`${study}\`? It reads the close itself, so ${id}(${e.args.map((a) => (a.name ? `${a.name}=` : '') + shortText(a.value)).join(', ')}) is ${study}(${e.args.map((a) => shortText(a.value)).join(', ')}). For another series write ${home?.to}(x, length).`;
                fix = this.fixNode(f.span, study);
            }
            else if (home && (home.sameArgs || e.args.length === 0)) {
                // rsi(close, 14) is ta.rsi(close, 14): the same arguments, so the name alone is rewritten.
                hint = `Did you mean \`${home.to}\`?${home.sameArgs ? '' : ` ${this.homeHint(id, home.to)}`}`;
                fix = this.fixNode(f.span, home.to);
            }
            else if (home)
                hint = this.homeHint(id, home.to);
            else {
                const lowerHome = this.caseHome(id);
                if (!near && lowerHome && !lowerHome.isValue) {
                    // SMA(close, 20): the name in small letters lives in a group (B8-17). Certain when the arguments carry over.
                    hint = `Names are lower case: did you mean \`${lowerHome.to}\`?${lowerHome.sameArgs ? '' : ` ${this.homeHint(id.toLowerCase(), lowerHome.to)}`}`;
                    if (lowerHome.sameArgs)
                        fix = this.fixNode(f.span, lowerHome.to);
                }
                else {
                    hint = near ? `Did you mean \`${near}\`?` : 'Check the spelling. Functions of the standard library are written ta.sma(...), candle.hammer(), and so on.';
                    // A near spelling is a guess, so it is a hint only (B1-10).
                    if (near && sameLetters(near, id))
                        fix = this.fixNode(f.span, near);
                }
            }
            this.err(f.span, 'E-NAME-UNKNOWN', `\`${id}\` is not defined.`, hint, fix);
        }
        this.evalAll(e, scope);
        return ANY;
    }
    /** A habit from Pine Script, refused with what to write here. */
    pine(span, habit, fix) {
        this.err(span, habit.code, habit.message, habit.hint, fix);
    }
    callMember(e, f, scope) {
        const ns = f.value.id;
        const full = `${ns}.${f.attr}`;
        if (ns in RESERVED_NAMESPACES || Object.prototype.hasOwnProperty.call(PLANNED, full) || !fnSpec(full)) {
            this.member(ns, f.attr, f, true, e);
            this.evalAll(e, scope, Object.prototype.hasOwnProperty.call(PLANNED, full));
            return ANY;
        }
        return this.callSpec(e, fnSpec(full), full, scope);
    }
    /** Evaluate every argument for its own errors, when the call itself could not be resolved. */
    evalAll(e, scope, skipLambda = false) {
        for (const a of e.args) {
            if (skipLambda && a.value.kind === 'Lambda')
                continue;
            this.expr(a.value, scope);
        }
    }
    // ---- argument binding
    bind(params, e, label) {
        const bound = new Map();
        const extra = [];
        let i = 0;
        for (const a of e.args) {
            if (a.name === undefined) {
                if (i < params.length)
                    bound.set(params[i++].name, a);
                else {
                    if (extra.length === 0) {
                        this.err(a.span, 'E-ARG-COUNT', `\`${label}\` takes ${params.length === 0 ? 'no values' : params.length === 1 ? 'one value' : `${params.length} values`}${params.length > 0 ? ` (${params.map((p) => p.name).join(', ')})` : ''}, but more were given.`, 'Remove the extra value.');
                    }
                    extra.push(a);
                }
            }
            else {
                const p = params.find((q) => q.name === a.name);
                if (!p) {
                    const names = params.map((q) => q.name);
                    const alias = argAlias(a.name, names);
                    const near = alias ?? suggest(a.name, names);
                    const why = alias ? ` (the ${alias === 'k' || alias === 'mult' ? 'multiplier' : alias === 'src' ? 'series' : 'length'} is called ${alias} in ${label})` : '';
                    this.err(a.span, 'E-ARG-NAME', `\`${label}\` has no argument called \`${a.name}\`.`, near ? `Did you mean \`${near}\`?${why} Its arguments are: ${names.join(', ')}.` : params.length > 0 ? `Its arguments are: ${names.join(', ')}.` : 'It takes no arguments.', near && (alias !== undefined || sameLetters(near, a.name)) ? this.fixAt(a.span, a.span.offset, a.name, near) : undefined);
                    extra.push(a);
                }
                else if (bound.has(a.name)) {
                    this.err(a.span, 'E-ARG-DUP', `\`${a.name}\` is given twice.`, 'Give each argument once.');
                    extra.push(a);
                }
                else
                    bound.set(a.name, a);
            }
        }
        const missing = params.filter((p) => !p.optional && !bound.has(p.name));
        if (missing.length > 0 && extra.length === 0) {
            // plot(x) and show(x): only the label is missing, so the hint shows the call with one (B8-12).
            const onlyLabel = missing.length === 1 && (missing[0].name === 'label' || missing[0].name === 'message') && e.args.length > 0;
            const shown = e.args.map((a) => (a.name !== undefined ? `${a.name}=` : '') + shortText(a.value)).join(', ');
            this.err(e.span, 'E-ARG-COUNT', `\`${label}\` needs ${missing.length === 1 ? 'a value' : 'values'} for ${missing.map((m) => `\`${m.name}\``).join(' and ')}.`, onlyLabel
                ? `Give it a name in quotes, shown in the ${label === 'show' ? 'column heading' : label === 'alert' ? 'alert' : 'legend'}: ${label}(${shown}, "Name").`
                : `Write ${label}(${params.map((p) => (p.optional ? `${p.name}=...` : p.name)).join(', ')}).`);
        }
        return { bound, extra };
    }
    callSpec(e, spec, written, scope) {
        if (Object.prototype.hasOwnProperty.call(PLANNED, spec.name)) {
            this.err(e.func.span, 'E-NOT-YET', `\`${spec.name}\` is not built yet.`, PLANNED[spec.name]);
            this.evalAll(e, scope, true);
            return ANY;
        }
        this.calls.set(e, spec.name);
        const { bound, extra } = this.bind(spec.params, e, spec.name);
        const tys = new Map();
        for (const p of spec.params) {
            const a = bound.get(p.name);
            if (!a)
                continue;
            const ty = p.arg.t === 'list' && a.value.kind === 'ListComp' ? this.listComp(a.value, scope, spec.name, p.arg.of === 'num')
                : p.arg.t === 'list' && a.value.kind === 'List' ? this.listLit(a.value, scope, spec.name, p.arg.of === 'num')
                    : this.expr(a.value, scope);
            tys.set(p.name, ty);
        }
        for (const a of extra)
            this.expr(a.value, scope);
        // Check each argument against its kind.
        let clean = true;
        for (const p of spec.params) {
            const a = bound.get(p.name);
            const ty = tys.get(p.name);
            if (!a || !ty)
                continue;
            if (!this.checkArgKind(p.arg, ty, a.value, spec.name, p.name, undefined))
                clean = false;
        }
        // Data, causality, host rules.
        if (!this.outputRules(spec, e))
            return this.resultOnError(spec);
        if (spec.returns.kind === 'none')
            this.attemptedOutputs.add(spec.name.startsWith('strategy.') ? spec.name.slice(9) : spec.name);
        const reqs = [...spec.requires];
        if (spec.name === 'tf') {
            const code = tys.get('code');
            if (code && code.k === 'scalar' && typeof code.value === 'string' && TF_CODES[code.value])
                reqs.push(TF_CODES[code.value].cap);
        }
        this.use(reqs, spec.name === 'tf' ? `tf(${this.codeText(tys.get('code'))})` : written, e.span);
        this.tagged(spec.name, spec.tag, spec.lag, e.func.span, spec.reason);
        if (!clean)
            return this.resultOnError(spec);
        if ((spec.name === 'max' || spec.name === 'min') && e.args.length === 2)
            this.windowHabit(e, spec.name, spec.params.map((q) => tys.get(q.name)));
        // ind.vwap() on daily candlesticks never starts again, so in a scan, an alert or a backtest it depends on how much history
        // was loaded (B8-20). The chart shows it from the first candlestick drawn, which is what it says.
        if (spec.name === 'ind.vwap' && this.host.id !== 'client-chart') {
            this.warn(e.span, 'W-VWAP-DAILY', 'On daily candlesticks ind.vwap() runs from the first candlestick loaded, so its value depends on how much history is read, not on a session.', 'For a VWAP that starts again each week, month or year write ind.sessionvwap(anchor="week"), "month" or "year".');
        }
        // History functions cannot look back through a value that exists only today.
        if (spec.history) {
            for (const p of spec.params) {
                const t = tys.get(p.name);
                const a = bound.get(p.name);
                if (t && t.k === 'scalar' && t.series && t.snap && a) {
                    this.err(a.value.span, 'E-SNAPSHOT-HISTORY', `\`${spec.name}\` looks back over earlier candlesticks, but this value exists only for the latest one.`, 'Levels, sector and fundamentals are current values. Use a price-based value inside ta.* functions.');
                    return this.resultOnError(spec);
                }
            }
        }
        return this.resultOf(spec, tys, e, bound);
    }
    /**
     * `max(high, 252)` (Chartink's "max(252, high)"): here max of two values is the larger of the two, so this is the high or the
     * number 252, not the highest high of 252 candlesticks. A price compared with a whole number of 2 or more is almost always that
     * habit (2026-10-25, B8-1); max() itself keeps its meaning, and the warning says what to write.
     */
    windowHabit(e, name, argTys = []) {
        const priceLike = (x) => {
            const base = x.kind === 'Subscript' ? x.value : x;
            if (base.kind === 'Name')
                return ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'].includes(base.id);
            return base.kind === 'Attribute' && FRAME_FIELDS.includes(base.attr);
        };
        const [a, b] = e.args.map((x) => x.value);
        const series = priceLike(a) ? a : priceLike(b) ? b : undefined;
        const n = series === a ? b : a;
        if (!series)
            return;
        // a written whole number, or a name that holds one (`n = 252` then `max(high, n)`, V-7 2026-10-25)
        const nTy = argTys[series === a ? 1 : 0];
        const named = n.kind === 'Name' && nTy !== undefined && nTy.k === 'scalar' && !nTy.series && typeof nTy.value === 'number' && Number.isInteger(nTy.value) ? nTy.value : undefined;
        if (named === undefined && (n.kind !== 'Number' || !intLike(n.raw, n.value)))
            return;
        const count = named ?? n.value;
        if (count < 2)
            return;
        const raw = named !== undefined ? n.id : n.raw;
        const fn = name === 'max' ? 'ta.highest' : 'ta.lowest';
        const s = shortText(series);
        this.warn(e.span, 'W-MINMAX-WINDOW', `\`${name}(${shortText(a)}, ${shortText(b)})\` is the ${name === 'max' ? 'larger' : 'smaller'} of ${s} and the number ${raw}, not the ${name === 'max' ? 'highest' : 'lowest'} ${s} of ${raw} candlesticks.`, `For the ${name === 'max' ? 'highest' : 'lowest'} of the last ${raw} candlesticks write ${fn}(${s}, ${raw}); add [1] to leave today out: ${fn}(${s}, ${raw})[1].`);
    }
    codeText(t) {
        return t && t.k === 'scalar' && typeof t.value === 'string' ? JSON.stringify(t.value) : '...';
    }
    resultOnError(spec) {
        return spec.returns.kind === 'none' ? NONE : { ...ANY };
    }
    /** Output helpers: right script type, not in a helper, not under a series if, labels, limits. Returns false when the call is out of place. */
    outputRules(spec, e) {
        const isOutput = spec.returns.kind === 'none';
        if (!isOutput)
            return true;
        const name = spec.name;
        if (this.inHelper > 0) {
            this.err(e.span, 'E-HELPER-OUTPUT', `\`${name}\` cannot be used inside a helper.`, 'Helpers only work out values. Call it from the main function.');
            return false;
        }
        if (!OUTPUTS_BY_KIND[this.kind].includes(name)) {
            const where = name === 'show' ? 'a screener' : name === 'plot' || name === 'mark' || name === 'bgcolor' || name === 'fill' ? 'an indicator' : name === 'alert' ? 'an @alert script' : 'a @strategy script';
            this.err(e.span, 'E-OUTPUT-KIND', `\`${name}\` belongs in ${where}, but this script is ${kindWords(this.kind)}.`, name === 'show' ? 'A screener adds columns with show(). Indicators draw with plot() and mark().' : name === 'plot' || name === 'mark' || name === 'bgcolor' || name === 'fill' ? 'plot() and mark() draw on a chart: start the script with @indicator. In a screener, add a result column with show(value, "Label").' : name === 'alert' ? 'An alert is its own script: @alert(name="My alert") on the first line, def check(): on the next, and alert(condition, "message") inside it, indented by 4 spaces.' : 'A strategy is its own script: @strategy() on the first line, def rules(): on the next, and strategy.entry(condition) and strategy.exit(condition) inside it, indented by 4 spaces.');
            return false;
        }
        if (this.seriesIf > 0) {
            this.err(e.span, 'E-OUTPUT-IN-IF', `\`${name}\` cannot be used inside an if that depends on candlestick values.`, 'Move it outside the if, and put the condition inside its arguments.');
            return false;
        }
        return true;
    }
    recordOutput(spec, e, tys, bound) {
        if (spec.returns.kind !== 'none' || this.inHelper > 0)
            return;
        const name = spec.name;
        const labelName = tys.has('label') ? 'label' : 'message';
        const labelTy = tys.get(labelName);
        const label = labelTy && labelTy.k === 'scalar' && typeof labelTy.value === 'string' ? labelTy.value : undefined;
        const kind = name.startsWith('strategy.') ? name.slice(9) : name;
        if (label !== undefined) {
            const at = bound.get(labelName)?.value.span ?? e.span;
            if (label.length === 0 || charCount(label) > LABEL_MAX_CHARS) {
                this.err(at, 'E-LABEL', `A label must be 1 to ${LABEL_MAX_CHARS} characters.`, 'Shorten the text, or give it some text.');
            }
            const key = `${kind}:${label}`;
            if (this.outputLabels.has(key))
                this.err(e.span, 'E-OUTPUT-DUP', `There are two ${kind === 'alert' ? 'alerts' : kind === 'show' ? 'columns' : 'plots'} called "${label}".`, 'Give each a different label.');
            this.outputLabels.add(key);
        }
        else if (kind === 'take_profit' && this.outputs.some((o) => o.kind === kind)) {
            // Two targets are allowed when exactly one of them is a first target (size_pct=) and the other is not.
            const sized = bound.has('size_pct');
            const before = this.levelArgs.filter((a) => a.kind === 'take_profit');
            if (before.length >= 2 || before.some((a) => a.sized === sized)) {
                this.err(e.span, 'E-OUTPUT-DUP', sized ? 'Only one strategy.take_profit can sell part of the position (size_pct=).' : `\`${name}\` is given twice.`, 'Give at most two targets: one first target with size_pct= (the part it sells) and one without, for the rest.');
            }
        }
        else if (['entry', 'exit', 'rank', 'stop_loss', 'trail'].includes(kind) && this.outputs.some((o) => o.kind === kind)) {
            this.err(e.span, 'E-OUTPUT-DUP', `\`${name}\` is given twice.`, kind === 'entry' || kind === 'exit' ? 'Combine the conditions with and / or in one call.' : 'Give it once.');
        }
        if (kind === 'stop_loss' || kind === 'take_profit')
            this.levelRules(kind, e, tys, bound);
        if (kind === 'plot')
            this.plotRules(tys, bound);
        if (kind === 'fill')
            this.fillArgs(bound);
        if (kind === 'show') {
            this.shows++;
            if (this.shows > MAX_SHOWS)
                this.err(e.span, 'E-SHOW-LIMIT', `A screener can show at most ${MAX_SHOWS} columns.`, 'Remove some show() lines.');
        }
        const info = { kind, line: e.span.line };
        if (label !== undefined)
            info.label = label;
        if (kind === 'leg') {
            const textOf = (n) => { const t = tys.get(n); return t && t.k === 'scalar' && typeof t.value === 'string' ? t.value : undefined; };
            const strike = textOf('strike');
            if (strike !== undefined && parseLegStrike(strike) === null) {
                this.err(bound.get('strike')?.value.span ?? e.span, 'E-LEG-STRIKE', `"${strike}" is not a strike the language can choose.`, 'Write "atm", or "atm+2" / "atm-1" for that many listed strikes above or below the money (up to 20), or "delta=0.25" (absolute delta, 0.05 to 0.95), or "premium=100" (settlement price in rupees, 0.05 to 100000), with at most two decimals.');
            }
            info.leg = { right: textOf('right') ?? '', side: textOf('side') ?? '' };
        }
        this.outputs.push(info);
    }
    /**
     * plot(..., linewidth=, offset=) (2026-10-17): whole numbers written in the script (they are presentation and travel in the program as
     * numbers, not as settings). A negative offset would draw each value on a candlestick before the one it was worked out on, which reads
     * as a value known earlier than it was: refused with its own code. The plain range (1 to 4, at most 500) is the argument kind's.
     */
    plotRules(tys, bound) {
        const series = bound.get('series');
        if (series && series.value.kind === 'Name')
            this.plottedNames.add(series.value.id);
        for (const name of ['linewidth', 'offset']) {
            const ty = tys.get(name);
            const arg = bound.get(name);
            if (!ty || !arg || ty.k !== 'scalar' || ty.series || !isNumeric(ty.base))
                continue;
            if (ty.value === undefined) {
                this.err(arg.value.span, 'E-ARG-CONST', `\`${name}\` of plot must be a number written in the script, not taken from a setting.`, name === 'offset' ? 'Write a whole number of candlesticks such as 2.' : `Write a whole number from 1 to ${PLOT_LINEWIDTH_MAX}.`);
                continue;
            }
            const v = Number(ty.value);
            if (name === 'offset' && v < 0) {
                this.err(arg.value.span, 'E-PLOT-OFFSET', `\`offset\` of plot cannot be negative (${v}): that would draw each value on a candlestick before the one it was worked out on, as if it had been known earlier.`, `Use offset=0 (the default) or a positive whole number of candlesticks (at most ${PLOT_OFFSET_MAX}) to shift the line to the right. To compare with an earlier value, plot x[1] instead.`);
                continue;
            }
            if (!Number.isInteger(v)) {
                this.err(arg.value.span, 'E-ARG-TYPE', `\`${name}\` of plot needs a whole number, but this is ${v}.`, name === 'offset' ? 'Write a whole number of candlesticks such as 2.' : `Write a whole number from 1 to ${PLOT_LINEWIDTH_MAX}.`);
            }
        }
    }
    /** fill(a, b): each side a name the script gives to plot() as its series; checked once the whole script is read (fillRules). */
    fillArgs(bound) {
        const a = bound.get('a');
        const b = bound.get('b');
        for (const side of [a, b]) {
            if (!side)
                continue;
            if (side.value.kind !== 'Name') {
                this.err(side.value.span, 'E-FILL-PLOT', 'fill() fills between two lines the script plots, named the way they were given to plot().', 'Give the line a name and plot it: fast = ta.ema(close, 10), plot(fast, "Fast"), then fill(fast, slow).');
                continue;
            }
            this.fillSides.push({ name: side.value.id, span: side.value.span });
        }
        if (a && b && a.value.kind === 'Name' && b.value.kind === 'Name' && a.value.id === b.value.id) {
            this.err(b.value.span, 'E-FILL-PLOT', `fill() needs two different lines, but both sides are \`${a.value.id}\`.`, 'Name the second line, for example fill(fast, slow).');
        }
    }
    fillRules() {
        for (const side of this.fillSides) {
            if (this.plottedNames.has(side.name))
                continue;
            const near = suggest(side.name, [...this.plottedNames]);
            this.err(side.span, 'E-FILL-PLOT', `\`${side.name}\` is not a line this script plots, so fill() has nothing to fill to.`, near ? `Did you mean \`${near}\`? fill() takes names given to plot(name, "Label").` : `Plot it first, for example plot(${side.name}, "Label"); fill() takes names given to plot().`);
        }
    }
    /**
     * A stop or a target's pct: a fixed number is 0.1 to 100 (as before); a value that changes per candlestick is accepted here and
     * read by the simulator on the signal candlestick (an option strategy refuses it, see `optionStrategyRules`). size_pct= is a number
     * written in the script, not a setting, so the part sold is the same on every run of the script.
     */
    levelRules(kind, e, tys, bound) {
        const pctTy = tys.get('pct');
        const pctArg = bound.get('pct');
        const pctSeries = !!pctTy && pctTy.k === 'scalar' && pctTy.series;
        if (pctTy && pctTy.k === 'scalar' && !pctTy.series && pctArg)
            this.checkArgKind(cnum(0.1, 100), pctTy, pctArg.value, `strategy.${kind}`, 'pct', undefined);
        const sizeTy = tys.get('size_pct');
        const sizeArg = bound.get('size_pct');
        if (sizeTy && sizeTy.k === 'scalar' && !sizeTy.series && sizeTy.value === undefined && sizeArg) {
            this.err(sizeArg.value.span, 'E-ARG-CONST', '`size_pct` of strategy.take_profit must be a number written in the script, not taken from a setting.', 'Write a whole percent such as 50.');
        }
        this.levelArgs.push({ kind, line: e.span.line, pctSpan: pctArg?.value.span ?? null, pctSeries, sized: !!sizeArg, sizeSpan: sizeArg?.value.span ?? null });
    }
    // ---- argument kinds
    /**
     * Check one argument against what the function wants. Returns true when it is acceptable.
     * `codeOverride` replaces the error codes (used by the script-type line).
     */
    checkArgKind(kind, ty, node, fname, pname, codeOverride) {
        const C = (c) => codeOverride ?? c;
        const what = `\`${pname}\` of ${fname}`;
        if (ty.k === 'scalar' && ty.base === 'any')
            return true;
        if (kind.t === 'list') {
            if (ty.k === 'list')
                return true;
            this.err(node.span, C('E-ARG-TYPE'), `${fname}() needs a list, written out like [a, b, c] or like [${kind.of === 'num' ? 'x[i]' : 'cond'} for i in range(3)].`, 'Put the values in square brackets.');
            return false;
        }
        if (ty.k !== 'scalar') {
            this.scalarOf(ty, node, what);
            return false;
        }
        const numeric = isNumeric(ty.base);
        switch (kind.t) {
            case 'num':
                if (!numeric)
                    return this.typeErr(node, C, what, 'a number', ty);
                return true;
            case 'bool':
                if (!isBoolish(ty.base))
                    return this.typeErr(node, C, what, 'a true/false value', ty, ty.base === 'color' && (fname === 'bgcolor' || fname === 'mark') ? `The condition comes first and the colour is named after it: ${fname}(cond, color=color.up).` : undefined);
                return true;
            case 'any':
                if (!numeric && !isBoolish(ty.base))
                    return this.typeErr(node, C, what, 'a number or a true/false value', ty, fname === 'show' && ty.base === 'str' ? 'A column shows a number or true/false, not text. Show a comparison instead, for example show(info.sector == "IT", "IT").' : undefined);
                return true;
            case 'value':
                if (ty.base === 'color')
                    return this.typeErr(node, C, what, 'a number, true/false or text', ty);
                return true;
            case 'color':
                if (ty.base !== 'color')
                    return this.typeErr(node, C, what, 'a colour such as color.up', ty);
                return true;
            case 'group':
                if (ty.base !== 'str')
                    return this.typeErr(node, C, what, 'text for every stock, such as info.sector', ty);
                return true;
            case 'len': {
                if (ty.series) {
                    // A study that takes src= (WP1, 2026-10-17): the series most likely meant to be the price, so say where it goes.
                    const src = fname.startsWith('ind.') && fnSpec(fname)?.params.some((q) => q.name === 'src');
                    this.err(node.span, C('E-ARG-CONST'), `${what} must be a fixed whole number, not a value that changes from candlestick to candlestick.`, src ? `Settings come first and the series goes in src=, for example ${fname}(20, src=close).` : 'Write a number such as 20, or use a setting made with input().');
                    return false;
                }
                if (ty.base !== 'int')
                    return this.typeErr(node, C, what, 'a whole number', ty, ty.base === 'float' ? 'Use a whole number; for whole-number division use //.' : undefined);
                if (ty.lo === undefined || ty.hi === undefined) {
                    this.err(node.span, C('E-ARG-RANGE'), `The size of ${what} is not known.`, `It must be between ${kind.min} and ${kind.max}. Give the setting min= and max=.`);
                    return false;
                }
                if (ty.lo < kind.min || ty.hi > kind.max) {
                    const known = ty.value !== undefined;
                    this.err(node.span, C('E-ARG-RANGE'), known ? `${what} must be between ${kind.min} and ${kind.max}, but it is ${ty.value}.` : `${what} must be between ${kind.min} and ${kind.max}, but this setting can go from ${ty.lo} to ${ty.hi}.`, known ? `Use a value from ${kind.min} to ${kind.max}.` : `Give the setting min=${Math.max(kind.min, ty.lo)} and max=${Math.min(kind.max, ty.hi)}, for example input(${Math.max(kind.min, Math.min(kind.max, 20))}, min=${Math.max(kind.min, ty.lo)}, max=${Math.min(kind.max, ty.hi)}). A whole-number setting without min= and max= can go from 1 to at least 500.`);
                    return false;
                }
                return true;
            }
            case 'cnum': {
                if (ty.series) {
                    this.err(node.span, C('E-ARG-CONST'), `${what} must be a fixed number, not a value that changes from candlestick to candlestick.`, 'Write a number such as 2, or use a setting made with input().');
                    return false;
                }
                if (!numeric)
                    return this.typeErr(node, C, what, 'a number', ty);
                if (kind.min !== undefined || kind.max !== undefined) {
                    const lo = ty.lo;
                    const hi = ty.hi;
                    const minOk = kind.min === undefined || (lo !== undefined && lo >= kind.min);
                    const maxOk = kind.max === undefined || (hi !== undefined && hi <= kind.max);
                    if (!minOk || !maxOk) {
                        const range = kind.min === undefined ? `at most ${kind.max}` : kind.max === undefined ? `from ${kind.min}` : `from ${kind.min} to ${kind.max}`;
                        this.err(node.span, C('E-ARG-RANGE'), ty.value !== undefined ? `${what} must be ${range}, but it is ${ty.value}.` : `${what} must be ${range}, and the range of this setting is not within it.`, ty.value !== undefined ? `Use a value ${range}.` : `Give the setting min= and max= ${range}.`);
                        return false;
                    }
                }
                return true;
            }
            case 'cbool':
                if (ty.series || ty.base !== 'bool')
                    return this.typeErr(node, C, what, 'True or False written in the script', ty);
                return true;
            case 'ctext': {
                if (ty.series || ty.base !== 'str')
                    return this.typeErr(node, C, what, 'text in quotes', ty);
                if (ty.value === undefined) {
                    this.err(node.span, C('E-ARG-CONST'), `${what} must be written in the script, not taken from a setting.`, 'Write the text in quotes.');
                    return false;
                }
                return true;
            }
            case 'choice': {
                if (ty.series || ty.base !== 'str')
                    return this.typeErr(node, C, what, 'text in quotes', ty);
                if (typeof ty.value !== 'string') {
                    this.err(node.span, C('E-ARG-CONST'), `${what} must be written in the script, not taken from a setting.`, `Write one of: ${kind.values.map((v) => `"${v}"`).join(', ')}.`);
                    return false;
                }
                const retired = kind.retired && Object.hasOwn(kind.retired, ty.value) ? kind.retired[ty.value] : undefined;
                if (retired) {
                    this.err(node.span, C('E-ARG-RETIRED'), `"${ty.value}" was retired on ${retired.on}: ${retired.why}.`, retired.instead);
                    return false;
                }
                if (!kind.values.includes(ty.value)) {
                    const near = suggest(ty.value, kind.values);
                    const list = kind.values.length > 12 ? `${kind.values.slice(0, 12).join(', ')}, ...` : kind.values.join(', ');
                    this.err(node.span, C('E-ARG-VALUE'), `"${ty.value}" is not one of the choices for ${what}.`, near ? `Did you mean "${near}"? Choices: ${list}.` : `Choices: ${list}.`, near && node.kind === 'String' && certainChoice(ty.value, kind.values) === near ? this.fixAt(node.span, node.span.offset + 1, ty.value, near) : undefined);
                    return false;
                }
                return true;
            }
        }
    }
    typeErr(node, C, what, wanted, got, hint) {
        const seen = got.value !== undefined && !got.series ? `\`${typeof got.value === 'string' ? JSON.stringify(got.value) : String(got.value)}\`` : words(got);
        this.err(node.span, C('E-ARG-TYPE'), `${what} needs ${wanted}, but this is ${seen}.`, hint ?? defaultTypeHint(wanted, got));
        return false;
    }
    // ---- results of stdlib calls
    resultOf(spec, tys, e, bound) {
        const scalars = [];
        for (const p of spec.params) {
            const t = tys.get(p.name);
            if (t && t.k === 'scalar')
                scalars.push(t);
        }
        const seriesArgs = scalars.filter((t) => t.series);
        const frameOf = () => seriesArgs.reduce((f, t) => finestFrame(f, t.frame), seriesArgs.length > 0 ? seriesArgs[0].frame : 'D');
        const snapAny = scalars.some((t) => t.snap);
        const baseLb = seriesArgs.reduce((m, t) => Math.max(m, t.lb), 0);
        const warm = this.warmup(spec, tys);
        const likeBase = (names) => {
            const bs = (names ?? []).map((n) => tys.get(n)).filter((t) => !!t && t.k === 'scalar').map((t) => t.base);
            if (bs.length === 0)
                return 'float';
            return bs.reduce((a, b) => joinNumeric2(a, b));
        };
        const r = spec.returns;
        const finish = (base) => {
            const frame = frameOf();
            let lb = baseLb + warm * frameWeight(frame);
            if (lb > MAX_LOOKBACK) {
                this.err(e.span, 'E-LOOKBACK', `This needs about ${Math.ceil(lb)} candlesticks of history, but the limit is ${MAX_LOOKBACK}.`, 'Use shorter look-backs, or give settings a smaller max=.');
                lb = MAX_LOOKBACK;
            }
            return { k: 'scalar', base, series: true, frame, snap: snapAny, lb };
        };
        switch (r.kind) {
            case 'none':
                this.recordOutput(spec, e, tys, bound);
                return NONE;
            case 'series': {
                if (spec.name === 'all' || spec.name === 'any' || spec.name === 'sum' || spec.name === 'avg') {
                    const list = tys.get('items');
                    if (!list || list.k !== 'list')
                        return { ...ANY };
                    return { ...list.item, base: spec.name === 'sum' ? list.item.base : spec.name === 'avg' ? 'float' : 'bool' };
                }
                const base = r.base === 'like' ? likeBase(r.like) : r.base;
                if (!spec.history && seriesArgs.length === 0 && spec.params.length > 0) {
                    const out = constant(base);
                    if ((spec.name === 'min' || spec.name === 'max') && scalars.length === 2) {
                        const [a, b] = scalars;
                        if (typeof a.value === 'number' && typeof b.value === 'number') {
                            out.value = spec.name === 'min' ? Math.min(a.value, b.value) : Math.max(a.value, b.value);
                            out.lo = out.value;
                            out.hi = out.value;
                        }
                        else if (a.lo !== undefined && a.hi !== undefined && b.lo !== undefined && b.hi !== undefined) {
                            out.lo = spec.name === 'min' ? Math.min(a.lo, b.lo) : Math.max(a.lo, b.lo);
                            out.hi = spec.name === 'min' ? Math.min(a.hi, b.hi) : Math.max(a.hi, b.hi);
                        }
                    }
                    return out;
                }
                return finish(base);
            }
            case 'snapshot': {
                const s = seriesOf(r.base, 'D', 0, true);
                return { ...s, lb: 0 };
            }
            case 'cross': {
                const mode = this.host.xs;
                const s = finish(r.base);
                // In the screener a cross-section exists for the latest candlestick only.
                return mode === 'panel' ? s : { ...s, snap: true };
            }
            case 'record': {
                const s = finish('float');
                const fields = {};
                for (const [k, b] of Object.entries(r.fields))
                    fields[k] = { ...s, base: b };
                const rec = { k: 'record', label: `${spec.name}(...)`, fields };
                return rec;
            }
            case 'frame': {
                const frame = spec.name === 'tf' ? this.frameFor(tys.get('code')) : 'D';
                const fields = {};
                // A weekly or monthly value needs a whole period and the part one before it, as the plan counts it (ir/plan.ts, B2-5).
                const first = frame === 'W' || frame === 'M' ? 2 * (frame === 'M' ? 23 : frameWeight(frame)) - 2 : 0;
                for (const f of FRAME_FIELDS)
                    fields[f] = seriesOf('float', frame, first, false);
                const label = spec.name === 'tf' ? `tf(${this.codeText(tys.get('code'))})` : `ref(${this.codeText(tys.get('symbol'))})`;
                return { k: 'record', label, fields };
            }
            case 'setting': return { ...ANY }; // input() is checked by setting() and never reaches here
        }
    }
    frameFor(code) {
        if (code && code.k === 'scalar' && typeof code.value === 'string' && TF_CODES[code.value])
            return TF_CODES[code.value].frame;
        return 'D';
    }
    warmup(spec, tys) {
        const w = spec.warmup;
        if (!w)
            return 0;
        let sum = 0;
        for (const t of w.terms ?? []) {
            const ty = tys.get(t);
            if (ty && ty.k === 'scalar')
                sum += ty.hi ?? 0;
            else {
                // An argument left out counts with its default (for example ta.change(x) looks back 1).
                const d = spec.params.find((q) => q.name === t)?.default;
                if (typeof d === 'number')
                    sum += d;
            }
        }
        return Math.max(0, sum * (w.mult ?? 1) + (w.add ?? 0));
    }
    // ---- list comprehension
    listComp(e, scope, owner, numbers = false) {
        const it = e.iter;
        const n = this.rangeCount(it, scope);
        if (n === undefined)
            return { ...ANY };
        if (n > MAX_UNROLL_PER_LOOP) {
            this.err(it.span, 'E-UNROLL-LIMIT', `A list can have at most ${MAX_UNROLL_PER_LOOP} steps, but this has ${n}.`, 'Use ta.count(cond, n) or ta.highest / ta.lowest for longer windows.');
            return { ...ANY };
        }
        if (this.unrolled + n > MAX_UNROLL_TOTAL) {
            this.err(it.span, 'E-UNROLL-LIMIT', `All lists together can have at most ${MAX_UNROLL_TOTAL} steps.`, 'Use fewer or shorter lists.');
            return { ...ANY };
        }
        this.unrolled += n;
        this.expanded += nodeCount(e.elt) * n;
        this.checkExpanded(e.span);
        // The first and the last step show every difference in type, size of index and look-back.
        const picks = n === 1 ? [0] : [0, n - 1];
        let merged = null;
        this.inComp++;
        for (const i of picks) {
            const child = new Scope(scope);
            child.set(e.target.id, { ty: constant('int', i), node: e.target.span, used: true, maybe: false, reportUnused: false });
            const t = this.scalarOf(this.expr(e.elt, child), e.elt, 'an item of the list');
            merged = this.listItem(t, e.elt, owner, numbers, merged);
        }
        this.inComp--;
        if (isReservedName(e.target.id))
            this.err(e.target.span, 'E-NAME-SHADOW', `\`${e.target.id}\` is a built-in name and cannot be used as the list variable.`, 'Use i or j.');
        const item = merged;
        return { k: 'list', n, item: { ...item, value: undefined } };
    }
    /** Check one item of a list and merge it into the list's item type: true/false items, or numbers for min, max, sum and avg. */
    listItem(t, node, owner, numbers, merged) {
        if (numbers) {
            if (!isNumeric(t.base)) {
                this.err(node.span, 'E-LIST-ITEM', `${owner}() needs numbers in its list, but this is ${words(t)}.`, isBoolish(t.base) ? 'For true/false items use all([...]) or any([...]); to count them use ta.count(cond, n).' : 'Use numbers, for example [high[i] - low[i] for i in range(3)].');
                return merged ?? { ...ANY };
            }
            const base = merged ? joinNumeric2(merged.base, t.base) : t.base === 'na' ? 'float' : t.base;
            return merged ? { ...mergeMetaScalar(merged, t), base: base === 'na' ? 'float' : base } : { ...t, base };
        }
        if (!isBoolish(t.base)) {
            this.err(node.span, 'E-LIST-ITEM', `${owner}() needs true/false items, but this is ${words(t)}.`, 'Use a comparison, for example [low[i] > low[i + 3] for i in range(3)].');
        }
        return merged ? { ...mergeMetaScalar(merged, t), base: 'bool' } : { ...t, base: 'bool' };
    }
    /** A list written out, [a, b, c]. Its items are already in the script, so nothing is expanded; the length limit is the one of range(n). */
    listLit(e, scope, owner, numbers) {
        if (e.elts.length > MAX_UNROLL_PER_LOOP) {
            this.err(e.span, 'E-UNROLL-LIMIT', `A list can have at most ${MAX_UNROLL_PER_LOOP} items, but this has ${e.elts.length}.`, 'Use ta.highest / ta.lowest or ta.sma for longer windows.');
            for (const x of e.elts)
                this.expr(x, scope);
            return { ...ANY };
        }
        let merged = null;
        for (const x of e.elts)
            merged = this.listItem(this.scalarOf(this.expr(x, scope), x, 'an item of the list'), x, owner, numbers, merged);
        const item = merged;
        return { k: 'list', n: e.elts.length, item: { ...item, value: undefined } };
    }
    /** min([...]) and max([...]): the list form of min and max (A4). The two-value form goes through the manifest as before. */
    listMinMax(e, id, scope) {
        const spec = fnSpec(id);
        this.calls.set(e, id);
        const arg = e.args[0].value;
        const list = arg.kind === 'List' ? this.listLit(arg, scope, id, true) : this.listComp(arg, scope, id, true);
        this.use(spec.requires, id, e.span);
        this.tagged(id, spec.tag, spec.lag, e.func.span, spec.reason);
        if (list.k !== 'list')
            return { ...ANY };
        return { ...list.item };
    }
    rangeCount(it, scope) {
        if (it.kind !== 'Call' || it.func.kind !== 'Name' || it.func.id !== 'range') {
            this.err(it.span, 'E-RANGE-ARGS', 'A list can only be built over range(n).', 'Write [cond for i in range(3)].');
            return undefined;
        }
        if (it.args.length !== 1 || it.args[0].name !== undefined) {
            this.err(it.span, 'E-RANGE-ARGS', 'range() takes one whole number here.', 'Write range(3).');
            for (const a of it.args)
                this.expr(a.value, scope);
            return undefined;
        }
        const t = this.expr(it.args[0].value, scope);
        if (t.k !== 'scalar' || t.base === 'any')
            return undefined;
        if (t.series || t.base !== 'int') {
            this.err(it.args[0].value.span, 'E-RANGE-CONST', 'range() needs a fixed whole number.', 'Write a number such as range(3).');
            return undefined;
        }
        if (typeof t.value !== 'number') {
            this.err(it.args[0].value.span, 'E-RANGE-CONST', 'range() needs a number written in the script, not a setting, because the list is expanded before the script runs.', 'Write a number such as range(3). To test the last n candlesticks with a setting n, use ta.count(cond, n): for example ta.count(close > close[1], n) == n.');
            return undefined;
        }
        if (t.value < 1) {
            this.err(it.args[0].value.span, 'E-RANGE-VALUE', 'range() must be at least 1 here.', 'Write range(3).');
            return undefined;
        }
        return t.value;
    }
    // ---- helper calls (copied into the script where they are called)
    callHelper(e, def, scope) {
        this.usedHelpers.add(def.name);
        this.calls.set(e, `helper:${def.name}`);
        const params = def.params;
        const { bound, extra } = this.bind(params.map((p) => ({ name: p.name, optional: p.default !== undefined })), e, def.name);
        const tys = params.map((p) => {
            const a = bound.get(p.name);
            if (a)
                return this.expr(a.value, scope);
            // Left out: the default written in the def (A3), worked out where the helper is defined.
            return p.default !== undefined && helperDefaultOk(p.default) ? this.expr(p.default, this.constScope) : { ...ANY };
        });
        for (const a of extra)
            this.expr(a.value, scope);
        const argTys = tys.map((t, i) => {
            const a = bound.get(params[i].name);
            if (t.k === 'none' || t.k === 'list') {
                this.scalarOf(t, a.value, 'an argument');
                return { ...ANY };
            }
            return t;
        });
        if (this.recursive.has(def.name))
            return { ...ANY };
        if (this.inlineStack.length >= MAX_INLINE_DEPTH) {
            this.err(e.span, 'E-HELPER-DEPTH', `Helpers call each other more than ${MAX_INLINE_DEPTH} levels deep.`, 'Flatten the helpers, or merge some of them.');
            return { ...ANY };
        }
        this.helperCalls++;
        this.expanded += this.helperNodes.get(def.name) ?? 0;
        this.checkExpanded(e.span);
        return this.inlineHelper(def, argTys, e, true);
    }
    checkExpanded(span) {
        if (this.expanded > MAX_EXPANDED_NODES && !this.expandedReported) {
            this.expandedReported = true;
            this.err(span, 'E-EXPANSION-LIMIT', `The script becomes too large once helpers and lists are expanded (more than ${MAX_EXPANDED_NODES} parts).`, 'Call helpers fewer times, or use shorter lists.');
        }
    }
    /** Check a helper's body with the given argument types and return the type it gives back. */
    inlineHelper(def, args, call, counted) {
        void counted;
        const scope = new Scope(this.constScope);
        def.params.forEach((p, i) => scope.set(p.name, { ty: args[i] ?? ANY, node: p.span, used: true, maybe: false, reportUnused: false }));
        const savedReturns = this.returns;
        const savedConds = this.condStack;
        const savedIf = this.seriesIf;
        const savedPending = this.pending;
        this.returns = [];
        this.condStack = [];
        this.seriesIf = 0;
        this.pending = new Set();
        this.inHelper++;
        this.inlineStack.push(def.name);
        this.checkBlock(def.body, scope, true, null);
        this.inlineStack.pop();
        this.inHelper--;
        const returns = this.returns;
        this.returns = savedReturns;
        this.condStack = savedConds;
        this.seriesIf = savedIf;
        this.pending = savedPending;
        this.reportUnused(scope);
        if (!alwaysReturns(def.body)) {
            this.err(this.lineSpan(def.defLine), 'E-RETURN-MISSING', returns.length === 0 ? `The helper \`${def.name}\` does not return a value.` : `The helper \`${def.name}\` does not return a value on every path.`, 'End the helper with return, and give every branch of an if (including else) its own return.');
            return { ...ANY };
        }
        if (returns.length === 0)
            return { ...ANY };
        let ty = returns[0].ty;
        for (const r of returns.slice(1)) {
            const j = joinTy(ty, r.ty, false);
            if (!j) {
                this.err(r.node, 'E-RETURN-MISMATCH', `The helper \`${def.name}\` returns ${words(ty)} on one path and ${words(r.ty)} on another.`, 'Every return must give the same kind of value.');
                return { ...ANY };
            }
            ty = j;
        }
        void call;
        return ty;
    }
}
// ---- Free helpers ---------------------------------------------------------------------------------
/**
 * `rng == ta.lowest(rng, 7)`: a value compared with the highest or lowest of a window that holds it is an exact comparison (the
 * extreme is one of the values), so W-FLOAT-EQ does not apply (B8-15).
 */
function windowOfItself(x, w) {
    const call = w.kind === 'Subscript' ? undefined : w;
    if (!call || call.kind !== 'Call' || call.func.kind !== 'Attribute' || call.func.value.kind !== 'Name' || call.func.value.id !== 'ta')
        return false;
    if (!['highest', 'lowest', 'highest_all', 'lowest_all', 'highest_since', 'lowest_since'].includes(call.func.attr) || call.args.length === 0)
        return false;
    return formatExpr(call.args[0].value) === formatExpr(x);
}
/**
 * A call as it can be copied into a script (B1-23): `ind.macd(fast=12, slow=26, signal=9)`. The reference writes optional
 * settings in square brackets, which are list brackets in a script; a hint shows them by name with their defaults, and leaves out
 * an optional setting that has no default.
 */
function callText(f) {
    const args = f.params.filter((p) => !p.optional || p.default !== undefined).map((p) => (p.optional ? `${p.name}=${JSON.stringify(p.default)}` : p.name));
    return `${f.name}(${args.join(', ')})`;
}
/** The same letters apart from capitals: the only "did you mean" that is certain enough for a one-click fix (B1-10). */
function sameLetters(a, b) {
    return a !== b && a.toLowerCase() === b.toLowerCase();
}
/**
 * Argument names other tools use for the same thing (B1-24): Pine's factor= and the multiplier called mult= or k= by different
 * studies here, len= and period= for length. Returns the name this function uses, when it has exactly one of them.
 */
function argAlias(written, names) {
    const groups = [['mult', 'k', 'factor', 'multiplier', 'stdev', 'dev', 'std'], ['length', 'period', 'len', 'n', 'window', 'lookback'], ['src', 'source', 'series']];
    for (const g of groups) {
        if (!g.includes(written))
            continue;
        const have = names.filter((n) => g.includes(n) && n !== written);
        if (have.length === 1)
            return have[0];
    }
    return undefined;
}
function cap1(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function kindName(k) {
    return k === 'bare-screener' ? 'a one-line screener' : k === 'bare-indicator' ? 'a bare indicator' : `@${k}`;
}
function exprName(e) {
    return e.kind === 'Name' ? e.id : 'x';
}
/** The expression as written in the canonical style, cut short for messages. */
function shortText(e) {
    const t = formatExpr(e);
    return t.length > 50 ? `${t.slice(0, 47)}...` : t;
}
function defaultTypeHint(wanted, got) {
    if (wanted.startsWith('a number') && got.base === 'bool')
        return 'A true/false value is not a number. Use ta.count(cond, n) to count how often it was true.';
    if (wanted.startsWith('a true/false') && isNumeric(got.base))
        return 'Add a comparison, for example x > 0.';
    if (wanted.startsWith('text'))
        return 'Write the text in quotes, like "support".';
    return `Give ${wanted}.`;
}
function joinNumeric2(a, b) {
    if (a === 'any' || b === 'any')
        return 'any';
    if (a === 'na')
        return b;
    if (b === 'na')
        return a;
    return a === 'int' && b === 'int' ? 'int' : 'float';
}
function mergeMeta(a, b) {
    const series = a.series || b.series;
    const frame = a.series && b.series ? finestFrame(a.frame, b.frame) : a.series ? a.frame : b.series ? b.frame : 'D';
    return { series, frame, snap: a.snap || b.snap, lb: Math.max(a.lb, b.lb) };
}
function mergeMetaScalar(a, b) {
    return { ...a, ...mergeMeta(a, b) };
}
function seriesOrConst(base, like) {
    return { k: 'scalar', base, series: like.series, frame: like.frame, snap: like.snap, lb: like.lb };
}
/** Does every path through the block end in a return? */
function alwaysReturns(stmts) {
    // A return that is not last is reported on its own (E-RETURN-EARLY); it still ends the path.
    return stmts.some((s) => s.kind === 'Return' || (s.kind === 'If' && s.orelse.length > 0 && alwaysReturns(s.body) && alwaysReturns(s.orelse)));
}
// ---- Public functions ---------------------------------------------------------------------------------
function fromScriptError(e) {
    return errorToDiagnostic(e);
}
function finish(diags, script, omitted) {
    const errors = diags.filter((d) => d.severity === 'error');
    const warnings = diags.filter((d) => d.severity === 'warning');
    return { ok: errors.length === 0, script, diagnostics: diags, errors, warnings, omitted };
}
/** Check a parsed script. Never throws. */
export function check(module, source, options = {}) {
    const c = new Checker(source);
    c.hostOption = options.host;
    c.stagesOption = options.stages;
    let script = null;
    try {
        script = c.run(module);
    }
    catch (err) {
        // A bug in the checker. Reported as a problem so the caller still gets an answer.
        c.err(module.span, 'E-INTERNAL', 'The checker could not finish this script.', `Please report it. (${err instanceof Error ? err.message : 'unknown error'})`);
    }
    c.diags.sort((a, b) => a.offset - b.offset || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    return finish(c.diags, script, c.omitted);
}
/**
 * Read and check a script in one call. Syntax problems come back as the one error (compileSource, which editors and hosts use,
 * looks for up to 5). Never throws.
 */
export function checkSource(source, options = {}) {
    const r = tryParse(source);
    if (r.error)
        return finish([fromScriptError(r.error)], null, 0);
    return check(r.module, source, options);
}
