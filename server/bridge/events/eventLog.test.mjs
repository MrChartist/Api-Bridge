import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventLog, toEnvelope } from "./eventLog.mjs";
import { createClock, tmpDir } from "./testkit.mjs";

const mk = (dir, clock, extra = {}) => createEventLog({ dir, retain: 100, now: clock.now, ...extra });

describe("event log", () => {
  it("numbers events from 1 and keeps them in order", () => {
    const clock = createClock();
    const log = mk(tmpDir(), clock);
    const a = log.record("order.updated", { orderId: "o1", accountId: "paper" });
    clock.advance(1000);
    const b = log.record("safety.kill_switch", { engaged: true });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b.at - a.at).toBe(1000);
    expect(log.latest()).toBe(2);
    expect(toEnvelope(a)).toEqual({ id: "1", topic: "order.updated", time: new Date(a.at).toISOString(), apiVersion: "v1", data: { orderId: "o1", accountId: "paper" } });
  });

  it("ignores topics that are not offered (ticks, key events) and never stores them", () => {
    const log = mk(tmpDir(), createClock());
    expect(log.record("tick", { symbol: "NSE:X" })).toBeNull();
    expect(log.record("key.revoked", { keyId: "k" })).toBeNull();
    expect(log.record("audit.appended", { seq: 1 })).toBeNull();
    expect(log.latest()).toBe(0);
  });

  it("sanitizes data before it is stored or sent", () => {
    const dir = tmpDir();
    const log = mk(dir, createClock());
    const e = log.record("ticket.prepared", { ticketId: "tkt_1", accountId: "a", confirmToken: "mct_secretsecretsecret", symbol: "NSE:X" });
    expect(e.data).toEqual({ ticketId: "tkt_1", accountId: "a", symbol: "NSE:X" });
    expect(readFileSync(join(dir, "log.jsonl"), "utf8")).not.toContain("mct_secret");
  });

  it("replays after a cursor, with filter and limit, and says when events are gone", () => {
    const log = createEventLog({ dir: tmpDir(), retain: 100, now: createClock().now });
    for (let i = 1; i <= 10; i += 1) log.record("order.updated", { orderId: `o${i}`, accountId: i % 2 ? "a" : "b" });
    expect(log.since(null).events).toEqual([]);
    expect(log.since(7).events.map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(log.since(0, { filter: (e) => e.data.accountId === "a" }).events.map((e) => e.seq)).toEqual([1, 3, 5, 7, 9]);
    const lim = log.since(0, { limit: 4 });
    expect(lim.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(lim.more).toBe(true);
    expect(log.since(10)).toMatchObject({ events: [], gap: false, latest: 10, oldest: 1 });
    expect(log.since(99)).toMatchObject({ gap: true, gapReason: "cursor_ahead" });
  });

  it("keeps only the last `retain` events and reports a gap before them", () => {
    const log = createEventLog({ dir: tmpDir(), retain: 100, now: createClock().now });
    // retain has a floor of 100 in config; the log itself accepts any number, so use a small one here
    const small = createEventLog({ dir: tmpDir(), retain: 5, now: createClock().now });
    for (let i = 1; i <= 12; i += 1) small.record("config.warning", { message: `w${i}` });
    const r = small.since(0);
    expect(r.events.map((e) => e.seq)).toEqual([8, 9, 10, 11, 12]);
    expect(r).toMatchObject({ gap: true, gapReason: "retention", oldest: 8 });
    expect(small.since(7).gap).toBe(false); // 8 is the next one, nothing missing
    expect(small.since(6).gap).toBe(true);
    expect(log.since(0).events).toEqual([]);
  });

  it("survives a restart: the numbering continues and a cursor from before still works", () => {
    const dir = tmpDir();
    const clock = createClock();
    const a = mk(dir, clock);
    for (let i = 0; i < 5; i += 1) a.record("order.updated", { orderId: `o${i}`, accountId: "p" });
    const b = mk(dir, clock);
    expect(b.latest()).toBe(5);
    expect(b.since(3).events.map((e) => e.data.orderId)).toEqual(["o3", "o4"]);
    expect(b.record("order.updated", { orderId: "o5", accountId: "p" }).seq).toBe(6);
    expect(mk(dir, clock).since(4).events.map((e) => e.seq)).toEqual([5, 6]);
  });

  it("rewrites the file to the last `retain` events when it grows past twice that, and still restarts cleanly", () => {
    const dir = tmpDir();
    const clock = createClock();
    const log = createEventLog({ dir, retain: 10, now: clock.now });
    for (let i = 1; i <= 45; i += 1) log.record("config.warning", { message: `w${i}` });
    const lines = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(21);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    const again = createEventLog({ dir, retain: 10, now: clock.now });
    expect(again.latest()).toBe(45);
    expect(again.since(0).events.map((e) => e.seq)).toEqual([36, 37, 38, 39, 40, 41, 42, 43, 44, 45]);
    expect(statSync(join(dir, "log.jsonl")).mode & 0o077).toBe(0);
  });

  it("skips a torn last line and keeps counting", () => {
    const dir = tmpDir();
    const log = mk(dir, createClock());
    log.record("order.updated", { orderId: "o1", accountId: "p" });
    log.record("order.updated", { orderId: "o2", accountId: "p" });
    appendFileSync(join(dir, "log.jsonl"), '{"seq":3,"topic":"order.upd');
    const again = mk(dir, createClock());
    expect(again.latest()).toBe(2);
    expect(again.record("order.updated", { orderId: "o3", accountId: "p" }).seq).toBe(3);
    expect(mk(dir, createClock()).since(0).events.map((e) => e.data.orderId)).toEqual(["o1", "o2", "o3"]);
  });

  it("moves an unreadable file aside and starts again from 1 (a client asking for a later cursor is told)", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "log.jsonl"), "not json\nstill not json\n");
    const log = mk(dir, createClock());
    expect(log.latest()).toBe(0);
    expect(readdirSync(dir).some((f) => f.startsWith("log.jsonl.corrupt-"))).toBe(true);
    log.record("order.updated", { accountId: "p" });
    expect(log.since(500)).toMatchObject({ gap: true, gapReason: "cursor_ahead" });
  });

  it("throttles noisy topics per key with the injected clock, and counts what it dropped", () => {
    const clock = createClock();
    const log = mk(tmpDir(), clock);
    expect(log.record("download.progress", { id: "d1", progress: { done: 1 } })).not.toBeNull();
    clock.advance(400);
    expect(log.record("download.progress", { id: "d1", progress: { done: 2 } })).toBeNull();
    expect(log.record("download.progress", { id: "d2", progress: { done: 1 } })).not.toBeNull(); // another job
    clock.advance(700);
    expect(log.record("download.progress", { id: "d1", progress: { done: 3 } })).not.toBeNull();
    expect(log.record("download.done", { id: "d1" })).not.toBeNull(); // not throttled
    expect(log.record("download.done", { id: "d1" })).not.toBeNull();
    expect(log.stats()).toMatchObject({ throttled: 1, recorded: 5 });
  });

  it("tells listeners after the event is stored, and a failing listener does not stop the others", () => {
    const log = mk(tmpDir(), createClock());
    const seen = [];
    log.subscribe(() => {
      throw new Error("boom");
    });
    const off = log.subscribe((e) => seen.push([e.seq, log.since(e.seq - 1).events.length]));
    log.record("order.updated", { accountId: "p" });
    expect(seen).toEqual([[1, 1]]);
    off();
    log.record("order.updated", { accountId: "p" });
    expect(seen).toHaveLength(1);
  });

  it("does not throw when the disk is not writable", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "blocker"), "a file, not a folder");
    const lines = [];
    const log = mk(join(dir, "blocker", "deeper"), createClock(), { logger: { error: (m) => lines.push(m), warn: () => {} } });
    expect(log.record("order.updated", { accountId: "p" }).seq).toBe(1);
    expect(log.stats().writeErrors).toBe(1);
    expect(lines).toHaveLength(1);
    expect(log.since(0).events).toHaveLength(1); // still served from memory
  });
});
