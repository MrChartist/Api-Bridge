/**
 * OPS-06: downloads and recordings are not part of a normal backup. What is left out is said, with sizes; the file-count limit
 * is a clear refusal for the bulk tier only (no crash, and keys, paper books and the audit log are still backed up); the copy
 * before an upgrade stays small whatever the recordings weigh; `--include-data` streams the bulk folders in; a restore of
 * such a backup keeps the folders it replaces.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../core/cli.mjs";
import { inspectArchive, writeBackup } from "./archive.mjs";
import { BACKUP_CONFIG_SCHEMA } from "./config.mjs";
import { createBackupManager } from "./manager.mjs";
import { describeBulk, measureBulk } from "./paths.mjs";
import { restoreBackup } from "./restore.mjs";
import { makeDataDir, snapshotOf, tmp } from "./testkit.mjs";

const put = (dir, rel, content) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, rel), content);
};
/** A sparse file of `mb` megabytes: takes no disk, and reads back as zeros. */
const sparse = (dir, rel, mb) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, rel), "w");
  closeSync(fd);
  truncateSync(join(dir, rel), mb * 1024 * 1024);
};
const withBulk = () => {
  const root = tmp();
  const dataDir = makeDataDir(root);
  put(dataDir, "downloads/jobs/dl_aaaaaaaaaaaa/job.json", '{"id":"dl_aaaaaaaaaaaa"}');
  put(dataDir, "downloads/jobs/dl_aaaaaaaaaaaa/NSE_RELIANCE_1d.csv", "time,open\r\n1,2\r\n");
  put(dataDir, "downloads/datasets/nifty-5m/dataset.json", "{}");
  put(dataDir, "recordings/rec_abcd1234/recording.json", '{"id":"rec_abcd1234"}');
  put(dataDir, "recordings/rec_abcd1234/2026-11-09__NSE_NIFTY.csv", "time,symbol,ltp\n09:15:00,NSE:NIFTY,24000\n");
  return { root, dataDir };
};
const names = (m) => m.files.map((f) => f.path);

describe("what a normal backup holds", () => {
  it("leaves downloads and recordings out and lists them (with the reason) in the manifest", async () => {
    const { root, dataDir } = withBulk();
    const res = await writeBackup({ dataDir, out: join(root, "a.tar.gz"), bridgeVersion: "2.0.0" });
    expect(names(res.manifest).some((n) => /^data\/(downloads|recordings)\//.test(n))).toBe(false);
    expect(names(res.manifest)).toContain("data/keys.json");
    expect(names(res.manifest)).toContain("data/audit/head.json");
    expect(res.includesData).toBe(false);
    const left = res.excluded.filter((e) => e.bulk);
    expect(left.map((e) => e.path).sort()).toEqual(["downloads", "recordings"]);
    expect(left[0].reason).toMatch(/--include-data/);
  });

  it("measures what was left out, in the words a person reads", () => {
    const { dataDir } = withBulk();
    const rows = measureBulk(dataDir);
    expect(rows.map((r) => [r.name, r.files, r.items])).toEqual([["downloads", 3, 1], ["recordings", 2, 1]]);
    expect(describeBulk(rows)).toBe("downloads: 1 KB, 1 job; recordings: 1 KB, 1 recording");
    expect(measureBulk(join(tmp(), "none"))).toEqual([]);
  });
});

describe("the file-count limit (it used to crash the backup)", () => {
  it("50,100 recording files do not stop a normal backup: keys, paper books and the audit log are still saved", async () => {
    const root = tmp();
    const dataDir = makeDataDir(root);
    const dir = join(dataDir, "recordings", "rec_abcd1234");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 50_100; i++) writeFileSync(join(dir, `f${i}.csv`), "x");
    const res = await writeBackup({ dataDir, out: join(root, "big.tar.gz"), bridgeVersion: "2.0.0" });
    expect(names(res.manifest)).toContain("data/keys.json");
    expect(names(res.manifest)).toContain("data/paper/book-paper-main.json");
    expect(res.manifest.files.length).toBeLessThan(50);
  }, 60_000);

  it("with --include-data, too many bulk files is a plain refusal (a BridgeError, not a stack trace) that names the setting", async () => {
    const root = tmp();
    const dataDir = makeDataDir(root);
    const dir = join(dataDir, "recordings", "rec_abcd1234");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1200; i++) writeFileSync(join(dir, `f${i}.csv`), "x");
    const err = await writeBackup({ dataDir, out: join(root, "no.tar.gz"), bridgeVersion: "2.0.0", includeData: true, maxDataFiles: 1000 }).catch((e) => e);
    expect(err).toMatchObject({ name: "BridgeError", code: "VALIDATION_FAILED" });
    expect(err.detail).toMatch(/more than 1000 files/);
    expect(err.detail).toMatch(/backup\.maxDataFiles/);
    expect(existsSync(join(root, "no.tar.gz"))).toBe(false);
    expect(readdirSync(root).filter((n) => n.includes(".partial"))).toEqual([]);
  });

  it("the command line prints that refusal as one line and exits 1", async () => {
    const root = tmp();
    const dataDir = makeDataDir(root);
    const dir = join(dataDir, "recordings", "rec_abcd1234");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1200; i++) writeFileSync(join(dir, `f${i}.csv`), "x");
    writeFileSync(join(root, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, backup: { maxDataFiles: 1000 } }));
    const err = [];
    const io = { out() {}, err: (s) => err.push(s), env: { MCB_HOME: join(root, "h") }, cwd: root };
    expect(await runCli(["backup"], { out: join(root, "x.tar.gz"), "include-data": true }, io)).toBe(1);
    expect(err.join("\n")).toMatch(/^Error: The downloads and recordings hold more than 1000 files/);
  });
});

describe("the copy before an upgrade stays small and fast", () => {
  it("is still made when recordings are far above backup.maxSizeMb (it used to be skipped), and holds no bulk data", async () => {
    const { dataDir } = withBulk();
    sparse(dataDir, "recordings/rec_abcd1234/2026-11-10__NSE_BANKNIFTY.csv", 300); // 300 MB, limit is 10 MB
    const mgr = createBackupManager({ dataDir, config: { backup: BACKUP_CONFIG_SCHEMA.parse({ maxSizeMb: 10 }) }, bridgeVersion: "2.1.0" });
    // the folder remembers an older version, so a snapshot is due
    writeFileSync(join(dataDir, "last-version.json"), JSON.stringify({ version: "2.0.0" }));
    const t0 = Date.now();
    const r = await mgr.snapshotBeforeStart();
    expect(r.took).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(statSync(r.path).size).toBeLessThan(200_000);
    const { manifest } = await inspectArchive(r.path);
    expect(manifest.includesData).toBe(false);
    expect(names(manifest).some((n) => n.startsWith("data/recordings/"))).toBe(false);
  });

  it("a restore can make its safety copy the same way, so `restore` no longer refuses over big recordings", async () => {
    const { root, dataDir } = withBulk();
    const archive = join(root, "state.tar.gz");
    await writeBackup({ dataDir, out: archive, bridgeVersion: "2.0.0" });
    sparse(dataDir, "recordings/rec_abcd1234/2026-11-10__NSE_BANKNIFTY.csv", 300);
    const r = await restoreBackup({ archive, dataDir, bridgeVersion: "2.0.0", config: { backup: BACKUP_CONFIG_SCHEMA.parse({ maxSizeMb: 10 }) } });
    expect(r.restored).toBe(true);
    expect(r.safetyBackup).toBeTruthy();
    // the recordings on this computer were not part of the backup, so they are untouched
    expect(statSync(join(dataDir, "recordings/rec_abcd1234/2026-11-10__NSE_BANKNIFTY.csv")).size).toBe(300 * 1024 * 1024);
  });
});

describe("--include-data", () => {
  it("puts downloads and recordings in, streamed, with matching checksums, and manual copies are kept per backup.manualKeep", async () => {
    const { root, dataDir } = withBulk();
    sparse(dataDir, "downloads/jobs/dl_aaaaaaaaaaaa/big.csv", 24); // streamed, never read whole
    const res = await writeBackup({ dataDir, out: join(root, "full.tar.gz"), bridgeVersion: "2.0.0", includeData: true });
    expect(res.includesData).toBe(true);
    expect(names(res.manifest)).toEqual(expect.arrayContaining(["data/downloads/jobs/dl_aaaaaaaaaaaa/big.csv", "data/recordings/rec_abcd1234/2026-11-09__NSE_NIFTY.csv", "data/keys.json"]));
    expect(res.manifest.files.find((f) => f.path.endsWith("big.csv")).size).toBe(24 * 1024 * 1024);
    const { entries } = await inspectArchive(res.path); // every checksum read back
    expect(entries.length).toBe(res.manifest.files.length);

    const mgr = createBackupManager({ dataDir, config: { backup: BACKUP_CONFIG_SCHEMA.parse({ manualKeep: 2 }) }, bridgeVersion: "2.0.0" });
    for (let i = 0; i < 4; i++) await mgr.run({ kind: "manual", quiet: true });
    expect(mgr.list().filter((f) => f.kind === "manual")).toHaveLength(2);
  });

  it("a file that grows while it is copied is cut at the size seen, so the copy is a whole earlier version", async () => {
    const { root, dataDir } = withBulk();
    const file = join(dataDir, "recordings/rec_abcd1234/2026-11-09__NSE_NIFTY.csv");
    const before = readFileSync(file);
    const p = writeBackup({ dataDir, out: join(root, "g.tar.gz"), bridgeVersion: "2.0.0", includeData: true });
    const fd = openSync(file, "a");
    writeSync(fd, "09:15:01,NSE:NIFTY,24001\n");
    closeSync(fd);
    const res = await p;
    const entry = res.manifest.files.find((f) => f.path.endsWith("NSE_NIFTY.csv"));
    expect(entry.size === before.length || entry.size === before.length + 25).toBe(true);
    await inspectArchive(res.path);
  });

  it("a restore of such a backup puts the bulk folders back and keeps the ones it replaced", async () => {
    const { root, dataDir } = withBulk();
    const archive = join(root, "full.tar.gz");
    await writeBackup({ dataDir, out: archive, bridgeVersion: "2.0.0", includeData: true });
    put(dataDir, "recordings/rec_abcd1234/2026-11-09__NSE_NIFTY.csv", "NEWER DATA\n");
    put(dataDir, "downloads/jobs/dl_bbbbbbbbbbbb/job.json", '{"id":"dl_bbbbbbbbbbbb"}');
    const r = await restoreBackup({ archive, dataDir, bridgeVersion: "2.0.0" });
    expect(readFileSync(join(dataDir, "recordings/rec_abcd1234/2026-11-09__NSE_NIFTY.csv"), "utf8")).toContain("24000");
    expect(existsSync(join(dataDir, "downloads/jobs/dl_bbbbbbbbbbbb"))).toBe(false);
    expect(r.keptBulk).toHaveLength(2);
    const kept = readdirSync(dataDir).filter((n) => n.includes(".before-restore-"));
    expect(kept.sort()).toEqual(r.keptBulk.sort());
    // nothing of the newer data was lost
    const recKept = kept.find((n) => n.startsWith("recordings"));
    expect(readFileSync(join(dataDir, recKept, "rec_abcd1234/2026-11-09__NSE_NIFTY.csv"), "utf8")).toBe("NEWER DATA\n");
    expect(existsSync(join(dataDir, kept.find((n) => n.startsWith("downloads")), "jobs/dl_bbbbbbbbbbbb/job.json"))).toBe(true);
    expect(readdirSync(dataDir).filter((n) => n.startsWith(".pre-restore-") || n.startsWith(".restore-staging-"))).toEqual([]);
  });
});

describe("the command line says what is left out", () => {
  const setup = () => {
    const { root, dataDir } = withBulk();
    writeFileSync(join(root, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" } }));
    const out = [];
    const io = { out: (s) => out.push(s), err() {}, env: { MCB_HOME: join(root, "h") }, cwd: root };
    return { root, dataDir, out, io, text: () => out.join("\n") };
  };

  it("backup names the folders left out, with their sizes, and the flag that adds them", async () => {
    const t = setup();
    expect(await runCli(["backup"], { out: join(t.root, "n.tar.gz") }, t.io)).toBe(0);
    expect(t.text()).toMatch(/NOT included: downloads: 1 KB, 1 job; recordings: 1 KB, 1 recording\..*--include-data/);
  });

  it("backup --include-data says they are in", async () => {
    const t = setup();
    expect(await runCli(["backup"], { out: join(t.root, "d.tar.gz"), "include-data": true }, t.io)).toBe(0);
    expect(t.text()).toMatch(/and the downloads and recordings folders/);
    expect(t.text()).not.toMatch(/NOT included: downloads/);
  });

  it("restore of a state-only backup says the downloads and recordings here are left as they are", async () => {
    const t = setup();
    const file = join(t.root, "s.tar.gz");
    await runCli(["backup"], { out: file }, t.io);
    t.out.length = 0;
    expect(await runCli(["restore", file], { "dry-run": true }, t.io)).toBe(0);
    expect(t.text()).toMatch(/downloads and recordings: not part of this backup, so the ones on this computer are left as they are \(downloads: 1 KB, 1 job; recordings: 1 KB, 1 recording\)/);
    // and the data folder is unchanged
    expect(Object.keys(snapshotOf(t.dataDir)).some((k) => k.startsWith("downloads/"))).toBe(true);
  });
});
