import { describe, expect, it } from "vitest";
import { budgetSummary } from "./budget.mjs";
import { consumerName, httpConsumer } from "./consumer.mjs";

const usage = {
  accounts: [
    {
      accountId: "kite-main",
      broker: "zerodha",
      healthy: true,
      queued: 2,
      classes: {
        quote: { callsToday: 100, backoffMs: 0, windows: [{ window: "1s", used: 1, limit: 1 }, { window: "1m", used: 30, limit: 400 }] },
        chain: { callsToday: 20, backoffMs: 0, windows: [{ window: "1s", used: 0, limit: 5 }, { window: "1m", used: 18, limit: 20 }] },
      },
    },
    { accountId: "dhan-main", broker: "dhan", healthy: true, queued: 0, classes: { quote: { callsToday: 5, backoffMs: 1500, windows: [{ window: "1s", used: 0, limit: 1 }] } } },
  ],
  savings: { servedFromStream: 10, servedFromCache: 5, coalesced: 3, batched: 2 },
};

describe("budgetSummary", () => {
  it("picks the fullest second and minute window per account and totals the day", () => {
    const s = budgetSummary(usage, "*", { feeds: [{ accountId: "kite-main", connected: true, subscriptions: 40 }] });
    const kite = s.accounts.find((a) => a.accountId === "kite-main");
    expect(kite.second).toEqual({ used: 1, limit: 1, cls: "quote" });
    expect(kite.minute).toEqual({ used: 18, limit: 20, cls: "chain" });
    expect(kite.callsToday).toBe(120);
    expect(s.accounts.find((a) => a.accountId === "dhan-main").backoffMs).toBe(1500);
    expect(s.callsToday).toBe(125);
    expect(s.savedToday).toBe(20);
    expect(s.stream).toEqual({ feeds: 1, up: 1, subscriptions: 40 });
  });

  it("shows only the accounts the key may use", () => {
    const s = budgetSummary(usage, new Set(["dhan-main"]), { feeds: [{ accountId: "kite-main", connected: true, subscriptions: 40 }] });
    expect(s.accounts.map((a) => a.accountId)).toEqual(["dhan-main"]);
    expect(s.callsToday).toBe(5);
    expect(s.stream.feeds).toBe(0);
  });
});

describe("consumer names", () => {
  it("names dashboard pages, MCP, compat and keys, and never passes odd characters", () => {
    expect(httpConsumer({ headers: { "x-mcb-client": "dashboard", "x-mcb-page": "chain" }, path: "/v1/optionchain" })).toBe("Dashboard · Option Chain");
    expect(httpConsumer({ headers: { "x-mcb-client": "dashboard", "x-mcb-page": "<script>" }, path: "/v1/quotes" })).toBe("Dashboard");
    expect(httpConsumer({ headers: {}, path: "/mcp" })).toBe("MCP (AI tools)");
    expect(httpConsumer({ headers: {}, path: "/api/v1/ltp" })).toBe("Excel / compat");
    expect(httpConsumer({ headers: {}, path: "/v1/ltp", principal: { kind: "key", label: "Python <bot>\n" } })).toBe("Key: Python bot");
    expect(consumerName("a".repeat(80))).toHaveLength(48);
    expect(consumerName("   ")).toBeNull();
  });
});
