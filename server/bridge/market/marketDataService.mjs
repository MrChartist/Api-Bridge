/**
 * MarketDataService. Contract: SERVICE_CONTRACTS.marketData in ../core/contracts.mjs.
 *
 * Read path for LTP and quotes (docs/ARCHITECTURE.md §4 and §6):
 *
 *   1. Stream: a live StreamHub subscription for the symbol answers at once (source "stream", zero REST calls).
 *   2. Freshness cache: a value no older than the caller's maxAgeMs (or the endpoint default) answers (source "cache").
 *   3. Broker: the rest go to ONE account (pinned with opts.accountId, else chosen by scheduler.pickAccount among
 *      accounts.marketDataCandidates), are merged with other requests that arrive within the batch window
 *      (market.batch.windowMs, default 25 ms), split into chunks of the broker's maxQuoteBatch and sent through
 *      scheduler.schedule({ endpointClass: "quote" }) with a coalesceKey. A symbol already being fetched for the same
 *      account joins that call instead of starting another (source "broker").
 *
 * Budget pressure: when the account has no budget left (scheduler.headroom) or the scheduler refuses or times out a
 * call, a cached value up to market.stale.maxStaleMs old is served labelled stale:true instead of queueing past the
 * caller's deadline. Depth is never served when older than 5 s. Reads with a stale fallback wait at most
 * market.stale.waitMs for budget.
 *
 * Routing (sources/router.mjs): an unpinned read asks the SourceRouter for up to two attempts. Pooled broker accounts are
 * scored on spare budget, error rate and latency; an account whose breaker is open is skipped. Failover to the next
 * account, or to a data source when the read allows backup (opts.allowBackup), is the retry: nothing is retried on the
 * same source. A data source's answer is labelled (source "backup", provider, class, delay, official, confidence), never
 * cached as broker data and never mixed into another source's item. opts.purpose (default "display") rules out sources:
 * order, risk, paper and alert reads accept only real-time data from a trusted source (never a delayed source, a stale
 * cached value or a stale-while-revalidate answer). Every real call's outcome goes to the health tracker, and a recent
 * failure is remembered (2 s for an upstream error, 10 min not-found, 60 min unsupported) so it is not repeated.
 *
 * Pinned reads (opts.accountId) never move to another account, and accept stream ticks and cached values only from
 * that account. Errors for single symbols go into `errors[]`; one bad symbol never fails the whole batch.
 *
 * Every broker call goes through deps.scheduler.schedule(); adapters are reached only inside the scheduled function.
 * Nothing here sees or logs a credential: creds() is read inside the scheduled function and handed straight to the
 * adapter. Cache keys are canonical symbols and arguments only.
 */
import { z } from "zod";
import { PRIORITIES, isStub } from "../core/contracts.mjs";
import { BridgeError, fromBrokerError, fromValidation } from "../core/errors.mjs";
import { EXCHANGES, parseSymbol } from "../core/symbolFormat.mjs";
import { currentConsumerInfo } from "../ratelimit/consumer.mjs";
import { recordSaving as recordSavingGlobal } from "../ratelimit/scheduler.mjs";
import { DEFAULT_RATE } from "../reference/defaults.mjs";
import { PURPOSES, classRank, dataQuality } from "../sources/contract.mjs";
import { createFacadeRegistry } from "../sources/facadeRegistry.mjs";
import { createFailureCache } from "../sources/failureCache.mjs";
import { createHealthTracker, outcomeKindOf } from "../sources/health.mjs";
import { createSourceRouter, historySupport } from "../sources/router.mjs";
import { createBatcher } from "./batcher.mjs";
import { markShared } from "./routeInfo.mjs";
import { IV_MODELS, applyB76, atmStrike, defaultOptionExchange, finishLeg, legSymbol, rowsFromBrokerChain, rowsFromQuotes, settlementOfKind, strikeStepOf, trimStrikes } from "./chain.mjs";
import { kindOf, pricingContext } from "../vol/context.mjs";
import { DEPTH_STALE_CAP_MS, parseMarketConfig } from "./config.mjs";
import { createFreshnessCache } from "./freshnessCache.mjs";
import { oiUnitFor } from "./oiUnits.mjs";
import { INTERVALS, INTRADAY_MINUTES, aggregate, countbackRange, planChunks, planInterval } from "./history.mjs";
import {
  depthFields,
  freshness,
  ltpOnlyFields,
  mergeCandles,
  normaliseCandles,
  quoteFields,
  stripGreeks,
  tickFields,
  tickHasQuote,
  toLtpItem,
  toQuoteItem,
} from "./normalise.mjs";
import { istDate, parseTimeInput } from "./time.mjs";

/** Most symbols one ltp()/quotes() call may ask for (OpenAPI Symbols parameter). */
export const MAX_SYMBOLS = 200;
/** Largest maxAgeMs a caller may give (OpenAPI MaxAge). */
export const MAX_AGE_LIMIT_MS = 3_600_000;
/** Option-chain exchanges a caller may name for expiries. */
export const EXPIRY_EXCHANGES = Object.freeze(["NFO", "BFO", "MCX", "CDS"]);
const UNDERLYING_RE = /^[A-Z0-9&-]{1,30}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Errors that mean "no budget or no answer right now", for which a labelled stale value is better than nothing. */
const PRESSURE_CODES = new Set(["UPSTREAM_RATE_LIMITED", "RATE_LIMITED", "UPSTREAM_TIMEOUT", "BROKER_UNAVAILABLE"]);
/** Failures of an unpinned read after which a backup source may answer instead (when the read allows it). */
const BACKUP_CODES = new Set([...PRESSURE_CODES, "UPSTREAM_ERROR", "SESSION_EXPIRED", "CAPABILITY_UNSUPPORTED", "SYMBOL_NOT_FOUND", "NOT_IMPLEMENTED"]);
/** Purposes that accept only trusted real-time data (see sources/contract.mjs). */
const STRICT_PURPOSES = new Set(["alert", "paper", "risk", "order"]);
/** broker capability name -> the read capability the router and the sources know */
const READ_CAPABILITY = { historical: "history" };
const MASTER_PAGE_LIMIT = 500;
const MASTER_MAX_PAGES = 20;
const BSE_INDICES = new Set(["SENSEX", "BANKEX", "SENSEX50"]);
/** spreadQuotes(): an account whose quote budget frees up later than this is left out of the split. */
const SPREAD_MAX_WAIT_MS = 1500;
/** A stream-first chain overlays ticks on a broker chain of the same day at most this old (it supplies previous OI). */
const STREAM_BASE_MAX_AGE_MS = 6 * 3_600_000;

const readOptionsSchema = z
  .object({
    accountId: z.string().min(1).max(64).nullable().optional(),
    maxAgeMs: z.number().int().min(0).max(MAX_AGE_LIMIT_MS).optional(),
    priority: z.enum(PRIORITIES).optional(),
    signal: z.any().optional(),
    exchange: z.string().nullable().optional(),
    /** Unpinned reads no broker can answer may fall back to BackupDataService (labelled source "backup"). */
    allowBackup: z.boolean().optional(),
    /**
     * What the read is for (default "display"). order, risk, paper and alert reads accept only real-time data from a
     * trusted source: never a delayed or end-of-day source, never a stale cached value, never stale-while-revalidate.
     */
    purpose: z.enum(PURPOSES).optional(),
    /** The caller's account restriction (a key's accounts list); "*" or absent = any. Unpinned reads stay inside it. */
    allowedAccounts: z.union([z.literal("*"), z.array(z.string().min(1).max(64))]).optional(),
    /** Broker option-chain calls only: the longest the call may wait for budget (background jobs such as the recorder). */
    maxWaitMs: z.number().int().min(0).max(60_000).optional(),
    /** Priority "background" only: the scheduler keeps every window at or above (1 − share) of its limit (≤ 0.5). */
    backgroundShare: z.number().min(0).max(0.8).optional(),
    /**
     * Stale-while-revalidate: when only an older cached value exists (within market.stale.maxStaleMs), answer with it
     * at once, labelled `stale: true` and `revalidating: true`, and refresh it in the background for the next read.
     */
    staleWhileRevalidate: z.boolean().optional(),
  })
  .passthrough();

const historySchema = z
  .object({
    symbol: z.string().min(1).max(64),
    interval: z.enum(INTERVALS),
    from: z.union([z.string().min(1).max(40), z.number()]).optional(),
    to: z.union([z.string().min(1).max(40), z.number()]).optional(),
    countback: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

const chainSchema = z
  .object({
    underlying: z.string().min(1).max(30),
    expiry: z.string().regex(ISO_DATE_RE, "expiry must be YYYY-MM-DD."),
    strikes: z.number().int().min(1).max(100).optional(),
    greeks: z.boolean().optional(),
    ivModel: z.enum(IV_MODELS).optional(),
  })
  .strict();

const usable = (svc) => Boolean(svc) && !isStub(svc);
const abortError = (signal) => signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");

/**
 * @param {object} deps  Core deps (config, logger, bus, clock, paths, brokers) plus accounts, scheduler, symbols, streamHub.
 * @returns {object} MarketDataService (contract methods plus non-contract diagnostics: stats, cache, close)
 */
export function createMarketDataService(deps) {
  const { config, clock } = deps;
  const log = deps.logger?.child ? deps.logger.child({ module: "market" }) : deps.logger;
  const cfg = parseMarketConfig(config?.market);
  const accounts = deps.accounts;
  const scheduler = deps.scheduler;
  const symbols = deps.symbols;
  const streamHub = deps.streamHub;
  /** Optional: absent in tests and tools that build the service by hand. */
  const backup = (() => {
    try {
      return deps.backupData;
    } catch {
      return undefined;
    }
  })();
  const now = () => clock.now();
  /** Optional services the sources module injects; absent in tests and tools that build the service by hand. */
  const optional = (name) => {
    try {
      return deps[name];
    } catch {
      return undefined;
    }
  };
  const random = typeof optional("random") === "function" ? optional("random") : Math.random;
  /** How each source (broker accounts and data sources) has been answering; shared with the router and /v1/sources. */
  const health = optional("sourceHealth") ?? createHealthTracker({ clock, random });
  // The sources service shows this tracker's state on GET /v1/sources. This service records the outcome of every call it
  // makes through the facade (viaSource), so the facade must not record them a second time.
  if (usable(backup) && typeof backup.attachHealth === "function") backup.attachHealth(health, { recordsCalls: false });
  const sourceRegistry = optional("sourceRegistry") ?? createFacadeRegistry({ backup, clock, usable });
  const router =
    optional("sourceRouter") ??
    createSourceRouter({
      registry: sourceRegistry,
      health,
      scheduler: deps.scheduler,
      accounts: deps.accounts,
      clock,
      logger: log,
    });
  /** Recent failures per (source, read, key): a failing call is not repeated for a moment (or for good, for not-found). */
  const failCache = createFailureCache({ clock, random });
  /** Optional: the reference rate. Absent in tests and tools that build the service by hand. */
  const reference = (() => {
    try {
      return deps.reference;
    } catch {
      return undefined;
    }
  })();
  if (cfg.chain.riskFreeRate !== undefined) {
    log?.warn?.("market.chain.riskFreeRate is deprecated: set the rate on the Market calendar page or in reference.rate. The configured value still overrides the reference rate.", { riskFreeRate: cfg.chain.riskFreeRate });
  }
  /** Rate for computed Greeks: the deprecated config override, else the reference rate, else the reference default. */
  const riskFreeRate = () => {
    if (cfg.chain.riskFreeRate !== undefined) return cfg.chain.riskFreeRate;
    if (usable(reference)) {
      try {
        const v = reference.rate()?.value;
        if (typeof v === "number" && Number.isFinite(v)) return v;
      } catch {
        // fall through to the default
      }
    }
    return DEFAULT_RATE;
  };
  /** Where the rate came from, for the b76 chain's `pricing.rate.quality`. */
  const rateQuality = () => {
    if (cfg.chain.riskFreeRate !== undefined) return "config";
    if (usable(reference)) {
      try {
        return reference.rate()?.quality ?? null;
      } catch {
        // fall through
      }
    }
    return "default";
  };
  /**
   * Reprice a finished chain with Black-76 on the parity forward and the vol-time clock (ivModel=b76-forward). The
   * clock context comes from config `vol.clock` plus the reference calendar, session and rate (vol/context.mjs).
   */
  function priceB76(chain) {
    const first = chain.rows.map((r) => r.ce ?? r.pe).find(Boolean);
    const exchange = /^(NFO|BFO):/.exec(first?.symbol ?? "")?.[1] ?? defaultOptionExchange(chain.underlying);
    const nowMs = now();
    const ctx = pricingContext({ config, reference: usable(reference) ? reference : undefined, exchange, kind: kindOf(chain.underlying), now: nowMs });
    return applyB76(chain, { ctx, nowMs, rate: riskFreeRate(), rateQuality: rateQuality() });
  }
  const setTimer = typeof clock.setTimeout === "function" ? (fn, ms) => clock.setTimeout(fn, ms) : undefined;
  const clearTimer = typeof clock.clearTimeout === "function" ? (h) => clock.clearTimeout(h) : undefined;
  const cache = createFreshnessCache({ maxEntries: cfg.cache.maxEntries, now });
  /** accountId|kind|symbol -> Promise<CacheEntry> for symbols being fetched right now */
  const inflight = new Map();
  /** Local counters for diagnostics and tests (the scheduler keeps the reported totals). */
  const stats = { stream: 0, cache: 0, stale: 0, coalesced: 0, batched: 0, brokerCalls: 0, backup: 0 };

  // ── small helpers ──

  function saving(kind, count = 1) {
    if (!(count > 0)) return;
    stats[kind] = (stats[kind] ?? 0) + count;
    try {
      if (typeof scheduler?.recordSaving === "function") scheduler.recordSaving(kind, count);
      else recordSavingGlobal(kind, count);
    } catch {
      // savings are diagnostics only
    }
  }

  function toBridge(err, brokerId) {
    if (err instanceof BridgeError) return err;
    if (err?.name === "AbortError") return err;
    return fromBrokerError(err, { brokerId });
  }

  function itemError(symbol, err) {
    if (err instanceof BridgeError) return { symbol, code: err.code, message: err.detail };
    log?.error("market data item failed", { symbol, err });
    return { symbol, code: "INTERNAL", message: "Internal error." };
  }

  const isPressure = (err) => err instanceof BridgeError && PRESSURE_CODES.has(err.code);
  /** A failure another source may still answer (the first attempt's error is the failover's reason). */
  const failoverable = (err) => err instanceof BridgeError && BACKUP_CODES.has(err.code);

  /**
   * The data source to try after `err` failed an unpinned read, or null: the read must allow backup sources (never for
   * order, risk, paper or alert reads), the error must be one a source can still answer, and a source must qualify.
   */
  function sourceAfter(capability, o, err, symbols) {
    if (!o.allowBackup || o.accountId) return null;
    if (err && !failoverable(err)) return null;
    return router.select({ capability, only: "sources", purpose: o.purpose, maxAgeMs: o.maxAgeMs, symbols, deadlineMs: o.maxWaitMs, allowSources: true })[0] ?? null;
  }

  /** Run `fn` unless this (source, read, key) failed a moment ago; remember a failure worth remembering. */
  async function guarded(sourceId, kind, key, fn) {
    const hit = failCache.get(sourceId, kind, key);
    if (hit) throw new BridgeError(hit.code, hit.message || "This source failed a moment ago.");
    try {
      return await fn();
    } catch (err) {
      failCache.note(sourceId, kind, key, err);
      throw err;
    }
  }

  /** callBroker() behind the failure cache, for the reads that are one call per key (depth, expiries, chain). */
  const guardedBroker = (kind, key) => (opts, fn) => guarded(opts.accountId, kind, key, () => callBroker(opts, fn));

  /** A quotes answer with no item: the error that says why (a hard one first), else null. Partial answers count as answered. */
  const unanswered = (res) => (res?.items?.length ? null : ((res?.errors ?? []).find((e) => outcomeKindOf(e) === "hard") ?? res?.errors?.[0] ?? null));

  /**
   * One call to a data source through the BackupDataService facade, with its health recorded. `failure(result)` names the
   * error behind a result that came back without throwing but did not answer (a quotes read reports its failures in
   * `errors`), so such a call counts as a failure and not as a success.
   */
  async function viaSource(cand, call, failure) {
    const startedAt = now();
    try {
      const res = await call();
      const bad = failure?.(res);
      if (bad) {
        const kind = outcomeKindOf(bad);
        if (kind) health.record(cand.id, { ok: false, ms: Math.max(0, now() - startedAt), kind, message: String(bad?.message ?? "").slice(0, 200) });
        else health.release?.(cand.id);
      } else health.record(cand.id, { ok: true, ms: Math.max(0, now() - startedAt) });
      return res;
    } catch (err) {
      const kind = outcomeKindOf(err);
      if (kind) health.record(cand.id, { ok: false, ms: Math.max(0, now() - startedAt), kind, message: String(err?.message ?? "").slice(0, 200) });
      else health.release?.(cand.id);
      throw err;
    }
  }

  /**
   * The descriptor to label an answer with: the one the router chose, unless the facade says another provider really
   * answered, in which case that provider's own descriptor. A provider the registry does not know gets the more
   * cautious of the chosen descriptor and a plain delayed, unofficial source.
   */
  function descriptorFor(cand, provider) {
    const chosen = cand.descriptor;
    if (!provider || provider === cand.id) return chosen;
    try {
      const row = sourceRegistry.get?.(provider);
      const known = row?.descriptor ?? row?.provider?.descriptor;
      if (known) return known;
    } catch {
      // unknown provider: label cautiously
    }
    return { ...chosen, id: provider, class: classRank(chosen.class) >= 1 ? chosen.class : "delayed", delaySec: chosen.class === "realtime" ? chosen.delaySec || 900 : chosen.delaySec, official: false };
  }

  const CONFIDENCE_BY_CLASS = { realtime: "high", delayed: "medium", eod: "medium" };
  /**
   * Freshness label for an answer from a data source: source "backup", the provider, and the class, delay, official
   * flag and confidence the descriptor states. `stale` for a delayed source means older than its own delay (plus a
   * little), or than the caller's maxAgeMs: being delayed is a different label from being stale.
   */
  function sourceFreshness(cand, { at, provider, targetMs, maxAgeMs }) {
    const d = descriptorFor(cand, provider);
    const delayMs = d.class === "eod" ? 36 * 3_600_000 : (Number.isFinite(d.delaySec) ? d.delaySec : 0) * 1000;
    const nowMs = now();
    const stale = Math.max(0, nowMs - at) > (maxAgeMs ?? delayMs + 120_000);
    const q = dataQuality({
      class: d.class,
      delaySec: d.class === "realtime" ? 0 : d.delaySec ?? null,
      official: d.official === true,
      confidence: d.official === true ? CONFIDENCE_BY_CLASS[d.class] ?? "low" : "low",
      flags: d.tier === "plugin" ? ["untrusted_source"] : [],
    });
    const f = freshness({ source: "backup", at, now: nowMs, targetMs, stale, provider: provider ?? cand.id, ...q });
    // Until freshness() itself carries the data-class fields they are added here: a source answer is never unlabelled.
    for (const k of Object.keys(q)) if (f[k] === undefined) f[k] = q[k];
    return f;
  }

  function readOpts(opts) {
    const parsed = readOptionsSchema.safeParse(opts ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const o = parsed.data;
    // Reads never run at order priority: orders must always stay ahead of market data.
    const priority = o.priority === "order" ? "live" : o.priority ?? "interactive";
    const allowedAccounts = Array.isArray(o.allowedAccounts) ? o.allowedAccounts : undefined;
    const purpose = o.purpose ?? "display";
    const strict = STRICT_PURPOSES.has(purpose);
    return {
      accountId: o.accountId ?? null,
      maxAgeMs: o.maxAgeMs,
      priority,
      signal: o.signal ?? undefined,
      exchange: o.exchange ?? undefined,
      allowedAccounts,
      purpose,
      strict,
      // Strict purposes never see a backup source, a stale value or a value still being refreshed.
      allowBackup: o.allowBackup === true && !o.accountId && !strict,
      maxWaitMs: o.maxWaitMs,
      backgroundShare: priority === "background" ? o.backgroundShare : undefined,
      swr: o.staleWhileRevalidate === true && !strict,
    };
  }

  /** Throws ACCOUNT_NOT_FOUND for an unknown pinned account. */
  function checkPinned(accountId) {
    if (accountId) accounts.get(accountId);
  }

  function brokerOf(accountId) {
    return accounts.get(accountId).broker;
  }

  function adapterCaps(accountId) {
    try {
      const a = accounts.adapter(accountId);
      return a?.capabilities && typeof a.capabilities === "object" ? a.capabilities : {};
    } catch {
      return {};
    }
  }

  /**
   * The account to use for a read: the pinned one, or the best pooled candidate among the accounts the caller may use.
   * Null when none can serve it (never borrows an account outside `allowed`).
   * @param {string[] | undefined} allowed  caller's account restriction; undefined = any account
   */
  function chooseAccount(capability, endpointClass, pinned, allowed, o) {
    if (pinned) {
      const candidates = accounts.marketDataCandidates({ capability, accountId: pinned, ...(allowed ? { allowedAccounts: allowed } : {}) });
      return Array.isArray(candidates) && candidates.length ? candidates[0] : null;
    }
    // Unpinned: the router scores the pooled accounts (spare budget, error rate, latency) and drops ejected ones.
    const plan = router.select({
      capability: READ_CAPABILITY[capability] ?? capability,
      brokerCapability: capability,
      endpointClass,
      only: "brokers",
      purpose: o?.purpose,
      deadlineMs: o?.maxWaitMs,
      allowedAccounts: allowed,
    });
    return plan[0]?.id ?? null;
  }

  /**
   * Split an unpinned quote read over the pooled accounts (same holder, pooling allowed, the caller may use them):
   * symbols go out in each account's maxQuoteBatch-sized chunks to the account with the most spare quote budget, so a
   * 200-symbol scan uses every pooled account's limit instead of queueing on one. Null when there is nothing to split
   * (one candidate, or one symbol); the caller then uses its single chosen account.
   * @param {string[]} list  canonical symbols still to fetch
   * @param {string[] | undefined} allowed
   * @returns {Map<string, string> | null} symbol -> accountId
   */
  function spreadQuotes(list, allowed) {
    if (list.length < 2) return null;
    const q = { capability: "quotes" };
    if (allowed) q.allowedAccounts = allowed;
    const candidates = (accounts.marketDataCandidates(q) ?? []).filter((id) => health.canTry(id));
    if (!Array.isArray(candidates) || candidates.length < 2) return null;
    const slots = candidates.map((id, index) => {
      let batch = 1;
      let spare = 1;
      let limit = 1;
      let blockedMs = 0;
      try {
        batch = Math.max(1, Math.floor(Number(scheduler.policyFor(brokerOf(id))?.maxQuoteBatch) || 1));
      } catch {
        batch = 1;
      }
      try {
        const h = scheduler.headroom(id, "quote");
        limit = Number.isFinite(h?.limit) && h.limit > 0 ? h.limit : h?.limit === Infinity ? 1e9 : 1;
        spare = Number.isFinite(h?.remaining) ? Math.max(0, h.remaining) : limit;
        if (spare <= 0) blockedMs = Number(h?.resetMs) || 0;
      } catch {
        // no headroom figure: treat as one call of budget
      }
      return { id, index, batch, spare, limit, blockedMs, planned: 0 };
    });
    // An account out of budget for longer than a per-second window (broker back-off, minute or day limit used up)
    // gets nothing; waiting on it would hold up the whole read.
    const usableSlots = slots.filter((s) => s.blockedMs <= SPREAD_MAX_WAIT_MS);
    if (usableSlots.length < 2) return null;
    // Spare share after the chunks already planned; ties go to the earlier account in config order.
    const score = (s) => (s.spare - s.planned) / s.limit;
    const out = new Map();
    let i = 0;
    while (i < list.length) {
      let best = usableSlots[0];
      for (const s of usableSlots) if (score(s) > score(best) || (score(s) === score(best) && s.planned < best.planned)) best = s;
      for (const sym of list.slice(i, i + best.batch)) out.set(sym, best.id);
      i += best.batch;
      best.planned += 1;
    }
    return out;
  }

  function noAccountError(what, pinned) {
    if (pinned) return new BridgeError("CAPABILITY_UNSUPPORTED", `Account ${pinned} cannot supply ${what} through its broker.`);
    return new BridgeError("BROKER_UNAVAILABLE", `No connected broker account can supply ${what} right now. Connect an account in the Bridge, or log in again.`);
  }

  /** True when the (account, class) budget is used up right now. */
  function budgetExhausted(accountId, endpointClass) {
    try {
      return scheduler.headroom(accountId, endpointClass).remaining <= 0;
    } catch {
      return false;
    }
  }

  /** A cached entry acceptable as a labelled-stale fallback for this read. */
  function staleEntry(key, pinned, capMs = cfg.stale.maxStaleMs, o) {
    // Orders, risk, paper and alerts never act on a value older than its freshness target.
    if (!cfg.stale.enabled || o?.strict) return null;
    const e = cache.getStale(key, Math.min(capMs, cfg.stale.maxStaleMs));
    if (!e || (pinned && e.accountId !== pinned)) return null;
    return e;
  }

  /** A cached entry within the freshness target. */
  function freshEntry(key, targetMs, pinned) {
    const e = cache.get(key, targetMs);
    if (!e || (pinned && e.accountId !== pinned)) return null;
    return e;
  }

  /**
   * Run one broker call through the scheduler. The adapter and credentials are fetched inside the scheduled function.
   * @returns {Promise<any>} the adapter result
   */
  async function callBroker({ accountId, broker, endpointClass, priority, coalesceKey, signal, maxWaitMs, backgroundShare, cost = 1 }, fn) {
    const opts = { accountId, endpointClass, priority, coalesceKey, cost };
    if (priority === "background" && typeof backgroundShare === "number") opts.backgroundShare = backgroundShare;
    if (signal) opts.signal = signal;
    if (maxWaitMs !== undefined) opts.maxWaitMs = maxWaitMs;
    if (backgroundShare !== undefined && priority === "background") opts.backgroundShare = backgroundShare;
    // Only the caller that really ran the call records its outcome (a joiner of a coalesced call would count it twice),
    // and time is taken inside the scheduled function so queueing is not counted as the broker's latency.
    let startedAt = null;
    try {
      const res = await scheduler.schedule(opts, async () => {
        stats.brokerCalls += 1;
        startedAt = now();
        const adapter = accounts.adapter(accountId);
        const creds = await accounts.creds(accountId);
        return fn(adapter, creds);
      });
      if (startedAt !== null) health.record(accountId, { ok: true, ms: Math.max(0, now() - startedAt) });
      return res;
    } catch (err) {
      const bridge = toBridge(err, broker);
      if (startedAt !== null) {
        const kind = outcomeKindOf(bridge);
        if (kind) health.record(accountId, { ok: false, ms: Math.max(0, now() - startedAt), kind, message: String(bridge?.message ?? "").slice(0, 200) });
        else health.release?.(accountId);
      }
      throw bridge;
    }
  }

  /** Reject when `signal` aborts (the caller went away); the shared work carries on for others. */
  function raceSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) {
      promise.catch(() => {});
      return Promise.reject(abortError(signal));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  // ── symbols ──

  /** Canonical symbol for any accepted input (canonical, venue form, chart tickers, continuous futures ...). */
  async function canonical(input) {
    const s = String(input ?? "").trim();
    if (!s) throw new BridgeError("VALIDATION_FAILED", "A symbol is required.");
    if (!usable(symbols)) return parseSymbol(s).canonical;
    try {
      return symbols.parse(s).canonical;
    } catch (err) {
      const r = await symbols.resolve(s);
      if (r?.canonical) return r.canonical;
      throw err;
    }
  }

  async function brokerRef(symbol, broker) {
    if (!usable(symbols)) throw new BridgeError("NOT_IMPLEMENTED", "Symbol resolution is not built yet.");
    const ref = await symbols.toBroker(symbol, broker);
    if (!ref?.token) throw new BridgeError("SYMBOL_NOT_FOUND", `${symbol} is not in ${broker}'s instrument list.`);
    return { token: String(ref.token), exchange: ref.exchange ?? parseSymbol(symbol).exchange };
  }

  function normaliseUnderlying(input) {
    let u = String(input ?? "").trim().toUpperCase();
    const colon = u.indexOf(":");
    if (colon > 0) u = u.slice(colon + 1);
    if (!UNDERLYING_RE.test(u)) {
      throw new BridgeError("VALIDATION_FAILED", "underlying must be an index or stock name such as NIFTY, BANKNIFTY, SENSEX or RELIANCE.", {
        errors: [{ path: "underlying", message: "not a valid underlying" }],
      });
    }
    return u;
  }

  /** The cash/index symbol that prices an underlying. */
  function spotSymbol(underlying) {
    return parseSymbol(`${BSE_INDICES.has(underlying) ? "BSE" : "NSE"}:${underlying}`).canonical;
  }

  // ── stream ──

  function fromStream(symbol, wantQuote, pinned, targetMs) {
    if (!cfg.streamFirst || !usable(streamHub)) return null;
    try {
      if (!streamHub.isLive(symbol)) return null;
      const t = streamHub.lastTick(symbol);
      if (!t || (pinned && t.accountId !== pinned)) return null;
      if (wantQuote && !tickHasQuote(t)) return null;
      // A connected feed says nothing about how old its last tick is (illiquid strike, after the close, a tick from
      // before a reconnect). A tick older than the caller's freshness target falls through to the cache/broker path.
      if (!Number.isFinite(t.receivedAt)) return null;
      if (Number.isFinite(targetMs) && now() - t.receivedAt > targetMs) return null;
      const fields = tickFields(t);
      if (!fields) return null;
      return { fields, at: t.receivedAt, accountId: t.accountId ?? null, broker: t.broker ?? null };
    } catch {
      return null;
    }
  }

  /**
   * A chain leg whose last tick is older than the freshness target, trusted because nothing traded: its subscription
   * is live, its feed is delivering ticks now (some symbol ticked within `targetMs`, and the feed is not silent), the
   * tick came on the current connection, and it is no older than market.quietLegMaxAgeMs. Null otherwise.
   */
  function quietFromStream(symbol, pinned, targetMs) {
    const maxMs = cfg.quietLegMaxAgeMs;
    if (!(maxMs > 0) || typeof streamHub.feedInfo !== "function") return null;
    try {
      const info = streamHub.feedInfo(symbol);
      if (!info || info.stale || !Number.isFinite(info.lastTickAt) || now() - info.lastTickAt > targetMs) return null;
      const t = streamHub.lastTick(symbol);
      if (!t || (pinned && t.accountId !== pinned) || !tickHasQuote(t) || !Number.isFinite(t.receivedAt)) return null;
      if (Number.isFinite(info.connectedAt) && t.receivedAt < info.connectedAt) return null;
      if (now() - t.receivedAt > maxMs) return null;
      const fields = tickFields(t);
      if (!fields) return null;
      return { fields, at: t.receivedAt, accountId: t.accountId ?? null, broker: t.broker ?? null, quiet: true };
    } catch {
      return null;
    }
  }

  // ── LTP and quotes ──

  const quoteKey = (symbol) => `q|${symbol}`;

  /** Batch flush: one account, one priority; fetch every id through fetchQuotes in maxQuoteBatch chunks. */
  async function runQuoteBatch(group, ids) {
    // The sixth part (the opener's fair key) only keeps consumers' batches apart; the run is already credited to it.
    const [accountId, priority, staleFlag, waitRaw, shareRaw] = group.split("|");
    // A background caller's short wait and dispatch floor travel in the group key.
    const callerWait = waitRaw ? Number(waitRaw) : undefined;
    const share = shareRaw ? Number(shareRaw) : undefined;
    const results = new Map();
    let broker;
    try {
      broker = brokerOf(accountId);
    } catch (err) {
      for (const id of ids) results.set(id, { error: toBridge(err) });
      return results;
    }
    let batchSize = 1;
    try {
      batchSize = Math.max(1, Math.floor(Number(scheduler.policyFor(broker)?.maxQuoteBatch) || 1));
    } catch {
      batchSize = 1;
    }
    const resolved = [];
    await Promise.all(
      ids.map(async (symbol) => {
        try {
          resolved.push({ symbol, ref: await brokerRef(symbol, broker) });
        } catch (err) {
          results.set(symbol, { error: toBridge(err, broker) });
        }
      }),
    );
    // Stable chunks: the same symbol set always makes the same coalesceKey.
    resolved.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const chunks = [];
    for (let i = 0; i < resolved.length; i += batchSize) chunks.push(resolved.slice(i, i + batchSize));
    // Queue never-fetched and oldest-cached chunks first, so when the budget only covers some of them the budget
    // rotates through every symbol instead of always refreshing the same few.
    const lastFetched = (chunk) => Math.min(...chunk.map((c) => cache.peek(quoteKey(c.symbol))?.at ?? -Infinity));
    chunks.sort((a, b) => lastFetched(a) - lastFetched(b));
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const res = await callBroker(
            {
              accountId,
              broker,
              endpointClass: "quote",
              priority,
              coalesceKey: `quote:${accountId}:${chunk.map((c) => c.symbol).join(",")}`,
              maxWaitMs: callerWait ?? (staleFlag === "s" ? cfg.stale.waitMs : undefined),
              backgroundShare: share,
            },
            (adapter, creds) => {
              if (typeof adapter.fetchQuotes !== "function") throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} offers no quotes API.`);
              return adapter.fetchQuotes(creds, chunk.map((c) => ({ token: c.ref.token, exchange: c.ref.exchange })));
            },
          );
          const at = now();
          const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
          const byRef = new Map(rows.map((r) => [`${String(r?.exchange ?? "").toUpperCase()}|${String(r?.token ?? "")}`, r]));
          for (const c of chunk) {
            let row = byRef.get(`${c.ref.exchange}|${c.ref.token}`);
            if (!row && chunk.length === 1 && rows.length === 1) row = rows[0];
            const fields = quoteFields(row);
            if (!fields) {
              results.set(c.symbol, { error: new BridgeError("UPSTREAM_ERROR", `The broker (${broker}) returned no price for ${c.symbol}.`) });
              continue;
            }
            results.set(c.symbol, { value: cache.set(quoteKey(c.symbol), { fields, full: true }, { at, accountId, broker }) });
          }
          saving("batched", chunk.length - 1);
        } catch (err) {
          for (const c of chunk) results.set(c.symbol, { error: err });
        }
      }),
    );
    return results;
  }

  const batcher = createBatcher({
    windowMs: cfg.batch.windowMs,
    maxSize: cfg.batch.maxSymbols,
    run: runQuoteBatch,
    setTimer,
    clearTimer,
    missingError: (id) => new BridgeError("UPSTREAM_ERROR", `No result for ${id}.`),
    onMerged: (n) => saving("coalesced", n),
  });

  /** Fetch full quotes for one symbol on one account (joins an in-flight fetch). */
  function fetchQuote(accountId, symbol, priority, hasStale, { maxWaitMs, backgroundShare } = {}) {
    const key = `${accountId}|q|${symbol}`;
    const running = inflight.get(key);
    if (running) {
      saving("coalesced");
      markShared();
      return running;
    }
    const share = priority === "background" && backgroundShare !== undefined ? backgroundShare : "";
    // The batch is per consumer (the last part of the key): a batch is credited to whoever opened it, so a light reader
    // that joined a heavy reader's batch would wait in the heavy reader's place in the fair queue. The cost is that two
    // consumers asking for different symbols in the same window make two calls, not one. The same symbol asked by both
    // still joins the call already in flight (the `inflight` check above).
    const fair = currentConsumerInfo()?.fairKey ?? "";
    const p = batcher.add(`${accountId}|${priority}|${hasStale ? "s" : "n"}|${maxWaitMs ?? ""}|${share}|${fair}`, symbol).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /** Fetch an LTP through the adapter's fetchLTP (brokers without a quotes API; indices and stocks only). */
  function fetchLtpOnly(accountId, symbol, priority, hasStale, { maxWaitMs, backgroundShare } = {}) {
    const key = `${accountId}|l|${symbol}`;
    const running = inflight.get(key);
    if (running) {
      saving("coalesced");
      markShared();
      return running;
    }
    const p = (async () => {
      const parsed = parseSymbol(symbol);
      const broker = brokerOf(accountId);
      if (parsed.kind !== "INDEX" && parsed.kind !== "EQ") {
        throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} offers no quotes API, so ${symbol} cannot be priced; only index and stock prices are available.`);
      }
      // fetchLTP takes a bare name and resolves it on NSE, so a BSE stock would come back with its NSE price.
      if (parsed.kind === "EQ" && parsed.exchange !== "NSE") {
        throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} offers no quotes API, and its last-price lookup covers NSE stocks only, so ${symbol} cannot be priced.`);
      }
      const res = await callBroker(
        { accountId, broker, endpointClass: "quote", priority, coalesceKey: `ltp:${accountId}:${symbol}`, maxWaitMs: maxWaitMs ?? (hasStale ? cfg.stale.waitMs : undefined), backgroundShare },
        (adapter, creds) => adapter.fetchLTP(creds, parsed.underlying),
      );
      const fields = ltpOnlyFields(res?.data?.last_price ?? res?.data?.ltp ?? res?.last_price);
      if (!fields) throw new BridgeError("UPSTREAM_ERROR", `The broker (${broker}) returned no price for ${symbol}.`);
      return cache.set(quoteKey(symbol), { fields, full: false }, { at: now(), accountId, broker });
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * Shared read path for ltp() and quotes().
   * @param {"ltp"|"quote"} kind
   * @param {string[]} inputs
   * @param {{ accountId: string | null, maxAgeMs?: number, priority: string }} o
   */
  async function readPrices(kind, inputs, o) {
    const wantQuote = kind === "quote";
    const targetMs = o.maxAgeMs ?? (wantQuote ? cfg.freshness.quoteMs : cfg.freshness.ltpMs);
    const pinned = o.accountId ?? null;
    checkPinned(pinned);
    const toItem = wantQuote ? toQuoteItem : toLtpItem;
    const errors = [];
    /** canonical -> item */
    const items = new Map();
    const order = [];
    const seen = new Set();
    const failedInputs = new Set();
    const canon = await Promise.all(
      inputs.map(async (input) => {
        try {
          return { input, symbol: await canonical(input) };
        } catch (err) {
          return { input, error: err };
        }
      }),
    );
    for (const c of canon) {
      if (c.error) {
        const label = String(c.input ?? "");
        if (!failedInputs.has(label)) errors.push(itemError(label, c.error));
        failedInputs.add(label);
      } else if (!seen.has(c.symbol)) {
        seen.add(c.symbol);
        order.push(c.symbol);
      }
    }

    const t = now();
    const pending = [];
    for (const symbol of order) {
      const s = fromStream(symbol, wantQuote, pinned, targetMs);
      if (s) {
        items.set(symbol, toItem(symbol, s.fields, freshness({ source: "stream", at: s.at, now: t, targetMs, accountId: s.accountId, broker: s.broker })));
        saving("stream");
        continue;
      }
      const e = freshEntry(quoteKey(symbol), targetMs, pinned);
      if (e && (!wantQuote || e.value.full)) {
        items.set(symbol, toItem(symbol, e.value.fields, freshness({ source: "cache", at: e.at, now: t, targetMs, accountId: e.accountId, broker: e.broker })));
        saving("cache");
        continue;
      }
      pending.push(symbol);
    }

    if (pending.length) {
      const failures = new Map();
      // A pinned read stays on its account. An unpinned read gets up to two ordered attempts from the router: the best
      // broker account, then the next broker or (when the read allows backup sources) a data source. Failover is the
      // retry: nothing is retried on the same source.
      let plan = [];
      let viaLtp = false;
      if (pinned) {
        const quotesId = chooseAccount("quotes", "quote", pinned, o.allowedAccounts);
        const id = quotesId ?? (!wantQuote ? chooseAccount("ltp", "quote", pinned, o.allowedAccounts) : null);
        viaLtp = !quotesId && Boolean(id);
        if (id) plan = [{ kind: "broker", id }];
      } else {
        const ask = (brokerCapability) =>
          router.select({ capability: "quotes", brokerCapability, endpointClass: "quote", purpose: o.purpose, maxAgeMs: o.maxAgeMs, symbols: pending, deadlineMs: o.maxWaitMs, allowedAccounts: o.allowedAccounts, allowSources: o.allowBackup });
        plan = ask("quotes");
        if (!wantQuote && !plan.some((c) => c.kind === "broker")) {
          const ltpPlan = ask("ltp");
          if (ltpPlan.some((c) => c.kind === "broker")) {
            plan = ltpPlan;
            viaLtp = true;
          }
        }
      }
      const first = plan[0] ?? null;
      const brokerFirst = first?.kind === "broker";
      const spread = !viaLtp && brokerFirst && !pinned ? spreadQuotes(pending, o.allowedAccounts) : null;
      /** symbol -> the account or source its first attempt used */
      const used = new Map();
      /** symbols whose first attempt was a data source: their failure is that source's, not the broker's */
      const sourceFirst = new Set();
      const callOpts = { maxWaitMs: o.maxWaitMs, backgroundShare: o.backgroundShare };

      const fetchOn = async (accountId, symbol, hasStale) => {
        const kind = viaLtp ? "ltp" : "quote";
        const entry = await guarded(accountId, kind, symbol, () => (viaLtp ? fetchLtpOnly(accountId, symbol, o.priority, hasStale, callOpts) : fetchQuote(accountId, symbol, o.priority, hasStale, callOpts)));
        if (wantQuote && !entry.value.full) throw new BridgeError("CAPABILITY_UNSUPPORTED", `Only a last price is available for ${symbol}.`);
        return entry;
      };
      const brokerItem = (symbol, entry) => toItem(symbol, entry.value.fields, freshness({ source: "broker", at: entry.at, now: now(), targetMs, accountId: entry.accountId, broker: entry.broker }));

      /** Ask one data source for `list`; answered symbols leave `failures`, the rest keep (or get) an error. */
      const answerFromSource = async (cand, list, { replaceErrors }) => {
        const todo = [];
        for (const symbol of list) {
          const hit = failCache.get(cand.id, "quote", symbol);
          if (hit) {
            if (replaceErrors || !failures.has(symbol)) failures.set(symbol, new BridgeError(hit.code, hit.message));
          } else todo.push(symbol);
        }
        if (!todo.length) return;
        let b;
        try {
          b = await viaSource(cand, () => backup.quotes(todo, { maxAgeMs: o.maxAgeMs, purpose: o.purpose, sourceId: cand.id, signal: o.signal }), unanswered);
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          const e = toBridge(err);
          for (const symbol of todo) if (replaceErrors || !failures.has(symbol)) failures.set(symbol, e);
          return;
        }
        const got = new Set();
        for (const it of b?.items ?? []) {
          if (!todo.includes(it.symbol) || got.has(it.symbol)) continue;
          const full = quoteFields(it.fields) ?? it.fields;
          if (!full || !Number.isFinite(full.ltp)) continue;
          const fields = wantQuote ? full : { ltp: full.ltp };
          items.set(it.symbol, toItem(it.symbol, fields, sourceFreshness(cand, { at: it.at ?? now(), provider: it.provider, targetMs, maxAgeMs: o.maxAgeMs })));
          failures.delete(it.symbol);
          got.add(it.symbol);
          stats.backup += 1;
        }
        for (const symbol of todo) {
          if (got.has(symbol)) continue;
          const e = new BridgeError("SYMBOL_NOT_FOUND", `${cand.descriptor.name ?? cand.id} has no price for ${symbol}.`);
          failCache.note(cand.id, "quote", symbol, e);
          if (replaceErrors || !failures.has(symbol)) failures.set(symbol, e);
        }
      };

      const toSource = [];
      await Promise.all(
        pending.map(async (symbol) => {
          if (!first) {
            failures.set(symbol, noAccountError(wantQuote ? "quotes" : "prices", pinned));
            return;
          }
          const accountId = brokerFirst ? spread?.get(symbol) ?? first.id : null;
          const stale = staleEntry(quoteKey(symbol), pinned, undefined, o);
          const staleOk = stale && (!wantQuote || stale.value.full) ? stale : null;
          const serveStale = () => {
            items.set(symbol, toItem(symbol, staleOk.value.fields, freshness({ source: "cache", at: staleOk.at, now: now(), targetMs, stale: true, accountId: staleOk.accountId, broker: staleOk.broker })));
            saving("cache");
            stats.stale += 1;
          };
          // A labelled-stale cached value beats a delayed source and beats queueing past the caller's deadline.
          const pressureAccount = accountId ?? plan.find((c) => c.kind === "broker")?.id ?? null;
          if (staleOk && pressureAccount && budgetExhausted(pressureAccount, "quote")) return serveStale();
          // The HTTP caller has gone away (closed tab, cancelled poll): do not queue for broker budget on its behalf.
          if (o.signal?.aborted) throw abortError(o.signal);
          if (!accountId) {
            sourceFirst.add(symbol);
            used.set(symbol, first.id);
            toSource.push(symbol);
            return;
          }
          used.set(symbol, accountId);
          if (staleOk && o.swr) {
            // Answer now from the older value; the refresh joins any fetch already running and fills the cache.
            serveStale();
            const item = items.get(symbol);
            if (item?.freshness) item.freshness.revalidating = true;
            const refresh = viaLtp ? fetchLtpOnly(accountId, symbol, o.priority, true, callOpts) : fetchQuote(accountId, symbol, o.priority, true, callOpts);
            refresh.catch(() => {});
            return;
          }
          try {
            items.set(symbol, brokerItem(symbol, await fetchOn(accountId, symbol, Boolean(staleOk))));
          } catch (err) {
            if (err?.name === "AbortError") throw err;
            const e = toBridge(err);
            if (staleOk && isPressure(e)) return serveStale();
            failures.set(symbol, e);
          }
        }),
      );
      if (toSource.length) await answerFromSource(first, toSource, { replaceErrors: true });

      // Second attempt (failover) for the symbols whose first attempt failed in a way another source can still answer.
      if (!pinned && failures.size && plan.length > 1) {
        const groups = new Map();
        for (const [symbol, err] of failures) {
          if (!failoverable(err)) continue;
          const next = plan.find((c) => c.id !== used.get(symbol));
          if (!next) continue;
          let g = groups.get(next.id);
          if (!g) groups.set(next.id, (g = { cand: next, list: [] }));
          g.list.push(symbol);
        }
        await Promise.all(
          [...groups.values()].map(async ({ cand, list }) => {
            if (cand.kind === "source") return answerFromSource(cand, list, { replaceErrors: false });
            await Promise.all(
              list.map(async (symbol) => {
                if (o.signal?.aborted) throw abortError(o.signal);
                try {
                  items.set(symbol, brokerItem(symbol, await fetchOn(cand.id, symbol, false)));
                  failures.delete(symbol);
                } catch (err) {
                  if (err?.name === "AbortError") throw err;
                  // keep the first attempt's error unless that was a data source's (the broker's is more telling)
                  if (sourceFirst.has(symbol)) failures.set(symbol, toBridge(err));
                }
              }),
            );
          }),
        );
      }
      for (const [symbol, err] of failures) errors.push(itemError(symbol, err));
    }

    return { items: order.filter((s) => items.has(s)).map((s) => items.get(s)), errors };
  }

  function checkSymbolList(list) {
    if (!Array.isArray(list) || list.length === 0) throw new BridgeError("VALIDATION_FAILED", "Give at least one symbol.", { errors: [{ path: "symbols", message: "empty" }] });
    if (list.length > MAX_SYMBOLS) {
      throw new BridgeError("VALIDATION_FAILED", `Ask for at most ${MAX_SYMBOLS} symbols at a time.`, { errors: [{ path: "symbols", message: `more than ${MAX_SYMBOLS}` }] });
    }
  }

  // ── depth ──

  async function depth(symbolIn, opts) {
    const o = readOpts(opts);
    const symbol = await canonical(symbolIn);
    const pinned = o.accountId;
    checkPinned(pinned);
    const targetMs = o.maxAgeMs ?? cfg.freshness.depthMs;
    const key = `d|${symbol}`;
    const hit = freshEntry(key, targetMs, pinned);
    if (hit) {
      saving("cache");
      return { symbol, ...hit.value, freshness: freshness({ source: "cache", at: hit.at, now: now(), targetMs, accountId: hit.accountId, broker: hit.broker }) };
    }
    const accountId = chooseAccount("depth", "depth", pinned, o.allowedAccounts, o);
    if (!accountId) throw noAccountError("market depth", pinned);
    const stale = staleEntry(key, pinned, DEPTH_STALE_CAP_MS, o);
    const serveStale = () => {
      saving("cache");
      stats.stale += 1;
      return { symbol, ...stale.value, freshness: freshness({ source: "cache", at: stale.at, now: now(), targetMs, stale: true, accountId: stale.accountId, broker: stale.broker }) };
    };
    if (stale && budgetExhausted(accountId, "depth")) return serveStale();
    const broker = brokerOf(accountId);
    try {
      const ref = await brokerRef(symbol, broker);
      const res = await raceSignal(
        guardedBroker("depth", symbol)(
          { accountId, broker, endpointClass: "depth", priority: o.priority, coalesceKey: `depth:${accountId}:${symbol}`, maxWaitMs: stale ? cfg.stale.waitMs : undefined },
          (adapter, creds) => {
            if (typeof adapter.fetchDepth !== "function") throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} offers no market depth API.`);
            return adapter.fetchDepth(creds, ref);
          },
        ),
        o.signal,
      );
      const fields = depthFields(res?.data ?? res);
      const entry = cache.set(key, fields, { at: now(), accountId, broker });
      return { symbol, ...fields, freshness: freshness({ source: "broker", at: entry.at, now: now(), targetMs, accountId, broker }) };
    } catch (err) {
      if (stale && isPressure(err)) return serveStale();
      throw err;
    }
  }

  // ── history ──

  /** One step of an interval in ms, for snapping history cache keys. */
  function historyStepMs(interval) {
    if (Object.hasOwn(INTRADAY_MINUTES, interval)) return INTRADAY_MINUTES[interval] * 60_000;
    if (interval === "1w") return 7 * 86_400_000;
    if (interval === "1M") return 28 * 86_400_000;
    return 86_400_000;
  }

  async function history(params, opts) {
    const parsed = historySchema.safeParse(params ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const p = parsed.data;
    const o = readOpts(opts);
    const symbol = await canonical(p.symbol);
    const parts = parseSymbol(symbol);
    const pinned = o.accountId;
    checkPinned(pinned);
    if (p.from === undefined && p.countback === undefined) {
      throw new BridgeError("VALIDATION_FAILED", "Give from (and optionally to), or countback.", { errors: [{ path: "from", message: "from or countback is required" }] });
    }
    const t = now();
    let toMs = p.to !== undefined ? parseTimeInput(p.to, { endOfDay: true, field: "to" }) : t;
    if (toMs > t) toMs = t;
    const fromMs = p.from !== undefined ? parseTimeInput(p.from, { field: "from" }) : countbackRange({ toMs, countback: p.countback, interval: p.interval, exchange: parts.exchange });
    if (fromMs > toMs) throw new BridgeError("VALIDATION_FAILED", "from must be before to.", { errors: [{ path: "from", message: "after to" }] });

    const targetMs = o.maxAgeMs ?? cfg.freshness.historyMs;
    // Chart clients send a slightly different from/to on every refresh (they pad or move `to`), so the
    // cache key snaps both to interval steps and treats a `to` within one step of now as "now". The broker fetch
    // covers the whole snapped range, so a hit holds every bar of any request with the same key; it is then filtered
    // to the exact range asked for.
    const stepMs = historyStepMs(p.interval);
    const snap = (ms) => Math.floor(ms / stepMs) * stepMs;
    const byCountback = p.from === undefined;
    const toIsNow = t - toMs <= stepMs;
    const fetchFromMs = byCountback ? fromMs : snap(fromMs);
    const fetchToMs = toIsNow ? t : Math.min(t, snap(toMs) + stepMs - 1);
    const key = `h|${symbol}|${p.interval}|${byCountback ? "" : fetchFromMs}|${toIsNow ? "now" : fetchToMs}|${p.countback ?? ""}|${pinned ?? "*"}`;
    const lo = Math.floor(fromMs / 1000);
    const hi = Math.floor(toMs / 1000);
    const pick = (candles) => {
      let out = byCountback ? candles.filter((c) => c.time <= hi) : candles.filter((c) => c.time >= lo && c.time <= hi);
      if (p.countback !== undefined && out.length > p.countback) out = out.slice(out.length - p.countback);
      return out;
    };
    const hit = freshEntry(key, targetMs, pinned);
    if (hit) {
      saving("cache");
      return { ...hit.value, candles: pick(hit.value.candles), freshness: freshness({ source: "cache", at: hit.at, now: t, targetMs, accountId: hit.accountId, broker: hit.broker }) };
    }

    const fromSource = async (cand) => {
      const b = await viaSource(cand, () => backup.history({ symbol, interval: p.interval, fromMs: fetchFromMs, toMs: fetchToMs, sourceId: cand.id }, { sourceId: cand.id, purpose: o.purpose, signal: o.signal }));
      stats.backup += 1;
      // Not put in the shared cache: a later hit would be labelled "cache" and could be mistaken for broker data.
      return { symbol, interval: p.interval, candles: pick(b.candles), partial: b.partial, freshness: sourceFreshness(cand, { at: b.at, provider: b.provider, targetMs, maxAgeMs: o.maxAgeMs }) };
    };
    const supportsHistory = (id) => historySupport(accounts, id, p.interval, parts.exchange);
    // Up to two attempts: the best broker that can serve this interval, then the next broker or (when the read allows
    // backup sources) a data source. With no broker able to serve it, a source goes first and the broker path runs last
    // so the caller still gets the broker's own explanation.
    let attempts = [{ kind: "broker", id: null }];
    if (!pinned) {
      attempts = router.select({ capability: "history", brokerCapability: "historical", endpointClass: "history", purpose: o.purpose, maxAgeMs: o.maxAgeMs, deadlineMs: o.maxWaitMs, allowedAccounts: o.allowedAccounts, allowSources: o.allowBackup, supports: supportsHistory });
      if (!attempts.some((c) => c.kind === "broker")) attempts = [...attempts, { kind: "broker", id: null }];
    }
    let brokerError = null;
    let firstError = null;
    for (const cand of attempts) {
      try {
        if (cand.kind === "source") return await fromSource(cand);
        return await guarded(cand.id ?? pinned ?? "-", "history", `${symbol}|${p.interval}`, () => brokerHistory(cand.id));
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        firstError ??= err;
        if (cand.kind === "broker") brokerError ??= err;
        if (!failoverable(err)) throw brokerError ?? err;
      }
    }
    throw brokerError ?? firstError;

    async function brokerHistory(preselected) {
      const accountId = preselected ?? chooseAccount("historical", "history", pinned, o.allowedAccounts, o);
      if (!accountId) throw noAccountError("historical candles", pinned);
      const broker = brokerOf(accountId);
      const caps = adapterCaps(accountId).historical;
      const capObj = caps && typeof caps === "object" ? caps : {};
      if (Array.isArray(capObj.segments) && !capObj.segments.includes(parts.exchange)) {
        throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} offers historical candles only for ${capObj.segments.join(", ")}.`);
      }
      const plan = planInterval(p.interval, capObj.intervals);
      const daily = plan.base === "1d";
      const spans = cfg.history.brokers[broker] ?? {};
      const spanDays = (daily ? spans.daily : spans.intraday) ?? (daily ? cfg.history.maxSpanDays.daily : cfg.history.maxSpanDays.intraday);
      let chunks = planChunks({ fromMs: fetchFromMs, toMs: fetchToMs, spanDays, daily });
      let partial = false;
      if (chunks.length > cfg.history.maxChunks) {
        chunks = chunks.slice(0, cfg.history.maxChunks); // newest first: keep the most recent part
        partial = true;
      }
      const ref = await brokerRef(symbol, broker);
      const settled = await raceSignal(
        Promise.allSettled(
          chunks.map((c) =>
            callBroker(
              { accountId, broker, endpointClass: "history", priority: o.priority, coalesceKey: `history:${accountId}:${symbol}:${plan.base}:${c.from}:${c.to}`, backgroundShare: o.backgroundShare },
              (adapter, creds) => {
                if (typeof adapter.fetchHistorical !== "function") throw new BridgeError("CAPABILITY_UNSUPPORTED", `${broker} offers no historical candles.`);
                return adapter.fetchHistorical(creds, { instrument: ref, interval: plan.base, from: c.from, to: c.to });
              },
            ),
          ),
        ),
        o.signal,
      );
      const lists = [];
      let firstError = null;
      // chunks are newest first; merge oldest first so a newer chunk wins any overlap
      for (let i = settled.length - 1; i >= 0; i -= 1) {
        const s = settled[i];
        if (s.status === "fulfilled") lists.push(normaliseCandles(s.value?.data ?? s.value));
        else {
          firstError ??= s.reason;
          partial = true;
        }
      }
      if (!lists.length) throw toBridge(firstError, broker);
      const merged = mergeCandles(lists).filter((c) => c.time >= Math.floor(fetchFromMs / 1000) && c.time <= Math.floor(fetchToMs / 1000));
      const all = aggregate(merged, plan, p.interval, parts.exchange);
      const at = now();
      cache.set(key, { symbol, interval: p.interval, candles: all, partial }, { at, accountId, broker });
      const value = { symbol, interval: p.interval, candles: pick(all), partial };
      return { ...value, freshness: freshness({ source: "broker", at, now: at, targetMs, accountId, broker }) };
    }
  }

  // ── expiries ──

  /** Option (else future) expiries for an underlying from the instrument master: no broker call. */
  async function masterExpiries(underlying, exchange) {
    if (!usable(symbols)) return [];
    const today = istDate(now());
    for (const kind of ["OPT", "FUT"]) {
      const set = new Set();
      let cursor;
      for (let page = 0; page < MASTER_MAX_PAGES; page += 1) {
        const q = { q: underlying, underlying, kind, limit: MASTER_PAGE_LIMIT };
        const ex = exchange ?? derivExchangeHint(underlying);
        if (ex) q.exchange = ex;
        if (cursor) q.cursor = cursor;
        const res = await symbols.search(q);
        for (const r of res?.items ?? []) if (r?.underlying === underlying && r.expiry && r.expiry >= today) set.add(r.expiry);
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
      if (set.size) return [...set].sort();
    }
    return [];
  }

  async function expiries(underlyingIn, opts) {
    const o = readOpts(opts);
    const underlying = normaliseUnderlying(underlyingIn);
    let exchange = null;
    if (o.exchange !== undefined && o.exchange !== "") {
      exchange = String(o.exchange).toUpperCase();
      if (!EXPIRY_EXCHANGES.includes(exchange)) {
        throw new BridgeError("VALIDATION_FAILED", `exchange must be one of ${EXPIRY_EXCHANGES.join(", ")}.`, { errors: [{ path: "exchange", message: "not allowed" }] });
      }
    }
    const pinned = o.accountId;
    checkPinned(pinned);
    const targetMs = o.maxAgeMs ?? cfg.freshness.expiriesMs;
    const key = `e|${underlying}|${exchange ?? ""}`;
    const hit = freshEntry(key, targetMs, pinned);
    if (hit) {
      saving("cache");
      return { underlying, expiries: [...hit.value], freshness: freshness({ source: "cache", at: hit.at, now: now(), targetMs, accountId: hit.accountId, broker: hit.broker }) };
    }
    const fromMaster = async () => {
      const list = await masterExpiries(underlying, exchange);
      if (!list.length) return null;
      saving("cache");
      const at = now();
      return { underlying, expiries: list, freshness: freshness({ source: "cache", at, now: at, targetMs, accountId: null, broker: null }) };
    };
    const fromBackup = async (cand, err) => {
      if (exchange && exchange !== "NFO") throw err;
      try {
        const b = await viaSource(cand, () => backup.expiries(underlying, { sourceId: cand.id, purpose: o.purpose, signal: o.signal }));
        stats.backup += 1;
        const today = istDate(now());
        return { underlying, expiries: b.expiries.filter((d) => d >= today), freshness: sourceFreshness(cand, { at: b.at, provider: b.provider, targetMs, maxAgeMs: o.maxAgeMs }) };
      } catch {
        throw err;
      }
    };
    const accountId = chooseAccount("expiries", "chain", pinned, o.allowedAccounts, o);
    if (!accountId) {
      const m = pinned ? null : await fromMaster();
      if (m) return m;
      const err = noAccountError("expiry dates", pinned);
      const src = sourceAfter("expiries", o, err);
      if (src) return fromBackup(src, err);
      throw err;
    }
    const broker = brokerOf(accountId);
    const stale = staleEntry(key, pinned, Math.max(cfg.stale.maxStaleMs, targetMs * 2), o);
    let list;
    try {
      const res = await raceSignal(
        guardedBroker("expiries", underlying)(
          { accountId, broker, endpointClass: "chain", priority: o.priority, coalesceKey: `expiries:${accountId}:${underlying}`, maxWaitMs: stale ? cfg.stale.waitMs : undefined },
          (adapter, creds) => adapter.fetchExpiryList(creds, underlying),
        ),
        o.signal,
      );
      const today = istDate(now());
      list = [...new Set((Array.isArray(res?.data) ? res.data : []).map(String).filter((d) => ISO_DATE_RE.test(d) && d >= today))].sort();
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      if (stale && isPressure(err)) {
        stats.stale += 1;
        saving("cache");
        return { underlying, expiries: [...stale.value], freshness: freshness({ source: "cache", at: stale.at, now: now(), targetMs, stale: true, accountId: stale.accountId, broker: stale.broker }) };
      }
      const m = pinned ? null : await fromMaster().catch(() => null);
      if (m) return m;
      const src = sourceAfter("expiries", o, err);
      if (src) return fromBackup(src, err);
      throw err;
    }
    // fetchExpiryList takes no exchange, so the broker may answer for another segment (NFO for BFO, NFO for MCX).
    // With an exchange named, keep only dates the instrument master lists for that exchange; when the master has
    // none to check against, answer without caching so the list can never be served later under the wrong segment.
    let verified = true;
    if (exchange && list.length) {
      const known = await masterExpiries(underlying, exchange).catch(() => []);
      if (known.length) list = list.filter((d) => known.includes(d));
      else verified = false;
    }
    if (!list.length) {
      const m = pinned ? null : await fromMaster();
      if (m) return m;
      throw new BridgeError("SYMBOL_NOT_FOUND", `No upcoming expiries were found for ${underlying}${exchange ? ` on ${exchange}` : ""}.`);
    }
    if (!verified) return { underlying, expiries: [...list], freshness: freshness({ source: "broker", at: now(), now: now(), targetMs, accountId, broker }) };
    const entry = cache.set(key, list, { at: now(), accountId, broker });
    return { underlying, expiries: [...list], freshness: freshness({ source: "broker", at: entry.at, now: now(), targetMs, accountId, broker }) };
  }

  // ── option chain ──

  /** Option legs for an underlying and expiry from the instrument master. */
  /**
   * Master searches pass the underlying as free text `q`, and the search reads exchange words as filters: an
   * underlying named BSE or MCX (both NSE F&O stocks) would filter every row away. Such underlyings get an explicit
   * derivatives exchange (the query's exchange wins over the parsed word).
   */
  const derivExchangeHint = (underlying) => (EXCHANGES.includes(String(underlying).toUpperCase()) ? defaultOptionExchange(underlying) : undefined);
  /** The cash exchange of an underlying's spot row (always explicit: spot rows live only on NSE and BSE). */
  const cashExchangeOf = (underlying) => (defaultOptionExchange(underlying) === "BFO" ? "BSE" : "NSE");

  /** underlying|expiry -> { at, legs }: the master's legs change once a day, a search for every chain read is waste. */
  const legsMemo = new Map();
  async function masterLegs(underlying, expiry) {
    if (!usable(symbols)) return [];
    const memoKey = `${underlying}|${expiry}`;
    const memo = legsMemo.get(memoKey);
    if (memo && now() - memo.at < 60_000) return memo.legs;
    const legs = await masterLegsUncached(underlying, expiry);
    legsMemo.set(memoKey, { at: now(), legs });
    if (legsMemo.size > 200) legsMemo.delete(legsMemo.keys().next().value);
    return legs;
  }

  async function masterLegsUncached(underlying, expiry) {
    const legs = [];
    let cursor;
    for (let page = 0; page < MASTER_MAX_PAGES; page += 1) {
      const q = { q: underlying, underlying, kind: "OPT", expiry, limit: MASTER_PAGE_LIMIT };
      const ex = derivExchangeHint(underlying);
      if (ex) q.exchange = ex;
      if (cursor) q.cursor = cursor;
      const res = await symbols.search(q);
      for (const r of res?.items ?? []) {
        if (r?.underlying === underlying && r.expiry === expiry && (r.right === "CE" || r.right === "PE") && r.strike > 0) {
          legs.push({ canonical: r.canonical, strike: r.strike, right: r.right, exchange: r.exchange, lotSize: r.lotSize ?? null, tickSize: r.tickSize ?? null });
        }
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return legs;
  }

  /** Exchange and lot size of an underlying's options, from the master when it is loaded. */
  async function chainMeta(underlying, expiry) {
    try {
      if (usable(symbols)) {
        const ex = derivExchangeHint(underlying);
        const res = await symbols.search({ q: underlying, underlying, kind: "OPT", expiry, limit: 1, ...(ex ? { exchange: ex } : {}) });
        const r = res?.items?.[0];
        if (r) return { exchange: r.exchange, lotSize: Number.isFinite(r.lotSize) ? r.lotSize : null };
      }
    } catch {
      // master not loaded: use the default exchange
    }
    return { exchange: defaultOptionExchange(underlying), lotSize: null };
  }

  /**
   * Contract facts for a chain, from the master only (no broker call): underlyingKind
   * from the master's spot row (INDEX vs EQ; else the reference universe), strikeStep inferred from the listed
   * strikes of the expiry, tickSize the largest option tick of the expiry. Memoised for 5 minutes per expiry.
   */
  const factsMemo = new Map();
  async function chainFacts(underlying, expiry) {
    const key = `${underlying}|${expiry}`;
    const hit = factsMemo.get(key);
    if (hit && now() - hit.at < 300_000) return hit.value;
    let kind = null;
    let legs = [];
    try {
      if (usable(symbols)) {
        legs = await masterLegs(underlying, expiry);
        const res = await symbols.search({ q: underlying, underlying, exchange: cashExchangeOf(underlying), limit: 5 });
        const spot = (res?.items ?? []).find((r) => r?.underlying === underlying && (r.kind === "INDEX" || r.kind === "EQ"));
        if (spot) kind = spot.kind === "INDEX" ? "index" : "stock";
      }
    } catch {
      // master not loaded: facts unknown
    }
    if (!kind && usable(reference) && typeof reference.universe === "function") {
      try {
        kind = reference.universe({ kind: "all" })?.items?.find((i) => i.symbol === underlying)?.kind ?? null;
      } catch {
        kind = null;
      }
    }
    const ticks = legs.map((l) => l.tickSize).filter((t) => Number.isFinite(t) && t > 0);
    const value = { underlyingKind: kind, settlement: settlementOfKind(kind), strikeStep: strikeStepOf(legs.map((l) => l.strike)), tickSize: ticks.length ? Math.max(...ticks) : null };
    factsMemo.set(key, { at: now(), value });
    if (factsMemo.size > 500) factsMemo.delete(factsMemo.keys().next().value);
    return value;
  }

  async function brokerChain({ underlying, expiry, greeks, pinned, priority, signal, stale, allowedAccounts, maxWaitMs, backgroundShare, purpose }) {
    const accountId = chooseAccount("optionChain", "chain", pinned, allowedAccounts, { purpose, maxWaitMs });
    if (!accountId) return null;
    const broker = brokerOf(accountId);
    const declaredRaw = adapterCaps(accountId).optionChain?.greeks;
    const declared = declaredRaw === "broker" || declaredRaw === "computed" ? declaredRaw : null;
    if (stale && budgetExhausted(accountId, "chain")) return { stale: true };
    const meta = await chainMeta(underlying, expiry);
    const res = await raceSignal(
      guardedBroker("chain", `${underlying}|${expiry}`)(
        { accountId, broker, endpointClass: "chain", priority, coalesceKey: `chain:${accountId}:${underlying}:${expiry}`, maxWaitMs: maxWaitMs ?? (stale ? cfg.stale.waitMs : undefined), backgroundShare },
        (adapter, creds) => adapter.fetchOptionChain(creds, underlying, expiry),
      ),
      signal,
    );
    const built = rowsFromBrokerChain(res, { underlying, expiry, exchange: meta.exchange, declared, greeks, nowMs: now(), rate: riskFreeRate(), oiUnit: oiUnitFor(broker, "chain"), lotSize: meta.lotSize });
    if (!built.rows.length) throw new BridgeError("SYMBOL_NOT_FOUND", `No options were found for ${underlying} expiring ${expiry}.`);
    return { value: { underlyingLtp: built.underlyingLtp, rows: built.rows, lotSize: meta.lotSize }, at: now(), accountId, broker, source: "broker" };
  }

  async function builtChain({ underlying, expiry, greeks, pinned, priority, targetMs, allowedAccounts, maxWaitMs, backgroundShare, purpose }) {
    const readExtra = { purpose, strict: STRICT_PURPOSES.has(purpose) };
    let legs = await masterLegs(underlying, expiry);
    if (!legs.length) throw new BridgeError("SYMBOL_NOT_FOUND", `No options were found for ${underlying} expiring ${expiry}.`);
    const spotRead = await readPrices("ltp", [spotSymbol(underlying)], { accountId: pinned, maxAgeMs: targetMs, priority, allowedAccounts, maxWaitMs, backgroundShare, ...readExtra });
    const spot = spotRead.items[0]?.ltp ?? null;
    if (legs.length > cfg.chain.maxBuiltLegs) {
      // Keep the strikes nearest the money so a built chain never floods the quote budget.
      const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
      const centre = spot ?? strikes[Math.floor(strikes.length / 2)];
      const keep = new Set([...strikes].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre)).slice(0, Math.floor(cfg.chain.maxBuiltLegs / 2)));
      legs = legs.filter((l) => keep.has(l.strike));
    }
    const read = await readPrices("quote", legs.map((l) => l.canonical), { accountId: pinned, maxAgeMs: targetMs, priority, allowedAccounts, maxWaitMs, backgroundShare, ...readExtra });
    if (!read.items.length && read.errors.length) {
      const first = read.errors[0];
      throw new BridgeError(first.code, first.message);
    }
    const quotes = new Map(read.items.map((i) => [i.symbol, i]));
    const built = rowsFromQuotes(legs, quotes, { spot, expiry, greeks, nowMs: now(), rate: riskFreeRate() });
    const fresh = [...read.items.map((i) => i.freshness), ...spotRead.items.map((i) => i.freshness)];
    const oldestAge = fresh.reduce((m, f) => Math.max(m, f.ageMs), 0);
    const sources = new Set(fresh.map((f) => f.source));
    const first = fresh.find((f) => f.accountId) ?? null;
    return {
      value: { underlyingLtp: built.underlyingLtp, rows: built.rows, lotSize: legs.find((l) => Number.isFinite(l.lotSize))?.lotSize ?? null },
      at: now() - oldestAge,
      accountId: first?.accountId ?? null,
      broker: first?.broker ?? null,
      source: sources.size === 1 ? [...sources][0] : "broker",
      anyStale: fresh.some((f) => f.stale),
    };
  }

  function chainResult(underlying, expiry, value, strikes, fresh, facts) {
    const atm = atmStrike(value.rows.map((r) => r.strike), value.underlyingLtp);
    return {
      underlying,
      expiry,
      underlyingLtp: value.underlyingLtp,
      atmStrike: atm,
      lotSize: value.lotSize ?? null,
      // Contract facts (additive; null when the master does not say)
      underlyingKind: facts?.underlyingKind ?? null,
      settlement: facts?.settlement ?? null,
      strikeStep: facts?.strikeStep ?? null,
      tickSize: facts?.tickSize ?? null,
      rows: trimStrikes(value.rows, atm, strikes),
      freshness: fresh,
    };
  }

  /** Option chain from a backup source (NSE website), Greeks computed locally. Not cached; rethrows `err` on failure. */
  async function backupChain(cand, underlying, p, greeks, targetMs, err, maxAgeMs, purpose) {
    let b;
    try {
      b = await viaSource(cand, () => backup.optionChain(underlying, p.expiry, { sourceId: cand.id, purpose }));
    } catch {
      throw err;
    }
    stats.backup += 1;
    const exchange = defaultOptionExchange(underlying);
    const spot = b.underlyingLtp ?? null;
    const rows = b.rows.map((r) => {
      const row = { strike: r.strike, ce: null, pe: null };
      for (const right of ["CE", "PE"]) {
        const raw = r[right.toLowerCase()];
        if (!raw) continue;
        const { symbol: _s, greeksSource: _g, ...fields } = raw;
        row[right.toLowerCase()] = finishLeg(fields, {
          symbol: legSymbol(exchange, underlying, p.expiry, r.strike, right),
          declared: null,
          greeks,
          spot,
          strike: r.strike,
          expiry: p.expiry,
          right,
          nowMs: now(),
          rate: riskFreeRate(),
        });
      }
      return row;
    });
    const value = { underlyingLtp: spot, rows, lotSize: null };
    return chainResult(underlying, p.expiry, value, p.strikes, sourceFreshness(cand, { at: b.at, provider: b.provider, targetMs, maxAgeMs }), await chainFacts(underlying, p.expiry));
  }

  /**
   * Black-76 repricing, once per chain value: every consumer of the same cached chain (several pages, the events
   * engine, the recorder) gets the same priced rows instead of solving 180 IVs each. Keyed by the rows array the
   * chain was built from (chainResult trims to new arrays, so the key is the cached rows plus the strike window).
   */
  const b76Memo = new WeakMap();
  function priceB76Memo(chain, rowsKey) {
    if (!rowsKey) return priceB76(chain);
    let byWindow = b76Memo.get(rowsKey);
    if (!byWindow) {
      byWindow = new Map();
      b76Memo.set(rowsKey, byWindow);
    }
    const k = `${chain.rows.length}|${chain.rows[0]?.strike ?? ""}`;
    const hit = byWindow.get(k);
    if (hit) return { ...hit, freshness: chain.freshness };
    const priced = priceB76(chain);
    byWindow.set(k, priced);
    return priced;
  }

  async function optionChain(params, opts) {
    const parsed = chainSchema.safeParse(params ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const model = parsed.data.ivModel ?? cfg.chain.ivModelDefault;
    const chain = await chainFor(params, opts);
    if (!(model === "b76-forward" && parsed.data.greeks !== false)) return chain;
    return priceB76Memo(chain, chainRowsKey.get(chain));
  }

  /** chain result -> the cached rows array it was cut from (for priceB76Memo). */
  const chainRowsKey = new WeakMap();

  /**
   * Stream-first chain (no broker call): when every leg in the requested strike window has a fresh tick from a live
   * stream subscription (a dashboard page, a strategy or the recorder subscribed them), the chain is the last broker
   * chain of the day with each leg's prices, OI and volume replaced by its tick. OI change is the tick's OI minus the
   * previous-day OI the broker chain implied. Greeks are recomputed for the new prices. Null when any leg, the spot or
   * the base chain is missing, so the caller falls back to the cache and the broker.
   */
  function streamChain({ underlying, expiry, strikes, greeks, pinned, targetMs }) {
    if (!cfg.streamFirst || !usable(streamHub) || !(strikes > 0)) return null;
    const base = cache.peek(`c|${underlying}|${expiry}|g`) ?? cache.peek(`c|${underlying}|${expiry}|n`);
    if (!base || (pinned && base.accountId !== pinned) || now() - base.at > STREAM_BASE_MAX_AGE_MS) return null;
    const spot = fromStream(spotSymbol(underlying), false, pinned, targetMs);
    if (!spot?.fields?.ltp) return null;
    const rows = base.value.rows;
    const atm = atmStrike(rows.map((r) => r.strike), spot.fields.ltp);
    if (atm === null) return null;
    const window = trimStrikes(rows, atm, strikes);
    const lotSize = base.value.lotSize ?? null;
    let oldest = spot.at;
    let quietLegs = 0;
    let quietOldest = null;
    const out = [];
    for (const row of window) {
      const next = { strike: row.strike, ce: null, pe: null };
      for (const side of ["ce", "pe"]) {
        const leg = row[side];
        if (!leg) continue;
        const s = fromStream(leg.symbol, true, pinned, targetMs) ?? quietFromStream(leg.symbol, pinned, targetMs);
        if (!s) return null;
        const unit = oiUnitFor(s.broker ?? base.broker, "stream");
        const tickOi = s.fields.oi ?? null;
        const oi = tickOi === null ? null : unit === "lots" ? (lotSize ? tickOi * lotSize : null) : tickOi;
        if (tickOi !== null && oi === null) return null;
        const prevOi = Number.isFinite(leg.oi) && Number.isFinite(leg.oiChange) ? leg.oi - leg.oiChange : null;
        const fields = {
          ...stripGreeks(leg),
          ltp: s.fields.ltp ?? leg.ltp ?? null,
          bid: s.fields.bid ?? leg.bid ?? null,
          ask: s.fields.ask ?? leg.ask ?? null,
          volume: s.fields.volume ?? leg.volume ?? null,
          close: s.fields.close ?? leg.close ?? null,
          change: s.fields.change ?? leg.change ?? null,
          oi: oi ?? leg.oi ?? null,
          oiChange: oi !== null && prevOi !== null ? oi - prevOi : leg.oiChange ?? null,
          iv: null,
          delta: null,
          gamma: null,
          theta: null,
          vega: null,
        };
        delete fields.symbol;
        delete fields.greeksSource;
        next[side] = finishLeg(fields, { symbol: leg.symbol, declared: null, greeks, spot: spot.fields.ltp, strike: row.strike, expiry, right: side.toUpperCase(), nowMs: now(), rate: riskFreeRate() });
        if (s.quiet) {
          // Its own label: the price is the last trade, this old. The chain's asOf stays that of the live legs.
          next[side].tickAgeMs = Math.max(0, Math.round(now() - s.at));
          quietLegs += 1;
          quietOldest = quietOldest === null ? s.at : Math.min(quietOldest, s.at);
        } else if (s.at < oldest) oldest = s.at;
      }
      out.push(next);
    }
    if (!out.length) return null;
    const quiet = quietLegs ? { legs: quietLegs, oldestTickAgeMs: Math.max(0, Math.round(now() - quietOldest)), maxAgeMs: cfg.quietLegMaxAgeMs } : null;
    return { value: { underlyingLtp: spot.fields.ltp, rows: out, lotSize }, at: oldest, accountId: spot.accountId ?? base.accountId, broker: spot.broker ?? base.broker, quiet };
  }

  /** In-flight background refreshes of stale-while-revalidate chain reads, by cache key. */
  const revalidating = new Map();

  const withoutGreeks = (leg) => (leg ? { ...stripGreeks(leg), greeksSource: null } : leg);

  async function chainFor(params, opts) {
    const parsed = chainSchema.safeParse(params ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const p = parsed.data;
    const o = readOpts(opts);
    const underlying = normaliseUnderlying(p.underlying);
    const greeks = p.greeks !== false;
    const pinned = o.accountId;
    checkPinned(pinned);
    const targetMs = o.maxAgeMs ?? cfg.freshness.chainMs;
    const facts = await chainFacts(underlying, p.expiry);
    const key = `c|${underlying}|${p.expiry}|${greeks ? "g" : "n"}`;
    let hit = freshEntry(key, targetMs, pinned);
    // A chain read with Greeks is a superset: a Greeks-off read reuses it (the Greeks stripped) at no broker cost.
    if (!hit && !greeks) {
      const g = freshEntry(`c|${underlying}|${p.expiry}|g`, targetMs, pinned);
      if (g) hit = { ...g, value: { ...g.value, rows: g.value.rows.map((r) => ({ ...r, ce: withoutGreeks(r.ce), pe: withoutGreeks(r.pe) })) } };
    }
    if (hit) {
      saving("cache");
      return keyed(chainResult(underlying, p.expiry, hit.value, p.strikes, freshness({ source: "cache", at: hit.at, now: now(), targetMs, accountId: hit.accountId, broker: hit.broker }), facts), hit.value.rows);
    }
    const live = streamChain({ underlying, expiry: p.expiry, strikes: p.strikes, greeks, pinned, targetMs });
    if (live) {
      saving("stream");
      const fresh = freshness({ source: "stream", at: live.at, now: now(), targetMs, accountId: live.accountId, broker: live.broker });
      if (live.quiet) fresh.quiet = live.quiet;
      return keyed(chainResult(underlying, p.expiry, live.value, p.strikes, fresh, facts), live.value.rows);
    }
    const stale = staleEntry(key, pinned, undefined, o);
    const serveStale = () => {
      stats.stale += 1;
      saving("cache");
      return chainResult(underlying, p.expiry, stale.value, p.strikes, freshness({ source: "cache", at: stale.at, now: now(), targetMs, stale: true, accountId: stale.accountId, broker: stale.broker }), facts);
    };
    const args = { underlying, expiry: p.expiry, greeks, pinned, priority: o.priority, signal: o.signal, stale: Boolean(stale), targetMs, allowedAccounts: o.allowedAccounts, maxWaitMs: o.maxWaitMs, backgroundShare: o.backgroundShare, purpose: o.purpose };
    if (stale && o.swr) {
      // Answer at once from the older chain (labelled), and refresh it for the next read; one refresh per chain.
      if (!revalidating.has(key)) {
        const job = fetchChainInto(key, { ...args, signal: undefined, stale: false })
          .catch(() => {})
          .finally(() => revalidating.delete(key));
        revalidating.set(key, job);
      }
      const out = serveStale();
      out.freshness.revalidating = true;
      return keyed(out, stale.value.rows);
    }
    let got = null;
    try {
      if (cfg.chain.source !== "built") {
        try {
          got = await brokerChain(args);
        } catch (err) {
          if (!(cfg.chain.source === "auto" && err?.code === "CAPABILITY_UNSUPPORTED")) throw err;
          got = null;
        }
        if (got?.stale) return serveStale();
        if (!got && cfg.chain.source === "broker") throw noAccountError("option chains", pinned);
      }
      if (!got) got = await raceSignal(builtChain(args), o.signal);
    } catch (err) {
      if (stale && isPressure(err)) return serveStale();
      const src = err?.name !== "AbortError" ? sourceAfter("optionChain", o, err) : null;
      if (src) return backupChain(src, underlying, p, greeks, targetMs, err, o.maxAgeMs, o.purpose);
      throw err;
    }
    cache.set(key, got.value, { at: got.at, accountId: got.accountId, broker: got.broker });
    const fresh = freshness({ source: got.source, at: got.at, now: now(), targetMs, accountId: got.accountId, broker: got.broker, ...(got.anyStale ? { stale: true } : {}) });
    return keyed(chainResult(underlying, p.expiry, got.value, p.strikes, fresh, facts), got.value.rows);
  }

  /** Remember which cached rows a chain result came from (for the Black-76 memo). */
  function keyed(result, rows) {
    if (rows && typeof rows === "object") chainRowsKey.set(result, rows);
    return result;
  }

  /** The broker (or built) chain for `args`, stored in the cache under `key`: a stale-while-revalidate refresh. */
  async function fetchChainInto(key, args) {
    let got = null;
    if (cfg.chain.source !== "built") {
      try {
        got = await brokerChain(args);
      } catch (err) {
        if (!(cfg.chain.source === "auto" && err?.code === "CAPABILITY_UNSUPPORTED")) throw err;
      }
    }
    if (!got && cfg.chain.source !== "broker") got = await builtChain(args);
    if (got && !got.stale) cache.set(key, got.value, { at: got.at, accountId: got.accountId, broker: got.broker });
  }

  // ── the service ──

  return {
    /**
     * Last traded prices. Stream first, then cache, then a batched broker call.
     * @param {string[]} list up to 200, any accepted symbol form
     * @param {import("../core/contracts.mjs").ReadOptions} [opts]
     */
    async ltp(list, opts) {
      checkSymbolList(list);
      const o = readOpts(opts);
      return raceSignal(readPrices("ltp", list, o), o.signal);
    },
    /**
     * Full quotes. Stream ticks are used only when they carry quote-mode data.
     * @param {string[]} list up to 200
     * @param {import("../core/contracts.mjs").ReadOptions} [opts]
     */
    async quotes(list, opts) {
      checkSymbolList(list);
      const o = readOpts(opts);
      return raceSignal(readPrices("quote", list, o), o.signal);
    },
    depth,
    history,
    expiries,
    optionChain,

    // ── non-contract extras (diagnostics, tests, module stop) ──
    /** Local counters: stream/cache/stale hits, coalesced and batched savings, broker calls made. */
    stats: () => ({ ...stats, cacheEntries: cache.size }),
    /** The freshness cache (tests). */
    cache,
    /** Routing parts shared with the trace route and the sources management API. */
    sourceRouter: router,
    sourceHealth: health,
    failureCache: failCache,
    /** Flush any open batch (shutdown). */
    close() {
      batcher.flushAll();
    },
  };
}
