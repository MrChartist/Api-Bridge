import { finestFrame, joinBase } from '../check/types.js';
import { fnSpec, valueSpec } from '../stdlib/manifest.js';
export const CONST_TYPE = (base) => ({ base, series: false, frame: 'D', partial: false });
/** Finest frame among the series types; 'D' when none is a series. */
export function finestOf(tys) {
    let f = null;
    for (const t of tys)
        if (t.series)
            f = f === null ? t.frame : finestFrame(f, t.frame);
    return f ?? 'D';
}
export function binBase(kind, a, b, bLowerBound) {
    if (kind === 'div')
        return 'float';
    if (kind === 'pow')
        return a.base === 'int' && b.base === 'int' && bLowerBound !== undefined && bLowerBound >= 0 ? 'int' : 'float';
    if (a.base === 'any' || b.base === 'any')
        return 'any';
    if (a.base === 'na')
        return b.base;
    if (b.base === 'na')
        return a.base;
    return a.base === 'int' && b.base === 'int' ? 'int' : 'float';
}
/** The type an op must have. Throws a plain Error for an op that cannot be typed (a bug or a hand-made IR). */
export function typeOfOp(op, cx) {
    const t = (r) => cx.tyOf(r);
    const anyPartial = (rs) => rs.some((r) => t(r).partial);
    switch (op.op) {
        case 'const': return CONST_TYPE(op.base);
        case 'input': {
            const spec = cx.input(op.name);
            if (!spec)
                throw new Error(`setting \`${op.name}\` is not declared`);
            return CONST_TYPE(spec.type);
        }
        case 'field': return { base: 'float', series: true, frame: op.frame, partial: op.partial };
        case 'bench':
        case 'ref': return { base: 'float', series: true, frame: 'D', partial: false };
        case 'value': {
            const v = valueSpec(op.name);
            if (!v)
                throw new Error(`unknown value \`${op.name}\``);
            return { base: v.base, series: true, frame: 'D', partial: false };
        }
        case 'shift': return { ...t(op.x) };
        case 'neg': return { ...t(op.x) };
        case 'not': return { ...t(op.x), base: 'bool' };
        case 'bin': {
            const a = t(op.a);
            const b = t(op.b);
            const series = a.series || b.series;
            return {
                // Only `**` reads the bound; asking for it on every operator made checking cost grow with the graph.
                base: binBase(op.kind, a, b, op.kind === 'pow' ? cx.lowerBound?.(op.b) : undefined),
                series,
                frame: series ? finestOf([a, b]) : 'D',
                partial: a.partial || b.partial,
            };
        }
        case 'cmp': {
            const a = t(op.a);
            const b = t(op.b);
            const series = a.series || b.series;
            return { base: 'bool', series, frame: series ? finestOf([a, b]) : 'D', partial: a.partial || b.partial };
        }
        case 'and':
        case 'or': {
            const tys = op.args.map(t);
            const series = tys.some((x) => x.series);
            return { base: 'bool', series, frame: series ? finestOf(tys) : 'D', partial: anyPartial(op.args) };
        }
        case 'select': {
            const c = t(op.cond);
            const a = t(op.a);
            const b = t(op.b);
            const base = joinBase(a.base, b.base) ?? 'any';
            const series = c.series || a.series || b.series;
            return { base, series, frame: series ? finestOf([c, a, b]) : 'D', partial: c.partial || a.partial || b.partial };
        }
        case 'align': {
            const x = t(op.x);
            return { ...x, frame: op.to, partial: x.partial || op.partial };
        }
        case 'call': {
            const spec = fnSpec(op.fn);
            if (!spec)
                throw new Error(`unknown function \`${op.fn}\``);
            const args = op.args.map(t);
            const seriesArgs = args.filter((x) => x.series);
            const frame = finestOf(args);
            const partial = anyPartial(op.args);
            const r = spec.returns;
            switch (r.kind) {
                case 'series': {
                    let base;
                    if (r.base === 'like') {
                        const bases = (r.like ?? []).map((n) => spec.params.findIndex((p) => p.name === n)).filter((i) => i >= 0 && i < args.length).map((i) => args[i].base);
                        base = bases.length === 0 ? 'float' : bases.reduce((x, y) => joinBase(x, y) ?? 'float');
                        if (base === 'na')
                            base = 'float';
                    }
                    else
                        base = r.base;
                    const series = Boolean(spec.history) || seriesArgs.length > 0 || spec.params.length === 0;
                    return { base, series, frame: series ? frame : 'D', partial };
                }
                case 'snapshot': return { base: r.base, series: true, frame: 'D', partial: false };
                case 'cross': return { base: r.base, series: true, frame, partial };
                case 'record': {
                    if (op.out === undefined || !Object.hasOwn(r.fields, op.out))
                        throw new Error(`\`${op.fn}\` has no field \`${op.out ?? ''}\``);
                    return { base: r.fields[op.out], series: true, frame, partial };
                }
                default: throw new Error(`\`${op.fn}\` gives no value`);
            }
        }
        case 'state': return { base: op.base, series: true, frame: 'D', partial: false };
        case 'scan': {
            const i = t(op.init);
            const b = t(op.body);
            return { base: joinBase(i.base, b.base) ?? 'any', series: true, frame: finestOf([i, b]), partial: i.partial || b.partial };
        }
    }
}
