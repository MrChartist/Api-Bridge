import { parse } from './parser.js';
// Binding strength, lowest first. A child is wrapped in brackets when it binds more loosely
// than its parent needs, so the printed text always reads back as the same tree.
const P_LAMBDA = 0;
const P_TERNARY = 1;
const P_OR = 2;
const P_AND = 3;
const P_NOT = 4;
const P_COMPARE = 5;
const P_ADD = 6;
const P_MUL = 7;
const P_UNARY = 8;
const P_POWER = 9;
const P_ATOM = 10;
function precOf(e) {
    switch (e.kind) {
        case 'Lambda': return P_LAMBDA;
        case 'IfExp': return P_TERNARY;
        case 'BoolOp': return e.op === 'or' ? P_OR : P_AND;
        case 'Compare': return P_COMPARE;
        case 'Unary': return e.op === 'not' ? P_NOT : P_UNARY;
        case 'Binary':
            if (e.op === '**')
                return P_POWER;
            return e.op === '+' || e.op === '-' ? P_ADD : P_MUL;
        default: return P_ATOM;
    }
}
function quote(s) {
    let out = '"';
    for (const ch of s) {
        switch (ch) {
            case '\\':
                out += '\\\\';
                break;
            case '"':
                out += '\\"';
                break;
            case '\n':
                out += '\\n';
                break;
            case '\t':
                out += '\\t';
                break;
            default: out += ch;
        }
    }
    return out + '"';
}
const at = (e, min) => (precOf(e) < min ? `(${raw(e)})` : raw(e));
function arg(a) {
    return a.name !== undefined ? `${a.name}=${at(a.value, P_LAMBDA)}` : at(a.value, P_LAMBDA);
}
function raw(e) {
    switch (e.kind) {
        case 'Number': return e.raw;
        case 'String': return quote(e.value);
        case 'Bool': return e.value ? 'True' : 'False';
        case 'Na': return 'na';
        case 'Name': return e.id;
        case 'Attribute':
            // A number followed by a dot would read as a decimal point.
            return `${e.value.kind === 'Number' ? `(${e.value.raw})` : at(e.value, P_ATOM)}.${e.attr}`;
        case 'Subscript': return `${at(e.value, P_ATOM)}[${at(e.index, P_LAMBDA)}]`;
        case 'Call': return `${at(e.func, P_ATOM)}(${e.args.map(arg).join(', ')})`;
        case 'Unary':
            return e.op === 'not' ? `not ${at(e.operand, P_NOT)}` : `${e.op}${at(e.operand, P_UNARY)}`;
        case 'Binary': {
            if (e.op === '**')
                return `${at(e.left, P_ATOM)} ** ${at(e.right, P_UNARY)}`;
            const p = e.op === '+' || e.op === '-' ? P_ADD : P_MUL;
            return `${at(e.left, p)} ${e.op} ${at(e.right, p + 1)}`;
        }
        case 'BoolOp': {
            const p = e.op === 'or' ? P_OR : P_AND;
            return e.values.map((v) => at(v, p + 1)).join(` ${e.op} `);
        }
        case 'Compare': {
            let s = at(e.left, P_ADD);
            e.ops.forEach((op, i) => {
                s += ` ${op} ${at(e.comparators[i], P_ADD)}`;
            });
            return s;
        }
        case 'IfExp': return `${at(e.body, P_OR)} if ${at(e.test, P_OR)} else ${at(e.orelse, P_TERNARY)}`;
        case 'Tuple': return `(${e.elts.map((x) => at(x, P_LAMBDA)).join(', ')}${e.elts.length === 1 ? ',' : ''})`;
        case 'ListComp': return `[${at(e.elt, P_LAMBDA)} for ${e.target.id} in ${at(e.iter, P_LAMBDA)}]`;
        case 'List': return `[${e.elts.map((x) => at(x, P_LAMBDA)).join(', ')}]`;
        case 'Lambda': return `lambda${e.params.length > 0 ? ' ' + e.params.join(', ') : ''}: ${at(e.body, P_LAMBDA)}`;
    }
}
/** Print one expression in the canonical style. */
export function formatExpr(e) {
    return raw(e);
}
function param(p) {
    let s = p.name;
    if (p.annotation !== undefined)
        s += `: ${p.annotation}`;
    if (p.default !== undefined)
        s += (p.annotation !== undefined ? ' = ' : '=') + at(p.default, P_LAMBDA);
    return s;
}
const INDENT = '    ';
class Formatter {
    comments;
    out = [];
    taken;
    /** Original line of the last item printed in the current block; 0 means none yet. */
    lastLine = 0;
    constructor(comments) {
        this.comments = comments;
        this.taken = comments.map(() => false);
    }
    take(pred) {
        const found = [];
        this.comments.forEach((c, i) => {
            if (!this.taken[i] && pred(c)) {
                this.taken[i] = true;
                found.push(c);
            }
        });
        return found;
    }
    /** Keep one blank line where the source had at least one between two items. */
    gapBefore(line) {
        if (this.lastLine > 0 && line - this.lastLine > 1 && this.out.length > 0 && this.out[this.out.length - 1] !== '') {
            this.out.push('');
        }
    }
    comment(c, pad) {
        this.gapBefore(c.line);
        this.out.push(pad + c.text);
        this.lastLine = c.line;
    }
    /** Print a line followed by any trailing comments: the first on the same line, the rest below. */
    lineWithComments(text, pad, cs) {
        this.out.push(cs.length > 0 ? `${text}  ${cs[0].text}` : text);
        for (const c of cs.slice(1))
            this.out.push(pad + c.text);
        for (const c of cs)
            this.lastLine = Math.max(this.lastLine, c.line);
    }
    block(stmts, indent, limitLine, isModule) {
        const pad = INDENT.repeat(indent);
        if (!isModule)
            this.lastLine = 0;
        stmts.forEach((s, i) => {
            const nextLine = i + 1 < stmts.length ? stmts[i + 1].span.line : limitLine;
            this.stmt(s, indent, nextLine);
        });
        if (!isModule && stmts.length > 0) {
            const origIndent = stmts[0].span.col - 1;
            const lastEnd = stmts[stmts.length - 1].span.endLine;
            for (const c of this.take((c) => c.standalone && c.line > lastEnd && c.line < limitLine && c.col - 1 >= origIndent)) {
                this.comment(c, pad);
            }
        }
    }
    stmt(s, indent, limitLine) {
        const pad = INDENT.repeat(indent);
        for (const c of this.take((c) => c.standalone && c.line < s.span.line))
            this.comment(c, pad);
        this.gapBefore(s.span.line);
        switch (s.kind) {
            case 'Assign':
                this.simple(`${s.targets.map((t) => t.id).join(', ')} = ${at(s.value, P_LAMBDA)}`, s, pad);
                break;
            case 'ExprStmt':
                this.simple(at(s.value, P_LAMBDA), s, pad);
                break;
            case 'Return':
                this.simple(`return ${at(s.value, P_LAMBDA)}`, s, pad);
                break;
            case 'Pass':
                this.simple('pass', s, pad);
                break;
            case 'If':
                this.ifStmt(s, indent, limitLine, 'if');
                break;
            case 'FunctionDef':
                this.def(s, indent, limitLine);
                break;
        }
        this.lastLine = Math.max(this.lastLine, s.span.endLine);
    }
    simple(text, s, pad) {
        const cs = this.take((c) => c.line >= s.span.line && c.line <= s.span.endLine);
        this.lineWithComments(pad + text, pad, cs);
        this.lastLine = Math.max(this.lastLine, s.span.endLine);
    }
    ifStmt(s, indent, limitLine, keyword) {
        const pad = INDENT.repeat(indent);
        const bodyStart = s.body[0].span.line;
        const header = this.take((c) => !c.standalone && c.line >= s.span.line && c.line < bodyStart);
        this.lineWithComments(`${pad}${keyword} ${at(s.test, P_LAMBDA)}:`, pad + INDENT, header);
        this.lastLine = s.span.line;
        let afterBody = limitLine;
        if (s.orelse.length > 0)
            afterBody = s.elseLine ?? s.orelse[0].span.line;
        this.block(s.body, indent + 1, afterBody, false);
        if (s.orelse.length === 0)
            return;
        if (s.elseLine === undefined && s.orelse.length === 1 && s.orelse[0].kind === 'If') {
            const e = s.orelse[0];
            for (const c of this.take((c) => c.standalone && c.line < e.span.line))
                this.comment(c, pad);
            this.ifStmt(e, indent, limitLine, 'elif');
            return;
        }
        const elseLine = s.elseLine ?? s.orelse[0].span.line;
        for (const c of this.take((c) => c.standalone && c.line < elseLine))
            this.comment(c, pad);
        const orelseStart = s.orelse[0].span.line;
        const trailing = this.take((c) => !c.standalone && c.line >= elseLine && c.line < orelseStart);
        this.lineWithComments(`${pad}else:`, pad + INDENT, trailing);
        this.block(s.orelse, indent + 1, limitLine, false);
    }
    def(s, indent, limitLine) {
        const pad = INDENT.repeat(indent);
        for (const d of s.decorators) {
            const args = d.args ? `(${d.args.map(arg).join(', ')})` : '';
            const cs = this.take((c) => !c.standalone && c.line >= d.span.line && c.line <= d.span.endLine);
            this.lineWithComments(`${pad}@${d.name}${args}`, pad, cs);
        }
        for (const c of this.take((c) => c.standalone && c.line < s.defLine))
            this.comment(c, pad);
        const bodyStart = s.body[0].span.line;
        const header = this.take((c) => !c.standalone && c.line >= s.defLine && c.line < bodyStart);
        this.lineWithComments(`${pad}def ${s.name}(${s.params.map(param).join(', ')}):`, pad + INDENT, header);
        this.block(s.body, indent + 1, limitLine, false);
    }
    finish() {
        for (const c of this.take(() => true))
            this.comment(c, '');
        return this.out.length === 0 ? '' : this.out.join('\n') + '\n';
    }
}
/**
 * Print a syntax tree in the canonical style: 4-space indentation, one space around operators,
 * double-quoted text, `elif` chains, at most one blank line kept between items.
 * Comments are kept. A comment inside a multi-line statement moves to just below it.
 */
export function format(module) {
    const f = new Formatter(module.comments);
    f.block(module.body, 0, Number.POSITIVE_INFINITY, true);
    return f.finish();
}
/** Read a script and print it in the canonical style. Throws ScriptError if it does not parse. */
export function formatSource(source, options = {}) {
    return format(parse(source, options));
}
