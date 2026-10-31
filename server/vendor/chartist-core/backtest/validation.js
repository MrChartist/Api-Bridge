// Validation of a strategy (S29): walk-forward windows with a purge gap, a sealed final holdout, a limited sweep grid, a robustness
// check that never names a lone best, and the deflated Sharpe ratio. Pure functions of numbers; nothing here reads a candlestick.
//
// Why these exist (PLAN section 5): a strategy tried many times will look good by luck. The defences are (1) judging on data the choice
// was not made on (walk-forward), (2) a purge gap so a position open at the end of training cannot colour the test, (3) a final
// stretch of history nobody may look at until the one choice is made (the sealed holdout), (4) a count of how many things were tried
// (the trial ledger, in the server) and a Sharpe ratio lowered by that count (deflated Sharpe), and (5) showing the whole surface of a
// sweep, never one top-scoring cell.
import { normCdf } from '../derivatives/normal.js';
/** Smallest sizes accepted (house values: the owner can change them). */
export const MIN_TRAIN_SESSIONS = 60;
export const MIN_TEST_SESSIONS = 20;
export const MAX_PURGE_SESSIONS = 252;
/**
 * The holdout for a calendar of `sessions`: a fifth of it, at most a year (252 sessions). House values, not facts. A short history
 * gets a short holdout rather than none, because a holdout of nothing seals nothing.
 */
export function holdoutSessionsFor(sessions, pct = 20, maxSessions = 252) {
    if (!Number.isInteger(sessions) || sessions < 0)
        throw new RangeError('sessions must be a whole number');
    return Math.min(maxSessions, Math.floor((sessions * pct) / 100));
}
const whole = (name, v, min, max) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
        throw new RangeError(`${name} must be a whole number from ${min} to ${max}`);
    return v;
};
/**
 * Windows over a calendar of `sessions`. Rolling: training starts `testSessions` later each time and keeps its length. Anchored:
 * training always starts at session 0 and grows by `testSessions`. In both, the test starts after a purge gap, and tests follow each
 * other without overlap or gap. A window that would reach into the holdout is not made. Throws when not even one window fits.
 */
export function planWalkForward(sessions, spec) {
    whole('sessions', sessions, 1, 1_000_000);
    if (spec.mode !== 'rolling' && spec.mode !== 'anchored')
        throw new RangeError('mode must be "rolling" or "anchored"');
    const train = whole('trainSessions', spec.trainSessions, MIN_TRAIN_SESSIONS, 100_000);
    const test = whole('testSessions', spec.testSessions, MIN_TEST_SESSIONS, 100_000);
    const purge = whole('purgeSessions', spec.purgeSessions, 0, MAX_PURGE_SESSIONS);
    const hold = whole('holdoutSessions', spec.holdoutSessions, 0, 100_000);
    const usableTo = sessions - 1 - hold;
    const windows = [];
    for (let k = 0;; k++) {
        const trainFrom = spec.mode === 'rolling' ? k * test : 0;
        const trainTo = (spec.mode === 'rolling' ? k * test : 0) + train - 1 + (spec.mode === 'anchored' ? k * test : 0);
        const testFrom = trainTo + 1 + purge;
        const testTo = testFrom + test - 1;
        if (testTo > usableTo)
            break;
        windows.push({ index: k, train: { from: trainFrom, to: trainTo }, test: { from: testFrom, to: testTo } });
    }
    if (windows.length === 0) {
        throw new RangeError(`no window fits: ${sessions} sessions, ${hold} sealed, leaves ${Math.max(0, usableTo + 1)} to use, and one window needs ${train + purge + test}`);
    }
    return { windows, holdout: hold > 0 ? { from: usableTo + 1, to: sessions - 1 } : null, usableTo };
}
// ---- The sweep grid ---------------------------------------------------------------------------------------------------------
export const MAX_SWEEP_PARAMS = 3;
export const MAX_SWEEP_COMBOS = 64;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
/** A grid of up to 3 parameters and 64 cells in all. Values are sorted ascending and must be distinct numbers. */
export function sweepGrid(params) {
    if (!Array.isArray(params) || params.length === 0)
        throw new RangeError('a sweep needs at least one parameter');
    if (params.length > MAX_SWEEP_PARAMS)
        throw new RangeError(`a sweep can vary at most ${MAX_SWEEP_PARAMS} parameters; this one varies ${params.length}`);
    const names = params.map((p) => p.name);
    if (new Set(names).size !== names.length)
        throw new RangeError('a parameter is named twice');
    for (const n of names)
        if (typeof n !== 'string' || !NAME.test(n))
            throw new RangeError(`"${String(n).slice(0, 40)}" is not a setting name`);
    const axes = params.map((p) => {
        if (!Array.isArray(p.values) || p.values.length === 0)
            throw new RangeError(`${p.name} needs at least one value`);
        for (const v of p.values)
            if (typeof v !== 'number' || !Number.isFinite(v))
                throw new RangeError(`${p.name} has a value that is not a number`);
        const sorted = [...p.values].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++)
            if (sorted[i] === sorted[i - 1])
                throw new RangeError(`${p.name} has the value ${sorted[i]} twice`);
        return sorted;
    });
    const shape = axes.map((a) => a.length);
    const total = shape.reduce((a, b) => a * b, 1);
    if (total > MAX_SWEEP_COMBOS)
        throw new RangeError(`a sweep can try at most ${MAX_SWEEP_COMBOS} combinations; this one tries ${total}`);
    const cells = [];
    const coords = new Array(axes.length).fill(0);
    for (let k = 0; k < total; k++) {
        const inputs = {};
        names.forEach((n, i) => { inputs[n] = axes[i][coords[i]]; });
        cells.push({ coords: [...coords], inputs });
        for (let i = axes.length - 1; i >= 0; i--) {
            coords[i]++;
            if (coords[i] < axes[i].length)
                break;
            coords[i] = 0;
        }
    }
    return { names, axes, shape, cells };
}
/** Indexes of the cells one step away (one coordinate up or down), in grid order. */
export function neighbourIndexes(grid, cell) {
    const c = grid.cells[cell].coords;
    const out = [];
    grid.cells.forEach((o, j) => {
        if (j === cell)
            return;
        let diff = 0;
        for (let i = 0; i < c.length; i++)
            diff += Math.abs(o.coords[i] - c[i]);
        if (diff === 1)
            out.push(j);
    });
    return out;
}
/**
 * For each cell: how many of its neighbours agree that the setting works. A cell whose score is high while its neighbours' are not
 * is a spike, not a finding. Cells with fewer than `minTrades` closed trades count as unknown, never as zero.
 */
export function robustness(grid, scores, minTrades = 30) {
    if (scores.length !== grid.cells.length)
        throw new RangeError('one score for each cell');
    const ok = (s) => s.trades >= minTrades && s.score !== null && Number.isFinite(s.score);
    return grid.cells.map((_c, i) => {
        const near = neighbourIndexes(grid, i).filter((j) => ok(scores[j]));
        const positive = near.filter((j) => scores[j].score > 0).length;
        const share = near.length ? positive / near.length : null;
        const plateau = ok(scores[i]) && share !== null ? scores[i].score > 0 && share >= 0.5 : null;
        return { neighbours: near.length, positiveNeighbours: positive, share, plateau };
    });
}
// ---- Returns and the deflated Sharpe ratio ----------------------------------------------------------------------------------
/** Daily returns of equity, the first against the starting capital (the same convention as the metrics). */
export function equityReturns(sim) {
    const eq = sim.equity;
    const out = new Float64Array(eq.length);
    for (let i = 0; i < eq.length; i++)
        out[i] = eq[i].equityPaise / (i === 0 ? sim.startEquityPaise : eq[i - 1].equityPaise) - 1;
    return out;
}
export function returnMoments(returns) {
    const n = returns.length;
    if (n < 2)
        return { n, mean: n ? returns[0] : 0, sd: 0, sr: null, skew: null, kurt: null };
    let sum = 0;
    for (let i = 0; i < n; i++)
        sum += returns[i];
    const mean = sum / n;
    let m2 = 0;
    let m3 = 0;
    let m4 = 0;
    for (let i = 0; i < n; i++) {
        const d = returns[i] - mean;
        m2 += d * d;
        m3 += d * d * d;
        m4 += d * d * d * d;
    }
    const pop = m2 / n;
    const sd = Math.sqrt(m2 / (n - 1));
    if (!(pop > 0))
        return { n, mean, sd, sr: null, skew: null, kurt: null };
    const s = Math.sqrt(pop);
    return { n, mean, sd, sr: mean / sd, skew: m3 / n / (s * s * s), kurt: m4 / n / (pop * pop) };
}
/** Euler-Mascheroni constant. */
const EULER = 0.5772156649015329;
/** The standard normal quantile, by bisection on `normCdf` (slow and exact enough: 1e-12). */
export function normInv(p) {
    if (!(p > 0 && p < 1))
        throw new RangeError('p must be between 0 and 1');
    let lo = -40;
    let hi = 40;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (normCdf(mid) < p)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}
/**
 * The deflated Sharpe ratio (Bailey and Lopez de Prado, 2014). With one try nothing is deflated and it is the probabilistic Sharpe
 * ratio against zero. With N tries the benchmark rises to the largest Sharpe ratio N tries would show by luck:
 *   SR0 = sqrt(V) x ((1 - g) x Phi^-1(1 - 1/N) + g x Phi^-1(1 - 1/(N e)))      (g: Euler-Mascheroni)
 *   DSR = Phi( (SR - SR0) x sqrt(T - 1) / sqrt(1 - skew x SR + (kurt - 1) / 4 x SR^2) )
 * It is not a promise about the future: it says how much of an apparent edge the number of tries can explain.
 */
export function deflatedSharpe(a) {
    if (!Number.isInteger(a.trials) || a.trials < 1)
        throw new RangeError('trials must be a whole number of at least 1');
    const sr0 = a.trials === 1 ? 0 : Math.sqrt(Math.max(0, a.trialSrVariance)) * ((1 - EULER) * normInv(1 - 1 / a.trials) + EULER * normInv(1 - 1 / (a.trials * Math.E)));
    const denom = 1 - a.skew * a.sr + ((a.kurt - 1) / 4) * a.sr * a.sr;
    if (!(a.n > 1) || !(denom > 0) || !Number.isFinite(a.sr))
        return { value: null, expectedMaxSr: sr0 };
    return { value: normCdf(((a.sr - sr0) * Math.sqrt(a.n - 1)) / Math.sqrt(denom)), expectedMaxSr: sr0 };
}
/** Sample variance (n - 1) of the values, or 0 when there are fewer than two. */
export function sampleVariance(values) {
    const n = values.length;
    if (n < 2)
        return 0;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    return values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
}
