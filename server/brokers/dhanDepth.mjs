/**
 * Dhan v2 full market depth: 20 and 200 levels a side over WebSocket. Used by dhanMarket.fetchDepth when the
 * caller hints `levels: 20 | 200`; every failure there falls back to the 5-level REST quote.
 *
 * Official source: https://dhanhq.co/docs/v2/full-market-depth/ and the annexure (checked October 2026), with
 * the byte order confirmed against Dhan's own Python SDK (dhanhq/fulldepth.py: header `<hBBiI`, level `<dII`).
 *  - 20 levels:  wss://depth-api-feed.dhan.co/twentydepth?token=..&clientId=..&authType=2
 *                up to 50 instruments per connection. Subscribe { RequestCode: 23, InstrumentCount,
 *                InstrumentList: [{ ExchangeSegment, SecurityId }] }; 24 unsubscribes (annexure).
 *  - 200 levels: wss://full-depth-api.dhan.co/twohundreddepth?token=..&clientId=..&authType=2
 *                one instrument per connection. Subscribe { RequestCode: 23, ExchangeSegment, SecurityId }.
 *  - Only NSE_EQ and NSE_FNO are enabled. At most 5 WebSockets per user across Dhan's feeds; a sixth makes Dhan
 *    drop the FIRST one with code 805, so depth keeps to 4 and leaves one for the live market feed (dhanFeed.mjs).
 *  - Responses are little-endian binary, several packets stacked in one frame. Bids and asks come as separate
 *    packets. Header, 12 bytes:
 *        @0 message length  int16      @2 response code u8 (41 bid, 51 ask, 50 disconnect)
 *        @3 exchange segment u8         @4 security id   int32
 *        @8 uint32: message sequence (20 levels, ignored) or number of rows to read (200 levels)
 *    then levels of 16 bytes: price float64 @0, quantity uint32 @8, orders uint32 @12.
 *    20 levels: 12 + 20 x 16 = 332 bytes per packet. 200 levels: up to 12 + 200 x 16 = 3212 bytes.
 *  - Disconnect (50): reason int16 after the header (805 limit, 806 no data plan, 807 token expired,
 *    808 bad client id, 809 token invalid).
 *  - Dhan pings every 10 s; the `ws` library answers pongs on its own.
 *
 * The access token rides in the URL (Dhan's documented scheme); it is never logged here.
 */

import WebSocket from "ws";

export const DHAN_DEPTH20_URL = "wss://depth-api-feed.dhan.co/twentydepth";
export const DHAN_DEPTH200_URL = "wss://full-depth-api.dhan.co/twohundreddepth";
/** Segments Dhan enables for full depth. */
export const DEPTH_SEGMENTS = new Set(["NSE_EQ", "NSE_FNO"]);

const SEGMENT_NAME = { 0: "IDX_I", 1: "NSE_EQ", 2: "NSE_FNO", 3: "NSE_CURRENCY", 4: "BSE_EQ", 5: "MCX_COMM", 7: "BSE_CURRENCY", 8: "BSE_FNO" };
const HEADER = 12;
const LEVEL = 16;
const BID = 41;
const ASK = 51;
const DISCONNECT = 50;
const SUBSCRIBE = 23;
const UNSUBSCRIBE = 24;
const PER_SOCKET_20 = 50;

/**
 * Decode one binary frame of the 20- or 200-level feed. Pure. `levels` says which feed the frame came from: it
 * decides whether header bytes 8-11 are a row count (200) or a sequence number (20). Levels without a positive
 * price are dropped; a truncated tail is dropped rather than read as garbage.
 * @returns {Array<{ code: number, side?: "bid"|"ask", segment: string, securityId: string, levels?: Array<{ price: number, qty: number, orders: number }>, disconnectCode?: number }>}
 */
export function parseDhanDepthFrame(input, { levels = 20 } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const deep = levels === 200;
  const out = [];
  let off = 0;
  while (off + HEADER <= buf.length) {
    const declared = buf.readUInt16LE(off);
    const code = buf.readUInt8(off + 2);
    const segment = SEGMENT_NAME[buf.readUInt8(off + 3)] ?? "UNKNOWN";
    const securityId = String(buf.readUInt32LE(off + 4));
    const word = buf.readUInt32LE(off + 8);
    if (code === BID || code === ASK) {
      const rows = deep ? Math.min(word, 200) : 20;
      const size = declared >= HEADER ? declared : HEADER + rows * LEVEL;
      if (off + size > buf.length) break;
      const n = Math.min(rows, Math.floor((size - HEADER) / LEVEL));
      const list = [];
      for (let i = 0; i < n; i++) {
        const b = off + HEADER + i * LEVEL;
        const price = buf.readDoubleLE(b);
        if (!(Number.isFinite(price) && price > 0)) continue;
        // NSE ticks are paise; float64 noise is rounded away.
        list.push({ price: Math.round(price * 100) / 100, qty: buf.readUInt32LE(b + 8), orders: buf.readUInt32LE(b + 12) });
      }
      out.push({ code, side: code === BID ? "bid" : "ask", segment, securityId, levels: list });
      off += size;
    } else if (code === DISCONNECT) {
      let reason = off + HEADER + 2 <= buf.length ? buf.readInt16LE(off + HEADER) : 0;
      if (!(reason >= 800 && reason < 900) && word >= 800 && word < 900) reason = word;
      out.push({ code, segment, securityId, disconnectCode: reason });
      off += declared >= HEADER ? Math.min(declared, buf.length - off) : Math.min(HEADER + 2, buf.length - off);
    } else {
      if (declared < HEADER) break;
      off += declared;
    }
  }
  return out;
}

/** Depth over the socket is unavailable for this request; the caller falls back to REST. */
export class DepthUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DepthUnavailableError";
  }
}

// Cool-down after Dhan refuses: auth and plan problems will not fix themselves within a session.
const COOLDOWN_MS = { 805: 60_000, 806: 15 * 60_000, 807: 15 * 60_000, 808: 15 * 60_000, 809: 15 * 60_000 };
const CONNECT_FAIL_COOLDOWN_MS = 30_000;

/**
 * A per-user pool of depth sockets. book() answers the latest { bids, asks } for one instrument, opening or
 * reusing a socket within the limit and subscribing on demand. Instruments not asked for in `idleMs` are
 * unsubscribed and empty sockets closed. Nothing reconnects by itself: the next request opens what it needs.
 */
export function createDhanDepthPool({
  WebSocketImpl = WebSocket,
  maxSockets = 4,
  idleMs = 60_000,
  firstDataMs = 3000,
  evictAfterMs = 10_000,
  now = Date.now,
} = {}) {
  const clients = new Map(); // clientId -> { token, sockets: Set<Sock>, cooldownUntil, reason }
  let sweeper = null;

  const keyOf = (segment, securityId) => `${segment}:${securityId}`;
  const snapshot = (sub) => ({
    bids: (sub.bids ?? []).map((l) => ({ ...l })),
    asks: (sub.asks ?? []).map((l) => ({ ...l })),
  });
  const settle = (sub, err) => {
    const waiters = sub.waiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve(snapshot(sub));
    }
  };

  function send(sock, msg) {
    if (sock.open && sock.ws.readyState === 1) sock.ws.send(JSON.stringify(msg));
  }
  function subscribeMsg(sock, subs) {
    if (sock.kind === 200) {
      const s = subs[0];
      return { RequestCode: SUBSCRIBE, ExchangeSegment: s.segment, SecurityId: s.securityId };
    }
    return { RequestCode: SUBSCRIBE, InstrumentCount: subs.length, InstrumentList: subs.map((s) => ({ ExchangeSegment: s.segment, SecurityId: s.securityId })) };
  }

  function dropSocket(client, sock, err) {
    if (!client.sockets.delete(sock)) return;
    for (const sub of sock.subs.values()) settle(sub, err ?? new DepthUnavailableError("Dhan depth socket closed."));
    sock.subs.clear();
    if (sock.ws.readyState === 0 || sock.ws.readyState === 1) {
      try {
        if (sock.open) sock.ws.send(JSON.stringify({ RequestCode: 12 }));
        sock.ws.close();
      } catch { /* already closing */ }
    }
  }

  function openSocket(client, creds, kind) {
    const base = kind === 200 ? DHAN_DEPTH200_URL : DHAN_DEPTH20_URL;
    const url = `${base}?token=${encodeURIComponent(creds.accessToken)}&clientId=${encodeURIComponent(creds.clientId)}&authType=2`;
    const sock = { kind, ws: new WebSocketImpl(url), open: false, subs: new Map() };
    client.sockets.add(sock);
    sock.ws.on("open", () => {
      sock.open = true;
      const subs = [...sock.subs.values()];
      if (subs.length) send(sock, subscribeMsg(sock, subs));
    });
    sock.ws.on("message", (data, isBinary) => {
      if (isBinary === false) return;
      for (const p of parseDhanDepthFrame(data, { levels: kind })) {
        if (p.code === DISCONNECT) {
          const code = p.disconnectCode;
          client.cooldownUntil = now() + (COOLDOWN_MS[code] ?? CONNECT_FAIL_COOLDOWN_MS);
          client.reason = `Dhan closed the depth feed (code ${code}).`;
          dropSocket(client, sock, new DepthUnavailableError(client.reason));
          return;
        }
        const sub = sock.subs.get(keyOf(p.segment, p.securityId));
        if (!sub) continue;
        if (p.side === "bid") sub.bids = p.levels;
        else sub.asks = p.levels;
        if (sub.bids && sub.asks) settle(sub);
      }
    });
    sock.ws.on("error", () => { /* the close handler cleans up */ });
    sock.ws.on("close", () => {
      if (!sock.open && client.sockets.has(sock)) {
        // Refused at the handshake (bad token, no plan, network): do not retry on every poll.
        client.cooldownUntil = Math.max(client.cooldownUntil, now() + CONNECT_FAIL_COOLDOWN_MS);
        client.reason = "Dhan depth socket could not connect.";
      }
      dropSocket(client, sock);
    });
    ensureSweeper();
    return sock;
  }

  const lastUsed = (sock) => Math.max(0, ...[...sock.subs.values()].map((s) => s.lastUsed));

  /** Room for one more socket: free a slot held by the least recently used socket if it has gone quiet. */
  function makeRoom(client) {
    if (client.sockets.size < maxSockets) return true;
    let oldest = null;
    for (const s of client.sockets) if (!oldest || lastUsed(s) < lastUsed(oldest)) oldest = s;
    if (oldest && now() - lastUsed(oldest) >= evictAfterMs) {
      dropSocket(client, oldest);
      return true;
    }
    return false;
  }

  function clientOf(creds) {
    let c = clients.get(creds.clientId);
    if (c && c.token !== creds.accessToken) {
      // A new token: the old sockets were opened with the old one.
      for (const s of [...c.sockets]) dropSocket(c, s);
      c = null;
    }
    if (!c) {
      c = { token: creds.accessToken, sockets: new Set(), cooldownUntil: 0, reason: "" };
      clients.set(creds.clientId, c);
    }
    return c;
  }

  function findSub(client, kind, key) {
    for (const s of client.sockets) if (s.kind === kind && s.subs.has(key)) return s.subs.get(key);
    return null;
  }

  function addSub(client, creds, kind, segment, securityId) {
    let sock = null;
    if (kind === 20) for (const s of client.sockets) if (s.kind === 20 && s.subs.size < PER_SOCKET_20) { sock = s; break; }
    if (!sock) {
      if (!makeRoom(client)) throw new DepthUnavailableError("All Dhan depth sockets are in use.");
      sock = openSocket(client, creds, kind);
    }
    const sub = { segment, securityId, bids: null, asks: null, lastUsed: now(), waiters: [], sock };
    sock.subs.set(keyOf(segment, securityId), sub);
    if (sock.open) send(sock, subscribeMsg(sock, [sub]));
    return sub;
  }

  /** Latest book for one instrument at 20 or 200 levels. Rejects with DepthUnavailableError on any failure. */
  function book(creds, { segment, securityId }, levels) {
    if (!creds?.clientId || !creds?.accessToken) return Promise.reject(new DepthUnavailableError("Dhan depth needs clientId and accessToken."));
    if (levels !== 20 && levels !== 200) return Promise.reject(new DepthUnavailableError("Dhan full depth is 20 or 200 levels."));
    if (!DEPTH_SEGMENTS.has(segment)) return Promise.reject(new DepthUnavailableError(`Dhan full depth is not offered for ${segment}.`));
    const client = clientOf(creds);
    if (now() < client.cooldownUntil) return Promise.reject(new DepthUnavailableError(client.reason || "Dhan depth is cooling down."));
    sweep();
    const key = keyOf(segment, String(securityId));
    let sub;
    try {
      sub = findSub(client, levels, key) ?? addSub(client, creds, levels, segment, String(securityId));
    } catch (e) {
      return Promise.reject(e);
    }
    sub.lastUsed = now();
    if (sub.bids && sub.asks) return Promise.resolve(snapshot(sub));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = sub.waiters.indexOf(w);
        if (i >= 0) sub.waiters.splice(i, 1);
        // One side only (a one-sided book) is still an answer; nothing at all is not.
        if (sub.bids || sub.asks) resolve(snapshot(sub));
        else reject(new DepthUnavailableError("Dhan depth sent no data in time."));
      }, firstDataMs);
      sub.waiters.push(w);
    });
  }

  /** Unsubscribe instruments idle for `idleMs` and close sockets left empty. */
  function sweep() {
    const t = now();
    for (const client of clients.values()) {
      for (const sock of [...client.sockets]) {
        const idle = [...sock.subs.values()].filter((s) => t - s.lastUsed >= idleMs && s.waiters.length === 0);
        if (!idle.length) continue;
        if (idle.length === sock.subs.size) {
          dropSocket(client, sock);
          continue;
        }
        for (const s of idle) sock.subs.delete(keyOf(s.segment, s.securityId));
        if (sock.kind === 20) {
          send(sock, { RequestCode: UNSUBSCRIBE, InstrumentCount: idle.length, InstrumentList: idle.map((s) => ({ ExchangeSegment: s.segment, SecurityId: s.securityId })) });
        }
      }
    }
    if (![...clients.values()].some((c) => c.sockets.size)) stopSweeper();
  }

  function ensureSweeper() {
    if (sweeper) return;
    sweeper = setInterval(sweep, Math.max(1000, Math.floor(idleMs / 4)));
    sweeper.unref?.();
  }
  function stopSweeper() {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
  }

  function close() {
    for (const client of clients.values()) for (const s of [...client.sockets]) dropSocket(client, s);
    clients.clear();
    stopSweeper();
  }

  function stats() {
    const out = {};
    for (const [id, c] of clients) {
      out[id] = { sockets: [...c.sockets].map((s) => ({ kind: s.kind, open: s.open, instruments: s.subs.size })), coolingDown: now() < c.cooldownUntil };
    }
    return out;
  }

  return { book, sweep, close, stats };
}

let shared = null;
let injected = false;

/** The process-wide pool (Dhan's socket limit is per user, so one pool serves every caller). */
export function dhanDepthPool() {
  if (!shared) {
    // Tests never open real sockets: they inject a pool with a fake WebSocket.
    if (process.env.VITEST && !injected) return null;
    shared = createDhanDepthPool();
  }
  return shared;
}

/** Test hook: replace (or with null, reset) the shared pool. */
export function setDhanDepthPool(pool) {
  shared?.close?.();
  shared = pool;
  injected = Boolean(pool);
}
