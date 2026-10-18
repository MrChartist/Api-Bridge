/**
 * Downstream streaming protocol, shared by the WebSocket (wsServer.mjs) and SSE (sse.mjs) endpoints. The full message
 * schemas are in docs/asyncapi.yaml; keep the two in step.
 *
 * Client -> server ops (WebSocket text frames; SSE takes the same subscribe/subscribe_orders through its URL):
 *   { "op": "subscribe", "symbols": ["NSE:NIFTY"], "mode": "ltp"|"quote"|"depth", "id"?: "c1" }
 *   { "op": "unsubscribe", "symbols": ["NSE:NIFTY"], "id"?: ... }
 *   { "op": "subscribe_orders", "accounts"?: ["dhan-main"], "id"?: ... }
 *   { "op": "unsubscribe_orders", "id"?: ... }
 *   { "op": "ping", "id"?: ... }
 *
 * Server -> client messages, every one with `type` and a per-connection `seq` (1, 2, 3 ... in wire order):
 *   heartbeat  { time, conflated, id?, clientId?, heartbeatMs? }   first message, every heartbeatMs, and the reply to ping
 *   snapshot   { id?, mode, symbols, ticks, pending }               reply to subscribe: latest known value per symbol
 *   tick       { symbol, ltp, ... }                                 fields depend on the mode (see tickBody)
 *   order      { order }                                            from "order.updated", only accounts the key may use
 *   status     { accountId, broker, state: up|stale|down, connected, reason, subscriptions }
 *   error      { code, message, retryable, id?, op?, symbols? }
 *   go_away    { reason, message, reconnectAfterMs }                then the server closes the connection
 *
 * Backpressure: a client that reads slower than ticks arrive never makes the Bridge buffer without bound. Ticks wait in
 * a per-symbol slot (a newer tick replaces the older one, whose seq is then never sent: a gap in seq means values were
 * conflated; the heartbeat says how many). Other messages wait in a FIFO capped at `maxQueuedMessages`; a client that
 * overflows it gets go_away "slow_consumer" and is disconnected. Nothing is written while the transport holds more
 * than `highWaterMarkBytes` unsent. Memory per client is therefore at most: one tick per subscribed symbol +
 * maxQueuedMessages + highWaterMarkBytes.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { expandScopes } from "../core/context.mjs";
import { BridgeError, ERROR_CODES } from "../core/errors.mjs";
import { STREAM_MODES } from "./streamHub.mjs";

const IST_OFFSET_MS = 330 * 60_000;
/** Epoch ms -> ISO-8601 with +05:30. */
export const istIso = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().replace("Z", "+05:30");

/** New connection id, e.g. "ws_k3j9..." (not secret; appears in logs and stats). */
export const newClientId = (kind) => `${kind}_${randomBytes(9).toString("base64url")}`;

const opId = z.union([z.string().max(64), z.number().int()]).optional();
const symbolList = z.array(z.string().min(1).max(100)).min(1).max(1000);
const accountId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/);

/** Zod schema for one client op. */
export const clientOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), symbols: symbolList, mode: z.enum(STREAM_MODES).default("ltp"), id: opId }).strict(),
  z.object({ op: z.literal("unsubscribe"), symbols: symbolList, id: opId }).strict(),
  z.object({ op: z.literal("subscribe_orders"), accounts: z.array(accountId).min(1).max(100).optional(), id: opId }).strict(),
  z.object({ op: z.literal("unsubscribe_orders"), id: opId }).strict(),
  z.object({ op: z.literal("ping"), id: opId }).strict(),
]);

/**
 * The tick fields a client sees in its mode. ltp: price and times; quote: + OHLC, volume, OI, best bid/ask and
 * change; depth: quote + `depth` when the broker feed carries it.
 * @param {import("../core/contracts.mjs").Tick & { depth?: object }} t
 * @param {import("../core/contracts.mjs").StreamMode} mode
 */
export function tickBody(t, mode) {
  const body = { symbol: t.symbol, ltp: t.ltp, exchangeTs: t.exchangeTs ?? null, receivedAt: t.receivedAt, accountId: t.accountId, broker: t.broker };
  if (mode === "ltp") return body;
  const change = typeof t.close === "number" && t.close > 0 ? +(t.ltp - t.close).toFixed(4) : null;
  Object.assign(body, {
    open: t.open ?? null,
    high: t.high ?? null,
    low: t.low ?? null,
    close: t.close ?? null,
    change,
    changePct: change === null ? null : +((change / t.close) * 100).toFixed(4),
    volume: t.volume ?? null,
    oi: t.oi ?? null,
    bid: t.bid ?? null,
    ask: t.ask ?? null,
    bidQty: t.bidQty ?? null,
    askQty: t.askQty ?? null,
  });
  if (mode === "depth" && t.depth) body.depth = t.depth;
  return body;
}

/** Error message body from any thrown value (unknown errors never leak their text). */
export function errorBody(err, extra = {}) {
  const e = err instanceof BridgeError ? err : new BridgeError("INTERNAL", "Something went wrong on the Bridge.");
  return { code: e.code, message: e.detail, retryable: Boolean(ERROR_CODES[e.code]?.retryable), ...extra };
}

/**
 * Authenticate a streaming connection: `?token=` (single-use stream token from POST /v1/stream/token), else an
 * `Authorization: Bearer <key>` or `X-API-Key` header. The key needs the read scope. API keys are never accepted in
 * the URL here.
 * @param {{ keyStore: object, query: URLSearchParams, headers: Record<string, any> }} opts
 * @returns {Promise<import("../core/context.mjs").KeyRecord>}
 */
export async function authenticateStream({ keyStore, query, headers }) {
  let record = null;
  const token = query.get("token");
  if (token) {
    record = token.length <= 512 ? await keyStore.verifyStreamToken(token) : null;
    if (!record) throw new BridgeError("UNAUTHENTICATED", "This stream token is not valid, was already used or has expired. Get a new one from POST /v1/stream/token.");
  } else {
    let raw = null;
    const auth = headers.authorization;
    const m = typeof auth === "string" ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
    if (m) raw = m[1];
    else if (typeof headers["x-api-key"] === "string" && headers["x-api-key"].trim()) raw = headers["x-api-key"].trim();
    if (!raw) throw new BridgeError("UNAUTHENTICATED", "Connect with ?token=<stream token> or an 'Authorization: Bearer <key>' header.");
    record = await keyStore.authenticate(raw, {});
    if (!record) throw new BridgeError("UNAUTHENTICATED", "This API key is not valid, has expired or was revoked.");
  }
  if (!expandScopes(record.scopes).has("read")) throw new BridgeError("SCOPE_REQUIRED", 'This API key needs the "read" scope to stream.');
  return record;
}

/**
 * Open sessions across both transports, for the global connection cap, stats and shutdown.
 * @param {{ max: number, maxPerKey?: number }} opts
 */
export function createSessionRegistry({ max, maxPerKey = Infinity }) {
  /** @type {Set<any>} */
  const sessions = new Set();
  const totals = { opened: 0, slowDisconnects: 0, conflated: 0 };
  return {
    full: () => sessions.size >= max,
    /** True when this key already holds maxPerKey connections, so one leaked key cannot take every slot. */
    fullFor(keyId) {
      let n = 0;
      for (const s of sessions) if (s.keyId === keyId && ++n >= maxPerKey) return true;
      return false;
    },
    add(s) {
      sessions.add(s);
      totals.opened += 1;
    },
    remove(s) {
      if (sessions.delete(s)) {
        totals.conflated += s.stats().conflatedTotal;
        if (s.closeReason === "slow_consumer") totals.slowDisconnects += 1;
      }
    },
    size: () => sessions.size,
    all: () => [...sessions],
    /** Send go_away to everyone and close. */
    goAwayAll(reason, message, reconnectAfterMs) {
      for (const s of [...sessions]) s.goAway(reason, message, reconnectAfterMs);
    },
    stats() {
      const list = [...sessions].map((s) => s.stats());
      return {
        connections: list.length,
        maxConnections: max,
        ws: list.filter((s) => s.kind === "ws").length,
        sse: list.filter((s) => s.kind === "sse").length,
        queued: list.reduce((n, s) => n + s.queued, 0),
        conflatedTicks: totals.conflated + list.reduce((n, s) => n + s.conflatedTotal, 0),
        slowDisconnects: totals.slowDisconnects,
        opened: totals.opened,
      };
    },
  };
}

/**
 * @typedef {{ kind: "ws"|"sse", write(msg: object): void, bufferedBytes(): number, close(code?: number, reason?: string): void,
 *   onDrain?: (cb: () => void) => void }} Transport
 *   write() serialises one message; bufferedBytes() is what the transport has not sent yet (ws.bufferedAmount,
 *   res.writableLength); onDrain(cb) calls cb once when the buffer has drained (falls back to polling).
 */

/**
 * One client connection: op handling, per-connection seq, conflating queue, heartbeats, order and status fan-out.
 * @param {{ id: string, kind: "ws"|"sse", key: import("../core/context.mjs").KeyRecord, hub: object, bus: object,
 *   transport: Transport, config: ReturnType<typeof import("./config.mjs").resolveStreamConfig>, clock: { now(): number },
 *   logger: object, keyStore?: object, onClosed?: (session: object) => void }} opts
 */
export function createClientSession({ id, kind, key, hub, bus, transport, config: cfg, clock, logger, keyStore, onClosed }) {
  const log = logger.child({ clientId: id, keyId: key.id });
  const now = () => clock.now();
  let seq = 0;
  /** @type {Map<string, object>} insertion order == seq order; "t:<symbol>" for ticks, "c:<seq>" for the rest */
  const queue = new Map();
  let control = 0;
  let conflatedSinceBeat = 0;
  let conflatedTotal = 0;
  let sent = 0;
  let flushQueued = false;
  let waitingDrain = false;
  let closed = false;
  /** @type {"*" | Set<string> | null} */
  let orderFilter = null;
  let tokens = cfg.maxOpsPerSecond;
  let refillAt = now();
  const offs = [];

  const session = {
    id,
    kind,
    keyId: key.id,
    closeReason: null,
    handleMessage,
    handleOp,
    goAway,
    close,
    stats: () => ({ id, kind, keyId: key.id, symbols: hub.clientSymbols?.(id).length ?? 0, queued: queue.size, sent, conflatedTotal, orders: orderFilter !== null }),
  };

  // ── queue ──
  function enqueue(msg, tickSymbol) {
    if (closed) return;
    seq += 1;
    const out = { type: msg.type, seq, ...msg };
    if (tickSymbol !== undefined) {
      const k = `t:${tickSymbol}`;
      if (queue.has(k)) {
        queue.delete(k);
        conflatedSinceBeat += 1;
        conflatedTotal += 1;
      }
      queue.set(k, out);
    } else {
      if (control >= cfg.maxQueuedMessages) {
        slowConsumer();
        return;
      }
      control += 1;
      queue.set(`c:${seq}`, out);
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushQueued || closed) return;
    flushQueued = true;
    queueMicrotask(flush);
  }

  function flush() {
    flushQueued = false;
    if (closed) return;
    while (queue.size > 0 && transport.bufferedBytes() < cfg.highWaterMarkBytes) {
      const [k, msg] = queue.entries().next().value;
      queue.delete(k);
      if (k.charCodeAt(0) === 99 /* c */) control -= 1;
      try {
        transport.write(msg);
        sent += 1;
      } catch (err) {
        log.debug("stream write failed", { code: err?.code });
        close("transport_error");
        return;
      }
    }
    if (queue.size > 0 && !waitingDrain) {
      waitingDrain = true;
      let fired = false;
      let poll = null;
      const resume = () => {
        if (fired) return;
        fired = true;
        clearTimeout(poll);
        waitingDrain = false;
        scheduleFlush();
      };
      poll = setTimeout(resume, transport.onDrain ? 250 : 25);
      poll.unref?.();
      transport.onDrain?.(resume);
    }
  }

  function writeDirect(msg) {
    seq += 1;
    try {
      transport.write({ type: msg.type, seq, ...msg });
      sent += 1;
    } catch {
      /* closing anyway */
    }
  }

  function slowConsumer() {
    log.info("stream client too slow; disconnecting", { queued: queue.size });
    goAway("slow_consumer", "Your connection is reading messages too slowly, so the Bridge closed it. Reconnect and subscribe to fewer symbols.", 1000);
  }

  // ── fan-out from the hub and the bus ──
  hub.attachSink(id, (tick, mode) => enqueue({ type: "tick", ...tickBody(tick, mode) }, tick.symbol));

  offs.push(
    bus.on("stream.status", (p) => {
      enqueue({ type: "status", accountId: p.accountId, broker: p.broker, state: p.state ?? (p.connected ? "up" : "down"), connected: Boolean(p.connected), reason: p.reason ?? null, subscriptions: p.subscriptions ?? 0 });
    }),
  );

  const onOrder = (p) => {
    if (orderFilter === null || !p || typeof p.accountId !== "string") return;
    if (orderFilter !== "*" && !orderFilter.has(p.accountId)) return;
    enqueue({ type: "order", order: p });
  };

  // ── heartbeat and key re-check ──
  const beat = setInterval(() => {
    enqueue({ type: "heartbeat", time: istIso(now()), conflated: conflatedSinceBeat });
    conflatedSinceBeat = 0;
    recheckKey();
  }, cfg.heartbeatMs);
  beat.unref?.();

  async function recheckKey() {
    if (!keyStore?.get) return;
    try {
      const rec = await keyStore.get(key.id);
      const expired = rec?.expiresAt && Date.parse(rec.expiresAt) <= now();
      if (!rec || rec.revokedAt || expired) goAway("key_revoked", "The API key behind this connection was revoked or has expired.", null);
    } catch {
      /* a key store that cannot answer must not drop healthy streams */
    }
  }

  // ── ops ──
  function allowOp() {
    const t = now();
    const elapsed = t - refillAt;
    if (elapsed > 0) {
      tokens = Math.min(cfg.maxOpsPerSecond, tokens + (elapsed / 1000) * cfg.maxOpsPerSecond);
      refillAt = t;
    }
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  /** Handle one raw text frame from the client. Never throws. @param {string} text */
  async function handleMessage(text) {
    if (closed) return;
    if (!allowOp()) {
      enqueue({ type: "error", ...errorBody(new BridgeError("RATE_LIMITED", `Send at most ${cfg.maxOpsPerSecond} messages a second on one connection.`, { retryAfterMs: 1000 })) });
      return;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      enqueue({ type: "error", ...errorBody(new BridgeError("INVALID_JSON", "Each message must be one JSON object.")) });
      return;
    }
    await handleOp(value);
  }

  /** Handle one parsed op object. Never throws. @param {unknown} value */
  async function handleOp(value) {
    if (closed) return;
    const parsed = clientOpSchema.safeParse(value);
    if (!parsed.success) {
      const rawId = value && typeof value === "object" && (typeof value.id === "string" || Number.isInteger(value.id)) ? value.id : undefined;
      const errors = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(message)"}: ${i.message}`);
      enqueue({ type: "error", ...errorBody(new BridgeError("VALIDATION_FAILED", `This message is not a valid op. ${errors.join("; ")}`), rawId === undefined ? {} : { id: rawId }) });
      return;
    }
    const op = parsed.data;
    const ref = op.id === undefined ? {} : { id: op.id };
    try {
      if (op.op === "subscribe") await doSubscribe(op, ref);
      else if (op.op === "unsubscribe") doUnsubscribe(op);
      else if (op.op === "subscribe_orders") doSubscribeOrders(op);
      else if (op.op === "unsubscribe_orders") orderFilter = null;
      else if (op.op === "ping") enqueue({ type: "heartbeat", time: istIso(now()), conflated: conflatedSinceBeat, ...ref });
    } catch (err) {
      if (!(err instanceof BridgeError)) log.error("stream op failed", { op: op.op, err });
      enqueue({ type: "error", ...errorBody(err, { op: op.op, ...ref }) });
    }
  }

  async function doSubscribe(op, ref) {
    const { accepted, rejected } = await hub.subscribe(id, op.symbols, op.mode);
    if (closed) return;
    if (accepted.length) {
      const ticks = [];
      const pending = [];
      for (const s of accepted) {
        const t = hub.lastTick(s);
        if (t) ticks.push(tickBody(t, op.mode));
        else pending.push(s);
        queue.delete(`t:${s}`); // the snapshot carries the latest value; an older queued tick would go backwards
      }
      enqueue({ type: "snapshot", ...ref, mode: op.mode, symbols: accepted, ticks, pending });
    }
    const byCode = new Map();
    for (const r of rejected) {
      if (!byCode.has(r.code)) byCode.set(r.code, { message: r.message, symbols: [] });
      byCode.get(r.code).symbols.push(r.symbol);
    }
    for (const [code, { message, symbols }] of byCode) {
      enqueue({ type: "error", code, message, retryable: Boolean(ERROR_CODES[code]?.retryable), op: "subscribe", symbols, ...ref });
    }
  }

  function doUnsubscribe(op) {
    const canon = op.symbols.map((s) => hub.canonicalFor?.(id, s) ?? s);
    hub.unsubscribe(id, op.symbols);
    for (const s of canon) if (s) queue.delete(`t:${s}`);
  }

  function doSubscribeOrders(op) {
    const allowed = key.accounts;
    let filter;
    if (op.accounts) {
      const forbidden = allowed === "*" ? [] : op.accounts.filter((a) => !allowed.includes(a));
      if (forbidden.length) throw new BridgeError("ACCOUNT_FORBIDDEN", `This key may not use account ${forbidden.join(", ")}.`);
      filter = new Set(op.accounts);
    } else filter = allowed === "*" ? "*" : new Set(allowed);
    if (orderFilter === null) offs.push(bus.on("order.updated", onOrder));
    orderFilter = filter;
  }

  // ── lifecycle ──
  /**
   * Tell the client why it is being disconnected, then close.
   * @param {string} reason  machine code: shutdown | slow_consumer | key_revoked | ...
   * @param {string} message @param {number | null} [reconnectAfterMs]
   */
  function goAway(reason, message, reconnectAfterMs = 1000) {
    if (closed) return;
    queue.clear();
    control = 0;
    writeDirect({ type: "go_away", reason, message, reconnectAfterMs });
    session.closeReason = reason;
    close(reason, true);
  }

  /** Close the session and release its subscriptions. Idempotent. */
  function close(reason = "closed", closeTransport = true) {
    if (closed) return;
    closed = true;
    session.closeReason ??= reason;
    clearInterval(beat);
    for (const off of offs.splice(0)) off();
    queue.clear();
    hub.dropClient(id);
    if (closeTransport) {
      try {
        transport.close(reason === "slow_consumer" ? 4008 : reason === "key_revoked" ? 4001 : 1001, reason);
      } catch {
        /* already closed */
      }
    }
    onClosed?.(session);
  }

  // First message: who we are and how often to expect heartbeats; then the current upstream states.
  enqueue({ type: "heartbeat", time: istIso(now()), conflated: 0, clientId: id, heartbeatMs: cfg.heartbeatMs });
  for (const p of hub.upstreamStatuses?.() ?? []) {
    enqueue({ type: "status", accountId: p.accountId, broker: p.broker, state: p.state, connected: p.connected, reason: p.reason ?? null, subscriptions: p.subscriptions });
  }
  return session;
}
