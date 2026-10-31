// option-scans.js: the Option Screener's ready-made contract scans (Screeners › Options, the Scans tab), pure.
// Thirteen scans in four families (Price, Open interest, Build-up, Volume), each one plain question over the per-strike
// records the sweep already holds (screens.js chainRecords): no network per scan. Plus the plain-word reading of a row,
// the cautions that make a list mislead (a tiny starting base, a wide quote, thin trade), the per-scan counts, the
// symbol search and the saved scans. No DOM, no fetch: tested in option-scans.test.mjs. Numbers become text through
// format.js only. Copy is neutral: a row says what the numbers did, never what to do.

import { DASH, formatCompact, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";

const num = (v) => (isFigure(v) ? Number(v) : null);

/** A change in % needs a real base: the premium the change starts from (₹) and the open interest it starts from (lots). */
export const START_PREMIUM = 2;
export const START_OI_LOTS = 50;
/** A quote wider than this share of its middle (%) is flagged; fewer lots traded than this is thin. */
export const WIDE_SPREAD = 5;
export const THIN_LOTS = 10;

/** Families, in picker order. */
export const SCAN_FAMILIES = Object.freeze([
  { id: "price", label: "Price" },
  { id: "oi", label: "Open interest" },
  { id: "buildup", label: "Build-up" },
  { id: "volume", label: "Volume" },
]);

// ── Per-record facts the scans read (worked out once per record, cached on it) ──

/**
 * The few figures the scans need beyond the record: where the premium and the open interest started, the change in
 * % against a real base, and volume against the starting position. Missing inputs give null, never 0.
 * @param {object} r a contract record (screens.js chainRecords → legs)
 */
export function scanFacts(r) {
  if (!r) return { prevPrice: null, startOiLots: null, oiPct: null, volStartOi: null, oiNew: false };
  if (r.__sf) return r.__sf;
  const lot = num(r.lot) > 0 ? Number(r.lot) : null;
  const ltp = num(r.ltp);
  const chg = num(r.changePct);
  const prevPrice = ltp !== null && chg !== null && chg > -100 ? ltp / (1 + chg / 100) : null;
  const oi = num(r.oi);
  const d = num(r.oiChange);
  const start = oi !== null && d !== null ? oi - d : null;
  const startOiLots = start !== null && lot ? start / lot : null;
  const based = startOiLots !== null && startOiLots >= START_OI_LOTS - 1e-9;
  const oiPct = based && d !== null ? (d / start) * 100 : null;
  const volLots = num(r.volLots) ?? (num(r.volume) !== null && lot ? r.volume / lot : null);
  const volStartOi = based && volLots !== null ? volLots / startOiLots : null;
  const sf = { prevPrice, startOiLots, oiPct, volStartOi, oiNew: start === 0 && d !== null && d > 0 };
  try {
    Object.defineProperty(r, "__sf", { value: sf, enumerable: false, configurable: true });
  } catch {
    /* a frozen record: work it out again next time */
  }
  return sf;
}

const pricedFrom = (r) => {
  const p = scanFacts(r).prevPrice;
  return p !== null && p >= START_PREMIUM - 1e-9;
};

/**
 * The thirteen scans. `sort` names a column of the Scans tab (screens.js) and its direction; `side` colours the
 * scan's marker: "up" (green), "down" (red) or "flow" (neutral activity). `plain` is the one question it answers.
 */
const RAW = [
  { id: "gainers", family: "price", label: "Top gainers", side: "up", sort: { by: "changePct", dir: "desc" }, plain: "Premium up the most since the previous close (from at least ₹2).", test: (r) => num(r.changePct) > 0 && pricedFrom(r) },
  { id: "losers", family: "price", label: "Top losers", side: "down", sort: { by: "changePct", dir: "asc" }, plain: "Premium down the most since the previous close (from at least ₹2).", test: (r) => num(r.changePct) < 0 && pricedFrom(r) },
  { id: "oi-gainers", family: "oi", label: "OI added", side: "up", sort: { by: "oiChangeLots", dir: "desc" }, plain: "Open interest added today, most lots first.", test: (r) => num(r.oiChange) > 0 },
  { id: "oi-losers", family: "oi", label: "OI closed", side: "down", sort: { by: "oiChangeLots", dir: "asc" }, plain: "Open interest closed today, most lots first.", test: (r) => num(r.oiChange) < 0 },
  { id: "oi-pct-gainers", family: "oi", label: "OI % added", side: "up", sort: { by: "oiPct", dir: "desc" }, plain: "Open interest added as a share of where it started (from at least 50 lots).", test: (r) => num(scanFacts(r).oiPct) > 0 },
  { id: "oi-pct-losers", family: "oi", label: "OI % closed", side: "down", sort: { by: "oiPct", dir: "asc" }, plain: "Open interest closed as a share of where it started (from at least 50 lots).", test: (r) => num(scanFacts(r).oiPct) < 0 },
  { id: "long-buildup", family: "buildup", label: "Long build-up", side: "up", sort: { by: "oiChangeLots", dir: "desc" }, plain: "Premium up and open interest up: positions added as the price rose.", test: (r) => r.tag === "LB" },
  { id: "short-buildup", family: "buildup", label: "Short build-up", side: "down", sort: { by: "oiChangeLots", dir: "desc" }, plain: "Premium down and open interest up: positions added as the price fell.", test: (r) => r.tag === "SB" },
  { id: "short-covering", family: "buildup", label: "Short covering", side: "up", sort: { by: "oiChangeLots", dir: "asc" }, plain: "Premium up and open interest down: positions closed as the price rose.", test: (r) => r.tag === "SC" },
  { id: "long-unwinding", family: "buildup", label: "Long unwinding", side: "down", sort: { by: "oiChangeLots", dir: "asc" }, plain: "Premium down and open interest down: positions closed as the price fell.", test: (r) => r.tag === "LU" },
  { id: "most-active", family: "volume", label: "Most active", side: "flow", sort: { by: "turnover", dir: "desc" }, plain: "Where the most money traded today (volume × price).", test: (r) => num(r.turnover) > 0 },
  { id: "volume-surge", family: "volume", label: "Volume surge", side: "flow", sort: { by: "volOiRel", dir: "desc" }, plain: "Volume against open interest well above the rest of its own chain (at least 2× its median).", test: (r) => num(r.volOiRel) >= 2 },
  { id: "volume-over-oi", family: "volume", label: "Volume above OI", side: "flow", sort: { by: "volStartOi", dir: "desc" }, plain: "More lots traded today than were open at the start (from at least 50 lots).", test: (r) => num(scanFacts(r).volStartOi) > 1 },
];
export const CONTRACT_SCANS = Object.freeze(RAW.map((s) => Object.freeze({ ...s, sort: Object.freeze(s.sort) })));
export const SCAN_IDS = Object.freeze(CONTRACT_SCANS.map((s) => s.id));
export const DEFAULT_SCAN = "gainers";
/** The scan by id; an unknown id is the default scan. */
export const scanById = (id) => CONTRACT_SCANS.find((s) => s.id === id) ?? CONTRACT_SCANS[0];
/** The scans of one family, in order. */
export const scansOf = (family) => CONTRACT_SCANS.filter((s) => s.family === family);
/** The family a scan belongs to. */
export const familyOf = (id) => scanById(id).family;

/** Does a record meet a scan? */
export const meetsScan = (r, id) => Boolean(r) && scanById(id).test(r);

/**
 * How many records meet each scan (the counts on the scan chips): `rows` are the records that already pass every
 * other setting, so a count always matches the list that chip opens.
 * @returns {Record<string, number>}
 */
export function scanCounts(rows) {
  const out = Object.fromEntries(SCAN_IDS.map((id) => [id, 0]));
  for (const r of rows ?? []) for (const s of CONTRACT_SCANS) if (s.test(r)) out[s.id]++;
  return out;
}

// ── Readings ──

const lotsText = (v) => `${formatCompact(Math.abs(v))} ${Math.abs(Math.round(v)) === 1 ? "lot" : "lots"}`;
const PATTERN = {
  LB: "Positions added as the premium rose",
  SB: "Positions added as the premium fell",
  SC: "Positions closed as the premium rose",
  LU: "Positions closed as the premium fell",
};
/** The plain sentence for a build-up tag, or "" for no clear pattern. */
export const patternText = (tag) => PATTERN[tag] ?? "";

/**
 * The table's Reading column, whatever the scan: the build-up pattern in words when there is one, else what the
 * premium did, else what traded. "" when nothing is known.
 */
export function rowReading(r) {
  if (!r) return "";
  const pattern = patternText(r.tag);
  if (pattern) return pattern;
  const chg = num(r.changePct);
  if (chg !== null && chg !== 0) return `Premium ${chg > 0 ? "up" : "down"} ${formatFixed(Math.abs(chg), 1)}%, no clear OI pattern`;
  const vl = num(r.volLots);
  if (vl !== null && vl > 0) return `${lotsText(vl)} traded, premium flat`;
  return "";
}

/**
 * The cautions that make a row mislead (the scanner's traps): a change on a tiny base, a wide quote, thin trade, the
 * expiry day. Short words, most important first.
 * @returns {string[]}
 */
export function cautions(r) {
  if (!r) return [];
  const out = [];
  const sf = scanFacts(r);
  if (sf.oiNew) out.push("Opened from zero");
  else if (sf.startOiLots !== null && sf.startOiLots < START_OI_LOTS && num(r.oiChange) !== null && r.oiChange !== 0) out.push("Small base");
  if (num(r.spread) !== null && r.spread > WIDE_SPREAD) out.push("Wide quote");
  const vl = num(r.volLots);
  if (vl !== null && vl < THIN_LOTS) out.push("Thin trade");
  if (num(r.days) !== null && r.days < 1) out.push("Expiry day");
  return out;
}

/**
 * One line in plain words: what the row's numbers did, for the scan it is on. The pattern when there is one, then the
 * scan's own figure. Missing figures are skipped, never shown as 0.
 * @returns {{ text: string, caution: string, tone: "pos" | "neg" | null }}
 */
export function scanReading(r, id) {
  if (!r) return { text: "", caution: "", tone: null };
  const s = scanById(id);
  const sf = scanFacts(r);
  const chg = num(r.changePct);
  const dLots = num(r.oiChangeLots);
  const parts = [];
  const pattern = patternText(r.tag);
  if (s.family === "price") {
    if (chg !== null) parts.push(`Premium ${chg >= 0 ? "up" : "down"} ${formatFixed(Math.abs(chg), 1)}%${sf.prevPrice !== null ? ` from ₹${formatFixed(sf.prevPrice, 2)}` : ""}`);
    if (pattern) parts.push(pattern.replace(/ as the premium (rose|fell)$/, "").toLowerCase());
  } else if (s.family === "oi") {
    if (dLots !== null && dLots !== 0) parts.push(`${lotsText(dLots)} ${dLots > 0 ? "added" : "closed"}${num(sf.oiPct) !== null ? ` (${formatSigned(sf.oiPct, 1)}%)` : sf.oiNew ? " (new)" : ""}`);
    if (chg !== null) parts.push(`premium ${formatSigned(chg, 1)}%`);
  } else if (s.family === "buildup") {
    if (pattern) parts.push(pattern);
    if (dLots !== null && dLots !== 0) parts.push(lotsText(dLots));
  } else {
    if (s.id === "volume-surge" && num(r.volOiRel) !== null) parts.push(`${formatFixed(r.volOiRel, 1)}× its chain's usual turnover`);
    else if (s.id === "volume-over-oi" && num(sf.volStartOi) !== null) parts.push(`Traded ${formatFixed(sf.volStartOi, 1)}× the lots open at the start`);
    else if (num(r.volLots) !== null) parts.push(`${lotsText(r.volLots)} traded`);
    if (pattern) parts.push(pattern.toLowerCase());
  }
  const text = parts.filter(Boolean).join(" · ") || DASH;
  const tone = s.side === "up" ? "pos" : s.side === "down" ? "neg" : chg === null || chg === 0 ? null : chg > 0 ? "pos" : "neg";
  return { text, caution: cautions(r).join(" · "), tone };
}

/**
 * The model's chance an option ends out of the money at expiry, 0..1: a call at or below its strike, a put at or above
 * it. `probBelow(x)` is P(price at expiry < x) (options.js probBelow on the forward at the leg's IV). Null without it.
 */
export function chanceWorthless(right, strike, probBelow) {
  const K = num(strike);
  if (K === null || typeof probBelow !== "function") return null;
  const p = num(probBelow(K));
  if (p === null) return null;
  return right === "PE" ? 1 - p : p;
}
/** "85.2%", "> 99.9%", "< 0.1%": a model reading never prints a certainty. */
export function worthlessText(p) {
  const v = num(p);
  if (v === null) return DASH;
  if (v > 0.999) return "> 99.9%";
  if (v < 0.001) return "< 0.1%";
  return `${formatFixed(v * 100, 1)}%`;
}

// ── Symbol search ──

/**
 * Does an underlying match the search box? A whole symbol means that underlying alone (NIFTY is not BANKNIFTY);
 * anything shorter than a known symbol finds every symbol containing it. Empty matches everything.
 * @param {string} query @param {string} underlying @param {string[]} [known] every symbol on the list
 */
export function symbolMatch(query, underlying, known = []) {
  const q = String(query ?? "").trim().toUpperCase();
  if (!q) return true;
  const u = String(underlying ?? "").toUpperCase();
  if ((known ?? []).some((k) => String(k).toUpperCase() === q)) return u === q;
  return u.includes(q);
}

// ── Saved scans ──

export const SAVED_MAX = 12;
export const NAME_MAX = 40;
const squash = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/** A saved list as stored (mcb.dashboard.screener.saved), validated: bad entries dropped, newest first, capped. */
export function normaliseSavedScans(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const name = squash(e.name).slice(0, NAME_MAX);
    if (!name || typeof e.preset !== "string" || !e.preset) continue;
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const sort = e.sort && typeof e.sort.by === "string" && (e.sort.dir === "asc" || e.sort.dir === "desc") ? { by: e.sort.by, dir: e.sort.dir } : null;
    out.push({ id: typeof e.id === "string" && e.id ? e.id : `s${out.length}`, name, preset: e.preset, filters: e.filters && typeof e.filters === "object" && !Array.isArray(e.filters) ? e.filters : {}, sort, at: num(e.at) ?? 0 });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, SAVED_MAX);
}

/**
 * Save the screen in use under a name: a name already saved (any case) is replaced in place of a second copy; the
 * newest goes first and the oldest beyond SAVED_MAX drops off. Returns the new list and the saved entry.
 * @param {object[]} list @param {{ name: string, preset: string, filters: object, sort: object }} entry
 */
export function addSavedScan(list, { name, preset, filters, sort }, at = Date.now()) {
  const n = squash(name).slice(0, NAME_MAX);
  if (!n || !preset) return { list: normaliseSavedScans(list), entry: null };
  const prev = normaliseSavedScans(list);
  const same = prev.find((x) => x.name.toLowerCase() === n.toLowerCase());
  const entry = { id: same?.id ?? `s${at.toString(36)}${prev.length}`, name: n, preset, filters: structuredClone(filters ?? {}), sort: sort ? { by: sort.by, dir: sort.dir } : null, at };
  return { list: normaliseSavedScans([entry, ...prev.filter((x) => x !== same)]), entry };
}
/** The list without one entry. */
export const removeSavedScan = (list, id) => normaliseSavedScans(list).filter((x) => x.id !== id);

/** The screener config patch that opens a saved scan (screens.js screenerConfig validates what it gets). */
export function savedScanPatch(cfg, entry) {
  if (!entry) return null;
  const p = entry.preset;
  return { preset: p, filters: { ...(cfg?.filters ?? {}), [p]: { ...(cfg?.filters?.[p] ?? {}), ...entry.filters } }, ...(entry.sort ? { sort: { ...(cfg?.sort ?? {}), [p]: { ...entry.sort } } } : {}) };
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The saved scan the screen shows now (same tab, every saved filter value and sort), or null. */
export function activeSavedScan(cfg, list) {
  for (const e of list ?? []) {
    if (cfg?.preset !== e.preset) continue;
    const f = cfg.filters?.[e.preset] ?? {};
    if (!Object.entries(e.filters ?? {}).every(([k, v]) => same(f[k], v))) continue;
    if (e.sort && !same(cfg.sort?.[e.preset], e.sort)) continue;
    return e.id;
  }
  return null;
}

/** The name a save sheet offers: the scan or tab and the side, e.g. "Top gainers · CE", made unique against the list. */
export function suggestScanName(base, list = [], extra = "") {
  const root = squash([base, extra].filter(Boolean).join(" · ")).slice(0, NAME_MAX - 4) || "My scan";
  const taken = new Set((list ?? []).map((x) => String(x.name).toLowerCase()));
  if (!taken.has(root.toLowerCase())) return root;
  for (let i = 2; i < 100; i++) if (!taken.has(`${root} ${i}`.toLowerCase())) return `${root} ${formatInt(i)}`;
  return root;
}
