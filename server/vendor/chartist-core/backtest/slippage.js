export function validateSlippageProfile(p) {
    const out = [];
    const nonNeg = (x, what) => { if (!Number.isFinite(x) || x < 0)
        out.push(`${what} must be a number of at least 0`); };
    if (!p.id || !p.version)
        out.push('a profile needs an id and a version');
    if (p.kind === 'fixed')
        nonNeg(p.bps, 'bps');
    else if (p.kind === 'adv_bucket') {
        if (p.buckets.length === 0)
            out.push('buckets is empty');
        p.buckets.forEach((b, i) => { nonNeg(b.maxAdvPaise, `bucket ${i + 1} maxAdvPaise`); nonNeg(b.bps, `bucket ${i + 1} bps`); if (i > 0 && b.maxAdvPaise <= p.buckets[i - 1].maxAdvPaise)
            out.push(`bucket ${i + 1} is not above bucket ${i}`); });
        nonNeg(p.overBps, 'overBps');
    }
    else if (p.kind === 'sqrt_impact') {
        nonNeg(p.spreadBps, 'spreadBps');
        nonNeg(p.coef, 'coef');
    }
    else
        out.push('unknown profile kind');
    return out;
}
export function slippageBp(p, c) {
    let bps;
    switch (p.kind) {
        case 'fixed':
            bps = p.bps;
            break;
        case 'adv_bucket': {
            if (c.advPaise === null) {
                bps = Math.max(...p.buckets.map((b) => b.bps), p.overBps);
                break;
            }
            const hit = p.buckets.find((b) => c.advPaise !== null && c.advPaise <= b.maxAdvPaise);
            bps = hit ? hit.bps : p.overBps;
            break;
        }
        case 'sqrt_impact': {
            const sigmaBps = c.sigma === null ? 0 : c.sigma * 10_000;
            bps = p.spreadBps + p.coef * sigmaBps * Math.sqrt(Math.min(1, Math.max(0, c.participation)));
            break;
        }
    }
    return Math.max(0, Math.ceil(bps - 1e-9));
}
