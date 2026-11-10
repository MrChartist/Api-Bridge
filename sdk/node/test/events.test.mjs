// Node SDK: event subscription (SSE with reconnect and cursor), webhook signatures and historyAll against the fake Bridge.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { BridgeApiError, BridgeClient, SignatureInvalidError, eventFrom, explainSignature, parseSse, signPayload, topicMatches, verifyRequest, verifySignature } from "../src/index.mjs";
import { ATTEMPT_HEADER, DELIVERY_HEADER, EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/events.mjs";
import { eventFrom as eventFromDirect, parseSse as parseSseDirect } from "../src/events.mjs";
import { DAY, bars } from "./fakeData.mjs";
import { TEST_KEY, createFakeBridge } from "./fakeServer.mjs";

const SECRET = "a-long-enough-secret-value";
const T0 = 1_760_000_000;
let fake;
let baseUrl;
let waits;
let bridge;

before(async () => {
  fake = createFakeBridge();
  baseUrl = `http://127.0.0.1:${await fake.listen()}`;
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  waits = [];
  bridge = new BridgeClient({ baseUrl, apiKey: TEST_KEY, sleep: async (ms) => waits.push(ms), maxRetries: 0 });
});

async function take(sub, n) {
  const out = [];
  for await (const ev of sub) {
    out.push(ev);
    if (out.length >= n) sub.close();
  }
  return out;
}
async function* chunks(...parts) {
  for (const p of parts) yield p;
}

// The Bridge signs "<timestamp>." + raw body with HMAC-SHA256 and sends X-Bridge-Timestamp and X-Bridge-Signature: v1=<hex>.
describe("signatures", () => {
  it("a signature made by the sender verifies, with the documented construction", () => {
    const body = Buffer.from('{"id":"1043","topic":"download.done","data":{"id":"dl_1"}}');
    const h = signPayload(SECRET, body, 1_800_000_000);
    assert.equal(h["X-Bridge-Timestamp"], "1800000000");
    assert.match(h["X-Bridge-Signature"], /^v1=[0-9a-f]{64}$/);
    assert.equal(h["X-Bridge-Signature"], `v1=${createHmac("sha256", SECRET).update("1800000000.").update(body).digest("hex")}`);
    assert.equal(verifySignature(SECRET, body, h, { now: 1_800_000_100 }), true);
    assert.equal(verifySignature(SECRET, body, { timestamp: "1800000000", signature: h["X-Bridge-Signature"] }, { now: 1_800_000_100 }), true);
    assert.equal(verifySignature(Buffer.from(SECRET), body.toString(), h, { now: 1_800_000_100 }), true); // text or bytes
  });

  it("a changed body, secret or timestamp fails", () => {
    const body = '{"x":1}';
    const h = signPayload(SECRET, body, 1_800_000_000);
    assert.equal(verifySignature(SECRET, '{"x":2}', h, { now: 1_800_000_000 }), false);
    assert.equal(verifySignature("another-secret-value", body, h, { now: 1_800_000_000 }), false);
    assert.equal(verifySignature(SECRET, body, { ...h, "X-Bridge-Timestamp": "1800000001" }, { now: 1_800_000_001 }), false);
    assert.equal(verifySignature(SECRET, '{"x": 1}', h, { now: 1_800_000_000 }), false); // re-serialised JSON changes the bytes
  });

  it("old and future timestamps are refused, the window is adjustable", () => {
    const h = signPayload(SECRET, "{}", 1_800_000_000);
    assert.equal(verifySignature(SECRET, "{}", h, { now: 1_800_000_300 }), true);
    assert.equal(verifySignature(SECRET, "{}", h, { now: 1_800_000_301 }), false);
    assert.equal(verifySignature(SECRET, "{}", h, { now: 1_799_999_600 }), false);
    assert.equal(verifySignature(SECRET, "{}", h, { now: 1_800_000_900, toleranceSec: 1000 }), true);
  });

  it("missing or malformed headers, and the reason", () => {
    const zero = `v1=${"0".repeat(64)}`;
    const cases = [
      [{}, "missing_header"],
      [{ "X-Bridge-Timestamp": "1800000000" }, "missing_header"],
      [{ "X-Bridge-Signature": zero }, "missing_header"],
      [{ "X-Bridge-Timestamp": "abc", "X-Bridge-Signature": zero }, "malformed_header"],
      [{ "X-Bridge-Timestamp": "1800000000", "X-Bridge-Signature": "garbage" }, "malformed_header"],
      [{ "X-Bridge-Timestamp": "1800000000", "X-Bridge-Signature": "v1=short" }, "malformed_header"],
      [{ "X-Bridge-Timestamp": "1800000000", "X-Bridge-Signature": zero }, "signature_mismatch"],
    ];
    for (const [headers, reason] of cases) {
      assert.equal(verifySignature(SECRET, "{}", headers, { now: 1_800_000_000 }), false);
      assert.equal(explainSignature(SECRET, "{}", headers, { now: 1_800_000_000 }).reason, reason);
      assert.throws(() => verifySignature(SECRET, "{}", headers, { now: 1_800_000_000, throwOnFail: true }), (e) => e instanceof SignatureInvalidError && e.reason === reason);
    }
    assert.equal(explainSignature(SECRET, "{}", signPayload(SECRET, "{}", 1), { now: 1_800_000_000 }).reason, "timestamp_out_of_range");
  });

  it("secret rotation on either side, header values separated by space or comma", () => {
    const [old, next] = ["old-secret-old-secret", "new-secret-new-secret"];
    const mac = (s) => createHmac("sha256", s).update("1800000000.{}").digest("hex");
    for (const sep of [" ", ","]) {
      const both = { "X-Bridge-Timestamp": "1800000000", "X-Bridge-Signature": `v1=${mac(old)}${sep}v1=${mac(next)}` };
      assert.ok(verifySignature(next, "{}", both, { now: 1_800_000_000 }) && verifySignature(old, "{}", both, { now: 1_800_000_000 }));
    }
    assert.ok(verifySignature([next, old], "{}", signPayload(old, "{}", 1_800_000_000), { now: 1_800_000_000 }));
    assert.equal(verifySignature([next], "{}", signPayload(old, "{}", 1_800_000_000), { now: 1_800_000_000 }), false);
  });

  it("verifyRequest reads the headers from an object or Headers in any case", () => {
    const body = '{"a":1}';
    const h = signPayload(SECRET, body);
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    assert.ok(verifyRequest(SECRET, { ...lower, "content-type": "application/json" }, body));
    assert.ok(verifyRequest(SECRET, new Headers(h), body));
    assert.equal(verifyRequest(SECRET, { "content-type": "application/json" }, body), false);
  });

  it("the header names are the Bridge's", () => {
    assert.deepEqual([SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER, DELIVERY_HEADER, ATTEMPT_HEADER], ["X-Bridge-Signature", "X-Bridge-Timestamp", "X-Bridge-Event-Id", "X-Bridge-Delivery", "X-Bridge-Attempt"]);
  });
});

describe("parsing", () => {
  it("parseSse handles frames, comments, multi-line data and split chunks", async () => {
    const frames = [];
    for await (const f of parseSse(chunks(": hello\n\nid: 7\nev", "ent: download.done\ndata: {\"a\":\ndata: 1}\n", "\nretry: 2500\ndata: x\n\n"))) frames.push(f);
    assert.deepEqual(frames[0], { id: "7", event: "download.done", data: '{"a":\n1}', retry: undefined });
    assert.equal(frames[1].data, "x");
    assert.equal(frames[1].retry, 2500);
    assert.equal(parseSse, parseSseDirect);
  });

  it("event shapes", () => {
    const full = eventFrom("9", "download.done", '{"cursor":"9","topic":"download.done","time":"2026-11-09T10:00:00+05:30","data":{"id":"dl_1"}}');
    assert.deepEqual([full.cursor, full.topic, full.data.id, full.time], ["9", "download.done", "dl_1", "2026-11-09T10:00:00+05:30"]);
    const real = eventFrom("1043", "order.updated", '{"id":"1043","topic":"order.updated","time":"2026-11-09T04:01:02.000Z","apiVersion":"v1","data":{"orderId":"P1"}}');
    assert.deepEqual([real.cursor, real.topic, real.data.orderId, real.time], ["1043", "order.updated", "P1", "2026-11-09T04:01:02.000Z"]);
    const bare = eventFrom("3", "order.update", '{"orderId":"o1"}');
    assert.deepEqual([bare.cursor, bare.topic, bare.data], ["3", "order.update", { orderId: "o1" }]);
    assert.equal(eventFrom(undefined, undefined, '{"type":"tick"}').topic, "tick");
    assert.deepEqual(eventFrom("1", "x", "not json").data, { text: "not json" });
    assert.equal(eventFrom, eventFromDirect);
  });

  it("topic patterns", () => {
    assert.ok(topicMatches("download.*", "download.done") && topicMatches("*", "anything") && topicMatches("a.b", "a.b"));
    assert.ok(!topicMatches("download.*", "downloads.done") && !topicMatches("download.*", "download"));
  });
});

describe("subscribe", () => {
  it("filters topics and tracks the cursor", async () => {
    fake.data.emit("download.done", { id: "a" });
    fake.data.emit("recording.gap", { id: "r" });
    fake.data.emit("download.failed", { id: "b" });
    const evs = await take(bridge.events.subscribe({ topics: "download.*" }), 2);
    assert.deepEqual(evs.map((e) => [e.topic, e.data.id, e.cursor]), [["download.done", "a", "1"], ["download.failed", "b", "3"]]);
    const req = fake.requests().find((r) => r.path === "/v1/events/stream");
    assert.deepEqual(req.query, { topics: "download.*" });
    assert.equal(req.authorization, "present");
  });

  it("a dropped connection resumes after the last cursor, nothing lost or repeated", async () => {
    fake.data.sseDropAfter = 2;
    for (let i = 1; i <= 5; i += 1) fake.data.emit("download.progress", { n: i });
    const sub = bridge.events.subscribe({ topics: ["download.progress"] });
    const evs = await take(sub, 5);
    assert.deepEqual(evs.map((e) => e.data.n), [1, 2, 3, 4, 5]);
    const reqs = fake.requests().filter((r) => r.path === "/v1/events/stream");
    assert.equal(reqs.length, 3);
    assert.equal(sub.reconnects, 2);
    assert.deepEqual(reqs.map((r) => r.query.since), [undefined, "2", "4"]);
    assert.ok(waits.length >= 2 && waits.every((w) => w >= 1000));
  });

  it("since resumes from a saved cursor", async () => {
    for (let i = 1; i <= 4; i += 1) fake.data.emit("recording.started", { n: i });
    const evs = await take(bridge.events.subscribe({ since: "2" }), 2);
    assert.deepEqual(evs.map((e) => e.data.n), [3, 4]);
    assert.equal(fake.requests().find((r) => r.path === "/v1/events/stream").query.since, "2");
  });

  it("a server error is retried with growing waits, a wrong key is thrown", async () => {
    fake.data.sseFailFirst = 2;
    fake.data.emit("download.done", { id: "a" });
    const evs = await take(bridge.events.subscribe(), 1);
    assert.equal(evs[0].data.id, "a");
    assert.equal(waits.length, 2);
    assert.ok(waits[1] > waits[0] * 1.5);
    const bad = new BridgeClient({ baseUrl, apiKey: "mcb_wrong_key_000000", sleep: async () => {}, maxRetries: 0 });
    await assert.rejects(async () => { for await (const _ of bad.events.subscribe()) break; }, (e) => e instanceof BridgeApiError && e.status === 401);
  });

  it("reconnect: false ends instead of retrying", async () => {
    fake.data.emit("download.done", { id: "a" });
    const got = [];
    for await (const ev of bridge.events.subscribe({ reconnect: false })) got.push(ev.data.id);
    assert.deepEqual(got, ["a"]);
    assert.equal(fake.requests().filter((r) => r.path === "/v1/events/stream").length, 1);
    fake.data.sseFailFirst = 1;
    await assert.rejects(async () => { for await (const _ of bridge.events.subscribe({ reconnect: false })); }, (e) => e.status === 503);
  });

  it("maxReconnects stops a quiet stream", async () => {
    const sub = bridge.events.subscribe({ maxReconnects: 2 });
    const got = [];
    for await (const ev of sub) got.push(ev);
    assert.deepEqual(got, []);
    assert.equal(sub.reconnects, 3);
    assert.equal(fake.requests().filter((r) => r.path === "/v1/events/stream").length, 3);
  });

  it("close() ends the iteration, also while it waits to reconnect", async () => {
    const slow = new BridgeClient({ baseUrl, apiKey: TEST_KEY, maxRetries: 0 });
    fake.data.emit("download.done", { id: "a" });
    const sub = slow.events.subscribe({ maxBackoffMs: 60_000 });
    const got = [];
    const run = (async () => { for await (const ev of sub) got.push(ev); })();
    const t0 = Date.now();
    while (!got.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    sub.close();
    await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("close did not end the iteration")), 3000))]);
    assert.equal(got[0].data.id, "a");
    assert.equal(sub.closed, true);
  });

  it("waitFor returns the matching event or undefined", async () => {
    fake.data.emit("download.progress", { id: "a", n: 1 });
    fake.data.emit("download.done", { id: "b" });
    assert.equal((await bridge.events.waitFor("download.done", undefined, { timeoutMs: 5000 })).data.id, "b");
    assert.equal(await bridge.events.waitFor("download.done", (e) => e.data.id === "zzz", { timeoutMs: 300 }), undefined);
  });
});

describe("gap, poll and topics", () => {
  it("the ready message reports a gap and is not an event", async () => {
    for (let i = 1; i <= 3; i += 1) fake.data.emit("download.done", { n: i });
    const seen = [];
    const sub = bridge.events.subscribe({ since: "99", maxReconnects: 0, onGap: (r) => seen.push(r) });
    const got = [];
    for await (const ev of sub) got.push(ev);
    assert.deepEqual(got, []);
    assert.deepEqual([sub.gap, sub.gapReason, seen, sub.ready.cursor], [true, "cursor_ahead", ["cursor_ahead"], "3"]);
    const ok = bridge.events.subscribe({ since: "1", maxReconnects: 0 });
    const evs = [];
    for await (const ev of ok) evs.push(ev.data.n);
    assert.deepEqual([evs, ok.gap, ok.gapReason], [[2, 3], false, undefined]);
  });

  it("poll and topics", async () => {
    for (let i = 1; i <= 5; i += 1) fake.data.emit(i % 2 ? "download.done" : "recording.gap", { n: i });
    const page = await bridge.events.poll({ since: "1", topics: "download.*", limit: 10 });
    assert.deepEqual([page.events.map((e) => e.data.n), page.cursor, page.gap], [[3, 5], "5", false]);
    assert.deepEqual(fake.requests().filter((r) => r.path === "/v1/events").at(-1).query, { since: "1", topics: "download.*", limit: "10" });
    assert.equal((await bridge.events.poll({ since: "50" })).gap, true);
    assert.equal((await bridge.events.topics())[0].topic, "download.done");
  });
});

describe("historyAll", () => {
  const daily = (n, start = T0) => bars(start, n, DAY);

  it("windows cover the range oldest first without duplicates, and nothing is fetched before iterating", async () => {
    fake.data.historySeries.set("NSE:A", daily(100));
    const it = bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: T0, to: T0 + 99 * DAY, chunkDays: 30 });
    assert.equal(fake.data.historyLog.length, 0);
    const times = [];
    for await (const c of it) times.push(c.time);
    assert.equal(times.length, 100);
    assert.deepEqual(times, [...new Set(times)].sort((a, b) => a - b));
    assert.equal(it.calls, 4);
    const froms = fake.data.historyLog.map((w) => w.from);
    assert.deepEqual(froms, [...froms].sort((a, b) => a - b));
    assert.equal(froms[0], T0);
    assert.ok(fake.data.historyLog.every((w) => w.localFirst === undefined));
  });

  it("a partial window is split until it fits", async () => {
    fake.data.historySeries.set("NSE:A", daily(60));
    fake.data.historyMaxDays = 10;
    const it = bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: T0, to: T0 + 59 * DAY, chunkDays: 60 });
    const got = (await it.toArray()).map((c) => c.time);
    assert.deepEqual(got, Array.from({ length: 60 }, (_, i) => T0 + i * DAY));
    assert.ok(it.calls > 1 && !it.partial && it.gaps.length === 0);
    const last = fake.data.historyLog.at(-1);
    assert.ok(last.to - last.from <= 10 * DAY);
  });

  it("a window that stays partial is reported as a gap", async () => {
    fake.data.historySeries.set("NSE:A", daily(10));
    fake.data.historyMaxDays = 0.5;
    const it = bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: T0, to: T0 + 9 * DAY, chunkDays: 10 });
    const h = await it.toHistory();
    assert.ok(it.partial && it.gaps.length > 0 && h.partial);
    assert.equal(h.gaps.length, it.gaps.length);
  });

  it("history, records and csv carry the freshness label", async () => {
    fake.data.historySeries.set("NSE:A", daily(5));
    const it = bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: "2025-10-09", to: T0 + 4 * DAY });
    const h = await it.toHistory();
    assert.deepEqual([h.candles.length, h.symbol, h.freshness.class, h.windows], [5, "NSE:A", "realtime", 1]);
    assert.equal((await it.toArray()).length, 5);
    assert.equal(it.calls, 1);
    const recs = await it.records();
    assert.deepEqual([recs[0].open, recs[0].source, recs[0].class], [100, "broker", "realtime"]);
    assert.match(recs[0].time, /^2025-10-09T\d\d:\d\d:\d\d\+05:30$/);
    const text = await it.toCsv();
    assert.equal(text.split("\n")[0], "time,open,high,low,close,volume,source,class,delaySec,official,confidence");
    assert.equal(text.trim().split("\n").length, 6);
    assert.equal((await it.toCsv({ freshness: false })).split("\n")[0], "time,open,high,low,close,volume");
  });

  it("freshness is the least current of the windows and requireRealtime refuses delayed data", async () => {
    fake.data.historySeries.set("NSE:A", daily(5));
    const it = bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: T0, to: T0 + 4 * DAY, backup: true });
    await it.toArray();
    assert.equal(it.freshness.class, "delayed");
    assert.equal(it.freshness.official, false);
    assert.throws(() => it.requireRealtime(), /not real-time/);
  });

  it("localFirst sends the flag and counts where windows came from", async () => {
    fake.data.historySeries.set("NSE:A", daily(60));
    fake.data.localRange = [T0, T0 + 30 * DAY];
    const it = bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: T0, to: T0 + 59 * DAY, chunkDays: 15, localFirst: true, dataset: "d1" });
    assert.equal((await it.toArray()).length, 60);
    assert.ok(fake.data.historyLog.every((w) => w.localFirst === "true" && w.dataset === "d1"));
    assert.deepEqual([it.calls, it.localWindows, it.brokerWindows, it.sources.local], [4, 2, 2, 2]);
  });

  it("checks its arguments and plain history takes localFirst and dataset", async () => {
    assert.throws(() => bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: "2025-02-01", to: "2025-01-01" }), TypeError);
    assert.throws(() => bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: "2025-01-01", chunkDays: 0 }), TypeError);
    assert.throws(() => bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: "not a date" }), TypeError);
    assert.equal(bridge.historyAll({ symbol: "NSE:A", interval: "5m", from: "2025-01-01" }).chunkDays, 120);
    assert.equal(bridge.historyAll({ symbol: "NSE:A", interval: "1d", from: "2025-01-01" }).chunkDays, 1500);
    fake.data.historySeries.set("NSE:A", daily(3));
    fake.data.localRange = [T0, T0 + 10 * DAY];
    const r = await bridge.history({ symbol: "NSE:A", interval: "1d", from: T0, to: T0 + 2 * DAY, localFirst: true, dataset: "d1" });
    assert.equal(r.data.candles.length, 3);
    assert.equal(r.meta.source, "local");
    assert.deepEqual(fake.data.historyLog.at(-1), { from: T0, to: T0 + 2 * DAY, localFirst: "true", dataset: "d1" });
  });
});
