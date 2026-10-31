import { describe, expect, it } from "vitest";
import { REDACTED, createLogger, isSecretFieldName, redact } from "./logger.mjs";

function capture(level = "debug") {
  const lines = [];
  const log = createLogger({ level, write: (l) => lines.push(JSON.parse(l)), now: () => 0 });
  return { log, lines };
}

describe("redact", () => {
  it("removes values of secret-looking fields at any depth", () => {
    const out = redact({ accountId: "dhan-main", creds: { apiKey: "abc123456", accessToken: "tok-999999", password: "hunter22", totpCode: "123456", clientId: "C1" } });
    expect(out.accountId).toBe("dhan-main");
    expect(out.creds).toEqual({ apiKey: REDACTED, accessToken: REDACTED, password: REDACTED, totpCode: REDACTED, clientId: "C1" });
  });

  it("masks Bridge keys, bearer tokens and JWTs inside strings", () => {
    const s = redact("key mcb_ABCDEFGH12_secretsecretsecret used, header Bearer abcdefghijklmnop, jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIx.c2lnbmF0dXJl");
    expect(s).not.toContain("secretsecret");
    expect(s).not.toContain("abcdefghijklmnop");
    expect(s).not.toContain("eyJzdWIiOiIx");
    expect(s).toContain("Bearer [redacted]");
  });

  it("masks exact registered secrets", () => {
    expect(redact({ msg: "broker said token xyz-SECRET-789 is bad" }, ["xyz-SECRET-789"]).msg).toBe("broker said token [redacted] is bad");
  });

  it("handles errors, cycles, buffers and depth", () => {
    const a = { name: "a" };
    a.self = a;
    const out = redact({ a, err: new Error("failed for mcb_ABCDEFGH12_zzzzzzzzzz"), buf: Buffer.from("xx") });
    expect(out.a.self).toBe("[circular]");
    expect(out.err.message).not.toContain("zzzzzzzz");
    expect(out.buf).toBe("[buffer 2 bytes]");
  });

  it("knows which field names are secret", () => {
    for (const n of ["password", "loginPin", "totp", "apiSecret", "access_token", "Authorization", "x-api-key", "sessionToken", "masterKey", "key"]) {
      expect(isSecretFieldName(n), n).toBe(true);
    }
    for (const n of ["accountId", "broker", "symbol", "keyId", "status", "sessionState"]) expect(isSecretFieldName(n), n).toBe(false);
  });
});

describe("createLogger", () => {
  it("writes one JSON object per line with level and message", () => {
    const { log, lines } = capture();
    log.info("hello", { accountId: "a1" });
    expect(lines).toEqual([{ t: "1970-01-01T00:00:00.000Z", level: "info", msg: "hello", accountId: "a1" }]);
  });

  it("respects the level threshold", () => {
    const { log, lines } = capture("warn");
    log.info("no");
    log.warn("yes");
    expect(lines.map((l) => l.msg)).toEqual(["yes"]);
  });

  it("child loggers carry bindings and share registered secrets", () => {
    const { log, lines } = capture();
    const child = log.child({ requestId: "r1", apiKey: "should-not-show" });
    log.addSecret("broker-token-123");
    child.error("failed with broker-token-123");
    expect(lines[0]).toMatchObject({ requestId: "r1", apiKey: REDACTED, msg: "failed with [redacted]" });
  });

  it("a throwing sink never throws into the caller", () => {
    const log = createLogger({ write: () => {
      throw new Error("disk full");
    } });
    expect(() => log.info("x")).not.toThrow();
  });
});
