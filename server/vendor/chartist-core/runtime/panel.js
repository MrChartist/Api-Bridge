// Panel execution (S19): scripts that compare a stock with the other stocks (`xs.*`, `breadth.*`), for the screener, where the
// answer is the value on the latest candlestick.
//
// How: every call across the universe is a "level": a call whose arguments do not depend on another such call is level 1; one
// that does (`xs.pct_rank(xs.group_median(r, by=...))`) is one level above its deepest argument. For level L = 1, 2, ... every stock
// is run once with the calls below L answered from the earlier levels and the calls at L CAPTURING the value of their argument
// on the latest candlestick; then the calls at L are worked out over the whole universe. A last run per stock reads the outputs.
// So a script with one level costs two runs per stock, one with two levels three.
//
// Rules, and why:
// - A stock whose value is missing is left out of the statistics and COUNTED (`excluded`); its own answer is missing, never 0.
// - Ties get the average of the ranks they span.
// - A call answers on the latest candlestick only (like `levels.*`): earlier candlesticks are missing, so a cross-stock test inside
//   a window or a shift is refused by the checker.
// - The same stocks, the same data and the same settings give the same answer, in any order of the stocks: statistics are worked
//   out from sorted values and ties are resolved by value, never by position.
import { PURE_HASH } from '../hash/provider.js';
import { refsOf } from '../ir/ir.js';
import { run } from './run.js';
const U = Number.NaN;
const isU = (x) => x !== x;
export const createPanelCache = () => {
    const m = new Map();
    return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
};
// ---- The statistics -----------------------------------------------------------------------------------------------------
/** Average rank (1 = smallest) of each value, ties sharing the average of the ranks they span. NaN stays NaN. */
export function averageRanks(values) {
    const idx = values.map((v, i) => [v, i]).filter(([v]) => !isU(v)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = new Array(values.length).fill(U);
    let i = 0;
    while (i < idx.length) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0])
            j++;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++)
            out[idx[k][1]] = avg;
        i = j + 1;
    }
    return out;
}
/** 0 for the smallest, 100 for the largest; fewer than two values cannot be ranked. */
export function percentRanks(values) {
    const n = values.filter((v) => !isU(v)).length;
    const r = averageRanks(values);
    return r.map((x) => (isU(x) || n < 2 ? U : ((x - 1) / (n - 1)) * 100));
}
/** Rank from the largest: 1 is the highest value. */
export function descendingRanks(values) {
    const n = values.filter((v) => !isU(v)).length;
    return averageRanks(values).map((x) => (isU(x) ? U : n + 1 - x));
}
export function zscores(values) {
    const xs = values.filter((v) => !isU(v));
    const n = xs.length;
    if (n < 2)
        return values.map(() => U);
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return values.map((v) => (isU(v) || sd === 0 ? U : (v - mean) / sd));
}
export function median(values) {
    const xs = values.filter((v) => !isU(v)).sort((a, b) => a - b);
    if (xs.length === 0)
        return U;
    const m = xs.length >> 1;
    return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
/** Apply `f` to the values of each group separately. A stock with no group is missing. */
function byGroup(values, groups, f) {
    const out = new Array(values.length).fill(U);
    const members = new Map();
    groups.forEach((g, i) => { if (g !== '')
        members.set(g, [...(members.get(g) ?? []), i]); });
    for (const ids of members.values()) {
        const r = f(ids.map((i) => values[i]));
        ids.forEach((i, k) => { out[i] = typeof r === 'number' ? (isU(values[i]) ? U : r) : r[k]; });
    }
    return out;
}
const STATS = {
    'xs.rank': (x) => descendingRanks(x),
    'xs.pct_rank': (x) => percentRanks(x),
    'xs.zscore': (x) => zscores(x),
    'xs.group_pct_rank': (x, g) => byGroup(x, g, percentRanks),
    'xs.group_median': (x, g) => byGroup(x, g, median),
};
const isCross = (fn) => fn.startsWith('xs.') || fn.startsWith('breadth.');
function crossCalls(program) {
    const nodes = program.nodes;
    const needed = new Array(nodes.length).fill(false);
    for (const o of program.outputs) {
        needed[o.value] = true;
        if (o.enabled !== undefined)
            needed[o.enabled] = true;
    }
    for (let id = nodes.length - 1; id >= 0; id--)
        if (needed[id])
            for (const r of refsOf(nodes[id]))
                needed[r] = true;
    const level = new Array(nodes.length).fill(0);
    const out = [];
    for (let id = 0; id < nodes.length; id++) {
        if (!needed[id])
            continue;
        const n = nodes[id];
        let below = 0;
        for (const r of refsOf(n))
            below = Math.max(below, level[r]);
        if (n.op === 'call' && isCross(n.fn)) {
            level[id] = below + 1;
            out.push({ node: id, fn: n.fn, level: level[id], feed: feedDigest(program, id) });
        }
        else
            level[id] = below;
    }
    return out;
}
/** The nodes an argument list reads, with their references renumbered from 0, as text and then as a digest. */
function feedDigest(program, id) {
    const seen = new Set();
    const stack = [...refsOf(program.nodes[id])];
    while (stack.length) {
        const r = stack.pop();
        if (seen.has(r))
            continue;
        seen.add(r);
        for (const x of refsOf(program.nodes[r]))
            stack.push(x);
    }
    const order = [...seen].sort((a, b) => a - b);
    const local = new Map(order.map((g, i) => [g, i]));
    const text = JSON.stringify(order.map((g) => JSON.parse(JSON.stringify(program.nodes[g], (k, v) => (k === 'ty' ? undefined : v)))).map((n) => remap(n, local)));
    return PURE_HASH.sha256Hex(`${program.nodes[id].op === 'call' ? program.nodes[id].fn : ''}|${text}`);
}
function remap(n, local) {
    const out = { ...n };
    delete out.id;
    for (const k of ['x', 'k', 'a', 'b', 'cond', 'init', 'body'])
        if (typeof out[k] === 'number')
            out[k] = local.get(out[k]) ?? out[k];
    for (const k of ['args'])
        if (Array.isArray(out[k]))
            out[k] = out[k].map((r) => local.get(r) ?? r);
    return out;
}
function lastOf(a) {
    return typeof a === 'number' ? a : a.length ? a[a.length - 1] : U;
}
function latestOnly(n, v) {
    const a = new Float64Array(n).fill(U);
    if (n > 0)
        a[n - 1] = v;
    return a;
}
export function runPanel(script, members, options = {}) {
    const calls = crossCalls(script.program);
    const maxLevel = calls.reduce((m, c) => Math.max(m, c.level), 0);
    const N = members.length;
    // captured[callIndex][memberIndex], resolved[callIndex][memberIndex]
    const captured = calls.map(() => new Array(N));
    const resolved = calls.map(() => new Array(N).fill(U));
    const levels = [];
    let cacheHits = 0;
    const inputsKey = JSON.stringify(options.inputs ?? {}, Object.keys(options.inputs ?? {}).sort());
    const runOne = (i, mode) => {
        const data = members[i].load();
        let callNo = -1;
        const wrap = (fn) => (ctx) => {
            callNo++;
            const k = callNo;
            const call = calls[k];
            if (!call || call.fn !== fn)
                throw new Error(`panel: call ${k} is ${fn} but the program has ${call?.fn ?? 'nothing'}`);
            if (mode.kind === 'final' || call.level < mode.level)
                return latestOnly(ctx.n, resolved[k][i]);
            if (call.level > mode.level)
                return latestOnly(ctx.n, U);
            // call.level === mode.level: capture the argument
            const arg0 = ctx.args[0];
            const x = fn.startsWith('breadth.') ? breadthValue(fn, ctx) : arg0 && 's' in arg0 ? lastOf(arg0.s) : arg0 && 'c' in arg0 ? arg0.c : U;
            const by = ctx.args[1];
            captured[k][i] = { x, group: by && 't' in by ? by.t : '' };
            return latestOnly(ctx.n, U);
        };
        const functions = {};
        for (const c of calls)
            functions[c.fn] = wrap(c.fn);
        const r = run(script, data.daily, {
            ...(options.inputs ? { inputs: options.inputs } : {}),
            ...(options.maxElements !== undefined ? { maxElements: options.maxElements } : {}),
            ...(options.holidays ? { holidays: options.holidays } : {}),
            ...(data.bench ? { bench: data.bench } : {}),
            ...(data.refs ? { refs: data.refs } : {}),
            ...(data.snapshots ? { snapshots: data.snapshots } : {}),
            ...(data.deriv ? { deriv: data.deriv } : {}),
            ...(data.values ? { values: data.values } : {}),
            functions,
            cross: true,
        });
        return r.outputs;
    };
    const errors = new Map();
    const guard = (i, f) => {
        if (errors.has(i))
            return;
        try {
            f();
        }
        catch (e) {
            const err = e;
            errors.set(i, { code: String(err.code ?? 'E-RUN'), message: String(err.message ?? e).slice(0, 300) });
        }
    };
    for (let level = 1; level <= maxLevel; level++) {
        const here = calls.map((c, k) => [c, k]).filter(([c]) => c.level === level);
        for (let i = 0; i < N; i++) {
            guard(i, () => {
                // Level 1 can come from the cache: nothing it reads depends on another stock.
                let allCached = level === 1 && !!options.cache && options.dataVersion !== undefined;
                if (allCached) {
                    for (const [c, k] of here) {
                        const hit = options.cache.get(`${options.dataVersion}|${members[i].symbol}|${inputsKey}|${c.feed}`);
                        if (!hit) {
                            allCached = false;
                            break;
                        }
                        captured[k][i] = hit;
                    }
                }
                if (allCached) {
                    cacheHits++;
                    return;
                }
                runOne(i, { kind: 'capture', level });
                if (level === 1 && options.cache && options.dataVersion !== undefined) {
                    for (const [c, k] of here)
                        if (captured[k][i])
                            options.cache.set(`${options.dataVersion}|${members[i].symbol}|${inputsKey}|${c.feed}`, captured[k][i]);
                }
            });
        }
        for (const [c, k] of here) {
            const xs = members.map((_, i) => (errors.has(i) || !captured[k][i] ? U : captured[k][i].x));
            const groups = members.map((_, i) => (errors.has(i) || !captured[k][i] ? '' : captured[k][i].group));
            const values = crossResult(c.fn, xs, groups);
            for (let i = 0; i < N; i++)
                resolved[k][i] = values[i];
            // A stock is in the statistic when it has a value (and, for a group call, a group).
            const counted = xs.filter((v, i) => !isU(v) && (!c.fn.includes('group') || groups[i] !== '')).length;
            levels.push({ fn: c.fn, level, counted, excluded: N - counted });
        }
    }
    const out = [];
    for (let i = 0; i < N; i++) {
        let outputs = null;
        guard(i, () => { outputs = runOne(i, { kind: 'final' }); });
        const err = errors.get(i);
        out.push(err ? { symbol: members[i].symbol, outputs: null, error: err } : { symbol: members[i].symbol, outputs });
    }
    return { members: out, levels, passes: maxLevel + 1, cacheHits };
}
/** What one stock contributes to a breadth call (read from its own closes). */
function breadthValue(fn, ctx) {
    const close = ctx.bars.close;
    const n = ctx.n;
    if (n === 0)
        return U;
    if (fn === 'breadth.adv_dec') {
        if (n < 2 || isU(close[n - 1]) || isU(close[n - 2]))
            return U;
        return close[n - 1] > close[n - 2] ? 1 : close[n - 1] < close[n - 2] ? -1 : 0;
    }
    const a = ctx.args[0];
    const len = a && typeof a.c === 'number' ? a.c : 0;
    if (len < 1 || n < len || isU(close[n - 1]))
        return U;
    let sum = 0;
    for (let i = n - len; i < n; i++) {
        if (isU(close[i]))
            return U;
        sum += close[i];
    }
    return close[n - 1] > sum / len ? 1 : 0;
}
function crossResult(fn, x, groups) {
    const stat = STATS[fn];
    if (stat)
        return stat(x, groups);
    const known = x.filter((v) => !isU(v));
    if (fn === 'breadth.pct_above_ma') {
        const v = known.length ? (known.reduce((a, b) => a + b, 0) / known.length) * 100 : U;
        return x.map((s) => (isU(s) ? U : v));
    }
    if (fn === 'breadth.adv_dec') {
        const adv = known.filter((v) => v > 0).length;
        const dec = known.filter((v) => v < 0).length;
        const v = dec === 0 ? U : adv / dec;
        return x.map((s) => (isU(s) ? U : v));
    }
    throw new Error(`panel: no statistic for ${fn}`);
}
