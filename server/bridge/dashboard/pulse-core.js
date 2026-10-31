// Market pulse, the pure part: market movers, technical readouts, the depth ladder and headlines, shaped for
// pulse.js. Every number becomes text through format.js; no DOM, no network, no clock (callers pass `now`), so
// pulse-core.test.mjs runs it directly. Copy states facts and never advises (copyRules.mjs): "RSI 14 above 70",
// "Bid side 62 % of the book", "Above 4 of 6 averages".
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatSignedPercent, isFigure } from "./format.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** "NSE:RELIANCE" -> "RELIANCE"; anything else is returned trimmed and upper-cased. */
export const tickerOf = (symbol) => String(symbol ?? "").trim().toUpperCase().replace(/^[A-Z]+:/, "");

/** Index underlyings the option chain always has. */
const CHAIN_INDICES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

// ── Market movers ──

/** The mover lists (GET /v1/analytics/markets/movers `by`), with what each ranks on. */
export const MOVER_TABS = Object.freeze([
  { id: "gainers", label: "Gainers", metric: "changePct" },
  { id: "losers", label: "Losers", metric: "changePct" },
  { id: "volume", label: "Volume", metric: "volume" },
  { id: "turnover", label: "Turnover", metric: "turnover" },
  { id: "oi", label: "Open interest", metric: "oi" },
]);

/** Universes the movers route knows without config. */
export const MOVER_UNIVERSES = Object.freeze([
  ["FNO", "F&O stocks"],
  ["NIFTY50", "NIFTY 50"],
  ["INDICES", "Indices"],
]);

/**
 * Rows for one mover list: each item with `bar` (0..1, its metric against the list's largest absolute value), the
 * metric as text, and where its price sits in the day's range (`range`, 0..1 or null).
 * @param {object[]} items GET .../movers data.items
 * @param {string} by gainers | losers | volume | turnover | oi
 */
export function moverRows(items, by) {
  const tab = MOVER_TABS.find((t) => t.id === by) ?? MOVER_TABS[0];
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(0, ...list.map((r) => Math.abs(num(r?.[tab.metric]) ?? 0)));
  return list.map((r) => {
    const v = num(r?.[tab.metric]);
    const lo = num(r?.dayLow);
    const hi = num(r?.dayHigh);
    const ltp = num(r?.ltp);
    return {
      symbol: r.symbol,
      ticker: tickerOf(r.symbol),
      ltp,
      changePct: num(r?.changePct),
      bar: v === null || max === 0 ? 0 : clamp01(Math.abs(v) / max),
      metricText: tab.metric === "changePct" ? formatSignedPercent(v, 2) : v === null ? DASH : formatCompact(v),
      range: ltp !== null && lo !== null && hi !== null && hi > lo ? clamp01((ltp - lo) / (hi - lo)) : null,
      tone: num(r?.changePct) === null || r.changePct === 0 ? "flat" : r.changePct > 0 ? "up" : "down",
    };
  });
}

/** What a board says when it has nothing to rank, per list. */
export const MOVER_EMPTY = Object.freeze({
  gainers: "No stock is up on the day.",
  losers: "No stock is down on the day.",
  volume: "No volume reported yet.",
  turnover: "No turnover reported yet.",
  oi: "No OI for cash stocks: the quotes in this universe carry no open interest.",
});

/**
 * One board from its own answer, never from the others: { state: "rows", rows } or { state: "empty" | "error", text }.
 * Gainers keep only rising names, Losers only falling ones, Open interest only names with OI above zero (cash quotes
 * send none, or 0), so a board never lists flat names as movers.
 * @param {{ data?: any, error?: { message?: string } }} res optional(api(...)) for this board
 * @param {string} by gainers | losers | volume | turnover | oi
 */
export function moverBoard(res, by) {
  const d = res?.data?.data;
  if (!d) return { state: "error", text: res?.error?.message || "Unavailable." };
  const tab = MOVER_TABS.find((t) => t.id === by) ?? MOVER_TABS[0];
  const keep = (r) => {
    const v = num(r?.[tab.metric]);
    if (v === null || !r?.symbol) return false;
    return by === "gainers" ? v > 0 : by === "losers" ? v < 0 : v > 0;
  };
  const rows = moverRows((Array.isArray(d.items) ? d.items : []).filter(keep), by);
  return rows.length ? { state: "rows", rows } : { state: "empty", text: MOVER_EMPTY[by] ?? MOVER_EMPTY.gainers };
}

/**
 * Load every board on its own: each answer is drawn the moment it lands (`onBoard(id, res)`), so one slow or stuck
 * read never holds the others on their placeholders. `onSlow(id)` fires for a board still waiting after `slowMs`.
 * Resolves when every board has answered (a read that never answers leaves only its own board waiting).
 * @param {readonly { id: string }[]} tabs
 * @param {(id: string) => Promise<any>} read resolves to optional(api(...)); never rejects
 * @param {{ onBoard: (id: string, res: any) => void, onSlow?: (id: string) => void, slowMs?: number, timer?: typeof setTimeout, clear?: typeof clearTimeout }} hooks
 */
export function loadBoards(tabs, read, { onBoard, onSlow, slowMs = 8000, timer = setTimeout, clear = clearTimeout }) {
  return Promise.all(
    tabs.map((t) => {
      const slow = onSlow ? timer(() => onSlow(t.id), slowMs) : null;
      return Promise.resolve()
        .then(() => read(t.id))
        .then(
          (res) => res,
          (error) => ({ error }),
        )
        .then((res) => {
          if (slow !== null) clear(slow);
          onBoard(t.id, res);
          return res;
        });
    }),
  );
}

/** Advance/decline as three shares that add to 1, and a one-line text. */
export function breadthParts(summary) {
  const a = num(summary?.advances) ?? 0;
  const d = num(summary?.declines) ?? 0;
  const u = num(summary?.unchanged) ?? 0;
  const t = a + d + u;
  if (!t) return { up: 0, down: 0, flat: 0, text: "No quotes yet" };
  return { up: a / t, down: d / t, flat: u / t, text: `${formatInt(a)} up · ${formatInt(d)} down${u ? ` · ${formatInt(u)} unchanged` : ""}` };
}

// ── Technical readouts ──

/** "high" (RSI 70 or more), "low" (30 or less), "mid", or null. */
export function rsiZone(v) {
  const n = num(v);
  if (n === null) return null;
  return n >= 70 ? "high" : n <= 30 ? "low" : "mid";
}

/**
 * The short chips for one readout (GET /v1/analytics/technicals item): averages above, RSI, MACD, Supertrend and
 * the 52-week position. Each { id, text, tone: up | down | flat }.
 */
export function techChips(t) {
  if (!t) return [];
  const out = [];
  if (t.trend?.of) out.push({ id: "trend", text: `Above ${formatInt(t.trend.above)} of ${formatInt(t.trend.of)} averages`, tone: t.trend.state === "above-all" ? "up" : t.trend.state === "below-all" ? "down" : "flat" });
  const z = rsiZone(t.rsi14);
  if (z) out.push({ id: "rsi", text: `RSI ${formatFixed(t.rsi14, 0)}${z === "high" ? ", above 70" : z === "low" ? ", below 30" : ""}`, tone: z === "high" ? "up" : z === "low" ? "down" : "flat" });
  const hist = num(t.macd?.hist);
  if (hist !== null) out.push({ id: "macd", text: `MACD ${hist >= 0 ? "above" : "below"} its 9-day average`, tone: hist >= 0 ? "up" : "down" });
  if (t.supertrend?.direction) out.push({ id: "st", text: `Supertrend ${t.supertrend.direction}`, tone: t.supertrend.direction === "up" ? "up" : "down" });
  const pos = num(t.range52w?.position);
  if (pos !== null && t.range52w?.complete) out.push({ id: "r52", text: `${formatPercent(pos * 100, 0)} of 52-week range`, tone: pos >= 0.9 ? "up" : pos <= 0.1 ? "down" : "flat" });
  return out;
}

/** Screener filters over readouts: [id, label, test]. */
export const TECH_FILTERS = Object.freeze([
  ["all", "All", () => true],
  ["above-all", "Above all averages", (t) => t.trend?.state === "above-all"],
  ["below-all", "Below all averages", (t) => t.trend?.state === "below-all"],
  ["rsi-high", "RSI above 70", (t) => rsiZone(t.rsi14) === "high"],
  ["rsi-low", "RSI below 30", (t) => rsiZone(t.rsi14) === "low"],
  ["near-high", "Near 52-week high", (t) => Boolean(t.range52w?.complete) && (num(t.range52w?.fromHighPct) ?? -100) >= -2],
  ["near-low", "Near 52-week low", (t) => Boolean(t.range52w?.complete) && (num(t.range52w?.fromLowPct) ?? 100) <= 2],
  ["macd-cross", "MACD crossed (3 sessions)", (t) => Boolean(t.macd?.cross)],
  ["volume", "Volume 2× average", (t) => (num(t.volume?.ratio) ?? 0) >= 2],
  ["facts", "Anything notable", (t) => (t.facts?.length ?? 0) > 0],
]);

/** Readouts that pass filter `id`. */
export function filterTech(items, id) {
  const f = TECH_FILTERS.find(([k]) => k === id) ?? TECH_FILTERS[0];
  return (Array.isArray(items) ? items : []).filter((t) => f[2](t));
}

/** Sort keys for the readout table: [id, label, value(t)]. Missing values sort last. */
export const TECH_SORTS = Object.freeze([
  ["symbol", "Symbol", (t) => tickerOf(t.symbol)],
  ["change", "Change", (t) => num(t.price?.changePct)],
  ["rsi", "RSI", (t) => num(t.rsi14)],
  ["trend", "Averages above", (t) => (t.trend?.of ? t.trend.above / t.trend.of : null)],
  ["r52", "52-week position", (t) => num(t.range52w?.position)],
  ["atr", "ATR %", (t) => num(t.atrPct)],
  ["volume", "Volume vs avg", (t) => num(t.volume?.ratio)],
]);

export function sortTech(items, key = "symbol", dir = 1) {
  const s = TECH_SORTS.find(([k]) => k === key) ?? TECH_SORTS[0];
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const x = s[2](a);
    const y = s[2](b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/**
 * The pivot ladder for one readout: R3 .. S3 with PP, highest first, and where the price sits (`at`: the index of
 * the first level at or below the price, or the length when the price is under S3).
 */
export function pivotLadder(t) {
  const p = t?.pivots;
  if (!p) return { rows: [], at: 0 };
  const rows = [
    ["R3", p.r3],
    ["R2", p.r2],
    ["R1", p.r1],
    ["PP", p.pp],
    ["S1", p.s1],
    ["S2", p.s2],
    ["S3", p.s3],
  ]
    .filter(([, v]) => isFigure(v))
    .map(([name, v]) => ({ name, value: Number(v) }));
  const ltp = num(t?.price?.ltp);
  let at = rows.length;
  if (ltp !== null) {
    const i = rows.findIndex((r) => r.value <= ltp);
    at = i === -1 ? rows.length : i;
  }
  return { rows, at };
}

// ── Depth ladder ──

/**
 * The depth ladder as one list, asks on top (highest price first) and bids below (highest first), from a depth
 * profile (GET /v1/analytics/depth-profile). Each row: { side, price, qty, orders, cum, heat (cumulative share of its
 * side, 0..1), bar (share of the largest level), large, level }. `rows` caps each side (closest to the touch kept).
 */
export function ladderRows(profile, { rows = 20 } = {}) {
  const pick = (list, side) => (Array.isArray(list) ? list.slice(0, rows) : []).map((l) => ({ side, price: l.price, qty: l.qty, orders: l.orders ?? null, cum: l.cum, heat: num(l.cumShare) ?? 0, bar: num(l.share) ?? 0, large: Boolean(l.large), level: l.level }));
  return [...pick(profile?.asks, "ask").reverse(), ...pick(profile?.bids, "bid")];
}

/** The imbalance meter: the bid side's share of the book (0..1) and its text. */
export function imbalanceMeter(imbalance) {
  const x = num(imbalance);
  if (x === null) return { bidShare: 0.5, text: "No depth yet", tone: "flat" };
  const share = clamp01((x + 1) / 2);
  const pct = formatPercent(share * 100, 0);
  return { bidShare: share, text: share >= 0.5 ? `Bid side ${pct} of the book` : `Ask side ${formatPercent((1 - share) * 100, 0)} of the book`, tone: Math.abs(x) < 0.1 ? "flat" : x > 0 ? "up" : "down" };
}

/** Depth choices: [levels, label]. */
export const DEPTH_LEVELS = Object.freeze([
  [5, "5"],
  [20, "20"],
  [200, "200"],
]);

/** A note when the broker answered fewer levels than asked. */
export function depthNote(profile, asked) {
  const got = Math.max(num(profile?.levels?.bids) ?? 0, num(profile?.levels?.asks) ?? 0);
  if (!got) return "No depth for this symbol from the connected broker.";
  if (got < asked) return `Your broker sends ${formatInt(got)} levels for this symbol, not ${formatInt(asked)}. Deeper books come from brokers with a full-depth feed.`;
  return "";
}

// ── Headlines ──

const KIND_LABEL = { market: "News", filing: "Filing", regulator: "Regulator" };
export const kindLabel = (k) => KIND_LABEL[k] ?? "News";

/** "Today", "Yesterday" or "Thu 29 Oct" for an ISO instant, in IST. */
export function dayLabel(iso, now) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "Undated";
  const day = (ms) => new Date(ms + 19_800_000).toISOString().slice(0, 10);
  const d = day(t);
  if (d === day(now)) return "Today";
  if (d === day(now - 86_400_000)) return "Yesterday";
  const dt = new Date(`${d}T00:00:00Z`);
  const W = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${W[dt.getUTCDay()]} ${dt.getUTCDate()} ${M[dt.getUTCMonth()]}`;
}

/** "5 min ago", "3 h ago", or "" for a future or missing time. */
export function agoLabel(iso, now) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t) || t > now + 60_000) return "";
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${formatInt(m)} min ago`;
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? `${formatInt(hrs)} h ago` : "";
}

/** "15:05" in IST for an ISO instant, or "". */
export function istClock(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? new Date(t + 19_800_000).toISOString().slice(11, 16) : "";
}

/** Headlines grouped by IST day, newest first: [{ label, items }]. */
export function groupHeadlines(items, now) {
  const groups = [];
  for (const it of Array.isArray(items) ? items : []) {
    const label = dayLabel(it.publishedAt, now);
    const g = groups.at(-1);
    if (g && g.label === label) g.items.push(it);
    else groups.push({ label, items: [it] });
  }
  return groups;
}

/** Headline filter by kind and by symbols: kind all | market | filing | regulator; symbols null for any. */
export function filterHeadlines(items, { kind = "all", symbols = null } = {}) {
  const want = symbols ? new Set(symbols.map(tickerOf)) : null;
  return (Array.isArray(items) ? items : []).filter((i) => (kind === "all" || i.kind === kind) && (!want || (i.symbols ?? []).some((s) => want.has(s))));
}

/** Where a symbol chip goes: the option chain for an index or an F&O underlying the desk knows, else null. */
export function chainUnderlying(symbol, known = CHAIN_INDICES) {
  const t = tickerOf(symbol);
  return known.has(t) ? t : null;
}
