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
 * Saved scans (dataDir/scanner/saved.json) can run every N minutes during market hours; when a run finds symbols the
 * previous run did not, the bus gets "scan.alert" (WebSocket clients with subscribe_scans receive it).
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

export const SCAN_SOURCES = Object.freeze(["auto", "broker", "backup"]);
const DEFAULT_COLUMNS = Object.freeze(["close", "change_pct", "volume"]);
const MIN_BARS = 30;

export const scanRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    universe: z.string().min(2).max(32).optional(),
    symbols: z.array(z.string().min(1).max(64)).min(1).max(5000).optional(),
    interval: z.enum(INTERVALS).default("1d"),
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

const savedSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    request: z.unknown(),
    /** Run by itself every N minutes (market hours only unless marketHoursOnly is false). */
    everyMinutes: z.number().int().min(1).max(1440).optional(),
    marketHoursOnly: z.boolean().default(true),
  })
  .strict();

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
  function plan(source, allowedAccounts, total) {
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
    const condition = parseExpression(r.condition);
    const cols = (r.columns ?? DEFAULT_COLUMNS).map((c) => ({ label: c, tree: parseExpression(c) }));
    for (const d of DEFAULT_COLUMNS) if (!cols.some((c) => c.label === d)) cols.push({ label: d, tree: parseExpression(d) });
    const sortTree = r.sort ? parseExpression(r.sort.by) : null;
    const list = r.universe ? await universes.resolve(r.universe) : r.symbols;
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
    return { request: r, condition, cols, sortTree, symbols, invalid, countback };
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

  async function runJob(job) {
    job.status = "running";
    job.startedAt = new Date(now()).toISOString();
    progressEvent(job, true);
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
    if (limit && job.results.length > limit) job.results = job.results.slice(0, limit);
    progressEvent(job, true);
    deps.bus?.emit?.("scan.completed", { keyId: job.keyId, jobId: job.id, savedId: job.savedId ?? null, status: job.status, matched: job.results.map((r) => r.symbol), progress: { ...job.progress } });
    if (job.savedId) afterSavedRun(job);
    running -= 1;
    trim();
    pump();
  }

  function afterSavedRun(job) {
    const s = saved.find((x) => x.id === job.savedId);
    if (!s || job.status !== "completed") return;
    const matched = job.allMatched ?? job.results.map((r) => r.symbol);
    const before = new Set(s.lastRun?.matched ?? []);
    const newMatches = s.lastRun ? matched.filter((m) => !before.has(m)) : [];
    s.lastRun = { jobId: job.id, at: job.finishedAt, matched, newMatches };
    try {
      persist();
    } catch (err) {
      log?.warn?.("could not save scan results", { err: err?.message });
    }
    job.newMatches = newMatches;
    if (newMatches.length) deps.bus?.emit?.("scan.alert", { keyId: s.keyId ?? null, savedId: s.id, name: s.name, jobId: job.id, newMatches, at: job.finishedAt });
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
    const p = plan(compiled.request.source, who.allowedAccounts, compiled.symbols.length);
    const job = {
      id: newId("scan"),
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

  function due(s, t) {
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
        allowedAccounts: who.allowedAccounts,
        keyId: who.keyId ?? null,
        createdAt: new Date(now()).toISOString(),
        lastStartedAt: null,
        lastRun: null,
      };
      if (saved.length >= 100) throw new BridgeError("VALIDATION_FAILED", "At most 100 saved scans.");
      saved.push(s);
      persist();
      return { ...s };
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
      for (const j of jobs.values()) if (j.status === "running") j.abort.abort();
    },
  };
  return api;
}
