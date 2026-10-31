import { TRI_TRUE } from '../signal/signalPanel.js';
import { weekKey, monthKey } from '../runtime/data.js';
import { slippageBp } from './slippage.js';
import { portfolioWeights, sizeTarget } from './sizing.js';
const isNum = (x) => x === x; // not NaN
/** Round half up for non-negative integers a * b / c. */
const mulDivP = (a, b, c) => Math.floor((a * b * 2 + c) / (c * 2));
export function simulate(panel, config) {
    const nSym = panel.symbols.length;
    const days = panel.calendar.length;
    const from = Math.max(0, config.fromIndex ?? 0);
    const to = Math.min(days - 1, config.toIndex ?? days - 1);
    if (!Number.isSafeInteger(config.capitalPaise) || config.capitalPaise <= 0)
        throw new RangeError('capitalPaise must be a positive integer');
    if (!Number.isInteger(config.maxPositions) || config.maxPositions < 1)
        throw new RangeError('maxPositions must be a whole number of at least 1');
    if (config.maxHoldSessions !== undefined && (!Number.isInteger(config.maxHoldSessions) || config.maxHoldSessions < 1))
        throw new RangeError('maxHoldSessions must be a whole number of at least 1');
    if (config.corporateActions?.length && panel.bars.adjustmentPolicy !== 'raw')
        throw new RangeError('corporate actions are applied only to raw candlesticks (the adjustment policy is not "raw")');
    const field = (s, f) => panel.bars.series(s, f);
    const open = Array.from({ length: nSym }, (_, s) => field(s, 'open'));
    const high = Array.from({ length: nSym }, (_, s) => field(s, 'high'));
    const low = Array.from({ length: nSym }, (_, s) => field(s, 'low'));
    const close = Array.from({ length: nSym }, (_, s) => field(s, 'close'));
    const volume = Array.from({ length: nSym }, (_, s) => field(s, 'volume'));
    const paise = (x) => Math.round(x * 100 + (x >= 0 ? 1e-9 : -1e-9));
    const hasBar = (s, d) => isNum(open[s][d]) && isNum(high[s][d]) && isNum(low[s][d]) && isNum(close[s][d]);
    const fixedSlipBp = config.slippageBp ?? 0;
    const advWindow = config.liquidity?.advWindow ?? 20;
    const minAdvP = config.liquidity?.minAdvPaise ?? 0;
    const partPct = config.liquidity?.participationPct ?? 0;
    const circuit = config.circuit ?? { enabled: false, minGapPct: 4.9 };
    const costOf = config.costModel ?? (() => 0);
    const actionsByDay = new Map();
    for (const a of config.corporateActions ?? []) {
        const list = actionsByDay.get(a.date) ?? [];
        list.push(a);
        actionsByDay.set(a.date, list);
    }
    const symIndex = new Map(panel.symbols.map((x, i) => [x, i]));
    let cashP = config.capitalPaise;
    const positions = new Map();
    const lastClose = new Float64Array(nSym).fill(Number.NaN);
    let pendingEntries = [];
    const pendingExits = new Map();
    const pendingAdjusts = new Map();
    const trades = [];
    const fills = [];
    const equity = [];
    const skips = { entryNoBar: 0, entryCircuit: 0, entryIlliquid: 0, entryNoCash: 0, entryPartial: 0, entryTooSmall: 0, entryNoSlot: 0, exitDelayedNoBar: 0, exitDelayedCircuit: 0, exitDelayedNoVolume: 0, exitPartial: 0, adjustNoBar: 0, adjustCircuit: 0, adjustNoCash: 0, adjustPartial: 0, sellCostCapped: 0 };
    const adv = (s, d) => {
        // Average traded value in rupees over the `advWindow` candlesticks up to and including `d`; a missing one is left out.
        let sum = 0;
        let n = 0;
        for (let k = d; k > d - advWindow && k >= 0; k--) {
            if (isNum(close[s][k]) && isNum(volume[s][k])) {
                sum += close[s][k] * volume[s][k];
                n++;
            }
        }
        return n >= Math.min(5, advWindow) ? sum / n : 0;
    };
    const prevClose = (s, d) => {
        for (let k = d - 1; k >= 0; k--)
            if (isNum(close[s][k]))
                return close[s][k];
        return Number.NaN;
    };
    const lockedUp = (s, d) => {
        if (!circuit.enabled || high[s][d] !== low[s][d])
            return false;
        const pc = prevClose(s, d);
        return isNum(pc) && open[s][d] >= pc * (1 + circuit.minGapPct / 100);
    };
    const lockedDown = (s, d) => {
        if (!circuit.enabled || high[s][d] !== low[s][d])
            return false;
        const pc = prevClose(s, d);
        return isNum(pc) && open[s][d] <= pc * (1 - circuit.minGapPct / 100);
    };
    /** Counters that exist only for a feature in use (a stop or target from a series, a first target): written when they happen. */
    const bump = (k) => { skips[k] = (skips[k] ?? 0) + 1; };
    const sizePct = panel.partialDist && panel.partialSizePct !== undefined ? panel.partialSizePct : null;
    /** The lot of symbol s (1 when there are no lots). */
    const lotOf = (s) => {
        const lot = config.lotSize ? config.lotSize(panel.symbols[s]) : 1;
        return lot > 1 ? lot : 1;
    };
    const record = (d, s, side, shares, priceP, reason) => {
        const valueP = shares * priceP;
        const charged = costOf({ date: panel.calendar[d], symbol: panel.symbols[s], side, shares, pricePaise: priceP, valuePaise: valueP });
        // A buy's charge is checked before it is placed (`affordable`); a sale's is cut to what the sale brings in.
        const cost = side === 'SELL' && charged > valueP ? valueP : charged;
        if (cost !== charged)
            skips.sellCostCapped++;
        fills.push({ date: panel.calendar[d], symbol: panel.symbols[s], side, shares, pricePaise: priceP, valuePaise: valueP, costPaise: cost, reason });
        cashP += side === 'BUY' ? -(valueP + cost) : valueP - cost;
        return cost;
    };
    /** Sell `want` shares of position `pos` at `priceP`; returns shares sold (the cap may allow fewer). */
    const sell = (d, pos, want, priceP, reason, cap, fillReason = reason) => {
        const qty = Math.min(want, cap);
        if (qty <= 0)
            return 0;
        const cost = record(d, pos.s, 'SELL', qty, priceP, fillReason);
        const t = trades[pos.tradeIndex];
        t.costsPaise += cost;
        if (qty === pos.shares) {
            t.exitDate = panel.calendar[d];
            t.exitPricePaise = priceP;
            t.reason = reason === 'rebalance' ? 'signal' : reason;
            t.open = false;
            t.soldValuePaise += qty * priceP;
            t.grossPnlPaise = t.soldValuePaise - t.boughtValuePaise;
            t.netPnlPaise = t.grossPnlPaise - t.costsPaise;
            positions.delete(pos.s);
        }
        else {
            t.soldValuePaise += qty * priceP;
            pos.shares -= qty;
            // The part sold is proportionally out of the cost basis for this row: partial exits settle when the last share goes.
        }
        return qty;
    };
    const capShares = (s, d) => {
        if (partPct <= 0)
            return Number.POSITIVE_INFINITY;
        const v = volume[s][d];
        return isNum(v) ? Math.floor((v * partPct) / 100) : 0;
    };
    /** Sample standard deviation of simple daily returns over the last `span` candlesticks up to `d`; NaN with too little history. */
    const sigma = (s, d, span) => {
        const r = [];
        let prev = Number.NaN;
        for (let k = Math.max(0, d - span); k <= d; k++) {
            const c = close[s][k];
            if (!isNum(c))
                continue;
            if (isNum(prev) && prev > 0)
                r.push(c / prev - 1);
            prev = c;
        }
        if (r.length < Math.max(5, Math.floor(span / 2)))
            return Number.NaN;
        const mean = r.reduce((a, b) => a + b, 0) / r.length;
        // Products, not `**`: a plain multiplication is the same on every engine version (determinism across Node versions).
        return Math.sqrt(r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (r.length - 1));
    };
    /**
     * Slippage for a fill of `shares` of stock `s` on session `d`, in basis points: the profile's, using only what was known before the
     * fill (average traded value and volatility up to the session before, the order's share of the day's volume), else the fixed number.
     */
    const slipBpFor = (s, d, shares) => {
        const profile = config.slippageProfile;
        if (!profile)
            return fixedSlipBp;
        const a = d > 0 ? adv(s, d - 1) : 0;
        const v = volume[s][d];
        return slippageBp(profile, {
            advPaise: a > 0 ? Math.round(a * 100) : null,
            sigma: d > 0 && Number.isFinite(sigma(s, d - 1, 20)) ? sigma(s, d - 1, 20) : null,
            participation: isNum(v) && v > 0 ? shares / v : 1,
        });
    };
    const rebalanceEvery = config.rebalance?.every ?? 'signal';
    const isRebalanceDay = (d) => {
        if (rebalanceEvery === 'signal' || d >= days - 1)
            return false;
        if (rebalanceEvery === 'daily')
            return true;
        const a = panel.calendar[d];
        const b = panel.calendar[d + 1];
        return rebalanceEvery === 'weekly' ? weekKey(a) !== weekKey(b) : monthKey(a) !== monthKey(b);
    };
    for (let d = from; d <= to; d++) {
        const date = panel.calendar[d];
        // 0. Corporate actions (raw candlesticks only).
        const todays = actionsByDay.get(date);
        if (todays) {
            for (const a of todays) {
                const s = symIndex.get(a.symbol);
                if (s === undefined)
                    continue;
                const pos = positions.get(s);
                if (isNum(lastClose[s]))
                    lastClose[s] = lastClose[s] / a.ratio;
                if (!pos)
                    continue;
                const exact = pos.shares * a.ratio;
                const newShares = Math.floor(exact + 1e-9);
                const lieuP = isNum(open[s][d]) ? Math.round((exact - newShares) * paise(open[s][d])) : 0;
                cashP += lieuP;
                pos.shares = newShares;
                const adj = (p) => Math.round(p / a.ratio);
                pos.entryPriceP = adj(pos.entryPriceP);
                if (pos.stopP !== null)
                    pos.stopP = adj(pos.stopP);
                if (pos.targetP !== null)
                    pos.targetP = adj(pos.targetP);
                if (pos.partialP !== null) {
                    pos.partialP = adj(pos.partialP);
                    pos.partialLeft = Math.floor(pos.partialLeft * a.ratio + 1e-9);
                    if (pos.partialLeft < 1)
                        pos.partialP = null;
                }
                pos.trailHighP = adj(pos.trailHighP);
            }
        }
        // 1a. Exits decided at the previous close, in symbol order.
        for (const s of [...pendingExits.keys()].sort((a, b) => a - b)) {
            const pos = positions.get(s);
            const pe = pendingExits.get(s);
            if (!pos || !pe) {
                pendingExits.delete(s);
                continue;
            }
            if (!hasBar(s, d)) {
                skips.exitDelayedNoBar++;
                continue;
            }
            if (lockedDown(s, d)) {
                skips.exitDelayedCircuit++;
                continue;
            }
            const priceP = mulDivP(paise(open[s][d]), 10_000 - slipBpFor(s, d, pos.shares), 10_000);
            const cap = capShares(s, d);
            const sold = sell(d, pos, pos.shares, priceP, pe.reason, cap);
            if (sold === 0) {
                skips.exitDelayedNoVolume++;
                continue;
            }
            if (!positions.has(s))
                pendingExits.delete(s);
            else
                skips.exitPartial++;
        }
        // 1b. Rebalance: positions above their target are trimmed first (their cash is there for the entries); the top-ups come after the entries.
        const topUps = [];
        for (const s of [...pendingAdjusts.keys()].sort((a, b) => a - b)) {
            const pos = positions.get(s);
            const pa = pendingAdjusts.get(s);
            if (!pos || pendingExits.has(s))
                continue;
            if (!hasBar(s, d)) {
                skips.adjustNoBar++;
                continue;
            }
            const base = paise(open[s][d]);
            let want = Math.max(1, Math.floor(pa.targetValueP / base));
            if (config.lotSize) {
                const lot = config.lotSize(panel.symbols[s]);
                if (lot > 1)
                    want = Math.max(lot, Math.floor(want / lot) * lot);
            }
            const delta = want - pos.shares;
            if (delta < 0) {
                if (lockedDown(s, d)) {
                    skips.adjustCircuit++;
                    continue;
                }
                const priceP = mulDivP(base, 10_000 - slipBpFor(s, d, -delta), 10_000);
                const cap = capShares(s, d);
                if (cap < -delta)
                    skips.adjustPartial++;
                const before = pos.shares;
                const sold = sell(d, pos, -delta, priceP, 'rebalance', cap);
                // A first target is a share of the position: a trim scales it down with the position (whole shares and lots), so it can
                // never sell the whole position (review fix 2026-10-17). Scaled to nothing, it is dropped and counted like at entry.
                if (sold > 0 && positions.has(s) && pos.partialP !== null && pos.partialLeft > 0) {
                    let left = Math.floor((pos.partialLeft * pos.shares) / before + 1e-9);
                    const lot = lotOf(s);
                    if (lot > 1)
                        left = Math.floor(left / lot) * lot;
                    pos.partialLeft = left;
                    if (left < 1) {
                        bump('partialTooSmall');
                        pos.partialLeft = 0;
                        pos.partialP = null;
                    }
                }
            }
            else if (delta > 0)
                topUps.push({ s, delta, reserveP: pa.reserveP });
        }
        pendingAdjusts.clear();
        // 1c. Entries decided at the previous close: highest rank first, ties by symbol.
        const ordered = [...pendingEntries].sort((a, b) => {
            const ra = isNum(a.rank) ? a.rank : Number.NEGATIVE_INFINITY;
            const rb = isNum(b.rank) ? b.rank : Number.NEGATIVE_INFINITY;
            return rb - ra || a.s - b.s;
        });
        pendingEntries = [];
        for (const pe of ordered) {
            const s = pe.s;
            if (positions.has(s))
                continue;
            if (positions.size >= config.maxPositions) {
                skips.entryNoSlot++;
                continue;
            }
            if (!hasBar(s, d)) {
                skips.entryNoBar++;
                continue;
            }
            if (lockedUp(s, d)) {
                skips.entryCircuit++;
                continue;
            }
            if (!pe.advOk) {
                skips.entryIlliquid++;
                continue;
            }
            const baseP = paise(open[s][d]);
            const priceP = mulDivP(baseP, 10_000 + slipBpFor(s, d, baseP > 0 ? Math.floor(pe.targetValueP / baseP) : 0), 10_000);
            if (priceP <= 0) {
                skips.entryTooSmall++;
                continue;
            }
            let shares = Math.floor(pe.targetValueP / priceP);
            if (config.lotSize) {
                const lot = config.lotSize(panel.symbols[s]);
                if (lot > 1)
                    shares = Math.floor(shares / lot) * lot;
            }
            if (shares < 1) {
                skips.entryTooSmall++;
                continue;
            }
            const cap = capShares(s, d);
            if (shares > cap) {
                if (cap < 1) {
                    skips.entryPartial++;
                    continue;
                }
                shares = Math.floor(cap);
                skips.entryPartial++;
            }
            // Cash: scale down to what can be paid for, fees included; skip when not even one share fits.
            const affordable = (n) => cashP - pe.reserveP - n * priceP - costOf({ date, symbol: panel.symbols[s], side: 'BUY', shares: n, pricePaise: priceP, valuePaise: n * priceP }) >= 0;
            if (!affordable(shares)) {
                let n = Math.min(shares, Math.floor(Math.max(0, cashP - pe.reserveP) / priceP));
                while (n >= 1 && !affordable(n))
                    n--;
                if (n < 1) {
                    skips.entryNoCash++;
                    continue;
                }
                shares = n;
            }
            const cost = record(d, s, 'BUY', shares, priceP, 'entry');
            const stopP = pe.stopBp !== null ? mulDivP(priceP, 10_000 - pe.stopBp, 10_000) : null;
            const targetP = pe.targetBp !== null ? mulDivP(priceP, 10_000 + pe.targetBp, 10_000) : null;
            if (panel.stopDist && pe.stopBp === null)
                bump('stopUnknown');
            if (panel.targetDist && pe.targetBp === null)
                bump('targetUnknown');
            let partialP = null;
            let partialLeft = 0;
            if (sizePct !== null) {
                if (pe.partialBp === null)
                    bump('partialUnknown');
                else {
                    partialLeft = Math.floor((shares * sizePct) / 100 + 1e-9);
                    if (config.lotSize) {
                        const lot = config.lotSize(panel.symbols[s]);
                        if (lot > 1)
                            partialLeft = Math.floor(partialLeft / lot) * lot;
                    }
                    if (partialLeft < 1) {
                        bump('partialTooSmall');
                        partialLeft = 0;
                    }
                    else
                        partialP = mulDivP(priceP, 10_000 + pe.partialBp, 10_000);
                }
            }
            trades.push({ symbol: panel.symbols[s], entryDate: date, entryPricePaise: priceP, shares, exitDate: null, exitPricePaise: null, reason: 'open', open: true, boughtValuePaise: shares * priceP, soldValuePaise: 0, grossPnlPaise: null, costsPaise: cost, netPnlPaise: null, signalDate: panel.calendar[pe.signalDay] });
            positions.set(s, { s, shares, entryDay: d, entryPriceP: priceP, stopP, targetP, trailBp: pe.trailBp, trailHighP: priceP, partialP, partialLeft, entryCostP: cost, tradeIndex: trades.length - 1 });
        }
        // 1d. Rebalance top-ups, paid for out of what the entries left, scaled down like an entry.
        for (const u of topUps) {
            const pos = positions.get(u.s);
            if (!pos)
                continue;
            if (lockedUp(u.s, d)) {
                skips.adjustCircuit++;
                continue;
            }
            const priceP = mulDivP(paise(open[u.s][d]), 10_000 + slipBpFor(u.s, d, u.delta), 10_000);
            let n = u.delta;
            const cap = capShares(u.s, d);
            if (n > cap) {
                skips.adjustPartial++;
                n = Math.floor(cap);
            }
            const total = (k) => k * priceP + costOf({ date, symbol: panel.symbols[u.s], side: 'BUY', shares: k, pricePaise: priceP, valuePaise: k * priceP });
            while (n >= 1 && cashP - u.reserveP - total(n) < 0)
                n = Math.min(n - 1, Math.floor(Math.max(0, cashP - u.reserveP) / priceP));
            if (n < 1) {
                skips.adjustNoCash++;
                continue;
            }
            const cost = record(d, u.s, 'BUY', n, priceP, 'rebalance');
            const t = trades[pos.tradeIndex];
            t.shares += n;
            t.boughtValuePaise += n * priceP;
            t.costsPaise += cost;
            pos.shares += n;
        }
        // 2. Stops, targets and trails on this candlestick, for every open position (symbol order).
        for (const s of [...positions.keys()].sort((a, b) => a - b)) {
            const pos = positions.get(s);
            if (!hasBar(s, d))
                continue; // a halted stock cannot trigger anything
            if (pendingExits.has(s)) {
                // Already waiting to leave (delayed at this open, or cut by the volume cap): it is not triggered again, so its reason is not
                // overwritten, a lock is not counted twice and the volume cap is not spent twice on one session.
                pos.trailHighP = Math.max(pos.trailHighP, paise(high[s][d]));
                continue;
            }
            const oP = paise(open[s][d]);
            const hP = paise(high[s][d]);
            const lP = paise(low[s][d]);
            let stopLevel = pos.stopP;
            if (pos.trailBp !== null) {
                const trail = mulDivP(pos.trailHighP, 10_000 - pos.trailBp, 10_000);
                stopLevel = stopLevel === null ? trail : Math.max(stopLevel, trail);
            }
            let exitP = null;
            let reason = 'stop';
            let capLeft = capShares(s, d);
            if (stopLevel !== null && lP <= stopLevel) {
                exitP = Math.min(stopLevel, oP); // a gap through the stop fills at the open
                reason = pos.trailBp !== null && (pos.stopP === null || stopLevel > pos.stopP) ? 'trail' : 'stop';
            }
            else {
                // A first target below the final one is taken first (the lower level is reached first on the way up).
                if (pos.partialP !== null && pos.partialLeft > 0 && (pos.targetP === null || pos.partialP < pos.targetP) && hP >= pos.partialP && !lockedDown(s, d)) {
                    const t = trades[pos.tradeIndex];
                    // Never the last lot: the rest stays with the stop, the final target and the exit rule.
                    const want = Math.min(pos.partialLeft, pos.shares - lotOf(s));
                    const sold = want < 1 ? 0 : sell(d, pos, want, Math.max(pos.partialP, oP), 'target', capLeft, 'partial');
                    if (want < 1) {
                        bump('partialTooSmall');
                        pos.partialLeft = 0;
                        pos.partialP = null;
                    }
                    if (sold > 0) {
                        capLeft -= sold;
                        pos.partialLeft -= sold;
                        if (pos.partialLeft <= 0)
                            pos.partialP = null;
                        t.partialShares = (t.partialShares ?? 0) + sold;
                        if (t.partialDate === undefined)
                            t.partialDate = date;
                    }
                }
                if (positions.has(s) && pos.targetP !== null && hP >= pos.targetP) {
                    exitP = Math.max(pos.targetP, oP); // a gap above the target fills at the open
                    reason = 'target';
                }
            }
            if (exitP !== null) {
                const slipped = reason === 'target' ? exitP : mulDivP(exitP, 10_000 - slipBpFor(s, d, pos.shares), 10_000);
                if (lockedDown(s, d)) {
                    skips.exitDelayedCircuit++;
                    pendingExits.set(s, { s, reason });
                }
                else {
                    const sold = sell(d, pos, pos.shares, slipped, reason, capLeft);
                    if (sold === 0) {
                        skips.exitDelayedNoVolume++;
                        pendingExits.set(s, { s, reason });
                    }
                    else if (positions.has(s)) {
                        skips.exitPartial++;
                        pendingExits.set(s, { s, reason });
                    }
                }
            }
            const still = positions.get(s);
            if (still)
                still.trailHighP = Math.max(still.trailHighP, hP);
        }
        // 3. Mark at the close; the last known close is carried over a missing candlestick.
        for (let s = 0; s < nSym; s++)
            if (isNum(close[s][d]))
                lastClose[s] = close[s][d];
        let posValueP = 0;
        for (const pos of positions.values())
            posValueP += pos.shares * paise(lastClose[pos.s]);
        equity.push({ date, cashPaise: cashP, positionsPaise: posValueP, equityPaise: cashP + posValueP, openPositions: positions.size });
        // 4. Signals at this close decide the orders for the next session.
        if (d < to) {
            const equityP = cashP + posValueP;
            for (const pos of positions.values()) {
                if (panel.exit[pos.s][d] === TRI_TRUE && !pendingExits.has(pos.s))
                    pendingExits.set(pos.s, { s: pos.s, reason: 'signal' });
                else if (config.maxHoldSessions !== undefined && d - pos.entryDay + 1 >= config.maxHoldSessions && !pendingExits.has(pos.s))
                    pendingExits.set(pos.s, { s: pos.s, reason: 'time' });
            }
            const candidates = [];
            for (let s = 0; s < nSym; s++) {
                if (positions.has(s) || pendingExits.has(s))
                    continue;
                if (panel.entry[s][d] !== TRI_TRUE)
                    continue;
                // A symbol that has both an entry and an exit signal on the day it is flat simply enters; an exit on a flat symbol is nothing.
                candidates.push({ s, rank: panel.rank ? panel.rank[s][d] : Number.NaN });
            }
            // The portfolio after this decision: what is held (and not leaving) plus the best-ranked candidates that fit the free slots.
            const rankOf = (s) => (panel.rank ? panel.rank[s][d] : Number.NaN);
            const byRank = [...candidates].sort((x, y) => (isNum(y.rank) ? y.rank : Number.NEGATIVE_INFINITY) - (isNum(x.rank) ? x.rank : Number.NEGATIVE_INFINITY) || x.s - y.s);
            const free = Math.max(0, config.maxPositions - (positions.size - [...pendingExits.keys()].filter((k) => positions.has(k)).length));
            const kept = [...positions.keys()].filter((k) => !pendingExits.has(k));
            const inPortfolio = [...kept, ...byRank.slice(0, free).map((c) => c.s)];
            const weighted = config.sizing.kind === 'inverse_vol' || config.sizing.kind === 'rank_weighted';
            const span = config.sizing.kind === 'inverse_vol' ? config.sizing.windowDays : 0;
            const weights = weighted
                ? portfolioWeights(config.sizing, inPortfolio.map((s) => ({ s, rank: rankOf(s), sigma: config.sizing.kind === 'inverse_vol' ? sigma(s, d, span) : Number.NaN })), config.maxPositions)
                : null;
            const usable = equityP * (1 - (config.cashBufferPct ?? 0) / 100);
            const targetFor = (s, stopBp) => {
                if (weights) {
                    const t = Math.floor(usable * (weights.get(s) ?? 0));
                    return Math.max(0, config.perNameCapPct !== undefined ? Math.min(t, Math.floor((equityP * config.perNameCapPct) / 100)) : t);
                }
                return sizeTarget(config.sizing, { equityP, maxPositions: config.maxPositions, stopBp, perNameCapPct: config.perNameCapPct, cashBufferPct: config.cashBufferPct });
            };
            const reserveP = Math.floor((equityP * (config.cashBufferPct ?? 0)) / 100);
            for (const c of candidates) {
                // A distance is whole hundredths of a percent; one that rounds to 0 or below (0.004%) is no usable value, like 0 itself
                // (review fix 2026-10-17: it gave a stop at the entry price).
                const bp = (x) => {
                    const v = x !== undefined && isNum(x) ? Math.round(x * 100) : 0;
                    return v > 0 ? v : null;
                };
                const stopBp = bp(panel.stopDist?.[c.s][d]);
                pendingEntries.push({
                    s: c.s, rank: c.rank, stopBp, targetBp: bp(panel.targetDist?.[c.s][d]), trailBp: bp(panel.trailDist?.[c.s][d]), partialBp: bp(panel.partialDist?.[c.s][d]), equityP, signalDay: d,
                    targetValueP: targetFor(c.s, stopBp), advOk: minAdvP <= 0 || adv(c.s, d) * 100 >= minAdvP, reserveP,
                });
            }
            // Rebalance: bring held positions that drifted past the band back to their targets at the next open.
            if (isRebalanceDay(d) && config.sizing.kind !== 'risk_percent') {
                const band = config.rebalance?.driftBandPct ?? 0;
                for (const s of kept.sort((x, y) => x - y)) {
                    const pos = positions.get(s);
                    const target = targetFor(s, null);
                    if (target <= 0)
                        continue;
                    const value = pos.shares * paise(lastClose[s]);
                    if ((Math.abs(value - target) / target) * 100 > band)
                        pendingAdjusts.set(s, { s, targetValueP: target, reserveP });
                }
            }
        }
    }
    // Positions still open stay on the books, marked at the last known close.
    for (const pos of positions.values()) {
        const t = trades[pos.tradeIndex];
        const markP = paise(lastClose[pos.s]);
        t.exitPricePaise = null;
        t.grossPnlPaise = t.soldValuePaise + pos.shares * markP - t.boughtValuePaise;
        t.netPnlPaise = t.grossPnlPaise - t.costsPaise;
        t.markPricePaise = markP;
    }
    const turnoverPaise = fills.reduce((a, f) => a + f.valuePaise, 0);
    return { trades, fills, equity, skips, startEquityPaise: config.capitalPaise, turnoverPaise, rebalanceFills: fills.filter((f) => f.reason === 'rebalance').length };
}
