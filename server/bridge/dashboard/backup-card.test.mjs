import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ageText, backupModel, formatBytes } from "./backup-card.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const base = { lastBackupAt: ago(2 * 3_600_000), lastBackupBytes: 151_552, lastBackupKind: "manual", lastError: null, schedule: { enabled: false, time: "02:30", keep: 7 }, keep: 5, folder: "/home/me/.mc-bridge/data/backups", items: [{ name: "a.tar.gz", path: "/home/me/.mc-bridge/data/backups/a.tar.gz", bytes: 151_552, at: ago(0), kind: "manual" }], restoreCommand: "mc-bridge restore <file>" };

describe("Backups card: words and numbers", () => {
  it("formats sizes and ages", () => {
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(151_552)).toBe("148 KB");
    expect(formatBytes(3_355_443)).toBe("3.2 MB");
    expect(formatBytes(-1)).toBe("");
    expect(ageText(ago(10_000), NOW)).toBe("just now");
    expect(ageText(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
    expect(ageText(ago(60_000), NOW)).toBe("1 minute ago");
    expect(ageText(ago(3 * 3_600_000), NOW)).toBe("3 hours ago");
    expect(ageText(ago(2 * 86_400_000), NOW)).toBe("2 days ago");
    expect(ageText("nonsense", NOW)).toBe("");
  });
});

describe("Backups card: the model", () => {
  it("a recent backup is fine, and the restore command names the newest file", () => {
    const m = backupModel(base, NOW);
    expect(m).toMatchObject({ tone: "ok", state: "Backed up", headline: "Last backup 2 hours ago", detail: "148 KB · made by hand" });
    expect(m.restoreCommand).toBe('mc-bridge restore "/home/me/.mc-bridge/data/backups/a.tar.gz"');
    expect(m.schedule).toMatch(/Daily backup is off.*backup\.schedule\.enabled/);
    expect(m.failure).toBeNull();
  });

  it("no backup yet is a warning that says so, and the command keeps its placeholder", () => {
    const m = backupModel({ ...base, lastBackupAt: null, lastBackupBytes: null, lastBackupKind: null, items: [] }, NOW);
    expect(m).toMatchObject({ tone: "warn", state: "No backup yet", headline: "No backup yet", detail: "", restoreCommand: "mc-bridge restore <file>" });
  });

  it("an old backup warns: after 30 days, or 3 days when the daily schedule is on", () => {
    expect(backupModel({ ...base, lastBackupAt: ago(40 * 86_400_000) }, NOW).state).toBe("Out of date");
    expect(backupModel({ ...base, lastBackupAt: ago(10 * 86_400_000) }, NOW).tone).toBe("ok");
    const daily = { ...base, schedule: { enabled: true, time: "02:30", keep: 7 } };
    expect(backupModel({ ...daily, lastBackupAt: ago(4 * 86_400_000) }, NOW).tone).toBe("warn");
    expect(backupModel(daily, NOW).schedule).toBe("Daily at 02:30, keeping the newest 7.");
  });

  it("a failed backup is red and carries the reason", () => {
    const m = backupModel({ ...base, lastError: { at: ago(1000), kind: "scheduled", message: "Not enough free disk space" } }, NOW);
    expect(m).toMatchObject({ tone: "bad", state: "Last backup failed", failure: "Not enough free disk space" });
  });

  it("copes with a missing answer", () => {
    expect(backupModel(undefined, NOW)).toMatchObject({ tone: "warn", items: [] });
  });
});

describe("Backups card: wiring", () => {
  const here = import.meta.dirname;
  const read = (f) => readFileSync(resolve(here, f), "utf8");
  it("is on the Safety page, uses only this computer's routes, and never links to the archive", () => {
    expect(read("views.js")).toContain('import { backupSection } from "./backup-card.js"');
    expect(read("views.js")).toMatch(/backupSection\(\), readiness\.demo/);
    const src = read("backup-card.js");
    expect(src).toContain('"/v1/backup"');
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/\.href\s*=|href:|download:|window\.open|location\./);
  });
  it("says what a backup holds and never holds, and why the master key is left out", () => {
    const src = read("backup-card.js");
    expect(src).toMatch(/What a backup holds/);
    expect(src).toMatch(/Your master key\. It is never copied into a backup/);
    expect(src).toMatch(/secrets\.enc/);
    expect(src).toMatch(/original master key/);
  });
});
