/**
 * The data modules together on the real Bridge (library, downloads, recorder): the modules were built apart and each is
 * tested against fakes of the others, so what one tells the next is checked here over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootBridge, stubBroker } from "./fixtures.mjs";

let bridge;
const keys = {};

beforeAll(async () => {
  bridge = await bootBridge({ brokers: { zerodha: stubBroker("zerodha") }, raw: { accounts: [{ id: "zerodha-a", broker: "zerodha", label: "Main" }, { id: "paper", broker: "paper" }] } });
  const mk = async (label, scopes) => (await bridge.deps.keyStore.create({ label, scopes, accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.admin = await mk("admin", ["admin", "paper"]);
  keys.read = await mk("read", ["read"]);
});
afterAll(async () => {
  await bridge?.close();
});

const http = (path, o = {}) => bridge.http(path, { key: keys.admin, ...o });

describe("collection usage lists what the recorder made from it", () => {
  it("shows manual recordings and auto-record rules, and refuses to delete a collection a recording is using", async () => {
    expect((await http("/v1/collections", { method: "POST", body: { name: "my-list", kind: "static", symbols: ["NSE:RELIANCE", "NSE:INFY"] } })).status).toBe(201);
    const rec = await http("/v1/recordings", { method: "POST", body: { name: "list quotes", kind: "quotes", collection: "my-list", everySec: 5, sessionOnly: false } });
    expect(rec.status).toBe(201);
    const rule = await http("/v1/recordings/rules", { method: "POST", body: { name: "list rule", kind: "quotes", collection: "my-list", everySec: 5 } });
    expect(rule.status).toBe(201);

    const usage = (await http("/v1/collections/my-list/usage", { key: keys.read })).json.data;
    expect(usage.sources).toMatchObject({ recordings: "available", rules: "available" });
    expect(usage.recordings.map((r) => r.id)).toEqual([rec.json.data.id]);
    expect(usage.rules.map((r) => r.id)).toEqual([rule.json.data.id]);
    expect(usage.recordings[0]).toMatchObject({ label: "list quotes", active: true });

    const refused = await http("/v1/collections/my-list", { method: "DELETE" });
    expect(refused.status).toBe(409);
    await http(`/v1/recordings/${rec.json.data.id}`, { method: "DELETE" });
    await http(`/v1/recordings/rules/${rule.json.data.id}`, { method: "DELETE" });
    expect((await http("/v1/collections/my-list", { method: "DELETE" })).status).toBe(204);
  });
});

describe("the settings routes are not read as ids", () => {
  it("answer from the real router with the real shapes", async () => {
    const dl = await http("/v1/downloads/settings", { key: keys.read });
    expect(dl.status).toBe(200);
    expect(dl.json.data).toMatchObject({ maxBudgetShare: 0.3, afterHoursOnly: false });
    const rc = await http("/v1/recordings/settings", { key: keys.read });
    expect(rc.status).toBe(200);
    expect(rc.json.data).toMatchObject({ maxBudgetShare: 0.3 });
    expect("afterHoursOnly" in rc.json.data).toBe(false);
    const patched = await http("/v1/recordings/settings", { method: "PATCH", body: { maxBudgetShare: 0.7 } });
    expect(patched.json.data.maxBudgetShare).toBe(0.7);
    expect((await http("/v1/recordings/status", { key: keys.read })).json.data.budgetShare).toBe(0.7);
    await http("/v1/recordings/settings", { method: "PATCH", body: { maxBudgetShare: 0.3 } });
  });
});

describe("calls saved by stored data show where the Data page reads them", () => {
  it("GET /v1/usage carries servedFromLocal next to the scheduler's own counts", async () => {
    const savings = (await http("/v1/usage", { key: keys.read })).json.data.savings;
    expect(savings).toMatchObject({ servedFromLocal: expect.any(Number), servedFromStream: expect.any(Number) });
  });
});
