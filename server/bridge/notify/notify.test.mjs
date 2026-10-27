/**
 * Notifications (stream S15): event filtering, Telegram/Discord/webhook request shapes, signing, retries, secrets
 * kept out of status, and the module routes. No network: fetch is stubbed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { verify } from "../auth/hmac.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { NOTIFY_CONFIG_SCHEMA } from "./config.mjs";
import { formatEvent } from "./format.mjs";
import { createNotifier } from "./notifier.mjs";

const SECRET = "s3cret-s3cret-s3cret-0123456789";

function stubFetch(statuses = []) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const status = statuses.length ? statuses.shift() : 200;
    return new Response("{}", { status, headers: status === 429 ? { "retry-after": "1" } : {} });
  };
  fn.calls = calls;
  return fn;
}

function make(targets, { statuses, env = {}, demo = false, extra = {} } = {}) {
  const bus = createEventBus();
  const fetchImpl = stubFetch(statuses);
  const waits = [];
  const n = createNotifier({ config: { demo, notify: { targets, ...extra } }, bus, env, fetchImpl, sleep: async (ms) => waits.push(ms) });
  n.start();
  return { n, bus, fetchImpl, waits };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("notify config", () => {
  it("keeps secrets out of the file and allows plain http only to this computer", () => {
    expect(NOTIFY_CONFIG_SCHEMA.safeParse({ targets: [{ id: "a1", kind: "webhook", url: "http://example.com/x" }] }).success).toBe(false);
    expect(NOTIFY_CONFIG_SCHEMA.safeParse({ targets: [{ id: "a1", kind: "webhook", url: "http://127.0.0.1:5678/hook" }] }).success).toBe(true);
    expect(NOTIFY_CONFIG_SCHEMA.safeParse({ targets: [{ id: "a1", kind: "telegram", chatId: "123", token: "x" }] }).success).toBe(false);
    expect(NOTIFY_CONFIG_SCHEMA.safeParse({ targets: [{ id: "a1", kind: "webhook" }] }).success).toBe(false);
    expect(NOTIFY_CONFIG_SCHEMA.safeParse({ targets: [{ id: "a1", kind: "discord", urlEnv: "D" + "X" }, { id: "a1", kind: "slack", urlEnv: "SX" }] }).success).toBe(false);
  });
});

describe("notifier", () => {
  it("sends saved-scan alerts to Telegram with the bot token from the environment", async () => {
    const { bus, fetchImpl, n } = make([{ id: "phone", kind: "telegram", chatId: "42" }], { env: { MCB_TELEGRAM_BOT_TOKEN: "123:abc" } });
    bus.emit("scan.alert", { keyId: "k1", savedId: "saved_1", name: "Breakouts", jobId: "scan_1", newMatches: ["NSE:TCS", "NSE:INFY"], at: "x" });
    await flush();
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(fetchImpl.calls[0].body).toMatchObject({ chat_id: "42" });
    expect(fetchImpl.calls[0].body.text).toContain("NSE:TCS, NSE:INFY");
    const st = n.status().targets[0];
    expect(st).toMatchObject({ id: "phone", configured: true, sent: 1, failed: 0 });
    expect(JSON.stringify(n.status())).not.toContain("123:abc");
  });

  it("filters orders by mode and status, sessions by state, and ignores events not chosen", async () => {
    const { bus, fetchImpl } = make([{ id: "n8n", kind: "webhook", url: "https://hooks.example.com/b", events: ["order.updated", "account.status"] }]);
    bus.emit("order.updated", { orderId: "PAPER-1", accountId: "a", mode: "paper", status: "filled" });
    bus.emit("order.updated", { orderId: "ord_1", accountId: "a", mode: "live", status: "open" });
    bus.emit("order.updated", { orderId: "ord_2", accountId: "a", mode: "live", status: "filled", filledQuantity: 65, avgPrice: 182.4 });
    bus.emit("account.status", { accountId: "a", session: "connected" });
    bus.emit("account.status", { accountId: "a", session: "expired" });
    bus.emit("scan.alert", { name: "x", newMatches: ["NSE:A"] });
    await flush();
    expect(fetchImpl.calls.map((c) => c.body.event)).toEqual(["order.updated", "account.status"]);
    expect(fetchImpl.calls[0].body.data.orderId).toBe("ord_2");
    expect(fetchImpl.calls[0].body.text).toContain("65 filled @ 182.4");
  });

  it("signs generic webhooks the way the Bridge verifies its own inbound hooks, and never forwards keyId", async () => {
    const { bus, fetchImpl } = make([{ id: "n8n", kind: "webhook", url: "https://hooks.example.com/b", secretEnv: "MCB_NOTIFY_SECRET", events: ["scan.alert"] }], {
      env: { MCB_NOTIFY_SECRET: SECRET },
    });
    bus.emit("scan.alert", { keyId: "k1", name: "x", newMatches: ["NSE:A"] });
    await flush();
    const c = fetchImpl.calls[0];
    expect(c.body.data).not.toHaveProperty("keyId");
    expect(verify(c.init.headers["X-MCB-Signature"], SECRET, Buffer.from(c.init.body)).ok).toBe(true);
  });

  it("retries 429 and 5xx with back-off, gives up after maxRetries, and does not retry 4xx", async () => {
    const t = [{ id: "d1", kind: "discord", urlEnv: "MCB_DISCORD_WEBHOOK_URL", events: ["safety.kill_switch"] }];
    const env = { MCB_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" };
    const a = make(t, { env, statuses: [429, 502, 200] });
    a.bus.emit("safety.kill_switch", { engaged: true, reason: "test", by: "me" });
    await flush();
    expect(a.fetchImpl.calls).toHaveLength(3);
    expect(a.waits).toContain(1000); // Retry-After: 1
    expect(a.fetchImpl.calls[0].body.content).toContain("KILL SWITCH ENGAGED");
    expect(a.n.status().targets[0]).toMatchObject({ sent: 1, failed: 0 });

    const b = make(t, { env, statuses: [400] });
    b.bus.emit("safety.kill_switch", { engaged: true });
    await flush();
    expect(b.fetchImpl.calls).toHaveLength(1);
    expect(b.n.status().targets[0]).toMatchObject({ sent: 0, failed: 1 });
    expect(b.n.status().targets[0].lastError.message).toMatch(/HTTP 400/);
  });

  it("reports a missing environment variable instead of sending", async () => {
    const { bus, fetchImpl, n } = make([{ id: "phone", kind: "telegram", chatId: "42" }]);
    expect(n.status().targets[0]).toMatchObject({ configured: false, problem: "MCB_TELEGRAM_BOT_TOKEN is not set" });
    bus.emit("scan.alert", { name: "x", newMatches: [] });
    await flush();
    expect(fetchImpl.calls).toHaveLength(0);
    expect(n.status().targets[0].failed).toBe(1);
  });

  it("is silent in demo mode; session messages say how to log in again", async () => {
    const demo = make([{ id: "w1", kind: "webhook", url: "https://h.example.com/x", events: ["scan.alert"] }], { demo: true });
    demo.bus.emit("scan.alert", { name: "x", newMatches: [] });
    await flush();
    expect(demo.fetchImpl.calls).toHaveLength(0);
    expect(demo.n.status().active).toBe(false);
    expect(formatEvent("account.status", { accountId: "dhan-main", session: "expired" }).text).toContain("mc-bridge accounts connect dhan-main");
  });
});

describe("notify routes", () => {
  it("GET /v1/notify needs admin and shows targets without secrets", async () => {
    const { config } = loadConfig({
      raw: { dataDir: mkdtempSync(join(tmpdir(), "mcb-notify-")), server: { port: 0 }, logging: { level: "silent" }, notify: { targets: [{ id: "phone", kind: "telegram", chatId: "42" }] } },
      env: {},
    });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    try {
      const { key: admin } = await app.deps.keyStore.create({ label: "a", scopes: ["admin"], accounts: "*" });
      const { key: reader } = await app.deps.keyStore.create({ label: "r", scopes: ["read"], accounts: "*" });
      const get = (k) => fetch(`http://127.0.0.1:${port}/v1/notify`, { headers: { Authorization: `Bearer ${k}` } });
      expect((await get(reader)).status).toBe(403);
      const body = await (await get(admin)).json();
      expect(body.data.targets[0]).toMatchObject({ id: "phone", kind: "telegram", events: ["scan.alert", "safety.kill_switch"] });
    } finally {
      await app.close();
    }
  });
});
