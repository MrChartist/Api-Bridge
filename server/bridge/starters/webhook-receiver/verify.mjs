// Checking that a webhook really came from your Bridge.
//
//   X-Bridge-Timestamp  whole seconds since 1970, as sent
//   X-Bridge-Signature  v1=<hex>      (several "v1=" values may be present while a secret is being replaced)
//   signed text         "<timestamp>." + the EXACT raw request body
//   signature           HMAC-SHA256(secret, signed text), lower-case hex
//
// Three rules that matter:
//   1. Sign the raw bytes you received, never JSON that you parsed and wrote out again (spacing and key order change).
//   2. Compare in constant time (timingSafeEqual), never with ===.
//   3. Reject a timestamp that is too old or too new (replay window, 300 s), and remember event ids so a retry of the
//      same event is handled once. Use the `id` in the BODY: it is covered by the signature. The X-Bridge-Event-Id header is
//      not, so someone who captured one request could change it and make you act again. See `seenBefore` in receiver.mjs.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-bridge-signature";
export const TIMESTAMP_HEADER = "x-bridge-timestamp";
/** Not signed: for logs only. De-duplicate on the `id` in the signed body instead. */
export const EVENT_ID_HEADER = "x-bridge-event-id";
export const TOLERANCE_SECONDS = 300;

/** The hex signature for a body (used by send-test.mjs and by your own tests). */
export const sign = (secret, timestamp, rawBody) => createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");

/** The two headers a sender adds. */
export const signatureHeaders = (secret, timestamp, rawBody) => ({ "X-Bridge-Timestamp": String(timestamp), "X-Bridge-Signature": `v1=${sign(secret, timestamp, rawBody)}` });

/**
 * @param {{ secret: string | string[], timestamp: string | undefined, signature: string | undefined, rawBody: Buffer | string, now?: number, toleranceSeconds?: number }} o
 *   secret: an array while you rotate secrets (either one may match).
 * @returns {{ ok: true } | { ok: false, reason: "missing" | "timestamp" | "stale" | "mismatch" }}
 */
export function verifySignature({ secret, timestamp, signature, rawBody, now = Date.now(), toleranceSeconds = TOLERANCE_SECONDS }) {
  if (timestamp === undefined || timestamp === null || !signature) return { ok: false, reason: "missing" };
  const ts = String(timestamp).trim();
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "timestamp" };
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSeconds) return { ok: false, reason: "stale" };
  const wants = [secret].flat().filter(Boolean).map((s) => Buffer.from(sign(s, ts, rawBody), "hex"));
  for (const part of String(signature).split(/[\s,]+/)) {
    const m = /^v1=([0-9a-fA-F]{64})$/.exec(part);
    if (m && wants.some((w) => timingSafeEqual(Buffer.from(m[1], "hex"), w))) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
