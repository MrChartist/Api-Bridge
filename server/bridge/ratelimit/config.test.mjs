import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_PER_SECOND, parseRatelimitConfig, ratelimitConfigSchema } from "./config.mjs";

describe("ratelimit config section", () => {
  it("defaults to the safe settings", () => {
    const c = parseRatelimitConfig(undefined);
    expect(c.client).toEqual({ perSecond: DEFAULT_CLIENT_PER_SECOND, keys: {} });
    expect(c.queue).toEqual({ maxQueuedPerAccount: 5000, ageingMs: 2000, maxWaitMs: { order: 5000, live: 15000, interactive: 10000, background: 300000 } });
    expect(c.maxInFlightPerAccount).toBe(8);
    expect(c.windowPaddingMs).toBe(100);
    expect(c.backoff).toEqual({ initialMs: 1000, maxMs: 60000 });
    expect(c.brokers).toEqual({});
    expect(c.accounts).toEqual({});
  });

  it("accepts overrides that lower broker limits", () => {
    const c = parseRatelimitConfig({ brokers: { zerodha: { limits: { history: { perSecond: 1, perMinute: 30 } }, groups: { quote: { perSecond: 1 } }, maxQuoteBatch: 200 } } });
    expect(c.brokers.zerodha.limits.history).toEqual({ perSecond: 1, perMinute: 30 });
  });

  it("rejects overrides that would raise a broker limit, with a clear path", () => {
    const r = ratelimitConfigSchema.safeParse({ brokers: { zerodha: { limits: { quote: { perSecond: 10 } } } } });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].path).toEqual(["brokers", "zerodha", "limits", "quote", "perSecond"]);
    expect(r.error.issues[0].message).toMatch(/may only lower/);
  });

  it("rejects unknown brokers, classes, keys and out-of-range values", () => {
    expect(ratelimitConfigSchema.safeParse({ brokers: { acme: { limits: {} } } }).success).toBe(false);
    expect(ratelimitConfigSchema.safeParse({ brokers: { zerodha: { limits: { quotes: { perSecond: 1 } } } } }).success).toBe(false);
    expect(ratelimitConfigSchema.safeParse({ brokers: { zerodha: { limits: { quote: { perHour: 1 } } } } }).success).toBe(false);
    expect(ratelimitConfigSchema.safeParse({ typo: true }).success).toBe(false);
    expect(ratelimitConfigSchema.safeParse({ windowPaddingMs: -1 }).success).toBe(false);
    expect(ratelimitConfigSchema.safeParse({ client: { perSecond: 0 } }).success).toBe(false);
    expect(ratelimitConfigSchema.safeParse({ accounts: { "Bad Id": {} } }).success).toBe(false);
  });

  it("accepts per-key client budgets and account overrides (clamped at runtime)", () => {
    const c = parseRatelimitConfig({ client: { perSecond: 20, burst: 40, keys: { sheet000001: { perSecond: 2 } } }, accounts: { "zerodha-main": { limits: { quote: { perSecond: 99 } } } } });
    expect(c.client.keys.sheet000001.perSecond).toBe(2);
    expect(c.accounts["zerodha-main"].limits.quote.perSecond).toBe(99);
  });
});
