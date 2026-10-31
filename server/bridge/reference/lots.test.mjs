import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCalendar } from "./calendar.mjs";
import { bannerDue, lotConflict, lotForMonth, lotTimeline, lotTransitions, membersFromMktLots, mergeLotHistory, parseMktLots, parseMonthHeader, universeChanges, universeOn, updateUniverse } from "./lots.mjs";

const fixture = (name) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("parseMktLots", () => {
  const parsed = parseMktLots(fixture("fo_mktlots.csv"));
  it("reads months, index and stock rows through padding, a BOM, quotes and blank cells", () => {
    expect(parsed.months).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(parsed.rows.find((r) => r.symbol === "NIFTY")).toMatchObject({ kind: "index", lots: { "2026-10": 65, "2026-11": 65, "2026-12": 65 } });
    expect(parsed.rows.find((r) => r.symbol === "BANKNIFTY").lots["2026-12"]).toBe(35);
    expect(parsed.rows.find((r) => r.symbol === "FINNIFTY").lots).toEqual({ "2026-10": 60, "2026-11": 60 });
    expect(parsed.rows.find((r) => r.symbol === "RELIANCE")).toMatchObject({ kind: "stock", lots: { "2026-10": 500 } });
    expect(parsed.rows.find((r) => r.symbol === "M&M").lots["2026-10"]).toBe(200);
    expect(parsed.rows.filter((r) => r.kind === "stock").map((r) => r.symbol)).toEqual(["RELIANCE", "BAJAJFINSV", "M&M", "XYZ"]);
  });
  it("month headers", () => {
    expect(parseMonthHeader("JAN-26")).toBe("2026-01");
    expect(parseMonthHeader(" dec-25 ")).toBe("2025-12");
    expect(parseMonthHeader("SYMBOL")).toBe(null);
  });
  it("refuses a file without the header or rows", () => {
    expect(() => parseMktLots("hello,world\n")).toThrow(/header/);
    expect(() => parseMktLots("UNDERLYING,SYMBOL,OCT-26\n")).toThrow(/no rows/);
  });
});

describe("lot history and effective dates (§6.3)", () => {
  const cal = createCalendar({ holidays: [{ date: "2025-12-25", label: "Christmas", exchanges: ["NSE", "BSE"], verified: true }] });
  const merged = mergeLotHistory([], parseMktLots(fixture("mktlots-revision.csv")), { date: "2025-12-20", source: "nse-archives:fo_mktlots.csv" });
  const nifty = lotTimeline(merged.rows, "NIFTY");

  it("the Jan 2026 revision takes effect on Wed 31 Dec 2025, the day after the last 75-lot expiry", () => {
    const listed = ["2025-12-02", "2025-12-09", "2025-12-16", "2025-12-23", "2025-12-30", "2026-01-06", "2026-01-27"];
    const t = lotTransitions(nifty, { listedExpiries: listed, cal });
    expect(t).toEqual([{ fromMonth: "2025-12", toMonth: "2026-01", lotBefore: 75, lotAfter: 65, lastOldExpiry: "2025-12-30", effectiveFrom: "2025-12-31" }]);
    expect(lotForMonth(nifty, "2026-01")).toBe(65);
  });

  it("without a listed expiry in the old month the effective date is unknown", () => {
    expect(lotTransitions(nifty, { listedExpiries: [], cal })[0].effectiveFrom).toBe(null);
  });

  it("banner window: 7 days in, 8 out, 0 on the day, never after", () => {
    expect(bannerDue("2025-12-24", "2025-12-31", 7)).toBe(true);
    expect(bannerDue("2025-12-23", "2025-12-31", 7)).toBe(false);
    expect(bannerDue("2025-12-31", "2025-12-31", 7)).toBe(true);
    expect(bannerDue("2026-01-01", "2025-12-31", 7)).toBe(false);
    expect(bannerDue("2025-12-24", null, 7)).toBe(false);
  });

  it("a second fetch with a changed lot records the revision; history is never deleted", () => {
    const again = mergeLotHistory(merged.rows, { rows: [{ symbol: "NIFTY", kind: "index", lots: { "2026-02": 75 } }] }, { date: "2025-12-21", source: "x" });
    expect(again.revisions).toEqual([{ underlying: "NIFTY", expiryMonth: "2026-02", from: 65, to: 75 }]);
    expect(again.rows.length).toBe(merged.rows.length);
    const same = mergeLotHistory(again.rows, { rows: [{ symbol: "NIFTY", kind: "index", lots: { "2026-02": 75 } }] }, { date: "2025-12-22", source: "x" });
    expect(same.changed).toBe(false);
  });

  it("conflicts: master and reference lots that differ", () => {
    expect(lotConflict(75, 65)).toEqual({ master: 75, reference: 65 });
    expect(lotConflict(65, 65)).toBe(null);
    expect(lotConflict(65, null)).toBe(null);
  });
});

describe("universe intervals (§6.8)", () => {
  const cal = createCalendar({ holidays: [] });
  const prev = (d) => cal.prevTradingDay(d);
  const m = (syms) => syms.map((s) => ({ symbol: s, kind: "stock", exchange: "NFO" }));
  const first = updateUniverse(null, m(["ABC", "XYZ"]), "2026-10-29", prev).universe;
  const second = updateUniverse(first, m(["ABC"]), "2026-11-02", prev).universe;

  it("XYZ absent on 2 Nov closes on 30 Oct", () => {
    expect(second.knownSince).toBe("2026-10-29");
    expect(second.intervals.find((i) => i.symbol === "XYZ")).toMatchObject({ from: "2026-10-29", to: "2026-10-30", fromIsFirstFetch: true });
    expect(universeOn(second, "2026-11-01").items.map((i) => i.symbol)).toEqual(["ABC"]);
    expect(universeOn(second, "2026-10-30").items.map((i) => i.symbol)).toEqual(["ABC", "XYZ"]);
  });
  it("a date before the first fetch is not recorded (never today's list)", () => {
    expect(universeOn(second, "2026-10-01")).toEqual({ date: "2026-10-01", coverage: "not-recorded", knownSince: "2026-10-29", items: [] });
  });
  it("a symbol that comes back opens a new interval; changes list additions and removals", () => {
    const third = updateUniverse(second, m(["ABC", "XYZ", "NEW"]), "2026-11-05", prev).universe;
    expect(third.intervals.filter((i) => i.symbol === "XYZ").length).toBe(2);
    const ch = universeChanges(third, "2026-10-01", "2026-11-30", (d) => cal.nextTradingDay(d));
    expect(ch).toEqual([
      { date: "2026-11-05", symbol: "NEW", change: "added" },
      { date: "2026-11-05", symbol: "XYZ", change: "added" },
      { date: "2026-11-02", symbol: "XYZ", change: "removed" },
    ]);
  });
  it("members come from the market-lots file", () => {
    expect(membersFromMktLots(parseMktLots(fixture("fo_mktlots.csv"))).find((x) => x.symbol === "NIFTY")).toEqual({ symbol: "NIFTY", kind: "index", exchange: "NFO" });
  });
});
