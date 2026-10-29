/**
 * Readiness monitor and service — stream S20 (docs/spec/p1-05-readiness.md §3). Contract: SERVICE_CONTRACTS.readiness.
 *
 * Checks every non-paper account: broker session (state, stated expiry, a cheap probe call), egress IP against
 * live.registeredIp / backupIp (opt-in lookup), order-rate headroom, daily order and loss headroom, and the kill switch.
 * Each account gets ready | warn | cannot_trade | paper_only | unknown (checks.mjs combine()).
 *
 * When:
 *   tick      every 60 s; decides whether a cycle or the pre-open run is due (no I/O unless due)
 *   cycle     every intervalMinutes inside the IST window on trading days (first one jitter seconds after it opens)
 *   preopen   preOpenAt + jitter, once per IST date (persisted): evaluate, then one "preopen" notification
 *   startup   20 s after start(): state only outside the window (no broker call), full check inside it
 *   bus       account.status, account.session_rejected, safety.kill_switch, safety.limit: at once (debounced 250 ms)
 *   ensureFresh  on demand (an automated live order with stale state)
 * evaluate() is singleflight per account; the probe has a cooldown (≥ 30 s, more for brokers with low limits).
 *
 * The monitor only reads. It never imports orders/ or paper/, never calls an order method and never engages the kill
 * switch (static.test.mjs). It feeds the safety guard's per-order static-IP warning (setDetectedEgressIp).
 * The egress IP lives in memory only and is registered with logger.addSecret.
 */
import { join } from "node:path";
import { liveAllowedByConfig } from "../core/config.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { BROKER_NAMES } from "../accounts/brokerInfo.mjs";
import { createBackgroundGate, MAX_BACKGROUND_SHARE } from "../ratelimit/backgroundGate.mjs";
import { formatEvent } from "../notify/format.mjs";
import { createDemoReadiness, DEMO_SAMPLE_AUTOMATIONS } from "../demo/demoReadiness.mjs";
import { marketSession } from "../../lib/marketHours.mjs";
import { createAutomationRegistry } from "./automations.mjs";
import {
  combine,
  cycleDue,
  dailyLossCheck,
  dailyOrdersCheck,
  egressCheck,
  hhmmMinutes,
  inWindow,
  istDate,
  istInstant,
  istIso,
  isStale,
  jitterSecondsFor,
  killSwitchCheck,
  liveConfigCheck,
  nextCycleAt,
  nextPreOpenAt,
  notifyFailKey,
  notifyKey,
  preopenDue,
  probeCooldownSeconds,
  rateCheck,
  sessionCheck,
  shouldNotify,
  worstState,
} from "./checks.mjs";
import { readinessConfig, readinessWarnings } from "./config.mjs";
import { createEgressDetector } from "./egress.mjs";
import { normaliseIp } from "./ip.mjs";
import { TRANSITIONS_KEPT, createReadinessStore, freshState } from "./store.mjs";

const TICK_MS = 60_000;
const STARTUP_DELAY_MS = 20_000;
const DEBOUNCE_MS = 250;
const EGRESS_COOLDOWN_MS = 30_000;
const CHECK_WAIT_MS = 12_000;
const DEMO_SENT_KEPT = 10;

export const METHOD_TEXT =
  "Session: the broker's stated expiry plus a read call every 4 minutes from 08:45 to 15:45 IST on trading days. Egress IP: as seen by the lookup service you chose, which can differ from what your broker sees. Order headroom: the Bridge's own caps; broker and exchange counters are not visible.";

const HOLIDAY_CAVEAT = "(The Bridge does not have the exchange holiday list yet; ignore this if the market is closed today.)";

const brokerNameOf = (broker) => BROKER_NAMES[broker] ?? (broker === "demo" ? "Demo" : broker);

const optional = (deps, name) => {
  try {
    const s = deps[name];
    return s && !isStub(s) ? s : null;
  } catch {
    return null;
  }
};

/**
 * @param {any} deps  scoped deps: config, logger, bus, clock, paths, accounts, scheduler, safety, audit, reference
 * @param {{ timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 *   egress?: { lookup(): Promise<any>, seenBy?: string | null }, demo?: any, fetchImpl?: typeof fetch, jitterSeconds?: number }} [opts]
 */
export function createReadinessService(deps, opts = {}) {
  const { config, bus } = deps;
  const log = deps.logger?.child ? deps.logger.child({ module: "readiness" }) : deps.logger;
  const cfg = readinessConfig(config);
  const now = () => deps.clock.now();
  const timers = opts.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const accounts = deps.accounts;
  const safety = deps.safety;
  const scheduler = optional(deps, "scheduler");
  const audit = optional(deps, "audit");
  const reference = optional(deps, "reference");
  const gate = scheduler ? createBackgroundGate({ scheduler }) : null;
  const registry = createAutomationRegistry({ logger: log });
  const dataDir = deps.paths?.dataDir ?? null;
  const store = dataDir ? createReadinessStore({ dir: join(dataDir, "readiness"), logger: log, now }) : null;
  const persisted = store ? store.load() : freshState();
  const sim = opts.demo !== undefined ? opts.demo : config.demo === true ? createDemoReadiness({ clock: deps.clock, safety }) : null;
  const detector = opts.egress ?? createEgressDetector({ cfg: cfg.egressIp, fetchImpl: opts.fetchImpl, clock: deps.clock, logger: deps.logger });
  const jitter = opts.jitterSeconds ?? (sim ? 0 : jitterSecondsFor(dataDir ?? "bridge"));
  const intervalMinutes = sim ? 1 : cfg.intervalMinutes;
  // A passing probe proves the session only while it is recent; an older one (restored from state.json, or left from
  // before the close) is shown as unknown, never as ready (§2.3, §3.2). It is still kept for the probe cooldown.
  const maxProbeAgeMs = Math.max(cfg.staleAfterMinutes, 2 * intervalMinutes) * 60_000;

  /** @type {Map<string, any>} per-account memory */
  const mem = new Map();
  const memFor = (id) => {
    let m = mem.get(id);
    if (!m) {
      const p = persisted.accounts[id] ?? {};
      const restoredState = typeof p.state === "string" ? p.state : null;
      m = {
        result: null,
        prevState: typeof p.state === "string" ? p.state : "unknown",
        since: typeof p.since === "string" ? p.since : null,
        // Only a passing probe is kept across a restart (for the cooldown); a refusal belonged to the old session.
        lastProbe: p.lastProbe && Number.isFinite(p.lastProbe.at) && p.lastProbe.result === "ok" ? { at: p.lastProbe.at, result: "ok" } : null,
        lastNotifiedAt: Number.isFinite(p.lastNotifiedAt) ? p.lastNotifiedAt : null,
        lastNotifiedKey: typeof p.lastNotifiedKey === "string" ? p.lastNotifiedKey : null,
        // The key of the restored state, so a restart while the same failure stands is not a "change" (§7.7).
        key: restoredState ? notifyKey(restoredState, Array.isArray(p.reasons) ? p.reasons : []) : null,
        probing: false,
        inflight: null,
        debounce: null,
        pendingProbe: false,
      };
      mem.set(id, m);
    }
    return m;
  };

  const egress = { ip: null, family: persisted.egress?.family ?? null, at: null, okAt: null, seenBy: persisted.egress?.seenBy ?? detector.seenBy ?? null, error: null, clockSkewMs: null, lastLookupAt: null, inflight: null };
  let preopenLastRunDate = persisted.preopen?.lastRunDate ?? null;
  let transitions = [...(persisted.transitions ?? [])];
  let lastCycleAt = null;
  let started = false;
  let tickHandle = null;
  let startupHandle = null;
  const offs = [];
  const demoSent = [];
  let dirty = false;

  // ───────────────────────────── helpers ─────────────────────────────

  const configAccount = (id) => (config.accounts ?? []).find((a) => a.id === id) ?? null;
  /** Accounts the monitor tracks: every enabled-or-not account that is not a paper account (demo: the demo account). */
  const tracked = () => (sim ? sim.accountIds.map(configAccount).filter(Boolean) : (config.accounts ?? []).filter((a) => a.broker !== "paper"));
  const isTracked = (id) => tracked().some((a) => a.id === id);

  const softAudit = async (input) => {
    if (!audit) return;
    try {
      await audit.append(input);
    } catch (err) {
      log?.warn?.("readiness audit append failed", { type: input.type, code: err?.code });
    }
  };
  const emit = (payload) => {
    try {
      bus?.emit("trading.readiness", payload);
    } catch (err) {
      log?.warn?.("trading.readiness could not be emitted", { err: err?.message });
    }
  };

  const calendarSource = () => (reference ? "reference" : "weekday");
  function isTradingDay(date) {
    if (sim) return true;
    if (reference) {
      try {
        return Boolean(reference.calendar().isTradingDay(date, "NFO"));
      } catch {
        /* fall back */
      }
    }
    // lib/marketHours.mjs: weekdays, plus any special session (a Saturday budget day, Muhurat) the operator listed.
    try {
      return marketSession(new Date(istInstant(date, "12:00"))).label !== "Weekend";
    } catch {
      const d = new Date(`${date}T00:00:00Z`).getUTCDay();
      return d >= 1 && d <= 5;
    }
  }
  function closeMsFor(t) {
    const d = istDate(t);
    if (reference) {
      try {
        const s = reference.session("NFO", t);
        if (s?.close && /^\d{2}:\d{2}$/.test(s.close)) return istInstant(d, s.close);
      } catch {
        /* fall back */
      }
    }
    return istInstant(d, "15:30");
  }

  const policyCooldown = (account) => {
    try {
      return probeCooldownSeconds(scheduler?.policyFor(account.broker), cfg.probe.endpointClass, cfg.probe.cooldownSeconds);
    } catch {
      return cfg.probe.cooldownSeconds;
    }
  };

  const withTimeout = (promise, ms, fallback) =>
    new Promise((resolve) => {
      let done = false;
      const h = timers.setTimeout(() => {
        if (!done) {
          done = true;
          resolve(fallback());
        }
      }, ms);
      h?.unref?.();
      promise.then(
        (v) => {
          if (done) return;
          done = true;
          timers.clearTimeout(h);
          resolve(v);
        },
        (err) => {
          if (done) return;
          done = true;
          timers.clearTimeout(h);
          resolve(fallback(err));
        },
      );
    });

  // ───────────────────────────── egress ─────────────────────────────

  function feedSafety() {
    if (typeof safety?.setDetectedEgressIp !== "function" || sim) return;
    try {
      if (cfg.egressIp.mode === "lookup") safety.setDetectedEgressIp(egress.ip);
      else if (cfg.egressIp.mode === "manual") safety.setDetectedEgressIp(normaliseIp(cfg.egressIp.manualIp ?? "")?.ip ?? null);
      else safety.setDetectedEgressIp(null);
    } catch (err) {
      log?.warn?.("could not pass the egress IP to safety", { err: err?.message });
    }
  }

  /** One shared lookup with a 30 s cooldown. Returns "egress:cooldown" when skipped. */
  async function refreshEgress(skipped) {
    if (sim || cfg.egressIp.mode !== "lookup") return;
    if (egress.inflight) return egress.inflight;
    if (egress.lastLookupAt !== null && now() - egress.lastLookupAt < EGRESS_COOLDOWN_MS) {
      skipped?.add("egress:cooldown");
      return;
    }
    egress.lastLookupAt = now();
    const run = (async () => {
      const r = await detector.lookup();
      if (r.ok) {
        Object.assign(egress, { ip: r.ip, family: r.family, at: r.at, okAt: r.at ?? now(), seenBy: r.seenBy ?? detector.seenBy ?? null, error: null, clockSkewMs: r.clockSkewMs ?? null });
        feedSafety();
      } else {
        Object.assign(egress, { at: r.at ?? now(), error: r.error ?? "lookup failed", seenBy: r.seenBy ?? egress.seenBy });
      }
    })();
    egress.inflight = run;
    run.finally(() => {
      if (egress.inflight === run) egress.inflight = null;
    });
    return run;
  }

  // ───────────────────────────── probe ─────────────────────────────

  async function probe(account, skipped) {
    if (!cfg.probe.enabled) return;
    const m = memFor(account.id);
    if (sim?.isSimulated(account.id)) {
      const o = sim.probeOverride(account.id);
      if (o) {
        m.lastProbe = { at: now(), result: o };
        return;
      }
      // The simulated refusal is over (restored or timed out): probe the demo adapter afresh.
      if (m.lastProbe && m.lastProbe.result !== "ok") m.lastProbe = null;
    }
    let st;
    try {
      st = accounts.status(account.id)?.state;
    } catch {
      st = "error";
    }
    if (st !== "connected") return;
    const cooldownMs = policyCooldown(account) * 1000;
    if (m.lastProbe && now() - m.lastProbe.at < cooldownMs) {
      skipped?.add(`probe:${account.id}:cooldown`);
      return;
    }
    const cls = cfg.probe.endpointClass;
    // The simulated demo account is probed on the demo adapter, which answers locally: no broker budget to protect.
    const local = Boolean(sim?.isSimulated(account.id));
    if (gate && !local) {
      try {
        if (!gate.allow(account.id, cls, { share: MAX_BACKGROUND_SHARE })) {
          skipped?.add(`probe:${account.id}:budget`);
          return;
        }
      } catch {
        /* a scheduler without this account: let schedule() decide */
      }
    }
    const run = () => accounts.testConnection(account.id);
    m.probing = true;
    try {
      m.lastProbe = { at: now(), result: await probeResult(account, run, cls, local) };
    } finally {
      m.probing = false;
    }
  }

  async function probeResult(account, run, cls, local) {
    const call = scheduler && !local
      ? scheduler.schedule({ accountId: account.id, endpointClass: cls, priority: "background", backgroundShare: MAX_BACKGROUND_SHARE, coalesceKey: `readiness-probe:${account.id}`, maxWaitMs: cfg.probe.timeoutMs }, run)
      : run();
    const r = await withTimeout(Promise.resolve(call), cfg.probe.timeoutMs, (err) => ({ ok: false, timeout: !err, error: err }));
    let result;
    if (r?.ok === true) result = "ok";
    else {
      let after;
      try {
        after = accounts.status(account.id)?.state;
      } catch {
        after = null;
      }
      const code = r?.error?.code;
      result = after === "expired" || code === "SESSION_EXPIRED" || code === "SESSION_LOGIN_REQUIRED" || code === "UPSTREAM_AUTH" ? "rejected" : "error";
    }
    return result;
  }

  // ───────────────────────────── evaluate ─────────────────────────────

  function inputsFor(account) {
    const id = account.id;
    const simulated = Boolean(sim?.isSimulated(id));
    let real;
    try {
      real = accounts.status(id);
    } catch {
      real = { state: "error", expiresAt: null, message: null };
    }
    const session = simulated ? sim.session(real) : real;
    const live = simulated
      ? sim.live()
      : { globalLiveTrading: Boolean(config.safety?.liveTrading), accountLiveEnabled: Boolean(account.live?.enabled), allowedByConfig: liveAllowedByConfig(config, account) };
    let lim;
    if (simulated) lim = sim.limits(id);
    else {
      const l = safety.limits(id);
      lim = {
        perSecond: l.limits.orderRatePerSecond,
        usedLastSecond: l.usage.ordersLastSecond ?? 0,
        dailyMaxOrders: l.limits.dailyMaxOrders,
        ordersToday: l.usage.ordersToday ?? 0,
        dailyMaxLoss: l.limits.dailyMaxLoss,
        pnlToday: l.usage.realisedPnlToday ?? 0,
        source: null,
      };
    }
    let broker = null;
    let backoffMs = 0;
    if (scheduler) {
      try {
        const h = scheduler.headroom(id, "order");
        let verified = null;
        try {
          verified = scheduler.policyFor(account.broker)?.limits?.order?.verified ?? null;
        } catch {
          /* unknown */
        }
        broker = { remaining: h.remaining, limit: h.limit, resetMs: h.resetMs, source: `brokerPolicies (verified: ${verified === true})` };
      } catch {
        broker = null;
      }
      try {
        const u = scheduler.usage()?.accounts?.find((a) => a.accountId === id);
        backoffMs = Number(u?.classes?.order?.backoffMs) || 0;
      } catch {
        backoffMs = 0;
      }
    }
    const eg = simulated
      ? sim.egress()
      : {
          mode: cfg.egressIp.mode,
          registeredIp: account.live?.registeredIp ?? null,
          backupIp: account.live?.backupIp ?? null,
          detected: cfg.egressIp.mode === "lookup" ? { ip: egress.ip, family: egress.family, at: egress.at, okAt: egress.okAt, seenBy: egress.seenBy, error: egress.error, clockSkewMs: egress.clockSkewMs } : { at: null, seenBy: "as entered" },
        };
    return { session, live, lim, broker, backoffMs, eg, simulated };
  }

  function computeAndApply(account) {
    const t = now();
    const id = account.id;
    const m = memFor(id);
    const inp = inputsFor(account);
    const who = { label: account.label ?? id, brokerName: brokerNameOf(account.broker) };
    const s = sessionCheck({ session: inp.session, probe: m.lastProbe, probeRequired: cfg.probe.enabled, now: t, warnMinutes: cfg.warn.sessionExpiresWithinMinutes, closeMs: inp.simulated ? Infinity : closeMsFor(t), expirySource: inp.simulated ? "simulated" : "broker-stated", maxProbeAgeMs });
    const e = egressCheck({ mode: inp.eg.mode, registeredIp: inp.eg.registeredIp, backupIp: inp.eg.backupIp, manualIp: cfg.egressIp.manualIp, detected: inp.eg.detected, now: t, intervalMinutes, maxSkewMs: cfg.egressIp.maxSkewMs, who });
    const r = rateCheck({ perSecond: inp.lim.perSecond, usedLastSecond: inp.lim.usedLastSecond, broker: inp.broker, backoffMs: inp.backoffMs });
    const o = dailyOrdersCheck({ limit: inp.lim.dailyMaxOrders, used: inp.lim.ordersToday, leftPct: cfg.warn.dailyOrdersLeftPct });
    const l = dailyLossCheck({ limit: inp.lim.dailyMaxLoss, pnlToday: inp.lim.pnlToday, leftPct: cfg.warn.dailyLossLeftPct, source: inp.lim.source });
    let ks;
    try {
      ks = safety.killSwitchStatus();
    } catch {
      ks = { engaged: false };
    }
    const k = killSwitchCheck(ks);
    const lc = liveConfigCheck(inp.live);
    if (inp.lim.source) {
      r.check.source = inp.lim.source;
      o.check.source = inp.lim.source;
    }
    const checks = { session: s.check, egress: e.check, orderRate: r.check, dailyOrders: o.check, dailyLoss: l.check, killSwitch: k.check };
    const reasons = [...lc.reasons, ...s.reasons, ...e.reasons, ...r.reasons, ...o.reasons, ...l.reasons, ...k.reasons];
    const c = combine({ allowedByConfig: inp.live.allowedByConfig, checks, reasons, checkedAt: t, now: t, staleAfterMinutes: cfg.staleAfterMinutes });
    const from = m.result?.state ?? m.prevState ?? "unknown";
    const key = notifyKey(c.state, c.reasons);
    const failKey = notifyFailKey(c.state, c.reasons);
    if (c.state !== from || !m.since) m.since = istIso(t);
    m.result = {
      accountId: id,
      broker: account.broker,
      brokerName: who.brokerName,
      label: account.label ?? null,
      simulated: inp.simulated,
      live: inp.live,
      state: c.state,
      since: m.since,
      checkedAt: istIso(t),
      checkedAtMs: t,
      stale: false,
      reasons: c.reasons,
      checks,
    };
    if (c.state !== from) {
      const codes = c.reasons.map((x) => x.code);
      transitions.push({ at: istIso(t), accountId: id, from, to: c.state, codes });
      if (transitions.length > TRANSITIONS_KEPT) transitions = transitions.slice(-TRANSITIONS_KEPT);
      dirty = true;
      void softAudit({ type: "readiness.changed", actor: { kind: "system", id: "readiness" }, source: "system", accountId: id, data: { from, to: c.state, codes } });
      registry.notify({ accountId: id, state: c.state, reasons: c.reasons, at: istIso(t) });
    }
    if (c.state !== from || key !== m.key) {
      const d = shouldNotify({ from, to: c.state, key: failKey, lastKey: m.lastNotifiedKey, lastAt: m.lastNotifiedAt, now: t, cooldownMinutes: cfg.notify.cooldownMinutes, onRecovery: cfg.notify.onRecovery });
      const autos = registry.byAccount(id);
      const payload = {
        accountId: id,
        broker: account.broker,
        brokerName: who.brokerName,
        label: account.label ?? null,
        state: c.state,
        previous: from,
        kind: d.kind,
        reasons: c.reasons.map((x) => ({ check: x.check, code: x.code, severity: x.severity, message: x.message })),
        automations: { total: autos.length, live: autos.filter((a) => a.mode === "live").length },
        notify: d.notify,
        simulated: inp.simulated,
        at: istIso(t),
      };
      if (d.notify && c.state === "cannot_trade") {
        m.lastNotifiedAt = t;
        m.lastNotifiedKey = failKey;
        dirty = true;
      }
      emit(payload);
      if (d.notify) recordDemoMessage(payload);
    }
    m.key = key;
    m.prevState = c.state;
    return m.result;
  }

  function recordDemoMessage(payload) {
    if (!sim) return;
    const { title, text } = formatEvent("trading.readiness", payload);
    demoSent.push({ at: payload.at, title, text });
    if (demoSent.length > DEMO_SENT_KEPT) demoSent.splice(0, demoSent.length - DEMO_SENT_KEPT);
  }

  /** Singleflight evaluation of one account. */
  function evaluate(account, { probe: doProbe = false, egress: doEgress = false, skipped } = {}) {
    const m = memFor(account.id);
    if (m.inflight) return m.inflight;
    const run = (async () => {
      try {
        // Side by side: one evaluation takes max(probe, egress) time, not their sum (§7.5).
        await Promise.all([doEgress ? refreshEgress(skipped) : null, doProbe ? probe(account, skipped) : null]);
        return computeAndApply(account);
      } catch (err) {
        log?.warn?.("readiness evaluation failed", { accountId: account.id, err: err?.message });
        return m.result;
      }
    })();
    // Cleared after the run settles (the body can finish synchronously, before this assignment).
    m.inflight = run;
    run.finally(() => {
      if (m.inflight === run) m.inflight = null;
    });
    return run;
  }

  async function evaluateAll(opts = {}) {
    const list = tracked();
    const out = await Promise.all(list.map((a) => evaluate(a, opts)));
    persist();
    return out;
  }

  function persist(force = false) {
    if (!store || (!dirty && !force)) return;
    const accountsState = {};
    for (const a of tracked()) {
      const m = memFor(a.id);
      accountsState[a.id] = {
        state: m.result?.state ?? m.prevState,
        since: m.since,
        checkedAt: m.result?.checkedAt ?? null,
        reasons: m.result?.reasons ?? [],
        lastProbe: m.lastProbe,
        lastNotifiedAt: m.lastNotifiedAt,
        lastNotifiedKey: m.lastNotifiedKey,
      };
    }
    const matchesByAccount = {};
    for (const a of tracked()) {
      const v = memFor(a.id).result?.checks?.egress?.matches;
      if (typeof v === "boolean") matchesByAccount[a.id] = v;
    }
    store.save({ version: 1, accounts: accountsState, egress: { at: egress.at, family: egress.family, seenBy: egress.seenBy, matchesByAccount }, preopen: { lastRunDate: preopenLastRunDate }, transitions });
    dirty = false;
  }

  // ───────────────────────────── schedule ─────────────────────────────

  async function runPreopen(t) {
    preopenLastRunDate = istDate(t);
    lastCycleAt = t;
    dirty = true;
    await evaluateAll({ probe: true, egress: true });
    const results = tracked().map((a) => memFor(a.id).result).filter(Boolean);
    const failing = results.filter((r) => r.state !== "ready" && r.state !== "paper_only");
    await softAudit({ type: "readiness.preopen", actor: { kind: "system", id: "readiness" }, source: "system", data: { accounts: results.length, failing: failing.map((r) => r.accountId) } });
    const counted = results.filter((r) => r.state !== "paper_only");
    if (!counted.length) return;
    if (!failing.length && cfg.notify.preopenOnlyIfFailing) return;
    const payload = {
      accountId: null,
      kind: "preopen",
      preOpenAt: cfg.preOpenAt,
      state: worstState(counted.map((r) => r.state)),
      previous: null,
      accounts: counted.map((r) => ({ accountId: r.accountId, broker: r.broker, brokerName: r.brokerName, label: r.label, state: r.state, reasons: r.reasons.map((x) => ({ code: x.code, severity: x.severity, message: x.message })) })),
      cannotTrade: counted.filter((r) => r.state === "cannot_trade").length,
      needAttention: failing.length,
      holidayCaveat: reference ? null : HOLIDAY_CAVEAT,
      automations: { total: registry.count(), live: registry.list().filter((a) => a.mode === "live").length },
      notify: true,
      simulated: counted.some((r) => r.simulated),
      at: istIso(t),
    };
    emit(payload);
    recordDemoMessage(payload);
    persist(true);
  }

  /** The 60 s tick (also called by tests and e2e after moving the clock). */
  async function tick() {
    if (!cfg.enabled) return;
    const t = now();
    if (sim) {
      if (lastCycleAt === null || t - lastCycleAt >= intervalMinutes * 60_000 - 2000) {
        lastCycleAt = t;
        await evaluateAll({ probe: true, egress: true });
      }
      return;
    }
    const lastRunDate = preopenLastRunDate;
    if (preopenDue(t, { preOpenAt: cfg.preOpenAt, jitterSeconds: jitter, window: cfg.window, isTradingDay, lastRunDate })) {
      await runPreopen(t);
      return;
    }
    if (cycleDue(t, { window: cfg.window, intervalMinutes, jitterSeconds: jitter, isTradingDay, lastCycleAt })) {
      lastCycleAt = t;
      await evaluateAll({ probe: true, egress: true });
    }
  }

  function scheduleFor(id, { probe: doProbe }) {
    if (!started || !cfg.enabled) return;
    const account = tracked().find((a) => a.id === id);
    if (!account) return;
    const m = memFor(id);
    m.pendingProbe = m.pendingProbe || doProbe;
    if (m.debounce) return;
    m.debounce = timers.setTimeout(() => {
      m.debounce = null;
      const p = m.pendingProbe;
      m.pendingProbe = false;
      // Bus triggers probe whenever asked (a login at 08:30 or after the close is the normal case): the probe cooldown
      // and the background gate bound the cost. Only the startup run is limited to the window.
      void evaluate(account, { probe: p, egress: false }).then(() => persist());
    }, DEBOUNCE_MS);
    m.debounce?.unref?.();
  }

  function listen() {
    const on = (topic, fn) => {
      const off = bus?.on?.(topic, (p) => {
        try {
          fn(p);
        } catch (err) {
          log?.warn?.("readiness bus handler failed", { topic, err: err?.message });
        }
      });
      if (off) offs.push(off);
    };
    on("account.status", (p) => {
      if (!p?.accountId) return;
      const m = memFor(p.accountId);
      // A new session supersedes an earlier refusal: probe it afresh.
      if (p.session === "connected" && m.lastProbe && m.lastProbe.result !== "ok") m.lastProbe = null;
      scheduleFor(p.accountId, { probe: p.session === "connected" });
    });
    on("account.session_rejected", (p) => {
      if (!p?.accountId || !isTracked(p.accountId)) return;
      memFor(p.accountId).lastProbe = { at: now(), result: "rejected" };
      scheduleFor(p.accountId, { probe: false });
    });
    on("safety.kill_switch", () => {
      for (const a of tracked()) scheduleFor(a.id, { probe: false });
    });
    on("safety.limit", (p) => {
      if (p?.accountId) scheduleFor(p.accountId, { probe: false });
    });
  }

  // ───────────────────────────── snapshot ─────────────────────────────

  function placeholder(account) {
    const simulated = Boolean(sim?.isSimulated(account.id));
    const live = simulated ? sim.live() : { globalLiveTrading: Boolean(config.safety?.liveTrading), accountLiveEnabled: Boolean(account.live?.enabled), allowedByConfig: liveAllowedByConfig(config, account) };
    const unknown = { status: "unknown", message: "Still checking" };
    return {
      accountId: account.id,
      broker: account.broker,
      brokerName: brokerNameOf(account.broker),
      label: account.label ?? null,
      simulated,
      live,
      state: live.allowedByConfig ? "unknown" : "paper_only",
      since: memFor(account.id).since,
      checkedAt: null,
      checkedAtMs: null,
      stale: true,
      reasons: [],
      checks: { session: unknown, egress: unknown, orderRate: unknown, dailyOrders: unknown, dailyLoss: unknown, killSwitch: unknown },
    };
  }

  function viewOf(account) {
    const m = memFor(account.id);
    const base = m.result ?? placeholder(account);
    const t = now();
    const stale = base.checkedAtMs === null ? true : isStale(base.checkedAtMs, t, cfg.staleAfterMinutes);
    let state = base.state;
    let reasons = base.reasons;
    if (stale && (state === "ready" || state === "warn")) {
      state = "unknown";
      reasons = [...reasons, { check: "readiness", code: "STALE", severity: "warn", message: "Not checked recently." }];
    }
    const autos = registry.byAccount(account.id).map((a) => ({ id: a.id, kind: a.kind, label: a.label, mode: a.mode, state: a.mode === "paper" ? "ready" : state }));
    const { checkedAtMs: _ms, ...rest } = base;
    return { ...rest, state, reasons, stale, automations: autos, _checkedAtMs: base.checkedAtMs };
  }

  function status({ accountIds } = {}) {
    const t = now();
    if (!cfg.enabled) return { overall: "unknown", disabled: true, summary: "Readiness checks are off (readiness.enabled is false).", checkedAt: null, accounts: [], paperOnly: false, method: METHOD_TEXT };
    const want = Array.isArray(accountIds) ? new Set(accountIds) : null;
    const views = tracked()
      .filter((a) => !want || want.has(a.id))
      .map(viewOf);
    const counted = views.filter((v) => v.live.allowedByConfig);
    const overall = worstState(views.map((v) => v.state));
    const cannot = counted.filter((v) => v.state === "cannot_trade").length;
    const summary = !counted.length
      ? "No account is set up for live trading (paper only)"
      : cannot
        ? `${cannot} of ${counted.length} live account${counted.length === 1 ? "" : "s"} cannot trade`
        : overall === "ready"
          ? `${counted.length === 1 ? "The live account is" : `All ${counted.length} live accounts are`} ready`
          : overall === "warn"
            ? `${counted.filter((v) => v.state === "warn").length} of ${counted.length} live account${counted.length === 1 ? "" : "s"} need attention`
            : "Still checking";
    const latest = views.reduce((mx, v) => (Number.isFinite(v._checkedAtMs) && v._checkedAtMs > mx ? v._checkedAtMs : mx), -Infinity);
    const autos = registry.list().filter((a) => !want || want.has(a.accountId));
    const stateById = new Map(views.map((v) => [v.accountId, v.state]));
    const targets = (config.notify?.targets ?? []).filter((x) => x.enabled !== false && Array.isArray(x.events) && x.events.includes("trading.readiness")).map((x) => x.id);
    const window = sim ? { from: "00:00", to: "23:59" } : cfg.window;
    const egressMode = sim ? (sim.scenario() === "ip-unchecked" ? "off" : "lookup") : cfg.egressIp.mode;
    const simEgress = sim ? sim.egress() : null;
    return {
      overall,
      summary,
      checkedAt: Number.isFinite(latest) ? istIso(latest) : null,
      accounts: views.map(({ _checkedAtMs, ...v }) => v),
      paperOnly: counted.length === 0,
      egress: sim
        ? { mode: egressMode, checkedAt: istIso(t), family: "ipv4", seenBy: simEgress.detected.seenBy, ip: simEgress.mode === "off" ? null : simEgress.detected.ip, clockSkewMs: null, lastError: null, simulated: true }
        : { mode: egressMode, checkedAt: egress.at ? istIso(egress.at) : null, family: egress.family, seenBy: egressMode === "lookup" ? egress.seenBy : egressMode === "manual" ? "as entered" : null, ip: egressMode === "lookup" ? egress.ip : egressMode === "manual" ? normaliseIp(cfg.egressIp.manualIp ?? "")?.ip ?? null : null, clockSkewMs: egress.clockSkewMs, lastError: egress.error },
      schedule: {
        intervalMinutes,
        window,
        inWindow: sim ? true : inWindow(t, cfg.window),
        tradingDay: isTradingDay(istDate(t)),
        calendarSource: sim ? "demo" : calendarSource(),
        nextCheckAt: istIso(sim ? (lastCycleAt ?? t) + intervalMinutes * 60_000 : nextCycleAt(t, { window: cfg.window, intervalMinutes, jitterSeconds: jitter, isTradingDay, lastCycleAt })),
        preOpen: { at: cfg.preOpenAt, lastRunDate: preopenLastRunDate, nextRunAt: sim ? null : istIso(nextPreOpenAt(t, { preOpenAt: cfg.preOpenAt, jitterSeconds: jitter, isTradingDay, lastRunDate: preopenLastRunDate })) },
        ...(sim ? { demo: { scenario: sim.scenario(), restoresAt: sim.restoresAt() ? istIso(sim.restoresAt()) : null, restoreAfterMinutes: sim.restoreAfterMinutes } } : {}),
      },
      automations: { total: autos.length, live: autos.filter((a) => a.mode === "live").length, cannotTrade: autos.filter((a) => a.mode === "live" && stateById.get(a.accountId) === "cannot_trade").length },
      notifications: {
        targetsListening: targets,
        warning: targets.length ? null : "No notification target listens to trading.readiness. Add it to notify.targets[].events.",
        demoOff: Boolean(sim),
        ...(sim ? { wouldHaveSent: [...demoSent].reverse() } : {}),
      },
      method: METHOD_TEXT,
    };
  }

  function canTrade(accountId, { mode } = {}) {
    const t = now();
    if (mode === "paper") return { ok: true, state: "ready", reasons: [], checkedAt: null, stale: false };
    if (!cfg.enabled) return { ok: true, state: "unknown", reasons: [{ check: "readiness", code: "READINESS_OFF", severity: "warn", message: "readiness checks are off" }], checkedAt: null, stale: false, disabled: true };
    const account = tracked().find((a) => a.id === accountId);
    if (!account) return { ok: true, state: "paper_only", reasons: [], checkedAt: null, stale: false };
    const v = viewOf(account);
    const stale = v._checkedAtMs === null ? true : isStale(v._checkedAtMs, t, cfg.staleAfterMinutes);
    return { ok: v.state === "ready" || v.state === "warn" || v.state === "paper_only", state: v.state, reasons: v.reasons, checkedAt: v.checkedAt, stale };
  }

  async function ensureFresh(accountId, { maxAgeMs = 60_000, timeoutMs = 5_000 } = {}) {
    const account = tracked().find((a) => a.id === accountId);
    if (!account || !cfg.enabled) return canTrade(accountId, {});
    const m = memFor(accountId);
    const fresh = m.result && Number.isFinite(m.result.checkedAtMs) && now() - m.result.checkedAtMs <= maxAgeMs && m.result.state !== "unknown";
    if (!fresh) await withTimeout(evaluate(account, { probe: true, egress: true }), timeoutMs, () => null);
    return canTrade(accountId, {});
  }

  /**
   * accountId: one account; accountIds: only these (the route passes the ids the caller's key may see); neither: all.
   */
  async function checkNow({ accountId, accountIds, reason = "manual" } = {}) {
    const skipped = new Set();
    let list = tracked();
    if (accountId) {
      list = list.filter((a) => a.id === accountId);
      if (!list.length) {
        if (!configAccount(accountId)) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${accountId}" in bridge.config.json.`);
      }
    } else if (Array.isArray(accountIds)) {
      const want = new Set(accountIds);
      list = list.filter((a) => want.has(a.id));
    }
    void reason;
    let timedOut = false;
    if (cfg.enabled) {
      const work = Promise.all(list.map((a) => evaluate(a, { probe: true, egress: true, skipped }))).then(() => persist());
      await withTimeout(work, CHECK_WAIT_MS, () => {
        timedOut = true;
        return null;
      });
    }
    const snapshot = status({ accountIds: accountId ? [accountId] : Array.isArray(accountIds) ? accountIds : undefined });
    if (timedOut) {
      // §4.2: the parts still running carry status unknown / "Still checking" (not the previous answer).
      const still = { status: "unknown", message: "Still checking" };
      snapshot.accounts = snapshot.accounts.map((v) => {
        const probing = memFor(v.accountId).probing;
        const looking = Boolean(egress.inflight) && cfg.egressIp.mode === "lookup" && !v.simulated;
        if (!probing && !looking) return v;
        const checks = { ...v.checks };
        if (probing) checks.session = { ...checks.session, ...still };
        if (looking) checks.egress = { ...checks.egress, ...still };
        return { ...v, checks };
      });
    }
    return { snapshot, skipped: [...skipped] };
  }

  const service = {
    status,
    canTrade,
    ensureFresh,
    async check(opts = {}) {
      return (await checkNow(opts)).snapshot;
    },
    registerAutomation(input) {
      return registry.register(input);
    },

    // ── Extras beyond the contract (module, routes, demo, tests) ──
    checkNow,
    tick,
    /** Transitions, newest first. */
    history({ accountIds, limit = 50 } = {}) {
      const want = Array.isArray(accountIds) ? new Set(accountIds) : null;
      return transitions.filter((x) => !want || want.has(x.accountId)).slice(-limit).reverse();
    },
    transitionsKept: TRANSITIONS_KEPT,
    /** Ids of the accounts the monitor tracks. */
    trackedIds: () => tracked().map((a) => a.id),
    automations: () => registry.list().map(({ onState: _f, ...a }) => a),
    /** Demo only: apply a scenario and re-evaluate the simulated account at once. */
    async demoScenario(name) {
      if (!sim) throw new BridgeError("NOT_FOUND", "Readiness scenarios exist only in demo mode.");
      sim.apply(name);
      // Each scenario starts from a fresh probe (the demo adapter answers locally, so this costs nothing).
      memFor(sim.accountIds[0]).lastProbe = null;
      await Promise.all(tracked().map((a) => evaluate(a, { probe: true, egress: false })));
      persist();
      return status();
    },
    start() {
      if (started) return;
      started = true;
      for (const w of readinessWarnings(cfg)) log?.warn?.(w);
      feedSafety();
      if (!cfg.enabled) return;
      listen();
      tickHandle = timers.setInterval(() => {
        void tick().catch((err) => log?.warn?.("readiness tick failed", { err: err?.message }));
      }, TICK_MS);
      tickHandle?.unref?.();
      startupHandle = timers.setTimeout(() => {
        startupHandle = null;
        const t = now();
        const inside = sim ? true : isTradingDay(istDate(t)) && inWindow(t, cfg.window);
        if (sim) lastCycleAt = t;
        void evaluateAll({ probe: inside, egress: inside }).then(() => tick());
      }, sim ? 0 : STARTUP_DELAY_MS);
      startupHandle?.unref?.();
    },
    stop() {
      started = false;
      if (tickHandle) timers.clearInterval(tickHandle);
      if (startupHandle) timers.clearTimeout(startupHandle);
      tickHandle = null;
      startupHandle = null;
      for (const m of mem.values()) {
        if (m.debounce) timers.clearTimeout(m.debounce);
        m.debounce = null;
      }
      for (const off of offs.splice(0)) off();
      persist();
    },
    /** For tests: the window start minute (sanity) and the jitter in use. */
    _debug: () => ({ jitter, windowFrom: hhmmMinutes(cfg.window.from), lastCycleAt, preopenLastRunDate, egressInMemory: Boolean(egress.ip) }),
  };
  if (sim) for (const a of DEMO_SAMPLE_AUTOMATIONS) registry.register(a);
  return service;
}
