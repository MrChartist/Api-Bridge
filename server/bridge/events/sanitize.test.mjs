import { describe, expect, it } from "vitest";
import { isForbiddenField, sanitizePayload } from "./sanitize.mjs";

describe("sanitizePayload", () => {
  it("drops fields that look like secrets, tokens or approvals, at any depth", () => {
    const out = sanitizePayload({
      ticketId: "tkt_1",
      accountId: "dhan-main",
      confirmToken: "mct_abcdefghijklmnop",
      confirmExpiresAt: "2026-11-09T10:00:00Z",
      token: "x",
      nested: { apiKey: "k", secret: "s", password: "p", ok: 1, deeper: [{ authorization: "Bearer abcdefghijklmn", fine: true }] },
      session: "expired",
      signature: "abc",
      approvalCode: 1,
    });
    expect(out).toEqual({ ticketId: "tkt_1", accountId: "dhan-main", nested: { ok: 1, deeper: [{ fine: true }] }, session: "expired" });
  });

  it("keeps ticket.confirmed style fields and the account status session field", () => {
    expect(sanitizePayload({ ticketId: "t", accountId: "a", principal: "key:abc" })).toEqual({ ticketId: "t", accountId: "a", principal: "key:abc" });
    expect(sanitizePayload({ accountId: "a", broker: "dhan", session: "connected", message: "ok" }).session).toBe("connected");
    expect(isForbiddenField("confirmedAt")).toBe(false);
    for (const n of ["confirmToken", "confirmation", "approve", "secret", "token", "pin", "key", "Authorization", "x-api-key"]) expect(isForbiddenField(n), n).toBe(true);
  });

  it("masks key-like values inside strings", () => {
    const out = sanitizePayload({ message: "login with mcb_abcdefghij_0123456789abcdef and mct_0123456789abcdef then Bearer abcdefghijklmnopqrstuv", jwt: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdEFGH12" });
    expect(JSON.stringify(out)).not.toMatch(/mcb_abc|mct_012|abcdefghijklmnopqrstuv|eyJhbG/);
    expect(out.message).toContain("[removed]");
  });

  it("caps depth, array length, string length and total size", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(JSON.stringify(sanitizePayload(deep))).not.toContain('"g"');
    expect(sanitizePayload({ list: Array.from({ length: 200 }, (_, i) => i) }).list).toHaveLength(50);
    expect(sanitizePayload({ s: "x".repeat(2000) }).s.length).toBeLessThan(600);
    const big = sanitizePayload({ items: Array.from({ length: 50 }, () => "y".repeat(450)) }, { maxBytes: 4096 });
    expect(big).toMatchObject({ truncated: true });
    expect(JSON.stringify(big).length).toBeLessThan(400);
  });

  it("copes with circular, odd and non-object payloads", () => {
    const a = { name: "x" };
    a.self = a;
    expect(sanitizePayload(a)).toEqual({ name: "x" });
    expect(sanitizePayload(null)).toEqual({});
    expect(sanitizePayload(undefined)).toEqual({});
    expect(sanitizePayload("hello")).toEqual({ value: "hello" });
    expect(sanitizePayload({ f: () => 1, n: 10n, e: new Error("boom") })).toEqual({ n: "10", e: { message: "boom" } });
  });
});
