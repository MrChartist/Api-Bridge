/**
 * The host-brokered network for plugins. A plugin never fetches anything itself on the honest path: it sends
 * `{ op: fetch, url, init }` and the host performs the request, but only when:
 *
 *   - the URL is https on the standard port, with a host name (no IP, no credentials) that matches the plugin's
 *     `network.allowHosts` and is not a broker domain;
 *   - the plugin is inside its own per-second, per-minute and per-day request limits from the manifest;
 *   - the address the name resolves to is public (checked again at connection time, so a name that later resolves to a
 *     private address is refused too);
 *   - every redirect passes the same checks again (at most 3 hops, each counted against the limits).
 *
 * The request carries no cookies, no Bridge headers and no credentials; the host sets the User-Agent. The response is
 * size-capped and times out. Only a small set of response headers is passed back (never Set-Cookie).
 */
import dns from "node:dns";
import https from "node:https";
import { checkOutboundUrl, isPrivateAddress } from "./netpolicy.mjs";

export class FetchRefused extends Error {
  /** @param {"HOST_NOT_ALLOWED"|"BAD_REQUEST"|"RATE_LIMITED"|"TIMEOUT"|"TOO_LARGE"|"NETWORK"|"CANCELLED"} code */
  constructor(code, message, retryAfterMs) {
    super(message);
    this.name = "FetchRefused";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

const FORBIDDEN_REQUEST_HEADERS = new Set(["cookie", "cookie2", "host", "connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer", "expect", "accept-encoding", "user-agent", "keep-alive", "origin", "referer"]);
const PASS_RESPONSE_HEADERS = new Set(["content-type", "retry-after", "etag", "last-modified", "date", "cache-control", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,60}$/;
const MAX_HEADERS = 20;

/** Request headers a plugin may send: lowercase names, no cookies, no hop-by-hop or identity headers, no proxy headers. */
export function cleanRequestHeaders(input) {
  const out = {};
  const entries = Object.entries(input ?? {});
  if (entries.length > MAX_HEADERS) throw new FetchRefused("BAD_REQUEST", `at most ${MAX_HEADERS} request headers`);
  for (const [k, v] of entries) {
    const name = k.toLowerCase();
    if (!HEADER_NAME.test(name)) throw new FetchRefused("BAD_REQUEST", "invalid header name");
    if (FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) throw new FetchRefused("BAD_REQUEST", `the ${name} header is not allowed`);
    if (typeof v !== "string" || /[\r\n\0]/.test(v) || v.length > 2000) throw new FetchRefused("BAD_REQUEST", `invalid value for ${name}`);
    out[name] = v;
  }
  return out;
}

/**
 * A DNS lookup for `net`/`https` that refuses any private, loopback or link-local answer. Used at connection time, so
 * the address checked is the address connected to.
 * @param {typeof dns.lookup} [resolver]
 */
export function createSafeLookup(resolver = dns.lookup) {
  return (hostname, options, callback) => {
    const opts = typeof options === "function" ? {} : { ...options };
    const cb = typeof options === "function" ? options : callback;
    resolver(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad || list.length === 0) {
        const e = new Error(`${hostname} does not resolve to a public address`);
        e.code = "EPRIVATEADDR";
        return cb(e);
      }
      if (opts.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

/** Sliding per-second and per-minute logs plus a per-UTC-day counter. `take` returns null, or ms until a slot is free. */
export function createRequestLimiter({ perSecond, perMinute, perDay }, clock = Date.now) {
  const sec = [];
  const min = [];
  let day = { key: -1, n: 0 };
  return {
    take() {
      const t = clock();
      while (sec.length && sec[0] <= t - 1000) sec.shift();
      while (min.length && min[0] <= t - 60_000) min.shift();
      const dayKey = Math.floor(t / 86_400_000);
      if (day.key !== dayKey) day = { key: dayKey, n: 0 };
      if (perSecond !== undefined && sec.length >= perSecond) return Math.max(1, sec[0] + 1000 - t);
      if (perMinute !== undefined && min.length >= perMinute) return Math.max(1, min[0] + 60_000 - t);
      if (perDay !== undefined && day.n >= perDay) return Math.max(1, (dayKey + 1) * 86_400_000 - t);
      sec.push(t);
      min.push(t);
      day.n += 1;
      return null;
    },
  };
}

/**
 * The real transport: one https request, no redirects, no compression, body capped.
 * @returns {Promise<{ status: number, headers: Record<string,string>, body: string }>}
 */
export function httpsTransport({ url, method, headers, body, signal, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { protocol: "https:", hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method, headers, lookup, agent: false, signal },
      (res) => {
        const declared = Number(res.headers["content-length"]);
        const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
        if (encoding !== "identity") {
          res.destroy();
          return reject(new FetchRefused("NETWORK", "the server used a content encoding the host did not ask for"));
        }
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new FetchRefused("TOO_LARGE", "the response is larger than the plugin's limit"));
        }
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new FetchRefused("TOO_LARGE", "the response is larger than the plugin's limit"));
          } else chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])), body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => reject(err));
      },
    );
    req.on("error", (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * @param {object} cfg
 * @param {string} cfg.id  plugin id (used in the User-Agent)
 * @param {string} cfg.version
 * @param {string[]} cfg.allowHosts
 * @param {boolean} [cfg.allowPost]
 * @param {{ perSecond?: number, perMinute?: number, perDay?: number, maxResponseBytes?: number }} cfg.limits
 * @param {() => number} [cfg.clock]
 * @param {typeof httpsTransport} [cfg.transport]  injected in tests; the real one is used otherwise
 * @param {typeof dns.lookup} [cfg.resolver]
 * @param {string[]} [cfg.denyExtra]  more broker domains to refuse
 * @param {number} [cfg.maxRedirects]
 */
export function createFetchBroker({ id, version, allowHosts, allowPost = false, limits, clock = Date.now, transport = httpsTransport, resolver, denyExtra = [], maxRedirects = 3 }) {
  const limiter = createRequestLimiter(limits, clock);
  const lookup = createSafeLookup(resolver);
  const maxBytes = limits.maxResponseBytes ?? 2 * 1024 * 1024;
  const stats = { requests: 0, refused: 0, bytes: 0 };

  /**
   * @param {string} rawUrl @param {{ method?: string, headers?: Record<string,string>, body?: string }} [init]
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   */
  async function fetchOnce(rawUrl, init = {}, { signal, timeoutMs = 5000 } = {}) {
    let method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !(method === "POST" && allowPost)) throw new FetchRefused("BAD_REQUEST", `${method} requests are not allowed for this plugin`);
    const headers = { ...cleanRequestHeaders(init.headers), "user-agent": `mc-bridge-plugin/${id}/${version}`, "accept-encoding": "identity" };
    let body = init.body;
    if (body !== undefined && method !== "POST") throw new FetchRefused("BAD_REQUEST", "only POST may carry a body");
    const deadline = AbortSignal.timeout(Math.max(1, timeoutMs));
    const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let target = rawUrl;
    for (let hop = 0; ; hop += 1) {
      const checked = checkOutboundUrl(target, { allowHosts, denyExtra });
      if (!checked.ok) throw new FetchRefused(checked.code, hop ? `redirect refused: ${checked.message}` : checked.message);
      const wait = limiter.take();
      if (wait !== null) throw new FetchRefused("RATE_LIMITED", "the plugin is over its own request limits", wait);
      stats.requests += 1;
      let res;
      try {
        res = await transport({ url: checked.url, method, headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) }, body, signal: both, maxBytes, lookup });
      } catch (err) {
        if (err instanceof FetchRefused) throw err;
        if (signal?.aborted) throw new FetchRefused("CANCELLED", "cancelled");
        if (deadline.aborted || err?.name === "TimeoutError") throw new FetchRefused("TIMEOUT", "the request timed out");
        if (err?.name === "AbortError") throw new FetchRefused("TIMEOUT", "the request timed out");
        if (err?.code === "EPRIVATEADDR") throw new FetchRefused("HOST_NOT_ALLOWED", "the host does not resolve to a public address");
        throw new FetchRefused("NETWORK", `network error${err?.code ? ` (${String(err.code).slice(0, 30)})` : ""}`);
      }
      if (Buffer.byteLength(res.body ?? "") > maxBytes) throw new FetchRefused("TOO_LARGE", "the response is larger than the plugin's limit");
      if (REDIRECTS.has(res.status)) {
        const loc = res.headers?.location;
        if (!loc) throw new FetchRefused("NETWORK", "redirect without a location");
        if (hop >= maxRedirects) throw new FetchRefused("NETWORK", "too many redirects");
        try {
          target = new URL(loc, checked.url).href;
        } catch {
          throw new FetchRefused("BAD_REQUEST", "redirect to an invalid URL");
        }
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      stats.bytes += Buffer.byteLength(res.body ?? "");
      const passed = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) if (PASS_RESPONSE_HEADERS.has(k.toLowerCase())) passed[k.toLowerCase()] = String(v).slice(0, 500);
      return { status: res.status, headers: passed, body: res.body ?? "" };
    }
  }

  return {
    async fetch(rawUrl, init, opts) {
      try {
        return await fetchOnce(rawUrl, init, opts);
      } catch (err) {
        stats.refused += 1;
        throw err;
      }
    },
    stats: () => ({ ...stats }),
  };
}
