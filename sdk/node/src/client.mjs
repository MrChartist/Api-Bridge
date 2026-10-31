/**
 * Mr. Chartist API Bridge — Node client (Node 20+, no dependencies; `ws` is used for streaming only when the runtime
 * has no global WebSocket).
 *
 *   import { BridgeClient } from "@mrchartist/bridge-client";
 *   const bridge = new BridgeClient({ apiKey: process.env.MCB_API_KEY });
 *   const { data } = await bridge.ltp(["NSE:NIFTY", "NSE:RELIANCE"]);
 *   const { data: order, replayed } = await bridge.placeOrder({ account: "dhan-main", symbol: "NSE:RELIANCE", side: "BUY",
 *     quantity: 1, product: "CNC", orderType: "LIMIT", price: 2900 });          // paper unless you send mode: "live"
 *
 * Behaviour that matters for trading code:
 *  - Every order write (place, modify, cancel, cancel-all) carries an Idempotency-Key. One is generated per call
 *    unless you pass your own; it is kept across the client's own retries and returned with the result, so a retry
 *    can never create a second order.
 *  - Retries happen only when the Bridge says the request is `retryable` (honouring Retry-After), plus network
 *    failures of reads. A write that fails without a reply raises BridgeConnectionError with outcomeUnknown = true
 *    and is never retried automatically. OUTCOME_UNKNOWN from the Bridge is not retryable either.
 *  - Responses are returned as the Bridge sends them: `{ data, meta, errors? }` for /v1 routes, so freshness
 *    (`item.freshness`) and per-symbol errors stay visible.
 */
import { randomUUID } from "node:crypto";
import { BridgeApiError, BridgeConnectionError } from "./errors.mjs";
import { BridgeStream } from "./stream.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:4300";
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const MAX_RETRY_WAIT_MS = 30_000;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/** Query string from an object; undefined/null values are left out, arrays are comma-joined. */
export function toQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** A fresh idempotency key (UUID v4; matches the Bridge's ^[A-Za-z0-9_.:-]{8,255}$). */
export const newIdempotencyKey = () => randomUUID();

export class BridgeClient {
  /**
   * @param {{ baseUrl?: string, apiKey?: string, timeoutMs?: number, maxRetries?: number, retryBaseMs?: number,
   *   fetch?: typeof fetch, WebSocket?: any, userAgent?: string, sleep?: (ms: number) => Promise<void> }} [opts]
   *   baseUrl defaults to $MCB_BRIDGE_URL or http://127.0.0.1:4300; apiKey to $MCB_API_KEY.
   */
  constructor(opts = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    this.baseUrl = String(opts.baseUrl ?? env.MCB_BRIDGE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const key = opts.apiKey ?? env.MCB_API_KEY;
    // Keep the key off enumerable properties so console.log(client) / JSON.stringify never print it.
    Object.defineProperty(this, "_apiKey", { value: key, enumerable: false, writable: false });
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseMs = opts.retryBaseMs ?? 250;
    this._fetch = opts.fetch ?? globalThis.fetch;
    this._WebSocket = opts.WebSocket;
    this._sleep = opts.sleep ?? sleep;
    this.userAgent = opts.userAgent ?? "mrchartist-bridge-node/0.1";
    if (typeof this._fetch !== "function") throw new Error("This runtime has no fetch(); use Node 20 or later.");
  }

  /**
   * Low-level request. Returns the parsed JSON body (or text for non-JSON replies) plus status and headers.
   * @param {string} method
   * @param {string} path  e.g. "/v1/ltp"
   * @param {{ query?: object, body?: unknown, idempotencyKey?: string, headers?: Record<string, string>,
   *   signal?: AbortSignal, timeoutMs?: number, retries?: number }} [o]
   * @returns {Promise<{ status: number, headers: Headers, body: any }>}
   */
  async request(method, path, o = {}) {
    method = method.toUpperCase();
    const url = this.baseUrl + path + toQuery(o.query);
    const headers = { Accept: "application/json, text/plain;q=0.9, text/csv;q=0.8", "User-Agent": this.userAgent, ...(o.headers ?? {}) };
    if (this._apiKey) headers.Authorization = `Bearer ${this._apiKey}`;
    if (o.idempotencyKey) headers["Idempotency-Key"] = o.idempotencyKey;
    let payload;
    if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers["Content-Type"] = "application/json";
    }
    const maxRetries = o.retries ?? this.maxRetries;
    for (let attempt = 0; ; attempt += 1) {
      const ac = new AbortController();
      const onAbort = () => ac.abort(o.signal.reason);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(new Error("timeout")), o.timeoutMs ?? this.timeoutMs);
      let res;
      let text;
      try {
        res = await this._fetch(url, { method, headers, body: payload, signal: ac.signal, redirect: "error" });
        text = await res.text();
      } catch (cause) {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (o.signal?.aborted) throw cause;
        const timedOut = ac.signal.aborted;
        const safe = SAFE_METHODS.has(method);
        if (safe && attempt < maxRetries) {
          await this._sleep(this._backoff(attempt), o.signal);
          continue;
        }
        throw new BridgeConnectionError(
          safe
            ? `Could not reach the Bridge at ${this.baseUrl} (${timedOut ? "timed out" : cause?.code ?? cause?.message ?? "network error"}).`
            : `No reply from the Bridge for ${method} ${path}. The Bridge may have acted on it: check before sending it again${o.idempotencyKey ? `, or resend with the same Idempotency-Key ${o.idempotencyKey}` : ""}.`,
          { cause, method, path, outcomeUnknown: !safe, idempotencyKey: o.idempotencyKey, timedOut },
        );
      }
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      const ct = res.headers.get("content-type") ?? "";
      let body = text;
      if (/json/i.test(ct)) {
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      }
      if (res.ok) return { status: res.status, headers: res.headers, body };
      const problem =
        body && typeof body === "object" && typeof body.code === "string"
          ? { ...body, status: body.status ?? res.status }
          : { status: res.status, code: res.headers.get("x-error-code") ?? `HTTP_${res.status}`, title: res.statusText, detail: typeof body === "string" ? body.slice(0, 200) : undefined, retryable: false };
      if (problem.retryAfterMs === undefined) {
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra >= 0) problem.retryAfterMs = ra * 1000;
      }
      const err = new BridgeApiError(problem, { idempotencyKey: o.idempotencyKey });
      if (err.retryable && attempt < maxRetries) {
        await this._sleep(Math.min(MAX_RETRY_WAIT_MS, problem.retryAfterMs ?? this._backoff(attempt)), o.signal);
        continue;
      }
      throw err;
    }
  }

  _backoff(attempt) {
    const base = this.retryBaseMs * 2 ** attempt;
    return Math.min(MAX_RETRY_WAIT_MS, base + Math.floor(Math.random() * base));
  }

  async _get(path, query, o = {}) {
    return (await this.request("GET", path, { ...o, query })).body;
  }

  /** Order writes: always carry an Idempotency-Key and report whether the Bridge replayed a stored result. */
  async _write(method, path, body, o = {}) {
    const idempotencyKey = o.idempotencyKey ?? newIdempotencyKey();
    const r = await this.request(method, path, { body, idempotencyKey, signal: o.signal, timeoutMs: o.timeoutMs });
    return { ...r.body, replayed: r.headers.get("idempotency-replayed") === "true", idempotencyKey };
  }

  // ── System ──
  health() { return this._get("/v1/health"); }
  meta() { return this._get("/v1/meta"); }
  brokers() { return this._get("/v1/brokers"); }

  // ── Accounts and limits ──
  accounts() { return this._get("/v1/accounts"); }
  account(accountId) { return this._get(`/v1/accounts/${encodeURIComponent(accountId)}`); }
  async testAccount(accountId) { return (await this.request("POST", `/v1/accounts/${encodeURIComponent(accountId)}/test`)).body; }
  limits({ account } = {}) { return this._get("/v1/limits", { account }); }
  usage() { return this._get("/v1/usage"); }

  // ── Instruments ──
  searchInstruments({ q, exchange, kind, underlying, expiry, limit, cursor } = {}) { return this._get("/v1/instruments/search", { q, exchange, kind, underlying, expiry, limit, cursor }); }
  instrument(symbol, { include } = {}) { return this._get(`/v1/instruments/${encodeURIComponent(symbol)}`, { include }); }
  convertSymbol(input, { from, exchange, broker } = {}) { return this._get("/v1/symbols/convert", { input, from, exchange, broker }); }
  /** @param {Array<string | { input: string, from?: string, exchange?: string, broker?: string }>} items */
  async convertSymbols(items) {
    const body = { items: items.map((i) => (typeof i === "string" ? { input: i } : i)) };
    return (await this.request("POST", "/v1/symbols/convert", { body })).body;
  }

  // ── Market data ──
  ltp(symbols, { account, maxAgeMs } = {}) { return this._get("/v1/ltp", { symbols: [].concat(symbols), account, maxAgeMs }); }
  quotes(symbols, { account, maxAgeMs } = {}) { return this._get("/v1/quotes", { symbols: [].concat(symbols), account, maxAgeMs }); }
  depth(symbol, { account, maxAgeMs } = {}) { return this._get("/v1/depth", { symbol, account, maxAgeMs }); }
  /** @param {{ symbol: string, interval: string, from?: string|number, to?: string|number, countback?: number, account?: string, format?: "json"|"csv" }} p */
  history({ symbol, interval, from, to, countback, account, format } = {}) { return this._get("/v1/history", { symbol, interval, from, to, countback, account, format }); }
  expiries(underlying, { exchange, account } = {}) { return this._get("/v1/expiries", { underlying, exchange, account }); }
  optionChain({ underlying, expiry, strikes, greeks, account, maxAgeMs } = {}) { return this._get("/v1/optionchain", { underlying, expiry, strikes, greeks, account, maxAgeMs }); }
  streamStats() { return this._get("/v1/stream/stats"); }

  // ── Backup data (Yahoo Finance, NSE website; labelled freshness.source "backup") ──
  backupStatus() { return this._get("/v1/backup/status"); }
  backupQuotes(symbols, { fields } = {}) { return this._get("/v1/backup/quotes", { symbols: [].concat(symbols), fields }); }
  backupHistory({ symbol, interval, from, to, countback } = {}) { return this._get("/v1/backup/history", { symbol, interval, from, to, countback }); }

  // ── Scanner ──
  scannerLanguage() { return this._get("/v1/scanner/language"); }
  scannerUniverses() { return this._get("/v1/scanner/universes"); }
  scannerUniverse(name) { return this._get(`/v1/scanner/universes/${encodeURIComponent(name)}`); }
  async planScan(scan, o = {}) { return (await this.request("POST", "/v1/scanner/plan", { body: scan, signal: o.signal })).body; }
  /** Start a scan; with waitMs the reply carries the results when it finished in time (status "completed"). */
  async scan(scan, { waitMs, signal } = {}) {
    return (await this.request("POST", "/v1/scanner/jobs", { body: scan, query: { waitMs }, signal, timeoutMs: Math.max(this.timeoutMs, (waitMs ?? 0) + 10_000) })).body;
  }
  scans() { return this._get("/v1/scanner/jobs"); }
  scanJob(jobId) { return this._get(`/v1/scanner/jobs/${encodeURIComponent(jobId)}`); }
  async cancelScan(jobId) { return (await this.request("DELETE", `/v1/scanner/jobs/${encodeURIComponent(jobId)}`)).body; }
  savedScans() { return this._get("/v1/scanner/saved"); }
  async saveScan({ name, request, everyMinutes, marketHoursOnly } = {}) {
    return (await this.request("POST", "/v1/scanner/saved", { body: { name, request, everyMinutes, marketHoursOnly } })).body;
  }
  async deleteSavedScan(savedId) { return (await this.request("DELETE", `/v1/scanner/saved/${encodeURIComponent(savedId)}`)).body; }
  async runSavedScan(savedId, { waitMs } = {}) {
    return (await this.request("POST", `/v1/scanner/saved/${encodeURIComponent(savedId)}/run`, { query: { waitMs }, timeoutMs: Math.max(this.timeoutMs, (waitMs ?? 0) + 10_000) })).body;
  }

  // ── Portfolio ──
  positions(account, { mode } = {}) { return this._get("/v1/positions", { account, mode }); }
  holdings(account) { return this._get("/v1/holdings", { account }); }
  funds(account, { mode } = {}) { return this._get("/v1/funds", { account, mode }); }

  // ── Orders (paper unless the order says mode: "live") ──
  orders({ account, mode, status, limit, cursor } = {}) { return this._get("/v1/orders", { account, mode, status, limit, cursor }); }
  order(orderId) { return this._get(`/v1/orders/${encodeURIComponent(orderId)}`); }
  orderByClientId(clientOrderId) { return this._get(`/v1/orders/by-client-id/${encodeURIComponent(clientOrderId)}`); }
  trades({ account, mode, limit, cursor } = {}) { return this._get("/v1/trades", { account, mode, limit, cursor }); }
  async previewOrder(order, o = {}) { return (await this.request("POST", "/v1/orders/preview", { body: order, signal: o.signal })).body; }
  /** @param {object} order OrderRequest  @param {{ idempotencyKey?: string, signal?: AbortSignal }} [o] */
  placeOrder(order, o = {}) { return this._write("POST", "/v1/orders", order, o); }
  modifyOrder(orderId, changes, o = {}) { return this._write("PATCH", `/v1/orders/${encodeURIComponent(orderId)}`, changes, o); }
  cancelOrder(orderId, o = {}) { return this._write("DELETE", `/v1/orders/${encodeURIComponent(orderId)}`, undefined, o); }
  cancelAllOrders({ account, mode } = {}, o = {}) {
    const body = {};
    if (account !== undefined) body.account = account;
    if (mode !== undefined) body.mode = mode;
    return this._write("POST", "/v1/orders/cancel-all", body, o);
  }

  // ── Paper and safety ──
  paperAccount(accountId) { return this._get(`/v1/paper/accounts/${encodeURIComponent(accountId)}`); }
  async resetPaperAccount(accountId, { startingCapital } = {}) {
    const body = startingCapital === undefined ? {} : { startingCapital };
    return (await this.request("POST", `/v1/paper/accounts/${encodeURIComponent(accountId)}/reset`, { body })).body;
  }
  safety() { return this._get("/v1/safety"); }
  /** Stop all orders now. Any key may engage the kill switch; releasing it is deliberately not in the SDK. */
  async engageKillSwitch({ reason, cancelOpenOrders = false }) {
    return (await this.request("POST", "/v1/safety/kill-switch", { body: { reason, cancelOpenOrders } })).body;
  }

  /**
   * Iterate every item of a paginated list (orders, trades, instrument search).
   * @param {(params: object) => Promise<{ data: any[], meta: { nextCursor?: string | null } }>} fn  e.g. (p) => client.orders(p)
   * @param {object} [params]
   */
  async *paginate(fn, params = {}) {
    let cursor = params.cursor;
    for (;;) {
      const page = await fn({ ...params, cursor });
      for (const item of page.data ?? []) yield item;
      cursor = page.meta?.nextCursor;
      if (!cursor) return;
    }
  }

  // ── Streaming ──
  /** A single-use, short-lived token for the WebSocket/SSE URL (your API key never goes in a URL). */
  async streamToken() {
    return (await this.request("POST", "/v1/stream/token")).body.data;
  }
  /** ws://… URL of the stream with a fresh token. */
  async streamUrl() {
    const { token } = await this.streamToken();
    return `${this.baseUrl.replace(/^http/i, "ws")}/v1/stream?token=${encodeURIComponent(token)}`;
  }
  /**
   * Open a live stream. Reconnects with a fresh token and re-subscribes after a drop.
   * @param {{ symbols?: string[], mode?: "ltp"|"quote"|"depth", orders?: boolean | string[], reconnect?: boolean }} [opts]
   * @returns {BridgeStream}
   */
  stream(opts = {}) {
    const s = new BridgeStream(this, { WebSocket: this._WebSocket, ...opts });
    s.connect();
    return s;
  }
}
