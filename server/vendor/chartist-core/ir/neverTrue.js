export const NEVER_TRUE_CODE = 'W-NEVER-TRUE';
const AT_MOST_HIGH = new Set(['close', 'open', 'high']);
const AT_LEAST_LOW = new Set(['close', 'open', 'low']);
export function neverTrueNodes(program) {
    const nodes = program.nodes;
    const field = (id) => {
        const n = nodes[id];
        return n.op === 'field' ? { field: n.field, frame: String(n.frame) } : null;
    };
    /** `x` when node `id` is `fn(x, n)`. */
    const windowArg = (id, fn) => {
        const n = nodes[id];
        return n.op === 'call' && n.fn === fn && n.args.length >= 2 ? n.args[0] : null;
    };
    /** `a` can never be above `b` because `b` is the highest of a window that includes `a` itself. */
    const neverAbove = (a, b) => {
        const x = windowArg(b, 'ta.highest');
        if (x === null)
            return false;
        if (x === a)
            return true;
        const fa = field(a);
        const fx = field(x);
        return fa !== null && fx !== null && fx.field === 'high' && fa.frame === fx.frame && AT_MOST_HIGH.has(fa.field);
    };
    const neverBelow = (a, b) => {
        const x = windowArg(b, 'ta.lowest');
        if (x === null)
            return false;
        if (x === a)
            return true;
        const fa = field(a);
        const fx = field(x);
        return fa !== null && fx !== null && fx.field === 'low' && fa.frame === fx.frame && AT_LEAST_LOW.has(fa.field);
    };
    const found = [];
    nodes.forEach((n, id) => {
        if (n.op === 'cmp') {
            if (n.kind === 'gt' && neverAbove(n.a, n.b))
                found.push({ node: id, side: 'above' });
            else if (n.kind === 'lt' && neverAbove(n.b, n.a))
                found.push({ node: id, side: 'above' });
            else if (n.kind === 'lt' && neverBelow(n.a, n.b))
                found.push({ node: id, side: 'below' });
            else if (n.kind === 'gt' && neverBelow(n.b, n.a))
                found.push({ node: id, side: 'below' });
        }
        else if (n.op === 'call' && n.args.length === 2) {
            if (n.fn === 'ta.crossover' && neverAbove(n.args[0], n.args[1]))
                found.push({ node: id, side: 'above' });
            else if (n.fn === 'ta.crossunder' && neverBelow(n.args[0], n.args[1]))
                found.push({ node: id, side: 'below' });
        }
    });
    return found;
}
