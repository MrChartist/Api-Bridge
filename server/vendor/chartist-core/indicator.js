import { run } from './runtime/run.js';
const MARK_SHAPE_SET = new Set(['dot', 'triangle_up', 'triangle_down', 'square', 'diamond']);
/** At most this many characters in `mark(text=...)`: a marker's text sits beside one candlestick. */
export const MAX_MARK_TEXT_CHARS = 12;
const COLOR_SET = new Set(['up', 'down', 'neutral', 'blue', 'teal', 'amber', 'gray']);
/** Colour code per candlestick in `IndicatorColumn.colors`. The first three are unchanged since S21; B7 added 2 to 5. */
export const COLOR_CODE = Object.freeze({ up: 1, down: -1, neutral: 0, blue: 2, teal: 3, amber: 4, gray: 5 });
/** The colour a code in `IndicatorColumn.colors` stands for, or null for NaN or a code that is not one. */
export function colorOfCode(code) {
    for (const [name, c] of Object.entries(COLOR_CODE))
        if (c === code)
            return name;
    return null;
}
export const MAX_INDICATOR_PLOTS = 8;
/** At most this many backgrounds and fills together in one indicator. */
export const MAX_INDICATOR_FILLS = 4;
/** The first `plot` (not a marker) whose series is node `ref`, as its index among the plots and marks, or -1. */
function plotIndexOf(program, ref) {
    if (ref === undefined)
        return -1;
    let k = 0;
    for (const o of program.outputs) {
        if (o.kind !== 'plot' && o.kind !== 'mark')
            continue;
        if (o.kind === 'plot' && o.value === ref)
            return k;
        k++;
    }
    return -1;
}
/** Why a compiled script cannot be drawn as a chart indicator, or null when it can. */
export function indicatorProblem(compiled) {
    if (compiled.program.kind !== 'indicator' && compiled.program.kind !== 'bare-indicator')
        return 'Only a script that starts with @indicator (or one that only plots) can be drawn on the chart.';
    const drawn = compiled.program.outputs.filter((o) => o.kind === 'plot' || o.kind === 'mark');
    const tints = compiled.program.outputs.filter((o) => o.kind === 'bgcolor' || o.kind === 'fill');
    if (drawn.length === 0 && !tints.some((o) => o.kind === 'bgcolor'))
        return 'The script draws nothing: add a plot(...) or a mark(...).';
    if (drawn.length > MAX_INDICATOR_PLOTS)
        return `A chart indicator can draw at most ${MAX_INDICATOR_PLOTS} lines or markers; this one draws ${drawn.length}.`;
    if (tints.length > MAX_INDICATOR_FILLS)
        return `A chart indicator can have at most ${MAX_INDICATOR_FILLS} backgrounds and fills together; this one has ${tints.length}.`;
    for (const o of tints) {
        if (o.kind !== 'fill')
            continue;
        const a = plotIndexOf(compiled.program, o.value);
        const b = plotIndexOf(compiled.program, o.other);
        if (a < 0 || b < 0)
            return 'fill(a, b) must name two lines the script plots: each side is a name given to plot(name, "Label"), and keeps that value.';
        if (a === b)
            return 'fill(a, b) needs two different lines.';
    }
    for (const o of drawn) {
        if (o.kind !== 'mark' || o.label === undefined)
            continue;
        const text = plainMarkText(o.label);
        if (text.length === 0)
            return 'A mark\'s text cannot be empty: give it a word, or leave text= out.';
        if (text.length > MAX_MARK_TEXT_CHARS)
            return `A mark's text can have at most ${MAX_MARK_TEXT_CHARS} characters; "${text.slice(0, 20)}" has ${text.length}.`;
    }
    return null;
}
/** A mark's text as drawn: no control characters, single spaces, trimmed. */
export function plainMarkText(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
const fixedColor = (program, ref) => {
    const n = program.nodes[ref];
    return n && n.op === 'const' && typeof n.value === 'string' && COLOR_SET.has(n.value) ? n.value : null;
};
/** The node that decides a `by-bar` colour (its condition), or null. */
function colorCondition(program, ref) {
    if (ref === undefined)
        return null;
    const n = program.nodes[ref];
    return n && n.op === 'select' && fixedColor(program, n.a) && fixedColor(program, n.b) ? n.cond : null;
}
function plotColor(program, ref) {
    if (ref === undefined)
        return undefined;
    const fixed = fixedColor(program, ref);
    if (fixed)
        return { kind: 'fixed', color: fixed };
    const n = program.nodes[ref];
    if (n && n.op === 'select') {
        const a = fixedColor(program, n.a);
        const b = fixedColor(program, n.b);
        if (a && b)
            return { kind: 'by-bar', whenTrue: a, whenFalse: b };
    }
    return { kind: 'other' };
}
export function describeIndicator(compiled) {
    const program = compiled.program;
    const plots = [];
    const backgrounds = [];
    const fills = [];
    program.outputs.forEach((o, output) => {
        const color = plotColor(program, o.color);
        const withColor = color ? { color } : {};
        if (o.kind === 'bgcolor') {
            backgrounds.push({ key: `b${backgrounds.length + 1}`, output, ...withColor });
            return;
        }
        if (o.kind !== 'plot' && o.kind !== 'mark')
            return;
        const n = plots.length + 1;
        if (o.kind === 'mark') {
            const text = o.label === undefined ? '' : plainMarkText(o.label).slice(0, MAX_MARK_TEXT_CHARS);
            const shape = o.shape !== undefined && MARK_SHAPE_SET.has(o.shape) ? o.shape : 'dot';
            plots.push({ key: `p${n}`, label: text || `Mark ${n}`, style: 'markers', where: o.where === 'below' ? 'below' : 'above', shape, ...(text ? { text } : {}), output, ...withColor });
        }
        else {
            const v = program.nodes[o.value];
            const level = o.style !== 'histogram' && v?.op === 'const' && typeof v.value === 'number' && Number.isFinite(v.value) ? { level: v.value } : {};
            const style = o.style === 'histogram' ? 'hist' : o.style === 'area' ? 'area' : o.style === 'step' ? 'step' : 'line';
            const width = o.width !== undefined ? { width: o.width } : {};
            const offset = o.offset !== undefined && o.offset > 0 ? { offset: o.offset } : {};
            plots.push({ key: `p${n}`, label: o.label ?? `Plot ${n}`, style, output, ...withColor, ...level, ...width, ...offset });
        }
    });
    // Fills name plots that may come later in the script, so they are matched once every plot has its key.
    program.outputs.forEach((o, output) => {
        if (o.kind !== 'fill')
            return;
        const a = plotIndexOf(program, o.value);
        const b = plotIndexOf(program, o.other);
        // A fill whose sides are not two different plotted lines is refused by indicatorProblem; it is left out here.
        if (a < 0 || b < 0 || a === b)
            return;
        const color = plotColor(program, o.color);
        fills.push({ key: `f${fills.length + 1}`, between: [plots[a].key, plots[b].key], output, ...(color ? { color } : {}) });
    });
    const name = typeof program.meta.name === 'string' && program.meta.name.trim() !== '' ? program.meta.name.trim().slice(0, 40) : 'Script';
    return { name, overlay: program.meta.overlay === true, inputs: program.inputs, plots, backgrounds, fills };
}
/**
 * The columns of an indicator over candlesticks. A plot switched off by a setting is a column of NaN. A marker column holds the
 * high (above) or the low (below) of the candlestick where the condition is true. A background column is 1 where its condition is
 * true; a fill column is 1 where both of its lines have a value. Throws what `run` throws (a bad setting, a budget that ran out,
 * data the script needs but the chart has not).
 */
export function runIndicator(compiled, daily, options = {}) {
    const problem = indicatorProblem(compiled);
    if (problem)
        throw new RangeError(problem);
    const description = describeIndicator(compiled);
    // A `by-bar` colour's condition is not an output of the script, so the runtime would not work it out: it is added as an extra output
    // (presentation only; the script's own outputs, their order and the IR hash are unchanged).
    const program = compiled.program;
    const extra = new Map();
    const outputs = [...program.outputs];
    for (const item of [...description.plots, ...description.backgrounds, ...description.fills]) {
        if (item.color?.kind !== 'by-bar')
            continue;
        const cond = colorCondition(program, program.outputs[item.output].color);
        if (cond === null)
            continue;
        extra.set(item.output, outputs.length);
        outputs.push({ kind: 'show', value: cond });
    }
    const result = run(extra.size ? { ...compiled, program: { ...program, outputs } } : compiled, daily, options);
    const n = daily.date.length;
    const byOutput = new Map(result.outputs.map((o) => [o.index, o]));
    const condOf = (output) => (extra.has(output) ? byOutput.get(extra.get(output)) : undefined);
    const plotColumns = description.plots.map((plot) => {
        const colors = colorsOf(plot, condOf(plot.output), n);
        const out = byOutput.get(plot.output);
        const values = new Float64Array(n).fill(Number.NaN);
        if (out) {
            if (plot.style === 'markers') {
                const level = plot.where === 'below' ? daily.low : daily.high;
                for (let i = 0; i < n; i++)
                    if (out.values[i] === 1)
                        values[i] = level[i];
            }
            else {
                for (let i = 0; i < n; i++)
                    values[i] = Number.isFinite(out.values[i]) ? out.values[i] : Number.NaN;
            }
        }
        // offset=N: the value worked out on candlestick i is drawn on candlestick i + N, never earlier (the checker refuses a negative N).
        const by = plot.offset ?? 0;
        return colors ? { key: plot.key, values: shifted(values, by), colors: shifted(colors, by) } : { key: plot.key, values: shifted(values, by) };
    });
    const byKey = new Map(plotColumns.map((c) => [c.key, c.values]));
    // A background: 1 on the candlesticks where its condition is true, NaN elsewhere (false and unknown give no tint).
    const backgroundColumns = description.backgrounds.map((bg) => {
        const out = byOutput.get(bg.output);
        const values = new Float64Array(n).fill(Number.NaN);
        if (out)
            for (let i = 0; i < n; i++)
                if (out.values[i] === 1)
                    values[i] = 1;
        const colors = colorsOf(bg, condOf(bg.output), n);
        return colors ? { key: bg.key, values, colors } : { key: bg.key, values };
    });
    // A fill: 1 where both of its lines (as drawn, offsets included) have a value, NaN elsewhere; NaN throughout when switched off.
    const fillColumns = description.fills.map((fill) => {
        const values = new Float64Array(n).fill(Number.NaN);
        const a = byKey.get(fill.between[0]);
        const b = byKey.get(fill.between[1]);
        if (a && b && byOutput.has(fill.output))
            for (let i = 0; i < n; i++)
                if (Number.isFinite(a[i]) && Number.isFinite(b[i]))
                    values[i] = 1;
        const colors = colorsOf(fill, condOf(fill.output), n);
        return colors ? { key: fill.key, values, colors } : { key: fill.key, values };
    });
    return [...plotColumns, ...backgroundColumns, ...fillColumns];
}
/** `values` moved `by` places to the right: the first `by` are NaN and the last `by` fall off the end. */
function shifted(values, by) {
    if (by <= 0)
        return values;
    const out = new Float64Array(values.length).fill(Number.NaN);
    for (let i = by; i < values.length; i++)
        out[i] = values[i - by];
    return out;
}
function colorsOf(item, cond, n) {
    if (item.color?.kind !== 'by-bar' || !cond)
        return undefined;
    const yes = COLOR_CODE[item.color.whenTrue];
    const no = COLOR_CODE[item.color.whenFalse];
    const out = new Float64Array(n).fill(Number.NaN);
    for (let i = 0; i < n; i++)
        out[i] = cond.values[i] === 1 ? yes : cond.values[i] === 0 ? no : Number.NaN;
    return out;
}
