/**
 * Scanner — stream S13. Runs a condition (expr.mjs) over a universe of symbols and returns the ones that match, with
 * any columns asked for. Built for big universes without tripping broker limits:
 *
 *  - Candles are fetched at "background" priority, so charts, Option Hub and orders always go first.
 *  - When several of the caller's accounts may pool reads (same holder, pooling on, broker allows it), the symbols are
 *    shared out: one worker pool per account, each pinned to its account and as wide as that account's history
 *    budget, all pulling from one queue. A faster account simply takes more symbols. The rate-limit engine still
 *    paces every call, so no account goes over its limits.
 *  - With source "auto" a symbol no broker can serve is fetched from the backup sources (Yahoo) when they are on;
 *    with "backup" the scan never touches a broker at all (handy for big end-of-day scans).
 *  - Every result row says where its candles came from.
 *
 * Saved scans (dataDir/scanner/saved.json) can run every N minutes during market hours, or once after the close;
 * when a run finds symbols the previous run did not, the bus gets "scan.alert" (WebSocket clients with subscribe_scans
 * receive it; the notify module sends it on when the scan asks), and each new symbol becomes a "Scan hit" row in Live
 * events.
 *
 * Live scans (interval "live") run on facts (facts.mjs): daily bars cached once a day with today's bar live at the end,
 * plus F&O, option-chain, IV-history and MWPL numbers per symbol. Their data comes from the shared reads
 * (liveFacts.mjs), or from the demo market in demo mode (demoFacts.mjs). Every live run reports its time and the
 * broker calls it caused (the scheduler counts calls per consumer; live collects run one at a time as "Scanner").
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { INTERVALS, countbackRange } from "../market/history.mjs";
import { marketSession } from "../../lib/marketHours.mjs";
import { isStub } from "../core/contracts.mjs";
import { parseScannerConfig } from "./config.mjs";
import { columns, lastValue, lookbackOf, matchesLast, parseExpression } from "./expr.mjs";
import { createUniverses } from "./universes.mjs";
import { FACT_IDS } from "../dashboard/scan-builder.js";
import { LIBRARY_BY_ID } from "../dashboard/scan-library.js";
import { runAsConsumer } from "../ratelimit/consumer.mjs";
import { buildFacts, dailyFacts, istDay, liveBars } from "./facts.mjs";
import { createDemoFacts } from "./demoFacts.mjs";
import { createLiveFacts, needsOf } from "./liveFacts.mjs";
import { createPrewarm } from "./prewarm.mjs";
import { FNO_STOCKS } from "./sectors.mjs";
import { defaultSessionFor } from "../reference/defaults.mjs";

/** The consumer name live scans run as (API › Rate limits › Top consumers). */
export const SCANNER_CONSUMER = "Scanner";
/** Facts every live result row carries (the table's columns and the side sheet). */
export const ROW_FACTS = Object.freeze(["ltp", "change_pct", "gap_pct", "day_high", "day_low", "volume", "vol_pace", "prev_close", "prev_high", "prev_low", "high_52w", "low_52w", "upper_circuit", "lower_circuit", "range_pct", "nr7", "inside_day", "hv20", "fut_ltp", "fut_change_pct", "fut_oi", "fut_oi_change_pct", "basis", "basis_pct", "basis_ann_pct", "rollover_pct", "fut_expiry", "mwpl_pct", "in_ban", "pcr", "atm_iv", "iv_rank", "iv_percentile", "iv_days", "iv_hv_gap", "put_skew", "call_skew", "max_pain", "max_pain_dist_pct", "straddle", "straddle_pct", "expected_move_pct", "straddle_vs_move", "call_wall", "put_wall", "top_oi_chg_pct", "top_oi_chg_strike", "top_oi_chg_right", "max_vol_oi", "max_vol_oi_strike", "max_vol_oi_right", "dte", "atm_strike", "chain_expiry", "lot", "sector", "fno", "indices"]);
const pickFacts = (f) => Object.fromEntries(ROW_FACTS.map((k) => [k, f[k] ?? null]));
const LIVE_FIELDS = Object.freeze([...FACT_IDS]);
const parseLive = (src) => parseExpression(src, { fields: LIVE_FIELDS });

export const SCAN_SOURCES = Object.freeze(["auto", "broker", "backup"]);
const DEFAULT_COLUMNS = Object.freeze(["close", "change_pct", "volume"]);
const MIN_BARS = 30;

export const scanRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    universe: z.string().min(2).max(32).optional(),
    symbols: z.array(z.string().min(1).max(64)).min(1).max(5000).optional(),
    /** "live": daily bars with today's bar live at the end, plus the facts (F&O, option chain, IV, MWPL). */
    interval: z.enum([...INTERVALS, "live"]).default("1d"),
    /** Bars to load per symbol; default: enough for the condition's longest look-back. */
    lookback: z.number().int().min(2).max(5000).optional(),
    condition: z.string().min(1).max(1000),
    /** Extra values to report for each match, as expressions: ["rsi(14)", "close / sma(200) - 1"]. */
    columns: z.array(z.string().min(1).max(200)).max(12).optional(),
    sort: z.object({ by: z.string().min(1).max(200), order: z.enum(["asc", "desc"]).default("desc") }).strict().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    source: z.enum(SCAN_SOURCES).default("auto"),
  })
  .strict()
  .refine((r) => Boolean(r.universe) !== Boolean(r.symbols), { message: "Give either universe or symbols, not both.", path: ["universe"] });

const savedFields = {
  name: z.string().trim().min(1).max(80),
  request: z.unknown(),
  /** Run by itself every N minutes (market hours only unless marketHoursOnly is false). */
  everyMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  marketHoursOnly: z.boolean().default(true),
  /** Run once after the close (15:31 IST) on each trading day. */
  atClose: z.boolean().default(false),
  /** Send scan.alert to the notification targets (notify module). Default true, as before. */
  notify: z.boolean().default(true),
  /** The builder model the scan was made with (dashboard/scan-builder.js), kept so it reopens in the builder. */
  builder: z.record(z.string(), z.unknown()).nullable().optional(),
  /** The library scan it started from. */
  libraryId: z.string().max(60).nullable().optional(),
  /** Result columns shown on the dashboard. */
  columns: z.array(z.string().min(1).max(40)).max(20).optional(),
};
const savedSchema = z.object(savedFields).strict();
const savedPatchSchema = z
  .object(Object.fromEntries(Object.entries(savedFields).map(([k, v]) => [k, k === "marketHoursOnly" || k === "atClose" || k === "notify" ? z.boolean().optional() : v.optional()])))
  .strict();
/** A hit row in Live events per new symbol, at most this many per run. */
const MAX_EVENT_HITS = 20;
/** The close run waits this long after the session close (reference sessions, else the shipped defaults). */
const CLOSE_RUN_AFTER_MIN = 1;

const newId = (p) => `${p}_${randomBytes(8).toString("hex")}`;

/**
 * @param {{ config: object, marketData: object, accounts: object, scheduler: object, backupData?: object, symbols?: object,
 *   bus?: object, clock: { now(): number }, paths: { dataDir: string }, logger?: object }} deps
 */
export function createScanner(deps) {
  const cfg = parseScannerConfig(deps.config?.scanner);
  const log = deps.logger?.child ? deps.logger.child({ module: "scanner" }) : deps.logger;
  const now = () => deps.clock.now();
  const universes = createUniverses({ symbols: deps.symbols, custom: cfg.universes });
  const savedPath = deps.paths?.dataDir ? join(deps.paths.dataDir, "scanner", "saved.json") : null;
  const demo = deps.config?.demo === true;
  const demoFacts = demo ? createDemoFacts({ now }) : null;
  const liveFacts = demo
    ? null
    : createLiveFacts({ marketData: deps.marketData, accounts: deps.accounts, scheduler: deps.scheduler, symbols: deps.symbols, recorder: deps.recorder, reference: deps.reference, fno: deps.fno, bus: deps.bus, clock: deps.clock, dataDir: deps.paths?.dataDir ?? null, share: cfg.budgetShare, logger: log });
  // Daily bars for NIFTY50 and FNO filled before the first scan (prewarm.mjs): at start and after each close.
  const prewarm = liveFacts ? createPrewarm({ liveFacts, universes, scheduler: deps.scheduler, clock: deps.clock, logger: log }) : null;
  /** Live collects run one at a time, so the broker calls credited to "Scanner" during one belong to it. */
  let collectChain = Promise.resolve();
  /** symbol -> the newest raw parts a live run collected (the live count re-reads these: no broker call). */
  const lastRaw = new Map();
  /** request signature -> symbols matched last time (ad-hoc "new since last run"). */
  const lastBySig = new Map();

  /** jobId -> job (newest last) */
  const jobs = new Map();
  const queue = [];
  let running = 0;
  let timer = null;

  // ── saved scans ──

  function loadSaved() {
    if (!savedPath || !existsSync(savedPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(savedPath, "utf8"));
      return Array.isArray(raw?.scans) ? raw.scans : [];
    } catch (err) {
      log?.warn?.("could not read saved scans; starting with none", { err: err?.message });
      return [];
    }
  }
  let saved = loadSaved();

  // A revoked key's scans stop: running ones are cancelled and its scheduled scans no longer run.
  deps.bus?.on?.("key.revoked", ({ keyId } = {}) => {
    if (!keyId) return;
    for (const j of jobs.values()) if (j.keyId === keyId && (j.status === "queued" || j.status === "running")) api.cancel(j);
    let changed = false;
    for (const s of saved) {
      if (s.keyId === keyId && !s.disabledReason) {
        s.disabledReason = "key revoked";
        changed = true;
      }
    }
    if (changed) {
      try {
        persist();
      } catch (err) {
        log?.warn?.("could not save scan state", { err: err?.message });
      }
    }
  });
  const persist = () => {
    if (savedPath) writeFileAtomic(savedPath, `${JSON.stringify({ version: 1, scans: saved }, null, 2)}\n`);
  };

  // ── planning ──

  function backupOn() {
    try {
      return Boolean(deps.backupData?.status?.().enabled);
    } catch {
      return false;
    }
  }

  function historyRate(accountId) {
    try {
      const broker = deps.accounts.get(accountId).broker;
      const lim = deps.scheduler.policyFor(broker)?.limits?.history;
      const perSecond = Number(lim?.perSecond) || (Number(lim?.perMinute) ? lim.perMinute / 60 : 1);
      return { broker, perSecond };
    } catch {
      return { broker: null, perSecond: 1 };
    }
  }

  /**
   * Which accounts serve a scan and how wide each pool is.
   * @param {"auto"|"broker"|"backup"} source
   * @param {string[] | undefined} allowedAccounts
   */
  function plan(source, allowedAccounts, total, live = false) {
    if (live && demo) return { pools: [{ kind: "demo", accountId: null, broker: "demo", pinned: false, perSecond: 0, concurrency: 1 }], backupFallback: false, estimatedSeconds: 1 };
    const pools = [];
    if (source !== "backup") {
      const q = { capability: "historical" };
      if (allowedAccounts) q.allowedAccounts = allowedAccounts;
      let candidates = [];
      try {
        candidates = deps.accounts.marketDataCandidates(q) ?? [];
      } catch {
        candidates = [];
      }
      const pinned = candidates.length > 1;
      for (const id of candidates) {
        const { broker, perSecond } = historyRate(id);
        pools.push({ kind: "broker", accountId: id, broker, pinned, perSecond, concurrency: Math.max(1, Math.min(cfg.perAccountConcurrency, Math.ceil(perSecond))) });
      }
    }
    const backup = source === "backup" || (source === "auto" && backupOn());
    if (!pools.length && backup) pools.push({ kind: "backup", accountId: null, broker: null, pinned: false, perSecond: 2, concurrency: 2 });
    if (!pools.length) {
      throw new BridgeError(
        "BROKER_UNAVAILABLE",
        source === "broker"
          ? "No connected broker account can supply candles for a scan. Connect an account, or use source auto/backup."
          : 'No connected broker account can supply candles, and the backup sources are off. Connect an account, or set "backup": { "enabled": true }.',
      );
    }
    const rate = pools.reduce((s, p) => s + p.perSecond, 0);
    return { pools, backupFallback: backup, estimatedSeconds: Math.ceil(total / Math.max(rate, 0.1)) };
  }

  // ── compiling a request ──

  async function compile(input) {
    const parsed = scanRequestSchema.safeParse(input ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const r = parsed.data;
    const live = r.interval === "live";
    const parse = live ? parseLive : parseExpression;
    const condition = parse(r.condition);
    const cols = (r.columns ?? DEFAULT_COLUMNS).map((c) => ({ label: c, tree: parse(c) }));
    for (const d of DEFAULT_COLUMNS) if (!cols.some((c) => c.label === d)) cols.push({ label: d, tree: parse(d) });
    const sortTree = r.sort ? parse(r.sort.by) : null;
    // Demo live scans cover the demo F&O market (about 200 stocks), not the demo broker's short master.
    const list = r.universe ? (demo && live && r.universe.toUpperCase() === "FNO" ? FNO_STOCKS.map((t) => `NSE:${t}`) : await universes.resolve(r.universe)) : r.symbols;
    const seen = new Set();
    const symbols = [];
    const invalid = [];
    for (const s of list) {
      try {
        const c = parseSymbol(s).canonical;
        if (!seen.has(c)) {
          seen.add(c);
          symbols.push(c);
        }
      } catch {
        invalid.push({ symbol: String(s), code: "VALIDATION_FAILED", message: "Not a valid symbol." });
      }
    }
    if (symbols.length > cfg.maxSymbols) {
      throw new BridgeError("VALIDATION_FAILED", `A scan may cover at most ${cfg.maxSymbols} symbols (config scanner.maxSymbols); this one has ${symbols.length}.`, {
        errors: [{ path: "symbols", message: "too many" }],
      });
    }
    const need = Math.max(lookbackOf(condition), ...cols.map((c) => lookbackOf(c.tree)), sortTree ? lookbackOf(sortTree) : 0);
    const countback = Math.min(5000, r.lookback ?? Math.max(MIN_BARS, need + 5));
    const needs = live ? needsOf([condition, ...(sortTree ? [sortTree] : [])]) : null;
    if (live && need > 260) throw new BridgeError("VALIDATION_FAILED", "A live scan reads up to 260 daily bars; shorten the longest period.", { errors: [{ path: "condition", message: "lookback too long" }] });
    return { request: r, condition, cols, sortTree, symbols, invalid, countback, live, needs };
  }

  // ── running ──

  async function fetchCandles(job, pool, symbol, signal) {
    const { interval } = job.request;
    const countback = job.countback;
    const viaBackup = async () => {
      const toMs = now();
      const fromMs = countbackRange({ toMs, countback, interval, exchange: parseSymbol(symbol).exchange });
      const b = await deps.backupData.history({ symbol, interval, fromMs, toMs });
      return { candles: b.candles.slice(-countback), source: "backup", provider: b.provider, accountId: null };
    };
    if (pool.kind === "backup") return viaBackup();
    const opts = { priority: "background", signal };
    if (job.allowedAccounts) opts.allowedAccounts = job.allowedAccounts;
    if (pool.pinned) opts.accountId = pool.accountId;
    else if (job.request.source === "auto") opts.allowBackup = true;
    try {
      const h = await deps.marketData.history({ symbol, interval, countback }, opts);
      return { candles: h.candles, source: h.freshness?.source ?? "broker", provider: h.freshness?.provider ?? null, accountId: h.freshness?.accountId ?? null };
    } catch (err) {
      if (err?.name === "AbortError" || !pool.pinned || !job.plan.backupFallback) throw err;
      return viaBackup().catch(() => {
        throw err;
      });
    }
  }

  function evaluateSymbol(job, symbol, got) {
    const cols = columns(got.candles);
    if (cols.close.length < 2) throw new BridgeError("SYMBOL_NOT_FOUND", `Not enough candles for ${symbol}.`);
    if (!matchesLast(job.compiled.condition, cols)) return null;
    const values = {};
    for (const c of job.compiled.cols) values[c.label] = lastValue(c.tree, cols);
    const row = {
      symbol,
      values,
      barTime: cols.time[cols.time.length - 1],
      bars: cols.close.length,
      source: got.source,
      accountId: got.accountId,
    };
    if (got.provider) row.provider = got.provider;
    if (job.compiled.sortTree) row.sortValue = lastValue(job.compiled.sortTree, cols);
    return row;
  }

  function progressEvent(job, force = false) {
    const t = now();
    if (!force && t - job._lastEmit < 1000) return;
    job._lastEmit = t;
    deps.bus?.emit?.("scan.progress", { keyId: job.keyId, jobId: job.id, savedId: job.savedId ?? null, status: job.status, progress: { ...job.progress } });
  }

  /** Evaluate one symbol's live facts; returns the row or null (sets row.facts for every symbol it evaluated). */
  function evaluateLive(job, symbol, raw) {
    const facts = buildFacts({ ...raw, daily: raw.dailyFacts ?? (raw.daily ? dailyFacts(raw.daily) : null) }, now());
    if (facts.ltp === null) throw new BridgeError("SYMBOL_NOT_FOUND", `No live price for ${symbol}.`);
    let bars = raw.daily?.length ? raw.daily : [];
    if (!bars.length && facts.prev_close !== null) {
      const t = Math.floor(now() / 1000) - 86_400;
      bars = [{ time: t, open: facts.prev_close, high: facts.prev_close, low: facts.prev_close, close: facts.prev_close, volume: NaN }];
    }
    const cols = columns(liveBars(bars, raw.quote, now()));
    cols.extra = facts;
    const result = { facts };
    if (!matchesLast(job.compiled.condition, cols)) return result;
    const values = {};
    for (const c of job.compiled.cols) values[c.label] = lastValue(c.tree, cols);
    const row = { symbol, values, barTime: cols.time[cols.time.length - 1], bars: cols.close.length, source: raw.source ?? raw.quote?.freshness?.source ?? "live", accountId: raw.quote?.freshness?.accountId ?? null, facts: pickFacts(facts) };
    if (job.compiled.sortTree) row.sortValue = lastValue(job.compiled.sortTree, cols);
    result.row = row;
    return result;
  }

  /** Run fn as the Scanner consumer, one collect at a time; returns { value, brokerCalls }. */
  function serialised(fn) {
    const run = collectChain.then(() =>
      runAsConsumer(SCANNER_CONSUMER, async () => {
        const before = deps.scheduler?.consumerCalls?.(SCANNER_CONSUMER)?.calls ?? 0;
        const value = await fn();
        const after = deps.scheduler?.consumerCalls?.(SCANNER_CONSUMER)?.calls ?? before;
        return { value, brokerCalls: Math.max(0, after - before) };
      }),
    );
    collectChain = run.catch(() => {});
    return run;
  }

  async function collectRaw(symbols, needs, signal, cacheOnly = false) {
    if (demoFacts) return { value: { raw: demoFacts.raw(symbols), usage: { quotes: { demo: symbols.length }, dailyCached: symbols.length, dailyFetched: 0, gateWaits: 0, errors: [] } }, brokerCalls: 0 };
    return serialised(() => liveFacts.collect(symbols, { needs, signal, cacheOnly }));
  }

  async function runLive(job) {
    const t0 = now();
    const perf0 = performance.now();
    const signal = job.abort.signal;
    const symbols = job.compiled.symbols;
    const got = await collectRaw(symbols, job.compiled.needs, signal);
    if (signal.aborted) return;
    const { raw, usage } = got.value;
    const ivs = [];
    /** symbol -> the read that failed for it (quote, daily ...): said instead of a bare "no price". */
    const why = new Map();
    for (const e of usage.errors) if (!why.has(e.symbol)) why.set(e.symbol, e);
    for (const symbol of symbols) {
      const r = raw.get(symbol);
      try {
        if (!r) throw new BridgeError("SYMBOL_NOT_FOUND", `No data for ${symbol}.`);
        const failed = why.get(symbol);
        if (!r.quote && failed) throw new BridgeError(failed.code ?? "INTERNAL", `${failed.part}: ${failed.message}`);
        const prev = lastRaw.get(symbol);
        lastRaw.set(symbol, prev ? { ...prev, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined)) } : r);
        const out = evaluateLive(job, symbol, r);
        if (out.facts.atm_iv !== null && !demo) ivs.push([symbol.split(":").pop(), out.facts.atm_iv]);
        if (out.row) {
          job.results.push(out.row);
          job.progress.matched += 1;
        }
        const used = demo ? "demo" : (r.quote?.freshness?.accountId ?? r.quote?.freshness?.source ?? "unknown");
        job.usage[used] = (job.usage[used] ?? 0) + 1;
      } catch (err) {
        job.progress.errors += 1;
        if (job.errors.length < 500) job.errors.push({ symbol, code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? err.detail : "Internal error." });
      }
      job.progress.done += 1;
    }
    for (const e of usage.errors.slice(0, 50)) if (!job.errors.some((x) => x.symbol === e.symbol) && job.errors.length < 500) job.errors.push({ symbol: e.symbol, code: e.code, message: `${e.part}: ${e.message}` });
    if (ivs.length) liveFacts?.noteIvs(ivs);
    job.stats = {
      symbols: symbols.length,
      brokerCalls: got.brokerCalls,
      ms: Math.round(performance.now() - perf0),
      quotes: usage.quotes,
      dailyFetched: usage.dailyFetched,
      dailyCached: usage.dailyCached,
      gateWaits: usage.gateWaits,
      demo,
      at: new Date(t0).toISOString(),
    };
  }

  async function runJob(job) {
    job.status = "running";
    job.startedAt = new Date(now()).toISOString();
    progressEvent(job, true);
    if (job.compiled.live) {
      try {
        await runLive(job);
        job.status = job.abort.signal.aborted ? "cancelled" : "completed";
      } catch (err) {
        if (job.abort.signal.aborted || err?.name === "AbortError") job.status = "cancelled";
        else {
          job.status = "failed";
          job.error = { code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? err.detail : "Internal error." };
          log?.warn?.("live scan failed", { err: err?.message });
        }
      }
      return finish(job);
    }
    const pending = [...job.compiled.symbols];
    const signal = job.abort.signal;
    const worker = async (pool) => {
      while (pending.length && !signal.aborted) {
        const symbol = pending.shift();
        try {
          const got = await fetchCandles(job, pool, symbol, signal);
          const row = evaluateSymbol(job, symbol, got);
          if (row) {
            job.results.push(row);
            job.progress.matched += 1;
          }
          const used = got.accountId ?? (got.source === "backup" ? `backup:${got.provider ?? "?"}` : "unknown");
          job.usage[used] = (job.usage[used] ?? 0) + 1;
        } catch (err) {
          if (err?.name === "AbortError" || signal.aborted) break;
          job.progress.errors += 1;
          if (job.errors.length < 500) job.errors.push({ symbol, code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? err.detail : "Internal error." });
        }
        job.progress.done += 1;
        progressEvent(job);
      }
    };
    try {
      await Promise.all(job.plan.pools.flatMap((pool) => Array.from({ length: pool.concurrency }, () => worker(pool))));
      if (signal.aborted) job.status = "cancelled";
      else job.status = "completed";
    } catch (err) {
      job.status = "failed";
      job.error = { code: err instanceof BridgeError ? err.code : "INTERNAL", message: err instanceof BridgeError ? err.detail : "Internal error." };
    }
    finish(job);
  }

  function finish(job) {
    job.finishedAt = new Date(now()).toISOString();
    const { sort, limit } = job.request;
    if (sort) {
      const dir = sort.order === "asc" ? 1 : -1;
      job.results.sort((a, b) => {
        const av = a.sortValue ?? null;
        const bv = b.sortValue ?? null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * dir;
      });
    } else job.results.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
    // Every match, before `limit` trims the list: saved-scan alerts compare these, so a symbol moving in and out of
    // the top N is not reported as new.
    job.allMatched = job.results.map((r) => r.symbol);
    if (!job.savedId && job.status === "completed") markNew(job, lastBySig.get(job.signature) ?? null);
    if (!job.savedId && job.status === "completed") {
      lastBySig.delete(job.signature);
      lastBySig.set(job.signature, job.allMatched);
      while (lastBySig.size > 50) lastBySig.delete(lastBySig.keys().next().value);
    }
    if (limit && job.results.length > limit) job.results = job.results.slice(0, limit);
    progressEvent(job, true);
    deps.bus?.emit?.("scan.completed", { keyId: job.keyId, jobId: job.id, savedId: job.savedId ?? null, status: job.status, matched: job.results.map((r) => r.symbol), progress: { ...job.progress } });
    if (job.savedId) afterSavedRun(job);
    running -= 1;
    trim();
    pump();
  }

  /** Mark rows matched now but not in the previous run (no previous run: nothing is new). */
  function markNew(job, previous) {
    job.firstRun = !previous;
    const before = new Set(previous ?? []);
    for (const r of job.results) r.isNew = Boolean(previous) && !before.has(r.symbol);
  }

  function afterSavedRun(job) {
    const s = saved.find((x) => x.id === job.savedId);
    if (!s || job.status !== "completed") return;
    const matched = job.allMatched ?? job.results.map((r) => r.symbol);
    const before = new Set(s.lastRun?.matched ?? []);
    const newMatches = s.lastRun ? matched.filter((m) => !before.has(m)) : [];
    markNew(job, s.lastRun?.matched ?? null);
    s.lastRun = { jobId: job.id, at: job.finishedAt, matched, newMatches, stats: job.stats ?? null };
    try {
      persist();
    } catch (err) {
      log?.warn?.("could not save scan results", { err: err?.message });
    }
    job.newMatches = newMatches;
    if (newMatches.length) {
      deps.bus?.emit?.("scan.alert", { keyId: s.keyId ?? null, savedId: s.id, name: s.name, jobId: job.id, newMatches, at: job.finishedAt, notify: s.notify !== false });
      // Each new symbol is a "Scan hit" row in Live events (the scan's name is the label).
      const ev = deps.events?.() ?? null;
      if (ev && typeof ev.scanHit === "function") {
        const byId = new Map(job.results.map((r) => [r.symbol, r]));
        for (const sym of newMatches.slice(0, MAX_EVENT_HITS)) {
          const row = byId.get(sym);
          try {
            ev.scanHit({ symbol: sym, name: s.name, savedId: s.id, side: LIBRARY_BY_ID.get(s.libraryId)?.side ?? null, ltp: row?.facts?.ltp ?? row?.values?.close ?? null, changePct: row?.facts?.change_pct ?? row?.values?.change_pct ?? null });
          } catch (err) {
            log?.debug?.("scan hit not recorded in live events", { err: err?.message });
          }
        }
      }
    }
  }

  function trim() {
    const done = [...jobs.values()].filter((j) => !["queued", "running"].includes(j.status));
    for (let i = 0; i < done.length - cfg.keepJobs; i += 1) jobs.delete(done[i].id);
  }

  function pump() {
    while (running < cfg.maxRunning && queue.length) {
      const job = queue.shift();
      if (job.status !== "queued") continue;
      running += 1;
      runJob(job).catch((err) => {
        log?.error?.("scan crashed", { jobId: job.id, err });
      });
    }
  }

  /** Public view of a job (no internals). */
  function view(job, { results = true } = {}) {
    const out = {
      id: job.id,
      name: job.name,
      savedId: job.savedId ?? null,
      status: job.status,
      request: job.request,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: { ...job.progress },
      plan: {
        estimatedSeconds: job.plan.estimatedSeconds,
        backupFallback: job.plan.backupFallback,
        pools: job.plan.pools.map(({ kind, accountId, broker, perSecond, concurrency }) => ({ kind, accountId, broker, perSecond, concurrency })),
      },
      usage: { ...job.usage },
      lookbackBars: job.countback,
    };
    if (job.error) out.error = job.error;
    if (job.newMatches) out.newMatches = job.newMatches;
    if (job.stats) out.stats = { ...job.stats };
    if (job.firstRun !== undefined) out.firstRun = job.firstRun;
    if (results) {
      out.results = job.results;
      out.errors = job.errors;
    }
    return out;
  }

  /**
   * @param {object} input scan request
   * @param {{ allowedAccounts?: string[], keyId?: string | null, savedId?: string }} who
   */
  async function start(input, who = {}) {
    const compiled = await compile(input);
    const p = plan(compiled.request.source, who.allowedAccounts, compiled.symbols.length, compiled.live);
    const job = {
      id: newId("scan"),
      signature: JSON.stringify([compiled.request.universe ?? compiled.symbols.slice(0, 50), compiled.request.interval, compiled.request.condition]),
      name: compiled.request.name ?? null,
      savedId: who.savedId,
      keyId: who.keyId ?? null,
      status: "queued",
      request: compiled.request,
      compiled,
      countback: compiled.countback,
      plan: p,
      allowedAccounts: who.allowedAccounts,
      createdAt: new Date(now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: { total: compiled.symbols.length + compiled.invalid.length, done: compiled.invalid.length, matched: 0, errors: compiled.invalid.length },
      results: [],
      errors: [...compiled.invalid],
      usage: {},
      abort: new AbortController(),
      _lastEmit: 0,
    };
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return job;
  }

  /** Wait for a job to finish (or `timeoutMs`). */
  function waitFor(job, timeoutMs) {
    if (!["queued", "running"].includes(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const off = deps.bus?.on?.("scan.completed", (e) => {
        if (e.jobId === job.id) {
          off?.();
          clearTimeout(t);
          resolve(job);
        }
      });
      const t = setTimeout(() => {
        off?.();
        resolve(job);
      }, timeoutMs);
    });
  }

  // ── scheduling saved scans ──

  /** NSE session state from deps.reference (holidays included), or null when no reference service is running. */
  function referenceSessionState(t) {
    const ref = deps.reference;
    if (!ref || isStub(ref) || typeof ref.session !== "function") return null;
    try {
      return ref.session("NSE", t).state;
    } catch {
      return null;
    }
  }

  /** A trading day per the reference calendar, else Monday to Friday. */
  function tradingDay(t) {
    const ref = deps.reference;
    if (ref && !isStub(ref) && typeof ref.session === "function") {
      try {
        const td = ref.session("NSE", t)?.tradingDay;
        if (typeof td === "boolean") return td;
      } catch {
        // fall through
      }
    }
    const dow = new Date(t + 19_800_000).getUTCDay();
    return dow !== 0 && dow !== 6;
  }

  /** The NSE session's close in IST minutes of the day: the reference session, else the shipped default. */
  function closeMinute(t) {
    let close = null;
    const ref = deps.reference;
    if (ref && !isStub(ref) && typeof ref.session === "function") {
      try {
        close = ref.session("NSE", t)?.close ?? null;
      } catch {
        close = null;
      }
    }
    const m = /^(\d{2}):(\d{2})$/.exec(String(close ?? defaultSessionFor("NSE")?.close ?? ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : 24 * 60;
  }

  /** The once-after-the-close run: a minute after the close or later on a trading day, not yet run today. */
  function dueAtClose(s, t) {
    if (!s.atClose || s.disabledReason) return false;
    const d = new Date(t + 19_800_000);
    const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (minute < closeMinute(t) + CLOSE_RUN_AFTER_MIN || !tradingDay(t)) return false;
    const lastClose = s.lastCloseRunAt ? istDay(Date.parse(s.lastCloseRunAt)) : null;
    return lastClose !== istDay(t);
  }

  function due(s, t) {
    if (dueAtClose(s, t)) return true;
    if (!s.everyMinutes || s.disabledReason) return false;
    if (s.marketHoursOnly !== false) {
      // Holiday-aware when the reference calendar (stream S16) is running; lib/marketHours otherwise.
      const st = referenceSessionState(t) ?? marketSession(new Date(t)).state;
      if (st !== "OPEN" && st !== "SPECIAL") return false;
    }
    const last = s.lastStartedAt ? Date.parse(s.lastStartedAt) : 0;
    return t - last >= s.everyMinutes * 60_000;
  }

  async function tick() {
    const t = now();
    for (const s of saved) {
      if (!due(s, t)) continue;
      const busy = [...jobs.values()].some((j) => j.savedId === s.id && ["queued", "running"].includes(j.status));
      if (busy) continue;
      if (dueAtClose(s, t)) s.lastCloseRunAt = new Date(t).toISOString();
      s.lastStartedAt = new Date(t).toISOString();
      try {
        await start(s.request, { savedId: s.id, allowedAccounts: s.allowedAccounts, keyId: s.keyId });
      } catch (err) {
        s.lastError = { code: err?.code ?? "INTERNAL", message: err?.detail ?? "Internal error.", at: new Date(t).toISOString() };
      }
    }
  }

  const api = {
    start,
    waitFor,
    view,
    /** @returns {object | null} */
    get: (id) => jobs.get(id) ?? null,
    list: () => [...jobs.values()].reverse(),
    cancel(job) {
      if (job.status === "queued") {
        job.status = "cancelled";
        job.finishedAt = new Date(now()).toISOString();
        deps.bus?.emit?.("scan.completed", { keyId: job.keyId, jobId: job.id, savedId: job.savedId ?? null, status: job.status, matched: [], progress: { ...job.progress } });
        return job;
      }
      if (job.status === "running") job.abort.abort();
      return job;
    },
    /** Dry run: which accounts would serve it and roughly how long it would take. */
    async plan(input, who = {}) {
      const compiled = await compile(input);
      const p = plan(compiled.request.source, who.allowedAccounts, compiled.symbols.length);
      return {
        symbols: compiled.symbols.length,
        invalid: compiled.invalid,
        lookbackBars: compiled.countback,
        estimatedSeconds: p.estimatedSeconds,
        backupFallback: p.backupFallback,
        pools: p.pools.map(({ kind, accountId, broker, perSecond, concurrency }) => ({ kind, accountId, broker, perSecond, concurrency })),
      };
    },
    /**
     * Live count while a scan is edited: the condition over the facts the last live run collected (no broker call;
     * demo mode recomputes its market). { matched, evaluated, total, sample, missing, ms }.
     */
    async count(input) {
      const compiled = await compile(input);
      if (!compiled.live) throw new BridgeError("VALIDATION_FAILED", 'Live counts work on live scans (interval "live").', { errors: [{ path: "interval", message: "not live" }] });
      const perf0 = performance.now();
      const job = { compiled };
      const raw = demoFacts ? demoFacts.raw(compiled.symbols) : lastRaw;
      let matched = 0;
      let evaluated = 0;
      const sample = [];
      for (const symbol of compiled.symbols) {
        const r = raw.get(symbol);
        if (!r) continue;
        try {
          const out = evaluateLive(job, symbol, r);
          evaluated += 1;
          if (out.row) {
            matched += 1;
            if (sample.length < 8) sample.push(symbol);
          }
        } catch {
          // a symbol without a price is not counted
        }
      }
      const parts = [...compiled.needs];
      const missing = demoFacts ? [] : parts.filter((part) => ![...lastRaw.values()].some((r) => (part === "daily" ? r.daily?.length : part === "futures" || part === "futuresPrevOi" ? r.fut : part === "chain" ? r.chain : part === "mwpl" ? r.mwpl : part === "ivHistory" ? r.ivHistory?.length : true)));
      return { matched, evaluated, total: compiled.symbols.length, sample, missing, ms: Math.round(performance.now() - perf0) };
    },
    /** The condition parts a live scan reads (for docs and the plan). */
    needs: async (input) => [...((await compile(input)).needs ?? [])],
    universes: () => universes.list(),
    async universe(name) {
      return universes.resolve(name);
    },

    saved: () => saved.map((s) => ({ ...s })),
    async save(input, who = {}) {
      const parsed = savedSchema.safeParse(input ?? {});
      if (!parsed.success) throw fromValidation(parsed.error);
      await compile(parsed.data.request); // validate now, not at 09:15 tomorrow
      const s = {
        id: newId("saved"),
        name: parsed.data.name,
        request: parsed.data.request,
        everyMinutes: parsed.data.everyMinutes ?? null,
        marketHoursOnly: parsed.data.marketHoursOnly,
        atClose: parsed.data.atClose,
        notify: parsed.data.notify,
        builder: parsed.data.builder ?? null,
        libraryId: parsed.data.libraryId ?? null,
        columns: parsed.data.columns ?? null,
        allowedAccounts: who.allowedAccounts,
        keyId: who.keyId ?? null,
        createdAt: new Date(now()).toISOString(),
        lastStartedAt: null,
        lastRun: null,
      };
      if (saved.length >= 100) throw new BridgeError("VALIDATION_FAILED", "At most 100 saved scans.");
      if (saved.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) throw new BridgeError("VALIDATION_FAILED", `A saved scan named "${s.name}" exists already.`, { errors: [{ path: "name", message: "duplicate" }] });
      saved.push(s);
      persist();
      return { ...s };
    },
    /** Change a saved scan: name, request, schedule, notify, builder, columns. A new request is validated first. */
    async updateSaved(id, input) {
      const s = saved.find((x) => x.id === id);
      if (!s) throw new BridgeError("NOT_FOUND", `No saved scan ${id}.`);
      const parsed = savedPatchSchema.safeParse(input ?? {});
      if (!parsed.success) throw fromValidation(parsed.error);
      const p = parsed.data;
      if (p.request !== undefined) {
        await compile(p.request);
        // A changed condition starts a fresh "new since last run" baseline.
        if (JSON.stringify(p.request) !== JSON.stringify(s.request)) s.lastRun = null;
      }
      if (p.name !== undefined && saved.some((x) => x.id !== id && x.name.toLowerCase() === p.name.toLowerCase())) throw new BridgeError("VALIDATION_FAILED", `A saved scan named "${p.name}" exists already.`, { errors: [{ path: "name", message: "duplicate" }] });
      for (const [k, v] of Object.entries(p)) if (v !== undefined) s[k] = v;
      s.updatedAt = new Date(now()).toISOString();
      persist();
      return { ...s };
    },
    /** A copy named "<name> (copy)" without its run history. */
    duplicateSaved(id, who = {}) {
      const s = saved.find((x) => x.id === id);
      if (!s) throw new BridgeError("NOT_FOUND", `No saved scan ${id}.`);
      if (saved.length >= 100) throw new BridgeError("VALIDATION_FAILED", "At most 100 saved scans.");
      let name = `${s.name} (copy)`.slice(0, 80);
      for (let i = 2; saved.some((x) => x.name === name); i += 1) name = `${s.name} (copy ${i})`.slice(0, 80);
      const copy = { ...structuredClone(s), id: newId("saved"), name, keyId: who.keyId ?? s.keyId ?? null, allowedAccounts: who.allowedAccounts ?? s.allowedAccounts, createdAt: new Date(now()).toISOString(), lastStartedAt: null, lastCloseRunAt: null, lastRun: null, disabledReason: undefined };
      saved.push(copy);
      persist();
      return { ...copy };
    },
    removeSaved(id) {
      const i = saved.findIndex((s) => s.id === id);
      if (i < 0) throw new BridgeError("NOT_FOUND", `No saved scan ${id}.`);
      const [s] = saved.splice(i, 1);
      persist();
      return s;
    },
    async runSaved(id, who = {}) {
      const s = saved.find((x) => x.id === id);
      if (!s) throw new BridgeError("NOT_FOUND", `No saved scan ${id}.`);
      s.lastStartedAt = new Date(now()).toISOString();
      return start(s.request, { ...who, savedId: s.id });
    },

    tick,
    /** Live facts cache state (status page, tests). */
    factsStatus: () => (liveFacts ? { ...liveFacts.status(), prewarm: prewarm?.status() ?? null } : { demo: true }),
    /** Start the daily-bar pre-warm (module start; not in demo mode). */
    startPrewarm() {
      prewarm?.start();
    },
    startSchedule() {
      if (!cfg.schedule || timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log?.warn?.("scan schedule tick failed", { err: err?.message }));
      }, 30_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      prewarm?.stop();
      for (const j of jobs.values()) if (j.status === "running") j.abort.abort();
    },
  };
  return api;
}
