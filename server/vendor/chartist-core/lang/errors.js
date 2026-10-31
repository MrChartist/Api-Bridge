export class ScriptError extends Error {
    code;
    hint;
    line;
    col;
    endCol;
    offset;
    fix;
    constructor(init) {
        super(init.message);
        this.name = 'ScriptError';
        this.code = init.code;
        this.hint = init.hint;
        this.line = init.line;
        this.col = init.col;
        this.endCol = init.endCol ?? init.col + 1;
        this.offset = init.offset;
        this.fix = init.fix;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            hint: this.hint,
            line: this.line,
            col: this.col,
            endCol: this.endCol,
            offset: this.offset,
            ...(this.fix ? { fix: this.fix } : {}),
        };
    }
}
export function diagnosticToError(d) {
    return new ScriptError({ code: d.code, message: d.message, hint: d.hint, line: d.line, col: d.col, endCol: d.endCol, offset: d.offset, ...(d.fix ? { fix: d.fix } : {}) });
}
/** The diagnostic for a ScriptError (a problem found while reading the script). */
export function errorToDiagnostic(e) {
    const d = { severity: 'error', code: e.code, message: e.message, line: e.line, col: e.col, endCol: e.endCol, offset: e.offset };
    if (e.hint !== undefined)
        d.hint = e.hint;
    if (e.fix !== undefined)
        d.fix = e.fix;
    return d;
}
const SNIPPET_MAX = 120;
/** Replace control characters, so a snippet is safe to show or log. */
function cleanForDisplay(text) {
    let out = '';
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        // A tab is a legal indent (read as 4 spaces): shown as one space, so the caret below stays under the right character (B1-25).
        out += cp === 9 ? ' ' : cp < 32 || cp === 127 ? '·' : ch;
    }
    return out;
}
/**
 * A short, safe, multi-line description of an error with a caret under the problem.
 * The source line is cut to 120 characters around the column and cleaned of control characters.
 */
export function formatError(err, source) {
    const lines = source.split(/\r\n|\r|\n/);
    const raw = lines[err.line - 1] ?? '';
    const col0 = Math.max(0, err.col - 1);
    let start = 0;
    if (raw.length > SNIPPET_MAX)
        start = Math.max(0, Math.min(col0 - 40, raw.length - SNIPPET_MAX));
    const shown = cleanForDisplay(raw.slice(start, start + SNIPPET_MAX));
    const caretAt = Math.max(0, col0 - start);
    const width = Math.max(1, Math.min(err.endCol - err.col, SNIPPET_MAX - caretAt));
    const out = [
        `${err.code} at line ${err.line}, column ${err.col}: ${err.message}`,
        shown,
        ' '.repeat(caretAt) + '^'.repeat(width),
    ];
    if (err.hint)
        out.push(`Hint: ${err.hint}`);
    return out.join('\n');
}
/** The same layout as formatError, for a checker diagnostic. */
export function formatDiagnostic(d, source) {
    return formatError(diagnosticToError(d), source);
}
