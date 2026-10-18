/**
 * TradingView alert receiver — stream S11.
 *
 * TradingView posts the alert message as the body: `application/json` when the message is valid JSON, otherwise
 * `text/plain`. It cannot sign requests and abandons a webhook after 3 seconds, so the hook URL token is the
 * credential, the reply is a fast 202 and processing happens in the background.
 * Source: https://www.tradingview.com/support/solutions/43000529348-about-webhooks/ (needs verification per release).
 *
 * JSON (recommended; see templates.mjs):
 *   { "symbol": "{{exchange}}:{{ticker}}", "side": "{{strategy.order.action}}", "quantity": "{{strategy.order.contracts}}",
 *     "price": "{{close}}", "id": "{{strategy.order.id}}", "time": "{{timenow}}" }
 * Text: the grammar in common.mjs signalFromText, e.g. "BUY NSE:RELIANCE 10 @ 1402.5 id=L1 time=2026-10-19T04:00:00Z".
 *
 * Idempotency: when the alert carries both a strategy order id and a time ({{strategy.order.id}} + {{timenow}}), that
 * pair identifies the signal, so a TradingView double-fire (the same alert delivered twice) and a later re-delivery
 * the same day both map to ONE order. The id alone is not enough: TradingView reuses order names such as "Long".
 * Without them the alert is identified by its exact bytes inside hooks.dedupeWindowMs.
 */
import { assertNoPlaceholders, invalid, signalFromObject, signalFromText } from "./common.mjs";

/**
 * @param {unknown} body  Parsed body (object for JSON, string for text).
 * @returns {import("./common.mjs").ParsedAlert}
 */
export function parseTradingView(body) {
  let signal;
  if (typeof body === "string") signal = signalFromText(body);
  else if (body && typeof body === "object" && !Array.isArray(body)) {
    assertNoPlaceholders(body);
    signal = signalFromObject(/** @type {Record<string, unknown>} */ (body));
  } else throw invalid("A TradingView alert must be a JSON object or a line of text.");
  const basis = signal.ref && signal.time ? `tv|${signal.ref}|${signal.time}` : null;
  return { signals: [signal], basis, dropped: 0 };
}
