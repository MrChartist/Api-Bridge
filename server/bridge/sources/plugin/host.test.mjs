/**
 * The plugin host against a fake child process: no real process, no network. Covers the protocol, hostile children,
 * timeouts and cancellation, crash and restart limits, the clean environment and the permission flags.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTART_WINDOW_MS, RUNNER_PATH, buildNodeArgs, cleanEnv, createPluginHost, permissionFlagFor, runAsProblem } from "./host.mjs";
import { parseManifest } from "./manifest.mjs";
import { createFetchBroker } from "./netbroker.mjs";
import { MAX_MESSAGE_BYTES } from "./protocol.mjs";
import { fakeSpawn, goodQuotes, testManifest } from "./__fixtures__/fakeChild.mjs";

const NOW = Date.parse("2026-10-19T10:00:00+05:30");
const AT = NOW - 900_000;
const answer = (msg, c) => msg.type === "call" && c.say({ type: "result", id: msg.id, data: goodQuotes(AT) });

const hosts = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((h) => h.stop().catch(() => {})));
});

function setup({ manifest = {}, spawn = {}, host = {}, answerCalls = true } = {}) {
  const state = { now: NOW };
  const fs = fakeSpawn({ onMessage: answerCalls ? answer : undefined, ...spawn });
  const logs = [];
  const logger = Object.fromEntries(["debug", "info", "warn"].map((l) => [l, (msg) => logs.push([l, msg])]));
  const m = parseManifest(testManifest(manifest));
  if (!m.ok) throw new Error(m.errors.join("; "));
  const h = createPluginHost({
    manifest: m.manifest,
    pluginDir: "/plugins/fake",
    entryPath: "/plugins/fake/index.mjs",
    entrySha: "ab".repeat(32),
    spawnImpl: fs.spawnImpl,
    clock: () => state.now,
    logger,
    cancelGraceMs: 20,
    stopGraceMs: 20,
    readyTimeoutMs: 200,
    ...host,
  });
  hosts.push(h);
  return { h, fs, logs, state };
}

const rejection = async (p) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("normal operation", () => {
  it("starts the child on the first call, does the handshake and returns a validated answer", async () => {
    const { h, fs } = setup();
    const r = await h.call("quotes", { symbols: ["NSE:RELIANCE"] });
    expect(r.items[0]).toMatchObject({ symbol: "NSE:RELIANCE", at: AT });
    const c = fs.last();
    expect(c.received.map((m) => m.type)).toEqual(["hello", "init", "call"]);
    expect(c.received[0]).toMatchObject({ protocol: "bridge-source/1", apiVersion: 1 });
    expect(c.received[2]).toMatchObject({ method: "quotes", params: { symbols: ["NSE:RELIANCE"] }, deadlineMs: 200, now: NOW });
    expect(h.status()).toMatchObject({ state: "ready", running: true });
  });

  it("does not start the process until it is needed, and reuses it", async () => {
    const { h, fs } = setup();
    expect(fs.calls).toHaveLength(0);
    expect(h.status().state).toBe("idle");
    await h.call("quotes", {});
    await h.call("quotes", {});
    expect(fs.calls).toHaveLength(1);
  });

  it("refuses a method the manifest did not declare, without starting anything", async () => {
    const { h, fs } = setup();
    expect((await rejection(h.call("history", {}))).code).toBe("CAPABILITY_UNSUPPORTED");
    expect((await rejection(h.call("placeOrder", {}))).code).toBe("CAPABILITY_UNSUPPORTED");
    expect(fs.calls).toHaveLength(0);
  });

  it("delivers the owner's config in init", async () => {
    const { h, fs } = setup({ host: { config: { region: "in" } } });
    await h.call("quotes", {});
    expect(fs.last().of("init")[0]).toEqual({ type: "init", config: { region: "in" }, secrets: {} });
  });

  it("sends test calls even though test is not a capability", async () => {
    const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say({ type: "result", id: m.id, data: { ok: true } }) } });
    expect(await h.call("test", {})).toEqual({ ok: true });
  });
});

describe("error mapping", () => {
  const run = async (reply) => {
    const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say({ type: "error", id: m.id, ...reply }) } });
    return rejection(h.call("quotes", {}));
  };

  it.each([
    ["RATE_LIMITED", "UPSTREAM_RATE_LIMITED"],
    ["UNAVAILABLE", "BROKER_UNAVAILABLE"],
    ["TIMEOUT", "UPSTREAM_TIMEOUT"],
    ["BAD_RESPONSE", "UPSTREAM_ERROR"],
    ["NOT_FOUND", "SYMBOL_NOT_FOUND"],
    ["UNSUPPORTED", "CAPABILITY_UNSUPPORTED"],
    ["AUTH", "UPSTREAM_ERROR"],
    ["INTERNAL", "UPSTREAM_ERROR"],
  ])("%s becomes %s", async (code, bridge) => {
    const err = await run({ code, message: "m" });
    expect(err.code).toBe(bridge);
    expect(err.broker).toEqual({ id: "fake-plugin", code });
  });

  it("passes retryAfterMs through and maps unknown codes to UPSTREAM_ERROR", async () => {
    expect((await run({ code: "RATE_LIMITED", message: "slow", retryAfterMs: 2500 })).retryAfterMs).toBe(2500);
    const unknown = await run({ code: "EXPLODED", message: "m" });
    expect(unknown.code).toBe("UPSTREAM_ERROR");
    expect(unknown.broker.code).toBe("BAD_RESPONSE");
  });

  it("a CANCELLED answer to a live call is an abort, not a failure", async () => {
    expect((await run({ code: "CANCELLED" })).name).toBe("AbortError");
  });

  it("an answer that does not fit the contract is UPSTREAM_ERROR and does not kill the process", async () => {
    const { h, fs } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say({ type: "result", id: m.id, data: { items: [{ symbol: "X", at: AT, fields: { ltp: -5 } }] } }) } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.detail).toMatch(/does not fit the contract/);
    expect(fs.last().killed).toEqual([]);
  });

  it("rejects a quote stamped in the future", async () => {
    const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say({ type: "result", id: m.id, data: goodQuotes(NOW + 3_600_000) }) } });
    expect((await rejection(h.call("quotes", {}))).code).toBe("UPSTREAM_ERROR");
  });
});

describe("the process: clean environment, working directory, permission flags", () => {
  it("starts the child with an EMPTY environment, the plugin folder as cwd and no shell", async () => {
    process.env.MCB_MASTER_KEY = "canary-master-key";
    process.env.AWS_SECRET_ACCESS_KEY = "canary-aws";
    try {
      const { h, fs } = setup();
      await h.call("quotes", {});
      const { cmd, args, options } = fs.calls[0];
      expect(cmd).toBe(process.execPath);
      expect(options.env).toEqual({});
      expect(options.cwd).toBe("/plugins/fake");
      expect(options.shell).toBe(false);
      expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect(JSON.stringify([args, options])).not.toMatch(/canary/);
    } finally {
      delete process.env.MCB_MASTER_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("assembles the permission flags: file reads limited to the entry file and the runner (never the folder), nothing else allowed", () => {
    const args = buildNodeArgs({ pluginDir: "/plugins/fake", entryPath: "/plugins/fake/index.mjs", entrySha: "ab".repeat(32), nodeVersion: "22.23.4" });
    expect(args).toEqual([
      "--permission",
      "--allow-fs-read=/plugins/fake/index.mjs",
      `--allow-fs-read=${RUNNER_PATH}`,
      "--max-old-space-size=128",
      "--disallow-code-generation-from-strings",
      "--no-experimental-fetch",
      "--no-experimental-websocket",
      RUNNER_PATH,
      "/plugins/fake/index.mjs",
      "ab".repeat(32),
    ]);
    const text = args.join(" ");
    for (const forbidden of ["--allow-child-process", "--allow-worker", "--allow-addons", "--allow-wasi", "--allow-fs-write", "--allow-net"]) expect(text).not.toContain(forbidden);
    expect(args.filter((a) => a.startsWith("--allow-fs-read="))).toHaveLength(2);
    expect(args).not.toContain("--allow-fs-read=/plugins/fake"); // the folder itself is not granted
    expect(args.indexOf("--permission")).toBe(0); // before the script, or Node would pass it to the script
    expect(args.indexOf("--permission")).toBeLessThan(args.indexOf(RUNNER_PATH));
  });

  it("picks the permission flag this Node version understands", () => {
    expect(permissionFlagFor("22.13.0")).toBe("--permission");
    expect(permissionFlagFor("22.23.4")).toBe("--permission");
    expect(permissionFlagFor("24.1.0")).toBe("--permission");
    expect(permissionFlagFor("22.12.0")).toBe("--experimental-permission");
    expect(permissionFlagFor("20.11.0")).toBe("--experimental-permission");
    expect(permissionFlagFor("18.19.0")).toBeNull();
    expect(buildNodeArgs({ pluginDir: "/p", entryPath: "/p/i.mjs", entrySha: "x", nodeVersion: "18.0.0" })).not.toContain("--permission");
  });

  it("the runner is the file that was started, and the host passes the pinned hash for it to re-check", async () => {
    const { h, fs } = setup();
    await h.call("quotes", {});
    expect(fs.calls[0].args.slice(-3)).toEqual([RUNNER_PATH, "/plugins/fake/index.mjs", "ab".repeat(32)]);
  });

  it("cleanEnv is empty everywhere except what Node needs on Windows", () => {
    expect(cleanEnv("linux", { PATH: "/bin", SECRET: "x", SystemRoot: "C:\\Windows" })).toEqual({});
    expect(cleanEnv("darwin", { HOME: "/h" })).toEqual({});
    expect(cleanEnv("win32", { PATH: "x", SECRET: "x", SystemRoot: "C:\\Windows" })).toEqual({ SystemRoot: "C:\\Windows" });
    expect(cleanEnv("win32", { PATH: "x" })).toEqual({});
  });
});

describe("secrets", () => {
  const withKey = { manifest: { secrets: ["apiKey"] } };

  it("reach the child once, in init, and in no other message, argv or environment", async () => {
    const { h, fs } = setup({ ...withKey, host: { readSecret: () => "canary-secret-value" } });
    await h.call("quotes", { symbols: ["A"] });
    const c = fs.last();
    expect(c.of("init")[0].secrets).toEqual({ apiKey: "canary-secret-value" });
    expect(JSON.stringify(c.received.filter((m) => m.type !== "init"))).not.toContain("canary");
    expect(JSON.stringify([fs.calls[0].args, fs.calls[0].options])).not.toContain("canary");
  });

  it("are redacted from the plugin's logs, stderr and error messages", async () => {
    const { h, fs, logs } = setup({
      ...withKey,
      host: { readSecret: () => "canary-secret-value" },
      spawn: { onMessage: (m, c) => m.type === "call" && (c.say({ type: "log", level: "info", msg: "got key canary-secret-value" }), c.stderr.write("oops canary-secret-value\n"), c.say({ type: "error", id: m.id, code: "AUTH", message: "bad key canary-secret-value" })) },
    });
    const err = await rejection(h.call("quotes", {}));
    await tick();
    expect(err.detail).not.toContain("canary");
    expect(err.detail).toContain("[redacted]");
    expect(JSON.stringify(logs)).not.toContain("canary");
    expect(fs.calls).toHaveLength(1);
  });

  it("without a stored key the plugin is not started and the message says how to set one", async () => {
    const { h, fs } = setup({ ...withKey, host: { readSecret: () => undefined } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(err.detail).toMatch(/mc-bridge sources set-key fake-plugin/);
    expect(fs.calls).toHaveLength(0);
  });
});

describe("handshake problems", () => {
  it("a child that never says ready is killed after the ready timeout", async () => {
    const { h, fs } = setup({ spawn: { autoReady: false } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(fs.last().killed).toContain("SIGKILL");
    expect(h.status().lastError).toMatch(/ready in time/);
  });

  it("a plugin that does not implement what its manifest declares is disabled, not restarted", async () => {
    const { h, fs } = setup({ spawn: { capabilities: [] } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(h.status()).toMatchObject({ state: "disabled" });
    expect(h.status().reason).toMatch(/does not implement.*quotes/);
    expect((await rejection(h.call("quotes", {}))).detail).toMatch(/disabled/);
    expect(fs.calls).toHaveLength(1);
  });

  it("a plugin speaking another apiVersion is disabled", async () => {
    const { h } = setup({ spawn: { apiVersion: 2 } });
    await rejection(h.call("quotes", {}));
    expect(h.status()).toMatchObject({ state: "disabled" });
    expect(h.status().reason).toMatch(/apiVersion 2/);
  });

  it("exit code 3 (the entry did not load or does not match its pin) disables at once", async () => {
    const { h, fs } = setup({
      spawn: {
        autoReady: false,
        onMessage: (m, c) => m.type === "hello" && (c.say({ type: "log", level: "error", msg: "could not load the plugin: the entry file does not match its pinned sha256" }), setTimeout(() => c.exit(3), 5)),
      },
    });
    await rejection(h.call("quotes", {}));
    expect(h.status().state).toBe("disabled");
    expect(h.status().reason).toMatch(/does not match its pinned sha256/);
    expect(fs.calls).toHaveLength(1);
  });

  it("a missing node binary (spawn error) counts as a crash", async () => {
    const { h, fs } = setup({ spawn: { autoReady: false, onMessage: (m, c) => m.type === "hello" && c.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })) } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(h.status().lastError).toMatch(/ENOENT/);
    expect(fs.calls).toHaveLength(1);
  });
});

describe("a hostile child", () => {
  const hostile = async (action, { expectKilled = true } = {}) => {
    const { h, fs, state } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && action(m, c) } });
    const err = await rejection(h.call("quotes", {}));
    await tick();
    if (expectKilled) expect(fs.last().killed).toContain("SIGKILL");
    return { err, h, fs, state };
  };

  it("an oversized message kills it", async () => {
    const { err, h } = await hostile((m, c) => c.say(`${JSON.stringify({ type: "result", id: m.id, data: "x".repeat(MAX_MESSAGE_BYTES + 10) })}\n`));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(h.status().lastError).toMatch(/too large/);
  });

  it("a line that never ends kills it before it can fill memory", async () => {
    const { h } = await hostile((m, c) => {
      for (let i = 0; i < 6; i += 1) c.say("x".repeat(MAX_MESSAGE_BYTES / 2));
    });
    expect(h.status().lastError).toMatch(/too large/);
  });

  it("invalid JSON kills it", async () => {
    const { h } = await hostile((m, c) => c.say("{this is not json\n"));
    expect(h.status().lastError).toMatch(/not valid JSON/);
  });

  it("console output on stdout (a non-protocol line) kills it", async () => {
    const { h } = await hostile((m, c) => c.say("hello from console.log\n"));
    expect(h.status().lastError).toMatch(/protocol violation/);
  });

  it("an unknown message type, a missing field or an extra field kills it", async () => {
    for (const bad of [{ type: "exec", cmd: "id" }, { type: "result", data: {} }, { type: "result", id: 1, data: {}, extra: 1 }, { type: "fetch", id: 1, url: "https://x", init: { agent: "evil" } }]) {
      const { h } = await hostile((m, c) => c.say(bad));
      expect(h.status().lastError).toMatch(/protocol violation/);
    }
  });

  it("a flood of messages kills it", async () => {
    const { h } = await hostile((m, c) => c.say(Array.from({ length: 800 }, () => JSON.stringify({ type: "log", level: "info", msg: "spam" })).join("\n") + "\n"));
    expect(h.status().lastError).toMatch(/flood/);
  });

  it("logs from a chatty child are rate-limited, not stored without bound", async () => {
    const { h, logs } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && (c.say(Array.from({ length: 200 }, () => JSON.stringify({ type: "log", level: "info", msg: "line" })).join("\n") + "\n"), answer(m, c)) } });
    await h.call("quotes", {});
    expect(logs.filter(([, msg]) => /line$/.test(msg)).length).toBeLessThanOrEqual(20);
  });

  it("endless stderr is logged only up to a cap", async () => {
    const { h, fs, logs } = setup();
    await h.call("quotes", {});
    for (let i = 0; i < 40; i += 1) fs.last().stderr.write("e".repeat(4096));
    await tick();
    const stderrLogs = logs.filter(([, msg]) => msg.includes("stderr"));
    expect(stderrLogs.length).toBeLessThan(25);
    expect(stderrLogs.at(-1)[1]).toMatch(/dropped/);
  });

  it("answers to calls that were never made are ignored, until there are too many", async () => {
    const { h, fs } = setup();
    await h.call("quotes", {});
    const c = fs.last();
    for (let i = 0; i < 10; i += 1) c.say({ type: "result", id: 9999 + i, data: {} });
    await tick();
    expect(c.killed).toEqual([]);
    for (let i = 0; i < 60; i += 1) c.say({ type: "result", id: 9999 + i, data: {} });
    await tick();
    expect(c.killed).toContain("SIGKILL");
  });

  it("an answer for another call's id cannot satisfy this call", async () => {
    const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say({ type: "result", id: m.id + 1, data: goodQuotes(AT) }) } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("a child that never answers gets UPSTREAM_TIMEOUT at the call timeout, is sent a cancel, and is killed after two ignored cancels", async () => {
    const { h, fs } = setup({ spawn: { onMessage: () => {} } });
    const t0 = Date.now();
    const first = await rejection(h.call("quotes", {}));
    expect(first.code).toBe("UPSTREAM_TIMEOUT");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fs.last().of("cancel")).toHaveLength(1);
    await tick(40); // the grace passes without an acknowledgement
    expect(fs.last().killed).toEqual([]);
    const second = await rejection(h.call("quotes", {}));
    expect(second.code).toBe("UPSTREAM_TIMEOUT");
    await tick(40);
    expect(fs.children[0].killed).toContain("SIGKILL");
    expect(h.status().lastError).toMatch(/ignored two cancellations/);
  });

  it("an answer that arrives after the timeout is dropped and does not disturb the next call", async () => {
    let held;
    let n = 0;
    const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && (++n === 1 ? (held = [m, c]) : answer(m, c)) } });
    expect((await rejection(h.call("quotes", {}))).code).toBe("UPSTREAM_TIMEOUT");
    held[1].say({ type: "result", id: held[0].id, data: goodQuotes(AT, "NSE:LATE") }); // late, treated as the cancel acknowledgement
    await tick();
    const r = await h.call("quotes", {});
    expect(r.items[0].symbol).toBe("NSE:RELIANCE");
  });

  it("an answer after the caller aborted is dropped; the cancel is acknowledged", async () => {
    let held;
    const { h, fs } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && (held = [m, c]) } });
    const ac = new AbortController();
    const p = rejection(h.call("quotes", {}, { signal: ac.signal }));
    await tick();
    ac.abort();
    expect((await p).name).toBe("AbortError");
    expect(fs.last().of("cancel")).toEqual([{ type: "cancel", id: held[0].id }]);
    held[1].say({ type: "error", id: held[0].id, code: "CANCELLED" });
    held[1].say({ type: "result", id: held[0].id, data: goodQuotes(AT) });
    await tick(40);
    expect(fs.last().killed).toEqual([]);
  });

  it("an already-aborted signal never reaches the child", async () => {
    const { h, fs } = setup();
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(h.call("quotes", {}, { signal: ac.signal }))).name).toBe("AbortError");
    expect(fs.calls).toHaveLength(0);
  });

  it("hostile keys inside an answer cannot pollute prototypes", async () => {
    const { h } = setup({
      spawn: { onMessage: (m, c) => m.type === "call" && c.say(`{"type":"result","id":${m.id},"data":{"__proto__":{"polluted":1},"items":[{"symbol":"NSE:X","at":${AT},"fields":{"ltp":5,"__proto__":{"polluted":2},"constructor":{"x":1}}}]}}\n`) },
    });
    const r = await h.call("quotes", {});
    expect({}.polluted).toBeUndefined();
    expect(r.items[0].fields.polluted).toBeUndefined();
    expect(Object.keys(r.items[0].fields)).not.toContain("constructor");
  });

  it("NaN, Infinity, string numbers and negative prices are rejected", async () => {
    for (const ltp of ['"NaN"', '"Infinity"', '"100"', "-1", "0", "null"]) {
      const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say(`{"type":"result","id":${m.id},"data":{"items":[{"symbol":"NSE:X","at":${AT},"fields":{"ltp":${ltp}}}]}}\n`) } });
      expect((await rejection(h.call("quotes", {}))).code).toBe("UPSTREAM_ERROR");
    }
  });
});

describe("the brokered network, driven by the child", () => {
  const withBroker = (transport, { allowHosts = ["api.vendor-example.com"], limits = { perSecond: 100 } } = {}) => {
    const broker = createFetchBroker({ id: "fake-plugin", version: "1.0.0", allowHosts, limits, transport });
    return broker;
  };
  const fetchReply = async (fetchMsg, transport, opts) => {
    const { h, fs } = setup({ host: { broker: withBroker(transport, opts) } });
    await h.call("quotes", {});
    const c = fs.last();
    c.say({ type: "fetch", id: 1, ...fetchMsg });
    await tick(10);
    return { reply: c.of("fetchResult").at(-1), c };
  };

  it("performs an allowed request and sends the answer back", async () => {
    const seen = [];
    const { reply } = await fetchReply({ url: "https://api.vendor-example.com/q?s=1" }, async (req) => (seen.push(req.url.href), { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":1}' }));
    expect(reply).toEqual({ type: "fetchResult", id: 1, ok: true, status: 200, headers: { "content-type": "application/json" }, body: '{"ok":1}' });
    expect(seen).toEqual(["https://api.vendor-example.com/q?s=1"]);
  });

  it.each([
    ["a host outside the manifest list", "https://evil.example.org/x"],
    ["http", "http://api.vendor-example.com/x"],
    ["a loopback IP", "https://127.0.0.1/x"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["a private IP", "https://192.168.1.1/admin"],
    ["an IPv6 loopback", "https://[::1]/x"],
    ["a broker host", "https://api.kite.trade/portfolio"],
    ["the Bridge itself", "https://localhost:4300/v1/keys"],
  ])("refuses %s and the network is never touched", async (_name, url) => {
    const transport = vi.fn();
    const { reply, c } = await fetchReply({ url }, transport);
    expect(reply).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
    expect(transport).not.toHaveBeenCalled();
    expect(c.killed).toEqual([]);
  });

  it("refuses a redirect from an allowed host to a private address", async () => {
    let calls = 0;
    const { reply } = await fetchReply({ url: "https://api.vendor-example.com/x" }, async () => (calls += 1, { status: 302, headers: { location: "https://10.0.0.1/secret" }, body: "" }));
    expect(reply).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
    expect(reply.message).toMatch(/redirect refused/);
    expect(calls).toBe(1);
  });

  it("applies the plugin's own request limits and says when to retry", async () => {
    const { h, fs } = setup({ host: { broker: withBroker(async () => ({ status: 200, headers: {}, body: "" }), { limits: { perSecond: 1 } }) } });
    await h.call("quotes", {});
    const c = fs.last();
    c.say({ type: "fetch", id: 1, url: "https://api.vendor-example.com/a" });
    c.say({ type: "fetch", id: 2, url: "https://api.vendor-example.com/b" });
    await tick(10);
    const replies = c.of("fetchResult");
    expect(replies.find((r) => r.id === 1).ok).toBe(true);
    expect(replies.find((r) => r.id === 2)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(replies.find((r) => r.id === 2).retryAfterMs).toBeGreaterThan(0);
  });

  it("caps concurrent fetches per plugin", async () => {
    const release = [];
    const broker = withBroker(() => new Promise((resolve) => release.push(() => resolve({ status: 200, headers: {}, body: "" }))));
    const { h, fs } = setup({ host: { broker } });
    await h.call("quotes", {});
    const c = fs.last();
    for (let i = 1; i <= 6; i += 1) c.say({ type: "fetch", id: i, url: "https://api.vendor-example.com/x" });
    await tick(10);
    expect(c.of("fetchResult").filter((r) => r.code === "RATE_LIMITED")).toHaveLength(2);
    release.forEach((r) => r());
    await tick(10);
    expect(c.of("fetchResult").filter((r) => r.ok)).toHaveLength(4);
  });

  it("stops brokered requests when the child is killed", async () => {
    let aborted = false;
    const broker = withBroker((req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => ((aborted = true), reject(Object.assign(new Error("a"), { name: "AbortError" }))))));
    const { h, fs } = setup({ host: { broker } });
    await h.call("quotes", {});
    fs.last().say({ type: "fetch", id: 1, url: "https://api.vendor-example.com/x" });
    await tick(5);
    h.kill("test");
    await tick(10);
    expect(aborted).toBe(true);
  });
});

describe("crashes and restarts", () => {
  const crashing = (limit = Infinity) => {
    let n = 0;
    return { onMessage: (m, c) => m.type === "call" && (++n <= limit ? c.exit(1) : answer(m, c)) };
  };

  it("a crash mid-call fails that call with BROKER_UNAVAILABLE and the next call restarts the process after a short backoff", async () => {
    const { h, fs, state } = setup({ spawn: crashing(1) });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(h.status()).toMatchObject({ state: "restarting", restarts: 1 });
    const early = await rejection(h.call("quotes", {}));
    expect(early.detail).toMatch(/restarting after a crash/);
    expect(early.retryAfterMs).toBeGreaterThan(0);
    expect(fs.calls).toHaveLength(1);
    state.now += 1001;
    const r = await h.call("quotes", {});
    expect(r.items).toHaveLength(1);
    expect(fs.calls).toHaveLength(2);
    expect(h.status().state).toBe("ready");
  });

  it("restarts at most 3 times in 10 minutes, then disables the plugin and says why", async () => {
    const { h, fs, state } = setup({ spawn: crashing() });
    const changes = [];
    for (let i = 1; i <= 4; i += 1) {
      state.now += 31_000;
      const err = await rejection(h.call("quotes", {}));
      expect(err.code).toBe("BROKER_UNAVAILABLE");
      changes.push(h.status().state);
    }
    expect(changes).toEqual(["restarting", "restarting", "restarting", "disabled"]);
    expect(fs.calls).toHaveLength(4); // the first start and three restarts
    const s = h.status();
    expect(s.reason).toMatch(/crashed 4 times in 10 minutes/);
    state.now += 3_600_000;
    const after = await rejection(h.call("quotes", {}));
    expect(after.detail).toMatch(/disabled: crashed 4 times/);
    expect(fs.calls).toHaveLength(4);
  });

  it("crashes that are more than 10 minutes apart do not add up", async () => {
    const { h, fs, state } = setup({ spawn: crashing() });
    for (let i = 0; i < 8; i += 1) {
      state.now += RESTART_WINDOW_MS / 2 + 1000;
      await rejection(h.call("quotes", {}));
    }
    expect(h.status().state).not.toBe("disabled");
    expect(fs.calls).toHaveLength(8);
  });

  it("reports the disabled state with its reason through the onStateChange hook", async () => {
    const events = [];
    const { h, state } = setup({ spawn: crashing(), host: { onStateChange: (s) => events.push(s) } });
    for (let i = 0; i < 4; i += 1) {
      state.now += 31_000;
      await rejection(h.call("quotes", {}));
    }
    expect(events.at(-1)).toMatchObject({ state: "disabled" });
    expect(events.at(-1).reason).toMatch(/crashed/);
    expect(events.slice(0, -1).every((e) => e.state === "restarting")).toBe(true);
  });

  it("a protocol violation counts as a crash against the same budget", async () => {
    const { h, state } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say("garbage\n") } });
    for (let i = 0; i < 4; i += 1) {
      state.now += 31_000;
      await rejection(h.call("quotes", {}));
    }
    expect(h.status().state).toBe("disabled");
  });
});

describe("concurrency and queueing", () => {
  it("runs one call at a time by default and queues the rest", async () => {
    const held = [];
    const { h } = setup({ manifest: { limits: { callTimeoutMs: 2000 } }, spawn: { onMessage: (m, c) => m.type === "call" && held.push([m, c]) } });
    const a = h.call("quotes", {});
    const b = h.call("quotes", {});
    await tick(20);
    expect(held).toHaveLength(1);
    held[0][1].say({ type: "result", id: held[0][0].id, data: goodQuotes(AT) });
    await a;
    await tick(10);
    expect(held).toHaveLength(2);
    held[1][1].say({ type: "result", id: held[1][0].id, data: goodQuotes(AT) });
    await b;
  });

  it("allows up to maxInFlight at once", async () => {
    const held = [];
    const { h } = setup({ manifest: { limits: { callTimeoutMs: 2000, maxInFlight: 2 } }, spawn: { onMessage: (m, c) => m.type === "call" && held.push([m, c]) } });
    const calls = [h.call("quotes", {}), h.call("quotes", {}), h.call("quotes", {})];
    await tick(20);
    expect(held).toHaveLength(2);
    for (const [m, c] of held.splice(0)) c.say({ type: "result", id: m.id, data: goodQuotes(AT) });
    await tick(10);
    for (const [m, c] of held.splice(0)) c.say({ type: "result", id: m.id, data: goodQuotes(AT) });
    await Promise.all(calls);
  });

  it("a queued call can be aborted and a long queue is refused", async () => {
    const { h } = setup({ manifest: { limits: { callTimeoutMs: 2000 } }, spawn: { onMessage: () => {} } });
    const first = rejection(h.call("quotes", {}));
    const ac = new AbortController();
    const queued = rejection(h.call("quotes", {}, { signal: ac.signal }));
    await tick(5);
    ac.abort();
    expect((await queued).name).toBe("AbortError");
    const many = Array.from({ length: 21 }, () => rejection(h.call("quotes", {})));
    const refused = await Promise.race(many);
    expect(refused.detail).toMatch(/busy/);
    await h.stop();
    await first;
  });
});

describe("heartbeat and stop", () => {
  it("pings every 10 seconds and kills a child that misses two heartbeats", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { h, fs } = setup({ host: { readyTimeoutMs: 60_000 } });
    await h.call("quotes", {});
    const c = fs.last();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.of("ping")).toHaveLength(1);
    c.say({ type: "pong", id: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.of("ping")).toHaveLength(2);
    expect(c.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000); // one missed
    expect(c.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000); // two missed
    expect(c.killed).toContain("SIGKILL");
    expect(h.status().lastError).toMatch(/two heartbeats/);
  });

  it("stop sends shutdown, waits for the exit, and refuses later calls", async () => {
    const { h, fs } = setup({ spawn: { onMessage: (m, c) => (m.type === "call" ? answer(m, c) : m.type === "shutdown" && setTimeout(() => c.exit(0), 2)) } });
    await h.call("quotes", {});
    await h.stop();
    expect(fs.last().of("shutdown")).toHaveLength(1);
    expect(fs.last().killed).toEqual([]);
    expect(h.status().state).toBe("stopped");
    expect((await rejection(h.call("quotes", {}))).detail).toMatch(/stopped/);
    expect(fs.calls).toHaveLength(1);
  });

  it("stop kills a child that ignores shutdown and fails calls in flight", async () => {
    const { h, fs } = setup({ manifest: { limits: { callTimeoutMs: 2000 } }, spawn: { onMessage: () => {} } });
    const inflight = rejection(h.call("quotes", {}));
    await tick(10);
    await h.stop();
    expect(fs.last().killed).toContain("SIGKILL");
    expect((await inflight).code).toBe("BROKER_UNAVAILABLE");
  });

  it("stopping a plugin that never started is a no-op", async () => {
    const { h } = setup();
    await h.stop();
    expect(h.status().state).toBe("stopped");
  });
});

describe("rate limits and cancellation reach the network", () => {
  it("errors carry fields.kind, the vocabulary the router reads", async () => {
    const kinds = {};
    for (const code of ["RATE_LIMITED", "AUTH", "NOT_FOUND", "UNAVAILABLE", "BAD_RESPONSE", "UNSUPPORTED"]) {
      const { h } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && c.say({ type: "error", id: m.id, code, message: "x", ...(code === "RATE_LIMITED" ? { retryAfterMs: 10 } : {}) }) } });
      kinds[code] = (await rejection(h.call("quotes", {}))).fields;
    }
    expect(kinds).toEqual({
      RATE_LIMITED: { kind: "rate-limited", source: "fake-plugin" },
      AUTH: { kind: "auth", source: "fake-plugin" },
      NOT_FOUND: { kind: "not-found", source: "fake-plugin" },
      UNAVAILABLE: { kind: "unavailable", source: "fake-plugin" },
      BAD_RESPONSE: { kind: "upstream", source: "fake-plugin" },
      UNSUPPORTED: { kind: "unsupported", source: "fake-plugin" },
    });
  });

  it("after RATE_LIMITED the plugin is not asked again until the retry time has passed", async () => {
    let n = 0;
    const { h, fs, state } = setup({ spawn: { onMessage: (m, c) => m.type === "call" && (++n === 1 ? c.say({ type: "error", id: m.id, code: "RATE_LIMITED", message: "slow", retryAfterMs: 30_000 }) : answer(m, c)) } });
    expect((await rejection(h.call("quotes", {}))).retryAfterMs).toBe(30_000);
    state.now += 10_000;
    const early = await rejection(h.call("quotes", {}));
    expect(early.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(early.retryAfterMs).toBe(20_000);
    expect(fs.last().of("call")).toHaveLength(1); // the second call never left the Bridge
    state.now += 20_001;
    expect((await h.call("quotes", {})).items).toHaveLength(1);
  });

  it("cancelling a call aborts the requests the host is making for it", async () => {
    let aborted = false;
    const broker = createFetchBroker({
      id: "fake-plugin",
      version: "1.0.0",
      allowHosts: ["api.vendor-example.com"],
      limits: { perSecond: 100 },
      transport: (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => ((aborted = true), reject(Object.assign(new Error("a"), { name: "AbortError" }))))),
    });
    let callId;
    const { h, fs } = setup({
      manifest: { limits: { callTimeoutMs: 5000 } },
      host: { broker },
      spawn: { onMessage: (m, c) => m.type === "call" && ((callId = m.id), c.say({ type: "fetch", id: 1, call: m.id, url: "https://api.vendor-example.com/slow" })) },
    });
    const ac = new AbortController();
    const p = rejection(h.call("quotes", {}, { signal: ac.signal }));
    await tick(20);
    expect(aborted).toBe(false);
    ac.abort();
    expect((await p).name).toBe("AbortError");
    await tick(10);
    expect(aborted).toBe(true);
    expect(fs.last().of("cancel")[0].id).toBe(callId);
  });
});

describe("refused-request logging is summarised", () => {
  it("logs the first refusal at once and then at most one summary line per 10 s per plugin", async () => {
    const { h, fs, logs, state } = setup({ host: { broker: createFetchBroker({ id: "fake-plugin", version: "1.0.0", allowHosts: ["api.vendor-example.com"], limits: { perSecond: 100 }, transport: vi.fn() }) } });
    await h.call("quotes", {});
    const c = fs.last();
    const refusals = () => logs.filter(([, m]) => m.includes("refused a request"));
    for (let i = 0; i < 60; i++) {
      c.say({ type: "fetch", id: i + 1, url: "https://evil.example.org/x" });
      await tick(1);
    }
    expect(c.of("fetchResult").filter((r) => r.code === "HOST_NOT_ALLOWED").length).toBeGreaterThan(50);
    expect(c.of("fetchResult").length).toBeGreaterThan(50); // the host still answers each one
    expect(refusals()).toHaveLength(1);
    state.now += 9_000;
    c.say({ type: "fetch", id: 1001, url: "https://evil.example.org/x" });
    await tick(10);
    expect(refusals()).toHaveLength(1); // still inside the 10 s window
    state.now += 1_500;
    c.say({ type: "fetch", id: 1002, url: "https://evil.example.org/x" });
    await tick(10);
    expect(refusals()).toHaveLength(2);
    expect(refusals()[1][1]).toMatch(/more refused since the last line/);
  });
});

describe("running plugins as another user (sources.pluginUser)", () => {
  it("passes uid and gid to the child process when the Bridge has the privilege", async () => {
    const { h, fs } = setup({ host: { runAs: { uid: 1500, gid: 1501 }, getuid: () => 0, platform: "linux" } });
    await h.call("quotes", {});
    expect(fs.calls[0].options).toMatchObject({ uid: 1500, gid: 1501, shell: false });
  });

  it("does not set uid or gid when no pluginUser is configured (never required)", async () => {
    const { h, fs } = setup({ host: { getuid: () => 1000 } });
    await h.call("quotes", {});
    expect(fs.calls[0].options).not.toHaveProperty("uid");
    expect(fs.calls[0].options).not.toHaveProperty("gid");
  });

  it("refuses to start the plugin, with a clear message, when the Bridge is not allowed to switch user", async () => {
    const { h, fs } = setup({ host: { runAs: { uid: 1500, gid: 1500 }, getuid: () => 1000, platform: "linux" } });
    const err = await rejection(h.call("quotes", {}));
    expect(err.code).toBe("BROKER_UNAVAILABLE");
    expect(err.message).toMatch(/runs as uid 1000/);
    expect(err.message).toMatch(/pluginUser/);
    expect(fs.calls).toHaveLength(0); // never silently started with the Bridge's own privileges
  });

  it("runAsProblem names every unsupported case", () => {
    expect(runAsProblem(null)).toBeNull();
    expect(runAsProblem({ uid: 1500, gid: 1500 }, { platform: "linux", getuid: () => 0 })).toBeNull();
    expect(runAsProblem({ uid: 1500, gid: 1500 }, { platform: "win32", getuid: undefined })).toMatch(/not supported/);
    expect(runAsProblem({ uid: 0, gid: 1500 }, { platform: "linux", getuid: () => 0 })).toMatch(/never run as root/);
    expect(runAsProblem({ uid: 1500, gid: 0 }, { platform: "linux", getuid: () => 0 })).toMatch(/never run as root/);
    expect(runAsProblem({ uid: 1.5, gid: 2 }, { platform: "linux", getuid: () => 0 })).toMatch(/numeric/);
    expect(runAsProblem({ uid: 1500, gid: 1500 }, { platform: "linux", getuid: () => 1000 })).toMatch(/uid 1000/);
  });
});
