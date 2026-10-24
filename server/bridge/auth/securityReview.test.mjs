// Regression tests for fixes from the pre-launch security review.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNullLogger } from "../core/logger.mjs";
import { expandIpList, ipEntrySchema } from "../hooks/config.mjs";
import { createKeyStore } from "./keyStore.mjs";

const FAST = { N: 2 ** 14, r: 8, p: 1 };
const mk = () => createKeyStore({ logger: createNullLogger(), clock: { now: () => Date.now() }, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-review-")) } }, { scryptParams: FAST });

describe("key creation cannot widen accounts", () => {
  it("refuses a key for more accounts than the creating key holds", async () => {
    const ks = mk();
    const opts = { loopback: true, creatorScopes: ["admin", "read"], creatorAccounts: ["acct-a"] };
    await expect(ks.create({ label: "wide", scopes: ["paper"], accounts: "*" }, opts)).rejects.toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
    await expect(ks.create({ label: "other", scopes: ["paper"], accounts: ["acct-a", "acct-b"] }, opts)).rejects.toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
    const ok = await ks.create({ label: "same", scopes: ["paper"], accounts: ["acct-a"] }, opts);
    expect(ok.record.accounts).toEqual(["acct-a"]);
  });

  it("leaves '*' creators and the local CLI unrestricted", async () => {
    const ks = mk();
    await expect(ks.create({ label: "a", scopes: ["paper"], accounts: "*" }, { creatorScopes: ["admin"], creatorAccounts: "*" })).resolves.toBeTruthy();
    await expect(ks.create({ label: "b", scopes: ["paper"], accounts: "*" })).resolves.toBeTruthy();
  });
});

describe("hook IP allowlist entries", () => {
  it("accepts only addresses and CIDR blocks, never names such as inherited Object keys", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(ipEntrySchema.safeParse(name).success).toBe(false);
    expect(ipEntrySchema.safeParse("52.89.214.238").success).toBe(true);
    expect(expandIpList(["__proto__"])).toEqual(["__proto__"]);
  });
});
