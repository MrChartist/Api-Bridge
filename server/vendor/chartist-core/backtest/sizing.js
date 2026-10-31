/** The value, in paise, to put in one new position. 0 means "do not enter". */
export function sizeTarget(sizing, c) {
    const usable = c.equityP * (1 - (c.cashBufferPct ?? 0) / 100);
    let target;
    switch (sizing.kind) {
        case 'equal':
            target = usable / c.maxPositions;
            break;
        case 'fixed_amount':
            target = sizing.amountPaise;
            break;
        case 'percent_equity':
            target = (c.equityP * sizing.pct) / 100;
            break;
        case 'inverse_vol':
        case 'rank_weighted':
            // These rules need the whole portfolio (see `portfolioWeights`); on their own they give an equal share.
            target = usable / c.maxPositions;
            break;
        case 'risk_percent':
            // Risk R between entry and stop: value = R / stop%. Without a stop distance there is no risk to measure: no entry.
            target = c.stopBp !== null && c.stopBp > 0 ? ((c.equityP * sizing.pct) / 100) * (10_000 / c.stopBp) : 0;
            break;
    }
    if (c.perNameCapPct !== undefined)
        target = Math.min(target, (c.equityP * c.perNameCapPct) / 100);
    return Math.max(0, Math.floor(target));
}
/**
 * Weights, as fractions of usable equity, for the stocks that make up the portfolio after a decision: the held ones and the
 * best-ranked candidates that fit in the free slots. They add up to (stocks in the portfolio) / maxPositions, so empty slots stay
 * cash and a full portfolio is fully invested. `equal` and the amount rules do not use this.
 *  - inverse_vol: raw weight 1 / sigma; a stock with no sigma gets 0.
 *  - rank_weighted: ordinal; with n stocks the best rank (ties by symbol) gets raw weight n, the next n - 1, ... the last 1.
 */
export function portfolioWeights(sizing, members, maxPositions) {
    const out = new Map();
    if (members.length === 0)
        return out;
    const raw = new Map();
    if (sizing.kind === 'inverse_vol') {
        for (const m of members)
            raw.set(m.s, m.sigma > 0 && Number.isFinite(m.sigma) ? 1 / m.sigma : 0);
    }
    else if (sizing.kind === 'rank_weighted') {
        const ordered = [...members].sort((a, b) => (Number.isNaN(b.rank) ? Number.NEGATIVE_INFINITY : b.rank) - (Number.isNaN(a.rank) ? Number.NEGATIVE_INFINITY : a.rank) || a.s - b.s);
        ordered.forEach((m, i) => raw.set(m.s, members.length - i));
    }
    else {
        for (const m of members)
            raw.set(m.s, 1);
    }
    let sum = 0;
    for (const v of raw.values())
        sum += v;
    const share = members.length / maxPositions;
    for (const m of members)
        out.set(m.s, sum > 0 ? (raw.get(m.s) / sum) * share : 0);
    return out;
}
