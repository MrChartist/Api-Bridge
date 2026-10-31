/**
 * GoCharting alert receiver — stream S11.
 *
 * GoCharting posts the alert's message as plain text (needs verification against GoCharting's current webhook help
 * page; if the user writes JSON in the message it is parsed as JSON). The text uses the same grammar as other text
 * alerts (common.mjs signalFromText), for example "BUY NSE:RELIANCE 10 @ 1402.5". GoCharting has no strategy order
 * id, so alerts are identified by their exact bytes inside hooks.dedupeWindowMs, unless the message carries
 * id=… and time=… itself.
 */
import { assertNoPlaceholders, invalid, signalFromObject, signalFromText } from "./common.mjs";

/**
 * @param {unknown} body
 * @returns {import("./common.mjs").ParsedAlert}
 */
export function parseGoCharting(body) {
  let signal;
  if (typeof body === "string") signal = signalFromText(body);
  else if (body && typeof body === "object" && !Array.isArray(body)) {
    assertNoPlaceholders(body);
    signal = signalFromObject(/** @type {Record<string, unknown>} */ (body));
  } else throw invalid("A GoCharting alert must be a line of text.");
  const basis = signal.ref && signal.time ? `gc|${signal.ref}|${signal.time}` : null;
  return { signals: [signal], basis, dropped: 0 };
}
