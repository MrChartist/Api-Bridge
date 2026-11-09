import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceState } from "./state.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "mcb-sources-state-"));
const warns = () => {
  const lines = [];
  return { lines, warn: (m, f) => lines.push([m, f]) };
};

describe("source state settings", () => {
  it("has no setting until one is saved, then keeps it across a reload next to the sources", () => {
    const dir = tmp();
    const a = createSourceState({ dataDir: dir });
    expect(a.getSetting("autoFallback")).toBeUndefined();
    a.update("demo-eod", { enabled: true });
    expect(a.setSetting("autoFallback", false)).toBe(true);
    const b = createSourceState({ dataDir: dir });
    expect(b.getSetting("autoFallback")).toBe(false);
    expect(b.get("demo-eod").enabled).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "sources", "state.json"), "utf8"))).toMatchObject({ version: 1, settings: { autoFallback: false } });
  });

  it("refuses unknown settings and non-boolean values, and a hand-edited file cannot smuggle in others", () => {
    const dir = tmp();
    const s = createSourceState({ dataDir: dir });
    expect(() => s.setSetting("other", true)).toThrow();
    expect(() => s.setSetting("autoFallback", "yes")).toThrow();
    mkdirSync(join(dir, "sources"), { recursive: true });
    writeFileSync(join(dir, "sources", "state.json"), JSON.stringify({ version: 1, sources: {}, settings: { autoFallback: "yes", admin: true } }));
    const t = createSourceState({ dataDir: dir });
    expect(t.getSetting("autoFallback")).toBeUndefined();
    expect(t.getSetting("admin")).toBeUndefined();
  });

  it("reads a file from before settings existed", () => {
    const dir = tmp();
    mkdirSync(join(dir, "sources"), { recursive: true });
    writeFileSync(join(dir, "sources", "state.json"), JSON.stringify({ version: 1, sources: { "demo-eod": { enabled: true } } }));
    const s = createSourceState({ dataDir: dir });
    expect(s.loadedFrom).toBe("file");
    expect(s.getSetting("autoFallback")).toBeUndefined();
  });
});

describe("source state", () => {
  it("starts empty, persists changes and reloads them", () => {
    const dir = tmp();
    const a = createSourceState({ dataDir: dir });
    expect(a.loadedFrom).toBe("new");
    expect(a.get("demo-delayed")).toBeNull();
    a.update("demo-delayed", { enabled: true, consent: { acceptedAt: "2026-11-08T10:00:00.000Z", noticeVersion: "demo-1" } });
    a.update("demo-eod", { configured: true });
    const b = createSourceState({ dataDir: dir });
    expect(b.loadedFrom).toBe("file");
    expect(b.get("demo-delayed")).toEqual({ enabled: true, configured: false, consent: { acceptedAt: "2026-11-08T10:00:00.000Z", noticeVersion: "demo-1" }, disabledAt: null });
    expect(b.get("demo-eod")).toEqual({ enabled: false, configured: true, consent: null, disabledAt: null });
    expect(Object.keys(b.all()).sort()).toEqual(["demo-delayed", "demo-eod"]);
  });

  it("writes atomically under sources/state.json with mode 0600 and leaves no temp files", () => {
    const dir = tmp();
    createSourceState({ dataDir: dir }).update("demo-eod", { enabled: true });
    const file = join(dir, "sources", "state.json");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "sources"))).toEqual(["state.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, sources: { "demo-eod": { enabled: true } } });
  });

  it("a corrupt file does not crash: it is moved aside, logged and the state starts clean", () => {
    const dir = tmp();
    mkdirSync(join(dir, "sources"));
    writeFileSync(join(dir, "sources", "state.json"), "{ not json");
    const log = warns();
    const s = createSourceState({ dataDir: dir, logger: log, clock: { now: () => Date.UTC(2026, 10, 8) } });
    expect(s.loadedFrom).toBe("corrupt");
    expect(s.all()).toEqual({});
    expect(log.lines).toHaveLength(1);
    expect(readdirSync(join(dir, "sources")).some((n) => n.startsWith("state.json.corrupt-"))).toBe(true);
    s.update("demo-eod", { enabled: true });
    expect(createSourceState({ dataDir: dir }).get("demo-eod").enabled).toBe(true);
  });

  it("treats an unknown version as corrupt", () => {
    const dir = tmp();
    mkdirSync(join(dir, "sources"));
    writeFileSync(join(dir, "sources", "state.json"), JSON.stringify({ version: 99, sources: { "demo-eod": { enabled: true } } }));
    expect(createSourceState({ dataDir: dir }).loadedFrom).toBe("corrupt");
  });

  it("ignores bad ids and bad values in a hand-edited file", () => {
    const dir = tmp();
    mkdirSync(join(dir, "sources"));
    writeFileSync(join(dir, "sources", "state.json"), JSON.stringify({ version: 1, sources: { "Bad Id": { enabled: true }, "demo-eod": { enabled: "yes", configured: 1, consent: { acceptedAt: 5 }, disabledAt: "not a time" } } }));
    const s = createSourceState({ dataDir: dir });
    expect(s.all()).toEqual({ "demo-eod": { enabled: false, configured: false, consent: null, disabledAt: null } });
  });

  it("keeps disabledAt (a valid time only) across a reload", () => {
    const dir = tmp();
    createSourceState({ dataDir: dir }).update("demo-eod", { enabled: false, disabledAt: "2026-11-08T10:00:00.000Z" });
    expect(createSourceState({ dataDir: dir }).get("demo-eod").disabledAt).toBe("2026-11-08T10:00:00.000Z");
  });

  it("keeps working in memory when the disk is not writable", () => {
    const dir = tmp();
    writeFileSync(join(dir, "sources"), "a file where the folder should be");
    const log = warns();
    const s = createSourceState({ dataDir: dir, logger: log });
    s.update("demo-eod", { enabled: true });
    expect(s.get("demo-eod").enabled).toBe(true);
    expect(log.lines.some(([m]) => /could not be saved/.test(m))).toBe(true);
  });

  it("rejects a bad id on update", () => {
    expect(() => createSourceState({ dataDir: tmp() }).update("Bad Id", {})).toThrow();
  });
});
