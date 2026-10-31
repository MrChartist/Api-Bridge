// workspaces-core.js: the pure engines behind the trading workspaces (workspaces.js): the six-workspace map and its
// Shift+1 to Shift+6 keys, the Scalper's layouts (Ctrl+Alt+L), Market Watch's saved tiles, the strike picker's
// window, chart specs for a tile and the live update of its last candle. No DOM, no storage, no fetch, no clock:
// time, prices and saved text come in as arguments, so all of it runs in Node tests.
import { candlesOf, priceText } from "./chart-specs.js";
import { DASH, formatFixed, formatSigned, isFigure } from "./format.js";

const num = (v) => (isFigure(v) ? Number(v) : null);

// ───────────────────────── the six workspaces ─────────────────────────

/**
 * The six workspaces, in the order of their keys (Shift+1 to Shift+6). Three are built here (the Workspaces page's
 * tabs); Stocks and Options Seller open the pages that already do that job, and Shift+6 opens this list (a Custom widget canvas is not built).
 * `route` is a views.js route (`page/tab`); `action` names something that is not a page.
 */
export const WORKSPACES = Object.freeze([
  Object.freeze({ id: "scalper", key: 1, label: "Scalper", route: "workspaces/scalper", sub: "The index with its ATM call and put" }),
  Object.freeze({ id: "trader", key: 2, label: "Options Trader", route: "workspaces/trader", sub: "Chain beside the call and put of a strike" }),
  Object.freeze({ id: "stocks", key: 3, label: "Stocks", route: "screeners/depth", sub: "Depth ladder, scanners and watchlists" }),
  Object.freeze({ id: "seller", key: 4, label: "Options Seller", route: "strategy", sub: "Strategy Builder: payoff and Greeks" }),
  Object.freeze({ id: "watch", key: 5, label: "Market Watch", route: "workspaces/watch", sub: "Up to six charts, each its own symbol" }),
  Object.freeze({ id: "switcher", key: 6, label: "All workspaces", action: "switcher", sub: "This list, to pick one by name" }),
]);

/** The workspace a key press asks for: Shift plus a digit 1 to 6 (by physical key, so any keyboard layout), no other modifier. */
export function workspaceForKey(e) {
  if (!e || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.repeat) return null;
  const m = /^Digit([1-6])$/.exec(String(e.code ?? ""));
  return m ? WORKSPACES[Number(m[1]) - 1] : null;
}

/** The workspace on screen for a route (`page` and `tab` ids), or null. Stocks counts on any Screeners tab. */
export function workspaceOfRoute(pageId, tabId = null) {
  if (pageId === "workspaces") return WORKSPACES.find((w) => w.id === tabId) ?? null;
  if (pageId === "strategy") return WORKSPACES[3];
  if (pageId === "screeners" && ["depth", "stocks", "watchlists"].includes(tabId)) return WORKSPACES[2];
  return null;
}

/** "Shift+1": the label of a workspace's key. */
export const workspaceKeyLabel = (w) => `Shift+${w.key}`;

/** The shortcut sheet's rows for the workspaces (palette.js shortcutList): { keys, what }. */
export function workspaceShortcuts() {
  return [
    { keys: ["Shift", "1…6"], what: `Switch workspace: ${WORKSPACES.map((w) => w.label).join(", ")}` },
    { keys: ["Ctrl", "Alt", "L"], what: "Scalper: next chart layout (index, call, put, all three; side by side or stacked)" },
  ];
}

// ───────────────────────── Scalper layouts ─────────────────────────

export const SCALPER_VIEWS = Object.freeze(["all", "index", "call", "put"]);
export const SCALPER_ARRANGE = Object.freeze(["row", "stack"]);
export const SCALPER_DEFAULT = Object.freeze({ view: "all", arrange: "row" });

/** A saved Scalper layout, cleaned: unknown or missing values fall back to the default. */
export function scalperLayout(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return { view: SCALPER_VIEWS.includes(r.view) ? r.view : SCALPER_DEFAULT.view, arrange: SCALPER_ARRANGE.includes(r.arrange) ? r.arrange : SCALPER_DEFAULT.arrange };
}

/** Which of the three charts a layout shows: ["index", "call", "put"] or one of them. */
export const scalperPanes = (layout) => (scalperLayout(layout).view === "all" ? ["index", "call", "put"] : [scalperLayout(layout).view]);

/** The order Ctrl+Alt+L walks: all three side by side, all three stacked, then the index, the call and the put alone. */
export const SCALPER_CYCLE = Object.freeze([
  Object.freeze({ view: "all", arrange: "row" }),
  Object.freeze({ view: "all", arrange: "stack" }),
  Object.freeze({ view: "index", arrange: "row" }),
  Object.freeze({ view: "call", arrange: "row" }),
  Object.freeze({ view: "put", arrange: "row" }),
]);
/** The layout after this one (Ctrl+Alt+L). A single chart keeps the arrangement out of the match. */
export function nextScalperLayout(layout) {
  const l = scalperLayout(layout);
  const i = SCALPER_CYCLE.findIndex((c) => c.view === l.view && (l.view !== "all" || c.arrange === l.arrange));
  return { ...SCALPER_CYCLE[(i + 1) % SCALPER_CYCLE.length] };
}
/** True for Ctrl+Alt+L (the physical L key), without Shift or Meta. */
export const isLayoutKey = (e) => Boolean(e && e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (e.code === "KeyL" || String(e.key).toLowerCase() === "l"));

/** A layout in words, for the toast and the screen reader: "Index, call and put, side by side". */
export function layoutText(layout) {
  const l = scalperLayout(layout);
  if (l.view === "all") return `Index, call and put, ${l.arrange === "row" ? "side by side" : "stacked"}`;
  return { index: "Index only", call: "Call only", put: "Put only" }[l.view];
}

// ───────────────────────── symbols and strikes ─────────────────────────

/** The index quote symbol of each index underlying (BSE for SENSEX and BANKEX). */
export const INDEX_SYMBOLS = Object.freeze({ NIFTY: "NSE:NIFTY", BANKNIFTY: "NSE:BANKNIFTY", FINNIFTY: "NSE:FINNIFTY", MIDCPNIFTY: "NSE:MIDCPNIFTY", SENSEX: "BSE:SENSEX", BANKEX: "BSE:BANKEX" });
const NAME_RE = /^[A-Z0-9&-]{1,20}$/;
/** A tile's symbol as typed or saved ("nifty", "NSE:RELIANCE") cleaned to its name ("NIFTY", "RELIANCE"), or null. */
export function cleanSymbol(v) {
  const s = String(v ?? "").trim().toUpperCase().replace(/^(NSE|BSE):/, "");
  return NAME_RE.test(s) ? s : null;
}
/** The quote symbol of a name: an index's own, else the NSE cash symbol. */
export const quoteSymbolOf = (name) => INDEX_SYMBOLS[name] ?? `NSE:${name}`;
export const isIndex = (name) => Object.hasOwn(INDEX_SYMBOLS, name);

/** The strikes of a chain answer, ascending. */
export const chainStrikes = (chain) => [...new Set((chain?.rows ?? []).map((r) => num(r?.strike)).filter((k) => k !== null))].sort((a, b) => a - b);

/** The ATM strike: the chain's own when it lists one, else the listed strike nearest the spot; null without strikes. */
export function atmOf(chain) {
  const ks = chainStrikes(chain);
  if (!ks.length) return null;
  const a = num(chain?.atmStrike);
  if (a !== null && ks.includes(a)) return a;
  const spot = num(chain?.underlyingLtp);
  if (spot === null) return ks[Math.floor(ks.length / 2)];
  return ks.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), ks[0]);
}

/** `n` strikes each side of `center` (clamped to the list), for the strike picker and the Trader's chain. */
export function strikeWindow(strikes, center, n = 10) {
  const ks = [...(strikes ?? [])];
  if (!ks.length) return [];
  let i = ks.indexOf(center);
  if (i < 0) i = ks.reduce((b, k, j) => (Math.abs(k - center) < Math.abs(ks[b] - center) ? j : b), 0);
  return ks.slice(Math.max(0, i - n), i + n + 1);
}

/** The strike `d` steps from `k` in the list (clamped); `k` itself when it is not listed. */
export function stepStrike(strikes, k, d) {
  const ks = strikes ?? [];
  const i = ks.indexOf(k);
  if (i < 0) return k;
  return ks[Math.max(0, Math.min(ks.length - 1, i + Math.sign(d)))];
}

/** The leg of a strike: the chain row's `ce` or `pe` (with its symbol), or null. */
export function legOf(chain, strike, right) {
  const row = (chain?.rows ?? []).find((r) => num(r?.strike) === strike);
  const leg = row?.[right === "PE" ? "pe" : "ce"];
  return leg?.symbol ? leg : null;
}

/** "24950 CE": a contract's short name. */
export const contractLabel = (strike, right) => `${isFigure(strike) ? String(Number(strike)) : DASH} ${right}`;

// ───────────────────────── live price and change ─────────────────────────

/**
 * A quote's price and change: { ltp, chg, pct, dir } with dir "up" | "down" | "" (no change, or unknown). The change
 * is the quote's own, else the price against the previous close.
 */
export function changeOf(q) {
  const ltp = num(q?.ltp);
  const close = num(q?.close);
  let chg = num(q?.change);
  if (chg === null && ltp !== null && close !== null && close > 0) chg = ltp - close;
  let pct = num(q?.changePct);
  if (pct === null && chg !== null && close !== null && close > 0) pct = (chg / close) * 100;
  const dir = chg === null || chg === 0 ? "" : chg > 0 ? "up" : "down";
  return { ltp, chg, pct, dir };
}
/** The price and change as text: { price: "24,974.90", change: "+111.65 (+0.45%)" }; a dash for what is missing. */
export function changeText(q, dp = 2) {
  const c = changeOf(q);
  return { price: c.ltp === null ? DASH : formatFixed(c.ltp, dp), change: c.chg === null ? DASH : `${formatSigned(c.chg, dp)}${c.pct === null ? "" : ` (${formatSigned(c.pct, 2)}%)`}`, dir: c.dir };
}

// ───────────────────────── intervals, history and chart specs ─────────────────────────

/** The intervals a tile can show (the Bridge's /v1/history set). */
export const INTERVALS = Object.freeze([
  Object.freeze({ id: "1m", label: "1m", ms: 60_000, countback: 375, refreshMs: 30_000 }),
  Object.freeze({ id: "3m", label: "3m", ms: 180_000, countback: 250, refreshMs: 60_000 }),
  Object.freeze({ id: "5m", label: "5m", ms: 300_000, countback: 150, refreshMs: 60_000 }),
  Object.freeze({ id: "15m", label: "15m", ms: 900_000, countback: 120, refreshMs: 120_000 }),
  Object.freeze({ id: "30m", label: "30m", ms: 1_800_000, countback: 120, refreshMs: 120_000 }),
  Object.freeze({ id: "60m", label: "1h", ms: 3_600_000, countback: 120, refreshMs: 300_000 }),
  Object.freeze({ id: "1d", label: "1D", ms: 86_400_000, countback: 250, refreshMs: 300_000 }),
]);
export const intervalOf = (id) => INTERVALS.find((i) => i.id === id) ?? INTERVALS[2];
const INTERVAL_WORDS = { "1m": "1-minute", "3m": "3-minute", "5m": "5-minute", "15m": "15-minute", "30m": "30-minute", "60m": "hourly", "1d": "daily" };

/** The /v1/history read of a symbol at an interval. */
export const historyPath = (symbol, interval) => `/v1/history?symbol=${encodeURIComponent(symbol)}&interval=${intervalOf(interval).id}&countback=${intervalOf(interval).countback}`;

/** A tile's chart: the candles (with volume when there is any) of one symbol at one interval, or an honest empty. */
export function tileSpec({ name, answer, interval }) {
  const candles = candlesOf(answer);
  if (!candles.length) return { empty: { title: `No candles for ${name} yet`, text: "The broker has no history for it at this interval, or it has not traded yet." } };
  const hasVolume = candles.some((c) => c.volume > 0);
  return {
    label: `${name}: ${INTERVAL_WORDS[intervalOf(interval).id]} candles`,
    panes: [{ id: "price" }],
    series: [{ id: "c", type: "candles", label: name, data: candles, volume: hasVolume, format: priceText }],
  };
}

/**
 * The last candle updated by a live price (pure; a new list, the old one untouched). Inside the last bar's interval the
 * close moves and the high / low stretch; past it a new bar opens at the price. A price that is not a figure, or a
 * clock behind the last bar, changes nothing.
 */
export function applyTick(candles, ltp, nowMs, intervalMs) {
  const p = num(ltp);
  if (!candles?.length || p === null || !(intervalMs > 0)) return candles;
  const last = candles[candles.length - 1];
  if (!(nowMs >= last.t)) return candles;
  if (nowMs < last.t + intervalMs) {
    if (last.close === p && last.high >= p && last.low <= p) return candles;
    return [...candles.slice(0, -1), { ...last, close: p, high: Math.max(last.high, p), low: Math.min(last.low, p) }];
  }
  // Daily bars open once a day: a new session is drawn by the next refresh, not by a tick.
  if (intervalMs >= 86_400_000) return candles;
  const t = last.t + Math.floor((nowMs - last.t) / intervalMs) * intervalMs;
  return [...candles, { t, open: p, high: p, low: p, close: p, volume: 0 }];
}

// ───────────────────────── Market Watch ─────────────────────────

export const WATCH_MAX = 6;
/** How many tiles the grid can show. */
export const WATCH_COUNTS = Object.freeze([1, 2, 4, 6]);
export const WATCH_DEFAULT = Object.freeze({
  count: 6,
  tiles: Object.freeze([
    Object.freeze({ symbol: "NIFTY", interval: "5m" }),
    Object.freeze({ symbol: "BANKNIFTY", interval: "5m" }),
    Object.freeze({ symbol: "SENSEX", interval: "5m" }),
    Object.freeze({ symbol: "RELIANCE", interval: "15m" }),
    Object.freeze({ symbol: "HDFCBANK", interval: "15m" }),
    Object.freeze({ symbol: "INFY", interval: "1d" }),
  ]),
});
/** The demo has no stock quotes: its grid starts on its three indices. */
export const WATCH_DEMO_DEFAULT = Object.freeze({
  count: 6,
  tiles: Object.freeze([
    Object.freeze({ symbol: "NIFTY", interval: "1m" }),
    Object.freeze({ symbol: "BANKNIFTY", interval: "1m" }),
    Object.freeze({ symbol: "SENSEX", interval: "1m" }),
    Object.freeze({ symbol: "NIFTY", interval: "15m" }),
    Object.freeze({ symbol: "BANKNIFTY", interval: "15m" }),
    Object.freeze({ symbol: "SENSEX", interval: "1d" }),
  ]),
});

/**
 * Saved Market Watch text (JSON) read back strictly: six tiles of { symbol, interval } (a bad tile takes the default's
 * place) and a count from WATCH_COUNTS. Never throws; garbage gives the default.
 */
export function readWatch(text, fallback = WATCH_DEFAULT) {
  let raw = null;
  try {
    raw = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    raw = null;
  }
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const count = WATCH_COUNTS.includes(r.count) ? r.count : fallback.count;
  const list = Array.isArray(r.tiles) ? r.tiles : [];
  const tiles = fallback.tiles.map((d, i) => {
    const t = list[i];
    const symbol = cleanSymbol(t?.symbol);
    const interval = INTERVALS.some((x) => x.id === t?.interval) ? t.interval : d.interval;
    return symbol ? { symbol, interval } : { ...d };
  });
  return { count, tiles };
}
/** The state with one tile changed in place (pure): a bad symbol or interval leaves that field as it was. */
export function setTile(state, i, patch) {
  if (!Number.isInteger(i) || i < 0 || i >= WATCH_MAX) return state;
  const tiles = state.tiles.map((t, j) => {
    if (j !== i) return t;
    const symbol = patch?.symbol === undefined ? t.symbol : cleanSymbol(patch.symbol) ?? t.symbol;
    const interval = INTERVALS.some((x) => x.id === patch?.interval) ? patch.interval : t.interval;
    return { symbol, interval };
  });
  return { ...state, tiles };
}
/** The grid of a tile count: { cols, rows } on a wide screen (one column on a phone is CSS's job). */
export const watchGrid = (count) => ({ 1: { cols: 1, rows: 1 }, 2: { cols: 2, rows: 1 }, 4: { cols: 2, rows: 2 }, 6: { cols: 3, rows: 2 } })[count] ?? { cols: 3, rows: 2 };

// ───────────────────────── the order ticket ─────────────────────────

/**
 * What a chart's Buy or Sell opens: the chain's own order ticket for one contract, filled in (the palette's typed-trade
 * handoff). On the index chart, Buy is the ATM call and Sell the ATM put, both bought: the index itself is not traded.
 * Returns the trade-intent leg for trade-intent.js intentHandoff, or null when there is no contract.
 * @param {{ underlying: string, strike: number|null, right?: "CE"|"PE", side: "BUY"|"SELL", pane?: "index"|"call"|"put", lots?: number }} o
 */
export function tradeLeg({ underlying, strike, right, side, pane = null, lots = 1 }) {
  if (!underlying || !isFigure(strike)) return null;
  if (pane === "index") return { kind: "leg", underlying, strike: Number(strike), right: side === "BUY" ? "CE" : "PE", side: "BUY", lots: Math.max(1, lots | 0) };
  if (right !== "CE" && right !== "PE") return null;
  return { kind: "leg", underlying, strike: Number(strike), right, side: side === "SELL" ? "SELL" : "BUY", lots: Math.max(1, lots | 0) };
}
