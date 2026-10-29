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
    expect(t[0]).toMatchObject({ value: "31.10%", sub: "-2.04 pts vs 27 Oct", longPct: 31.1 });
    expect(t[0].title).toMatch(/FII held 31\.1 % of their index-futures positions long/);
    expect(t[1]).toMatchObject({ value: "-1.37L", tone: "down", sub: "-15.6K vs 27 Oct · net short" });
  });

  it("table: participants × instruments, TOTAL without net, tones on net and Δ", () => {
    const m = P.tableModel(summary, "fut");
    expect(m.columns.map((c) => c.id)).toEqual(["IDX_FUT", "STK_FUT"]);
    expect(m.rows.map((r) => r.name)).toEqual(["Client", "DII", "FII", "Pro", "Total"]);
    const fii = m.rows[2].cells.IDX_FUT;
    expect(fii).toMatchObject({ long: "1.12L", short: "2.49L", net: "-1.37L", dnet: "-15.6K", netTone: "down", dTone: "down", longPctText: "31.1% long" });
    expect(fii.share).toMatch(/^\d+\.\d% of all longs · \d+\.\d% of all shorts$/);
    expect(P.tableModel(summary, "opt").columns).toHaveLength(4);
  });

  it("phone cards for one instrument, with the total line", () => {
    const c = P.cardsModel(summary, "IDX_FUT");
    expect(c.cards.map((x) => x.name)).toEqual(["Client", "DII", "FII", "Pro"]);
    expect(c.total).toMatch(/^Total open interest: .+ contracts each side$/);
  });

  it("page states: source off, no data, stale", () => {
    expect(P.pageState(summary).kind).toBe("ok");
    expect(P.pageState({ available: false, reason: "SOURCE_OFF" })).toMatchObject({ kind: "source-off", text: expect.stringMatching(/Market calendar/) });
    expect(P.pageState({ available: false, reason: "NO_PARTICIPANT_DATA" }).text).toMatch(/after 19:10/);
    expect(P.pageState({ available: false, reason: "PARTICIPANT_STALE", detail: "old" })).toMatchObject({ kind: "stale", text: "old" });
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
    const csv = P.historyCsv(m);
    expect(csv[0]).toEqual(["date", "FII index futures long %", "FII index futures net", "Client index calls net", "Client index puts net"]);
    expect(csv).toHaveLength(6);
    expect(P.toCsvText([["a", "b,c"]])).toBe('a,"b,c"\r\n');
  });

  it("the OI page line: NSE figure, BSE note, nothing without data", () => {
    expect(P.oiTileText(summary, "NIFTY")).toMatchObject({ text: "FII index futures: 31.1% long (-2.0 pts)", tone: "down" });
    expect(P.oiTileText(summary, "SENSEX").text).toMatch(/^No BSE participant file/);
    expect(P.oiTileText(null, "NIFTY")).toBeNull();
    expect(P.oiTileText({ available: false, detail: "x" }, "NIFTY").text).toBe("Participant OI not available yet");
  });
});
