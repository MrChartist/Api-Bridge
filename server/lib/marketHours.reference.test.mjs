/**
 * marketHours answers from the dated reference rules and the shipped special sessions (reference/data), not from
 * constants of its own: derivatives trade to 15:40 from 3 Aug 2026 and to 15:45 from 7 Dec 2026, the Muhurat Sunday is not
 * "Weekend", and a special session whose timing is not verified stays closed for live orders.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isTradeable, isTradingDay, marketSession, minutesToClose, orderSession, requireFreshTick, setSpecialSessions, useShippedSpecialSessions } from "./marketHours.mjs";

const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`);

beforeEach(() => useShippedSpecialSessions());

describe("derivatives hours come from the dated rules", () => {
  it("NFO and BFO are open at 15:35 on Mon 9 Nov 2026; cash (and a call with no exchange) is closed", () => {
    for (const ex of ["NFO", "BFO"]) {
      expect(marketSession(ist("2026-11-09", "15:35"), ex).state).toBe("OPEN");
      expect(isTradeable(ist("2026-11-09", "15:35"), ex)).toBe(true);
      expect(isTradeable(ist("2026-11-09", "15:40"), ex)).toBe(false);
    }
    expect(marketSession(ist("2026-11-09", "15:35"), "NSE").state).toBe("CLOSED");
    expect(marketSession(ist("2026-11-09", "15:35")).state).toBe("CLOSED");
    expect(isTradeable(ist("2026-11-09", "15:35"))).toBe(false);
  });

  it("before 3 Aug 2026 derivatives still closed at 15:30", () => {
    expect(isTradeable(ist("2026-07-31", "15:30"), "NFO")).toBe(false);
    expect(isTradeable(ist("2026-07-31", "15:29"), "NFO")).toBe(true);
  });

  it("from 7 Dec 2026: stock derivatives and later-expiry index contracts trade to 15:45; an index contract expiring that day stops at 15:30", () => {
    const t = ist("2026-12-08", "15:35");
    expect(isTradeable(t, "NFO", { kind: "stock", expiry: "2026-12-29" })).toBe(true);
    expect(isTradeable(t, "NFO", { kind: "index", expiry: "2026-12-15" })).toBe(true);
    expect(isTradeable(t, "NFO", { kind: "index", expiry: "2026-12-08" })).toBe(false);
    expect(isTradeable(t, "NFO", null)).toBe(false); // unknown contract: the earlier close
    expect(isTradeable(ist("2026-12-08", "15:45"), "NFO", { kind: "stock", expiry: "2026-12-29" })).toBe(false);
    // The read-only view shows the segment's session.
    expect(marketSession(t, "NFO").state).toBe("OPEN");
  });

  it("the labels keep their old words", () => {
    expect(marketSession(ist("2026-11-09", "09:05"), "NSE").label).toBe("Pre-open (09:00–09:15) — no orders");
    expect(marketSession(ist("2026-11-09", "10:00"), "NSE").label).toBe("Regular session");
    expect(marketSession(ist("2026-11-09", "16:00"), "NFO").label).toBe("Market closed (09:15–15:40 IST)");
    expect(marketSession(ist("2026-11-07", "11:00")).label).toBe("Weekend");
  });

  it("minutesToClose follows the exchange's close", () => {
    expect(minutesToClose(ist("2026-11-09", "15:20"))).toBe(10);
    expect(minutesToClose(ist("2026-11-09", "15:20"), "NFO")).toBe(20);
  });

  it("requireFreshTick lets a derivative tick through until its close", () => {
    const now = ist("2026-11-09", "15:35").getTime();
    const ltt = Math.floor(now / 1000) - 1;
    expect(requireFreshTick(ltt, now - 100, 5000, now, "NFO")).toEqual({ ok: true, reason: null });
    expect(requireFreshTick(ltt, now - 100, 5000, now).reason).toBe("MARKET_CLOSED");
  });
});

describe("special sessions are loaded from the data file", () => {
  it("the Muhurat Sunday (2026-11-08) is a trading day, and no hour of it reads as Weekend", () => {
    expect(isTradingDay("2026-11-08", "NSE")).toBe(true);
    expect(isTradingDay("2026-11-08", "NFO")).toBe(true);
    expect(isTradingDay("2026-11-07", "NSE")).toBe(false);
    for (const hhmm of ["08:00", "12:00", "14:10", "14:30", "16:00"]) expect(marketSession(ist("2026-11-08", hhmm)).label).not.toBe("Weekend");
  });

  it("read-only: SPECIAL during the window, flagged unverified; for orders: closed with the reason", () => {
    const t = ist("2026-11-08", "14:30");
    expect(marketSession(t, "NSE")).toMatchObject({ state: "SPECIAL", verified: false });
    const gate = orderSession(t, "NSE");
    expect(gate).toMatchObject({ state: "CLOSED", unverifiedSpecial: true });
    expect(gate.label).toMatch(/timing is not verified/);
    expect(isTradeable(t, "NSE")).toBe(false);
    expect(isTradeable(t, "NFO")).toBe(false);
  });

  it("Budget Sunday 2026-02-01 is a session too, also unverified", () => {
    expect(isTradingDay("2026-02-01", "NSE")).toBe(true);
    expect(marketSession(ist("2026-02-01", "11:00"), "NSE")).toMatchObject({ state: "SPECIAL", verified: false });
    expect(isTradeable(ist("2026-02-01", "11:00"), "NSE")).toBe(false);
  });

  it("setSpecialSessions replaces the data file's sessions (a test or operator override) and a session given that way counts as verified", () => {
    setSpecialSessions({ "2026-11-08": { startMinute: 18 * 60 + 30, endMinute: 19 * 60 + 30, label: "Muhurat" } });
    expect(isTradeable(ist("2026-11-08", "18:45"), "NSE")).toBe(true);
    expect(marketSession(ist("2026-11-08", "14:30"), "NSE").state).toBe("CLOSED");
    setSpecialSessions({});
    expect(marketSession(ist("2026-11-08", "14:30"), "NSE").label).toBe("Weekend");
    useShippedSpecialSessions();
    expect(marketSession(ist("2026-11-08", "14:30"), "NSE").state).toBe("SPECIAL");
  });

  it("holidays are in isTradingDay (verified rows of the shipped list), including the 2026-01-15 closure", () => {
    expect(isTradingDay("2026-11-10", "NFO")).toBe(false); // Diwali-Balipratipada
    expect(isTradingDay("2026-01-15", "NSE")).toBe(false); // Maharashtra municipal elections
    expect(isTradingDay("2026-11-09", "NSE")).toBe(true);
  });
});
