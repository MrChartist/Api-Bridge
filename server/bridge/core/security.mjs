/**
 * Transport guards that run on EVERY request before routing: Host allowlist (DNS rebinding), Origin allowlist
 * (CORS), loopback detection and baseline response headers.
 *
 * Why the Host check: a web page on evil.example can resolve its own name to 127.0.0.1 and make the browser talk
 * to the Bridge. The browser then sends `Host: evil.example`, which we refuse. Loopback names on our own port are
 * always allowed; anything else must be listed in config (server.allowedHosts / publicIngress.allowedHosts).
 *
 * Why the Origin check: a browser always sends Origin on cross-origin requests. If it is present it must be on the
 * allowlist (cors.allowedOrigins); there is no "*". Requests without Origin (curl, Python, Excel, charting platforms'
 * servers) pass this check and are judged by their API key.
 */
import { BridgeError } from "./errors.mjs";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** Parse a Host header into { name, port }. Returns null when malformed. */
export function parseHostHeader(host) {
  const h = String(host ?? "").trim().toLowerCase();
  if (!h || h.length > 255) return null;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h);
  if (!m) return null;
  return { name: m[1], port: m[2] ? Number(m[2]) : null };
}

/**
 * Build the Host allowlist check for one listener.
 * @param {{ port: number, allowedHosts?: string[] }} opts  port: the port this listener is bound to.
 * @returns {(hostHeader: string | undefined) => boolean}
 */
export function createHostCheck({ port, allowedHosts = [] }) {
  const extra = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
  return (hostHeader) => {
    const parsed = parseHostHeader(hostHeader);
    if (!parsed) return false;
    const full = parsed.port === null ? parsed.name : `${parsed.name}:${parsed.port}`;
    if (extra.has(full) || extra.has(parsed.name)) return true;
    if (!LOOPBACK_NAMES.includes(parsed.name)) return false;
    // Loopback name: the port must be ours (or absent, which some clients do for port 80).
    return parsed.port === null || parsed.port === port || port === 0;
  };
}

/** True when the TCP peer address is loopback. Never trusts X-Forwarded-For. */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? "");
  return a === "::1" || a === "127.0.0.1" || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/** Headers that tunnels and reverse proxies add. Their presence means the request did not start on this computer. */
export const FORWARDING_HEADERS = Object.freeze([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "ngrok-trace-id",
]);

/** True when the Host header names this computer (127.0.0.1, localhost or [::1]) rather than a tunnel host. */
export function isLoopbackHostHeader(hostHeader) {
  const parsed = parseHostHeader(hostHeader);
  return parsed !== null && LOOPBACK_NAMES.includes(parsed.name);
}

/**
 * True only when a request genuinely comes from this computer. A tunnel client (cloudflared, ngrok) runs locally,
 * so its TCP peer address is 127.0.0.1 even though the caller is on the internet. We therefore also require a
 * loopback Host name (a tunnel host matched through server.allowedHosts is not one) and no forwarding headers.
 * @param {import("node:http").IncomingMessage} req
 */
export function isLocalRequest(req, { localPeers = [] } = {}) {
  const peer = req?.socket?.remoteAddress;
  if (!isLoopbackAddress(peer) && !peerInList(peer, localPeers)) return false;
  if (!isLoopbackHostHeader(req.headers?.host)) return false;
  for (const h of FORWARDING_HEADERS) if (req.headers?.[h] !== undefined) return false;
  return true;
}

/**
 * @param {{ allowedOrigins?: string[] }} opts
 * @returns {{ isAllowed(origin: string | undefined): boolean, headersFor(origin: string): Record<string, string> }}
 */
export function createCors({ allowedOrigins = [] }) {
  const allowed = new Set(allowedOrigins.map((o) => o.toLowerCase().replace(/\/$/, "")));
  return {
    isAllowed(origin) {
      if (origin === undefined) return true;
      return allowed.has(String(origin).toLowerCase());
    },
    headersFor(origin) {
      return {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-API-Key, X-Request-Id, X-MCB-Signature",
        "Access-Control-Expose-Headers": "X-Request-Id, RateLimit, RateLimit-Policy, Retry-After, Idempotency-Replayed",
        "Access-Control-Max-Age": "600",
      };
    },
  };
}

/**
 * True when Origin is this very server as addressed by the (already Host-checked) Host header, for example the
 * dashboard served from http://127.0.0.1:4300 calling its own API. Safe against DNS rebinding because the Host
 * check has already refused foreign host names.
 */
export function isSameOrigin(origin, hostHeader) {
  if (typeof origin !== "string" || typeof hostHeader !== "string") return false;
  return origin.toLowerCase() === `http://${hostHeader.trim().toLowerCase()}`;
}

/** Headers set on every response. */
export const BASE_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
});

/**
 * Run the Host and Origin checks for a request. Throws BridgeError on refusal.
 * @param {import("node:http").IncomingMessage} req
 * @param {{ hostCheck: (h?: string) => boolean, cors: ReturnType<typeof createCors> }} guards
 */
export function assertTransportAllowed(req, { hostCheck, cors }) {
  if (!hostCheck(req.headers.host)) throw new BridgeError("HOST_NOT_ALLOWED", "This request was addressed to a host name the Bridge does not answer to.");
  const origin = req.headers.origin;
  if (origin !== undefined && !cors.isAllowed(origin) && !isSameOrigin(origin, req.headers.host)) {
    throw new BridgeError("ORIGIN_NOT_ALLOWED", "Add this page's origin to cors.allowedOrigins in bridge.config.json to allow it.");
  }
}

/**
 * Defence in depth for writes (docs/spec/p1-05-readiness.md §3.9 F7): a browser that says the request is cross-site
 * or same-site (Sec-Fetch-Site) but sends NO allowlisted or same-origin Origin is refused for every method other than
 * GET/HEAD/OPTIONS. Modern browsers send Origin on cross-origin writes anyway, so this only closes the gap where
 * Origin is missing. Non-browser clients never send Sec-Fetch-* headers, so nothing legitimate breaks. "same-site" is
 * included because http://localhost:5173 and http://127.0.0.1:4300 are same-site but not same-origin.
 * @param {import("node:http").IncomingMessage} req
 * @param {ReturnType<typeof createCors>} cors
 */
export function assertNotCrossSiteWrite(req, cors) {
  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const raw = req.headers["sec-fetch-site"];
  const site = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim().toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return;
  const origin = req.headers.origin;
  if (origin !== undefined && (cors.isAllowed(origin) || isSameOrigin(origin, req.headers.host))) return;
  throw new BridgeError("ORIGIN_NOT_ALLOWED", "This browser request comes from another site. Add that page's origin to cors.allowedOrigins in bridge.config.json to allow it.");
}

/**
 * Whether an IPv4 peer (plain or IPv4-mapped IPv6) matches one of `list` (addresses or CIDR blocks).
 * Used only for server.localPeers (Docker).
 * @param {string | undefined} addr @param {string[]} list
 */
export function peerInList(addr, list) {
  if (!list?.length) return false;
  let a = String(addr ?? "");
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return false;
  const toInt = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
  for (const e of list) {
    const [base, bitsText] = String(e).split("/");
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!(bits >= 0 && bits <= 32)) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((toInt(a) & mask) >>> 0) === ((toInt(base) & mask) >>> 0)) return true;
  }
  return false;
}
