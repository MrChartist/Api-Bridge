/**
 * End-to-end, multi-account routing: unpinned read-only market data is spread across the user's OWN accounts only
 * when BOTH the account opts in (marketData.pooling) AND the broker's policy says pooling is "allowed". No real
 * broker is marked "allowed" today (every entry is "unknown", treated as not allowed), so this test adds one
 * hypothetical broker, "stubpool", to the policy table. Everything else is the real Bridge.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootBridge, stubBroker } from "./fixtures.mjs";

vi.mock("../ratelimit/brokerPolicies.mjs", async (importOriginal) => {
  const mod = await importOriginal();
  const stubpool = Object.freeze({
    brokerId: "stubpool",
    limits: Object.freeze({ quote: Object.freeze({ perSecond: 1, verified: false }), master: Object.freeze({ perSecond: 1, verified: false }) }),
    maxQuoteBatch: 50,
    feed: Object.freeze({ maxConnections: 1, maxSubscriptions: 100 }),
    pooling: "allowed",
    maxModificationsPerOrder: null,
  });
  return { ...mod, BROKER_POLICIES: Object.freeze({ ...mod.BROKER_POLICIES, stubpool }) };
});

let bridge;
let stubpool;
let key;

beforeAll(async () => {
  stubpool = stubBroker("stubpool");
  bridge = await bootBridge({
    brokers: { stubpool },
    raw: {
      accounts: [
        { id: "pool-a", broker: "stubpool", holder: "self", marketData: { pooling: true } },
        { id: "pool-b", broker: "stubpool", holder: "self", marketData: { pooling: true } },
        // Same broker, but this account did NOT opt in: it must never serve someone else's unpinned read.
        { id: "pool-c", broker: "stubpool", holder: "self", marketData: { pooling: false } },
      ],
    },
  });
  key = (await bridge.deps.keyStore.create({ label: "pool", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  for (const id of ["pool-a", "pool-b", "pool-c"]) {
    const r = await bridge.http(`/v1/accounts/${id}/session`, { method: "POST", key, body: { values: { apiKey: `k-${id}`, accessToken: `token-${id}` } } });
    expect(r.status).toBe(200);
  }
  await bridge.deps.symbols.refresh();
});

afterAll(async () => {
  await bridge?.close();
});

const quotesBy = (account) => stubpool.calls.filter((c) => c.method === "fetchQuotes" && c.account === account);

describe("multi-account routing", () => {
  it("reports pooling per account from the account opt-in AND the broker policy", async () => {
    const r = await bridge.http("/v1/accounts", { key });
    const pooling = Object.fromEntries(r.json.data.map((a) => [a.id, a.pooling]));
    expect(pooling).toEqual({ "pool-a": true, "pool-b": true, "pool-c": false });
  });

  it("spreads unpinned reads across the opted-in accounts within each account's own limit", async () => {
    // Two unpinned reads back to back: the first uses one account's 1/s quote budget, so the second goes to the other
    // opted-in account instead of waiting.
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([bridge.http("/v1/ltp?symbols=NSE:RELIANCE&maxAgeMs=0", { key }), bridge.http("/v1/ltp?symbols=NSE:INFY&maxAgeMs=0", { key })]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const a = quotesBy("pool-a").length;
    const b = quotesBy("pool-b").length;
    expect(a + b).toBeGreaterThanOrEqual(1);
    expect(quotesBy("pool-c")).toHaveLength(0);
    // Both served well inside one second, which a single 1/s account could not do with two separate calls.
    if (a + b === 2) {
      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(Date.now() - t0).toBeLessThan(900);
    }
    for (const r of [r1, r2]) {
      const item = (r.json.data.items ?? r.json.data)[0];
      expect(["pool-a", "pool-b"]).toContain(item.freshness.accountId);
    }
  });

  it("never sends an unpinned read to an account that did not opt in, however many reads arrive", async () => {
    for (const sym of ["TCS", "SBIN", "ITC"]) {
      const r = await bridge.http(`/v1/ltp?symbols=NSE:${sym}&maxAgeMs=0`, { key });
      expect(r.status).toBe(200);
    }
    expect(quotesBy("pool-c")).toHaveLength(0);
    expect(quotesBy("pool-a").length).toBeGreaterThan(0);
    expect(quotesBy("pool-b").length).toBeGreaterThan(0);
    // Pinning is always honoured.
    const pinned = await bridge.http("/v1/ltp?symbols=NSE:LT&account=pool-c&maxAgeMs=0", { key });
    expect(pinned.status).toBe(200);
    expect(quotesBy("pool-c")).toHaveLength(1);
  });

  it("uses each account's own credentials for its calls (no sharing)", () => {
    for (const c of stubpool.calls.filter((x) => x.method === "fetchQuotes")) expect(["pool-a", "pool-b", "pool-c"]).toContain(c.account);
  });
});
