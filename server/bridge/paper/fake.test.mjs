/**
 * The published fake PaperEngine (fake.mjs) used by other streams' tests: contract shape, call recording, price
 * helpers, instrument helpers and account restriction. No disk, no timers.
 */
import { describe, expect, it } from "vitest";
import { SERVICE_CONTRACTS } from "../core/contracts.mjs";
import { createFakePaperEngine } from "./fake.mjs";

const clock = { t: Date.parse("2026-10-19T10:00:00+05:30"), now() { return this.t; } };

describe("createFakePaperEngine", () => {
  it("satisfies the contract and records contract calls", async () => {
    const paper = createFakePaperEngine({ prices: { "NSE:RELIANCE": 1400 }, clock });
    for (const m of SERVICE_CONTRACTS.paper.methods) expect(typeof paper[m]).toBe("function");
    const o = await paper.place("acc-1", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" });
    expect(o).toMatchObject({ status: "filled", avgPrice: 1400.7, mode: "paper" });
    expect(paper.calls[0]).toEqual(["place", "acc-1", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" }]);
  });

  it("setPrice evaluates pending orders like a tick and emits order.updated", async () => {
    const paper = createFakePaperEngine({ prices: { "NSE:RELIANCE": 1400 }, clock });
    const events = [];
    paper.bus.on("order.updated", (e) => events.push(e.status));
    const o = await paper.place("acc-1", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1390 });
    paper.setPrice("NSE:RELIANCE", 1389);
    expect((await paper.order("acc-1", o.orderId)).status).toBe("filled");
    expect(events).toEqual(["open", "filled"]);
  });

  it("rejects MARKET orders without a price and lets LIMIT orders wait", async () => {
    const paper = createFakePaperEngine({ clock });
    expect((await paper.place("acc-1", { symbol: "NSE:INFY", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" })).status).toBe("rejected");
    expect((await paper.place("acc-1", { symbol: "NSE:INFY", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1500 })).status).toBe("open");
  });

  it("uses registered lot sizes and restricts account ids when asked", async () => {
    const paper = createFakePaperEngine({ prices: { "NFO:NIFTY-2026-10-27-25000-CE": 120 }, clock, accounts: ["paper-1"] });
    paper.setInstrument("NFO:NIFTY-2026-10-27-25000-CE", { lotSize: 65, tickSize: 0.05, strike: 25000 });
    await expect(paper.place("paper-1", { symbol: "NFO:NIFTY-2026-10-27-25000-CE", side: "BUY", quantity: 10, product: "MARGIN", orderType: "MARKET" })).rejects.toMatchObject({ code: "INVALID_ORDER" });
    expect((await paper.place("paper-1", { symbol: "NFO:NIFTY-2026-10-27-25000-CE", side: "BUY", lots: 1, product: "MARGIN", orderType: "MARKET" })).quantity).toBe(65);
    await expect(paper.funds("other")).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("keeps state in memory only and accepts config overrides", async () => {
    const paper = createFakePaperEngine({ prices: { "NSE:RELIANCE": 1000 }, clock, paper: { startingCapital: 50_000, slippageBps: 0 } });
    expect((await paper.funds("acc-1")).availableCash).toBe(50_000);
    await paper.place("acc-1", { symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "MARKET" });
    expect((await paper.positions("acc-1"))[0]).toMatchObject({ netQty: 10, avgPrice: 1000 });
    expect([...paper.store.files.keys()]).toEqual(["acc-1"]);
  });
});
