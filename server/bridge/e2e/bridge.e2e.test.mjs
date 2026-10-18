/**
 * End-to-end: the REAL Bridge (every built-in module and real service, real HTTP listener on 127.0.0.1) with stub
 * broker adapters. Walks the product the way a user would: create keys → connect two broker accounts → quotes over
 * REST → live stream over WebSocket → UDF chart history → a TradingView alert creates a PAPER order → the kill switch
 * blocks orders → the audit log holds every step. Also proves the headline rate-limit claims: 20 concurrent
 * identical quote requests reach the broker as ONE call, and unpinned reads stay on the primary account when the
 * broker's terms do not allow pooling (pooling.e2e.test.mjs covers the "allowed" side).
 *
 * The steps share one Bridge and run in order.
 */
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hooksRuntimeFor } from "../hooks/module.mjs";
import { STOCKS, bootBridge, eventually, openStream, stubBroker } from "./fixtures.mjs";

const tokenOf = (sym) => STOCKS.find((s) => s.symbol === sym).token;

let bridge;
let zerodha;
const keys = {};
const keyIds = {};

beforeAll(async () => {
  zerodha = stubBroker("zerodha");
  bridge = await bootBridge({
    brokers: { zerodha },
    raw: {
      accounts: [
        // Both opt in to pooling, but Zerodha's policy entry says pooling "unknown", so unpinned reads must stay on
        // the primary account.
        { id: "zerodha-a", broker: "zerodha", label: "Zerodha (main)", marketData: { pooling: true } },
        { id: "zerodha-b", broker: "zerodha", label: "Zerodha (family)", marketData: { pooling: true } },
        { id: "paper", broker: "paper", label: "Practice" },
      ],
    },
  });
});

afterAll(async () => {
  await bridge?.close();
});

const quoteCalls = (account, token) => zerodha.calls.filter((c) => c.method === "fetchQuotes" && (!account || c.account === account) && (!token || c.tokens.includes(token)));

describe("Mr. Chartist API Bridge end to end", () => {
  it("boots with every service built, paper by default, and serves the local dashboard", async () => {
    const h = await bridge.http("/v1/health");
    expect(h.status).toBe(200);
    expect(Object.values(h.json.services).every((s) => s === "ready")).toBe(true);
    expect(bridge.deps.config.safety.liveTrading).toBe(false);

    const root = await bridge.http("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/dashboard");
    const page = await bridge.http("/dashboard");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    expect(page.text).toMatch(/Mr\. Chartist API Bridge/);
    expect((await bridge.http("/dashboard/app.js")).headers.get("content-type")).toMatch(/javascript/);
    expect((await bridge.http("/dashboard/..%2Fapp.mjs")).status).toBe(404);
  });

  it("refuses foreign Host headers and foreign Origins, but allows the dashboard's own origin", async () => {
    // fetch() will not send a custom Host header, so use node:http (as a DNS-rebinding page's browser would send it).
    const rebinding = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: bridge.port, path: "/v1/health", headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.once("error", reject);
      req.end();
    });
    expect(rebinding).toBe(403);
    const foreign = await bridge.http("/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    const same = await bridge.http("/v1/health", { headers: { Origin: bridge.base } });
    expect(same.status).toBe(200);
  });

  it("creates keys: an admin key from the CLI path, then read and paper keys over REST", async () => {
    const admin = await bridge.deps.keyStore.create({ label: "e2e admin", scopes: ["admin"], accounts: "*", expiresAt: null, allowQuery: false, clientKind: "other" });
    keys.admin = admin.key;
    const read = await bridge.http("/v1/keys", { method: "POST", key: keys.admin, body: { label: "charts", scopes: ["read"], allowQuery: true } });
    expect(read.status).toBe(201);
    expect(read.json.data.key).toMatch(/^mcb_[a-z2-7]{10}_/);
    keys.read = read.json.data.key;
    keyIds.read = read.json.data.record.id;
    const paper = await bridge.http("/v1/keys", { method: "POST", key: keys.admin, body: { label: "scripts", scopes: ["paper"] } });
    expect(paper.status).toBe(201);
    keys.paper = paper.json.data.key;

    const list = await bridge.http("/v1/keys", { key: keys.admin });
    expect(list.json.data.map((k) => k.label).sort()).toEqual(["charts", "e2e admin", "scripts"]);
    expect(list.text).not.toContain(keys.read.split("_")[2]);
    expect((await bridge.http("/v1/accounts")).status).toBe(401);
    expect((await bridge.http("/v1/keys", { key: keys.read })).status).toBe(403);
  });

  it("lists brokers with the fields a login form needs, and never any values", async () => {
    const r = await bridge.http("/v1/brokers", { key: keys.read });
    expect(r.status).toBe(200);
    const z = r.json.data.find((b) => b.id === "zerodha");
    expect(z).toMatchObject({ authKind: "apiKeyToken", credentialFields: ["apiKey", "accessToken"], loginFields: [] });
    expect(z.capabilities).toContain("quotes");
  });

  it("connects two accounts of the same broker; no credential is ever echoed back", async () => {
    for (const id of ["zerodha-a", "zerodha-b"]) {
      const r = await bridge.http(`/v1/accounts/${id}/session`, { method: "POST", key: keys.admin, body: { values: { apiKey: `key-${id}`, accessToken: `token-${id}` } } });
      expect(r.status).toBe(200);
      expect(r.json.data.state).toBe("connected");
      expect(r.text).not.toContain(`token-${id}`);
    }
    const accounts = await bridge.http("/v1/accounts", { key: keys.read });
    const byId = Object.fromEntries(accounts.json.data.map((a) => [a.id, a]));
    expect(byId["zerodha-a"].session.state).toBe("connected");
    expect(byId["zerodha-b"].session.state).toBe("connected");
    expect(byId.paper.session.state).toBe("connected");
    expect(byId["zerodha-a"].pooling).toBe(false); // opted in, but the broker policy does not allow pooling
    expect(accounts.text).not.toMatch(/token-zerodha/);
  });

  it("loads the instrument master once per broker and resolves canonical symbols", async () => {
    await bridge.deps.symbols.refresh();
    const r = await eventually(async () => {
      const x = await bridge.http("/v1/instruments/NSE:RELIANCE", { key: keys.read });
      return x.status === 200 ? x : null;
    });
    expect(r.json.data).toMatchObject({ symbol: "NSE:RELIANCE", exchange: "NSE", kind: "EQ", lotSize: 1 });
    const masterLoads = zerodha.calls.filter((c) => c.method === "fetchInstruments");
    expect(new Set(masterLoads.map((c) => c.account)).size).toBe(1); // one account per broker, not one per account
  });

  it("serves quotes over REST with a freshness label", async () => {
    const r = await bridge.http("/v1/quotes?symbols=NSE:RELIANCE,NSE:INFY", { key: keys.read });
    expect(r.status).toBe(200);
    const items = r.json.data.items ?? r.json.data;
    const rel = items.find((i) => i.symbol === "NSE:RELIANCE");
    expect(rel.ltp).toBe(1402.5);
    expect(rel.freshness).toMatchObject({ source: "broker", stale: false });
    expect(items.find((i) => i.symbol === "NSE:INFY").ltp).toBe(1510.25);
    expect(r.headers.get("ratelimit-policy")).toBeTruthy();
  });

  it("coalesces 20 concurrent identical quote requests into ONE broker call", async () => {
    const before = quoteCalls(null, tokenOf("TCS")).length;
    expect(before).toBe(0);
    const results = await Promise.all(Array.from({ length: 20 }, () => bridge.http("/v1/ltp?symbols=NSE:TCS&account=zerodha-a", { key: keys.read })));
    for (const r of results) {
      expect(r.status).toBe(200);
      const items = r.json.data.items ?? r.json.data;
      expect(items[0]).toMatchObject({ symbol: "NSE:TCS", ltp: 3105 });
    }
    expect(quoteCalls(null, tokenOf("TCS"))).toHaveLength(1);
    const usage = await bridge.http("/v1/usage", { key: keys.read });
    const s = usage.json.data.savings;
    expect(s.coalesced + s.servedFromCache + s.batched).toBeGreaterThanOrEqual(19);
  });

  it("keeps unpinned reads on the primary account when the broker's terms do not allow pooling", async () => {
    for (const sym of ["HDFCBANK", "ITC", "LT"]) {
      const r = await bridge.http(`/v1/ltp?symbols=NSE:${sym}&maxAgeMs=0`, { key: keys.read });
      expect(r.status).toBe(200);
    }
    expect(quoteCalls("zerodha-b")).toHaveLength(0);
    expect(quoteCalls("zerodha-a").length).toBeGreaterThan(0);
    // An explicitly pinned read still uses the account the caller named.
    const pinned = await bridge.http("/v1/ltp?symbols=NSE:ITC&account=zerodha-b&maxAgeMs=0", { key: keys.read });
    expect(pinned.status).toBe(200);
    expect(quoteCalls("zerodha-b")).toHaveLength(1);
  });

  let streamA;
  let streamB;
  it("streams over WebSocket: two clients share ONE broker subscription, and REST reads come from the stream", async () => {
    const tok = await bridge.http("/v1/stream/token", { method: "POST", key: keys.read });
    expect(tok.status).toBe(200);
    streamA = await openStream(`ws://127.0.0.1:${bridge.port}/v1/stream?token=${encodeURIComponent(tok.json.data.token)}`);
    streamA.send({ op: "subscribe", symbols: ["NSE:SBIN"], mode: "ltp", id: "s1" });
    await streamA.waitFor((m) => m.type === "snapshot" && m.id === "s1");
    const feed = await eventually(() => zerodha.feeds.find((f) => f.subs.has(tokenOf("SBIN"))));

    const tok2 = await bridge.http("/v1/stream/token", { method: "POST", key: keys.read });
    streamB = await openStream(`ws://127.0.0.1:${bridge.port}/v1/stream?token=${encodeURIComponent(tok2.json.data.token)}`);
    streamB.send({ op: "subscribe", symbols: ["NSE:SBIN"], mode: "ltp", id: "s2" });
    await streamB.waitFor((m) => m.type === "snapshot" && m.id === "s2");
    expect(zerodha.feeds.filter((f) => !f.closed)).toHaveLength(1);
    expect(feed.subscribeCalls.flat().filter((t) => t === tokenOf("SBIN"))).toHaveLength(1);

    // A stream token is single use.
    await expect(openStream(`ws://127.0.0.1:${bridge.port}/v1/stream?token=${encodeURIComponent(tok.json.data.token)}`)).rejects.toThrow();

    feed.tick(tokenOf("SBIN"), 815.5);
    const tA = await streamA.waitFor((m) => m.type === "tick" && m.symbol === "NSE:SBIN" && m.ltp === 815.5);
    const tB = await streamB.waitFor((m) => m.type === "tick" && m.symbol === "NSE:SBIN" && m.ltp === 815.5);
    expect(tA.seq).toBeGreaterThan(0);
    expect(tB.ltp).toBe(815.5);

    const r = await bridge.http("/v1/ltp?symbols=NSE:SBIN", { key: keys.read });
    const item = (r.json.data.items ?? r.json.data)[0];
    expect(item).toMatchObject({ symbol: "NSE:SBIN", ltp: 815.5 });
    expect(item.freshness.source).toBe("stream");
    expect(quoteCalls(null, tokenOf("SBIN"))).toHaveLength(0);
  });

  it("serves TradingView UDF chart history (with a read-only ?key=), and UDF errors in UDF format", async () => {
    const to = Math.floor(Date.parse("2026-10-17T00:00:00+05:30") / 1000);
    const from = to - 14 * 86_400;
    const r = await bridge.http(`/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=${from}&to=${to}&key=${encodeURIComponent(keys.read)}`);
    expect(r.status).toBe(200);
    expect(r.json.s).toBe("ok");
    expect(r.json.t.length).toBeGreaterThan(5);
    expect(r.json.c.every((c) => c === 1402.5)).toBe(true);
    const cfg = await bridge.http("/udf/config", { key: keys.read });
    expect(cfg.json.supported_resolutions).toContain("1D");

    // A bad key on a UDF route must still be a UDF body, or TradingView reads it as data.
    const bad = await bridge.http("/udf/symbols?symbol=NSE:RELIANCE&key=mcb_aaaaaaaaaa_nope");
    expect(bad.status).toBe(401);
    expect(bad.json).toMatchObject({ s: "error", code: "UNAUTHENTICATED" });
    expect(bad.json.errmsg).toBeTruthy();
    // Spreadsheet cells get #N/A, never problem+json.
    const cell = await bridge.http("/xl/ltp?symbol=NSE:RELIANCE");
    expect(cell.status).toBe(401);
    expect(cell.text).toBe("#N/A");
    const ok = await bridge.http(`/xl/ltp?symbol=NSE:RELIANCE&key=${encodeURIComponent(keys.read)}`);
    expect(ok.text).toBe("1402.5");
    // ?key= is refused for keys that can trade.
    expect((await bridge.http(`/udf/time?key=${encodeURIComponent(keys.paper)}`)).status).toBe(401);
  });

  let hookPath;
  it("a TradingView alert creates exactly one PAPER order, even when TradingView fires twice", async () => {
    const created = await bridge.http("/v1/hooks", { method: "POST", key: keys.admin, body: { source: "tradingview", label: "TV RELIANCE", account: "paper", product: "CNC", orderType: "MARKET", maxLotsPerSignal: 5 } });
    expect(created.status).toBe(201);
    hookPath = created.json.data.path ?? new URL(created.json.data.url).pathname;
    expect(hookPath).toMatch(/^\/hooks\/tradingview\//);
    const listed = await bridge.http("/v1/hooks", { key: keys.admin });
    expect(listed.text).not.toContain(hookPath.split("/").pop());

    const alert = { symbol: "NSE:RELIANCE", side: "buy", quantity: "2", id: "Long", time: "2026-10-19T04:31:00Z" };
    const first = await bridge.http(hookPath, { method: "POST", body: alert });
    expect(first.status).toBe(202);
    const again = await bridge.http(hookPath, { method: "POST", body: alert });
    expect(again.status).toBe(202);
    await hooksRuntimeFor(bridge.deps).worker.idle();

    const orders = await bridge.http("/v1/orders?account=paper", { key: keys.read });
    expect(orders.status).toBe(200);
    const fromHook = orders.json.data.filter((o) => o.source === "webhook");
    expect(fromHook).toHaveLength(1);
    expect(fromHook[0]).toMatchObject({ mode: "paper", symbol: "NSE:RELIANCE", side: "BUY", quantity: 2 });
    expect(fromHook[0].orderId).toMatch(/^PAPER-/);

    const bogus = await bridge.http(hookPath.replace(/[^/]+$/, "x".repeat(43)), { method: "POST", body: alert });
    expect([401, 404]).toContain(bogus.status);
  });

  it("a confirmation-required hook waits for a person, then places exactly the confirmed order", async () => {
    const created = await bridge.http("/v1/hooks", { method: "POST", key: keys.admin, body: { source: "tradingview", label: "TV confirm", account: "paper", product: "CNC", orderType: "MARKET", requireConfirmation: true } });
    expect(created.status).toBe(201);
    const path = created.json.data.path ?? new URL(created.json.data.url).pathname;
    expect((await bridge.http(path, { method: "POST", body: { symbol: "NSE:INFY", side: "BUY", quantity: "1", id: "C1", time: "2026-10-19T04:40:00Z" } })).status).toBe(202);
    const rt = hooksRuntimeFor(bridge.deps);
    await rt.worker.idle();
    const waiting = rt.worker.recent().find((r) => r.symbol === "NSE:INFY");
    expect(waiting.status).toBe("awaiting_confirmation");
    const countInfy = async () => (await bridge.http("/v1/orders?account=paper", { key: keys.read })).json.data.filter((o) => o.symbol === "NSE:INFY").length;
    expect(await countInfy()).toBe(0);

    const tickets = await bridge.http("/v1/tickets", { key: keys.admin });
    expect(tickets.json.data.map((t) => t.ticketId)).toContain(waiting.ticketId);
    const confirmed = await bridge.http(`/v1/tickets/${waiting.ticketId}/confirm`, { method: "POST", key: keys.admin });
    expect(confirmed.status).toBe(200);
    await eventually(async () => rt.worker.recent().find((r) => r.ticketId === waiting.ticketId && r.status === "placed"));
    await rt.worker.idle();
    expect(await countInfy()).toBe(1);
  });

  it("the kill switch blocks every new order (REST and webhooks) until an admin releases it", async () => {
    const engaged = await bridge.http("/v1/safety/kill-switch", { method: "POST", key: keys.read, body: { reason: "e2e: stop everything" } });
    expect(engaged.status).toBe(200);
    expect(engaged.json.data.engaged).toBe(true);

    const order = { account: "paper", symbol: "NSE:ITC", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" };
    const blocked = await bridge.http("/v1/orders", { method: "POST", key: keys.paper, body: order, headers: { "Idempotency-Key": "e2e-kill-1" } });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(blocked.status).toBeLessThan(500);
    expect(blocked.text).toMatch(/KILL_SWITCH/);

    await bridge.http(hookPath, { method: "POST", body: { symbol: "NSE:ITC", side: "buy", quantity: "1", id: "K1", time: "2026-10-19T04:45:00Z" } });
    await hooksRuntimeFor(bridge.deps).worker.idle();
    const rec = hooksRuntimeFor(bridge.deps).worker.recent().find((r) => r.symbol === "NSE:ITC");
    expect(rec.status).toBe("rejected");

    // Releasing needs an admin key and the word RELEASE.
    expect((await bridge.http("/v1/safety/kill-switch", { method: "DELETE", key: keys.read, body: { confirm: "RELEASE" } })).status).toBe(403);
    const released = await bridge.http("/v1/safety/kill-switch", { method: "DELETE", key: keys.admin, body: { confirm: "RELEASE" } });
    expect(released.status).toBe(200);
    expect(released.json.data.engaged).toBe(false);

    const placed = await bridge.http("/v1/orders", { method: "POST", key: keys.paper, body: order, headers: { "Idempotency-Key": "e2e-kill-2" } });
    expect(placed.status).toBe(201);
    expect(placed.json.data.mode).toBe("paper");
    const replay = await bridge.http("/v1/orders", { method: "POST", key: keys.paper, body: order, headers: { "Idempotency-Key": "e2e-kill-2" } });
    expect(replay.json.data.orderId).toBe(placed.json.data.orderId);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
  });

  it("refuses live orders: paper is the default and live needs explicit enablement", async () => {
    const r = await bridge.http("/v1/orders", { method: "POST", key: keys.paper, body: { account: "zerodha-a", symbol: "NSE:ITC", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET", mode: "live" } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(zerodha.calls.some((c) => /order/i.test(c.method))).toBe(false);
  });

  it("the audit log holds every step and its hash chain verifies", async () => {
    const r = await bridge.http("/v1/audit?limit=500", { key: keys.admin });
    expect(r.status).toBe(200);
    const types = new Set(r.json.data.map((x) => x.type));
    for (const t of ["key.created", "account.connected", "order.placed", "kill_switch.engaged", "kill_switch.released", "hook.signal", "ticket.confirmed"]) expect(types, t).toContain(t);
    for (const k of Object.values(keys)) expect(r.text).not.toContain(k);
    expect(r.text).not.toMatch(/token-zerodha/);
    const v = await bridge.http("/v1/audit/verify", { key: keys.admin });
    expect(v.status).toBe(200);
    expect(v.json.data.ok).toBe(true);
    expect((await bridge.http("/v1/audit", { key: keys.read })).status).toBe(403);
  });

  it("answers MCP over HTTP with read-only tools for a read key", async () => {
    const rpc = (body) => bridge.http("/mcp", { method: "POST", key: keys.read, body, headers: { Accept: "application/json, text/event-stream" } });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toMatch(/bridge/i);
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = list.json.result.tools.map((t) => t.name);
    expect(names).toContain("get_quotes");
    expect(names.some((n) => /order/.test(n) && !/^get_|^list_/.test(n))).toBe(false);
    const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_quotes", arguments: { symbols: ["NSE:RELIANCE"], account: null } } });
    expect(call.status).toBe(200);
    expect(JSON.stringify(call.json.result)).toMatch(/1402\.5/);
  });

  it("revoking a key closes its open streams at once and refuses its next request", async () => {
    const goAway = streamA.waitFor((m) => m.type === "go_away" && m.reason === "key_revoked", 2000);
    const r = await bridge.http(`/v1/keys/${keyIds.read}`, { method: "DELETE", key: keys.admin });
    expect([200, 204]).toContain(r.status);
    await goAway;
    expect((await bridge.http("/v1/ltp?symbols=NSE:SBIN", { key: keys.read })).status).toBe(401);
    streamB.close();
  });
});
