/**
 * `mc-bridge download ...` against a fake client: the request it builds, the plain words it prints, --watch and --out.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadCommand, formatBytes, formatDuration, formatEstimate, formatJobs, formatProgress, requestFromFlags } from "./cli.mjs";

const job = (o = {}) => ({ id: "dl_aaaaaaaaaaaa", name: "nifty", status: "running", progress: { total: 2, done: 1, failed: 0, rows: 1500, bytes: 93_000, etaSec: 90, current: { symbol: "NSE:NIFTY", interval: "5m" }, waiting: null }, dataClass: "realtime", source: "dhan", official: true, delaySec: null, notes: [], items: [], ...o });
const estimate = { symbols: 1, intervals: 1, items: 1, brokerCalls: 12, callsSaved: 3, rows: 18_000, bytes: 1_116_000, budgetShare: 0.3, etaSec: 40, disk: { wouldExceed: false, maxBytes: 5e9, usedBytes: 0 }, notes: ["Rows assume every trading minute has a bar."] };

function harness(responses) {
  const calls = [];
  const out = [];
  const err = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = responses(method, path, body);
    if (r instanceof Error) throw r;
    return r;
  };
  const raw = async (path) => Buffer.from(`bytes of ${path}`);
  return { calls, out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {}, cwd: tmpdir() }, helpers: { connect: async () => ({ call, raw }), cli: "mc-bridge" } };
}

describe("requestFromFlags", () => {
  it("builds the body from symbols and flags", () => {
    expect(requestFromFlags(["NSE:NIFTY", "NSE:RELIANCE,NSE:INFY"], { interval: "5m,15m", from: "2024-01-01", to: "2024-02-01", format: "jsonl", dataset: "x", backup: true, tags: "a, b", "after-hours": true, name: "n" })).toEqual({
      symbols: ["NSE:NIFTY", "NSE:RELIANCE", "NSE:INFY"],
      intervals: ["5m", "15m"],
      from: "2024-01-01",
      to: "2024-02-01",
      format: "jsonl",
      dataset: "x",
      backup: true,
      tags: ["a", "b"],
      afterHoursOnly: true,
      name: "n",
    });
    expect(requestFromFlags([], { collection: "mine", interval: "1d", from: "2024-01-01" })).toEqual({ collection: "mine", intervals: ["1d"], from: "2024-01-01" });
  });

  it("--allow-expired lets an expired contract through for its history", () => {
    expect(requestFromFlags(["NFO:NIFTY-2020-01-30-12000-CE"], { interval: "1d", from: "2020-01-01", "allow-expired": true }).allowExpired).toBe(true);
    expect(requestFromFlags(["NSE:NIFTY"], { interval: "1d", from: "2020-01-01" }).allowExpired).toBeUndefined();
  });
});

describe("formatting", () => {
  it("says sizes and times in plain words", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
    expect(formatDuration(30)).toBe("30 s");
    expect(formatDuration(4000)).toBe("1 h 07 min");
    expect(formatDuration(null)).toBe("unknown");
    expect(formatDuration(3 * 86_400)).toBe("3 days");
  });
  it("shows the estimate, a progress line and the job table", () => {
    const e = formatEstimate(estimate);
    expect(e).toMatch(/1 symbol x 1 interval: about 18,000 rows, 1\.1 MB on disk/);
    expect(e).toMatch(/Broker calls: 12 \(3 saved because that part is already on this computer\)/);
    expect(e).toMatch(/30% share/);
    expect(formatProgress(job())).toMatch(/dl_aaaaaaaaaaaa {2}running {2}\| {2}1\/2 done {2}\| {2}1,500 rows.*NSE:NIFTY 5m.*about 2 min left/);
    expect(formatProgress(job({ status: "paused", message: "The kill switch is on." }))).toMatch(/The kill switch is on\./);
    expect(formatJobs([job(), job({ id: "dl_bbbbbbbbbbbb", status: "done" })]).split("\n")).toHaveLength(3);
    expect(formatJobs([])).toBe("No download jobs yet.");
  });
});

describe("mc-bridge download", () => {
  it("starts a job: shows the estimate first, then the id", async () => {
    const h = harness((m, p) => (p.includes("dryRun") ? { data: estimate } : { data: job({ status: "queued" }) }));
    const code = await downloadCommand(["NSE:NIFTY"], { interval: "5m", from: "2024-01-01" }, h.io, h.helpers);
    expect(code).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/downloads?dryRun=1", "POST /v1/downloads"]);
    expect(h.calls[1].body).toEqual({ symbols: ["NSE:NIFTY"], intervals: ["5m"], from: "2024-01-01" });
    expect(h.out.join("\n")).toMatch(/18,000 rows/);
    expect(h.out.join("\n")).toMatch(/Started dl_aaaaaaaaaaaa\. Follow it with: mc-bridge download show dl_aaaaaaaaaaaa/);
  });

  it("--dry-run starts nothing and exits 1 when it would not fit the disk", async () => {
    const h = harness(() => ({ data: { ...estimate, disk: { wouldExceed: true, maxBytes: 1e6, usedBytes: 0 } } }));
    const code = await downloadCommand(["NSE:NIFTY"], { interval: "1m", from: "2000-01-01", "dry-run": true }, h.io, h.helpers);
    expect(code).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.out.join("\n")).toMatch(/dry run: nothing was started/);
    expect(h.out.join("\n")).toMatch(/pass the disk limit/);
  });

  it("--watch follows the job until it ends and exits by how it ended", async () => {
    let n = 0;
    const h = harness((m, p) => {
      if (p.includes("dryRun")) return { data: estimate };
      if (m === "POST") return { data: job({ status: "queued" }) };
      n += 1;
      return { data: n < 3 ? job() : job({ status: n === 3 ? "done" : "failed", progress: { total: 2, done: 2, failed: 0, rows: 3000, bytes: 186_000, etaSec: null, current: null } }) };
    });
    const code = await downloadCommand(["NSE:NIFTY"], { interval: "5m", from: "2024-01-01", watch: true }, h.io, h.helpers);
    expect(code).toBe(0);
    expect(h.out.some((l) => /done {2}\| {2}2\/2 done/.test(l))).toBe(true);
  });

  it("asks for what is missing in plain words", async () => {
    const h = harness(() => ({ data: {} }));
    expect(await downloadCommand([], {}, h.io, h.helpers)).toBe(1);
    expect(h.err.join("\n")).toMatch(/at least one symbol/);
    const h2 = harness(() => ({ data: {} }));
    expect(await downloadCommand(["NSE:NIFTY"], {}, h2.io, h2.helpers)).toBe(1);
    expect(h2.err.join("\n")).toMatch(/--interval.*--from/);
    expect(h2.calls).toEqual([]);
  });

  it("list, show, pause, resume, cancel, delete", async () => {
    const h = harness((m, p) => (p === "/v1/downloads" || p.startsWith("/v1/downloads?") ? { data: [job()] } : m === "DELETE" ? {} : { data: job({ status: "paused" }) }));
    expect(await downloadCommand(["list"], { status: "running" }, h.io, h.helpers)).toBe(0);
    expect(h.calls[0].path).toBe("/v1/downloads?status=running");
    expect(await downloadCommand(["show", "dl_aaaaaaaaaaaa"], {}, h.io, h.helpers)).toBe(0);
    for (const c of ["pause", "resume", "cancel"]) expect(await downloadCommand([c, "dl_aaaaaaaaaaaa"], {}, h.io, h.helpers)).toBe(0);
    expect(await downloadCommand(["delete", "dl_aaaaaaaaaaaa"], {}, h.io, h.helpers)).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/downloads?status=running",
      "GET /v1/downloads/dl_aaaaaaaaaaaa",
      "POST /v1/downloads/dl_aaaaaaaaaaaa/pause",
      "POST /v1/downloads/dl_aaaaaaaaaaaa/resume",
      "POST /v1/downloads/dl_aaaaaaaaaaaa/cancel",
      "DELETE /v1/downloads/dl_aaaaaaaaaaaa",
    ]);
    await expect(downloadCommand(["pause"], {}, h.io, h.helpers)).rejects.toThrow(/needs a job id/);
  });

  it("files lists them, or saves them and checks every checksum", async () => {
    const bytes = Buffer.from("bytes of /v1/downloads/dl_aaaaaaaaaaaa/files/a.csv");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const h = harness(() => ({ data: [{ name: "a.csv", rows: 10, bytes: bytes.length, firstBar: "2024-01-01", lastBar: "2024-01-31", sha256: sha }] }));
    await downloadCommand(["files", "dl_aaaaaaaaaaaa"], {}, h.io, h.helpers);
    expect(h.out[0]).toMatch(/a\.csv {2}10 rows/);
    const dir = mkdtempSync(join(tmpdir(), "mcb-cli-"));
    await downloadCommand(["files", "dl_aaaaaaaaaaaa"], { out: dir }, h.io, h.helpers);
    expect(readFileSync(join(dir, "a.csv"))).toEqual(bytes);
    expect(h.out.join("\n")).toMatch(/checksum matches/);
    const bad = harness(() => ({ data: [{ name: "a.csv", rows: 1, bytes: 1, firstBar: null, lastBar: null, sha256: "0".repeat(64) }] }));
    await expect(downloadCommand(["files", "dl_aaaaaaaaaaaa"], { out: mkdtempSync(join(tmpdir(), "mcb-cli-")) }, bad.io, bad.helpers)).rejects.toThrow(/did not match its checksum/);
    // saving again into the same folder does not silently replace the files; --force does
    await expect(downloadCommand(["files", "dl_aaaaaaaaaaaa"], { out: dir }, h.io, h.helpers)).rejects.toThrow(/already exists.*--force/);
    await downloadCommand(["files", "dl_aaaaaaaaaaaa"], { out: dir, force: true }, h.io, h.helpers);
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("refuses a file name from the server that is a path, and saves nothing (audit S13)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-cli-"));
    for (const name of ["../escape.csv", "/etc/x", "a/b.csv", "..", "a\\b.csv", ""]) {
      const h = harness(() => ({ data: [{ name, rows: 1, bytes: 1, firstBar: null, lastBar: null, sha256: null }] }));
      await expect(downloadCommand(["files", "dl_aaaaaaaaaaaa"], { out: join(dir, "sub") }, h.io, h.helpers), JSON.stringify(name)).rejects.toThrow(/not a plain file name/);
    }
    expect(existsSync(join(dir, "escape.csv"))).toBe(false);
    expect(existsSync(join(dir, "sub", "escape.csv"))).toBe(false);
  });

  it("datasets and update", async () => {
    const h = harness((m) => (m === "GET" ? { data: [{ name: "nifty-5m", series: 1, rows: 100, bytes: 6200, dataClass: "realtime", gaps: 2, tags: ["idx"] }] } : { data: job({ status: "queued" }) }));
    await downloadCommand(["datasets"], {}, h.io, h.helpers);
    expect(h.out[0]).toMatch(/nifty-5m {2}1 file {2}100 rows.*realtime {2}2 gaps {2}\[idx\]/);
    await downloadCommand(["update", "nifty-5m"], {}, h.io, h.helpers);
    expect(h.calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/datasets/nifty-5m/update" });
    await expect(downloadCommand(["update"], {}, h.io, h.helpers)).rejects.toThrow(/dataset name/);
  });
});
