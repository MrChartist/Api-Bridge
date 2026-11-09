// Node SDK: downloads, datasets, recordings (+ rules), collections, subscriptions against the fake Bridge. Run: node --test sdk/node/test/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { BridgeClient, ChecksumMismatchError, DownloadFailedError, WaitTimeoutError, optionUniverse, parseTable, toCsv } from "../src/index.mjs";
import { bars } from "./fakeData.mjs";
import { TEST_KEY, createFakeBridge } from "./fakeServer.mjs";

let fake;
let baseUrl;
let clock;
let bridge;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcb-sdk-"));
const lastBody = (method, p) => fake.requests().filter((r) => r.method === method && r.path === p).at(-1)?.body;

before(async () => {
  fake = createFakeBridge();
  baseUrl = `http://127.0.0.1:${await fake.listen()}`;
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  clock = { t: 0 };
  bridge = new BridgeClient({ baseUrl, apiKey: TEST_KEY, sleep: async (ms) => { clock.t += ms; }, now: () => clock.t });
});

describe("downloads", () => {
  it("create sends the documented body and returns the job", async () => {
    const job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: "5m", from: "2024-01-01", name: "large caps", format: "csv", layout: "per-symbol", dataset: "lc-5m", tags: ["eq"] });
    assert.deepEqual(lastBody("POST", "/v1/downloads"), { name: "large caps", symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: ["5m"], from: "2024-01-01", format: "csv", layout: "per-symbol", dataset: "lc-5m", tags: ["eq"] });
    assert.equal(job.status, "queued");
    assert.match(job.id, /^dl_/);
    assert.equal(job.progress.total, 2);
  });

  it("accepts a collection, dates and backup", async () => {
    await bridge.collections.create("tcs-only", { symbols: ["NSE:TCS"] });
    await bridge.downloads.create({ collection: "tcs-only", intervals: ["1d", "5m"], from: new Date("2024-01-02T00:00:00Z"), backup: true });
    const b = lastBody("POST", "/v1/downloads");
    assert.equal(b.collection, "tcs-only");
    assert.equal(b.symbols, undefined);
    assert.equal(b.from, "2024-01-02T00:00:00.000Z");
    assert.equal(b.backup, true);
  });

  it("checks arguments before sending anything", async () => {
    for (const p of [
      { intervals: "5m", from: "2024-01-01" },
      { symbols: ["NSE:X"], collection: "c", intervals: "5m", from: "2024-01-01" },
      { symbols: ["NSE:X"], from: "2024-01-01" },
      { symbols: ["NSE:X"], intervals: "5m" },
      { symbols: ["NSE:X"], intervals: "5m", from: "2024-01-01", format: "xlsx" },
      { symbols: ["NSE:X"], intervals: "5m", from: "2024-01-01", layout: "wide" },
    ]) await assert.rejects(() => bridge.downloads.create(p), TypeError);
    assert.equal(fake.requests().filter((r) => r.path === "/v1/downloads").length, 0);
    await bridge.downloads.create({ symbols: ["NSE:X"], intervals: "5m", dataset: "x" }); // a dataset continues by itself: no from needed
    assert.equal(lastBody("POST", "/v1/downloads").from, undefined);
  });

  it("wait polls and reports progress", async () => {
    const job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE"], intervals: "5m", from: "2024-01-01" });
    const seen = [];
    const done = await bridge.downloads.wait(job, { pollMs: 500, onProgress: (j) => seen.push(j.status) });
    assert.equal(done.status, "done");
    assert.ok(seen.includes("running"));
    assert.equal(seen.at(-1), "done");
    assert.equal(done.files.length, 1);
    assert.ok(clock.t >= 1000);
  });

  it("wait throws with the reason a job failed, or returns it", async () => {
    fake.data.jobFail = "The broker login ended (session lost).";
    const job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE"], intervals: "5m", from: "2024-01-01" });
    await assert.rejects(() => bridge.downloads.wait(job), (e) => e instanceof DownloadFailedError && /session lost/.test(e.message) && e.job.status === "failed");
    const j = await bridge.downloads.wait(job, { throwOnFailure: false });
    assert.equal(j.status, "failed");
    assert.ok(j.reason);
  });

  it("wait times out without stopping the job", async () => {
    fake.data.jobPolls = 10_000;
    const job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE"], intervals: "5m", from: "2024-01-01" });
    await assert.rejects(() => bridge.downloads.wait(job, { timeoutMs: 5000, pollMs: 1000 }), (e) => e instanceof WaitTimeoutError && /keeps running/.test(e.message) && ["queued", "running"].includes(e.last.status));
    assert.ok(["queued", "running"].includes((await bridge.downloads.get(job)).status));
  });

  it("list, pause, resume, cancel, rename, delete", async () => {
    const a = await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01" });
    const b = await bridge.downloads.create({ symbols: ["NSE:B"], intervals: "5m", from: "2024-01-01" });
    assert.deepEqual((await bridge.downloads.list()).map((j) => j.id), [b.id, a.id]);
    assert.equal((await bridge.downloads.pause(a)).status, "paused");
    assert.equal((await bridge.downloads.resume(a)).status, "running");
    assert.equal((await bridge.downloads.cancel(b)).status, "cancelled");
    assert.deepEqual((await bridge.downloads.list({ status: "cancelled" })).map((j) => j.id), [b.id]);
    const r = await bridge.downloads.rename(a, { name: "morning", tags: ["a"] });
    assert.deepEqual([r.name, r.tags], ["morning", ["a"]]);
    await bridge.downloads.delete(b);
    await assert.rejects(() => bridge.downloads.get(b), (e) => e.status === 404);
    await assert.rejects(() => bridge.downloads.rename(a), TypeError);
  });

  it("save checks each file, writes the manifest and does not fetch twice", async () => {
    const dir = path.join(tmp(), "out");
    const job = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: "5m", from: "2024-01-01", backup: true }));
    assert.equal(job.dataClass, "delayed");
    const saved = await bridge.downloads.save(job, dir);
    assert.deepEqual(saved.map((s) => s.name).sort(), ["NSE-RELIANCE_5m.csv", "NSE-TCS_5m.csv"]);
    assert.ok(saved.every((s) => !s.skipped));
    assert.match(fs.readFileSync(path.join(dir, "NSE-TCS_5m.csv"), "utf8"), /^time,open,high,low,close,volume/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.dataClass, "delayed");
    assert.equal(manifest.source, "yahoo");
    assert.equal(manifest.official, false);
    assert.equal(manifest.files.length, 2);
    assert.equal(manifest.progress, undefined);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".part")).length, 0);
    const n = fake.requests().filter((r) => r.path.endsWith("/files/NSE-TCS_5m.csv")).length;
    const again = await bridge.downloads.save(job, dir);
    assert.ok(again.every((s) => s.skipped));
    assert.equal(fake.requests().filter((r) => r.path.endsWith("/files/NSE-TCS_5m.csv")).length, n);
  });

  it("a file that does not match its checksum is not kept", async () => {
    const dir = tmp();
    const job = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:RELIANCE"], intervals: "5m", from: "2024-01-01" }));
    fake.data.tamper.set("NSE-RELIANCE_5m.csv", Buffer.from("time,open\n1,2\n"));
    await assert.rejects(() => bridge.downloads.save(job, dir), (e) => e instanceof ChecksumMismatchError && e.expected !== e.actual);
    assert.deepEqual(fs.readdirSync(dir), []);
    const saved = await bridge.downloads.save(job, dir, { verify: false });
    assert.equal(saved[0].bytes, 14);
  });

  it("save only the named files", async () => {
    const dir = tmp();
    const job = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A", "NSE:B"], intervals: "5m", from: "2024-01-01" }));
    assert.deepEqual((await bridge.downloads.save(job, dir, { names: ["NSE-B_5m.csv"] })).map((s) => s.name), ["NSE-B_5m.csv"]);
  });

  it("read returns rows with symbol and interval, for csv and jsonl", async () => {
    const job = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A", "NSE:B"], intervals: "5m", from: "2024-01-01" }));
    const rows = await bridge.downloads.read(job);
    assert.equal(rows.length, 6);
    assert.deepEqual([...new Set(rows.map((r) => r.symbol))], ["NSE:A", "NSE:B"]);
    assert.equal(rows[0].interval, "5m");
    assert.equal(typeof rows[0].open, "number");
    assert.equal((await bridge.downloads.read(job, "NSE-A_5m.csv")).length, 3);
    const j2 = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01", format: "jsonl" }));
    assert.equal((await bridge.downloads.read(j2))[0].symbol, "NSE:A");
  });

  it("read refuses formats it cannot parse", async () => {
    const job = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01", format: "amibroker" }));
    const files = fake.data.jobFiles.get(job.id);
    files.set("NSE-A_5m.aqh", files.get("NSE-A_5m.csv"));
    files.delete("NSE-A_5m.csv");
    await assert.rejects(() => bridge.downloads.read(job), /read\(\) understands csv and jsonl/);
  });

  it("exports the instrument master to text or a file", async () => {
    assert.match(await bridge.downloads.exportInstruments({ kind: "EQ" }), /^symbol,exchange,kind/);
    const dest = path.join(tmp(), "master.csv");
    assert.equal(await bridge.downloads.exportInstruments({ dest, exchange: "NSE" }), dest);
    assert.equal(fs.readFileSync(dest, "utf8").split("\n").length, 4);
    await assert.rejects(() => bridge.downloads.exportInstruments({ format: "xml" }), TypeError);
  });

  it("manifest carries the label and the files", async () => {
    const job = await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01" }));
    const m = await bridge.downloads.manifest(job);
    assert.equal(m.dataClass, "realtime");
    assert.equal(m.files[0].name, "NSE-A_5m.csv");
  });
});

describe("datasets", () => {
  it("update continues the dataset and keeps the label", async () => {
    await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01", dataset: "nifty-5m" }));
    const ds = await bridge.datasets.get("nifty-5m");
    assert.deepEqual([ds.files.length, ds.dataClass], [1, "realtime"]);
    const up = await bridge.datasets.update("nifty-5m", { wait: true });
    assert.equal(up.status, "done");
    assert.equal(up.request.dataset, "nifty-5m");
    assert.equal((await bridge.datasets.update("nifty-5m")).status, "queued");
  });

  it("tags, rename and tag filter", async () => {
    await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01", dataset: "d1" }));
    await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:B"], intervals: "5m", from: "2024-01-01", dataset: "d2" }));
    await bridge.datasets.edit("d1", { tags: ["index"], description: "five minute bars" });
    assert.deepEqual((await bridge.datasets.list({ tag: "index" })).map((d) => d.name), ["d1"]);
    assert.deepEqual(fake.requests().filter((r) => r.path === "/v1/datasets").at(-1).query, { tag: "index" });
    assert.equal((await bridge.datasets.edit("d2", { newName: "d2-renamed" })).name, "d2-renamed");
    await assert.rejects(() => bridge.datasets.edit("d1"), TypeError);
    await assert.rejects(() => bridge.datasets.get("nope"), (e) => e.status === 404);
  });

  it("read serves stored bars through history with localFirst and the dataset", async () => {
    await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01", dataset: "d1" }));
    fake.data.historySeries.set("NSE:A", bars(1_760_000_000, 50));
    fake.data.localRange = [1_759_000_000, 1_770_000_000];
    const h = await bridge.datasets.read("d1", { from: "2025-10-09", to: "2025-10-10" });
    assert.ok(h.candles.length > 0);
    assert.equal(h.freshness.source, "local");
    assert.deepEqual([fake.data.historyLog.at(-1).localFirst, fake.data.historyLog.at(-1).dataset], ["true", "d1"]);
    await bridge.downloads.wait(await bridge.downloads.create({ symbols: ["NSE:B"], intervals: "5m", from: "2024-01-01", dataset: "d1" }));
    await assert.rejects(() => bridge.datasets.read("d1"), /say which one/);
  });
});

describe("recordings", () => {
  it("lifecycle: create, pause, resume, files, save, read, stop, delete", async () => {
    const rec = await bridge.recordings.create({ kind: "quotes", symbols: ["NSE:A", "NSE:B"], everySec: 1 });
    assert.deepEqual(lastBody("POST", "/v1/recordings"), { kind: "quotes", symbols: ["NSE:A", "NSE:B"], everySec: 1 });
    assert.equal(rec.status, "running");
    assert.equal((await bridge.recordings.pause(rec)).status, "paused");
    assert.equal((await bridge.recordings.resume(rec)).status, "running");
    assert.equal((await bridge.recordings.list()).length, 1);
    const files = await bridge.recordings.files(rec);
    assert.equal(files[0].day, "2026-11-09");
    const dir = tmp();
    const saved = await bridge.recordings.save(rec, dir);
    assert.equal(saved[0].bytes, files[0].bytes);
    assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
    const rows = await bridge.recordings.read(rec);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ltp, 100.5);
    assert.equal((await bridge.recordings.stop(rec)).status, "stopped");
    await bridge.recordings.delete(rec);
    assert.equal((await bridge.recordings.list()).length, 0);
  });

  it("chain recordings and argument checks", async () => {
    await bridge.recordings.create({ kind: "chain", underlying: "NIFTY", expiry: "2026-11-12", everySec: 30, sessionOnly: false, format: "jsonl", name: "n" });
    assert.deepEqual(lastBody("POST", "/v1/recordings"), { name: "n", kind: "chain", underlying: "NIFTY", expiry: "2026-11-12", everySec: 30, sessionOnly: false, format: "jsonl" });
    for (const p of [{ kind: "chain", underlying: "NIFTY", everySec: 10 }, { kind: "quotes", symbols: ["NSE:A"], everySec: 0.5 }, { kind: "quotes", everySec: 1 }, { kind: "chain", everySec: 30 }, { kind: "ticks", symbols: ["NSE:A"], everySec: 1 }]) {
      await assert.rejects(() => bridge.recordings.create(p), TypeError);
    }
  });

  it("auto-record rules", async () => {
    const r = await bridge.recordings.rules.create({ name: "Index chains", kind: "chain", everySec: 30, collection: "index-options", keepDays: 30, format: "csv" });
    assert.deepEqual(lastBody("POST", "/v1/recordings/rules"), { name: "Index chains", enabled: true, kind: "chain", collection: "index-options", everySec: 30, schedule: "market-hours", keepDays: 30, format: "csv" });
    assert.equal(r.enabled, true);
    const r2 = await bridge.recordings.rules.create({ name: "Watchlist", kind: "quotes", everySec: 5, symbols: ["NSE:A"], schedule: { days: ["MON"], start: "09:15", end: "15:30" }, enabled: false });
    assert.equal(r2.enabled, false);
    assert.deepEqual((await bridge.recordings.rules.list()).map((x) => x.name), ["Index chains", "Watchlist"]);
    assert.equal((await bridge.recordings.rules.get("Watchlist")).id, r2.id);
    assert.equal((await bridge.recordings.rules.disable(r.id)).enabled, false);
    assert.equal((await bridge.recordings.rules.enable(r.id)).enabled, true);
    assert.equal((await bridge.recordings.rules.update(r.id, { everySec: 60, keepDays: 7 })).keepDays, 7);
    assert.deepEqual(lastBody("PATCH", `/v1/recordings/rules/${r.id}`), { everySec: 60, keepDays: 7 });
    await bridge.recordings.rules.delete(r.id);
    assert.equal((await bridge.recordings.rules.list()).length, 1);
    for (const p of [{ name: "b", kind: "chain", everySec: 10, collection: "c" }, { name: "b", kind: "chain", everySec: 30 }, { name: "b", kind: "chain", everySec: 30, collection: "c", underlying: "NIFTY" }, { name: "b", kind: "bars", everySec: 30, collection: "c" }]) {
      await assert.rejects(() => bridge.recordings.rules.create(p), TypeError);
    }
    await assert.rejects(() => bridge.recordings.rules.update(r2.id), TypeError);
    await assert.rejects(() => bridge.recordings.rules.get("zzz"), TypeError);
  });
});

describe("collections", () => {
  it("static lists and option universes", async () => {
    const c = await bridge.collections.create("my-watchlist", { symbols: ["NSE:A", "NSE:B"], description: "mine", tags: ["watch"] });
    assert.deepEqual([c.kind, c.symbols, c.tags], ["static", ["NSE:A", "NSE:B"], ["watch"]]);
    const u = await bridge.collections.create("nifty-near", { universe: optionUniverse({ underlying: "NIFTY", expiries: "current-weekly", count: 2, includeFuture: true }) });
    const body = lastBody("POST", "/v1/collections");
    assert.equal(body.kind, "option-universe");
    assert.deepEqual(body.universe, { underlying: "NIFTY", expiries: "current-weekly", strikes: { around: "atm", count: 2 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: true });
    assert.equal(body.symbols, undefined);
    assert.equal(u.kind, "option-universe");
    assert.deepEqual((await bridge.collections.list()).map((x) => x.name).sort(), ["my-watchlist", "nifty-near"]);
    assert.deepEqual((await bridge.collections.list({ tag: "watch" })).map((x) => x.name), ["my-watchlist"]);
    assert.deepEqual((await bridge.collections.list({ kind: "option-universe" })).map((x) => x.name), ["nifty-near"]);
    await assert.rejects(() => bridge.collections.create("x", {}), TypeError);
    await assert.rejects(() => bridge.collections.create("x", { symbols: ["NSE:A"], universe: optionUniverse({ underlying: "NIFTY" }) }), TypeError);
  });

  it("optionUniverse checks its arguments", () => {
    assert.deepEqual(optionUniverse({ underlying: "NIFTY", expiries: ["2026-11-12"], fromStrike: 25000, toStrike: 26000, sides: ["CE"], includeUnderlying: false }).strikes, { from: 25000, to: 26000 });
    assert.throws(() => optionUniverse({ underlying: "NIFTY", fromStrike: 25000 }), TypeError);
    assert.throws(() => optionUniverse({ underlying: "NIFTY", sides: ["XX"] }), TypeError);
    assert.throws(() => optionUniverse({ underlying: "NIFTY", count: -1 }), TypeError);
    assert.throws(() => optionUniverse({}), TypeError);
  });

  it("resolve follows the universe and is honest about the price", async () => {
    const c = await bridge.collections.create("nifty-near", { universe: optionUniverse({ underlying: "NIFTY", count: 1 }) });
    assert.match(c.id, /^col_/);
    const r = await bridge.collections.resolve("nifty-near");
    assert.equal(r.symbols[0], "NSE:NIFTY");
    assert.equal(r.symbols.length, 1 + 3 * 2);
    assert.equal(r.atm, 26000);
    assert.equal(r.atmSource, "stream");
    assert.match(r.rule, /ATM 26000/);
    assert.equal(bridge.collections.isReliable(r), true);
    assert.deepEqual(fake.requests().filter((x) => x.path === "/v1/collections/nifty-near/resolve").at(-1).query, {});
    // a delayed price is refused by the Bridge (422): the SDK throws, it never falls back to a stale ATM
    fake.data.atmDelayed = "delayed";
    await assert.rejects(() => bridge.collections.resolve("nifty-near", { allowStale: true }), (e) => e.status === 422);
    // a stale price is refused (503) unless the caller says allowStale; the answer is then labelled
    fake.data.atmDelayed = "stale";
    await assert.rejects(() => bridge.collections.resolve("nifty-near"), (e) => e.status === 503);
    const r2 = await bridge.collections.resolve("nifty-near", { allowStale: true });
    assert.deepEqual(fake.requests().filter((x) => x.path === "/v1/collections/nifty-near/resolve").at(-1).query, { allowStale: "1" });
    assert.equal(bridge.collections.isReliable(r2), false);
    assert.match(r2.warnings[0], /stale/);
    assert.equal(r2.atmSource, "cache");
    assert.deepEqual(await bridge.collections.symbols("nifty-near", { allowStale: true }), r2.symbols);
  });

  it("edit, rename, tag, duplicate, delete", async () => {
    await bridge.collections.create("a", { symbols: ["NSE:A"], tags: ["x"] });
    assert.deepEqual((await bridge.collections.tag("a", ["y", "x"], { remove: ["z"] })).tags, ["x", "y"]);
    assert.deepEqual((await bridge.collections.tag("a", [], { remove: ["x"] })).tags, ["y"]);
    assert.deepEqual((await bridge.collections.update("a", { symbols: ["NSE:A", "NSE:B"], description: "d" })).symbols, ["NSE:A", "NSE:B"]);
    assert.equal((await bridge.collections.rename("a", "b")).name, "b");
    await assert.rejects(() => bridge.collections.get("a"), (e) => e.status === 404);
    const d = await bridge.collections.duplicate("b", "b2");
    assert.deepEqual([d.name, d.symbols, d.tags, d.description], ["b2", ["NSE:A", "NSE:B"], ["y"], "d"]);
    await bridge.collections.create("dyn", { universe: optionUniverse({ underlying: "NIFTY" }) });
    assert.equal((await bridge.collections.duplicate("dyn", "dyn2")).kind, "option-universe");
    await bridge.collections.delete("b2");
    assert.ok(!(await bridge.collections.list()).some((c) => c.name === "b2"));
    await assert.rejects(() => bridge.collections.update("b"), TypeError);
  });

  it("export and import round trip (json, csv, text, lists)", async () => {
    const dir = tmp();
    await bridge.collections.create("w", { symbols: ["NSE:A", "NSE:B"], description: "my list", tags: ["t"] });
    const js = await bridge.collections.export("w", { format: "json", path: path.join(dir, "w.json") });
    assert.deepEqual(JSON.parse(js), { name: "w", description: "my list", tags: ["t"], kind: "static", symbols: ["NSE:A", "NSE:B"] });
    const csv = await bridge.collections.export("w", { format: "csv" });
    assert.equal(csv, "symbol\nNSE:A\nNSE:B\n");
    await bridge.collections.delete("w");
    const back = await bridge.collections.importFrom(path.join(dir, "w.json"));
    assert.deepEqual([back.name, back.symbols, back.tags], ["w", ["NSE:A", "NSE:B"], ["t"]]);
    fs.writeFileSync(path.join(dir, "x.csv"), csv);
    const c2 = await bridge.collections.importFrom(path.join(dir, "x.csv"), { name: "from-csv", tags: ["imp"] });
    assert.deepEqual([c2.symbols, c2.tags], [["NSE:A", "NSE:B"], ["imp"]]);
    assert.deepEqual((await bridge.collections.importFrom("NSE:A\nNSE:C\n", { name: "plain" })).symbols, ["NSE:A", "NSE:C"]);
    assert.deepEqual((await bridge.collections.importFrom('["NSE:Z"]', { name: "from-list" })).symbols, ["NSE:Z"]);
    await assert.rejects(() => bridge.collections.importFrom("NSE:A\n"), TypeError);
  });

  it("a universe exports as CSV with the resolved symbols", async () => {
    await bridge.collections.create("u", { universe: optionUniverse({ underlying: "NIFTY", count: 1, includeUnderlying: false }) });
    const lines = (await bridge.collections.export("u", { format: "csv" })).trim().split("\n");
    assert.equal(lines[0], "symbol");
    assert.equal(lines.length, 1 + 6);
    assert.equal(JSON.parse(await bridge.collections.export("u")).universe.underlying, "NIFTY");
    await assert.rejects(() => bridge.collections.export("u", { format: "xml" }), TypeError);
  });

  it("usage and estimate", async () => {
    await bridge.collections.create("w", { symbols: ["NSE:A", "NSE:B"] });
    await bridge.downloads.create({ collection: "w", intervals: "5m", from: "2024-01-01" });
    assert.equal((await bridge.collections.usage("w")).downloads.length, 1);
    const est = await bridge.collections.estimate("w", { intervals: ["5m", "1d"], days: 30 });
    assert.equal(est.symbols, 2);
    assert.equal(est.rows, 2 * 2 * 30 * 75);
    assert.deepEqual(fake.requests().filter((r) => r.path === "/v1/collections/w/estimate").at(-1).query, { intervals: "5m,1d", days: "30" });
  });
});

describe("subscriptions", () => {
  it("never show the secret again", async () => {
    const s = await bridge.subscriptions.create({ url: "https://example.org/hook", topics: ["download.*"], secret: "s3cret-s3cret-s3cret" });
    assert.equal(lastBody("POST", "/v1/subscriptions").secret, "s3cret-s3cret-s3cret");
    assert.equal(s.secret, undefined);
    assert.deepEqual([s.topics, s.active], [["download.*"], true]);
    assert.equal((await bridge.subscriptions.list())[0].secret, undefined);
    assert.equal((await bridge.subscriptions.update(s.id, { active: false })).active, false);
    assert.equal((await bridge.subscriptions.test(s.id)).delivered, true);
    assert.equal((await bridge.subscriptions.deliveries(s.id))[0].status, "delivered");
    await bridge.subscriptions.delete(s.id);
    assert.equal((await bridge.subscriptions.list()).length, 0);
    await assert.rejects(() => bridge.subscriptions.create({ url: "https://example.org/h", topics: [], secret: "x".repeat(20) }), TypeError);
    await assert.rejects(() => bridge.subscriptions.update(s.id), TypeError);
  });
});

describe("table helpers", () => {
  it("parseTable types cells and handles quotes and a BOM", () => {
    assert.deepEqual(parseTable("﻿time,open,volume,note\n2026-11-09T09:15:00+05:30,1.5,10,\n2026-11-09T09:20:00+05:30,2,,\"a,b\"\n"), [
      { time: "2026-11-09T09:15:00+05:30", open: 1.5, volume: 10, note: null },
      { time: "2026-11-09T09:20:00+05:30", open: 2, volume: null, note: "a,b" },
    ]);
    assert.deepEqual(parseTable('{"a":1}\n\n{"a":2}\n', "jsonl"), [{ a: 1 }, { a: 2 }]);
    assert.throws(() => parseTable("a", "xml"), TypeError);
  });

  it("toCsv quotes what needs quoting", () => {
    assert.equal(toCsv([{ a: 1, b: 'x,"y"' }, { a: null, b: "z" }]), 'a,b\n1,"x,""y"""\n,z\n');
  });
});

describe("an older Bridge", () => {
  it("answers 404 and the error says so", async () => {
    fake.script("POST", "/v1/downloads", [{ status: 404, body: { status: 404, code: "NOT_FOUND", detail: "No route." } }]);
    await assert.rejects(() => bridge.downloads.create({ symbols: ["NSE:A"], intervals: "5m", from: "2024-01-01" }), (e) => e.status === 404 && e.code === "NOT_FOUND");
  });
});
