/**
 * Webhook signatures. The Bridge signs the exact bytes it sends:
 *
 *   signed text   = <timestamp> + "." + <raw request body>          (timestamp: whole seconds since 1970, as sent)
 *   signature     = HMAC-SHA256(secret, signed text), lower-case hex
 *   header        = X-Bridge-Signature: v1=<signature>
 *
 * A receiver recomputes it from the raw body (before any JSON parsing), compares in constant time and refuses a
 * timestamp that is more than `toleranceSec` (default 300) away from its own clock, so a captured request cannot be sent
 * again later. docs/guides/events.md has the receiver code for Node, Python and the shell; the tests run that code
 * against these functions.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_VERSION = "v1";
export const HEADERS = Object.freeze({
  signature: "X-Bridge-Signature",
  timestamp: "X-Bridge-Timestamp",
  eventId: "X-Bridge-Event-Id",
  topic: "X-Bridge-Event-Topic",
  delivery: "X-Bridge-Delivery",
  attempt: "X-Bridge-Attempt",
});

/** The signature value (without the `v1=` prefix). @param {string} secret @param {number|string} timestamp @param {string|Buffer} body */
export function computeSignature(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

/** The headers that carry the signature. @returns {Record<string, string>} */
export function signatureHeaders(secret, timestamp, body) {
  return { [HEADERS.timestamp]: String(timestamp), [HEADERS.signature]: `${SIGNATURE_VERSION}=${computeSignature(secret, timestamp, body)}` };
}

/**
 * Check a received request. The reference for what the docs snippets do.
 * @param {{ secret: string, timestamp: string|number|undefined, signature: string|undefined, body: string|Buffer, toleranceSec?: number, nowMs?: number }} input
 * @returns {{ ok: true } | { ok: false, reason: "missing"|"timestamp"|"stale"|"mismatch" }}
 */
export function verifySignature({ secret, timestamp, signature, body, toleranceSec = 300, nowMs = Date.now() }) {
  if (timestamp === undefined || timestamp === null || !signature) return { ok: false, reason: "missing" };
  const ts = String(timestamp).trim();
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "timestamp" };
  if (Math.abs(nowMs / 1000 - Number(ts)) > toleranceSec) return { ok: false, reason: "stale" };
  const want = Buffer.from(computeSignature(secret, ts, body), "hex");
  // A header may carry several signatures ("v1=aaa v1=bbb") while a secret is being replaced.
  for (const part of String(signature).split(/[\s,]+/)) {
    const m = /^v1=([0-9a-fA-F]{64})$/.exec(part);
    if (m && timingSafeEqual(Buffer.from(m[1], "hex"), want)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
