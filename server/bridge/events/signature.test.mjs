import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HEADERS, computeSignature, signatureHeaders, verifySignature } from "./signature.mjs";

const SECRET = "a-long-enough-test-secret-0123456789";
const BODY = '{"id":"42","topic":"order.updated","data":{"orderId":"o1"}}';

describe("webhook signature", () => {
  it("is HMAC-SHA256 over '<timestamp>.<raw body>' in lower-case hex, sent as v1=<hex>", () => {
    const want = createHmac("sha256", SECRET).update(`1700000000.${BODY}`).digest("hex");
    expect(computeSignature(SECRET, 1700000000, BODY)).toBe(want);
    expect(computeSignature(SECRET, "1700000000", Buffer.from(BODY))).toBe(want);
    expect(signatureHeaders(SECRET, 1700000000, BODY)).toEqual({ [HEADERS.timestamp]: "1700000000", [HEADERS.signature]: `v1=${want}` });
    expect(want).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a good request and refuses each kind of bad one", () => {
    const nowMs = 1_700_000_100_000;
    const h = signatureHeaders(SECRET, 1_700_000_000, BODY);
    const ok = { secret: SECRET, timestamp: h[HEADERS.timestamp], signature: h[HEADERS.signature], body: BODY, nowMs };
    expect(verifySignature(ok)).toEqual({ ok: true });
    expect(verifySignature({ ...ok, body: `${BODY} ` })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ ...ok, secret: "another-secret-another-secret" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ ...ok, timestamp: "1700000001" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ ...ok, signature: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ ...ok, timestamp: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ ...ok, timestamp: "17e8" })).toEqual({ ok: false, reason: "timestamp" });
    expect(verifySignature({ ...ok, signature: "v1=zz" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ ...ok, signature: h[HEADERS.signature].slice(3) })).toEqual({ ok: false, reason: "mismatch" }); // no v1= prefix
  });

  it("enforces the replay window in both directions", () => {
    const h = signatureHeaders(SECRET, 1_700_000_000, BODY);
    const base = { secret: SECRET, timestamp: h[HEADERS.timestamp], signature: h[HEADERS.signature], body: BODY };
    expect(verifySignature({ ...base, nowMs: 1_700_000_000_000 + 300_000 }).ok).toBe(true);
    expect(verifySignature({ ...base, nowMs: 1_700_000_000_000 + 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature({ ...base, nowMs: 1_700_000_000_000 - 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature({ ...base, nowMs: 1_700_000_000_000 + 3_000_000, toleranceSec: 4000 }).ok).toBe(true);
  });

  it("accepts any of several signatures (while a secret is being replaced)", () => {
    const nowMs = 1_700_000_000_000;
    const good = computeSignature(SECRET, 1_700_000_000, BODY);
    const old = computeSignature("the-previous-secret-0123456789", 1_700_000_000, BODY);
    expect(verifySignature({ secret: SECRET, timestamp: "1700000000", signature: `v1=${old} v1=${good}`, body: BODY, nowMs }).ok).toBe(true);
    expect(verifySignature({ secret: SECRET, timestamp: "1700000000", signature: `v1=${old},v1=${old}`, body: BODY, nowMs }).ok).toBe(false);
  });
});
