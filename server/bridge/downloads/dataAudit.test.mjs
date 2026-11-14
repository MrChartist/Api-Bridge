/**
 * Regression tests from the data review (RDATA-xx): each one failed before its fix.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventually, makeManager, waitStatus } from "./testkit.mjs";

const started = [];
afterEach(async () => {
  for (const m of started.splice(0)) await m.manager.stop();
});
const boot = async (o) => {
  const m = makeManager(o);
  await m.manager.start();
  started.push(m);
  return m;
};
const slow = () => new Promise((r) => setTimeout(r, 20));
const level = (m, l, freeMb) => m.bus.emit("storage.status", { level: l, previous: "ok", freeMb, minFreeMb: 1024, hardFreeMb: 200, writeFailures: 0, message: "x" });
const BODY = { symbols: ["NSE:A", "NSE:B"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" };

describe("RDATA-03 a from inside a daily bar keeps that day", () => {
  it("stores the first day of a 1d dataset job whose from is 11:00", async () => {
    const m = await boot();
    const { job } = await m.manager.create({ symbols: ["NSE:A"], intervals: ["1d"], from: "2026-10-05T11:00", to: "2026-10-09", dataset: "mid" });
    await waitStatus(m.manager, job.id);
    const ds = m.manager.getDataset("mid");
    expect(ds.rows).toBe(5); // Monday 5 to Friday 9 October
    expect(ds.files[0].firstBar).toMatch(/^2026-10-05/);
  });
});

describe("RDATA-04 a dataset job with an earlier from is refused, never 'done' with nothing fetched", () => {
  it("says the dataset only grows forward and how to get the older range", async () => {
    const m = await boot();
    const a = await m.manager.create({ symbols: ["NSE:A"], intervals: ["1d"], from: "2026-10-05", to: "2026-10-16", dataset: "d1" });
    await waitStatus(m.manager, a.job.id);
    const calls = m.history.calls.length;
    await expect(m.manager.create({ symbols: ["NSE:A"], intervals: ["1d"], from: "2026-09-01", to: "2026-10-16", dataset: "d1" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/already starts at 2026-10-05.*only grow forward.*new dataset/),
    });
    expect(m.history.calls.length).toBe(calls);
    expect(m.manager.list().filter((j) => j.dataset === "d1")).toHaveLength(1);
    // the same start, a later start and a new symbol are all fine
    const b = await m.manager.create({ symbols: ["NSE:A", "NSE:B"], intervals: ["1d"], from: "2026-10-05", to: "2026-10-16", dataset: "d1" });
    expect((await waitStatus(m.manager, b.job.id)).status).toBe("done");
  });
});

describe("RDATA-07 cancel or pause while a job is finishing", () => {
  async function bootCombined(act) {
    let m;
    let acted = null;
    let jobId = null;
    const statfs = () => {
      if (jobId && !acted) {
        const j = m.manager.internals.jobs.get(jobId);
        if (j && j.items.every((i) => i.status === "done")) acted = act(m, jobId);
      }
      return 10 * 1024 ** 3;
    };
    m = makeManager({ statfs });
    await m.manager.start();
    started.push(m);
    const { job } = await m.manager.create({ ...BODY, layout: "combined" });
    jobId = job.id;
    await eventually(() => acted, { ms: 5000 });
    return { m, id: job.id, result: await acted };
  }

  it("cancel during the assembly of a combined file ends cancelled and leaves no orphan file", async () => {
    const { m, id, result } = await bootCombined((mm, jid) => mm.manager.cancel(jid));
    expect(result.status).toBe("cancelled");
    const dir = join(m.dataDir, "downloads", "jobs", id);
    const leftovers = () => readdirSync(dir).filter((n) => n.endsWith(".csv") || n.endsWith(".tmp"));
    // The assembly finishes on its own timing (slow on a busy machine): wait for the cleanup instead of a fixed sleep.
    await eventually(() => leftovers().length === 0, { ms: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // a late assembly would write its file in this window
    expect(m.manager.get(id).status).toBe("cancelled");
    expect(leftovers()).toEqual([]);
  });

  it("pause during the assembly stays paused, and a resume assembles the file", async () => {
    const { m, id, result } = await bootCombined((mm, jid) => mm.manager.pause(jid));
    expect(result.status).toBe("paused");
    await new Promise((r) => setTimeout(r, 250)); // long enough for a late assembly to (wrongly) change the state
    expect(m.manager.get(id)).toMatchObject({ status: "paused", reason: "user" });
    await m.manager.resume(id);
    const fin = await waitStatus(m.manager, id);
    expect(fin.status).toBe("done");
    expect(m.manager.files(id).some((f) => f.name.endsWith(".csv"))).toBe(true);
  });
});

describe("RDATA-12 an admin's resume of a key_revoked job holds", () => {
  it("is not paused again by the next housekeeping tick", async () => {
    const m = await boot({ sleep: slow });
    const revoked = new Set();
    m.deps.keyStore = { get: async (id) => (revoked.has(id) ? { id, revokedAt: "x" } : { id }) };
    m.history.fail("UPSTREAM_TIMEOUT", 4);
    const { job } = await m.manager.create(BODY, { actor: { id: "key:abc", admin: false } });
    await eventually(() => m.manager.get(job.id).status === "running");
    revoked.add("abc");
    m.bus.emit("key.revoked", { keyId: "abc" });
    await eventually(() => m.manager.get(job.id).status === "paused");
    expect(m.manager.get(job.id).reason).toBe("key_revoked");
    await m.manager.resume(job.id, { actor: { id: "key:admin", admin: true } });
    await m.manager.tick();
    expect(m.manager.get(job.id).status).not.toBe("paused");
  });
});

describe("RDATA-13 a create() that fails leaves no job behind", () => {
  it("drops the job when its folder cannot be written", async () => {
    const m = await boot();
    rmSync(join(m.dataDir, "downloads", "jobs"), { recursive: true, force: true });
    writeFileSync(join(m.dataDir, "downloads", "jobs"), "x");
    await expect(m.manager.create(BODY)).rejects.toBeTruthy();
    expect(m.manager.list()).toEqual([]);
  });
});

describe("RDATA-19 smaller items", () => {
  it("a: two concurrent creates on one new dataset make one job", async () => {
    const m = await boot();
    const body = { symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16", dataset: "dup" };
    const r = await Promise.allSettled([m.manager.create(body), m.manager.create(body)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.find((x) => x.status === "rejected").reason).toMatchObject({ code: "STATE_CONFLICT" });
    expect(m.manager.list().filter((j) => j.dataset === "dup")).toHaveLength(1);
  });

  it("b: tick() does not resume a disk_low job while the storage module still says critical", async () => {
    const m = await boot({ sleep: slow, statfs: () => 10 * 1024 ** 3 });
    m.history.fail("UPSTREAM_TIMEOUT", 4);
    const { job } = await m.manager.create(BODY);
    await eventually(() => m.manager.get(job.id).status === "running");
    level(m, "critical", 120);
    await eventually(() => m.manager.get(job.id).status === "paused");
    await m.manager.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(m.manager.get(job.id).status).toBe("paused");
    level(m, "ok", 5000);
    await eventually(() => ["running", "done"].includes(m.manager.get(job.id).status));
  });

  it("d: a name with control characters is refused, on create and on rename", async () => {
    const m = await boot();
    await expect(m.manager.create({ ...BODY, name: "\u001b]0;pwned\u0007\u001b[2J evil" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const { job } = await m.manager.create({ ...BODY, name: "fine name" });
    await expect(m.manager.patchJob(job.id, { name: "bad\nname" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("g: a job that lost its settings file cannot be resumed into an empty 'done'", async () => {
    const m = await boot();
    const { job } = await m.manager.create(BODY);
    await waitStatus(m.manager, job.id);
    await m.manager.stop();
    writeFileSync(join(m.dataDir, "downloads", "jobs", job.id, "job.json"), "{ cut off");
    const again = makeManager({ dataDir: m.dataDir });
    await again.manager.start();
    started.push(again);
    expect(again.manager.get(job.id)).toMatchObject({ status: "failed", reason: "damaged" });
    await expect(again.manager.resume(job.id)).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(again.manager.get(job.id).status).toBe("failed");
  });
});

describe("RDATA-10 a clock that jumped forward does not delete finished jobs", () => {
  it("holds retention after a restart far ahead of the last run, then applies it again", async () => {
    let now = Date.parse("2026-10-20T11:00:00+05:30");
    const clock = { now: () => now };
    const m = await boot({ clock, config: { retentionDays: 7 } });
    const { job } = await m.manager.create({ symbols: ["NSE:A"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-05" });
    await waitStatus(m.manager, job.id);
    await m.manager.stop();
    now += 400 * 86_400_000; // the clock is a year ahead when the Bridge starts again
    const again = makeManager({ dataDir: m.dataDir, clock, config: { retentionDays: 7 } });
    await again.manager.start();
    started.push(again);
    expect(await again.manager.sweepRetention()).toEqual([]);
    expect(again.manager.list().map((j) => j.id)).toEqual([job.id]);
    now += 7 * 3_600_000; // the hold is over
    expect(await again.manager.sweepRetention()).toEqual([job.id]);
  });
});

describe("RDATA-05 a damaged downloads/settings.json is quarantined", () => {
  it("is moved aside, not overwritten by the next change", async () => {
    const m = await boot();
    await m.manager.setSettings({ maxBudgetShare: 0.2 });
    await m.manager.stop();
    const dir = join(m.dataDir, "downloads");
    writeFileSync(join(dir, "settings.json"), "{ \"maxBudgetShare\": 0.");
    const again = makeManager({ dataDir: m.dataDir });
    await again.manager.start();
    started.push(again);
    expect(readdirSync(dir).some((n) => n.startsWith("settings.json.corrupt-"))).toBe(true);
    await again.manager.setSettings({ afterHoursOnly: true });
    expect(readdirSync(dir).some((n) => n.startsWith("settings.json.corrupt-"))).toBe(true);
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ afterHoursOnly: true });
  });
});
