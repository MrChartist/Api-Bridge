/**
 * The two ways to read the event log live: Server-Sent Events (GET /v1/events/stream) and a WebSocket (/v1/events/ws).
 * Same events, same filters, same cursor:
 *
 *   ?topics=order.*,download.*     which topics (default "*": everything this key may see)
 *   ?accounts=dhan-main            only events about these accounts (a narrowing; a key never sees more than its own)
 *   ?since=<cursor>                first replay every kept event after this cursor, then go live; SSE also takes the
 *                                  Last-Event-ID header (the browser's EventSource sends it by itself on reconnect)
 *   ?token=<stream token>          single-use token from POST /v1/stream/token, or an Authorization / X-API-Key header
 *
 * The first message is `ready`: { cursor (newest event now), oldest (oldest kept), replayed, gap, gapReason }. gap=true
 * means events between the client's cursor and the oldest kept one are gone (retention) or the cursor is newer than
 * anything this Bridge knows; the client should re-read its state from REST. Then the replayed events, then live ones, in
 * cursor order with nothing missed in between (replay and subscription happen in the same step).
 *
 * A reader that falls behind by more than `maxBufferedBytes` is sent `go_away` ("slow_consumer") and closed; it comes back
 * with its cursor. Revoking or expiring the key ends its connections. Read-only: nothing a client sends changes the Bridge.
 */
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { BridgeError } from "../core/errors.mjs";
import { BASE_HEADERS, createCors } from "../core/security.mjs";
import { authenticateStream, newClientId } from "../stream/protocol.mjs";
import { CURSOR_RE, toEnvelope } from "./eventLog.mjs";
import { canSee, checkTopicPatterns, matchesAny, parsePatternList, topicInfo, viewerOf } from "./catalog.mjs";

/** How long after an SSE connection drops its token may reconnect the same URL (as the price stream does). */
export const RECONNECT_GRACE_MS = 5 * 60_000;
const MAX_GRANTS = 1000;
const MAX_CLIENT_FRAME_BYTES = 4096;

/** @param {{ max: number, maxPerKey: number }} opts */
export function createClientRegistry({ max, maxPerKey }) {
  const sessions = new Set();
  return {
    full: () => sessions.size >= max,
    fullFor(keyId) {
      let n = 0;
      for (const s of sessions) if (s.keyId === keyId && ++n >= maxPerKey) return true;
      return false;
    },
    add: (s) => sessions.add(s),
    remove: (s) => sessions.delete(s),
    all: () => [...sessions],
    stats: () => ({ connections: sessions.size, sse: [...sessions].filter((s) => s.kind === "sse").length, ws: [...sessions].filter((s) => s.kind === "ws").length, maxConnections: max }),
  };
}

/** Read and check the query shared by both transports. @param {URLSearchParams} query @param {string | undefined} lastEventId */
export function parseStreamQuery(query, lastEventId) {
  const checked = checkTopicPatterns(parsePatternList(query.get("topics")));
  if (!checked.ok) throw new BridgeError("VALIDATION_FAILED", checked.message, { errors: [{ path: "topics", message: checked.message }] });
  const rawSince = typeof lastEventId === "string" && lastEventId.trim() ? lastEventId.trim() : query.get("since");
  let since = null;
  if (rawSince !== null && rawSince !== "") {
    if (!CURSOR_RE.test(rawSince)) throw new BridgeError("VALIDATION_FAILED", "since must be a cursor from an earlier event (digits only), or 0 for everything kept.", { errors: [{ path: "since", message: "not a cursor" }] });
    since = Number(rawSince);
  }
  const acc = query.get("accounts");
  const accounts = acc ? new Set(acc.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  if (accounts && accounts.size > 100) throw new BridgeError("VALIDATION_FAILED", "At most 100 accounts.", { errors: [{ path: "accounts", message: "too many" }] });
  return { patterns: checked.patterns, since, accounts };
}

/**
 * One connected reader, whatever the transport. The transport turns messages into wire frames.
 * @param {{ eventLog: any, key: any, query: { patterns: string[], since: number | null, accounts: Set<string> | null }, cfg: any,
 *   transport: { kind: "sse"|"ws", ready(m: object): void, event(e: object): void, goAway(reason: string, message: string): void,
 *     buffered(): number, close(): void }, onClosed?: (session: object) => void, logger?: any }} opts
 */
export function openSession({ eventLog, key, query, cfg, transport, onClosed, logger }) {
  const viewer = viewerOf(key);
  const pass = (e) => canSee(viewer, e) && matchesAny(query.patterns, e.topic) && (!query.accounts || !topicInfo(e.topic)?.accounts || query.accounts.has(e.data?.accountId));
  let closed = false;
  let sent = 0;
  let off = () => {};
  const session = {
    id: newClientId(transport.kind),
    kind: transport.kind,
    keyId: key.id,
    sent: () => sent,
    isClosed: () => closed,
    goAway(reason, message) {
      if (closed) return;
      try {
        transport.goAway(reason, message);
      } catch {
        /* closing anyway */
      }
      session.close();
    },
    close() {
      if (closed) return;
      closed = true;
      off();
      try {
        transport.close();
      } catch {
        /* already closed */
      }
      onClosed?.(session);
    },
  };
  const deliver = (e) => {
    if (transport.buffered() > cfg.maxBufferedBytes) {
      session.goAway("slow_consumer", "This connection reads events too slowly. Reconnect with the last cursor you saw.");
      return;
    }
    transport.event(e);
    sent += 1;
  };
  const rep = eventLog.since(query.since, { filter: pass });
  try {
    transport.ready({ cursor: String(rep.latest), oldest: rep.oldest === null ? null : String(rep.oldest), replayed: rep.events.length, gap: rep.gap, gapReason: rep.gapReason, topics: query.patterns });
    for (const e of rep.events) deliver(e);
    if (!closed) off = eventLog.subscribe((e) => {
      if (!closed && pass(e)) deliver(e);
    });
  } catch (err) {
    logger?.debug?.("events client write failed", { code: err?.code });
    session.close();
  }
  return session;
}

/** One SSE frame. @param {{ id?: string, event: string, data: object }} f */
export const sseFrame = ({ id, event, data }) => `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const tokenTag = (token) => createHash("sha256").update(String(token)).digest("base64url");
const usable = (r, t) => Boolean(r) && !r.revokedAt && !(r.expiresAt && Date.parse(r.expiresAt) <= t);

/**
 * @param {{ eventLog: any, bus: any, keyStore: any, registry: ReturnType<typeof createClientRegistry>, cfg: any, clock: { now(): number },
 *   logger: any, cors?: { allowedOrigins?: string[] }, setInterval?: typeof setInterval, clearInterval?: typeof clearInterval }} opts
 */
export function createEventsSse({ eventLog, bus, keyStore, registry, cfg, clock, logger, cors, setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval }) {
  const corsCheck = createCors(cors ?? {});
  /** token tag -> { keyId, sub, active, expiresAt }: a token that opened a connection may reconnect the same URL for a while. */
  const grants = new Map();
  bus?.on?.("key.revoked", ({ keyId } = {}) => {
    for (const [t, g] of grants) if (g.keyId === keyId) grants.delete(t);
  });
  const subTag = (q) => ["topics", "accounts"].map((k) => `${k}=${q.get(k) ?? ""}`).join("&");

  async function fromGrant(token, query) {
    if (typeof token !== "string" || !token || token.length > 512) return null;
    const g = grants.get(tokenTag(token));
    const t = clock.now();
    if (!g || g.sub !== subTag(query)) return null;
    if (!g.active && g.expiresAt <= t) {
      grants.delete(tokenTag(token));
      return null;
    }
    if (g.active) throw new BridgeError("UNAUTHENTICATED", "This stream token is already in use by an open connection. Get a new one from POST /v1/stream/token.");
    const record = await keyStore.get?.(g.keyId);
    if (!usable(record, t)) {
      grants.delete(tokenTag(token));
      return null;
    }
    return { record, grant: g };
  }

  return async function handle(ctx) {
    const token = ctx.query.get("token");
    const reused = await fromGrant(token, ctx.query);
    const key = reused ? reused.record : await authenticateStream({ keyStore, query: ctx.query, headers: ctx.req.headers });
    ctx.key = key;
    const q = parseStreamQuery(ctx.query, typeof ctx.req.headers["last-event-id"] === "string" ? ctx.req.headers["last-event-id"] : undefined);
    if (registry.full()) throw new BridgeError("RATE_LIMITED", "Too many event connections are open on the Bridge. Close one and try again.", { retryAfterMs: 5000 });
    if (registry.fullFor(key.id)) throw new BridgeError("RATE_LIMITED", "This API key already has the most event connections allowed (events.maxClientsPerKey). Close one and try again.", { retryAfterMs: 5000 });
    let grant = reused?.grant ?? null;
    if (token && !grant) {
      for (const [id, g] of grants) if (!g.active && g.expiresAt <= clock.now()) grants.delete(id);
      while (grants.size >= MAX_GRANTS) grants.delete(grants.keys().next().value);
      grant = { keyId: key.id, sub: subTag(ctx.query), active: false, expiresAt: 0 };
      grants.set(tokenTag(token), grant);
    }
    if (grant) grant.active = true;

    const { req, res } = ctx;
    const headers = { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Request-Id": ctx.requestId };
    const origin = req.headers.origin;
    if (typeof origin === "string" && corsCheck.isAllowed(origin)) Object.assign(headers, corsCheck.headersFor(origin));
    res.writeHead(200, headers);
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);
    res.write("retry: 3000\n\n");

    let beat = null;
    const session = openSession({
      eventLog,
      key,
      query: q,
      cfg,
      logger,
      transport: {
        kind: "sse",
        ready: (m) => res.write(sseFrame({ id: m.cursor, event: "ready", data: m })),
        event: (e) => res.write(sseFrame({ id: String(e.seq), event: e.topic, data: toEnvelope(e) })),
        goAway: (reason, message) => res.write(sseFrame({ event: "go_away", data: { reason, message, reconnectAfterMs: reason === "key_revoked" ? null : 1000 } })),
        buffered: () => res.writableLength,
        close: () => {
          if (!res.writableEnded) res.end();
        },
      },
      onClosed: (s) => {
        clearIv(beat);
        registry.remove(s);
      },
    });
    if (!session.isClosed()) registry.add(session);
    res.on("close", () => {
      if (grant) {
        grant.active = false;
        grant.expiresAt = clock.now() + RECONNECT_GRACE_MS;
      }
      session.close();
    });
    beat = setIv(async () => {
      try {
        const rec = await keyStore.get?.(key.id);
        if (!usable(rec, clock.now())) {
          session.goAway("key_revoked", "The API key behind this connection was revoked or has expired.");
          return;
        }
        res.write(": keep-alive\n\n");
      } catch {
        session.close();
      }
    }, cfg.heartbeatMs);
    beat.unref?.();
    if (session.isClosed()) clearIv(beat);
  };
}

/**
 * @param {{ eventLog: any, keyStore: any, registry: ReturnType<typeof createClientRegistry>, cfg: any, clock: { now(): number }, logger: any }} opts
 */
export function createEventsWs({ eventLog, keyStore, registry, cfg, clock, logger }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES, perMessageDeflate: false, clientTracking: false });

  async function handleUpgrade({ req, socket, head, url, reject }) {
    let key;
    let q;
    try {
      key = await authenticateStream({ keyStore, query: url.searchParams, headers: req.headers });
      q = parseStreamQuery(url.searchParams, undefined);
    } catch (err) {
      reject(err?.code === "SCOPE_REQUIRED" ? "403 Forbidden" : err?.code === "VALIDATION_FAILED" ? "400 Bad Request" : "401 Unauthorized");
      return;
    }
    if (registry.full() || registry.fullFor(key.id)) {
      reject("429 Too Many Requests");
      return;
    }
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, key, q));
  }

  function attach(ws, key, q) {
    let alive = true;
    let liveness = null;
    const send = (m) => ws.send(JSON.stringify(m));
    const session = openSession({
      eventLog,
      key,
      query: q,
      cfg,
      logger,
      transport: {
        kind: "ws",
        ready: (m) => send({ type: "ready", ...m }),
        event: (e) => send({ type: "event", ...toEnvelope(e) }),
        goAway: (reason, message) => send({ type: "go_away", reason, message, reconnectAfterMs: reason === "key_revoked" ? null : 1000 }),
        buffered: () => ws.bufferedAmount,
        close: () => {
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, "closed");
        },
      },
      onClosed: (s) => {
        clearInterval(liveness);
        registry.remove(s);
      },
    });
    if (!session.isClosed()) registry.add(session);
    liveness = setInterval(async () => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        const rec = await keyStore.get?.(key.id);
        if (!usable(rec, clock.now())) {
          session.goAway("key_revoked", "The API key behind this connection was revoked or has expired.");
          return;
        }
        ws.ping();
      } catch {
        /* closing */
      }
    }, cfg.heartbeatMs);
    liveness.unref?.();
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data, isBinary) => {
      alive = true;
      // The only message a client may send is a ping. Nothing a client sends changes the Bridge.
      let op = null;
      try {
        op = isBinary ? null : JSON.parse(data.toString("utf8"));
      } catch {
        /* answered below */
      }
      if (op && op.op === "ping") send({ type: "pong", ...(op.id !== undefined ? { id: String(op.id).slice(0, 64) } : {}) });
      else send({ type: "error", code: "VALIDATION_FAILED", message: 'This stream is one way. Send {"op":"ping"} or nothing.' });
    });
    ws.on("error", () => {});
    ws.on("close", () => session.close());
  }

  return { handleUpgrade, close: () => wss.close() };
}
