import { describe, expect, it } from "vitest";
import { parseGeneric } from "./receivers/generic.mjs";
import { parseGoCharting } from "./receivers/gocharting.mjs";
import { parseTradingView } from "./receivers/tradingview.mjs";
import { alertTemplates } from "./templates.mjs";

const hook = (o) => ({ source: "tradingview", side: null, orderType: "LIMIT", product: null, maxLotsPerSignal: 2, ...o });

/** What TradingView would send once it fills the placeholders. */
const fill = (msg) =>
  msg
    .replace("{{exchange}}", "NSE")
    .replace("{{ticker}}", "RELIANCE")
    .replace("{{strategy.order.action}}", "buy")
    .replace("{{strategy.order.contracts}}", "1")
    .replace("{{strategy.order.id}}", "Long")
    .replace("{{timenow}}", "2026-10-19T04:00:00Z")
    .replace("{{close}}", "1402.5");

describe("alert templates match their receivers", () => {
  it("TradingView strategy and indicator templates parse once filled, and refuse while unfilled", () => {
    const [strategy, indicator] = alertTemplates(hook({}));
    const s = parseTradingView(JSON.parse(fill(strategy.message)));
    expect(s.signals[0]).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, price: 1402.5 });
    expect(s.basis).toBe("tv|Long|2026-10-19T04:00:00Z");
    expect(parseTradingView(JSON.parse(fill(indicator.message))).signals[0]).toMatchObject({ lots: 1, price: 1402.5 });
    expect(() => parseTradingView(JSON.parse(strategy.message))).toThrow();
  });
  it("MARKET hooks get templates without a price", () => {
    const [strategy] = alertTemplates(hook({ orderType: "MARKET" }));
    expect(strategy.message).not.toContain("{{close}}");
  });
  it("GoCharting and generic examples parse", () => {
    expect(parseGoCharting(alertTemplates(hook({ source: "gocharting" }))[0].message).signals[0]).toMatchObject({ side: "BUY", quantity: 1 });
    expect(parseGeneric(JSON.parse(alertTemplates(hook({ source: "generic", side: "SELL" }))[0].message)).signals[0]).toMatchObject({ side: "SELL" });
  });
  it("ChartInk explains that the side comes from the hook", () => {
    expect(alertTemplates(hook({ source: "chartink" }))[0].notes.join(" ")).toMatch(/Set a side/);
  });
});
