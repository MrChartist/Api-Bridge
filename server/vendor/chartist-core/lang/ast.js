/** The script types a function can be marked with, for example @screener. */
export const ENTRY_KINDS = ['screener', 'indicator', 'alert', 'strategy'];
/** The direct children of a node, in source order. */
export function childrenOf(node) {
    switch (node.kind) {
        case 'Number':
        case 'String':
        case 'Bool':
        case 'Na':
        case 'Name':
        case 'Pass':
            return [];
        case 'Attribute': return [node.value];
        case 'Subscript': return [node.value, node.index];
        case 'Arg': return [node.value];
        case 'Call': return [node.func, ...node.args];
        case 'Unary': return [node.operand];
        case 'Binary': return [node.left, node.right];
        case 'BoolOp': return node.values;
        case 'Compare': return [node.left, ...node.comparators];
        case 'IfExp': return [node.body, node.test, node.orelse];
        case 'Tuple': return node.elts;
        case 'List': return node.elts;
        case 'ListComp': return [node.elt, node.target, node.iter];
        case 'Lambda': return [node.body];
        case 'Assign': return [...node.targets, node.value];
        case 'ExprStmt': return [node.value];
        case 'Return': return [node.value];
        case 'If': return [node.test, ...node.body, ...node.orelse];
        case 'Param': return node.default ? [node.default] : [];
        case 'Decorator': return node.args ?? [];
        case 'FunctionDef': return [...node.decorators, ...node.params, ...node.body];
        case 'Module': return node.body;
    }
}
/**
 * Count the nodes and find the deepest nesting without recursion, so a hostile script
 * cannot overflow the stack. Reports the first node that goes over either limit.
 */
export function measureTree(root, maxNodes, maxDepth) {
    const stack = [{ node: root, depth: 1 }];
    let nodes = 0;
    let depth = 0;
    let tooDeep;
    let tooMany;
    while (stack.length > 0) {
        const { node, depth: d } = stack.pop();
        nodes++;
        if (d > depth)
            depth = d;
        if (d > maxDepth && !tooDeep)
            tooDeep = node;
        if (nodes > maxNodes && !tooMany)
            tooMany = node;
        if (tooDeep && tooMany)
            break;
        const kids = childrenOf(node);
        for (let i = kids.length - 1; i >= 0; i--)
            stack.push({ node: kids[i], depth: d + 1 });
    }
    return { nodes, depth, tooDeep, tooMany };
}
const IGNORED_KEYS = new Set(['span', 'comments', 'elseLine', 'defLine']);
/**
 * A copy of a tree without positions and comments, for comparing shapes in tests and for
 * hashing. Safe to call on trees that have passed the size limits.
 */
export function stripSpans(value) {
    if (Array.isArray(value))
        return value.map(stripSpans);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (!IGNORED_KEYS.has(k))
                out[k] = stripSpans(v);
        }
        return out;
    }
    return value;
}
