import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSecretStore } from "../auth/fake.mjs";
import { createHookStore, hashToken, publicHook } from "./hookStore.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mcb-hooks-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = { source: "gocharting", label: "Nifty breakout", account: "dhan-main", product: "INTRADAY" };

describe("hook store", () => {
  it("returns the token once and stores only its hash", async () => {
    const dir = tmp();
    const store = createHookStore({ dataDir: dir });
    const { hook, token, signingSecret } = await store.create(base);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(signingSecret).toBeNull();
    expect(hook.tokenHash).toBe(hashToken(token));
    const file = readFileSync(join(dir, "hooks.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).toContain(hook.tokenHash);
    expect(JSON.stringify(publicHook(hook))).not.toContain(hook.tokenHash);
    expect(store.findByToken(token)?.id).toBe(hook.id);
    expect(store.findByToken(`${token.slice(0, -1)}x`)).toBeNull();
    expect(store.findByToken("short")).toBeNull();
    if (process.platform !== "win32") expect(statSync(join(dir, "hooks.json")).mode & 0o777).toBe(0o600);
  });

  it("applies defaults and canonicalises allowed symbols", async () => {
    const store = createHookStore({ dataDir: tmp() });
    const { hook } = await store.create({ ...base, allowedSymbols: ["nse:reliance", "NSE:RELIANCE", "NFO:NIFTY-2026-10-27-25000-CE"] });
    expect(hook).toMatchObject({ mode: "paper", requireConfirmation: false, maxLotsPerSignal: 1, orderType: "LIMIT", side: null });
    expect(hook.allowedSymbols).toEqual(["NSE:RELIANCE", "NFO:NIFTY-2026-10-27-25000-CE"]);
  });

  it("validates the definition", async () => {
    const store = createHookStore({ dataDir: tmp() });
    await expect(store.create({ ...base, source: "slack" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ ...base, extra: 1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ ...base, allowedSymbols: ["???"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ ...base, maxLotsPerSignal: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("keeps generic signing secrets in the encrypted secret store, not in hooks.json", async () => {
    const dir = tmp();
    const secrets = createFakeSecretStore();
    const store = createHookStore({ dataDir: dir, secrets });
    const { hook, signingSecret } = await store.create({ ...base, source: "generic" });
    expect(signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(dir, "hooks.json"), "utf8")).not.toContain(signingSecret);
    expect(secrets.calls.find((c) => c.method === "set")).toMatchObject({ name: `hook:${hook.id}`, value: { signingSecret } });
    const fresh = createHookStore({ dataDir: dir, secrets });
    expect(await fresh.signingSecret(hook.id)).toBe(signingSecret);
    await fresh.remove(hook.id);
    expect(await secrets.get(`hook:${hook.id}`)).toBeNull();
  });

  it("refuses generic hooks without a secret store", async () => {
    const store = createHookStore({ dataDir: tmp() });
    await expect(store.create({ ...base, source: "generic" })).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("survives a restart and forgets deleted hooks at once", async () => {
    const dir = tmp();
    const a = createHookStore({ dataDir: dir });
    const { hook, token } = await a.create(base);
    const b = createHookStore({ dataDir: dir });
    expect(b.findByToken(token)?.id).toBe(hook.id);
    await b.remove(hook.id);
    expect(b.findByToken(token)).toBeNull();
    expect(createHookStore({ dataDir: dir }).list()).toEqual([]);
    await expect(b.remove(hook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces maxHooks and records lastSignalAt", async () => {
    const dir = tmp();
    const store = createHookStore({ dataDir: dir, maxHooks: 1, now: () => Date.parse("2026-10-19T04:00:00Z") });
    const { hook } = await store.create(base);
    await expect(store.create(base)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    store.touch(hook.id);
    store.close();
    expect(createHookStore({ dataDir: dir }).get(hook.id).lastSignalAt).toBe("2026-10-19T09:30:00.000+05:30");
  });

  it("registers new credentials with the logger so they are masked", async () => {
    const seen = [];
    const store = createHookStore({ dataDir: tmp(), secrets: createFakeSecretStore(), logger: { warn() {}, addSecret: (v) => seen.push(v) } });
    const { token, signingSecret } = await store.create({ ...base, source: "generic" });
    expect(seen).toEqual([token, signingSecret]);
  });
});
