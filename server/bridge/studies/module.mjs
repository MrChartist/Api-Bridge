/**
 * studies module, stream S31: chart studies and candlestick patterns from the ChartistScript core (the owner's code,
 * vendored compiled and unchanged in server/vendor/chartist-core; docs/guides/studies.md). Read only:
 *
 *   GET  /v1/studies            the studies (`ind.<id>`) and patterns on offer: settings, ranges, outputs, pane
 *   POST /v1/studies/compute    { symbol, interval, from?, to?, countback?, studies?, patterns?, script?, inputs?, warmup? }
 *                               reads candles through the market data service (as /v1/history, ?account= pinned) and
 *                               gives series aligned to the candles' times, plus pattern and script markers
 *
 * The calculation runs in a worker thread (pool.mjs) with a time limit, a heap limit and the core's own budget. Nothing
 * here reaches orders: the core has no order code, the worker gets candles and gives numbers, and the module uses only
 * the market data service (USED_SERVICES; noOrders.test.mjs checks the whole import graph).
 *
 * Config (file only): studies { workers, timeoutMs, maxQueue, maxOldMb }.
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { defineModule } from "../core/modules.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { parseTimeInput } from "../market/time.mjs";
import { MAX_BARS, catalogue } from "./compute.mjs";
import { createStudyPool } from "./pool.mjs";

export const configSchema = z
  .object({
    workers: z.number().int().min(1).max(8).default(2),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    maxQueue: z.number().int().min(0).max(256).default(16),
    maxOldMb: z.number().int().min(32).max(4096).default(256),
  })
  .strict();

/** Largest request body: a 12,000-character script and its settings fit many times over. */
export const BODY_LIMIT_BYTES = 64 * 1024;
/** Intervals the core can read: one candle per session or coarser. */
export const STUDY_INTERVALS = Object.freeze(["1d", "1w", "1M"]);
/** Candles shown when the request gives neither from nor countback. */
export const DEFAULT_COUNTBACK = 500;

export const ROUTES = Object.freeze([
  ["GET", "/v1/studies", { scope: "read" }, "list"],
  ["POST", "/v1/studies/compute", { scope: "read", bodyLimitBytes: BODY_LIMIT_BYTES }, "compute"],
]);

/** The only service this module reads. */
export const USED_SERVICES = Object.freeze(["marketData"]);

const BODY_KEYS = new Set(["symbol", "interval", "from", "to", "countback", "studies", "patterns", "script", "inputs", "warmup"]);
const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

/** Calendar milliseconds that hold `bars` candles of an interval, with room for weekends and holidays. */
export function warmSpanMs(bars, interval) {
  const day = 86_400_000;
  if (bars <= 0) return 0;
  if (interval === "1w") return (bars * 7 + 14) * day;
  if (interval === "1M") return (bars * 31 + 62) * day;
  return (Math.ceil(bars * 1.5) + 14) * day; // about 250 sessions a year; 1.5 covers weekends and the holiday-heavy months
}

/** Check the request body (shape only: the job itself is checked by the core in the worker). */
export function parseComputeBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body", "Send a JSON object.");
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) throw invalid(k, `Unknown field ${k}.`);
  const { symbol, interval } = body;
  if (typeof symbol !== "string" || !symbol.trim() || symbol.length > 64) throw invalid("symbol", "symbol is required, for example NSE:RELIANCE.");
  if (typeof interval !== "string" || !STUDY_INTERVALS.includes(interval)) {
    throw invalid("interval", `interval must be ${STUDY_INTERVALS.join(", ")}: studies read one candle per session (intraday candles are not supported).`);
  }
  for (const k of ["from", "to"]) {
    const v = body[k];
    if (v !== undefined && !((typeof v === "string" && v.length <= 40) || (typeof v === "number" && Number.isFinite(v)))) throw invalid(k, `${k} must be a date (2026-10-19), a date and time, or epoch seconds.`);
  }
  if (body.countback !== undefined && (!Number.isInteger(body.countback) || body.countback < 1 || body.countback > MAX_BARS)) throw invalid("countback", `countback must be a whole number from 1 to ${MAX_BARS}.`);
  if (body.from !== undefined && body.countback !== undefined) throw invalid("countback", "Give from (and optionally to), or countback, not both.");
  if (body.warmup !== undefined && typeof body.warmup !== "boolean") throw invalid("warmup", "warmup must be true or false.");
  const job = {};
  for (const k of ["studies", "patterns", "script", "inputs"]) if (body[k] !== undefined) job[k] = body[k];
  return { symbol: symbol.trim(), interval, from: body.from, to: body.to, countback: body.countback, warmup: body.warmup !== false, job };
}

/**
 * The handlers, given the market data service and a pool.
 * @param {{ marketData: object, backupData?: object }} deps
 * @param {ReturnType<typeof createStudyPool>} pool
 */
export function createStudyRoutes(deps, pool) {
  const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });
  return {
    async list(ctx) {
      return { data: catalogue(), meta: meta(ctx) };
    },

    async compute(ctx) {
      const p = parseComputeBody(ctx.body);
      const opts = readOptionsBase(ctx, { maxAge: false, autoBackup: autoBackupFor(deps) });
      // 1. Check and compile in the worker: a bad script or setting fails here, before any broker call.
      const plan = await pool.plan(p.job, { signal: ctx.signal });
      const warm = p.warmup ? plan.warmBars : 0;

      // 2. Candles: the range asked for, plus `warm` earlier ones so the first value shown is already reliable.
      const params = { symbol: p.symbol, interval: p.interval };
      let fromSec = null;
      if (p.from !== undefined) {
        const fromMs = parseTimeInput(p.from, { field: "from" });
        fromSec = Math.floor(fromMs / 1000);
        params.from = Math.max(0, Math.floor((fromMs - warmSpanMs(warm, p.interval)) / 1000));
        if (p.to !== undefined) params.to = p.to;
      } else {
        params.countback = Math.min(MAX_BARS + warm, (p.countback ?? DEFAULT_COUNTBACK) + warm);
        if (params.countback > 5000) params.countback = 5000; // the history service's own cap
        if (p.to !== undefined) params.to = p.to;
      }
      const h = await deps.marketData.history(params, opts);
      const candles = (h.candles ?? []).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }));

      // 3. The visible part: from `from` on, or the last `countback`; at most MAX_BARS (the newest are kept).
      let start = fromSec === null ? Math.max(0, candles.length - (p.countback ?? DEFAULT_COUNTBACK)) : candles.findIndex((c) => c.time >= fromSec);
      if (start < 0) start = candles.length;
      let truncated = false;
      if (candles.length - start > MAX_BARS) {
        start = candles.length - MAX_BARS;
        truncated = true;
      }
      const first = Math.max(0, start - plan.warmBars);
      const used = candles.slice(p.warmup ? first : start);
      const from = start - (p.warmup ? first : start);
      const out = await pool.run(p.job, used, from, { signal: ctx.signal });
      return {
        data: {
          symbol: h.symbol ?? p.symbol,
          interval: p.interval,
          partial: Boolean(h.partial),
          truncated,
          warmup: { needed: plan.warmBars, used: from, short: Math.max(0, (p.warmup ? plan.warmBars : 0) - from) },
          ...out,
        },
        meta: meta(ctx, { accountId: opts.accountId ?? null, freshness: h.freshness ?? null, core: catalogue().core }),
      };
    },
  };
}

const pools = new WeakMap();

export default defineModule({
  name: "studies",
  stream: "S31",
  configKey: "studies",
  configSchema,
  register(app, deps) {
    const cfg = configSchema.parse(deps.config?.studies ?? {});
    const pool = createStudyPool({ size: cfg.workers, timeoutMs: cfg.timeoutMs, maxQueue: cfg.maxQueue, maxOldMb: cfg.maxOldMb });
    pools.set(deps, pool);
    const handlers = createStudyRoutes(deps, pool);
    for (const [method, path, options, name] of ROUTES) app.route(method, path, handlers[name], options);
  },
  async stop(deps) {
    await pools.get(deps)?.close();
  },
});

/** The pool of a deps object (tests). */
export const studyPoolOf = (deps) => pools.get(deps) ?? null;
