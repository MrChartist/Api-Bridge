import { canonicalLegStrike, fnSpec, isPriceBlend, PRICE_BLENDS, TF_CODES, FRAME_FIELDS } from '../stdlib/manifest.js';
import { IrBuilder } from './builder.js';
import { META_KEYS, PARAM_KEYS } from './ir.js';
import { requiresOf } from './analysis.js';
/** A bug in the lowering or in the checker: a script the checker accepted could not be lowered. */
export class LoweringError extends Error {
    span;
    constructor(message, span) {
        super(message);
        this.span = span;
        this.name = 'LoweringError';
    }
}
const BIN = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '//': 'floordiv', '%': 'mod', '**': 'pow' };
const CMP = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne' };
const OHLCV = ['open', 'high', 'low', 'close', 'volume'];
const MAX_DEPTH = 64;
class Lowerer {
    checked;
    b;
    helpers = new Map();
    consts = new Map();
    outputs = [];
    /** Source line of each node of the finished program (0 when unknown). */
    lines = [];
    guards = [];
    depth = 0;
    constructor(hash, checked) {
        this.checked = checked;
        this.b = new IrBuilder(hash);
    }
    // ---- values
    fail(message, span) {
        throw new LoweringError(message, span);
    }
    ref(v, span) {
        if (!v || v.k !== 'ref')
            return this.fail('expected a single value', span);
        return v.ref;
    }
    selectVal(test, a, b) {
        if (a.k === 'ref' && b.k === 'ref')
            return { k: 'ref', ref: this.b.select(test, a.ref, b.ref) };
        if (a.k === 'rec' && b.k === 'rec') {
            const fields = {};
            for (const name of Object.keys(a.fields)) {
                if (!Object.hasOwn(b.fields, name))
                    return this.fail('groups of different shape');
                fields[name] = this.b.select(test, a.fields[name], b.fields[name]);
            }
            return { k: 'rec', fields };
        }
        if (a.k === 'tup' && b.k === 'tup' && a.items.length === b.items.length) {
            return { k: 'tup', items: a.items.map((x, i) => this.selectVal(test, x, b.items[i])) };
        }
        if (a.k === 'none' && b.k === 'none')
            return a;
        return this.fail('values of different kinds in a choice');
    }
    // ---- program
    run(module, hash) {
        const checked = this.checked;
        const inputs = checked.inputs.map((i) => {
            const spec = { name: i.name, type: i.type, default: i.default };
            if (i.min !== undefined)
                spec.min = i.min;
            if (i.max !== undefined)
                spec.max = i.max;
            if (i.options !== undefined)
                spec.options = [...i.options];
            return spec;
        });
        for (const i of inputs)
            this.b.declareInput(i);
        const defs = module.body.filter((s) => s.kind === 'FunctionDef');
        for (const d of defs)
            if (d.decorators.length === 0)
                this.helpers.set(d.name, d);
        const entry = defs.find((d) => d.decorators.length > 0);
        let resultVal;
        if (entry) {
            for (const s of module.body)
                if (s.kind === 'Assign')
                    this.assign(s.targets.map((t) => t.id), this.expr(s.value, this.consts), this.consts);
            const env = new Map(this.consts);
            for (const p of entry.params)
                env.set(p.name, { k: 'ref', ref: this.b.input(p.name) });
            resultVal = this.block(entry.body, env, null);
            if (checked.kind === 'screener')
                this.pushResult(resultVal, entry.body[entry.body.length - 1]?.span);
        }
        else {
            // A bare script's own lines are its top level: a helper sees the fixed values set there so far, as in the
            // @screener form (the checker refuses a helper that reads a value changing per candlestick).
            const env = this.consts;
            const body = module.body.filter((s) => s.kind !== 'FunctionDef');
            const last = module.body[module.body.length - 1];
            const resultStmt = checked.kind === 'bare-screener' && last && last.kind === 'ExprStmt' ? last : null;
            resultVal = this.block(body, env, resultStmt);
            if (resultStmt)
                this.pushResult(resultVal, resultStmt.span);
        }
        // Number the nodes reachable from the outputs, in output order.
        const roots = [];
        for (const o of this.outputs) {
            roots.push(o.value);
            if (o.enabled)
                roots.push(o.enabled);
            if (o.color)
                roots.push(o.color);
            if (o.other)
                roots.push(o.other);
        }
        const { nodes, idOf } = this.b.finalize(roots);
        this.lines = nodes.map(() => 0);
        for (const [digest, id] of idOf)
            this.lines[id] = this.lineOf.get(digest) ?? 0;
        const outputs = this.outputs.map((o) => {
            const out = { kind: o.kind, value: idOf.get(o.value) };
            if (o.enabled)
                out.enabled = idOf.get(o.enabled);
            if (o.label !== undefined)
                out.label = o.label;
            if (o.style !== undefined)
                out.style = o.style;
            if (o.shape !== undefined)
                out.shape = o.shape;
            if (o.where !== undefined)
                out.where = o.where;
            if (o.color)
                out.color = idOf.get(o.color);
            if (o.width !== undefined)
                out.width = o.width;
            if (o.offset !== undefined)
                out.offset = o.offset;
            if (o.other)
                out.other = idOf.get(o.other);
            if (o.leg)
                out.leg = { ...o.leg };
            if (o.sizePct !== undefined)
                out.sizePct = o.sizePct;
            return out;
        });
        const params = {};
        const meta = {};
        for (const [k, v] of Object.entries(checked.entryArgs)) {
            if (PARAM_KEYS.includes(k))
                params[k] = v;
            else if (META_KEYS.includes(k))
                meta[k] = v;
            else
                return this.fail(`unknown script type setting \`${k}\``);
        }
        const program = { irVersion: 0, kind: checked.kind, params, meta, inputs, nodes, outputs, requires: [] };
        void hash;
        program.requires = requiresOf(program);
        return program;
    }
    pushResult(v, span) {
        this.outputs.push({ kind: 'result', value: this.ref(v, span) });
    }
    // ---- statements
    /** Lower a block. Returns the value of a `return`, if the block ends in one. */
    block(stmts, env, resultStmt) {
        let result;
        for (const s of stmts) {
            switch (s.kind) {
                case 'Assign':
                    // `n = input(20)` in a script without def (the checker allows it nowhere else): the setting itself.
                    if (s.targets.length === 1 && s.value.kind === 'Call' && s.value.func.kind === 'Name' && s.value.func.id === 'input')
                        env.set(s.targets[0].id, { k: 'ref', ref: this.b.input(s.targets[0].id) });
                    else
                        this.assign(s.targets.map((t) => t.id), this.expr(s.value, env), env);
                    break;
                case 'ExprStmt': {
                    const v = this.expr(s.value, env);
                    if (s === resultStmt)
                        result = v;
                    break;
                }
                case 'Return': return this.expr(s.value, env);
                case 'Pass':
                case 'FunctionDef': break;
                case 'If': {
                    const r = this.ifStmt(s, env);
                    if (r !== undefined)
                        return r;
                    break;
                }
            }
        }
        return result;
    }
    assign(names, v, env) {
        if (names.length === 1) {
            env.set(names[0], v);
            return;
        }
        // m, s, h = ind.macd(): the group's values in its own order (the checker has matched the count and the names).
        if (v.k === 'rec') {
            const keys = Object.keys(v.fields);
            if (keys.length !== names.length)
                this.fail('cannot split this group');
            names.forEach((n, i) => env.set(n, { k: 'ref', ref: v.fields[keys[i]] }));
            return;
        }
        if (v.k !== 'tup' || v.items.length !== names.length)
            this.fail('cannot split this value');
        names.forEach((n, i) => env.set(n, v.items[i]));
    }
    ifStmt(s, env) {
        const test = this.ref(this.expr(s.test, env), s.test.span);
        const folded = this.b.constOf(test);
        if (folded && typeof folded.value === 'boolean')
            return this.block(folded.value ? s.body : s.orelse, env, null);
        const fixed = !this.b.ty(test).series;
        const a = new Map(env);
        const c = new Map(env);
        if (fixed)
            this.guards.push(test);
        const ra = this.block(s.body, a, null);
        if (fixed)
            this.guards[this.guards.length - 1] = this.b.not(test);
        const rb = this.block(s.orelse, c, null);
        if (fixed)
            this.guards.pop();
        if (ra !== undefined && rb !== undefined)
            return this.selectVal(test, ra, rb);
        if (ra !== undefined || rb !== undefined)
            return this.fail('a return on one path only', s.span);
        const names = new Set();
        for (const [n, v] of a)
            if (env.get(n) !== v)
                names.add(n);
        for (const [n, v] of c)
            if (env.get(n) !== v)
                names.add(n);
        for (const n of names) {
            const va = a.get(n) ?? env.get(n);
            const vb = c.get(n) ?? env.get(n);
            if (va && vb)
                env.set(n, this.selectVal(test, va, vb));
            else
                env.set(n, (va ?? vb));
        }
        return undefined;
    }
    // ---- expressions
    /** The line of the script that first wrote each value (by digest), so a later error can name it. */
    lineOf = new Map();
    expr(e, env) {
        const v = this.exprInner(e, env);
        const line = e.span?.line;
        if (line) {
            const note = (x) => {
                if (x.k === 'ref') {
                    if (!this.lineOf.has(x.ref))
                        this.lineOf.set(x.ref, line);
                }
                else if (x.k === 'rec')
                    Object.values(x.fields).forEach((r) => { if (!this.lineOf.has(r))
                        this.lineOf.set(r, line); });
                else if (x.k === 'tup')
                    x.items.forEach(note);
            };
            note(v);
        }
        return v;
    }
    exprInner(e, env) {
        const b = this.b;
        switch (e.kind) {
            case 'Number': return { k: 'ref', ref: b.number(e.value, Number.isInteger(e.value) && !/[.eE]/.test(e.raw) ? 'int' : 'float') };
            case 'String': return { k: 'ref', ref: b.text(e.value) };
            case 'Bool': return { k: 'ref', ref: b.bool(e.value) };
            case 'Na': return { k: 'ref', ref: b.na() };
            case 'Name': {
                const v = env.get(e.id);
                if (v)
                    return v;
                if (OHLCV.includes(e.id))
                    return { k: 'ref', ref: b.field(e.id) };
                // hl2 is (high + low) / 2, built as that expression is, so both spellings are one program.
                if (isPriceBlend(e.id)) {
                    const fields = PRICE_BLENDS[e.id].fields;
                    let sum = b.field(fields[0]);
                    for (const f of fields.slice(1))
                        sum = b.bin('add', sum, b.field(f));
                    return { k: 'ref', ref: b.bin('div', sum, b.number(fields.length, 'int')) };
                }
                return this.fail(`name \`${e.id}\` is not defined`, e.span);
            }
            case 'Attribute': return this.attribute(e.value, e.attr, env, e.span);
            case 'Subscript': return { k: 'ref', ref: b.shift(this.ref(this.expr(e.value, env), e.span), this.ref(this.expr(e.index, env), e.index.span)) };
            case 'Call': return this.call(e, env);
            case 'Unary': {
                const x = this.ref(this.expr(e.operand, env), e.span);
                return { k: 'ref', ref: e.op === 'not' ? b.not(x) : e.op === '-' ? b.neg(x) : x };
            }
            case 'Binary': return { k: 'ref', ref: b.bin(BIN[e.op], this.ref(this.expr(e.left, env), e.span), this.ref(this.expr(e.right, env), e.span)) };
            case 'BoolOp': return { k: 'ref', ref: b.logic(e.op, e.values.map((v) => this.ref(this.expr(v, env), v.span))) };
            case 'Compare': {
                const xs = [e.left, ...e.comparators].map((x) => this.ref(this.expr(x, env), x.span));
                const parts = e.ops.map((op, i) => b.cmp(CMP[op], xs[i], xs[i + 1]));
                return { k: 'ref', ref: parts.length === 1 ? parts[0] : b.logic('and', parts) };
            }
            case 'IfExp': {
                const test = this.ref(this.expr(e.test, env), e.test.span);
                return this.selectVal(test, this.expr(e.body, env), this.expr(e.orelse, env));
            }
            case 'Tuple': return { k: 'tup', items: e.elts.map((x) => this.expr(x, env)) };
            case 'ListComp':
            case 'List':
            case 'Lambda': return this.fail('this form is only valid as the list of all, any, min, max, sum or avg', e.span);
        }
    }
    attribute(base, attr, env, span) {
        const b = this.b;
        if (base.kind === 'Name' && !env.has(base.id)) {
            switch (base.id) {
                case 'bench': return { k: 'ref', ref: b.bench(attr) };
                case 'info':
                case 'fund': return { k: 'ref', ref: b.value(`${base.id}.${attr}`) };
                case 'color': return { k: 'ref', ref: b.const('color', attr) };
                // math.pi is the only maths value (WP1, 2026-10-17); it is an ordinary fixed number.
                case 'math': if (attr === 'pi')
                    return { k: 'ref', ref: b.number(Math.PI) };
            }
            return this.fail(`unknown name \`${base.id}.${attr}\``, span);
        }
        const v = this.expr(base, env);
        if (v.k !== 'rec' || !Object.hasOwn(v.fields, attr))
            return this.fail(`no field \`${attr}\``, span);
        return { k: 'ref', ref: v.fields[attr] };
    }
    // ---- calls
    bindArgs(params, args, env) {
        const out = params.map(() => undefined);
        let i = 0;
        for (const a of args) {
            const at = a.name === undefined ? i++ : params.findIndex((p) => p.name === a.name);
            if (at < 0 || at >= params.length)
                return this.fail('argument does not fit', a.span);
            out[at] = this.ref(this.expr(a.value, env), a.span);
        }
        return out;
    }
    call(e, env) {
        const f = e.func;
        let name;
        if (f.kind === 'Name') {
            const h = this.helpers.get(f.id);
            if (h && !env.has(f.id))
                return this.inline(h, e, env);
            name = f.id;
        }
        else if (f.kind === 'Attribute' && f.value.kind === 'Name' && !env.has(f.value.id)) {
            name = `${f.value.id}.${f.attr}`;
        }
        else
            return this.fail('cannot call this', f.span);
        if (name === 'all' || name === 'any')
            return this.allAny(name, e, env);
        if (name === 'sum' || name === 'avg' || ((name === 'min' || name === 'max') && e.args.length === 1 && (e.args[0].value.kind === 'List' || e.args[0].value.kind === 'ListComp'))) {
            return this.listNumbers(name, e, env);
        }
        if (name === 'tf' || name === 'ref')
            return this.frameCall(name, e, env);
        const spec = fnSpec(name);
        if (!spec)
            return this.fail(`unknown function \`${name}\``, e.span);
        if (spec.returns.kind === 'none') {
            this.output(spec.name, spec.params, e, env);
            return { k: 'none' };
        }
        const bound = this.bindArgs(spec.params, e.args, env);
        const args = [];
        spec.params.forEach((p, i) => {
            const r = bound[i];
            if (r !== undefined)
                args.push(r);
            else if (p.default !== undefined)
                args.push(typeof p.default === 'number' ? this.b.number(p.default) : typeof p.default === 'boolean' ? this.b.bool(p.default) : this.b.text(p.default));
            else if (!p.optional)
                this.fail(`missing argument \`${p.name}\``, e.span);
        });
        // A written occurrence=0 means the same as none: drop it, so both spellings (and scripts older than the argument) hash alike.
        if (spec.name === 'ta.value_when' && args.length === 3 && this.b.constOf(args[2])?.value === 0)
            args.pop();
        if (spec.returns.kind === 'record') {
            const fields = {};
            for (const out of Object.keys(spec.returns.fields))
                fields[out] = this.b.call(spec.name, args, out);
            return { k: 'rec', fields };
        }
        return { k: 'ref', ref: this.b.call(spec.name, args) };
    }
    /** The items of a list, written out ([a, b, c]) or expanded ([x for i in range(n)]), in order. */
    listItems(name, e, env) {
        const arg = e.args[0]?.value;
        if (arg && arg.kind === 'List')
            return arg.elts.map((x) => this.ref(this.expr(x, env), x.span));
        if (!arg || arg.kind !== 'ListComp')
            return this.fail(`${name}() needs a list`, e.span);
        const range = arg.iter;
        if (range.kind !== 'Call' || range.args.length !== 1)
            return this.fail('range needs one number', arg.span);
        const n = this.b.constOf(this.ref(this.expr(range.args[0].value, env)));
        if (!n || typeof n.value !== 'number')
            return this.fail('range needs a fixed number', range.span);
        const items = [];
        for (let i = 0; i < n.value; i++) {
            const child = new Map(env);
            child.set(arg.target.id, { k: 'ref', ref: this.b.number(i, 'int') });
            items.push(this.ref(this.expr(arg.elt, child), arg.elt.span));
        }
        return items;
    }
    allAny(name, e, env) {
        return { k: 'ref', ref: this.b.logic(name === 'all' ? 'and' : 'or', this.listItems(name, e, env)) };
    }
    /**
     * min, max, sum and avg of a list (A4) become ordinary nodes, folded left to right: max(max(a, b), c), (a + b) + c, and the sum
     * divided by the count. No new node kind. A missing item makes the answer missing, because min, max and + are missing when an
     * argument is.
     */
    listNumbers(name, e, env) {
        // Every item is first brought to the finest candlestick size among them, as one call over all of them would be: folding first
        // would align a monthly value to a weekly one and only then to the day, which shows a month later than the day does.
        const items = this.b.alignAll(this.listItems(name, e, env)).refs;
        if (items.length === 0)
            return this.fail('an empty list', e.span);
        let acc = items[0];
        for (const x of items.slice(1))
            acc = name === 'min' || name === 'max' ? this.b.call(name, [acc, x]) : this.b.bin('add', acc, x);
        if (name === 'avg')
            acc = this.b.bin('div', acc, this.b.number(items.length, 'int'));
        return { k: 'ref', ref: acc };
    }
    frameCall(name, e, env) {
        const spec = fnSpec(name);
        const bound = this.bindArgs(spec.params, e.args, env);
        const first = this.b.constOf(bound[0]);
        if (!first || typeof first.value !== 'string')
            return this.fail(`${name}() needs text written in the script`, e.span);
        const fields = {};
        if (name === 'tf') {
            const code = TF_CODES[first.value];
            if (!code)
                return this.fail('unknown timeframe code', e.span);
            const pc = bound[1] === undefined ? undefined : this.b.constOf(bound[1]);
            const partial = pc !== undefined && pc.value === true;
            for (const f of FRAME_FIELDS)
                fields[f] = this.b.field(f, code.frame, partial);
        }
        else {
            for (const f of FRAME_FIELDS)
                fields[f] = this.b.ref(first.value, f);
        }
        return { k: 'rec', fields };
    }
    inline(h, e, env) {
        if (this.depth >= MAX_DEPTH)
            return this.fail('helpers nested too deeply', e.span);
        // A helper sees its own parameters and the fixed values written above the function (in a bare script, the top level), nothing else.
        const local = new Map(this.consts);
        let i = 0;
        const given = new Set();
        for (const a of e.args) {
            const at = a.name === undefined ? i++ : h.params.findIndex((p) => p.name === a.name);
            if (at < 0 || at >= h.params.length)
                return this.fail('argument does not fit', a.span);
            given.add(at);
            local.set(h.params[at].name, this.expr(a.value, env));
        }
        // A parameter left out takes the default written in the def (A3; the checker allows only a value written out).
        h.params.forEach((p, k) => {
            if (!given.has(k) && p.default !== undefined)
                local.set(p.name, this.expr(p.default, this.consts));
        });
        this.depth++;
        const r = this.block(h.body, local, null);
        this.depth--;
        if (r === undefined)
            return this.fail('a helper that returns nothing', e.span);
        return r;
    }
    // ---- outputs
    output(fn, params, e, env) {
        const kind = (fn.startsWith('strategy.') ? fn.slice(9) : fn);
        const bound = {};
        let i = 0;
        for (const a of e.args) {
            const at = a.name === undefined ? i++ : params.findIndex((p) => p.name === a.name);
            if (at < 0 || at >= params.length)
                return this.fail('argument does not fit', a.span);
            bound[params[at].name] = this.ref(this.expr(a.value, env), a.span);
        }
        const text = (n) => {
            const r = bound[n];
            if (r === undefined)
                return undefined;
            const c = this.b.constOf(r);
            return c && typeof c.value === 'string' ? c.value : this.fail(`\`${n}\` must be text written in the script`, e.span);
        };
        if (kind === 'leg') {
            // The leg's written arguments (checked by the checker) travel as `leg`; its value is the number of lots.
            const choice = (n, dflt) => text(n) ?? dflt;
            const lotsRef = bound.lots ?? this.b.const('int', 1);
            const leg = {
                kind, value: lotsRef,
                leg: { right: choice('right', 'call'), side: choice('side', 'buy'), strike: canonicalLegStrike(choice('strike', 'atm')), expiry: choice('expiry', 'near') },
            };
            if (this.guards.length > 0)
                return this.fail('strategy.leg cannot be switched by a setting', e.span);
            this.outputs.push(leg);
            return;
        }
        const valueName = params[0].name;
        const out = { kind, value: bound[valueName] };
        if (out.value === undefined)
            return this.fail('output without a value', e.span);
        if (this.guards.length > 0)
            out.enabled = this.b.logic('and', this.guards);
        // `mark(text=...)` travels as the output's label (presentation only, outside irHash).
        const label = text('label') ?? text('message') ?? text('text');
        if (label !== undefined)
            out.label = label;
        const style = text('style');
        if (style !== undefined)
            out.style = style;
        const shape = text('shape');
        if (shape !== undefined)
            out.shape = shape;
        const where = text('where');
        if (where !== undefined)
            out.where = where;
        if (bound.color !== undefined)
            out.color = bound.color;
        // fill(a, b): the second line travels as `other`.
        if (kind === 'fill') {
            if (bound.b === undefined)
                return this.fail('fill needs two lines', e.span);
            out.other = bound.b;
        }
        // plot(linewidth=, offset=): numbers written in the script (the checker says so), presentation only. A written offset=0 means the
        // same as none and is dropped, so both spellings hash alike. A written linewidth is kept (left out, the chart picks the width).
        for (const name of ['linewidth', 'offset']) {
            if (bound[name] === undefined)
                continue;
            const c = this.b.constOf(bound[name]);
            if (!c || typeof c.value !== 'number')
                return this.fail(`\`${name}\` must be a number written in the script`, e.span);
            if (name === 'linewidth')
                out.width = c.value;
            if (name === 'offset' && c.value !== 0)
                out.offset = c.value;
        }
        if (bound.size_pct !== undefined) {
            // The part a first target sells is a number written in the script (the checker says so); it travels as a number, not a node.
            const c = this.b.constOf(bound.size_pct);
            if (!c || typeof c.value !== 'number')
                return this.fail('`size_pct` must be a number written in the script', e.span);
            out.sizePct = c.value;
        }
        this.outputs.push(out);
    }
}
export function lower(module, checked, hash) {
    return new Lowerer(hash, checked).run(module, hash);
}
/** The program, and the source line that first wrote each of its nodes (0 when unknown). The lines are not part of any hash. */
export function lowerWithLines(module, checked, hash) {
    const l = new Lowerer(hash, checked);
    const program = l.run(module, hash);
    return { program, lines: l.lines };
}
