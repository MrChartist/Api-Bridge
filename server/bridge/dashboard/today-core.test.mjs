import { describe, expect, it } from "vitest";
import { dataLine, dayText, durationText, eventSplit, homeSummary, keyLevels, levelAxis, marketClock, nextTradingDay, pnlBars, readinessChecks, upcomingExpiries } from "./today-core.js";

// IST wall-clock time → epoch ms.
const ist = (iso) => Date.parse(`${iso}+05:30`);
const SESSION = { open: "09:15", close: "15:30" };
const HOLS = [{ date: "2026-11-09", label: "Diwali" }];

describe("durationText", () => {
  it("writes hours and minutes, minutes alone under an hour", () => {
    expect(durationText(80)).toBe("1h 20m");
    expect(durationText(20.7)).toBe("20m");
    expect(durationText(0.4)).toBe("under 1m");
    expect(durationText(null)).toBe("");
  });
});

describe("nextTradingDay", () => {
  it("skips weekends and holidays", () => {
    expect(nextTradingDay("2026-10-30")).toBe("2026-11-02"); // Fri → Mon
    expect(nextTradingDay("2026-11-06", HOLS)).toBe("2026-11-10"); // Fri → Tue (Mon a holiday)
  });
});

describe("marketClock", () => {
  it("counts down to the close while the session runs", () => {
    const c = marketClock({ nowMs: ist("2026-10-29T14:10:00"), session: SESSION });
    expect(c.phase).toBe("open");
    expect(c.hero).toBe("Open");
    expect(c.minsLeft).toBe(80);
    expect(c.sub).toBe("1h 20m to close · closes 15:30 IST");
    expect(c.elapsed).toBeCloseTo((14 * 60 + 10 - 555) / 375, 6);
  });
  it("says Closed before the open, with the time to it", () => {
    const c = marketClock({ nowMs: ist("2026-10-29T08:50:00"), session: SESSION });
    expect(c).toMatchObject({ phase: "pre", hero: "Closed", elapsed: 0 });
    expect(c.sub).toBe("Opens today at 09:15 IST · in 25m");
  });
  it("after the close and at the weekend names the next session", () => {
    expect(marketClock({ nowMs: ist("2026-10-29T16:00:00"), session: SESSION })).toMatchObject({ phase: "closed", elapsed: 1 });
    const w = marketClock({ nowMs: ist("2026-10-31T11:00:00"), session: SESSION });
    expect(w).toMatchObject({ phase: "closed", elapsed: 0, next: "2026-11-02" });
    expect(w.sub).toMatch(/^Weekend · opens Mon 2 Nov, 09:15 IST$/);
  });
  it("names a holiday", () => {
    const c = marketClock({ nowMs: ist("2026-11-09T11:00:00"), session: SESSION, holidays: HOLS });
    expect(c).toMatchObject({ phase: "closed", holiday: "Diwali" });
    expect(c.sub).toMatch(/^Diwali · opens Tue 10 Nov/);
  });
});

describe("dataLine", () => {
  const now = ist("2026-10-29T11:00:00");
  it("grades the age while open", () => {
    expect(dataLine({ phase: "open", asOfMs: now - 30_000, nowMs: now })).toEqual({ state: "live", text: "Live · 10:59 IST" });
    expect(dataLine({ phase: "open", asOfMs: now - 240_000, nowMs: now }).text).toBe("Delayed · 4m old · 10:56 IST");
    expect(dataLine({ phase: "open", asOfMs: now - 900_000, nowMs: now }).state).toBe("stale");
  });
  it("reads Closing data outside the session, and says when there is no time", () => {
    const c = dataLine({ phase: "closed", asOfMs: ist("2026-10-30T15:30:00"), nowMs: now });
    expect(c.state).toBe("closing");
    expect(c.text).toMatch(/^Closing data · 30 Oct, 15:30 IST$/);
    expect(dataLine({ phase: "open", asOfMs: null, nowMs: now })).toEqual({ state: "none", text: "Time not reported" });
  });
});

// A small chain: spot 24,990, strikes 24,500–25,500 every 100.
const leg = (ltp, oi, iv = 20) => ({ ltp, oi, iv });
const chain = {
  underlyingLtp: 24990,
  atmStrike: 25000,
  lotSize: 65,
  rows: [
    { strike: 24500, ce: leg(520, 100), pe: leg(20, 900) },
    { strike: 24600, ce: leg(430, 120), pe: leg(30, 700) },
    { strike: 24700, ce: leg(340, 150), pe: leg(45, 800) },
    { strike: 24800, ce: leg(260, 200), pe: leg(70, 1200) },
    { strike: 24900, ce: leg(190, 400), pe: leg(105, 950) },
    { strike: 25000, ce: leg(130, 900, 21), pe: leg(140, 600, 21.4) },
    { strike: 25100, ce: leg(85, 1100), pe: leg(195, 300) },
    { strike: 25200, ce: leg(50, 1500), pe: leg(260, 150) },
    { strike: 25300, ce: leg(30, 1000), pe: leg(340, 90) },
    { strike: 25400, ce: leg(15, 800), pe: leg(430, 60) },
    { strike: 25500, ce: leg(8, 2000), pe: leg(520, 40) },
  ],
};

describe("keyLevels", () => {
  const lv = keyLevels(chain, { flip: 24600 });
  it("reads the straddle and the expected move (0.85 × straddle)", () => {
    expect(lv.atm).toBe(25000);
    expect(lv.straddle).toBe(270);
    expect(lv.move).toBeCloseTo(229.5, 6);
    expect(lv.rangeLo).toBeCloseTo(24990 - 229.5, 6);
    expect(lv.atmIv).toBeCloseTo(21.2, 6);
  });
  it("finds the walls inside ATM ± 7 strikes, on their side of spot", () => {
    // The most Call OI at or above spot is 25,500 and the most Put OI at or below is 24,800.
    expect(lv.callWall).toEqual({ strike: 25500, oi: 2000, dist: 510 });
    expect(lv.putWall).toEqual({ strike: 24800, oi: 1200, dist: -190 });
  });
  it("keeps the wall window to ATM ± 7 strikes on a wide chain", () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ strike: 24000 + i * 100, ce: leg(10, i === 30 ? 99999 : 100), pe: leg(10, 100) }));
    const wide = keyLevels({ underlyingLtp: 25500, atmStrike: 25500, rows });
    expect(wide.callWall.strike).not.toBe(27000);
  });
  it("gives PCR with its scope, max pain and the flip's distance", () => {
    expect(lv.pcr).toBeCloseTo(5790 / 8270, 6);
    expect(lv.pcrStrikes).toBe(11);
    expect(lv.maxPain.strike).toBeGreaterThan(0);
    expect(lv.flip).toEqual({ price: 24600, dist: -390 });
  });
  it("prints nothing it cannot back", () => {
    const e = keyLevels({ rows: [] });
    expect(e).toMatchObject({ spot: null, straddle: null, move: null, callWall: null, putWall: null, maxPain: null, pcr: null, flip: null });
  });
});

describe("levelAxis", () => {
  it("puts every level on one axis, sharing a mark when prices agree", () => {
    const ax = levelAxis({ spot: 100, callWall: { strike: 110 }, putWall: { strike: 90 }, maxPain: { strike: 110 }, flip: null, rangeLo: 95, rangeHi: 105 });
    expect(ax.marks.map((m) => m.price)).toEqual([90, 95, 105, 110]);
    expect(ax.marks.at(-1).tags).toEqual(["Call wall", "Max pain"]);
    expect(ax.spot.x).toBeCloseTo(0.5, 6);
    expect(ax.band.x0).toBeLessThan(ax.spot.x);
    expect(ax.marks.every((m) => m.x > 0 && m.x < 1)).toBe(true);
  });
  it("leaves a level more than three expected moves away off the ruler, and names it", () => {
    const ax = levelAxis({ spot: 100, move: 2, callWall: { strike: 103 }, flip: { price: 80 } });
    expect(ax.marks.map((m) => m.price)).toEqual([103]);
    expect(ax.off).toEqual(["Gamma flip"]);
  });
  it("is null without a spot", () => expect(levelAxis({ spot: null })).toBeNull());
});

describe("upcomingExpiries", () => {
  it("lists index expiries in the window, soonest first", () => {
    const b = [
      { underlying: "NIFTY", expiries: [{ date: "2026-11-03", kind: "weekly" }, { date: "2026-11-30", kind: "monthly" }] },
      { underlying: "SENSEX", expiries: [{ date: "2026-11-05", kind: "weekly", shifted: true }, { date: "2026-10-29", kind: "weekly" }] },
    ];
    expect(upcomingExpiries(b, "2026-10-31")).toEqual([
      { u: "NIFTY", date: "2026-11-03", kind: "weekly", shifted: false, days: 3 },
      { u: "SENSEX", date: "2026-11-05", kind: "weekly", shifted: true, days: 5 },
    ]);
  });
});

describe("pnlBars", () => {
  it("scales bars to the largest move and drops groups with no figure", () => {
    const bars = pnlBars([{ underlying: "NIFTY", pnl: 738 }, { underlying: "BANKNIFTY", pnl: -62 }, { underlying: "X", pnl: null }]);
    expect(bars).toEqual([
      { label: "NIFTY", v: 738, h: 1 },
      { label: "BANKNIFTY", v: -62, h: 62 / 738 },
    ]);
  });
});

describe("readinessChecks / eventSplit", () => {
  it("counts passed checks, leaving n/a out", () => {
    expect(readinessChecks({ accounts: [{ checks: { a: { status: "pass" }, b: { status: "warn" }, c: { status: "n/a" } } }] })).toEqual({ pass: 1, total: 2 });
    expect(readinessChecks(null)).toEqual({ pass: 0, total: 0 });
  });
  it("splits today's events by side", () => {
    const evs = [{ ts: ist("2026-10-31T10:00:00"), side: "bull" }, { time: "2026-10-31T11:00:00+05:30", side: "bear" }, { ts: ist("2026-10-30T10:00:00"), side: "bull" }, { ts: ist("2026-10-31T12:00:00"), side: "neutral" }];
    expect(eventSplit(evs, "2026-10-31")).toEqual({ total: 3, bull: 1, bear: 1 });
  });
});

describe("homeSummary", () => {
  it("joins what is known, in order", () => {
    const clock = marketClock({ nowMs: ist("2026-10-29T14:10:00"), session: SESSION });
    expect(homeSummary({ clock, books: 5, pnl: 629, expiry: { u: "NIFTY", days: 3 } })).toBe("Market open · 1h 20m to close · 5 books open · P&L today +₹629 · NIFTY expiry in 3 days");
    expect(homeSummary({ books: 0, pnl: 0, expiry: { u: "SENSEX", days: 0 } })).toBe("Nothing open · SENSEX expiry today");
  });
  it("writes the day short", () => expect(dayText("2026-11-02")).toBe("Mon 2 Nov"));
});
