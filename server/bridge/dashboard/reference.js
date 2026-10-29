// Reference data on the dashboard (docs/spec/p1-02-reference.md §5.1): the client side of /v1/reference/*. One bundle
// per underlying (session, holidays, rate, expiries, lots, freeze qty, ban / MWPL, events, charges), cached for 10
// minutes, and the pieces every Options page shows from it: the reference chip in the top bar, the banners for events
// within 7 days, the stale-data warning and the order ticket's lot-size confirmation.
//
// REF_DEFAULTS is the ONLY dashboard copy of the store-S5 default values (rate, session times, brokerage, the charge
// table). It is used only when the bundle cannot be read, and every value says so ("dashboard fallback"). The static
// test reference/noConstants.test.mjs keeps these literals out of every other dashboard file.
//
// Pure helpers (refRate, refSession, refCalendar, refCharges, lotConfirmGate, bannerModel, chipModel ...) are exported
// for tests; DOM code runs only in a browser. Numbers become text through format.js only. Copy is descriptive, never
// advice (copyRules.mjs).
import { api, h, icon, sheetPopover, store } from "./app.js";
import { DASH, formatFixed, formatInt } from "./format.js";

/** Where a fallback value comes from (shown wherever it is used). */
export const FALLBACK_SOURCE = "dashboard fallback";

/**
 * The fallback values, used only when /v1/reference/bundle cannot be read (an older Bridge, a network error). The
 * charge table has the server's shape (reference/data/charges.json + brokerage) so refCharges() reads both the same.
 */
export const REF_DEFAULTS = Object.freeze({
  source: FALLBACK_SOURCE,
  rate: Object.freeze({ value: 0.065, asOf: null, source: FALLBACK_SOURCE, quality: "default", stale: true }),
  session: Object.freeze({ state: null, label: null, date: null, preOpen: "09:00", open: "09:15", close: "15:30", holiday: null, special: null, source: FALLBACK_SOURCE }),
  charges: Object.freeze({
    asOf: "2026-04-01",
    source: FALLBACK_SOURCE,
    verified: false,
    opt: Object.freeze({ sttSell: 0.0015, exerciseStt: 0.0015, stampBuy: 0.00003, txn: Object.freeze({ NSE: 0.0003503, BSE: 0.000325 }) }),
    fut: Object.freeze({ sttSell: 0.0005, stampBuy: 0.00002, txn: Object.freeze({ NSE: 0.0000173, BSE: 0 }) }),
    sebiPerCrore: 10,
    ipftPerCrore: 0,
    gst: 0.18,
    brokerage: Object.freeze({ kind: "flat", perOrder: 20, source: FALLBACK_SOURCE }),
  }),
});

/** How long one bundle is reused before it is read again (spec §3.3: every 10 minutes). */
export const REF_TTL_MS = 10 * 60_000;
/** Events at most this many days away get a banner (reference.bannerDays). */
export const BANNER_DAYS = 7;
/** localStorage slot for "Hide until tomorrow": { [eventId]: "YYYY-MM-DD" (the IST day it was hidden) }. */
export const HIDDEN_SLOT = "mcb.dashboard.refHidden";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IST_OFFSET_MS = 330 * 60_000;
const finite = (v) => (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
const num = (v) => (finite(v) ? Number(v) : null);

// ── Dates (IST calendar days as "YYYY-MM-DD"; pure) ──

/** "2026-10-27" → "27 Oct" ("27 Oct 2025" when `year`); "--" for anything else. */
export function dayText(iso, { year = false, weekday = false } = {}) {
  if (!ISO_DAY.test(String(iso ?? ""))) return DASH;
  const [y, m, d] = String(iso).split("-").map(Number);
  const wd = weekday ? `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ` : "";
  return `${wd}${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
}
/** "2026-11" → "Nov 2026". */
export const monthText = (ym) => (/^\d{4}-\d{2}$/.test(String(ym ?? "")) ? `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}` : DASH);
/** The IST calendar date of an epoch-ms time. */
export const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
/** Whole calendar days from a to b (both "YYYY-MM-DD"); null for bad input. */
export function daysBetween(a, b) {
  if (!ISO_DAY.test(String(a ?? "")) || !ISO_DAY.test(String(b ?? ""))) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
/** "HH:MM" → minutes after midnight (null for a bad time). */
export function hmMinutes(hm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── Loading (one bundle per underlying, 10-minute cache) ──

const cache = new Map();
/** Forget every cached bundle (tests; the Market calendar page after a write). */
export function clearReferenceCache() {
  cache.clear();
  failures.clear();
}

/** The fallback bundle: REF_DEFAULTS in the bundle's shape, flagged `fallback: true` with the reason. */
export function fallbackBundle(underlying = null, reason = "Reference data unavailable") {
  return {
    fallback: true,
    reason,
    underlying,
    exchange: null,
    kind: null,
    session: { ...REF_DEFAULTS.session },
    nextTradingDay: null,
    prevTradingDay: null,
    holidays: [],
    rate: { ...REF_DEFAULTS.rate },
    expiries: [],
    lots: null,
    freeze: null,
    ban: null,
    events: [],
    deliveryMargin: null,
    charges: REF_DEFAULTS.charges,
    warnings: ["Reference data unavailable: using dashboard defaults."],
  };
}

/** The first wait after a failed bundle read; each further failure doubles it, up to REF_TTL_MS (spec §3.3, §8). */
export const REF_RETRY_MS = 60_000;
const failures = new Map();

/**
 * The reference bundle for an underlying: GET /v1/reference/bundle, reused for REF_TTL_MS, read again on `force`.
 * Never throws: a failure returns fallbackBundle(), and that same fallback object is reused for a backoff (60 s,
 * doubling per failure up to REF_TTL_MS), so a 5xx, a 429 or a signed-out key is not asked again on every refresh tick.
 * `get` and `now` are for tests; `demoStale` asks a demo Bridge to report the lots as two trading days old (spec §4).
 * @returns {Promise<object>}
 */
export async function loadReference(underlying, { force = false, demoStale = false, now = Date.now(), get = defaultGet } = {}) {
  const u = String(underlying ?? "").trim().toUpperCase();
  if (!u) return fallbackBundle(null, "No underlying");
  const key = `${u}|${demoStale ? 1 : 0}`;
  const hit = cache.get(key);
  if (!force && hit && now - hit.at < hit.ttl) return hit.promise;
  const entry = { at: now, ttl: REF_TTL_MS, promise: null };
  entry.promise = (async () => {
    try {
      const data = await get(`/v1/reference/bundle?underlying=${encodeURIComponent(u)}${demoStale ? "&demoStale=1" : ""}`);
      if (!data || typeof data !== "object" || !data.session) throw new Error("Unexpected reference bundle");
      failures.delete(key);
      return data;
    } catch (err) {
      const n = (failures.get(key) ?? 0) + 1;
      failures.set(key, n);
      entry.ttl = Math.min(REF_TTL_MS, REF_RETRY_MS * 2 ** (n - 1));
      return fallbackBundle(u, err?.message ?? "Reference data unavailable");
    }
  })();
  cache.set(key, entry);
  return entry.promise;
}

/** What a page compares before redrawing for a new bundle: the same data read twice gives the same signature. */
export const refSignature = (b) => (b ? JSON.stringify([b.underlying ?? null, Boolean(b.fallback), b.now ?? b.asOf ?? null, b.lots?.asOf ?? null, b.lots?.stale ?? null, (b.events ?? []).length, b.rate?.value ?? null]) : "");
async function defaultGet(path) {
  return (await api(path)).data?.data ?? null;
}

/** True when the page URL asks a demo Bridge for stale lots ("#/chain?demoStale=1"), so the warning can be seen. */
export const demoStaleAsked = (hash = typeof location === "undefined" ? "" : location.hash) => /[?&]demoStale=1\b/.test(String(hash ?? ""));

// ── Values from a bundle (pure; a missing or fallback bundle gives the labelled defaults) ──

/** { value, asOf, source, quality, stale, isDefault } — the rate every pricing figure on the page uses. */
export function refRate(b) {
  const r = b?.rate && finite(b.rate.value) ? b.rate : REF_DEFAULTS.rate;
  const isDefault = r.quality === "default" || r.source === FALLBACK_SOURCE;
  return { value: Number(r.value), asOf: r.asOf ?? null, source: r.source ?? FALLBACK_SOURCE, quality: r.quality ?? "default", stale: Boolean(r.stale), isDefault };
}
/** "6.50 % default, not sourced" / "5.71 % · 91-day T-bill (28 Oct)": the rate as one line, for method notes. */
export function rateText(b) {
  const r = refRate(b);
  const pct = `${formatFixed(r.value * 100, 2)} %`;
  if (r.source === FALLBACK_SOURCE) return `${pct} dashboard default`;
  if (r.isDefault) return `${pct} default, not sourced`;
  return `${pct} · ${r.source}${r.asOf ? ` (${dayText(r.asOf)})` : ""}${r.stale ? " · over 14 days old" : ""}`;
}
/** True when the Volatility and Arbitrage pages should say where the rate comes from (default or old). */
export const rateNeedsNote = (b) => {
  const r = refRate(b);
  return r.isDefault || r.stale;
};

/** The session window for today: { preOpen, open, close, state, label, holiday, special, date, source } (HH:MM IST). */
export function refSession(b) {
  const s = b?.session && hmMinutes(b.session.open) !== null && hmMinutes(b.session.close) !== null ? b.session : REF_DEFAULTS.session;
  return { ...REF_DEFAULTS.session, ...s };
}

/** NFO / BFO trade on the NSE / BSE holiday list. */
const cashExchange = (exchange) => (exchange === "BFO" || exchange === "BSE" ? "BSE" : "NSE");
/**
 * The client calendar from the bundle's holidays: { holidays: Set of dates, isTradingDay(date), label(date) }. Weekends
 * are closed; a listed holiday for the underlying's exchange is closed (verified or not: this is display only).
 */
export function refCalendar(b) {
  const exch = cashExchange(b?.exchange);
  const rows = (b?.holidays ?? []).filter((x) => ISO_DAY.test(String(x?.date ?? "")) && (!Array.isArray(x.exchanges) || x.exchanges.includes(exch)));
  const byDate = new Map(rows.map((x) => [x.date, x]));
  const isTradingDay = (date) => {
    if (!ISO_DAY.test(String(date ?? ""))) return false;
    const [y, m, d] = String(date).split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow !== 0 && dow !== 6 && !byDate.has(date);
  };
  return { holidays: new Set(byDate.keys()), isTradingDay, label: (date) => byDate.get(date)?.label ?? null, verified: (date) => Boolean(byDate.get(date)?.verified) };
}

/**
 * The statutory charge table the pages price with (options.js rate shape): { asOf: "Apr 2026", asOfDate, source,
 * brokeragePerOrder, opt, fut, sebiPerCrore, ipftPerCrore, gst }. From the bundle, else REF_DEFAULTS.
 */
export function refCharges(b) {
  const c = b?.charges && b.charges.opt && b.charges.fut ? b.charges : REF_DEFAULTS.charges;
  const asOfDate = ISO_DAY.test(String(c.asOf ?? "")) ? c.asOf : null;
  const per = num(c.brokerage?.perOrder);
  return {
    asOf: asOfDate ? monthText(asOfDate.slice(0, 7)) : DASH,
    asOfDate,
    source: c.source ?? FALLBACK_SOURCE,
    brokeragePerOrder: per ?? REF_DEFAULTS.charges.brokerage.perOrder,
    brokerage: { kind: c.brokerage?.kind ?? "flat", perOrder: per ?? REF_DEFAULTS.charges.brokerage.perOrder, source: c.brokerage?.source ?? c.source ?? FALLBACK_SOURCE },
    opt: { ...c.opt, txn: { ...c.opt.txn } },
    fut: { ...c.fut, txn: { ...c.fut.txn } },
    sebiPerCrore: num(c.sebiPerCrore) ?? 0,
    ipftPerCrore: num(c.ipftPerCrore) ?? 0,
    gst: num(c.gst) ?? 0,
  };
}

// ── Lots: staleness and the ticket gate ──

/** The lots block's age in words: "1 day old", "2 trading days old", or null when current. */
export function lotsAge(b) {
  const n = num(b?.lots?.staleTradingDays);
  if (n === null || n <= 0) return null;
  return n === 1 ? "1 day old" : `${formatInt(n)} trading days old`;
}

/**
 * The order ticket's lot-size gate (spec §5.4, acceptance criterion 4): needed when the reference lot data is stale
 * (over one trading day old) or the broker master and the reference disagree. { needed, text, reason, lot }.
 * Orders always use the master's lot; this only asks the user to confirm it. Options and futures sent in lots are both
 * gated (the server's LOT_SIZE_STALE check covers FUT and OPT); an order in units (`units: true`) never is.
 */
export function lotConfirmGate(b, lot, { units = false } = {}) {
  const L = num(lot);
  const lots = b?.lots ?? null;
  if (units || !lots || b?.fallback || L === null || L <= 0) return { needed: false, text: "", reason: null, lot: L };
  const conflict = lots.conflict && typeof lots.conflict === "object" ? lots.conflict : null;
  if (conflict) {
    const other = num(conflict.reference) ?? num(conflict.master);
    return { needed: true, reason: "conflict", lot: L, text: `Lot size ${formatInt(L)} units from your broker's contract${other !== null && other !== L ? `; the reference list says ${formatInt(other)}` : ""}. I have checked it.` };
  }
  if (lots.stale) {
    const age = lotsAge(b);
    return { needed: true, reason: "stale", lot: L, text: `Lot size ${formatInt(L)} units, from ${dayText(lots.asOf)}${age ? ` (${age})` : ""}. I have checked it.` };
  }
  return { needed: false, text: "", reason: null, lot: L };
}

// ── Events, banners and the stale warning (pure models) ──

/** A stable id for "Hide until tomorrow". */
export const eventId = (e) => `${e?.kind ?? "event"}:${e?.underlying ?? ""}:${e?.effectiveOn ?? ""}`;

/** Read the hidden-events map, dropping entries from earlier days. Never throws (storage may be blocked). */
export function readHidden(today, local = store("local")) {
  try {
    const raw = JSON.parse(local.get(HIDDEN_SLOT) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, d]) => d === today));
  } catch {
    return {};
  }
}
/** Hide one event until tomorrow (IST). Storage errors are ignored. */
export function hideEvent(id, today, local = store("local")) {
  try {
    local.set(HIDDEN_SLOT, JSON.stringify({ ...readHidden(today, local), [id]: today }));
  } catch {
    /* storage blocked: the banner just comes back next time */
  }
}

/** Short label of an event for chips: "Lot change 25 Nov", "Bonus ex 4 Nov", "Expiry moved to 9 Nov". */
export function eventShort(e) {
  const on = dayText(e?.effectiveOn);
  if (e?.kind === "lot-revision") return `Lot change ${on}`;
  if (e?.kind === "holiday-expiry-shift") return `Expiry on ${on}`;
  if (e?.kind === "corporate-action") {
    const t = String(e?.ref?.type ?? "");
    const word = t === "bonus" ? "Bonus" : t === "split" ? "Split" : t === "rights" ? "Rights" : t === "dividend" ? "Dividend" : t === "consolidation" ? "Consolidation" : "Corporate action";
    return `${word} ex ${on}`;
  }
  return on;
}

/** Events within `days` (0 ≤ daysAway ≤ days), nearest first. */
export function upcomingEvents(events, days = BANNER_DAYS) {
  return [...(events ?? [])].filter((e) => num(e?.daysAway) !== null && e.daysAway >= 0 && e.daysAway <= days).sort((a, b) => a.daysAway - b.daysAway || String(a.underlying).localeCompare(String(b.underlying)));
}

/**
 * What the banners above a page say (spec §5.3): [{ id, kind, tone, text, hideable }], the stale warning first, then
 * one per event within BANNER_DAYS that is not hidden today. `max` banners show; `more` counts the rest.
 */
export function bannerModel(b, { hidden = {}, max = 2, rateNote = false } = {}) {
  const out = [];
  if (b?.fallback) out.push({ id: "fallback", kind: "fallback", tone: "bad", text: "Reference data unavailable: using dashboard defaults", detail: "Session times, the rate and charges are the dashboard's built-in values until the Bridge answers.", hideable: false });
  const stale = staleText(b);
  if (stale) out.push({ id: "stale", kind: "stale", tone: "warn", text: stale.text, detail: stale.detail, hideable: false });
  const events = upcomingEvents(b?.events).filter((e) => !hidden[eventId(e)]);
  for (const e of events) out.push({ id: eventId(e), kind: e.kind, tone: "info", text: e.text || eventShort(e), detail: null, hideable: true, event: e });
  if (rateNote && rateNeedsNote(b) && !b?.fallback) out.push({ id: "rate", kind: "rate", tone: "quiet", text: `Rate: ${rateText(b)}.`, detail: null, hideable: false, link: "#/calendar" });
  return { shown: out.slice(0, max), more: Math.max(0, out.length - max), all: out };
}

/** True when the bundle's ban / MWPL data is older than reference.staleAfterTradingDays (server's `ban.stale`). */
export const banStale = (b) => b?.ban?.stale === true;

/** The stale-data warning (acceptance criterion 4), or null: lots more than one trading day old, or the ban list old. */
export function staleText(b) {
  const lots = b?.lots ?? null;
  if (lots?.stale) {
    const n = num(lots.staleTradingDays);
    const age = n === null ? "old" : n === 1 ? "1 trading day old" : `${formatInt(n)} trading days old`;
    return { text: `Contract data is ${age} (lot sizes from ${dayText(lots.asOf)}). Check the lot size before ordering in lots.`, detail: null };
  }
  if (b?.ban && banStale(b)) {
    const n = num(b.ban.staleTradingDays);
    const age = n === null ? "" : n === 1 ? " (1 trading day old)" : ` (${formatInt(n)} trading days old)`;
    return { text: `The ban list and MWPL are from ${dayText(b.ban.asOf)}${age}. Check them before opening positions in this stock.`, detail: null };
  }
  return null;
}

/**
 * The chip's words (spec §5.2): { text, short, aria, tone, dot, count }. Desktop shows `text` ("Lot 65 · Freeze 1800
 * · 1 event"), tablets `short` plus the count, phones the lot and a dot.
 */
export function chipModel(b, { lot = null, now = Date.now() } = {}) {
  const L = num(lot) ?? num(b?.lots?.current);
  const freeze = num(b?.freeze?.freezeQty);
  const events = upcomingEvents(b?.events);
  const parts = [`Lot ${L === null ? DASH : formatInt(L)}`];
  if (freeze !== null) parts.push(`Freeze ${formatInt(freeze)}`);
  const extra = [];
  if (events.length) extra.push(`${formatInt(events.length)} event${events.length === 1 ? "" : "s"}`);
  if (b?.lots?.stale) extra.push("Stale");
  const tomorrow = b?.fallback ? null : holidayTomorrow(b, now);
  if (tomorrow) extra.push("Holiday tomorrow");
  const tone = b?.fallback ? "bad" : b?.lots?.stale || b?.lots?.conflict ? "warn" : "normal";
  const text = b?.fallback ? `${parts[0]} · Defaults` : [...parts, ...extra].join(" · ");
  const short = [parts[0], ...extra.filter((x) => x !== "Stale" && x !== "Holiday tomorrow").slice(0, 1)].join(" · ");
  const aria = b?.fallback ? `${parts.join(", ")}. Reference data unavailable: using dashboard defaults. Open contract facts.` : `${[...parts, ...extra].join(", ")}. Open contract facts.`;
  return { text, short, aria, tone, dot: Boolean(events.length || tone !== "normal" || tomorrow), count: events.length };
}
/** The holiday on the IST day after `now`, when that day is a weekday holiday in the bundle. */
function holidayTomorrow(b, now) {
  const d = new Date(Date.parse(`${istDate(now)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const cal = refCalendar(b);
  return cal.label(d);
}

/** Rows of the "Contract facts" sheet: [{ k, v, sub }] (pure, tested). */
export function factsRows(b, { lot = null } = {}) {
  const s = refSession(b);
  const r = refRate(b);
  const L = num(lot) ?? num(b?.lots?.current);
  const rows = [];
  const sessionV = s.holiday ? `Closed: ${s.holiday.label}${s.holiday.verified ? "" : " (unverified)"}` : s.special ? `${s.special.label ?? "Special session"} ${s.special.open ?? ""}–${s.special.close ?? ""}`.trim() : `${s.open}–${s.close} IST`;
  rows.push({ k: "Session today", v: sessionV, sub: `${s.label ? `${s.label} · ` : ""}${s.source ?? FALLBACK_SOURCE}` });
  rows.push({ k: "Next trading day", v: b?.nextTradingDay ? dayText(b.nextTradingDay, { weekday: true }) : DASH, sub: "Holiday list and weekends" });
  const next = b?.lots?.next;
  const nextText = next && num(next.lot) !== null && next.from && num(next.lot) !== L ? ` · ${formatInt(next.lot)} from ${dayText(next.from)}` : "";
  rows.push({ k: "Lot size", v: `${L === null ? DASH : formatInt(L)} units${nextText}`, sub: b?.lots ? `${b.lots.source ?? DASH}, ${dayText(b.lots.asOf)}${lotsAge(b) ? ` · ${lotsAge(b)}` : ""}${b.lots.conflict ? " · differs from the broker master" : ""}` : b?.fallback ? FALLBACK_SOURCE : "From the broker master" });
  const fq = num(b?.freeze?.freezeQty);
  rows.push({ k: "Freeze qty", v: fq === null ? "Unknown" : `${formatInt(fq)} units`, sub: fq === null ? "Freeze qty unknown: slicing is not checked" : `${b.freeze.source === "exchange-list" ? "Exchange list" : b.freeze.source === "master" ? "Broker master" : b.freeze.source ?? DASH}${b.freeze.verified ? "" : " · unverified"}` });
  rows.push({ k: "Rate", v: `${formatFixed(r.value * 100, 2)} %`, sub: `${r.isDefault ? "default, not sourced" : r.source}${r.asOf ? ` · ${dayText(r.asOf)}` : ""}${r.stale && !r.isDefault ? " · over 14 days old" : ""}` });
  if (b?.ban) rows.push({ k: "Ban / MWPL", v: b.ban.inBan ? "In ban period" : num(b.ban.mwplPct) !== null ? `MWPL ${formatFixed(b.ban.mwplPct, 1)} %` : DASH, sub: `${b.ban.source ?? DASH}, for ${dayText(b.ban.forDate)}` });
  const ev = upcomingEvents(b?.events);
  rows.push({ k: "Upcoming", v: ev.length ? ev.map(eventShort).join(" · ") : "Nothing within 7 days", sub: ev.length ? "Lot revisions, corporate actions and expiry shifts" : null });
  return rows;
}

// ── DOM ──

const media = (q) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);

/**
 * The reference chip for the Options top bar (spec §5.2): a button that opens "Contract facts". `getBundle()` and
 * `getLot()` are read on every update(), so the chip follows the page's underlying.
 * @returns {{ el: HTMLElement, update: () => void, open: () => void }}
 */
export function refChip({ getBundle, getLot = () => null }) {
  const text = h("span", { class: "ref-chip-text" });
  const dot = h("span", { class: "ref-chip-dot", "aria-hidden": "true", hidden: true });
  const el = h("button", { type: "button", class: "ref-chip glass", "aria-haspopup": "dialog", hidden: true }, h("span", { class: "ref-chip-ic", "aria-hidden": "true" }, icon("calendar")), text, dot);
  let sig = "";
  const update = () => {
    const b = getBundle();
    if (!b) {
      el.hidden = true;
      return;
    }
    const m = chipModel(b, { lot: getLot() });
    const phone = media("(max-width: 719px)");
    const tablet = !phone && media("(max-width: 1023px)");
    const words = phone ? m.text.split(" · ")[0] : tablet ? m.short : m.text;
    const s = JSON.stringify([words, m.tone, m.dot, m.aria]);
    el.hidden = false;
    if (s === sig) return;
    sig = s;
    text.textContent = words;
    el.dataset.tone = m.tone;
    dot.hidden = !(m.dot && (phone || tablet));
    el.setAttribute("aria-label", m.aria);
    el.title = m.text;
  };
  const open = () => openFacts(el, getBundle(), getLot());
  el.addEventListener("click", open);
  return { el, update, open };
}

/** The "Contract facts" popover (a bottom sheet on phones). */
export function openFacts(trigger, b, lot) {
  if (!b) return null;
  const rows = factsRows(b, { lot });
  const body = h(
    "div",
    { class: "ref-facts" },
    b.fallback ? h("p", { class: "ref-facts-note bad" }, "Reference data unavailable: using dashboard defaults.") : null,
    h("dl", { class: "ref-facts-list" }, rows.map((r) => h("div", { class: "ref-fact" }, h("dt", {}, r.k), h("dd", {}, h("span", { class: "ref-fact-v" }, r.v), r.sub ? h("small", {}, r.sub) : null)))),
    h("a", { href: "#/calendar", class: "ref-facts-link" }, icon("calendar"), "Market calendar"),
  );
  return sheetPopover({ trigger, title: `Contract facts · ${b.underlying ?? ""}`.trim(), body, cls: "ref-facts-pop" });
}

/**
 * The banner strip above a page body (spec §5.3). update(bundle) redraws it; at most 2 banners show (1 on phones),
 * "+N more" opens the facts sheet. Events can be hidden until tomorrow. `rateNote` adds the rate line (vol, arb).
 * @returns {{ el: HTMLElement, update: (b: object|null) => void }}
 */
export function refBanners({ rateNote = false, onMore = null, now = () => Date.now() } = {}) {
  const el = h("div", { class: "ref-banners", "data-fixed": "", hidden: true, role: "region", "aria-label": "Contract notices" });
  let last = null;
  let sig = "";
  const draw = () => {
    const b = last;
    if (!b) {
      el.hidden = true;
      return;
    }
    const today = istDate(now());
    const max = media("(max-width: 719px)") ? 1 : 2;
    const m = bannerModel(b, { hidden: readHidden(today), max, rateNote });
    const s = JSON.stringify([m.shown.map((x) => [x.id, x.text]), m.more]);
    if (s === sig) return;
    sig = s;
    el.hidden = !m.shown.length;
    const kids = [
      ...m.shown.map((x) =>
        h(
          "div",
          { class: `ref-banner ${x.tone}`, "data-kind": x.kind, role: x.tone === "bad" || x.tone === "warn" ? "alert" : "status" },
          icon(x.tone === "info" || x.tone === "quiet" ? "calendar" : "warn"),
          h("p", { class: "ref-banner-text", tabindex: "0", title: x.text, onclick: (e) => e.currentTarget.classList.toggle("open") }, x.text, x.detail ? h("span", { class: "ref-banner-detail" }, ` ${x.detail}`) : null),
          x.link ? h("a", { href: x.link, class: "ref-banner-act" }, "Market calendar") : null,
          x.hideable
            ? h("button", { type: "button", class: "ref-banner-act", title: "Hide until tomorrow", "aria-label": `Hide until tomorrow: ${x.text}`, onclick: () => (hideEvent(x.id, today), (sig = ""), draw()) }, h("span", { class: "ref-hide-long" }, "Hide until tomorrow"), h("span", { class: "ref-hide-short", "aria-hidden": "true" }, icon("close")))
            : null,
        ),
      ),
    ];
    if (m.more) kids.push(h("button", { type: "button", class: "ref-more", onclick: (e) => onMore?.(e.currentTarget) }, `+${formatInt(m.more)} more`));
    el.replaceChildren(...kids);
  };
  return {
    el,
    update(b) {
      last = b ?? null;
      draw();
    },
  };
}

/** The event chip for a positions row or the "Also open" list: "Lot change 25 Nov" (class ref-event-chip). */
export function eventChip(e) {
  return h("span", { class: "ref-event-chip", title: e?.text ?? "" }, eventShort(e));
}
