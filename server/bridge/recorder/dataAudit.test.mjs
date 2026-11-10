/**
 * Regression tests from the data review (RDATA-xx): each one failed before its fix.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onQuarantine } from "../../lib/safeStore.mjs";
import { createFileStore } from "./files.mjs";
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

describe("RDATA-09 a dead feed does not produce rows", () => {
  it("stops writing once the last tick is older than the gap limit, and opens a gap", async () => {
    const w = boot();
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    await w.run(1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 24000 });
    await w.run(5 * 60_000, 1000);
    const v = w.svc.get(r.id);
    expect(v.rows).toBeLessThanOrEqual(35); // about 30 s of the one tick, not 300 rows
    expect(v.gaps.total).toBeGreaterThanOrEqual(1);
  });

  it("keeps writing while ticks keep coming", async () => {
    const w = boot();
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    await w.run(1000);
    for (let i = 0; i < 60; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 24000 + i });
      await w.run(1000);
    }
    expect(w.svc.get(r.id).rows).toBeGreaterThanOrEqual(55);
    expect(w.svc.get(r.id).gaps.total).toBe(0);
  });
});

describe("RDATA-10 a clock that jumped forward does not wipe the history", () => {
  it("holds retention after a restart with the clock far ahead of the last run", async () => {
    const w = boot({ config: { retentionDays: 30 } });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    await w.run(1000);
    for (let i = 0; i < 3; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 100 + i });
      await w.run(1000);
    }
    await w.svc.close();
    await w.clock.advance(43 * 86_400_000);
    await w.restart();
    w.svc.sweepNow();
    const dir = join(w.dir, "recordings", r.id);
    expect(readdirSync(dir).filter((n) => n.startsWith("2026"))).toHaveLength(1);
    // after the hold (6 hours of a steady clock) the normal retention applies again
    await w.run(7 * 3_600_000, 3_600_000);
    w.svc.sweepNow();
    expect(readdirSync(dir).filter((n) => n.startsWith("2026-11-09"))).toEqual([]);
  });

  it("holds retention when the computer reports a clock change", async () => {
    const w = boot({ config: { retentionDays: 2 } });
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 1, sessionOnly: false });
    writeFileSync(join(w.dir, "recordings", r.id, "2026-11-01__NSE_NIFTY.csv"), "time,symbol\n");
    w.bus.emit("system.clock_changed", { deltaMs: 86_400_000 });
    w.svc.sweepNow();
    expect(readdirSync(join(w.dir, "recordings", r.id)).filter((n) => n.startsWith("2026-11-01"))).toHaveLength(1);
  });
});

describe("RDATA-15 a restart on a later day reports the gap from the last row", () => {
  it("starts the gap at the last data, not at the activation", async () => {
    const w = boot();
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: [NIFTY], everySec: 5, sessionOnly: false });
    await w.run(1000);
    for (let i = 0; i < 20; i += 1) {
      w.hub.pushTick({ symbol: NIFTY, ltp: 100 + i });
      await w.run(5000, 1000);
    }
    const lastData = w.clock.now();
    await w.svc.close();
    await w.clock.set(Date.parse("2026-11-11T10:00:00+05:30"));
    await w.restart();
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(30_000, 1000);
    const gaps = w.svc.get(r.id).gaps.recent;
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    const from = Date.parse(gaps[0].from);
    expect(from).toBeGreaterThanOrEqual(lastData - 15_000);
    expect(from).toBeLessThanOrEqual(lastData + 15_000);
  });
});

describe("RDATA-17 the file bookkeeping does not scan the folder every time", () => {
  it("usedBytes and the index follow appends from memory; list() looks at the folder again", () => {
    const root = mkdtempSync(join(tmpdir(), "mcb-rec-files-"));
    const store = createFileStore({ root });
    const id = "rec_abcd1234";
    store.append(id, "2026-11-09", "NSE:NIFTY", "csv", ["a,1\n"]);
    store.append(id, "2026-11-09", "NSE:NIFTY", "csv", ["b,2\n"]);
    const known = store.usedBytes(id);
    expect(known).toBeGreaterThan(0);
    // a file planted behind the store's back is not seen by the cheap paths ...
    writeFileSync(join(root, id, "2026-11-08__NSE_BANKNIFTY.csv"), "time,symbol\nx,y\n");
    expect(store.usedBytes(id)).toBe(known);
    store.flushIndex(id);
    // ... but is by the listing a person asked for
    expect(store.list(id).map((f) => f.name)).toContain("2026-11-08__NSE_BANKNIFTY.csv");
    expect(store.usedBytes(id)).toBeGreaterThan(known);
    expect(store.list(id).find((f) => f.name.startsWith("2026-11-09"))).toMatchObject({ rows: 2 });
  });
});
