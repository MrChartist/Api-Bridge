// AmiBroker AFL to ChartistScript: the common vectorised subset (Filter / Buy / Sell / Plot / AlertIf, Param, AddColumn,
// ApplyStop, TimeFrameSet weekly and monthly). Loops, static variables, Gfx drawing and anything that reads a later bar are
// refused with the reason. Written from the public AFL function reference; names not confirmed against a real AmiBroker run are
// marked Needs verification in docs/features/script-import/README.md.
class Unsupported extends Error {
    code;
    level;
    constructor(message, code, level = 'unsupported') {
        super(message);
        this.code = code;
        this.level = level;
    }
}
// ---- reading ---------------------------------------------------------------------------------------------------------------
function tokenize(src) {
    const toks = [];
    const comments = [];
    let i = 0;
    let line = 1;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\n') {
            line++;
            i++;
            continue;
        }
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            let j = i + 2;
            while (j < n && src[j] !== '\n')
                j++;
            comments.push({ line, text: src.slice(i + 2, j).trim() });
            i = j;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            let j = i + 2;
            while (j < n && !(src[j] === '*' && src[j + 1] === '/')) {
                if (src[j] === '\n')
                    line++;
                j++;
            }
            i = j + 2;
            continue;
        }
        const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
        if (num) {
            toks.push({ t: 'num', v: num[0], line });
            i += num[0].length;
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            let body = '';
            while (j < n && src[j] !== '"') {
                if (src[j] === '\\' && j + 1 < n) {
                    body += src[j + 1];
                    j += 2;
                    continue;
                }
                if (src[j] === '\n')
                    line++;
                body += src[j++];
            }
            toks.push({ t: 'str', v: body, line });
            i = j + 1;
            continue;
        }
        const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 80));
        if (nm) {
            toks.push({ t: 'name', v: nm[0], line });
            i += nm[0].length;
            continue;
        }
        const op = /^(==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|[-+*/%<>=!(),;[\]{}?:&|^])/.exec(src.slice(i, i + 3));
        if (op) {
            toks.push({ t: 'op', v: op[0], line });
            i += op[0].length;
            continue;
        }
        throw new Unsupported(`the character "${c}" on line ${line} is not part of AFL.`, 'CV-AFL-UNREADABLE');
    }
    return { toks, comments };
}
const lower = (s) => s.toLowerCase();
class Reader {
    toks;
    i = 0;
    constructor(toks) {
        this.toks = toks;
    }
    peek(o = 0) {
        return this.toks[this.i + o];
    }
    isOp(v, o = 0) {
        const t = this.peek(o);
        return !!t && t.t === 'op' && t.v === v;
    }
    isWord(v, o = 0) {
        const t = this.peek(o);
        return !!t && t.t === 'name' && lower(t.v) === v;
    }
    next() {
        const t = this.toks[this.i++];
        if (!t)
            throw new Unsupported('the script ends too early.', 'CV-AFL-UNREADABLE');
        return t;
    }
    expectOp(v) {
        const t = this.next();
        if (t.v !== v)
            throw new Unsupported(`expected "${v}" on line ${t.line}, found "${t.v}".`, 'CV-AFL-UNREADABLE');
    }
    expr() {
        return this.or();
    }
    or() {
        let l = this.and();
        while (this.isWord('or') || this.isOp('||')) {
            this.next();
            l = { k: 'bin', op: 'or', l, r: this.and(), line: l.line };
        }
        return l;
    }
    and() {
        let l = this.cmp();
        while (this.isWord('and') || this.isOp('&&')) {
            this.next();
            l = { k: 'bin', op: 'and', l, r: this.cmp(), line: l.line };
        }
        return l;
    }
    cmp() {
        let l = this.add();
        while (['==', '!=', '<', '>', '<=', '>='].some((o) => this.isOp(o))) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.add(), line: l.line };
        }
        return l;
    }
    add() {
        let l = this.mul();
        while (this.isOp('+') || this.isOp('-')) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.mul(), line: l.line };
        }
        return l;
    }
    mul() {
        let l = this.unary();
        while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.unary(), line: l.line };
        }
        return l;
    }
    unary() {
        if (this.isOp('-')) {
            const t = this.next();
            return { k: 'un', op: '-', x: this.unary(), line: t.line };
        }
        if (this.isWord('not') || this.isOp('!')) {
            const t = this.next();
            return { k: 'un', op: 'not', x: this.unary(), line: t.line };
        }
        return this.postfix();
    }
    postfix() {
        let x = this.atom();
        for (;;) {
            if (this.isOp('(') && x.k === 'name') {
                this.next();
                const args = [];
                while (!this.isOp(')')) {
                    args.push(this.expr());
                    if (this.isOp(','))
                        this.next();
                    else if (!this.isOp(')'))
                        throw new Unsupported(`expected "," or ")" on line ${this.peek()?.line ?? x.line}.`, 'CV-AFL-UNREADABLE');
                }
                this.expectOp(')');
                x = { k: 'call', fn: x.v, args, line: x.line };
                continue;
            }
            if (this.isOp('[')) {
                this.next();
                const i = this.expr();
                this.expectOp(']');
                x = { k: 'index', x, i, line: x.line };
                continue;
            }
            return x;
        }
    }
    atom() {
        const t = this.next();
        if (t.t === 'num')
            return { k: 'num', v: t.v, line: t.line };
        if (t.t === 'str')
            return { k: 'str', v: t.v, line: t.line };
        if (t.t === 'name')
            return { k: 'name', v: t.v, line: t.line };
        if (t.v === '(') {
            const e = this.expr();
            this.expectOp(')');
            return e;
        }
        throw new Unsupported(`unexpected "${t.v}" on line ${t.line}.`, 'CV-AFL-UNREADABLE');
    }
}
function readStatements(src) {
    const { toks, comments } = tokenize(src);
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const r = new Reader(toks);
    const textOf = (a, b) => lines
        .slice(a - 1, b)
        .map((l) => l.trim())
        .join(' ');
    while (r.i < toks.length) {
        const start = r.peek();
        // control flow: refused as a whole (with its braces)
        if (start.t === 'name' && ['if', 'for', 'while', 'do', 'switch', 'function', 'procedure'].includes(lower(start.v))) {
            let depth = 0;
            let seenBrace = false;
            let end = start.line;
            while (r.i < toks.length) {
                const t = r.next();
                end = t.line;
                if (t.v === '{') {
                    depth++;
                    seenBrace = true;
                }
                else if (t.v === '}') {
                    depth--;
                    if (seenBrace && depth === 0)
                        break;
                }
                else if (t.v === ';' && !seenBrace && depth === 0 && r.peek()?.v !== '{') {
                    // a one-statement body without braces: stop after it
                    if (lower(start.v) !== 'for' || toks.slice(0, r.i).filter((x) => x.v === ';').length > 2)
                        break;
                }
            }
            out.push({ name: null, value: null, line: start.line, endLine: end, refused: lower(start.v), text: textOf(start.line, end) });
            continue;
        }
        const from = r.i;
        try {
            let name = null;
            if (start.t === 'name' && r.isOp('=', 1)) {
                name = start.v;
                r.i += 2;
            }
            const value = r.expr();
            const endTok = r.peek();
            if (endTok && endTok.v === ';')
                r.next();
            else if (endTok && endTok.line === value.line)
                throw new Unsupported(`"${endTok.v}" on line ${endTok.line} could not be read.`, 'CV-AFL-UNREADABLE');
            const endLine = toks[r.i - 1]?.line ?? start.line;
            out.push({ name, value, line: start.line, endLine, text: textOf(start.line, endLine) });
        }
        catch (err) {
            // skip to the next ;
            r.i = from;
            let end = start.line;
            while (r.i < toks.length) {
                const t = r.next();
                end = t.line;
                if (t.v === ';')
                    break;
            }
            out.push({ name: null, value: null, line: start.line, endLine: end, refused: err instanceof Error ? err.message : 'unreadable', text: textOf(start.line, end) });
        }
    }
    for (const c of comments) {
        const at = out.findIndex((s) => s.line > c.line);
        const stmt = { name: null, value: null, line: c.line, endLine: c.line, text: '', comment: c.text };
        if (lines[c.line - 1]?.trim().startsWith('//')) {
            if (at < 0)
                out.push(stmt);
            else
                out.splice(at, 0, stmt);
        }
    }
    return out;
}
const PRICES = { c: 'close', close: 'close', o: 'open', open: 'open', h: 'high', high: 'high', l: 'low', low: 'low', v: 'volume', volume: 'volume', avg: 'hlc3' };
const COLORS = {
    colorblue: { tone: 'color.blue', exact: true },
    colorred: { tone: 'color.down', exact: false },
    colorgreen: { tone: 'color.up', exact: false },
    colorbrightgreen: { tone: 'color.up', exact: false },
    colororange: { tone: 'color.amber', exact: true },
    coloryellow: { tone: 'color.amber', exact: false },
    colorgold: { tone: 'color.amber', exact: false },
    colorteal: { tone: 'color.teal', exact: true },
    coloraqua: { tone: 'color.teal', exact: false },
    colorgrey40: { tone: 'color.gray', exact: true },
    colorgrey50: { tone: 'color.gray', exact: true },
    colorlightgrey: { tone: 'color.gray', exact: true },
    colorblack: { tone: 'color.neutral', exact: false },
    colorwhite: { tone: 'color.neutral', exact: false },
};
const TAKEN = new Set(['open', 'high', 'low', 'close', 'volume', 'abs', 'min', 'max', 'nz', 'near', 'all', 'any', 'input', 'show', 'plot', 'mark', 'alert', 'tf', 'ref', 'range', 'na', 'is_na', 'sum', 'avg', 'fill', 'bgcolor', 'bench', 'breadth', 'candle', 'color', 'fund', 'fut', 'ind', 'info', 'levels', 'opt', 'pattern', 'price', 'strategy', 'ta', 'xs', 'flow', 'deriv', 'math', 'and', 'or', 'not', 'in', 'is', 'if', 'else', 'for', 'def', 'return', 'pass', 'lambda', 'class', 'from', 'import', 'none', 'true', 'false']);
const RESERVED = new Set(['filter', 'buy', 'sell', 'short', 'cover', 'buyprice', 'sellprice', 'shortprice', 'coverprice', 'positionsize', 'positionscore', 'title']);
class Writer {
    notes = [];
    scope = new Map();
    spelling = new Map();
    groups = new Map();
    frames = new Map();
    frame = null;
    lines = [];
    settings = [];
    shows = [];
    plots = [];
    filter = null;
    buy = null;
    sell = null;
    alerts = [];
    stops = [];
    section = null;
    taken = new Set();
    note(level, code, message, line, endLine) {
        if (this.notes.some((n) => n.code === code && n.message === message && n.line === line))
            return;
        const n = { line, level, code, message };
        if (endLine !== undefined && endLine !== line)
            n.endLine = endLine;
        this.notes.push(n);
    }
    fresh(base) {
        let n = TAKEN.has(lower(base)) ? `${base}_` : base;
        const root = n;
        let i = 2;
        while (this.taken.has(n))
            n = `${root}_${i++}`;
        this.taken.add(n);
        return n;
    }
    group(key, call, base) {
        const g = this.groups.get(key);
        if (g) {
            g.uses++;
            return `__g${[...this.groups.keys()].indexOf(key)}__`;
        }
        this.groups.set(key, { key, call, base, uses: 1 });
        return `__g${this.groups.size - 1}__`;
    }
    frameName(code, line) {
        const have = this.frames.get(code);
        if (have)
            return have;
        const name = this.fresh(code === 'W' ? 'week' : 'month');
        this.frames.set(code, name);
        this.lines.push({ text: `# approx: TimeFrameExpand includes the ${code === 'W' ? 'week' : 'month'} still forming; tf("${code}") uses completed ${code === 'W' ? 'weeks' : 'months'} only.`, src: line, comment: true });
        this.lines.push({ text: `${name} = tf("${code}")`, src: line });
        this.note('approx', 'CV-AFL-TIMEFRAME', `TimeFrameExpand includes the ${code === 'W' ? 'week' : 'month'} still forming; tf("${code}") uses completed ${code === 'W' ? 'weeks' : 'months'} only.`, line);
        return name;
    }
    num(n, what) {
        if (!n)
            throw new Unsupported(`${what} is missing a number.`, 'CV-AFL-ARGS');
        if (n.k === 'num')
            return n.v;
        if (n.k === 'un' && n.op === '-' && n.x.k === 'num')
            return `-${n.x.v}`;
        if (n.k === 'name') {
            const b = this.scope.get(lower(n.v));
            if (b && b.k === 'setting')
                return b.cs;
        }
        throw new Unsupported(`${what} needs a written number or a Param setting here.`, 'CV-AFL-ARGS');
    }
    /** A value and whether it is true/false. */
    tx(n) {
        switch (n.k) {
            case 'num':
                return { s: n.v, bool: false };
            case 'str':
                throw new Unsupported('a text is used where a value is expected.', 'CV-AFL-TEXT');
            case 'name': {
                const id = lower(n.v);
                const b = this.scope.get(id);
                if (b) {
                    if (b.k === 'dropped')
                        throw new Unsupported(`\`${n.v}\` was left out, so this is left out too.`, 'CV-AFL-DEPENDS-ON-DROPPED');
                    if (b.k === 'inline')
                        return { s: b.s, bool: b.bool };
                    return { s: b.cs, bool: b.k === 'name' ? b.bool : false };
                }
                if (PRICES[id]) {
                    const p = PRICES[id];
                    if (this.frame) {
                        if (p === 'hlc3')
                            return { s: `((${this.frame}.high + ${this.frame}.low + ${this.frame}.close) / 3)`, bool: false };
                        return { s: `${this.frame}.${p}`, bool: false };
                    }
                    return { s: p, bool: false };
                }
                if (id === 'true')
                    return { s: 'True', bool: true };
                if (id === 'false')
                    return { s: 'False', bool: true };
                if (id === 'barcount' || id === 'barindex')
                    throw new Unsupported(`${n.v} counts bars from the first loaded; loops over bars are not part of the language.`, 'CV-AFL-BARS');
                if (id === 'oi' || id === 'openint')
                    throw new Unsupported('open interest is not available in a screener here.', 'CV-AFL-OI');
                throw new Unsupported(`\`${n.v}\` is not known to the converter.`, 'CV-AFL-NAME');
            }
            case 'un': {
                const x = this.tx(n.x);
                return n.op === 'not' ? { s: `(not ${x.s})`, bool: true } : { s: `(-${x.s})`, bool: false };
            }
            case 'bin': {
                const l = this.tx(n.l);
                const r = this.tx(n.r);
                if (n.op === 'and' || n.op === 'or')
                    return { s: `(${l.s} ${n.op} ${r.s})`, bool: true };
                if (['==', '!=', '<', '>', '<=', '>='].includes(n.op))
                    return { s: `(${l.s} ${n.op} ${r.s})`, bool: true };
                // Buy * shapeUpArrow and other bool arithmetic is not a value here
                if (l.bool || r.bool)
                    throw new Unsupported('arithmetic on a true/false value (AFL treats it as 1 and 0) is not converted.', 'CV-AFL-BOOL-MATH');
                return { s: `(${l.s} ${n.op} ${r.s})`, bool: false };
            }
            case 'index':
                throw new Unsupported('x[i] reads one bar of an array by its number; loops over bars are not part of the language.', 'CV-AFL-ARRAY-INDEX');
            case 'call':
                return this.call(n);
        }
    }
    call(n) {
        const fn = lower(n.fn);
        const a = n.args;
        const v = (i) => this.tx(a[i] ?? { k: 'num', v: '0', line: n.line });
        const need = (k) => {
            if (a.length < k)
                throw new Unsupported(`${n.fn}() needs ${k} arguments.`, 'CV-AFL-ARGS');
        };
        switch (fn) {
            case 'ma':
            case 'ema':
            case 'wma':
                need(2);
                return { s: `ta.${fn === 'ma' ? 'sma' : fn}(${v(0).s}, ${this.num(a[1], n.fn)})`, bool: false };
            case 'rsi':
                return { s: `ta.rsi(${this.frame ? `${this.frame}.close` : 'close'}, ${a.length ? this.num(a[0], 'RSI') : '14'})`, bool: false };
            case 'rsia':
                need(2);
                return { s: `ta.rsi(${v(0).s}, ${this.num(a[1], 'RSIa')})`, bool: false };
            case 'atr':
                if (this.frame)
                    throw new Unsupported('ATR inside TimeFrameSet is not converted.', 'CV-AFL-FRAME-STUDY');
                return { s: `ta.atr(${a.length ? this.num(a[0], 'ATR') : '14'})`, bool: false };
            case 'hhv':
            case 'llv':
                need(2);
                return { s: `ta.${fn === 'hhv' ? 'highest' : 'lowest'}(${v(0).s}, ${this.num(a[1], n.fn)})`, bool: false };
            case 'ref': {
                need(2);
                const k = this.num(a[1], 'Ref');
                const kn = Number(k);
                if (Number.isNaN(kn))
                    throw new Unsupported('Ref() with a setting as the offset is not converted (its sign decides past or future).', 'CV-AFL-REF');
                if (kn > 0)
                    throw new Unsupported(`Ref(x, +${kn}) reads a later bar: it looks into the future, which is never converted.`, 'CV-AFL-FUTURE');
                const x = v(0);
                if (kn === 0)
                    return x;
                this.note('info', 'CV-AFL-REF', `Ref(x, -${-kn}) is x[${-kn}] here: the sign flips (a positive number looks back).`, n.line);
                return { s: /^[\w.]+$/.test(x.s) || /\)$/.test(x.s) ? `${x.s}[${-kn}]` : `(${x.s})[${-kn}]`, bool: x.bool };
            }
            case 'cross':
                need(2);
                return { s: `ta.crossover(${v(0).s}, ${v(1).s})`, bool: true };
            case 'barssince':
                need(1);
                return { s: `ta.bars_since(${v(0).s})`, bool: false };
            case 'valuewhen': {
                need(2);
                const occ = a[2] ? Number(this.num(a[2], 'ValueWhen')) : 1;
                if (Number.isNaN(occ) || occ < 1)
                    throw new Unsupported('ValueWhen with a changing or zero occurrence is not converted.', 'CV-AFL-ARGS');
                this.note('info', 'CV-AFL-VALUEWHEN', 'ValueWhen counts occurrences from 1; ta.value_when counts from 0.', n.line);
                return { s: occ === 1 ? `ta.value_when(${v(0).s}, ${v(1).s})` : `ta.value_when(${v(0).s}, ${v(1).s}, ${occ - 1})`, bool: v(1).bool };
            }
            case 'sum': {
                need(2);
                const x = v(0);
                const len = this.num(a[1], 'Sum');
                if (x.bool)
                    return { s: `ta.count(${x.s}, ${len})`, bool: false };
                this.note('approx', 'CV-AFL-SUM', 'Sum(x, n) of numbers is written ta.sma(x, n) * n; the last decimal places can differ.', n.line);
                return { s: `(ta.sma(${x.s}, ${len}) * ${len})`, bool: false };
            }
            case 'cum':
                need(1);
                return { s: `ta.cum_sum(${v(0).s})`, bool: false };
            case 'iif': {
                need(3);
                const x = v(1);
                return { s: `(${x.s} if ${v(0).s} else ${v(2).s})`, bool: x.bool };
            }
            case 'max':
            case 'min':
                need(2);
                return { s: `${fn}(${v(0).s}, ${v(1).s})`, bool: false };
            case 'abs':
                return { s: `abs(${v(0).s})`, bool: false };
            case 'sqrt':
            case 'log':
            case 'exp':
            case 'floor':
            case 'ceil':
                return { s: `math.${fn}(${v(0).s})`, bool: false };
            case 'round':
                return { s: `math.round(${v(0).s})`, bool: false };
            case 'roc':
                need(2);
                return { s: `ta.roc(${v(0).s}, ${this.num(a[1], 'ROC')})`, bool: false };
            case 'stdev':
                need(2);
                this.note('approx', 'CV-AFL-STDEV', 'StDev is written ta.stdev, the population form; check that AmiBroker uses the same (Needs verification).', n.line);
                return { s: `ta.stdev(${v(0).s}, ${this.num(a[1], 'StDev')})`, bool: false };
            case 'cci':
                return { s: `ta.cci(hlc3, ${a.length ? this.num(a[0], 'CCI') : '14'})`, bool: false };
            case 'mfi':
                this.daily(n.fn);
                return { s: `ind.mfi(${a.length ? this.num(a[0], 'MFI') : '14'})`, bool: false };
            case 'obv':
                this.daily(n.fn);
                return { s: 'ind.obv()', bool: false };
            case 'adx':
            case 'pdi':
            case 'mdi': {
                this.daily(n.fn);
                const len = a.length ? this.num(a[0], n.fn) : '14';
                const g = this.group(`adx:${len}`, `ind.adx(${len})`, 'adx_');
                return { s: `${g}.${fn === 'adx' ? 'adx' : fn === 'pdi' ? 'plus_di' : 'minus_di'}`, bool: false };
            }
            case 'macd':
            case 'signal': {
                this.daily(n.fn);
                const f = a[0] ? this.num(a[0], n.fn) : '12';
                const s = a[1] ? this.num(a[1], n.fn) : '26';
                const sig = fn === 'signal' && a[2] ? this.num(a[2], n.fn) : '9';
                const g = this.group(`macd:${f},${s},${sig}`, `ind.macd(${f}, ${s}, ${sig})`, 'md');
                return { s: `${g}.${fn === 'macd' ? 'macd' : 'signal'}`, bool: false };
            }
            case 'bbandtop':
            case 'bbandbot': {
                this.daily(n.fn);
                need(3);
                const src = v(0).s;
                const len = this.num(a[1], n.fn);
                const k = this.num(a[2], n.fn);
                const g = this.group(`bb:${src},${len},${k}`, src === 'close' ? `ind.bb(${len}, ${k})` : `ind.bb(${len}, ${k}, src=${src})`, 'bb');
                return { s: `${g}.${fn === 'bbandtop' ? 'upper' : 'lower'}`, bool: false };
            }
            case 'flip':
                need(2);
                return { s: `ta.latch(${v(0).s}, ${v(1).s})`, bool: true };
            case 'foreign': {
                need(2);
                const sym = a[0];
                const field = a[1];
                if (sym.k !== 'str' || field.k !== 'str')
                    throw new Unsupported('Foreign() needs a written symbol and field.', 'CV-AFL-ARGS');
                const p = PRICES[lower(field.v)];
                if (!p || p === 'hlc3')
                    throw new Unsupported(`Foreign field "${field.v}" is not converted.`, 'CV-AFL-ARGS');
                const s = sym.v.toUpperCase() === 'NIFTY' || sym.v.toUpperCase() === '^NSEI' ? 'NIFTY 50' : sym.v;
                this.note('approx', 'CV-AFL-FOREIGN', `Foreign("${sym.v}") is ref("${s}"); the symbol name Needs verification against the index list here.`, n.line);
                return { s: `ref("${s}").${p}`, bool: false };
            }
            case 'timeframeexpand': {
                need(1);
                // the value was worked out inside TimeFrameSet; its binding already reads the weekly fields
                return v(0);
            }
            case 'exrem':
                throw new Unsupported('ExRem (remove repeated signals) has no exact equal; the strategy here does not buy again while holding.', 'CV-AFL-EXREM');
            default:
                throw new Unsupported(`${n.fn}() is not converted.`, 'CV-AFL-FUNCTION');
        }
    }
    daily(fn) {
        if (this.frame)
            throw new Unsupported(`${fn}() inside TimeFrameSet is not converted (the study runs on daily candles here).`, 'CV-AFL-FRAME-STUDY');
    }
}
/** Convert AFL to a draft. */
export function convertAflDraft(text, kind) {
    const w = new Writer();
    let stmts;
    try {
        stmts = readStatements(text);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unreadable';
        return { kind: 'screener', text: '', srcLines: [], notes: [{ line: 1, level: 'unsupported', code: 'CV-AFL-UNREADABLE', message: msg }], companions: [], failed: true };
    }
    const body = [];
    const refuse = (s, err) => {
        const e = err instanceof Unsupported ? err : new Unsupported(err instanceof Error ? err.message : 'not converted.', 'CV-AFL-UNREADABLE');
        w.note(e.level, e.code, `${e.message}${e.level === 'unsupported' ? ' Left out.' : ''}`, s.line, s.endLine);
        if (e.level === 'unsupported')
            body.push({ text: `# unsupported: ${s.text.slice(0, 160)}`, src: s.line, comment: true });
        if (s.name)
            w.scope.set(lower(s.name), { k: 'dropped' });
    };
    // V-6 (2026-10-25): `Buy = ExRem(Buy, Sell)` / `Sell = ExRem(Sell, Buy)` in a long-only strategy changes no trade, since the
    // backtest here never buys while holding nor sells while flat. Only when nothing else reads Buy or Sell (a Filter, an alert or
    // a plot of the signal would see the repeated ones), there is no Short or Cover, and the kind is not forced to another one.
    const isExRem = (st) => {
        const v = st.value;
        if (!st.name || !v || v.k !== 'call' || lower(v.fn) !== 'exrem' || v.args.length !== 2)
            return false;
        const [a, b] = v.args.map((x) => (x.k === 'name' ? lower(x.v) : ''));
        const id = lower(st.name);
        return (id === 'buy' && a === 'buy' && b === 'sell') || (id === 'sell' && a === 'sell' && b === 'buy');
    };
    const signalLine = (st) => st.name !== null && ['buy', 'sell'].includes(lower(st.name));
    const exRemHarmless = (kind === undefined || kind === 'strategy') &&
        stmts.some((st) => st.name !== null && lower(st.name) === 'buy') &&
        !stmts.some((st) => st.name !== null && ['short', 'cover', 'filter'].includes(lower(st.name))) &&
        !stmts.some((st) => st.comment === undefined && !signalLine(st) && /\b(buy|sell)\b/i.test(st.text.replace(/"[^"]*"/g, '')));
    for (const s of stmts) {
        if (exRemHarmless && isExRem(s)) {
            w.note('info', 'CV-AFL-EXREM', `${s.name} = ExRem(...) is not needed here: the backtest never buys while holding nor sells while flat, so the repeated signals it removes would change no trade.`, s.line, s.endLine);
            continue;
        }
        if (s.comment !== undefined) {
            body.push({ text: `# ${s.comment}`, src: s.line, comment: true });
            continue;
        }
        if (s.refused) {
            const why = ['if', 'for', 'while', 'do', 'switch'].includes(s.refused)
                ? `${s.refused} blocks step through bars one at a time; a script here works on every candlestick at once.`
                : s.refused === 'function' || s.refused === 'procedure'
                    ? 'functions with a body are not converted.'
                    : s.refused;
            w.note('unsupported', 'CV-AFL-BLOCK', `${why} Left out.`, s.line, s.endLine);
            body.push({ text: `# unsupported: ${s.text.slice(0, 160)}`, src: s.line, comment: true });
            continue;
        }
        const v = s.value;
        try {
            if (s.name === null) {
                if (v.k !== 'call')
                    throw new Unsupported('a value on its own line does nothing.', 'CV-AFL-NO-EFFECT', 'info');
                statementCall(w, v, s, body);
                continue;
            }
            const id = lower(s.name);
            if (v.k === 'call' && (lower(v.fn) === 'param' || lower(v.fn) === 'optimize')) {
                const [title, def, mn, mx] = v.args;
                const d = w.num(def, v.fn);
                const cs = w.fresh(s.name);
                const parts = [d];
                if (mn)
                    parts.push(`min=${w.num(mn, v.fn)}`);
                if (mx)
                    parts.push(`max=${w.num(mx, v.fn)}`);
                if (title && title.k === 'str' && title.v.length <= 60)
                    parts.push(`title="${title.v.replace(/"/g, "'")}"`);
                const isFloat = [def, mn, mx].some((x) => x && x.k === 'num' && /\./.test(x.v));
                w.settings.push({ cs, text: `input(${parts.join(', ')})${isFloat ? '' : ''}`, line: s.line });
                w.scope.set(id, { k: 'setting', cs });
                if (lower(v.fn) === 'optimize')
                    w.note('info', 'CV-AFL-OPTIMIZE', 'Optimize is a setting here (min and max kept); the backtest does not search the range.', s.line);
                continue;
            }
            if (RESERVED.has(id)) {
                const x = w.tx(v);
                w.scope.set(id, { k: 'inline', s: x.s, bool: x.bool });
                if (id === 'filter')
                    w.filter = { s: x.s, line: s.line };
                else if (id === 'buy')
                    w.buy = { s: x.s, line: s.line };
                else if (id === 'sell')
                    w.sell = { s: x.s, line: s.line };
                else if (id === 'short' || id === 'cover')
                    throw new Unsupported(`${s.name}: short selling is not available; a strategy here buys and sells.`, 'CV-AFL-SHORT');
                else if (id === 'buyprice' || id === 'sellprice')
                    w.note('approx', 'CV-AFL-FILL', `${s.name} is not carried over: the backtest here fills at the next open.`, s.line);
                else
                    w.note('info', 'CV-AFL-IGNORED', `${s.name} is not carried over.`, s.line);
                continue;
            }
            const x = w.tx(v);
            // a name that only holds a part of a library group is written as that part (so the group is shared)
            if (/^__g\d+__\.\w+$/.test(x.s) || w.frame) {
                w.scope.set(id, { k: 'inline', s: x.s, bool: x.bool });
                continue;
            }
            const prev = w.scope.get(id);
            const cs = prev && (prev.k === 'name' || prev.k === 'setting') ? w.fresh(prev.cs) : w.fresh(s.name);
            body.push({ text: `${cs} = ${x.s}`, src: s.line });
            w.scope.set(id, { k: 'name', cs, bool: x.bool });
        }
        catch (err) {
            refuse(s, err);
        }
    }
    // which kind
    const hasStrategy = w.buy !== null;
    const hasFilter = w.filter !== null;
    const hasPlot = w.plots.length > 0;
    const hasAlert = w.alerts.length > 0;
    const hasSell = w.sell !== null;
    let target = hasFilter ? 'screener' : hasAlert && !hasSell ? 'alert' : hasStrategy ? 'strategy' : hasAlert ? 'alert' : hasPlot ? 'indicator' : 'screener';
    if (kind)
        target = kind;
    if (hasFilter && hasStrategy && !kind)
        w.note('info', 'CV-AFL-TWO-KINDS', 'the script has both Filter and Buy; it is converted as a screener. Convert it as a strategy for the Buy and Sell rules.', w.buy?.line ?? 1);
    if (hasAlert && hasPlot && target === 'alert')
        w.note('unsupported', 'CV-AFL-ALERT-DRAWS', 'an alert script draws nothing; the Plot lines are left out (convert as an indicator to see them).', w.plots[0].line);
    // groups: named when used more than once
    const groups = [...w.groups.values()];
    const groupLines = [];
    const resolve = (s) => s.replace(/__g(\d+)__/g, (_m, i) => {
        const g = groups[Number(i)];
        return g.uses > 1 ? g.name ?? g.call : g.call;
    });
    for (const g of groups) {
        if (g.uses > 1) {
            const name = w.fresh(g.base);
            g.name = name;
            groupLines.push(`${name} = ${g.call}`);
        }
    }
    const out = [];
    const firstCode = stmts.find((s) => !s.comment)?.line ?? 1;
    const inner = [...groupLines.map((t) => ({ text: t, src: firstCode })), ...body.map((b) => ({ text: resolve(b.text), src: b.src }))];
    let failed = false;
    if (target === 'screener') {
        if (!w.filter) {
            failed = true;
            w.note('unsupported', 'CV-AFL-NO-FILTER', 'there is no Filter = ... line to screen for.', 1);
        }
        else {
            for (const st of w.settings)
                out.push({ text: `${st.cs} = ${st.text}`, src: st.line });
            out.push(...inner);
            let cond = resolve(w.filter.s);
            for (const sh of w.shows) {
                let shown = resolve(sh.s);
                // a value shown and also tested is given one name (from its column label)
                if (/\)$/.test(shown) && cond.includes(shown)) {
                    const name = w.fresh(sh.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value');
                    out.push({ text: `${name} = ${shown}`, src: sh.line });
                    cond = cond.split(shown).join(name);
                    shown = name;
                }
                out.push({ text: `show(${shown}, "${sh.label}")`, src: sh.line });
            }
            out.push({ text: cond, src: w.filter.line });
        }
    }
    else {
        let deco;
        if (target === 'strategy') {
            if (!w.buy) {
                failed = true;
                w.note('unsupported', 'CV-AFL-NO-BUY', 'there is no Buy = ... line to enter on.', 1);
            }
            deco = '@strategy(universe="liquid")';
            w.note('approx', 'CV-AFL-FILL-NEXT', 'AmiBroker fills at the signal bar close by default (BuyPrice = C); the backtest here fills at the next open.', w.buy?.line ?? 1);
            out.push({ text: '# approx: AmiBroker fills at the signal bar close by default (BuyPrice = C); the backtest here fills at the next open.', src: 0 });
        }
        else if (target === 'alert') {
            if (!w.alerts.length) {
                failed = true;
                w.note('unsupported', 'CV-AFL-NO-ALERT', 'there is no AlertIf line to convert.', 1);
            }
            deco = `@alert(name="${(w.alerts[0]?.msg || w.section || 'Converted').slice(0, 40).replace(/"/g, "'")}")`;
        }
        else {
            if (!w.plots.length) {
                failed = true;
                w.note('unsupported', 'CV-AFL-NO-PLOT', 'there is no Plot line to draw.', 1);
            }
            const oscillator = w.plots.some((p) => /ta\.(rsi|cci|roc)|ind\.(adx|mfi|macd)|\.adx|\.macd|\.signal/.test(resolve(p.text)));
            deco = `@indicator(name="${(w.section ?? 'Converted').slice(0, 40).replace(/"/g, "'")}", overlay=${oscillator ? 'False' : 'True'})`;
        }
        out.push({ text: deco, src: 0 });
        out.push({ text: `def converted(${w.settings.map((st) => `${st.cs}: ${/\./.test(st.text.split(',')[0]) ? 'float' : 'int'} = ${st.text}`).join(', ')}):`, src: 0 });
        const ind = (t, src) => out.push({ text: `    ${t}`, src });
        for (const l of inner)
            ind(l.text, l.src);
        if (target === 'strategy' && w.buy) {
            ind(`strategy.entry(${resolve(w.buy.s)})`, w.buy.line);
            if (w.sell)
                ind(`strategy.exit(${resolve(w.sell.s)})`, w.sell.line);
            for (const st of w.stops)
                ind(st.text, st.line);
        }
        else if (target === 'alert') {
            for (const al of w.alerts)
                ind(`alert(${resolve(al.cond)}, "${al.msg.replace(/"/g, "'")}")`, al.line);
        }
        else if (target === 'indicator') {
            for (const p of w.plots) {
                if (p.note)
                    ind(`# approx: ${p.note}`, p.line);
                ind(resolve(p.text), p.line);
            }
        }
        else {
            failed = true;
        }
        if (!out.slice(2).some((l) => !l.text.trim().startsWith('#')))
            ind('pass', 0);
    }
    return {
        kind: target,
        text: out.map((l) => l.text).join('\n') + '\n',
        srcLines: out.map((l) => l.src),
        ...(w.section ? { title: w.section } : {}),
        notes: w.notes,
        companions: [],
        ...(failed ? { failed: true } : {}),
    };
}
function statementCall(w, v, s, body) {
    const fn = lower(v.fn);
    const a = v.args;
    switch (fn) {
        case '_section_begin':
            if (a[0] && a[0].k === 'str')
                w.section = a[0].v;
            return;
        case '_section_end':
        case 'setchartoptions':
        case 'graphxspace':
        case 'setbarsrequired':
        case 'setformulaname':
            return;
        case 'addcolumn': {
            const x = w.tx(a[0]);
            const label = a[1] && a[1].k === 'str' ? a[1].v : 'Value';
            // a call shown and also used elsewhere is given a name
            w.shows.push({ s: x.s, label: label.slice(0, 60).replace(/"/g, "'"), line: s.line });
            return;
        }
        case 'plot': {
            const x = w.tx(a[0]);
            const label = a[1] && a[1].k === 'str' ? a[1].v : `Plot ${w.plots.length + 1}`;
            const parts = [x.s, `"${label.replace(/"/g, "'")}"`];
            let note;
            const col = a[2];
            if (col && col.k === 'name') {
                const c = COLORS[lower(col.v)];
                if (c) {
                    parts.push(`color=${c.tone}`);
                    if (!c.exact) {
                        note = `${col.v} has no named colour here; ${c.tone} is the nearest theme tone.`;
                        w.note('approx', 'CV-AFL-COLOR', note, s.line);
                    }
                }
            }
            const st = a[3];
            if (st && st.k === 'name' && /stylehistogram/i.test(st.v))
                parts.push('style="histogram"');
            w.plots.push({ text: `plot(${parts.join(', ')})`, line: s.line, ...(note ? { note } : {}) });
            return;
        }
        case 'timeframeset': {
            const code = a[0] && a[0].k === 'name' ? lower(a[0].v) : '';
            if (code === 'inweekly')
                w.frame = w.frameName('W', s.line);
            else if (code === 'inmonthly')
                w.frame = w.frameName('M', s.line);
            else if (code === 'indaily')
                w.frame = null;
            else
                throw new Unsupported(`TimeFrameSet(${code}) is not converted: scripts run on daily, weekly and monthly candles.`, 'CV-AFL-TIMEFRAME');
            // the frame line (and its approx comment) goes into the body where the block starts
            body.push(...w.lines.splice(0));
            return;
        }
        case 'timeframerestore':
            w.frame = null;
            return;
        case 'applystop': {
            const type = a[0] && a[0].k === 'name' ? lower(a[0].v) : '';
            const mode = a[1] && a[1].k === 'name' ? lower(a[1].v) : '';
            if (mode !== 'stopmodepercent')
                throw new Unsupported('ApplyStop in points or bars is not converted; give the stop in percent (stopModePercent).', 'CV-AFL-STOP-MODE');
            const pct = w.num(a[2], 'ApplyStop');
            if (type === 'stoptypeloss')
                w.stops.push({ text: `strategy.stop_loss(pct=${pct})`, line: s.line });
            else if (type === 'stoptypeprofit')
                w.stops.push({ text: `strategy.take_profit(pct=${pct})`, line: s.line });
            else if (type === 'stoptypetrailing')
                w.stops.push({ text: `strategy.trail(pct=${pct})`, line: s.line });
            else
                throw new Unsupported(`ApplyStop(${a[0] && a[0].k === 'name' ? a[0].v : '?'}) is not converted.`, 'CV-AFL-STOP-TYPE');
            return;
        }
        case 'alertif': {
            const cond = w.tx(a[0]).s;
            const msg = a[2] && a[2].k === 'str' && a[2].v ? a[2].v : 'Alert';
            w.alerts.push({ cond, msg: msg.slice(0, 120), line: s.line });
            return;
        }
        case 'plotshapes':
            w.note('unsupported', 'CV-AFL-PLOTSHAPES', 'PlotShapes is not converted here (an alert or screener draws nothing; make an indicator with mark(...) for the arrows). Left out.', s.line);
            body.push({ text: `# unsupported: ${s.text.slice(0, 160)}`, src: s.line, comment: true });
            return;
        case 'settradedelays':
        case 'setoption':
        case 'setpositionsize':
            w.note('approx', 'CV-AFL-SETTINGS', `${v.fn} is not carried over: the backtest uses its own settings (next-open fills, its sizing).`, s.line);
            return;
        default:
            throw new Unsupported(`${v.fn}() on a line of its own is not converted.`, 'CV-AFL-FUNCTION');
    }
}
