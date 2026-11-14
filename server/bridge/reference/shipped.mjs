/**
 * The datasets shipped in the repo (reference/data/*.json), read once and frozen. A release updates these files (the
 * holiday list each December); every row from outside the repo carries `verified`, and nothing unverified becomes a
 * blocking rule.
 */
import { readFileSync } from "node:fs";

const load = (name) => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), "utf8"));

const deepFreeze = (o) => {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

/** { version, asOf, source, sources, amendments, years: { "2026": [{ date, label, exchanges, verified }] } } */
export const SHIPPED_HOLIDAYS = deepFreeze(load("holidays.json"));
/** { version, asOf, source, verified, appliesTo, schedule: [{ day: "E-4", pct }] } */
export const SHIPPED_DELIVERY_MARGIN = deepFreeze(load("delivery-margin.json"));
/** Statutory charges (the shape of the dashboard's CHARGE_RATES, without brokerage). */
export const SHIPPED_CHARGES = deepFreeze(load("charges.json"));
/** { version, note, entries: { "NFO:NIFTY": { freezeQty, lotWiseQty, verified, asOf, source, circular, readOn, note } } } */
export const SHIPPED_FREEZE = deepFreeze(load("freeze-quantities.json"));
/** { version, asOf, source, items: [CorporateAction without factor/origin] } */
export const SHIPPED_CORPORATE_ACTIONS = deepFreeze(load("corporate-actions.json"));

/** Shipped holiday rows, flattened and sorted, each with origin "shipped". */
export function shippedHolidayRows() {
  return Object.values(SHIPPED_HOLIDAYS.years)
    .flat()
    .map((r) => ({ date: r.date, label: r.label, exchanges: [...r.exchanges], verified: r.verified === true, origin: "shipped" }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** { version, asOf, gateFloor, rules: [{ id, segment, exchanges, from, to?, preOpen, open, close, verified, circular, source, readOn }] } */
export const SHIPPED_SESSIONS = deepFreeze(load("sessions.json"));
/** { version, asOf, sessions: [{ date, label, exchanges, open, close, preOpen?, cas?, verified, source, readOn, note }] } */
export const SHIPPED_SPECIAL_SESSIONS = deepFreeze(load("special-sessions.json"));

/** The dated session rules (a fresh copy; the calendar reads them with createCalendar({ rules })). */
export function shippedSessionRules() {
  return { gateFloor: { ...SHIPPED_SESSIONS.gateFloor }, rules: SHIPPED_SESSIONS.rules.map((r) => ({ ...r, exchanges: [...r.exchanges] })) };
}

/**
 * Shipped special sessions as { date: { open, close, preOpen, cas, label, exchanges, verified, source, readOn, note } }.
 * `verified` is true only when the timing was read in the exchange circular; the calendar shows the flag and the live-order
 * gate refuses orders in a session that is not verified.
 */
export function shippedSpecialSessions() {
  return Object.fromEntries(
    SHIPPED_SPECIAL_SESSIONS.sessions.map((s) => [
      s.date,
      {
        open: s.open ?? null,
        close: s.close ?? null,
        preOpen: s.preOpen ?? null,
        cas: s.cas ? { ...s.cas } : null,
        label: s.label,
        exchanges: [...s.exchanges],
        verified: s.verified === true,
        source: s.source ?? null,
        readOn: s.readOn ?? null,
        note: s.note ?? null,
      },
    ]),
  );
}
