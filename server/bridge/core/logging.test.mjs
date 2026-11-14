/**
 * OPS-10: a log file with rotation, request lines only for errors and slow requests by default, and one summary line a
 * minute for a webhook that keeps failing (4,459 failed deliveries used to leave no line at all).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { createLogFile } from "./logFile.mjs";
import { SECRET, URL_OK, bootWebhooks, createClock } from "../events/testkit.mjs";

describe("the log file", () => {
  it("appends lines, rotates by size into compressed files, keeps at most `keep` old ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-log-"));
    const f = createLogFile({ dir, maxBytes: 200, keep: 2 });
    for (let i = 0; i < 40; i++) f.write(JSON.stringify({ n: i, pad: "x".repeat(20) }));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["bridge.log", "bridge.log.1.gz", "bridge.log.2.gz"]); // never a .3
    // the newest old file is a valid gzip of whole lines, and the numbering runs newest first
    const first = gunzipSync(readFileSync(join(dir, "bridge.log.1.gz"))).toString().trim().split("\n").map((l) => JSON.parse(l).n);
    const second = gunzipSync(readFileSync(join(dir, "bridge.log.2.gz"))).toString().trim().split("\n").map((l) => JSON.parse(l).n);
    const current = readFileSync(join(dir, "bridge.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l).n);
    expect(Math.min(...first)).toBeGreaterThan(Math.max(...second));
    expect(Math.min(...current)).toBeGreaterThan(Math.max(...first));
    expect(current.at(-1)).toBe(39);
    expect(statLen(join(dir, "bridge.log"))).toBeLessThanOrEqual(400);
  });

  it("carries on after a restart (it continues the file) and never throws when the folder cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-log-"));
    createLogFile({ dir }).write("one");
    createLogFile({ dir }).write("two");
    expect(readFileSync(join(dir, "bridge.log"), "utf8")).toBe("one\ntwo\n");
    rmSync(dir, { recursive: true, force: true });
    // the folder is gone and a plain file takes its place: every write fails, none throws
    const blocked = join(tmpdir(), `mcb-log-blocked-${process.pid}`);
    require_fs().writeFileSync(blocked, "x");
    const f = createLogFile({ dir: join(blocked, "logs") });
    const realWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      expect(() => f.write("lost")).not.toThrow();
      expect(() => f.write("lost again")).not.toThrow();
    } finally {
      process.stderr.write = realWrite;
      rmSync(blocked, { force: true });
    }
  });
});
const statLen = (p) => readFileSync(p).length;
function require_fs() {
  return globalThis.process.getBuiltinModule("node:fs");
}

describe("access lines", () => {
  async function run(logging) {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-reqlog-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 }, ...(logging ? { logging } : {}) }, env: {}, demo: true });
    const out = [];
    const logger = createLogger({ level: "info", write: (l) => out.push(JSON.parse(l)) });
    const app = await createApp({ config, logger });
    const { port } = await app.listen();
    try {
      app.router.add("GET", "/v1/test-slow", async () => {
        await new Promise((r) => setTimeout(r, 1100));
        return { ok: true };
      }, { auth: "none" }, "core");
      await fetch(`http://127.0.0.1:${port}/v1/health`); // 200, fast
      await fetch(`http://127.0.0.1:${port}/v1/ready`); // 200, fast
      await fetch(`http://127.0.0.1:${port}/v1/nothing-here`); // 404
      await fetch(`http://127.0.0.1:${port}/v1/test-slow`); // 200 but slow
    } finally {
      await app.close();
    }
    return out.filter((l) => l.msg === "http").map((l) => `${l.status}${l.ms >= 1000 ? " slow" : ""} ${l.path}`);
  }

  it("by default: only errors and slow requests are logged", async () => {
    expect(await run()).toEqual(["404 /v1/nothing-here", "200 slow /v1/test-slow"]);
  }, 20_000);

  it("requests: all logs every one, requests: off logs none", async () => {
    expect((await run({ requests: "all" })).length).toBe(4);
    expect(await run({ requests: "off" })).toEqual([]);
  }, 30_000);

  it("the settings are checked", () => {
    expect(() => loadConfig({ raw: { logging: { requests: "sometimes" } }, env: {} })).toThrow();
    expect(loadConfig({ raw: {}, env: {} }).config.logging).toMatchObject({ requests: "errors", maxFileMb: 10, keepFiles: 5 });
  });
});

describe("a webhook that keeps failing", () => {
  it("is reported on the first failure and then once a minute with the count, and recovery is reported too", async () => {
    const clock = createClock();
    const b = bootWebhooks({ clock, config: { webhooks: { retry: { baseMs: 100, maxMs: 1000, jitter: 0, maxAttempts: 50 }, breakerAfter: 20 } } });
    const s = await b.svc.create({ url: URL_OK, topics: ["order.*"], secret: SECRET });
    b.receiver.always({ status: 500 });
    for (let i = 1; i <= 10; i += 1) b.eventLog.record("order.updated", { orderId: `o${i}`, accountId: "paper", status: "filled" });
    await b.svc.pump();
    const lines = () => b.logLines.map((l) => JSON.parse(l)).filter((l) => /webhook subscription/.test(l.msg));
    expect(lines()).toHaveLength(1); // ten failures, one line
    expect(lines()[0]).toMatchObject({ level: "warn", subscriptionId: s.id, failures: 1, code: "http_5xx" });
    clock.advance(61_000);
    b.eventLog.record("order.updated", { orderId: "o11", accountId: "paper", status: "filled" });
    await b.svc.pump();
    const second = lines()[1];
    expect(second.msg).toMatch(/failed \d+ times in the last minute: http_5xx/);
    b.receiver.always({ status: 200 });
    clock.advance(10 * 60_000);
    await b.svc.pump();
    expect(lines().at(-1).msg).toMatch(/is delivering again/);
  });
});
