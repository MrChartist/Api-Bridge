import { describe, expect, it } from "vitest";
import { TICKET_ORDER_TYPES, TICKET_PRODUCTS, TICKET_VALIDITIES, buildTicketOrder, choiceHint, refusedField, ticketAccounts, ticketNeeds, ticketSummary } from "./ticket.js";
import { ORDER_TYPES, PRODUCTS } from "../orders/orderValidation.mjs";
import { parseOrderRequest } from "../orders/orderValidation.mjs";

const base = { account: "paper", symbol: " nse:reliance ", side: "BUY", size: "5", product: "CNC", orderType: "LIMIT", price: "1300", trigger: "" };

describe("order ticket", () => {
  it("offers every order type, product and validity the Bridge accepts", () => {
    expect(TICKET_ORDER_TYPES.map(([v]) => v).sort()).toEqual([...ORDER_TYPES].sort());
    expect(TICKET_PRODUCTS.map(([v]) => v).sort()).toEqual([...PRODUCTS].sort());
    expect(TICKET_VALIDITIES.map(([v]) => v)).toEqual(["DAY", "IOC"]);
    for (const [v, , hint] of [...TICKET_ORDER_TYPES, ...TICKET_PRODUCTS, ...TICKET_VALIDITIES]) expect(hint, v).not.toMatch(/—/);
    expect(choiceHint(TICKET_ORDER_TYPES, "SL-M")).toMatch(/trigger/);
  });

  it("knows which prices each order type uses", () => {
    expect(ticketNeeds("LIMIT")).toEqual({ price: true, trigger: false });
    expect(ticketNeeds("MARKET")).toEqual({ price: false, trigger: false });
    expect(ticketNeeds("SL")).toEqual({ price: true, trigger: true });
    expect(ticketNeeds("SL-M")).toEqual({ price: false, trigger: true });
  });

  it("builds a body the order API accepts, for every order type and both sides", () => {
    for (const side of ["BUY", "SELL"])
      for (const [orderType] of TICKET_ORDER_TYPES)
        for (const [product] of TICKET_PRODUCTS)
          for (const [validity] of TICKET_VALIDITIES) {
            const r = buildTicketOrder({ ...base, side, orderType, product, validity, price: "1300", trigger: "1300" });
            expect(r.error, `${side} ${orderType}`).toBeUndefined();
            expect(() => parseOrderRequest(r.body)).not.toThrow();
          }
    expect(buildTicketOrder(base).body).toEqual({ account: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 5, product: "CNC", orderType: "LIMIT", price: 1300, validity: "DAY", mode: "paper" });
  });

  it("sends lots for a contract with a lot size, and leaves out prices the type does not use", () => {
    const r = buildTicketOrder({ ...base, symbol: "NFO:NIFTY-2026-11-26-FUT", lotSize: 75, size: "2", orderType: "SL-M", price: "99", trigger: "24000", product: "MARGIN", tag: "desk-1" });
    expect(r.body).toMatchObject({ lots: 2, orderType: "SL-M", triggerPrice: 24000, tag: "desk-1" });
    expect(r.body.quantity).toBeUndefined();
    expect(r.body.price).toBeUndefined();
    expect(buildTicketOrder({ ...base, orderType: "MARKET" }).body.price).toBeUndefined();
  });

  it("names the field with the first problem", () => {
    expect(buildTicketOrder({ ...base, account: "" }).error.field).toBe("account");
    expect(buildTicketOrder({ ...base, symbol: " " }).error.field).toBe("symbol");
    expect(buildTicketOrder({ ...base, size: "1.5" }).error.field).toBe("size");
    expect(buildTicketOrder({ ...base, size: "0" }).error.field).toBe("size");
    expect(buildTicketOrder({ ...base, price: "" }).error.field).toBe("price");
    expect(buildTicketOrder({ ...base, orderType: "SL", trigger: "" }).error.field).toBe("trigger");
    expect(buildTicketOrder({ ...base, orderType: "SL", price: "1290", trigger: "1300" }).error.message).toMatch(/buy stop-loss/);
    expect(buildTicketOrder({ ...base, side: "SELL", orderType: "SL", price: "1310", trigger: "1300" }).error.message).toMatch(/sell stop-loss/);
    expect(buildTicketOrder({ ...base, tag: "has space" }).error.field).toBe("tag");
  });

  it("puts paper accounts first and drops disabled ones", () => {
    const list = ticketAccounts([{ id: "dhan", broker: "dhan" }, { id: "off", broker: "paper", enabled: false }, { id: "p", broker: "paper" }]);
    expect(list.map((a) => a.id)).toEqual(["p", "dhan"]);
    expect(ticketAccounts(null)).toEqual([]);
  });

  it("says the order in one line", () => {
    expect(ticketSummary({ side: "BUY", quantity: 5, symbol: "NSE:RELIANCE", orderType: "LIMIT", price: 1300 })).toBe("Buy 5 NSE:RELIANCE at 1300.00 (LIMIT)");
    expect(ticketSummary({ side: "SELL", lots: 1, symbol: "NFO:X", orderType: "SL-M", triggerPrice: 240 })).toBe("Sell 1 lot NFO:X at market (SL-M, trigger 240.00)");
  });

  it("maps a refusal to its field", () => {
    expect(refusedField([{ path: "body.triggerPrice", message: "off tick" }])).toEqual({ field: "trigger", message: "off tick" });
    expect(refusedField([{ path: "lots", message: "x" }]).field).toBe("size");
    expect(refusedField([{ path: "product", message: "x" }])).toBeNull();
    expect(refusedField(undefined)).toBeNull();
  });
});
