import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createFakeKeyStore } from "../auth/fake.mjs";
import { createSecretStore } from "../auth/secretStore.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createLogger } from "../core/logger.mjs";
import { createFakeAuditLog, createFakeSafetyGuard } from "../safety/fake.mjs";
import { createNotifyModule } from "./module.mjs";
import { TOKEN, createFakeTelegram } from "./testkit.mjs";

let b;
const JSON_H = { "content-type": "application/json" };

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-notify-http-"));
  const logLines = [];
  const logger = createLogger({ level: "debug", write: (l) => logLines.push(l) });
  const tg = createFakeTelegram();
  const { config } = loadConfig({ raw: { dataDir, logging: { level: "debug" }, server: { port: 0 }, notify: { coalesceSeconds: 0 } }, env: {} });
  const keyStore = createFakeKeyStore();
  const audit = createFakeAuditLog();
  const secrets = createSecretStore({ logger, paths: { dataDir } }, { env: { MCB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") } });
  const app = await createApp({
    config,
    modules: [createNotifyModule({ fetchImpl: tg.fetch })],
    logger,
    overrides: { keyStore, secrets, audit, safety: createFakeSafetyGuard(), accounts: createFakeAccountManager({ accounts: [{ id: "paper", broker: "paper" }] }) },
  });
  const { port } = await app.listen();
  const keys = { admin: keyStore.addKey({ label: "admin", scopes: ["admin"], accounts: "*" }).key, read: keyStore.addKey({ label: "r", scopes: ["read"], accounts: "*" }).key };
  const request = ({ method = "GET", path, key, body, headers = {} }) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port, method, path, agent: false, headers: { host: `127.0.0.1:${port}`, ...(key ? { authorization: `Bearer ${key}` } : {}), ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({ status: res.statusCode, headers: res.headers, raw: text, json });
          });
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  return { app, tg, keys, audit, logLines, dataDir, request, async close() { await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

beforeEach(async () => {
  b = await boot();
});
afterEach(async () => b.close());

const admin = () => b.keys.admin;

async function addTarget() {
  const r = await b.request({ method: "POST", path: "/v1/notify/targets", key: admin(), body: { token: TOKEN, label: "Mine" } });
  expect(r.status).toBe(201);
  return r.json.data;
}

describe("notify routes", () => {
  it("needs an admin key: no key 401, read key 403, on every route", async () => {
    for (const [method, path] of [["GET", "/v1/notify/status"], ["GET", "/v1/notify/targets"], ["POST", "/v1/notify/targets"], ["GET", "/v1/notify/events"], ["PUT", "/v1/notify/events"], ["DELETE", "/v1/notify/targets/tg_aaaaaaaa"], ["POST", "/v1/notify/targets/tg_aaaaaaaa/test"]]) {
      expect((await b.request({ method, path, body: method === "GET" || method === "DELETE" ? undefined : {} })).status, `${method} ${path} anon`).toBe(401);
      expect((await b.request({ method, path, key: b.keys.read, body: method === "GET" || method === "DELETE" ? undefined : {} })).status, `${method} ${path} read`).toBe(403);
    }
  });

  it("a full setup: add the bot, find the chat, confirm it, test it, change events, read status, remove", async () => {
    const t = await addTarget();
    expect(t).toMatchObject({ kind: "telegram", label: "Mine", bot: { username: "my_bridge_bot", tokenHint: "••••0000" }, chats: [], replaced: false });
    const raw = JSON.stringify(t);
    expect(raw).not.toContain(TOKEN);

    b.tg.receive(TOKEN, { chatId: 424242, text: "/start", name: "Asha" });
    // polling is off in this test app (the module was not started with timers), so find-chat looks once
    const found = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/find-chat`, key: admin() });
    expect(found.status).toBe(200);
    expect(found.json.data).toHaveLength(1);
    expect(found.json.data[0]).toMatchObject({ name: "Asha", type: "private", idHint: "••••4242" });
    expect(found.raw).not.toContain("424242");

    const added = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { ref: found.json.data[0].ref } });
    expect(added.status).toBe(201);
    expect(added.json.data).toMatchObject({ name: "Asha", commands: true, idHint: "••••4242" });

    const test = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/test`, key: admin(), body: {} });
    expect(test.status).toBe(200);
    expect(test.json.data).toMatchObject({ ok: true, delivered: 1 });
    expect(b.tg.texts()[0]).toMatch(/test from your Bridge/);

    const list = await b.request({ path: "/v1/notify/targets", key: admin() });
    expect(list.json.data[0].health.state).toBe("ok");
    expect(list.json.data[0].chats[0].commands).toBe(true);

    const patched = await b.request({ method: "PATCH", path: `/v1/notify/targets/${t.id}/chats/${added.json.data.key}`, key: admin(), body: { commands: false } });
    expect(patched.json.data.commands).toBe(false);

    const ev = await b.request({ path: "/v1/notify/events", key: admin() });
    expect(ev.json.data.events.find((e) => e.key === "session.expired")).toMatchObject({ enabled: true, label: "A broker account is logged out" });
    const put = await b.request({ method: "PUT", path: "/v1/notify/events", key: admin(), body: { events: { "order.filled": false }, quietHours: { enabled: true, start: "23:00", end: "06:30" } } });
    expect(put.status).toBe(200);
    expect(put.json.data.events.find((e) => e.key === "order.filled").enabled).toBe(false);
    expect(put.json.data.quietHours).toMatchObject({ enabled: true, start: "23:00", end: "06:30" });

    const status = await b.request({ path: "/v1/notify/status", key: admin() });
    expect(status.json.data).toMatchObject({ enabled: true, queue: { depth: 0 }, counters: { delivered: 1 } });
    expect(status.json.data.lastDeliveryAt).toBeTruthy();

    expect((await b.request({ method: "DELETE", path: `/v1/notify/targets/${t.id}/chats/${added.json.data.key}`, key: admin() })).status).toBe(204);
    expect((await b.request({ method: "DELETE", path: `/v1/notify/targets/${t.id}`, key: admin() })).status).toBe(204);
    expect((await b.request({ path: "/v1/notify/targets", key: admin() })).json.data).toEqual([]);
  });

  it("no response, audit record or log line ever carries the token or the chat id", async () => {
    const t = await addTarget();
    b.tg.receive(TOKEN, { chatId: 424242, text: "/start" });
    const found = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/find-chat`, key: admin() });
    await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { ref: found.json.data[0].ref } });
    await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/test`, key: admin(), body: {} });
    const bodies = [];
    for (const p of ["/v1/notify/status", "/v1/notify/targets", "/v1/notify/events"]) bodies.push((await b.request({ path: p, key: admin() })).raw);
    const blob = bodies.join("\n") + JSON.stringify(b.audit.records) + b.logLines.join("\n");
    expect(blob).not.toContain(TOKEN);
    expect(blob).not.toContain("AAH-fake");
    expect(blob).not.toContain("424242");
    expect(b.audit.records.map((r) => r.type)).toEqual(expect.arrayContaining(["notify.target_added", "notify.chat_added"]));
  });

  it("refuses bad input in plain words: a malformed token, a rejected token, an unknown event, an unknown field", async () => {
    const bad = await b.request({ method: "POST", path: "/v1/notify/targets", key: admin(), body: { token: "definitely not a bot token" } });
    expect(bad.status).toBe(400);
    expect(bad.json.detail).toMatch(/does not look like a bot token/);
    const wrong = await b.request({ method: "POST", path: "/v1/notify/targets", key: admin(), body: { token: "111111111:AAH-unknown_token_value_for_tests_xxxx" } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.detail).toMatch(/does not accept this bot token/);
    expect(wrong.raw).not.toContain("AAH-unknown");
    expect((await b.request({ method: "PUT", path: "/v1/notify/events", key: admin(), body: { events: { "made.up": true } } })).status).toBe(400);
    expect((await b.request({ method: "PUT", path: "/v1/notify/events", key: admin(), body: { nope: 1 } })).status).toBe(400);
    expect((await b.request({ method: "POST", path: "/v1/notify/targets", key: admin(), body: { token: TOKEN, extra: 1 } })).status).toBe(400);
    expect((await b.request({ method: "DELETE", path: "/v1/notify/targets/tg_aaaaaaaa", key: admin() })).status).toBe(404);
    expect((await b.request({ method: "DELETE", path: "/v1/notify/targets/not-an-id", key: admin() })).status).toBe(404);
  });

  it("a chat can also be added by id typed on this computer; a bad id is refused; the same chat twice is a conflict", async () => {
    const t = await addTarget();
    const bad = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { chatId: "abc" } });
    expect(bad.status).toBe(400);
    const both = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { chatId: "123", ref: "0123456789" } });
    expect(both.status).toBe(400);
    const ok = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { chatId: "-100500", name: "Desk" } });
    expect(ok.status).toBe(201);
    expect(ok.json.data).toMatchObject({ type: "group", commands: false, idHint: "••••0500" });
    const again = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { chatId: "-100500" } });
    expect(again.status).toBe(409);
  });

  it("a test to a blocked chat is reported as data (200, ok false) with the reason in plain words", async () => {
    const t = await addTarget();
    await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/chats`, key: admin(), body: { chatId: "42" } });
    b.tg.script("sendMessage", { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } });
    const r = await b.request({ method: "POST", path: `/v1/notify/targets/${t.id}/test`, key: admin(), body: {} });
    expect(r.status).toBe(200);
    expect(r.json.data.ok).toBe(false);
    expect(r.json.data.message).toMatch(/blocked the bot/);
  });

  it("writes and sends are this-computer-only: the route table says so", () => {
    const rows = b.app.router.list().filter((r) => r.pattern.startsWith("/v1/notify"));
    expect(rows.length).toBe(11);
    for (const r of rows) {
      expect(r.options.scope).toBe("admin");
      expect(r.module).toBe("notify");
      if (r.method !== "GET") expect(r.options.loopbackOnly, `${r.method} ${r.pattern}`).toBe(true);
    }
  });

  it("the Bridge answers without a Telegram bot: status is quiet and nothing is sent", async () => {
    const r = await b.request({ path: "/v1/notify/status", key: admin() });
    expect(r.json.data).toMatchObject({ enabled: true, targets: [], queue: { depth: 0 }, lastDeliveryAt: null });
    expect(b.tg.calls).toEqual([]);
  });
});
