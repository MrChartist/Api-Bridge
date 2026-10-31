// Option-chain and futures measures: put-call ratio, max pain, IV rank and percentile, OI build-up, basis.
// All are conventions rather than laws, and each states its convention below (Needs verification where it is a
// choice a user could disagree with). Pure functions over plain rows; no data source.
import { black76Price, impliedVol } from './black76.js';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/** Put OI / call OI. `null` when there is no call open interest (the ratio is undefined, not infinite). */
export function pcrOi(rows) {
    const calls = sum(rows.filter((r) => r.side === 'CE').map((r) => r.oi));
    const puts = sum(rows.filter((r) => r.side === 'PE').map((r) => r.oi));
    return calls > 0 ? puts / calls : null;
}
/** Put volume / call volume. */
export function pcrVolume(rows) {
    const calls = sum(rows.filter((r) => r.side === 'CE').map((r) => r.volume));
    const puts = sum(rows.filter((r) => r.side === 'PE').map((r) => r.volume));
    return calls > 0 ? puts / calls : null;
}
/**
 * Max pain: if the underlying expired exactly at strike K, holders of calls with strike below K collect (K - strike)
 * per unit and holders of puts with strike above K collect (strike - K); weight each by its open interest and add.
 * The strike with the smallest total is "max pain". Candidates are the strikes that appear in the chain. A tie goes
 * to the lower strike (a convention; Needs verification). `null` when there are no rows with open interest.
 */
export function maxPain(rows) {
    const live = rows.filter((r) => r.oi > 0);
    if (live.length === 0)
        return null;
    const strikes = [...new Set(live.map((r) => r.strike))].sort((a, b) => a - b);
    const payout = strikes.map((k) => ({
        strike: k,
        total: sum(live.map((r) => (r.side === 'CE' ? Math.max(k - r.strike, 0) : Math.max(r.strike - k, 0)) * r.oi)),
    }));
    let best = payout[0];
    for (const p of payout)
        if (p.total < best.total)
            best = p;
    return { strike: best.strike, payout };
}
/** The strike nearest to `price`; a tie goes to the lower strike. `null` for an empty list. */
export function atmStrike(strikes, price) {
    let best = null;
    for (const k of strikes) {
        if (best === null || Math.abs(k - price) < Math.abs(best - price) || (Math.abs(k - price) === Math.abs(best - price) && k < best))
            best = k;
    }
    return best;
}
/**
 * IV rank: where today's IV sits between the lowest and highest of the last `n` sessions (default 252), 0 to 100.
 * `history` ends with the latest value; missing values (NaN/null) are ignored. `null` when fewer than `minPoints`
 * values exist or the range is flat. Needs the account's own ATM-IV history (India VIX is a bridge).
 */
export function ivRank(history, n = 252, minPoints = 20) {
    const w = lastValues(history, n);
    if (w.length < minPoints)
        return null;
    const cur = w[w.length - 1];
    const lo = Math.min(...w);
    const hi = Math.max(...w);
    return hi > lo ? ((cur - lo) / (hi - lo)) * 100 : null;
}
/** IV percentile: the share of the earlier sessions in the window whose IV was lower than today's, 0 to 100. */
export function ivPercentile(history, n = 252, minPoints = 20) {
    const w = lastValues(history, n);
    if (w.length < minPoints)
        return null;
    const cur = w[w.length - 1];
    const earlier = w.slice(0, -1);
    return (earlier.filter((v) => v < cur).length / earlier.length) * 100;
}
function lastValues(history, n) {
    const finite = history.filter((v) => typeof v === 'number' && Number.isFinite(v));
    return finite.slice(-Math.max(1, Math.floor(n)));
}
/**
 * Reading of price change against open-interest change:
 * price up and OI up = long build-up; price down and OI up = short build-up; price up and OI down = short covering;
 * price down and OI down = long unwinding. No change in either = neutral.
 */
export function oiBuildup(priceChange, oiChange) {
    if (!Number.isFinite(priceChange) || !Number.isFinite(oiChange) || priceChange === 0 || oiChange === 0)
        return 'neutral';
    if (priceChange > 0)
        return oiChange > 0 ? 'long_buildup' : 'short_covering';
    return oiChange > 0 ? 'short_buildup' : 'long_unwinding';
}
/** Open interest and its change for a near-month and a next-month future, added before reading the build-up. */
export function combinedOi(near, next) {
    return { oi: near.oi + (next?.oi ?? 0), oiChange: near.oiChange + (next?.oiChange ?? 0) };
}
/** Future minus spot. */
export const basis = (future, spot) => future - spot;
/** Basis as a percentage of spot. `null` for a non-positive spot. */
export const basisPct = (future, spot) => (spot > 0 ? ((future - spot) / spot) * 100 : null);
/** Share of open interest already in the next month, 0 to 100: a rollover reading. `null` when there is none. */
export function rolloverPct(nearOi, nextOi) {
    const total = nearOi + nextOi;
    return total > 0 ? (nextOi / total) * 100 : null;
}
/**
 * The open-interest floor, in LOTS of the contract. Open interest arrives in units, and a lot differs by underlying (NIFTY 25 to
 * 75, a stock several hundred to thousands), so a floor in units means a different thing on every underlying: the old floor of
 * 100 units passed 11827 of the 12037 traded options of 2 Jul 2024. 10 lots is a house starting value (the same as the option
 * strategies' strike picker), Needs verification.
 */
export const MIN_OI_LOTS = 10;
/**
 * Open interest in lots, or null when the row does not say its lot size (the legacy file): the floor cannot be read then, and a
 * caller leaves the contract out and counts it rather than guess a lot.
 */
export function oiInLots(r) {
    return typeof r.lot === 'number' && r.lot >= 1 ? r.oi / r.lot : null;
}
/** Starting floors: Needs verification against real chains before use. */
export const DEFAULT_ILLIQUIDITY = { minOiLots: MIN_OI_LOTS, minVolume: 1 };
/**
 * Implied volatility of each usable contract of a chain. Only out-of-the-money options are used (the in-the-money
 * ones are mostly intrinsic value and carry little volatility information); contracts below the open-interest
 * floor (in lots; a row with no lot size is left out as `no_lot_size`), or that did not trade (the settlement price
 * is then a computed number, not a market price) are left out. Everything left out is counted, never hidden.
 */
export function chainImpliedVols(rows, ctx, policy = DEFAULT_ILLIQUIDITY) {
    const report = { points: [], dropped: { in_the_money: 0, no_lot_size: 0, low_open_interest: 0, not_traded: 0, no_solution: 0 }, failures: {} };
    for (const r of rows) {
        const otm = r.side === 'CE' ? r.strike >= ctx.forward : r.strike <= ctx.forward;
        if (!otm) {
            report.dropped.in_the_money++;
            continue;
        }
        const lots = oiInLots(r);
        if (lots === null) {
            report.dropped.no_lot_size++;
            continue;
        }
        if (lots < policy.minOiLots) {
            report.dropped.low_open_interest++;
            continue;
        }
        if (r.volume < policy.minVolume) {
            report.dropped.not_traded++;
            continue;
        }
        const res = impliedVol(r.settle, { forward: ctx.forward, strike: r.strike, years: ctx.years, rate: ctx.rate, side: r.side });
        if (res.ok)
            report.points.push({ strike: r.strike, side: r.side, iv: res.iv });
        else {
            report.dropped.no_solution++;
            report.failures[res.reason] = (report.failures[res.reason] ?? 0) + 1;
        }
    }
    return report;
}
/** Convenience for tests and callers: the model price of a contract at a volatility (re-exported so one import suffices). */
export { black76Price };
