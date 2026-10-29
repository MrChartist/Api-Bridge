/**
 * VolService (stream S18, docs/spec/p1-03-pricing-vol.md §2.2). Step P1-3a lands the contract and the clock; the
 * daily store, capture scheduler, read routes and back-fill arrive in P1-3b/P1-3c, and until then those methods answer
 * NOT_IMPLEMENTED (HTTP 501) like any service whose stream has not landed.
 */
import { BridgeError, NotImplementedError } from "../core/errors.mjs";
import { volTime } from "../dashboard/pricing.js";
import { defaultOptionExchange } from "../market/chain.mjs";
import { toIstIso } from "../market/time.mjs";
import { kindOf, pricingContext } from "./context.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const later = (m) => () => {
  throw new NotImplementedError(`VolService.${m}() (stream S18, step P1-3b/P1-3c)`);
};

/**
 * @param {object} deps  core deps plus marketData, reference, symbols, scheduler
 */
export function createVolService(deps) {
  const { config, clock } = deps;
  const now = () => clock.now();

  /** Clock settings and T for expiries (§3.3). Listed expiries come from marketData when none are given. */
  async function clockFor({ underlying, expiries, at } = {}) {
    const u = String(underlying ?? "").toUpperCase();
    if (!/^[A-Z0-9&-]{1,30}$/.test(u)) throw new BridgeError("VALIDATION_FAILED", "underlying is required, for example NIFTY.");
    const t = at === undefined || at === null ? now() : typeof at === "number" ? at : Date.parse(String(at));
    if (!Number.isFinite(t)) throw new BridgeError("VALIDATION_FAILED", "at must be an ISO-8601 instant.");
    let list = expiries;
    if (!Array.isArray(list) || !list.length) list = (await deps.marketData.expiries(u, { priority: "interactive" }))?.expiries ?? [];
    list = list.filter((e) => DATE_RE.test(String(e)));
    const exchange = defaultOptionExchange(u);
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
      holidays: ctx.holidays,
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
