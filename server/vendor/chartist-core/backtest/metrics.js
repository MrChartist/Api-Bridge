const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : Number.NaN);
function sd(a) {
    if (a.length < 2)
        return Number.NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
}
const nz = (x) => (Number.isFinite(x) ? x : null);
export function computeMetrics(sim, o = {}) {
    const ppy = o.periodsPerYear ?? 252;
    const rf = (o.riskFreeAnnualPct ?? 0) / 100 / ppy;
    const minTrades = o.minClosedTrades ?? 30;
    const start = sim.startEquityPaise;
    const eq = sim.equity;
    const n = eq.length;
    const end = n ? eq[n - 1].equityPaise : start;
    const costs = sim.fills.reduce((a, f) => a + f.costPaise, 0);
    const returns = [];
    for (let i = 0; i < n; i++)
        returns.push(eq[i].equityPaise / (i === 0 ? start : eq[i - 1].equityPaise) - 1);
    const years = n / ppy;
    // Drawdowns on the equity path with the starting capital as the first peak.
    let peak = start;
    let maxDd = 0;
    let troughIdx = -1;
    let peakIdxOfMax = -1;
    let curPeakIdx = -1;
    let under = 0;
    let longest = 0;
    for (let i = 0; i < n; i++) {
        const e = eq[i].equityPaise;
        if (e >= peak) {
            peak = e;
            curPeakIdx = i;
            under = 0;
        }
        else {
            under++;
            if (under > longest)
                longest = under;
            const dd = 1 - e / peak;
            if (dd > maxDd) {
                maxDd = dd;
                troughIdx = i;
                peakIdxOfMax = curPeakIdx;
            }
        }
    }
    let recovery = null;
    if (troughIdx >= 0) {
        const level = (peakIdxOfMax >= 0 ? eq[peakIdxOfMax].equityPaise : start);
        for (let i = troughIdx + 1; i < n; i++)
            if (eq[i].equityPaise >= level) {
                recovery = i - troughIdx;
                break;
            }
    }
    else
        recovery = 0;
    const cagr = n >= 60 && end > 0 ? Math.pow(end / start, 1 / years) - 1 : Number.NaN;
    const vol = sd(returns);
    const excess = mean(returns) - rf;
    const downside = Math.sqrt(mean(returns.map((r) => Math.min(r - rf, 0) * Math.min(r - rf, 0))));
    const avgEquity = mean(eq.map((e) => e.equityPaise));
    // Closed trades.
    const dateIndex = new Map(eq.map((e, i) => [e.date, i]));
    const closed = sim.trades.filter((t) => !t.open);
    const rets = closed.map((t) => (t.netPnlPaise / t.boughtValuePaise) * 100);
    const wins = closed.filter((t) => t.netPnlPaise > 0);
    const losses = closed.filter((t) => t.netPnlPaise < 0);
    const winPnl = wins.reduce((a, t) => a + t.netPnlPaise, 0);
    const lossPnl = losses.reduce((a, t) => a + t.netPnlPaise, 0);
    const holds = closed.map((t) => (dateIndex.get(t.exitDate) ?? Number.NaN) - (dateIndex.get(t.entryDate) ?? Number.NaN)).filter(Number.isFinite);
    // Calendar returns.
    const group = (key) => {
        const out = [];
        let prevEnd = start;
        let k = '';
        let last = start;
        for (const row of eq) {
            const kk = key(row.date);
            if (kk !== k) {
                if (k !== '') {
                    out.push({ period: k, pct: (last / prevEnd - 1) * 100 });
                    prevEnd = last;
                }
                k = kk;
            }
            last = row.equityPaise;
        }
        if (k !== '')
            out.push({ period: k, pct: (last / prevEnd - 1) * 100 });
        return out;
    };
    let bench = null;
    if (o.benchmark) {
        const b = [];
        const r = [];
        for (let i = 1; i < n; i++) {
            const x = o.benchmark[i] / o.benchmark[i - 1] - 1;
            if (Number.isFinite(x) && Number.isFinite(returns[i])) {
                b.push(x);
                r.push(returns[i]);
            }
        }
        const mb = mean(b);
        const mr = mean(r);
        const cov = b.length > 1 ? b.reduce((a, x, i) => a + (x - mb) * (r[i] - mr), 0) / (b.length - 1) : Number.NaN;
        const varB = sd(b) * sd(b);
        const beta = cov / varB;
        const up = b.map((x, i) => [x, r[i]]).filter(([x]) => x > 0);
        const down = b.map((x, i) => [x, r[i]]).filter(([x]) => x < 0);
        bench = {
            betaToBenchmark: nz(beta),
            alphaPctPerYear: nz((mr - beta * mb) * ppy * 100),
            upCapture: nz(mean(up.map(([, y]) => y)) / mean(up.map(([x]) => x))),
            downCapture: nz(mean(down.map(([, y]) => y)) / mean(down.map(([x]) => x))),
            correlation: nz(cov / (sd(b) * sd(r))),
        };
    }
    const cagrPct = nz(cagr * 100);
    return {
        totalReturnPct: (end / start - 1) * 100,
        netReturnPct: (end / start - 1) * 100,
        grossReturnPct: ((end + costs) / start - 1) * 100,
        cagrPct,
        calmar: cagrPct !== null && maxDd > 0 ? cagrPct / (maxDd * 100) : null,
        finalEquityPaise: end,
        netProfitPaise: end - start,
        grossProfitPaise: end + costs - start,
        yearlyReturns: group((d) => String(Math.floor(d / 10000))),
        monthlyReturns: group((d) => `${Math.floor(d / 10000)}-${String(Math.floor((d % 10000) / 100)).padStart(2, '0')}`),
        startEquityPaise: start,
        sessions: n,
        years,
        volatilityPct: nz(vol * Math.sqrt(ppy) * 100),
        sharpe: vol > 0 ? nz((excess / vol) * Math.sqrt(ppy)) : null,
        sortino: downside > 0 ? nz((excess / downside) * Math.sqrt(ppy)) : null,
        maxDrawdownPct: maxDd * 100,
        longestUnderwaterSessions: longest,
        maxDrawdownRecoverySessions: recovery,
        exposureAvgPct: n ? mean(eq.map((e) => (e.equityPaise > 0 ? e.positionsPaise / e.equityPaise : 0))) * 100 : 0,
        daysInMarketPct: n ? (eq.filter((e) => e.openPositions > 0).length / n) * 100 : 0,
        turnoverPctPerYear: n >= 20 && avgEquity > 0 ? nz((sim.turnoverPaise / (2 * avgEquity) / years) * 100) : null,
        costsPaise: costs,
        costDragPct: (costs / start) * 100,
        trades: {
            closed: closed.length,
            open: sim.trades.length - closed.length,
            winners: wins.length,
            losers: losses.length,
            avgWinPct: wins.length ? nz(mean(wins.map((t) => (t.netPnlPaise / t.boughtValuePaise) * 100))) : null,
            avgLossPct: losses.length ? nz(mean(losses.map((t) => (t.netPnlPaise / t.boughtValuePaise) * 100))) : null,
            profitFactor: lossPnl < 0 ? winPnl / -lossPnl : null,
            expectancyPct: rets.length ? nz(mean(rets)) : null,
            avgHoldSessions: holds.length ? nz(mean(holds)) : null,
            minClosedTrades: minTrades,
            enoughTrades: closed.length >= minTrades,
        },
        benchmark: bench,
    };
}
