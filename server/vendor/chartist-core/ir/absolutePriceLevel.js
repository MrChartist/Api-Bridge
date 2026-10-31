const PRICE_FIELDS = new Set(['open', 'high', 'low', 'close']);
/** Functions whose first series argument is a price and whose result is on the same price scale. */
const PRICE_PRESERVING = new Set([
    'ta.sma', 'ta.ema', 'ta.wma', 'ta.hma', 'ta.rma', 'ta.highest', 'ta.lowest', 'ta.highest_all', 'ta.lowest_all', 'ta.vwap', 'ta.median',
]);
/** Node numbers of comparisons that test a price against a fixed price level. */
export function absolutePriceLevelNodes(program) {
    const nodes = program.nodes;
    const price = new Array(nodes.length).fill(false);
    const fixed = new Array(nodes.length).fill(false);
    const inputIsNumber = new Map(program.inputs.map((i) => [i.name, i.type === 'int' || i.type === 'float']));
    const found = [];
    for (let id = 0; id < nodes.length; id++) {
        const n = nodes[id];
        switch (n.op) {
            // 0 is not a price level: the sign of a price, or of a difference of prices, does not change when history is adjusted (B1-16).
            case 'const':
                fixed[id] = typeof n.value === 'number' && n.value !== 0;
                break;
            case 'input':
                fixed[id] = inputIsNumber.get(n.name) === true;
                break;
            case 'field':
                price[id] = PRICE_FIELDS.has(n.field);
                break;
            case 'shift':
                price[id] = price[n.x];
                break;
            case 'align':
                price[id] = price[n.x];
                break;
            case 'neg':
                price[id] = price[n.x];
                fixed[id] = fixed[n.x];
                break;
            case 'select':
                price[id] = price[n.a] || price[n.b];
                break;
            case 'bin': {
                const a = n.a;
                const b = n.b;
                if (n.kind === 'add' || n.kind === 'sub')
                    price[id] = price[a] || price[b];
                else if (n.kind === 'mul')
                    price[id] = (price[a] && !price[b]) || (price[b] && !price[a]);
                else if (n.kind === 'div')
                    price[id] = price[a] && !price[b];
                if (fixed[a] && fixed[b])
                    fixed[id] = true;
                break;
            }
            case 'call':
                if (PRICE_PRESERVING.has(n.fn) && n.args.length > 0 && price[n.args[0]])
                    price[id] = true;
                break;
            case 'cmp':
                if ((price[n.a] && fixed[n.b]) || (price[n.b] && fixed[n.a]))
                    found.push(id);
                break;
            default: break;
        }
    }
    return found;
}
