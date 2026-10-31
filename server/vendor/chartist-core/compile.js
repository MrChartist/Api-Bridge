import { check } from './check/checker.js';
import { errorToDiagnostic } from './lang/errors.js';
import { tryParseAll } from './lang/parser.js';
import { PURE_HASH } from './hash/provider.js';
import { hashProgram } from './ir/hashing.js';
import { LoweringError, lowerWithLines } from './ir/lower.js';
import { makePlan } from './ir/plan.js';
import { absolutePriceLevelNodes } from './ir/absolutePriceLevel.js';
import { NEVER_TRUE_CODE, neverTrueNodes } from './ir/neverTrue.js';
import { API_VERSION, CORE_VERSION, IR_VERSION, STDLIB_VERSION } from './versions.js';
/** The warning code for a price compared with a fixed price level. */
export const ABS_PRICE_LEVEL_CODE = 'W-ABS-PRICE-LEVEL';
export const VERSIONS = { core: CORE_VERSION, ir: IR_VERSION, api: API_VERSION, stdlib: STDLIB_VERSION };
function internal(message, line = 1, col = 1, offset = 0) {
    return { severity: 'error', code: 'E-INTERNAL', message: 'The compiler could not finish this script.', hint: `Please report it. (${message})`, line, col, endCol: col + 1, offset };
}
/** Compile a parsed script. */
export function compile(module, source, options = {}) {
    const hash = options.hash ?? PURE_HASH;
    const checkedResult = check(module, source, { ...(options.host ? { host: options.host } : {}), ...(options.stages ? { stages: options.stages } : {}) });
    const diagnostics = [...checkedResult.diagnostics];
    const fail = () => ({
        ok: false,
        diagnostics,
        errors: diagnostics.filter((d) => d.severity === 'error'),
        warnings: diagnostics.filter((d) => d.severity === 'warning'),
        compiled: null,
        checked: checkedResult.script,
    });
    if (!checkedResult.ok || !checkedResult.script)
        return fail();
    let program;
    let lines;
    try {
        ;
        ({ program, lines } = lowerWithLines(module, checkedResult.script, hash));
    }
    catch (e) {
        if (e instanceof LoweringError)
            diagnostics.push(internal(e.message, e.span?.line, e.span?.col, e.span?.offset));
        else
            diagnostics.push(internal(e instanceof Error ? e.message : 'unknown error'));
        return fail();
    }
    const { plan, problems } = makePlan(program);
    for (const p of problems)
        diagnostics.push({ severity: 'error', code: p.code, message: p.message, hint: p.hint, line: 1, col: 1, endCol: 2, offset: 0 });
    if (problems.length > 0)
        return fail();
    // These two warnings come from the compiled graph, which knows the line but not the column: they mark the whole statement on that line.
    const sourceLines = source.split('\n');
    const lineSpan = (line) => {
        const raw = sourceLines[line - 1] ?? '';
        // Leave a trailing comment out of the span: the first # that is not inside a string.
        let quote = '';
        let cut = raw.length;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (quote) {
                if (ch === '\\')
                    i++;
                else if (ch === quote)
                    quote = '';
            }
            else if (ch === '"' || ch === "'")
                quote = ch;
            else if (ch === '#') {
                cut = i;
                break;
            }
        }
        const text = raw.slice(0, cut);
        const lead = text.length - text.trimStart().length;
        const end = text.trimEnd().length;
        let offset = 0;
        for (let i = 0; i < line - 1 && i < sourceLines.length; i++)
            offset += sourceLines[i].length + 1;
        return end > lead ? { col: lead + 1, endCol: end + 1, offset: offset + lead } : { col: 1, endCol: 2, offset };
    };
    // A comparison that can never be true (today's candlestick is inside the window it is compared with) checks clean and then does nothing.
    const seen = new Set();
    for (const f of neverTrueNodes(program)) {
        const line = lines[f.node] > 0 ? lines[f.node] : 1;
        if (seen.has(line))
            continue;
        seen.add(line);
        diagnostics.push({
            severity: 'warning', code: NEVER_TRUE_CODE, line, ...lineSpan(line),
            message: f.side === 'above'
                ? "This can never be true: ta.highest(...) includes today's candlestick, so today's price is never above it."
                : "This can never be true: ta.lowest(...) includes today's candlestick, so today's price is never below it.",
            hint: f.side === 'above'
                ? 'To compare with the earlier candlesticks only, leave today out by shifting the window: ta.highest(high, 20)[1].'
                : 'To compare with the earlier candlesticks only, leave today out by shifting the window: ta.lowest(low, 10)[1].',
        });
    }
    // A strategy that tests a price against a fixed price over adjusted history is testing something other than what was written (docs/adr/0004).
    if (checkedResult.script.host === 'strategy') {
        const levelNodes = absolutePriceLevelNodes(program);
        if (levelNodes.length > 0) {
            const line = lines[levelNodes[0]] > 0 ? lines[levelNodes[0]] : 1;
            diagnostics.push({
                severity: 'warning', code: ABS_PRICE_LEVEL_CODE, line, ...lineSpan(line),
                message: 'This script compares a price with a fixed number. History is adjusted for splits and bonuses, so that number meant something else in the past; the result will carry the label ADJUSTED_PRICE_LEVEL.',
                hint: 'Compare with a moving average, a recent high or low, or a ratio such as close / close[20] instead.',
            });
        }
    }
    const hashes = hashProgram(program, hash);
    const compiled = { ...hashes, versions: VERSIONS, program, plan, lines, checked: checkedResult.script };
    return {
        ok: true,
        diagnostics,
        errors: [],
        warnings: diagnostics.filter((d) => d.severity === 'warning'),
        compiled,
        checked: checkedResult.script,
    };
}
/** Read, check, lower, hash and plan a script. */
export function compileSource(source, options = {}) {
    const r = tryParseAll(source);
    if (!r.module) {
        // Up to MAX_SYNTAX_ERRORS problems, in the order of the script.
        const ds = r.errors.map(errorToDiagnostic);
        return { ok: false, diagnostics: ds, errors: ds, warnings: [], compiled: null, checked: null };
    }
    return compile(r.module, source, options);
}
