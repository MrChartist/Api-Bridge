import { tryParse } from './lang/parser.js';
/** Most parts explained for one script; a longer condition explains the first ones and says so. */
export const MAX_EXPLAIN_CLAUSES = 12;
const CONSTANT_KINDS = new Set(['Number', 'String', 'Bool']);
/** A value written in the script: a number (with its sign, `-1`), text or True/False (B8-9: `-1` was shown as a column). */
const isConstant = (e) => CONSTANT_KINDS.has(e.kind) || (e.kind === 'Unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'Number');
function isShowCall(s) {
    if (s.kind !== 'ExprStmt')
        return false;
    const v = s.value;
    return v.kind === 'Call' && v.func.kind === 'Name' && v.func.id === 'show';
}
/** Every Return anywhere under these statements. */
function returnsIn(stmts) {
    const out = [];
    const walk = (list) => {
        for (const s of list) {
            if (s.kind === 'Return')
                out.push(s);
            else if (s.kind === 'If') {
                walk(s.body);
                walk(s.orelse);
            }
        }
    };
    walk(stmts);
    return out;
}
function locate(module, source) {
    const entries = module.body.filter((s) => s.kind === 'FunctionDef' && s.decorators.length > 0);
    if (entries.length > 1)
        return { reason: 'The script has more than one script-type function.' };
    const entry = entries[0];
    let body;
    let result;
    let expr;
    if (entry) {
        if (entry.decorators.length !== 1 || entry.decorators[0].name !== 'screener')
            return { reason: 'Only a screener can be explained.' };
        body = entry.body;
        result = body[body.length - 1];
        if (!result || result.kind !== 'Return')
            return { reason: 'The function must end with a return of its condition.' };
        const returns = returnsIn(body);
        if (returns.length !== 1)
            return { reason: 'A script with several returns cannot be explained yet.' };
        expr = result.value;
    }
    else {
        body = module.body.filter((s) => s.kind !== 'FunctionDef');
        result = body[body.length - 1];
        if (!result || result.kind !== 'ExprStmt')
            return { reason: 'The script must end with its condition.' };
        expr = result.value;
    }
    const lineStart = source.lastIndexOf('\n', result.span.offset - 1) + 1;
    const indent = source.slice(lineStart, result.span.offset);
    return { body, result, expr, indent: /^[ \t]*$/.test(indent) ? indent : '' };
}
const operand = (source, e) => ({ text: source.slice(e.span.offset, e.span.end), constant: isConstant(e) });
/**
 * The part as written, without brackets that wrap all of it: a bracketed part has a span that includes its brackets. Returns the
 * text and the offset where it starts. Text in quotes is skipped when matching, so `(f("("))` is read right.
 */
function unwrap(source, start, end) {
    let a = start;
    let b = end;
    for (;;) {
        if (source[a] !== '(' || source[b - 1] !== ')')
            break;
        let depth = 0;
        let quote = '';
        let wraps = true;
        for (let i = a; i < b; i++) {
            const ch = source[i];
            if (quote) {
                if (ch === '\\')
                    i++;
                else if (ch === quote)
                    quote = '';
                continue;
            }
            if (ch === '"' || ch === "'")
                quote = ch;
            else if (ch === '(')
                depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0 && i < b - 1) {
                    wraps = false;
                    break;
                }
            }
        }
        if (!wraps)
            break;
        a++;
        b--;
        while (a < b && /\s/.test(source[a]))
            a++;
        while (b > a && /\s/.test(source[b - 1]))
            b--;
    }
    return { text: source.slice(a, b), offset: a };
}
/** 1-based line and column of an offset. */
function lineCol(source, offset) {
    const before = source.slice(0, offset);
    const line = before.split('\n').length;
    return { line, col: offset - (before.lastIndexOf('\n') + 1) + 1 };
}
function clausesOf(expr) {
    return expr.kind === 'BoolOp' ? { joiner: expr.op, parts: expr.values } : { joiner: null, parts: [expr] };
}
function compareOf(source, e) {
    if (e.kind !== 'Compare')
        return undefined;
    const c = e;
    if (c.ops.length !== 1)
        return undefined;
    return { left: operand(source, c.left), op: c.ops[0], right: operand(source, c.comparators[0]) };
}
/** Split the condition a screener returns into its top-level parts. */
export function explainClauses(source) {
    const parsed = tryParse(source);
    if (parsed.error || !parsed.module)
        return { ok: false, reason: 'The script does not read yet.' };
    const where = locate(parsed.module, source);
    if ('reason' in where)
        return { ok: false, reason: where.reason };
    const { joiner, parts } = clausesOf(where.expr);
    const clauses = parts.slice(0, MAX_EXPLAIN_CLAUSES).map((e, index) => {
        const compare = compareOf(source, e);
        const { text, offset } = unwrap(source, e.span.offset, e.span.end);
        const { line, col } = lineCol(source, offset);
        return { index, text, line, col, ...(compare ? { compare } : {}) };
    });
    return { ok: true, joiner, clauses, truncated: parts.length > MAX_EXPLAIN_CLAUSES };
}
/** Labels of the columns `explainSource` adds. Fixed, so the host can find them by name. */
export const EXPLAIN_LEFT = 'explain left';
export const EXPLAIN_RIGHT = 'explain right';
/**
 * The script as it must be run to see one part: the same settings, the same lines before the result (the `show()` lines
 * are left out, they are only for display), then the two sides of a comparison as columns, then the part itself as the
 * condition. Null when the script cannot be explained or the part does not exist.
 */
export function explainSource(source, clauseIndex) {
    const parsed = tryParse(source);
    if (parsed.error || !parsed.module)
        return null;
    const where = locate(parsed.module, source);
    if ('reason' in where)
        return null;
    const { parts } = clausesOf(where.expr);
    if (!Number.isInteger(clauseIndex) || clauseIndex < 0 || clauseIndex >= Math.min(parts.length, MAX_EXPLAIN_CLAUSES))
        return null;
    const part = parts[clauseIndex];
    // Everything before the result, with each show() line replaced by `pass` (same indentation, same place).
    let head = '';
    let at = 0;
    const resultStart = where.result.span.offset;
    const shows = where.body.filter((s) => s !== where.result && isShowCall(s));
    for (const s of shows) {
        head += source.slice(at, s.span.offset) + 'pass';
        at = s.span.end;
    }
    head += source.slice(at, resultStart);
    const compare = compareOf(source, part);
    let tail = '';
    if (compare && !compare.left.constant)
        tail += `show((${compare.left.text}), "${EXPLAIN_LEFT}")\n${where.indent}`;
    if (compare && !compare.right.constant)
        tail += `show((${compare.right.text}), "${EXPLAIN_RIGHT}")\n${where.indent}`;
    const text = unwrap(source, part.span.offset, part.span.end).text;
    const isReturn = where.result.kind === 'Return';
    return `${head}${tail}${isReturn ? 'return ' : ''}(${text})\n`;
}
/** Most value columns added to a screener that shows none of its own (`autoShowSource`). */
export const MAX_AUTO_COLUMNS = 6;
/** Longest label of an added column; a longer expression is cut and ends with an ellipsis. */
const MAX_AUTO_LABEL = 40;
const CROSS_CALLS = new Set(['ta.crossover', 'ta.crossunder', 'ta.cross']);
function dottedName(e) {
    if (e.kind === 'Name')
        return e.id;
    if (e.kind === 'Attribute') {
        const base = dottedName(e.value);
        return base === null ? null : `${base}.${e.attr}`;
    }
    return null;
}
/**
 * A screener that shows no values of its own, with the values its condition compares added as columns, so a result explains
 * itself: `ta.rsi(close, 14) < 30` gets a column "ta.rsi(close, 14)". Taken from the top-level parts of the condition: both
 * sides of a comparison and the two series of `ta.crossover` / `ta.crossunder` / `ta.cross`, each once, written ones (numbers)
 * left out, at most MAX_AUTO_COLUMNS. The `show()` lines are written just before the condition, which is not changed, so the
 * script matches exactly the stocks it matched before. Null when the script already shows something, cannot be split (see
 * `explainClauses`), or compares nothing that could be shown. The host compiles what this writes and falls back to the script
 * as written if it does not compile (a side that is a true/false value, for example). Added 2026-10-25 (slice 3).
 */
export function autoShowSource(source) {
    const parsed = tryParse(source);
    if (parsed.error || !parsed.module)
        return null;
    const where = locate(parsed.module, source);
    if ('reason' in where)
        return null;
    // A script that chose its own columns keeps them.
    const anyShow = (list) => list.some((s) => isShowCall(s) || (s.kind === 'If' && (anyShow(s.body) || anyShow(s.orelse))));
    if (anyShow(where.body) || anyShow(parsed.module.body))
        return null;
    const { parts } = clausesOf(where.expr);
    const texts = [];
    const add = (e) => {
        if (isConstant(e))
            return;
        const t = unwrap(source, e.span.offset, e.span.end).text.trim();
        if (t !== '' && !texts.includes(t))
            texts.push(t);
    };
    for (const part of parts.slice(0, MAX_EXPLAIN_CLAUSES)) {
        const inner = part.kind === 'Unary' && part.op === 'not' ? part.operand : part;
        if (inner.kind === 'Compare') {
            add(inner.left);
            for (const c of inner.comparators)
                add(c);
        }
        else if (inner.kind === 'Call' && CROSS_CALLS.has(dottedName(inner.func) ?? '')) {
            for (const a of inner.args.slice(0, 2))
                if (!a.name)
                    add(a.value);
        }
    }
    const shown = texts.slice(0, MAX_AUTO_COLUMNS);
    if (shown.length === 0)
        return null;
    const labelOf = (t) => {
        const one = t.replace(/\s+/g, ' ').replace(/\\/g, '/').replace(/"/g, "'");
        return one.length > MAX_AUTO_LABEL ? `${one.slice(0, MAX_AUTO_LABEL - 1).trimEnd()}…` : one;
    };
    const labels = shown.map(labelOf);
    const at = where.result.span.offset;
    const lines = shown.map((t, i) => `show((${t}), "${labels[i]}")\n${where.indent}`).join('');
    return { source: `${source.slice(0, at)}${lines}${source.slice(at)}`, labels };
}
// ---- A screener drawn on a chart ------------------------------------------------------------------------------------------------
/** The text beside each marker `screenerChartSource` draws (at most MAX_MARK_TEXT_CHARS). */
export const SCREENER_MARK_TEXT = 'Match';
/** Longest name the written indicator gets (the chart's legend; `describeIndicator` keeps 40). */
const MAX_CHART_NAME = 40;
/** `source[start, end)` with the edits that fall inside it applied (edits never overlap). */
function applyEdits(source, edits, start = 0, end = source.length) {
    let out = '';
    let at = start;
    for (const e of [...edits].sort((a, b) => a.start - b.start)) {
        if (e.start < start || e.end > end)
            continue;
        out += source.slice(at, e.start) + e.text;
        at = e.end;
    }
    return out + source.slice(at, end);
}
/** A setting's value written as the language writes it, or null when it does not suit the value written there now. */
function literalFor(v, written) {
    const numeric = written.kind === 'Number' || (written.kind === 'Unary' && (written.op === '-' || written.op === '+') && written.operand.kind === 'Number');
    if (typeof v === 'number')
        return numeric && Number.isFinite(v) ? String(v) : null;
    if (typeof v === 'boolean')
        return written.kind === 'Bool' ? (v ? 'True' : 'False') : null;
    return written.kind === 'String' ? JSON.stringify(v) : null;
}
/** The edit that writes a setting's run value over its default (`input(20)` -> `input(50)`), or null. */
function inputEdit(def, value) {
    if (value === undefined || !def || def.kind !== 'Call' || def.func.kind !== 'Name' || def.func.id !== 'input')
        return null;
    const first = def.args[0];
    if (!first || first.name)
        return null;
    const text = literalFor(value, first.value);
    return text === null ? null : { start: first.value.span.offset, end: first.value.span.end, text };
}
/** Every `show(...)` statement under these statements, at any depth. */
function showsIn(stmts) {
    const out = [];
    for (const s of stmts) {
        if (isShowCall(s))
            out.push(s);
        else if (s.kind === 'If')
            out.push(...showsIn(s.body), ...showsIn(s.orelse));
    }
    return out;
}
/** A name for the indicator, as plain text that sits inside double quotes. */
function chartName(name) {
    const base = (name ?? '').replace(/\s+/g, ' ').replace(/\\/g, '/').replace(/"/g, "'").trim() || 'Screener';
    const suffix = ' matches';
    return base.length + suffix.length > MAX_CHART_NAME ? `${base.slice(0, MAX_CHART_NAME - suffix.length - 1).trimEnd()}…${suffix}` : `${base}${suffix}`;
}
/**
 * A screener written as a chart indicator that marks every candlestick where its condition is true, so a person can see on the
 * chart of one stock where (and how often) the scan would have matched. Pure text work on the syntax tree, like `explainSource`:
 * the same settings and the same lines, the `show()` lines left out (`pass` in their place), and the returned condition as
 * `mark(condition, ...)` under the candlestick. The type line becomes `@indicator(name="<name> matches", overlay=True)` (a
 * `benchmark=` is kept); a script without `def` is put inside one, its settings as the function's parameters. With `inputs`,
 * the settings a scan ran with become the defaults, so the marks are that run's. The host compiles what this writes for the
 * chart: a name the chart cannot work out per candlestick (the nightly levels, fundamentals, a comparison across stocks) is
 * refused there, in the checker's own words. Added 2026-10-25.
 */
export function screenerChartSource(source, options = {}) {
    const parsed = tryParse(source);
    if (parsed.error || !parsed.module)
        return { ok: false, reason: 'The script does not read yet.' };
    const module = parsed.module;
    const entries = module.body.filter((s) => s.kind === 'FunctionDef' && s.decorators.length > 0);
    if (entries.some((e) => e.decorators.some((d) => d.name !== 'screener')))
        return { ok: false, reason: 'Only a screener can be shown on the chart as matches.' };
    const where = locate(module, source);
    if ('reason' in where) {
        return { ok: false, reason: /several returns/.test(where.reason) ? 'A screener with several returns cannot be shown on the chart yet: end it with one return of its condition.' : where.reason };
    }
    const name = chartName(options.name);
    const inputs = options.inputs ?? {};
    const own = (k) => Object.prototype.hasOwnProperty.call(inputs, k);
    const cond = unwrap(source, where.expr.span.offset, where.expr.span.end).text;
    const edits = showsIn(where.body).map((s) => ({ start: s.span.offset, end: s.span.end, text: 'pass' }));
    edits.push({ start: where.result.span.offset, end: where.result.span.end, text: `mark((${cond}), shape="triangle_up", where="below", color=color.blue, text="${SCREENER_MARK_TEXT}")` });
    const entry = entries[0];
    if (entry) {
        const deco = entry.decorators[0];
        const bench = deco.args?.find((a) => a.name === 'benchmark');
        const benchText = bench ? `, benchmark=${source.slice(bench.value.span.offset, bench.value.span.end)}` : '';
        // The decorator's text from its '@' to its end, whatever its span starts on.
        const at = source.lastIndexOf('@', deco.span.offset);
        edits.push({ start: at >= 0 && at >= source.lastIndexOf('\n', deco.span.offset) ? at : deco.span.offset, end: deco.span.end, text: `@indicator(name="${name}", overlay=True${benchText})` });
        for (const p of entry.params) {
            const e = own(p.name) ? inputEdit(p.default, inputs[p.name]) : null;
            if (e)
                edits.push(e);
        }
        const text = applyEdits(source, edits);
        return { ok: true, source: text.endsWith('\n') ? text : `${text}\n`, name };
    }
    // No `def`: settings (`n = input(20)`) become the parameters of a function that holds the other lines; helpers stay outside.
    const params = [];
    const helpers = [];
    const lines = [];
    for (const s of module.body) {
        if (s.kind === 'FunctionDef') {
            helpers.push(applyEdits(source, edits, s.span.offset, s.span.end));
            continue;
        }
        if (s.kind === 'Assign' && s.value.kind === 'Call' && s.value.func.kind === 'Name' && s.value.func.id === 'input' && s.targets.length === 1) {
            const target = s.targets[0].id;
            const e = own(target) ? inputEdit(s.value, inputs[target]) : null;
            params.push(`${target}=${applyEdits(source, e ? [e] : [], s.value.span.offset, s.value.span.end)}`);
            continue;
        }
        const text = applyEdits(source, edits, s.span.offset, s.span.end);
        lines.push(text.split('\n').map((l) => (l.trim() === '' ? l : `    ${l}`)).join('\n'));
    }
    const head = helpers.length ? `${helpers.join('\n\n')}\n\n` : '';
    return { ok: true, source: `${head}@indicator(name="${name}", overlay=True)\ndef matches(${params.join(', ')}):\n${lines.join('\n')}\n`, name };
}
