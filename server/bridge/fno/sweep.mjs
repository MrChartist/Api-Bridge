/**
 * The server-side option sweep behind the screener (stream S19, docs/spec/p1-06-stocks.md §2.4, §2.6, §3.6).
 *
 *  - One sweep at a time for the whole Bridge (tabs, scripts and the auto-repeat all join it).
 *  - It reads from ONE data account (config, else the first marketDataCandidates() account; never pooled across
 *    holders), at priority "background" and with backgroundShare = fno.sweep.budgetShare (≤ 0.5), after the F0
 *    background gate says the call leaves every window at or above (1 − share) of its limit. User and order calls
 *    always go first (the scheduler's priority queue), and the scheduler re-checks the floor at dispatch.
 *  - Order: spots (one batched quote read), index chains (chain endpoint), stock chains (chain endpoint or batched
 *    quotes, whichever the plan picked), then the HV20 pass. Each finished chain is appended to the job file with a
 *    rising seq and served from memory; a restart within resumeWithinMinutes continues with the keys not done.
 *  - Auto-repeat runs only while leased (a dashboard GET …/current?lease=1 in the last leaseSeconds) or with the
 *    background switch on, while the session is open, at the plan's auto interval.
 *
 * Nothing here can place an order. The job files hold chains and the account id only.
 */
import { randomBytes } from "node:crypto";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { realisedVol } from "../dashboard/pricing.js";
import { istDate, toIstIso } from "../market/time.mjs";
import { MAX_BACKGROUND_SHARE, createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { perMinuteOf, planSweep } from "./plan.mjs";
import { chainFromQuotes, strikeWindow, withBrokerBasis } from "./quotesChain.mjs";

/**
 * Brokers whose quote response carries OI, bid and ask for NFO stock options, proved by a documented fixture
 * (fno/quotesFixtures.contract.test.mjs). Until a broker's fixture passes, the planner treats its quotes path as
 * unavailable. The demo adapter's quotes carry all three.
 */
export const QUOTES_VERIFIED = Object.freeze(new Set(["dhan", "zerodha", "upstox", "demo"]));

const ROUTE_CHUNK = 200;
const PROGRESS_EVERY_MS = 1000;
const IST_OFFSET_MS = 330 * 60_000;
const hhmm = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
const usable = (s) => Boolean(s) && !isStub(s);
const newJobId = () => `swp_${randomBytes(8).toString("hex")}`;
const TERMINAL = new Set(["done", "partial", "cancelled", "failed", "interrupted"]);

/**
 * @param {{ cfg: object, demo?: boolean, clock?: object, logger?: any, bus?: any, scheduler: any, accounts: any,
 *   marketData: any, symbols?: any, reference?: any, backupData?: any, recorder?: any, universe: any, store: any,
 *   demoBaseline?: (canonical: string, date: string) => Promise<[string, number] | null> }} deps
 */
export function createSweeper(deps) {
  const cfg = deps.cfg;
  const sc = cfg.sweep;
  const share = Math.min(sc.budgetShare, MAX_BACKGROUND_SHARE);
  const clock = deps.clock;
  const now = () => (clock ? clock.now() : Date.now());
  const log = deps.logger;
  const store = deps.store;
  const gate = usable(deps.scheduler) ? createBackgroundGate({ scheduler: deps.scheduler }) : null;
  const setT = typeof clock?.setTimeout === "function" ? (fn, ms) => clock.setTimeout(fn, ms) : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof clock?.clearTimeout === "function" ? (h) => clock.clearTimeout(h) : (h) => clearTimeout(h);

  /** Wait `ms` (the injected clock's timers in tests), resolving early when `signal` aborts. */
  function wait(ms, signal) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const h = setT(() => {
        signal?.removeEventListener?.("abort", done);
        resolve();
      }, ms);
      h?.unref?.();
      function done() {
        clearT(h);
        resolve();
      }
      signal?.addEventListener?.("abort", done, { once: true });
    });
  }

  let settings = store.readSettings();
  settings.optIn ??= { stocks: [], setAt: null, setBy: null };
  settings.autoRepeat ??= { background: false };
  /** @type {object|null} the running or last job */
  let job = store.readState().job ?? null;
  /** The job found on disk at boot: the only one resume() may continue. */
  const bootJob = job;
  /** key -> { key, seq, at, method, chain } (current job's day) */
  let cache = new Map();
  let cacheDay = null;
  let seq = 0;
  let abort = null;
  let running = null;
  let leaseUntil = 0;
  let lastProgressAt = 0;
  let coverage = { day: null, byUnderlying: new Map(), limitedReason: null };
  let oiBase = null;
  let hvDoc = null;

  const today = () => istDate(now());

  // ── account, policy, plan ──

  function chooseAccount() {
    const accounts = deps.accounts;
    if (!usable(accounts)) return null;
    if (sc.accountId && sc.accountId !== "auto") {
      try {
        const id = accounts.marketDataCandidates({ capability: "quotes", accountId: sc.accountId })[0] ?? accounts.marketDataCandidates({ capability: "optionChain", accountId: sc.accountId })[0];
        return id ?? null;
      } catch {
        return null;
      }
    }
    try {
      return accounts.marketDataCandidates({ capability: "quotes" })[0] ?? accounts.marketDataCandidates({ capability: "optionChain" })[0] ?? null;
    } catch {
      return null;
    }
  }

  function accountFacts(accountId) {
    const a = deps.accounts.get(accountId);
    let caps = [];
    let policy = null;
    try {
      const c = deps.accounts.capabilities(accountId);
      caps = c?.capabilities ?? [];
      policy = c?.policy ?? null;
    } catch {
      caps = [];
    }
    try {
      policy = deps.scheduler.policyFor(a.broker) ?? policy;
    } catch {
      // keep what accounts reported
    }
    return { id: accountId, broker: a.broker, caps: { optionChain: caps.includes("optionChain"), quotes: caps.includes("quotes") }, policy: policy ?? { limits: {}, groups: {}, maxQuoteBatch: 1 } };
  }

  const sessionMinutes = () => {
    try {
      const s = deps.reference?.session?.("NFO");
      const [oh, om] = String(s?.open ?? "").split(":").map(Number);
      const [ch, cm] = String(s?.close ?? "").split(":").map(Number);
      const m = ch * 60 + cm - (oh * 60 + om);
      return Number.isFinite(m) && m > 0 ? m : 375;
    } catch {
      return 375;
    }
  };

  /** Calendar days from a to b. */
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  /** Monthly expiries: the last listed expiry of each calendar month (from data). */
  const monthlyOf = (expiries) => expiries.filter((e, i, all) => i === all.length - 1 || all[i + 1].slice(0, 7) !== e.slice(0, 7));

  /** Index expiries: the nearest indexExpiries, plus the nearest monthly when asked (§2.5). */
  function indexExpiries(list) {
    const out = list.slice(0, sc.indexExpiries);
    if (sc.indexMonthly) {
      const m = monthlyOf(list)[0];
      if (m && !out.includes(m)) out.push(m);
    }
    return out;
  }

  /** Stock expiries (§6.10): the nearest monthly; the next one too when the nearest is within nextExpiryWithinDays. */
  function stockExpiries(list, t = today()) {
    const monthly = monthlyOf(list);
    const out = monthly.slice(0, sc.stockExpiries);
    if (monthly[0] && daysBetween(t, monthly[0]) <= sc.nextExpiryWithinDays && monthly[1] && !out.includes(monthly[1])) out.push(monthly[1]);
    return out.slice(0, 2);
  }

  function validateBody(body) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
    for (const k of Object.keys(b)) if (!["underlyings", "stocks", "force", "method"].includes(k)) throw invalid(k, `Unknown field ${k}. Send { underlyings?, stocks?, force?, method? }.`);
    const u = b.underlyings ?? "indices+stocks";
    if (!(Array.isArray(u) ? u.length <= 500 && u.every((x) => typeof x === "string" && /^[A-Z0-9&-]{1,30}$/.test(x)) : ["indices", "stocks", "indices+stocks"].includes(u))) throw invalid("underlyings", 'underlyings must be "indices", "stocks", "indices+stocks" or an array of names.');
    const s = b.stocks ?? "all";
    if (!(Array.isArray(s) ? s.length <= 1000 && s.every((x) => typeof x === "string" && /^[A-Z0-9&-]{1,30}$/.test(x)) : ["all", "optIn"].includes(s))) throw invalid("stocks", 'stocks must be "all", "optIn" or an array of names.');
    if (b.force !== undefined && typeof b.force !== "boolean") throw invalid("force", "force must be true or false.");
    const m = b.method ?? sc.method;
    if (!["auto", "chain", "quotes"].includes(m)) throw invalid("method", 'method must be "auto", "chain" or "quotes".');
    return { underlyings: u, stocks: s, force: b.force === true, method: m };
  }

  /** The plan and the key list for a request (no broker call). */
  async function makePlan(body) {
    const req = validateBody(body);
    const accountId = chooseAccount();
    if (!accountId) throw new BridgeError("BROKER_UNAVAILABLE", "No connected account can serve quotes or option chains for the sweep. Connect a broker account first.");
    const acc = accountFacts(accountId);
    const names = await deps.universe.names();
    let indices = [];
    let stocks = [];
    if (Array.isArray(req.underlyings)) {
      indices = req.underlyings.filter((u) => names.indices.includes(u));
      stocks = req.underlyings.filter((u) => names.stocks.includes(u));
    } else {
      if (req.underlyings !== "stocks") indices = names.indices;
      if (req.underlyings !== "indices") {
        const optIn = settings.optIn?.stocks ?? [];
        const want = Array.isArray(req.stocks) ? req.stocks : req.stocks === "optIn" ? optIn : names.stocks;
        stocks = want.filter((s) => names.stocks.includes(s));
      }
    }
    // Keys from the masters' listed expiries.
    const indexKeys = [];
    for (const u of indices) {
      const f = await deps.universe.facts(u);
      for (const e of indexExpiries(f?.expiries ?? [])) indexKeys.push({ key: `${u}|${e}`, underlying: u, expiry: e, kind: "index" });
    }
    const stockExp = new Map();
    let E = 1;
    for (const u of stocks) {
      const f = await deps.universe.facts(u);
      const ex = stockExpiries(f?.expiries ?? []);
      if (ex.length) stockExp.set(u, ex);
      E = Math.max(E, ex.length);
    }
    stocks = stocks.filter((s) => stockExp.has(s));
    const optInCount = Array.isArray(req.stocks) || req.stocks === "optIn" ? stocks.length : null;
    const plan = planSweep({
      broker: acc.broker,
      policy: acc.policy,
      caps: { optionChain: acc.caps.optionChain },
      quotesVerified: QUOTES_VERIFIED.has(acc.broker),
      preferQuotes: deps.demo === true,
      indexKeys: indexKeys.length,
      indexSpots: acc.caps.optionChain ? 0 : indices.length,
      stocks: stocks.length,
      stockExpiries: E,
      method: req.method,
      cfg: { budgetShare: share, maxMinutes: sc.maxMinutes, stockStrikes: sc.stockStrikes, indexStrikes: sc.indexStrikes, minIntervalSeconds: sc.minIntervalSeconds },
      sessionMinutes: sessionMinutes(),
      optIn: optInCount,
      hvCalls: sc.hv.source === "off" ? 0 : indices.length + stocks.length,
      hvSource: hvSource(),
    });
    if (plan.error) throw new BridgeError(plan.error.code, plan.error.message);
    // Not everything fits: opted-in stocks first, then by name.
    let covered = stocks;
    if (plan.limited) {
      const optIn = new Set(settings.optIn?.stocks ?? []);
      covered = [...stocks].sort((a, b) => Number(optIn.has(b)) - Number(optIn.has(a)) || (a < b ? -1 : 1)).slice(0, plan.maxStocksThatFit);
    }
    const stockMethod = plan.groups.find((g) => g.kind === "stock")?.method ?? "chain";
    const stockKeys = [];
    for (const u of covered) for (const e of stockExp.get(u)) stockKeys.push({ key: `${u}|${e}`, underlying: u, expiry: e, kind: "stock" });
    return {
      req,
      account: { id: acc.id, broker: acc.broker },
      acc,
      plan: { account: { id: acc.id, broker: acc.broker }, ...plan },
      keys: [...indexKeys, ...stockKeys],
      stockMethod,
      indices,
      stocks: covered,
      skipped: stocks.filter((s) => !covered.includes(s)),
    };
  }

  /** BackupDataService reports its switch through status().enabled (it has no enabled() method). */
  function backupEnabled() {
    try {
      return usable(deps.backupData) && deps.backupData.status?.()?.enabled === true;
    } catch {
      return false;
    }
  }

  function hvSource() {
    if (sc.hv.source === "off") return "off";
    if (sc.hv.source === "backup") return "backup";
    if (sc.hv.source === "auto" && backupEnabled()) return "backup";
    return "broker";
  }

  // ── job state ──

  function publicJob(j = job, extra = {}) {
    if (!j) return null;
    const elapsed = (j.finishedAt ? Date.parse(j.finishedAt) : now()) - Date.parse(j.startedAt);
    const rate = j.done > 0 && elapsed > 0 ? j.done / elapsed : null;
    const left = j.keys.length - j.done - Object.keys(j.failedKeys ?? {}).length;
    return {
      id: j.id,
      status: j.status,
      requestedBy: j.requestedBy,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt ?? null,
      plan: j.plan,
      progress: {
        total: j.keys.length,
        done: j.done,
        failed: Object.keys(j.failedKeys ?? {}).length,
        phase: j.phase ?? null,
        current: j.current ?? null,
        etaSeconds: TERMINAL.has(j.status) ? 0 : rate ? Math.ceil(left / rate / 1000) : null,
        calls: { ...(j.calls ?? {}) },
        hv: { ...(j.hv ?? { done: 0, total: 0 }) },
      },
      cursor: seq,
      durationMs: j.finishedAt ? elapsed : null,
      joined: false,
      reused: false,
      lease: { until: leaseUntil > now() ? toIstIso(leaseUntil) : null },
      ...extra,
    };
  }

  function saveState() {
    try {
      store.writeState(job);
    } catch (err) {
      log?.warn?.("fno: could not save sweep state", { code: err?.code });
    }
  }

  function emitProgress(force = false) {
    const t = now();
    if (!force && t - lastProgressAt < PROGRESS_EVERY_MS) return;
    lastProgressAt = t;
    try {
      deps.bus?.emit?.("fno.sweep.progress", { jobId: job.id, status: job.status, progress: publicJob().progress });
    } catch {
      // diagnostics only
    }
  }

  function resetDay(day) {
    if (cacheDay === day) return;
    cache = new Map();
    seq = 0;
    cacheDay = day;
    oiBase = store.readOiBase(day);
    hvDoc = store.readHv(day);
    try {
      store.pruneDays({ keepDays: cfg.retentionDays + 2, today: day });
    } catch {
      // retention is best effort
    }
  }

  function putChain(key, method, chain) {
    seq += 1;
    const line = { key, seq, at: toIstIso(now()), method, chain };
    cache.set(key, line);
    try {
      store.appendChain(job.id, line);
    } catch (err) {
      log?.warn?.("fno: could not append a sweep chain", { code: err?.code });
    }
  }

  // ── gate and calls ──

  /**
   * Before each call. The F0 background gate keeps every window at or above (1 − share) of its limit, and the call is
   * scheduled with backgroundShare so the scheduler re-checks that floor at dispatch ("floor" mode).
   *
   * A window of limit 1 (Dhan and Zerodha quotes: 1 per second) cannot be split: its floor equals its limit, so the
   * gate would never let a background call through. For such a class the sweep paces itself instead ("paced" mode):
   * it starts a call only when no other work is queued or running on any window of the class (every window has room
   * for the call) and its own calls in the last minute stay within share × the class's per-minute rate (§6.9's R), so
   * it never takes more than `share` of the budget over a minute. The call still runs at priority "background",
   * behind every user and order call (§7: on a 1/s class one sweep call in flight can delay a user call by ≤ 1 s).
   */
  const paced = new Map();
  async function gated(acc, cls, cost, signal) {
    if (!gate) return "floor";
    for (;;) {
      if (signal?.aborted) throw abortErr();
      const d = gate.check(acc.id, cls, { share, cost });
      if (d.ok) return "floor";
      if (onlyUnsplittableBlock(acc.id, cls, cost) && pacedAllows(acc, cls, cost)) {
        const list = paced.get(`${acc.id}|${cls}`) ?? [];
        for (let i = 0; i < cost; i += 1) list.push(now());
        paced.set(`${acc.id}|${cls}`, list);
        return "paced";
      }
      await wait(Math.min(2000, Math.max(50, d.waitMs)), signal);
    }
  }
  /** True when every window that refuses is one whose floor equals its limit (limit × share < 1: a 1/s window). */
  function onlyUnsplittableBlock(accountId, cls, cost) {
    let view;
    try {
      view = deps.scheduler.headroomWindows(accountId, cls);
    } catch {
      return false;
    }
    if ((view?.backoffMs ?? 0) > 0) return false;
    const refusing = (view?.windows ?? []).filter((w) => Number.isFinite(w.limit) && w.remaining - cost < Math.ceil((1 - share) * w.limit));
    return refusing.length > 0 && refusing.every((w) => Math.ceil((1 - share) * w.limit) >= w.limit);
  }
  function pacedAllows(acc, cls, cost) {
    let windows = [];
    try {
      windows = deps.scheduler.headroomWindows(acc.id, cls).windows;
    } catch {
      return false;
    }
    // Nothing else queued or running: every window has room for the whole call.
    if (windows.some((w) => Number.isFinite(w.limit) && w.remaining < cost)) return false;
    const perMin = perMinuteOf(acc.policy, cls) ?? 60;
    const allowed = Math.max(1, Math.floor(share * perMin));
    const t = now();
    const recent = (paced.get(`${acc.id}|${cls}`) ?? []).filter((x) => t - x < 60_000);
    paced.set(`${acc.id}|${cls}`, recent);
    return recent.length + cost <= allowed;
  }
  /** backgroundShare for a call in this mode (paced calls carry none: the scheduler floor cannot split a limit of 1). */
  const shareFor = (mode) => (mode === "floor" ? share : undefined);
  const abortErr = () => Object.assign(new Error("The sweep was cancelled."), { name: "AbortError" });
  const pace = (signal) => (deps.demo && cfg.demo.callDelayMs > 0 ? wait(cfg.demo.callDelayMs, signal) : Promise.resolve());

  /** One call with rate-limit handling: pause on UPSTREAM_RATE_LIMITED, retry once (never on Fyers). */
  async function withRetry(acc, fn, signal) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== "UPSTREAM_RATE_LIMITED" || signal?.aborted) throw err;
      const ms = Math.min(60_000, Math.max(1000, Number(err?.retryAfterMs ?? err?.details?.retryAfterMs) || 2000));
      job.pausedUntil = toIstIso(now() + ms);
      await wait(ms, signal);
      job.pausedUntil = null;
      if (acc.broker === "fyers") throw err;
      return fn();
    }
  }

  const bump = (cls, n = 1) => {
    job.calls[cls] = (job.calls[cls] ?? 0) + n;
  };

  /** The most broker calls one wave may take: share of the tightest window (at least 1). */
  function maxWaveCost(accountId, cls) {
    try {
      const limits = deps.scheduler.headroomWindows(accountId, cls).windows.map((w) => w.limit).filter((x) => Number.isFinite(x) && x > 0);
      return limits.length ? Math.max(1, Math.floor(share * Math.min(...limits))) : 1;
    } catch {
      return 1;
    }
  }

  async function readQuotes(acc, symbols, signal) {
    const B = Math.max(1, Math.floor(acc.policy?.maxQuoteBatch ?? 1));
    const out = new Map();
    // One wave = as many instruments as `maxWaveCost` broker calls carry (B each), sent as route-sized chunks at once,
    // so the batcher fills maxQuoteBatch per call and one wave never needs more than the background share of a window.
    const perWave = Math.max(1, maxWaveCost(acc.id, "quote")) * B;
    for (let i = 0; i < symbols.length; i += perWave) {
      const slice = symbols.slice(i, i + perWave);
      const wave = [];
      for (let j = 0; j < slice.length; j += ROUTE_CHUNK) wave.push(slice.slice(j, j + ROUTE_CHUNK));
      const cost = Math.max(1, Math.ceil(slice.length / B));
      const mode = await gated(acc, "quote", cost, signal);
      await pace(signal);
      const results = await Promise.all(
        wave.map((chunk) => withRetry(acc, () => deps.marketData.quotes(chunk, { priority: "background", accountId: acc.id, maxAgeMs: 5000, backgroundShare: shareFor(mode), signal }), signal)),
      );
      bump("quote", cost);
      for (const r of results) for (const it of r?.items ?? []) out.set(it.symbol, it);
    }
    return out;
  }

  async function baselineFor(legs, quotes, t) {
    const day = today();
    let changed = false;
    const base = {};
    for (const l of legs) {
      const q = quotes.get(l.canonical);
      let first = oiBase.firstAt[l.canonical];
      if (!first && deps.demoBaseline) {
        first = await deps.demoBaseline(l.canonical, day);
        if (first) {
          oiBase.firstAt[l.canonical] = first;
          changed = true;
        }
      }
      if (!first && Number.isFinite(q?.oi)) {
        first = [hhmm(t), q.oi];
        oiBase.firstAt[l.canonical] = first;
        changed = true;
      }
      if (first) base[l.canonical] = first;
    }
    if (changed) {
      oiBaseDirty = true;
      if (now() - oiBaseSavedAt >= 10_000) saveOiBase();
    }
    return base;
  }

  /** The day's OI baseline is written at most every 10 s while a sweep runs, and once at its end (~330 KB/day). */
  let oiBaseDirty = false;
  let oiBaseSavedAt = 0;
  function saveOiBase() {
    if (!oiBaseDirty || !oiBase) return;
    try {
      store.writeOiBase(oiBase);
      oiBaseDirty = false;
      oiBaseSavedAt = now();
    } catch {
      // the baseline is rebuilt from the next sweep
    }
  }

  async function legsFor(underlying, expiry, exchange = "NFO") {
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      // The explicit exchange keeps an underlying named like an exchange word (BSE, MCX) from filtering the master.
      const res = await deps.symbols.search({ q: underlying, underlying, exchange, kind: "OPT", expiry, limit: 500, ...(cursor ? { cursor } : {}) });
      for (const r of res?.items ?? []) if (r.underlying === underlying && r.expiry === expiry && (r.right === "CE" || r.right === "PE")) out.push({ canonical: r.canonical, strike: r.strike, right: r.right, lotSize: r.lotSize, tickSize: r.tickSize });
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * ΔOI basis 2 (§6.11): the last OI the recorder holds for each contract on the previous trading day, read in-process
   * (no broker call), once per key and day. Returns strike|right -> OI, or null without a recorder or a record.
   */
  const recorderPrevCache = new Map();
  async function recorderPrevFor(underlying, expiry) {
    const rec = deps.recorder;
    if (!usable(rec) || typeof rec.snapshots !== "function") return null;
    const day = today();
    const ck = `${day}|${underlying}|${expiry}`;
    if (recorderPrevCache.has(ck)) return recorderPrevCache.get(ck);
    let out = null;
    try {
      const cal = deps.reference?.calendar?.();
      const prev = typeof cal?.prevTradingDay === "function" ? cal.prevTradingDay(day, "NFO") : null;
      if (prev) {
        // The previous day's close from the reference sessions (no session, no read).
        let close = null;
        try {
          const s = deps.reference?.session?.("NFO", Date.parse(`${prev}T12:00:00+05:30`));
          if (/^\d{2}:\d{2}$/.test(String(s?.close ?? ""))) close = s.close;
        } catch {
          close = null;
        }
        const toMs = close ? Date.parse(`${prev}T${close}:00+05:30`) : NaN;
        const page = Number.isFinite(toMs) && (await rec.snapshots({ underlying, expiry, fromMs: toMs - 10 * 60_000, toMs, fields: ["oi"], limit: 400 }));
        const snap = (page?.snapshots ?? []).at(-1);
        if (snap && Array.isArray(snap.k)) {
          out = new Map();
          snap.k.forEach((k, i) => {
            const ce = snap.ce?.oi?.[i];
            const pe = snap.pe?.oi?.[i];
            if (Number.isFinite(ce)) out.set(`${k}|CE`, ce);
            if (Number.isFinite(pe)) out.set(`${k}|PE`, pe);
          });
          if (!out.size) out = null;
        }
      }
    } catch {
      out = null;
    }
    recorderPrevCache.set(ck, out);
    if (recorderPrevCache.size > 2000) recorderPrevCache.delete(recorderPrevCache.keys().next().value);
    return out;
  }

  /** recorderPrev keyed by contract symbol for chainFromQuotes / withBrokerBasis. */
  const prevBySymbol = (prev, legs) => (prev ? new Map(legs.filter((l) => prev.has(`${l.strike}|${l.right}`)).map((l) => [l.canonical, prev.get(`${l.strike}|${l.right}`)])) : null);

  // ── the runner ──

  async function runChainKey(acc, k, strikes, signal) {
    const cls = acc.caps.optionChain ? "chain" : "quote";
    const mode = await gated(acc, cls, 1, signal);
    await pace(signal);
    job.current = k.key;
    const chain = await withRetry(acc, () => deps.marketData.optionChain({ underlying: k.underlying, expiry: k.expiry, strikes, greeks: true }, { priority: "background", accountId: acc.id, maxAgeMs: 5000, backgroundShare: shareFor(mode), signal }), signal);
    bump(cls, acc.caps.optionChain ? 1 : 2);
    const legs = chain.rows.flatMap((r) => [["CE", r.ce], ["PE", r.pe]].filter(([, l]) => l).map(([right, l]) => ({ canonical: l.symbol, strike: r.strike, right })));
    const quotes = new Map(chain.rows.flatMap((r) => [r.ce, r.pe].filter(Boolean).map((l) => [l.symbol, l])));
    const base = await baselineFor(legs, quotes, now());
    const recorderPrev = prevBySymbol(await recorderPrevFor(k.underlying, k.expiry), legs);
    return withBrokerBasis(chain, { dayBase: base, recorderPrev });
  }

  async function run(plan, signal) {
    const acc = plan.acc;
    const keys = job.keys.filter((k) => !cache.has(k) && !(k in (job.failedKeys ?? {})));
    const byKey = new Map(plan.keyObjs.map((k) => [k.key, k]));
    const todo = keys.map((k) => byKey.get(k)).filter(Boolean);
    const fail = (key, err) => {
      job.failedKeys[key] = err?.code ?? "UPSTREAM_ERROR";
    };
    // 1. Spots first: one batched read, only for the quotes path (a chain call carries its own spot). As planned
    //    (plan.mjs): the stocks' spots, plus the index spots when index chains are not served by a chain endpoint.
    job.phase = "spots";
    emitProgress(true);
    let spots = new Map();
    if (plan.stockMethod === "quotes") {
      const spotSymbols = [...new Set(todo.filter((k) => k.kind === "stock" || !acc.caps.optionChain).map((k) => plan.spotOf.get(k.underlying)).filter(Boolean))];
      try {
        spots = await readQuotes(acc, spotSymbols, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        log?.warn?.("fno: the spot read failed; chains read their own spots", { code: err?.code });
      }
    }
    // 2. Index chains.
    job.phase = "index-chains";
    for (const k of todo.filter((x) => x.kind === "index")) {
      if (signal.aborted) throw abortErr();
      try {
        putChain(k.key, "chain", await runChainKey(acc, k, sc.indexStrikes, signal));
        job.done += 1;
      } catch (err) {
        if (signal.aborted) throw err;
        fail(k.key, err);
      }
      emitProgress();
    }
    // 3. Stock chains.
    job.phase = "stock-chains";
    const stockKeys = todo.filter((x) => x.kind === "stock");
    if (plan.stockMethod === "chain") {
      for (const k of stockKeys) {
        if (signal.aborted) throw abortErr();
        try {
          putChain(k.key, "chain", await runChainKey(acc, k, sc.stockStrikes, signal));
          job.done += 1;
        } catch (err) {
          if (signal.aborted) throw err;
          fail(k.key, err);
        }
        emitProgress();
      }
    } else {
      const B = Math.max(1, Math.floor(acc.policy?.maxQuoteBatch ?? 1));
      // Batches of keys that fill about one broker call each, so progress moves and a restart loses little.
      let batch = [];
      let batchLegs = 0;
      const flush = async () => {
        if (!batch.length) return;
        const work = batch;
        batch = [];
        batchLegs = 0;
        const all = work.flatMap((w) => w.legs.map((l) => l.canonical));
        job.current = work[0].k.key;
        let quotes;
        try {
          quotes = await readQuotes(acc, all, signal);
        } catch (err) {
          if (signal.aborted) throw err;
          for (const w of work) fail(w.k.key, err);
          return;
        }
        const t = now();
        for (const w of work) {
          const got = w.legs.filter((l) => quotes.has(l.canonical));
          if (!got.length) {
            fail(w.k.key, { code: "UPSTREAM_ERROR" });
            continue;
          }
          const dayBase = await baselineFor(w.legs, quotes, t);
          const recorderPrev = prevBySymbol(await recorderPrevFor(w.k.underlying, w.k.expiry), w.legs);
          const freshness = quotes.get(got[0].canonical)?.freshness ?? null;
          const chain = chainFromQuotes({ legs: w.legs, quotes, spot: w.spot, expiry: w.k.expiry, underlying: w.k.underlying, lotSize: w.lot, tickSize: w.tick, strikeStep: w.step, kind: "stock", nowMs: t, rate: plan.rate, dayBase, recorderPrev, freshness });
          putChain(w.k.key, "quotes", chain);
          job.done += 1;
        }
        emitProgress();
      };
      for (const k of stockKeys) {
        if (signal.aborted) throw abortErr();
        const f = await deps.universe.facts(k.underlying);
        let legs = [];
        try {
          legs = await legsFor(k.underlying, k.expiry, f?.exchange ?? "NFO");
        } catch (err) {
          fail(k.key, err);
          continue;
        }
        if (!legs.length) {
          fail(k.key, { code: "SYMBOL_NOT_FOUND" });
          continue;
        }
        const spot = spots.get(plan.spotOf.get(k.underlying))?.ltp ?? null;
        const strikes = spot ? strikeWindow(legs.map((l) => l.strike), spot, sc.stockStrikes) : null;
        const keep = strikes ? new Set(strikes) : null;
        const windowed = keep ? legs.filter((l) => keep.has(l.strike)) : legs;
        const lots = new Map();
        for (const l of windowed) lots.set(l.lotSize, (lots.get(l.lotSize) ?? 0) + 1);
        const lot = [...lots.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const ticks = windowed.map((l) => l.tickSize).filter((x) => x > 0);
        batch.push({ k, legs: windowed, spot, lot, tick: ticks.length ? Math.max(...ticks) : null, step: f?.strikeStep ?? null });
        batchLegs += windowed.length;
        if (batchLegs >= 4 * B) await flush();
      }
      await flush();
    }
    // 4. HV pass (after the chains; never holds them back).
    job.phase = "hv";
    job.current = null;
    if (hvSource() !== "off") {
      const unders = [...new Set(plan.keyObjs.map((k) => k.underlying))];
      const need = unders.filter((u) => !Number.isFinite(hvDoc.hv[u]));
      job.hv = { done: unders.length - need.length, total: unders.length };
      for (const u of need) {
        if (signal.aborted) throw abortErr();
        try {
          const useBackup = hvSource() === "backup" && typeof deps.backupData?.history === "function";
          // Only the broker read draws on the account's budget.
          const mode = useBackup ? null : await gated(acc, "history", 1, signal);
          await pace(signal);
          const symbol = plan.spotOf.get(u);
          // The backup service takes a time range, not a countback: ~1.6 calendar days per daily candle covers weekends
          // and holidays.
          const t = now();
          const res =
            useBackup
              ? await deps.backupData.history({ symbol, interval: "1d", fromMs: t - Math.ceil(sc.hv.candles * 1.6 + 5) * 86_400_000, toMs: t })
              : await deps.marketData.history({ symbol, interval: "1d", countback: sc.hv.candles }, { priority: "background", accountId: acc.id, backgroundShare: shareFor(mode), signal });
          if (!useBackup) bump("history");
          const candles = res?.candles ?? res?.items ?? [];
          const closes = candles.map((c) => (Array.isArray(c) ? c[4] : c?.close)).filter((x) => Number.isFinite(x));
          const hv = realisedVol(closes, 20);
          if (Number.isFinite(hv)) hvDoc.hv[u] = Math.round(hv * 100) / 100;
        } catch (err) {
          if (signal.aborted) throw err;
        }
        job.hv.done += 1;
        emitProgress();
      }
      try {
        store.writeHv(hvDoc);
      } catch {
        // HV is fetched again tomorrow
      }
    }
    job.phase = null;
  }

  function launch(planned, { requestedBy, resumeOf = null }) {
    const t = now();
    resetDay(today());
    if (!resumeOf) {
      job = {
        id: newJobId(),
        day: today(),
        status: "running",
        requestedBy,
        plan: planned.plan,
        keys: planned.keys.map((k) => k.key),
        done: 0,
        failedKeys: {},
        calls: {},
        hv: { done: 0, total: 0 },
        startedAt: toIstIso(t),
        finishedAt: null,
        phase: "queued",
        current: null,
      };
      cache = new Map();
      seq = 0;
    } else {
      job.status = "running";
    }
    coverage = { day: today(), byUnderlying: new Map(), limitedReason: planned.plan.limited ? planned.plan.message : null };
    for (const k of planned.keys) coverage.byUnderlying.set(k.underlying, k.kind === "index" ? "chain" : planned.stockMethod);
    for (const s of planned.skipped) coverage.byUnderlying.set(s, null);
    saveState();
    try {
      store.pruneJobs(sc.keepJobs, job.id);
    } catch {
      // retention is best effort
    }
    abort = new AbortController();
    const signal = abort.signal;
    const started = now();
    // `running` is set before the first await, so a second start in the same tick joins this one.
    running = (async () => {
      const spotOf = new Map();
      const names = await deps.universe.list({ kind: "all" });
      for (const i of names.items) spotOf.set(i.underlying, i.spot);
      let rate = null;
      try {
        rate = deps.reference?.rate?.()?.value ?? null;
      } catch {
        rate = null;
      }
      await run({ ...planned, keyObjs: planned.keys, spotOf, rate: Number.isFinite(rate) ? rate : 0 }, signal);
    })()
      .then(() => {
        job.status = Object.keys(job.failedKeys).length ? (job.done > 0 ? "partial" : "failed") : "done";
      })
      .catch((err) => {
        if (signal.aborted || err?.name === "AbortError") job.status = "cancelled";
        else {
          job.status = "failed";
          job.error = { code: err?.code ?? "INTERNAL", message: String(err?.message ?? err).slice(0, 200) };
          log?.warn?.("fno: the sweep failed", { code: err?.code });
        }
      })
      .finally(() => {
        saveOiBase();
        job.finishedAt = toIstIso(now());
        job.phase = null;
        job.current = null;
        saveState();
        emitProgress(true);
        try {
          deps.bus?.emit?.("fno.sweep.completed", { jobId: job.id, status: job.status, chains: job.done, failed: Object.keys(job.failedKeys).length, durationMs: now() - started });
        } catch {
          // diagnostics only
        }
        running = null;
        abort = null;
      });
    return job;
  }

  // ── public API ──

  const isActive = () => job && (job.status === "running" || job.status === "queued") && running;

  async function startSweep(body = {}, { requestedBy = "rest" } = {}) {
    const req = validateBody(body);
    if (isActive()) return { job: publicJob(job, { joined: true }), created: false };
    const last = job && job.day === today() && job.finishedAt ? Date.parse(job.finishedAt) : null;
    if (!req.force && last !== null && now() - last < sc.minIntervalSeconds * 1000 && job.status !== "cancelled") return { job: publicJob(job, { reused: true }), created: false };
    const planned = await makePlan(req);
    // Another request may have started one while this one planned.
    if (isActive()) return { job: publicJob(job, { joined: true }), created: false };
    launch(planned, { requestedBy });
    return { job: publicJob(job), created: true };
  }

  function current({ lease = false } = {}) {
    if (lease) leaseUntil = now() + sc.leaseSeconds * 1000;
    if (!job || job.day !== today()) throw new BridgeError("NOT_FOUND", "No option sweep has run today.");
    return publicJob(job);
  }

  function chains({ since = 0, limit = 40 } = {}) {
    if (!job || job.day !== today()) throw new BridgeError("NOT_FOUND", "No option sweep has run today.");
    const items = [...cache.values()].filter((x) => x.seq > since).sort((a, b) => a.seq - b.seq);
    const page = items.slice(0, limit);
    const finished = TERMINAL.has(job.status);
    const done = finished && page.length === items.length;
    return {
      items: page,
      nextCursor: page.length ? page[page.length - 1].seq : since,
      done,
      ...(done ? { hv: { ...(hvDoc?.hv ?? {}) } } : {}),
    };
  }

  async function cancel() {
    if (!job || job.day !== today()) throw new BridgeError("NOT_FOUND", "No option sweep has run today.");
    if (abort) abort.abort();
    leaseUntil = 0;
    if (running) await running.catch(() => {});
    return publicJob(job);
  }

  async function setSettings(body, actor) {
    const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
    const invalid = (path, message, extra = {}) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }], ...extra });
    if (!b) throw invalid("body", 'Send { "optIn": ["RELIANCE"], "background": false }.');
    for (const k of Object.keys(b)) if (k !== "optIn" && k !== "background") throw invalid(k, `Unknown field ${k}.`);
    if (b.background !== undefined && typeof b.background !== "boolean") throw invalid("background", "background must be true or false.");
    let optIn = settings.optIn?.stocks ?? [];
    if (b.optIn !== undefined) {
      if (!Array.isArray(b.optIn) || b.optIn.some((x) => typeof x !== "string")) throw invalid("optIn", "optIn must be an array of stock names.");
      if (b.optIn.length > cfg.universe.maxStocks) throw invalid("optIn", `optIn holds at most ${cfg.universe.maxStocks} stocks.`);
      const names = await deps.universe.names();
      const want = [...new Set(b.optIn.map((s) => s.trim().toUpperCase()))];
      const unknown = want.filter((s) => !names.stocks.includes(s));
      if (unknown.length) throw invalid("optIn", `Not F&O stocks in the list: ${unknown.slice(0, 20).join(", ")}.`, { unknown });
      optIn = want;
    }
    settings = { version: 1, optIn: { stocks: optIn, setAt: toIstIso(now()), setBy: actor ?? null }, autoRepeat: { background: b.background ?? settings.autoRepeat?.background ?? false } };
    store.writeSettings(settings);
    return { ...publicSettings(), persisted: store.persisted };
  }

  const publicSettings = () => ({ optIn: [...(settings.optIn?.stocks ?? [])], setAt: settings.optIn?.setAt ?? null, setBy: settings.optIn?.setBy ?? null, background: settings.autoRepeat?.background === true, leaseSeconds: sc.leaseSeconds, persisted: store.persisted });

  // ── timers: auto-repeat, day roll, resume ──

  function sessionOpen() {
    try {
      const s = deps.reference?.session?.("NFO");
      return s ? s.state === "OPEN" : false;
    } catch {
      return false;
    }
  }

  async function tick() {
    const d = today();
    if (cacheDay && cacheDay !== d && !isActive()) resetDay(d);
    if (isActive()) return null;
    const wanted = leaseUntil > now() || settings.autoRepeat?.background === true;
    if (!wanted || !sessionOpen()) return null;
    const interval = (job?.plan?.autoIntervalSec ?? sc.minIntervalSeconds) * 1000;
    const last = job && job.day === d && job.finishedAt ? Date.parse(job.finishedAt) : null;
    if (last !== null && now() - last < interval) return null;
    try {
      return (await startSweep({}, { requestedBy: "auto" })).job;
    } catch (err) {
      log?.debug?.("fno: auto sweep did not start", { code: err?.code });
      return null;
    }
  }

  async function resume() {
    if (!job || job !== bootJob || isActive() || TERMINAL.has(job.status)) return null;
    const startedAt = Date.parse(job.startedAt);
    const fresh = job.day === today() && now() - startedAt < sc.resumeWithinMinutes * 60_000;
    if (!fresh) {
      job.status = "interrupted";
      job.finishedAt = job.finishedAt ?? toIstIso(now());
      saveState();
      return publicJob(job);
    }
    resetDay(job.day);
    for (const line of store.readChains(job.id).items) {
      cache.set(line.key, line);
      seq = Math.max(seq, line.seq);
    }
    job.done = cache.size;
    let planned;
    try {
      planned = await makePlan({});
    } catch (err) {
      job.status = "interrupted";
      job.finishedAt = toIstIso(now());
      job.error = { code: err?.code ?? "INTERNAL", message: "The sweep could not be resumed." };
      saveState();
      return publicJob(job);
    }
    // Keep the original key list; plan objects only for keys the job still needs.
    const wantKeys = new Set(job.keys);
    planned.keys = planned.keys.filter((k) => wantKeys.has(k.key));
    const planKeys = new Set(planned.keys.map((k) => k.key));
    for (const k of job.keys) if (!cache.has(k) && !planKeys.has(k)) job.failedKeys[k] = "NOT_RESUMED";
    if (isActive()) return publicJob(job);
    launch(planned, { requestedBy: job.requestedBy, resumeOf: job.id });
    return publicJob(job);
  }

  let minuteTimer = null;
  let resumeTimer = null;
  function startTimers() {
    resetDay(today());
    if (job && job.day === today() && TERMINAL.has(job.status)) {
      for (const line of store.readChains(job.id).items) {
        cache.set(line.key, line);
        seq = Math.max(seq, line.seq);
      }
    }
    resumeTimer = setT(() => resume().catch(() => {}), 5000);
    resumeTimer?.unref?.();
    const loop = () => {
      minuteTimer = setT(() => {
        tick()
          .catch(() => {})
          .finally(() => {
            if (minuteTimer) loop();
          });
      }, 60_000);
      minuteTimer?.unref?.();
    };
    loop();
  }
  function stopTimers() {
    if (minuteTimer) clearT(minuteTimer);
    if (resumeTimer) clearT(resumeTimer);
    minuteTimer = null;
    resumeTimer = null;
    if (abort) abort.abort();
  }

  return {
    plan: async (body) => (await makePlan(body)).plan,
    start: startSweep,
    current,
    chains,
    cancel,
    settings: publicSettings,
    setSettings,
    tick,
    resume,
    startTimers,
    stopTimers,
    /** Coverage of one underlying by the last plan (for the universe list). */
    coverageFor(u) {
      if (coverage.day !== today() || !coverage.byUnderlying.has(u)) return { covered: false, method: null };
      const m = coverage.byUnderlying.get(u);
      return m ? { covered: true, method: m } : { covered: false, method: null, limitedReason: coverage.limitedReason };
    },
    /** Waits for the running job (tests). */
    idle: () => running ?? Promise.resolve(),
    leaseActive: () => leaseUntil > now(),
    /** For the stock-chain helpers above (tests). */
    _internals: { stockExpiries, indexExpiries },
  };
}
