/**
 * What answered a market-data read, in one small record for the request log (GET /v1/requests, field `route`). The
 * Sources page turns it into words such as "answered from Dhan", "served from cache" or "used Yahoo, delayed 15 min".
 *
 *   { from: "stream" | "cache" | "shared" | "live" | "stale", source, sourceName, class, delaySec }
 *
 *   from   stream: a live subscription answered. cache: a value inside its freshness target. shared: the read joined a
 *          call another caller already had in flight. live: a call was made for this read (a broker account or a data
 *          source). stale: at least one value was older than its target (served from the last good value).
 *   source / sourceName   the account's broker or the data source that answered (id and a name to show).
 *   class / delaySec      the least current data class among the answers, and the largest delay.
 *
 * It is built only from the freshness labels the read already returned and one counter, so it costs no extra upstream
 * call and the log never holds a per-symbol list. A read of many symbols is summed up: the verdict is the least current
 * one (stale, then live, shared, cache, stream) and the source is the most informative one (a data source before a
 * broker, then the one that answered most items).
 */
import { BROKER_NAMES } from "../accounts/brokerInfo.mjs";
import { currentRequestContext } from "../ratelimit/consumer.mjs";
import { classRank } from "../sources/contract.mjs";

/**
 * @param {Array<{ source?: string, stale?: boolean, broker?: string | null, provider?: string, class?: string, delaySec?: number | null }>} labels freshness labels of the answered items
 * @param {{ shared?: number, nameOf?: (id: string) => string | undefined }} [o]  shared: how many of the items joined a call already in flight
 * @returns {{ from: "stream"|"cache"|"shared"|"live"|"stale", source?: string, sourceName?: string, class: string, delaySec: number } | null} null when nothing was answered
 */
export function summariseRoute(labels, { shared = 0, nameOf } = {}) {
  let n = 0;
  let stale = 0;
  let live = 0;
  let cache = 0;
  let stream = 0;
  let worst = "realtime";
  let delay = 0;
  /** source id -> { count, data: whether it is a data source } for the answers that name one */
  const sources = new Map();
  for (const f of labels ?? []) {
    if (!f || typeof f !== "object") continue;
    n += 1;
    if (classRank(f.class) > classRank(worst)) worst = f.class;
    if (Number.isFinite(f.delaySec) && f.delaySec > delay) delay = f.delaySec;
    const data = f.source === "backup";
    // Only a cached value can be "served stale": a value just fetched is live even if it is older than a tight maxAgeMs.
    if (f.source === "cache") {
      if (f.stale === true) stale += 1;
      else cache += 1;
    } else if (f.source === "stream") stream += 1;
    else live += 1;
    const id = data ? f.provider : f.broker;
    if (id) {
      const s = sources.get(id) ?? { count: 0, data };
      s.count += 1;
      sources.set(id, s);
    }
  }
  if (n === 0) return null;
  const from = stale ? "stale" : live ? (shared >= live ? "shared" : "live") : cache ? "cache" : "stream";
  const out = { from, class: classRank(worst) < 3 ? worst : "delayed", delaySec: worst === "realtime" ? 0 : delay };
  let best = null;
  for (const [id, s] of sources) if (!best || (s.data && !best.s.data) || (s.data === best.s.data && s.count > best.s.count)) best = { id, s };
  if (best) {
    out.source = best.id;
    const name = best.s.data ? nameOf?.(best.id) : (BROKER_NAMES[best.id] ?? nameOf?.(best.id));
    out.sourceName = typeof name === "string" && name ? name : best.id;
  }
  return out;
}

/** The request context of the work running now (set by the HTTP pipeline), or null. */
const requestContext = () => currentRequestContext();

/** Note that `count` items of the running request joined a call another caller had already started. */
export function markShared(count = 1) {
  const ctx = requestContext();
  if (ctx && typeof ctx === "object") ctx.routeShared = (ctx.routeShared ?? 0) + count;
}

/**
 * Put the route of a finished read on the request context, where the request log picks it up. Does nothing when the read
 * answered nothing. Never throws: the log is advisory.
 * @param {{ route?: object, routeShared?: number } | null | undefined} ctx
 * @param {Parameters<typeof summariseRoute>[0]} labels
 * @param {(id: string) => string | undefined} [nameOf]
 */
export function noteRoute(ctx, labels, nameOf) {
  if (!ctx || typeof ctx !== "object") return;
  try {
    const route = summariseRoute(labels, { shared: ctx.routeShared ?? 0, nameOf });
    if (route) ctx.route = route;
  } catch {
    // advisory only
  }
}
