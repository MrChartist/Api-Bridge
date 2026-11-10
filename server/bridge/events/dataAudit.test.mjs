/**
 * Regression tests from the data review (RDATA-xx): each one failed before its fix.
 */
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventLog } from "./eventLog.mjs";
import { createEventsRoutes } from "./routes.mjs";
import { createClock } from "./testkit.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "mcb-ev-audit-"));

/** A timer the test fires by hand, so no real time passes. */
function manualTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = pending.indexOf(t);
      if (i >= 0) pending.splice(i, 1);
    },
    pending,
    fireAll() {
      for (const t of pending.splice(0)) t.fn();
    },
  };
}

describe("RDATA-06 the throttle never loses a state change, and the last event is delivered", () => {
  it("lets a pause 300 ms after a progress event through", () => {
    const clock = createClock();
    const log = createEventLog({ dir: dir(), retain: 100, now: clock.now, ...manualTimers() });
    expect(log.record("download.progress", { id: "dl_1", status: "running", done: 3 })).not.toBeNull();
    clock.advance(300);
    expect(log.record("download.progress", { id: "dl_1", status: "paused", reason: "disk_low" })).not.toBeNull();
    clock.advance(200);
    expect(log.record("download.progress", { id: "dl_1", status: "running", reason: null, done: 4 })).not.toBeNull();
    expect(log.since(0).events.map((e) => e.data.status)).toEqual(["running", "paused", "running"]);
  });

  it("lets a feed that goes down 200 ms after it came up through", () => {
    const clock = createClock();
    const log = createEventLog({ dir: dir(), retain: 100, now: clock.now, ...manualTimers() });
    log.record("stream.status", { accountId: "a", connected: true, state: "up" });
    clock.advance(200);
    expect(log.record("stream.status", { accountId: "a", connected: false, state: "down" })).not.toBeNull();
    expect(log.since(0).events.map((e) => e.data.state)).toEqual(["up", "down"]);
  });

  it("still holds back repeats of the same state, then sends the newest one when the window ends", () => {
    const clock = createClock();
    const timers = manualTimers();
    const log = createEventLog({ dir: dir(), retain: 100, now: clock.now, ...timers });
    log.record("download.progress", { id: "d1", status: "running", done: 1 });
    clock.advance(100);
    expect(log.record("download.progress", { id: "d1", status: "running", done: 2 })).toBeNull();
    clock.advance(100);
    expect(log.record("download.progress", { id: "d1", status: "running", done: 3 })).toBeNull();
    expect(timers.pending).toHaveLength(1); // one timer per key, not one per event
    clock.advance(900);
    timers.fireAll();
    const events = log.since(0).events;
    expect(events.map((e) => e.data.done)).toEqual([1, 3]); // the newest one, not the first held back
    log.close();
  });

  it("a state change cancels the held-back older event", () => {
    const clock = createClock();
    const timers = manualTimers();
    const log = createEventLog({ dir: dir(), retain: 100, now: clock.now, ...timers });
    log.record("download.progress", { id: "d1", status: "running", done: 1 });
    clock.advance(100);
    log.record("download.progress", { id: "d1", status: "running", done: 2 });
    clock.advance(100);
    log.record("download.progress", { id: "d1", status: "paused", done: 2 });
    clock.advance(1500);
    timers.fireAll();
    expect(log.since(0).events.map((e) => e.data.status)).toEqual(["running", "paused"]);
  });
});

describe("RDATA-14 the polling cursor advances", () => {
  const ctxFor = (qs) => ({ query: new URLSearchParams(qs), key: { scopes: ["read"], accounts: "*" }, requestId: "r" });
  const bodyOf = (r) => JSON.parse(r.body ?? JSON.stringify(r));

  it("a narrow filter does not fall behind the ring and report a false retention gap", () => {
    const log = createEventLog({ dir: dir(), retain: 100 });
    const routes = createEventsRoutes({ eventLog: log, webhooks: {}, registry: {}, cfg: { retain: 100 } });
    log.record("recording.started", { id: "r1" });
    let cursor = bodyOf(routes.listEvents(ctxFor("since=0&topics=collection.*"))).meta.cursor;
    // two polls with 80 other events between them: the ring (100) rolls past the first cursor, not past the second
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 80; i += 1) log.record("download.done", { id: `d${round}-${i}` });
      const r = bodyOf(routes.listEvents(ctxFor(`since=${cursor}&topics=collection.*`)));
      expect(r.meta.gap).toBe(false);
      expect(r.meta.cursor).toBe(r.meta.latest);
      cursor = r.meta.cursor;
    }
  });

  it("a poller whose log was reset gets the new latest as its cursor", () => {
    const d = dir();
    let log = createEventLog({ dir: d, retain: 100 });
    for (let i = 0; i < 50; i += 1) log.record("download.done", { id: `d${i}` });
    unlinkSync(join(d, "log.jsonl"));
    log = createEventLog({ dir: d, retain: 100 });
    const routes = createEventsRoutes({ eventLog: log, webhooks: {}, registry: {}, cfg: { retain: 100 } });
    for (let i = 0; i < 5; i += 1) log.record("download.done", { id: `new${i}` });
    const r = bodyOf(routes.listEvents(ctxFor("since=50")));
    expect(r.meta).toMatchObject({ gap: true, gapReason: "cursor_ahead", cursor: "5", latest: "5" });
    const next = bodyOf(routes.listEvents(ctxFor(`since=${r.meta.cursor}`)));
    expect(next.meta.gap).toBe(false);
  });

  it("still pages: with more events than the limit the cursor is the last one returned", () => {
    const log = createEventLog({ dir: dir(), retain: 100 });
    const routes = createEventsRoutes({ eventLog: log, webhooks: {}, registry: {}, cfg: { retain: 100 } });
    for (let i = 0; i < 5; i += 1) log.record("download.done", { id: `d${i}` });
    const r = bodyOf(routes.listEvents(ctxFor("since=0&limit=2")));
    expect(r.data).toHaveLength(2);
    expect(r.meta).toMatchObject({ cursor: "2", nextCursor: "2", hasMore: true });
  });
});
