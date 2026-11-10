/**
 * OPS-13 and OPS-01: `mc-bridge doctor` knows about the data folder lock, free disk space, files set aside, the order-record
 * damage marker, downloads, recordings, webhooks and collections; --strict fails on the serious ones.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../core/cli.mjs";
import { opsDoctorChecks, storageDoctorChecks } from "./doctor.mjs";
import { webhookSecretsNeeded } from "../events/restoreNote.mjs";

const MB = 1024 * 1024;
const NOW = Date.parse("2026-11-10T10:00:00Z");
const put = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const folder = () => mkdtempSync(join(tmpdir(), "mcb-doc-"));
const find = (checks, check, re) => checks.filter((c) => c.check === check && re.test(c.message));

describe("the data folder", () => {
  it("names the Bridge that holds the lock, and a left-over lock from one that stopped", () => {
    const dir = folder();
    // a process id that cannot exist
    put(dir, "bridge.lock", JSON.stringify({ pid: 0x7ffffff0, port: 4300, startedAt: "2026-11-10T09:12:00.000Z" }));
    let c = storageDoctorChecks({ config: { dataDir: dir }, now: NOW });
    expect(find(c, "instance", /left-over lock .*process 2147483632 is not running.*takes it over/)).toHaveLength(1);
    put(dir, "bridge.lock", JSON.stringify({ pid: process.ppid, port: 4300, startedAt: "2026-11-10T09:12:00.000Z" })); // the test runner that started this process is alive
    require_fs().utimesSync(join(dir, "bridge.lock"), new Date(NOW), new Date(NOW)); // a fresh heartbeat
    c = storageDoctorChecks({ config: { dataDir: dir }, now: NOW });
    expect(find(c, "instance", new RegExp(`A Bridge is running on this data folder \\(process ${process.ppid}, port 4300, started 2026-11-10 09:12\\)`))).toHaveLength(1);
  });

  it("reports free space, and a disk below the hard floor is blocking", () => {
    const dir = folder();
    const at = (freeMb) => storageDoctorChecks({ config: { dataDir: dir, storage: { minFreeMb: 1024, hardFreeMb: 200 } }, now: NOW, statfs: () => ({ bavail: freeMb, bsize: MB, blocks: 100_000 }) }).find((c) => c.check === "disk");
    expect(at(50_000)).toMatchObject({ level: "ok", message: "50000 MB free where the data folder is" });
    expect(at(500)).toMatchObject({ level: "warn", message: expect.stringMatching(/below 1024 MB/) });
    expect(at(500).blocking).toBeUndefined();
    expect(at(120)).toMatchObject({ level: "warn", blocking: true, message: expect.stringMatching(/below 200 MB.*downloads pause/) });
  });

  it("lists damaged files that were set aside, and the order-record marker, as blocking", () => {
    const dir = folder();
    put(dir, "hooks.json.corrupt-20261110T000000000Z", "{");
    put(dir, "orders/state.json.corrupt-20261110T000000000Z", "");
    put(dir, "orders/state-damaged.json", "{}");
    const c = storageDoctorChecks({ config: { dataDir: dir }, now: NOW });
    expect(find(c, "set-aside-files", /2 damaged files were set aside.*hooks\.json\.corrupt-/)[0]).toMatchObject({ blocking: true });
    expect(c.find((x) => x.check === "order-records")).toMatchObject({ blocking: true, fix: expect.stringMatching(/orders acknowledge-state/) });
  });

  it("counts old temp files", () => {
    const dir = folder();
    put(dir, ".state.json.1.abc.tmp", "x");
    const old = new Date(NOW - 3 * 3600_000);
    const { utimesSync } = require_fs();
    utimesSync(join(dir, ".state.json.1.abc.tmp"), old, old);
    expect(find(storageDoctorChecks({ config: { dataDir: dir }, now: NOW }), "temp-files", /1 temp file/)).toHaveLength(1);
  });
});

function require_fs() {
  return globalThis.process.getBuiltinModule("node:fs");
}

describe("downloads, recordings, webhooks and collections", () => {
  it("downloads: size against the limit, failed, stuck, damaged and orphan jobs", () => {
    const dir = folder();
    const job = (id, o) => put(dir, `downloads/jobs/${id}/job.json`, JSON.stringify({ id, items: [], createdAt: "2026-11-10T09:00:00Z", ...o }));
    job("dl_000000000001", { status: "done" });
    job("dl_000000000002", { status: "failed" });
    job("dl_000000000003", { status: "paused", createdAt: "2026-11-08T09:00:00Z" });
    job("dl_000000000004", { status: "failed", damaged: true, reason: "damaged" });
    put(dir, "downloads/jobs/dl_000000000005/data.csv", "x".repeat(2000)); // no job.json
    const c = opsDoctorChecks({ config: { dataDir: dir, downloads: { maxDiskMb: 1 } }, now: NOW });
    expect(find(c, "downloads", /4 jobs \(1 done, 0 waiting or running, 1 paused, 2 failed\)/)).toHaveLength(1);
    expect(find(c, "downloads", /2 download jobs failed/)).toHaveLength(1);
    expect(find(c, "downloads", /1 job has been waiting.*dl_000000000003/)).toHaveLength(1);
    expect(find(c, "downloads", /1 job could not be read/)[0]).toMatchObject({ blocking: true });
    expect(find(c, "downloads", /1 folder under downloads\/jobs has no job\.json/)).toHaveLength(1);
  });

  it("recordings: a damaged settings file, auto-record, and a recording that went silent", () => {
    const dir = folder();
    put(dir, "recordings/rec_aaaa1111/recording.json", JSON.stringify({ id: "rec_aaaa1111", damaged: true }));
    put(dir, "recordings/rec_bbbb2222/recording.json", JSON.stringify({ id: "rec_bbbb2222", status: "active", everySec: 30 }));
    put(dir, "recordings/rec_bbbb2222/state.json", JSON.stringify({ phase: "recording", lastWriteMs: NOW - 2 * 3600_000 }));
    const c = opsDoctorChecks({ config: { dataDir: dir }, now: NOW });
    expect(find(c, "recordings", /2 recordings \(1 active\)/)).toHaveLength(1);
    expect(find(c, "recordings", /lost its settings file \(rec_aaaa1111\)/)[0]).toMatchObject({ blocking: true });
    expect(find(c, "recordings", /written nothing for a long while \(rec_bbbb2222\)/)).toHaveLength(1);
    expect(find(c, "auto-record", /off/)).toHaveLength(1);
  });

  it("webhooks: failing subscriptions, deliveries waiting for a secret, dead letters, old queue", () => {
    const dir = folder();
    const sub = (id, o) => JSON.stringify({ op: "put", r: { id, active: true, label: id, ...o } });
    put(dir, "events/subscriptions.jsonl", [sub("sub_aaaaaaaa", { consecutiveFailures: 5, lastFailureCode: "timeout" }), sub("sub_bbbbbbbb", { needsSecret: true }), sub("sub_cccccccc", {})].join("\n") + "\n");
    put(dir, "events/outbox.jsonl", `${JSON.stringify({ op: "put", r: { id: "dlv_1", subId: "sub_aaaaaaaa", createdAt: NOW - 3 * 3600_000 } })}\n`);
    put(dir, "events/deadletter.jsonl", Array.from({ length: 12 }, (_, i) => JSON.stringify({ op: "put", r: { id: `dlv_d${i}`, subId: "sub_aaaaaaaa" } })).join("\n") + "\n");
    const c = opsDoctorChecks({ config: { dataDir: dir }, now: NOW });
    expect(find(c, "webhooks", /3 subscriptions \(3 on\); 1 delivery queued, 12 dead letters/)).toHaveLength(1);
    expect(find(c, "webhooks", /1 subscription needs the signing secret again/)).toHaveLength(1);
    expect(find(c, "webhooks", /1 subscription is failing \(sub_aaaaaaaa: timeout\)/)).toHaveLength(1);
    expect(find(c, "webhooks", /12 dead letters are set aside/)).toHaveLength(1);
    expect(find(c, "webhooks", /oldest queued delivery is 180 minutes old/)).toHaveLength(1);
    expect(webhookSecretsNeeded(dir)).toBe(3);
  });

  it("collections: a file that was set aside is blocking", () => {
    const dir = folder();
    put(dir, "collections.json.corrupt-20261110T000000000Z", "{");
    put(dir, "collections.json", JSON.stringify({ version: 1, collections: [{}, {}] }));
    const c = opsDoctorChecks({ config: { dataDir: dir }, now: NOW });
    expect(find(c, "collections", /damaged once/)[0]).toMatchObject({ blocking: true });
    expect(find(c, "collections", /^2 collections$/)).toHaveLength(1);
  });
});

describe("mc-bridge doctor --strict", () => {
  it("fails when a damaged file was set aside, and passes without --strict", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcb-doc-cli-"));
    const dataDir = join(root, "data");
    put(dataDir, "hooks.json.corrupt-20261110T000000000Z", "{");
    put(root, "bridge.config.json", JSON.stringify({ dataDir: "data", logging: { level: "silent" } }));
    const out = [];
    const io = { out: (s) => out.push(s), err() {}, env: { MCB_HOME: join(root, "h") }, cwd: root };
    expect(await runCli(["doctor"], { "no-port-check": true }, io)).toBe(0);
    expect(out.join("\n")).toMatch(/set-aside-files\s+1 damaged file was set aside/);
    out.length = 0;
    expect(await runCli(["doctor"], { "no-port-check": true, strict: true }, io)).toBe(1);
    expect(out.join("\n")).toMatch(/BLOCK\s+set-aside-files/);
  });
});
