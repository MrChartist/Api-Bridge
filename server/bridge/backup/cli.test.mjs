/**
 * `mc-bridge backup` and `mc-bridge restore` through runCli: what is printed, refusal while a Bridge runs, dry run,
 * the confirmation, and the snapshot that `start` takes when the version changed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, USAGE } from "../core/cli.mjs";
import { BRIDGE_VERSION } from "../core/app.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { backedUpSnapshot, makeDataDir, snapshotOf, tmp } from "./testkit.mjs";

/** A home folder with a config file and a data folder full of files, and an io that records what is printed. */
function setup({ port = 0, env = {} } = {}) {
  const home = tmp();
  const dataDir = makeDataDir(home);
  writeFileSync(join(home, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, server: { port }, accounts: [{ id: "practice", broker: "paper" }] }));
  const out = [];
  const err = [];
  const io = { out: (s) => out.push(s), err: (s) => err.push(s), env: { MCB_HOME: join(home, "mcbhome"), ...env }, cwd: home };
  return { home, dataDir, out, err, io, text: () => out.join("\n"), errText: () => err.join("\n") };
}

describe("usage", () => {
  it("lists the commands", () => {
    expect(USAGE).toMatch(/mc-bridge backup \[--out FILE\] \[--include-secrets\]/);
    expect(USAGE).toMatch(/mc-bridge restore FILE \[--dry-run\]/);
  });
});

describe("mc-bridge backup", () => {
  it("writes an archive, says what is and is not in it, and why the master key is not", async () => {
    const t = setup();
    const file = join(t.home, "mine.tar.gz");
    expect(await runCli(["backup"], { out: file }, t.io)).toBe(0);
    expect(existsSync(file)).toBe(true);
    const text = t.text();
    expect(text).toMatch(/Backup written: .*mine\.tar\.gz/);
    expect(text).toMatch(/matched its checksum/);
    expect(text).toMatch(/NOT included: the master key/);
    expect(text).toMatch(/never copied into a backup/);
    expect(text).toMatch(/secrets\.enc .* is not included/);
    expect(text).toMatch(/mode 600/);
    expect(text).toMatch(/Restore it with the Bridge stopped:  mc-bridge restore|npm run bridge -- restore/);
  });

  it("--include-secrets says restoring them needs the original master key", async () => {
    const t = setup();
    expect(await runCli(["backup"], { out: join(t.home, "s.tar.gz"), "include-secrets": true }, t.io)).toBe(0);
    expect(t.text()).toMatch(/secrets\.enc IS included.*ORIGINAL master key/);
  });

  it("refuses to overwrite, and a folder as --out gets a named file inside", async () => {
    const t = setup();
    const file = join(t.home, "x.tar.gz");
    expect(await runCli(["backup"], { out: file }, t.io)).toBe(0);
    expect(await runCli(["backup"], { out: file }, t.io)).toBe(1);
    expect(t.errText()).toMatch(/already exists.*never overwrites/);
    const dir = join(t.home, "usb");
    mkdirSync(dir);
    expect(await runCli(["backup"], { out: dir }, t.io)).toBe(0);
    expect(readdirSync(dir)[0]).toMatch(/^mc-bridge-backup-\d{8}-\d{6}-manual\.tar\.gz$/);
    expect(await runCli(["backup"], { out: true }, t.io)).toBe(1);
  });

  it("without --out it writes to the backups folder in the data folder, and `backup list` shows it", async () => {
    const t = setup();
    expect(await runCli(["backup"], {}, t.io)).toBe(0);
    expect(readdirSync(join(t.dataDir, "backups")).filter((n) => n.endsWith(".tar.gz"))).toHaveLength(1);
    t.out.length = 0;
    expect(await runCli(["backup", "list"], {}, t.io)).toBe(0);
    expect(t.text()).toMatch(/manual\s+\S+ [KM]B\s+mc-bridge-backup-/);
    t.out.length = 0;
    expect(await runCli(["backup", "list"], { json: true }, t.io)).toBe(0);
    expect(JSON.parse(t.out[0]).items).toHaveLength(1);
  });

  it("backup verify checks an archive, and names a damaged one", async () => {
    const t = setup();
    const file = join(t.home, "v.tar.gz");
    await runCli(["backup"], { out: file }, t.io);
    t.out.length = 0;
    expect(await runCli(["backup", "verify", file], {}, t.io)).toBe(0);
    expect(t.text()).toMatch(/every checksum matches/);
    writeFileSync(join(t.home, "bad.tar.gz"), Buffer.from("not a backup"));
    expect(await runCli(["backup", "verify", join(t.home, "bad.tar.gz")], {}, t.io)).toBe(1);
    expect(t.errText()).toMatch(/damaged|not a backup/);
    expect(await runCli(["backup", "verify"], {}, t.io)).toBe(1);
    expect(await runCli(["backup", "frobnicate"], {}, t.io)).toBe(1);
  });
});

describe("mc-bridge restore", () => {
  async function backedUp() {
    const t = setup();
    const file = join(t.home, "r.tar.gz");
    await runCli(["backup"], { out: file }, t.io);
    t.out.length = 0;
    return { t, file };
  }

  it("--dry-run shows what would change and changes nothing", async () => {
    const { t, file } = await backedUp();
    writeFileSync(join(t.dataDir, "keys.json"), "CHANGED");
    const before = snapshotOf(t.dataDir);
    expect(await runCli(["restore", file], { "dry-run": true }, t.io)).toBe(0);
    const text = t.text();
    expect(text).toMatch(/replaced with the backup's version \(1\): keys\.json/);
    expect(text).toMatch(/Dry run only: nothing was changed/);
    expect(text).toMatch(/The master key is not touched/);
    expect(snapshotOf(t.dataDir)).toEqual(before);
  });

  it("restores with --yes, prints the next steps and keeps a safety copy", async () => {
    const { t, file } = await backedUp();
    const expected = backedUpSnapshot(t.dataDir);
    writeFileSync(join(t.dataDir, "keys.json"), "CHANGED");
    writeFileSync(join(t.dataDir, "paper", "late.json"), "late");
    expect(await runCli(["restore", file], { yes: true }, t.io)).toBe(0);
    expect(backedUpSnapshot(t.dataDir)).toEqual(expected);
    const text = t.text();
    expect(text).toMatch(/Restored\./);
    expect(text).toMatch(/A copy of what was here before is saved in: .*-safety\.tar\.gz/);
    expect(text).toMatch(/Next steps:/);
    expect(text).toMatch(/Log in to each broker again/);
    expect(text).toMatch(/live trading/);
  });

  it("asks for the word RESTORE; anything else cancels without touching a file", async () => {
    const { t, file } = await backedUp();
    writeFileSync(join(t.dataDir, "keys.json"), "CHANGED");
    const asked = [];
    t.io.prompt = async (q) => {
      asked.push(q);
      return "yes";
    };
    expect(await runCli(["restore", file], {}, t.io)).toBe(1);
    expect(t.text()).toMatch(/Cancelled\. Nothing was changed/);
    expect(readFileSync(join(t.dataDir, "keys.json"), "utf8")).toBe("CHANGED");
    expect(asked[0]).toMatch(/Type RESTORE/);
    t.io.prompt = async () => "RESTORE";
    expect(await runCli(["restore", file], {}, t.io)).toBe(0);
    expect(readFileSync(join(t.dataDir, "keys.json"), "utf8")).not.toBe("CHANGED");
  });

  it("without a keyboard and without --yes it changes nothing and says to add --yes", async () => {
    const { t, file } = await backedUp();
    writeFileSync(join(t.dataDir, "keys.json"), "CHANGED");
    expect(await runCli(["restore", file], {}, t.io)).toBe(1);
    expect(t.errText()).toMatch(/no keyboard.*--yes/);
    expect(readFileSync(join(t.dataDir, "keys.json"), "utf8")).toBe("CHANGED");
  });

  it("refuses while a Bridge is running on this data folder, and a dry run only warns", async () => {
    const t = setup();
    const { config } = loadConfig({ raw: { dataDir: t.dataDir, logging: { level: "silent" }, server: { port: 0 } }, env: {} });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    try {
      writeFileSync(join(t.home, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, server: { port } }));
      const file = join(t.home, "run.tar.gz");
      expect(await runCli(["backup"], { out: file }, t.io)).toBe(0); // a backup is fine while it runs
      writeFileSync(join(t.dataDir, "keys.json"), "CHANGED-WHILE-RUNNING");
      const before = snapshotOf(t.dataDir);
      t.out.length = 0;
      expect(await runCli(["restore", file], { yes: true }, t.io)).toBe(1);
      expect(t.errText()).toMatch(/A Bridge is running at http:\/\/127\.0\.0\.1:\d+.*Stop it first.*Nothing was changed/);
      expect(snapshotOf(t.dataDir).hasOwnProperty("keys.json")).toBe(true);
      // the running Bridge keeps its control token and writes its own files; compare only what the restore would have rewritten
      expect(readFileSync(join(t.dataDir, "keys.json"), "utf8")).toBe(before["keys.json"]);
      expect(readdirSync(t.dataDir).filter((n) => n.startsWith(".restore-") || n.startsWith(".pre-restore-"))).toEqual([]);
      expect(await runCli(["restore", file], { "dry-run": true }, t.io)).toBe(0);
      expect(t.errText()).toMatch(/this dry run only reads/);
    } finally {
      await app.close();
    }
  });

  it("refuses an archive from a newer Bridge with a clear message", async () => {
    const t = setup();
    const { writeBackup } = await import("./archive.mjs");
    const file = join(t.home, "future.tar.gz");
    await writeBackup({ dataDir: t.dataDir, out: file, bridgeVersion: "99.0.0" });
    expect(await runCli(["restore", file], { yes: true }, t.io)).toBe(1);
    expect(t.errText()).toMatch(/made by Bridge 99\.0\.0.*newer than this one/);
  });

  it("needs a file, and says so when it is not there", async () => {
    const t = setup();
    expect(await runCli(["restore"], {}, t.io)).toBe(1);
    expect(t.errText()).toMatch(/restore needs the backup file/);
    t.err.length = 0;
    expect(await runCli(["restore", join(t.home, "none.tar.gz")], {}, t.io)).toBe(1);
    expect(t.errText()).toMatch(/no backup file/);
  });

  it("--skip-config leaves the settings file alone", async () => {
    const { t, file } = await backedUp();
    const cfgPath = join(t.home, "bridge.config.json");
    const edited = JSON.stringify({ dataDir: "data", logging: { level: "silent" }, server: { port: 0 }, accounts: [], note: "edited" });
    writeFileSync(cfgPath, edited);
    expect(await runCli(["restore", file], { yes: true, "skip-config": true }, t.io)).toBe(0);
    expect(readFileSync(cfgPath, "utf8")).toBe(edited);
    expect(await runCli(["restore", file], { yes: true }, t.io)).toBe(0);
    expect(readFileSync(cfgPath, "utf8")).not.toBe(edited);
  });
});

describe("mc-bridge start: snapshot before a version change", () => {
  it("copies the data first when the version changed, prints one line, and then starts", async () => {
    const t = setup({ port: 0 });
    writeFileSync(join(t.dataDir, "last-version.json"), JSON.stringify({ version: "1.0.0" }));
    let app = null;
    t.io.onListening = (x) => (app = x);
    try {
      expect(await runCli(["start"], {}, t.io)).toBeNull();
      expect(t.errText()).toMatch(/Saved a copy of your data before this version runs \(1\.0\.0 to /);
      const copies = readdirSync(join(t.dataDir, "backups")).filter((n) => n.endsWith("-upgrade.tar.gz"));
      expect(copies).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(t.dataDir, "last-version.json"), "utf8")).version).toBe(BRIDGE_VERSION);
      // the snapshot was taken before the Bridge began: it does not contain this run's control token
      const { inspectArchive } = await import("./archive.mjs");
      const { entries } = await inspectArchive(join(t.dataDir, "backups", copies[0]));
      expect(entries.map((e) => e.name)).toContain("data/keys.json");
      expect(entries.map((e) => e.name)).not.toContain("data/control.token");
    } finally {
      await app?.close();
    }
    // starting again on the same version takes no new snapshot and prints nothing about it
    const again = setup();
    again.io.onListening = (x) => (app = x);
    writeFileSync(join(again.dataDir, "last-version.json"), JSON.stringify({ version: BRIDGE_VERSION }));
    try {
      await runCli(["start"], {}, again.io);
      expect(again.errText()).not.toMatch(/Saved a copy|no copy of your data/);
      expect(existsSync(join(again.dataDir, "backups"))).toBe(false);
    } finally {
      await app?.close();
    }
  });

  it("a snapshot that cannot be made never stops the Bridge from starting", async () => {
    const t = setup({ port: 0 });
    writeFileSync(join(t.dataDir, "last-version.json"), JSON.stringify({ version: "0.1.0" }));
    // backup.maxSizeMb is the smallest allowed (10 MB); a larger audit file makes the automatic copy skip itself
    writeFileSync(join(t.dataDir, "audit", "big.jsonl"), Buffer.alloc(11 * 1024 * 1024, 97));
    writeFileSync(join(t.home, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" }, server: { port: 0 }, backup: { maxSizeMb: 10 } }));
    let app = null;
    t.io.onListening = (x) => (app = x);
    try {
      expect(await runCli(["start"], {}, t.io)).toBeNull();
      expect(t.errText()).toMatch(/Warning: no copy of your data was made.*Start continues/);
      expect(app).toBeTruthy();
    } finally {
      await app?.close();
    }
  });
});

describe("doctor", () => {
  it("reports the backup state and creates nothing", async () => {
    const t = setup();
    expect(await runCli(["doctor"], { "no-port-check": true, json: true }, t.io)).toBe(0);
    const checks = JSON.parse(t.out[0]);
    expect(checks.find((c) => c.check === "backup")).toMatchObject({ level: "warn" });
    expect(checks.find((c) => c.check === "backup-schedule").message).toMatch(/off/);
  });
});
