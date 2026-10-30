import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMarketData } from "../market/fake.mjs";
import { alertRuleRoutes, alertRulesFor, createAlertRules, evaluateRule, metricsFor } from "./alertRules.mjs";

const leg = (oi, extra = {}) => ({ symbol: "x", oi, oiChange: 0, volume: 0, iv: 15, gamma: 0.001, ...extra });
const chain = {
  underlying: "NIFTY",
  expiry: "2026-10-27",
  underlyingLtp: 25000,
  atmStrike: 25000,
  lotSize: 75,
  rows: [
    { strike: 24900, ce: leg(100), pe: leg(500) },
    { strike: 25000, ce: leg(300), pe: leg(300) },
    { strike: 25100, ce: leg(600), pe: leg(100) },
  ],
};
const base = { name: "r", underlying: "NIFTY", expiry: "2026-10-27" };

describe("evaluateRule", () => {
  const rule = { ...base, metric: "pcr_oi", op: "above", value: 1 };
  it("fires once per crossing and re-arms when the condition clears", () => {
    let state = {};
    const run = (v) => {
      const r = evaluateRule({ ...rule, state }, { pcrOi: v });
      state = r.state;
      return r.fired;
    };
    expect([run(0.8), run(1.2), run(1.3), run(0.9), run(1.1)]).toEqual([false, true, false, false, true]);
  });
  it("fires on the first check when already true, and never mutates the rule", () => {
    const r = { ...rule, state: {} };
    expect(evaluateRule(r, { pcrOi: 2 }).fired).toBe(true);
    expect(r.state).toEqual({});
  });
  it("below, and no data leaves state untouched", () => {
    const below = { ...rule, op: "below", value: 0.5, state: { active: true } };
    const r = evaluateRule(below, { pcrOi: null });
    expect(r).toMatchObject({ fired: false, status: "no_data", state: { active: true } });
    expect(evaluateRule({ ...below, state: {} }, { pcrOi: 0.4 }).fired).toBe(true);
  });
  it("covers atm_iv, basis_pct and max_pain_distance thresholds", () => {
    expect(evaluateRule({ ...base, metric: "atm_iv", op: "above", value: 20 }, { atmIv: 21 }).fired).toBe(true);
    expect(evaluateRule({ ...base, metric: "basis_pct", op: "below", value: 0 }, { basisPct: -0.1 }).fired).toBe(true);
    expect(evaluateRule({ ...base, metric: "max_pain_distance", op: "above", value: 1 }, { maxPainDistancePct: 0.4 }).fired).toBe(false);
  });
  it("gex_regime needs a baseline, then fires on a change (optionally only to one regime)", () => {
    const g = { ...base, metric: "gex_regime" };
    const first = evaluateRule(g, { gexRegime: "positive" });
    expect(first).toMatchObject({ fired: false, status: "baseline", state: { regime: "positive" } });
    const flip = evaluateRule({ ...g, state: first.state }, { gexRegime: "negative" });
    expect(flip.fired).toBe(true);
    expect(flip.message).toContain("positive to negative");
    expect(evaluateRule({ ...g, to: "positive", state: flip.state }, { gexRegime: "negative" }).fired).toBe(false);
    expect(evaluateRule({ ...g, state: flip.state }, { gexRegime: "negative" }).fired).toBe(false);
  });
  it("spot_cross records a baseline, fires on a crossing in the wanted direction only", () => {
    const s = { ...base, metric: "spot_cross", value: 25000, op: "above" };
    const a = evaluateRule(s, { spot: 24950 });
    expect(a).toMatchObject({ fired: false, status: "baseline" });
    expect(evaluateRule({ ...s, state: a.state }, { spot: 24990 }).fired).toBe(false);
    const up = evaluateRule({ ...s, state: a.state }, { spot: 25010 });
    expect(up.fired).toBe(true);
    const down = evaluateRule({ ...s, state: up.state }, { spot: 24900 });
    expect(down.fired).toBe(false);
    expect(down.state.side).toBe("below");
    expect(evaluateRule({ ...s, op: "either", state: up.state }, { spot: 24900 }).fired).toBe(true);
  });
});

describe("metricsFor", () => {
  const md = () => {
    const m = createFakeMarketData({ prices: { "NSE:NIFTY": 25020, "NFO:NIFTY-2026-10-27-FUT": 25070 } });
    m.setChain("NIFTY", "2026-10-27", chain);
    return m;
  };
  it("reads only what the metric needs", async () => {
    const marketData = md();
    expect((await metricsFor({ ...base, metric: "pcr_oi" }, { marketData })).pcrOi).toBe(0.9);
    expect((await metricsFor({ ...base, metric: "atm_iv" }, { marketData })).atmIv).toBe(15);
    expect((await metricsFor({ ...base, metric: "gex_regime" }, { marketData })).gexRegime).toMatch(/positive|negative|neutral/);
    const mp = await metricsFor({ ...base, metric: "max_pain_distance" }, { marketData });
    expect(mp).toMatchObject({ maxPain: 25000, maxPainDistancePct: 0 });
    expect((await metricsFor({ ...base, metric: "spot_cross", value: 1 }, { marketData })).spot).toBe(25020);
    expect((await metricsFor({ ...base, metric: "basis_pct" }, { marketData })).basisPct).toBe(0.2);
  });
});

describe("service and routes", () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  function setup(prices = { "NSE:NIFTY": 24900 }) {
    const dir = mkdtempSync(join(tmpdir(), "alert-rules-"));
    dirs.push(dir);
    const marketData = createFakeMarketData({ prices });
    const events = [];
    const handlers = {};
    const bus = { on: () => () => {}, emit: (t, p) => events.push([t, p]) };
    const clock = { now: () => Date.parse("2026-10-30T05:00:00Z") };
    const deps = { marketData, bus, clock, paths: { dataDir: dir } };
    for (const [m, p, o, h] of alertRuleRoutes(deps)) handlers[`${m} ${p}`] = { o, h };
    const call = (key, ctx = {}) => handlers[key].h({ requestId: "q", params: {}, query: new URLSearchParams(), principal: { kind: "local" }, ...ctx });
    return { dir, marketData, events, call, handlers, deps, clock };
  }
  const body = { name: "NIFTY 25000", underlying: "nifty", metric: "spot_cross", value: 25000, op: "above" };

  it("exposes the four routes with read scope and body none on DELETE", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers)).toEqual(["GET /v1/analytics/alert-rules", "POST /v1/analytics/alert-rules", "DELETE /v1/analytics/alert-rules/:ruleId", "POST /v1/analytics/alert-rules/:ruleId/check"]);
    expect(handlers["DELETE /v1/analytics/alert-rules/:ruleId"].o).toEqual({ scope: "read", body: "none" });
  });

  it("saves, persists atomically, checks with edge trigger, delivers, and deletes", async () => {
    const { dir, marketData, events, call, deps } = setup();
    const created = await call("POST /v1/analytics/alert-rules", { body });
    const id = JSON.parse(created.body).data.id;
    expect(id).toMatch(/^arule_/);
    const file = JSON.parse(readFileSync(join(dir, "analytics", "alert-rules.json"), "utf8"));
    expect(file.rules[0]).toMatchObject({ id, underlying: "NIFTY" });

    const check = async () => (await call("POST /v1/analytics/alert-rules/:ruleId/check", { params: { ruleId: id } })).data;
    expect((await check()).status).toBe("baseline");
    marketData.setPrice("NSE:NIFTY", 25010);
    const hit = await check();
    expect(hit).toMatchObject({ fired: true, value: 25010 });
    expect((await check()).fired).toBe(false);
    expect(events.map((e) => e[0])).toEqual(["scan.alert", "analytics.alert"]);
    expect(events[0][1]).toMatchObject({ name: "NIFTY 25000", savedId: id, newMatches: [hit.message] });

    marketData.setPrice("NSE:NIFTY", 24000);
    const dry = (await call("POST /v1/analytics/alert-rules/:ruleId/check", { params: { ruleId: id }, query: new URLSearchParams("dryRun=true") })).data;
    expect(dry.dryRun).toBe(true);
    expect(alertRulesFor(deps).get(id).state.side).toBe("above");

    const list = (await call("GET /v1/analytics/alert-rules")).data;
    expect(list).toHaveLength(1);
    expect(list[0].keyId).toBeUndefined();
    // a fresh service reads the saved state back
    expect(createAlertRules(deps).get(id).lastFiredAt).not.toBeNull();
    expect((await call("DELETE /v1/analytics/alert-rules/:ruleId", { params: { ruleId: id } })).data).toEqual({ id, deleted: true });
    await expect(call("DELETE /v1/analytics/alert-rules/:ruleId", { params: { ruleId: id } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates input and hides other keys' rules", async () => {
    const { call } = setup();
    await expect(call("POST /v1/analytics/alert-rules", { body: { name: "x", underlying: "NIFTY", metric: "pcr_oi", op: "above", value: 1 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(call("POST /v1/analytics/alert-rules", { body: { ...body, bogus: 1 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const k1 = { principal: { kind: "key" }, key: { id: "k1", accounts: "*" }, scopes: new Set(["read"]) };
    await call("POST /v1/analytics/alert-rules", { body, ...k1 });
    expect((await call("GET /v1/analytics/alert-rules", { ...k1, key: { id: "k2", accounts: "*" } })).data).toEqual([]);
    expect((await call("GET /v1/analytics/alert-rules", k1)).data).toHaveLength(1);
  });

  it("tick runs due rules with the injected clock and records errors", async () => {
    const { deps, marketData, events } = setup({ "NSE:NIFTY": 25100 });
    const svc = alertRulesFor(deps);
    const r = svc.save({ name: "t", underlying: "NIFTY", metric: "spot_cross", value: 25000, everyMinutes: 5, marketHoursOnly: false });
    await svc.tick();
    expect(svc.get(r.id).lastCheck.status).toBe("baseline");
    await svc.tick(); // not due again yet
    expect(marketData.calls.filter((c) => c[0] === "ltp")).toHaveLength(1);
    const bad = svc.save({ name: "e", underlying: "ZZZ", expiry: "2026-10-27", metric: "pcr_oi", op: "above", value: 1, everyMinutes: 5, marketHoursOnly: false });
    await svc.tick();
    expect(svc.get(bad.id).lastError.code).toBeTruthy();
    expect(events).toEqual([]);
  });
});
