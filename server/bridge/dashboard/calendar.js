// Market calendar (#/calendar, docs/spec/p1-02-reference.md §5.5): the reference data behind every Options page, with
// its sources. A status strip per dataset; the month calendar (trading days, holidays, special sessions, the selected
// underlying's expiries and holiday shifts); expiries and lot history; ban list and MWPL; the F&O universe by date;
// corporate actions with an adjustment preview; the risk-free rate (editable here, on this computer); the charge table.
//
// Pure helpers (monthGrid, monthList, statusTiles, toCsv, CSV_COLUMNS, previewBody, mwplView, universeNote) are
// exported for calendar.test.mjs; DOM code runs only in a browser. Numbers become text through format.js only. Copy
// describes facts and never advises (copyRules.mjs): "in ban", "MWPL 96 %", "lot changes".
import { alertBox, api, app, emptyState, h, icon, modal, mountToolbarCtx, optional, sheetPopover, toast } from "./app.js";
import { DASH, formatFixed, formatInt, formatRupee } from "./format.js";
import { DEMO_UNDERLYINGS, UNDERLYINGS } from "./desk.js";
import { REF_DEFAULTS, clearReferenceCache, dayText, daysBetween, istDate, loadReference, monthText, rateText, refBanners, refChip, upcomingEvents } from "./reference.js";
import { segmented } from "./views.js";

const SLOT = "mcb.dashboard.calendar";
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** replaceChildren without the nulls (a null child would print "null"). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The page's footer (spec §7.2). */
export const CAL_DISCLAIMER = "Reference data from the sources shown. Check exchange circulars before acting. Not investment advice.";
/** Below this width the month is a list of its non-ordinary days, not a grid (spec §5.5). */
export const LIST_BELOW_PX = 720;
/** "list" on phones (under 720 px), else "grid". */
export const monthMode = (width) => (Number(width) < LIST_BELOW_PX ? "list" : "grid");

// ── Month calendar (pure) ──

/** "2026-11" ± n months. */
export function addMonths(ym, n) {
  const [y, m] = String(ym).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month as weeks of 7 cells, Monday first: { date, day, inMonth, weekend, today, holiday: { label, verified } |
 * null, special: { label, open, close } | null, expiry: { kind, shifted, ruleDate, lot } | null, movedTo: date | null
 * (an expiry that would have been on this day was moved to that date), trading }.
 * @param {string} ym "YYYY-MM"
 * @param {{ holidays?: object[], expiries?: object[], specials?: object[], today?: string }} d
 */
export function monthGrid(ym, { holidays = [], expiries = [], specials = [], today = null } = {}) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return [];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const hol = new Map(holidays.filter((x) => ISO_DAY.test(String(x?.date))).map((x) => [x.date, x]));
  const spe = new Map(specials.filter((x) => ISO_DAY.test(String(x?.date))).map((x) => [x.date, x]));
  const exp = new Map(expiries.filter((x) => ISO_DAY.test(String(x?.date))).map((x) => [x.date, x]));
  const moved = new Map(expiries.filter((x) => x?.shifted && ISO_DAY.test(String(x.ruleDate))).map((x) => [x.ruleDate, x.date]));
  const cells = [];
  const total = Math.ceil((lead + days) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const t = new Date(Date.UTC(y, m - 1, 1 - lead + i));
    const date = t.toISOString().slice(0, 10);
    const dow = t.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const holiday = hol.get(date) ?? null;
    const special = spe.get(date) ?? null;
    const e = exp.get(date) ?? null;
    cells.push({
      date,
      day: t.getUTCDate(),
      inMonth: t.getUTCMonth() === m - 1,
      weekend,
      today: date === today,
      holiday: holiday ? { label: holiday.label, verified: Boolean(holiday.verified) } : null,
      special: special ? { label: special.label, open: special.open ?? null, close: special.close ?? null } : null,
      expiry: e ? { kind: e.kind, shifted: Boolean(e.shifted), ruleDate: e.ruleDate ?? null, lot: num(e.lot) } : null,
      movedTo: moved.get(date) ?? null,
      trading: (!weekend && !holiday) || Boolean(special && special.open),
    });
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The phone list: the month's non-ordinary days (holidays, special sessions, expiries, moved expiries), in order. */
export function monthList(weeks) {
  const out = [];
  for (const c of weeks.flat()) {
    if (!c.inMonth) continue;
    const notes = [];
    if (c.holiday) notes.push({ kind: "holiday", text: `${c.holiday.label}${c.holiday.verified ? "" : " (unverified)"}` });
    if (c.special) notes.push({ kind: "special", text: `${c.special.label}${c.special.open ? ` ${c.special.open}–${c.special.close}` : ": time not announced"}` });
    if (c.expiry) notes.push({ kind: "expiry", text: `${c.expiry.kind === "monthly" ? "Monthly" : "Weekly"} expiry${c.expiry.shifted && c.expiry.ruleDate ? ` (moved from ${dayText(c.expiry.ruleDate, { weekday: true })})` : ""}` });
    if (c.movedTo && !c.holiday) notes.push({ kind: "moved", text: `Expiry moved to ${dayText(c.movedTo, { weekday: true })}` });
    if (notes.length) out.push({ date: c.date, today: c.today, notes });
  }
  return out;
}

/**
 * The page's banners (spec §5.3): events within 7 days across the F&O market. The selected underlying's come first as
 * they are; every other one is labelled "Across F&O:" so it does not read as a fact about the selected underlying.
 */
export function calendarEvents(items, underlying) {
  return upcomingEvents(items ?? [])
    .map((e) => (e.underlying === underlying ? e : { ...e, text: `Across F&O: ${e.text || e.underlying}` }))
    .sort((a, b) => (a.underlying === underlying ? 0 : 1) - (b.underlying === underlying ? 0 : 1) || a.daysAway - b.daysAway);
}

/**
 * The short marks inside a month-grid cell, each with its full text for a tooltip: [{ kind, text, full }]. The cell is
 * narrow, so expiries say only "Weekly" / "Monthly" (the lot is in the Expiries table) and a move gets its own line.
 */
export function cellMarks(c) {
  const out = [];
  if (c.holiday) {
    out.push({ kind: "hol", text: c.holiday.label, full: `Holiday: ${c.holiday.label}${c.holiday.verified ? "" : " (unverified)"}` });
    if (!c.holiday.verified) out.push({ kind: "hol-u", text: "unverified", full: "Holiday not yet checked against the exchange circular" });
  }
  if (c.special) {
    // The cell is narrow: the first word of the label ("Muhurat"), the time on its own line; the full text is in the
    // cell's sheet (tap or Enter) and its label.
    out.push({ kind: "spe", text: String(c.special.label ?? "Special").split(/\s+/)[0], full: `${c.special.label}${c.special.open ? ` ${c.special.open}–${c.special.close} IST` : ": time not announced"}` });
    if (c.special.open) out.push({ kind: "spe-t", text: `${c.special.open}–${c.special.close}`, full: `${c.special.label} ${c.special.open}–${c.special.close} IST` });
  }
  if (c.expiry) {
    const word = c.expiry.kind === "monthly" ? "Monthly" : "Weekly";
    out.push({ kind: c.expiry.kind === "monthly" ? "exm" : "exw", text: word, full: `${word} expiry${c.expiry.lot ? `, lot ${formatInt(c.expiry.lot)}` : ""}` });
  }
  if (c.expiry?.shifted && c.expiry.ruleDate) {
    const from = dayText(c.expiry.ruleDate, { weekday: true }).split(" ").slice(0, 2).join(" ");
    out.push({ kind: "mov", text: `from ${from}`, full: `Expiry moved from ${dayText(c.expiry.ruleDate, { weekday: true })}` });
  }
  return out;
}

/** A grid cell's screen-reader label: the date, what kind of day it is, and every mark in full. */
export function cellLabel(c) {
  const kind = c.special ? `special session, ${c.special.label}${c.special.open ? ` ${c.special.open} to ${c.special.close} IST` : ", time not announced"}` : c.holiday ? `holiday, ${c.holiday.label}${c.holiday.verified ? "" : ", unverified"}` : c.trading ? "trading day" : "closed";
  const exp = c.expiry ? `${c.expiry.kind} expiry${c.expiry.lot ? `, lot ${formatInt(c.expiry.lot)}` : ""}${c.expiry.shifted && c.expiry.ruleDate ? `, moved from ${dayText(c.expiry.ruleDate, { weekday: true })}` : ""}` : "";
  const moved = c.movedTo && !c.holiday ? `expiry moved to ${dayText(c.movedTo, { weekday: true })}` : "";
  return [dayText(c.date, { weekday: true, year: true }), kind, exp, moved, c.today && c.inMonth ? "today" : ""].filter(Boolean).join(", ");
}

// ── Status strip (pure) ──

const DATASETS = [
  ["lots", "Lots"],
  ["ban", "Ban"],
  ["mwpl", "MWPL"],
  ["universe", "Universe"],
  ["holidays", "Holidays"],
  ["rate", "Rate"],
];
/**
 * One dataset's state word: "Current", "1 day old", "Stale", "Off", "Not fetched", "Parse failed" (spec §5.5). An
 * unavailable dataset carries `reason` (SOURCE_OFF, NEVER_FETCHED, PARSE_FAILED) from GET /v1/reference/status even
 * before any sync has run; `error.code` is only there after an attempt.
 */
export function stateWord(ds, { today = null } = {}) {
  if (!ds) return "Not fetched";
  const why = ds.available ? null : ds.reason ?? ds.error?.code ?? null;
  if (why === "SOURCE_OFF" || ds.error?.code === "SOURCE_OFF") return "Off";
  if (why === "PARSE_FAILED") return "Parse failed";
  if (!ds.available && !ds.asOf) return "Not fetched";
  if (ds.stale) return "Stale";
  const age = today && ds.asOf ? daysBetween(String(ds.asOf).slice(0, 10), today) : null;
  if (age !== null && age >= 1) return age === 1 ? "1 day old" : `${formatInt(age)} days old`;
  return "Current";
}
/** An IST timestamp ("2026-11-02T08:20:00.000+05:30") as "Mon 2 Nov 08:20 IST"; the raw text when it is not one. */
export function stampText(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso ?? ""));
  return m ? `${dayText(m[1], { weekday: true })} ${m[2]} IST` : String(iso ?? DASH);
}
/** The strip's tiles: [{ id, label, word, tone, asOf, source, detail }] from GET /v1/reference/status. */
export function statusTiles(status, { today = null } = {}) {
  const ds = status?.datasets ?? {};
  return DATASETS.map(([id, label]) => {
    const d = ds[id] ?? null;
    const word = id === "rate" && d?.quality === "default" ? "Default" : stateWord(d, { today });
    const tone = word === "Current" ? "ok" : word === "Off" || word === "Not fetched" ? "quiet" : word === "1 day old" ? "info" : "warn";
    const parts = [];
    if (d?.source) parts.push(`Source: ${d.source}`);
    if (d?.lastAttemptAt) parts.push(`Last attempt ${stampText(d.lastAttemptAt)}`);
    if (d?.nextRunAt) parts.push(`Next ${stampText(d.nextRunAt)}`);
    if (d?.error) parts.push(`Error: ${d.error.code ?? d.error}${d.error.detail ? ` (${d.error.detail})` : ""}`);
    return { id, label, word, tone, asOf: d?.asOf ?? null, source: d?.source ?? null, detail: parts.join(" · ") };
  });
}

/**
 * The consent copy for turning NSE archive downloads on (spec §7.2: name the files and how often, as the cli init
 * question does). `src` is GET /v1/reference/status's sources.nseArchives (host, schedule, dailyRequestCap).
 */
export function consentText(src) {
  const host = src?.host || "the NSE archives";
  const times = [src?.schedule?.morning, src?.schedule?.evening].filter((t) => /^\d{2}:\d{2}$/.test(String(t ?? "")));
  const when = times.length ? ` at ${times.join(" and ")} IST on trading days (one retry each if a file is late)` : " on trading days";
  const cap = Number(src?.dailyRequestCap) > 0 ? ` At most ${formatInt(src.dailyRequestCap)} requests a day, one every few seconds.` : "";
  return {
    title: "Download NSE's public F&O files?",
    lead: `The Bridge will download NSE's public F&O reference files from ${host}, about twice a day${when}:`,
    files: ["Market lots (fo_mktlots.csv): lot sizes and the F&O universe", "Ban list (fo_secban_DDMMYYYY.csv): stocks in the ban period", "Combined OI (combineoi_DDMMYYYY.zip): market-wide position limits (MWPL)"],
    tail: `Nothing else is sent: no account, key or order data.${cap} You can turn this off again on this page.`,
  };
}

// ── CSV (pure) ──

const csvCell = (v) => {
  // A text cell starting with = + - @ (or a tab / CR) would run as a formula in a spreadsheet: a leading ' keeps it
  // text. Numbers (a negative figure included) are written as they are.
  const raw = v === null || v === undefined ? "" : String(v);
  const s = typeof v !== "number" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Rows as CSV text: a header line, then one line per row (quoted where needed). Columns are [header, value(row)]. */
export function toCsv(columns, rows) {
  return [columns.map((c) => csvCell(c[0])).join(","), ...(rows ?? []).map((r) => columns.map((c) => csvCell(c[1](r))).join(","))].join("\n");
}
/** Each panel's CSV columns (raw values: dates as YYYY-MM-DD, rates as decimals, quantities in units). */
export const CSV_COLUMNS = Object.freeze({
  calendar: [["date", (r) => r.date], ["trading_day", (r) => (r.trading ? "yes" : "no")], ["holiday", (r) => r.holiday?.label ?? ""], ["holiday_verified", (r) => (r.holiday ? (r.holiday.verified ? "yes" : "no") : "")], ["special_session", (r) => r.special?.label ?? ""], ["expiry", (r) => r.expiry?.kind ?? ""], ["expiry_moved_from", (r) => (r.expiry?.shifted ? r.expiry.ruleDate ?? "" : "")]],
  expiries: [["date", (r) => r.date], ["kind", (r) => r.kind], ["lot", (r) => r.lot ?? ""], ["shifted", (r) => (r.shifted ? "yes" : "no")], ["usual_date", (r) => r.ruleDate ?? ""], ["source", (r) => r.source ?? ""]],
  lots: [["expiry_month", (r) => r.expiryMonth], ["lot", (r) => r.lot], ["effective_from", (r) => r.effectiveFrom ?? ""], ["last_old_expiry", (r) => r.lastOldExpiry ?? ""], ["source", (r) => r.source ?? ""]],
  mwpl: [["symbol", (r) => r.symbol], ["mwpl_pct", (r) => r.mwplPct ?? ""], ["band", (r) => r.band ?? ""], ["oi", (r) => r.oi ?? ""], ["mwpl", (r) => r.mwpl ?? ""], ["limit_next_day", (r) => r.limitNextDay ?? ""]],
  universe: [["symbol", (r) => r.symbol], ["kind", (r) => r.kind], ["exchange", (r) => r.exchange], ["since", (r) => r.since ?? ""], ["since_is_first_fetch", (r) => (r.sinceIsFirstFetch ? "yes" : "no")]],
  actions: [["id", (r) => r.id], ["symbol", (r) => r.symbol], ["type", (r) => r.type], ["ratio", (r) => (r.ratio ? `${r.ratio.new}:${r.ratio.held}` : "")], ["ex_date", (r) => r.exDate ?? ""], ["factor", (r) => r.factor ?? ""], ["origin", (r) => r.origin], ["verified", (r) => (r.verified ? "yes" : "no")], ["source", (r) => r.source ?? ""]],
  charges: [["item", (r) => r.k], ["value", (r) => r.raw], ["unit", (r) => r.unit]],
});

// ── Ban / MWPL, universe, corporate-action preview (pure) ──

/** The MWPL table: filter by `query` (symbol prefix, any case), sort by "pct" (high first) or "symbol". */
export function mwplView(items, { query = "", sort = "pct" } = {}) {
  const q = String(query ?? "").trim().toUpperCase();
  const rows = (items ?? []).filter((r) => !q || String(r.symbol).toUpperCase().includes(q));
  return rows.sort(sort === "symbol" ? (a, b) => String(a.symbol).localeCompare(String(b.symbol)) : (a, b) => (num(b.mwplPct) ?? -1) - (num(a.mwplPct) ?? -1) || String(a.symbol).localeCompare(String(b.symbol)));
}
/** What the universe panel says for a date: coverage, count and the "not recorded" line (spec §1.3, §6.8). */
export function universeNote(u) {
  if (!u) return { recorded: false, text: "Membership not loaded" };
  if (u.coverage === "not-recorded") return { recorded: false, text: `Not recorded on this Bridge before ${dayText(u.knownSince, { year: true })}` };
  return { recorded: true, text: `${formatInt(u.count ?? u.items?.length ?? 0)} underlyings on ${dayText(u.date, { year: true })}${u.knownSince ? ` · recorded since ${dayText(u.knownSince, { year: true })}` : ""}` };
}
/**
 * The body for POST /v1/reference/corporate-actions/preview from the add form's values, or { error } when a needed
 * field is missing. Strikes are the five around the last price on the stock's strike step.
 */
export function previewBody(f) {
  const type = String(f?.type ?? "");
  const body = { type, strikeTick: 0.05 };
  const lot = num(f?.lot);
  if (lot !== null && lot > 0) body.lot = Math.round(lot);
  const strikes = (f?.strikes ?? []).map(num).filter((k) => k !== null && k > 0);
  if (strikes.length) body.strikes = strikes;
  if (type === "bonus" || type === "rights") {
    const n = num(f?.ratioNew);
    const d = num(f?.ratioHeld);
    if (!(n > 0) || !(d > 0)) return { error: "Enter the ratio (new for held)." };
    body.ratio = { new: n, held: d };
  }
  if (type === "rights") {
    if (!(num(f?.subscriptionPrice) > 0) || !(num(f?.cumPrice) > 0)) return { error: "Enter the subscription price and the cum price." };
    body.subscriptionPrice = num(f.subscriptionPrice);
    body.cumPrice = num(f.cumPrice);
  }
  if (type === "split" || type === "consolidation") {
    if (!(num(f?.fvFrom) > 0) || !(num(f?.fvTo) > 0)) return { error: "Enter the face value before and after." };
    body.fv = { from: num(f.fvFrom), to: num(f.fvTo) };
  }
  if (type === "dividend") {
    if (!(num(f?.dividend) > 0) || !(num(f?.cumPrice) > 0)) return { error: "Enter the dividend and the cum price." };
    body.dividend = num(f.dividend);
    body.cumPrice = num(f.cumPrice);
  }
  if (!["bonus", "rights", "split", "consolidation", "dividend"].includes(type)) return { error: "Choose the action type." };
  return { body };
}
/**
 * Five strikes around `price` on `step` (default: 20 from 2,000, 10 from 500, else 5: the server's exampleStrikeGrid
 * rule, so the add form's preview and the saved card show the same strikes).
 */
export function strikesAround(price, step = null) {
  const p = num(price);
  if (p === null || p <= 0) return [];
  const st = num(step) ?? (p >= 2000 ? 20 : p >= 500 ? 10 : 5);
  const atm = Math.round(p / st) * st;
  return [-2, -1, 0, 1, 2].map((i) => atm + i * st).filter((k) => k > 0);
}
/** Run the preview through `post` (api by default). Resolves { data } or { error }. */
export async function runPreview(form, { post = (body) => api("/v1/reference/corporate-actions/preview", { method: "POST", body }).then((r) => r.data.data) } = {}) {
  const b = previewBody(form);
  if (b.error) return { error: b.error };
  try {
    return { data: await post(b.body) };
  } catch (err) {
    return { error: err?.message ?? "Preview failed" };
  }
}

/** The charge table as rows for the panel: [{ k, v, raw, unit }]. */
export function chargeRows(c) {
  if (!c?.opt) return [];
  const pct = (v) => `${formatFixed(v * 100, 4).replace(/0+$/, "").replace(/\.$/, "")} %`;
  return [
    { k: "STT, options (sale side, on premium)", v: pct(c.opt.sttSell), raw: c.opt.sttSell, unit: "of premium" },
    { k: "STT, exercised in-the-money long options", v: pct(c.opt.exerciseStt), raw: c.opt.exerciseStt, unit: "of intrinsic value" },
    { k: "STT, futures (sale side)", v: pct(c.fut.sttSell), raw: c.fut.sttSell, unit: "of value" },
    { k: "Exchange charge, NSE options", v: pct(c.opt.txn.NSE), raw: c.opt.txn.NSE, unit: "of premium" },
    { k: "Exchange charge, BSE options", v: pct(c.opt.txn.BSE), raw: c.opt.txn.BSE, unit: "of premium" },
    { k: "Exchange charge, NSE futures", v: pct(c.fut.txn.NSE), raw: c.fut.txn.NSE, unit: "of value" },
    { k: "Stamp duty, options (purchase side)", v: pct(c.opt.stampBuy), raw: c.opt.stampBuy, unit: "of premium" },
    { k: "Stamp duty, futures (purchase side)", v: pct(c.fut.stampBuy), raw: c.fut.stampBuy, unit: "of value" },
    { k: "SEBI fee", v: `${formatRupee(c.sebiPerCrore, 0)} per crore`, raw: c.sebiPerCrore, unit: "rupees per crore" },
    { k: "IPFT", v: `${formatRupee(c.ipftPerCrore, 0)} per crore`, raw: c.ipftPerCrore, unit: "rupees per crore" },
    { k: "GST", v: pct(c.gst), raw: c.gst, unit: "of brokerage + exchange + SEBI" },
    { k: "Brokerage (default)", v: `${formatRupee(c.brokerage?.perOrder, 0)} per order`, raw: c.brokerage?.perOrder ?? "", unit: c.brokerage?.kind ?? "flat" },
  ];
}

/** True when the dashboard is opened on the Bridge's own computer (the admin writes are loopback-only anyway). */
const onThisComputer = () => typeof location !== "undefined" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);

// ── Method notes ("?" per panel, spec §5.5 K3) ──
const METHODS = {
  calendar: "A trading day is a weekday that is not on the holiday list for the exchange, or a day with a special session whose times are set. Holidays come from the shipped NSE / BSE list (unverified rows say so) plus your config. An expiry on an unusual weekday is explained when the usual weekday (the most common one among the listed expiries) is a holiday; the listed date always decides.",
  expiries: "Expiries come from the broker master. Monthly = the last listed expiry of its calendar month. The lot is a property of the contract's expiry month (NSE market lots file). A new lot takes effect on the trading day after the last expiry with the old lot.",
  ban: "MWPL % = 100 × combined open interest ÷ market-wide position limit (both in shares, NSE combined OI file, end of day). Band: in ban when the stock is on NSE's ban list for the date; high at 80 % or more (a display band, not an exchange status); else normal. The exchange rule (enter above 95 %, leave below 80 %) needs verification.",
  universe: "F&O membership by date is recorded from the first market lots file this Bridge fetched. Earlier dates are not recorded here, so they are never filled with today's list.",
  actions: "Adjustment factor: bonus a:b → (a + b) ÷ b; split or consolidation → old face value ÷ new; rights a:b at S with cum price P → P ÷ TERP, TERP = (b·P + a·S) ÷ (a + b). Adjusted strike = strike ÷ factor, rounded to the tick; adjusted lot = lot × factor, rounded (a fraction marks a non-standard contract). An extraordinary dividend D lowers strikes by D. The exchange method needs verification against each circular.",
  // The default's value comes from the Bridge (or REF_DEFAULTS when it cannot be read): never written here.
  rate: (def) => `The risk-free rate discounts option prices and carries the forward (put-call parity). Enter the 91-day T-bill or your preferred rate, with where it came from. Without one, the pages use ${formatFixed(def * 100, 2)} % and say it is a default.`,
  charges: "Statutory charges per order. Brokerage here is the default; plans per account are separate. Check your broker's contract note.",
};

// ── Page ──

/** The Market calendar page. */
export async function renderCalendarPage() {
  const list = app.state.demo ? DEMO_UNDERLYINGS : UNDERLYINGS;
  let saved = {};
  try {
    saved = JSON.parse(app.local.get(SLOT) ?? "{}") ?? {};
  } catch {
    saved = {};
  }
  let desk = {};
  try {
    desk = JSON.parse(app.local.get("mcb.dashboard.desk") ?? "{}") ?? {};
  } catch {
    desk = {};
  }
  const today = istDate(Date.now());
  const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;
  const st = {
    underlying: list.includes(saved.underlying) ? saved.underlying : list.includes(desk.underlying) ? desk.underlying : list[0],
    month: /^\d{4}-\d{2}$/.test(saved.month ?? "") && Math.abs(daysBetween(`${saved.month}-01`, `${today.slice(0, 7)}-01`) ?? 999) < 400 ? saved.month : today.slice(0, 7),
    mwplQuery: "",
    mwplSort: "pct",
    mwplAll: false,
    uniDate: today,
    ref: null,
  };
  const save = () => app.local.set(SLOT, JSON.stringify({ underlying: st.underlying, month: st.month }));
  const get = (path) => optional(api(path)).then((r) => (r.error ? { error: r.error } : { data: r.data?.data ?? null }));
  const data = { status: null, holidays: null, specials: [], expiries: null, lots: null, ban: null, mwpl: null, universe: null, actions: null, rate: null, charges: null, events: null };
  /** The default rate's value: the Bridge's when it reports its default, else the dashboard fallback. */
  const defaultRate = () => (data.rate?.data?.quality === "default" && Number.isFinite(data.rate.data.value) ? data.rate.data.value : REF_DEFAULTS.rate.value);

  // ── Top bar: the underlying (for expiries and lots) and its reference chip ──
  const uSel = h("select", { "aria-label": "Underlying", class: "desk-u" }, list.map((u) => h("option", { value: u, selected: u === st.underlying }, u)));
  const uMain = document.createTextNode(st.underlying);
  const uItem = h("label", { class: "ctx-item ctx-pick ctx-u", title: "Underlying" }, h("span", { class: "ctx-main" }, uMain), h("span", { class: "ctx-sub", "aria-hidden": "true" }, "Expiries and lots"), uSel);
  const chip = refChip({ getBundle: () => st.ref });
  mountToolbarCtx("calendar", h("div", { class: "ctx-cap glass" }, uItem), chip.el, h("span", { class: "ctx-spacer" }));
  uSel.addEventListener("change", () => {
    st.underlying = uSel.value;
    uMain.data = st.underlying;
    save();
    loadUnderlying();
    drawEvents();
  });

  // ── Panel shell ──
  function panel(id, title, sub, { csv = null, extra = [] } = {}) {
    const subEl = h("span", { class: "cal-sub" }, sub ?? "");
    const help = h("button", { type: "button", class: "icon-btn tiny cal-help", "aria-label": `How ${title.toLowerCase()} is read`, title: "Method" }, h("span", { "aria-hidden": "true" }, "?"));
    help.addEventListener("click", () => {
      const m = METHODS[id] ?? "";
      sheetPopover({ trigger: help, title, body: h("p", { class: "cal-method" }, typeof m === "function" ? m(defaultRate()) : m) });
    });
    const csvBtn = csv ? h("button", { type: "button", class: "small cal-csv", title: "Download as CSV", "aria-label": "Download as CSV" }, icon("external"), h("span", { class: "cal-csv-t" }, "CSV")) : null;
    csvBtn?.addEventListener("click", () => {
      const rows = csv.rows();
      if (!rows.length) return toast("Nothing to export yet", { tone: "info" });
      download(`${csv.name}-${today}.csv`, toCsv(CSV_COLUMNS[csv.cols], rows));
    });
    const body = h("div", { class: "cal-body" });
    const acts = h("div", { class: "cal-acts" }, ...extra.filter(Boolean), csvBtn, help);
    const el = h("section", { class: `desk-panel cal-panel calp-${id}`, "data-panel": `cal-${id}`, "aria-label": title }, h("header", { class: "panel-head cal-head" }, h("div", { class: "cal-titles" }, h("h2", {}, title), subEl), acts), body);
    return { el, body, sub: subEl, acts };
  }
  function download(name, text) {
    try {
      const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      const a = h("a", { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch {
      toast("This browser could not save the file", { tone: "error" });
    }
  }
  const loading = (label) => h("p", { class: "cal-loading muted small" }, label);
  // A failed read shows one page-level alert with Retry (drawPageAlert); each panel only says it is unavailable.
  const fail = () => (queueMicrotask(drawPageAlert), h("p", { class: "cal-unavail muted small" }, "Unavailable: see the notice above."));
  const pageAlert = h("div", { class: "cal-page-alert", hidden: true });
  let retrying = false;
  function drawPageAlert() {
    const err = [data.status, data.holidays, data.expiries, data.lots, data.ban, data.mwpl, data.universe, data.actions, data.rate, data.charges, data.events].find((x) => x?.error)?.error ?? null;
    pageAlert.hidden = !err;
    if (!err) return fill(pageAlert);
    const retry = h("button", { type: "button", class: "small", disabled: retrying }, icon("refresh"), retrying ? "Retrying" : "Retry");
    retry.addEventListener("click", async () => {
      retrying = true;
      drawPageAlert();
      clearReferenceCache();
      try {
        await loadAll();
      } finally {
        retrying = false;
        drawPageAlert();
      }
    });
    // No broker logged in is the usual cause: a caution with the way out, not a red failure.
    const needsLogin = ["SYMBOL_NOT_FOUND", "NO_ACCOUNT", "BROKER_UNAVAILABLE", "SESSION_EXPIRED"].includes(err?.code);
    const login = needsLogin ? h("button", { type: "button", class: "small primary", onclick: () => (location.hash = "#/accounts") }, "Log in on Accounts") : null;
    fill(pageAlert, h("div", { class: "cal-page-alert-row" }, alertBox(err, needsLogin ? "warn" : "bad"), login, retry));
  }

  // ── 0. Banners: everything within 7 days, every underlying (the Options pages show their own) ──
  const banners = refBanners({ onMore: () => chip.open() });

  // ── 1. Status strip ──
  const statusEl = h("section", { class: "desk-panel cal-status", "data-panel": "cal-status", "aria-label": "Reference data status" });
  function drawStatus() {
    const s = data.status;
    if (!s) return fill(statusEl, loading("Reading the status of each dataset"));
    if (s.error) return fill(statusEl, fail(s.error));
    const tiles = statusTiles(s.data, { today });
    const off = !s.data.demo && s.data.sources?.nseArchives?.enabled === false;
    const tilesEl = h(
      "div",
      { class: "cal-tiles", role: "list" },
      tiles.map((t) => {
        const b = h("button", { type: "button", class: `cal-tile ${t.tone}`, "aria-haspopup": "dialog", "aria-label": `${t.label}: ${t.word}${t.asOf ? `, as of ${dayText(t.asOf)}` : ""}` }, h("span", { class: "cal-tile-k" }, t.label), h("strong", { class: "cal-tile-v" }, t.word), h("small", {}, t.asOf ? dayText(String(t.asOf).slice(0, 10)) : DASH));
        b.addEventListener("click", () => sheetPopover({ trigger: b, title: `${t.label}: ${t.word}`, body: h("p", { class: "cal-method" }, t.detail || "No details recorded yet.") }));
        // The list item wraps the button, so the button keeps its own role (an explicit role would replace it).
        return h("div", { role: "listitem", class: "cal-tile-li" }, b);
      }),
    );
    const notice = off
      ? h(
          "div",
          { class: "cal-off" },
          icon("info"),
          h("p", {}, "NSE archive downloads are off. Lot sizes come from your broker's master; ban list, MWPL and universe history are unavailable."),
          onThisComputer() ? h("button", { type: "button", class: "small", onclick: (e) => turnOn(e.currentTarget, s.data.sources?.nseArchives) }, "Turn on") : null,
        )
      : null;
    const on = !s.data.demo && s.data.sources?.nseArchives?.enabled === true;
    const lead = h(
      "div",
      { class: "cal-status-lead" },
      h("span", { class: "cal-status-k" }, s.data.demo ? "Demo reference data" : "Reference data"),
      h("small", {}, s.data.knownSince ? `Recorded since ${dayText(s.data.knownSince, { year: true })}` : ""),
      on && onThisComputer() ? h("button", { type: "button", class: "small plain cal-src-off", onclick: (e) => turnOff(e.currentTarget) }, "Turn off NSE downloads") : null,
    );
    fill(statusEl, h("div", { class: "cal-status-row" }, lead, tilesEl), notice, s.data.demo && onThisComputer() ? demoStaleSwitch(Boolean(s.data.demoLotsStale)) : null);
  }
  /**
   * Demo only (spec §4): report the demo lot data as two trading days old, so the stale warning, the chip's "Stale"
   * and the order ticket's lot-size check can be seen from the dashboard (PUT /v1/demo/reference, this computer only).
   */
  function demoStaleSwitch(on) {
    const box = h("input", { type: "checkbox", role: "switch" });
    box.checked = on;
    box.addEventListener("change", async () => {
      box.disabled = true;
      const r = await optional(api("/v1/demo/reference", { method: "PUT", body: { lotsStale: box.checked } }));
      box.disabled = false;
      if (r.error) {
        box.checked = !box.checked;
        return toast(r.error.message ?? "Could not change the demo lot data", { tone: "error" });
      }
      toast(box.checked ? "Demo lot data now reads as two trading days old on every page" : "Demo lot data is current again");
      clearReferenceCache();
      loadStatus();
      loadUnderlying();
    });
    return h("label", { class: "check cal-demo-stale" }, box, h("span", {}, "Show stale lot data ", h("small", {}, "demo: lots read as two trading days old, so the warning and the ticket's lot-size check appear")));
  }
  async function turnOn(btn, src) {
    // Nothing is fetched until the user has read what will be fetched, from where and how often (spec §7.2).
    const c = consentText(src);
    const ok = await modal({
      title: c.title,
      body: h("div", { class: "stack cal-consent" }, h("p", {}, c.lead), h("ul", { class: "cal-consent-files" }, c.files.map((f) => h("li", {}, f))), h("p", { class: "muted small" }, c.tail)),
      buttons: [
        { label: "Cancel", cls: "plain", value: false },
        { label: "Turn on downloads", cls: "primary", value: true },
      ],
    });
    if (ok !== true) return;
    btn.disabled = true;
    const r = await optional(api("/v1/reference/sources", { method: "PUT", body: { nseArchives: true } }));
    btn.disabled = false;
    if (r.error) return toast(r.error.message ?? "Could not turn it on", { tone: "error" });
    toast("NSE archive downloads are on: the first sync starts shortly");
    clearReferenceCache();
    loadAll();
  }

  async function turnOff(btn) {
    btn.disabled = true;
    const r = await optional(api("/v1/reference/sources", { method: "PUT", body: { nseArchives: false } }));
    btn.disabled = false;
    if (r.error) return toast(r.error.message ?? "Could not turn it off", { tone: "error" });
    toast("NSE archive downloads are off");
    clearReferenceCache();
    loadAll();
  }

  // ── 2. Month calendar ──
  const cal = panel("calendar", "Calendar", "", { csv: { name: "calendar", cols: "calendar", rows: () => monthGrid(st.month, gridData()).flat().filter((c) => c.inMonth) } });
  const monthLabel = h("strong", { class: "cal-month" });
  const prevBtn = h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Previous month" }, icon("chevron"));
  const nextBtn = h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Next month" }, icon("chevron"));
  prevBtn.classList.add("flip");
  const todayBtn = h("button", { type: "button", class: "small", title: "This month" }, "Today");
  prevBtn.addEventListener("click", () => setMonth(addMonths(st.month, -1)));
  nextBtn.addEventListener("click", () => setMonth(addMonths(st.month, 1)));
  todayBtn.addEventListener("click", () => setMonth(today.slice(0, 7)));
  const monthNav = h("div", { class: "cal-nav" }, prevBtn, monthLabel, nextBtn, todayBtn);
  const legendEl = h("div", { class: "cal-legend", "aria-hidden": "true" }, h("span", { class: "lg hol" }, "Holiday"), h("span", { class: "lg spe" }, "Special session"), h("span", { class: "lg exw" }, "Weekly expiry"), h("span", { class: "lg exm" }, "Monthly expiry"), h("span", { class: "lg mov" }, "Moved expiry"));
  const gridHost = h("div", { class: "cal-grid-host" });
  cal.body.append(monthNav, gridHost, legendEl);
  const gridData = () => ({ holidays: data.holidays?.data?.items ?? [], expiries: data.expiries?.data?.expiries ?? [], specials: data.specials, today });
  // Quick prev / next clicks only fetch the month the user stops on (and a late answer for a month already left is
  // dropped in loadMonth).
  let monthTimer = null;
  function setMonth(ym) {
    st.month = ym;
    save();
    data.holidays = null;
    data.specials = [];
    drawCalendar();
    clearTimeout(monthTimer);
    monthTimer = setTimeout(loadMonth, 250);
  }
  function drawCalendar() {
    monthLabel.textContent = monthText(st.month);
    cal.sub.textContent = `${st.underlying} expiries · NSE holidays`;
    if (!data.holidays) return fill(gridHost, loading("Loading the holiday list"));
    if (data.holidays.error) return fill(gridHost, fail(data.holidays.error));
    const weeks = monthGrid(st.month, gridData());
    const phone = isPhone();
    // The legend's swatches belong to the grid; the phone list says each kind in words.
    legendEl.hidden = phone;
    if (phone) {
      const items = monthList(weeks);
      fill(gridHost, 
        items.length
          ? h(
              "ul",
              { class: "cal-list" },
              items.map((it) => h("li", { class: it.today ? "today" : undefined }, h("span", { class: "cal-list-d" }, h("strong", {}, dayText(it.date).split(" ")[0]), h("small", {}, dayText(it.date, { weekday: true }).split(" ")[0])), h("span", { class: "cal-list-n" }, it.notes.map((n) => h("span", { class: `cal-note ${n.kind}` }, n.text))))),
            )
          : h("p", { class: "muted small cal-none" }, `No holidays, special sessions or ${st.underlying} expiries in ${monthText(st.month)}.`),
      );
      return;
    }
    const table = h(
      "table",
      { class: "cal-grid" },
      h("caption", { class: "sr-only" }, `${monthText(st.month)}: holidays, special sessions and ${st.underlying} expiries`),
      h("thead", {}, h("tr", {}, WEEK.map((d, i) => h("th", { scope: "col", class: i >= 5 ? "we" : undefined }, d)))),
      h(
        "tbody",
        {},
        weeks.map((w) =>
          h(
            "tr",
            {},
            w.map((c) => {
              const cls = ["cal-cell", c.inMonth ? "" : "out", c.weekend ? "we" : "", c.holiday ? "hol" : "", c.special ? "spe" : "", c.expiry ? (c.expiry.kind === "monthly" ? "exm" : "exw") : "", c.today && c.inMonth ? "today" : ""].filter(Boolean).join(" ");
              const ms = c.inMonth ? cellMarks(c) : [];
              const marks = ms.map((m) => h("span", { class: `cal-mark ${m.kind}`, title: m.full }, m.text));
              // A day with marks opens a small sheet with every mark in full (touch screens have no tooltip).
              const td = h("td", { class: `${cls}${ms.length ? " has-marks" : ""}`, "aria-label": c.inMonth ? cellLabel(c) : undefined, tabindex: ms.length ? "0" : undefined, "aria-haspopup": ms.length ? "dialog" : undefined }, h("span", { class: "cal-day" }, formatInt(c.day)), c.inMonth ? marks : null);
              if (ms.length) {
                const open = () => sheetPopover({ trigger: td, title: dayText(c.date, { weekday: true, year: true }), body: h("ul", { class: "cal-cell-sheet" }, ms.filter((m) => m.kind !== "spe-t" && m.kind !== "hol-u").map((m) => h("li", {}, m.full))), cls: "cal-cell-pop" });
                td.addEventListener("click", open);
                td.addEventListener("keydown", (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                  }
                });
              }
              return td;
            }),
          ),
        ),
      ),
    );
    fill(gridHost, table);
  }

  // ── 3. Expiries and lots ──
  const exp = panel("expiries", "Expiries and lots", "", { csv: { name: "expiries", cols: "expiries", rows: () => data.expiries?.data?.expiries ?? [] } });
  function drawExpiries() {
    exp.sub.textContent = st.underlying;
    const e = data.expiries;
    const l = data.lots;
    if (!e || !l) return fill(exp.body, loading(`Loading ${st.underlying} expiries`));
    if (e.error) return fill(exp.body, fail(e.error));
    const rows = e.data?.expiries ?? [];
    // The lots read can fail on its own: say so in the head rather than show "Lot now --" as if there were no lot.
    const lotsFailed = l.error ? fail(l.error) : null;
    const freeze = l.data?.freeze ?? null;
    const fq = num(freeze?.freezeQty);
    const head = h(
      "div",
      { class: "cal-kv" },
      kv("Lot now", l.data?.current ? `${formatInt(l.data.current)} units` : DASH, l.data?.stale ? "Stale" : l.data?.asOf ? `as of ${dayText(l.data.asOf)}` : ""),
      kv("Next lot", l.data?.next?.from && l.data.next.lot !== l.data.current ? `${formatInt(l.data.next.lot)} from ${dayText(l.data.next.from)}` : "No change listed", ""),
      kv("Freeze qty", fq === null ? "Unknown" : `${formatInt(fq)} units`, fq === null ? "slicing is not checked" : `${freeze.source === "exchange-list" ? "exchange list" : freeze.source ?? ""}${freeze.verified ? "" : " · unverified"}`),
      kv("Source", e.data?.source ?? DASH, e.data?.asOf ? dayText(e.data.asOf) : ""),
    );
    const table = rows.length
      ? h(
          "div",
          { class: "cal-scroll" },
          h(
            "table",
            { class: "cal-table" },
            h("thead", {}, h("tr", {}, ["Expiry", "Kind", "Lot", "Freeze", "Note"].map((t, i) => h("th", { scope: "col", class: i === 2 || i === 3 ? "num" : undefined }, t)))),
            h(
              "tbody",
              {},
              rows.map((r) => h("tr", {}, h("th", { scope: "row" }, dayText(r.date, { weekday: true })), h("td", {}, h("span", { class: `cal-kind ${r.kind}` }, r.kind === "monthly" ? "Monthly" : "Weekly")), h("td", { class: "num" }, r.lot ? formatInt(r.lot) : DASH), h("td", { class: "num" }, fq === null ? DASH : formatInt(fq)), h("td", { class: "wrap" }, r.shifted ? `Moved from ${dayText(r.ruleDate, { weekday: true })}: ${dayText(r.ruleDate)} is a holiday` : ""))),
            ),
          ),
        )
      : emptyState("calendar", "No expiries listed", `No ${st.underlying} contracts in the broker master.`, null, { compact: true });
    const hist = l.data?.history ?? [];
    const histEl = hist.length
      ? h(
          "div",
          { class: "cal-lots" },
          h("h3", {}, "Lot history ", h("small", {}, "by expiry month")),
          h(
            "ol",
            { class: "cal-lot-steps" },
            hist.map((x, i) => {
              const changed = i > 0 && hist[i - 1].lot !== x.lot;
              return h("li", { class: changed ? "chg" : undefined, title: x.effectiveFrom ? `Lot ${x.lot} from ${dayText(x.effectiveFrom, { year: true })} (last old expiry ${dayText(x.lastOldExpiry)})` : `Lot ${x.lot}` }, h("span", { class: "m" }, monthText(x.expiryMonth).replace(" 20", " ’")), h("strong", {}, formatInt(x.lot)), changed && x.effectiveFrom ? h("small", {}, `from ${dayText(x.effectiveFrom)}`) : null);
            }),
          ),
        )
      : null;
    fill(exp.body, lotsFailed, head, table, histEl);
  }
  function kv(k, v, sub) {
    return h("div", { class: "cal-kv-i" }, h("span", { class: "k" }, k), h("strong", {}, v), sub ? h("small", {}, sub) : null);
  }

  // ── 4. Ban list and MWPL ──
  const sortSeg = segmented("Sort MWPL by", [["pct", "MWPL %"], ["symbol", "Symbol"]], st.mwplSort);
  sortSeg.addEventListener("change", () => {
    st.mwplSort = sortSeg.value;
    drawBan();
  });
  const MWPL_TOP = 12;
  const search = h("input", { type: "search", class: "cal-search", placeholder: "Symbol", "aria-label": "Find a symbol", autocomplete: "off", spellcheck: "false" });
  search.addEventListener("input", () => {
    st.mwplQuery = search.value;
    drawBan();
  });
  const ban = panel("ban", "Ban list and MWPL", "", { csv: { name: "mwpl", cols: "mwpl", rows: () => mwplView(data.mwpl?.data?.items ?? [], { query: st.mwplQuery, sort: st.mwplSort }) } });
  const banTop = h("div", { class: "cal-ban-top" });
  const banTools = h("div", { class: "cal-tools" }, search, sortSeg);
  const mwplHost = h("div", { class: "cal-scroll cal-mwpl" });
  ban.body.append(banTop, banTools, mwplHost);
  function drawBan() {
    const b = data.ban;
    const m = data.mwpl;
    banTools.hidden = true;
    if (!b || !m) return (fill(mwplHost), fill(banTop, loading("Loading the ban list")));
    if (b.error) return (fill(mwplHost), fill(banTop, fail(b.error)));
    const bd = b.data;
    ban.sub.textContent = bd?.forDate ? `for ${dayText(bd.forDate)}` : "";
    if (!bd?.available) {
      fill(banTop, h("p", { class: "muted small" }, bd?.reason === "SOURCE_OFF" ? "Unavailable: NSE archive downloads are off." : "Unavailable: not fetched yet."));
      banTools.hidden = true;
      fill(mwplHost);
      return;
    }
    banTools.hidden = false;
    fill(banTop, 
      h("div", { class: "cal-ban-list" }, h("span", { class: "k" }, `In ban (${formatInt(bd.items.length)})`), bd.items.length ? bd.items.map((x) => h("span", { class: "cal-ban-chip" }, h("strong", {}, x.symbol), num(x.mwplPct) !== null ? ` ${formatFixed(x.mwplPct, 1)} %` : "")) : h("span", { class: "muted" }, "None")),
      h("p", { class: "cal-note-line" }, `In ban: no fresh positions; closing is allowed. Source: ${bd.source === "demo" ? "demo data" : "NSE combined OI"}, end of day ${dayText(m.data?.asOf ?? bd.asOf)}.`),
    );
    if (m.error) {
      // The ban list read but MWPL did not: the table is unavailable, not an empty search result.
      banTools.hidden = true;
      return fill(mwplHost, fail(m.error));
    }
    const rows = mwplView(m.data?.items ?? [], { query: st.mwplQuery, sort: st.mwplSort });
    // The top rows, then one row button for the rest: the page scrolls, never a second scroll box inside the panel.
    const shown = st.mwplAll ? rows : rows.slice(0, MWPL_TOP);
    const toggle = (all) => () => {
      st.mwplAll = all;
      drawBan();
    };
    const more =
      rows.length > MWPL_TOP
        ? h("tfoot", {}, h("tr", {}, h("td", { colspan: "4" }, h("button", { type: "button", class: "small quiet cal-more", "aria-expanded": String(st.mwplAll), onclick: toggle(!st.mwplAll) }, st.mwplAll ? `Show the top ${formatInt(MWPL_TOP)}` : `Show all ${formatInt(rows.length)}`))))
        : null;
    fill(mwplHost, 
      rows.length
        ? h(
            "table",
            { class: "cal-table cal-mwpl-t" },
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Symbol"), h("th", { scope: "col", class: "num" }, "MWPL %"), h("th", { scope: "col", class: "bar-col" }, h("span", { class: "sr-only" }, "Share of the limit")), h("th", { scope: "col" }, "Band"))),
            h(
              "tbody",
              {},
              shown.map((r) => {
                const p = num(r.mwplPct);
                const bar = h("span", { class: `cal-bar ${r.band ?? "normal"}`, "aria-hidden": "true" });
                bar.style.setProperty("--w", `${Math.max(0, Math.min(100, p ?? 0))}%`);
                return h("tr", { class: r.band === "ban" ? "ban" : undefined }, h("th", { scope: "row" }, r.symbol), h("td", { class: "num" }, p === null ? DASH : formatFixed(p, 1)), h("td", { class: "bar-col" }, h("span", { class: "cal-track" }, bar)), h("td", {}, h("span", { class: `cal-band ${r.band ?? "normal"}` }, r.band === "ban" ? "In ban" : r.band === "high" ? "High" : "Normal")));
              }),
            ),
            more,
          )
        : h("p", { class: "muted small pad" }, `No symbol matches "${st.mwplQuery}".`),
    );
  }

  // ── 5. F&O universe ──
  const dateIn = h("input", { type: "date", class: "cal-date", value: st.uniDate, max: today, "aria-label": "Membership on" });
  dateIn.addEventListener("change", () => {
    if (!ISO_DAY.test(dateIn.value)) return;
    st.uniDate = dateIn.value;
    loadUniverse();
  });
  const uni = panel("universe", "F&O universe", "", { csv: { name: "fno-universe", cols: "universe", rows: () => data.universe?.data?.items ?? [] }, extra: [dateIn] });
  // Phones: the date picker gets a full-width row in the panel body ("Membership on [date]"), so the header keeps
  // only CSV and "?" like the other panels. Wider screens keep it in the header.
  const uniDateRow = h("label", { class: "field cal-uni-date" }, h("span", {}, "Membership on"));
  function placeDate() {
    if (isPhone()) {
      if (dateIn.parentElement !== uniDateRow) uniDateRow.append(dateIn);
      dateIn.removeAttribute("aria-label");
      return uniDateRow;
    }
    if (dateIn.parentElement !== uni.acts) uni.acts.prepend(dateIn);
    dateIn.setAttribute("aria-label", "Membership on");
    return null;
  }
  function drawUniverse() {
    const u = data.universe;
    const dateRow = placeDate();
    if (!u) return fill(uni.body, dateRow, loading("Loading membership"));
    if (u.error) return fill(uni.body, dateRow, fail(u.error));
    const note = universeNote(u.data);
    uni.sub.textContent = note.recorded ? `${formatInt(u.data.count ?? 0)} on ${dayText(u.data.date)}` : "";
    const changes = u.data?.changes ?? [];
    const stocks = (u.data?.items ?? []).filter((x) => x.kind === "stock").length;
    const idx = (u.data?.items ?? []).filter((x) => x.kind === "index").length;
    fill(uni.body, 
      dateRow,
      h("p", { class: note.recorded ? "cal-note-line" : "cal-note-line quiet" }, note.text),
      note.recorded ? h("div", { class: "cal-kv" }, kv("Stocks", formatInt(stocks), ""), kv("Indices", formatInt(idx), ""), kv("Recorded since", dayText(u.data.knownSince, { year: true }), "")) : null,
      h("h3", {}, "Changes ", h("small", {}, "last 90 days")),
      changes.length ? h("ul", { class: "cal-changes" }, changes.map((c) => h("li", {}, h("span", { class: `cal-chg ${c.change}` }, c.change === "added" ? "Added" : "Removed"), h("strong", {}, c.symbol), h("small", {}, dayText(c.date))))) : h("p", { class: "muted small" }, "No additions or removals recorded."),
    );
  }

  // ── 6. Corporate actions ──
  const addBtn = h("button", { type: "button", class: "small" }, icon("plus"), "Add");
  addBtn.addEventListener("click", () => openAdd());
  const act = panel("actions", "Corporate actions", "", { csv: { name: "corporate-actions", cols: "actions", rows: () => data.actions?.data?.items ?? [] }, extra: [addBtn] });
  function drawActions() {
    const a = data.actions;
    if (!a) return fill(act.body, loading("Loading corporate actions"));
    if (a.error) return fill(act.body, fail(a.error));
    const items = [...(a.data?.items ?? [])].sort((x, y) => String(y.exDate ?? "9999").localeCompare(String(x.exDate ?? "9999")));
    const upcoming = items.filter((x) => x.exDate && x.exDate >= today).sort((x, y) => x.exDate.localeCompare(y.exDate));
    const recent = items.filter((x) => !x.exDate || x.exDate < today);
    act.sub.textContent = `${formatInt(upcoming.length)} upcoming · ${formatInt(recent.length)} recent or inferred`;
    const card = (x) => {
      const ratio = x.ratio ? `${formatInt(x.ratio.new)}:${formatInt(x.ratio.held)}` : x.fv ? `FV ${formatInt(x.fv.from)} → ${formatInt(x.fv.to)}` : "";
      const typeWord = x.origin === "inferred" ? "Non-standard contract" : x.type === "bonus" ? "Bonus" : x.type === "split" ? "Split" : x.type === "rights" ? "Rights" : x.type === "dividend" ? "Dividend" : x.type === "consolidation" ? "Consolidation" : "Other";
      const adj = x.adjusted;
      const del = x.origin === "user" && onThisComputer() ? h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Remove ${x.symbol} ${typeWord}`, onclick: () => removeAction(x) }, icon("close")) : null;
      return h(
        "li",
        { class: `cal-ca ${x.origin}` },
        h("div", { class: "cal-ca-top" }, h("strong", {}, x.symbol), h("span", { class: "cal-ca-type" }, `${typeWord}${ratio ? ` ${ratio}` : ""}`), h("span", { class: "cal-ca-date" }, x.exDate ? `ex ${dayText(x.exDate, { year: x.exDate.slice(0, 4) !== today.slice(0, 4) })}` : x.contract?.expiry ? `contract ${dayText(x.contract.expiry)}` : ""), del),
        h(
          "div",
          { class: "cal-ca-meta" },
          num(x.factor) !== null ? h("span", {}, `factor ${formatFixed(x.factor, x.factor % 1 ? 4 : 0)}`) : null,
          h("span", { class: `cal-origin ${x.origin}` }, x.origin === "inferred" ? "inferred" : x.origin === "user" ? "entered here" : "shipped"),
          h("span", { class: x.verified ? "cal-ver yes" : "cal-ver" }, x.verified ? "verified" : "unverified"),
          x.origin === "inferred" && x.contract ? h("span", {}, `lot ${formatInt(x.contract.lot)} vs ${formatInt(x.contract.standardLot)} standard`) : null,
        ),
        x.origin === "inferred" ? h("p", { class: "cal-ca-note" }, x.text ?? "Probably adjusted for a corporate action") : null,
        adj?.exampleStrikes?.length ? h("p", { class: "cal-ca-adj" }, `Strikes ${adj.exampleStrikes.map((s) => `${formatInt(s.before)} → ${formatFixed(s.after, s.after % 1 ? 2 : 0)}`).join(", ")}${adj.lotBefore ? ` · lot ${formatInt(adj.lotBefore)} → ${formatInt(adj.lotAfter)}` : ""}`) : null,
      );
    };
    fill(act.body, 
      upcoming.length ? h("h3", {}, "Upcoming") : null,
      upcoming.length ? h("ul", { class: "cal-cas" }, upcoming.map(card)) : null,
      h("h3", {}, "Recent and inferred"),
      recent.length ? h("ul", { class: "cal-cas" }, recent.map(card)) : h("p", { class: "muted small" }, "None recorded."),
    );
  }
  async function removeAction(x) {
    const r = await optional(api(`/v1/reference/corporate-actions/${encodeURIComponent(x.id)}`, { method: "DELETE" }));
    if (r.error) return toast(r.error.message ?? "Could not remove it", { tone: "error" });
    toast(`${x.symbol} action removed`);
    clearReferenceCache();
    loadActions();
  }
  function openAdd() {
    const f = { type: "bonus", symbol: "", exDate: "", ratioNew: "1", ratioHeld: "1", subscriptionPrice: "", cumPrice: "", dividend: "", fvFrom: "10", fvTo: "2", lot: "", strikes: [] };
    const field = (label, input) => h("label", { class: "field" }, h("span", {}, label), input);
    const inp = (key, attrs = {}) => {
      const el = h("input", { type: "number", inputmode: "decimal", min: "0", step: "any", value: f[key], ...attrs });
      el.addEventListener("input", () => {
        f[key] = el.value;
        schedule();
      });
      return el;
    };
    const typeSel = h("select", { "aria-label": "Type" }, [["bonus", "Bonus"], ["split", "Split"], ["consolidation", "Consolidation"], ["rights", "Rights"], ["dividend", "Dividend"]].map(([v, t]) => h("option", { value: v }, t)));
    const uid = `caf${Date.now().toString(36)}`;
    const symIn = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "e.g. RELIANCE", maxlength: "30", "aria-label": "Symbol", "aria-describedby": `${uid}-sym` });
    // Past ex-dates are allowed (the panel lists recent actions too); the server validates the date.
    const dateIn2 = h("input", { type: "date", "aria-label": "Ex-date", "aria-describedby": `${uid}-date` });
    // Field errors sit under their field (and the field is marked invalid and focused), not at the foot of the sheet.
    const symErr = h("small", { class: "cal-field-err", id: `${uid}-sym`, hidden: true });
    const dateErr = h("small", { class: "cal-field-err", id: `${uid}-date`, hidden: true });
    const fieldErr = (input, el, text) => {
      el.textContent = text ?? "";
      el.hidden = !text;
      if (text) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    const ratioRow = h("div", { class: "ticket-grid" }, field("New shares", inp("ratioNew")), field("For held", inp("ratioHeld")));
    const fvRow = h("div", { class: "ticket-grid" }, field("Face value before", inp("fvFrom")), field("Face value after", inp("fvTo")));
    // One cum-price input, moved into whichever row shows (rights or dividend), so the value used is always visible.
    const cumField = field("Cum price", inp("cumPrice"));
    const rightsRow = h("div", { class: "ticket-grid" }, field("Subscription price", inp("subscriptionPrice")));
    const divRow = h("div", { class: "ticket-grid" }, field("Dividend per share", inp("dividend")));
    const lotIn = inp("lot", { step: "1", inputmode: "numeric" });
    const strikesIn = h("input", { type: "text", inputmode: "decimal", "aria-label": "Strikes", "aria-describedby": `${uid}-stk` });
    strikesIn.addEventListener("input", () => {
      f.strikes = strikesIn.value.split(/[\s,]+/).filter(Boolean);
      schedule();
    });
    const out = h("div", { class: "cal-preview", "aria-live": "polite" }, h("p", { class: "muted small" }, "Enter the action to see adjusted strikes and lot."));
    const err = h("p", { class: "cal-form-err", role: "alert", hidden: true });
    const sync = () => {
      ratioRow.hidden = !["bonus", "rights"].includes(f.type);
      fvRow.hidden = !["split", "consolidation"].includes(f.type);
      rightsRow.hidden = f.type !== "rights";
      divRow.hidden = f.type !== "dividend";
      if (f.type === "rights" && cumField.parentNode !== rightsRow) rightsRow.append(cumField);
      if (f.type === "dividend" && cumField.parentNode !== divRow) divRow.append(cumField);
    };
    typeSel.addEventListener("change", () => {
      f.type = typeSel.value;
      sync();
      schedule();
    });
    let symTimer = 0;
    symIn.addEventListener("input", () => {
      f.symbol = symIn.value.trim().toUpperCase();
      fieldErr(symIn, symErr, null);
      clearTimeout(symTimer);
      symTimer = setTimeout(fillSymbol, 350);
    });
    dateIn2.addEventListener("change", () => ((f.exDate = dateIn2.value), fieldErr(dateIn2, dateErr, null)));
    async function fillSymbol() {
      const s = f.symbol;
      if (!/^[A-Z0-9&-]{2,30}$/.test(s)) return;
      const [lots, q] = await Promise.all([optional(api(`/v1/reference/lots?underlying=${encodeURIComponent(s)}`)), optional(api(`/v1/quotes?symbols=${encodeURIComponent(`NSE:${s}`)}`))]);
      if (s !== f.symbol) return;
      const lot = lots.data?.data?.current ?? null;
      if (lot && !lotIn.value) {
        lotIn.value = String(lot);
        f.lot = String(lot);
      }
      const ltp = q.data?.data?.[0]?.ltp ?? null;
      if (ltp && !strikesIn.value) {
        f.strikes = strikesAround(ltp).map(String);
        strikesIn.value = f.strikes.join(", ");
      }
      schedule();
    }
    let pvTimer = 0;
    let pvSeq = 0;
    function schedule() {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(async () => {
        const seq = ++pvSeq;
        const r = await runPreview(f);
        if (seq !== pvSeq) return;
        if (r.error) return fill(out, h("p", { class: "muted small" }, r.error));
        const d = r.data;
        fill(out, 
          h("div", { class: "cal-kv" }, kv("Factor", d.factor === null ? DASH : formatFixed(d.factor, 4), d.terp ? `TERP ${formatFixed(d.terp, 2)}` : ""), kv("Lot", d.lotAfter ? `${formatInt(num(f.lot))} → ${formatInt(d.lotAfter)}` : DASH, d.nonStandardLot ? "non-standard" : "")),
          d.strikes?.length ? h("p", { class: "cal-ca-adj" }, `Strikes ${d.strikes.map((s) => `${formatInt(s.before)} → ${formatFixed(s.after, s.after % 1 ? 2 : 0)}`).join(", ")}`) : null,
          h("p", { class: "muted small" }, d.method),
        );
      }, 250);
    }
    sync();
    const body = h(
      "div",
      { class: "stack cal-form" },
      h("div", { class: "ticket-grid" }, h("label", { class: "field" }, h("span", {}, "Symbol"), symIn, symErr), field("Type", typeSel)),
      h("div", { class: "ticket-grid" }, h("label", { class: "field" }, h("span", {}, "Ex-date"), dateIn2, dateErr), field("Lot before", lotIn)),
      ratioRow,
      fvRow,
      rightsRow,
      divRow,
      h("label", { class: "field" }, h("span", {}, "Strikes"), strikesIn, h("small", { class: "cal-field-hint", id: `${uid}-stk` }, "Filled from the last price; separate with commas")),
      out,
      err,
    );
    // A modal sheet on every screen: the form grows with its preview, and the sheet's body scrolls, so Cancel and Save
    // stay reachable (an anchored popover ran past the bottom of a 900 px window).
    let closeAdd = () => {};
    modal({
      title: "Add a corporate action",
      body: (close) => {
        closeAdd = () => close(undefined, true);
        return body;
      },
      buttons: [],
    });
    const pop = { close: () => closeAdd() };
    const saveBtn = h("button", { type: "button", class: "primary" }, "Save");
    const cancel = h("button", { type: "button", class: "plain", onclick: () => pop.close() }, "Cancel");
    body.append(h("div", { class: "cal-form-acts" }, cancel, saveBtn));
    saveBtn.addEventListener("click", async () => {
      const b = previewBody(f);
      err.hidden = true;
      const symBad = !/^[A-Z0-9&-]{2,30}$/.test(f.symbol);
      const dateBad = !ISO_DAY.test(f.exDate);
      fieldErr(symIn, symErr, symBad ? (f.symbol ? "Use the NSE symbol: letters, digits, & or -." : "Enter the symbol.") : null);
      fieldErr(dateIn2, dateErr, dateBad ? "Enter the ex-date." : null);
      if (symBad || dateBad) return (symBad ? symIn : dateIn2).focus();
      if (b.error) {
        err.textContent = b.error;
        err.hidden = false;
        return;
      }
      const { lot: _l, strikes, strikeTick: _t, ...rest } = b.body;
      saveBtn.disabled = true;
      // The previewed strikes are saved with the row, so its card shows the same example the user just checked.
      const r = await optional(api("/v1/reference/corporate-actions", { method: "POST", body: { ...rest, ...(strikes?.length ? { exampleStrikes: strikes.slice(0, 9) } : {}), symbol: f.symbol, exchange: "NSE", exDate: f.exDate, source: "entered on the Market calendar page" } }));
      saveBtn.disabled = false;
      if (r.error) {
        err.textContent = r.error.message ?? "Could not save it";
        err.hidden = false;
        return;
      }
      pop.close();
      toast(`${f.symbol} ${f.type} saved`);
      clearReferenceCache();
      loadActions();
    });
  }

  // ── 7. Risk-free rate ──
  const rate = panel("rate", "Risk-free rate", "");
  const footRate = document.createTextNode("");
  const foot = h("p", { class: "cal-foot", "data-fixed": "" }, CAL_DISCLAIMER, footRate);
  function drawRate() {
    const r = data.rate;
    if (!r) return fill(rate.body, loading("Loading the rate"));
    if (r.error) return fill(rate.body, fail(r.error));
    const d = r.data;
    footRate.data = ` Rate in use: ${rateText({ rate: d })}.`;
    const isDefault = d.quality === "default";
    rate.sub.textContent = isDefault ? "Used on every Options page" : `${d.quality === "config" ? "From config" : "Entered"}${d.asOf ? ` · ${dayText(d.asOf)}` : ""}${d.stale ? " · over 14 days old" : ""}`;
    const valIn = h("input", { type: "number", min: "0", max: "25", step: "0.01", inputmode: "decimal", value: isDefault ? "" : formatFixed(d.value * 100, 2), placeholder: formatFixed(d.value * 100, 2), "aria-label": "Rate, % a year" });
    const asOfIn = h("input", { type: "date", value: d.asOf ?? today, max: today, "aria-label": "As of" });
    const srcIn = h("input", { type: "text", maxlength: "120", value: isDefault ? "" : d.source ?? "", placeholder: "91-day T-bill cut-off, RBI auction", "aria-label": "Source" });
    const msg = h("p", { class: "cal-form-err", role: "alert", hidden: true });
    const saveBtn = h("button", { type: "button", class: "small" }, "Save rate");
    saveBtn.addEventListener("click", async () => {
      const v = num(valIn.value);
      msg.hidden = true;
      if (v === null || v < 0 || v > 25) return Object.assign(msg, { hidden: false, textContent: "Enter a rate between 0 and 25 %." });
      if (srcIn.value.trim().length < 3) return Object.assign(msg, { hidden: false, textContent: "Say where the rate comes from (3 to 120 characters)." });
      saveBtn.disabled = true;
      const res = await optional(api("/v1/reference/rate", { method: "PUT", body: { value: Math.round(v * 100) / 10000, asOf: asOfIn.value || today, source: srcIn.value.trim() } }));
      saveBtn.disabled = false;
      if (res.error) return Object.assign(msg, { hidden: false, textContent: res.error.message ?? "Could not save the rate" });
      toast("Rate saved: every page uses it from the next refresh");
      clearReferenceCache();
      loadRate();
    });
    const age = d.asOf ? daysBetween(d.asOf, today) : null;
    fill(rate.body, 
      h("div", { class: "cal-rate-now" }, h("strong", { class: "cal-rate-v" }, `${formatFixed(d.value * 100, 2)} %`), h("span", { class: `cal-rate-src${isDefault || d.stale ? " warn" : ""}` }, isDefault ? "Default, not sourced" : d.source, h("small", {}, isDefault ? "Set it below" : `${dayText(d.asOf, { year: true })}${age !== null ? ` · ${age === 0 ? "today" : age === 1 ? "1 day old" : `${formatInt(age)} days old`}` : ""}${d.stale ? " · over 14 days old" : ""}`))),
      h("p", { class: "cal-note-line" }, "Used for forwards, IV and Greeks on every page. Enter the 91-day T-bill or your preferred rate."),
      onThisComputer()
        ? h("div", { class: "cal-rate-form" }, h("label", { class: "field" }, h("span", {}, "Rate, % a year"), valIn), h("label", { class: "field" }, h("span", {}, "As of"), asOfIn), h("label", { class: "field cal-wide" }, h("span", {}, "Source"), srcIn), h("div", { class: "cal-rate-acts" }, saveBtn), msg)
        : h("p", { class: "muted small" }, "The rate can be set from the Bridge's own computer."),
    );
  }

  // ── 8. Charges ──
  const chg = panel("charges", "Charges", "", { csv: { name: "charges", cols: "charges", rows: () => chargeRows(data.charges?.data) } });
  function drawCharges() {
    const c = data.charges;
    if (!c) return fill(chg.body, loading("Loading the charge table"));
    if (c.error) return fill(chg.body, fail(c.error));
    chg.sub.textContent = `as of ${dayText(c.data.asOf, { year: true })}${c.data.verified ? "" : " · unverified"}`;
    fill(chg.body, 
      h("table", { class: "cal-table cal-charges" }, h("tbody", {}, chargeRows(c.data).map((r) => h("tr", {}, h("th", { scope: "row" }, r.k), h("td", { class: "num" }, r.v))))),
      h("p", { class: "muted small cal-src" }, `Source: ${c.data.source}`),
    );
  }

  // ── Loading ──
  async function loadAll() {
    await Promise.all([loadStatus(), loadMonth(), loadUnderlying(), loadBan(), loadUniverse(), loadActions(), loadRate(), loadCharges(), loadEvents()]);
  }
  async function loadStatus() {
    data.status = await get("/v1/reference/status");
    drawStatus();
  }
  async function loadMonth() {
    const ym = st.month;
    drawCalendar();
    const from = `${ym}-01`;
    const to = `${addMonths(ym, 1)}-01`;
    const last = new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    // One request: the holidays and the special sessions of the month (weekday holidays included, where Muhurat
    // trading usually falls).
    const hol = await get(`/v1/reference/holidays?from=${from}&to=${last}&exchange=NSE`);
    if (ym !== st.month) return;
    data.holidays = hol;
    data.specials = (hol.data?.specialSessions ?? []).map((s) => ({ date: s.date, label: s.label, open: s.open ?? null, close: s.close ?? null }));
    drawCalendar();
  }
  async function loadUnderlying() {
    const u = st.underlying;
    data.expiries = null;
    data.lots = null;
    drawExpiries();
    const [e, l, b] = await Promise.all([get(`/v1/reference/expiries?underlying=${encodeURIComponent(u)}`), get(`/v1/reference/lots?underlying=${encodeURIComponent(u)}`), loadReference(u)]);
    if (u !== st.underlying) return;
    data.expiries = e;
    data.lots = l;
    st.ref = b;
    chip.update();
    drawEvents();
    drawExpiries();
    drawCalendar();
  }
  async function loadBan() {
    const [b, m] = await Promise.all([get("/v1/reference/ban"), get("/v1/reference/mwpl")]);
    data.ban = b;
    data.mwpl = m;
    drawBan();
  }
  async function loadUniverse() {
    data.universe = null;
    drawUniverse();
    data.universe = await get(`/v1/reference/fno-universe?date=${st.uniDate}&kind=all`);
    drawUniverse();
  }
  async function loadActions() {
    data.actions = await get("/v1/reference/corporate-actions");
    drawActions();
  }
  async function loadRate() {
    data.rate = await get("/v1/reference/rate");
    drawRate();
    loadStatus();
  }
  async function loadCharges() {
    data.charges = await get("/v1/reference/charges");
    drawCharges();
  }
  async function loadEvents() {
    // The server's own window (reference.bannerDays): the same events the Options pages' banners show.
    data.events = await get("/v1/reference/events");
    drawEvents();
  }
  function drawEvents() {
    // The selected underlying's lots go in too, so the stale-lot warning shows here as on every Options page (§5.3).
    banners.update({ events: calendarEvents(data.events?.data?.items ?? [], st.underlying), lots: st.ref?.lots ?? null, rate: null, session: null });
  }

  // Phones get the list, wider screens the grid: redraw when the device class changes. The listener (and a pending
  // month fetch) go when the route leaves this page, so a visit does not keep the page's DOM alive.
  const mq = typeof matchMedia === "function" ? matchMedia("(max-width: 719px)") : null;
  const onMq = () => (statusEl.isConnected ? (drawCalendar(), drawUniverse()) : cleanup());
  mq?.addEventListener("change", onMq);
  const onRoute = () => setTimeout(() => !statusEl.isConnected && cleanup(), 0);
  window.addEventListener("hashchange", onRoute);
  function cleanup() {
    mq?.removeEventListener("change", onMq);
    window.removeEventListener("hashchange", onRoute);
    clearTimeout(monthTimer);
  }

  drawStatus();
  drawCalendar();
  drawExpiries();
  drawBan();
  drawUniverse();
  drawActions();
  drawRate();
  drawCharges();
  loadAll();

  const left = h("div", { class: "cal-col cal-left" }, cal.el, exp.el, ban.el, uni.el);
  const right = h("div", { class: "cal-col cal-right" }, act.el, rate.el, chg.el);
  return [banners.el, pageAlert, statusEl, h("div", { class: "cal-cols", "data-fixed": "" }, left, right), foot];
}
