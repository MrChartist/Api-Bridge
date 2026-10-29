/**
 * Snapshot builder (stream S17, docs/spec/p1-01-recorder.md §3.3, §6.2–6.7). Pure.
 *
 * Turns one chain read (per-leg raw fields from the stream tick book or a REST chain) into the columnar S1 record:
 * per-chain spot, parity forward, ATM, straddle, rate, T on the vol-time clock and calendar T, and per leg Black-76
 * IV, Δ and Γ computed by dashboard/pricing.js (model "b76-vt1"). There is no pricing code here: the clock, the
 * forward and the IV solver are the shared ones (P1-3a). Raw bid/ask/ltp, the forward and the rate are kept, so IV can
 * be recomputed if the model changes.
 *
 * Missing values are null, never 0. Gaps are never filled: a leg with no data stays null and counts as missing.
 */
import { greeks76, impliedVolB76, legPrice, parityForward, volTime } from "../dashboard/pricing.js";

export const SNAPSHOT_VERSION = 1;
/** Model id: Black-76 on the parity forward, vol-time clock vt1 (P1-3). */
export const MODEL = "b76-vt1";
/** Leg keys of a stored snapshot, per side. */
export const LEG_KEYS = Object.freeze(["ltp", "bid", "ask", "bq", "aq", "oi", "vol", "iv", "d", "g", "age"]);
/**
 * Optional per-side column `oc`: the broker's OI change since the previous close (units), stored only when the read
 * carried one (REST chains). The daily job uses it for ΔOI when the previous day was not recorded (§6.10).
 */
export const OI_CHANGE_KEY = "oc";
/** API field name -> stored key (§4.1 `fields`). */
export const FIELD_KEYS = Object.freeze({ ltp: "ltp", bid: "bid", ask: "ask", bidQty: "bq", askQty: "aq", oi: "oi", volume: "vol", iv: "iv", delta: "d", gamma: "g", age: "age" });
export const API_FIELDS = Object.freeze(Object.keys(FIELD_KEYS));
/** Fewer two-sided strikes than this near spot: no forward, no IV (§6.3). */
export const MIN_FORWARD_STRIKES = 3;
/** A snapshot with more than this share of planned legs missing is partial (§6.6). */
export const PARTIAL_SHARE = 0.05;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const roundTo = (v, dp) => {
  const n = num(v);
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const price = (v) => {
  const n = num(v);
  return n === null || n <= 0 ? null : roundTo(n, 2);
};

/** Mid when both sides are quoted (bid > 0, ask ≥ bid), else null. */
export function midOf(leg) {
  const b = num(leg?.bid);
  const a = num(leg?.ask);
  return b !== null && a !== null && b > 0 && a >= b ? (a + b) / 2 : null;
}

/** Mid, else LTP, else null (§6.4 straddle and §6.5 IV price). */
export function markOf(leg) {
  const m = midOf(leg);
  if (m !== null) return m;
  const l = num(leg?.ltp);
  return l !== null && l > 0 ? l : null;
}

/**
 * The parity forward (§6.3): the median over the 5 strikes nearest spot that are two-sided on both CE and PE of
 * K + e^(r·Tcal)(C_mid − P_mid). Fewer than 3 such strikes → null (no fallback model).
 * @param {Array<{ strike: number, ce: object|null, pe: object|null }>} rows
 * @param {{ spot: number|null, rate: number, tcal: number }} p
 */
export function forwardOf(rows, { spot, rate, tcal }) {
  const r = parityForward({ underlyingLtp: spot, rows }, { rate, Tcal: tcal, strikes: 5 });
  return r.source === "parity" && r.strikes >= MIN_FORWARD_STRIKES ? r.F : null;
}

/** The strike nearest `centre` (the lower one on a tie), or null. */
export function atmOf(strikes, centre) {
  const c = num(centre);
  if (c === null || !strikes.length) return null;
  let best = null;
  for (const k of strikes) if (best === null || Math.abs(k - c) < Math.abs(best - c) || (Math.abs(k - c) === Math.abs(best - c) && k < best)) best = k;
  return best;
}

/** CE mark + PE mark at the ATM strike (§6.4); null if either side has neither a mid nor an LTP. */
export function straddleOf(rows, atm) {
  const row = rows.find((r) => r.strike === atm);
  if (!row) return null;
  const c = markOf(row.ce);
  const p = markOf(row.pe);
  return c === null || p === null ? null : c + p;
}

/**
 * IV (percent), Δ and Γ on the forward for one leg (§6.5): price = mid (LTP when a side is missing), solved by the
 * shared Black-76 solver with discount factor df = e^(−r·Tcal); Δ and Γ are discounted: Δ_C = df·N(d1),
 * Δ_P = −df·N(−d1), Γ = df·n(d1)/(F·σ√T). Nulls when the price is below discounted intrinsic, above the bound, or
 * without a forward or time.
 */
export function legGreeks(leg, { forward, strike, right, t, df }) {
  const p = legPrice(leg, "mid").price;
  if (p === null || forward === null || !(t > 0)) return { iv: null, d: null, g: null };
  const iv = impliedVolB76(p, forward, strike, t, right, df);
  if (iv === null) return { iv: null, d: null, g: null };
  const gr = greeks76(forward, strike, t, iv, right);
  if (!gr) return { iv: roundTo(iv, 2), d: null, g: null };
  return { iv: roundTo(iv, 2), d: roundTo(df * gr.delta, 4), g: roundTo(df * gr.gamma, 7) };
}

/**
 * Build one S1 snapshot.
 * @param {{ u: string, x: string, ex: string, slot: number, ts: number, source: "stream"|"rest"|"nse-backup"|"backfill",
 *   accountId: string|null, broker: string|null, accounts?: Record<string, number>|null, quality: string,
 *   oiUnit?: "units"|"lots", oiUnitVerified: boolean, lot: number|null, spot: number|null,
 *   rows: Array<{ strike: number, ce: object|null, pe: object|null }>, plannedLegs?: number }} input
 *   Each leg: { ltp, bid, ask, bidQty, askQty, oi, volume, at } where `at` is when that leg's value was received
 *   (stream: last tick; REST: the chain's asOf). Rows are the planned strikes, ascending.
 * @param {{ clock: object|null, rate: number }} ctx  clock: dashboard/pricing.js clock context (vol/context.mjs)
 * @returns {object} the snapshot record (§3.3)
 */
export function buildSnapshot(input, { clock, rate }) {
  const rows = [...(input.rows ?? [])].filter((r) => num(r?.strike) !== null).sort((a, b) => a.strike - b.strike);
  const k = rows.map((r) => r.strike);
  const vt = clock ? volTime(clock, input.ts, input.x) : null;
  const t = vt && vt.T > 0 ? vt.T : null;
  const tcal = vt && vt.Tcal > 0 ? vt.Tcal : null;
  const r = num(rate) ?? 0;
  const spot = price(input.spot);
  const fwd = tcal !== null ? forwardOf(rows, { spot, rate: r, tcal }) : null;
  const atm = atmOf(k, fwd ?? spot);
  const straddle = atm === null ? null : straddleOf(rows, atm);
  const df = tcal !== null ? Math.exp(-r * tcal) : 1;
  const side = () => Object.fromEntries(LEG_KEYS.map((key) => [key, []]));
  const ce = side();
  const pe = side();
  let missing = 0;
  const oc = { ce: [], pe: [] };
  let anyOc = false;
  for (const row of rows) {
    for (const [right, out] of [
      ["CE", ce],
      ["PE", pe],
    ]) {
      const leg = row[right.toLowerCase()];
      const ltp = price(leg?.ltp);
      const oi = int(leg?.oi);
      if (ltp === null && oi === null) missing += 1;
      const g = leg && fwd !== null && t !== null ? legGreeks(leg, { forward: fwd, strike: row.strike, right, t, df }) : { iv: null, d: null, g: null };
      const at = num(leg?.at);
      out.ltp.push(ltp);
      out.bid.push(price(leg?.bid));
      out.ask.push(price(leg?.ask));
      out.bq.push(int(leg?.bidQty));
      out.aq.push(int(leg?.askQty));
      out.oi.push(oi);
      out.vol.push(int(leg?.volume));
      out.iv.push(g.iv);
      out.d.push(g.d);
      out.g.push(g.g);
      out.age.push(at === null || !leg ? null : Math.max(0, Math.round(input.ts - at)));
      const chg = int(leg?.oiChange);
      if (chg !== null) anyOc = true;
      oc[right === "CE" ? "ce" : "pe"].push(chg);
    }
  }
  if (anyOc) {
    ce[OI_CHANGE_KEY] = oc.ce;
    pe[OI_CHANGE_KEY] = oc.pe;
  }
  const planned = Number.isInteger(input.plannedLegs) && input.plannedLegs > 0 ? input.plannedLegs : rows.length * 2;
  missing += Math.max(0, planned - rows.length * 2);
  return {
    v: SNAPSHOT_VERSION,
    kind: "snap",
    u: input.u,
    x: input.x,
    ex: input.ex,
    slot: input.slot,
    ts: input.ts,
    source: input.source,
    accountId: input.accountId ?? null,
    broker: input.broker ?? null,
    accounts: input.accounts ?? null,
    quality: input.quality,
    partial: missing > PARTIAL_SHARE * planned || fwd === null,
    missingLegs: missing,
    oiUnit: "units",
    oiUnitVerified: Boolean(input.oiUnitVerified),
    lot: int(input.lot),
    spot,
    fwd: roundTo(fwd, 2),
    atm,
    straddle: roundTo(straddle, 2),
    rate: roundTo(r, 6),
    t: roundTo(t, 6),
    tcal: roundTo(tcal, 6),
    model: MODEL,
    k,
    ce,
    pe,
  };
}

/** A gap record (§3.3): one per chain-slot that has no snapshot; reasons are an open list. */
export function gapRecord({ u, x, slot, reason, detail = null }) {
  return { v: SNAPSHOT_VERSION, kind: "gap", u, x, slot, reason, detail };
}

/**
 * Keep only `fields` (API names) and `strikesEach` strikes each side of the snapshot's ATM. Returns a new record with
 * the same stored keys; the strike window is cut around ATM (or the middle strike when there is none).
 * @param {object} snap  stored snapshot
 * @param {{ fields?: string[], strikesEach?: number|null }} [opts]
 */
export function projectSnapshot(snap, { fields = API_FIELDS, strikesEach = null } = {}) {
  const keys = fields.map((f) => FIELD_KEYS[f]).filter(Boolean);
  let lo = 0;
  let hi = snap.k.length;
  if (Number.isInteger(strikesEach) && strikesEach > 0 && snap.k.length) {
    let i = snap.atm === null ? -1 : snap.k.indexOf(snap.atm);
    if (i < 0) i = Math.floor(snap.k.length / 2);
    lo = Math.max(0, i - strikesEach);
    hi = Math.min(snap.k.length, i + strikesEach + 1);
  }
  const cut = (s) => Object.fromEntries(keys.map((key) => [key, (s?.[key] ?? []).slice(lo, hi)]));
  return { ...snap, k: snap.k.slice(lo, hi), ce: cut(snap.ce), pe: cut(snap.pe) };
}
