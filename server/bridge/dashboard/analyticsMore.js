// More Analytics pages: Futures (chain, basis history, synthetic), FII and DII flows, Expiry day, OI change and
// spurts, Strategies (find, build), Greeks grid and straddle, Alert rules, Positions (Greeks, lot split).
//
// Same rules as analyticsViews.js, whose helpers it builds on: this Bridge only (no external requests), inline SVG made
// by the DOM, colours from classes in app.css (theme tokens, light and dark), no style attributes, numbers printed with
// format.js. The maths that decides geometry, wording and request bodies is pure and exported for
// analyticsViews.test.mjs; only the functions further down touch the DOM. views.js adds the pages with
// analyticsMorePages(() => helpers), after the first six, so the numbered shortcuts do not move.
import { alertBox, api, app, card, emptyState, h, icon, istDateTime, modal, pill, table, toast } from "./app.js";
import { intentHandoff } from "./trade-intent.js";
import { DASH, formatFixed, formatInt, formatNumber, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import { TAG_CHAR_W, calcStatus, chainControls, chartHeight, chartHost, compact, dataDisclosure, demoPill, handoff, legend, linear, nextId, niceScale, payoffChart, readNumber, s, statusRow, strikeBars, svgRoot, tickDecimals, tile, tiles } from "./analyticsViews.js";

// ───────────────────────── pure helpers ─────────────────────────

const r1 = (v) => Math.round(v * 10) / 10;
const istFormat = (o) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...o });
const F_DAY = istFormat({ day: "numeric", month: "short" });
const F_TIME = istFormat({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const F_BOTH = istFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "30 Oct" for a YYYY-MM-DD date (the day in India, whatever the viewer's time zone). */
export const dayLabel = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? F_DAY.format(new Date(`${iso}T12:00:00+05:30`)) : String(iso ?? DASH));

/** How to label candle times: whole days for daily candles, the clock for one day, both when intraday spans days. */
export function timeMode(times, interval) {
  if (interval === "1d" || interval === "1w" || interval === "1M") return "day";
  const t = times.filter(isFigure).map(Number);
  if (!t.length) return "time";
  return Math.max(...t) - Math.min(...t) > 20 * 3600 ? "both" : "time";
}
/** A candle's time (epoch seconds) as an IST label in the given mode. */
export function barTimeLabel(sec, mode) {
  if (!isFigure(sec)) return DASH;
  const d = new Date(Number(sec) * 1000);
  return mode === "day" ? F_DAY.format(d) : mode === "both" ? F_BOTH.format(d) : F_TIME.format(d);
}

/**
 * Line chart geometry over evenly spaced points (candles), so overnight gaps do not stretch the picture. `series`:
 * [{ id, label, cls, dash?, points: [{ label, y }] }]; `refs`: horizontal reference lines [{ y, label }].
 */
export function seriesLayout(series, { width = 640, height, padL = 50, padR = 14, padT = 12, padB = 28, yDecimals = 2, refs = [] } = {}) {
  const w = Math.max(240, width);
  const hgt = height ?? Math.round(Math.min(300, Math.max(200, w * 0.45)));
  const n = Math.max(0, ...series.map((x) => x.points.length));
  const ys = [...series.flatMap((x) => x.points.map((p) => p.y).filter(isFigure).map(Number)), ...refs.map((x) => x.y).filter(isFigure).map(Number)];
  const empty = ys.length === 0;
  const ysc = niceScale(empty ? 0 : Math.min(...ys), empty ? 1 : Math.max(...ys), 4);
  const x = n <= 1 ? () => (padL + w - padR) / 2 : linear(0, n - 1, padL, w - padR);
  const y = linear(ysc.min, ysc.max, hgt - padB, padT);
  const longest = series.reduce((b, x2) => (x2.points.length > (b?.points.length ?? 0) ? x2 : b), null);
  const want = Math.max(2, Math.floor((w - padL - padR) / 84));
  const idx = new Set();
  if (n > 0) {
    const k = Math.min(want, n);
    for (let i = 0; i < k; i++) idx.add(k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1)));
  }
  const xTicks = [...idx].sort((a, b) => a - b).map((i) => ({ x: r1(x(i)), label: longest.points[i].label }));
  const showDots = n <= 40;
  const paths = series.map((sr) => {
    let d = "";
    let pen = false;
    const dots = [];
    sr.points.forEach((p, i) => {
      if (!isFigure(p.y)) {
        pen = false;
        return;
      }
      const px = r1(x(i));
      const py = r1(y(Number(p.y)));
      d += `${pen ? "L" : "M"}${px} ${py}`;
      pen = true;
      if (showDots) dots.push({ x: px, y: py, title: `${sr.label}, ${p.label}: ${formatFixed(p.y, yDecimals)}` });
    });
    return { id: sr.id, label: sr.label, cls: sr.cls, dash: sr.dash ?? null, hollow: Boolean(sr.hollow), d, dots };
  });
  return {
    width: w,
    height: hgt,
    padL,
    padR,
    padT,
    padB,
    plotRight: w - padR,
    plotBottom: hgt - padB,
    empty,
    xTicks,
    yTicks: ysc.ticks.map((t) => ({ y: r1(y(t)), label: formatFixed(t, tickDecimals(ysc.step, yDecimals)), value: t })),
    refs: refs.filter((rf) => isFigure(rf.y)).map((rf) => ({ y: r1(y(Number(rf.y))), label: rf.label })),
    paths,
  };
}

/**
 * A ruler: markers [{ id, label, value, cls }] on one price axis with an optional shaded `band` { from, to }. Labels
 * stack in lanes above the axis so two close values never print over each other, and every label stays inside the width.
 */
export function rulerLayout(markers, { width = 640, band = null } = {}) {
  const w = Math.max(240, width);
  const list = markers.filter((m) => isFigure(m.value));
  if (!list.length) return { width: w, height: 0, empty: true, items: [], band: null, axisY: 0, lanes: 0 };
  const edge = [...list.map((m) => Number(m.value)), ...(band ? [band.from, band.to] : [])].filter(isFigure);
  let lo = Math.min(...edge);
  let hi = Math.max(...edge);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.05;
  const x = linear(lo - pad, hi + pad, 10, w - 10);
  const laneH = 16;
  const lastRight = [];
  const items = [...list]
    .sort((a, b) => a.value - b.value)
    .map((m) => {
      const text = `${m.label} ${formatInt(m.value)}`;
      const tw = Math.ceil(text.length * TAG_CHAR_W);
      const px = x(Number(m.value));
      const left = Math.min(Math.max(px - tw / 2, 2), w - tw - 2);
      let lane = lastRight.findIndex((right) => right + 6 <= left);
      if (lane < 0) lane = lastRight.length;
      lastRight[lane] = left + tw;
      return { id: m.id, cls: m.cls, text, value: Number(m.value), x: r1(px), left: r1(left), lane };
    });
  const lanes = lastRight.length;
  const axisY = 8 + lanes * laneH + 8;
  return {
    width: w,
    height: axisY + 16,
    empty: false,
    axisY,
    lanes,
    laneH,
    items: items.map((i) => ({ ...i, textY: axisY - 14 - i.lane * laneH })),
    band: band ? { x0: r1(x(Math.min(band.from, band.to))), x1: r1(x(Math.max(band.from, band.to))) } : null,
  };
}

/** Flow rows for the grouped bar chart: one row per session (newest first, as the Bridge sends them), FII and DII net. */
export function flowItems(days) {
  return (days ?? []).map((d) => {
    const lab = dayLabel(d.date);
    const t = (who, v) => `${lab} ${who} net ${formatSigned(v.net, 2)} crore (bought ${formatFixed(v.buy, 2)}, sold ${formatFixed(v.sell, 2)})`;
    return { label: lab, bars: [{ value: d.fii?.net ?? 0, cls: "s1", title: t("FII", d.fii ?? {}) }, { value: d.dii?.net ?? 0, cls: "s2", title: t("DII", d.dii ?? {}) }] };
  });
}
/** A streak as a tile: net buying or selling and for how many sessions. */
export function streakText(st) {
  if (!st || st.direction === "flat" || !st.count) return { value: "Flat", sub: "No run of net buying or selling" };
  return { value: st.direction === "buying" ? "Net buying" : "Net selling", sub: `${st.count} session${st.count === 1 ? "" : "s"} in a row`, tone: st.direction === "buying" ? "up" : "down" };
}
/** Rolling sums as table rows with a note when fewer sessions are held than the window. */
export function rollingRows(rolling) {
  return (rolling ?? []).map((r) => ({ ...r, label: r.window === 1 ? "Latest session" : `Last ${r.window} sessions`, partial: r.days < r.window }));
}

/** Words for how unusual a z-score is. */
export function zWords(z) {
  if (!isFigure(z)) return "Not enough history yet";
  const a = Math.abs(Number(z));
  const dir = Number(z) > 0 ? "wider" : "narrower";
  return a < 1 ? "Typical for this period" : a < 2 ? `Somewhat ${dir} than usual` : `Much ${dir} than usual`;
}
/** Futures state as plain words. */
export const stateWord = (st) => ({ contango: "Premium to spot", backwardation: "Discount to spot", flat: "Level with spot" })[st] ?? DASH;

/** Remaining time to the expiry cut-off, in words. */
export function countdownText(hours) {
  if (!isFigure(hours)) return DASH;
  const hrs = Number(hours);
  if (hrs <= 0) return "Expired";
  if (hrs >= 48) return `${formatFixed(hrs / 24, 1)} days`;
  const mins = Math.round(hrs * 60);
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}
export const SEVERITY = { high: { text: "High", tone: "bad" }, medium: { text: "Medium", tone: "warn" }, low: { text: "Low", tone: "" } };

/** What a build-up code means, in words, with a pill tone. */
export const BUILD_UP = {
  long_build_up: { label: "Long build-up", tone: "ok", hint: "Price up and OI up: new buyers" },
  short_build_up: { label: "Short build-up", tone: "bad", hint: "Price down and OI up: new sellers" },
  long_unwinding: { label: "Long unwinding", tone: "warn", hint: "Price down and OI down: buyers leaving" },
  short_covering: { label: "Short covering", tone: "info", hint: "Price up and OI down: sellers leaving" },
};
export const buildUpInfo = (code) => BUILD_UP[code] ?? { label: "Unclear", tone: "", hint: "Price or OI did not move" };

/** OI change rows (one per strike and side) as grouped bar rows per strike, highest strike first. */
export function oiChangeItems(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    const e = by.get(r.strike) ?? { ce: 0, pe: 0 };
    e[r.side === "CE" ? "ce" : "pe"] = Number(r.oiChange) || 0;
    by.set(r.strike, e);
  }
  return [...by.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([strike, e]) => ({
      label: formatInt(strike),
      bars: [
        { value: e.ce, cls: "call", title: `${formatInt(strike)} call OI change ${formatSigned(e.ce, 0)}` },
        { value: e.pe, cls: "put", title: `${formatInt(strike)} put OI change ${formatSigned(e.pe, 0)}` },
      ],
    }));
}
/** One line on the window that was really compared. */
export function windowNote(d) {
  if (!d || !isFigure(d.from) || !isFigure(d.to)) return "";
  const min = (Number(d.to) - Number(d.from)) / 60_000;
  const span = min < 1 ? "under a minute" : `${formatFixed(min, min < 10 ? 1 : 0)} min`;
  if (d.windowCovered === false && isFigure(d.windowMs)) return `You asked for ${formatInt(Number(d.windowMs) / 60_000)} min, but this Bridge has only watched this chain for ${span}, so that is the window used.`;
  return `Compared with the reading from ${span} ago.`;
}

export const GRID_METRICS = [["gamma", "Gamma"], ["vega", "Vega"], ["theta", "Theta"], ["delta", "Delta"], ["iv", "IV %"]];
export const GRID_DP = { delta: 3, gamma: 5, theta: 2, vega: 2, iv: 2 };
/** Greeks grid strikes as grouped call and put bars for one metric. Null becomes a zero-length bar. */
export function gridItems(strikes, metric) {
  const dp = GRID_DP[metric] ?? 2;
  return [...(strikes ?? [])]
    .sort((a, b) => b.strike - a.strike)
    .map((r) => ({
      label: formatInt(r.strike),
      bars: [
        { value: isFigure(r.ce?.[metric]) ? Number(r.ce[metric]) : 0, cls: "call", title: `${formatInt(r.strike)} call ${metric} ${formatFixed(r.ce?.[metric], dp)}` },
        { value: isFigure(r.pe?.[metric]) ? Number(r.pe[metric]) : 0, cls: "put", title: `${formatInt(r.strike)} put ${metric} ${formatFixed(r.pe?.[metric], dp)}` },
      ],
    }));
}
/** Synthetic-future gaps by strike as single bars: right (blue) means the synthetic is dearer than the reference. */
export function syntheticItems(strikes, atm) {
  return [...(strikes ?? [])]
    .sort((a, b) => b.strike - a.strike)
    .map((r) => ({
      label: formatInt(r.strike),
      band: r.strike === atm ? "atm" : null,
      tag: r.strike === atm ? "ATM" : null,
      bars: [{ value: isFigure(r.arbitrageGap) ? Number(r.arbitrageGap) : 0, cls: Number(r.arbitrageGap) >= 0 ? "call" : "put", title: `${formatInt(r.strike)} synthetic ${formatFixed(r.synthetic, 2)}, gap ${formatSigned(r.arbitrageGap, 2)}` }],
    }));
}
export const directionWord = (d) => ({ "sell-synthetic": "Synthetic is dear", "buy-synthetic": "Synthetic is cheap" })[d] ?? DASH;

/** "Buy 24500 CE at 120.00" for one built leg. */
export function legPhrase(l) {
  const side = l.side === "sell" ? "Sell" : "Buy";
  const price = isFigure(l.price) ? formatFixed(l.price, 2) : DASH;
  return l.type === "FUT" ? `${side} future at ${price}` : `${side} ${formatInt(l.strike)} ${l.type} at ${price}`;
}
/** Built legs as the payoff page's editor fields. */
export const legsToEditor = (legs) => (legs ?? []).map((l) => ({ type: l.type, side: l.side, strike: l.type === "FUT" || l.strike == null ? "" : String(l.strike), price: String(l.price ?? ""), lots: String(l.lots ?? 1), lotSize: String(l.lotSize ?? 1) }));
/** The headline figures of an analysed strategy as [label, value, tone] rows. */
export function strategyFigures(a) {
  const loss = a.unboundedRisk ? "Unlimited" : isFigure(a.maxLoss) ? formatRupee(a.maxLoss) : DASH;
  return [
    ["Max profit", a.unboundedProfit ? "Unlimited" : isFigure(a.maxProfit) ? formatRupee(a.maxProfit) : DASH, a.unboundedProfit || Number(a.maxProfit) > 0 ? "up" : ""],
    ["Max loss", loss, a.unboundedRisk || Number(a.maxLoss) < 0 ? "down" : ""],
    ["Chance of profit", isFigure(a.probabilityOfProfit) ? formatPercent(Number(a.probabilityOfProfit) * 100, 1) : DASH, ""],
    [a.credit ? "Net credit" : "Net debit", isFigure(a.netPremium) ? formatRupee(Math.abs(a.netPremium)) : DASH, ""],
    ["Break-evens", a.breakevens?.length ? a.breakevens.map((b) => formatFixed(b, 2)).join(", ") : "None", ""],
    ["Reward for risk", isFigure(a.riskReward) ? `${formatFixed(a.riskReward, 2)} to 1` : DASH, ""],
  ];
}

// Alert rules: the metric list, the sentence for a rule, and the request body from the builder's fields.
export const RULE_METRICS = [
  { id: "pcr_oi", label: "PCR (put-call ratio by OI)", short: "PCR (OI)", kind: "threshold", unit: "", hint: "Above 1 means more put OI than call OI.", example: "1.2" },
  { id: "max_pain_distance", label: "Distance from max pain", short: "distance from max pain", kind: "threshold", unit: "% of spot", hint: "How far spot has moved from the max pain strike, in percent of spot.", example: "0.5" },
  { id: "atm_iv", label: "At-the-money IV", short: "ATM IV", kind: "threshold", unit: "%", hint: "Implied volatility of the at-the-money options, in percent.", example: "15" },
  { id: "basis_pct", label: "Futures basis", short: "futures basis", kind: "threshold", unit: "% of spot", hint: "Future minus spot, in percent of spot.", example: "0.4" },
  { id: "gex_regime", label: "Gamma regime changes", short: "gamma regime", kind: "regime", unit: "", hint: "Fires when dealer gamma flips between positive, negative and neutral.", example: "" },
  { id: "spot_cross", label: "Spot crosses a level", short: "spot", kind: "cross", unit: "", hint: "Fires when the underlying's price crosses the level you type.", example: "24500", noExpiry: true },
  { id: "strike_oi_change", label: "OI change at one strike", short: "OI change", kind: "threshold", unit: "% since the previous close", hint: "Open interest added (or cut) at the strike since the previous close, in percent of that close.", example: "25", perStrike: true },
  { id: "strike_iv", label: "IV at one strike", short: "IV", kind: "threshold", unit: "%", hint: "Implied volatility of the contract at that strike, in percent.", example: "18", perStrike: true },
  { id: "atm_iv_change", label: "ATM IV change today", short: "ATM IV change", kind: "threshold", unit: "points", hint: "ATM IV now against the day's first check, in volatility points (a rise of 2 is 14% to 16%).", example: "2" },
  { id: "iv_rank", label: "ATM IV rank", short: "IV rank", kind: "threshold", unit: "", hint: "Where today's ATM IV sits in its past year, 0 to 100.", example: "80" },
  { id: "unusual_count", label: "Unusual contracts", short: "count of unusual contracts", kind: "threshold", unit: "", hint: "Contracts scoring 50 or more on Flow › Unusual activity.", example: "3" },
  { id: "tide_sentiment", label: "Flow sentiment changes", short: "flow sentiment", kind: "regime", unit: "", hint: "Fires when Market tide's sentiment turns bullish, bearish or neutral.", example: "", to: ["bullish", "bearish", "neutral"] },
  { id: "volume_spike", label: "Volume against its 20-day average", short: "volume against its 20-day average", kind: "threshold", unit: "x", hint: "Today's volume as a multiple of the 20-day average.", example: "2", noExpiry: true },
  { id: "fii_net_streak", label: "FII buying or selling streak", short: "FII net streak", kind: "threshold", unit: "days", hint: "Days in a row of FII net buying (positive) or selling (negative).", example: "3", noExpiry: true },
];
export const metricInfo = (id) => RULE_METRICS.find((m) => m.id === id) ?? RULE_METRICS[0];

/** "Tell me when NIFTY's PCR (OI) rises above 1.2 (expiry 2026-11-26)." */
export function describeRule(r) {
  const m = metricInfo(r.metric);
  const u = String(r.underlying ?? "").toUpperCase() || "the underlying";
  const where = r.expiry && !m.noExpiry ? ` (expiry ${r.expiry})` : "";
  const at = m.perStrike && isFigure(r.strike) ? ` at ${formatInt(r.strike)} ${r.right ?? ""}`.trimEnd() : "";
  const val = isFigure(r.value) ? formatNumber(r.value, { maximumFractionDigits: 4 }) : "...";
  if (m.kind === "regime") return `Tell me when ${u}'s ${m.short} changes${r.to ? ` to ${r.to}` : ""}${where}.`;
  if (m.kind === "cross") return r.op === "above" ? `Tell me when ${u} moves up through ${val}.` : r.op === "below" ? `Tell me when ${u} moves down through ${val}.` : `Tell me when ${u} crosses ${val} in either direction.`;
  const unit = m.unit === "%" ? "%" : m.unit ? ` ${m.unit}` : "";
  return `Tell me when ${u}'s ${m.short}${at} ${r.op === "below" ? "falls below" : "rises above"} ${val}${unit}${where}.`;
}

/**
 * The POST /v1/analytics/alert-rules body from the builder's text fields, or { ok: false, errors }.
 * @param {{ name: string, underlying: string, expiry: string, metric: string, op: string, value: string, to: string, every: string, marketHoursOnly: boolean }} f
 */
export function ruleBody(f) {
  const m = metricInfo(f.metric);
  const errors = [];
  const underlying = String(f.underlying ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9&_-]{1,30}$/.test(underlying)) errors.push("Underlying must be a symbol such as NIFTY.");
  const body = { name: "", underlying, metric: m.id, marketHoursOnly: Boolean(f.marketHoursOnly), enabled: true };
  if (!m.noExpiry) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.expiry ?? ""))) errors.push("Pick an expiry.");
    else body.expiry = f.expiry;
  }
  if (m.perStrike) {
    const k = readNumber(f.strike);
    if (k === null || k <= 0) errors.push("Type the strike to watch.");
    else body.strike = k;
    body.right = f.right === "PE" ? "PE" : "CE";
  }
  if (m.kind !== "regime") {
    const v = readNumber(f.value);
    if (v === null) errors.push(m.kind === "cross" ? "Type the price level to watch." : "Type the number to compare with.");
    else if (m.id === "pcr_oi" && v < 0) errors.push("PCR cannot be below 0.");
    else if (m.id === "atm_iv" && v <= 0) errors.push("IV must be above 0.");
    else if (m.id === "max_pain_distance" && v < 0) errors.push("The distance cannot be below 0.");
    else if (m.id === "spot_cross" && v <= 0) errors.push("The level must be above 0.");
    else if (m.id === "strike_iv" && v <= 0) errors.push("IV must be above 0.");
    else body.value = v;
    body.op = m.kind === "cross" ? (["above", "below", "either"].includes(f.op) ? f.op : "either") : f.op === "below" ? "below" : "above";
  } else if (f.to) body.to = f.to;
  if (String(f.every ?? "").trim()) {
    const n = readNumber(f.every);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 1440) errors.push("Check every must be a whole number of minutes from 1 to 1440.");
    else body.everyMinutes = n;
  }
  const name = String(f.name ?? "").trim() || describeRule({ ...body, expiry: body.expiry }).replace(/^Tell me when /, "").replace(/\.$/, "");
  if (name.length > 80) body.name = `${name.slice(0, 77)}...`;
  else body.name = name;
  return errors.length ? { ok: false, errors } : { ok: true, body };
}

/** A saved rule's state in words, with a pill tone. */
export function ruleState(r) {
  if (r.disabledReason) return { text: `Off: ${r.disabledReason}`, tone: "bad" };
  if (r.enabled === false) return { text: "Paused", tone: "warn" };
  if (r.lastError) return { text: "Last check failed", tone: "bad" };
  const c = r.lastCheck;
  if (!c) return { text: "Not checked yet", tone: "" };
  if (c.status === "no_data") return { text: "No data at last check", tone: "warn" };
  if (c.status === "baseline") return { text: "Watching: starting point taken", tone: "info" };
  return c.condition ? { text: "Triggered: waiting to clear", tone: "warn" } : { text: "Armed: waiting for it", tone: "ok" };
}
/** How a rule is checked, in words. */
export const ruleSchedule = (r) => (r.everyMinutes ? `Every ${r.everyMinutes} min${r.marketHoursOnly === false ? "" : ", market hours only"}` : "Only when you check it");
/** What a dry-run result means, in one sentence. */
export function dryRunText(c) {
  if (!c) return "";
  if (c.status === "no_data") return "There was no data to check right now, so nothing can be said.";
  if (c.status === "baseline") return "This took the starting reading. A crossing or regime change needs a starting point, so it would not fire on this check.";
  if (c.fired) return `It would fire now: ${c.message}`;
  if (c.condition) return "The condition is true, but the rule has already fired and is waiting for it to clear before it can fire again.";
  return "The condition is not met, so it would not fire.";
}

/** The POST /v1/analytics/lot-split body from the planner's fields, or { ok: false, error }. */
export function lotSplitBody({ symbol, lots, lotSize, freezeQty, iceberg, sliceLots, delayMs }) {
  const sym = String(symbol ?? "").trim();
  if (!sym) return { ok: false, error: "Type the contract, for example NFO:NIFTY-2026-11-24-FUT." };
  const whole = (v, name, min) => {
    const n = readNumber(v);
    return n === null || !Number.isInteger(n) || n < min ? `${name} must be a whole number, ${min} or more.` : null;
  };
  const problem = whole(lots, "Lots", 1) ?? whole(lotSize, "Lot size", 1) ?? (String(freezeQty ?? "").trim() ? whole(freezeQty, "Freeze quantity", 1) : null) ?? (iceberg && String(sliceLots ?? "").trim() ? whole(sliceLots, "Lots per slice", 1) : null) ?? (iceberg && String(delayMs ?? "").trim() ? whole(delayMs, "Delay", 0) : null);
  if (problem) return { ok: false, error: problem };
  if (iceberg && String(delayMs ?? "").trim() && readNumber(delayMs) > 3_600_000) return { ok: false, error: "Delay cannot be more than 3600000 ms (one hour)." };
  const body = { symbol: sym, quantity: readNumber(lots) * readNumber(lotSize), lotSize: readNumber(lotSize) };
  if (String(freezeQty ?? "").trim()) body.freezeQty = readNumber(freezeQty);
  if (iceberg) {
    body.iceberg = {};
    if (String(sliceLots ?? "").trim()) body.iceberg.sliceLots = readNumber(sliceLots);
    if (String(delayMs ?? "").trim()) body.iceberg.delayMs = readNumber(delayMs);
  }
  return { ok: true, body };
}

// ───────────────────────── SVG (DOM) ─────────────────────────

/** A line chart over candles. See seriesLayout. */
export function seriesChart(series, { label, yDecimals = 2, refs = [] }) {
  return chartHost((w) => {
    const L = seriesLayout(series, { width: w, yDecimals, refs, height: chartHeight(w) });
    const svg = svgRoot(L.width, L.height, label);
    if (L.empty) return svg;
    for (const t of L.yTicks) svg.append(s("line", { class: "grid-line", x1: L.padL, x2: L.plotRight, y1: t.y, y2: t.y }), s("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.xTicks) svg.append(s("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    for (const rf of L.refs) svg.append(s("line", { class: "marker-line", x1: L.padL, x2: L.plotRight, y1: rf.y, y2: rf.y }), s("text", { class: "tag", x: L.plotRight - 2, y: rf.y - 5, "text-anchor": "end" }, rf.label));
    for (const p of L.paths) {
      if (p.d) svg.append(s("path", { class: `line ${p.cls}`, d: p.d, "stroke-dasharray": p.dash }));
      for (const d of p.dots) svg.append(s("circle", { class: `dot ${p.cls}${p.hollow ? " hollow" : ""}`, cx: d.x, cy: d.y, r: p.hollow ? 3.5 : 3 }, s("title", {}, d.title)));
    }
    return svg;
  });
}

/** The ruler chart: shaded band, axis, and labelled markers. */
function rulerChart(markers, { band, label }) {
  return chartHost((w) => {
    const L = rulerLayout(markers, { width: w, band });
    const svg = svgRoot(L.width, Math.max(L.height, 40), label);
    if (L.empty) return svg;
    if (L.band) svg.append(s("rect", { class: "range-fill", x: L.band.x0, y: L.axisY - 7, width: Math.max(1, L.band.x1 - L.band.x0), height: 14, rx: 3 }));
    svg.append(s("line", { class: "axis-line", x1: 10, x2: L.width - 10, y1: L.axisY, y2: L.axisY }));
    for (const i of L.items) {
      svg.append(s("line", { class: `leader ${i.cls}`, x1: i.x, x2: i.x, y1: i.textY + 3, y2: L.axisY + 6 }), s("circle", { class: `m-dot ${i.cls}`, cx: i.x, cy: L.axisY, r: 4 }), s("text", { class: `tag m-text ${i.cls}`, x: i.left, y: i.textY, "text-anchor": "start" }, i.text));
    }
    return svg;
  });
}

// ───────────────────────── page scaffolding ─────────────────────────

const loadingNode = () => h("p", { class: "muted", role: "status" }, "Loading…");
const note = (title, detail, tone = "info") => alertBox({ title, detail }, tone);
const partial = (errors, title = "Some prices could not be read") => (errors?.length ? note(title, errors.slice(0, 4).map((e) => `${e.symbol ?? e.underlying ?? ""}${e.symbol || e.underlying ? ": " : ""}${e.message}`).join(" · "), "warn") : null);
const money = (v) => (isFigure(v) ? formatRupee(v) : DASH);
const signedClass = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : undefined);
const signedSpan = (v, dp = 2, suffix = "") => (isFigure(v) ? h("span", { class: signedClass(v) }, `${formatSigned(v, dp)}${suffix}`) : DASH);
const sectionCard = (title, sub, ...body) => card({ title, sub, body: h("div", { class: "stack" }, body) });
/** Labelled figures in a compact grid inside a card. `rows`: [label, value, tone?]. */
const kv = (rows) => h("dl", { class: "kv" }, rows.map(([k, v, tone]) => h("div", {}, h("dt", {}, k), h("dd", { class: tone || undefined }, v))));

/** A field spec's control. `spec`: { key, label, type: "select"|"number"|"text", options, value, hint, min, max, step, placeholder, onChange }. */
function makeField(H, spec) {
  const id = nextId("an-f");
  const el =
    spec.type === "select"
      ? h("select", { id }, spec.options.map(([v, t]) => h("option", { value: v }, t)))
      : h("input", { id, type: spec.type === "number" ? "number" : "text", inputmode: spec.type === "number" ? "decimal" : undefined, step: spec.step ?? "any", min: spec.min, max: spec.max, placeholder: spec.placeholder, spellcheck: "false", autocomplete: "off" });
  el.value = spec.value ?? (spec.type === "select" ? spec.options[0]?.[0] ?? "" : "");
  const wrap = H.field(spec.label, el, spec.hint);
  if (spec.wide) wrap.classList.add("wide-field");
  return { key: spec.key, el, wrap, spec };
}

/**
 * A page of tabs over one set of controls. Each tab: { id, label, underlying?, expiry?, strikes?, fields?, run({ v, o, wb }) }
 * where `run` returns the nodes to show and `v` / `o` are the chain controls and the tab's own fields. A change to any
 * control reloads the open tab; the result area shows loading, the Bridge's error, or the drawing.
 */
async function workbench(H, { tabs, label = "View" }) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  // In the dashboard shell each tab is a page tab of its own (analytics.js passes H.tab): no inner switch then.
  const forced = H.tab && tabs.some((t) => t.id === H.tab) ? H.tab : null;
  const seg = !forced && tabs.length > 1 ? H.segmented(label, tabs.map((t) => [t.id, t.label]), tabs[0].id) : null;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const active = () => byId.get(forced ?? (seg ? seg.value : tabs[0].id));
  let seq = 0;
  const wb = {};
  for (const t of tabs) {
    t.fieldMap = new Map((t.fields ?? []).map((f) => [f.key, makeField(H, f)]));
    t.box = t.fieldMap.size ? h("div", { class: "form-grid analytics-options", hidden: true }, [...t.fieldMap.values()].map((f) => f.wrap)) : null;
    for (const f of t.fieldMap.values()) f.el.addEventListener("change", () => (f.spec.onChange?.(Object.fromEntries([...t.fieldMap].map(([k, x]) => [k, x.el]))), load()));
    t.values = () => Object.fromEntries([...t.fieldMap].map(([k, f]) => [k, f.el.value]));
    // A field that fills others (Templates: the strategy sets its offset and width) runs once at the start, so a tab
    // opened directly (a page tab of the dashboard) starts with its defaults, not empty fields.
    const els = Object.fromEntries([...t.fieldMap].map(([k, f]) => [k, f.el]));
    for (const f of t.fieldMap.values()) f.spec.onChange?.(els);
  }
  async function load() {
    const mine = ++seq;
    const t = active();
    const v = controls.values();
    out.replaceChildren(loadingNode());
    try {
      if (t.expiry && !v.expiry) {
        out.replaceChildren(emptyState("info", "No expiry to show", "This underlying has no upcoming expiry in the instrument list. Check the symbol (for example NIFTY) and try again."));
        return;
      }
      const nodes = await t.run({ v, o: t.values(), wb });
      if (mine === seq) out.replaceChildren(...[nodes].flat().filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  }
  const apply = () => {
    const t = active();
    controls.show({ underlying: t.underlying !== false, expiry: Boolean(t.expiry), strikes: Boolean(t.strikes) });
    for (const x of tabs) if (x.box) x.box.hidden = x !== t;
  };
  const controls = chainControls(H, { onChange: load, onError: (e) => out.replaceChildren(H.errorBox(e)) });
  if (seg)
    seg.addEventListener("change", () => {
      apply();
      load();
    });
  apply();
  /** Open a tab, optionally setting some of its fields first. */
  wb.goTo = (id, values = {}) => {
    const t = byId.get(id);
    for (const [k, v] of Object.entries(values)) if (t?.fieldMap.has(k)) t.fieldMap.get(k).el.value = String(v);
    if (seg && seg.value !== id) seg.value = id;
    else load();
  };
  wb.fieldEls = (id) => Object.fromEntries([...byId.get(id).fieldMap].map(([k, f]) => [k, f.el]));
  wb.node = h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body stack" }, seg ? H.segField(label, seg) : null, controls.node, ...tabs.map((t) => t.box))), out);
  if (await controls.init()) await load();
  return wb;
}

// ───────────────────────── Futures ─────────────────────────

function drawFutures(res) {
  const d = res.data?.data ?? {};
  const list = d.futures ?? [];
  const near = list[0];
  const cols = [
    { label: "Expiry", cell: (r) => h("strong", {}, r.expiry) },
    { label: "Price", num: true, cell: (r) => formatFixed(r.ltp, 2) },
    { label: "Basis", num: true, cell: (r) => signedSpan(r.basis) },
    { label: "Basis %", num: true, cell: (r) => signedSpan(r.basisPct, 3, "%") },
    { label: "Carry a year", num: true, cell: (r) => signedSpan(r.annualisedPct, 2, "%") },
    { label: "Against spot", cell: (r) => stateWord(r.state) },
    { label: "OI", num: true, cell: (r) => compact(r.oi) },
    { label: "Volume", num: true, cell: (r) => compact(r.volume) },
    { label: "Days left", num: true, cell: (r) => formatFixed(r.daysToExpiry, 1) },
  ];
  const carry = list.filter((r) => isFigure(r.annualisedPct)).map((r) => ({ label: r.expiry, bars: [{ value: Number(r.annualisedPct), cls: Number(r.annualisedPct) >= 0 ? "call" : "put", title: `${r.expiry}: ${formatSigned(r.annualisedPct, 2)}% a year (${formatSigned(r.basis, 2)} points)` }] }));
  const spreadCols = [
    { label: "Near", cell: (r) => h("strong", {}, r.near) },
    { label: "Far", cell: (r) => r.far },
    { label: "Spread", num: true, cell: (r) => signedSpan(r.spread) },
    { label: "Spread %", num: true, cell: (r) => signedSpan(r.spreadPct, 3, "%") },
    { label: "Days apart", num: true, cell: (r) => formatFixed(r.daysBetween, 0) },
    { label: "Carry a year", num: true, cell: (r) => signedSpan(r.annualisedPct, 2, "%") },
  ];
  return [
    statusRow(res.data?.meta?.freshness),
    partial(res.data?.errors),
    tiles(
      tile(`${d.underlying ?? ""} spot`, isFigure(d.spot) ? formatFixed(d.spot, 2) : DASH, d.spotSymbol ?? ""),
      tile("Near-month basis", isFigure(near?.basis) ? formatSigned(near.basis, 2) : DASH, near ? `${isFigure(near.basisPct) ? `${formatSigned(near.basisPct, 3)}%` : DASH} · ${stateWord(near.state)}` : ""),
      tile("Roll cost", isFigure(d.rollCostPct) ? `${formatSigned(d.rollCostPct, 3)}%` : DASH, isFigure(d.rollCostAnnualisedPct) ? `${formatSigned(d.rollCostAnnualisedPct, 2)}% a year, near to next` : "Needs two expiries with prices"),
      tile("Contracts", formatInt(list.length), "Upcoming expiries shown"),
    ),
    sectionCard("Futures", "Each upcoming future against spot. Basis is future minus spot; carry scales it to a year.", h("div", { class: "card-flush" }, table(cols, list, emptyState("list", "No futures", "The Bridge found no priced futures for this underlying."), { mobile: "scroll" }))),
    carry.length
      ? sectionCard("Carry by expiry", "Annualised premium of each future over spot. Blue bars are a premium, orange bars a discount.", legend([{ cls: "call", label: "Premium to spot" }, { cls: "put", label: "Discount to spot" }]), strikeBars(carry, { label: `Annualised carry by expiry for ${d.underlying}.`, layout: { labelW: 84, tickFormat: (v) => `${formatFixed(v, 1)}%` } }))
      : null,
    sectionCard("Calendar spreads", "The price gap between neighbouring expiries. The first one is the cost of rolling the near month forward.", h("div", { class: "card-flush" }, table(spreadCols, d.calendarSpreads ?? [], emptyState("list", "No spreads", "Calendar spreads need two expiries with prices."), { mobile: "scroll" }))),
  ];
}

function drawBasis(res) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  const series = d.series ?? [];
  if (!series.length) {
    return [statusRow(fr), partial(res.data?.errors, "Part of the history could not be read"), emptyState("chart", "No basis history", `The Bridge could not line up ${d.futureSymbol ?? "the future"} with ${d.spotSymbol ?? "spot"} candles for this interval. Try a longer interval such as 1d.`)];
  }
  const mode = timeMode(series.map((p) => p.time), d.interval);
  const b = d.basis ?? {};
  const bp = d.basisPct ?? {};
  const pts = series.map((p) => ({ label: barTimeLabel(p.time, mode), y: p.basis }));
  const rows = [...series].reverse();
  return [
    statusRow(fr),
    partial(res.data?.errors, "Part of the history could not be read"),
    tiles(
      tile("Latest basis", isFigure(b.latest) ? formatSigned(b.latest, 2) : DASH, isFigure(bp.latest) ? `${formatSigned(bp.latest, 3)}% of spot` : ""),
      tile("Average basis", isFigure(b.mean) ? formatFixed(b.mean, 2) : DASH, `Over ${formatInt(b.count)} candles`),
      tile("Range", isFigure(b.min) ? `${formatFixed(b.min, 1)} to ${formatFixed(b.max, 1)}` : DASH, "Lowest to highest basis"),
      tile("How unusual", isFigure(b.zScore) ? formatSigned(b.zScore, 2) : DASH, zWords(b.zScore)),
    ),
    sectionCard("Basis over time", `${d.futureSymbol ?? ""} minus ${d.spotSymbol ?? ""}, in points. The dashed line is the average.`, legend([{ cls: "s1", label: "Basis (points)" }]), seriesChart([{ id: "basis", label: "Basis", cls: "s1", points: pts }], { label: `Futures basis in points over ${series.length} candles for ${d.underlying} ${d.expiry}. Latest ${isFigure(b.latest) ? formatSigned(b.latest, 2) : "unknown"}.`, refs: isFigure(b.mean) ? [{ y: b.mean, label: "Average" }] : [] })),
    dataDisclosure("Show as a table", [{ label: "Time", cell: (r) => h("strong", {}, istDateTime(new Date(r.time * 1000).toISOString())) }, { label: "Future", num: true, cell: (r) => formatFixed(r.future, 2) }, { label: "Spot", num: true, cell: (r) => formatFixed(r.spot, 2) }, { label: "Basis", num: true, cell: (r) => formatSigned(r.basis, 2) }, { label: "Basis %", num: true, cell: (r) => formatSigned(r.basisPct, 3) }], rows.slice(0, 100)),
  ];
}

function drawSynthetic(res) {
  const d = res.data?.data ?? {};
  const list = d.strikes ?? [];
  const fr = res.data?.meta?.freshness;
  if (!list.length) return [statusRow(fr), emptyState("chart", "No strikes with both prices", "A synthetic future needs a call and a put price at the same strike.")];
  const ref = d.referenceSource === "future" ? "the futures price" : "spot";
  const cols = [
    { label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike), r.strike === d.atmStrike ? h("span", { class: "atm-flag" }, "ATM") : null) },
    { label: "Call", num: true, cell: (r) => formatFixed(r.ce, 2) },
    { label: "Put", num: true, cell: (r) => formatFixed(r.pe, 2) },
    { label: "Synthetic", num: true, cell: (r) => formatFixed(r.synthetic, 2) },
    { label: "Gap", num: true, cell: (r) => signedSpan(r.arbitrageGap) },
    { label: "Gap %", num: true, cell: (r) => signedSpan(r.arbitrageGapPct, 3, "%") },
    { label: "Reading", cell: (r) => directionWord(r.direction) },
  ];
  return [
    statusRow(fr),
    partial(res.data?.errors, "The futures price could not be read, so spot is the reference"),
    tiles(
      tile("Reference", isFigure(d.future) ? formatFixed(d.future, 2) : isFigure(d.spot) ? formatFixed(d.spot, 2) : DASH, `The ${ref}`),
      tile("ATM synthetic", isFigure(d.atmSynthetic) ? formatFixed(d.atmSynthetic, 2) : DASH, `Strike ${isFigure(d.atmStrike) ? formatInt(d.atmStrike) : DASH}`),
      tile("Widest gap at", isFigure(d.widestGapStrike) ? formatInt(d.widestGapStrike) : DASH, "Strike furthest from the reference"),
      tile("Spot", isFigure(d.spot) ? formatFixed(d.spot, 2) : DASH, d.underlying ?? ""),
    ),
    sectionCard("Synthetic future by strike", `Strike plus call minus put, against ${ref}. Blue bars mean the synthetic is dearer, orange cheaper.`, legend([{ cls: "call", label: "Synthetic dearer" }, { cls: "put", label: "Synthetic cheaper" }]), strikeBars(syntheticItems(list, d.atmStrike), { label: `Synthetic future gap by strike for ${d.underlying} ${d.expiry}.`, layout: { tickFormat: (x) => formatFixed(x, 1) } })),
    sectionCard("Strikes", "Gaps are in index points. Small gaps are normal; a large one is worth a second look before trusting either price.", h("div", { class: "card-flush" }, table(cols, [...list].sort((a, b) => a.strike - b.strike), emptyState("list", "No strikes", ""), { mobile: "scroll" }))),
  ];
}

async function renderFutures(H) {
  const wb = await workbench(H, {
    label: "View",
    tabs: [
      {
        id: "chain",
        label: "Futures",
        fields: [{ key: "expiries", label: "Expiries to show", type: "select", options: [["2", "Next 2"], ["3", "Next 3"], ["4", "Next 4"], ["6", "Next 6"]], value: "3" }],
        run: async ({ v, o }) => drawFutures(await api(`/v1/analytics/futures?${new URLSearchParams({ underlying: v.underlying, expiries: o.expiries })}`)),
      },
      {
        id: "basis",
        label: "Basis history",
        expiry: true,
        fields: [
          { key: "interval", label: "Candle", type: "select", options: [["1d", "Daily"], ["1h", "Hourly"], ["30m", "30 minutes"], ["15m", "15 minutes"], ["5m", "5 minutes"]], value: "1d" },
          { key: "countback", label: "How many candles", type: "select", options: [["30", "30"], ["60", "60"], ["120", "120"], ["250", "250"]], value: "30" },
        ],
        run: async ({ v, o }) => drawBasis(await api(`/v1/analytics/basis-history?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, interval: o.interval, countback: o.countback })}`)),
      },
      {
        id: "synthetic",
        label: "Synthetic",
        expiry: true,
        strikes: true,
        run: async ({ v }) => drawSynthetic(await api(`/v1/analytics/synthetic?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes) })}`)),
      },
    ],
  });
  return wb.node;
}

// ───────────────────────── Flows ─────────────────────────

/** The status line for the NSE-sourced flows: where it came from, when it was fetched, and whether it is stale. */
export function flowsFreshness(meta) {
  if (!meta) return { text: "Freshness unknown", tone: "warn" };
  const at = meta.fetchedAt ? istDateTime(meta.fetchedAt) : DASH;
  return { text: `NSE public data · fetched ${at} IST${meta.stale ? " · stale" : ""}`, tone: meta.stale ? "warn" : "info" };
}

function drawFlows(res) {
  const d = res.data?.data ?? {};
  const meta = res.data?.meta ?? {};
  const days = d.days ?? [];
  const f = flowsFreshness(meta);
  const status = h("div", { class: "row analytics-status" }, pill(f.text, f.tone), demoPill());
  if (!days.length) return [status, emptyState("wallet", "No FII or DII sessions yet", "NSE has not published a session this Bridge can read. Try again in a few minutes.")];
  const latest = days[0];
  const fs = streakText(d.streak?.fii);
  const ds = streakText(d.streak?.dii);
  const netTile = (who, v) => tile(`${who} net, ${dayLabel(latest.date)}`, formatSigned(v.net, 2), `Bought ${formatFixed(v.buy, 0)}, sold ${formatFixed(v.sell, 0)} (₹ crore)`, signedClass(v.net));
  const rows = rollingRows(d.rolling);
  const cols = [
    { label: "Period", cell: (r) => h("strong", {}, r.label) },
    { label: "FII net", num: true, cell: (r) => signedSpan(r.fiiNet) },
    { label: "DII net", num: true, cell: (r) => signedSpan(r.diiNet) },
    { label: "Sessions counted", num: true, cell: (r) => (r.partial ? `${r.days} of ${r.window}` : formatInt(r.days)) },
  ];
  const detail = [
    { label: "Date", cell: (r) => h("strong", {}, dayLabel(r.date)) },
    { label: "FII bought", num: true, cell: (r) => formatFixed(r.fii.buy, 2) },
    { label: "FII sold", num: true, cell: (r) => formatFixed(r.fii.sell, 2) },
    { label: "FII net", num: true, cell: (r) => signedSpan(r.fii.net) },
    { label: "DII bought", num: true, cell: (r) => formatFixed(r.dii.buy, 2) },
    { label: "DII sold", num: true, cell: (r) => formatFixed(r.dii.sell, 2) },
    { label: "DII net", num: true, cell: (r) => signedSpan(r.dii.net) },
  ];
  const short = isFigure(meta.available) && isFigure(meta.requested) && meta.available < meta.requested;
  return [
    status,
    short ? note("Only part of the history is held so far", `This Bridge holds ${meta.available} session${meta.available === 1 ? "" : "s"} of the ${meta.requested} you asked for. NSE publishes one session at a time, so the history builds up while the Bridge runs and starts empty after a restart.`) : null,
    tiles(netTile("FII", latest.fii), netTile("DII", latest.dii), tile("FII run", fs.value, fs.sub, fs.tone), tile("DII run", ds.value, ds.sub, ds.tone)),
    // Rows grow to use the window's height (a short list is not a band of empty plot), between 26 and 46 px.
    sectionCard("Net flow by session", "₹ crore, newest first. Right of zero is net buying.", legend([{ cls: "s1", label: "FII / FPI" }, { cls: "s2", label: "DII" }]), strikeBars(flowItems(days), { label: `FII and DII net flows over ${days.length} sessions. Latest FII ${formatSigned(latest.fii.net, 2)} crore, DII ${formatSigned(latest.dii.net, 2)} crore.`, layout: { group: true, rowH: flowRowH(days.length), labelW: 52, tickFormat: (v) => formatNumber(v, { maximumFractionDigits: 0 }) } })),
    sectionCard("Cumulative net", "₹ crore, added up from the oldest session shown.", legend([{ cls: "s1", label: "FII / FPI" }, { cls: "s2", label: "DII" }]), seriesChart(cumulativeFlows(days), { label: `Cumulative FII and DII net flows over ${days.length} sessions`, yDecimals: 0 })),
    sectionCard("Rolling sums", "Net flow over the latest sessions held.", h("div", { class: "card-flush" }, table(cols, rows, emptyState("list", "No sums", ""), { mobile: "stack" }))),
    sectionCard("Sessions", "Bought, sold and net by session, ₹ crore.", h("div", { class: "card-flush" }, table(detail, days, h("p", { class: "muted small" }, "No data."), { mobile: "scroll" }))),
  ];
}

/** Row height of the net-flow bars: the window's room shared by the sessions, 26 to 46 px (pure apart from the window). */
export function flowRowH(n, room = typeof innerHeight === "number" ? innerHeight - 380 : 400) {
  return Math.round(Math.max(26, Math.min(46, room / Math.max(1, n))));
}

/** Running FII and DII net, oldest session first, as two series for seriesChart (pure). */
export function cumulativeFlows(days) {
  const asc = [...(days ?? [])].reverse();
  let f = 0;
  let d = 0;
  const fii = [];
  const dii = [];
  for (const r of asc) {
    f += Number(r.fii?.net) || 0;
    d += Number(r.dii?.net) || 0;
    fii.push({ label: dayLabel(r.date), y: Math.round(f * 100) / 100 });
    dii.push({ label: dayLabel(r.date), y: Math.round(d * 100) / 100 });
  }
  return [
    { id: "fii", label: "FII", cls: "s1", points: fii },
    { id: "dii", label: "DII", cls: "s2", dash: "6 3", points: dii },
  ];
}

async function renderFlows(H) {
  const days = h("select", { id: nextId("an-days") }, [["5", "5 sessions"], ["10", "10 sessions"], ["20", "20 sessions"], ["30", "30 sessions"], ["60", "60 sessions"]].map(([v, t]) => h("option", { value: v }, t)));
  days.value = "10";
  const out = h("div", { class: "stack", "aria-live": "polite" });
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    out.replaceChildren(loadingNode());
    try {
      const res = await api(`/v1/analytics/fii-dii?days=${encodeURIComponent(days.value)}`);
      if (mine === seq) out.replaceChildren(...drawFlows(res).filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  };
  days.addEventListener("change", load);
  const refresh = h("button", { type: "button", class: "small", onclick: load }, icon("refresh"), "Refresh");
  await load();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "form-grid analytics-controls" }, H.field("Show the last", days), h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Refresh"), refresh)))), out);
}

// ───────────────────────── Expiry day ─────────────────────────

function drawExpiry(res) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  const st = d.straddle ?? {};
  const mp = d.maxPain ?? {};
  const walls = d.oiWalls ?? {};
  const g = d.gamma ?? {};
  const flags = d.flags ?? [];
  const wall = (list) => (list?.length ? list.map((x) => `${formatInt(x.strike)} (${compact(x.value)})`).join(", ") : DASH);
  const markers = [
    { id: "lbe", label: "Lower BE", value: st.lowerBreakeven, cls: "be" },
    { id: "ube", label: "Upper BE", value: st.upperBreakeven, cls: "be" },
    { id: "spot", label: "Spot", value: d.spot, cls: "spot" },
    { id: "pain", label: "Max pain", value: mp.strike, cls: "pain" },
    { id: "sup", label: "Support", value: walls.support?.[0]?.strike, cls: "put" },
    { id: "res", label: "Resistance", value: walls.resistance?.[0]?.strike, cls: "call" },
    { id: "flip", label: "Gamma flip", value: g.flipStrike, cls: "flip" },
  ];
  const band = isFigure(st.lowerBreakeven) && isFigure(st.upperBreakeven) ? { from: Number(st.lowerBreakeven), to: Number(st.upperBreakeven) } : null;
  const regimeWord = { positive: "Positive: dealers dampen moves", negative: "Negative: dealers amplify moves", neutral: "Neutral" }[g.regime] ?? DASH;
  const t = d.timeToExpiry ?? {};
  return [
    statusRow(fr, d.asOf ? h("span", { class: "muted small" }, `digest at ${istDateTime(d.asOf)} IST`) : null),
    tiles(
      tile("Time to expiry", countdownText(t.hours), `To 15:30 IST on ${d.expiry ?? DASH}${t.isExpiryDay ? " · expiry day" : ""}`, t.hours === 0 ? "down" : undefined),
      tile(`${d.underlying ?? ""} spot`, isFigure(d.spot) ? formatFixed(d.spot, 2) : DASH, "Underlying last price"),
      tile("Max pain", isFigure(mp.strike) ? formatInt(mp.strike) : DASH, isFigure(mp.spotDistance) ? `Spot is ${formatFixed(Math.abs(mp.spotDistance), 2)} points (${formatFixed(Math.abs(mp.spotDistancePct), 2)}%) ${mp.spotDistance > 0 ? "above" : mp.spotDistance < 0 ? "below" : "at"} it` : "Writers pay out least here"),
      tile("Gamma regime", g.regime ? g.regime[0].toUpperCase() + g.regime.slice(1) : DASH, regimeWord),
    ),
    sectionCard(
      flags.length ? `${flags.length} thing${flags.length === 1 ? "" : "s"} to look at` : "Flags",
      `Checked against your limits: spot ${formatFixed(d.thresholds?.maxPainPct, 2)}% from max pain, straddle down ${formatFixed(d.thresholds?.decayPct, 0)}% from its open.`,
      flags.length
        ? h("ul", { class: "flag-list" }, flags.map((f) => h("li", {}, pill((SEVERITY[f.severity] ?? SEVERITY.low).text, (SEVERITY[f.severity] ?? SEVERITY.low).tone), h("span", {}, f.message))))
        : h("p", { class: "muted" }, "Nothing unusual: spot is within your max pain limit, the straddle has not decayed past your limit and gamma is not negative."),
    ),
    sectionCard("Where spot sits", "The shaded band is the range the ATM straddle prices in (between its break-evens).", rulerChart(markers, { band, label: `Price ruler for ${d.underlying} ${d.expiry}: spot ${isFigure(d.spot) ? formatInt(d.spot) : "unknown"}, max pain ${isFigure(mp.strike) ? formatInt(mp.strike) : "unknown"}, straddle break-evens ${isFigure(st.lowerBreakeven) ? formatInt(st.lowerBreakeven) : "unknown"} to ${isFigure(st.upperBreakeven) ? formatInt(st.upperBreakeven) : "unknown"}.` })),
    h(
      "div",
      { class: "grid cols-2" },
      sectionCard(`ATM straddle at ${isFigure(st.strike) ? formatInt(st.strike) : DASH}`, "Buying the call and the put at the money.", kv([["Straddle price", money(st.price)], ["Call / put", `${isFigure(st.cePrice) ? formatFixed(st.cePrice, 2) : DASH} / ${isFigure(st.pePrice) ? formatFixed(st.pePrice, 2) : DASH}`], ["Implied move", isFigure(st.impliedMove) ? `${formatFixed(st.impliedMove, 2)} points (${formatFixed(st.impliedMovePct, 2)}%)` : DASH], ["Break-evens", isFigure(st.lowerBreakeven) ? `${formatFixed(st.lowerBreakeven, 2)} to ${formatFixed(st.upperBreakeven, 2)}` : DASH], ["Day-open price", money(st.dayOpenPrice)], ["Decayed since open", isFigure(st.decayedPct) ? `${formatFixed(st.decayedPct, 1)}%` : DASH, Number(st.decayedPct) >= Number(d.thresholds?.decayPct ?? 101) ? "down" : ""]])),
      sectionCard("OI walls and gamma", "Where the most open interest and gamma sit.", kv([["Resistance (call OI)", wall(walls.resistance)], ["Support (put OI)", wall(walls.support)], ["PCR (OI)", isFigure(walls.pcrOi) ? formatFixed(walls.pcrOi, 2) : DASH], ["Net gamma", compact(g.netGex)], ["Gamma flip", isFigure(g.flipStrike) ? formatInt(g.flipStrike) : DASH], ["Largest gamma", isFigure(g.largestStrike) ? formatInt(g.largestStrike) : DASH]])),
    ),
  ];
}

async function renderExpiry(H) {
  const wb = await workbench(H, {
    tabs: [
      {
        id: "digest",
        label: "Digest",
        expiry: true,
        strikes: true,
        fields: [
          { key: "maxPainPct", label: "Flag when spot is this far from max pain (%)", type: "number", value: "0.5", min: "0" },
          { key: "decayPct", label: "Flag when the straddle has lost this much (%)", type: "number", value: "50", min: "0", max: "100" },
        ],
        run: async ({ v, o }) => {
          const mp = readNumber(o.maxPainPct);
          const dc = readNumber(o.decayPct);
          if (mp === null || mp < 0) return H.errorBox({ title: "Check the limits", detail: "The max pain limit must be a number, 0 or more." });
          if (dc === null || dc < 0 || dc > 100) return H.errorBox({ title: "Check the limits", detail: "The straddle decay limit must be a number from 0 to 100." });
          return drawExpiry(await api(`/v1/analytics/expiry-day?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes), maxPainPct: String(mp), decayPct: String(dc) })}`));
        },
      },
    ],
  });
  return wb.node;
}

// ───────────────────────── OI change ─────────────────────────

const buildUpPill = (code) => {
  const i = buildUpInfo(code);
  return h("span", { title: i.hint }, pill(i.label, i.tone));
};
const buildUpKey = () => h("ul", { class: "chart-legend", "aria-label": "What the build-up words mean" }, Object.values(BUILD_UP).map((b) => h("li", {}, pill(b.label, b.tone), b.hint)));

function drawOiChange(res, o, v) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  if ((d.snapshots ?? 0) < 2 || !d.rows?.length) {
    return [
      statusRow(fr),
      emptyState("clock", "Not enough readings yet", `The Bridge compares chain readings taken a few minutes apart, and it has ${formatInt(d.snapshots ?? 0)} so far for ${d.underlying ?? v.underlying} ${d.expiry ?? v.expiry}. Each Refresh adds one; the history lives in memory and starts empty after a restart.`, h("button", { type: "button", class: "primary", onclick: (e) => e.currentTarget.closest(".stack")?.parentElement?.querySelector(".analytics-controls button")?.click() }, icon("refresh"), "Take another reading")),
    ];
  }
  const t = d.totals ?? {};
  const show = Number(o.rows) || 10;
  const cols = [
    { label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) },
    { label: "Side", cell: (r) => (r.side === "CE" ? "Call" : "Put") },
    { label: "OI now", num: true, cell: (r) => compact(r.oi) },
    { label: "OI change", num: true, cell: (r) => signedSpan(r.oiChange, 0) },
    { label: "Change %", num: true, cell: (r) => signedSpan(r.oiChangePct, 1, "%") },
    { label: "Price change", num: true, cell: (r) => signedSpan(r.priceChange) },
    { label: "Reading", cell: (r) => buildUpPill(r.buildUp) },
  ];
  return [
    statusRow(fr),
    h("p", { class: "muted small" }, windowNote(d)),
    tiles(tile("Call OI change", compact(t.ceOiChange), "Added (+) or removed (-) in the window", signedClass(t.ceOiChange)), tile("Put OI change", compact(t.peOiChange), "Added (+) or removed (-) in the window", signedClass(t.peOiChange)), tile("Put minus call", compact(t.netOiChange), "Positive leans bullish, negative bearish"), tile("Readings held", formatInt(d.snapshots), "Chain snapshots in memory")),
    sectionCard("OI change by strike", "Open interest added or removed since the earlier reading. Bars to the right are an increase.", legend([{ cls: "call", label: "Call (CE)" }, { cls: "put", label: "Put (PE)" }]), strikeBars(oiChangeItems(d.rows), { label: `Change in call and put open interest by strike for ${d.underlying} ${d.expiry}.`, layout: { group: true, rowH: 28, tickFormat: (x) => compact(x) } })),
    sectionCard(`Biggest ${Math.min(show, d.rows.length)} changes`, "Price and OI together say who is acting. Hover or tap a reading for its meaning.", buildUpKey(), h("div", { class: "card-flush" }, table(cols, d.rows.slice(0, show), emptyState("list", "No changes", ""), { mobile: "stack" }))),
  ];
}

function drawSpurts(res) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  if ((d.snapshots ?? 0) < 2) {
    return [statusRow(fr), emptyState("clock", "Not enough readings yet", `Spurts compare the newest OI jump with earlier ones, so the Bridge needs at least two readings of this chain. It has ${formatInt(d.snapshots ?? 0)}. Press Refresh again in a minute.`)];
  }
  const cols = [
    { label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) },
    { label: "Side", cell: (r) => (r.side === "CE" ? "Call" : "Put") },
    { label: "OI now", num: true, cell: (r) => compact(r.oi) },
    { label: "Jump", num: true, cell: (r) => signedSpan(r.oiChange, 0) },
    { label: "Jump %", num: true, cell: (r) => signedSpan(r.oiChangePct, 1, "%") },
    { label: "Times usual", num: true, cell: (r) => (isFigure(r.multiple) ? `${formatFixed(r.multiple, 1)}x` : "No baseline yet") },
    { label: "Reading", cell: (r) => buildUpPill(r.buildUp) },
  ];
  const list = d.spurts ?? [];
  return [
    statusRow(fr),
    h("p", { class: "muted small" }, windowNote({ from: d.from, to: d.to, windowCovered: true })),
    tiles(tile("Spurts found", formatInt(list.length), `Jumps of ${formatFixed(d.minChangePct, 0)}% or more`), tile("Readings held", formatInt(d.snapshots), "Chain snapshots in memory"), tile("Baseline intervals", formatInt(d.baselineIntervals), "Earlier jumps to compare with"), tile("Spot", isFigure(res.data?.data?.underlyingLtp) ? formatFixed(res.data.data.underlyingLtp, 2) : DASH, d.underlying ?? "")),
    sectionCard("OI spurts", "A spurt is a jump in open interest much bigger than that strike's recent jumps. 'Times usual' says how many times bigger.", buildUpKey(), h("div", { class: "card-flush" }, table(cols, list, emptyState("check", "No spurts", `No strike jumped by ${formatFixed(d.minChangePct, 0)}% or more in the latest interval. Lower the minimum jump to see smaller ones.`), { mobile: "stack" }))),
  ];
}

async function renderOiChange(H) {
  const wb = await workbench(H, {
    tabs: [
      {
        id: "change",
        label: "OI change",
        expiry: true,
        strikes: true,
        fields: [
          { key: "windowMin", label: "Compare with", type: "select", options: [["5", "5 minutes ago"], ["15", "15 minutes ago"], ["30", "30 minutes ago"], ["60", "1 hour ago"], ["120", "2 hours ago"]], value: "15" },
          { key: "rows", label: "Table rows", type: "select", options: [["10", "Top 10"], ["20", "Top 20"], ["40", "Top 40"]], value: "10" },
        ],
        run: async ({ v, o }) => drawOiChange(await api(`/v1/analytics/oi-change?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes), windowMin: o.windowMin })}`), o, v),
      },
      {
        id: "spurts",
        label: "Spurts",
        expiry: true,
        strikes: true,
        fields: [
          { key: "lookbackMin", label: "Baseline looks back", type: "select", options: [["15", "15 minutes"], ["30", "30 minutes"], ["60", "1 hour"], ["120", "2 hours"]], value: "60" },
          { key: "minChangePct", label: "Smallest jump (%)", type: "number", value: "5", min: "0" },
          { key: "top", label: "Rows", type: "select", options: [["10", "10"], ["20", "20"], ["40", "40"]], value: "10" },
        ],
        run: async ({ v, o }) => {
          const min = readNumber(o.minChangePct);
          if (min === null || min < 0) return H.errorBox({ title: "Check the number", detail: "The smallest jump must be a number, 0 or more." });
          return drawSpurts(await api(`/v1/analytics/oi-spurts?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes), lookbackMin: o.lookbackMin, minChangePct: String(min), top: o.top })}`));
        },
      },
    ],
  });
  return wb.node;
}

// ───────────────────────── Strategies ─────────────────────────

function legList(legs) {
  return h("ul", { class: "leg-list" }, legs.map((l) => h("li", {}, pill(l.side === "sell" ? "Sell" : "Buy", l.side === "sell" ? "warn" : "info"), h("span", {}, legPhrase(l).replace(/^(Buy|Sell) /, ""), h("span", { class: "muted" }, ` · ${formatInt(l.lots)} lot${l.lots === 1 ? "" : "s"} of ${formatInt(l.lotSize)}`)))));
}
/**
 * The part of a payoff curve worth drawing (pure): from a little below the lowest strike to a little above the highest
 * (the strikes' span, at least 3 % of spot, on each side), so an iron condor is not a spike in a 6,000-point plot.
 */
export function payoffWindow(curve, legs, spot) {
  const ks = (legs ?? []).map((l) => Number(l.strike)).filter((k) => k > 0);
  if (!ks.length || !(curve ?? []).length) return curve ?? [];
  const lo = Math.min(...ks);
  const hi = Math.max(...ks);
  const pad = Math.max(hi - lo, (Number(spot) > 0 ? Number(spot) : lo) * 0.03);
  const out = curve.filter((p) => p.price >= lo - pad && p.price <= hi + pad);
  return out.length >= 5 ? out : curve;
}

/**
 * Strategy legs as the Strategy Builder's basket legs (pure): { right, strike, side, lots, expiry }; a future leg is
 * left out (the builder adds futures itself). The one payoff page is the Strategy Builder.
 */
export function legsToBasket(legs, expiry) {
  return (legs ?? []).filter((l) => l.type === "CE" || l.type === "PE").map((l) => ({ right: l.type, strike: Number(l.strike), side: l.side === "sell" ? "SELL" : "BUY", lots: Math.max(1, Number(l.lots) || 1), expiry }));
}

/** Open legs in the Strategy Builder (the same handoff the Ctrl K trade line uses); nothing is sent. */
function openInPayoff(legs, underlying, expiry) {
  const basket = legsToBasket(legs, expiry);
  if (!basket.length) return toast("These legs have no option the Strategy Builder can take", { tone: "warn" });
  const go = intentHandoff({ kind: "structure", underlying }, { expiry, desk: {}, legs: basket, nowHash: location.hash });
  // The desk reads this slot once on its next draw (desk.js TRADE_HANDOFF_SLOT), as for a typed trade.
  app.local.set("mcb.dashboard.tradeHandoff", JSON.stringify({ underlying, expiry, baskets: go.prefs.baskets }));
  location.hash = go.hash;
}

/** The optimizer's views: range-bound templates are among the neutral ones (GET /v1/analytics/optimizer). */
export const OPT_VIEWS = [
  ["neutral", "Neutral or range-bound"],
  ["bullish", "Bullish"],
  ["bearish", "Bearish"],
  ["volatile", "Volatile, either way"],
];
export const OBJECTIVES = [
  ["expectedValue", "Expected value"],
  ["popAdjusted", "Value per rupee, times chance"],
  ["riskReward", "Reward for risk"],
];

/** The optimizer's query from the Finder's fields (pure). Returns { query } or { problems }. */
export function optimizerQuery(v, o) {
  const p = new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, view: o.view, objective: o.objective || "expectedValue", top: "6" });
  const problems = [];
  const opt = (key, text, name, { min, max }) => {
    if (!String(text ?? "").trim()) return;
    const n = readNumber(text);
    if (n === null || n <= min || n > max) problems.push(`${name} must be a number above ${min}${max < Infinity ? ` up to ${max}` : ""}, or empty.`);
    else p.set(key, String(n));
  };
  opt("maxLoss", o.maxLoss, "The largest loss", { min: 0, max: Infinity });
  opt("capital", o.capital, "Capital", { min: 0, max: Infinity });
  if (String(o.minPop ?? "").trim()) {
    const n = readNumber(o.minPop);
    if (n === null || n < 0 || n > 100) problems.push("The lowest chance of profit must be from 0 to 100, or empty.");
    else p.set("minPop", String(n));
  }
  return problems.length ? { problems } : { query: p.toString() };
}

function drawOptimize(res, wb) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  const results = d.results ?? [];
  const view = OPT_VIEWS.find(([id]) => id === d.view)?.[1].split(":")[0] ?? d.view;
  const rank = OBJECTIVES.find(([id]) => id === d.objective)?.[1] ?? d.objective;
  const head = [
    statusRow(fr),
    tiles(
      tile("Your view", view ?? DASH, `Ranked by ${String(rank).toLowerCase()}`),
      tile("Spot", isFigure(d.spot) ? formatFixed(d.spot, 2) : DASH, `${d.underlying ?? ""}, ATM ${isFigure(d.atmStrike) ? formatInt(d.atmStrike) : DASH}`),
      tile("At-the-money IV", isFigure(d.atmIv) ? `${formatFixed(d.atmIv, 2)}%` : DASH, d.atmIvSource === "straddle" ? "Worked out from the straddle price" : "From the chain"),
      tile("Searched", formatInt(d.evaluated ?? 0), `${formatInt(d.passed ?? 0)} passed your limits, ${formatFixed(d.daysToExpiry, 1)} days left`),
    ),
  ];
  if (!results.length) {
    return [...head, emptyState("scan", "Nothing fits", "No strike choice for this view passes the limits. Loosen the largest loss, the lowest chance or the capital, or try another expiry.")];
  }
  const figures = (r) => [
    ["Expected value", money(r.expectedValue), Number(r.expectedValue) >= 0 ? "up" : "down"],
    ["Chance of profit", isFigure(r.probabilityOfProfitPct) ? formatPercent(r.probabilityOfProfitPct, 1) : DASH, ""],
    ["Max profit", r.unboundedProfit ? "Unlimited" : money(r.maxProfit), "up"],
    ["Max loss", r.unboundedRisk ? "Unlimited" : money(r.maxLoss), "down"],
    [r.credit ? "Net credit" : "Net debit", isFigure(r.netPremium) ? formatRupee(Math.abs(r.netPremium)) : DASH, ""],
    ["Capital", money(r.capitalRequired), ""],
    ["Break-evens", r.breakevens?.length ? r.breakevens.map((b) => formatFixed(b, 2)).join(", ") : "None", ""],
    ["Reward for risk", r.unboundedRisk ? "Risk not capped" : isFigure(r.riskReward) ? `${formatFixed(r.riskReward, 2)} to 1` : DASH, ""],
  ];
  return [
    ...head,
    ...results.map((r) =>
      card({
        title: `${r.rank}. ${r.name}`,
        sub: `${formatInt(r.lots)} lot${r.lots === 1 ? "" : "s"}; capital is ${r.capitalBasis === "max loss" ? "the most it can lose" : "its loss on a 2.5 sigma move"}`,
        actions: pill(r.credit ? "Credit" : "Debit", r.credit ? "ok" : "info"),
        cls: "strategy",
        body: h("div", { class: "stack" }, kv(figures(r)), legList(r.legs), h("div", { class: "row" }, h("button", { type: "button", class: "small primary", onclick: () => openInPayoff(r.legs, d.underlying, d.expiry) }, icon("chart"), "Open in Strategy Builder"), h("button", { type: "button", class: "small", onclick: () => wb.goTo("build", { template: r.template, offset: r.params?.offset ?? "", width: r.params?.width ?? "", lots: r.lots ?? 1 }) }, "Fine-tune"))),
      }),
    ),
    h("p", { class: "muted small" }, "A screening model: the expiry price is lognormal around today's spot at the ATM IV, with no skew. Arithmetic on today's prices, not advice; nothing here places an order."),
  ];
}

function drawBuild(res, o) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  const curve = payoffWindow(d.curve ?? [], d.legs ?? [], d.spot);
  return [
    statusRow(fr),
    tiles(tile("Max profit", d.unboundedProfit ? "Unlimited" : money(d.maxProfit), "At expiry", d.unboundedProfit || Number(d.maxProfit) > 0 ? "up" : undefined), tile("Max loss", d.unboundedRisk ? "Unlimited" : money(d.maxLoss), d.lossAtZero ? "If the underlying fell to zero" : "At expiry", d.unboundedRisk || Number(d.maxLoss) < 0 ? "down" : undefined), tile(d.credit ? "Net credit" : "Net debit", isFigure(d.netPremium) ? money(Math.abs(d.netPremium)) : DASH, "Premium received minus paid"), tile("Chance of profit", isFigure(d.probabilityOfProfit) ? formatPercent(Number(d.probabilityOfProfit) * 100, 1) : DASH, isFigure(d.atmIv) ? `From ${formatFixed(d.atmIv, 1)}% IV, ${formatFixed(d.daysToExpiry, 1)} days` : "Needs an IV")),
    h(
      "div",
      { class: "grid cols-2" },
      sectionCard(d.name ?? "Strategy", `${d.underlying ?? ""} ${d.expiry ?? ""}, ${formatInt(o.lots)} lot${Number(o.lots) === 1 ? "" : "s"}. Strikes count from the at-the-money ${isFigure(d.atmStrike) ? formatInt(d.atmStrike) : ""}.`, legList(d.legs ?? []), kv(strategyFigures(d).slice(4)), h("div", { class: "row" }, h("button", { type: "button", class: "small primary", onclick: () => openInPayoff(d.legs ?? [], d.underlying, d.expiry) }, icon("chart"), "Open in Strategy Builder"))),
      sectionCard("Payoff at expiry", "Profit or loss in rupees against the underlying's price at expiry.", legend([{ cls: "profit", label: "Profit" }, { cls: "loss", label: "Loss" }]), curve.length ? payoffChart(curve, { breakevens: d.breakevens ?? [], spot: d.spot, label: `${d.name} payoff at expiry. Max profit ${d.unboundedProfit ? "unlimited" : money(d.maxProfit)}, max loss ${d.unboundedRisk ? "unlimited" : money(d.maxLoss)}.` }) : h("p", { class: "muted" }, "No curve to draw.")),
    ),
  ];
}

async function renderStrategies(H) {
  const list = (await api("/v1/analytics/strategies")).data?.data ?? {};
  const templates = list.templates ?? [];
  const byId = new Map(templates.map((t) => [t.id, t]));
  const first = templates.find((t) => t.id === "iron_condor") ?? templates[0];
  const sync = (els) => {
    const t = byId.get(els.template.value);
    if (!t) return;
    els.offset.disabled = !t.params.offset;
    els.width.disabled = !t.params.width;
    els.offset.value = t.params.offset ? String(t.defaults.offset) : "";
    els.width.value = t.params.width ? String(t.defaults.width) : "";
  };
  const wb = await workbench(H, {
    tabs: [
      {
        id: "find",
        label: "Find by view",
        expiry: true,
        strikes: false,
        // One finder: the optimizer searches every template's strikes and widths (GET /v1/analytics/optimizer); the
        // older ranking (GET /v1/analytics/strategies/find) stays as an API route.
        fields: [
          { key: "view", label: "My view", type: "select", options: OPT_VIEWS, value: "neutral" },
          { key: "objective", label: "Rank by", type: "select", options: OBJECTIVES, value: "expectedValue" },
          { key: "minPop", label: "Lowest chance of profit %", type: "number", placeholder: "Any", min: "0", max: "100" },
          { key: "maxLoss", label: "Largest loss (₹)", type: "number", placeholder: "No limit", min: "0" },
          { key: "capital", label: "Capital (₹)", type: "number", placeholder: "One lot", min: "0" },
        ],
        run: async ({ v, o, wb: w }) => {
          const r = optimizerQuery(v, o);
          if (r.problems) return H.errorBox({ title: "Check the numbers", detail: r.problems.join(" ") });
          return drawOptimize(await api(`/v1/analytics/optimizer?${r.query}`), w);
        },
      },
      {
        id: "build",
        label: "Build",
        expiry: true,
        strikes: false,
        fields: [
          { key: "template", label: "Strategy", type: "select", options: templates.map((t) => [t.id, t.name]), value: first?.id, onChange: sync, wide: true },
          { key: "offset", label: "Strikes from the money", type: "number", step: "1", min: "-20", max: "20", hint: "Negative is below the money." },
          { key: "width", label: "Strikes between legs", type: "number", step: "1", min: "1", max: "20" },
          { key: "lots", label: "Lots", type: "number", step: "1", min: "1", max: "1000", value: "1" },
        ],
        run: async ({ v, o }) => {
          const t = byId.get(o.template);
          const p = new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, template: o.template });
          const problems = [];
          const num = (text, name, min, max) => {
            const n = readNumber(text);
            if (n === null || !Number.isInteger(n) || n < min || n > max) problems.push(`${name} must be a whole number from ${min} to ${max}.`);
            return n;
          };
          if (t?.params.offset) p.set("offset", String(num(o.offset, "Strikes from the money", -20, 20)));
          if (t?.params.width) p.set("width", String(num(o.width, "Strikes between legs", 1, 20)));
          p.set("lots", String(num(o.lots, "Lots", 1, 1000)));
          if (problems.length) return H.errorBox({ title: "Check the numbers", detail: problems.join(" ") });
          return [t ? h("p", { class: "muted small" }, t.description) : null, ...drawBuild(await api(`/v1/analytics/strategies/build?${p}`), o)];
        },
      },
    ],
  });
  // The first template's defaults, filled in before the first Build.
  sync(wb.fieldEls("build"));
  return wb.node;
}

// ───────────────────────── Greeks grid and straddle ─────────────────────────

function drawGrid(res, H) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  const list = [...(d.strikes ?? [])].sort((a, b) => a.strike - b.strike);
  if (!list.length) return [statusRow(fr), emptyState("list", "No strikes", "The chain came back empty.")];
  const dp = GRID_DP;
  const cell = (side, g) => (r) => {
    const val = r[side]?.[g];
    return isFigure(val) ? formatFixed(val, dp[g]) : DASH;
  };
  const cols = [
    ...["delta", "gamma", "theta", "vega", "iv"].map((g) => ({ label: `Call ${g === "iv" ? "IV %" : g}`, num: true, cell: cell("ce", g) })),
    { label: "Strike", num: true, cell: (r) => h("strong", {}, formatInt(r.strike), r.strike === d.atmStrike ? h("span", { class: "atm-flag" }, "ATM") : null) },
    ...["iv", "vega", "theta", "gamma", "delta"].map((g) => ({ label: `Put ${g === "iv" ? "IV %" : g}`, num: true, cell: cell("pe", g) })),
  ];
  const tot = d.totals ?? {};
  const totRows = [
    { side: "Calls", ...tot.ce },
    { side: "Puts", ...tot.pe },
  ];
  const totCols = [
    { label: "Side", cell: (r) => h("strong", {}, r.side) },
    { label: "Delta", num: true, cell: (r) => formatFixed(r.delta, 3) },
    { label: "Gamma", num: true, cell: (r) => formatFixed(r.gamma, 5) },
    { label: "Theta", num: true, cell: (r) => formatFixed(r.theta, 2) },
    { label: "Vega", num: true, cell: (r) => formatFixed(r.vega, 2) },
    { label: "Average IV %", num: true, cell: (r) => formatFixed(r.avgIv, 2) },
  ];
  const seg = H.segmented("Chart shows", GRID_METRICS, "gamma");
  const chartBox = h("div", { class: "stack" });
  const draw = () => {
    const metric = seg.value;
    const name = GRID_METRICS.find(([k]) => k === metric)[1];
    chartBox.replaceChildren(legend([{ cls: "call", label: "Call (CE)" }, { cls: "put", label: "Put (PE)" }]), strikeBars(gridItems(list, metric), { label: `${name} by strike for calls and puts, ${d.underlying} ${d.expiry}.`, layout: { group: true, rowH: 26, tickFormat: (x) => formatNumber(x, { maximumFractionDigits: GRID_DP[metric] }) } }));
  };
  seg.addEventListener("change", draw);
  draw();
  const pk = (x) => (x ? `${formatInt(x.strike)}` : DASH);
  return [
    statusRow(fr),
    tiles(tile(`${d.underlying ?? ""} spot`, isFigure(d.underlyingLtp) ? formatFixed(d.underlyingLtp, 2) : DASH, `ATM strike ${isFigure(d.atmStrike) ? formatInt(d.atmStrike) : DASH}`), tile("Peak gamma", pk(d.peakGamma?.combined), "Where delta changes fastest"), tile("Peak vega", pk(d.peakVega?.combined), "Most sensitive to a change in IV"), tile("Average IV", `${formatFixed(tot.ce?.avgIv, 1)}% / ${formatFixed(tot.pe?.avgIv, 1)}%`, "Calls / puts")),
    sectionCard("Greeks by strike", "Pick a Greek to compare calls and puts across strikes.", H.segField("Greek", seg), chartBox),
    sectionCard("Totals across the strikes shown", "Greeks per unit, added up over the listed strikes.", h("div", { class: "card-flush" }, table(totCols, totRows, emptyState("list", "No totals", ""), { mobile: "stack" }))),
    sectionCard("Full grid", "Calls on the left, puts on the right. A dash means the data source did not send that Greek.", h("div", { class: "card-flush" }, table(cols, list, emptyState("list", "No strikes", ""), { mobile: "scroll" }))),
  ];
}

function drawStraddle(res) {
  const d = res.data?.data ?? {};
  const fr = res.data?.meta?.freshness;
  const hist = d.history ?? [];
  const strangle = Number(d.width) > 0;
  const what = strangle ? "Strangle" : "Straddle";
  const at = strangle ? `${formatInt(d.callStrike)} CE and ${formatInt(d.putStrike)} PE` : `at ${isFigure(d.atmStrike) ? formatInt(d.atmStrike) : DASH}`;
  const head = tiles(
    tile(`${what} price`, money(d.premium), `Call ${isFigure(d.ce) ? formatFixed(d.ce, 2) : DASH} + put ${isFigure(d.pe) ? formatFixed(d.pe, 2) : DASH} ${at}`),
    tile("Since the start of the history", isFigure(d.changePct) ? `${formatSigned(d.changePct, 2)}%` : DASH, isFigure(d.change) ? `${formatSigned(d.change, 2)} points` : "Needs history", signedClass(d.change)),
    tile("Implied move", isFigure(d.impliedMove) ? `${formatFixed(d.impliedMove, 2)}` : DASH, isFigure(d.impliedMovePct) ? `${formatFixed(d.impliedMovePct, 2)}% of spot, up or down` : ""),
    tile("Break-evens", isFigure(d.lowerBreakeven) ? `${formatFixed(d.lowerBreakeven, 0)} to ${formatFixed(d.upperBreakeven, 0)}` : DASH, "Expiry prices where a buyer breaks even"),
  );
  if (!hist.length) return [statusRow(fr), head, emptyState("chart", "No straddle history", "The Bridge could not line up call and put candles for the at-the-money strike. Try another interval.")];
  const mode = timeMode(hist.map((p) => p.time), d.interval);
  const pts = hist.map((p) => ({ label: barTimeLabel(p.time, mode), y: p.straddle }));
  return [
    statusRow(fr),
    head,
    sectionCard(`${what} price over time`, `${strangle ? `The ${formatInt(d.callStrike)} call plus the ${formatInt(d.putStrike)} put` : "The at-the-money call plus put"} at ${d.interval} candles. A falling line is time decay and shrinking IV; a rising one is the market pricing a bigger move.`, legend([{ cls: "s1", label: `${what} price` }]), seriesChart([{ id: "st", label: what, cls: "s1", points: pts }], { label: `${strangle ? `${formatInt(d.callStrike)} / ${formatInt(d.putStrike)} strangle` : "ATM straddle"} price over ${hist.length} candles for ${d.underlying} ${d.expiry}. Now ${money(d.premium)}, high ${isFigure(d.historyHigh) ? formatFixed(d.historyHigh, 2) : "unknown"}, low ${isFigure(d.historyLow) ? formatFixed(d.historyLow, 2) : "unknown"}.`, refs: isFigure(d.historyHigh) && isFigure(d.historyLow) ? [{ y: d.historyHigh, label: "High" }, { y: d.historyLow, label: "Low" }] : [] })),
    dataDisclosure("Show as a table", [{ label: "Time", cell: (r) => h("strong", {}, istDateTime(new Date(r.time * 1000).toISOString())) }, { label: "Call", num: true, cell: (r) => formatFixed(r.ce, 2) }, { label: "Put", num: true, cell: (r) => formatFixed(r.pe, 2) }, { label: "Straddle", num: true, cell: (r) => formatFixed(r.straddle, 2) }], [...hist].reverse().slice(0, 100)),
  ];
}

async function renderGreeksGrid(H) {
  const wb = await workbench(H, {
    tabs: [
      { id: "grid", label: "Greeks grid", expiry: true, strikes: true, run: async ({ v }) => drawGrid(await api(`/v1/analytics/greeks-grid?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, strikes: String(v.strikes) })}`), H) },
      {
        id: "straddle",
        label: "ATM straddle",
        expiry: true,
        fields: [
          { key: "width", label: "Pair", type: "select", options: [["0", "ATM straddle"], ["1", "Strangle ±1 strike"], ["2", "Strangle ±2 strikes"], ["3", "Strangle ±3 strikes"], ["5", "Strangle ±5 strikes"]], value: "0" },
          { key: "interval", label: "Candle", type: "select", options: [["1m", "1 minute"], ["5m", "5 minutes"], ["15m", "15 minutes"], ["30m", "30 minutes"], ["60m", "1 hour"]], value: "5m" },
          { key: "countback", label: "How many candles", type: "select", options: [["75", "75"], ["150", "150"], ["300", "300"]], value: "75" },
        ],
        run: async ({ v, o }) => drawStraddle(await api(`/v1/analytics/straddle?${new URLSearchParams({ underlying: v.underlying, expiry: v.expiry, interval: o.interval, countback: o.countback, width: o.width || "0", strikes: "15" })}`)),
      },
    ],
  });
  return wb.node;
}

// ───────────────────────── Alert rules ─────────────────────────

const localStatus = (text) => h("div", { class: "row analytics-status" }, pill(text, "info"), demoPill());

function ruleTable(H, rules, { onChecked, onDeleted, show }) {
  const cols = [
    { label: "Rule", wrap: true, cell: (r) => h("div", {}, h("strong", {}, r.name), h("div", { class: "muted small" }, describeRule(r))) },
    { label: "State", cell: (r) => pill(ruleState(r).text, ruleState(r).tone) },
    { label: "Last check", wrap: true, cell: (r) => (r.lastCheck ? `${istDateTime(r.lastCheck.at)}${isFigure(r.lastCheck.value) ? ` · ${formatNumber(r.lastCheck.value, { maximumFractionDigits: 4 })}` : typeof r.lastCheck.value === "string" ? ` · ${r.lastCheck.value}` : ""}` : DASH) },
    { label: "Fired", wrap: true, cell: (r) => (r.fireCount ? `${r.fireCount} time${r.fireCount === 1 ? "" : "s"}, last ${istDateTime(r.lastFiredAt)}` : "Never") },
    { label: "Checked", wrap: true, cell: (r) => ruleSchedule(r) },
    {
      label: "",
      cell: (r) =>
        h(
          "div",
          { class: "row nowrap" },
          h("button", { type: "button", class: "small", title: "Evaluate now without changing the rule or sending anything", onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
              const res = await api(`/v1/analytics/alert-rules/${encodeURIComponent(r.id)}/check?dryRun=true`, { method: "POST" });
              onChecked(r, res.data?.data);
            } catch (err) {
              show(H.errorBox(err));
            }
            b.disabled = false;
          } }, icon("play"), "Dry run"),
          h("button", { type: "button", class: "small", "aria-label": `Delete ${r.name}`, onclick: () => onDeleted(r) }, icon("close"), "Delete"),
        ),
    },
  ];
  return table(cols, rules, emptyState("warn", "No alert rules yet", "Build one below: pick what to watch and the level, and the Bridge tells you when it happens."), { mobile: "stack-wide" });
}

function confirmDelete(H, r, done) {
  const err = h("div", { "aria-live": "polite" });
  return modal({
    title: `Delete ${r.name}?`,
    body: h("div", { class: "stack" }, h("p", {}, describeRule(r)), h("p", { class: "muted small" }, "The rule stops being checked and its history is removed. You can build it again any time."), err),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Delete",
        cls: "primary",
        onClick: async () => {
          try {
            await api(`/v1/analytics/alert-rules/${encodeURIComponent(r.id)}`, { method: "DELETE" });
            return true;
          } catch (e) {
            err.replaceChildren(H.errorBox(e));
            return false;
          }
        },
      },
    ],
  }).then((ok) => ok && done());
}

async function renderAlerts(H) {
  const listBox = h("div", { class: "stack", "aria-live": "polite" });
  const resultBox = h("div", { class: "stack", "aria-live": "polite" });
  const loadRules = async () => {
    listBox.replaceChildren(loadingNode());
    try {
      const rules = (await api("/v1/analytics/alert-rules")).data?.data ?? [];
      listBox.replaceChildren(
        ruleTable(H, rules, {
          show: (node) => resultBox.replaceChildren(node),
          onChecked: (r, c) => {
            resultBox.replaceChildren(
              alertBox({ title: `${r.name}: ${c?.fired ? "would fire" : c?.status === "ok" ? "would not fire" : "no verdict"}`, detail: `${dryRunText(c)}${isFigure(c?.value) || typeof c?.value === "string" ? ` Current reading: ${typeof c.value === "string" ? c.value : formatNumber(c.value, { maximumFractionDigits: 4 })}.` : ""} This was a dry run: the rule's state was not changed and nothing was sent.` }, c?.fired ? "warn" : "info"),
            );
            toast("Dry run finished");
          },
          onDeleted: (r) => confirmDelete(H, r, () => (toast("Rule deleted"), resultBox.replaceChildren(), loadRules())),
        }),
      );
    } catch (err) {
      listBox.replaceChildren(H.errorBox(err));
    }
  };

  // The builder: a sentence the person completes, shown back in full before saving.
  const mk = (spec) => makeField(H, spec);
  const metricF = mk({ key: "metric", label: "Watch", type: "select", options: RULE_METRICS.map((m) => [m.id, m.label]), value: "pcr_oi" });
  const opF = mk({ key: "op", label: "When it", type: "select", options: [["above", "rises above"], ["below", "falls below"]], value: "above" });
  const valueF = mk({ key: "value", label: "Level", type: "number", placeholder: "1.2" });
  const toF = mk({ key: "to", label: "Only when it changes to", type: "select", options: [["", "Any regime"], ["positive", "Positive"], ["negative", "Negative"], ["neutral", "Neutral"]], value: "" });
  const nameF = mk({ key: "name", label: "Name (optional)", type: "text", placeholder: "Made from the sentence", hint: "Up to 80 characters." });
  const everyF = mk({ key: "every", label: "Check by itself", type: "select", options: [["", "No, only when I check"], ["5", "Every 5 minutes"], ["15", "Every 15 minutes"], ["30", "Every 30 minutes"], ["60", "Every hour"]], value: "" });
  const hoursEl = h("input", { type: "checkbox", id: nextId("an-mh") });
  hoursEl.checked = true;
  const hoursField = h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Market hours"), h("label", { class: "check", for: hoursEl.id }, hoursEl, "Only during market hours"));
  const preview = h("p", { class: "rule-sentence", role: "status" });
  const formOut = h("div", { class: "stack", "aria-live": "polite" });
  // A rule names its own target, so its underlying and expiry stay visible (they still follow the context bar).
  const controls = chainControls(H, { onChange: () => update(), onContext: () => update(), onError: (e) => formOut.replaceChildren(H.errorBox(e)), withStrikes: false, local: true });
  controls.node.querySelector("button")?.closest(".field")?.remove();
  const fields = () => ({ name: nameF.el.value, underlying: controls.values().underlying, expiry: controls.values().expiry, metric: metricF.el.value, op: opF.el.value, value: valueF.el.value, to: toF.el.value, every: everyF.el.value, marketHoursOnly: hoursEl.checked });
  const update = () => {
    const f = fields();
    const m = metricInfo(f.metric);
    controls.show({ underlying: true, expiry: m.kind !== "cross", strikes: false });
    valueF.wrap.hidden = m.kind === "regime";
    opF.wrap.hidden = m.kind === "regime";
    toF.wrap.hidden = m.kind !== "regime";
    const wanted = m.kind === "cross" ? [["either", "crosses either way"], ["above", "moves up through"], ["below", "moves down through"]] : [["above", "rises above"], ["below", "falls below"]];
    if ([...opF.el.options].map((o) => o.value).join() !== wanted.map((x) => x[0]).join()) {
      opF.el.replaceChildren(...wanted.map(([v, t]) => h("option", { value: v }, t)));
      opF.el.value = wanted[0][0];
    }
    valueF.el.placeholder = m.example;
    valueF.wrap.querySelector("span").textContent = m.unit ? `Level (${m.unit})` : "Level";
    const draft = { ...fields(), op: opF.el.value };
    preview.textContent = describeRule({ ...draft, value: readNumber(draft.value) ?? undefined });
  };
  for (const f of [metricF, opF, valueF, toF, nameF, everyF]) f.el.addEventListener(f.el.tagName === "INPUT" ? "input" : "change", update);
  const save = h("button", { type: "submit", class: "primary" }, icon("plus"), "Save rule");
  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const r = ruleBody(fields());
        if (!r.ok) return formOut.replaceChildren(H.errorBox({ title: "Check the rule", detail: r.errors.join(" ") }));
        save.disabled = true;
        formOut.replaceChildren(loadingNode());
        try {
          await api("/v1/analytics/alert-rules", { method: "POST", body: r.body });
          formOut.replaceChildren();
          nameF.el.value = "";
          toast("Rule saved");
          await loadRules();
        } catch (err) {
          formOut.replaceChildren(H.errorBox(err, { value: "Level", expiry: "Expiry", name: "Name", everyMinutes: "Check every" }));
        }
        save.disabled = false;
      },
    },
    h("div", { class: "form-grid" }, metricF.wrap, opF.wrap, valueF.wrap, toF.wrap),
    controls.node,
    h("div", { class: "form-grid" }, everyF.wrap, hoursField, nameF.wrap),
    h("div", { class: "preview" }, h("span", { class: "label" }, "The rule says"), preview),
    h("div", { class: "row" }, save),
    formOut,
  );
  await controls.init();
  update();
  await loadRules();
  return h(
    "div",
    { class: "stack" },
    localStatus("Saved on this Bridge · checked by this Bridge"),
    sectionCard("Your rules", "Each rule fires once when its condition turns true and re-arms when it clears. Delivery goes to the notify targets you set up. A rule only reads prices and sends a message; it never places an order.", resultBox, h("div", { class: "card-flush" }, listBox)),
    sectionCard("New rule", "Complete the sentence, check it reads right, and save.", form),
  );
}

// ───────────────────────── Positions ─────────────────────────

const sourceWord = (r) => (!r.greeksAvailable ? "No Greeks" : r.greeksSource === "computed" ? "Worked out" : "From the chain");

function drawPositionGreeks(res) {
  const d = res.data?.data ?? {};
  const meta = res.data?.meta ?? {};
  const fr = meta.freshness ?? meta.positionsFreshness;
  const rows = d.positions ?? [];
  const status = statusRow(fr, meta.accountId ? h("span", { class: "muted small" }, `Account ${meta.accountId}`) : null);
  if (!rows.length && !(d.skipped ?? []).length) return [status, partial(res.data?.errors, "Some chains could not be read"), emptyState("wallet", "No open positions", "This account holds no open positions. Place a paper order on the Orders page, then come back to see its Greeks.")];
  const n = d.net ?? {};
  const cols = [
    { label: "Position", wrap: true, cell: (r) => h("div", {}, h("strong", {}, r.symbol), h("div", { class: "muted small" }, `${r.netQty > 0 ? "Long" : "Short"} ${formatInt(Math.abs(r.netQty))}${r.product ? ` · ${r.product}` : ""}`)) },
    { label: "Price", num: true, cell: (r) => (isFigure(r.ltp) ? formatFixed(r.ltp, 2) : DASH) },
    { label: "IV %", num: true, cell: (r) => (isFigure(r.iv) ? formatFixed(r.iv, 2) : DASH) },
    { label: "Delta", num: true, cell: (r) => (r.greeksAvailable ? signedSpan(r.delta, 2) : DASH) },
    { label: "Gamma", num: true, cell: (r) => (r.greeksAvailable ? signedSpan(r.gamma, 4) : DASH) },
    { label: "Theta", num: true, cell: (r) => (r.greeksAvailable ? signedSpan(r.theta, 2) : DASH) },
    { label: "Vega", num: true, cell: (r) => (r.greeksAvailable ? signedSpan(r.vega, 2) : DASH) },
    { label: "Exposure", num: true, cell: (r) => (isFigure(r.deltaExposure) ? signedSpan(r.deltaExposure, 0) : DASH) },
    { label: "Greeks", cell: (r) => pill(sourceWord(r), r.greeksAvailable ? "" : "warn") },
  ];
  const ucols = [
    { label: "Underlying", cell: (r) => h("strong", {}, r.underlying) },
    { label: "Spot", num: true, cell: (r) => (isFigure(r.spot) ? formatFixed(r.spot, 2) : DASH) },
    { label: "Positions", num: true, cell: (r) => formatInt(r.positions) },
    { label: "Delta", num: true, cell: (r) => signedSpan(r.delta, 2) },
    { label: "Gamma", num: true, cell: (r) => signedSpan(r.gamma, 4) },
    { label: "Theta", num: true, cell: (r) => signedSpan(r.theta, 2) },
    { label: "Vega", num: true, cell: (r) => signedSpan(r.vega, 2) },
    { label: "Exposure", num: true, cell: (r) => signedSpan(r.deltaExposure, 0) },
  ];
  return [
    status,
    partial(res.data?.errors, "Some chains could not be read, so those positions have no Greeks"),
    tiles(tile("Net delta", formatSigned(n.delta, 2), `Exposure ${isFigure(n.deltaExposure) ? formatRupee(n.deltaExposure, 0) : DASH}`, signedClass(n.delta)), tile("Net gamma", formatSigned(n.gamma, 4), "Delta change per 1 point of spot"), tile("Net theta", formatSigned(n.theta, 2), "₹ per calendar day", signedClass(n.theta)), tile("Net vega", formatSigned(n.vega, 2), "₹ per 1 point of IV", signedClass(n.vega))),
    sectionCard("By underlying", "Greeks added up across the positions on each underlying. Exposure is delta times quantity times the underlying's price, in rupees.", h("div", { class: "card-flush" }, table(ucols, d.byUnderlying ?? [], emptyState("list", "Nothing to add up", "No option positions have Greeks."), { mobile: "stack" }))),
    sectionCard("Each position", "Shorts show negative delta and vega where they should. Greeks come from the chain, or are worked out from the price when the chain has none.", h("div", { class: "card-flush" }, table(cols, rows, emptyState("list", "No option positions", ""), { mobile: "scroll" }))),
    (d.skipped ?? []).length ? sectionCard("Left out", "These positions are not options, so they have no Greeks.", h("ul", { class: "flag-list" }, d.skipped.map((x) => h("li", {}, pill("Skipped", ""), h("span", {}, `${x.symbol}: ${x.reason}`))))) : null,
  ];
}

function drawLotSplit(res) {
  const d = res.data?.data ?? {};
  const cols = [
    { label: "Order", num: true, cell: (r) => formatInt(r.index + 1) },
    { label: "Lots", num: true, cell: (r) => formatInt(r.lots) },
    { label: "Quantity", num: true, cell: (r) => formatInt(r.quantity) },
  ];
  const ice = d.iceberg;
  if (ice) cols.push({ label: "Send after", num: true, cell: (r) => `${formatFixed((r.sendAfterMs ?? 0) / 1000, 1)} s` });
  const rows = (ice ? ice.schedule : d.children) ?? [];
  const shown = rows.slice(0, 100);
  return [
    calcStatus(),
    note("Plan only: nothing was sent", "Place each slice yourself on the Orders page or with POST /v1/orders, one order each, so every safety check still applies."),
    (d.warnings ?? []).length ? note("Check the freeze quantity", d.warnings.join(" "), "warn") : null,
    tiles(tile("Orders needed", formatInt(d.orderCount), d.needsSplit ? "Split to stay under the freeze limit" : "One order is enough"), tile("Most lots per order", formatInt(d.maxLotsPerOrder), `Freeze quantity ${formatInt(d.freezeQty)} units`), tile("Total", `${formatInt(d.totalLots)} lots`, `${formatInt(d.totalQuantity)} units of ${formatInt(d.lotSize)}`), tile(ice ? "Iceberg runs for" : "Freeze source", ice ? `${formatFixed(ice.totalDurationMs / 1000, 1)} s` : String(d.freezeQtySource ?? DASH), ice ? `${formatInt(ice.sliceLots)} lots a slice, ${formatInt(ice.delayMs)} ms apart` : d.symbol ?? "")),
    sectionCard("The slices", `${d.symbol ?? ""}. Each slice is a whole number of lots and no bigger than the freeze limit.`, h("div", { class: "card-flush" }, table(cols, shown, emptyState("list", "No slices", ""), { mobile: "stack" })), rows.length > shown.length ? h("p", { class: "muted small" }, `Showing the first ${shown.length} of ${rows.length} slices.`) : null),
  ];
}

async function renderPositions(H) {
  const seg = H.segmented("View", [["greeks", "Position Greeks"], ["split", "Lot split"]], "greeks");

  // Position Greeks
  const accounts = (await api("/v1/accounts")).data?.data ?? [];
  const acct = h("select", { id: nextId("an-acct") }, accounts.map((a) => h("option", { value: a.id }, `${a.label ?? a.id}${a.label && a.label !== a.id ? ` (${a.id})` : ""}`)));
  const modeEl = h("select", { id: nextId("an-pmode") }, [["", "Default"], ["paper", "Paper positions"], ["live", "Live positions"]].map(([v, t]) => h("option", { value: v }, t)));
  const gOut = h("div", { class: "stack", "aria-live": "polite" });
  let seq = 0;
  const loadG = async () => {
    if (!acct.value) return;
    const mine = ++seq;
    gOut.replaceChildren(loadingNode());
    try {
      const p = new URLSearchParams({ account: acct.value });
      if (modeEl.value) p.set("mode", modeEl.value);
      const res = await api(`/v1/analytics/position-greeks?${p}`);
      if (mine === seq) gOut.replaceChildren(...drawPositionGreeks(res).filter(Boolean));
    } catch (err) {
      if (mine === seq) gOut.replaceChildren(H.errorBox(err));
    }
  };
  acct.addEventListener("change", loadG);
  modeEl.addEventListener("change", loadG);
  const refresh = h("button", { type: "button", class: "small", onclick: loadG }, icon("refresh"), "Refresh");
  const greeksPane = accounts.length
    ? h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "form-grid analytics-controls" }, H.field("Account", acct), H.field("Positions", modeEl), h("div", { class: "field" }, h("span", { class: "pal-sr-only" }, "Refresh"), refresh)))), gOut)
    : emptyState("accounts", "No accounts yet", "Position Greeks read an account's open positions. Add a broker or the paper account first.", h("button", { type: "button", class: "primary", onclick: () => (location.hash = "#/accounts") }, "Open Accounts"));

  // Lot split
  const mkn = (label, props = {}) => {
    const el = h("input", { id: nextId("an-ls"), type: "number", inputmode: "decimal", step: "1", min: "0", ...props });
    return { el, wrap: H.field(label, el, props.hint) };
  };
  const symbol = h("input", { id: nextId("an-ls"), value: "", placeholder: "NFO:NIFTY-2026-11-24-FUT", spellcheck: "false", autocomplete: "off", autocapitalize: "characters" });
  const lots = mkn("Total lots", { min: "1", value: "100", placeholder: "100" });
  const lotSize = mkn("Lot size", { min: "1", value: "75", placeholder: "75" });
  const freeze = mkn("Freeze quantity (units)", { min: "1", placeholder: "Built-in table", hint: "Needed only for stock derivatives." });
  const iceEl = h("input", { type: "checkbox", id: nextId("an-ice") });
  const slice = mkn("Lots per slice", { min: "1", placeholder: "As many as allowed" });
  const delay = mkn("Delay between slices (ms)", { min: "0", max: "3600000", value: "500" });
  const iceBox = h("div", { class: "form-grid", hidden: true }, slice.wrap, delay.wrap);
  iceEl.addEventListener("change", () => (iceBox.hidden = !iceEl.checked));
  const units = h("p", { class: "hint", role: "status" });
  const qty = () => {
    const a = readNumber(lots.el.value);
    const b = readNumber(lotSize.el.value);
    units.textContent = a !== null && b !== null && a > 0 && b > 0 ? `That is ${formatInt(a * b)} units in total.` : "";
  };
  lots.el.addEventListener("input", qty);
  lotSize.el.addEventListener("input", qty);
  qty();
  const sOut = h("div", { class: "stack", "aria-live": "polite" });
  const splitForm = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const r = lotSplitBody({ symbol: symbol.value, lots: lots.el.value, lotSize: lotSize.el.value, freezeQty: freeze.el.value, iceberg: iceEl.checked, sliceLots: slice.el.value, delayMs: delay.el.value });
        if (!r.ok) return sOut.replaceChildren(H.errorBox({ title: "Check the numbers", detail: r.error }));
        sOut.replaceChildren(loadingNode());
        try {
          sOut.replaceChildren(...drawLotSplit(await api("/v1/analytics/lot-split", { method: "POST", body: r.body })).filter(Boolean));
        } catch (err) {
          sOut.replaceChildren(H.errorBox(err, { symbol: "Contract", quantity: "Quantity", lotSize: "Lot size", freezeQty: "Freeze quantity" }));
        }
      },
    },
    h("div", { class: "form-grid" }, H.field("Contract", symbol, "The Bridge's symbol, e.g. NFO:NIFTY-2026-11-24-FUT"), lots.wrap, lotSize.wrap, freeze.wrap),
    units,
    h("div", { class: "field" }, h("label", { class: "check", for: iceEl.id }, iceEl, "Space the slices out (iceberg)")),
    iceBox,
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary" }, icon("play"), "Plan the slices")),
  );
  const splitPane = h("div", { class: "stack" }, sectionCard("Lot split planner", "Exchanges cap the size of one order (the freeze quantity). Enter how many lots you want and this plans the slices. It only plans: nothing is sent.", splitForm), sOut);
  splitPane.hidden = true;

  seg.addEventListener("change", () => {
    greeksPane.hidden = seg.value !== "greeks";
    splitPane.hidden = seg.value !== "split";
  });
  if (accounts.length) await loadG();
  return h("div", { class: "stack" }, h("section", { class: "card" }, h("div", { class: "card-body" }, H.segField("View", seg))), greeksPane, splitPane);
}

// ───────────────────────── registry ─────────────────────────

/**
 * The remaining Analytics pages for views.js, appended after analyticsPages() in the same group.
 * `getHelpers()` returns { segmented, segField, field, errorBox }.
 */
export function analyticsMorePages(getHelpers) {
  const group = "Analytics";
  return [
    { id: "futures", label: "Futures", icon: "chart", tint: "pink", group, title: "Futures", sub: "Futures prices, basis and carry, basis history and synthetic futures", render: () => renderFutures(getHelpers()) },
    { id: "flows", label: "FII and DII", icon: "inbox", tint: "green", group, title: "FII and DII flows", sub: "Cash-market buying and selling by foreign and domestic institutions", render: () => renderFlows(getHelpers()) },
    { id: "expiry", label: "Expiry day", icon: "clock", tint: "red", group, title: "Expiry day", sub: "Time left, flags, the ATM straddle, max pain and OI walls in one view", render: () => renderExpiry(getHelpers()) },
    { id: "oichange", label: "OI change", icon: "activity", tint: "orange", group, title: "OI change and spurts", sub: "Where open interest is being added or removed, and who is acting", render: () => renderOiChange(getHelpers()) },
    { id: "strategies", label: "Strategies", icon: "scan", tint: "mint", group, title: "Strategies", sub: "Find strategies for your view, or build one from a template and see its payoff", render: () => renderStrategies(getHelpers()) },
    { id: "greeksgrid", label: "Greeks grid", icon: "bolt", tint: "indigo", group, title: "Greeks grid and straddle", sub: "Delta, gamma, theta and vega by strike, and the ATM straddle's price history", render: () => renderGreeksGrid(getHelpers()) },
    { id: "alerts", label: "Alert rules", icon: "warn", tint: "red", group, title: "Alert rules", sub: "Get told when PCR, IV, basis, max pain, gamma or spot reaches a level", render: () => renderAlerts(getHelpers()) },
    { id: "positions", label: "Positions", icon: "wallet", tint: "blue", group, title: "Positions", sub: "Greeks and exposure of your open option positions, and a lot-split planner", render: () => renderPositions(getHelpers()) },
  ];
}
