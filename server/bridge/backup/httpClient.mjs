/**
 * Small JSON-over-HTTPS client for the backup data providers (Yahoo Finance, NSE India public site). Not for broker
 * APIs: those go through server/brokers/brokerFetch.mjs. Every call has a timeout, a browser-like User-Agent (both
 * sites refuse obvious bots), and maps failures to BridgeError codes the market-data path already understands.
 *
 * A tiny cookie jar is kept per client because NSE's API answers only with the cookies its pages set.
 */
import { BridgeError } from "../core/errors.mjs";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, provider: string }} opts
 */
export function createHttpClient({ fetchImpl = globalThis.fetch, timeoutMs = 8000, provider }) {
  /** name -> value */
  const jar = new Map();

  function storeCookies(res) {
    const raw = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers?.get?.("set-cookie")].filter(Boolean);
    for (const line of raw) {
      for (const part of String(line).split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
        const m = /^\s*([^=;\s]+)=([^;]*)/.exec(part);
        if (m) jar.set(m[1], m[2]);
      }
    }
  }

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  /**
   * GET a URL. Returns { status, json } for 2xx; throws BridgeError otherwise.
   * @param {string} url
   * @param {{ headers?: Record<string, string>, accept404?: boolean, raw?: boolean }} [o]
   */
  async function get(url, o = {}) {
    if (typeof fetchImpl !== "function") throw new BridgeError("BROKER_UNAVAILABLE", `${provider}: no fetch() in this Node.js runtime.`);
    const headers = { "User-Agent": BROWSER_UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", ...o.headers };
    if (jar.size) headers.Cookie = cookieHeader();
    let res;
    try {
      res = await fetchImpl(url, { method: "GET", headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new BridgeError("UPSTREAM_TIMEOUT", `${provider} did not answer within ${timeoutMs} ms.`);
      throw new BridgeError("BROKER_UNAVAILABLE", `${provider} could not be reached (${err?.cause?.code ?? err?.code ?? "network error"}).`);
    }
    storeCookies(res);
    if (o.raw) return { status: res.status, json: null };
    if (res.status === 429) throw new BridgeError("UPSTREAM_RATE_LIMITED", `${provider} is rate limiting requests; backing off.`);
    if (res.status === 401 || res.status === 403) throw new BridgeError("UPSTREAM_ERROR", `${provider} refused the request (HTTP ${res.status}).`, { broker: { id: provider, code: `HTTP_${res.status}` } });
    let json = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new BridgeError("UPSTREAM_ERROR", `${provider} answered with something that is not JSON (HTTP ${res.status}).`);
    }
    if (res.status === 404 && !o.accept404) throw new BridgeError("SYMBOL_NOT_FOUND", `${provider} has no data for this request.`);
    if (res.status >= 400 && res.status !== 404) {
      // Yahoo answers 4xx with { chart: { error } } for a bad symbol or range; let the caller read it.
      return { status: res.status, json };
    }
    return { status: res.status, json };
  }

  return { get, clearCookies: () => jar.clear(), hasCookies: () => jar.size > 0 };
}
