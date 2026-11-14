/**
 * SourceRouter: for one read, decide which sources may answer it and in what order to try them.
 *
 * Candidates are the user's own broker accounts (accounts.marketDataCandidates already applies pooling consent and the
 * caller's account restriction) plus the data sources the registry holds and the owner has switched on.
 *
 * 1. Hard filters, never traded against score: capability, data class against the read's purpose
 *    (contract.classAllowedFor), the caller's maxAgeMs (contract.meetsMaxAge), the breaker, the caller's deadline.
 *    Reads made for order, risk, paper or alert accept only real-time data, and from a non-broker source only an
 *    official, non-plugin one.
 * 2. Order: brokers that still have budget first (real-time data always outranks delayed data), then data sources
 *    (most current class first), then brokers that are out of budget right now (the scheduler will queue or refuse).
 *    Data sources are considered only when the read allows them (`allowSources`, from the caller's backup opt-in or
 *    the autoFallback setting). Inside a group: score = spare x (1 - errorRate) x latencyFactor, with a small
 *    optimistic discount for a source that has no history yet.
 * 3. At most 2 attempts per request: failover is the retry.
 *
 * `select()` is on the hot path: no I/O, no clock reads beyond one, short-lived small arrays only, and no strings
 * built. `trace()` runs the same decision with explanations and never claims a probe or calls upstream.
 */
import { planInterval } from "../market/history.mjs";
import { PURPOSES, classAllowedFor, classRank, meetsMaxAge } from "./contract.mjs";
import { istClock } from "./health.mjs";

/** Most sources tried for one request. */
export const MAX_ATTEMPTS = 2;

const STRICT = new Set(["alert", "paper", "risk", "order"]);
/** read capability -> scheduler endpoint class */
const ENDPOINT = { quotes: "quote", ltp: "quote", depth: "depth", history: "history", expiries: "chain", optionChain: "chain" };
/** read capability -> the name accounts.marketDataCandidates knows */
const BROKER_CAP = { quotes: "quotes", ltp: "ltp", depth: "depth", history: "historical", expiries: "expiries", optionChain: "optionChain" };
/** A source with fewer calls than this is scored with an optimistic prior (slightly below proven ones). */
const EXPLORE_CALLS = 10;
const EXPLORE_FACTOR = 0.9;
/** Below this share of budget left, a candidate's score is halved so the last slice is not drained. */
const SOFT_RESERVE = 0.1;
/** A breaker-open candidate may be probed once per this long when nothing else could answer. */
const FORCED_PROBE_MS = 5000;
const NO_BUDGET_RETRY_MS = 30_000;

const REASONS = Object.freeze({
  broker: Object.freeze(["real-time broker account"]),
  brokerNoBudget: Object.freeze(["real-time broker account", "no budget left right now"]),
  realtime: Object.freeze(["real-time data source"]),
  delayed: Object.freeze(["delayed data source"]),
  eod: Object.freeze(["end-of-day data source"]),
  lastResort: Object.freeze(["last resort: nothing else could answer"]),
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function delayText(d) {
  if (d.class === "eod") return "only has end-of-day data";
  const sec = Number.isFinite(d.delaySec) ? d.delaySec : 900;
  if (sec >= 120 && sec % 60 === 0) return `is delayed ${sec / 60} min`;
  return `is delayed ${sec} s`;
}

function msText(ms) {
  if (!Number.isFinite(ms)) return "a while";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 120_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function ejectedReason(phase, until) {
  if (phase === "disabled") return "switched off";
  if (phase === "half") return "a probe call is already in flight after repeated failures";
  return `breaker open until ${istClock(until)} after repeated failures`;
}

/** Read a registry entry as { descriptor, enabled } whatever shape the registry hands out. */
function readEntry(entry) {
  const descriptor = entry?.descriptor ?? entry?.provider?.descriptor ?? null;
  return { descriptor, enabled: typeof entry?.enabled === "boolean" ? entry.enabled : undefined };
}

/** The health calls the router uses, from the real tracker or any object that only has state(). */
function adaptHealth(health) {
  const stateName = (id) => health?.state?.(id)?.state;
  return {
    canTry: typeof health?.canTry === "function" ? (id) => health.canTry(id) : (id) => stateName(id) !== "open" && stateName(id) !== "disabled",
    claim: typeof health?.claim === "function" ? (id) => health.claim(id) : () => {},
    latencyMs: typeof health?.latencyMs === "function" ? (id) => health.latencyMs(id) : (id) => (Number.isFinite(health?.state?.(id)?.p50Ms) ? health.state(id).p50Ms : NaN),
    errorRate: typeof health?.errorRate === "function" ? (id) => health.errorRate(id) : (id) => health?.state?.(id)?.errorRate ?? 0,
    samples: typeof health?.samples === "function" ? (id) => health.samples(id) : () => 0,
    phase:
      typeof health?.phase === "function"
        ? (id) => health.phase(id)
        : (id) => {
            const n = stateName(id);
            return n === "open" ? "open" : n === "disabled" ? "disabled" : "closed";
          },
    nextTryAt: typeof health?.nextTryAt === "function" ? (id) => health.nextTryAt(id) : (id) => health?.state?.(id)?.nextTryAt ?? null,
    state: (id) => (typeof health?.state === "function" ? health.state(id) : { state: "ok", errorRate: 0, p50Ms: null, lastError: null, nextTryAt: null }),
  };
}

/**
 * @param {object} deps
 * @param {{ list(): any[], get?(id: string): any }} deps.registry   sources; entries are providers (`{ descriptor }`) or `{ descriptor, enabled }`
 * @param {object} deps.health      createHealthTracker()
 * @param {object} deps.scheduler   headroom(accountId, endpointClass) -> { remaining, limit, resetMs }
 * @param {object} deps.accounts    marketDataCandidates({ capability, accountId?, allowedAccounts? }) -> string[]
 * @param {{ now(): number }} deps.clock
 * @param {object} [deps.logger]
 * @param {(id: string) => boolean} [deps.isEnabled]  whether the owner switched a source on (and set it up); when absent
 *   the registry's own `isEnabled(id)` or the entry's `enabled` flag is used, else a source counts as off
 * @param {(id: string, capability: string) => number | undefined} [deps.sourceSpare]  0..1 share of a source's own quota left
 */
export function createSourceRouter({ registry, health, scheduler, accounts, clock, logger, isEnabled, sourceSpare } = {}) {
  const now = () => (clock && typeof clock.now === "function" ? clock.now() : Date.now());
  const hl = adaptHealth(health);
  /** account id -> synthesised descriptor */
  const brokerDescriptors = new Map();
  /** source id -> time after which the scheduler is asked about its budget again (it has no entry for it) */
  const budgetUnknownUntil = new Map();
  /** id -> last forced probe */
  const forcedProbes = new Map();

  function brokerDescriptor(id, capability) {
    let d = brokerDescriptors.get(id);
    if (!d) {
      let name = id;
      try {
        const a = accounts.get?.(id);
        if (a && typeof a.label === "string" && a.label) name = a.label;
      } catch {
        // unknown account: the id is name enough
      }
      d = Object.freeze({ id, name, kind: "broker", tier: "builtin", class: "realtime", delaySec: 0, official: true, capabilities: Object.freeze([capability]), limits: Object.freeze({}) });
      brokerDescriptors.set(id, d);
    }
    return d;
  }

  const enabledOf = (id, entryEnabled) => {
    if (typeof isEnabled === "function") {
      try {
        return Boolean(isEnabled(id));
      } catch {
        return false;
      }
    }
    if (typeof registry?.isEnabled === "function") {
      try {
        return Boolean(registry.isEnabled(id));
      } catch {
        return false;
      }
    }
    return entryEnabled === true;
  };

  /** { remaining, limit, resetMs } for a broker account, or null when the scheduler cannot say. */
  function budgetOf(id, endpointClass) {
    try {
      return scheduler.headroom(id, endpointClass);
    } catch {
      return null;
    }
  }

  function sourceBudget(id, capability, endpointClass, t) {
    // The quota the sources service enforces, when it reports one.
    if (typeof sourceSpare === "function") {
      try {
        const v = sourceSpare(id, capability);
        if (Number.isFinite(v)) return { remaining: v > 0 ? v : 0, limit: 1, resetMs: 0 };
      } catch {
        // fall through
      }
    }
    // Otherwise the scheduler, when it budgets a pseudo account for the source (src:<id>).
    const until = budgetUnknownUntil.get(id);
    if (until !== undefined && t < until) return null;
    try {
      return scheduler.headroom(`src:${id}`, endpointClass);
    } catch {
      budgetUnknownUntil.set(id, t + NO_BUDGET_RETRY_MS);
      return null;
    }
  }

  const spareOf = (b) => {
    if (!b || !Number.isFinite(b.limit) || b.limit <= 0) return 1;
    const s = clamp((Number.isFinite(b.remaining) ? b.remaining : b.limit) / b.limit, 0, 1);
    return s >= SOFT_RESERVE ? s : s * 0.5;
  };

  function candidate(kind, id, descriptor, score, reasons) {
    return { kind, id, accountId: kind === "broker" ? id : undefined, descriptor, score, reasons };
  }

  /**
   * The decision. `explain` fills `considered` with a reason for every source looked at and never claims a probe.
   * @returns {{ plan: Candidate[], considered: any[] | null, broker: number, sources: number }}
   */
  function decide(req, explain) {
    const capability = req.capability;
    const purpose = req.purpose ?? "display";
    const strict = STRICT.has(purpose) || !PURPOSES.includes(purpose);
    const endpointClass = req.endpointClass ?? ENDPOINT[capability] ?? "other";
    const deadline = Number.isFinite(req.deadlineMs) && req.deadlineMs >= 0 ? req.deadlineMs : null;
    const allowSources = req.allowSources === true;
    const t = now();
    const skipped = explain ? [] : null;
    const skip = (c, reason, extra) => {
      if (skipped) skipped.push({ id: c.id, kind: c.kind, verdict: "skipped", reason: `skipped: ${reason}`, ...(extra ?? {}), _c: c });
    };

    const brokersOnly = req.only === "brokers";
    const sourcesOnly = req.only === "sources";

    // ── brokers ──
    const brokers = [];
    const brokerLat = [];
    const noBudget = [];
    const lastResort = [];
    let ids = [];
    if (!sourcesOnly) {
      try {
        const q = { capability: req.brokerCapability ?? BROKER_CAP[capability] ?? capability };
        if (req.allowedAccounts !== undefined) q.allowedAccounts = req.allowedAccounts;
        if (req.accountId) q.accountId = req.accountId;
        const got = accounts.marketDataCandidates(q);
        if (Array.isArray(got)) ids = got;
      } catch (err) {
        logger?.debug?.("router: marketDataCandidates failed", { code: err?.code });
      }
    }
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const desc = brokerDescriptor(id, capability);
      if (typeof req.supports === "function") {
        const v = req.supports(id);
        if (v !== true && v !== undefined && v !== null) {
          if (skipped) skip(candidate("broker", id, desc, 0, REASONS.broker), typeof v === "string" ? lowerFirst(v) : "this account cannot serve this request");
          continue;
        }
      }
      if (!hl.canTry(id)) {
        const c = candidate("broker", id, desc, 0, REASONS.lastResort);
        const phase = hl.phase(id);
        if (phase === "open") lastResort.push(c);
        if (skipped) skip(c, ejectedReason(phase, hl.nextTryAt(id)));
        continue;
      }
      const b = budgetOf(id, endpointClass);
      const remaining = b && Number.isFinite(b.remaining) ? b.remaining : Infinity;
      if (remaining <= 0) {
        const wait = Number(b.resetMs) || 0;
        const c = candidate("broker", id, desc, 0, REASONS.brokerNoBudget);
        c.waitMs = wait;
        c.spare = 0;
        if (deadline !== null && wait > deadline) {
          lastResort.push(c);
          if (skipped) skip(c, `its budget frees up in ${msText(wait)}, later than the ${msText(deadline)} this read can wait`, { spareBudget: 0 });
        } else noBudget.push(c);
        continue;
      }
      const spare = spareOf(b);
      const c = candidate("broker", id, desc, spare, REASONS.broker);
      brokers.push(c);
      brokerLat.push(hl.latencyMs(id));
    }

    // ── data sources ──
    const sources = [];
    const sourceLat = [];
    if (!brokersOnly && (allowSources || explain)) {
      let entries;
      try {
        entries = registry?.list?.() ?? [];
      } catch (err) {
        logger?.debug?.("router: registry.list failed", { code: err?.code });
        entries = [];
      }
      for (let i = 0; i < entries.length; i += 1) {
        const { descriptor: d, enabled: entryEnabled } = readEntry(entries[i]);
        if (!d || d.kind === "broker") continue; // broker accounts come from the accounts list
        const c0 = candidate("source", d.id, d, 0, REASONS[d.class] ?? REASONS.delayed);
        if (!Array.isArray(d.capabilities) || !d.capabilities.includes(capability)) {
          if (skipped) skip(c0, `${d.name ?? d.id} does not offer ${capability}`);
          continue;
        }
        if (!enabledOf(d.id, entryEnabled)) {
          if (skipped) skip(c0, "switched off (turn it on, and set its key if it needs one, on the Sources page)");
          continue;
        }
        if (!allowSources) {
          if (skipped) skip(c0, "backup sources are not used for this read (ask with backup=true, or turn on automatic fallback)");
          continue;
        }
        if (!classAllowedFor(d.class, purpose) || (strict && d.class !== "realtime")) {
          if (skipped) skip(c0, d.class === "realtime" ? `${purpose} reads cannot use this source` : `needs real-time, this source ${delayText(d)}`);
          continue;
        }
        if (strict && !(d.official === true && d.tier !== "plugin" && d.kind !== "plugin")) {
          if (skipped) skip(c0, `${purpose} reads accept only official real-time sources, and this one is ${d.tier === "plugin" ? "a plugin" : "not official"}`);
          continue;
        }
        if (!meetsMaxAge(d, req.maxAgeMs)) {
          if (skipped) skip(c0, `you asked for data at most ${msText(req.maxAgeMs)} old, and this source ${delayText(d)}`);
          continue;
        }
        if (!hl.canTry(d.id)) {
          const phase = hl.phase(d.id);
          if (phase === "open") lastResort.push(candidate("source", d.id, d, 0, REASONS.lastResort));
          if (skipped) skip(c0, ejectedReason(phase, hl.nextTryAt(d.id)));
          continue;
        }
        const lat = hl.latencyMs(d.id);
        if (deadline !== null && Number.isFinite(lat) && lat > deadline) {
          lastResort.push(candidate("source", d.id, d, 0, REASONS.lastResort));
          if (skipped) skip(c0, `it usually takes ${msText(lat)}, longer than the ${msText(deadline)} this read can wait`);
          continue;
        }
        const b = sourceBudget(d.id, capability, endpointClass, t);
        if (b && Number.isFinite(b.remaining) && b.remaining <= 0) {
          if (skipped) skip(c0, `its own quota is used up${Number(b.resetMs) > 0 ? ` (frees up in ${msText(b.resetMs)})` : ""}`, { spareBudget: 0 });
          continue;
        }
        const c = candidate("source", d.id, d, spareOf(b), REASONS[d.class] ?? REASONS.delayed);
        sources.push(c);
        sourceLat.push(lat);
      }
    }

    // ── score and order ──
    scoreGroup(brokers, brokerLat, false);
    scoreGroup(sources, sourceLat, true);
    brokers.sort((a, b) => b.score - a.score);
    sources.sort((a, b) => classRank(a.descriptor.class) - classRank(b.descriptor.class) || b.score - a.score);
    noBudget.sort((a, b) => a.waitMs - b.waitMs);

    const ordered = brokers.concat(sources, noBudget);
    let forced = null;
    if (!ordered.length && lastResort.length) {
      // Never fully blind: when nothing else can answer, one ejected or too-slow candidate still gets the call, a
      // breaker-open one at most once per FORCED_PROBE_MS.
      let best = null;
      for (const c of lastResort) {
        const open = !hl.canTry(c.id);
        if (open && t - (forcedProbes.get(c.id) ?? -Infinity) < FORCED_PROBE_MS) continue;
        const key = open ? hl.nextTryAt(c.id) ?? t : t;
        if (!best || key < best.key) best = { c, key };
      }
      if (best) {
        forced = best.c;
        ordered.push(forced);
        if (!explain && !hl.canTry(forced.id)) forcedProbes.set(forced.id, t);
      }
    }
    const plan = ordered.length > MAX_ATTEMPTS ? ordered.slice(0, MAX_ATTEMPTS) : ordered;
    if (!explain && plan.length) hl.claim(plan[0].id);
    if (!explain) return { plan, considered: null, broker: brokers.length, sources: sources.length };

    // ── explanations ──
    const considered = [];
    plan.forEach((c, index) => {
      const verdict = index === 0 ? "chosen" : "fallback";
      considered.push({ id: c.id, kind: c.kind, verdict, reason: explainPicked(c, index, { brokers, forced, noBudget }), score: round(c.score), spareBudget: round(c.spare), _c: c });
    });
    for (const c of ordered.slice(MAX_ATTEMPTS)) {
      considered.push({ id: c.id, kind: c.kind, verdict: "skipped", reason: `skipped: qualified, but ranked lower and a read tries at most ${MAX_ATTEMPTS} sources`, score: round(c.score), spareBudget: round(c.spare), _c: c });
    }
    for (const s of skipped) considered.push(s);
    return { plan, considered, broker: brokers.length, sources: sources.length };
  }

  function explainPicked(c, index, ctx) {
    const d = c.descriptor;
    if (c === ctx.forced) return `${index === 0 ? "chosen" : "fallback"}: nothing else could answer, so this one is tried anyway (it may fail fast)`;
    if (c.kind === "broker") {
      if (ctx.noBudget.includes(c)) return `${index === 0 ? "chosen" : "fallback"}: no better option; this account's budget is used up, so the call waits ${msText(c.waitMs)} or is refused`;
      if (index === 0) return ctx.brokers.length > 1 ? `chosen: most spare budget (${Math.round(c.score * 100)}% score) among your real-time accounts` : "chosen: your own real-time broker account";
      return "fallback: another of your real-time accounts, tried only if the first one fails";
    }
    const label = d.class === "realtime" ? "real-time" : d.class === "eod" ? "end-of-day" : `delayed ${Number.isFinite(d.delaySec) ? `${Math.round(d.delaySec / 60)} min` : ""}`.trim();
    const flags = `${label}${d.official ? "" : ", not official"}`;
    if (index === 0) return `chosen: no real-time broker account can answer this, so ${d.name ?? d.id} does (${flags}; the answer is labelled)`;
    return `fallback: tried only if the first one fails; ${d.name ?? d.id} is ${flags}, and its answer is labelled`;
  }

  /** score = spare x (1 - errorRate) x latencyFactor (x optimistic discount for a source with little history) */
  function scoreGroup(list, lats, isSource) {
    if (!list.length) return;
    let best = Infinity;
    for (let i = 0; i < lats.length; i += 1) if (lats[i] > 0 && lats[i] < best) best = lats[i];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const err = Math.min(0.9, hl.errorRate(c.id));
      const lat = lats[i];
      const latFactor = lat > 0 && best !== Infinity ? clamp(best / lat, 0.25, 1) : 1;
      const prior = isSource && hl.samples(c.id) < EXPLORE_CALLS ? EXPLORE_FACTOR : 1;
      c.spare = c.score;
      c.score = c.score * (1 - err) * latFactor * prior;
    }
  }

  const round = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

  /**
   * The ordered attempts for a read: at most MAX_ATTEMPTS candidates, best first. Empty when nothing can answer.
   * @param {{ capability: "quotes"|"history"|"expiries"|"optionChain"|"depth"|"ltp", brokerCapability?: string, endpointClass?: string,
   *   purpose?: string, maxAgeMs?: number, symbols?: string[], deadlineMs?: number, allowedAccounts?: string[], accountId?: string,
   *   allowSources?: boolean, only?: "brokers"|"sources", supports?: (accountId: string) => true | string | false }} req
   * @returns {Array<{ kind: "broker"|"source", id: string, accountId?: string, descriptor: object, score: number, reasons: readonly string[] }>}
   */
  function select(req) {
    return decide(req, false).plan;
  }

  /**
   * Dry run of select(): no upstream call, no probe claimed. Says what would be tried and why every other source was
   * skipped.
   * @returns {{ request: object, considered: Array<{ id: string, kind: string, verdict: "chosen"|"fallback"|"skipped", reason: string, score?: number, spareBudget?: number, health: object }>, class: string|null, note: string }}
   */
  function trace(req) {
    const r = decide(req, true);
    const considered = r.considered.map(({ _c, ...row }) => {
      const out = { ...row, health: hl.state(row.id) };
      if (out.spareBudget === undefined) delete out.spareBudget;
      if (out.score === undefined) delete out.score;
      return out;
    });
    const first = r.plan[0];
    const purpose = req.purpose ?? "display";
    let note;
    if (!first) {
      note = "Nothing can answer this read right now. Connect a broker account, log in again, or switch on a data source on the Sources page.";
    } else if (first.kind === "source") {
      const d = first.descriptor;
      note = `Answered by ${d.name ?? d.id}: ${d.class === "realtime" ? "real-time" : d.class === "eod" ? "end-of-day" : "delayed"} data${d.official ? "" : ", not official"}. The answer says so. Orders, risk checks, paper fills and alerts never use it.`;
    } else {
      note = `Answered by your own broker account ${first.id}: real-time data${r.plan[1]?.kind === "source" ? `; ${r.plan[1].descriptor.name ?? r.plan[1].id} is the labelled fallback` : ""}.`;
    }
    if (!PURPOSES.includes(purpose)) note += ` "${String(purpose).slice(0, 20)}" is not a known purpose, so it is treated as strict (real-time only).`;
    return { request: describeRequest(req), considered, class: first ? first.descriptor.class : null, note };
  }

  return { select, trace, MAX_ATTEMPTS };
}

/**
 * Whether a broker account can serve a history request: true, or a plain reason it cannot. Used as the router's
 * `supports` hook so a source can take over when no broker offers the interval or segment.
 * @param {{ adapter(id: string): any }} accounts
 */
export function historySupport(accounts, accountId, interval, exchange) {
  let caps;
  try {
    caps = accounts.adapter(accountId)?.capabilities?.historical;
  } catch {
    caps = undefined;
  }
  const capObj = caps && typeof caps === "object" ? caps : {};
  if (Array.isArray(capObj.segments) && exchange && !capObj.segments.includes(exchange)) return `this account's broker offers historical candles only for ${capObj.segments.join(", ")}`;
  try {
    planInterval(interval, capObj.intervals);
    return true;
  } catch (err) {
    return err?.detail ?? "this account's broker cannot supply that interval";
  }
}

/** The request as echoed in a trace: only plain values. */
function describeRequest(req) {
  const out = { capability: req.capability, purpose: req.purpose ?? "display" };
  if (Array.isArray(req.symbols)) out.symbols = req.symbols.slice(0, 200);
  if (req.maxAgeMs !== undefined) out.maxAgeMs = req.maxAgeMs;
  if (req.deadlineMs !== undefined) out.deadlineMs = req.deadlineMs;
  if (req.interval !== undefined) out.interval = req.interval;
  out.allowBackup = req.allowSources === true;
  return out;
}
