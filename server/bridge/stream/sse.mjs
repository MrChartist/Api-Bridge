/**
 * Server-Sent Events endpoint: GET /v1/stream/sse?token=<stream token>&symbols=NSE:NIFTY,NSE:RELIANCE&mode=ltp[&orders=1][&budget=1]
 *
 * Same messages as the WebSocket (docs/asyncapi.yaml). Each event is
 *   id: <seq>\nevent: <type>\ndata: <JSON message>\n\n
 * SSE is one-way, so the subscription is fixed by the URL; to change it, open a new URL. A reconnect (the browser's
 * EventSource does this by itself, sending Last-Event-ID) always starts with a fresh snapshot, so nothing is replayed.
 * The route is `auth: "custom"`: this handler accepts a stream token or an Authorization / X-API-Key header.
 *
 * Reconnects with the same URL: stream tokens are single use, but EventSource reconnects to the very same URL after
 * any network blip. So a token that opened an SSE connection becomes a reconnect grant for THAT connection only:
 * the same token, the same symbols/mode/orders query, at most one open connection at a time, within
 * SSE_RECONNECT_GRACE_MS after the connection dropped, and only while the key is still usable. Revoking the key
 * drops its grants at once.
 */
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { BASE_HEADERS, createCors } from "../core/security.mjs";
import { authenticateStream, createClientSession, newClientId } from "./protocol.mjs";
import { STREAM_MODES } from "./streamHub.mjs";

/** Serialise one message as an SSE event. Exported for tests. @param {{ type: string, seq: number }} msg */
export function sseFrame(msg) {
  return `id: ${msg.seq}\nevent: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`;
}

/** How long after an SSE connection drops its token may reconnect the same URL. */
export const SSE_RECONNECT_GRACE_MS = 5 * 60_000;
const MAX_RECONNECT_GRANTS = 1000;

const tokenTag = (token) => createHash("sha256").update(String(token)).digest("base64url");
const subscriptionTag = (query) => ["symbols", "mode", "orders"].map((k) => `${k}=${query.get(k) ?? ""}`).join("&");
const usable = (r, t) => Boolean(r) && !r.revokedAt && !(r.expiresAt && Date.parse(r.expiresAt) <= t);

/**
 * @param {{ hub: object, bus: object, keyStore: object, registry: object, config: object, clock: { now(): number },
 *   logger: object, cors?: { allowedOrigins?: string[] } }} opts
 * @returns {(ctx: import("../core/context.mjs").RequestContext) => Promise<void>}
 */
export function createSseHandler({ hub, bus, keyStore, registry, config: cfg, clock, logger, cors, scheduler = null }) {
  const corsCheck = createCors(cors ?? {});
  /** @type {Map<string, { keyId: string, sub: string, active: boolean, expiresAt: number }>} token tag -> grant */
  const grants = new Map();
  bus?.on?.("key.revoked", ({ keyId } = {}) => {
    for (const [t, g] of grants) if (g.keyId === keyId) grants.delete(t);
  });
  const sweep = (t) => {
    for (const [id, g] of grants) if (!g.active && g.expiresAt <= t) grants.delete(id);
    while (grants.size >= MAX_RECONNECT_GRANTS) grants.delete(grants.keys().next().value);
  };

  /** Redeem a reconnect grant for this exact URL, or null when there is none. Throws when it exists but is in use. */
  async function fromGrant(token, query) {
    if (typeof token !== "string" || !token || token.length > 512) return null;
    const g = grants.get(tokenTag(token));
    const t = clock.now();
    if (!g || g.sub !== subscriptionTag(query)) return null;
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

  return async function sseHandler(ctx) {
    const token = ctx.query.get("token");
    let reused = await fromGrant(token, ctx.query);
    const key = reused ? reused.record : await authenticateStream({ keyStore, query: ctx.query, headers: ctx.req.headers, ip: ctx.clientIp });
    ctx.key = key;
    const symbols = (ctx.query.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const mode = ctx.query.get("mode") ?? "ltp";
    const orders = ["1", "true", "yes"].includes(String(ctx.query.get("orders") ?? "").toLowerCase());
    const budget = ["1", "true", "yes"].includes(String(ctx.query.get("budget") ?? "").toLowerCase());
    if (!STREAM_MODES.includes(mode)) throw new BridgeError("VALIDATION_FAILED", `mode must be one of ${STREAM_MODES.join(", ")}.`);
    if (!symbols.length && !orders) throw new BridgeError("VALIDATION_FAILED", "Give the symbols to stream, e.g. ?symbols=NSE:NIFTY,NSE:RELIANCE.");
    if (symbols.length > cfg.maxSymbolsPerRequest) throw new BridgeError("VALIDATION_FAILED", `Stream at most ${cfg.maxSymbolsPerRequest} symbols on one SSE URL.`);
    if (registry.full()) throw new BridgeError("RATE_LIMITED", "Too many stream connections are open on the Bridge. Close one and try again.", { retryAfterMs: 5000 });
    if (registry.fullFor?.(key.id)) throw new BridgeError("RATE_LIMITED", "This API key already has the most stream connections allowed (stream.maxClientsPerKey). Close one and try again.", { retryAfterMs: 5000 });
    let grant = reused?.grant ?? null;
    if (token && !grant) {
      sweep(clock.now());
      grant = { keyId: key.id, sub: subscriptionTag(ctx.query), active: false, expiresAt: 0 };
      grants.set(tokenTag(token), grant);
    }
    if (grant) grant.active = true;

    const { req, res } = ctx;
    const headers = {
      ...BASE_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": ctx.requestId,
    };
    const origin = req.headers.origin;
    if (typeof origin === "string" && corsCheck.isAllowed(origin)) Object.assign(headers, corsCheck.headersFor(origin));
    res.writeHead(200, headers);
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);
    res.write("retry: 3000\n\n");

    const transport = {
      kind: "sse",
      write: (msg) => {
        res.write(sseFrame(msg));
      },
      bufferedBytes: () => res.writableLength,
      close: () => {
        if (!res.writableEnded) res.end();
      },
      onDrain: (cb) => res.once("drain", cb),
    };
    const session = createClientSession({
      id: newClientId("sse"),
      kind: "sse",
      key,
      hub,
      bus,
      transport,
      config: cfg,
      clock,
      logger: ctx.log ?? logger,
      keyStore,
      scheduler,
      onClosed: (s) => registry.remove(s),
    });
    registry.add(session);
    res.on("close", () => {
      if (grant) {
        grant.active = false;
        grant.expiresAt = clock.now() + SSE_RECONNECT_GRACE_MS;
      }
      session.close("closed", false);
    });
    if (symbols.length) await session.handleOp({ op: "subscribe", symbols, mode });
    if (orders) await session.handleOp({ op: "subscribe_orders" });
    if (budget) await session.handleOp({ op: "subscribe_budget" });
  };
}
