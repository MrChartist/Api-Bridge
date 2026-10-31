// A digest of everything in the standard library that changes what a script means: names, settings (kind, range, default,
// order), what a call gives back, the data it needs and its causality tag. Not the plain-words text. A test pins it
// (`stdlib.golden.json`), so a change to the library cannot slip in without a new version.
import { sha256Hex } from '../hash/sha256.js';
import { FUNCTIONS, VALUES } from './manifest.js';
function canonical(v) {
    return JSON.stringify(v, (_k, x) => {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
            return Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]));
        }
        return x;
    });
}
export function stdlibDigest() {
    const fns = FUNCTIONS.map((f) => ({ name: f.name, params: f.params, returns: f.returns, requires: f.requires, tag: f.tag, lag: f.lag ?? null, history: f.history ?? false, warmup: f.warmup ?? null }));
    const vals = VALUES.map((v) => ({ name: v.name, base: v.base, shape: v.shape, requires: v.requires, tag: v.tag }));
    return sha256Hex(canonical({ functions: fns, values: vals }));
}
