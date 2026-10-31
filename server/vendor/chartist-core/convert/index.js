// Script import ("convert"): detect the language of a pasted script and convert it to ChartistScript, deterministically.
// One interface for every source language; each source registers a Converter. Design: docs/features/script-import/README.md.
import { detectLanguage, languageName } from './detect.js';
import { finish } from './finish.js';
import { convertAflDraft } from './afl/convert.js';
import { convertChartinkDraft } from './chartink/convert.js';
import { convertPineDraft } from './pine/convert.js';
import { convertPythonDraft } from './python/convert.js';
export { detectLanguage, languageName } from './detect.js';
export { applyFixes } from './finish.js';
const pine = {
    lang: 'pine',
    label: 'Pine Script',
    convert: (text, o) => convertPineDraft(text, o.kind),
};
const chartink = {
    lang: 'chartink',
    label: 'Chartink',
    convert: (text, o) => convertChartinkDraft(text, o.kind),
};
const afl = {
    lang: 'afl',
    label: 'AmiBroker AFL',
    convert: (text, o) => convertAflDraft(text, o.kind),
};
/** Converters by source language. Detection knows more languages than there are converters. */
const python = {
    lang: 'python',
    label: 'Python',
    convert: (text, o) => convertPythonDraft(text, o.kind),
};
export const CONVERTERS = { pine, chartink, afl, python };
/** Comment markers of each source, so the line counts leave comment lines out. */
const COMMENT = {
    pine: /^\/\//,
    chartink: /^(#|\/\/)/,
    afl: /^(\/\/|\/\*|\*)/,
    python: /^#/,
    chartist: /^#/,
    unknown: /^(#|\/\/)/,
};
/** Languages that have a converter now. */
export function supportedLanguages() {
    return Object.keys(CONVERTERS);
}
function emptyResult(lang, code, message, extra = {}) {
    return {
        ok: false,
        lang,
        kind: 'screener',
        script: '',
        companions: [],
        notes: [{ line: 0, level: 'unsupported', code, message }],
        confidence: 'none',
        summary: message,
        lineMap: [],
        counts: { total: 0, exact: 0, approx: 0, unsupported: 0 },
        diagnostics: [],
        ...extra,
    };
}
/**
 * Convert a script written in another language to ChartistScript. Pure and deterministic: the same text gives the same bytes.
 * The result's script is formatted and checked by this engine; `ok` is false when it does not check (never "best effort").
 */
export function convert(text, options = {}) {
    const detection = options.from ? undefined : detectLanguage(text);
    const lang = options.from ?? detection?.[0]?.lang ?? 'unknown';
    const extra = detection ? { detection } : {};
    if (lang === 'chartist') {
        return emptyResult('chartist', 'CV-ALREADY-CHARTIST', 'This is already ChartistScript; open it in the editor as it is.', extra);
    }
    if (lang === 'unknown') {
        return emptyResult('unknown', 'CV-UNKNOWN-LANGUAGE', 'We could not tell which language this is. Pick it, or describe what the script looks for.', extra);
    }
    const conv = CONVERTERS[lang];
    if (!conv) {
        return emptyResult(lang, 'CV-NOT-SUPPORTED-YET', `${languageName(lang)} is recognised, but converting it is not supported yet. Pick another language, or describe what the script looks for.`, extra);
    }
    let draft;
    try {
        draft = conv.convert(text, options.kind ? { kind: options.kind } : {});
    }
    catch (err) {
        // a bug in a converter: reported, never thrown at the caller
        return emptyResult(lang, 'CV-INTERNAL', `The converter could not finish (${err instanceof Error ? err.message : 'unknown error'}). Please report it.`, extra);
    }
    const res = finish(draft, text, lang, COMMENT[lang]);
    if (detection)
        res.detection = detection;
    return res;
}
