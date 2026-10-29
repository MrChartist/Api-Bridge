/**
 * VolService (stream S18, docs/spec/p1-03-pricing-vol.md §2.2). Step P1-3a lands the contract and the clock; the
 * daily store, capture scheduler, read routes and back-fill arrive in P1-3b/P1-3c, and until then those methods answer
 * NOT_IMPLEMENTED (HTTP 501) like any service whose stream has not landed.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError, NotImplementedError } from "../core/errors.mjs";
import { volTime } from "../dashboard/pricing.js";
import { defaultOptionExchange } from "../market/chain.mjs";
import { istDate, toIstIso } from "../market/time.mjs";
import { kindOf, pricingContext } from "./context.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Listed expiries the clock reports when none are named (§3.3). */
const MAX_EXPIRY_DAYS = 100;
/** How far ahead the clock payload lists holidays (§3.3): enough for the dashboard to rebuild its clock. */
const HOLIDAY_DAYS = 400;
const MASTER_PAGE_LIMIT = 500;
const MASTER_MAX_PAGES = 20;
const usable = (svc) => Boolean(svc) && !isStub(svc);
const later = (m) => () => {
  throw new NotImplementedError(`VolService.${m}() (stream S18, step P1-3b/P1-3c)`);
};

/**
 * @param {object} deps  core deps plus marketData, reference, symbols, scheduler (the clock reads symbols and reference only)
 */
export function createVolService(deps) {
  const { config, clock } = deps;
  const now = () => clock.now();

  /**
   * Listed option expiries from the local instrument master (0 broker calls, §7): the clock is memory-only, so it never
   * reaches a broker for an expiry list. Without a loaded master the list is empty (callers can name expiries).
   */
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

  /** Holidays in [from, to] for the exchange, as { date, label, verified } (§3.3). */
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

  /**
   * Clock settings and T for expiries (§3.3). Without `expiries`, the listed expiries within 100 calendar days, read
   * from the instrument master (never a broker call). Holidays cover [at, at + 400 days] for the exchange.
   */
  async function clockFor({ underlying, expiries, at } = {}) {
    const u = String(underlying ?? "").toUpperCase();
    if (!/^[A-Z0-9&-]{1,30}$/.test(u)) throw new BridgeError("VALIDATION_FAILED", "underlying is required, for example NIFTY.");
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

  return {
    clock: clockFor,
    snapshot: later("snapshot"),
    history: later("history"),
    rank: later("rank"),
    summary: later("summary"),
    status: later("status"),
    capture: later("capture"),
    backfill: later("backfill"),
    cancelBackfill: later("cancelBackfill"),
    predictions: later("predictions"),
    logPredictions: later("logPredictions"),
  };
}
