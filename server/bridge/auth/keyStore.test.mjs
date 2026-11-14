import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import { IS_POSIX } from "./fsUtil.mjs";
import { API_KEY_RE, createKeyStore, generateKeyId, parseApiKey, scryptHash, SCRYPT_PARAMS, STREAM_TOKEN_RE } from "./keyStore.mjs";

let dir;
let lines;
let logger;
let clock;
const FAST = { N: 2 ** 14, r: 8, p: 1 };
const T0 = Date.parse("2026-10-18T09:15:00+05:30");
/** Not scrypt: a stand-in that makes a throttle test with hundreds of attempts fast (same length, wrong secrets never match). */
const quickHash = async (secret) => createHash("sha256").update(String(secret)).digest();
const mk = (opts = {}) => createKeyStore({ logger, clock, paths: { dataDir: dir } }, { scryptParams: FAST, ...opts });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcb-keys-"));
  lines = [];
  logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  let t = T0;
  clock = { now: () => t, set: (v) => (t = v), advance: (ms) => (t += ms) };
});

describe("key format helpers", () => {
  it("generates 10-char lowercase base32 ids", () => {
    const ids = new Set(Array.from({ length: 200 }, generateKeyId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{10}$/);
  });

  it("parses mcb_<keyId>_<secret> and nothing else", () => {
    const secret = "A".repeat(42) + "_";
    expect(parseApiKey(`mcb_abcdefgh23_${secret}`)).toEqual({ keyId: "abcdefgh23", secret });
    expect(parseApiKey(`mcb_ABCDEFGH23_${secret}`)).toBeNull();
    expect(parseApiKey(`mcb_abcdefgh2_${secret}`)).toBeNull();
    expect(parseApiKey(`mcb_abcdefgh23_${secret}x`)).toBeNull();
    expect(parseApiKey(42)).toBeNull();
  });
});

describe("KeyStore", () => {
  it("implements every contract method", () => {
    expect(() => assertService("keyStore", mk())).not.toThrow();
  });

  it("creates a key shown once and stores only a scrypt hash (production parameters)", async () => {
    const ks = createKeyStore({ logger, clock, paths: { dataDir: dir } });
    const { key, record } = await ks.create({ label: "Dashboard", scopes: ["read"] });
    expect(key).toMatch(API_KEY_RE);
    expect(record).toEqual({
      id: key.slice(4, 14),
      label: "Dashboard",
      scopes: ["read"],
      accounts: "*",
      allowQuery: false,
      clientKind: "other",
      createdAt: new Date(T0).toISOString(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    const raw = readFileSync(join(dir, "keys.json"), "utf8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(parseApiKey(key).secret);
    const stored = JSON.parse(raw).keys[0];
    expect(stored.kdf).toEqual(SCRYPT_PARAMS);
    const expected = await scryptHash(parseApiKey(key).secret, Buffer.from(stored.salt, "base64"), SCRYPT_PARAMS);
    expect(stored.hash).toBe(expected.toString("base64"));
    if (IS_POSIX) expect(statSync(join(dir, "keys.json")).mode & 0o777).toBe(0o600);
    expect(await ks.authenticate(key)).toMatchObject({ id: record.id, scopes: ["read"] });
  });

  it("validates create input", async () => {
    const ks = mk();
    await expect(ks.create({ scopes: ["read"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["root"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["read"], accounts: ["Bad Id"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["read"], extra: 1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["read"], expiresAt: "tomorrow" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["read"], expiresAt: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["read"], clientKind: "robot" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const { record } = await ks.create({ label: "  trimmed  ", scopes: ["paper", "read", "paper"], accounts: ["dhan-main"], clientKind: "script" });
    expect(record).toMatchObject({ label: "trimmed", scopes: ["read", "paper"], accounts: ["dhan-main"], clientKind: "script" });
  });

  it("allows allowQuery only for keys whose only scope is read", async () => {
    const ks = mk();
    const { record } = await ks.create({ label: "Excel", scopes: ["read"], allowQuery: true, clientKind: "excel" });
    expect(record.allowQuery).toBe(true);
    await expect(ks.create({ label: "x", scopes: ["paper"], allowQuery: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(ks.create({ label: "x", scopes: ["read", "admin"], allowQuery: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("creates live and admin keys only from this computer", async () => {
    const ks = mk();
    await expect(ks.create({ label: "x", scopes: ["live"] }, { loopback: false })).rejects.toMatchObject({ code: "LOOPBACK_ONLY" });
    await expect(ks.create({ label: "x", scopes: ["admin"] }, { loopback: false })).rejects.toMatchObject({ code: "LOOPBACK_ONLY" });
    await expect(ks.create({ label: "x", scopes: ["paper"] }, { loopback: false })).resolves.toBeTruthy();
    await expect(ks.create({ label: "x", scopes: ["live"] }, { loopback: true })).resolves.toBeTruthy();
    await expect(ks.create({ label: "cli", scopes: ["admin"] })).resolves.toBeTruthy();
  });

  it("rejects wrong, malformed, unknown and look-alike keys", async () => {
    const ks = mk();
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    const { secret, keyId } = parseApiKey(key);
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    for (const bad of [`mcb_${keyId}_${flipped}`, `mcb_${generateKeyId()}_${secret}`, key.toUpperCase(), `${key} `, "mcb_", "", "x".repeat(600), null, undefined, 42]) {
      expect(await ks.authenticate(bad)).toBeNull();
    }
  });

  it("hashes a wrong secret for a known keyId like a right one, but never hashes malformed keys or unknown keyIds", async () => {
    const calls = [];
    const hasher = async (secret, salt, params) => {
      calls.push({ len: String(secret).length, saltLen: salt.length, N: params.N, r: params.r, p: params.p });
      return scryptHash(secret, salt, params);
    };
    const ks = createKeyStore({ logger, clock, paths: { dataDir: dir } }, { hasher });
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    const { keyId, secret } = parseApiKey(key);
    calls.length = 0;
    // Malformed and unknown keyIds are public facts: refused with no scrypt (a flood of them costs nothing).
    for (const c of [`mcb_${generateKeyId()}_${secret}`, `mcb_${keyId}`, "not-a-key", "Bearer junk"]) expect(await ks.authenticate(c)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await ks.authenticate(`mcb_${keyId}_${"B".repeat(43)}`)).toBeNull();
    expect(await ks.authenticate(key)).not.toBeNull();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatchObject({ N: SCRYPT_PARAMS.N, r: 8, p: 1, saltLen: 16, len: 43 });
  });

  it("bounds concurrent scrypt work: at most 2 at a time, then a short queue, then RATE_LIMITED", async () => {
    let active = 0;
    let peak = 0;
    const gates = [];
    const hasher = async (secret, salt, params) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => gates.push(r));
      active -= 1;
      return scryptHash(secret, salt, params);
    };
    const real = mk();
    const { key } = await real.create({ label: "a", scopes: ["read"] });
    const ks = mk({ hasher });
    const { keyId } = parseApiKey(key);
    const wrong = (i) => `mcb_${keyId}_${String(i).padStart(43, "C")}`;
    let settled = 0;
    const pending = [];
    for (let i = 0; i < 34; i += 1) pending.push(ks.authenticate(wrong(i)).then((v) => v, (e) => e).finally(() => (settled += 1)));
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(2);
    const over = await ks.authenticate(wrong(99)).catch((e) => e);
    expect(over).toMatchObject({ code: "RATE_LIMITED" });
    while (settled < pending.length) {
      gates.splice(0).forEach((g) => g());
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(pending);
    expect(peak).toBe(2);
  }, 20_000);

  it("refuses an address after too many failed attempts at one key id in a minute, before any hashing", async () => {
    let n = 0;
    const ks = mk({ hasher: (s, salt, p) => (n++, scryptHash(s, salt, p)) });
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    const { keyId } = parseApiKey(key);
    n = 0;
    for (let i = 0; i < 30; i += 1) expect(await ks.authenticate(`mcb_${keyId}_${String(i).padStart(43, "B")}`, { ip: "192.0.2.9" })).toBeNull();
    expect(n).toBe(30);
    await expect(ks.authenticate(key, { ip: "192.0.2.9" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(n).toBe(30); // refused without hashing
    // Another address is not affected.
    expect(await ks.authenticate(key, { ip: "192.0.2.10" })).not.toBeNull();
    // and the block ends with the minute
    clock.advance(60_001);
    expect(await ks.authenticate(key, { ip: "192.0.2.9" })).not.toBeNull();
  });

  it("one stale key on a shared address does not lock out the other keys (audit S8)", async () => {
    const ks = mk();
    const a = await ks.create({ label: "dashboard", scopes: ["read"] });
    const b = await ks.create({ label: "cli", scopes: ["read"] });
    const stale = `mcb_${generateKeyId()}_${"S".repeat(43)}`;
    for (let i = 0; i < 70; i += 1) expect(await ks.authenticate(i % 2 ? stale : "junk", { ip: "127.0.0.1" }).catch((e) => e)).toSatisfy((r) => r === null || r?.code === "RATE_LIMITED");
    // the stale key and the junk are refused by now ...
    await expect(ks.authenticate(stale, { ip: "127.0.0.1" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // ... but every real key on the same address still works, even one never used before
    expect(await ks.authenticate(a.key, { ip: "127.0.0.1" })).not.toBeNull();
    expect(await ks.authenticate(b.key, { ip: "127.0.0.1" })).not.toBeNull();
  });

  it("does not lock out a key that authenticated a moment ago, however many wrong secrets are tried for it", async () => {
    const ks = mk({ hasher: quickHash });
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    const { keyId } = parseApiKey(key);
    expect(await ks.authenticate(key, { ip: "127.0.0.1" })).not.toBeNull();
    for (let i = 0; i < 40; i += 1) expect(await ks.authenticate(`mcb_${keyId}_${String(i).padStart(43, "D")}`, { ip: "127.0.0.1" })).toBeNull();
    clock.advance(61_000); // the verification cache has expired: the key is checked again
    expect(await ks.authenticate(key, { ip: "127.0.0.1" })).not.toBeNull();
    // but not for ever: ten times the failures lock even a key that worked
    for (let i = 0; i < 300; i += 1) await ks.authenticate(`mcb_${keyId}_${String(i).padStart(43, "E")}`, { ip: "127.0.0.1" }).catch(() => null);
    await expect(ks.authenticate(`mcb_${keyId}_${"F".repeat(43)}`, { ip: "127.0.0.1" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("caps the scrypt work one address can cause across key ids", async () => {
    let n = 0;
    const ks = mk({ hasher: async (s) => (n++, quickHash(s)) });
    const keys = [];
    for (let i = 0; i < 12; i += 1) keys.push(await ks.create({ label: `k${i}`, scopes: ["read"] }));
    n = 0;
    let tried = 0;
    // 29 wrong secrets for each of 12 real key ids stays under the per-key limit, but not under the per-address one
    for (let round = 0; round < 29; round += 1) {
      for (const k of keys) {
        const r = await ks.authenticate(`mcb_${parseApiKey(k.key).keyId}_${String(round).padStart(43, "G")}`, { ip: "192.0.2.50" }).catch((e) => e);
        if (r === null) tried += 1;
      }
    }
    expect(n).toBe(300);
    expect(tried).toBe(300);
  }, 30_000);

  it("caches a verified key for 60 seconds, then verifies again", async () => {
    let n = 0;
    const hasher = (s, salt, p) => {
      n++;
      return scryptHash(s, salt, p);
    };
    const ks = mk({ hasher });
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    n = 0;
    await ks.authenticate(key);
    await ks.authenticate(key);
    await ks.authenticate(key);
    expect(n).toBe(1);
    clock.advance(60_001);
    await ks.authenticate(key);
    expect(n).toBe(2);
    // Failures are never cached.
    const bad = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    await ks.authenticate(bad);
    await ks.authenticate(bad);
    expect(n).toBe(4);
  });

  it("revocation takes effect on the very next request, even when cached", async () => {
    const ks = mk();
    const { key, record } = await ks.create({ label: "a", scopes: ["paper"] });
    expect(await ks.authenticate(key)).not.toBeNull();
    const revoked = await ks.revoke(record.id);
    expect(revoked.revokedAt).toBe(new Date(T0).toISOString());
    expect(await ks.authenticate(key)).toBeNull();
    // Idempotent; unknown ids are NOT_FOUND.
    expect((await ks.revoke(record.id)).revokedAt).toBe(revoked.revokedAt);
    await expect(ks.revoke("zzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ks.revoke("../../x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await ks.get(record.id)).revokedAt).toBeTruthy();
  });

  it("revocation by another process (the CLI) is seen on the next request", async () => {
    const server = mk();
    const cli = mk();
    const { key, record } = await cli.create({ label: "a", scopes: ["read"] });
    expect(await server.authenticate(key)).not.toBeNull(); // now cached in the server
    await cli.revoke(record.id);
    expect(await server.authenticate(key)).toBeNull();
    expect((await server.list())[0].revokedAt).toBeTruthy();
  });

  it("expired keys fail", async () => {
    const ks = mk();
    const { key } = await ks.create({ label: "a", scopes: ["read"], expiresAt: new Date(T0 + 120_000).toISOString() });
    expect(await ks.authenticate(key)).not.toBeNull();
    clock.advance(119_000);
    expect(await ks.authenticate(key)).not.toBeNull();
    clock.advance(1_000);
    expect(await ks.authenticate(key)).toBeNull();
  });

  it("writes lastUsedAt at most once a minute", async () => {
    const ks = mk();
    const { key, record } = await ks.create({ label: "a", scopes: ["read"] });
    const stamp = () => JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")).keys[0].lastUsedAt;
    await ks.authenticate(key);
    await ks.list(); // let the queued write run
    await new Promise((r) => setImmediate(r));
    expect(stamp()).toBe(new Date(T0).toISOString());
    clock.advance(30_000);
    await ks.authenticate(key);
    await new Promise((r) => setImmediate(r));
    expect(stamp()).toBe(new Date(T0).toISOString());
    clock.advance(31_000);
    await ks.authenticate(key);
    await new Promise((r) => setImmediate(r));
    expect(stamp()).toBe(new Date(T0 + 61_000).toISOString());
    expect((await ks.get(record.id)).lastUsedAt).toBe(new Date(T0 + 61_000).toISOString());
  });

  it("lists keys without secrets and gets by id", async () => {
    const ks = mk();
    const a = await ks.create({ label: "a", scopes: ["read"] });
    clock.advance(1000);
    const b = await ks.create({ label: "b", scopes: ["admin"] });
    const list = await ks.list();
    expect(list.map((r) => r.id)).toEqual([a.record.id, b.record.id]);
    for (const r of list) {
      expect(r).not.toHaveProperty("hash");
      expect(r).not.toHaveProperty("salt");
      expect(r).not.toHaveProperty("kdf");
    }
    expect(await ks.get(a.record.id)).toEqual(a.record);
    expect(await ks.get("zzzzzzzzzz")).toBeNull();
    expect(await ks.get("BAD")).toBeNull();
  });

  it("fails closed on a corrupt keys.json and recovers when it is fixed", async () => {
    const ks = mk();
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    const good = readFileSync(join(dir, "keys.json"), "utf8");
    expect(await ks.authenticate(key)).not.toBeNull();
    writeFileSync(join(dir, "keys.json"), "{ not json");
    expect(await ks.authenticate(key)).toBeNull();
    await expect(ks.list()).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(ks.create({ label: "b", scopes: ["read"] })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(lines.some((l) => l.includes("keys file is not valid"))).toBe(true);
    writeFileSync(join(dir, "keys.json"), good);
    expect(await ks.authenticate(key)).not.toBeNull();
  });

  it("normalises hand-edited records that break the allowQuery rule", async () => {
    const ks = mk();
    const { key, record } = await ks.create({ label: "a", scopes: ["paper"] });
    const doc = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"));
    doc.keys[0].allowQuery = true;
    writeFileSync(join(dir, "keys.json"), JSON.stringify(doc));
    expect((await ks.authenticate(key)).allowQuery).toBe(false);
    expect((await ks.get(record.id)).allowQuery).toBe(false);
  });

  it("never logs a key", async () => {
    const ks = mk();
    const { key, record } = await ks.create({ label: "a", scopes: ["read"] });
    await ks.authenticate(key);
    await ks.revoke(record.id);
    const all = lines.join("\n");
    expect(all).not.toContain(parseApiKey(key).secret);
    expect(all).toContain(record.id);
  });
});

describe("stream tokens", () => {
  it("are single use, bound to the key, and valid for 60 seconds", async () => {
    const ks = mk();
    const { key, record } = await ks.create({ label: "a", scopes: ["read"] });
    const rec = await ks.authenticate(key);
    const t1 = await ks.issueStreamToken(rec);
    expect(t1.token).toMatch(STREAM_TOKEN_RE);
    expect(t1.expiresAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(await ks.verifyStreamToken(t1.token)).toMatchObject({ id: record.id });
    expect(await ks.verifyStreamToken(t1.token)).toBeNull();

    const t2 = await ks.issueStreamToken(rec);
    clock.advance(60_000);
    expect(await ks.verifyStreamToken(t2.token)).toBeNull();

    const t3 = await ks.issueStreamToken(rec, { ttlMs: 10 * 60_000 });
    expect(t3.expiresAt).toBe(new Date(clock.now() + 60_000).toISOString());
    const t4 = await ks.issueStreamToken(rec, { ttlMs: 5_000 });
    clock.advance(5_001);
    expect(await ks.verifyStreamToken(t4.token)).toBeNull();
    expect(await ks.verifyStreamToken(t3.token)).not.toBeNull();
  });

  it("die with their key and cannot be issued for a revoked or unknown key", async () => {
    const ks = mk();
    const { key, record } = await ks.create({ label: "a", scopes: ["read"] });
    const rec = await ks.authenticate(key);
    const t = await ks.issueStreamToken(rec);
    await ks.revoke(record.id);
    expect(await ks.verifyStreamToken(t.token)).toBeNull();
    await expect(ks.issueStreamToken(rec)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ks.issueStreamToken({ id: "zzzzzzzzzz" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ks.issueStreamToken(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("reject junk and keep at most 32 outstanding per key", async () => {
    const ks = mk();
    const { key } = await ks.create({ label: "a", scopes: ["read"] });
    const rec = await ks.authenticate(key);
    expect(await ks.verifyStreamToken("mcb_st_short")).toBeNull();
    expect(await ks.verifyStreamToken(key)).toBeNull();
    expect(await ks.verifyStreamToken(undefined)).toBeNull();
    const tokens = [];
    for (let i = 0; i < 40; i++) tokens.push((await ks.issueStreamToken(rec)).token);
    expect(await ks.verifyStreamToken(tokens[0])).toBeNull();
    expect(await ks.verifyStreamToken(tokens[39])).not.toBeNull();
    expect(await ks.verifyStreamToken(tokens[8])).not.toBeNull();
  });
});

describe("KeyStore: a creator cannot grant more than it holds", () => {
  it("an admin-only creator cannot mint a live key; an admin+live creator and the CLI can", async () => {
    const ks = mk();
    await expect(ks.create({ label: "x", scopes: ["live"], accounts: "*" }, { creatorScopes: ["admin", "read"] })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(ks.create({ label: "x", scopes: ["live"] }, { creatorScopes: ["admin", "read", "live", "paper"] })).resolves.toBeTruthy();
    await expect(ks.create({ label: "x", scopes: ["live"] })).resolves.toBeTruthy();
    await expect(ks.create({ label: "x", scopes: ["paper"] }, { creatorScopes: ["admin", "read"] })).resolves.toBeTruthy();
  });

  it("refuses an AI-assistant key with the admin scope", async () => {
    const ks = mk();
    await expect(ks.create({ label: "ai", scopes: ["admin"], clientKind: "mcp" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("KeyStore: no per-run key purpose in v2", () => {
  it("a key has no purpose, and the request body cannot ask for one", async () => {
    const ks = mk();
    const plain = await ks.create({ label: "plain", scopes: ["paper"] });
    expect(plain.record).not.toHaveProperty("purpose");
    await expect(ks.create({ label: "x", scopes: ["paper"], purpose: "strategy-run" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
