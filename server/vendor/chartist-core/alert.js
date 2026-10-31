import { compile } from './compile.js';
import { runIndicator } from './indicator.js';
import { tryParse } from './lang/parser.js';
import { run } from './runtime/run.js';
export const MAX_ALERT_CONDITIONS = 4;
export const MAX_ALERT_MESSAGE_CHARS = 120;
/** At most this many of the script's own numbers across all the messages of one alert script. */
export const MAX_ALERT_VALUES = 4;
/**
 * The names of the script's own numbers a message may use: every name the alert function gives a number (a variable or a setting),
 * as the checker typed it. True/false and text names are left out (a message says numbers). The built-in fields win a clash.
 */
export function alertValueNames(compiled) {
    const out = [];
    for (const [name, ty] of Object.entries(compiled.checked.locals)) {
        if (FIELD_SET.has(name))
            continue;
        if (/^(int|float)\b/.test(ty))
            out.push(name);
    }
    return out;
}
/** Why a compiled script cannot raise alerts, or null when it can. */
export function alertProblem(compiled) {
    if (compiled.program.kind !== 'alert')
        return 'Only a script that starts with @alert can raise an alert.';
    const raised = compiled.program.outputs.filter((o) => o.kind === 'alert');
    if (raised.length === 0)
        return 'The script raises nothing: add an alert(condition, "message").';
    if (raised.length > MAX_ALERT_CONDITIONS)
        return `An alert script can raise at most ${MAX_ALERT_CONDITIONS} conditions; this one raises ${raised.length}.`;
    const lookahead = compiled.checked.functions.find((f) => f.tag === 'noncausal');
    if (lookahead)
        return `${lookahead.name} looks at candlesticks after the one being judged, so an alert cannot use it.`;
    const names = alertValueNames(compiled);
    for (const o of raised) {
        const unknown = unknownAlertFields(o.label ?? '', names);
        if (unknown.length) {
            const own = names.length ? `, or a number the script names (${names.slice(0, 6).map((n) => `{${n}}`).join(', ')})` : ', or a number the script names (give it a name first: r = ta.rsi(close, 14))';
            return `The alert message uses {${unknown[0]}}, which is not a value an alert can fill. Use ${ALERT_MESSAGE_FIELDS.map((f) => `{${f}}`).join(', ')}${own}.`;
        }
    }
    const used = messageValues(raised.map((o) => o.label ?? ''), names);
    if (used.length > MAX_ALERT_VALUES)
        return `The alert messages name ${used.length} of the script's numbers; at most ${MAX_ALERT_VALUES} can be filled in.`;
    return null;
}
/** The script's own names used in `messages`, in order of first use, each once. */
function messageValues(messages, names) {
    const own = new Set(names);
    const out = [];
    for (const text of messages) {
        for (const m of text.matchAll(PLACEHOLDER))
            if (own.has(m[1]) && !FIELD_SET.has(m[1]) && !out.includes(m[1]))
                out.push(m[1]);
    }
    return out;
}
/**
 * Values an alert message may name, filled in by the host when the alert fires: `alert(cond, "Breakout at {close}")`. Only facts of
 * the candlestick the alert judged; nothing a script computes (that would need a value the host does not have).
 */
export const ALERT_MESSAGE_FIELDS = Object.freeze(['symbol', 'close', 'interval', 'time']);
const FIELD_SET = new Set(ALERT_MESSAGE_FIELDS);
/** `{name}` or `{{name}}` (the double form is common in other charting tools; both mean the same here). */
const PLACEHOLDER = /\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}/g;
/**
 * The `{name}` placeholders in a message that are not values an alert can fill, in order, each once. `names` are the script's own
 * numbers (`alertValueNames`); without them only the built-in fields are known.
 */
export function unknownAlertFields(text, names = []) {
    const own = new Set(names);
    const out = [];
    for (const m of text.matchAll(PLACEHOLDER))
        if (!FIELD_SET.has(m[1]) && !own.has(m[1]) && !out.includes(m[1]))
            out.push(m[1]);
    return out;
}
/**
 * The text of an alert as kept: known placeholders written `{name}` (the built-in fields, and `names`, the script's own numbers),
 * every other brace removed (the host's template uses braces), no control characters, at most 120 characters.
 */
export function cleanAlertMessage(text, names = []) {
    const own = new Set(names);
    const kept = [];
    // eslint-disable-next-line no-control-regex
    const marked = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(PLACEHOLDER, (all, name) => {
        if (!FIELD_SET.has(name) && !own.has(name))
            return all;
        kept.push(name);
        return `\u0001${kept.length - 1}\u0001`;
    });
    const plain = marked.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    // eslint-disable-next-line no-control-regex
    return plain.replace(/\u0001(\d+)\u0001/g, (_m, i) => `{${kept[Number(i)]}}`).slice(0, MAX_ALERT_MESSAGE_CHARS);
}
export function describeAlert(compiled) {
    const program = compiled.program;
    const names = alertValueNames(compiled);
    const alerts = [];
    program.outputs.forEach((o, output) => {
        if (o.kind !== 'alert')
            return;
        const n = alerts.length + 1;
        alerts.push({ key: `a${n}`, message: cleanAlertMessage(o.label ?? '', names) || `Alert ${n}`, output });
    });
    const name = typeof program.meta.name === 'string' && program.meta.name.trim() !== '' ? program.meta.name.trim().slice(0, 40) : 'Alert';
    const values = messageValues(alerts.map((a) => a.message), names).slice(0, MAX_ALERT_VALUES);
    return { name, inputs: program.inputs, alerts, values };
}
const isAlertCall = (s) => s.kind === 'ExprStmt' && s.value.kind === 'Call' && s.value.func.kind === 'Name' && s.value.func.id === 'alert';
/** The body without its alert(...) calls; an if left empty keeps a `pass`. */
function withoutAlerts(body, span) {
    const out = [];
    for (const s of body) {
        if (isAlertCall(s))
            continue;
        if (s.kind === 'If') {
            const inner = withoutAlerts(s.body, s.span);
            const orelse = s.orelse.length ? withoutAlerts(s.orelse, s.span) : [];
            out.push({ ...s, body: inner, orelse });
            continue;
        }
        out.push(s);
    }
    return out.length ? out : [{ kind: 'Pass', span }];
}
const plotOf = (name, span) => {
    const arg = (value) => ({ kind: 'Arg', span, value });
    const call = { kind: 'Call', span, func: { kind: 'Name', span, id: 'plot' }, args: [arg({ kind: 'Name', span, id: name }), arg({ kind: 'String', span, value: name })] };
    return { kind: 'ExprStmt', span, value: call };
};
/**
 * The chart script that works out the numbers an alert script's messages name, or null when they name none (or it does not
 * compile, for example a name given a value only inside an if). It is the same source with `@indicator` in place of `@alert`, the
 * alert(...) calls left out and one plot per name added at the end of the function, so every number is worked out exactly as the
 * alert function works it out. Presentation only: it does not change the alert script, its id or its conditions.
 */
export function alertValueScript(source, alert, options = {}) {
    if (alertProblem(alert))
        return null;
    const names = describeAlert(alert).values;
    if (names.length === 0)
        return null;
    const parsed = tryParse(source);
    if (parsed.error || !parsed.module)
        return null;
    const module = parsed.module;
    const entry = module.body.find((s) => s.kind === 'FunctionDef' && s.decorators.some((d) => d.name === 'alert'));
    if (!entry)
        return null;
    const decorators = entry.decorators.map((d) => (d.name === 'alert' ? { ...d, name: 'indicator', args: d.args ? d.args.filter((a) => a.name === 'name') : null } : d));
    const end = { ...entry.span, line: entry.span.endLine, col: 1, offset: entry.span.end };
    const body = [...withoutAlerts(entry.body, entry.span), ...names.map((n) => plotOf(n, end))];
    const next = { ...module, body: module.body.map((s) => (s === entry ? { ...entry, decorators, body } : s)) };
    const r = compile(next, source, { ...options, host: 'client-chart' });
    return r.ok && r.compiled ? { names, compiled: r.compiled } : null;
}
/**
 * Why the numbers an alert script's messages name cannot be worked out, or null when they can (or it names none). The check passes
 * for a name given a value only inside an if (`if close > open: x = close`), but such a name has no value after the if, so the
 * host refuses the alert when it is set up, as for `alertProblem`.
 */
export function alertValueProblem(source, alert, options = {}) {
    if (alertProblem(alert))
        return null;
    const names = describeAlert(alert).values;
    if (names.length === 0 || alertValueScript(source, alert, options))
        return null;
    const list = names.map((n) => `{${n}}`).join(', ');
    return `The alert message names ${list}, but ${names.length === 1 ? 'it is' : 'one of them is'} given a value only inside an if, so it has no value to fill in. Give it a value before the if, or in both branches.`;
}
/** The numbers an alert script's messages name, over candlesticks, in `names` order. Settings the value script does not use are left out. */
export function runAlertValues(script, daily, options = {}) {
    const known = new Set(script.compiled.program.inputs.map((i) => i.name));
    const inputs = Object.fromEntries(Object.entries(options.inputs ?? {}).filter(([k]) => known.has(k)));
    const columns = runIndicator(script.compiled, daily, { ...options, inputs });
    return script.names.map((name, k) => ({ name, values: columns[k]?.values ?? new Float64Array(daily.date.length).fill(Number.NaN) }));
}
/**
 * The columns of an alert script over candlesticks, in `describeAlert` order. A condition switched off by a setting is a column
 * of NaN. Throws what `run` throws (a bad setting, a budget that ran out, data the script needs but the host has not).
 */
export function runAlert(compiled, daily, options = {}) {
    const problem = alertProblem(compiled);
    if (problem)
        throw new RangeError(problem);
    const description = describeAlert(compiled);
    const result = run(compiled, daily, options);
    const n = daily.date.length;
    const byOutput = new Map(result.outputs.map((o) => [o.index, o]));
    return description.alerts.map((a) => {
        const out = byOutput.get(a.output);
        const values = new Float64Array(n).fill(Number.NaN);
        if (out)
            for (let i = 0; i < n; i++)
                values[i] = out.values[i] === 1 ? 1 : out.values[i] === 0 ? 0 : Number.NaN;
        return { key: a.key, values };
    });
}
