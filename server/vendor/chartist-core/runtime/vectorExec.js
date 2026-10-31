import { refsOf } from '../ir/ir.js';
import { alignIndex } from './data.js';
import { MissingData, NotYetSupported, RuntimeError } from './errors.js';
import { lookup } from './functions.js';
import * as K from './kernels.js';
const scalar = (v) => {
    if (v.k !== 'c')
        throw new RuntimeError('E-RT-INTERNAL', 'a fixed number was expected');
    return v.c;
};
/** Nodes whose value is an array the executor allocated (the others point at the caller's data). */
const ownsArray = (op) => op !== 'field' && op !== 'bench' && op !== 'ref';
export function execute(program, data, opts) {
    const nodes = program.nodes;
    const total = nodes.length;
    const lenOf = (frame) => {
        if (frame === 'D')
            return data.cal.n;
        if (frame === 'W' || frame === 'M')
            return data.cal.len[frame];
        throw new NotYetSupported(`candlestick size ${frame}`);
    };
    // Which nodes the outputs need, and how many later nodes read each one (so it can be dropped when unused).
    const needed = new Array(total).fill(false);
    const roots = [];
    for (const o of program.outputs) {
        roots.push(o.value);
        if (o.enabled !== undefined)
            roots.push(o.enabled);
    }
    for (const r of roots)
        needed[r] = true;
    for (let id = total - 1; id >= 0; id--)
        if (needed[id])
            for (const r of refsOf(nodes[id]))
                needed[r] = true;
    const readers = new Array(total).fill(0);
    for (let id = 0; id < total; id++)
        if (needed[id])
            for (const r of refsOf(nodes[id]))
                readers[r]++;
    for (const r of roots)
        readers[r]++; // the outputs read their values after the pass
    const vals = new Array(total).fill(undefined);
    let live = 0;
    let peak = 0;
    let evaluated = 0;
    const operand = (v, frame, node) => {
        if (v.k === 'c')
            return v.c;
        if (v.k === 's') {
            if (v.frame !== frame)
                throw new RuntimeError('E-RT-FRAME', `an operand on candlestick size ${v.frame} is used on size ${frame} without an align`, node, opts.lineOf(node));
            return v.s;
        }
        throw new RuntimeError('E-RT-INTERNAL', 'a number was expected', node, opts.lineOf(node));
    };
    const get = (id) => {
        const v = vals[id];
        if (!v)
            throw new RuntimeError('E-RT-INTERNAL', 'a value was used after it was dropped', id, opts.lineOf(id));
        return v;
    };
    function build(id) {
        const n = nodes[id];
        const frame = n.ty.frame;
        const len = lenOf(frame);
        const line = opts.lineOf(id);
        const cost = (inputs) => opts.budget.touch(len * (1 + inputs), id);
        const series = (a) => ({ k: 's', s: a, frame });
        const op = (r) => operand(get(r), frame, id);
        switch (n.op) {
            case 'const':
                if (n.value === null)
                    return { k: 'c', c: K.U };
                if (typeof n.value === 'string')
                    return { k: 't', t: n.value };
                return { k: 'c', c: typeof n.value === 'boolean' ? (n.value ? 1 : 0) : n.value };
            case 'input': {
                const v = opts.inputs.get(n.name);
                if (v === undefined)
                    throw new MissingData(`setting ${n.name}`, id, line);
                return typeof v === 'string' ? { k: 't', t: v } : { k: 'c', c: v };
            }
            case 'field': {
                // The series holds every candlestick, the forming one included; `align` decides who may see it (partial or not).
                cost(0);
                return { k: 's', s: data.bars(n.frame)[n.field], frame: n.frame };
            }
            case 'bench': {
                if (!data.bench)
                    throw new MissingData('the benchmark', id, line);
                cost(0);
                if (data.bench.n !== data.cal.n)
                    throw new RuntimeError('E-RT-DATA', 'the benchmark does not line up with the instrument', id, line);
                return series(data.bench[n.field]);
            }
            case 'ref': {
                const b = data.refs?.get(n.symbol);
                if (!b)
                    throw new MissingData(`the candlesticks of ${n.symbol}`, id, line);
                cost(0);
                if (b.n !== data.cal.n)
                    throw new RuntimeError('E-RT-DATA', `${n.symbol} does not line up with the instrument`, id, line);
                return series(b[n.field]);
            }
            case 'value': {
                const v = data.values?.get(n.name);
                if (v === undefined)
                    throw new MissingData(`the current value ${n.name}`, id, line);
                cost(0);
                // Text (info.sector) is compared as text; an unknown one makes every comparison unknown.
                if (typeof v === 'string')
                    return { k: 't', t: v, snap: true };
                if (v === null && n.ty.base === 'str')
                    return { k: 't', t: '', snap: true, na: true };
                const a = new Float64Array(len).fill(K.U);
                if (typeof v === 'number' && len > 0)
                    a[len - 1] = Number.isFinite(v) ? v : K.U;
                return series(a);
            }
            case 'state':
            case 'scan':
                throw new NotYetSupported('ta.scan', id, line);
            case 'shift': {
                const k = scalar(get(n.k));
                const x = get(n.x);
                cost(1);
                return series(K.shift(operand(x, frame, id), k, len));
            }
            case 'neg': {
                const x = get(n.x);
                if (x.k === 'c')
                    return { k: 'c', c: -x.c };
                cost(1);
                return series(K.map1(len, op(n.x), (a) => -a));
            }
            case 'not': {
                const x = get(n.x);
                if (x.k === 'c')
                    return { k: 'c', c: K.not3(x.c) };
                cost(1);
                return series(K.map1(len, op(n.x), K.not3));
            }
            case 'bin': {
                const a = get(n.a);
                const b = get(n.b);
                if (a.k === 'c' && b.k === 'c')
                    return { k: 'c', c: K.arith(n.kind, a.c, b.c) };
                cost(2);
                return series(K.map2(len, op(n.a), op(n.b), (x, y) => K.arith(n.kind, x, y)));
            }
            case 'cmp': {
                const a = get(n.a);
                const b = get(n.b);
                if (a.k === 't' || b.k === 't') {
                    if (a.k !== 't' || b.k !== 't') {
                        // `na` against a text is unknown, like any comparison with na (e.g. `lab == na`).
                        const other = a.k === 't' ? b : a;
                        if (other.k === 'c' && K.isU(other.c))
                            return { k: 'c', c: K.U };
                        throw new RuntimeError('E-RT-INTERNAL', 'text was compared with a number', id, line);
                    }
                    if (n.kind !== 'eq' && n.kind !== 'ne')
                        throw new RuntimeError('E-RT-INTERNAL', 'text can only be compared with == and !=', id, line);
                    const known = !a.na && !b.na;
                    const same = a.t === b.t ? 1 : 0;
                    const result = !known ? K.U : n.kind === 'eq' ? same : 1 - same;
                    if (!a.snap && !b.snap)
                        return { k: 'c', c: result };
                    // Text read for the latest candlestick only gives an answer for the latest candlestick only.
                    cost(0);
                    const out = new Float64Array(len).fill(K.U);
                    if (len > 0)
                        out[len - 1] = result;
                    return series(out);
                }
                if (a.k === 'c' && b.k === 'c')
                    return { k: 'c', c: K.compare(n.kind, a.c, b.c) };
                cost(2);
                return series(K.map2(len, op(n.a), op(n.b), (x, y) => K.compare(n.kind, x, y)));
            }
            case 'and':
            case 'or': {
                const f = n.op === 'and' ? K.and3 : K.or3;
                const vs = n.args.map(get);
                if (vs.every((v) => v.k === 'c'))
                    return { k: 'c', c: f(vs.map((v) => v.c)) };
                cost(vs.length);
                return series(K.mapN(len, n.args.map(op), f));
            }
            case 'select': {
                const c = get(n.cond);
                const a = get(n.a);
                const b = get(n.b);
                const pick = (t, x, y) => (K.isU(t) ? K.U : t ? x : y);
                if (c.k === 'c' && a.k === 'c' && b.k === 'c')
                    return { k: 'c', c: pick(c.c, a.c, b.c) };
                // Text chosen by a fixed value (a setting, a constant): pass the chosen text through.
                // The checker refuses a text chosen per candlestick (E-TEXT-CHOICE), so a text branch
                // only reaches here with a fixed condition.
                if (a.k === 't' || b.k === 't') {
                    if (c.k !== 'c')
                        throw new RuntimeError('E-RT-INTERNAL', 'a text was chosen per candlestick', id, line);
                    const snap = (a.k === 't' && a.snap) || (b.k === 't' && b.snap) || undefined;
                    if (K.isU(c.c))
                        return { k: 't', t: '', na: true, snap };
                    // The other branch can only be `na` (the checker joins na with text as text): an unknown text, not a number.
                    const chosen = c.c ? a : b;
                    return chosen.k === 't' ? chosen : { k: 't', t: '', na: true, snap };
                }
                cost(3);
                return series(K.map3(len, op(n.cond), op(n.a), op(n.b), pick));
            }
            case 'align': {
                const x = get(n.x);
                if (x.k !== 's')
                    return x;
                cost(1);
                const to = lenOf(n.to);
                const out = new Float64Array(to).fill(K.U);
                for (let i = 0; i < to; i++) {
                    const j = alignIndex(data.cal, x.frame, n.to, i, n.partial);
                    if (j >= 0)
                        out[i] = x.s[j];
                }
                return { k: 's', s: out, frame: n.to };
            }
            case 'call': {
                const args = n.args.map((r) => {
                    const v = get(r);
                    if (v.k === 'c')
                        return { c: v.c };
                    if (v.k === 't')
                        return { t: v.t };
                    return { s: operand(v, frame, id) };
                });
                cost(args.filter((a) => 's' in a).length);
                const ctx = { fn: n.fn, out: n.out, frame, n: len, args, bars: data.bars(frame), snapshots: data.snapshots ?? {}, ...(data.deriv ? { deriv: data.deriv } : {}), touch: (c) => opts.budget.touch(c, id) };
                const f = lookup(opts.functions, ctx, id, line);
                const r = f(ctx);
                if (n.ty.series) {
                    if (typeof r === 'number')
                        return series(new Float64Array(len).fill(r));
                    if (r.length !== len)
                        throw new RuntimeError('E-RT-INTERNAL', `${n.fn} returned ${r.length} values for ${len} candlesticks`, id, line);
                    return series(r);
                }
                // A call whose arguments are all constants is one number; a kernel may still hand back an array of equal values.
                if (typeof r !== 'number') {
                    if (r.length === 0)
                        throw new RuntimeError('E-RT-INTERNAL', `${n.fn} returned nothing where one number was expected`, id, line);
                    return { k: 'c', c: r[0] };
                }
                return { k: 'c', c: r };
            }
        }
    }
    // The pass.
    for (let id = 0; id < total; id++) {
        if (!needed[id])
            continue;
        const v = build(id);
        vals[id] = v;
        evaluated++;
        if (v.k === 's' && ownsArray(nodes[id].op)) {
            live++;
            if (live > peak)
                peak = live;
        }
        for (const r of refsOf(nodes[id])) {
            if (--readers[r] === 0) {
                const old = vals[r];
                if (old && old.k === 's' && ownsArray(nodes[r].op))
                    live--;
                vals[r] = undefined;
            }
        }
    }
    // The outputs, each on the daily size.
    const n = data.cal.n;
    const outputs = [];
    for (let index = 0; index < program.outputs.length; index++) {
        const o = program.outputs[index];
        if (o.enabled !== undefined && scalar(get(o.enabled)) !== 1)
            continue;
        const v = get(o.value);
        const values = new Float64Array(n);
        if (v.k === 'c')
            values.fill(v.c);
        else if (v.k === 's') {
            if (v.frame === 'D')
                values.set(v.s);
            else
                for (let i = 0; i < n; i++) {
                    const j = alignIndex(data.cal, v.frame, 'D', i, nodes[o.value].ty.partial);
                    values[i] = j < 0 ? K.U : v.s[j];
                }
        }
        else
            throw new RuntimeError('E-RT-INTERNAL', 'an output must be a number');
        opts.budget.touch(n, o.value);
        const out = { index, kind: o.kind, values };
        if (o.label !== undefined)
            out.label = o.label;
        if (o.style !== undefined)
            out.style = o.style;
        if (o.shape !== undefined)
            out.shape = o.shape;
        if (o.where !== undefined)
            out.where = o.where;
        outputs.push(out);
    }
    return { outputs, stats: { nodes: evaluated, peakLiveSeries: peak } };
}
