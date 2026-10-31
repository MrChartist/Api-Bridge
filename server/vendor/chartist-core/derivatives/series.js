// One underlying's derivatives as a dated series (S31): for every trading day, its futures (nearest first) and the option
// chain of each listed expiry. This is the shape the `fut.*` and `opt.*` names read. It is built from contract rows (the
// parsers' output) and holds no data source of its own; the host decides where the rows come from and whether they are
// licensed to be shown.
//
// Conventions below are choices, not facts, and each is marked Needs verification where a user could disagree:
// - "Near" is the nearest expiry ON OR AFTER the trading day (the expiry day itself still counts), "next" the one after it.
// - Futures open interest is near + next added together, so a roll (OI leaving the near month for the next) does not look
//   like a collapse; the roll itself is read from `rolloverPct`.
// - Basis is the near future's close against the underlying price printed in the same file, in percent of that price.
// - Days to expiry are calendar days; years = days / 365.
// - Everything is read from the day's own rows, so a value on day t never uses a row from a later day.
import { MIN_OI_LOTS, atmStrike, combinedOi, oiInLots, oiBuildup, pcrOi, pcrVolume, rolloverPct, basisPct, maxPain, ivRank } from './analytics.js';
import { forwardFromParity, impliedVol } from './black76.js';
import { daysBetween } from './dates.js';
const ymd = (iso) => Number(iso.replace(/-/g, ''));
/** Build the series of one underlying from contract rows of any number of days. Rows of other symbols are ignored. */
export function buildDerivSeries(contracts, symbol) {
    const dropped = { expired: 0, no_price: 0, duplicate: 0 };
    const byDay = new Map();
    const seen = new Set();
    for (const c of contracts) {
        if (c.symbol !== symbol)
            continue;
        if (c.expiry < c.tradeDate) {
            dropped.expired++;
            continue;
        }
        const key = `${c.tradeDate}|${c.kind}|${c.expiry}|${c.strike ?? ''}|${c.side ?? ''}`;
        if (seen.has(key)) {
            dropped.duplicate++;
            continue;
        }
        seen.add(key);
        if (c.kind === 'option' ? c.settle === null || c.strike === null || c.side === null : c.settle === null && c.close === null) {
            dropped.no_price++;
            continue;
        }
        const list = byDay.get(c.tradeDate);
        if (list)
            list.push(c);
        else
            byDay.set(c.tradeDate, [c]);
    }
    const days = [];
    for (const iso of [...byDay.keys()].sort()) {
        const rows = byDay.get(iso);
        const futures = rows
            .filter((c) => c.kind === 'future')
            .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0))
            .map((c) => ({ expiry: c.expiry, close: c.close, settle: c.settle, prevClose: c.prevClose, oi: c.oi, oiChange: c.oiChange }));
        const byExpiry = new Map();
        // The underlying's price: from the nearest future when there is one, else from the nearest option row, so the answer
        // does not depend on the order of the rows in the file.
        let spot = null;
        let spotExpiry = '';
        const consider = (c) => {
            if (c.underlying !== null && (spot === null || c.expiry < spotExpiry)) {
                spot = c.underlying;
                spotExpiry = c.expiry;
            }
        };
        rows.filter((c) => c.kind === 'future').forEach(consider);
        if (spot === null)
            rows.forEach(consider);
        for (const c of rows) {
            if (c.kind !== 'option')
                continue;
            const list = byExpiry.get(c.expiry) ?? [];
            list.push({ strike: c.strike, side: c.side, oi: c.oi, volume: c.volume, settle: c.settle, close: c.close ?? c.settle, lot: c.lot });
            byExpiry.set(c.expiry, list);
        }
        const chains = [...byExpiry.keys()].sort().map((expiry) => ({
            expiry,
            dte: daysBetween(iso, expiry),
            rows: byExpiry.get(expiry).sort((a, b) => a.strike - b.strike || (a.side === b.side ? 0 : a.side === 'CE' ? -1 : 1)),
        }));
        days.push({ date: ymd(iso), iso, spot, futures, chains });
    }
    return { series: { symbol, days }, dropped };
}
// ---- one day, one reading ------------------------------------------------------------------------------------------
export const futClose = (d) => d.futures[0]?.close ?? null;
/** Near future against the underlying, in percent of the underlying. */
export function futBasisPct(d) {
    const f = futClose(d);
    return f === null || d.spot === null ? null : basisPct(f, d.spot);
}
const combined = (d) => {
    const near = d.futures[0];
    return near ? combinedOi(near, d.futures[1] ?? null) : null;
};
/**
 * Open interest of the near and next future added, in units. Units, not contracts, are the right thing to add: during a lot
 * revision the two months can have different lots (FINNIFTY 40 and 25 on 2 Jul 2024), and a contract of each is not the same size.
 */
export const futOi = (d) => combined(d)?.oi ?? null;
export const futOiChange = (d) => combined(d)?.oiChange ?? null;
/** Share of the open interest already in the next month, 0 to 100. Null with no next future or no interest. */
export function futRollover(d) {
    const near = d.futures[0];
    const next = d.futures[1];
    return near && next ? rolloverPct(near.oi, next.oi) : null;
}
/** Price change of the near future (against its previous close) read with the combined open-interest change. */
export function futBuildup(d) {
    const near = d.futures[0];
    const c = combined(d);
    if (!near || !c || near.close === null || near.prevClose === null)
        return null;
    return oiBuildup(near.close - near.prevClose, c.oiChange);
}
/** The k-th listed expiry's chain (0 is the nearest), or null. */
export const chainAt = (d, k) => d.chains[k] ?? null;
export const pcrOiOf = (d, k) => { const c = chainAt(d, k); return c ? pcrOi(c.rows) : null; };
export const pcrVolumeOf = (d, k) => { const c = chainAt(d, k); return c ? pcrVolume(c.rows) : null; };
export const maxPainOf = (d, k) => { const c = chainAt(d, k); return c ? (maxPain(c.rows)?.strike ?? null) : null; };
/** Same starting floors as the chain analytics: Needs verification against real chains. */
export const ATM_FLOORS = { minOiLots: MIN_OI_LOTS, minVolume: 1 };
/**
 * Implied volatility at the money, as a fraction (0.16 is 16 percent), for the listed expiry whose days to expiry are closest to
 * `dte` (a tie goes to the nearer expiry). The expiry day itself and expiries with no time left are not used. Black-76 on the
 * forward: the future of that expiry when it has one (index weekly options have none), else the forward the put and call at the
 * strike nearest the underlying imply by put-call parity. The result is the mean of the call and the put at the strike nearest the
 * forward, or whichever of the two is usable; null when neither is. `rate` is a plain continuously compounded annual rate (0 means
 * no discounting; the convention is Needs verification and is carried in the result's provenance by the host).
 */
export function atmIvOf(d, dte, rate = 0, floors = ATM_FLOORS) {
    let pick = null;
    for (const c of d.chains) {
        if (c.dte < 1)
            continue;
        if (pick === null || Math.abs(c.dte - dte) < Math.abs(pick.dte - dte))
            pick = c;
    }
    if (pick === null)
        return null;
    const years = pick.dte / 365;
    const strikes = [...new Set(pick.rows.map((r) => r.strike))].filter((k) => pick.rows.some((r) => r.strike === k && r.side === 'CE') && pick.rows.some((r) => r.strike === k && r.side === 'PE'));
    let forward = null;
    const fut = d.futures.find((f) => f.expiry === pick.expiry);
    if (fut)
        forward = fut.settle ?? fut.close;
    if (forward === null) {
        if (d.spot === null)
            return null;
        const k0 = atmStrike(strikes, d.spot);
        if (k0 === null)
            return null;
        const call = pick.rows.find((r) => r.strike === k0 && r.side === 'CE');
        const put = pick.rows.find((r) => r.strike === k0 && r.side === 'PE');
        if (!call || !put)
            return null;
        forward = forwardFromParity(call.settle, put.settle, k0, rate, years);
    }
    const k = atmStrike(strikes, forward);
    if (k === null)
        return null;
    const ivs = [];
    for (const side of ['CE', 'PE']) {
        const r = pick.rows.find((x) => x.strike === k && x.side === side);
        if (!r || r.volume < floors.minVolume)
            continue;
        const lots = oiInLots(r);
        if (lots === null || lots < floors.minOiLots)
            continue;
        const res = impliedVol(r.settle, { forward, strike: k, years, rate, side });
        if (res.ok)
            ivs.push(res.iv);
    }
    return ivs.length === 0 ? null : ivs.reduce((a, b) => a + b, 0) / ivs.length;
}
/** The ATM implied volatility of every day of the series (null where there is none), for `ivRank`. */
export const atmIvSeries = (s, dte, rate = 0) => s.days.map((d) => atmIvOf(d, dte, rate));
/**
 * IV rank (0 to 100) on day `i`: where that day's ATM IV sits between the lowest and highest of the last `n` days that had one.
 * Uses days up to and including `i` only. The window is `n` sessions WITH a value: a session with a file but no ATM IV (no strike
 * passed the floors) is skipped, not counted, so a thin stretch does not shrink the sample the rank is taken over (it was: 252
 * sessions holding 20 values ranked today against those 20 only). Fewer than 20 values before and including day `i` is "not enough
 * history" (null).
 */
export function ivRankAt(history, i, n) {
    // A day with no ATM IV has no rank: ranking the last known value would present an earlier day's volatility as today's.
    const today = history[i];
    if (typeof today !== 'number' || !Number.isFinite(today))
        return null;
    const want = Math.max(1, Math.floor(n));
    const vals = [];
    for (let j = i; j >= 0 && vals.length < want; j--) {
        const v = history[j];
        if (typeof v === 'number' && Number.isFinite(v))
            vals.push(v);
    }
    return ivRank(vals.reverse(), want);
}
