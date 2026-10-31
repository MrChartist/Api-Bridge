import { costTableGate } from './costTable.js';
import { headlinesAllowed, stampLabels } from './labels.js';
import { computeRunId } from './runId.js';
import { PURE_HASH } from '../hash/provider.js';
/** Keys of `summary.trades` that together with `closed` make a win rate: never shown. */
export const WIN_COUNT_KEYS = ['winners', 'losers'];
/** Summary keys that are absolute return headlines (ADR-0004). */
export const HEADLINE_KEYS = ['totalReturnPct', 'cagrPct', 'netReturnPct', 'grossReturnPct', 'finalEquityPaise', 'netProfitPaise', 'grossProfitPaise', 'calmar', 'yearlyReturns', 'monthlyReturns'];
function maskHeadlines(summary, allowed) {
    if (allowed || summary === null || typeof summary !== 'object' || Array.isArray(summary))
        return { summary, withheld: [] };
    const out = { ...summary };
    const withheld = [];
    for (const k of HEADLINE_KEYS) {
        if (k in out && out[k] !== null) {
            out[k] = null;
            withheld.push(k);
        }
    }
    return { summary: out, withheld };
}
function maskWinCounts(summary) {
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary))
        return { summary, withheld: [] };
    const trades = summary.trades;
    if (trades === null || typeof trades !== 'object' || Array.isArray(trades))
        return { summary, withheld: [] };
    const t = { ...trades };
    const withheld = [];
    for (const k of WIN_COUNT_KEYS) {
        if (k in t && t[k] !== null) {
            t[k] = null;
            withheld.push(`trades.${k}`);
        }
    }
    return withheld.length ? { summary: { ...summary, trades: t }, withheld } : { summary, withheld };
}
export function makeEnvelope(a) {
    const labels = stampLabels(a.facts);
    const allowed = headlinesAllowed(labels);
    const gate = costTableGate(a.costTable);
    if (a.costTable.version !== a.inputs.costTableV)
        throw new RangeError(`the cost table is version ${a.costTable.version} but the run says ${a.inputs.costTableV}`);
    const headlines = maskHeadlines(a.summary, allowed);
    const counts = maskWinCounts(headlines.summary);
    const masked = { summary: counts.summary, withheld: [...headlines.withheld, ...counts.withheld] };
    return {
        runId: computeRunId(a.inputs, a.hash ?? PURE_HASH),
        kind: 'backtest',
        asOf: a.facts.asOf,
        labels,
        gates: { headlinesAllowed: allowed, costTable: { version: a.costTable.version, signedOff: gate.ok, reasons: gate.reasons }, userVisible: gate.ok },
        summary: masked.summary,
        withheld: masked.withheld,
        skipped: a.skipped,
        provenance: {
            engineV: a.inputs.engineV, stdlibV: a.inputs.stdlibV, dataV: a.inputs.dataV, costTableV: a.inputs.costTableV, calendarV: a.inputs.calendarV,
            universe: { spec: a.inputs.universe.spec, count: a.inputs.universe.symbols.length }, irHash: a.inputs.irHash,
        },
    };
}
