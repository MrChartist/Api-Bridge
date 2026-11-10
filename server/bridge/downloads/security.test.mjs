/**
 * Security regressions for downloads (audit "security", S1 to S7): resource caps, the free-disk floor, who may change a
 * job or a dataset, the scheduler floor, and the labels of a dataset file. No network: the history comes from testkit.mjs.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManualClock } from "../ratelimit/fake.mjs";
import { createScheduler } from "../ratelimit/scheduler.mjs";
import { createFakeHistory, eventually, makeManager, TUESDAY_11AM, at, waitStatus } from "./testkit.mjs";

const started = [];
/** A manager that is started (jobs run) or not (jobs stay queued). */
const boot = async (o = {}, { run = true } = {}) => {
  const m = makeManager(o);
  if (run) {
    await m.manager.start();
    started.push(m.manager);
  }
  return m;
};
afterEach(async () => {
  for (const m of started.splice(0)) await m.stop();
});

const BODY = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" };
const A = { id: "key:aaaaaaaaaa", admin: false };
const B = { id: "key:bbbbbbbbbb", admin: false };
const ADMIN = { id: "key:adminadmin", admin: true };

/** A history that waits until `release()`, so jobs stay running. */
function gated() {
  const h = createFakeHistory();
  const inner = h.history;
  let release;
  const open = new Promise((r) => (release = r));
  h.history = async (p, o) => {
    await open;
    return inner(p, o);
  };
  h.release = release;
  return h;
}

describe("S1: a read key cannot queue unlimited jobs or ignore the disk limit", () => {
  it("refuses a job beyond downloads.maxQueuedJobs, whoever asks", async () => {
    const m = await boot({ config: { maxQueuedJobs: 2, maxQueuedJobsPerKey: 10 } }, { run: false });
    await m.manager.create(BODY, { actor: A });
    await m.manager.create(BODY, { actor: B });
    await expect(m.manager.create(BODY, { actor: ADMIN })).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(m.manager.list()).toHaveLength(2);
  });

  it("keeps one key to downloads.maxQueuedJobsPerKey and leaves the rest of the places to others", async () => {
    const m = await boot({ config: { maxQueuedJobs: 20, maxQueuedJobsPerKey: 2 } }, { run: false });
    await m.manager.create(BODY, { actor: A });
    await m.manager.create(BODY, { actor: A });
    await expect(m.manager.create(BODY, { actor: A })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(m.manager.create(BODY, { actor: B })).resolves.toBeTruthy();
  });

  it("frees a place when a job finishes or is cancelled", async () => {
    const m = await boot({ config: { maxQueuedJobs: 1 } }, { run: false });
    const { job } = await m.manager.create(BODY, { actor: A });
    await expect(m.manager.create(BODY, { actor: A })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await m.manager.cancel(job.id, { actor: A });
    await expect(m.manager.create(BODY, { actor: A })).resolves.toBeTruthy();
  });

  it("holds the line when many requests arrive at once (the audit's 150 jobs)", async () => {
    const m = await boot({ config: { maxQueuedJobs: 5, maxQueuedJobsPerKey: 5 } }, { run: false });
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => m.manager.create(BODY, { actor: A })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "RATE_LIMITED")).toBe(true);
    expect(m.manager.list()).toHaveLength(5);
  });

  it("stops at downloads.maxStoredJobs with a plain way out", async () => {
    const m = await boot({ config: { maxQueuedJobs: 50, maxQueuedJobsPerKey: 50, maxStoredJobs: 3 } }, { run: false });
    for (let i = 0; i < 3; i += 1) await m.manager.create(BODY, { actor: ADMIN });
    await expect(m.manager.create(BODY, { actor: ADMIN })).rejects.toThrow(/maxStoredJobs/);
  });

  it("counts job.json in the disk use and writes it compact (a 5000-item job)", async () => {
    const m = await boot({}, { run: false });
    const symbols = Array.from({ length: 500 }, (_, i) => `NSE:S${i}`);
    const intervals = ["1m", "5m", "15m", "30m", "60m", "1d", "1w", "1M", "3m", "10m"];
    const before = m.manager.internals.diskBytes();
    const { job } = await m.manager.create({ symbols, intervals, from: "2026-10-19", to: "2026-10-19" }, { actor: A });
    expect(job.progress.total).toBe(5000);
    const file = join(m.dataDir, "downloads", "jobs", job.id, "job.json");
    const text = readFileSync(file, "utf8");
    expect(text.split("\n").length).toBeLessThan(5); // not indented: the indentation was most of the 2 MB
    expect(m.manager.internals.diskBytes() - before).toBeGreaterThanOrEqual(statSync(file).size);
  });

  it("counts what queued jobs are still expected to write, so two jobs that fit alone are not both accepted", async () => {
    const m = await boot({ config: { maxDiskMb: 1, maxQueuedJobs: 10, maxQueuedJobsPerKey: 10 } }, { run: false });
    const body = { symbols: ["NSE:NIFTY"], intervals: ["5m"], from: "2026-02-01", to: "2026-10-15" };
    const est = await m.manager.estimate(body);
    expect(est.bytes).toBeGreaterThan(0.5 * 1024 * 1024);
    expect(est.bytes).toBeLessThan(1024 * 1024);
    expect(est.disk.wouldExceed).toBe(false);
    await m.manager.create(body, { actor: A });
    const second = await m.manager.estimate(body);
    expect(second.disk.queuedBytes).toBeGreaterThan(0);
    expect(second.disk.wouldExceed).toBe(true);
    await expect(m.manager.create(body, { actor: B })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("S2: downloads keep a free-disk floor", () => {
  it("refuses a job that would leave the disk under downloads.minFreeDiskMb", async () => {
    const m = await boot({ config: { minFreeDiskMb: 500 }, statfs: () => 400 * 1024 * 1024 }, { run: false });
    await expect(m.manager.create(BODY, { actor: A })).rejects.toThrow(/minFreeDiskMb/);
    const est = await m.manager.estimate(BODY);
    expect(est.disk).toMatchObject({ wouldExceed: true, freeBytes: 400 * 1024 * 1024, minFreeBytes: 500 * 1024 * 1024 });
  });

  it("pauses with reason disk_low before asking the broker, and continues when there is room", async () => {
    const state = { free: 10 * 1024 ** 3 };
    const m = await boot({ config: { minFreeDiskMb: 500 }, statfs: () => state.free }, { run: false });
    const { job } = await m.manager.create(BODY, { actor: A });
    state.free = 100 * 1024 * 1024; // another program filled the disk in the meantime
    await m.manager.start();
    started.push(m.manager);
    const paused = await waitStatus(m.manager, job.id, ["paused", "done", "failed"]);
    expect(paused).toMatchObject({ status: "paused", reason: "disk_low" });
    expect(paused.message).toMatch(/minFreeDiskMb/);
    expect(m.history.calls).toEqual([]); // no broker call was spent on bars with no room to write
    await m.manager.tick();
    expect(m.manager.get(job.id).status).toBe("paused"); // still too little room
    state.free = 10 * 1024 ** 3;
    await m.manager.tick();
    expect((await waitStatus(m.manager, job.id)).status).toBe("done");
  });

  it("pauses in the middle of a job when the disk fills up while it runs", async () => {
    const state = { free: 10 * 1024 ** 3 };
    const h = createFakeHistory();
    const inner = h.history;
    h.history = async (p, o) => {
      const r = await inner(p, o);
      state.free = 10 * 1024 * 1024; // the disk fills right after the broker answers
      return r;
    };
    const m = await boot({ config: { minFreeDiskMb: 500 }, statfs: () => state.free, history: h });
    const { job } = await m.manager.create(BODY, { actor: A });
    const paused = await waitStatus(m.manager, job.id, ["paused", "done", "failed"]);
    expect(paused).toMatchObject({ status: "paused", reason: "disk_low" });
  });

  it("downloads.minFreeDiskMb: 0 switches the check off", async () => {
    const m = await boot({ config: { minFreeDiskMb: 0 }, statfs: () => 1 });
    const { job } = await m.manager.create(BODY, { actor: A });
    expect((await waitStatus(m.manager, job.id)).status).toBe("done");
  });
});

describe("S4 and S6: who may change a job or a dataset", () => {
  it("lets only the key that started a job, or an admin, pause, resume, cancel or rename it", async () => {
    const m = await boot({}, { run: false });
    const { job } = await m.manager.create(BODY, { actor: A });
    expect(job.createdBy).toBe(A.id);
    for (const act of [(a) => m.manager.pause(job.id, { actor: a }), (a) => m.manager.cancel(job.id, { actor: a }), (a) => m.manager.patchJob(job.id, { name: "x" }, { actor: a })]) {
      await expect(act(B)).rejects.toMatchObject({ code: "SCOPE_REQUIRED", status: 403 });
    }
    expect(m.manager.get(job.id)).toMatchObject({ status: "queued", name: expect.not.stringMatching(/^x$/) });
    await m.manager.pause(job.id, { actor: A });
    await expect(m.manager.resume(job.id, { actor: B })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(m.manager.resume(job.id, { actor: ADMIN })).resolves.toMatchObject({ status: "queued" });
    await expect(m.manager.cancel(job.id, { actor: ADMIN })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("treats a job from before owners were recorded as admin-only", async () => {
    const m = await boot({}, { run: false });
    const { job } = await m.manager.create(BODY); // no actor: an internal caller, no owner
    expect(job.createdBy).toBeNull();
    await expect(m.manager.cancel(job.id, { actor: A })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(m.manager.cancel(job.id, { actor: ADMIN })).resolves.toBeTruthy();
  });

  it("does not let another key write into a dataset or change what it updates from (the audit's exploit)", async () => {
    const m = await boot();
    const mine = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", dataset: "owner-ds", backup: false };
    await waitStatus(m.manager, (await m.manager.create(mine, { actor: A })).job.id);
    const before = m.manager.getDataset("owner-ds");
    expect(before.createdBy).toBe(A.id);
    // B posts a job into A's dataset with backup switched on, an account and another start date
    await expect(m.manager.create({ ...mine, backup: true, account: "acc1", from: "2026-10-12", symbols: ["NSE:RELIANCE", "NSE:INFY"], intervals: ["1d", "5m"] }, { actor: B })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(m.manager.getDataset("owner-ds").request).toEqual(before.request);
    // B cannot rename or tag it either
    await expect(m.manager.patchDataset("owner-ds", { name: "hijacked" }, { actor: B })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    await expect(m.manager.patchDataset("owner-ds", { tags: ["x"] }, { actor: B })).rejects.toMatchObject({ code: "SCOPE_REQUIRED" });
    expect(m.manager.getDataset("owner-ds").name).toBe("owner-ds");
    // but B may ask for the update the owner set up: it only fetches what the stored request says
    const upd = await m.manager.updateDataset("owner-ds", { actor: B });
    expect(upd.job.request).toMatchObject({ backup: false, from: "2026-10-01" });
    await waitStatus(m.manager, upd.job.id);
  });

  it("lets the owner and an admin keep working with the dataset, without rewriting its stored request", async () => {
    const m = await boot();
    const mine = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", dataset: "mine", backup: false };
    await waitStatus(m.manager, (await m.manager.create(mine, { actor: A })).job.id);
    const more = (await m.manager.create({ ...mine, symbols: ["NSE:INFY"], backup: true, from: "2026-10-12" }, { actor: A })).job;
    await waitStatus(m.manager, more.id);
    const req = m.manager.getDataset("mine").request;
    expect(req).toMatchObject({ backup: false, from: "2026-10-01" }); // not overwritten
    expect(req.symbols).toEqual(["NSE:RELIANCE", "NSE:INFY"]); // only added to
    const renamed = await m.manager.patchDataset("mine", { name: "renamed" }, { actor: A });
    expect(renamed.name).toBe("renamed");
    expect((await m.manager.patchDataset("renamed", { tags: ["x"] }, { actor: ADMIN })).tags).toEqual(["x"]);
  });

  it("pauses the open jobs of a key when it is revoked, and no one else's", async () => {
    const h = gated();
    const m = await boot({ history: h });
    const a = (await m.manager.create(BODY, { actor: A })).job;
    const b = (await m.manager.create(BODY, { actor: B })).job;
    m.bus.emit("key.revoked", { keyId: "aaaaaaaaaa" });
    await eventually(() => m.manager.get(a.id).status === "paused");
    expect(m.manager.get(a.id)).toMatchObject({ status: "paused", reason: "key_revoked" });
    expect(m.manager.get(b.id).status).not.toBe("paused");
    h.release();
    // an admin can still pick the paused job up
    await expect(m.manager.resume(a.id, { actor: ADMIN })).resolves.toBeTruthy();
    await waitStatus(m.manager, a.id);
  });

  it("notices a key revoked by another process (the CLI) at the next housekeeping tick", async () => {
    const h = gated();
    const m = await boot({ history: h });
    const revoked = new Set();
    m.deps.keyStore = { get: async (id) => ({ id, revokedAt: revoked.has(id) ? "2026-10-20T00:00:00Z" : null }) };
    const a = (await m.manager.create(BODY, { actor: A })).job;
    await m.manager.tick();
    expect(m.manager.get(a.id).status).not.toBe("paused");
    revoked.add("aaaaaaaaaa");
    await m.manager.tick();
    expect(m.manager.get(a.id)).toMatchObject({ status: "paused", reason: "key_revoked" });
    h.release();
  });

  it("downloads.pauseOnKeyRevoked: false leaves the jobs alone", async () => {
    const h = gated();
    const m = await boot({ history: h, config: { pauseOnKeyRevoked: false } });
    const a = (await m.manager.create(BODY, { actor: A })).job;
    m.bus.emit("key.revoked", { keyId: "aaaaaaaaaa" });
    await new Promise((r) => setTimeout(r, 30));
    expect(m.manager.get(a.id).status).not.toBe("paused");
    h.release();
  });
});

describe("S5: every broker call carries the scheduler's floor", () => {
  it("a nearly empty window refuses the call even when the pacer's view said yes", async () => {
    const clock = createManualClock(TUESDAY_11AM);
    const policies = { fake: { brokerId: "fake", limits: { history: { perSecond: 1000, perDay: 10, verified: true, source: "https://example.test/limits" } }, groups: {}, maxQuoteBatch: 1, feed: {}, pooling: "unknown" } };
    const m = makeManager({ clock });
    const real = createScheduler({ config: { ratelimit: {} }, logger: m.deps.logger, bus: m.bus, clock, accounts: m.accounts }, { policies });
    const ran = [];
    const inner = m.history;
    // marketData.history as the real service does it: the call goes through the scheduler with the options it was given
    m.deps.marketData.history = (params, opts) => real.schedule({ accountId: opts.accountId, endpointClass: "history", priority: opts.priority, backgroundShare: opts.backgroundShare, signal: opts.signal }, async () => (ran.push(params), inner.history(params, opts)));
    // The pacer's view is stale: it still sees a free budget (live traffic spent it a moment later)
    m.deps.scheduler = { ...m.deps.scheduler, headroomWindows: () => ({ windows: [], backoffMs: 0 }), pickAccount: undefined };
    // Live traffic uses 6 of the 10 daily calls: 4 are left and the floor is 5
    for (let i = 0; i < 6; i += 1) await real.schedule({ accountId: "acc1", endpointClass: "history", priority: "interactive" }, async () => "live");
    expect(real.headroom("acc1", "history").remaining).toBe(4);
    await m.manager.start();
    started.push(m.manager);
    const { job } = await m.manager.create(BODY, { actor: A });
    await eventually(() => m.manager.get(job.id).status === "running", { ms: 2000 });
    await new Promise((r) => setTimeout(r, 60));
    expect(ran).toEqual([]); // held back by the floor: nothing reached the broker
    expect(m.manager.get(job.id).status).toBe("running");
  });
});

describe("S7: the labels of a dataset file are the dataset's, not the older job's", () => {
  it("answers an old job's file URL with the worst class the dataset now holds", async () => {
    let now = TUESDAY_11AM;
    const h = createFakeHistory();
    const inner = h.history;
    let cls = "realtime";
    h.history = async (p, o) => {
      const r = await inner(p, o);
      return { ...r, freshness: { ...r.freshness, class: cls, delaySec: cls === "realtime" ? null : 900, official: cls === "realtime" } };
    };
    const m = await boot({ history: h, clock: { now: () => now } });
    const first = (await m.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", dataset: "labelled" }, { actor: A })).job;
    await waitStatus(m.manager, first.id);
    const file = m.manager.files(first.id)[0].name;
    expect((await m.manager.fileOf(first.id, file)).job).toMatchObject({ dataClass: "realtime", official: true });
    // a later update brings end-of-day, unofficial bars into the same file
    cls = "eod";
    now = at("2026-10-23T18:00:00+05:30");
    const upd = await m.manager.updateDataset("labelled", { actor: A });
    await waitStatus(m.manager, upd.job.id);
    const old = await m.manager.fileOf(first.id, file);
    expect(old.job).toMatchObject({ dataClass: "eod", official: false });
    expect(old.job.delaySec).toBe(900);
  });

  it("keeps a job's dataset name after a rename and a restart", async () => {
    const m = await boot();
    const first = (await m.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", dataset: "before" }, { actor: A })).job;
    await waitStatus(m.manager, first.id);
    await m.manager.patchDataset("before", { name: "after" }, { actor: A });
    expect(m.manager.get(first.id).dataset).toBe("after");
    await m.manager.stop();
    const again = await boot({ dataDir: m.dataDir });
    expect(again.manager.get(first.id)).toMatchObject({ dataset: "after" });
    expect(again.manager.get(first.id).request.dataset).toBe("after");
    expect((await again.manager.fileOf(first.id, again.manager.files(first.id)[0].name)).path).toContain(join("datasets", "after"));
  });
});

describe("S12d: a file that grows while it is sent does not overrun Content-Length", () => {
  it("sends only the bytes that were counted", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { PassThrough } = await import("node:stream");
    const { createDownloadRoutes } = await import("./routes.mjs");
    const dir = mkdtempSync(join(tmpdir(), "mcb-dl-grow-"));
    const path = join(dir, "x.csv");
    writeFileSync(path, "time,close\r\n1,2\r\n3,4\r\n5,6\r\n"); // 30 bytes now, though the answer will promise only 12
    const handlers = createDownloadRoutes({}, { downloads: { fileOf: async () => ({ path, size: 12, name: "x.csv", format: "csv", job: { dataClass: "realtime", source: null, official: null, delaySec: null } }) } });
    const res = new PassThrough();
    res.writeHead = (status, headers) => Object.assign(res, { status, headers });
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    const done = new Promise((r) => res.on("end", r));
    await handlers.file({ params: { downloadId: "dl_aaaaaaaaaaaa", name: "x.csv" }, req: { method: "GET" }, res, requestId: "r", responseHeaders: {} });
    await done;
    expect(res.headers["Content-Length"]).toBe("12");
    expect(Buffer.concat(chunks).length).toBe(12);
  });
});
