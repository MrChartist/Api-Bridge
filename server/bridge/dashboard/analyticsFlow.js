// Analytics, flow and volatility pages: Unusual activity, Market tide, Exposure (by strike, by expiry, OI explorer),
// and Screener and Vol (contract screener, vol stats, NSE deals, insiders and events).
//
// Same rules as analyticsViews.js and analyticsMore.js, whose helpers it builds on: this Bridge only (no external
// requests), inline SVG made by the DOM, heatmaps as HTML tables with cell classes, colours from classes in app.css
// (section 17, theme tokens, light and dark), no style attributes, numbers printed with format.js. The maths that
// decides geometry, wording and request building is pure and exported for analyticsFlow.test.mjs; only the functions
// further down touch the DOM. views.js adds the pages with analyticsFlowPages(() => helpers) after the other
// analytics pages.
import { alertBox, api, emptyState, h, icon, istTime, optional, pill, table } from "./app.js";
import { DASH, MINUS, formatFixed, formatInt, formatNumber, formatSigned, isFigure } from "./format.js";
import { chainControls, chartHost, compact, demoPill, legend, linear, nextId, niceScale, readNumber, s, statusRow, strikeBars, svgRoot, tile, tiles } from "./analyticsViews.js";
import { barTimeLabel, dayLabel, rulerLayout, seriesLayout } from "./analyticsMore.js";

// ───────────────────────── pure helpers ─────────────────────────

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const r1 = (v) => Math.round(v * 10) / 10;

/** A rupee figure in Indian short form (₹12.5 L, ₹1.25 Cr). Missing → DASH (an en dash). */
export const inr = (v) => (isFigure(v) ? `${Number(v) < 0 ? MINUS : ""}₹${compact(Math.abs(Number(v)))}` : DASH);
/** A figure the Bridge already reports in INR crore (NSE deals and insiders). Missing → DASH (an en dash). */
export const crore = (v) => (isFigure(v) ? `${Number(v) < 0 ? MINUS : ""}₹${formatFixed(Math.abs(Number(v)), 2)} Cr` : DASH);
/** compact(), but small figures keep two decimals so a vanna or charm axis never reads 0, 0, 1. */
export function compactFine(v) {
  if (!isFigure(v)) return DASH;
  const n = Number(v);
  const a = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  if (a >= 1e12) return `${sign}${formatNumber(a / 1e12, { maximumFractionDigits: 2 })} L Cr`; // lakh crore
  if (a >= 1e10) return `${sign}${formatNumber(a / 1e10, { maximumFractionDigits: 1 })}k Cr`; // thousand crore
  return a < 1000 && n !== 0 ? formatNumber(n, { maximumFractionDigits: 2 }) : compact(n);
}
const signClass = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : undefined);
const signedSpan = (v, dp = 2, suffix = "") => (isFigure(v) ? h("span", { class: signClass(v) }, `${formatSigned(v, dp)}${suffix}`) : DASH);

/** Unusual-activity flags: plain label, a hint with the threshold, and the pill tone. */
export const FLAG_INFO = {
  VOLUME_SPIKE: { label: "Volume spike", tone: "warn", hint: "Volume is at least 1x the open interest" },
  BIG_PREMIUM: { label: "Big premium", tone: "info", hint: "Premium traded is ₹1 Cr or more" },
  OTM_LOTTERY: { label: "OTM lottery", tone: "warn", hint: "3% or more out of the money, with volume at least half the open interest" },
  IV_ANOMALY: { label: "IV anomaly", tone: "info", hint: "IV is 25% or more away from the at-the-money IV" },
  OI_BUILDUP: { label: "OI build-up", tone: "info", hint: "Open interest grew 10% or more over its prior level" },
};
export const flagInfo = (code) => FLAG_INFO[code] ?? { label: String(code).toLowerCase().replace(/_/g, " "), tone: "", hint: "" };

/** The aggressor PROXY (where the last price sits in the bid-ask spread) in words. It is never trade-tape data. */
export function aggressorInfo(a) {
  if (!a || !a.side) return { text: "No quote", sub: "no valid bid and ask", tone: "" };
  const pct = isFigure(a.position) ? `${formatInt(Number(a.position) * 100)}% of spread` : "";
  const text = { "buyer-aggressive": "Buy-side", "seller-aggressive": "Sell-side", neutral: "Mid" }[a.side] ?? a.side;
  return { text, sub: ["proxy", pct].filter(Boolean).join(" · "), tone: a.side === "buyer-aggressive" ? "up" : a.side === "seller-aggressive" ? "down" : "" };
}

export const MIN_PREMIUM_CHOICES = [["0", "Any premium"], ["100000", "₹1 L"], ["1000000", "₹10 L"], ["5000000", "₹50 L"], ["10000000", "₹1 Cr"], ["50000000", "₹5 Cr"]];

/** The GET /v1/analytics/unusual query from the filter fields, or { ok: false, error }. */
export function unusualQuery({ underlyings, minPremium, side, sort, limit } = {}) {
  const list = [...new Set(String(underlyings ?? "").split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return { ok: false, error: "Enter at least one underlying, for example NIFTY,BANKNIFTY." };
  if (list.length > 10) return { ok: false, error: "At most 10 underlyings at a time." };
  const bad = list.find((u) => !/^[A-Z0-9&_-]{1,30}$/.test(u));
  if (bad) return { ok: false, error: `"${bad}" is not a valid underlying name.` };
  const prem = readNumber(minPremium ?? "0");
  if (prem === null || prem < 0) return { ok: false, error: "Minimum premium must be 0 or more." };
  const q = new URLSearchParams({ underlyings: list.join(","), side: ["call", "put"].includes(side) ? side : "both", sort: ["score", "premium", "volOi"].includes(sort) ? sort : "score", limit: String(Math.min(500, Math.max(1, Math.round(readNumber(limit ?? "50") ?? 50)))) });
  if (prem > 0) q.set("minPremium", String(prem));
  return { ok: true, query: q.toString() };
}

const SCORE_LABELS = { volOi: "Volume against open interest", premiumInr: "Premium traded", otmPct: "Distance out of the money", ivVsAtm: "IV away from ATM IV", oiChangePct: "Open-interest build-up" };
const SCORE_FALLBACK = [
  { id: "volOi", weight: 30, divisor: 3 },
  { id: "premiumInr", weight: 25, divisor: 20_000_000 },
  { id: "otmPct", weight: 15, divisor: 5 },
  { id: "ivVsAtm", weight: 15, divisor: 0.5 },
  { id: "oiChangePct", weight: 15, divisor: 20 },
];
/** The terms of "score = 30*min(volOi/3,1) + ..." as [{ id, weight, divisor }], or [] when the text is not in that shape. */
export function parseScoreFormula(text) {
  const out = [];
  const ids = { volOi: "volOi", premiumInr: "premiumInr", otmPct: "otmPct", "|iv/atmIv-1|": "ivVsAtm", oiChangePct: "oiChangePct" };
  for (const m of String(text ?? "").matchAll(/(\d+(?:\.\d+)?)\*min\((.+?),1\)/g)) {
    const inner = m[2].match(/^(.*)\/([\d.]+)$/);
    const id = inner ? ids[inner[1]] : undefined;
    if (id && Number(inner[2]) > 0) out.push({ id, weight: Number(m[1]), divisor: Number(inner[2]) });
  }
  return out;
}

/** The input a score term reads from one contract (null when the Bridge could not work it out). */
function scoreInput(id, c) {
  if (id === "ivVsAtm") return isFigure(c.ivVsAtm) ? Math.abs(Number(c.ivVsAtm) - 1) : null;
  return isFigure(c[id]) ? Number(c[id]) : null;
}
/** Where each point of a contract's score came from: [{ id, label, weight, input, shown, fraction, points }], using the terms in `method.score`. */
export function scoreParts(contract, method) {
  const terms = parseScoreFormula(method?.score);
  return (terms.length ? terms : SCORE_FALLBACK).map((t) => {
    const input = scoreInput(t.id, contract);
    const fraction = input === null ? 0 : clamp01(input / t.divisor);
    const raw = contract[t.id];
    const shown = !isFigure(raw) ? "not available" : t.id === "volOi" ? `${formatFixed(raw, 2)}x` : t.id === "premiumInr" ? inr(raw) : t.id === "ivVsAtm" ? `${formatFixed(raw, 2)}x ATM IV` : `${formatFixed(raw, 1)}%`;
    return { id: t.id, label: SCORE_LABELS[t.id], weight: t.weight, input, shown, fraction, points: Math.round(t.weight * fraction * 10) / 10 };
  });
}

/** Score band for the chip colour. */
export const scoreTone = (v) => (Number(v) >= 60 ? "hot" : Number(v) >= 35 ? "warm" : "cool");

// ── tide ──

/** Sentiment chip: a word, the pill tone and the score text. */
export function sentimentView(sent) {
  const label = sent?.label ?? "neutral";
  return { label, text: { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" }[label] ?? "Neutral", tone: label === "bullish" ? "ok" : label === "bearish" ? "bad" : "", score: isFigure(sent?.score) ? formatSigned(sent.score, 2) : null };
}
/** Tide has nothing to draw until two snapshots exist: one snapshot has no interval between it and the next. */
export const tideReady = (d) => Array.isArray(d?.series) && d.series.length >= 1;

const shared = { padL: 54, padR: 12, padT: 10, padB: 26 };
function timeTicks(points, plotW, cx) {
  const maxLabels = Math.max(2, Math.floor(plotW / 64));
  const every = Math.max(1, Math.ceil(points.length / maxLabels));
  return points.map((p, i) => ({ i, x: r1(cx(i)), label: barTimeLabel(p.ts / 1000, "time") })).filter((t) => t.i % every === 0);
}
/** Per-interval call premium (up) and put premium (down) as bars from a zero line, one slot per snapshot interval. */
export function tideBarsLayout(points, { width = 640, height = 210 } = {}) {
  const { padL, padR, padT, padB } = shared;
  const w = Math.max(240, width);
  const n = points.length;
  const plotW = w - padL - padR;
  const slot = plotW / Math.max(1, n);
  const bw = Math.max(2, Math.min(28, slot * 0.64));
  const sc = niceScale(-Math.max(0, ...points.map((p) => Number(p.putPremium) || 0)), Math.max(0, ...points.map((p) => Number(p.callPremium) || 0)), 4);
  const y = linear(sc.min, sc.max, height - padB, padT);
  const zeroY = r1(y(0));
  const cx = (i) => padL + slot * (i + 0.5);
  return {
    width: w, height, padL, padR, padT, padB, zeroY, plotRight: w - padR,
    bars: points.map((p, i) => {
      const c = Math.max(0, Number(p.callPremium) || 0);
      const pu = Math.max(0, Number(p.putPremium) || 0);
      const time = barTimeLabel(p.ts / 1000, "time");
      return { x: r1(cx(i) - bw / 2), w: r1(bw), callY: r1(y(c)), callH: r1(zeroY - y(c)), putY: zeroY, putH: r1(y(-pu) - zeroY), title: `${time} IST: calls ${inr(c)}, puts ${inr(pu)}` };
    }),
    yTicks: sc.ticks.map((t) => ({ y: r1(y(t)), label: compact(t), value: t })),
    xTicks: timeTicks(points, plotW, cx),
  };
}
/** The running net (call minus put) premium as a line with the area between it and zero. */
export function cumulativeLayout(points, { width = 640, height = 190 } = {}) {
  const { padL, padR, padT, padB } = shared;
  const w = Math.max(240, width);
  const n = points.length;
  const plotW = w - padL - padR;
  const slot = plotW / Math.max(1, n);
  const vals = points.map((p) => Number(p.cumulativeNet) || 0);
  const sc = niceScale(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const y = linear(sc.min, sc.max, height - padB, padT);
  const cx = (i) => padL + slot * (i + 0.5);
  const zeroY = r1(y(0));
  const pts = vals.map((v, i) => ({ x: r1(cx(i)), y: r1(y(v)), title: `${barTimeLabel(points[i].ts / 1000, "time")} IST: cumulative net ${inr(v)}` }));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join("");
  const area = pts.length ? `${line}L${pts.at(-1).x} ${zeroY}L${pts[0].x} ${zeroY}Z` : "";
  return { width: w, height, padL, padR, padT, padB, zeroY, plotRight: w - padR, plotBottom: height - padB, line, area, dots: pts.length <= 60 ? pts : [], yTicks: sc.ticks.map((t) => ({ y: r1(y(t)), label: compact(t), value: t })), xTicks: timeTicks(points, plotW, cx) };
}

// ── exposure ──

export const GREEKS = {
  delta: { label: "Delta", net: "netDelta", total: "netDelta", unit: "delta", blurb: "How much the dealer book gains for one index point" },
  gamma: { label: "Gamma", net: "netGex", total: "netGex", unit: "gamma", blurb: "How much that delta changes for a 1% move" },
  vanna: { label: "Vanna", net: "netVanna", total: "netVanna", unit: "vanna", blurb: "How delta changes when implied volatility moves" },
  charm: { label: "Charm", net: "netCharm", total: "netCharm", unit: "charm", blurb: "How delta drifts as a day passes" },
};
/** Bars for the by-strike chart (highest strike on top): one net bar per strike, with call wall, put wall and zero-gamma marks. */
export function exposureItems(d, greek) {
  const g = GREEKS[greek] ?? GREEKS.gamma;
  return [...(d?.strikes ?? [])]
    .sort((a, b) => b.strike - a.strike)
    .map((r) => {
      const tag = r.strike === d.callWall ? "Call wall" : r.strike === d.putWall ? "Put wall" : r.strike === d.zeroGammaLevel ? "Zero gamma" : null;
      const band = r.strike === d.zeroGammaLevel ? "pain" : r.strike === d.callWall ? "wall-call" : r.strike === d.putWall ? "wall-put" : null;
      const v = Number(r[g.net]) || 0;
      return { label: formatInt(r.strike), tag, band, bars: [{ value: v, cls: v >= 0 ? "call" : "put", title: `${formatInt(r.strike)} net ${g.label.toLowerCase()} ${compactFine(v)}` }] };
    });
}
/** One bar per expiry for the by-expiry chart (nearest on top). */
export function expiryItems(d) {
  return (d?.expiries ?? []).map((e) => ({ label: dayLabel(e.expiry), bars: [{ value: Number(e.netGex) || 0, cls: Number(e.netGex) >= 0 ? "call" : "put", title: `${e.expiry}: net gamma ${compactFine(e.netGex)}, ${formatFixed(Number(e.gexShare) * 100, 1)}% of gross gamma` }] }));
}
/** Net gamma summed over the expiries, by strike. */
export function acrossItems(d) {
  return [...(d?.strikes ?? [])]
    .sort((a, b) => b.strike - a.strike)
    .map((r) => ({ label: formatInt(r.strike), tag: r.strike === d.zeroGammaLevel ? "Zero gamma" : null, band: r.strike === d.zeroGammaLevel ? "pain" : null, bars: [{ value: Number(r.netGex) || 0, cls: Number(r.netGex) >= 0 ? "call" : "put", title: `${formatInt(r.strike)} net gamma ${compactFine(r.netGex)}` }] }));
}

/** Heat level 0 (empty) to 5 (the highest) for a cell; a square-root scale so mid-sized cells still show. */
export function heatLevel(value, max) {
  if (!(Number(value) > 0) || !(Number(max) > 0)) return 0;
  return Math.min(5, Math.max(1, Math.ceil(Math.sqrt(Number(value) / Number(max)) * 5)));
}
export const OI_MODES = { total: ["totalOi", "Calls + puts"], call: ["callOi", "Calls"], put: ["putOi", "Puts"] };
/** The `n` highest cells for a mode, as a Map of "strike|expiry" to rank (1 = highest). */
export function topCellRanks(data, mode = "total", n = 5) {
  const key = (OI_MODES[mode] ?? OI_MODES.total)[0];
  const cells = [];
  for (const r of data?.strikes ?? []) for (const c of r.cells ?? []) if (Number(c[key]) > 0) cells.push({ k: `${r.strike}|${c.expiry}`, v: Number(c[key]), strike: r.strike });
  cells.sort((a, b) => b.v - a.v || a.strike - b.strike);
  return new Map(cells.slice(0, n).map((c, i) => [c.k, i + 1]));
}
/** The grid for the heatmap: rows by strike (highest first), each cell with its figure, level and rank. */
export function heatGrid(data, mode = "total", n = 5) {
  const key = (OI_MODES[mode] ?? OI_MODES.total)[0];
  const max = Math.max(0, ...(data?.strikes ?? []).flatMap((r) => (r.cells ?? []).map((c) => Number(c[key]) || 0)));
  const ranks = topCellRanks(data, mode, n);
  return [...(data?.strikes ?? [])]
    .sort((a, b) => b.strike - a.strike)
    .map((r) => ({ strike: r.strike, total: Number(r[key]) || 0, cells: (r.cells ?? []).map((c) => ({ expiry: c.expiry, value: Number(c[key]) || 0, level: heatLevel(c[key], max), rank: ranks.get(`${r.strike}|${c.expiry}`) ?? null, callOi: c.callOi, putOi: c.putOi })) }));
}

// ── screener ──

export const SCREENER_DEFAULTS = { underlyings: "NIFTY", expiry: "", type: "both", moneyness: "any", minDelta: "", maxDelta: "", minIv: "", maxIv: "", minOi: "", minVolume: "", minPremium: "", maxPremium: "", minDte: "", maxDte: "", maxSpreadPct: "", sort: "oi", dir: "desc", limit: "50" };
/** Turn a preset's query string into the form's field values (every field present, unset ones back to the defaults). */
export function presetToForm(query) {
  const p = new URLSearchParams(String(query ?? ""));
  const out = { ...SCREENER_DEFAULTS };
  for (const k of Object.keys(out)) if (p.has(k)) out[k] = p.get(k) ?? "";
  return out;
}
const NUMERIC = [["minDelta", "Min delta"], ["maxDelta", "Max delta"], ["minIv", "Min IV"], ["maxIv", "Max IV"], ["minOi", "Min open interest"], ["minVolume", "Min volume"], ["minPremium", "Min option price"], ["maxPremium", "Max option price"], ["minDte", "Min days to expiry"], ["maxDte", "Max days to expiry"], ["maxSpreadPct", "Max spread %"]];
export const SCREENER_NUMERIC = NUMERIC;
/** The GET /v1/analytics/screener query from the form's text fields, or { ok: false, error }. */
export function screenerQuery(f) {
  const form = { ...SCREENER_DEFAULTS, ...f };
  const list = [...new Set(String(form.underlyings).split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return { ok: false, error: "Enter at least one underlying, for example NIFTY or NIFTY,BANKNIFTY." };
  if (list.length > 5) return { ok: false, error: "At most 5 underlyings at a time." };
  const bad = list.find((u) => !/^[A-Z0-9&_-]{1,30}$/.test(u));
  if (bad) return { ok: false, error: `"${bad}" is not a valid underlying name.` };
  const q = new URLSearchParams({ underlyings: list.join(","), type: form.type, moneyness: form.moneyness, sort: form.sort, dir: form.dir, limit: String(form.limit) });
  const expiry = String(form.expiry ?? "").trim();
  if (expiry) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { ok: false, error: "Expiry must look like 2026-11-24, or be left empty for the nearest." };
    q.set("expiry", expiry);
  }
  for (const [k, label] of NUMERIC) {
    const raw = String(form[k] ?? "").trim();
    if (!raw) continue;
    const n = readNumber(raw);
    if (n === null || n < 0) return { ok: false, error: `${label} must be a number, 0 or more.` };
    q.set(k, String(n));
  }
  return { ok: true, query: q.toString() };
}
/** Sort screener rows in the browser by one column; a missing figure always sorts last, ties keep the Bridge's order. */
export function sortRows(rows, key, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  const val = (r) => (key === "contract" ? r.strike : r[key]);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = val(a.r);
      const y = val(b.r);
      const xm = !isFigure(x);
      const ym = !isFigure(y);
      if (xm !== ym) return xm ? 1 : -1;
      if (!xm && Number(x) !== Number(y)) return (Number(x) - Number(y)) * sign;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

// ── vol ──

/** IV rank and percentile, or the labelled HV20 fallback while fewer than 20 days of IV are stored. */
export function ivRankView(d) {
  const fb = d?.ivRankFallback;
  if (isFigure(d?.ivRank)) return { fallback: false, rank: Number(d.ivRank), percentile: isFigure(d.ivPercentile) ? Number(d.ivPercentile) : null, title: "IV rank", sub: "Where ATM IV sits in its stored range, 0 to 100", days: d.ivHistoryDays ?? null };
  if (fb && isFigure(fb.rank)) return { fallback: true, rank: Number(fb.rank), percentile: isFigure(fb.percentile) ? Number(fb.percentile) : null, title: "HV20 rank (fallback)", sub: `IV rank needs 20 days of stored IV (${formatInt(d.ivHistoryDays ?? 0)} so far). Showing where 20-day HV sits in its own range.`, days: d.ivHistoryDays ?? 0 };
  return { fallback: true, rank: null, percentile: null, title: "IV rank", sub: "Not enough history yet", days: d?.ivHistoryDays ?? 0 };
}
/** Markers for the expected-move ruler: spot, and the lower and upper end of the one-sigma band. */
export function moveMarkers(d) {
  const m = d?.expectedMove;
  if (!m) return { markers: [], band: null };
  const spot = d.iv?.spot;
  return {
    markers: [{ id: "lo", label: "-1σ", value: m.lower, cls: "put" }, ...(isFigure(spot) ? [{ id: "spot", label: "Spot", value: spot, cls: "spot" }] : []), { id: "hi", label: "+1σ", value: m.upper, cls: "call" }],
    band: { from: m.lower, to: m.upper },
  };
}
export const TERM_WORDS = { contango: "Contango: far expiries cost more volatility than near ones", backwardation: "Backwardation: near expiries cost more volatility than far ones", flat: "Flat: near and far are level" };
/** One line over the expiries (oldest first): ATM IV by expiry, with the expiry as the label. */
export function termSeries(term) {
  return [{ id: "iv", label: "ATM IV", cls: "s1", points: (term?.expiries ?? []).map((e) => ({ label: dayLabel(e.expiry), y: isFigure(e.atmIv) ? Number(e.atmIv) : null })) }];
}

// ── NSE tabs ──

/** The label for the NSE pages: where the rows came from, when, and whether this is a saved copy. */
export function nseLabel(meta) {
  if (!meta || meta.source !== "nse") return { text: "Source unknown", tone: "warn" };
  const when = meta.fetchedAt ? `fetched ${istTime(meta.fetchedAt)} IST` : "";
  return { text: ["Source: NSE India", when, meta.stale ? "stale" : ""].filter(Boolean).join(" · "), tone: meta.stale ? "warn" : "info" };
}
export const sideTone = (side) => (side === "BUY" || side === "acquisition" ? "ok" : side === "SELL" || side === "disposal" ? "bad" : "");

// ───────────────────────── DOM pieces ─────────────────────────

const loadingNode = () => h("p", { class: "muted", role: "status" }, "Loading…");
const note = (title, detail, tone = "info") => alertBox({ title, detail }, tone);
const sectionCard = (title, sub, ...body) =>
  h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, title), sub ? h("p", {}, sub) : null)), h("div", { class: "card-body stack" }, body));
const kv = (rows) => h("dl", { class: "kv" }, rows.map(([k, v, tone]) => h("div", {}, h("dt", {}, k), h("dd", { class: tone || undefined }, v))));
const partial = (errors) => (errors?.length ? note("Some underlyings could not be read", errors.slice(0, 4).map((e) => `${e.underlying ?? ""}${e.underlying ? ": " : ""}${e.message}`).join(" · "), "warn") : null);

/** Input plus label. `type`: "text" | "number" | "select" (options [[value, text]]). */
function mkField(H, label, { type = "text", value = "", options, hint, ...props } = {}) {
  const id = nextId("fl-f");
  const el = type === "select" ? h("select", { id }, options.map(([v, t]) => h("option", { value: v }, t))) : h("input", { id, type: type === "number" ? "number" : "text", inputmode: type === "number" ? "decimal" : undefined, step: type === "number" ? "any" : undefined, spellcheck: "false", autocomplete: "off", ...props });
  el.value = value;
  return { el, wrap: H.field(label, el, hint) };
}

/** Runs `work()` into `out`: loading text first (unless quiet), then the nodes or the Bridge's error. Late answers are dropped. */
function runner(H, out) {
  let seq = 0;
  return async (work, { quiet = false } = {}) => {
    const mine = ++seq;
    if (!quiet) out.replaceChildren(loadingNode());
    try {
      const nodes = await work();
      if (mine === seq) out.replaceChildren(...[nodes].flat().filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  };
}

/** Tabs as a segmented control over panels that are built once, on first use, and kept (so a tab keeps its filters). */
async function tabbedPage(H, { label, tabs, initial }) {
  // In the dashboard shell each tab is a page tab of its own (analytics.js passes H.tab): draw only that one.
  const only = H.tab ? tabs.find((t) => t.id === H.tab) : null;
  if (only) return only.build(H);
  const hash = new URLSearchParams(String(location.hash).split("?")[1] ?? "").get("tab");
  const start = tabs.some((t) => t.id === hash) ? hash : initial ?? tabs[0].id;
  const seg = H.segmented(label, tabs.map((t) => [t.id, t.label]), start);
  const host = h("div", { class: "stack" });
  const panels = new Map();
  const show = async () => {
    const t = tabs.find((x) => x.id === seg.value);
    for (const [id, p] of panels) p.hidden = id !== t.id;
    if (panels.has(t.id)) return;
    const panel = h("div", { class: "stack" }, loadingNode());
    panels.set(t.id, panel);
    host.append(panel);
    try {
      panel.replaceChildren(await t.build(H));
    } catch (err) {
      panel.replaceChildren(H.errorBox(err));
    }
  };
  seg.addEventListener("change", show);
  await show();
  return h("div", { class: "stack" }, h("div", { class: "flow-tabs" }, H.segField(label, seg)), host);
}

/** A tab over a chain request: underlying, expiry and strikes controls plus any `extras` (mkField results), then the result. */
async function chainTab(H, { endpoint, draw, needsExpiry = true, withStrikes = true, extras = [], strikeChoices }) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const run = runner(H, out);
  const load = () =>
    run(async () => {
      const v = controls.values();
      if (needsExpiry && !v.expiry) return emptyState("info", "No expiry to show", "This underlying has no upcoming expiry in the instrument list. Check the symbol (for example NIFTY) and try again.");
      const res = await endpoint(v, Object.fromEntries(extras.map((x) => [x.key, x.el.value])));
      return draw(res.data?.data, res.data?.meta?.freshness, v, res);
    });
  const controls = chainControls(H, { onChange: load, onError: (e) => out.replaceChildren(H.errorBox(e)), withStrikes, strikeChoices });
  controls.show({ expiry: needsExpiry, strikes: withStrikes });
  controls.node.lastElementChild.before(...extras.map((x) => x.wrap));
  for (const x of extras) x.el.addEventListener("change", load);
  if (await controls.init()) await load();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, controls.node)), out);
}

/** Small segmented control inside a card, wrapped as a labelled field. */
const segIn = (H, label, options, initial, onChange) => {
  const seg = H.segmented(label, options, initial);
  seg.addEventListener("change", onChange);
  return { seg, field: H.segField(label, seg) };
};

/** A table that sorts by column header (when `onSort` is given) and selects a row on click. `columns`: [{ label, key?, num?, cell }]. */
export function dataTable(columns, rows, { sort, onSort, onSelect, selected, rowKey = (r) => r, empty, scroll = true } = {}) {
  if (!rows.length) return empty ?? h("p", { class: "muted small" }, "No rows.");
  const sortable = Boolean(onSort);
  const head = columns.map((c) => {
    const on = sort && c.key && sort.key === c.key;
    return h("th", { scope: "col", class: c.num ? "num" : undefined, "aria-sort": sortable && c.key ? (on ? (sort.dir === "asc" ? "ascending" : "descending") : "none") : undefined }, sortable && c.key ? h("button", { type: "button", class: "th-sort", onclick: () => onSort(c.key) }, c.label) : c.label);
  });
  const trs = rows.map((r, i) => {
    const tr = h("tr", { class: onSelect ? "selectable" : undefined, "aria-selected": onSelect ? String(selected !== undefined && rowKey(r) === selected) : undefined, onclick: onSelect ? () => onSelect(r) : undefined }, columns.map((c) => h("td", { class: c.num ? "num" : c.cls }, c.cell(r, i))));
    return tr;
  });
  const wrap = h("div", { class: `table-wrap scroll-x${scroll ? " scroll-box" : ""}` }, h("table", { class: onSelect ? "pick-table" : undefined }, h("thead", {}, h("tr", {}, head)), h("tbody", {}, trs)));
  wrap.markSelected = (key) => trs.forEach((tr, i) => tr.setAttribute("aria-selected", String(rowKey(rows[i]) === key)));
  return wrap;
}

// ── SVG charts ──

/** Call premium up, put premium down, per interval. */
function tideBars(points, label) {
  return chartHost((w) => {
    const L = tideBarsLayout(points, { width: w });
    const svg = svgRoot(L.width, L.height, label);
    for (const t of L.yTicks) svg.append(s("line", { class: "grid-line", x1: L.padL, x2: L.plotRight, y1: t.y, y2: t.y }), s("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.xTicks) svg.append(s("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    for (const b of L.bars) {
      if (b.callH > 0) svg.append(s("rect", { class: "bar call", x: b.x, y: b.callY, width: b.w, height: b.callH, rx: 2 }, s("title", {}, b.title)));
      if (b.putH > 0) svg.append(s("rect", { class: "bar put", x: b.x, y: b.putY, width: b.w, height: b.putH, rx: 2 }, s("title", {}, b.title)));
    }
    svg.append(s("line", { class: "zero-line", x1: L.padL, x2: L.plotRight, y1: L.zeroY, y2: L.zeroY }));
    return svg;
  });
}
let clipSeq = 0;
/** The cumulative net premium: area above zero (call-led) and below (put-led), one line over it. */
function cumulativeChart(points, label) {
  return chartHost((w) => {
    const L = cumulativeLayout(points, { width: w });
    const svg = svgRoot(L.width, L.height, label);
    const id = `tide-clip-${++clipSeq}`;
    svg.append(s("defs", {}, s("clipPath", { id: `${id}-up` }, s("rect", { x: L.padL, y: 0, width: L.plotRight - L.padL, height: L.zeroY })), s("clipPath", { id: `${id}-dn` }, s("rect", { x: L.padL, y: L.zeroY, width: L.plotRight - L.padL, height: Math.max(0, L.height - L.zeroY) }))));
    for (const t of L.yTicks) svg.append(s("line", { class: "grid-line", x1: L.padL, x2: L.plotRight, y1: t.y, y2: t.y }), s("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.xTicks) svg.append(s("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    svg.append(s("path", { class: "area call", d: L.area, "clip-path": `url(#${id}-up)` }), s("path", { class: "area put", d: L.area, "clip-path": `url(#${id}-dn)` }), s("line", { class: "zero-line", x1: L.padL, x2: L.plotRight, y1: L.zeroY, y2: L.zeroY }), s("path", { class: "line payoff", d: L.line }));
    for (const d of L.dots) svg.append(s("circle", { class: "be-dot", cx: d.x, cy: d.y, r: 3 }, s("title", {}, d.title)));
    return svg;
  });
}
/** Score-term bars: label and points above a full-width track. */
function scoreBars(parts, label) {
  return chartHost((w) => {
    const rowH = 38;
    const svg = svgRoot(w, parts.length * rowH + 4, label);
    parts.forEach((p, i) => {
      const y = i * rowH;
      svg.append(s("text", { class: "strike", x: 0, y: y + 13, "text-anchor": "start" }, p.label), s("text", { class: "tag", x: w, y: y + 13, "text-anchor": "end" }, `${formatFixed(p.points, 1)} / ${p.weight}`), s("rect", { class: "meter-track", x: 0, y: y + 21, width: w, height: 8, rx: 4 }));
      if (p.fraction > 0) svg.append(s("rect", { class: "meter-fill", x: 0, y: y + 21, width: Math.max(4, r1(w * p.fraction)), height: 8, rx: 4 }));
    });
    return svg;
  });
}
/** A line over evenly spaced labelled points (the term structure). */
function termChart(series, label) {
  return chartHost((w) => {
    const L = seriesLayout(series, { width: w, yDecimals: 2, height: 220 });
    const svg = svgRoot(L.width, L.height, label);
    if (L.empty) return svg;
    for (const t of L.yTicks) svg.append(s("line", { class: "grid-line", x1: L.padL, x2: L.plotRight, y1: t.y, y2: t.y }), s("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.xTicks) svg.append(s("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    for (const p of L.paths) {
      if (p.d) svg.append(s("path", { class: `line ${p.cls}`, d: p.d }));
      for (const d of p.dots) svg.append(s("circle", { class: `dot ${p.cls}`, cx: d.x, cy: d.y, r: 4 }, s("title", {}, d.title)));
    }
    return svg;
  });
}
/** The one-sigma band on a price ruler with spot marked. */
function moveRuler(markers, band, label) {
  return chartHost((w) => {
    const L = rulerLayout(markers, { width: w, band });
    const svg = svgRoot(L.width, Math.max(L.height, 40), label);
    if (L.empty) return svg;
    if (L.band) svg.append(s("rect", { class: "range-fill", x: L.band.x0, y: L.axisY - 7, width: Math.max(1, L.band.x1 - L.band.x0), height: 14, rx: 3 }));
    svg.append(s("line", { class: "axis-line", x1: 10, x2: L.width - 10, y1: L.axisY, y2: L.axisY }));
    for (const i of L.items) svg.append(s("line", { class: `leader ${i.cls}`, x1: i.x, x2: i.x, y1: i.textY + 3, y2: L.axisY + 6 }), s("circle", { class: `m-dot ${i.cls}`, cx: i.x, cy: L.axisY, r: 4 }), s("text", { class: `tag m-text ${i.cls}`, x: i.left, y: i.textY, "text-anchor": "start" }, i.text));
    return svg;
  });
}

const callPutLegendNet = () => legend([{ cls: "call", label: "Net positive" }, { cls: "put", label: "Net negative" }]);
const UNDERLYING_CHOICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

const spanAll = (n) => (n.classList.add("span-all"), n);

// ───────────────────────── Page 1: Unusual activity ─────────────────────────

async function renderUnusual(H) {
  const under = mkField(H, "Underlyings", { value: "NIFTY,BANKNIFTY", maxlength: 120, hint: "Up to 10, separated by commas." });
  const prem = mkField(H, "Min premium traded", { type: "select", options: MIN_PREMIUM_CHOICES, value: "0" });
  const sortF = mkField(H, "Rank by", { type: "select", options: [["score", "Score"], ["premium", "Premium traded"], ["volOi", "Volume / OI"]], value: "score" });
  const limitF = mkField(H, "Show", { type: "select", options: [["25", "Top 25"], ["50", "Top 50"], ["100", "Top 100"]], value: "50" });
  const side = H.segmented("Side", [["both", "Both"], ["call", "Calls"], ["put", "Puts"]], "both");
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const run = runner(H, out);

  const draw = (res) => {
    const d = res.data?.data ?? {};
    const rows = d.contracts ?? [];
    const method = d.method ?? {};
    let chosen = rows[0] ?? null;
    const detail = h("div", {});
    const showDetail = () => detail.replaceChildren(breakdownCard(chosen, method));
    const tbl = h("div", {});
    const build = () => {
      const t = dataTable(
        [
          { label: "#", cell: (_, i) => h("span", { class: "muted" }, String(i + 1)) },
          { label: "Contract", cell: (c) => h("div", { class: "cell-two" }, h("button", { type: "button", class: "row-pick" }, `${c.underlying} ${formatInt(c.strike)} ${c.side === "call" ? "CE" : "PE"}`), h("span", { class: "muted small" }, dayLabel(c.expiry))) },
          { label: "Score", num: true, cell: (c) => h("span", { class: `score-chip ${scoreTone(c.score)}` }, formatFixed(c.score, 1)) },
          { label: "Flags", cell: (c) => h("div", { class: "flags" }, c.flags?.length ? c.flags.map((f) => h("span", { class: `pill sm ${flagInfo(f).tone}`, title: flagInfo(f).hint }, flagInfo(f).label)) : h("span", { class: "muted small" }, "None")) },
          { label: "Volume / OI", num: true, cell: (c) => h("div", { class: "cell-two num" }, h("span", {}, isFigure(c.volOi) ? `${formatFixed(c.volOi, 2)}x` : DASH), h("span", { class: "muted small" }, `${compact(c.volume)} / ${compact(c.oi)}`)) },
          { label: "Premium", num: true, cell: (c) => (isFigure(c.premiumInr) ? inr(c.premiumInr) : h("span", { class: "muted", title: "The chain has no lot size, so premium cannot be worked out" }, DASH)) },
          { label: "Aggressor (proxy)", cell: (c) => { const a = aggressorInfo(c.aggressor); return h("div", { class: "cell-two" }, h("span", { class: a.tone || undefined }, a.text), h("span", { class: "muted small" }, a.sub)); } },
          { label: "OTM %", num: true, cell: (c) => (isFigure(c.otmPct) ? formatFixed(c.otmPct, 1) : DASH) },
          { label: "LTP", num: true, cell: (c) => formatFixed(c.ltp, 2) },
        ],
        rows,
        { selected: chosen ? rowId(chosen) : undefined, rowKey: rowId, onSelect: (c) => { chosen = c; tbl.firstElementChild?.markSelected?.(rowId(c)); showDetail(); detail.scrollIntoView?.({ block: "nearest" }); }, empty: emptyState("scan", "Nothing unusual", "No contract passed the filters. Lower the minimum premium or pick more underlyings.") },
      );
      tbl.replaceChildren(t);
    };
    build();
    showDetail();
    const lotMissing = (d.underlyings ?? []).filter((u) => u.lotSizeMissing).map((u) => u.underlying);
    const sum = rows.reduce((t, c) => t + (isFigure(c.premiumInr) ? Number(c.premiumInr) : 0), 0);
    const top = rows[0];
    return [
      statusRow(res.data?.meta?.freshness),
      partial(res.data?.errors),
      lotMissing.length ? note("No lot size", `${lotMissing.join(", ")}: the chain carries no lot size, so premium traded is not available and those contracts cannot pass a premium filter.`, "warn") : null,
      tiles(tile("Contracts", formatInt(d.count), `${formatInt(d.returned)} shown of ${formatInt(d.count)} that passed`), tile("Top score", top ? formatFixed(top.score, 1) : DASH, top ? `${top.underlying} ${formatInt(top.strike)} ${top.side === "call" ? "CE" : "PE"}` : "Nothing ranked"), tile("Premium shown", inr(sum), "Volume x price x lot size"), tile("Scanned", formatInt((d.underlyings ?? []).reduce((t, u) => t + u.contracts, 0)), `${(d.underlyings ?? []).map((u) => `${u.underlying} ${dayLabel(u.expiry)}`).join(", ") || "No underlying"}`)),
      h("div", { class: "grid side" }, h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Ranked contracts"), h("p", {}, "Choose a row to see where its score comes from. Buy-side and sell-side are a proxy from the price's place in the bid-ask spread, not trade data."))), h("div", { class: "card-body flush" }, tbl)), detail),
      d.disclaimer ? h("p", { class: "muted small" }, d.disclaimer) : null,
    ];
  };
  const rowId = (c) => `${c.underlying}|${c.expiry}|${c.strike}|${c.side}`;
  const load = () =>
    run(async () => {
      const q = unusualQuery({ underlyings: under.el.value, minPremium: prem.el.value, side: side.value, sort: sortF.el.value, limit: limitF.el.value });
      if (!q.ok) return H.errorBox({ title: "Check the filters", detail: q.error });
      return draw(await api(`/v1/analytics/unusual?${q.query}`));
    });
  for (const el of [prem.el, sortF.el, limitF.el]) el.addEventListener("change", load);
  side.addEventListener("change", load);
  under.el.addEventListener("change", load);
  const go = h("button", { type: "button", class: "primary", onclick: load }, icon("refresh"), "Scan");
  await load();
  return h(
    "div",
    { class: "stack" },
    h("section", { class: "card" }, h("div", { class: "card-body stack" }, h("div", { class: "form-grid analytics-controls" }, spanAll(under.wrap), prem.wrap, H.segField("Side", side), sortF.wrap, limitF.wrap, h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Scan"), go)))),
    out,
  );
}

function breakdownCard(c, method) {
  if (!c) return h("section", { class: "card" }, h("div", { class: "card-body" }, emptyState("scan", "No contract chosen", "Rank some contracts, then choose one.")));
  const parts = scoreParts(c, method);
  const name = `${c.underlying} ${formatInt(c.strike)} ${c.side === "call" ? "CE" : "PE"}`;
  const a = aggressorInfo(c.aggressor);
  const sum = Math.round(parts.reduce((t, p) => t + p.points, 0) * 10) / 10;
  const meth = [["Volume / OI", method.volOi], ["Premium", method.premiumInr], ["Out of the money", method.otmPct], ["IV against ATM", method.ivVsAtm], ["OI change", method.oiChangePct], ["Aggressor", method.aggressor], ["Flags", method.flags]].filter(([, t]) => t);
  return h(
    "section",
    { class: "card" },
    h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, `Score breakdown: ${name}`), h("p", {}, `${c.expiry} · ${c.side === "call" ? "call" : "put"} · last price ${formatFixed(c.ltp, 2)}`)), h("span", { class: `score-chip ${scoreTone(c.score)}` }, formatFixed(c.score, 1))),
    h(
      "div",
      { class: "card-body stack" },
      scoreBars(parts, `Score ${formatFixed(c.score, 1)} out of 100 for ${name}: ${parts.map((p) => `${p.label} ${formatFixed(p.points, 1)} of ${p.weight}`).join(", ")}`),
      h("p", { class: "muted small" }, `Terms add up to ${formatFixed(sum, 1)}; the Bridge reports ${formatFixed(c.score, 1)} (it rounds each input first). Each term is capped at its maximum.`),
      kv(parts.map((p) => [p.label, p.shown])),
      h("div", { class: "alert info" }, icon("info"), h("div", {}, h("strong", {}, `Aggressor proxy: ${a.text}`), h("span", { class: "detail" }, a.sub ? `${a.sub}. ` : "", "A guess from where the last price sits between bid and ask. India has no trade tape, so this is not who actually hit whom."))),
      c.flags?.length ? h("ul", { class: "flag-list" }, c.flags.map((f) => h("li", {}, pill(flagInfo(f).label, flagInfo(f).tone), h("span", {}, flagInfo(f).hint)))) : null,
      h("details", { class: "disclosure" }, h("summary", {}, "How the score is worked out"), h("div", { class: "stack method" }, method.score ? h("p", { class: "mono small" }, method.score) : null, meth.map(([k, t]) => h("p", { class: "small" }, h("strong", {}, `${k}: `), t)))),
    ),
  );
}

// ───────────────────────── Page 2: Market tide ─────────────────────────

async function renderTide(H) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const run = runner(H, out);
  const windowF = mkField(H, "Window", { type: "select", options: [["", "Whole session"], ["15", "Last 15 min"], ["30", "Last 30 min"], ["60", "Last hour"]], value: "" });
  const topF = mkField(H, "Top strikes", { type: "select", options: [["5", "5"], ["10", "10"]], value: "5" });
  const rec = h("input", { type: "checkbox", id: nextId("fl-rec"), checked: true });
  const recLabel = h("label", { class: "check", for: rec.id }, rec, "Record a reading every 60 seconds while this page is open");

  const draw = (d, freshness, v) => {
    const sent = sentimentView(d.sentiment);
    const t = d.totals ?? {};
    const status = statusRow(freshness, rec.checked ? pill("Recording", "ok") : pill("Not recording", "warn"));
    if (!tideReady(d))
      return [status, emptyState("activity", "Collecting the first readings", `The Bridge has taken the first reading for ${d.underlying} ${d.expiry ?? ""}. Tide measures premium traded between two readings, so the chart starts after the next one${rec.checked ? ", about a minute from now" : ""}.`)];
    const pts = d.series;
    return [
      status,
      d.lotSizeAssumed ? note("No lot size", "The chain carries no lot size, so premium assumes 1 unit per lot.", "warn") : null,
      tiles(tile("Call premium", inr(t.callPremium), "Traded this session"), tile("Put premium", inr(t.putPremium), "Traded this session"), tile("Net (calls - puts)", inr(t.net), "Call premium minus put premium", signClass(t.net)), tile("Cumulative net", inr(t.cumulativeNet), `${formatInt(d.intervals)} intervals so far`, signClass(t.cumulativeNet))),
      h(
        "div",
        { class: "grid cols-2" },
        sectionCard(
          "Sentiment",
          "From the split of bought and sold premium (a proxy).",
          h("div", { class: "row" }, pill(sent.text, sent.tone), sent.score ? h("span", { class: "chip-score mono" }, `Score ${sent.score}`) : null, d.sentiment?.proxy ? pill("Proxy", "info") : null),
          h("p", { class: "rule-text" }, d.sentiment?.rule ?? DASH),
          d.sentiment?.reason ? h("p", { class: "muted small" }, d.sentiment.reason) : null,
          isFigure(d.sentiment?.threshold) ? h("p", { class: "muted small" }, `Neutral inside ±${formatFixed(d.sentiment.threshold, 2)}.`) : null,
          d.window ? h("p", { class: "muted small" }, `Last ${formatInt(d.window.minutes)} min: net ${inr(d.window.net)}, directional ${inr(d.window.directionalNet)}.`) : null,
        ),
        sectionCard("Bought and sold (proxy)", "Premium split by where the price sat in the spread.", kv([["Calls bought", inr(t.callBuyAggressive)], ["Calls sold", inr(t.callSellAggressive)], ["Puts bought", inr(t.putBuyAggressive)], ["Puts sold", inr(t.putSellAggressive)], ["Unclassified", inr(t.unclassified)]])),
      ),
      sectionCard(
        "Premium flow through the session",
        `${d.underlying} ${d.expiry}: premium traded between snapshots, each interval shown at its end. Times are IST.`,
        legend([{ cls: "call", label: "Call premium" }, { cls: "put", label: "Put premium" }]),
        tideBars(pts, `Call and put premium traded in each of ${pts.length} intervals for ${d.underlying}. Total calls ${inr(t.callPremium)}, puts ${inr(t.putPremium)}.`),
        h("h3", { class: "chart-title" }, "Cumulative net premium"),
        cumulativeChart(pts, `Cumulative call minus put premium for ${d.underlying}, now ${inr(t.cumulativeNet)}.`),
      ),
      sectionCard(
        "Top strikes",
        "The strikes where the most premium traded this session.",
        table(
          [
            { label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) },
            { label: "Call premium", num: true, cell: (r) => inr(r.callPremium) },
            { label: "Put premium", num: true, cell: (r) => inr(r.putPremium) },
            { label: "Total", num: true, cell: (r) => inr(r.totalPremium) },
            { label: "Net", num: true, cell: (r) => h("span", { class: signClass(r.net) }, inr(r.net)) },
          ],
          d.topStrikes ?? [],
          h("p", { class: "muted small" }, "No strikes yet."),
          { mobile: "scroll" },
        ),
      ),
      h("ul", { class: "note-list muted small" }, (d.notes ?? []).map((n) => h("li", {}, n))),
    ];
  };

  const load = (quiet = false) =>
    run(async () => {
      const v = controls.values();
      const q = new URLSearchParams({ underlying: v.underlying, top: topF.el.value });
      if (v.expiry) q.set("expiry", v.expiry);
      if (windowF.el.value) q.set("windowMin", windowF.el.value);
      const res = await api(`/v1/analytics/tide?${q}`);
      return draw(res.data?.data ?? {}, res.data?.meta?.freshness, v);
    }, { quiet });
  const controls = chainControls(H, { onChange: () => load(), onError: (e) => out.replaceChildren(H.errorBox(e)), withStrikes: false });
  controls.show({ expiry: true, strikes: false });
  controls.node.lastElementChild.before(windowF.wrap, topF.wrap);
  for (const x of [windowF, topF]) x.el.addEventListener("change", () => load());
  rec.addEventListener("change", () => load(true));
  const root = h(
    "div",
    { class: "stack" },
    h(
      "section",
      { class: "card" },
      h("div", { class: "card-body stack" }, controls.node, recLabel, h("p", { class: "hint recording-hint" }, icon("clock"), "Readings only accrue while a page or an alert rule is polling the Bridge. Close this page and the series has a gap until something reads it again.")),
    ),
    out,
  );
  const timer = setInterval(() => {
    if (!root.isConnected) return clearInterval(timer);
    if (rec.checked && !document.hidden) load(true);
  }, 60_000);
  if (await controls.init()) await load();
  return root;
}

// ───────────────────────── Page 3: Exposure ─────────────────────────

function exposureByStrike(H) {
  const greekSeg = { v: "gamma" };
  return chainTab(H, {
    endpoint: (v) => api(`/v1/analytics/exposure?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes) })}`),
    draw: (d, freshness) => {
      const tilesSlot = h("div", {});
      const chartSlot = h("div", {});
      const blurb = h("p", { class: "muted small" });
      const flipTxt = isFigure(d.zeroGammaLevel) ? formatInt(d.zeroGammaLevel) : DASH;
      const paint = () => {
        const g = GREEKS[greekSeg.v];
        const items = exposureItems(d, greekSeg.v);
        const total = d.totals?.[g.total];
        tilesSlot.replaceChildren(
          tiles(
            tile(`Net ${g.label.toLowerCase()}`, compactFine(total), d.units?.[g.unit] ?? "", signClass(total)),
            tile("Call wall", isFigure(d.callWall) ? formatInt(d.callWall) : DASH, "Largest call gamma: often resistance"),
            tile("Put wall", isFigure(d.putWall) ? formatInt(d.putWall) : DASH, "Largest put gamma: often support"),
            tile("Zero gamma", flipTxt, `Regime ${d.regime ?? DASH}: gamma flips sign here`),
          ),
        );
        blurb.textContent = `${g.label}: ${g.blurb}. ${d.units?.[g.unit] ?? ""}.`;
        chartSlot.replaceChildren(
          items.length
            ? strikeBars(items, { label: `Net ${g.label.toLowerCase()} exposure by strike for ${d.underlying} ${d.expiry}. Call wall ${isFigure(d.callWall) ? formatInt(d.callWall) : "none"}, put wall ${isFigure(d.putWall) ? formatInt(d.putWall) : "none"}, zero gamma ${flipTxt}.`, layout: { tickFormat: compactFine } })
            : emptyState("chart", "No exposure to draw", "No strike has open interest with a usable IV and gamma."),
        );
      };
      const sw = segIn(H, "Greek", Object.entries(GREEKS).map(([k, x]) => [k, x.label]), greekSeg.v, () => {
        greekSeg.v = sw.seg.value;
        paint();
      });
      paint();
      return [
        statusRow(freshness),
        d.skippedLegs ? note("Some legs skipped", `${formatInt(d.skippedLegs)} legs have open interest but no usable IV or gamma, so they are left out.`, "warn") : null,
        tilesSlot,
        h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Exposure by strike"), h("p", {}, "Dealers are assumed long calls and short puts. Walls and the zero-gamma level come from gamma, whichever Greek is shown."))), h("div", { class: "card-body stack" }, sw.field, legend([{ cls: "call", label: "Net positive" }, { cls: "put", label: "Net negative" }, { cls: "swatch-wall-call", label: "Call wall" }, { cls: "swatch-wall-put", label: "Put wall" }, { cls: "swatch-flip", label: "Zero gamma" }]), blurb, chartSlot)),
      ];
    },
  });
}

function exposureByExpiry(H) {
  const count = mkField(H, "Expiries", { type: "select", options: [["2", "2"], ["3", "3"], ["4", "4"], ["6", "6"]], value: "3" });
  count.key = "expiries";
  return chainTab(H, {
    needsExpiry: false,
    extras: [count],
    endpoint: (v, x) => api(`/v1/analytics/exposure/expiries?${new URLSearchParams({ underlying: v.underlying, expiries: x.expiries, strikes: String(v.strikes) })}`),
    draw: (d, freshness) => {
      const list = d.expiries ?? [];
      if (!list.length) return [statusRow(freshness), emptyState("chart", "No expiries to show", "The Bridge found no upcoming expiry with prices for this underlying.")];
      return [
        statusRow(freshness),
        tiles(tile("Net gamma", compactFine(d.totals?.netGex), d.unit?.gamma ?? "", signClass(d.totals?.netGex)), tile("Net delta", compactFine(d.totals?.netDelta), d.unit?.delta ?? "", signClass(d.totals?.netDelta)), tile("Zero gamma", isFigure(d.zeroGammaLevel) ? formatInt(d.zeroGammaLevel) : DASH, `Regime ${d.regime ?? DASH}, all expiries together`), tile("Peak strike", isFigure(d.peakStrike) ? formatInt(d.peakStrike) : DASH, "Largest net gamma")),
        sectionCard("Net gamma by expiry", "How much of the exposure each expiry holds. Nearer expiries usually dominate.", callPutLegendNet(), strikeBars(expiryItems(d), { label: `Net gamma by expiry for ${d.underlying}`, layout: { labelW: 64, tickFormat: compactFine } })),
        sectionCard(
          "Net gamma by strike, all expiries",
          "Each strike's exposure added up across the expiries above.",
          callPutLegendNet(),
          strikeBars(acrossItems(d), { label: `Net gamma by strike summed over ${list.length} expiries for ${d.underlying}. Zero gamma ${isFigure(d.zeroGammaLevel) ? formatInt(d.zeroGammaLevel) : "none"}.`, layout: { tickFormat: compactFine } }),
        ),
        sectionCard(
          "Expiry table",
          "Share is of gross (unsigned) exposure across the expiries shown.",
          table(
            [
              { label: "Expiry", cell: (e) => h("strong", {}, e.expiry) },
              { label: "Days", num: true, cell: (e) => formatFixed(e.daysToExpiry, 1) },
              { label: "Net gamma", num: true, cell: (e) => h("span", { class: signClass(e.netGex) }, compactFine(e.netGex)) },
              { label: "Gamma share", num: true, cell: (e) => `${formatFixed(Number(e.gexShare) * 100, 1)}%` },
              { label: "Net delta", num: true, cell: (e) => compactFine(e.netDelta) },
              { label: "Delta share", num: true, cell: (e) => `${formatFixed(Number(e.deltaShare) * 100, 1)}%` },
              { label: "Zero gamma", num: true, cell: (e) => (isFigure(e.zeroGammaLevel) ? formatInt(e.zeroGammaLevel) : DASH) },
              { label: "Call wall", num: true, cell: (e) => (isFigure(e.callWall) ? formatInt(e.callWall) : DASH) },
              { label: "Put wall", num: true, cell: (e) => (isFigure(e.putWall) ? formatInt(e.putWall) : DASH) },
            ],
            list,
            h("p", { class: "muted small" }, "No expiries."),
            { mobile: "scroll" },
          ),
        ),
      ];
    },
  });
}

/** The OI heatmap as an HTML table: strike rows, expiry columns, a class per cell for its heat, rank badges on the highest. */
export function heatmapTable(data, mode) {
  const grid = heatGrid(data, mode);
  const cols = data.expiries ?? [];
  const totals = data.columns ?? [];
  const key = (OI_MODES[mode] ?? OI_MODES.total)[0];
  const head = h("tr", {}, h("th", { scope: "col", class: "strike-col" }, "Strike"), cols.map((e) => h("th", { scope: "col", class: "num", title: e }, dayLabel(e))), h("th", { scope: "col", class: "num" }, "All"));
  const body = grid.map((r) =>
    h(
      "tr",
      {},
      h("th", { scope: "row", class: "strike-col" }, formatInt(r.strike)),
      r.cells.map((c) => h("td", { class: `hm hm-${c.level}${c.rank ? " top" : ""}`, title: `${formatInt(r.strike)} · ${c.expiry}: calls ${formatInt(c.callOi)}, puts ${formatInt(c.putOi)}${c.rank ? ` · highest #${c.rank}` : ""}` }, c.value > 0 ? compact(c.value) : h("span", { class: "muted" }, "·"), c.rank ? h("span", { class: "rank", "aria-label": `highest ${c.rank}` }, String(c.rank)) : null)),
      h("td", { class: "num hm-all" }, compact(r.total)),
    ),
  );
  const foot = h("tr", {}, h("th", { scope: "row", class: "strike-col" }, "Total"), totals.map((c) => h("td", { class: "num" }, compact(c[key]))), h("td", { class: "num hm-all" }, compact(totals.reduce((t, c) => t + (Number(c[key]) || 0), 0))));
  return h("div", { class: `table-wrap scroll-x scroll-box heatmap heat-${mode}` }, h("table", {}, h("thead", {}, head), h("tbody", {}, body), h("tfoot", {}, foot)));
}

function oiExplorer(H) {
  const count = mkField(H, "Expiries", { type: "select", options: [["2", "2"], ["3", "3"], ["4", "4"], ["6", "6"], ["8", "8"]], value: "4" });
  count.key = "expiries";
  return chainTab(H, {
    needsExpiry: false,
    extras: [count],
    endpoint: (v, x) => api(`/v1/analytics/oi-explorer?${new URLSearchParams({ underlying: v.underlying, expiries: x.expiries, strikes: String(v.strikes) })}`),
    draw: (d, freshness) => {
      if (!(d.strikes ?? []).length) return [statusRow(freshness), emptyState("chart", "No open interest to show", "The Bridge found no strikes with open interest for this underlying.")];
      const slot = h("div", {});
      const paint = () => slot.replaceChildren(heatmapTable(d, mode.seg.value));
      const mode = segIn(H, "Show", Object.entries(OI_MODES).map(([k, [, t]]) => [k, t]), "total", paint);
      paint();
      const t = d.totals ?? {};
      return [
        statusRow(freshness),
        tiles(tile("Call OI", compact(t.callOi), "All expiries shown"), tile("Put OI", compact(t.putOi), "All expiries shown"), tile("PCR (OI)", isFigure(t.pcr) ? formatFixed(t.pcr, 2) : DASH, "Put OI divided by call OI"), tile("Expiries", formatInt((d.expiries ?? []).length), `${formatInt(d.strikes.length)} strikes`)),
        sectionCard(
          "Open interest by strike and expiry",
          "Darker cells hold more open interest. The five highest cells carry a number, 1 being the highest.",
          mode.field,
          legend([{ cls: "heat-sample", label: "Lower to higher OI" }, { cls: "top-sample", label: "Top 5 cells" }]),
          slot,
        ),
      ];
    },
  });
}

async function renderExposure(H) {
  return tabbedPage(H, { label: "Exposure view", tabs: [{ id: "strike", label: "By strike", build: exposureByStrike }, { id: "expiry", label: "By expiry", build: exposureByExpiry }, { id: "oi", label: "OI explorer", build: oiExplorer }] });
}

// ───────────────────────── Page 4: Screener and Vol ─────────────────────────

const SCREEN_SORTS = [["oi", "Open interest"], ["volume", "Volume"], ["iv", "IV"], ["delta", "Delta"], ["premium", "Premium traded"], ["theta", "Theta % of price"], ["ltp", "Price"], ["spread", "Spread"]];

async function screenerTab(H) {
  const f = {};
  const mk = (key, label, spec) => (f[key] = mkField(H, label, { value: SCREENER_DEFAULTS[key], ...spec }));
  mk("underlyings", "Underlyings", { maxlength: 120, hint: "Up to 5, separated by commas." });
  mk("expiry", "Expiry", { placeholder: "Nearest", maxlength: 10, hint: "YYYY-MM-DD, or empty." });
  mk("moneyness", "Moneyness", { type: "select", options: [["any", "Any"], ["itm", "In the money"], ["atm", "At the money"], ["otm", "Out of money"]] });
  for (const [k, label] of SCREENER_NUMERIC) mk(k, label, { type: "number", min: "0" });
  mk("sort", "Sort by", { type: "select", options: SCREEN_SORTS });
  mk("dir", "Order", { type: "select", options: [["desc", "Highest first"], ["asc", "Lowest first"]] });
  mk("limit", "Rows", { type: "select", options: [["20", "20"], ["25", "25"], ["50", "50"], ["100", "100"], ["200", "200"]] });
  const type = H.segmented("Type", [["both", "Both"], ["call", "Calls"], ["put", "Puts"]], "both");
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const run = runner(H, out);
  const presetNote = h("p", { class: "muted small", role: "status" });
  const presetBox = h("div", { class: "row", role: "group", "aria-label": "Ready-made screens" });

  const read = () => ({ ...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.el.value])), type: type.value });
  const fill = (form) => {
    for (const [k, x] of Object.entries(f)) x.el.value = form[k] ?? SCREENER_DEFAULTS[k];
    type.value = form.type ?? "both";
  };
  const draw = (res) => {
    const d = res.data?.data ?? {};
    let sort = { key: null, dir: "desc" };
    let rows = d.rows ?? [];
    const slot = h("div", {});
    const paint = () => {
      const shown = sort.key ? sortRows(rows, sort.key, sort.dir) : rows;
      slot.replaceChildren(
        dataTable(
          [
            { label: "Contract", key: "contract", cell: (r) => h("div", { class: "cell-two" }, h("strong", {}, `${r.underlying} ${formatInt(r.strike)} ${r.type === "call" ? "CE" : "PE"}`), h("span", { class: "muted small" }, `${dayLabel(r.expiry)}${r.moneyness ? ` · ${r.moneyness.toUpperCase()}` : ""}`)) },
            { label: "Price", key: "ltp", num: true, cell: (r) => formatFixed(r.ltp, 2) },
            { label: "Delta", key: "probItm", num: true, cell: (r) => (isFigure(r.delta) ? formatSigned(r.delta, 2) : DASH) },
            { label: "IV %", key: "iv", num: true, cell: (r) => formatFixed(r.iv, 1) },
            { label: "OI", key: "oi", num: true, cell: (r) => compact(r.oi) },
            { label: "Volume", key: "volume", num: true, cell: (r) => compact(r.volume) },
            { label: "Premium traded", key: "premiumTraded", num: true, cell: (r) => (isFigure(r.premiumTraded) ? inr(r.premiumTraded) : DASH) },
            { label: "Days", key: "dte", num: true, cell: (r) => formatFixed(r.dte, 1) },
            { label: "Spread %", key: "spreadPct", num: true, cell: (r) => formatFixed(r.spreadPct, 2) },
            { label: "Theta %/day", key: "thetaPctPerDay", num: true, cell: (r) => formatFixed(r.thetaPctPerDay, 2) },
            { label: "Liquid", cell: (r) => (r.liquid ? pill("Liquid", "ok") : h("span", { class: "muted" }, DASH)) },
          ],
          shown,
          { sort, onSort: (key) => { sort = { key, dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc" }; paint(); }, empty: emptyState("scan", "No contracts matched", "Nothing passed every filter. Loosen one and try again.") },
        ),
      );
    };
    paint();
    return [
      statusRow(res.data?.meta?.freshness),
      partial(res.data?.errors),
      tiles(tile("Scanned", formatInt(d.scanned), `${(d.sources ?? []).map((x) => `${x.underlying} ${dayLabel(x.expiry)}`).join(", ") || "No source"}`), tile("Matched", formatInt(d.matched), "Passed every filter"), tile("Shown", formatInt(d.returned), `Top ${formatInt(d.limit)} by ${d.sort}, ${d.dir === "asc" ? "lowest" : "highest"} first`), tile("Liquid", formatInt(rows.filter((r) => r.liquid).length), "OI 1000+, volume 100+, spread 5% or less")),
      h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Results"), h("p", {}, "Choose a column heading to sort the rows shown. Delta sorts by size, so puts and calls compare."))), h("div", { class: "card-body flush" }, slot)),
    ];
  };
  const load = () =>
    run(async () => {
      const q = screenerQuery(read());
      if (!q.ok) return H.errorBox({ title: "Check the filters", detail: q.error });
      return draw(await api(`/v1/analytics/screener?${q.query}`));
    });

  // Presets come from the Bridge; if they cannot be read the form still works.
  const presets = await optional(api("/v1/analytics/screener/presets"));
  const list = presets.data?.data?.presets ?? [];
  presetBox.replaceChildren(h("span", { class: "muted small" }, "Start from"), ...list.map((p) => h("button", { type: "button", class: "small example", title: p.description, "data-preset": p.id, onclick: () => { fill(presetToForm(p.query)); presetNote.textContent = p.description; load(); } }, p.name)));
  if (!list.length) presetBox.replaceChildren(h("span", { class: "muted small" }, "Ready-made screens are not available right now."));

  const submit = h("button", { type: "submit", class: "primary" }, icon("play"), "Run screen");
  const reset = h("button", { type: "button", class: "small", onclick: () => { fill(SCREENER_DEFAULTS); presetNote.textContent = ""; } }, "Reset");
  const form = h(
    "form",
    { class: "stack", novalidate: true, onsubmit: (e) => { e.preventDefault(); load(); } },
    presetBox,
    presetNote,
    h("div", { class: "form-grid analytics-options" }, spanAll(f.underlyings.wrap), f.expiry.wrap, H.segField("Type", type), f.moneyness.wrap),
    h("details", { class: "disclosure" }, h("summary", {}, "More filters"), h("div", { class: "form-grid analytics-options filter-grid" }, SCREENER_NUMERIC.map(([k]) => f[k].wrap))),
    h("div", { class: "form-grid analytics-options" }, f.sort.wrap, f.dir.wrap, f.limit.wrap, h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Actions"), h("div", { class: "row" }, submit, reset))),
  );
  await load();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, form)), out);
}

function underlyingField(H) {
  const id = nextId("fl-u");
  const el = h("input", { id, list: `${id}-list`, value: "NIFTY", spellcheck: "false", autocomplete: "off", autocapitalize: "characters", maxlength: 30 });
  return { el, wrap: h("div", { class: "field" }, H.field("Underlying", el), h("datalist", { id: `${id}-list` }, UNDERLYING_CHOICES.map((u) => h("option", { value: u })))) };
}

async function volTab(H) {
  const u = underlyingField(H);
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const run = runner(H, out);
  const pct = (v) => (isFigure(v) ? `${formatFixed(v, 2)}%` : DASH);
  const load = () =>
    run(async () => {
      const name = (u.el.value.trim() || "NIFTY").toUpperCase();
      u.el.value = name;
      const [vs, term] = await Promise.all([api(`/v1/analytics/vol-stats?underlying=${encodeURIComponent(name)}`), optional(api(`/v1/analytics/vol-stats/term?underlying=${encodeURIComponent(name)}`))]);
      const d = vs.data?.data ?? {};
      const hv = d.hv ?? {};
      const iv = d.iv ?? {};
      const vh = d.ivVsHv ?? {};
      const rank = ivRankView(d);
      const move = d.expectedMove;
      const mm = moveMarkers(d);
      const t = term.data?.data;
      const series = termSeries(t);
      const labelTone = { rich: "warn", cheap: "info", fair: "ok" }[vh.label] ?? "";
      return [
        statusRow(vs.data?.meta?.freshness),
        d.note ? note("Note", d.note, "info") : null,
        tiles(
          tile("ATM IV", pct(iv.atmIv), iv.expiry ? `${dayLabel(iv.expiry)} expiry, ${formatFixed(iv.daysToExpiry, 1)} days` : "No expiry with enough days left"),
          tile("HV20", pct(hv.hv20), "20-day realised volatility"),
          h("section", { class: "card stat" }, h("div", { class: "stat-head" }, h("span", { class: "label" }, "IV against HV20")), h("span", { class: "value" }, isFigure(vh.ratio) ? `${formatFixed(vh.ratio, 2)}x` : DASH), h("span", { class: "sub" }, vh.label ? pill(`IV is ${vh.label}`, labelTone) : "Needs ATM IV and HV20", isFigure(vh.spread) ? ` ${formatSigned(vh.spread, 2)} points` : "")),
          h("section", { class: "card stat" }, h("div", { class: "stat-head" }, h("span", { class: "label" }, rank.title)), h("span", { class: "value" }, isFigure(rank.rank) ? formatFixed(rank.rank, 0) : DASH), h("span", { class: "sub" }, rank.fallback ? pill("HV20 fallback", "warn") : null, rank.fallback ? " " : "", rank.sub, isFigure(rank.percentile) ? ` Percentile ${formatFixed(rank.percentile, 0)}.` : "")),
        ),
        tiles(tile("HV10", pct(hv.hv10), "10 days"), tile("HV30", pct(hv.hv30), "30 days"), tile("HV60", pct(hv.hv60), "60 days"), tile("Parkinson 20", pct(hv.parkinson20), "High-low estimate")),
        sectionCard(
          "Expected move",
          move ? `One standard deviation to the ${dayLabel(move.expiry)} expiry: spot x IV x sqrt(days / 365). About two in three outcomes land inside.` : "No expected move without an ATM IV.",
          move ? [moveRuler(mm.markers, mm.band, `Expected move for ${d.underlying}: ${formatInt(move.lower)} to ${formatInt(move.upper)} around spot ${formatInt(iv.spot)}.`), kv([["Move (1σ)", `±${formatFixed(move.oneSigma, 2)}`], ["As a share of spot", `±${formatFixed(move.pct, 2)}%`], ["Lower", formatFixed(move.lower, 2)], ["Upper", formatFixed(move.upper, 2)]])] : emptyState("chart", "No expected move", "The chain carried no usable at-the-money IV."),
        ),
        sectionCard(
          "IV term structure",
          t?.termStructure ? TERM_WORDS[t.termStructure] : "ATM IV for the next expiries, oldest first.",
          term.error ? H.errorBox(term.error) : (t?.expiries ?? []).length ? [termChart(series, `ATM IV by expiry for ${d.underlying}: ${(t.expiries ?? []).map((e) => `${e.expiry} ${pct(e.atmIv)}`).join(", ")}`), table([{ label: "Expiry", cell: (e) => h("strong", {}, e.expiry) }, { label: "Days", num: true, cell: (e) => formatFixed(e.daysToExpiry, 1) }, { label: "ATM strike", num: true, cell: (e) => (isFigure(e.atmStrike) ? formatInt(e.atmStrike) : DASH) }, { label: "ATM IV", num: true, cell: (e) => pct(e.atmIv) }], t.expiries, null, { mobile: "scroll" })] : emptyState("chart", "No term structure", "No upcoming expiry has an ATM IV."),
        ),
      ];
    });
  u.el.addEventListener("change", load);
  await load();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "form-grid analytics-controls" }, u.wrap, h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Refresh"), h("button", { type: "button", class: "small", onclick: load }, icon("refresh"), "Refresh"))))), out);
}

/** The shell of the three NSE tabs: a few fields, then the rows with the NSE source and stale labels above them. */
async function nseTab(H, { fields, extra, path, draw, intro }) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const run = runner(H, out);
  const symbol = mkField(H, "Symbol", { placeholder: "All", maxlength: 20, hint: "An NSE ticker, or empty." });
  const load = () =>
    run(async () => {
      const q = new URLSearchParams(extra ? extra() : {});
      for (const x of fields) if (x.el.value.trim()) q.set(x.key, x.el.value.trim());
      if (symbol.el.value.trim()) q.set("symbol", symbol.el.value.trim().toUpperCase());
      const res = await api(`${path}?${q}`);
      const lab = nseLabel(res.data?.meta);
      return [
        h("div", { class: "row analytics-status" }, pill(lab.text, lab.tone), demoPill()),
        res.data?.meta?.stale ? note("Showing the last saved copy", "NSE could not be reached just now, so these rows are the last good answer the Bridge kept. They may be out of date.", "warn") : null,
        ...[draw(res.data?.data ?? {}, res.data?.meta ?? {})].flat(),
        h("p", { class: "muted small" }, intro),
      ];
    });
  for (const x of [...fields, symbol]) x.el.addEventListener("change", load);
  await load();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "form-grid analytics-controls" }, ...fields.map((x) => x.wrap), symbol.wrap, h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Refresh"), h("button", { type: "button", class: "small", onclick: load }, icon("refresh"), "Refresh"))))), out);
}
const NSE_NOTE = "These pages read NSE's public site, which changes without notice. If NSE changes a page, the Bridge says so instead of guessing, and shows the last good copy when it has one. Values are in INR crore.";

function topList(rows, valueKey, labelKey, extraKey) {
  return table(
    [
      { label: labelKey === "client" ? "Client" : "Symbol", cell: (r) => h("span", { class: "clip", title: r[labelKey] }, r[labelKey]) },
      { label: "Value", num: true, cell: (r) => h("span", { class: valueKey === "netCr" ? signClass(r[valueKey]) : undefined }, crore(r[valueKey])) },
      ...(extraKey ? [{ label: "Deals", num: true, cell: (r) => formatInt(r[extraKey]) }] : []),
    ],
    rows ?? [],
    h("p", { class: "muted small" }, "None."),
    { mobile: "scroll" },
  );
}

function dealsTab(H) {
  const kind = mkField(H, "Kind", { type: "select", options: [["block", "Block deals"], ["bulk", "Bulk deals"]], value: "block" });
  kind.key = "kind";
  const days = mkField(H, "Last", { type: "select", options: [["1", "1 day"], ["5", "5 days"], ["10", "10 days"], ["30", "30 days"], ["90", "90 days"]], value: "5" });
  days.key = "days";
  const minV = mkField(H, "Min value (₹ Cr)", { type: "number", min: "0", placeholder: "Any" });
  minV.key = "minValue";
  return nseTab(H, {
    fields: [kind, days, minV],
    path: "/v1/analytics/deals",
    intro: NSE_NOTE,
    draw: (d) => {
      const sum = d.summary ?? {};
      const net = Number(sum.buyCr) - Number(sum.sellCr);
      return [
        tiles(tile("Deals", formatInt(sum.deals), `${d.kind === "bulk" ? "Bulk" : "Block"} deals in the window`), tile("Bought", crore(sum.buyCr), "Buy-side value"), tile("Sold", crore(sum.sellCr), "Sell-side value"), tile("Net", crore(net), "Bought minus sold", signClass(net))),
        h("div", { class: "grid cols-2" }, sectionCard("Top buyers", "By value in the window.", topList(sum.topBuyers, "valueCr", "client", "deals")), sectionCard("Top sellers", "By value in the window.", topList(sum.topSellers, "valueCr", "client", "deals"))),
        h(
          "section",
          { class: "card" },
          h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Deals"), h("p", {}, "Newest first, then by value."))),
          h("div", { class: "card-body flush" }, dataTable([{ label: "Date", cell: (r) => dayLabel(r.date) }, { label: "Symbol", cell: (r) => h("div", { class: "cell-two" }, h("strong", {}, r.symbol), h("span", { class: "muted small" }, r.name ?? "")) }, { label: "Side", cell: (r) => pill(r.side, sideTone(r.side)) }, { label: "Client", cell: (r) => h("span", { class: "clip", title: r.client ?? "" }, r.client ?? DASH) }, { label: "Quantity", num: true, cell: (r) => formatInt(r.quantity) }, { label: "Price", num: true, cell: (r) => formatFixed(r.price, 2) }, { label: "Value", num: true, cell: (r) => crore(r.valueCr) }], d.deals ?? [], { empty: emptyState("list", "No deals", "NSE reported no deals for these filters.") })),
        ),
      ];
    },
  });
}

function insidersTab(H) {
  const days = mkField(H, "Last", { type: "select", options: [["7", "7 days"], ["30", "30 days"], ["60", "60 days"], ["90", "90 days"]], value: "30" });
  days.key = "days";
  return nseTab(H, {
    fields: [days],
    path: "/v1/analytics/insiders",
    intro: `${NSE_NOTE} Disclosures are filed by promoters and other insiders under SEBI's insider-trading rules.`,
    draw: (d) => {
      const sum = d.summary ?? {};
      return [
        tiles(tile("Net insider flow", crore(sum.netCr), sum.bias ? sum.bias[0].toUpperCase() + sum.bias.slice(1) : "", signClass(sum.netCr)), tile("Acquired", crore(sum.acquisitionCr), `${formatInt(sum.acquisitions)} disclosures`), tile("Disposed", crore(sum.disposalCr), `${formatInt(sum.disposals)} disclosures`), tile("Other", formatInt(sum.other), "Pledges and other kinds, not counted")),
        h("div", { class: "grid cols-2" }, sectionCard("Top net buyers", "Insider acquisitions minus disposals.", topList(sum.topNetBuyers, "netCr", "symbol")), sectionCard("Top net sellers", "Insider disposals minus acquisitions.", topList(sum.topNetSellers, "netCr", "symbol"))),
        h(
          "section",
          { class: "card" },
          h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Disclosures"), h("p", {}, "Newest first, then by value."))),
          h("div", { class: "card-body flush" }, dataTable([{ label: "Date", cell: (r) => dayLabel(r.date) }, { label: "Symbol", cell: (r) => h("div", { class: "cell-two" }, h("strong", {}, r.symbol), h("span", { class: "muted small" }, r.company ?? "")) }, { label: "Person", cell: (r) => h("div", { class: "cell-two" }, h("span", { class: "clip", title: r.person ?? "" }, r.person ?? DASH), h("span", { class: "muted small" }, r.category ?? "")) }, { label: "Direction", cell: (r) => pill(r.direction, sideTone(r.direction)) }, { label: "Security", cell: (r) => r.securityType ?? DASH }, { label: "Securities", num: true, cell: (r) => compact(r.securities) }, { label: "Value", num: true, cell: (r) => crore(r.valueCr) }, { label: "Mode", cell: (r) => r.mode ?? DASH }], d.disclosures ?? [], { empty: emptyState("list", "No disclosures", "NSE reported none for these filters.") })),
        ),
      ];
    },
  });
}

function eventsTab(H) {
  const days = mkField(H, "Next", { type: "select", options: [["7", "7 days"], ["14", "14 days"], ["30", "30 days"], ["60", "60 days"]], value: "14" });
  days.key = "days";
  return nseTab(H, {
    fields: [days],
    path: "/v1/analytics/events",
    intro: `${NSE_NOTE} Results and board meetings are listed on the day NSE publishes them.`,
    draw: (d) => {
      const flat = (d.days ?? []).flatMap((g) => g.events.map((e, i) => ({ ...e, date: g.date, first: i === 0 })));
      return [
        tiles(tile("Days with events", formatInt((d.days ?? []).length), "In the window"), tile("Events", formatInt(flat.length), "Results, board meetings and more"), tile("Next", d.days?.[0] ? dayLabel(d.days[0].date) : DASH, d.days?.[0] ? `${formatInt(d.days[0].events.length)} events` : "Nothing scheduled")),
        h(
          "section",
          { class: "card" },
          h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, "Calendar"), h("p", {}, "Soonest first."))),
          h("div", { class: "card-body flush" }, dataTable([{ label: "Date", cell: (r) => (r.first ? h("strong", {}, dayLabel(r.date)) : h("span", { class: "muted" }, "·")) }, { label: "Symbol", cell: (r) => h("strong", {}, r.symbol) }, { label: "Company", cell: (r) => h("span", { class: "clip", title: r.company ?? "" }, r.company ?? DASH) }, { label: "Purpose", cls: "wrap", cell: (r) => h("div", { class: "cell-two" }, h("span", {}, r.purpose ?? DASH), r.description ? h("span", { class: "muted small" }, r.description) : null) }], flat, { empty: emptyState("clock", "Nothing scheduled", "NSE lists no events for these filters.") })),
        ),
      ];
    },
  });
}

/** The NSE filings views (deals, insiders, results calendar) for Flow > Filings. */
export const filingsTabs = () => [
  { id: "deals", label: "Deals", build: dealsTab },
  { id: "insiders", label: "Insiders", build: insidersTab },
  { id: "events", label: "Results", build: eventsTab },
];
export { tabbedPage };

async function renderScreener(H) {
  return tabbedPage(H, {
    label: "Screener view",
    tabs: [
      { id: "screener", label: "Screener", build: screenerTab },
      { id: "vol", label: "Vol stats", build: volTab },
      { id: "deals", label: "Deals", build: dealsTab },
      { id: "insiders", label: "Insiders", build: insidersTab },
      { id: "events", label: "Events", build: eventsTab },
    ],
  });
}

// ───────────────────────── pages ─────────────────────────

/**
 * The four pages for views.js, in the Analytics group. `getHelpers()` returns { segmented, segField, field, errorBox }
 * and runs when a page is drawn, never at import.
 */
export function analyticsFlowPages(getHelpers) {
  const group = "Analytics";
  return [
    { id: "unusual", label: "Unusual activity", icon: "scan", tint: "red", group, title: "Unusual activity", sub: "Option contracts trading far above their usual size, ranked by score", render: () => renderUnusual(getHelpers()) },
    { id: "tide", label: "Market tide", icon: "activity", tint: "green", group, title: "Market tide", sub: "Net call against put premium through the session, and the sentiment it implies", render: () => renderTide(getHelpers()) },
    { id: "exposure", label: "Exposure", icon: "bolt", tint: "yellow", group, title: "Exposure", sub: "Delta, gamma, vanna and charm by strike and expiry, and the open-interest heatmap", render: () => renderExposure(getHelpers()) },
    { id: "screener", label: "Screener and vol", icon: "list", tint: "mint", group, title: "Screener and volatility", sub: "Filter every contract, read volatility, and follow NSE deals, insiders and events", render: () => renderScreener(getHelpers()) },
  ];
}
