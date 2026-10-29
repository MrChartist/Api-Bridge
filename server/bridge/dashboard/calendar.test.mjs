/** Market calendar page maths (calendar.js, docs/spec/p1-02-reference.md §5.5, §9.4). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSource } from "./copyRules.mjs";

// views.js imports desk.js and calendar.js (the router): load it first so the circular import settles as in the browser.
await import("./views.js");
const { CAL_DISCLAIMER, CSV_COLUMNS, addMonths, calendarEvents, cellLabel, cellMarks, chargeRows, monthGrid, monthList, monthMode, mwplView, previewBody, runPreview, stateWord, statusTiles, strikesAround, toCsv, universeNote } = await import("./calendar.js");
const { PAGES } = await import("./views.js");
const { exampleStrikeGrid } = await import("../reference/corporateActions.mjs");

const HOLIDAYS = [
  { date: "2026-11-10", label: "Diwali Balipratipada", exchanges: ["NSE", "BSE"], verified: false },
  { date: "2026-11-24", label: "Prakash Gurpurb Sri Guru Nanak Dev", exchanges: ["NSE", "BSE"], verified: true },
];
const EXPIRIES = [
  { date: "2026-11-03", kind: "weekly", lot: 65, shifted: false },
  { date: "2026-11-09", kind: "weekly", lot: 65, shifted: true, ruleDate: "2026-11-10" },
  { date: "2026-11-23", kind: "monthly", lot: 65, shifted: true, ruleDate: "2026-11-24" },
];
const SPECIALS = [{ date: "2026-11-08", label: "Muhurat trading", open: "18:00", close: "19:00" }];

describe("month calendar", () => {
  const weeks = monthGrid("2026-11", { holidays: HOLIDAYS, expiries: EXPIRIES, specials: SPECIALS, today: "2026-11-03" });
  const cell = (d) => weeks.flat().find((c) => c.date === d);

  it("lays the month out Monday first in whole weeks", () => {
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 1 Nov 2026 is a Sunday: the grid starts on Mon 26 Oct.
    expect(weeks[0][0]).toMatchObject({ date: "2026-10-26", inMonth: false });
    expect(weeks[0][6]).toMatchObject({ date: "2026-11-01", inMonth: true, weekend: true, trading: false });
    expect(weeks.flat().filter((c) => c.inMonth)).toHaveLength(30);
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("marks holidays, special sessions, expiries and shifted expiries", () => {
    expect(cell("2026-11-10")).toMatchObject({ holiday: { label: "Diwali Balipratipada", verified: false }, trading: false });
    expect(cell("2026-11-08")).toMatchObject({ special: { label: "Muhurat trading", open: "18:00" }, trading: true });
    expect(cell("2026-11-09").expiry).toMatchObject({ kind: "weekly", shifted: true, ruleDate: "2026-11-10" });
    expect(cell("2026-11-10").movedTo).toBe("2026-11-09");
    expect(cell("2026-11-23").expiry.kind).toBe("monthly");
    expect(cell("2026-11-03").today).toBe(true);
    expect(cell("2026-11-04")).toMatchObject({ trading: true, holiday: null, expiry: null });
  });

  it("keeps grid marks short, with the full text as a tooltip and in the cell's label", () => {
    expect(cellMarks(cell("2026-11-09")).map((m) => m.text)).toEqual(["Weekly", "from Tue 10"]);
    expect(cellMarks(cell("2026-11-09"))[0].full).toBe("Weekly expiry, lot 65");
    expect(cellMarks(cell("2026-11-10")).map((m) => [m.kind, m.text])).toEqual([["hol", "Diwali Balipratipada"], ["hol-u", "unverified"]]);
    expect(cellMarks(cell("2026-11-08")).map((m) => m.text)).toEqual(["Muhurat trading", "18:00–19:00"]);
    expect(cellLabel(cell("2026-11-08"))).toBe("Sun 8 Nov 2026, special session, Muhurat trading 18:00 to 19:00 IST");
    expect(cellLabel(cell("2026-11-09"))).toBe("Mon 9 Nov 2026, trading day, weekly expiry, lot 65, moved from Tue 10 Nov");
    expect(cellLabel(cell("2026-11-10"))).toBe("Tue 10 Nov 2026, holiday, Diwali Balipratipada, unverified");
    expect(cellLabel(cell("2026-11-03"))).toContain(", today");
    // Today shown outside the month (the leading or trailing days) is not announced or ringed as today.
    const dec = monthGrid("2026-12", { today: "2026-11-30" });
    const out = dec.flat().find((c) => c.date === "2026-11-30");
    expect(out.inMonth).toBe(false);
    expect(cellLabel(out)).not.toContain("today");
  });

  it("labels banners for other underlyings as market-wide", () => {
    const items = [
      { kind: "corporate-action", underlying: "CIPLA", effectiveOn: "2026-11-04", daysAway: 6, text: "CIPLA 1:1 bonus, ex-date 4 Nov." },
      { kind: "holiday-expiry-shift", underlying: "NIFTY", effectiveOn: "2026-11-09", daysAway: 7, text: "NIFTY weekly expiry is on 9 Nov." },
    ];
    const ev = calendarEvents(items, "NIFTY");
    expect(ev.map((e) => e.text)).toEqual(["NIFTY weekly expiry is on 9 Nov.", "Across F&O: CIPLA 1:1 bonus, ex-date 4 Nov."]);
  });

  it("is a list of the non-ordinary days on a 360 px phone and a grid from 720 px", () => {
    expect(monthMode(360)).toBe("list");
    expect(monthMode(390)).toBe("list");
    expect(monthMode(720)).toBe("grid");
    expect(monthMode(1440)).toBe("grid");
    const list = monthList(weeks);
    expect(list.map((x) => x.date)).toEqual(["2026-11-03", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-23", "2026-11-24"]);
    expect(list.find((x) => x.date === "2026-11-09").notes[0].text).toBe("Weekly expiry (moved from Tue 10 Nov)");
    expect(list.find((x) => x.date === "2026-11-10").notes.map((n) => n.text)).toEqual(["Diwali Balipratipada (unverified)"]);
    expect(list.find((x) => x.date === "2026-11-08").notes[0].text).toBe("Muhurat trading 18:00–19:00");
  });
});

describe("status strip", () => {
  it("says Current, n days old, Stale, Off or Not fetched", () => {
    const today = "2026-10-29";
    expect(stateWord({ available: true, asOf: "2026-10-29", stale: false }, { today })).toBe("Current");
    expect(stateWord({ available: true, asOf: "2026-10-28", stale: false }, { today })).toBe("1 day old");
    expect(stateWord({ available: true, asOf: "2026-10-26", stale: true }, { today })).toBe("Stale");
    expect(stateWord({ available: false, asOf: null, error: { code: "SOURCE_OFF" } }, { today })).toBe("Off");
    expect(stateWord({ available: false, asOf: null, error: null }, { today })).toBe("Not fetched");
    // The real status() shape on a fresh install with archives off: reason, no error (no sync attempt has run).
    expect(stateWord({ available: false, reason: "SOURCE_OFF", asOf: null, error: null }, { today })).toBe("Off");
    expect(stateWord({ available: false, reason: "NEVER_FETCHED", asOf: null, error: null }, { today })).toBe("Not fetched");
    expect(stateWord({ available: false, reason: "PARSE_FAILED", asOf: null, error: { code: "PARSE_FAILED" } }, { today })).toBe("Parse failed");
    expect(statusTiles({ datasets: { ban: { available: false, reason: "PARSE_FAILED", asOf: null, error: null } } }, { today })[1]).toMatchObject({ word: "Parse failed", tone: "warn" });
    expect(stateWord(null)).toBe("Not fetched");
    const tiles = statusTiles({ datasets: { lots: { available: true, asOf: "2026-10-29", source: "demo", stale: false }, rate: { available: true, quality: "default", stale: true } } }, { today });
    expect(tiles.map((t) => t.id)).toEqual(["lots", "ban", "mwpl", "universe", "holidays", "rate"]);
    expect(tiles[0]).toMatchObject({ word: "Current", tone: "ok" });
    expect(tiles[0].detail).toContain("Source: demo");
    expect(tiles[5]).toMatchObject({ word: "Default", tone: "warn" });
  });
});

describe("CSV export", () => {
  it("has a header row per panel and quotes where needed", () => {
    expect(CSV_COLUMNS.expiries.map((c) => c[0])).toEqual(["date", "kind", "lot", "shifted", "usual_date", "source"]);
    expect(CSV_COLUMNS.mwpl.map((c) => c[0])).toEqual(["symbol", "mwpl_pct", "band", "oi", "mwpl", "limit_next_day"]);
    expect(CSV_COLUMNS.calendar.map((c) => c[0])).toEqual(["date", "trading_day", "holiday", "holiday_verified", "special_session", "expiry", "expiry_moved_from"]);
    expect(Object.keys(CSV_COLUMNS)).toEqual(["calendar", "expiries", "lots", "mwpl", "universe", "actions", "charges"]);
    const csv = toCsv(CSV_COLUMNS.expiries, EXPIRIES.map((e) => ({ ...e, source: "demo, NSE" })));
    expect(csv.split("\n")[0]).toBe("date,kind,lot,shifted,usual_date,source");
    expect(csv.split("\n")[2]).toBe('2026-11-09,weekly,65,yes,2026-11-10,"demo, NSE"');
    expect(toCsv([["a", (r) => r.a]], [{ a: 'say "x"' }])).toBe('a\n"say ""x"""');
    const cal = toCsv(CSV_COLUMNS.calendar, monthGrid("2026-11", { holidays: HOLIDAYS, expiries: EXPIRIES }).flat().filter((c) => c.inMonth));
    expect(cal.split("\n")).toHaveLength(31);
    expect(cal).toContain("2026-11-24,no,Prakash Gurpurb Sri Guru Nanak Dev,yes,,,");
  });
});

describe("ban list, universe and charges", () => {
  it("filters and sorts the MWPL table", () => {
    const items = [{ symbol: "SBIN", mwplPct: 98.7, band: "ban" }, { symbol: "ITC", mwplPct: 30, band: "normal" }, { symbol: "ICICIBANK", mwplPct: 88.3, band: "high" }];
    expect(mwplView(items).map((x) => x.symbol)).toEqual(["SBIN", "ICICIBANK", "ITC"]);
    expect(mwplView(items, { sort: "symbol" }).map((x) => x.symbol)).toEqual(["ICICIBANK", "ITC", "SBIN"]);
    expect(mwplView(items, { query: "ic" }).map((x) => x.symbol)).toEqual(["ICICIBANK"]);
  });
  it("says when membership was not recorded", () => {
    expect(universeNote({ coverage: "not-recorded", knownSince: "2026-10-29" })).toEqual({ recorded: false, text: "Not recorded on this Bridge before 29 Oct 2026" });
    expect(universeNote({ coverage: "recorded", date: "2026-10-29", knownSince: "2026-07-01", count: 53 }).text).toBe("53 underlyings on 29 Oct 2026 · recorded since 1 Jul 2026");
  });
  it("lists the charge table with neutral labels", () => {
    const rows = chargeRows({ opt: { sttSell: 0.0015, exerciseStt: 0.0015, stampBuy: 0.00003, txn: { NSE: 0.0003503, BSE: 0.000325 } }, fut: { sttSell: 0.0005, stampBuy: 0.00002, txn: { NSE: 0.0000173, BSE: 0 } }, sebiPerCrore: 10, ipftPerCrore: 0, gst: 0.18, brokerage: { kind: "flat", perOrder: 20 } });
    expect(rows[0]).toMatchObject({ v: "0.15 %", raw: 0.0015 });
    expect(rows.find((r) => r.k === "GST").v).toBe("18 %");
    expect(rows.at(-1).v).toBe("₹20 per order");
  });
});

describe("corporate-action preview wiring", () => {
  it("builds the preview body for each type, and says what is missing", () => {
    expect(previewBody({ type: "bonus", ratioNew: "1", ratioHeld: "1", lot: "250", strikes: ["2800", "2820"] }).body).toEqual({ type: "bonus", strikeTick: 0.05, lot: 250, strikes: [2800, 2820], ratio: { new: 1, held: 1 } });
    expect(previewBody({ type: "split", fvFrom: "10", fvTo: "2" }).body).toMatchObject({ fv: { from: 10, to: 2 } });
    expect(previewBody({ type: "rights", ratioNew: 1, ratioHeld: 5, subscriptionPrice: 100, cumPrice: 250 }).body).toMatchObject({ subscriptionPrice: 100, cumPrice: 250 });
    expect(previewBody({ type: "dividend", dividend: 40, cumPrice: 1000 }).body).toMatchObject({ dividend: 40, cumPrice: 1000 });
    expect(previewBody({ type: "rights", ratioNew: 1, ratioHeld: 5 }).error).toBe("Enter the subscription price and the cum price.");
    expect(previewBody({ type: "" }).error).toBe("Choose the action type.");
    expect(strikesAround(2805)).toEqual([2760, 2780, 2800, 2820, 2840]);
    expect(strikesAround(null)).toEqual([]);
    // Same grid as the server's example strikes, so the preview and the saved card agree.
    for (const p of [1515, 2805, 640, 120]) expect(strikesAround(p)).toEqual(exampleStrikeGrid(p));
  });

  it("posts the body to the preview route and returns its answer (example 1: RELIANCE 1:1 bonus)", async () => {
    const sent = [];
    const post = async (body) => (sent.push(body), { factor: 2, lotAfter: 500, strikes: [{ before: 2800, after: 1400 }, { before: 2820, after: 1410 }] });
    const r = await runPreview({ type: "bonus", ratioNew: 1, ratioHeld: 1, lot: 250, strikes: [2800, 2820] }, { post });
    expect(sent).toEqual([{ type: "bonus", strikeTick: 0.05, lot: 250, strikes: [2800, 2820], ratio: { new: 1, held: 1 } }]);
    expect(r.data.strikes.map((s) => s.after)).toEqual([1400, 1410]);
    expect(await runPreview({ type: "bonus" }, { post })).toEqual({ error: "Enter the ratio (new for held)." });
    expect(sent).toHaveLength(1);
    expect(await runPreview({ type: "bonus", ratioNew: 1, ratioHeld: 1 }, { post: async () => Promise.reject(new Error("Bad ratio")) })).toEqual({ error: "Bad ratio" });
  });
});

describe("page registration and copy", () => {
  it("is an Options page with a calendar glyph", () => {
    expect(PAGES.find((p) => p.id === "calendar")).toMatchObject({ label: "Market calendar", icon: "calendar", group: "Options", layout: "desk" });
  });
  it("describes facts only and carries the disclaimer", () => {
    expect(checkSource(readFileSync(new URL("./calendar.js", import.meta.url), "utf8"))).toEqual([]);
    expect(CAL_DISCLAIMER).toBe("Reference data from the sources shown. Check exchange circulars before acting. Not investment advice.");
  });
});
