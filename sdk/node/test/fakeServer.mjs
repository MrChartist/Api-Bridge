/**
 * A small fake Mr. Chartist API Bridge for the SDK tests (Node and Python). No broker, no real Bridge code: it
 * speaks the wire contract of docs/openapi.yaml closely enough to test clients.
 *
 *  - Auth: `Authorization: Bearer mcb_test_key`, else 401 problem+json.
 *  - Market data: /v1/ltp, /v1/quotes, /v1/history (json|csv), /v1/optionchain, /v1/orders (GET, paginated).
 *  - Order writes (POST /v1/orders, PATCH|DELETE /v1/orders/:id, POST /v1/orders/cancel-all) REQUIRE an
 *    Idempotency-Key and replay the stored result for a repeated key (Idempotency-Replayed: true).
 *  - Streaming: POST /v1/stream/token issues single-use tokens; WS /v1/stream?token= answers subscribe with a
 *    snapshot and pings with heartbeats; every message has a per-connection seq.
 *  - Test control (no auth): POST /__test/script { method, path, responses: [{ status, body, headers, delayMs,
 *    destroy }] } queues scripted replies for a route; GET /__test/requests lists what clients sent;
 *    POST /__test/reset; POST /__test/tick { symbol, ltp } broadcasts a tick; POST /__test/drop closes every socket.
 *
 * Run standalone: `node fakeServer.mjs` prints "PORT=<n>" and serves until stdin closes or SIGTERM.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

export const TEST_KEY = "mcb_test_key";

const problem = (status, code, detail, extra = {}) => ({
  status,
  body: { type: `https://bridge.mrchartist.local/errors/${code.toLowerCase().replace(/_/g, "-")}`, title: code, status, detail, code, retryable: false, requestId: "req_fake", ...extra },
  headers: { "Content-Type": "application/problem+json" },
});

export function createFakeBridge() {
  let requests = [];
  let scripts = new Map();
  let idem = new Map();
  let tokens = new Set();
  let orderSeq = 0;
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  const envelope = (data, extra = {}) => ({ status: 200, body: { data, meta: { requestId: "req_fake", ...extra.meta }, ...(extra.errors ? { errors: extra.errors } : {}) } });
  const freshness = { source: "stream", asOf: "2026-10-16T15:00:00+05:30", ageMs: 5, stale: false, accountId: "dhan-main", broker: "dhan" };

  function orderFrom(body, id) {
    return {
      orderId: id,
      clientOrderId: body?.clientOrderId ?? null,
      accountId: body?.account ?? "dhan-main",
      broker: "paper",
      mode: body?.mode ?? "paper",
      symbol: body?.symbol ?? "NSE:RELIANCE",
      side: body?.side ?? "BUY",
      quantity: body?.quantity ?? 1,
      filledQuantity: 0,
      orderType: body?.orderType ?? "LIMIT",
      product: body?.product ?? "CNC",
      status: "open",
      legs: [],
      placedAt: "2026-10-16T15:00:00+05:30",
      updatedAt: "2026-10-16T15:00:00+05:30",
    };
  }

  function idempotent(req, body, make, status = 200) {
    const key = req.headers["idempotency-key"];
    if (!key) return problem(400, "VALIDATION_FAILED", "Idempotency-Key is required by this fake.");
    const fingerprint = `${req.method} ${req.url.split("?")[0]} ${JSON.stringify(body ?? null)}`;
    const prior = idem.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return problem(409, "IDEMPOTENCY_KEY_REUSED", "Different parameters for this key.");
      return { ...prior.reply, headers: { ...(prior.reply.headers ?? {}), "Idempotency-Replayed": "true" } };
    }
    const reply = { status, body: { data: make(), meta: { requestId: "req_fake" } } };
    idem.set(key, { fingerprint, reply });
    return reply;
  }

  function route(req, url, body) {
    const p = url.pathname;
    const q = url.searchParams;
    if (req.method === "GET" && p === "/v1/health") return { status: 200, body: { status: "ok", version: "0.0.0-fake", apiVersion: "v1" } };
    if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return problem(401, "UNAUTHENTICATED", "A valid API key is required.");
    if (req.method === "GET" && p === "/v1/ltp") {
      const syms = (q.get("symbols") ?? "").split(",").filter(Boolean);
      const items = syms.filter((s) => s !== "NSE:NOPE").map((s) => ({ symbol: s.toUpperCase(), ltp: 25000.5, freshness }));
      const errors = syms.filter((s) => s === "NSE:NOPE").map((s) => ({ symbol: s, code: "SYMBOL_NOT_FOUND", message: "Not found." }));
      return envelope(items, { errors });
    }
    if (req.method === "GET" && p === "/v1/quotes") return envelope((q.get("symbols") ?? "").split(",").map((s) => ({ symbol: s, ltp: 100, open: 99, high: 101, low: 98, close: 99.5, change: 0.5, changePct: 0.5025, volume: 10, oi: null, bid: 99.95, ask: 100.05, bidQty: 1, askQty: 1, freshness })));
    if (req.method === "GET" && p === "/v1/history") {
      const candles = [
        { time: 1792122300, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 1792122600, open: 1.5, high: 2.5, low: 1, close: 2, volume: 12 },
      ];
      if (q.get("format") === "csv") return { status: 200, body: "time,open,high,low,close,volume,oi\r\n2026-10-16 09:15:00,1,2,0.5,1.5,10,\r\n", headers: { "Content-Type": "text/csv; charset=utf-8" } };
      return envelope({ symbol: q.get("symbol"), interval: q.get("interval"), candles, freshness: { ...freshness, source: "broker" }, partial: false });
    }
    if (req.method === "GET" && p === "/v1/optionchain") return envelope({ underlying: q.get("underlying"), expiry: q.get("expiry"), underlyingLtp: 25010, atmStrike: 25000, lotSize: 75, rows: [{ strike: 25000, ce: null, pe: null }], freshness });
    if (req.method === "GET" && p === "/v1/orders") {
      const page = Number(q.get("cursor") ?? "0");
      const items = [0, 1].map((i) => orderFrom({}, `PAPER-${page * 2 + i + 1}`));
      return envelope(items, { meta: { nextCursor: page < 2 ? String(page + 1) : null } });
    }
    if (req.method === "POST" && p === "/v1/orders") return idempotent(req, body, () => orderFrom(body, `PAPER-${(orderSeq += 1)}`), 201);
    if (req.method === "POST" && p === "/v1/orders/preview") return envelope({ ok: true, mode: "paper", checks: [], requiresHumanConfirmation: false });
    if (req.method === "POST" && p === "/v1/orders/cancel-all") return idempotent(req, body, () => ({ cancelled: ["PAPER-1"], failed: [] }));
    const m = /^\/v1\/orders\/([^/]+)$/.exec(p);
    if (m && req.method === "GET") return envelope(orderFrom({}, decodeURIComponent(m[1])));
    if (m && req.method === "PATCH") return idempotent(req, body, () => ({ ...orderFrom({}, decodeURIComponent(m[1])), price: body?.price ?? null }));
    if (m && req.method === "DELETE") return idempotent(req, body, () => ({ ...orderFrom({}, decodeURIComponent(m[1])), status: "cancelled" }));
    if (req.method === "GET" && p === "/v1/backup/quotes") {
      const items = (q.get("symbols") ?? "").split(",").map((s) => ({ symbol: s, ltp: 1201.8, freshness: { ...freshness, source: "backup", provider: "yahoo", accountId: null, broker: null } }));
      return envelope(items, { errors: [] });
    }
    if (req.method === "POST" && p === "/v1/scanner/jobs") {
      const job = { id: "scan_0123456789abcdef", status: "completed", request: body, progress: { total: 2, done: 2, matched: 1, errors: 0 }, results: [{ symbol: "NSE:TCS", values: { close: 4000, "rsi(14)": 61.2 }, source: "broker", accountId: "dhan-main" }], errors: [] };
      return { status: q.get("waitMs") ? 200 : 202, body: { data: q.get("waitMs") ? job : { ...job, status: "running", results: [] }, meta: { requestId: "req_fake" } } };
    }
    if (req.method === "GET" && p === "/v1/scanner/jobs/scan_0123456789abcdef") return envelope({ id: "scan_0123456789abcdef", status: "completed", progress: { total: 2, done: 2, matched: 1, errors: 0 }, results: [], errors: [] });
    if (req.method === "POST" && p === "/v1/safety/kill-switch") return envelope({ engaged: true, reason: body?.reason ?? null, by: "key", at: "2026-10-16T15:00:00+05:30" });
    if (req.method === "POST" && p === "/v1/stream/token") {
      const token = `st_${randomUUID()}`;
      tokens.add(token);
      return envelope({ token, expiresAt: "2026-10-16T15:01:00+05:30" });
    }
    return problem(404, "NOT_FOUND", `No route for ${p}.`);
  }

  function send(res, reply) {
    const headers = { ...(reply.headers ?? {}) };
    let text = reply.body;
    if (typeof text !== "string") {
      text = JSON.stringify(text);
      headers["Content-Type"] ??= "application/json; charset=utf-8";
    }
    headers["Content-Length"] = Buffer.byteLength(text);
    res.writeHead(reply.status, headers);
    res.end(text);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://fake");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      if (url.pathname.startsWith("/__test/")) {
        const name = url.pathname.slice(8);
        if (name === "script") {
          scripts.set(`${String(body.method).toUpperCase()} ${body.path}`, [...body.responses]);
          return send(res, { status: 204, body: "" });
        }
        if (name === "requests") return send(res, { status: 200, body: requests });
        if (name === "reset") {
          requests = [];
          scripts = new Map();
          idem = new Map();
          return send(res, { status: 204, body: "" });
        }
        if (name === "tick") {
          broadcast({ type: "tick", symbol: body.symbol, ltp: body.ltp, exchangeTs: null, receivedAt: Date.now(), accountId: "dhan-main", broker: "dhan" });
          return send(res, { status: 204, body: "" });
        }
        if (name === "drop") {
          for (const c of clients) c.ws.terminate();
          return send(res, { status: 204, body: "" });
        }
        return send(res, { status: 404, body: "" });
      }
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        idempotencyKey: req.headers["idempotency-key"] ?? null,
        authorization: req.headers.authorization ? "present" : null,
        userAgent: req.headers["user-agent"] ?? null,
        body: body ?? null,
      });
      const queue = scripts.get(`${req.method} ${url.pathname}`);
      if (queue && queue.length) {
        const r = queue.shift();
        if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
        if (r.destroy) return req.socket.destroy();
        return send(res, { status: r.status, body: r.body ?? "", headers: r.headers });
      }
      send(res, route(req, url, body));
    });
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  function broadcast(msg) {
    for (const c of clients) c.send(msg);
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://fake");
    const token = url.searchParams.get("token");
    if (url.pathname !== "/v1/stream" || !token || !tokens.delete(token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let seq = 0;
      const client = {
        ws,
        subs: new Set(),
        send(msg) {
          if (msg.type === "tick" && !this.subs.has(msg.symbol)) return;
          seq += 1;
          ws.send(JSON.stringify({ ...msg, seq }));
        },
      };
      clients.add(client);
      ws.on("close", () => clients.delete(client));
      client.send({ type: "heartbeat", time: Date.now(), conflated: 0 });
      ws.on("message", (data) => {
        let op;
        try {
          op = JSON.parse(String(data));
        } catch {
          return client.send({ type: "error", code: "VALIDATION_FAILED", message: "Not JSON.", retryable: false });
        }
        if (op.op === "subscribe") {
          for (const s of op.symbols) client.subs.add(s);
          client.send({ type: "snapshot", id: op.id, mode: op.mode ?? "ltp", symbols: op.symbols, ticks: op.symbols.map((s) => ({ symbol: s, ltp: 100 })), pending: [] });
        } else if (op.op === "unsubscribe") for (const s of op.symbols) client.subs.delete(s);
        else if (op.op === "ping") client.send({ type: "heartbeat", id: op.id, time: Date.now(), conflated: 0 });
      });
    });
  });

  return {
    server,
    /** Requests received so far (copies). */
    requests: () => requests.slice(),
    reset() {
      requests = [];
      scripts = new Map();
      idem = new Map();
    },
    script(method, path, responses) {
      scripts.set(`${method.toUpperCase()} ${path}`, [...responses]);
    },
    tick(symbol, ltp) {
      broadcast({ type: "tick", symbol, ltp, exchangeTs: null, receivedAt: Date.now(), accountId: "dhan-main", broker: "dhan" });
    },
    drop() {
      for (const c of clients) c.ws.terminate();
    },
    clientCount: () => clients.size,
    async listen(port = 0) {
      await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
      return server.address().port;
    },
    async close() {
      for (const c of clients) c.ws.terminate();
      for (const s of sockets) s.destroy();
      await new Promise((ok) => server.close(() => ok()));
    },
  };
}

// Standalone mode (used by the Python SDK tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = createFakeBridge();
  const port = await fake.listen(Number(process.argv[2] ?? 0));
  process.stdout.write(`PORT=${port}\n`);
  const stop = async () => {
    await fake.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", stop);
  process.stdin.resume();
}
