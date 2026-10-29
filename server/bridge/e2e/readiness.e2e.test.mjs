/**
 * End-to-end: trading readiness (docs/spec/p1-05-readiness.md §10.3; README §4 step 5 acceptance). The REAL Bridge
 * (every module) on 127.0.0.1 with a stub broker, a local IP-echo server for the egress lookup and a local capture
 * server as the notification target. The clock is shifted to a trading day and moved forward by hand; the 60 s tick
 * is driven with readiness.tick() after each move, exactly as the interval timer would.
 *
 *  1. ready: snapshot, live hook and a test automation all show ready
 *  2. session expiry: the stub's read call starts failing → cannot_trade (SESSION_REJECTED) within 300 s of simulated
 *     time; automation notified; one notification; a signed webhook signal is refused with CANNOT_TRADE and the stub's
 *     placeOrder is never called; audit has readiness.changed and order.refused
 *  3. recovery: reconnect → ready within 1 s; a "ready again" notification
 *  4. IP change: the echo server answers another address → cannot_trade (IP_MISMATCH); webhook refused; placeOrder 0;
 *     a person's REST preview shows the READINESS warning and the safety static-IP warning (now fed)
 *  5. pre-open: next trading day (the reference calendar skips the Dussehra holiday) 08:59:30 → exactly one pre-open
 *     notification; a restart at 09:05 sends no second one
 *  6. demo: POST /v1/demo/readiness ip-changed → cannot_trade (simulated), samples too; 10 simulated minutes → ready
 */
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "../auth/hmac.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { hooksRuntimeFor } from "../hooks/module.mjs";
import { detectionBoundSeconds, parseReadinessConfig } from "../readiness/config.mjs";
import { fakeAutomation } from "../readiness/testkit.mjs";
import { TRADING_DAY_10AM_IST, eventually, stubBroker, stubRegistry } from "./fixtures.mjs";

const REGISTERED = "203.0.113.10";
const CHANGED = "198.51.100.23";

/** A small local HTTP server; `handler(req, body)` returns [status, text, headers?]. */
async function localServer(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [status, text, headers = {}] = handler(req, body);
      res.writeHead(status, { "content-type": "text/plain", ...headers });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

/** A clock that runs in real time from `start`; move() jumps it forward (or to an instant). */
function movableClock(start) {
  let offset = start - Date.now();
  return {
    now: () => Date.now() + offset,
    move: (ms) => {
      offset += ms;
    },
    to: (t) => {
      offset = t - Date.now();
    },
  };
}

async function boot({ raw, brokers, clock, dataDir = mkdtempSync(join(tmpdir(), "mcb-e2e-rd-")), demo = false }) {
  const { config } = loadConfig({ raw: { dataDir, logging: { level: "silent" }, server: { port: 0 }, ...raw }, env: {}, demo });
  const app = await createApp({ config, logger: createNullLogger(), clock, ...(brokers ? { brokers: stubRegistry(brokers) } : {}) });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const request = async (path, { method = "GET", key, body, headers = {} } = {}) => {
    const h = { ...headers };
    if (key) h.Authorization = `Bearer ${key}`;
    if (body !== undefined && typeof body !== "string") h["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, text, json };
  };
  return { app, deps: app.deps, port, request, dataDir, close: () => app.close() };
}

let bridge;
let ipServer;
let capture;
let ipAnswer = REGISTERED;
let stub;
let failSession = false;
const placed = [];
const notifications = [];
const keys = {};
let hook;
let auto;
const clock = movableClock(TRADING_DAY_10AM_IST);
let raw;

const readiness = () => bridge.deps.readiness;
const state = async () => (await bridge.request("/v1/readiness", { key: keys.read })).json.data.accounts[0];
const titles = () => notifications.map((n) => n.title);

/** Move the clock one tick (60 s) at a time and run the tick, until `pred` holds; returns the simulated ms used. */
async function ticksUntil(pred, maxMs = 600_000) {
  let used = 0;
  while (used < maxMs) {
    clock.move(60_000);
    used += 60_000;
    await readiness().tick();
    if (await pred()) return used;
  }
  throw new Error(`condition not met within ${maxMs / 1000} s of simulated time`);
}

async function sendSignal(id) {
  const body = JSON.stringify({ symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, price: 1400, orderType: "LIMIT", id });
  const t = Math.floor(clock.now() / 1000);
  const res = await bridge.request(hook.path, { method: "POST", body, headers: { "Content-Type": "application/json", "X-MCB-Signature": sign(hook.signingSecret, t, body) } });
  expect(res.status).toBe(202);
  const rt = hooksRuntimeFor(bridge.deps);
  await rt.worker.idle();
  return rt.worker.get(res.json.signalId);
}

beforeAll(async () => {
  // The echo server's Date header follows the Bridge's (shifted) clock, so the clock-skew check sees no skew.
  ipServer = await localServer(() => [200, `${ipAnswer}\n`, { date: new Date(clock.now()).toUTCString() }]);
  capture = await localServer((req, body) => {
    try {
      notifications.push(JSON.parse(body));
    } catch {
      /* ignore */
    }
    return [200, "ok"];
  });
  stub = stubBroker("zerodha");
  const healthy = stub.adapter.testConnection;
  stub.adapter.testConnection = async (creds) => {
    if (failSession) throw Object.assign(new Error("Please log in again"), { code: "SESSION_LOGIN_REQUIRED" });
    return healthy(creds);
  };
  stub.adapter.placeOrder = async (...args) => {
    placed.push(args);
    return { status: "success", data: { orderId: `STUB-${placed.length}` } };
  };
  raw = {
    safety: { liveTrading: true },
    accounts: [{ id: "stub-live", broker: "zerodha", label: "Stub", live: { enabled: true, allowedSources: ["rest", "webhook"], registeredIp: REGISTERED } }],
    readiness: { intervalMinutes: 1, egressIp: { mode: "lookup", lookupUrl: `http://127.0.0.1:${ipServer.port}/ip` } },
    notify: { targets: [{ id: "capture", kind: "webhook", url: `http://127.0.0.1:${capture.port}/n`, events: ["trading.readiness"] }] },
    ratelimit: { client: { perSecond: 1000 } },
  };
  bridge = await boot({ raw, brokers: { zerodha: stub }, clock });
  await bridge.deps.accounts.connect("stub-live", { values: { apiKey: "k", accessToken: "token-stub-live" } });
  const ks = bridge.deps.keyStore;
  keys.owner = (await ks.create({ label: "owner", scopes: ["admin", "live"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.read = (await ks.create({ label: "read", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  keys.live = (await ks.create({ label: "person", scopes: ["live"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "script" })).key;
  const created = await bridge.request("/v1/hooks", { method: "POST", key: keys.owner, body: { source: "generic", label: "Breakout", account: "stub-live", mode: "live", product: "CNC" } });
  expect(created.status).toBe(201);
  hook = created.json.data;
  auto = fakeAutomation(readiness(), { id: "test-guard", accountId: "stub-live", mode: "live" });
});

afterAll(async () => {
  await bridge?.close();
  await ipServer?.close();
  await capture?.close();
});

describe("trading readiness end to end", () => {
  it("the detection bound at the default interval is under 5 minutes", () => {
    expect(detectionBoundSeconds(parseReadinessConfig({}))).toBe(280.25);
    expect(detectionBoundSeconds(parseReadinessConfig({ intervalMinutes: 1 }))).toBeLessThan(300);
  });

  it("1. ready: snapshot, live hook and a test automation", async () => {
    const c = await bridge.request("/v1/readiness/check", { method: "POST", key: keys.read, body: {} });
    expect(c.status).toBe(200);
    const a = await state();
    expect(a.state).toBe("ready");
    expect(a.checks.session).toMatchObject({ status: "pass", probe: "ok" });
    expect(a.checks.egress).toMatchObject({ status: "pass", matches: true, seenBy: `127.0.0.1:${ipServer.port}` });
    const hooks = (await bridge.request("/v1/hooks", { key: keys.owner })).json.data;
    expect(hooks.find((h) => h.id === hook.id).readiness).toBe("ready");
    await eventually(() => auto.last()?.state === "ready");
    expect(a.automations.map((x) => [x.id, x.state])).toEqual(expect.arrayContaining([[hook.id, "ready"], ["test-guard", "ready"]]));
  });

  it("2. session expiry → cannot_trade within 300 s; webhook refused with CANNOT_TRADE; nothing sent", async () => {
    await readiness().tick(); // a cycle runs now; the fault starts right after it
    failSession = true;
    const used = await ticksUntil(async () => (await state()).state === "cannot_trade");
    expect(used).toBeLessThanOrEqual(300_000);
    const a = await state();
    expect(a.reasons[0]).toMatchObject({ check: "session", code: "SESSION_REJECTED", severity: "fail" });
    await eventually(() => auto.last()?.state === "cannot_trade");
    await eventually(() => notifications.some((n) => n.title === "Zerodha (Kite) Stub: cannot trade"));
    expect(notifications.filter((n) => n.event === "trading.readiness" && n.title.endsWith("cannot trade"))).toHaveLength(1);
    expect(notifications.at(-1).text).toMatch(/Automated orders on this account are paused\. Log in again: mc-bridge accounts connect stub-live/);

    const [rec] = await sendSignal("sig-session");
    expect(rec).toMatchObject({ status: "rejected", code: "CANNOT_TRADE" });
    expect(placed).toHaveLength(0);
    const audit = (await bridge.deps.audit.query({ limit: 500 })).items.map((r) => r.type);
    expect(audit).toContain("readiness.changed");
    expect(audit).toContain("order.refused");
  });

  it("3. recovery: a reconnect brings the account back within 1 s, with a 'ready again' notification", async () => {
    failSession = false;
    const t0 = Date.now();
    const r = await bridge.request("/v1/accounts/stub-live/session", { method: "POST", key: keys.owner, body: { values: { apiKey: "k", accessToken: "token-stub-live" } } });
    expect(r.status).toBe(200);
    await eventually(async () => (await state()).state === "ready", { ms: 1000 });
    expect(Date.now() - t0).toBeLessThan(1500);
    await eventually(() => notifications.some((n) => n.title === "Zerodha (Kite) Stub: ready again"));
  });

  it("4. IP change → cannot_trade (IP_MISMATCH); webhook refused; REST preview warns (readiness and static IP)", async () => {
    ipAnswer = CHANGED;
    const used = await ticksUntil(async () => (await state()).state === "cannot_trade");
    expect(used).toBeLessThanOrEqual(300_000);
    const a = await state();
    expect(a.reasons[0]).toMatchObject({ check: "egress", code: "IP_MISMATCH" });
    const [rec] = await sendSignal("sig-ip");
    expect(rec).toMatchObject({ status: "rejected", code: "CANNOT_TRADE" });
    expect(placed).toHaveLength(0);
    const p = await bridge.request("/v1/orders/preview", { method: "POST", key: keys.live, body: { account: "stub-live", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 1400, mode: "live" } });
    expect(p.status).toBe(200);
    const messages = p.json.data.checks.map((c) => `${c.code}: ${c.message}`).join("\n");
    expect(messages).toMatch(/READINESS: Readiness: cannot trade: This computer's internet address does not match/);
    expect(messages).toMatch(/does not match the static IP registered for stub-live \(see readiness\)/);
    // A non-admin key's preview never carries either address (§9).
    expect(JSON.stringify(p.json)).not.toMatch(/198\.51\.100\.23|203\.0\.113\.10/);
    expect(JSON.stringify(notifications)).not.toMatch(/198\.51\.100\.23|203\.0\.113\.10/);
  });

  it("5. pre-open: exactly one notification at 09:00 + jitter; a restart at 09:05 sends no second one", async () => {
    // Tuesday 20 Oct 2026 is an exchange holiday in the reference calendar (P1-2), so the next run is Wednesday.
    const snap = (await bridge.request("/v1/readiness", { key: keys.read })).json.data;
    expect(snap.schedule.calendarSource).toBe("reference");
    expect(snap.schedule.preOpen.nextRunAt).toMatch(/^2026-10-21T09:00:\d\d\+05:30$/);
    clock.to(Date.parse("2026-10-21T08:59:30+05:30"));
    await readiness().tick();
    for (let i = 0; i < 3; i += 1) {
      clock.move(60_000);
      await readiness().tick();
    }
    await eventually(() => notifications.some((n) => /readiness: 1 account\(s\) cannot trade/.test(n.title)));
    const pre = () => notifications.filter((n) => /^09:00 readiness/.test(n.title));
    expect(pre()).toHaveLength(1);
    expect(pre()[0].text).toMatch(/^Zerodha \(Kite\) Stub: cannot trade/);
    expect(pre()[0].text).not.toMatch(/holiday list/); // the calendar knows the holidays, so no caveat
    expect(JSON.parse(readFileSync(join(bridge.dataDir, "readiness", "state.json"), "utf8")).preopen.lastRunDate).toBe("2026-10-21");

    await bridge.close();
    clock.to(Date.parse("2026-10-21T09:05:00+05:30"));
    bridge = await boot({ raw, brokers: { zerodha: stub }, clock, dataDir: bridge.dataDir });
    await readiness().tick();
    clock.move(60_000);
    await readiness().tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(pre()).toHaveLength(1);
  });
});

describe("trading readiness in demo mode", () => {
  let demo;
  const demoClock = movableClock(Date.parse("2026-11-01T21:00:00+05:30")); // a Sunday evening
  beforeAll(async () => {
    demo = await boot({ raw: {}, clock: demoClock, demo: true });
    keys.demo = (await demo.deps.keyStore.create({ label: "demo", scopes: ["read"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" })).key;
  });
  afterAll(async () => demo?.close());

  it("6. ip-changed → cannot_trade (simulated) with the samples; restores after 10 simulated minutes", async () => {
    const r = await demo.request("/v1/demo/readiness", { method: "POST", key: keys.demo, body: { scenario: "ip-changed" } });
    expect(r.status).toBe(200);
    const a = r.json.data.accounts[0];
    expect(a).toMatchObject({ accountId: "demo", simulated: true, state: "cannot_trade" });
    expect(a.reasons[0].code).toBe("IP_MISMATCH");
    expect(a.automations.map((x) => x.state)).toEqual(["cannot_trade", "cannot_trade"]);
    expect(r.json.meta.demo).toBe(true);
    demoClock.move(10 * 60_000 + 1000);
    await demo.deps.readiness.tick();
    const after = (await demo.request("/v1/readiness", { key: keys.demo })).json.data.accounts[0];
    expect(after.state).toBe("ready");
    expect((await demo.request("/v1/demo/readiness", { method: "POST", key: keys.demo, body: { scenario: "nope" } })).status).toBe(400);
  });
});
