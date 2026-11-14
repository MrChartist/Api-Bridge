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
import { Collections, Datasets, Downloads, Recordings, Subscriptions } from "./data.mjs";
import { Events } from "./events.mjs";
import { HistoryAll } from "./history.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:4300";
const seg = (s) => encodeURIComponent(String(s));
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
    this.userAgent = opts.userAgent ?? "mrchartist-bridge-node/0.2";
    this._now = opts.now ?? Date.now;
    // Not enumerable, so console.log(client) and JSON.stringify(client) stay short and never loop back on themselves.
    for (const [name, Group] of Object.entries({ downloads: Downloads, datasets: Datasets, recordings: Recordings, collections: Collections, subscriptions: Subscriptions, events: Events })) {
      Object.defineProperty(this, name, { value: new Group(this), enumerable: false });
    }
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
  /** `explain: true` adds the budget pools, the competing clients and `savedCalls`. */
  limits({ account, explain } = {}) { return this._get("/v1/limits", { account, explain: explain ? "true" : undefined }); }
  /**
   * Broker calls the Bridge did not make today because the data was already stored, streamed, cached or shared
   * (`GET /v1/limits?explain=1`, `savedCalls`): `{ day, total, byReason, scheduler, totalToday }`. `total` counts reads served from
   * datasets and recordings; `totalToday` adds the scheduler's own savings. Zeros on a Bridge that does not count them.
   */
  async savedCalls() {
    const saved = (await this.limits({ explain: true }))?.data?.savedCalls ?? {};
    const scheduler = saved.scheduler ?? {};
    const total = Number(saved.total ?? 0);
    return { day: saved.day ?? null, total, byReason: saved.byReason ?? {}, scheduler, totalToday: Number(saved.totalToday ?? total + Object.values(scheduler).reduce((a, n) => a + Number(n || 0), 0)) };
  }
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
  // Every market read takes `purpose` ("display", "analysis", "alert", "paper", "risk" or "order"): what the data is for. The Bridge refuses
  // data that is not good enough for it (delayed or end-of-day data never feeds an order, a risk check or an alert).
  ltp(symbols, { account, maxAgeMs, purpose } = {}) { return this._get("/v1/ltp", { symbols: [].concat(symbols), account, maxAgeMs, purpose }); }
  /** `fields: ["ltp", "bid"]` keeps only those columns (symbol and freshness are always kept). */
  quotes(symbols, { account, maxAgeMs, purpose, fields } = {}) { return this._get("/v1/quotes", { symbols: [].concat(symbols), account, maxAgeMs, purpose, fields: fields === undefined ? undefined : [].concat(fields).join(",") }); }
  depth(symbol, { account, maxAgeMs, purpose } = {}) { return this._get("/v1/depth", { symbol, account, maxAgeMs, purpose }); }
  /**
   * @param {{ symbol: string, interval: string, from?: string|number, to?: string|number, countback?: number, account?: string, format?: "json"|"csv",
   *   localFirst?: boolean, dataset?: string, backup?: boolean, purpose?: string, timeIso?: boolean, tz?: "IST"|"UTC", fields?: string[]|string }} p
   *   localFirst serves bars the Bridge already stored (dataset picks one) and fetches only the rest. Daily and longer candles carry `date` (the IST
   *   trading date); timeIso or tz adds `timeIso`; fields keeps only those columns (`time` is always kept).
   */
  history({ symbol, interval, from, to, countback, account, format, localFirst, dataset, backup, purpose, timeIso, tz, fields } = {}) { return this._get("/v1/history", { symbol, interval, from, to, countback, account, format, localFirst, dataset, backup, purpose, timeIso, tz, fields: fields === undefined ? undefined : [].concat(fields).join(",") }); }
  expiries(underlying, { exchange, account } = {}) { return this._get("/v1/expiries", { underlying, exchange, account }); }
  optionChain({ underlying, expiry, strikes, greeks, account, maxAgeMs, purpose } = {}) { return this._get("/v1/optionchain", { underlying, expiry, strikes, greeks, account, maxAgeMs, purpose }); }
  streamStats() { return this._get("/v1/stream/stats"); }

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

  // ── Data you keep: downloads, datasets, recordings, collections, subscriptions (envelopes, like every call above) ──
  // The friendlier groups are bridge.downloads, bridge.datasets, bridge.recordings, bridge.collections,
  // bridge.subscriptions and bridge.events; these are the plain one-route-one-method calls they use.
  /** `dryRun: true` starts nothing and answers with the estimate (broker calls, rows, bytes, time at your share, disk). */
  async createDownload(request, { dryRun = false } = {}) {
    return (await this.request("POST", "/v1/downloads", { body: request, query: dryRun ? { dryRun: "true" } : undefined })).body;
  }
  downloadSettings() { return this._get("/v1/downloads/settings"); }
  /** Needs an admin key from this computer. `{ maxBudgetShare?: 0.05 to 0.8, afterHoursOnly?: boolean }`. */
  setDownloadSettings(changes) { return this._send("PATCH", "/v1/downloads/settings", changes); }
  listDownloads({ status, limit, cursor } = {}) { return this._get("/v1/downloads", { status, limit, cursor }); }
  download(id) { return this._get(`/v1/downloads/${seg(id)}`); }
  pauseDownload(id) { return this._send("POST", `/v1/downloads/${seg(id)}/pause`); }
  resumeDownload(id) { return this._send("POST", `/v1/downloads/${seg(id)}/resume`); }
  cancelDownload(id) { return this._send("POST", `/v1/downloads/${seg(id)}/cancel`); }
  deleteDownload(id) { return this._send("DELETE", `/v1/downloads/${seg(id)}`); }
  editDownload(id, changes) { return this._send("PATCH", `/v1/downloads/${seg(id)}`, changes); }
  downloadFiles(id) { return this._get(`/v1/downloads/${seg(id)}/files`); }
  listDatasets({ tag } = {}) { return this._get("/v1/datasets", { tag }); }
  dataset(name) { return this._get(`/v1/datasets/${seg(name)}`); }
  updateDataset(name, body = {}) { return this._send("POST", `/v1/datasets/${seg(name)}/update`, body); }
  editDataset(name, changes) { return this._send("PATCH", `/v1/datasets/${seg(name)}`, changes); }
  listRecordings({ status } = {}) { return this._get("/v1/recordings", { status }); }
  recordingStatus() { return this._get("/v1/recordings/status"); }
  recordingSettings() { return this._get("/v1/recordings/settings"); }
  /** Needs an admin key from this computer. `{ maxBudgetShare: 0.05 to 0.8 }`. */
  setRecordingSettings(changes) { return this._send("PATCH", "/v1/recordings/settings", changes); }
  recordingPresets() { return this._get("/v1/recordings/presets"); }
  applyRecordingPreset(id, body = {}) { return this._send("POST", `/v1/recordings/presets/${seg(id)}/apply`, body); }
  createRecording(request) { return this._send("POST", "/v1/recordings", request); }
  recording(id) { return this._get(`/v1/recordings/${seg(id)}`); }
  pauseRecording(id) { return this._send("POST", `/v1/recordings/${seg(id)}/pause`); }
  resumeRecording(id) { return this._send("POST", `/v1/recordings/${seg(id)}/resume`); }
  stopRecording(id) { return this._send("POST", `/v1/recordings/${seg(id)}/stop`); }
  deleteRecording(id) { return this._send("DELETE", `/v1/recordings/${seg(id)}`); }
  recordingFiles(id) { return this._get(`/v1/recordings/${seg(id)}/files`); }
  recordingRules() { return this._get("/v1/recordings/rules"); }
  createRecordingRule(rule) { return this._send("POST", "/v1/recordings/rules", rule); }
  updateRecordingRule(id, changes) { return this._send("PATCH", `/v1/recordings/rules/${seg(id)}`, changes); }
  deleteRecordingRule(id) { return this._send("DELETE", `/v1/recordings/rules/${seg(id)}`); }
  listCollections({ tag, kind } = {}) { return this._get("/v1/collections", { tag, kind }); }
  collection(name) { return this._get(`/v1/collections/${seg(name)}`); }
  createCollection(collection) { return this._send("POST", "/v1/collections", collection); }
  updateCollection(name, changes) { return this._send("PATCH", `/v1/collections/${seg(name)}`, changes); }
  deleteCollection(name) { return this._send("DELETE", `/v1/collections/${seg(name)}`); }
  /** A delayed or end-of-day ATM price is refused (422) and a stale one too (503) unless `allowStale: true` (then the answer is labelled). */
  resolveCollection(name, { allowStale } = {}) { return this._get(`/v1/collections/${seg(name)}/resolve`, { allowStale: allowStale ? 1 : undefined }); }
  collectionUsage(name) { return this._get(`/v1/collections/${seg(name)}/usage`); }
  collectionEstimate(name, { intervals, days } = {}) { return this._get(`/v1/collections/${seg(name)}/estimate`, { intervals, days }); }
  listSubscriptions() { return this._get("/v1/subscriptions"); }
  createSubscription(subscription) { return this._send("POST", "/v1/subscriptions", subscription); }
  updateSubscription(id, changes) { return this._send("PATCH", `/v1/subscriptions/${seg(id)}`, changes); }
  deleteSubscription(id) { return this._send("DELETE", `/v1/subscriptions/${seg(id)}`); }
  testSubscription(id) { return this._send("POST", `/v1/subscriptions/${seg(id)}/test`); }
  subscription(id) { return this._get(`/v1/subscriptions/${seg(id)}`); }
  /** Every delivery attempt, newest first. `outcome` is delivered, retry, dead or failed. */
  subscriptionDeliveries(id, { limit, outcome } = {}) { return this._get(`/v1/subscriptions/${seg(id)}/deliveries`, { limit, outcome }); }
  subscriptionDeadLetters(id) { return this._get(`/v1/subscriptions/${seg(id)}/dead-letters`); }
  retryDeadLetter(id, deliveryId) { return this._send("POST", `/v1/subscriptions/${seg(id)}/dead-letters/${seg(deliveryId)}/retry`); }
  clearDeadLetters(id) { return this._send("DELETE", `/v1/subscriptions/${seg(id)}/dead-letters`); }

  /** A write that is not an order: JSON in, body out, no Idempotency-Key (a lost reply is never retried). */
  async _send(method, path, body, o = {}) {
    return (await this.request(method, path, { body, signal: o.signal, timeoutMs: o.timeoutMs })).body;
  }

  /**
   * Open a reply that is read piece by piece (a file or a Server-Sent Events stream). Resolves to the fetch Response once
   * the status is known; a problem reply throws BridgeApiError. Retryable problems (rate limit) are retried and an
   * unreachable Bridge is retried like a read. `timeoutMs` covers only the wait for the first answer; stop a running
   * stream with `signal`.
   * @param {string} method
   * @param {string} path
   * @param {{ query?: object, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number, accept?: string }} [o]
   * @returns {Promise<Response>}
   */
  async openStream(method, path, o = {}) {
    const url = this.baseUrl + path + toQuery(o.query);
    const headers = { Accept: o.accept ?? "*/*", "User-Agent": this.userAgent, ...(o.headers ?? {}) };
    if (this._apiKey) headers.Authorization = `Bearer ${this._apiKey}`;
    for (let attempt = 0; ; attempt += 1) {
      const ac = new AbortController();
      const onAbort = () => ac.abort(o.signal.reason);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(new Error("timeout")), o.timeoutMs ?? this.timeoutMs);
      let res;
      try {
        res = await this._fetch(url, { method: method.toUpperCase(), headers, signal: ac.signal, redirect: "error" });
      } catch (cause) {
        o.signal?.removeEventListener("abort", onAbort);
        if (o.signal?.aborted) throw cause;
        if (attempt < this.maxRetries) {
          await this._sleep(this._backoff(attempt), o.signal);
          continue;
        }
        throw new BridgeConnectionError(`Could not reach the Bridge at ${this.baseUrl} (${ac.signal.aborted ? "timed out" : cause?.code ?? cause?.cause?.code ?? cause?.message ?? "network error"}).`, { cause, method, path, outcomeUnknown: false, timedOut: ac.signal.aborted });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return res; // the abort link stays: o.signal also stops the body that is still being read
      o.signal?.removeEventListener("abort", onAbort);
      const text = await res.text().catch(() => "");
      let body = text;
      if (/json/i.test(res.headers.get("content-type") ?? "")) {
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      }
      const problem =
        body && typeof body === "object" && typeof body.code === "string"
          ? { ...body, status: body.status ?? res.status }
          : { status: res.status, code: res.headers.get("x-error-code") ?? `HTTP_${res.status}`, title: res.statusText, detail: typeof body === "string" ? body.slice(0, 200) : undefined, retryable: false };
      const ra = Number(res.headers.get("retry-after"));
      if (problem.retryAfterMs === undefined && Number.isFinite(ra) && ra >= 0) problem.retryAfterMs = ra * 1000;
      const err = new BridgeApiError(problem);
      if (err.retryable && attempt < this.maxRetries) {
        await this._sleep(Math.min(MAX_RETRY_WAIT_MS, problem.retryAfterMs ?? this._backoff(attempt)), o.signal);
        continue;
      }
      throw err;
    }
  }

  /**
   * Candles over any length of time: `for await (const c of bridge.historyAll({ symbol, interval, from, to })) ...`.
   * See history.mjs. `localFirst: true` lets the Bridge answer from the data it already stored (fewer broker calls).
   * @param {import("./history.mjs").HistoryAllParams} p
   */
  historyAll(p) { return new HistoryAll(this, p); }

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
