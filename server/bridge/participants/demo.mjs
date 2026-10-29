/**
 * Deterministic demo participant OI (stream S26, docs/spec/p1-12-guard-participants.md §5.3). Every IST weekday is a
 * pure function of its date, so every demo Bridge shows the same history and nothing is stored or fetched.
 *
 *  - Every series is a seeded mean-reverting random walk (Ornstein–Uhlenbeck on the weekday axis), so the history
 *    wanders like real data rather than repeating a cycle. FII index-futures long % reverts to a level that can shift
 *    around each monthly expiry (about every 21 trading days), clamped to 16–66 %.
 *  - Index futures: total OI 3.2–4.6 lakh contracts a side. Stock futures 18–24 lakh; index options about 18–26 lakh;
 *    stock options 6–14 lakh.
 *  - Σ long = Σ short per instrument exactly: CLIENT is the balancing participant on each side.
 *  - Every 30th weekday has no file (a demo "holiday"), so gaps show.
 *  - One synthetic contract-size revision on 1 Jan of the current year.
 *
 * P1-8 (exposure) reads its demo CE/PE rows from demoParticipantDay() so both pages agree.
 */
import { INSTRUMENTS, PARTICIPANTS } from "./parser.mjs";

export const DEMO_SOURCE = "demo";
const DAY_MS = 86_400_000;
const MONDAY_0 = Date.UTC(1970, 0, 5);

/** FNV-1a 32-bit. */
export function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic noise in [-1, 1] for a date and a key. */
const noise = (date, key) => (hash32(`${date}|${key}`) / 4294967295) * 2 - 1;

/** Weekday count since Mon 5 Jan 1970 (null on Sat/Sun). */
export function weekdayIndex(date) {
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - MONDAY_0) / DAY_MS);
  const dow = ((d % 7) + 7) % 7;
  if (dow > 4) return null;
  return Math.floor(d / 7) * 5 + dow;
}

/** True when the demo publishes a file for this date (weekday and not a demo holiday). */
export function demoHasFile(date) {
  const i = weekdayIndex(date);
  return i !== null && i % 30 !== 17;
}

/**
 * Per-instrument shares of the side total for DII, FII and PRO ([long, short]); CLIENT balances.
 * FII index-futures long is driven by the cycle instead (see below).
 */
const SHARES = {
  IDX_FUT: { DII: [0.045, 0.008], PRO: [0.24, 0.15] },
  IDX_CE: { DII: [0, 0.03], FII: [0.085, 0.12], PRO: [0.19, 0.33] },
  IDX_PE: { DII: [0.01, 0], FII: [0.14, 0.095], PRO: [0.24, 0.38] },
  STK_FUT: { DII: [0.03, 0.32], FII: [0.6, 0.25], PRO: [0.08, 0.1] },
  STK_CE: { DII: [0, 0.002], FII: [0.04, 0.03], PRO: [0.28, 0.42] },
  STK_PE: { DII: [0, 0], FII: [0.035, 0.045], PRO: [0.26, 0.4] },
};

/** Deterministic noise in [-1, 1] for a weekday index and a key (the walks are indexed by weekday, not date). */
const noiseI = (i, key) => (hash32(`w${i}|${key}`) / 4294967295) * 2 - 1;
/** An approximately standard normal draw (sum of three uniforms, sd 1). */
const gauss = (i, key) => (noiseI(i, `${key}a`) + noiseI(i, `${key}b`) + noiseI(i, `${key}c`));

/** The walks start here (any date before it reads the walk's long-run level). */
const ORIGIN = weekdayIndex("2016-01-04");
const WALKS = new Map();
/**
 * A seeded Ornstein–Uhlenbeck walk on the weekday axis: x(i+1) = x(i) + θ(μ(i) − x(i)) + σ·g(i). Pure in (key, i):
 * the path is built once from ORIGIN and memoised, so every date gets the same value however it is asked for.
 * @param {string} key @param {number} i weekday index
 * @param {{ theta: number, sigma: number, mu?: (i: number) => number }} o
 */
function walk(key, i, { theta, sigma, mu = () => 0 }) {
  if (i < ORIGIN) return mu(i);
  let w = WALKS.get(key);
  if (!w) {
    w = [mu(ORIGIN)];
    WALKS.set(key, w);
  }
  for (let k = w.length; k <= i - ORIGIN; k += 1) {
    const j = ORIGIN + k - 1;
    const x = w[k - 1];
    w.push(x + theta * (mu(j) - x) + sigma * gauss(j, key));
  }
  return w[i - ORIGIN];
}
/** A unit walk (long-run sd about 1), clamped to ±lim. */
const unit = (key, i, theta = 0.06, lim = 1.25) => Math.max(-lim, Math.min(lim, walk(key, i, { theta, sigma: Math.sqrt(2 * theta) / Math.sqrt(3) })));

/** The level FII long % reverts to: it may shift around each monthly expiry (every 21 weekdays). */
const fiiLevel = (i) => {
  const r = Math.floor((i + 6) / 21);
  const shift = noiseI(r, "regime");
  return 40 + (Math.abs(shift) > 0.4 ? 21 * shift : 5 * shift);
};
/** FII index-futures long % for a weekday index (≈ 16–66). */
const fiiLongPct = (i, date) => Math.min(65.8, Math.max(16.2, walk("fiip", i, { theta: 0.09, sigma: 2.1 / Math.sqrt(3), mu: fiiLevel }) + 1.1 * noise(date, "fiip")));

/** Side totals (contracts) per instrument for a weekday index. */
function totals(date, i) {
  return {
    IDX_FUT: 390000 + 48000 * unit("tif", i, 0.05) + 6000 * noise(date, "tif"),
    IDX_CE: 2150000 + 280000 * unit("tic", i, 0.12) + 60000 * noise(date, "tic"),
    IDX_PE: 2200000 + 280000 * unit("tip", i, 0.1) + 60000 * noise(date, "tip"),
    STK_FUT: 2100000 + 200000 * unit("tsf", i, 0.04) + 30000 * noise(date, "tsf"),
    STK_CE: 1000000 + 260000 * unit("tsc", i, 0.1) + 40000 * noise(date, "tsc"),
    STK_PE: 960000 + 250000 * unit("tsp", i, 0.1) + 40000 * noise(date, "tsp"),
  };
}

/**
 * One demo day: { date, rows: { CLIENT|DII|FII|PRO|TOTAL: { IDX_FUT|...: [long, short] } } }, or null when the demo
 * publishes no file that day (weekend or demo holiday).
 * @param {string} date  IST YYYY-MM-DD
 */
export function demoParticipantDay(date) {
  if (!demoHasFile(date)) return null;
  const i = weekdayIndex(date);
  const T = totals(date, i);
  const rows = Object.fromEntries([...PARTICIPANTS, "TOTAL"].map((p) => [p, {}]));
  for (const x of INSTRUMENTS) {
    const t = Math.round(T[x]);
    const sh = SHARES[x];
    const side = { DII: [0, 0], FII: [0, 0], PRO: [0, 0] };
    for (const p of ["DII", "FII", "PRO"]) {
      if (!sh[p]) continue;
      side[p] = sh[p].map((s, k) => Math.max(0, Math.round(t * s * (1 + 0.025 * noise(date, `${x}${p}${k}`) + (p === "PRO" && x.startsWith("IDX_") && x !== "IDX_FUT" ? 0.13 : 0.07) * unit(`s${x}${p}${k}`, i, 0.08)))));
    }
    if (x === "IDX_FUT") {
      // FII gross ≈ 86 % of the side total; long % is a mean-reverting walk (≈ 16–66 %).
      const gross = Math.round(t * (0.86 + 0.025 * unit("fiig", i, 0.1) + 0.01 * noise(date, "fiig")));
      const pct = fiiLongPct(i, date);
      const L = Math.round((gross * pct) / 100);
      side.FII = [L, gross - L];
    }
    const client = [0, 1].map((k) => t - side.DII[k] - side.FII[k] - side.PRO[k]);
    rows.CLIENT[x] = client;
    rows.DII[x] = side.DII;
    rows.FII[x] = side.FII;
    rows.PRO[x] = side.PRO;
    rows.TOTAL[x] = [t, t];
  }
  return { date, rows };
}

/** The synthetic contract-size revision: 1 Jan of the current IST year. */
export function demoRevisions(today) {
  const y = Number(String(today).slice(0, 4));
  return [{ date: `${y}-01-01`, regime: `${y}-01`, text: "Sample revision (demo): index lot sizes changed; contract counts before and after are not like for like" }];
}
