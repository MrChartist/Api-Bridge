/**
 * Download settings changed while the Bridge runs (budget share, after-hours switch): kept in
 * <dataDir>/downloads/settings.json, read live by the pacing code, config value is the default.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { at, makeManager, waitStatus } from "./testkit.mjs";

const started = [];
const boot = async (o) => {
  const m = makeManager(o);
  await m.manager.start();
  started.push(m.manager);
  return m;
};
afterEach(async () => {
  for (const manager of started.splice(0)) await manager.stop();
});

const settingsFile = (m) => join(m.dataDir, "downloads", "settings.json");

describe("settings changed while the Bridge runs", () => {
  it("starts from the config, changes the share, keeps it across a restart", async () => {
    const m = await boot({ config: { maxBudgetShare: 0.4 } });
    expect(m.manager.settings()).toMatchObject({ maxBudgetShare: 0.4, afterHoursOnly: false, defaults: { maxBudgetShare: 0.4, afterHoursOnly: false }, limits: { minBudgetShare: 0.05, maxBudgetShare: 0.8 }, changed: [] });
    expect(existsSync(settingsFile(m))).toBe(false);
    const after = await m.manager.setSettings({ maxBudgetShare: 0.7 });
    expect(after).toMatchObject({ maxBudgetShare: 0.7, afterHoursOnly: false, changed: ["maxBudgetShare"] });
    expect(JSON.parse(readFileSync(settingsFile(m), "utf8"))).toEqual({ maxBudgetShare: 0.7 });
    // the estimate (and the pacer) read the new share at once, with no restart
    expect((await m.manager.estimate({ symbols: ["NSE:NIFTY"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-05" })).budgetShare).toBe(0.7);
    await m.manager.setSettings({ afterHoursOnly: true });
    expect(JSON.parse(readFileSync(settingsFile(m), "utf8"))).toEqual({ maxBudgetShare: 0.7, afterHoursOnly: true });
    await m.manager.stop();
    const again = await boot({ dataDir: m.dataDir, config: { maxBudgetShare: 0.4 } });
    expect(again.manager.settings()).toMatchObject({ maxBudgetShare: 0.7, afterHoursOnly: true, defaults: { maxBudgetShare: 0.4 } });
  });

  it("refuses a share outside 0.05 to 0.8, unknown fields and an empty body, and changes nothing", async () => {
    const m = await boot();
    for (const body of [{ maxBudgetShare: 0.04 }, { maxBudgetShare: 0.81 }, { maxBudgetShare: "half" }, { afterHoursOnly: "yes" }, { surprise: 1 }, {}, null]) {
      await expect(m.manager.setSettings(body), JSON.stringify(body)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(existsSync(settingsFile(m))).toBe(false);
    expect(m.manager.settings().maxBudgetShare).toBe(0.3);
    await expect(m.manager.setSettings({ maxBudgetShare: 0.05 })).resolves.toMatchObject({ maxBudgetShare: 0.05 });
    await expect(m.manager.setSettings({ maxBudgetShare: 0.8 })).resolves.toMatchObject({ maxBudgetShare: 0.8 });
  });

  it("a damaged settings file is ignored field by field and never stops the Bridge", async () => {
    const first = await boot();
    await first.manager.setSettings({ afterHoursOnly: true });
    await first.manager.stop();
    writeFileSync(settingsFile(first), JSON.stringify({ maxBudgetShare: 9, afterHoursOnly: true, extra: 1 }));
    const m = await boot({ dataDir: first.dataDir });
    expect(m.manager.settings()).toMatchObject({ maxBudgetShare: 0.3, afterHoursOnly: true });
    await m.manager.stop();
    writeFileSync(settingsFile(first), "{ not json");
    const n = await boot({ dataDir: first.dataDir });
    expect(n.manager.settings()).toMatchObject({ maxBudgetShare: 0.3, afterHoursOnly: false });
  });

  it("a waiting job follows the after-hours switch as it changes; a job that says its own value keeps it", async () => {
    const m = await boot({ config: { maxConcurrentJobs: 2 }, clock: { now: () => at("2026-10-21T11:00:00+05:30") } }); // a Wednesday, 11:00: the market is open
    await m.manager.setSettings({ afterHoursOnly: true });
    const { job } = await m.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-05" });
    expect(job.request.afterHoursOnly).toBeNull();
    const own = await m.manager.create({ symbols: ["NSE:INFY"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-05", afterHoursOnly: false });
    expect(own.job.request.afterHoursOnly).toBe(false);
    await waitStatus(m.manager, own.job.id);
    await new Promise((r) => setTimeout(r, 40));
    expect(m.manager.get(job.id).status).not.toBe("done");
    await m.manager.setSettings({ afterHoursOnly: false });
    expect((await waitStatus(m.manager, job.id)).status).toBe("done");
  });
});
