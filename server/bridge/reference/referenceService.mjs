/**
 * ReferenceData service — stream S16 (docs/spec/p1-02-reference.md §2). One dated, sourced, local reference store:
 * contract calendar, sessions, holidays, lots with effective dates, freeze quantities, ban list, MWPL, the F&O universe
 * by date, corporate actions (curated, user and inferred), delivery-margin schedule, rate and charges.
 *
 * Data sources:
 *  - instrument masters through `deps.symbols` (already loaded daily; this service never downloads masters and makes
 *    no broker call);
 *  - the shipped files in reference/data/ and the `reference` config section;
 *  - three NSE archive files (lots, ban list, combined OI), ONLY when the user turned downloads on (settings.json or
 *    config), never in demo mode. A minute-tick scheduler runs the morning and evening jobs on trading days.
 *  - demo mode: reference/demoReference.mjs instead of the store and the archives.
 *
 * Every dataset value carries source, asOf and quality. A dataset that is unavailable is not an error: it answers
 * available: false with a reason (SOURCE_OFF, NEVER_FETCHED, NOT_RECORDED, PARSE_FAILED, NO_MASTER).
 */
import { join } from "node:path";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { addDays, calendarDaysBetween, createCalendar, dayMonth, shortDay, deliveryMarginDates, expiryKinds, expiryShifts, isIsoDate, istDateOf, istInstant, mergeHolidays, monthLabel } from "./calendar.mjs";
import { effectiveSettings, parseReferenceConfig } from "./config.mjs";
import { exampleStrikeGrid, inferNonStandard, normaliseAction, previewAdjustment, roundToTick } from "./corporateActions.mjs";
import { DEFAULT_BROKERAGE } from "./defaults.mjs";
import { DEMO_SOURCE, DEMO_STOCK_LOT, demoDatasets, demoPrice } from "./demoReference.mjs";
import { demoHolidayRows, demoSpecialSessions } from "./demoTables.mjs";
import { bannerDue, lotConflict, lotForMonth, lotTimeline, lotTransitions, membersFromMktLots, mergeLotHistory, parseMktLots, universeChanges, universeOn, updateUniverse } from "./lots.mjs";
import { createNseArchiveClient } from "./nseArchives.mjs";
import { mwplBand, parseCombineOi, parseSecBan, readCombineOiZip } from "./parsers.mjs";
import { SHIPPED_CHARGES, SHIPPED_CORPORATE_ACTIONS, SHIPPED_DELIVERY_MARGIN, SHIPPED_HOLIDAYS, shippedHolidayRows, shippedSpecialSessions } from "./shipped.mjs";
import { createReferenceStore } from "./store.mjs";

export const SYNC_DATASETS = Object.freeze(["lots", "ban", "mwpl", "corporateActions"]);
export const STATUS_DATASETS = Object.freeze(["lots", "universe", "ban", "mwpl", "holidays", "rate", "corporateActions"]);
export const DAILY_REQUEST_CAP = 20;
/** "nsearchives.nseindia.com" from the configured base URL (the host the downloads go to). */
const archiveHost = (url) => {
  try {
    return new URL(String(url)).host || null;
  } catch {
    return null;
  }
};
const MASTER_PAGE = 500;
const MASTER_MAX_PAGES = 12;
const MASTER_CACHE_MS = 5 * 60_000;
const BAN_KEEP_DAYS_DEFAULT = 400;
const MWPL_KEEP_DAYS = 30;
const MAX_INFERRED = 200;
const SOURCES = Object.freeze({
  lots: "nse-archives:fo_mktlots.csv",
  ban: "nse-archives:fo_secban",
  mwpl: "nse-archives:combineoi",
});

const pct2 = (v) => (Math.round(v * 10000) / 100).toFixed(2);
const invalid = (detail, path) => new BridgeError("VALIDATION_FAILED", detail, path ? { errors: [{ path, message: detail }] } : undefined);

/** IST ISO timestamp "2026-10-29T08:20:41.120+05:30". */
function istIso(ms) {
  const d = new Date(ms + 330 * 60_000);
  return `${d.toISOString().slice(0, 23)}+05:30`;
}

/** Deterministic jitter of hash(dataDir) % 240 seconds, so many Bridges do not hit NSE at the same instant. */
export function jitterMsFor(dataDir) {
  let h = 2166136261;
  for (const ch of String(dataDir ?? "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 240) * 1000;
}

/**
 * @param {object} deps  config, logger, bus, clock, paths, symbols
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, jitterMs?: number,
 *   timers?: { setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function } }} [opts]
 */
export function createReferenceService(deps, opts = {}) {
  const config = deps.config ?? {};
  const cfg = config.reference && config.reference.sources ? config.reference : parseReferenceConfig(config.reference);
  const demo = config.demo === true;
  const log = typeof deps.logger?.child === "function" ? deps.logger.child({ module: "reference" }) : deps.logger;
  const bus = deps.bus;
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const symbols = deps.symbols && !isStub(deps.symbols) ? deps.symbols : null;
  const dataDir = deps.paths?.dataDir ?? config.dataDir ?? null;
  const store = dataDir ? createReferenceStore(join(dataDir, "reference"), { now, logger: log }) : null;
  const timers = opts.timers ?? { setInterval, clearInterval, setTimeout, clearTimeout };
  const jitterMs = opts.jitterMs ?? jitterMsFor(dataDir);

  // ── persisted state (memory copy; every change is written atomically) ──
  const read = (name, empty) => (store ? store.read(name, empty) : empty());
  const write = (name, obj) => store?.write(name, obj);
  let settings = read("settings.json", () => ({ version: 1 }));
  let state = read("state.json", () => ({ version: 1, datasets: {}, jobs: {}, requests: { day: null, count: 0 } }));
  state.datasets ??= {};
  state.jobs ??= {};
  state.requests ??= { day: null, count: 0 };
  let lotsDoc = demo ? { version: 1, rows: [] } : read("lots.json", () => ({ version: 1, rows: [] }));
  let universeDoc = demo ? null : read("universe.json", () => ({ version: 1, knownSince: null, intervals: [] }));
  let banDoc = demo ? { version: 1, days: {} } : read("ban.json", () => ({ version: 1, days: {} }));
  let mwplDoc = demo ? { version: 1, days: {} } : read("mwpl.json", () => ({ version: 1, days: {} }));
  let userActionsDoc = read("corporate-actions.json", () => ({ version: 1, items: [] }));
  if (!Array.isArray(userActionsDoc.items)) userActionsDoc = { version: 1, items: [] };
  let inferredCache = Array.isArray(state.inferred) ? state.inferred : [];
  const saveState = () => write("state.json", state);

  // ── calendar ──
  const cal = createCalendar({
    holidays: mergeHolidays(demo ? demoHolidayRows().map((h) => ({ ...h, origin: "shipped" })) : shippedHolidayRows(), cfg.holidays),
    specialSessions: {
      ...(demo ? demoSpecialSessions() : shippedSpecialSessions()),
      ...Object.fromEntries(Object.entries(cfg.specialSessions ?? {}).map(([d, s]) => [d, { ...s, verified: true, origin: "config" }])),
    },
    sessions: cfg.sessions,
  });
  const today = () => istDateOf(now());

  // ── masters (through symbols; cached a few minutes per underlying) ──
  const masterCache = new Map();
  const mastersLoadedSig = () => {
    try {
      return JSON.stringify((symbols?.status()?.brokers ?? []).map((b) => [b.broker, b.loadedAt]));
    } catch {
      return "";
    }
  };
  const masterDay = () => {
    try {
      const days = (symbols?.status()?.brokers ?? []).map((b) => b.day).filter(Boolean).sort();
      return days.length ? days[days.length - 1] : null;
    } catch {
      return null;
    }
  };

  async function searchAll(q) {
    const out = [];
    let cursor;
    for (let page = 0; page < MASTER_MAX_PAGES; page += 1) {
      const res = await symbols.search(cursor ? { ...q, cursor } : q);
      out.push(...(res?.items ?? []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Listed contracts of an underlying from the masters: { exchange, kind, expiries: [{ date, lot, lots, sample, futuresOnly }] }.
   * @returns {Promise<{ exchange: string|null, kind: "index"|"stock"|null, expiries: Array<object>, contracts: Array<object>, found: boolean }>}
   */
  async function masterContracts(underlying, exchange) {
    if (!symbols) return { exchange: exchange ?? null, kind: null, expiries: [], contracts: [], found: false };
    const key = `${underlying}|${exchange ?? ""}|${today()}|${mastersLoadedSig()}`;
    const hit = masterCache.get(key);
    if (hit && now() - hit.at < MASTER_CACHE_MS) return hit.value;
    const base = { q: underlying, underlying, limit: MASTER_PAGE, ...(exchange ? { exchange } : {}) };
    let opts = [];
    let futs = [];
    let spot = [];
    try {
      [opts, futs, spot] = await Promise.all([
        searchAll({ ...base, kind: "OPT" }),
        searchAll({ ...base, kind: "FUT" }),
        symbols.search({ q: underlying, underlying, limit: 5 }).then((r) => (r?.items ?? []).filter((x) => x.kind === "INDEX" || x.kind === "EQ")),
      ]);
    } catch (err) {
      if (err?.code !== "SYMBOL_NOT_FOUND" && err?.code !== "VALIDATION_FAILED") log?.warn?.("reference could not read the instrument masters", { underlying, code: err?.code });
    }
    opts = opts.filter((r) => r.underlying === underlying);
    futs = futs.filter((r) => r.underlying === underlying);
    const derivs = opts.length ? opts : futs;
    const exch = exchange ?? (derivs.some((r) => r.exchange === "NFO") ? "NFO" : derivs[0]?.exchange ?? null);
    const byExpiry = new Map();
    for (const r of derivs) {
      if (exch && r.exchange !== exch) continue;
      if (!r.expiry) continue;
      if (!byExpiry.has(r.expiry)) byExpiry.set(r.expiry, { date: r.expiry, lots: new Map(), sample: r.canonical });
      const e = byExpiry.get(r.expiry);
      e.lots.set(r.lotSize, (e.lots.get(r.lotSize) ?? 0) + 1);
    }
    const expiries = [...byExpiry.values()]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((e) => {
        // The lot most contracts of the expiry carry (adjusted contracts may differ).
        const lot = [...e.lots.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
        return { date: e.date, lot, sample: e.sample, futuresOnly: !opts.length };
      });
    const spotRow = spot.find((r) => r.underlying === underlying || r.canonical?.endsWith(`:${underlying}`));
    const kind = spotRow ? (spotRow.kind === "INDEX" ? "index" : "stock") : null;
    const value = { exchange: exch, kind, expiries, contracts: opts.length ? opts : [], found: derivs.length > 0 || Boolean(spotRow) };
    masterCache.set(key, { at: now(), value });
    if (masterCache.size > 200) masterCache.delete(masterCache.keys().next().value);
    return value;
  }

  // ── datasets (store-backed or demo) ──
  const demoData = () => demoDatasets(now());
  const lotRows = () => (demo ? demoData().lots : lotsDoc.rows ?? []);
  const universeData = () => (demo ? demoData().universe : universeDoc?.knownSince ? universeDoc : null);
  const archivesEnabled = () => !demo && effectiveSettings(cfg, settings).nseArchives.enabled;

  function unavailableReason(name) {
    const st = state.datasets[name];
    if (st?.error?.code === "PARSE_FAILED") return "PARSE_FAILED";
    if (!archivesEnabled()) return "SOURCE_OFF";
    return "NEVER_FETCHED";
  }

  /** Lots dataset freshness (reference file when fetched, else the masters). */
  // Demo only: PUT /v1/demo/reference { lotsStale: true } reports the lots as two trading days old everywhere (the
  // bundle, lotFor and so the order preview's LOT_SIZE_STALE), so the warning and the ticket's confirmation can be
  // tried end to end. A real Bridge never sets it.
  let demoLotsStale = false;
  function lotsMeta({ demoStale: asked = false } = {}) {
    const demoStale = asked || (demo && demoLotsStale);
    const t = today();
    let asOf;
    let source;
    let quality;
    if (demo) {
      asOf = demoStale ? cal.prevTradingDay(cal.prevTradingDay(cal.isTradingDay(t) ? t : cal.nextTradingDay(t))) : t;
      source = DEMO_SOURCE;
      quality = "demo";
    } else if ((lotsDoc.rows ?? []).length && state.datasets.lots?.asOf) {
      asOf = state.datasets.lots.asOf;
      source = SOURCES.lots;
      quality = "exchange";
    } else {
      asOf = masterDay();
      source = symbols ? "masters" : null;
      quality = "master";
    }
    const staleTradingDays = asOf ? cal.staleTradingDays(asOf, t) : null;
    return { asOf, source, quality, staleTradingDays, stale: staleTradingDays !== null && staleTradingDays > cfg.staleAfterTradingDays };
  }

  // ── rate ──
  function rate(atDate) {
    void atDate;
    // Demo mode reports the same honest default (6.50 %, not sourced) as a fresh install; the demo adapter prices
    // with that value through reference/defaults.mjs.
    const eff = effectiveSettings(cfg, settings).rate;
    let stale = true;
    if (eff.quality !== "default" && eff.asOf) stale = calendarDaysBetween(eff.asOf, today()) > cfg.rateStaleDays;
    return { value: eff.value, asOf: eff.asOf, source: eff.source, quality: eff.quality, stale, setBy: eff.setBy };
  }

  // ── sessions and calendar ──
  function session(exchange = "NFO", tMs = now()) {
    const s = cal.sessionAt(exchange, tMs);
    return { ...s, asOf: SHIPPED_HOLIDAYS.asOf, tradingDay: cal.isTradingDay(s.date, exchange), source: s.source };
  }

  function calendar() {
    return {
      isTradingDay: (d, e = "NFO") => cal.isTradingDay(d, e),
      prevTradingDay: (d, e = "NFO") => cal.prevTradingDay(d, e),
      nextTradingDay: (d, e = "NFO") => cal.nextTradingDay(d, e),
      tradingDaysBetween: (a, b, e = "NFO") => cal.tradingDaysBetween(a, b, e),
      holidays: cal.holidays.map((h) => ({ ...h })),
    };
  }

  // ── expiries and lots ──
  async function expiries(underlying, { exchange } = {}) {
    const m = await masterContracts(underlying, exchange);
    const ex = m.exchange ?? exchange ?? "NFO";
    const kinds = expiryKinds(
      m.expiries.map((e) => e.date),
      { futuresOnly: m.expiries.length > 0 && m.expiries.every((e) => e.futuresOnly) },
    );
    const shifts = expiryShifts(kinds, cal, ex);
    const master = masterDay();
    let list = shifts.map((e, i) => ({ date: e.date, kind: e.kind, lot: m.expiries[i].lot, shifted: e.shifted, ...(e.shifted ? { ruleDate: e.ruleDate, reason: e.reason } : {}), source: demo ? DEMO_SOURCE : "master" }));
    if (!list.length && demo && DEMO_STOCK_LOT[underlying]) {
      // Demo stocks have no option chains this round (P1-6): show the monthly cycle with the demo lot.
      const bn = await masterContracts("BANKNIFTY", "NFO");
      list = bn.expiries.map((e) => ({ date: e.date, kind: "monthly", lot: DEMO_STOCK_LOT[underlying], shifted: false, source: DEMO_SOURCE }));
    }
    return { underlying, exchange: ex, kind: m.kind ?? (DEMO_STOCK_LOT[underlying] ? "stock" : null), expiries: list, source: demo ? DEMO_SOURCE : "master", asOf: demo ? today() : master, found: m.found || list.length > 0 };
  }

  function timelineFor(underlying, exchange) {
    return lotTimeline(lotRows(), underlying, exchange ?? "NFO");
  }

  async function lotFor(underlying, expiry, { exchange, demoStale = false } = {}) {
    const m = await masterContracts(underlying, exchange);
    const ex = m.exchange ?? exchange ?? "NFO";
    const masterLot = m.expiries.find((e) => e.date === expiry)?.lot ?? null;
    const timeline = timelineFor(underlying, ex);
    const refLot = expiry ? lotForMonth(timeline, expiry.slice(0, 7)) : null;
    const transitions = lotTransitions(timeline, { listedExpiries: m.expiries.map((e) => e.date), cal, exchange: ex });
    const tr = expiry ? transitions.find((x) => x.toMonth === expiry.slice(0, 7)) : null;
    const meta = lotsMeta({ demoStale });
    const conflict = lotConflict(masterLot, refLot);
    const lot = masterLot ?? refLot ?? (demo ? DEMO_STOCK_LOT[underlying] ?? null : null);
    return {
      underlying,
      exchange: ex,
      expiry,
      lot,
      effectiveFrom: tr?.effectiveFrom ?? null,
      previousLot: tr?.lotBefore ?? null,
      source: refLot !== null ? (demo ? DEMO_SOURCE : SOURCES.lots) : masterLot !== null ? "master" : null,
      asOf: meta.asOf,
      quality: meta.quality,
      conflict,
      stale: meta.stale,
      staleTradingDays: meta.staleTradingDays,
      staleAfterTradingDays: cfg.staleAfterTradingDays,
      blockWhenStale: cfg.blockLotsWhenStale,
    };
  }

  async function freezeFor(canonical) {
    let resolved = null;
    if (symbols) {
      try {
        resolved = await symbols.resolve(canonical);
      } catch {
        resolved = null;
      }
    }
    if (resolved?.freezeQtySource === "master" && resolved.freezeQty) return { freezeQty: resolved.freezeQty, source: "master", verified: true };
    const key = resolved ? `${resolved.exchange}:${resolved.underlying}` : null;
    if (key && cfg.freeze[key]) return { freezeQty: cfg.freeze[key], source: "config", verified: true };
    if (resolved?.freezeQty) return { freezeQty: resolved.freezeQty, source: resolved.freezeQtySource ?? "exchange-list", verified: false };
    return { freezeQty: null, source: null, verified: false };
  }

  async function lotsView(underlying, { exchange, from } = {}) {
    const m = await masterContracts(underlying, exchange);
    const ex = m.exchange ?? exchange ?? "NFO";
    const timeline = timelineFor(underlying, ex);
    const transitions = lotTransitions(timeline, { listedExpiries: m.expiries.map((e) => e.date), cal, exchange: ex });
    const meta = lotsMeta();
    const history = timeline
      .filter((r) => !from || r.expiryMonth >= from.slice(0, 7))
      .map((r) => {
        const tr = transitions.find((x) => x.toMonth === r.expiryMonth);
        return { expiryMonth: r.expiryMonth, lot: r.lot, effectiveFrom: tr?.effectiveFrom ?? null, lastOldExpiry: tr?.lastOldExpiry ?? null, source: r.source };
      });
    const nearest = m.expiries[0] ?? null;
    const current = nearest?.lot ?? lotForMonth(timeline, today().slice(0, 7)) ?? (demo ? DEMO_STOCK_LOT[underlying] ?? null : null);
    const upcoming = transitions.find((x) => x.effectiveFrom && x.effectiveFrom >= today());
    const freeze = nearest ? await freezeFor(nearest.sample) : { freezeQty: null, source: null, verified: false };
    return {
      underlying,
      exchange: ex,
      history,
      current,
      next: upcoming ? { lot: upcoming.lotAfter, from: upcoming.effectiveFrom } : { lot: current, from: null },
      freeze,
      source: meta.source,
      asOf: meta.asOf,
      stale: meta.stale,
      staleTradingDays: meta.staleTradingDays,
      conflict: nearest ? lotConflict(nearest.lot, lotForMonth(timeline, nearest.date.slice(0, 7))) : null,
      found: m.found || timeline.length > 0,
    };
  }

  // ── ban list and MWPL ──
  function banDay(forDate) {
    if (demo) {
      const d = demoData();
      return d.ban.forDate === forDate ? { symbols: d.ban.symbols, asOf: d.today, source: DEMO_SOURCE } : null;
    }
    return banDoc.days?.[forDate] ?? null;
  }

  function mwplDay(date) {
    if (demo) {
      const d = demoData();
      return { forDate: d.mwpl.forDate, rows: d.mwpl.rows, asOf: d.today, source: DEMO_SOURCE };
    }
    const dates = Object.keys(mwplDoc.days ?? {})
      .filter((d) => d <= date)
      .sort();
    const last = dates[dates.length - 1];
    return last ? { forDate: last, ...mwplDoc.days[last] } : null;
  }

  const defaultBanDate = () => {
    const t = today();
    if (demo) return demoData().ban.forDate;
    return cal.isTradingDay(t) ? t : cal.nextTradingDay(t);
  };

  function banList(date) {
    const forDate = date ?? defaultBanDate();
    const day = banDay(forDate);
    if (!day) return { forDate, items: [], available: false, reason: demo ? "NOT_RECORDED" : unavailableReason("ban"), asOf: null, source: demo ? DEMO_SOURCE : SOURCES.ban };
    const mw = mwplDay(forDate);
    const pctOf = new Map((mw?.rows ?? []).map((r) => [r.symbol, r.mwplPct ?? mwplBand(r, true).mwplPct]));
    return { forDate, items: day.symbols.map((s) => ({ symbol: s, mwplPct: pctOf.get(s) ?? null })), available: true, asOf: day.asOf, source: day.source };
  }

  function mwplList({ date, symbol } = {}) {
    const forDate = date ?? defaultBanDate();
    const mw = mwplDay(forDate);
    if (!mw) return { forDate, items: [], available: false, reason: demo ? "NOT_RECORDED" : unavailableReason("mwpl"), asOf: null, source: demo ? DEMO_SOURCE : SOURCES.mwpl };
    const ban = new Set(banDay(forDate)?.symbols ?? []);
    let items = mw.rows.map((r) => ({ symbol: r.symbol, mwpl: r.mwpl, oi: r.oi, limitNextDay: r.limitNextDay ?? null, ...mwplBand(r, ban.has(r.symbol)) }));
    if (symbol) items = items.filter((r) => r.symbol === symbol);
    return { forDate: mw.forDate, items, available: true, asOf: mw.asOf, source: mw.source };
  }

  /** Demo only (p1-06 §4.2, POST /v1/demo/fno): stocks forced into the ban on top of the demo list, until a time. */
  let demoBan = null;
  function demoBanActive() {
    if (!demo || !demoBan) return null;
    if (now() >= demoBan.until) {
      demoBan = null;
      return null;
    }
    return demoBan;
  }

  function banStatus(symbol, date) {
    const forDate = date ?? defaultBanDate();
    const forced = date === undefined || date === defaultBanDate() ? demoBanActive() : null;
    if (forced?.symbols.has(symbol)) {
      // A forced ban has no MWPL figure of its own (the demo's daily MWPL row would contradict it).
      return { inBan: true, mwplPct: null, mwpl: null, oi: null, band: "ban", forDate, asOf: today(), source: "demo-override", available: true };
    }
    const day = banDay(forDate);
    const mw = mwplDay(forDate);
    const row = mw?.rows.find((r) => r.symbol === symbol) ?? null;
    if (!day && !row) return { inBan: null, mwplPct: null, mwpl: null, oi: null, band: null, forDate, asOf: null, source: null, available: false, reason: demo ? "NOT_RECORDED" : unavailableReason("ban") };
    const inBan = day ? day.symbols.includes(symbol) : null;
    const b = row ? mwplBand(row, inBan === true) : { mwplPct: null, band: inBan ? "ban" : null };
    return { inBan, mwplPct: b.mwplPct, mwpl: row?.mwpl ?? null, oi: row?.oi ?? null, band: b.band, forDate, asOf: mw?.asOf ?? day?.asOf ?? null, source: demo ? DEMO_SOURCE : `${day ? SOURCES.ban : ""}${day && row ? " + " : ""}${row ? SOURCES.mwpl : ""}`, available: true };
  }

  // ── universe ──
  function universe({ date, kind = "all" } = {}) {
    const d = date ?? today();
    const u = universeData();
    const on = universeOn(u, d, kind);
    const changes = universeChanges(u, addDays(today(), -90), today(), (x) => cal.nextTradingDay(x));
    return { ...on, count: on.items.length, changes, source: demo ? DEMO_SOURCE : SOURCES.lots, ...(u ? {} : { available: false, reason: unavailableReason("universe") }) };
  }

  // ── corporate actions ──
  function allActions() {
    const shipped = demo ? demoData().actions : SHIPPED_CORPORATE_ACTIONS.items.map((a) => normaliseAction(a, { origin: "shipped", verified: a.verified === true }));
    const user = userActionsDoc.items;
    const inferred = demo ? demoData().inferred : inferredCache;
    return [...shipped, ...user, ...inferred];
  }

  /**
   * Example strikes and lots around an action. An upcoming action (or a past one with its cum price) shows strikes
   * near the pre-action price and their adjusted values. A past action priced from today's spot (demo mode) shows the
   * strikes listed now as "after" and the pre-action strikes they came from (K x factor) as "before", so the example
   * matches the strikes actually trading.
   */
  function withAdjusted(a) {
    if (!a.factor) return a;
    const past = Boolean(a.exDate) && a.exDate < today();
    const timeline = demo ? [] : timelineFor(a.symbol, "NFO");
    const currentLot = demo ? DEMO_STOCK_LOT[a.symbol] ?? null : lotForMonth(timeline, today().slice(0, 7));
    const monthBeforeEx = past ? addDays(`${a.exDate.slice(0, 7)}-01`, -1).slice(0, 7) : null;
    // Lots: the lot before the ex-date and the adjusted lot of contracts open across it (lot x factor). Demo lots are
    // the pre-action lots (the inferred demo contract carries lot x 5).
    const lotBeforeEx = past && !demo ? lotForMonth(timeline, monthBeforeEx) : currentLot;
    const fromSpot = demo || !a.cumPrice;
    const ref = demo ? demoPrice(a.symbol, now()) : a.cumPrice;
    // A user entry stores the strikes its preview showed, so the saved card shows the same example.
    const stored = Array.isArray(a.exampleStrikes) && a.exampleStrikes.length ? a.exampleStrikes : null;
    let strikes = stored ?? [];
    if (!stored && ref) strikes = exampleStrikeGrid(ref);
    const tick = a.strikeTick ?? 0.05;
    try {
      if (past && fromSpot && !stored) {
        // Today's spot is post-action: the listed strikes are the "after" side.
        const lotAfter = lotBeforeEx === null ? null : Math.round(lotBeforeEx * a.factor);
        return { ...a, adjusted: { exampleStrikes: strikes.map((k) => ({ before: roundToTick(k * a.factor, tick), after: k })), lotBefore: lotBeforeEx, lotAfter } };
      }
      const p = previewAdjustment({ type: a.type, ratio: a.ratio ?? undefined, fv: a.fv ?? undefined, subscriptionPrice: a.subscriptionPrice ?? undefined, cumPrice: a.cumPrice ?? undefined, lot: lotBeforeEx ?? undefined, strikes, strikeTick: tick }, { extraordinaryDividendPct: cfg.extraordinaryDividendPct });
      return { ...a, adjusted: { exampleStrikes: p.strikes, lotBefore: lotBeforeEx, lotAfter: p.lotAfter } };
    } catch {
      return a;
    }
  }

  function corporateActions({ symbol, from, to, origin } = {}) {
    return allActions()
      .filter((a) => (!symbol || a.symbol === symbol) && (!origin || a.origin === origin) && (!from || !a.exDate || a.exDate >= from) && (!to || !a.exDate || a.exDate <= to))
      .map(withAdjusted)
      .sort((x, y) => String(y.exDate ?? "9999").localeCompare(String(x.exDate ?? "9999")) || x.symbol.localeCompare(y.symbol));
  }

  function addAction(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send a corporate action object.");
    const allowed = new Set(["symbol", "exchange", "type", "ratio", "exDate", "subscriptionPrice", "cumPrice", "dividend", "fv", "strikeTick", "source", "lotRule", "exampleStrikes"]);
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length) throw invalid(`Unknown field(s): ${extra.join(", ")}. id, factor, origin and verified are set by the Bridge.`, extra[0]);
    if (!isIsoDate(body.exDate)) throw invalid("exDate must be a real date, YYYY-MM-DD.", "exDate");
    const row = normaliseAction(body, { origin: "user", verified: true });
    const dup = allActions().find((a) => a.symbol === row.symbol && a.type === row.type && a.exDate === row.exDate);
    if (dup) throw invalid(`An action for ${row.symbol} (${row.type}, ex-date ${row.exDate}) already exists.`, "exDate");
    row.id = `ca_${row.symbol}_${row.exDate}_${row.type}_u`;
    row.addedAt = istIso(now());
    userActionsDoc = { version: 1, items: [...userActionsDoc.items, row] };
    write("corporate-actions.json", userActionsDoc);
    bus?.emit("reference.updated", { dataset: "corporateActions", asOf: today(), source: "user", changed: true });
    return row;
  }

  function deleteAction(id) {
    const row = userActionsDoc.items.find((a) => a.id === id);
    if (!row) throw new BridgeError("NOT_FOUND", `No corporate action ${String(id).slice(0, 80)} that was entered on this Bridge. Shipped and inferred rows cannot be deleted.`);
    userActionsDoc = { version: 1, items: userActionsDoc.items.filter((a) => a.id !== id) };
    write("corporate-actions.json", userActionsDoc);
    bus?.emit("reference.updated", { dataset: "corporateActions", asOf: today(), source: "user", changed: true });
    return row;
  }

  // ── events within N days ──
  async function events({ days, underlying } = {}) {
    const n = days ?? cfg.bannerDays;
    const t = today();
    const out = [];
    // Lot revisions
    const unders = underlying ? [underlying] : [...new Set(lotRows().map((r) => r.underlying))];
    for (const u of unders) {
      const timeline = timelineFor(u, lotRows().find((r) => r.underlying === u)?.exchange ?? "NFO");
      if (timeline.length < 2 || timeline.every((r) => r.lot === timeline[0].lot)) continue;
      const m = await masterContracts(u);
      for (const tr of lotTransitions(timeline, { listedExpiries: m.expiries.map((e) => e.date), cal, exchange: m.exchange ?? "NFO" })) {
        if (!bannerDue(t, tr.effectiveFrom, n)) continue;
        const away = calendarDaysBetween(t, tr.effectiveFrom);
        out.push({
          kind: "lot-revision",
          underlying: u,
          effectiveOn: tr.effectiveFrom,
          daysAway: away,
          text: `${u} lot size changes from ${tr.lotBefore} to ${tr.lotAfter} for contracts from the ${monthLabel(tr.toMonth)} series (first trading day ${dayMonth(tr.effectiveFrom)}, ${away === 0 ? "today" : `in ${away} day${away === 1 ? "" : "s"}`}). Source: ${demo ? "demo data" : "NSE market lots"}, ${dayMonth(lotsMeta().asOf ?? t)}.`,
          ref: { lotBefore: tr.lotBefore, lotAfter: tr.lotAfter, fromMonth: tr.fromMonth, toMonth: tr.toMonth, lastOldExpiry: tr.lastOldExpiry },
        });
      }
    }
    // Corporate actions
    for (const a of allActions()) {
      if (!a.exDate || (underlying && a.symbol !== underlying)) continue;
      const away = calendarDaysBetween(t, a.exDate);
      if (away < 0 || away > n) continue;
      const tdays = cal.tradingDaysBetween(t, a.exDate);
      const what = a.type === "bonus" && a.ratio ? `${a.ratio.new}:${a.ratio.held} bonus` : a.type === "split" && a.fv ? `split (face value ${a.fv.from} to ${a.fv.to})` : a.type;
      const effect = a.type === "bonus" && a.ratio?.new === a.ratio?.held ? " Strikes halve and lots double on that day." : a.factor ? ` Strikes and lots are adjusted by a factor of ${a.factor} on that day.` : "";
      out.push({ kind: "corporate-action", underlying: a.symbol, effectiveOn: a.exDate, daysAway: away, text: `${a.symbol} ${what}, ex-date ${dayMonth(a.exDate)} (${tdays === 0 ? "today" : `in ${tdays} trading day${tdays === 1 ? "" : "s"}`}).${effect}`, ref: { id: a.id, type: a.type, factor: a.factor ?? null, verified: a.verified } });
    }
    // Holiday expiry shifts
    // Site-wide (no underlying): the index underlyings, whose weekly and monthly expiries move for holidays. Stock
    // expiries are monthly and move the same way as the index monthly, so the index rows cover the calendar.
    const indexUnders = [...new Set(["NIFTY", "BANKNIFTY", "SENSEX", ...lotRows().filter((r) => r.kind === "index").map((r) => r.underlying), ...(universeData()?.intervals ?? []).filter((i) => i.kind === "index" && i.to === null).map((i) => i.symbol)])].slice(0, 12);
    const shiftUnders = underlying ? [underlying] : indexUnders;
    for (const u of shiftUnders) {
      const ex = await expiries(u);
      for (const e of ex.expiries) {
        if (!e.shifted) continue;
        const away = calendarDaysBetween(t, e.date);
        if (away < 0 || away > n) continue;
        // User-facing words: dates as "10 Nov" (never ISO) and the real size of the move (a weekend can sit between).
        const early = calendarDaysBetween(e.date, e.ruleDate);
        const hol = cal.holidayOn(e.ruleDate, ex.exchange ?? "NFO");
        const by = early === 1 ? "a day earlier than usual" : `${early} days earlier than usual`;
        out.push({ kind: "holiday-expiry-shift", underlying: u, effectiveOn: e.date, daysAway: away, text: `${u} ${e.kind} expiry is on ${shortDay(e.date)}, ${by} (moved from ${shortDay(e.ruleDate)}, ${hol && !hol.verified ? "an unverified holiday" : "a holiday"}).`, ref: { ruleDate: e.ruleDate, expiry: e.date } });
      }
    }
    return out.sort((a, b) => a.daysAway - b.daysAway || a.underlying.localeCompare(b.underlying));
  }

  // ── charges, delivery margin ──
  function charges() {
    const { version, notes, ...rest } = SHIPPED_CHARGES;
    void version;
    const brokerage = demo || cfg.brokerage.perOrder !== DEFAULT_BROKERAGE.perOrder ? { kind: cfg.brokerage.kind, perOrder: cfg.brokerage.perOrder, source: cfg.brokerage.perOrder === DEFAULT_BROKERAGE.perOrder ? DEFAULT_BROKERAGE.source : "config: reference.brokerage" } : { kind: DEFAULT_BROKERAGE.kind, perOrder: DEFAULT_BROKERAGE.perOrder, source: DEFAULT_BROKERAGE.source };
    return structuredClone({ ...rest, notes, brokerage });
  }

  function deliveryMargin(expiry, exchange = "NFO") {
    return { expiry, items: deliveryMarginDates(expiry, SHIPPED_DELIVERY_MARGIN.schedule, cal, exchange), verified: demo ? true : SHIPPED_DELIVERY_MARGIN.verified, source: demo ? DEMO_SOURCE : SHIPPED_DELIVERY_MARGIN.source, asOf: SHIPPED_DELIVERY_MARGIN.asOf, appliesTo: SHIPPED_DELIVERY_MARGIN.appliesTo };
  }

  // ── status ──
  function nextRunAt(dataset) {
    const t = now();
    const jobs = dataset === "lots" || dataset === "universe" ? ["morning", "evening"] : dataset === "ban" ? ["evening", "morning"] : dataset === "mwpl" ? ["evening"] : dataset === "corporateActions" ? ["morning"] : [];
    let best = null;
    for (let i = 0; i < 10 && best === null; i += 1) {
      const d = addDays(today(), i);
      if (!cal.isTradingDay(d)) continue;
      for (const j of jobs) {
        const at = istInstant(d, cfg.schedule[j]) + jitterMs;
        if (at > t && (best === null || at < best)) best = at;
      }
    }
    return best === null ? null : istIso(best);
  }

  function status() {
    const sources = effectiveSettings(cfg, settings);
    const datasets = {};
    if (demo) {
      const d = demoData();
      const tomorrow = istIso(istInstant(cal.nextTradingDay(d.today), cfg.schedule.morning));
      for (const name of STATUS_DATASETS) datasets[name] = { available: true, asOf: d.today, source: DEMO_SOURCE, lastSuccessAt: d.asOfIso, lastAttemptAt: d.asOfIso, nextRunAt: tomorrow, stale: false, error: null };
      const r = rate();
      // The demo stale switch (PUT /v1/demo/reference) ages the lots here too, so the status strip agrees with the
      // bundle, the chip and the Expiries panel.
      const lm = lotsMeta();
      datasets.lots = { ...datasets.lots, asOf: lm.asOf, stale: lm.stale, staleTradingDays: lm.staleTradingDays };
      datasets.rate = { available: true, asOf: r.asOf, source: r.source, quality: r.quality, lastSuccessAt: null, lastAttemptAt: null, nextRunAt: null, stale: r.stale, error: null };
      return { demo: true, demoLotsStale: demoLotsStale, sources: { nseArchives: { enabled: false, setBy: "demo", setAt: null } }, datasets, knownSince: d.knownSince, requestsToday: 0, syncing: null };
    }
    for (const name of ["lots", "universe", "ban", "mwpl"]) {
      const st = state.datasets[name] ?? {};
      const has = name === "lots" ? (lotsDoc.rows ?? []).length > 0 : name === "universe" ? Boolean(universeDoc?.knownSince) : name === "ban" ? Object.keys(banDoc.days ?? {}).length > 0 : Object.keys(mwplDoc.days ?? {}).length > 0;
      const asOf = st.asOf ?? null;
      const staleDays = asOf ? cal.staleTradingDays(asOf, today()) : null;
      datasets[name] = {
        available: has,
        ...(has ? {} : { reason: unavailableReason(name) }),
        asOf,
        source: has ? SOURCES[name] ?? SOURCES.lots : name === "lots" && symbols ? "masters" : null,
        lastSuccessAt: st.lastSuccessAt ?? null,
        lastAttemptAt: st.lastAttemptAt ?? null,
        nextRunAt: sources.nseArchives.enabled ? nextRunAt(name) : null,
        stale: has ? staleDays !== null && staleDays > cfg.staleAfterTradingDays : false,
        staleTradingDays: staleDays,
        error: st.error ?? null,
        ...(st.rows !== undefined ? { rows: st.rows } : {}),
      };
    }
    datasets.holidays = { available: true, asOf: SHIPPED_HOLIDAYS.asOf, source: SHIPPED_HOLIDAYS.source, lastSuccessAt: null, lastAttemptAt: null, nextRunAt: null, stale: false, error: null, verified: cal.holidays.every((h) => h.verified) };
    const r = rate();
    datasets.rate = { available: true, asOf: r.asOf, source: r.source, quality: r.quality, lastSuccessAt: null, lastAttemptAt: null, nextRunAt: null, stale: r.stale, error: null };
    const ca = state.datasets.corporateActions ?? {};
    datasets.corporateActions = { available: true, asOf: ca.asOf ?? SHIPPED_CORPORATE_ACTIONS.asOf, source: "curated + user + inferred from masters", lastSuccessAt: ca.lastSuccessAt ?? null, lastAttemptAt: ca.lastAttemptAt ?? null, nextRunAt: nextRunAt("corporateActions"), stale: false, error: ca.error ?? null };
    return {
      demo: false,
      // host, schedule and the daily cap let the dashboard's "Turn on" sheet say what is fetched and how often (§7.2).
      sources: { nseArchives: { enabled: sources.nseArchives.enabled, setBy: sources.nseArchives.setBy, setAt: sources.nseArchives.setAt, host: archiveHost(cfg.sources.nseArchives.baseUrl), schedule: { morning: cfg.schedule.morning, evening: cfg.schedule.evening }, dailyRequestCap: DAILY_REQUEST_CAP } },
      datasets,
      knownSince: universeDoc?.knownSince ?? null,
      requestsToday: state.requests.day === today() ? state.requests.count : 0,
      syncing: running ? { jobId: running.jobId, datasets: running.datasets, startedAt: running.startedAt } : null,
    };
  }

  // ── bundle (one call per page) ──
  function banForBundle(symbol) {
    const b = banStatus(symbol);
    if (b.available === false) return null;
    // Age of the ban / MWPL data (spec §5.3: the stale warning also covers a ban list older than allowed).
    const staleTradingDays = b.asOf ? cal.staleTradingDays(b.asOf, today()) : null;
    return { inBan: b.inBan, mwplPct: b.mwplPct, band: b.band, forDate: b.forDate, asOf: b.asOf, source: b.source, stale: staleTradingDays !== null && staleTradingDays > cfg.staleAfterTradingDays, staleTradingDays };
  }

  async function bundle({ underlying, exchange, now: atMs, demoStale = false } = {}) {
    const t = atMs ?? now();
    const ex = await expiries(underlying, { exchange });
    const known = ex.found || (universeData()?.intervals ?? []).some((i) => i.symbol === underlying) || timelineFor(underlying, ex.exchange).length > 0;
    if (!known) throw new BridgeError("SYMBOL_NOT_FOUND", `${underlying} is not in any loaded instrument master or in the F&O universe.`);
    const exch = ex.exchange;
    const lots = await lotsView(underlying, { exchange: exch });
    const meta = lotsMeta({ demoStale: demo && demoStale });
    const s = session(exch, t);
    const r = rate();
    const evts = await events({ days: cfg.bannerDays, underlying });
    const kind = ex.kind ?? (universeData()?.intervals ?? []).find((i) => i.symbol === underlying)?.kind ?? null;
    const isStock = kind === "stock";
    const nearestMonthly = ex.expiries.find((e) => e.kind === "monthly")?.date ?? ex.expiries[0]?.date ?? null;
    const warnings = [];
    if (r.quality === "default") warnings.push(`Rate is the ${pct2(r.value)} % default, not sourced.`);
    else if (r.stale) warnings.push(`Rate ${pct2(r.value)} % is from ${r.asOf ?? "an unknown date"}, older than ${cfg.rateStaleDays} days.`);
    if (meta.stale) warnings.push(`Contract data is ${meta.staleTradingDays} trading days old (lot sizes from ${dayMonth(meta.asOf)}). Check the lot size before ordering in lots.`);
    if (lots.conflict) warnings.push(`The broker's master lists ${lots.conflict.master} units per lot; the reference file says ${lots.conflict.reference}. Orders use the master's lot.`);
    if (lots.freeze.freezeQty === null) warnings.push("Freeze qty unknown: slicing is not checked.");
    const holidaysAhead = cal.holidaysIn(today(), addDays(today(), 60), exch).map((h) => ({ date: h.date, label: h.label, exchanges: h.exchanges, verified: h.verified }));
    return {
      underlying,
      exchange: exch,
      kind,
      now: istIso(t),
      session: { state: s.state, label: s.label, date: s.date, preOpen: s.preOpen, open: s.open, close: s.close, holiday: s.holiday, special: s.special, source: s.source, asOf: s.asOf },
      nextTradingDay: cal.nextTradingDay(s.date, exch),
      prevTradingDay: cal.prevTradingDay(s.date, exch),
      holidays: holidaysAhead,
      rate: { value: r.value, asOf: r.asOf, source: r.source, quality: r.quality, stale: r.stale },
      expiries: ex.expiries.map(({ source, ...e }) => (void source, e)),
      lots: { current: lots.current, next: lots.next, source: meta.source, asOf: meta.asOf, quality: meta.quality, stale: meta.stale, staleTradingDays: meta.staleTradingDays, conflict: lots.conflict },
      freeze: lots.freeze,
      ban: isStock ? banForBundle(underlying) : null,
      events: evts,
      deliveryMargin: isStock && nearestMonthly ? deliveryMargin(nearestMonthly, exch) : null,
      charges: charges(),
      warnings,
    };
  }

  // ── writes: rate, sources ──
  function setRate(body, by) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send { value, asOf, source }.");
    const extra = Object.keys(body).filter((k) => !["value", "asOf", "source"].includes(k));
    if (extra.length) throw invalid(`Unknown field(s): ${extra.join(", ")}.`, extra[0]);
    if (typeof body.value !== "number" || !Number.isFinite(body.value) || body.value < 0 || body.value > 0.25) throw invalid("value must be a decimal from 0 to 0.25 (0.0571 is 5.71 %).", "value");
    if (body.asOf !== undefined && body.asOf !== null && !isIsoDate(body.asOf)) throw invalid("asOf must be a real date, YYYY-MM-DD.", "asOf");
    if (body.asOf && body.asOf > today()) throw invalid("asOf cannot be in the future.", "asOf");
    if (typeof body.source !== "string" || body.source.trim().length < 3 || body.source.trim().length > 120) throw invalid("source must be 3 to 120 characters, for example \"91-day T-bill cut-off, RBI auction\".", "source");
    settings = { ...settings, version: 1, rate: { value: body.value, asOf: body.asOf ?? today(), source: body.source.trim(), at: istIso(now()), by: String(by ?? "unknown").slice(0, 80) } };
    write("settings.json", settings);
    bus?.emit("reference.updated", { dataset: "rate", asOf: settings.rate.asOf, source: settings.rate.source, changed: true });
    return rate();
  }

  function setSources(body, by) {
    if (demo) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Demo mode never downloads reference files.");
    if (!body || typeof body !== "object" || typeof body.nseArchives !== "boolean" || Object.keys(body).some((k) => k !== "nseArchives")) throw invalid('Send { "nseArchives": true } or { "nseArchives": false }.', "nseArchives");
    settings = { ...settings, version: 1, nseArchives: { enabled: body.nseArchives, at: istIso(now()), by: String(by ?? "unknown").slice(0, 80) } };
    write("settings.json", settings);
    if (body.nseArchives) queueMicrotask(() => startupSync().catch(() => {}));
    return status().sources;
  }

  // ── sync (NSE archives; never in demo) ──
  let client = null;
  let running = null;
  let jobSeq = 0;
  const clientFor = () => {
    const a = cfg.sources.nseArchives;
    client ??= createNseArchiveClient({ baseUrl: a.baseUrl, gapMs: a.gapMs, timeoutMs: a.timeoutMs, maxBytes: a.maxBytes, fetchImpl: opts.fetchImpl, now, sleep: opts.sleep });
    return client;
  };

  function record(name, patch) {
    const prev = state.datasets[name] ?? {};
    state.datasets[name] = { ...prev, ...patch };
  }

  function takeRequest() {
    const t = today();
    if (state.requests.day !== t) state.requests = { day: t, count: 0 };
    if (state.requests.count >= DAILY_REQUEST_CAP) return false;
    state.requests.count += 1;
    return true;
  }

  async function download(name, kind, date) {
    if (!takeRequest()) {
      throw new BridgeError("UPSTREAM_RATE_LIMITED", `The daily cap of ${DAILY_REQUEST_CAP} NSE archive requests is used up; the dataset waits for tomorrow.`);
    }
    const file = await clientFor().fetchFile(kind, date);
    store?.writeRaw(today(), file.name, file.buf);
    return file;
  }

  /** One dataset: fetch, keep the raw copy, parse, merge, write, state, event. */
  async function syncOne(name, { forDate } = {}) {
    const attemptAt = istIso(now());
    if (name === "corporateActions") return inferFromMasters();
    if (!archivesEnabled()) {
      record(name, { lastAttemptAt: attemptAt, error: { code: "SOURCE_OFF", detail: "NSE archive downloads are off." } });
      if (name === "lots") record("universe", { lastAttemptAt: attemptAt, error: { code: "SOURCE_OFF", detail: "NSE archive downloads are off." } });
      return { dataset: name, ok: false, code: "SOURCE_OFF" };
    }
    const kind = name === "lots" ? "mktlots" : name === "ban" ? "secban" : "combineoi";
    const date = forDate ?? (name === "ban" ? defaultBanDate() : cal.isTradingDay(today()) ? today() : cal.prevTradingDay(today()));
    record(name, { lastAttemptAt: attemptAt });
    let file;
    try {
      file = await download(name, kind, date);
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : "UPSTREAM_ERROR";
      const failures = (state.datasets[name]?.failures ?? 0) + 1;
      record(name, { error: { code, detail: err?.detail ?? String(err?.message ?? err) }, failures });
      log?.warn?.("reference sync failed", { dataset: name, code });
      return { dataset: name, ok: false, code };
    }
    const prev = state.datasets[name] ?? {};
    const sameFile = prev.sha256 === file.sha256 && (name !== "ban" || banDoc.days?.[date]) && (name !== "mwpl" || mwplDoc.days?.[date]);
    if (sameFile) {
      // The market-lots file is the same on most days: a successful fetch still confirms the lots as of today, so
      // staleness (counted from asOf) does not grow while every daily sync succeeds. Ban and MWPL keep their forDate.
      const okAt = istIso(now());
      const sameAsOf = name === "lots" ? today() : prev.asOf;
      record(name, { lastSuccessAt: okAt, asOf: sameAsOf, error: null, failures: 0 });
      if (name === "lots" && universeDoc?.knownSince) record("universe", { lastSuccessAt: okAt, lastAttemptAt: attemptAt, asOf: sameAsOf, error: null });
      bus?.emit("reference.updated", { dataset: name, asOf: sameAsOf ?? today(), source: SOURCES[name], changed: false });
      return { dataset: name, ok: true, changed: false };
    }
    let changed = false;
    let asOf = today();
    let rows = 0;
    try {
      if (name === "lots") {
        const parsed = parseMktLots(file.buf.toString("utf8"));
        const merged = mergeLotHistory(lotsDoc.rows, parsed, { exchange: "NFO", date: today(), source: SOURCES.lots });
        const uni = updateUniverse(universeDoc?.knownSince ? universeDoc : null, membersFromMktLots(parsed), today(), (d) => cal.prevTradingDay(d));
        lotsDoc = { version: 1, rows: merged.rows };
        universeDoc = uni.universe;
        write("lots.json", lotsDoc);
        write("universe.json", universeDoc);
        changed = merged.changed || uni.changed;
        rows = parsed.rows.length;
        record("universe", { lastSuccessAt: istIso(now()), lastAttemptAt: attemptAt, asOf, error: null, knownSince: universeDoc.knownSince });
      } else if (name === "ban") {
        const parsed = parseSecBan(file.buf.toString("utf8"));
        const forD = parsed.forDate ?? date;
        const before = JSON.stringify(banDoc.days?.[forD]?.symbols ?? null);
        banDoc = { version: 1, days: { ...(banDoc.days ?? {}), [forD]: { symbols: parsed.symbols, asOf: today(), source: SOURCES.ban } } };
        write("ban.json", banDoc);
        changed = before !== JSON.stringify(parsed.symbols);
        asOf = forD;
        rows = parsed.symbols.length;
      } else {
        const text = readCombineOiZip(file.buf, { maxBytes: cfg.sources.nseArchives.maxBytes });
        const parsed = parseCombineOi(text);
        const forD = parsed.forDate ?? date;
        mwplDoc = { version: 1, days: { ...(mwplDoc.days ?? {}), [forD]: { rows: parsed.rows, asOf: forD, source: SOURCES.mwpl } } };
        write("mwpl.json", mwplDoc);
        changed = true;
        asOf = forD;
        rows = parsed.rows.length;
      }
    } catch (err) {
      record(name, { error: { code: "PARSE_FAILED", detail: String(err?.message ?? err).slice(0, 200) }, failures: (prev.failures ?? 0) + 1 });
      log?.warn?.("reference file could not be parsed; the previous data stays in force", { dataset: name, err: String(err?.message ?? err) });
      return { dataset: name, ok: false, code: "PARSE_FAILED" };
    }
    record(name, { lastSuccessAt: istIso(now()), asOf, source: SOURCES[name], sha256: file.sha256, rows, error: null, failures: 0 });
    bus?.emit("reference.updated", { dataset: name, asOf, source: SOURCES[name], changed });
    return { dataset: name, ok: true, changed };
  }

  /** Non-standard stock option contracts from the masters (§6.2). No network. */
  async function inferFromMasters() {
    const attemptAt = istIso(now());
    record("corporateActions", { lastAttemptAt: attemptAt });
    if (!symbols) return { dataset: "corporateActions", ok: false, code: "NO_MASTER" };
    const stocks = [...new Set(lotRows().filter((r) => r.kind === "stock").map((r) => r.underlying))];
    const found = [];
    for (const u of stocks) {
      const m = await masterContracts(u, "NFO");
      const flagged = inferNonStandard(
        m.contracts.map((c) => ({ canonical: c.canonical, underlying: c.underlying, expiry: c.expiry, strike: c.strike, lotSize: c.lotSize })),
        (und, exp) => lotForMonth(timelineFor(und, "NFO"), exp.slice(0, 7)),
      );
      for (const f of flagged) {
        found.push({ id: `inf_${f.canonical}`, symbol: f.underlying, exchange: "NSE", type: "other", ratio: null, exDate: null, factor: null, source: "inferred from the instrument master", verified: false, origin: "inferred", quality: "inferred", nonStandard: true, text: f.text, contract: { canonical: f.canonical, expiry: f.expiry, strike: f.strike, lot: f.lot, standardLot: f.standardLot, lotMismatch: f.lotMismatch, offGrid: f.offGrid } });
        if (found.length >= MAX_INFERRED) break;
      }
      if (found.length >= MAX_INFERRED) break;
    }
    inferredCache = found;
    state.inferred = found;
    record("corporateActions", { lastSuccessAt: istIso(now()), asOf: today(), error: null, rows: found.length, mastersSig: mastersLoadedSig() });
    bus?.emit("reference.updated", { dataset: "corporateActions", asOf: today(), source: "inferred", changed: true });
    return { dataset: "corporateActions", ok: true, changed: true };
  }

  /**
   * Start a sync and return the job at once ({ jobId, datasets, startedAt, reason, promise }); POST /sync answers 202
   * with it. Throws IDEMPOTENCY_IN_PROGRESS while another sync runs, CAPABILITY_UNSUPPORTED in demo mode.
   * @param {{ datasets?: string[], reason?: string, forDates?: Record<string, string> }} [o]
   */
  function startSync({ datasets, reason = "manual", forDates = {} } = {}) {
    if (demo) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Demo mode never downloads reference files.");
    const list = datasets?.length ? datasets : ["lots", "ban", "mwpl"];
    const bad = list.filter((d) => !SYNC_DATASETS.includes(d) && d !== "universe");
    if (bad.length) throw invalid(`Unknown dataset(s): ${bad.join(", ")}. Use ${SYNC_DATASETS.join(", ")}.`, "datasets");
    if (running) throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", `A reference sync (${running.jobId}: ${running.datasets.join(", ")}) is still running.`);
    if (ticking) throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", "A scheduled reference job is still running.");
    const names = [...new Set(list.map((d) => (d === "universe" ? "lots" : d)))];
    jobSeq += 1;
    running = { jobId: `refsync_${now().toString(36)}_${jobSeq}`, datasets: names, startedAt: istIso(now()), reason };
    const job = running;
    job.promise = (async () => {
      const results = [];
      try {
        for (const n of names) results.push(await syncOne(n, { forDate: forDates[n] }));
      } finally {
        saveState();
        running = null;
      }
      return { jobId: job.jobId, reason, results };
    })();
    return job;
  }

  // ── scheduler ──
  const JOBS = Object.freeze([
    { name: "morning", at: () => cfg.schedule.morning },
    { name: "morningRetry", at: () => cfg.schedule.morningRetry, retryOf: "morning" },
    { name: "evening", at: () => cfg.schedule.evening },
    { name: "eveningRetry", at: () => cfg.schedule.eveningRetry, retryOf: "evening" },
  ]);
  /** A job that is more than this late (Bridge started afterwards) is skipped; the startup sync covers it. */
  const LATE_MS = 3 * 3_600_000;

  /** One scheduled job. It holds the same `running` slot as startSync, so a manual or startup sync cannot overlap it. */
  async function runJob(name) {
    if (running) throw new BridgeError("IDEMPOTENCY_IN_PROGRESS", `A reference sync (${running.jobId}: ${running.datasets.join(", ")}) is still running.`);
    const base = name.replace(/Retry$/, "");
    jobSeq += 1;
    running = { jobId: `refjob_${now().toString(36)}_${jobSeq}`, datasets: base === "morning" ? ["lots", "ban", "corporateActions"] : ["ban", "mwpl", "lots"], startedAt: istIso(now()), reason: name };
    try {
      return await runJobBody(name, base);
    } finally {
      running = null;
    }
  }

  async function runJobBody(name, base) {
    const t = today();
    const results = [];
    if (base === "morning") {
      results.push(await syncOne("lots"));
      if (!banDoc.days?.[t] && cal.isTradingDay(t)) results.push(await syncOne("ban", { forDate: t }));
      results.push(await inferFromMasters());
      try {
        store?.pruneRaw(cfg.retentionDays, t);
        const banCut = addDays(t, -(cfg.retentionDays ?? BAN_KEEP_DAYS_DEFAULT));
        banDoc = { version: 1, days: Object.fromEntries(Object.entries(banDoc.days ?? {}).filter(([d]) => d >= banCut)) };
        mwplDoc = { version: 1, days: Object.fromEntries(Object.entries(mwplDoc.days ?? {}).filter(([d]) => d >= addDays(t, -MWPL_KEEP_DAYS))) };
        if (archivesEnabled()) {
          write("ban.json", banDoc);
          write("mwpl.json", mwplDoc);
        }
      } catch (err) {
        log?.warn?.("reference retention failed", { err: String(err?.message ?? err) });
      }
    } else {
      results.push(await syncOne("ban", { forDate: cal.nextTradingDay(t) }));
      results.push(await syncOne("mwpl", { forDate: t }));
      results.push(await syncOne("lots"));
    }
    const failed = results.some((r) => !r.ok && r.code !== "SOURCE_OFF");
    state.jobs[name] = { day: t, ok: !failed };
    saveState();
    return { job: name, results, failed };
  }

  let ticking = false;
  /** One minute tick: run the jobs that are due today (trading days only). Exposed for tests. */
  async function tick() {
    if (demo || ticking || running) return null;
    const t = now();
    const d = today();
    if (!cal.isTradingDay(d)) return null;
    ticking = true;
    try {
      for (const j of JOBS) {
        const due = istInstant(d, j.at()) + jitterMs;
        if (t < due || state.jobs[j.name]?.day === d) continue;
        if (j.retryOf) {
          const main = state.jobs[j.retryOf];
          if (!main || main.day !== d || main.ok) {
            if (main?.day === d) state.jobs[j.name] = { day: d, ok: true, skipped: true };
            continue;
          }
        }
        if (t > due + LATE_MS) {
          state.jobs[j.name] = { day: d, ok: true, skipped: "late" };
          continue;
        }
        if (!archivesEnabled() && j.name !== "morning") {
          state.jobs[j.name] = { day: d, ok: true, skipped: "SOURCE_OFF" };
          continue;
        }
        return await runJob(j.name);
      }
      return null;
    } finally {
      ticking = false;
    }
  }

  /** Datasets whose last success is older than staleAfterTradingDays (or never): fetch them once at start. */
  async function startupSync() {
    if (demo || !archivesEnabled() || running || ticking) return null;
    const names = ["lots", "ban", "mwpl"].filter((n) => {
      const st = state.datasets[n];
      if (!st?.lastSuccessAt) return true;
      const days = cal.staleTradingDays(st.lastSuccessAt.slice(0, 10), today());
      return days !== null && days > cfg.staleAfterTradingDays;
    });
    if (!names.length) return null;
    return startSync({ datasets: names, reason: "startup" }).promise;
  }

  let interval = null;
  let startupTimer = null;
  let lastMasterSig = null;
  function start() {
    if (demo || interval) return;
    interval = timers.setInterval(() => {
      tick().catch((err) => log?.warn?.("reference tick failed", { err: String(err?.message ?? err) }));
      // Re-run the inference when the masters reload.
      const sig = mastersLoadedSig();
      if (symbols && sig && lastMasterSig !== null && sig !== lastMasterSig && !running) inferFromMasters().then(saveState, () => {});
      lastMasterSig = sig;
    }, 60_000);
    interval?.unref?.();
    startupTimer = timers.setTimeout(() => startupSync().catch(() => {}), 30_000);
    startupTimer?.unref?.();
  }
  function stop() {
    if (interval) timers.clearInterval(interval);
    if (startupTimer) timers.clearTimeout(startupTimer);
    interval = null;
    startupTimer = null;
  }

  return {
    // contract
    session,
    calendar,
    rate,
    lotFor,
    freezeFor,
    banStatus,
    universe,
    corporateActions,
    events,
    charges,
    deliveryMargin,
    status,
    bundle,
    /** Run a sync; resolves with { jobId, reason, results: [{ dataset, ok, changed?, code? }] }. */
    sync: async (o) => startSync(o).promise,
    // extras for routes, MCP and tests
    isDemo: () => demo,
    /** Demo only: report the lots as stale (true) or current (false). Returns the flag; a non-demo Bridge refuses. */
    setDemoLotsStale(on) {
      if (!demo) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Only a demo Bridge can pretend its lot data is stale.");
      demoLotsStale = Boolean(on);
      return demoLotsStale;
    },
    demoLotsStale: () => demo && demoLotsStale,
    /**
     * Demo only (p1-06 §4.2): force stocks into the ban period for `minutes` (memory only), so the "close allowed,
     * open refused" path can be tried. An empty list clears it. A non-demo Bridge refuses.
     */
    setDemoBanOverride({ symbols = [], minutes = 30 } = {}) {
      if (!demo) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Only a demo Bridge can force a ban list.");
      demoBan = symbols.length ? { symbols: new Set(symbols), until: now() + minutes * 60_000 } : null;
      return { ban: symbols.length ? [...demoBan.symbols].sort() : [], until: demoBan ? istIso(demoBan.until) : null, source: "demo-override" };
    },
    config: () => cfg,
    /**
     * For P1-13a participants (and other archive users): whether NSE archive downloads are on, and the one shared
     * polite client (one request in flight across every user), or null in demo mode or when downloads are off.
     */
    archives: () => ({ enabled: archivesEnabled(), setBy: demo ? "demo" : effectiveSettings(cfg, settings).nseArchives.setBy, client: archivesEnabled() ? clientFor() : null }),
    expiries,
    holidays({ from, to, exchange } = {}) {
      const items = cal.holidaysIn(from, to, exchange).map((h) => ({ date: h.date, label: h.label, exchanges: [...h.exchanges], verified: h.verified, origin: h.origin === "config" ? "config" : "shipped" }));
      // Special sessions in the same range (Muhurat often falls on a weekday holiday), so a month needs one request.
      const specialSessions = Object.keys(cal.specialSessions)
        .filter((d) => d >= from && d <= to)
        .sort()
        .map((d) => cal.specialOn(d, exchange ?? "NSE"))
        .filter(Boolean)
        .map((x) => ({ date: x.date, label: x.label, open: x.open, close: x.close, verified: x.verified, origin: x.origin }));
      return { items, specialSessions, source: demo ? `${SHIPPED_HOLIDAYS.source} (treated as verified in demo mode)` : SHIPPED_HOLIDAYS.source, asOf: SHIPPED_HOLIDAYS.asOf };
    },
    lots: lotsView,
    banList,
    mwplList,
    previewAction: (body) => previewAdjustment(body, { extraordinaryDividendPct: cfg.extraordinaryDividendPct }),
    addAction,
    deleteAction,
    setRate,
    setSources,
    startSync,
    syncRunning: () => running,
    tick,
    runJob,
    startupSync,
    start,
    stop,
  };
}
