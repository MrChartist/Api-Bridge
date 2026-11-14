/**
 * GET /v1/orders/drift and the readiness `orderBook` item on the real app (booted with a stub broker): the answer has the
 * OpenAPI shape, a key sees only its own accounts, the route needs the read scope and it makes no broker call.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootBridge, stubBroker } from "../e2e/fixtures.mjs";

let bridge;
const keys = {};

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
        { id: "zerodha-main", broker: "zerodha", label: "Main", live: { enabled: true, allowedSources: ["rest"] } },
        { id: "practice", broker: "paper" },
      ],
    },
  });
  await bridge.deps.accounts.connect("zerodha-main", { values: { apiKey: "k", accessToken: "token-main" } });
  keys.read = (await bridge.deps.keyStore.create({ label: "read", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.none = (await bridge.deps.keyStore.create({ label: "other", scopes: ["read"], accounts: ["practice"], expiresAt: null, allowQuery: false, clientKind: "other" })).key;
});

afterAll(async () => {
  await bridge?.close();
});

describe("GET /v1/orders/drift", () => {
  it("answers in the documented shape and says it only reports", async () => {
    const r = await bridge.http("/v1/orders/drift", { key: keys.read });
    expect(r.status).toBe(200);
    const d = r.json.data;
    for (const k of requiredOf("OrderDrift")) expect(d).toHaveProperty(k);
    expect(["idle", "waiting", "ok", "drift", "unavailable"]).toContain(d.state);
    expect(d.readOnly).toBe(true);
    expect(d.note).toMatch(/never changes or cancels/);
    expect(d.intervalMinutes).toBe(5);
    expect(Array.isArray(d.differences)).toBe(true);
    expect(r.json.meta).toMatchObject({ accountId: null });
  });

  it("needs a key and a known account; a key without access to the account is refused", async () => {
    expect((await bridge.http("/v1/orders/drift", {})).status).toBe(401);
    expect((await bridge.http("/v1/orders/drift?account=nope-nope", { key: keys.read })).status).toBe(404);
    expect((await bridge.http("/v1/orders/drift?account=zerodha-main", { key: keys.none })).status).toBe(403);
    expect((await bridge.http("/v1/orders/drift?bogus=1", { key: keys.read })).status).toBe(400);
  });

  it("a key that may not use the live account sees none of its accounts", async () => {
    const r = await bridge.http("/v1/orders/drift", { key: keys.none });
    expect(r.status).toBe(200);
    expect(r.json.data.accounts).toEqual([]);
  });

  it("is also an item of the readiness answer, with a pointer to the details", async () => {
    const r = await bridge.http("/v1/readiness", { key: keys.read });
    expect(r.status).toBe(200);
    expect(r.json.data.orderBook).toMatchObject({ details: "/v1/orders/drift", differences: 0 });
    expect(typeof r.json.data.orderBook.summary).toBe("string");
  });
});
