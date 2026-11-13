/**
 * TradingView alert receiver.
 *
 * TradingView posts the alert's Message box to the Webhook URL: as application/json when the message is valid JSON,
 * else as text/plain (needs verification against TradingView's current webhook help page). Both are accepted:
 *
 *   JSON  { "symbol": "{{exchange}}:{{ticker}}", "side": "{{strategy.order.action}}",
 *           "quantity": "{{strategy.order.contracts}}", "price": "{{strategy.order.price}}",
 *           "id": "{{strategy.order.id}}", "time": "{{timenow}}" }
 *   text  BUY NSE:RELIANCE 10 @ 1402.5        (the grammar of common.mjs signalFromText)
 *
 * TradingView fills the {{placeholders}} before it sends; one it left unfilled refuses the alert. A strategy alert
 * carries an order id and a time, which identify it (a resend never places a second order that day); an indicator
 * alert has neither, so it is identified by its exact bytes inside hooks.dedupeWindowMs.
 *
 * TradingView cannot sign its alerts: the URL token is the credential, and a hook may also list the addresses the
 * alerts come from (TRADINGVIEW_WEBHOOK_IPS) in allowSourceIps.
 */
import { assertNoPlaceholders, invalid, signalFromObject, signalFromText } from "./common.mjs";

/**
 * The addresses TradingView says its webhooks come from. Unverified here: check TradingView's webhook help page before
 * relying on them, since a wrong list refuses every alert. Offered to the person as a suggestion, never applied alone.
 */
export const TRADINGVIEW_WEBHOOK_IPS = Object.freeze(["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"]);

/**
 * @param {unknown} body
 * @returns {import("./common.mjs").ParsedAlert}
 */
export function parseTradingView(body) {
  let signal;
  if (typeof body === "string") signal = signalFromText(body);
  else if (body && typeof body === "object" && !Array.isArray(body)) {
    assertNoPlaceholders(body);
    signal = signalFromObject(/** @type {Record<string, unknown>} */ (body));
  } else throw invalid("A TradingView alert must be a JSON object or a line of text in the alert's Message box.");
  const basis = signal.ref && signal.time ? `tv|${signal.ref}|${signal.time}` : null;
  return { signals: [signal], basis, dropped: 0 };
}
