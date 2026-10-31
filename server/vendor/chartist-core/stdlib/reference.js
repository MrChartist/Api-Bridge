// The reference page for the standard library, written from the manifest so the two can never differ.
// The committed copy is docs/STDLIB.md; a test fails when it is out of date.
import { STDLIB_VERSION } from '../versions.js';
import { FUNCTIONS, NAMESPACES, PATTERN_IDS, PLANNED, PRICE_BLENDS, RESERVED_NAMESPACES, RETIRED_PATTERN_IDS, TF_CODES, VALUES } from './manifest.js';
/** What an argument may be, in words (`whole number 1..500`). Used by the reference page and by editors for hover text. */
export const argText = (a) => {
    switch (a.t) {
        case 'num': return 'number';
        case 'bool': return 'true/false';
        case 'any': return 'number or true/false';
        case 'value': return 'number, true/false or text';
        case 'color': return 'colour';
        case 'len': return `whole number ${a.min}..${a.max}`;
        case 'cnum': return `fixed number${a.min !== undefined || a.max !== undefined ? ` ${a.min ?? ''}..${a.max ?? ''}` : ''}`;
        case 'cbool': return 'True or False';
        case 'ctext': return 'text';
        case 'choice': return a.values.length > 8 ? `one of ${a.values.length} choices (see below)` : `one of ${a.values.map((v) => `"${v}"`).join(', ')}`;
        case 'group': return 'text for every stock';
        case 'list': return a.of === 'num' ? 'list of numbers [a, b, c] or [x[i] for i in range(n)]' : a.of === 'text' ? 'list of texts written out ["a", "b"]' : 'list of true/false [a, b, c] or [cond for i in range(n)]';
    }
};
/** What a call gives back, in words. */
export const retText = (r) => {
    switch (r.kind) {
        case 'series': return r.base === 'like' ? `series like ${(r.like ?? []).join(' / ')}` : `${r.base} series`;
        case 'snapshot': return `${r.base} (latest candlestick only)`;
        case 'cross': return `${r.base} (across all stocks)`;
        case 'none': return 'nothing';
        case 'record': return `group: ${Object.entries(r.fields).map(([k, v]) => `${k} (${v})`).join(', ')}`;
        case 'frame': return 'group: open, high, low, close, volume';
        case 'setting': return 'the setting\'s value, fixed for the run';
    }
};
/** `ta.sma(x, length)`; optional settings in brackets with their defaults. */
export const signature = (f) => {
    const args = f.params.map((p) => (p.optional ? `[${p.name}${p.default !== undefined ? `=${JSON.stringify(p.default)}` : ''}]` : p.name));
    return `${f.name}(${args.join(', ')})`;
};
const esc = (s) => s.replace(/\|/g, '\\|');
const tagText = (f) => (f.tag === null ? (f.reason ? 'unavailable' : 'unavailable (not audited)') : f.tag);
export function renderStdlibReference() {
    const out = [];
    out.push('# ChartistScript — Standard library (generated)');
    out.push('');
    out.push(`Generated from \`src/stdlib/manifest.ts\` (manifest version ${STDLIB_VERSION}). Do not edit by hand: change the manifest and run \`UPDATE_STDLIB_DOC=1 npx vitest run packages/chartist-core/src/stdlib\`. A test fails when this page is out of date.`);
    out.push('');
    out.push('Status: DRAFT. Names, argument rules and tags are a draft until the standard library is frozen (end of step S10). Anything marked "Needs verification" in a summary is not settled.');
    out.push('');
    out.push('How to read: **Needs** is the data the name requires; a script is refused where that data does not exist (SPEC section 10.1). **Tag** says whether a value at a candlestick uses only that candlestick and earlier ones (`causal`), is delayed (`lag`), or can change when later candlesticks arrive (`noncausal`, drawing only). A name with no tag cannot be used yet.');
    out.push('');
    const group = (name) => FUNCTIONS.filter((f) => (name === '' ? !f.name.includes('.') : f.name.startsWith(`${name}.`)));
    const groups = ['', ...NAMESPACES.filter((n) => FUNCTIONS.some((f) => f.name.startsWith(`${n}.`)))];
    for (const g of groups) {
        const fns = group(g);
        if (fns.length === 0)
            continue;
        out.push(g === '' ? '## Language-level functions' : `## ${g}`);
        out.push('');
        out.push('| Call | Arguments | Gives | Needs | Tag | Notes |');
        out.push('|---|---|---|---|---|---|');
        for (const f of fns) {
            const args = f.params.length === 0 ? '—' : f.params.map((p) => `\`${p.name}\`: ${argText(p.arg)}${p.optional ? ' (optional)' : ''}`).join('<br>');
            out.push(`| \`${esc(signature(f))}\` | ${esc(args)} | ${esc(retText(f.returns))} | ${f.requires.length ? f.requires.join(', ') : '—'} | ${tagText(f)} | ${esc(f.summary)}${f.reason ? ` Unavailable: ${esc(f.reason)}` : ''} |`);
        }
        out.push('');
    }
    out.push('## Values');
    out.push('');
    out.push('| Name | Type | Needs | Tag | Notes |');
    out.push('|---|---|---|---|---|');
    const vs = (v) => `${v.base} ${v.shape === 'series' ? 'series' : v.shape === 'snapshot' ? '(latest candlestick only)' : '(fixed)'}`;
    for (const v of VALUES)
        out.push(`| \`${v.name}\` | ${vs(v)} | ${v.requires.length ? v.requires.join(', ') : '—'} | ${v.tag ?? 'unavailable (not audited)'} | ${esc(v.summary)} |`);
    out.push('');
    out.push('Prices worked out from each candlestick. Each is exactly the sum written out (the same program, the same results), and a script may still set its own name with the same spelling, which then wins:');
    out.push('');
    for (const [n, b] of Object.entries(PRICE_BLENDS))
        out.push(`- \`${n}\`: float series, needs ohlcv:daily, causal. ${esc(b.summary)}`);
    out.push('');
    out.push('## Choices');
    out.push('');
    out.push(`- \`tf(code)\`: ${Object.keys(TF_CODES).map((c) => `"${c}"`).join(', ')}. Intraday sizes exist only on the chart.`);
    out.push(`- \`candle.pattern(id)\` (${PATTERN_IDS.length} patterns): ${PATTERN_IDS.map((p) => `\`${p}\``).join(', ')}.`);
    out.push(`- Retired pattern ids, refused with E-ARG-RETIRED: ${Object.entries(RETIRED_PATTERN_IDS).map(([id, r]) => `\`${id}\` (${r.on})`).join(', ')}.`);
    out.push('');
    out.push('## Reserved and planned names');
    out.push('');
    for (const [ns, what] of Object.entries(RESERVED_NAMESPACES))
        out.push(`- \`${ns}\`: kept for ${what}; refused until that data exists.`);
    for (const [n, why] of Object.entries(PLANNED))
        out.push(`- \`${n}\`: ${why}`);
    out.push('');
    return out.join('\n');
}
