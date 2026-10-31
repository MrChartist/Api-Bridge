/** "Did you mean" support: the closest known name, or undefined when nothing is close. */
function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit)
        return limit + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            cur.push(v);
            if (v < rowMin)
                rowMin = v;
        }
        if (rowMin > limit)
            return limit + 1;
        prev = cur;
    }
    return prev[b.length];
}
/**
 * A choice that is certainly the one meant (verify 2026-10-25, V-4 audit): the same letters in another case, or the only choice
 * one letter away with no other choice within two (`diamnd` -> `diamond`). A one-click fix is given only then; a nearest choice
 * by spelling may be another meaning (`bearish_harami` for `bullish_harami`), so it stays a "did you mean" hint.
 */
export function certainChoice(word, pool) {
    const lower = word.toLowerCase();
    const same = pool.filter((c) => c !== word && c.toLowerCase() === lower);
    if (same.length === 1)
        return same[0];
    if (word.length < 4)
        return undefined;
    const near = pool.filter((c) => distance(lower, c.toLowerCase(), 2) <= 1);
    const close = pool.filter((c) => distance(lower, c.toLowerCase(), 2) <= 2);
    return near.length === 1 && close.length === 1 ? near[0] : undefined;
}
export function suggest(word, pool) {
    const lower = word.toLowerCase();
    // Very short names have too many near matches to guess usefully; only a change of case is suggested.
    const short = word.length < 3;
    const limit = Math.max(1, Math.min(3, Math.floor(word.length / 3)));
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const cand of pool) {
        if (cand === word)
            continue;
        if (short && cand.toLowerCase() !== lower)
            continue;
        let d = cand.toLowerCase() === lower ? 0 : distance(lower, cand.toLowerCase(), limit);
        if (d > limit)
            continue;
        // Prefer the same first letter and a shorter edit.
        if (cand[0]?.toLowerCase() !== lower[0])
            d += 0.5;
        if (d < bestScore || (d === bestScore && best !== undefined && cand < best)) {
            best = cand;
            bestScore = d;
        }
    }
    return best;
}
// ---- Names that live in another group (2026-10-25) --------------------------------------------------------------------------
/**
 * Names from Pine Script that are spelt differently here. `sameArgs` is true when the arguments mean the same in both, so the
 * name alone can be rewritten; otherwise only the hint names the place and its arguments (a one-click rewrite could keep
 * arguments that mean something else here, and give a different answer without an error).
 */
export const RENAMED = {
    'ta.barssince': { to: 'ta.bars_since', sameArgs: true },
    'ta.valuewhen': { to: 'ta.value_when', sameArgs: true },
    'ta.cum': { to: 'ta.cum_sum', sameArgs: true },
    'ta.dmi': { to: 'ind.adx', sameArgs: false },
    'ta.kc': { to: 'ind.keltner', sameArgs: false },
    'ta.wpr': { to: 'ind.williamsr', sameArgs: false },
    'math.abs': { to: 'abs', sameArgs: true },
    'math.max': { to: 'max', sameArgs: true },
    'math.min': { to: 'min', sameArgs: true },
};
/** The groups searched for a name written without its group, or in the wrong one, in this order (the first that has it wins). */
const HOME_ORDER = ['ta', 'ind', 'math', 'candle', 'price', 'levels', 'xs', 'breadth', 'info', 'fund'];
/**
 * Plain functions a name may be moved to from any group with the same arguments (math.abs is abs). min and max come only from
 * math (RENAMED); sum and avg take a list here, so they are never a rewrite of a two-value or rolling call (B1-11).
 */
const PLAIN_FUNCTIONS = ['abs', 'nz', 'is_na'];
const ROLLING_SUM = 'There is no rolling sum: the sum of the last n values of x is ta.sma(x, n) * n, and the number of candlesticks where a condition was true is ta.count(cond, n). sum([a, b, c]) adds values written out.';
const LIST_AVG = 'avg takes a list in square brackets: write avg([a, b]). For the average of the last n values of x write ta.sma(x, n).';
/**
 * Names from Pine Script that look like a function here but mean something else (B1-11): only the hint says what to write, and
 * there is no one-click rewrite.
 */
export const NOTED = {
    'ta.min': { to: 'ta.lowest', note: 'For the lowest of the last n candlesticks write ta.lowest(x, n); Pine\'s ta.min(x), the lowest so far, is ta.lowest_all(x). min(a, b) is the smaller of two values.' },
    'ta.max': { to: 'ta.highest', note: 'For the highest of the last n candlesticks write ta.highest(x, n); Pine\'s ta.max(x), the highest so far, is ta.highest_all(x). max(a, b) is the larger of two values.' },
    'ta.sum': { to: 'ta.sma', note: ROLLING_SUM },
    'math.sum': { to: 'ta.sma', note: ROLLING_SUM },
    'math.avg': { to: 'avg', note: LIST_AVG },
    'ta.avg': { to: 'avg', note: LIST_AVG },
};
/**
 * Where a name lives when it was written without its group (`rsi` for `ta.rsi`) or in another group (`ta.supertrend` for
 * `ind.supertrend`). Exact names only: a near spelling is the job of `suggest`. `from` is the group it was written in, or null.
 */
export function findElsewhere(name, from, lookup) {
    const noted = from !== null && Object.hasOwn(NOTED, `${from}.${name}`) ? NOTED[`${from}.${name}`] : undefined;
    if (noted)
        return { to: noted.to, sameArgs: false, isValue: false, note: noted.note };
    const renamed = Object.hasOwn(RENAMED, `${from ?? 'ta'}.${name}`) ? RENAMED[`${from ?? 'ta'}.${name}`] : undefined;
    if (renamed)
        return { to: renamed.to, sameArgs: renamed.sameArgs, isValue: false };
    if (from !== null && PLAIN_FUNCTIONS.includes(name))
        return { to: name, sameArgs: true, isValue: false };
    for (const ns of HOME_ORDER) {
        if (ns === from)
            continue;
        const full = `${ns}.${name}`;
        // A Pine habit carries over to ta and math (same arguments); a study in ind or a pattern takes its own settings.
        if (lookup.fn(full))
            return { to: full, sameArgs: ns === 'ta' || ns === 'math', isValue: false };
        if (lookup.value(full))
            return { to: full, sameArgs: true, isValue: true };
    }
    return undefined;
}
