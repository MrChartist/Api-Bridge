// Market pulse: market movers, technical readouts, headlines and the depth ladder, for whichever broker is connected
// (or demo data). The Bridge computes everything from data every adapter has (quotes, daily candles, market depth)
// and public news feeds; nothing here needs a broker-specific API. Pages:
//   Screeners › Movers       (#/screeners/movers)      GET /v1/analytics/markets/movers, one shared quote pass
//   Screeners › Technicals   (#/screeners/technicals)  GET /v1/analytics/technicals, 25 symbols a call
//   Flow › Headlines         (#/flow/news)             GET /v1/analytics/news/headlines
//   Screeners › Depth ladder (#/screeners/depth?symbol=)        GET /v1/analytics/depth-profile (5, 20 or 200 levels)
// and two Home cards (moversCard, headlinesCard). Any symbol opens the symbol sheet: readouts, top of book, its
// headlines, and the chart, ladder and option chain one tap away.
//
// Reads only: nothing here places an order. Numbers become text through format.js; the shaping is pulse-core.js
// (pure, tested). Copy states facts and never advises (copyRules.mjs).
import { api, app, card, emptyState, errorState, h, icon, loadingState, modal, optional, pill } from "./app.js";
import { DASH, formatCompact, formatFixed, formatGrouped, formatInt, formatPercent, formatSignedPercent, isFigure } from "./format.js";
import { candlesOf, contractSpec } from "./chart-specs.js";
import { svgEl } from "./viz.js";
import { every, segmented } from "./views.js";
import {
  DEPTH_LEVELS,
  MOVER_TABS,
  MOVER_UNIVERSES,
  TECH_FILTERS,
  TECH_SORTS,
  agoLabel,
  istClock,
  breadthParts,
  chainUnderlying,
  depthNote,
  filterHeadlines,
  filterTech,
  groupHeadlines,
  imbalanceMeter,
  kindLabel,
  ladderRows,
  loadBoards,
  moverBoard,
  moverRows,
  pivotLadder,
  rsiZone,
  sortTech,
  techChips,
  tickerOf,
} from "./pulse-core.js";

const SLOT = "mcb.dashboard.pulse";
const DESK_SLOT = "mcb.dashboard.desk";
const TECH_CHUNK = 25;
const TECH_MAX = 50;
/** replaceChildren without the nulls. */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const num = (v) => (isFigure(v) ? Number(v) : null);
const price = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1000 ? formatGrouped(v, 2) : formatFixed(v, 2));
const tone = (v) => (num(v) === null || v === 0 ? "flat" : v > 0 ? "up" : "down");
const delta = (v, dp = 2) => h("span", { class: `delta ${tone(v)}` }, num(v) === null ? DASH : `${v > 0 ? "▲" : v < 0 ? "▼" : ""} ${formatSignedPercent(v, dp)}`.trim());
const enc = encodeURIComponent;

function prefs() {
  try {
    return JSON.parse(app.local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function savePrefs(patch) {
  app.local.set(SLOT, JSON.stringify({ ...prefs(), ...patch }));
}

/** A bar 0..1 drawn with a width (a span inside a track). */
function bar(share, cls = "") {
  const f = h("i", { class: `pm-bar-fill ${cls}`.trim() });
  f.style.width = `${formatFixed(Math.max(0, Math.min(1, share)) * 100, 1)}%`;
  return h("span", { class: "pm-bar", "aria-hidden": "true" }, f);
}

/** Where a value sits in a range (0..1): a track with a dot. */
function rangeDot(pos, label) {
  const dot = h("i", { class: "pm-range-dot" });
  dot.style.left = `${formatFixed(Math.max(0, Math.min(1, pos ?? 0.5)) * 100, 1)}%`;
  return h("span", { class: `pm-range${pos === null || pos === undefined ? " none" : ""}`, role: "img", "aria-label": label }, dot);
}

// ── Symbol actions ──

/** Open the option chain on an underlying (the desk's saved settings, nearest expiry). */
function toChain(underlying) {
  let desk = {};
  try {
    desk = JSON.parse(app.local.get(DESK_SLOT) ?? "{}") ?? {};
  } catch {
    desk = {};
  }
  const next = { ...desk, underlying };
  delete next.expiry;
  delete next.focus;
  app.local.set(DESK_SLOT, JSON.stringify(next));
  document.querySelector("#dialog .sheet-close")?.click();
  location.hash = "#/chain";
}

/** Daily candles of a symbol in the chart modal (indicators available there). */
export function openChart(symbol) {
  const name = tickerOf(symbol);
  return app.chartEngine?.open(`${name}: daily`, {
    label: `${name} daily candles`,
    studies: { symbol: () => symbol },
    load: async () => contractSpec({ name, daily: true, candles: candlesOf((await api(`/v1/history?symbol=${enc(symbol)}&interval=1d&countback=250`)).data?.data) }),
  });
}

/** One readout as a compact block: price, the chips, pivots, 52-week range, the facts. */
function readoutBlock(t) {
  if (!t) return h("p", { class: "muted small" }, "No readout for this symbol.");
  const chips = techChips(t);
  const lad = pivotLadder(t);
  const r52 = t.range52w ?? {};
  const pivots = h(
    "ol",
    { class: "pm-pivots", "aria-label": `Floor pivots from the session of ${t.pivots?.session ?? "the previous day"}` },
    lad.rows.flatMap((r, i) => [
      i === lad.at ? h("li", { class: "pm-pivot-ltp" }, h("span", {}, "Last"), h("strong", {}, price(t.price?.ltp))) : null,
      h("li", { class: `pm-pivot ${r.name === "PP" ? "pp" : r.name[0] === "R" ? "r" : "s"}` }, h("span", {}, r.name), h("strong", {}, price(r.value))),
    ]),
    lad.at === lad.rows.length && lad.rows.length ? h("li", { class: "pm-pivot-ltp" }, h("span", {}, "Last"), h("strong", {}, price(t.price?.ltp))) : null,
  );
  const kv = (k, v, cls) => [h("dt", {}, k), h("dd", { class: cls || undefined }, v)];
  return h(
    "div",
    { class: "pm-readout" },
    h("div", { class: "chips pm-chips" }, chips.map((c) => h("span", { class: `chip pm-chip ${c.tone}` }, c.text))),
    h(
      "div",
      { class: "pm-readout-grid" },
      h(
        "dl",
        { class: "pm-kv" },
        kv("RSI 14", isFigure(t.rsi14) ? formatFixed(t.rsi14, 1) : DASH, { high: "up", low: "down" }[rsiZone(t.rsi14)]),
        kv("MACD", isFigure(t.macd?.hist) ? `${formatFixed(t.macd.macd, 2)} (hist ${formatFixed(t.macd.hist, 2)})` : DASH, isFigure(t.macd?.hist) ? (t.macd.hist >= 0 ? "up" : "down") : ""),
        kv("ADX 14", isFigure(t.adx14?.adx) ? formatFixed(t.adx14.adx, 1) : DASH),
        kv("ATR 14", isFigure(t.atr14) ? `${price(t.atr14)} (${formatPercent(t.atrPct, 1)})` : DASH),
        kv("Bollinger %B", isFigure(t.bollinger?.percentB) ? formatFixed(t.bollinger.percentB, 2) : DASH),
        kv("Supertrend", t.supertrend?.direction ? `${t.supertrend.direction === "up" ? "Up" : "Down"} at ${price(t.supertrend.value)}` : DASH, t.supertrend?.direction ?? ""),
        kv("Volume", isFigure(t.volume?.ratio) ? `${formatFixed(t.volume.ratio, 2)}× 20-day average` : DASH),
        kv("Returns", [["5d", t.returns?.d5], ["20d", t.returns?.d20], ["60d", t.returns?.d60]].map(([k, v]) => `${k} ${formatSignedPercent(v, 1)}`).join(" · ")),
      ),
      h("div", { class: "pm-side" }, h("h4", { class: "pm-mini-h" }, "Pivots (classic)"), pivots),
    ),
    h(
      "div",
      { class: "pm-r52" },
      h("span", { class: "pm-mini-h" }, `52-week range${r52.complete ? "" : ` (${formatInt(r52.sessions)} sessions)`}`),
      h("div", { class: "pm-r52-row" }, h("span", {}, price(r52.low)), rangeDot(num(r52.position), `Last price at ${formatPercent((num(r52.position) ?? 0) * 100, 0)} of the range`), h("span", {}, price(r52.high))),
    ),
    t.averages?.length
      ? h(
          "ul",
          { class: "pm-ma", "aria-label": "Moving averages" },
          t.averages.map((a) => h("li", { class: a.above === null ? "none" : a.above ? "up" : "down" }, h("span", {}, `${a.kind.toUpperCase()} ${a.length}`), h("strong", {}, price(a.value)), h("small", {}, a.distancePct === null ? DASH : formatSignedPercent(a.distancePct, 1)))),
        )
      : null,
    t.facts?.length ? h("ul", { class: "pm-facts" }, t.facts.map((f) => h("li", { class: f.tone }, f.text))) : null,
  );
}

/**
 * The symbol sheet: readouts, the top of the book, this symbol's headlines; Chart, Depth ladder and Option chain.
 * @param {string} symbol e.g. NSE:RELIANCE
 */
export function openSymbolSheet(symbol) {
  const t = tickerOf(symbol);
  const sym = symbol.includes(":") ? symbol : `NSE:${t}`;
  const techHost = h("div", {}, loadingState({ rows: 4, cols: 3, label: "Reading candles" }));
  const bookHost = h("div", { class: "pm-sheet-book" });
  const newsHost = h("div", {});
  // The Option chain button shows once the Bridge lists expiries for this name (an index or an F&O stock).
  const chainBtn = h("button", { type: "button", class: "small", hidden: true, onclick: () => toChain(t) }, icon("list"), "Option chain");
  const acts = h(
    "div",
    { class: "row pm-sheet-acts" },
    h("button", { type: "button", class: "small", onclick: () => openChart(sym) }, icon("chart"), "Chart"),
    h("a", { class: "btn small", href: `#/screeners/depth?symbol=${enc(sym)}`, onclick: () => document.querySelector("#dialog .sheet-close")?.click() }, icon("bars"), "Depth ladder"),
    chainBtn,
  );
  (async () => {
    const [tr, dr, nr, er] = await Promise.all([
      optional(api(`/v1/analytics/technicals?symbols=${enc(sym)}`)),
      optional(api(`/v1/analytics/depth-profile?symbol=${enc(sym)}`)),
      optional(api(`/v1/analytics/news/headlines?symbols=${enc(t)}&only=symbols&days=7`)),
      optional(api(`/v1/expiries?underlying=${enc(t)}`)),
    ]);
    chainBtn.hidden = !(er.data?.data?.expiries?.length > 0);
    const item = tr.data?.data?.items?.[0];
    fill(techHost, tr.error ? h("p", { class: "muted small" }, `No readouts: ${tr.error.message}`) : h("div", {}, h("div", { class: "pm-sheet-px" }, h("strong", {}, price(item?.price?.ltp)), delta(item?.price?.changePct), item?.live ? pill("Live session", "info") : pill(`Close of ${item?.asOf ?? DASH}`)), readoutBlock(item)));
    const p = dr.data?.data;
    fill(
      bookHost,
      p && p.levels && (p.levels.bids || p.levels.asks)
        ? [
            h("h4", { class: "pm-mini-h" }, "Top of the book"),
            h(
              "dl",
              { class: "pm-kv two" },
              h("dt", {}, "Bid"),
              h("dd", { class: "bid" }, `${price(p.bestBid)} × ${formatInt(p.bids?.[0]?.qty)}`),
              h("dt", {}, "Ask"),
              h("dd", { class: "ask" }, `${price(p.bestAsk)} × ${formatInt(p.asks?.[0]?.qty)}`),
              h("dt", {}, "Spread"),
              h("dd", {}, isFigure(p.spreadBps) ? `${formatFixed(p.spread, 2)} (${formatFixed(p.spreadBps, 1)} bps)` : DASH),
              h("dt", {}, "Imbalance"),
              h("dd", { class: { up: "bid", down: "ask" }[imbalanceMeter(p.imbalance).tone] }, imbalanceMeter(p.imbalance).text),
            ),
          ]
        : null,
    );
    const items = nr.data?.data?.items ?? [];
    fill(newsHost, items.length ? [h("h4", { class: "pm-mini-h" }, "Headlines naming it"), headlineList(items.slice(0, 6), { compact: true })] : null);
  })();
  return modal({ title: t, body: h("div", { class: "pm-sheet" }, acts, techHost, bookHost, newsHost), buttons: [{ label: "Close", value: false }] });
}

/** A symbol chip: opens the symbol sheet. */
const symbolChip = (s) => h("button", { type: "button", class: "chip-btn pm-sym", onclick: (e) => (e.preventDefault(), openSymbolSheet(s)), "aria-label": `${tickerOf(s)}: readouts, chart and depth` }, tickerOf(s));

// ── Movers ──

/** One mover list as rows: rank, symbol, price, the metric with a bar, and where the price sits in the day's range. */
function moverList(items, by, { compact = false } = {}) {
  const rows = moverRows(items, by);
  if (!rows.length) return h("p", { class: "muted small pm-empty" }, by === "oi" ? "No OI for cash stocks: the quotes in this universe carry no open interest." : "Nothing to rank yet.");
  return moverOl(rows, by, { compact });
}

/** Ranked rows (moverRows / moverBoard) as the list. */
function moverOl(rows, by, { compact = false } = {}) {
  return h(
    "ol",
    { class: `pm-movers${compact ? " compact" : ""}` },
    rows.map((r, i) =>
      h(
        "li",
        {},
        h(
          "a",
          { class: "pm-mrow", href: `#/screeners/depth?symbol=${enc(r.symbol)}`, onclick: (e) => (e.preventDefault(), openSymbolSheet(r.symbol)), title: `${r.ticker}: readouts, chart and depth` },
          h("span", { class: "pm-rank" }, formatInt(i + 1)),
          h("span", { class: "pm-name" }, h("strong", {}, r.ticker), compact ? null : h("small", {}, price(r.ltp))),
          h("span", { class: `pm-metric ${by === "gainers" || by === "losers" ? r.tone : ""}`.trim() }, r.metricText),
          bar(r.bar, by === "gainers" ? "up" : by === "losers" ? "down" : "info"),
          compact ? null : rangeDot(r.range, r.range === null ? "Day range not known" : `At ${formatPercent(r.range * 100, 0)} of the day's range`),
        ),
      ),
    ),
  );
}

/** The advance/decline strip: one bar in three parts and its count. */
function breadthStrip(summary) {
  const b = breadthParts(summary);
  const seg = (share, cls) => {
    const s = h("i", { class: `pm-ad-${cls}` });
    s.style.flexGrow = String(share);
    return s;
  };
  return h("div", { class: "pm-ad" }, h("div", { class: "pm-ad-bar", role: "img", "aria-label": b.text }, seg(b.up, "up"), seg(b.flat, "flat"), seg(b.down, "down")), h("span", { class: "pm-ad-text" }, b.text));
}

/** Universe choices: the built-in three plus any from config scanner.universes. */
async function universeChoices() {
  const r = await optional(api("/v1/scanner/universes"));
  const extra = (r.data?.data?.items ?? r.data?.data ?? []).map((u) => u?.name).filter((n) => typeof n === "string" && !MOVER_UNIVERSES.some(([k]) => k === n) && n !== "WATCHLIST");
  return [...MOVER_UNIVERSES, ...extra.map((n) => [n, n])];
}

export async function renderMoversPage() {
  const p = prefs();
  const st = { universe: p.universe ?? "FNO", limit: 15 };
  const choices = await universeChoices();
  if (!choices.some(([k]) => k === st.universe)) st.universe = "FNO";
  const uSel = h("select", { "aria-label": "Universe", class: "pm-sel" }, choices.map(([k, l]) => h("option", { value: k, selected: k === st.universe }, l)));
  const status = h("span", { class: "muted small pm-status", "aria-live": "polite" });
  const adHost = h("div", { class: "pm-ad-host" });
  const boards = Object.fromEntries(MOVER_TABS.map((t) => [t.id, card({ title: t.label, glyph: t.id === "losers" ? "down" : t.id === "gainers" ? "up" : t.id === "oi" ? "bars" : "activity", tint: t.id === "gainers" ? "green" : t.id === "losers" ? "red" : t.id === "volume" ? "blue" : t.id === "turnover" ? "purple" : "orange", cls: `pm-board pm-board-${t.id}`, body: loadingState({ rows: 8, cols: 3, label: "Reading quotes" }) })]));
  const grid = h("div", { class: "pm-boards" }, Object.values(boards));
  const err = h("div", { hidden: true });
  uSel.addEventListener("change", () => {
    st.universe = uSel.value;
    savePrefs({ universe: st.universe });
    busy = null;
    load();
  });
  // Each board draws from its own answer the moment it lands (pulse-core loadBoards): the first pass over a large
  // universe on a real broker takes seconds (5 to 13 s seen, longer when the quote budget is busy), and one slow or
  // stuck read used to hold all five boards on their placeholders behind a Promise.all.
  let busy = null;
  function load() {
    if (busy) return busy;
    const u = st.universe;
    let shown = false;
    let fails = 0;
    const answer = (id, res) => {
      if (u !== st.universe) return;
      const body = boards[id].querySelector(".card-body");
      const b = moverBoard(res, id);
      if (body) fill(body, b.state === "rows" ? moverOl(b.rows, id) : h("p", { class: "muted small pm-empty" }, b.text));
      if (res?.error) fails += 1;
      const first = res?.data;
      if (first?.data && !shown) {
        shown = true;
        err.hidden = true;
        fill(adHost, breadthStrip(first.data.summary));
        const m = first.meta ?? {};
        status.textContent = `${formatInt(m.quoted)} of ${formatInt(m.requested)} quoted · ${agoLabel(first.data.asOf, Date.now()) || "now"} · refreshes every 15 s`;
      }
      if (fails === MOVER_TABS.length) {
        err.hidden = false;
        fill(err, errorState(res.error, { onRetry: load }));
      }
    };
    const slow = () => {
      if (u !== st.universe || shown) return;
      status.textContent = "Still reading quotes: the first pass over a large universe can take a few seconds…";
    };
    busy = loadBoards(MOVER_TABS, (id) => optional(api(`/v1/analytics/markets/movers?universe=${enc(u)}&by=${id}&limit=${st.limit}`)), { onBoard: answer, onSlow: slow }).finally(() => {
      busy = null;
    });
    return busy;
  }
  load();
  every(15_000, load);
  const bar0 = h("div", { class: "pm-toolbar" }, h("label", { class: "pm-field" }, h("span", {}, "Universe"), uSel), adHost, status);
  return [bar0, err, grid, h("p", { class: "muted small pm-foot" }, "From one batched quote pass of the universe (cached 15 s, shared). Tap a name for its readouts, chart and depth.")];
}

// ── Technicals ──

/** Symbols for the technicals table: a watchlist, NIFTY 50, or typed symbols. */
async function techSources() {
  const [wl, un] = await Promise.all([optional(api("/v1/watchlists")), optional(api("/v1/scanner/universes/NIFTY50"))]);
  const lists = (wl.data?.data?.items ?? []).filter((l) => Array.isArray(l.symbols) && l.symbols.length);
  const nifty = un.data?.data?.symbols ?? un.data?.data?.items ?? [];
  const out = lists.map((l) => ({ id: `wl:${l.id}`, label: `Watchlist: ${l.name}`, symbols: l.symbols }));
  if (Array.isArray(nifty) && nifty.length) out.push({ id: "nifty50", label: "NIFTY 50", symbols: nifty.map((s) => (typeof s === "string" ? s : s?.symbol)).filter(Boolean) });
  out.push({ id: "custom", label: "Symbols I type", symbols: [] });
  return out;
}

/** A 0..100 RSI gauge with the 30 and 70 marks. */
function rsiGauge(v) {
  const n = num(v);
  const z = rsiZone(n);
  const dot = h("i", { class: "pm-rsi-dot" });
  dot.style.left = `${formatFixed(Math.max(0, Math.min(100, n ?? 50)), 1)}%`;
  return h("span", { class: "pm-rsi-cell" }, h("span", { class: `pm-rsi ${z ?? "none"}`, role: "img", "aria-label": n === null ? "RSI not known" : `RSI ${formatFixed(n, 0)}` }, h("i", { class: "pm-rsi-lo" }), h("i", { class: "pm-rsi-hi" }), dot), h("span", { class: "pm-rsi-v" }, n === null ? DASH : formatFixed(n, 0)));
}

/** Six dots: price above (filled) or below each average. */
function maDots(t) {
  return h(
    "span",
    { class: "pm-dots", role: "img", "aria-label": t.trend?.of ? `Above ${t.trend.above} of ${t.trend.of} averages` : "Averages not known" },
    (t.averages ?? []).map((a) => h("i", { class: a.above === null ? "none" : a.above ? "up" : "down", title: `${a.kind.toUpperCase()} ${a.length}: ${price(a.value)}` })),
  );
}

export async function renderTechnicalsPage() {
  const p = prefs();
  const sources = await techSources();
  const st = { source: sources.some((s) => s.id === p.techSource) ? p.techSource : sources[0].id, filter: "all", sort: p.techSort ?? "symbol", dir: p.techDir === -1 ? -1 : 1, custom: typeof p.techCustom === "string" ? p.techCustom : "NSE:RELIANCE, NSE:TCS, NSE:HDFCBANK, NSE:INFY", items: [], errors: [], busy: false, at: 0 };
  const srcSel = h("select", { "aria-label": "Symbols from", class: "pm-sel" }, sources.map((s) => h("option", { value: s.id, selected: s.id === st.source }, s.label)));
  const customIn = h("input", { type: "text", class: "pm-custom", value: st.custom, "aria-label": "Symbols, comma-separated", placeholder: "NSE:RELIANCE, NSE:TCS", autocomplete: "off", spellcheck: "false" });
  const runBtn = h("button", { type: "button", class: "small rect" }, icon("refresh"), "Read");
  const sortSel = h("select", { "aria-label": "Sort by", class: "pm-sel" }, TECH_SORTS.map(([k, l]) => h("option", { value: k, selected: k === st.sort }, l)));
  const dirBtn = h("button", { type: "button", class: "small quiet", "aria-label": "Reverse the order" }, icon(st.dir === 1 ? "up" : "down"));
  const filters = h("div", { class: "chips pm-filters", role: "group", "aria-label": "Filter" });
  const status = h("span", { class: "muted small pm-status", "aria-live": "polite" });
  const host = h("div", { class: "pm-tech-host" }, loadingState({ rows: 10, cols: 8, label: "Reading candles" }));
  const customRow = h("div", { class: "pm-custom-row" }, customIn, runBtn);

  const symbolsNow = () => {
    if (st.source === "custom")
      return [
        ...new Set(
          customIn.value
            .split(/[\s,]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
            .map((s) => (s.includes(":") ? s : `NSE:${s}`)),
        ),
      ].slice(0, TECH_MAX);
    return (sources.find((s) => s.id === st.source)?.symbols ?? []).slice(0, TECH_MAX);
  };
  async function load() {
    if (st.busy) return;
    const syms = symbolsNow();
    customRow.hidden = st.source !== "custom";
    if (!syms.length) {
      st.items = [];
      fill(host, emptyState("chart", "No symbols", "Type symbols such as NSE:RELIANCE, NSE:TCS, or pick a watchlist."));
      return;
    }
    st.busy = true;
    status.textContent = `Reading ${formatInt(syms.length)} symbols`;
    try {
      const chunks = [];
      for (let i = 0; i < syms.length; i += TECH_CHUNK) chunks.push(syms.slice(i, i + TECH_CHUNK));
      const res = await Promise.all(chunks.map((c) => optional(api(`/v1/analytics/technicals?symbols=${c.map(enc).join(",")}`))));
      st.items = res.flatMap((r) => r.data?.data?.items ?? []);
      st.errors = res.flatMap((r) => (r.error ? [{ symbol: "", message: r.error.message }] : r.data?.errors ?? []));
      st.at = Date.now();
      if (!st.items.length && res[0]?.error) fill(host, errorState(res[0].error, { onRetry: load }));
      else draw();
    } finally {
      st.busy = false;
    }
  }
  function drawFilters() {
    fill(
      filters,
      TECH_FILTERS.map(([id, label]) => {
        const n = filterTech(st.items, id).length;
        if (id !== "all" && !n) return null;
        return h("button", { type: "button", class: "chip-btn", "aria-pressed": String(st.filter === id), onclick: () => ((st.filter = id), draw()) }, `${label} ${formatInt(n)}`);
      }),
    );
  }
  function draw() {
    drawFilters();
    const rows = sortTech(filterTech(st.items, st.filter), st.sort, st.dir);
    status.textContent = `${formatInt(st.items.length)} symbols · daily candles; the last session follows the live price${st.errors.length ? ` · ${formatInt(st.errors.length)} could not be read` : ""}`;
    if (!rows.length) return fill(host, emptyState("chart", "Nothing matches", st.items.length ? "No symbol passes this filter now." : "No readouts yet."));
    const head = ["Symbol", "Last", "Change", "Averages", "RSI 14", "MACD", "Supertrend", "52-week", "Vol ×", "Notable"];
    fill(
      host,
      h(
        "div",
        { class: "table-wrap pm-tech-wrap" },
        h(
          "table",
          { class: "pm-tech" },
          h("thead", {}, h("tr", {}, head.map((x, i) => h("th", { scope: "col", class: i > 0 && i < 3 ? "num" : undefined }, x)))),
          h(
            "tbody",
            {},
            rows.map((t) =>
              h(
                "tr",
                {},
                h("th", { scope: "row" }, symbolChip(t.symbol)),
                h("td", { class: "num" }, price(t.price?.ltp)),
                h("td", { class: "num" }, delta(t.price?.changePct)),
                h("td", {}, maDots(t)),
                h("td", {}, rsiGauge(t.rsi14)),
                h("td", {}, isFigure(t.macd?.hist) ? h("span", { class: `pm-tag ${t.macd.hist >= 0 ? "up" : "down"}` }, `${t.macd.hist >= 0 ? "Above" : "Below"}${t.macd.cross ? ", crossed" : ""}`) : DASH),
                h("td", {}, t.supertrend?.direction ? h("span", { class: `pm-tag ${t.supertrend.direction}` }, t.supertrend.direction === "up" ? "Up" : "Down") : DASH),
                h("td", {}, t.range52w?.complete ? rangeDot(num(t.range52w.position), `At ${formatPercent((num(t.range52w.position) ?? 0) * 100, 0)} of the 52-week range`) : h("span", { class: "muted small" }, "Under a year")),
                h("td", { class: "num" }, isFigure(t.volume?.ratio) ? formatFixed(t.volume.ratio, 1) : DASH),
                h("td", { class: `pm-note ${t.facts?.[0]?.tone ?? ""}`.trim() }, t.facts?.[0]?.text ?? ""),
              ),
            ),
          ),
        ),
      ),
    );
  }
  srcSel.addEventListener("change", () => {
    st.source = srcSel.value;
    st.filter = "all";
    savePrefs({ techSource: st.source });
    load();
  });
  runBtn.addEventListener("click", () => {
    savePrefs({ techCustom: customIn.value });
    load();
  });
  customIn.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), runBtn.click()));
  sortSel.addEventListener("change", () => {
    st.sort = sortSel.value;
    savePrefs({ techSort: st.sort });
    draw();
  });
  dirBtn.addEventListener("click", () => {
    st.dir = -st.dir;
    savePrefs({ techDir: st.dir });
    fill(dirBtn, icon(st.dir === 1 ? "up" : "down"));
    draw();
  });
  customRow.hidden = st.source !== "custom";
  load();
  // Candles are cached for the day on the Bridge; a refresh re-reads only the live quotes.
  every(60_000, load);
  const bar0 = h("div", { class: "pm-toolbar" }, h("label", { class: "pm-field" }, h("span", {}, "Symbols"), srcSel), customRow, h("label", { class: "pm-field" }, h("span", {}, "Sort"), sortSel), dirBtn, status);
  return [bar0, filters, host, h("p", { class: "muted small pm-foot" }, "Indicators from daily candles of the connected broker (ChartistScript kernel), the last session following the live price. Facts describe the numbers; they are not advice.")];
}

// ── Headlines ──

/** Headlines as a list: time, source, title (a link to the publisher), symbol chips. */
function headlineList(items, { compact = false, now = Date.now() } = {}) {
  return h(
    "ul",
    { class: `pm-news${compact ? " compact" : ""}` },
    items.map((n) => {
      const ago = agoLabel(n.publishedAt, now);
      const when = ago || (n.publishedAt ? istClock(n.publishedAt) : "");
      return h(
        "li",
        { class: `pm-n ${n.kind}` },
        h("span", { class: "pm-n-meta" }, h("span", { class: `pm-kind ${n.kind}` }, kindLabel(n.kind)), h("span", {}, n.sourceName ?? n.source), when ? h("time", { datetime: n.publishedAt ?? "" }, when) : null),
        n.link ? h("a", { class: "pm-n-title", href: n.link, target: "_blank", rel: "noopener noreferrer" }, n.title) : h("span", { class: "pm-n-title" }, n.title),
        n.symbols?.length ? h("span", { class: "chips pm-n-syms" }, n.symbols.slice(0, 4).map((s) => symbolChip(s))) : null,
      );
    }),
  );
}

/** Symbols the user follows: one watchlist's, or the held ones (positions and holdings). */
async function followed(kind) {
  if (kind === "held") {
    const [pos, hold] = await Promise.all([optional(api("/v1/positions")), optional(api("/v1/holdings"))]);
    const syms = [...(pos.data?.data ?? []), ...(hold.data?.data ?? [])].map((r) => r?.underlying ?? r?.symbol).filter(Boolean);
    return [...new Set(syms.map((s) => tickerOf(String(s).split("-")[0])))].slice(0, 50);
  }
  const wl = await optional(api("/v1/watchlists"));
  const lists = wl.data?.data?.items ?? [];
  const l = lists.find((x) => x.home) ?? lists[0];
  return [...new Set((l?.symbols ?? []).map(tickerOf))].slice(0, 50);
}

export async function renderNewsPage() {
  const p = prefs();
  const st = { kind: p.newsKind ?? "all", follow: p.newsFollow ?? "all", days: 2, q: "", items: [], symbols: [], meta: null };
  const kindSeg = segmented("Kind", [["all", "All"], ["market", "News"], ["filing", "Filings"], ["regulator", "Regulators"]], st.kind);
  const followSeg = segmented("Symbols", [["all", "Everything"], ["watchlist", "My watchlist"], ["held", "What I hold"]], st.follow);
  const daysSel = h("select", { "aria-label": "Days", class: "pm-sel" }, [[1, "Today and yesterday"], [2, "2 days"], [7, "7 days"], [14, "14 days"]].map(([d, l]) => h("option", { value: String(d), selected: d === st.days }, l)));
  const search = h("input", { type: "search", class: "pm-search", placeholder: "Search headlines", "aria-label": "Search headlines", autocomplete: "off" });
  const status = h("span", { class: "muted small pm-status", "aria-live": "polite" });
  const host = h("div", { class: "pm-news-host" }, loadingState({ rows: 10, cols: 2, label: "Reading feeds" }));
  async function load() {
    st.symbols = st.follow === "all" ? await followed("watchlist") : await followed(st.follow);
    const qs = new URLSearchParams({ days: String(st.days) });
    if (st.symbols.length) qs.set("symbols", st.symbols.join(","));
    const r = await optional(api(`/v1/analytics/news/headlines?${qs}`));
    if (r.error) return fill(host, errorState(r.error, { onRetry: load }));
    st.items = r.data.data.items ?? [];
    st.meta = r.data.meta ?? {};
    draw();
  }
  function draw() {
    const want = st.follow === "all" ? null : st.symbols;
    let items = filterHeadlines(st.items, { kind: st.kind, symbols: want });
    const q = search.value.trim().toLowerCase();
    if (q) items = items.filter((i) => q.split(/\s+/).every((w) => String(i.title).toLowerCase().includes(w)));
    const failed = st.meta?.failedFeeds ?? [];
    status.textContent = `${formatInt(items.length)} headlines${failed.length ? ` · not answering: ${failed.join(", ")}` : ""}${st.meta?.stale ? " · some feeds from cache" : ""}`;
    if (st.follow !== "all" && !st.symbols.length) return fill(host, emptyState("list", st.follow === "held" ? "Nothing held" : "No watchlist", st.follow === "held" ? "No open positions or holdings were found on your accounts." : "Make a watchlist under Screeners › Watchlists and its symbols filter the headlines here."));
    if (!items.length) return fill(host, emptyState("inbox", "No headlines", "Nothing matches these filters in the chosen days."));
    const now = Date.now();
    fill(host, groupHeadlines(items, now).map((g) => h("section", { class: "pm-news-day" }, h("h3", { class: "pm-day-h" }, g.label, h("small", {}, formatInt(g.items.length))), headlineList(g.items, { now }))));
  }
  kindSeg.addEventListener("change", () => {
    st.kind = kindSeg.value;
    savePrefs({ newsKind: st.kind });
    draw();
  });
  followSeg.addEventListener("change", () => {
    st.follow = followSeg.value;
    savePrefs({ newsFollow: st.follow });
    load();
  });
  daysSel.addEventListener("change", () => {
    st.days = Number(daysSel.value);
    load();
  });
  search.addEventListener("input", draw);
  load();
  every(5 * 60_000, load);
  const bar0 = h("div", { class: "pm-toolbar" }, kindSeg, followSeg, daysSel, search, status);
  return [bar0, host, h("p", { class: "muted small pm-foot" }, "Headlines and links from the public markets feeds of The Economic Times, Business Standard and Mint, NSE filings and SEBI / RBI. Each article opens on its publisher's site. Feeds are third-party text and not advice.")];
}

// ── Depth ladder ──

/** Cumulative depth as an SVG area: bids rising to the left of mid, asks to the right. */
function depthCurve(profile) {
  const W = 600;
  const H = 140;
  const bids = (profile?.bids ?? []).filter((l) => isFigure(l.price));
  const asks = (profile?.asks ?? []).filter((l) => isFigure(l.price));
  if (!bids.length && !asks.length) return null;
  const lo = Math.min(...bids.map((l) => l.price), ...asks.map((l) => l.price));
  const hi = Math.max(...bids.map((l) => l.price), ...asks.map((l) => l.price));
  const maxCum = Math.max(1, bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0);
  const x = (v) => (hi - lo < 1e-9 ? W / 2 : ((v - lo) / (hi - lo)) * W);
  const y = (c) => H - 4 - (c / maxCum) * (H - 12);
  const path = (list) => {
    if (!list.length) return "";
    let d = `M${formatFixed(x(list[0].price), 1)},${H} `;
    for (const l of list) d += `L${formatFixed(x(l.price), 1)},${formatFixed(y(l.cum), 1)} `;
    return `${d}L${formatFixed(x(list.at(-1).price), 1)},${H} Z`;
  };
  return svgEl(
    "svg",
    { class: "pm-curve", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `Cumulative depth: ${formatCompact(bids.at(-1)?.cum ?? 0)} on the bid side, ${formatCompact(asks.at(-1)?.cum ?? 0)} on the ask side` },
    svgEl("path", { class: "pm-curve-bid", d: path(bids) }),
    svgEl("path", { class: "pm-curve-ask", d: path(asks) }),
    isFigure(profile.mid) ? svgEl("line", { class: "pm-curve-mid", x1: x(profile.mid), x2: x(profile.mid), y1: 0, y2: H }) : null,
  );
}

/** The ladder table: bid quantity | price | ask quantity, with cumulative heat and large levels marked. */
function ladderTable(profile, rowsPerSide) {
  const rows = ladderRows(profile, { rows: rowsPerSide });
  const qtyCell = (r, side) => {
    if (r.side !== side) return h("td", { class: `pm-q ${side} empty` });
    const heat = h("i", { class: "pm-heat" });
    heat.style.width = `${formatFixed(r.heat * 100, 1)}%`;
    const b = h("i", { class: "pm-lvl" });
    b.style.width = `${formatFixed(r.bar * 100, 1)}%`;
    return h("td", { class: `pm-q ${side}${r.large ? " large" : ""}`, title: `${formatInt(r.qty)} at ${price(r.price)}${r.orders ? ` in ${formatInt(r.orders)} orders` : ""} · ${formatInt(r.cum)} to here` }, heat, b, h("span", { class: "pm-qv" }, formatInt(r.qty)), r.orders ? h("small", {}, formatInt(r.orders)) : null);
  };
  return h(
    "table",
    { class: "pm-ladder" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "num" }, "Bid qty"), h("th", { scope: "col", class: "num" }, "Price"), h("th", { scope: "col", class: "num" }, "Ask qty"))),
    h(
      "tbody",
      {},
      rows.map((r, i) => {
        const touch = (r.side === "ask" && rows[i + 1]?.side === "bid") || (r.side === "bid" && i > 0 && rows[i - 1]?.side === "ask");
        return h("tr", { class: `${r.side}${touch ? " touch" : ""}${r.large ? " large" : ""}` }, qtyCell(r, "bid"), h("td", { class: "num pm-px" }, price(r.price), r.large ? h("span", { class: "pm-large" }, "Large") : null), qtyCell(r, "ask"));
      }),
    ),
  );
}

export async function renderDepthPage() {
  const p = prefs();
  const fromHash = new URLSearchParams(location.hash.split("?")[1] ?? "").get("symbol");
  const st = { symbol: (fromHash || p.depthSymbol || "NSE:RELIANCE").toUpperCase(), levels: DEPTH_LEVELS.some(([l]) => l === p.depthLevels) ? p.depthLevels : 20, rows: 20, profile: null, at: 0, busy: false };
  if (!st.symbol.includes(":")) st.symbol = `NSE:${st.symbol}`;
  const symIn = h("input", { type: "text", class: "pm-custom", value: st.symbol, "aria-label": "Symbol", placeholder: "NSE:RELIANCE", autocomplete: "off", spellcheck: "false" });
  const goBtn = h("button", { type: "button", class: "small rect" }, "Show");
  const lvlSeg = segmented("Levels", DEPTH_LEVELS.map(([l, t]) => [String(l), t]), String(st.levels));
  const rowsSel = h("select", { "aria-label": "Rows each side", class: "pm-sel" }, [10, 20, 50, 200].map((n) => h("option", { value: String(n), selected: n === st.rows }, `${n} rows each side`)));
  const status = h("span", { class: "muted small pm-status", "aria-live": "polite" });
  const stats = h("div", { class: "pm-depth-stats" });
  const meter = h("div", { class: "pm-imb" });
  const curveHost = h("div", { class: "pm-curve-host" });
  const ladderHost = h("div", { class: "pm-ladder-host" }, loadingState({ rows: 12, cols: 3, label: "Reading depth" }));
  const wallsHost = h("div", { class: "pm-walls" });
  const note = h("p", { class: "muted small pm-depth-note", hidden: true });
  const acts = h("div", { class: "row pm-depth-acts" });

  async function load() {
    if (st.busy) return;
    st.busy = true;
    try {
      const r = await optional(api(`/v1/analytics/depth-profile?symbol=${enc(st.symbol)}&levels=${st.levels}`, { fresh: true }));
      if (!ladderHost.isConnected && st.at) return;
      if (r.error) {
        fill(ladderHost, errorState(r.error, { onRetry: load }));
        fill(stats);
        fill(meter);
        fill(curveHost);
        fill(wallsHost);
        return;
      }
      st.profile = r.data.data;
      st.at = Date.now();
      draw(r.data.meta);
    } finally {
      st.busy = false;
    }
  }
  function draw(meta) {
    const pr = st.profile;
    const m = imbalanceMeter(pr.imbalance);
    const top = imbalanceMeter(pr.imbalanceTop5);
    // Bid side in the loss colour, ask side in the gain colour (the house rule for the ladder).
    const stat = (label, value, sub, side = "") => h("div", { class: `pm-stat ${side}`.trim() }, h("span", { class: "pm-stat-l" }, label), h("strong", {}, value), sub ? h("small", {}, sub) : null);
    fill(
      stats,
      stat("Top bid", price(pr.bestBid), `${formatInt(pr.bids?.[0]?.qty)} qty`, "bid"),
      stat("Top ask", price(pr.bestAsk), `${formatInt(pr.asks?.[0]?.qty)} qty`, "ask"),
      stat("Spread", isFigure(pr.spread) ? formatFixed(pr.spread, 2) : DASH, isFigure(pr.spreadBps) ? `${formatFixed(pr.spreadBps, 1)} bps of mid` : ""),
      stat("Microprice", price(pr.microprice), "Touch prices weighted by size"),
      stat("Bid total", formatCompact(pr.totals?.bidQty), pr.totals?.bidOrders ? `${formatInt(pr.totals.bidOrders)} orders` : "", "bid"),
      stat("Ask total", formatCompact(pr.totals?.askQty), pr.totals?.askOrders ? `${formatInt(pr.totals.askOrders)} orders` : "", "ask"),
    );
    const fillBid = h("i", { class: "pm-imb-bid" });
    fillBid.style.width = `${formatFixed(m.bidShare * 100, 1)}%`;
    const fillTop = h("i", { class: "pm-imb-bid" });
    fillTop.style.width = `${formatFixed(top.bidShare * 100, 1)}%`;
    fill(
      meter,
      h("div", { class: "pm-imb-row" }, h("span", { class: "pm-imb-l" }, `Whole book (${formatInt(Math.max(pr.levels?.bids ?? 0, pr.levels?.asks ?? 0))} levels)`), h("span", { class: "pm-imb-track", role: "img", "aria-label": m.text }, fillBid), h("span", { class: `pm-imb-t ${m.tone}` }, m.text)),
      h("div", { class: "pm-imb-row" }, h("span", { class: "pm-imb-l" }, "Top 5 levels"), h("span", { class: "pm-imb-track", role: "img", "aria-label": top.text }, fillTop), h("span", { class: `pm-imb-t ${top.tone}` }, top.text)),
    );
    fill(curveHost, depthCurve(pr));
    fill(ladderHost, ladderTable(pr, st.rows));
    const wall = (w, side) => h("li", { class: side }, h("span", {}, price(w.price)), h("strong", {}, formatInt(w.qty)), h("small", {}, `level ${formatInt(w.level)} · ${isFigure(w.distanceBps) ? `${formatFixed(Math.abs(w.distanceBps), 0)} bps from mid` : DASH}`));
    fill(wallsHost, h("div", {}, h("h4", { class: "pm-mini-h" }, "Largest bid levels"), h("ul", {}, (pr.walls?.bids ?? []).map((w) => wall(w, "bid")))), h("div", {}, h("h4", { class: "pm-mini-h" }, "Largest ask levels"), h("ul", {}, (pr.walls?.asks ?? []).map((w) => wall(w, "ask")))));
    const n = depthNote(pr, st.levels);
    note.hidden = !n;
    note.textContent = n;
    const f = meta?.freshness;
    status.textContent = `${f?.broker ? `${f.broker} · ` : ""}${f?.stale ? "older answer · " : ""}refreshes every 2 s while open · large = ${formatInt(pr.largeMultiple)}× the median level`;
  }
  function apply() {
    let s = symIn.value.trim().toUpperCase();
    if (!s) return;
    if (!s.includes(":")) s = `NSE:${s}`;
    st.symbol = s;
    symIn.value = s;
    savePrefs({ depthSymbol: s });
    history.replaceState(null, "", `#/screeners/depth?symbol=${enc(s)}`);
    drawActs();
    fill(ladderHost, loadingState({ rows: 12, cols: 3, label: "Reading depth" }));
    load();
  }
  function drawActs() {
    const under = chainUnderlying(st.symbol);
    fill(
      acts,
      h("button", { type: "button", class: "small", onclick: () => openSymbolSheet(st.symbol) }, icon("info"), "Readouts"),
      h("button", { type: "button", class: "small", onclick: () => openChart(st.symbol) }, icon("chart"), "Chart"),
      under ? h("button", { type: "button", class: "small", onclick: () => toChain(under) }, icon("list"), "Option chain") : null,
    );
  }
  goBtn.addEventListener("click", apply);
  symIn.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), apply()));
  lvlSeg.addEventListener("change", () => {
    st.levels = Number(lvlSeg.value);
    if (st.rows > st.levels) st.rows = Math.min(st.levels, 200);
    rowsSel.value = String([10, 20, 50, 200].find((n) => n >= st.rows) ?? 20);
    savePrefs({ depthLevels: st.levels });
    load();
  });
  rowsSel.addEventListener("change", () => {
    st.rows = Number(rowsSel.value);
    if (st.profile) draw();
  });
  drawActs();
  load();
  every(2000, load);
  const bar0 = h("div", { class: "pm-toolbar" }, h("div", { class: "pm-custom-row" }, symIn, goBtn), lvlSeg, rowsSel, acts, status);
  const left = card({ title: "Ladder", glyph: "bars", tint: "indigo", cls: "pm-depth-ladder", body: h("div", {}, note, ladderHost) });
  const right = h(
    "div",
    { class: "pm-depth-side" },
    card({ title: "Book", glyph: "scale", tint: "teal", body: h("div", {}, stats) }),
    card({ title: "Imbalance", glyph: "activity", tint: "purple", body: meter }),
    card({ title: "Cumulative depth", glyph: "wave", tint: "blue", body: curveHost }),
    card({ title: "Largest levels", glyph: "bars", tint: "orange", body: wallsHost }),
  );
  return [bar0, h("div", { class: "pm-depth" }, left, right), h("p", { class: "muted small pm-foot" }, "Depth from the connected broker: 5 levels from most quote APIs, 20 or 200 where the broker has a full-depth feed. Quantities as the exchange shows them.")];
}

// ── Home cards ──

/** Home: top gainers or losers of NIFTY 50 (or F&O stocks), with bars. Refreshes itself every 30 s while shown. */
export function moversCard() {
  let by = prefs().homeMovers === "losers" ? "losers" : "gainers";
  const seg = segmented("Movers", [["gainers", "Gainers"], ["losers", "Losers"]], by);
  const body = h("div", { class: "pm-home-movers" }, loadingState({ rows: 6, cols: 3, label: "Reading quotes" }));
  const ad = h("div", { class: "pm-home-ad" });
  const el = card({ glyph: "activity", tint: "green", title: "Market movers", sub: "NIFTY 50, from one quote pass", cls: "ck-card ck-a-mv", actions: h("a", { class: "lk small", href: "#/screeners/movers" }, "All movers"), body: h("div", {}, seg, ad, body) });
  let last = 0;
  async function refresh(force = false) {
    if (!force && Date.now() - last < 30_000) return;
    last = Date.now();
    const r = await optional(api(`/v1/analytics/markets/movers?universe=NIFTY50&by=${by}&limit=6`));
    if (r.error) return fill(body, h("p", { class: "muted small" }, r.error.message));
    fill(ad, breadthStrip(r.data.data.summary));
    fill(body, moverList(r.data.data.items, by, { compact: true }));
  }
  seg.addEventListener("change", () => {
    by = seg.value;
    savePrefs({ homeMovers: by });
    refresh(true);
  });
  refresh(true);
  return { el, refresh: () => refresh(false) };
}

/** Home: the latest headlines, tagged with the Home watchlist's symbols. Refreshes every 5 minutes while shown. */
export function headlinesCard() {
  const body = h("div", { class: "pm-home-news" }, loadingState({ rows: 6, cols: 2, label: "Reading feeds" }));
  const el = card({ glyph: "inbox", tint: "orange", title: "Headlines", sub: "Market news, filings and regulators", cls: "ck-card ck-a-nw", actions: h("a", { class: "lk small", href: "#/flow/news" }, "All headlines"), body });
  let last = 0;
  async function refresh(force = false) {
    if (!force && Date.now() - last < 5 * 60_000) return;
    last = Date.now();
    const syms = await followed("watchlist");
    const r = await optional(api(`/v1/analytics/news/headlines?days=2${syms.length ? `&symbols=${syms.map(enc).join(",")}` : ""}`));
    if (r.error) return fill(body, h("p", { class: "muted small" }, r.error.message));
    const items = r.data.data.items ?? [];
    // Rows that name a followed symbol first, then the rest, newest first within each.
    const mine = items.filter((i) => i.symbols?.some((s) => syms.includes(s)));
    const rest = items.filter((i) => !mine.includes(i));
    const show = [...mine, ...rest].slice(0, 7);
    fill(body, show.length ? headlineList(show, { compact: true }) : emptyState("inbox", "No headlines", "The feeds have nothing in the last two days.", null, { compact: true }));
  }
  refresh(true);
  return { el, refresh: () => refresh(false) };
}
