/**
 * Consented client for three public files on the NSE archives host (stream S16, docs/spec/p1-02-reference.md §2.6,
 * §7.2). Shared by later specs (P1-3c back-fill, P1-13a participants): they add their own file kinds here.
 *
 * Polite by construction: one request in flight, at least `gapMs` between two requests, a timeout, a body cap (before
 * and after unzip), and the browser User-Agent of backup/httpClient.mjs. It never calls the NSE website API. The
 * reference service constructs it only when the user has turned archive downloads on, and never in demo mode.
 *
 * URLs and layouts NEED VERIFICATION (§7.3), and so does the legal position on automated fetching from this host.
 */
import { createHash } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { BROWSER_UA } from "../backup/httpClient.mjs";
import { readBodyCapped } from "../../lib/safeArchive.mjs";
import { nseFileDate } from "./parsers.mjs";

/** File kinds -> path on the archives host (date: the IST trading date the file is for). */
export const ARCHIVE_FILES = Object.freeze({
  mktlots: Object.freeze({ path: () => "/content/fo/fo_mktlots.csv", name: "fo_mktlots.csv" }),
  secban: Object.freeze({ path: (date) => `/archives/fo/sec_ban/fo_secban_${nseFileDate(date)}.csv`, name: "fo_secban.csv" }),
  combineoi: Object.freeze({ path: (date) => `/archives/nsccl/mwpl/combineoi_${nseFileDate(date)}.zip`, name: "combineoi.zip" }),
  /** Participant-wise OI (P1-13a, stream S26). The participants module may pass its own path template (config). */
  participantoi: Object.freeze({ path: (date) => `/content/nsccl/fao_participant_oi_${nseFileDate(date)}.csv`, name: "fao_participant_oi.csv" }),
});

/** Paths a caller may pass: relative to the archives host, no scheme, no "..", no query. */
const SAFE_PATH = /^\/(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;

/**
 * @param {{ baseUrl: string, gapMs: number, timeoutMs: number, maxBytes: number, fetchImpl?: typeof fetch,
 *   now?: () => number, sleep?: (ms: number) => Promise<void> }} o
 */
export function createNseArchiveClient({ baseUrl, gapMs, timeoutMs, maxBytes, fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let chain = Promise.resolve();
  let lastAt = 0;
  let requests = 0;

  async function fetchOnce(kind, date, pathOverride) {
    const spec = ARCHIVE_FILES[kind];
    if (!spec) throw new BridgeError("VALIDATION_FAILED", `Unknown archive file ${kind}.`);
    if (pathOverride !== undefined && !SAFE_PATH.test(String(pathOverride))) throw new BridgeError("VALIDATION_FAILED", "Archive path must be a plain path on the archives host.");
    const wait = lastAt + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
    requests += 1;
    const url = `${baseUrl.replace(/\/+$/, "")}${pathOverride ?? spec.path(date)}`;
    if (typeof fetchImpl !== "function") throw new BridgeError("BROKER_UNAVAILABLE", "NSE archives: no fetch() in this Node.js runtime.");
    let res;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { "User-Agent": BROWSER_UA, Accept: "text/csv, application/zip, */*" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new BridgeError("UPSTREAM_TIMEOUT", `NSE archives did not answer within ${timeoutMs} ms.`);
      throw new BridgeError("UPSTREAM_ERROR", `NSE archives could not be reached (${err?.cause?.code ?? err?.code ?? "network error"}).`);
    } finally {
      lastAt = now();
    }
    if (res.status === 429) throw new BridgeError("UPSTREAM_RATE_LIMITED", "NSE archives are rate limiting requests; the next scheduled run will try again.");
    if (res.status === 404) {
      const err = new BridgeError("UPSTREAM_ERROR", `NSE has not published ${spec.name} for ${date} yet (HTTP 404).`);
      err.httpStatus = 404;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) throw new BridgeError("UPSTREAM_ERROR", `NSE archives answered HTTP ${res.status} for ${spec.name}.`);
    let buf;
    try {
      buf = await readBodyCapped(res, { maxBytes, label: `NSE ${spec.name}` });
    } catch (err) {
      throw new BridgeError("UPSTREAM_ERROR", err?.message ?? `NSE ${spec.name} was too large.`);
    } finally {
      lastAt = now();
    }
    return { kind, date, url, name: spec.name, buf, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  }

  return {
    /**
     * Download one file (queued behind any request in flight).
     * @param {"mktlots"|"secban"|"combineoi"|"participantoi"} kind
     * @param {string} date  IST trading date (ignored for mktlots)
     * @param {{ path?: string }} [o]  a path on the archives host instead of the kind's default (participants config)
     */
    fetchFile(kind, date, { path } = {}) {
      const run = chain.then(() => fetchOnce(kind, date, path));
      chain = run.catch(() => {});
      return run;
    },
    /** Requests made by this client since it was created. */
    requests: () => requests,
  };
}
