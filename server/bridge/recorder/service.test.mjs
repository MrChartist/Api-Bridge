/**
 * The recorder service with a manual clock and fake feeds: manual recordings, the session clock, the midnight roll,
 * gaps, the real-time-only rule, disk safety, restart resume, retention and the plain status line.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { decodeRows } from "./format.mjs";
import { NIFTY, at, bootRecorder, leg } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});

const rec = (id) => join(w.dir, "recordings", id);
const dataFiles = (id) => readdirSync(rec(id)).filter((n) => /^\d{4}-\d{2}-\d{2}__/.test(n)).sort();
const readRows = (id, name) => decodeRows(readFileSync(join(rec(id), name), "utf8"), name.endsWith(".jsonl") ? "jsonl" : "csv");

async function startQuotes(extra = {}) {
  await w.svc.start();
  const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY, "NSE:RELIANCE"], everySec: 1, sessionOnly: false, ...extra });
  // first pass subscribes the symbols to the live feed
  await w.run(1000);
  return r;
}

describe("manual quotes recording", () => {
  it("writes one file per symbol per IST day from the live feed, labelled realtime, with no broker call", async () => {
    w = bootRecorder({ prices: { "NSE:RELIANCE": 1402.5 } });
    const r = await startQuotes();
    expect(w.hub.calls.some((c) => c[0] === "subscribe" && c[1] === `recorder:${r.id}`)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 24000 + i, bid: 23999.5, ask: 24000.5, volume: 1000 + i });
      w.hub.pushTick({ symbol: "NSE:RELIANCE", ltp: 1400 + i });
      await w.run(1000);
    }
    expect(dataFiles(r.id)).toEqual(["2026-11-09__NSE_NIFTY.csv", "2026-11-09__NSE_RELIANCE.csv"]);
    const rows = readRows(r.id, "2026-11-09__NSE_NIFTY.csv");
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0]).toMatchObject({ symbol: NIFTY, class: "realtime", source: "stream" });
    expect(rows[0].time).toMatch(/^2026-11-09T09:0\d:\d\d\.\d{3}\+05:30$/);
    expect(readFileSync(join(rec(r.id), "2026-11-09__NSE_NIFTY.csv"), "utf8").startsWith("time,symbol,ltp,")).toBe(true);
    // everything came from the feed: the market service was never asked for quotes
    expect(w.md.calls.filter((c) => c[0] === "quotes")).toEqual([]);
    const v = w.svc.get(r.id);
    expect(v).toMatchObject({ status: "recording", dataClass: "realtime", kind: "quotes" });
    expect(v.rows).toBeGreaterThanOrEqual(8);
    expect(v.files.count).toBe(2);
    expect(w.scheduler.savings.servedFromStream).toBeGreaterThan(0);
  });

  it("jsonl format writes one JSON object per line", async () => {
    w = bootRecorder();
    const r = await startQuotes({ format: "jsonl" });
    w.hub.pushTick({ symbol: NIFTY, ltp: 24001 });
    await w.run(1000);
    const name = dataFiles(r.id).find((n) => n.includes("NIFTY"));
    expect(name.endsWith(".jsonl")).toBe(true);
    const line = readFileSync(join(rec(r.id), name), "utf8").trim().split("\n")[0];
    expect(JSON.parse(line)).toMatchObject({ symbol: NIFTY, ltp: 24001, class: "realtime" });
  });

  it("rolls to a new file at IST midnight and keeps the old day intact", async () => {
    w = bootRecorder({ start: at("2026-11-09T23:59:50") });
    const r = await startQuotes();
    w.hub.pushTick({ symbol: NIFTY, ltp: 100 });
    await w.run(3000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 101 });
    await w.run(15_000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 102 });
    await w.run(2000);
    const names = dataFiles(r.id).filter((n) => n.includes("NIFTY"));
    expect(names).toEqual(["2026-11-09__NSE_NIFTY.csv", "2026-11-10__NSE_NIFTY.csv"]);
    expect(readRows(r.id, names[0]).every((x) => x.time.startsWith("2026-11-09"))).toBe(true);
    expect(readRows(r.id, names[1]).every((x) => x.time.startsWith("2026-11-10"))).toBe(true);
    expect(w.svc.files(r.id).map((f) => f.date)).toContain("2026-11-10");
  });

  it("with sessionOnly it waits for the open, records inside market hours, stops at the close and skips a holiday", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:00:00") });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 5, sessionOnly: true });
    await w.run(60_000, 5000);
    expect(w.svc.get(r.id).status).toBe("waiting");
    expect(dataFiles(r.id)).toEqual([]);
    expect(w.svc.get(r.id).statusText).toMatch(/Waiting for the next session: 9 Nov 09:15 IST/);
    // 09:15 opens: the first pass subscribes, then ticks arrive
    await w.clock.set(at("2026-11-09T09:15:00"));
    await w.run(10_000, 1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 24010 });
    await w.run(10_000, 1000);
    expect(w.svc.get(r.id).status).toBe("recording");
    expect(dataFiles(r.id)).toEqual(["2026-11-09__NSE_NIFTY.csv"]);
    // 15:30 closes: no row at or after the close
    await w.clock.set(at("2026-11-09T15:29:50"));
    w.hub.pushTick({ symbol: NIFTY, ltp: 24020 });
    await w.run(20_000, 5000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 24030 });
    await w.run(30_000, 5000);
    const times = readRows(r.id, "2026-11-09__NSE_NIFTY.csv").map((x) => x.time.slice(11, 16));
    expect(times.every((t) => t >= "09:15" && t < "15:31")).toBe(true);
    expect(w.svc.get(r.id).status).toBe("waiting");
    // Tuesday 10th is a holiday: nothing is recorded; the next start is Wednesday 11th
    await w.clock.set(at("2026-11-10T10:00:00"));
    await w.run(60_000, 10_000);
    expect(dataFiles(r.id).some((n) => n.startsWith("2026-11-10"))).toBe(false);
    expect(w.svc.get(r.id).nextStartAt).toMatch(/^2026-11-11T09:15/);
  });

  it("refuses what it cannot do and says why", async () => {
    w = bootRecorder({ config: { maxRecordings: 1 } });
    await w.svc.start();
    await expect(w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, dataClass: "delayed" })).rejects.toThrow(/real-time data only/);
    await expect(w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, dataClass: "eod" })).rejects.toThrow(/End-of-day/);
    await expect(w.svc.create({ kind: "chain", underlying: "NIFTY", everySec: 5 })).rejects.toThrow(/at least 15 seconds/);
    await expect(w.svc.create({ kind: "quotes", symbols: ["NOT A SYMBOL"], everySec: 1 })).rejects.toThrow();
    await expect(w.svc.create({ kind: "quotes", symbols: ["MCX:CRUDEOIL-2026-11-19-FUT"], everySec: 1 })).rejects.toThrow(/own hours/);
    await expect(w.svc.create({ kind: "quotes", collection: "x", everySec: 1 })).rejects.toThrow(/Collections are not available/);
    await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1 });
    await expect(w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1 })).rejects.toThrow(/already 1 recordings/);
  });

  it("pause stops writing, resume continues, stop is final, delete removes the files", async () => {
    w = bootRecorder();
    const r = await startQuotes();
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(2000);
    const before = w.svc.get(r.id).rows;
    expect(before).toBeGreaterThan(0);
    w.svc.pause(r.id);
    w.hub.pushTick({ symbol: NIFTY, ltp: 2 });
    await w.run(5000);
    expect(w.svc.get(r.id)).toMatchObject({ status: "paused", rows: before });
    w.svc.resume(r.id);
    await w.run(3000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 3 });
    await w.run(3000);
    expect(w.svc.get(r.id).rows).toBeGreaterThan(before);
    w.svc.stop(r.id);
    expect(() => w.svc.resume(r.id)).toThrow(/stopped/);
    expect(w.eventsOf("recording.stopped").at(-1)).toMatchObject({ id: r.id, reason: "manual" });
    w.svc.remove(r.id);
    expect(existsSync(rec(r.id))).toBe(false);
    expect(w.svc.list()).toEqual([]);
  });
});

describe("gaps", () => {
  it("a silent feed opens a gap after the threshold, logs it with its reason, and closes it when data returns", async () => {
    w = bootRecorder();
    const r = await startQuotes();
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(2000);
    expect(w.svc.get(r.id).gaps.open).toBe(null);
    // the feed goes down: everySec 1 is too short to read one call at a time, so nothing can be recorded
    w.hub.setConnected(false);
    await w.run(40_000, 2000);
    const open = w.svc.get(r.id).gaps.open;
    expect(open).toMatchObject({ reason: "feed-down" });
    expect(w.eventsOf("recording.gap").some((g) => g.state === "open" && g.reason === "feed-down")).toBe(true);
    // the feed comes back
    w.hub.setConnected(true);
    await w.svc.pumpAll();
    await w.run(3000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 2 });
    await w.run(3000);
    const v = w.svc.get(r.id);
    expect(v.gaps.open).toBe(null);
    expect(v.gaps.total).toBe(1);
    expect(v.gaps.recent[0]).toMatchObject({ reason: "feed-down", state: "closed" });
    expect(v.gaps.recent[0].seconds).toBeGreaterThanOrEqual(30);
    const log = readFileSync(join(rec(r.id), "gaps.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((l) => l.state)).toEqual(["open", "closed"]);
    expect(w.eventsOf("recording.gap").at(-1)).toMatchObject({ state: "closed" });
  });

  it("an interval of 5 s or more reads symbols the feed does not carry through the market service at background priority within the share cap", async () => {
    w = bootRecorder({ prices: { "NSE:RELIANCE": 1402.5 } });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 10, sessionOnly: false });
    w.hub.setConnected(false); // not live: REST path
    await w.run(30_000, 5000);
    const q = w.md.calls.filter((c) => c[0] === "quotes");
    expect(q.length).toBeGreaterThan(0);
    expect(q[0][2]).toMatchObject({ priority: "background", allowBackup: false, backgroundShare: 0.3 });
    const rows = readRows(r.id, "2026-11-09__NSE_RELIANCE.csv");
    expect(rows[0]).toMatchObject({ source: "broker", class: "realtime" });
    expect(w.svc.get(r.id).apiCalls.madeToday).toBeGreaterThan(0);
  });

  it("a broker back-off pauses broker reads and records a budget gap, never a stale value", async () => {
    w = bootRecorder({ prices: { "NSE:RELIANCE": 1402.5 } });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 10, sessionOnly: false });
    w.hub.setConnected(false);
    w.bus.emit("limits.throttled", { accountId: "main", endpointClass: "quote", retryAfterMs: 120_000, upstream: true });
    const calls0 = w.md.calls.length;
    await w.run(60_000, 5000);
    expect(w.md.calls.length).toBe(calls0);
    expect(w.svc.get(r.id).gaps.open).toMatchObject({ reason: "budget" });
  });
});

describe("real-time only", () => {
  it("a delayed answer is refused, counted, explained and never written", async () => {
    w = bootRecorder({ prices: { "NSE:RELIANCE": 1402.5 } });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 10, sessionOnly: false });
    w.hub.setConnected(false);
    w.label.current = { class: "delayed", delaySec: 900, provider: "free-source", source: "backup", official: false };
    await w.run(60_000, 5000);
    expect(dataFiles(r.id)).toEqual([]);
    const v = w.svc.get(r.id);
    expect(v.rows).toBe(0);
    expect(v.refused.total).toBeGreaterThan(0);
    expect(v.issue.message).toMatch(/Not recorded: .*delayed data \(900 s late\)/);
    expect(v.gaps.open).toMatchObject({ reason: "delayed-source" });
    // the label changes back: recording starts
    w.label.current = null;
    await w.run(20_000, 5000);
    expect(w.svc.get(r.id).rows).toBeGreaterThan(0);
  });
});

describe("disk safety", () => {
  it("stops writing before a limit is passed, warns first, says so, and starts again when room appears", async () => {
    w = bootRecorder({ config: { maxDiskMb: 10, minFreeDiskMb: 500 }, free: 800 * 1024 * 1024 });
    const r = await startQuotes();
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(2000);
    expect(w.svc.get(r.id).rows).toBeGreaterThan(0);
    // free space drops below twice the floor: a warning, still writing
    w.state.free = 900 * 1024 * 1024;
    w.hub.pushTick({ symbol: NIFTY, ltp: 2 });
    await w.run(2000);
    const warn = w.eventsOf("recording.disk_low").find((e) => e.level === "warning");
    expect(warn).toMatchObject({ scope: "volume", stopped: false });
    // below the floor: writing stops
    const rowsBefore = w.svc.get(r.id).rows;
    w.state.free = 100 * 1024 * 1024;
    for (let i = 0; i < 5; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 3 + i });
      await w.run(2000);
    }
    expect(w.svc.get(r.id)).toMatchObject({ status: "blocked", rows: rowsBefore });
    expect(w.svc.get(r.id).statusText).toMatch(/Not writing: The disk has only 100 MB free/);
    const stopped = w.eventsOf("recording.disk_low").filter((e) => e.stopped);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ id: r.id, scope: "volume", level: "stopped" });
    expect(w.svc.get(r.id).gaps.open).toMatchObject({ reason: "disk-full" });
    // the card shows the real reason: code, the Bridge's own text and the fix
    const problem = w.svc.get(r.id).problem;
    expect(problem).toMatchObject({ code: "disk_full" });
    expect(problem.message).toMatch(/The disk has only 100 MB free/);
    expect(problem.fix).toMatch(/recorder\.maxDiskMb/);
    // room again
    w.state.free = 30 * 1024 ** 3;
    await w.run(40_000, 5000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 50 });
    await w.run(3000);
    expect(w.svc.get(r.id)).toMatchObject({ status: "recording" });
    expect(w.svc.get(r.id).rows).toBeGreaterThan(rowsBefore);
  });

  it("the total limit counts every recording and a write that would pass it is dropped whole", async () => {
    w = bootRecorder({ config: { maxDiskMb: 10 } });
    await w.svc.start();
    const a = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    await w.svc.close();
    // another recording's files fill the folder to just under 10 MB
    const filler = join(rec("rec_filler01"));
    mkdirSync(filler, { recursive: true });
    writeFileSync(join(filler, "recording.json"), JSON.stringify({ id: "rec_filler01", name: "old", kind: "quotes", source: "manual", ruleId: null, target: { symbols: [NIFTY] }, everySec: 1, sessionOnly: false, schedule: null, format: "csv", status: "stopped", createdAt: "2026-11-01T00:00:00.000+05:30", activatedAt: 0 }));
    writeFileSync(join(filler, "2026-11-01__NSE_NIFTY.csv"), Buffer.alloc(10 * 1024 * 1024 - 300));
    await w.restart();
    await w.run(1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(3000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 2 });
    await w.run(3000);
    const v = w.svc.get(a.id);
    expect(v.status).toBe("blocked");
    expect(v.disk.blocked.scope).toBe("total");
    const total = readdirSync(rec(a.id)).reduce((n, f) => n + statSync(join(rec(a.id), f)).size, 0) + statSync(join(filler, "2026-11-01__NSE_NIFTY.csv")).size;
    expect(total).toBeLessThanOrEqual(10 * 1024 * 1024 + 4096); // only the small bookkeeping files can be over the cap
    expect(dataFiles(a.id)).toEqual([]);
  });

  it("a recording's own limit (maxDiskMb) stops that recording only", async () => {
    w = bootRecorder({});
    await w.svc.start();
    const a = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false, maxDiskMb: 1 });
    const b = await w.svc.create({ kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 1, sessionOnly: false });
    await w.svc.close();
    writeFileSync(join(rec(a.id), "2026-11-01__NSE_NIFTY.csv"), Buffer.alloc(1024 * 1024 - 100));
    await w.restart();
    await w.run(1000);
    for (let i = 0; i < 3; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 1 + i });
      w.hub.pushTick({ symbol: "NSE:RELIANCE", ltp: 100 + i });
      await w.run(2000);
    }
    expect(w.svc.get(a.id)).toMatchObject({ status: "blocked" });
    expect(w.svc.get(b.id)).toMatchObject({ status: "recording" });
    expect(w.svc.get(b.id).rows).toBeGreaterThan(0);
  });
});

describe("restart resume", () => {
  it("resumes on its own, appends to the same day file without a second header, and logs the time the Bridge was off", async () => {
    w = bootRecorder();
    const r = await startQuotes();
    for (let i = 0; i < 3; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 10 + i });
      await w.run(1000);
    }
    const name = "2026-11-09__NSE_NIFTY.csv";
    const rowsBefore = readRows(r.id, name).length;
    expect(rowsBefore).toBeGreaterThan(0);
    await w.svc.close();
    // five minutes with the Bridge off
    await w.clock.advance(5 * 60_000);
    const svc2 = await w.restart();
    expect(svc2.list().map((x) => x.id)).toEqual([r.id]);
    await w.run(1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 99 });
    await w.run(3000);
    const text = readFileSync(join(rec(r.id), name), "utf8");
    expect(text.match(/^time,symbol/gm)).toHaveLength(1);
    expect(readRows(r.id, name).length).toBeGreaterThan(rowsBefore);
    const v = w.svc.get(r.id);
    expect(v.rows).toBeGreaterThan(rowsBefore);
    expect(v.gaps.recent[0]).toMatchObject({ reason: "bridge-stopped", state: "closed" });
    expect(v.gaps.recent[0].seconds).toBeGreaterThanOrEqual(290);
  });

  it("repairs a file whose last line was cut short, and does not resume a paused or stopped recording", async () => {
    w = bootRecorder();
    const r = await startQuotes();
    const p = await w.svc.create({ kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 1, sessionOnly: false });
    w.svc.pause(p.id);
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(2000);
    await w.svc.close();
    const file = join(rec(r.id), "2026-11-09__NSE_NIFTY.csv");
    writeFileSync(file, `${readFileSync(file, "utf8")}2026-11-09T09:00:05.000+05:30,NSE:NIF`); // torn, no newline
    await w.restart();
    await w.run(1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 7 });
    await w.run(3000);
    const rows = readRows(r.id, "2026-11-09__NSE_NIFTY.csv");
    expect(rows.at(-1)).toMatchObject({ ltp: 7 });
    expect(w.svc.get(p.id).status).toBe("paused");
    expect(w.svc.get(r.id).status).toBe("recording");
  });
});

describe("retention", () => {
  it("deletes day files older than keepDays and gzips finished days when asked", async () => {
    w = bootRecorder();
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false, keepDays: 3, compress: true });
    const d = rec(r.id);
    const csv = "time,symbol,ltp\nx,NSE:NIFTY,1\n";
    for (const day of ["2026-11-01", "2026-11-05", "2026-11-07", "2026-11-08"]) writeFileSync(join(d, `${day}__NSE_NIFTY.csv`), csv);
    w.svc.sweepNow();
    // today is the 9th: keep 3 days = the 7th, 8th, 9th
    const left = readdirSync(d).filter((n) => /^\d{4}/.test(n)).sort();
    expect(left).toEqual(["2026-11-07__NSE_NIFTY.csv.gz", "2026-11-08__NSE_NIFTY.csv.gz"]);
    expect(gunzipSync(readFileSync(join(d, left[0]))).toString()).toBe(csv);
    // the listing counts rows inside a .gz and the file can be opened by its listed name
    const listed = w.svc.files(r.id);
    expect(listed.find((f) => f.name === left[0])).toMatchObject({ compressed: true, rows: 1, date: "2026-11-07" });
    expect(w.svc.openFile(r.id, left[0]).compressed).toBe(true);
  });

  it("the global retentionDays applies to every recording", async () => {
    w = bootRecorder({ config: { retentionDays: 2 } });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    writeFileSync(join(rec(r.id), "2026-11-06__NSE_NIFTY.csv"), "time,symbol\n");
    writeFileSync(join(rec(r.id), "2026-11-08__NSE_NIFTY.csv"), "time,symbol\n");
    w.svc.sweepNow();
    expect(dataFiles(r.id)).toEqual(["2026-11-08__NSE_NIFTY.csv"]);
  });

  it("opens only listed data files, never a path", async () => {
    w = bootRecorder();
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    expect(() => w.svc.openFile(r.id, "../../secrets.enc")).toThrow(/No such file/);
    expect(() => w.svc.openFile(r.id, "recording.json")).toThrow(/No such file/);
    expect(() => w.svc.openFile(r.id, "2026-11-09__NSE_NIFTY.csv")).toThrow(/No such file/);
  });
});

describe("status line", () => {
  it("says what is happening in plain words", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:00:00") });
    await w.svc.start();
    expect(w.svc.status().line).toBe("Recording is off. Nothing is being saved.");
    await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    await w.run(1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 5 });
    await w.run(2000);
    expect(w.svc.status().line).toMatch(/^Recording today: 1 manual recording, 1 symbol, \d+ KB, last write 09:0\d:\d\d\.$/);
    expect(w.svc.status().today.lastWriteAt).toMatch(/^2026-11-09T09:0/);
  });
});
