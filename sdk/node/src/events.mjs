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
 * Webhooks (the Bridge posts to your URL) are managed with `bridge.subscriptions`. Every delivery carries
 * `X-MCB-Signature: t=<unix seconds>,v1=<hex>`: the hex is HMAC-SHA256 of `"<t>." + the exact raw body` with your secret.
 * Check it with `verifySignature` before you trust the body, and answer 401 when it fails:
 *
 *   const ok = verifySignature(SECRET, rawBodyBuffer, req.headers["x-mcb-signature"]);
 *
 * Use the raw bytes as received: re-serialising parsed JSON changes them. A timestamp more than 5 minutes from your clock
 * fails (replay protection; this helper keeps no memory, so remember delivery ids yourself if duplicates matter). A sender
 * rotating its secret may send several `v1=` values: any one may match, and you may pass an array of secrets.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { BridgeApiError, BridgeConnectionError, SignatureInvalidError } from "./errors.mjs";

export const SIGNATURE_HEADER = "X-MCB-Signature";
export const DEFAULT_TOLERANCE_SEC = 300;
export const EVENTS_PATH = "/v1/events/stream";

const bytes = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : Buffer.from(v ?? "", "utf8"));

/** Hex HMAC-SHA256 of `"<timestamp>." + body`. */
export function computeSignature(secret, timestamp, body) {
  return createHmac("sha256", bytes(secret)).update(`${Math.trunc(timestamp)}.`, "utf8").update(bytes(body)).digest("hex");
}

/** A signature header value (`t=...,v1=...`) for `body`: for sending your own test deliveries to a receiver. */
export function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${Math.trunc(timestamp)},v1=${computeSignature(secret, timestamp, body)}`;
}

function parseHeader(header) {
  let t;
  const sigs = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-fA-F]{64}$/.test(v)) sigs.push(v.toLowerCase());
  }
  return { t, sigs };
}

/**
 * `{ ok, reason }`: `reason` is ok, missing_header, malformed_header, timestamp_out_of_range or signature_mismatch. Log the
 * reason; answer the caller with a plain 401.
 * @param {string|Buffer|Array<string|Buffer>} secret
 * @param {string|Buffer|Uint8Array} body  the exact raw request body
 * @param {string|null|undefined} header
 * @param {{ toleranceSec?: number, now?: number }} [o]  `now` is epoch seconds (tests)
 */
export function explainSignature(secret, body, header, { toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() / 1000 } = {}) {
  if (!header) return { ok: false, reason: "missing_header" };
  const { t, sigs } = parseHeader(header);
  if (t === undefined || !sigs.length) return { ok: false, reason: "malformed_header" };
  if (Math.abs(now - t) > toleranceSec) return { ok: false, reason: "timestamp_out_of_range" };
  for (const s of Array.isArray(secret) ? secret : [secret]) {
    const want = Buffer.from(computeSignature(s, t, body), "hex");
    for (const got of sigs) if (timingSafeEqual(want, Buffer.from(got, "hex"))) return { ok: true, reason: "ok" };
  }
  return { ok: false, reason: "signature_mismatch" };
}

/**
 * True when `header` is a valid signature of the raw `body` made with `secret` (or any of several secrets), made within
 * `toleranceSec` of now. Compared in constant time. With `throwOnFail: true` a failure throws SignatureInvalidError (its
 * `reason` says which check failed) instead of returning false.
 */
export function verifySignature(secret, body, header, { toleranceSec, now, throwOnFail = false } = {}) {
  const { ok, reason } = explainSignature(secret, body, header, { toleranceSec, now });
  if (!ok && throwOnFail) throw new SignatureInvalidError(`The webhook signature was not accepted (${reason}). Do not process this request.`, reason);
  return ok;
}

/** verifySignature reading the header from request headers (a plain object or a Headers instance, any letter case). */
export function verifyRequest(secret, headers, body, o) {
  let h;
  if (typeof headers?.get === "function") h = headers.get(SIGNATURE_HEADER);
  else h = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === SIGNATURE_HEADER.toLowerCase())?.[1];
  return verifySignature(secret, body, Array.isArray(h) ? h[0] : h, o);
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
  if (d && typeof d === "object" && typeof d.topic === "string" && ("data" in d || "payload" in d || "cursor" in d)) {
    const body = "data" in d ? d.data : d.payload;
    return { topic: d.topic, data: body && typeof body === "object" ? body : { value: body }, cursor: d.cursor !== undefined ? String(d.cursor) : sseId, time: d.time ?? d.at ?? d.ts, raw: d };
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
   * @param {{ topics?: string|string[], since?: string, reconnect?: boolean, maxBackoffMs?: number, idleTimeoutMs?: number, maxReconnects?: number }} [o]
   */
  subscribe(o = {}) {
    return new EventSubscription(this.client, o);
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
