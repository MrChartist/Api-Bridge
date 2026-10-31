const num = (n) => (Object.is(n, -0) ? '0' : String(n));
export function constKey(base, value) {
    const v = value === null ? 'na' : typeof value === 'boolean' ? (value ? 'true' : 'false') : typeof value === 'number' ? num(value) : JSON.stringify(value);
    return `c|${base}|${v}`;
}
/** The text a node is hashed from. `R` are the digests of the nodes it refers to. */
export function opKey(op) {
    switch (op.op) {
        case 'const': return constKey(op.base, op.value);
        case 'input': return `i|${JSON.stringify(op.name)}`;
        case 'field': return `f|${op.field}|${op.frame}|${op.partial ? 1 : 0}`;
        case 'bench': return `b|${op.field}`;
        case 'ref': return `r|${JSON.stringify(op.symbol)}|${op.field}`;
        case 'value': return `v|${op.name}`;
        case 'shift': return `sh|${op.x}|${op.k}`;
        case 'neg': return `neg|${op.x}`;
        case 'not': return `not|${op.x}`;
        case 'bin': return `bin|${op.kind}|${op.a}|${op.b}`;
        case 'cmp': return `cmp|${op.kind}|${op.a}|${op.b}`;
        case 'and': return `and|${op.args.join(',')}`;
        case 'or': return `or|${op.args.join(',')}`;
        case 'select': return `sel|${op.cond}|${op.a}|${op.b}`;
        case 'align': return `al|${op.x}|${op.to}|${op.partial ? 1 : 0}`;
        case 'call': return `call|${op.fn}|${op.out ?? ''}|${op.args.join(',')}`;
        case 'state': return `st|${op.slot}|${op.base}`;
        case 'scan': return `scan|${op.slot}|${op.init}|${op.body}`;
    }
}
export function digestOf(op, hash) {
    return hash.sha256Hex(opKey(op));
}
