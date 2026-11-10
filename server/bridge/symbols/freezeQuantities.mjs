/**
 * Exchange freeze quantities (the largest quantity one order may carry; bigger orders must be sliced) for index
 * derivatives, used only when no connected broker's master publishes a freeze quantity for the contract.
 *
 * The figures are in reference/data/freeze-quantities.json, one row per underlying with its own `asOf`, `source` and
 * `verified` flag. NO row is verified: the exchange circulars could not be opened, only a forum summary of them, so every
 * row says `verified: false`, and resolved instruments say where their freeze quantity came from (`freezeQtySource`). The
 * numbers are the ones that were already here: nothing was changed without a primary source.
 *
 * To update: change the quantity, the `asOf` date, the `source` and the circular, and set `verified: true` only after
 * reading the circular itself (docs/reference-data.md).
 */
import { SHIPPED_FREEZE } from "../reference/shipped.mjs";

/** @typedef {{ freezeQty: number, lotWiseQty: number|null, verified: boolean, asOf: string, source: string|null, circular: string|null, readOn: string|null }} FreezeEntry */

/** "SEGMENT:UNDERLYING" -> FreezeEntry (quantity in units, not lots). */
export const INDEX_FREEZE_QUANTITIES = SHIPPED_FREEZE.entries;

/** The oldest row's date: the list is only as fresh as its stalest figure. */
export const FREEZE_LIST_AS_OF = Object.values(INDEX_FREEZE_QUANTITIES).reduce((oldest, e) => (e.asOf < oldest ? e.asOf : oldest), "9999-12-31");

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
