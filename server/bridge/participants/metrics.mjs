/**
 * Pure participant OI metrics (stream S26, docs/spec/p1-12-guard-participants.md §7.10). Inputs are ParticipantDay
 * objects: { date, rows: { CLIENT|DII|FII|PRO|TOTAL: { IDX_FUT|...: [long, short] } } } in contracts.
 *
 *  net = L − S; Δnet = net(d) − net(d−1); long % = L / (L + S) × 100 (2 dp), Δ in percentage points;
 *  share of long = L / Σ_p L (TOTAL row), share of short likewise.
 *
 * Copy is descriptive only ("FII held 31.1 % of their index-futures positions long"): no market view.
 */
import { INSTRUMENTS, PARTICIPANTS, PARTICIPANT_ROWS } from "./parser.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const LONG_PCT_FORMULA = "FII index-futures long % = FII long ÷ (FII long + FII short) × 100, in contracts";

/** Half-up to 2 dp (tiny epsilon so 31.095 does not fall to 31.09 through binary error). */
export const round2 = (x) => (Number.isFinite(x) ? Math.round((x + Math.sign(x) * 1e-9) * 100) / 100 : null);

/** long % (unrounded), or null when the participant holds nothing in that instrument. */
export function longPctRaw(L, S) {
  const g = (Number(L) || 0) + (Number(S) || 0);
  return g > 0 ? (Number(L) / g) * 100 : null;
}

export const longPct = (L, S) => round2(longPctRaw(L, S));

/** The [long, short] pair for one participant and instrument, or null. */
export function pairOf(day, participant, instrument) {
  const p = day?.rows?.[participant]?.[instrument];
  return Array.isArray(p) && p.length === 2 ? p : null;
}

/** Σ over the four participants (when the TOTAL row is missing). */
function totalOf(day, instrument) {
  const t = pairOf(day, "TOTAL", instrument);
  if (t) return t;
  let L = 0;
  let S = 0;
  for (const p of PARTICIPANTS) {
    const x = pairOf(day, p, instrument);
    if (x) {
      L += x[0];
      S += x[1];
    }
  }
  return [L, S];
}

/**
 * One table row (participant × instrument) with day-on-day change against `prev` (may be null).
 * @returns {{ participant, instrument, long, short, net, netChange, longPct, longPctChange, shareOfLong, shareOfShort } | null}
 */
export function cell(day, prev, participant, instrument) {
  const x = pairOf(day, participant, instrument);
  if (!x) return null;
  const [L, S] = x;
  const px = prev ? pairOf(prev, participant, instrument) : null;
  const t = totalOf(day, instrument);
  const lp = longPctRaw(L, S);
  const plp = px ? longPctRaw(px[0], px[1]) : null;
  return {
    participant,
    instrument,
    long: L,
    short: S,
    net: L - S,
    netChange: px ? L - S - (px[0] - px[1]) : null,
    longPct: round2(lp),
    longPctChange: lp !== null && plp !== null ? round2(lp - plp) : null,
    shareOfLong: t[0] > 0 ? round2((L / t[0]) * 100) : null,
    shareOfShort: t[1] > 0 ? round2((S / t[1]) * 100) : null,
  };
}

/** Every participant (and TOTAL) × instrument for the day. */
export function summaryTable(day, prev) {
  const out = [];
  for (const p of PARTICIPANT_ROWS) for (const x of INSTRUMENTS) {
    const c = cell(day, prev, p, x);
    if (c) out.push(c);
  }
  return out;
}

/** Named daily series: a value per day from one ParticipantDay. */
export const SERIES = Object.freeze({
  fiiIndexFutLongPct: { label: "FII index futures long %", unit: "%", of: (d) => longPct(...(pairOf(d, "FII", "IDX_FUT") ?? [0, 0])) },
  fiiIndexFutNet: { label: "FII index futures net", unit: "contracts", of: (d) => netOf(d, "FII", "IDX_FUT") },
  clientIndexCallNet: { label: "Client index calls net", unit: "contracts", of: (d) => netOf(d, "CLIENT", "IDX_CE") },
  clientIndexPutNet: { label: "Client index puts net", unit: "contracts", of: (d) => netOf(d, "CLIENT", "IDX_PE") },
});

export function netOf(day, participant, instrument) {
  const x = pairOf(day, participant, instrument);
  return x ? x[0] - x[1] : null;
}

/** [{ date, value }] for a named series over days sorted oldest first (days without a value are left out). */
export function seriesFor(days, name) {
  const s = SERIES[name];
  if (!s) throw new Error(`Unknown series ${name}`);
  return days.map((d) => ({ date: d.date, value: s.of(d) })).filter((p) => p.value !== null && p.value !== undefined);
}

/** The headline figures the page's tiles and the OI page line read. */
export function headline(day, prev) {
  const c = (p, x) => cell(day, prev, p, x);
  const fii = c("FII", "IDX_FUT");
  const pick = (p, x) => {
    const r = c(p, x);
    return r ? { net: r.net, netChange: r.netChange } : { net: null, netChange: null };
  };
  return {
    fiiIndexFutLongPct: fii?.longPct ?? null,
    fiiIndexFutLongPctChange: fii?.longPctChange ?? null,
    fiiIndexFutNet: fii?.net ?? null,
    fiiIndexFutNetChange: fii?.netChange ?? null,
    clientIndexCall: pick("CLIENT", "IDX_CE"),
    clientIndexPut: pick("CLIENT", "IDX_PE"),
    proIndexCall: pick("PRO", "IDX_CE"),
    proIndexPut: pick("PRO", "IDX_PE"),
    formula: LONG_PCT_FORMULA,
  };
}

/** "28 Oct 2026" */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The note every panel and response carries (BRD §8.4, spec §1.3). */
export function publishedNote(date) {
  return `NSE only. Summed over all strikes and expiries. Number of contracts, for the trading day ended ${longDate(date)}.`;
}

/**
 * The lot regime in force on a date: the id of the latest revision on or before it ("pre-<first>" before all).
 * @param {string} date @param {Array<{ date: string, regime: string }>} revisions sorted by date
 */
export function lotRegimeOn(date, revisions) {
  let r = null;
  for (const v of revisions ?? []) if (v.date <= date) r = v.regime;
  return r ?? (revisions?.length ? `pre-${revisions[0].regime}` : null);
}

/**
 * The §4.2.2 summary body (without source/fetchedAt, which the service adds).
 * @param {{ day: object, prev: object|null, history: object[], revisions: Array<{ date, text }> }} o
 *   history: days sorted oldest first ending with `day` (any length; the headline history uses them all)
 */
export function buildSummary({ day, prev, history = [], revisions = [] }) {
  return {
    date: day.date,
    previousDate: prev?.date ?? null,
    exchange: "NSE",
    unit: "contracts",
    quality: day.quality ?? "ok",
    ...(day.mismatches?.length ? { mismatches: day.mismatches } : {}),
    lotRegime: day.lotRegime ?? null,
    publishedNote: publishedNote(day.date),
    table: summaryTable(day, prev),
    headline: headline(day, prev),
    history: { fiiIndexFutLongPct: seriesFor(history, "fiiIndexFutLongPct"), days: history.length },
    revisions: revisions.filter((r) => !history.length || (r.date >= history[0].date && r.date <= day.date)).map((r) => ({ date: r.date, text: r.text })),
  };
}

/** CSV rows (header first) for a list of days: one row per date × participant × instrument. */
export function csvRows(days, { participants = PARTICIPANT_ROWS, instruments = INSTRUMENTS } = {}) {
  const out = [["date", "exchange", "participant", "instrument", "long", "short", "net", "long_pct", "unit", "quality", "lot_regime"]];
  for (const d of days) for (const p of participants) for (const x of instruments) {
    const v = pairOf(d, p, x);
    if (!v) continue;
    out.push([d.date, "NSE", p, x, v[0], v[1], v[0] - v[1], longPct(v[0], v[1]), "contracts", d.quality ?? "ok", d.lotRegime ?? ""]);
  }
  return out;
}
