/**
 * `mc-bridge record ...` against a fake running Bridge on 127.0.0.1 (never the real network).
 */
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../core/cli.mjs";
import { recordingLine, showLines, sizeText } from "./cli.mjs";

let server;
const seen = [];
afterEach(async () => {
  seen.length = 0;
  if (server) await new Promise((r) => server.close(r));
  server = null;
});

const REC = {
  id: "rec_abcd1234", name: "Nifty ticks", kind: "quotes", status: "recording", statusText: "Recording 2 symbols every 1 s, last write 09:31:02 IST.", everySec: 1, sessionOnly: true, format: "csv", dataClass: "realtime",
  symbols: { count: 2, rule: null, notes: [] }, rows: 1234, bytes: 250_000, today: { rows: 600 }, lastWriteAt: "2026-11-09T09:31:02.000+05:30",
  gaps: { total: 1, today: 1, open: null, recent: [{ from: "2026-11-09T09:20:00.000+05:30", to: "2026-11-09T09:21:00.000+05:30", reason: "feed-down", seconds: 60 }] },
  refused: { total: 0, last: null }, apiCalls: { madeToday: 3, savedToday: 90 }, disk: { usedBytes: 250_000, limitMb: null, totalLimitMb: 5000 },
};
const RULE = { id: "index-option-chains", name: "Index option chains", enabled: true, kind: "chain", everySec: 30, statusText: "Waiting for the next session: 10 Nov 09:15 IST." };

async function bridge() {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, o) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(code === 204 ? "" : JSON.stringify(o));
      };
      const u = req.url;
      if (u === "/v1/health") return send(200, { ok: true });
      if (u === "/v1/recordings" && req.method === "POST") return send(201, { data: REC });
      if (u === "/v1/recordings") return send(200, { data: [REC], meta: { status: "Recording today: 1 manual recording, 2 symbols, 244 KB, last write 09:31:02." } });
      if (u === "/v1/recordings/status") return send(200, { data: { line: "Recording today: 1 manual recording.", disk: { usedBytes: 250_000, limitMb: 5000, freeBytes: 5e9 }, apiCalls: { made: 3, saved: 90 }, budgetShare: 0.3 } });
      if (u === "/v1/recordings/rec_abcd1234") return req.method === "DELETE" ? send(204) : send(200, { data: REC });
      if (/\/files$/.test(u)) return send(200, { data: [{ name: "2026-11-09__NSE_NIFTY.csv", rows: 600, bytes: 100_000 }] });
      if (/\/(pause|resume|stop)$/.test(u)) return send(200, { data: { ...REC, statusText: "Paused." } });
      if (u === "/v1/recordings/auto" && req.method === "PUT") return send(200, { data: { enabled: JSON.parse(body).enabled, rules: 1, activeRules: 1 } });
      if (u === "/v1/recordings/auto") return send(200, { data: { enabled: false, rules: 0, activeRules: 0 } });
      if (u === "/v1/recordings/rules" && req.method === "POST") return send(201, { data: RULE });
      if (u === "/v1/recordings/rules") return send(200, { data: [RULE] });
      if (u.startsWith("/v1/recordings/rules/")) return req.method === "DELETE" ? send(204) : send(200, { data: RULE });
      if (u === "/v1/recordings/presets") return send(200, { data: [{ id: "index-option-chains", title: "Record index option chains", about: "x", needs: "a login" }] });
      if (u.endsWith("/apply")) return send(201, { data: { created: true, rule: RULE, auto: { enabled: true } } });
      send(404, { code: "NOT_FOUND", detail: "no such route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

function setup() {
  const out = [];
  const err = [];
  const dir = mkdtempSync(join(tmpdir(), "mcb-cli-record-"));
  writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" } }));
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), env: { MCB_ADMIN_KEY: "mcb_adminkey00_x" }, cwd: dir } };
}
const posts = () => seen.filter((s) => s.method !== "GET" && s.url !== "/v1/health");

describe("mc-bridge record", () => {
  it("quotes: sends the symbols and the interval, says what it saves", async () => {
    const url = await bridge();
    const a = setup();
    expect(await runCli(["record", "quotes", "NSE:NIFTY", "NSE:RELIANCE"], { url, every: "1", name: "Nifty ticks", "keep-days": "30" }, a.io)).toBe(0);
    expect(posts()[0]).toMatchObject({ method: "POST", url: "/v1/recordings", auth: "Bearer mcb_adminkey00_x", body: { kind: "quotes", symbols: ["NSE:NIFTY", "NSE:RELIANCE"], everySec: 1, name: "Nifty ticks", keepDays: 30 } });
    expect(a.out.join("\n")).toMatch(/Started rec_abcd1234.*real-time data only, one file per symbol per trading day/s);
  });

  it("chain: an underlying, an expiry, strikes and --all-day", async () => {
    const url = await bridge();
    const a = setup();
    await runCli(["record", "chain", "nifty"], { url, every: "30", expiry: "2026-11-12", strikes: "5", "all-day": true }, a.io);
    expect(posts()[0].body).toEqual({ kind: "chain", underlying: "NIFTY", everySec: 30, expiry: "2026-11-12", strikes: 5, sessionOnly: false });
  });

  it("a missing --every or symbols is a plain message and nothing is sent", async () => {
    const url = await bridge();
    const a = setup();
    expect(await runCli(["record", "quotes", "NSE:NIFTY"], { url }, a.io)).toBe(1);
    expect(a.err.join("\n")).toMatch(/needs --every <seconds>/);
    const b = setup();
    expect(await runCli(["record", "chain"], { url, every: "30" }, b.io)).toBe(1);
    expect(b.err.join("\n")).toMatch(/chain needs an underlying/);
    const c = setup();
    expect(await runCli(["record", "chain", "NIFTY"], { url, every: "x" }, c.io)).toBe(1);
    expect(posts()).toEqual([]);
  });

  it("list, status, show, files, pause, resume, stop, delete", async () => {
    const url = await bridge();
    const a = setup();
    expect(await runCli(["record", "list"], { url }, a.io)).toBe(0);
    expect(a.out[0]).toContain("rec_abcd1234  recording quotes");
    expect(a.out[0]).toContain("Recording today: 1 manual recording");
    expect(await runCli(["record", "status"], { url }, a.io)).toBe(0);
    expect(a.out.join("\n")).toMatch(/API calls today: 3 made, 90 saved. Background share of the budget: 30 %/);
    expect(await runCli(["record", "show", "rec_abcd1234"], { url }, a.io)).toBe(0);
    expect(a.out.join("\n")).toMatch(/gaps: 1 in total.*feed-down \(60 s\)/s);
    expect(await runCli(["record", "files", "rec_abcd1234"], { url }, a.io)).toBe(0);
    for (const v of ["pause", "resume", "stop"]) expect(await runCli(["record", v, "rec_abcd1234"], { url }, a.io)).toBe(0);
    expect(await runCli(["record", "delete", "rec_abcd1234"], { url }, a.io)).toBe(0);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(expect.arrayContaining(["POST /v1/recordings/rec_abcd1234/pause", "POST /v1/recordings/rec_abcd1234/stop", "DELETE /v1/recordings/rec_abcd1234"]));
    expect(await runCli(["record", "show"], { url }, a.io)).toBe(1);
  });

  it("--json prints the data as it is", async () => {
    const url = await bridge();
    const a = setup();
    await runCli(["record", "show", "rec_abcd1234"], { url, json: true }, a.io);
    expect(JSON.parse(a.out[0]).id).toBe("rec_abcd1234");
  });

  it("auto on and off, rules, rule add (a chain rule with a universe and hours), on/off/remove, presets", async () => {
    const url = await bridge();
    const a = setup();
    await runCli(["record", "auto", "on"], { url }, a.io);
    expect(posts()[0]).toMatchObject({ method: "PUT", url: "/v1/recordings/auto", body: { enabled: true } });
    await runCli(["record", "auto"], { url }, a.io);
    expect(a.out.join("\n")).toMatch(/Auto-record is off/);
    await runCli(["record", "rule", "add", "chain", "NIFTY,BANKNIFTY"], { url, every: "30", strikes: "10", days: "mon,tue", start: "09:30", end: "15:00", name: "Chains" }, a.io);
    expect(posts().at(-1).body).toMatchObject({ name: "Chains", kind: "chain", underlying: ["NIFTY", "BANKNIFTY"], everySec: 30, universe: { expiries: "current-weekly", strikes: { around: "atm", count: 10 } }, schedule: { days: ["mon", "tue"], start: "09:30", end: "15:00" } });
    await runCli(["record", "rule", "off", "index-option-chains"], { url }, a.io);
    expect(posts().at(-1)).toMatchObject({ method: "PATCH", body: { enabled: false } });
    await runCli(["record", "rule", "remove", "index-option-chains"], { url, "delete-files": true }, a.io);
    expect(posts().at(-1)).toMatchObject({ method: "DELETE", url: "/v1/recordings/rules/index-option-chains?deleteFiles=true" });
    await runCli(["record", "rules"], { url }, a.io);
    expect(a.out.join("\n")).toMatch(/index-option-chains {2}on {3}chain/);
    await runCli(["record", "preset", "index-option-chains"], { url }, a.io);
    expect(posts().at(-1)).toMatchObject({ method: "POST", url: "/v1/recordings/presets/index-option-chains/apply" });
    expect(a.out.join("\n")).toMatch(/Added: Index option chains. Auto-record is on/);
  });

  it("formats sizes and lines in plain words", () => {
    expect(sizeText(900)).toBe("1 KB");
    expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(sizeText(50 * 1024 * 1024)).toBe("50 MB");
    expect(sizeText(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(recordingLine(REC)).toMatch(/^rec_abcd1234 {2}recording quotes every {3}1 s/);
    expect(showLines(REC)[1]).toMatch(/^ {2}Recording 2 symbols/);
  });
});
