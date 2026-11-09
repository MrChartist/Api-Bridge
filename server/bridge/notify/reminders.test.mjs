import { describe, expect, it } from "vitest";
import { createTradingCalendar, dueReminders, nextReminderAt } from "./reminders.mjs";
import { bootNotify } from "./testkit.mjs";

/** IST "YYYY-MM-DD HH:MM" -> epoch ms */
const ist = (s) => Date.parse(`${s.replace(" ", "T")}:00+05:30`);
const MORNING = { enabled: true, at: "08:45", secondAt: "09:10", endOfDay: { enabled: false, at: "15:45" } };
const cal = createTradingCalendar();

describe("when reminders are due (pure)", () => {
  const due = (when, o = {}) => dueReminders({ now: ist(when), morning: { ...MORNING, ...o.morning }, calendar: o.calendar ?? cal, sent: o.sent ?? {} }).map((r) => r.kind);

  it("on a trading day: morning from 08:45, the second nudge from 09:10, nothing before", () => {
    expect(due("2026-11-09 08:44")).toEqual([]);
    expect(due("2026-11-09 08:45")).toEqual(["morning"]);
    expect(due("2026-11-09 09:10")).toEqual(["morning", "second"]);
  });
  it("not on a weekend", () => {
    expect(due("2026-11-14 08:50")).toEqual([]); // Saturday
    expect(due("2026-11-15 08:50")).toEqual([]); // Sunday
  });
  it("not on an exchange holiday (Diwali-Balipratipada, Tue 10 Nov 2026), and again on the next day", () => {
    expect(due("2026-11-10 08:50")).toEqual([]);
    expect(due("2026-11-11 08:50")).toEqual(["morning"]);
  });
  it("not on a special-session Sunday (Muhurat trading has its own hours)", () => {
    expect(due("2026-11-08 08:50")).toEqual([]);
  });
  it("only once a day, and not hours late (a Bridge started at 14:00 sends no 08:45 reminder)", () => {
    expect(due("2026-11-09 08:50", { sent: { "morning:2026-11-09": 1 } })).toEqual([]);
    expect(due("2026-11-09 14:00")).toEqual([]);
    expect(due("2026-11-09 10:30")).toEqual([]); // the 90 minutes of grace for the morning reminder have passed
  });
  it("without the holiday calendar, weekdays only", () => {
    const weekdays = { isTradingDay: (d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) };
    expect(due("2026-11-10 08:50", { calendar: weekdays })).toEqual(["morning"]);
    expect(due("2026-11-14 08:50", { calendar: weekdays })).toEqual([]);
  });
  it("the end-of-day summary is optional", () => {
    expect(due("2026-11-09 15:50")).toEqual([]);
    expect(due("2026-11-09 15:50", { morning: { endOfDay: { enabled: true, at: "15:45" } } })).toEqual(["eod"]);
  });
  it("nextReminderAt skips the weekend and the holiday", () => {
    expect(nextReminderAt({ now: ist("2026-11-09 09:30"), morning: MORNING, calendar: cal })).toBe(ist("2026-11-11 08:45"));
    expect(nextReminderAt({ now: ist("2026-11-13 09:30"), morning: MORNING, calendar: cal })).toBe(ist("2026-11-16 08:45"));
  });
});

async function booted(whenIst, { loggedOut = ["dhan-main"], config = {} } = {}) {
  const n = bootNotify({ now: { t: ist(whenIst) }, config: { coalesceSeconds: 0, ...config } });
  for (const id of loggedOut) n.world.accounts.find((a) => a.id === id).session.state = "expired";
  await n.withChat();
  return n;
}

describe("the morning reminder, end to end", () => {
  it("08:45: '1 account is not logged in' with its name; 09:10: a second nudge if still not logged in", async () => {
    const n = await booted("2026-11-09 08:44");
    await n.advance(0);
    expect(n.tg.texts()).toEqual([]);
    await n.advance(60_000);
    expect(n.tg.texts()).toEqual(["1 account is not logged in: Dhan Main. Log in on this computer before the market opens at 09:15."]);
    await n.advance(60_000);
    expect(n.tg.texts()).toHaveLength(1); // not repeated
    await n.advance(25 * 60_000);
    for (let i = 0; i < 3; i += 1) await n.advance(1200);
    expect(n.tg.texts()[1]).toBe("Still not logged in at the open: 1 account is not logged in: Dhan Main. The market opened at 09:15.");
  });

  it("several accounts are listed by name", async () => {
    const n = await booted("2026-11-09 08:44", { loggedOut: ["dhan-main", "zerodha-main"] });
    await n.advance(60_000);
    expect(n.tg.texts()[0]).toBe("2 accounts are not logged in: Zerodha Main, Dhan Main. Log in on this computer before the market opens at 09:15.");
  });

  it("no second nudge when the person logged in after the first one", async () => {
    const n = await booted("2026-11-09 08:44");
    await n.advance(60_000);
    n.world.accounts.find((a) => a.id === "dhan-main").session.state = "connected";
    await n.advance(30 * 60_000);
    expect(n.tg.texts()).toHaveLength(1);
  });

  it("nothing at all when every account is logged in; paper accounts never count", async () => {
    const n = await booted("2026-11-09 08:44", { loggedOut: [] });
    n.world.accounts.find((a) => a.id === "paper").session.state = "expired";
    await n.advance(60_000);
    await n.advance(30 * 60_000);
    expect(n.tg.texts()).toEqual([]);
  });

  it("no reminder on a holiday, a Saturday or a Sunday, even with accounts logged out", async () => {
    for (const day of ["2026-11-10", "2026-11-14", "2026-11-15", "2026-11-08"]) {
      const n = await booted(`${day} 08:44`);
      await n.advance(60_000);
      await n.advance(30 * 60_000);
      expect(n.tg.texts(), day).toEqual([]);
    }
  });

  it("a Bridge started at 09:05 gets the first reminder, and the second nudge is skipped as redundant", async () => {
    const n = await booted("2026-11-09 09:05");
    await n.advance(0);
    expect(n.tg.texts()).toHaveLength(1);
    await n.advance(6 * 60_000); // 09:11
    expect(n.tg.texts()).toHaveLength(1);
  });

  it("the reminder is remembered across a restart: no repeat", async () => {
    const n = await booted("2026-11-09 08:44");
    await n.advance(60_000);
    const again = bootNotify({ dir: n.dataDir, now: n.clock, tg: n.tg, masterKey: n.key });
    await again.advance(1000);
    expect(n.tg.texts()).toHaveLength(1);
  });

  it("can be switched off, and the time changed", async () => {
    const n = await booted("2026-11-09 08:44");
    n.svc.setEvents({ morning: { at: "08:55" } });
    await n.advance(60_000);
    expect(n.tg.texts()).toEqual([]);
    await n.advance(10 * 60_000);
    expect(n.tg.texts()).toHaveLength(1);
    const off = await booted("2026-11-09 08:44");
    off.svc.setEvents({ events: { "reminder.morning": false } });
    await off.advance(60_000);
    expect(off.tg.texts()).toEqual([]);
  });

  it("the end-of-day summary lists orders, fills, rejections and P&L per account", async () => {
    const n = await booted("2026-11-09 10:00", { loggedOut: [] });
    n.svc.setEvents({ events: { "summary.eod": true }, morning: { endOfDay: { enabled: true, at: "15:45" } } });
    n.svc.subscribe();
    n.world.pnl.paper = 310;
    n.bus.emit("order.updated", { orderId: "P1", accountId: "paper", mode: "paper", status: "open", filledQuantity: 0, source: "rest" });
    n.bus.emit("order.updated", { orderId: "P1", accountId: "paper", mode: "paper", status: "filled", filledQuantity: 1, avgPrice: 10, source: "rest" });
    n.bus.emit("order.updated", { orderId: "P2", accountId: "paper", mode: "paper", status: "rejected", filledQuantity: 0, source: "rest" });
    await n.settle();
    n.tg.texts().length = 0;
    n.clock.t = ist("2026-11-09 15:46");
    await n.advance(0);
    for (let i = 0; i < 3; i += 1) await n.advance(1200);
    expect(n.tg.texts().at(-1)).toBe("End of day 2026-11-09.\nPaper (paper): 2 orders, 1 filled, 1 rejected, P&L +₹310.00");
  });
});
