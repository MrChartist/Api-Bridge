// Symbol search: the Options desk's quick switcher. On the chain, OI, Volatility, Strategy, Positions and Arbitrage
// pages, "/" or a letter that is not one of the page's own keys opens it, filled in with that letter (desk.js
// bindKeys); so does the underlying's name in the toolbar. It paints at once from what it already has (the desk's
// indices, the F&O stocks read earlier this session, the recent picks), then reads the stock list and the prices of
// the rows on screen (one /v1/quotes call, kept 5 s). Picking a row switches the desk's underlying the way the
// toolbar's select does. Numbers are formatted by format.js only.
import { api, app, h, icon, keyHint, optional } from "./app.js";
import { DASH, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";

/** The last picks, newest first (localStorage; a blocked store just means no Recent tab). */
export const RECENT_SLOT = "mcb.dashboard.symbolRecent";
export const RECENT_MAX = 10;
/** A quote younger than this is not read again. */
const QUOTE_TTL_MS = 5000;
/** Rows drawn per list (a query narrows it). */
const SHOW_MAX = 60;
/** The rows' fixed height (px, app.css .sym-row): which rows are on screen, for their prices. */
const ROW_H = 52;
const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;

/**
 * Items matching a query, best first: the exact symbol, then symbols that start with it, then any that contain it;
 * within a tier indices before stocks, the earlier match, the shorter symbol, then A-Z. An empty query keeps the
 * order given (the desk's own index order). Pure. `items`: [{ symbol, kind: "index" | "stock" }].
 */
export function rankSymbols(items, query) {
  const list = Array.isArray(items) ? items : [];
  const q = String(query ?? "").trim().toUpperCase();
  if (!q) return [...list];
  const scored = [];
  for (const it of list) {
    const s = String(it?.symbol ?? "").toUpperCase();
    const at = s.indexOf(q);
    if (at < 0) continue;
    scored.push({ it, s, at, tier: s === q ? 0 : at === 0 ? 1 : 2 });
  }
  scored.sort((a, b) => a.tier - b.tier || (a.it.kind === b.it.kind ? 0 : a.it.kind === "index" ? -1 : 1) || a.at - b.at || a.s.length - b.s.length || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  return scored.map((x) => x.it);
}

/** A symbol cut around the query's first match: [[text, matched]] (no empty parts). Pure. */
export function highlightParts(text, query) {
  const t = String(text ?? "");
  const q = String(query ?? "").trim();
  const at = q ? t.toUpperCase().indexOf(q.toUpperCase()) : -1;
  if (at < 0) return t ? [[t, false]] : [];
  return [[t.slice(0, at), false], [t.slice(at, at + q.length), true], [t.slice(at + q.length), false]].filter(([s]) => s);
}

/** The recent list after a pick: the symbol first, once, at most `max`. Pure. */
export function pushRecent(list, symbol, max = RECENT_MAX) {
  const s = String(symbol ?? "").toUpperCase();
  const rest = (Array.isArray(list) ? list : []).filter((x) => x !== s);
  return SYMBOL_RE.test(s) ? [s, ...rest].slice(0, max) : rest.slice(0, max);
}

/** The saved recent picks (symbols only; anything else in the slot is dropped). */
export function readRecent(store = app.local) {
  try {
    const v = JSON.parse(store.get(RECENT_SLOT) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && SYMBOL_RE.test(x)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function writeRecent(list, store = app.local) {
  try {
    store.set(RECENT_SLOT, JSON.stringify(list));
  } catch {
    // No Recent tab next time.
  }
}

// ── The F&O stock list (once a day per tab) and quotes (5 s) ──
let stocks = null;
let stocksDay = "";
let stocksLoading = null;
/** True when the universe is not recorded: stocks are then found by a search per query (futures' underlyings). */
let stocksFallback = false;
const quotes = new Map();
const pending = new Set();
/** Today in IST (YYYY-MM-DD): the universe is per trading day. */
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
function loadStocks() {
  const day = istToday();
  if (stocks && stocksDay === day) return Promise.resolve(stocks);
  if (stocksLoading) return stocksLoading;
  stocksLoading = optional(api(`/v1/reference/fno-universe?date=${day}&kind=all`)).then((r) => {
    stocksLoading = null;
    const d = r.data?.data;
    const items = (d?.items ?? []).filter((i) => i?.kind === "stock" && SYMBOL_RE.test(String(i.symbol ?? "")));
    stocksFallback = Boolean(r.error) || d?.available === false || d?.coverage === "not-recorded" || !items.length;
    stocks = items.map((i) => i.symbol);
    stocksDay = day;
    return stocks;
  });
  return stocksLoading;
}

/**
 * Open the search. `initial`: the text to start with (the letter typed); `current`: the desk's underlying (✓);
 * `indices`: the desk's index list; `quoteSymbol(u)` / `exchangeOf(u)`: how to quote and label one; `strike(text)`:
 * the chain only, the strike a query names (or null), shown as a row of its own; `onStrike(k)`, `onPick(u)`.
 */
export function openSymbolSearch({ initial = "", current = "", indices = [], quoteSymbol, exchangeOf, strike = null, onStrike = () => {}, onPick = () => {} }) {
  if (document.querySelector(".sym-search")) return null;
  const back = document.activeElement;
  const idx = new Set(indices);
  const recent = readRecent();
  /** Stocks the per-query search found (when the universe is not recorded). */
  const found = new Set();
  let tab = "all";
  let active = 0;
  /** What the list shows now: [{ type: "strike", k } | { type: "sym", symbol, kind }] */
  let rows = [];

  const input = h("input", { type: "search", class: "sym-input", autocomplete: "off", spellcheck: "false", enterkeyhint: "go", role: "combobox", "aria-expanded": "true", "aria-controls": "sym-list", "aria-autocomplete": "list", "aria-label": strike ? "Search symbols or a strike" : "Search symbols", placeholder: strike ? "Symbol, or a strike (26400, +3, atm)" : "Symbol" });
  input.value = initial;
  const clear = h("button", { type: "button", class: "small plain sym-clear", onclick: () => ((input.value = ""), input.focus(), draw()) }, "Clear");
  const close = h("button", { type: "button", class: "icon-btn tiny sym-close", "aria-label": "Close the search", onclick: () => done() }, icon("close"));
  const TABS = [["all", "All"], ["index", "Index"], ["stock", "Stocks"], ["recent", "Recent"]];
  const tabBtns = TABS.map(([id, label]) => h("button", { type: "button", role: "tab", "data-tab": id, "aria-selected": String(id === tab), tabindex: id === tab ? "0" : "-1", onclick: () => pickTab(id) }, label, h("span", { class: "sym-n" }, "")));
  const tabs = h("div", { class: "sym-tabs", role: "tablist", "aria-label": "Show" }, tabBtns);
  const list = h("div", { class: "sym-list", id: "sym-list", role: "listbox", "aria-label": "Symbols" });
  const hint = keyHint("↑ ↓ to move · ↵ to open · Esc to close");
  const box = h(
    "div",
    { class: "sym-box", role: "dialog", "aria-modal": "true", "aria-label": "Search symbols" },
    h("div", { class: "sym-field" }, icon("search"), input, clear, close),
    tabs,
    list,
    hint ? h("p", { class: "sym-hint" }, hint) : null,
  );
  const veil = h("div", { class: "sym-search" }, box);
  veil.addEventListener("pointerdown", (e) => e.target === veil && done());

  const kindOf = (s) => (idx.has(s) ? "index" : "stock");
  function pool(which) {
    const st = [...new Set([...(stocks ?? []), ...found, ...(current && !idx.has(current) ? [current] : [])])].filter((s) => !idx.has(s)).sort();
    const index = indices.map((s) => ({ symbol: s, kind: "index" }));
    const stock = st.map((s) => ({ symbol: s, kind: "stock" }));
    if (which === "index") return index;
    if (which === "stock") return stock;
    if (which === "recent") return recent.map((s) => ({ symbol: s, kind: kindOf(s) }));
    return [...index, ...stock];
  }
  function draw() {
    const q = input.value.trim();
    clear.hidden = !q;
    for (const b of tabBtns) b.lastChild.textContent = String(rankSymbols(pool(b.dataset.tab), q).length);
    const k = strike && q ? strike(q) : null;
    rows = [...(k !== null && k !== undefined ? [{ type: "strike", k }] : []), ...rankSymbols(pool(tab), q).slice(0, SHOW_MAX).map((it) => ({ type: "sym", ...it }))];
    active = Math.min(active, Math.max(0, rows.length - 1));
    list.replaceChildren(
      ...(rows.length
        ? rows.map((r, i) => (r.type === "strike" ? strikeRow(r.k, i) : symRow(r, q, i)))
        : [h("p", { class: "sym-empty" }, q ? (stocksLoading && tab !== "index" ? "Looking…" : `No symbol matches “${q}”`) : tab === "recent" ? "Symbols you pick show here" : "No symbols")]),
    );
    paintActive();
    prices();
    if (q && stocksFallback && tab !== "index" && tab !== "recent") searchStocks(q);
  }
  function strikeRow(k, i) {
    return h("div", { class: "sym-row sym-strike", role: "option", id: `sym-opt-${i}`, "data-i": i }, h("span", { class: "sym-l" }, h("span", { class: "sym-name" }, "Go to strike ", h("b", {}, formatInt(k))), h("small", {}, "In this chain")), h("span", { class: "sym-r" }, icon("chevron")));
  }
  function symRow(r, q, i) {
    const on = r.symbol === current;
    return h(
      "div",
      { class: `sym-row${on ? " cur" : ""}`, role: "option", id: `sym-opt-${i}`, "data-i": i, "data-sym": r.symbol },
      h("span", { class: "sym-l" }, h("span", { class: "sym-name" }, highlightParts(r.symbol, q).map(([t, m]) => (m ? h("b", {}, t) : t))), h("small", {}, `${exchangeOf(r.symbol)}${r.kind === "index" ? " · Index" : ""}`)),
      h("span", { class: "sym-r" }, h("span", { class: "sym-px" }, h("span", { class: "sym-ltp" }, ""), h("small", { class: "sym-chg" }, "")), h("span", { class: "sym-tick", "aria-hidden": "true" }, on ? icon("check") : null)),
    );
  }
  /** The row the keyboard is on: aria-selected for screen readers, .act for its fill. */
  function markActive(el) {
    if (!el.dataset?.i) return;
    const on = Number(el.dataset.i) === active;
    el.setAttribute("aria-selected", String(on));
    el.classList.toggle("act", on);
  }
  function paintActive() {
    for (const el of list.children) markActive(el);
    const cur = list.querySelector(`#sym-opt-${active}`);
    if (cur) {
      input.setAttribute("aria-activedescendant", cur.id);
      cur.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  /** Prices for the rows on screen: cached ones at once, the rest in one call. */
  function prices() {
    const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 1);
    const n = Math.ceil((list.clientHeight || ROW_H * 8) / ROW_H) + 2;
    const syms = rows.slice(first, first + n).filter((r) => r.type === "sym").map((r) => r.symbol);
    const now = Date.now();
    const want = [];
    for (const s of syms) {
      const qs = quoteSymbol(s);
      const c = quotes.get(qs);
      paintPrice(s, c?.q);
      if ((!c || now - c.at > QUOTE_TTL_MS) && !pending.has(qs)) want.push(qs);
    }
    if (!want.length) return;
    for (const s of want) pending.add(s);
    optional(api(`/v1/quotes?symbols=${encodeURIComponent(want.join(","))}`)).then((r) => {
      for (const s of want) pending.delete(s);
      const at = Date.now();
      for (const q of r.data?.data ?? []) if (q?.symbol) quotes.set(q.symbol, { q, at });
      // A symbol with no answer is not asked again for 5 s either.
      for (const s of want) if (!quotes.has(s)) quotes.set(s, { q: null, at });
      if (veil.isConnected) for (const s of syms) paintPrice(s, quotes.get(quoteSymbol(s))?.q);
    });
  }
  function paintPrice(sym, q) {
    const row = list.querySelector(`[data-sym="${sym}"]`);
    if (!row) return;
    const ltp = isFigure(q?.ltp) ? Number(q.ltp) : null;
    const ch = isFigure(q?.change) ? Number(q.change) : null;
    const chp = isFigure(q?.changePct) ? Number(q.changePct) : null;
    row.querySelector(".sym-ltp").textContent = ltp === null ? (q === undefined ? "" : DASH) : formatFixed(ltp, 2);
    const chg = row.querySelector(".sym-chg");
    chg.textContent = ch === null ? "" : `${formatSigned(ch, 2)}${chp === null ? "" : ` (${formatSigned(chp, 2)}%)`}`;
    chg.className = `sym-chg${ch > 0 ? " up" : ch < 0 ? " down" : ""}`;
  }
  /** No recorded universe: the futures' underlyings matching the query are the F&O stocks (one search per pause). */
  let searchTimer = 0;
  let searched = "";
  function searchStocks(q) {
    clearTimeout(searchTimer);
    if (q.length < 2 || q === searched) return;
    searchTimer = setTimeout(() => {
      searched = q;
      optional(api(`/v1/instruments/search?q=${encodeURIComponent(q)}&kind=FUT&limit=50`)).then((r) => {
        let added = false;
        for (const f of r.data?.data ?? []) {
          const u = String(f?.underlying ?? "").toUpperCase();
          if (SYMBOL_RE.test(u) && !idx.has(u) && !found.has(u)) {
            found.add(u);
            added = true;
          }
        }
        if (added && veil.isConnected) draw();
      });
    }, 200);
  }
  function pickTab(id) {
    tab = id;
    active = 0;
    for (const b of tabBtns) {
      const on = b.dataset.tab === id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    draw();
    input.focus();
  }
  function choose(i) {
    const r = rows[i];
    if (!r) return;
    done(false);
    if (r.type === "strike") return onStrike(r.k);
    writeRecent(pushRecent(readRecent(), r.symbol));
    onPick(r.symbol);
  }
  function done(restore = true) {
    if (!veil.isConnected) return;
    veil.remove();
    document.removeEventListener("keydown", onDocKey, true);
    removeEventListener("hashchange", onHash);
    if (restore && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  }
  const onHash = () => done(false);
  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      paintActive();
      prices();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  });
  tabs.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = TABS.findIndex(([id]) => id === tab);
    pickTab(TABS[(i + d + TABS.length) % TABS.length][0]);
    tabBtns.find((b) => b.dataset.tab === tab)?.focus();
  });
  list.addEventListener("click", (e) => {
    const row = e.target.closest?.(".sym-row");
    if (row) choose(Number(row.dataset.i));
  });
  list.addEventListener("pointermove", (e) => {
    const row = e.target.closest?.(".sym-row");
    const i = row ? Number(row.dataset.i) : -1;
    if (i >= 0 && i !== active) {
      active = i;
      for (const el of list.children) markActive(el);
    }
  });
  let scrollTimer = 0;
  list.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(prices, 120);
  }, { passive: true });
  // Escape closes; Tab stays inside the box (the page under it is not reachable while it is open).
  function onDocKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      done();
    } else if (e.key === "Tab") {
      const f = [...box.querySelectorAll("input, button:not([hidden]), [tabindex='0']")].filter((x) => !x.disabled && x.offsetParent !== null);
      const i = f.indexOf(document.activeElement);
      if (!f.length) return;
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }
  document.addEventListener("keydown", onDocKey, true);
  addEventListener("hashchange", onHash);
  document.body.append(veil);
  input.focus();
  // Caret after the typed letter (not selected: the next key adds to it).
  input.setSelectionRange(input.value.length, input.value.length);
  draw();
  // The stock list, after the first paint.
  if (!stocks || stocksDay !== istToday()) loadStocks().then(() => veil.isConnected && draw());
  return { close: () => done() };
}
