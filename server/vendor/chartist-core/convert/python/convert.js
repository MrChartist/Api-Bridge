// Python (pandas, pandas-ta, TA-Lib, numpy, vectorbt) to ChartistScript: only the vectorised subset that names price columns and
// chains known methods. Statements other than assignments, imports and one vectorbt backtest are refused with the reason;
// anything that reads a later row (shift(-k), centred windows) is refused. Written from the public pandas, pandas-ta, TA-Lib and
// vectorbt documentation; points not checked are marked Needs verification in docs/features/script-import/README.md.
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
function lexLine(text, line) {
    const out = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (c === '#')
            break;
        const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
        if (num) {
            out.push({ t: 'num', v: num[0], line });
            i += num[0].length;
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            let body = '';
            while (j < text.length && text[j] !== c) {
                if (text[j] === '\\')
                    j++;
                body += text[j++] ?? '';
            }
            out.push({ t: 'str', v: body, line });
            i = j + 1;
            continue;
        }
        const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
        if (nm) {
            out.push({ t: 'name', v: nm[0], line });
            i += nm[0].length;
            continue;
        }
        const op = /^(\*\*|\/\/|==|!=|<=|>=|[-+*/%<>=&|~^().,[\]:{}@])/.exec(text.slice(i));
        if (op) {
            out.push({ t: 'op', v: op[0], line });
            i += op[0].length;
            continue;
        }
        throw new Unsupported(`the character "${c}" on line ${line} could not be read.`, 'CV-PY-UNREADABLE');
    }
    return out;
}
function logicalLines(src) {
    const phys = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let depth = 0;
    for (let i = 0; i < phys.length; i++) {
        const raw = phys[i];
        const t = raw.trim();
        if (!t)
            continue;
        if (t.startsWith('#') && depth === 0) {
            out.push({ toks: [], line: i + 1, endLine: i + 1, text: raw, indent: 0, comment: t.slice(1).trim() });
            continue;
        }
        let toks = [];
        let error;
        try {
            toks = lexLine(raw, i + 1);
        }
        catch (err) {
            error = err instanceof Error ? err.message : 'unreadable';
        }
        const prev = out[out.length - 1];
        if (depth > 0 && prev) {
            prev.toks.push(...toks);
            prev.endLine = i + 1;
            prev.text += ' ' + t;
        }
        else {
            out.push({ toks, line: i + 1, endLine: i + 1, text: t, indent: raw.length - raw.trimStart().length, ...(error ? { error } : {}) });
        }
        for (const k of toks) {
            if (k.t !== 'op')
                continue;
            if (k.v === '(' || k.v === '[' || k.v === '{')
                depth++;
            if ((k.v === ')' || k.v === ']' || k.v === '}') && depth > 0)
                depth--;
        }
    }
    return out;
}
class Reader {
    toks;
    i = 0;
    constructor(toks) {
        this.toks = toks;
    }
    peek(o = 0) {
        return this.toks[this.i + o];
    }
    is(v, o = 0) {
        const t = this.peek(o);
        return !!t && (t.t === 'op' || t.t === 'name') && t.v === v;
    }
    next() {
        const t = this.toks[this.i++];
        if (!t)
            throw new Unsupported('the line ends too early.', 'CV-PY-UNREADABLE');
        return t;
    }
    expect(v) {
        const t = this.next();
        if (t.v !== v)
            throw new Unsupported(`expected "${v}", found "${t.v}" (line ${t.line}).`, 'CV-PY-UNREADABLE');
    }
    expr() {
        const a = this.or();
        if (this.is('if')) {
            this.next();
            const c = this.or();
            this.expect('else');
            const b = this.expr();
            return { k: 'ifx', c, a, b, line: a.line };
        }
        return a;
    }
    or() {
        let l = this.and();
        while (this.is('or')) {
            this.next();
            l = { k: 'bin', op: 'or', l, r: this.and(), line: l.line };
        }
        return l;
    }
    and() {
        let l = this.not();
        while (this.is('and')) {
            this.next();
            l = { k: 'bin', op: 'and', l, r: this.not(), line: l.line };
        }
        return l;
    }
    not() {
        if (this.is('not')) {
            const t = this.next();
            return { k: 'un', op: 'not', x: this.not(), line: t.line };
        }
        return this.cmp();
    }
    cmp() {
        let l = this.bor();
        while (['==', '!=', '<', '>', '<=', '>='].some((o) => this.is(o))) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.bor(), line: l.line };
        }
        return l;
    }
    bor() {
        let l = this.band();
        while (this.is('|')) {
            this.next();
            l = { k: 'bin', op: '|', l, r: this.band(), line: l.line };
        }
        return l;
    }
    band() {
        let l = this.add();
        while (this.is('&')) {
            this.next();
            l = { k: 'bin', op: '&', l, r: this.add(), line: l.line };
        }
        return l;
    }
    add() {
        let l = this.mul();
        while (this.is('+') || this.is('-')) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.mul(), line: l.line };
        }
        return l;
    }
    mul() {
        let l = this.unary();
        while (this.is('*') || this.is('/') || this.is('//') || this.is('%')) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.unary(), line: l.line };
        }
        return l;
    }
    unary() {
        if (this.is('-') || this.is('+') || this.is('~')) {
            const t = this.next();
            return { k: 'un', op: t.v, x: this.unary(), line: t.line };
        }
        return this.power();
    }
    power() {
        const b = this.postfix();
        if (this.is('**')) {
            this.next();
            return { k: 'bin', op: '**', l: b, r: this.unary(), line: b.line };
        }
        return b;
    }
    postfix() {
        let x = this.atom();
        for (;;) {
            if (this.is('.')) {
                this.next();
                const n = this.next();
                x = { k: 'attr', x, name: n.v, line: x.line };
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
                    else
                        args.push({ value: this.expr() });
                    if (this.is(','))
                        this.next();
                    else if (!this.is(')'))
                        throw new Unsupported(`expected "," or ")" (line ${x.line}).`, 'CV-PY-UNREADABLE');
                }
                this.expect(')');
                x = { k: 'call', f: x, args, line: x.line };
                continue;
            }
            if (this.is('[')) {
                this.next();
                const i = this.expr();
                if (this.is(':') || this.is(','))
                    throw new Unsupported('slices and .loc-style selections are not converted.', 'CV-PY-SLICE');
                this.expect(']');
                x = { k: 'sub', x, i, line: x.line };
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
            const first = this.expr();
            if (this.is(',')) {
                const items = [first];
                while (this.is(',')) {
                    this.next();
                    if (this.is(')'))
                        break;
                    items.push(this.expr());
                }
                this.expect(')');
                return { k: 'tuple', items, line: t.line };
            }
            this.expect(')');
            return first;
        }
        throw new Unsupported(`unexpected "${t.v}" (line ${t.line}).`, 'CV-PY-UNREADABLE');
    }
}
const FIELDS = { close: 'close', open: 'open', high: 'high', low: 'low', volume: 'volume', 'adj close': 'close', adj_close: 'close' };
const TAKEN = new Set(['open', 'high', 'low', 'close', 'volume', 'abs', 'min', 'max', 'nz', 'near', 'all', 'any', 'input', 'show', 'plot', 'mark', 'alert', 'tf', 'ref', 'range', 'na', 'is_na', 'sum', 'avg', 'fill', 'bgcolor', 'bench', 'breadth', 'candle', 'color', 'fund', 'fut', 'ind', 'info', 'levels', 'opt', 'pattern', 'price', 'strategy', 'ta', 'xs', 'flow', 'deriv', 'math']);
const SIGNAL_NAMES = new Set(['signal', 'signals', 'buy', 'buy_signal', 'entry', 'condition', 'cond', 'setup', 'match']);
class Writer {
    notes = [];
    scope = new Map();
    /** pandas-ta columns appended with append=True: column name -> value. */
    columns = new Map();
    taken = new Set();
    body = [];
    signal = null;
    lastBool = null;
    strategy = null;
    /** talib.BBANDS split into names: each band is written (as bb_<band>) only when it is used. */
    pendingBands = null;
    bandsNoted = false;
    note(level, code, message, line) {
        if (this.notes.some((n) => n.code === code && n.message === message))
            return;
        this.notes.push({ line, level, code, message });
    }
    fresh(base) {
        let n = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, 'v_$1');
        if (TAKEN.has(n))
            n = `${n}_`;
        const root = n;
        let i = 2;
        while (this.taken.has(n))
            n = `${root}_${i++}`;
        this.taken.add(n);
        return n;
    }
    num(n, what) {
        if (n && n.k === 'num')
            return n.v;
        throw new Unsupported(`${what} needs a written number here.`, 'CV-PY-ARGS');
    }
    isDf(n) {
        return n.k === 'name' && this.scope.get(n.v)?.k === 'df';
    }
    column(name, line) {
        const low = name.toLowerCase();
        if (FIELDS[low]) {
            if (low.startsWith('adj'))
                this.note('approx', 'CV-PY-ADJ-CLOSE', 'the adjusted close is read as close here (there is no separate adjusted series; Needs verification).', line);
            return { s: FIELDS[low], bool: false };
        }
        const col = this.columns.get(name);
        if (col)
            return col;
        const b = this.scope.get(`col:${name}`);
        if (b && b.k === 'name')
            return { s: b.cs, bool: b.bool };
        if (b && b.k === 'inline')
            return { s: b.s, bool: b.bool };
        if (b && b.k === 'dropped')
            throw new Unsupported(`the column "${name}" was left out, so this is left out too.`, 'CV-PY-DEPENDS-ON-DROPPED');
        throw new Unsupported(`the column "${name}" is not known (it is not a price and was not made above).`, 'CV-PY-COLUMN');
    }
    /** shift(k) on a value: x[k]. */
    shift(x, k, line) {
        if (k < 0)
            throw new Unsupported(`shift(${k}) reads a later row: it looks into the future, which is never converted.`, 'CV-PY-FUTURE');
        if (k === 0)
            return x;
        void line;
        return { s: /^[\w.]+$/.test(x.s) || /\)$/.test(x.s) ? `${x.s}[${k}]` : `(${x.s})[${k}]`, bool: x.bool };
    }
    tx(n) {
        switch (n.k) {
            case 'num':
                return { s: n.v, bool: false };
            case 'str':
                throw new Unsupported('a text is used where a value is expected.', 'CV-PY-TEXT');
            case 'name': {
                const b = this.scope.get(n.v);
                if (b) {
                    if (b.k === 'name')
                        return { s: b.cs, bool: b.bool };
                    if (b.k === 'inline' && b.s.startsWith('__band__') && this.pendingBands) {
                        const field = b.s.slice('__band__'.length);
                        const cs = this.fresh(`bb_${field}`);
                        if (!this.bandsNoted)
                            this.body.push({ text: '# Only the bands that are used are written (as bb_<band>); the others are left out.', src: this.pendingBands.line, comment: true });
                        this.bandsNoted = true;
                        this.body.push({ text: `${cs} = ${this.pendingBands.call}.${field}`, src: this.pendingBands.line, name: cs });
                        this.scope.set(n.v, { k: 'name', cs, bool: false });
                        return { s: cs, bool: false };
                    }
                    if (b.k === 'inline')
                        return { s: b.s, bool: b.bool };
                    if (b.k === 'dropped')
                        throw new Unsupported(`\`${n.v}\` was left out, so this is left out too.`, 'CV-PY-DEPENDS-ON-DROPPED');
                    throw new Unsupported(`\`${n.v}\` is a table or a module, not a value.`, 'CV-PY-NOT-VALUE');
                }
                const low = n.v.toLowerCase();
                if (FIELDS[low])
                    return { s: FIELDS[low], bool: false };
                if (n.v === 'True' || n.v === 'False')
                    return { s: n.v, bool: true };
                throw new Unsupported(`\`${n.v}\` is not known to the converter.`, 'CV-PY-NAME');
            }
            case 'sub': {
                if (this.isDf(n.x) && n.i.k === 'str')
                    return this.column(n.i.v, n.line);
                throw new Unsupported('selecting rows by position (.iloc, x[i]) is not converted; a script here works on every candlestick at once.', 'CV-PY-ROWS');
            }
            case 'attr': {
                if (this.isDf(n.x))
                    return this.column(n.name, n.line);
                throw new Unsupported(`.${n.name} is not converted.`, 'CV-PY-ATTR');
            }
            case 'un': {
                const x = this.tx(n.x);
                if (n.op === '~' || n.op === 'not')
                    return { s: `(not ${x.s})`, bool: true };
                return { s: `(${n.op}${x.s})`, bool: false };
            }
            case 'ifx': {
                const a = this.tx(n.a);
                return { s: `(${a.s} if ${this.tx(n.c).s} else ${this.tx(n.b).s})`, bool: a.bool };
            }
            case 'tuple':
                throw new Unsupported('several values at once are not converted here.', 'CV-PY-TUPLE');
            case 'bin':
                return this.bin(n);
            case 'call':
                return this.call(n);
        }
    }
    bin(n) {
        if (n.op === '&' || n.op === 'and') {
            const cross = this.crossPattern(n);
            if (cross)
                return cross;
            return { s: `(${this.tx(n.l).s} and ${this.tx(n.r).s})`, bool: true };
        }
        if (n.op === '|' || n.op === 'or')
            return { s: `(${this.tx(n.l).s} or ${this.tx(n.r).s})`, bool: true };
        const l = this.tx(n.l);
        const r = this.tx(n.r);
        if (['==', '!=', '<', '>', '<=', '>='].includes(n.op))
            return { s: `(${l.s} ${n.op} ${r.s})`, bool: true };
        if (n.op === '^')
            throw new Unsupported('^ (exclusive or) is not converted.', 'CV-PY-XOR');
        return { s: `(${l.s} ${n.op} ${r.s})`, bool: false };
    }
    /** (a > b) & (a.shift(1) <= b.shift(1)) is ta.crossover(a, b); the mirror is ta.crossunder. */
    crossPattern(n) {
        const now = n.l;
        const before = n.r;
        if (now.k !== 'bin' || before.k !== 'bin')
            return null;
        const unshift = (x) => (x.k === 'call' && x.f.k === 'attr' && x.f.name === 'shift' && x.args.length === 1 && x.args[0].value.k === 'num' && x.args[0].value.v === '1' ? x.f.x : null);
        const same = (a, b) => b !== null && JSON.stringify({ ...a, line: 0 }, (k, v) => (k === 'line' ? 0 : v)) === JSON.stringify({ ...b, line: 0 }, (k, v) => (k === 'line' ? 0 : v));
        const up = now.op === '>' && before.op === '<=';
        const down = now.op === '<' && before.op === '>=';
        if (!up && !down)
            return null;
        if (!same(now.l, unshift(before.l)) || !same(now.r, unshift(before.r)))
            return null;
        this.note('info', 'CV-PY-CROSS', '(a > b) & (a.shift(1) <= b.shift(1)) is ta.crossover(a, b).', n.line);
        return { s: `ta.${up ? 'crossover' : 'crossunder'}(${this.tx(now.l).s}, ${this.tx(now.r).s})`, bool: true };
    }
    kw(args, name, pos) {
        return args.find((a) => a.name === name)?.value ?? args.filter((a) => !a.name)[pos]?.value;
    }
    call(n) {
        const f = n.f;
        // method chains on a value: x.rolling(n).mean(), x.shift(k), x.ewm(span=n).mean(), x.pct_change(n), x.diff(n)
        if (f.k === 'attr') {
            const m = f.name;
            const recv = f.x;
            if (recv.k === 'call' && recv.f.k === 'attr' && recv.f.name === 'rolling') {
                const x = this.tx(recv.f.x);
                if (recv.args.some((a) => a.name === 'center' && a.value.k === 'name' && a.value.v === 'True'))
                    throw new Unsupported('a centred rolling window reads later rows (the future); never converted.', 'CV-PY-FUTURE');
                const len = this.num(this.kw(recv.args, 'window', 0), 'rolling');
                switch (m) {
                    case 'mean':
                        return { s: `ta.sma(${x.s}, ${len})`, bool: false };
                    case 'max':
                        return { s: `ta.highest(${x.s}, ${len})`, bool: false };
                    case 'min':
                        return { s: `ta.lowest(${x.s}, ${len})`, bool: false };
                    case 'std':
                        this.note('approx', 'CV-PY-STD', 'pandas .std() divides by n - 1; ta.stdev divides by n (the population form), so the value is a little smaller.', n.line);
                        return { s: `ta.stdev(${x.s}, ${len})`, bool: false };
                    case 'median':
                        return { s: `ta.median(${x.s}, ${len})`, bool: false };
                    case 'sum':
                        if (x.bool)
                            return { s: `ta.count(${x.s}, ${len})`, bool: false };
                        this.note('approx', 'CV-PY-ROLLING-SUM', '.rolling(n).sum() of numbers is written ta.sma(x, n) * n; the last decimal places can differ.', n.line);
                        return { s: `(ta.sma(${x.s}, ${len}) * ${len})`, bool: false };
                    default:
                        throw new Unsupported(`.rolling(...).${m}() is not converted.`, 'CV-PY-ROLLING');
                }
            }
            if (recv.k === 'call' && recv.f.k === 'attr' && recv.f.name === 'ewm' && m === 'mean') {
                const x = this.tx(recv.f.x);
                const span = this.kw(recv.args, 'span', 0);
                if (!span)
                    throw new Unsupported('ewm() is converted only with span=n.', 'CV-PY-EWM');
                this.note('approx', 'CV-PY-EWM', "pandas ewm(adjust=False) starts from the first close; ta.ema has its own start, so early values differ (Needs verification).", n.line);
                return { s: `ta.ema(${x.s}, ${this.num(span, 'ewm')})`, bool: false };
            }
            if (m === 'shift') {
                const neg = n.args[0]?.value.k === 'un' && n.args[0].value.op === '-';
                if (neg)
                    throw new Unsupported('shift(-k) reads a later row: it looks into the future, which is never converted.', 'CV-PY-FUTURE');
                const k = Number(n.args.length ? this.num(this.kw(n.args, 'periods', 0), 'shift') : '1');
                return this.shift(this.tx(recv), k, n.line);
            }
            if (m === 'pct_change') {
                const k = n.args.length ? this.num(this.kw(n.args, 'periods', 0), 'pct_change') : '1';
                const x = this.tx(recv);
                return { s: `(${x.s} / ${this.shift(x, Number(k), n.line).s} - 1)`, bool: false };
            }
            if (m === 'diff') {
                const k = n.args.length ? this.num(this.kw(n.args, 'periods', 0), 'diff') : '1';
                const x = this.tx(recv);
                return { s: `(${x.s} - ${this.shift(x, Number(k), n.line).s})`, bool: false };
            }
            if (m === 'abs')
                return { s: `abs(${this.tx(recv).s})`, bool: false };
            // library calls: ta.* (pandas-ta), talib.*, np.*
            if (recv.k === 'name') {
                const lib = this.scope.get(recv.v);
                const libName = lib && lib.k === 'module' ? lib.lib : recv.v;
                if (libName === 'pandas_ta')
                    return this.pandasTa(m, n);
                if (libName === 'talib')
                    return this.talib(m, n);
                if (libName === 'numpy' && m === 'where') {
                    const c = this.tx(n.args[0].value);
                    const a = n.args[1]?.value;
                    const b = n.args[2]?.value;
                    if (a && b && a.k === 'num' && b.k === 'num' && a.v === '1' && b.v === '0')
                        return c;
                    if (a && b && a.k === 'name' && b.k === 'name' && a.v === 'True' && b.v === 'False')
                        return c;
                    const av = this.tx(a);
                    return { s: `(${av.s} if ${c.s} else ${this.tx(b).s})`, bool: av.bool };
                }
            }
            if (m === 'iloc' || m === 'apply' || m === 'loc')
                throw new Unsupported(`.${m} is not converted; a script here works on every candlestick at once.`, 'CV-PY-ROWS');
        }
        throw new Unsupported('this call is not converted.', 'CV-PY-CALL');
    }
    pandasTa(m, n) {
        const x = () => this.tx(this.kw(n.args, 'close', 0));
        const len = (d) => {
            const v = this.kw(n.args, 'length', 1);
            return v ? this.num(v, m) : d;
        };
        switch (m) {
            case 'rsi':
                return { s: `ta.rsi(${x().s}, ${len('14')})`, bool: false };
            case 'sma':
            case 'ema':
            case 'wma':
                return { s: `ta.${m}(${x().s}, ${len('10')})`, bool: false };
            default:
                throw new Unsupported(`pandas-ta ${m}() is not converted.`, 'CV-PY-PANDAS-TA');
        }
    }
    talib(m, n) {
        const period = (pos, d) => {
            const v = this.kw(n.args, 'timeperiod', pos);
            return v ? this.num(v, `talib.${m}`) : d;
        };
        switch (m) {
            case 'RSI':
                return { s: `ta.rsi(${this.tx(n.args[0].value).s}, ${period(1, '14')})`, bool: false };
            case 'SMA':
            case 'EMA':
            case 'WMA':
                return { s: `ta.${m.toLowerCase()}(${this.tx(n.args[0].value).s}, ${period(1, '30')})`, bool: false };
            case 'ATR':
                return { s: `ta.atr(${period(3, '14')})`, bool: false };
            case 'CCI':
                return { s: `ta.cci(hlc3, ${period(3, '14')})`, bool: false };
            case 'MAX':
                return { s: `ta.highest(${this.tx(n.args[0].value).s}, ${period(1, '30')})`, bool: false };
            case 'MIN':
                return { s: `ta.lowest(${this.tx(n.args[0].value).s}, ${period(1, '30')})`, bool: false };
            case 'MFI':
                return { s: `ind.mfi(${period(4, '14')})`, bool: false };
            case 'OBV':
                return { s: 'ind.obv()', bool: false };
            default:
                throw new Unsupported(`talib.${m} is not converted.`, 'CV-PY-TALIB');
        }
    }
}
/** Convert Python (pandas family) text to a draft. */
export function convertPythonDraft(text, kind) {
    const w = new Writer();
    w.scope.set('df', { k: 'df' });
    w.scope.set('data', { k: 'df' });
    const lines = logicalLines(text);
    const refuse = (l, err, names = []) => {
        const e = err instanceof Unsupported ? err : new Unsupported(err instanceof Error ? err.message : 'not converted.', 'CV-PY-UNREADABLE');
        w.note(e.level, e.code, `${e.message}${e.level === 'unsupported' ? ' Left out.' : ''}`, l.line);
        if (e.level === 'unsupported')
            w.body.push({ text: `# unsupported: ${l.text.slice(0, 160)}`, src: l.line, comment: true });
        for (const nm of names)
            w.scope.set(nm, { k: 'dropped' });
    };
    for (const l of lines) {
        if (l.comment !== undefined) {
            w.body.push({ text: `# ${l.comment}`, src: l.line, comment: true });
            continue;
        }
        if (l.error) {
            refuse(l, new Unsupported(l.error, 'CV-PY-UNREADABLE'));
            continue;
        }
        const t = l.toks;
        const first = t[0]?.v;
        // imports
        if (first === 'import' || first === 'from') {
            const mod = first === 'import' ? t[1]?.v : t[1]?.v;
            const asIdx = t.findIndex((x) => x.v === 'as');
            const alias = asIdx > 0 ? t[asIdx + 1]?.v : mod;
            if (mod && alias)
                w.scope.set(alias, { k: 'module', lib: mod });
            w.note('info', 'CV-PY-IMPORT', 'imports are not needed here: the price columns and the library are always there.', l.line);
            continue;
        }
        if (l.indent > 0 || ['for', 'while', 'def', 'class', 'if', 'with', 'try', 'async', 'return', 'elif', 'else', 'except', 'lambda'].includes(first ?? '')) {
            refuse(l, new Unsupported(`${first === 'def' || first === 'class' ? 'functions and classes' : 'loops and blocks'} are not converted; a script here works on every candlestick at once (a vectorised rule converts).`, 'CV-PY-BLOCK'));
            continue;
        }
        const r = new Reader(t);
        try {
            // targets
            const targets = [];
            const eq = t.findIndex((x, i) => x.t === 'op' && x.v === '=' && t.slice(0, i).filter((y) => y.v === '(' || y.v === '[').length === t.slice(0, i).filter((y) => y.v === ')' || y.v === ']').length);
            if (eq > 0) {
                const lhs = new Reader(t.slice(0, eq));
                targets.push(lhs.postfix());
                while (lhs.is(',')) {
                    lhs.next();
                    targets.push(lhs.postfix());
                }
                r.i = eq + 1;
            }
            const value = r.expr();
            if (r.i < t.length)
                throw new Unsupported(`"${t[r.i].v}" could not be read (line ${l.line}).`, 'CV-PY-UNREADABLE');
            if (!targets.length) {
                statementCall(w, value, l);
                continue;
            }
            // df = pd.read_csv(...), yf.download(...): data loading
            if (targets.length === 1 && targets[0].k === 'name' && value.k === 'call' && JSON.stringify(value).match(/read_csv|download|DataFrame|get_data|historical/)) {
                w.scope.set(targets[0].v, { k: 'df' });
                w.note('info', 'CV-PY-DATA', 'loading data is left out: the candles here come from the host.', l.line);
                continue;
            }
            // vectorbt backtest
            if (value.k === 'call' && JSON.stringify(value.f).includes('"from_signals"')) {
                const entries = w.kw(value.args, 'entries', 1);
                const exits = w.kw(value.args, 'exits', 2);
                if (!entries)
                    throw new Unsupported('from_signals without entries is not converted.', 'CV-PY-VBT');
                const stops = [];
                const sl = value.args.find((a) => a.name === 'sl_stop')?.value;
                const tp = value.args.find((a) => a.name === 'tp_stop')?.value;
                const pct = (x) => String(Math.round(Number(w.num(x, 'stop')) * 100 * 1e6) / 1e6);
                if (sl)
                    stops.push(`strategy.stop_loss(pct=${pct(sl)})`);
                if (tp)
                    stops.push(`strategy.take_profit(pct=${pct(tp)})`);
                if (value.args.some((a) => a.name === 'sl_trail'))
                    w.note('unsupported', 'CV-PY-VBT-TRAIL', 'sl_trail is not converted (strategy.trail takes a fixed percent; check the value). Left out.', l.line);
                w.strategy = { entry: w.tx(entries).s, exit: exits ? w.tx(exits).s : null, stops, line: l.line };
                continue;
            }
            if (targets.length > 1) {
                tupleAssign(w, targets, value, l);
                continue;
            }
            const target = targets[0];
            const v = w.tx(value);
            let base;
            let key;
            if (target.k === 'name') {
                base = target.v;
                key = target.v;
            }
            else if (target.k === 'sub' && w.isDf(target.x) && target.i.k === 'str') {
                base = target.i.v;
                key = `col:${target.i.v}`;
            }
            else
                throw new Unsupported('this assignment target is not converted.', 'CV-PY-TARGET');
            if (SIGNAL_NAMES.has(base.toLowerCase()) && v.bool) {
                w.signal = { s: v.s, line: l.line };
                w.scope.set(key, { k: 'inline', s: v.s, bool: true });
                continue;
            }
            if (['entries', 'exits', 'entry_signal', 'exit_signal', 'long_entries', 'long_exits'].includes(base.toLowerCase())) {
                w.scope.set(key, { k: 'inline', s: v.s, bool: v.bool });
                continue;
            }
            const cs = w.fresh(base.toLowerCase());
            w.body.push({ text: `${cs} = ${v.s}`, src: l.line, name: cs });
            w.scope.set(key, { k: 'name', cs, bool: v.bool });
            if (v.bool)
                w.lastBool = { s: cs, line: l.line, name: cs };
        }
        catch (err) {
            const names = t[0]?.t === 'name' && t[1]?.v === '=' ? [t[0].v] : [];
            refuse(l, err, names);
        }
    }
    // the result
    let target = w.strategy ? 'strategy' : 'screener';
    if (kind)
        target = kind;
    const out = [];
    let failed = false;
    const body = w.body;
    if (target === 'screener') {
        let cond = w.signal;
        if (!cond && w.lastBool) {
            // the last true/false column is the condition
            const i = body.findIndex((b) => b.name === w.lastBool?.name);
            const line = body[i];
            body.splice(i, 1);
            cond = { s: line.text.slice(line.text.indexOf('=') + 1).trim(), line: line.src };
            w.note('info', 'CV-PY-CONDITION', `the last true/false value (line ${line.src}) is taken as the screener's condition.`, line.src);
        }
        if (!cond) {
            failed = true;
            w.note('unsupported', 'CV-PY-NO-CONDITION', 'there is no condition to screen for (name it signal = ...).', 1);
        }
        else {
            out.push(...body);
            out.push({ text: cond.s, src: cond.line });
        }
    }
    else if (target === 'strategy' && w.strategy) {
        out.push({ text: '# approx: vectorbt fills at the signal close by default; the backtest here fills at the next open.', src: 0 });
        w.note('approx', 'CV-PY-VBT-FILL', 'vectorbt fills at the signal close by default; the backtest here fills at the next open.', w.strategy.line);
        out.push({ text: '@strategy(universe="liquid")', src: 0 }, { text: 'def converted():', src: 0 });
        for (const b of body)
            out.push({ text: `    ${b.text}`, src: b.src });
        out.push({ text: `    strategy.entry(${w.strategy.entry})`, src: w.strategy.line });
        if (w.strategy.exit)
            out.push({ text: `    strategy.exit(${w.strategy.exit})`, src: w.strategy.line });
        for (const st of w.strategy.stops)
            out.push({ text: `    ${st}`, src: w.strategy.line });
    }
    else {
        failed = true;
        w.note('unsupported', 'CV-PY-KIND', `Python is converted as a screener or (with vectorbt) a strategy, not as ${target === 'alert' ? 'an alert' : `an ${target}`}.`, 1);
    }
    return { kind: target, text: out.map((l) => l.text).join('\n') + '\n', srcLines: out.map((l) => l.src), notes: w.notes, companions: [], ...(failed ? { failed: true } : {}) };
}
function statementCall(w, value, l) {
    // df.ta.macd(fast=12, slow=26, signal=9, append=True): pandas-ta adds columns
    if (value.k === 'call' && value.f.k === 'attr' && value.f.x.k === 'attr' && value.f.x.name === 'ta' && w.isDf(value.f.x.x)) {
        const m = value.f.name;
        const num = (name, pos, d) => {
            const v = w.kw(value.args, name, pos);
            return v ? w.num(v, m) : d;
        };
        if (m === 'macd') {
            const f = num('fast', 0, '12');
            const s = num('slow', 1, '26');
            const g = num('signal', 2, '9');
            const call = `ind.macd(${f}, ${s}, ${g})`;
            w.columns.set(`MACD_${f}_${s}_${g}`, { s: `${call}.macd`, bool: false });
            w.columns.set(`MACDh_${f}_${s}_${g}`, { s: `${call}.hist`, bool: false });
            w.columns.set(`MACDs_${f}_${s}_${g}`, { s: `${call}.signal`, bool: false });
            w.note('info', 'CV-PY-PANDAS-TA-COLUMNS', `df.ta.macd(...) adds the columns MACD_${f}_${s}_${g}, MACDh_ and MACDs_; they are ${call}.macd, .hist and .signal.`, l.line);
            return;
        }
        if (m === 'rsi' || m === 'sma' || m === 'ema') {
            const n = num('length', 0, m === 'rsi' ? '14' : '10');
            w.columns.set(`${m.toUpperCase()}_${n}`, { s: `ta.${m}(close, ${n})`, bool: false });
            return;
        }
        throw new Unsupported(`df.ta.${m}() is not converted.`, 'CV-PY-PANDAS-TA');
    }
    if (value.k === 'call' && value.f.k === 'name' && value.f.v === 'print') {
        w.note('info', 'CV-PY-PRINT', 'print() is left out.', l.line);
        return;
    }
    throw new Unsupported('a call on its own line is not converted.', 'CV-PY-CALL');
}
function tupleAssign(w, targets, value, l) {
    // upper, middle, lower = talib.BBANDS(close, timeperiod=20, nbdevup=2, nbdevdn=2)
    if (value.k === 'call' && value.f.k === 'attr' && value.f.name === 'BBANDS') {
        const len = w.num(w.kw(value.args, 'timeperiod', 1), 'BBANDS');
        const up = w.kw(value.args, 'nbdevup', 2);
        const dn = w.kw(value.args, 'nbdevdn', 3);
        const k = up ? w.num(up, 'BBANDS') : '2';
        if (dn && w.num(dn, 'BBANDS') !== k)
            throw new Unsupported('BBANDS with different up and down widths has no equal here.', 'CV-PY-BBANDS');
        const src = w.tx(value.args[0].value).s;
        const call = src === 'close' ? `ind.bb(${len}, ${k})` : `ind.bb(${len}, ${k}, src=${src})`;
        ['upper', 'mid', 'lower'].forEach((field, i) => {
            const tg = targets[i];
            if (!tg || tg.k !== 'name' || tg.v === '_')
                return;
            // named bb_<line>, so the name says which band it is (Pine and pandas give the bands in different orders)
            w.scope.set(tg.v, { k: 'inline', s: `__band__${field}`, bool: false });
        });
        w.pendingBands = { call, line: l.line, targets: targets.map((t) => (t.k === 'name' ? t.v : '_')) };
        return;
    }
    if (value.k === 'call' && value.f.k === 'attr' && value.f.name === 'MACD') {
        const src = w.tx(value.args[0].value).s;
        const f = w.kw(value.args, 'fastperiod', 1);
        const s = w.kw(value.args, 'slowperiod', 2);
        const g = w.kw(value.args, 'signalperiod', 3);
        const call = `ind.macd(${f ? w.num(f, 'MACD') : '12'}, ${s ? w.num(s, 'MACD') : '26'}, ${g ? w.num(g, 'MACD') : '9'}${src === 'close' ? '' : `, src=${src}`})`;
        ['macd', 'signal', 'hist'].forEach((field, i) => {
            const tg = targets[i];
            if (tg && tg.k === 'name' && tg.v !== '_')
                w.scope.set(tg.v, { k: 'inline', s: `${call}.${field}`, bool: false });
        });
        return;
    }
    throw new Unsupported('splitting a result into several names is converted only for talib.BBANDS and talib.MACD.', 'CV-PY-TUPLE');
}
