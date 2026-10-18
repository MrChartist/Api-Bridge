/**
 * The dashboard's pending-confirmation view: a person must see every field the confirmation covers before they
 * approve it, and the single-use code must be shown once after confirming. Pure helpers only (no DOM).
 */
import { describe, expect, it } from "vitest";
import { confirmCodeNotice, ticketFields } from "./app.js";

const ticket = {
  ticketId: "tkt_abc123",
  source: "mcp",
  client: "Claude",
  order: { account: "zerodha-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, product: "CNC", orderType: "LIMIT", price: 1400, triggerPrice: null, validity: "DAY", mode: "live", tag: "ai1" },
  checks: [{ code: "PRICE_FAR_FROM_LTP", message: "Price is 4% away from the last price.", severity: "warn" }],
  estimatedValue: 14000,
};
const accounts = new Map([["zerodha-main", { id: "zerodha-main", broker: "zerodha", label: "Main" }]]);

describe("dashboard ticket view", () => {
  it("shows every field of the order the confirmation covers", () => {
    const f = Object.fromEntries(ticketFields(ticket, accounts).map(([k, v]) => [k, v]));
    expect(f.Account).toBe("zerodha-main (zerodha · Main)");
    expect(f.Mode).toMatch(/LIVE/);
    expect(f).toMatchObject({ Side: "BUY", Quantity: "10", Symbol: "NSE:RELIANCE", "Order type": "LIMIT", Product: "CNC", Validity: "DAY", Tag: "ai1" });
    expect(f.Price).toMatch(/1,400/);
    expect(f["Trigger price"]).toBe("—");
    expect(f["Estimated value"]).toMatch(/14,000/);
    expect(f.Warning).toMatch(/PRICE_FAR_FROM_LTP/);
  });

  it("flags live mode, MARKET orders and blocking checks", () => {
    const rows = ticketFields({ ...ticket, order: { ...ticket.order, orderType: "MARKET", price: null }, checks: [{ code: "KILL_SWITCH", severity: "block" }] }, accounts);
    const cls = Object.fromEntries(rows.map(([k, , c]) => [k, c]));
    expect(cls.Mode).toBe("bad");
    expect(cls["Order type"]).toBe("warn");
    expect(rows.find(([k]) => k === "Order type")[1]).toMatch(/MARKET \(no price limit\)/);
    expect(cls.Blocked).toBe("bad");
  });

  it("shows lots and an unknown account plainly", () => {
    const f = Object.fromEntries(ticketFields({ order: { account: "ghost", lots: 2, symbol: "NFO:NIFTY-2026-10-27-25000-CE", mode: "paper" } }).map(([k, v]) => [k, v]));
    expect(f).toMatchObject({ Account: "ghost", Quantity: "2 lot(s)", Mode: "paper", Validity: "DAY" });
  });

  it("keeps the confirmation code from the confirm response instead of throwing it away", () => {
    const n = confirmCodeNotice("tkt_abc123", { data: { confirmToken: "mct_0123456789abcdef", expiresAt: "2026-10-18T10:01:00+05:30" }, meta: {} });
    expect(n.token).toBe("mct_0123456789abcdef");
    expect(n.text).toMatch(/single-use/);
    expect(n.text).toMatch(/expires at/);
    expect(confirmCodeNotice("tkt_x", { data: {} })).toBeNull();
  });
});
