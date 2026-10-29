/**
 * Egress IP detector (docs/spec/p1-05-readiness.md §2.3, §7.3, §7.6). Asks the IP-echo service the USER chose
 * (readiness.egressIp.lookupUrl) which address this computer's requests come from. Off by default; never called in
 * "off" or "manual" mode.
 *
 * Rules: https only (http only to 127.0.0.1 / localhost / [::1]); redirects refused; timeout; the answer is read up to
 * 1 KB and then dropped; the address is registered with logger.addSecret so it never appears in a log line, and it is
 * never written to disk (the monitor keeps it in memory). The result is labelled with the service's host name: it is
 * what THAT service saw, which can differ from what the broker sees (VPN split tunnels, dual WAN, IPv6).
 *
 * Clock skew (§7.6): skewMs = Date(response) + 500 − midpoint(requestStart, responseEnd); the +500 ms makes up for the
 * header's 1 s resolution.
 */
import { lookupUrlProblem } from "./config.mjs";
import { LOOKUP_BODY_MAX_BYTES, parseLookupBody } from "./ip.mjs";

/** skew from a Date header and the request's start and end (all ms). null when the header is missing or bad. */
export function clockSkewMs(dateHeader, startMs, endMs) {
  const t = Date.parse(String(dateHeader ?? ""));
  if (!Number.isFinite(t)) return null;
  return Math.round(t + 500 - (startMs + endMs) / 2);
}

async function readCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const t = await res.text();
    return Buffer.byteLength(t) > max ? null : t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {{ cfg: { mode: string, lookupUrl: string | null, timeoutMs: number }, fetchImpl?: typeof fetch,
 *   clock?: { now(): number }, logger?: any }} opts
 */
export function createEgressDetector({ cfg, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, logger } = {}) {
  const host = (() => {
    try {
      return cfg?.lookupUrl ? new URL(cfg.lookupUrl).host : null;
    } catch {
      return null;
    }
  })();
  return {
    /** The service host, for "as seen by <host>". */
    seenBy: host,
    /**
     * One lookup. Never throws: { ok: true, ip, family, at, seenBy, clockSkewMs } or { ok: false, error, at, seenBy }.
     */
    async lookup() {
      const at = clock.now();
      if (cfg?.mode !== "lookup" || !cfg.lookupUrl) return { ok: false, error: "lookup is off", at, seenBy: host };
      const problem = lookupUrlProblem(cfg.lookupUrl);
      if (problem) return { ok: false, error: `lookupUrl ${problem}`, at, seenBy: host };
      const started = clock.now();
      try {
        const res = await fetchImpl(cfg.lookupUrl, {
          method: "GET",
          headers: { Accept: "text/plain, application/json", "User-Agent": "mrchartist-api-bridge" },
          redirect: "error",
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) {
          await res.text().catch(() => "");
          return { ok: false, error: `the service answered HTTP ${res.status}`, at: clock.now(), seenBy: host };
        }
        const text = await readCapped(res, LOOKUP_BODY_MAX_BYTES);
        const ended = clock.now();
        if (text === null) return { ok: false, error: "the answer was larger than 1 KB", at: ended, seenBy: host };
        const parsed = parseLookupBody(text, res.headers?.get?.("content-type"));
        if ("error" in parsed) return { ok: false, error: parsed.error, at: ended, seenBy: host };
        logger?.addSecret?.(parsed.ip);
        return { ok: true, ip: parsed.ip, family: parsed.family, at: ended, seenBy: host, clockSkewMs: clockSkewMs(res.headers?.get?.("date"), started, ended) };
      } catch (err) {
        const why = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timed out" : err?.cause?.code ?? err?.name ?? "network error";
        return { ok: false, error: `could not reach the service (${why})`, at: clock.now(), seenBy: host };
      }
    },
  };
}
