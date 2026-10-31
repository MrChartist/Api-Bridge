import { PLOT_LINEWIDTH_MAX, PLOT_OFFSET_MAX, fnSpec, valueSpec } from '../stdlib/manifest.js';
import { frameRank } from '../check/types.js';
import { nodeDigests } from './hashing.js';
import { refsOf } from './ir.js';
import { typeOfOp } from './typing.js';
import { rangeOf } from './range.js';
const isNumberish = (b) => b === 'int' || b === 'float' || b === 'any' || b === 'na';
const sameTy = (a, b) => a.base === b.base && a.series === b.series && a.frame === b.frame && a.partial === b.partial;
/** Problems found, each starting with the node number; an empty list means the program is well formed. */
export function validateIr(program, hash) {
    const problems = [];
    const bad = (id, msg) => {
        problems.push(`${typeof id === 'number' ? `node ${id}` : id}: ${msg}`);
    };
    const inputs = new Map(program.inputs.map((i) => [i.name, i]));
    if (inputs.size !== program.inputs.length)
        bad('inputs', 'two settings have the same name');
    for (const i of program.inputs) {
        if (i.options === undefined)
            continue;
        if (i.type !== 'str' || !Array.isArray(i.options) || i.options.length === 0 || i.options.some((o) => typeof o !== 'string') || new Set(i.options).size !== i.options.length)
            bad('inputs', `setting ${i.name} has malformed options`);
        else if (!i.options.includes(i.default))
            bad('inputs', `the default of setting ${i.name} is not one of its options`);
    }
    const n = program.nodes.length;
    const view = { op: (r) => program.nodes[r], input: (name) => inputs.get(name) };
    /** A `len` or `cnum` argument: fixed, and inside the manifest's range (the checker's E-ARG-RANGE, restated). */
    const fixedArg = (i, what, r, kind) => {
        if (kind.t !== 'len' && kind.t !== 'cnum')
            return;
        const ty = program.nodes[r].ty;
        if (ty.series)
            return bad(i, `${what} must be a fixed number`);
        const range = rangeOf(r, view);
        if (kind.t === 'len') {
            if (ty.base !== 'int' || !range || range.lo === undefined || range.hi === undefined || !Number.isInteger(range.lo) || !Number.isInteger(range.hi))
                return bad(i, `${what} must be a known whole number`);
            if (range.lo < kind.min || range.hi > kind.max)
                bad(i, `${what} must be from ${kind.min} to ${kind.max}, but can be ${range.lo} to ${range.hi}`);
            return;
        }
        if (kind.min === undefined && kind.max === undefined)
            return;
        const lo = range?.lo;
        const hi = range?.hi;
        if ((kind.min !== undefined && !(lo !== undefined && lo >= kind.min)) || (kind.max !== undefined && !(hi !== undefined && hi <= kind.max))) {
            bad(i, `${what} must be${kind.min !== undefined ? ` from ${kind.min}` : ''}${kind.max !== undefined ? ` to ${kind.max}` : ''}, but can be ${lo ?? 'unbounded'} to ${hi ?? 'unbounded'}`);
        }
    };
    let structural = true;
    program.nodes.forEach((node, i) => {
        if (node.id !== i) {
            bad(i, `has number ${node.id}`);
            structural = false;
        }
        for (const r of refsOf(node)) {
            if (!Number.isInteger(r) || r < 0 || r >= i) {
                bad(i, `refers to node ${r}, which is not an earlier node`);
                structural = false;
            }
        }
    });
    if (!structural)
        return problems;
    program.nodes.forEach((node, i) => {
        let expected = null;
        try {
            expected = typeOfOp(node, { tyOf: (r) => program.nodes[r].ty, input: (name) => inputs.get(name), lowerBound: (r) => rangeOf(r, view)?.lo });
        }
        catch (e) {
            bad(i, e instanceof Error ? e.message : 'cannot be typed');
        }
        if (expected && !sameTy(expected, node.ty))
            bad(i, `has type ${JSON.stringify(node.ty)} but its operation gives ${JSON.stringify(expected)}`);
        const series = (r) => program.nodes[r].ty.series;
        const frame = (r) => program.nodes[r].ty.frame;
        const allAligned = (rs) => {
            for (const r of rs)
                if (series(r) && frame(r) !== node.ty.frame)
                    bad(i, `uses node ${r} in frame ${frame(r)} inside frame ${node.ty.frame} without an align`);
        };
        switch (node.op) {
            case 'bin':
            case 'cmp':
                allAligned([node.a, node.b]);
                break;
            case 'and':
            case 'or':
                if (node.args.length < 2)
                    bad(i, `${node.op} needs at least two arguments`);
                if (new Set(node.args).size !== node.args.length)
                    bad(i, `${node.op} repeats an argument`);
                allAligned(node.args);
                break;
            case 'select':
                allAligned([node.cond, node.a, node.b]);
                break;
            case 'call': {
                const spec = fnSpec(node.fn);
                if (spec && spec.returns.kind !== 'cross' && spec.returns.kind !== 'snapshot')
                    allAligned(node.args);
                if (spec && node.args.length > spec.params.length)
                    bad(i, `\`${node.fn}\` has too many arguments`);
                if (spec)
                    node.args.forEach((r, k) => { const p = spec.params[k]; if (p)
                        fixedArg(i, `\`${node.fn}\` argument ${p.name}`, r, p.arg); });
                break;
            }
            case 'align': {
                const x = program.nodes[node.x].ty;
                if (!x.series)
                    bad(i, 'aligns a value that is not a series');
                if (frameRank(node.to) >= frameRank(x.frame))
                    bad(i, `aligns from frame ${x.frame} to ${node.to}, which is not finer`);
                break;
            }
            case 'shift': {
                const k = program.nodes[node.k].ty;
                if (k.series)
                    bad(i, 'shifts by a value that changes from candlestick to candlestick');
                else {
                    const r = rangeOf(node.k, view);
                    if (k.base !== 'int' || !r || r.lo === undefined || r.hi === undefined || !Number.isInteger(r.lo) || !Number.isInteger(r.hi))
                        bad(i, 'shifts by a value that is not a known whole number');
                    else if (r.lo < 0)
                        bad(i, `shifts by ${r.lo}, which would look into the future`);
                }
                if (!program.nodes[node.x].ty.series)
                    bad(i, 'shifts a value that is not a series');
                break;
            }
            case 'value':
                if (!valueSpec(node.name))
                    bad(i, `unknown value \`${node.name}\``);
                break;
            default: break;
        }
    });
    if (hash) {
        const d = nodeDigests(program, hash);
        program.nodes.forEach((node, i) => {
            if ((node.op === 'and' || node.op === 'or') && node.args.some((r, k) => k > 0 && d[node.args[k - 1]] >= d[r]))
                bad(i, `${node.op} arguments are not in canonical order`);
        });
        const seen = new Set();
        d.forEach((x, i) => {
            if (seen.has(x))
                bad(i, 'repeats another node');
            seen.add(x);
        });
    }
    program.outputs.forEach((o, k) => {
        const where = `output ${k}`;
        if (!(o.value >= 0 && o.value < n))
            return bad(where, 'value is not a node');
        const t = program.nodes[o.value].ty;
        if (o.enabled !== undefined) {
            if (!(o.enabled >= 0 && o.enabled < n))
                bad(where, 'enabled is not a node');
            else if (program.nodes[o.enabled].ty.series || program.nodes[o.enabled].ty.base !== 'bool')
                bad(where, 'enabled must be a fixed true/false value');
        }
        if (o.color !== undefined && (!(o.color >= 0 && o.color < n) || program.nodes[o.color].ty.base !== 'color'))
            bad(where, 'color must be a colour node');
        if (o.kind === 'fill') {
            if (o.other === undefined || !(o.other >= 0 && o.other < n))
                bad(where, 'fill needs a second line');
            else if (!isNumberish(program.nodes[o.other].ty.base) || !isNumberish(t.base))
                bad(where, 'fill needs two number series');
        }
        else if (o.other !== undefined)
            bad(where, 'only a fill carries a second line');
        if ((o.width !== undefined || o.offset !== undefined) && o.kind !== 'plot')
            bad(where, 'only a plot carries a width or an offset');
        if (o.width !== undefined && !(Number.isInteger(o.width) && o.width >= 1 && o.width <= PLOT_LINEWIDTH_MAX))
            bad(where, `width is a whole number from 1 to ${PLOT_LINEWIDTH_MAX}`);
        if (o.offset !== undefined && !(Number.isInteger(o.offset) && o.offset >= 0 && o.offset <= PLOT_OFFSET_MAX))
            bad(where, `offset is a whole number from 0 to ${PLOT_OFFSET_MAX}`);
        const needsCondition = ['result', 'mark', 'bgcolor', 'alert', 'entry', 'exit'].includes(o.kind);
        if (needsCondition && t.base !== 'bool' && t.base !== 'any' && t.base !== 'na')
            bad(where, `${o.kind} needs a true/false value`);
        if (['show', 'plot', 'alert'].includes(o.kind) && (o.label === undefined || o.label.length === 0))
            bad(where, `${o.kind} needs a label`);
        // A stop or a target may be a series (read on the signal candlestick by the simulator); a trail is a fixed percent.
        if (o.kind === 'trail' && t.series)
            bad(where, `${o.kind} needs a fixed percent`);
        if (o.sizePct !== undefined && (o.kind !== 'take_profit' || typeof o.sizePct !== 'number' || !(o.sizePct >= 1 && o.sizePct <= 99)))
            bad(where, 'size_pct is a number from 1 to 99 on a take_profit only');
        if (o.kind === 'leg') {
            if (t.series)
                bad(where, 'leg needs a fixed number of lots');
            if (!o.leg)
                bad(where, 'leg needs what it trades');
        }
        else if (o.leg !== undefined)
            bad(where, 'only a leg carries leg');
    });
    const results = program.outputs.filter((o) => o.kind === 'result').length;
    if ((program.kind === 'screener' || program.kind === 'bare-screener') && results !== 1)
        bad('outputs', `a screener needs exactly one result, found ${results}`);
    if (program.kind !== 'screener' && program.kind !== 'bare-screener' && results !== 0)
        bad('outputs', 'only a screener has a result');
    // A `state` value may only be used inside the body of the scan with the same slot: every value that
    // depends on one is consumed by that scan, so nothing that depends on a state reaches an output.
    const needs = program.nodes.map(() => new Set());
    program.nodes.forEach((node, i) => {
        if (node.op === 'state')
            needs[i].add(node.slot);
        for (const r of refsOf(node))
            for (const slot of needs[r])
                needs[i].add(slot);
        if (node.op === 'scan')
            needs[i].delete(node.slot);
    });
    const leaks = (r, what) => {
        if (r !== undefined && r >= 0 && r < n && needs[r].size > 0)
            bad(what, `uses a scan state (${[...needs[r]].join(', ')}) outside its scan`);
    };
    program.outputs.forEach((o, k) => {
        leaks(o.value, `output ${k}`);
        leaks(o.enabled, `output ${k}`);
        leaks(o.color, `output ${k}`);
        leaks(o.other, `output ${k}`);
    });
    return problems;
}
