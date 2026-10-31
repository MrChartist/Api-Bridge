import { absolutePriceLevelNodes } from '../ir/absolutePriceLevel.js';
import { run } from '../runtime/run.js';
/** Most (stocks x sessions) one panel holds. About 52 bytes a cell, so 8 million is about 420 MB. Needs verification against the host. */
export const MAX_PANEL_CELLS = 8_000_000;
/** Why a compiled script cannot be lowered to a panel, or null when it can. */
export function strategyProblem(compiled) {
    const p = compiled.program;
    if (p.kind !== 'strategy')
        return 'Only a script that starts with @strategy can be run as a backtest.';
    if (!p.outputs.some((o) => o.kind === 'entry'))
        return 'The strategy has no entry rule: add strategy.entry(condition).';
    if (p.outputs.some((o) => o.kind === 'leg'))
        return 'This is an option strategy: it is tested on option prices for its underlying, not on a list of stocks.';
    if (compiled.plan.crossPasses > 0) {
        return 'A strategy that compares a stock with the other stocks (xs.* or breadth.*) cannot be run over history yet: those statistics exist for the latest candlestick only. Use strategy.rank(value) to order the candidates instead.';
    }
    if (p.nodes.some((n) => n.ty.partial)) {
        return 'A strategy cannot use partial=True: a coarser candlestick that is still forming is known for the latest session only, so a test over history would be missing it or would look ahead.';
    }
    return null;
}
const tri = (v) => (v === 1 ? 1 : v === 0 ? 0 : 2);
const FIELDS = ['open', 'high', 'low', 'close', 'volume'];
/**
 * Run the strategy on every stock (its own candlesticks, as a screener would see them) and line the answers up on the union of
 * their sessions. A stock has no value on a session it has no candlestick: its signals there are unknown, its prices NaN (a halt).
 */
export function buildSignalPanel(compiled, members, options) {
    const problem = strategyProblem(compiled);
    if (problem)
        throw new RangeError(problem);
    const sorted = [...members].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    for (let i = 1; i < sorted.length; i++)
        if (sorted[i].symbol === sorted[i - 1].symbol)
            throw new RangeError(`the stock ${sorted[i].symbol} is given twice`);
    const skipped = [];
    const got = [];
    const one = (outs, kind) => outs.find((o) => o.kind === kind)?.values ?? null;
    // Two targets: the one with size_pct= is the first (partial) target, the other the final one. Found by their place in the program.
    const program = compiled.program;
    const partialAt = program.outputs.findIndex((o) => o.kind === 'take_profit' && o.sizePct !== undefined);
    const targetAt = program.outputs.findIndex((o) => o.kind === 'take_profit' && o.sizePct === undefined);
    const partialSizePct = partialAt >= 0 ? program.outputs[partialAt].sizePct : null;
    const at = (outs, index) => (index < 0 ? null : outs.find((o) => o.index === index)?.values ?? null);
    for (const m of sorted) {
        try {
            const data = m.load();
            const n = data.daily.date.length;
            const date = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                date[i] = data.daily.date[i];
                if (i > 0 && date[i] <= date[i - 1])
                    throw Object.assign(new RangeError(`the dates are not strictly ascending at position ${i}`), { code: 'E-DATA-ORDER' });
            }
            const r = run(compiled, data.daily, {
                ...(options.inputs ? { inputs: options.inputs } : {}),
                ...(options.holidays ? { holidays: options.holidays } : {}),
                ...(options.maxElements !== undefined ? { maxElements: options.maxElements } : {}),
                ...(data.bench ? { bench: data.bench } : {}),
                ...(data.refs ? { refs: data.refs } : {}),
                ...(data.deriv ? { deriv: data.deriv } : {}),
            });
            const entry = one(r.outputs, 'entry');
            if (!entry)
                throw new RangeError('The entry rule is switched off by a setting, so there is nothing to test.');
            const bars = {};
            for (const f of FIELDS)
                bars[f] = Float64Array.from(data.daily[f]);
            got.push({ symbol: m.symbol, date, bars, entry, exit: one(r.outputs, 'exit'), rank: one(r.outputs, 'rank'), stop: one(r.outputs, 'stop_loss'), target: at(r.outputs, targetAt), partial: at(r.outputs, partialAt), trail: one(r.outputs, 'trail') });
        }
        catch (e) {
            const err = e;
            // A setting that makes the whole strategy meaningless fails every stock the same way; say so once, loudly.
            if (err.message?.startsWith('The entry rule is switched off'))
                throw e;
            skipped.push({ symbol: m.symbol, code: String(err.code ?? 'E-RUN'), message: String(err.message ?? e).slice(0, 300) });
        }
    }
    const all = new Set();
    for (const g of got)
        for (let i = 0; i < g.date.length; i++)
            all.add(g.date[i]);
    const calendar = Int32Array.from([...all].sort((a, b) => a - b));
    const days = calendar.length;
    const cells = days * got.length;
    const limit = options.maxCells ?? MAX_PANEL_CELLS;
    if (cells > limit)
        throw new RangeError(`The universe is too large for one run: ${got.length} stocks over ${days} sessions is ${cells} cells (the limit is ${limit}).`);
    const dayAt = new Map();
    calendar.forEach((d, i) => dayAt.set(d, i));
    const carries = {
        exit: got.some((g) => g.exit !== null), rank: got.some((g) => g.rank !== null),
        stopLoss: got.some((g) => g.stop !== null), takeProfit: got.some((g) => g.target !== null), trail: got.some((g) => g.trail !== null),
        partialTarget: got.some((g) => g.partial !== null),
    };
    const positions = got.map((g) => Int32Array.from(g.date, (d) => dayAt.get(d)));
    const triRows = (pick, empty) => got.map((g, s) => {
        const row = new Uint8Array(days).fill(empty);
        const src = pick(g);
        if (src)
            for (let i = 0; i < src.length; i++)
                row[positions[s][i]] = tri(src[i]);
        return row;
    });
    const numRows = (pick, positive) => got.map((g, s) => {
        const row = new Float64Array(days).fill(Number.NaN);
        const src = pick(g);
        if (src)
            for (let i = 0; i < src.length; i++)
                if (Number.isFinite(src[i]) && (!positive || src[i] > 0))
                    row[positions[s][i]] = src[i];
        return row;
    });
    const aligned = new Map();
    const series = (s, f) => {
        const key = s * 5 + FIELDS.indexOf(f);
        const hit = aligned.get(key);
        if (hit)
            return hit;
        const row = new Float64Array(days).fill(Number.NaN);
        const src = got[s].bars[f];
        for (let i = 0; i < src.length; i++)
            row[positions[s][i]] = src[i];
        aligned.set(key, row);
        return row;
    };
    const panel = {
        calendar,
        symbols: got.map((g) => g.symbol),
        entry: triRows((g) => g.entry, 2),
        // No exit rule: nothing ever exits by signal (0), as opposed to a session with no candlestick (unknown).
        exit: got.map((g, s) => {
            const row = new Uint8Array(days).fill(carries.exit ? 2 : 0);
            if (g.exit)
                for (let i = 0; i < g.exit.length; i++)
                    row[positions[s][i]] = tri(g.exit[i]);
            return row;
        }),
        ...(carries.rank ? { rank: numRows((g) => g.rank, false) } : {}),
        ...(carries.stopLoss ? { stopDist: numRows((g) => g.stop, true) } : {}),
        ...(carries.takeProfit ? { targetDist: numRows((g) => g.target, true) } : {}),
        ...(carries.trail ? { trailDist: numRows((g) => g.trail, true) } : {}),
        ...(carries.partialTarget && partialSizePct !== null ? { partialDist: numRows((g) => g.partial, true), partialSizePct } : {}),
        bars: { adjustmentPolicy: options.adjustmentPolicy, dataVersion: options.dataVersion, series },
        labels: absolutePriceLevelNodes(compiled.program).length > 0 ? ['ADJUSTED_PRICE_LEVEL'] : [],
    };
    return { panel, skipped, symbols: got.length, sessions: days, cells, carries };
}
// ---- The settings on the @strategy line -------------------------------------------------------------------------------------
/** Values taken when the script's type line leaves a setting out. House choices (not facts): the owner confirms them. */
export const STRATEGY_DEFAULTS = {
    capitalRupees: 1_000_000,
    maxPositions: 10,
    rebalance: 'signal',
    /** A rebalance leaves a position alone while its value is within this percent of its target. */
    driftBandPct: 5,
    /** Percent of equity risked between entry and stop under `risk_pct`. */
    riskPct: 1,
    inverseVolWindow: 20,
};
const asDate = (name, v) => {
    const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
    if (!m)
        throw new RangeError(`${name} must be a date written like 2024-01-31`);
    const ymd = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (t.getUTCFullYear() !== Number(m[1]) || t.getUTCMonth() !== Number(m[2]) - 1 || t.getUTCDate() !== Number(m[3]))
        throw new RangeError(`${name} is not a real date: ${String(v)}`);
    return ymd;
};
const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
/** Read the @strategy line into engine settings. `overrides` are the host's (a UI field, a sweep); they win over the script. */
export function strategySettings(program, overrides = {}) {
    if (program.kind !== 'strategy')
        throw new RangeError('Only a script that starts with @strategy has strategy settings.');
    const p = program.params;
    const defaults = [];
    const pick = (key, fallback, read) => {
        if (Object.hasOwn(p, key))
            return read(p[key]);
        defaults.push(key);
        return fallback;
    };
    const capitalRupees = pick('capital', STRATEGY_DEFAULTS.capitalRupees, (v) => Number(v));
    const maxPositions = pick('max_positions', STRATEGY_DEFAULTS.maxPositions, (v) => Number(v));
    const every = pick('rebalance', STRATEGY_DEFAULTS.rebalance, (v) => String(v));
    const sizingName = pick('sizing', 'equal', (v) => String(v));
    const capitalPaise = overrides.capitalPaise ?? Math.round(capitalRupees * 100);
    const maxPos = overrides.maxPositions ?? maxPositions;
    if (!Number.isSafeInteger(capitalPaise) || capitalPaise <= 0)
        throw new RangeError('capital must be a positive amount');
    // Checked here, with the setting's own name, so the host answers E-SETTINGS instead of failing later inside the simulator.
    if (!Number.isInteger(maxPos) || maxPos < 1)
        throw new RangeError('max_positions must be a whole number of at least 1');
    const hasStop = program.outputs.some((o) => o.kind === 'stop_loss');
    let sizing;
    switch (sizingName) {
        case 'equal':
            sizing = { kind: 'equal' };
            break;
        case 'fixed_amount':
            sizing = { kind: 'fixed_amount', amountPaise: Math.floor(capitalPaise / maxPos) };
            break;
        case 'pct_equity':
            sizing = { kind: 'percent_equity', pct: 100 / maxPos };
            break;
        case 'risk_pct':
            if (!hasStop && !overrides.sizing)
                throw new RangeError('sizing="risk_pct" needs a strategy.stop_loss(pct=...): the risk is measured from the entry to the stop.');
            sizing = { kind: 'risk_percent', pct: STRATEGY_DEFAULTS.riskPct };
            break;
        case 'inverse_vol':
            sizing = { kind: 'inverse_vol', windowDays: STRATEGY_DEFAULTS.inverseVolWindow };
            break;
        case 'rank_weighted':
            sizing = { kind: 'rank_weighted' };
            break;
        default: throw new RangeError(`sizing "${sizingName}" is not one of equal, fixed_amount, pct_equity, risk_pct, inverse_vol, rank_weighted`);
    }
    let maxHold = null;
    if (Object.hasOwn(p, 'max_hold')) {
        maxHold = Number(p.max_hold);
        if (!Number.isInteger(maxHold) || maxHold < 1)
            throw new RangeError('max_hold must be a whole number of sessions, at least 1');
    }
    if (!['signal', 'daily', 'weekly', 'monthly'].includes(every))
        throw new RangeError(`rebalance "${every}" is not one of signal, daily, weekly, monthly`);
    return {
        capitalPaise, maxPositions: maxPos, sizing: overrides.sizing ?? sizing,
        rebalance: overrides.rebalance ?? { every: every, driftBandPct: STRATEGY_DEFAULTS.driftBandPct },
        from: Object.hasOwn(p, 'from_') ? asDate('from_', p.from_) : null,
        to: Object.hasOwn(p, 'to') ? asDate('to', p.to) : null,
        universe: text(p.universe), benchmark: text(p.benchmark), costs: text(p.costs), split: text(p.split),
        maxHoldSessions: maxHold,
        defaults,
    };
}
/**
 * The simulator's config for these settings on this panel: the window `from_`..`to` becomes calendar indexes, and the capital,
 * position limit, sizing, rebalance and time stop (`max_hold`, only when given) come across. Costs, slippage, corporate actions and liquidity belong to the host.
 */
export function configFor(settings, calendar) {
    const n = calendar.length;
    let fromIndex = 0;
    let toIndex = n - 1;
    if (settings.from !== null) {
        fromIndex = -1;
        for (let i = 0; i < n; i++)
            if (calendar[i] >= settings.from) {
                fromIndex = i;
                break;
            }
        if (fromIndex < 0)
            throw new RangeError('from_ is after the last session of the data');
    }
    if (settings.to !== null) {
        toIndex = -1;
        for (let i = n - 1; i >= 0; i--)
            if (calendar[i] <= settings.to) {
                toIndex = i;
                break;
            }
        if (toIndex < 0)
            throw new RangeError('to is before the first session of the data');
    }
    if (toIndex < fromIndex)
        throw new RangeError('the window from_..to holds no session');
    return {
        capitalPaise: settings.capitalPaise, maxPositions: settings.maxPositions, sizing: settings.sizing, rebalance: settings.rebalance, fromIndex, toIndex,
        ...(settings.maxHoldSessions !== null ? { maxHoldSessions: settings.maxHoldSessions } : {}),
    };
}
