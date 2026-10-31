// What an option position pays (a strategy builder's numbers), from legs whose premium is known: the payoff at expiry and today, the
// breakevens, the most it can make and lose, the net greeks and the chance of finishing above zero. Plain maths on Black-76 (the
// futures-style model the package uses for index options); no data of its own. Quantities are in units (lots x lot size).
//
// Conventions, written down so a test can pin them:
//  - The payoff at expiry is linear between strikes, so its extremes and zero crossings are found exactly on the strikes and two
//    far points; a slope that stays positive (or negative) beyond the last (first) strike means an unlimited profit or loss.
//  - "Today" is valued with Black-76 on the given forward, volatility, rate and time; a leg of a future is worth forward - entry.
//  - The probability of profit is the chance, under a lognormal forward with the given volatility, that the expiry payoff is above
//    zero. It is a model's number, not a forecast.
import { black76Greeks, black76Price } from './black76.js';
import { normCdf } from './normal.js';
const sign = (l) => (l.side === 'buy' ? 1 : -1);
/** One leg's value at expiry for an underlying price, net of its premium. */
export function legExpiryValue(l, price) {
    const s = sign(l) * l.quantity;
    if (l.right === 'future')
        return s * (price - l.premium);
    const intrinsic = l.right === 'call' ? Math.max(0, price - l.strike) : Math.max(0, l.strike - price);
    return s * (intrinsic - l.premium);
}
export function expiryPayoff(legs, price) {
    let v = 0;
    for (const l of legs)
        v += legExpiryValue(l, price);
    return v;
}
function todayValue(input, price) {
    const rate = input.rate ?? 0;
    let v = 0;
    for (const l of input.legs) {
        const s = sign(l) * l.quantity;
        if (l.right === 'future' || input.years <= 0) {
            v += legExpiryValue(l, price);
            continue;
        }
        const theo = black76Price({ side: l.right === 'call' ? 'CE' : 'PE', forward: price, strike: l.strike, years: input.years, rate }, l.vol ?? input.vol);
        v += s * (theo - l.premium);
    }
    return v;
}
export function optionPayoff(input) {
    if (!(input.forward > 0))
        throw new RangeError('forward must be above 0');
    if (!(input.vol > 0))
        throw new RangeError('vol must be above 0');
    if (input.legs.length === 0)
        throw new RangeError('a payoff needs at least one leg');
    const grid = input.grid ?? Array.from({ length: 121 }, (_, i) => input.forward * (0.7 + (0.6 * i) / 120));
    const points = grid.map((price) => ({ price, expiry: expiryPayoff(input.legs, price), today: todayValue(input, price) }));
    // Exact extremes: the expiry payoff is linear between strikes.
    const strikes = [...new Set(input.legs.filter((l) => l.right !== 'future').map((l) => l.strike))].sort((a, b) => a - b);
    const knots = [0, ...strikes];
    const slopeAbove = input.legs.reduce((s, l) => s + sign(l) * l.quantity * (l.right === 'put' ? 0 : 1), 0);
    const values = knots.map((k) => expiryPayoff(input.legs, k));
    const finiteMax = Math.max(...values);
    const finiteMin = Math.min(...values);
    const maxProfit = slopeAbove > 1e-12 ? null : finiteMax;
    const maxLoss = slopeAbove < -1e-12 ? null : finiteMin;
    // Zero crossings on each linear piece, and beyond the last knot.
    const breakevens = [];
    const pushRoot = (x) => { if (x > 0 && !breakevens.some((b) => Math.abs(b - x) < 1e-6))
        breakevens.push(x); };
    for (let i = 0; i < knots.length - 1; i++) {
        const [a, b] = [knots[i], knots[i + 1]];
        const [fa, fb] = [values[i], values[i + 1]];
        if (fa === 0)
            pushRoot(a);
        if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0))
            pushRoot(a + ((b - a) * fa) / (fa - fb));
    }
    const last = knots[knots.length - 1];
    const fLast = values[values.length - 1];
    if (fLast === 0)
        pushRoot(last);
    if (Math.abs(slopeAbove) > 1e-12 && fLast * slopeAbove < 0)
        pushRoot(last - fLast / slopeAbove);
    breakevens.sort((a, b) => a - b);
    const rate = input.rate ?? 0;
    const greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };
    for (const l of input.legs) {
        const s = sign(l) * l.quantity;
        if (l.right === 'future') {
            greeks.delta += s;
            continue;
        }
        if (input.years <= 0)
            continue;
        const g = black76Greeks({ side: l.right === 'call' ? 'CE' : 'PE', forward: input.forward, strike: l.strike, years: input.years, rate }, l.vol ?? input.vol);
        greeks.delta += s * g.delta;
        greeks.gamma += s * g.gamma;
        greeks.vega += s * g.vega;
        greeks.theta += s * g.theta;
    }
    const netPremium = input.legs.reduce((s, l) => s + (l.right === 'future' ? 0 : -sign(l) * l.quantity * l.premium), 0);
    return { points, breakevens, maxProfit, maxLoss, netPremium, greeks, probabilityOfProfit: probabilityOfProfit(input, breakevens) };
}
/** P(payoff at expiry > 0) for a lognormal forward: sums the probability of the price intervals between breakevens that are profitable. */
function probabilityOfProfit(input, breakevens) {
    if (!(input.years > 0))
        return null;
    const sd = input.vol * Math.sqrt(input.years);
    const cdf = (x) => (x <= 0 ? 0 : normCdf((Math.log(x / input.forward) + 0.5 * sd * sd) / sd));
    const edges = [0, ...breakevens, Number.POSITIVE_INFINITY];
    let p = 0;
    for (let i = 0; i < edges.length - 1; i++) {
        const lo = edges[i];
        const hi = edges[i + 1];
        const mid = Number.isFinite(hi) ? (lo + hi) / 2 : Math.max(lo * 1.5, input.forward * 2);
        if (expiryPayoff(input.legs, mid) > 0)
            p += (Number.isFinite(hi) ? cdf(hi) : 1) - cdf(lo);
    }
    return Math.min(1, Math.max(0, p));
}
