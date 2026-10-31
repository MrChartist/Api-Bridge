/** Participant OI page view-models (participants.js; docs/spec/p1-12-guard-participants.md §6.7, §10.1). */
import { describe, expect, it } from "vitest";
import { buildSummary } from "../participants/metrics.mjs";
import { demoParticipantDay } from "../participants/demo.mjs";

// views.js imports desk.js, which imports oi.js, which imports participants.js: load the router first.
await import("./views.js");
const P = await import("./participants.js");

const ROWS = (fiiFut) => {
  const r = structuredClone(demoParticipantDay("2026-10-28").rows);
  if (fiiFut) {
    const d = [fiiFut[0] - r.FII.IDX_FUT[0], fiiFut[1] - r.FII.IDX_FUT[1]];
    r.FII.IDX_FUT = fiiFut;
    r.CLIENT.IDX_FUT = [r.CLIENT.IDX_FUT[0] - d[0], r.CLIENT.IDX_FUT[1] - d[1]];
  }
  return r;
};
const day = { date: "2026-10-28", rows: ROWS([112340, 248910]), quality: "ok" };
const prev = { date: "2026-10-27", rows: ROWS([118900, 239905]), quality: "ok" };
const summary = { available: true, ...buildSummary({ day, prev, history: [prev, day] }), source: "demo", fetchedAt: "2026-10-28T19:11:42.003+05:30", demo: true };

describe("participant page view-models", () => {
  it("tiles: FII long % with Δ pts and formula, nets with direction words and tones", () => {
    const t = P.tilesModel(summary);
    expect(t.map((x) => x.key)).toEqual(["fiiLongPct", "fiiNet", "clientCall", "clientPut", "proCall", "proPut"]);
    expect(t[0]).toMatchObject({ value: "31.1%", sub: "−2.04 pts vs 27 Oct", longPct: 31.1 });
    expect(t[0].title).toMatch(/FII held 31\.1% of their index-futures positions long/);
    expect(t[1]).toMatchObject({ value: "−1.37L", tone: "down", sub: "−15.6K vs 27 Oct · net short" });
    expect(t[1]).toMatchObject({ subMain: "−15.6K vs 27 Oct", subNote: "net short" });
  });

  it("table: participants × instruments, TOTAL without net, tones on net and Δ", () => {
    const m = P.tableModel(summary, "fut");
    expect(m.columns.map((c) => c.id)).toEqual(["IDX_FUT", "STK_FUT"]);
    expect(m.rows.map((r) => r.name)).toEqual(["Client", "DII", "FII", "Pro", "Total"]);
    const fii = m.rows[2].cells.IDX_FUT;
    expect(fii).toMatchObject({ long: "1.12L", short: "2.49L", net: "−1.37L", dnet: "−15.6K", netTone: "down", dTone: "down", longPctText: "31.1% long" });
    expect(fii.share).toMatch(/^\d+\.\d% of all longs · \d+\.\d% of all shorts$/);
    expect(P.tableModel(summary, "idxopt").columns.map((c) => c.id)).toEqual(["IDX_CE", "IDX_PE"]);
    expect(P.tableModel(summary, "stkopt").columns.map((c) => c.id)).toEqual(["STK_CE", "STK_PE"]);
    // Every table is two instruments × four columns, so none needs sideways scroll from 1024 px up.
    expect(P.PT_GROUPS.every((g) => g.instruments.length === 2)).toBe(true);
  });

  it("phone cards for one instrument, with the total line", () => {
    const c = P.cardsModel(summary, "IDX_FUT");
    expect(c.cards.map((x) => x.name)).toEqual(["Client", "DII", "FII", "Pro"]);
    expect(c.total).toMatch(/^Total open interest: .+ contracts each side$/);
  });

  it("page states: source off, no data, stale", () => {
    expect(P.pageState(summary).kind).toBe("ok");
    expect(P.pageState({ available: false, reason: "SOURCE_OFF" }, null, { hasCalendar: true })).toMatchObject({ kind: "source-off", text: expect.stringMatching(/Market calendar page/) });
    expect(P.pageState({ available: false, reason: "SOURCE_OFF" }).text).not.toMatch(/Market calendar/);
    const nd = P.pageState({ available: false, reason: "NO_PARTICIPANT_DATA" }, { nextRunAt: "2026-10-30T19:12:30.000+05:30", backfill: { target: 500, have: 312, noFile: 0, running: true } });
    expect(nd.text).toMatch(/Next check: 30 Oct, 19:12 IST\./);
    expect(nd.text).not.toMatch(/today/);
    expect(nd.note).toBe("History: 312 of 500 trading days (filling in)");
    expect(P.pageState({ available: false, reason: "NO_PARTICIPANT_DATA" }, { backfill: { target: 500, have: 0, running: false } }).note).toBe("");
    expect(P.pageState({ available: false, reason: "PARTICIPANT_STALE", detail: "old" })).toMatchObject({ kind: "stale", text: "old" });
    const nh = P.pageState({ available: false, reason: "SOURCE_UNAVAILABLE", detail: "Reference data is not running on this Bridge." }, null, { hasCalendar: true });
    expect(nh).toMatchObject({ kind: "not-here", title: "Participant OI is not available on this Bridge" });
    expect(nh.text).not.toMatch(/Turn on|nseArchives/);
    expect(P.topLine(summary)).toBe("NSE only · all strikes and expiries · number of contracts · for the day ended 28 Oct");
    expect(P.backfillText({ backfill: { target: 500, have: 487, noFile: 13 } })).toBe("History: 487 of 500 trading days; 13 not available from NSE");
  });

  it("history: weekday axis, gaps for days without a file, range, revisions", () => {
    const days = [];
    for (const d of ["2026-10-19", "2026-10-20", "2026-10-22", "2026-10-23", "2026-10-26"]) days.push({ date: d, rows: ROWS(), lotRegime: d >= "2026-10-22" ? "B" : "A" });
    const revs = P.revisionsFrom(days, { revisions: [] });
    expect(revs).toEqual([{ date: "2026-10-22", text: expect.stringMatching(/not like for like/) }]);
    const m = P.historyModel(days, "all", revs);
    expect(m.slots).toBe(6); // 19–26 Oct on weekdays: 19, 20, 21, 22, 23, 26
    expect(m.gaps).toBe(1);
    expect(m.series[0].points.map((p) => p.i)).toEqual([0, 1, 3, 4, 5]);
    expect(m.revisions).toEqual([{ i: 3, date: "2026-10-22", text: revs[0].text }]);
    expect(P.historyModel(days, "20", []).dates).toHaveLength(5);
    const g = P.sparkGeometry(m.series[1].points, m.slots, { w: 300, h: 100, kind: "net" });
    expect(g.d.match(/M/g)).toHaveLength(2); // the missing 21 Oct breaks the line
    // A small multiple always has a readable scale: at least three ticks, all inside the plotted range.
    for (const vals of [[380_000, 410_000, 395_000], [-104_000, -98_000, -101_000], [0.5, 0.7], [1, 1]]) {
      const pts = vals.map((value, i) => ({ i, value }));
      const gg = P.sparkGeometry(pts, vals.length, { w: 300, h: 136, kind: "net" });
      expect(gg.ticks.length).toBeGreaterThanOrEqual(3);
      expect(gg.ticks.every((t) => t >= gg.lo - 1e-9 && t <= gg.hi + 1e-9)).toBe(true);
    }
    const csv = P.historyCsv(m);
    expect(csv[0]).toEqual(["date", "FII index futures long %", "FII index futures net", "Client index calls net", "Client index puts net"]);
    expect(csv).toHaveLength(6);
    expect(P.toCsvText([["a", "b,c"]])).toBe('a,"b,c"\r\n');
  });

  it("the OI page line: NSE figure, BSE note, nothing without data", () => {
    expect(P.oiTileText(summary, "NIFTY")).toMatchObject({ text: "FII index futures (28 Oct): 31.1% long (−2.0 pts)", main: "FII index futures (28 Oct): 31.1% long", delta: "(−2.0 pts)", tone: "", stale: false });
    // An old latest file says so in the visible line, not only in the hover title.
    const old = P.oiTileText({ ...summary, stale: true, expectedDate: "2026-10-30" }, "NIFTY");
    expect(old).toMatchObject({ text: "FII index futures (28 Oct): 31.1% long (−2.0 pts) · not current", flag: "not current", stale: true });
    expect(old.title).toMatch(/newer file \(30 Oct\) has not been fetched/);
    expect(P.oiTileText(summary, "SENSEX").text).toBe("No BSE participant file");
    expect(P.oiTileText(null, "NIFTY")).toBeNull();
    expect(P.oiTileText({ available: false, detail: "x" }, "NIFTY").text).toBe("Participant OI not available yet");
  });

  it("back-fill line says when the back-fill is paused", () => {
    expect(P.backfillText({ backfill: { target: 500, have: 40, noFile: 0, running: false, pausedUntil: "2026-10-29T17:30:00.000+05:30" } })).toBe("History: 40 of 500 trading days; paused while NSE is not answering (next try 29 Oct, 17:30 IST)");
  });

  it("totals-mismatch chip names the instruments in its text", () => {
    expect(P.mismatchText({ mismatches: ["IDX_CE", "STK_PE"] })).toBe("NSE totals did not add up for Index CE, Stock PE on this day; shown as published");
    expect(P.mismatchText({})).toBe("NSE totals did not add up on this day; shown as published");
  });

  it("stale latest file: a warning line naming the day and the expected one", () => {
    expect(P.staleText(summary)).toBe("");
    expect(P.staleText({ ...summary, stale: true, expectedDate: "2026-10-30" })).toBe("Latest file is for 28 Oct; NSE's newer file (30 Oct) has not been fetched");
  });

  it("ranges across years keep the year on both ends", () => {
    expect(P.rangeEnds("2026-10-01", "2026-10-29")).toEqual(["1 Oct", "29 Oct"]);
    expect(P.rangeEnds("2024-10-10", "2026-10-29")).toEqual(["10 Oct 2024", "29 Oct 2026"]);
  });

  it("the OI line's summary: one request per 60 s after a failure, one per 10 min after a success", async () => {
    P.resetParticipantSummaryCache();
    let n = 0;
    const failing = async () => {
      n += 1;
      throw new Error("down");
    };
    expect(await P.participantSummaryCached(1_000_000, failing)).toBeNull();
    expect(await P.participantSummaryCached(1_030_000, failing)).toBeNull();
    expect(n).toBe(1);
    await P.participantSummaryCached(1_061_000, failing);
    expect(n).toBe(2);
    let m = 0;
    const ok = async () => {
      m += 1;
      return { data: { data: summary } };
    };
    P.resetParticipantSummaryCache();
    expect(await P.participantSummaryCached(2_000_000, ok)).toBe(summary);
    expect(await P.participantSummaryCached(2_500_000, ok)).toBe(summary);
    expect(m).toBe(1);
    P.resetParticipantSummaryCache();
  });
});

describe("participant hero reading", () => {
  it("leads with FII index futures' long share, red when more short than long, and names the biggest shift", () => {
    const r = P.heroReading(summary);
    expect(r).toMatchObject({ word: "FIIs 31.1% long in index futures", tone: "neg" });
    expect(r.detail).toMatch(/^Down 2\.04 pts against 27 Oct\. Their net position is −1\.37L contracts \(net short\), −15\.6K on the day\./);
    const biggest = Math.max(...summary.table.filter((x) => x.participant !== "TOTAL" && Number.isFinite(x.netChange)).map((x) => Math.abs(x.netChange)));
    expect(Math.abs(r.shift.change)).toBe(biggest);
    expect(r.detail).toContain("The day's biggest shift:");
  });
  it("says so when the day has no headline", () => {
    expect(P.heroReading({ table: [] })).toMatchObject({ word: "FII index futures", tone: "zero", detail: "No headline figures in this day's file.", shift: null });
  });
});
