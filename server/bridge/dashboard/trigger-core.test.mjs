import { describe, expect, it } from "vitest";
import { distancePct, gttFillPrice, gttLimit, gttLimitWarning, gttValidityText, kindText, legText, outcomeText, statusText, triggerBody, triggerProblem } from "./trigger-core.js";

const leg = (o) => ({ op: "below", trigger: 98.5, role: "stop", trail: null, order: { side: "SELL", quantity: 130, orderType: "MARKET" }, ...o });

describe("trigger words", () => {
  it("names each kind as brokers do", () => {
    expect(kindText({ origin: "gtt", type: "single", legs: [leg({ role: "entry" })] })).toBe("GTT");
    expect(kindText({ origin: "gtt", type: "oco", legs: [leg(), leg()] })).toBe("GTT OCO");
    expect(kindText({ origin: "position", type: "oco", legs: [leg({ trail: { points: 5 } }), leg({ role: "target" })] })).toBe("Trailing stop and target");
    expect(kindText({ origin: "position", type: "single", legs: [leg({ trail: { points: 5 } })] })).toBe("Trailing stop");
    expect(kindText({ origin: "bracket", type: "oco", legs: [leg(), leg()] })).toBe("Stop and target (on entry)");
  });

  it("says a leg in lots, with the true symbols and fixed decimals", () => {
    expect(legText(leg(), 65)).toBe("Sell 2 lots at market when LTP ≤ 98.50");
    expect(legText(leg({ op: "above", order: { side: "BUY", quantity: 65, orderType: "LIMIT", price: 101 }, trail: { points: 5 } }), 65)).toBe("Buy 1 lot at 101.00 when LTP ≥ 98.50 · trails 5.00");
    expect(legText(leg({ order: { side: "SELL", quantity: 10 } }), 65)).toBe("Sell 10 qty at market when LTP ≤ 98.50");
  });

  it("status and outcome in plain words", () => {
    expect(statusText({ status: "waiting" }).text).toBe("Waits for the entry to fill");
    expect(statusText({ status: "triggered", result: { status: "rejected" } })).toEqual({ text: "Triggered · order rejected", tone: "bad" });
    expect(outcomeText({ status: "triggered", lotSize: 65, fireLtp: 97.2, result: { status: "filled", quantity: 130 } })).toBe("Order filled · 2 lots · LTP was 97.20");
    expect(outcomeText({ status: "failed", result: { message: "The kill switch is on." } })).toBe("The kill switch is on.");
    expect(distancePct(leg(), 100)).toBeCloseTo(1.5, 6);
  });
});

describe("GTT limit, validity and expected fill", () => {
  it("defaults the limit to the trigger plus 0.5 % for a buy, minus for a sell, on the tick away from the trigger", () => {
    expect(gttLimit(586.7, "BUY", 0.05)).toBe(589.65); // 589.6335 up to the tick
    expect(gttLimit(586.7, "SELL", 0.05)).toBe(583.75); // 583.7665 down to the tick
    expect(gttLimit(586.7, "BUY", 0.05, 0)).toBe(586.7);
    expect(gttLimit(null, "BUY")).toBeNull();
  });
  it("warns when a typed limit is on the wrong side of the trigger", () => {
    expect(gttLimitWarning("BUY", 586.7, 575.65)).toMatch(/^A buy limit of 575\.65 is under the trigger 586\.70: when it fires the order may rest unfilled/);
    expect(gttLimitWarning("SELL", 100, 101)).toMatch(/sell limit of 101\.00 is over the trigger 100\.00/);
    expect(gttLimitWarning("BUY", 586.7, 586.7)).toBeNull();
    expect(gttLimitWarning("SELL", 100, 99)).toBeNull();
  });
  it("says how long it lasts by product: intraday ends at today's square-off", () => {
    expect(gttValidityText("INTRADAY")).toBe("Intraday: good till 15:20 today, then cancelled.");
    expect(gttValidityText("MARGIN")).toBe("Good till the contract expires.");
  });
  it("prices You pay, max loss and breakeven at the expected fill: the limit, or the trigger for market", () => {
    expect(gttFillPrice({ orderType: "LIMIT", price: 589.65, trigger: 586.7 })).toBe(589.65);
    expect(gttFillPrice({ orderType: "MARKET", price: undefined, trigger: 586.7 })).toBe(586.7);
  });
});

describe("trigger bodies and checks", () => {
  const base = { account: "demo-paper", symbol: "NFO:NIFTY-2026-11-03-26000-CE", product: "MARGIN", side: "SELL", units: 65, ltp: 100 };
  it("a GTT is one entry leg", () => {
    expect(triggerBody({ ...base, side: "BUY", origin: "gtt", entry: 110, orderType: "MARKET" })).toEqual({ account: "demo-paper", symbol: base.symbol, product: "MARGIN", origin: "gtt", type: "single", legs: [{ trigger: 110, role: "entry", order: { side: "BUY", quantity: 65, orderType: "MARKET" } }] });
  });
  it("an exit with stop and target is an OCO on the right sides; a trail rides on the stop", () => {
    const b = triggerBody({ ...base, origin: "position", stop: 90, target: 120, trail: 5, orderType: "MARKET", mode: "live" });
    expect(b).toMatchObject({ type: "oco", mode: "live", origin: "position" });
    expect(b.legs).toEqual([
      { trigger: 90, op: "below", role: "stop", trail: { points: 5 }, order: { side: "SELL", quantity: 65, orderType: "MARKET" } },
      { trigger: 120, op: "above", role: "target", order: { side: "SELL", quantity: 65, orderType: "MARKET" } },
    ]);
    const short = triggerBody({ ...base, side: "BUY", origin: "position", stop: 110 });
    expect(short).toMatchObject({ type: "single", legs: [{ op: "above", role: "stop" }] });
  });
  it("checks the fields in plain words", () => {
    expect(triggerProblem({ ...base, origin: "gtt" })?.message).toBe("Enter the trigger price.");
    expect(triggerProblem({ ...base, origin: "gtt", entry: 100 })?.message).toMatch(/price now/);
    expect(triggerProblem({ ...base, origin: "position" })?.message).toBe("Enter a stop, a target or both.");
    expect(triggerProblem({ ...base, origin: "position", stop: 105 })?.message).toBe("A stop for a long goes below 100.00.");
    expect(triggerProblem({ ...base, origin: "position", target: 95 })?.message).toBe("A target for a long goes above 100.00.");
    expect(triggerProblem({ ...base, side: "BUY", origin: "position", stop: 95 })?.message).toBe("A stop for a short goes above 100.00.");
    expect(triggerProblem({ ...base, origin: "position", stop: 90, target: 120 })).toBeNull();
    expect(triggerProblem({ ...base, origin: "gtt", entry: 110, orderType: "LIMIT" })?.field).toBe("price");
  });
});
