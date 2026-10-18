/**
 * Live stream helper for the Mr. Chartist API Bridge (docs/asyncapi.yaml).
 *
 *   const s = bridge.stream({ symbols: ["NSE:NIFTY"], mode: "ltp" });
 *   s.on("tick", (t) => console.log(t.symbol, t.ltp));
 *   for await (const msg of s) { ... }          // or iterate every message
 *   s.close();
 *
 * Each connection uses a fresh single-use token from POST /v1/stream/token, so the API key never appears in a URL.
 * After a drop (or a `go_away` from a restarting Bridge) it reconnects with exponential back-off and jitter, then
 * re-subscribes everything it was asked for. The Bridge numbers messages with `seq`; a gap means ticks were conflated
 * for a slow reader (the newest value always arrives) and is reported as a "gap" event.
 *
 * Events: open, message, tick, snapshot, order, status, error (server error message), heartbeat, go_away, gap,
 * reconnecting, close, failure (could not connect; err).
 */

const WS_OPEN = 1;

async function resolveWebSocket(explicit) {
  if (explicit) return explicit;
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    return (await import("ws")).default;
  } catch {
    throw new Error("No WebSocket implementation: use Node 22+, or install the 'ws' package, or pass { WebSocket }.");
  }
}

export class BridgeStream {
  /**
   * @param {import("./client.mjs").BridgeClient} client
   * @param {{ symbols?: string[], mode?: "ltp"|"quote"|"depth", orders?: boolean | string[], reconnect?: boolean,
   *   maxBackoffMs?: number, WebSocket?: any }} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.reconnect = opts.reconnect !== false;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this._WebSocket = opts.WebSocket;
    /** symbol -> mode */
    this.subscriptions = new Map();
    for (const s of opts.symbols ?? []) this.subscriptions.set(s, opts.mode ?? "ltp");
    this.orders = opts.orders ?? false;
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.lastSeq = 0;
    this._listeners = new Map();
    this._queue = [];
    this._waiters = [];
    this._timer = null;
  }

  /** Add a listener. Returns a function that removes it. */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch {
        /* a listener's bug must not kill the stream */
      }
    }
  }

  /** Resolves once connected (or rejects when the first attempt cannot get a token). */
  async connect() {
    if (this.closed) return;
    let token;
    try {
      token = (await this.client.streamToken()).token;
    } catch (err) {
      this._emit("failure", err);
      if (err?.retryable === false && err?.status && err.status < 500 && err.status !== 429) {
        // Bad key or missing scope: retrying will not help.
        this.closed = true;
        this._finish();
        return;
      }
      this._scheduleReconnect();
      return;
    }
    const WebSocketImpl = await resolveWebSocket(this._WebSocket);
    if (this.closed) return;
    const url = `${this.client.baseUrl.replace(/^http/i, "ws")}/v1/stream?token=${encodeURIComponent(token)}`;
    const ws = new WebSocketImpl(url);
    this.ws = ws;
    this.lastSeq = 0;
    ws.onopen = () => {
      this.attempt = 0;
      this._emit("open", undefined);
      this._resubscribe();
    };
    ws.onmessage = (ev) => this._onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this._emit("close", undefined);
      if (!this.closed) this._scheduleReconnect();
      else this._finish();
    };
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.seq === "number") {
      if (this.lastSeq && msg.seq !== this.lastSeq + 1) this._emit("gap", { expected: this.lastSeq + 1, got: msg.seq });
      this.lastSeq = msg.seq;
    }
    this._emit("message", msg);
    if (typeof msg.type === "string") this._emit(msg.type, msg);
    if (msg.type === "go_away") {
      this._goAwayDelay = Math.max(0, Number(msg.reconnectAfterMs) || 0);
    }
    const w = this._waiters.shift();
    if (w) w({ value: msg, done: false });
    else if (this._queue.length < 10_000) this._queue.push(msg);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify(obj));
  }

  _resubscribe() {
    const byMode = new Map();
    for (const [sym, mode] of this.subscriptions) {
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode).push(sym);
    }
    for (const [mode, symbols] of byMode) for (let i = 0; i < symbols.length; i += 500) this._send({ op: "subscribe", symbols: symbols.slice(i, i + 500), mode });
    if (this.orders) this._send(Array.isArray(this.orders) ? { op: "subscribe_orders", accounts: this.orders } : { op: "subscribe_orders" });
  }

  _scheduleReconnect() {
    if (this.closed || !this.reconnect) {
      this.closed = true;
      this._finish();
      return;
    }
    const base = Math.min(this.maxBackoffMs, 500 * 2 ** this.attempt);
    const wait = this._goAwayDelay ?? base + Math.floor(Math.random() * base * 0.5);
    this._goAwayDelay = undefined;
    this.attempt += 1;
    this._emit("reconnecting", { attempt: this.attempt, waitMs: wait });
    this._timer = setTimeout(() => this.connect(), wait);
  }

  /** Subscribe more symbols (kept across reconnects). */
  subscribe(symbols, mode = "ltp") {
    const list = [].concat(symbols);
    for (const s of list) this.subscriptions.set(s, mode);
    this._send({ op: "subscribe", symbols: list, mode });
  }

  unsubscribe(symbols) {
    const list = [].concat(symbols);
    for (const s of list) this.subscriptions.delete(s);
    this._send({ op: "unsubscribe", symbols: list });
  }

  ping() {
    this._send({ op: "ping" });
  }

  /** Close for good (no reconnect). */
  close() {
    this.closed = true;
    clearTimeout(this._timer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    } else this._finish();
  }

  _finish() {
    for (const w of this._waiters.splice(0)) w({ value: undefined, done: true });
  }

  /** Async iteration over every server message until close(). */
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._queue.length) return Promise.resolve({ value: this._queue.shift(), done: false });
        if (this.closed && !this.ws) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this._waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
