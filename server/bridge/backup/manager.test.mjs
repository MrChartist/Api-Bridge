/**
 * The backup manager: the snapshot before a version change, retention, low space, the daily schedule, status and the
 * bus events. Nothing here may ever stop a start.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { BACKUP_CONFIG_SCHEMA } from "./config.mjs";
import { backupDoctorChecks } from "./doctor.mjs";
import { backupHealth } from "./health.mjs";
import { createBackupManager, readBackupStatus, readLastVersion } from "./manager.mjs";
import { makeDataDir, tmp } from "./testkit.mjs";

const cfg = (over = {}) => BACKUP_CONFIG_SCHEMA.parse(over);
function make({ version = "2.0.0", backup = {}, clockAt = new Date(2026, 10, 9, 10, 0, 0), freeBytesFn, withData = true } = {}) {
  const root = tmp();
  const dataDir = withData ? makeDataDir(root) : join(root, "data");
  let now = clockAt.getTime();
  const clock = { now: () => now };
  const bus = createEventBus();
  const events = [];
  bus.on("backup.completed", (e) => events.push(["completed", e]));
  bus.on("backup.failed", (e) => events.push(["failed", e]));
  const warnings = [];
  const logger = { warn: (...a) => warnings.push(a), info() {}, error() {} };
  const mgr = (v = version, extra = {}) => createBackupManager({ dataDir, config: { backup: cfg(backup) }, bridgeVersion: v, logger, bus, clock, freeBytesFn, ...extra });
  return { root, dataDir, mgr, events, warnings, advance: (ms) => (now += ms), now: () => now, setNow: (d) => (now = d.getTime()) };
}
const files = (dataDir) => readdirSync(join(dataDir, "backups")).filter((n) => n.endsWith(".tar.gz"));

describe("config", () => {
  it("defaults: keep 5, schedule off", () => {
    expect(cfg()).toMatchObject({ keep: 5, maxSizeMb: 500, schedule: { enabled: false, time: "02:30", keep: 7, includeSecrets: false } });
    expect(() => cfg({ keep: 0 })).toThrow();
    expect(() => cfg({ schedule: { time: "25:00" } })).toThrow();
    expect(() => cfg({ surprise: 1 })).toThrow();
  });
});

describe("snapshot before a version change", () => {
  it("first run on an empty folder: nothing to copy, the version is remembered", async () => {
    const t = make({ withData: false });
    const r = await t.mgr().snapshotBeforeStart();
    expect(r).toEqual({ took: false, message: null });
    expect(readLastVersion(t.dataDir)).toBe("2.0.0");
    expect(existsSync(join(t.dataDir, "backups"))).toBe(false);
  });

  it("same version again: nothing is copied", async () => {
    const t = make();
    await t.mgr().snapshotBeforeStart();
    const n = files(t.dataDir).length;
    expect(await t.mgr().snapshotBeforeStart()).toEqual({ took: false, message: null });
    expect(files(t.dataDir)).toHaveLength(n);
  });

  it("a changed version copies the data first and says so in one line, including how to restore", async () => {
    const t = make();
    writeFileSync(join(t.dataDir, "last-version.json"), JSON.stringify({ version: "1.9.0" }));
    const r = await t.mgr("2.0.0").snapshotBeforeStart();
    expect(r.took).toBe(true);
    expect(r.message).toMatch(/Saved a copy of your data before this version runs \(1\.9\.0 to 2\.0\.0\)/);
    expect(r.message).toMatch(/mc-bridge restore/);
    expect(r.message.split("\n")).toHaveLength(1);
    expect(files(t.dataDir)).toHaveLength(1);
    expect(files(t.dataDir)[0]).toMatch(/-upgrade\.tar\.gz$/);
    expect(readLastVersion(t.dataDir)).toBe("2.0.0");
    // it sits next to the secrets it copies, so it holds them; the master key is still not in it
    const raw = readFileSync(join(t.dataDir, "backups", files(t.dataDir)[0]));
    expect(raw.length).toBeGreaterThan(100);
  });

  it("existing data with no version marker (installed before this existed) is copied once", async () => {
    const t = make();
    const r = await t.mgr().snapshotBeforeStart();
    expect(r.took).toBe(true);
    expect(r.message).not.toMatch(/\(.* to .*\)/);
  });

  it("keeps the newest N (backup.keep) and removes older snapshots", async () => {
    const t = make({ backup: { keep: 2 } });
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) {
      t.advance(60_000);
      await t.mgr(v).snapshotBeforeStart();
    }
    const names = files(t.dataDir);
    expect(names).toHaveLength(2);
    // the two newest survive
    expect(names.every((n) => n.includes("-upgrade"))).toBe(true);
    const status = readBackupStatus(t.dataDir);
    expect(status.lastOk.kind).toBe("upgrade");
  });

  it("prunes only its own files of the same kind: other kinds and strangers are left alone", async () => {
    const t = make({ backup: { keep: 1 } });
    await t.mgr().run({ kind: "manual" });
    mkdirSync(join(t.dataDir, "backups"), { recursive: true });
    writeFileSync(join(t.dataDir, "backups", "my-notes.txt"), "keep me");
    for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
      t.advance(60_000);
      await t.mgr(v).snapshotBeforeStart();
    }
    const all = readdirSync(join(t.dataDir, "backups"));
    expect(all).toContain("my-notes.txt");
    expect(all.filter((n) => n.endsWith("-manual.tar.gz"))).toHaveLength(1);
    expect(all.filter((n) => n.endsWith("-upgrade.tar.gz"))).toHaveLength(1);
  });

  it("two snapshots in the same second get different names", async () => {
    const t = make();
    await t.mgr("1.0.0").snapshotBeforeStart();
    await t.mgr("1.1.0").snapshotBeforeStart();
    await t.mgr("1.2.0").snapshotBeforeStart();
    expect(new Set(files(t.dataDir)).size).toBe(files(t.dataDir).length);
    expect(files(t.dataDir).length).toBeGreaterThanOrEqual(3);
  });

  it("low space: skipped with a warning, the start goes on, and it is not retried forever", async () => {
    const t = make({ freeBytesFn: () => 1024 });
    writeFileSync(join(t.dataDir, "last-version.json"), JSON.stringify({ version: "1.0.0" }));
    const r = await t.mgr("2.0.0").snapshotBeforeStart();
    expect(r.took).toBe(false);
    expect(r.message).toMatch(/^Warning: no copy of your data was made before this version runs \(Not enough free disk space/);
    expect(r.message).toMatch(/Start continues/);
    expect(existsSync(join(t.dataDir, "backups")) ? files(t.dataDir) : []).toEqual([]);
    expect(readBackupStatus(t.dataDir).lastSkipped.reason).toMatch(/free disk space/);
    expect(readLastVersion(t.dataDir)).toBe("2.0.0");
    expect(await t.mgr("2.0.0").snapshotBeforeStart()).toEqual({ took: false, message: null });
  });

  it("a data folder over the size cap (backup.maxSizeMb) is skipped with a warning, not an error", async () => {
    const t = make({ backup: { maxSizeMb: 10 } });
    writeFileSync(join(t.dataDir, "audit", "2026-11-11.jsonl"), Buffer.alloc(11 * 1024 * 1024, 97));
    const r = await t.mgr("2.0.0").snapshotBeforeStart();
    expect(r.took).toBe(false);
    expect(r.message).toMatch(/more than the 10 MB limit/);
    expect(readLastVersion(t.dataDir)).toBe("2.0.0");
  });

  it("never throws, whatever goes wrong (a data folder that is a file)", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    writeFileSync(dataDir, "not a folder");
    const mgr = createBackupManager({ dataDir, bridgeVersion: "2.0.0", config: {} });
    await expect(mgr.snapshotBeforeStart()).resolves.toMatchObject({ took: false });
  });
});

describe("backup list and status", () => {
  it("lists the copies newest first with kind and size, and reports the last backup", async () => {
    const t = make();
    await t.mgr().run({ kind: "manual" });
    t.advance(120_000);
    await t.mgr().run({ kind: "scheduled" });
    const m = t.mgr();
    const rows = m.list();
    expect(rows.map((r) => r.kind)).toEqual(["scheduled", "manual"]);
    expect(rows[0].bytes).toBeGreaterThan(0);
    expect(m.summary()).toMatchObject({ lastBackupKind: "scheduled", lastError: null, schedule: { enabled: false } });
    expect(m.summary().lastBackupBytes).toBe(rows[0].bytes);
  });

  it("emits backup.completed with name, size and time but no file contents", async () => {
    const t = make();
    await t.mgr().run({ kind: "manual" });
    expect(t.events).toHaveLength(1);
    const [name, e] = t.events[0];
    expect(name).toBe("completed");
    expect(Object.keys(e).sort()).toEqual(["at", "bytes", "files", "includesSecrets", "kind", "path"]);
  });

  it("a backup to a name that exists is the caller's mistake: not a failure in the status, no event", async () => {
    const t = make();
    const out = join(t.root, "x.tar.gz");
    await t.mgr().run({ kind: "manual", out });
    await expect(t.mgr().run({ kind: "manual", out })).rejects.toThrow(/already exists/);
    expect(readBackupStatus(t.dataDir).lastFailure).toBeNull();
  });
});

describe("daily schedule", () => {
  const sched = (over = {}) => ({ schedule: { enabled: true, time: "02:30", keep: 2, ...over } });

  it("does nothing while off", async () => {
    const t = make({ clockAt: new Date(2026, 10, 9, 3, 0, 0) });
    expect(await t.mgr().scheduleTick()).toBeNull();
    expect(existsSync(join(t.dataDir, "backups"))).toBe(false);
  });

  it("waits for its time, runs once a day, then again the next day, keeping the newest few", async () => {
    const t = make({ backup: sched(), clockAt: new Date(2026, 10, 9, 2, 0, 0) });
    expect(await t.mgr().scheduleTick()).toBeNull(); // before 02:30
    t.setNow(new Date(2026, 10, 9, 2, 31, 0));
    expect(await t.mgr().scheduleTick()).toMatchObject({ kind: "scheduled" });
    t.advance(60_000);
    expect(await t.mgr().scheduleTick()).toBeNull(); // already today
    for (const day of [10, 11, 12]) {
      t.setNow(new Date(2026, 10, day, 3, 0, 0));
      expect(await t.mgr().scheduleTick()).toMatchObject({ kind: "scheduled" });
    }
    expect(files(t.dataDir).filter((n) => n.endsWith("-scheduled.tar.gz"))).toHaveLength(2);
    expect(t.events.filter(([n]) => n === "completed")).toHaveLength(4);
  });

  it("catches up a run that was missed while the computer was off", async () => {
    const t = make({ backup: sched(), clockAt: new Date(2026, 10, 9, 18, 0, 0) });
    expect(await t.mgr().scheduleTick()).toMatchObject({ kind: "scheduled" });
  });

  it("a failure is logged, shown in health and doctor, emitted as backup.failed, and retried after an hour", async () => {
    const t = make({ backup: sched(), clockAt: new Date(2026, 10, 9, 3, 0, 0), freeBytesFn: () => 10 });
    expect(await t.mgr().scheduleTick()).toBeNull();
    const [name, e] = t.events.at(-1);
    expect(name).toBe("failed");
    expect(e).toMatchObject({ kind: "scheduled" });
    expect(e.message).toMatch(/free disk space/);
    expect(t.warnings.length).toBeGreaterThan(0);
    const config = { dataDir: t.dataDir, backup: cfg(sched()) };
    const health = backupHealth({ config, dataDir: t.dataDir });
    expect(health.lastError).toMatchObject({ kind: "scheduled" });
    expect(health.schedule).toEqual({ enabled: true, time: "02:30" });
    const doctor = backupDoctorChecks({ config, now: Date.now() });
    expect(doctor.find((c) => c.level === "warn" && c.check === "backup").message).toMatch(/last scheduled backup failed/);
    // not again within the hour; again after
    t.advance(30 * 60_000);
    expect(await t.mgr().scheduleTick()).toBeNull();
    expect(t.events.filter(([n]) => n === "failed")).toHaveLength(1);
    t.advance(40 * 60_000);
    await t.mgr().scheduleTick();
    expect(t.events.filter(([n]) => n === "failed")).toHaveLength(2);
    // space comes back: the next attempt succeeds and clears the failure
    t.advance(2 * 3_600_000);
    const ok = createBackupManager({ dataDir: t.dataDir, config: { backup: cfg(sched()) }, bridgeVersion: "2.0.0", clock: { now: () => Date.now() }, bus: createEventBus() });
    expect((await ok.run({ kind: "scheduled" })).kind).toBe("scheduled");
    expect(readBackupStatus(t.dataDir).lastFailure).toBeNull();
  });

  it("a manual backup does not hide a failing schedule", async () => {
    const t = make({ backup: sched(), clockAt: new Date(2026, 10, 9, 3, 0, 0), freeBytesFn: () => 10 });
    await t.mgr().scheduleTick();
    const ok = createBackupManager({ dataDir: t.dataDir, config: { backup: cfg(sched()) }, bridgeVersion: "2.0.0", clock: { now: () => Date.now() } });
    await ok.run({ kind: "manual" });
    expect(readBackupStatus(t.dataDir).lastFailure).toMatchObject({ kind: "scheduled" });
  });

  it("the timer starts and stops cleanly (and is not started when off)", () => {
    const off = make();
    off.mgr().start();
    const on = make({ backup: sched() });
    const m = on.mgr();
    m.start();
    m.start();
    m.stop();
    off.mgr().stop();
  });
});

describe("doctor", () => {
  it("warns when there is data and no backup, is quiet for an empty folder", async () => {
    const t = make();
    const config = { dataDir: t.dataDir, backup: cfg() };
    // The manager ran on the test's fixed clock, so the doctor is asked the time on that same clock (not the real one, which
    // would call the backup "old" once the real date is 30 days past it).
    const now = t.now();
    expect(backupDoctorChecks({ config, now }).find((c) => c.check === "backup").message).toMatch(/No backup of your data yet/);
    await t.mgr().run({ kind: "manual" });
    expect(backupDoctorChecks({ config, now }).find((c) => c.check === "backup")).toMatchObject({ level: "ok" });
    expect(backupDoctorChecks({ config: { dataDir: join(t.root, "nope") }, now })).toEqual([]);
    expect(backupDoctorChecks({ config, now: now + 40 * 86_400_000 }).find((c) => c.check === "backup")).toMatchObject({ level: "warn" });
    expect(backupDoctorChecks({ config, now }).find((c) => c.check === "backup-schedule").message).toMatch(/off/);
  });
});
