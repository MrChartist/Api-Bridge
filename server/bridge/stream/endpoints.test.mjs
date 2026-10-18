/**
 * End-to-end through the real app pipeline on a loopback port: WebSocket upgrade and SSE with stream tokens, one
 * upstream subscription for many clients, SUBSCRIPTION_LIMIT to the client that crossed the cap, stats, and go_away on
 * shutdown. The broker side is a stub feed adapter; nothing leaves the machine.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createFakeKeyStore } from "../auth/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { stubAdapter } from "./__fixtures__/stubFeed.mjs";
import streamModule from "./module.mjs";
import { sseFrame } from "./sse.mjs";

const INSTRUMENTS = [
  { symbol: "NSE:NIFTY", lotSize: 1, refs: { dhan: { token: "13" } } },
  { symbol: "NSE:BANKNIFTY", lotSize: 1, refs: { dhan: { token: "25" } } },
  { symbol: "NSE:RELIANCE", lotSize: 1, refs: { dhan: { token: "2885" } } },
];

const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A WebSocket client that collects parsed messages. */
function wsClient(url, opts) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  const closed = new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
  return { ws, msgs, closed, open: new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej), ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))))) };
}

/** Open an SSE stream and parse events as they arrive. */
function sseClient(port, path, headers = {}) {
  const events = [];
  let res;
  const ready = new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (r) => {
      res = r;
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const line of block.split("\n")) {
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (m) ev[m[1]] = m[2];
          }
          if (ev.data) events.push({ id: ev.id, event: ev.event, data: JSON.parse(ev.data) });
        }
      });
      resolve(r);
    });
    req.on("error", reject);
  });
  return { events, ready, close: () => res?.destroy() };
}

let app;
let port;
let keyStore;
let key;
let record;
let feed;
let accounts;
const adapter = stubAdapter();

beforeAll(async () => {
  const { config } = loadConfig({
    raw: { server: { port: 0 }, dataDir: mkdtempSync(join(tmpdir(), "mcb-stream-")), logging: { level: "silent" }, stream: { maxClients: 4, heartbeatMs: 60_000 } },
    env: {},
  });
  keyStore = createFakeKeyStore();
  ({ key, record } = keyStore.addKey({ scopes: ["read"], accounts: ["dhan-main"] }));
  accounts = createFakeAccountManager({
    accounts: [{ id: "dhan-main", broker: "dhan", adapter: adapter.adapter, capabilities: ["feed"], creds: { clientId: "1", accessToken: "secret-token-xyz" } }],
    policies: { dhan: { feed: { maxConnections: 1, maxSubscriptions: 2 } } },
  });
  app = await createApp({
    config,
    modules: [streamModule],
    logger: createNullLogger(),
    overrides: { keyStore, accounts, symbols: createFakeSymbolService({ instruments: INSTRUMENTS }) },
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

const token = async () => (await keyStore.issueStreamToken(record)).token;

describe("WebSocket /v1/stream", () => {
  it("refuses a connection without credentials, with a reused token, or for a foreign Host", async () => {
    await expect(wsClient(`ws://127.0.0.1:${port}/v1/stream`).open).rejects.toThrow(/HTTP 401/);
    const t = await token();
    const a = wsClient(`ws://127.0.0.1:${port}/v1/stream?token=${t}`);
    await a.open;
    await expect(wsClient(`ws://127.0.0.1:${port}/v1/stream?token=${t}`).open).rejects.toThrow(/HTTP 401/);
    await expect(wsClient(`ws://127.0.0.1:${port}/v1/stream`, { headers: { Authorization: `Bearer ${key}`, Host: "evil.example" } }).open).rejects.toThrow(/HTTP 403/);
    a.ws.close();
    await a.closed;
  });

  it("fans one upstream subscription out to two clients and returns SUBSCRIPTION_LIMIT to the one that crosses the cap", async () => {
    const c1 = wsClient(`ws://127.0.0.1:${port}/v1/stream?token=${await token()}`);
    const c2 = wsClient(`ws://127.0.0.1:${port}/v1/stream`, { headers: { Authorization: `Bearer ${key}` } });
    await Promise.all([c1.open, c2.open]);
    expect(await waitFor(() => c1.msgs[0])).toMatchObject({ type: "heartbeat", seq: 1, clientId: expect.stringMatching(/^ws_/) });

    c1.ws.send(JSON.stringify({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:BANKNIFTY"], mode: "quote", id: "a" }));
    await waitFor(() => c1.msgs.find((m) => m.type === "snapshot"));
    c2.ws.send(JSON.stringify({ op: "subscribe", symbols: ["NSE:NIFTY", "NSE:RELIANCE"], id: "b" }));
    const err = await waitFor(() => c2.msgs.find((m) => m.type === "error"));
    expect(err).toMatchObject({ code: "SUBSCRIPTION_LIMIT", symbols: ["NSE:RELIANCE"], id: "b", op: "subscribe" });
    expect(c2.msgs.find((m) => m.type === "snapshot")).toMatchObject({ symbols: ["NSE:NIFTY"], id: "b" });
    expect(c1.msgs.find((m) => m.type === "error")).toBeUndefined();

    feed = await waitFor(() => adapter.last());
    expect(adapter.feeds).toHaveLength(1);
    expect(feed.subscribeCalls).toEqual([["13", "25"]]);
    feed.status(true);
    feed.tick("13", "NSE", 25012.5, { close: 25000 });
    const t1 = await waitFor(() => c1.msgs.find((m) => m.type === "tick"));
    const t2 = await waitFor(() => c2.msgs.find((m) => m.type === "tick"));
    expect(t1).toMatchObject({ symbol: "NSE:NIFTY", ltp: 25012.5, change: 12.5 });
    expect(t2).toMatchObject({ symbol: "NSE:NIFTY", ltp: 25012.5 });
    expect(t2).not.toHaveProperty("open"); // ltp mode
    expect(c1.msgs.some((m) => m.type === "status" && m.state === "up")).toBe(true);

    const stats = await (await fetch(`http://127.0.0.1:${port}/v1/stream/stats`, { headers: { Authorization: `Bearer ${key}` } })).json();
    expect(stats.data).toMatchObject({ clients: 2, symbols: 2, upstreams: [{ accountId: "dhan-main", connected: true, subscriptions: 2, limit: 2 }], downstream: { connections: 2, ws: 2, sse: 0 } });
    expect(stats.meta.requestId).toMatch(/^req_/);

    c1.ws.close();
    await c1.closed;
    await waitFor(() => feed.unsubscribeCalls.length === 1);
    expect(feed.unsubscribeCalls).toEqual([["25"]]); // NIFTY is still wanted by c2
    c2.ws.close();
    await c2.closed;
    await waitFor(() => feed.unsubscribeCalls.length === 2);
    expect(feed.unsubscribeCalls[1]).toEqual(["13"]);
  });

  it("answers bad frames with error messages and keeps the connection", async () => {
    const c = wsClient(`ws://127.0.0.1:${port}/v1/stream?token=${await token()}`);
    await c.open;
    c.ws.send("not json");
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    c.ws.send(JSON.stringify({ op: "ping", id: 9 }));
    await waitFor(() => c.msgs.find((m) => m.type === "heartbeat" && m.id === 9));
    expect(c.msgs.filter((m) => m.type === "error").map((m) => m.code)).toEqual(["INVALID_JSON", "VALIDATION_FAILED"]);
    c.ws.close();
    await c.closed;
  });

  it("stats needs a read key", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/v1/stream/stats`)).status).toBe(401);
  });
});

describe("SSE /v1/stream/sse", () => {
  it("streams the same messages as SSE events whose id is the seq", async () => {
    const s = sseClient(port, `/v1/stream/sse?token=${await token()}&symbols=NSE:NIFTY&mode=ltp`);
    const res = await s.ready;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    const snap = await waitFor(() => s.events.find((e) => e.event === "snapshot"));
    expect(snap.data).toMatchObject({ type: "snapshot", symbols: ["NSE:NIFTY"], mode: "ltp" });
    expect(String(snap.data.seq)).toBe(snap.id);
    const f = await waitFor(() => adapter.last()?.subs.has("NSE:13") && adapter.last());
    f.status(true);
    f.tick("13", "NSE", 25100);
    const tick = await waitFor(() => s.events.find((e) => e.event === "tick" && e.data.ltp === 25100));
    expect(tick.data).toMatchObject({ symbol: "NSE:NIFTY", ltp: 25100 });
    s.close();
    await waitFor(() => app.deps.streamHub.stats().clients === 0);
  });

  it("refuses bad requests with problem+json before streaming", async () => {
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/stream/sse?symbols=NSE:NIFTY`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("content-type")).toMatch(/problem\+json/);
    const headers = { Authorization: `Bearer ${key}` };
    expect((await fetch(`http://127.0.0.1:${port}/v1/stream/sse?symbols=NSE:NIFTY&mode=full`, { headers })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/v1/stream/sse`, { headers })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/v1/stream/sse?symbols=NSE:NIFTY&key=${key}`)).status).toBe(401);
  });

  it("lets EventSource reconnect to the same URL with the same token, one connection at a time", async () => {
    const t = await token();
    const path = `/v1/stream/sse?token=${t}&symbols=NSE:NIFTY&mode=ltp`;
    const a = sseClient(port, path);
    expect((await a.ready).statusCode).toBe(200);
    // While the first connection is open the token cannot open a second one.
    expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(401);
    // A different subscription on the same token is refused.
    expect((await fetch(`http://127.0.0.1:${port}/v1/stream/sse?token=${t}&symbols=NSE:RELIANCE&mode=ltp`)).status).toBe(401);
    a.close();
    await waitFor(() => app.deps.streamHub.stats().clients === 0);
    await new Promise((r) => setTimeout(r, 20));
    const b = sseClient(port, path);
    expect((await b.ready).statusCode).toBe(200);
    await waitFor(() => b.events.find((e) => e.event === "snapshot"));
    b.close();
    await waitFor(() => app.deps.streamHub.stats().clients === 0);
  });

  it("sseFrame formats one event", () => {
    expect(sseFrame({ type: "tick", seq: 4, ltp: 1 })).toBe('id: 4\nevent: tick\ndata: {"type":"tick","seq":4,"ltp":1}\n\n');
  });
});

describe("connection cap and shutdown", () => {
  it("refuses connections over stream.maxClients, then sends go_away to everyone on close", async () => {
    const clients = [];
    for (let i = 0; i < 4; i += 1) {
      const c = wsClient(`ws://127.0.0.1:${port}/v1/stream?token=${await token()}`);
      await c.open;
      clients.push(c);
    }
    await expect(wsClient(`ws://127.0.0.1:${port}/v1/stream?token=${await token()}`).open).rejects.toThrow(/HTTP 429/);
    const sseRes = await fetch(`http://127.0.0.1:${port}/v1/stream/sse?symbols=NSE:NIFTY`, { headers: { Authorization: `Bearer ${key}` } });
    expect(sseRes.status).toBe(429);
    expect(sseRes.headers.get("retry-after")).toBe("5");

    await app.close();
    app = null;
    for (const c of clients) {
      const closed = await c.closed;
      expect(closed.code).toBe(1001);
      expect(c.msgs.at(-1)).toMatchObject({ type: "go_away", reason: "shutdown", reconnectAfterMs: 3000 });
    }
    expect(adapter.last().closed).toBe(true);
  });
});
