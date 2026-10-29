/**
 * Readiness routes (p1-05 §4) on the real app: shape vs the OpenAPI schema, account visibility, IP privacy, the
 * check cooldown, history.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootBridge, stubBroker } from "../e2e/fixtures.mjs";

let bridge;
const keys = {};

/** required: [...] of a component schema in docs/openapi.yaml (disciplined layout). */
function requiredOf(schema) {
  const spec = readFileSync(resolve(import.meta.dirname, "../../../docs/openapi.yaml"), "utf8");
  const at = spec.indexOf(`\n    ${schema}:\n`);
  const m = /required: \[([^\]]+)\]/.exec(spec.slice(at, at + 400));
  return m ? m[1].split(",").map((s) => s.trim()) : [];
}

beforeAll(async () => {
  bridge = await bootBridge({
    brokers: { zerodha: stubBroker("zerodha") },
    raw: {
      safety: { liveTrading: true },
      accounts: [
        { id: "zerodha-main", broker: "zerodha", label: "Main", live: { enabled: true, allowedSources: ["rest", "webhook"], registeredIp: "203.0.113.10" } },
        { id: "zerodha-b", broker: "zerodha", label: "Family" },
        { id: "practice", broker: "paper" },
      ],
      readiness: { egressIp: { mode: "manual", manualIp: "198.51.100.23" } },
    },
  });
  for (const id of ["zerodha-main", "zerodha-b"]) await bridge.deps.accounts.connect(id, { values: { apiKey: "k", accessToken: `token-${id}` } });
  keys.admin = (await bridge.deps.keyStore.create({ label: "admin", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.read = (await bridge.deps.keyStore.create({ label: "read", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.mainOnly = (await bridge.deps.keyStore.create({ label: "main", scopes: ["read"], accounts: ["zerodha-main"], expiresAt: null, allowQuery: false, clientKind: "other" })).key;
});

afterAll(async () => {
  await bridge?.close();
});

const remote = { "X-Forwarded-For": "192.0.2.50" };

describe("readiness routes", () => {
  it("POST /v1/readiness/check runs the checks; GET answers the cached snapshot in the OpenAPI shape", async () => {
    const c = await bridge.http("/v1/readiness/check", { method: "POST", key: keys.read, body: {} });
    expect(c.status).toBe(200);
    const g = await bridge.http("/v1/readiness", { key: keys.read });
    expect(g.status).toBe(200);
    const d = g.json.data;
    for (const k of requiredOf("Readiness")) expect(d).toHaveProperty(k);
    expect(d.accounts.map((a) => a.accountId)).toEqual(["zerodha-main", "zerodha-b"]);
    for (const a of d.accounts) for (const k of requiredOf("AccountReadiness")) expect(a).toHaveProperty(k);
    const main = d.accounts[0];
    expect(main).toMatchObject({ state: "cannot_trade", live: { allowedByConfig: true } });
    expect(main.reasons[0]).toMatchObject({ check: "egress", code: "IP_MISMATCH", severity: "fail" });
    expect(Object.keys(main.checks).sort()).toEqual(["dailyLoss", "dailyOrders", "egress", "killSwitch", "orderRate", "session"]);
    expect(d.accounts[1]).toMatchObject({ state: "paper_only" });
    expect(d).toMatchObject({ overall: "cannot_trade", summary: "1 of 1 live account cannot trade", paperOnly: false });
    expect(d.method).toMatch(/as seen by the lookup service you chose/);
  });

  it("IP addresses only for this computer or admin keys", async () => {
    const local = (await bridge.http("/v1/readiness", { key: keys.read })).json.data;
    expect(local.accounts[0].checks.egress).toMatchObject({ detectedIp: "198.51.100.23", registeredIp: "203.0.113.10" });
    expect(local.egress.ip).toBe("198.51.100.23");
    const far = await bridge.http("/v1/readiness", { key: keys.read, headers: remote });
    expect(far.status).toBe(200);
    expect(far.text).not.toMatch(/198\.51\.100\.23|203\.0\.113\.10/);
    expect(far.json.data.accounts[0].checks.egress).toMatchObject({ matches: false, registered: "set", backup: "not-set" });
    expect(far.json.data.accounts[0].checks.egress).not.toHaveProperty("seenBy");
    const farAdmin = await bridge.http("/v1/readiness", { key: keys.admin, headers: remote });
    expect(farAdmin.json.data.accounts[0].checks.egress.detectedIp).toBe("198.51.100.23");
  });

  it("filters by the key's accounts; unknown → 404, not visible → 403; at most 20", async () => {
    const mine = await bridge.http("/v1/readiness", { key: keys.mainOnly });
    expect(mine.json.data.accounts.map((a) => a.accountId)).toEqual(["zerodha-main"]);
    expect((await bridge.http("/v1/readiness?account=nobody-here", { key: keys.read })).json.code).toBe("ACCOUNT_NOT_FOUND");
    const forbidden = await bridge.http("/v1/readiness?account=zerodha-b", { key: keys.mainOnly });
    expect([forbidden.status, forbidden.json.code]).toEqual([403, "ACCOUNT_FORBIDDEN"]);
    const one = await bridge.http("/v1/readiness?account=zerodha-b", { key: keys.read });
    expect(one.json.data.accounts.map((a) => a.accountId)).toEqual(["zerodha-b"]);
    const many = `/v1/readiness?${Array.from({ length: 21 }, () => "account=zerodha-b").join("&")}`;
    expect((await bridge.http(many, { key: keys.read })).status).toBe(400);
    expect((await bridge.http("/v1/readiness?acount=x", { key: keys.read })).status).toBe(400);
  });

  it("POST /check: probe cooldown is reported in meta.skipped; bad bodies are refused", async () => {
    const r = await bridge.http("/v1/readiness/check", { method: "POST", key: keys.read, body: { account: "zerodha-main" } });
    expect(r.status).toBe(200);
    expect(r.json.meta.skipped).toEqual(["probe:zerodha-main:cooldown"]);
    expect((await bridge.http("/v1/readiness/check", { method: "POST", key: keys.read, body: { account: "zerodha-main", extra: 1 } })).status).toBe(400);
    expect((await bridge.http("/v1/readiness/check", { method: "POST", key: keys.mainOnly, body: { account: "zerodha-b" } })).json.code).toBe("ACCOUNT_FORBIDDEN");
    expect((await bridge.http("/v1/readiness/check", { method: "POST", key: keys.read, body: { account: "nobody-here" } })).json.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("GET /history: newest first, limit, visible accounts only", async () => {
    const h = await bridge.http("/v1/readiness/history?limit=1", { key: keys.read });
    expect(h.status).toBe(200);
    expect(h.json.data).toHaveLength(1);
    expect(h.json.meta.kept).toBe(200);
    const all = (await bridge.http("/v1/readiness/history", { key: keys.read })).json.data;
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].at >= all.at(-1).at).toBe(true);
    const mine = (await bridge.http("/v1/readiness/history", { key: keys.mainOnly })).json.data;
    expect(mine.every((t) => t.accountId === "zerodha-main")).toBe(true);
    expect((await bridge.http("/v1/readiness/history?limit=0", { key: keys.read })).status).toBe(400);
  });

  it("the demo scenario route does not exist outside demo mode", async () => {
    expect((await bridge.http("/v1/demo/readiness", { method: "POST", key: keys.read, body: { scenario: "ip-changed" } })).status).toBe(404);
  });
});
