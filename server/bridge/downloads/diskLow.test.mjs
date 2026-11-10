/**
 * OPS-07: below the storage module's hard free-space floor, downloads pause (reason disk_low, with a plain message), no
 * new download starts (DISK_FULL), and a paused job continues when space is back. Before this, downloads had no free-space
 * floor at all, only their own maxDiskMb cap.
 */
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
const level = (m, l, freeMb) => m.bus.emit("storage.status", { level: l, previous: "ok", freeMb, minFreeMb: 1024, hardFreeMb: 200, writeFailures: 0, message: "x" });

describe("downloads and a nearly full disk", () => {
  it("refuses a new job while the disk is critical, accepts it again when space is back", async () => {
    const m = await boot();
    level(m, "critical", 90);
    await expect(m.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" })).rejects.toMatchObject({ code: "DISK_FULL", status: 507 });
    level(m, "ok", 5000);
    const { job } = await m.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" });
    expect((await waitStatus(m.manager, job.id)).status).toBe("done");
  });

  it("pauses a job that is queued or running, says why, and continues it when there is room", async () => {
    const m = await boot({ sleep: () => new Promise((r) => setTimeout(r, 20)) });
    m.history.fail("UPSTREAM_TIMEOUT", 4); // slows the first symbol so the pause lands mid-job
    const { job } = await m.manager.create({ symbols: ["NSE:A", "NSE:B"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" });
    await eventually(() => m.manager.get(job.id).status === "running");
    level(m, "critical", 120);
    await eventually(() => m.manager.get(job.id).status === "paused");
    expect(m.manager.get(job.id)).toMatchObject({ status: "paused", reason: "disk_low" });
    expect(m.manager.get(job.id).message).toMatch(/almost full/);
    level(m, "ok", 5000);
    const done = await waitStatus(m.manager, job.id);
    expect(done.status).toBe("done");
    expect(done.progress.done).toBe(2);
  });

  it("a person's own pause is not undone by the disk coming back", async () => {
    const m = await boot({ sleep: () => new Promise((r) => setTimeout(r, 20)) });
    m.history.fail("UPSTREAM_TIMEOUT", 4);
    const { job } = await m.manager.create({ symbols: ["NSE:A"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" });
    await eventually(() => m.manager.get(job.id).status === "running");
    await m.manager.pause(job.id);
    level(m, "ok", 5000);
    await new Promise((r) => setTimeout(r, 50));
    expect(m.manager.get(job.id)).toMatchObject({ status: "paused", reason: "user" });
  });
});
