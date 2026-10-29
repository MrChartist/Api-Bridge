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
      expect(body.data.targets[0]).toMatchObject({ id: "phone", kind: "telegram", events: ["scan.alert", "safety.kill_switch", "trading.readiness"] });
    } finally {
      await app.close();
    }
  });
});

describe("trading.readiness (p1-05 §6.8)", () => {
  const base = { accountId: "dhan-main", broker: "dhan", brokerName: "Dhan", label: null, previous: "ready", simulated: false, at: "2026-10-29T10:12:31+05:30" };
  const expired = { ...base, state: "cannot_trade", kind: "change", notify: true, automations: { total: 1, live: 1 }, reasons: [{ check: "session", code: "SESSION_EXPIRED", severity: "fail", message: "The broker session has expired." }] };
  const ipMismatch = {
    ...base,
    accountId: "zerodha-main",
    broker: "zerodha",
    brokerName: "Zerodha",
    label: "Main",
    state: "cannot_trade",
    kind: "change",
    notify: true,
    automations: { total: 0, live: 0 },
    reasons: [{ check: "egress", code: "IP_MISMATCH", severity: "fail", message: "This computer's internet address does not match the static IP registered for Main. Live orders will be refused by Zerodha." }],
  };
  const preopen = {
    accountId: null,
    kind: "preopen",
    preOpenAt: "09:00",
    state: "cannot_trade",
    notify: true,
    holidayCaveat: "(The Bridge does not have the exchange holiday list yet; ignore this if the market is closed today.)",
    accounts: [
      { accountId: "zerodha-main", brokerName: "Zerodha", label: "Main", state: "cannot_trade", reasons: ipMismatch.reasons },
      { accountId: "dhan-main", brokerName: "Dhan", label: null, state: "ready", reasons: [] },
    ],
    at: "2026-10-29T09:00:12+05:30",
  };

  it("formats the BRD example exactly", () => {
    expect(formatEvent("trading.readiness", expired)).toEqual({
      title: "Dhan dhan-main: cannot trade",
      text: "The broker session has expired. Automated orders on this account are paused. Log in again: mc-bridge accounts connect dhan-main, or the Accounts page.",
    });
  });

  it("formats change (with the remedy of the first failing check), recovered and pre-open messages", () => {
    const ip = formatEvent("trading.readiness", ipMismatch);
    expect(ip.title).toBe("Zerodha Main: cannot trade");
    expect(ip.text).toMatch(/Check your internet connection or VPN; see the deployment guide\.$/);
    expect(ip.text).not.toMatch(/paused/);
    const ks = formatEvent("trading.readiness", { ...base, state: "cannot_trade", kind: "change", automations: { live: 0 }, reasons: [{ check: "killSwitch", code: "KILL_SWITCH", severity: "fail", message: "The kill switch is on (manual)." }] });
    expect(ks.text).toBe("The kill switch is on (manual). Release it on the Safety page if this was not intended.");
    const loss = formatEvent("trading.readiness", { ...base, state: "cannot_trade", kind: "change", automations: { live: 0 }, reasons: [{ check: "dailyLoss", code: "DAILY_LOSS_REACHED", severity: "fail", message: "Today's loss limit (₹10,000) is reached." }] });
    expect(loss.text).toMatch(/Daily limit reached; it resets at midnight IST\.$/);
    expect(formatEvent("trading.readiness", { ...base, label: "Main", state: "ready", previous: "cannot_trade", kind: "recovered", reasons: [] })).toEqual({ title: "Dhan Main: ready again", text: "Trading readiness checks pass again." });
    const pre = formatEvent("trading.readiness", preopen);
    expect(pre.title).toBe("09:00 readiness: 1 account(s) cannot trade");
    expect(pre.text.split("\n")).toEqual([
      "Zerodha Main: cannot trade (This computer's internet address does not match the static IP registered for Main. Live orders will be refused by Zerodha)",
      preopen.holidayCaveat,
    ]);
    const warnOnly = formatEvent("trading.readiness", { ...preopen, accounts: [{ accountId: "a", brokerName: "Dhan", label: "A", state: "warn", reasons: [{ severity: "warn", message: "₹1,750 of ₹10,000 daily loss left." }] }] });
    expect(warnOnly.title).toBe("09:00 readiness: 1 account(s) need attention");
    // A label that already starts with the broker's name is not prefixed twice.
    expect(formatEvent("trading.readiness", { ...base, brokerName: "Demo", label: "Demo market data", state: "ready", previous: "cannot_trade", kind: "recovered", reasons: [] }).title).toBe("Demo market data: ready again");
    expect(formatEvent("trading.readiness", { ...base, brokerName: "Zerodha", label: "zerodha main", state: "ready", previous: "cannot_trade", kind: "recovered", reasons: [] }).title).toBe("zerodha main: ready again");
    expect(formatEvent("trading.readiness", { ...base, brokerName: "Dhan", label: "Dhanush", state: "ready", previous: "cannot_trade", kind: "recovered", reasons: [] }).title).toBe("Dhan Dhanush: ready again");
  });

  it("delivers only payloads the monitor marked notify: true, and targets get the event by default", async () => {
    const parsed = NOTIFY_CONFIG_SCHEMA.parse({ targets: [{ id: "hook", kind: "webhook", url: "https://example.com/x" }] });
    expect(parsed.targets[0].events).toContain("trading.readiness");
    const { bus, fetchImpl } = make(parsed.targets);
    bus.emit("trading.readiness", { ...expired, notify: false });
    bus.emit("trading.readiness", { ...base, state: "warn", kind: "change", notify: false, reasons: [] });
    await flush();
    expect(fetchImpl.calls).toHaveLength(0);
    bus.emit("trading.readiness", expired);
    await flush();
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].body).toMatchObject({ event: "trading.readiness", title: "Dhan dhan-main: cannot trade" });
  });

  it("T-n2: no IPv4/IPv6 address, no mcb_ key and no lookup host in any formatted readiness message", () => {
    const payloads = [expired, ipMismatch, preopen, { ...ipMismatch, kind: "recovered", state: "ready", reasons: [] }];
    const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/;
    const IPV6 = /\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/i;
    for (const p of payloads) {
      const { title, text } = formatEvent("trading.readiness", p);
      const all = `${title}\n${text}`;
      expect(all).not.toMatch(IPV4);
      expect(all).not.toMatch(IPV6);
      expect(all).not.toMatch(/mcb_[A-Za-z0-9]/);
      expect(all).not.toMatch(/ipify|ifconfig|icanhazip|api\.|https?:\/\//i);
    }
  });

  it("uses neutral copy (no advice words)", () => {
    for (const p of [expired, ipMismatch, preopen]) {
      const { title, text } = formatEvent("trading.readiness", p);
      expect(`${title} ${text}`).not.toMatch(/recommend|\bbest\b|safe to|you should|\bbuy\b|\bsell\b/i);
    }
  });
});
