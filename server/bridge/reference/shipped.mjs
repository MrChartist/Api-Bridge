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

/** { version, asOf, source, years: { "2026": [{ date, label, exchanges, verified }] }, special: [...] } */
export const SHIPPED_HOLIDAYS = deepFreeze(load("holidays.json"));
/** { version, asOf, source, verified, appliesTo, schedule: [{ day: "E-4", pct }] } */
export const SHIPPED_DELIVERY_MARGIN = deepFreeze(load("delivery-margin.json"));
/** Statutory charges (the shape of the dashboard's CHARGE_RATES, without brokerage). */
export const SHIPPED_CHARGES = deepFreeze(load("charges.json"));
/** { version, asOf, source, items: [CorporateAction without factor/origin] } */
export const SHIPPED_CORPORATE_ACTIONS = deepFreeze(load("corporate-actions.json"));

/** Shipped holiday rows, flattened and sorted, each with origin "shipped". */
export function shippedHolidayRows() {
  return Object.values(SHIPPED_HOLIDAYS.years)
    .flat()
    .map((r) => ({ date: r.date, label: r.label, exchanges: [...r.exchanges], verified: r.verified === true, origin: "shipped" }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Shipped special sessions as { date: { open, close, label, exchanges, verified } }. */
export function shippedSpecialSessions() {
  return Object.fromEntries(SHIPPED_HOLIDAYS.special.map((s) => [s.date, { open: s.open, close: s.close, label: s.label, exchanges: [...s.exchanges], verified: s.verified === true }]));
}
