/**
 * In-memory VolService for OTHER streams' tests (alerts, exposure, strategy, screener). Satisfies SERVICE_CONTRACTS.vol
 * exactly, touches no disk and makes no broker call. Ranks, snapshots and history are whatever the test sets.
 *
 *   import { createFakeVol } from "../vol/fake.mjs";
 *   const vol = createFakeVol();
 *   vol.setRank("NIFTY", { current: { iv: 12.86 }, lookbacks: [{ days: 252, n: 252, ivr: 55.4, ivp: 70.2 }] });
 *   vol.setSnapshot("NIFTY", { cm30: { iv: 12.86 }, rows: [] });
 *   vol.setHistory("NIFTY", [{ date: "2026-10-28", iv: 12.71, quality: "live" }]);
 *   vol.calls        // [["rank", { underlying: "NIFTY" }], ...]
 *
 * An underlying with nothing set answers `available: false, reason: "NOT_TRACKED"` (as the real service does).
 */
import { assertService } from "../core/contracts.mjs";

export function createFakeVol() {
  const calls = [];
  const ranks = new Map();
  const snapshots = new Map();
  const histories = new Map();
  const predictions = [];
  let seq = 0;
  const key = (u) => String(u ?? "").toUpperCase();
  const missing = (underlying) => ({ underlying: key(underlying), available: false, reason: "NOT_TRACKED" });

  const svc = {
    calls,
    setRank: (u, v) => ranks.set(key(u), v),
    setSnapshot: (u, v) => snapshots.set(key(u), v),
    setHistory: (u, items) => histories.set(key(u), items),
    async clock(p) {
      calls.push(["clock", p]);
      return { underlying: key(p?.underlying), settings: { version: "vt1", mode: "weighted" }, holidays: [], expiries: [] };
    },
    async snapshot(p) {
      calls.push(["snapshot", p]);
      const s = snapshots.get(key(p?.underlying));
      return s ? { underlying: key(p.underlying), available: true, stale: false, ...s } : missing(p?.underlying);
    },
    async history(p) {
      calls.push(["history", p]);
      const items = histories.get(key(p?.underlying));
      return items ? { underlying: key(p.underlying), items: [...items], gaps: [], nextCursor: null } : missing(p?.underlying);
    },
    async rank(p) {
      calls.push(["rank", p]);
      const r = ranks.get(key(p?.underlying));
      return r ? { underlying: key(p.underlying), available: true, ...r } : missing(p?.underlying);
    },
    async summary(p) {
      calls.push(["summary", p]);
      const items = (p?.underlyings ?? []).map((u) => {
        const r = ranks.get(key(u));
        const lb = r?.lookbacks?.at(-1);
        return r ? { underlying: key(u), available: true, iv: r.current?.iv ?? null, ...lb } : { underlying: key(u), available: false, reason: "NOT_TRACKED", n: 0 };
      });
      return { lookback: p?.lookback ?? 252, items };
    },
    status() {
      calls.push(["status"]);
      return { demo: false, clock: { version: "vt1", mode: "weighted" }, underlyings: [], backfill: null };
    },
    async capture(p) {
      calls.push(["capture", p]);
      return { jobId: `cap_${(seq += 1)}`, underlyings: p?.underlyings ?? [], startedAt: null };
    },
    async backfill(p) {
      calls.push(["backfill", p]);
      return { jobId: `bf_${(seq += 1)}`, days: 0, files: 0, estimateMinutes: 0 };
    },
    async cancelBackfill() {
      calls.push(["cancelBackfill"]);
    },
    async predictions(p) {
      calls.push(["predictions", p]);
      return { items: predictions.filter((r) => !p?.underlying || r.underlying === key(p.underlying)), nextCursor: null };
    },
    async logPredictions(rows) {
      calls.push(["logPredictions", rows]);
      const ids = [];
      for (const r of rows ?? []) {
        const id = r.id ?? `p_${(seq += 1)}`;
        predictions.push({ ...r, id });
        ids.push(id);
      }
      return { ids };
    },
  };
  assertService("vol", svc);
  return svc;
}
