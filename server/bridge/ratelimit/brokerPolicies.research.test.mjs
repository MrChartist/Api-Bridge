/**
 * The November 2026 broker research applied to the policy table: pooling notes, data entitlement, the corrected
 * and added figures, Fyers plans, and the table validation rules.
 */
import { describe, expect, it } from "vitest";
import { BROKER_POLICIES, DATA_ENTITLEMENTS, POLICY_TABLE_CHECKED, POOLING_NOT_REVIEWED } from "./brokerPolicies.mjs";
import { bucketPlan, chooseTier, overrideProblems, policyTableProblems, resolvePolicy } from "./policy.mjs";
import { parseRatelimitConfig } from "./config.mjs";

const ids = Object.keys(BROKER_POLICIES);

describe("pooling and data entitlement notes", () => {
  it("keeps pooling unknown for every broker: the research found no clause that allows it and none about reads that forbids it", () => {
    for (const id of ids) expect(BROKER_POLICIES[id].pooling, id).toBe("unknown");
  });

  it("gives every broker a one-line poolingNote, with the findings for the 14 brokers that were reviewed", () => {
    for (const id of ids) {
      const note = BROKER_POLICIES[id].poolingNote;
      expect(typeof note, id).toBe("string");
      expect(note.length, id).toBeGreaterThan(20);
      expect(note, id).not.toMatch(/[\r\n]/);
    }
    const reviewed = ["zerodha", "upstox", "dhan", "angelone", "fyers", "groww", "fivepaisa", "aliceblue", "kotak", "flattrade", "shoonya", "icicidirect", "hdfcsky", "motilal"];
    for (const id of reviewed) expect(BROKER_POLICIES[id].poolingNote, id).not.toBe(POOLING_NOT_REVIEWED);
    expect(BROKER_POLICIES.kotak.poolingNote).toMatch(/exclusively for the client's own use/);
    expect(BROKER_POLICIES.shoonya.poolingNote).toMatch(/used only by you/);
    expect(BROKER_POLICIES.bigul.poolingNote).toBe(POOLING_NOT_REVIEWED);
  });

  it("records Motilal's wording as a note about ORDER limits, not as a ban on pooling reads", () => {
    expect(BROKER_POLICIES.motilal.pooling).toBe("unknown");
    expect(BROKER_POLICIES.motilal.poolingNote).toMatch(/circumvent the OPS limit/);
    expect(BROKER_POLICIES.motilal.poolingNote).toMatch(/order limits, not reads/);
  });

  it("states what live data costs for the brokers whose data needs a paid plan", () => {
    for (const id of ["zerodha", "dhan", "groww"]) {
      expect(BROKER_POLICIES[id].dataEntitlement, id).toMatchObject({ value: "paid-for-live", verified: true });
      expect(BROKER_POLICIES[id].dataEntitlement.source).toMatch(/^https:\/\//);
      expect(BROKER_POLICIES[id].dataEntitlement.note).toMatch(/Rs 500|Rs 499/);
    }
    expect(BROKER_POLICIES.upstox.dataEntitlement.value).toBe("free");
    expect(BROKER_POLICIES.angelone.dataEntitlement.value).toBe("free");
    // Marketing-page claims stay unverified.
    expect(BROKER_POLICIES.fivepaisa.dataEntitlement).toMatchObject({ value: "free", verified: false });
    expect(BROKER_POLICIES.shoonya.dataEntitlement.value).toBe("unknown");
    for (const id of ids) {
      const d = BROKER_POLICIES[id].dataEntitlement;
      if (d) expect(DATA_ENTITLEMENTS, id).toContain(d.value);
    }
  });

  it("reports an entitlement and a poolingNote on every effective policy (unknown when not researched)", () => {
    expect(resolvePolicy("zerodha").dataEntitlement).toMatchObject({ value: "paid-for-live", verified: true });
    expect(resolvePolicy("bigul").dataEntitlement).toMatchObject({ value: "unknown", verified: false });
    expect(resolvePolicy("bigul").poolingNote).toBe(POOLING_NOT_REVIEWED);
    expect(resolvePolicy("not-a-broker")).toMatchObject({ dataEntitlement: { value: "unknown" }, poolingNote: POOLING_NOT_REVIEWED });
    expect(resolvePolicy("paper").pooling).toBe("not-allowed");
  });
});

describe("corrections from the broker research", () => {
  it("is dated November 2026", () => {
    expect(POLICY_TABLE_CHECKED).toBe("2026-11");
  });

  it("marks Zerodha's order caps verified (they are on the exceptions page) and keeps them as a group", () => {
    expect(BROKER_POLICIES.zerodha.groups.orderCaps).toMatchObject({ perMinute: 400, perDay: 5000, verified: true, classes: ["order"] });
    expect(resolvePolicy("zerodha").groups.orderCaps).toMatchObject({ perMinute: 400, perDay: 5000, verified: true });
  });

  it("adds Dhan's feed sub-limits and cites the option-chain page", () => {
    expect(BROKER_POLICIES.dhan.feed).toMatchObject({ maxConnections: 5, maxSubscriptions: 5000, perSubscribeMessage: 100, depth20PerConnection: 50, depth200PerConnection: 1, verified: true });
    expect(BROKER_POLICIES.dhan.limits.chain.source).toBe("https://dhanhq.co/docs/v2/option-chain/");
  });

  it("adds Angel One's minute and hour caps as unverified groups and keeps the verified per-second figures", () => {
    const p = resolvePolicy("angelone");
    expect(p.limits.order).toMatchObject({ perSecond: 9, verified: true });
    expect(p.groups.orderCaps).toMatchObject({ perMinute: 500, verified: false, classes: ["order"], extraWindows: [{ windowMs: 3_600_000, limit: 1000 }] });
    expect(p.groups.candleCaps).toMatchObject({ perMinute: 120, verified: false, classes: ["history"], extraWindows: [{ windowMs: 3_600_000, limit: 5000 }] });
    expect(p.feed).toMatchObject({ maxConnections: 3, maxSubscriptions: 1000, verified: false });
  });

  it("adds the missing feed and order entries", () => {
    expect(BROKER_POLICIES.groww.feed).toMatchObject({ maxSubscriptions: 1000, verified: true });
    expect(BROKER_POLICIES.kotak.limits.order).toMatchObject({ perSecond: 10, verified: true });
    expect(BROKER_POLICIES.kotak.feed).toMatchObject({ maxSubscriptions: 200, verified: false });
    expect(BROKER_POLICIES.motilal.limits.order).toMatchObject({ perSecond: 10, verified: true });
    expect(BROKER_POLICIES.icicidirect.limits.order).toMatchObject({ perSecond: 10, verified: true });
    expect(resolvePolicy("icicidirect").groups.breeze).toMatchObject({ perMinute: 100, perDay: 5000 });
    expect(BROKER_POLICIES.hdfcsky.feed).toMatchObject({ maxConnections: 3, maxSubscriptions: 300, verified: false });
    expect(BROKER_POLICIES.fivepaisa.limits.order).toMatchObject({ perSecond: 10, perMinute: 600, verified: false });
    expect(BROKER_POLICIES.fivepaisa.groups.nonOrder).toMatchObject({ perMinute: 50, verified: false });
    expect(BROKER_POLICIES.fivepaisa.feed).toMatchObject({ maxSubscriptions: 200, verified: false });
    expect(BROKER_POLICIES.shoonya.feed).toMatchObject({ maxConnections: 1, verified: true });
  });

  it("adds Upstox's combined-mode feed caps", () => {
    expect(BROKER_POLICIES.upstox.feed.byMode).toEqual({
      ltpc: { alone: 5000, combined: 2000 },
      optionGreeks: { alone: 3000, combined: 2000 },
      full: { alone: 2000, combined: 1500 },
    });
  });

  it("flags the two brokers whose docs could not be re-read", () => {
    expect(BROKER_POLICIES.aliceblue.notes).toMatch(/Verify before release/);
    expect(BROKER_POLICIES.flattrade.notes).toMatch(/Verify before release/);
  });
});

describe("Fyers plans", () => {
  it("keeps Standard as the default, with the 16 October 2026 limits and the 100-symbol feed", () => {
    const p = resolvePolicy("fyers");
    expect(p).toMatchObject({ tier: "standard", tiers: ["standard", "prime"], maxQuoteBatch: 50 });
    expect(p.groups.dataApis).toMatchObject({ perSecond: 5, perMinute: 50, perDay: 5000, verified: true, classes: ["quote", "depth", "history", "chain"] });
    expect(p.groups.transactionApis).toMatchObject({ perSecond: 10, perMinute: 200, perDay: 100_000, verified: true });
    expect(p.feed).toMatchObject({ maxConnections: 1, maxSubscriptions: 100, verified: true });
    expect(p.dataEntitlement).toMatchObject({ value: "free", verified: true });
    expect(BROKER_POLICIES.fyers.defaultTier).toBe("standard");
    // The entry's own figures are the default tier's, so a reader that ignores tiers sees the safe plan.
    expect(BROKER_POLICIES.fyers.groups.dataApis.perDay).toBe(5000);
    expect(BROKER_POLICIES.fyers.feed.maxSubscriptions).toBe(100);
  });

  it("resolves Prime when the account or the broker chooses it", () => {
    const viaAccount = resolvePolicy("fyers", { account: { tier: "prime" } });
    expect(viaAccount).toMatchObject({ tier: "prime", maxQuoteBatch: 1000 });
    expect(viaAccount.groups.dataApis).toMatchObject({ perSecond: 10, perMinute: 500, perDay: 500_000 });
    expect(viaAccount.groups.transactionApis).toMatchObject({ perSecond: 10, perMinute: 500, perDay: 500_000 });
    expect(viaAccount.feed).toMatchObject({ maxSubscriptions: 5000 });
    expect(viaAccount.dataEntitlement).toMatchObject({ value: "paid", verified: true });
    expect(resolvePolicy("fyers", { broker: { tier: "prime" } }).tier).toBe("prime");
    // The account's choice wins over the broker-level one.
    expect(resolvePolicy("fyers", { broker: { tier: "prime" }, account: { tier: "standard" } }).tier).toBe("standard");
  });

  it("falls back to Standard, never to Prime, for an unknown plan name, and says so", () => {
    const p = resolvePolicy("fyers", { account: { tier: "platinum" } });
    expect(p.tier).toBe("standard");
    expect(p.tierFallback).toMatch(/platinum is not a plan of fyers/);
    expect(p.groups.dataApis.perDay).toBe(5000);
    expect(chooseTier(BROKER_POLICIES.zerodha, "prime")).toEqual({ id: null, fields: {} });
    // A broker without plans ignores the choice.
    expect(resolvePolicy("zerodha", { account: { tier: "prime" } }).tier).toBeUndefined();
  });

  it("lets overrides lower the chosen plan, but not raise it, and judges them against that plan", () => {
    const p = resolvePolicy("fyers", { account: { tier: "prime", groups: { dataApis: { perMinute: 100 } } } });
    expect(p.groups.dataApis).toMatchObject({ perMinute: 100, perSecond: 10, lowered: true });
    expect(overrideProblems("fyers", { groups: { dataApis: { perMinute: 400 } } })[0].path).toEqual(["groups", "dataApis", "perMinute"]);
    expect(overrideProblems("fyers", { tier: "prime", groups: { dataApis: { perMinute: 400 } } })).toEqual([]);
    expect(overrideProblems("fyers", { tier: "prime", maxQuoteBatch: 1000 })).toEqual([]);
    expect(overrideProblems("fyers", { tier: "gold" })[0]).toMatchObject({ path: ["tier"] });
    expect(overrideProblems("zerodha", { tier: "prime" })[0].message).toMatch(/no plans/);
  });

  it("accepts the tier in the ratelimit config, for a broker and for an account", () => {
    const cfg = parseRatelimitConfig({ brokers: { fyers: { tier: "prime" } }, accounts: { "fyers-main": { tier: "standard" } } });
    expect(cfg.brokers.fyers.tier).toBe("prime");
    expect(cfg.accounts["fyers-main"].tier).toBe("standard");
    // A broker entry naming a plan the broker does not have is a config error.
    expect(() => parseRatelimitConfig({ brokers: { fyers: { tier: "gold" } } })).toThrow(/not a plan of fyers/);
    expect(() => parseRatelimitConfig({ brokers: { dhan: { tier: "prime" } } })).toThrow(/no plans/);
  });

  it("keeps Prime's budget behind the same bucket plan shape with different windows", () => {
    const std = bucketPlan(resolvePolicy("fyers"));
    const prime = bucketPlan(resolvePolicy("fyers", { account: { tier: "prime" } }));
    expect(prime.map((b) => b.key)).toEqual(std.map((b) => b.key));
    const dataStd = std.find((b) => b.key === "group:dataApis");
    const dataPrime = prime.find((b) => b.key === "group:dataApis");
    expect(JSON.stringify(dataPrime.windows)).not.toBe(JSON.stringify(dataStd.windows));
  });
});

describe("policy table validation", () => {
  it("passes for the shipped table", () => {
    expect(policyTableProblems(BROKER_POLICIES)).toEqual([]);
  });

  const base = BROKER_POLICIES.zerodha;
  const check = (patch) => policyTableProblems({ zerodha: { ...base, ...patch } }).map((p) => `${p.path}: ${p.message}`);

  it("rejects a bad pooling value, a missing or multi-line poolingNote", () => {
    expect(check({ pooling: "yes" })[0]).toMatch(/^pooling:/);
    expect(check({ poolingNote: undefined })[0]).toMatch(/^poolingNote:/);
    expect(check({ poolingNote: "one\ntwo" })[0]).toMatch(/^poolingNote:/);
  });

  it("rejects a bad dataEntitlement", () => {
    expect(check({ dataEntitlement: { value: "maybe", note: "x", verified: false } })[0]).toMatch(/dataEntitlement.value/);
    expect(check({ dataEntitlement: { value: "free", note: "", verified: false } })[0]).toMatch(/dataEntitlement.note/);
    expect(check({ dataEntitlement: { value: "free", note: "n", verified: true } })[0]).toMatch(/dataEntitlement.source/);
    expect(check({ dataEntitlement: { value: "free", note: "n", verified: false, price: 5 } })[0]).toMatch(/dataEntitlement.price/);
  });

  it("rejects a verified figure with no official https source, and a missing verified flag", () => {
    expect(check({ limits: { quote: { perSecond: 1, verified: true } } })[0]).toMatch(/limits.quote: a verified figure needs/);
    expect(check({ limits: { quote: { perSecond: 1 } } })[0]).toMatch(/boolean verified/);
    expect(check({ limits: { nonsense: { perSecond: 1, verified: false } } })[0]).toMatch(/not an endpoint class/);
    expect(check({ feed: { maxConnections: 3, maxSubscriptions: 3000, verified: true } })[0]).toMatch(/feed cap needs/);
  });

  it("rejects a tier table whose default tier is missing or differs from the entry's own figures", () => {
    const fyers = BROKER_POLICIES.fyers;
    expect(policyTableProblems({ fyers: { ...fyers, defaultTier: "gold" } })[0]).toMatchObject({ path: "defaultTier" });
    expect(policyTableProblems({ fyers: { ...fyers, maxQuoteBatch: 7 } })[0]).toMatchObject({ path: "tiers" });
  });
});
