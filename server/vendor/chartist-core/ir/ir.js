/** Script-type-line keys that change results. */
export const PARAM_KEYS = ['universe', 'benchmark', 'capital', 'rebalance', 'max_positions', 'sizing', 'costs', 'from_', 'to', 'split', 'underlying', 'margin_pct', 'max_hold'];
/** Script-type-line keys that only change how results look. */
export const META_KEYS = ['name', 'overlay'];
export const BIN_SYMBOL = { add: '+', sub: '-', mul: '*', div: '/', floordiv: '//', mod: '%', pow: '**' };
export const CMP_SYMBOL = { lt: '<', le: '<=', gt: '>', ge: '>=', eq: '==', ne: '!=' };
/** The nodes an op refers to, in order. */
export function refsOf(n) {
    switch (n.op) {
        case 'const':
        case 'input':
        case 'field':
        case 'bench':
        case 'ref':
        case 'value':
        case 'state': return [];
        case 'shift': return [n.x, n.k];
        case 'neg':
        case 'not': return [n.x];
        case 'bin':
        case 'cmp': return [n.a, n.b];
        case 'and':
        case 'or': return n.args;
        case 'select': return [n.cond, n.a, n.b];
        case 'align': return [n.x];
        case 'call': return n.args;
        case 'scan': return [n.init, n.body];
    }
}
