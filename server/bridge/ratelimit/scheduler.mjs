/**
 * Scheduler (rate-limit engine). Contract: SERVICE_CONTRACTS.scheduler in ../core/contracts.mjs.
 *
 * Every broker call in the Bridge goes through schedule(). For each account the scheduler keeps:
 *  - one multi-window limiter per endpoint class and one per broker GROUP (a budget several classes share), built
 *    from the effective policy (policy.mjs over brokerPolicies.mjs, lowered by the `ratelimit` config). A call needs
 *    room in its class bucket and in every group bucket that lists its class (tokenBucket.mjs);
 *  - a priority queue (priorityQueue.mjs): order > live > interactive > background, with ageing. A request that
 *    cannot run RESERVES its buckets for the rest of that dispatch pass, so lower-priority work on the same buckets
 *    waits behind it while work on other buckets still flows;
 *  - fairness (priorityQueue.mjs): inside a lane, consumers (API keys) share the budget by weight with start-time fair
 *    queueing; a consumer may have at most queue.maxQueuedPerConsumer (200) requests waiting and, while others wait
 *    too, ceil(maxInFlightPerAccount / 2) calls in flight. The admission estimate counts only the work that would
 *    really run before the new request, so a flood does not make a well-behaved consumer look blocked, and a full
 *    queue drops the newest request of the biggest consumer instead of refusing everyone;
 *  - upstream back-off, per POOL: a broker 429 / UPSTREAM_RATE_LIMIT pauses every class of that account that shares
 *    a budget with the throttled class (a group bucket's classes together), honouring Retry-After, else 1 s, 2 s,
 *    4 s ... up to backoff.maxMs, plus 0 to 250 ms of jitter (never before Retry-After). Throttled calls are never
 *    retried here (an order must never be resent blindly, and some brokers block the user for the day after
 *    repeated breaches);
 *  - adaptive budget (AIMD): each pool has a scale below the policy ceiling. A throttle episode (the 429s of one
 *    back-off window count once) halves it (floor 0.25); every clean 60 s with traffic adds 0.05; three episodes in
 *    an hour cap it at 0.8 x its value before the last drop for 24 h (the policy figure is probably too high; a
 *    warning says so). The scale only ever lowers the limits (tokenBucket.mjs setScale), in memory only;
 *  - health: a session error from a scheduled call emits "account.session_rejected" and keeps the account out of
 *    pooled routing until AccountManager reports it connected again.
 *
 * Identical in-flight reads share one call (singleflight by coalesceKey; orders are never coalesced). Waiting
 * requests leave the queue when their AbortSignal fires; a shared call is withdrawn only when every waiter has gone.
 * A request that cannot start before its deadline (queue.maxWaitMs per priority, or the caller's maxWaitMs) is
 * refused with UPSTREAM_RATE_LIMITED and a retryAfterMs, up front when the estimate already says so.
 *
 * Time comes from deps.clock.now(); timers from deps.clock.setTimeout/clearTimeout when the clock provides them
 * (the fake clock in fake.mjs does), else the global timers (unref'd). Nothing here sleeps.
 *
 * Non-contract extras (used by this module's own routes, by tests and by module stop()): recordSaving, clientBudget,
 * accountPolicy, stop, headroomWindows (read by backgroundGate.mjs). Other modules call only the contract methods; market reports savings through the exported
 * recordSaving() helper below.
 */
import { ENDPOINT_CLASSES, PRIORITIES } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createClientLimiter } from "./clientLimiter.mjs";
import { DEFAULT_MAX_QUEUED_PER_CONSUMER, parseRatelimitConfig } from "./config.mjs";
import { bucketPlan, resolvePolicy } from "./policy.mjs";
import { MAX_BACKGROUND_SHARE } from "./backgroundGate.mjs";
import { BROKER_POLICIES } from "./brokerPolicies.mjs";
import { PRIORITY_RANK, createPriorityQueue } from "./priorityQueue.mjs";
import { currentConsumer, currentConsumerInfo } from "./consumer.mjs";
import { createQuotaStore } from "./quotaStore.mjs";
import { createRateLimiter, istDay, nextIstMidnight, toIstIso } from "./tokenBucket.mjs";

const SESSION_CODES = new Set(["SESSION_LOGIN_REQUIRED", "UPSTREAM_AUTH", "SESSION_EXPIRED"]);
const THROTTLE_CODES = new Set(["UPSTREAM_RATE_LIMIT", "UPSTREAM_RATE_LIMITED"]);
const UNHEALTHY_STATES = new Set(["expired", "missing", "error"]);
const MAX_COST = 10_000;
const MAX_CALLER_WAIT_MS = 3_600_000;
const MAX_RETRY_AFTER_MS = 3_600_000;
/** Back-off jitter: 0 to this many ms are added to every pause (never subtracted). */
const BACKOFF_JITTER_MS = 250;
/** AIMD: multiplicative decrease, floor, additive step per clean minute, freeze rule. */
const AIMD = Object.freeze({ decrease: 0.5, floor: 0.25, step: 0.05, periodMs: 60_000, episodesToFreeze: 3, episodeWindowMs: 3_600_000, freezeFactor: 0.8, freezeMs: 86_400_000 });
/** Seconds of per-second call history kept per account (usage({ series: true }), the Sources page chart). */
export const SERIES_SECONDS = 120;
/** Distinct consumer names kept per day; later ones are counted under "Other". */
const MAX_CONSUMERS = 200;

/** Savings kinds accepted by recordSaving (short alias -> report field). */
export const SAVING_KINDS = Object.freeze({
  stream: "servedFromStream",
  servedFromStream: "servedFromStream",
  cache: "servedFromCache",
  servedFromCache: "servedFromCache",
  coalesced: "coalesced",
  batched: "batched",
});

/** True for errors that mean the broker session is gone (log in again). */
export function isSessionError(err) {
  if (!err) return false;
  if (err.name === "SessionRequiredError") return true;
  return SESSION_CODES.has(err.code) || SESSION_CODES.has(err.broker?.code);
}

/** True for errors that mean the broker throttled us. */
export function isThrottleError(err) {
  if (!err) return false;
  if (THROTTLE_CODES.has(err.code) || THROTTLE_CODES.has(err.broker?.code)) return true;
  return err.statusCode === 429 || err.status === 429 || err.httpStatus === 429;
}

/** Retry-After carried by an error, in ms (retryAfterMs, or retryAfter in seconds), else undefined. */
export function retryAfterFrom(err) {
  const ms = Number(err?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  const s = Number(err?.retryAfter);
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
  return undefined;
}

/** The scheduler that recordSaving() reports to: the most recently created one that has not been stopped. */
let current = null;

/**
 * Report a broker call avoided by streaming, caching, coalescing or batching (market calls this). Never throws.
 * @param {"stream"|"cache"|"coalesced"|"batched"|"servedFromStream"|"servedFromCache"} kind
 * @param {number} [count]
 */
export function recordSaving(kind, count = 1) {
  current?.recordSaving(kind, count);
}

const finiteOrNull = (n) => (Number.isFinite(n) ? n : null);

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

const secondsText = (ms) => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s === 1 ? "1 second" : `${s} seconds`;
};

/**
 * @param {object} deps  Core deps (config, logger, bus, clock) plus `accounts`.
 * @param {{ policies?: Readonly<Record<string, object>> }} [options]  policies: raw policy table (tests).
 * @returns {object} Scheduler
 */
export function createScheduler(deps, options = {}) {
  const { config, bus, clock } = deps;
  /** 0 <= random() < 1; tests pass a fixed one so back-off delays are exact. */
  const random = typeof options.random === "function" ? options.random : Math.random;
  const log = deps.logger?.child ? deps.logger.child({ module: "ratelimit" }) : deps.logger;
  const accounts = deps.accounts;
  const table = options.policies ?? BROKER_POLICIES;
  const rl = parseRatelimitConfig(config?.ratelimit);
  const now = () => clock.now();
  const setT = typeof clock.setTimeout === "function" ? (fn, ms) => clock.setTimeout(fn, ms) : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof clock.clearTimeout === "function" ? (h) => clock.clearTimeout(h) : (h) => clearTimeout(h);

  /** @type {Map<string, any>} accountId -> account state */
  const states = new Map();
  /** @type {Map<string, any>} coalesceKey -> shared call */
  const inflight = new Map();
  /** @type {Map<string, any>} brokerId -> effective policy (broker-level overrides only) */
  const policyCache = new Map();
  const quotas = options.quotas ?? createQuotaStore({ dir: typeof config?.dataDir === "string" ? config.dataDir : null, config: rl.client, logger: log });
  const client = createClientLimiter(rl.client, clock, { quotas });
  const maxQueuedPerConsumer = rl.queue.maxQueuedPerConsumer ?? DEFAULT_MAX_QUEUED_PER_CONSUMER;
  const maxInFlightPerConsumer = rl.maxInFlightPerConsumer ?? Math.max(1, Math.ceil(rl.maxInFlightPerAccount / 2));
  const savings = { day: istDay(now()), servedFromStream: 0, servedFromCache: 0, coalesced: 0, batched: 0 };
  /** consumer name -> { calls, saved } for the IST day in `savings.day` */
  const consumers = new Map();
  let timer = null;
  let timerAt = Infinity;
  /** When a non-background read or an order was last scheduled (userActiveAt). */
  let lastUserAt = -Infinity;
  let stopped = false;
  const offs = [];

  // ── Accounts and policies ──

  function brokerOf(accountId) {
    try {
      return accounts.get(accountId).broker;
    } catch (err) {
      // AccountManager not built yet (stub): treat as an unknown broker, which gets the conservative defaults.
      if (err?.code === "NOT_IMPLEMENTED") return "unknown";
      throw err;
    }
  }

  /**
   * Pools: the classes of an account that share a budget (a group bucket lists them together) form one pool. They
   * pause together after a 429 and share one AIMD scale. A class with no budget of its own is a pool by itself.
   * @returns {{ comps: any[], compOf: Map<string, any> }}
   */
  function buildPools(plan, t) {
    const parent = new Map(ENDPOINT_CLASSES.map((c) => [c, c]));
    const find = (c) => {
      while (parent.get(c) !== c) {
        parent.set(c, parent.get(parent.get(c)));
        c = parent.get(c);
      }
      return c;
    };
    for (const b of plan) {
      if (!b.key.startsWith("group:")) continue;
      for (const c of b.classes.slice(1)) parent.set(find(c), find(b.classes[0]));
    }
    const byRoot = new Map();
    for (const c of ENDPOINT_CLASSES) {
      const root = find(c);
      if (!byRoot.has(root)) byRoot.set(root, { name: null, classes: [], bucketKeys: [], groups: [] });
      byRoot.get(root).classes.push(c);
    }
    for (const b of plan) {
      const comp = byRoot.get(find(b.classes[0]));
      comp.bucketKeys.push(b.key);
      if (b.key.startsWith("group:")) comp.groups.push(b.key.slice(6));
    }
    const comps = [];
    const compOf = new Map();
    for (const comp of byRoot.values()) {
      comp.name = comp.groups.length ? comp.groups.join("+") : comp.classes[0];
      Object.assign(comp, { scale: 1, ceiling: 1, ceilingUntil: 0, episodes: [], backoffUntil: 0, streak: 0, periodStart: t, periodHadCalls: false });
      comps.push(comp);
      for (const c of comp.classes) compOf.set(c, comp);
    }
    return { comps, compOf };
  }

  function newClassStats() {
    return { calls: 0, units: 0, coalesced: 0, errors: 0, throttled: 0, rejected: 0 };
  }

  function stateFor(accountId) {
    let st = states.get(accountId);
    if (st) return st;
    const broker = brokerOf(accountId);
    const policy = resolvePolicy(broker, { broker: rl.brokers[broker], account: rl.accounts[accountId] }, table);
    const plan = bucketPlan(policy);
    const buckets = new Map();
    /** @type {Map<string, Array<{ key: string, lim: import("./tokenBucket.mjs").RateLimiter }>>} */
    const classLimiters = new Map(ENDPOINT_CLASSES.map((c) => [c, []]));
    for (const b of plan) {
      const lim = createRateLimiter(b.windows, { paddingMs: rl.windowPaddingMs });
      buckets.set(b.key, lim);
      for (const c of b.classes) classLimiters.get(c).push({ key: b.key, lim });
    }
    const { comps, compOf } = buildPools(plan, now());
    st = {
      accountId,
      broker,
      policy,
      buckets,
      classLimiters,
      /** pools: classes that share a budget back off and scale together */
      comps,
      compOf,
      /** fairKey -> { label, weight, queued, inFlight } for consumers with work waiting or running on this account */
      cons: new Map(),
      queue: createPriorityQueue({ ageingMs: rl.queue.ageingMs }),
      /** bucket key -> queued units per priority rank (for wait estimates) */
      bucketQueued: new Map([...buckets.keys()].map((k) => [k, PRIORITIES.map(() => 0)])),
      queuedByClass: new Map(ENDPOINT_CLASSES.map((c) => [c, 0])),
      inFlight: 0,
      inFlightReads: 0,
      backoff: new Map(),
      sessionRejected: false,
      statsDay: istDay(now()),
      stats: new Map(ENDPOINT_CLASSES.map((c) => [c, newClassStats()])),
      /** per-second call counts: slot = epoch second % SERIES_SECONDS -> { sec, counts[class index] } */
      series: Array.from({ length: SERIES_SECONDS }, () => ({ sec: -1, counts: new Array(ENDPOINT_CLASSES.length).fill(0) })),
    };
    states.set(accountId, st);
    return st;
  }

  function stats(st, cls) {
    const d = istDay(now());
    if (d !== st.statsDay) {
      st.statsDay = d;
      for (const c of ENDPOINT_CLASSES) st.stats.set(c, newClassStats());
    }
    return st.stats.get(cls);
  }

  const CLASS_INDEX = new Map(ENDPOINT_CLASSES.map((c, i) => [c, i]));

  /** Count `units` broker calls of class `cls` in the account's per-second history. */
  function noteSeries(st, cls, units, t) {
    const sec = Math.floor(t / 1000);
    const slot = st.series[sec % SERIES_SECONDS];
    if (slot.sec !== sec) {
      slot.sec = sec;
      slot.counts.fill(0);
    }
    slot.counts[CLASS_INDEX.get(cls)] += units;
  }

  function consumerRow(name) {
    rollSavings();
    let key = name ?? "Other";
    if (!consumers.has(key) && consumers.size >= MAX_CONSUMERS) key = "Other";
    let row = consumers.get(key);
    if (!row) {
      row = { calls: 0, saved: 0 };
      consumers.set(key, row);
    }
    return row;
  }

  /** Credit one started broker call to its consumer and the per-second history. */
  function noteCall(st, cls, units, consumer, t) {
    noteSeries(st, cls, units, t);
    consumerRow(consumer).calls += units;
  }

  function policyFor(brokerId) {
    if (typeof brokerId !== "string" || !brokerId) throw new TypeError("policyFor() needs a broker id");
    let p = policyCache.get(brokerId);
    if (!p) {
      p = resolvePolicy(brokerId, { broker: rl.brokers[brokerId] }, table);
      policyCache.set(brokerId, p);
    }
    return p;
  }

  function healthy(st) {
    if (st.sessionRejected) return false;
    try {
      const s = accounts.status(st.accountId);
      if (s && UNHEALTHY_STATES.has(s.state)) return false;
    } catch {
      // status unknown (stub or removed account): rely on our own view
    }
    return true;
  }

  if (bus?.on) {
    offs.push(
      bus.on("account.status", (p) => {
        const st = states.get(p?.accountId);
        if (!st) return;
        if (p.session === "connected") {
          st.sessionRejected = false;
          queueMicrotask(() => dispatch(st));
        } else if (UNHEALTHY_STATES.has(p.session)) st.sessionRejected = true;
      }),
    );
  }

  // ── Validation ──

  function checkClass(endpointClass) {
    if (!ENDPOINT_CLASSES.includes(endpointClass)) throw new TypeError(`Unknown endpoint class "${endpointClass}". Use one of: ${ENDPOINT_CLASSES.join(", ")}.`);
  }

  function checkAccountId(accountId) {
    if (typeof accountId !== "string" || !accountId) throw new TypeError("An accountId is required.");
  }

  /** Orders always get "order"; nothing else may claim it (it is capped at "live"). Default "interactive". */
  function normalisePriority(cls, p) {
    if (cls === "order") return "order";
    if (p == null) return "interactive";
    if (!PRIORITIES.includes(p)) throw new TypeError(`Unknown priority "${p}". Use one of: ${PRIORITIES.join(", ")}.`);
    return p === "order" ? "live" : p;
  }

  /** backgroundShare for a floored background call: null when not given, else clamped to 0 .. MAX_BACKGROUND_SHARE. */
  function normaliseShare(share, priority) {
    if (share == null) return null;
    const n = Number(share);
    if (Number.isNaN(n)) throw new TypeError("backgroundShare must be a number from 0 to 0.5.");
    if (priority !== "background") throw new TypeError('backgroundShare is only for priority "background".');
    return Math.min(Math.max(n, 0), MAX_BACKGROUND_SHARE);
  }

  function normaliseCost(cost) {
    if (cost == null) return 1;
    const n = Math.ceil(Number(cost));
    if (!Number.isFinite(n) || n < 1 || n > MAX_COST) throw new TypeError(`cost must be a whole number from 1 to ${MAX_COST}.`);
    return n;
  }

  // ── Adaptive budget (AIMD) ──

  const round6 = (x) => Math.round(x * 1e6) / 1e6;

  function applyScale(st, comp) {
    for (const key of comp.bucketKeys) st.buckets.get(key)?.setScale(comp.scale);
  }

  /** Additive increase: +step for the clean minute that had traffic. Lazy: runs whenever the pool is looked at. */
  function syncScale(st, comp, t) {
    if (comp.ceilingUntil && t >= comp.ceilingUntil) {
      comp.ceiling = 1;
      comp.ceilingUntil = 0;
    }
    if (comp.scale >= comp.ceiling) {
      comp.periodStart = Math.max(comp.periodStart, t);
      comp.periodHadCalls = false;
      return;
    }
    const periods = Math.floor((t - comp.periodStart) / AIMD.periodMs);
    if (periods <= 0) return;
    // Only the first elapsed minute can have seen traffic: a later one would have synced when its call started.
    const gain = comp.periodHadCalls ? AIMD.step : 0;
    comp.periodStart += periods * AIMD.periodMs;
    comp.periodHadCalls = false;
    if (gain > 0) {
      comp.scale = round6(Math.min(comp.ceiling, comp.scale + gain));
      applyScale(st, comp);
    }
  }

  function syncAll(st, t) {
    for (const comp of st.comps) if (comp.scale < comp.ceiling || comp.ceilingUntil) syncScale(st, comp, t);
  }

  /** Multiplicative decrease, once per throttle episode. */
  function decreaseScale(st, comp, t, pauseMs) {
    syncScale(st, comp, t);
    const before = comp.scale;
    comp.scale = round6(Math.max(AIMD.floor, comp.scale * AIMD.decrease));
    comp.episodes = comp.episodes.filter((e) => t - e < AIMD.episodeWindowMs);
    comp.episodes.push(t);
    if (comp.episodes.length >= AIMD.episodesToFreeze) {
      comp.ceiling = round6(Math.max(AIMD.floor, AIMD.freezeFactor * before));
      comp.ceilingUntil = t + AIMD.freezeMs;
      comp.scale = Math.min(comp.scale, comp.ceiling);
      log?.warn?.("the broker throttled this pool three times within an hour; its limit in the policy table looks too high. Lower it in ratelimit.brokers or ratelimit.accounts", {
        accountId: st.accountId,
        broker: st.broker,
        pool: comp.name,
        ceiling: comp.ceiling,
      });
    }
    comp.periodStart = t + pauseMs;
    comp.periodHadCalls = false;
    applyScale(st, comp);
  }

  // ── Budget helpers ──

  function backoffRemaining(st, cls, t) {
    const b = st.backoff.get(cls);
    return b ? Math.max(0, b.until - t) : 0;
  }

  function limitersOf(st, cls) {
    return st.classLimiters.get(cls);
  }

  /** ms until a request of `cost` could start on its buckets, ignoring the queue. */
  function budgetWait(st, cls, cost, t) {
    let wait = backoffRemaining(st, cls, t);
    for (const { lim } of limitersOf(st, cls)) {
      const w = lim.waitMs(cost, t);
      wait = Math.max(wait, Number.isFinite(w) ? w : nextIstMidnight(t) - t);
    }
    return wait;
  }

  /**
   * Estimated start time for a new request, counting the queued work that would really run before it on the same
   * buckets: everything in the lanes above its own, and in its own lane the items of its consumer and the items of
   * other consumers that the fair queue serves first (start tag at or below the new request's). Another consumer's
   * deeper backlog is not counted, so a flood does not make a well-behaved consumer look blocked.
   */
  function estimateStart(st, cls, priority, cost, t, fairKey = "") {
    let wait = backoffRemaining(st, cls, t);
    const rank = PRIORITY_RANK[priority];
    const lims = limitersOf(st, cls);
    /** queued units ahead in the same lane, by endpoint class */
    const sameLane = new Map();
    if (lims.length) {
      st.queue.aheadUnits(priority, fairKey, (c, units) => sameLane.set(c, (sameLane.get(c) ?? 0) + units));
    }
    for (const { key, lim } of lims) {
      const queued = st.bucketQueued.get(key);
      let ahead = 0;
      for (let r = 0; r < rank; r++) ahead += queued[r];
      for (const [c, units] of sameLane) if (limitersOf(st, c).some((l) => l.key === key)) ahead += units;
      const cap = lim.capacity();
      const w = lim.waitMs(Math.min(ahead + Math.min(cost, cap), cap), t);
      const base = Number.isFinite(w) ? w : nextIstMidnight(t) - t;
      // waitMs covers what fits in the current windows; anything beyond drains at the sustained rate.
      const rate = lim.unitsPerMs();
      const overflow = Math.max(0, ahead + cost - cap);
      wait = Math.max(wait, Number.isFinite(rate) && rate > 0 ? base + overflow / rate : base);
    }
    return t + wait;
  }

  /**
   * Floor for a background call scheduled with backgroundShare: starting it must leave every window it
   * takes from at or above ceil((1 − share) × limit). Checked where the budget is taken, so several callers that passed
   * the gate in the same tick, or user work queued ahead, can never push a window below the floor.
   * @returns {number} 0 when the call may start now; else ms until it is worth looking again.
   */
  function floorWait(st, sh, t) {
    if (sh.floorShare == null) return 0;
    let wait = 0;
    for (const { lim } of limitersOf(st, sh.endpointClass)) {
      for (const w of lim.windows(t)) {
        if (!Number.isFinite(w.limit)) continue;
        const floor = Math.ceil((1 - sh.floorShare) * w.limit);
        if (w.limit - w.used - sh.cost >= floor) continue;
        wait = Math.max(wait, w.resetMs > 0 ? w.resetMs : 1000);
      }
    }
    return wait;
  }

  function headroomOf(st, cls, t) {
    const lims = limitersOf(st, cls);
    if (!lims.length) return { remaining: Infinity, limit: Infinity, resetMs: 0, used: 0, window: "none" };
    let best = null;
    for (const { lim } of lims) {
      const h = lim.headroom(t);
      if (!best || h.remaining < best.remaining || (h.remaining === best.remaining && h.remaining / h.limit < best.remaining / best.limit)) best = h;
    }
    const bo = backoffRemaining(st, cls, t);
    if (bo > 0) return { ...best, remaining: 0, resetMs: Math.max(best.resetMs, bo) };
    return best;
  }

  // ── Queue bookkeeping ──

  function trackQueued(st, sh, sign, served = false) {
    const rank = PRIORITY_RANK[sh.priority];
    for (const { key } of limitersOf(st, sh.endpointClass)) st.bucketQueued.get(key)[rank] += sign * sh.cost;
    st.queuedByClass.set(sh.endpointClass, st.queuedByClass.get(sh.endpointClass) + sign);
    consumerRowFor(st, sh).queued += sign;
    // A served call becomes in flight a moment later (start): keep its consumer's row rather than drop and rebuild it.
    if (!served) dropIdleConsumer(st, sh.fairKey);
  }

  /** The consumer's row on this account (created on demand). */
  function consumerRowFor(st, sh) {
    let row = st.cons.get(sh.fairKey);
    if (!row) {
      row = { label: sh.label, weight: sh.weight, kind: sh.clientKind, queued: 0, inFlight: 0 };
      st.cons.set(sh.fairKey, row);
    }
    return row;
  }

  function dropIdleConsumer(st, fairKey) {
    const row = st.cons.get(fairKey);
    if (row && row.queued <= 0 && row.inFlight <= 0) st.cons.delete(fairKey);
  }

  /** Take a waiting call out of the queue. `served` when it is about to start (advances the lane's virtual time). */
  function dequeue(st, sh, served = false) {
    if (sh.item && st.queue.remove(sh.item, { served })) trackQueued(st, sh, -1, served);
  }

  function settle(sh, ok, value) {
    if (sh.settled) return;
    sh.settled = true;
    if (sh.key && inflight.get(sh.key) === sh) inflight.delete(sh.key);
    if (ok) sh.resolve(value);
    else sh.reject(value);
  }

  /** The budget that said no, as the refusal's `limit`: the back-off when it is what blocks, else the binding window. */
  function upstreamLimit(st, cls, t) {
    const h = headroomOf(st, cls, t);
    const bo = backoffRemaining(st, cls, t);
    if (bo > 0 && bo >= h.resetMs) return { name: `${st.accountId}:${cls}:backoff`, remaining: 0, resetMs: Math.ceil(bo) };
    return { name: `${st.accountId}:${cls}:${h.window}`, remaining: Number.isFinite(h.remaining) ? Math.max(0, h.remaining) : 0, resetMs: Math.ceil(h.resetMs) };
  }

  /**
   * Refuse a request. scope "upstream" (the shared broker budget cannot serve it in time) and "queue" (the shared queue
   * is full) are UPSTREAM_RATE_LIMITED; "consumer-cap" (this consumer has too many requests waiting) is RATE_LIMITED:
   * it is the caller's own cap. Every refusal carries scope, retryAfterMs and the limit that said no.
   */
  function refuse(st, sh, retryAfterMs, why, scope = "upstream") {
    const retry = Math.max(1, Math.ceil(retryAfterMs));
    const t = now();
    stats(st, sh.endpointClass).rejected += 1;
    let limit;
    if (scope === "consumer-cap") limit = { name: `${st.accountId}:consumer-queue`, remaining: 0, resetMs: retry };
    else if (scope === "queue") limit = { name: `${st.accountId}:queue`, remaining: Math.max(0, rl.queue.maxQueuedPerAccount - st.queue.size), resetMs: retry };
    else limit = upstreamLimit(st, sh.endpointClass, t);
    const detail =
      scope === "consumer-cap"
        ? `This client already has ${maxQueuedPerConsumer} requests waiting for the ${st.broker} ${sh.endpointClass} budget of account ${st.accountId} ${why}. Try again in ${secondsText(retry)}.`
        : `The ${st.broker} ${sh.endpointClass} budget for account ${st.accountId} is fully used ${why}. Try again in ${secondsText(retry)}.`;
    const err = new BridgeError(scope === "consumer-cap" ? "RATE_LIMITED" : "UPSTREAM_RATE_LIMITED", detail, { retryAfterMs: retry, scope, limit });
    bus?.emit("limits.throttled", { accountId: st.accountId, endpointClass: sh.endpointClass, retryAfterMs: retry, upstream: false });
    settle(sh, false, err);
  }

  // ── Timer ──

  function wakeAt(at) {
    if (stopped || !Number.isFinite(at)) return;
    if (timer && at >= timerAt) return;
    if (timer) clearT(timer);
    timerAt = at;
    timer = setT(onTimer, Math.max(0, at - now()));
    timer?.unref?.();
  }

  function onTimer() {
    timer = null;
    timerAt = Infinity;
    for (const st of states.values()) if (st.queue.size) dispatch(st);
  }

  // ── Dispatch ──

  /**
   * How many calls one consumer may have in flight while others have work on the account: half the slots
   * (maxInFlightPerConsumer), or its weighted share of the slots when that is more, so a heavily weighted consumer
   * (the dashboard) is never held below the share the fair queue gives it. The account total still caps everything.
   */
  function inFlightCap(st, fairKey) {
    const row = st.cons.get(fairKey);
    let total = 0;
    for (const r of st.cons.values()) total += r.weight;
    const share = row && total > 0 ? Math.ceil((rl.maxInFlightPerAccount * row.weight) / total) : 0;
    return Math.min(rl.maxInFlightPerAccount, Math.max(maxInFlightPerConsumer, share));
  }

  function dispatch(st) {
    if (stopped || st.queue.size === 0) return;
    const t = now();
    syncAll(st, t);
    const reserved = new Set();
    let readsBlocked = st.inFlightReads >= rl.maxInFlightPerAccount;
    let nextWake = Infinity;
    for (const item of st.queue.iterate(t)) {
      const sh = item.value;
      if (t >= sh.deadline) {
        dequeue(st, sh);
        refuse(st, sh, budgetWait(st, sh.endpointClass, sh.cost, t), `and this request waited ${secondsText(t - item.enqueuedAt)}`);
        continue;
      }
      nextWake = Math.min(nextWake, sh.deadline);
      const isOrder = sh.endpointClass === "order";
      if (!isOrder && readsBlocked) continue;
      // While other consumers have work here, one consumer may hold at most its in-flight cap (see inFlightCap).
      if (!isOrder && sh.fairKey !== "" && st.cons.size > 1 && (st.cons.get(sh.fairKey)?.inFlight ?? 0) >= inFlightCap(st, sh.fairKey)) continue;
      const lims = limitersOf(st, sh.endpointClass);
      if (lims.some((l) => reserved.has(l.key))) continue;
      const bo = backoffRemaining(st, sh.endpointClass, t);
      if (bo > 0) {
        nextWake = Math.min(nextWake, t + bo);
        continue;
      }
      if (lims.every((l) => l.lim.canTake(sh.cost, t))) {
        const fw = floorWait(st, sh, t);
        if (fw > 0) {
          // Held back to keep the background floor; it reserves nothing, so other work on these buckets still runs.
          nextWake = Math.min(nextWake, t + Math.max(1, fw));
          continue;
        }
        dequeue(st, sh, true);
        start(st, sh, t);
        if (!isOrder) readsBlocked = st.inFlightReads >= rl.maxInFlightPerAccount;
        continue;
      }
      for (const l of lims) reserved.add(l.key);
      nextWake = Math.min(nextWake, t + Math.max(1, budgetWait(st, sh.endpointClass, sh.cost, t)));
    }
    if (st.queue.size) wakeAt(nextWake);
  }

  function start(st, sh, t) {
    for (const { lim } of limitersOf(st, sh.endpointClass)) lim.take(sh.cost, t);
    sh.started = true;
    st.inFlight += 1;
    const isOrder = sh.endpointClass === "order";
    if (!isOrder) st.inFlightReads += 1;
    const row = consumerRowFor(st, sh);
    row.inFlight += 1;
    const comp = st.compOf.get(sh.endpointClass);
    syncScale(st, comp, t);
    comp.periodHadCalls = true;
    const s = stats(st, sh.endpointClass);
    s.calls += 1;
    s.units += sh.cost;
    noteCall(st, sh.endpointClass, sh.cost, sh.consumer, t);
    // Run on a microtask so fn never re-enters dispatch() while the queue is being walked.
    Promise.resolve()
      .then(() => sh.fn({ signal: sh.controller.signal, accountId: st.accountId, endpointClass: sh.endpointClass }))
      .then(
        (value) => {
          // A call that started before the pause and ends during it says nothing about the budget being healthy again.
          if (backoffRemaining(st, sh.endpointClass, now()) === 0) comp.streak = 0;
          settle(sh, true, value);
        },
        (err) => {
          stats(st, sh.endpointClass).errors += 1;
          if (isSessionError(err)) {
            st.sessionRejected = true;
            const code = typeof err?.code === "string" ? err.code : "SESSION_EXPIRED";
            log?.warn?.("broker session rejected a scheduled call", { accountId: st.accountId, broker: st.broker, code });
            bus?.emit("account.session_rejected", { accountId: st.accountId, broker: st.broker, code });
          } else if (isThrottleError(err)) {
            noteUpstreamThrottle(st.accountId, sh.endpointClass, retryAfterFrom(err));
          }
          settle(sh, false, err);
        },
      )
      .finally(() => {
        st.inFlight -= 1;
        if (!isOrder) st.inFlightReads -= 1;
        row.inFlight -= 1;
        dropIdleConsumer(st, sh.fairKey);
        dispatch(st);
      });
  }

  /** The consumer holding the most queued requests on this account (never `except`), or null. */
  function heaviestConsumer(st, except, evictableOnly) {
    let best = null;
    for (const [key, row] of st.cons) {
      if (key === except || row.queued <= 0) continue;
      if (evictableOnly && !st.queue.newestOf(key)) continue;
      if (!best || row.queued > best.row.queued) best = { key, row };
    }
    return best;
  }

  function enqueue(st, sh) {
    const t = now();
    syncAll(st, t);
    const lims = limitersOf(st, sh.endpointClass);
    if (lims.some(({ lim }) => !lim.fitsDay(sh.cost))) {
      refuse(st, sh, nextIstMidnight(t) - t, "for today (this request needs more than a whole day's budget)");
      return;
    }
    const isOrder = sh.endpointClass === "order";
    // One consumer's own cap (orders and unattributed internal calls are exempt).
    const own = st.cons.get(sh.fairKey)?.queued ?? 0;
    if (!isOrder && sh.fairKey !== "" && own >= maxQueuedPerConsumer) {
      refuse(st, sh, Math.max(1000, budgetWait(st, sh.endpointClass, sh.cost, t)), `(the limit is ${maxQueuedPerConsumer} waiting per client)`, "consumer-cap");
      return;
    }
    let victim = null;
    if (st.queue.size >= rl.queue.maxQueuedPerAccount) {
      // A full queue must not be held by one consumer. Make room by dropping the newest waiting request of the consumer
      // that holds the most, if it holds clearly more than this one; otherwise this request is the one refused.
      const heavy = heaviestConsumer(st, isOrder ? null : sh.fairKey, true);
      victim = heavy && (isOrder || heavy.row.queued > own + 1) ? st.queue.newestOf(heavy.key) : null;
      if (!victim) {
        refuse(st, sh, Math.max(1000, budgetWait(st, sh.endpointClass, sh.cost, t)), `and ${st.queue.size} requests are already waiting`, "queue");
        return;
      }
    }
    const est = estimateStart(st, sh.endpointClass, sh.priority, sh.cost, t, sh.fairKey);
    if (est > sh.deadline) {
      refuse(st, sh, est - t, "for now");
      return;
    }
    if (victim) {
      const vsh = victim.value;
      dequeue(st, vsh);
      refuse(st, vsh, Math.max(1000, budgetWait(st, vsh.endpointClass, vsh.cost, t)), `and ${st.queue.size + 1} requests are already waiting (this was the newest request of the client with the most waiting)`, "queue");
    }
    sh.item = st.queue.push(sh, { priority: sh.priority, now: t, consumer: sh.fairKey, weight: sh.weight, cost: sh.cost, group: sh.endpointClass });
    trackQueued(st, sh, +1);
    dispatch(st);
  }

  /**
   * A caller joined a waiting shared call. Keep the call alive for the most patient caller, raise its priority when
   * the joiner is more urgent, and hand it to the joiner's consumer when that consumer would be served sooner than
   * the one that opened it: a shared call waits where its best-placed caller would, so a light consumer that asks for
   * what a flood already asked for is not held behind the flood's queue.
   */
  function promote(st, sh, priority, deadline, joiner) {
    sh.deadline = Math.max(sh.deadline, deadline);
    if (sh.started || sh.settled || !sh.item?.queued) return;
    const raise = PRIORITY_RANK[priority] < PRIORITY_RANK[sh.priority];
    const lane = raise ? priority : sh.priority;
    const ownerTag = raise ? st.queue.startTag(lane, sh.fairKey) : sh.item.tag;
    const rehome = Boolean(joiner) && joiner.fairKey !== "" && joiner.fairKey !== sh.fairKey && st.queue.startTag(lane, joiner.fairKey) < ownerTag;
    if (!raise && !rehome) return;
    const enqueuedAt = sh.item.enqueuedAt;
    dequeue(st, sh);
    if (rehome) {
      sh.fairKey = joiner.fairKey;
      sh.weight = joiner.weight;
      sh.label = joiner.label;
      sh.clientKind = joiner.clientKind;
    }
    sh.priority = lane;
    if (raise) sh.floorShare = null; // a more urgent caller now waits on this call: it is no longer background work
    sh.item = st.queue.push(sh, { priority: lane, now: enqueuedAt, consumer: sh.fairKey, weight: sh.weight, cost: sh.cost, group: sh.endpointClass });
    trackQueued(st, sh, +1);
    queueMicrotask(() => dispatch(st));
  }

  function leave(st, sh) {
    sh.waiters -= 1;
    if (sh.waiters > 0 || sh.settled) return;
    if (sh.started) {
      // Detach the aborted run so a later caller with the same key starts a fresh call instead of inheriting the abort.
      if (sh.key && inflight.get(sh.key) === sh) inflight.delete(sh.key);
      sh.controller.abort();
      return;
    }
    dequeue(st, sh);
    settle(sh, false, new DOMException("Every caller withdrew this request.", "AbortError"));
  }

  function waitFor(st, sh, signal) {
    if (!signal) return sh.promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        leave(st, sh);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      sh.promise.then(
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

  // ── Contract methods ──

  /**
   * Wait for budget, then run fn. Rejects with fn's own error unchanged, with UPSTREAM_RATE_LIMITED when the request
   * could not start in time, or with the signal's reason when aborted.
   * @template T
   * @param {{ accountId: string, endpointClass: string, priority?: string, coalesceKey?: string, cost?: number,
   *   signal?: AbortSignal, maxWaitMs?: number, backgroundShare?: number }} opts
   *   cost: upstream HTTP requests fn will make (default 1). maxWaitMs: wait at most this long (default per priority).
   *   coalesceKey: callers with the same key share one in-flight run; include the account id in it for pinned reads.
   *   backgroundShare: priority "background" only. The call starts only while it leaves every window at or above
   *   ceil((1 − share) × limit); share is clamped to MAX_BACKGROUND_SHARE (0.5). Jobs gated by backgroundGate pass it.
   * @param {(ctx: { signal: AbortSignal, accountId: string, endpointClass: string }) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function schedule(opts, fn) {
    if (stopped) throw new BridgeError("BROKER_UNAVAILABLE", "The Bridge is shutting down; broker calls are no longer accepted.");
    if (typeof fn !== "function") throw new TypeError("schedule() needs a function to run.");
    const { accountId, endpointClass, coalesceKey, signal } = opts ?? {};
    checkAccountId(accountId);
    checkClass(endpointClass);
    const priority = normalisePriority(endpointClass, opts.priority);
    const cost = normaliseCost(opts.cost);
    const floorShare = normaliseShare(opts.backgroundShare, priority);
    if (signal?.aborted) throw abortReason(signal);
    const st = stateFor(accountId);
    const t = now();
    const maxWait = Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs >= 0 ? Math.min(opts.maxWaitMs, MAX_CALLER_WAIT_MS) : rl.queue.maxWaitMs[priority];
    const deadline = t + maxWait;
    const key = endpointClass !== "order" && typeof coalesceKey === "string" && coalesceKey.length > 0 ? coalesceKey : null;

    const consumer = currentConsumer() ?? (priority === "background" ? "Background jobs" : null);
    // A person (or their tool) is asking: background pre-warms wait while this is recent (userActiveAt).
    if (priority !== "background") lastUserAt = t;
    // Fairness identity: the API key (else the principal kind, else the job name); unattributed internal work shares one "" consumer.
    const info = currentConsumerInfo();
    const fairKey = info?.fairKey ?? "";
    const weight = info ? client.weightFor(info.keyId, info.clientKind) : 1;
    const existing = key ? inflight.get(key) : null;
    if (existing && !existing.settled) {
      existing.waiters += 1;
      stats(existing.st, existing.endpointClass).coalesced += 1;
      bumpSaving("coalesced", 1, consumer);
      if (floorShare == null) existing.floorShare = null; // a caller without a floor is waiting too
      promote(existing.st, existing, priority, deadline, { fairKey, weight, label: info?.label ?? consumer ?? "Other", clientKind: info?.clientKind ?? "other" });
      return waitFor(existing.st, existing, signal);
    }

    const sh = {
      key,
      st,
      endpointClass,
      priority,
      cost,
      floorShare,
      deadline,
      fn,
      consumer,
      fairKey,
      weight,
      label: info?.label ?? consumer ?? "Other",
      clientKind: info?.clientKind ?? "other",
      waiters: 1,
      settled: false,
      started: false,
      item: null,
      controller: new AbortController(),
    };
    sh.promise = new Promise((resolve, reject) => {
      sh.resolve = resolve;
      sh.reject = reject;
    });
    sh.promise.catch(() => {}); // a call every waiter abandoned must not become an unhandled rejection
    if (key) inflight.set(key, sh);
    enqueue(st, sh);
    return waitFor(st, sh, signal);
  }

  /**
   * Take budget right now without queueing. Refuses (with retryAfterMs) when the class is backing off, when anything
   * is already waiting on the same buckets (so this never jumps the queue), or when the windows are full.
   */
  function tryAcquire(accountId, endpointClass, cost = 1) {
    checkAccountId(accountId);
    checkClass(endpointClass);
    const n = normaliseCost(cost);
    const st = stateFor(accountId);
    const t = now();
    syncAll(st, t);
    const bo = backoffRemaining(st, endpointClass, t);
    if (bo > 0) return { ok: false, retryAfterMs: Math.ceil(bo) };
    const lims = limitersOf(st, endpointClass);
    if (lims.some(({ lim }) => !lim.fitsDay(n))) return { ok: false, retryAfterMs: nextIstMidnight(t) - t };
    const waiting = lims.some(({ key }) => st.bucketQueued.get(key).some((u) => u > 0));
    if (!waiting && lims.every(({ lim }) => lim.canTake(n, t))) {
      for (const { lim } of lims) lim.take(n, t);
      const s = stats(st, endpointClass);
      s.calls += 1;
      s.units += n;
      noteCall(st, endpointClass, n, currentConsumer() ?? "Background jobs", t);
      const comp = st.compOf.get(endpointClass);
      syncScale(st, comp, t);
      comp.periodHadCalls = true;
      return { ok: true, retryAfterMs: 0 };
    }
    const est = waiting ? estimateStart(st, endpointClass, "background", n, t, currentConsumerInfo()?.fairKey ?? "") - t : budgetWait(st, endpointClass, n, t);
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil(est)) };
  }

  /** Units left in the binding window for (account, class). remaining/limit are Infinity for paper accounts. */
  function headroom(accountId, endpointClass) {
    checkAccountId(accountId);
    checkClass(endpointClass);
    const st = stateFor(accountId);
    syncAll(st, now());
    const h = headroomOf(st, endpointClass, now());
    return { remaining: h.remaining, limit: h.limit, resetMs: Math.ceil(h.resetMs) };
  }

  /**
   * Every window that covers (account, class): the class bucket's windows and those of each group bucket that lists
   * the class, plus the class back-off. Used by backgroundGate.mjs (background work keeps each window at or
   * above half its limit). Paper accounts have no windows. `remaining` already counts the units of every request
   * queued on that bucket (it will take them before anything new), so `remaining = limit − used − queued`.
   * @returns {{ windows: Array<{ bucket: string, window: string, used: number, queued: number, limit: number, remaining: number, resetMs: number }>, backoffMs: number }}
   */
  function headroomWindows(accountId, endpointClass) {
    checkAccountId(accountId);
    checkClass(endpointClass);
    const st = stateFor(accountId);
    const t = now();
    syncAll(st, t);
    const windows = [];
    for (const { key, lim } of limitersOf(st, endpointClass)) {
      const queued = st.bucketQueued.get(key).reduce((a, b) => a + b, 0);
      for (const w of lim.windows(t)) {
        windows.push({ bucket: key, window: w.window, used: w.used, queued, limit: w.limit, remaining: Math.max(0, w.limit - w.used - queued), resetMs: Math.ceil(w.resetMs) });
      }
    }
    return { windows, backoffMs: Math.ceil(backoffRemaining(st, endpointClass, t)) };
  }

  /**
   * Choose an account for a pooled read: healthy first, then not backing off, then the largest share of budget left
   * after queued work, then fewer queued requests, then candidate order. Null when no candidate is healthy.
   */
  function pickAccount({ candidates, endpointClass } = {}) {
    checkClass(endpointClass);
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const t = now();
    let best = null;
    candidates.forEach((id, index) => {
      let st;
      try {
        st = stateFor(id);
      } catch {
        return;
      }
      if (!healthy(st)) return;
      const bo = backoffRemaining(st, endpointClass, t);
      const h = headroomOf(st, endpointClass, t);
      const queued = st.queuedByClass.get(endpointClass);
      const share = Number.isFinite(h.limit) ? (h.remaining - queued) / h.limit : 1;
      const row = { id, tier: bo > 0 ? 1 : 0, share, bo, queued, index };
      const better =
        !best ||
        row.tier < best.tier ||
        (row.tier === best.tier && (row.share > best.share || (row.share === best.share && (row.bo < best.bo || (row.bo === best.bo && row.queued < best.queued)))));
      if (better) best = row;
    });
    return best?.id ?? null;
  }

  /**
   * The broker throttled (account, class): pause every class of that account that shares a budget with it (the whole
   * pool), for Retry-After or 1 s, 2 s, 4 s ... plus 0 to 250 ms of jitter (never less than Retry-After), and lower the
   * pool's adaptive scale once per throttle episode. Emits "limits.throttled".
   */
  function noteUpstreamThrottle(accountId, endpointClass, retryAfterMs) {
    checkAccountId(accountId);
    checkClass(endpointClass);
    const st = stateFor(accountId);
    const t = now();
    const comp = st.compOf.get(endpointClass);
    comp.streak += 1;
    const given = Number(retryAfterMs);
    const base = Number.isFinite(given) && given > 0 ? Math.min(given, MAX_RETRY_AFTER_MS) : Math.min(rl.backoff.maxMs, rl.backoff.initialMs * 2 ** (comp.streak - 1));
    const delay = base + Math.floor(random() * BACKOFF_JITTER_MS);
    // Many in-flight calls fail together when a budget is hit: the ones inside the pause already in force are one episode.
    const newEpisode = t >= comp.backoffUntil;
    comp.backoffUntil = Math.max(comp.backoffUntil, t + delay);
    for (const c of comp.classes) {
      const b = st.backoff.get(c) ?? { until: 0 };
      b.until = Math.max(b.until, t + delay);
      st.backoff.set(c, b);
    }
    stats(st, endpointClass).throttled += 1;
    if (newEpisode) decreaseScale(st, comp, t, delay);
    log?.warn?.("broker rate limit hit; pausing this account and its shared budget", { accountId, broker: st.broker, endpointClass, pool: comp.name, retryAfterMs: delay, backoffFactor: comp.scale });
    bus?.emit("limits.throttled", { accountId, endpointClass, retryAfterMs: delay, upstream: true });
    if (st.queue.size) wakeAt(t + delay);
  }

  function rollSavings() {
    const d = istDay(now());
    if (d !== savings.day) {
      savings.day = d;
      savings.servedFromStream = 0;
      savings.servedFromCache = 0;
      savings.coalesced = 0;
      savings.batched = 0;
      consumers.clear();
    }
  }

  function bumpSaving(kind, count, consumer = currentConsumer()) {
    const field = SAVING_KINDS[kind];
    const n = Math.floor(Number(count));
    if (!field || !Number.isFinite(n) || n <= 0) return false;
    rollSavings();
    savings[field] += n;
    if (consumer) consumerRow(consumer).saved += n;
    return true;
  }

  /** Per-second calls of the last SERIES_SECONDS seconds, oldest first, only classes with any call. */
  function seriesOf(st, t) {
    const end = Math.floor(t / 1000);
    const start = end - SERIES_SECONDS + 1;
    const out = {};
    for (let sec = start; sec <= end; sec++) {
      const slot = st.series[((sec % SERIES_SECONDS) + SERIES_SECONDS) % SERIES_SECONDS];
      if (slot.sec !== sec) continue;
      slot.counts.forEach((n, i) => {
        if (!n) return;
        const cls = ENDPOINT_CLASSES[i];
        (out[cls] ??= new Array(SERIES_SECONDS).fill(0))[sec - start] = n;
      });
    }
    return { startSec: start, seconds: SERIES_SECONDS, classes: out };
  }

  /** Every window of (account, class) with what it holds now: the second and the minute a trader watches. */
  function windowsOf(st, cls, t) {
    const out = [];
    for (const { key, lim } of limitersOf(st, cls)) {
      for (const w of lim.windows(t)) out.push({ bucket: key, window: w.window, used: w.used, limit: w.limit, resetMs: Math.ceil(w.resetMs) });
    }
    return out;
  }

  /**
   * Per-account, per-class budgets (binding window and every window), plus today's savings and top consumers.
   * @param {{ series?: boolean }} [opts]  series: add each account's per-second history (last SERIES_SECONDS s)
   */
  function usage({ series = false } = {}) {
    const t = now();
    rollSavings();
    const ids = [];
    try {
      for (const a of accounts.list()) if (a.broker !== "paper" && a.enabled !== false) ids.push(a.id);
    } catch {
      // AccountManager not built: report what the scheduler has seen
    }
    for (const id of states.keys()) if (!ids.includes(id)) ids.push(id);
    const out = [];
    for (const id of ids) {
      let st;
      try {
        st = stateFor(id);
      } catch {
        continue;
      }
      if (st.policy.unlimited) continue;
      syncAll(st, t);
      const classes = {};
      for (const cls of ENDPOINT_CLASSES) {
        const h = headroomOf(st, cls, t);
        const s = stats(st, cls);
        classes[cls] = {
          used: h.used,
          limit: h.limit,
          queued: st.queuedByClass.get(cls),
          resetMs: Math.ceil(h.resetMs),
          window: h.window,
          backoffMs: Math.ceil(backoffRemaining(st, cls, t)),
          callsToday: s.calls,
          coalescedToday: s.coalesced,
          throttledToday: s.throttled,
          refusedToday: s.rejected,
          windows: windowsOf(st, cls, t),
        };
      }
      const row = { accountId: id, broker: st.broker, healthy: healthy(st), inFlight: st.inFlight, queued: st.queue.size, classes };
      if (series) row.series = seriesOf(st, t);
      out.push(row);
    }
    return {
      accounts: out,
      savings: {
        servedFromStream: savings.servedFromStream,
        servedFromCache: savings.servedFromCache,
        coalesced: savings.coalesced,
        batched: savings.batched,
        since: toIstIso(nextIstMidnight(t) - 86_400_000),
      },
      consumers: [...consumers]
        .map(([name, c]) => ({ name, calls: c.calls, saved: c.saved }))
        .sort((a, b) => b.calls - a.calls || b.saved - a.saved || (a.name < b.name ? -1 : 1))
        .slice(0, 12),
      generatedAt: toIstIso(t),
    };
  }

  /**
   * Adaptive state of every budget pool (a pool is the classes of one account that share a budget), for
   * GET /v1/limits?explain=1. `backoffFactor` is the AIMD scale (1 = the policy figure; lower after broker 429s),
   * `ceiling` the most it may recover to (below 1 for 24 h after three episodes in an hour), `spare` the share of the
   * tightest window still free after queued work (0 to 1).
   * @param {{ accountIds?: Iterable<string> | "*" }} [opts]  only these accounts (default all that have been used or exist)
   * @returns {Array<{ group: string, accountId: string, broker: string, classes: string[], accounts: string[], spare: number, remaining: number, limit: number, ceiling: number, backoffFactor: number, backoffMs: number, episodesLastHour: number, frozen: boolean }>}
   */
  function pools({ accountIds = "*" } = {}) {
    const t = now();
    const allow = accountIds === "*" ? null : new Set(accountIds);
    const ids = [];
    try {
      for (const a of accounts.list()) if (a.broker !== "paper" && a.enabled !== false) ids.push(a.id);
    } catch {
      // AccountManager not built: report what the scheduler has seen
    }
    for (const id of states.keys()) if (!ids.includes(id)) ids.push(id);
    const out = [];
    for (const id of ids) {
      if (allow && !allow.has(id)) continue;
      let st;
      try {
        st = stateFor(id);
      } catch {
        continue;
      }
      if (st.policy.unlimited) continue;
      syncAll(st, t);
      for (const comp of st.comps) {
        if (!comp.bucketKeys.length) continue;
        let spare = 1;
        let remaining = Infinity;
        let limit = Infinity;
        for (const cls of comp.classes) {
          if (!limitersOf(st, cls).length) continue;
          const h = headroomOf(st, cls, t);
          const queued = st.queuedByClass.get(cls);
          const share = Number.isFinite(h.limit) && h.limit > 0 ? Math.max(0, h.remaining - queued) / h.limit : 1;
          if (share < spare || !Number.isFinite(limit)) {
            spare = Math.min(spare, share);
            remaining = h.remaining;
            limit = h.limit;
          }
        }
        const backoffMs = Math.max(0, ...comp.classes.map((c) => backoffRemaining(st, c, t)));
        out.push({
          group: `${id}/${comp.name}`,
          accountId: id,
          broker: st.broker,
          classes: [...comp.classes],
          accounts: [id],
          spare: Math.round(spare * 1000) / 1000,
          remaining: finiteOrNull(remaining),
          limit: finiteOrNull(limit),
          ceiling: comp.ceiling,
          backoffFactor: comp.scale,
          backoffMs: Math.ceil(backoffMs),
          episodesLastHour: comp.episodes.filter((e) => t - e < AIMD.episodeWindowMs).length,
          frozen: comp.ceiling < 1,
        });
      }
    }
    return out;
  }

  /**
   * Consumers with work waiting or running now, across accounts: `{ id, label, kind, weight, queued, inFlight, share }`.
   * `share` is the consumer's weight over the total weight of the consumers that are competing (its fair share of a
   * contended budget, 0 to 1).
   */
  function consumersNow() {
    /** @type {Map<string, { id: string, label: string, kind: string, weight: number, queued: number, inFlight: number }>} */
    const byKey = new Map();
    for (const st of states.values()) {
      for (const [key, row] of st.cons) {
        let c = byKey.get(key);
        if (!c) {
          c = { id: key, label: row.label, kind: row.kind, weight: row.weight, queued: 0, inFlight: 0 };
          byKey.set(key, c);
        }
        c.queued += row.queued;
        c.inFlight += row.inFlight;
      }
    }
    const total = [...byKey.values()].reduce((a, c) => a + c.weight, 0);
    return [...byKey.values()]
      .map((c) => ({ ...c, id: c.id === "" ? "internal" : c.id, share: total > 0 ? Math.round((c.weight / total) * 1000) / 1000 : 0 }))
      .sort((a, b) => b.queued + b.inFlight - (a.queued + a.inFlight) || (a.id < b.id ? -1 : 1));
  }

  /** Inbound per-key budget (RateLimit headers). */
  function checkClient(ctx) {
    return client.check(ctx);
  }

  // ── Extras ──

  /** Stop timers and refuse everything still waiting (module stop). */
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearT(timer);
    timer = null;
    for (const off of offs) off();
    for (const st of states.values()) {
      for (const item of [...st.queue.iterate(now())]) {
        const sh = item.value;
        dequeue(st, sh);
        settle(sh, false, new BridgeError("BROKER_UNAVAILABLE", "The Bridge is shutting down; this broker call was not sent."));
      }
    }
    if (current === api) current = null;
  }

  const api = {
    schedule,
    tryAcquire,
    headroom,
    headroomWindows,
    pickAccount,
    noteUpstreamThrottle,
    pools,
    consumers: consumersNow,
    /** The per-key quota store (overrides over config over defaults) and usage counters: GET/PUT/DELETE /v1/quotas. */
    quotas,
    clientUsage: (keyId) => client.usageOf(keyId),
    clientWeights: () => client.kindWeights(),
    clientLimits: () => ({ defaults: quotas.defaults(), maxConcurrent: client.maxConcurrent }),
    weightFor: (keyId, clientKind) => client.weightFor(keyId, clientKind),
    policyFor,
    usage,
    checkClient,
    /** Epoch ms of the last non-background broker request (an order or a read a person or tool is waiting on). */
    userActiveAt: () => lastUserAt,
    /** Record a saved broker call (see the exported recordSaving). */
    recordSaving: (kind, count = 1) => bumpSaving(kind, count),
    /** Broker calls and saved calls credited to one consumer today ({ calls: 0, saved: 0 } when none). Read-only. */
    consumerCalls: (name) => {
      rollSavings();
      const row = consumers.get(name);
      return { calls: row?.calls ?? 0, saved: row?.saved ?? 0 };
    },
    /** This caller's budget without spending it (/v1/limits). */
    clientBudget: (ctx) => client.peek(ctx),
    /** The effective policy for one account (broker policy lowered by that account's overrides). */
    accountPolicy: (accountId) => stateFor(accountId).policy,
    stop,
  };
  current = api;
  return api;
}
