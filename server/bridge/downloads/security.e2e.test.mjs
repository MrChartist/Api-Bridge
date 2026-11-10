/**
 * Security regressions for downloads on the REAL Bridge over HTTP (audit "security", S1, S4, S6): a read key cannot touch
 * another key's jobs or datasets, cannot fill the queue, and deletes and cancels are audited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootBridge, eventually, stubBroker } from "../e2e/fixtures.mjs";

let bridge;
const keys = {};

beforeAll(async () => {
  const broker = stubBroker("zerodha");
  bridge = await bootBridge({
    brokers: { zerodha: broker },
    raw: { accounts: [{ id: "zerodha-a", broker: "zerodha", label: "Main" }, { id: "paper", broker: "paper" }], downloads: { maxBudgetShare: 0.5, progressThrottleMs: 100, maxQueuedJobs: 4, maxQueuedJobsPerKey: 3 } },
    withConfigFile: true,
  });
  const mk = async (label, scopes) => (await bridge.deps.keyStore.create({ label, scopes, accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.alice = await mk("alice", ["read"]);
  keys.bob = await mk("bob", ["read"]);
  keys.admin = await mk("admin", ["admin"]);
  const r = await bridge.http("/v1/accounts/zerodha-a/session", { method: "POST", key: keys.admin, body: { values: { apiKey: "k", accessToken: "token-zerodha-a" } } });
  expect(r.json.data.state).toBe("connected");
  await bridge.deps.symbols.refresh();
});
afterAll(async () => {
  await bridge?.close();
});

const call = (method, path, key, body) => bridge.http(path, { method, key, body });
const BODY = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" };
const waitDone = (id) =>
  eventually(async () => {
    const j = (await call("GET", `/v1/downloads/${id}`, keys.alice)).json.data;
    return ["done", "failed", "cancelled"].includes(j.status) ? j : null;
  }, { ms: 15_000, every: 50 });
const audited = async (type) => (await bridge.deps.audit.query({ type, limit: 50 })).items;

describe("jobs belong to the key that started them", () => {
  it("lets another read key read but not pause, resume, cancel or rename a job; the owner and an admin can", async () => {
    const created = await call("POST", "/v1/downloads", keys.alice, { ...BODY, name: "alice job", dataset: "alice-ds" });
    expect(created.status).toBe(202);
    const id = created.json.data.id;
    expect(created.json.data.createdBy).toMatch(/^key:/);
    await waitDone(id);
    // a finished job cannot be cancelled, so use a second, held one for the write routes
    expect((await call("GET", `/v1/downloads/${id}`, keys.bob)).status).toBe(200);
    for (const [method, path, body] of [
      ["PATCH", `/v1/downloads/${id}`, { name: "hijacked" }],
      ["POST", `/v1/downloads/${id}/pause`],
      ["POST", `/v1/downloads/${id}/resume`],
      ["POST", `/v1/downloads/${id}/cancel`],
    ]) {
      const res = await call(method, path, keys.bob, body);
      expect([method, path, res.status, res.json?.code]).toEqual([method, path, 403, "SCOPE_REQUIRED"]);
    }
    expect((await call("GET", `/v1/downloads/${id}`, keys.alice)).json.data.name).toBe("alice job");
    expect((await call("PATCH", `/v1/downloads/${id}`, keys.alice, { name: "mine" })).status).toBe(200);
    expect((await call("PATCH", `/v1/downloads/${id}`, keys.admin, { name: "by admin" })).status).toBe(200);
  });

  it("stops another key from rewriting or renaming a dataset (the audit's exploit), while an update stays open to any read key", async () => {
    const ds = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16", dataset: "owner-ds", backup: false };
    const first = await call("POST", "/v1/downloads", keys.alice, ds);
    expect(first.status).toBe(202);
    await waitDone(first.json.data.id);
    const before = (await call("GET", "/v1/datasets/owner-ds", keys.bob)).json.data;
    const hijack = await call("POST", "/v1/downloads", keys.bob, { ...ds, backup: true, account: "zerodha-a", from: "2026-10-12", symbols: ["NSE:RELIANCE", "NSE:INFY"] });
    expect(hijack.status).toBe(403);
    expect(hijack.json.code).toBe("SCOPE_REQUIRED");
    expect((await call("PATCH", "/v1/datasets/owner-ds", keys.bob, { name: "hijacked" })).status).toBe(403);
    expect((await call("PATCH", "/v1/datasets/owner-ds", keys.bob, { tags: ["x"] })).status).toBe(403);
    const after = (await call("GET", "/v1/datasets/owner-ds", keys.bob)).json.data;
    expect(after.request).toEqual(before.request);
    expect(after.name).toBe("owner-ds");
    // the owner renames and tags it; so can an admin
    expect((await call("PATCH", "/v1/datasets/owner-ds", keys.alice, { tags: ["eq"] })).status).toBe(200);
    expect((await call("PATCH", "/v1/datasets/owner-ds", keys.admin, { title: "Owner data" })).status).toBe(200);
    // bob may ask for the update alice set up: it runs alice's stored request, nothing of bob's
    const upd = await call("POST", "/v1/datasets/owner-ds/update", keys.bob);
    expect(upd.status).toBe(202);
    expect(upd.json.data.request).toMatchObject({ backup: false, from: "2026-10-01" });
    await waitDone(upd.json.data.id);
  });
});

describe("the queue is capped", () => {
  it("refuses with 429 once a key has its places, and other keys still have theirs", async () => {
    // keep jobs open: the first window of every job waits on a paused account of the stub (jobs for a symbol the broker is slow on are not
    // needed here; paused jobs also count as open)
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await call("POST", "/v1/downloads", keys.alice, { ...BODY, name: `held ${i}`, symbols: ["NSE:RELIANCE", "NSE:INFY"], intervals: ["1m"], from: "2026-01-01" });
      expect(res.status).toBe(202);
      ids.push(res.json.data.id);
      await call("POST", `/v1/downloads/${res.json.data.id}/pause`, keys.alice);
    }
    const over = await call("POST", "/v1/downloads", keys.alice, BODY);
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("RATE_LIMITED");
    expect(over.json.detail ?? over.json.message ?? "").toMatch(/maxQueuedJobsPerKey/);
    const bobs = await call("POST", "/v1/downloads", keys.bob, { ...BODY, name: "bob fits" });
    expect(bobs.status).toBe(202);
    await call("POST", `/v1/downloads/${bobs.json.data.id}/pause`, keys.bob);
    // the Bridge-wide cap (4 in this test) is reached now
    const full = await call("POST", "/v1/downloads", keys.admin, BODY);
    expect(full.status).toBe(429);
    expect(full.json.detail ?? full.json.message ?? "").toMatch(/maxQueuedJobs /);
    for (const id of ids) expect((await call("POST", `/v1/downloads/${id}/cancel`, keys.alice)).status).toBe(200);
    await call("POST", `/v1/downloads/${bobs.json.data.id}/cancel`, keys.bob);
    expect((await call("POST", "/v1/downloads", keys.alice, BODY)).status).toBe(202);
  });
});

describe("deletes, cancels and renames are audited", () => {
  it("writes an audit record with the actor, for a job and a dataset", async () => {
    const id = (await call("POST", "/v1/downloads", keys.alice, { ...BODY, name: "audited" })).json.data.id;
    await waitDone(id);
    expect((await call("DELETE", `/v1/downloads/${id}`, keys.admin)).status).toBe(204);
    const deleted = (await audited("download.deleted")).find((r) => r.data.id === id);
    expect(deleted).toBeTruthy();
    expect(deleted.actor.id).toBeTruthy();
    expect(deleted.data).toMatchObject({ name: "audited" });

    const held = (await call("POST", "/v1/downloads", keys.alice, { ...BODY, name: "to cancel", symbols: ["NSE:RELIANCE", "NSE:INFY"], intervals: ["1m"], from: "2026-01-01" })).json.data.id;
    await call("POST", `/v1/downloads/${held}/pause`, keys.alice);
    expect((await call("POST", `/v1/downloads/${held}/cancel`, keys.alice)).status).toBe(200);
    expect((await audited("download.cancelled")).some((r) => r.data.id === held)).toBe(true);
    expect((await audited("download.created")).some((r) => r.data.id === held)).toBe(true);

    expect((await call("PATCH", "/v1/datasets/owner-ds", keys.alice, { name: "renamed-ds" })).status).toBe(200);
    expect((await audited("dataset.changed")).some((r) => r.data.name === "owner-ds" && r.data.newName === "renamed-ds")).toBe(true);
    expect((await call("DELETE", "/v1/datasets/renamed-ds", keys.admin)).status).toBe(204);
    expect((await audited("dataset.deleted")).some((r) => r.data.name === "renamed-ds")).toBe(true);
  });
});
