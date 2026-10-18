import { describe, expect, it } from "vitest";
import { assertService } from "../core/contracts.mjs";
import { createLogger } from "../core/logger.mjs";
import { createFakeKeyStore, createFakeSecretStore } from "./fake.mjs";

describe("fake SecretStore", () => {
  it("satisfies the contract and records calls", async () => {
    const lines = [];
    const logger = createLogger({ write: (l) => lines.push(l) });
    const s = createFakeSecretStore({ initial: { "account:a1": { clientId: "1" } }, logger });
    assertService("secrets", s);
    expect(await s.get("account:a1")).toEqual({ clientId: "1" });
    await s.set("account:b2", { accessToken: "tok-123456" });
    expect(await s.list()).toEqual(["account:a1", "account:b2"]);
    expect(s.calls.filter((c) => c.method === "set")).toEqual([{ method: "set", name: "account:b2", value: { accessToken: "tok-123456" } }]);
    expect(await s.delete("account:b2")).toBe(true);
    expect(s.status().entries).toBe(1);
    expect(s.dump()).toEqual({ "account:a1": { clientId: "1" } });
    logger.info("tok-123456");
    expect(lines.join("")).not.toContain("tok-123456");
    await expect(s.set("x", "nope")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("fake KeyStore", () => {
  it("satisfies the contract and behaves like the real one", async () => {
    let t = 1_000_000;
    const ks = createFakeKeyStore({ clock: { now: () => t } });
    assertService("keyStore", ks);
    const { key, record } = ks.addKey({ scopes: ["read"], accounts: ["a1"], allowQuery: true });
    expect(record.allowQuery).toBe(true);
    expect(await ks.authenticate(key)).toMatchObject({ id: record.id, accounts: ["a1"] });
    expect(await ks.authenticate(key + "x")).toBeNull();
    const tok = await ks.issueStreamToken(record);
    expect(await ks.verifyStreamToken(tok.token)).toMatchObject({ id: record.id });
    expect(await ks.verifyStreamToken(tok.token)).toBeNull();
    const tok2 = await ks.issueStreamToken(record);
    t += 60_000;
    expect(await ks.verifyStreamToken(tok2.token)).toBeNull();
    await ks.revoke(record.id);
    expect(await ks.authenticate(key)).toBeNull();
    await expect(ks.revoke("zzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ks.create({ label: "x", scopes: ["live"] }, { loopback: false })).rejects.toMatchObject({ code: "LOOPBACK_ONLY" });
    await expect(ks.create({ label: "x", scopes: ["paper"], allowQuery: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const created = await ks.create({ label: "x", scopes: ["paper"] });
    expect(await ks.get(created.record.id)).toEqual(created.record);
    expect((await ks.list()).length).toBe(2);
  });
});
