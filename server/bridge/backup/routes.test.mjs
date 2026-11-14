/**
 * Backup routes on the real app: admin and this computer only, the archive is never served, the audit trail, the
 * health entry and the bus events.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootBridge } from "../e2e/fixtures.mjs";
import { inspectArchive } from "./archive.mjs";

let bridge;
const keys = {};
const events = [];
const remote = { "X-Forwarded-For": "192.0.2.50" };

beforeAll(async () => {
  bridge = await bootBridge({ brokers: {}, raw: { accounts: [{ id: "practice", broker: "paper" }] }, withConfigFile: true });
  keys.admin = (await bridge.deps.keyStore.create({ label: "admin", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.read = (await bridge.deps.keyStore.create({ label: "read", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  // A master key sitting in the data folder (the default place): it must still never reach a backup.
  writeFileSync(join(bridge.dataDir, "master.key"), "MK-TEST-MATERIAL-0123456789", { mode: 0o600 });
  bridge.deps.bus.on("backup.completed", (e) => events.push(e));
});
afterAll(async () => {
  await bridge?.close();
});

const posix = process.platform !== "win32";

describe("POST /v1/backup", () => {
  it("writes an archive in the data folder and answers with its path on this computer", async () => {
    const res = await bridge.http("/v1/backup", { method: "POST", key: keys.admin, body: {} });
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d).toMatchObject({ kind: "manual", includesSecrets: false, masterKeyIncluded: false });
    expect(d.path.startsWith(join(bridge.dataDir, "backups"))).toBe(true);
    expect(existsSync(d.path)).toBe(true);
    expect(d.restoreCommand).toMatch(/restore ".*\.tar\.gz"/);
    if (posix) expect(statSync(d.path).mode & 0o777).toBe(0o600);
    const { manifest, entries } = await inspectArchive(d.path);
    expect(manifest.bridgeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(["data/keys.json", "config/bridge.config.json"]));
    expect(entries.map((e) => e.name).some((n) => /master\.key|control\.token|secrets\.enc/.test(n))).toBe(false);
    expect(gunzipSync(readFileSync(d.path)).toString("latin1")).not.toContain("MK-TEST-MATERIAL");
  });

  it("includeSecrets adds secrets.enc only when it exists, and still never the master key", async () => {
    const res = await bridge.http("/v1/backup", { method: "POST", key: keys.admin, body: { includeSecrets: true } });
    expect(res.status).toBe(200);
    expect(res.json.data.includesSecrets).toBe(existsSync(join(bridge.dataDir, "secrets.enc")));
    const { entries } = await inspectArchive(res.json.data.path);
    expect(entries.map((e) => e.name)).not.toContain("data/master.key");
  });

  it("is admin only, this computer only, and takes a strict body", async () => {
    expect((await bridge.http("/v1/backup", { method: "POST", key: keys.read, body: {} })).status).toBe(403);
    expect((await bridge.http("/v1/backup", { method: "POST", body: {} })).status).toBe(401);
    const far = await bridge.http("/v1/backup", { method: "POST", key: keys.admin, body: {}, headers: remote });
    expect(far.status).toBe(403);
    expect(far.json.code).toBe("LOOPBACK_ONLY");
    const bad = await bridge.http("/v1/backup", { method: "POST", key: keys.admin, body: { includeSecrets: "yes" } });
    expect(bad.status).toBe(400);
    expect((await bridge.http("/v1/backup", { method: "POST", key: keys.admin, body: { surprise: 1 } })).status).toBe(400);
  });

  it("is audited, and emits backup.completed on the bus", async () => {
    const before = events.length;
    await bridge.http("/v1/backup", { method: "POST", key: keys.admin, body: {} });
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)).toMatchObject({ kind: "manual" });
    const audit = await bridge.http("/v1/audit?type=backup.*", { key: keys.admin });
    expect(audit.json.data.some((r) => r.type === "backup.created" && r.data.name?.endsWith(".tar.gz"))).toBe(true);
  });
});

describe("GET /v1/backup and the archive is never served", () => {
  it("lists the copies, the last backup and the schedule; admin and this computer only", async () => {
    const res = await bridge.http("/v1/backup", { key: keys.admin });
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.items.length).toBeGreaterThanOrEqual(3);
    expect(d.items[0]).toMatchObject({ kind: "manual" });
    expect(d).toMatchObject({ lastBackupKind: "manual", lastError: null, schedule: { enabled: false, time: "02:30", keep: 7 }, keep: 5, folder: join(bridge.dataDir, "backups") });
    expect(d.restoreCommand).toMatch(/restore <file>$/);
    expect((await bridge.http("/v1/backup", { key: keys.read })).status).toBe(403);
    expect((await bridge.http("/v1/backup", { key: keys.admin, headers: remote })).status).toBe(403);
  });

  it("has no route that returns the archive (neither a file path, a download, nor a static folder)", async () => {
    const name = (await bridge.http("/v1/backup", { key: keys.admin })).json.data.items[0].name;
    for (const path of [`/v1/backup/${name}`, `/v1/backup/file?name=${name}`, `/v1/backup/download`, `/backups/${name}`, `/dashboard/${name}`, `/dashboard/backups/${name}`, `/data/backups/${name}`]) {
      const r = await bridge.http(path, { key: keys.admin });
      expect([404, 405], path).toContain(r.status);
      expect(r.text.includes("manifest.json"), path).toBe(false);
    }
    const routes = bridge.app.router.list().filter((r) => r.pattern.includes("backup")).map((r) => `${r.method} ${r.pattern}`);
    expect(routes.sort()).toEqual(["GET /v1/backup", "POST /v1/backup"]);
  });

  it("GET /v1/health shows the backup entry to this computer, and nothing about it to others", async () => {
    const mine = await bridge.http("/v1/health");
    expect(mine.json.backup).toMatchObject({ lastError: null, schedule: { enabled: false, time: "02:30" } });
    expect(typeof mine.json.backup.lastBackupAt).toBe("string");
    expect(mine.json.backup.lastBackupBytes).toBeGreaterThan(0);
    const far = await bridge.http("/v1/health", { headers: remote });
    expect(far.json.backup).toBeUndefined();
  });
});
