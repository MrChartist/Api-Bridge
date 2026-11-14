/**
 * The shared load-with-quarantine helper, write-failure counting, the Windows rename retry, and the rule that no file
 * outside lib/jsonl.mjs writes a state file with writeFileSync + renameSync (those writes skip fsync).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { renameWithRetry, writeFileAtomic } from "./jsonl.mjs";
import { findCorruptFiles, loadJsonOrQuarantine, noteCorruptLines, resetReportedJournals } from "./safeStore.mjs";
import { isDiskFull, onQuarantine, onWriteFailure, quarantined, resetQuarantined, resetWriteFailures, writeFailureStatus } from "./storageHealth.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "mcb-safe-"));

beforeEach(() => {
  resetQuarantined();
  resetWriteFailures();
  resetReportedJournals();
});

describe("loadJsonOrQuarantine", () => {
  it("reads a good file and reports a missing one", () => {
    const d = tmp();
    writeFileSync(join(d, "a.json"), '{"x":1}');
    expect(loadJsonOrQuarantine(join(d, "a.json"), { what: "a" })).toMatchObject({ value: { x: 1 }, missing: false, quarantinedTo: null });
    expect(loadJsonOrQuarantine(join(d, "none.json"), { what: "a" })).toMatchObject({ value: null, missing: true });
  });

  it("moves an empty, garbled or rejected file aside, logs, reports and tells listeners", () => {
    const d = tmp();
    const heard = [];
    const off = onQuarantine((e) => heard.push(e));
    const warnings = [];
    const log = { warn: (m) => warnings.push(m), error() {} };
    for (const [name, text, validate] of [["empty.json", "   \n", undefined], ["garbled.json", "{nope", undefined], ["shape.json", '{"v":2}', (v) => v.v === 1]]) {
      const f = join(d, name);
      writeFileSync(f, text);
      const r = loadJsonOrQuarantine(f, { what: `store ${name}`, log, now: Date.parse("2026-11-10T04:30:00.123Z"), validate });
      expect(r.value).toBeNull();
      expect(r.quarantinedTo).toBe(`${f}.corrupt-20261110T043000123Z`);
      expect(existsSync(f)).toBe(false);
      expect(existsSync(r.quarantinedTo)).toBe(true);
    }
    off();
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/store empty\.json/);
    expect(heard).toHaveLength(3);
    expect(quarantined({ under: d }).map((q) => q.what)).toEqual(["store empty.json", "store garbled.json", "store shape.json"]);
    expect(quarantined({ under: join(d, "elsewhere") })).toEqual([]);
  });

  it("works with Windows style paths in the folder filter", () => {
    const d = tmp();
    const f = join(d, "w.json");
    writeFileSync(f, "x");
    loadJsonOrQuarantine(f, { what: "w" });
    expect(quarantined({ under: d.replace(/\//g, "\\") }).length).toBe(1);
  });
});

describe("journals with unreadable lines", () => {
  it("keeps a copy once and reports", () => {
    const d = tmp();
    const f = join(d, "j.jsonl");
    writeFileSync(f, '{"a":1}\nbad\n');
    expect(noteCorruptLines(f, { what: "j", corrupt: 1 })).toMatch(/\.corrupt-/);
    expect(noteCorruptLines(f, { what: "j", corrupt: 1 })).toBeNull(); // the same damage is not reported twice
    expect(noteCorruptLines(f, { what: "j", corrupt: 0 })).toBeNull();
    expect(readdirSync(d).filter((n) => n.includes(".corrupt-"))).toHaveLength(1);
  });

  it("findCorruptFiles lists set-aside files for doctor", () => {
    const d = tmp();
    mkdirSync(join(d, "orders"));
    writeFileSync(join(d, "orders", "state.json.corrupt-20261110T000000000Z"), "x");
    writeFileSync(join(d, "hooks.json"), "{}");
    expect(findCorruptFiles(d).map((c) => c.file)).toEqual([join(d, "orders", "state.json.corrupt-20261110T000000000Z")]);
  });
});

describe("write failures", () => {
  it("a failed atomic write is counted, leaves no temp file, and the next good write clears it", () => {
    const d = tmp();
    const seen = [];
    const off = onWriteFailure((f) => seen.push(f));
    // A folder where the file should go makes the final rename fail.
    mkdirSync(join(d, "state.json"));
    expect(() => writeFileAtomic(join(d, "state.json"), "{}")).toThrow();
    expect(readdirSync(d).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(writeFailureStatus({ under: d })).toMatchObject({ openCount: 1, total: 1 });
    expect(seen[0]).toMatchObject({ diskFull: false });
    writeFileAtomic(join(d, "other.json"), "{}");
    expect(writeFailureStatus({ under: d }).openCount).toBe(1); // a different file's success does not clear it
    off();
    resetWriteFailures();
    expect(writeFailureStatus().openCount).toBe(0);
  });

  it("recognises a full disk", () => {
    expect(isDiskFull({ code: "ENOSPC" })).toBe(true);
    expect(isDiskFull({ code: "EDQUOT" })).toBe(true);
    expect(isDiskFull({ code: "EACCES" })).toBe(false);
  });
});

describe("renameWithRetry (Windows: antivirus or the indexer holds the target)", () => {
  it("retries EPERM and EBUSY a few times, then succeeds", () => {
    let calls = 0;
    renameWithRetry("a", "b", {
      waitMs: 0,
      rename: () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("busy"), { code: calls === 1 ? "EPERM" : "EBUSY" });
      },
    });
    expect(calls).toBe(3);
  });

  it("gives up after the last try and never retries other errors", () => {
    let calls = 0;
    const always = (code) => () => {
      calls += 1;
      throw Object.assign(new Error(code), { code });
    };
    expect(() => renameWithRetry("a", "b", { waitMs: 0, tries: 3, rename: always("EACCES") })).toThrow(/EACCES/);
    expect(calls).toBe(3);
    calls = 0;
    expect(() => renameWithRetry("a", "b", { waitMs: 0, rename: always("ENOENT") })).toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });
});

describe("durable writes", () => {
  it("no server file other than lib/jsonl.mjs writes a state file with writeFileSync followed by renameSync", () => {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const offenders = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === "__fixtures__") continue;
          walk(p);
        } else if (/\.mjs$/.test(ent.name) && !/\.test\.mjs$/.test(ent.name) && relative(root, p) !== join("lib", "jsonl.mjs")) {
          const text = readFileSync(p, "utf8");
          if (/\bwriteFileSync\(/.test(text) && /\brenameSync\(/.test(text)) offenders.push(relative(root, p));
        }
      }
    };
    walk(root);
    // Use writeFileAtomic (lib/jsonl.mjs): temp file, fsync, rename with a retry, fsync of the folder.
    expect(offenders).toEqual([]);
  });
});
