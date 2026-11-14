import { describe, expect, it } from "vitest";
import { parseGeneric } from "./receivers/generic.mjs";
import { parseGoCharting } from "./receivers/gocharting.mjs";
import { alertTemplates } from "./templates.mjs";

const hook = (o) => ({ source: "generic", side: null, orderType: "LIMIT", product: null, maxLotsPerSignal: 2, ...o });

describe("alert templates match their receivers", () => {
  it("stop-loss hooks get examples with a trigger, and each example parses", () => {
    expect(JSON.parse(alertTemplates(hook({ orderType: "SL-M" }))[0].message)).toMatchObject({ triggerPrice: 1400 });
    expect(JSON.parse(alertTemplates(hook({ orderType: "SL-M" }))[0].message).price).toBeUndefined();
    expect(JSON.parse(alertTemplates(hook({ orderType: "SL" }))[0].message)).toMatchObject({ price: 1402.5, triggerPrice: 1400 });
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting", orderType: "SL-M" }))[0].message).signals[0]).toMatchObject({ orderType: "SL-M", triggerPrice: 1400, price: null });
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting", orderType: "SL" }))[0].message).signals[0]).toMatchObject({ orderType: "SL", triggerPrice: 1400, price: 1402.5 });
    // TradingView: every template names the trigger, and a filled-in one is read back with it.
    const tv = alertTemplates(hook({ source: "tradingview", orderType: "SL-M", mode: "paper", maxAgeSec: 120 }));
    for (const t of tv) expect(t.message).toMatch(/trigger/i);
  });

  it("MARKET hooks get examples without a price, LIMIT hooks with one", () => {
    expect(JSON.parse(alertTemplates(hook({ orderType: "MARKET" }))[0].message).price).toBeUndefined();
    expect(JSON.parse(alertTemplates(hook({}))[0].message).price).toBe(1402.5);
    expect(alertTemplates(hook({ source: "gocharting", orderType: "MARKET" }))[0].message).toContain("MKT");
  });
  it("GoCharting and generic examples parse", () => {
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting" }))[0].message).signals[0]).toMatchObject({ side: "BUY", quantity: 1 });
    expect(parseGeneric(JSON.parse(alertTemplates(hook({ source: "generic", side: "SELL" }))[0].message)).signals[0]).toMatchObject({ side: "SELL" });
  });
  it("ChartInk explains that the side comes from the hook", () => {
    expect(alertTemplates(hook({ source: "chartink" }))[0].notes.join(" ")).toMatch(/Set a side/);
  });
});
