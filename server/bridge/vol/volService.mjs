/**
 * VolService (stream S18, docs/spec/p1-03-pricing-vol.md §2.2–2.8, §3, §4). The vol-time clock, the daily vol store
 * (S2) with its 15:25 capture, IV rank and percentile, the IV history, INDIA VIX and the prediction log (S9).
 *
 *  - Scheduler (§2.4): a 60-second tick (unref'd). On a trading day: capture at close − 5 min, retry at close + 5 for
 *    failed or partial underlyings (and the closing VIX and spot for all), a late capture from closing quotes up to
 *    close + 30 when today has no row, then an explicit missed row. At start, missed rows for earlier trading days the
 *    Bridge was off. Compaction at 02:30. No session literal: every time comes from reference.session().
 *  - Chains (§2.7): the recorder's snapshot nearest now when the recorder runs (no broker call); otherwise
 *    marketData.optionChain at priority "background" inside the background share, pinned to ONE data account
 *    (vol.account, else the recorder's data account, else the account that served the first read).
 *  - Reads (rank, history, summary, status, clock) are memory/disk only: 0 broker calls.
 *  - Demo (§4): the store lives in dataDir/vol-demo/, is seeded with 300 days on first start (demoVol.mjs), a manual
 *    capture works at any time, and `demoPartial` ranks against the live days only.
 *
 * Back-fill (backfill/cancelBackfill) lands with step P1-3c and answers NOT_IMPLEMENTED until then.
 */
import { join } from "node:path";
import { isStub } from "../core/contracts.mjs";
import { BridgeError, NotImplementedError } from "../core/errors.mjs";
import { ivRank, sameDteRows, volTime } from "../dashboard/pricing.js";
import { defaultOptionExchange } from "../market/chain.mjs";
import { istDate, toIstIso } from "../market/time.mjs";
import { createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { chainFromSnapshot, chooseExpiries, cm30Of, cmTargetDate, expiryRow, frontOf, hvOf, missedRow, predictionRows, round, summaryRow } from "./capture.mjs";
import { parseVolConfig } from "./config.mjs";
import { kindOf, pricingContext } from "./context.mjs";
import { candles as demoCandles, demoChainAt, expiriesFor as demoExpiries, spotAt as demoSpot } from "../demo/demoAdapter.mjs";
import { DEMO_VOL_UNDERLYINGS, isoIst, istAtHm, seedDemoHistory } from "./demoVol.mjs";
import { createVolStore } from "./store.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNDERLYING_RE = /^[A-Z0-9&-]{1,30}$/;
const DAY_MS = 86_400_000;
const MINUTE = 60_000;
/** Listed expiries the clock reports when none are named (§3.3). */
const MAX_EXPIRY_DAYS = 100;
/** How far ahead the clock payload lists holidays (§3.3): enough for the dashboard to rebuild its clock. */
const HOLIDAY_DAYS = 400;
const MASTER_PAGE_LIMIT = 500;
const MASTER_MAX_PAGES = 20;
/** Most days of missed rows written at start for days the Bridge was off. */
const MAX_MISSED_BACKFILL = 30;
/** A recorder snapshot this close to the capture instant is used instead of a broker read. */
const RECORDER_MAX_AGE_MS = 5 * MINUTE;
const COMPACT_AT = "02:30";
/** Demo: seed the history this long after start when nothing has asked for vol data before. */
const SEED_DELAY_MS = 10_000;
const BSE_INDICES = new Set(["SENSEX", "BANKEX", "SENSEX50"]);
export const SERIES = Object.freeze(["iv", "ivCal", "vix", "hv10", "hv20", "hv60", "park20", "yz20", "ivHv20", "spotClose", "rr25", "bf25", "straddle", "forward"]);
export const DEFAULT_SERIES = Object.freeze(["iv", "vix", "hv20", "ivHv20"]);
export const CLOCKS = Object.freeze(["weighted", "trading", "calendar"]);
export const BASES = Object.freeze(["cm30", "front", "expiry"]);
/** Prediction metrics logged today (the list is open: any name matching METRIC_RE is accepted). */
export const PREDICTION_METRICS = Object.freeze(["band1", "band2", "eam", "pItmBand", "pop", "chanceOfProfit", "pItm", "expectedMove"]);
const METRIC_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_RANGE_DAYS = 1100;
const MAX_LIMIT = 2000;
const MAX_UNDERLYINGS = 200;
/** Demo strike steps (the demo adapter's grid) for the seeded end-of-day files. */
const DEMO_STEPS = Object.freeze({ NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100 });

const usable = (svc) => Boolean(svc) && !isStub(svc);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
const later = (m) => () => {
  throw new NotImplementedError(`VolService.${m}() (stream S18, step P1-3c)`);
};
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const isWeekendDate = (d) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
};

/** Canonical spot symbol of an underlying. */
export const spotSymbolOf = (u) => `${BSE_INDICES.has(u) ? "BSE" : "NSE"}:${u}`;

export function underlyingOf(v, path = "underlying") {
  if (v === undefined || v === null || v === "") throw invalid(path, `${path} is required, for example NIFTY.`);
  const u = String(v).trim().toUpperCase();
  if (!UNDERLYING_RE.test(u)) throw invalid(path, `${path} must be 1-30 letters, digits, & or -.`);
  return u;
}
export function dateOf(v, path) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) throw invalid(path, `${path} must be a real date, YYYY-MM-DD.`);
  return s;
}
const oneOf = (v, list, path, dflt) => {
  if (v === undefined || v === null || v === "") return dflt;
  if (!list.includes(v)) throw invalid(path, `${path} must be one of ${list.join(", ")}.`);
  return v;
};

/** σ (vol points) of a slim expiry row on another clock, through total variance (§6.2). */
function slimIv(r, clock, mode) {
  if (clock === mode && num(r.atmIv) !== null) return r.atmIv;
  const T = clock === "calendar" ? r.Tcal : clock === "trading" ? r.Ttd : r.Tw;
  return num(r.tv) > 0 && num(T) > 0 ? round(Math.sqrt(r.tv / T) * 100, 2) : null;
}
const slimOfRow = (row) => ({ ...row, Tw: row.clock?.Tw ?? row.clock?.T, Tcal: row.clock?.Tcal, Ttd: row.clock?.Ttd });

/**
 * @param {object} deps  core deps plus marketData, reference, symbols, scheduler, recorder (optional)
 */
export function createVolService(deps) {
  const { config, clock } = deps;
  const log = deps.logger?.child ? deps.logger.child({ module: "vol" }) : deps.logger;
  const bus = deps.bus;
  const now = () => clock.now();
  const demo = Boolean(config?.demo);
  const s = config?.vol && typeof config.vol === "object" && config.vol.capture ? config.vol : parseVolConfig(config?.vol ?? {});
  const mode = s.clock.mode;
  const store = config?.dataDir ? createVolStore({ root: join(config.dataDir, demo ? "vol-demo" : "vol"), logger: log, retentionDays: s.retentionDays, predictionRetentionDays: s.predictions.retentionDays }) : null;
  const gate = usable(deps.scheduler) && typeof deps.scheduler.headroom === "function" ? createBackgroundGate({ scheduler: deps.scheduler }) : null;

  let loaded = false;
  let state = { days: {}, lastCompact: null, lastRun: null };
  let timer = null;
  let running = null; // { jobId, underlyings, startedAt, trigger }
  let seeding = null;
  let seedReport = null;
  let seedTimer = null;
  let pinnedAccount = s.account ?? null;
  let accountSelectedBy = s.account ? "config" : null;
  let lastBroker = null;
  const snapshots = new Map(); // u -> { at, data }
  let jobSeq = 0;

  const tracked = () => {
    const list = [...new Set([...s.underlyings, ...s.stocks])];
    return demo ? list.filter((u) => DEMO_VOL_UNDERLYINGS.includes(u)) : list;
  };
  const notListedInDemo = (u) => demo && !DEMO_VOL_UNDERLYINGS.includes(u);
  const isTracked = (u) => tracked().includes(u);

  function ensureLoaded() {
    if (!store || loaded) return;
    store.load();
    try {
      const st = store.readState();
      if (st && typeof st === "object" && st.days) state = { days: st.days, lastCompact: st.lastCompact ?? null, lastRun: st.lastRun ?? null };
    } catch {
      // a bad state file starts fresh
    }
    loaded = true;
  }
  function saveState() {
    if (!store) return;
    const keep = Object.keys(state.days).sort().slice(-10);
    state.days = Object.fromEntries(keep.map((d) => [d, state.days[d]]));
    try {
      store.writeState(state);
    } catch (err) {
      log?.warn?.("vol state write failed", { err: err?.message });
    }
  }
  const dayState = (date, u) => {
    state.days[date] ??= {};
    state.days[date][u] ??= {};
    return state.days[date][u];
  };

  // ── calendar and context ──

  const ctxFor = (u, t = now()) => pricingContext({ config, reference: deps.reference, exchange: defaultOptionExchange(u), kind: kindOf(u), now: t });
  function isTradingDate(date, exchange = "NFO") {
    if (usable(deps.reference)) {
      try {
        return deps.reference.calendar().isTradingDay(date, exchange);
      } catch {
        // fall through
      }
    }
    return !isWeekendDate(date);
  }
  function sessionFor(exchange, t) {
    if (usable(deps.reference)) {
      try {
        const r = deps.reference.session(exchange, t);
        const date = r?.date ?? istDate(t);
        if (r?.open && r?.close) return { date, open: r.open, close: r.close, tradingDay: r.tradingDay ?? isTradingDate(date, exchange) };
      } catch {
        // fall through
      }
    }
    const ctx = pricingContext({ config, reference: null, exchange });
    const date = istDate(t);
    return { date, open: ctx.session.open, close: ctx.session.close, tradingDay: !isWeekendDate(date) };
  }

  // ── clock (§3.3) ──

  async function listedExpiries(u, exchange) {
    if (!usable(deps.symbols) || typeof deps.symbols.search !== "function") return [];
    const set = new Set();
    let cursor;
    for (let page = 0; page < MASTER_MAX_PAGES; page += 1) {
      const q = { q: u, underlying: u, kind: "OPT", exchange, limit: MASTER_PAGE_LIMIT };
      if (cursor) q.cursor = cursor;
      let res;
      try {
        res = await deps.symbols.search(q);
      } catch {
        break;
      }
      for (const r of res?.items ?? []) if (r?.underlying === u && DATE_RE.test(String(r.expiry ?? ""))) set.add(r.expiry);
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return [...set].sort();
  }

  function holidaysAhead(exchange, from, to) {
    if (!usable(deps.reference)) return [];
    try {
      const cal = deps.reference.calendar();
      const key = exchange === "BFO" || exchange === "BSE" ? "BSE" : "NSE";
      return (cal?.holidays ?? [])
        .filter((h) => h?.date >= from && h.date <= to && (h.exchanges ?? ["NSE", "BSE"]).includes(key))
        .map((h) => ({ date: h.date, label: h.label ?? null, verified: Boolean(h.verified) }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    } catch {
      return [];
    }
  }

  async function clockFor({ underlying, expiries, at } = {}) {
    const u = String(underlying ?? "").toUpperCase();
    if (!UNDERLYING_RE.test(u)) throw new BridgeError("VALIDATION_FAILED", "underlying is required, for example NIFTY.");
    const t = at === undefined || at === null ? now() : typeof at === "number" ? at : Date.parse(String(at));
    if (!Number.isFinite(t)) throw new BridgeError("VALIDATION_FAILED", "at must be an ISO-8601 instant.");
    const exchange = defaultOptionExchange(u);
    const today = istDate(t);
    let list = expiries;
    if (!Array.isArray(list) || !list.length) {
      const last = istDate(t + MAX_EXPIRY_DAYS * DAY_MS);
      list = (await listedExpiries(u, exchange)).filter((e) => e >= today && e <= last);
    }
    list = list.filter((e) => DATE_RE.test(String(e)));
    const ctx = pricingContext({ config, reference: deps.reference, exchange, kind: kindOf(u), now: t });
    return {
      underlying: u,
      exchange,
      at: toIstIso(t),
      settings: {
        version: ctx.version,
        mode: ctx.mode,
        nonTradingDayWeight: ctx.nonTradingDayWeight,
        overnightShare: ctx.overnightShare,
        eventDays: ctx.eventDays,
        yearBasis: ctx.effectiveYearBasis,
        settlementWindowMinutes: ctx.settlementWindowMinutes,
        session: ctx.session,
        holidays: ctx.holidaysSource,
        source: "config",
      },
      rate: ctx.rate,
      holidays: holidaysAhead(exchange, today, istDate(t + HOLIDAY_DAYS * DAY_MS)),
      expiries: list.map((e) => {
        const c = volTime(ctx, t, e, { parts: true });
        return c ? { expiry: e, T: c.T, units: c.units, Tcal: c.Tcal, Ttd: c.Ttd, parts: c.parts } : { expiry: e, T: null, units: null, Tcal: null, Ttd: null, parts: [] };
      }),
    };
  }

  // ── chain reads ──

  function recorderAccount() {
    if (!usable(deps.recorder) || typeof deps.recorder.status !== "function") return null;
    try {
      return deps.recorder.status()?.account?.id ?? null;
    } catch {
      return null;
    }
  }
  function dataAccount() {
    if (pinnedAccount) return pinnedAccount;
    const r = recorderAccount();
    if (r) {
      pinnedAccount = r;
      accountSelectedBy = "recorder";
    }
    return pinnedAccount;
  }

  /** Wait for background headroom on the data account; false when it does not come before `deadline`. */
  async function headroom(deadline) {
    const acc = dataAccount();
    if (!gate || !acc) return true;
    for (let i = 0; i < 20; i++) {
      let w;
      try {
        if (gate.allow(acc, "chain", { share: s.capture.budgetShare })) return true;
        w = gate.waitMs(acc, "chain", { share: s.capture.budgetShare });
      } catch {
        return true;
      }
      if (now() + w > deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(Math.max(w, 50), 5000)));
    }
    return false;
  }

  /**
   * One chain: the recorder's snapshot when it is fresh, else a background broker read pinned to the data account.
   * Null when the background budget has no room before `deadline`.
   */
  async function readChain(u, expiry, t, { maxAgeMs = 30_000, deadline = Infinity } = {}) {
    // Demo never spends the (demo) broker budget: the chains come from the demo adapter's own prices, as the seeding.
    if (demo) {
      const chain = demoChainAt(u, expiry, t, s.capture.strikesEachSide);
      return chain ? { chain, source: "demo", broker: "demo", accountId: null } : null;
    }
    if (usable(deps.recorder) && typeof deps.recorder.latest === "function") {
      try {
        const snap = await deps.recorder.latest({ underlying: u, expiry });
        if (snap && Math.abs((num(snap.ts) ?? 0) - t) <= RECORDER_MAX_AGE_MS) {
          const chain = chainFromSnapshot(snap);
          if (chain?.rows?.length) return { chain, source: demo ? "demo" : "recorder", broker: snap.broker ?? null, accountId: snap.accountId ?? null };
        }
      } catch {
        // fall back to a broker read
      }
    }
    if (!usable(deps.marketData)) throw new BridgeError("CAPABILITY_UNSUPPORTED", "No market data service.", { reason: "NO_DATA_ACCOUNT" });
    if (!(await headroom(deadline))) return null;
    const opts = { priority: "background", backgroundShare: s.capture.budgetShare, maxAgeMs };
    const acc = dataAccount();
    if (acc) opts.accountId = acc;
    const chain = await deps.marketData.optionChain({ underlying: u, expiry, strikes: s.capture.strikesEachSide, greeks: false }, opts);
    const f = chain?.freshness ?? {};
    if (!pinnedAccount && f.accountId) {
      pinnedAccount = f.accountId;
      accountSelectedBy = "first-with-optionChain";
    }
    if (f.broker) lastBroker = f.broker;
    return { chain, source: demo ? "demo" : "broker", broker: f.broker ?? null, accountId: f.accountId ?? null };
  }

  async function listedFor(u) {
    if (demo) return demoExpiries(u, now(), 6);
    if (!usable(deps.marketData)) return [];
    const opts = { priority: "background" };
    const acc = dataAccount();
    if (acc) opts.accountId = acc;
    const r = await deps.marketData.expiries(u, opts);
    return (r?.expiries ?? []).map((e) => (typeof e === "string" ? e : e?.date)).filter((e) => DATE_RE.test(String(e)));
  }

  const sourceOf = (f) => (demo ? "demo" : f?.source === "backup" ? "yahoo" : "broker");
  async function vixQuote() {
    if (demo) return { value: demoSpot("INDIAVIX", now()), source: "demo" };
    if (!usable(deps.marketData)) return null;
    try {
      const r = await deps.marketData.quotes([s.vix.symbol], { priority: "background" });
      const q = r?.items?.[0];
      return num(q?.ltp) !== null ? { value: q.ltp, source: sourceOf(q.freshness) } : null;
    } catch {
      return null;
    }
  }
  async function spotQuote(u) {
    if (demo) return demoSpot(u, now());
    if (!usable(deps.marketData)) return null;
    try {
      const r = await deps.marketData.quotes([spotSymbolOf(u)], { priority: "background" });
      return num(r?.items?.[0]?.ltp);
    } catch {
      return null;
    }
  }
  async function dailyBars(u) {
    if (demo) return { bars: demoCandles(`DM-${u}`, "1d", now() - 110 * DAY_MS, now()).slice(-70), source: "demo" };
    if (!usable(deps.marketData)) return { bars: [], source: null };
    try {
      const r = await deps.marketData.history({ symbol: spotSymbolOf(u), interval: "1d", countback: 70 }, { priority: "background", allowBackup: true });
      return { bars: r?.candles ?? [], source: sourceOf(r?.freshness) };
    } catch {
      return { bars: [], source: null };
    }
  }

  // ── capture (§2.7) ──

  /** Capture one underlying at `t`: { underlying, status: "ok"|"partial"|"failed"|"skipped", reason?, rows }. */
  async function captureOne(u, { t, trigger, late = false, deadline = Infinity, closeMs = null, replace = false }) {
    const date = istDate(t);
    const exchange = defaultOptionExchange(u);
    const prev = store?.summaryOn(u, date);
    if (prev && !prev.missed && !replace && (trigger === "manual" || trigger === "scheduled")) return { underlying: u, status: "skipped", reason: "ALREADY_CAPTURED", rows: 0 };
    if (!demo && !usable(deps.marketData) && !usable(deps.recorder)) return { underlying: u, status: "failed", reason: "NO_DATA_ACCOUNT", rows: 0 };
    const ctx = ctxFor(u, t);
    let listed;
    try {
      listed = await listedFor(u);
    } catch (err) {
      return { underlying: u, status: "failed", reason: err?.code === "NO_ACCOUNT" || err?.code === "CAPABILITY_UNSUPPORTED" ? "NO_DATA_ACCOUNT" : "CHAIN_FAILED", rows: 0 };
    }
    const exps = chooseExpiries(listed, { today: date, target: cmTargetDate(ctx, date), maxPerUnderlying: s.expiries.maxPerUnderlying, maxCalendarDays: s.expiries.maxCalendarDays });
    const rows = [];
    const strikes = new Map();
    let partial = false;
    let lastErr = null;
    let spot = null;
    for (const e of exps) {
      if (now() > deadline) {
        partial = true;
        break;
      }
      let got;
      try {
        got = await readChain(u, e, t, { deadline });
      } catch (err) {
        lastErr = err;
        partial = true;
        continue;
      }
      if (!got) {
        partial = true;
        break;
      }
      spot = num(got.chain?.underlyingLtp) ?? spot;
      const at = now();
      const row = expiryRow(got.chain, ctx, t, e, {
        underlying: u,
        exchange,
        kind: kindOf(u),
        quality: "live",
        trigger,
        late,
        source: got.source,
        broker: got.broker,
        accountId: got.accountId,
        capturedAt: isoIst(at),
        partialWindow: closeMs !== null && at > closeMs - 30_000 && at < closeMs,
      });
      if (row) {
        rows.push(row);
        strikes.set(e, (got.chain.rows ?? []).map((r) => r.strike));
      }
    }
    if (!rows.length) {
      const reason = lastErr?.details?.reason === "NO_DATA_ACCOUNT" || lastErr?.code === "NO_ACCOUNT" ? "NO_DATA_ACCOUNT" : "CHAIN_FAILED";
      return { underlying: u, status: "failed", reason, rows: 0 };
    }
    if (rows.length < exps.length) partial = true;
    const vix = await vixQuote();
    const { bars, source: hvSource } = await dailyBars(u);
    const afterClose = closeMs === null || t >= closeMs;
    const prevRows = store ? store.summaries(u).filter((r) => r.date < date && !r.missed) : [];
    const summary = summaryRow({
      underlying: u,
      rows,
      ctx,
      now: t,
      quality: "live",
      late,
      partial,
      vix: vix ? { value: vix.value, close: afterClose ? vix.value : null, source: vix.source } : null,
      hv: bars.length ? hvOf(bars, hvSource) : null,
      spotClose: afterClose ? ((await spotQuote(u)) ?? spot) : null,
      prevFront: prevRows.at(-1)?.front?.expiry ?? null,
    });
    if (store) {
      store.putExpiryRows(u, rows);
      store.putSummaries(u, [summary]);
      if (s.predictions.enabled) {
        const preds = rows.flatMap((r) => predictionRows(r, { ts: r.capturedAt, strikes: strikes.get(r.expiry) }));
        if (preds.length) store.appendPredictions(preds);
      }
    }
    const ranks = rankCore(u, { basis: "cm30", lookbacks: [252], quality: "all", clock: mode, current: summary.cm30[mode] });
    bus?.emit?.("vol.captured", { underlying: u, date, quality: "live", partial, missed: false, cm30Iv: summary.cm30[mode], ivr252: ranks.lookbacks[0]?.ivr ?? null, trigger });
    return { underlying: u, status: partial ? "partial" : "ok", rows: rows.length };
  }

  async function runCapture(list, { trigger, late = false, deadline = Infinity, closeMs = null, replace = false, t = now() }) {
    const results = [];
    for (const u of list) {
      let r;
      try {
        r = await captureOne(u, { t, trigger, late, deadline, closeMs, replace });
      } catch (err) {
        log?.warn?.("vol capture failed", { underlying: u, err: err?.message });
        r = { underlying: u, status: "failed", reason: "CHAIN_FAILED", rows: 0 };
      }
      results.push(r);
      const ds = dayState(istDate(t), u);
      ds.status = r.status;
      if (r.reason) ds.reason = r.reason;
    }
    state.lastRun = { at: toIstIso(now()), trigger, results };
    saveState();
    return results;
  }

  async function guarded(list, opts) {
    running = { jobId: `cap_${(jobSeq += 1)}`, underlyings: list, startedAt: toIstIso(now()), trigger: opts.trigger };
    try {
      return await runCapture(list, opts);
    } finally {
      running = null;
    }
  }

  /** Missed rows for `u` on trading days after its last row and before `until` (exclusive), at most 30. */
  function writeMissedSinceLast(u, until) {
    const last = store.summaries(u).at(-1)?.date;
    if (!last) return [];
    const exchange = defaultOptionExchange(u);
    const out = [];
    for (let d = addDays(last, 1), i = 0; d < until && i < 400; d = addDays(d, 1), i++) if (isTradingDate(d, exchange)) out.push(missedRow(u, d, "BRIDGE_OFF"));
    return store.putSummaries(u, out.slice(-MAX_MISSED_BACKFILL));
  }

  /** The scheduler's minute tick (§2.4). Exposed for tests. */
  async function tick(t = now()) {
    ensureLoaded();
    if (!store) return [];
    // Demo: the scheduler starts after the seeded history exists (a capture first would leave the store unseeded).
    if (demo && (seeding || store.isEmpty())) return [];
    const ran = [];
    const cap = s.capture;
    const byExchange = new Map();
    for (const u of tracked()) {
      const ex = defaultOptionExchange(u);
      if (!byExchange.has(ex)) byExchange.set(ex, []);
      byExchange.get(ex).push(u);
    }
    for (const [exchange, us] of byExchange) {
      const sess = sessionFor(exchange, t);
      if (!sess.tradingDay) continue;
      const closeMs = istAtHm(sess.date, sess.close);
      const date = sess.date;
      if (t >= closeMs - cap.minutesBeforeClose * MINUTE && t < closeMs) {
        const due = us.filter((u) => !dayState(date, u).attempted && !store.summaryOn(u, date));
        if (due.length && !running) {
          for (const u of due) dayState(date, u).attempted = true;
          ran.push(...(await guarded(due, { trigger: "scheduled", deadline: closeMs - 30_000, closeMs, t })));
        }
      } else if (t >= closeMs + cap.retryMinutesAfterClose * MINUTE && (demo || t < closeMs + cap.lateUntilMinutesAfterClose * MINUTE)) {
        // (Demo: the demo market keeps two-sided quotes after the close, so the late path stays open all evening.)
        const retry = [];
        const lateList = [];
        for (const u of us) {
          const ds = dayState(date, u);
          const row = store.summaryOn(u, date);
          if (!row || row.missed) {
            if (ds.attempted && !ds.retried) retry.push(u);
            else if (!ds.attempted && !ds.lateTried) lateList.push(u);
          } else if (row.partial && !ds.retried) retry.push(u);
        }
        if (!running) {
          for (const u of retry) dayState(date, u).retried = true;
          for (const u of lateList) dayState(date, u).lateTried = true;
          if (retry.length) ran.push(...(await guarded(retry, { trigger: "retry", closeMs, replace: true, t })));
          if (lateList.length) ran.push(...(await guarded(lateList, { trigger: "late", late: true, closeMs, t })));
        }
        // The closing VIX and spot on rows captured before the close (once per underlying and day).
        for (const u of us) {
          const ds = dayState(date, u);
          const row = store.summaryOn(u, date);
          if (ds.closeFilled || !row || row.missed) continue;
          ds.closeFilled = true;
          if (row.spotClose !== null && row.vix?.close !== null && row.vix?.close !== undefined) continue;
          const vix = await vixQuote();
          const spot = await spotQuote(u);
          store.putSummaries(u, [{ ...row, spotClose: row.spotClose ?? spot, vix: row.vix ? { ...row.vix, close: row.vix.close ?? vix?.value ?? null } : vix ? { value: vix.value, close: vix.value, source: vix.source } : null }]);
        }
        saveState();
      } else if (t >= closeMs + cap.lateUntilMinutesAfterClose * MINUTE) {
        const out = [];
        for (const u of us) {
          const ds = dayState(date, u);
          if (ds.missedWritten || store.summaryOn(u, date)) continue;
          ds.missedWritten = true;
          const reason = !usable(deps.marketData) && !usable(deps.recorder) ? "NO_DATA_ACCOUNT" : ds.attempted || ds.lateTried ? (ds.reason === "NO_DATA_ACCOUNT" ? "NO_DATA_ACCOUNT" : "CHAIN_FAILED") : "BRIDGE_OFF";
          out.push(...store.putSummaries(u, [missedRow(u, date, reason)]));
        }
        if (out.length) {
          for (const r of out) bus?.emit?.("vol.captured", { underlying: r.underlying, date, quality: null, partial: false, missed: true, cm30Iv: null, ivr252: null, trigger: "missed" });
          saveState();
        }
        ran.push(...out.map((r) => ({ underlying: r.underlying, status: "missed", reason: r.reason })));
      }
    }
    // Compaction and retention at 02:30 IST, once a day.
    const today = istDate(t);
    if (t >= istAtHm(today, COMPACT_AT) && state.lastCompact !== today) {
      state.lastCompact = today;
      try {
        await store.compactAll({ today });
      } catch (err) {
        log?.warn?.("vol compaction failed", { err: err?.message });
      }
      saveState();
    }
    return ran;
  }

  /**
   * POST /v1/vol/capture (§3.8): capture now with trigger "manual". Without `replace`, an underlying that already has
   * today's row is skipped and listed. `wait: false` returns as soon as the run starts (the route's 202).
   */
  async function capture({ underlyings, replace = false } = {}, { wait = true } = {}) {
    ensureLoaded();
    if (!store) throw new BridgeError("CAPABILITY_UNSUPPORTED", "The vol store needs a data directory.");
    kickSeed();
    if (seeding) await seeding;
    if (running) throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", "A vol capture is already running; try again when it ends.");
    if (underlyings !== undefined && !Array.isArray(underlyings)) throw invalid("underlyings", "underlyings must be a list such as [\"NIFTY\"].");
    const list = underlyings?.length ? [...new Set(underlyings.map((u) => underlyingOf(u, "underlyings")))] : tracked();
    if (list.length > 50) throw invalid("underlyings", "At most 50 underlyings per capture.");
    const unknown = list.filter((u) => !isTracked(u));
    if (unknown.length) throw invalid("underlyings", `Not tracked: ${unknown.join(", ")}. Add them to vol.underlyings or vol.stocks.`);
    const t = now();
    if (!demo && !sessionFor(defaultOptionExchange(list[0]), t).tradingDay) throw new BridgeError("VALIDATION_FAILED", "Today is not a trading day; a capture needs live quotes.", { reason: "NOT_TRADING" });
    const jobId = `cap_${(jobSeq += 1)}`;
    const startedAt = toIstIso(t);
    running = { jobId, underlyings: list, startedAt, trigger: "manual" };
    const p = (async () => {
      try {
        return await runCapture(list, { trigger: "manual", replace: Boolean(replace), t });
      } finally {
        running = null;
      }
    })();
    if (!wait) {
      p.catch((err) => log?.warn?.("vol capture failed", { err: err?.message }));
      return { jobId, underlyings: list, startedAt };
    }
    const results = await p;
    return { jobId, underlyings: list, startedAt, results, skipped: results.filter((r) => r.status === "skipped").map((r) => r.underlying) };
  }

  // ── history and ranks ──

  const currentFresh = (u) => {
    const c = snapshots.get(u);
    return c && now() - c.at <= s.snapshotTtlSeconds * 5000 ? c.data : null;
  };

  /** Daily values of a basis before `before`, oldest first: [{ date, iv, quality }]. */
  function seriesOf(u, { basis, expiry = null, quality = "all", clock = mode, before = "9999-99-99" }) {
    const ok = (q) => q === "live" || (quality === "all" && q === "backfill-eod");
    if (basis === "cm30") {
      return store
        .summaries(u)
        .filter((r) => !r.missed && r.date < before && ok(r.quality) && num(r.cm30?.[clock]) !== null)
        .map((r) => ({ date: r.date, iv: r.cm30[clock], quality: r.quality }));
    }
    const idx = store.expiryIndex(u).filter((r) => r.date < before && ok(r.quality));
    if (basis === "expiry") return idx.filter((r) => r.expiry === expiry).map((r) => ({ date: r.date, iv: slimIv(r, clock, mode), quality: r.quality })).filter((r) => r.iv !== null);
    const byDate = new Map();
    for (const r of idx) if (r.expiry !== r.date && slimIv(r, clock, mode) !== null && (!byDate.has(r.date) || r.expiry < byDate.get(r.date).expiry)) byDate.set(r.date, r);
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => ({ date: r.date, iv: slimIv(r, clock, mode), quality: r.quality }));
  }

  /** IVR/IVP per lookback (§6.7) over the stored days before today that have a row. */
  function rankCore(u, { basis = "cm30", lookbacks = s.lookbacks, quality = "all", clock = mode, expiry = null, current }) {
    const today = istDate(now());
    const all = store ? seriesOf(u, { basis, expiry, quality, clock, before: today }) : [];
    return {
      lookbacks: lookbacks.map((days) => {
        const win = all.slice(-days);
        const r = ivRank(win, current, { minN: s.minRankDays });
        const liveN = win.filter((v) => v.quality === "live").length;
        const out = {
          days,
          n: r.n,
          liveN,
          backfillN: r.n - liveN,
          partial: r.n < days,
          min: r.min ? { iv: r.min.iv, date: r.min.date } : null,
          max: r.max ? { iv: r.max.iv, date: r.max.date } : null,
          ivr: r.ivr === null ? null : round(Math.min(100, Math.max(0, r.ivr)), 1),
          ivp: r.ivp === null ? null : round(r.ivp, 1),
        };
        // Today's value outside the stored range reads as 0 or 100, with the side named.
        if (r.ivr !== null && (r.ivr < 0 || r.ivr > 100)) out.outside = r.ivr > 100 ? "above" : "below";
        if (r.reason) out.reason = r.reason;
        return out;
      }),
    };
  }

  /** The current value of a basis: the fresh live snapshot, else the last capture. */
  function currentOf(u, { basis, expiry = null, clock }) {
    const snap = currentFresh(u);
    if (snap) {
      if (basis === "cm30") {
        const iv = snap.cm30?.byClock?.[clock];
        if (num(iv) !== null) return { iv, asOf: snap.asOf, source: "live-snapshot" };
      } else {
        const row = basis === "expiry" ? snap.rows.find((r) => r.expiry === expiry) : frontOf(snap.rows, istDate(now()));
        if (row && num(row.atmIv) !== null) return { iv: slimIv(slimOfRow(row), clock, mode), asOf: snap.asOf, source: "live-snapshot" };
      }
    }
    const last = store ? seriesOf(u, { basis, expiry, quality: "all", clock }).at(-1) : null;
    if (!last) return null;
    return { iv: last.iv, asOf: last.date, source: "last-capture" };
  }

  function vixInfo(u, { before }) {
    const closes = store ? store.vixRows().filter((r) => r.date < before).slice(-252) : [];
    const snap = currentFresh(u) ?? currentFresh("NIFTY");
    const lastSum = store ? store.summaries(u).filter((r) => !r.missed && num(r.vix?.value) !== null).at(-1) : null;
    const value = num(snap?.vix?.value) ?? num(lastSum?.vix?.value) ?? num(closes.at(-1)?.c);
    if (value === null) return null;
    const r = ivRank(closes.map((c) => ({ iv: c.c, date: c.date })), value, { minN: s.minRankDays });
    const out = { value, n: r.n, pct252: r.ivp === null ? null : round(r.ivp, 1), rank252: r.ivr === null ? null : round(Math.min(100, Math.max(0, r.ivr)), 1), source: snap?.vix?.source ?? lastSum?.vix?.source ?? closes.at(-1)?.source ?? null };
    if (r.reason) out.reason = r.reason;
    return out;
  }

  /** null when the underlying has history; else the `available: false` body. */
  function unavailable(u) {
    ensureLoaded();
    kickSeed();
    if (!store) return { available: false, reason: "NO_HISTORY" };
    if (notListedInDemo(u)) return { available: false, reason: "NOT_LISTED_IN_DEMO" };
    const has = store.summaries(u).some((r) => !r.missed);
    if (!has && !isTracked(u)) return { available: false, reason: "NOT_TRACKED" };
    if (!has) return { available: false, reason: seeding ? "COLLECTING" : "NO_HISTORY" };
    return null;
  }

  function parseLookbacks(v) {
    if (v === undefined || v === null || v === "") return [...s.lookbacks];
    const list = Array.isArray(v) ? v : String(v).split(",");
    const out = list.map((x) => Number(x));
    if (!out.length || out.length > 5 || out.some((n) => !Number.isInteger(n) || n < 5 || n > 1000)) throw invalid("lookbacks", "lookbacks must be up to 5 whole numbers from 5 to 1000.");
    return out;
  }

  /** GET /v1/vol/rank (§3.6). Memory only. */
  async function rank(p = {}) {
    const u = underlyingOf(p.underlying);
    const basis = oneOf(p.basis, BASES, "basis", "cm30");
    const quality = oneOf(p.quality, ["all", "live"], "quality", "all");
    const clockMode = oneOf(p.clock, CLOCKS, "clock", mode);
    const lookbacks = parseLookbacks(p.lookbacks);
    const expiry = dateOf(p.expiry, "expiry") ?? null;
    if (basis === "expiry" && !expiry) throw invalid("expiry", "expiry is required with basis=expiry.");
    const missing = unavailable(u);
    if (missing) return { underlying: u, basis, clock: clockMode, ...missing };
    const q = demo && p.demoPartial ? "live" : quality;
    const cur = currentOf(u, { basis, expiry, clock: clockMode });
    const core = rankCore(u, { basis, lookbacks, quality: q, clock: clockMode, expiry, current: cur?.iv ?? null });
    const today = istDate(now());
    // Same-DTE (§6.9): the named expiry, else the current front expiry.
    const snap = currentFresh(u);
    const idx = store.expiryIndex(u);
    const lastDate = idx.at(-1)?.date ?? null;
    const sdExpiry = expiry ?? frontOf(snap?.rows ?? [], today)?.expiry ?? (lastDate ? frontOf(idx.filter((r) => r.date === lastDate), lastDate)?.expiry : null) ?? null;
    let sameDte = null;
    if (sdExpiry) {
      const vt = volTime(ctxFor(u), now(), sdExpiry);
      const lb = Math.max(...lookbacks);
      const past = idx.filter((r) => r.date < today && (q === "all" || r.quality === "live"));
      const dates = [...new Set(past.map((r) => r.date))].slice(-lb);
      const from = dates[0] ?? today;
      const set = sameDteRows(
        past.filter((r) => r.date >= from).map((r) => ({ ...r, iv: slimIv(r, clockMode, mode) })).filter((r) => r.iv !== null),
        vt && vt.units > 0 ? vt.units : null,
        s.sameDteBand,
      );
      const curRow = snap?.rows.find((r) => r.expiry === sdExpiry) ?? null;
      const curIv = curRow ? slimIv(slimOfRow(curRow), clockMode, mode) : (() => {
        const r = idx.filter((x) => x.expiry === sdExpiry).at(-1);
        return r ? slimIv(r, clockMode, mode) : null;
      })();
      const r = ivRank(set, curIv, { minN: s.minRankDays });
      const U = vt && vt.units > 0 ? vt.units : null;
      sameDte = {
        expiry: sdExpiry,
        units: round(U, 2),
        iv: curIv,
        band: s.sameDteBand,
        n: r.n,
        partial: r.n < s.minRankDays,
        ivr: r.ivr === null ? null : round(Math.min(100, Math.max(0, r.ivr)), 1),
        ivp: r.ivp === null ? null : round(r.ivp, 1),
        note: U === null ? "No time left to this expiry" : `Against past days with ${round(Math.max(0, U - s.sameDteBand), 1)}–${round(U + s.sameDteBand, 1)} trading days to expiry`,
      };
      if (r.reason) sameDte.reason = r.reason;
    }
    const vix = vixInfo(u, { before: today });
    if (vix && u === "NIFTY") {
      const calIv = currentOf(u, { basis: "cm30", clock: "calendar" })?.iv ?? null;
      vix.vsNifty30 = { vix: vix.value, nifty30Cal: calIv, diff: calIv === null ? null : round(vix.value - calIv, 2), note: "Both on calendar time" };
    }
    const basisText = basis === "cm30" ? "30-day constant-maturity ATM IV" : basis === "front" ? "Front-expiry ATM IV" : `ATM IV of the ${shortDate(expiry)} expiry`;
    return {
      underlying: u,
      basis,
      clock: clockMode,
      available: true,
      ...(demo && p.demoPartial ? { demoPartial: true } : {}),
      current: cur,
      lookbacks: core.lookbacks,
      sameDte,
      vix,
      definitions: {
        ivr: "(current − lowest) ÷ (highest − lowest) × 100 over the lookback",
        ivp: "share of days in the lookback with IV below current × 100",
        partial: "fewer stored days than the lookback; n is shown",
        outside: "today's value is above the highest or below the lowest stored day: IV rank reads 100 or 0",
        collecting: `no rank under ${s.minRankDays} stored days`,
        basis: `${basisText} (Black-76, parity forward, ${clockMode} vol-time clock)`,
      },
    };
  }

  const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  function decodeCursor(c) {
    try {
      return JSON.parse(Buffer.from(String(c), "base64url").toString("utf8"));
    } catch {
      throw invalid("cursor", "cursor is not valid; use nextCursor from the previous page.");
    }
  }

  function rangeOf(p, defaultDays = 400) {
    const today = istDate(now());
    const to = dateOf(p.to, "to") ?? today;
    const from = dateOf(p.from, "from") ?? addDays(to, -defaultDays);
    if (from > to) throw invalid("from", "from must be on or before to.");
    if (daysBetween(from, to) > MAX_RANGE_DAYS) throw invalid("from", `The range may be at most ${MAX_RANGE_DAYS} days.`);
    return { from, to };
  }
  function limitOf(v) {
    const limit = v === undefined || v === null || v === "" ? 500 : Number(v);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid("limit", `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    return limit;
  }

  /** GET /v1/vol/history (§3.5). Memory and disk only. */
  async function history(p = {}) {
    const u = underlyingOf(p.underlying);
    const basis = oneOf(p.basis, BASES, "basis", "cm30");
    const expiry = dateOf(p.expiry, "expiry") ?? null;
    if (basis === "expiry" && !expiry) throw invalid("expiry", "expiry is required with basis=expiry.");
    const quality = oneOf(p.quality, ["all", "live"], "quality", "all");
    const clockMode = oneOf(p.clock, CLOCKS, "clock", mode);
    const series = p.series === undefined || p.series === null || p.series === "" ? [...DEFAULT_SERIES] : (Array.isArray(p.series) ? p.series : String(p.series).split(",")).map((x) => String(x).trim());
    if (!series.length || series.some((x) => !SERIES.includes(x))) throw invalid("series", `series must be a comma list of ${SERIES.join(", ")}.`);
    const limit = limitOf(p.limit);
    const { from, to } = rangeOf(p);
    const after = p.cursor ? decodeCursor(p.cursor)?.d : null;
    if (p.cursor && !DATE_RE.test(String(after))) throw invalid("cursor", "cursor is not valid; use nextCursor from the previous page.");
    const missing = unavailable(u);
    if (missing) return { underlying: u, basis, clock: clockMode, ...missing };
    const ok = (q) => q === "live" || (quality === "all" && q === "backfill-eod");
    const sums = store.summaries(u).filter((r) => r.date >= from && r.date <= to);
    const gaps = sums.filter((r) => r.missed).map((r) => ({ date: r.date, reason: r.reason }));
    const idx = store.expiryIndex(u).filter((r) => r.date >= from && r.date <= to);
    if (basis === "expiry") await store.flush();
    const byExpiry = basis === "expiry" ? new Map(store.readExpiryRows(u, { from, to, expiry }).map((r) => [r.date, slimOfRow(r)])) : null;
    const frontByDate = new Map();
    for (const r of idx) if (r.expiry !== r.date && num(r.atmIv) !== null && (!frontByDate.has(r.date) || r.expiry < frontByDate.get(r.date).expiry)) frontByDate.set(r.date, r);
    const all = [];
    let prevFront = null;
    for (const sum of sums) {
      if (sum.missed || !ok(sum.quality)) continue;
      const fr = frontByDate.get(sum.date) ?? null;
      const src = basis === "expiry" ? (byExpiry.get(sum.date) ?? null) : fr;
      if (basis === "expiry" && !src) continue;
      const iv = basis === "cm30" ? (sum.cm30?.[clockMode] ?? null) : src ? slimIv(src, clockMode, mode) : null;
      const ivCal = basis === "cm30" ? (sum.cm30?.calendar ?? null) : src ? slimIv(src, "calendar", mode) : null;
      const roll = basis !== "expiry" && Boolean(fr && prevFront && prevFront !== fr.expiry);
      if (fr) prevFront = fr.expiry;
      const values = {
        iv,
        ivCal,
        vix: sum.vix?.close ?? sum.vix?.value ?? null,
        hv10: sum.hv?.cc10 ?? null,
        hv20: sum.hv?.cc20 ?? null,
        hv60: sum.hv?.cc60 ?? null,
        park20: sum.hv?.park20 ?? null,
        yz20: sum.hv?.yz20 ?? null,
        ivHv20: iv !== null && num(sum.hv?.cc20) > 0 ? round(iv / sum.hv.cc20, 2) : null,
        spotClose: sum.spotClose ?? null,
        rr25: src?.rr25 ?? null,
        bf25: src?.bf25 ?? null,
        straddle: src?.straddle ?? null,
        forward: src?.forward ?? null,
      };
      const item = { date: sum.date };
      for (const k of series) item[k] = values[k];
      item.quality = sum.quality;
      item.roll = roll;
      if (fr && basis !== "expiry") item.frontExpiry = fr.expiry;
      item.flags = src?.flags ?? [];
      all.push(item);
    }
    const rest = after ? all.filter((i) => i.date > after) : all;
    const page = rest.slice(0, limit);
    let tradingDaysInRange = 0;
    for (let d = from, i = 0; d <= to && i <= MAX_RANGE_DAYS + 1; d = addDays(d, 1), i++) if (isTradingDate(d, defaultOptionExchange(u))) tradingDaysInRange += 1;
    const unitOf = (k) => (k === "ivHv20" ? "ratio" : k === "spotClose" || k === "straddle" || k === "forward" ? "index points" : "vol points");
    return {
      underlying: u,
      basis,
      ...(basis === "expiry" ? { expiry } : {}),
      clock: clockMode,
      available: true,
      series,
      units: Object.fromEntries(series.map((k) => [k, unitOf(k)])),
      items: page,
      gaps,
      coverage: {
        liveDays: sums.filter((r) => r.quality === "live").length,
        backfillDays: sums.filter((r) => r.quality === "backfill-eod").length,
        first: sums.find((r) => !r.missed)?.date ?? null,
        last: sums.filter((r) => !r.missed).at(-1)?.date ?? null,
        tradingDaysInRange,
      },
      nextCursor: rest.length > page.length && page.length ? encodeCursor({ d: page.at(-1).date }) : null,
      method: {
        iv:
          basis === "cm30"
            ? `30-day constant-maturity ATM IV: total variance interpolated on the ${clockMode} clock`
            : basis === "front"
              ? "Front-expiry ATM IV (the nearest expiry not on its own expiry day); roll marks the first day after it changed"
              : "ATM IV of this expiry",
        quality: "live: captured from quotes before the close; backfill-eod: end-of-day close prices, lower quality",
        clock: settingsOf(ctxFor(u)),
      },
    };
  }

  function settingsOf(ctx) {
    return { version: ctx.version, mode: ctx.mode, nonTradingDayWeight: ctx.nonTradingDayWeight, overnightShare: ctx.overnightShare, yearBasis: ctx.effectiveYearBasis, settlementWindowMinutes: ctx.settlementWindowMinutes };
  }

  // ── snapshot (§2.8) ──

  async function buildSnapshot(u, t) {
    const ctx = ctxFor(u, t);
    const today = istDate(t);
    const listed = await listedFor(u);
    const target = cmTargetDate(ctx, today);
    const front = listed.find((e) => e > today) ?? null;
    const pair = chooseExpiries(listed, { today, target, maxPerUnderlying: 2, maxCalendarDays: s.expiries.maxCalendarDays });
    const exps = [...new Set([front, ...pair].filter(Boolean))].sort().slice(0, 3);
    const rows = [];
    let spot = null;
    for (const e of exps) {
      const got = await readChain(u, e, t, { maxAgeMs: s.snapshotTtlSeconds * 1000 });
      if (!got) break;
      spot = num(got.chain?.underlyingLtp) ?? spot;
      const row = expiryRow(got.chain, ctx, t, e, { underlying: u, exchange: defaultOptionExchange(u), kind: kindOf(u), quality: "live-snapshot", trigger: "snapshot", source: got.source, broker: got.broker, capturedAt: isoIst(t) });
      if (row) rows.push(row);
    }
    if (!rows.length) return null;
    const cm = cm30Of(rows, ctx, t);
    const vix = await vixQuote();
    return { asOf: isoIst(t), stale: false, spot, rows, vix, cm30: { iv: cm[mode], ivCal: cm.calendar, method: cm.method, expiries: cm.expiries, targetDate: cm.targetDate, byClock: { weighted: cm.weighted, trading: cm.trading, calendar: cm.calendar } } };
  }

  /** GET /v1/vol/snapshot (§3.4): front + 30-day pair from live chains (cached), cm30, a quick 252-day rank. */
  async function snapshot(p = {}) {
    const u = underlyingOf(p.underlying);
    ensureLoaded();
    if (notListedInDemo(u)) return { underlying: u, available: false, reason: "NOT_LISTED_IN_DEMO" };
    if (!isTracked(u) && !(store && store.summaries(u).length)) return { underlying: u, available: false, reason: "NOT_TRACKED" };
    const t = now();
    const cached = snapshots.get(u);
    let data = cached && t - cached.at < s.snapshotTtlSeconds * 1000 ? cached.data : null;
    if (!data) {
      try {
        data = await buildSnapshot(u, t);
        if (data) snapshots.set(u, { at: t, data });
      } catch (err) {
        if (!cached) return { underlying: u, available: false, reason: err?.details?.reason === "NO_DATA_ACCOUNT" ? "NO_DATA_ACCOUNT" : "NO_CHAIN" };
      }
      if (!data && cached) data = { ...cached.data, stale: true };
      if (!data) return { underlying: u, available: false, reason: "NO_CHAIN" };
    }
    const q = demo && p.demoPartial ? "live" : "all";
    const r = store ? rankCore(u, { basis: "cm30", lookbacks: [252], quality: q, clock: mode, current: data.cm30?.iv ?? null }).lookbacks[0] : null;
    const vix = vixInfo(u, { before: istDate(t) });
    const { byClock, ...cm30 } = data.cm30 ?? {};
    void byClock;
    return {
      underlying: u,
      available: true,
      asOf: data.asOf,
      stale: Boolean(data.stale),
      spot: data.spot,
      rows: data.rows.map(({ accountId, ...row }) => {
        void accountId;
        return row;
      }),
      cm30,
      rank: r ? { lookback: 252, n: r.n, liveN: r.liveN, partial: r.partial, ivr: r.ivr, ivp: r.ivp, ...(r.reason ? { reason: r.reason } : {}) } : null,
      vix: vix ? { value: vix.value, pct252: vix.pct252 } : null,
      clock: { version: "vt1", mode },
    };
  }

  // ── summary, status, predictions ──

  /** GET /v1/vol/summary (§3.7): memory only, no broker calls. */
  async function summary(p = {}) {
    const raw = Array.isArray(p.underlyings) ? p.underlyings : String(p.underlyings ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!raw.length) throw invalid("underlyings", "underlyings is required, for example NIFTY,BANKNIFTY.");
    if (raw.length > MAX_UNDERLYINGS) throw invalid("underlyings", `At most ${MAX_UNDERLYINGS} underlyings.`);
    const list = raw.map((x) => underlyingOf(x, "underlyings"));
    const lookback = p.lookback === undefined || p.lookback === null || p.lookback === "" ? 252 : Number(p.lookback);
    if (!Number.isInteger(lookback) || lookback < 5 || lookback > 1000) throw invalid("lookback", "lookback must be a whole number from 5 to 1000.");
    ensureLoaded();
    const items = list.map((u) => {
      const missing = unavailable(u);
      if (missing) return { underlying: u, ...missing, n: 0 };
      const cur = currentOf(u, { basis: "cm30", clock: mode });
      const r = rankCore(u, { basis: "cm30", lookbacks: [lookback], quality: "all", clock: mode, current: cur?.iv ?? null }).lookbacks[0];
      const last = store.summaries(u).filter((x) => !x.missed).at(-1);
      const out = { underlying: u, available: true, iv: cur?.iv ?? null, asOf: cur?.asOf ?? null, source: cur?.source ?? null, n: r.n, liveN: r.liveN, partial: r.partial, ivr: r.ivr, ivp: r.ivp, hv20: last?.hv?.cc20 ?? null, ivHv20: last?.ivHv20 ?? null };
      if (r.reason) out.reason = r.reason;
      return out;
    });
    return { lookback, items };
  }

  function nextRunAt(u, t) {
    const exchange = defaultOptionExchange(u);
    for (let i = 0; i < 10; i++) {
      const d = addDays(istDate(t), i);
      if (!isTradingDate(d, exchange)) continue;
      const sess = sessionFor(exchange, istAtHm(d, "12:00"));
      const at = istAtHm(d, sess.close) - s.capture.minutesBeforeClose * MINUTE;
      if (at > t) return toIstIso(at);
    }
    return null;
  }

  /** GET /v1/vol/status (§3.8). Never returns an account id. */
  function status() {
    ensureLoaded();
    kickSeed();
    const t = now();
    const all = [...new Set([...s.underlyings, ...s.stocks])];
    const underlyings = all.map((u) => {
      if (notListedInDemo(u)) return { underlying: u, available: false, reason: "NOT_LISTED_IN_DEMO" };
      const sums = store ? store.summaries(u) : [];
      const last = sums.filter((r) => !r.missed).at(-1) ?? null;
      return {
        underlying: u,
        available: true,
        liveDays: sums.filter((r) => r.quality === "live").length,
        backfillDays: sums.filter((r) => r.quality === "backfill-eod").length,
        lastCapture: last ? { date: last.date, quality: last.quality, partial: Boolean(last.partial), late: Boolean(last.late) } : null,
        missed: sums.filter((r) => r.missed).map((r) => r.date).slice(-30),
        nextRunAt: nextRunAt(u, t),
      };
    });
    const acc = dataAccount();
    const window = s.capture.minutesBeforeClose - 0.5;
    const callsNeeded = tracked().length * s.expiries.maxPerUnderlying;
    let capacity = demo ? { chainCallsPerMin: null, windowMinutes: window, callsNeeded, fits: true, maxStocksThatFit: null, basis: "Demo: chains come from the demo prices on this computer; no broker budget is used" } : null;
    if (!capacity && gate && acc) {
      try {
        const h = deps.scheduler.headroom(acc, "chain");
        const perMin = Math.floor((h.limit ?? 0) * s.capture.budgetShare);
        capacity = { chainCallsPerMin: perMin, windowMinutes: window, callsNeeded, fits: perMin * window >= callsNeeded, maxStocksThatFit: Math.max(0, Math.floor((perMin * window - callsNeeded) / 2)), basis: `chain limit ${h.limit} a minute × budgetShare ${s.capture.budgetShare} (broker policy, unverified)` };
      } catch {
        capacity = null;
      }
    }
    capacity ??= { chainCallsPerMin: null, windowMinutes: window, callsNeeded, fits: null, maxStocksThatFit: null, basis: usable(deps.recorder) ? "chains are read from the recorder when it has a fresh snapshot" : "no data account chosen yet" };
    return {
      demo,
      clock: { version: "vt1", mode },
      account: { broker: demo ? "demo" : lastBroker, selectedBy: demo ? "demo" : accountSelectedBy },
      capacity,
      running: running ? { ...running } : null,
      seeding: seeding ? { state: "running" } : seedReport ? { state: "done", liveDays: seedReport.liveDays, backfillDays: seedReport.backfillDays } : null,
      underlyings,
      lastRun: state.lastRun ?? null,
      sources: { recorder: usable(deps.recorder), nseArchives: { enabled: false, note: "Back-fill from NSE files arrives in a later step" }, vixHistory: { provider: demo ? "demo" : null, enabled: demo } },
      backfill: null,
      store: store ? store.health() : null,
      disk: { bytes: store ? store.bytes() : 0 },
    };
  }

  /** GET /v1/vol/predictions: store S9 rows, oldest first, ≤ 2,000 a page. */
  async function predictions(p = {}) {
    ensureLoaded();
    const { from, to } = rangeOf(p, 30);
    const u = p.underlying ? underlyingOf(p.underlying) : null;
    const metric = p.metric ? String(p.metric) : null;
    if (metric && !METRIC_RE.test(metric)) throw invalid("metric", "metric must be a name such as band1.");
    const limit = limitOf(p.limit);
    if (!store) return { items: [], nextCursor: null };
    await store.flush();
    let rows = store.readPredictions({ from, to }).filter((r) => (!u || r.underlying === u) && (!metric || r.metric === metric));
    if (p.cursor) {
      const k = decodeCursor(p.cursor);
      if (typeof k?.ts !== "string" || typeof k?.id !== "string") throw invalid("cursor", "cursor is not valid; use nextCursor from the previous page.");
      rows = rows.filter((r) => r.ts > k.ts || (r.ts === k.ts && r.id > k.id));
    }
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ ts: last.ts, id: last.id }) : null };
  }

  /** Append S9 rows (P1-9's builder probabilities are the first external caller). */
  async function logPredictions(rows) {
    ensureLoaded();
    if (!Array.isArray(rows) || !rows.length) throw invalid("rows", "Give at least one prediction row.");
    if (rows.length > 500) throw invalid("rows", "At most 500 rows per call.");
    const out = rows.map((r, i) => {
      if (!r || typeof r !== "object") throw invalid(`rows.${i}`, "Each row is an object.");
      if (!METRIC_RE.test(String(r.metric ?? ""))) throw invalid(`rows.${i}.metric`, `metric must be a name such as ${PREDICTION_METRICS.slice(0, 3).join(", ")}.`);
      const u = underlyingOf(r.underlying, `rows.${i}.underlying`);
      const ts = r.ts ?? isoIst(now());
      if (!Number.isFinite(Date.parse(ts))) throw invalid(`rows.${i}.ts`, "ts must be ISO-8601.");
      const id = r.id ?? `p_${u}_${r.expiry ?? "na"}_${String(ts).slice(0, 16)}_${r.metric}_${(jobSeq += 1)}`;
      return { v: 1, id, metric: r.metric, modelVersion: r.modelVersion ?? "unversioned", underlying: u, expiry: r.expiry ?? null, ts, inputs: r.inputs ?? {}, prediction: r.prediction ?? {}, outcome: null };
    });
    if (store) await store.appendPredictions(out);
    return { ids: out.map((r) => r.id) };
  }

  // ── lifecycle ──

  async function seedIfDemo() {
    ensureLoaded();
    if (!demo || !store || !store.isEmpty() || seeding) return seeding;
    const sessCtx = pricingContext({ config, reference: deps.reference, exchange: "NFO" });
    seeding = seedDemoHistory({
      store,
      ctxFor: (exchange) => pricingContext({ config, reference: deps.reference, exchange, kind: "index", now: now() }),
      today: istDate(now()),
      isTradingDay: (d, ex) => isTradingDate(d, ex),
      exchangeOf: (u) => defaultOptionExchange(u),
      stepOf: (u) => DEMO_STEPS[u] ?? 50,
      underlyings: tracked(),
      minContracts: s.backfill.minContracts.index,
      session: { open: sessCtx.session.open, close: sessCtx.session.close },
    });
    try {
      seedReport = await seeding;
      log?.info?.("vol demo history seeded", { liveDays: seedReport.liveDays, backfillDays: seedReport.backfillDays });
    } finally {
      seeding = null;
    }
    return seedReport;
  }

  /**
   * Demo seeding runs in the background: on the first read of vol data, or 10 s after start, whichever is first. (Not
   * during start itself: a 300-day seed takes a few seconds of CPU and must not compete with the first page loads.)
   */
  function kickSeed() {
    if (!demo || !store || seeding || seedReport || !store.isEmpty()) return;
    seedIfDemo().catch((err) => log?.warn?.("vol demo seeding failed", { err: err?.message }));
  }

  async function start() {
    ensureLoaded();
    if (!store) return;
    if (demo && !seedTimer) {
      seedTimer = setTimeout(kickSeed, SEED_DELAY_MS);
      seedTimer.unref?.();
    }
    // Missed rows for trading days the Bridge was off (§2.4); then today's jobs (late capture, missed row).
    if (!demo) for (const u of tracked()) writeMissedSinceLast(u, istDate(now()));
    await tick().catch((err) => log?.warn?.("vol tick failed", { err: err?.message }));
    if (!timer) {
      timer = setInterval(() => {
        tick().catch((err) => log?.warn?.("vol tick failed", { err: err?.message }));
      }, MINUTE);
      timer.unref?.();
    }
  }
  async function stop() {
    if (seedTimer) clearTimeout(seedTimer);
    seedTimer = null;
    if (timer) clearInterval(timer);
    timer = null;
    if (seeding) await seeding.catch(() => {});
    if (store) await store.flush();
  }

  return {
    clock: clockFor,
    snapshot,
    history,
    rank,
    summary,
    status,
    capture,
    backfill: later("backfill"),
    cancelBackfill: later("cancelBackfill"),
    predictions,
    logPredictions,
    // lifecycle and test hooks (not part of the contract)
    start,
    stop,
    tick,
    seedIfDemo,
    get store() {
      return store;
    },
  };
}
