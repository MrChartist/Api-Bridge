import { BRACKET_MAX_DEPTH, INDENT_MAX_DEPTH, NAME_MAX_CHARS, NUMBER_MAX_CHARS, SOURCE_MAX_CHARS, SOURCE_MAX_LINES, STRING_MAX_CHARS, charCount, } from '../limits.js';
import { ScriptError } from './errors.js';
import { ALLOWED_KEYWORDS, PINE_HABITS, TRIPLE_QUOTE, habitForCharacter, habitForKeyword, habitForOperator, habitForStringPrefix, } from './pythonisms.js';
const OPS3 = ['**=', '//=', '>>=', '<<='];
const OPS2 = ['**', '//', '==', '!=', '<=', '>=', '->', ':=', '+=', '-=', '*=', '/=', '%=', '<<', '>>', '&&', '||'];
const OPS1 = '+-*/%<>=()[],:.@&|^~!;{}?\\$`';
const ESCAPES = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' };
const closerFor = (open) => (open === '(' ? ')' : ']');
const isDigit = (c) => c >= 48 && c <= 57;
const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);
const isLetterLike = (c) => isIdentStart(c);
/** A word the language keeps for itself, written where a name is expected. */
function reservedName(word) {
    return { code: 'E-PARSE-RESERVED-NAME', message: `\`${word}\` is a reserved word, so it cannot be used as a name.`, hint: `Choose another name, for example ${word}_value or my_${word}.` };
}
/** Characters pasted from documents that have exactly one meaning here, and the keyboard text that replaces them (B1-19). */
const CHAR_FIXES = {
    0x201c: '"', 0x201d: '"', 0x2018: "'", 0x2019: "'", 0x2212: '-', 0x00d7: '*', 0x00f7: '/', 0x2265: '>=', 0x2264: '<=', 0x2260: '!=',
    0x00a0: ' ', 0x202f: ' ', 0x2002: ' ', 0x2003: ' ', 0x2009: ' ', 0x200a: ' ', 0x3000: ' ',
    0x200b: '', 0x200c: '', 0x200d: '', 0x2060: '', 0xfeff: '',
};
/**
 * Whether the text after `//` reads as words rather than as one value (B1-4): two values in a row (`up day`), or nothing at all.
 * `// 200` and `// n` are left to be read as floor division; the checker warns about the first and names the Pine habit for an
 * unknown name.
 */
function looksLikeComment(rest) {
    const body = rest.trim();
    if (body === '')
        return true;
    const STRING = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/;
    const words = body.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\S/g) ?? [];
    const OPERATOR_WORDS = new Set(['and', 'or', 'not', 'if', 'else', 'in', 'for', 'is', 'lambda']);
    const isValue = (w) => (STRING.test(w) || /^[A-Za-z_\d]/.test(w)) && !OPERATOR_WORDS.has(w);
    // Two values in a row outside brackets (a closing bracket ends a value): `up day`, `RSI(14) oversold`.
    let depth = 0;
    let prevValue = false;
    for (const w of words) {
        if (w === '(' || w === '[') {
            if (depth === 0 && prevValue)
                prevValue = false;
            depth++;
            continue;
        }
        if (w === ')' || w === ']') {
            depth--;
            if (depth < 0)
                return false;
            if (depth === 0)
                prevValue = true;
            continue;
        }
        if (depth > 0)
            continue;
        const v = isValue(w);
        if (v && prevValue)
            return true;
        prevValue = v;
    }
    // Text no value can contain: an @, a non-ASCII letter, a question mark.
    return /[@?$]|[^\x20-\x7e\t]/.test(body.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ''));
}
/** Length of the line break at index i: 2 for CRLF, 1 for LF or CR, otherwise 0. */
function lineBreakLength(s, i) {
    const c = s.charCodeAt(i);
    if (c === 10)
        return 1;
    if (c === 13)
        return s.charCodeAt(i + 1) === 10 ? 2 : 1;
    return 0;
}
function countLines(s) {
    let lines = 1;
    for (let i = 0; i < s.length;) {
        const k = lineBreakLength(s, i);
        if (k) {
            i += k;
            if (i < s.length)
                lines++;
        }
        else
            i++;
    }
    return s.length === 0 ? 0 : lines;
}
/**
 * Turn a script into tokens, with INDENT, DEDENT and NEWLINE tokens like Python's tokenizer.
 * Throws ScriptError on the first problem. Never throws anything else.
 */
export function tokenize(source, options = {}) {
    return lex(source, options).tokens;
}
/** Like tokenize, but also returns the comments (kept on the side so a formatter can keep them). */
export function lex(source, options = {}) {
    const maxChars = options.maxChars ?? SOURCE_MAX_CHARS;
    const maxLines = options.maxLines ?? SOURCE_MAX_LINES;
    const n = source.length;
    if (n > maxChars) {
        throw new ScriptError({
            code: 'E-LEX-TOO-LARGE',
            message: `The script is too long: ${n} characters (the limit is ${maxChars}).`,
            hint: 'Split the idea into smaller named values, or remove comments you do not need.',
            line: 1,
            col: 1,
            offset: 0,
        });
    }
    const tokens = [];
    const comments = [];
    const indents = [0];
    const brackets = [];
    let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    let line = 1;
    let lineStart = i;
    let atLineStart = true;
    if (countLines(source) > maxLines) {
        // Point at the first line over the limit.
        let seen = 1;
        let off = 0;
        while (off < n && seen <= maxLines) {
            const k = lineBreakLength(source, off);
            if (k) {
                off += k;
                seen++;
            }
            else
                off++;
        }
        throw new ScriptError({
            code: 'E-LEX-TOO-LARGE',
            message: `The script has too many lines (the limit is ${maxLines}).`,
            hint: 'Split the idea into smaller named values, or remove lines you do not need.',
            line: maxLines + 1,
            col: 1,
            offset: off,
        });
    }
    function fail(code, message, hint, from, to = from + 1) {
        throw new ScriptError({ code, message, hint, line, col: from - lineStart + 1, endCol: to - lineStart + 1, offset: from });
    }
    function failHabit(habit, from, to = from + 1, fix) {
        if (!fix)
            return fail(habit.code, habit.message, habit.hint, from, to);
        const edits = Array.isArray(fix) ? fix : [fix];
        throw new ScriptError({
            code: habit.code, message: habit.message, hint: habit.hint, line, col: from - lineStart + 1, endCol: to - lineStart + 1, offset: from,
            fix: edits.map((f) => ({ line, col: f.from - lineStart + 1, endCol: f.to - lineStart + 1, text: f.text })),
        });
    }
    /** Indentation of the script so far: spaces or tabs. Tabs are read as 4 spaces when every indented line uses them (2026-10-25). */
    let indentStyle = null;
    const push = (type, value, from, to, extra) => {
        tokens.push({ type, value, line, col: from - lineStart + 1, endLine: line, endCol: to - lineStart + 1, offset: from, end: to, ...extra });
    };
    while (i < n) {
        // ---- Start of a logical line: measure indentation ----
        if (atLineStart && brackets.length === 0) {
            let j = i;
            let spaces = 0;
            let tabs = 0;
            for (; j < n; j++) {
                const cc = source.charCodeAt(j);
                if (cc === 32)
                    spaces++;
                else if (cc === 9)
                    tabs++;
                else
                    break;
            }
            if (j >= n) {
                i = j;
                break;
            }
            const c = source.charCodeAt(j);
            const nl = lineBreakLength(source, j);
            if (nl) {
                i = j + nl;
                line++;
                lineStart = i;
                continue;
            }
            if (c === 35) {
                // Comment-only line: no tokens, but remember the comment.
                const startComment = j;
                while (j < n && !lineBreakLength(source, j))
                    j++;
                const text = source.slice(startComment, j).trimEnd();
                comments.push({ line, col: startComment - lineStart + 1, offset: startComment, end: startComment + text.length, text, standalone: true });
                const k = j < n ? lineBreakLength(source, j) : 0;
                i = j + k;
                if (k) {
                    line++;
                    lineStart = i;
                }
                continue;
            }
            if (tabs > 0 && spaces > 0) {
                fail('E-LEX-TAB', 'This line is indented with both tabs and spaces.', 'Indent with spaces only, 4 for each level (or with tabs only, on every line).', i, j);
            }
            if (tabs > 0 && indentStyle === 'space') {
                fail('E-LEX-TAB', 'This line is indented with tabs, but the lines above are indented with spaces.', 'Use the same kind of indent on every line: 4 spaces for each level.', i, j);
            }
            if (spaces > 0 && indentStyle === 'tab') {
                fail('E-LEX-TAB', 'This line is indented with spaces, but the lines above are indented with tabs.', 'Use the same kind of indent on every line: 4 spaces for each level.', i, j);
            }
            if (tabs > 0)
                indentStyle = 'tab';
            else if (spaces > 0)
                indentStyle = 'space';
            // A tab is read as 4 spaces, so a block indented with one tab is the same as one indented with 4 spaces.
            const width = tabs > 0 ? tabs * 4 : spaces;
            let top = indents[indents.length - 1];
            if (width > top) {
                if (indents.length > INDENT_MAX_DEPTH) {
                    fail('E-LEX-INDENT-DEEP', `Blocks are nested too deeply (the limit is ${INDENT_MAX_DEPTH} levels).`, 'Move part of the logic into a named value or a def function.', i, j);
                }
                indents.push(width);
                push('INDENT', '', i, j);
            }
            else if (width < top) {
                while (width < top) {
                    indents.pop();
                    top = indents[indents.length - 1];
                    push('DEDENT', '', j, j);
                }
                if (width !== top) {
                    fail('E-LEX-DEDENT', 'This line is indented differently from any line above it.', 'Line up with the lines of the block it belongs to, using the same number of spaces.', i, j + 1);
                }
            }
            i = j;
            atLineStart = false;
        }
        const ch = source[i];
        const code = source.charCodeAt(i);
        // A tab between the parts of a line is a space (2026-10-25); inside text it is still refused (E-LEX-CONTROL).
        if (code === 32 || code === 9) {
            i++;
            continue;
        }
        const nl = lineBreakLength(source, i);
        if (nl) {
            if (brackets.length === 0) {
                push('NEWLINE', '\n', i, i + nl);
                atLineStart = true;
            }
            i += nl;
            line++;
            lineStart = i;
            continue;
        }
        if (code === 35) {
            // Comment: skip to the end of the line (the line break is handled above).
            const startComment = i;
            while (i < n && !lineBreakLength(source, i))
                i++;
            const text = source.slice(startComment, i).trimEnd();
            comments.push({ line, col: startComment - lineStart + 1, offset: startComment, end: startComment + text.length, text, standalone: false });
            continue;
        }
        if (code < 32 || code === 127) {
            fail('E-LEX-CONTROL', 'A hidden control character was found.', 'Delete it and type the line again. This can happen when text is copied from another program.', i);
        }
        // ---- Names, keywords, and text prefixes ----
        if (isIdentStart(code)) {
            let j = i + 1;
            while (j < n && isIdentPart(source.charCodeAt(j)))
                j++;
            const word = source.slice(i, j);
            if (word.length > NAME_MAX_CHARS) {
                fail('E-LEX-NAME-LONG', `This name is too long (the limit is ${NAME_MAX_CHARS} characters).`, 'Use a shorter name.', i, j);
            }
            const q = source[j];
            if ((q === '"' || q === "'") && /^[rRbBuUfF]{1,2}$/.test(word))
                failHabit(habitForStringPrefix(word), i, j);
            // A reserved word used as a name (`in = 3`, `class = 2`): say it is reserved, not what the word does (2026-10-25, B1-15/26).
            const assigned = /^[ \t]*=(?!=)/.test(source.slice(j));
            if (ALLOWED_KEYWORDS.has(word)) {
                if (assigned && brackets.length === 0 && word !== 'True' && word !== 'False')
                    failHabit(reservedName(word), i, j);
                push('KEYWORD', word, i, j);
            }
            else {
                // `from="2020-01-01"` in a strategy line: `from` is reserved (it is Python's `from ... import`); the setting is written `from_`.
                if (word === 'from' && assigned && brackets.length > 0) {
                    failHabit({ code: 'E-PY-IMPORT', message: '`from` is a reserved word, so it cannot be the name of a setting.', hint: 'Write from_ with an underscore: from_="2020-01-01".' }, i, j);
                }
                const habit = habitForKeyword(word);
                if (habit) {
                    // Only `from x import y` is an import; `from` anywhere else is a name that happens to be reserved.
                    if (word === 'from' && !/^[ \t]+[A-Za-z_][\w.]*[ \t]+import\b/.test(source.slice(j)))
                        failHabit(reservedName(word), i, j);
                    if (assigned && word !== 'import')
                        failHabit(reservedName(word), i, j);
                    failHabit(habit, i, j);
                }
                push('NAME', word, i, j);
            }
            i = j;
            continue;
        }
        // ---- Numbers ----
        if (isDigit(code) || (ch === '.' && isDigit(source.charCodeAt(i + 1)))) {
            if (ch === '0' && /[xXoObB]/.test(source[i + 1] ?? '')) {
                fail('E-LEX-NUMBER', 'Hex, octal and binary numbers are not available.', 'Write the number in plain decimal, for example 31.', i, i + 2);
            }
            let j = i;
            while (isDigit(source.charCodeAt(j)))
                j++;
            if (source[j] === '.') {
                j++;
                while (isDigit(source.charCodeAt(j)))
                    j++;
            }
            if (source[j] === 'e' || source[j] === 'E') {
                let k = j + 1;
                if (source[k] === '+' || source[k] === '-')
                    k++;
                if (isDigit(source.charCodeAt(k))) {
                    while (isDigit(source.charCodeAt(k)))
                        k++;
                    j = k;
                }
            }
            const text = source.slice(i, j);
            if (/^0\d/.test(text)) {
                // `500,000` and `10,00,000` (lakh grouping) reach here as a number that starts with zeros, after a comma that follows a digit.
                if (/\d[ \t]*,[ \t]*$/.test(source.slice(0, i)))
                    fail('E-LEX-NUMBER', 'Numbers are written without commas.', 'Write 500000, not 500,000 or 5,00,000.', i, j);
                fail('E-LEX-NUMBER', 'Numbers cannot start with extra zeros.', 'Write 7 instead of 007.', i, j);
            }
            const next = source.charCodeAt(j);
            if (next === 95)
                fail('E-LEX-NUMBER', 'Underscores inside numbers are not available.', 'Write the number without underscores, for example 1000.', i, j + 1);
            if (source[j] === 'j' || source[j] === 'J')
                fail('E-LEX-NUMBER', 'Complex numbers are not available.', undefined, i, j + 1);
            if (isLetterLike(next)) {
                fail('E-LEX-NUMBER', 'A number cannot be followed directly by letters.', 'Put an operator between them, for example 2 * x.', i, j + 1);
            }
            if (text.length > NUMBER_MAX_CHARS)
                fail('E-LEX-NUMBER', 'This number has too many digits.', 'Use fewer digits.', i, j);
            const num = Number(text);
            if (!Number.isFinite(num))
                fail('E-LEX-NUMBER-RANGE', 'This number is too large.', 'Use a smaller number.', i, j);
            push('NUMBER', text, i, j, { num });
            i = j;
            continue;
        }
        // ---- Text in quotes ----
        if (ch === '"' || ch === "'") {
            if (source[i + 1] === ch && source[i + 2] === ch)
                failHabit(TRIPLE_QUOTE, i, i + 3);
            let j = i + 1;
            let out = '';
            for (;;) {
                if (j >= n || lineBreakLength(source, j)) {
                    fail('E-LEX-STRING-OPEN', 'This text is missing its closing quote.', 'Add the same quote character at the end of the text, on the same line.', i, Math.min(j, i + 1));
                }
                const c = source[j];
                if (c === ch) {
                    j++;
                    break;
                }
                if (c === '\\') {
                    const e = source[j + 1];
                    const mapped = e === undefined ? undefined : ESCAPES[e];
                    if (mapped === undefined) {
                        fail('E-LEX-ESCAPE', `The escape \\${e ?? ''} is not available.`, 'Use \\n for a new line, \\t for a tab, \\\\ for a backslash, or \\" and \\\' for quotes.', j, j + 2);
                    }
                    out += mapped;
                    j += 2;
                }
                else {
                    const cc = source.charCodeAt(j);
                    if (cc < 32 || cc === 127) {
                        fail('E-LEX-CONTROL', 'A hidden control character was found inside this text.', 'Delete it, or write \\t or \\n if you meant a tab or a new line.', j);
                    }
                    out += c;
                    j++;
                }
                if (out.length > STRING_MAX_CHARS && charCount(out) > STRING_MAX_CHARS) {
                    fail('E-LEX-STRING-LONG', `This text is too long (the limit is ${STRING_MAX_CHARS} characters).`, 'Use a shorter label.', i, j);
                }
            }
            push('STRING', source.slice(i, j), i, j, { str: out });
            i = j;
            continue;
        }
        // ---- Operators and brackets ----
        let op = '';
        const three = source.slice(i, i + 3);
        const two = source.slice(i, i + 2);
        if (OPS3.includes(three))
            op = three;
        else if (OPS2.includes(two))
            op = two;
        else if (OPS1.includes(ch))
            op = ch;
        if (op) {
            // `// note` or `//@version=5`: a Pine Script comment. Floor division needs a value on its left, and one value on its right
            // (2026-10-25, B1-4: a `//` after a value followed by words, `close > open // up day`, is a comment too).
            const prevTok = tokens[tokens.length - 1];
            if (op === '//') {
                const afterValue = !!prevTok && (prevTok.type === 'NAME' || prevTok.type === 'NUMBER' || prevTok.type === 'STRING' ||
                    (prevTok.type === 'KEYWORD' && (prevTok.value === 'True' || prevTok.value === 'False')) ||
                    (prevTok.type === 'OP' && (prevTok.value === ')' || prevTok.value === ']')));
                let eol = i + 2;
                while (eol < n && !lineBreakLength(source, eol))
                    eol++;
                const rest = source.slice(i + 2, eol);
                const restNoComment = /["']/.test(rest) ? rest : rest.replace(/#.*$/, '');
                if (!afterValue || (brackets.length === 0 && /^(\s|[A-Za-z])/.test(rest) && looksLikeComment(restNoComment)) || rest.startsWith('@')) {
                    failHabit(source.startsWith('//@version', i) ? PINE_HABITS.version : PINE_HABITS.comment, i, i + 2, { from: i, to: i + 2, text: '#' });
                }
            }
            // `<>` is "not equal" in spreadsheets and AmiBroker; here it is != (B1-8).
            if (op === '<' && source[i + 1] === '>') {
                failHabit({ code: 'E-PY-NOT-EQUAL', message: '`<>` is not used in this language.', hint: 'Write != for "not equal", for example close != open.' }, i, i + 2, { from: i, to: i + 2, text: '!=' });
            }
            const habit = habitForOperator(op);
            if (habit)
                failHabit(habit, i, i + op.length);
            if (op === '(' || op === '[') {
                if (brackets.length >= BRACKET_MAX_DEPTH) {
                    fail('E-LEX-BRACKET-DEEP', `Brackets are nested too deeply (the limit is ${BRACKET_MAX_DEPTH} levels).`, 'Give part of the expression its own name.', i);
                }
                brackets.push({ ch: op, line, col: i - lineStart + 1, offset: i });
            }
            else if (op === ')' || op === ']') {
                const open = brackets.pop();
                if (!open)
                    fail('E-LEX-BRACKET', `There is a closing \`${op}\` with no opening bracket.`, 'Remove it, or add the opening bracket before it.', i);
                else if ((open.ch === '(') !== (op === ')')) {
                    fail('E-LEX-BRACKET', `The closing \`${op}\` does not match the \`${open.ch}\` opened on line ${open.line}.`, `Use \`${closerFor(open.ch)}\` to close it.`, i);
                }
            }
            push('OP', op, i, i + op.length);
            i += op.length;
            continue;
        }
        // ---- Anything else is a non-ASCII character outside text and comments ----
        const cp = source.codePointAt(i);
        const width = cp > 0xffff ? 2 : 1;
        const replacement = Object.hasOwn(CHAR_FIXES, cp) ? CHAR_FIXES[cp] : undefined;
        const edits = replacement === undefined ? [] : [{ from: i, to: i + width, text: replacement }];
        // An opening curly quote: its closing partner on the same line is replaced too, so the text reads back whole.
        const partner = cp === 0x201c ? 0x201d : cp === 0x2018 ? 0x2019 : undefined;
        if (partner !== undefined) {
            let k = i + 1;
            while (k < n && !lineBreakLength(source, k) && source.charCodeAt(k) !== partner)
                k++;
            if (k < n && source.charCodeAt(k) === partner)
                edits.push({ from: k, to: k + 1, text: CHAR_FIXES[partner] });
        }
        failHabit(habitForCharacter(cp), i, i + width, edits.length > 0 ? edits : undefined);
    }
    if (brackets.length > 0) {
        const open = brackets[brackets.length - 1];
        throw new ScriptError({
            code: 'E-LEX-BRACKET-OPEN',
            message: `The \`${open.ch}\` opened here is never closed.`,
            hint: `Add \`${closerFor(open.ch)}\` where the expression ends.`,
            line: open.line,
            col: open.col,
            offset: open.offset,
        });
    }
    // Close the last logical line, then every open block.
    const last = tokens[tokens.length - 1];
    if (last && last.type !== 'NEWLINE' && last.type !== 'DEDENT' && last.type !== 'INDENT') {
        push('NEWLINE', '\n', n, n);
    }
    while (indents.length > 1) {
        indents.pop();
        push('DEDENT', '', n, n);
    }
    push('EOF', '', n, n);
    return { tokens, comments };
}
/** Like tokenize, but returns the error instead of throwing. For editors and tools. */
export function tryTokenize(source, options = {}) {
    try {
        return { tokens: tokenize(source, options) };
    }
    catch (e) {
        if (e instanceof ScriptError)
            return { error: e };
        // Never expected. Report it as an internal error rather than hide it.
        return {
            error: new ScriptError({
                code: 'E-INTERNAL',
                message: 'An internal error occurred while reading the script.',
                hint: 'Please report this script so it can be fixed.',
                line: 1,
                col: 1,
                offset: 0,
            }),
        };
    }
}
