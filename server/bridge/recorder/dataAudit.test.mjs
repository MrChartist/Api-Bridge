/**
 * Regression tests from the data review (RDATA-xx): each one failed before its fix.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onQuarantine } from "../../lib/safeStore.mjs";
import { NIFTY, bootRecorder } from "./testkit.mjs";
import { ruleFingerprint } from "./rules.mjs";

const worlds = [];
const boot = (o) => {
  const w = bootRecorder(o);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close().catch(() => {});
});

const UNIVERSE = { expiries: "current-weekly", strikes: { around: "atm", count: 10 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false };

describe("RDATA-01 rule fingerprint covers nested fields", () => {
  it("changes when one nested key changes, and ignores key order and the name", () => {
    const base = { id: "a", name: "x", kind: "chain", underlying: "NIFTY", universe: UNIVERSE, schedule: { days: ["mon"], start: "09:15", end: "15:30" } };
    const fp = ruleFingerprint(base);
    expect(ruleFingerprint({ ...base, name: "renamed", enabled: false })).toBe(fp);
    expect(ruleFingerprint({ ...base, universe: { ...UNIVERSE, strikes: { count: 10, around: "atm" } } })).toBe(fp);
    expect(ruleFingerprint({ ...base, universe: { ...UNIVERSE, strikes: { around: "atm", count: 3 } } })).not.toBe(fp);
    expect(ruleFingerprint({ ...base, universe: { ...UNIVERSE, sides: ["CE"] } })).not.toBe(fp);
    expect(ruleFingerprint({ ...base, schedule: { days: ["mon"], start: "10:00", end: "15:30" } })).not.toBe(fp);
  });

  it("a PATCH of the strike window or the hours rebuilds the live recording, also after a restart", async () => {
    const w = boot();
    await w.svc.start();
    const rule = await w.svc.createRule({ name: "idx", kind: "quotes", underlying: "NIFTY", everySec: 10, universe: UNIVERSE, schedule: { days: ["mon"], start: "09:15", end: "15:30" } });
    await w.svc.setAuto(true);
    const rid = w.svc.getRule(rule.id).recordingId;
    expect(w.svc.get(rid).target.universe.strikes.count).toBe(10);
    await w.svc.patchRule(rule.id, { universe: { ...UNIVERSE, strikes: { around: "atm", count: 3 }, sides: ["CE"] }, schedule: { days: ["mon", "wed"], start: "10:00", end: "11:00" } });
    expect(w.svc.get(rid).target.universe.strikes.count).toBe(3);
    expect(w.svc.get(rid).schedule).toMatchObject({ start: "10:00", end: "11:00" });
    await w.restart();
    expect(w.svc.get(rid).target.universe.strikes.count).toBe(3);
    expect(w.svc.get(rid).schedule.start).toBe("10:00");
  });
});

describe("RDATA-05 a damaged rules.json or settings.json is quarantined, never silently dropped", () => {
  it("moves a cut-off rules.json aside with a copy, warns and reports data.quarantined", async () => {
    const seen = [];
    const off = onQuarantine((e) => seen.push(e));
    try {
      const w = boot();
      await w.svc.start();
      await w.svc.createRule({ name: "mine", kind: "quotes", symbols: [NIFTY], everySec: 10 });
      await w.svc.close();
      const f = join(w.dir, "recordings", "rules.json");
      const good = readFileSync(f, "utf8");
      writeFileSync(f, good.slice(0, good.length - 7));
      await w.restart();
      expect(w.svc.listRules()).toEqual([]);
      const aside = readdirSync(join(w.dir, "recordings")).filter((n) => n.startsWith("rules.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(w.dir, "recordings", aside[0]), "utf8")).toBe(good.slice(0, good.length - 7));
      expect(seen.some((e) => String(e.file).endsWith("rules.json"))).toBe(true);
      // the next change does not destroy the copy
      await w.svc.createRule({ name: "other", kind: "quotes", symbols: [NIFTY], everySec: 10 });
      expect(readdirSync(join(w.dir, "recordings")).some((n) => n.startsWith("rules.json.corrupt-"))).toBe(true);
    } finally {
      off();
    }
  });

  it("does the same for settings.json", async () => {
    const w = boot();
    await w.svc.start();
    await w.svc.close();
    writeFileSync(join(w.dir, "recordings", "settings.json"), "{ not json");
    await w.restart();
    expect(readdirSync(join(w.dir, "recordings")).some((n) => n.startsWith("settings.json.corrupt-"))).toBe(true);
  });
});
