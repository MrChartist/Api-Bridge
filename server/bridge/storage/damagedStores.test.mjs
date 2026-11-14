/**
 * OPS-03 and OPS-05: a damaged or empty state file never stops the Bridge and never disappears without a trace.
 * Every store moves the file aside (<name>.corrupt-<time>), logs a warning, starts empty and is listed in
 * quarantined(). A recording or a download job whose settings file is damaged stays in the list as "damaged" so its
 * files can still be deleted.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHookStore } from "../hooks/hookStore.mjs";
import { createDedupeMap } from "../hooks/dedupe.mjs";
import { createJournal } from "../events/journal.mjs";
import { createEventLog } from "../events/eventLog.mjs";
import { bootRecorder } from "../recorder/testkit.mjs";
import { makeManager, eventually, waitStatus } from "../downloads/testkit.mjs";
import { resetReportedJournals } from "../../lib/safeStore.mjs";
import { quarantined, resetQuarantined } from "../../lib/storageHealth.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "mcb-damaged-"));
const logger = () => {
  const lines = [];
  return { lines, warn: (m, f) => lines.push(["warn", m, f]), error: (m, f) => lines.push(["error", m, f]), info() {}, debug() {}, child() { return this; } };
};
const corruptCopies = (dir, base) => readdirSync(dir).filter((n) => n.startsWith(`${base}.corrupt-`));

beforeEach(() => {
  resetQuarantined();
  resetReportedJournals();
});

describe("hooks.json", () => {
  for (const [label, content] of [["empty (power cut after an unsynced rename)", ""], ["garbage", "{oops"], ["wrong shape", JSON.stringify({ version: 7 })]]) {
    it(`${label}: the Bridge starts, the file is kept aside and reported`, () => {
      const dir = tmp();
      writeFileSync(join(dir, "hooks.json"), content);
      const log = logger();
      const store = createHookStore({ dataDir: dir, logger: log });
      expect(store.list()).toEqual([]);
      expect(corruptCopies(dir, "hooks.json")).toHaveLength(1);
      expect(quarantined({ under: dir })).toHaveLength(1);
      expect(log.lines.some(([lvl, m]) => lvl === "warn" && /hooks\.json/.test(m))).toBe(true);
      expect(existsSync(join(dir, "hooks.json"))).toBe(false);
    });
  }

  it("the dedupe list moves a damaged file aside too", () => {
    const dir = tmp();
    const f = join(dir, "dedupe.json");
    writeFileSync(f, "");
    const m = createDedupeMap({ now: () => 1, file: f });
    expect(m.get("k")).toBeNull();
    expect(corruptCopies(dir, "dedupe.json")).toHaveLength(1);
  });
});

describe("events files", () => {
  it("subscriptions.jsonl with unreadable lines: the good lines load, a copy is kept, the loss is reported", () => {
    const dir = tmp();
    const file = join(dir, "subscriptions.jsonl");
    writeFileSync(file, `${JSON.stringify({ op: "put", r: { id: "sub_1" } })}\nnot json at all\n${JSON.stringify({ op: "put", r: { id: "sub_2" } })}\n`);
    const log = logger();
    const j = createJournal({ file, logger: log });
    expect(j.list().map((r) => r.id)).toEqual(["sub_1", "sub_2"]);
    expect(corruptCopies(dir, "subscriptions.jsonl")).toHaveLength(1);
    expect(quarantined({ under: dir })[0]).toMatchObject({ what: "webhook subscriptions" });
    expect(log.lines.some(([lvl, m]) => lvl === "warn" && /1 unreadable line/.test(m))).toBe(true);
  });

  it("log.jsonl with no readable line is moved aside with a warning", () => {
    const dir = tmp();
    const file = join(dir, "log.jsonl");
    writeFileSync(file, "garbage\nmore garbage\n");
    const log = logger();
    createEventLog({ dir, retain: 100, maxEventBytes: 4096, now: () => 1, logger: log });
    expect(corruptCopies(dir, "log.jsonl")).toHaveLength(1);
    expect(log.lines.some(([lvl, m]) => lvl === "warn" && /event log/.test(m))).toBe(true);
  });
});

describe("a recording with a damaged recording.json", () => {
  let w;
  afterEach(async () => {
    await w?.close();
    w = null;
  });

  it("stays in the list as damaged, keeps its day files, can be deleted", async () => {
    w = bootRecorder();
    await w.svc.start();
    const r = await w.svc.create({ kind: "quotes", symbols: ["NSE:NIFTY"], everySec: 1 });
    await w.run(3000);
    const folder = join(w.dir, "recordings", r.id);
    // A clean stop writes recording.json one last time; damage it afterwards, as a power cut would.
    const closeOnce = w.svc.close.bind(w.svc);
    await closeOnce();
    w.svc.close = async () => {};
    writeFileSync(join(folder, "recording.json"), "{ broken");
    await w.restart();
    const listed = w.svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: r.id, damaged: true, status: "stopped" });
    expect(listed[0].statusText).toMatch(/Damaged/);
    expect(corruptCopies(folder, "recording.json")).toHaveLength(1);
    expect(quarantined({ under: w.dir }).some((q) => /recording/.test(q.what))).toBe(true);
    // the day files still count and the recording can be deleted
    await w.restart();
    expect(w.svc.list()[0].damaged).toBe(true);
    w.svc.remove(r.id);
    expect(w.svc.list()).toEqual([]);
    expect(existsSync(folder)).toBe(false);
  });
});

describe("a download job with a damaged job.json", () => {
  it("stays in the list as a failed, damaged job and can be deleted", async () => {
    const m1 = makeManager();
    await m1.manager.start();
    const { job } = await m1.manager.create({ symbols: ["NSE:RELIANCE"], intervals: ["1d"], from: "2026-10-01", to: "2026-10-16" });
    await waitStatus(m1.manager, job.id);
    await m1.manager.stop();
    const folder = join(m1.dataDir, "downloads", "jobs", job.id);
    writeFileSync(join(folder, "job.json"), "");
    const m2 = makeManager({ dataDir: m1.dataDir });
    await m2.manager.start();
    try {
      const listed = m2.manager.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: job.id, status: "failed", reason: "damaged" });
      expect(corruptCopies(folder, "job.json")).toHaveLength(1);
      expect(quarantined({ under: m1.dataDir }).length).toBeGreaterThan(0);
      await m2.manager.remove(job.id);
      expect(m2.manager.list()).toEqual([]);
      expect(existsSync(folder)).toBe(false);
    } finally {
      await m2.manager.stop();
    }
  });
});
