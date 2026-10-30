import { describe, expect, it } from "vitest";
import { amoWhenText, checksForLaterDay, marketClosedAt, distancePct, exitChipText, pnlAt, slTriggerStart, stopOrderProblem, stopOrderText, gttFillPrice, gttLimit, gttLimitWarning, gttValidityText, kindText, legText, outcomeText, statusText, triggerBody, triggerProblem } from "./trigger-core.js";

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

describe("position stop and target", () => {
  it("P&L at an exit price: (price − average) × signed quantity", () => {
    expect(pnlAt(449, 559.65, 65)).toBeCloseTo(-7192.25, 6);
    expect(pnlAt(110, 130.25, -65)).toBeCloseTo(1316.25, 6);
    expect(pnlAt(null, 1, 1)).toBeNull();
  });
  it("the chip lists open exits on the symbol: SL, TSL when it trails, T for the target; not GTT entries or waiting brackets", () => {
    const sym = "NFO:NIFTY-2026-11-03-25800-CE";
    const t = (o) => ({ symbol: sym, reduceOnly: true, status: "active", legs: [], ...o });
    const list = [
      t({ legs: [leg({ trigger: 449 }), leg({ role: "target", op: "above", trigger: 785 })] }),
      t({ legs: [leg({ trigger: 450, trail: { points: 5 } })] }),
      t({ status: "waiting", legs: [leg({ trigger: 1 })] }),
      t({ reduceOnly: false, legs: [leg({ trigger: 2 })] }),
      t({ status: "triggered", legs: [leg({ trigger: 3 })] }),
    ];
    expect(exitChipText(list, sym)).toBe("SL 449.00 · T 785.00 · TSL 450.00");
    expect(exitChipText(list, "NFO:OTHER")).toBeNull();
  });
});

describe("stop-loss orders on the ticket", () => {
  it("starts the trigger 1 % beyond the price on the side it waits for", () => {
    expect(slTriggerStart("BUY", 250.65, 0.05)).toBe(253.2);
    expect(slTriggerStart("SELL", 580.2, 0.05)).toBe(574.35);
    expect(slTriggerStart("BUY", null)).toBeNull();
  });
  it("checks the trigger side and the SL limit in plain words", () => {
    expect(stopOrderProblem({ side: "BUY", orderType: "LIMIT" })).toBeNull();
    expect(stopOrderProblem({ side: "BUY", orderType: "SL-M", trigger: null, ltp: 100 })?.field).toBe("trigger");
    expect(stopOrderProblem({ side: "BUY", orderType: "SL-M", trigger: 99, ltp: 100 })?.message).toBe("A stop-loss buy triggers above the price now (100.00). For a buy below it, use a limit order.");
    expect(stopOrderProblem({ side: "SELL", orderType: "SL", trigger: 101, price: 100, ltp: 100 })?.field).toBe("trigger");
    expect(stopOrderProblem({ side: "SELL", orderType: "SL", trigger: 98, price: 99, ltp: 100 })?.message).toBe("For a stop-loss sell the limit is at or below the trigger.");
    expect(stopOrderProblem({ side: "BUY", orderType: "SL", trigger: 102, price: 101, ltp: 100 })?.message).toBe("For a stop-loss buy the limit is at or above the trigger.");
    expect(stopOrderProblem({ side: "BUY", orderType: "SL", trigger: 102, ltp: 100 })?.field).toBe("price");
    expect(stopOrderProblem({ side: "BUY", orderType: "SL", trigger: 102, price: 102.5, ltp: 100 })).toBeNull();
  });
  it("says what the order does", () => {
    expect(stopOrderText({ side: "BUY", orderType: "SL-M", trigger: 253.2 })).toBe("Sends a market buy when LTP rises to 253.20. Rests at the exchange until then.");
    expect(stopOrderText({ side: "SELL", orderType: "SL", trigger: 575.05, price: 572.15 })).toBe("Sends a limit sell at 572.15 when LTP falls to 575.05. Rests at the exchange until then.");
  });
});

describe("after-market orders in words", () => {
  const amo = { origin: "amo", type: "single", status: "active", held: "bridge", openAt: "2026-11-02T09:15:00.000+05:30", legs: [{ op: "open", trigger: null, role: "entry", order: { side: "BUY", quantity: 65, orderType: "LIMIT", price: 121 } }] };
  it("names it, says when it goes and that this Bridge must be running", () => {
    expect(kindText(amo)).toBe("After-market order");
    expect(statusText(amo)).toEqual({ text: "Queued for the open", tone: "info" });
    expect(legText(amo.legs[0], 65)).toBe("Buy 1 lot at 121.00 at the open");
    expect(amoWhenText(amo)).toBe("Goes at 09:15 on Mon 2 Nov · Held on this Bridge: it must be running at 09:15 IST");
    expect(amoWhenText({ ...amo, held: "broker" })).toMatch(/Queued at your broker$/);
  });
  it("builds the body and checks the limit", () => {
    const f = { account: "p", symbol: "NFO:X", product: "MARGIN", side: "BUY", units: 65, origin: "amo", orderType: "LIMIT", price: 121 };
    expect(triggerBody(f)).toEqual({ account: "p", symbol: "NFO:X", product: "MARGIN", origin: "amo", type: "single", legs: [{ role: "entry", order: { side: "BUY", quantity: 65, orderType: "LIMIT", price: 121 } }] });
    expect(triggerProblem(f)).toBeNull();
    expect(triggerProblem({ ...f, price: null })?.field).toBe("price");
  });
  it("knows when the market is closed (weekends, before 09:15, from 15:30 IST)", () => {
    const at = (iso) => marketClosedAt(Date.parse(iso));
    expect(at("2026-10-30T09:14:00+05:30")).toBe(true);
    expect(at("2026-10-30T09:15:00+05:30")).toBe(false);
    expect(at("2026-10-30T15:29:00+05:30")).toBe(false);
    expect(at("2026-10-30T15:30:00+05:30")).toBe(true);
    expect(at("2026-10-31T11:00:00+05:30")).toBe(true); // Saturday
  });
});

describe("checks for an order sent on a later day", () => {
  it("drops today's daily counters and keeps per-order limits, the kill switch and live gates", () => {
    const checks = [
      { code: "DAILY_LIMIT_REACHED", severity: "block", message: "Account demo-paper has a paper loss of ₹31,651.5 today" },
      { code: "INVALID_ORDER", severity: "block", message: "12 lots is above the per-order limit of 10 lots." },
      { code: "KILL_SWITCH_ACTIVE", severity: "block", message: "The kill switch is on." },
      { code: "PAPER_ONLY", severity: "block", message: "Live trading is off" },
    ];
    expect(checksForLaterDay(checks).map((c) => c.code)).toEqual(["INVALID_ORDER", "KILL_SWITCH_ACTIVE", "PAPER_ONLY"]);
    expect(checksForLaterDay(null)).toEqual([]);
  });
});
