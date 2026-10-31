// Chartink scan text to ChartistScript. Both forms users paste: the display text ("Daily Close Greater than Daily Sma( close,200 )",
// one condition per line) and the scan clause ("( {cash} ( latest close > latest sma( latest close , 200 ) ) )"). Chartink
// publishes no grammar; the names below come from its help pages and common scans, and every point not checked against a real
// export is marked Needs verification in docs/features/script-import/README.md. A Chartink scan is a screener.
class Unsupported extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
// ---- tokens ----------------------------------------------------------------------------------------------------------------
/** Multi-word names, longest first. Value: the token they become. */
const PHRASES = [
    [['greater', 'than', 'or', 'equal', 'to'], 'op:>='],
    [['less', 'than', 'or', 'equal', 'to'], 'op:<='],
    [['greater', 'than', 'equal', 'to'], 'op:>='],
    [['less', 'than', 'equal', 'to'], 'op:<='],
    [['greater', 'than'], 'op:>'],
    [['less', 'than'], 'op:<'],
    [['equal', 'to'], 'op:='],
    [['equals'], 'op:='],
    [['crossed', 'above'], 'op:xa'],
    [['crossed', 'below'], 'op:xb'],
    [['market', 'cap'], 'w:mcap'],
    [['pe', 'ratio'], 'w:pe'],
    [['macd', 'line'], 'w:macd_line'],
    [['macd', 'signal'], 'w:macd_signal'],
    [['macd', 'histogram'], 'w:macd_hist'],
    [['upper', 'bollinger', 'band'], 'w:bb_upper'],
    [['lower', 'bollinger', 'band'], 'w:bb_lower'],
    [['middle', 'bollinger', 'band'], 'w:bb_mid'],
    [['adx', 'di', 'positive'], 'w:adx_plus'],
    [['adx', 'di', 'negative'], 'w:adx_minus'],
    [['avg', 'true', 'range'], 'w:atr'],
    [['average', 'true', 'range'], 'w:atr'],
    [['williams', '%r'], 'w:wpr'],
    [['slow', 'stochastic', '%k'], 'w:stoch_k'],
    [['slow', 'stochastic', '%d'], 'w:stoch_d'],
    [['parabolic', 'sar'], 'w:sar'],
].sort((a, b) => b[0].length - a[0].length);
function tokenize(text) {
    const raw = [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((l, i) => {
        const line = i + 1;
        let j = 0;
        while (j < l.length) {
            const c = l[j];
            if (/\s/.test(c)) {
                j++;
                continue;
            }
            const seg = /^\{\s*([a-z]+|\d+)\s*\}/i.exec(l.slice(j));
            if (seg) {
                raw.push({ t: 'seg', v: seg[1].toLowerCase(), line });
                j += seg[0].length;
                continue;
            }
            const num = /^\d+(\.\d+)?/.exec(l.slice(j));
            if (num) {
                raw.push({ t: 'num', v: num[0], line });
                j += num[0].length;
                continue;
            }
            const w = /^%?[A-Za-z_][A-Za-z0-9_%]*/.exec(l.slice(j));
            if (w) {
                raw.push({ t: 'word', v: w[0].toLowerCase(), line });
                j += w[0].length;
                continue;
            }
            const op = /^(>=|<=|!=|<>|==|[()[\],+\-*/<>=])/.exec(l.slice(j));
            if (op) {
                raw.push({ t: 'op', v: op[0] === '<>' ? '!=' : op[0] === '==' ? '=' : op[0], line });
                j += op[0].length;
                continue;
            }
            throw new Unsupported(`the character "${c}" on line ${line} is not part of a Chartink scan.`, 'CV-CHARTINK-UNREADABLE');
        }
    });
    // multi-word names
    const out = [];
    for (let i = 0; i < raw.length;) {
        let hit = false;
        for (const [words, tok] of PHRASES) {
            if (words.every((w, k) => raw[i + k]?.t === 'word' && raw[i + k].v === w)) {
                const [kind, v] = tok.split(':');
                out.push({ t: kind === 'op' ? 'op' : 'word', v, line: raw[i].line });
                i += words.length;
                hit = true;
                break;
            }
        }
        if (!hit)
            out.push(raw[i++]);
    }
    return out;
}
// ---- parser ----------------------------------------------------------------------------------------------------------------
const COMPARE = { '>': '>', '<': '<', '>=': '>=', '<=': '<=', '=': '==', '!=': '!=', xa: 'xa', xb: 'xb' };
class Parser {
    toks;
    src;
    i = 0;
    segments = [];
    constructor(toks, src) {
        this.toks = toks;
        this.src = src;
    }
    peek(o = 0) {
        return this.toks[this.i + o];
    }
    is(v, o = 0) {
        const t = this.peek(o);
        return !!t && (t.t === 'op' || t.t === 'word') && t.v === v;
    }
    next() {
        const t = this.toks[this.i++];
        if (!t)
            throw new Unsupported('the scan ends too early.', 'CV-CHARTINK-UNREADABLE');
        return t;
    }
    expect(v) {
        const t = this.next();
        if (t.v !== v)
            throw new Unsupported(`expected "${v}" on line ${t.line}, found "${t.v}".`, 'CV-CHARTINK-UNREADABLE');
    }
    or() {
        const first = this.and();
        const items = [first];
        while (this.is('or')) {
            this.next();
            items.push(this.and());
        }
        return items.length === 1 ? first : { k: 'logic', op: 'or', items, line: first.line };
    }
    and() {
        const first = this.cmp();
        const items = [first];
        for (;;) {
            if (this.is('and')) {
                this.next();
                items.push(this.cmp());
                continue;
            }
            // display form: a new line starts a new condition
            const t = this.peek();
            if (t && t.line > (this.toks[this.i - 1]?.line ?? t.line) && !this.is(')') && !this.is('or')) {
                items.push(this.cmp());
                continue;
            }
            break;
        }
        return items.length === 1 ? first : { k: 'logic', op: 'and', items, line: first.line };
    }
    cmp() {
        const l = this.sum();
        const t = this.peek();
        if (t && t.t === 'op' && COMPARE[t.v]) {
            this.next();
            const r = this.sum();
            return { k: 'cmp', op: COMPARE[t.v], l, r, line: l.line };
        }
        return l;
    }
    sum() {
        let l = this.term();
        while (this.is('+') || this.is('-')) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.term(), line: l.line };
        }
        return l;
    }
    term() {
        let l = this.unary();
        while (this.is('*') || this.is('/')) {
            const op = this.next().v;
            l = { k: 'bin', op, l, r: this.unary(), line: l.line };
        }
        return l;
    }
    unary() {
        if (this.is('-')) {
            const t = this.next();
            return { k: 'neg', x: this.unary(), line: t.line };
        }
        return this.primary();
    }
    primary() {
        const t = this.peek();
        if (!t)
            throw new Unsupported('the scan ends too early.', 'CV-CHARTINK-UNREADABLE');
        if (t.t === 'op' && t.v === '(') {
            this.next();
            while (this.peek()?.t === 'seg')
                this.segments.push(this.next().v);
            const e = this.or();
            this.expect(')');
            return e;
        }
        return this.value();
    }
    value() {
        const start = this.i;
        let off = 0;
        let frame = '';
        const line = this.peek()?.line ?? 1;
        // prefixes in any order: latest | N day(s)/week(s)/month(s) ago | [n] | daily/weekly/monthly | N minute / N hour
        for (;;) {
            const t = this.peek();
            if (!t)
                break;
            if (t.t === 'word' && t.v === 'latest') {
                this.next();
                continue;
            }
            if (t.t === 'num' && this.peek(1)?.t === 'word' && /^(day|days|week|weeks|month|months|candle|candles)$/.test(this.peek(1)?.v ?? '') && this.is('ago', 2)) {
                const unit = this.peek(1)?.v ?? '';
                this.i += 3;
                const n = Number(t.v);
                if (/^week/.test(unit)) {
                    if (frame && frame !== 'W')
                        throw new Unsupported(`"${t.v} ${unit} ago" on a ${frame === 'M' ? 'monthly' : 'daily'} value is not converted.`, 'CV-CHARTINK-OFFSET');
                    frame = 'W';
                }
                else if (/^month/.test(unit)) {
                    if (frame && frame !== 'M')
                        throw new Unsupported(`"${t.v} ${unit} ago" on a ${frame === 'W' ? 'weekly' : 'daily'} value is not converted.`, 'CV-CHARTINK-OFFSET');
                    frame = 'M';
                }
                off += n;
                continue;
            }
            if (t.t === 'op' && t.v === '[') {
                // [0], [-1], [=1]: intraday candle positions
                this.next();
                let neg = false;
                let eq = false;
                if (this.is('-')) {
                    this.next();
                    neg = true;
                }
                if (this.is('=')) {
                    this.next();
                    eq = true;
                }
                const n = this.next();
                this.expect(']');
                if (eq)
                    frame = 'I';
                off += neg ? Number(n.v) : 0;
                continue;
            }
            if (t.t === 'word' && (t.v === 'daily' || t.v === 'weekly' || t.v === 'monthly')) {
                this.next();
                frame = t.v === 'daily' ? 'D' : t.v === 'weekly' ? 'W' : 'M';
                continue;
            }
            if (t.t === 'word' && t.v === 'quarterly')
                throw new Unsupported('quarterly candles are not available.', 'CV-CHARTINK-FRAME');
            if (t.t === 'num' && this.peek(1)?.t === 'word' && /^(minute|minutes|hour|hours)$/.test(this.peek(1)?.v ?? '')) {
                // read, so the rest of the scan can still be converted; the writer refuses it
                this.i += 2;
                frame = 'I';
                continue;
            }
            break;
        }
        const t = this.next();
        const text = () => this.toks
            .slice(start, this.i)
            .map((x) => (x.t === 'seg' ? `{${x.v}}` : x.v))
            .join(' ');
        if (t.t === 'num')
            return { k: 'num', v: t.v, line: t.line };
        if (t.t === 'word' && t.v === 'number') {
            const neg = this.is('-') ? (this.next(), '-') : '';
            const n = this.next();
            if (n.t !== 'num')
                throw new Unsupported(`"Number" must be followed by a number (line ${n.line}).`, 'CV-CHARTINK-UNREADABLE');
            return { k: 'num', v: `${neg}${n.v}`, line: n.line };
        }
        if (t.t !== 'word')
            throw new Unsupported(`unexpected "${t.v}" on line ${t.line}.`, 'CV-CHARTINK-UNREADABLE');
        const name = t.v;
        const args = [];
        if (this.is('(')) {
            this.next();
            while (!this.is(')')) {
                args.push(this.sum());
                if (this.is(','))
                    this.next();
                else if (!this.is(')')) {
                    // count( n , k where ... ) and other forms with words inside
                    throw new Unsupported(`the arguments of ${name}( ... ) on line ${line} are not in a form the converter reads.`, 'CV-CHARTINK-ARGS');
                }
            }
            this.expect(')');
        }
        return { k: 'val', name, args, off, frame, line, text: text() };
    }
}
class Writer {
    notes = [];
    hoists = new Map();
    shows = [];
    approxComments = [];
    note(level, code, message, line) {
        if (this.notes.some((n) => n.code === code && n.message === message))
            return;
        this.notes.push({ line, level, code, message });
    }
    hoist(key, base, value, comment) {
        const have = this.hoists.get(key);
        if (have) {
            have.uses++;
            return have.name;
        }
        const taken = new Set([...this.hoists.values()].map((h) => h.name));
        let name = base;
        let i = 2;
        while (taken.has(name))
            name = `${base}_${i++}`;
        const h = { name, value, uses: 1 };
        if (comment)
            h.comment = comment;
        this.hoists.set(key, h);
        return name;
    }
    frameName(frame, line) {
        if (frame !== 'W' && frame !== 'M')
            return '';
        const word = frame === 'W' ? 'week' : 'month';
        this.note('approx', 'CV-CHARTINK-FORMING', `Chartink reads the ${word} that is still forming; tf("${frame}") uses completed ${word}s only.`, line);
        const name = this.hoist(`tf:${frame}`, word, `tf("${frame}")`, `approx: Chartink reads the ${word} that is still forming; tf("${frame}") uses completed ${word}s only.`);
        const h = this.hoists.get(`tf:${frame}`);
        if (h)
            h.uses = Math.max(h.uses, 2); // a frame is always named
        return name;
    }
    shift(s, off) {
        if (!off)
            return s;
        return /^[A-Za-z_][\w.]*$/.test(s) || /\)$/.test(s) ? `${s}[${off}]` : `(${s})[${off}]`;
    }
    /** A value. `outer` = the frame of the call it is an argument of, used when the value has no frame of its own. */
    val(n, outer = '') {
        switch (n.k) {
            case 'num':
                return n.v;
            case 'neg':
                return `(-${this.val(n.x, outer)})`;
            case 'bin': {
                const l = this.val(n.l, outer);
                const r = this.val(n.r, outer);
                // close * volume is the traded value: named and shown, as Chartink users read it
                if (n.op === '*' && ((l === 'close' && r === 'volume') || (l === 'volume' && r === 'close'))) {
                    const name = this.hoist('turnover', 'turnover', `${l} * ${r}`);
                    if (!this.shows.some((s) => s.name === name))
                        this.shows.push({ name, label: 'Turnover' });
                    const h = this.hoists.get('turnover');
                    if (h)
                        h.uses = Math.max(h.uses, 2);
                    return name;
                }
                return `(${l} ${n.op} ${r})`;
            }
            case 'cmp':
            case 'logic':
                throw new Unsupported('a condition is used where a number is expected.', 'CV-CHARTINK-UNREADABLE');
            case 'val':
                return this.value(n, outer);
        }
    }
    value(n, outer) {
        if (n.frame === 'I' || outer === 'I')
            throw new Unsupported('Scripts run on daily, weekly and monthly candles. Intraday scans cannot be converted yet.', 'CV-CHARTINK-INTRADAY');
        const frame = n.frame || outer || 'D';
        const fr = frame === 'D' ? '' : this.frameName(frame, n.line);
        const field = (p) => (fr ? `${fr}.${p}` : p);
        const num = (i) => {
            const a = n.args[i];
            if (!a || a.k !== 'num')
                throw new Unsupported(`${n.name}( ... ) on line ${n.line} needs written numbers here.`, 'CV-CHARTINK-ARGS');
            return a.v;
        };
        const arg = (i) => {
            const a = n.args[i];
            if (!a)
                throw new Unsupported(`${n.name}( ... ) on line ${n.line} is missing an argument.`, 'CV-CHARTINK-ARGS');
            return this.val(a, frame === 'D' ? '' : frame);
        };
        const daily = (what) => {
            if (fr)
                throw new Unsupported(`${what} on ${frame === 'W' ? 'weekly' : 'monthly'} candles is not converted (the study runs on daily candles here).`, 'CV-CHARTINK-FRAME-STUDY');
        };
        let s;
        switch (n.name) {
            case 'open':
            case 'high':
            case 'low':
            case 'close':
            case 'volume':
                s = field(n.name);
                break;
            case 'sma':
            case 'ema':
            case 'wma':
                if (n.args.length === 1)
                    s = `ta.${n.name}(${field('close')}, ${num(0)})`;
                else
                    s = `ta.${n.name}(${arg(0)}, ${num(1)})`;
                break;
            case 'rsi':
                s = n.args.length === 2 ? `ta.rsi(${arg(0)}, ${num(1)})` : `ta.rsi(${field('close')}, ${num(0)})`;
                break;
            case 'max':
            case 'min': {
                // Chartink writes the length first: max( 20 , high )
                const len = num(0);
                const x = arg(1);
                s = `ta.${n.name === 'max' ? 'highest' : 'lowest'}(${x}, ${len})`;
                this.note('info', 'CV-CHARTINK-MAX-ORDER', `${n.name}( n , x ) is ta.${n.name === 'max' ? 'highest' : 'lowest'}(x, n) here: the length comes second.`, n.line);
                break;
            }
            case 'abs':
                s = `abs(${arg(0)})`;
                break;
            case 'atr':
                if (fr)
                    s = `ta.rma(max([${fr}.high - ${fr}.low, abs(${fr}.high - ${fr}.close[1]), abs(${fr}.low - ${fr}.close[1])]), ${num(0)})`;
                else
                    s = `ta.atr(${num(0)})`;
                break;
            case 'cci':
                s = `ta.cci(${fr ? `(${fr}.high + ${fr}.low + ${fr}.close) / 3` : 'hlc3'}, ${num(0)})`;
                break;
            case 'supertrend':
                daily('supertrend');
                s = `${this.hoist(`st:${num(0)},${num(1)}`, 'st', `ind.supertrend(${num(0)}, ${num(1)})`)}.value`;
                break;
            case 'macd_line':
            case 'macd_signal':
            case 'macd_hist': {
                daily('MACD');
                const [slow, fast, sig] = [num(0), num(1), num(2)];
                const m = this.hoist(`macd:${fast},${slow},${sig}`, 'm', `ind.macd(${fast}, ${slow}, ${sig})`, `Chartink writes MACD as (slow, fast, signal); here it is (fast, slow, signal).`);
                this.note('info', 'CV-CHARTINK-MACD-ORDER', `MACD is written (${fast}, ${slow}, ${sig}) here; Chartink wrote (${slow}, ${fast}, ${sig}).`, n.line);
                s = `${m}.${n.name === 'macd_line' ? 'macd' : n.name === 'macd_signal' ? 'signal' : 'hist'}`;
                break;
            }
            case 'bb_upper':
            case 'bb_lower':
            case 'bb_mid': {
                daily('Bollinger band');
                const b = this.hoist(`bb:${num(0)},${num(1)}`, 'bb', `ind.bb(${num(0)}, ${num(1)})`);
                s = `${b}.${n.name === 'bb_upper' ? 'upper' : n.name === 'bb_lower' ? 'lower' : 'mid'}`;
                break;
            }
            case 'adx':
            case 'adx_plus':
            case 'adx_minus': {
                daily('ADX');
                const a = this.hoist(`adx:${num(0)}`, 'a', `ind.adx(${num(0)})`);
                s = `${a}.${n.name === 'adx' ? 'adx' : n.name === 'adx_plus' ? 'plus_di' : 'minus_di'}`;
                break;
            }
            case 'mfi':
                daily('MFI');
                s = `ind.mfi(${num(0)})`;
                break;
            case 'wpr':
                daily('Williams %R');
                s = `ind.williamsr(${num(0)})`;
                break;
            case 'obv':
                daily('OBV');
                s = 'ind.obv()';
                break;
            case 'mcap':
                s = 'info.mcap_cr';
                this.note('info', 'CV-CHARTINK-MCAP', 'Chartink market cap is in crore rupees, as info.mcap_cr (Needs verification).', n.line);
                break;
            case 'pe':
                s = 'fund.pe';
                break;
            case 'stoch_k':
            case 'stoch_d':
            case 'sar':
            case 'vwap':
            case 'count':
                throw new Unsupported(`${n.text}: this Chartink study has no confirmed equal here yet.`, 'CV-CHARTINK-STUDY');
            default:
                throw new Unsupported(`"${n.name}" is not a Chartink name the converter knows.`, 'CV-CHARTINK-NAME');
        }
        if (n.off && (n.name === 'mcap' || n.name === 'pe'))
            throw new Unsupported(`${n.text}: a value from an earlier day is not available for ${n.name === 'mcap' ? 'market cap' : 'the PE ratio'}.`, 'CV-CHARTINK-OFFSET');
        return this.shift(s, n.off);
    }
    cond(n) {
        if (n.k === 'logic') {
            if (n.op === 'or')
                return `(${n.items.map((x) => this.cond(x)).join(' or ')})`;
            return `(${n.items.map((x) => this.cond(x)).join(' and ')})`;
        }
        if (n.k === 'cmp') {
            const l = this.val(n.l);
            const r = this.val(n.r);
            if (n.op === 'xa')
                return `ta.crossover(${l}, ${r})`;
            if (n.op === 'xb')
                return `ta.crossunder(${l}, ${r})`;
            if (n.op === '==') {
                const isWholeNumber = n.r.k === 'num' && /^-?\d+$/.test(n.r.v);
                if (!isWholeNumber) {
                    this.note('approx', 'CV-CHARTINK-EQUALS', '"=" between two prices is written near(a, b, 0.01): equal within 0.01 percent, because decimals are rarely exactly equal.', n.line);
                    return `near(${l}, ${r}, 0.01)`;
                }
            }
            return `(${l} ${n.op} ${r})`;
        }
        throw new Unsupported('a number on its own is not a condition; compare it with something (for example "> 100").', 'CV-CHARTINK-NOT-CONDITION');
    }
}
/** The text of the source lines a node came from. */
function srcOf(src, line) {
    return (src[line - 1] ?? '').trim();
}
/** Convert Chartink scan text to a draft. */
export function convertChartinkDraft(text, kind) {
    const src = text.replace(/\r\n?/g, '\n').split('\n');
    const w = new Writer();
    const fail = (message, code, line = 1) => ({
        kind: 'screener',
        text: '',
        srcLines: [],
        notes: [{ line, level: 'unsupported', code, message }],
        companions: [],
        failed: true,
    });
    if (kind && kind !== 'screener') {
        return fail(`a Chartink scan is a screener; it cannot be converted as ${kind === 'alert' ? 'an alert' : `a ${kind}`}. Convert it as a screener, then make an alert from it.`, 'CV-CHARTINK-KIND');
    }
    let ast;
    let segments = [];
    let p;
    try {
        p = new Parser(tokenize(text), src);
        ast = p.or();
        if (p.i < p.toks.length) {
            const t = p.toks[p.i];
            throw new Unsupported(`"${t.v}" on line ${t.line} could not be read.`, 'CV-CHARTINK-UNREADABLE');
        }
        segments = p.segments;
    }
    catch (err) {
        if (err instanceof Unsupported)
            return fail(`${err.message}`, err.code);
        throw err;
    }
    // the top-level and-chain: each condition converts or is kept as an unsupported comment (never dropped silently)
    const top = ast.k === 'logic' && ast.op === 'and' ? ast.items : [ast];
    const kept = [];
    const leftOut = [];
    for (const c of top) {
        try {
            kept.push(w.cond(c));
        }
        catch (err) {
            if (!(err instanceof Unsupported))
                throw err;
            const orNote = c.k === 'logic' && c.op === 'or' ? ' One branch of an "or" could not be converted, so the whole "or" is left out.' : '';
            w.notes.push({ line: c.line, level: 'unsupported', code: err.code, message: `${err.message}${orNote} This condition is left out, so the scan can match more stocks than on Chartink.` });
            leftOut.push({ line: c.line, text: srcOf(src, c.line) });
        }
    }
    if (!kept.length) {
        return { kind: 'screener', text: '', srcLines: [], notes: w.notes, companions: [], failed: true };
    }
    const expr = kept.join(' and ');
    // segment
    const seg = segments[0];
    let universe = null;
    const headComments = [];
    if (seg !== undefined) {
        if (seg === 'cash') {
            universe = 'all';
            headComments.push('Segment {cash}: all cash-market stocks, so universe="all".');
        }
        else if (seg === '57960') {
            universe = 'fno';
            headComments.push('Segment {57960}: the F&O stock list (segment id mapping Needs verification).');
            w.note('approx', 'CV-CHARTINK-SEGMENT', 'segment {57960} is read as the F&O stock list (universe="fno"); the mapping of Chartink segment ids Needs verification.', 1);
        }
        else {
            universe = 'all';
            headComments.push(`Segment {${seg}} is not known here; the scan runs on all stocks (universe="all").`);
            w.note('approx', 'CV-CHARTINK-SEGMENT', `segment {${seg}} is not known here; the scan runs on all stocks. Set universe= to the list you meant.`, 1);
        }
    }
    const lines = [];
    const firstLine = top[0]?.line ?? 1;
    for (const c of headComments)
        lines.push({ text: `# ${c}`, src: 0 });
    const hoists = [...w.hoists.values()].filter((h) => h.uses >= 2 || h.name === 'turnover');
    const inlineHoists = [...w.hoists.values()].filter((h) => !hoists.includes(h));
    let body = expr;
    for (const h of inlineHoists)
        body = body.split(new RegExp(`(?<![\\w.])${h.name}(?=\\.)`, 'g')).join(h.value);
    const bodyLines = [];
    for (const h of hoists) {
        if (h.comment)
            bodyLines.push({ text: `# ${h.comment}`, src: firstLine });
        bodyLines.push({ text: `${h.name} = ${h.value}`, src: firstLine });
    }
    for (const s of w.shows)
        bodyLines.push({ text: `show(${s.name}, "${s.label}")`, src: firstLine });
    for (const lo of leftOut)
        bodyLines.push({ text: `# unsupported: ${lo.text}`, src: lo.line });
    for (const n of w.notes.filter((x) => x.level === 'approx' && x.code !== 'CV-CHARTINK-FORMING'))
        bodyLines.push({ text: `# approx: ${n.message}`, src: n.line });
    if (universe === null) {
        // the display form: a bare screener (the last line is the condition)
        for (const b of bodyLines)
            lines.push(b);
        lines.push({ text: body, src: firstLine });
    }
    else {
        lines.push({ text: `@screener(universe="${universe}")`, src: 0 });
        lines.push({ text: 'def scan():', src: 0 });
        for (const b of bodyLines)
            lines.push({ text: `    ${b.text}`, src: b.src });
        lines.push({ text: `    return ${body}`, src: firstLine });
    }
    return {
        kind: 'screener',
        text: lines.map((l) => l.text).join('\n') + '\n',
        srcLines: lines.map((l) => l.src),
        notes: w.notes,
        companions: [],
    };
}
