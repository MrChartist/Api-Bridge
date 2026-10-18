/**
 * Each live mapper is checked against the adapter's OWN body builder, so a renamed field on either side fails here
 * instead of on a real-money call.
 */
import { describe, expect, it } from "vitest";
import { buildOrderBody as dhanBody } from "../../lib/dhanOrders.mjs";
import { buildModifyOrderBody as dhanModifyBody } from "../../lib/dhanPortfolio.mjs";
import { buildModifyBody as upstoxModifyBody, buildOrderBody as upstoxBody } from "../../brokers/upstoxOrders.mjs";
import { buildModifyBody as kiteModifyBody, buildOrderBody as kiteBody } from "../../brokers/zerodhaOrders.mjs";
import { LIVE_ORDER_MAPPERS, assertLiveSupport, liveMapperFor, liveSupport } from "./brokerOrders.mjs";

const limit = { side: "BUY", orderType: "LIMIT", product: "INTRADAY", validity: "DAY", price: 120.5 };
const slm = { side: "SELL", orderType: "SL-M", product: "MARGIN", validity: "DAY", triggerPrice: 110 };

describe("Zerodha mapper ↔ zerodhaOrders.buildOrderBody", () => {
  const m = LIVE_ORDER_MAPPERS.zerodha;
  const ref = { token: "1001", exchange: "NFO", tradingSymbol: "NIFTY26O2725000CE" };
  it("LIMIT with a tag", () => {
    const body = kiteBody(m.place({ order: limit, ref, lots: 2, tag: "MCBABCDEFGHIJKLM", marketProtectionPct: null }), 65);
    expect(body).toEqual({ tradingsymbol: "NIFTY26O2725000CE", exchange: "NFO", transaction_type: "BUY", order_type: "LIMIT", quantity: 130, product: "MIS", validity: "DAY", price: 120.5, tag: "MCBABCDEFGHIJKLM" });
  });
  it("SL-M carries native market protection and the trigger", () => {
    const body = kiteBody(m.place({ order: slm, ref, lots: 1, tag: null, marketProtectionPct: 2 }), 65);
    expect(body).toMatchObject({ order_type: "SL-M", trigger_price: 110, market_protection: 2, product: "NRML", price: 0, quantity: 65 });
  });
  it("modify sends the full type, quantity and price", () => {
    expect(kiteModifyBody(m.modify({ next: { ...limit, quantity: 65 }, marketProtectionPct: null }))).toEqual({ order_type: "LIMIT", validity: "DAY", quantity: 65, price: 120.5 });
  });
  it("needs the Zerodha trading symbol", () => {
    expect(m.unsupported({ exchange: "NFO", ref: { ...ref, tradingSymbol: null } })).toMatch(/trading symbol/);
    expect(m.unsupported({ exchange: "NFO", ref })).toBeNull();
  });
});

describe("Dhan mapper ↔ dhanOrders.buildOrderBody", () => {
  const m = LIVE_ORDER_MAPPERS.dhan;
  it("maps exchange segment, order type names, security id and correlation id", () => {
    const body = dhanBody("1000", m.place({ order: { ...limit, orderType: "SL", triggerPrice: 120 }, ref: { token: "51440", exchange: "NFO", tradingSymbol: null }, lots: 3, tag: "MCBTAG", marketProtectionPct: null }), 65);
    expect(body).toEqual({ dhanClientId: "1000", transactionType: "BUY", exchangeSegment: "NSE_FNO", productType: "INTRADAY", orderType: "STOP_LOSS", validity: "DAY", securityId: "51440", quantity: 195, price: 120.5, triggerPrice: 120, correlationId: "MCBTAG" });
  });
  it("cash equity on BSE and a MARKET order", () => {
    const body = dhanBody("1000", m.place({ order: { side: "SELL", orderType: "MARKET", product: "CNC" }, ref: { token: "500325", exchange: "BSE", tradingSymbol: null }, lots: 5, tag: null, marketProtectionPct: null }), 1);
    expect(body).toMatchObject({ exchangeSegment: "BSE_EQ", orderType: "MARKET", price: 0, quantity: 5, productType: "CNC" });
  });
  it("modify carries the full documented field set", () => {
    const c = m.modify({ next: { ...slm, quantity: 65 }, marketProtectionPct: null });
    expect(dhanModifyBody("1000", "D-1", c)).toEqual({ dhanClientId: "1000", orderId: "D-1", orderType: "STOP_LOSS_MARKET", validity: "DAY", quantity: 65, triggerPrice: 110 });
  });
  it("has no native market protection (the service converts MARKET to LIMIT)", () => {
    expect(m.nativeMarketProtection).toBe(false);
  });
});

describe("Upstox mapper ↔ upstoxOrders.buildOrderBody", () => {
  const m = LIVE_ORDER_MAPPERS.upstox;
  const ref = { token: "NSE_EQ|INE002A01018", exchange: "NSE", tradingSymbol: "RELIANCE" };
  it("maps instrument key, product and whole-percent protection", () => {
    const body = upstoxBody(m.place({ order: { side: "BUY", orderType: "MARKET", product: "CNC", validity: "IOC" }, ref, lots: 10, tag: "MCBX", marketProtectionPct: 2.4 }), 1);
    expect(body).toMatchObject({ instrument_token: "NSE_EQ|INE002A01018", transaction_type: "BUY", order_type: "MARKET", product: "D", validity: "IOC", quantity: 10, market_protection: 2, tag: "MCBX" });
  });
  it("modify", () => {
    const body = upstoxModifyBody("U-1", m.modify({ next: { ...limit, quantity: 10 }, marketProtectionPct: null }));
    expect(body).toMatchObject({ order_id: "U-1", order_type: "LIMIT", price: 120.5, quantity: 10, validity: "DAY" });
  });
  it("refuses MCX and unknown instrument keys before anything is sent", () => {
    expect(m.unsupported({ exchange: "MCX", ref: { token: "MCX_FO|1", exchange: "MCX" } })).toMatch(/MCX/);
    expect(m.unsupported({ exchange: "NSE", ref: { token: "2885", exchange: "NSE" } })).toMatch(/instrument key/);
  });
});

describe("live support", () => {
  const adapter = { placeOrder() {}, modifyOrder() {}, cancelOrder() {} };
  it("only wired brokers can trade live; others are refused clearly", () => {
    expect(liveMapperFor("dhan")).toBe(LIVE_ORDER_MAPPERS.dhan);
    expect(liveMapperFor("toString")).toBeNull();
    expect(liveSupport("angelone", adapter, "placeOrder").problem).toMatch(/not wired in the Bridge yet; use paper mode/);
    expect(liveSupport("zerodha", {}, "placeOrder").problem).toMatch(/no placeOrder/);
    expect(() => assertLiveSupport("fyers", adapter, "cancelOrder")).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(assertLiveSupport("upstox", adapter, "cancelOrder")).toBe(LIVE_ORDER_MAPPERS.upstox);
  });
});

describe("liveVerified (regression: fixture-only mappers must say so)", () => {
  it("every mapper declares it; only Dhan is verified against a real account", async () => {
    const { LIVE_ORDER_MAPPERS, unverifiedWarning } = await import("./brokerOrders.mjs");
    for (const m of Object.values(LIVE_ORDER_MAPPERS)) expect(typeof m.liveVerified).toBe("boolean");
    expect(LIVE_ORDER_MAPPERS.dhan.liveVerified).toBe(true);
    expect(unverifiedWarning(LIVE_ORDER_MAPPERS.dhan)).toBeNull();
    expect(unverifiedWarning(LIVE_ORDER_MAPPERS.zerodha)).toMatch(/not yet against a real account/);
  });
});
