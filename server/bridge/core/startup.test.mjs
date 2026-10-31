import { describe, expect, it } from "vitest";
import { armStartup, openStartup, startupJob, startupProgress, startupReady, startupStatus } from "./startup.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("startup jobs (the demo book seed)", () => {
  it("reads wait from the first request while the Bridge starts, until every job is done", async () => {
    const deps = {};
    armStartup(deps);
    let seeded = false;
    let finish;
    const job = new Promise((r) => (finish = r)).then(() => (seeded = true));
    // A read arrives before the module even registered its job.
    let answered = false;
    const read = startupReady(deps).then(() => (answered = seeded));
    startupJob(deps, "demo book seed", job);
    const opened = openStartup(deps);
    await tick();
    expect(answered).toBe(false);
    finish();
    await opened;
    await read;
    expect(answered).toBe(true);
    // Once open, reads answer at once.
    await expect(startupReady(deps)).resolves.toBeUndefined();
  });

  it("never waits outside listen(), and a failed or slow job does not hold reads for ever", async () => {
    await expect(startupReady({})).resolves.toBeUndefined();
    const deps = {};
    startupJob(deps, "x", new Promise(() => {}));
    await expect(startupReady(deps)).resolves.toBeUndefined();
    armStartup(deps);
    startupJob(deps, "fails", Promise.reject(new Error("no chain")));
    const t0 = Date.now();
    await openStartup(deps, { maxMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(startupReady(deps)).resolves.toBeUndefined();
  });

  it("reports each job's progress while the gate is shut, and nothing once it opens", async () => {
    expect(startupStatus({})).toBeNull();
    const deps = {};
    armStartup(deps);
    let finish;
    startupJob(deps, "demo book seed", new Promise((r) => (finish = r)));
    expect(startupStatus(deps)).toEqual({ ready: false, jobs: [{ name: "demo book seed", done: null, total: null }] });
    startupProgress(deps, "demo book seed", { done: 6, total: 9 });
    expect(startupStatus(deps).jobs[0]).toEqual({ name: "demo book seed", done: 6, total: 9 });
    startupProgress(deps, "demo book seed", { done: -1, total: Number.NaN });
    expect(startupStatus(deps).jobs[0]).toMatchObject({ done: null, total: null });
    const opened = openStartup(deps);
    finish();
    await opened;
    expect(startupStatus(deps)).toBeNull();
  });
});
