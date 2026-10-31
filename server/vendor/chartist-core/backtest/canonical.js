// The canonical form that `runId` is a hash of (docs/adr/0003). Same inputs, same bytes, on any machine and any key order.
//
// Rules: object keys sorted; arrays keep their order; strings as JSON; booleans and null as they are; integers only for numbers
// (money is integer paise, a ratio is a string with fixed decimals, see `fixed`); NaN, Infinity and non-integers are refused with
// the path, because a float inside a hash input is how two machines end up with two ids for one run.
export class CanonicalError extends Error {
    path;
    code = 'E-CANON';
    constructor(message, path) {
        super(`${message} at ${path}`);
        this.path = path;
        this.name = 'CanonicalError';
    }
}
export function canonicalJson(value, path = '$') {
    if (value === null)
        return 'null';
    switch (typeof value) {
        case 'string': return JSON.stringify(value);
        case 'boolean': return value ? 'true' : 'false';
        case 'number':
            if (!Number.isSafeInteger(value))
                throw new CanonicalError(`${String(value)} is not a safe integer (use integer paise, or a fixed-decimal string)`, path);
            return Object.is(value, -0) ? '0' : String(value);
        case 'object': {
            if (Array.isArray(value)) {
                return `[${value.map((v, i) => {
                    if (v === undefined)
                        throw new CanonicalError('an array holds undefined', `${path}[${i}]`);
                    return canonicalJson(v, `${path}[${i}]`);
                }).join(',')}]`;
            }
            const o = value;
            const parts = [];
            for (const key of Object.keys(o).sort()) {
                if (o[key] === undefined)
                    continue; // an absent field and an undefined one are the same thing
                parts.push(`${JSON.stringify(key)}:${canonicalJson(o[key], `${path}.${key}`)}`);
            }
            return `{${parts.join(',')}}`;
        }
        default:
            throw new CanonicalError(`a ${typeof value} cannot be hashed`, path);
    }
}
/** A ratio as text with a fixed number of decimals (no locale, no grouping): `fixed(0.1 + 0.2, 6)` is "0.300000". */
export function fixed(x, decimals) {
    if (!Number.isFinite(x))
        throw new CanonicalError(`${String(x)} is not a number`, '$');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12)
        throw new RangeError('decimals must be a whole number from 0 to 12');
    const s = x.toFixed(decimals);
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}
/** Integer paise from rupees, rounded half away from zero (the only rounding the money side uses). */
export function toPaise(rupees) {
    if (!Number.isFinite(rupees))
        throw new RangeError('rupees must be a finite number');
    const p = Math.round(Math.abs(rupees) * 100 + 1e-9);
    return rupees < 0 ? -p : p;
}
export const fromPaise = (paise) => paise / 100;
