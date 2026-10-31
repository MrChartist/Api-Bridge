import { run } from '../runtime/run.js';
import { MIN_OI_LOTS, atmStrike } from '../derivatives/analytics.js';
import { black76Greeks, impliedVol } from '../derivatives/black76.js';
import { parseLegStrike } from '../stdlib/manifest.js';
import { daysBetween } from './labels.js';
import { simulateLegs } from './legs.js';
/** The legs a compiled script declares, in order; empty for anything that is not an option strategy. */
export function optionLegsOf(compiled) {
    const p = compiled.program;
    if (p.kind !== 'strategy')
        return [];
    const out = [];
    for (const o of p.outputs) {
        if (o.kind !== 'leg' || !o.leg)
            continue;
        const node = p.nodes[o.value];
        const lots = node && node.op === 'const' && typeof node.value === 'number' ? node.value : 1;
        out.push({ ...o.leg, lots });
    }
    return out;
}
export const isOptionStrategy = (compiled) => optionLegsOf(compiled).length > 0;
/** Expiries of `underlying` listed on `date` (contracts with a price that day) and later than it, ascending. */
function listedExpiries(contracts, date) {
    return [...new Set(contracts.map((c) => c.spec.expiry).filter((e) => e > date))].sort((a, b) => a - b);
}
function pickExpiry(expiries, rule) {
    if (rule === 'near')
        return expiries[0] ?? null;
    if (rule === 'next')
        return expiries[1] ?? null;
    // The last listed expiry of its calendar month (yyyymm), nearest first.
    for (const e of expiries) {
        const month = Math.floor(e / 100);
        if (!expiries.some((x) => x > e && Math.floor(x / 100) === month))
            return e;
    }
    return null;
}
/**
 * Strikes chosen by delta or by premium (`strike="delta=0.25"`, `strike="premium=100"`), on the decision day, among the listed
 * contracts of that right and expiry. Rules, each written down so a test can pin it:
 *  - A contract is skipped, and counted, when it did not trade that day (volume 0: its settlement price is a computed number, not a
 *    market price), when its open interest is below `STRIKE_PICK_MIN_OI_LOTS` lots (the exchange's files give open interest in units, so the floor is
 *    in lots of that contract; 10 is a house starting value, Needs verification),
 *    when it has no settlement price, or when the implied-volatility solver refuses its settlement price (below or at intrinsic value,
 *    above the largest possible price, ...). The same skips apply to both forms, so a premium is only matched against prices that are
 *    a possible option price.
 *  - Implied volatility: Black-76 inverted on the settlement price; forward = the settlement price of the future of the same expiry when
 *    one is listed that day, else the underlying's close; rate 0; time = calendar days from the decision day to the expiry / 365.
 *  - Delta: the absolute Black-76 delta at that implied volatility. The chosen strike is the one whose value (delta, or settlement
 *    price in paise) is nearest the target; a tie goes to the strike further out of the money (the higher strike for a call, the
 *    lower for a put): the cheaper of two equally good choices.
 */
export const STRIKE_PICK_MIN_OI_LOTS = MIN_OI_LOTS;
/**
 * The candidate whose value is nearest `target`; a tie (within 1e-12 for fractional values) goes to the strike further out of the
 * money: the higher strike for a call, the lower for a put. Null for none. Shared by the backtest and the Script page's preview.
 */
export function nearestStrikeBy(candidates, target, right) {
    let best = null;
    for (const c of candidates) {
        if (!Number.isFinite(c.value))
            continue;
        if (best === null) {
            best = c;
            continue;
        }
        const d = Math.abs(c.value - target) - Math.abs(best.value - target);
        const furtherOut = right === 'call' ? c.strike > best.strike : c.strike < best.strike;
        if (d < -1e-12 || (Math.abs(d) <= 1e-12 && furtherOut))
            best = c;
    }
    return best === null ? null : best.strike;
}
const yearsTo = (date, expiry) => daysBetween(date, expiry) / 365;
/** The contract of `same` (one right, one expiry) chosen by delta or premium on `date`, or null when none qualifies. Skips are counted into `skipped`. */
function pickByValue(same, rule, right, forward, date, expiry, skipped) {
    const skip = (k) => { skipped[k] = (skipped[k] ?? 0) + 1; };
    const years = yearsTo(date, expiry);
    const side = right === 'call' ? 'CE' : 'PE';
    const candidates = [];
    const byStrike = new Map();
    for (const c of same) {
        const day = c.days.get(date);
        if (!day || !(day.volume > 0)) {
            skip('no-volume');
            continue;
        }
        if (day.oi !== undefined && day.oi < STRIKE_PICK_MIN_OI_LOTS * c.spec.lot) {
            skip('low-oi');
            continue;
        }
        if (day.settle === null || !(day.settle > 0)) {
            skip('no-price');
            continue;
        }
        const input = { forward, strike: c.spec.strike, years, rate: 0, side };
        const iv = impliedVol(day.settle / 100, input);
        if (!iv.ok) {
            skip('no-iv');
            continue;
        }
        const value = rule.by === 'delta' ? Math.abs(black76Greeks(input, iv.iv).delta) : day.settle;
        candidates.push({ strike: c.spec.strike, value });
        byStrike.set(c.spec.strike, c);
    }
    // Premium is compared in whole paise, so a tie is exact.
    const target = rule.by === 'delta' ? rule.delta : Math.round(rule.premium * 100);
    const k = nearestStrikeBy(candidates, target, right);
    return k === null ? null : byStrike.get(k) ?? null;
}
/** Each leg's contract on `date`, from what is listed that day. All or nothing. `skipped` (optional) collects the contracts a delta or premium choice left out. */
export function resolveLegs(legs, panel, underlying, date, skipped = {}) {
    const listed = [...panel.contracts.values()].filter((c) => c.spec.underlying === underlying && c.days.has(date));
    if (listed.length === 0)
        return { ok: false, reason: 'no-listing' };
    const spotPaise = panel.spot.get(underlying)?.get(date);
    const out = [];
    for (const leg of legs) {
        const ofRight = listed.filter((c) => c.spec.kind === leg.right);
        const expiry = pickExpiry(listedExpiries(ofRight, date), leg.expiry);
        if (expiry === null)
            return { ok: false, reason: 'no-expiry' };
        const same = ofRight.filter((c) => c.spec.expiry === expiry);
        if (leg.right === 'future') {
            const fut = same[0];
            if (!fut)
                return { ok: false, reason: 'no-expiry' };
            out.push({ ...leg, contract: fut.id, expiryDate: expiry, strikePrice: 0 });
            continue;
        }
        if (spotPaise === undefined)
            return { ok: false, reason: 'no-spot' };
        const rule = parseLegStrike(leg.strike);
        if (rule === null)
            return { ok: false, reason: 'strike-out-of-range' };
        if (rule.by !== 'atm') {
            const futSettle = listed.find((c) => c.spec.kind === 'future' && c.spec.expiry === expiry)?.days.get(date)?.settle;
            const forward = (futSettle != null && futSettle > 0 ? futSettle : spotPaise) / 100;
            const picked = pickByValue(same, rule, leg.right, forward, date, expiry, skipped);
            if (!picked)
                return { ok: false, reason: rule.by === 'delta' ? 'no-delta-match' : 'no-premium-match' };
            out.push({ ...leg, contract: picked.id, expiryDate: expiry, strikePrice: picked.spec.strike });
            continue;
        }
        const strikes = [...new Set(same.map((c) => c.spec.strike))].sort((a, b) => a - b);
        const atm = atmStrike(strikes, spotPaise / 100);
        if (atm === null)
            return { ok: false, reason: 'strike-out-of-range' };
        const at = strikes.indexOf(atm) + rule.offset;
        if (at < 0 || at >= strikes.length)
            return { ok: false, reason: 'strike-out-of-range' };
        const contract = same.find((c) => c.spec.strike === strikes[at]);
        if (!contract)
            return { ok: false, reason: 'strike-out-of-range' };
        out.push({ ...leg, contract: contract.id, expiryDate: expiry, strikePrice: strikes[at] });
    }
    return { ok: true, legs: out };
}
/**
 * The stop and target of a held position on one close. The position's gain is the sum over its legs of side x quantity x (settlement
 * - entry price); the reference is the absolute value of the sum over its OPTION legs of side x quantity x entry price (a future has
 * no premium). A loss of at least `stopPct` percent of the reference is a stop, a gain of at least `targetPct` percent a target; the
 * stop is looked at first. Prices are the exchange's (the entry is the leg's open on its fill session, before slippage and charges);
 * a leg with no settlement that day keeps its last one, as the simulator does.
 *
 * Worked: a credit of 100 received (reference 100), stop 30: a stop when the cost to close reaches 130 (gain -30). A debit of 100
 * paid, target 50: a target when the legs are worth 150 (gain +50); stop 30: a stop when they are worth 70 (gain -30).
 */
export function premiumCheck(watch) {
    if (!(watch.reference > 0))
        return null;
    let gain = 0;
    for (const l of watch.legs)
        gain += l.signedQty * (l.mark - l.entry);
    if (watch.stopPct !== null && -gain * 100 >= watch.stopPct * watch.reference)
        return 'stop';
    if (watch.targetPct !== null && gain * 100 >= watch.targetPct * watch.reference)
        return 'target';
    return null;
}
/** A finite percent above zero, else null (no stop or target on that candlestick). */
const pctAt = (col, i) => {
    const v = col ? col[i] : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
};
/** The script's entry and exit columns over the underlying's candlesticks. Throws a RangeError when the script is not an option strategy. */
function signalsOf(input) {
    const { compiled, daily } = input;
    if (optionLegsOf(compiled).length === 0 || typeof compiled.program.params.underlying !== 'string')
        throw new RangeError('Only an option strategy (@strategy(underlying=...) with strategy.leg) can be planned here.');
    const result = run(compiled, daily, { ...(input.runOptions ?? {}), ...(input.inputs ? { inputs: input.inputs } : {}), ...(input.holidays ? { holidays: input.holidays } : {}) });
    const col = (kind) => {
        const at = compiled.program.outputs.findIndex((o) => o.kind === kind);
        return at < 0 ? null : result.outputs.find((o) => o.index === at)?.values ?? null;
    };
    return { entry: col('entry'), exit: col('exit'), stop: col('stop_loss'), target: col('take_profit') };
}
/** The orders an option strategy gives over the underlying's history. Throws a RangeError when the script is not one. */
export function optionStrategyPlan(input) {
    return planFrom(input, signalsOf(input));
}
function planFrom(input, { entry, exit, stop, target }) {
    const { compiled, daily, panel } = input;
    const legs = optionLegsOf(compiled);
    const underlying = compiled.program.params.underlying;
    const sessions = new Set(panel.calendar);
    const orders = [];
    const refused = {};
    const entries = [];
    const strikeSkipped = {};
    const premium = {};
    const count = (k) => { premium[k] = (premium[k] ?? 0) + 1; };
    let held = null;
    let watch = null;
    for (let i = 0; i < daily.date.length; i++) {
        const date = daily.date[i];
        if (held && date >= Math.min(...held.map((l) => l.expiryDate))) {
            held = null;
            watch = null;
        } // settled by the simulator at expiry
        if (!sessions.has(date))
            continue;
        if (held) {
            let why = null;
            if (watch && date >= watch.from) {
                for (const l of watch.legs) {
                    const settle = panel.contracts.get(l.contract)?.days.get(date)?.settle;
                    if (settle !== null && settle !== undefined)
                        l.mark = settle;
                }
                why = premiumCheck(watch);
            }
            if (why || (exit && exit[i] === 1)) {
                if (why)
                    count(why === 'stop' ? 'stopHit' : 'targetHit');
                for (const l of held)
                    orders.push(why ? { date, action: 'close', contract: l.contract, reason: why } : { date, action: 'close', contract: l.contract });
                held = null;
                watch = null;
            }
            continue;
        }
        if (!entry || entry[i] !== 1)
            continue;
        if (input.notOpened?.has(date)) {
            refused['not-opened'] = (refused['not-opened'] ?? 0) + 1;
            continue;
        }
        const r = resolveLegs(legs, panel, underlying, date, strikeSkipped);
        if (!r.ok) {
            refused[r.reason] = (refused[r.reason] ?? 0) + 1;
            continue;
        }
        // One group per position: its legs open together or not at all, and a hedged spread's margin is its largest loss.
        for (const l of r.legs)
            orders.push({ date, action: 'open', contract: l.contract, side: l.side === 'buy' ? 1 : -1, lots: l.lots, group: `p${date}` });
        entries.push({ date, legs: r.legs });
        held = r.legs;
        watch = watchOf(r.legs, panel, date, pctAt(stop, i), pctAt(target, i), count);
    }
    return { underlying, legs, orders, refused, entries, strikeSkipped, premium };
}
/**
 * What the stop and target watch for a position decided on `date`: its legs at their open on the fill session (the next session),
 * from which day's close on they are looked at. Null when there is no stop or target, when the position cannot fill (no next
 * session, a leg with no open: the simulator refuses it and the plan is made again without it), or when the net premium is zero
 * (counted as `stopNoReference`: a percent of nothing cannot be hit).
 */
function watchOf(legs, panel, date, stopPct, targetPct, count) {
    if (stopPct === null && targetPct === null)
        return null;
    const at = panel.calendar.indexOf(date);
    const from = at < 0 ? undefined : panel.calendar[at + 1];
    if (from === undefined)
        return null;
    const marked = [];
    let premium = 0;
    for (const l of legs) {
        const c = panel.contracts.get(l.contract);
        const open = c?.days.get(from)?.open;
        if (!c || open === null || open === undefined)
            return null;
        const signedQty = (l.side === 'buy' ? 1 : -1) * l.lots * c.spec.lot;
        if (c.spec.kind !== 'future')
            premium += signedQty * open;
        marked.push({ contract: l.contract, signedQty, entry: open, mark: open });
    }
    const reference = Math.abs(premium);
    if (reference === 0) {
        count('stopNoReference');
        return null;
    }
    return { legs: marked, reference, stopPct, targetPct, from };
}
/** At most this many plan-and-simulate rounds; each round removes at least one position that could not open. */
const MAX_REPLANS = 64;
/**
 * Plan and simulate: the script's capital and margin_pct, no rolls (option legs expire). A position the simulator cannot open is
 * removed from the plan and the plan is made again, so a refused entry does not block later ones (the plan alone cannot know cash
 * and margin). Deterministic: the same input gives the same rounds.
 */
export function runOptionStrategy(input, config) {
    const params = input.compiled.program.params;
    const capital = typeof params.capital === 'number' ? Math.round(params.capital * 100) : 100_000_000;
    const marginPct = typeof params.margin_pct === 'number' ? params.margin_pct : null;
    const notOpened = new Set(input.notOpened ?? []);
    const signals = signalsOf(input);
    for (let round = 0;; round++) {
        const plan = planFrom({ ...input, notOpened }, signals);
        const result = simulateLegs(input.panel, plan.orders, { ...config, capitalPaise: config.capitalPaise ?? capital, marginPct, rollDte: null });
        const fresh = result.notOpenedGroups.map((g) => Number(g.slice(1))).filter((d) => Number.isFinite(d) && !notOpened.has(d));
        if (fresh.length === 0 || round + 1 >= MAX_REPLANS)
            return { ...plan, result };
        // Only the first refusal is certain: a later one may have been caused by a position the first refusal now frees.
        notOpened.add(Math.min(...fresh));
    }
}
