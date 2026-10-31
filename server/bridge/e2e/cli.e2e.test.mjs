/**
 * Process-level end to end: the real `mc-bridge` binary. `start` boots the full service on 127.0.0.1 in paper mode,
 * `keys create` (a second process) mints a key the running server accepts at once, and `mcp` relays MCP over stdio
 * to the running server, as Claude Desktop or Claude Code would run it. No broker accounts are configured.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = resolve(import.meta.dirname, "../../../bin/mc-bridge.mjs");

const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

let cwd;
let port;
let server;
let env;

const run = (args, { input, timeoutMs = 20_000 } = {}) =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      rej(new Error(`mc-bridge ${args.join(" ")} timed out; stderr: ${err}`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      res({ code, out, err });
    });
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "mcb-cli-e2e-"));
  port = await freePort();
  writeFileSync(join(cwd, "bridge.config.json"), JSON.stringify({ server: { port }, dataDir: "data", logging: { level: "warn" }, accounts: [{ id: "paper", broker: "paper" }] }));
  env = { ...process.env, MCB_CONFIG: "", MCB_API_KEY: "" };
  delete env.MCB_CONFIG;
  delete env.MCB_API_KEY;
  server = spawn(process.execPath, [BIN, "start"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    let err = "";
    const timer = setTimeout(() => rej(new Error(`mc-bridge start did not come up: ${err}`)), 20_000);
    server.stderr.on("data", (d) => {
      err += d;
      if (/listening on http:\/\/127\.0\.0\.1:\d+/.test(err)) {
        clearTimeout(timer);
        res();
      }
    });
    server.once("exit", (code) => rej(new Error(`mc-bridge start exited with ${code}: ${err}`)));
  });
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
});

describe("mc-bridge binary", () => {
  it("start: serves /v1/health on 127.0.0.1 with every service ready and live trading off", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    expect(r.status).toBe(200);
    const h = await r.json();
    expect(h.status).toBe("ok");
    expect(Object.values(h.services).every((s) => s === "ready")).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/dashboard`)).status).toBe(200);
  });

  it("keys create in another process works against the running server; mcp relays over stdio", async () => {
    const created = await run(["keys", "create", "--label", "claude", "--scope", "read", "--client", "mcp"]);
    expect(created.code).toBe(0);
    const key = /(mcb_[a-z2-7]{10}_[A-Za-z0-9_-]+)/.exec(created.out)?.[1];
    expect(key).toBeTruthy();
    const accounts = await fetch(`http://127.0.0.1:${port}/v1/accounts`, { headers: { Authorization: `Bearer ${key}` } });
    expect(accounts.status).toBe(200);

    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-e2e", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const mcp = await run(["mcp", "--key", key], { input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
    expect(mcp.code).toBe(0);
    const replies = mcp.out.trim().split("\n").map((l) => JSON.parse(l));
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    expect(byId[1].result.serverInfo).toBeTruthy();
    expect(byId[2].result.tools.length).toBeGreaterThan(3);
    expect(mcp.out).not.toContain(key);
    expect(mcp.err).not.toContain(key);
  });

  it("doctor passes with all services built", async () => {
    const d = await run(["doctor", "--no-port-check", "--json"]);
    expect(d.code).toBe(0);
    const checks = JSON.parse(d.out);
    expect(checks.find((c) => c.check === "services").level).toBe("ok");
    expect(checks.find((c) => c.check === "live-trading").message).toMatch(/off/);
  });
});
