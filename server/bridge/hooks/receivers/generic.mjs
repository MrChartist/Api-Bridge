/**
 * Generic signed receiver — stream S11. For your own scripts, Amibroker/Python bridges and anything that can sign.
 *
 * Every request must carry `X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>`
 * (server/bridge/auth/hmac.mjs). Requests outside the time window (5 minutes at most) or replayed inside it are
 * refused before the body is looked at. The route verifies the signature; this module only parses.
 *
 * Body (JSON):
 *   { "symbol": "NSE:RELIANCE", "side": "BUY", "quantity": 10, "price": 1402.5, "orderType": "LIMIT", "id": "sig-42" }
 * or several at once: { "signals": [ {...}, {...} ], "id": "batch-7" }   (at most MAX_SIGNALS_PER_ALERT)
 *
 * `id` (per signal, or on the batch) makes the signal idempotent for the IST day: sending the same id again never
 * creates a second order, even after the replay window.
 */
import { MAX_SIGNALS_PER_ALERT, assertNoPlaceholders, invalid, signalFromObject, toRef } from "./common.mjs";

/**
 * @param {unknown} body
 * @returns {import("./common.mjs").ParsedAlert}
 */
export function parseGeneric(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("A generic hook body must be a JSON object.");
  const o = /** @type {Record<string, unknown>} */ (body);
  assertNoPlaceholders(o);
  if (o.signals !== undefined) {
    if (!Array.isArray(o.signals) || o.signals.length === 0) throw invalid("signals must be a non-empty array.", "signals");
    if (o.signals.length > MAX_SIGNALS_PER_ALERT) throw invalid(`At most ${MAX_SIGNALS_PER_ALERT} signals per request.`, "signals");
    const batchId = toRef(o.id, "id");
    const signals = o.signals.map((s, i) => signalFromObject(/** @type {any} */ (s), `signals.${i}`));
    const ids = signals.map((s) => s.ref);
    const basis = batchId ? `gen|batch|${batchId}` : ids.every(Boolean) ? `gen|ids|${ids.join("|")}` : null;
    return { signals, basis, dropped: 0 };
  }
  const signal = signalFromObject(o);
  return { signals: [signal], basis: signal.ref ? `gen|${signal.ref}` : null, dropped: 0 };
}
