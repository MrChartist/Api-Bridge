/**
 * OUTCOME_UNKNOWN reconciliation (docs/ARCHITECTURE.md §7).
 *
 * A live write that timed out, or failed without a clear refusal, is NEVER retried. Its leg is stored as
 * outcome_unknown and this matcher looks for it in the broker's order book. The contract's Order rows carry no tag,
 * so a leg is matched on what we sent:
 *   same instrument (token, or trading symbol) and exchange · same side · same quantity · placed no earlier than
 *   CLOCK_SKEW_MS before we sent it · for priced orders, the same limit price (within half a tick) ·
 *   and a broker order id no other Bridge leg already owns.
 * Exactly one candidate resolves the leg. None: keep waiting (the job gives up after orders.reconcileGiveUpMs and
 * the order stays outcome_unknown, so nobody is told it failed when it may not have). Several: ambiguous, keep
 * waiting and say so; the user must check the broker app.
 */

/** Broker clocks and ours may differ; also covers brokers that stamp placedAt in whole seconds or minutes. */
export const CLOCK_SKEW_MS = 120_000;

/**
 * @param {{ ref: { token: string, exchange: string, tradingSymbol: string | null }, side: "BUY"|"SELL", quantity: number,
 *   orderType: string, price: number | null, sentAt: number, tickSize: number }} leg
 * @param {object[]} book   contract Order rows
 * @param {Set<string>} claimed broker order ids already owned by Bridge legs
 * @returns {{ match: object | null, candidates: number }}
 */
export function findLegInBook(leg, book, claimed) {
  const candidates = (Array.isArray(book) ? book : []).filter((row) => {
    if (!row || !row.orderId || claimed.has(String(row.orderId))) return false;
    const sameInstrument = (row.token && String(row.token) === String(leg.ref.token)) || (leg.ref.tradingSymbol && row.tradingSymbol === leg.ref.tradingSymbol);
    if (!sameInstrument || row.exchange !== leg.ref.exchange) return false;
    if (row.side !== leg.side || Number(row.qty) !== leg.quantity) return false;
    if (row.placedAt) {
      const t = Date.parse(row.placedAt);
      if (Number.isFinite(t) && t < leg.sentAt - CLOCK_SKEW_MS) return false;
    }
    if ((leg.orderType === "LIMIT" || leg.orderType === "SL") && Number.isFinite(leg.price) && Number(row.price) > 0) {
      const tol = Math.max(leg.tickSize ?? 0, 1e-6) / 2;
      if (Math.abs(Number(row.price) - leg.price) > tol) return false;
    }
    return true;
  });
  return { match: candidates.length === 1 ? candidates[0] : null, candidates: candidates.length };
}
