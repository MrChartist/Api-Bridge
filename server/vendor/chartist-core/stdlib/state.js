// Bounded state without a loop (ROADMAP "Bounded state", LANGUAGE-GAPS A1): the running functions that carry a value from one
// candlestick to the next, each in one forward pass with a fixed amount of memory. The script stays loop-free and causal: the
// value at candlestick i is worked out from candlesticks 0 to i only (src/__tests__/stateCausality.test.ts cuts and replaces the
// data to prove it). Meanings are in SPEC section 12.3; the slow reference definitions are in src/__tests__/reference/kernels.ts.
import { RuntimeError } from '../runtime/errors.js';
const U = Number.NaN;
const isU = (x) => x !== x;
const at = (x, i) => (typeof x === 'number' ? x : x[i]);
/**
 * Running total of x since the last candlestick where `reset` was true, that candlestick included; before the first reset (or with
 * no reset) since the first candlestick. A missing x is missing at its own candlestick and adds nothing. A missing reset makes the
 * total missing until reset is next true, because nobody knows whether the total restarted there.
 */
export function accumulate(x, reset, n) {
    const out = new Float64Array(n).fill(U);
    let total = 0;
    let known = true;
    for (let i = 0; i < n; i++) {
        const r = at(reset, i);
        if (isU(r)) {
            known = false;
            continue;
        }
        if (r) {
            total = 0;
            known = true;
        }
        const v = at(x, i);
        if (isU(v))
            continue;
        total += v;
        if (known)
            out[i] = total;
    }
    return out;
}
/**
 * x on the (k+1)-th most recent candlestick where the condition was true (k = 0 is ta.value_when's usual answer). Keeps the last
 * k+1 values in a ring. A missing condition empties the ring: it may have been a true, so how far back the k-th true lies is not
 * known until k+1 trues have been seen again.
 */
export function valueWhenNth(c, x, k, n) {
    const out = new Float64Array(n).fill(U);
    const size = k + 1;
    const ring = new Float64Array(size);
    let seen = 0;
    let head = 0;
    for (let i = 0; i < n; i++) {
        const now = at(c, i);
        if (isU(now)) {
            seen = 0;
            continue;
        }
        if (now) {
            ring[head] = at(x, i);
            head = (head + 1) % size;
            if (seen < size)
                seen++;
        }
        // The newest is at head - 1, the k-th before it at head - 1 - k, which is head itself once the ring is full.
        if (seen === size)
            out[i] = ring[head];
    }
    return out;
}
const operand = (ctx, k) => {
    const a = ctx.args[k];
    if (!a)
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} was called without argument ${k + 1}`);
    if ('s' in a)
        return a.s;
    if ('c' in a)
        return a.c;
    throw new RuntimeError('E-RT-ARGS', `${ctx.fn} got text where a number was expected`);
};
/** The occurrence of ta.value_when: left out (or a stored program from before it existed) means 0. */
const occurrence = (ctx) => {
    const a = ctx.args[2];
    if (a === undefined)
        return 0;
    if (!('c' in a) || !Number.isInteger(a.c) || a.c < 0 || a.c > 50)
        throw new RuntimeError('E-RT-ARGS', `${ctx.fn} needs a whole number from 0 to 50 as its occurrence`);
    return a.c;
};
export const STATE_FUNCTIONS = {
    'ta.accumulate': (c) => accumulate(operand(c, 0), operand(c, 1), c.n),
    'ta.value_when': (c) => valueWhenNth(operand(c, 0), operand(c, 1), occurrence(c), c.n),
};
