import { fnSpec } from '../stdlib/manifest.js';
import { frameWeight } from '../check/types.js';
import { MAX_LIVE_SERIES, MAX_LOOKBACK } from '../limits.js';
import { refsOf } from './ir.js';
import { rangeOf } from './range.js';
/**
 * How many candlesticks a stock must have for the script to give an answer on the latest one: the earlier candlesticks it needs
 * (`needBars`, rounded up) and the latest itself. This is the figure to show people ("needs 200 candlesticks" for a 200-day
 * average); `needBars` alone is one less (2026-10-25: it was shown as is, one short).
 */
export function candlesticksNeeded(plan) {
    return Math.ceil(plan.needBars) + 1;
}
/**
 * Candlesticks needed with every number setting at its default (2026-10-25, B1-17): the figure for the script as written. A
 * plan's own figure takes each setting at its largest (a setting without max= can go up to 500), so `n = input(20)` with
 * `ta.sma(close, n)` "needs 500" there; this gives 20. Hosts that load history keep using the plan's figure.
 */
export function candlesticksNeededAtDefaults(program) {
    const pinned = {
        ...program,
        inputs: program.inputs.map((i) => (typeof i.default === 'number' ? { ...i, min: i.default, max: i.default } : i)),
    };
    return candlesticksNeeded(makePlan(pinned).plan);
}
export function makePlan(program) {
    const problems = [];
    const nodes = program.nodes;
    const inputs = new Map(program.inputs.map((i) => [i.name, i]));
    const view = { op: (r) => nodes[r], input: (name) => inputs.get(name) };
    const hiOf = (r) => rangeOf(r, view)?.hi;
    const levels = [];
    const lb = [];
    let unbounded = false;
    let crossNodes = 0;
    let snapshotNodes = 0;
    let scanNodes = 0;
    let seriesNodes = 0;
    let cost = 0;
    const frames = new Set();
    nodes.forEach((n, i) => {
        const refs = refsOf(n);
        const m = refs.reduce((x, r) => Math.max(x, levels[r]), 0);
        const spec = n.op === 'call' ? fnSpec(n.fn) : undefined;
        const cross = spec?.returns.kind === 'cross';
        levels.push(cross ? (m % 2 === 0 ? m + 1 : m + 2) : m % 2 === 1 ? m + 1 : m);
        if (cross)
            crossNodes++;
        if (spec?.returns.kind === 'snapshot' || n.op === 'value')
            snapshotNodes++;
        if (n.op === 'scan')
            scanNodes++;
        if (n.ty.series) {
            seriesNodes++;
            cost += 1 / frameWeight(n.ty.frame);
            frames.add(n.ty.frame);
        }
        // History needed.
        let v = 0;
        switch (n.op) {
            case 'field': {
                // A weekly or monthly candlestick exists once a whole period has been seen, and the data can start part-way through one
                // (the first part-period is not a whole week): one whole period plus the days of a part one before it (2026-10-25, B2-5).
                // A month is taken as 23 sessions here, the most it has, so the figure is never short.
                v = n.frame === 'W' || n.frame === 'M' ? 2 * (n.frame === 'M' ? 23 : frameWeight(n.frame)) - 2 : 0;
                break;
            }
            case 'shift': {
                const k = hiOf(n.k);
                if (k === undefined) {
                    unbounded = true;
                    v = Math.max(lb[n.x], MAX_LOOKBACK);
                }
                else
                    v = lb[n.x] + k * frameWeight(nodes[n.x].ty.frame);
                break;
            }
            case 'call': {
                const base = n.args.reduce((x, r) => (nodes[r].ty.series ? Math.max(x, lb[r]) : x), 0);
                const w = spec?.warmup;
                let warm = 0;
                if (w) {
                    let sum = 0;
                    for (const t of w.terms ?? []) {
                        const at = spec?.params.findIndex((p) => p.name === t) ?? -1;
                        const hi = at >= 0 && at < n.args.length ? hiOf(n.args[at]) : undefined;
                        if (hi === undefined)
                            unbounded = true;
                        sum += hi ?? 0;
                    }
                    warm = Math.max(0, sum * (w.mult ?? 1) + (w.add ?? 0));
                }
                v = base + warm * frameWeight(n.ty.frame);
                break;
            }
            default:
                v = refs.reduce((x, r) => Math.max(x, lb[r]), 0);
        }
        lb.push(v);
        void i;
    });
    const needBarsByOutput = program.outputs.map((o) => Math.max(lb[o.value] ?? 0, o.enabled === undefined ? 0 : lb[o.enabled], o.color === undefined ? 0 : lb[o.color], o.other === undefined ? 0 : lb[o.other]));
    const needBars = needBarsByOutput.reduce((x, y) => Math.max(x, y), 0);
    if (unbounded)
        problems.push({ code: 'E-PLAN-UNBOUNDED', message: 'The history this script needs cannot be bounded.', hint: 'Give each setting used as a length or an index a min and a max.' });
    if (needBars > MAX_LOOKBACK)
        problems.push({ code: 'E-LOOKBACK', message: `This script needs ${needBars} candlesticks of history, but the limit is ${MAX_LOOKBACK}.`, hint: 'Use shorter look-backs, or give settings a smaller max.' });
    if (scanNodes > 0)
        problems.push({ code: 'E-PLAN-SCAN-DISABLED', message: 'Scripts that carry state with ta.scan cannot be run yet.', hint: 'Use ta.bars_since, ta.value_when or ta.latch.' });
    // Order of computing, and how many series are alive at once.
    const order = nodes.map((_, i) => i).sort((a, b) => levels[a] - levels[b] || a - b);
    const lastUse = new Array(nodes.length).fill(-1);
    const pos = new Array(nodes.length);
    order.forEach((id, p) => { pos[id] = p; });
    nodes.forEach((n, i) => {
        for (const r of refsOf(n))
            lastUse[r] = Math.max(lastUse[r], pos[i]);
    });
    for (const o of program.outputs)
        for (const r of [o.value, o.enabled, o.color, o.other])
            if (r !== undefined)
                lastUse[r] = order.length;
    let live = 0;
    let liveMax = 0;
    const dies = Array.from({ length: order.length + 1 }, () => []);
    order.forEach((id, p) => {
        if (nodes[id].ty.series) {
            live++;
            const end = Math.max(lastUse[id], p);
            dies[Math.min(end, order.length)].push(id);
        }
        if (live > liveMax)
            liveMax = live;
        live -= dies[p].length;
    });
    if (liveMax > MAX_LIVE_SERIES)
        problems.push({ code: 'E-LIVE-SERIES', message: `This script keeps ${liveMax} series alive at once, but the limit is ${MAX_LIVE_SERIES}.`, hint: 'Split the script, or reuse values instead of repeating long calculations.' });
    const crossPasses = new Set(levels.filter((l) => l % 2 === 1)).size;
    return {
        plan: {
            levels,
            crossPasses,
            order,
            needBars,
            needBarsByOutput,
            frames: [...frames].sort(),
            seriesNodes,
            crossNodes,
            snapshotNodes,
            scanNodes,
            liveSeries: liveMax,
            costPerBar: Math.round(cost * 1000) / 1000,
            requires: program.requires,
        },
        problems,
    };
}
