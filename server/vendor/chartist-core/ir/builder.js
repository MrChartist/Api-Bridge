// Builds the IR. Every node is stored once under its content digest, and the constructors do the
// work that makes equal scripts give equal graphs: they work out fixed values, flatten and order
// and/or, drop repeats, and put an `align` node wherever a coarser candlestick size meets a finer one.
import { joinBase } from '../check/types.js';
import { frameRank } from '../check/types.js';
import { settingRange } from '../check/settings.js';
import { fnSpec } from '../stdlib/manifest.js';
import { digestOf } from './digest.js';
import { refsOf } from './ir.js';
import { rangeOf } from './range.js';
import { binBase, finestOf, typeOfOp } from './typing.js';
const SAFE = 1e15;
export function foldBin(kind, a, b) {
    let v;
    switch (kind) {
        case 'add':
            v = a + b;
            break;
        case 'sub':
            v = a - b;
            break;
        case 'mul':
            v = a * b;
            break;
        case 'div':
            if (b === 0)
                return undefined;
            v = a / b;
            break;
        case 'floordiv':
            if (b === 0)
                return undefined;
            v = Math.floor(a / b);
            break;
        case 'mod':
            if (b === 0)
                return undefined;
            v = a - b * Math.floor(a / b);
            break;
        case 'pow':
            v = a ** b;
            break;
    }
    return Number.isFinite(v) && Math.abs(v) <= SAFE ? (Object.is(v, -0) ? 0 : v) : undefined;
}
function foldCmp(kind, a, b) {
    switch (kind) {
        case 'lt': return a < b;
        case 'le': return a <= b;
        case 'gt': return a > b;
        case 'ge': return a >= b;
        case 'eq': return a === b;
        case 'ne': return a !== b;
    }
}
export class IrBuilder {
    hash;
    table = new Map();
    inputs = new Map();
    constructor(hash) {
        this.hash = hash;
    }
    // ---- reading
    get(ref) {
        const s = this.table.get(ref);
        if (!s)
            throw new Error('unknown node');
        return s;
    }
    ty(ref) {
        return this.get(ref).ty;
    }
    op(ref) {
        return this.get(ref).op;
    }
    size() {
        return this.table.size;
    }
    /** The fixed value of a constant node, if the node is one. */
    constOf(ref) {
        const o = this.get(ref).op;
        return o.op === 'const' ? { base: o.base, value: o.value } : undefined;
    }
    constNumber(ref) {
        const c = this.constOf(ref);
        return c && typeof c.value === 'number' ? c.value : undefined;
    }
    constBool(ref) {
        const c = this.constOf(ref);
        return c && typeof c.value === 'boolean' ? c.value : undefined;
    }
    /** Range of a fixed node (a number, a setting, or arithmetic on them). */
    rangeOf(ref) {
        return rangeOf(ref, { op: (r) => this.op(r), input: (n) => this.inputs.get(n) });
    }
    // ---- interning
    intern(op) {
        const ty = typeOfOp(op, {
            tyOf: (r) => this.ty(r),
            input: (n) => this.inputs.get(n),
            lowerBound: (r) => this.rangeOf(r)?.lo,
        });
        const d = digestOf(op, this.hash);
        if (!this.table.has(d))
            this.table.set(d, { op, ty });
        return d;
    }
    declareInput(i) {
        this.inputs.set(i.name, i);
    }
    // ---- leaves
    const(base, value) {
        return this.intern({ op: 'const', base, value: typeof value === 'number' && Object.is(value, -0) ? 0 : value });
    }
    number(v, base) {
        return this.const(base ?? (Number.isInteger(v) ? 'int' : 'float'), v);
    }
    bool(v) {
        return this.const('bool', v);
    }
    text(v) {
        return this.const('str', v);
    }
    na() {
        return this.const('na', null);
    }
    input(name) {
        return this.intern({ op: 'input', name });
    }
    field(field, frame = 'D', partial = false) {
        return this.intern({ op: 'field', field, frame, partial });
    }
    bench(field) {
        return this.intern({ op: 'bench', field });
    }
    ref(symbol, field) {
        return this.intern({ op: 'ref', symbol, field });
    }
    value(name) {
        return this.intern({ op: 'value', name });
    }
    state(slot, base) {
        return this.intern({ op: 'state', slot, base });
    }
    // ---- frames
    align(x, to, partial = false) {
        const t = this.ty(x);
        if (!t.series || t.frame === to || frameRank(to) > frameRank(t.frame))
            return x;
        return this.intern({ op: 'align', x, to, partial: partial || t.partial });
    }
    /** Align every series reference to the finest frame among them. */
    alignAll(refs) {
        const tys = refs.map((r) => this.ty(r));
        const frame = finestOf(tys);
        return { refs: refs.map((r, i) => (tys[i].series ? this.align(r, frame) : r)), frame };
    }
    // ---- operations
    shift(x, k) {
        const t = this.ty(x);
        const kv = this.constNumber(k);
        if (!t.series || kv === 0)
            return x;
        return this.intern({ op: 'shift', x, k });
    }
    neg(x) {
        const c = this.constOf(x);
        if (c && typeof c.value === 'number')
            return this.const(c.base, -c.value);
        const o = this.op(x);
        if (o.op === 'neg')
            return o.x;
        return this.intern({ op: 'neg', x });
    }
    not(x) {
        const b = this.constBool(x);
        if (b !== undefined)
            return this.bool(!b);
        const o = this.op(x);
        if (o.op === 'not')
            return o.x;
        return this.intern({ op: 'not', x });
    }
    bin(kind, a, b) {
        const ca = this.constOf(a);
        const cb = this.constOf(b);
        if (ca && cb && typeof ca.value === 'number' && typeof cb.value === 'number') {
            const v = foldBin(kind, ca.value, cb.value);
            if (v !== undefined) {
                const base = binBase(kind, this.ty(a), this.ty(b), cb.value);
                return this.const(base, v);
            }
        }
        const al = this.alignAll([a, b]);
        return this.intern({ op: 'bin', kind, a: al.refs[0], b: al.refs[1] });
    }
    cmp(kind, a, b) {
        const ca = this.constOf(a);
        const cb = this.constOf(b);
        if (ca && cb && ca.value !== null && cb.value !== null) {
            const sameKind = typeof ca.value === typeof cb.value;
            if (sameKind)
                return this.bool(foldCmp(kind, ca.value, cb.value));
        }
        const al = this.alignAll([a, b]);
        return this.intern({ op: 'cmp', kind, a: al.refs[0], b: al.refs[1] });
    }
    /** Three-valued `and` / `or`. A decided value (false for and, true for or) wins even beside an unknown. */
    logic(op, args) {
        const identity = op === 'and';
        const flat = [];
        for (const a of args) {
            const o = this.op(a);
            if (o.op === op)
                flat.push(...o.args);
            else
                flat.push(a);
        }
        const rest = [];
        for (const a of flat) {
            const c = this.constBool(a);
            if (c === undefined)
                rest.push(a);
            else if (c !== identity)
                return this.bool(c);
        }
        if (rest.length === 0)
            return this.bool(identity);
        const aligned = this.alignAll(rest).refs;
        const unique = [...new Set(aligned)].sort();
        if (unique.length === 1)
            return unique[0];
        return this.intern({ op, args: unique });
    }
    select(cond, a, b) {
        const c = this.constBool(cond);
        if (c !== undefined)
            return c ? a : b;
        // Not simplified when both sides are equal: an unknown condition still gives na (SPEC section 4).
        const al = this.alignAll([cond, a, b]);
        return this.intern({ op: 'select', cond: al.refs[0], a: al.refs[1], b: al.refs[2] });
    }
    call(fn, args, out) {
        const spec = fnSpec(fn);
        if (spec && args.length > 0 && (fn === 'abs' || fn === 'min' || fn === 'max')) {
            const cs = args.map((a) => this.constOf(a));
            if (cs.every((c) => c && typeof c.value === 'number')) {
                const vs = cs.map((c) => c.value);
                const v = fn === 'abs' ? Math.abs(vs[0]) : fn === 'min' ? Math.min(...vs) : Math.max(...vs);
                const base = cs.every((c) => c.base === 'int') ? 'int' : 'float';
                return this.const(base, v);
            }
        }
        const al = this.alignAll(args);
        return this.intern(out === undefined ? { op: 'call', fn, args: al.refs } : { op: 'call', fn, args: al.refs, out });
    }
    scan(slot, init, body) {
        return this.intern({ op: 'scan', slot, init, body });
    }
    /** Join two types the way a choice between them does. */
    joinBase(a, b) {
        return joinBase(a, b);
    }
    // ---- finishing
    /**
     * Number the nodes reachable from the roots, children before parents, visiting roots in order and
     * a node's references in order. The numbering depends only on the graph, so it is canonical.
     */
    finalize(roots) {
        const idOf = new Map();
        const nodes = [];
        const visited = new Set();
        for (const root of roots) {
            if (visited.has(root))
                continue;
            const stack = [{ ref: root, kids: refsOf(this.op(root)), next: 0 }];
            visited.add(root);
            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (top.next < top.kids.length) {
                    const kid = top.kids[top.next++];
                    if (!visited.has(kid)) {
                        visited.add(kid);
                        stack.push({ ref: kid, kids: refsOf(this.op(kid)), next: 0 });
                    }
                }
                else {
                    stack.pop();
                    const id = nodes.length;
                    idOf.set(top.ref, id);
                    nodes.push({ id, ty: { ...this.ty(top.ref) }, ...mapRefs(this.op(top.ref), (r) => idOf.get(r)) });
                }
            }
        }
        return { nodes, idOf };
    }
}
/** The same op with every reference replaced. */
export function mapRefs(op, f) {
    switch (op.op) {
        case 'const':
        case 'input':
        case 'field':
        case 'bench':
        case 'ref':
        case 'value':
        case 'state': return op;
        case 'shift': return { ...op, x: f(op.x), k: f(op.k) };
        case 'neg':
        case 'not': return { ...op, x: f(op.x) };
        case 'bin':
        case 'cmp': return { ...op, a: f(op.a), b: f(op.b) };
        case 'and':
        case 'or': return { ...op, args: op.args.map(f) };
        case 'select': return { ...op, cond: f(op.cond), a: f(op.a), b: f(op.b) };
        case 'align': return { ...op, x: f(op.x) };
        case 'call': return { ...op, args: op.args.map(f) };
        case 'scan': return { ...op, init: f(op.init), body: f(op.body) };
    }
}
export { settingRange };
