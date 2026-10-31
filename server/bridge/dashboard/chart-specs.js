// chart-specs.js: what each page's chart slot draws, as pure functions from the Bridge's own answers to a chart-lite
// spec (chart-lite-core.js buildModel). No DOM, no fetch, no clock: the pages fetch, these map, and
// chart-specs.test.mjs checks every mapping. Numbers become text only through format.js.
//
// Data sources (all existing endpoints; nothing here is invented or simulated):
//   chain sheet   GET /v1/history (the contract's 5-minute candles)
//   strategy      GET /v1/history (the underlying's daily candles) + the builder's strikes, breakevens, ±1σ / ±2σ
//   positions     GET /v1/history (the underlying's and each open leg's 5-minute candles today) + strikes, spot exits
//   OI            the OI page's snapshot store (the Bridge recorder, or this page's own minutes)
//   volatility    GET /v1/vol/history (basis=front: ATM IV of the front expiry, and HV20)
//   participants  GET /v1/participants/oi (the page's history model)
//   screener      GET /v1/history (daily candles) + GET /v1/vol/history (30-day ATM IV)
//   arbitrage     GET /v1/options/snapshots (the recorder's per-strike last prices: forward by parity, box rate)
import { DASH, formatCompactTick, formatFixed, formatInt, formatPercent, formatSignedRupee, isFigure } from "./format.js";

const IST_MS = 330 * 60_000;
const num = (v) => (isFigure(v) ? Number(v) : null);

/** The spot (index or stock) symbol of an underlying, as the Bridge names it: BSE for SENSEX and BANKEX, NSE otherwise. */
export const spotSymbol = (u) => `${u === "SENSEX" || u === "BANKEX" ? "BSE" : "NSE"}:${u}`;

/** Epoch ms of an IST calendar day ("2026-10-30"), at IST midnight; null when it is not a date. */
export function istDayMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST_MS : null;
}

/** /v1/history's answer (`data.candles`, epoch-second bar opens) as chart candles { t (ms), open, high, low, close, volume }. */
export function candlesOf(answer) {
  const list = answer?.data?.candles ?? answer?.candles ?? (Array.isArray(answer) ? answer : []);
  return list
    .map((c) => ({ t: Number(c?.time) * 1000, open: num(c?.open), high: num(c?.high), low: num(c?.low), close: num(c?.close), volume: num(c?.volume) ?? 0 }))
    .filter((c) => Number.isFinite(c.t) && c.open !== null && c.high !== null && c.low !== null && c.close !== null)
    .sort((a, b) => a.t - b.t);
}

/** The candles of the latest IST session in a list (today's, or the last one traded). */
export function lastSession(candles) {
  if (!candles.length) return [];
  const dayOf = (t) => Math.floor((t + IST_MS) / 86_400_000);
  const d = dayOf(candles[candles.length - 1].t);
  return candles.filter((c) => dayOf(c.t) === d);
}

/** A price as axis or tooltip text: two decimals under 1000, whole numbers above (index levels). */
export const priceText = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1000 ? formatFixed(v, 0) : formatFixed(v, 2));
const price2 = (v) => formatFixed(v, 2);

const empty = (title, text) => ({ empty: { title, text } });

// ── Chain sheet: the contract's candles ──

/** The contract's 5-minute candles and volume (the latest session and the one before it). */
export function contractSpec({ name, candles, daily = false }) {
  if (!candles?.length) return empty("No candles for this contract yet", "The broker has no history for it, or it has not traded yet.");
  return {
    label: `${name}: ${daily ? "daily" : "5-minute"} candles`,
    note: daily ? "Daily candles while indicators are on: studies read one candle per session." : "",
    // The axis takes its decimals from the tick step (chart-lite.js); the tooltip keeps the price's two.
    panes: [{ id: "price" }],
    series: [{ id: "c", type: "candles", label: name, data: candles, volume: true, format: price2 }],
  };
}

// ── Strategy: the underlying with the strikes, breakevens and the ±σ bands ──

/**
 * Daily candles of the underlying, the strategy's strikes and breakevens as levels and the expected move at the
 * horizon as bands (±1σ, ±2σ fainter). `band1` / `band2` are [lo, hi] from options.js payoffModel.
 */
export function strategySpec({ underlying, candles, strikes = [], breakevens = [], band1 = null, band2 = null }) {
  if (!candles?.length) return empty(`No price history for ${underlying}`, "The broker returned no daily candles.");
  const series = [{ id: "c", type: "candles", label: underlying, data: candles, format: priceText }];
  if (Array.isArray(band2) && band2.every(isFigure)) series.push({ id: "b2", type: "band", lo: band2[0], hi: band2[1], tone: "iv", strength: 2, label: "±2σ", legend: false });
  if (Array.isArray(band1) && band1.every(isFigure)) series.push({ id: "b1", type: "band", lo: band1[0], hi: band1[1], tone: "iv", label: "±1σ", legend: false });
  for (const k of [...new Set(strikes.filter(isFigure).map(Number))].sort((a, b) => a - b)) series.push({ id: `k${k}`, type: "level", value: k, label: `Strike ${formatInt(k)}`, tone: "muted" });
  breakevens.filter(isFigure).forEach((b, i) => series.push({ id: `be${i}`, type: "level", value: Number(b), label: `BE ${formatInt(b)}`, tone: "warn", dash: false }));
  return {
    label: `${underlying}: daily candles with the strategy's strikes, breakevens and ±σ`,
    panes: [{ id: "price", format: priceText }],
    series,
    note: band1 ? "Bands: the expected move to the payoff's horizon at the current ATM IV (lognormal)." : "",
  };
}

// ── Positions: spot through the day, the strikes, the book's P&L ──

/**
 * The book's mark-to-market P&L through the day: Σ qty × (close − average) over the open legs, each leg carried
 * forward from its last 5-minute close. A time counts only once every leg has a price (no partial books).
 * @param {Array<{ qty: number, avg: number, candles: Array<{ t: number, close: number }> }>} legs
 */
export function bookPnlSeries(legs) {
  const usable = (legs ?? []).filter((l) => isFigure(l.qty) && isFigure(l.avg) && l.candles?.length);
  if (!usable.length || usable.length !== (legs ?? []).length) return [];
  const times = [...new Set(usable.flatMap((l) => l.candles.map((c) => c.t)))].sort((a, b) => a - b);
  const at = usable.map(() => 0);
  const lastClose = usable.map(() => null);
  const out = [];
  for (const t of times) {
    let total = 0;
    let ok = true;
    usable.forEach((l, k) => {
      while (at[k] < l.candles.length && l.candles[at[k]].t <= t) lastClose[k] = l.candles[at[k]++].close;
      if (lastClose[k] === null) ok = false;
      else total += Number(l.qty) * (lastClose[k] - Number(l.avg));
    });
    if (ok) out.push({ t, v: Math.round(total * 100) / 100 });
  }
  return out;
}

/**
 * Spot through the day (a line) with the book's strikes and any exits set on the underlying itself as levels, and the
 * book's P&L as a signed area in a second pane. `exits`: [{ role: "stop"|"target", trigger }] on the spot symbol.
 */
export function positionsSpec({ underlying, spot, legs = [], strikes = [], exits = [], pnlNote = "" }) {
  if (!spot?.length) return empty(`No intraday prices for ${underlying} yet`, "Spot through the day appears once the session has 5-minute candles.");
  const series = [{ id: "spot", type: "line", label: `${underlying} spot`, tone: "spot", pane: "price", data: spot.map((c) => ({ t: c.t, v: c.close })), format: priceText }];
  for (const k of [...new Set(strikes.filter(isFigure).map(Number))].sort((a, b) => a - b)) series.push({ id: `k${k}`, type: "level", pane: "price", value: k, label: `Strike ${formatInt(k)}`, tone: "muted", fit: false });
  exits.filter((e) => isFigure(e?.trigger)).forEach((e, i) => series.push({ id: `x${i}`, type: "level", pane: "price", value: Number(e.trigger), label: `${e.role === "target" ? "Target" : "Stop"} ${priceText(e.trigger)}`, tone: e.role === "target" ? "pos" : "neg", dash: false }));
  const pnl = bookPnlSeries(legs);
  const panes = [{ id: "price", weight: 3, format: priceText }];
  if (pnl.length) {
    panes.push({ id: "pnl", weight: 1.6, label: "Book P&L", format: (v) => formatSignedRupee(v, 0), include: [0] });
    series.push({ id: "pnl", type: "area", pane: "pnl", label: "Book P&L", signed: true, baseline: 0, data: pnl, tone: "pos", format: (v) => formatSignedRupee(v, 0) });
  }
  return {
    label: `${underlying} spot through the day with your strikes${pnl.length ? ", and the book's P&L" : ""}`,
    panes,
    series,
    note: pnl.length ? "Book P&L: open legs marked at each 5-minute close against their average price; charges not included." : pnlNote,
  };
}

// ── OI: call OI, put OI, PCR, max pain and spot over the session ──

/** From options.js oiSeries points { t, spot, ceOi, peOi, pcr, maxPain }: three panes (price, OI in lots, PCR). */
export function oiSpec(points, { underlying = "" } = {}) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p?.t));
  if (pts.length < 2) return empty("Not enough snapshots yet", "The chart fills in as minutes are recorded: keep this page open, or turn on the Bridge recorder for this chain.");
  const line = (key) => pts.map((p) => ({ t: p.t, v: num(p[key]) }));
  return {
    label: `${underlying} call OI, put OI, PCR, max pain and spot over time`.trim(),
    kind: "intraday",
    panes: [
      { id: "price", weight: 1.3, label: "Spot and max pain", format: priceText },
      { id: "oi", weight: 1.2, label: "OI (lots)", format: formatCompactTick },
      { id: "pcr", weight: 0.8, label: "PCR", format: (v) => formatFixed(v, 2) },
    ],
    series: [
      { id: "spot", type: "line", pane: "price", label: "Spot", tone: "spot", data: line("spot"), format: price2 },
      { id: "mp", type: "line", pane: "price", label: "Max pain", tone: "warn", dash: true, data: line("maxPain"), format: (v) => formatInt(v) },
      { id: "ce", type: "line", pane: "oi", label: "Call OI", tone: "call", data: line("ceOi"), format: formatCompactTick },
      { id: "pe", type: "line", pane: "oi", label: "Put OI", tone: "put", data: line("peOi"), format: formatCompactTick },
      { id: "pcr", type: "line", pane: "pcr", label: "PCR", tone: "iv", data: line("pcr"), format: (v) => formatFixed(v, 2) },
      { id: "pcr1", type: "level", pane: "pcr", value: 1, tone: "muted" },
    ],
  };
}

// ── Volatility: ATM IV of the front expiry against HV20 ──

/** GET /v1/vol/history (series iv, hv20) as two lines by day. An unavailable answer says why. */
export function volSpec(history, { underlying = "" } = {}) {
  if (history && history.available === false) {
    const why = { NOT_TRACKED: `The Bridge does not track ${underlying}'s daily vol.`, COLLECTING: "The daily vol store is still collecting its first days.", NOT_LISTED_IN_DEMO: `${underlying} is not in the demo's vol store.` }[history.reason] ?? "The daily vol store has no days for it yet.";
    return empty("No IV history yet", why);
  }
  const items = (history?.items ?? []).filter((i) => istDayMs(i?.date) !== null);
  const iv = items.map((i) => ({ t: istDayMs(i.date), v: num(i.iv) }));
  const hv = items.map((i) => ({ t: istDayMs(i.date), v: num(i.hv20) }));
  if (iv.filter((p) => p.v !== null).length + hv.filter((p) => p.v !== null).length < 2) return empty("No IV history yet", "The daily vol store records one row a day after the close.");
  const pct = (v) => formatPercent(v, 1);
  // A dotted rule where the front expiry rolled, while that is rare enough to read (monthly series); a weekly
  // series rolls every week, and that many rules would hide the lines.
  const rollDays = items.filter((i) => i.roll);
  const rolls = rollDays.length <= 8 ? rollDays.map((i, k) => ({ id: `roll${k}`, type: "marker", t: istDayMs(i.date), tone: "muted" })) : [];
  return {
    label: `${underlying} ATM IV of the front expiry and 20-day realised vol, by day`.trim(),
    kind: "daily",
    panes: [{ id: "vol", format: (v) => formatPercent(v, 0) }],
    series: [
      { id: "iv", type: "line", label: "ATM IV (front)", tone: "iv", data: iv, format: pct },
      { id: "hv20", type: "line", label: "HV20", tone: "hv", dash: true, data: hv, format: pct },
      ...rolls,
    ],
    note: rolls.length ? "Dotted rules: the front expiry rolled to the next one." : rollDays.length ? `The front expiry rolled ${formatInt(rollDays.length)} times in this range (weekly expiries).` : "",
  };
}

// ── Participants: FII long % and the nets ──

/** The page's historyModel (participants.js) as two panes: FII long % with 50 %, and the three nets with zero. */
export function participantsSpec(model) {
  if (!model?.dates?.length) return empty("No history yet", "Older days fill in from the NSE archive outside market hours.");
  const s = Object.fromEntries((model.series ?? []).map((x) => [x.key, x]));
  const pts = (key) => (s[key]?.points ?? []).map((p) => ({ t: istDayMs(p.date), v: num(p.value) }));
  const count = (v) => formatCompactTick(v);
  return {
    label: `Participant OI by day, ${model.from} to ${model.to}`,
    kind: "daily",
    panes: [
      { id: "pct", weight: 1, label: "FII index futures long %", format: (v) => formatPercent(v, 0), include: [50] },
      { id: "net", weight: 1.3, label: "Nets (contracts)", format: count, include: [0] },
    ],
    series: [
      { id: "fiiLongPct", type: "line", pane: "pct", label: "FII index futures long %", tone: "spot", data: pts("fiiLongPct"), format: (v) => formatPercent(v, 1) },
      { id: "half", type: "level", pane: "pct", value: 50, tone: "muted" },
      { id: "fiiNet", type: "line", pane: "net", label: "FII index futures net", tone: "spot", data: pts("fiiNet"), format: count },
      { id: "clientCallNet", type: "line", pane: "net", label: "Client index calls net", tone: "call", data: pts("clientCallNet"), format: count },
      { id: "clientPutNet", type: "line", pane: "net", label: "Client index puts net", tone: "put", data: pts("clientPutNet"), format: count },
      { id: "zero", type: "level", pane: "net", value: 0, tone: "muted" },
      ...(model.revisions ?? []).map((r, k) => ({ id: `rev${k}`, type: "marker", t: istDayMs(r.date), tone: "warn" })),
    ],
  };
}

// ── Screener: price and IV ──

/** Daily candles of the underlying and its 30-day ATM IV (the vol store's cm30 basis) by day. */
export function screenerSpec({ underlying, candles, ivHistory }) {
  if (!candles?.length) return empty(`No price history for ${underlying}`, "The broker returned no daily candles.");
  const items = ivHistory?.available === false ? [] : (ivHistory?.items ?? []);
  const iv = items.filter((i) => istDayMs(i?.date) !== null).map((i) => ({ t: istDayMs(i.date), v: num(i.iv) }));
  const hasIv = iv.filter((p) => p.v !== null).length >= 2;
  const series = [{ id: "c", type: "candles", pane: "price", label: underlying, data: candles, format: priceText }];
  const panes = [{ id: "price", weight: 2, format: priceText }];
  if (hasIv) {
    panes.push({ id: "iv", weight: 1, label: "ATM IV 30-day", format: (v) => formatPercent(v, 0) });
    series.push({ id: "iv", type: "line", pane: "iv", label: "ATM IV 30-day", tone: "iv", data: iv, format: (v) => formatPercent(v, 1) });
  }
  return { label: `${underlying}: daily candles${hasIv ? " and 30-day ATM IV" : ""}`, panes, series, note: hasIv ? "" : "No IV history for this underlying in the daily vol store yet." };
}

// ── Arbitrage: implied forward and box rate through the day ──

/** Close of an expiry day (15:30 IST) in epoch ms. */
const expiryCloseMs = (expiry) => {
  const d = istDayMs(expiry);
  return d === null ? null : d + (15 * 60 + 30) * 60_000;
};

/**
 * From one recorded snapshot { t, spot, k, cl, pl } (oi-store.js fromServerSnapshot): the implied forward (median of
 * K + C − P over the five strikes nearest spot with both last prices) and the box rate of the strikes either side of
 * spot (annualised % from (K2 − K1) ÷ box − 1 over the days left). Last prices, so a guide, not a fill.
 */
export function parityPoint(snap, expiry) {
  const spot = num(snap?.spot);
  const k = snap?.k ?? [];
  const both = k.map((K, i) => ({ K: Number(K), c: num(snap.cl?.[i]), p: num(snap.pl?.[i]) })).filter((r) => Number.isFinite(r.K) && r.c !== null && r.p !== null && r.c > 0 && r.p > 0);
  if (spot === null || both.length < 2) return null;
  const near = [...both].sort((a, b) => Math.abs(a.K - spot) - Math.abs(b.K - spot)).slice(0, 5);
  const f = near.map((r) => r.K + r.c - r.p).sort((a, b) => a - b);
  const forward = f.length % 2 ? f[(f.length - 1) / 2] : (f[f.length / 2 - 1] + f[f.length / 2]) / 2;
  const lo = [...both].filter((r) => r.K <= spot).sort((a, b) => b.K - a.K)[0];
  const hi = [...both].filter((r) => r.K > spot).sort((a, b) => a.K - b.K)[0];
  let rate = null;
  const close = expiryCloseMs(expiry);
  if (lo && hi && close !== null) {
    const box = lo.c - lo.p - (hi.c - hi.p);
    const days = (close - snap.t) / 86_400_000;
    if (box > 0 && days > 0.5) rate = (((hi.K - lo.K) / box - 1) * 365 * 100) / days;
  }
  return { t: snap.t, spot, forward: Math.round(forward * 100) / 100, rate: rate === null || Math.abs(rate) > 200 ? null : Math.round(rate * 100) / 100 };
}

/** Implied forward against spot, and the box rate, over the recorded minutes of one chain. */
export function arbSpec(snaps, { underlying = "", expiry = "", hurdle = null } = {}) {
  const pts = (snaps ?? []).map((s) => parityPoint(s, expiry)).filter(Boolean).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return empty("No recorded minutes for this chain yet", "This chart reads the Bridge recorder's per-strike prices. Turn the recorder on for this chain (Data recorder) and the minutes fill in during the session.");
  const series = [
    { id: "spot", type: "line", pane: "fwd", label: "Spot", tone: "spot", data: pts.map((p) => ({ t: p.t, v: p.spot })), format: price2 },
    { id: "fwd", type: "line", pane: "fwd", label: "Implied forward", tone: "call", data: pts.map((p) => ({ t: p.t, v: p.forward })), format: price2 },
    { id: "rate", type: "line", pane: "rate", label: "Box rate", tone: "iv", data: pts.map((p) => ({ t: p.t, v: p.rate })), format: (v) => formatPercent(v, 2) },
  ];
  if (isFigure(hurdle)) series.push({ id: "hurdle", type: "level", pane: "rate", value: Number(hurdle), label: `Hurdle ${formatPercent(hurdle, 1)}`, tone: "muted" });
  return {
    label: `${underlying} implied forward and box rate over the session`.trim(),
    kind: "intraday",
    panes: [
      { id: "fwd", weight: 1.4, label: "Spot and implied forward", format: priceText },
      { id: "rate", weight: 1, label: "Box rate, annualised", format: (v) => formatPercent(v, 1) },
    ],
    series,
    note: "From the recorder's last prices (parity over the five strikes nearest spot; the box of the strikes either side of spot), not bid and ask.",
  };
}

// ── Indicators (studies from the ChartistScript core: GET /v1/studies, POST /v1/studies/compute) ──

/** At most this many indicators on one chart. */
export const MAX_STUDIES = 4;
/** Series colours for studies, in order: data-viz tokens only (the core's own `color` is not used). */
export const STUDY_TONES = Object.freeze(["call", "put", "iv", "warn", "today", "hv"]);

/** The indicator ids a browser remembers (stored JSON), cleaned: known shape, no repeats, at most MAX_STUDIES. */
export function studyList(raw) {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = [];
    }
  }
  return [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && /^[a-z0-9_]{1,32}$/.test(x)))].slice(0, MAX_STUDIES);
}

/** The compute request for a chart's candles: daily (or coarser) only, as many bars as the chart shows. */
export function studyRequest({ symbol, interval = "1d", bars = 120, ids = [] }) {
  return { symbol, interval, countback: Math.max(1, Math.min(2000, Math.round(bars) || 120)), studies: studyList(ids).map((id) => ({ id })) };
}

/** The study's own name for a pane ("macd(12, 26, 9)" from "macd(12, 26, 9) macd"). */
const studyName = (x) => String(x.label ?? x.study ?? "").replace(new RegExp(` ${String(x.field ?? "").replace(/[^a-z0-9_]/gi, "")}$`), "") || String(x.study ?? "");

/**
 * Lay a compute answer over a candle spec: series on pane "price" join the candles' pane, each "panel" study gets a
 * pane of its own (a "hist" output becomes bars, "area" an area, "line" and "step" a line, a `level` a reference
 * line), fills become a band between their two series, markers become markers. Study times are matched to the
 * candles by IST day, so a study point always sits on its candle. "background" outputs are not drawn.
 */
export function withStudies(spec, result) {
  const base = spec?.series?.find((s) => s.type === "candles");
  if (!base || !result?.time?.length) return spec;
  const pricePane = base.pane ?? spec.panes?.[0]?.id ?? "price";
  const dayOf = (ms) => Math.floor((ms + IST_MS) / 86_400_000);
  const byDay = new Map(base.data.map((c) => [dayOf(c.t), c.t]));
  const ts = result.time.map((sec) => byDay.get(dayOf(Number(sec) * 1000)) ?? null);
  const order = new Map((result.studies ?? []).map((s, k) => [s.key, k]));
  const fieldNo = new Map();
  const paneOf = new Map();
  const values = new Map();
  const series = [];
  const panes = [];
  for (const x of result.series ?? []) {
    if (!x?.key || !Array.isArray(x.values) || x.style === "background") continue;
    const n = fieldNo.get(x.study) ?? 0;
    fieldNo.set(x.study, n + 1);
    const tone = STUDY_TONES[((order.get(x.study) ?? 0) + n) % STUDY_TONES.length];
    const data = x.values.map((v, i) => ({ t: ts[i], v: num(v) })).filter((p) => p.t !== null);
    values.set(x.key, data);
    let pane = pricePane;
    if (x.pane !== "price") {
      pane = `study:${x.study}`;
      if (!panes.some((p) => p.id === pane)) panes.push({ id: pane, weight: 0.75, label: studyName(x) });
    }
    paneOf.set(x.key, pane);
    const type = x.pane !== "price" && x.style === "hist" ? "bars" : x.pane !== "price" && x.style === "area" ? "area" : "line";
    series.push({ id: `st:${x.key}`, type, pane, label: x.label ?? x.key, tone, data, signed: type === "bars", weight: "thin", study: x.study });
    if (isFigure(x.level)) series.push({ id: `st:${x.key}:level`, type: "level", pane, value: Number(x.level), tone: "muted" });
  }
  for (const f of result.fills ?? []) {
    const [a, b] = f?.between ?? [];
    if (!values.has(a) || !values.has(b)) continue;
    const vb = new Map(values.get(b).map((p) => [p.t, p.v]));
    const data = values.get(a).map((p) => ({ t: p.t, lo: Math.min(p.v ?? NaN, vb.get(p.t) ?? NaN), hi: Math.max(p.v ?? NaN, vb.get(p.t) ?? NaN) }));
    series.unshift({ id: `st:fill:${f.key ?? `${a}-${b}`}`, type: "band", pane: paneOf.get(a), data, tone: "iv", legend: false });
  }
  for (const m of (result.markers ?? []).slice(-20)) {
    const t = byDay.get(dayOf(Number(m?.time) * 1000));
    if (t === undefined) continue;
    series.push({ id: `st:mk:${m.key ?? t}`, type: "marker", t, label: m.text ? String(m.text).slice(0, 24) : undefined, tone: m.bias === "bullish" ? "pos" : m.bias === "bearish" ? "neg" : "muted" });
  }
  const notes = [spec.note, result.partial ? "Indicators: not enough history to warm every study up; its first values are left out." : ""].filter(Boolean);
  return { ...spec, panes: [...(spec.panes ?? [{ id: pricePane }]), ...panes], series: [...spec.series, ...series], note: notes.join(" ") };
}
