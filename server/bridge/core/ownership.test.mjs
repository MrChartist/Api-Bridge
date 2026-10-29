import { describe, expect, it } from "vitest";
import { ownerKeyId, owns, seesAll } from "./ownership.mjs";

const keyCtx = (id, scopes = ["read"]) => ({ principal: { kind: "key", id }, key: { id }, scopes: new Set(scopes) });

describe("ownership", () => {
  it("a local person and an admin key see everything", () => {
    expect(seesAll({ principal: { kind: "local", id: "cli" }, scopes: new Set() })).toBe(true);
    expect(seesAll(keyCtx("k1", ["admin", "read"]))).toBe(true);
    expect(seesAll(keyCtx("k1"))).toBe(false);
    expect(seesAll(undefined)).toBe(false);
  });

  it("a key owns only its own records", () => {
    expect(owns(keyCtx("k1"), { keyId: "k1" })).toBe(true);
    expect(owns(keyCtx("k1"), { keyId: "k2" })).toBe(false);
    expect(owns(keyCtx("k1"), { keyId: null })).toBe(false);
    expect(owns(keyCtx("k2", ["admin"]), { keyId: "k1" })).toBe(true);
  });

  it("records made without a key belong to callers without a key", () => {
    const anon = { principal: { kind: "anonymous", id: "anonymous" }, key: null, scopes: new Set() };
    expect(owns(anon, {})).toBe(true);
    expect(owns(anon, { keyId: "k1" })).toBe(false);
    expect(ownerKeyId(anon)).toBe(null);
    expect(ownerKeyId(keyCtx("k9"))).toBe("k9");
  });
});
