/**
 * Data recorder page view-model (recorder.js; docs/spec/p1-01-recorder.md §7.1, §9): state → pill text, tiles,
 * coverage rows (refused below), budget and disk text, the plan verdict, the settings body, "Use what fits", the
 * stock search, the phone stacking flag, and neutral copy (copyRules.mjs) with the footer disclaimer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSource } from "./copyRules.mjs";
import {
  DEMO_FOOTER,
  FOOTER,
  budgetModel,
  bytesText,
  coverageCounts,
  coverageRows,
  diskModel,
  fitToCarry,
  formBody,
  formFrom,
  gapRange,
  gapReason,
  stackCoverage,
  statePill,
  stocksFromSearch,
  tilesModel,
  verdictView,
} from "./recorder.js";

const STATUS = {
  state: "degraded",
  stateDetail: "Recording 2 index chains (2 by stream) and 0 stocks. 1 chain could not be recorded.",
  demo: false,
  account: { id: "dhan-main", broker: "dhan", chosen: "config", session: "connected", feedAccount: "dhan-main", costNote: "Dhan data APIs may need a paid plan." },
  session: { tradingDay: true, open: true, start: "09:15", end: "15:30" },
  plan: {
    chains: [
      { underlying: "NIFTY", expiry: "2026-11-03", kind: "index", everyMinutes: 1, strikesEachSide: 40, source: "stream" },
      { underlying: "BANKNIFTY", expiry: "2026-11-24", kind: "index", everyMinutes: 1, strikesEachSide: 40, source: "stream" },
    ],
    refused: [{ underlying: "TATASTEEL", expiry: "2026-11-24", reason: "capacity", detail: "Feed room left: 66 legs; this chain needs 62 plus 2 futures and spot." }],
    capacity: { stream: { cap: 3000, used: 2934, feedLimit: 5000, share: 0.6 }, rest: { endpointClass: "chain", allowed: false, why: "Dhan option chain is 1 request/s: recording on it could delay your own chain requests by up to 1 s." } },
  },
  budget: { restCallsLastMinute: 0, restCapPerMinute: 0, brokerPerMinute: 20, share: 0.5 },
  today: { snapshots: 1098, legRows: 177876, gapSlots: 3, lastSnapshotAt: "2026-10-29T10:15:01.412+05:30" },
  disk: { bytes: 1238000000, todayBytes: 18100000, days: 31, oldestDay: "2026-09-29", retentionDays: 365, maxBytes: 10737418240, freeBytes: 182000000000 },
  coverage: [
    { underlying: "NIFTY", expiry: "2026-11-03", source: "stream", expectedSlots: 61, recordedSlots: 58, gapSlots: 3, lastSlot: "2026-10-29T10:15:00.000+05:30", lastAgeMs: 1412, gaps: [{ from: Date.parse("2026-10-29T10:41:00+05:30"), to: Date.parse("2026-10-29T10:43:00+05:30"), slots: 3, reason: "stream-down", detail: "Dhan feed stale for 74 s" }] },
    { underlying: "BANKNIFTY", expiry: "2026-11-24", source: "stream", expectedSlots: 61, recordedSlots: 61, gapSlots: 0, lastSlot: "2026-10-29T10:15:00.000+05:30", lastAgeMs: 1500, gaps: [] },
  ],
  sources: { stream: true, rest: true, nseBackup: false },
  settings: { enabled: true, account: "dhan-main", indices: ["NIFTY", "BANKNIFTY"], indexExpiries: 1, indexStrikes: 40, stocks: ["TATASTEEL"], stockStrikes: 15, stockEveryMinutes: 5, budgetShare: 0.5, streamShare: 0.6, retentionDays: 365, sources: { stream: true, rest: true, nseBackup: false } },
  warnings: [],
};

describe("state, tiles and coverage", () => {
  it("names every state with a tone (no colour-only meaning)", () => {
    expect(statePill("recording")).toEqual({ text: "Recording", tone: "ok" });
    expect(statePill("idle-closed")).toEqual({ text: "Market closed", tone: "" });
    expect(statePill("paused").text).toBe("Paused");
    expect(statePill("holiday-suspected")).toEqual({ text: "Holiday suspected", tone: "warn" });
    expect(statePill("not-configured").text).toBe("Not configured");
    expect(statePill("degraded").tone).toBe("warn");
    expect(statePill("disk-full")).toEqual({ text: "Disk full", tone: "bad" });
    expect(statePill("something-new").text).toBe("something-new");
  });

  it("four tiles: state, feeding account, today, disk", () => {
    const t = tilesModel(STATUS);
    expect(t.map((x) => x.key)).toEqual(["state", "account", "today", "disk"]);
    expect(t[0]).toMatchObject({ value: "Degraded", tone: "warn", sub: STATUS.stateDetail });
    expect(t[1].value).toBe("dhan-main");
    expect(t[1].sub).toBe("Dhan · chosen · connected. Dhan data APIs may need a paid plan.");
    expect(t[2].value).toBe("1098");
    expect(t[2].sub).toBe("snapshots · 177876 leg rows · 3 gap minutes · last 10:15:01");
    expect(t[3].value).toBe("1.2 GB");
    expect(t[3].sub).toMatch(/^17\.3 MB today · 31 days kept of 365 · 170 GB free$/);
    // A restricted key sees no account id: "Hidden", never the id.
    expect(tilesModel({ ...STATUS, account: { ...STATUS.account, id: null, broker: null } })[1].value).toBe("Hidden");
    expect(tilesModel({ ...STATUS, account: null })[1].value).toBe("None");
  });

  it("bytes in binary units without grouping", () => {
    expect(bytesText(512)).toBe("512 B");
    expect(bytesText(41725013)).toBe("39.8 MB");
    expect(bytesText(10737418240)).toBe("10.0 GB");
    expect(bytesText(182000000000)).toBe("170 GB");
    expect(bytesText(null)).toBe("–");
  });

  it("coverage rows, refused chains last with the reason", () => {
    const rows = coverageRows(STATUS);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ underlying: "NIFTY", expiryText: "3 Nov", every: "1 min", source: "Stream", strikes: "±40", recText: "58 / 61 min", gapText: "3 min", tone: "warn", last: "10:15:00", lastAge: "1 s old", refused: false });
    expect(rows[0].lastGap).toBe("10:41–10:43 feed down");
    expect(rows[1]).toMatchObject({ recText: "61 / 61 min", gapText: "None", tone: "ok" });
    expect(rows[2]).toMatchObject({ refused: true, underlying: "TATASTEEL", reason: "Over capacity", detail: expect.stringMatching(/^Feed room left/) });
    expect(coverageRows({ plan: { refused: [{ underlying: "BANKEX", expiry: null, reason: "not-offered", detail: "x" }] } })[0]).toMatchObject({ expiryText: "All expiries", reason: "Not offered" });
    expect(coverageCounts(rows)).toBe("2 chains recording · 1 not recorded");
  });

  it("minutes, not slots: a 5-minute chain and the demo's 5-minute night", () => {
    const st = {
      plan: { chains: [{ underlying: "SBIN", expiry: "2026-11-24", kind: "stock", everyMinutes: 5, strikesEachSide: 15, source: "rest" }] },
      coverage: [
        // The server's minutes (the status sends them): 10 slots from 00:00 at 5 minutes = 50 minutes.
        { underlying: "NIFTY", expiry: "2026-11-03", kind: "index", source: "rest", everyMinutes: 1, everyMinutesNow: 5, expectedSlots: 10, recordedSlots: 9, gapSlots: 1, expectedMinutes: 50, recordedMinutes: 45, gapMinutes: 5, gaps: [{ from: 1, to: 1, slots: 1, minutes: 5, reason: "budget" }] },
        // An older status without *Minutes: slots × everyMinutes.
        { underlying: "SBIN", expiry: "2026-11-24", source: "rest", expectedSlots: 2, recordedSlots: 2, gapSlots: 0, gaps: [] },
      ],
    };
    const [nifty, sbin] = coverageRows(st);
    expect(nifty).toMatchObject({ every: "5 min", recText: "45 / 50 min", gapText: "5 min", tone: "warn" });
    expect(nifty.gaps[0].minutes).toBe(5);
    expect(sbin).toMatchObject({ kind: "stock", every: "5 min", recText: "10 / 10 min", gapText: "None", tone: "ok" });
    expect(tilesModel({ today: { snapshots: 9, legRows: 0, gapSlots: 1, gapMinutes: 5 } })[2].sub).toMatch(/· 5 gap minutes ·/);
  });

  it("chains not due yet read as waiting, with no bar, counted apart", () => {
    const rows = coverageRows({ coverage: [{ underlying: "NIFTY", expiry: "2026-11-03", expectedSlots: 10, recordedSlots: 10, gapSlots: 0 }, { underlying: "BANKNIFTY", expiry: "2027-01-26", expectedSlots: 0, recordedSlots: 0, gapSlots: 0 }] });
    expect(rows[1]).toMatchObject({ waiting: true, recText: "Not due yet", gapText: "–", ratio: null });
    expect(coverageCounts(rows)).toBe("1 chain recording · 1 waiting");
  });

  it("rows group by kind, index priority and expiry, whatever order the status lists them in", () => {
    const row = (underlying, expiry, kind = "index") => ({ underlying, expiry, kind, expectedSlots: 1, recordedSlots: 1, gapSlots: 0 });
    const rows = coverageRows({
      coverage: [row("NIFTY", "2026-11-03"), row("SENSEX", "2026-11-05"), row("SBIN", "2026-11-24", "stock"), row("INFY", "2026-11-24", "stock"), row("NIFTY", "2026-11-24"), row("BANKNIFTY", "2026-11-24"), row("SENSEX", "2026-11-26"), row("NIFTY", "2026-11-10")],
      plan: { refused: [{ underlying: "BANKEX", expiry: null, reason: "not-offered" }] },
    });
    expect(rows.map((r) => `${r.underlying} ${r.expiry ?? ""}`.trim())).toEqual(["NIFTY 2026-11-03", "NIFTY 2026-11-10", "NIFTY 2026-11-24", "BANKNIFTY 2026-11-24", "SENSEX 2026-11-05", "SENSEX 2026-11-26", "INFY 2026-11-24", "SBIN 2026-11-24", "BANKEX"]);
  });

  it("gap ranges and reasons in plain words", () => {
    expect(gapRange({ from: "2026-10-29T10:41:00.000+05:30", to: "2026-10-29T10:43:00.000+05:30" })).toBe("10:41–10:43");
    expect(gapRange({ from: Date.parse("2026-10-29T10:41:00+05:30"), to: Date.parse("2026-10-29T10:41:00+05:30") })).toBe("10:41");
    expect(gapRange({ from: "nope" })).toBe("–");
    expect(gapReason("bridge-down")).toBe("Bridge not running");
    expect(gapReason("budget")).toBe("REST budget used");
  });
});

describe("budget, disk and verdict", () => {
  it("feed meter with its share; REST off with the one-line reason", () => {
    const b = budgetModel(STATUS);
    expect(b.feed).toEqual({ used: 2934, cap: 3000, text: "2934 of 3000 (60% of 5000)" });
    expect(b.rest).toBeNull();
    expect(b.restWhy).toMatch(/^Dhan option chain is 1 request\/s/);
    const on = budgetModel({ ...STATUS, plan: { capacity: { stream: { cap: 0 }, rest: { allowed: true } } }, budget: { restCallsLastMinute: 9, restCapPerMinute: 10, brokerPerMinute: 20, share: 0.5, plannedPerMinute: 9 } });
    expect(on.rest.text).toBe("9 of 10 calls/min (50% of 20)");
    expect(on.feed).toBeNull();
    expect(on.feedNote).toMatch(/no live feed/);
    expect(on.planned).toBe("Planned: 9 calls a minute. Your own requests always go first.");
  });

  it("disk lines", () => {
    const d = diskModel(STATUS);
    expect(d.text).toBe("1.2 GB of 10.0 GB");
    expect(Object.fromEntries(d.lines)).toMatchObject({ Today: "17.3 MB", "Days kept": "31 of 365", "Free on this disk": "170 GB" });
    expect(Object.fromEntries(d.lines)["Oldest day"]).toMatch(/^29 Sep/);
  });

  it("verdict: busy, ok, warn, error", () => {
    expect(verdictView(null, { busy: true }).tone).toBe("busy");
    expect(verdictView({ ok: true, message: "This account can carry all 18 index chains." })).toEqual({ text: "This account can carry all 18 index chains.", tone: "ok" });
    expect(verdictView({ ok: false, message: "This account can carry 12 of the 40 stocks." }).tone).toBe("warn");
    expect(verdictView(null, { error: "The Bridge did not answer." })).toEqual({ text: "The Bridge did not answer.", tone: "bad" });
  });
});

describe("settings", () => {
  it("the body is bounded to the schema, indices in priority order; NSE needs the acknowledgement in the same write", () => {
    const f = { ...formFrom(STATUS.settings), indices: ["SENSEX", "NIFTY", "NIFTY"], budgetShare: 0.9, streamShare: 0.05, indexStrikes: 99, retentionDays: 1, stockEveryMinutes: 7 };
    const b = formBody(f);
    expect(b).toMatchObject({ indices: ["NIFTY", "SENSEX"], budgetShare: 0.5, streamShare: 0.1, indexStrikes: 60, retentionDays: 7, stockEveryMinutes: 5, account: "dhan-main" });
    expect(b.acknowledgeNseTerms).toBeUndefined();
    const nse = { ...f, sources: { ...f.sources, nseBackup: true } };
    expect(formBody(nse).acknowledgeNseTerms).toBeUndefined();
    expect(formBody(nse, { acknowledge: true })).toMatchObject({ sources: { nseBackup: true }, acknowledgeNseTerms: true });
    expect(formBody({ ...f, account: "" }).account).toBeNull();
  });

  it("Use what fits keeps only what the account can carry", () => {
    const f = { ...formFrom(STATUS.settings), indices: ["NIFTY", "BANKNIFTY", "SENSEX"], stocks: ["SBIN", "TATASTEEL", "INFY"] };
    const out = fitToCarry(f, { indices: ["NIFTY", "SENSEX"], stocks: ["INFY", "SBIN"] });
    expect(out.indices).toEqual(["NIFTY", "SENSEX"]);
    expect(out.stocks).toEqual(["SBIN", "INFY"]);
    expect(out.indexExpiries).toBe(f.indexExpiries);
    // Later expiries refused for kept indices: the expiry count drops by the most refused for any one index.
    const four = { ...f, indexExpiries: 4 };
    const cut = fitToCarry(four, { indices: ["NIFTY", "BANKNIFTY", "SENSEX"], stocks: [] }, [
      { underlying: "SENSEX", expiry: "2026-11-26", kind: "index" },
      { underlying: "SBIN", expiry: "2026-11-24", kind: "stock" },
    ]);
    expect(cut).toMatchObject({ indices: ["NIFTY", "BANKNIFTY", "SENSEX"], stocks: [], indexExpiries: 3 });
    expect(fitToCarry({ ...f, indexExpiries: 1 }, { indices: ["NIFTY"] }, [{ underlying: "NIFTY", kind: "index" }, { underlying: "NIFTY", kind: "index" }]).indexExpiries).toBe(1);
  });

  it("stock search: unique underlyings, no indices, none already chosen", () => {
    const rows = [{ underlying: "RELIANCE" }, { underlying: "RELIANCE" }, { underlying: "NIFTY" }, { underlying: "SBIN" }, { underlying: "bad name!" }];
    expect(stocksFromSearch(rows, ["SBIN"])).toEqual(["RELIANCE"]);
    // Equity derivatives only: MCX and CDS futures are not stock options.
    const mixed = [
      { underlying: "CRUDEOIL", exchange: "MCX", kind: "FUT" },
      { underlying: "USDINR", exchange: "CDS", kind: "FUT" },
      { underlying: "TATASTEEL", exchange: "NFO", kind: "FUT" },
      { underlying: "TATAMOTORS", exchange: "NSE", kind: "EQ" },
    ];
    expect(stocksFromSearch(mixed)).toEqual(["TATASTEEL"]);
  });

  it("phones stack the coverage table and open settings in a sheet", () => {
    expect(stackCoverage(390)).toBe(true);
    expect(stackCoverage(719)).toBe(true);
    expect(stackCoverage(720)).toBe(false);
    expect(stackCoverage(1440)).toBe(false);
  });
});

describe("copy", () => {
  it("neutral words only, and the footer says the data stays here", () => {
    const src = readFileSync(new URL("./recorder.js", import.meta.url), "utf8");
    expect(checkSource(src)).toEqual([]);
    expect(FOOTER).toBe("Recorded on this computer from your own broker account, for your personal use. Nothing is uploaded.");
    expect(DEMO_FOOTER).toBe("Demo recordings are sample data and are kept for 3 days in a separate folder.");
    expect(src).toContain("FOOTER, demo ? ` ${DEMO_FOOTER}`");
  });
});
