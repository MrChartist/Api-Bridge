import { daysBetween } from './labels.js';
const KIND_CODE = { future: 'FUT', call: 'CE', put: 'PE' };
const CODE_KIND = { FUT: 'future', CE: 'call', PE: 'put' };
/** `UND|expiry|CE|strike|lot`, with FUT and a strike of 0 for a future. */
export const contractId = (c) => `${c.underlying}|${c.expiry}|${KIND_CODE[c.kind]}|${c.strike}|${c.lot}`;
/** The parts of a contract id, or null when it is not one. The segment is not in the id: the panel knows it. */
export function parseContractId(id) {
    const m = /^([A-Za-z0-9&_.-]{1,40})\|(\d{8})\|(FUT|CE|PE)\|(\d+(?:\.\d+)?)\|(\d+)$/.exec(id);
    if (!m)
        return null;
    const kind = CODE_KIND[m[3]];
    const strike = Number(m[4]);
    const lot = Number(m[5]);
    if ((kind === 'future') !== (strike === 0) || lot < 1)
        return null;
    return { underlying: m[1], expiry: Number(m[2]), kind, strike, lot };
}
const ymd = (iso) => Number(iso.replace(/-/g, ''));
const paise = (x) => Math.round(x * 100);
/** A panel from the parsed rows of any number of days. Rows with no lot size or no price at all are left out and counted. */
export function buildLegPanel(rows, options = {}) {
    const dropped = { noLot: 0, noPrice: 0 };
    const contracts = new Map();
    const days = new Set();
    const spotChoice = new Map();
    for (const r of rows) {
        if (r.lot === null || !(r.lot >= 1)) {
            dropped.noLot++;
            continue;
        }
        if (r.settle === null && r.close === null && r.open === null) {
            dropped.noPrice++;
            continue;
        }
        const kind = r.kind === 'future' ? 'future' : r.side === 'CE' ? 'call' : 'put';
        const spec = { underlying: r.symbol, segment: r.segment, kind, expiry: ymd(r.expiry), strike: kind === 'future' ? 0 : r.strike, lot: r.lot };
        const id = contractId(spec);
        const date = ymd(r.tradeDate);
        days.add(date);
        let c = contracts.get(id);
        if (!c) {
            c = { id, spec, days: new Map() };
            contracts.set(id, c);
        }
        c.days.set(date, { open: r.open === null ? null : paise(r.open), settle: r.settle === null ? (r.close === null ? null : paise(r.close)) : paise(r.settle), volume: r.volume, oi: r.oi });
        if (r.underlying !== null) {
            let per = spotChoice.get(r.symbol);
            if (!per) {
                per = new Map();
                spotChoice.set(r.symbol, per);
            }
            const have = per.get(date);
            // The underlying's price is read from the contract with the smallest id of that day, so it does not depend on the order of the rows.
            if (!have || id < have.id)
                per.set(date, { id, value: paise(r.underlying) });
        }
    }
    const spot = new Map();
    for (const [und, per] of spotChoice)
        spot.set(und, new Map([...per].map(([d, v]) => [d, v.value])));
    const bans = new Map(Object.entries(options.bans ?? {}).map(([u, ds]) => [u, new Set(ds)]));
    const freezeUnits = new Map(Object.entries(options.freeze ?? {}));
    const sorted = new Map([...contracts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return { panel: { calendar: [...days].sort((a, b) => a - b), contracts: sorted, spot, bans, freezeUnits }, dropped };
}
/** Run the plan over the panel. Pure: the same panel, plan and settings give the same result. */
export function simulateLegs(panel, orders, config) {
    if (!Number.isSafeInteger(config.capitalPaise) || config.capitalPaise <= 0)
        throw new RangeError('capitalPaise must be a positive whole number of paise');
    if (!Number.isInteger(config.slippageBp) || config.slippageBp < 0)
        throw new RangeError('slippageBp must be a whole number from 0');
    if (config.rollDte !== null && (!Number.isInteger(config.rollDte) || config.rollDte < 0))
        throw new RangeError('rollDte must be a whole number from 0, or null');
    if (config.marginPct !== null && !(config.marginPct > 0 && config.marginPct <= 100))
        throw new RangeError('marginPct must be above 0 and at most 100, or null');
    if (config.marginPct === null) {
        for (const o of orders) {
            if (o.action !== 'open')
                continue;
            const kind = panel.contracts.get(o.contract)?.spec.kind ?? parseContractId(o.contract)?.kind;
            if (kind === 'future' || (kind !== undefined && o.side === -1))
                throw new RangeError('marginPct is needed for a plan that opens a future or sells an option: without it the position size would have no limit');
        }
    }
    const cal = panel.calendar;
    const skips = {};
    const bump = (k) => { skips[k] = (skips[k] ?? 0) + 1; };
    const fills = [];
    const trades = [];
    const equity = [];
    const positions = new Map();
    const notOpenedGroups = [];
    let cash = config.capitalPaise;
    const byDate = new Map();
    const sessions = new Set(cal);
    for (const o of orders) {
        // An order is taken at the close of a session; one dated on a day that is not a session, or on the last session (nothing follows it), never fills.
        if (!sessions.has(o.date) || o.date === cal[cal.length - 1]) {
            bump('orderNotFilled');
            continue;
        }
        const l = byDate.get(o.date);
        if (l)
            l.push(o);
        else
            byDate.set(o.date, [o]);
    }
    /** The index of the last session on or before the expiry; Infinity when the data ends before it. */
    const expirySession = (expiry) => {
        if (cal.length === 0 || expiry > cal[cal.length - 1])
            return Number.POSITIVE_INFINITY;
        let lo = 0;
        let hi = cal.length - 1;
        let ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (cal[mid] <= expiry) {
                ans = mid;
                lo = mid + 1;
            }
            else
                hi = mid - 1;
        }
        return ans;
    };
    const slip = (side, price) => Math.round((price * (side === 1 ? 10_000 + config.slippageBp : 10_000 - config.slippageBp)) / 10_000);
    const segmentOf = (c) => (c.spec.kind === 'future' ? 'FUT' : 'OPT');
    const chargeOf = (c) => (config.charge ? config.charge(c) : 0);
    const marginOf = (p) => {
        if (config.marginPct === null)
            return 0;
        if (p.c.spec.kind !== 'future' && p.side === 1)
            return 0;
        const notional = p.c.spec.kind === 'future' ? p.qty * p.lastMark : p.qty * paise(p.c.spec.strike);
        return Math.round((notional * config.marginPct) / 100);
    };
    /**
     * The margin of positions held together: each leg's margin added, capped at the largest loss the legs can make at expiry (intrinsic
     * values only; the premium already sits in cash) when they are options on one underlying and one expiry and that loss is bounded.
     */
    const groupMargin = (legs) => {
        let sum = 0;
        for (const l of legs)
            sum += marginOf(l);
        if (sum === 0 || legs.length < 2)
            return sum;
        const first = legs[0].c.spec;
        if (legs.some((l) => l.c.spec.kind === 'future' || l.c.spec.underlying !== first.underlying || l.c.spec.expiry !== first.expiry))
            return sum;
        const value = (s) => {
            let v = 0;
            for (const l of legs) {
                const k = paise(l.c.spec.strike);
                v += l.side * l.qty * (l.c.spec.kind === 'call' ? Math.max(s - k, 0) : Math.max(k - s, 0));
            }
            return v;
        };
        // Net calls sold above the highest strike: the loss has no bound, so no cap.
        let callSlope = 0;
        for (const l of legs)
            if (l.c.spec.kind === 'call')
                callSlope += l.side * l.qty;
        if (callSlope < 0)
            return sum;
        let worst = value(0);
        for (const l of legs)
            worst = Math.min(worst, value(paise(l.c.spec.strike)));
        return Math.min(sum, Math.max(0, -worst));
    };
    const totalMargin = (extra = []) => {
        const groups = new Map();
        let m = 0;
        for (const p of [...positions.values(), ...extra]) {
            if (p.group === null) {
                m += marginOf(p);
                continue;
            }
            const g = groups.get(p.group);
            if (g)
                g.push(p);
            else
                groups.set(p.group, [p]);
        }
        for (const g of groups.values())
            m += groupMargin(g);
        return m;
    };
    const closePosition = (p, date, exitPrice, reason, extraCost) => {
        const costs = p.costs + extraCost;
        const gross = p.side * p.qty * (exitPrice - p.entryPrice);
        trades.push({ contract: p.c.id, side: p.side, lots: p.lots, qty: p.qty, entryDate: p.entryDate, exitDate: date, entryPricePaise: p.entryPrice, exitPricePaise: exitPrice, grossPnlPaise: gross, costsPaise: costs, netPnlPaise: gross - costs, exitReason: reason });
        positions.delete(p.c.id);
    };
    /** Fill a close at today's open. Returns false when the contract could not trade today (the close then waits). */
    const fillClose = (p, date, reason, exit) => {
        const day = p.c.days.get(date);
        if (!day || day.open === null || day.volume <= 0) {
            if (reason === 'expiry-force') {
                // Forced out and it did not trade: closed at the last settlement price, and counted, so it is never silently held.
                const price = p.lastMark;
                bump('forceOutNoPrice');
                applyClose(p, date, price, 'expiry-force', reason);
                return true;
            }
            bump('closeDelayed');
            return false;
        }
        applyClose(p, date, slip(p.side === 1 ? -1 : 1, day.open), reason === 'roll-out' ? 'roll' : reason === 'expiry-force' ? 'expiry-force' : exit ?? 'signal', reason);
        return true;
    };
    const applyClose = (p, date, price, exitReason, fillReason) => {
        const closeSide = p.side === 1 ? -1 : 1;
        const value = p.qty * price;
        const cost = chargeOf({ segment: segmentOf(p.c), side: closeSide === 1 ? 'BUY' : 'SELL', date, turnoverPaise: value });
        if (p.c.spec.kind === 'future')
            cash += p.side * p.qty * (price - p.lastMark);
        else
            cash += p.side * p.qty * price;
        cash -= cost;
        fills.push({ date, contract: p.c.id, side: closeSide === 1 ? 'BUY' : 'SELL', lots: p.lots, qty: p.qty, pricePaise: price, valuePaise: value, costPaise: cost, reason: fillReason });
        closePosition(p, date, price, exitReason, cost);
    };
    /** Everything an open needs except cash and margin, which depend on the other legs filled with it. */
    const checkOpen = (o, date, i) => {
        const no = (reason) => ({ ok: false, reason });
        const c = panel.contracts.get(o.contract);
        if (!c)
            return no('NoContract');
        if (positions.has(o.contract))
            return no('Exists');
        if (!Number.isInteger(o.lots) || o.lots < 1)
            return no('BadLots');
        const qty = o.lots * c.spec.lot;
        const freeze = panel.freezeUnits.get(c.spec.underlying);
        if (freeze !== undefined && qty > freeze)
            return no('Freeze');
        if (panel.bans.get(c.spec.underlying)?.has(date))
            return no('Ban');
        const exp = expirySession(c.spec.expiry);
        if (i > exp)
            return no('NoContract');
        // A stock option is forced out at the open of the session before its expiry: opening one that late has no life.
        if (c.spec.segment === 'stock' && c.spec.kind !== 'future' && i >= exp - 1)
            return no('TooClose');
        const day = c.days.get(date);
        if (!day || day.open === null || day.volume <= 0)
            return no('NoPrice');
        const price = slip(o.side, day.open);
        const value = qty * price;
        const cost = chargeOf({ segment: segmentOf(c), side: o.side === 1 ? 'BUY' : 'SELL', date, turnoverPaise: value });
        const outflow = c.spec.kind === 'future' ? 0 : o.side * value;
        return { ok: true, c, qty, price, value, cost, outflow };
    };
    const commitOpen = (o, k, date) => {
        cash -= k.outflow + k.cost;
        positions.set(k.c.id, { c: k.c, side: o.side, lots: o.lots, qty: k.qty, entryDate: date, entryPrice: k.price, lastMark: k.price, costs: k.cost, rollScheduled: false, group: o.group ?? null });
        fills.push({ date, contract: k.c.id, side: o.side === 1 ? 'BUY' : 'SELL', lots: o.lots, qty: k.qty, pricePaise: k.price, valuePaise: k.value, costPaise: k.cost, reason: o.via === 'roll' ? 'roll-in' : 'open' });
    };
    /** Try to open at today's open. `via` says whether it is an order or the second half of a roll, for the counts. */
    const fillOpen = (o, date, i) => {
        const refuse = (r) => bump(`${o.via === 'roll' ? 'rollIn' : 'open'}${r}`);
        const k = checkOpen(o, date, i);
        if (!k.ok)
            return refuse(k.reason);
        const after = cash - k.outflow - k.cost;
        if (after < 0)
            return refuse('NoCash');
        if (config.marginPct !== null && after - totalMargin([{ c: k.c, side: o.side, qty: k.qty, lastMark: k.price, group: null }]) < 0)
            return refuse('Margin');
        commitOpen(o, k, date);
    };
    /** Open the legs of one group together, or none of them: the first refusal is counted under `open<Reason>`, and the group under `groupNotOpened`. */
    const fillGroup = (legs, date, i) => {
        const checks = [];
        const fail = (r) => { bump(`open${r}`); bump('groupNotOpened'); notOpenedGroups.push(legs[0].group ?? ''); };
        for (const o of legs) {
            const k = checkOpen(o, date, i);
            if (!k.ok)
                return fail(k.reason);
            checks.push(k);
        }
        let after = cash;
        for (const k of checks)
            after -= k.outflow + k.cost;
        if (after < 0)
            return fail('NoCash');
        if (config.marginPct !== null && after - totalMargin(legs.map((o, j) => ({ c: checks[j].c, side: o.side, qty: checks[j].qty, lastMark: checks[j].price, group: o.group ?? null }))) < 0)
            return fail('Margin');
        legs.forEach((o, j) => commitOpen(o, checks[j], date));
    };
    let pending = [];
    /** Closes that could not trade at an open and wait for the next, with the reason they were asked for (and a stop or target kept). */
    let carriedCloses = new Map();
    for (let i = 0; i < cal.length; i++) {
        const date = cal[i];
        // ---- 1. The open: exits first, then entries.
        const closes = [];
        const closing = new Set();
        const want = (id, reason, exit) => {
            const pos = positions.get(id);
            if (!pos)
                return bump('closeNoPosition');
            if (closing.has(id))
                return;
            closing.add(id);
            closes.push({ pos, reason, ...(exit ? { exit } : {}) });
        };
        for (const [id, why] of [...carriedCloses].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            want(id, why.reason, why.exit);
        carriedCloses = new Map();
        for (const p of pending.filter((x) => x.kind === 'close').sort((a, b) => (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0)))
            want(p.contract, p.via === 'roll' ? 'roll-out' : 'signal', p.exit);
        for (const pos of [...positions.values()].sort((a, b) => (a.c.id < b.c.id ? -1 : 1))) {
            const exp = expirySession(pos.c.spec.expiry);
            if (pos.c.spec.segment === 'stock' && pos.c.spec.kind !== 'future' && i === exp - 1 && !closing.has(pos.c.id)) {
                closing.add(pos.c.id);
                closes.push({ pos, reason: 'expiry-force' });
            }
        }
        for (const { pos, reason, exit } of closes) {
            if (!fillClose(pos, date, reason, exit))
                carriedCloses.set(pos.c.id, { reason: reason === 'roll-out' ? 'roll-out' : 'signal', ...(exit ? { exit } : {}) });
        }
        // Entries in a fixed order (contract, then the way it came, side and size), so the order of the orders in the plan never changes the result.
        const openKey = (o) => `${o.contract}|${o.via}|${o.side}|${o.lots}`;
        const opens = pending.filter((x) => x.kind === 'open').sort((a, b) => (openKey(a) < openKey(b) ? -1 : openKey(a) > openKey(b) ? 1 : 0));
        const grouped = new Map();
        for (const o of opens) {
            if (o.group === undefined) {
                fillOpen(o, date, i);
                continue;
            }
            const g = grouped.get(o.group);
            if (g)
                g.push(o);
            else
                grouped.set(o.group, [o]);
        }
        for (const key of [...grouped.keys()].sort())
            fillGroup(grouped.get(key), date, i);
        pending = [];
        // ---- 2. The close: expiry settlement, then marking.
        for (const pos of [...positions.values()].sort((a, b) => (a.c.id < b.c.id ? -1 : 1))) {
            const exp = expirySession(pos.c.spec.expiry);
            const day = pos.c.days.get(date);
            if (i === exp) {
                if (pos.c.spec.kind === 'future') {
                    const settle = day?.settle ?? pos.lastMark;
                    if (day?.settle == null)
                        bump('markCarried');
                    cash += pos.side * pos.qty * (settle - pos.lastMark);
                    closePosition(pos, date, settle, 'expiry', 0);
                    continue;
                }
                if (pos.c.spec.segment === 'stock') {
                    // Reached only when the force-out could not run: the position is closed at its last mark, in cash, and counted.
                    cash += pos.side * pos.qty * pos.lastMark;
                    closePosition(pos, date, pos.lastMark, 'expiry-force', 0);
                    bump('stockOptionAtExpiry');
                    continue;
                }
                const spot = panel.spot.get(pos.c.spec.underlying)?.get(date);
                if (spot === undefined) {
                    // No closing price of the underlying to settle against: the option is closed at its last mark, in cash, and counted.
                    bump('expiryNoSpot');
                    cash += pos.side * pos.qty * pos.lastMark;
                    closePosition(pos, date, pos.lastMark, 'expiry', 0);
                    continue;
                }
                const strike = paise(pos.c.spec.strike);
                const intrinsic = pos.c.spec.kind === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
                cash += pos.side * pos.qty * intrinsic;
                let extra = 0;
                if (pos.side === 1 && intrinsic > 0) {
                    extra = chargeOf({ segment: 'OPT', side: 'SELL', date, turnoverPaise: 0, intrinsicPaise: pos.qty * intrinsic });
                    cash -= extra;
                }
                closePosition(pos, date, intrinsic, intrinsic > 0 ? 'exercise' : 'expiry', extra);
                continue;
            }
            if (day?.settle == null) {
                bump('markCarried');
                continue;
            }
            if (pos.c.spec.kind === 'future')
                cash += pos.side * pos.qty * (day.settle - pos.lastMark);
            pos.lastMark = day.settle;
        }
        // ---- 3. The row of the day. A margin call is not modelled; a session that ends short of the margin, or below zero, is counted.
        let held = 0;
        for (const p of positions.values())
            if (p.c.spec.kind !== 'future')
                held += p.side * p.qty * p.lastMark;
        const margin = totalMargin();
        if (margin > 0 && cash < margin)
            bump('marginShort');
        if (cash < 0)
            bump('cashBelowZero');
        equity.push({ date, cashPaise: cash, positionsPaise: held, equityPaise: cash + held, openPositions: positions.size, marginPaise: margin });
        // ---- 4. Decisions for the next open.
        if (i + 1 >= cal.length)
            break;
        for (const o of byDate.get(date) ?? []) {
            if (o.action === 'open')
                pending.push({ kind: 'open', contract: o.contract, side: o.side, lots: o.lots, via: 'signal', ...(o.group !== undefined ? { group: o.group } : {}) });
            else
                pending.push({ kind: 'close', contract: o.contract, via: 'signal', ...(o.reason ? { exit: o.reason } : {}) });
        }
        if (config.rollDte !== null) {
            for (const pos of [...positions.values()].sort((a, b) => (a.c.id < b.c.id ? -1 : 1))) {
                if (pos.c.spec.kind !== 'future' || pos.rollScheduled || i >= expirySession(pos.c.spec.expiry))
                    continue;
                if (daysBetween(date, pos.c.spec.expiry) > config.rollDte)
                    continue;
                pos.rollScheduled = true;
                pending.push({ kind: 'close', contract: pos.c.id, via: 'roll' });
                let next = null;
                for (const c of panel.contracts.values()) {
                    if (c.spec.underlying !== pos.c.spec.underlying || c.spec.kind !== 'future' || c.spec.expiry <= pos.c.spec.expiry || !c.days.has(date))
                        continue;
                    if (next === null || c.spec.expiry < next.spec.expiry)
                        next = c;
                }
                if (next === null)
                    bump('rollNoNext');
                else
                    pending.push({ kind: 'open', contract: next.id, side: pos.side, lots: pos.lots, via: 'roll', ...(pos.group !== null ? { group: pos.group } : {}) });
            }
        }
    }
    // Whatever is still open is reported at its last settlement price, not hidden and not counted as closed.
    const open = [...positions.values()].sort((a, b) => (a.c.id < b.c.id ? -1 : 1)).map((p) => {
        const gross = p.side * p.qty * (p.lastMark - p.entryPrice);
        return { contract: p.c.id, side: p.side, lots: p.lots, qty: p.qty, entryDate: p.entryDate, exitDate: cal[cal.length - 1] ?? 0, entryPricePaise: p.entryPrice, exitPricePaise: p.lastMark, grossPnlPaise: gross, costsPaise: p.costs, netPnlPaise: gross - p.costs, exitReason: 'open' };
    });
    return { fills, trades, equity, skips, open, finalCashPaise: cash, notOpenedGroups };
}
/** The facts a result envelope needs from a run with legs: fills are end-of-day, and margin is an estimate whenever it is set (it must be for futures and short options). */
export const legLabelFacts = (config) => ({ eodFills: true, marginModelled: config.marginPct !== null });
