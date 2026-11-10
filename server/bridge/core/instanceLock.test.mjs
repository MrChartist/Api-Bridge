/**
 * OPS-01: one Bridge per data folder. Fake process table and clock; a real second createApp on the same folder.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createNullLogger } from "./logger.mjs";
import { LOCK_FILE, acquireInstanceLock, inspectLock, lockMessage, pidAlive, processStartTime, sweepStaleTemps } from "./instanceLock.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mcb-lock-"));
  dirs.push(d);
  return d;
};
const handles = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.release();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A process table: which pids are alive and when each started. */
const table = (procs) => ({
  isAlive: (pid) => procs.has(pid),
  startTimeOf: (pid) => procs.get(pid) ?? null,
});
const noTimers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
const take = (dataDir, o = {}) => {
  const h = acquireInstanceLock({ dataDir, ...noTimers, ...o });
  handles.push(h);
  return h;
};

describe("taking the lock", () => {
  it("creates bridge.lock with the pid, port and start time, and removes it on release", () => {
    const d = tmp();
    const clock = Date.parse("2026-11-10T09:12:00Z");
    const h = take(d, { pid: 4312, port: 4300, version: "2.0.0", now: () => clock, ...table(new Map([[4312, 777]])) });
    const info = JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8"));
    expect(info).toMatchObject({ pid: 4312, port: 4300, version: "2.0.0", startedAt: "2026-11-10T09:12:00.000Z", procStart: 777 });
    h.setPort(4301);
    expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8")).port).toBe(4301);
    h.release();
    expect(existsSync(join(d, LOCK_FILE))).toBe(false);
  });

  it("refuses a second Bridge while the first is alive, naming its process and port", () => {
    const d = tmp();
    const procs = new Map([[4312, 777]]);
    take(d, { pid: 4312, port: 4300, ...table(procs) });
    let err;
    try {
      take(d, { pid: 5000, port: 4301, ...table(new Map([[4312, 777], [5000, 900]])) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.detail).toMatch(/Another Bridge \(process 4312, port 4300/);
    expect(err.detail).toMatch(/using this data folder/);
    expect(err.detail).toContain(d);
    expect(err.fields.owner).toMatchObject({ pid: 4312, port: 4300 });
  });

  it("takes over a lock whose process is gone (a crash), and says so", () => {
    const d = tmp();
    take(d, { pid: 4312, port: 4300, ...table(new Map([[4312, 777]])) });
    const warnings = [];
    const h = take(d, { pid: 5000, port: 4301, logger: { warn: (m) => warnings.push(m) }, ...table(new Map([[5000, 900]])) });
    expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8")).pid).toBe(5000);
    expect(warnings[0]).toMatch(/stale.*process 4312 is not running/);
    h.release();
  });

  it("takes over when the process id was reused by another program (different start time)", () => {
    const d = tmp();
    take(d, { pid: 4312, port: 4300, ...table(new Map([[4312, 777]])) });
    // pid 4312 exists again, but it started later: a different program
    const h = take(d, { pid: 5000, ...table(new Map([[4312, 99999], [5000, 900]])) });
    expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8")).pid).toBe(5000);
    h.release();
  });

  it("a laptop that slept keeps its lock: same process, same start time, old heartbeat", () => {
    const d = tmp();
    let now = Date.parse("2026-11-10T09:00:00Z");
    take(d, { pid: 4312, now: () => now, ...table(new Map([[4312, 777]])) });
    now += 3 * 3600_000; // three hours later, nobody touched the file
    const state = inspectLock(d, { now: () => now, ...table(new Map([[4312, 777]])) });
    expect(state).toMatchObject({ held: true, stale: false });
  });

  it("where the system cannot give a start time, an untouched lock goes stale after the limit, a touched one does not", () => {
    const d = tmp();
    const t0 = Date.parse("2026-11-10T09:00:00Z");
    let clockNow = t0;
    const h = take(d, { pid: 4312, now: () => clockNow, isAlive: () => true, startTimeOf: () => null });
    const file = join(d, LOCK_FILE);
    utimesSync(file, new Date(t0), new Date(t0));
    expect(inspectLock(d, { now: () => t0 + 60_000, isAlive: () => true, startTimeOf: () => null })).toMatchObject({ held: true });
    expect(inspectLock(d, { now: () => t0 + 5 * 60_000, isAlive: () => true, startTimeOf: () => null })).toMatchObject({ held: false, stale: true });
    clockNow = t0 + 5 * 60_000;
    h.touch(); // the heartbeat
    expect(inspectLock(d, { now: () => clockNow + 1000, isAlive: () => true, startTimeOf: () => null })).toMatchObject({ held: true });
  });

  it("an unreadable lock is waited for, then treated as left behind once it is old", () => {
    const d = tmp();
    const file = join(d, LOCK_FILE);
    writeFileSync(file, "");
    const fresh = Date.now();
    utimesSync(file, new Date(fresh), new Date(fresh)); // the file's own clock is the real one; the test's may be moved
    expect(inspectLock(d, { now: () => fresh })).toMatchObject({ held: true });
    expect(inspectLock(d, { now: () => fresh + 10 * 60_000 })).toMatchObject({ held: false, stale: true });
  });

  it("release leaves another Bridge's lock alone", () => {
    const d = tmp();
    const a = take(d, { pid: 1, ...table(new Map([[1, 1]])) });
    rmSync(join(d, LOCK_FILE));
    const b = take(d, { pid: 2, ...table(new Map([[2, 2]])) });
    a.release();
    expect(JSON.parse(readFileSync(join(d, LOCK_FILE), "utf8")).pid).toBe(2);
    b.release();
  });

  it("the heartbeat puts a removed lock back, so a second Bridge is still refused", () => {
    const d = tmp();
    const h = take(d, { pid: 1, ...table(new Map([[1, 1]])) });
    rmSync(join(d, LOCK_FILE));
    h.touch();
    expect(existsSync(join(d, LOCK_FILE))).toBe(true);
  });

  it("the message works for Windows style folders", () => {
    const msg = lockMessage("C:\\Users\\Asha\\AppData\\Roaming\\MrChartist\\Bridge", { pid: 12, port: 4300, startedAt: "2026-11-10T09:12:00.000Z" });
    expect(msg).toContain("C:\\Users\\Asha\\AppData\\Roaming\\MrChartist\\Bridge");
    expect(msg).toMatch(/process 12, port 4300, started 2026-11-10 09:12/);
  });

  it("the real process table sees this process, and not a made-up id", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0x7ffffff0)).toBe(false);
    if (process.platform === "linux") expect(processStartTime(process.pid)).toBeGreaterThan(0);
  });
});

describe("two Bridges on one folder", () => {
  it("the second app refuses to listen, and the first keeps serving", async () => {
    const dataDir = tmp();
    const mk = () => loadConfig({ raw: { dataDir, server: { port: 0 }, demo: true }, env: {} }).config;
    const a = await createApp({ config: mk(), logger: createNullLogger() });
    await a.listen();
    try {
      const b = await createApp({ config: mk(), logger: createNullLogger() });
      await expect(b.listen()).rejects.toThrow(/Another Bridge \(process \d+/);
      await b.close();
      // b's close must not have removed a's lock
      expect(existsSync(join(dataDir, LOCK_FILE))).toBe(true);
    } finally {
      await a.close();
    }
    expect(existsSync(join(dataDir, LOCK_FILE))).toBe(false);
    // after a clean stop a new Bridge starts
    const c = await createApp({ config: mk(), logger: createNullLogger() });
    await c.listen();
    await c.close();
  });
});

describe("left-over temp files", () => {
  it("removes old *.tmp files and keeps recent ones", () => {
    const d = tmp();
    const old = join(d, ".state.json.1.abc.tmp");
    const fresh = join(d, ".other.json.2.def.tmp");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const t = new Date(Date.now() - 3 * 3600_000);
    utimesSync(old, t, t);
    utimesSync(fresh, new Date(Date.now()), new Date(Date.now())); // the file clock is the real one; Date.now() may be moved
    expect(sweepStaleTemps(d)).toEqual([old]);
    expect(existsSync(fresh)).toBe(true);
  });
});
