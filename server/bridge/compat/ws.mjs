/**
 * Compat-style WebSocket (stream S14) at ws://127.0.0.1:4300/api/v1/ws, on top of the same StreamHub as /v1/stream:
 * one upstream feed per broker account however many clients listen.
 *
 *   -> { "action": "authenticate", "api_key": "<Bridge key>" }         within 15 s of connecting
 *   <- { "type": "auth", "status": "success", "broker": "dhan", "message": "Authentication successful" }
 *   -> { "action": "subscribe", "mode": "LTP" | "Quote" | "Depth" (or 1 | 2 | 3), "symbols": [{ "exchange": "NSE", "symbol": "RELIANCE" }] }
 *   <- { "type": "subscribe", "status": "success", "subscriptions": [{ symbol, exchange, mode, status }] }
 *   <- { "type": "market_data", "symbol": "RELIANCE", "exchange": "NSE", "mode": 1, "data": { ltp, ... } }
 *   -> { "action": "unsubscribe", "symbols": [...] }   or   { "action": "unsubscribe_all" }
 *
 * The Host/Origin checks already ran in core's upgrade pipeline. A slow reader loses ticks (the newest wins), never
 * memory: nothing is sent while more than 1 MB is waiting on the socket.
 */
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { expandScopes } from "../core/context.mjs";
import { fromCanonical, toCanonical } from "./mapping.mjs";

const AUTH_TIMEOUT_MS = 15_000;
const MAX_CONNECTIONS = 50;
const MAX_FRAME_BYTES = 64 * 1024;
const HIGH_WATER_BYTES = 1_048_576;
const MODE_IN = Object.freeze({ 1: "ltp", 2: "quote", 3: "depth", LTP: "ltp", QUOTE: "quote", DEPTH: "depth" });
const MODE_OUT = Object.freeze({ ltp: 1, quote: 2, depth: 3 });

/** Tick -> compat market_data payload. */
export function marketData(tick, mode, symbol, exchange) {
  const data = { ltp: tick.ltp, timestamp: tick.exchangeTs ?? tick.receivedAt };
  if (mode !== "ltp") Object.assign(data, { open: tick.open ?? 0, high: tick.high ?? 0, low: tick.low ?? 0, close: tick.close ?? 0, volume: tick.volume ?? 0, oi: tick.oi ?? 0, bid: tick.bid ?? 0, ask: tick.ask ?? 0 });
  if (mode === "depth" && tick.depth) {
    const lvl = (l) => ({ price: l.price, quantity: l.qty ?? l.quantity ?? 0, orders: l.orders ?? 0 });
    data.depth = { buy: (tick.depth.bids ?? []).map(lvl), sell: (tick.depth.asks ?? []).map(lvl) };
  }
  return { type: "market_data", symbol, exchange, mode: MODE_OUT[mode], data };
}

/**
 * @param {{ hub: object, keyStore: object, accounts: object, bus?: object, logger?: object, account?: string }} deps
 */
export function createCompatWs({ hub, keyStore, accounts, bus, logger, account }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: false });
  /** id -> { ws, keyId } */
  const sockets = new Map();
  bus?.on?.("key.revoked", ({ keyId } = {}) => {
    for (const s of sockets.values()) if (s.keyId === keyId) s.ws.close(4001, "key revoked");
  });

  function brokerName() {
    try {
      const list = accounts.list();
      return (account ? list.find((a) => a.id === account) : list.find((a) => a.broker !== "paper"))?.broker ?? null;
    } catch {
      return null;
    }
  }

  function attach(ws, req) {
    const ip = req?.socket?.remoteAddress ?? null;
    const id = `cws_${randomBytes(9).toString("base64url")}`;
    const entry = { ws, keyId: null };
    sockets.set(id, entry);
    /** canonical -> { symbol, exchange } as the client named it */
    const names = new Map();
    let authed = false;
    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const authTimer = setTimeout(() => {
      if (!authed) {
        send({ type: "error", status: "error", code: "AUTHENTICATION_TIMEOUT", message: "Send { action: authenticate, api_key } within 15 seconds." });
        ws.close(4000, "authentication timeout");
      }
    }, AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    hub.attachSink?.(id, (tick, mode) => {
      if (ws.bufferedAmount > HIGH_WATER_BYTES) return;
      const n = names.get(tick.symbol) ?? fromCanonical(tick.symbol);
      send(marketData(tick, mode, n.symbol, n.exchange));
    });

    async function onMessage(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return send({ type: "error", status: "error", code: "INVALID_JSON", message: "Each message must be one JSON object." });
      }
      const action = String(msg?.action ?? "").toLowerCase();
      if (action === "authenticate") {
        const rec = typeof msg.api_key === "string" ? await keyStore.authenticate(msg.api_key, { ip }) : null;
        if (!rec || !expandScopes(rec.scopes).has("read")) {
          send({ type: "auth", status: "error", message: "Invalid API key" });
          return ws.close(4001, "invalid api key");
        }
        authed = true;
        entry.keyId = rec.id;
        clearTimeout(authTimer);
        return send({ type: "auth", status: "success", message: "Authentication successful", broker: brokerName(), user_id: rec.label ?? rec.id, supported_features: { ltp: true, quote: true, depth: true } });
      }
      if (!authed) return send({ type: "error", status: "error", code: "NOT_AUTHENTICATED", message: "Authenticate first." });
      if (action === "subscribe") {
        const mode = MODE_IN[String(msg.mode ?? "LTP").toUpperCase()];
        if (!mode) return send({ type: "subscribe", status: "error", message: "mode must be LTP, Quote or Depth (1, 2 or 3)." });
        const list = Array.isArray(msg.symbols) ? msg.symbols.slice(0, 1000) : [];
        const subscriptions = [];
        const wanted = [];
        for (const s of list) {
          try {
            const c = toCanonical(s?.symbol, s?.exchange);
            names.set(c, { symbol: String(s.symbol).toUpperCase(), exchange: String(s.exchange).toUpperCase() });
            wanted.push(c);
          } catch (err) {
            subscriptions.push({ symbol: s?.symbol, exchange: s?.exchange, mode: MODE_OUT[mode], status: "error", message: err?.detail ?? "invalid symbol" });
          }
        }
        if (wanted.length) {
          const r = await hub.subscribe(id, wanted, mode);
          for (const c of r.accepted) subscriptions.push({ ...names.get(c), mode: MODE_OUT[mode], status: "success" });
          for (const rej of r.rejected) subscriptions.push({ ...(names.get(rej.symbol) ?? { symbol: rej.symbol }), mode: MODE_OUT[mode], status: "error", message: rej.message });
          // snapshot: the latest tick for each accepted symbol, so a client is never blank until the next tick
          for (const c of r.accepted) {
            const t = hub.lastTick(c);
            if (t) {
              const n = names.get(c);
              send(marketData(t, mode, n.symbol, n.exchange));
            }
          }
        }
        const okAll = subscriptions.every((x) => x.status === "success");
        return send({ type: "subscribe", status: okAll ? "success" : subscriptions.some((x) => x.status === "success") ? "partial" : "error", subscriptions, message: okAll ? "Subscription successful" : "Some symbols could not be subscribed" });
      }
      if (action === "unsubscribe") {
        const list = Array.isArray(msg.symbols) ? msg.symbols : [];
        const canon = [];
        for (const s of list) {
          try {
            canon.push(toCanonical(s?.symbol, s?.exchange));
          } catch {
            /* ignore unknown */
          }
        }
        hub.unsubscribe(id, canon);
        return send({ type: "unsubscribe", status: "success", message: `Unsubscribed ${canon.length} symbol(s)` });
      }
      if (action === "unsubscribe_all") {
        hub.unsubscribe(id, [...names.keys()]);
        names.clear();
        return send({ type: "unsubscribe", status: "success", message: "Unsubscribed from all symbols" });
      }
      if (action === "ping") return send({ type: "pong", timestamp: Date.now() });
      return send({ type: "error", status: "error", code: "UNKNOWN_ACTION", message: `Unknown action ${String(msg?.action ?? "").slice(0, 40)}.` });
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) return send({ type: "error", status: "error", code: "INVALID_JSON", message: "Send text frames." });
      onMessage(data.toString("utf8")).catch((err) => {
        logger?.warn?.("compat websocket message failed", { err: err?.message });
        send({ type: "error", status: "error", code: err?.code ?? "INTERNAL", message: err?.detail ?? "Internal error." });
      });
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(authTimer);
      sockets.delete(id);
      try {
        hub.dropClient(id);
      } catch {
        /* hub stopping */
      }
    });
  }

  return {
    async handleUpgrade({ req, socket, head, reject }) {
      if (sockets.size >= MAX_CONNECTIONS) return reject("429 Too Many Requests");
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, req));
    },
    close() {
      for (const s of sockets.values()) s.ws.close(1001, "shutting down");
      wss.close();
    },
    size: () => sockets.size,
  };
}
