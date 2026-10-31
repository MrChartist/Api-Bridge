/**
 * Daily derived rows, S3 (stream S17, docs/spec/p1-01-recorder.md §3.3, §6.8–6.11). Pure.
 *
 * One row per (date, underlying, expiry) from that day's last recorded snapshot: PCR on OI and volume, max pain,
 * largest call and put OI, total OI, the top 5 OI adds and cuts against the previous recorded day (or the broker's
 * own previous-close change, else none), and the near future's basis and rollover. PCR, max pain and largest OI come
 * from the shared dashboard/oi-series.js, so pages and the server compute them once. Exposure columns (gex,
 * zeroGamma) are reserved for P1-8 and stay null.
 *
 * Every figure is over the recorded strikes only (±40 by default), and labelled so where it is shown.
 */
import { fromColumns, largestOi, maxPain, pcr } from "../dashboard/oi-series.js";

const DAY_MS = 86_400_000;
const TOP_N = 5;
const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const roundTo = (v, dp) => {
  const n = num(v);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Calendar days from one IST date to another (YYYY-MM-DD). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Futures basis and rollover (§6.11): basis = fut − spot; annualised = (fut/spot − 1) × 365 / days × 100;
 * rollover = OI_next / (OI_near + OI_next) × 100 (null when either OI is missing).
 * @param {{ date: string, spot: number|null, futures: Array<{ x: string, ltp: number|null, oi: number|null }> }} p
 * @returns {{ x: string, ltp: number, oi: number|null, basis: number, basisAnnPct: number|null, rolloverPct: number|null } | null}
 */
export function futuresBasis({ date, spot, futures }) {
  const list = (futures ?? []).filter((f) => f && f.x >= date && num(f.ltp) !== null && f.ltp > 0).sort((a, b) => (a.x < b.x ? -1 : 1));
  const near = list[0];
  const s = num(spot);
  if (!near || s === null || s <= 0) return null;
  const next = list[1] ?? null;
  const days = daysBetween(date, near.x);
  const nearOi = num(near.oi);
  const nextOi = num(next?.oi);
  return {
    x: near.x,
    ltp: near.ltp,
    oi: nearOi,
    basis: roundTo(near.ltp - s, 2),
    basisAnnPct: days > 0 ? roundTo(((near.ltp / s - 1) * 365 * 100) / days, 2) : null,
    rolloverPct: nearOi !== null && nextOi !== null && nearOi + nextOi > 0 ? roundTo((nextOi / (nearOi + nextOi)) * 100, 1) : null,
  };
}

/**
 * Per-contract OI change (§6.10): today's last OI − the previous recorded day's last OI for the same strike and side.
 * @returns {Array<{ k: number, r: "CE"|"PE", dOi: number }>}
 */
export function oiChanges(today, prev) {
  const out = [];
  if (!today || !prev) return out;
  const prevIndex = new Map(prev.k.map((k, i) => [k, i]));
  today.k.forEach((k, i) => {
    const j = prevIndex.get(k);
    if (j === undefined) return;
    for (const [r, side] of [
      ["CE", "ce"],
      ["PE", "pe"],
    ]) {
      const a = num(today[side]?.oi?.[i]);
      const b = num(prev[side]?.oi?.[j]);
      if (a !== null && b !== null) out.push({ k, r, dOi: a - b });
    }
  });
  return out;
}

/** Changes from the broker's own previous-close OI change arrays (`{ ce: [...], pe: [...] }` aligned to today's k). */
function brokerChanges(today, change) {
  const out = [];
  today.k.forEach((k, i) => {
    for (const [r, side] of [
      ["CE", "ce"],
      ["PE", "pe"],
    ]) {
      const d = num(change?.[side]?.[i]);
      if (d !== null) out.push({ k, r, dOi: d });
    }
  });
  return out;
}

const tops = (changes) => ({
  topAdds: changes
    .filter((c) => c.dOi > 0)
    .sort((a, b) => b.dOi - a.dOi || a.k - b.k)
    .slice(0, TOP_N),
  topCuts: changes
    .filter((c) => c.dOi < 0)
    .sort((a, b) => a.dOi - b.dOi || a.k - b.k)
    .slice(0, TOP_N),
});

/**
 * The S3 row for one chain and day.
 * @param {{ date: string, last: object, prevLast?: object|null, brokerOiChange?: { ce: number[], pe: number[] }|null,
 *   und?: { spot: number|null, fut: Array<{ x: string, ltp: number|null, oi: number|null }> }|null,
 *   counts?: { slots: number, gapSlots: number, partialSlots: number } }} p
 *   last: the day's last snapshot of the chain; prevLast: the previous recorded day's last snapshot of it.
 */
export function dailyRow({ date, last, prevLast = null, brokerOiChange = null, und = null, counts = { slots: 0, gapSlots: 0, partialSlots: 0 } }) {
  const rows = fromColumns(last);
  const forward = num(last.fwd);
  const p = pcr(rows);
  const mp = maxPain(rows, { forward });
  const big = largestOi(rows, { forward });
  let changes = [];
  let basis = "none";
  if (prevLast) {
    changes = oiChanges(last, prevLast);
    basis = "prev-recorded";
  } else if (brokerOiChange) {
    changes = brokerChanges(last, brokerOiChange);
    basis = changes.length ? "broker-prev-close" : "none";
  }
  const spot = num(und?.spot) ?? num(last.spot);
  return {
    v: 1,
    date,
    u: last.u,
    x: last.x,
    asOfSlot: last.slot,
    source: "recorder",
    quality: last.quality,
    spot,
    fwd: forward,
    atm: last.atm ?? null,
    straddle: last.straddle ?? null,
    pcrOi: roundTo(p.pcrOi, 3),
    pcrVol: roundTo(p.pcrVol, 3),
    maxPain: mp?.strike ?? null,
    strikesCovered: last.k.length,
    largestCallOi: big.call ? { k: big.call.strike, oi: big.call.oi } : null,
    largestPutOi: big.put ? { k: big.put.strike, oi: big.put.oi } : null,
    ceOi: p.ceOi,
    peOi: p.peOi,
    ...tops(changes),
    dOiBasis: basis,
    fut: und ? futuresBasis({ date, spot, futures: und.fut }) : null,
    slots: counts.slots ?? 0,
    gapSlots: counts.gapSlots ?? 0,
    partialSlots: counts.partialSlots ?? 0,
    gex: null,
    zeroGamma: null,
  };
}
