/**
 * Local-first answers for GET /v1/history: bars this Bridge already holds in a dataset are read from disk, and only the
 * part the dataset does not cover (a newer tail, an older head) is asked of the broker.
 *
 * When it applies:
 *  - `?dataset=<name>` names a dataset: the answer comes from it (a dataset that has no such series is a 404, not a
 *    silent fall-back to the broker);
 *  - `market.history.localFirst` is true: any dataset that covers the range may serve it. Off by default.
 * It never applies to a countback request (the range is not known before the bars are).
 *
 * Honest labels: stored bars carry the data class, source, delay and official flag the dataset was written with. The
 * Freshness says `source: "cache"`, `provider: "dataset:<name>"` and the flag `local`; a mixed answer takes the least
 * current class of ALL its parts (an end-of-day head with a real-time tail is end-of-day), is `partial` when any broker
 * part was, and carries the flag `partly-local`. Daily and longer bars are stored stamped at IST midnight of their date,
 * and the broker's part is stamped the same way, so one series has one style; intraday bars are identical.
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { normaliseBar } from "../downloads/bars.mjs";
import { barStartOf } from "./history.mjs";
import { DATASET_NAME_RE } from "./localStore.mjs";
import { freshness } from "./normalise.mjs";
import { record as recordSaved } from "./savedCalls.mjs";
import { parseTimeInput } from "./time.mjs";

const RANK = { realtime: 0, delayed: 1, eod: 2 };

/**
 * @param {{ store: ReturnType<typeof import("./localStore.mjs").createLocalStore>, history: (params: object, opts: object) => Promise<any>,
 *   now: () => number }} deps
 * @param {{ params: { symbol: string, interval: string, from?: string, to?: string, countback?: number }, opts: object, dataset?: string, enabled: boolean }} req
 * @returns {Promise<null | { data: object, meta: { source: "local" | "mixed", dataset: string, localBars: number, brokerCalls: number } }>}
 *   null when local data does not apply and the caller should ask the broker as usual.
 */
export async function readHistoryLocalFirst({ store, history, now }, { params, opts, dataset, enabled }) {
  if (dataset !== undefined && !DATASET_NAME_RE.test(dataset)) {
    throw new BridgeError("VALIDATION_FAILED", "dataset must be a dataset name: lowercase letters, digits, dashes or underscores.", { errors: [{ path: "dataset", message: "not a valid dataset name" }] });
  }
  if (dataset === undefined && !enabled) return null;
  if (params.from === undefined || params.countback !== undefined) {
    if (dataset !== undefined) throw new BridgeError("VALIDATION_FAILED", "Reading from a dataset needs from (and optionally to); countback is not supported.", { errors: [{ path: "from", message: "required with dataset" }] });
    return null;
  }
  let symbol;
  try {
    symbol = parseSymbol(params.symbol).canonical;
  } catch {
    return null; // the normal path explains a symbol it cannot read
  }
  const t = now();
  const fromMs = parseTimeInput(params.from, { field: "from" });
  let toMs = params.to !== undefined ? parseTimeInput(params.to, { endOfDay: true, field: "to" }) : t;
  if (toMs > t) toMs = t;
  if (fromMs > toMs) return null; // the normal path reports it
  // Daily, weekly and monthly bars are stored at IST midnight: a from inside that bar still means that bar (as on the broker path).
  const fromSec = Math.floor(barStartOf(params.interval, fromMs) / 1000);
  const toSec = Math.floor(toMs / 1000);
  const local = await store.readRange(symbol, params.interval, fromSec, toSec, dataset ? { dataset } : {});
  if (!local.covered) {
    if (dataset !== undefined) throw new BridgeError("NOT_FOUND", `Dataset ${dataset} holds no ${params.interval} bars for ${symbol} in that range.`);
    return null;
  }

  let candles = local.bars;
  const brokerLabels = [];
  let brokerCalls = 0;
  let partial = false;
  for (const gap of local.gaps) {
    const r = await history({ symbol: params.symbol, interval: params.interval, from: gap.from, to: gap.to }, opts);
    brokerCalls += 1;
    brokerLabels.push(r.freshness);
    if (r.partial) partial = true;
    // Stored daily and longer bars are stamped at IST midnight: stamp the broker's part the same way, so one series has one style.
    const fetched = r.candles.map((c) => normaliseBar(c, params.interval) ?? c);
    const seen = new Set(candles.map((c) => c.time));
    candles = [...candles, ...fetched.filter((c) => !seen.has(c.time))];
  }
  candles.sort((a, b) => a.time - b.time);
  if (!brokerCalls) recordSaved(1, "local-history");

  const src = local.source;
  const worst = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);
  const updatedAt = Date.parse(src.updatedAt ?? "") || t;
  const localLabel = freshness({
    source: "cache",
    at: updatedAt,
    now: t,
    targetMs: Number.MAX_SAFE_INTEGER,
    stale: false,
    provider: `dataset:${src.dataset}`,
    class: src.dataClass,
    delaySec: src.delaySec,
    official: src.official ?? false,
    confidence: src.dataClass === "realtime" ? "high" : "medium",
    flags: ["local"],
  });
  let label = localLabel;
  const fetchedLabels = brokerLabels.filter(Boolean);
  if (fetchedLabels.length) {
    // The answer is only as good as its worst part: fold the class, delay, official flag, confidence and flags of the
    // stored bars and of EVERY broker part (an end-of-day head with a real-time tail is end-of-day).
    const parts = [localLabel, ...fetchedLabels];
    const cls = parts.reduce((acc, p) => worst(acc, p.class ?? "realtime"), "realtime");
    const lead = fetchedLabels.find((p) => (p.class ?? "realtime") === cls) ?? fetchedLabels[0];
    const confRank = { high: 0, medium: 1, low: 2 };
    const confidence = parts.reduce((acc, p) => ((confRank[p.confidence] ?? 0) > (confRank[acc] ?? 0) ? p.confidence : acc), "high");
    label = {
      ...lead,
      class: cls,
      delaySec: cls === "realtime" ? 0 : Math.max(...parts.map((p) => p.delaySec ?? 0)),
      official: parts.every((p) => p.official === true),
      confidence,
      flags: [...new Set([...parts.flatMap((p) => p.flags ?? []).filter((f) => f !== "local"), "partly-local"])],
    };
  }
  return {
    data: { symbol, interval: params.interval, candles, partial, freshness: label },
    meta: { source: brokerCalls ? "mixed" : "local", dataset: src.dataset, localBars: local.bars.length, brokerCalls },
  };
}
