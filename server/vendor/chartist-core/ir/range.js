// The range a fixed node can take (a number, a setting, or arithmetic on them). Used to bound how much
// history a script needs and to decide whether `**` stays whole-number. Works on any node reference.
import { settingRange } from '../check/settings.js';
/**
 * Range of a fixed node, or undefined when the node is not a fixed value or cannot be bounded this way.
 *
 * Memoised per walk: nodes are interned, so `a = b + b` shares one child. Walked as a tree, 28 lines of
 * `aN = a(N-1) + a(N-1)` took 22 s to check and each extra line doubled it (found 2026-10-20).
 *
 * The answer is exactly the old tree walk's, depth limit included: each cached result keeps the height of the subtree
 * it walked, and is reused at depth d only when d + height stays within MAX_DEPTH (past it the tree walk would have
 * stopped and answered undefined). A result cut off by the limit depends on where it was reached, so it is never
 * cached (height Infinity). Without this, the limit depended on operand order (`x + y` bounded, `y + x` not).
 */
const MAX_DEPTH = 200;
export function rangeOf(ref, view, depth = 0) {
    return walk(ref, view, depth, { done: new Map(), cut: new Map() }).r;
}
const CUT = { r: undefined, h: Infinity };
// Each node is computed at most once, plus once per shallower depth it is reached at after being cut off: bounded
// by nodes x MAX_DEPTH, never exponential.
function walk(ref, view, depth, memo) {
    if (depth > MAX_DEPTH)
        return CUT;
    const hit = memo.done.get(ref);
    if (hit)
        return depth + hit.h > MAX_DEPTH ? CUT : hit;
    const cutAt = memo.cut.get(ref);
    if (cutAt !== undefined && depth >= cutAt)
        return CUT;
    let h = 0;
    const sub = (x) => {
        const w = walk(x, view, depth + 1, memo);
        h = Math.max(h, w.h + 1);
        return w.r;
    };
    const out = { r: compute(ref, view, sub), h };
    if (Number.isFinite(out.h))
        memo.done.set(ref, out);
    else
        memo.cut.set(ref, Math.min(cutAt ?? Infinity, depth));
    return Number.isFinite(out.h) ? out : CUT;
}
function compute(ref, view, rangeOf) {
    const o = view.op(ref);
    switch (o.op) {
        case 'const': return typeof o.value === 'number' ? { lo: o.value, hi: o.value } : undefined;
        case 'input': {
            const i = view.input(o.name);
            if (!i || (i.type !== 'int' && i.type !== 'float'))
                return undefined;
            return settingRange(i.type, i.default, i.min, i.max);
        }
        case 'neg': {
            const r = rangeOf(o.x);
            if (!r)
                return undefined;
            const out = {};
            if (r.hi !== undefined)
                out.lo = -r.hi;
            if (r.lo !== undefined)
                out.hi = -r.lo;
            return out;
        }
        case 'bin': {
            const a = rangeOf(o.a);
            if (!a)
                return undefined;
            const b = rangeOf(o.b);
            if (!b)
                return undefined;
            if (a.lo === undefined || a.hi === undefined || b.lo === undefined || b.hi === undefined)
                return {};
            if (o.kind === 'add')
                return { lo: a.lo + b.lo, hi: a.hi + b.hi };
            if (o.kind === 'sub')
                return { lo: a.lo - b.hi, hi: a.hi - b.lo };
            if (o.kind === 'mul') {
                const ps = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
                return { lo: Math.min(...ps), hi: Math.max(...ps) };
            }
            return {};
        }
        case 'call': {
            if ((o.fn === 'min' || o.fn === 'max') && o.args.length === 2) {
                const a = rangeOf(o.args[0]);
                const b = rangeOf(o.args[1]);
                if (!a || !b || a.lo === undefined || a.hi === undefined || b.lo === undefined || b.hi === undefined)
                    return a && b ? {} : undefined;
                return o.fn === 'min' ? { lo: Math.min(a.lo, b.lo), hi: Math.min(a.hi, b.hi) } : { lo: Math.max(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
            }
            return undefined;
        }
        default: return undefined;
    }
}
