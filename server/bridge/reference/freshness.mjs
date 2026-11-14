/**
 * How current the shipped reference data is (reference/data/*.json), in plain words. Pure: the clock comes in.
 *
 * Two rules, both from the maintainers' own checklist (docs/reference-data.md):
 *  - the holiday calendar must have rows for the NEXT calendar year (NSE publishes the list for a year in December; a year
 *    with no rows is treated as ordinary weekdays, and the Bridge says so);
 *  - no dataset may carry an `asOf` older than six months.
 *
 * Used by `mc-bridge doctor` (a warning each) and by the readiness page of the dashboard (the same sentences). A warning
 * never blocks an order: unverified or old reference data is shown, not enforced.
 */
import { SHIPPED_CHARGES, SHIPPED_DELIVERY_MARGIN, SHIPPED_FREEZE, SHIPPED_HOLIDAYS, SHIPPED_SESSIONS, SHIPPED_SPECIAL_SESSIONS } from "./shipped.mjs";

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
/** A dataset older than this many months is called out. */
export const MAX_AGE_MONTHS = 6;

const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The date `months` calendar months before `date` ("YYYY-MM-DD"), the day clamped to the month's length. */
export function monthsBefore(date, months) {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

const ageOf = (asOf, today) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
const monthsAgoText = (asOf, today) => {
  const days = ageOf(asOf, today);
  const months = Math.floor(days / 30.44);
  return months >= 1 ? `${months} month${months === 1 ? "" : "s"} ago` : `${days} day${days === 1 ? "" : "s"} ago`;
};

/** The datasets whose asOf is checked: { id, title, file, asOf, detail? }. asOf is the oldest date inside the file. */
function datasetsOf({ holidays, sessions, specials, charges, delivery, freeze }) {
  const oldest = (dates) => dates.filter(Boolean).sort()[0] ?? null;
  const freezeRows = Object.entries(freeze?.entries ?? {});
  const freezeOldest = oldest(freezeRows.map(([, e]) => e.asOf));
  const stalest = freezeRows.filter(([, e]) => e.asOf === freezeOldest).map(([k]) => k.split(":")[1]);
  const chargeGroups = Object.entries(charges?.groups ?? {});
  const chargeOldest = oldest([charges?.asOf, ...chargeGroups.map(([, g]) => g.asOf)]);
  const chargeStalest = chargeGroups.filter(([, g]) => g.asOf === chargeOldest).map(([k]) => k);
  return [
    { id: "holidays", title: "Holiday calendar", file: "holidays.json", asOf: holidays?.asOf ?? null },
    { id: "sessions", title: "Session hours", file: "sessions.json", asOf: sessions?.asOf ?? null },
    { id: "special-sessions", title: "Special sessions (Muhurat, Budget day)", file: "special-sessions.json", asOf: specials?.asOf ?? null },
    { id: "freeze-quantities", title: "Freeze quantities", file: "freeze-quantities.json", asOf: freezeOldest, detail: stalest.length ? `oldest: ${stalest.join(", ")}` : null },
    { id: "charges", title: "Statutory charges", file: "charges.json", asOf: chargeOldest, detail: chargeStalest.length ? `oldest group: ${chargeStalest.join(", ")}` : null },
    { id: "delivery-margin", title: "Delivery-margin schedule", file: "delivery-margin.json", asOf: delivery?.asOf ?? null },
  ];
}

/**
 * @param {{ now?: number, data?: object }} [o]  data: override the shipped files (tests)
 * @returns {{ today: string, level: "ok"|"warn", summary: string, items: Array<{ id: string, title: string, level: "ok"|"warn", asOf: string|null, message: string, fix?: string }> }}
 */
export function referenceFreshness({ now = Date.now(), data } = {}) {
  const d = data ?? { holidays: SHIPPED_HOLIDAYS, sessions: SHIPPED_SESSIONS, specials: SHIPPED_SPECIAL_SESSIONS, charges: SHIPPED_CHARGES, delivery: SHIPPED_DELIVERY_MARGIN, freeze: SHIPPED_FREEZE };
  const today = istDate(now);
  const year = Number(today.slice(0, 4));
  const items = [];
  const cutoff = monthsBefore(today, MAX_AGE_MONTHS);
  const FIX = "Update the file at the next release (docs/reference-data.md says where each figure comes from and how).";

  // The calendar must reach into next year.
  const years = Object.keys(d.holidays?.years ?? {}).map(Number);
  const rowsIn = (y) => (d.holidays?.years?.[String(y)] ?? []).length;
  if (!rowsIn(year)) {
    items.push({ id: "calendar-year", title: "Holiday calendar", level: "warn", asOf: d.holidays?.asOf ?? null, message: `The holiday calendar has no rows for ${year}, so every weekday this year is treated as a trading day. Live orders still go out, but each carries a "not holiday-checked" warning.`, fix: FIX });
  } else if (!rowsIn(year + 1)) {
    items.push({
      id: "calendar-next-year",
      title: "Holiday calendar",
      level: "warn",
      asOf: d.holidays?.asOf ?? null,
      message: `The holiday calendar has no rows for ${year + 1} yet (it covers ${years.sort((a, b) => a - b).join(", ")}). Dates in ${year + 1} are treated as ordinary weekdays, and every answer for them says it is not verified. NSE usually publishes the next year's list in December.`,
      fix: FIX,
    });
  } else {
    items.push({ id: "calendar-next-year", title: "Holiday calendar", level: "ok", asOf: d.holidays?.asOf ?? null, message: `The holiday calendar covers ${year} and ${year + 1}.` });
  }

  for (const ds of datasetsOf(d)) {
    if (!ds.asOf) {
      items.push({ id: `asof-${ds.id}`, title: ds.title, level: "warn", asOf: null, message: `${ds.title}: the file has no asOf date, so its age is unknown.`, fix: FIX });
    } else if (ds.asOf < cutoff) {
      items.push({
        id: `asof-${ds.id}`,
        title: ds.title,
        level: "warn",
        asOf: ds.asOf,
        message: `${ds.title}: as of ${ds.asOf} (${monthsAgoText(ds.asOf, today)}, older than ${MAX_AGE_MONTHS} months${ds.detail ? `; ${ds.detail}` : ""}). Check the figures against the current circular before relying on them.`,
        fix: FIX,
      });
    } else {
      items.push({ id: `asof-${ds.id}`, title: ds.title, level: "ok", asOf: ds.asOf, message: `${ds.title}: as of ${ds.asOf}.` });
    }
  }

  const warns = items.filter((i) => i.level === "warn");
  return {
    today,
    level: warns.length ? "warn" : "ok",
    summary: warns.length ? `${warns.length} reference-data item${warns.length === 1 ? " is" : "s are"} out of date` : "Reference data is current",
    items,
  };
}
