import { describe, expect, it } from "vitest";
import { MAX_SIGNALS_PER_ALERT, signalFromObject, signalFromText, toNumber, toOrderType, toProduct, toSide } from "./common.mjs";
import { parseChartInk } from "./chartink.mjs";
import { parseGeneric } from "./generic.mjs";
import { parseGoCharting } from "./gocharting.mjs";
import { TRADINGVIEW_WEBHOOK_IPS, parseTradingView } from "./tradingview.mjs";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

describe("common field parsing", () => {
  it("accepts numbers and numeric strings, refuses junk", () => {
    expect(toNumber("12.5", "p")).toBe(12.5);
    expect(toNumber(3, "q", { integer: true })).toBe(3);
    expect(toNumber(undefined, "q")).toBeNull();
    expect(code(() => toNumber("1e3", "p"))).toBe("VALIDATION_FAILED");
    expect(code(() => toNumber("-1", "p"))).toBe("VALIDATION_FAILED");
    expect(code(() => toNumber(0, "p"))).toBe("VALIDATION_FAILED");
    expect(code(() => toNumber("2.5", "q", { integer: true }))).toBe("VALIDATION_FAILED");
  });
  it("normalises side, order type and product spellings", () => {
    expect(toSide("buy")).toBe("BUY");
    expect(toSide("Sell")).toBe("SELL");
    expect(code(() => toSide("long"))).toBe("VALIDATION_FAILED");
    expect(toOrderType("mkt")).toBe("MARKET");
    expect(toOrderType("limit")).toBe("LIMIT");
    expect(toOrderType("SL")).toBe("SL");
    expect(toOrderType("slm")).toBe("SL-M");
    expect(toOrderType("sl-m")).toBe("SL-M");
    expect(code(() => toOrderType("BRACKET"))).toBe("VALIDATION_FAILED");
    expect(toProduct("MIS")).toBe("INTRADAY");
    expect(toProduct("nrml")).toBe("MARGIN");
    expect(toProduct("cnc")).toBe("CNC");
  });
  it("builds a signal from common JSON spellings, joining exchange and ticker", () => {
    const s = signalFromObject({ ticker: "RELIANCE", exchange: "NSE", action: "buy", qty: "10", limit_price: "1402.5", product: "MIS", order_id: "L1", timenow: "t" });
    expect(s).toEqual({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, lots: null, price: 1402.5, triggerPrice: null, orderType: null, product: "INTRADAY", ref: "L1", time: "t" });
    expect(code(() => signalFromObject({ symbol: "NSE:X", quantity: 1, lots: 1 }))).toBe("VALIDATION_FAILED");
    expect(code(() => signalFromObject({ side: "buy" }))).toBe("VALIDATION_FAILED");
  });
});

describe("text alert grammar", () => {
  it("reads positional alerts", () => {
    expect(signalFromText("BUY NSE:RELIANCE 10 @ 1402.5")).toMatchObject({ side: "BUY", symbol: "NSE:RELIANCE", quantity: 10, price: 1402.5 });
    expect(signalFromText("sell NFO:NIFTY-2026-10-27-25000-CE 2 lots MKT INTRADAY")).toMatchObject({ side: "SELL", lots: 2, orderType: "MARKET", product: "INTRADAY" });
    expect(signalFromText("SELL NSE:RELIANCE 10 SL-M trigger=1390")).toMatchObject({ side: "SELL", quantity: 10, orderType: "SL-M", triggerPrice: 1390, price: null });
    expect(signalFromText("SELL NSE:RELIANCE 10 @ 1388 SL trigger=1390")).toMatchObject({ orderType: "SL", price: 1388, triggerPrice: 1390 });
    expect(signalFromObject({ symbol: "NSE:INFY", side: "sell", qty: 1, order_type: "SLM", trigger_price: "1490.5" })).toMatchObject({ orderType: "SL-M", triggerPrice: 1490.5 });
    expect(signalFromText("BUY NSE:M&M 5 @1500")).toMatchObject({ symbol: "NSE:M&M", quantity: 5, price: 1500 });
  });
  it("reads key=value alerts, mixed with positional words", () => {
    expect(signalFromText("side=buy symbol=NSE:INFY qty=3 price=1500 id=abc time=2026-10-19T04:00:00Z")).toMatchObject({ side: "BUY", symbol: "NSE:INFY", quantity: 3, price: 1500, ref: "abc", time: "2026-10-19T04:00:00Z" });
    expect(signalFromText("BUY, NSE:INFY; qty=3")).toMatchObject({ side: "BUY", quantity: 3 });
  });
  it("refuses anything it does not understand instead of guessing", () => {
    expect(code(() => signalFromText("BUY NSE:RELIANCE now please"))).toBe("VALIDATION_FAILED");
    expect(code(() => signalFromText("BUY SELL NSE:RELIANCE"))).toBe("VALIDATION_FAILED");
    expect(code(() => signalFromText("BUY NSE:RELIANCE 1 2 3"))).toBe("VALIDATION_FAILED");
    expect(code(() => signalFromText("colour=red BUY NSE:RELIANCE"))).toBe("VALIDATION_FAILED");
    expect(code(() => signalFromText("   "))).toBe("VALIDATION_FAILED");
    expect(code(() => signalFromText("x".repeat(2001)))).toBe("VALIDATION_FAILED");
  });
});

describe("ChartInk", () => {
  const body = { stocks: "SEPOWER,ASTEC,M&M", trigger_prices: "3.75,541.8,2900", triggered_at: "2:34 pm", scan_name: "Short term breakouts", scan_url: "short-term-breakouts", alert_name: "Alert" };
  it("splits comma-joined lists into NSE signals with trigger prices", () => {
    const a = parseChartInk(body, { istDate: "2026-10-19" });
    expect(a.signals.map((s) => [s.symbol, s.price])).toEqual([
      ["NSE:SEPOWER", 3.75],
      ["NSE:ASTEC", 541.8],
      ["NSE:M&M", 2900],
    ]);
    expect(a.signals.every((s) => s.side === null)).toBe(true);
  });
  it("stamps the dateless time with the IST date", () => {
    const d1 = parseChartInk(body, { istDate: "2026-10-19" }).basis;
    const d2 = parseChartInk(body, { istDate: "2026-10-20" }).basis;
    expect(d1).toContain("2026-10-19");
    expect(d1).not.toBe(d2);
  });
  it("caps the number of signals and reports the rest as dropped", () => {
    const many = Array.from({ length: MAX_SIGNALS_PER_ALERT + 5 }, (_, i) => `S${i}`);
    const a = parseChartInk({ stocks: many.join(","), triggered_at: "3:00 pm" }, { istDate: "2026-10-19" });
    expect(a.signals).toHaveLength(MAX_SIGNALS_PER_ALERT);
    expect(a.dropped).toBe(5);
  });
  it("refuses mismatched lists and bad symbols", () => {
    expect(code(() => parseChartInk({ stocks: "A,B", trigger_prices: "1" }, { istDate: "2026-10-19" }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseChartInk({ stocks: "A B" }, { istDate: "2026-10-19" }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseChartInk({}, { istDate: "2026-10-19" }))).toBe("VALIDATION_FAILED");
  });
});

describe("GoCharting", () => {
  it("parses text, and JSON when the user wrote JSON", () => {
    expect(parseGoCharting("SELL NSE:INFY 2 @ 1500").signals[0]).toMatchObject({ side: "SELL", quantity: 2, price: 1500 });
    expect(parseGoCharting({ symbol: "NSE:INFY", side: "buy" }).signals[0].side).toBe("BUY");
    expect(code(() => parseGoCharting(null))).toBe("VALIDATION_FAILED");
  });
  it("uses id + time as the alert identity when the message carries both", () => {
    const a = parseGoCharting({ symbol: "NSE:RELIANCE", side: "buy", quantity: "1", price: "1400", id: "Long", time: "2026-10-19T04:00:00Z" });
    expect(a.basis).toBe("gc|Long|2026-10-19T04:00:00Z");
    expect(a.signals).toHaveLength(1);
    expect(parseGoCharting({ symbol: "NSE:RELIANCE", side: "buy", id: "Long" }).basis).toBeNull();
  });
  it("refuses unfilled placeholders, in JSON and in text", () => {
    expect(code(() => parseGoCharting({ symbol: "NSE:RELIANCE", side: "{{side}}" }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseGoCharting("{{side}} NSE:RELIANCE 1"))).toBe("VALIDATION_FAILED");
  });
  it("refuses arrays and other shapes", () => {
    expect(code(() => parseGoCharting([1, 2]))).toBe("VALIDATION_FAILED");
    expect(code(() => parseGoCharting(42))).toBe("VALIDATION_FAILED");
  });
});

describe("generic", () => {
  it("parses one signal or a batch with ids", () => {
    expect(parseGeneric({ symbol: "NSE:INFY", side: "BUY", quantity: 1, id: "s1" }).basis).toBe("gen|s1");
    const b = parseGeneric({ id: "batch-1", signals: [{ symbol: "NSE:INFY", side: "BUY", quantity: 1 }, { symbol: "NSE:RELIANCE", side: "SELL", lots: 1 }] });
    expect(b.signals).toHaveLength(2);
    expect(b.basis).toBe("gen|batch|batch-1");
    expect(parseGeneric({ signals: [{ symbol: "NSE:INFY", side: "BUY", id: "a" }, { symbol: "NSE:TCS", side: "BUY", id: "b" }] }).basis).toBe("gen|ids|a|b");
  });
  it("refuses oversize batches and bad shapes", () => {
    const sig = { symbol: "NSE:INFY", side: "BUY", quantity: 1 };
    expect(code(() => parseGeneric({ signals: Array(MAX_SIGNALS_PER_ALERT + 1).fill(sig) }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseGeneric({ signals: [] }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseGeneric("BUY NSE:INFY 1"))).toBe("VALIDATION_FAILED");
  });
});

describe("TradingView", () => {
  it("reads a filled-in strategy alert: exchange and ticker joined, numbers sent as text", () => {
    const a = parseTradingView({ symbol: "NSE:RELIANCE", side: "buy", quantity: "10", price: "1402.5", id: "Long", time: "2026-10-19T04:00:00Z" });
    expect(a.signals).toEqual([{ symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, lots: null, price: 1402.5, triggerPrice: null, orderType: null, product: null, ref: "Long", time: "2026-10-19T04:00:00Z" }]);
    expect(a.basis).toBe("tv|Long|2026-10-19T04:00:00Z");
    expect(parseTradingView({ ticker: "INFY", exchange: "NSE", action: "sell", contracts: 2 }).signals[0]).toMatchObject({ symbol: "NSE:INFY", side: "SELL", quantity: 2 });
  });
  it("reads a plain-text message, and identifies an alert with no id by its bytes", () => {
    expect(parseTradingView("SELL NSE:INFY 2 @ 1500").signals[0]).toMatchObject({ side: "SELL", quantity: 2, price: 1500 });
    expect(parseTradingView({ symbol: "NSE:RELIANCE", side: "buy", quantity: 1 }).basis).toBeNull();
  });
  it("refuses a placeholder TradingView did not fill, and anything that is not an object or text", () => {
    expect(code(() => parseTradingView({ symbol: "{{exchange}}:{{ticker}}", side: "buy" }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseTradingView("{{strategy.order.action}} NSE:RELIANCE 1"))).toBe("VALIDATION_FAILED");
    expect(code(() => parseTradingView({ symbol: "NSE:RELIANCE", side: "long" }))).toBe("VALIDATION_FAILED");
    expect(code(() => parseTradingView([1]))).toBe("VALIDATION_FAILED");
    expect(code(() => parseTradingView(null))).toBe("VALIDATION_FAILED");
  });
  it("lists the sender's addresses as plain IPv4", () => {
    expect(TRADINGVIEW_WEBHOOK_IPS.length).toBeGreaterThan(0);
    for (const ip of TRADINGVIEW_WEBHOOK_IPS) expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });
});
