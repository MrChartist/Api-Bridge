import { describe, expect, it } from "vitest";
import { displaySymbol, money, pnl, scrub } from "./messages.mjs";
import { bootNotify } from "./testkit.mjs";

async function ready(config = {}) {
  const n = bootNotify({ config: { coalesceSeconds: 0, dedupeSeconds: 0, ...config } });
  await n.withChat();
  n.svc.subscribe();
  return n;
}
const order = (o = {}) => ({ orderId: "PAPER-1", accountId: "paper", mode: "paper", status: "open", filledQuantity: 0, source: "rest", ...o });

describe("formatting", () => {
  it("money has Indian grouping and a clear sign", () => {
    expect(money(2431.5)).toBe("₹2,431.50");
    expect(money(12450075.5)).toBe("₹1,24,50,075.50");
    expect(money(-1200)).toBe("-₹1,200.00");
    expect(pnl(310)).toBe("+₹310.00");
    expect(pnl(-90)).toBe("-₹90.00");
    expect(money(NaN)).toBe("n/a");
  });
  it("symbols lose the exchange prefix; options read like a person says them", () => {
    expect(displaySymbol("NSE:RELIANCE")).toBe("RELIANCE");
    expect(displaySymbol("NFO:NIFTY-2026-11-26-24500-CE")).toBe("NIFTY 26 Nov 24500 CE");
    expect(displaySymbol("NFO:NIFTY-2026-11-26-FUT")).toBe("NIFTY 26 Nov FUT");
  });
  it("scrub removes anything that looks like a secret", () => {
    const dirty = "a 123456789:AAH-fake_Token_value_for_tests_0000 b mcb_abcdefgh_ssssssssssssssss c mct_zzzzzzzzzzzzzzzz d Bearer abcdefghijkl e /hooks/generic/abcdefghijklmnopqrstuv";
    const clean = scrub(dirty);
    expect(clean).not.toMatch(/AAH|mcb_|mct_|Bearer abc|abcdefghijklmnopqrstuv/);
  });
});

describe("events become short plain messages", () => {
  it("a fill: side, quantity, symbol, price, mode and account", async () => {
    const n = await ready();
    n.world.orderById["PAPER-1"] = { side: "BUY", quantity: 10, symbol: "NSE:RELIANCE" };
    n.bus.emit("order.updated", order({ status: "filled", filledQuantity: 10, avgPrice: 2431.5 }));
    await n.settle();
    expect(n.tg.texts()).toEqual(["Filled: BUY 10 RELIANCE at ₹2,431.50 (paper, Paper)."]);
  });

  it("a rejection carries the broker's reason, clipped and cleaned", async () => {
    const n = await ready();
    n.world.orderById["PAPER-2"] = { side: "SELL", quantity: 5, symbol: "NSE:INFY", statusMessage: "Insufficient\nmargin‮ ".padEnd(400, "x") };
    n.bus.emit("order.updated", order({ orderId: "PAPER-2", status: "rejected" }));
    await n.settle();
    const t = n.tg.texts()[0];
    expect(t).toMatch(/^Order rejected: SELL 5 INFY \(paper, Paper\)\. Reason: Insufficient margin/);
    expect(t).not.toMatch(/[\n‮]/);
    expect(t.length).toBeLessThan(260);
  });

  it("an order whose result is unknown says 'unknown, check your broker', never 'failed'", async () => {
    const n = await ready();
    n.world.orderById["ord_9"] = { side: "BUY", quantity: 1, symbol: "NSE:RELIANCE" };
    n.bus.emit("order.outcome_unknown", { orderId: "ord_9", accountId: "dhan-main", since: "x" });
    await n.settle();
    const t = n.tg.texts()[0];
    expect(t).toMatch(/unknown/i);
    expect(t).toMatch(/check your broker/);
    expect(t.toLowerCase()).not.toMatch(/failed|fail/);
  });

  it("each order transition is announced once, even if the bus repeats it; placed is off by default", async () => {
    const n = await ready();
    n.bus.emit("order.updated", order({ status: "open" }));
    n.bus.emit("order.updated", order({ status: "filled", filledQuantity: 1, avgPrice: 100 }));
    n.bus.emit("order.updated", order({ status: "filled", filledQuantity: 1, avgPrice: 100 }));
    await n.settle();
    for (let i = 0; i < 3; i += 1) await n.advance(1200);
    expect(n.tg.texts()).toHaveLength(1);
    expect(n.tg.texts()[0]).toMatch(/^An order was filled at ₹100.00/);
  });

  it("a ticket asks for approval ON THIS COMPUTER and carries no token, id or link", async () => {
    const n = await ready();
    n.bus.emit("ticket.prepared", { ticketId: "tkt_SECRETid123456", accountId: "dhan-main", mode: "live", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, estimatedValue: 24315, confirmToken: "mct_shouldneverappear0000", expiresAt: "x" });
    await n.settle();
    const t = n.tg.texts()[0];
    expect(t).toMatch(/waiting for your approval: BUY 10 RELIANCE \(about ₹24,315\) on Dhan Main/);
    expect(t).toMatch(/ON THIS COMPUTER/);
    expect(t).toMatch(/cannot be approved from Telegram/);
    expect(t).not.toMatch(/tkt_|mct_|http|SECRET/);
  });

  it("the kill switch: engaged says by whom, released says orders can go again", async () => {
    const n = await ready();
    n.bus.emit("safety.kill_switch", { engaged: true, reason: "manual", by: "key:telegram", at: "x", cancelOpenOrders: false });
    await n.settle();
    expect(n.tg.texts()[0]).toBe("Kill switch ON (by Telegram): manual. New orders are blocked until you release it on this computer.");
    n.bus.emit("safety.kill_switch", { engaged: false, reason: null, by: "local:cli", at: "x", cancelOpenOrders: false });
    await n.settle();
    await n.advance(1200);
    expect(n.tg.texts()[1]).toBe("Kill switch OFF. Orders can be sent again.");
  });

  it("a session that was connected and is now logged out is announced; a never-connected account is not", async () => {
    const n = await ready();
    n.bus.emit("account.status", { accountId: "dhan-main", broker: "dhan", session: "expired" });
    await n.settle();
    expect(n.tg.texts()).toEqual([]);
    n.bus.emit("account.status", { accountId: "dhan-main", broker: "dhan", session: "connected" });
    n.bus.emit("account.status", { accountId: "dhan-main", broker: "dhan", session: "expired" });
    await n.settle();
    expect(n.tg.texts()).toEqual(["Dhan Main is logged out. Log in again on this computer, or prices and orders from it stop."]);
  });

  it("readiness changes use the readiness wording, only when the monitor says notify", async () => {
    const n = await ready();
    n.bus.emit("trading.readiness", { accountId: "dhan-main", broker: "dhan", brokerName: "Dhan", label: "Dhan Main", state: "cannot_trade", notify: false, reasons: [{ check: "session", severity: "fail", message: "Session expired" }] });
    await n.settle();
    expect(n.tg.texts()).toEqual([]);
    n.bus.emit("trading.readiness", { accountId: "dhan-main", broker: "dhan", brokerName: "Dhan", label: "Dhan Main", state: "cannot_trade", notify: true, reasons: [{ check: "session", severity: "fail", message: "Session expired" }] });
    await n.settle();
    expect(n.tg.texts()[0]).toMatch(/^Dhan Main: cannot trade\. Session expired/);
  });

  it("webhook alerts after the 202: rejected, stale and failed", async () => {
    const n = await ready();
    n.bus.emit("hook.rejected", { hookId: "hk_abc", label: "NIFTY scalp", reason: "Symbol is not on the hook's allowed list", symbol: "NSE:INFY", side: "buy" });
    n.bus.emit("hook.stale", { label: "NIFTY scalp", reason: "alert is 9 minutes old" });
    n.bus.emit("hook.failed", { label: "NIFTY scalp", reason: "Insufficient margin" });
    await n.settle();
    for (let i = 0; i < 5; i += 1) await n.advance(1200);
    const t = n.tg.texts();
    expect(t[0]).toBe('A webhook alert was rejected on "NIFTY scalp" (BUY INFY). Reason: Symbol is not on the hook\'s allowed list.');
    expect(t[1]).toMatch(/^A webhook alert arrived too late and was dropped on "NIFTY scalp"/);
    expect(t[2]).toMatch(/^A webhook alert was accepted but its order failed on "NIFTY scalp"/);
  });

  it("a failed backup reaches the phone, without the file path or the reason text", async () => {
    const n = await ready();
    n.bus.emit("backup.failed", { kind: "scheduled", at: "2026-11-10T02:30:00.000Z", message: "ENOSPC: no space left on device, write '/home/someone/.mc-bridge/backups/x.tar.gz'" });
    await n.settle();
    const t = n.tg.texts();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatch(/^The daily backup could not be written, so your data may not be backed up/);
    expect(t[0]).not.toMatch(/ENOSPC|\/home\//);
  });

  it("a daily limit reached is announced with the figures", async () => {
    const n = await ready();
    n.bus.emit("safety.limit", { accountId: "dhan-main", limit: "dailyMaxLoss", value: -5200, threshold: 5000 });
    await n.settle();
    expect(n.tg.texts()[0]).toBe("Daily loss limit reached on Dhan Main: ₹5,200 against a limit of ₹5,000. New orders on it are blocked for today.");
  });

  it("rate-limit throttling is announced once, only above the threshold", async () => {
    const n = await ready({ rateLimitAlert: { threshold: 5, windowMinutes: 10 } });
    for (let i = 0; i < 4; i += 1) n.bus.emit("limits.throttled", { accountId: "dhan-main", endpointClass: "quote", retryAfterMs: 1000, upstream: true });
    await n.settle();
    expect(n.tg.texts()).toEqual([]);
    for (let i = 0; i < 10; i += 1) n.bus.emit("limits.throttled", { accountId: "dhan-main", endpointClass: "quote", retryAfterMs: 1000, upstream: true });
    await n.settle();
    expect(n.tg.texts()).toHaveLength(1);
    expect(n.tg.texts()[0]).toMatch(/^Rate limits slowed 5 requests in the last 10 minutes\. Most of it on Dhan Main \(quote\)\./);
  });

  it("a data source that gets ejected is announced once, and again only after it recovered", async () => {
    const n = await ready();
    n.world.sources = [{ id: "nse-eod", name: "NSE end of day", enabled: true, health: { state: "open" } }];
    await n.advance(0);
    await n.advance(40_000);
    expect(n.tg.texts()).toEqual(["Data source NSE end of day is paused after repeated failures. The Bridge tries it again by itself."]);
    await n.advance(40_000);
    expect(n.tg.texts()).toHaveLength(1);
    n.world.sources[0].health.state = "ok";
    await n.advance(40_000);
    n.world.sources[0].health.state = "open";
    await n.advance(40_000);
    for (let i = 0; i < 3; i += 1) await n.advance(1200);
    expect(n.tg.texts()).toHaveLength(2);
  });

  it("an unknown bus topic is tolerated (a build without the hook topics)", async () => {
    const n = bootNotify({ bus: { on: (t, h) => { if (t.startsWith("hook.")) throw new Error("unknown topic"); return () => {}; }, emit: () => 0 } });
    expect(() => n.svc.subscribe()).not.toThrow();
  });
});
