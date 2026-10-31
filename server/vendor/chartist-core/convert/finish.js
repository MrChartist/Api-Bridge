// The step every importer shares: format the draft with our own formatter, compile and check it, apply the checker's own exact
// fixes once, check again, and work out the line map, the counts, the confidence and the summary. A result whose script does
// not check is never reported as converted (ok false, the checker's problems attached).
import { alertProblem } from '../alert.js';
import { strategyProblem } from '../backtest/strategy.js';
import { compileSource } from '../compile.js';
import { indicatorProblem } from '../indicator.js';
import { formatSource } from '../lang/format.js';
/** Apply exact fixes (non-overlapping edits on one line each), last first so earlier columns stay valid. */
export function applyFixes(text, fixes) {
    const lines = text.split('\n');
    const sorted = [...fixes].sort((a, b) => b.line - a.line || b.col - a.col);
    let lastLine = -1;
    let lastCol = Number.POSITIVE_INFINITY;
    for (const f of sorted) {
        if (f.line === lastLine && f.endCol > lastCol)
            continue; // overlaps the one applied after it
        const l = lines[f.line - 1];
        if (l === undefined)
            continue;
        lines[f.line - 1] = l.slice(0, f.col - 1) + f.text + l.slice(f.endCol - 1);
        lastLine = f.line;
        lastCol = f.col;
    }
    return lines.join('\n');
}
function format(text) {
    try {
        return { text: formatSource(text), error: null };
    }
    catch (err) {
        const e = err;
        return {
            text,
            error: {
                severity: 'error',
                code: e.code ?? 'CV-OUTPUT-UNREADABLE',
                message: e.message ?? 'The converted script could not be read.',
                line: e.line ?? 1,
                col: e.col ?? 1,
                endCol: e.endCol ?? (e.col ?? 1) + 1,
                offset: e.offset ?? 0,
                ...(e.hint ? { hint: e.hint } : {}),
            },
        };
    }
}
/** Format, compile, apply the checker's exact fixes once, compile again. */
export function checkText(draft) {
    const f = format(draft);
    if (f.error)
        return { text: f.text, ok: false, diagnostics: [f.error], fixed: [] };
    let text = f.text;
    let r = compileSource(text);
    const fixes = r.diagnostics.flatMap((d) => d.fix ?? []);
    const fixed = [];
    if (fixes.length) {
        const next = format(applyFixes(text, fixes));
        if (!next.error) {
            const r2 = compileSource(next.text);
            if (r2.errors.length <= r.errors.length) {
                for (const d of r.diagnostics)
                    if (d.fix)
                        fixed.push(d.code);
                text = next.text;
                r = r2;
            }
        }
    }
    const diagnostics = [...r.diagnostics];
    let ok = r.ok;
    // The check a host makes before it uses a script of this kind (the chart, the alert page, the backtest).
    if (r.ok && r.compiled) {
        const kind = r.compiled.program.kind;
        let problem = null;
        try {
            if (kind === 'alert')
                problem = alertProblem(r.compiled);
            else if (kind === 'indicator' || kind === 'bare-indicator')
                problem = indicatorProblem(r.compiled);
            else if (kind === 'strategy')
                problem = strategyProblem(r.compiled);
        }
        catch (err) {
            problem = err instanceof Error ? err.message : 'refused';
        }
        if (problem) {
            ok = false;
            diagnostics.push({ severity: 'error', code: 'CV-HOST-CHECK', message: problem, line: 1, col: 1, endCol: 2, offset: 0 });
        }
    }
    return { text, ok, diagnostics, fixed };
}
/** Source lines that hold code: not blank and not only a comment. */
export function codeLines(source, commentPrefix) {
    const out = [];
    source.split(/\r?\n/).forEach((l, i) => {
        const t = l.trim();
        if (t && !commentPrefix.test(t))
            out.push(i + 1);
    });
    return out;
}
function linesOf(n) {
    if (n.lines)
        return n.lines;
    const out = [];
    for (let i = n.line; i <= (n.endLine ?? n.line); i++)
        out.push(i);
    return out;
}
export function countLines(code, notes) {
    const uns = new Set();
    const apx = new Set();
    for (const n of notes) {
        if (n.level === 'unsupported')
            for (const l of linesOf(n))
                uns.add(l);
        if (n.level === 'approx')
            for (const l of linesOf(n))
                apx.add(l);
    }
    let exact = 0;
    let approx = 0;
    let unsupported = 0;
    for (const l of code) {
        if (uns.has(l))
            unsupported++;
        else if (apx.has(l))
            approx++;
        else
            exact++;
    }
    return { total: code.length, exact, approx, unsupported };
}
export function confidenceOf(ok, notes) {
    if (!ok)
        return 'none';
    if (notes.some((n) => n.level === 'unsupported'))
        return 'low';
    if (notes.some((n) => n.level === 'approx'))
        return 'medium';
    return 'high';
}
const KIND_WORD = { screener: 'Screener', indicator: 'Indicator', alert: 'Alert', strategy: 'Strategy' };
export function summaryOf(ok, counts, kind) {
    const k = `${KIND_WORD[kind] ?? kind}.`;
    if (!ok)
        return `Converted, but the result does not check yet; the problems are listed. ${k}`;
    const { total, exact, approx, unsupported } = counts;
    const plural = (n) => `${n} line${n === 1 ? '' : 's'}`;
    if (unsupported === 0 && approx === 0)
        return `Converted all ${plural(total)} exactly. ${k}`;
    if (unsupported === 0)
        return `Converted ${exact} of ${plural(total)} exactly, ${approx} approximated. ${k}`;
    return `Converted ${exact + approx} of ${plural(total)}${approx ? ` (${approx} approximated)` : ''}; ${unsupported} could not be converted and ${unsupported === 1 ? 'is' : 'are'} noted in the script. ${k}`;
}
/** Output line -> source line, by matching the draft's code lines to the formatted ones in order. */
export function lineMapOf(draft, srcLines, formatted) {
    const norm = (s) => s.replace(/\s+/g, '').replace(/[()]/g, '');
    const d = draft.split('\n').map((t, i) => ({ t: norm(t), src: srcLines[i] ?? 0 }));
    const f = formatted.split('\n');
    const map = [];
    let j = 0;
    for (let i = 0; i < f.length; i++) {
        const t = norm(f[i]);
        if (!t)
            continue;
        let k = j;
        while (k < d.length && d[k].t !== t)
            k++;
        if (k < d.length) {
            if (d[k].src > 0)
                map.push({ out: i + 1, src: d[k].src });
            j = k + 1;
        }
    }
    return map;
}
/** Turn a draft into the final result. */
export function finish(draft, source, lang, commentPrefix) {
    const notes = [...draft.notes];
    const c = checkText(draft.text);
    if (c.fixed.length) {
        notes.push({ line: 0, level: 'info', code: 'CV-CHECKER-FIX', message: `The checker's own exact fix was applied (${[...new Set(c.fixed)].join(', ')}).` });
    }
    const ok = c.ok && !draft.failed;
    const counts = countLines(codeLines(source, commentPrefix), notes);
    const companions = draft.companions.map((x) => {
        const cc = checkText(x.text);
        return { kind: x.kind, script: cc.text, ok: cc.ok, diagnostics: cc.diagnostics };
    });
    const res = {
        ok,
        lang,
        kind: draft.kind,
        script: c.text,
        companions,
        notes,
        confidence: confidenceOf(ok, notes),
        summary: (draft.failed ? 'Nothing here could be converted exactly; the reasons are listed.' : summaryOf(c.ok, counts, draft.kind)) +
            (draft.lostRisk?.length ? ` The backtest has no ${draft.lostRisk.join(' and no ')}: the source's ${draft.lostRisk.join(' and ')} could not be converted (see the notes).` : ''),
        lineMap: lineMapOf(draft.text, draft.srcLines, c.text),
        counts,
        diagnostics: c.diagnostics,
    };
    if (draft.title)
        res.title = draft.title;
    return res;
}
