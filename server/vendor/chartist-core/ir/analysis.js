import { fnSpec, valueSpec } from '../stdlib/manifest.js';
const FRAME_CAP = {
    D: 'ohlcv:daily',
    W: 'ohlcv:weekly',
    M: 'ohlcv:monthly',
    '1m': 'ohlcv:intraday',
    '5m': 'ohlcv:intraday',
    '15m': 'ohlcv:intraday',
    '30m': 'ohlcv:intraday',
    '1h': 'ohlcv:intraday',
};
const OUTPUT_CAP = {
    show: 'screener-output',
    plot: 'chart-output',
    mark: 'chart-output',
    bgcolor: 'chart-output',
    fill: 'chart-output',
    alert: 'alert-output',
    entry: 'strategy-output',
    exit: 'strategy-output',
    rank: 'strategy-output',
    stop_loss: 'strategy-output',
    take_profit: 'strategy-output',
    trail: 'strategy-output',
};
/** Data the program needs, sorted. */
export function requiresOf(program) {
    const caps = new Set();
    for (const n of program.nodes) {
        switch (n.op) {
            case 'field':
                caps.add(FRAME_CAP[n.frame]);
                break;
            case 'bench':
            case 'ref':
                caps.add('bench');
                break;
            case 'value':
                for (const c of valueSpec(n.name)?.requires ?? [])
                    caps.add(c);
                break;
            case 'call':
                for (const c of fnSpec(n.fn)?.requires ?? [])
                    caps.add(c);
                break;
            default: break;
        }
    }
    for (const o of program.outputs) {
        const c = OUTPUT_CAP[o.kind];
        if (c)
            caps.add(c);
    }
    return [...caps].sort();
}
