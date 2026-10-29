/**
 * Recorder service (stream S17, docs/spec/p1-01-recorder.md §3.2, §4, §5, §8, M1–M13): the orchestrator.
 *
 *  - Chooses ONE data account (`recorder.account`, else the first connected account that serves option chains) and
 *    never reads another holder's account: REST is pinned to it and the stream is used only when the hub's feed for
 *    the data account is the one that feeds.
 *  - Plans (plan.mjs) on start, on a config change, on account or feed status changes and every 5 minutes in session.
 *  - Runs one minute loop (deps.clock timers when present, else unref'd globals): at each slot + `slotOffsetMs` it
 *    builds the stream snapshots (each in its own setImmediate turn) and dispatches the REST reads spread over
 *    `restSpreadMs`; every due chain-slot ends as a snapshot or a gap record with its reason. The same loop runs the
 *    daily S3 job (`dailyAt`, retry at 15:45), the day roll (15:40 or 10 minutes after a later session end),
 *    retention, re-centring and the holiday detector.
 *  - On restart it writes `bridge-down` gaps for the slots missed today and resumes at the next slot.
 *  - Demo mode records into <dataDir>/recorder-demo/ on an "always open" clock, synthesises a back-fill
 *    (demoBackfill.mjs) and keeps config changes in memory only.
 *
 * Imports nothing from orders/, paper/ or safety/ (module.test.mjs checks): the recorder can never place an order.
 */
import { join } from "node:path";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { formatSymbol, parseSymbol } from "../core/symbolFormat.mjs";
import { legSymbol } from "../market/chain.mjs";
import { oiUnitVerified } from "../market/oiUnits.mjs";
import { toIstIso } from "../market/time.mjs";
import { kindOf, pricingContext } from "../vol/context.mjs";
import { createRecorderBudget } from "./budget.mjs";
import { createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { HOLIDAY_DETECT_SLOTS, MINUTE_MS, cadenceAt, expectedMinutesBetween, expectedSlotsBy, holidaySuspected, isDue, istDateOf, istMidnight, nextSlotAfter, resolveDay, slotFloor, slotsOfDay } from "./calendar.mjs";
import { RECORDER_CONFIG_SCHEMA, recorderSettings } from "./config.mjs";
import { dailyRow } from "./daily.mjs";
import { demoKeepDays, runDemoBackfill } from "./demoBackfill.mjs";
import { capacityPayload, feedCapFor, planRecording } from "./plan.mjs";
import { builtChainCost, createRestSource } from "./restSource.mjs";
import { buildSnapshot, gapRecord, projectSnapshot } from "./snapshot.mjs";
import { createSnapshotStore } from "./store.mjs";
import { createStreamSource } from "./streamSource.mjs";

const REPLAN_MS = 5 * MINUTE_MS;
const STATUS_EMIT_MS = 1000;
const RECENTRE_STRIKES = 2;
/** The daily job's one retry (§3.2), minutes after IST midnight. */
const RETRY_MIN = 15 * 60 + 45;
const JOB_TIMEOUT_MS = 55_000;
const DEMO_RETENTION_DAYS = 3;
const MASTER_PAGE_LIMIT = 500;
const MASTER_MAX_PAGES = 20;
const BSE_INDICES = new Set(["SENSEX", "BANKEX", "SENSEX50"]);
/** Key of the accounts a dry-run plan names (non-enumerable; see routes.mjs redactPlan). */
export const PLAN_ACCOUNTS = Symbol.for("mcb.recorder.planAccounts");
/** Stock underlyings the demo adapter lists options for (P1-1 §8; P1-6 extends to all 50). */
export const DEMO_OPTION_STOCKS = Object.freeze(["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "SBIN"]);

/** Plain cost notes per broker (docs/guides/recorder.md §Costs). */
const COST_NOTES = Object.freeze({
  dhan: "Dhan data APIs may need a paid plan (needs verification).",
  zerodha: "Kite Connect market data comes with the paid Connect plan (needs verification).",
  upstox: "Upstox market-data APIs are free with the API plan (needs verification).",
  demo: "Sample data on this computer; no cost.",
});

const usable = (svc) => Boolean(svc) && !isStub(svc);
const chainKey = (u, x) => `${u}|${x}`;
const sleepTurn = () => new Promise((r) => setImmediate(r));
const hhmmMinutes = (s) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Canonical spot symbol of an underlying (NSE or BSE index / stock). */
export function spotSymbolOf(u) {
  return parseSymbol(`${BSE_INDICES.has(u) ? "BSE" : "NSE"}:${u}`).canonical;
}

/**
 * @param {object} deps  core deps plus marketData, streamHub, accounts, scheduler, symbols, reference, backupData
 */
export function createRecorderService(deps) {
  const { config, clock, bus } = deps;
  const log = deps.logger?.child ? deps.logger.child({ module: "recorder" }) : deps.logger;
  const demo = Boolean(config.demo);
  const now = () => clock.now();
  const setT =
    typeof clock.setTimeout === "function"
      ? (fn, ms) => clock.setTimeout(fn, ms)
      : (fn, ms) => {
          const h = setTimeout(fn, ms);
          h.unref?.();
          return h;
        };
  const clearT = typeof clock.clearTimeout === "function" ? (h) => clock.clearTimeout(h) : (h) => clearTimeout(h);

  let settings = recorderSettings(config);
  const root = join(config.dataDir, demo ? "recorder-demo" : "recorder");
  const store = createSnapshotStore({ root, clock, logger: log, retentionDays: demo ? DEMO_RETENTION_DAYS : settings.retentionDays, maxDiskMb: settings.maxDiskMb });
  const stream = usable(deps.streamHub) ? createStreamSource({ hub: deps.streamHub, maxPerClient: config.stream?.maxSymbolsPerClient ?? 500, maxPerRequest: config.stream?.maxSymbolsPerRequest ?? 200, logger: log }) : null;
  const rest = createRestSource({ marketData: deps.marketData, scheduler: deps.scheduler, backupData: deps.backupData });

  // ── state ──
  let started = false;
  let stopped = false;
  let timer = null;
  let lastPlanAt = 0;
  let replanTimer = null;
  let account = null; // { id, broker, chosen: "config"|"auto" }
  let plan = null;
  let policy = null;
  let budget = null;
  let endpointClass = "chain";
  /** Broker calls one REST chain read costs (1; a chain built from quotes: its quote batches plus a spot read). */
  let readCost = 1;
  /** A chain built from quotes reads every master leg of the expiry, up to market.chain.maxBuiltLegs. */
  const readCostFor = (cls, pol) => (cls === "quote" ? builtChainCost(config.market?.chain?.maxBuiltLegs ?? 400, pol?.maxQuoteBatch) : 1);
  const gate = usable(deps.scheduler) && typeof deps.scheduler.headroom === "function" ? createBackgroundGate({ scheduler: deps.scheduler }) : null;
  let feed = { cap: 0, onDataAccount: true, accountId: null, hasFeed: false };
  /** chain key -> runtime chain */
  const chains = new Map();
  /** chain key -> today's counters */
  const today = { date: null, byChain: new Map(), lastSnapshotAt: null };
  let persisted = loadState();
  let holidaySuspect = persisted.holidaySuspected ?? null;
  let lastStatusEmit = 0;
  let lastStatusState = null;
  let statusTimer = null;
  /** The live feed's refusal of some recorder symbols, rebuilt on every subscription sync (null when none). */
  let feedWarning = null;
  /** Why the configured account cannot be used (set by the applied plan only, so a dry run never leaves one). */
  let accountWarning = null;
  let error = null;
  const dailyDone = new Map(); // date -> "ok"|"failed"
  let lastDay = null;
  const masterCache = new Map(); // `${date}|${u}` -> info
  const offs = [];
  let backfill = null; // promise while running
  const holidayWatch = new Map(); // chain key -> { spots: [], volume }

  function loadState() {
    const s = store.readState();
    return s && typeof s === "object" ? s : { lastSlot: null, lastPlanHash: null, refused: [], warnings: [], holidaySuspected: null, demoBackfilledFor: null };
  }
  function saveState(patch = {}) {
    persisted = { ...persisted, ...patch };
    try {
      store.writeState(persisted);
    } catch (err) {
      log?.warn?.("recorder state could not be saved", { err: err?.message });
    }
  }

  // ── session ──
  const dayFor = (t) => resolveDay({ reference: deps.reference, exchange: "NFO", t, recordSpecialSessions: settings.recordSpecialSessions, alwaysOpen: demo && settings.demo.alwaysOpen });

  // ── masters (0 broker calls) ──
  async function masterInfo(u, date) {
    const key = `${date}|${u}`;
    if (masterCache.has(key)) return masterCache.get(key);
    const info = { kind: kindOf(u), exchange: null, expiries: [], lots: {}, strikes: {}, futures: [] };
    if (usable(deps.symbols)) {
      for (const kind of ["OPT", "FUT"]) {
        let cursor;
        for (let page = 0; page < MASTER_MAX_PAGES; page++) {
          const q = { q: u, underlying: u, kind, limit: MASTER_PAGE_LIMIT };
          if (cursor) q.cursor = cursor;
          let res;
          try {
            res = await deps.symbols.search(q);
          } catch {
            break;
          }
          for (const r of res?.items ?? []) {
            if (r?.underlying !== u || !r.expiry || r.expiry < date) continue;
            if (kind === "FUT") {
              if (!info.futures.includes(r.expiry)) info.futures.push(r.expiry);
              continue;
            }
            if (!(r.strike > 0)) continue;
            info.exchange ??= r.exchange;
            (info.strikes[r.expiry] ??= new Set()).add(r.strike);
            if (Number.isFinite(r.lotSize) && r.lotSize > 0) info.lots[r.expiry] = r.lotSize;
          }
          cursor = res?.nextCursor;
          if (!cursor) break;
        }
      }
    }
    info.expiries = Object.keys(info.strikes).sort();
    info.futures.sort();
    for (const x of info.expiries) info.strikes[x] = [...info.strikes[x]].sort((a, b) => a - b);
    if (masterCache.size > 400) masterCache.clear();
    if (info.expiries.length) masterCache.set(key, info);
    return info;
  }

  // ── account, policy, feed ──
  /** The data account for a settings object (the one being planned, not only the live one). */
  function chooseAccount(s) {
    if (!usable(deps.accounts)) return { acc: null, warning: null };
    if (demo) {
      const ids = deps.accounts.marketDataCandidates({ capability: "optionChain" }) ?? [];
      return { acc: ids[0] ? { id: ids[0], chosen: "auto" } : null, warning: null };
    }
    if (s.account) {
      const ids = deps.accounts.marketDataCandidates({ capability: "optionChain", accountId: s.account }) ?? [];
      if (!ids.length) return { acc: null, warning: `The recorder account ${s.account} is not connected or cannot serve option chains.` };
      return { acc: { id: s.account, chosen: "config" }, warning: null };
    }
    const ids = deps.accounts.marketDataCandidates({ capability: "optionChain" }) ?? [];
    return { acc: ids[0] ? { id: ids[0], chosen: "auto" } : null, warning: null };
  }

  function holderOf(id) {
    try {
      const h = deps.accounts.get(id)?.holder;
      return typeof h === "string" && h ? h : null;
    } catch {
      return null;
    }
  }

  function brokerOf(id) {
    try {
      return deps.accounts.get(id).broker;
    } catch {
      return null;
    }
  }

  function feedInfo(acc, pol) {
    let caps = [];
    try {
      caps = deps.accounts.capabilities(acc.id)?.capabilities ?? [];
    } catch {
      caps = [];
    }
    const hasFeed = caps.includes("feed");
    let feedIds = [];
    try {
      feedIds = deps.accounts.marketDataCandidates({ capability: "feed" }) ?? [];
    } catch {
      feedIds = [];
    }
    // The hub places each symbol on whichever feed candidate has the most room, so the stream counts as the data
    // account's only when every candidate it can place on is the data account or one of the same holder's.
    const holder = holderOf(acc.id);
    const onDataAccount = hasFeed && (feedIds.length === 0 || (feedIds.includes(acc.id) && feedIds.every((id) => id === acc.id || (holder !== null && holderOf(id) === holder))));
    // The smaller of what the hub enforces for this feed and what the broker policy states (§5.1 rule 1).
    const health = stream?.health(acc.id);
    const fromPolicy = feedCapFor(pol, hasFeed, config.stream?.maxSubscriptionsPerUpstream ?? null);
    const cap = typeof health?.limit === "number" && health.limit > 0 ? Math.min(health.limit, fromPolicy) : fromPolicy;
    return { cap: hasFeed ? cap : 0, onDataAccount, accountId: feedIds.find((id) => id !== acc.id) ?? feedIds[0] ?? null, hasFeed };
  }

  /** The recorder section in use (the config section merged with the changes saved while running). */
  let currentRaw = {};
  /** Whether a saved change gave a stock list (demo: the default five apply until then). */
  let stocksGiven = false;
  /**
   * Settings as planned: in demo, the five demo option stocks until a change saves a stock list (the config section
   * arrives filled with defaults, so its empty list does not count). A saved list, empty included, is used as given,
   * so the page can trim or clear the demo stocks.
   */
  const effectiveSettings = (s, given = stocksGiven) => (demo && s.stocks.length === 0 && !given ? { ...s, stocks: [...DEMO_OPTION_STOCKS] } : s);

  async function availability(s, date) {
    const out = {};
    for (const u of [...s.indices, ...s.stocks]) {
      const info = await masterInfo(u, date);
      if (info.expiries.length) out[u] = { kind: s.indices.includes(u) ? "index" : "stock", exchange: info.exchange, expiries: info.expiries };
    }
    return out;
  }

  /** Plan for a settings object (dry run when `apply` is false). */
  async function computePlan(s, { apply = false, stocksListed } = {}) {
    const eff = effectiveSettings(s, stocksListed);
    const { acc, warning } = chooseAccount(s);
    if (apply) accountWarning = warning;
    const date = istDateOf(now());
    if (!acc) return { plan: planRecording({ cfg: eff, account: null, policy: null, feedCap: 0, available: {} }), acc: null };
    const broker = brokerOf(acc.id);
    let pol = null;
    try {
      pol = deps.scheduler.policyFor(broker);
    } catch {
      pol = null;
    }
    const cls = config.market?.chain?.source === "built" ? "quote" : "chain";
    const perRead = readCostFor(cls, pol);
    const f = feedInfo(acc, pol);
    const available = await availability(eff, date);
    const p = planRecording({ cfg: eff, callsPerRead: perRead, account: { id: acc.id, broker }, policy: pol, feedCap: f.cap, feedOnDataAccount: f.onDataAccount, feedAccountId: f.accountId, endpointClass: cls, available, nseBackup: Boolean(eff.sources.nseBackup) && !demo && usable(deps.backupData), brokerName: broker === "demo" ? "Demo" : broker ? broker[0].toUpperCase() + broker.slice(1) : undefined });
    if (apply) {
      account = { ...acc, broker };
      policy = pol;
      endpointClass = cls;
      readCost = perRead;
      feed = f;
      // The limiter's windows survive re-plans and config changes: a rebuild (new policy, class or account) carries
      // the call logs and any rule-7 halving of the same account and class over; a share change is applied in place.
      if (!budget || budget.policyRef !== pol || budget.classRef !== cls || budget.accountRef !== acc.id) {
        const carry = budget && budget.classRef === cls && budget.accountRef === acc.id ? budget.exportState() : null;
        budget = createRecorderBudget({ policy: pol, endpointClass: cls, share: eff.budgetShare, clock, carry });
        budget.policyRef = pol;
        budget.classRef = cls;
        budget.accountRef = acc.id;
        budget.shareRef = eff.budgetShare;
      } else if (budget.shareRef !== eff.budgetShare) {
        budget.setShare(eff.budgetShare);
        budget.shareRef = eff.budgetShare;
      }
    }
    return { plan: p, acc: { ...acc, broker }, policy: pol, available, feedAccountId: f.accountId };
  }

  async function replan(reason = "timer") {
    if (stopped) return;
    lastPlanAt = now();
    if (!settings.enabled) {
      plan = null;
      chains.clear();
      stream?.clear();
      feedWarning = null;
      emitStatus();
      return;
    }
    try {
      const { plan: p } = await computePlan(settings, { apply: true });
      plan = p;
      error = null;
      const date = istDateOf(now());
      const keep = new Set();
      for (const c of p.chains) {
        const key = chainKey(c.underlying, c.expiry);
        keep.add(key);
        const info = await masterInfo(c.underlying, date);
        const prev = chains.get(key);
        const futs = info.futures.slice(0, c.kind === "index" ? 2 : 1);
        chains.set(key, {
          ...c,
          key,
          exchange: c.exchange ?? info.exchange ?? (BSE_INDICES.has(c.underlying) ? "BFO" : "NFO"),
          lot: info.lots[c.expiry] ?? null,
          strikes: info.strikes[c.expiry] ?? [],
          futures: futs,
          atm: prev?.source === c.source ? prev.atm : null,
          window: prev?.source === c.source ? prev.window : null,
          inFlight: prev?.inFlight ?? false,
        });
      }
      for (const key of [...chains.keys()]) if (!keep.has(key)) chains.delete(key);
      await syncStream();
      saveState({ lastPlanHash: JSON.stringify(p.chains.map((c) => [c.underlying, c.expiry, c.source])), refused: p.refused });
      log?.info?.("recorder plan", { reason, chains: p.chains.length, refused: p.refused.length });
      if (p.refused.some((r) => r.reason === "not-offered") && now() - startedAt < MASTER_RETRY_WINDOW_MS) scheduleReplan("masters", MASTER_RETRY_MS);
      // A chain that just joined the plan (an account connected, masters loaded, a config change) is recorded for the
      // current minute at once instead of waiting for the next slot.
      if (started && reason !== "start" && reason !== "timer" && settings.enabled) {
        const t = now();
        const day = dayFor(t);
        const s0 = slotFloor(t);
        if (day.tradingDay && day.plan && s0 >= day.plan.startMs && s0 < day.plan.endMs && !(holidaySuspect && holidaySuspect.date === day.date)) {
          runSlot(s0, day, { quick: true }).catch((err) => log?.warn?.("recorder slot after re-plan failed", { err: err?.message }));
        }
      }
    } catch (err) {
      error = String(err?.message ?? err);
      log?.warn?.("recorder plan failed", { err: error });
    }
    emitStatus();
  }

  function scheduleReplan(reason, delayMs = 1000) {
    if (replanTimer || stopped || !started) return;
    replanTimer = setT(() => {
      replanTimer = null;
      replan(reason);
    }, delayMs);
  }
  let startedAt = 0;
  /** Instrument masters load in the background at start: look again soon while an underlying shows as not offered. */
  const MASTER_RETRY_MS = 20_000;
  const MASTER_RETRY_WINDOW_MS = 10 * MINUTE_MS;

  // ── stream subscriptions and re-centring ──

  function spotOf(c) {
    const t = stream?.leg(spotSymbolOf(c.underlying));
    return t?.ltp ?? null;
  }

  function windowStrikes(c, atm, n) {
    const i = c.strikes.indexOf(atm);
    if (i < 0) return [];
    return c.strikes.slice(Math.max(0, i - n), i + n + 1);
  }

  function nearestStrike(strikes, centre) {
    let best = null;
    for (const k of strikes) if (best === null || Math.abs(k - centre) < Math.abs(best - centre) || (Math.abs(k - centre) === Math.abs(best - centre) && k < best)) best = k;
    return best;
  }

  /** Desired stream symbols for the plan; re-centres a chain when its ATM moved ≥ 2 strikes. */
  async function syncStream() {
    if (!stream || stopped) return;
    const streamChains = [...chains.values()].filter((c) => c.source === "stream");
    if (!streamChains.length) {
      stream.clear();
      feedWarning = null;
      return;
    }
    const desired = new Set();
    const cap = plan?.capacity?.stream?.cap ?? 0;
    for (const c of streamChains) {
      desired.add(spotSymbolOf(c.underlying));
      for (const x of c.futures) desired.add(formatSymbol({ exchange: c.exchange, underlying: c.underlying, expiry: x, kind: "FUT" }));
      const spot = spotOf(c);
      if (spot !== null && c.strikes.length) {
        const atm = nearestStrike(c.strikes, spot);
        const idx = (k) => c.strikes.indexOf(k);
        if (c.atm === null || Math.abs(idx(atm) - idx(c.atm)) >= RECENTRE_STRIKES) {
          c.atm = atm;
          c.window = windowStrikes(c, atm, c.strikesEachSide);
        }
      }
      for (const k of c.window ?? []) for (const r of ["CE", "PE"]) desired.add(legSymbol(c.exchange, c.underlying, c.expiry, k, r));
    }
    // Strike buffer only when feed room allows.
    if (settings.strikeBuffer > 0) {
      for (const c of streamChains) {
        if (!c.window?.length) continue;
        const wide = windowStrikes(c, c.atm, c.strikesEachSide + settings.strikeBuffer);
        const extra = wide.filter((k) => !c.window.includes(k));
        if (desired.size + extra.length * 2 > cap) continue;
        for (const k of extra) for (const r of ["CE", "PE"]) desired.add(legSymbol(c.exchange, c.underlying, c.expiry, k, r));
      }
    }
    if (stopped) return;
    const res = await stream.setDesired(desired);
    feedWarning = res.rejected.length ? `The live feed refused ${res.rejected.length} of the recorder's symbols (${res.rejected[0].code ?? "refused"}); those legs record as missing.` : null;
  }

  // ── today's counters ──

  function rollToday(date) {
    if (today.date === date) return;
    today.date = date;
    today.byChain = new Map();
    today.lastSnapshotAt = null;
    holidayWatch.clear();
  }
  const counter = (key) => {
    if (!today.byChain.has(key)) today.byChain.set(key, { snaps: 0, gaps: 0, partial: 0, legRows: 0, firstSlot: null, lastSlot: null, lastTs: null, slots: new Set(), snapSlots: new Set(), gapList: [] });
    return today.byChain.get(key);
  };

  async function loadTodayCounters(date) {
    rollToday(date);
    for (const { u, x } of store.chainsOn(date)) {
      const recs = await store.readDay(date, u, x);
      const c = counter(chainKey(u, x));
      for (const r of recs) {
        if (!r || c.slots.has(r.slot)) continue;
        c.slots.add(r.slot);
        if (c.firstSlot === null || r.slot < c.firstSlot) c.firstSlot = r.slot;
        if (r.kind === "snap") {
          c.snaps += 1;
          c.snapSlots.add(r.slot);
          c.legRows += r.k.length * 2;
          if (r.partial) c.partial += 1;
          if (c.lastSlot === null || r.slot > c.lastSlot) {
            c.lastSlot = r.slot;
            c.lastTs = r.ts;
          }
          store.rememberLatest(r);
          today.lastSnapshotAt = Math.max(today.lastSnapshotAt ?? 0, r.ts);
        } else if (r.kind === "gap") {
          c.gaps += 1;
          c.gapList.push(r);
        }
      }
    }
  }

  // ── writing ──

  async function writeRecord(rec) {
    if (stopped) return false; // nothing is written after stop()
    if (istDateOf(rec.slot) !== today.date) {
      // Another day (the demo back-fill of previous weekdays): written as is, not counted in today's figures.
      return (await store.append(rec)).ok;
    }
    const key = chainKey(rec.u, rec.x);
    const c = counter(key);
    const id = claimId(key, rec.slot);
    if (c.slots.has(rec.slot) || writing.has(id)) return false;
    writing.add(id);
    let res;
    try {
      res = await store.append(rec);
    } finally {
      writing.delete(id);
    }
    if (c !== today.byChain.get(key)) return res.ok; // the day rolled while appending
    if (!res.ok) {
      if (res.reason === "disk-full") {
        await store.append(gapRecord({ u: rec.u, x: rec.x, slot: rec.slot, reason: "disk-full", detail: "The recorder's disk limit is reached; nothing new is written until space is freed or the limit raised." }));
        c.slots.add(rec.slot);
        c.gaps += 1;
      }
      return false;
    }
    c.slots.add(rec.slot);
    if (c.firstSlot === null || rec.slot < c.firstSlot) c.firstSlot = rec.slot;
    if (rec.kind === "snap") {
      c.snaps += 1;
      c.snapSlots.add(rec.slot);
      c.legRows += rec.k.length * 2;
      if (rec.partial) c.partial += 1;
      c.lastSlot = Math.max(c.lastSlot ?? 0, rec.slot);
      c.lastTs = rec.ts;
      today.lastSnapshotAt = rec.ts;
      bus?.emit?.("recorder.snapshot", { underlying: rec.u, expiry: rec.x, slot: toIstIso(rec.slot), ts: toIstIso(rec.ts), source: rec.source, quality: rec.quality, partial: rec.partial });
    } else {
      c.gaps += 1;
      c.gapList.push(rec);
      if (c.gapList.length > 500) c.gapList.shift();
    }
    if (persisted.lastSlot === null || rec.slot > persisted.lastSlot) persisted.lastSlot = rec.slot;
    return true;
  }

  /** Write many snapshots of one chain-day at once (the demo back-fill); today's go through the counters. */
  async function writeRecords(recs) {
    if (!recs.length) return 0;
    const isToday = istDateOf(recs[0].slot) === today.date;
    const c = isToday ? counter(chainKey(recs[0].u, recs[0].x)) : null;
    const fresh = c ? recs.filter((r) => !c.slots.has(r.slot)) : recs;
    if (!fresh.length) return 0;
    const res = await store.appendMany(fresh);
    if (!res.ok) return 0;
    if (c) {
      for (const rec of fresh) {
        c.slots.add(rec.slot);
        if (c.firstSlot === null || rec.slot < c.firstSlot) c.firstSlot = rec.slot;
        c.snaps += 1;
        c.snapSlots.add(rec.slot);
        c.legRows += rec.k.length * 2;
        if (rec.partial) c.partial += 1;
        if (c.lastSlot === null || rec.slot > c.lastSlot) {
          c.lastSlot = rec.slot;
          c.lastTs = rec.ts;
        }
      }
      today.lastSnapshotAt = Math.max(today.lastSnapshotAt ?? 0, fresh.at(-1).ts);
    }
    return fresh.length;
  }

  const quality = () => (demo ? "demo" : "live");

  function clockFor(c) {
    return pricingContext({ config, reference: deps.reference, exchange: c.exchange, kind: c.kind, now: now() });
  }

  function snapshotFrom(c, { slot, ts, source, rows, spot, accountId, broker, lot, accounts = null }) {
    const ctx = clockFor(c);
    return buildSnapshot(
      { u: c.underlying, x: c.expiry, ex: c.exchange, slot, ts, source, accountId, broker, accounts, quality: quality(), oiUnitVerified: oiUnitVerified(broker), lot: lot ?? c.lot, spot, rows, plannedLegs: 2 * (2 * c.strikesEachSide + 1) },
      { clock: ctx, rate: ctx.rate?.value ?? 0 },
    );
  }

  async function recordStream(c, slot) {
    const h = stream.health(account.id);
    if (h.state === "down" || h.state === "stale") return writeRecord(gapRecord({ u: c.underlying, x: c.expiry, slot, reason: "stream-down", detail: `The ${account.broker} feed is ${h.state === "stale" ? "stale" : "down"}${h.lastTickAt ? ` (last tick ${h.lastTickAt})` : ""}.` }));
    if (!c.window?.length) return writeRecord(gapRecord({ u: c.underlying, x: c.expiry, slot, reason: "not-subscribed-yet", detail: "Waiting for the first spot tick to choose strikes." }));
    const spot = spotOf(c);
    const centre = spot ?? c.atm;
    // The rows sit around the current ATM over all listed strikes, so a drift of one strike (below the re-centre
    // threshold) is covered by the strike buffer's legs instead of cutting the snapshot at the window edge. A leg is
    // read only when the recorder holds it (window or buffer) or it is in the subscribed window.
    const atm = nearestStrike(c.strikes, centre);
    const strikes = windowStrikes(c, atm, c.strikesEachSide);
    const inWindow = new Set(c.window);
    // Each leg names the feed account its tick came from (the hub places symbols on any candidate feed). Legs from
    // another holder's account are never recorded (they count as missing); legs from more than one account are
    // listed in `accounts` (§3.3).
    const holder = holderOf(account.id);
    const counts = new Map();
    const own = (leg) => {
      if (!leg) return null;
      const id = leg.accountId ?? account.id;
      if (id !== account.id && (holder === null || holderOf(id) !== holder)) return null;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return leg;
    };
    const legOf = (k, r) => {
      const sym = legSymbol(c.exchange, c.underlying, c.expiry, k, r);
      return inWindow.has(k) || stream.holds(sym) ? own(stream.leg(sym)) : null;
    };
    const rows = strikes.map((k) => ({ strike: k, ce: legOf(k, "CE"), pe: legOf(k, "PE") }));
    if (rows.every((r) => !r.ce && !r.pe)) return writeRecord(gapRecord({ u: c.underlying, x: c.expiry, slot, reason: "not-subscribed-yet", detail: "No tick has arrived for this chain yet." }));
    const ts = now();
    const accounts = counts.size > 1 || (counts.size === 1 && !counts.has(account.id)) ? Object.fromEntries(counts) : null;
    const snap = snapshotFrom(c, { slot, ts, source: "stream", rows, spot, accountId: account.id, broker: account.broker, accounts });
    return writeRecord(snap);
  }

  async function recordRest(c, slot) {
    if (stopped) return false;
    if (c.inFlight) return writeRecord(gapRecord({ u: c.underlying, x: c.expiry, slot, reason: "budget", detail: "The previous read of this chain is still waiting." }));
    c.inFlight = true;
    try {
      let timeoutHandle = null;
      const timeout = new Promise((r) => {
        timeoutHandle = setT(() => r({ ok: false, reason: "broker-error", detail: "The broker did not answer within 55 s." }), JOB_TIMEOUT_MS);
      });
      const read = c.source === "nse-backup" ? rest.readBackup({ underlying: c.underlying, expiry: c.expiry }) : rest.read({ accountId: account.id, underlying: c.underlying, expiry: c.expiry, strikes: c.strikesEachSide, endpointClass, share: effectiveSettings(settings).budgetShare, budget, cost: readCost, stopped: () => stopped });
      const r = await Promise.race([read, timeout]);
      clearT(timeoutHandle);
      if (!r.ok) return writeRecord(gapRecord({ u: c.underlying, x: c.expiry, slot, reason: r.reason, detail: r.detail }));
      const rows = r.rows;
      const snap = snapshotFrom(c, { slot, ts: r.ts ?? now(), source: c.source === "nse-backup" ? "nse-backup" : "rest", rows, spot: r.spot, accountId: r.accountId ?? account.id, broker: r.broker ?? account.broker, lot: r.lotSize });
      c.lastSpot = r.spot;
      return writeRecord(snap);
    } finally {
      c.inFlight = false;
    }
  }

  async function writeUnd(underlying, slot, chainsOfU) {
    const c = chainsOfU[0];
    const spotStream = stream?.leg(spotSymbolOf(underlying));
    const spot = spotStream?.ltp ?? chainsOfU.map((x) => x.lastSpot).find((v) => v != null) ?? null;
    const fut = [];
    for (const x of c.futures ?? []) {
      const t = stream?.holds(formatSymbol({ exchange: c.exchange, underlying, expiry: x, kind: "FUT" })) ? stream.leg(formatSymbol({ exchange: c.exchange, underlying, expiry: x, kind: "FUT" })) : null;
      if (t) fut.push({ x, ltp: t.ltp, bid: t.bid, ask: t.ask, oi: t.oi, vol: t.volume });
    }
    if (spot === null && !fut.length) return;
    await store.appendUnd({ v: 1, kind: "und", u: underlying, slot, spot, fut });
  }

  /** REST jobs still running (they finish in the background; tests and stop() can wait for them). */
  const pending = new Set();
  /** Spread REST reads not started yet: timer handle -> the job's resolve. */
  const spreadTimers = new Map();
  /**
   * Chain-slots dispatched and not yet finished (`key|slot`): claimed synchronously when runSlot decides a chain is
   * due, so a quick slot after a re-plan or an overlapping tick never reads the same chain-slot twice while its REST
   * read is still spread or in flight. Released when the job ends (written, failed or cancelled by stop()).
   */
  const claims = new Set();
  const claimId = (key, slot) => `${key}|${slot}`;
  /** Records being appended (`key|slot`): writeRecord's check and its append are not split by another write. */
  const writing = new Set();

  /** Minimum spacing between REST reads so the recorder's per-second cap is never the reason for a gap. */
  function restSpacingMs() {
    const perSecond = (budget?.caps?.windows ?? []).filter((w) => w.windowMs === 1000).reduce((m, w) => Math.min(m, w.cap), Infinity);
    return Number.isFinite(perSecond) && perSecond > 0 ? Math.ceil((1000 * readCost) / perSecond) + 50 : 0;
  }

  /** Record every chain due at `slot`. Stream snapshots are written before this resolves; REST reads continue. */
  async function runSlot(slot, day, { quick = false } = {}) {
    if (!plan || !account || !settings.enabled) return;
    if (holidaySuspect && holidaySuspect.date === day.date) return;
    // Chains already written for this slot (a re-plan in the same minute, a restart's bridge-down gap) are skipped.
    const due = [...chains.values()].filter((c) => isDue(day.plan, slot, c.kind, c.everyMinutes) && !claims.has(claimId(c.key, slot)) && !(day.date === today.date && counter(c.key).slots.has(slot)));
    if (!due.length) return;
    // Claimed before the first await: a second runSlot for this slot (a re-plan's quick slot, the regular tick) skips them.
    for (const c of due) claims.add(claimId(c.key, slot));
    const release = (c) => claims.delete(claimId(c.key, slot));
    // Re-centre stream chains before reading them.
    try {
      await syncStream();
    } catch (err) {
      for (const c of due) release(c);
      throw err;
    }
    const streamDue = due.filter((c) => c.source === "stream");
    const restDue = due.filter((c) => c.source !== "stream");
    for (const c of streamDue) {
      await sleepTurn();
      await recordStream(c, slot)
        .catch((err) => log?.warn?.("recorder stream snapshot failed", { chain: c.key, err: err?.message }))
        .finally(() => release(c));
    }
    const spacing = restSpacingMs();
    const total = Math.min(55_000, Math.max(quick ? 0 : settings.restSpreadMs, spacing * restDue.length));
    const step = restDue.length > 1 ? Math.max(spacing, total / restDue.length) : 0;
    const jobs = restDue.map(
      (c, i) =>
        new Promise((settle) => {
          const resolve = () => {
            release(c);
            settle();
          };
          const go = () => {
            if (stopped) return resolve();
            recordRest(c, slot)
              .catch((err) => log?.warn?.("recorder REST snapshot failed", { chain: c.key, err: err?.message }))
              .finally(resolve);
          };
          if (i === 0 || step === 0) go();
          else {
            // Tracked so stop() can cancel the reads not started yet (and settle their promises).
            const h = setT(() => {
              spreadTimers.delete(h);
              go();
            }, Math.round(i * step));
            spreadTimers.set(h, resolve);
          }
        }),
    );
    const byU = new Map();
    for (const c of due) {
      if (!byU.has(c.underlying)) byU.set(c.underlying, []);
      byU.get(c.underlying).push(c);
    }
    const finish = Promise.all(jobs)
      .then(async () => {
        if (stopped) return;
        for (const [u, list] of byU) await writeUnd(u, slot, list).catch(() => {});
        saveState({ lastSlot: persisted.lastSlot });
        await watchHoliday(slot, day).catch((err) => log?.warn?.("recorder holiday check failed", { err: err?.message }));
        emitStatus();
      })
      .finally(() => pending.delete(finish));
    pending.add(finish);
    if (!restDue.length) await finish;
  }

  /** Bridge-down gaps for today's slots missed while the Bridge was not running (§3.3). */
  async function writeBridgeDownGaps(day, startSlot) {
    if (!day.plan) return;
    const recorded = store.days("0000-00-00", day.date).filter((d) => d < day.date);
    for (const c of chains.values()) {
      const cnt = counter(c.key);
      const lastToday = cnt.slots.size ? Math.max(...cnt.slots) : null;
      // Only this chain's own last record counts (today's, else its last recorded day's). A chain never recorded
      // before (just added to the plan, a newly listed expiry) starts its coverage now: no bridge-down gaps.
      let lastKnown = lastToday;
      for (let i = recorded.length - 1; lastKnown === null && i >= Math.max(0, recorded.length - 10); i--) {
        if (!store.chainsOn(recorded[i]).some((x) => x.u === c.underlying && x.x === c.expiry)) continue;
        lastKnown = await store.lastSlotOn(recorded[i], c.underlying, c.expiry);
      }
      if (lastKnown === null || !Number.isFinite(lastKnown)) continue;
      const from = Math.max(lastKnown + MINUTE_MS, day.plan.startMs);
      for (let s = from; s < startSlot; s += MINUTE_MS) {
        if (!isDue(day.plan, s, c.kind, c.everyMinutes)) continue;
        await writeRecord(gapRecord({ u: c.underlying, x: c.expiry, slot: s, reason: "bridge-down", detail: "The Bridge was not running." }));
      }
    }
  }

  // ── daily job, roll, retention ──

  /** The trading day before `date` by the exchange calendar (the demo's "always open" clock is not a calendar). */
  function prevTradingDate(date) {
    let d = date;
    for (let i = 0; i < 15; i++) {
      d = istDateOf(istMidnight(d) - 12 * 3_600_000);
      const r = resolveDay({ reference: deps.reference, exchange: "NFO", t: istMidnight(d) + 12 * 3_600_000, recordSpecialSessions: settings.recordSpecialSessions });
      if (r.tradingDay) return d;
    }
    return null;
  }

  /**
   * The last snapshot of the PREVIOUS trading day (§6.10 ΔOI, §6.13 volume), or null when that day was not recorded:
   * an older recorded day is never used, so ΔOI then falls back to the broker's change since the previous close.
   */
  async function prevRecordedLast(date, u, x) {
    const prev = prevTradingDate(date);
    if (!prev) return null;
    const recs = await store.readDay(prev, u, x);
    const snaps = recs.filter((r) => r?.kind === "snap" && r.quality !== "suspect-holiday");
    return snaps.length ? snaps.reduce((a, b) => (b.slot > a.slot ? b : a)) : null;
  }

  let futuresBudget = null;
  async function futuresForDaily(u, und) {
    if (und?.fut?.length || demo || !account || !usable(deps.marketData)) return und;
    const info = await masterInfo(u, istDateOf(now()));
    const c = [...chains.values()].find((x) => x.underlying === u);
    const futs = info.futures.slice(0, 2).map((x) => formatSymbol({ exchange: c?.exchange ?? (BSE_INDICES.has(u) ? "BFO" : "NFO"), underlying: u, expiry: x, kind: "FUT" }));
    if (!futs.length) return und;
    // A background REST call like any other (README §3.3): the shared gate, the recorder's own budget, the short
    // wait and the dispatch floor. Refused: the row is written without futures.
    const share = effectiveSettings(settings).budgetShare;
    let batch = 1;
    try {
      batch = Math.max(1, Math.floor(Number(deps.scheduler.policyFor(account.broker)?.maxQuoteBatch) || 1));
    } catch {
      batch = 1;
    }
    const cost = Math.ceil(futs.length / batch);
    if (endpointClass !== "quote" && (!futuresBudget || futuresBudget.policyRef !== policy || futuresBudget.accountRef !== account.id)) {
      const carry = futuresBudget && futuresBudget.accountRef === account.id ? futuresBudget.exportState() : null;
      futuresBudget = createRecorderBudget({ policy, endpointClass: "quote", share, clock, carry });
      futuresBudget.policyRef = policy;
      futuresBudget.accountRef = account.id;
    }
    const quoteBudget = endpointClass === "quote" ? budget : futuresBudget;
    if (gate && !gate.allow(account.id, "quote", { share, cost })) return und;
    if (!quoteBudget || !quoteBudget.tryTake(cost)) return und;
    try {
      const q = await deps.marketData.quotes(futs, { accountId: account.id, priority: "background", maxAgeMs: 120_000, maxWaitMs: 1500, backgroundShare: share });
      const fut = (q?.items ?? []).map((it) => ({ x: parseSymbol(it.symbol).expiry, ltp: it.ltp, oi: it.oi ?? null })).filter((f) => f.x);
      return { ...(und ?? { spot: null }), fut };
    } catch {
      return und;
    }
  }

  /** The broker's OI change (the stored `oc` column) of the day's latest snapshot carrying one, aligned to `last.k`. */
  function brokerOiChangeOf(snaps, last) {
    const src = [...snaps].reverse().find((s) => Array.isArray(s.ce?.oc) || Array.isArray(s.pe?.oc));
    if (!src) return null;
    const at = new Map(src.k.map((k, i) => [k, i]));
    const pick = (side) => last.k.map((k) => (at.has(k) ? (src[side]?.oc?.[at.get(k)] ?? null) : null));
    return { ce: pick("ce"), pe: pick("pe") };
  }

  /** Build S3 rows for one day from its S1 files. */
  async function runDaily(date) {
    const rows = [];
    for (const { u, x } of store.chainsOn(date)) {
      const recs = await store.readDay(date, u, x);
      const snaps = recs.filter((r) => r?.kind === "snap" && r.quality !== "suspect-holiday").sort((a, b) => a.slot - b.slot);
      if (!snaps.length) continue;
      const last = snaps.at(-1);
      const undLines = await store.readUnd(date, u);
      let und = undLines.length ? undLines.reduce((a, b) => (b.slot > a.slot ? b : a)) : null;
      if (date === istDateOf(now())) und = await futuresForDaily(u, und);
      const gapSlots = new Set(recs.filter((r) => r?.kind === "gap").map((r) => r.slot)).size;
      const prevLast = await prevRecordedLast(date, u, x);
      rows.push(
        dailyRow({
          date,
          last,
          prevLast,
          // The previous day was not recorded: ΔOI falls back to the broker's change since the previous close (§6.10).
          brokerOiChange: prevLast ? null : brokerOiChangeOf(snaps, last),
          und,
          counts: { slots: new Set(snaps.map((s) => s.slot)).size, gapSlots, partialSlots: snaps.filter((s) => s.partial).length },
        }),
      );
      await sleepTurn();
    }
    if (rows.length) await store.writeDaily(rows);
    dailyDone.set(date, "ok");
    return rows.length;
  }

  async function catchUpDaily() {
    const t = now();
    const todayDate = istDateOf(t);
    const dailyMin = hhmmMinutes(settings.dailyAt);
    const minNow = Math.floor((t - istMidnight(todayDate)) / MINUTE_MS);
    // One pass over an in-memory S3 index (each year file read once), per (date, expiry), yielding between days.
    const missing = await store.missingDailyDays({ skip: (date) => (date === todayDate && minNow < dailyMin) || (date !== todayDate && dailyDone.has(date)) });
    for (const date of missing) {
      if (stopped) return;
      try {
        await runDaily(date);
      } catch (err) {
        log?.warn?.("recorder daily catch-up failed", { date, err: err?.message });
      }
      await sleepTurn();
    }
  }

  async function rollPastDays() {
    const todayDate = istDateOf(now());
    for (const date of store.days()) {
      if (date >= todayDate || store.isRolled(date)) continue;
      try {
        await store.rollDay(date, { quality: demo ? "demo" : null });
      } catch (err) {
        log?.warn?.("recorder day roll failed", { date, err: err?.message });
      }
    }
  }

  async function housekeeping(t, day) {
    const date = day.date;
    if (lastDay !== date && !backfill) {
      lastDay = date;
      rollToday(date);
      // A suspected holiday holds for its own day only: the next day runs the detector again (§6.13).
      if (holidaySuspect && holidaySuspect.date !== date) {
        holidaySuspect = null;
        saveState({ holidaySuspected: null });
      }
      await rollPastDays();
      prune(date);
      await catchUpDaily();
    }
    const minNow = Math.floor((t - istMidnight(date)) / MINUTE_MS);
    const dailyMin = hhmmMinutes(settings.dailyAt);
    if (day.tradingDay && minNow >= dailyMin && !dailyDone.has(date) && store.chainsOn(date).length) {
      try {
        await runDaily(date);
      } catch (err) {
        dailyDone.set(date, "failed");
        log?.warn?.("recorder daily job failed; retrying at 15:45", { err: err?.message });
      }
    }
    // One retry at 15:45 (§3.2); a second failure is left to the next start's catch-up.
    if (dailyDone.get(date) === "failed" && minNow >= Math.max(RETRY_MIN, dailyMin + 1)) {
      try {
        await runDaily(date);
      } catch (err) {
        dailyDone.set(date, "retried");
        log?.warn?.("recorder daily job failed again; it runs at the next start", { err: err?.message });
      }
    }
    if (day.plan && !day.plan.alwaysOpen) {
      const rollMin = Math.max(15 * 60 + 40, day.plan.closeMin + 10);
      if (minNow >= rollMin && !store.isRolled(date) && store.chainsOn(date).length) await store.rollDay(date, { quality: quality() });
    }
    if (minNow === 16 * 60) prune(date);
  }

  /** Retention: the configured days; demo keeps today and the back-filled weekdays (about 3 days). */
  function prune(date) {
    if (demo) store.setLimits({ retentionDays: Math.max(DEMO_RETENTION_DAYS, demoKeepDays(date, settings.demo.backfillDays)) });
    return store.prune(date);
  }

  // ── holiday detector (§6.13) ──

  async function watchHoliday(slot, day) {
    if (demo || !day.plan || day.plan.alwaysOpen || holidaySuspect?.date === day.date) return;
    const idx = Math.round((slot - day.plan.startMs) / MINUTE_MS);
    if (idx !== HOLIDAY_DETECT_SLOTS - 1) return;
    const inputs = [];
    for (const c of chains.values()) {
      if (c.kind !== "index") continue;
      const recs = (await store.readDay(day.date, c.underlying, c.expiry)).filter((r) => r?.kind === "snap").sort((a, b) => a.slot - b.slot);
      if (!recs.length) continue;
      // null when no leg carries a volume (a feed that sends none): missing data never suspects a holiday (§6.13).
      const vol = (s) => {
        const vs = [...(s.ce?.vol ?? []), ...(s.pe?.vol ?? [])].filter((v) => typeof v === "number" && Number.isFinite(v));
        return vs.length ? vs.reduce((a, v) => a + v, 0) : null;
      };
      const prev = await prevRecordedLast(day.date, c.underlying, c.expiry);
      inputs.push({ spots: recs.slice(0, HOLIDAY_DETECT_SLOTS).map((s) => s.spot), volume: vol(recs.at(-1)), prevVolume: prev ? vol(prev) : null });
    }
    if (holidaySuspected(inputs)) {
      holidaySuspect = { date: day.date, at: toIstIso(now()) };
      saveState({ holidaySuspected: holidaySuspect });
      await store.remarkDay(day.date, "suspect-holiday");
      log?.warn?.("recorder: today looks like an unlisted holiday; recording stopped for the day", { date: day.date });
      emitStatus(true);
    }
  }

  // ── the loop ──

  function scheduleNext() {
    if (stopped) return;
    const t = now();
    const offset = settings.slotOffsetMs;
    let at = slotFloor(t) + offset;
    if (at <= t) at += MINUTE_MS;
    timer = setT(() => {
      timer = null;
      ticking = tick().finally(() => {
        ticking = null;
        scheduleNext();
      });
    }, at - t);
  }
  let ticking = null;

  async function tick() {
    if (stopped) return;
    const t = now();
    const slot = slotFloor(t - settings.slotOffsetMs);
    let day;
    try {
      day = dayFor(slot);
      await housekeeping(t, day);
      if (!settings.enabled) return;
      if (t - lastPlanAt >= REPLAN_MS) await replan("timer");
      if (day.tradingDay && day.plan) {
        await runSlot(slot, day);
      }
      emitStatus();
    } catch (err) {
      error = String(err?.message ?? err);
      log?.error?.("recorder slot failed", { err });
    }
  }

  // ── status ──

  function stateOf(day) {
    if (error && !plan) return "error";
    if (!settings.enabled) return "paused";
    if (!account) return "not-configured";
    if (store.usage().full) return "disk-full";
    if (holidaySuspect && holidaySuspect.date === day.date) return "holiday-suspected";
    const t = now();
    if (!day.tradingDay || !day.plan || t < day.plan.startMs || t >= day.plan.endMs) return "idle-closed";
    const h = stream && account ? stream.health(account.id) : null;
    const streamDown = [...chains.values()].some((c) => c.source === "stream") && h && (h.state === "down" || h.state === "stale");
    if ((plan?.refused ?? []).some((r) => r.reason === "capacity") || streamDown) return "degraded";
    return "recording";
  }

  function stateDetailOf(state, day) {
    const idx = [...chains.values()].filter((c) => c.kind === "index");
    const st = [...chains.values()].filter((c) => c.kind === "stock");
    const byStream = idx.filter((c) => c.source === "stream").length;
    const base = `${idx.length} index chain${idx.length === 1 ? "" : "s"} (${byStream} by stream${idx.length - byStream ? `, ${idx.length - byStream} by REST` : ""}) and ${st.length} stock chain${st.length === 1 ? "" : "s"}`;
    switch (state) {
      case "paused":
        return "Recording is switched off (recorder.enabled is false).";
      case "not-configured":
        return "No connected account can serve option chains. Connect one on the Accounts page.";
      case "disk-full":
        return "The recorder's disk limit is reached; nothing new is written.";
      case "holiday-suspected":
        return "Today looks like an exchange holiday the calendar does not list: the first six minutes were flat with no volume. Recording stopped for the day.";
      case "idle-closed":
        return day.tradingDay ? `Market closed. Next session records ${base}.` : `Not a trading day (${day.reason ?? "closed"}). Next session records ${base}.`;
      case "degraded":
        return `Recording ${base}; some chains are refused or a source is down.`;
      case "error":
        return `The recorder hit an error: ${error}`;
      default:
        return `Recording ${base}.`;
    }
  }

  function coverageOf(day) {
    const t = now();
    const out = [];
    for (const c of chains.values()) {
      const cnt = counter(c.key);
      // From the chain's first record today: coverage starts when recording started (bridge-down gaps count as missing).
      const first = cnt.firstSlot;
      const expected = day.plan && first !== null ? expectedSlotsBy(day.plan, Math.min(t, day.plan.endMs - 1), c.kind, c.everyMinutes) - expectedSlotsBy(day.plan, first - 1, c.kind, c.everyMinutes) : 0;
      // Minutes, not slots: each slot stands for its cadence (5-minute chains, the demo's 5-minute night slots).
      const mins = (slot) => (day.plan ? cadenceAt(day.plan, slot, c.kind, c.everyMinutes) : c.kind === "stock" ? c.everyMinutes : 1);
      let recordedMinutes = 0;
      let gapMinutes = 0;
      for (const s of cnt.slots) {
        if (cnt.snapSlots.has(s)) recordedMinutes += mins(s);
        else gapMinutes += mins(s);
      }
      const expectedMinutes = day.plan && first !== null ? Math.max(expectedMinutesBetween(day.plan, first, Math.min(t, day.plan.endMs - 1), c.kind, c.everyMinutes), recordedMinutes + gapMinutes) : 0;
      const nowSlot = day.plan ? Math.min(Math.max(slotFloor(t), day.plan.startMs), day.plan.endMs - MINUTE_MS) : null;
      out.push({
        underlying: c.underlying,
        expiry: c.expiry,
        kind: c.kind,
        source: c.source,
        everyMinutes: c.everyMinutes,
        everyMinutesNow: nowSlot === null ? c.everyMinutes : mins(nowSlot),
        strikesEachSide: c.strikesEachSide,
        firstSlot: first === null ? null : toIstIso(first),
        expectedSlots: expected,
        recordedSlots: cnt.snaps,
        gapSlots: cnt.gaps,
        expectedMinutes,
        recordedMinutes,
        gapMinutes,
        partialSlots: cnt.partial,
        lastSlot: cnt.lastSlot === null ? null : toIstIso(cnt.lastSlot),
        lastAgeMs: cnt.lastTs === null ? null : Math.max(0, t - cnt.lastTs),
        gaps: mergeGaps(cnt.gapList, mins).slice(-20),
      });
    }
    return out;
  }

  function status() {
    const t = now();
    const day = dayFor(t);
    const state = stateOf(day);
    const s = effectiveSettings(settings);
    const usage = store.usage();
    const health = store.health();
    let todaySnaps = 0;
    let legRows = 0;
    let gapSlots = 0;
    let partial = 0;
    for (const c of today.byChain.values()) {
      todaySnaps += c.snaps;
      legRows += c.legRows;
      gapSlots += c.gaps;
      partial += c.partial;
    }
    const next = day.plan ? nextSlotAfter(day.plan, t) : null;
    const coverage = coverageOf(day);
    const w = new Set([...(feedWarning ? [feedWarning] : []), ...(accountWarning ? [accountWarning] : []), ...(plan?.warnings ?? [])]);
    if (account && !oiUnitVerified(account.broker)) w.add(`Open interest units for ${account.broker} are not verified against a recorded response; OI is recorded as sent (marked oiUnitVerified: false).`);
    for (const d of health.unreadableDays) w.add(`The recordings of ${d.date} could not be read (${d.detail}); that day is skipped.`);
    if (demo) w.add("Demo clock: always open. Demo recordings are sample data and are kept for 3 days in a separate folder.");
    const h = stream && account ? stream.health(account.id) : null;
    return {
      state,
      stateDetail: stateDetailOf(state, day),
      demo,
      account: account
        ? { id: account.id, broker: account.broker, chosen: account.chosen, session: safeSession(account.id), feedAccount: feed.onDataAccount && feed.hasFeed ? account.id : feed.accountId, feedState: h?.state ?? null, costNote: COST_NOTES[account.broker] ?? "Recording uses your broker's market-data APIs; some brokers charge for them (needs verification)." }
        : null,
      session: {
        tradingDay: day.tradingDay,
        open: Boolean(day.plan && t >= day.plan.startMs && t < day.plan.endMs),
        date: day.date,
        start: day.plan?.open ?? null,
        end: day.plan?.close ?? null,
        alwaysOpen: Boolean(day.plan?.alwaysOpen),
        calendarSource: day.calendarSource,
        reason: day.reason,
        nextSlot: next === null ? null : toIstIso(next + s.slotOffsetMs),
      },
      plan: {
        chains: (plan?.chains ?? []).map((c) => ({ underlying: c.underlying, expiry: c.expiry, kind: c.kind, everyMinutes: c.everyMinutes, strikesEachSide: c.strikesEachSide, source: c.source, legs: c.legs })),
        refused: plan?.refused ?? [],
        capacity: plan?.capacity ?? null,
        message: plan?.message ?? null,
      },
      budget: {
        restCallsLastMinute: budget ? budget.usedLastMinute(t) : 0,
        restCapPerMinute: budget && plan?.capacity?.rest?.allowed ? budget.perMinute(t) : 0,
        brokerPerMinute: plan?.budget?.brokerPerMinute ?? null,
        plannedPerMinute: plan?.budget?.restCallsPerMinute ?? 0,
        share: s.budgetShare,
        throttledUntil: budget && budget.halvedUntil() > t ? toIstIso(budget.halvedUntil()) : null,
      },
      today: { snapshots: todaySnaps, legRows, gapSlots, gapMinutes: coverage.reduce((n, c) => n + c.gapMinutes, 0), partialSnapshots: partial, lastSnapshotAt: today.lastSnapshotAt ? toIstIso(today.lastSnapshotAt) : null, corruptLines: health.corruptLines },
      disk: { bytes: usage.bytes, todayBytes: usage.todayBytes, days: usage.days, oldestDay: usage.oldestDay, retentionDays: demo ? DEMO_RETENTION_DAYS : s.retentionDays, maxBytes: usage.maxBytes, freeBytes: usage.freeBytes },
      coverage,
      sources: { stream: s.sources.stream, rest: s.sources.rest, nseBackup: s.sources.nseBackup && !demo },
      oiUnits: { verified: account ? oiUnitVerified(account.broker) : false, broker: account?.broker ?? null },
      holidaySuspected: holidaySuspect,
      backfill: demo ? { running: Boolean(backfill), doneFor: persisted.demoBackfilledFor ?? null } : null,
      // The stocks as recorded (in demo, the default five until a list is saved), so the page edits what it sees.
      settings: s,
      warnings: [...w],
    };
  }

  function safeSession(id) {
    try {
      return deps.accounts.status(id)?.state ?? null;
    } catch {
      return null;
    }
  }

  function emitStatus(force = false) {
    if (!bus?.emit) return;
    const t = now();
    let state;
    try {
      state = stateOf(dayFor(t));
    } catch {
      return;
    }
    if (!force && state === lastStatusState && t - lastStatusEmit < 60_000) return;
    if (t - lastStatusEmit < STATUS_EMIT_MS) {
      if (!statusTimer)
        statusTimer = setT(() => {
          statusTimer = null;
          emitStatus(true);
        }, STATUS_EMIT_MS);
      return;
    }
    lastStatusEmit = t;
    lastStatusState = state;
    bus.emit("recorder.status", { state, demo, accountId: account?.id ?? null, chains: chains.size, refused: plan?.refused?.length ?? 0, at: toIstIso(t) });
  }

  // ── reads ──

  async function snapshots({ underlying, expiry, fromMs, toMs, fields, strikes = null, every = 1, includeSuspect = false, limit = 400, cursor = null }) {
    const page = await store.read({ u: underlying, x: expiry, fromMs, toMs, includeSuspect, everyMinutes: every, limit, cursor });
    const projected = page.snaps.map((s) => projectSnapshot(s, { fields, strikesEach: strikes }));
    const gaps = page.gaps;
    const key = chainKey(underlying, expiry);
    const inPlan = chains.get(key) ?? null;
    // Expected slots run from the first record in range (coverage starts when recording started; restarts leave
    // bridge-down gap records, so they still count as missing).
    let expected = 0;
    const end = Math.min(toMs, now());
    const startAt = page.firstRecordSlot ?? Infinity;
    const kind = inPlan?.kind ?? kindOf(underlying);
    const everyMin = inPlan?.everyMinutes ?? (kind === "stock" ? settings.stockEveryMinutes : 1);
    for (let d = istDateOf(fromMs); d <= istDateOf(end); d = istDateOf(istMidnight(d) + 36 * 3_600_000)) {
      const day = dayFor(istMidnight(d) + 12 * 3_600_000);
      if (!day.plan) continue;
      for (const s of slotsOfDay(day.plan, kind, everyMin)) if (s >= fromMs && s >= startAt && s <= end) expected += 1;
    }
    let unavailable = null;
    if (page.allSnaps === 0 && gaps.length === 0) {
      const refused = (plan?.refused ?? []).find((r) => r.underlying === underlying && (r.expiry === expiry || r.expiry === null));
      if (refused) unavailable = { reason: "refused", detail: refused.detail };
      else if (inPlan) unavailable = { reason: "not-recorded-yet", detail: `${underlying} ${expiry} is in the recorder plan but nothing has been recorded in this range yet.` };
      else unavailable = { reason: "not-in-plan", detail: `${underlying} ${expiry} is not in the recorder plan. Add it on the Data recorder page.` };
    }
    const all = [...page.snaps];
    return {
      underlying,
      expiry,
      exchange: all[0]?.ex ?? inPlan?.exchange ?? null,
      snapshots: projected,
      gaps: mergeGaps(gaps, everyMin),
      coverage: {
        expectedSlots: Math.max(expected, page.allSnaps + new Set(gaps.map((g) => g.slot)).size),
        recordedSlots: page.allSnaps,
        gapSlots: new Set(gaps.map((g) => g.slot)).size,
        partialSlots: page.partialSnaps,
        firstSlot: all[0]?.slot ?? null,
        lastSlot: all.at(-1)?.slot ?? null,
      },
      unavailable,
      nextCursor: page.nextCursor,
    };
  }

  async function latest({ underlying, expiry, fields, strikes = null }) {
    let s = store.latest(underlying, expiry);
    if (!s) {
      const recs = await store.readDay(istDateOf(now()), underlying, expiry);
      const snaps = recs.filter((r) => r?.kind === "snap");
      if (snaps.length) {
        s = snaps.reduce((a, b) => (b.slot > a.slot ? b : a));
        store.rememberLatest(s);
      }
    }
    if (!s || istDateOf(s.slot) !== istDateOf(now())) return null;
    return projectSnapshot(s, { fields, strikesEach: strikes });
  }

  async function daily({ underlying, from, to, expiry = null }) {
    return store.readDaily({ u: underlying, from, to, x: expiry });
  }

  // ── config ──

  /**
   * Validate, plan and apply a recorder section (merged over the current one).
   * @param {object} section  raw section (acknowledgeNseTerms is not part of it)
   * @param {{ persist?: boolean, acknowledgeNseTerms?: boolean, save?: (value: object) => Promise<unknown> }} [opts]
   */
  async function configure(section, { acknowledgeNseTerms = false, save = null } = {}) {
    const merged = { ...(config.recorder ?? {}), ...currentRaw, ...(section ?? {}) };
    if (section?.sources) merged.sources = { ...(currentRaw.sources ?? config.recorder?.sources ?? {}), ...section.sources };
    if (section?.demo) merged.demo = { ...(currentRaw.demo ?? config.recorder?.demo ?? {}), ...section.demo };
    const parsed = RECORDER_CONFIG_SCHEMA.safeParse(merged);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => ({ path: ["recorder", ...i.path].join("."), message: i.message }));
      throw new BridgeError("VALIDATION_FAILED", `The recorder settings are not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
    }
    const next = parsed.data;
    if (next.sources.nseBackup && !settings.sources.nseBackup && !acknowledgeNseTerms) {
      throw new BridgeError("CONFIRMATION_REQUIRED", "Turning on the NSE website backup needs acknowledgeNseTerms: true. The NSE website's terms may not allow automated reading; use it only for your own use.");
    }
    const listed = stocksGiven || Array.isArray(section?.stocks);
    const { plan: p } = await computePlan(next, { stocksListed: listed });
    if (p.refused.some((r) => r.reason === "capacity")) {
      const body = capacityPayload(p);
      throw new BridgeError("CAPACITY_EXCEEDED", `${p.message} Nothing was saved.`, { fields: body });
    }
    let saved = false;
    if (!demo && typeof save === "function") {
      await save(merged);
      saved = true;
    }
    currentRaw = merged;
    stocksGiven = listed;
    settings = next;
    store.setLimits({ retentionDays: demo ? DEMO_RETENTION_DAYS : next.retentionDays, maxDiskMb: next.maxDiskMb });
    await replan("config");
    return { persisted: saved, status: status() };
  }

  // ── lifecycle ──

  let startRun = null;
  async function start() {
    if (started) return;
    startRun = startInner().finally(() => {
      startRun = null;
    });
    return startRun;
  }

  async function startInner() {
    started = true;
    stopped = false;
    const t = now();
    startedAt = t;
    const day = dayFor(t);
    await loadTodayCounters(day.date);
    lastDay = null;
    if (bus?.on) {
      offs.push(bus.on("account.status", (p) => (p?.accountId === account?.id || !account ? scheduleReplan("account") : null)));
      offs.push(bus.on("stream.status", (p) => (p?.accountId === account?.id ? scheduleReplan("stream") : null)));
      offs.push(
        bus.on("limits.throttled", (p) => {
          // Rule 7 reacts to a real broker throttle of the recorder's own class only (not a local queue refusal such
          // as the recorder's own maxWaitMs, and not orders or another class).
          if (p?.upstream === true && p.endpointClass === endpointClass && p.accountId === account?.id && budget) {
            budget.throttle(now());
            log?.warn?.("recorder REST use halved for 10 minutes after a broker throttle", { accountId: p.accountId });
          }
        }),
      );
    }
    await replan("start");
    if (holidaySuspect && holidaySuspect.date !== day.date) {
      holidaySuspect = null;
      saveState({ holidaySuspected: null });
    }
    if (settings.enabled && day.tradingDay && day.plan) {
      const s0 = slotFloor(t);
      const fresh = [...chains.values()].every((c) => counter(c.key).lastSlot === null && counter(c.key).gaps === 0);
      if (demo && settings.demo.alwaysOpen) {
        backfill = runDemoBackfill({ store, chains: [...chains.values()], day, now: t, backfillDays: settings.demo.backfillDays, state: persisted, clockFor, logger: log, writeMany: writeRecords, stopped: () => stopped, onDone: (date) => saveState({ demoBackfilledFor: date }) })
          // A restart later the same day: the back-fill already ran, so the minutes the Bridge was off are
          // bridge-down gaps as in real mode (coverage would otherwise show them missing with no gap).
          .then(() => (stopped ? null : writeBridgeDownGaps(day, s0)))
          .then(() => catchUpDaily())
          .catch((err) => log?.warn?.("demo back-fill failed", { err: err?.message }))
          .finally(() => {
            backfill = null;
          });
      } else {
        await writeBridgeDownGaps(day, fresh ? s0 : s0 + MINUTE_MS);
      }
      if (fresh || demo) {
        // Record the current minute at once (the first snapshot within seconds of start).
        if (s0 >= day.plan.startMs && s0 < day.plan.endMs) await runSlot(s0, day, { quick: true }).catch(() => {});
      }
    }
    scheduleNext();
    emitStatus(true);
  }

  async function stop() {
    stopped = true;
    const bounded = (p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref?.())]);
    if (startRun) await bounded(startRun);
    started = false;
    for (const [h, resolve] of spreadTimers) {
      clearT(h);
      resolve();
    }
    spreadTimers.clear();
    if (timer) clearT(timer);
    if (replanTimer) clearT(replanTimer);
    if (statusTimer) clearT(statusTimer);
    timer = null;
    replanTimer = null;
    statusTimer = null;
    for (const off of offs.splice(0)) off();
    // A tick in progress (housekeeping, a re-plan) checks `stopped` at each step; wait for it before dropping the
    // stream clients, so nothing subscribes after the clear.
    if (ticking) await bounded(ticking);
    await bounded(Promise.allSettled([...pending, backfill ?? Promise.resolve()]));
    stream?.clear();
    saveState({});
  }

  return {
    status,
    async plan(section = {}) {
      const merged = { ...(config.recorder ?? {}), ...currentRaw, ...(section ?? {}) };
      const parsed = RECORDER_CONFIG_SCHEMA.safeParse(merged);
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => ({ path: ["recorder", ...i.path].join("."), message: i.message }));
        throw new BridgeError("VALIDATION_FAILED", `The recorder settings are not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
      }
      const { plan: p, acc, feedAccountId } = await computePlan(parsed.data, { stocksListed: stocksGiven || Array.isArray(section?.stocks) });
      const out = { ok: p.ok, message: p.message, plan: { chains: p.chains, refused: p.refused, warnings: p.warnings }, budget: p.budget, capacity: p.capacity };
      // The accounts this dry run names (routes redact them for restricted keys); not part of the JSON body.
      Object.defineProperty(out, PLAN_ACCOUNTS, { value: { id: acc?.id ?? null, broker: acc?.broker ?? null, feedAccountId: feedAccountId ?? null, configured: parsed.data.account ?? null } });
      return out;
    },
    snapshots,
    latest,
    daily,
    configure,
    // extras
    start,
    stop,
    demo: () => demo,
    store,
    /** Clear a suspected holiday (the user says the market is open): recording resumes at the next slot. */
    clearHoliday() {
      holidaySuspect = null;
      saveState({ holidaySuspected: null });
      emitStatus(true);
    },
    /** Run one slot now (tests). */
    runSlotNow: async (slot, opts) => runSlot(slot ?? slotFloor(now()), dayFor(slot ?? now()), opts),
    /** Resolves when the current minute's work and every REST read started so far have been written (tests). */
    idle: async () => {
      for (let i = 0; i < 100 && (ticking || pending.size || startRun); i++) await Promise.allSettled([ticking, startRun, ...pending].filter(Boolean));
    },
    /** Run the daily job for a date now (tests, CLI). */
    runDaily,
    /** The in-flight demo back-fill (tests). */
    backfillDone: () => backfill ?? Promise.resolve(),
    settings: () => settings,
  };
}

/**
 * Merge consecutive gap records into ranges (§6.7): [{ from, to, slots, reason, detail }] with epoch ms. Gaps are
 * consecutive when they are `everyMinutes` apart with the same reason.
 */
export function mergeGaps(gaps, everyMinutes = 1) {
  const minsOf = typeof everyMinutes === "function" ? everyMinutes : () => everyMinutes;
  const sorted = [...gaps].sort((a, b) => a.slot - b.slot);
  const out = [];
  for (const g of sorted) {
    const last = out.at(-1);
    if (last && g.slot === last.to) continue;
    if (last && last.reason === g.reason && g.slot - last.to === minsOf(last.to) * MINUTE_MS) {
      last.to = g.slot;
      last.slots += 1;
      last.minutes += minsOf(g.slot);
    } else out.push({ from: g.slot, to: g.slot, slots: 1, minutes: minsOf(g.slot), reason: g.reason, detail: g.detail ?? null });
  }
  return out;
}
