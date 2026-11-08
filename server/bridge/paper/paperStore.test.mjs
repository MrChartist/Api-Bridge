/**
 * Paper persistence: atomic file store (round trip, quarantine of bad files, id sequence) and the memory store.
 */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_VERSION, createFileStore, createMemoryStore, isValidState, writeFileAtomic } from "./paperStore.mjs";

const state = (accountId) => ({ v: STATE_VERSION, accountId, startingCapital: 1_000_000, orders: [], trades: [], positions: {}, realisedTotal: 0, charges: 0 });

describe("file store", () => {
  it("round-trips state and the id sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-paper-store-"));
    const store = createFileStore(dir);
    expect(store.load("paper-1")).toEqual({ state: null });
    expect(store.loadIds()).toBeNull();
    store.save("paper-1", state("paper-1"));
    store.saveIds({ day: "20261019", seq: 7 });
    expect(store.load("paper-1").state).toEqual(state("paper-1"));
    expect(store.loadIds()).toEqual({ day: "20261019", seq: 7 });
  });

  it("quarantines unreadable or wrong-shaped files instead of overwriting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-paper-store-"));
    const store = createFileStore(dir, { now: () => 123 });
    writeFileSync(join(dir, "paper-1.json"), "{broken");
    expect(store.load("paper-1")).toEqual({ state: null, corrupt: join(dir, "paper-1.json.corrupt-123") });
    writeFileSync(join(dir, "paper-2.json"), JSON.stringify({ ...state("someone-else") }));
    expect(store.load("paper-2").corrupt).toMatch(/paper-2\.json\.corrupt-123$/);
    expect(readdirSync(dir).sort()).toEqual(["paper-1.json.corrupt-123", "paper-2.json.corrupt-123"]);
  });

  it("ignores a damaged id file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-paper-store-"));
    writeFileSync(join(dir, "_ids.json"), "nope");
    expect(createFileStore(dir).loadIds()).toBeNull();
  });

  it("refuses account ids that are not safe file names", () => {
    const store = createFileStore(mkdtempSync(join(tmpdir(), "mcb-paper-store-")));
    expect(() => store.load("../x")).toThrow(/Bad paper account id/);
    expect(() => store.save("A", state("A"))).toThrow(/Bad paper account id/);
  });

  it("writeFileAtomic leaves no temp file and replaces content", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-paper-store-"));
    const p = join(dir, "sub", "f.json");
    writeFileAtomic(p, "1");
    writeFileAtomic(p, "2");
    expect(readdirSync(join(dir, "sub"))).toEqual(["f.json"]);
  });
});

describe("memory store and shape check", () => {
  it("copies on the way in and out", () => {
    const store = createMemoryStore();
    const s = state("paper-1");
    store.save("paper-1", s);
    s.charges = 99;
    expect(store.load("paper-1").state.charges).toBe(0);
    store.saveIds({ day: "d", seq: 1 });
    expect(store.loadIds()).toEqual({ day: "d", seq: 1 });
  });

  it("validates the stored shape", () => {
    expect(isValidState(state("a1"), "a1")).toBe(true);
    expect(isValidState({ ...state("a1"), v: 2 }, "a1")).toBe(false);
    expect(isValidState({ ...state("a1"), orders: null }, "a1")).toBe(false);
    expect(isValidState(null, "a1")).toBe(false);
  });
});
