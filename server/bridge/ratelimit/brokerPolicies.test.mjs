import { describe, expect, it } from "vitest";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { normalisePolicies, poolingFor } from "../accounts/brokerInfo.mjs";
import { ENDPOINT_CLASSES } from "../core/contracts.mjs";
import { SEBI_UNREGISTERED_OPS_CEILING } from "../core/config.mjs";
import { BROKER_POLICIES, DEFAULT_CLASS_LIMITS, PAPER_POLICY } from "./brokerPolicies.mjs";
import { bucketPlan, effectiveClassSpec, lowerSpec, overrideProblems, resolvePolicy } from "./policy.mjs";

const WINDOWS = ["perSecond", "perMinute", "perDay"];
const ids = Object.keys(BROKER_POLICIES);

describe("BROKER_POLICIES table", () => {
  it("has exactly one entry per registered adapter (all 41)", () => {
    const registered = createBrokerRegistry().list().sort();
    expect(registered).toHaveLength(41);
    expect(ids.sort()).toEqual(registered);
    for (const id of ids) expect(BROKER_POLICIES[id].brokerId).toBe(id);
  });

  it("gives every number a verified flag and every verified number an official https source", () => {
    for (const [id, p] of Object.entries(BROKER_POLICIES)) {
      const specs = [...Object.entries(p.limits).map(([c, s]) => [`limits.${c}`, s]), ...Object.entries(p.groups ?? {}).map(([g, s]) => [`groups.${g}`, s])];
      for (const [where, s] of specs) {
        expect(typeof s.verified, `${id}.${where}`).toBe("boolean");
        if (s.verified) expect(s.source, `${id}.${where}`).toMatch(/^https:\/\/[^\s]+$/);
        if (s.source) expect(() => new URL(s.source)).not.toThrow();
        for (const k of WINDOWS) if (s[k] !== undefined) expect(s[k], `${id}.${where}.${k}`).toBeGreaterThan(0);
      }
      for (const c of Object.keys(p.limits)) expect(ENDPOINT_CLASSES, `${id} class ${c}`).toContain(c);
      for (const [g, s] of Object.entries(p.groups ?? {})) {
        expect(s.classes.length, `${id}.groups.${g}`).toBeGreaterThan(0);
        for (const c of s.classes) expect(ENDPOINT_CLASSES).toContain(c);
      }
    }
  });

  it("keeps pooling unknown (treated as not allowed) until a broker's terms clearly allow it", () => {
    for (const id of ids) expect(BROKER_POLICIES[id].pooling).toBe("unknown");
    // S1 reads the table through its own helpers; check they see it the same way.
    const table = normalisePolicies(BROKER_POLICIES);
    expect(Object.keys(table)).toHaveLength(41);
    expect(poolingFor(table, "zerodha")).toBe("unknown");
  });

  it("states batch sizes, feed caps and modification caps in the contract shape", () => {
    for (const [id, p] of Object.entries(BROKER_POLICIES)) {
      expect(Number.isInteger(p.maxQuoteBatch) && p.maxQuoteBatch >= 1, id).toBe(true);
      expect(p.feed).toHaveProperty("maxConnections");
      expect(p.feed).toHaveProperty("maxSubscriptions");
      expect(p.maxModificationsPerOrder === null || Number.isInteger(p.maxModificationsPerOrder)).toBe(true);
    }
    expect(BROKER_POLICIES.zerodha.feed).toEqual({ maxConnections: 3, maxSubscriptions: 3000 });
    expect(BROKER_POLICIES.dhan.maxQuoteBatch).toBe(1000);
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(BROKER_POLICIES)).toBe(true);
    expect(Object.isFrozen(BROKER_POLICIES.dhan.limits.order)).toBe(true);
    expect(() => {
      BROKER_POLICIES.dhan.limits.order.perSecond = 100;
    }).toThrow();
  });
});

describe("effective policies", () => {
  it("covers every endpoint class with at least one window for every broker", () => {
    for (const id of ids) {
      const p = resolvePolicy(id);
      for (const c of ENDPOINT_CLASSES) {
        const s = p.limits[c];
        expect(WINDOWS.some((k) => s[k] > 0) || s.extraWindows?.length, `${id}.${c}`).toBeTruthy();
        expect(s.perSecond, `${id}.${c} has a per-second cap`).toBeGreaterThan(0);
      }
      expect(bucketPlan(p).length).toBeGreaterThanOrEqual(ENDPOINT_CLASSES.length);
    }
  });

  it("never lets orders above the SEBI unregistered-algo ceiling, even where a broker allows more", () => {
    expect(BROKER_POLICIES.mstock.limits.order.perSecond).toBe(30);
    for (const id of ids) expect(resolvePolicy(id).limits.order.perSecond, id).toBeLessThanOrEqual(SEBI_UNREGISTERED_OPS_CEILING);
    expect(resolvePolicy("mstock").limits.order.perSecond).toBe(10);
  });

  it("falls back to conservative defaults for unverified figures but keeps lower ones", () => {
    for (const id of ids) {
      const p = resolvePolicy(id);
      for (const c of ENDPOINT_CLASSES) {
        const s = p.limits[c];
        if (s.verified) continue;
        const def = DEFAULT_CLASS_LIMITS[c];
        for (const k of WINDOWS) if (def[k] !== undefined) expect(s[k], `${id}.${c}.${k}`).toBeLessThanOrEqual(def[k]);
      }
    }
    // Shoonya's approximate 10/s quotes are unverified: defaults apply.
    expect(resolvePolicy("shoonya").limits.quote).toMatchObject({ perSecond: 1, verified: false });
    // Dhan's unverified chain figure (1 per 3 s) is lower than the default, so it stays.
    expect(resolvePolicy("dhan").limits.chain).toMatchObject({ perSecond: 1, perMinute: 20, verified: false });
    expect(effectiveClassSpec("portfolio", undefined)).toMatchObject({ perSecond: 2, verified: false, defaulted: true });
  });

  it("uses verified figures as written", () => {
    expect(resolvePolicy("zerodha").limits.history).toMatchObject({ perSecond: 3, verified: true });
    expect(resolvePolicy("dhan").limits.order).toMatchObject({ perSecond: 10, perMinute: 250, perDay: 7000, extraWindows: [{ windowMs: 3_600_000, limit: 1000 }] });
    expect(resolvePolicy("fyers").groups.dataApis).toMatchObject({ perSecond: 5, perMinute: 50, perDay: 5000, classes: ["quote", "depth", "history", "chain"] });
  });

  it("derives a per-second cap from minute-only figures", () => {
    expect(resolvePolicy("nubra").limits.quote).toMatchObject({ perMinute: 60, perSecond: 2, derivedPerSecond: true });
  });

  it("shares quote, depth and chain budgets by default and for brokers that declare no groups", () => {
    const p = resolvePolicy("kotak");
    expect(p.groups.quoteFamily).toMatchObject({ classes: ["quote", "depth", "chain"], perSecond: 1, defaulted: true });
    expect(resolvePolicy("not-a-broker")).toMatchObject({ known: false, pooling: "unknown", maxQuoteBatch: 1 });
  });

  it("treats paper accounts as unlimited with pooling not allowed", () => {
    const p = resolvePolicy("paper");
    expect(p).toMatchObject({ unlimited: true, pooling: "not-allowed" });
    expect(bucketPlan(p)).toEqual([]);
    expect(PAPER_POLICY.brokerId).toBe("paper");
  });
});

describe("overrides only lower", () => {
  it("lowers windows and leaves higher values alone", () => {
    expect(lowerSpec({ perSecond: 3, verified: true }, { perSecond: 1, perMinute: 30 })).toEqual({ perSecond: 1, perMinute: 30, verified: true, lowered: true });
    expect(lowerSpec({ perSecond: 3, verified: true }, { perSecond: 9 })).toEqual({ perSecond: 3, verified: true });
    expect(lowerSpec({ perSecond: 3, verified: true }, undefined)).toEqual({ perSecond: 3, verified: true });
  });

  it("applies broker then account overrides, and can never raise", () => {
    const p = resolvePolicy("zerodha", { broker: { limits: { history: { perSecond: 2 } }, maxQuoteBatch: 100 }, account: { limits: { history: { perSecond: 50, perMinute: 60 } }, groups: { quote: { perSecond: 5 } } } });
    expect(p.limits.history).toMatchObject({ perSecond: 2, perMinute: 60, lowered: true });
    expect(p.groups.quote.perSecond).toBe(1);
    expect(p.maxQuoteBatch).toBe(100);
    const raised = resolvePolicy("zerodha", { account: { limits: { order: { perSecond: 50 } }, maxQuoteBatch: 9999 } });
    expect(raised.limits.order.perSecond).toBe(10);
    expect(raised.maxQuoteBatch).toBe(500);
  });

  it("reports overrides that try to raise a limit, name an unknown group or broker", () => {
    expect(overrideProblems("zerodha", { limits: { quote: { perSecond: 1 } } })).toEqual([]);
    expect(overrideProblems("zerodha", { limits: { quote: { perSecond: 5 } } })[0]).toMatchObject({ path: ["limits", "quote", "perSecond"] });
    expect(overrideProblems("zerodha", { groups: { nope: { perSecond: 1 } } })[0].message).toMatch(/no group "nope"/);
    expect(overrideProblems("zerodha", { maxQuoteBatch: 501 })[0].path).toEqual(["maxQuoteBatch"]);
    expect(overrideProblems("dhan", { limits: { order: { extraWindows: [{ windowMs: 3_600_000, limit: 2000 }] } } })[0].path).toEqual(["limits", "order", "extraWindows"]);
    expect(overrideProblems("acme", {})[0].message).toMatch(/not a broker id/);
  });
});
