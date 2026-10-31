import { PURE_HASH } from '../hash/provider.js';
import { canonicalJson } from './canonical.js';
/** The object that is hashed: no floats, symbols reduced to one hash, params normalised. Exported so tests can read it. */
export function runIdInput(i, hash = PURE_HASH) {
    for (let k = 1; k < i.universe.symbols.length; k++) {
        if (!(i.universe.symbols[k] > i.universe.symbols[k - 1]))
            throw new RangeError('universe symbols must be strictly ascending');
    }
    const params = {};
    for (const k of Object.keys(i.params).sort()) {
        const v = i.params[k];
        params[k] = typeof v === 'number' && !Number.isInteger(v) ? String(v) : v;
    }
    return {
        irHash: i.irHash, stdlibV: i.stdlibV, engineV: i.engineV, dataV: i.dataV, costTableV: i.costTableV, calendarV: i.calendarV,
        universe: { spec: i.universe.spec, count: i.universe.symbols.length, symbolsHash: hash.sha256Hex(i.universe.symbols.join('\n')) },
        params, split: i.split, seed: i.seed,
    };
}
export function computeRunId(i, hash = PURE_HASH) {
    return hash.sha256Hex(canonicalJson(runIdInput(i, hash)));
}
