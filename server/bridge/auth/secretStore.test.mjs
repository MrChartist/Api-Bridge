import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import { IS_POSIX } from "./fsUtil.mjs";
import { createSecretStore, decodeMasterKey, SecretStoreError } from "./secretStore.mjs";

let dir;
let lines;
let logger;
const mk = (env = {}, extra = {}) => createSecretStore({ logger, paths: { dataDir: dir }, ...extra }, { env });
const ENV_KEY = randomBytes(32).toString("base64");
const SECRET_VALUE = "access-token-9f8e7d6c5b4a";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcb-secrets-"));
  lines = [];
  logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
});

async function expectReason(promise, reason) {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(SecretStoreError);
  expect(err.reason).toBe(reason);
  expect(err.code).toBe("INTERNAL");
  return err;
}

describe("SecretStore contract", () => {
  it("implements every contract method", () => {
    expect(() => assertService("secrets", mk())).not.toThrow();
  });

  it("round-trips JSON objects and lists names", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    expect(await s.get("account:a1")).toBeNull();
    await s.set("account:a1", { clientId: "1000", accessToken: SECRET_VALUE, nested: { refresh: "refresh-xyz-123" } });
    await s.set("account:b2", { apiKey: "k" });
    expect(await s.get("account:a1")).toEqual({ clientId: "1000", accessToken: SECRET_VALUE, nested: { refresh: "refresh-xyz-123" } });
    expect(await s.list()).toEqual(["account:a1", "account:b2"]);
    expect(await s.delete("account:b2")).toBe(true);
    expect(await s.delete("account:b2")).toBe(false);
    expect(await s.list()).toEqual(["account:a1"]);
    expect(s.status()).toEqual({ keySource: "env", path: join(dir, "secrets.enc"), entries: 1 });
  });

  it("returns copies, so callers cannot mutate the store", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    const v = { a: "1" };
    await s.set("x", v);
    v.a = "2";
    const got = await s.get("x");
    got.a = "3";
    expect(await s.get("x")).toEqual({ a: "1" });
  });

  it("validates names and values", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    await expect(s.get("../etc/passwd")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(s.set("", {})).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(s.set("ok", "string")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(s.set("ok", [1])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(s.set("ok", { big: "x".repeat(70_000) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("never writes plaintext, uses a fresh IV per write and the name as AAD", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    await s.set("account:a1", { accessToken: SECRET_VALUE });
    const first = JSON.parse(readFileSync(join(dir, "secrets.enc"), "utf8"));
    expect(JSON.stringify(first)).not.toContain(SECRET_VALUE);
    expect(first).toMatchObject({ format: "mcb-secrets", version: 1 });
    await s.set("account:a1", { accessToken: SECRET_VALUE });
    const second = JSON.parse(readFileSync(join(dir, "secrets.enc"), "utf8"));
    expect(second.entries["account:a1"].iv).not.toBe(first.entries["account:a1"].iv);
    expect(Buffer.from(second.entries["account:a1"].iv, "base64")).toHaveLength(12);
    if (IS_POSIX) expect(statSync(join(dir, "secrets.enc")).mode & 0o777).toBe(0o600);
    // No temp files left behind (atomic write).
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("registers decrypted values and the master key with the logger", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    await s.set("account:a1", { accessToken: SECRET_VALUE, short: "abc" });
    // A fresh store reading the same file registers on read as well.
    const lines2 = [];
    const logger2 = createLogger({ write: (l) => lines2.push(l) });
    const s2 = createSecretStore({ logger: logger2, paths: { dataDir: dir } }, { env: { MCB_MASTER_KEY: ENV_KEY } });
    await s2.get("account:a1");
    logger2.info(`leak ${SECRET_VALUE} and ${ENV_KEY}`, { note: `x${SECRET_VALUE}x` });
    expect(lines2.join("\n")).not.toContain(SECRET_VALUE);
    expect(lines2.join("\n")).not.toContain(ENV_KEY);
    logger.info(`leak ${SECRET_VALUE}`);
    expect(lines.join("\n")).not.toContain(SECRET_VALUE);
  });
});

describe("master key", () => {
  it("creates <dataDir>/master.key with mode 0600 on first write and reuses it", async () => {
    const s = mk();
    expect(s.status().keySource).toBe("none");
    await s.set("a", { v: "1" });
    const keyFile = join(dir, "master.key");
    expect(existsSync(keyFile)).toBe(true);
    if (IS_POSIX) expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(decodeMasterKey(readFileSync(keyFile, "utf8"))).toHaveLength(32);
    expect(s.status().keySource).toBe("file");
    expect(await mk().get("a")).toEqual({ v: "1" });
  });

  it("does not create a key file just to read an empty store", async () => {
    const s = mk();
    expect(await s.list()).toEqual([]);
    expect(existsSync(join(dir, "master.key"))).toBe(false);
  });

  it("honours MCB_MASTER_KEY_FILE", async () => {
    const keyFile = join(dir, "custom.key");
    const s = mk({ MCB_MASTER_KEY_FILE: keyFile });
    await s.set("a", { v: "1" });
    expect(existsSync(keyFile)).toBe(true);
    expect(existsSync(join(dir, "master.key"))).toBe(false);
  });

  it.skipIf(!IS_POSIX)("refuses a key file other users can read", async () => {
    const keyFile = join(dir, "master.key");
    writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o644 });
    chmodSync(keyFile, 0o644);
    const err = await expectReason(mk().set("a", { v: "1" }), "unsafe_key_file");
    expect(err.message).toMatch(/chmod 600/);
  });

  it("rejects a bad MCB_MASTER_KEY and a bad key file", async () => {
    await expectReason(mk({ MCB_MASTER_KEY: Buffer.alloc(16).toString("base64") }).set("a", { v: "1" }), "bad_env_key");
    const keyFile = join(dir, "master.key");
    writeFileSync(keyFile, "not base64!!", { mode: 0o600 });
    await expectReason(mk().set("a", { v: "1" }), "bad_key_file");
  });

  it("decodeMasterKey accepts standard and URL-safe base64 of exactly 32 bytes", () => {
    const k = randomBytes(32);
    expect(decodeMasterKey(k.toString("base64"))?.equals(k)).toBe(true);
    expect(decodeMasterKey(k.toString("base64url"))?.equals(k)).toBe(true);
    expect(decodeMasterKey(`  ${k.toString("base64")}\n`)?.equals(k)).toBe(true);
    expect(decodeMasterKey(randomBytes(31).toString("base64"))).toBeNull();
    expect(decodeMasterKey("")).toBeNull();
  });

  it("detects a wrong master key and a missing one", async () => {
    await mk({ MCB_MASTER_KEY: ENV_KEY }).set("a", { v: "1" });
    await expectReason(mk({ MCB_MASTER_KEY: randomBytes(32).toString("base64") }).get("a"), "wrong_key");
    await expectReason(mk().get("a"), "no_key");
  });
});

describe("tamper detection (never partial data)", () => {
  const file = () => join(dir, "secrets.enc");
  const edit = (fn) => {
    const doc = JSON.parse(readFileSync(file(), "utf8"));
    fn(doc);
    writeFileSync(file(), JSON.stringify(doc));
  };
  beforeEach(async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    await s.set("account:a1", { accessToken: SECRET_VALUE });
    await s.set("account:b2", { accessToken: "other-token-123456" });
  });

  it("flipped ciphertext byte", async () => {
    edit((d) => {
      const b = Buffer.from(d.entries["account:a1"].data, "base64");
      b[0] ^= 1;
      d.entries["account:a1"].data = b.toString("base64");
    });
    await expectReason(mk({ MCB_MASTER_KEY: ENV_KEY }).get("account:b2"), "tampered");
  });

  it("entry removed", async () => {
    edit((d) => delete d.entries["account:b2"]);
    await expectReason(mk({ MCB_MASTER_KEY: ENV_KEY }).list(), "tampered");
  });

  it("ciphertexts swapped between names (AAD + MAC)", async () => {
    edit((d) => {
      const a = d.entries["account:a1"];
      d.entries["account:a1"] = d.entries["account:b2"];
      d.entries["account:b2"] = a;
    });
    await expectReason(mk({ MCB_MASTER_KEY: ENV_KEY }).get("account:a1"), "tampered");
  });

  it("MAC removed or file truncated", async () => {
    const good = readFileSync(file(), "utf8");
    edit((d) => {
      d.mac = Buffer.alloc(32).toString("base64");
    });
    await expectReason(mk({ MCB_MASTER_KEY: ENV_KEY }).get("account:a1"), "tampered");
    writeFileSync(file(), good.slice(0, good.length / 2));
    await expectReason(mk({ MCB_MASTER_KEY: ENV_KEY }).get("account:a1"), "corrupt");
    writeFileSync(file(), JSON.stringify({ format: "other" }));
    await expectReason(mk({ MCB_MASTER_KEY: ENV_KEY }).get("account:a1"), "corrupt");
  });

  it("a running store refuses a file tampered after it was loaded, and does not write over it", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    expect(await s.get("account:a1")).toEqual({ accessToken: SECRET_VALUE });
    edit((d) => delete d.entries["account:b2"]);
    const tampered = readFileSync(file(), "utf8");
    await expectReason(s.get("account:a1"), "tampered");
    await expectReason(s.set("account:c3", { v: "1" }), "tampered");
    expect(readFileSync(file(), "utf8")).toBe(tampered);
  });
});

describe("multi-process behaviour", () => {
  it("picks up changes another process (the CLI) wrote", async () => {
    const server = mk({ MCB_MASTER_KEY: ENV_KEY });
    const cli = mk({ MCB_MASTER_KEY: ENV_KEY });
    expect(await server.list()).toEqual([]);
    await cli.set("account:a1", { accessToken: SECRET_VALUE });
    expect(await server.get("account:a1")).toEqual({ accessToken: SECRET_VALUE });
    await cli.delete("account:a1");
    expect(await server.get("account:a1")).toBeNull();
  });

  it("serialises concurrent writes in one process", async () => {
    const s = mk({ MCB_MASTER_KEY: ENV_KEY });
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.set(`k${i}`, { v: String(i) })));
    expect((await s.list()).length).toBe(20);
    const fresh = mk({ MCB_MASTER_KEY: ENV_KEY });
    expect(await fresh.get("k7")).toEqual({ v: "7" });
  });

  it("status() never throws, even on a broken file", () => {
    writeFileSync(join(dir, "secrets.enc"), "{broken");
    expect(mk().status()).toMatchObject({ entries: 0, keySource: "none" });
  });
});
