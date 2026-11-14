/**
 * `mc-bridge notify ...` against a fake running Bridge on 127.0.0.1 (never the real network), and the doctor lines.
 */
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, runDoctor } from "../core/cli.mjs";
import { loadConfig } from "../core/config.mjs";
import { formatStatus } from "./cli.mjs";
import { notifyDoctorChecks } from "./doctor.mjs";
import { TOKEN, bootNotify } from "./testkit.mjs";

let server;
const seen = [];
afterEach(async () => {
  seen.length = 0;
  if (server) await new Promise((r) => server.close(r));
  server = null;
});

const TARGET = { id: "tg_abcdefgh", kind: "telegram", label: "@my_bridge_bot", bot: { username: "my_bridge_bot", tokenHint: "••••0000" }, chats: [], createdAt: "x", health: { state: "unverified", message: "x" }, replaced: false };

async function bridge({ found = [{ ref: "0123456789", name: "Asha", type: "private", idHint: "••••4242", seenAt: "x" }], testOk = true, status } = {}) {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const send = (code, o) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(o));
      };
      if (req.url === "/v1/health") return send(200, { ok: true });
      if (req.url === "/v1/notify/targets" && req.method === "POST") return send(201, { data: TARGET });
      if (req.url === "/v1/notify/targets" && req.method === "GET") return send(200, { data: [TARGET] });
      if (/find-chat$/.test(req.url)) return send(200, { data: found });
      if (/\/chats$/.test(req.url)) return send(201, { data: { key: "abcdef0123", name: "Asha", type: "private", idHint: "••••4242", commands: true } });
      if (/\/test$/.test(req.url)) return send(200, { data: testOk ? { ok: true, delivered: 1, results: [{ chat: { name: "Asha" }, ok: true }] } : { ok: false, delivered: 0, results: [{ chat: { name: "Asha" }, ok: false, error: { kind: "blocked", message: "This chat has blocked the bot." } }] } });
      if (req.url === "/v1/notify/status") return send(200, { data: status ?? { enabled: true, targets: [], queue: { depth: 0, dropped: 0 }, lastDeliveryAt: null, counters: { ignoredMessages: 0 } } });
      if (req.method === "DELETE") return send(204, {});
      send(404, { code: "NOT_FOUND", detail: "no such route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

function setup() {
  const out = [];
  const err = [];
  const asked = [];
  const dir = mkdtempSync(join(tmpdir(), "mcb-cli-notify-"));
  writeFileSync(join(dir, "bridge.config.json"), JSON.stringify({ dataDir: "data", logging: { level: "silent" } }));
  const answers = [TOKEN, "", "y"];
  const io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { MCB_ADMIN_KEY: "mcb_adminkey00_x" },
    cwd: dir,
    sleep: async () => {},
    prompt: async (label, o) => {
      asked.push({ label, hidden: o?.hidden });
      return answers.shift() ?? "";
    },
  };
  return { out, err, asked, io };
}

describe("mc-bridge notify telegram setup", () => {
  it("asks for the token with HIDDEN input, finds the chat, confirms it, sends a test", async () => {
    const url = await bridge();
    const a = setup();
    const code = await runCli(["notify", "telegram", "setup"], { url }, a.io);
    expect(code).toBe(0);
    expect(a.asked[0]).toEqual({ label: "Bot token", hidden: true });
    expect(a.asked[1].hidden).toBe(false);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /v1/health",
      "POST /v1/notify/targets",
      "POST /v1/notify/targets/tg_abcdefgh/find-chat",
      "POST /v1/notify/targets/tg_abcdefgh/chats",
      "POST /v1/notify/targets/tg_abcdefgh/test",
    ]);
    expect(seen[1].body).toEqual({ token: TOKEN });
    expect(seen[1].auth).toBe("Bearer mcb_adminkey00_x");
    expect(seen[3].body).toEqual({ ref: "0123456789" });
    const printed = [...a.out, ...a.err].join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(printed).toContain("@my_bridge_bot");
    expect(printed).toContain("Asha");
    expect(printed).toMatch(/test message delivered/);
  });

  it("never reads the token from the command line: an extra argument or a --token flag is refused before anything is sent", async () => {
    const url = await bridge();
    const a = setup();
    expect(await runCli(["notify", "telegram", "setup", TOKEN], { url }, a.io)).toBe(1);
    expect(a.err.join("\n")).toMatch(/never read from the command line/);
    expect(a.err.join("\n")).not.toContain(TOKEN);
    const b = setup();
    expect(await runCli(["notify", "telegram", "setup"], { url, token: TOKEN }, b.io)).toBe(1);
    expect(b.err.join("\n")).toMatch(/never taken from the command line/);
    expect(b.err.join("\n")).not.toContain(TOKEN);
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("says what to do when no message from you has arrived yet", async () => {
    const url = await bridge({ found: [] });
    const a = setup();
    expect(await runCli(["notify", "telegram", "setup"], { url }, a.io)).toBe(1);
    expect(a.err.join("\n")).toMatch(/did not see a message yet/);
  });

  it("reports a blocked chat in plain words and exits non-zero", async () => {
    const url = await bridge({ testOk: false });
    const a = setup();
    expect(await runCli(["notify", "telegram", "setup"], { url }, a.io)).toBe(1);
    expect(a.out.join("\n")).toMatch(/NOT delivered. This chat has blocked the bot/);
  });

  it("answering no adds no chat", async () => {
    const url = await bridge();
    const a = setup();
    a.io.prompt = async (label) => ({ "Bot token": TOKEN }[label] ?? (label.startsWith("Send alerts") ? "n" : ""));
    await runCli(["notify", "telegram", "setup"], { url }, a.io);
    expect(seen.some((s) => /\/chats$/.test(s.url))).toBe(false);
  });
});

describe("other notify commands", () => {
  it("status and test print plain lines", async () => {
    const url = await bridge({ status: { enabled: true, targets: [{ id: "tg_abcdefgh", label: "x", bot: "@my_bridge_bot", chats: 1, state: "blocked", message: "This chat has blocked the bot.", inbound: { state: "listening" } }], queue: { depth: 2, dropped: 0 }, lastDeliveryAt: null, counters: { ignoredMessages: 3 } } });
    const a = setup();
    expect(await runCli(["notify", "status"], { url }, a.io)).toBe(1);
    expect(a.out.join("\n")).toMatch(/@my_bridge_bot\), 1 chat: PROBLEM. This chat has blocked the bot\./);
    expect(a.out.join("\n")).toMatch(/3 message\(s\) from chats that are not on your list were ignored/);
    const b = setup();
    expect(await runCli(["notify", "test"], { url }, b.io)).toBe(0);
    expect(b.out.join("\n")).toMatch(/delivered/);
    const c = setup();
    expect(await runCli(["notify", "telegram", "remove", "tg_abcdefgh"], { url }, c.io)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/v1/notify/targets/tg_abcdefgh" });
  });

  it("unknown subcommands print the usage", async () => {
    const a = setup();
    expect(await runCli(["notify", "whatever"], {}, a.io)).toBe(1);
  });

  it("formatStatus handles the empty case", () => {
    expect(formatStatus({ enabled: true, targets: [], queue: { depth: 0, dropped: 0 }, lastDeliveryAt: null, counters: { ignoredMessages: 0 } })).toMatch(/No Telegram bot is set up\. Run: mc-bridge notify telegram setup/);
  });
});

describe("doctor reports notify health truthfully", () => {
  const withSvc = (n) => ({ ...n.deps, notify: n.svc });
  const by = (checks) => checks.filter((c) => c.check === "notify");

  it("not set up: ok, optional, with the command", async () => {
    const n = bootNotify();
    expect(await notifyDoctorChecks(withSvc(n))).toEqual([{ level: "ok", check: "notify", message: expect.stringMatching(/not set up \(optional\).*notify telegram setup/) }]);
  });

  it("set up but never delivered: a warning that says it is unverified (never 'alerts go to ...')", async () => {
    const n = bootNotify();
    await n.withChat();
    const [c] = await notifyDoctorChecks(withSvc(n));
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/not verified/);
    expect(c.message).not.toMatch(/go to/i);
  });

  it("after a delivery: ok with the time; after a failure: a warning with the reason", async () => {
    const n = bootNotify();
    const { target } = await n.withChat();
    await n.svc.testTarget(target.id);
    expect((await notifyDoctorChecks(withSvc(n)))[0]).toMatchObject({ level: "ok", message: expect.stringMatching(/last delivery 20/) });
    n.tg.script("sendMessage", { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    await n.svc.testTarget(target.id);
    const [c] = await notifyDoctorChecks(withSvc(n));
    expect(c.level).toBe("warn");
    expect(c.message).toMatch(/cannot send right now: Telegram does not accept this bot token/);
  });

  it("a bot with no chat, and waiting messages, are reported", async () => {
    const n = bootNotify();
    await n.svc.addTarget({ token: TOKEN });
    expect((await notifyDoctorChecks(withSvc(n)))[0].message).toMatch(/has no chat yet/);
  });

  it("switched off in the config", async () => {
    const n = bootNotify({ config: { enabled: false } });
    expect((await notifyDoctorChecks(withSvc(n)))[0].message).toMatch(/switched off/);
  });

  it("runDoctor includes the notify line when the service is built", async () => {
    const n = bootNotify();
    const { config } = loadConfig({ raw: { dataDir: n.dataDir }, env: {} });
    const checks = await runDoctor({ config, deps: withSvc(n), portCheck: false, env: {} });
    expect(by(checks)).toHaveLength(1);
    expect(by(checks)[0].message).toMatch(/Telegram alerts are not set up/);
    expect(checks.some((c) => /Readiness alerts go to/.test(c.message))).toBe(false);
  });
});
