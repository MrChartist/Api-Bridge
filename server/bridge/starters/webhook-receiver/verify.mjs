// Checking that a webhook really came from your Bridge. The same rule as every signed request the Bridge sends or accepts.
//
//   header   X-MCB-Signature: t=<unix seconds>,v1=<hex>
//   signed   HMAC-SHA256(secret, "<t>." + the EXACT raw request body)
//
// Three rules that matter:
//   1. Sign the raw bytes you received, never JSON that you parsed and wrote out again (spacing and key order change).
//   2. Compare in constant time (timingSafeEqual), never with ===.
//   3. Reject a timestamp that is too old or too new (replay window), and remember what you saw, so a copy of a
//      real request cannot be sent again. See `seenBefore` in receiver.mjs.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-mcb-signature";
export const TOLERANCE_SECONDS = 300;

/** The hex signature for a body (used by send-test.mjs and by your own tests). */
export const sign = (secret, timestamp, rawBody) => createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");

/**
 * @param {{ secret: string | string[], header: string | undefined, rawBody: Buffer | string, now?: number, toleranceSeconds?: number }} o
 *   secret: an array while you rotate secrets (either one may match).
 * @returns {{ ok: true, timestamp: number } | { ok: false, reason: "missing_header" | "malformed_header" | "timestamp_out_of_range" | "signature_mismatch" }}
 */
export function verifySignature({ secret, header, rawBody, now = Date.now(), toleranceSeconds = TOLERANCE_SECONDS }) {
  if (!header) return { ok: false, reason: "missing_header" };
  const parts = String(header).split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const given = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")).map(([, v]) => v);
  if (!Number.isInteger(t) || given.length === 0) return { ok: false, reason: "malformed_header" };
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return { ok: false, reason: "timestamp_out_of_range" };
  const secrets = [secret].flat().filter(Boolean);
  const match = secrets.some((s) => {
    const expected = Buffer.from(sign(s, t, rawBody), "hex");
    return given.some((g) => timingSafeEqual(expected, Buffer.from(g, "hex")));
  });
  return match ? { ok: true, timestamp: t } : { ok: false, reason: "signature_mismatch" };
}
