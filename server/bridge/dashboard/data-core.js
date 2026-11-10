// Data page: the pure logic (no DOM, no clock unless it is passed in), so it can be tested in Node.
//
// What lives here: the words and numbers for downloads, recordings, datasets and collections, the estimate before a
// job starts (bars, size, broker calls, time at the allowed share), the option-universe rules in plain words, the
// auto-record summary, tag and usage helpers, import and export of a collection, and a small client for the routes
// (createDataClient) that takes the dashboard's own fetch function, so a test can run it against a fake Bridge.
// The page modules (data-page.js) only draw what these return.
//
// Route shapes are the ones in the wave rules: /v1/downloads, /v1/datasets, /v1/recordings (+ /rules), /v1/collections
// (+ /{name}/resolve). Every function tolerates a missing field: a half-built Bridge never throws here.

import { DASH, formatFixed, formatInt, plural } from "./format.js";

// ── Numbers and words ──

/** 1536 -> "1.5 KB". Missing or negative -> "". */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v < 1024) return `${formatInt(v)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 100 || Number.isInteger(x) ? formatInt(x) : formatFixed(x, 1)} ${units[i]}`;
}

/** Seconds -> "under a minute", "about 3 minutes", "about 2 hours". null when unknown. */
export function formatDuration(sec) {
  const s = sec === null || sec === undefined || sec === "" ? NaN : Number(sec);
  if (!Number.isFinite(s) || s < 0) return null;
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `about ${plural(m, "minute")}`;
  const hrs = Math.round((s / 3600) * 10) / 10;
  if (hrs < 48) return `about ${hrs === Math.round(hrs) ? formatInt(hrs) : formatFixed(hrs, 1)} ${hrs === 1 ? "hour" : "hours"}`;
  return `about ${plural(Math.round(hrs / 24), "day")}`;
}

/** A count in short words: 1200 -> "1200" (no separators, house rule), 1_250_000 -> "1.3 million". */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DASH;
  if (v >= 1_000_000) return `${formatFixed(v / 1_000_000, 1)} million`;
  return formatInt(v);
}

const IST_MS = 5.5 * 3_600_000;
const pad = (n) => String(n).padStart(2, "0");
/** An epoch ms as an IST calendar day "2026-11-09". */
export function istDay(ms) {
  const d = new Date(ms + IST_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** An ISO timestamp as IST "09:31:02"; DASH when it is not a time. */
export function istClock(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return DASH;
  const d = new Date(t + IST_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-09..." -> "9 Nov 2026"; DASH when missing. */
export function dayText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return DASH;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}
/** Two bars as "9 Nov 2026 to 6 Nov 2026"-style text. */
export function rangeText(first, last) {
  if (!first && !last) return DASH;
  return `${dayText(first)} to ${dayText(last)}`;
}
/** When something happened, as a short plain age: "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function agoText(iso, nowMs = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return DASH;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${plural(Math.round(s / 60), "minute")} ago`;
  if (s < 86_400) return `${plural(Math.round(s / 3600), "hour")} ago`;
  return `${plural(Math.round(s / 86_400), "day")} ago`;
}

// ── What the data is (the three data classes) ──

/**
 * The plain label for a data class and what it means for a file (never green for a delayed or end-of-day file).
 * @param {{ dataClass?: string, delaySec?: number | null, source?: string }} o
 */
export function classInfo({ dataClass, delaySec = null, source = "" } = {}) {
  const from = source ? ` Source: ${source}.` : "";
  if (dataClass === "realtime") return { id: "realtime", label: "Real-time", tone: "ok", note: `Recorded or fetched from your own broker account as it happened. Fine for any use.${from}` };
  if (dataClass === "delayed") {
    const mins = Number.isFinite(Number(delaySec)) && Number(delaySec) > 0 ? Math.round(Number(delaySec) / 60) : 15;
    return { id: "delayed", label: `Delayed ${mins} min`, tone: "warn", note: `About ${mins} minutes behind the market, from a free source. Fine for study and charts; the Bridge never uses it for orders, risk checks, paper fills or alerts.${from}` };
  }
  if (dataClass === "eod") return { id: "eod", label: "End of day", tone: "warn", note: `One set of values per day, published after the close. Fine for study; never used for orders, risk checks, paper fills or alerts.${from}` };
  return { id: "unknown", label: "Not labelled", tone: "", note: "The Bridge did not say how current this data is, so treat it as study data only." };
}
/** The three classes in the order a person reads them (for the "what do these mean" note). */
export const CLASS_GUIDE = Object.freeze([classInfo({ dataClass: "realtime" }), classInfo({ dataClass: "delayed" }), classInfo({ dataClass: "eod" })]);

// ── Intervals, formats, ranges ──

/** Bars the history route can return. `perDay` is bars per trading day (the NSE cash session is 375 minutes). */
export const INTERVALS = Object.freeze([
  { id: "1m", label: "1 minute", perDay: 375, intraday: true },
  { id: "3m", label: "3 minutes", perDay: 125, intraday: true },
  { id: "5m", label: "5 minutes", perDay: 75, intraday: true },
  { id: "10m", label: "10 minutes", perDay: 38, intraday: true },
  { id: "15m", label: "15 minutes", perDay: 25, intraday: true },
  { id: "30m", label: "30 minutes", perDay: 13, intraday: true },
  { id: "60m", label: "1 hour", perDay: 7, intraday: true },
  { id: "1d", label: "Daily", perDay: 1, intraday: false },
  { id: "1w", label: "Weekly", perDay: 0.2, intraday: false },
  { id: "1M", label: "Monthly", perDay: 1 / 21, intraday: false },
]);
export const DEFAULT_INTERVALS = Object.freeze(["5m"]);
export const intervalInfo = (id) => INTERVALS.find((i) => i.id === id) ?? null;

export const FORMATS = Object.freeze([
  { id: "csv", label: "CSV", note: "Opens in Excel, Google Sheets and most tools.", bytesPerBar: 62 },
  { id: "jsonl", label: "JSON lines", note: "One JSON object per line, for scripts.", bytesPerBar: 118 },
  { id: "amibroker", label: "AmiBroker", note: "Ready to import into AmiBroker.", bytesPerBar: 56 },
]);
export const LAYOUTS = Object.freeze([
  { id: "per-symbol", label: "One file per symbol", note: "Easiest to open and share." },
  { id: "combined", label: "One combined file", note: "Everything in one file with a symbol column." },
]);

/** How far back a "longest" range asks (days). The broker may give less; the job says so when it does. */
export const MAX_BACK_DAYS = Object.freeze({ intraday: 730, daily: 3650 });
/** Days one broker call covers (the history route's default chunking), and the usual spare calls per second. */
export const CALL_SPAN_DAYS = Object.freeze({ intraday: 60, daily: 2000 });
export const DEFAULT_CALLS_PER_SEC = 3;
export const DEFAULT_SHARE = 0.3;

export const RANGES = Object.freeze([
  { id: "1m", label: "Last month", days: 31 },
  { id: "3m", label: "3 months", days: 92 },
  { id: "1y", label: "Last year", days: 366 },
  { id: "max", label: "As far back as possible", days: null },
  { id: "custom", label: "Pick dates", days: null },
]);
export const DEFAULT_RANGE = "1m";

const dayMs = 86_400_000;
const parseDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
};
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The dates a range choice means: { from, to } as IST days. "max" goes back as far as the deepest chosen interval is
 * asked for (the broker may give less).
 * @param {string} rangeId  @param {number} nowMs  @param {string[]} [intervals]  @param {{ from?: string, to?: string }} [custom]
 */
export function rangeDates(rangeId, nowMs, intervals = DEFAULT_INTERVALS, custom = {}) {
  const today = istDay(nowMs);
  if (rangeId === "custom") return { from: custom.from || "", to: custom.to || today };
  const base = parseDay(today);
  if (rangeId === "max") {
    const days = intervals.some((i) => intervalInfo(i)?.intraday) || !intervals.length ? MAX_BACK_DAYS.intraday : MAX_BACK_DAYS.daily;
    return { from: dayOf(base - days * dayMs), to: today };
  }
  const r = RANGES.find((x) => x.id === rangeId) ?? RANGES[0];
  return { from: dayOf(base - r.days * dayMs), to: today };
}

/** Calendar days from a day to another (inclusive of the first, at least 1). NaN when either is not a day. */
export function daysBetween(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.max(1, Math.round((b - a) / dayMs) + 1);
}
/** Trading days in a calendar span: weekdays, less the usual exchange holidays (about 4 %). */
export function tradingDays(calendarDays) {
  if (!Number.isFinite(calendarDays) || calendarDays < 1) return 0;
  return Math.max(1, Math.round(calendarDays * (5 / 7) * 0.96));
}

// ── Symbols ──

/** "reliance", "RELIANCE" and "NSE:RELIANCE" all mean the same stock; anything with a colon is kept as typed. */
export function canonicalSymbol(text) {
  const t = String(text ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return "";
  return t.includes(":") ? t : `NSE:${t}`;
}
const SYMBOL_OK = /^[A-Z0-9]{2,10}:[A-Z0-9][A-Z0-9&_.\-]{0,60}$/;
export const MAX_SYMBOLS = 500;

/**
 * Read a pasted list (commas, spaces, new lines, semicolons, or a CSV with a header) into canonical symbols.
 * @returns {{ symbols: string[], duplicates: number, invalid: string[], over: number }}
 */
export function parseSymbolList(text, { max = MAX_SYMBOLS } = {}) {
  const out = [];
  const seen = new Set();
  const invalid = [];
  let duplicates = 0;
  for (const raw of String(text ?? "").split(/[\s,;|]+/)) {
    const t = raw.replace(/^["']|["']$/g, "");
    if (!t) continue;
    if (/^(symbol|symbols|instrument|name|ticker)$/i.test(t) && !out.length) continue; // a CSV header
    const s = canonicalSymbol(t);
    if (!SYMBOL_OK.test(s)) {
      invalid.push(t);
      continue;
    }
    if (seen.has(s)) {
      duplicates++;
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  const over = Math.max(0, out.length - max);
  return { symbols: out.slice(0, max), duplicates, invalid, over };
}

/** "NFO:NIFTY-2026-10-27-25000-CE" -> "NIFTY 27 Oct 25000 CE"; a plain symbol is shown without its exchange only when it is NSE. */
export function symbolLabel(symbol) {
  const s = String(symbol ?? "");
  const m = /^([A-Z]+):(.+)-(\d{4}-\d{2}-\d{2})-(\d+(?:\.\d+)?)-(CE|PE)$/.exec(s);
  if (m) return `${m[2]} ${dayText(m[3]).replace(/ \d{4}$/, "")} ${m[4]} ${m[5]}`;
  const f = /^([A-Z]+):(.+)-(\d{4}-\d{2}-\d{2})-FUT$/.exec(s);
  if (f) return `${f[2]} ${dayText(f[3]).replace(/ \d{4}$/, "")} future`;
  return s.startsWith("NSE:") ? s.slice(4) : s;
}

// ── Estimates before starting ──

/**
 * What a download will cost before it starts. `share` is the part of the spare broker room it may use (0 to 1).
 * @param {{ symbols: number, intervals: string[], from: string, to?: string, format?: string, share?: number, callsPerSec?: number, nowMs?: number }} o
 */
export function estimateJob({ symbols, intervals, from, to, format = "csv", share = DEFAULT_SHARE, callsPerSec = DEFAULT_CALLS_PER_SEC, nowMs = Date.now() }) {
  const n = Math.max(0, Math.floor(Number(symbols) || 0));
  const ivs = (intervals ?? []).map(intervalInfo).filter(Boolean);
  const end = to || istDay(nowMs);
  const span = daysBetween(from, end);
  if (!n || !ivs.length || !Number.isFinite(span)) return { ok: false, symbols: n, intervals: ivs.length, calendarDays: 0, tradingDays: 0, bars: 0, bytes: 0, calls: 0, seconds: null, files: 0 };
  const tdays = tradingDays(span);
  const bytesPerBar = (FORMATS.find((f) => f.id === format) ?? FORMATS[0]).bytesPerBar;
  let barsEach = 0;
  let callsEach = 0;
  for (const iv of ivs) {
    barsEach += Math.max(1, Math.round(tdays * iv.perDay));
    callsEach += Math.max(1, Math.ceil(span / (iv.intraday ? CALL_SPAN_DAYS.intraday : CALL_SPAN_DAYS.daily)));
  }
  const bars = n * barsEach;
  const calls = n * callsEach;
  const rate = Math.max(0.05, callsPerSec * Math.min(1, Math.max(0.01, share)));
  return { ok: true, symbols: n, intervals: ivs.length, calendarDays: span, tradingDays: tdays, bars, bytes: bars * bytesPerBar, calls, seconds: Math.ceil(calls / rate), files: n * ivs.length, share, callsPerSec };
}

/** The estimate as three short lines for the wizard: size, broker calls, time. */
export function estimateLines(est) {
  if (!est?.ok) return { size: "Pick symbols, bars and dates to see an estimate.", calls: "", time: "", short: "" };
  const size = `About ${formatCount(est.bars)} bars, ${formatBytes(est.bytes)} in ${plural(est.files, "file")}.`;
  const calls = `It will cost about ${plural(est.calls, "broker call")}.`;
  const t = formatDuration(est.seconds);
  const time = `${t ? `${t[0].toUpperCase()}${t.slice(1)}` : "Time unknown"} at ${formatInt(Math.round((est.share ?? DEFAULT_SHARE) * 100))}% of your spare room.`;
  return { size, calls, time, short: `${formatCount(est.bars)} bars · ${formatBytes(est.bytes)} · ${plural(est.calls, "call")} · ${t ?? DASH}` };
}

/** A warning worth showing before start (too large, or very slow), or "". */
export function estimateWarning(est) {
  if (!est?.ok) return "";
  if (est.bytes > 500 * 1024 * 1024) return "This is a very large download. Consider fewer symbols or a shorter range.";
  if (est.seconds > 6 * 3600) return "This will take a long time at your current share. It keeps going in the background and never slows live prices.";
  return "";
}

/** Rows and bytes a recording writes in one session day. A chain row is one contract per snapshot. */
export function estimateRecording({ kind = "quotes", symbolCount = 0, everySec = 30, sessionMinutes = 375, format = "csv" }) {
  const n = Math.max(0, Number(symbolCount) || 0);
  const every = Math.max(1, Number(everySec) || 30);
  const snapshots = Math.floor((sessionMinutes * 60) / every);
  const rows = n * snapshots;
  const perRow = (kind === "chain" ? 96 : 74) * (format === "jsonl" ? 1.9 : 1);
  return { rows, bytesPerDay: Math.round(rows * perRow), snapshots };
}

// ── Option universes (a collection that works out its own symbols) ──

export const COMMON_UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]);
export const EXPIRY_CHOICES = Object.freeze([
  { id: "current-weekly", label: "Current weekly expiry", count: 1 },
  { id: "next-weekly", label: "Next weekly expiry", count: 1 },
  { id: "current-monthly", label: "Current monthly expiry", count: 1 },
  { id: "all-weekly", label: "All weekly expiries", count: 4 },
]);

export function defaultUniverse(underlying = "NIFTY") {
  return { underlying, expiries: "current-weekly", strikes: { around: "atm", count: 10 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false };
}

/** The user's form as the `universe` body the Bridge stores, with sensible clamps. */
export function buildUniverse(form = {}) {
  const u = defaultUniverse(form.underlying === undefined ? "NIFTY" : String(form.underlying).trim().toUpperCase());
  if (Array.isArray(form.expiries) ? form.expiries.length : form.expiries) u.expiries = form.expiries;
  if (form.strikes?.around === "atm" || (form.strikes && form.strikes.count !== undefined)) {
    const c = Math.round(Number(form.strikes.count));
    u.strikes = { around: "atm", count: Number.isFinite(c) ? Math.min(100, Math.max(1, c)) : 10 };
  } else if (form.strikes && (form.strikes.from !== undefined || form.strikes.to !== undefined)) {
    u.strikes = { from: Number(form.strikes.from), to: Number(form.strikes.to) };
  }
  if (Array.isArray(form.sides)) u.sides = ["CE", "PE"].filter((s) => form.sides.includes(s));
  if (typeof form.includeUnderlying === "boolean") u.includeUnderlying = form.includeUnderlying;
  if (typeof form.includeFuture === "boolean") u.includeFuture = form.includeFuture;
  return u;
}

/** The first thing wrong with a universe, in plain words, or "". */
export function universeProblem(u) {
  if (!u || !String(u.underlying ?? "").trim()) return "Type the index or stock the options are on, for example NIFTY.";
  if (!/^[A-Za-z0-9&_-]{1,30}$/.test(String(u.underlying))) return "The underlying can only have letters, numbers, & and -.";
  if (!Array.isArray(u.sides) || !u.sides.length) {
    if (!u.includeUnderlying && !u.includeFuture) return "Pick calls, puts, or include the index itself. Nothing is selected.";
  }
  if (Array.isArray(u.expiries) && !u.expiries.length) return "Pick at least one expiry.";
  if (Array.isArray(u.expiries) && u.expiries.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) return "Expiry dates look like 2026-11-27.";
  if (u.strikes?.from !== undefined || u.strikes?.to !== undefined) {
    const a = Number(u.strikes.from);
    const b = Number(u.strikes.to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "Type both ends of the strike range.";
    if (a >= b) return "The first strike must be lower than the last.";
  } else if (!(Number(u.strikes?.count) >= 1)) return "Pick how many strikes either side of the current price (1 or more).";
  return "";
}

const expiryWords = (e) => (Array.isArray(e) ? (e.length === 1 ? `the ${dayText(e[0])} expiry` : `${plural(e.length, "chosen expiry", "chosen expiries")}`) : EXPIRY_CHOICES.find((c) => c.id === e)?.label.toLowerCase() ?? String(e ?? ""));
/** One sentence for what a universe means: "NIFTY calls and puts, 10 strikes either side of the current price, current weekly expiry, plus the index". */
export function universeSentence(u) {
  if (!u?.underlying) return "An option universe that is not set up yet.";
  const sides = Array.isArray(u.sides) && u.sides.length ? (u.sides.length === 2 ? "calls and puts" : u.sides[0] === "CE" ? "calls" : "puts") : "no option sides";
  const strikes = u.strikes?.from !== undefined ? `strikes ${formatInt(u.strikes.from)} to ${formatInt(u.strikes.to)}` : `${formatInt(u.strikes?.count ?? 10)} strikes either side of the current price`;
  const extra = [u.includeUnderlying ? "the index itself" : null, u.includeFuture ? "the nearest future" : null].filter(Boolean);
  return `${u.underlying} ${sides}, ${strikes}, ${expiryWords(u.expiries)}${extra.length ? `, plus ${extra.join(" and ")}` : ""}.`;
}
/** The short form used in rule rows: "NIFTY ATM +/- 10, current weekly". */
export function universeShort(u) {
  if (!u?.underlying) return "";
  const strikes = u.strikes?.from !== undefined ? [formatInt(u.strikes.from), formatInt(u.strikes.to)].join("-") : `ATM +/- ${formatInt(u.strikes?.count ?? 10)}`;
  const ex = Array.isArray(u.expiries) ? `${plural(u.expiries.length, "date")}` : (EXPIRY_CHOICES.find((c) => c.id === u.expiries)?.label ?? "").replace(" expiry", "").toLowerCase();
  return `${u.underlying} ${strikes}${ex ? `, ${ex}` : ""}`;
}

/**
 * How many symbols a universe will have (a good guess before the Bridge resolves it). `strikes` as a range cannot be
 * counted without the strike step, so it answers null and the page waits for the real answer.
 * @returns {{ count: number | null, approx: boolean }}
 */
export function universeSize(u) {
  if (!u) return { count: 0, approx: false };
  const exp = Array.isArray(u.expiries) ? u.expiries.length : (EXPIRY_CHOICES.find((c) => c.id === u.expiries)?.count ?? 1);
  const approx = u.expiries === "all-weekly";
  const sides = Array.isArray(u.sides) ? u.sides.length : 0;
  let strikes = null;
  if (u.strikes?.from === undefined) strikes = 2 * Math.max(0, Math.floor(Number(u.strikes?.count) || 0)) + 1;
  const extras = (u.includeUnderlying ? 1 : 0) + (u.includeFuture ? exp : 0);
  if (strikes === null) return { count: sides ? null : extras, approx: true };
  return { count: exp * strikes * sides + extras, approx };
}

/**
 * The preview of a resolve answer: how many symbols, a few examples, and the honest parts (when, which rule, what the
 * ATM was worked out from, and any warning). Never silently implies a stale price is live.
 * @param {object | null} res  the `data` of GET /v1/collections/{name}/resolve
 */
export function resolveModel(res, { sample = 8 } = {}) {
  if (!res) return { ok: false, count: 0, sample: [], more: 0, notes: [], atm: null, resolvedAt: null, rule: "" };
  const symbols = Array.isArray(res.symbols) ? res.symbols.map(String) : [];
  const notes = Array.isArray(res.warnings) ? res.warnings.map(String) : Array.isArray(res.notes) ? res.notes.map(String) : [];
  const a = res.atm && typeof res.atm === "object" ? res.atm : null;
  let atm = null;
  if (a) {
    const cls = classInfo({ dataClass: a.class ?? a.dataClass, delaySec: a.delaySec });
    const strike = Number.isFinite(Number(a.strike)) ? formatInt(a.strike) : null;
    const spot = Number.isFinite(Number(a.underlyingPrice ?? a.spot)) ? formatFixed(a.underlyingPrice ?? a.spot, 2) : null;
    if (a.unavailable || (!strike && !spot)) {
      atm = { tone: "warn", text: "The current price is not available right now, so the middle strike could not be worked out. Nothing was guessed.", trusted: false };
    } else if (a.stale || a.trusted === false || cls.id === "delayed" || cls.id === "eod") {
      atm = { tone: "warn", text: `The middle strike (${strike ?? DASH}) was worked out from a ${cls.label.toLowerCase()} price${spot ? ` of ${spot}` : ""}, so it may be off. Use real-time data for recording.`, trusted: false };
    } else atm = { tone: "ok", text: `The middle strike is ${strike ?? DASH}${spot ? `, from a live price of ${spot}` : ""}.`, trusted: true };
  }
  // Where the middle strike's price came from, when the Bridge says (never hidden).
  const src = res.atmSource && typeof res.atmSource === "object" ? (res.atmSource.name ?? res.atmSource.source ?? "") : String(res.atmSource ?? "");
  if (src && atm) atm = { ...atm, text: `${atm.text} Price source: ${src}.` };
  else if (src) atm = { tone: "ok", text: `The middle strike was worked out from ${src}.`, trusted: true };
  return {
    ok: true,
    count: Number.isFinite(Number(res.count)) ? Number(res.count) : symbols.length,
    sample: symbols.slice(0, sample),
    more: Math.max(0, symbols.length - sample),
    notes,
    atm,
    resolvedAt: res.resolvedAt ?? null,
    rule: typeof res.rule === "string" ? res.rule : "",
    expiries: Array.isArray(res.expiries) ? res.expiries : [],
  };
}

// ── Collections: names, tags, import, export, usage ──

/** Letters, numbers, space, dash, underscore; 1 to 40 characters. */
export function collectionNameProblem(name, existing = []) {
  const n = String(name ?? "").trim();
  if (!n) return "Give the collection a name.";
  if (n.length > 40) return "Keep the name to 40 characters or fewer.";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _\-.]*$/.test(n)) return "Use letters, numbers, spaces, dashes and underscores.";
  if (existing.some((e) => String(e).toLowerCase() === n.toLowerCase())) return "A collection with this name already exists.";
  return "";
}
/** Names as the Bridge addresses them (lower case, dashes). */
export const slug = (name) => String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** "nifty, weekly ,Weekly" -> ["nifty", "weekly"] (lower case, no repeats, 12 at most, 24 characters each). */
export function parseTags(text) {
  const out = [];
  for (const raw of Array.isArray(text) ? text : String(text ?? "").split(/[,;\n]+/)) {
    const t = String(raw).trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 24);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 12);
}
/** Every tag in a list of items, with its count, most used first. */
export function tagCounts(items) {
  const m = new Map();
  for (const it of items ?? []) for (const t of it.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
/** Items that have every chosen tag and match the search words. */
export function filterItems(items, { tags = [], query = "" } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  return (items ?? []).filter((it) => tags.every((t) => (it.tags ?? []).includes(t)) && (!q || `${it.name ?? ""} ${it.description ?? ""} ${(it.tags ?? []).join(" ")}`.toLowerCase().includes(q)));
}

/** A collection as the row shows it: what it is, how big, and its one-line rule. */
export function collectionView(c, resolvedCount = null) {
  const universe = c?.kind === "option-universe";
  const stored = Array.isArray(c?.symbols) ? c.symbols.length : Number.isFinite(Number(c?.count)) ? Number(c.count) : null;
  const size = universe ? (resolvedCount ?? universeSize(c.universe).count) : stored;
  return {
    name: c?.name ?? "",
    universe,
    kindWord: universe ? "Option universe" : "Fixed list",
    sub: universe ? universeShort(c.universe) : stored === null ? "" : plural(stored, "symbol"),
    sizeText: size === null || size === undefined ? "" : `${universe && resolvedCount === null ? "about " : ""}${plural(size, "symbol")}`,
    tags: c?.tags ?? [],
    description: c?.description ?? "",
  };
}

/** A collection as CSV text (one symbol per line under a header) or, for an option universe, its rule. */
export function collectionToCsv(c, resolved = null) {
  if (c?.kind === "option-universe") {
    const rows = ["symbol", ...(resolved?.symbols ?? [])];
    return `${rows.join("\n")}\n`;
  }
  return `${["symbol", ...(c?.symbols ?? [])].join("\n")}\n`;
}
export function collectionToJson(c) {
  const { name, description = "", tags = [], kind = "static", symbols, universe } = c ?? {};
  return `${JSON.stringify({ name, description, tags, kind, ...(kind === "option-universe" ? { universe } : { symbols: symbols ?? [] }) }, null, 2)}\n`;
}
/**
 * Read a file or pasted text back into a collection body. JSON with a `kind`, a JSON array of symbols, or a list of
 * symbols (CSV or one per line). Returns { body } or { error }.
 */
export function parseCollectionImport(text, fallbackName = "") {
  const t = String(text ?? "").trim();
  if (!t) return { error: "The file is empty." };
  if (t.startsWith("{") || t.startsWith("[")) {
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      return { error: "That is not valid JSON." };
    }
    if (Array.isArray(j)) {
      const p = parseSymbolList(j.join("\n"));
      return p.symbols.length ? { body: { name: fallbackName, description: "", tags: [], kind: "static", symbols: p.symbols } } : { error: "No symbols found in the list." };
    }
    if (j.kind === "option-universe" && j.universe) {
      const universe = buildUniverse(j.universe);
      const problem = universeProblem(universe);
      return problem ? { error: problem } : { body: { name: String(j.name ?? fallbackName), description: String(j.description ?? ""), tags: parseTags(j.tags), kind: "option-universe", universe } };
    }
    const p = parseSymbolList((j.symbols ?? []).join("\n"));
    return p.symbols.length ? { body: { name: String(j.name ?? fallbackName), description: String(j.description ?? ""), tags: parseTags(j.tags), kind: "static", symbols: p.symbols } } : { error: "No symbols found in the file." };
  }
  const p = parseSymbolList(t);
  if (!p.symbols.length) return { error: "No symbols found. Use one symbol per line, for example NSE:RELIANCE." };
  return { body: { name: fallbackName, description: "", tags: [], kind: "static", symbols: p.symbols }, skipped: p.invalid.length };
}

/**
 * Which downloads, recordings, rules and datasets use a collection (read from the lists the page already has).
 */
export function usageOf(name, { downloads = [], recordings = [], rules = [], datasets = [] } = {}) {
  const uses = (x) => (x?.collection ?? x?.request?.collection ?? null) === name;
  return {
    downloads: downloads.filter(uses),
    recordings: recordings.filter(uses),
    rules: rules.filter(uses),
    datasets: datasets.filter((d) => uses(d) || (d?.collections ?? []).includes(name)),
  };
}
export function usageText(u) {
  const parts = [];
  if (u.downloads.length) parts.push(plural(u.downloads.length, "download"));
  if (u.recordings.length) parts.push(plural(u.recordings.length, "recording"));
  if (u.rules.length) parts.push(plural(u.rules.length, "auto-record rule"));
  if (u.datasets.length) parts.push(plural(u.datasets.length, "dataset"));
  return parts.length ? `Used by ${parts.join(", ")}.` : "Not used by anything yet.";
}

// ── Downloads ──

const FAIL_WORDS = {
  SESSION_EXPIRED: ["Your broker login ended", "Log in to your broker again on Accounts, then press Retry. What was already saved is kept.", "accounts"],
  NO_ACCOUNT: ["No broker is logged in", "Log in to your broker on Accounts, then press Retry.", "accounts"],
  BROKER_UNAVAILABLE: ["No broker is logged in", "Log in to your broker on Accounts, then press Retry.", "accounts"],
  login_needed: ["Your broker login ended", "Log in to your broker again on Accounts, then press Retry. What was already saved is kept.", "accounts"],
  KILL_SWITCH_ENGAGED: ["The kill switch is on", "Downloads stop while it is on. Release it on Safety, then press Resume.", "safety"],
  kill_switch: ["The kill switch is on", "Downloads stop while it is on. Release it on Safety, then press Resume.", "safety"],
  DISK_FULL: ["The disk is nearly full", "Delete old downloads or recordings to make room, then press Retry.", null],
  disk_low: ["The disk is nearly full", "Delete old downloads or recordings to make room, then press Retry.", null],
  RATE_LIMITED: ["The broker asked the Bridge to slow down", "Nothing is lost. The Bridge waits and tries again by itself; press Retry to try now.", "sources/overview"],
  UPSTREAM_RATE_LIMITED: ["The broker asked the Bridge to slow down", "Nothing is lost. The Bridge waits and tries again by itself; press Retry to try now.", "sources/overview"],
  UPSTREAM_TIMEOUT: ["The broker did not answer", "Check your internet connection and press Retry.", null],
  restart: ["Paused when the Bridge restarted", "Press Resume to carry on where it stopped.", null],
  schedule: ["Waiting for after market hours", "It starts by itself when the market closes. Press Resume to start now.", null],
};
/** Why a job stopped, in plain words: { title, fix, route } (route is a dashboard address for the fix, or null). */
export function failureWords(job) {
  const code = job?.error?.code ?? job?.reason ?? job?.code;
  const hit = FAIL_WORDS[code];
  if (hit) return { title: hit[0], fix: hit[1], route: hit[2] };
  const message = job?.error?.message ?? (typeof job?.error === "string" ? job.error : "") ?? "";
  return { title: job?.status === "failed" ? "The download did not finish" : "Stopped", fix: message ? `${message} Press Retry to try again.` : "Press Retry to try again. What was already saved is kept.", route: null };
}
/** Is this reason something to fix on Accounts (a login is missing)? */
export const needsLogin = (code) => ["SESSION_EXPIRED", "NO_ACCOUNT", "BROKER_UNAVAILABLE", "login_needed"].includes(code);

const STATUS = {
  queued: { word: "Waiting", tone: "info" },
  running: { word: "Downloading", tone: "info" },
  paused: { word: "Paused", tone: "warn" },
  done: { word: "Done", tone: "ok" },
  failed: { word: "Failed", tone: "bad" },
  cancelled: { word: "Cancelled", tone: "" },
};

/** A name for a job that was started without one: "5m bars for 40 symbols". */
export function jobTitle(job) {
  if (job?.name) return job.name;
  const r = job?.request ?? {};
  const ivs = (r.intervals ?? []).join(", ");
  const what = r.collection ? `collection ${r.collection}` : Array.isArray(r.symbols) && r.symbols.length === 1 ? symbolLabel(r.symbols[0]) : `${plural(r.symbols?.length ?? 0, "symbol")}`;
  return `${ivs || "History"} bars, ${what}`;
}

/**
 * Everything one job row needs (pure). `actions` is the set of buttons that make sense now.
 * @param {object} job
 */
export function jobView(job, nowMs = Date.now()) {
  const st = STATUS[job?.status] ?? { word: String(job?.status ?? "Unknown"), tone: "" };
  const p = job?.progress ?? {};
  const total = Math.max(0, Number(p.total) || 0);
  const done = Math.max(0, Number(p.done) || 0);
  const failed = Math.max(0, Number(p.failed) || 0);
  const percent = job?.status === "done" ? 100 : total ? Math.min(100, Math.floor(((done + failed) / total) * 100)) : 0;
  const active = job?.status === "queued" || job?.status === "running";
  const eta = Number.isFinite(Number(p.etaSec)) ? formatDuration(p.etaSec) : null;
  const rows = Number(p.rows) || 0;
  const bytes = Number(p.bytes) || 0;
  const bits = [];
  if (total) bits.push(`${formatInt(done)} of ${plural(total, "item")}`);
  if (failed) bits.push(`${formatInt(failed)} failed`);
  if (rows) bits.push(`${formatCount(rows)} bars`);
  if (bytes) bits.push(formatBytes(bytes));
  if (job?.status === "running" && eta) bits.push(`${eta} left`);
  const cur = p.current && p.current.symbol ? `Now: ${symbolLabel(p.current.symbol)} ${p.current.interval ?? ""}`.trim() : "";
  const cls = classInfo({ dataClass: job?.dataClass, source: job?.source });
  const stopped = job?.status === "failed" || (job?.status === "paused" && (job?.reason || job?.error));
  const why = stopped ? failureWords(job) : null;
  const actions = [];
  if (job?.status === "running" || job?.status === "queued") actions.push("pause", "cancel");
  if (job?.status === "paused") actions.push("resume", "cancel");
  if (job?.status === "failed") actions.push("retry");
  if (job?.status === "done") actions.push("files");
  if (job?.status === "failed" || job?.status === "cancelled") actions.push("delete");
  if (job?.status === "done") actions.push("delete");
  return {
    id: job?.id,
    title: jobTitle(job),
    status: job?.status,
    word: st.word,
    tone: st.tone,
    active,
    percent,
    summary: bits.join(" · "),
    current: cur,
    cls,
    why,
    actions,
    when: job?.finishedAt ?? job?.startedAt ?? job?.createdAt ?? null,
    whenText: job?.finishedAt ? `Finished ${agoText(job.finishedAt, nowMs)}` : job?.startedAt ? `Started ${agoText(job.startedAt, nowMs)}` : job?.createdAt ? `Added ${agoText(job.createdAt, nowMs)}` : "",
    failedItems: (job?.items ?? []).filter((i) => i.status === "failed"),
    dataset: job?.request?.dataset ?? job?.dataset ?? null,
  };
}

/** Active jobs first (running, queued, paused), then the rest, newest first. */
export function sortJobs(jobs) {
  const rank = (j) => (j.status === "running" ? 0 : j.status === "queued" ? 1 : j.status === "paused" ? 2 : 3);
  return [...(jobs ?? [])].sort((a, b) => rank(a) - rank(b) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/** Disk use from a list answer's `meta.disk`: { tone, text, share } or null. */
export function diskView(disk) {
  if (!disk || typeof disk !== "object") return null;
  const used = Number(disk.usedBytes ?? (Number(disk.usedMb) || 0) * 1_048_576);
  const limit = Number(disk.limitBytes ?? (Number(disk.limitMb) || 0) * 1_048_576);
  const free = Number(disk.freeBytes ?? (Number(disk.freeMb) || 0) * 1_048_576);
  const share = limit > 0 ? Math.min(1, used / limit) : null;
  const low = disk.low === true || (share !== null && share >= 0.9) || (Number.isFinite(free) && free > 0 && free < 500 * 1_048_576);
  const text = limit > 0 ? `${formatBytes(used)} of ${formatBytes(limit)} used` : Number.isFinite(used) && used > 0 ? `${formatBytes(used)} used` : "";
  return { low, tone: low ? "warn" : "ok", text, share, used, limit, free };
}

// ── Recordings and auto-record ──

const REC_STATUS = {
  running: { word: "Recording", tone: "ok" },
  waiting: { word: "Waiting for the market", tone: "info" },
  paused: { word: "Paused", tone: "warn" },
  stopped: { word: "Stopped", tone: "" },
  failed: { word: "Failed", tone: "bad" },
  login_needed: { word: "Needs a login", tone: "warn" },
  disk_low: { word: "Stopped, disk low", tone: "bad" },
};
const REC_WHY = {
  login_needed: ["No broker login right now", "It starts by itself as soon as a price feed is available. Log in on Accounts.", "accounts"],
  SESSION_EXPIRED: ["Your broker login ended", "Log in again on Accounts. It carries on by itself.", "accounts"],
  disk_low: ["The disk is nearly full", "The recording stopped writing so the disk does not fill up. Delete old recordings or raise the limit.", null],
  feed_silent: ["The price feed went quiet", "A gap is marked in the file. It carries on when prices come back.", null],
  kill_switch: ["The kill switch is on", "Release it on Safety and the recording continues.", "safety"],
};

/** Everything one recording row needs. */
export function recordingView(rec, nowMs = Date.now()) {
  const code = rec?.reason ?? rec?.error?.code ?? (rec?.status === "disk_low" ? "disk_low" : rec?.loginNeeded ? "login_needed" : null);
  const status = REC_STATUS[rec?.status] ? rec.status : rec?.status === "recording" ? "running" : (rec?.status ?? "stopped");
  const st = REC_STATUS[status] ?? { word: String(status), tone: "" };
  const gaps = Array.isArray(rec?.gaps) ? rec.gaps.length : Number(rec?.gaps) || 0;
  const symbolCount = Number.isFinite(Number(rec?.symbolCount)) ? Number(rec.symbolCount) : Array.isArray(rec?.symbols) ? rec.symbols.length : null;
  const bits = [];
  if (rec?.kind === "chain") bits.push(rec.underlying ? `${rec.underlying} option chain` : "Option chain");
  else if (symbolCount !== null) bits.push(plural(symbolCount, "symbol"));
  if (rec?.everySec) bits.push(`every ${rec.everySec} s`);
  const stats = [];
  if (Number(rec?.rows) > 0) stats.push(`${formatCount(rec.rows)} rows`);
  if (Number(rec?.bytes) > 0) stats.push(formatBytes(rec.bytes));
  if (rec?.lastWriteAt) stats.push(`last write ${istClock(rec.lastWriteAt)}`);
  if (gaps) stats.push(plural(gaps, "gap"));
  const why = code && REC_WHY[code] && (status !== "running" || code === "feed_silent") ? { title: REC_WHY[code][0], fix: REC_WHY[code][1], route: REC_WHY[code][2] } : null;
  const actions = [];
  if (status === "running" || status === "waiting" || status === "login_needed") actions.push("pause", "stop");
  if (status === "paused") actions.push("resume", "stop");
  if (status === "disk_low" || status === "failed") actions.push("resume");
  actions.push("files");
  if (status === "stopped" || status === "failed") actions.push("delete");
  return {
    id: rec?.id,
    title: rec?.name || `${rec?.kind === "chain" ? "Option chain" : "Quotes"} recording`,
    status,
    word: st.word,
    tone: st.tone,
    sub: bits.join(" · "),
    stats: stats.join(" · "),
    gaps,
    why,
    cls: classInfo({ dataClass: rec?.dataClass ?? "realtime", source: rec?.source }),
    actions,
    live: status === "running",
    startedText: rec?.startedAt ? `Started ${agoText(rec.startedAt, nowMs)}` : "",
  };
}

/** One sentence for a schedule: "during market hours" or "Mon to Fri, with your own hours". */
export function scheduleText(s) {
  if (!s || s === "market-hours") return "during market hours";
  if (typeof s === "object") {
    const days = Array.isArray(s.days) && s.days.length ? s.days.join(", ") : "trading days";
    return `${days}, ${s.start ?? "market open"} to ${s.end ?? "market close"} IST`;
  }
  return String(s);
}

/** A rule in plain words: "NIFTY ATM +/- 10, current weekly, every 30 s, during market hours". */
export function ruleSentence(rule, collections = []) {
  const what = rule?.collection
    ? (() => {
        const c = collections.find((x) => x.name === rule.collection);
        return c ? `Collection ${rule.collection}${c.kind === "option-universe" ? ` (${universeShort(c.universe)})` : ""}` : `Collection ${rule.collection}`;
      })()
    : rule?.universe
      ? `${universeShort({ ...rule.universe, underlying: rule.underlying ?? rule.universe.underlying })} ${rule.kind === "chain" ? "option chain" : ""}`.trim()
      : Array.isArray(rule?.symbols)
        ? plural(rule.symbols.length, "symbol")
        : rule?.underlying
          ? `${rule.underlying} option chain`
          : "Nothing chosen";
  return `${what}, every ${rule?.everySec ?? 30} s, ${scheduleText(rule?.schedule)}`;
}

const RULE_STATUS = {
  recording: { word: "Recording now", tone: "ok" },
  waiting: { word: "Waiting for the market", tone: "info" },
  login_needed: { word: "Needs a login", tone: "warn" },
  disk_low: { word: "Stopped, disk low", tone: "bad" },
  failed: { word: "Failed", tone: "bad" },
  off: { word: "Off", tone: "" },
  on: { word: "On", tone: "info" },
};
export function ruleStatus(rule) {
  if (rule?.enabled === false) return { id: "off", ...RULE_STATUS.off };
  const id = RULE_STATUS[rule?.status] ? rule.status : rule?.status === "running" ? "recording" : "on";
  return { id, ...RULE_STATUS[id] };
}

/**
 * "Recording today: 3 rules, 41 symbols, 18 MB, last write 09:31:02", or why it is quiet.
 * @param {{ rules?: object[], recordings?: object[], nowMs?: number }} o
 */
export function autoRecordSummary({ rules = [], recordings = [] } = {}) {
  const on = rules.filter((r) => r.enabled !== false);
  if (!rules.length) return { tone: "", headline: "Auto-record is off", detail: "Pick a preset or add a rule and the Bridge records by itself every trading day.", on: 0 };
  if (!on.length) return { tone: "", headline: "Auto-record is off", detail: `${plural(rules.length, "rule")} saved, none turned on.`, on: 0 };
  const running = recordings.filter((r) => r.status === "running" && (r.ruleId || r.rule));
  const loginNeeded = on.some((r) => r.status === "login_needed");
  if (!running.length) {
    return loginNeeded
      ? { tone: "warn", headline: "Waiting for a broker login", detail: `${plural(on.length, "rule")} on. Recording starts by itself as soon as a price feed is available.`, on: on.length }
      : { tone: "info", headline: "Nothing recording right now", detail: `${plural(on.length, "rule")} on. They start at the next market session.`, on: on.length };
  }
  const symbols = running.reduce((a, r) => a + (Number.isFinite(Number(r.symbolCount)) ? Number(r.symbolCount) : (r.symbols?.length ?? 0)), 0);
  const bytes = running.reduce((a, r) => a + (Number(r.bytesToday ?? r.bytes) || 0), 0);
  const last = running.map((r) => Date.parse(r.lastWriteAt ?? "")).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const parts = [plural(on.length, "rule"), plural(symbols, "symbol")];
  if (bytes) parts.push(formatBytes(bytes));
  if (last) parts.push(`last write ${istClock(new Date(last).toISOString())}`);
  return { tone: "ok", headline: `Recording today: ${parts.join(", ")}`, detail: "", on: on.length };
}

/** The one-click auto-record presets. `build` makes the rule bodies to POST (one per rule). */
export const RECORD_PRESETS = Object.freeze([
  {
    id: "index-chains",
    title: "Record index option chains",
    sub: "NIFTY and BANKNIFTY, ATM +/- 10, current weekly expiry, every 30 s, during market hours",
    needs: null,
    build: () =>
      ["NIFTY", "BANKNIFTY"].map((u) => ({ name: `${u} option chain`, enabled: true, kind: "chain", underlying: u, universe: { ...defaultUniverse(u), includeUnderlying: true }, everySec: 30, schedule: "market-hours", format: "csv" })),
  },
  {
    id: "my-watchlist",
    title: "Record my watchlist",
    sub: "Prices of a collection you pick, every 5 s, during market hours",
    needs: "collection",
    build: ({ collection }) => [{ name: `Watchlist ${collection}`, enabled: true, kind: "quotes", collection, everySec: 5, schedule: "market-hours", format: "csv" }],
  },
]);

/** What a preset will do, with the size it is expected to write (for the confirm sheet). */
export function presetPlan(preset, { collection, collectionSize = null } = {}) {
  const bodies = preset.build({ collection });
  const est = bodies.map((b) => {
    const n = b.kind === "chain" ? (universeSize(b.universe).count ?? 0) : (collectionSize ?? 0);
    return estimateRecording({ kind: b.kind, symbolCount: n, everySec: b.everySec, format: b.format });
  });
  return { bodies, bytesPerDay: est.reduce((a, e) => a + e.bytesPerDay, 0), symbols: est.length ? bodies.reduce((a, b) => a + (b.kind === "chain" ? (universeSize(b.universe).count ?? 0) : (collectionSize ?? 0)), 0) : 0 };
}

/** The first thing wrong with a rule or recording form, or "". */
export function recordingProblem(f) {
  const every = Number(f.everySec);
  const min = f.kind === "chain" ? 15 : 1;
  if (!Number.isFinite(every) || every < min) return f.kind === "chain" ? "An option chain can be saved at most every 15 seconds." : "Prices can be saved at most every second.";
  if (f.kind === "chain") {
    if (!f.collection && !String(f.underlying ?? "").trim()) return "Pick a collection or type the index to record, for example NIFTY.";
  } else if (!f.collection && !(f.symbols ?? []).length) return "Pick a collection or paste the symbols to record.";
  if (f.custom && (!f.start || !f.end)) return "Pick the start and end time, or choose market hours.";
  if (f.keepDays !== undefined && f.keepDays !== null && f.keepDays !== "" && !(Number(f.keepDays) >= 1)) return "Keep days must be 1 or more, or empty to keep everything.";
  return "";
}

// ── Datasets ──

/** A dataset as its row shows it. */
export function datasetView(d, nowMs = Date.now()) {
  const cls = classInfo({ dataClass: d?.dataClass, source: d?.source, delaySec: d?.delaySec });
  const syms = Array.isArray(d?.symbols) ? d.symbols.length : Number.isFinite(Number(d?.symbolCount)) ? Number(d.symbolCount) : null;
  const ivs = Array.isArray(d?.intervals) ? d.intervals.join(", ") : (d?.interval ?? "");
  const bits = [];
  if (syms !== null) bits.push(plural(syms, "symbol"));
  if (ivs) bits.push(ivs);
  if (Number(d?.rows) > 0) bits.push(`${formatCount(d.rows)} bars`);
  if (Number(d?.bytes) > 0) bits.push(formatBytes(d.bytes));
  return {
    name: d?.name ?? "",
    title: d?.title ?? d?.name ?? "",
    sub: bits.join(" · "),
    range: rangeText(d?.firstBar, d?.lastBar),
    updated: d?.updatedAt ? `Updated ${agoText(d.updatedAt, nowMs)}` : "",
    cls,
    tags: d?.tags ?? [],
    collection: d?.collection ?? null,
  };
}

// ── The saving API calls card ──

export const SAVED_LABELS = Object.freeze([
  ["servedFromLocal", "Stored data"],
  ["servedFromStream", "Live stream"],
  ["servedFromCache", "Remembered answers"],
  ["coalesced", "Shared requests"],
  ["batched", "Batched"],
]);
/** { total, parts: [[label, count]] } from the savings in GET /v1/usage (and any new counters it grows). */
export function savedSummary(savings) {
  const s = savings && typeof savings === "object" ? savings : {};
  const parts = SAVED_LABELS.map(([k, label]) => [label, Math.max(0, Number(s[k]) || 0)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = parts.reduce((a, [, n]) => a + n, 0);
  return { total, parts, local: Math.max(0, Number(s.servedFromLocal) || 0) };
}
/** The range the Bridge accepts for the share (PATCH /v1/downloads/settings): 5 to 80 percent. */
export const SHARE_MIN_PERCENT = 5;
export const SHARE_MAX_PERCENT = 80;
/** A share (0 to 1) as the slider's whole percent, kept to 5 to 80 in steps of 5. */
export const sharePercent = (share) => {
  const v = Number(share);
  return Number.isFinite(v) ? Math.min(SHARE_MAX_PERCENT, Math.max(SHARE_MIN_PERCENT, Math.round((v * 100) / 5) * 5)) : Math.round(DEFAULT_SHARE * 100);
};
export function shareSentence(percent) {
  const p = Math.round(Number(percent));
  const w = p <= 20 ? "very gently" : p <= 40 ? "gently" : p <= 70 ? "a fair share" : "most of what is spare";
  return `Downloads and recordings may use up to ${p}% of the room your broker leaves free, so they work ${w}. Live prices, orders and risk checks always go first.`;
}

// ── The client (routes) ──

const unavailable = (e) => Boolean(e) && (e.status === 404 || e.status === 405 || e.status === 501);
/** True when a failed call means "this Bridge does not have that route (yet)". */
export const isUnavailable = unavailable;

/**
 * The routes this page uses, over any `call(method, path, body)` that returns the parsed JSON body of an answer
 * ({ data, meta }) and throws an error with `status` and `code` for a failed one. The dashboard passes a wrapper of its
 * own api(); a test passes a fetch to a fake Bridge. Each method answers { data, meta }.
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} call
 */
export function createDataClient(call) {
  const e = encodeURIComponent;
  const out = async (method, path, body) => {
    const r = await call(method, path, body);
    return { data: r?.data ?? null, meta: r?.meta ?? {} };
  };
  const qs = (o) => {
    const p = Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
    return p.length ? `?${p.map(([k, v]) => `${e(k)}=${e(v)}`).join("&")}` : "";
  };
  return {
    downloads: {
      list: (o) => out("GET", `/v1/downloads${qs(o)}`),
      get: (id) => out("GET", `/v1/downloads/${e(id)}`),
      create: (body) => out("POST", "/v1/downloads", body),
      pause: (id) => out("POST", `/v1/downloads/${e(id)}/pause`),
      resume: (id) => out("POST", `/v1/downloads/${e(id)}/resume`),
      cancel: (id) => out("POST", `/v1/downloads/${e(id)}/cancel`),
      remove: (id) => out("DELETE", `/v1/downloads/${e(id)}`),
      files: (id) => out("GET", `/v1/downloads/${e(id)}/files`),
      settings: () => out("GET", "/v1/downloads/settings"),
      setSettings: (body) => out("PATCH", "/v1/downloads/settings", body),
    },
    datasets: {
      list: (o) => out("GET", `/v1/datasets${qs(o)}`),
      get: (name) => out("GET", `/v1/datasets/${e(name)}`),
      update: (name) => out("POST", `/v1/datasets/${e(name)}/update`),
      patch: (name, body) => out("PATCH", `/v1/datasets/${e(name)}`, body),
    },
    recordings: {
      list: () => out("GET", "/v1/recordings"),
      get: (id) => out("GET", `/v1/recordings/${e(id)}`),
      create: (body) => out("POST", "/v1/recordings", body),
      pause: (id) => out("POST", `/v1/recordings/${e(id)}/pause`),
      resume: (id) => out("POST", `/v1/recordings/${e(id)}/resume`),
      stop: (id) => out("POST", `/v1/recordings/${e(id)}/stop`),
      remove: (id) => out("DELETE", `/v1/recordings/${e(id)}`),
      files: (id) => out("GET", `/v1/recordings/${e(id)}/files`),
      settings: () => out("GET", "/v1/recordings/settings"),
      setSettings: (body) => out("PATCH", "/v1/recordings/settings", body),
      rules: {
        list: () => out("GET", "/v1/recordings/rules"),
        create: (body) => out("POST", "/v1/recordings/rules", body),
        patch: (id, body) => out("PATCH", `/v1/recordings/rules/${e(id)}`, body),
        remove: (id) => out("DELETE", `/v1/recordings/rules/${e(id)}`),
      },
    },
    collections: {
      list: () => out("GET", "/v1/collections"),
      get: (name) => out("GET", `/v1/collections/${e(name)}`),
      create: (body) => out("POST", "/v1/collections", body),
      patch: (name, body) => out("PATCH", `/v1/collections/${e(name)}`, body),
      remove: (name) => out("DELETE", `/v1/collections/${e(name)}`),
      resolve: (name, o = {}) => out("GET", `/v1/collections/${e(name)}/resolve${o.allowStale ? "?allowStale=1" : ""}`),
      duplicate: (name, body) => out("POST", `/v1/collections/${e(name)}/duplicate`, body),
      /** Resolve an option universe that is not saved yet (a dry run). */
      resolveDraft: (universe) => out("POST", "/v1/collections/resolve", { kind: "option-universe", universe }),
    },
    usage: () => out("GET", "/v1/usage"),
    accounts: () => out("GET", "/v1/accounts"),
    searchInstruments: (q, o) => out("GET", `/v1/instruments/search${qs({ q, limit: 12, ...o })}`),
  };
}

/** True when no account can read prices (none has a connected session). Demo and paper accounts count as connected. */
export function noLogin(accounts, demo = false) {
  if (demo) return false;
  if (!Array.isArray(accounts)) return false;
  if (!accounts.length) return true;
  return !accounts.some((a) => a?.broker === "paper" || a?.broker === "demo" || a?.session?.state === "connected");
}

/**
 * Why a resolve was refused, in plain words: a delayed or end-of-day price (422) or a stale one (503) is never used for the
 * middle strike unless the person asks to see it anyway (then the answer is labelled). null for any other failure.
 */
export function staleAtmNotice(err) {
  if (err?.status === 422) return { title: "The price is not real-time", text: "The middle strike needs a real-time price, and the only price available is delayed or end of day. Nothing was guessed. You can still see the symbols it would pick from that price, clearly labelled, but do not use them for recording." };
  if (err?.status === 503) return { title: "The price is out of date", text: "The latest price is too old to trust for the middle strike, so no symbols were worked out. Log in to your broker or wait for prices to resume. You can still see a labelled guess." };
  return null;
}
