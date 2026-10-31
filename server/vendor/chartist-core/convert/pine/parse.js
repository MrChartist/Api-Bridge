// Pine Script reader for the importer: a lexer and a recursive-descent parser for the subset of Pine Script v4, v5 and v6 that
// the converter maps (docs/features/script-import/README.md). Written from the public Pine Script reference manual; no code from
// any other Pine implementation. A statement that cannot be read becomes an `opaque` node with its lines, so one odd line never
// sinks the whole file.
// ---- Lexer -----------------------------------------------------------------------------------------------------------------
const OPS3 = ['...'];
const OPS2 = [':=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%='];
const OPS1 = '+-*/%<>=?:,.()[]';
export class PineSyntaxError extends Error {
    line;
    constructor(message, line) {
        super(message);
        this.line = line;
    }
}
/** Tokens of one physical line (comments already removed). */
function lexLine(text, line) {
    const out = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\r') {
            i++;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
            const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
            const raw = m ? m[0] : c;
            out.push({ t: 'num', v: raw, line });
            i += raw.length;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
            const raw = m ? m[0] : c;
            out.push({ t: 'name', v: raw, line });
            i += raw.length;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            let body = '';
            while (j < n && text[j] !== c) {
                if (text[j] === '\\' && j + 1 < n) {
                    const e = text[j + 1];
                    body += e === 'n' ? '\n' : e === 't' ? '\t' : e;
                    j += 2;
                    continue;
                }
                body += text[j];
                j++;
            }
            if (j >= n)
                throw new PineSyntaxError('A text is not closed.', line);
            out.push({ t: 'str', v: body, line });
            i = j + 1;
            continue;
        }
        if (c === '#') {
            const m = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?/.exec(text.slice(i));
            if (!m)
                throw new PineSyntaxError('`#` here is not a colour.', line);
            out.push({ t: 'hex', v: m[0], line });
            i += m[0].length;
            continue;
        }
        const three = text.slice(i, i + 3);
        if (OPS3.includes(three)) {
            out.push({ t: 'op', v: three, line });
            i += 3;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (OPS2.includes(two)) {
            out.push({ t: 'op', v: two, line });
            i += 2;
            continue;
        }
        if (OPS1.includes(c)) {
            out.push({ t: 'op', v: c, line });
            i++;
            continue;
        }
        throw new PineSyntaxError(`Unexpected character \`${c}\`.`, line);
    }
    return out;
}
/** Split a physical line into code and its `//` comment (a `//` inside a text is code). */
function splitComment(text) {
    let q = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '\\')
                i++;
            else if (c === q)
                q = null;
            continue;
        }
        if (c === '"' || c === "'")
            q = c;
        else if (c === '/' && text[i + 1] === '/')
            return { code: text.slice(0, i), comment: text.slice(i + 2) };
    }
    return { code: text, comment: null };
}
function indentOf(text) {
    let w = 0;
    for (const c of text) {
        if (c === ' ')
            w++;
        else if (c === '\t')
            w += 4;
        else
            break;
    }
    return w;
}
const CONTINUES_AFTER = new Set(['+', '-', '*', '/', '%', '?', ':', ',', '=', ':=', '==', '!=', '<', '>', '<=', '>=', 'and', 'or', 'not', '(', '[']);
function logicalLines(source) {
    const physical = source.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let version = null;
    let depth = 0;
    for (let idx = 0; idx < physical.length; idx++) {
        const raw = physical[idx];
        const lineNo = idx + 1;
        const { code, comment } = splitComment(raw);
        if (comment !== null) {
            const vm = /^@version\s*=\s*(\d+)/.exec(comment.trim());
            if (vm) {
                version = Number(vm[1]);
                if (!code.trim())
                    continue;
            }
        }
        if (!code.trim()) {
            if (comment !== null && depth === 0 && !/^@version/.test(comment.trim())) {
                out.push({ indent: indentOf(raw), toks: [], line: lineNo, endLine: lineNo, text: raw, comment: comment.trim() });
            }
            continue;
        }
        let toks;
        let lexError;
        try {
            toks = lexLine(code, lineNo);
        }
        catch (err) {
            toks = [{ t: 'name', v: '__unreadable__', line: lineNo }];
            lexError = err instanceof Error ? err.message : 'unreadable';
        }
        const indent = indentOf(code);
        const prev = [...out].reverse().find((l) => !l.comment);
        const last = prev?.toks[prev.toks.length - 1];
        const continues = prev !== undefined &&
            (depth > 0 ||
                (indent > prev.indent && indent % 4 !== 0) ||
                (last !== undefined && CONTINUES_AFTER.has(last.v) && !(last.v === '=' && false)));
        if (continues && prev) {
            prev.toks.push(...toks);
            prev.endLine = lineNo;
            prev.text += '\n' + code;
        }
        else {
            out.push({ indent, toks, line: lineNo, endLine: lineNo, text: code, ...(lexError ? { error: lexError } : {}) });
        }
        if (lexError && continues && prev)
            prev.error = lexError;
        for (const t of toks) {
            if (t.t !== 'op')
                continue;
            if (t.v === '(' || t.v === '[')
                depth++;
            else if ((t.v === ')' || t.v === ']') && depth > 0)
                depth--;
        }
    }
    return { lines: out, version, physical };
}
// ---- Expressions -----------------------------------------------------------------------------------------------------------
class ExprParser {
    toks;
    line;
    i = 0;
    constructor(toks, line) {
        this.toks = toks;
        this.line = line;
    }
    peek(o = 0) {
        return this.toks[this.i + o];
    }
    is(v, o = 0) {
        const t = this.peek(o);
        return t !== undefined && (t.t === 'op' || t.t === 'name') && t.v === v;
    }
    next() {
        const t = this.toks[this.i++];
        if (!t)
            throw new PineSyntaxError('The line ends too early.', this.line);
        return t;
    }
    expect(v) {
        const t = this.next();
        if (t.v !== v)
            throw new PineSyntaxError(`Expected \`${v}\`, found \`${t.v}\`.`, t.line);
    }
    done() {
        return this.i >= this.toks.length;
    }
    expr() {
        return this.ternary();
    }
    ternary() {
        const c = this.or();
        if (this.is('?')) {
            this.next();
            const a = this.ternary();
            this.expect(':');
            const b = this.ternary();
            return { k: 'tern', c, a, b, line: c.line };
        }
        return c;
    }
    or() {
        let l = this.and();
        while (this.is('or')) {
            this.next();
            const r = this.and();
            l = { k: 'bin', op: 'or', l, r, line: l.line };
        }
        return l;
    }
    and() {
        let l = this.eq();
        while (this.is('and')) {
            this.next();
            const r = this.eq();
            l = { k: 'bin', op: 'and', l, r, line: l.line };
        }
        return l;
    }
    eq() {
        let l = this.cmp();
        while (this.is('==') || this.is('!=')) {
            const op = this.next().v;
            const r = this.cmp();
            l = { k: 'bin', op, l, r, line: l.line };
        }
        return l;
    }
    cmp() {
        let l = this.add();
        while (this.is('<') || this.is('>') || this.is('<=') || this.is('>=')) {
            const op = this.next().v;
            const r = this.add();
            l = { k: 'bin', op, l, r, line: l.line };
        }
        return l;
    }
    add() {
        let l = this.mul();
        while (this.is('+') || this.is('-')) {
            const op = this.next().v;
            const r = this.mul();
            l = { k: 'bin', op, l, r, line: l.line };
        }
        return l;
    }
    mul() {
        let l = this.unary();
        while (this.is('*') || this.is('/') || this.is('%')) {
            const op = this.next().v;
            const r = this.unary();
            l = { k: 'bin', op, l, r, line: l.line };
        }
        return l;
    }
    unary() {
        if (this.is('-') || this.is('+') || this.is('not')) {
            const t = this.next();
            const x = this.unary();
            return { k: 'un', op: t.v, x, line: t.line };
        }
        return this.postfix();
    }
    postfix() {
        let x = this.atom();
        for (;;) {
            if (this.is('.')) {
                this.next();
                const t = this.next();
                if (t.t !== 'name')
                    throw new PineSyntaxError('A name must follow `.`.', t.line);
                x = x.k === 'name' ? { k: 'name', id: `${x.id}.${t.v}`, line: x.line } : { k: 'member', x, name: t.v, line: x.line };
                continue;
            }
            // A type argument, as in array.new<float>(...): read and dropped.
            if (this.is('<') && x.k === 'name' && this.peek(1)?.t === 'name' && this.peek(2)?.v === '>' && this.peek(3)?.v === '(') {
                this.i += 3;
                continue;
            }
            if (this.is('(')) {
                this.next();
                const args = [];
                while (!this.is(')')) {
                    if (this.peek()?.t === 'name' && this.is('=', 1)) {
                        const name = this.next().v;
                        this.next();
                        args.push({ name, value: this.expr() });
                    }
                    else {
                        args.push({ value: this.expr() });
                    }
                    if (this.is(','))
                        this.next();
                    else if (!this.is(')'))
                        throw new PineSyntaxError('Expected `,` or `)` in a call.', this.peek()?.line ?? this.line);
                }
                this.expect(')');
                x = { k: 'call', fn: x.k === 'name' ? x.id : null, callee: x, args, line: x.line };
                continue;
            }
            if (this.is('[')) {
                this.next();
                const i = this.expr();
                this.expect(']');
                x = { k: 'index', x, i, line: x.line };
                continue;
            }
            return x;
        }
    }
    atom() {
        const t = this.next();
        if (t.t === 'num')
            return { k: 'num', v: Number(t.v), raw: t.v, line: t.line };
        if (t.t === 'str')
            return { k: 'str', v: t.v, line: t.line };
        if (t.t === 'hex')
            return { k: 'hex', v: t.v, line: t.line };
        if (t.t === 'name') {
            if (t.v === 'true' || t.v === 'false')
                return { k: 'bool', v: t.v === 'true', line: t.line };
            if (t.v === 'na' && !this.is('('))
                return { k: 'na', line: t.line };
            return { k: 'name', id: t.v, line: t.line };
        }
        if (t.v === '(') {
            const e = this.expr();
            this.expect(')');
            return e;
        }
        if (t.v === '[') {
            const items = [];
            while (!this.is(']')) {
                items.push(this.expr());
                if (this.is(','))
                    this.next();
                else if (!this.is(']'))
                    throw new PineSyntaxError('Expected `,` or `]`.', this.peek()?.line ?? t.line);
            }
            this.expect(']');
            return { k: 'list', items, line: t.line };
        }
        throw new PineSyntaxError(`Unexpected \`${t.v}\`.`, t.line);
    }
}
function parseExprToks(toks, line) {
    const p = new ExprParser(toks, line);
    const e = p.expr();
    if (!p.done())
        throw new PineSyntaxError(`Unexpected \`${p.peek()?.v}\` after the value.`, p.peek()?.line ?? line);
    return e;
}
// ---- Statements ------------------------------------------------------------------------------------------------------------
const TYPE_WORDS = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table', 'linefill', 'polyline', 'array', 'matrix', 'map', 'chart']);
const QUALIFIERS = new Set(['series', 'simple', 'const', 'input']);
class StmtParser {
    ll;
    constructor(ll) {
        this.ll = ll;
    }
    i = 0;
    /** Statements at indentation deeper than `parentIndent`, until a line at or above it. */
    block(parentIndent) {
        const out = [];
        while (this.i < this.ll.length) {
            const l = this.ll[this.i];
            if (l.comment !== undefined) {
                if (l.indent <= parentIndent && parentIndent >= 0)
                    break;
                out.push({ k: 'comment', text: l.comment, line: l.line });
                this.i++;
                continue;
            }
            if (l.indent <= parentIndent)
                break;
            out.push(this.statement());
        }
        return out;
    }
    /** The child lines of the line at this.i - 1 (indented deeper than `indent`). */
    children(indent) {
        return this.block(indent);
    }
    /** Skip the child lines of a statement that is being refused; returns the last line. */
    skipChildren(indent, endLine) {
        let end = endLine;
        while (this.i < this.ll.length) {
            const l = this.ll[this.i];
            if (l.indent <= indent && l.comment === undefined)
                break;
            if (l.indent <= indent && l.comment !== undefined)
                break;
            end = l.endLine;
            this.i++;
        }
        return end;
    }
    lastLine(stmts, fallback) {
        let end = fallback;
        for (const s of stmts)
            end = Math.max(end, 'endLine' in s ? s.endLine : s.line);
        return end;
    }
    statement() {
        const l = this.ll[this.i++];
        try {
            if (l.error)
                throw new PineSyntaxError(l.error, l.line);
            return this.statementOf(l);
        }
        catch (err) {
            const end = this.skipChildren(l.indent, l.endLine);
            const reason = err instanceof Error ? err.message : 'unknown';
            return { k: 'opaque', text: l.text.trim(), reason, what: 'unreadable', line: l.line, endLine: end };
        }
    }
    statementOf(l) {
        const t = l.toks;
        const first = t[0];
        if (first.t === 'name') {
            switch (first.v) {
                case 'if':
                    return this.ifStmt(l);
                case 'for':
                    return this.forStmt(l);
                case 'while':
                case 'type':
                case 'method':
                case 'import':
                case 'export':
                case 'enum': {
                    const end = this.skipChildren(l.indent, l.endLine);
                    return { k: 'opaque', text: l.text.trim(), reason: first.v, what: first.v, line: l.line, endLine: end };
                }
                case 'switch': {
                    const e = this.switchExpr(l, t.slice(1));
                    return { k: 'expr', e, line: l.line, endLine: e.k === 'switch' ? e.endLine : l.endLine };
                }
                default:
                    break;
            }
        }
        // Function definition: name(params) => ...
        if (first.t === 'name' && t[1]?.v === '(') {
            const close = matching(t, 1);
            if (close > 0 && t[close + 1]?.v === '=>')
                return this.funcDef(l, close);
        }
        // Tuple assignment: [a, b] = expr
        if (first.v === '[' && first.t === 'op') {
            const close = matching(t, 0);
            if (close > 0 && (t[close + 1]?.v === '=' || t[close + 1]?.v === ':=')) {
                const names = t
                    .slice(1, close)
                    .filter((x) => x.t === 'name')
                    .map((x) => x.v);
                const value = this.rhs(l, t.slice(close + 2));
                return { k: 'assign', targets: names, tuple: true, op: '=', value, decl: null, type: null, line: l.line, endLine: this.endOf(value, l) };
            }
        }
        // Declarations: [var|varip] [qualifier] [type] name = expr
        let j = 0;
        let decl = null;
        let type = null;
        if (t[j]?.t === 'name' && (t[j].v === 'var' || t[j].v === 'varip')) {
            decl = t[j].v;
            j++;
        }
        if (t[j]?.t === 'name' && QUALIFIERS.has(t[j].v) && t[j + 1]?.t === 'name')
            j++;
        if (t[j]?.t === 'name' && TYPE_WORDS.has(t[j].v) && (t[j + 1]?.t === 'name' || t[j + 1]?.v === '<' || t[j + 1]?.v === '[')) {
            type = t[j].v;
            j++;
            if (t[j]?.v === '<') {
                while (j < t.length && t[j].v !== '>')
                    j++;
                j++;
            }
            if (t[j]?.v === '[' && t[j + 1]?.v === ']')
                j += 2;
        }
        if (t[j]?.t === 'name' && t[j + 1]?.t === 'op' && ['=', ':=', '+=', '-=', '*=', '/=', '%='].includes(t[j + 1].v)) {
            const name = t[j].v;
            const op = t[j + 1].v;
            const value = this.rhs(l, t.slice(j + 2));
            return { k: 'assign', targets: [name], tuple: false, op, value, decl, type, line: l.line, endLine: this.endOf(value, l) };
        }
        if (decl || type)
            throw new PineSyntaxError('A declaration needs `name = value`.', l.line);
        const e = parseExprToks(t, l.line);
        return { k: 'expr', e, line: l.line, endLine: l.endLine };
    }
    endOf(e, l) {
        return e.k === 'switch' || e.k === 'ifx' ? Math.max(e.endLine, l.endLine) : l.endLine;
    }
    /** The value of an assignment: an expression, or a `switch` / `if` block. */
    rhs(l, toks) {
        if (toks[0]?.t === 'name' && toks[0].v === 'switch')
            return this.switchExpr(l, toks.slice(1));
        if (toks[0]?.t === 'name' && toks[0].v === 'if')
            return this.ifExpr(l, toks.slice(1));
        return parseExprToks(toks, l.line);
    }
    switchExpr(l, subjectToks) {
        const subject = subjectToks.length ? parseExprToks(subjectToks, l.line) : null;
        const arms = [];
        let end = l.endLine;
        while (this.i < this.ll.length) {
            const a = this.ll[this.i];
            if (a.comment !== undefined) {
                if (a.indent <= l.indent)
                    break;
                this.i++;
                continue;
            }
            if (a.indent <= l.indent)
                break;
            this.i++;
            const k = a.toks.findIndex((x) => x.t === 'op' && x.v === '=>');
            if (k < 0)
                throw new PineSyntaxError('A switch line needs `=>`.', a.line);
            const when = k === 0 ? null : parseExprToks(a.toks.slice(0, k), a.line);
            const rest = a.toks.slice(k + 1);
            if (!rest.length)
                throw new PineSyntaxError('A switch arm with a block of lines is not converted.', a.line);
            arms.push({ when, value: parseExprToks(rest, a.line), line: a.line });
            end = a.endLine;
        }
        return { k: 'switch', subject, arms, line: l.line, endLine: end };
    }
    /** `x = if cond` with value lines: each branch must end in a value line. */
    ifExpr(l, condToks) {
        const branches = [];
        let cond = parseExprToks(condToks, l.line);
        let indent = l.indent;
        let line = l.line;
        for (;;) {
            const body = this.block(indent);
            const last = body[body.length - 1];
            if (!last || last.k !== 'expr' || body.length !== 1)
                throw new PineSyntaxError('An `if` used as a value is converted only when each branch is one value.', line);
            branches.push({ cond, value: last.e, line });
            const nx = this.ll[this.i];
            if (nx && nx.comment === undefined && nx.indent === indent && nx.toks[0]?.v === 'else') {
                this.i++;
                line = nx.line;
                indent = nx.indent;
                if (nx.toks[1]?.v === 'if') {
                    cond = parseExprToks(nx.toks.slice(2), nx.line);
                    continue;
                }
                cond = null;
                const b2 = this.block(indent);
                const l2 = b2[b2.length - 1];
                if (!l2 || l2.k !== 'expr' || b2.length !== 1)
                    throw new PineSyntaxError('An `if` used as a value is converted only when each branch is one value.', line);
                branches.push({ cond: null, value: l2.e, line });
            }
            break;
        }
        const endLine = this.ll[this.i - 1]?.endLine ?? l.endLine;
        return { k: 'ifx', branches, line: l.line, endLine };
    }
    ifStmt(l) {
        const cond = parseExprToks(l.toks.slice(1), l.line);
        const body = this.children(l.indent);
        const elifs = [];
        let orelse = null;
        let end = this.lastLine(body, l.endLine);
        while (this.i < this.ll.length) {
            const nx = this.ll[this.i];
            if (nx.comment !== undefined || nx.indent !== l.indent || nx.toks[0]?.v !== 'else')
                break;
            this.i++;
            if (nx.toks[1]?.v === 'if') {
                const c = parseExprToks(nx.toks.slice(2), nx.line);
                const b = this.children(nx.indent);
                elifs.push({ cond: c, body: b, line: nx.line });
                end = this.lastLine(b, nx.endLine);
            }
            else {
                orelse = this.children(nx.indent);
                end = this.lastLine(orelse, nx.endLine);
                break;
            }
        }
        return { k: 'if', cond, body, elifs, orelse, line: l.line, endLine: end };
    }
    forStmt(l) {
        const t = l.toks;
        if (t[1]?.t === 'name' && t[2]?.v === '=') {
            const toIdx = t.findIndex((x, n) => n > 2 && x.t === 'name' && x.v === 'to');
            if (toIdx < 0)
                throw new PineSyntaxError('`for` needs `to`.', l.line);
            const byIdx = t.findIndex((x, n) => n > toIdx && x.t === 'name' && x.v === 'by');
            const from = parseExprToks(t.slice(3, toIdx), l.line);
            const to = parseExprToks(t.slice(toIdx + 1, byIdx < 0 ? t.length : byIdx), l.line);
            const by = byIdx < 0 ? null : parseExprToks(t.slice(byIdx + 1), l.line);
            const body = this.children(l.indent);
            return { k: 'for', v: t[1].v, from, to, by, body, line: l.line, endLine: this.lastLine(body, l.endLine) };
        }
        const end = this.skipChildren(l.indent, l.endLine);
        return { k: 'opaque', text: l.text.trim(), reason: 'for-in', what: 'for', line: l.line, endLine: end };
    }
    funcDef(l, close) {
        const t = l.toks;
        const params = [];
        let j = 2;
        while (j < close) {
            // skip type words in parameter lists (v5: `f(float x) =>`)
            while (j < close && t[j].t === 'name' && (TYPE_WORDS.has(t[j].v) || QUALIFIERS.has(t[j].v)) && t[j + 1]?.t === 'name')
                j++;
            const name = t[j];
            if (name.t !== 'name')
                throw new PineSyntaxError('A parameter must be a name.', l.line);
            j++;
            let def = null;
            if (t[j]?.v === '=') {
                let k = j + 1;
                let depth = 0;
                while (k < close && !(depth === 0 && t[k].v === ',')) {
                    if (t[k].v === '(' || t[k].v === '[')
                        depth++;
                    if (t[k].v === ')' || t[k].v === ']')
                        depth--;
                    k++;
                }
                def = parseExprToks(t.slice(j + 1, k), l.line);
                j = k;
            }
            params.push({ name: name.v, def });
            if (t[j]?.v === ',')
                j++;
        }
        const rest = t.slice(close + 2);
        if (rest.length) {
            const e = parseExprToks(rest, l.line);
            return { k: 'func', name: t[0].v, params, body: [{ k: 'expr', e, line: l.line, endLine: l.endLine }], line: l.line, endLine: l.endLine };
        }
        const body = this.children(l.indent);
        return { k: 'func', name: t[0].v, params, body, line: l.line, endLine: this.lastLine(body, l.endLine) };
    }
}
function matching(t, open) {
    let depth = 0;
    for (let i = open; i < t.length; i++) {
        if (t[i].t !== 'op')
            continue;
        if (t[i].v === '(' || t[i].v === '[')
            depth++;
        else if (t[i].v === ')' || t[i].v === ']') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
/** Read a Pine Script file. Never throws: unreadable statements become `opaque` nodes. */
export function parsePine(source) {
    let ll;
    let version;
    let physical;
    try {
        const r = logicalLines(source);
        ll = r.lines;
        version = r.version;
        physical = r.physical;
    }
    catch (err) {
        const line = err instanceof PineSyntaxError ? err.line : 1;
        physical = source.split('\n');
        return {
            version: null,
            lines: physical,
            body: [{ k: 'opaque', text: physical[line - 1] ?? '', reason: err instanceof Error ? err.message : 'unreadable', what: 'unreadable', line, endLine: physical.length }],
        };
    }
    const p = new StmtParser(ll);
    // Top-level lines may be indented by mistake; treat the smallest indent as the top level.
    const base = Math.min(...ll.filter((l) => l.comment === undefined).map((l) => l.indent), 0);
    const body = [];
    while (p.i < ll.length) {
        const before = p.i;
        body.push(...p.block(base - 1));
        if (p.i === before) {
            // a line indented less than the first: read it as top level
            body.push(p.statement());
        }
    }
    return { version, body, lines: physical };
}
