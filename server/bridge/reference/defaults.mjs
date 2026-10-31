/**
 * Reference-data defaults (stream S16, docs/spec/p1-02-reference.md §2.5). This is the ONLY server file allowed to hold
 * the store-S5 default literals: the risk-free rate, the equity-derivatives session times and the default brokerage.
 * Everything else reads them through `deps.reference` (or imports them from here when no service is running, as the
 * demo adapter and the paper engine's fallback do). The static test reference/noConstants.test.mjs keeps them out of
 * every other file.
 *
 * Each value carries a `source`. The session times and the pre-open window need verification against the current
 * NSE/BSE circulars; the rate is not sourced at all, which the API and the dashboard say every time they show it.
 */

/** Where the session defaults come from (shown in API responses and on the Market calendar page). */
// User-facing words (shown in the Contract facts sheet): no store ids or config keys here (store S5 is the spec's name).
export const DEFAULT_SESSION_SOURCE = "Standard NSE/BSE F&O hours (default, needs verification)";
/** Where the default rate comes from: nowhere. Said plainly so no page presents it as a market figure. */
export const DEFAULT_RATE_SOURCE = "default (not sourced)";

/** Risk-free rate (annual, decimal) used only when no rate was entered in the dashboard or in config. */
export const DEFAULT_RATE = 0.065;

const window = Object.freeze({ preOpen: "09:00", open: "09:15", close: "15:30" });

/**
 * Session windows per exchange, IST "HH:MM". The cash exchanges (NSE, BSE) use the same window for the purposes the
 * Bridge needs (order hours, scan hours, paper day end); their pre-open auction details are not modelled.
 */
export const DEFAULT_SESSIONS = Object.freeze({
  NFO: window,
  BFO: window,
  NSE: window,
  BSE: window,
  source: DEFAULT_SESSION_SOURCE,
});

/** Default brokerage per executed order (rupees). Per-account plans arrive with P1-10 (`chargePlans`). */
export const DEFAULT_BROKERAGE = Object.freeze({ kind: "flat", perOrder: 20, source: "Default flat brokerage per order" });

/** The session window for an exchange code (NFO/BFO/NSE/BSE), or null for exchanges the reference does not cover. */
export function defaultSessionFor(exchange) {
  const w = DEFAULT_SESSIONS[exchange];
  return w && typeof w === "object" ? w : null;
}
