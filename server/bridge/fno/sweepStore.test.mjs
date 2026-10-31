/**
 * fno store on disk (docs/spec/p1-06-stocks.md §2.3, §9.2): torn last line ignored, corrupt state.json moved aside,
 * atomic JSON documents, job files beyond keepJobs deleted, dated retention, memory mode writes nothing.
 */
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSweepStore } from "./sweepStore.mjs";

const dirOf = () => join(mkdtempSync(join(tmpdir(), "mcb-fno-")), "fno");

describe("sweep store", () => {
  it("appends chains and reads them back; a torn last line is skipped", () => {
    const dir = dirOf();
    const s = createSweepStore(dir);
    s.appendChain("swp_a", { key: "NIFTY|2026-11-03", seq: 1, method: "chain", chain: { rows: [] } });
    s.appendChain("swp_a", { key: "SBIN|2026-11-23", seq: 2, method: "quotes", chain: { rows: [] } });
    appendFileSync(join(dir, "sweep", "swp_a.ndjson"), '{"key":"TORN|2026-11-2');
    const r = s.readChains("swp_a");
    expect(r.items.map((x) => x.seq)).toEqual([1, 2]);
    expect(r.tornTail).toBe(true);
    // The next append repairs the newline first, so the new record is readable.
    s.appendChain("swp_a", { key: "TCS|2026-11-23", seq: 3, method: "quotes", chain: { rows: [] } });
    expect(s.readChains("swp_a").items.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it("a corrupt state.json is renamed *.corrupt-<ts> and the store starts empty", () => {
    const dir = dirOf();
    createSweepStore(dir);
    writeFileSync(join(dir, "sweep", "state.json"), "{not json");
    const s = createSweepStore(dir, { logger: { warn() {} } });
    expect(s.readState()).toEqual({ version: 1, job: null });
    expect(readdirSync(join(dir, "sweep")).some((n) => n.startsWith("state.json.corrupt-"))).toBe(true);
  });

  it("writes version 1 documents atomically (no temp files left)", () => {
    const dir = dirOf();
    const s = createSweepStore(dir);
    s.writeState({ id: "swp_x", status: "done" });
    s.writeSettings({ optIn: { stocks: ["SBIN"], setAt: null, setBy: null }, autoRepeat: { background: false } });
    expect(JSON.parse(readFileSync(join(dir, "sweep", "state.json"), "utf8"))).toEqual({ version: 1, job: { id: "swp_x", status: "done" } });
    expect(s.readSettings().optIn.stocks).toEqual(["SBIN"]);
    expect(readdirSync(join(dir, "sweep")).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("keeps keepJobs job files in all: the current one plus the newest others", () => {
    const dir = dirOf();
    const s = createSweepStore(dir);
    const ids = ["swp_1", "swp_2", "swp_3", "swp_4"];
    ids.forEach((id, i) => {
      s.appendChain(id, { key: "K", seq: 1 });
      const t = new Date(Date.UTC(2026, 10, 19, 4, i));
      utimesSync(join(dir, "sweep", `${id}.ndjson`), t, t);
    });
    s.pruneJobs(2, "swp_1");
    expect(readdirSync(join(dir, "sweep")).filter((n) => n.endsWith(".ndjson")).sort()).toEqual(["swp_1.ndjson", "swp_4.ndjson"]);
  });

  it("dated retention for oi-base and hv", () => {
    const dir = dirOf();
    const s = createSweepStore(dir);
    for (const d of ["2026-11-10", "2026-11-17", "2026-11-19"]) {
      s.writeOiBase({ date: d, firstAt: { a: ["09:21", 1] } });
      s.writeHv({ date: d, hv: { SBIN: 20 } });
    }
    s.pruneDays({ keepDays: 5, today: "2026-11-19" });
    expect(readdirSync(join(dir, "oi-base")).sort()).toEqual(["2026-11-17.json", "2026-11-19.json"]);
    expect(readdirSync(join(dir, "hv")).sort()).toEqual(["2026-11-17.json", "2026-11-19.json"]);
    expect(s.readOiBase("2026-11-19").firstAt.a).toEqual(["09:21", 1]);
  });

  it("memory mode (demo) writes nothing to disk", () => {
    const dir = dirOf();
    const s = createSweepStore(dir, { memory: true });
    s.writeState({ id: "swp_m" });
    s.appendChain("swp_m", { key: "K", seq: 1 });
    expect(s.persisted).toBe(false);
    expect(s.readState().job.id).toBe("swp_m");
    expect(s.readChains("swp_m").items).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });
});
