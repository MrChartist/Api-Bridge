/**
 * Backup archive and restore: round trip, what is and is not included, tamper and damage detection, hostile archives,
 * dry run, version compatibility and the safety copy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { backupFileName, checkCompatibility, extractArchive, inspectArchive, parseBackupName, writeBackup } from "./archive.mjs";
import { checkEntryName, classify, collectDataFiles } from "./paths.mjs";
import { planRestore, restoreBackup } from "./restore.mjs";
import { backedUpSnapshot, craftArchive, makeDataDir, snapshotOf, tmp } from "./testkit.mjs";

const require_sha = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const posix = process.platform !== "win32";
const base = (dataDir, extra = {}) => ({ dataDir, bridgeVersion: "2.0.0", masterKeyFile: join(dataDir, "master.key"), ...extra });

describe("what a backup holds", () => {
  it("holds the data files and settings, and never the master key, tokens, caches or temp files", () => {
    const dataDir = makeDataDir();
    const { files, excluded } = collectDataFiles(dataDir, { masterKeyFile: join(dataDir, "master.key") });
    const names = files.map((f) => f.rel);
    expect(names).toEqual(expect.arrayContaining(["keys.json", "hooks.json", "quotas.json", "audit/head.json", "audit/2026-11-09.jsonl", "paper/book-paper-main.json", "orders/state.json", "safety/state.json", "sources/state.json", "pooling/consent.json", "readiness/state.json"]));
    for (const never of ["master.key", "control.token", "sign-in-codes.json", "secrets.enc"]) expect(names).not.toContain(never);
    expect(names.some((n) => n.startsWith("instruments/") || n.endsWith(".tmp"))).toBe(false);
    expect(excluded.map((e) => e.path)).toEqual(expect.arrayContaining(["master.key", "control.token", "secrets.enc", "instruments"]));
    expect(excluded.find((e) => e.path === "master.key").reason).toMatch(/never included/);
    // the audit head is copied before the log files, so a log that grows while copying is never older than its head
    expect(names.indexOf("audit/head.json")).toBe(0);
  });

  it("secrets.enc only with includeSecrets, and the master key still never", () => {
    const dataDir = makeDataDir();
    const withS = collectDataFiles(dataDir, { includeSecrets: true, masterKeyFile: join(dataDir, "master.key") }).files.map((f) => f.rel);
    expect(withS).toContain("secrets.enc");
    expect(withS).not.toContain("master.key");
  });

  it("a master key kept under another name or place (masterKeyFile) is left out too", () => {
    const dataDir = makeDataDir();
    mkdirSync(join(dataDir, "keyring"));
    writeFileSync(join(dataDir, "keyring", "mine.bin"), "KEY");
    writeFileSync(join(dataDir, "master.key.bak"), "OLD KEY");
    const names = collectDataFiles(dataDir, { includeSecrets: true, masterKeyFile: join(dataDir, "keyring", "mine.bin") }).files.map((f) => f.rel);
    expect(names).not.toContain("keyring/mine.bin");
    expect(names).not.toContain("master.key.bak");
  });

  it("skips links instead of following them", () => {
    if (!posix) return;
    const dataDir = makeDataDir();
    const outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(join(outside, "secret.txt"), join(dataDir, "link.json"));
    const { files, excluded } = collectDataFiles(dataDir, {});
    expect(files.map((f) => f.rel)).not.toContain("link.json");
    expect(excluded.find((e) => e.path === "link.json").reason).toMatch(/link/);
  });

  it("classify and checkEntryName agree on the never-included files", () => {
    for (const rel of ["master.key", "control.token", "sign-in-codes.json", "backups/x.tar.gz", "instruments/a.json", "audit/x.tmp"]) expect(classify(rel, { includeSecrets: true }).include).toBe(false);
    for (const name of ["data/master.key", "data/control.token", "data/backups/a", "data/instruments/a.json"]) expect(() => checkEntryName(name)).toThrow(/not allowed/);
    expect(checkEntryName("data/secrets.enc")).toEqual({ area: "data", rel: "secrets.enc" });
  });
});

describe("writing a backup", () => {
  it("writes one verified archive with a manifest of versions, time and SHA-256 per file", async () => {
    const dataDir = makeDataDir();
    const configFile = join(dataDir, "..", "bridge.config.json");
    writeFileSync(configFile, '{"dataDir":"data"}');
    const out = join(tmp(), "b.tar.gz");
    const res = await writeBackup({ ...base(dataDir), configFile, out, now: new Date("2026-11-09T10:00:00Z") });
    expect(res.path).toBe(out);
    expect(res.files).toBeGreaterThan(10);
    const { manifest, entries } = await inspectArchive(out);
    expect(manifest).toMatchObject({ format: "mc-bridge-backup", formatVersion: 1, bridgeVersion: "2.0.0", createdAt: "2026-11-09T10:00:00.000Z", includesSecrets: false, includesConfig: true });
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size >= 0)).toBe(true);
    expect(entries.map((e) => e.name)).toContain("config/bridge.config.json");
    expect(manifest.note).toMatch(/master key is never part of a backup/);
    expect(manifest.excluded.map((e) => e.path)).toContain("master.key");
    // the raw archive holds no trace of the master key's content
    expect(gunzipSync(readFileSync(out)).toString("latin1")).not.toContain("MASTER-KEY-MATERIAL");
  });

  it.skipIf(!posix)("the file is private to the user (mode 600) even under a permissive umask", async () => {
    const dataDir = makeDataDir();
    const old = process.umask(0o000);
    try {
      const out = join(tmp(), "p.tar.gz");
      await writeBackup({ ...base(dataDir), out });
      expect(statSync(out).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  it("refuses to overwrite an existing file, and leaves it as it was", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "exists.tar.gz");
    writeFileSync(out, "precious");
    await expect(writeBackup({ ...base(dataDir), out })).rejects.toThrow(/already exists/);
    expect(readFileSync(out, "utf8")).toBe("precious");
  });

  it("leaves no partial file behind when it fails", async () => {
    const dataDir = makeDataDir();
    const dir = tmp();
    await expect(writeBackup({ ...base(dataDir), out: join(dir, "x.tar.gz"), maxBytes: 10 })).rejects.toThrow(/limit/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("secrets.enc is inside only when asked, and the manifest says so", async () => {
    const dataDir = makeDataDir();
    const a = await writeBackup({ ...base(dataDir), out: join(tmp(), "a.tar.gz") });
    const b = await writeBackup({ ...base(dataDir), out: join(tmp(), "b.tar.gz"), includeSecrets: true });
    expect(a.includesSecrets).toBe(false);
    expect(b.includesSecrets).toBe(true);
    expect((await inspectArchive(a.path)).entries.map((e) => e.name)).not.toContain("data/secrets.enc");
    expect((await inspectArchive(b.path)).entries.map((e) => e.name)).toContain("data/secrets.enc");
    for (const r of [a, b]) expect(gunzipSync(readFileSync(r.path)).toString("latin1")).not.toContain("MASTER-KEY-MATERIAL");
  });

  it("names backups by time and kind, and reads the name back", () => {
    const n = backupFileName("upgrade", new Date(2026, 10, 9, 2, 15, 0));
    expect(n).toBe("mc-bridge-backup-20261109-021500-upgrade.tar.gz");
    expect(parseBackupName(n)).toEqual({ stamp: "20261109-021500", kind: "upgrade" });
    expect(parseBackupName("notes.tar.gz")).toBeNull();
    expect(parseBackupName("../mc-bridge-backup-20261109-021500-upgrade.tar.gz")).toBeNull();
  });
});

describe("restore: round trip", () => {
  it("backup then restore reproduces every backed-up file byte for byte, and leaves the master key and caches alone", async () => {
    const dataDir = makeDataDir();
    const configFile = join(dataDir, "..", "bridge.config.json");
    writeFileSync(configFile, '{"dataDir":"data","note":"original"}');
    const before = backedUpSnapshot(dataDir);
    const out = join(tmp(), "rt.tar.gz");
    await writeBackup({ ...base(dataDir), configFile, out, includeSecrets: true });

    // The disk "dies": everything is changed, deleted or added.
    writeFileSync(join(dataDir, "keys.json"), "CORRUPTED");
    writeFileSync(join(dataDir, "paper", "book-paper-main.json"), "{}");
    writeFileSync(join(dataDir, "paper", "book-new.json"), "made after the backup");
    writeFileSync(join(dataDir, "audit", "2026-11-10.jsonl"), "later\n");
    writeFileSync(join(dataDir, "secrets.enc"), "DIFFERENT");
    writeFileSync(configFile, '{"dataDir":"data","note":"edited"}');
    const kept = { master: readFileSync(join(dataDir, "master.key"), "utf8"), instruments: readFileSync(join(dataDir, "instruments/demo-2026-11-09.json"), "utf8") };

    const res = await restoreBackup({ ...base(dataDir), configFile, archive: out });
    expect(res.restored).toBe(true);
    expect(backedUpSnapshot(dataDir)).toEqual(before);
    expect(readFileSync(configFile, "utf8")).toBe('{"dataDir":"data","note":"original"}');
    expect(existsSync(join(dataDir, "paper", "book-new.json"))).toBe(false);
    expect(readFileSync(join(dataDir, "master.key"), "utf8")).toBe(kept.master);
    expect(readFileSync(join(dataDir, "instruments/demo-2026-11-09.json"), "utf8")).toBe(kept.instruments);
    // no staging or holding folders left in the data folder
    expect(readdirSync(dataDir).filter((n) => n.startsWith(".restore-") || n.startsWith(".pre-restore-"))).toEqual([]);
  });

  it("makes a safety backup of the current data first, and it holds what was replaced", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "s.tar.gz");
    await writeBackup({ ...base(dataDir), out });
    writeFileSync(join(dataDir, "keys.json"), "NEWER STATE");
    const res = await restoreBackup({ ...base(dataDir), archive: out });
    expect(res.safetyBackup).toMatch(/backups[\\/]mc-bridge-backup-.*-safety\.tar\.gz$/);
    const { entries } = await inspectArchive(res.safetyBackup);
    const keys = entries.find((e) => e.name === "data/keys.json");
    expect(keys).toBeTruthy();
    // restoring the safety backup brings the newer state back
    await restoreBackup({ ...base(dataDir), archive: res.safetyBackup });
    expect(readFileSync(join(dataDir, "keys.json"), "utf8")).toBe("NEWER STATE");
  });

  it("restores into an empty folder (a new computer) with no safety backup needed", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "n.tar.gz");
    const configFile = join(tmp(), "cfg", "bridge.config.json");
    mkdirSync(join(configFile, ".."), { recursive: true });
    writeFileSync(configFile, '{"x":1}');
    await writeBackup({ ...base(dataDir), configFile, out });
    const fresh = join(tmp(), "data");
    const freshConfig = join(tmp(), "home", "bridge.config.json");
    const res = await restoreBackup({ ...base(fresh), configFile: freshConfig, archive: out });
    expect(res.safetyBackup).toBeNull();
    const { "secrets.enc": _s, ...expected } = backedUpSnapshot(dataDir);
    expect(backedUpSnapshot(fresh)).toEqual(expected);
    expect(readFileSync(freshConfig, "utf8")).toBe('{"x":1}');
  });

  it("without secrets in the archive, the secrets file already here is kept", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "k.tar.gz");
    await writeBackup({ ...base(dataDir), out });
    writeFileSync(join(dataDir, "secrets.enc"), "MY CURRENT LOGINS");
    const res = await restoreBackup({ ...base(dataDir), archive: out });
    expect(res.plan.secrets).toBe("kept");
    expect(readFileSync(join(dataDir, "secrets.enc"), "utf8")).toBe("MY CURRENT LOGINS");
  });

  it.skipIf(!posix)("restored files are private to the user", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "m.tar.gz");
    await writeBackup({ ...base(dataDir), out });
    const old = process.umask(0o000);
    try {
      await restoreBackup({ ...base(dataDir), archive: out });
    } finally {
      process.umask(old);
    }
    for (const rel of ["keys.json", "audit/2026-11-09.jsonl", "paper/book-paper-main.json"]) expect(statSync(join(dataDir, rel)).mode & 0o077).toBe(0);
    expect(statSync(join(dataDir, "audit")).mode & 0o077).toBe(0);
  });

  it("undoes everything when the swap fails part way", async () => {
    const dataDir = makeDataDir();
    const configFile = join(tmp(), "cfg.json");
    writeFileSync(configFile, '{"v":"old"}');
    const out = join(tmp(), "u.tar.gz");
    await writeBackup({ ...base(dataDir), configFile, out });
    writeFileSync(join(dataDir, "keys.json"), "STATE-AFTER-BACKUP");
    writeFileSync(configFile, '{"v":"new"}');
    const stateBefore = backedUpSnapshot(dataDir);
    // The config path is a folder, so the last step (replace the settings file) fails after the data was swapped.
    const bad = join(tmp(), "cfgdir");
    mkdirSync(join(bad, "bridge.config.json"), { recursive: true });
    await expect(restoreBackup({ ...base(dataDir), configFile: join(bad, "bridge.config.json"), archive: out })).rejects.toThrow(/undone/);
    expect(backedUpSnapshot(dataDir)).toEqual(stateBefore);
    expect(readdirSync(dataDir).filter((n) => n.startsWith(".restore-") || n.startsWith(".pre-restore-"))).toEqual([]);
  });
});

describe("restore: dry run and plan", () => {
  it("shows what would change and changes nothing", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "d.tar.gz");
    await writeBackup({ ...base(dataDir), out });
    writeFileSync(join(dataDir, "keys.json"), "changed");
    rmSync(join(dataDir, "hooks.json"));
    writeFileSync(join(dataDir, "paper", "extra.json"), "new");
    const before = snapshotOf(dataDir);
    const res = await restoreBackup({ ...base(dataDir), archive: out, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.restored).toBe(false);
    expect(res.plan.replace).toEqual(["keys.json"]);
    expect(res.plan.add).toEqual(["hooks.json"]);
    expect(res.plan.remove).toEqual(["paper/extra.json"]);
    expect(res.plan.same).toContain("quotas.json");
    expect(snapshotOf(dataDir)).toEqual(before);
    expect(existsSync(join(dataDir, "backups"))).toBe(false);
  });

  it("planRestore reports the settings file and secrets", async () => {
    const dataDir = makeDataDir();
    const configFile = join(tmp(), "c.json");
    writeFileSync(configFile, "{}");
    const out = join(tmp(), "pl.tar.gz");
    const w = await writeBackup({ ...base(dataDir), configFile, out, includeSecrets: true });
    const plan = planRestore({ manifest: w.manifest, dataDir, configFile, masterKeyFile: join(dataDir, "master.key") });
    expect(plan.config).toBe("same");
    expect(plan.secrets).toBe("restored");
  });
});

describe("restore: damaged and tampered archives", () => {
  async function made() {
    const dataDir = makeDataDir();
    const out = join(tmp(), "t.tar.gz");
    await writeBackup({ ...base(dataDir), out });
    return { dataDir, out };
  }

  it("detects a changed byte inside a file (checksum) and restores nothing", async () => {
    const { dataDir, out } = await made();
    const tar = gunzipSync(readFileSync(out));
    const at = tar.indexOf(Buffer.from('"killSwitch":false'));
    expect(at).toBeGreaterThan(0);
    tar[at + 15] = "X".charCodeAt(0); // false -> fXlse, same length
    const bad = join(tmp(), "tampered.tar.gz");
    writeFileSync(bad, gzipSync(tar));
    const before = snapshotOf(dataDir);
    await expect(inspectArchive(bad)).rejects.toThrow(/checksum/);
    await expect(restoreBackup({ ...base(dataDir), archive: bad })).rejects.toThrow(/checksum/);
    expect(snapshotOf(dataDir)).toEqual(before);
  });

  it("detects a file whose manifest entry was edited", async () => {
    const dir = tmp();
    const f = await craftArchive(join(dir, "a.tar.gz"), [["data/keys.json", "{}"]], { manifestFiles: [{ path: "data/keys.json", size: 2, sha256: "0".repeat(64) }] });
    await expect(inspectArchive(f)).rejects.toThrow(/does not match its checksum/);
  });

  it("detects an extra file that the manifest does not list, and a listed file that is missing", async () => {
    const dir = tmp();
    const sum = (s) => require_sha(s);
    const extra = await craftArchive(join(dir, "e.tar.gz"), [["data/keys.json", "{}"], ["data/extra.json", "evil"]], { manifestFiles: [{ path: "data/keys.json", size: 2, sha256: sum("{}") }] });
    await expect(inspectArchive(extra)).rejects.toThrow(/not in its manifest/);
    const missing = await craftArchive(join(dir, "m.tar.gz"), [["data/keys.json", "{}"]], { manifestFiles: [{ path: "data/keys.json", size: 2, sha256: sum("{}") }, { path: "data/gone.json", size: 1, sha256: sum("x") }] });
    await expect(inspectArchive(missing)).rejects.toThrow(/missing from the archive/);
  });

  it("refuses a truncated, empty, garbage or non-gzip file with a plain message", async () => {
    const { dataDir, out } = await made();
    const whole = readFileSync(out);
    const cases = {
      truncated: whole.subarray(0, Math.floor(whole.length / 2)),
      empty: Buffer.alloc(0),
      garbage: Buffer.from("this is not a backup at all, just some text ".repeat(20)),
      "gzip of text": gzipSync(Buffer.from("hello")),
      "gzip, tar cut before the end marker": gzipSync(gunzipSync(whole).subarray(0, 3000)),
    };
    const before = snapshotOf(dataDir);
    for (const [label, bytes] of Object.entries(cases)) {
      const f = join(tmp(), "c.tar.gz");
      writeFileSync(f, bytes);
      const err = await inspectArchive(f).then(() => null, (e) => e);
      expect(err, label).toBeTruthy();
      expect(String(err.detail ?? err.message), label).toMatch(/damaged|not a backup|cut short|no manifest|manifest/);
      await expect(restoreBackup({ ...base(dataDir), archive: f }), label).rejects.toThrow();
    }
    expect(snapshotOf(dataDir)).toEqual(before);
  });

  it("an archive without a manifest is refused", async () => {
    const f = await craftArchive(join(tmp(), "nm.tar.gz"), [["data/keys.json", "{}"]], { noManifest: true });
    await expect(inspectArchive(f)).rejects.toThrow(/no manifest/);
  });

  it("a file that does not exist is a plain message", async () => {
    await expect(restoreBackup({ ...base(makeDataDir()), archive: join(tmp(), "nope.tar.gz") })).rejects.toThrow(/no backup file/);
  });
});

describe("restore: hostile archives cannot write outside the data folder", () => {
  const evil = [
    ["parent folder", "../evil.txt"],
    ["parent inside data", "data/../../evil.txt"],
    ["deep parent", "data/a/../../../evil.txt"],
    ["absolute path", "/tmp/evil.txt"],
    ["windows drive", "C:/evil.txt"],
    ["backslash", "data\\..\\evil.txt"],
    ["outside data and config", "other/evil.txt"],
    ["config elsewhere", "config/other.json"],
    ["NUL", "data/a\0b.json"],
    ["dot segment", "data/./keys.json"],
    ["empty segment", "data//keys.json"],
    ["colon (stream name)", "data/keys.json:stream"],
    ["master key", "data/master.key"],
    ["control token", "data/control.token"],
    ["sign-in codes", "data/sign-in-codes.json"],
    ["a backups file", "data/backups/x.tar.gz"],
    ["restore folder", "data/.pre-restore-x/keys.json"],
  ];
  for (const [label, name] of evil) {
    it(`refuses ${label}`, async () => {
      const root = tmp();
      const dataDir = makeDataDir(join(root, "home"));
      const file = await craftArchive(join(tmp(), "evil.tar.gz"), [[name, "owned"]]);
      const before = snapshotOf(root);
      await expect(restoreBackup({ ...base(dataDir), archive: file })).rejects.toThrow();
      expect(snapshotOf(root)).toEqual(before);
      expect(existsSync(join(root, "evil.txt"))).toBe(false);
      expect(existsSync(join(root, "home", "evil.txt"))).toBe(false);
    });
  }

  it("refuses a manifest that names a path outside, even if the file is not in the archive", async () => {
    const file = await craftArchive(join(tmp(), "mf.tar.gz"), [["data/keys.json", "{}"]], { manifestFiles: [{ path: "data/keys.json", size: 2, sha256: require_sha("{}") }, { path: "../../etc/passwd", size: 1, sha256: require_sha("x") }] });
    await expect(inspectArchive(file)).rejects.toThrow(/not allowed/);
  });

  it("refuses links and directories-as-files in the tar (only plain files are accepted)", async () => {
    const { tarHeader } = await import("./tar.mjs");
    const h = tarHeader("data/keys.json", 0);
    h.write("2", 156, 1, "ascii"); // symlink type
    // recompute the checksum so only the type is wrong
    h.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const f = join(tmp(), "link.tar.gz");
    writeFileSync(f, gzipSync(Buffer.concat([h, Buffer.alloc(1024)])));
    await expect(inspectArchive(f)).rejects.toThrow(/not a plain file/);
  });

  it("refuses a duplicate entry", async () => {
    const f = await craftArchive(join(tmp(), "dup.tar.gz"), [["data/keys.json", "{}"], ["data/keys.json", "{}"]]);
    await expect(inspectArchive(f)).rejects.toThrow(/twice/);
  });

  it("will not unpack into a folder that already exists", async () => {
    const { out } = await (async () => {
      const dataDir = makeDataDir();
      const o = join(tmp(), "x.tar.gz");
      await writeBackup({ ...base(dataDir), out: o });
      return { out: o };
    })();
    await expect(extractArchive(out, tmp())).rejects.toThrow(/already exists/);
  });
});

describe("version and format compatibility", () => {
  const m = (v, f = 1) => ({ format: "mc-bridge-backup", formatVersion: f, bridgeVersion: v });
  it("accepts the same or an older Bridge, refuses a newer one or a newer format", () => {
    expect(checkCompatibility(m("2.0.0"), { bridgeVersion: "2.0.0" })).toMatchObject({ ok: true });
    expect(checkCompatibility(m("2.0.0"), { bridgeVersion: "2.3.1" })).toMatchObject({ ok: true });
    expect(checkCompatibility(m("1.9.0"), { bridgeVersion: "2.0.0" })).toMatchObject({ ok: true, warnings: [expect.stringMatching(/older major/)] });
    const newer = checkCompatibility(m("2.1.0"), { bridgeVersion: "2.0.9" });
    expect(newer.ok).toBe(false);
    expect(newer.message).toMatch(/made by Bridge 2\.1\.0.*newer.*Install Bridge 2\.1\.0 or newer/);
    expect(checkCompatibility(m("3.0.0"), { bridgeVersion: "2.9.9" }).ok).toBe(false);
    expect(checkCompatibility(m("2.0.0", 2), { bridgeVersion: "2.0.0" })).toMatchObject({ ok: false, message: expect.stringMatching(/newer backup format/) });
    expect(checkCompatibility({ format: "other" }, { bridgeVersion: "2.0.0" }).ok).toBe(false);
    expect(checkCompatibility({ format: "mc-bridge-backup", formatVersion: 1 }, { bridgeVersion: "2.0.0" }).ok).toBe(false);
  });

  it("a restore of an archive from a newer Bridge changes nothing", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "v.tar.gz");
    await writeBackup({ ...base(dataDir, { bridgeVersion: "9.0.0" }), out });
    const before = snapshotOf(dataDir);
    await expect(restoreBackup({ ...base(dataDir), archive: out })).rejects.toThrow(/newer than this one/);
    expect(snapshotOf(dataDir)).toEqual(before);
  });
});

describe("low space", () => {
  it("refuses to start a backup that would not fit, and leaves nothing behind", async () => {
    const dataDir = makeDataDir();
    const dir = tmp();
    const err = await writeBackup({ ...base(dataDir), out: join(dir, "low.tar.gz"), freeBytesFn: () => 100 }).catch((e) => e);
    expect(err.lowSpace).toBe(true);
    expect(String(err.detail)).toMatch(/Not enough free disk space/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a restore checks for room before it touches anything", async () => {
    const dataDir = makeDataDir();
    const out = join(tmp(), "ls.tar.gz");
    await writeBackup({ ...base(dataDir), out });
    const before = snapshotOf(dataDir);
    await expect(restoreBackup({ ...base(dataDir), archive: out, freeBytesFn: () => 1000 })).rejects.toThrow(/Not enough free disk space/);
    expect(snapshotOf(dataDir)).toEqual(before);
  });
});
