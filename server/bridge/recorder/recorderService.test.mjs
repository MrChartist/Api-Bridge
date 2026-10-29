/**
 * Recorder service (docs/spec/p1-01-recorder.md §3.2, §5, §12) over fakes with a manual clock: a whole session
 * 09:15–15:29 and nothing at 15:30; weekend and holiday; stream-down, budget and session-expired gaps; restart with
 * bridge-down gaps and resume ≤ 1 min; ATM re-centring subscribes before it unsubscribes; one data account with two
 * holders; events; the daily job and the day roll; the holiday detector.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { EXPIRY, IST, fakeChain, makeRecorder } from "./testkit.mjs";

const readAll = async (svc, from, to) => svc.store.read({ u: "NIFTY", x: EXPIRY, fromMs: from, toMs: to, limit: 500 });

describe("a REST-recorded session", () => {
  it("writes every minute 09:15–15:29, nothing at 15:30; runs the daily job and rolls the day", async () => {
    const r = makeRecorder({ start: IST("2026-10-19T09:14:30"), recorder: { sources: { stream: false } } });
    await r.svc.start();
    await r.minutes(390); // to 15:44:30
    const day = await readAll(r.svc, IST("2026-10-19T00:00:00"), IST("2026-10-19T23:59:00"));
    expect(day.snaps).toHaveLength(375);
    expect(day.snaps[0].slot).toBe(IST("2026-10-19T09:15:00"));
    expect(day.snaps.at(-1).slot).toBe(IST("2026-10-19T15:29:00"));
    expect(day.gaps).toHaveLength(0);
    expect(day.snaps[0]).toMatchObject({ source: "rest", accountId: "acc-1", broker: "upstox", quality: "live", oiUnitVerified: false, lot: 75 });
    // Every read was pinned to the data account at background priority with the 1.5 s wait cap.
    expect(r.calls.every((c) => c.opts.accountId === "acc-1" && c.opts.priority === "background" && c.opts.maxWaitMs === 1500 && c.opts.backgroundShare === 0.5)).toBe(true);
    const rows = await r.svc.daily({ underlying: "NIFTY", from: "2026-10-19", to: "2026-10-19" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-10-19", u: "NIFTY", x: EXPIRY, slots: 375, gapSlots: 0, dOiBasis: "none" });
    expect(readdirSync(join(r.dataDir, "recorder", "s1", "2026-10-19", "NIFTY"))).toContain(`${EXPIRY}.ndjson.gz`);
    const st = r.svc.status();
    expect(st.state).toBe("idle-closed");
    expect(st.coverage[0]).toMatchObject({ expectedSlots: 375, recordedSlots: 375, gapSlots: 0 });
    await r.svc.stop();
  }, 60_000);

  it("a weekend and a listed holiday write nothing", async () => {
    for (const start of [IST("2026-10-24T10:00:30"), IST("2026-10-20T10:00:30")]) {
      const r = makeRecorder({ start, recorder: { sources: { stream: false } } });
      await r.svc.start();
      await r.minutes(5);
      expect(r.calls).toHaveLength(0);
      expect(existsSync(join(r.dataDir, "recorder", "s1"))).toBe(false);
      expect(r.svc.status().state).toBe("idle-closed");
      await r.svc.stop();
    }
  });

  it("a refused REST read is a budget gap; session expiry gaps then recovery", async () => {
    let mode = "budget";
    const r = makeRecorder({
      start: IST("2026-10-19T10:00:30"),
      recorder: { sources: { stream: false } },
      marketData: {
        async optionChain(_p, opts) {
          if (mode === "budget") throw new BridgeError("UPSTREAM_RATE_LIMITED", "Waited too long.");
          if (mode === "session") throw new BridgeError("SESSION_EXPIRED", "Log in again.");
          return fakeChain({ t: r.clock.now(), accountId: opts.accountId });
        },
      },
    });
    await r.svc.start(); // 10:00 slot at once
    await r.minutes(1); // 10:01
    mode = "session";
    await r.minutes(2); // 10:02, 10:03
    mode = "ok";
    await r.minutes(1); // 10:04
    const page = await readAll(r.svc, IST("2026-10-19T09:00:00"), IST("2026-10-19T11:00:00"));
    expect(page.gaps.map((g) => [g.slot, g.reason])).toEqual([
      [IST("2026-10-19T10:00:00"), "budget"],
      [IST("2026-10-19T10:01:00"), "budget"],
      [IST("2026-10-19T10:02:00"), "session-expired"],
      [IST("2026-10-19T10:03:00"), "session-expired"],
    ]);
    expect(page.snaps.map((s) => s.slot)).toEqual([IST("2026-10-19T10:04:00")]);
    const q = await r.svc.snapshots({ underlying: "NIFTY", expiry: EXPIRY, fromMs: IST("2026-10-19T10:00:00"), toMs: IST("2026-10-19T10:04:30"), fields: ["oi"] });
    expect(q.gaps.map((g) => [g.reason, g.slots])).toEqual([
      ["budget", 2],
      ["session-expired", 2],
    ]);
    expect(q.coverage).toMatchObject({ expectedSlots: 5, recordedSlots: 1, gapSlots: 4 });
    await r.svc.stop();
  });
});

describe("restart", () => {
  it("writes bridge-down gaps for the missed slots and resumes at the next slot (≤ 1 min)", async () => {
    const a = makeRecorder({ start: IST("2026-10-19T10:00:58"), recorder: { sources: { stream: false } } });
    await a.svc.start();
    await a.svc.idle();
    expect((await readAll(a.svc, IST("2026-10-19T09:00:00"), IST("2026-10-19T11:00:00"))).snaps.map((s) => s.slot)).toEqual([IST("2026-10-19T10:00:00")]);
    await a.svc.stop();
    const b = makeRecorder({ start: IST("2026-10-19T10:03:58"), dataDir: a.dataDir, recorder: { sources: { stream: false } } });
    await b.svc.start();
    await b.svc.idle();
    await b.clock.advance(4000); // 10:04:02
    await b.svc.idle();
    const page = await readAll(b.svc, IST("2026-10-19T09:00:00"), IST("2026-10-19T11:00:00"));
    expect(page.gaps.map((g) => [g.slot, g.reason])).toEqual([
      [IST("2026-10-19T10:01:00"), "bridge-down"],
      [IST("2026-10-19T10:02:00"), "bridge-down"],
      [IST("2026-10-19T10:03:00"), "bridge-down"],
    ]);
    expect(page.snaps.map((s) => s.slot)).toEqual([IST("2026-10-19T10:00:00"), IST("2026-10-19T10:04:00")]);
    await b.svc.stop();
  });
});

describe("the stream source", () => {
  const legSym = (k, r) => `NFO:NIFTY-${EXPIRY}-${k}-${r}`;
  const tickChain = (hub, spot, centre) => {
    hub.pushTick({ symbol: "NSE:NIFTY", ltp: spot });
    for (let k = centre - 100; k <= centre + 100; k += 50) {
      hub.pushTick({ symbol: legSym(k, "CE"), ltp: 120, bid: 119.5, ask: 120.5, oi: 75 * 100, volume: 7500 });
      hub.pushTick({ symbol: legSym(k, "PE"), ltp: 110, bid: 109.5, ask: 110.5, oi: 75 * 90, volume: 7500 });
    }
  };

  it("not-subscribed-yet until the first spot tick, snapshots from ticks, stream-down gaps when the feed drops", async () => {
    const r = makeRecorder({ start: IST("2026-10-19T09:59:30"), recorder: { sources: { rest: false } } });
    await r.svc.start();
    await r.minutes(1); // 10:00: spot and futures subscribed, no strikes yet
    tickChain(r.hub, 25010, 25000);
    await r.minutes(1); // 10:01: legs subscribed, no leg ticks yet were stored before subscribe
    tickChain(r.hub, 25010, 25000);
    await r.minutes(1); // 10:02: snapshot
    r.hub.setConnected(false);
    await r.minutes(1); // 10:03: stream-down
    const page = await readAll(r.svc, IST("2026-10-19T09:00:00"), IST("2026-10-19T11:00:00"));
    expect(page.gaps.map((g) => [g.slot, g.reason])).toEqual([
      [IST("2026-10-19T09:59:00"), "not-subscribed-yet"], // the minute of start is recorded at once
      [IST("2026-10-19T10:00:00"), "not-subscribed-yet"],
      [IST("2026-10-19T10:01:00"), "not-subscribed-yet"],
      [IST("2026-10-19T10:03:00"), "stream-down"],
    ]);
    expect(page.snaps).toHaveLength(1);
    expect(page.snaps[0]).toMatchObject({ slot: IST("2026-10-19T10:02:00"), source: "stream", atm: 25000, missingLegs: 0 });
    expect(page.snaps[0].k).toEqual([24900, 24950, 25000, 25050, 25100]);
    expect(page.snaps[0].ce.age.every((a) => a >= 0)).toBe(true);
    expect(r.svc.status().state).toBe("degraded");
    await r.svc.stop();
  });

  it("ATM re-centring subscribes the new strikes before unsubscribing the old ones", async () => {
    const r = makeRecorder({ start: IST("2026-10-19T09:59:30"), recorder: { sources: { rest: false } } });
    await r.svc.start();
    tickChain(r.hub, 25010, 25000);
    await r.minutes(1);
    const before = r.hub.calls.length;
    r.hub.pushTick({ symbol: "NSE:NIFTY", ltp: 25160 }); // 3 strikes up
    await r.minutes(1);
    const after = r.hub.calls.slice(before);
    const sub = after.findIndex((c) => c[0] === "subscribe" && c[2].includes(legSym(25250, "CE")));
    const unsub = after.findIndex((c) => c[0] === "unsubscribe" && c[2].includes(legSym(24900, "CE")));
    expect(sub).toBeGreaterThanOrEqual(0);
    expect(unsub).toBeGreaterThan(sub);
    expect(r.hub.calls.every((c) => c[0] !== "subscribe" || c[1].startsWith("recorder:"))).toBe(true);
    await r.svc.stop();
    expect(r.hub.calls.at(-1)[0]).toBe("dropClient");
  });
});

describe("one data account", () => {
  it("with two holders, only the configured data account is read", async () => {
    const bus = createEventBus();
    const accountsSvc = createFakeAccountManager({
      bus,
      accounts: [
        { id: "fam-1", broker: "upstox", holder: "spouse", pooling: true },
        { id: "acc-1", broker: "upstox", holder: "me", pooling: true },
      ],
      policies: { upstox: { pooling: "allowed" } },
    });
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), bus, accountsSvc, recorder: { account: "acc-1", sources: { stream: false } } });
    await r.svc.start();
    await r.minutes(3);
    expect(r.calls.length).toBeGreaterThan(0);
    expect(new Set(r.calls.map((c) => c.opts.accountId))).toEqual(new Set(["acc-1"]));
    expect(r.svc.status().account).toMatchObject({ id: "acc-1", chosen: "config" });
    await r.svc.stop();
  });

  it("no eligible account: not-configured, nothing read", async () => {
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), accounts: [{ id: "acc-1", broker: "upstox", state: "expired" }] });
    await r.svc.start();
    await r.minutes(2);
    expect(r.calls).toHaveLength(0);
    expect(r.svc.status()).toMatchObject({ state: "not-configured", account: null });
    await r.svc.stop();
  });
});

describe("events and status", () => {
  it("emits recorder.snapshot per written snapshot and recorder.status on state changes", async () => {
    const bus = createEventBus();
    const snaps = [];
    const states = [];
    bus.on("recorder.snapshot", (p) => snaps.push(p));
    bus.on("recorder.status", (p) => states.push(p.state));
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), bus, recorder: { sources: { stream: false } } });
    await r.svc.start();
    await r.minutes(2);
    expect(snaps.length).toBe(3);
    expect(snaps[0]).toMatchObject({ underlying: "NIFTY", expiry: EXPIRY, source: "rest", quality: "live" });
    expect(states).toContain("recording");
    const st = r.svc.status();
    expect(st).toMatchObject({ state: "recording", demo: false, sources: { stream: false, rest: true, nseBackup: false } });
    expect(st.plan.chains).toEqual([{ underlying: "NIFTY", expiry: EXPIRY, kind: "index", everyMinutes: 1, strikesEachSide: 2, source: "rest", legs: 10 }]);
    expect(st.today.snapshots).toBe(3);
    expect(st.disk.bytes).toBeGreaterThan(0);
    expect(st.warnings.join(" ")).toMatch(/not verified/);
    await r.svc.stop();
  });

  it("paused when disabled: no reads, no subscriptions", async () => {
    const r = makeRecorder({ start: IST("2026-10-19T10:00:30"), recorder: { enabled: false } });
    await r.svc.start();
    await r.minutes(2);
    expect(r.calls).toHaveLength(0);
    expect(r.hub.calls.filter((c) => c[0] === "subscribe")).toHaveLength(0);
    expect(r.svc.status().state).toBe("paused");
    await r.svc.stop();
  });
});

describe("holiday detector (§6.13)", () => {
  it("six flat minutes with no volume → holiday-suspected, the day re-marked and recording stopped", async () => {
    const r = makeRecorder({
      start: IST("2026-10-19T09:14:30"),
      recorder: { sources: { stream: false } },
      marketData: {
        async optionChain(_p, opts) {
          return fakeChain({ t: r.clock.now(), spot: 25010, volume: 0, accountId: opts.accountId });
        },
      },
    });
    await r.svc.start();
    await r.minutes(8);
    expect(r.svc.status().state).toBe("holiday-suspected");
    const all = await r.svc.store.read({ u: "NIFTY", x: EXPIRY, fromMs: IST("2026-10-19T09:00:00"), toMs: IST("2026-10-19T10:00:00"), includeSuspect: true });
    expect(all.snaps).toHaveLength(6);
    expect(all.snaps.every((s) => s.quality === "suspect-holiday")).toBe(true);
    expect((await readAll(r.svc, IST("2026-10-19T09:00:00"), IST("2026-10-19T10:00:00"))).snaps).toHaveLength(0);
    r.svc.clearHoliday();
    await r.minutes(1);
    expect(r.svc.status().state).toBe("recording");
    await r.svc.stop();
  });
});
