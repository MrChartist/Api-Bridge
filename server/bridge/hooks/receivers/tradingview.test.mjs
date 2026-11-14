import { describe, expect, it } from "vitest";
import { extractPassphrase, isDatedCanonical, parseAlertTime, parseTradingView, tryAlertTime } from "./tradingview.mjs";

const T = "2026-11-09T09:56:00Z";
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return `${e.code}: ${e.detail}`;
  }
  return null;
};
const base = { symbol: "NSE:RELIANCE", side: "buy", lots: 1, orderType: "limit", price: 1402.5, product: "MIS", id: "a1", time: T };

describe("TradingView alert: JSON message", () => {
  it("reads our schema", () => {
    const a = parseTradingView({ ...base, mode: "paper", account: "paper", passphrase: "x" });
    expect(a.signals).toHaveLength(1);
    expect(a.signals[0]).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", lots: 1, orderType: "LIMIT", price: 1402.5, product: "INTRADAY", ref: "a1", time: T, mode: "paper", account: "paper", symbolFrom: "chart", timeMs: Date.parse(T) });
  });

  it("reads a strategy alert as TradingView fills it in (strings where a placeholder was quoted)", () => {
    const a = parseTradingView({ symbol: "NSE:NIFTY1!", side: "sell", lots: "2", orderType: "limit", price: "25010.5", marketPosition: "short", positionSize: "2", id: "Short", time: T });
    expect(a.signals[0]).toMatchObject({ symbol: "NSE:NIFTY1!", side: "SELL", lots: 2, price: 25010.5, marketPosition: "short", positionSize: 2 });
  });

  it("reads a stop-loss alert: the trigger price in JSON and as trigger= in text", () => {
    expect(parseTradingView({ symbol: "NSE:RELIANCE", side: "sell", lots: 1, orderType: "sl-m", triggerPrice: "1390", id: "sl", time: T }).signals[0]).toMatchObject({ orderType: "SL-M", triggerPrice: 1390, price: null });
    expect(parseTradingView({ symbol: "NSE:RELIANCE", side: "sell", lots: 1, orderType: "sl", price: 1388, triggerPrice: 1390, id: "sl", time: T }).signals[0]).toMatchObject({ orderType: "SL", price: 1388, triggerPrice: 1390 });
    expect(parseTradingView(`SELL NSE:RELIANCE 1 SL-M trigger=1390 MIS id=sl time=${T}`).signals[0]).toMatchObject({ orderType: "SL-M", triggerPrice: 1390 });
  });

  it("accepts a flat strategy position (size 0) and the ticker/exchange pair", () => {
    const a = parseTradingView({ ticker: "RELIANCE", exchange: "NSE", side: "sell", quantity: 5, marketPosition: "flat", positionSize: 0, time: T });
    expect(a.signals[0]).toMatchObject({ symbol: "NSE:RELIANCE", quantity: 5, marketPosition: "flat", positionSize: 0 });
  });

  it("accepts the product aliases MIS, NRML and CNC", () => {
    expect(parseTradingView({ ...base, product: "NRML" }).signals[0].product).toBe("MARGIN");
    expect(parseTradingView({ ...base, product: "cnc" }).signals[0].product).toBe("CNC");
    expect(parseTradingView({ ...base, product: "MIS" }).signals[0].product).toBe("INTRADAY");
  });

  it("refuses unknown fields, with a hint for contracts, instead of ignoring them", () => {
    expect(code(() => parseTradingView({ ...base, quantiy: 3 }))).toMatch(/does not know: "quantiy"/);
    expect(code(() => parseTradingView({ ...base, lots: undefined, contracts: 2 }))).toMatch(/send it as "lots"/);
  });

  it("refuses an unfilled placeholder, a bad side, both quantity and lots, and a missing symbol", () => {
    expect(code(() => parseTradingView({ ...base, side: "{{strategy.order.action}}" }))).toMatch(/placeholder/);
    expect(code(() => parseTradingView({ ...base, side: "long" }))).toMatch(/buy or sell/);
    expect(code(() => parseTradingView({ ...base, quantity: 1 }))).toMatch(/quantity or lots/);
    expect(code(() => parseTradingView({ side: "buy", time: T }))).toMatch(/symbol is required/);
  });

  it("refuses a symbol with no exchange instead of guessing one", () => {
    expect(code(() => parseTradingView({ ...base, symbol: "RELIANCE" }))).toMatch(/no exchange/);
  });

  it("refuses bad time, mode, marketPosition and negative or non-numeric sizes", () => {
    expect(code(() => parseTradingView({ ...base, time: "yesterday" }))).toMatch(/time must look like/);
    expect(code(() => parseTradingView({ ...base, time: "2026-13-45T99:99:99Z" }))).toMatch(/time/);
    expect(code(() => parseTradingView({ ...base, mode: "demo" }))).toMatch(/paper or live/);
    expect(code(() => parseTradingView({ ...base, marketPosition: "sideways" }))).toMatch(/long, flat or short/);
    expect(code(() => parseTradingView({ ...base, positionSize: -3 }))).toMatch(/must not be negative/);
    expect(code(() => parseTradingView({ ...base, positionSize: "-3" }))).toMatch(/must not be negative/);
    expect(code(() => parseTradingView({ ...base, price: "abc" }))).toMatch(/price must be a number/);
    expect(code(() => parseTradingView({ ...base, account: "Bad Account!" }))).toMatch(/account/);
  });

  it("refuses a body that is not an object or text", () => {
    expect(code(() => parseTradingView([1]))).toMatch(/JSON or one line of text/);
    expect(code(() => parseTradingView(5))).toMatch(/JSON or one line of text/);
  });

  it("a key spelled in lower case is still ours (orderType, marketPosition, positionSize)", () => {
    expect(parseTradingView({ symbol: "NSE:INFY", side: "buy", ordertype: "market", marketposition: "long", positionsize: 1, time: T }).signals[0]).toMatchObject({ orderType: "MARKET", marketPosition: "long", positionSize: 1 });
  });
});

describe("TradingView alert: plain text message", () => {
  it("reads the documented shape with our extra words", () => {
    const a = parseTradingView(`BUY NSE:RELIANCE 1 @ 1402.5 MIS mode=paper id=a1 time=${T} passphrase=zzz`);
    expect(a.signals[0]).toMatchObject({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, price: 1402.5, product: "INTRADAY", mode: "paper", ref: "a1", time: T });
    expect(JSON.stringify(a)).not.toContain("zzz");
  });

  it("reads lots, market orders and account", () => {
    expect(parseTradingView("sell NSE:NIFTY1! 2 lots MKT account=paper marketposition=short positionsize=2").signals[0]).toMatchObject({ lots: 2, orderType: "MARKET", account: "paper", marketPosition: "short", positionSize: 2 });
  });

  it("explains an alert that was meant to be JSON but is not valid", () => {
    expect(code(() => parseTradingView('{"symbol": NSE:RELIANCE, "side": "buy"}'))).toMatch(/not valid JSON.*quotes/);
  });

  it("refuses unfilled placeholders, unknown words and oversize text", () => {
    expect(code(() => parseTradingView("BUY {{exchange}}:{{ticker}} 1"))).toMatch(/placeholder/);
    expect(code(() => parseTradingView("BUY NSE:RELIANCE now"))).toMatch(/does not understand/);
    expect(code(() => parseTradingView("x".repeat(2001)))).toMatch(/too long/);
    expect(code(() => parseTradingView("   "))).toMatch(/empty/);
    expect(code(() => parseTradingView("BUY RELIANCE 1"))).toMatch(/no exchange/);
  });
});

describe("alert identity (replay and duplicate protection)", () => {
  it("is id AND time AND symbol AND side, so a repeated default id on a later day is a new alert", () => {
    const a = parseTradingView({ ...base, id: "Long" }).basis;
    const later = parseTradingView({ ...base, id: "Long", time: "2026-11-10T09:56:00Z" }).basis;
    const again = parseTradingView({ ...base, id: "Long", price: 1500 }).basis;
    expect(a).not.toBe(later);
    expect(again).toBe(a);
    expect(parseTradingView({ ...base, id: "Long", symbol: "NSE:INFY" }).basis).not.toBe(a);
    expect(parseTradingView({ ...base, id: "Long", side: "sell" }).basis).not.toBe(a);
  });

  it("has no stable identity without a time (the exact bytes decide, inside the dedupe window)", () => {
    expect(parseTradingView({ ...base, time: undefined }).basis).toBeNull();
  });
});

describe("passphrase extraction and helpers", () => {
  it("finds the passphrase in JSON, text and a broken JSON message", () => {
    expect(extractPassphrase({ passphrase: "p1" })).toBe("p1");
    expect(extractPassphrase({ Passphrase: "p2" })).toBe("p2");
    expect(extractPassphrase("BUY NSE:X 1 passphrase=p3 id=1")).toBe("p3");
    expect(extractPassphrase('{"symbol": NSE:X, "passphrase": "p4"}')).toBe("p4");
    expect(extractPassphrase({ pass: "no" })).toBe("");
    expect(extractPassphrase([1])).toBe("");
    expect(extractPassphrase(null)).toBe("");
    expect(extractPassphrase({ passphrase: 12 })).toBe("");
  });

  it("parses TradingView's time format, with milliseconds or an offset, and refuses others", () => {
    expect(parseAlertTime("2019-08-27T09:56:00Z")).toBe(Date.parse("2019-08-27T09:56:00Z"));
    expect(parseAlertTime("2026-11-09T15:26:00+05:30")).toBe(Date.parse("2026-11-09T09:56:00Z"));
    expect(parseAlertTime("2026-11-09T15:26:00+0530")).toBe(Date.parse("2026-11-09T09:56:00Z"));
    expect(parseAlertTime("2026-11-09T09:56:00.250Z")).toBe(Date.parse("2026-11-09T09:56:00.250Z"));
    expect(() => parseAlertTime("2026-11-09 09:56:00")).toThrow();
    expect(tryAlertTime("nope")).toBeNull();
    expect(tryAlertTime(undefined)).toBeNull();
  });

  it("tells a dated canonical contract from a chart ticker", () => {
    expect(isDatedCanonical("NFO:NIFTY-2026-10-27-FUT")).toBe(true);
    expect(isDatedCanonical("NFO:NIFTY-2026-10-27-25000-CE")).toBe(true);
    expect(isDatedCanonical("NSE:M_M")).toBe(false);
    expect(isDatedCanonical("NSE:BAJAJ-AUTO")).toBe(false);
    expect(isDatedCanonical("NSE:NIFTY1!")).toBe(false);
  });
});
