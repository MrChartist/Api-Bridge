/**
 * Shared option-chain OI maths (docs/spec/p1-01-recorder.md §6.8–6.10; docs/spec/README.md §3.2, created by P1-1a,
 * extended by P1-7 with buckets, VWAP and build-up). Pure: no DOM, no fetch, no clock. The server's daily S3 job
 * (recorder/daily.mjs) and the pages use the same functions, so a figure is computed once.
 *
 * Input rows are option-chain rows `{ strike, ce: { oi, volume } | null, pe: { oi, volume } | null }` (the OpenAPI
 * OptionChain shape; `fromColumns` turns a recorded columnar snapshot into it). Missing values are null, never 0, and
 * every figure is over the strikes given ("over recorded strikes"), not the whole chain.
 *
 * Names are descriptive: `largestOi` is the strike with the largest call or put open interest. It is not called a
 * wall here or anywhere in the UI ("Call Wall"/"Put Wall" are the gamma levels of P1-8).
 */

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Rows from columnar arrays (a recorded snapshot: strikes `k`, per side arrays such as `oi` and `vol`).
 * @param {{ k: number[], ce?: Record<string, Array<number|null>>, pe?: Record<string, Array<number|null>> }} snap
 * @returns {Array<{ strike: number, ce: { oi: number|null, volume: number|null }, pe: { oi: number|null, volume: number|null } }>}
 */
export function fromColumns(snap) {
  const k = Array.isArray(snap?.k) ? snap.k : [];
  const side = (s, i) => ({ oi: num(s?.oi?.[i]), volume: num(s?.vol?.[i] ?? s?.volume?.[i]) });
  return k.map((strike, i) => ({ strike, ce: side(snap.ce, i), pe: side(snap.pe, i) }));
}

/**
 * Put-call ratios (§6.8): pcrOi = Σ PE oi / Σ CE oi and pcrVol = Σ PE volume / Σ CE volume, each over the strikes
 * where both sides have a value. Null when there is no such strike or the call sum is 0.
 * @param {Array<object>} rows
 * @returns {{ pcrOi: number|null, pcrVol: number|null, ceOi: number|null, peOi: number|null, ceVol: number|null, peVol: number|null, strikes: number }}
 */
export function pcr(rows) {
  let ceOi = 0;
  let peOi = 0;
  let ceVol = 0;
  let peVol = 0;
  let nOi = 0;
  let nVol = 0;
  for (const r of rows ?? []) {
    const co = num(r?.ce?.oi);
    const po = num(r?.pe?.oi);
    if (co !== null && po !== null) {
      ceOi += co;
      peOi += po;
      nOi += 1;
    }
    const cv = num(r?.ce?.volume);
    const pv = num(r?.pe?.volume);
    if (cv !== null && pv !== null) {
      ceVol += cv;
      peVol += pv;
      nVol += 1;
    }
  }
  return {
    pcrOi: nOi && ceOi > 0 ? peOi / ceOi : null,
    pcrVol: nVol && ceVol > 0 ? peVol / ceVol : null,
    ceOi: nOi ? ceOi : null,
    peOi: nOi ? peOi : null,
    ceVol: nVol ? ceVol : null,
    peVol: nVol ? peVol : null,
    strikes: nOi,
  };
}

/** Of two strikes, the one nearer `forward` (the lower one on a tie or without a forward). */
const nearer = (a, b, forward) => {
  const F = num(forward);
  if (F === null) return Math.min(a, b);
  const da = Math.abs(a - F);
  const db = Math.abs(b - F);
  return da < db ? a : db < da ? b : Math.min(a, b);
};

/**
 * Max pain (§6.9): pain(S) = Σ_K [CE_oi(K)·max(0, S − K) + PE_oi(K)·max(0, K − S)] over the given strikes; max pain
 * is the given strike S with the smallest pain (ties: nearer the forward). Missing OI counts as no contracts.
 * @param {Array<object>} rows
 * @param {{ forward?: number|null }} [opts]
 * @returns {{ strike: number, pain: number } | null}
 */
export function maxPain(rows, { forward = null } = {}) {
  const legs = (rows ?? [])
    .map((r) => ({ k: num(r?.strike), c: num(r?.ce?.oi) ?? 0, p: num(r?.pe?.oi) ?? 0, any: num(r?.ce?.oi) !== null || num(r?.pe?.oi) !== null }))
    .filter((r) => r.k !== null && r.any);
  if (!legs.length) return null;
  let best = null;
  for (const s of legs) {
    let pain = 0;
    for (const l of legs) pain += l.c * Math.max(0, s.k - l.k) + l.p * Math.max(0, l.k - s.k);
    if (!best || pain < best.pain || (pain === best.pain && nearer(s.k, best.strike, forward) === s.k)) best = { strike: s.k, pain };
  }
  return best;
}

/**
 * The strikes with the largest call OI and the largest put OI (§6.10; ties: nearer the forward).
 * @param {Array<object>} rows
 * @param {{ forward?: number|null }} [opts]
 * @returns {{ call: { strike: number, oi: number } | null, put: { strike: number, oi: number } | null }}
 */
export function largestOi(rows, { forward = null } = {}) {
  const pick = (side) => {
    let best = null;
    for (const r of rows ?? []) {
      const k = num(r?.strike);
      const oi = num(r?.[side]?.oi);
      if (k === null || oi === null) continue;
      if (!best || oi > best.oi || (oi === best.oi && nearer(k, best.strike, forward) === k)) best = { strike: k, oi };
    }
    return best;
  };
  return { call: pick("ce"), put: pick("pe") };
}
