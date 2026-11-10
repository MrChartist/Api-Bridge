/**
 * The events module end to end through the real app pipeline on a loopback port: SSE and WebSocket with cursor replay (also
 * across a restart), per-key scope and account filtering, the polling twin, the subscription routes with a fake receiver
 * (no network), and the promise that nothing here can approve an order or leak a secret.
 */
import http from "node:http";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createFakeKeyStore, createFakeSecretStore } from "../auth/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createLogger } from "../core/logger.mjs";
import { createFakeAuditLog } from "../safety/fake.mjs";
import { createEventsModule, ROUTES } from "./module.mjs";
import { SECRET, URL_OK, createFakeReceiver, publicDns, tmpDir } from "./testkit.mjs";

const open = [];
afterEach(async () => {
  for (const b of open.splice(0)) await b.close();
});

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function boot({ dir = tmpDir("mcb-events-http-"), events = {}, keep = false, receiver = createFakeReceiver({ clock: { now: () => Date.now() } }), dns = publicDns(), keyStore = createFakeKeyStore(), secrets = createFakeSecretStore() } = {}) {
  const logLines = [];
  const logger = createLogger({ level: "debug", write: (l) => logLines.push(l) });
  const { config } = loadConfig({ raw: { dataDir: dir, logging: { level: "debug" }, server: { port: 0 }, events: { heartbeatMs: 60_000, ...events } }, env: {} });
  const audit = createFakeAuditLog();
  const app = await createApp({ config, modules: [createEventsModule({ transport: receiver.transport, resolve: dns.resolve })], logger, overrides: { keyStore, secrets, audit } });
  const { port } = await app.listen();
  const keys = {
    admin: keyStore.addKey({ label: "admin", scopes: ["admin"], accounts: "*" }),
    read: keyStore.addKey({ label: "read", scopes: ["read"], accounts: "*" }),
    one: keyStore.addKey({ label: "one-account", scopes: ["read"], accounts: ["dhan-main"] }),
  };
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
            resolve({ status: res.statusCode, headers: res.headers, text, json });
          });
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  const emit = (topic, payload) => app.deps.bus.emit(topic, payload);
  const b = {
    app, port, dir, keys, request, emit, receiver, dns, keyStore, secrets, audit, logLines,
    async close() {
      await app.close();
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
  open.push(b);
  return b;
}

/** An SSE client that collects frames (events and comments). */
function sse(port, path, headers = {}) {
  const frames = [];
  let res;
  const opened = new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers, agent: false }, (r) => {
      res = r;
      let buf = "";
      let raw = "";
      r.setEncoding("utf8");
      r.on("data", (chunk) => {
        raw += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f = { comment: null };
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) f.comment = line.slice(1).trim();
            else {
              const m = /^(\w+): ?(.*)$/.exec(line);
              if (m) f[m[1]] = m[2];
            }
          }
          if (f.data) f.data = JSON.parse(f.data);
          frames.push(f);
        }
      });
      resolve(r);
    });
    req.on("error", reject);
  });
  const ended = new Promise((r) => opened.then((x) => x.on("close", r)).catch(r));
  return { frames, opened, ended, raw: () => res && undefined, events: () => frames.filter((f) => f.event && f.event !== "ready" && f.event !== "go_away"), named: (e) => frames.filter((f) => f.event === e), close: () => res?.destroy() };
}

function wsClient(url, opts) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  return { ws, msgs, closed, open: new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej), ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))))) };
}

const auth = (key) => ({ Authorization: `Bearer ${key}` });

describe("access", () => {
  it("needs a key on every route, and an admin key for the admin ones", async () => {
    const b = await boot();
    for (const [method, path] of ROUTES.map(([m, p]) => [m, p.replace(":subscriptionId", "sub_aaaaaaaa").replace(":deliveryId", "dlv_000000000000")])) {
      if (path === "/v1/events/stream") continue;
      const body = method === "GET" || method === "DELETE" || path.endsWith("/test") || path.endsWith("/retry") ? undefined : {};
      expect((await b.request({ method, path, body })).status, `${method} ${path} no key`).toBe(401);
    }
    for (const [method, path] of [["GET", "/v1/events/status"], ["GET", "/v1/subscriptions"], ["POST", "/v1/subscriptions"], ["GET", "/v1/subscriptions/sub_aaaaaaaa"], ["DELETE", "/v1/subscriptions/sub_aaaaaaaa"], ["POST", "/v1/subscriptions/sub_aaaaaaaa/test"]]) {
      expect((await b.request({ method, path, key: b.keys.read.key, body: method === "POST" && path === "/v1/subscriptions" ? {} : undefined })).status, `${method} ${path} read key`).toBe(403);
    }
    expect((await b.request({ path: "/v1/events/stream" })).status).toBe(401);
    expect((await b.request({ path: "/v1/events/topics", key: b.keys.read.key })).status).toBe(200);
  });

  it("is read-only on the wire: the event routes are GET only and no route is about confirming, approving or placing", async () => {
    const b = await boot();
    const mine = b.app.router.list().filter((r) => r.module === "events");
    expect(mine.length).toBe(ROUTES.length);
    for (const r of mine.filter((x) => x.pattern.startsWith("/v1/events"))) expect(r.method).toBe("GET");
    for (const r of mine) expect(r.pattern).not.toMatch(/confirm|approve|ticket|order|token/i);
    expect(b.app.router.list().filter((r) => r.module === "events" && r.method === "POST").map((r) => r.pattern).sort()).toEqual([
      "/v1/subscriptions",
      "/v1/subscriptions/:subscriptionId/dead-letters/:deliveryId/retry",
      "/v1/subscriptions/:subscriptionId/test",
    ]);
    // writes that reach an outside URL are this-computer-only
    for (const r of mine.filter((x) => x.method === "POST" || x.method === "PATCH" || x.method === "DELETE")) expect(r.options.loopbackOnly, `${r.method} ${r.pattern}`).toBe(true);
    // a remote admin key cannot delete a subscription or clear its dead letters (audit S12c)
    for (const path of ["/v1/subscriptions/sub_aaaaaaaa", "/v1/subscriptions/sub_aaaaaaaa/dead-letters"]) {
      const far = await b.request({ method: "DELETE", path, key: b.keys.admin.key, headers: { "X-Forwarded-For": "192.0.2.5" } });
      expect([path, far.status, far.json?.code]).toEqual([path, 403, "LOOPBACK_ONLY"]);
    }
    // a stream upgrade is not a write: a client's message cannot change anything
    const ws = wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws`, { headers: auth(b.keys.admin.key) });
    await ws.open;
    ws.ws.send(JSON.stringify({ op: "confirm", ticketId: "tkt_1", token: "mct_abcdefabcdef" }));
    ws.ws.send(JSON.stringify({ op: "ping", id: 7 }));
    await waitFor(() => ws.msgs.find((m) => m.type === "pong"));
    expect(ws.msgs.find((m) => m.type === "error")).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(ws.msgs.find((m) => m.type === "pong")).toMatchObject({ id: "7" });
    ws.ws.close();
  });
});

describe("topics and polling", () => {
  it("lists the topics a key may receive: a read key sees no admin-only topic", async () => {
    const b = await boot();
    const read = (await b.request({ path: "/v1/events/topics", key: b.keys.read.key })).json.data.map((t) => t.topic);
    const admin = (await b.request({ path: "/v1/events/topics", key: b.keys.admin.key })).json.data.map((t) => t.topic);
    expect(read).toContain("order.updated");
    expect(read).toContain("download.progress");
    for (const t of ["ticket.prepared", "hook.rejected", "backup.completed", "config.warning"]) {
      expect(read).not.toContain(t);
      expect(admin).toContain(t);
    }
    expect(read).not.toContain("tick");
  });

  it("replays as JSON with a cursor, per-key topic and account filtering, and reports gaps", async () => {
    const b = await boot();
    b.emit("order.updated", { orderId: "o1", accountId: "dhan-main", status: "filled" });
    b.emit("order.updated", { orderId: "o2", accountId: "kite-main", status: "filled" });
    b.emit("ticket.prepared", { ticketId: "tkt_1", accountId: "dhan-main", confirmToken: "mct_abcdefabcdefabcdef" });
    b.emit("download.done", { id: "d1", name: "nifty" });
    b.emit("tick", { symbol: "NSE:X", ltp: 1 }); // never offered
    const admin = (await b.request({ path: "/v1/events", key: b.keys.admin.key })).json;
    expect(admin.data.map((e) => e.topic)).toEqual(["order.updated", "order.updated", "ticket.prepared", "download.done"]);
    expect(admin.meta).toMatchObject({ cursor: "4", latest: "4", oldest: "1", gap: false, hasMore: false });
    const read = (await b.request({ path: "/v1/events", key: b.keys.read.key })).json;
    expect(read.data.map((e) => e.topic)).toEqual(["order.updated", "order.updated", "download.done"]);
    const one = (await b.request({ path: "/v1/events", key: b.keys.one.key })).json;
    expect(one.data.map((e) => e.id)).toEqual(["1", "4"]); // its own account's order and the account-less download
    // cursor, limit, topics
    const after = (await b.request({ path: "/v1/events?since=1&limit=1", key: b.keys.read.key })).json;
    expect(after.data.map((e) => e.id)).toEqual(["2"]);
    expect(after.meta).toMatchObject({ cursor: "2", hasMore: true });
    expect((await b.request({ path: "/v1/events?since=2&topics=download.*", key: b.keys.read.key })).json.data.map((e) => e.id)).toEqual(["4"]);
    expect((await b.request({ path: "/v1/events?topics=order.*&accounts=kite-main", key: b.keys.read.key })).json.data.map((e) => e.id)).toEqual(["2"]);
    expect((await b.request({ path: "/v1/events?limit=2", key: b.keys.admin.key })).json.data.map((e) => e.id)).toEqual(["3", "4"]);
    expect((await b.request({ path: "/v1/events?since=99", key: b.keys.read.key })).json.meta).toMatchObject({ gap: true, gapReason: "cursor_ahead", cursor: "99" });
    for (const bad of ["since=abc", "since=-1", "topics=nope", "topics=tick", "limit=0"]) {
      const r = await b.request({ path: `/v1/events?${bad}`, key: b.keys.read.key });
      expect([200, 400], bad).toContain(r.status);
      if (bad !== "limit=0") expect(r.status, bad).toBe(400);
    }
  });

  it("keeps what happened across a restart and continues the numbering", async () => {
    const dir = tmpDir("mcb-events-restart-");
    const keyStore = createFakeKeyStore();
    const a = await boot({ dir, keep: true, keyStore });
    a.emit("order.updated", { orderId: "o1", accountId: "p" });
    a.emit("order.updated", { orderId: "o2", accountId: "p" });
    await a.close();
    open.length = 0;
    const b = await boot({ dir, keyStore });
    const key = b.keys.read.key;
    expect((await b.request({ path: "/v1/events?since=1", key })).json.data.map((e) => e.data.orderId)).toEqual(["o2"]);
    b.emit("order.updated", { orderId: "o3", accountId: "p" });
    const r = (await b.request({ path: "/v1/events?since=1", key })).json;
    expect(r.data.map((e) => [e.id, e.data.orderId])).toEqual([["2", "o2"], ["3", "o3"]]);
  });
});

describe("SSE /v1/events/stream", () => {
  it("sends ready with the cursor, replays after ?since=, then live events in order", async () => {
    const b = await boot();
    b.emit("order.updated", { orderId: "o1", accountId: "p" });
    b.emit("order.updated", { orderId: "o2", accountId: "p" });
    const c = sse(b.port, "/v1/events/stream?since=1", auth(b.keys.read.key));
    const res = await c.opened;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const ready = await waitFor(() => c.named("ready")[0]);
    expect(ready).toMatchObject({ id: "2", data: { cursor: "2", oldest: "1", replayed: 1, gap: false, gapReason: null, topics: ["*"] } });
    b.emit("order.updated", { orderId: "o3", accountId: "p" });
    await waitFor(() => c.events().length >= 2);
    expect(c.events().map((f) => [f.id, f.event, f.data.id, f.data.data.orderId])).toEqual([["2", "order.updated", "2", "o2"], ["3", "order.updated", "3", "o3"]]);
    expect(c.events()[0].data).toMatchObject({ topic: "order.updated", apiVersion: "v1", time: expect.stringMatching(/Z$/) });
    c.close();
  });

  it("without ?since= it is live only; Last-Event-ID resumes like ?since=", async () => {
    const b = await boot();
    b.emit("order.updated", { orderId: "o1", accountId: "p" });
    const live = sse(b.port, "/v1/events/stream", auth(b.keys.read.key));
    await live.opened;
    await waitFor(() => live.named("ready")[0]);
    expect(live.named("ready")[0].data.replayed).toBe(0);
    b.emit("order.updated", { orderId: "o2", accountId: "p" });
    await waitFor(() => live.events().length === 1);
    expect(live.events()[0].data.data.orderId).toBe("o2");
    const resume = sse(b.port, "/v1/events/stream", { ...auth(b.keys.read.key), "Last-Event-ID": "1" });
    await resume.opened;
    await waitFor(() => resume.events().length === 1);
    expect(resume.events()[0].data.data.orderId).toBe("o2");
    live.close();
    resume.close();
  });

  it("says when events are gone: a cursor older than what is kept, or newer than anything known", async () => {
    const b = await boot({ events: { retain: 100 } });
    for (let i = 1; i <= 130; i += 1) b.emit("config.warning", { message: `w${i}` });
    const old = sse(b.port, "/v1/events/stream?since=5", auth(b.keys.admin.key));
    await old.opened;
    const r = await waitFor(() => old.named("ready")[0]);
    expect(r.data).toMatchObject({ gap: true, gapReason: "retention", oldest: "31", cursor: "130", replayed: 100 });
    const ahead = sse(b.port, "/v1/events/stream?since=5000", auth(b.keys.admin.key));
    await ahead.opened;
    expect((await waitFor(() => ahead.named("ready")[0])).data).toMatchObject({ gap: true, gapReason: "cursor_ahead", replayed: 0 });
    old.close();
    ahead.close();
  });

  it("filters by topic and account, and a read key never sees an admin-only event", async () => {
    const b = await boot();
    const read = sse(b.port, "/v1/events/stream", auth(b.keys.read.key));
    const one = sse(b.port, "/v1/events/stream?topics=order.*", auth(b.keys.one.key));
    const admin = sse(b.port, "/v1/events/stream?topics=ticket.*,hook.*", auth(b.keys.admin.key));
    await Promise.all([read.opened, one.opened, admin.opened]);
    await waitFor(() => read.named("ready")[0] && one.named("ready")[0] && admin.named("ready")[0]);
    b.emit("ticket.prepared", { ticketId: "tkt_1", accountId: "dhan-main", mode: "live", symbol: "NSE:X", side: "BUY", quantity: 1, confirmToken: "mct_abcdefabcdefabcdef" });
    b.emit("hook.rejected", { hookId: "h1", reason: "stale" });
    b.emit("order.updated", { orderId: "o1", accountId: "kite-main" });
    b.emit("order.updated", { orderId: "o2", accountId: "dhan-main" });
    b.emit("download.done", { id: "d1" });
    b.emit("safety.kill_switch", { engaged: true, reason: "test", by: "x" });
    await waitFor(() => read.events().length >= 3 && one.events().length >= 1 && admin.events().length >= 2);
    await settle();
    expect(read.events().map((f) => f.event)).toEqual(["order.updated", "order.updated", "download.done", "safety.kill_switch"]);
    expect(one.events().map((f) => f.data.data.orderId)).toEqual(["o2"]);
    expect(admin.events().map((f) => f.event)).toEqual(["ticket.prepared", "hook.rejected"]);
    for (const f of [...read.events(), ...one.events(), ...admin.events()]) expect(JSON.stringify(f)).not.toMatch(/mct_|confirmToken/);
    read.close();
    one.close();
    admin.close();
  });

  it("accepts a stream token, lets the same URL reconnect once after a drop, and refuses a second use at the same time", async () => {
    const b = await boot();
    const { token } = await b.keyStore.issueStreamToken(b.keys.read.record);
    const first = sse(b.port, `/v1/events/stream?token=${token}`);
    await first.opened;
    await waitFor(() => first.named("ready")[0]);
    const second = sse(b.port, `/v1/events/stream?token=${token}`);
    expect((await second.opened).statusCode).toBe(401); // in use
    first.close();
    await first.ended;
    await settle(50);
    const again = sse(b.port, `/v1/events/stream?token=${token}`, { "Last-Event-ID": "0" });
    expect((await again.opened).statusCode).toBe(200);
    await waitFor(() => again.named("ready")[0]);
    again.close();
    // a different filter is not the same URL: the grant does not apply, and the token was already used
    await settle(50);
    const other = sse(b.port, `/v1/events/stream?token=${token}&topics=order.*`);
    expect((await other.opened).statusCode).toBe(401);
  });

  it("refuses bad input with problem+json before the stream starts", async () => {
    const b = await boot();
    for (const [q, status] of [["topics=nope", 400], ["since=abc", 400], ["topics=tick", 400]]) {
      const r = await b.request({ path: `/v1/events/stream?${q}`, key: b.keys.read.key });
      expect(r.status, q).toBe(status);
      expect(r.headers["content-type"]).toMatch(/problem\+json/);
    }
    expect((await b.request({ path: "/v1/events/stream", headers: { authorization: "Bearer mcb_aaaaaaaaaa_bbbbbbbbbbbbbbbb" } })).status).toBe(401);
  });

  it("caps the connections per key", async () => {
    const b = await boot({ events: { maxClientsPerKey: 2 } });
    const a = [sse(b.port, "/v1/events/stream", auth(b.keys.read.key)), sse(b.port, "/v1/events/stream", auth(b.keys.read.key))];
    await Promise.all(a.map((c) => c.opened));
    await waitFor(() => a.every((c) => c.named("ready")[0]));
    const third = await b.request({ path: "/v1/events/stream", key: b.keys.read.key });
    expect(third.status).toBe(429);
    const other = sse(b.port, "/v1/events/stream", auth(b.keys.admin.key));
    expect((await other.opened).statusCode).toBe(200);
    for (const c of [...a, other]) c.close();
  });

  it("ends the connection with go_away when the key is revoked, and when the Bridge stops", async () => {
    const b = await boot();
    const victim = b.keyStore.addKey({ label: "temp", scopes: ["read"], accounts: "*" });
    const c = sse(b.port, "/v1/events/stream", auth(victim.key));
    await c.opened;
    await waitFor(() => c.named("ready")[0]);
    const d = sse(b.port, "/v1/events/stream", auth(b.keys.read.key));
    await d.opened;
    await waitFor(() => d.named("ready")[0]);
    await b.keyStore.revoke(victim.record.id);
    b.emit("key.revoked", { keyId: victim.record.id });
    await waitFor(() => c.named("go_away")[0]);
    expect(c.named("go_away")[0].data).toMatchObject({ reason: "key_revoked", reconnectAfterMs: null });
    await c.ended;
    expect(d.named("go_away")).toEqual([]); // another key's connection is untouched
    await b.app.close();
    open.length = 0;
    await waitFor(() => d.named("go_away")[0]);
    expect(d.named("go_away")[0].data).toMatchObject({ reason: "shutdown" });
  });
});

describe("a revoked key is noticed at the next heartbeat", () => {
  it("sends go_away key_revoked and closes", async () => {
    const b = await boot({ events: { heartbeatMs: 1000 } });
    const victim = b.keyStore.addKey({ label: "temp", scopes: ["read"], accounts: "*" });
    const c = sse(b.port, "/v1/events/stream", auth(victim.key));
    await c.opened;
    await waitFor(() => c.named("ready")[0]);
    await b.keyStore.revoke(victim.record.id);
    await waitFor(() => c.named("go_away")[0], 4000);
    expect(c.named("go_away")[0].data).toMatchObject({ reason: "key_revoked", reconnectAfterMs: null });
    await c.ended;
  });
});

describe("WebSocket /v1/events/ws", () => {
  it("authenticates like the price stream and replays from ?since=", async () => {
    const b = await boot();
    await expect(wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws`).open).rejects.toThrow(/HTTP 401/);
    await expect(wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws?topics=nope`, { headers: auth(b.keys.read.key) }).open).rejects.toThrow(/HTTP 400/);
    b.emit("order.updated", { orderId: "o1", accountId: "p" });
    b.emit("hook.failed", { hookId: "h", reason: "x" });
    b.emit("order.updated", { orderId: "o2", accountId: "p" });
    const { token } = await b.keyStore.issueStreamToken(b.keys.read.record);
    const c = wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws?since=0&topics=order.*,hook.*&token=${token}`);
    await c.open;
    await waitFor(() => c.msgs.filter((m) => m.type === "event").length >= 2);
    expect(c.msgs[0]).toMatchObject({ type: "ready", cursor: "3", oldest: "1", replayed: 2, gap: false });
    expect(c.msgs.filter((m) => m.type === "event").map((m) => [m.id, m.data.orderId])).toEqual([["1", "o1"], ["3", "o2"]]); // read key: no hook.failed
    b.emit("order.updated", { orderId: "o3", accountId: "p" });
    await waitFor(() => c.msgs.filter((m) => m.type === "event").length === 3);
    expect(c.msgs.at(-1)).toMatchObject({ type: "event", id: "4", topic: "order.updated", apiVersion: "v1" });
    c.ws.close();
    await c.closed;
    // the token was single use
    await expect(wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws?token=${token}`).open).rejects.toThrow(/HTTP 401/);
  });

  it("closes with go_away when the Bridge stops", async () => {
    const b = await boot();
    const c = wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws`, { headers: auth(b.keys.read.key) });
    await c.open;
    await waitFor(() => c.msgs[0]);
    await b.app.close();
    open.length = 0;
    await c.closed;
    expect(c.msgs.find((m) => m.type === "go_away")).toMatchObject({ reason: "shutdown" });
  });
});

describe("webhook subscription routes", () => {
  const create = (b, body = {}, key = b.keys.admin.key) => b.request({ method: "POST", path: "/v1/subscriptions", key, body: { url: URL_OK, topics: ["order.*"], secret: SECRET, ...body } });

  it("creates (this computer only), lists, reads, patches and deletes; the answers hold no secret and no URL path", async () => {
    const b = await boot();
    const r = await create(b, { label: "mine" });
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    const id = r.json.data.id;
    expect(r.json.data).toMatchObject({ target: "https://hooks.example.test/…", host: "hooks.example.test", topics: ["order.*"], active: true, label: "mine", signing: { algorithm: "hmac-sha256", version: "v1", replayWindowSec: 300 } });
    const list = await b.request({ path: "/v1/subscriptions", key: b.keys.admin.key });
    expect(list.json.data).toHaveLength(1);
    expect((await b.request({ path: `/v1/subscriptions/${id}`, key: b.keys.admin.key })).json.data.id).toBe(id);
    const patched = await b.request({ method: "PATCH", path: `/v1/subscriptions/${id}`, key: b.keys.admin.key, body: { topics: ["order.*", "download.*"], active: false } });
    expect(patched.json.data).toMatchObject({ topics: ["order.*", "download.*"], active: false });
    expect((await b.request({ method: "DELETE", path: `/v1/subscriptions/${id}`, key: b.keys.admin.key })).status).toBe(204);
    expect((await b.request({ path: `/v1/subscriptions/${id}`, key: b.keys.admin.key })).status).toBe(404);
    for (const x of [r, list, patched]) {
      expect(x.text).not.toContain(SECRET);
      expect(x.text).not.toContain("abc123");
    }
  });

  it("refuses a bad target, secret or topic, unknown fields, a bad id, and an empty patch", async () => {
    const b = await boot();
    for (const [body, path] of [
      [{ url: "http://hooks.example.test/x" }, "url"],
      [{ url: "https://127.0.0.1/x" }, "url"],
      [{ url: "https://169.254.169.254/latest/meta-data" }, "url"],
      [{ url: "https://user:pw@hooks.example.test/" }, "url"],
      [{ secret: "short" }, "secret"],
      [{ topics: ["tick"] }, "topics"],
    ]) {
      const r = await create(b, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.errors[0].path).toBe(path);
    }
    expect((await create(b, { extra: 1 })).status).toBe(400);
    expect((await create(b, { confirm: true })).status).toBe(400);
    expect((await b.request({ method: "POST", path: "/v1/subscriptions", key: b.keys.admin.key, body: "{}" })).status).toBe(400);
    expect((await b.request({ path: "/v1/subscriptions/bogus", key: b.keys.admin.key })).status).toBe(404);
    const id = (await create(b)).json.data.id;
    expect((await b.request({ method: "PATCH", path: `/v1/subscriptions/${id}`, key: b.keys.admin.key, body: {} })).status).toBe(400);
    expect((await b.request({ method: "PATCH", path: `/v1/subscriptions/${id}`, key: b.keys.admin.key, body: { url: "http://x.example.test" } })).status).toBe(400);
  });

  it("allows http and private targets only when the config file says so", async () => {
    const b = await boot({ events: { webhooks: { allowPrivateTargets: true } } });
    expect((await create(b, { url: "http://127.0.0.1:9000/in" })).status).toBe(201);
    expect((await create(b, { url: "http://169.254.169.254/latest" })).status).toBe(400);
  });

  it("sends a test delivery, keeps a delivery log and dead letters, and sends one again", async () => {
    const b = await boot();
    const id = (await create(b)).json.data.id;
    const t = await b.request({ method: "POST", path: `/v1/subscriptions/${id}/test`, key: b.keys.admin.key });
    expect(t.status).toBe(200);
    expect(t.json.data).toMatchObject({ ok: true, status: 200, willRetry: false });
    expect(b.receiver.calls[0]).toMatchObject({ signatureOk: true, url: URL_OK });
    expect((await b.request({ method: "POST", path: `/v1/subscriptions/${id}/test`, key: b.keys.admin.key })).status).toBe(429); // two seconds apart
    b.receiver.script({ status: 400 });
    b.emit("order.updated", { orderId: "o1", accountId: "p", status: "filled" });
    await waitFor(() => b.receiver.calls.length === 2);
    let letters;
    for (let i = 0; i < 100 && !letters?.length; i += 1) {
      await settle(10);
      letters = (await b.request({ path: `/v1/subscriptions/${id}/dead-letters`, key: b.keys.admin.key })).json.data;
    }
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ topic: "order.updated", reason: "http_4xx", status: 400 });
    const log = (await b.request({ path: `/v1/subscriptions/${id}/deliveries`, key: b.keys.admin.key })).json.data;
    expect(log.map((r) => [r.outcome, r.test])).toEqual([["dead", false], ["delivered", true]]);
    expect((await b.request({ path: `/v1/subscriptions/${id}/deliveries?outcome=dead`, key: b.keys.admin.key })).json.data).toHaveLength(1);
    expect((await b.request({ path: `/v1/subscriptions/${id}/deliveries?outcome=nope`, key: b.keys.admin.key })).status).toBe(400);
    const retry = await b.request({ method: "POST", path: `/v1/subscriptions/${id}/dead-letters/${letters[0].id}/retry`, key: b.keys.admin.key });
    expect(retry.status).toBe(202);
    await waitFor(() => b.receiver.calls.length === 3);
    await settle(30);
    expect((await b.request({ path: `/v1/subscriptions/${id}/dead-letters`, key: b.keys.admin.key })).json.data).toEqual([]);
    expect((await b.request({ method: "DELETE", path: `/v1/subscriptions/${id}/dead-letters`, key: b.keys.admin.key })).json.data).toEqual({ removed: 0 });
    const status = (await b.request({ path: "/v1/events/status", key: b.keys.admin.key })).json.data;
    expect(status).toMatchObject({ log: { latest: 1 }, webhooks: { subscriptions: 1, pending: 0, deadLetters: 0, allowPrivateTargets: false } });
  });

  it("audits changes without the secret or the URL path", async () => {
    const b = await boot();
    const id = (await create(b)).json.data.id;
    await b.request({ method: "PATCH", path: `/v1/subscriptions/${id}`, key: b.keys.admin.key, body: { secret: "another-secret-another-secret" } });
    await b.request({ method: "POST", path: `/v1/subscriptions/${id}/test`, key: b.keys.admin.key });
    await b.request({ method: "DELETE", path: `/v1/subscriptions/${id}`, key: b.keys.admin.key });
    expect(b.audit.records.map((r) => r.type)).toEqual(["subscription.created", "subscription.updated", "subscription.tested", "subscription.deleted"]);
    const text = JSON.stringify(b.audit.records);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("another-secret");
    expect(text).not.toContain("abc123");
    expect(b.audit.records[1].data.changed).toEqual(["secret"]);
  });

  it("delivers a bus event to a webhook end to end, signed, with the same envelope as the stream", async () => {
    const b = await boot();
    await create(b, { topics: ["order.updated"] });
    const stream = sse(b.port, "/v1/events/stream", auth(b.keys.read.key));
    await stream.opened;
    await waitFor(() => stream.named("ready")[0]);
    b.emit("order.updated", { orderId: "o9", accountId: "paper", status: "filled", filledQuantity: 5 });
    await waitFor(() => b.receiver.calls.length === 1 && stream.events().length === 1);
    expect(b.receiver.calls[0].signatureOk).toBe(true);
    expect(JSON.parse(b.receiver.calls[0].body)).toEqual(stream.events()[0].data);
    stream.close();
  });

  it("keeps secrets out of every log line", async () => {
    const b = await boot();
    const id = (await create(b)).json.data.id;
    b.receiver.script({ throws: "ECONNREFUSED", times: 2 });
    b.emit("order.updated", { orderId: "o1", accountId: "p" });
    await settle(60);
    await b.request({ method: "POST", path: `/v1/subscriptions/${id}/test`, key: b.keys.admin.key });
    await b.close();
    open.length = 0;
    const all = b.logLines.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("abc123");
  });
});

describe("events can never approve an order or carry a secret", () => {
  it("no response, frame or webhook body from the module has a confirm token, a key, a token or a secret", async () => {
    const b = await boot();
    const sub = await b.request({ method: "POST", path: "/v1/subscriptions", key: b.keys.admin.key, body: { url: URL_OK, topics: ["*", "ticket.prepared", "ticket.confirmed", "hook.rejected", "config.warning"], secret: SECRET } });
    const id = sub.json.data.id;
    const stream = sse(b.port, "/v1/events/stream", auth(b.keys.admin.key));
    const ws = wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws`, { headers: auth(b.keys.admin.key) });
    await Promise.all([stream.opened, ws.open]);
    await waitFor(() => stream.named("ready")[0] && ws.msgs[0]);
    const LEAKS = ["mct_abcdefabcdefabcdef", "mcb_abcdefghij_0123456789abcdef", "hunter2-passphrase", "sk-live-0123456789abcdef", "the-bot-token-0123456789"];
    b.emit("ticket.prepared", { ticketId: "tkt_1", accountId: "dhan-main", mode: "live", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, estimatedValue: 24000, source: "rest", client: "bot", expiresAt: "x", confirmToken: LEAKS[0], confirmExpiresAt: "y" });
    b.emit("ticket.confirmed", { ticketId: "tkt_1", accountId: "dhan-main", principal: "key:abc", token: LEAKS[0] });
    b.emit("hook.rejected", { hookId: "h1", label: "tv", reason: `bad key ${LEAKS[1]}`, passphrase: LEAKS[2], secret: LEAKS[3], symbol: "NSE:X" });
    b.emit("account.status", { accountId: "dhan-main", broker: "dhan", session: "expired", accessToken: LEAKS[4], message: `login with ${LEAKS[1]}` });
    b.emit("config.warning", { message: "careful", apiKey: LEAKS[3], nested: { authorization: `Bearer ${LEAKS[4]}`, ok: 1 } });
    await waitFor(() => stream.events().length >= 5 && b.receiver.calls.length >= 5);
    const seen = [
      stream.frames.map((f) => JSON.stringify(f)).join("\n"),
      JSON.stringify(ws.msgs),
      b.receiver.calls.map((c) => `${JSON.stringify(c.headers)}${c.body}`).join("\n"),
      (await b.request({ path: "/v1/events", key: b.keys.admin.key })).text,
      (await b.request({ path: `/v1/subscriptions/${id}`, key: b.keys.admin.key })).text,
      (await b.request({ path: "/v1/subscriptions", key: b.keys.admin.key })).text,
      (await b.request({ path: `/v1/subscriptions/${id}/deliveries`, key: b.keys.admin.key })).text,
      (await b.request({ path: `/v1/subscriptions/${id}/dead-letters`, key: b.keys.admin.key })).text,
      (await b.request({ path: "/v1/events/status", key: b.keys.admin.key })).text,
      (await b.request({ path: "/v1/events/topics", key: b.keys.admin.key })).text,
      sub.text,
    ].join("\n");
    for (const leak of [...LEAKS, SECRET]) expect(seen, leak).not.toContain(leak);
    // the subscription's own answers have no field about secrets, tokens or confirmations
    const keysOf = (v, out = new Set()) => {
      if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
      return out;
    };
    const subAnswers = [sub.json, (await b.request({ path: "/v1/subscriptions", key: b.keys.admin.key })).json, (await b.request({ path: `/v1/subscriptions/${id}/deliveries`, key: b.keys.admin.key })).json];
    for (const k of subAnswers.flatMap((a) => [...keysOf(a)])) expect(k, k).not.toMatch(/secret|token|confirm|passphrase|password|authorization/i);
    // and the events themselves kept their harmless fields
    expect(JSON.parse(b.receiver.calls.find((c) => c.headers["X-Bridge-Event-Topic"] === "ticket.prepared").body).data).toEqual({ ticketId: "tkt_1", accountId: "dhan-main", mode: "live", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10, estimatedValue: 24000, source: "rest", client: "bot", expiresAt: "x" });
    stream.close();
    ws.ws.close();
  });

  it("a \"*\" webhook gets read topics only; admin topics need their exact name, and a prefix that matches only admin topics is refused", async () => {
    const b = await boot();
    const star = await b.request({ method: "POST", path: "/v1/subscriptions", key: b.keys.admin.key, body: { url: URL_OK, topics: ["*"], secret: SECRET } });
    expect(star.status).toBe(201);
    const prefix = await b.request({ method: "POST", path: "/v1/subscriptions", key: b.keys.admin.key, body: { url: URL_OK, topics: ["ticket.*"], secret: SECRET } });
    expect(prefix.status).toBe(400);
    expect(prefix.json.detail).toMatch(/only matches admin topics/);
    b.emit("ticket.prepared", { ticketId: "tkt_1", accountId: "dhan-main", symbol: "NSE:RELIANCE", side: "BUY", quantity: 10 });
    b.emit("backup.completed", { path: "x" });
    b.emit("account.status", { accountId: "dhan-main", broker: "dhan", session: "expired" });
    await waitFor(() => b.receiver.calls.length >= 1);
    await settle(50);
    expect(b.receiver.calls.map((c) => JSON.parse(c.body).topic)).toEqual(["account.status"]);
  });

  it("ignores everything a receiver answers: no reply is read or acted on", async () => {
    const b = await boot();
    await b.request({ method: "POST", path: "/v1/subscriptions", key: b.keys.admin.key, body: { url: URL_OK, topics: ["ticket.prepared"], secret: SECRET } });
    let confirmed = 0;
    b.app.deps.bus.on("ticket.confirmed", () => (confirmed += 1));
    b.emit("ticket.prepared", { ticketId: "tkt_1", accountId: "dhan-main", confirmToken: "mct_abcdefabcdefabcdef" });
    await waitFor(() => b.receiver.calls.length === 1);
    await settle(30);
    expect(confirmed).toBe(0);
    expect(b.app.router.list().some((r) => /confirm/.test(r.pattern) && r.module === "events")).toBe(false);
  });
});

describe("switched off", () => {
  it("answers 422 on the stream and creates nothing when events.enabled is false", async () => {
    const b = await boot({ events: { enabled: false } });
    b.emit("order.updated", { orderId: "o1", accountId: "p" });
    expect((await b.request({ path: "/v1/events/stream", key: b.keys.read.key })).status).toBe(422);
    await expect(wsClient(`ws://127.0.0.1:${b.port}/v1/events/ws`, { headers: auth(b.keys.read.key) }).open).rejects.toThrow(/HTTP 404/);
    expect((await b.request({ path: "/v1/events", key: b.keys.read.key })).json.data).toEqual([]);
  });
});
