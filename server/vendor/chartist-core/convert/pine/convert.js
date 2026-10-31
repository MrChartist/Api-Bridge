// Pine Script to ChartistScript: the mapping and the writer. Input: the Pine syntax tree (./parse). Output: ChartistScript text,
// one statement per line, with the notes written as a header; the shared finishing step (../finish) formats and checks it.
// Rules (docs/features/script-import/README.md): every construct is exact, approximate (note) or unsupported (note, left out);
// nothing that reads the future is converted; a condition is never dropped from an `and` without a note.
import { fnSpec } from '../../stdlib/manifest.js';
import { defaultIntRange } from '../../check/settings.js';
import { parsePine } from './parse.js';
import { CALENDAR_NAMES, LOCATIONS, NAMED_COLORS, PLOT_STYLES, SHAPES, SOURCE_CHOICES, TAKEN_NAMES, TICKERS, V4_ALIASES, V4_INPUT_TYPES, toneOfHex, toneOfRgb, } from './tables.js';
/** A construct that cannot be converted. Thrown from inside an expression; the statement turns into a note. */
class Unsupported extends Error {
    code;
    level;
    constructor(code, message, level = 'unsupported') {
        super(message);
        this.code = code;
        this.level = level;
    }
}
/** A value that depends on something already left out: the statement is left out too (the first note says why). */
class Dropped extends Error {
    name;
    constructor(name) {
        super(name);
        this.name = name;
    }
}
export function csString(s) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}
function numText(raw) {
    let r = raw;
    if (r.startsWith('.'))
        r = `0${r}`;
    if (r.endsWith('.'))
        r = `${r}0`;
    return r;
}
export function snake(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
}
/** A function name from a title: "RSI with levels" -> rsi_with_levels. */
export function slugOf(title) {
    let s = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!s)
        s = 'script';
    if (/^[0-9]/.test(s))
        s = `script_${s}`;
    if (s.length > 40)
        s = s.slice(0, 40).replace(/_+$/, '');
    if (TAKEN_NAMES.has(s))
        s = `${s}_script`;
    return s;
}
/** Identifiers a line of ChartistScript reads (not attributes, not texts, not keyword-argument names). */
function refsOf(text) {
    const code = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const out = [];
    const re = /(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)(?!\s*=(?!=))/g;
    let m;
    while ((m = re.exec(code)))
        out.push(m[1]);
    return out;
}
const PRICE = new Set(['open', 'high', 'low', 'close', 'volume']);
const BLENDS = {
    hl2: ['high', 'low'],
    hlc3: ['high', 'low', 'close'],
    ohlc4: ['open', 'high', 'low', 'close'],
    hlcc4: ['high', 'low', 'close', 'close'],
};
function lineRange(a, b) {
    const out = [];
    for (let i = a; i <= b; i++)
        out.push(i);
    return out;
}
const WRITTEN_COLOURS = 'written colours (#hex, color.rgb) are mapped to the nearest theme tone (blue, teal, up, down, amber, gray); transparency is not carried over.';
const CHART_TF = new Set(['', 'D', '1D']);
const FRAME_OF = { W: 'W', '1W': 'W', M: 'M', '1M': 'M' };
// ---- the converter ---------------------------------------------------------------------------------------------------------
export class PineToChartist {
    file;
    version;
    st;
    constructor(source) {
        this.file = parsePine(source);
        this.version = this.file.version ?? 4;
    }
    /** The natural kind of this script: strategy, alert (only alertcondition outputs) or indicator. */
    naturalKind() {
        let hasDraw = false;
        let hasAlert = false;
        let strategy = false;
        const walk = (ss) => {
            for (const s of ss) {
                if (s.k === 'expr' && s.e.k === 'call') {
                    const fn = this.alias(s.e.fn ?? '');
                    if (fn === 'strategy')
                        strategy = true;
                    if (fn === 'alertcondition' || fn === 'alert')
                        hasAlert = true;
                    if (['plot', 'plotshape', 'plotchar', 'plotarrow', 'bgcolor', 'barcolor', 'fill', 'hline', 'label.new', 'line.new', 'plotcandle', 'plotbar'].includes(fn)) {
                        if (!(fn === 'plot' && s.e.args.some((a) => a.name === 'display' && a.value.k === 'name' && a.value.id === 'display.none')))
                            hasDraw = true;
                    }
                }
                if (s.k === 'assign' && s.value.k === 'call') {
                    const fn = this.alias(s.value.fn ?? '');
                    if (['plot', 'hline', 'label.new', 'line.new', 'box.new', 'table.new'].includes(fn))
                        hasDraw = true;
                }
                if (s.k === 'if') {
                    walk(s.body);
                    for (const e of s.elifs)
                        walk(e.body);
                    if (s.orelse)
                        walk(s.orelse);
                }
            }
        };
        walk(this.file.body);
        if (strategy)
            return 'strategy';
        if (hasAlert && !hasDraw)
            return 'alert';
        return 'indicator';
    }
    hasAlertConditions() {
        let found = false;
        const walk = (ss) => {
            for (const s of ss) {
                if (s.k === 'expr' && s.e.k === 'call' && (s.e.fn === 'alertcondition' || s.e.fn === 'alert'))
                    found = true;
                if (s.k === 'if') {
                    walk(s.body);
                    for (const e of s.elifs)
                        walk(e.body);
                    if (s.orelse)
                        walk(s.orelse);
                }
            }
        };
        walk(this.file.body);
        return found;
    }
    alias(fn) {
        if (this.version <= 4 && V4_ALIASES[fn])
            return V4_ALIASES[fn];
        return fn;
    }
    // ---- notes ---------------------------------------------------------------------------------------------------------------
    note(level, code, message, line, endLine, original) {
        const n = { line, level, code, message };
        if (endLine !== undefined && endLine !== line)
            n.endLine = endLine;
        if (original)
            n.original = original;
        this.st.notes.push(n);
    }
    srcText(line, endLine = line) {
        return this.file.lines
            .slice(line - 1, endLine)
            .map((l) => l.trim())
            .join(' ');
    }
    // ---- names ---------------------------------------------------------------------------------------------------------------
    fresh(base) {
        let n = base;
        if (TAKEN_NAMES.has(n))
            n = `${n}_`;
        let i = 2;
        const root = n;
        while (this.st.taken.has(n))
            n = `${root}_${i++}`;
        this.st.taken.add(n);
        return n;
    }
    csNameFor(pine) {
        return this.fresh(snake(pine));
    }
    // ---- output lines --------------------------------------------------------------------------------------------------------
    emitAssign(name, value, src) {
        this.st.lines.push({ text: `${name} = ${value}`, src, defines: name });
    }
    emitOutput(text, src) {
        this.st.lines.push({ text, src, output: true });
    }
    // ---- entry point ---------------------------------------------------------------------------------------------------------
    /** `companion`: a second script made beside the main one; its notes are only those about the lines it keeps. */
    companion = false;
    run(target, companion = false) {
        this.companion = companion;
        this.st = {
            target,
            notes: [],
            scope: new Map(),
            taken: new Set(),
            inputs: [],
            lines: [],
            skip: new Set(),
            replaced: new Map(),
            title: '',
            overlay: false,
            declLine: 0,
            declKind: null,
            benchmark: null,
            frames: new Map(),
            hoisted: new Map(),
            entries: [],
            exits: [],
            strategyArgs: [],
            alertConds: [],
            matchConds: [],
            shows: [],
            plotLabels: new Set(),
            hlineRunStart: null,
            fillHandles: new Set(),
            plotCount: 0,
        };
        this.collectFillHandles(this.file.body);
        this.varNames = new Set();
        this.scaled = new Map();
        this.collectRebound(this.file.body);
        if (this.file.version === null)
            this.note('info', 'CV-PINE-NO-VERSION', 'There is no //@version line; the script is read as Pine Script v4.', 1);
        this.block(this.file.body);
        for (const [name, line] of this.drawingVars) {
            this.note('unsupported', 'CV-PINE-DRAWING', `\`${name}\` holds a drawing object (line, label, box); drawing objects are not part of the language. It is left out.`, line, line, this.srcText(line));
        }
        this.riskLost();
        if (this.tableLines.length && !this.st.notes.some((n) => n.code === 'CV-PINE-TABLE')) {
            this.note('unsupported', 'CV-PINE-TABLE', 'tables are not part of the language, so the table is left out.', this.tableLines[0], this.tableLines[this.tableLines.length - 1]);
        }
        return this.assemble();
    }
    /** What a strategy.exit of the source asked for (stop, target, trailing stop) that is not in the result (V-5). */
    lostRisk = [];
    /**
     * V-5 (2026-10-25): a strategy whose stop or target could not be converted would backtest with none, which reads as a
     * complete conversion. Say so in a note on the exit line and in the summary.
     */
    riskLost() {
        this.lostRisk = [];
        if (this.st.target !== 'strategy')
            return;
        const asked = new Map();
        const walk = (ss) => {
            for (const x of ss) {
                if (x.k === 'expr' && x.e.k === 'call' && x.e.fn && this.alias(x.e.fn) === 'strategy.exit') {
                    const m = this.argsOf(x.e.args, ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset']);
                    if (m.get('stop') || m.get('loss'))
                        asked.set('stop loss', asked.get('stop loss') ?? x.line);
                    if (m.get('limit') || m.get('profit'))
                        asked.set('profit target', asked.get('profit target') ?? x.line);
                    if (m.get('trail_points') || m.get('trail_price') || m.get('trail_offset'))
                        asked.set('trailing stop', asked.get('trailing stop') ?? x.line);
                }
                if (x.k === 'if') {
                    walk(x.body);
                    for (const b of x.elifs)
                        walk(b.body);
                    if (x.orelse)
                        walk(x.orelse);
                }
            }
        };
        walk(this.file.body);
        const text = this.st.lines.map((l) => l.text).join('\n');
        const has = { 'stop loss': 'strategy.stop_loss(', 'profit target': 'strategy.take_profit(', 'trailing stop': 'strategy.trail(' };
        for (const [what, line] of asked) {
            if (text.includes(has[what]))
                continue;
            this.lostRisk.push(what);
            this.note('unsupported', 'CV-PINE-EXIT-LOST', `the ${what} of strategy.exit was not converted (see the note on that line), so this strategy backtests with NO ${what}. Add one by hand before you trust the results.`, line);
        }
    }
    collectFillHandles(ss) {
        for (const s of ss) {
            if (s.k === 'expr' && s.e.k === 'call' && s.e.fn === 'fill') {
                for (const a of s.e.args.slice(0, 2))
                    if (a.value.k === 'name')
                        this.st.fillHandles.add(a.value.id);
            }
            if (s.k === 'if')
                this.collectFillHandles(s.body);
        }
    }
    block(ss) {
        for (let i = 0; i < ss.length; i++) {
            const s = ss[i];
            if (this.st.skip.has(s))
                continue;
            const rep = this.st.replaced.get(s);
            if (rep) {
                rep();
                continue;
            }
            const isHline = (s.k === 'expr' && s.e.k === 'call' && s.e.fn === 'hline') || (s.k === 'assign' && s.value.k === 'call' && s.value.fn === 'hline');
            if (!isHline)
                this.st.hlineRunStart = null;
            this.statement(s, ss, i);
        }
    }
    statement(s, siblings, index) {
        switch (s.k) {
            case 'comment':
                this.st.lines.push({ text: `# ${s.text}`, src: s.line, comment: true });
                return;
            case 'opaque':
                this.opaque(s);
                return;
            case 'func':
                this.funcDef(s);
                return;
            case 'expr':
                this.exprStatement(s.e, s.line, s.endLine, null);
                return;
            case 'assign':
                this.assign(s, siblings, index);
                return;
            case 'if':
                this.ifStatement(s);
                return;
            case 'for':
                this.forStatement(s);
                return;
        }
    }
    opaque(s) {
        const why = {
            while: 'while loops are not part of the language; a script here works on every candlestick at once.',
            type: 'user-defined types are not part of the language.',
            method: 'methods are not part of the language.',
            import: 'libraries are not available; paste the library functions into the script.',
            export: 'library exports are not available.',
            enum: 'enum declarations are not converted.',
            for: '`for ... in` loops over arrays are not part of the language.',
            unreadable: `this line could not be read as Pine Script (${s.reason}).`,
        };
        this.note('unsupported', `CV-PINE-${s.what.toUpperCase()}`, `${why[s.what] ?? 'not converted.'} It is left out.`, s.line, s.endLine, this.srcText(s.line, Math.min(s.endLine, s.line + 2)));
    }
    /** Report a statement that could not be converted; names it defines are left out too. */
    failStatement(err, line, endLine, defines) {
        for (const d of defines)
            this.st.scope.set(d, { k: 'dropped', line });
        if (err instanceof Dropped) {
            const msg = defines.length
                ? `${defines.map((d) => `\`${d}\``).join(', ')} uses \`${err.name}\`, which was left out, so it is left out too.`
                : `this line uses \`${err.name}\`, which was left out, so it is left out too.`;
            this.note('unsupported', 'CV-PINE-DEPENDS-ON-DROPPED', msg, line, endLine, this.srcText(line, endLine));
            return;
        }
        if (err instanceof Unsupported) {
            this.note(err.level, err.code, `${err.message}${err.level === 'unsupported' ? ' The line is left out.' : ''}`, line, endLine, this.srcText(line, endLine));
            return;
        }
        throw err;
    }
    // ---- expressions ---------------------------------------------------------------------------------------------------------
    /** Arguments by Pine parameter name: positional ones in `order`, keyword ones by name. */
    argsOf(args, order) {
        const m = new Map();
        let pos = 0;
        for (const a of args) {
            if (a.name)
                m.set(a.name, a.value);
            else {
                if (pos < order.length)
                    m.set(order[pos], a.value);
                pos++;
            }
        }
        return m;
    }
    tx(e, env0) {
        const top = env0.top === true;
        const env = top ? { ...env0, top: false } : env0;
        switch (e.k) {
            case 'num':
                return { s: numText(e.raw), ty: 'num' };
            case 'str':
                return { s: csString(e.v), ty: 'str' };
            case 'bool':
                return { s: e.v ? 'True' : 'False', ty: 'bool' };
            case 'na':
                return { s: 'na', ty: 'any' };
            case 'hex':
                return { s: this.colorOf(e, env), ty: 'color' };
            case 'name':
                return this.txName(e.id, env, e);
            case 'member':
                throw new Unsupported('CV-PINE-FIELD', `\`.${e.name}\` on a value is not converted.`);
            case 'call':
                return this.txCall(e, env, top);
            case 'index': {
                // Pine's history of a name is the value it ENDS with on each candlestick. For a name changed later by `:=` the converter
                // writes the values before and after the change as two names, so neither one's history is Pine's: refused (V-1).
                if (e.x.k === 'name' && this.rebound.has(e.x.id)) {
                    throw new Unsupported('CV-PINE-HISTORY-REASSIGN', `\`${e.x.id}[${this.srcExpr(e.i)}]\` reads the value \`${e.x.id}\` ends with on an earlier candlestick, after it is changed with := or +=. The converter keeps the values before and after the change apart, so this is not converted.`);
                }
                const x = this.tx(e.x, env);
                const i = this.tx(e.i, env);
                if (!/^[0-9]+$/.test(i.s) && !this.isInputName(i.s)) {
                    throw new Unsupported('CV-PINE-SERIES-OFFSET', `\`[${this.srcExpr(e.i)}]\` is an offset that changes from candlestick to candlestick; an offset here must be a fixed number or a setting.`);
                }
                const simple = /^[A-Za-z_][\w.]*$/.test(x.s) || /\)$/.test(x.s);
                return { s: simple ? `${x.s}[${i.s}]` : `(${x.s})[${i.s}]`, ty: x.ty };
            }
            case 'un': {
                const x = this.tx(e.x, env);
                if (e.op === 'not')
                    return { s: `(not ${x.s})`, ty: 'bool' };
                return { s: `(${e.op}${x.s})`, ty: x.ty };
            }
            case 'bin':
                return this.txBinary(e, env);
            case 'tern': {
                const c = this.tx(e.c, env);
                const a = this.tx(e.a, env);
                const b = this.tx(e.b, env);
                return { s: `(${a.s} if ${c.s} else ${b.s})`, ty: a.ty === 'any' ? b.ty : a.ty };
            }
            case 'list':
                throw new Unsupported('CV-PINE-ARRAY', 'a list of values is only converted as the options of a setting.');
            case 'switch':
                return this.txSwitch(e, env);
            case 'ifx': {
                let out = null;
                for (let i = e.branches.length - 1; i >= 0; i--) {
                    const br = e.branches[i];
                    const v = this.tx(br.value, env);
                    if (br.cond === null)
                        out = v;
                    else
                        out = { s: `(${v.s} if ${this.tx(br.cond, env).s} else ${out ? out.s : 'na'})`, ty: v.ty };
                }
                this.note('info', 'CV-PINE-IF-VALUE', 'an `if` that gives a value became a choice: a if condition else b.', e.line, e.endLine);
                return out ?? { s: 'na', ty: 'any' };
            }
        }
    }
    srcExpr(e) {
        switch (e.k) {
            case 'num':
                return e.raw;
            case 'str':
                return JSON.stringify(e.v);
            case 'name':
                return e.id;
            case 'call':
                return `${e.fn ?? '(...)'}(${e.args.map((a) => (a.name ? `${a.name}=` : '') + this.srcExpr(a.value)).join(', ')})`;
            case 'index':
                return `${this.srcExpr(e.x)}[${this.srcExpr(e.i)}]`;
            case 'bin':
                return `${this.srcExpr(e.l)} ${e.op} ${this.srcExpr(e.r)}`;
            case 'un':
                return `${e.op === 'not' ? 'not ' : e.op}${this.srcExpr(e.x)}`;
            case 'tern':
                return `${this.srcExpr(e.c)} ? ${this.srcExpr(e.a)} : ${this.srcExpr(e.b)}`;
            case 'bool':
                return e.v ? 'true' : 'false';
            case 'na':
                return 'na';
            case 'hex':
                return e.v;
            case 'member':
                return `${this.srcExpr(e.x)}.${e.name}`;
            case 'list':
                return `[${e.items.map((x) => this.srcExpr(x)).join(', ')}]`;
            default:
                return '...';
        }
    }
    isInputName(s) {
        return this.st.inputs.some((i) => i.cs === s);
    }
    txSwitch(e, env) {
        let out = null;
        const subject = e.subject ? this.tx(e.subject, env) : null;
        for (let i = e.arms.length - 1; i >= 0; i--) {
            const arm = e.arms[i];
            const v = this.tx(arm.value, env);
            if (arm.when === null) {
                out = v;
                continue;
            }
            const w = this.tx(arm.when, env);
            const cond = subject ? `(${subject.s} == ${w.s})` : w.s;
            out = { s: `(${v.s} if ${cond} else ${out ? out.s : 'na'})`, ty: v.ty === 'any' ? (out?.ty ?? 'any') : v.ty };
        }
        this.note('info', 'CV-PINE-SWITCH', 'switch became a choice with if ... else.', e.line, e.endLine);
        return out ?? { s: 'na', ty: 'any' };
    }
    txBinary(e, env) {
        // x == na / x != na: Pine v4 allowed it; the author meant "is missing".
        if ((e.op === '==' || e.op === '!=') && (e.r.k === 'na' || e.l.k === 'na')) {
            const x = this.tx(e.r.k === 'na' ? e.l : e.r, env);
            return { s: e.op === '==' ? `is_na(${x.s})` : `(not is_na(${x.s}))`, ty: 'bool' };
        }
        // sum fold divided by its own length: total / n -> ta.sma(x, n)
        if (e.op === '/' && e.l.k === 'name') {
            const b = this.st.scope.get(e.l.id);
            if (b && b.k === 'sum') {
                const r = this.tx(e.r, env);
                if (r.s === b.n) {
                    if (b.note)
                        this.st.notes.push({ ...b.note, line: e.line, endLine: e.line });
                    return { s: `ta.sma(${b.x}, ${b.n})`, ty: 'num' };
                }
            }
        }
        // rng == ta.lowest(rng, n): the same answer as <=, without comparing decimals exactly.
        if (e.op === '==' && e.r.k === 'call' && (e.r.fn === 'ta.lowest' || e.r.fn === 'ta.highest')) {
            const l = this.tx(e.l, env);
            const r = this.tx(e.r, env);
            const inner = e.r.args[0] ? this.tx(e.r.args[0].value, env).s : '';
            if (e.r.args.length === 2 && inner === l.s) {
                const op = e.r.fn === 'ta.lowest' ? '<=' : '>=';
                this.note('info', 'CV-PINE-FLOAT-EQ-WINDOW', `${this.srcExpr(e)} is written with ${op}: the same answer (a value can never be past the ${e.r.fn === 'ta.lowest' ? 'lowest' : 'highest'} of a window that holds it), without an exact comparison of decimals (W-FLOAT-EQ).`, e.line);
                return { s: `(${l.s} ${op} ${r.s})`, ty: 'bool' };
            }
        }
        if (e.op === 'and' || e.op === 'or') {
            // one flat chain, so the formatter prints a and b and c (nested parentheses would be kept)
            const parts = [];
            const flat = (x) => {
                if (x.k === 'bin' && x.op === e.op) {
                    flat(x.l);
                    flat(x.r);
                }
                else
                    parts.push(x);
            };
            flat(e);
            return { s: `(${parts.map((p) => this.tx(p, env).s).join(` ${e.op} `)})`, ty: 'bool' };
        }
        const l = this.tx(e.l, env);
        const r = this.tx(e.r, env);
        if (['==', '!=', '<', '>', '<=', '>='].includes(e.op))
            return { s: `(${l.s} ${e.op} ${r.s})`, ty: 'bool' };
        if (e.op === '/' && this.version <= 4 && l.ty === 'num' && r.ty === 'num' && /^[0-9]+$/.test(l.s) && /^[0-9]+$/.test(r.s)) {
            return { s: `(${l.s} // ${r.s})`, ty: 'num' };
        }
        if (e.op === '+' && (l.ty === 'str' || r.ty === 'str')) {
            throw new Unsupported('CV-PINE-TEXT-JOIN', 'joining texts with + is not available; texts here are written out (only alert messages take {placeholders}).');
        }
        return { s: `(${l.s} ${e.op} ${r.s})`, ty: 'num' };
    }
    txName(id0, env, e) {
        const id = this.alias(id0);
        const b = this.st.scope.get(id0);
        if (b) {
            switch (b.k) {
                case 'value':
                    return { s: b.cs, ty: b.ty };
                case 'inline':
                    return { s: b.s, ty: b.ty };
                case 'dropped':
                    throw new Dropped(id0);
                case 'color':
                    return { s: b.s, ty: 'color' };
                case 'plot':
                    throw new Unsupported('CV-PINE-PLOT-HANDLE', `\`${id0}\` is a plot; only fill() can use it here.`);
                case 'symbol':
                    throw new Unsupported('CV-PINE-SYMBOL-VALUE', `\`${id0}\` is a symbol; it is only converted as the first argument of request.security.`);
                case 'tfcode':
                    throw new Unsupported('CV-PINE-TF-VALUE', `\`${id0}\` is a candlestick size; it is only converted as the second argument of request.security.`);
                case 'sum':
                    return { s: `(ta.sma(${b.x}, ${b.n}) * ${b.n})`, ty: 'num' };
                case 'pendingVar':
                    throw new Unsupported('CV-PINE-VAR-READ', `\`${id0}\` is read before its new value is set; a value that carries over from one candlestick to the next is converted only in the forms listed in the import guide.`);
            }
        }
        if (PRICE.has(id))
            return { s: env.frame ? `${env.frame}.${id}` : id, ty: 'num' };
        if (BLENDS[id]) {
            if (!env.frame && id !== 'hlcc4')
                return { s: id, ty: 'num' };
            const parts = BLENDS[id].map((p) => (env.frame ? `${env.frame}.${p}` : p));
            return { s: `((${parts.join(' + ')}) / ${parts.length})`, ty: 'num' };
        }
        if (id === 'na')
            return { s: 'na', ty: 'any' };
        if (id === 'bar_index') {
            this.note('approx', 'CV-PINE-BAR-INDEX', 'bar_index is written ta.cum_sum(1) - 1: it counts from the first candlestick loaded here, which is not where Pine starts counting.', e.line);
            return { s: '(ta.cum_sum(1) - 1)', ty: 'num' };
        }
        if (id === 'barstate.isconfirmed') {
            this.note('info', 'CV-PINE-ISCONFIRMED', 'barstate.isconfirmed is always true here: scripts are worked out on closed candlesticks.', e.line);
            return { s: 'True', ty: 'bool' };
        }
        if (id.startsWith('barstate.'))
            throw new Unsupported('CV-PINE-BARSTATE', `${id}: scripts here are worked out on closed candlesticks and have no "last candlestick" switch.`);
        if (CALENDAR_NAMES.has(id) || id.startsWith('dayofweek.') || id.startsWith('session.')) {
            throw new Unsupported('CV-PINE-CALENDAR', `${id} and other calendar values are not available.`);
        }
        if (id.startsWith('syminfo.') || id.startsWith('timeframe.'))
            throw new Unsupported('CV-PINE-SYMINFO', `${id} is not available in a script here.`);
        if (id === 'ta.tr')
            return { s: this.trueRange(env), ty: 'num' };
        if (id === 'ta.obv' || id === 'ta.accdist' || id === 'ta.pvt') {
            const ind = id === 'ta.obv' ? 'ind.obv()' : id === 'ta.accdist' ? 'ind.adline()' : 'ind.pvt()';
            if (env.frame)
                throw new Unsupported('CV-PINE-FRAME-STUDY', `${id} on another candlestick size is not converted.`);
            return { s: this.hoist(id.slice(3), ind, e.line), ty: 'num' };
        }
        if (id === 'ta.vwap')
            return this.vwap(null, env, e.line);
        if (id === 'math.pi')
            return { s: '3.141592653589793', ty: 'num' };
        if (id === 'math.e')
            return { s: '2.718281828459045', ty: 'num' };
        if (id === 'math.phi')
            return { s: '1.618033988749895', ty: 'num' };
        if (id === 'math.rphi')
            return { s: '0.618033988749895', ty: 'num' };
        if (id.startsWith('color.'))
            return { s: this.colorOf(e, env), ty: 'color' };
        if (id.startsWith('strategy.'))
            throw new Unsupported('CV-PINE-STRATEGY-VALUE', `${id} is not available; a strategy here does not read its own position.`);
        throw new Unsupported('CV-PINE-UNKNOWN-NAME', `\`${id0}\` is not known to the converter.`);
    }
    /** A library value used in several places gets one name (obv = ind.obv()). */
    hoist(base, value, line) {
        const have = this.st.hoisted.get(value);
        if (have)
            return have;
        const name = this.fresh(base);
        this.emitAssign(name, value, line);
        this.st.hoisted.set(value, name);
        if (value === 'ind.obv()') {
            this.note('info', 'CV-PINE-OBV', 'ta.obv (a value in Pine) is ind.obv() here; both start counting at the first candlestick loaded, so the level depends on where the data starts.', line);
        }
        return name;
    }
    trueRange(env) {
        const f = (p) => (env.frame ? `${env.frame}.${p}` : p);
        return `max([${f('high')} - ${f('low')}, abs(${f('high')} - ${f('close')}[1]), abs(${f('low')} - ${f('close')}[1])])`;
    }
    vwap(src, env, line) {
        const s = src ? this.tx(src, env) : { s: env.frame ? `((${env.frame}.high + ${env.frame}.low + ${env.frame}.close) / 3)` : 'hlc3', ty: 'num' };
        this.note('approx', 'CV-PINE-VWAP-DAILY', `Pine's ta.vwap starts again every session. Scripts here run on daily candlesticks, where one session is one candlestick, so Pine's value on a daily chart is the candlestick's own ${src ? this.srcExpr(src) : 'hlc3'}, and that is what is written. On an intraday Pine chart the line is the session's running VWAP, which a daily script cannot draw. For a VWAP that runs across many days use ind.vwap().`, line);
        return s;
    }
    /** A call to a library function, recording which settings are passed straight to which parameter (for the setting ranges). */
    callCs(fn, args) {
        const spec = fnSpec(fn);
        if (spec) {
            args.forEach((a, i) => {
                const param = a.name ?? spec.params[i]?.name;
                const inp = this.st.inputs.find((x) => x.cs === a.s);
                if (inp && param)
                    inp.uses.push({ fn, param });
            });
        }
        return `${fn}(${args.map((a) => (a.name ? `${a.name}=${a.s}` : a.s)).join(', ')})`;
    }
    txCall(e, env, top = false) {
        if (!e.fn)
            throw new Unsupported('CV-PINE-CALL', 'this call is not converted.');
        const fn = this.alias(e.fn);
        const line = e.line;
        const a = (order) => this.argsOf(e.args, order);
        const v = (x, dflt) => {
            if (!x) {
                if (dflt === undefined)
                    throw new Unsupported('CV-PINE-ARGS', `${fn} is missing an argument.`);
                return { s: dflt, ty: 'num' };
            }
            return this.tx(x, env);
        };
        const userFn = this.st.scope.get(`fn:${e.fn}`);
        if (userFn && userFn.k === 'inline')
            return this.inlineCall(e, env);
        if (userFn && userFn.k === 'dropped')
            throw new Dropped(`${e.fn}()`);
        const simple1 = {
            'ta.sma': 'ta.sma', 'ta.ema': 'ta.ema', 'ta.rma': 'ta.rma', 'ta.wma': 'ta.wma', 'ta.rsi': 'ta.rsi', 'ta.cci': 'ta.cci',
            'ta.mom': 'ta.mom', 'ta.roc': 'ta.roc', 'ta.variance': 'ta.variance', 'ta.dev': 'ta.dev', 'ta.median': 'ta.median',
        };
        if (fn === 'ta.rising' || fn === 'ta.falling') {
            // V-8 (2026-10-25): Pine's ta.rising(x, n) is "x is greater than each of the previous n values", not "x went up on each
            // of the last n candlesticks" (this language's ta.rising): 1, 5, 3, 6 with n = 3 is rising in Pine. Written with the
            // highest (lowest) of the previous n values. Source: the Pine reference ("greater than any previous source for
            // length bars back") as quoted by a third-party copy of it; the official page could not be loaded here, so Needs verification.
            const m = a(['source', 'length']);
            const x = v(m.get('source'));
            const n = v(m.get('length'));
            const sx = /^[A-Za-z_][\w.]*$/.test(x.s) ? x.s : `(${x.s})`;
            const up = fn === 'ta.rising';
            this.note('approx', 'CV-PINE-RISING', `${fn}(x, n) in Pine is x ${up ? 'above the highest' : 'below the lowest'} of the previous n values, written ${up ? 'x > ta.highest(x, n)[1]' : 'x < ta.lowest(x, n)[1]'} (ta.${up ? 'rising' : 'falling'} here means a ${up ? 'rise' : 'fall'} on each of the last n candlesticks, a stricter test). Where one of those values is missing this gives unknown; Pine skips it. Pine's exact rule Needs verification.`, env.line);
            return { s: `${sx} ${up ? '>' : '<'} ${this.callCs(up ? 'ta.highest' : 'ta.lowest', [x, n])}[1]`, ty: 'bool' };
        }
        if (simple1[fn]) {
            const m = a(['source', 'length']);
            return { s: this.callCs(simple1[fn], [v(m.get('source')), v(m.get('length'))]), ty: 'num' };
        }
        switch (fn) {
            case 'ta.highest':
            case 'ta.lowest': {
                if (e.args.length === 1 && !e.args[0].name) {
                    const src = fn === 'ta.highest' ? 'high' : 'low';
                    this.note('info', 'CV-PINE-ONE-ARG-SOURCE', `${fn}(length) with one argument reads the ${src} (ta.lowest the low); written out.`, line);
                    return { s: this.callCs(fn, [{ s: env.frame ? `${env.frame}.${src}` : src }, v(e.args[0].value)]), ty: 'num' };
                }
                const m = a(['source', 'length']);
                return { s: this.callCs(fn, [v(m.get('source')), v(m.get('length'))]), ty: 'num' };
            }
            case 'ta.stdev':
            case 'ta.variance': {
                const m = a(['source', 'length', 'biased']);
                const base = this.callCs(fn, [v(m.get('source')), v(m.get('length'))]);
                const biased = m.get('biased');
                if (biased && biased.k === 'bool' && !biased.v) {
                    const n = v(m.get('length')).s;
                    return { s: fn === 'ta.stdev' ? `(${base} * math.sqrt(${n} / (${n} - 1)))` : `(${base} * ${n} / (${n} - 1))`, ty: 'num' };
                }
                return { s: base, ty: 'num' };
            }
            case 'ta.atr': {
                const m = a(['length']);
                if (env.frame)
                    return { s: this.callCs('ta.rma', [{ s: this.trueRange(env) }, v(m.get('length'))]), ty: 'num' };
                return { s: this.callCs('ta.atr', [v(m.get('length'))]), ty: 'num' };
            }
            case 'ta.tr':
                return { s: this.trueRange(env), ty: 'num' };
            case 'ta.change': {
                const m = a(['source', 'length']);
                const src = v(m.get('source'));
                const len = m.get('length');
                if (src.ty === 'bool')
                    return { s: `(${src.s} != ${src.s}[${len ? v(len).s : '1'}])`, ty: 'bool' };
                return { s: len ? this.callCs('ta.change', [src, v(len)]) : this.callCs('ta.change', [src]), ty: 'num' };
            }
            case 'ta.crossover':
            case 'ta.crossunder':
            case 'ta.cross': {
                const m = a(['source1', 'source2']);
                return { s: this.callCs(fn, [v(m.get('source1')), v(m.get('source2'))]), ty: 'bool' };
            }
            case 'ta.barssince':
                return { s: this.callCs('ta.bars_since', [v(a(['condition']).get('condition'))]), ty: 'num' };
            case 'ta.valuewhen': {
                const m = a(['condition', 'source', 'occurrence']);
                const occ = m.get('occurrence');
                const args = [v(m.get('condition')), v(m.get('source'))];
                if (occ) {
                    const o = v(occ);
                    if (!/^[0-9]+$/.test(o.s) && !this.isInputName(o.s))
                        throw new Unsupported('CV-PINE-VALUEWHEN-OCC', 'ta.valuewhen with an occurrence that changes per candlestick is not converted.');
                    args.push(o);
                }
                return { s: this.callCs('ta.value_when', args), ty: args[1].ty };
            }
            case 'ta.cum':
                return { s: this.callCs('ta.cum_sum', [v(a(['source']).get('source'))]), ty: 'num' };
            case 'ta.correlation': {
                const m = a(['source1', 'source2', 'length']);
                return { s: this.callCs('ta.correlation', [v(m.get('source1')), v(m.get('source2')), v(m.get('length'))]), ty: 'num' };
            }
            case 'ta.linreg': {
                const m = a(['source', 'length', 'offset']);
                return { s: this.callCs('ta.linreg', [v(m.get('source')), v(m.get('length')), v(m.get('offset'), '0')]), ty: 'num' };
            }
            case 'ta.percentile_linear_interpolation': {
                const m = a(['source', 'length', 'percentage']);
                return { s: this.callCs('ta.percentile', [v(m.get('source')), v(m.get('length')), v(m.get('percentage'))]), ty: 'num' };
            }
            case 'ta.vwma': {
                const m = a(['source', 'length']);
                const s = v(m.get('source')).s;
                const n = v(m.get('length'));
                return { s: `(${this.callCs('ta.sma', [{ s: `(${s} * ${env.frame ? `${env.frame}.volume` : 'volume'})` }, n])} / ${this.callCs('ta.sma', [{ s: env.frame ? `${env.frame}.volume` : 'volume' }, n])})`, ty: 'num' };
            }
            case 'ta.swma': {
                const s = v(a(['source']).get('source')).s;
                return { s: `((${s}[3] + 2 * ${s}[2] + 2 * ${s}[1] + ${s}) / 6)`, ty: 'num' };
            }
            case 'ta.range': {
                const m = a(['source', 'length']);
                const s = v(m.get('source'));
                const n = v(m.get('length'));
                return { s: `(${this.callCs('ta.highest', [s, n])} - ${this.callCs('ta.lowest', [s, n])})`, ty: 'num' };
            }
            case 'ta.max':
                return { s: this.callCs('ta.highest_all', [v(a(['source']).get('source'))]), ty: 'num' };
            case 'ta.min':
                return { s: this.callCs('ta.lowest_all', [v(a(['source']).get('source'))]), ty: 'num' };
            case 'ta.pivothigh':
            case 'ta.pivotlow': {
                let src;
                let m;
                const positional = e.args.filter((x) => !x.name).length;
                if (positional === 2 && !e.args.some((x) => x.name === 'source')) {
                    const s = fn === 'ta.pivothigh' ? 'high' : 'low';
                    src = { s: env.frame ? `${env.frame}.${s}` : s, ty: 'num' };
                    m = a(['leftbars', 'rightbars']);
                    this.note('info', 'CV-PINE-PIVOT-SOURCE', 'ta.pivothigh(left, right) with two arguments reads the high (the low for pivotlow); written out here.', line);
                }
                else {
                    m = a(['source', 'leftbars', 'rightbars']);
                    src = v(m.get('source'));
                }
                return { s: this.callCs(fn, [src, v(m.get('leftbars')), v(m.get('rightbars'))]), ty: 'num' };
            }
            case 'ta.stoch': {
                const m = a(['source', 'high', 'low', 'length']);
                const s = v(m.get('source')).s;
                const h = v(m.get('high')).s;
                const l = v(m.get('low')).s;
                const n = v(m.get('length'));
                const lo = this.callCs('ta.lowest', [{ s: l }, n]);
                const hi = this.callCs('ta.highest', [{ s: h }, n]);
                this.note('info', 'CV-PINE-STOCH', 'ta.stoch is written out: 100 * (source - lowest low) / (highest high - lowest low), the raw %K (ind.stoch is smoothed, so it is not used). It is unknown where the range is 0.', line);
                const k = `(100 * (${s} - ${lo}) / (${hi} - ${lo}))`;
                if (top || !env.target)
                    return { s: k, ty: 'num' };
                const raw = this.fresh(`raw_${env.target}`);
                this.emitAssign(raw, k, line);
                return { s: raw, ty: 'num' };
            }
            case 'ta.hma': {
                const m = a(['source', 'length']);
                const s = v(m.get('source'));
                const n = v(m.get('length'));
                this.note('info', 'CV-PINE-HMA', `${this.srcExpr(e)} is ind.hma, the study form of the Hull average.`, line);
                if (env.frame)
                    throw new Unsupported('CV-PINE-FRAME-STUDY', 'ta.hma on another candlestick size is not converted.');
                return { s: s.s === 'close' ? this.callCs('ind.hma', [n]) : this.callCs('ind.hma', [n, { name: 'src', s: s.s }]), ty: 'num' };
            }
            case 'ta.alma': {
                const m = a(['series', 'length', 'offset', 'sigma', 'floor']);
                if (env.frame)
                    throw new Unsupported('CV-PINE-FRAME-STUDY', 'ta.alma on another candlestick size is not converted.');
                const s = v(m.get('series'));
                const args = [{ name: 'window', s: v(m.get('length')).s }, { name: 'offset', s: v(m.get('offset')).s }, { name: 'sigma', s: v(m.get('sigma')).s }];
                if (s.s !== 'close')
                    args.push({ name: 'src', s: s.s });
                return { s: this.callCs('ind.alma', args), ty: 'num' };
            }
            case 'ta.mfi': {
                const m = a(['series', 'length']);
                const s = m.get('series');
                if (!s || !(s.k === 'name' && s.id === 'hlc3'))
                    throw new Unsupported('CV-PINE-MFI-SOURCE', 'ta.mfi of another source than hlc3 is not converted (ind.mfi reads the typical price itself).');
                if (env.frame)
                    throw new Unsupported('CV-PINE-FRAME-STUDY', 'ta.mfi on another candlestick size is not converted.');
                this.note('info', 'CV-PINE-MFI', 'ta.mfi(hlc3, len) is ind.mfi(len), which reads the typical price itself (Needs verification: same handling of equal typical prices as Pine).', line);
                return { s: this.callCs('ind.mfi', [v(m.get('length'))]), ty: 'num' };
            }
            case 'ta.cmo': {
                const m = a(['series', 'length']);
                const s = v(m.get('series'));
                if (env.frame)
                    throw new Unsupported('CV-PINE-FRAME-STUDY', 'ta.cmo on another candlestick size is not converted.');
                return { s: s.s === 'close' ? this.callCs('ind.cmo', [v(m.get('length'))]) : this.callCs('ind.cmo', [v(m.get('length')), { name: 'src', s: s.s }]), ty: 'num' };
            }
            case 'ta.wpr': {
                if (env.frame)
                    throw new Unsupported('CV-PINE-FRAME-STUDY', 'ta.wpr on another candlestick size is not converted.');
                return { s: this.callCs('ind.williamsr', [v(a(['length']).get('length'))]), ty: 'num' };
            }
            case 'ta.vwap':
                return this.vwap(a(['source']).get('source') ?? null, env, line);
            case 'ta.sar': {
                const m = a(['start', 'inc', 'max']);
                const start = v(m.get('start'));
                const inc = v(m.get('inc'));
                if (start.s !== inc.s)
                    this.note('approx', 'CV-PINE-SAR-START', 'ta.sar with a start different from its increment: ind.sar starts at its step, so the first values can differ.', line);
                return { s: `${this.callCs('ind.sar', [{ name: 'step', s: inc.s }, { name: 'max', s: v(m.get('max')).s }])}.value`, ty: 'num' };
            }
            case 'ta.macd':
            case 'ta.bb':
            case 'ta.kc':
            case 'ta.supertrend':
            case 'ta.dmi':
                throw new Unsupported('CV-PINE-TUPLE-PLACE', `${fn} gives several values; it is converted when its result is split into names: [a, b, c] = ${fn}(...).`);
            case 'math.abs':
                return { s: `abs(${v(e.args[0]?.value).s})`, ty: 'num' };
            case 'math.max':
            case 'math.min': {
                const xs = e.args.map((x) => this.tx(x.value, env).s);
                const f = fn === 'math.max' ? 'max' : 'min';
                return { s: xs.length === 2 ? `${f}(${xs.join(', ')})` : `${f}([${xs.join(', ')}])`, ty: 'num' };
            }
            case 'math.avg': {
                const xs = e.args.map((x) => this.tx(x.value, env).s);
                this.note('info', 'CV-PINE-MATH-AVG', 'math.avg(a, b) is avg([a, b]).', line);
                return { s: `avg([${xs.join(', ')}])`, ty: 'num' };
            }
            case 'math.sqrt':
            case 'math.log':
            case 'math.exp':
            case 'math.floor':
            case 'math.ceil':
            case 'math.sign':
                return { s: `${fn}(${v(e.args[0]?.value).s})`, ty: 'num' };
            case 'math.round': {
                const x = v(e.args[0]?.value).s;
                return { s: e.args[1] ? `math.round(${x}, ${v(e.args[1].value).s})` : `math.round(${x})`, ty: 'num' };
            }
            case 'math.log10':
                return { s: `(math.log(${v(e.args[0]?.value).s}) / math.log(10))`, ty: 'num' };
            case 'math.pow':
                return { s: `(${v(e.args[0]?.value).s} ** ${v(e.args[1]?.value).s})`, ty: 'num' };
            case 'math.todegrees':
                return { s: `(${v(e.args[0]?.value).s} * 180 / 3.141592653589793)`, ty: 'num' };
            case 'math.toradians':
                return { s: `(${v(e.args[0]?.value).s} * 3.141592653589793 / 180)`, ty: 'num' };
            case 'math.sum': {
                const m = a(['source', 'length']);
                const s = v(m.get('source')).s;
                const n = v(m.get('length')).s;
                if (/^[0-9]+$/.test(n) && Number(n) <= 64)
                    return { s: `sum([${s}[i] for i in range(${n})])`, ty: 'num' };
                this.note('approx', 'CV-PINE-MATH-SUM', `math.sum(x, n) is written ta.sma(x, n) * n; the last decimal places can differ.`, line);
                return { s: `(${this.callCs('ta.sma', [{ s }, { s: n }])} * ${n})`, ty: 'num' };
            }
            case 'nz': {
                const m = a(['source', 'replacement']);
                const x = v(m.get('source'));
                if (x.ty === 'bool')
                    throw new Unsupported('CV-PINE-NZ-BOOL', 'nz() of a true/false value is not available (nz works on numbers here).');
                const r = m.get('replacement');
                return { s: r ? `nz(${x.s}, ${v(r).s})` : `nz(${x.s})`, ty: 'num' };
            }
            case 'na':
                return { s: `is_na(${v(e.args[0]?.value).s})`, ty: 'bool' };
            case 'fixnan': {
                const x = v(e.args[0]?.value).s;
                return { s: `ta.value_when((not is_na(${x})), ${x})`, ty: 'num' };
            }
            case 'iff': {
                const c = v(e.args[0]?.value);
                const x = v(e.args[1]?.value);
                const y = v(e.args[2]?.value);
                return { s: `(${x.s} if ${c.s} else ${y.s})`, ty: x.ty };
            }
            case 'color.new':
            case 'color.rgb':
            case 'color.from_gradient':
                return { s: this.colorOf(e, env), ty: 'color' };
            case 'request.security':
                return this.security(e, env);
            case 'str.tostring':
            case 'str.format':
                throw new Unsupported('CV-PINE-STR', `${fn}: texts that change per candlestick are not available (only alert messages take {placeholders}).`);
            default:
                break;
        }
        if (fn.startsWith('str.'))
            throw new Unsupported('CV-PINE-STR', `${fn}: text functions are not available.`);
        if (/^(array|matrix|map)\./.test(fn))
            throw new Unsupported('CV-PINE-ARRAY', `${fn}: arrays, maps, matrices and user types are not part of the language. For "the last n values" use ta.highest, ta.lowest, ta.sma or x[i].`);
        if (/^(line|label|box|table|polyline|linefill|chart)\./.test(fn))
            throw new Unsupported('CV-PINE-DRAWING', `${fn}: drawing objects are not part of the language.`);
        if (fn === 'time' || fn === 'time_close' || CALENDAR_NAMES.has(fn))
            throw new Unsupported('CV-PINE-CALENDAR', `${fn}() and other calendar values are not available.`);
        if (fn.startsWith('request.'))
            throw new Unsupported('CV-PINE-REQUEST', `${fn} is not available.`);
        if (fn.startsWith('input'))
            throw new Unsupported('CV-PINE-INPUT-PLACE', 'a setting is converted only when it is given a name at the top of the script (n = input.int(...)).');
        if (fn === 'math.random')
            throw new Unsupported('CV-PINE-RANDOM', 'math.random: there is no randomness here, by design.');
        if (/^math\.(sin|cos|tan|asin|acos|atan)$/.test(fn))
            throw new Unsupported('CV-PINE-TRIG', `${fn}: angle functions are not available.`);
        if (fn.startsWith('ta.'))
            throw new Unsupported('CV-PINE-TA-UNKNOWN', `${fn} has no equal here.`);
        throw new Unsupported('CV-PINE-UNKNOWN-CALL', `${fn}() is not known to the converter.`);
    }
    // ---- colours -------------------------------------------------------------------------------------------------------------
    colorOf(e, env) {
        if (e.k === 'na')
            return 'na';
        if (e.k === 'name') {
            const b = this.st.scope.get(e.id);
            if (b && b.k === 'color')
                return b.s;
            if (b && b.k === 'value')
                return b.cs;
            const c = NAMED_COLORS[e.id];
            if (!c)
                throw new Unsupported('CV-PINE-COLOR', `${e.id} is not a colour the converter knows.`, 'unsupported');
            if (c.note)
                this.note('info', 'CV-PINE-COLOR-TONE', `${c.note}.`, e.line);
            return c.tone;
        }
        if (e.k === 'hex') {
            const t = toneOfHex(e.v);
            this.note('info', 'CV-PINE-COLOR-WRITTEN', WRITTEN_COLOURS, e.line);
            return t;
        }
        if (e.k === 'call' && e.fn === 'color.new') {
            const inner = e.args[0]?.value;
            if (!inner)
                throw new Unsupported('CV-PINE-COLOR', 'color.new needs a colour.');
            const t = this.colorOf(inner, env);
            this.note('info', 'CV-PINE-COLOR-TRANSP', 'colour transparency is not carried over; backgrounds and fills are always faint here.', e.line);
            return t;
        }
        if (e.k === 'call' && e.fn === 'color.rgb') {
            const n = e.args.map((x) => (x.value.k === 'num' ? x.value.v : NaN));
            if (n.length < 3 || n.slice(0, 3).some((x) => Number.isNaN(x)))
                throw new Unsupported('CV-PINE-COLOR', 'color.rgb with values that are not written numbers is not converted.');
            const t = toneOfRgb(n[0], n[1], n[2]);
            this.note('info', 'CV-PINE-COLOR-WRITTEN', WRITTEN_COLOURS, e.line);
            return t;
        }
        if (e.k === 'tern') {
            const c = this.tx(e.c, env).s;
            return `(${this.colorOf(e.a, env)} if ${c} else ${this.colorOf(e.b, env)})`;
        }
        throw new Unsupported('CV-PINE-COLOR', 'this colour is not converted.');
    }
    // ---- request.security ----------------------------------------------------------------------------------------------------
    security(e, env) {
        if (env.frame)
            throw new Unsupported('CV-PINE-SECURITY-NESTED', 'request.security inside request.security is not converted.');
        const m = this.argsOf(e.args, ['symbol', 'timeframe', 'expression', 'gaps', 'lookahead']);
        const sym = m.get('symbol');
        const tfx = m.get('timeframe');
        let expr = m.get('expression');
        if (!sym || !tfx || !expr)
            throw new Unsupported('CV-PINE-SECURITY', 'request.security needs a symbol, a candlestick size and a value.');
        const asWritten = expr;
        if (expr.k === 'list')
            throw new Unsupported('CV-PINE-SECURITY-TUPLE', 'request.security with several values is not converted; write one request.security per value.');
        // candlestick size
        let code;
        if (tfx.k === 'str')
            code = tfx.v;
        else if (tfx.k === 'name' && tfx.id === 'timeframe.period')
            code = '';
        else if (tfx.k === 'name' && this.st.scope.get(tfx.id)?.k === 'tfcode')
            code = this.st.scope.get(tfx.id).code;
        else
            throw new Unsupported('CV-PINE-SECURITY-TF', 'request.security with a candlestick size that is not written out is not converted.');
        // look-ahead: never read the future
        const la = m.get('lookahead');
        const lookaheadOn = la !== undefined && la.k === 'name' && (la.id === 'barmerge.lookahead_on' || la.id === 'true');
        /** x[k] with look-ahead on: the k-th candlestick of the other size before the one the day belongs to (V-2). */
        let shiftedBack = 0;
        if (lookaheadOn) {
            if (expr.k === 'index' && expr.i.k === 'num' && expr.i.v >= 1) {
                shiftedBack = expr.i.v;
                expr = expr.i.v === 1 ? expr.x : { ...expr, i: { k: 'num', v: expr.i.v - 1, raw: String(expr.i.v - 1), line: expr.i.line } };
            }
            else {
                throw new Unsupported('CV-PINE-LOOKAHEAD', "request.security with lookahead=barmerge.lookahead_on reads the other candlestick's close before it has happened (on past candlesticks it sees the future). This is never converted.");
            }
        }
        const gaps = m.get('gaps');
        if (gaps && gaps.k === 'name' && gaps.id === 'barmerge.gaps_on') {
            this.note('approx', 'CV-PINE-SECURITY-GAPS', 'gaps=barmerge.gaps_on is not carried over: the value of the other size is shown on every candlestick.', e.line);
        }
        // symbol
        let own = false;
        let ticker = null;
        let pineSym = '';
        if (sym.k === 'name' && (sym.id === 'syminfo.tickerid' || sym.id === 'syminfo.ticker'))
            own = true;
        else if (sym.k === 'call' && (sym.fn === 'ticker.new' || sym.fn === 'tickerid'))
            throw new Unsupported('CV-PINE-TICKER-NEW', `${sym.fn} is not converted.`);
        else if (sym.k === 'str') {
            pineSym = sym.v;
            ticker = this.tickerOf(sym.v, e.line);
        }
        else if (sym.k === 'name') {
            const b = this.st.scope.get(sym.id);
            if (b && b.k === 'symbol') {
                pineSym = b.pine;
                ticker = b.ticker;
                this.note('info', 'CV-PINE-INPUT-SYMBOL', `input.symbol is not a setting here; the index is written in the script line as benchmark="${b.ticker}" (the Pine symbol ${b.pine}). Change it there.`, b.line);
            }
            else
                throw new Unsupported('CV-PINE-SECURITY-SYMBOL', 'request.security with a symbol that is not written out is not converted.');
        }
        else
            throw new Unsupported('CV-PINE-SECURITY-SYMBOL', 'request.security with this symbol is not converted.');
        const chartTf = CHART_TF.has(code);
        if (own) {
            if (chartTf) {
                // on the chart's own size look-ahead changes nothing for x[k]: it is x[k] as written
                this.note('info', 'CV-PINE-SECURITY-SAME', 'request.security on this symbol and the daily size is the value itself.', e.line);
                return this.tx(asWritten, env);
            }
            const frame = FRAME_OF[code];
            if (!frame)
                throw new Unsupported('CV-PINE-SECURITY-INTRADAY', `request.security on the "${code}" size is not converted: scripts here run on daily, weekly and monthly candlesticks.`);
            const name = this.frameName(frame, `tf("${frame}")`, e.line);
            if (shiftedBack > 0) {
                // V-2. Pine: on every day of week k, the close of week k-1 (k-n for x[n]). tf() shows week k from the close of its own last
                // session, so on that day tf("W").close is the day's own close. The same value one DAY earlier is right on every day: the
                // day before a week's last session still shows the week before. `+ nz(0 * close)` puts the weekly value on the daily
                // candlesticks, so the [1] steps back one day, not one week (nz: a missing day does not blank the next one).
                const unit = frame === 'W' ? 'week' : 'month';
                const v = this.tx(expr, { ...env, frame: name });
                this.note('approx', 'CV-PINE-SECURITY-LOOKAHEAD-SHIFTED', `request.security(..., x[${shiftedBack}], lookahead=barmerge.lookahead_on) is the ${shiftedBack === 1 ? `previous ${unit}` : `${unit} ${shiftedBack} back`} on every day of a ${unit}, its last session included. It is written as the ${unit}ly value as it stood the day before: (${v.s} + nz(0 * close))[1]. That follows Pine's rule on every session (weekly and monthly, month ends in mid-week included); the one difference is the first session after a ${unit} whose last weekday was a holiday (the ${unit} is only known complete then), where this shows the ${unit} before.`, e.line);
                return { s: `(${v.s} + nz(0 * close))[1]`, ty: v.ty };
            }
            this.note('info', 'CV-PINE-SECURITY-HTF', `request.security(syminfo.tickerid, "${code}", expr) is tf("${frame}") with the prices inside expr read from it. Here only completed ${frame === 'W' ? 'weeks' : 'months'} are seen (one appears from the close of its last session): on past candlesticks this is what Pine shows with lookahead off; on the live, unfinished ${frame === 'W' ? 'week' : 'month'} Pine shows it so far (and repaints), this script does not.`, e.line);
            return this.tx(expr, { ...env, frame: name });
        }
        if (!chartTf)
            throw new Unsupported('CV-PINE-SECURITY-OTHER-TF', 'request.security on another symbol and another candlestick size is not converted (ref() has no size here).');
        if (this.st.benchmark === null || this.st.benchmark === ticker) {
            this.st.benchmark = ticker;
            this.note('info', 'CV-PINE-SECURITY-BENCH', `request.security(${pineSym || 'symbol'}, timeframe.period, x) on the chart's own candlestick size reads the benchmark: bench.close and so on.`, e.line);
            return this.tx(asWritten, { ...env, frame: 'bench' });
        }
        const name = this.frameName(`ref:${ticker}`, `ref(${csString(ticker)})`, e.line);
        return this.tx(asWritten, { ...env, frame: name });
    }
    frameName(key, value, line) {
        const have = this.st.frames.get(key);
        if (have)
            return have;
        const base = key === 'W' ? 'w' : key === 'M' ? 'm' : 'other';
        const name = this.fresh(base);
        this.emitAssign(name, value, line);
        this.st.frames.set(key, name);
        return name;
    }
    tickerOf(sym, line) {
        const up = sym.toUpperCase();
        if (TICKERS[up])
            return TICKERS[up];
        const bare = up.includes(':') ? up.slice(up.indexOf(':') + 1) : up;
        if (up.includes(':'))
            this.note('approx', 'CV-PINE-TICKER', `the exchange prefix of ${sym} is dropped (${bare}); check that the symbol exists here (Needs verification).`, line);
        return bare;
    }
    // ---- user functions ------------------------------------------------------------------------------------------------------
    funcs = new Map();
    funcDef(s) {
        const body = s.body;
        const last = body[body.length - 1];
        const locals = body.slice(0, -1).filter((x) => x.k !== 'comment');
        const simpleLocals = locals.every((x) => x.k === 'assign' && x.op === '=' && x.decl === null && !x.tuple && x.targets.length === 1);
        if (last && last.k === 'expr' && simpleLocals) {
            this.funcs.set(s.name, s);
            this.st.scope.set(`fn:${s.name}`, { k: 'inline', s: '', ty: 'any' });
            this.note('info', 'CV-PINE-FUNCTION-INLINED', `the function ${s.name}() is written out where it is called${locals.length ? ', its own names prefixed with the function name' : ''}.`, s.line, s.endLine);
            return;
        }
        this.note('unsupported', 'CV-PINE-FUNCTION-BLOCK', `the function ${s.name}() is converted only when its lines name values (x = ...) and the last line is the result; this one also changes values or has blocks. It is left out.`, s.line, s.endLine, this.srcText(s.line));
        this.st.scope.set(s.name, { k: 'dropped', line: s.line });
        this.st.scope.set(`fn:${s.name}`, { k: 'dropped', line: s.line });
    }
    inlineCall(e, env) {
        const f = this.funcs.get(e.fn);
        if (!f)
            throw new Dropped(e.fn);
        const m = this.argsOf(e.args, f.params.map((p) => p.name));
        const saved = new Map();
        for (const p of f.params) {
            const x = m.get(p.name) ?? p.def;
            if (!x)
                throw new Unsupported('CV-PINE-ARGS', `${f.name}() is missing an argument.`);
            const val = this.tx(x, env);
            saved.set(p.name, this.st.scope.get(p.name));
            this.st.scope.set(p.name, { k: 'inline', s: `(${val.s})`, ty: val.ty });
        }
        try {
            const body = f.body.filter((x) => x.k !== 'comment');
            for (const st of body.slice(0, -1)) {
                const a = st;
                const local = a.targets[0];
                if (!saved.has(local))
                    saved.set(local, this.st.scope.get(local));
                const val = this.tx(a.value, env);
                const cs = this.fresh(`${snake(f.name)}_${snake(local)}`);
                this.emitAssign(cs, val.s, a.line);
                this.st.scope.set(local, { k: 'value', cs, ty: val.ty });
            }
            const res = body[body.length - 1];
            return this.tx(res.e, env);
        }
        finally {
            for (const [k, b] of saved) {
                if (b)
                    this.st.scope.set(k, b);
                else
                    this.st.scope.delete(k);
            }
        }
    }
    // ---- statements ----------------------------------------------------------------------------------------------------------
    exprStatement(e, line, endLine, guard, handle) {
        if (e.k === 'switch' || e.k === 'ifx') {
            this.note('unsupported', 'CV-PINE-SWITCH-STATEMENT', 'a switch or if used as a statement on its own is not converted. It is left out.', line, endLine, this.srcText(line));
            return;
        }
        if (e.k !== 'call' || !e.fn) {
            this.note('info', 'CV-PINE-NO-EFFECT', 'a value on a line of its own does nothing; it is left out.', line);
            return;
        }
        const fn = this.alias(e.fn);
        try {
            switch (fn) {
                case 'indicator':
                case 'strategy':
                    this.declaration(e, fn, line);
                    return;
                case 'library':
                    this.st.declKind = 'library';
                    this.note('unsupported', 'CV-PINE-LIBRARY', 'a library cannot be converted; paste its functions into the script that uses them.', line);
                    return;
                case 'plot':
                    this.plot(e, line, guard, handle);
                    return;
                case 'hline':
                    this.hline(e, line, handle);
                    return;
                case 'plotshape':
                case 'plotchar':
                    this.plotshape(e, fn, line, guard);
                    return;
                case 'plotarrow':
                    this.plotarrow(e, line, guard);
                    return;
                case 'bgcolor':
                case 'barcolor':
                    this.bgcolor(e, fn, line, guard);
                    return;
                case 'fill':
                    this.fill(e, line);
                    return;
                case 'alertcondition':
                    this.alertcondition(e, line, guard);
                    return;
                case 'alert':
                    this.alertCall(e, line, guard);
                    return;
                case 'strategy.entry':
                case 'strategy.order':
                    this.strategyEntry(e, fn, line, guard);
                    return;
                case 'strategy.close':
                case 'strategy.close_all':
                    this.strategyClose(e, line, guard);
                    return;
                case 'strategy.exit':
                    this.strategyExit(e, line, guard);
                    return;
                case 'strategy.cancel':
                case 'strategy.cancel_all':
                    throw new Unsupported('CV-PINE-STRATEGY-ORDER', `${fn}: pending orders are not part of a strategy here.`);
                case 'label.new':
                    this.labelNew(e, line, guard);
                    return;
                case 'line.delete':
                case 'label.delete':
                case 'box.delete':
                    throw new Unsupported('CV-PINE-DRAWING', 'drawing objects are not part of the language.');
                case 'table.cell':
                    this.tableCell(e, line);
                    return;
                default:
                    break;
            }
            if (/^(line|label|box|table|polyline|linefill)\./.test(fn))
                throw new Unsupported('CV-PINE-DRAWING', `${fn}: drawing objects (lines, labels, boxes, tables) are not part of the language.`);
            if (fn === 'plotcandle' || fn === 'plotbar')
                throw new Unsupported('CV-PINE-PLOTCANDLE', `${fn}: drawing candlesticks is not available.`);
            if (fn.startsWith('runtime.') || fn.startsWith('log.'))
                throw new Unsupported('CV-PINE-LOG', `${fn}: messages to the log are not available.`);
            this.tx(e, { line });
            this.note('info', 'CV-PINE-NO-EFFECT', 'a value on a line of its own does nothing; it is left out.', line);
        }
        catch (err) {
            this.failStatement(err, line, endLine, []);
        }
    }
    declaration(e, fn, line) {
        this.st.declKind = fn;
        this.st.declLine = line;
        const m = this.argsOf(e.args, ['title', 'shorttitle', 'overlay']);
        const t = m.get('title');
        this.st.title = t && t.k === 'str' ? t.v : 'Imported script';
        const ov = m.get('overlay');
        this.st.overlay = ov !== undefined && ov.k === 'bool' && ov.v;
        const ignored = [];
        const known = new Set(['title', 'shorttitle', 'overlay']);
        if (fn === 'indicator') {
            for (const [k] of m)
                if (!known.has(k))
                    ignored.push(k);
            if (ignored.length)
                this.note('info', 'CV-PINE-DECL-IGNORED', `${ignored.map((x) => `${x}=`).join(' and ')} ${ignored.length > 1 ? 'are' : 'is'} not carried over.`, line);
            return;
        }
        // strategy settings
        const args = [];
        const cap = m.get('initial_capital');
        const qtyType = m.get('default_qty_type');
        const qtyVal = m.get('default_qty_value');
        if (cap) {
            if (cap.k !== 'num')
                throw new Unsupported('CV-PINE-STRATEGY-CAPITAL', 'initial_capital must be a written number.', 'approx');
            args.push(`capital=${numText(cap.raw)}`);
        }
        const qtyName = qtyType && qtyType.k === 'name' ? qtyType.id : 'strategy.fixed';
        if (qtyName === 'strategy.percent_of_equity') {
            const p = qtyVal && qtyVal.k === 'num' ? qtyVal.v : 100;
            const n = Math.max(1, Math.min(500, Math.round(100 / p)));
            args.push(`max_positions=${n}`, 'sizing="pct_equity"');
            this.note('info', 'CV-PINE-STRATEGY-SIZING', `default_qty_value=${p} percent of equity is sizing="pct_equity" with max_positions=${n} (100 / ${p}).`, line);
        }
        else if (qtyName === 'strategy.cash') {
            args.push('sizing="fixed_amount"');
            this.note('approx', 'CV-PINE-STRATEGY-SIZING', 'default_qty_type=strategy.cash is sizing="fixed_amount"; check the amount per trade and max_positions.', line);
        }
        else {
            this.note('approx', 'CV-PINE-STRATEGY-SIZING', 'Pine buys a fixed number of shares here (default_qty_type=strategy.fixed); this strategy uses the default sizing of the backtest instead.', line);
        }
        const pyr = m.get('pyramiding');
        if (pyr && pyr.k === 'num' && pyr.v > 1)
            this.note('unsupported', 'CV-PINE-PYRAMIDING', `pyramiding=${pyr.v}: adding to a position is not available; a stock already held is not bought again.`, line);
        else if (pyr)
            this.note('info', 'CV-PINE-PYRAMIDING', `pyramiding=${pyr.k === 'num' ? pyr.v : 0} is the rule here too: a stock already held is not bought again.`, line);
        const comm = m.get('commission_value');
        if (comm)
            this.note('info', 'CV-PINE-STRATEGY-COSTS', `commission_value=${this.srcExpr(comm)} is not carried over: costs come from the host's dated cost table (costs=...), and with none they are zero.`, line);
        if (m.get('slippage'))
            this.note('info', 'CV-PINE-STRATEGY-COSTS', 'slippage= is not carried over: the backtest uses its own slippage profile.', line);
        const poc = m.get('process_orders_on_close');
        if (poc && poc.k === 'bool' && poc.v)
            this.note('approx', 'CV-PINE-STRATEGY-FILL', 'process_orders_on_close=true fills at the signal close in Pine; here an entry decided on a close fills at the next open.', line);
        for (const k of ['calc_on_every_tick', 'calc_on_order_fills', 'use_bar_magnifier', 'close_entries_rule']) {
            if (m.get(k))
                this.note('info', 'CV-PINE-DECL-IGNORED', `${k}= is not carried over.`, line);
        }
        this.note('info', 'CV-PINE-STRATEGY-SCOPE', 'a Pine strategy trades the one chart symbol; this strategy is tested across the host\'s default list of stocks (set universe= to choose).', line);
        this.st.strategyArgs = args;
    }
    /** `name = input...` at the top level. Returns true when it was an input. */
    input(s) {
        const e = s.value;
        if (e.k !== 'call' || !e.fn)
            return false;
        const fn = this.alias(e.fn);
        if (fn !== 'input' && !fn.startsWith('input.'))
            return false;
        const name = s.targets[0];
        const line = s.line;
        let kind;
        let m;
        if (fn === 'input') {
            m = this.argsOf(e.args, ['defval', 'title']);
            const ty = m.get('type');
            const def = m.get('defval');
            if (ty && ty.k === 'name' && V4_INPUT_TYPES[ty.id])
                kind = V4_INPUT_TYPES[ty.id];
            else if (def && def.k === 'name' && (PRICE.has(def.id) || BLENDS[def.id]))
                kind = 'source';
            else if (def && def.k === 'num')
                kind = /[.eE]/.test(def.raw) ? 'float' : 'int';
            else if (def && def.k === 'un' && def.op === '-' && def.x.k === 'num')
                kind = /[.eE]/.test(def.x.raw) ? 'float' : 'int';
            else if (def && def.k === 'bool')
                kind = 'bool';
            else if (def && def.k === 'str')
                kind = 'string';
            else
                kind = 'unknown';
        }
        else {
            kind = fn.slice('input.'.length);
            m = this.argsOf(e.args, kind === 'string' ? ['defval', 'title', 'options'] : ['defval', 'title', 'minval', 'maxval']);
        }
        const titleE = m.get('title');
        const title = titleE && titleE.k === 'str' && titleE.v.length >= 1 && titleE.v.length <= 60 && !titleE.v.includes('\n') ? titleE.v : undefined;
        const def = m.get('defval');
        const ignoredKeys = ['step', 'tooltip', 'inline', 'group', 'confirm', 'display'].filter((k) => m.has(k));
        const fixedNote = (what) => this.note('approx', 'CV-PINE-INPUT-FROZEN', what, line);
        switch (kind) {
            case 'source': {
                const d = def && def.k === 'name' ? def.id : 'close';
                if (!SOURCE_CHOICES.includes(d)) {
                    this.st.scope.set(name, { k: 'value', cs: this.tx(def, { line }).s, ty: 'num' });
                    fixedNote(`the source setting ${name} with default ${d} is fixed to ${d}.`);
                    return true;
                }
                const choice = this.fresh(`${snake(name)}_choice`);
                const inp = { pine: name, cs: choice, type: 'str', def: csString(d), options: [...SOURCE_CHOICES], line, uses: [] };
                if (title)
                    inp.title = title;
                this.st.inputs.push(inp);
                const src = this.csNameFor(name);
                const others = SOURCE_CHOICES.filter((c) => c !== d);
                let chain = d;
                for (let i = others.length - 1; i >= 0; i--)
                    chain = `${others[i]} if ${choice} == ${csString(others[i])} else ${chain}`;
                this.emitAssign(src, chain, line);
                this.st.scope.set(name, { k: 'value', cs: src, ty: 'num' });
                this.note('info', 'CV-PINE-INPUT-SOURCE', `${fn === 'input' ? `input(${d}, ...)` : 'input.source'} became a choice setting of the usual prices; another script's plot cannot be chosen as a source here.`, line);
                return true;
            }
            case 'symbol': {
                const d = def && def.k === 'str' ? def.v : '';
                this.st.scope.set(name, { k: 'symbol', ticker: this.tickerOf(d, line), pine: d, line });
                return true;
            }
            case 'timeframe': {
                const d = def && def.k === 'str' ? def.v : '';
                this.st.scope.set(name, { k: 'tfcode', code: d, line });
                fixedNote(`input.timeframe is not a setting here: the size "${d}" is written into the script.`);
                return true;
            }
            case 'color': {
                const c = def ? this.colorOf(def, { line }) : 'color.blue';
                this.st.scope.set(name, { k: 'color', s: c });
                this.note('info', 'CV-PINE-INPUT-COLOR', 'a colour setting is not available; the colour is fixed to the nearest theme tone.', line);
                return true;
            }
            case 'session':
            case 'time':
            case 'price':
            case 'text_area':
            case 'unknown': {
                this.st.scope.set(name, { k: 'dropped', line });
                this.note('unsupported', 'CV-PINE-INPUT-KIND', `this kind of setting (${fn}) is not available. It is left out.`, line, s.endLine, this.srcText(line));
                return true;
            }
            default:
                break;
        }
        // int / float / bool / string / enum
        const inp = { pine: name, cs: this.csNameFor(name), type: 'int', def: '', line, uses: [] };
        if (title)
            inp.title = title;
        if (kind === 'bool') {
            inp.type = 'bool';
            inp.def = def && def.k === 'bool' && def.v ? 'True' : 'False';
        }
        else if (kind === 'string' || kind === 'enum') {
            inp.type = 'str';
            if (!def || def.k !== 'str')
                throw new Unsupported('CV-PINE-INPUT-DEFAULT', 'a text setting needs a written default.');
            inp.def = csString(def.v);
            const opts = m.get('options');
            if (opts && opts.k === 'list') {
                const vals = opts.items.map((x) => (x.k === 'str' ? x.v : null));
                if (vals.some((x) => x === null))
                    throw new Unsupported('CV-PINE-INPUT-OPTIONS', 'options must be written texts.');
                let list = vals;
                if (list.length > 12) {
                    list = list.slice(0, 12);
                    this.note('approx', 'CV-PINE-INPUT-OPTIONS', 'a text setting offers at most 12 choices here; the first 12 are kept.', line);
                }
                if (list.some((x) => x.length > 24 || x.length < 1))
                    throw new Unsupported('CV-PINE-INPUT-OPTIONS', 'a choice must be 1 to 24 characters here.');
                if (!list.includes(def.v))
                    list = [def.v, ...list.slice(0, 11)];
                inp.options = list;
            }
        }
        else {
            inp.type = kind === 'float' ? 'float' : 'int';
            const lit = def && def.k === 'num' ? def.raw : def && def.k === 'un' && def.op === '-' && def.x.k === 'num' ? `-${def.x.raw}` : null;
            if (lit === null)
                throw new Unsupported('CV-PINE-INPUT-DEFAULT', 'a number setting needs a written default.');
            let d = numText(lit);
            if (inp.type === 'float' && !/[.eE]/.test(d))
                d = `${d}.0`;
            if (inp.type === 'int' && /[.eE]/.test(d))
                inp.type = 'float';
            inp.def = d;
            inp.defNum = Number(d);
            const lim = (k) => {
                const x = m.get(k);
                if (!x)
                    return undefined;
                if (x.k === 'num')
                    return numText(x.raw);
                if (x.k === 'un' && x.op === '-' && x.x.k === 'num')
                    return `-${numText(x.x.raw)}`;
                return undefined;
            };
            const mn = lim('minval');
            const mx = lim('maxval');
            if (mn !== undefined)
                inp.min = mn;
            if (mx !== undefined)
                inp.max = mx;
            const opts = m.get('options');
            if (opts && opts.k === 'list') {
                const nums = opts.items.map((x) => (x.k === 'num' ? x.v : NaN));
                if (!nums.some((x) => Number.isNaN(x))) {
                    inp.min = String(Math.min(...nums));
                    inp.max = String(Math.max(...nums));
                    this.note('approx', 'CV-PINE-INPUT-NUM-OPTIONS', `a number setting with a list of choices became a number from ${inp.min} to ${inp.max}; any value in between can be chosen here.`, line);
                }
            }
        }
        if (ignoredKeys.length)
            this.note('info', 'CV-PINE-INPUT-IGNORED', `${ignoredKeys.map((k) => `${k}=`).join(', ')} ${ignoredKeys.length > 1 ? 'are' : 'is'} not carried over.`, line);
        this.st.inputs.push(inp);
        const ty = inp.type === 'bool' ? 'bool' : inp.type === 'str' ? 'str' : 'num';
        this.st.scope.set(name, { k: 'value', cs: inp.cs, ty, inputOf: inp });
        return true;
    }
    /** Pine names bound to `setting / k` or `setting * k` (V-5): the setting's own name here and the arithmetic. */
    scaled = new Map();
    /**
     * `stopPct = input(3.0, "Stop %") / 100` (V-5, 2026-10-25): a setting with arithmetic. It becomes the setting (`stop_pct_in`,
     * the number people type) and a name for the arithmetic (`stop_pct = stop_pct_in / 100`), so a strategy stop written from it
     * can be given the setting itself as its percent.
     */
    scaledInput(s) {
        const e = s.value;
        if (e.k !== 'bin' || (e.op !== '/' && e.op !== '*'))
            return false;
        const isIn = (x) => x.k === 'call' && !!x.fn && (this.alias(x.fn) === 'input' || this.alias(x.fn).startsWith('input.'));
        const [call, k] = isIn(e.l) && e.r.k === 'num' ? [e.l, e.r] : e.op === '*' && isIn(e.r) && e.l.k === 'num' ? [e.r, e.l] : [null, null];
        if (!call || !k || k.k !== 'num' || k.v === 0)
            return false;
        const name = s.targets[0];
        const setting = `${name}_in`;
        if (!this.input({ ...s, targets: [setting], value: call }))
            return false;
        const b = this.st.scope.get(setting);
        if (!b || b.k !== 'value' || !b.inputOf)
            return true;
        const cs = this.bindNew(name, { s: `${b.cs} ${e.op} ${numText(k.raw)}`, ty: 'num' }, s.line, { k: 'bin', op: e.op, l: { k: 'name', id: setting, line: s.line }, r: k, line: s.line });
        void cs;
        this.scaled.set(name, { cs: b.cs, op: e.op, k: k.v });
        this.note('info', 'CV-PINE-INPUT-SCALED', `the setting with arithmetic became the setting ${b.cs} (the number people type) and \`${snake(name)} = ${b.cs} ${e.op} ${numText(k.raw)}\`.`, s.line);
        return true;
    }
    assign(s, siblings, index) {
        const line = s.line;
        try {
            if (s.op === '=' && s.decl === null && !s.tuple && this.input(s))
                return;
            if (s.op === '=' && s.decl === null && !s.tuple && this.scaledInput(s))
                return;
        }
        catch (err) {
            this.failStatement(err, line, s.endLine, s.targets);
            return;
        }
        // plots and hlines given a name (handles)
        if (s.value.k === 'call' && (s.value.fn === 'plot' || s.value.fn === 'hline')) {
            this.exprStatement(s.value, line, s.endLine, null, s.targets[0]);
            return;
        }
        if (s.value.k === 'call' && s.value.fn && /^(line|label|box|table)\.new$/.test(s.value.fn)) {
            this.st.scope.set(s.targets[0], { k: 'dropped', line });
            if (s.value.fn === 'table.new') {
                this.tableLines.push(line);
                return;
            }
            this.note('unsupported', 'CV-PINE-DRAWING', `${s.value.fn}: drawing objects (lines, labels, boxes, tables) are not part of the language. It is left out.`, line, s.endLine, this.srcText(line));
            return;
        }
        if (s.type && ['line', 'label', 'box', 'table', 'linefill', 'polyline'].includes(s.type)) {
            // a drawing object held in a name: reported where it is drawn (or at the end, if it never is)
            this.st.scope.set(s.targets[0], { k: 'dropped', line });
            if (s.type === 'table')
                this.tableLines.push(line);
            else
                this.drawingVars.set(s.targets[0], line);
            return;
        }
        if (s.tuple) {
            this.tuple(s);
            return;
        }
        if (s.decl === 'varip') {
            this.st.scope.set(s.targets[0], { k: 'dropped', line });
            this.note('unsupported', 'CV-PINE-VARIP', 'varip keeps a value inside the forming candlestick; scripts here are worked out on closed candlesticks. It is left out.', line, s.endLine, this.srcText(line));
            return;
        }
        if (s.decl === 'var') {
            this.varDecl(s, siblings, index);
            return;
        }
        const name = s.targets[0];
        if (s.op !== '=') {
            this.reassign(s);
            return;
        }
        try {
            const v = this.tx(s.value, { line, top: true, target: snake(name) });
            this.bindNew(name, v, line, s.value);
            this.lookalikes(line, s.endLine);
        }
        catch (err) {
            this.failStatement(err, line, s.endLine, [name]);
        }
    }
    /** Hand-written candle patterns that look like a library name but are not the same test: say why they are kept as written. */
    lookalikes(line, endLine) {
        const t = this.srcText(line, endLine).replace(/\s+/g, ' ');
        if (/high\s*<\s*high\[1\]/.test(t) && /low\s*>\s*low\[1\]/.test(t)) {
            this.note('info', 'CV-PINE-KEPT-INSIDE', 'kept as written (strictly inside). candle.inside() here also counts an equal high or low, so it is not used.', line);
        }
        if (/close\s*[<>]\s*open\b/.test(t) && /close\[1\]\s*[<>]\s*open\[1\]/.test(t) && /open\s*[<>]=?\s*close\[1\]/.test(t)) {
            this.note('info', 'CV-PINE-KEPT-ENGULFING', 'kept as written; candle.pattern("bullish_engulfing") here adds a trend and size test, so it is not used.', line);
        }
    }
    tableLines = [];
    /** Names declared with `var` (V-1): a value for one of them that reads the name is a recursion and is never converted. */
    varNames = new Set();
    /** Names (not var) that are changed with `:=` / `+=` somewhere AND whose history (`x[1]`) is read somewhere (V-1). */
    rebound = new Set();
    /** Fills `rebound` before the statements are converted. Function bodies have their own names and are not looked at. */
    collectRebound(body) {
        const changed = new Set();
        const history = new Set();
        const vars = new Set();
        const ex = (e) => {
            if (e.k === 'index' && e.x.k === 'name')
                history.add(e.x.id);
            for (const k of this.kidsOf(e))
                ex(k);
        };
        const walk = (ss) => {
            for (const st of ss) {
                if (st.k === 'expr')
                    ex(st.e);
                else if (st.k === 'assign') {
                    ex(st.value);
                    if (st.decl === 'var' || st.decl === 'varip')
                        for (const t of st.targets)
                            vars.add(t);
                    else if (st.op !== '=')
                        for (const t of st.targets)
                            changed.add(t);
                }
                else if (st.k === 'if') {
                    ex(st.cond);
                    walk(st.body);
                    for (const b of st.elifs) {
                        ex(b.cond);
                        walk(b.body);
                    }
                    if (st.orelse)
                        walk(st.orelse);
                }
                else if (st.k === 'for') {
                    ex(st.from);
                    ex(st.to);
                    walk(st.body);
                }
            }
        };
        walk(body);
        this.rebound = new Set([...changed].filter((n) => history.has(n) && !vars.has(n)));
    }
    /** `name[k]` anywhere in e. */
    readsHistory(e, name) {
        let hit = false;
        const look = (x) => {
            if (hit)
                return;
            if (x.k === 'index' && x.x.k === 'name' && x.x.id === name) {
                hit = true;
                return;
            }
            for (const k of this.kidsOf(x))
                look(k);
        };
        look(e);
        return hit;
    }
    kidsOf(x) {
        switch (x.k) {
            case 'bin':
                return [x.l, x.r];
            case 'tern':
                return [x.c, x.a, x.b];
            case 'call':
                return [x.callee, ...x.args.map((q) => q.value)];
            case 'un':
            case 'member':
                return [x.x];
            case 'index':
                return [x.x, x.i];
            case 'list':
                return x.items;
            case 'switch':
                return [...(x.subject ? [x.subject] : []), ...x.arms.flatMap((a) => [...(a.when ? [a.when] : []), a.value])];
            case 'ifx':
                return x.branches.flatMap((b) => [...(b.cond ? [b.cond] : []), b.value]);
            default:
                return [];
        }
    }
    /**
     * The guard for every new value given to an existing name (V-1). Pine's `var x` keeps its value from one candlestick to the next,
     * so a new value that reads x reads the previous candlestick's x: a recursion this language cannot write. And `x[k]` in the new
     * value is the value x ENDS with on that candlestick, after this change (a recursion too). Both are refused, never converted
     * to the first value. Reads of `x[k]` elsewhere are refused where they are written (`rebound`).
     */
    stateGuard(name, value) {
        if (this.varNames.has(name) && value && this.readsName(value, name)) {
            throw new Unsupported('CV-PINE-VAR-STATE', `\`${name}\` is a var that is given a new value from its own previous value (a recursion); this language cannot write that yet, so it is not converted.`);
        }
        if (value && this.readsHistory(value, name)) {
            throw new Unsupported('CV-PINE-RECURSION', `\`${name}\` is given a new value from its own earlier values (${name}[...]), a recursion this language cannot write yet (a running total is ta.cum_sum(x)). It is not converted.`);
        }
    }
    bindNew(name, v, line, pine) {
        const prev = this.st.scope.get(name);
        if (prev && pine && this.varNames.has(name) && this.readsName(pine, name))
            this.stateGuard(name, pine);
        const cs = prev && prev.k === 'value' && !prev.inputOf ? this.fresh(`${prev.cs}`) : this.csNameFor(name);
        this.emitAssign(cs, v.s, line);
        const b = { k: 'value', cs, ty: v.ty, line };
        if (pine)
            b.pine = pine;
        this.st.scope.set(name, b);
        return cs;
    }
    readsName(e, name) {
        switch (e.k) {
            case 'name':
                return e.id === name;
            case 'member':
                return this.readsName(e.x, name);
            case 'call':
                return this.readsName(e.callee, name) || e.args.some((a) => this.readsName(a.value, name));
            case 'index':
                return this.readsName(e.x, name) || this.readsName(e.i, name);
            case 'un':
                return this.readsName(e.x, name);
            case 'bin':
                return this.readsName(e.l, name) || this.readsName(e.r, name);
            case 'tern':
                return this.readsName(e.c, name) || this.readsName(e.a, name) || this.readsName(e.b, name);
            case 'list':
                return e.items.some((x) => this.readsName(x, name));
            case 'switch':
                return (e.subject !== null && this.readsName(e.subject, name)) || e.arms.some((a) => (a.when !== null && this.readsName(a.when, name)) || this.readsName(a.value, name));
            case 'ifx':
                return e.branches.some((b) => (b.cond !== null && this.readsName(b.cond, name)) || this.readsName(b.value, name));
            default:
                return false;
        }
    }
    /** `x := expr` / `x += expr` outside the recognised `var` idioms: a new name, unless it reads its own earlier value. */
    reassign(s) {
        const name = s.targets[0];
        const line = s.line;
        const prev = this.st.scope.get(name);
        try {
            if (!prev)
                throw new Unsupported('CV-PINE-REASSIGN-UNKNOWN', `\`${name}\` is given a new value before it has one.`);
            if (prev.k === 'dropped')
                throw new Dropped(name);
            let value = s.value;
            if (s.op !== ':=') {
                const op = s.op[0];
                value = { k: 'bin', op, l: { k: 'name', id: name, line }, r: s.value, line };
            }
            if (prev.k === 'sum' || prev.k === 'pendingVar')
                throw new Unsupported('CV-PINE-RECURSION', `\`${name}\` is changed again after a loop or a carried-over value; this is not converted.`);
            // `x := x + 1` at the top level with no var: Pine starts x again every candlestick, so it is plain arithmetic.
            this.stateGuard(name, value);
            const v = this.tx(value, { line });
            this.bindNew(name, v, line, value);
        }
        catch (err) {
            this.failStatement(err, line, s.endLine, [name]);
        }
    }
    inLoopOrIf = 0;
    tuple(s) {
        const line = s.line;
        const e = s.value;
        const names = s.targets;
        try {
            if (e.k !== 'call' || !e.fn)
                throw new Unsupported('CV-PINE-TUPLE', 'splitting a value into several names is converted only for ta.macd, ta.bb, ta.kc, ta.supertrend and ta.dmi.');
            const fn = this.alias(e.fn);
            const env = { line };
            const name = (i, base) => {
                const n = names[i];
                if (!n || n === '_')
                    return this.fresh(base);
                return this.csNameFor(n);
            };
            const bind = (i, cs) => {
                const n = names[i];
                if (n && n !== '_')
                    this.st.scope.set(n, { k: 'value', cs, ty: 'num' });
            };
            switch (fn) {
                case 'ta.macd': {
                    const m = this.argsOf(e.args, ['source', 'fastlen', 'slowlen', 'siglen']);
                    const src = this.tx(m.get('source'), env).s;
                    const f = this.tx(m.get('fastlen'), env);
                    const sl = this.tx(m.get('slowlen'), env);
                    const sg = this.tx(m.get('siglen'), env);
                    const mn = name(0, 'macd_line');
                    this.emitAssign(mn, `${this.callCs('ta.ema', [{ s: src }, f])} - ${this.callCs('ta.ema', [{ s: src }, sl])}`, line);
                    bind(0, mn);
                    const sn = name(1, 'signal_line');
                    this.emitAssign(sn, this.callCs('ta.ema', [{ s: mn }, sg]), line);
                    bind(1, sn);
                    const hn = name(2, 'hist_line');
                    this.emitAssign(hn, `${mn} - ${sn}`, line);
                    bind(2, hn);
                    this.note('info', 'CV-PINE-MACD', 'ta.macd is written out as Pine defines it (EMA fast minus EMA slow, signal = EMA of that), so the result does not depend on a study.', line);
                    return;
                }
                case 'ta.bb': {
                    const m = this.argsOf(e.args, ['series', 'length', 'mult']);
                    const src = this.tx(m.get('series'), env).s;
                    const len = this.tx(m.get('length'), env);
                    const mult = this.tx(m.get('mult'), env).s;
                    const mid = name(0, 'basis');
                    this.emitAssign(mid, this.callCs('ta.sma', [{ s: src }, len]), line);
                    bind(0, mid);
                    const dev = this.fresh('dev');
                    this.emitAssign(dev, `${mult} * ${this.callCs('ta.stdev', [{ s: src }, len])}`, line);
                    const up = name(1, 'upper');
                    this.emitAssign(up, `${mid} + ${dev}`, line);
                    bind(1, up);
                    const lo = name(2, 'lower');
                    this.emitAssign(lo, `${mid} - ${dev}`, line);
                    bind(2, lo);
                    this.note('info', 'CV-PINE-BB', "ta.bb gives [middle, upper, lower] in Pine; it is written out here (SMA and population standard deviation, as Pine's ta.bb), so no order can be mixed up.", line);
                    return;
                }
                case 'ta.kc': {
                    const m = this.argsOf(e.args, ['series', 'length', 'mult', 'useTrueRange']);
                    const src = this.tx(m.get('series'), env).s;
                    const len = this.tx(m.get('length'), env);
                    const mult = this.tx(m.get('mult'), env).s;
                    const useTr = m.get('useTrueRange');
                    const tr = !(useTr && useTr.k === 'bool' && !useTr.v);
                    const mid = name(0, 'middle');
                    this.emitAssign(mid, this.callCs('ta.ema', [{ s: src }, len]), line);
                    bind(0, mid);
                    const rng = tr ? this.fresh('tr') : null;
                    if (rng)
                        this.emitAssign(rng, this.trueRange(env), line);
                    const re = this.fresh('range_ema');
                    this.emitAssign(re, this.callCs('ta.ema', [{ s: rng ?? '(high - low)' }, len]), line);
                    const up = name(1, 'upper');
                    this.emitAssign(up, `${mid} + ${mult} * ${re}`, line);
                    bind(1, up);
                    const lo = name(2, 'lower');
                    this.emitAssign(lo, `${mid} - ${mult} * ${re}`, line);
                    bind(2, lo);
                    this.note('info', 'CV-PINE-KC', `ta.kc (${tr ? "true range on, Pine's default" : 'high - low'}) is written out: middle = EMA of the source, bands = middle +/- mult x EMA of the ${tr ? 'true range' : 'range'}. ind.keltner is not used because its averaging is not confirmed to be Pine's.`, line);
                    return;
                }
                case 'ta.supertrend': {
                    const m = this.argsOf(e.args, ['factor', 'atrPeriod']);
                    const factor = this.tx(m.get('factor'), env).s;
                    const period = this.tx(m.get('atrPeriod'), env).s;
                    const g = this.fresh('s');
                    this.emitAssign(g, this.callCs('ind.supertrend', [{ name: 'period', s: period }, { name: 'mult', s: factor }]), line);
                    if (names[0] && names[0] !== '_') {
                        const st = this.csNameFor(names[0]);
                        this.emitAssign(st, `${g}.value`, line);
                        bind(0, st);
                    }
                    if (names[1] && names[1] !== '_') {
                        const d = this.csNameFor(names[1]);
                        this.emitAssign(d, `-${g}.direction`, line);
                        bind(1, d);
                        this.note('info', 'CV-PINE-SUPERTREND-DIRECTION', "Pine's direction is -1 in an uptrend; here .direction is 1 in an uptrend, so it is written as -s.direction to keep Pine's meaning.", line);
                    }
                    this.note('info', 'CV-PINE-SUPERTREND-ORDER', 'ta.supertrend(factor, atrPeriod) takes the factor first; ind.supertrend is written with names (period=, mult=) so they cannot be swapped.', line);
                    return;
                }
                case 'ta.dmi': {
                    const m = this.argsOf(e.args, ['diLength', 'adxSmoothing']);
                    const di = this.tx(m.get('diLength'), env).s;
                    const sm = this.tx(m.get('adxSmoothing'), env).s;
                    const g = this.fresh('dmi');
                    this.emitAssign(g, this.callCs('ind.adx', [{ s: di }]), line);
                    const fields = ['plus_di', 'minus_di', 'adx'];
                    names.forEach((n, i) => {
                        if (!n || n === '_' || i > 2)
                            return;
                        const cs = this.csNameFor(n);
                        this.emitAssign(cs, `${g}.${fields[i]}`, line);
                        this.st.scope.set(n, { k: 'value', cs, ty: 'num' });
                    });
                    if (di !== sm) {
                        const smInput = this.st.inputs.find((x) => x.cs === sm);
                        this.note('approx', 'CV-PINE-DMI-LENGTHS', `ta.dmi(diLength, adxSmoothing) has two lengths; ind.adx(length) has one, used for both.${smInput ? ` The setting ${smInput.pine} is left out.` : ''} With both equal the numbers are meant to match Pine (Wilder smoothing; Needs verification).`, smInput ? Math.min(smInput.line, line) : line, line);
                    }
                    this.note('info', 'CV-PINE-DMI', 'ta.dmi gives [+DI, -DI, ADX]; here the parts are read by name (.plus_di, .minus_di, .adx).', line);
                    return;
                }
                case 'request.security':
                    throw new Unsupported('CV-PINE-SECURITY-TUPLE', 'request.security with several values is not converted; write one request.security per value.');
                default: {
                    const uf = this.funcs.get(e.fn);
                    if (uf)
                        throw new Unsupported('CV-PINE-FUNCTION-TUPLE', `a function that gives several values (${e.fn}) is not converted.`);
                    throw new Unsupported('CV-PINE-TUPLE', `splitting the result of ${fn} into names is not converted.`);
                }
            }
        }
        catch (err) {
            this.failStatement(err, line, s.endLine, names.filter((n) => n !== '_'));
        }
    }
    // ---- var idioms ----------------------------------------------------------------------------------------------------------
    /** Statements after `var x` in the same block that give x a new value (directly, or as the only statement of an if). */
    updatesOf(name, siblings, from) {
        const out = [];
        for (let j = from + 1; j < siblings.length; j++) {
            const s = siblings[j];
            if (s.k === 'assign' && s.targets.length === 1 && s.targets[0] === name && s.op !== '=')
                out.push({ stmt: s, assign: s, cond: null });
            if (s.k === 'if' && s.elifs.length === 0 && s.orelse === null && s.body.length === 1) {
                const b = s.body[0];
                if (b.k === 'assign' && b.targets[0] === name && b.op !== '=')
                    out.push({ stmt: s, assign: b, cond: s.cond });
            }
            if (s.k === 'for' && this.assignsTo(s.body, name))
                out.push({ stmt: s, assign: s.body[0], cond: null });
        }
        return out;
    }
    assignsTo(ss, name) {
        return ss.some((s) => (s.k === 'assign' && s.targets.includes(name)) || (s.k === 'if' && (this.assignsTo(s.body, name) || (s.orelse !== null && this.assignsTo(s.orelse, name)))));
    }
    varDecl(s, siblings, index) {
        const name = s.targets[0];
        const line = s.line;
        this.varNames.add(name);
        const ups = this.updatesOf(name, siblings, index);
        if (ups.length === 0) {
            // a var never changed is a constant
            try {
                const v = this.tx(s.value, { line });
                this.bindNew(name, v, line, s.value);
            }
            catch (err) {
                this.failStatement(err, line, s.endLine, [name]);
            }
            return;
        }
        const last = ups[ups.length - 1];
        const endLine = Math.max(...ups.map((u) => ('endLine' in u.stmt ? u.stmt.endLine : u.stmt.line)));
        const lines = [line, ...ups.flatMap((u) => lineRange(u.stmt.line, 'endLine' in u.stmt ? u.stmt.endLine : u.stmt.line))];
        const done = (emit) => {
            for (const u of ups)
                this.st.skip.add(u.stmt);
            this.st.skip.delete(last.stmt);
            this.st.replaced.set(last.stmt, emit);
            this.st.scope.set(name, { k: 'pendingVar', line });
        };
        const u = ups[0];
        const a = u.assign;
        // ATR trailing stop: x := ... math.max(prev, close - k * atr) ... math.min(prev, close + k * atr) ...
        if (ups.length === 1 && u.cond === null && a.op === ':=') {
            const atr = this.findAtrMultiple(a.value);
            const text = this.srcExpr(a.value);
            if (atr && /math\.max/.test(text) && /math\.min/.test(text)) {
                try {
                    const env = { line };
                    const period = this.tx(atr.n, env).s;
                    const mult = this.tx(atr.k, env).s;
                    const cs = this.csNameFor(name);
                    this.emitAssign(cs, `${this.callCs('ind.supertrend', [{ name: 'period', s: period }, { name: 'mult', s: mult }])}.value`, line);
                    this.st.scope.set(name, { k: 'value', cs, ty: 'num' });
                    for (const x of ups)
                        this.st.skip.add(x.stmt);
                    this.note('approx', 'CV-PINE-ATR-TRAILING-STOP', `\`${name}\` reads its own previous value (var + ${name}[1]), a recursion this language cannot write yet (ta.scan is planned). It is replaced by the nearest built-in study, ind.supertrend(period=${period}, mult=${mult}), whose line also ratchets by mult x ATR and flips side when price crosses it. Differences: Supertrend measures from (high + low) / 2, Pine's line from the close, so the line sits at a different height and can flip on different days. Check it on a chart before you rely on it.`, line, endLine, this.srcText(a.line, a.endLine));
                    return;
                }
                catch (err) {
                    this.failStatement(err, line, endLine, [name]);
                    for (const x of ups)
                        this.st.skip.add(x.stmt);
                    return;
                }
            }
        }
        // streak: x := cond ? x + 1 : 0
        if (ups.length === 1 && u.cond === null && a.op === ':=' && a.value.k === 'tern') {
            const t = a.value;
            const plusOne = t.a.k === 'bin' && t.a.op === '+' && t.a.l.k === 'name' && t.a.l.id === name && t.a.r.k === 'num' && t.a.r.v === 1;
            const zero = t.b.k === 'num' && t.b.v === 0;
            if (plusOne && zero && !this.readsName(t.c, name)) {
                done(() => {
                    try {
                        const c = this.tx(t.c, { line: a.line });
                        const cs = this.csNameFor(name);
                        this.emitAssign(cs, `ta.bars_since((not ${c.s}))`, a.line);
                        this.st.scope.set(name, { k: 'value', cs, ty: 'num' });
                        this.note('approx', 'CV-PINE-VAR-STREAK', `the counter \`var ${name} ... ${name} := cond ? ${name} + 1 : 0\` is the idiom "candlesticks in a row where cond is true", written ta.bars_since(not cond). It gives the same numbers once cond has been false at least once; before that (the start of the data) it is unknown where Pine counts from 0.`, line, endLine);
                    }
                    catch (err) {
                        this.failStatement(err, line, endLine, [name]);
                    }
                });
                return;
            }
        }
        // level: var float lvl = na; if cond lvl := expr
        if (ups.length === 1 && u.cond !== null && a.op === ':=' && !this.readsName(a.value, name)) {
            const cond = u.cond;
            done(() => {
                try {
                    const c = this.tx(cond, { line: u.stmt.line });
                    const x = this.tx(a.value, { line: a.line });
                    const cs = this.csNameFor(name);
                    this.emitAssign(cs, this.callCs('ta.value_when', [c, x]), u.stmt.line);
                    this.st.scope.set(name, { k: 'value', cs, ty: x.ty });
                    this.note('info', 'CV-PINE-VAR-LEVEL', `\`var ${name}\` set only when a condition is true is ta.value_when(cond, value): the value from the last candlestick where the condition held.`, line, endLine);
                }
                catch (err) {
                    this.failStatement(err, line, endLine, [name]);
                }
            });
            return;
        }
        // running total: x += expr (or x := x + expr), optionally only when cond
        if (ups.length === 1 && (a.op === '+=' || (a.op === ':=' && a.value.k === 'bin' && a.value.op === '+' && a.value.l.k === 'name' && a.value.l.id === name))) {
            const addend = a.op === '+=' ? a.value : a.value.r;
            if (!this.readsName(addend, name) && u.stmt.k !== 'for') {
                const cond = u.cond;
                done(() => {
                    try {
                        const x = this.tx(addend, { line: a.line });
                        const c = cond ? this.tx(cond, { line: u.stmt.line }) : null;
                        const cs = this.csNameFor(name);
                        this.emitAssign(cs, this.callCs('ta.cum_sum', [{ s: c ? `(${x.s} if ${c.s} else 0)` : x.s }]), u.stmt.line);
                        this.st.scope.set(name, { k: 'value', cs, ty: 'num' });
                        this.note('info', 'CV-PINE-VAR-TOTAL', `the running total \`var ${name}\` is ta.cum_sum(...). Both count from the first candlestick loaded, so the level depends on where the data starts. A missing value adds nothing here; in Pine it makes the total missing from then on.`, line, endLine);
                    }
                    catch (err) {
                        this.failStatement(err, line, endLine, [name]);
                    }
                });
                return;
            }
        }
        // anything else: not converted
        for (const x of ups)
            this.st.skip.add(x.stmt);
        this.st.scope.set(name, { k: 'dropped', line });
        const ls = [...new Set(lines)].sort((p, q) => p - q);
        this.st.notes.push({
            line: ls[0],
            endLine: ls[ls.length - 1],
            lines: ls,
            level: 'unsupported',
            code: 'CV-PINE-VAR-STATE',
            message: `\`var ${name}\` carries a value from one candlestick to the next in a form the converter does not recognise (only counters, running totals, levels set on a condition and the ATR trailing stop are). It is left out, with everything that uses it.`,
            original: this.srcText(line),
        });
    }
    /** In `x := ...`, a name bound to `k * ta.atr(n)` (or such a product written inline). */
    findAtrMultiple(e) {
        const seen = new Set();
        const look = (x) => {
            if (x.k === 'bin' && x.op === '*') {
                const isAtr = (y) => y.k === 'call' && this.alias(y.fn ?? '') === 'ta.atr';
                if (isAtr(x.r))
                    return { k: x.l, n: x.r.args[0].value };
                if (isAtr(x.l))
                    return { k: x.r, n: x.l.args[0].value };
            }
            if (x.k === 'name' && !seen.has(x.id)) {
                seen.add(x.id);
                const b = this.st.scope.get(x.id);
                if (b && b.k === 'value' && b.pine)
                    return look(b.pine);
                return null;
            }
            const kids = x.k === 'bin' ? [x.l, x.r] : x.k === 'tern' ? [x.c, x.a, x.b] : x.k === 'call' ? x.args.map((q) => q.value) : x.k === 'un' ? [x.x] : x.k === 'index' ? [x.x] : [];
            for (const k of kids) {
                const r = look(k);
                if (r)
                    return r;
            }
            return null;
        };
        return look(e);
    }
    // ---- if and for ----------------------------------------------------------------------------------------------------------
    isOutputCall(s) {
        if (s.k !== 'expr' || s.e.k !== 'call' || !s.e.fn)
            return false;
        const fn = this.alias(s.e.fn);
        return /^(plot|plotshape|plotchar|plotarrow|bgcolor|barcolor|alertcondition|alert|label\.new|strategy\.(entry|order|close|close_all|exit))$/.test(fn);
    }
    ifStatement(s) {
        const line = s.line;
        // drawing on the last candlestick only
        if (this.mentions(s.cond, 'barstate.islast') || this.mentions(s.cond, 'barstate.islastconfirmedhistory')) {
            this.lastBarBlock(s);
            return;
        }
        const branches = [{ cond: s.cond, body: s.body, line }, ...s.elifs.map((x) => ({ cond: x.cond, body: x.body, line: x.line }))];
        if (s.orelse)
            branches.push({ cond: null, body: s.orelse, line: s.orelse[0]?.line ?? line });
        const allOutputs = branches.every((b) => b.body.every((x) => this.isOutputCall(x) || x.k === 'comment'));
        if (allOutputs) {
            // outputs cannot sit inside a per-candlestick if: the condition moves into each output
            let prior = [];
            for (const br of branches) {
                let cond;
                try {
                    const c = br.cond ? this.guardCond(br.cond, br.line) : null;
                    const parts = [...prior.map((p) => `(not ${p})`), ...(c ? [c] : [])];
                    cond = parts.length ? parts.join(' and ') : 'True';
                    if (c)
                        prior = [...prior, c];
                }
                catch (err) {
                    this.failStatement(err, br.line, s.endLine, []);
                    return;
                }
                for (const x of br.body)
                    if (x.k === 'expr')
                        this.exprStatement(x.e, x.line, x.endLine, cond === 'True' ? null : `(${cond})`);
            }
            return;
        }
        // assignments to names: a choice per candlestick
        const assigned = new Set();
        const onlyAssigns = branches.every((b) => b.body.every((x) => {
            if (x.k === 'comment')
                return true;
            if (x.k === 'assign' && !x.tuple && x.decl === null && x.targets.length === 1) {
                assigned.add(x.targets[0]);
                return true;
            }
            return false;
        }));
        if (onlyAssigns) {
            if (assigned.size === 1 && this.runningExtreme([...assigned][0], branches, s))
                return;
            try {
                for (const name of assigned) {
                    // V-1: a var set in an if block keeps its previous value where no branch sets it, and a branch that reads it reads the
                    // previous candlestick's value. Both are state; never lowered to a choice over the first value.
                    const isVar = this.varNames.has(name);
                    for (const br of branches) {
                        const st = br.body.filter((x) => x.k === 'assign' && x.targets[0] === name);
                        if (isVar && st.length === 0)
                            throw new Unsupported('CV-PINE-VAR-STATE', `\`${name}\` is a var that keeps its previous value where a branch does not set it; this carries a value over from one candlestick to the next and is not converted.`);
                        for (const a of st)
                            this.stateGuard(name, a.op !== '=' && a.op !== ':=' ? { k: 'bin', op: a.op[0], l: { k: 'name', id: name, line: a.line }, r: a.value, line: a.line } : a.value);
                    }
                    if (isVar && !s.orelse)
                        throw new Unsupported('CV-PINE-VAR-STATE', `\`${name}\` is a var that keeps its previous value when no condition holds (the if block has no else); this carries a value over from one candlestick to the next and is not converted.`);
                }
                for (const name of assigned) {
                    let value = null;
                    for (let i = branches.length - 1; i >= 0; i--) {
                        const br = branches[i];
                        const st = br.body.filter((x) => x.k === 'assign' && x.targets[0] === name);
                        if (st.length > 1)
                            throw new Unsupported('CV-PINE-IF-ASSIGN', `\`${name}\` is set twice in one branch; this is not converted.`);
                        let v;
                        if (st.length === 1) {
                            const a = st[0];
                            if (this.st.scope.get(name)?.k === 'pendingVar')
                                throw new Unsupported('CV-PINE-VAR-STATE', `\`${name}\` carries a value over from one candlestick to the next; this form is not converted.`);
                            if (a.op !== '=' && a.op !== ':=') {
                                v = this.tx({ k: 'bin', op: a.op[0], l: { k: 'name', id: name, line: a.line }, r: a.value, line: a.line }, { line: a.line }).s;
                            }
                            else
                                v = this.tx(a.value, { line: a.line }).s;
                        }
                        else {
                            const prev = this.st.scope.get(name);
                            v = prev ? this.tx({ k: 'name', id: name, line: br.line }, { line: br.line }).s : 'na';
                        }
                        if (br.cond === null)
                            value = v;
                        else {
                            const c = this.tx(br.cond, { line: br.line }).s;
                            const otherwise = value ?? (this.st.scope.get(name) ? this.tx({ k: 'name', id: name, line }, { line }).s : 'na');
                            value = `(${v} if ${c} else ${otherwise})`;
                        }
                    }
                    this.bindNew(name, { s: value, ty: 'any' }, line);
                }
                if (branches.some((b) => b.cond !== null))
                    this.note('info', 'CV-PINE-IF-CHOICE', 'the if block that sets values became a choice per candlestick (a if condition else b). Where the condition is unknown (early candlesticks, gaps), the value is unknown here; Pine takes the else branch.', line, s.endLine);
            }
            catch (err) {
                this.failStatement(err, line, s.endLine, [...assigned]);
            }
            return;
        }
        this.note('unsupported', 'CV-PINE-IF-MIXED', 'this if block mixes outputs and other statements in a way the converter does not handle. It is left out.', line, s.endLine, this.srcText(line));
        for (const b of branches)
            for (const x of b.body)
                if (x.k === 'assign')
                    for (const t of x.targets)
                        this.st.scope.set(t, { k: 'dropped', line });
    }
    /**
     * `var x = ...` / `if cond: x := v` / `else: x := math.max(x, v)` (or nz(x), or math.min): the highest (lowest) v since cond was
     * last true, which is ta.highest_since(cond, v). Approximate only before the first time cond holds and around a missing condition.
     */
    runningExtreme(name, branches, s) {
        if (!this.varNames.has(name) || branches.length !== 2 || branches[0].cond === null || branches[1].cond !== null)
            return false;
        const one = (b) => {
            const st = b.filter((x) => x.k === 'assign');
            return st.length === 1 && st[0].op === ':=' ? st[0].value : null;
        };
        const v = one(branches[0].body);
        const m = one(branches[1].body);
        if (!v || !m || this.readsName(v, name))
            return false;
        if (m.k !== 'call' || !m.fn || m.args.length !== 2 || m.args.some((a) => a.name))
            return false;
        const fn = this.alias(m.fn);
        if (fn !== 'math.max' && fn !== 'math.min')
            return false;
        const isSelf = (x) => (x.k === 'name' && x.id === name) || (x.k === 'call' && x.fn === 'nz' && x.args.length === 1 && x.args[0].value.k === 'name' && x.args[0].value.id === name);
        const [p, q] = m.args.map((a) => a.value);
        const other = isSelf(p) ? q : isSelf(q) ? p : null;
        if (!other || this.readsName(other, name) || this.srcExpr(other) !== this.srcExpr(v))
            return false;
        const line = s.line;
        try {
            const c = this.tx(branches[0].cond, { line });
            const x = this.tx(v, { line });
            const f = fn === 'math.max' ? 'ta.highest_since' : 'ta.lowest_since';
            this.bindNew(name, { s: this.callCs(f, [c, x]), ty: 'num' }, line);
            this.note('approx', 'CV-PINE-VAR-EXTREME', `\`var ${name}\` set to ${this.srcExpr(v)} when the condition holds and to the ${fn === 'math.max' ? 'higher' : 'lower'} of itself and ${this.srcExpr(v)} otherwise is ${f}(cond, ${this.srcExpr(v)}): the same numbers once the condition has held. Before the first time it holds this gives unknown, where Pine keeps the ${fn === 'math.max' ? 'highest' : 'lowest'} value since the first candlestick${isSelf(p) && p.k === 'call' || isSelf(q) && q.k === 'call' ? ' (with nz, measured against 0)' : ''}; after a candlestick where the condition is unknown it gives unknown until the condition holds again, where Pine carries on.`, line, s.endLine);
        }
        catch (err) {
            this.failStatement(err, line, s.endLine, [name]);
        }
        return true;
    }
    /** The condition of an `if` around outputs. `strategy.position_size == 0` in an and-chain is dropped (no pyramiding here). */
    guardCond(c, line) {
        const parts = [];
        const flat = (x) => {
            if (x.k === 'bin' && x.op === 'and') {
                flat(x.l);
                flat(x.r);
            }
            else
                parts.push(x);
        };
        flat(c);
        const kept = parts.filter((p) => {
            const isFlat = p.k === 'bin' &&
                (p.op === '==' || p.op === '<=') &&
                p.l.k === 'name' &&
                p.l.id === 'strategy.position_size' &&
                p.r.k === 'num' &&
                p.r.v === 0;
            if (isFlat)
                this.note('info', 'CV-PINE-POSITION-SIZE', '`strategy.position_size == 0` is left out: a stock already held is not bought again here (no pyramiding), as in Pine\'s default.', line);
            return !isFlat;
        });
        if (!kept.length)
            return 'True';
        return kept.map((p) => this.tx(p, { line }).s).join(' and ');
    }
    mentions(e, id) {
        return this.readsName(e, id);
    }
    /** `if barstate.islast` blocks draw on the latest candlestick only: drawing objects are not available. */
    lastBarBlock(s) {
        const lines = new Set(lineRange(s.line, s.endLine));
        let approxPlot = false;
        for (const x of s.body) {
            if (x.k === 'assign' && x.value.k === 'call' && x.value.fn === 'line.new') {
                const m = this.argsOf(x.value.args, ['x1', 'y1', 'x2', 'y2']);
                const y1 = m.get('y1');
                const y2 = m.get('y2');
                if (y1 && y2 && this.srcExpr(y1) === this.srcExpr(y2)) {
                    try {
                        const y = this.tx(y1, { line: x.line });
                        const handle = x.targets[0];
                        const declLine = this.st.scope.get(handle)?.k === 'dropped' ? this.st.scope.get(handle).line : x.line;
                        lines.add(declLine);
                        const colorArg = x.value.args.find((q) => q.name === 'color');
                        const color = colorArg ? this.colorOf(colorArg.value, { line: x.line }) : null;
                        if (this.st.target === 'indicator') {
                            const label = this.uniqueLabel(humanize(handle));
                            this.emitOutput(`plot(${y.s}, ${csString(label)}${color && color !== 'na' ? `, color=${color}` : ''}, style="step")`, x.line);
                        }
                        approxPlot = true;
                    }
                    catch {
                        /* the note below covers it */
                    }
                }
            }
        }
        const ls = [...lines].sort((p, q) => p - q);
        const varLines = this.drawingVarLines(s);
        const all = [...new Set([...varLines, ...ls])].sort((p, q) => p - q);
        this.st.notes.push({
            line: all[0],
            endLine: all[all.length - 1],
            lines: all,
            level: 'unsupported',
            code: 'CV-PINE-LAST-BAR-DRAWING',
            message: approxPlot
                ? 'line.new / line.delete draw on the latest candlestick only; drawing objects are not part of the language. The level is plotted as a step line over every candlestick instead, which shows more than Pine did.'
                : 'drawing on the latest candlestick only (if barstate.islast) is not available; drawing objects are not part of the language. The block is left out.',
            original: this.srcText(s.line),
        });
    }
    drawingVars = new Map();
    drawingVarLines(s) {
        const out = [];
        for (const [name, line] of this.drawingVars) {
            if (this.blockReads(s.body, name)) {
                out.push(line);
                this.drawingVars.delete(name);
            }
        }
        return out;
    }
    blockReads(ss, name) {
        return ss.some((x) => (x.k === 'expr' && this.readsName(x.e, name)) || (x.k === 'assign' && (x.targets.includes(name) || this.readsName(x.value, name))));
    }
    forStatement(s) {
        const line = s.line;
        const assigned = s.body.filter((x) => x.k === 'assign').flatMap((x) => x.targets);
        const fail = (msg) => {
            for (const t of assigned)
                this.st.scope.set(t, { k: 'dropped', line });
            this.note('unsupported', 'CV-PINE-FOR', `${msg} It is left out, with what it sets.`, line, s.endLine, this.srcText(line, s.endLine));
        };
        if (s.body.length !== 1 || s.body[0].k !== 'assign' || s.by !== null) {
            fail('a `for` loop is converted only when it adds up, counts or finds the largest of the last n values.');
            return;
        }
        const a = s.body[0];
        const acc = a.targets[0];
        const from0 = s.from.k === 'num' && s.from.v === 0;
        // to = n - 1
        const toN = s.to.k === 'bin' && s.to.op === '-' && s.to.r.k === 'num' && s.to.r.v === 1 ? s.to.l : null;
        let addend = null;
        if (a.op === '+=')
            addend = a.value;
        else if (a.op === ':=' && a.value.k === 'bin' && a.value.op === '+' && a.value.l.k === 'name' && a.value.l.id === acc)
            addend = a.value.r;
        const prev = this.st.scope.get(acc);
        const initZero = prev && prev.k === 'value' && prev.pine && prev.pine.k === 'num' && prev.pine.v === 0;
        if (!from0 || !toN || !addend || !initZero || addend.k !== 'index' || addend.i.k !== 'name' || addend.i.id !== s.v || this.readsName(addend.x, s.v)) {
            fail('a `for` loop is converted only when it adds up, counts or finds the largest of the last n values.');
            return;
        }
        try {
            const x = this.tx(addend.x, { line: a.line }).s;
            const n = this.tx(toN, { line }).s;
            const bind = { k: 'sum', x, n, line };
            this.st.scope.set(acc, bind);
            this.note('approx', 'CV-PINE-FOR-SUM', `the loop \`for ${s.v} = 0 to ${this.srcExpr(toN)} - 1: ${acc} += ${this.srcExpr(addend)}\` is the sum of the last ${this.srcExpr(toN)} values; ${acc} / ${this.srcExpr(toN)} is ta.sma(${x}, ${n}). The last decimal places can differ (the numbers are added in another order).`, prev.line ?? line, s.endLine);
            bind.note = this.st.notes[this.st.notes.length - 1];
        }
        catch (err) {
            this.failStatement(err, line, s.endLine, assigned);
        }
    }
    // ---- outputs -------------------------------------------------------------------------------------------------------------
    uniqueLabel(label) {
        let l = label.slice(0, 60) || 'Plot';
        let i = 2;
        const root = l;
        while (this.st.plotLabels.has(l))
            l = `${root} ${i++}`;
        this.st.plotLabels.add(l);
        return l;
    }
    plot(e, line, guard, handle) {
        const order = ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display'];
        const m = this.argsOf(e.args, order);
        const series = m.get('series');
        if (!series)
            throw new Unsupported('CV-PINE-ARGS', 'plot needs a value.');
        const disp = m.get('display');
        const target = this.st.target;
        if (handle)
            this.st.scope.set(handle, { k: 'plot', series: null, line });
        if (disp && disp.k === 'name' && disp.id === 'display.none') {
            if (target === 'indicator')
                this.note('info', 'CV-PINE-PLOT-HIDDEN', 'a plot with display=display.none is not drawn here either; its value is kept where it is used.', line);
            return;
        }
        if (target === 'strategy') {
            this.note('info', 'CV-PINE-STRATEGY-PLOTS', 'plots are left out; a strategy does not draw. Convert as an indicator to see the lines.', line);
            return;
        }
        if (target === 'alert')
            return;
        let v = this.tx(series, { line });
        const titleE = m.get('title');
        const rawTitle = titleE && titleE.k === 'str' ? titleE.v : series.k === 'name' ? series.id : `Plot ${this.st.plotCount + 1}`;
        this.st.plotCount++;
        if (guard)
            v = { s: `(${v.s} if ${guard} else na)`, ty: v.ty };
        if (target === 'screener') {
            if (v.ty === 'bool')
                this.st.matchConds.push({ cond: v.s, line, from: 'plot' });
            else
                this.st.shows.push({ s: v.s, label: rawTitle.slice(0, 60), line });
            return;
        }
        let seriesText = v.s;
        if (handle && this.st.fillHandles.has(handle) && !/^[A-Za-z_]\w*$/.test(seriesText)) {
            const nm = this.fresh(snake(rawTitle.replace(/[^A-Za-z0-9]+/g, '_')).replace(/^_+|_+$/g, '') || 'line');
            this.emitAssign(nm, seriesText, line);
            seriesText = nm;
        }
        if (handle)
            this.st.scope.set(handle, { k: 'plot', series: /^[A-Za-z_]\w*$/.test(seriesText) ? seriesText : null, line });
        const label = this.uniqueLabel(rawTitle);
        const args = [seriesText, csString(label)];
        for (const a of e.args) {
            const key = a.name ?? order[e.args.filter((x) => !x.name).indexOf(a)];
            if (!key || key === 'series' || key === 'title' || key === 'display')
                continue;
            switch (key) {
                case 'color': {
                    const c = this.colorOf(a.value, { line });
                    if (c !== 'na')
                        args.push(`color=${c}`);
                    break;
                }
                case 'linewidth': {
                    if (a.value.k !== 'num')
                        break;
                    const w = Math.max(1, Math.min(4, Math.round(a.value.v)));
                    if (w !== a.value.v)
                        this.note('info', 'CV-PINE-LINEWIDTH', `linewidth=${a.value.raw} is drawn ${w} pixels wide (1 to 4 here).`, line);
                    if (w !== 1 || a.value.v === 1)
                        args.push(`linewidth=${w}`);
                    break;
                }
                case 'style': {
                    if (a.value.k !== 'name')
                        break;
                    const st = PLOT_STYLES[a.value.id];
                    if (!st) {
                        this.note('info', 'CV-PINE-PLOT-STYLE', `${a.value.id} is drawn as a line.`, line);
                        break;
                    }
                    if (st.note)
                        this.note('info', 'CV-PINE-PLOT-STYLE', st.note, line);
                    if (st.style)
                        args.push(`style=${csString(st.style)}`);
                    break;
                }
                case 'offset': {
                    const o = a.value.k === 'num' ? a.value.v : a.value.k === 'un' && a.value.op === '-' ? -1 : NaN;
                    if (o > 0)
                        args.push(`offset=${Math.min(500, Math.round(o))}`);
                    else if (o < 0 || Number.isNaN(o))
                        this.note('info', 'CV-PINE-PLOT-OFFSET', 'a negative or changing plot offset is refused here (E-PLOT-OFFSET): it would draw a value before it was known. The offset is left out.', line);
                    break;
                }
                default:
                    this.note('info', 'CV-PINE-PLOT-IGNORED', `${key}= is not carried over.`, line);
            }
        }
        this.emitOutput(`plot(${args.join(', ')})`, line);
    }
    hline(e, line, handle) {
        const m = this.argsOf(e.args, ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display']);
        const price = m.get('price');
        if (!price)
            throw new Unsupported('CV-PINE-ARGS', 'hline needs a price.');
        if (handle)
            this.st.scope.set(handle, { k: 'plot', series: null, line });
        if (this.st.target !== 'indicator')
            return;
        const p = this.tx(price, { line });
        const titleE = m.get('title');
        let title;
        if (titleE && titleE.k === 'str')
            title = titleE.v;
        else {
            title = `Level ${this.srcExpr(price)}`;
            if (!this.st.notes.some((n) => n.code === 'CV-PINE-HLINE-UNTITLED' && n.line === line))
                this.note('info', 'CV-PINE-HLINE-UNTITLED', 'untitled hline levels are named by their value.', line);
        }
        const colorE = m.get('color');
        const color = colorE ? this.colorOf(colorE, { line }) : null;
        let series = p.s;
        if (handle && this.st.fillHandles.has(handle) && /^[A-Za-z_]\w*$/.test(p.s)) {
            // already a name (a setting or a value): fill can name it as it is
            this.st.scope.set(handle, { k: 'plot', series: p.s, line });
        }
        else if (handle && this.st.fillHandles.has(handle)) {
            const nm = this.fresh(snake(title.replace(/[^A-Za-z0-9]+/g, '_')).replace(/^_+|_+$/g, '') || 'level');
            const at = this.st.hlineRunStart ?? this.st.lines.length;
            this.st.lines.splice(at, 0, { text: `${nm} = ${p.s}`, src: line, defines: nm });
            this.st.hlineRunStart = at + 1;
            series = nm;
            this.st.scope.set(handle, { k: 'plot', series: nm, line });
            this.note('info', 'CV-PINE-HLINE-NAMED', 'hline levels are plotted as flat lines with names, so fill can name them.', line);
        }
        else if (this.st.hlineRunStart === null) {
            this.st.hlineRunStart = this.st.lines.length;
        }
        const label = this.uniqueLabel(title);
        this.emitOutput(`plot(${series}, ${csString(label)}${color && color !== 'na' ? `, color=${color}` : ''})`, line);
    }
    markParts(m, fn, line) {
        let shape = 'diamond';
        if (fn === 'plotchar')
            shape = 'dot';
        const st = m.get('style');
        if (fn === 'plotshape') {
            const id = st && st.k === 'name' ? st.id : 'shape.xcross';
            const sh = SHAPES[id];
            if (!sh)
                this.note('info', 'CV-PINE-SHAPE', `${id} is drawn as a diamond.`, line);
            else {
                shape = sh.shape;
                if (sh.note)
                    this.note('info', 'CV-PINE-SHAPE', `${id.replace('shape.', 'shape.')} is drawn as a ${sh.shape === 'diamond' ? 'diamond' : 'triangle'}.`, line);
            }
        }
        const loc = m.get('location');
        const lid = loc && loc.k === 'name' ? loc.id : 'location.abovebar';
        const lc = LOCATIONS[lid];
        const where = lc ? lc.where : 'above';
        if (!lc || lc.note)
            this.note('info', 'CV-PINE-LOCATION', `${lid} has no equal here; the marker is drawn ${where} the candlestick.`, line);
        const ce = m.get('color');
        const color = ce ? this.colorOf(ce, { line }) : null;
        let text = null;
        const te = fn === 'plotchar' ? (m.get('char') ?? m.get('text')) : m.get('text');
        if (te && te.k === 'str' && te.v.trim()) {
            text = te.v.replace(/\n/g, ' ').trim();
            if (text.length > 12) {
                this.note('info', 'CV-PINE-MARK-TEXT', `the marker text "${text}" is cut to 12 characters.`, line);
                text = text.slice(0, 12).trim();
            }
        }
        for (const k of ['size', 'textcolor', 'show_last', 'editable', 'force_overlay']) {
            const x = m.get(k);
            if (x)
                this.note('info', 'CV-PINE-MARK-IGNORED', `${k}=${this.srcExpr(x)} is not carried over.`, line);
        }
        const off = m.get('offset');
        if (off) {
            this.note('info', 'CV-PINE-MARK-OFFSET', `the markers are drawn on the candlestick where the condition is known. offset=${this.srcExpr(off)} would draw them elsewhere; a marker has no offset here, and a negative one is refused (E-PLOT-OFFSET) because it would show a value before it was known.`, line);
        }
        return { shape, where, color, text };
    }
    condOf(series, line) {
        const v = this.tx(series, { line });
        if (v.ty === 'bool')
            return v.s;
        this.note('info', 'CV-PINE-SERIES-AS-COND', `${this.srcExpr(series)} as a condition marks where it has a value; that is written as not is_na(${this.srcExpr(series)}).`, line);
        return `(not is_na(${v.s}))`;
    }
    plotshape(e, fn, line, guard) {
        const order = fn === 'plotshape'
            ? ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display']
            : ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display'];
        const m = this.argsOf(e.args, order);
        const series = m.get('series');
        if (!series)
            throw new Unsupported('CV-PINE-ARGS', `${fn} needs a condition.`);
        const target = this.st.target;
        if (target === 'alert')
            return;
        if (target === 'strategy') {
            this.note('info', 'CV-PINE-STRATEGY-PLOTS', 'plots are left out; a strategy does not draw. Convert as an indicator to see the lines.', line);
            return;
        }
        let cond = this.condOf(series, line);
        if (guard)
            cond = cond === 'True' ? guard : `(${guard} and ${cond})`;
        if (target === 'screener') {
            this.st.matchConds.push({ cond, line, from: 'mark' });
            return;
        }
        const p = this.markParts(m, fn, line);
        if (fn === 'plotchar')
            this.note('info', 'CV-PINE-PLOTCHAR', 'plotchar is drawn as a dot with the character as its text.', line);
        this.emitMark(cond, p, line);
    }
    emitMark(cond, p, line) {
        const args = [cond, `shape=${csString(p.shape)}`, `where=${csString(p.where)}`];
        if (p.color && p.color !== 'na')
            args.push(`color=${p.color}`);
        if (p.text)
            args.push(`text=${csString(p.text)}`);
        this.emitOutput(`mark(${args.join(', ')})`, line);
    }
    plotarrow(e, line, guard) {
        const series = e.args[0]?.value;
        if (!series)
            throw new Unsupported('CV-PINE-ARGS', 'plotarrow needs a value.');
        if (this.st.target !== 'indicator')
            return;
        const v = this.tx(series, { line }).s;
        const g = (c) => (guard ? `(${guard} and ${c})` : c);
        this.emitMark(g(`(${v} > 0)`), { shape: 'triangle_up', where: 'below', color: 'color.up', text: null }, line);
        this.emitMark(g(`(${v} < 0)`), { shape: 'triangle_down', where: 'above', color: 'color.down', text: null }, line);
        this.note('approx', 'CV-PINE-PLOTARROW', 'plotarrow is drawn as two markers (up where the value is above 0, down where it is below); the arrow length is not shown.', line);
    }
    bgcolor(e, fn, line, guard) {
        const target = this.st.target;
        if (target !== 'indicator') {
            if (target === 'strategy')
                this.note('info', 'CV-PINE-STRATEGY-PLOTS', 'plots are left out; a strategy does not draw. Convert as an indicator to see the lines.', line);
            return;
        }
        const ce = this.argsOf(e.args, ['color']).get('color');
        if (!ce)
            throw new Unsupported('CV-PINE-ARGS', `${fn} needs a colour.`);
        const pairs = [];
        const g = (c) => (guard ? `(${guard} and ${c})` : c);
        if (ce.k === 'tern') {
            const c = this.tx(ce.c, { line }).s;
            const a = ce.a.k === 'na' ? null : this.colorOf(ce.a, { line });
            const b = ce.b.k === 'na' ? null : this.colorOf(ce.b, { line });
            if (a && a !== 'na')
                pairs.push({ cond: g(c), color: a });
            if (b && b !== 'na')
                pairs.push({ cond: g(`(not ${c})`), color: b });
            if (a && b && a !== 'na' && b !== 'na')
                this.note('info', 'CV-PINE-BGCOLOR-TWO', `one ${fn} with two colours became two lines. Where the condition is unknown (early candlesticks) neither is drawn; Pine draws the second colour.`, line);
        }
        else {
            const c = this.colorOf(ce, { line });
            if (c !== 'na')
                pairs.push({ cond: guard ?? 'True', color: c });
        }
        for (const p of pairs) {
            if (fn === 'barcolor')
                this.emitMark(p.cond, { shape: 'dot', where: 'above', color: p.color, text: null }, line);
            else
                this.emitOutput(`bgcolor(${p.cond}, color=${p.color})`, line);
        }
        if (fn === 'barcolor')
            this.note('approx', 'CV-PINE-BARCOLOR', 'barcolor (colouring the candlestick) is not available; it is drawn as a marker on the candlestick.', line);
    }
    fill(e, line) {
        const target = this.st.target;
        if (target !== 'indicator')
            return;
        const m = this.argsOf(e.args, ['hline1', 'hline2', 'color', 'title', 'editable', 'fillgaps', 'display']);
        const side = (x) => {
            if (!x || x.k !== 'name')
                throw new Unsupported('CV-PINE-FILL', 'fill is converted only between two named plots or hlines.');
            const b = this.st.scope.get(x.id);
            if (b && b.k === 'dropped')
                throw new Dropped(x.id);
            if (!b || b.k !== 'plot' || !b.series)
                throw new Unsupported('CV-PINE-FILL', `fill: \`${x.id}\` is not a plot that could be named here.`);
            return { name: b.series, line: b.line };
        };
        const a = side(m.get('hline1'));
        const b = side(m.get('hline2'));
        const ce = m.get('color');
        const color = ce ? this.colorOf(ce, { line }) : null;
        const h1 = m.get('hline1').id;
        const h2 = m.get('hline2').id;
        this.note('info', 'CV-PINE-FILL-NAMES', `fill(${h1}, ${h2}) names the plotted lines here, not plot handles: fill(${a.name}, ${b.name}).`, Math.min(a.line, b.line), line);
        this.emitOutput(`fill(${a.name}, ${b.name}${color && color !== 'na' ? `, color=${color}` : ''})`, line);
    }
    alertMessage(msg, line) {
        const fields = { ticker: '{symbol}', tickerid: '{symbol}', close: '{close}', interval: '{interval}', time: '{time}' };
        const dropped = [];
        let out = msg.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_all, key) => {
            const k = key.toLowerCase();
            if (fields[k])
                return fields[k];
            dropped.push(`{{${key}}}`);
            return '';
        });
        out = out.replace(/\s{2,}/g, ' ').trim();
        if (dropped.length)
            this.note('info', 'CV-PINE-ALERT-PLACEHOLDER', `${dropped.join(', ')} ${dropped.length > 1 ? 'have' : 'has'} no equal in an alert message here and ${dropped.length > 1 ? 'are' : 'is'} left out of the text ({symbol}, {close}, {interval} and {time} are available).`, line);
        if (/\{\{/.test(msg) && !dropped.length && this.st.target === 'alert')
            this.note('info', 'CV-PINE-ALERT-FIELDS', 'Pine placeholders are written {symbol}, {close}, {interval} and {time} here. An alert fires once, on the closed candlestick where the condition turns true.', line);
        if (out.length > 120) {
            out = out.slice(0, 120).replace(/\s+\S*$/, '');
            this.note('info', 'CV-PINE-ALERT-LONG', 'the alert message is cut to 120 characters.', line);
        }
        return out || 'Alert';
    }
    alertcondition(e, line, guard) {
        const m = this.argsOf(e.args, ['condition', 'title', 'message']);
        const c = m.get('condition');
        if (!c)
            throw new Unsupported('CV-PINE-ARGS', 'alertcondition needs a condition.');
        const target = this.st.target;
        if (target === 'indicator') {
            this.note('info', 'CV-PINE-ALERT-COMPANION', 'alertcondition moved to the companion alert script; an indicator here draws, an alert script raises alerts.', line);
            return;
        }
        if (target === 'strategy') {
            this.note('info', 'CV-PINE-STRATEGY-ALERTS', 'alertcondition is left out of the strategy; convert as an alert to raise it.', line);
            return;
        }
        let cond = this.tx(c, { line }).s;
        if (guard)
            cond = `(${guard} and ${cond})`;
        if (target === 'screener') {
            this.st.matchConds.push({ cond, line, from: 'alert' });
            return;
        }
        const msgE = m.get('message') ?? m.get('title');
        const msg = (msgE ? this.messageText(msgE) : null) ?? 'Alert';
        this.st.alertConds.push({ cond, msg, line });
        this.emitOutput(`alert(${cond}, ${csString(this.alertMessage(msg, line))})`, line);
    }
    alertCall(e, line, guard) {
        const m = this.argsOf(e.args, ['message', 'freq']);
        const target = this.st.target;
        if (target === 'indicator') {
            this.note('info', 'CV-PINE-ALERT-COMPANION', 'alert() moved to the companion alert script; an indicator here draws, an alert script raises alerts.', line);
            return;
        }
        if (target !== 'alert')
            return;
        if (!guard)
            throw new Unsupported('CV-PINE-ALERT-ALWAYS', 'alert() outside an if would fire on every candlestick; it is converted only inside `if condition`.');
        const msgE = m.get('message');
        const text = msgE ? this.messageText(msgE) : null;
        if (text === null)
            throw new Unsupported('CV-PINE-ALERT-MESSAGE', 'an alert message built from values is converted only from texts, the symbol, the close and the candlestick size; write it as a text with {symbol} or {close}.');
        const freq = m.get('freq');
        if (freq && freq.k === 'name' && freq.id !== 'alert.freq_once_per_bar_close')
            this.note('info', 'CV-PINE-ALERT-FREQ', `${freq.id}: an alert here fires once, on the closed candlestick where the condition turns true.`, line);
        this.emitOutput(`alert(${guard}, ${csString(this.alertMessage(text, line))})`, line);
    }
    /** An alert message joined with +: texts, the symbol, the close and the candlestick size become {placeholders}. */
    messageText(e) {
        const parts = [];
        const flat = (x) => {
            if (x.k === 'bin' && x.op === '+') {
                flat(x.l);
                flat(x.r);
            }
            else
                parts.push(x);
        };
        flat(e);
        let out = '';
        for (const p of parts) {
            const q = p.k === 'call' && (p.fn === 'str.tostring' || p.fn === 'tostring') && p.args[0] ? p.args[0].value : p;
            if (q.k === 'str')
                out += q.v;
            else if (q.k === 'name' && (q.id === 'syminfo.ticker' || q.id === 'syminfo.tickerid'))
                out += '{{ticker}}';
            else if (q.k === 'name' && q.id === 'close')
                out += '{{close}}';
            else if (q.k === 'name' && q.id === 'timeframe.period')
                out += '{{interval}}';
            else
                return null;
        }
        return out;
    }
    labelNew(e, line, guard) {
        const m = this.argsOf(e.args, ['x', 'y', 'text', 'xloc', 'yloc', 'color', 'style', 'textcolor', 'size']);
        if (!guard)
            throw new Unsupported('CV-PINE-DRAWING', 'label.new outside an if: drawing objects are not part of the language.');
        const t = m.get('text');
        if (!t || t.k !== 'str')
            throw new Unsupported('CV-PINE-DRAWING', 'label.new with a text built from values is not converted (texts here are written out).');
        if (this.st.target !== 'indicator')
            return;
        const st = m.get('style');
        const down = st && st.k === 'name' && /down/.test(st.id);
        const ce = m.get('color');
        const color = ce ? this.colorOf(ce, { line }) : null;
        let text = t.v.replace(/\n/g, ' ').trim();
        if (text.length > 12)
            text = text.slice(0, 12).trim();
        this.emitMark(guard, { shape: down ? 'triangle_down' : 'triangle_up', where: down ? 'above' : 'below', color, text }, line);
        this.note('approx', 'CV-PINE-LABEL-MARK', 'label.new with text becomes a marker with the same text.', line);
    }
    tableCell(e, line) {
        const m = this.argsOf(e.args, ['table_id', 'column', 'row', 'text']);
        const t = m.get('text');
        const lines = [...this.tableLines, line];
        // the number the cell shows: "words: " + str.tostring(x) + "%"
        let shown = null;
        if (t) {
            const parts = [];
            const flat = (x) => {
                if (x.k === 'bin' && x.op === '+') {
                    flat(x.l);
                    flat(x.r);
                }
                else
                    parts.push(x);
            };
            flat(t);
            const nums = parts.filter((p) => p.k === 'call' && p.fn === 'str.tostring');
            if (nums.length === 1) {
                const x = nums[0].args[0]?.value;
                const words = parts
                    .filter((p) => p.k === 'str')
                    .map((p) => p.v.replace(/[:=]/g, ' ').trim())
                    .filter(Boolean)
                    .join(' ')
                    .replace(/\s+/g, ' ');
                if (x) {
                    try {
                        shown = { name: this.tx(x, { line }).s, label: words || this.srcExpr(x) };
                    }
                    catch {
                        shown = null;
                    }
                }
            }
        }
        const ls = [...new Set(lines)].sort((p, q) => p - q);
        if (this.st.target === 'screener' && shown) {
            this.st.shows.push({ s: shown.name, label: shown.label.slice(0, 60), line });
            this.st.notes.push({ line: ls[0], endLine: ls[ls.length - 1], lines: ls, level: 'unsupported', code: 'CV-PINE-TABLE', message: `the table is left out; its number is the "${shown.label}" column.` });
            return;
        }
        this.st.notes.push({
            line: ls[0],
            endLine: ls[ls.length - 1],
            lines: ls,
            level: 'unsupported',
            code: 'CV-PINE-TABLE',
            message: `tables are not part of the language, so the table is left out.${shown ? ` Its number (${shown.name}) can be shown with plot(${shown.name}, ...) in a pane of its own, or as a column with the Screener choice.` : ''}`,
            original: this.srcText(line),
        });
    }
    // ---- strategy ------------------------------------------------------------------------------------------------------------
    strategyEntry(e, fn, line, guard) {
        const m = this.argsOf(e.args, ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert', 'when']);
        const dir = m.get('direction');
        if (dir && dir.k === 'name' && dir.id === 'strategy.short') {
            if (this.st.target !== 'strategy')
                return;
            this.note('unsupported', 'CV-PINE-SHORT', 'short entries are not available: a strategy here buys and sells, it does not sell short. The short side is left out; because a Pine short entry also closes an open long, its condition is added to strategy.exit.', line, line, this.srcText(line));
            const when = m.get('when');
            const parts = [guard, when ? this.tx(when, { line }).s : null].filter((x) => !!x);
            if (!this.st.exits.length)
                this.st.lines.push({ text: '', src: line, output: true, placeholder: 'exit' });
            this.st.exits.push({ cond: parts.length ? parts.join(' and ') : 'True', line });
            return;
        }
        if (this.st.target === 'indicator' || this.st.target === 'alert')
            return;
        for (const k of ['qty', 'limit', 'stop'])
            if (m.get(k))
                this.note('approx', 'CV-PINE-ENTRY-ARGS', `${k}= on the entry is not carried over: entries fill at the next open with the strategy's sizing.`, line);
        const when = m.get('when');
        const parts = [guard, when ? this.tx(when, { line }).s : null].filter((x) => !!x);
        const cond = parts.length ? parts.join(' and ') : 'True';
        if (this.st.target === 'screener') {
            this.st.matchConds.push({ cond, line, from: 'alert' });
            return;
        }
        if (!this.st.entries.length)
            this.st.lines.push({ text: '', src: line, output: true, placeholder: 'entry' });
        this.st.entries.push({ cond, line });
        void fn;
    }
    strategyClose(e, line, guard) {
        if (this.st.target !== 'strategy')
            return;
        const m = this.argsOf(e.args, ['id', 'when']);
        const when = m.get('when');
        const parts = [guard, when ? this.tx(when, { line }).s : null].filter((x) => !!x);
        const cond = parts.length ? parts.join(' and ') : 'True';
        if (!this.st.exits.length)
            this.st.lines.push({ text: '', src: line, output: true, placeholder: 'exit' });
        this.st.exits.push({ cond, line });
        if (!this.st.notes.some((n) => n.code === 'CV-PINE-STRATEGY-FILL-NEXT')) {
            const ls = [...new Set([...this.st.entries.map((x) => x.line), line])].sort((p, q) => p - q);
            this.st.notes.push({
                line: ls[0],
                ...(ls.length > 1 ? { endLine: ls[ls.length - 1], lines: ls } : {}),
                level: 'info',
                code: 'CV-PINE-STRATEGY-FILL-NEXT',
                message: "an entry decided on a candlestick's close fills at the next open, as Pine does by default.",
            });
        }
    }
    strategyExit(e, line, guard) {
        if (this.st.target !== 'strategy')
            return;
        const m = this.argsOf(e.args, ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points', 'trail_offset']);
        const ticks = ['profit', 'loss', 'trail_points', 'trail_offset', 'trail_price'].filter((k) => m.get(k));
        if (ticks.length) {
            this.note('unsupported', 'CV-PINE-EXIT-TICKS', `${ticks.map((k) => `${k}=`).join(', ')} ${ticks.length > 1 ? 'are' : 'is'} measured in ticks or price points, which a strategy here does not have; give a stop or target as a percent of the fill (strategy.stop_loss(pct=...), strategy.take_profit(pct=...), strategy.trail(pct=...)). Left out.`, line, line, this.srcText(line));
        }
        if (guard)
            this.note('approx', 'CV-PINE-EXIT-GUARD', 'the stop and target apply to every trade here; the condition around strategy.exit is not carried over.', line);
        const qp = m.get('qty_percent');
        const sizePct = qp && qp.k === 'num' && qp.v > 0 && qp.v < 100 ? qp.v : null;
        let approx = false;
        const pct = (x, side) => {
            // avg * (1 -/+ p / 100)
            const avg = (y) => y.k === 'name' && y.id === 'strategy.position_avg_price';
            const sign = side === 'stop' ? '-' : '+';
            if (x.k === 'bin' && x.op === '*' && (avg(x.l) || avg(x.r))) {
                const f = avg(x.l) ? x.r : x.l;
                if (f.k === 'bin' && f.op === sign && f.l.k === 'num' && f.l.v === 1) {
                    const p = f.r;
                    // a setting typed in percent and divided by 100 (V-5): the percent is the setting itself
                    const sc = p.k === 'name' ? this.scaled.get(p.id) : undefined;
                    if (sc && ((sc.op === '/' && sc.k === 100) || (sc.op === '*' && sc.k === 0.01)))
                        return sc.cs;
                    if (p.k === 'bin' && p.op === '/' && p.r.k === 'num' && p.r.v === 100)
                        return this.tx(p.l, { line }).s;
                    return `${this.tx(p, { line }).s} * 100`;
                }
            }
            if (x.k === 'bin' && x.op === sign && avg(x.l)) {
                approx = true;
                return `${this.tx(x.r, { line }).s} / close * 100`;
            }
            throw new Unsupported('CV-PINE-EXIT-PRICE', `a ${side === 'stop' ? 'stop' : 'target'} at ${this.srcExpr(x)} is converted only when it is a distance from strategy.position_avg_price.`);
        };
        const stop = m.get('stop');
        const limit = m.get('limit');
        const out = [];
        if (stop)
            out.push(`strategy.stop_loss(pct=${pct(stop, 'stop')})`);
        if (limit)
            out.push(`strategy.take_profit(pct=${pct(limit, 'limit')}${sizePct ? `, size_pct=${sizePct}` : ''})`);
        for (const o of out)
            this.emitOutput(o, line);
        if (approx) {
            this.note('approx', 'CV-PINE-EXIT-SERIES', 'Pine sets the stop and target from position_avg_price and moves them every candlestick as the values change. Here they are a percent of the fill price, read once on the signal candlestick (distance / close) and fixed for the trade. The distance is measured from the signal close, applied to the next open.', line);
        }
        else if (out.length) {
            this.note('info', 'CV-PINE-EXIT-PCT', "a stop and a limit at a percent of position_avg_price are strategy.stop_loss(pct=...) and strategy.take_profit(pct=...) of the fill price. When one candlestick touches both, the stop is taken here; Pine's broker emulator guesses the order from the candlestick's shape.", line);
        }
        // percent settings feeding pct
        for (const o of out) {
            const mm = /pct=([A-Za-z_]\w*)\)/.exec(o);
            const inp = mm ? this.st.inputs.find((x) => x.cs === mm[1]) : undefined;
            if (inp)
                inp.uses.push({ fn: o.startsWith('strategy.stop_loss') ? 'strategy.stop_loss' : 'strategy.take_profit', param: 'pct' });
        }
    }
    // ---- assembling ----------------------------------------------------------------------------------------------------------
    /** Setting ranges: intersect each setting's range with the arguments it is passed to (the checker proves ranges). */
    applyRanges() {
        for (const inp of this.st.inputs) {
            if (inp.type !== 'int' && inp.type !== 'float')
                continue;
            let lo;
            let hi;
            let forceExplicit = false;
            const why = [];
            for (const u of inp.uses) {
                let pmin;
                let pmax;
                if (u.fn === 'strategy.stop_loss' || u.fn === 'strategy.take_profit') {
                    pmin = 0.1;
                    pmax = 100;
                }
                else {
                    const spec = fnSpec(u.fn);
                    const p = spec?.params.find((x) => x.name === u.param);
                    if (!p)
                        continue;
                    if (p.arg.t === 'len') {
                        pmin = p.arg.min;
                        pmax = p.arg.max;
                    }
                    else if (p.arg.t === 'cnum') {
                        pmin = p.arg.min;
                        pmax = p.arg.max;
                    }
                    else
                        continue;
                }
                if (pmin !== undefined)
                    lo = lo === undefined ? pmin : Math.max(lo, pmin);
                if (pmax !== undefined)
                    hi = hi === undefined ? pmax : Math.min(hi, pmax);
                if (u.fn.startsWith('ind.') || u.fn.startsWith('strategy.'))
                    forceExplicit = true;
                why.push(u.fn);
            }
            if (lo === undefined && hi === undefined)
                continue;
            const curMin = inp.min !== undefined ? Number(inp.min) : inp.type === 'int' ? defaultIntRange(inp.defNum ?? 1).lo : undefined;
            const curMax = inp.max !== undefined ? Number(inp.max) : inp.type === 'int' ? defaultIntRange(inp.defNum ?? 1).hi : undefined;
            const inside = (curMin !== undefined && (lo === undefined || curMin >= lo)) && (curMax !== undefined && (hi === undefined || curMax <= hi));
            if (inside && !forceExplicit)
                continue;
            const newMin = lo === undefined ? curMin : curMin === undefined ? lo : Math.max(curMin, lo);
            const newMax = hi === undefined ? curMax : curMax === undefined ? hi : Math.min(curMax, hi);
            const fns = [...new Set(why)].join(', ');
            const raised = inp.min !== undefined && newMin !== undefined && newMin > Number(inp.min);
            const changed = String(newMin) !== inp.min || String(newMax) !== inp.max;
            if (!changed)
                continue;
            if (raised) {
                this.note('info', 'CV-PINE-INPUT-RANGE', `minval=${inp.min} was raised to min=${newMin}, because ${fns} needs at least ${newMin} here.`, inp.line);
            }
            else {
                this.note('info', 'CV-PINE-INPUT-RANGE', `min and max were added to the setting ${inp.pine} so it stays inside what ${fns} accepts (${newMin} to ${newMax}).`, inp.line);
            }
            if (newMin !== undefined)
                inp.min = String(newMin);
            if (newMax !== undefined)
                inp.max = String(newMax);
        }
    }
    inputText(i) {
        const parts = [i.def];
        if (i.min !== undefined)
            parts.push(`min=${i.min}`);
        if (i.max !== undefined)
            parts.push(`max=${i.max}`);
        if (i.options)
            parts.push(`options=[${i.options.map(csString).join(', ')}]`);
        if (i.title)
            parts.push(`title=${csString(i.title)}`);
        return `${i.cs}: ${i.type} = input(${parts.join(', ')})`;
    }
    /** Remove names that no output needs. Returns the source lines of statements removed. */
    deadCode() {
        const lines = this.st.lines;
        let changed = true;
        while (changed) {
            changed = false;
            const need = new Set();
            for (const l of lines)
                if (l.output || (!l.defines && !l.comment))
                    for (const r of refsOf(l.text))
                        need.add(r);
            for (let i = lines.length - 1; i >= 0; i--) {
                const l = lines[i];
                if (l.defines && need.has(l.defines))
                    for (const r of refsOf(l.text))
                        need.add(r);
            }
            for (let i = lines.length - 1; i >= 0; i--) {
                const l = lines[i];
                if (l.defines && !need.has(l.defines)) {
                    lines.splice(i, 1);
                    changed = true;
                }
            }
            this.neededNames = need;
        }
    }
    neededNames = new Set();
    assemble() {
        const st = this.st;
        const target = st.target;
        // strategy entries and exits
        for (const l of st.lines) {
            if (l.placeholder === 'entry') {
                const conds = st.entries.map((x) => x.cond);
                l.text = `strategy.entry(${conds.length === 1 ? conds[0] : conds.map((c) => `(${c})`).join(' or ')})`;
            }
            if (l.placeholder === 'exit') {
                const conds = st.exits.map((x) => x.cond);
                l.text = `strategy.exit(${conds.length === 1 ? conds[0] : conds.map((c) => `(${c})`).join(' or ')})`;
            }
        }
        let failed = false;
        if (target === 'screener') {
            const conds = st.matchConds;
            if (!conds.length) {
                failed = true;
                this.note('unsupported', 'CV-PINE-SCREENER-NO-CONDITION', 'there is no condition to screen for: no alertcondition, no plotshape and no true/false plot.', st.declLine || 1);
            }
            else {
                const pick = conds.find((c) => c.from === 'alert') ?? conds[0];
                if (conds.length > 1)
                    this.note('info', 'CV-PINE-SCREENER-PICK', `the screener matches on the condition from line ${pick.line}; the script had ${conds.length} conditions (marks or alerts). Change the return line to pick another.`, pick.line);
                for (const s of st.shows.slice(0, 8))
                    st.lines.push({ text: `show(${s.s}, ${csString(s.label)})`, src: s.line, output: true });
                st.lines.push({ text: `return ${pick.cond}`, src: pick.line, output: true });
            }
        }
        if (target === 'strategy' && !st.entries.length) {
            failed = true;
            this.note('unsupported', 'CV-PINE-STRATEGY-NO-ENTRY', 'there is no long entry to convert (strategy.entry with strategy.long).', st.declLine || 1);
        }
        if (target === 'alert' && !st.lines.some((l) => l.output)) {
            failed = true;
            this.note('unsupported', 'CV-PINE-ALERT-NONE', 'there is no alertcondition or alert() to convert.', st.declLine || 1);
        }
        if (target === 'indicator' && !st.lines.some((l) => l.output)) {
            failed = true;
            this.note('unsupported', 'CV-PINE-INDICATOR-NONE', 'nothing that draws could be converted.', st.declLine || 1);
        }
        this.deadCode();
        // settings no output uses
        const need = this.neededNames;
        st.inputs = st.inputs.filter((i) => {
            if (need.has(i.cs))
                return true;
            if (!st.notes.some((n) => n.line <= i.line && (n.endLine ?? n.line) >= i.line) && target === 'indicator')
                this.note('info', 'CV-PINE-INPUT-UNUSED', `the setting ${i.pine} is not used by anything that was converted, so it is left out.`, i.line);
            return false;
        });
        this.applyRanges();
        if (st.declKind === null)
            this.note('info', 'CV-PINE-NO-DECLARATION', 'there is no indicator() or strategy() line; the script is converted as an indicator.', 1);
        if (this.companion && !failed) {
            const kept = new Set([...st.lines.map((l) => l.src), ...st.inputs.map((i) => i.line)]);
            st.notes = st.notes.filter((n) => n.line === 0 || (n.lines ?? lineRange(n.line, n.endLine ?? n.line)).some((l) => kept.has(l)));
        }
        const title = st.title || 'Imported script';
        const fnName = slugOf(title);
        const out = [];
        const ver = this.file.version ?? 4;
        const kindWord = st.declKind === 'strategy' ? ' strategy' : '';
        const conf = st.notes.some((n) => n.level === 'unsupported') ? 'LOW' : st.notes.some((n) => n.level === 'approx') ? 'MEDIUM' : null;
        const head = target === 'screener'
            ? `# Converted from Pine Script v${ver}${kindWord} ${JSON.stringify(title)} as a screener (the "Screener" choice).`
            : target === 'alert' && this.naturalKind() !== 'alert'
                ? `# Converted from Pine Script v${ver} ${JSON.stringify(title)} (its alert lines).`
                : `# Converted from Pine Script v${ver}${kindWord} ${JSON.stringify(title)}.`;
        out.push({ text: conf ? `${head}  Confidence: ${conf}.` : head, src: 0 });
        for (const n of mergeNotes(st.notes)) {
            const word = n.level === 'unsupported' ? 'UNSUPPORTED' : n.level === 'approx' ? 'APPROXIMATE' : 'NOTE';
            const where = n.line > 0 ? ` line ${rangeText(n.lines ?? lineRange(n.line, n.endLine ?? n.line))}` : '';
            for (const [i, w] of wrap(`${word}${where}: ${n.message}`, 128).entries())
                out.push({ text: i === 0 ? `# ${w}` : `#   ${w}`, src: n.line });
            if (n.level === 'unsupported' && n.original)
                out.push({ text: `#   was: ${n.original.slice(0, 200)}`, src: n.line });
        }
        let deco;
        if (target === 'indicator') {
            const name = title.length > 40 ? title.slice(0, 40).trim() : title;
            if (title.length > 40)
                this.note('info', 'CV-PINE-NAME-LONG', 'the name is cut to 40 characters.', st.declLine || 1);
            deco = `@indicator(name=${csString(name)}, overlay=${st.overlay ? 'True' : 'False'}${st.benchmark ? `, benchmark=${csString(st.benchmark)}` : ''})`;
        }
        else if (target === 'alert') {
            deco = `@alert(name=${csString(title.slice(0, 40).trim())}${st.benchmark ? `, benchmark=${csString(st.benchmark)}` : ''})`;
        }
        else if (target === 'strategy') {
            const args = [...st.strategyArgs];
            if (st.benchmark)
                args.push(`benchmark=${csString(st.benchmark)}`);
            deco = `@strategy(${args.join(', ')})`;
        }
        else {
            deco = `@screener(${st.benchmark ? `benchmark=${csString(st.benchmark)}` : ''})`;
        }
        out.push({ text: deco, src: st.declLine });
        out.push({ text: `def ${fnName}(${st.inputs.map((i) => this.inputText(i)).join(', ')}):`, src: st.declLine });
        const body = st.lines.filter((l) => l.text);
        if (!body.some((l) => !l.comment))
            out.push({ text: '    pass', src: 0 });
        for (const l of body)
            out.push({ text: `    ${l.text}`, src: l.src });
        return {
            kind: target,
            text: out.map((x) => x.text).join('\n') + '\n',
            srcLines: out.map((x) => x.src),
            title,
            notes: mergeNotes(st.notes),
            companions: [],
            ...(failed ? { failed: true } : {}),
            ...(this.lostRisk.length ? { lostRisk: [...this.lostRisk] } : {}),
        };
    }
}
function humanize(name) {
    const s = snake(name).replace(/_/g, ' ').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : 'Level';
}
/** Notes with the same code and message become one note over all their lines. Order: first line, then unsupported first. */
export function mergeNotes(notes) {
    const byKey = new Map();
    const order = [];
    for (const n of notes) {
        const key = `${n.level}|${n.code}|${n.message}`;
        const ls = n.lines ?? lineRange(n.line, n.endLine ?? n.line);
        const have = byKey.get(key);
        if (have) {
            for (const l of ls)
                have.set.add(l);
            continue;
        }
        byKey.set(key, { ...n, set: new Set(ls) });
        order.push(key);
    }
    const out = [];
    for (const k of order) {
        const n = byKey.get(k);
        const ls = [...n.set].filter((x) => x > 0).sort((a, b) => a - b);
        const { set: _s, ...rest } = n;
        void _s;
        const r = { ...rest, line: ls[0] ?? 0 };
        delete r.endLine;
        delete r.lines;
        if (ls.length > 1) {
            r.endLine = ls[ls.length - 1];
            const contiguous = ls.every((x, i) => i === 0 || x === ls[i - 1] + 1);
            if (!contiguous)
                r.lines = ls;
        }
        out.push(r);
    }
    return out.sort((a, b) => a.line - b.line);
}
function rangeText(ls) {
    const parts = [];
    let i = 0;
    while (i < ls.length) {
        let j = i;
        while (j + 1 < ls.length && ls[j + 1] === ls[j] + 1)
            j++;
        parts.push(i === j ? `${ls[i]}` : `${ls[i]}-${ls[j]}`);
        i = j + 1;
    }
    return parts.join(', ');
}
function wrap(text, width) {
    const words = text.split(/\s+/);
    const out = [];
    let cur = '';
    for (const w of words) {
        if (cur && cur.length + 1 + w.length > width) {
            out.push(cur);
            cur = w;
        }
        else
            cur = cur ? `${cur} ${w}` : w;
    }
    if (cur)
        out.push(cur);
    return out;
}
/** Convert Pine Script text to a draft (not yet formatted or checked). */
export function convertPineDraft(source, kind) {
    const conv = new PineToChartist(source);
    const natural = conv.naturalKind();
    const target = kind ?? natural;
    const main = conv.run(target);
    if (!kind && natural === 'indicator' && conv.hasAlertConditions()) {
        const comp = new PineToChartist(source).run('alert', true);
        if (!comp.failed)
            main.companions.push({ kind: 'alert', text: comp.text });
        else {
            const why = comp.notes.filter((n) => n.level === 'unsupported');
            // V-6 (2026-10-25): "there is no alertcondition" was said when there is one whose condition uses a line left out; say that.
            const dep = why.find((n) => n.code === 'CV-PINE-DEPENDS-ON-DROPPED');
            const name = dep ? /uses `([^`]+)`/.exec(dep.message)?.[1] : undefined;
            const root = why.find((n) => n.code !== 'CV-PINE-DEPENDS-ON-DROPPED' && n.code !== 'CV-PINE-ALERT-NONE');
            const message = dep && name
                ? `the alert lines could not be made into a companion alert script: the alert's condition (line ${dep.line}) uses \`${name}\`, which was left out${root ? ` (line ${root.line}: ${root.message.replace(/\.$/, '')})` : ''}.`
                : `the alert lines could not be made into a companion alert script${why.length ? `: ${why[0].message}` : '.'}`;
            // the alert lines did not move anywhere, so the note saying they moved goes
            main.notes = main.notes.filter((n) => n.code !== 'CV-PINE-ALERT-COMPANION');
            const keep = main.text.split('\n').map((l) => !/^\s*# NOTE[^:]*: (alertcondition|alert\(\)) moved to the companion alert script/.test(l));
            main.text = main.text.split('\n').filter((_, i) => keep[i]).join('\n');
            main.srcLines = main.srcLines.filter((_, i) => keep[i]);
            main.notes.push({
                line: dep?.line ?? why[0]?.line ?? 0,
                level: 'unsupported',
                code: 'CV-PINE-ALERT-COMPANION-FAILED',
                message,
            });
        }
    }
    return main;
}
