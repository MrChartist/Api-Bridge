import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeSignature, createReplayCache, parseSignatureHeader, sign, verify } from "./hmac.mjs";

const SECRET = "whsec_0123456789abcdef0123456789abcdef";
const BODY = '{"action":"BUY","symbol":"NSE:RELIANCE","qty":1}';
const T = 1_760_781_234; // seconds
const NOW = T * 1000;

describe("sign / computeSignature", () => {
  it("is HMAC-SHA256 over '<t>.' + raw body, hex", () => {
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(computeSignature(SECRET, T, BODY)).toBe(expected);
    expect(sign(SECRET, T, BODY)).toBe(`t=${T},v1=${expected}`);
  });

  it("treats Buffer and string bodies identically (exact bytes)", () => {
    expect(sign(SECRET, T, Buffer.from(BODY))).toBe(sign(SECRET, T, BODY));
    expect(sign(SECRET, T, new Uint8Array(Buffer.from(BODY)))).toBe(sign(SECRET, T, BODY));
  });

  it("refuses short secrets and bad timestamps", () => {
    expect(() => sign("short", T, BODY)).toThrow(/at least 16/);
    expect(() => sign(SECRET, 1.5, BODY)).toThrow(/integer/);
    expect(() => sign(SECRET, -1, BODY)).toThrow(/integer/);
  });
});

describe("parseSignatureHeader", () => {
  it("parses t and one or more v1 values, ignoring unknown versions", () => {
    const sig = computeSignature(SECRET, T, BODY);
    expect(parseSignatureHeader(`t=${T},v1=${sig}`)).toEqual({ timestamp: T, signatures: [sig] });
    expect(parseSignatureHeader(`t=${T}, v0=abc, v1=${sig.toUpperCase()}, v1=${"0".repeat(64)}`)).toEqual({ timestamp: T, signatures: [sig, "0".repeat(64)] });
  });

  it.each([
    [undefined],
    [""],
    ["garbage"],
    [`v1=${"a".repeat(64)}`],
    [`t=${T}`],
    [`t=abc,v1=${"a".repeat(64)}`],
    [`t=${T},t=${T},v1=${"a".repeat(64)}`],
    [`t=${T},v1=xyz`],
    [`t=${T},v1=${"a".repeat(63)}`],
    [`t=${T},v1=${"a".repeat(64)},${"x".repeat(2000)}`],
  ])("rejects %s", (h) => {
    expect(parseSignatureHeader(h)).toBeNull();
  });
});

describe("verify", () => {
  const header = sign(SECRET, T, BODY);

  it("accepts a correct signature inside the window", () => {
    expect(verify(header, SECRET, BODY, { now: NOW })).toEqual({ ok: true, timestamp: T });
    expect(verify(header, SECRET, Buffer.from(BODY), { now: NOW + 299_000 })).toMatchObject({ ok: true });
    expect(verify(header, SECRET, BODY, { now: NOW - 299_000 })).toMatchObject({ ok: true });
  });

  it("rejects outside the 5-minute window (both directions)", () => {
    expect(verify(header, SECRET, BODY, { now: NOW + 301_000 })).toEqual({ ok: false, reason: "timestamp_out_of_range" });
    expect(verify(header, SECRET, BODY, { now: NOW - 301_000 })).toEqual({ ok: false, reason: "timestamp_out_of_range" });
    expect(verify(header, SECRET, BODY, { now: NOW + 61_000, toleranceS: 60 })).toEqual({ ok: false, reason: "timestamp_out_of_range" });
  });

  it("rejects a changed body, a wrong secret, or a moved timestamp", () => {
    expect(verify(header, SECRET, `${BODY} `, { now: NOW })).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(verify(header, `${SECRET}x`, BODY, { now: NOW })).toEqual({ ok: false, reason: "signature_mismatch" });
    const moved = header.replace(`t=${T}`, `t=${T + 1}`);
    expect(verify(moved, SECRET, BODY, { now: NOW })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("reports missing and malformed headers and missing secrets", () => {
    expect(verify(undefined, SECRET, BODY, { now: NOW })).toEqual({ ok: false, reason: "missing_header" });
    expect(verify("t=1", SECRET, BODY, { now: NOW })).toEqual({ ok: false, reason: "malformed_header" });
    expect(verify(header, "", BODY, { now: NOW })).toEqual({ ok: false, reason: "no_secret" });
    expect(verify(header, [], BODY, { now: NOW })).toEqual({ ok: false, reason: "no_secret" });
  });

  it("supports secret rotation on both sides", () => {
    const old = "whsec_old_old_old_old_old_old_old_old";
    expect(verify(sign(old, T, BODY), [SECRET, old], BODY, { now: NOW })).toMatchObject({ ok: true });
    const both = `t=${T},v1=${computeSignature(old, T, BODY)},v1=${computeSignature(SECRET, T, BODY)}`;
    expect(verify(both, SECRET, BODY, { now: NOW })).toMatchObject({ ok: true });
  });

  it("blocks replays with a replay cache, and only after a valid signature", () => {
    let clock = NOW;
    const seen = createReplayCache({ now: () => clock });
    expect(verify(header, SECRET, BODY, { now: clock, seen })).toMatchObject({ ok: true });
    expect(verify(header, SECRET, BODY, { now: clock, seen })).toEqual({ ok: false, reason: "replayed" });
    // Upper-case hex or an extra junk v1 does not make a replay look new.
    const sig = computeSignature(SECRET, T, BODY);
    expect(verify(`t=${T},v1=${"0".repeat(64)},v1=${sig.toUpperCase()}`, SECRET, BODY, { now: clock, seen })).toEqual({ ok: false, reason: "replayed" });
    // Invalid requests are not remembered.
    expect(verify(header, "wrong-secret-wrong-secret", BODY, { now: clock, seen })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(seen.size()).toBe(1);
    // A fresh timestamp is a fresh request.
    const t2 = T + 10;
    clock = t2 * 1000;
    expect(verify(sign(SECRET, t2, BODY), SECRET, BODY, { now: clock, seen })).toMatchObject({ ok: true });
  });
});

describe("createReplayCache", () => {
  it("forgets entries once they expire and stays bounded", () => {
    let t = 0;
    const c = createReplayCache({ max: 3, now: () => t });
    expect(c.checkAndAdd("a", 100)).toBe(true);
    expect(c.checkAndAdd("a", 100)).toBe(false);
    t = 101;
    expect(c.checkAndAdd("a", 300)).toBe(true);
    c.checkAndAdd("b", 300);
    c.checkAndAdd("c", 300);
    // Full of unexpired entries: refuse (fail closed) rather than evict a pair that could then be replayed.
    expect(c.checkAndAdd("d", 300)).toBe("full");
    expect(c.size()).toBe(3);
    expect(c.checkAndAdd("a", 300)).toBe(false);
    c.clear();
    expect(c.size()).toBe(0);
  });

  it("evicts the oldest only when asked to (onFull: evict)", () => {
    const t = 0;
    const c = createReplayCache({ max: 2, now: () => t, onFull: "evict" });
    c.checkAndAdd("a", 100);
    c.checkAndAdd("b", 100);
    expect(c.checkAndAdd("c", 100)).toBe(true);
    expect(c.checkAndAdd("a", 100)).toBe(true);
  });

  it("verify() reports replay_cache_full when the cache refuses", () => {
    const now = T * 1000;
    const seen = createReplayCache({ max: 1, now: () => now });
    expect(verify(sign(SECRET, T, BODY), SECRET, BODY, { now, seen }).ok).toBe(true);
    expect(verify(sign(SECRET, T, `${BODY} `), SECRET, `${BODY} `, { now, seen })).toEqual({ ok: false, reason: "replay_cache_full" });
  });
});
