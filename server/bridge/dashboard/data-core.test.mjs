import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLASS_GUIDE,
  RECORD_PRESETS,
  agoText,
  autoRecordSummary,
  buildUniverse,
  canonicalSymbol,
  classInfo,
  collectionNameProblem,
  collectionToCsv,
  collectionToJson,
  collectionView,
  createDataClient,
  datasetView,
  dayText,
  daysBetween,
  defaultUniverse,
  diskView,
  estimateJob,
  estimateLines,
  estimateRecording,
  estimateWarning,
  failureWords,
  filterItems,
  formatBytes,
  folderPath,
  formatCount,
  formatDuration,
  isUnavailable,
  istClock,
  istDay,
  jobView,
  noLogin,
  parseCollectionImport,
  parseSymbolList,
  parseTags,
  presetPlan,
  RANGES,
  rangeDates,
  rangeLimitNote,
  zipName,
  recordingProblem,
  recordingView,
  resolveModel,
  ruleSentence,
  ruleStatus,
  savedSummary,
  shareSentence,
  sharePercent,
  sortJobs,
  staleAtmNotice,
  symbolLabel,
  tagCounts,
  tradingDays,
  universeProblem,
  universeSentence,
  universeShort,
  universeSize,
  usageOf,
  usageText,
} from "./data-core.js";

// 9 Nov 2026, 12:00 IST
const NOW = Date.parse("2026-11-09T06:30:00Z");

describe("numbers and words", () => {
  it("formats sizes and durations", () => {
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(18 * 1024 * 1024)).toBe("18 MB");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(undefined)).toBe("");
    expect(formatDuration(20)).toBe("under a minute");
    expect(formatDuration(180)).toBe("about 3 minutes");
    expect(formatDuration(3 * 3600)).toBe("about 3 hours");
    expect(formatDuration(5 * 86_400)).toBe("about 5 days");
    expect(formatDuration(null)).toBeNull();
    expect(formatCount(1200)).toBe("1200");
    expect(formatCount(1_250_000)).toBe("1.3 million");
    expect(formatCount(375750)).toBe("3,75,750");
    expect(formatCount(9999)).toBe("9999");
  });

  it("tells IST days, clocks and ages", () => {
    expect(istDay(Date.parse("2026-11-08T20:00:00Z"))).toBe("2026-11-09");
    expect(istClock("2026-11-09T04:01:02Z")).toBe("09:31:02");
    expect(istClock("nonsense")).toBe("–");
    expect(dayText("2026-11-09T00:00:00Z")).toBe("9 Nov 2026");
    expect(agoText("2026-11-09T06:29:50Z", NOW)).toBe("just now");
    expect(agoText("2026-11-09T05:30:00Z", NOW)).toBe("1 hour ago");
    expect(agoText("2026-11-07T06:30:00Z", NOW)).toBe("2 days ago");
  });
});

describe("data classes", () => {
  it("never calls a delayed or end-of-day file green, and says what it means", () => {
    expect(classInfo({ dataClass: "realtime" })).toMatchObject({ label: "Real-time", tone: "ok" });
    expect(classInfo({ dataClass: "delayed", delaySec: 900 })).toMatchObject({ label: "Delayed 15 min", tone: "warn" });
    expect(classInfo({ dataClass: "delayed", delaySec: 900 }).note).toMatch(/never uses it for orders/);
    expect(classInfo({ dataClass: "eod" })).toMatchObject({ label: "End of day", tone: "warn" });
    expect(classInfo({}).label).toBe("Not labelled");
    expect(CLASS_GUIDE.map((c) => c.id)).toEqual(["realtime", "delayed", "eod"]);
  });
});

describe("ranges and symbols", () => {
  it("works out the preset ranges from today in IST", () => {
    expect(rangeDates("1m", NOW)).toEqual({ from: "2026-10-09", to: "2026-11-09" });
    expect(rangeDates("1y", NOW).from).toBe("2025-11-08");
    expect(rangeDates("max", NOW, ["5m"]).from).toBe("2024-11-09");
    expect(rangeDates("max", NOW, ["1d"]).from).toBe("2016-11-11");
    expect(rangeDates("custom", NOW, [], { from: "2026-01-01" })).toEqual({ from: "2026-01-01", to: "2026-11-09" });
  });

  it("counts days", () => {
    expect(daysBetween("2026-11-01", "2026-11-09")).toBe(9);
    expect(daysBetween("2026-11-09", "2026-11-09")).toBe(1);
    expect(daysBetween("x", "2026-11-09")).toBeNaN();
    expect(tradingDays(365)).toBe(Math.round(365 * (5 / 7) * 0.96));
    expect(tradingDays(0)).toBe(0);
  });

  it("reads a pasted list: canonical names, no repeats, bad ones named", () => {
    const r = parseSymbolList("reliance, TCS\nNSE:INFY; nse:tcs\nbad!name, NFO:NIFTY-2026-11-12-25000-CE");
    expect(r.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS", "NSE:INFY", "NFO:NIFTY-2026-11-12-25000-CE"]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual(["bad!name"]);
    expect(parseSymbolList("symbol\nRELIANCE").symbols).toEqual(["NSE:RELIANCE"]);
    expect(parseSymbolList("$$$").invalid).toEqual(["$$$"]);
    expect(canonicalSymbol(" reliance ")).toBe("NSE:RELIANCE");
    expect(canonicalSymbol("bse:500325")).toBe("BSE:500325");
  });

  it("limits a list to 500 and says how many were left out", () => {
    const text = Array.from({ length: 520 }, (_, i) => `NSE:S${i}`).join("\n");
    const r = parseSymbolList(text);
    expect(r.symbols).toHaveLength(500);
    expect(r.over).toBe(20);
  });

  it("shows contracts in plain words", () => {
    expect(symbolLabel("NFO:NIFTY-2026-11-12-25000-CE")).toBe("NIFTY 12 Nov 25000 CE");
    expect(symbolLabel("NFO:NIFTY-2026-11-26-FUT")).toBe("NIFTY 26 Nov future");
    expect(symbolLabel("NSE:RELIANCE")).toBe("RELIANCE");
    expect(symbolLabel("BSE:500325")).toBe("BSE:500325");
  });
});

describe("estimate before starting", () => {
  it("estimates bars, size, calls and time", () => {
    const e = estimateJob({ symbols: 10, intervals: ["5m"], from: "2026-10-09", to: "2026-11-09", share: 0.3, callsPerSec: 3, nowMs: NOW });
    expect(e.ok).toBe(true);
    expect(e.calendarDays).toBe(32);
    expect(e.files).toBe(10);
    expect(e.calls).toBe(10);
    expect(e.bars).toBe(10 * Math.round(tradingDays(32) * 75));
    expect(e.bytes).toBe(e.bars * 62);
    expect(e.seconds).toBe(Math.ceil(10 / 0.9));
  });

  it("a long intraday range costs one call per 60 days, daily one per 2000", () => {
    const e = estimateJob({ symbols: 1, intervals: ["1m", "1d"], from: "2024-11-09", to: "2026-11-09", nowMs: NOW });
    expect(e.calls).toBe(Math.ceil(732 / 60) + 1);
    expect(e.files).toBe(2);
  });

  it("a smaller share takes longer, a bigger format is bigger", () => {
    const base = { symbols: 50, intervals: ["15m"], from: "2026-01-01", to: "2026-11-09", nowMs: NOW };
    expect(estimateJob({ ...base, share: 0.1 }).seconds).toBeGreaterThan(estimateJob({ ...base, share: 0.5 }).seconds);
    expect(estimateJob({ ...base, format: "jsonl" }).bytes).toBeGreaterThan(estimateJob({ ...base, format: "csv" }).bytes);
  });

  it("says nothing useful without symbols, bars or dates, and never throws", () => {
    expect(estimateJob({ symbols: 0, intervals: ["5m"], from: "2026-01-01" }).ok).toBe(false);
    expect(estimateJob({ symbols: 3, intervals: [], from: "2026-01-01" }).ok).toBe(false);
    expect(estimateJob({ symbols: 3, intervals: ["5m"], from: "" }).ok).toBe(false);
    expect(estimateLines({ ok: false }).size).toMatch(/Pick symbols/);
    expect(estimateLines(null).size).toMatch(/Pick symbols/);
  });

  it("writes the estimate in plain words", () => {
    const e = estimateJob({ symbols: 10, intervals: ["5m"], from: "2026-10-09", to: "2026-11-09", nowMs: NOW });
    const l = estimateLines(e);
    expect(l.size).toMatch(/^About [\d,]+ bars, .+ in 10 files\.$/);
    expect(l.calls).toBe("It will cost about 10 broker calls.");
    expect(l.time).toMatch(/at 30% of your spare room\.$/);
  });

  it("warns about a huge or slow job", () => {
    const huge = estimateJob({ symbols: 500, intervals: ["1m"], from: "2024-11-09", to: "2026-11-09", format: "jsonl", nowMs: NOW });
    expect(estimateWarning(huge)).toMatch(/very large/);
    const slow = estimateJob({ symbols: 500, intervals: ["1m", "5m", "15m"], from: "2024-11-09", to: "2026-11-09", share: 0.05, nowMs: NOW });
    expect(estimateWarning({ ...slow, bytes: 1 })).toMatch(/long time/);
    expect(estimateWarning({ ok: true, bytes: 10, seconds: 10 })).toBe("");
  });

  it("estimates what a recording writes in a day", () => {
    const r = estimateRecording({ kind: "chain", symbolCount: 42, everySec: 30 });
    expect(r.snapshots).toBe(750);
    expect(r.rows).toBe(42 * 750);
    expect(r.bytesPerDay).toBeGreaterThan(1_000_000);
    expect(estimateRecording({ symbolCount: 0 }).rows).toBe(0);
  });
});

describe("option universes", () => {
  it("builds the body the Bridge stores, with sensible limits", () => {
    expect(buildUniverse({ underlying: " nifty " })).toEqual(defaultUniverse("NIFTY"));
    expect(buildUniverse({ underlying: "BANKNIFTY", strikes: { around: "atm", count: 500 } }).strikes).toEqual({ around: "atm", count: 100 });
    expect(buildUniverse({ strikes: { from: 24000, to: 26000 } }).strikes).toEqual({ from: 24000, to: 26000 });
    expect(buildUniverse({ sides: ["PE", "XX"] }).sides).toEqual(["PE"]);
    expect(buildUniverse({ expiries: ["2026-11-12"] }).expiries).toEqual(["2026-11-12"]);
  });

  it("says what is wrong in plain words", () => {
    expect(universeProblem(defaultUniverse())).toBe("");
    expect(universeProblem({ ...defaultUniverse(), underlying: "" })).toMatch(/Type the index/);
    expect(universeProblem({ ...defaultUniverse(), sides: [], includeUnderlying: false })).toMatch(/Nothing is selected/);
    expect(universeProblem({ ...defaultUniverse(), sides: [], includeUnderlying: true })).toBe("");
    expect(universeProblem({ ...defaultUniverse(), expiries: [] })).toMatch(/at least one expiry/);
    expect(universeProblem({ ...defaultUniverse(), expiries: ["27 Nov"] })).toMatch(/look like/);
    expect(universeProblem({ ...defaultUniverse(), strikes: { from: 26000, to: 24000 } })).toMatch(/lower/);
    expect(universeProblem({ ...defaultUniverse(), strikes: { around: "atm", count: 0 } })).toMatch(/1 or more/);
  });

  it("describes a universe in a sentence", () => {
    expect(universeSentence(defaultUniverse())).toBe("NIFTY calls and puts, 10 strikes either side of the current price, current weekly expiry, plus the index itself.");
    expect(universeSentence({ ...defaultUniverse("BANKNIFTY"), sides: ["CE"], includeUnderlying: false, includeFuture: true, expiries: "current-monthly" })).toBe("BANKNIFTY calls, 10 strikes either side of the current price, current monthly expiry, plus the nearest future.");
    expect(universeShort(defaultUniverse())).toBe("NIFTY ATM +/- 10, current weekly");
    expect(universeShort({ ...defaultUniverse(), strikes: { from: 24000, to: 26000 }, expiries: ["2026-11-12", "2026-11-19"] })).toBe("NIFTY 24000-26000, 2 dates");
  });

  it("counts the symbols a universe will have", () => {
    expect(universeSize(defaultUniverse())).toEqual({ count: 43, approx: false });
    expect(universeSize({ ...defaultUniverse(), expiries: "all-weekly" })).toEqual({ count: 169, approx: true });
    expect(universeSize({ ...defaultUniverse(), sides: ["CE"], includeUnderlying: false })).toEqual({ count: 21, approx: false });
    expect(universeSize({ ...defaultUniverse(), strikes: { from: 1, to: 2 } }).count).toBeNull();
    expect(universeSize(null).count).toBe(0);
  });

  it("the preview is honest about the middle strike", () => {
    const m = resolveModel({ symbols: Array.from({ length: 43 }, (_, i) => `NFO:S${i}`), resolvedAt: "2026-11-09T04:00:00Z", rule: "NIFTY ATM +/- 10", atm: { strike: 25000, underlyingPrice: 24987.5, class: "realtime" } });
    expect(m).toMatchObject({ ok: true, count: 43, more: 35, atm: { tone: "ok", trusted: true }, rule: "NIFTY ATM +/- 10" });
    expect(m.atm.text).toBe("The middle strike is 25000, from a live price of 24987.50.");
    const delayed = resolveModel({ symbols: ["a"], atm: { strike: 25000, underlyingPrice: 24900, class: "delayed", delaySec: 900 } });
    expect(delayed.atm).toMatchObject({ tone: "warn", trusted: false });
    expect(delayed.atm.text).toMatch(/delayed 15 min price/);
    const none = resolveModel({ symbols: [], atm: { unavailable: true } });
    expect(none.atm.text).toMatch(/not available right now.*Nothing was guessed/);
    expect(resolveModel({ symbols: ["a"], atm: { strike: 1, stale: true, class: "realtime" } }).atm.trusted).toBe(false);
    expect(resolveModel(null).ok).toBe(false);
    const withSource = resolveModel({ symbols: ["a"], atm: { strike: 25000, underlyingPrice: 24987.5, class: "realtime" }, atmSource: "your broker stream" });
    expect(withSource.atm.text).toBe("The middle strike is 25000, from a live price of 24987.50. Price source: your broker stream.");
    expect(resolveModel({ symbols: ["a"], atmSource: { name: "broker quote" } }).atm.text).toBe("The middle strike was worked out from broker quote.");
    expect(resolveModel({ symbols: ["a"], warnings: ["Expiry rolled"] }).notes).toEqual(["Expiry rolled"]);
  });
});

describe("a refused resolve", () => {
  it("says why a delayed, end-of-day or stale price was not used", () => {
    expect(staleAtmNotice({ status: 422 }).title).toBe("The price is not real-time");
    expect(staleAtmNotice({ status: 422 }).text).toMatch(/Nothing was guessed/);
    expect(staleAtmNotice({ status: 503 }).title).toBe("The price is out of date");
    expect(staleAtmNotice({ status: 500 })).toBeNull();
    expect(staleAtmNotice(null)).toBeNull();
  });
  it("asks for the labelled answer only when told to", async () => {
    const calls = [];
    const c = createDataClient(async (m, p) => (calls.push(`${m} ${p}`), { data: null }));
    await c.collections.resolve("a b");
    await c.collections.resolve("a", { allowStale: true });
    await c.collections.duplicate("a", { name: "b" });
    expect(calls).toEqual(["GET /v1/collections/a%20b/resolve", "GET /v1/collections/a/resolve?allowStale=1", "POST /v1/collections/a/duplicate"]);
  });
});

describe("collections", () => {
  it("checks names", () => {
    expect(collectionNameProblem("")).toMatch(/Give the collection/);
    expect(collectionNameProblem("x".repeat(41))).toMatch(/40/);
    expect(collectionNameProblem("bad/name")).toMatch(/letters/);
    expect(collectionNameProblem("Nifty 50", ["nifty 50"])).toMatch(/already exists/);
    expect(collectionNameProblem("Nifty 50", ["Bank"])).toBe("");
  });

  it("reads tags", () => {
    expect(parseTags("Nifty, weekly ,Weekly; my tag!!")).toEqual(["nifty", "weekly", "my-tag"]);
    expect(parseTags(["A", "b"])).toEqual(["a", "b"]);
    expect(parseTags("a,".repeat(30)).length).toBe(1);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
  });

  it("counts and filters by tag and search", () => {
    const items = [
      { name: "Nifty 50", tags: ["index", "daily"] },
      { name: "Bank", tags: ["index"], description: "banks" },
      { name: "Mine", tags: [] },
    ];
    expect(tagCounts(items)).toEqual([{ tag: "index", count: 2 }, { tag: "daily", count: 1 }]);
    expect(filterItems(items, { tags: ["index"] }).map((x) => x.name)).toEqual(["Nifty 50", "Bank"]);
    expect(filterItems(items, { tags: ["index", "daily"] }).map((x) => x.name)).toEqual(["Nifty 50"]);
    expect(filterItems(items, { query: "BANKS" }).map((x) => x.name)).toEqual(["Bank"]);
    expect(filterItems(null, {})).toEqual([]);
  });

  it("shows a row", () => {
    expect(collectionView({ name: "a", kind: "static", symbols: ["x", "y"], tags: ["t"] })).toMatchObject({ universe: false, kindWord: "Fixed list", sub: "2 symbols", sizeText: "2 symbols" });
    const u = collectionView({ name: "b", kind: "option-universe", universe: defaultUniverse() });
    expect(u).toMatchObject({ universe: true, kindWord: "Option universe", sub: "NIFTY ATM +/- 10, current weekly", sizeText: "about 43 symbols" });
    expect(collectionView({ name: "b", kind: "option-universe", universe: defaultUniverse() }, 41).sizeText).toBe("41 symbols");
  });

  it("exports and imports CSV and JSON and round-trips", () => {
    const c = { name: "Mine", description: "d", tags: ["a"], kind: "static", symbols: ["NSE:RELIANCE", "NSE:TCS"] };
    expect(collectionToCsv(c)).toBe("symbol\nNSE:RELIANCE\nNSE:TCS\n");
    const back = parseCollectionImport(collectionToJson(c));
    expect(back.body).toEqual(c);
    const csv = parseCollectionImport(collectionToCsv(c), "from-csv");
    expect(csv.body).toMatchObject({ name: "from-csv", kind: "static", symbols: ["NSE:RELIANCE", "NSE:TCS"] });
    const u = { name: "U", description: "", tags: [], kind: "option-universe", universe: defaultUniverse() };
    expect(parseCollectionImport(collectionToJson(u)).body).toEqual(u);
    expect(collectionToCsv(u, { symbols: ["NFO:A", "NFO:B"] })).toBe("symbol\nNFO:A\nNFO:B\n");
    expect(parseCollectionImport(JSON.stringify(["reliance", "tcs"]), "n").body.symbols).toEqual(["NSE:RELIANCE", "NSE:TCS"]);
  });

  it("refuses an import it cannot use, in plain words", () => {
    expect(parseCollectionImport("").error).toMatch(/empty/);
    expect(parseCollectionImport("{nope").error).toMatch(/not valid JSON/);
    expect(parseCollectionImport("$$$").error).toMatch(/No symbols/);
    expect(parseCollectionImport(JSON.stringify({ kind: "option-universe", universe: { underlying: "" } })).error).toMatch(/Type the index/);
    expect(parseCollectionImport("[]").error).toMatch(/No symbols/);
  });

  it("finds what uses a collection", () => {
    const u = usageOf("mine", {
      downloads: [{ id: "1", request: { collection: "mine" } }, { id: "2", request: { symbols: ["x"] } }],
      recordings: [{ id: "r", collection: "mine" }],
      rules: [{ id: "u", collection: "other" }],
      datasets: [{ name: "d", collection: "mine" }, { name: "e", collections: ["mine"] }],
    });
    expect(u.downloads).toHaveLength(1);
    expect(usageText(u)).toBe("Used by 1 download, 1 recording, 2 datasets.");
    expect(usageText(usageOf("none", {}))).toBe("Not used by anything yet.");
  });
});

describe("downloads", () => {
  const running = { id: "j1", name: "", status: "running", request: { symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: ["5m"] }, dataClass: "realtime", source: "your broker", progress: { total: 10, done: 4, failed: 1, rows: 18_400, bytes: 2_200_000, etaSec: 200, current: { symbol: "NSE:TCS", interval: "5m" } }, createdAt: "2026-11-09T06:00:00Z", startedAt: "2026-11-09T06:10:00Z" };

  it("shows a running job", () => {
    const v = jobView(running, NOW);
    expect(v).toMatchObject({ title: "5m bars, 2 symbols", word: "Downloading", tone: "info", active: true, percent: 50, current: "Now: TCS 5m", actions: ["pause", "cancel"] });
    expect(v.summary).toBe("4 of 10 items · 1 failed · 18,400 bars · 2.1 MB · about 3 minutes left");
    expect(v.cls.label).toBe("Real-time");
    expect(v.whenText).toBe("Started 20 minutes ago");
  });

  it("each state has its own buttons", () => {
    expect(jobView({ ...running, status: "queued" }).actions).toEqual(["pause", "cancel"]);
    expect(jobView({ ...running, status: "paused" }).actions).toEqual(["resume", "cancel"]);
    expect(jobView({ ...running, status: "done", progress: { total: 3, done: 3 } })).toMatchObject({ percent: 100, actions: ["files", "delete"], tone: "ok" });
    expect(jobView({ ...running, status: "cancelled" })).toMatchObject({ actions: ["delete"], word: "Cancelled" });
    const failed = jobView({ ...running, status: "failed", error: { code: "SESSION_EXPIRED", message: "x" }, items: [{ symbol: "a", interval: "5m", status: "failed", error: "e" }] });
    expect(failed).toMatchObject({ tone: "bad", actions: ["retry", "delete"], why: { title: "Your broker login ended", route: "accounts" } });
    expect(failed.failedItems).toHaveLength(1);
  });

  it("a paused job says why when there is a reason", () => {
    expect(jobView({ ...running, status: "paused", reason: "restart" }).why.title).toBe("Paused when the Bridge restarted");
    expect(jobView({ ...running, status: "paused" }).why).toBeNull();
  });

  it("explains stops in plain words with the fix", () => {
    expect(failureWords({ reason: "kill_switch" })).toMatchObject({ title: "The kill switch is on", route: "safety" });
    expect(failureWords({ error: { code: "DISK_FULL" } }).title).toBe("The disk is nearly full");
    expect(failureWords({ status: "failed", error: { code: "WEIRD", message: "The broker said no." } })).toMatchObject({ title: "The download did not finish", fix: "The broker said no. Press Retry to try again." });
    expect(failureWords({ status: "failed" }).fix).toMatch(/already saved is kept/);
  });

  it("puts running jobs first, then the newest", () => {
    const list = sortJobs([
      { id: "old", status: "done", createdAt: "2026-11-01T00:00:00Z" },
      { id: "new", status: "done", createdAt: "2026-11-08T00:00:00Z" },
      { id: "p", status: "paused", createdAt: "2026-10-01T00:00:00Z" },
      { id: "r", status: "running", createdAt: "2026-09-01T00:00:00Z" },
    ]);
    expect(list.map((j) => j.id)).toEqual(["r", "p", "new", "old"]);
  });

  it("reads disk use and flags low space", () => {
    expect(diskView(null)).toBeNull();
    expect(diskView({ usedBytes: 1e9, limitBytes: 5e9 })).toMatchObject({ low: false, tone: "ok", text: "954 MB of 4.7 GB used" });
    expect(diskView({ usedMb: 4600, limitMb: 5000 })).toMatchObject({ low: true, tone: "warn" });
    expect(diskView({ low: true })).toMatchObject({ low: true });
    expect(diskView({ usedBytes: 1e9, limitBytes: 5e9, freeBytes: 100 * 1_048_576 }).low).toBe(true);
  });
});

describe("recordings and auto-record", () => {
  const rec = { id: "r1", name: "", kind: "chain", underlying: "NIFTY", everySec: 30, status: "running", rows: 12_000, bytes: 1_048_576, lastWriteAt: "2026-11-09T04:01:02Z", gaps: [{ from: "a" }], dataClass: "realtime", ruleId: "u1", symbolCount: 43 };

  it("shows a recording with its last write in IST", () => {
    const v = recordingView(rec, NOW);
    expect(v).toMatchObject({ title: "Option chain recording", word: "Recording", tone: "ok", live: true, gaps: 1, actions: ["pause", "stop", "files"] });
    expect(v.sub).toBe("NIFTY option chain · every 30 s");
    expect(v.stats).toBe("12,000 rows · 1 MB · last write 09:31:02 · 1 gap");
  });

  it("every state has the right buttons and words", () => {
    expect(recordingView({ ...rec, status: "paused" }).actions).toEqual(["resume", "stop", "files"]);
    expect(recordingView({ ...rec, status: "stopped" }).actions).toEqual(["files", "delete"]);
    const lo = recordingView({ ...rec, status: "disk_low" });
    expect(lo).toMatchObject({ word: "Stopped, disk low", tone: "bad", actions: ["resume", "files"] });
    expect(lo.why.title).toBe("The disk is nearly full");
    const nl = recordingView({ ...rec, status: "waiting", reason: "login_needed" });
    expect(nl.why).toMatchObject({ title: "No broker login right now", route: "accounts" });
    expect(recordingView({ ...rec, reason: "feed_silent" }).why.title).toBe("The price feed went quiet");
    expect(recordingView({ ...rec, status: "failed" }).word).toBe("Failed");
  });

  it("a recording is always real-time data", () => {
    expect(recordingView({ id: "x", kind: "quotes", symbols: ["a", "b"] }).cls.label).toBe("Real-time");
    expect(recordingView({ id: "x", kind: "quotes", symbols: ["a", "b"] }).sub).toBe("2 symbols");
  });

  it("says the plain summary", () => {
    expect(autoRecordSummary({ rules: [], recordings: [] })).toMatchObject({ headline: "Auto-record is off", on: 0 });
    expect(autoRecordSummary({ rules: [{ enabled: false }] }).detail).toBe("1 rule saved, none turned on.");
    const quiet = autoRecordSummary({ rules: [{ enabled: true }, { enabled: true }], recordings: [] });
    expect(quiet).toMatchObject({ tone: "info", headline: "Nothing recording right now" });
    expect(autoRecordSummary({ rules: [{ enabled: true, status: "login_needed" }], recordings: [] })).toMatchObject({ tone: "warn", headline: "Waiting for a broker login" });
    const s = autoRecordSummary({ rules: [{ enabled: true }, { enabled: true }, { enabled: true }], recordings: [{ ...rec, symbolCount: 41, bytes: 18 * 1048576 }] });
    expect(s).toMatchObject({ tone: "ok", headline: "Recording today: 3 rules, 41 symbols, 18 MB, last write 09:31:02" });
  });

  it("writes a rule in words and shows its status", () => {
    const universe = { ...defaultUniverse(), underlying: undefined };
    expect(ruleSentence({ kind: "chain", underlying: "NIFTY", universe, everySec: 30, schedule: "market-hours" })).toBe("NIFTY ATM +/- 10, current weekly option chain, every 30 s, during market hours");
    expect(ruleSentence({ collection: "mine", everySec: 5, schedule: { days: ["Mon", "Tue"], start: "09:20", end: "15:00" } }, [{ name: "mine", kind: "static" }])).toBe("Collection mine, every 5 s, Mon, Tue, 09:20 to 15:00 IST");
    expect(ruleSentence({ symbols: ["a", "b"], everySec: 1 })).toBe("2 symbols, every 1 s, during market hours");
    expect(ruleStatus({ enabled: false })).toMatchObject({ id: "off", word: "Off" });
    expect(ruleStatus({ enabled: true, status: "recording" })).toMatchObject({ id: "recording", tone: "ok" });
    expect(ruleStatus({ enabled: true })).toMatchObject({ id: "on" });
  });

  it("the presets build the rule bodies the Bridge expects", () => {
    const [chains, watch] = RECORD_PRESETS;
    const b = chains.build({});
    expect(b.map((x) => x.underlying)).toEqual(["NIFTY", "BANKNIFTY"]);
    expect(b[0]).toMatchObject({ kind: "chain", everySec: 30, schedule: "market-hours", enabled: true, format: "csv" });
    expect(b[0].universe).toMatchObject({ expiries: "current-weekly", strikes: { around: "atm", count: 10 } });
    expect(watch.build({ collection: "mine" })).toEqual([{ name: "Watchlist mine", enabled: true, kind: "quotes", collection: "mine", everySec: 5, schedule: "market-hours", format: "csv" }]);
    expect(watch.needs).toBe("collection");
    const plan = presetPlan(chains, {});
    expect(plan.bodies).toHaveLength(2);
    expect(plan.symbols).toBe(86);
    expect(plan.bytesPerDay).toBeGreaterThan(0);
    expect(presetPlan(watch, { collection: "mine", collectionSize: 20 }).symbols).toBe(20);
  });

  it("checks a recording form", () => {
    expect(recordingProblem({ kind: "chain", everySec: 5, underlying: "NIFTY" })).toMatch(/at most every 15/);
    expect(recordingProblem({ kind: "quotes", everySec: 0, symbols: ["a"] })).toMatch(/every second/);
    expect(recordingProblem({ kind: "chain", everySec: 30 })).toMatch(/Pick a collection or type the index/);
    expect(recordingProblem({ kind: "quotes", everySec: 5 })).toMatch(/Pick a collection or paste/);
    expect(recordingProblem({ kind: "quotes", everySec: 5, collection: "c", keepDays: 0 })).toMatch(/Keep days/);
    expect(recordingProblem({ kind: "quotes", everySec: 5, collection: "c", keepDays: "" })).toBe("");
    expect(recordingProblem({ kind: "quotes", everySec: 5, collection: "c", custom: true, start: "", end: "15:00" })).toMatch(/start and end/);
    expect(recordingProblem({ kind: "quotes", everySec: 5, collection: "c", custom: true, start: "09:20", end: "15:00" })).toBe("");
    expect(recordingProblem({ kind: "quotes", everySec: 5, collection: "c", custom: true, start: "15:00", end: "09:20" })).toMatch(/end time must be later/);
  });
});

describe("datasets and the saving card", () => {
  it("shows a dataset", () => {
    const v = datasetView({ name: "nifty-5m", symbols: ["a", "b"], intervals: ["5m"], rows: 120_000, bytes: 7_500_000, firstBar: "2025-11-10T03:45:00Z", lastBar: "2026-11-06T10:00:00Z", updatedAt: "2026-11-09T05:30:00Z", dataClass: "realtime", tags: ["index"] }, NOW);
    expect(v).toMatchObject({ name: "nifty-5m", sub: "2 symbols · 5m · 1,20,000 bars · 7.2 MB", range: "10 Nov 2025 to 6 Nov 2026", updated: "Updated 1 hour ago", tags: ["index"] });
    expect(datasetView({}).range).toBe("–");
  });

  it("adds up the calls saved, with local data counted", () => {
    expect(savedSummary(null)).toEqual({ total: 0, parts: [], local: 0 });
    const s = savedSummary({ servedFromStream: 300, servedFromCache: 120, coalesced: 10, batched: 0, servedFromLocal: 500 });
    expect(s.total).toBe(930);
    expect(s.parts[0]).toEqual(["Stored data", 500]);
    expect(s.local).toBe(500);
  });

  it("the share slider snaps to steps of five and speaks plainly", () => {
    expect(sharePercent(0.3)).toBe(30);
    expect(sharePercent(0.33)).toBe(35);
    expect(sharePercent(0)).toBe(5);
    expect(sharePercent(4)).toBe(100);
    expect(sharePercent(undefined)).toBe(30);
    expect(shareSentence(30)).toBe("Downloads and recordings may use up to 30% of the room your broker leaves free, so they work gently. Live prices, orders and risk checks always go first.");
  });

  it("knows when nobody is logged in", () => {
    expect(noLogin([], false)).toBe(true);
    expect(noLogin([{ broker: "zerodha", session: { state: "missing" } }], false)).toBe(true);
    expect(noLogin([{ broker: "zerodha", session: { state: "connected" } }], false)).toBe(false);
    expect(noLogin([{ broker: "paper" }], false)).toBe(false);
    expect(noLogin([], true)).toBe(false);
    expect(noLogin(null, false)).toBe(false);
  });
});

// ── The client, against a fake Bridge that serves the documented routes ──

describe("the client against a fake Bridge", () => {
  let server;
  let base;
  const seen = [];
  const state = { jobs: [{ id: "j1", status: "running" }], collections: [{ name: "mine", kind: "static", symbols: ["NSE:RELIANCE"], tags: [] }] };
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const url = new URL(req.url, "http://x");
      seen.push({ method: req.method, path: url.pathname, query: url.search, body });
      const p = url.pathname;
      if (p === "/v1/downloads" && req.method === "GET") return send(res, 200, { data: state.jobs, meta: { disk: { usedMb: 100, limitMb: 5000 } } });
      if (p === "/v1/downloads" && req.method === "POST") return send(res, 202, { data: { id: "j2", status: "queued", request: body } });
      if (p === "/v1/downloads/j1/pause") return send(res, 200, { data: { id: "j1", status: "paused" } });
      if (p === "/v1/collections" && req.method === "GET") return send(res, 200, { data: state.collections });
      if (p === "/v1/collections/mine/resolve") return send(res, 200, { data: { symbols: ["NSE:RELIANCE"], resolvedAt: "2026-11-09T04:00:00Z", rule: "fixed" } });
      if (p === "/v1/collections/resolve") return send(res, 404, { code: "NOT_FOUND", detail: "no such route" });
      if (p === "/v1/recordings/rules" && req.method === "POST") return send(res, 201, { data: { id: "u1", ...body } });
      if (p === "/v1/usage") return send(res, 200, { data: { savings: { servedFromStream: 5 } } });
      if (p === "/v1/instruments/search") return send(res, 200, { data: [{ symbol: "NSE:RELIANCE" }] });
      if (p === "/v1/datasets/nifty%205m/update") return send(res, 202, { data: { id: "j9", status: "queued" } });
      return send(res, 404, { code: "NOT_FOUND", detail: "no route" });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(j?.detail ?? `HTTP ${r.status}`), { status: r.status, code: j?.code });
    return j;
  };
  const client = () => createDataClient(call);

  it("lists, creates and pauses downloads", async () => {
    const c = client();
    const list = await c.downloads.list({ status: "running" });
    expect(list.data).toHaveLength(1);
    expect(list.meta.disk.limitMb).toBe(5000);
    expect(seen.at(-1)).toMatchObject({ method: "GET", path: "/v1/downloads", query: "?status=running" });
    const made = await c.downloads.create({ symbols: ["NSE:RELIANCE"], intervals: ["5m"], from: "2026-10-09" });
    expect(made.data).toMatchObject({ id: "j2", status: "queued" });
    expect(seen.at(-1).body.symbols).toEqual(["NSE:RELIANCE"]);
    expect((await c.downloads.pause("j1")).data.status).toBe("paused");
  });

  it("reads collections and resolves them", async () => {
    const c = client();
    expect((await c.collections.list()).data[0].name).toBe("mine");
    expect((await c.collections.resolve("mine")).data.rule).toBe("fixed");
  });

  it("a route this Bridge does not have reads as unavailable", async () => {
    const c = client();
    await expect(c.collections.resolveDraft({ underlying: "NIFTY" })).rejects.toSatisfy((e) => isUnavailable(e));
    await expect(c.downloads.settings()).rejects.toSatisfy((e) => isUnavailable(e));
    expect(isUnavailable({ status: 500 })).toBe(false);
    expect(isUnavailable(null)).toBe(false);
  });

  it("creates a rule, reads usage, searches and updates a dataset by encoded name", async () => {
    const c = client();
    const r = await c.recordings.rules.create({ name: "n", kind: "quotes" });
    expect(r.data).toMatchObject({ id: "u1", name: "n" });
    expect((await c.usage()).data.savings.servedFromStream).toBe(5);
    expect((await c.searchInstruments("reliance")).data[0].symbol).toBe("NSE:RELIANCE");
    expect(seen.at(-1).query).toBe("?q=reliance&limit=12");
    expect((await c.datasets.update("nifty 5m")).data.id).toBe("j9");
  });

  it("builds every address from the documented routes", async () => {
    const calls = [];
    const c = createDataClient(async (m, p, b) => (calls.push([m, p, b]), { data: null }));
    await c.downloads.resume("a b");
    await c.downloads.cancel("a");
    await c.downloads.remove("a");
    await c.downloads.files("a");
    await c.datasets.list({ tag: "idx" });
    await c.datasets.patch("n", { tags: ["x"] });
    await c.recordings.stop("r");
    await c.recordings.files("r");
    await c.recordings.rules.patch("u", { enabled: false });
    await c.recordings.rules.remove("u");
    await c.collections.patch("old", { name: "new" });
    await c.collections.remove("old");
    await c.collections.resolveDraft({ underlying: "NIFTY" });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      "POST /v1/downloads/a%20b/resume",
      "POST /v1/downloads/a/cancel",
      "DELETE /v1/downloads/a",
      "GET /v1/downloads/a/files",
      "GET /v1/datasets?tag=idx",
      "PATCH /v1/datasets/n",
      "POST /v1/recordings/r/stop",
      "GET /v1/recordings/r/files",
      "PATCH /v1/recordings/rules/u",
      "DELETE /v1/recordings/rules/u",
      "PATCH /v1/collections/old",
      "DELETE /v1/collections/old",
      "POST /v1/collections/resolve",
    ]);
    expect(calls.at(-1)[2]).toEqual({ kind: "option-universe", universe: { underlying: "NIFTY" } });
  });
});

describe("long ranges", () => {
  it("offers 2 and 5 years and works the dates out", () => {
    expect(RANGES.map((r) => r.id)).toEqual(["1m", "3m", "1y", "2y", "5y", "max", "custom"]);
    const now = Date.parse("2026-11-09T06:30:00Z");
    expect(rangeDates("2y", now)).toEqual({ from: "2024-11-09", to: "2026-11-09" });
    expect(rangeDates("5y", now).from).toBe("2021-11-09");
  });
  it("says when 5 minute bars rarely go back that far, and stays quiet when they do", () => {
    expect(rangeLimitNote("2024-11-09", "2026-11-09", ["5m"])).toBe("");
    expect(rangeLimitNote("2021-11-08", "2026-11-09", ["5m"])).toMatch(/Bars of 5m usually go back about 2 years/);
    expect(rangeLimitNote("2021-11-08", "2026-11-09", ["1d"])).toBe("");
    expect(rangeLimitNote("", "2026-11-09", ["5m"])).toBe("");
  });
});

describe("where the files are", () => {
  it("labels demo data as sample data, never real-time", () => {
    expect(classInfo({ dataClass: "realtime", source: "demo" })).toMatchObject({ id: "sample", label: "Sample data", tone: "" });
    expect(classInfo({ dataClass: "realtime", source: "demo (sample prices)" }).id).toBe("sample");
    expect(classInfo({ dataClass: "realtime", source: "dhan" }).label).toBe("Real-time");
  });
  it("names the folder and the zip", () => {
    expect(folderPath("/home/me/bridge/data/", "downloads", "dl_abc")).toBe("/home/me/bridge/data/downloads/dl_abc");
    expect(folderPath("C:\\Bridge\\data", "recordings", "rec_1")).toBe("C:\\Bridge\\data\\recordings\\rec_1");
    expect(folderPath(undefined, "downloads", "x")).toBe("");
    expect(zipName("Nifty 50 / 5-minute bars", "dl_1")).toBe("Nifty-50-5-minute-bars.zip");
    expect(zipName("", "dl_1")).toBe("dl_1.zip");
  });
});
