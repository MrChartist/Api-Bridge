// The page's vol-time clock (docs/spec/p1-03-pricing-vol.md §5.1). Every Options page prices on ONE clock, the same
// one the Bridge uses for ?ivModel=b76-forward and the 15:25 vol store: loadPricingContext(underlying) reads
// GET /v1/vol/clock (reused for 10 minutes per underlying), builds the client clock context from it and hands it to
// options.js (setPricingContext). Until it arrives — or on an older Bridge without the route — options.js keeps its
// weighted, weekends-only default and clockNote() says holidays are not loaded yet.
//
// Pure helpers (contextFromClock, clockNote, nextSessionUnits) are exported for tests; numbers become text through
// format.js only; copy is descriptive (copyRules.mjs).
import { api } from "./app.js";
import { formatFixed } from "./format.js";
import { getPricingContext, setPricingContext } from "./options.js";
import { clockSettings, volTime, yearBasisOf } from "./pricing.js";

/** How long one clock payload is reused per underlying. */
export const CLOCK_TTL_MS = 10 * 60_000;
/** After a failure, the same fallback is kept this long before asking again. */
export const CLOCK_RETRY_MS = 60_000;

const cache = new Map();

/**
 * The client clock context from a GET /v1/vol/clock payload: the installation's settings, the session the Bridge
 * measures to, and the holidays ahead (the calendar the server's clock counts with).
 */
export function contextFromClock(clock) {
  const st = clock?.settings;
  if (!st?.session?.open || !st?.session?.close) return null;
  return {
    mode: st.mode,
    nonTradingDayWeight: st.nonTradingDayWeight,
    overnightShare: st.overnightShare,
    eventDays: st.eventDays ?? {},
    yearBasis: st.yearBasis ?? null,
    settlementWindowMinutes: st.settlementWindowMinutes,
    session: { open: st.session.open, close: st.session.close },
    holidays: (clock.holidays ?? []).map((h) => h.date),
    holidaysSource: st.holidays ?? "reference",
    rate: clock.rate ?? null,
    underlying: clock.underlying ?? null,
    loaded: true,
  };
}

async function defaultGet(path) {
  return (await api(path)).data?.data ?? null;
}

/** Forget cached clocks (tests, a config change). */
export function clearClockCache() {
  cache.clear();
}

/**
 * Load the clock for an underlying and make it the page's context. Never throws: on failure the default context stays
 * (labelled "Holidays not loaded yet") and the route is asked again after CLOCK_RETRY_MS.
 * @returns {Promise<object>} the context in force
 */
export async function loadPricingContext(underlying, { force = false, now = Date.now(), get = defaultGet } = {}) {
  const u = String(underlying ?? "").trim().toUpperCase();
  if (!u) return getPricingContext();
  const hit = cache.get(u);
  if (!force && hit && now - hit.at < hit.ttl) {
    const ctx = await hit.promise;
    if (ctx) setPricingContext(ctx);
    return getPricingContext();
  }
  const entry = { at: now, ttl: CLOCK_TTL_MS, promise: null };
  entry.promise = (async () => {
    try {
      const ctx = contextFromClock(await get(`/v1/vol/clock?underlying=${encodeURIComponent(u)}`));
      if (!ctx) throw new Error("Unexpected clock payload");
      return ctx;
    } catch {
      entry.ttl = CLOCK_RETRY_MS;
      return null;
    }
  })();
  cache.set(u, entry);
  const ctx = await entry.promise;
  if (ctx) setPricingContext(ctx);
  return getPricingContext();
}

/**
 * Method-note lines for the clock in force (§5.1): the mode with its weights (stated assumptions), the expiry-day
 * settlement window, and that interest runs on calendar days.
 */
export function clockNote(ctx = getPricingContext()) {
  const s = clockSettings(ctx);
  const lines = [];
  if (s.mode === "calendar") lines.push("Time: calendar days to the expiry close ÷ 365 (ACT/365); nights and weekends count in full.");
  else if (s.mode === "trading") lines.push(`Time: trading-day clock (each trading day 1, nights and weekends 0, ${formatFixed(yearBasisOf(ctx), 0)} days a year).`);
  else {
    lines.push(
      `Time: weighted vol-time clock (trading day 1, weekend/holiday day ${formatFixed(s.nonTradingDayWeight, 2)}, overnight share ${formatFixed(s.overnightShare, 2)}, ${formatFixed(yearBasisOf(ctx), 2)} units a year). The weights are assumptions, not measured.`,
    );
  }
  if (s.mode !== "calendar" && s.settlementWindowMinutes > 0) lines.push(`Expiry day: the ${formatFixed(s.settlementWindowMinutes, 0)}-minute settlement window counts one third.`);
  lines.push("Interest (discounting, parity forward, carry) uses calendar days.");
  if (!ctx?.loaded) lines.push("Holidays not loaded yet: weekends only.");
  return lines;
}

/**
 * Trading-day units from `now` to the same time on the next session (1.0 weekday to weekday, 1.3 Friday to Monday
 * with the default weights): the "next session decays N trading days" figure. Null when it cannot be read.
 */
export function nextSessionUnits(ctx = getPricingContext(), now = Date.now(), expiry = null) {
  const far = expiry ?? new Date(now + 60 * 86_400_000).toISOString().slice(0, 10);
  const a = volTime(ctx, now, far);
  if (!a) return null;
  for (let d = 1; d <= 6; d++) {
    const t = now + d * 86_400_000;
    const date = new Date(t + 330 * 60_000).toISOString().slice(0, 10);
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    const holiday = (ctx?.holidays ?? []).includes(date);
    if (wd === 0 || wd === 6 || holiday) continue;
    const b = volTime(ctx, t, far);
    return b ? a.units - b.units : null;
  }
  return null;
}
