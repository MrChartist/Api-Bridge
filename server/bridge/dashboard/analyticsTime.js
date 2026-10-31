// Markets › OI Analysis › Strike history and Markets › Volatility › Cone, drawn in the analytics host (analytics.js).
//  - Strike history: one strike's call and put OI and IV through the session, from the Bridge's own recorder
//    (GET /v1/options/snapshots: what it recorded, gaps never filled). Nothing is fetched from a broker for it.
//  - Cone: the ±1σ and ±2σ price range each expiry's ATM IV implies (GET /v1/analytics/surface for the IVs, the
//    underlying's quote for spot). A lognormal reading of IV, not a forecast.
// Reads go through api(); nothing polls. Figures become text through format.js only.
import { api, card, emptyState, h, icon, table } from "./app.js";
import { DASH, formatDayMonth, formatFixed, formatInt, formatPercent, formatSigned, isFigure } from "./format.js";
import { legend, nextId, statusRow, tile, tiles } from "./analyticsViews.js";
import { seriesChart } from "./analyticsMore.js";
import { hero } from "./analyticsOi.js";
import { changeReading } from "./oi-suite-core.js";
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

/**
 * One strike's day in one reading (pure): the net change of each side since the first reading (the OI change view's
 * words: puts added reads green, calls added red), the strike's put-call ratio then and now, and the biggest single
 * step between two readings (the moment the strike moved most). Null without rows.
 * @param {Array<{ time: string, ceOi: number|null, peOi: number|null }>} rows
 */
export function strikeReading(rows) {
  if (!rows?.length) return null;
  const ce = firstLast(rows, "ceOi");
  const pe = firstLast(rows, "peOi");
  const reading = changeReading({ ce: ce.change ?? 0, pe: pe.change ?? 0 });
  const ratio = (c, p) => (isFigure(c) && isFigure(p) && c > 0 ? p / c : null);
  let peak = null;
  for (let i = 1; i < rows.length; i += 1) {
    for (const [side, key] of [["ce", "ceOi"], ["pe", "peOi"]]) {
      const a = rows[i - 1][key];
      const b = rows[i][key];
      if (!isFigure(a) || !isFigure(b) || b === a) continue;
      if (!peak || Math.abs(b - a) > Math.abs(peak.d)) peak = { time: rows[i].time, side, d: b - a };
    }
  }
  // The ratio from one reading that has both sides (never a call from one minute over a put from another).
  const both = rows.filter((x) => isFigure(x.ceOi) && isFigure(x.peOi));
  return { ce, pe, word: reading.word, tone: reading.tone, pcrNow: both.length ? ratio(both.at(-1).ceOi, both.at(-1).peOi) : null, pcrFirst: both.length ? ratio(both[0].ceOi, both[0].peOi) : null, peak };
}

const loading = () => h("p", { class: "muted", role: "status" }, "Loading…");
/** The step between readings, from the first two: "1 min", "5 min". */
const everyText = (rows) => {
  const a = Date.parse(rows[0]?.time ?? "");
  const b = Date.parse(rows[1]?.time ?? "");
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? `${formatInt(Math.round((b - a) / 60_000))} min` : DASH;
};
const lakh = (v) => (isFigure(v) ? `${formatFixed(v / LAKH, 2)} L` : DASH);

// ───────────────────────── Strike history ─────────────────────────

async function renderStrikeHistory(H) {
  const u = workspace.state.underlying;
  const e = workspace.state.expiry;
  if (!e) return emptyState("info", "No expiry to show", "Pick an underlying with upcoming expiries in the top bar.");
  const chain = (await api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(e)}&strikes=15`)).data?.data ?? {};
  const strikes = (chain.rows ?? []).map((r) => Number(r.strike)).filter((k) => k > 0);
  if (!strikes.length) return emptyState("list", "No strikes", "The chain came back empty for this expiry.");
  const atm = chain.atmStrike ?? strikes[Math.floor(strikes.length / 2)];
  const strikeEl = h("select", { id: nextId("an-sh"), class: "oix-clock", "aria-label": "Strike" }, strikes.map((k) => h("option", { value: String(k) }, `${formatInt(k)}${k === chain.atmStrike ? " · ATM" : ""}`)));
  strikeEl.value = String(atm);
  // The strike as a capsule stepper: ‹ strike › (the select in the middle lists every strike read).
  const step = (dir) => {
    const i = strikes.indexOf(Number(strikeEl.value)) + dir;
    if (i < 0 || i >= strikes.length) return;
    strikeEl.value = String(strikes[i]);
    load();
  };
  const stepBtn = (dir, label) => {
    const b = h("button", { type: "button", class: `icon-btn small oix-rp-btn${dir < 0 ? " back" : ""}`, "aria-label": label, title: label }, h("span", { class: "oix-rp-ic", "aria-hidden": "true" }, icon("chevron")));
    b.addEventListener("click", () => step(dir));
    return b;
  };
  const strikeCap = h("div", { class: "oix-range sh-stepper", role: "group", "aria-label": "Strike" }, stepBtn(-1, "Lower strike"), strikeEl, stepBtn(1, "Higher strike"));
  const everyEl = H.segmented("Every", [["1", "1m"], ["5", "5m"], ["15", "15m"]], "5");
  everyEl.classList.add("oix-cap");
  const tools = [strikeCap, everyEl];
  const out = h("div", { class: "stack" });
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    out.setAttribute("aria-busy", "true");
    try {
      const q = new URLSearchParams({ underlying: u, expiry: e, fields: "oi,iv", every: everyEl.value, strikes: "30", limit: "400" });
      const res = await api(`/v1/options/snapshots?${q}`);
      if (mine === seq) out.replaceChildren(...drawStrikeHistory(res, Number(strikeEl.value), u, e, atm, tools).filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
    if (mine === seq) out.removeAttribute("aria-busy");
  };
  strikeEl.addEventListener("change", load);
  everyEl.addEventListener("change", load);
  out.replaceChildren(loading());
  await load();
  return out;
}

function drawStrikeHistory(res, strike, u, e, atm, tools) {
  const d = res.data?.data ?? {};
  const rows = strikeSeries(d.snapshots, strike);
  if (!rows.length) {
    return [hero({ title: "Strike history", word: "Nothing recorded yet", detail: d.unavailable ? String(d.unavailable.reason ?? d.unavailable) : "The Bridge records index chains every minute while it runs in market hours; this fills in as the session is recorded.", tools })];
  }
  const ceIv = firstLast(rows, "ceIv");
  const peIv = firstLast(rows, "peIv");
  const label = (r) => istClock(r.time);
  const signedLakh = (v) => (isFigure(v) ? `${formatSigned(v / LAKH, 2)} L` : DASH);
  const r = strikeReading(rows);
  const tone = (v) => (!isFigure(v) || v === 0 ? "ink-zero" : v > 0 ? "ink-pos" : "ink-neg");
  const side = (s) => (s === "ce" ? "call" : "put");
  const where = strike === atm ? "at the money" : strike > atm ? "above the money" : "below the money";
  const pcrTxt = (v) => (isFigure(v) ? formatFixed(v, 2) : DASH);
  return [
    hero({
      title: "Strike history",
      word: `${formatInt(strike)} · ${r.word}`,
      tone: r.tone,
      detail: `Since ${label(rows[0])} the call side ${r.ce.change >= 0 ? "added" : "cut"} ${lakh(Math.abs(r.ce.change ?? 0))} and the put side ${r.pe.change >= 0 ? "added" : "cut"} ${lakh(Math.abs(r.pe.change ?? 0))}.${r.peak ? ` The biggest single step was the ${side(r.peak.side)} at ${label({ time: r.peak.time })}: ${signedLakh(r.peak.d)}.` : ""} Contracts opened or closed, not who holds them.`,
      scope: `${u} ${formatDayMonth(e)} · ${formatInt(strike)} ${where} · ${formatInt(rows.length)} recorded readings · every ${everyText(rows)} · as of ${label(rows.at(-1))} IST`,
      figs: [
        ["Call OI", lakh(r.ce.last), "", h("span", { class: tone(r.ce.change) }, `${signedLakh(r.ce.change)} since ${label(rows[0])}`)],
        ["Put OI", lakh(r.pe.last), "", h("span", { class: tone(r.pe.change) }, `${signedLakh(r.pe.change)} since ${label(rows[0])}`)],
        ["Strike PCR", pcrTxt(r.pcrNow), isFigure(r.pcrNow) ? (r.pcrNow >= 1 ? "ink-pos" : "ink-neg") : "", isFigure(r.pcrFirst) ? `From ${pcrTxt(r.pcrFirst)} · ${isFigure(r.pcrNow) && r.pcrNow >= 1 ? "put-heavy" : "call-heavy"}` : ""],
        ["IV call · put", `${isFigure(ceIv.last) ? formatPercent(ceIv.last, 1) : DASH} · ${isFigure(peIv.last) ? formatPercent(peIv.last, 1) : DASH}`, "", isFigure(ceIv.change) || isFigure(peIv.change) ? `${isFigure(ceIv.change) ? formatSigned(ceIv.change, 2) : DASH} · ${isFigure(peIv.change) ? formatSigned(peIv.change, 2) : DASH} points` : ""],
      ],
      tools,
    }),
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
