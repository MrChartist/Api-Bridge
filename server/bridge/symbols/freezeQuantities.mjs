/**
 * Exchange freeze quantities (the largest quantity one order may carry; bigger orders must be sliced) for index
 * derivatives, used only when no connected broker's master publishes a freeze quantity for the contract.
 *
 * NEEDS VERIFICATION. Exchanges revise these by circular, usually alongside lot-size changes, and the figures below
 * are a dated snapshot that has not been checked against the current NSE/BSE circulars. Every entry therefore carries
 * `verified: false`, and resolved instruments say where their freeze quantity came from (`freezeQtySource`). A wrong
 * figure fails safe in one direction only: a value that is too high makes the exchange reject an oversized order; a
 * value that is too low only causes extra slicing. Stock derivatives have per-stock limits and are left null.
 *
 * To update: change the quantity, the `asOf` date and the `source`, and set `verified: true` only after reading the
 * circular itself.
 */

/** @typedef {{ freezeQty: number, verified: boolean, asOf: string, source: string }} FreezeEntry */

export const FREEZE_LIST_AS_OF = "2025-03-01";

const NSE_SOURCE = "NSE F&O quantity freeze limits (snapshot; check the latest NSE circular)";
const BSE_SOURCE = "BSE derivatives quantity freeze limits (snapshot; check the latest BSE notice)";

/** "SEGMENT:UNDERLYING" -> FreezeEntry (quantity in units, not lots). */
export const INDEX_FREEZE_QUANTITIES = Object.freeze({
  "NFO:NIFTY": Object.freeze({ freezeQty: 1800, verified: false, asOf: FREEZE_LIST_AS_OF, source: NSE_SOURCE }),
  "NFO:BANKNIFTY": Object.freeze({ freezeQty: 900, verified: false, asOf: FREEZE_LIST_AS_OF, source: NSE_SOURCE }),
  "NFO:FINNIFTY": Object.freeze({ freezeQty: 1800, verified: false, asOf: FREEZE_LIST_AS_OF, source: NSE_SOURCE }),
  "NFO:MIDCPNIFTY": Object.freeze({ freezeQty: 2800, verified: false, asOf: FREEZE_LIST_AS_OF, source: NSE_SOURCE }),
  "NFO:NIFTYNXT50": Object.freeze({ freezeQty: 600, verified: false, asOf: FREEZE_LIST_AS_OF, source: NSE_SOURCE }),
  "BFO:SENSEX": Object.freeze({ freezeQty: 1000, verified: false, asOf: FREEZE_LIST_AS_OF, source: BSE_SOURCE }),
  "BFO:BANKEX": Object.freeze({ freezeQty: 900, verified: false, asOf: FREEZE_LIST_AS_OF, source: BSE_SOURCE }),
});

/**
 * Freeze entry for a derivative contract, or null (stocks, cash, commodities, unknown indices).
 * @param {{ exchange: string, kind: string, underlying: string }} p
 * @param {Record<string, FreezeEntry>} [table]
 * @returns {FreezeEntry | null}
 */
export function freezeEntryFor(p, table = INDEX_FREEZE_QUANTITIES) {
  if (p.kind !== "FUT" && p.kind !== "OPT") return null;
  return table[`${p.exchange}:${p.underlying}`] ?? null;
}
