import { AST_MAX_DEPTH, AST_MAX_NODES, PARSE_MAX_RECURSION } from '../limits.js';
import { ENTRY_KINDS, measureTree, } from './ast.js';
import { ScriptError } from './errors.js';
import { lex } from './lexer.js';
import { LOGIC_WORDS, PARSER_HABITS, PINE_HABITS } from './pythonisms.js';
const CMP_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);
const AUG_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '//=', '**=', '<<=', '>>=']);
const spanFrom = (a, b) => ({
    line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol, offset: a.offset, end: b.end,
});
function describe(t) {
    switch (t.type) {
        case 'NAME':
        case 'KEYWORD':
        case 'OP':
        case 'NUMBER': return '`' + t.value + '`';
        case 'STRING': return 'a piece of text';
        case 'NEWLINE':
        case 'EOF': return 'the end of the line';
        case 'INDENT': return 'an indent';
        case 'DEDENT': return 'the end of the block';
    }
}
const isStructural = (t) => t.type === 'NEWLINE' || t.type === 'EOF' || t.type === 'DEDENT';
/** Pine Script's type words, written between `var` and the name. */
const PINE_TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table']);
/** Words that start a line (statement keywords), compared with a name written at the start of a line (B1-7). */
const LINE_KEYWORDS = ['def', 'if', 'elif', 'else', 'return', 'pass'];
/** One letter added, dropped or changed, or two letters next to each other swapped. */
function nearWord(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1)
        return false;
    if (a.length === b.length) {
        const diff = [];
        for (let i = 0; i < a.length; i++)
            if (a[i] !== b[i])
                diff.push(i);
        if (diff.length === 1)
            return true;
        return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
    }
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < long.length; i++)
        if (long.slice(0, i) + long.slice(i + 1) === short)
            return true;
    return false;
}
/** The keyword a name at the start of a line stands for: `If` is if (case only, certain), `esle` is probably else (a guess). */
function keywordMeant(word) {
    const lower = word.toLowerCase();
    if (lower === 'elseif' || lower === 'elsif')
        return { keyword: 'elif', caseOnly: false };
    for (const k of LINE_KEYWORDS)
        if (lower === k && word !== k)
            return { keyword: k, caseOnly: true };
    if (word.length < 4)
        return undefined;
    for (const k of ['else', 'elif', 'return'])
        if (nearWord(lower, k))
            return { keyword: k, caseOnly: false };
    return undefined;
}
class Parser {
    toks;
    pos = 0;
    depth = 0;
    constructor(toks) {
        this.toks = toks;
    }
    // ---- token helpers ----
    peek(k = 0) {
        return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
    }
    next() {
        const t = this.toks[this.pos];
        if (this.pos < this.toks.length - 1)
            this.pos++;
        return t;
    }
    is(type, k = 0) {
        return this.peek(k).type === type;
    }
    isOp(v, k = 0) {
        const t = this.peek(k);
        return t.type === 'OP' && t.value === v;
    }
    isKw(v, k = 0) {
        const t = this.peek(k);
        return t.type === 'KEYWORD' && t.value === v;
    }
    last() {
        return this.toks[this.pos - 1];
    }
    // ---- errors ----
    failAt(at, code, message, hint, fix) {
        const endCol = at.endLine === undefined || at.endLine === at.line ? Math.max(at.endCol ?? at.col + 1, at.col + 1) : at.col + 1;
        throw new ScriptError({ code, message, hint, line: at.line, col: at.col, endCol, offset: at.offset, ...(fix && fix.length > 0 ? { fix } : {}) });
    }
    failHabit(h, at, fix) {
        return this.failAt(at, h.code, h.message, h.hint, fix);
    }
    /** AND / OR / NOT in capitals: the same words in small letters, one click to fix. */
    failLogic(t) {
        return this.failHabit(PINE_HABITS.logic(t.value), t, [{ line: t.line, col: t.col, endCol: t.endCol, text: t.value.toLowerCase() }]);
    }
    /** The position just after the last real token that was read: where something is missing. */
    failAfter(code, message, hint) {
        for (let k = this.pos - 1; k >= 0; k--) {
            const t = this.toks[k];
            if (t.type !== 'NEWLINE' && t.type !== 'INDENT' && t.type !== 'DEDENT' && t.type !== 'EOF') {
                return this.failAt({ line: t.endLine, col: t.endCol, offset: t.end }, code, message, hint);
            }
        }
        return this.failAt({ line: 1, col: 1, offset: 0 }, code, message, hint);
    }
    /** Fail at token t, or after the previous token when t only marks a line or block end. */
    failExpected(t, code, message, hint) {
        return isStructural(t) ? this.failAfter(code, message, hint) : this.failAt(t, code, message, hint);
    }
    enter(at) {
        if (++this.depth > PARSE_MAX_RECURSION) {
            this.failAt(at, 'E-PARSE-TOO-DEEP', 'This is nested too deeply to read.', 'Give part of the expression its own name on a separate line.');
        }
    }
    leave() {
        this.depth--;
    }
    unexpected(t) {
        if (isStructural(t)) {
            return this.failAfter('E-PARSE-INCOMPLETE', 'The line ends too early; something is missing.', 'Finish the expression, or remove the last operator or comma.');
        }
        if (t.type === 'INDENT') {
            return this.failAt(this.peek(1), 'E-PARSE-INDENT', 'This line is indented, but nothing above it starts a block.', 'Remove the extra spaces, or end the line above with a colon to start a block.');
        }
        if (t.type === 'NAME' && LOGIC_WORDS.has(t.value))
            return this.failLogic(t);
        const prev = this.toks[this.pos - 1];
        // NOT x: the capital NOT was read as a name, and the value after it is what is unexpected.
        if (prev && prev.type === 'NAME' && LOGIC_WORDS.has(prev.value))
            return this.failLogic(prev);
        // `If x:`, `Return x`, `elseif x:`: a keyword written with a capital or a slip, at the start of the line (B1-7).
        if (prev && prev.type === 'NAME' && this.startsLine(this.pos - 1))
            this.failKeyword(prev);
        const phrase = this.chartinkPhrase(t);
        if (phrase)
            return this.failAt(t, 'E-PARSE-UNEXPECTED', `Unexpected ${describe(t)}: two values cannot follow each other.`, phrase);
        const afterValue = !!prev &&
            (prev.type === 'NAME' || prev.type === 'NUMBER' || prev.type === 'STRING' ||
                (prev.type === 'KEYWORD' && (prev.value === 'True' || prev.value === 'False')) ||
                (prev.type === 'OP' && (prev.value === ')' || prev.value === ']')));
        const twoValues = () => this.failAt(t, 'E-PARSE-UNEXPECTED', `Unexpected ${describe(t)}: two values cannot follow each other.`, 'Put an operator such as + or and between them, or start a new line. Inside a call, separate arguments with commas.');
        if (t.type === 'KEYWORD') {
            if (afterValue && (t.value === 'True' || t.value === 'False'))
                return twoValues();
            const hints = {
                in: '`in` is only available inside a list such as [x for i in range(3)].',
                for: '`for` is only available inside a list such as [x for i in range(3)].',
                else: 'Write a if condition else b, with both choices.',
                elif: '`elif` must follow an `if` block.',
                if: 'Write a if condition else b. The value comes first, then if.',
                def: '`def` must start a new line.',
                return: '`return` must start a new line, inside a def function.',
                pass: '`pass` must be on a line of its own.',
                lambda: 'A lambda must be a whole argument, for example ta.scan(na, lambda p: p + 1).',
            };
            return this.failAt(t, 'E-PARSE-UNEXPECTED', `Unexpected ${describe(t)} here.`, hints[t.value] ?? 'Check the line for a missing operator, comma or bracket.');
        }
        if (t.type === 'OP' && t.value === ',') {
            return this.failAt(t, 'E-PARSE-UNEXPECTED', 'Unexpected `,` here.', 'Several values on one line need brackets, for example (a, b). In a call, commas only separate arguments.');
        }
        if (afterValue && (t.type === 'NAME' || t.type === 'NUMBER' || t.type === 'STRING'))
            return twoValues();
        return this.failAt(t, 'E-PARSE-UNEXPECTED', `Unexpected ${describe(t)} here.`, 'Check the line for a missing operator, comma or bracket.');
    }
    /** Whether token k is the first on its line (after an indent or a line break). */
    startsLine(k) {
        const before = this.toks[k - 1];
        return !before || before.type === 'NEWLINE' || before.type === 'INDENT' || before.type === 'DEDENT';
    }
    /** A keyword written another way at the start of a line: refused with the keyword's name (a one-click fix when only the case differs). */
    failKeyword(t) {
        const meant = keywordMeant(t.value);
        if (!meant)
            return;
        const fix = meant.caseOnly ? [{ line: t.line, col: t.col, endCol: t.endCol, text: meant.keyword }] : undefined;
        this.failAt(t, 'E-PARSE-KEYWORD', meant.caseOnly ? `\`${t.value}\` is written in small letters here: ${meant.keyword}.` : `\`${t.value}\` is not a word this language knows.`, meant.caseOnly ? `Write ${meant.keyword}. Keywords are lower case.` : `Did you mean \`${meant.keyword}\`?${meant.keyword === 'elif' ? ' Write elif condition:.' : ''}`, fix);
    }
    /** Words from Chartink's scan language, read as two values in a row: what to write here (B8-7). */
    chartinkPhrase(t) {
        if (t.type !== 'NAME')
            return undefined;
        const prev = this.toks[this.pos - 1];
        const word = t.value.toLowerCase();
        if (word === 'crossed' || word === 'crosses') {
            return 'To test a cross write ta.crossover(a, b) for "a crossed above b", or ta.crossunder(a, b) for "crossed below".';
        }
        if (['day', 'days', 'candle', 'candles', 'bar', 'bars'].includes(word) && prev?.type === 'NUMBER') {
            return `An earlier candlestick is written with [ ]: "${prev.value} ${t.value} ago high" is high[${prev.value}].`;
        }
        if (prev?.type === 'NAME') {
            const p = prev.value.toLowerCase();
            if (p === 'gap')
                return 'A gap is measured with price.gap_pct(): write price.gap_pct() >= 2 for a gap up of 2% or more, price.gap_pct() <= -2 for a gap down.';
            if (p === 'latest')
                return '`latest` is not needed: close, high and the other prices are the latest candlestick already, for example close > ta.sma(close, 20).';
            if (p === 'weekly')
                return `A weekly value is read from tf("W"): tf("W").${t.value} is the last completed week's (last week's, in the middle of a week), and tf("W").${t.value}[1] the week before it.`;
            if (p === 'monthly')
                return `A monthly value is read from tf("M"): tf("M").${t.value} is the last completed month's, and tf("M").${t.value}[1] the month before it.`;
        }
        return undefined;
    }
    /** What stopped an expression early that is a known habit: AND in capitals, a single = to compare (B1-6, B1-8). */
    habitAfterExpr() {
        const t = this.peek();
        if (t.type === 'NAME' && LOGIC_WORDS.has(t.value))
            this.failLogic(t);
        if (t.type === 'OP' && t.value === '=') {
            this.failAt(t, 'E-PARSE-COMPARE-EQ', 'A single = sets a name; it cannot compare two values.', 'To compare, write ==, for example close == open.', [{ line: t.line, col: t.col, endCol: t.endCol, text: '==' }]);
        }
    }
    // ---- module and statements ----
    parseModule(comments) {
        const body = [];
        while (!this.is('EOF'))
            body.push(this.parseStatement(true));
        const span = body.length > 0
            ? spanFrom(body[0].span, body[body.length - 1].span)
            : { line: 1, col: 1, endLine: 1, endCol: 1, offset: 0, end: 0 };
        return { kind: 'Module', body, comments, span };
    }
    parseStatement(top) {
        const t = this.peek();
        if (t.type === 'INDENT')
            return this.unexpected(t);
        if (t.type === 'OP' && t.value === '@')
            return this.parseDecorated(top);
        if (t.type === 'KEYWORD') {
            switch (t.value) {
                case 'def': return this.parseDef(top, []);
                case 'if':
                    if (top) {
                        this.failAt(t, 'E-PARSE-TOP-IF', '`if` blocks must be inside a def function.', 'At the top level, write a if condition else b, or put the logic inside def.');
                    }
                    return this.parseIf();
                case 'return': return this.parseReturn(top);
                case 'pass': {
                    this.next();
                    this.endSimple();
                    return { kind: 'Pass', span: spanFrom(t, t) };
                }
                case 'for': return this.failHabit(PARSER_HABITS.forLoop, t);
                case 'elif':
                case 'else':
                    return this.failAt(t, 'E-PARSE-ELSE-ORPHAN', `\`${t.value}\` has no \`if\` before it.`, 'Start with an if line, then elif or else lines at the same indentation.');
            }
        }
        return this.parseSimple(t);
    }
    /** Consume the end of a one-line statement; returns nothing, fails if something else follows. */
    endSimple() {
        if (this.is('NEWLINE')) {
            this.next();
            return;
        }
        this.unexpected(this.peek());
    }
    looksLikeAssignment() {
        let k = 0;
        for (;;) {
            if (!this.is('NAME', k))
                return false;
            k++;
            if (this.isOp('=', k))
                return true;
            if (this.isOp(',', k)) {
                k++;
                continue;
            }
            return false;
        }
    }
    makeName(t) {
        if (t.value === 'na') {
            this.failAt(t, 'E-PARSE-RESERVED-NAME', '`na` is the missing-value literal and cannot be used as a name.', 'Choose another name.');
        }
        return { kind: 'Name', id: t.value, span: spanFrom(t, t) };
    }
    parseSimple(first) {
        // Pine's `var x = 0` (and `varip`): the word is not needed here.
        if (first.type === 'NAME' && (first.value === 'var' || first.value === 'varip') && this.is('NAME', 1)) {
            // `var x = 0` and `var float x = na`: the fix removes `var` (and Pine's type word) only when a name and = follow (B1-12).
            const typed = PINE_TYPES.has(this.peek(1).value) && this.is('NAME', 2);
            const nameTok = this.peek(typed ? 2 : 1);
            const eq = this.peek(typed ? 3 : 2);
            const fixable = nameTok.line === first.line && eq.type === 'OP' && eq.value === '=';
            // V-4 (2026-10-25): only a start value that is a constant keeps its meaning without `var`. `var x = close` is the FIRST
            // candlestick's close, kept for ever; `x = close` is today's. That gets a hint and no fix (a fix must be certain).
            let k = typed ? 3 : 2;
            if (this.isOp('-', k + 1))
                k++;
            const v = this.peek(k + 1);
            const constant = (v.type === 'NUMBER' || (v.type === 'NAME' && ['na', 'true', 'false', 'True', 'False'].includes(v.value))) && v.line === first.line;
            const after = this.peek(k + 2);
            const ends = after.type === 'NEWLINE' || after.type === 'EOF' || after.type === 'DEDENT' || after.line !== first.line;
            if (fixable && !(constant && ends)) {
                this.failAt(first, PINE_HABITS.var.code, '`var` is not used here: a name is set with name = value, and it is worked out again on every candlestick.', `Here the start value is not a fixed number, so removing var changes the meaning: Pine keeps the value from the first candlestick, without var it is today's. For a value kept from an event use ta.value_when(cond, x); for a running total ta.cum_sum(x); for the highest since an event ta.highest_since(cond, x).`);
            }
            this.failHabit(PINE_HABITS.var, first, fixable ? [{ line: first.line, col: first.col, endCol: nameTok.col, text: '' }] : undefined);
        }
        if (this.looksLikeAssignment()) {
            const targets = [];
            for (;;) {
                targets.push(this.makeName(this.next()));
                if (this.isOp(',')) {
                    this.next();
                    continue;
                }
                break;
            }
            this.next(); // =
            const value = this.parseExpr();
            if (this.isOp('=')) {
                this.failAt(this.peek(), 'E-PARSE-CHAINED-ASSIGN', 'Chained assignment is not available.', 'Write each assignment on its own line.');
            }
            const end = this.last();
            this.endSimple();
            const node = { kind: 'Assign', targets, value, span: spanFrom(first, end) };
            return node;
        }
        const value = this.parseExpr();
        const t = this.peek();
        if (t.type === 'OP') {
            // Pine's [a, b] = f(): the same names without the brackets split a group of values.
            if (t.value === '=' && value.kind === 'List' && value.elts.every((x) => x.kind === 'Name')) {
                const sp = value.span;
                // The whole `[a, b]` is replaced by the names, so spaces and a trailing comma inside the brackets go too (B1-12).
                const names = value.elts.map((x) => x.id).join(', ');
                this.failHabit(PINE_HABITS.tuple, sp, sp.endLine === sp.line ? [{ line: sp.line, col: sp.col, endCol: sp.endCol, text: names }] : undefined);
            }
            if (t.value === '=') {
                this.failAt(t, 'E-PARSE-ASSIGN-TARGET', 'The left side of = must be a plain name.', 'You can assign to names such as x = ..., not to x[1], x.y or a call. Give the result a new name.');
            }
            if (AUG_OPS.has(t.value))
                this.failHabit(PARSER_HABITS.augAssign, t);
            if (t.value === ':' && value.kind === 'Name') {
                // `Else:` or `esle:` at the start of a line: a keyword written another way, not a type note (B1-7).
                if (this.startsLine(this.pos - 1))
                    this.failKeyword(this.toks[this.pos - 1]);
                this.failAt(t, 'E-PARSE-ANNOTATION', 'Type notes on values are not used.', 'Write the assignment without the type, for example x = 3.');
            }
        }
        const end = this.last();
        this.endSimple();
        return { kind: 'ExprStmt', value, span: spanFrom(first, end) };
    }
    parseReturn(top) {
        const kw = this.next();
        if (top) {
            this.failAt(kw, 'E-PARSE-RETURN-TOP', '`return` can only be used inside a def function.', 'In a script without def, the last line is the result: just write the condition on its own.');
        }
        if (this.is('NEWLINE')) {
            this.failAt(kw, 'E-PARSE-RETURN-VALUE', '`return` needs a value.', 'Write return followed by the condition or value.');
        }
        let value = this.parseExpr();
        // `return a, b` gives back two values, as `return (a, b)` does (2026-10-25).
        if (this.isOp(',')) {
            const elts = [value];
            while (this.isOp(',')) {
                const comma = this.next();
                if (this.is('NEWLINE')) {
                    // `return x,` would give back a group of one value (B1-22).
                    if (elts.length === 1) {
                        this.failAt(comma, 'E-PARSE-RETURN-COMMA', 'A comma after the value would make a group of one value.', 'Remove the comma: return x. To give back two values write return a, b.', [{ line: comma.line, col: comma.col, endCol: comma.endCol, text: '' }]);
                    }
                    break;
                }
                elts.push(this.parseExpr());
            }
            value = { kind: 'Tuple', elts, span: spanFrom(elts[0].span, elts[elts.length - 1].span) };
        }
        const end = this.last();
        this.endSimple();
        return { kind: 'Return', value, span: spanFrom(kw, end) };
    }
    parseBlockAfterColon(what) {
        if (!this.isOp(':')) {
            if (what === 'if' || what === 'elif')
                this.habitAfterExpr();
            if (what === 'else' && this.isKw('if')) {
                // Pine's `else if`: one word here (B1-7).
                const e = this.toks[this.pos - 1];
                const f = this.peek();
                this.failAt(e, 'E-PARSE-ELSE-IF', '`else if` is written elif here.', 'Write elif condition:, at the same indent as the if.', e.line === f.line ? [{ line: e.line, col: e.col, endCol: f.endCol, text: 'elif' }] : undefined);
            }
            this.failAfter('E-PARSE-COLON', `A colon is missing at the end of this ${what} line.`, 'Add : at the end of the line.');
        }
        this.next();
        if (!this.is('NEWLINE')) {
            this.failExpected(this.peek(), 'E-PARSE-ONE-LINE-BLOCK', 'The block must start on the next line.', 'Press Enter after the colon and indent the lines of the block by 4 spaces.');
        }
        this.next();
        if (!this.is('INDENT')) {
            this.failExpected(this.peek(), 'E-PARSE-EXPECTED-INDENT', 'An indented block is expected here.', 'Indent the lines that belong to this block by 4 spaces.');
        }
        this.next();
        const stmts = [];
        while (!this.is('DEDENT') && !this.is('EOF'))
            stmts.push(this.parseStatement(false));
        if (this.is('DEDENT'))
            this.next();
        return stmts;
    }
    parseIf() {
        this.enter(this.peek());
        const kw = this.next();
        const test = this.parseExpr();
        const body = this.parseBlockAfterColon(kw.value);
        let orelse = [];
        let elseLine;
        if (this.isKw('elif')) {
            orelse = [this.parseIf()];
        }
        else if (this.isKw('else')) {
            const e = this.next();
            elseLine = e.line;
            orelse = this.parseBlockAfterColon('else');
        }
        this.leave();
        const lastStmt = orelse.length > 0 ? orelse[orelse.length - 1] : body[body.length - 1];
        const node = { kind: 'If', test, body, orelse, span: spanFrom(kw, lastStmt.span) };
        if (elseLine !== undefined)
            node.elseLine = elseLine;
        return node;
    }
    parseDecorated(top) {
        const decorators = [];
        while (this.isOp('@')) {
            const at = this.next();
            if (!top) {
                this.failAt(at, 'E-PARSE-NESTED-DEF', 'Script types such as @screener can only be used at the top of the script.', 'Put the def and its @ line outside other functions.');
            }
            if (decorators.length > 0) {
                this.failAt(at, 'E-PARSE-MANY-DECORATORS', 'Only one script type can be given for a function.', 'Keep a single @ line above the def.');
            }
            const nameTok = this.peek();
            if (nameTok.type !== 'NAME')
                this.failExpected(nameTok, 'E-PARSE-DECORATOR-NAME', 'A script type name is expected after @.', 'Use @screener, @indicator, @alert or @strategy.');
            this.next();
            if (this.isOp('.')) {
                this.failAt(this.peek(), 'E-PARSE-DECORATOR-NAME', 'A script type is a single name.', 'Use @screener, @indicator, @alert or @strategy.');
            }
            if (!ENTRY_KINDS.includes(nameTok.value)) {
                this.failAt(nameTok, 'E-PARSE-DECORATOR-UNKNOWN', `\`@${nameTok.value}\` is not a script type.`, 'Use @screener, @indicator, @alert or @strategy.');
            }
            let args = null;
            let end = nameTok;
            if (this.isOp('(')) {
                const open = this.next();
                args = this.parseCallArgs(open);
                end = this.last();
            }
            if (!this.is('NEWLINE'))
                this.unexpected(this.peek());
            this.next();
            decorators.push({ kind: 'Decorator', name: nameTok.value, args, span: spanFrom(at, end) });
        }
        if (!this.isKw('def')) {
            this.failExpected(this.peek(), 'E-PARSE-DECORATOR-TARGET', 'The @ line must be followed by a def line.', 'Write def name(): on the next line.');
        }
        return this.parseDef(top, decorators);
    }
    parseDef(top, decorators) {
        const defTok = this.next();
        if (!top) {
            this.failAt(defTok, 'E-PARSE-NESTED-DEF', 'A def inside another def is not available.', 'Put each def at the top of the script, outside other functions.');
        }
        const nameTok = this.peek();
        if (nameTok.type !== 'NAME')
            this.failExpected(nameTok, 'E-PARSE-DEF-NAME', 'A function name is expected after def.', 'Write def name(): .');
        this.next();
        // `def na(x):` would hide the missing value (B1-21), as a parameter called na would.
        if (nameTok.value === 'na')
            this.makeName(nameTok);
        if (!this.isOp('(')) {
            this.failAfter('E-PARSE-DEF-PARENS', 'The function name must be followed by ( ).', 'Write def name(): or def name(a, b): .');
        }
        const params = this.parseParams();
        if (this.isOp('->'))
            this.failHabit(PARSER_HABITS.returnAnnotation, this.peek());
        const body = this.parseBlockAfterColon('def');
        const start = decorators.length > 0 ? decorators[0].span : defTok;
        return {
            kind: 'FunctionDef',
            name: nameTok.value,
            params,
            body,
            decorators,
            defLine: defTok.line,
            span: spanFrom(start, body[body.length - 1].span),
        };
    }
    parseParams() {
        this.next(); // (
        const params = [];
        const seen = new Set();
        let sawDefault = false;
        while (!this.isOp(')')) {
            const t = this.peek();
            if (t.type === 'OP' && (t.value === '*' || t.value === '**')) {
                this.failAt(t, 'E-PARSE-STAR-PARAMS', 'Parameters with * or ** are not available.', 'List each parameter by name.');
            }
            if (t.type !== 'NAME')
                this.failExpected(t, 'E-PARSE-PARAM', 'A parameter name is expected here.', 'Write def name(a, b): with plain names.');
            this.next();
            if (t.value === 'na')
                this.makeName(t);
            if (seen.has(t.value))
                this.failAt(t, 'E-PARSE-DUP-PARAM', `The parameter \`${t.value}\` is given twice.`, 'Use a different name for each parameter.');
            seen.add(t.value);
            let annotation;
            if (this.isOp(':')) {
                this.next();
                const ty = this.peek();
                if (ty.type !== 'NAME')
                    this.failExpected(ty, 'E-PARSE-ANNOTATION', 'A type name is expected after the colon.', 'Write a: int, a: float, a: bool or a: str.');
                this.next();
                annotation = ty.value;
            }
            let def;
            if (this.isOp('=')) {
                this.next();
                def = this.parseExpr();
                sawDefault = true;
            }
            else if (sawDefault) {
                this.failAt(t, 'E-PARSE-PARAM-ORDER', 'A parameter without a default cannot follow one with a default.', 'Put the parameters with defaults last.');
            }
            const param = { kind: 'Param', name: t.value, span: spanFrom(t, this.last()) };
            if (annotation !== undefined)
                param.annotation = annotation;
            if (def !== undefined)
                param.default = def;
            params.push(param);
            if (this.isOp(',')) {
                this.next();
                continue;
            }
            break;
        }
        if (!this.isOp(')'))
            this.unexpected(this.peek());
        this.next();
        return params;
    }
    // ---- expressions ----
    parseExpr() {
        const t = this.peek();
        this.enter(t);
        let result;
        if (t.type === 'KEYWORD' && t.value === 'lambda') {
            result = this.parseLambda();
        }
        else {
            const body = this.parseOr();
            if (this.isKw('if')) {
                this.next();
                const test = this.parseOr();
                if (!this.isKw('else')) {
                    this.habitAfterExpr();
                    this.failAfter('E-PARSE-TERNARY', 'This `if` is missing its `else`.', 'Write a if condition else b. Both choices are needed.');
                }
                this.next();
                const orelse = this.parseExpr();
                result = { kind: 'IfExp', test, body, orelse, span: spanFrom(body.span, orelse.span) };
            }
            else {
                result = body;
            }
        }
        this.leave();
        return result;
    }
    parseLambda() {
        const kw = this.next();
        const params = [];
        if (!this.isOp(':')) {
            for (;;) {
                const p = this.peek();
                if (p.type === 'OP' && (p.value === '*' || p.value === '**')) {
                    this.failAt(p, 'E-PARSE-STAR-PARAMS', 'Parameters with * or ** are not available.', 'List each parameter by name.');
                }
                if (p.type !== 'NAME')
                    this.failExpected(p, 'E-PARSE-PARAM', 'A parameter name is expected here.', 'Write lambda x: expression.');
                this.next();
                if (p.value === 'na')
                    this.makeName(p);
                if (params.includes(p.value))
                    this.failAt(p, 'E-PARSE-DUP-PARAM', `The parameter \`${p.value}\` is given twice.`, 'Use a different name for each parameter.');
                params.push(p.value);
                if (this.isOp('='))
                    this.failAt(this.peek(), 'E-PARSE-LAMBDA-DEFAULT', 'Defaults are not available in a lambda.', 'Remove the = part.');
                if (this.isOp(',')) {
                    this.next();
                    continue;
                }
                break;
            }
        }
        if (!this.isOp(':'))
            this.failAfter('E-PARSE-COLON', 'A colon is missing after the lambda parameters.', 'Write lambda x: expression.');
        this.next();
        const body = this.parseExpr();
        return { kind: 'Lambda', params, body, span: spanFrom(kw, body.span) };
    }
    parseOr() {
        const first = this.parseAnd();
        if (!this.isKw('or'))
            return first;
        const values = [first];
        while (this.isKw('or')) {
            this.next();
            values.push(this.parseAnd());
        }
        return { kind: 'BoolOp', op: 'or', values, span: spanFrom(first.span, values[values.length - 1].span) };
    }
    parseAnd() {
        const first = this.parseNot();
        if (!this.isKw('and'))
            return first;
        const values = [first];
        while (this.isKw('and')) {
            this.next();
            values.push(this.parseNot());
        }
        return { kind: 'BoolOp', op: 'and', values, span: spanFrom(first.span, values[values.length - 1].span) };
    }
    parseNot() {
        if (this.isKw('not')) {
            const kw = this.next();
            this.enter(kw);
            const operand = this.parseNot();
            this.leave();
            return { kind: 'Unary', op: 'not', operand, span: spanFrom(kw, operand.span) };
        }
        return this.parseComparison();
    }
    parseComparison() {
        const left = this.parseSum();
        const ops = [];
        const comparators = [];
        while (this.peek().type === 'OP' && CMP_OPS.has(this.peek().value)) {
            ops.push(this.next().value);
            comparators.push(this.parseSum());
        }
        if (ops.length === 0)
            return left;
        return { kind: 'Compare', left, ops, comparators, span: spanFrom(left.span, comparators[comparators.length - 1].span) };
    }
    parseSum() {
        let left = this.parseTerm();
        while (this.isOp('+') || this.isOp('-')) {
            const op = this.next().value;
            const right = this.parseTerm();
            left = { kind: 'Binary', op, left, right, span: spanFrom(left.span, right.span) };
        }
        return left;
    }
    parseTerm() {
        let left = this.parseUnary();
        for (;;) {
            const t = this.peek();
            if (t.type !== 'OP')
                break;
            if (t.value === '@')
                this.failHabit(PARSER_HABITS.matmul, t);
            if (t.value !== '*' && t.value !== '/' && t.value !== '//' && t.value !== '%')
                break;
            this.next();
            const right = this.parseUnary();
            left = { kind: 'Binary', op: t.value, left, right, span: spanFrom(left.span, right.span) };
        }
        return left;
    }
    parseUnary() {
        const t = this.peek();
        if (t.type === 'OP' && (t.value === '-' || t.value === '+')) {
            this.next();
            this.enter(t);
            const operand = this.parseUnary();
            this.leave();
            return { kind: 'Unary', op: t.value, operand, span: spanFrom(t, operand.span) };
        }
        return this.parsePower();
    }
    parsePower() {
        const base = this.parsePostfix();
        if (this.isOp('**')) {
            const op = this.next();
            this.enter(op);
            const right = this.parseUnary();
            this.leave();
            return { kind: 'Binary', op: '**', left: base, right, span: spanFrom(base.span, right.span) };
        }
        return base;
    }
    parsePostfix() {
        let node = this.parseAtom();
        for (;;) {
            const t = this.peek();
            if (t.type !== 'OP')
                break;
            if (t.value === '(') {
                this.next();
                const args = this.parseCallArgs(t);
                node = { kind: 'Call', func: node, args, span: spanFrom(node.span, this.last()) };
            }
            else if (t.value === '[') {
                node = this.parseSubscript(node);
            }
            else if (t.value === '.') {
                this.next();
                const n = this.peek();
                if (n.type !== 'NAME')
                    this.failExpected(n, 'E-PARSE-ATTRIBUTE', 'A name is expected after the dot.', 'Write something like ta.sma or close.x .');
                this.next();
                node = { kind: 'Attribute', value: node, attr: n.value, span: spanFrom(node.span, n) };
            }
            else {
                break;
            }
        }
        return node;
    }
    /** Reads arguments after the opening bracket `open` and consumes the closing ). */
    parseCallArgs(open) {
        void open;
        const args = [];
        const seen = new Set();
        let sawKeyword = false;
        while (!this.isOp(')')) {
            const t = this.peek();
            if (t.type === 'OP' && (t.value === '*' || t.value === '**')) {
                this.failAt(t, 'E-PARSE-STAR-ARGS', 'Arguments with * or ** are not available.', 'Write each argument out.');
            }
            if (t.type === 'NAME' && this.isOp('=', 1)) {
                this.next();
                this.next();
                if (seen.has(t.value))
                    this.failAt(t, 'E-PARSE-DUP-KEYWORD', `The argument \`${t.value}\` is given twice.`, 'Give each named argument once.');
                seen.add(t.value);
                sawKeyword = true;
                const value = this.parseExpr();
                args.push({ kind: 'Arg', name: t.value, value, span: spanFrom(t, value.span) });
            }
            else {
                if (sawKeyword) {
                    this.failAt(t, 'E-PARSE-POSITIONAL-AFTER-KEYWORD', 'An argument without a name cannot follow one with a name.', 'Put the arguments without names first.');
                }
                const value = this.parseExpr();
                args.push({ kind: 'Arg', value, span: spanFrom(value.span, value.span) });
            }
            if (this.isOp(',')) {
                this.next();
                continue;
            }
            break;
        }
        if (!this.isOp(')'))
            this.unexpected(this.peek());
        this.next();
        return args;
    }
    parseSubscript(value) {
        const open = this.next(); // [
        if (this.isOp(']'))
            this.failAt(open, 'E-PARSE-EMPTY-INDEX', 'An index is needed inside [ ].', 'Write x[0] for the current candlestick or x[1] for the previous one.');
        if (this.isOp(':'))
            this.failHabit(PARSER_HABITS.slice, this.peek());
        const index = this.parseExpr();
        if (this.isOp(':'))
            this.failHabit(PARSER_HABITS.slice, this.peek());
        if (this.isOp(','))
            this.failAt(this.peek(), 'E-PARSE-MULTI-INDEX', 'Only one index is allowed inside [ ].', 'Use x[1] for one value back. For a window use ta.highest(x, n) or ta.sma(x, n).');
        if (!this.isOp(']'))
            this.unexpected(this.peek());
        const close = this.next();
        if (index.kind === 'Unary' && index.op === '-' && index.operand.kind === 'Number') {
            this.failHabit(PARSER_HABITS.negativeIndex, index.span);
        }
        return { kind: 'Subscript', value, index, span: spanFrom(value.span, close) };
    }
    parseAtom() {
        const t = this.peek();
        switch (t.type) {
            case 'NUMBER':
                this.next();
                return { kind: 'Number', value: t.num, raw: t.value, span: spanFrom(t, t) };
            case 'STRING':
                this.next();
                return { kind: 'String', value: t.str, span: spanFrom(t, t) };
            case 'NAME':
                this.next();
                return t.value === 'na' ? { kind: 'Na', span: spanFrom(t, t) } : { kind: 'Name', id: t.value, span: spanFrom(t, t) };
            case 'KEYWORD':
                if (t.value === 'True' || t.value === 'False') {
                    this.next();
                    return { kind: 'Bool', value: t.value === 'True', span: spanFrom(t, t) };
                }
                return this.unexpected(t);
            case 'OP':
                if (t.value === '(')
                    return this.parseGroup();
                if (t.value === '[')
                    return this.parseListComp();
                return this.unexpected(t);
            default:
                return this.unexpected(t);
        }
    }
    parseGroup() {
        const open = this.next();
        this.enter(open);
        if (this.isOp(')'))
            this.failAt(open, 'E-PARSE-EMPTY-BRACKETS', 'There is nothing inside these brackets.', 'Put an expression between ( and ).');
        const first = this.parseExpr();
        let result;
        if (this.isOp(',')) {
            const elts = [first];
            while (this.isOp(',')) {
                this.next();
                if (this.isOp(')'))
                    break;
                elts.push(this.parseExpr());
            }
            if (!this.isOp(')'))
                this.unexpected(this.peek());
            const close = this.next();
            result = { kind: 'Tuple', elts, span: spanFrom(open, close) };
        }
        else {
            if (!this.isOp(')'))
                this.unexpected(this.peek());
            const close = this.next();
            // Brackets only group; keep the inner node but widen its span to include them.
            result = { ...first, span: spanFrom(open, close) };
        }
        this.leave();
        return result;
    }
    parseListComp() {
        const open = this.next();
        this.enter(open);
        const listHelp = 'A list is written out, [a, b, c], or as [expression for i in range(n)]. Lists are used inside all, any, min, max, sum and avg.';
        if (this.isOp(']'))
            this.failAt(open, 'E-PARSE-LIST', 'Empty lists are not available.', listHelp);
        const elt = this.parseExpr();
        if (!this.isKw('for')) {
            // A list written out: [a, b, c] (a trailing comma is allowed).
            const elts = [elt];
            while (this.isOp(',')) {
                this.next();
                if (this.isOp(']'))
                    break;
                elts.push(this.parseExpr());
            }
            if (!this.isOp(']'))
                this.unexpected(this.peek());
            const close = this.next();
            this.leave();
            return { kind: 'List', elts, span: spanFrom(open, close) };
        }
        this.next();
        const tt = this.peek();
        if (tt.type !== 'NAME')
            this.failExpected(tt, 'E-PARSE-COMP-TARGET', 'A name is expected after for.', 'Write for i in range(3).');
        this.next();
        const target = this.makeName(tt);
        if (this.isOp(','))
            this.failAt(this.peek(), 'E-PARSE-COMP-TARGET', 'Only one name is allowed after for.', 'Write for i in range(3).');
        if (!this.isKw('in'))
            this.failExpected(this.peek(), 'E-PARSE-COMP-IN', 'The word `in` is missing.', 'Write for i in range(3).');
        this.next();
        const iter = this.parseOr();
        if (!(iter.kind === 'Call' && iter.func.kind === 'Name' && iter.func.id === 'range')) {
            this.failAt(iter.span, 'E-PARSE-COMP-ITER', 'Only range(...) can be used after `in`.', 'Write for i in range(3), where 3 is a fixed number.');
        }
        if (this.isKw('if')) {
            this.failAt(this.peek(), 'E-PARSE-COMP-IF', 'A condition after the range is not available.', 'Put the condition in the first part instead, for example [a if cond else b for i in range(3)].');
        }
        if (this.isKw('for')) {
            this.failAt(this.peek(), 'E-PARSE-COMP-NESTED', 'Only one `for` is allowed in a list.', 'Use separate lists, or give the inner list its own name.');
        }
        if (!this.isOp(']'))
            this.unexpected(this.peek());
        const close = this.next();
        this.leave();
        return { kind: 'ListComp', elt, target, iter, span: spanFrom(open, close) };
    }
}
function enforceLimits(module) {
    const r = measureTree(module, AST_MAX_NODES, AST_MAX_DEPTH);
    const bad = r.tooDeep ?? r.tooMany;
    if (!bad)
        return;
    const deep = !!r.tooDeep;
    throw new ScriptError({
        code: deep ? 'E-PARSE-TOO-DEEP' : 'E-PARSE-TOO-LARGE',
        message: deep
            ? `This is nested too deeply (the limit is ${AST_MAX_DEPTH} levels).`
            : `This script has too many parts (the limit is ${AST_MAX_NODES}).`,
        hint: deep
            ? 'Give part of the expression its own name on a separate line. Long chains of + count as nesting.'
            : 'Split the idea into smaller named values.',
        line: bad.span.line,
        col: bad.span.col,
        endCol: bad.span.endLine === bad.span.line ? Math.max(bad.span.endCol, bad.span.col + 1) : bad.span.col + 1,
        offset: bad.span.offset,
    });
}
/**
 * Read a script into a syntax tree. Throws ScriptError on the first problem and never anything
 * else. Comments are kept on `module.comments` so a formatter can keep them.
 */
export function parse(source, options = {}) {
    const { tokens, comments } = lex(source, options);
    try {
        const module = new Parser(tokens).parseModule(comments);
        enforceLimits(module);
        return module;
    }
    catch (e) {
        if (e instanceof RangeError) {
            throw new ScriptError({
                code: 'E-PARSE-TOO-DEEP',
                message: 'This is nested too deeply to read.',
                hint: 'Give part of the expression its own name on a separate line.',
                line: 1,
                col: 1,
                offset: 0,
            });
        }
        throw e;
    }
}
/** Like parse, but returns the error instead of throwing. For editors and tools. */
export function tryParse(source, options = {}) {
    try {
        return { module: parse(source, options) };
    }
    catch (e) {
        if (e instanceof ScriptError)
            return { error: e };
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
// ---- More than one problem (2026-10-25) ------------------------------------------------------------------------------------
/** Most problems reported for a script that cannot be read. */
export const MAX_SYNTAX_ERRORS = 5;
/** Problems after which the rest of the script cannot be read reliably: no second problem is looked for. */
const FINAL_CODES = new Set([
    'E-INTERNAL', 'E-LEX-TOO-LARGE', 'E-PARSE-TOO-LARGE', 'E-PARSE-TOO-DEEP', 'E-LEX-BRACKET', 'E-LEX-BRACKET-OPEN', 'E-LEX-BRACKET-DEEP', 'E-LEX-INDENT-DEEP',
]);
/** Problems with the indentation itself: the line is left out (blank) rather than replaced, since its indent is the problem. */
const INDENT_CODES = new Set(['E-LEX-DEDENT', 'E-LEX-TAB', 'E-PARSE-INDENT']);
function lineSpans(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 10 || c === 13) {
            out.push({ start, end: i });
            if (c === 13 && text.charCodeAt(i + 1) === 10)
                i++;
            start = i + 1;
        }
    }
    out.push({ start, end: text.length });
    return out;
}
/** Change in bracket depth over [from, to), and whether it ever went below zero. Text in quotes and comments is skipped. */
function bracketDepth(text, from, to) {
    let depth = 0;
    let negative = false;
    let quote = '';
    for (let i = from; i < to; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\')
                i++;
            else if (ch === quote || ch === '\n' || ch === '\r')
                quote = '';
            continue;
        }
        if (ch === '"' || ch === "'")
            quote = ch;
        else if (ch === '#') {
            while (i < to && text[i] !== '\n' && text[i] !== '\r')
                i++;
        }
        else if (ch === '(' || ch === '[' || ch === '{')
            depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            if (depth < 0)
                negative = true;
        }
    }
    return { depth, negative };
}
const leadingSpace = (s) => /^[ \t]*/.exec(s)?.[0] ?? '';
/**
 * The script with line `line` (1-based) replaced so it reads cleanly and the lines around it keep their meaning: `pass` at the
 * same indent, a line that opens a block (`def _():` at the top, `if True:` inside) when the next line is indented further, or
 * nothing when the indent itself is the problem. Null when the line is part of a statement over several lines (brackets
 * open before it or left open after it): then the next problem cannot be found reliably.
 */
function setLineAside(text, line, code) {
    const spans = lineSpans(text);
    const at = spans[line - 1];
    if (!at)
        return null;
    const before = bracketDepth(text, 0, at.start);
    const own = bracketDepth(text, at.start, at.end);
    if (before.depth !== 0 || own.depth !== 0 || own.negative)
        return null;
    const raw = text.slice(at.start, at.end);
    const indent = leadingSpace(raw);
    let filler;
    if (INDENT_CODES.has(code))
        filler = '';
    else {
        let next;
        for (const sp of spans.slice(line)) {
            const t = text.slice(sp.start, sp.end);
            if (t.trim() !== '' && !t.trimStart().startsWith('#')) {
                next = t;
                break;
            }
        }
        const opensBlock = next !== undefined && leadingSpace(next).replace(/\t/g, '    ').length > indent.replace(/\t/g, '    ').length;
        filler = indent + (opensBlock ? (indent === '' ? 'def _():' : 'if True:') : 'pass');
    }
    return text.slice(0, at.start) + filler + text.slice(at.end);
}
/** The error with its offset worked out again in the original script (only other lines were changed, so line and column hold). */
function relocate(e, source) {
    const at = lineSpans(source)[e.line - 1];
    if (!at)
        return e;
    return new ScriptError({ code: e.code, message: e.message, hint: e.hint, line: e.line, col: e.col, endCol: e.endCol, offset: Math.min(at.start + e.col - 1, source.length), ...(e.fix ? { fix: e.fix } : {}) });
}
/**
 * Like tryParse, but when the script cannot be read it looks for more problems, up to MAX_SYNTAX_ERRORS: the line with each
 * problem is set aside and the script read again from the start. It stops early when a problem spans several lines, or when the
 * next problem is on a line already looked at or just after it (it would only be a consequence of setting the line aside).
 * The first problem is always the one tryParse reports.
 */
export function tryParseAll(source, options = {}) {
    const first = tryParse(source, options);
    if (first.module)
        return { module: first.module, errors: [] };
    const errors = [first.error];
    let text = source;
    const lines = new Set();
    while (errors.length < MAX_SYNTAX_ERRORS) {
        const last = errors[errors.length - 1];
        if (FINAL_CODES.has(last.code))
            break;
        const next = setLineAside(text, last.line, last.code);
        if (next === null)
            break;
        lines.add(last.line);
        text = next;
        const r = tryParse(text, options);
        if (r.module || !r.error)
            break;
        const e = r.error;
        if (e.line <= last.line || lines.has(e.line))
            break;
        // Right after a block opener that was set aside, an indent problem is the setting aside, not the script.
        if (e.line === last.line + 1 && (INDENT_CODES.has(e.code) || e.code === 'E-PARSE-EXPECTED-INDENT'))
            break;
        errors.push(relocate(e, source));
    }
    return { errors };
}
