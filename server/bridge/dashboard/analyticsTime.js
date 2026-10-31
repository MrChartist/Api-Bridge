// Markets › OI Analysis › Strike history and Markets › Volatility › Cone, drawn in the analytics host (analytics.js).
//  - Strike history: one strike's call and put OI and IV through the session, from the Bridge's own recorder
//    (GET /v1/options/snapshots: what it recorded, gaps never filled). Nothing is fetched from a broker for it.
//  - Cone: the ±1σ and ±2σ price range each expiry's ATM IV implies (GET /v1/analytics/surface for the IVs, the
//    underlying's quote for spot). A lognormal reading of IV, not a forecast.
// Reads go through api(); nothing polls. Figures become text through format.js only.
import { api, card, emptyState, h, table } from "./app.js";
import { DASH, formatDayMonth, formatFixed, formatInt, formatPercent, formatSigned, isFigure } from "./format.js";
import { legend, nextId, statusRow, tile, tiles } from "./analyticsViews.js";
import { seriesChart } from "./analyticsMore.js";
import { spotSymbolOf } from "./alert-core.js";
import { workspace } from "./workspace.js";

const LAKH = 1e5;
const istClock = (iso) => String(iso ?? "").slice(11, 16);

/**
 * One strike's legs through the recorded snapshots (pure): [{ time, ceOi, peOi, ceIv, peIv }], oldest first. Gaps stay
 * gaps:
 *  - a snapshot without the underlying's price, or without this strike's legs (a partial chain that missed it), is out;
 *  - a zero or missing OI or IV is no reading (null); OI of one lot or less is not a real position either;
 *  - the recorder warming up before the chain was ready (OI at the strike under 5 % of its usual level at the start of
 *    the series) is trimmed, so the chart and the deltas start at the first real point.
 */
export function strikeSeries(snapshots, strike) {
  const rows = [];
  for (const s of snapshots ?? []) {
    if (!(Number(s.spot) > 0)) continue;
    const i = (s.strikes ?? []).indexOf(Number(strike));
    if (i < 0) continue;
    const lot = Number(s.lotSize) > 0 ? Number(s.lotSize) : 0;
    const pick = (side, f) => {
      const v = s[side]?.[f]?.[i];
      if (!isFigure(v) || !(Number(v) > 0)) return null;
      return f === "oi" && Number(v) <= lot ? null : Number(v);
    };
    const row = { time: s.ts ?? s.slot, ceOi: pick("ce", "oi"), peOi: pick("pe", "oi"), ceIv: pick("ce", "iv"), peIv: pick("pe", "iv") };
    if (row.ceOi === null && row.peOi === null) continue;
    rows.push(row);
  }
  const total = (r) => (r.ceOi ?? 0) + (r.peOi ?? 0);
  const sorted = rows.map(total).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  let start = 0;
  while (start < rows.length - 1 && total(rows[start]) < median * 0.05) start += 1;
  return rows.slice(start);
}

/** First and last value of a field, and the change between them (pure). */
export function firstLast(rows, key) {
  const xs = rows.map((r) => r[key]).filter(isFigure);
  if (!xs.length) return { first: null, last: null, change: null };
  return { first: xs[0], last: xs.at(-1), change: xs.at(-1) - xs[0] };
}

/**
 * The probability cone (pure): for each expiry, spot × e^(±kσ√t) with σ the expiry's ATM IV and t its days / 365,
 * for k = 1 and 2. About 68 % and 95 % of outcomes under a lognormal reading of IV.
 * @param {number} spot @param {Array<{ expiry, daysToExpiry, atmIv }>} slices
 */
export function probabilityCone(spot, slices) {
  const S = Number(spot);
  if (!(S > 0)) return [];
  return (slices ?? [])
    .filter((x) => isFigure(x.atmIv) && Number(x.atmIv) > 0 && Number(x.daysToExpiry) > 0)
    .map((x) => {
      const sd = (Number(x.atmIv) / 100) * Math.sqrt(Number(x.daysToExpiry) / 365);
      const at = (k) => Math.round(S * Math.exp(k * sd) * 100) / 100;
      return { expiry: x.expiry, days: Number(x.daysToExpiry), atmIv: Number(x.atmIv), sdPct: Math.round(sd * 10000) / 100, down2: at(-2), down1: at(-1), up1: at(1), up2: at(2) };
    })
    .sort((a, b) => a.days - b.days);
}

const loading = () => h("p", { class: "muted", role: "status" }, "Loading…");
const lakh = (v) => (isFigure(v) ? `${formatFixed(v / LAKH, 2)} L` : DASH);

// ───────────────────────── Strike history ─────────────────────────

async function renderStrikeHistory(H) {
  const u = workspace.state.underlying;
  const e = workspace.state.expiry;
  if (!e) return emptyState("info", "No expiry to show", "Pick an underlying with upcoming expiries in the top bar.");
  const chain = (await api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(e)}&strikes=15`)).data?.data ?? {};
  const strikes = (chain.rows ?? []).map((r) => Number(r.strike)).filter((k) => k > 0);
  if (!strikes.length) return emptyState("list", "No strikes", "The chain came back empty for this expiry.");
  const strikeEl = h("select", { id: nextId("an-sh") }, strikes.map((k) => h("option", { value: String(k) }, `${formatInt(k)}${k === chain.atmStrike ? " (ATM)" : ""}`)));
  strikeEl.value = String(chain.atmStrike ?? strikes[Math.floor(strikes.length / 2)]);
  const everyEl = h("select", { id: nextId("an-sh") }, [["1", "1 min"], ["5", "5 min"], ["15", "15 min"]].map(([v, t]) => h("option", { value: v }, t)));
  everyEl.value = "5";
  const out = h("div", { class: "stack", "aria-live": "polite" });
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    out.replaceChildren(loading());
    try {
      const q = new URLSearchParams({ underlying: u, expiry: e, fields: "oi,iv", every: everyEl.value, strikes: "30", limit: "400" });
      const res = await api(`/v1/options/snapshots?${q}`);
      if (mine === seq) out.replaceChildren(...drawStrikeHistory(res, Number(strikeEl.value), u, e).filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  };
  strikeEl.addEventListener("change", load);
  everyEl.addEventListener("change", load);
  await load();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "form-grid" }, H.field("Strike", strikeEl), H.field("Every", everyEl)))), out);
}

function drawStrikeHistory(res, strike, u, e) {
  const d = res.data?.data ?? {};
  const rows = strikeSeries(d.snapshots, strike);
  if (!rows.length) {
    return [emptyState("clock", "Nothing recorded for this strike today", d.unavailable ? String(d.unavailable.reason ?? d.unavailable) : "The Bridge records chains every minute for indices while it runs. Leave it running in market hours and this fills in.")];
  }
  const ceOi = firstLast(rows, "ceOi");
  const peOi = firstLast(rows, "peOi");
  const ceIv = firstLast(rows, "ceIv");
  const peIv = firstLast(rows, "peIv");
  const label = (r) => istClock(r.time);
  const signedLakh = (v) => (isFigure(v) ? `${formatSigned(v / LAKH, 2)} L` : DASH);
  return [
    tiles(
      tile(`${formatInt(strike)} CE OI`, lakh(ceOi.last), `${signedLakh(ceOi.change)} since ${label(rows[0])}`, ceOi.change > 0 ? "up" : ceOi.change < 0 ? "down" : undefined),
      tile(`${formatInt(strike)} PE OI`, lakh(peOi.last), `${signedLakh(peOi.change)} since ${label(rows[0])}`, peOi.change > 0 ? "up" : peOi.change < 0 ? "down" : undefined),
      tile("CE IV", isFigure(ceIv.last) ? formatPercent(ceIv.last, 2) : DASH, isFigure(ceIv.change) ? `${formatSigned(ceIv.change, 2)} points` : ""),
      tile("PE IV", isFigure(peIv.last) ? formatPercent(peIv.last, 2) : DASH, isFigure(peIv.change) ? `${formatSigned(peIv.change, 2)} points` : ""),
    ),
    card({
      title: "Open interest, lakh units",
      sub: `${u} ${e} ${formatInt(strike)}, ${formatInt(rows.length)} recorded snapshots`,
      body: h("div", { class: "stack" }, legend([{ cls: "call", label: "Call (CE)" }, { cls: "put", label: "Put (PE), dashed" }]), seriesChart(
        [
          { id: "ce", label: "CE OI", cls: "call", points: rows.map((r) => ({ label: label(r), y: isFigure(r.ceOi) ? Math.round((r.ceOi / LAKH) * 100) / 100 : null })) },
          { id: "pe", label: "PE OI", cls: "put", dash: "6 4", points: rows.map((r) => ({ label: label(r), y: isFigure(r.peOi) ? Math.round((r.peOi / LAKH) * 100) / 100 : null })) },
        ],
        { label: `Call and put open interest at ${strike} through the session, in lakh units`, yDecimals: 1 },
      )),
    }),
    card({
      title: "Implied volatility, %",
      sub: "Each leg's IV as the recorder solved it",
      body: h("div", { class: "stack" }, legend([{ cls: "put", label: "Put (PE)" }, { cls: "call", label: "Call (CE), dashed over the put" }]), seriesChart(
        [
          // As on Skew: the put underneath, the call on top dashed with hollow markers, so equal IVs both show.
          { id: "pe", label: "PE IV", cls: "put", points: rows.map((r) => ({ label: label(r), y: r.peIv })) },
          { id: "ce", label: "CE IV", cls: "call", dash: "6 4", hollow: true, points: rows.map((r) => ({ label: label(r), y: r.ceIv })) },
        ],
        { label: `Call and put IV at ${strike} through the session`, yDecimals: 1 },
      )),
    }),
  ];
}

// ───────────────────────── Probability cone ─────────────────────────

async function renderCone(H) {
  const u = workspace.state.underlying;
  try {
    const sym = spotSymbolOf(u);
    const [surf, quote] = await Promise.all([api(`/v1/analytics/surface?${new URLSearchParams({ underlying: u, strikes: "5", expiries: "6" })}`), api(`/v1/quotes?symbols=${encodeURIComponent(sym)}`)]);
    const spot = (quote.data?.data?.items ?? quote.data?.data ?? []).find?.((q) => q.symbol === sym)?.ltp ?? null;
    const cone = probabilityCone(spot, surf.data?.data?.expiries);
    if (!cone.length) return emptyState("info", "No cone to draw", "The expiries came back without an ATM IV or a spot price.");
    // Points sit at their days to expiry (`at`), so the cone widens with √time instead of one step per expiry.
    const pt = (y, label, at) => ({ label, y, at });
    const now = "Now";
    const line = (k) => [pt(spot, now, 0), ...cone.map((c) => pt(c[k], formatDayMonth(c.expiry), c.days))];
    const series = [
      { id: "u2", label: "+2σ", cls: "s2", dash: "6 4", points: line("up2") },
      { id: "u1", label: "+1σ", cls: "s1", points: line("up1") },
      { id: "d1", label: "−1σ", cls: "s1", points: line("down1") },
      { id: "d2", label: "−2σ", cls: "s2", dash: "6 4", points: line("down2") },
    ];
    const calDays = (d) => formatInt(Math.floor(d));
    const cols = [
      { label: "Expiry", cell: (r) => h("strong", { title: r.expiry }, formatDayMonth(r.expiry)) },
      { label: "Calendar days", num: true, cell: (r) => calDays(r.days) },
      { label: "ATM IV", num: true, cell: (r) => formatPercent(r.atmIv, 2) },
      { label: "1σ move", num: true, cell: (r) => `±${formatFixed(r.sdPct, 2)}%` },
      { label: "−2σ", num: true, cell: (r) => formatFixed(r.down2, 0) },
      { label: "−1σ", num: true, cell: (r) => formatFixed(r.down1, 0) },
      { label: "+1σ", num: true, cell: (r) => formatFixed(r.up1, 0) },
      { label: "+2σ", num: true, cell: (r) => formatFixed(r.up2, 0) },
    ];
    const near = cone[0];
    return h(
      "div",
      { class: "stack" },
      statusRow(surf.data?.meta?.freshness),
      tiles(
        tile(`${u} spot`, formatFixed(spot, 2), "The cone starts here"),
        tile(`1σ to ${formatDayMonth(near.expiry)}`, `${formatFixed(near.down1, 0)} to ${formatFixed(near.up1, 0)}`, `About 68 % of outcomes, ±${formatFixed(near.sdPct, 2)}%`),
        tile(`2σ to ${formatDayMonth(near.expiry)}`, `${formatFixed(near.down2, 0)} to ${formatFixed(near.up2, 0)}`, "About 95 % of outcomes"),
        tile("Furthest expiry", formatDayMonth(cone.at(-1).expiry), `1σ ±${formatFixed(cone.at(-1).sdPct, 2)}% in ${calDays(cone.at(-1).days)} calendar days`),
      ),
      card({ title: "Probability cone", sub: "Spot × e^(±kσ√t) from each expiry's ATM IV: a lognormal reading of what the options price in, not a forecast", body: h("div", { class: "stack" }, legend([{ cls: "s1", label: "±1σ, about 68 % of outcomes" }, { cls: "s2", label: "±2σ, about 95 %" }]), seriesChart(series, { label: `${u} probability cone by expiry`, yDecimals: 0 })) }),
      card({ title: "By expiry", sub: "The cone's levels", body: table(cols, cone, emptyState("list", "No expiries", "")), flush: true }),
    );
  } catch (err) {
    return H.errorBox(err);
  }
}

/** The pages this module draws, for analytics.js's sources(). */
export function analyticsTimePages(getHelpers) {
  return [
    { id: "strikehist", render: () => renderStrikeHistory(getHelpers()) },
    { id: "cone", render: () => renderCone(getHelpers()) },
  ];
}
