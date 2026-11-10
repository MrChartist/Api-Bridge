/**
 * Events out: react to what the Bridge does without polling (`bridge.events`), and check signed webhooks.
 *
 *   for await (const ev of bridge.events.subscribe({ topics: ["download.*", "recording.gap"] })) {
 *     console.log(ev.cursor, ev.topic, ev.data);
 *   }
 *
 * `subscribe` reads the Bridge's event stream (GET /v1/events/stream, Server-Sent Events). It reconnects by itself with
 * growing waits after a drop and asks for everything after the last event it saw (`since=<cursor>` and the Last-Event-ID
 * header), so a restart of the Bridge or of your network loses nothing the Bridge still keeps. Keep `ev.cursor` somewhere to
 * continue after your own program restarts: `subscribe({ since: savedCursor })`. A read key sees only the events a read key
 * may see; admin events need an admin key.
 *
 * Webhooks (the Bridge posts to your URL) are managed with `bridge.subscriptions`. Every delivery carries the headers
 * `X-Bridge-Signature: v1=<hex>` and `X-Bridge-Timestamp: <unix seconds>` (also `X-Bridge-Event-Id`, `X-Bridge-Delivery`,
 * `X-Bridge-Attempt`): the hex is HMAC-SHA256 of `"<timestamp>." + the exact raw body` with your secret. Check it with
 * `verifySignature` before you trust the body, and answer 401 when it fails:
 *
 *   const ok = verifySignature(SECRET, rawBodyBuffer, req.headers);      // or { timestamp, signature } explicitly
 *
 * Use the raw bytes as received: re-serialising parsed JSON changes them. A timestamp more than 5 minutes from your clock
 * fails (replay protection; this helper keeps no memory: de-duplicate on `X-Bridge-Event-Id`, delivery is at least once). A
 * secret being replaced makes the Bridge send several `v1=` values: any one may match, and you may pass an array of secrets.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { BridgeApiError, BridgeConnectionError, SignatureInvalidError } from "./errors.mjs";

export const SIGNATURE_HEADER = "X-Bridge-Signature";
export const TIMESTAMP_HEADER = "X-Bridge-Timestamp";
export const EVENT_ID_HEADER = "X-Bridge-Event-Id";
export const EVENT_TOPIC_HEADER = "X-Bridge-Event-Topic";
export const DELIVERY_HEADER = "X-Bridge-Delivery";
export const ATTEMPT_HEADER = "X-Bridge-Attempt";
export const DEFAULT_TOLERANCE_SEC = 300;
export const EVENTS_PATH = "/v1/events/stream";

const bytes = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(v ?? "", "utf8"));

/** Hex HMAC-SHA256 of `"<timestamp>." + body`. */
export function computeSignature(secret, timestamp, body) {
  return createHmac("sha256", bytes(secret)).update(`${Math.trunc(timestamp)}.`, "utf8").update(bytes(body)).digest("hex");
}

/** The two headers the Bridge sends with a delivery (`X-Bridge-Timestamp`, `X-Bridge-Signature: v1=<hex>`) for `body`: for sending your own test deliveries to a receiver. */
export function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const t = Math.trunc(timestamp);
  return { [TIMESTAMP_HEADER]: String(t), [SIGNATURE_HEADER]: `v1=${computeSignature(secret, t, body)}` };
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const v = typeof headers.get === "function" ? headers.get(name) : Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(v) ? v[0] : v ?? undefined;
}

/**
 * `{ ok, reason }`: `reason` is ok, missing_header, malformed_header, timestamp_out_of_range or signature_mismatch. Give the
 * request `headers` (a plain object or a Headers instance, any letter case) or `timestamp` and `signature` yourself. Log the
 * reason; answer the caller with a plain 401.
 * @param {string|Buffer|Array<string|Buffer>} secret
 * @param {string|Buffer|Uint8Array} body  the exact raw request body
 * @param {Headers|Record<string, any>|{ timestamp?: string|number, signature?: string }} headersOrParts
 * @param {{ toleranceSec?: number, now?: number }} [o]  `now` is epoch seconds (tests)
 */
export function explainSignature(secret, body, headersOrParts, { toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() / 1000 } = {}) {
  const x = headersOrParts ?? {};
  const explicit = "timestamp" in x || "signature" in x;
  const timestamp = explicit ? x.timestamp : headerValue(x, TIMESTAMP_HEADER);
  const signature = explicit ? x.signature : headerValue(x, SIGNATURE_HEADER);
  if (timestamp === undefined || timestamp === null || timestamp === "" || !signature) return { ok: false, reason: "missing_header" };
  const ts = String(timestamp);
  const sigs = String(signature).trim().split(/[\s,]+/).map((p) => /^v1=([0-9a-fA-F]{64})$/.exec(p)?.[1]?.toLowerCase()).filter(Boolean);
  if (!/^\d{1,12}$/.test(ts) || !sigs.length) return { ok: false, reason: "malformed_header" };
  if (Math.abs(now - Number(ts)) > toleranceSec) return { ok: false, reason: "timestamp_out_of_range" };
  for (const sec of Array.isArray(secret) ? secret : [secret]) {
    const want = Buffer.from(computeSignature(sec, Number(ts), body), "hex");
    for (const got of sigs) if (timingSafeEqual(want, Buffer.from(got, "hex"))) return { ok: true, reason: "ok" };
  }
  return { ok: false, reason: "signature_mismatch" };
}

/**
 * True when the delivery is genuine: `X-Bridge-Signature` (`v1=<hex>`) is the HMAC-SHA256 of `"<timestamp>." + raw body` made
 * with `secret` (or any of several secrets), and `X-Bridge-Timestamp` is within `toleranceSec` of now. Pass the request headers
 * (object or Headers), or `{ timestamp, signature }`. Compared in constant time. With `throwOnFail: true` a failure throws
 * SignatureInvalidError (its `reason` says which check failed) instead of returning false.
 */
export function verifySignature(secret, body, headersOrParts, { toleranceSec, now, throwOnFail = false } = {}) {
  const { ok, reason } = explainSignature(secret, body, headersOrParts, { toleranceSec, now });
  if (!ok && throwOnFail) throw new SignatureInvalidError(`The webhook signature was not accepted (${reason}). Do not process this request.`, reason);
  return ok;
}

/** verifySignature with the arguments in the order a request handler has them (headers, then raw body). */
export function verifyRequest(secret, headers, body, o) {
  return verifySignature(secret, body, headers, o);
}

/** `download.*` matches `download.done`; `*` matches everything. */
export function topicMatches(pattern, topic) {
  return pattern === "*" || pattern === topic || (pattern.endsWith(".*") && topic.startsWith(pattern.slice(0, -1)));
}

/**
 * One event from the Bridge. `cursor` is the position to resume from; `topic` looks like `download.done`.
 * @typedef {{ topic: string, data: Record<string, any>, cursor?: string, time?: string, raw: any }} BridgeEvent
 */

/** @returns {BridgeEvent} */
export function eventFrom(sseId, sseEvent, payload) {
  let d;
  try {
    d = payload ? JSON.parse(payload) : {};
  } catch {
    d = { text: payload };
  }
  if (d && typeof d === "object" && typeof d.topic === "string" && ("data" in d || "payload" in d || "cursor" in d || "id" in d)) {
    const body = "data" in d ? d.data : d.payload;
    return { topic: d.topic, data: body && typeof body === "object" ? body : { value: body }, cursor: d.cursor !== undefined ? String(d.cursor) : d.id !== undefined ? String(d.id) : sseId, time: d.time ?? d.at ?? d.ts, raw: d };
  }
  const obj = d && typeof d === "object" && !Array.isArray(d) ? d : { value: d };
  return { topic: sseEvent ?? (typeof obj.type === "string" ? obj.type : "message"), data: obj, cursor: sseId, time: obj.time ?? obj.at, raw: obj };
}

/**
 * Frames of a Server-Sent Events stream as `{ id, event, data, retry }` from an async iterable of text chunks. Comment lines
 * (heartbeats) are skipped; a frame with no data lines is not an event.
 * @param {AsyncIterable<string>} chunks
 */
export async function* parseSse(chunks) {
  let buf = "";
  let id;
  let event;
  let data = [];
  let retry;
  for await (const chunk of chunks) {
    buf += chunk;
    let m;
    while ((m = /\r\n|\n|\r/.exec(buf))) {
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === "") {
        if (data.length) yield { id, event, data: data.join("\n"), retry };
        event = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const k = i < 0 ? line : line.slice(0, i);
      let v = i < 0 ? "" : line.slice(i + 1);
      if (v.startsWith(" ")) v = v.slice(1);
      if (k === "id") id = v;
      else if (k === "event") event = v;
      else if (k === "data") data.push(v);
      else if (k === "retry" && /^\d+$/.test(v)) retry = Number(v);
    }
  }
}

async function* readText(res, idleMs) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("idle")), idleMs);
      });
      let r;
      try {
        r = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (r.done) return;
      yield dec.decode(r.value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/**
 * A live, self-reconnecting read of the Bridge's event stream. `for await` over it; `close()` ends the iteration.
 * `cursor` is the last event seen, `reconnects` how many times the connection was re-made. After a drop it waits (1 s
 * doubling to `maxBackoffMs`, with jitter) and asks for events after `cursor`. A problem that retrying cannot fix (a wrong
 * key, a missing scope) is thrown at once; so is any failure when `reconnect: false`. `idleTimeoutMs` is the longest silence
 * before the connection is treated as dead (the Bridge sends heartbeats).
 */
export class EventSubscription {
  /**
   * @param {import("./client.mjs").BridgeClient} client
   * @param {{ topics?: string|string[], since?: string, reconnect?: boolean, maxBackoffMs?: number, idleTimeoutMs?: number, maxReconnects?: number }} [o]
   */
  constructor(client, o = {}) {
    this.client = client;
    this.topics = o.topics === undefined ? [] : [].concat(o.topics);
    this.cursor = o.since;
    this.reconnect = o.reconnect !== false;
    this.maxBackoffMs = o.maxBackoffMs ?? 30_000;
    this.idleTimeoutMs = o.idleTimeoutMs ?? 90_000;
    this.maxReconnects = o.maxReconnects;
    this.reconnects = 0;
    this.connected = false;
    this.closed = false;
    this._life = new AbortController();
    this._attempt = 0;
    /** The Bridge's last `ready` message: cursor, oldest, replayed, gap, gapReason, topics. */
    this.ready = undefined;
    /** True when events were lost between your cursor and what the Bridge still keeps (`gapReason`: retention or cursor_ahead): read the current state from the API again, then carry on. */
    this.gap = false;
    this.gapReason = undefined;
    /** Called with the reason when the Bridge reports a gap. */
    this.onGap = o.onGap;
  }

  close() {
    this.closed = true;
    this._life.abort(new Error("closed"));
  }

  async _waitToRetry(floorMs) {
    this.reconnects += 1;
    if (this.maxReconnects !== undefined && this.reconnects > this.maxReconnects) return false;
    const base = Math.min(this.maxBackoffMs, 1000 * 2 ** Math.min(this._attempt, 10));
    this._attempt += 1;
    try {
      await this.client._sleep(Math.max(floorMs, base + Math.floor(Math.random() * base * 0.25)), this._life.signal);
    } catch {
      return false; // closed while waiting
    }
    return !this.closed;
  }

  async *_run() {
    let floorMs = 0;
    while (!this.closed) {
      let res;
      try {
        res = await this.client.openStream("GET", EVENTS_PATH, {
          query: { topics: this.topics.length ? this.topics : undefined, since: this.cursor },
          headers: this.cursor ? { "Last-Event-ID": this.cursor } : undefined,
          accept: "text/event-stream",
          signal: this._life.signal,
        });
      } catch (err) {
        if (this.closed) return;
        const fixable = err instanceof BridgeConnectionError || (err instanceof BridgeApiError && (err.retryable || err.status >= 500));
        if (!this.reconnect || !fixable) throw err;
        if (!(await this._waitToRetry(floorMs))) return;
        continue;
      }
      this.connected = true;
      try {
        for await (const f of parseSse(readText(res, this.idleTimeoutMs))) {
          this._attempt = 0;
          if (f.retry !== undefined) floorMs = f.retry;
          if (f.event === "ready") {
            try {
              this.ready = JSON.parse(f.data || "{}");
            } catch {
              this.ready = {};
            }
            this.gap = Boolean(this.ready.gap);
            this.gapReason = this.gap ? this.ready.gapReason : undefined;
            if (this.gap) this.onGap?.(this.gapReason);
            continue;
          }
          if (f.event === "go_away") break; // the Bridge is closing this connection: reconnect with the cursor
          const ev = eventFrom(f.id, f.event, f.data);
          if (ev.cursor) this.cursor = ev.cursor;
          yield ev;
          if (this.closed) return;
        }
      } catch {
        if (this.closed) return; // otherwise: the connection dropped or went quiet; reconnect below
      } finally {
        this.connected = false;
      }
      if (this.closed || !this.reconnect) return;
      if (!(await this._waitToRetry(floorMs))) return;
    }
  }

  [Symbol.asyncIterator]() {
    return this._run();
  }
}

/** `bridge.events`: subscribe to the event stream; verify webhook signatures. */
export class Events {
  constructor(client) {
    this.client = client;
    this.verifySignature = verifySignature;
    this.signPayload = signPayload;
  }

  /**
   * Events as they happen (see the file comment). `topics` filters (`"download.*"`, `["recording.gap", "order.*"]`); none means
   * every topic your key may see. `since` is a cursor saved from an earlier `ev.cursor`.
   * @param {{ topics?: string|string[], since?: string, reconnect?: boolean, maxBackoffMs?: number, idleTimeoutMs?: number, maxReconnects?: number, onGap?: (reason?: string) => void }} [o]
   */
  subscribe(o = {}) {
    return new EventSubscription(this.client, o);
  }

  /** The topics this key may receive (GET /v1/events/topics): topic, scope, accountScoped, description. */
  async topics() {
    return (await this.client._get("/v1/events/topics")).data ?? [];
  }

  /**
   * The same events as one JSON answer (GET /v1/events), for a script that runs now and then. Pass the returned `cursor` as
   * `since` next time. Without `since` it returns the newest events. `gap` is true when events were lost.
   * @param {{ since?: string, topics?: string|string[], limit?: number }} [o]
   * @returns {Promise<{ events: BridgeEvent[], cursor?: string, gap: boolean, gapReason?: string, hasMore: boolean }>}
   */
  async poll({ since, topics, limit } = {}) {
    const r = await this.client._get("/v1/events", { since, topics: topics === undefined ? undefined : [].concat(topics), limit });
    const meta = r.meta ?? {};
    return { events: (r.data ?? []).map((e) => eventFrom(undefined, undefined, JSON.stringify(e))), cursor: meta.cursor !== undefined ? String(meta.cursor) : since, gap: Boolean(meta.gap), gapReason: meta.gapReason ?? undefined, hasMore: Boolean(meta.hasMore) };
  }

  /**
   * The first event on `topic` (that satisfies `predicate`), or undefined after `timeoutMs` of silence or a dropped connection.
   * @param {string} topic
   * @param {(ev: BridgeEvent) => boolean} [predicate]
   * @param {{ timeoutMs?: number, since?: string }} [o]
   */
  async waitFor(topic, predicate, { timeoutMs = 60_000, since } = {}) {
    const sub = this.subscribe({ topics: topic, since, idleTimeoutMs: timeoutMs, maxReconnects: 0 });
    try {
      for await (const ev of sub) if (topicMatches(topic, ev.topic) && (!predicate || predicate(ev))) return ev;
    } finally {
      sub.close();
    }
    return undefined;
  }
}
