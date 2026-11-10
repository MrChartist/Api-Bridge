/**
 * The one place a webhook leaves the Bridge. node:https / node:http, no dependency, and deliberately plain:
 *
 *  - it connects to the address the caller already checked (`address`), never to a second lookup of the name; the host
 *    name is still sent as the Host header and as the TLS server name, and the certificate is always verified;
 *  - it never follows a redirect (node:http does not; a 3xx is reported as it is, and the sender treats it as a failure);
 *  - one connection per request (`agent: false`, `Connection: close`), a total deadline and a socket idle timeout;
 *  - the answer's body is not used: at most `maxResponseBytes` are read and dropped, then the connection is closed, so a
 *    receiver cannot make the Bridge buffer or act on what it says back.
 *
 * Tests give the sender a fake transport with the same shape and never reach this file's sockets, except the few that
 * talk to a server on 127.0.0.1 with private targets allowed.
 */
import http from "node:http";
import https from "node:https";

/**
 * @typedef {{ url: URL, address: string, family: 4 | 6, method?: string, headers: Record<string, string>, body: string,
 *   timeoutMs: number, maxResponseBytes: number }} TransportRequest
 * @typedef {{ status: number, retryAfter: string | null, hasLocation: boolean }} TransportResponse
 * @typedef {(req: TransportRequest) => Promise<TransportResponse>} Transport
 */

const TLS_CODES = /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_SSL)/;

/** A short code for a socket error. Never the error's own text (it can name addresses and paths). */
export function classifySocketError(err) {
  const code = String(err?.code ?? "");
  if (err?.name === "TimeoutError" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "TIMEOUT") return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
  if (TLS_CODES.test(code)) return "tls_failed";
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") return "connect_failed";
  return "request_failed";
}

/** @returns {Transport} */
export function createHttpTransport({ httpsRequest = https.request, httpRequest = http.request } = {}) {
  return function send(r) {
    return new Promise((resolve, reject) => {
      const secure = r.url.protocol === "https:";
      const body = Buffer.from(r.body, "utf8");
      const host = r.url.hostname.replace(/^\[|\]$/g, "");
      const isIp = /^[\d.]+$/.test(host) || host.includes(":");
      let finished = false;
      let deadline = null;
      const done = (fn, v) => {
        if (finished) return;
        finished = true;
        fn(v);
      };
      const opts = {
        method: r.method ?? "POST",
        hostname: host,
        port: r.url.port || (secure ? 443 : 80),
        path: `${r.url.pathname}${r.url.search}`,
        agent: false,
        headers: { ...r.headers, Host: r.url.host, "Content-Length": String(body.length), Connection: "close" },
        // Connect to the vetted address. Node calls lookup with { all: true } when it tries several families.
        lookup: (_name, o, cb) => (o && o.all ? cb(null, [{ address: r.address, family: r.family }]) : cb(null, r.address, r.family)),
        timeout: r.timeoutMs,
        ...(secure && !isIp ? { servername: host } : {}),
      };
      const req = (secure ? httpsRequest : httpRequest)(opts, (res) => {
        let read = 0;
        const out = { status: res.statusCode ?? 0, retryAfter: typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : null, hasLocation: Boolean(res.headers.location) };
        res.on("data", (chunk) => {
          read += chunk.length;
          if (read > r.maxResponseBytes) res.destroy();
        });
        res.on("error", () => {});
        done(resolve, out);
        // Keep reading (and dropping) until the receiver is done, the cap is hit or the deadline closes the socket.
        res.resume();
        res.on("end", () => req.destroy());
        res.on("close", () => req.destroy());
      });
      deadline = setTimeout(() => {
        const e = Object.assign(new Error("deadline"), { code: "ETIMEDOUT" });
        req.destroy(e);
        done(reject, e);
      }, r.timeoutMs);
      deadline.unref?.();
      req.on("timeout", () => {
        const e = Object.assign(new Error("idle"), { code: "ETIMEDOUT" });
        req.destroy(e);
        done(reject, e);
      });
      req.on("error", (e) => done(reject, e));
      req.on("close", () => clearTimeout(deadline)); // until then the deadline also bounds a receiver that trickles its answer
      req.end(body);
    });
  };
}
