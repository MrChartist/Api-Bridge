// Black-76 pricing of European options on a forward (index and stock options on NSE settle against the future).
// All times are in years and every rate is a continuously compounded annual rate, as plain numbers.
//
// Price:   call = DF * (F N(d1) - K N(d2))      put = DF * (K N(-d2) - F N(-d1))
//          d1 = (ln(F/K) + sigma^2 T / 2) / (sigma sqrt(T))      d2 = d1 - sigma sqrt(T)      DF = exp(-r T)
// Black, "The pricing of commodity contracts", Journal of Financial Economics 3 (1976). Conventions that are a
// choice and not a fact (day count, which rate, which forward) are parameters here, not constants: Needs
// verification before any result is shown to a user (see docs/features/derivatives/README.md).
import { normCdf, normPdf } from './normal.js';
export const MAX_VOL = 5;
const MIN_VOL = 1e-8;
const valid = (i) => Number.isFinite(i.forward) && i.forward > 0 && Number.isFinite(i.strike) && i.strike > 0 &&
    Number.isFinite(i.years) && i.years >= 0 && Number.isFinite(i.rate) && (i.side === 'CE' || i.side === 'PE');
export const discount = (rate, years) => Math.exp(-rate * years);
/** Value at expiry (or with no volatility): discounted intrinsic value. */
export function intrinsic(i) {
    const df = discount(i.rate, i.years);
    return df * (i.side === 'CE' ? Math.max(i.forward - i.strike, 0) : Math.max(i.strike - i.forward, 0));
}
function d1d2(i, vol) {
    const sd = vol * Math.sqrt(i.years);
    const d1 = (Math.log(i.forward / i.strike) + 0.5 * sd * sd) / sd;
    return { d1, d2: d1 - sd, sd };
}
/** Option price. NaN for input that makes no sense. At zero time or zero volatility it is the intrinsic value. */
export function black76Price(i, vol) {
    if (!valid(i) || !Number.isFinite(vol) || vol < 0)
        return NaN;
    if (i.years === 0 || vol === 0)
        return intrinsic(i);
    const { d1, d2 } = d1d2(i, vol);
    const df = discount(i.rate, i.years);
    return i.side === 'CE'
        ? df * (i.forward * normCdf(d1) - i.strike * normCdf(d2))
        : df * (i.strike * normCdf(-d2) - i.forward * normCdf(-d1));
}
/** Greeks of the price above. All NaN when the price is not defined; time value gone gives only delta and rho. */
export function black76Greeks(i, vol) {
    const bad = { delta: NaN, gamma: NaN, vega: NaN, theta: NaN, rho: NaN };
    if (!valid(i) || !Number.isFinite(vol) || vol < 0)
        return bad;
    const df = discount(i.rate, i.years);
    if (i.years === 0 || vol === 0) {
        const inTheMoney = i.side === 'CE' ? i.forward > i.strike : i.forward < i.strike;
        return { delta: inTheMoney ? (i.side === 'CE' ? df : -df) : 0, gamma: 0, vega: 0, theta: 0, rho: -i.years * intrinsic(i) };
    }
    const { d1, sd } = d1d2(i, vol);
    const price = black76Price(i, vol);
    const pdf = normPdf(d1);
    return {
        delta: i.side === 'CE' ? df * normCdf(d1) : -df * normCdf(-d1),
        gamma: (df * pdf) / (i.forward * sd),
        vega: df * i.forward * pdf * Math.sqrt(i.years),
        theta: i.rate * price - (df * i.forward * pdf * vol) / (2 * Math.sqrt(i.years)),
        rho: -i.years * price,
    };
}
/** Absolute price tolerance (relative to the price, with a floor) at which the inversion stops. */
const PRICE_TOL = 1e-12;
/**
 * Implied volatility: the vol at which the model price equals `price`.
 *
 * Refused, with the reason, when no volatility can produce the price: below discounted intrinsic value; at it
 * (the time value is zero, so volatility is undefined); at or above the largest price an option can have
 * (the discounted forward for a call, the discounted strike for a put); above the price at a volatility of 500%;
 * or when there is no time left. A refusal is data, not an error: a caller drops that strike and counts it.
 *
 * Method: Newton's method on vega with a bisection bracket that is shrunk on every step, so it cannot leave the
 * bracket or stall where vega is tiny. Starts from the Brenner-Subrahmanyam guess.
 */
export function impliedVol(price, i) {
    if (!valid(i) || !Number.isFinite(price) || price < 0)
        return { ok: false, reason: 'bad_input' };
    if (i.years === 0)
        return { ok: false, reason: 'no_time' };
    const df = discount(i.rate, i.years);
    const floor = intrinsic(i);
    const cap = df * (i.side === 'CE' ? i.forward : i.strike);
    const slack = 1e-9 * Math.max(1, cap);
    if (price < floor - slack)
        return { ok: false, reason: 'below_intrinsic' };
    if (price <= floor + slack)
        return { ok: false, reason: 'at_intrinsic' };
    if (price >= cap - slack)
        return { ok: false, reason: 'above_maximum' };
    if (price > black76Price(i, MAX_VOL))
        return { ok: false, reason: 'too_high' };
    let lo = MIN_VOL;
    let hi = MAX_VOL;
    const guess = (Math.sqrt((2 * Math.PI) / i.years) * price) / (df * i.forward);
    let vol = Math.min(Math.max(guess, 0.05), 2);
    const tol = PRICE_TOL * Math.max(1, price);
    for (let n = 1; n <= 200; n++) {
        const diff = black76Price(i, vol) - price;
        if (Math.abs(diff) <= tol || hi - lo < 1e-15)
            return { ok: true, iv: vol, iterations: n };
        if (diff > 0)
            hi = vol;
        else
            lo = vol;
        const vega = black76Greeks(i, vol).vega;
        let next = vega > 1e-14 ? vol - diff / vega : NaN;
        if (!(next > lo && next < hi))
            next = 0.5 * (lo + hi);
        vol = next;
    }
    return { ok: false, reason: 'no_convergence' };
}
/** Forward implied by a call and a put at the same strike: F = K + (C - P) / DF (put-call parity). */
export function forwardFromParity(call, put, strike, rate, years) {
    return strike + (call - put) / discount(rate, years);
}
