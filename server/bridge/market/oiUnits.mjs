/**
 * Open-interest units per broker (docs/spec/p1-01-recorder.md §10, M10). DATA ONLY.
 *
 * The Bridge reports OI in UNITS (contracts × lot size) everywhere. A broker that sends OI in lots is converted by the
 * normaliser (market/normalise.mjs oiToUnits) with the leg's lot size; when the lot size is unknown the OI becomes
 * null, never a guess.
 *
 * `verified: true` only when BOTH the broker's own documentation says units AND its recorded fixture passes the
 * multiple-of-lot check in oiUnits.contract.test.mjs. The fixtures in server/brokers/__fixtures__ are shaped from the
 * documentation samples, and their OI values are not multiples of the published lot sizes (sample numbers), so the
 * check cannot pass and the three brokers stay unverified until a real captured response is recorded. Adapters not
 * listed here record with `oiUnitVerified: false` and the recorder status warns.
 */

/** @typedef {"units"|"lots"} OiUnit */
/** @type {Readonly<Record<string, Readonly<{ chain: OiUnit, quotes: OiUnit, stream: OiUnit, verified: boolean, source: string }>>>} */
export const OI_UNITS = Object.freeze({
  demo: Object.freeze({ chain: "units", quotes: "units", stream: "units", verified: true, source: "server/bridge/demo/demoAdapter.mjs" }),
  dhan: Object.freeze({ chain: "units", quotes: "units", stream: "units", verified: false, source: "https://dhanhq.co/docs/v2/option-chain/" }),
  zerodha: Object.freeze({ chain: "units", quotes: "units", stream: "units", verified: false, source: "https://kite.trade/docs/connect/v3/market-quotes/" }),
  upstox: Object.freeze({ chain: "units", quotes: "units", stream: "units", verified: false, source: "https://upstox.com/developer/api-documentation/" }),
});

/**
 * Lot-revision transition contracts whose OI may legitimately not divide by the current lot (old-lot positions carried
 * after a revision). Keys "broker:underlying:expiry". Empty today.
 */
export const OI_LOT_EXCEPTIONS = Object.freeze([]);

/** The unit a broker sends OI in for a source ("chain" | "quotes" | "stream"); "units" when unknown. */
export function oiUnitFor(broker, source = "chain") {
  return OI_UNITS[broker]?.[source] ?? "units";
}

/** Whether the broker's OI unit has been verified (docs + fixture). */
export function oiUnitVerified(broker) {
  return OI_UNITS[broker]?.verified === true;
}
