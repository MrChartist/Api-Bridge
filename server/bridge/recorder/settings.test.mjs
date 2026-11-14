/**
 * Recorder settings changed while the Bridge runs (the budget share): read live by the sampler, kept in
 * recordings/settings.json next to the auto-record switch, config value is the default.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootRecorder } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});
const file = () => join(w.dir, "recordings", "settings.json");

describe("recorder settings", () => {
  it("starts from the config, changes the share, keeps the auto-record switch, and survives a restart", async () => {
    w = bootRecorder({ config: { maxBudgetShare: 0.4 } });
    await w.svc.start();
    expect(w.svc.settings()).toEqual({ maxBudgetShare: 0.4, defaults: { maxBudgetShare: 0.4 }, limits: { minBudgetShare: 0.05, maxBudgetShare: 0.8 }, changed: [] });
    await w.svc.setAuto(true);
    expect(await w.svc.setSettings({ maxBudgetShare: 0.75 })).toMatchObject({ maxBudgetShare: 0.75, changed: ["maxBudgetShare"] });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ autoRecord: { enabled: true }, maxBudgetShare: 0.75 });
    expect(w.svc.status().budgetShare).toBe(0.75);
    const again = await w.restart();
    expect(again.settings().maxBudgetShare).toBe(0.75);
    expect(again.auto().enabled).toBe(true);
  });

  it("refuses a share outside 0.05 to 0.8, an after-hours switch (recordings follow market hours) and unknown fields", async () => {
    w = bootRecorder();
    await w.svc.start();
    for (const body of [{ maxBudgetShare: 0.04 }, { maxBudgetShare: 0.81 }, { maxBudgetShare: "a lot" }, { afterHoursOnly: true }, { maxBudgetShare: 0.5, afterHoursOnly: true }, {}, null]) {
      await expect(w.svc.setSettings(body), JSON.stringify(body)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(existsSync(file())).toBe(false);
    expect(w.svc.settings().maxBudgetShare).toBe(0.3);
  });

  it("a share outside the range in a hand-edited file is ignored", async () => {
    w = bootRecorder();
    await w.svc.start();
    await w.svc.setSettings({ maxBudgetShare: 0.6 });
    writeFileSync(file(), JSON.stringify({ maxBudgetShare: 3 }));
    expect((await w.restart()).settings().maxBudgetShare).toBe(0.3);
  });

  it("the sampler uses the new share on its next broker read, with no restart", async () => {
    w = bootRecorder({ prices: { "NSE:RELIANCE": 1402.5 } });
    await w.svc.start();
    await w.svc.create({ kind: "quotes", symbols: ["NSE:RELIANCE"], everySec: 10, sessionOnly: false });
    w.hub.setConnected(false);
    await w.run(15_000, 5000);
    expect(w.md.calls.filter((c) => c[0] === "quotes").at(-1)[2]).toMatchObject({ backgroundShare: 0.3 });
    await w.svc.setSettings({ maxBudgetShare: 0.7 });
    w.md.calls.length = 0;
    await w.run(30_000, 5000);
    expect(w.md.calls.filter((c) => c[0] === "quotes").at(-1)[2]).toMatchObject({ backgroundShare: 0.7 });
  });
});
