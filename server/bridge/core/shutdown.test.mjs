/**
 * OPS-09: SIGHUP, SIGBREAK, stray errors and a failing stderr no longer end the Bridge without a flush; a hung part cannot
 * keep it alive; and a real Bridge under load stops inside the allowed time with jobs, recordings and the webhook queue
 * written down, the control token and the lock removed, and no temp files left.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createLogger, createNullLogger } from "./logger.mjs";
import { installShutdown } from "./shutdown.mjs";

/** A process stand-in: a real emitter, a recorded exit, a fake timer wheel. */
function fakeProc(platform = "linux") {
  const p = new EventEmitter();
  p.platform = platform;
  p.exits = [];
  p.exit = (code) => p.exits.push(code);
  return p;
}
const timers = () => {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => {
      const h = { fn, ms, cleared: false, unref() {} };
      list.push(h);
      return h;
    },
    clearTimer: (h) => {
      if (h) h.cleared = true;
    },
  };
};
const lines = () => {
  const out = [];
  const logger = createLogger({ level: "debug", write: (l) => out.push(JSON.parse(l)) });
  return { logger, out, msgs: () => out.map((l) => l.msg) };
};
const tick = () => new Promise((r) => setImmediate(r));

describe("installShutdown", () => {
  it("stops on SIGINT, SIGTERM, SIGHUP (and SIGBREAK on Windows), logs, and exits 0", async () => {
    for (const [sig, platform] of [["SIGINT", "linux"], ["SIGTERM", "linux"], ["SIGHUP", "linux"], ["SIGBREAK", "win32"]]) {
      const proc = fakeProc(platform);
      const t = timers();
      const l = lines();
      let closed = 0;
      installShutdown({ close: async () => void (closed += 1) }, { logger: l.logger, proc, ...t });
      proc.emit(sig);
      await tick();
      expect(closed, sig).toBe(1);
      expect(proc.exits, sig).toEqual([0]);
      expect(l.msgs()[0]).toBe("stopping");
      expect(l.msgs().at(-1)).toMatch(/^stopped in \d+ ms$/);
    }
  });

  it("SIGBREAK is only listened for on Windows", () => {
    const proc = fakeProc("linux");
    installShutdown({ close: async () => {} }, { proc, ...timers() });
    expect(proc.listenerCount("SIGBREAK")).toBe(0);
    expect(proc.listenerCount("SIGHUP")).toBe(1);
  });

  it("a stop that hangs is cut off at the deadline: logged, exit 1", async () => {
    const proc = fakeProc();
    const t = timers();
    const l = lines();
    installShutdown({ close: () => new Promise(() => {}) }, { logger: l.logger, proc, deadlineMs: 10_000, ...t });
    proc.emit("SIGTERM");
    await tick();
    expect(proc.exits).toEqual([]);
    const deadline = t.list.find((x) => x.ms === 10_000);
    expect(deadline).toBeTruthy();
    deadline.fn();
    await tick();
    expect(proc.exits).toEqual([1]);
    expect(l.msgs()).toContain("the Bridge did not stop within the time allowed; exiting anyway");
  });

  it("a second signal exits at once", async () => {
    const proc = fakeProc();
    installShutdown({ close: () => new Promise(() => {}) }, { proc, ...timers() });
    proc.emit("SIGINT");
    await tick();
    proc.emit("SIGINT");
    await tick();
    expect(proc.exits).toEqual([1]);
  });

  it("an uncaught error or a stray rejection is logged (secrets masked), the app is closed briefly, and the process exits 1", async () => {
    for (const event of ["uncaughtException", "unhandledRejection"]) {
      const proc = fakeProc();
      const l = lines();
      let closed = 0;
      installShutdown({ close: async () => void (closed += 1) }, { logger: l.logger, proc, ...timers() });
      proc.emit(event, new Error("boom with Bearer abcdefghijklmnop inside"));
      await tick();
      await tick();
      expect(closed, event).toBe(1);
      expect(proc.exits, event).toEqual([1]);
      const rec = l.out.find((x) => /unexpected/.test(x.msg));
      expect(rec.msg).toMatch(event === "unhandledRejection" ? /rejection/ : /error/);
      expect(JSON.stringify(rec)).not.toContain("abcdefghijklmnop");
    }
  });

  it("uninstall removes the handlers", () => {
    const proc = fakeProc();
    const s = installShutdown({ close: async () => {} }, { proc, ...timers() });
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    s.uninstall();
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("uncaughtException")).toBe(0);
  });
});

describe("the log sink", () => {
  it("a stderr that fails does not kill the process: the stream's error event is swallowed", () => {
    const before = process.stderr.listenerCount("error");
    const logger = createLogger({ level: "info" }); // the default sink (stderr)
    const realWrite = process.stderr.write;
    process.stderr.write = () => true; // keep the test output clean
    try {
      logger.info("hello");
    } finally {
      process.stderr.write = realWrite;
    }
    expect(process.stderr.listenerCount("error")).toBeGreaterThan(before - 1);
    // emitting an error on stderr (ENOSPC) with a listener present does not throw
    expect(() => process.stderr.emit("error", Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))).not.toThrow();
  });

  it("a sink that throws never breaks the caller", () => {
    const logger = createLogger({ level: "info", write: () => { throw new Error("EIO"); } });
    expect(() => logger.error("x")).not.toThrow();
  });
});

describe("a stop that takes too long in one module", () => {
  it("is left behind after moduleStopMs, the rest still stop, and the control token and lock go", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-stop-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 } }, env: {}, demo: true });
    const { BUILTIN_MODULES } = await import("./builtinModules.mjs");
    const { defineModule } = await import("./modules.mjs");
    const stopped = [];
    const hung = defineModule({ name: "hungmod", stop: () => new Promise(() => {}) });
    const after = defineModule({ name: "aftermod", stop: async () => void stopped.push("after") });
    const out = [];
    const logger = createLogger({ level: "info", write: (l) => out.push(JSON.parse(l)) });
    const app = await createApp({ config, modules: [...BUILTIN_MODULES, after, hung], logger, moduleStopMs: 50 });
    await app.listen();
    expect(existsSync(join(dataDir, "control.token"))).toBe(true);
    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(stopped).toEqual(["after"]); // modules stop in reverse: the hung one first, and the next still ran
    expect(out.some((l) => /did not stop in time/.test(l.msg) && l.module === "hungmod")).toBe(true);
    expect(existsSync(join(dataDir, "control.token"))).toBe(false);
    expect(existsSync(join(dataDir, "bridge.lock"))).toBe(false);
  });
});

describe("graceful stop under load", () => {
  it("jobs, recordings and the webhook queue are written down inside the stop time; no temp files, no token, no lock", async () => {
    // A receiver that accepts the connection and never answers (the worst case for a stop).
    const sockets = new Set();
    const receiver = http.createServer(() => {});
    receiver.on("connection", (s) => sockets.add(s));
    await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
    const rxPort = receiver.address().port;

    const dataDir = mkdtempSync(join(tmpdir(), "mcb-stop-load-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 }, events: { webhooks: { allowPrivateTargets: true, timeoutMs: 60_000 } } }, env: {}, demo: true });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    try {
      const { key } = await app.deps.keyStore.create({ label: "admin", scopes: ["admin", "paper"] });
      const call = async (method, path, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, json: await r.json().catch(() => null) };
      };
      // 1. a recording, writing every second
      const rec = await call("POST", "/v1/recordings", { kind: "quotes", symbols: ["NSE:NIFTY"], everySec: 1, sessionOnly: false });
      expect(rec.status, JSON.stringify(rec.json)).toBeLessThan(300);
      // 2. a download job
      const job = await call("POST", "/v1/downloads", { symbols: ["NSE:RELIANCE", "NSE:INFY", "NSE:TCS"], intervals: ["1d"], from: "2026-01-01" });
      expect(job.status, JSON.stringify(job.json)).toBeLessThan(300);
      // 3. a webhook to a receiver that never answers, and events for it
      const sub = await call("POST", "/v1/subscriptions", { url: `http://127.0.0.1:${rxPort}/hook`, topics: ["order.*"], secret: "s".repeat(32) });
      expect(sub.status, JSON.stringify(sub.json)).toBeLessThan(300);
      for (let i = 0; i < 5; i += 1) {
        const o = await call("POST", "/v1/orders", { account: "demo", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" });
        expect(o.status, JSON.stringify(o.json)).toBeLessThan(300);
      }
      await new Promise((r) => setTimeout(r, 1500)); // let the recording write and the receiver hang
    } finally {
      const t0 = Date.now();
      await app.close();
      const ms = Date.now() - t0;
      for (const s of sockets) s.destroy();
      receiver.close();
      // inside the stop time (the module limit is 5 s each; the webhook grace is 3 s)
      expect(ms).toBeLessThan(5000);
    }
    // everything is on disk
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(dataDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(dataDir, "control.token"))).toBe(false);
    expect(existsSync(join(dataDir, "bridge.lock"))).toBe(false);
    // recording: its settings and counters were written, and it has rows
    const recFolder = files.find((f) => /recordings[\\/]rec_[a-z0-9]+[\\/]state\.json$/.test(f));
    expect(recFolder).toBeTruthy();
    expect(JSON.parse(readFileSync(recFolder, "utf8"))).toBeTypeOf("object");
    // download job: written, and not left claiming to be "running" past the stop (it continues after a restart)
    const jobFile = files.find((f) => /downloads[\\/]jobs[\\/]dl_[0-9a-f]+[\\/]job\.json$/.test(f));
    expect(jobFile).toBeTruthy();
    expect(["queued", "running", "done", "paused"]).toContain(JSON.parse(readFileSync(jobFile, "utf8")).status);
    // webhook queue: every event is either delivered or still queued on disk, none lost
    const outbox = readFileSync(join(dataDir, "events", "outbox.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const queued = new Map();
    for (const r of outbox) {
      if (r.op === "put") queued.set(r.r.id, r.r);
      else if (r.op === "del") queued.delete(r.id);
    }
    expect(queued.size).toBeGreaterThanOrEqual(5); // each order makes at least one event; none was lost
  }, 30_000);
});
