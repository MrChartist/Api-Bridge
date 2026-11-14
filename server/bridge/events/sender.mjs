/**
 * One webhook call: check the target, resolve it, sign the body, send it, and say in a few plain words what happened.
 * Never throws; never returns the receiver's answer text, the full URL, the secret or the signature.
 *
 * Result: { ok, status?, code?, retryable, retryAfterMs?, durationMs }
 *   code (when not ok): http_4xx, http_5xx, http_429, http_408, redirect_refused, timeout, dns_failed, connect_failed, tls_failed,
 *   request_failed, or a target refusal from urlPolicy.mjs (blocked_scheme, blocked_host, blocked_address, host_not_listed, bad_url ...).
 *   retryable: whether sending the same event again later can help.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { checkTargetUrl, resolveAllowed } from "./urlPolicy.mjs";
import { HEADERS, signatureHeaders } from "./signature.mjs";
import { classifySocketError, createHttpTransport } from "./transport.mjs";

/** Words for the delivery log and the dashboard, one per code. */
export const FAILURE_TEXT = Object.freeze({
  http_4xx: "The receiver refused the request (a 4xx answer). Check its signature check and URL.",
  http_5xx: "The receiver had an error (a 5xx answer).",
  http_429: "The receiver asked the Bridge to slow down (429).",
  http_408: "The receiver timed out (408).",
  redirect_refused: "The receiver answered with a redirect. The Bridge never follows redirects; use the final URL.",
  timeout: "The receiver did not answer in time.",
  dns_failed: "The host name could not be looked up.",
  connect_failed: "The Bridge could not connect to the receiver.",
  tls_failed: "The receiver's certificate could not be verified.",
  request_failed: "The request could not be sent.",
  blocked_scheme: "Only https:// targets are allowed.",
  blocked_host: "This host is not allowed.",
  blocked_address: "This address is not allowed (private, loopback, link-local or cloud metadata).",
  blocked_credentials: "The URL has a user name or password.",
  host_not_listed: "This host is not on the allowed list.",
  bad_url: "The URL is not valid.",
  secret_missing: "The signing secret is missing from the secrets store (it was lost, or this Bridge runs in demo mode, which keeps secrets in memory only). Send it again with PATCH, then send the dead letters again.",
});

const PERMANENT_TARGET_CODES = new Set(["blocked_scheme", "blocked_host", "blocked_address", "blocked_credentials", "host_not_listed", "bad_url"]);

/** Seconds or an HTTP date -> ms, or null. */
export function parseRetryAfter(value, nowMs) {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (/^\d{1,7}$/.test(v)) return Number(v) * 1000;
  const t = /[A-Za-z]/.test(v) ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/**
 * @param {{ policy: () => { allowPrivateTargets: boolean, allowedHosts: string[], timeoutMs: number, maxResponseBytes: number },
 *   transport?: import("./transport.mjs").Transport, resolve?: (host: string) => Promise<Array<{ address: string, family: number }>>,
 *   now?: () => number, version?: string }} opts
 */
export function createSender({ policy, transport = createHttpTransport(), resolve = (h) => dnsLookup(h, { all: true, verbatim: true }), now = () => Date.now(), version = "2" }) {
  /**
   * @param {{ url: string, secret: string, body: string, headers?: Record<string, string> }} req  the Bridge's own headers are added
   */
  async function send({ url, secret, body, headers = {} }) {
    const t0 = now();
    const fail = (code, extra = {}) => ({ ok: false, code, retryable: !PERMANENT_TARGET_CODES.has(code) && code !== "redirect_refused" && code !== "http_4xx", durationMs: Math.max(0, now() - t0), ...extra });
    const p = policy();
    const target = checkTargetUrl(url, p);
    if (!target.ok) return fail(target.code);
    const where = await resolveAllowed(target, { resolve, allowPrivateTargets: p.allowPrivateTargets });
    if (!where.ok) return fail(where.code);
    const stamp = Math.floor(now() / 1000);
    let res;
    try {
      res = await transport({
        url: target.url,
        address: where.address,
        family: where.family,
        headers: { "Content-Type": "application/json", "User-Agent": `mc-bridge-events/${version}`, ...headers, ...signatureHeaders(secret, stamp, body) },
        body,
        timeoutMs: p.timeoutMs,
        maxResponseBytes: p.maxResponseBytes,
      });
    } catch (err) {
      return fail(classifySocketError(err));
    }
    const durationMs = Math.max(0, now() - t0);
    const s = res.status;
    if (s >= 200 && s < 300) return { ok: true, status: s, retryable: false, durationMs };
    if (s >= 300 && s < 400) return { ok: false, status: s, code: "redirect_refused", retryable: false, durationMs };
    if (s === 429 || s === 408 || s === 425 || (s >= 500 && s < 600)) {
      const code = s === 429 ? "http_429" : s === 408 || s === 425 ? "http_408" : "http_5xx";
      const ra = parseRetryAfter(res.retryAfter, now());
      return { ok: false, status: s, code, retryable: true, ...(ra !== null ? { retryAfterMs: ra } : {}), durationMs };
    }
    return { ok: false, status: s, code: "http_4xx", retryable: false, durationMs };
  }
  return { send };
}

export { HEADERS };
