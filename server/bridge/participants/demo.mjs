/**
 * Deterministic demo participant OI (stream S26, docs/spec/p1-12-guard-participants.md §5.3). Every IST weekday is a
 * pure function of its date, so every demo Bridge shows the same history and nothing is stored or fetched.
 *
 *  - Index futures: total OI 3.2–4.6 lakh contracts a side; FII long % follows a 40-trading-day cycle between about
 *    18 % and 64 % plus noise. Stock futures 18–24 lakh; index options about 18–26 lakh; stock options 6–14 lakh.
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

/** Side totals (contracts) per instrument for a weekday index. */
function totals(date, i) {
  const wave = (period, phase = 0) => Math.sin((2 * Math.PI * (i + phase)) / period);
  return {
    IDX_FUT: 390000 + 55000 * wave(57) + 12000 * noise(date, "tif"),
    IDX_CE: 2150000 + 300000 * wave(23, 4) + 80000 * noise(date, "tic"),
    IDX_PE: 2200000 + 300000 * wave(29, 9) + 80000 * noise(date, "tip"),
    STK_FUT: 2100000 + 220000 * wave(61, 7) + 50000 * noise(date, "tsf"),
    STK_CE: 1000000 + 300000 * wave(19, 2) + 60000 * noise(date, "tsc"),
    STK_PE: 950000 + 280000 * wave(21, 11) + 60000 * noise(date, "tsp"),
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
      side[p] = sh[p].map((s, k) => Math.max(0, Math.round(t * s * (1 + 0.035 * noise(date, `${x}${p}${k}`) + 0.05 * Math.sin((2 * Math.PI * (i + k * 5)) / (17 + p.length))))));
    }
    if (x === "IDX_FUT") {
      // FII gross ≈ 88 % of the side total; long % on a 40-trading-day cycle (≈ 18–64 %) plus noise.
      const gross = Math.round(t * (0.86 + 0.04 * noise(date, "fiig")));
      const pct = Math.min(66, Math.max(16, 41 + 19 * Math.sin((2 * Math.PI * i) / 40) + 2.5 * Math.sin((2 * Math.PI * i) / 7.3) + 1.6 * noise(date, "fiip")));
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
