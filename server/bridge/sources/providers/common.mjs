/**
 * Shared building blocks for the built-in free providers: error classification, a request limiter that never
 * goes above a source's documented limits, and an HTTP helper that only talks to declared hosts, honours the abort
 * signal, turns every failure into a BridgeError and never lets a secret into a message.
 *
 * Every failure a provider throws is a BridgeError carrying `fields.kind` so the router can tell a 429, an auth
 * problem or a missing symbol (which must not trip a circuit breaker) from a real upstream fault:
 *
 *   kind           code                     meaning
 *   rate-limited   UPSTREAM_RATE_LIMITED    the vendor (or our own limiter) said wait; `retryAfterMs` says how long
 *   auth           UPSTREAM_ERROR           the key is missing or rejected
 *   not-found      SYMBOL_NOT_FOUND         the vendor does not know the symbol
 *   entitlement    CAPABILITY_UNSUPPORTED   the user's plan does not include this data
 *   unsupported    CAPABILITY_UNSUPPORTED   the source cannot do this at all
 *   blocked        UPSTREAM_ERROR           the vendor now demands something we will not do (cookies, a login)
 *   upstream       UPSTREAM_ERROR           the vendor failed or sent something unreadable
 *   timeout        UPSTREAM_TIMEOUT         no answer in time
 *   unavailable    BROKER_UNAVAILABLE       the network call itself failed
 */
import { BridgeError } from "../../core/errors.mjs";
import { defaultSessionFor } from "../../reference/defaults.mjs";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

const KIND_CODE = Object.freeze({
  "rate-limited": "UPSTREAM_RATE_LIMITED",
  auth: "UPSTREAM_ERROR",
  "not-found": "SYMBOL_NOT_FOUND",
  entitlement: "CAPABILITY_UNSUPPORTED",
  unsupported: "CAPABILITY_UNSUPPORTED",
  blocked: "UPSTREAM_ERROR",
  upstream: "UPSTREAM_ERROR",
  timeout: "UPSTREAM_TIMEOUT",
  unavailable: "BROKER_UNAVAILABLE",
});
export const ERROR_KINDS = Object.freeze(Object.keys(KIND_CODE));

/** Replace every secret (length >= 4) and any `apikey=...` style query value in `text` with "***". */
export function redactText(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) if (typeof s === "string" && s.length >= 4) out = out.split(s).join("***");
  return out.replace(/((?:api[_-]?key|api[_-]?token|apikey|token)=)[^&\s"']+/gi, "$1***");
}

/**
 * Build a classified BridgeError. `message` is plain text for a person; it is redacted and cut to 240 characters.
 * @param {keyof typeof KIND_CODE} kind
 * @param {string} message
 * @param {{ source?: string, retryAfterMs?: number, secrets?: string[], status?: number }} [opts]
 */
export function sourceError(kind, message, { source, retryAfterMs, secrets = [], status } = {}) {
  const code = KIND_CODE[kind] ?? "UPSTREAM_ERROR";
  const extra = { fields: { kind, ...(source ? { source } : {}) } };
  if (retryAfterMs !== undefined) extra.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
  if (status !== undefined) extra.status = status;
  if (source) extra.broker = { id: source, code: kind };
  return new BridgeError(code, redactText(message, secrets).slice(0, 240), extra);
}

export function abortError(message = "The request was cancelled.") {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

export const isAbort = (err) => err?.name === "AbortError";

/** Seconds (or an HTTP date) from a Retry-After header to milliseconds, or null. */
export function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/** Milliseconds until the next UTC midnight, at least one minute (daily vendor quotas reset about then). */
export function msToNextUtcDay(nowMs) {
  return Math.max(MINUTE_MS, (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS - nowMs);
}

/** The real clock: `now` and an abortable `sleep`. Tests pass a fake with the same two methods. */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
});

/**
 * A sliding-window limiter for a source's documented limits (per second, per minute, per rolling 24 hours).
 * Callers are served in order. A call that would break a limit waits (through `clock.sleep`) when the wait is at most
 * `maxWaitMs`, and is refused with an UPSTREAM_RATE_LIMITED error carrying `retryAfterMs` when it would be longer, so a
 * slot is never taken early and the vendor is never asked more often than documented. `block(ms)` records a vendor
 * 429: nothing is sent until the time has passed.
 */
export function createLimiter({ limits, clock = systemClock, maxWaitMs = 2500, source, label = source } = {}) {
  const caps = [
    [1000, limits?.perSecond],
    [MINUTE_MS, limits?.perMinute],
    [DAY_MS, limits?.perDay],
  ].filter(([, n]) => Number.isFinite(n) && n > 0);
  /** @type {number[]} */
  let stamps = [];
  let blockedUntil = 0;
  let chain = Promise.resolve();

  const waitFor = (now) => {
    let wait = Math.max(0, blockedUntil - now);
    for (const [span, cap] of caps) {
      const recent = stamps.filter((t) => t > now - span);
      if (recent.length >= cap) wait = Math.max(wait, recent[recent.length - cap] + span - now);
    }
    return wait;
  };

  async function attempt(signal) {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const now = clock.now();
      stamps = stamps.filter((t) => t > now - DAY_MS);
      const wait = waitFor(now);
      if (wait <= 0) {
        stamps.push(now);
        return;
      }
      if (wait > maxWaitMs) {
        throw sourceError("rate-limited", `${label ?? "This source"} is at its request limit. The Bridge will try again in about ${Math.ceil(wait / 1000)} seconds.`, { source, retryAfterMs: wait });
      }
      await clock.sleep(wait, signal);
    }
  }

  return {
    /** Wait for a free slot (or throw). */
    acquire(signal) {
      const run = chain.then(() => attempt(signal));
      chain = run.catch(() => {});
      return run;
    },
    /** The vendor said wait: send nothing for `ms`. */
    block(ms) {
      blockedUntil = Math.max(blockedUntil, clock.now() + Math.max(0, ms));
    },
    /** Requests made in the last minute and in the last 24 hours. */
    usage() {
      const now = clock.now();
      return { lastMinute: stamps.filter((t) => t > now - MINUTE_MS).length, today: stamps.filter((t) => t > now - DAY_MS).length };
    },
  };
}

/**
 * The HTTP helper of one provider.
 * @param {{ id: string, name: string, fetch?: typeof fetch, clock?: object, hosts: string[], limiter: ReturnType<typeof createLimiter>,
 *   userAgent: string, timeoutMs?: number, secrets?: () => string[] }} o
 */
export function createHttp({ id, name, fetch: fetchImpl = globalThis.fetch, clock = systemClock, hosts, limiter, userAgent, timeoutMs = 10_000, secrets = () => [] }) {
  /**
   * GET `url`. Returns `{ status, headers, text, json }` (json is null when the body is not JSON). Never throws a raw
   * error: network failures become BROKER_UNAVAILABLE or UPSTREAM_TIMEOUT, a cancelled call becomes an AbortError.
   * HTTP status handling is left to the provider, which knows its vendor's error shapes.
   */
  async function get(url, { headers = {}, signal } = {}) {
    const target = new URL(url);
    if (target.protocol !== "https:" || !hosts.includes(target.hostname)) {
      throw sourceError("upstream", `${name} tried to contact an address it does not declare, so the call was stopped.`, { source: id });
    }
    await limiter.acquire(signal);
    const timer = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    let res;
    try {
      res = await fetchImpl(target.href, { method: "GET", headers: { "user-agent": userAgent, accept: "application/json", ...headers }, redirect: "error", signal: combined });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (timer.aborted || err?.name === "TimeoutError") throw sourceError("timeout", `${name} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, { source: id });
      throw sourceError("unavailable", `${name} could not be reached. Check the internet connection and try again.`, { source: id });
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw sourceError("unavailable", `${name} stopped sending its answer part-way.`, { source: id });
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  /** Record a vendor 429 on the limiter and build the error. */
  function rateLimited(res, { fallbackMs = MINUTE_MS, message } = {}) {
    const wait = parseRetryAfter(res?.headers?.get?.("retry-after"), clock.now()) ?? fallbackMs;
    limiter.block(wait);
    return sourceError("rate-limited", message ?? `${name} asked the Bridge to slow down. It will try again in about ${Math.ceil(wait / 1000)} seconds.`, { source: id, retryAfterMs: wait, secrets: secrets() });
  }

  const upstream = (message, kind = "upstream") => sourceError(kind, message, { source: id, secrets: secrets() });
  return { get, rateLimited, upstream };
}

/** A read-only source that cannot do something says so plainly. */
export function unsupported(name, what) {
  return sourceError("unsupported", `${name} cannot provide ${what}.`);
}

/** Number from a number or numeric string, otherwise null. */
export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

/** Positive finite price or null. */
export function price(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/** Minutes after IST midnight at which the cash session closes, from the reference defaults (never a literal here). */
export function sessionCloseMinutes(exchange = "NSE") {
  const [h, m] = (defaultSessionFor(exchange)?.close ?? "00:00").split(":").map(Number);
  return h * 60 + m;
}

/** Keep the bits of `ctx` the providers read. */
export function readNow(ctx, clock) {
  return Number.isFinite(ctx?.now) ? ctx.now : clock.now();
}

/** Abort quickly when the caller's signal is already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** Validate a history request's shape; returns { fromMs, toMs }. */
export function checkRange(req) {
  const fromMs = Number(req?.fromMs);
  const toMs = Number(req?.toMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new BridgeError("VALIDATION_FAILED", "A history request needs fromMs earlier than toMs, both in epoch milliseconds.");
  }
  return { fromMs, toMs };
}
