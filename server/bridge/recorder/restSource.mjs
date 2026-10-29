/**
 * REST source (stream S17, docs/spec/p1-01-recorder.md §5.1 rules 3–6). One chain read through
 * marketData.optionChain, pinned to the data account, at background priority, only when:
 *  - the recorder's own limiter (budget.mjs, floor(share × limit) on every window) has room, and
 *  - the shared background gate (ratelimit/backgroundGate.mjs) says the call keeps every window at or above half, and
 * with `maxWaitMs: 1500` (so nothing ages past interactive work in the queue) and `backgroundShare`, so the scheduler
 * re-checks the floor when it takes the budget. A chain a user loaded in the last 20 s is reused from the cache
 * (`maxAgeMs: 20000`; a user chain with Greeks serves the recorder's Greeks-off read) and its budget is given back,
 * since it cost the broker nothing. `cost` is the broker calls one read makes: 1 for a broker chain, and for a chain
 * built from quotes ceil(legs / maxQuoteBatch) quote batches plus 1 spot read (builtChainCost); the gate and the
 * recorder's limiter are both charged that. A refusal is a `budget` gap for that chain-slot; nothing retries within
 * the slot.
 */
import { isStub } from "../core/contracts.mjs";
import { createBackgroundGate } from "../ratelimit/backgroundGate.mjs";

export const REST_MAX_WAIT_MS = 1500;
export const REUSE_CACHE_MS = 20_000;

const SESSION_CODES = new Set(["SESSION_EXPIRED", "SESSION_LOGIN_REQUIRED", "UPSTREAM_AUTH"]);
const BUDGET_CODES = new Set(["UPSTREAM_RATE_LIMITED", "RATE_LIMITED", "UPSTREAM_RATE_LIMIT"]);

/** Broker calls one built chain costs: the quote batches for its legs plus one spot read. */
export function builtChainCost(legs, maxQuoteBatch) {
  const batch = Math.max(1, Math.floor(Number(maxQuoteBatch) || 1));
  return Math.ceil(Math.max(0, legs) / batch) + 1;
}

/** Gap reason for a failed read. */
export function gapReasonFor(err) {
  const code = err?.code ?? "";
  if (BUDGET_CODES.has(code)) return "budget";
  if (SESSION_CODES.has(code)) return "session-expired";
  return "broker-error";
}

/**
 * @param {{ marketData: object, scheduler: object, backupData?: object }} deps
 */
export function createRestSource({ marketData, scheduler, backupData }) {
  const gate = scheduler && !isStub(scheduler) ? createBackgroundGate({ scheduler }) : null;

  /** Normalised rows from an OptionChain (OpenAPI shape) with each leg's receive time. */
  function rowsOf(chain, at) {
    return (chain?.rows ?? []).map((r) => ({
      strike: r.strike,
      ce: r.ce ? { ltp: r.ce.ltp ?? null, bid: r.ce.bid ?? null, ask: r.ce.ask ?? null, bidQty: r.ce.bidQty ?? null, askQty: r.ce.askQty ?? null, oi: r.ce.oi ?? null, volume: r.ce.volume ?? null, oiChange: r.ce.oiChange ?? null, at } : null,
      pe: r.pe ? { ltp: r.pe.ltp ?? null, bid: r.pe.bid ?? null, ask: r.pe.ask ?? null, bidQty: r.pe.bidQty ?? null, askQty: r.pe.askQty ?? null, oi: r.pe.oi ?? null, volume: r.pe.volume ?? null, oiChange: r.pe.oiChange ?? null, at } : null,
    }));
  }

  return {
    /**
     * Read one chain for the recorder.
     * @param {{ accountId: string, underlying: string, expiry: string, strikes: number, endpointClass: string,
     *   share: number, budget: ReturnType<import("./budget.mjs").createRecorderBudget>, cost?: number, stopped?: () => boolean }} p
     * @returns {Promise<{ ok: true, rows: object[], spot: number|null, ts: number, lotSize: number|null, accountId: string|null, broker: string|null, cached: boolean }
     *   | { ok: false, reason: string, detail: string }>}
     */
    async read({ accountId, underlying, expiry, strikes, endpointClass, share, budget, cost = 1, stopped = () => false }) {
      const n = Math.max(1, Math.ceil(Number(cost) || 1));
      if (stopped()) return { ok: false, reason: "broker-error", detail: "The recorder stopped." };
      if (gate && !gate.allow(accountId, endpointClass, { share, cost: n })) {
        return { ok: false, reason: "budget", detail: "The broker's rate window is more than half used; the recorder waits for your own requests." };
      }
      if (!budget.tryTake(n)) return { ok: false, reason: "budget", detail: "The recorder's half of the broker budget is used up for this window." };
      let chain;
      try {
        chain = await marketData.optionChain(
          { underlying, expiry, strikes, greeks: false },
          { accountId, priority: "background", maxAgeMs: REUSE_CACHE_MS, maxWaitMs: REST_MAX_WAIT_MS, backgroundShare: share },
        );
      } catch (err) {
        return { ok: false, reason: gapReasonFor(err), detail: String(err?.detail ?? err?.message ?? "The broker did not answer.").slice(0, 200), code: err?.code ?? null };
      }
      const cached = chain?.freshness?.source === "cache";
      if (cached) budget.refund(n); // served from the cache: no broker call was made
      const asOf = Date.parse(chain?.freshness?.asOf ?? "");
      const ts = Number.isFinite(asOf) ? asOf : null;
      return {
        ok: true,
        rows: rowsOf(chain, ts),
        spot: chain?.underlyingLtp ?? null,
        ts,
        lotSize: chain?.lotSize ?? null,
        accountId: chain?.freshness?.accountId ?? accountId,
        broker: chain?.freshness?.broker ?? null,
        cached,
      };
    },

    /** NSE website backup (opt-in, never in demo): legs without Greeks, its own timestamp. */
    async readBackup({ underlying, expiry }) {
      if (!backupData || isStub(backupData)) return { ok: false, reason: "broker-error", detail: "The NSE website backup is not running." };
      try {
        const b = await backupData.optionChain(underlying, expiry);
        const ts = Date.parse(b?.at ?? "");
        const at = Number.isFinite(ts) ? ts : null;
        const rows = (b?.rows ?? []).map((r) => ({ strike: r.strike, ce: r.ce ? { ...r.ce, at } : null, pe: r.pe ? { ...r.pe, at } : null }));
        return { ok: true, rows, spot: b?.underlyingLtp ?? null, ts: at, lotSize: null, accountId: null, broker: null, cached: false };
      } catch (err) {
        return { ok: false, reason: "broker-error", detail: String(err?.message ?? "The NSE website did not answer.").slice(0, 200) };
      }
    },
  };
}
