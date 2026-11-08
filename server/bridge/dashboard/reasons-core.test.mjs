import { describe, expect, it } from "vitest";
import { whatToDo } from "./reasons-core.js";

// The Bridge's own words (safety/safetyGuard.mjs, paper/paperEngine.mjs, orders/), each with the next step a trader reads.
describe("what to do about a refusal", () => {
  const cases = [
    ["KILL_SWITCH_ACTIVE", "The kill switch is on (test). No orders are being sent", /release it on the Safety page/],
    ["DAILY_LIMIT_REACHED", "Account demo-paper has placed 100 paper orders today, the daily limit (100).", /resets at midnight IST/],
    ["INVALID_ORDER", "12 lots is above the per-order limit of 10 lots.", /split it into several smaller orders/],
    ["INVALID_ORDER", "The order value ₹62,660 is above the per-order limit of ₹60,000.", /fewer lots/],
    ["INVALID_ORDER", "The price 568 is 4.05% away from the last traded price 591.95; the limit is 3%.", /nearer the last price/],
    ["MARKET_CLOSED", "The NFO market is not open for orders now (closed).", /when the market opens/],
    ["ORDER_RATE_LIMITED", "Account x is at its order rate cap of 5 per second. Try again in 120 ms.", /Wait a second/],
    ["PAPER_ONLY", "Live trading is off for the Bridge (safety.liveTrading in bridge.config.json). The order was not sent.", /safety\.liveTrading/],
    [null, "Insufficient paper funds: this order needs about ₹1,63,000 and ₹20,000 is available.", /add a hedge/],
    [null, "The trigger price for a stop-loss sell must be below the last traded price (100).", /past the trigger/],
    [null, "Intraday orders are not accepted after the 15:20 IST square-off.", /Carry \(NRML\)/],
    ["OUTCOME_UNKNOWN", "The broker did not confirm order ord_1.", /Do not send it again/],
    ["CANNOT_TRADE", "dhan-main cannot trade now.", /Log in to the broker/],
  ];
  for (const [code, message, fix] of cases) it(`${code ?? "rejected"}: ${message.slice(0, 40)}`, () => expect(whatToDo({ code, message })).toMatch(fix));

  it("daily loss and the kill switch: a paper account is never sent to a broker; a live one is", () => {
    const paper = "Account demo-paper has a paper loss of ₹31,651.5 today, at or above the daily limit of ₹10,000. New orders resume tomorrow.";
    const live = "Account dhan-main has a live loss of ₹12,000 today, at or above the daily limit of ₹10,000. New orders resume tomorrow.";
    expect(whatToDo({ code: "DAILY_LIMIT_REACHED", message: paper })).toBe("Paper orders resume tomorrow (IST). Raise or reset the paper limit on the Safety page.");
    expect(whatToDo({ code: "DAILY_LIMIT_REACHED", message: paper, mode: "paper" })).not.toMatch(/broker/);
    expect(whatToDo({ code: "DAILY_LIMIT_REACHED", message: live })).toMatch(/close in your broker's app/);
    expect(whatToDo({ code: "DAILY_LIMIT_REACHED", message: paper, mode: "live" })).toMatch(/broker's app/);
    for (const m of ["paper", "live"]) expect(whatToDo({ code: "DAILY_LIMIT_REACHED", message: m === "paper" ? paper : live, mode: m })).not.toMatch(/Positions/);
    expect(whatToDo({ code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on.", mode: "paper" })).toBe("Find out why it is on, then release it on the Safety page.");
    expect(whatToDo({ code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on.", mode: "live" })).toMatch(/Your broker's app can still close positions/);
  });

  it("adds nothing when there is nothing useful to add, and reads plain strings", () => {
    expect(whatToDo({ code: "INVALID_ORDER", message: "Expired at the end of the trading session." })).toBeNull();
    expect(whatToDo(null)).toBeNull();
    expect(whatToDo("Insufficient paper funds: needs more")).toMatch(/reset paper funds/);
  });
});
