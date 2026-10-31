// The standard normal distribution, to near double precision, with no library.
//
// Middle of the range: Marsaglia's series  Phi(x) = 1/2 + phi(x) * (x + x^3/3 + x^5/(3*5) + x^7/(3*5*7) + ...),
// published in "Evaluating the Normal Distribution", Journal of Statistical Software 11(5), 2004. Every term is
// positive for x > 0, so there is no cancellation. Far tails: the continued fraction
// Q(x) = phi(x) / (x + 1/(x + 2/(x + 3/(x + ...)))), so a tail probability keeps its relative precision.
const INV_SQRT_2PI = 0.3989422804014327;
const SERIES_LIMIT = 3;
export function normPdf(x) {
    return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}
/** Upper tail Q(x) = 1 - Phi(x) for x >= SERIES_LIMIT, by the continued fraction (evaluated from the bottom up). */
function upperTail(x) {
    let f = x;
    for (let k = 200; k >= 1; k--)
        f = x + k / f;
    return normPdf(x) / f;
}
/** Cumulative distribution Phi(x). NaN in, NaN out. */
export function normCdf(x) {
    if (Number.isNaN(x))
        return NaN;
    const a = Math.abs(x);
    if (a >= SERIES_LIMIT) {
        const q = upperTail(a);
        return x > 0 ? 1 - q : q;
    }
    let term = a;
    let sum = a;
    for (let n = 1; term > 1e-17 * sum; n++) {
        term *= (a * a) / (2 * n + 1);
        sum += term;
        if (n > 500)
            break;
    }
    const p = 0.5 + normPdf(a) * sum;
    return x >= 0 ? p : 1 - p;
}
