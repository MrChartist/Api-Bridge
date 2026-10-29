/**
 * Recorder planner (docs/spec/p1-01-recorder.md §5.1–5.2): the worked budgets for Dhan, Zerodha, Upstox, Fyers and
 * demo; rule 4; a feed on another account; priority order; the CAPACITY_EXCEEDED payload; and the feasibility table in
 * docs/guides/recorder.md equals scripts/recorder-feasibility.mjs output.
 */
import { describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../demo/demoMode.mjs";
import { resolvePolicy } from "../ratelimit/policy.mjs";
import { feasibilityTable, tableInDoc } from "../../../scripts/recorder-feasibility.mjs";
import { parseRecorderConfig } from "./config.mjs";
import { capacityPayload, feasibilityRow, feedCapFor, fullAvailability, legsFor, planRecording } from "./plan.mjs";

const cfg = (over = {}) => parseRecorderConfig(over);
const plan = (broker, over = {}, extra = {}) => {
  const c = cfg(over);
  const policy = broker === "demo" ? resolvePolicy("demo", {}, { demo: DEMO_POLICY }) : resolvePolicy(broker);
  const hasFeed = !["fyers"].includes(broker);
  const brokerName = broker[0].toUpperCase() + broker.slice(1);
  return planRecording({ cfg: c, account: { id: `${broker}-main`, broker }, policy, feedCap: feedCapFor(policy, hasFeed), available: fullAvailability(c, c.stocks), brokerName, ...extra });
};
const by = (p, source, kind = "index") => p.chains.filter((c) => c.source === source && c.kind === kind).length;
const STOCKS = Array.from({ length: 40 }, (_, i) => `STK${String(i).padStart(2, "0")}`);

describe("§5.2 worked budgets (default config)", () => {
  it("chain sizes: ±40 = 162 legs, ±15 = 62", () => {
    expect(legsFor(40)).toBe(162);
    expect(legsFor(15)).toBe(62);
  });

  it("Dhan: all 18 index chains by stream (2,934 of 3,000); REST off; streamShare 0.9 → 24 stocks", () => {
    const p = plan("dhan");
    expect(by(p, "stream")).toBe(18);
    expect(p.capacity.stream).toMatchObject({ cap: 3000, used: 2934, feedLimit: 5000, share: 0.6 });
    expect(p.capacity.rest.allowed).toBe(false);
    expect(p.capacity.rest.why).toMatch(/1 request\/s/);
    expect(p.budget).toMatchObject({ restCapPerMinute: 0, brokerPerMinute: 20, share: 0.5 });
    expect(p.refused).toEqual([]);
    const wide = plan("dhan", { streamShare: 0.9, stocks: STOCKS });
    expect(by(wide, "stream", "stock")).toBe(24);
    expect(wide.capacity.stream.cap).toBe(4500);
  });

  it("Zerodha: 11 index chains by stream (1,800), the 6 nearest then 2nd expiries; 7 refused; REST off", () => {
    const p = plan("zerodha");
    expect(by(p, "stream")).toBe(11);
    expect(p.capacity.stream).toMatchObject({ cap: 1800, used: 1800 });
    expect(p.chains.map((c) => `${c.underlying}:${c.expiry}`)).toEqual([
      "NIFTY:2026-11-03",
      "BANKNIFTY:2026-11-03",
      "FINNIFTY:2026-11-03",
      "MIDCPNIFTY:2026-11-03",
      "SENSEX:2026-11-03",
      "BANKEX:2026-11-03",
      "NIFTY:2026-11-10",
      "BANKNIFTY:2026-11-10",
      "FINNIFTY:2026-11-10",
      "MIDCPNIFTY:2026-11-10",
      "SENSEX:2026-11-10",
    ]);
    expect(p.refused.filter((r) => r.reason === "capacity")).toHaveLength(7);
    expect(p.refused[0].detail).toMatch(/Feed room left: 0 legs; this chain needs 162 plus 2 futures and spot/);
    expect(p.ok).toBe(false);
    const single = plan("zerodha", { allowSingleTokenRest: true });
    expect(single.capacity.rest.allowed).toBe(true);
    expect(single.warnings.join(" ")).toMatch(/may wait up to 1 s/);
  });

  it("Upstox: 7 by stream (1,152), 11 by REST (11 calls/min of 33); 22 left → 110 stocks at 5 min", () => {
    const p = plan("upstox");
    expect(by(p, "stream")).toBe(7);
    expect(by(p, "rest")).toBe(11);
    expect(p.capacity.stream).toMatchObject({ cap: 1200, used: 1152 });
    expect(p.budget).toMatchObject({ restCallsPerMinute: 11, restCapPerMinute: 33 });
    const withStocks = plan("upstox", { stocks: Array.from({ length: 120 }, (_, i) => `S${i}`) });
    expect(by(withStocks, "rest", "stock")).toBe(110);
    expect(withStocks.refused.filter((r) => r.kind === "stock")).toHaveLength(10);
    expect(withStocks.message).toBe("This account can carry all 18 index chains (7 by stream, 11 by REST) and 110 of the 120 stocks you asked for (110 by REST). Upstox REST budget for the recorder: 33 calls/min.");
  });

  it("Fyers (no feed): 18 by REST at 18/min of 25; 7 left → 35 stocks; the daily quota is stated", () => {
    const p = plan("fyers");
    expect(by(p, "rest")).toBe(18);
    expect(p.capacity.stream.cap).toBe(0);
    expect(p.budget.restCapPerMinute).toBe(25);
    expect(p.warnings.join(" ")).toMatch(/2,500 calls a day/);
    expect(by(plan("fyers", { stocks: STOCKS }), "rest", "stock")).toBe(35);
  });

  it("demo: 1 chain by stream (NIFTY nearest), 14 by REST, BANKEX refused as not offered, 5 stocks by REST", () => {
    const c = cfg({ stocks: ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "SBIN"] });
    const available = fullAvailability(c, c.stocks);
    delete available.BANKEX;
    const policy = resolvePolicy("demo", {}, { demo: DEMO_POLICY });
    const p = planRecording({ cfg: c, account: { id: "demo-market", broker: "demo" }, policy, feedCap: feedCapFor(policy, true), available });
    expect(p.capacity.stream).toMatchObject({ cap: 300, used: 165 });
    expect(p.chains.filter((x) => x.source === "stream").map((x) => `${x.underlying}:${x.expiry}`)).toEqual(["NIFTY:2026-11-03"]);
    expect(by(p, "rest")).toBe(14);
    expect(by(p, "rest", "stock")).toBe(5);
    expect(p.chains.filter((x) => x.kind === "stock").every((x) => x.everyMinutes === 5 && x.strikesEachSide === 15)).toBe(true);
    expect(p.refused).toEqual([{ underlying: "BANKEX", expiry: null, reason: "not-offered", detail: "BANKEX is not offered by this account (no option contracts in its instrument list)." }]);
    expect(p.ok).toBe(true);
  });
});

describe("rules and payloads", () => {
  it("rule 2: a feed on another account → stream capacity 0, REST only, with a warning", () => {
    const p = plan("upstox", {}, { feedOnDataAccount: false, feedAccountId: "upstox-x" });
    expect(p.capacity.stream.cap).toBe(0);
    expect(by(p, "rest")).toBe(18);
    expect(p.warnings[0]).toBe("The live feed runs on upstox-x; the recorder's account upstox-main is used for REST only.");
  });
  it("sources can be switched off", () => {
    expect(by(plan("upstox", { sources: { stream: false } }), "stream")).toBe(0);
    const noRest = plan("upstox", { sources: { rest: false } });
    expect(by(noRest, "rest")).toBe(0);
    expect(noRest.capacity.rest.why).toBe("REST recording is switched off.");
  });
  it("priority order follows the configured index order", () => {
    const p = plan("zerodha", { indices: ["SENSEX", "NIFTY"], indexExpiries: 1 });
    expect(p.chains.map((c) => c.underlying)).toEqual(["SENSEX", "NIFTY"]);
  });
  it("CAPACITY_EXCEEDED payload lists what fits and what was refused", () => {
    const p = plan("dhan", { stocks: ["RELIANCE", "INFY"] });
    const body = capacityPayload(p);
    expect(body.canCarry.indices).toEqual(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);
    expect(body.canCarry.stocks).toEqual(["RELIANCE"]);
    expect(body.refused.map((r) => r.underlying)).toEqual(["INFY"]);
  });
  it("no account: nothing planned, a plain message", () => {
    const p = planRecording({ cfg: cfg(), account: null, policy: null, feedCap: 0, available: {} });
    expect(p).toMatchObject({ ok: false, chains: [] });
    expect(p.message).toMatch(/No connected account/);
  });
  it("a feasibility row for every default", () => {
    const r = feasibilityRow({ broker: "upstox", policy: resolvePolicy("upstox"), hasFeed: true, cfg: cfg() });
    expect(r).toMatchObject({ indexByStream: 7, indexByRest: 11, stocksByRest: 110, restPerMinute: 33 });
    expect(feasibilityRow({ broker: "dhan", policy: resolvePolicy("dhan"), hasFeed: true, cfg: cfg({ streamShare: 0.9 }) }).stocksByStream).toBe(24);
  });
});

describe("docs/guides/recorder.md", () => {
  it("the feasibility table equals the generated output (run scripts/recorder-feasibility.mjs --write)", () => {
    expect(tableInDoc()).toBe(feasibilityTable());
  });
});

describe("chains built from quotes cost their quote batches", () => {
  it("builtChainCost: ceil(legs / batch) + 1 spot read", async () => {
    const { builtChainCost } = await import("./restSource.mjs");
    expect(builtChainCost(400, 500)).toBe(2);
    expect(builtChainCost(400, 50)).toBe(9);
    expect(builtChainCost(10, undefined)).toBe(11);
  });
  it("REST capacity is charged per call: fewer chains fit, and a read wider than the per-second cap turns REST off", () => {
    const one = plan("upstox", { sources: { stream: false } });
    const three = plan("upstox", { sources: { stream: false } }, { callsPerRead: 3 });
    expect(by(three, "rest")).toBeLessThan(by(one, "rest") + 1);
    expect(three.capacity.rest.allowed).toBe(true);
    const wide = plan("upstox", { sources: { stream: false } }, { callsPerRead: 26 });
    expect(by(wide, "rest")).toBe(0);
    expect(wide.capacity.rest.why).toMatch(/too slow for chains built from quotes/);
  });
});
