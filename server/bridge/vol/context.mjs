/**
 * The server's pricing (clock) context (the vol module). Builds the context
 * dashboard/pricing.js needs from the `vol.clock` settings plus the reference calendar, session and rate.
 * Imported by market/chain pricing (`?ivModel=b76-forward`), the demo adapter and, later, the vol service, recorder,
 * exposure and strategy.
 *
 * Pure apart from the reads of `reference`. Without a usable reference service (a stub, or a tool that builds market
 * data by hand) it falls back to a weekends-only calendar (`holidays: "unknown"`), the default session window from
 * reference/defaults.mjs and the default rate, each labelled.
 */
import { isStub } from "../core/contracts.mjs";
import { CLOCK_VERSION, yearBasisOf } from "../dashboard/pricing.js";
import { DEFAULT_RATE, DEFAULT_RATE_SOURCE, defaultSessionFor } from "../reference/defaults.mjs";
import { clockSettings } from "./config.mjs";

/** Index underlyings (their settlement window is `settlementWindowMinutes.index`); everything else is a stock. */
const INDEX_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX", "SENSEX50"]);

/** "index" or "stock" for an underlying symbol. */
export const kindOf = (underlying) => (INDEX_UNDERLYINGS.has(String(underlying ?? "").toUpperCase()) ? "index" : "stock");

const usable = (svc) => Boolean(svc) && !isStub(svc);

/**
 * A clock context from parts (pure).
 * @param {{ settings: object, kind?: "index"|"stock", session: { open: string, close: string, source?: string },
 *   isTradingDay?: (date: string) => boolean, holidays?: Array<string|{ date: string }>, holidaysSource?: string,
 *   rate?: { value: number, quality?: string, source?: string } }} p
 */
export function buildClockContext({ settings, kind = "index", session, isTradingDay, holidays = [], holidaysSource = "reference", rate = null }) {
  const s = settings ?? clockSettings(null);
  const w = s.settlementWindowMinutes;
  const ctx = {
    version: CLOCK_VERSION,
    mode: s.mode,
    nonTradingDayWeight: s.nonTradingDayWeight,
    overnightShare: s.overnightShare,
    eventDays: s.eventDays ?? {},
    yearBasis: s.yearBasis ?? null,
    settlementWindowMinutes: typeof w === "number" ? w : (w?.[kind] ?? w?.index ?? 30),
    session: { open: session.open, close: session.close, source: session.source ?? null },
    holidays: holidays.map((h) => (typeof h === "string" ? h : h.date)),
    holidaysSource,
    rate: rate ?? { value: DEFAULT_RATE, quality: "default", source: DEFAULT_RATE_SOURCE },
  };
  if (typeof isTradingDay === "function") ctx.isTradingDay = isTradingDay;
  ctx.effectiveYearBasis = yearBasisOf(ctx);
  return ctx;
}

/**
 * Holiday dates that close an exchange (rows { date, exchanges }). The clock counts a day as a trading day when it is a
 * weekday not in this list, which the dashboard can rebuild from GET /v1/vol/clock alone. A special session held on a
 * holiday (Muhurat trading, about an hour) stays a non-trading day for the clock.
 */
export function holidayDates(rows, exchange = "NFO") {
  const key = exchange === "BFO" || exchange === "BSE" ? "BSE" : "NSE";
  return (rows ?? []).filter((h) => (h.exchanges ?? ["NSE", "BSE"]).includes(key)).map((h) => h.date);
}

/**
 * The clock context for an exchange at `now`, from config and the reference service.
 * @param {{ config?: object, reference?: object, exchange?: string, kind?: "index"|"stock", now?: number }} p
 */
export function pricingContext({ config, reference, exchange = "NFO", kind = "index", now = 0 } = {}) {
  const settings = clockSettings(config);
  const fallbackSession = defaultSessionFor(exchange) ?? defaultSessionFor("NFO");
  if (!usable(reference)) {
    return buildClockContext({ settings, kind, session: { ...fallbackSession, source: "default (reference data not loaded)" }, holidaysSource: "unknown" });
  }
  let session = { ...fallbackSession, source: "default" };
  let holidays = [];
  let holidaysSource = "reference";
  let rate = null;
  try {
    const s = reference.session(exchange, now);
    if (s?.open && s?.close) session = { open: s.open, close: s.close, source: s.source ?? null };
  } catch {
    // keep the default window
  }
  try {
    holidays = holidayDates(reference.calendar().holidays, exchange);
  } catch {
    holidaysSource = "unknown";
  }
  try {
    const r = reference.rate();
    if (typeof r?.value === "number" && Number.isFinite(r.value)) rate = { value: r.value, quality: r.quality ?? null, source: r.source ?? null };
  } catch {
    // default rate
  }
  return buildClockContext({ settings, kind, session, holidays, holidaysSource, rate });
}
