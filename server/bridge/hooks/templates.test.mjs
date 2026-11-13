import { describe, expect, it } from "vitest";
import { parseGeneric } from "./receivers/generic.mjs";
import { parseGoCharting } from "./receivers/gocharting.mjs";
import { parseTradingView } from "./receivers/tradingview.mjs";
import { alertTemplates } from "./templates.mjs";

const hook = (o) => ({ source: "generic", side: null, orderType: "LIMIT", product: null, maxLotsPerSignal: 2, ...o });

describe("alert templates match their receivers", () => {
  it("stop-loss hooks get examples with a trigger, and each example parses", () => {
    expect(JSON.parse(alertTemplates(hook({ orderType: "SL-M" }))[0].message)).toMatchObject({ triggerPrice: 1400 });
    expect(JSON.parse(alertTemplates(hook({ orderType: "SL-M" }))[0].message).price).toBeUndefined();
    expect(JSON.parse(alertTemplates(hook({ orderType: "SL" }))[0].message)).toMatchObject({ price: 1402.5, triggerPrice: 1400 });
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting", orderType: "SL-M" }))[0].message).signals[0]).toMatchObject({ orderType: "SL-M", triggerPrice: 1400, price: null });
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting", orderType: "SL" }))[0].message).signals[0]).toMatchObject({ orderType: "SL", triggerPrice: 1400, price: 1402.5 });
    for (const t of alertTemplates(hook({ source: "tradingview", orderType: "SL" }))) expect(JSON.parse(t.message).triggerPrice).toBeTruthy();
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
  it("TradingView: both templates parse once TradingView has filled the placeholders in", () => {
    const fill = (m) => JSON.parse(m.replace("{{exchange}}", "NSE").replace("{{ticker}}", "RELIANCE").replace("{{strategy.order.action}}", "buy").replace("{{strategy.order.contracts}}", "5").replace(/\{\{(strategy\.order\.price|close)\}\}/, "1402.5").replace("{{strategy.order.id}}", "Long").replace("{{timenow}}", "2026-10-19T04:00:00Z"));
    const [strategy, indicator] = alertTemplates(hook({ source: "tradingview" }));
    expect(parseTradingView(fill(strategy.message))).toMatchObject({ basis: "tv|Long|2026-10-19T04:00:00Z", signals: [{ symbol: "NSE:RELIANCE", side: "BUY", quantity: 5, price: 1402.5, product: "INTRADAY" }] });
    expect(parseTradingView(fill(indicator.message)).signals[0]).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, price: 1402.5 });
    // Sent as it stands (placeholders unfilled) it is refused, never guessed.
    expect(() => parseTradingView(JSON.parse(strategy.message))).toThrow();
    const market = alertTemplates(hook({ source: "tradingview", orderType: "MARKET", side: "SELL", product: "CNC" }))[0];
    expect(JSON.parse(market.message)).toEqual({ symbol: "{{exchange}}:{{ticker}}", side: "SELL", quantity: "{{strategy.order.contracts}}", id: "{{strategy.order.id}}", time: "{{timenow}}" });
  });
  it("ChartInk explains that the side comes from the hook", () => {
    expect(alertTemplates(hook({ source: "chartink" }))[0].notes.join(" ")).toMatch(/Set a side/);
  });
});
