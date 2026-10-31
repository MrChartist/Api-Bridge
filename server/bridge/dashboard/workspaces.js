// workspaces.js: the trading workspaces (Trade › Workspaces). Scalper: the index with its ATM call and put, each chart
// with Buy and Sell, a strike picker on the option charts and a layout switcher (Ctrl+Alt+L). Options Trader: a compact
// chain beside the call and put charts of the strike picked in it. Market Watch: up to six charts, each with its own
// symbol and interval, changed in place and kept per browser. Shift+1 to Shift+6 switch workspace (views.js binds them
// app-wide from workspaces-core.js).
//
// Charts are the shared engine's slots (app.js chartSlot); prices stream over the one live connection (live.js) and
// patch text nodes and the last candle in place. Buy and Sell never place anything: they open the Option Chain's own
// order ticket filled in (the palette's typed-trade handoff), on the paper account when there is one, so every order
// passes the ticket's checks and the Bridge's safety gates as before. Numbers go through format.js only.
import { api, app, chartSlot, emptyState, errorState, h, icon, keyHint, optional, sheetPopover, toast } from "./app.js";
import { DASH, formatFixed, formatSigned } from "./format.js";
import * as live from "./live.js";
import { openSymbolSearch } from "./symbol-search.js";
import { intentHandoff } from "./trade-intent.js";
import { segmented } from "./views.js";
import {
  INDEX_SYMBOLS,
  INTERVALS,
  WATCH_COUNTS,
  WATCH_DEFAULT,
  WATCH_DEMO_DEFAULT,
  WORKSPACES,
  applyTick,
  atmOf,
  chainStrikes,
  changeOf,
  changeText,
  contractLabel,
  historyPath,
  intervalOf,
  isLayoutKey,
  layoutText,
  legOf,
  nextScalperLayout,
  quoteSymbolOf,
  readWatch,
  scalperLayout,
  scalperPanes,
  setTile,
  stepStrike,
  strikeWindow,
  tileSpec,
  tradeLeg,
  watchGrid,
  workspaceKeyLabel,
} from "./workspaces-core.js";

const SLOT = { scalper: "mcb.dashboard.ws.scalper", trader: "mcb.dashboard.ws.trader", watch: "mcb.dashboard.ws.watch" };
const DESK_SLOT = "mcb.dashboard.desk";
const HANDOFF_SLOT = "mcb.dashboard.tradeHandoff";
/** The chain is read again this often (strike list, ATM and the legs' closes); prices stream in between. */
const CHAIN_REFRESH_MS = 30_000;
/** The live last candle redraws at most this often per chart. */
const CANDLE_GAP_MS = 1000;

const readJson = (key) => {
  try {
    return JSON.parse(app.local.get(key) ?? "null");
  } catch {
    return null;
  }
};
const save = (key, v) => app.local.set(key, JSON.stringify(v));
const underlyings = () => (app.state.demo ? ["NIFTY", "BANKNIFTY", "SENSEX"] : Object.keys(INDEX_SYMBOLS));

// ───────────────────────── shared pieces ─────────────────────────

/** The paper account's id (read once a page), or null: Buy and Sell send the ticket there by default. */
let paperId;
async function paperAccount() {
  if (paperId !== undefined) return paperId;
  const r = await optional(api("/v1/accounts"));
  const list = r.data?.data?.data ?? [];
  paperId = list.find((a) => a.enabled && a.broker === "paper" && (a.capabilities ?? []).includes("placeOrder"))?.id ?? null;
  return paperId;
}

/**
 * Open the Option Chain's order ticket for one contract, filled in. Nothing is sent: the ticket shows the price,
 * margin and checks, and the person places it there. Paper by default (the paper account when one exists).
 */
async function openTicket(leg, expiry) {
  if (!leg || !expiry) return toast("No contract to trade yet: the chain has not loaded", { tone: "warn" });
  const desk = readJson(DESK_SLOT) ?? {};
  const go = intentHandoff(leg, { expiry, desk: typeof desk === "object" && !Array.isArray(desk) ? desk : {}, nowHash: location.hash });
  const paper = await paperAccount();
  const extra = paper ? { account: paper } : {};
  save(DESK_SLOT, { ...go.prefs, ...extra });
  save(HANDOFF_SLOT, { underlying: go.prefs.underlying, expiry: go.prefs.expiry, jump: go.prefs.jump, ticket: go.prefs.ticket, ...extra });
  location.hash = go.hash;
}

/** A capsule select (underlying, expiry, interval): a native select, so the keyboard and screen readers work as usual. */
function capsuleSelect(label, options, value, cls = "") {
  const sel = h("select", { class: `ws-select ${cls}`.trim(), "aria-label": label }, options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
  return sel;
}

/** A saved interval id, or 1-minute candles (the scalping default). */
const savedInterval = (v) => (INTERVALS.some((x) => x.id === v) ? v : "1m");
const intervalSelect = (label, value) => capsuleSelect(label, INTERVALS.map((x) => [x.id, x.label]), value, "ws-int");

/** The workspace switcher: a capsule that opens the six workspaces with their keys. */
function switcherButton(current) {
  const btn = h("button", { type: "button", class: "small ws-switch", "aria-haspopup": "dialog", title: "Switch workspace (Shift+1 to Shift+6)" }, icon("columns"), h("span", {}, "Workspaces"));
  btn.addEventListener("click", () => openSwitcher(btn, current));
  return btn;
}
/** The list of workspaces in a popover (also Shift+6 from anywhere). */
export function openSwitcher(trigger = null, current = null) {
  current ??= WORKSPACES.find((w) => w.route && location.hash.split("?")[0] === `#/${w.route}`)?.id ?? null;
  const rows = WORKSPACES.filter((w) => w.action !== "switcher").map((w) =>
    h(
      "li",
      {},
      h(
        "a",
        { href: `#/${w.route}`, class: "ws-sw-row", "aria-current": w.id === current ? "page" : undefined, onclick: () => pop?.close() },
        h("span", { class: "ws-sw-text" }, h("strong", {}, w.label), h("small", {}, w.sub)),
        keyHint(workspaceKeyLabel(w)) ? h("kbd", { class: "ws-sw-key" }, workspaceKeyLabel(w)) : null,
      ),
    ),
  );
  const pop = sheetPopover({ trigger: trigger ?? document.querySelector(".ws-switch") ?? document.getElementById("toolbar-label"), title: "Workspaces", cls: "ws-sw-pop", body: h("ul", { class: "ws-sw-list", role: "list" }, rows) });
  pop.el?.querySelector(".ws-sw-row")?.focus();
  return pop;
}

/** The price and change of a quote, patched in place (text and the direction class only). */
function priceBox() {
  const price = document.createTextNode(DASH);
  const chg = document.createTextNode("");
  const chgEl = h("span", { class: "ws-chg" }, chg);
  const el = h("span", { class: "ws-px", "aria-live": "off" }, h("strong", { class: "ws-ltp" }, price), chgEl);
  let sig = "";
  return {
    el,
    set(q) {
      const t = changeText(q);
      const s = `${t.price}|${t.change}|${t.dir}`;
      if (s === sig) return;
      sig = s;
      price.data = t.price;
      chg.data = t.change === DASH ? "" : t.change;
      chgEl.classList.toggle("up", t.dir === "up");
      chgEl.classList.toggle("down", t.dir === "down");
    },
  };
}

/** A quote with a tick laid over it; without its own change, the change is worked out from the close again. */
function overlay(base, tick) {
  if (!tick) return base;
  const q = { ...(base ?? {}), ...Object.fromEntries(Object.entries(tick).filter(([, v]) => v !== null && v !== undefined)) };
  if ((tick.change === null || tick.change === undefined) && q.close !== null && q.close !== undefined) {
    q.change = null;
    q.changePct = null;
  }
  return q;
}

/**
 * One chart tile: a head (name, strike picker, live price and change, Buy / Sell) over a chart slot. `show(symbol,
 * name, interval)` points it at a contract or symbol (a new slot, so its refresh follows the interval); `tick(q)`
 * patches the price and the last candle. Buy / Sell call `onTrade(side)`.
 */
function chartTile({ pane, id, trade = null, picker = null, extra = null, buyLabel = "Buy", sellLabel = "Sell" }) {
  const nameEl = h("strong", { class: "ws-name" }, DASH);
  const subEl = h("small", { class: "ws-sub" });
  const px = priceBox();
  const buy = trade ? h("button", { type: "button", class: "btn buy xs ws-buy", onclick: () => trade("BUY") }, buyLabel) : null;
  const sell = trade ? h("button", { type: "button", class: "btn sell xs ws-sell", onclick: () => trade("SELL") }, sellLabel) : null;
  const chartBox = h("div", { class: "ws-chart" });
  const el = h(
    "section",
    { class: "ws-tile", "data-pane": pane, "aria-label": pane },
    h("header", { class: "ws-tile-head" }, h("div", { class: "ws-id" }, h("div", { class: "ws-id-top" }, nameEl, picker), subEl), px.el, extra, trade ? h("div", { class: "ws-trade" }, buy, sell) : null),
    chartBox,
  );
  let slot = null;
  let symbol = null;
  let base = null;
  let spec = null;
  let candles = null;
  let ivMs = 0;
  let lastDraw = 0;
  let key = "";
  return {
    el,
    get symbol() {
      return symbol;
    },
    setTitle(name, sub = "") {
      if (nameEl.textContent !== name) nameEl.textContent = name;
      if (subEl.textContent !== sub) subEl.textContent = sub;
      el.setAttribute("aria-label", sub ? `${name}, ${sub}` : name);
    },
    setTradeLabel(text) {
      if (buy) buy.setAttribute("aria-label", `${buyLabel} ${text}`);
      if (sell) sell.setAttribute("aria-label", `${sellLabel} ${text}`);
    },
    setTradeEnabled(on, why = "") {
      for (const b of [buy, sell]) {
        if (!b) continue;
        b.disabled = !on;
        b.title = on ? "" : why;
      }
    },
    /** Point the chart at a symbol and interval; the same pair keeps the chart as it is. */
    show(sym, name, interval, quote = null) {
      if (quote) base = quote;
      px.set(base);
      const k = `${sym}|${interval}`;
      if (!sym || k === key) return;
      key = k;
      symbol = sym;
      spec = null;
      candles = null;
      const iv = intervalOf(interval);
      ivMs = iv.ms;
      slot?.chart.destroy();
      slot = chartSlot(`${name}, ${iv.label} candles`, {
        id: `ws-${id}`,
        refreshMs: iv.refreshMs,
        expand: true,
        load: async () => {
          const r = await api(historyPath(sym, iv.id));
          const s = tileSpec({ name, answer: r.data, interval: iv.id });
          spec = s.empty ? null : s;
          candles = spec ? spec.series[0].data : null;
          return s;
        },
      });
      chartBox.replaceChildren(slot ?? emptyState("chart", "Chart unavailable", "The chart engine did not load. Reload the page to try again.", null, { compact: true }));
    },
    /** A quote from a REST read (the chain's leg, the index quote): the base the stream's ticks lay over. */
    quote(q) {
      base = q;
      px.set(base);
    },
    tick(t, now) {
      const q = overlay(base, t);
      px.set(q);
      if (!spec || !candles || !slot || now - lastDraw < CANDLE_GAP_MS) return;
      const next = applyTick(candles, q.ltp, now, ivMs);
      if (next === candles) return;
      candles = next;
      lastDraw = now;
      spec = { ...spec, series: [{ ...spec.series[0], data: next }] };
      slot.chart.set(spec);
    },
    destroy() {
      slot?.chart.destroy();
    },
  };
}

/** The strike picker: ‹ strike › in one capsule (a native select between two steps). `onPick(k)` on a change. */
function strikePicker(label, onPick) {
  const sel = h("select", { class: "ws-strike-sel", "aria-label": `${label} strike` });
  const prev = h("button", { type: "button", class: "icon-btn tiny quiet ws-step", "aria-label": `${label}: strike below`, title: "Strike below" }, icon("minus"));
  const next = h("button", { type: "button", class: "icon-btn tiny quiet ws-step", "aria-label": `${label}: strike above`, title: "Strike above" }, icon("plus"));
  const el = h("span", { class: "ws-strike", role: "group", "aria-label": `${label} strike picker` }, prev, sel, next);
  let strikes = [];
  let atm = null;
  let value = null;
  let sig = "";
  sel.addEventListener("change", () => onPick(Number(sel.value)));
  prev.addEventListener("click", () => onPick(stepStrike(strikes, value, -1)));
  next.addEventListener("click", () => onPick(stepStrike(strikes, value, 1)));
  return {
    el,
    set(list, at, k) {
      strikes = list;
      atm = at;
      value = k;
      const win = strikeWindow(list, k ?? at, 15);
      const s = `${win.join()}|${atm}|${k}`;
      if (s === sig) return;
      sig = s;
      sel.replaceChildren(...win.map((x) => h("option", { value: String(x), selected: x === k }, x === atm ? `${x} · ATM` : String(x))));
      prev.disabled = !list.length || list[0] === k;
      next.disabled = !list.length || list[list.length - 1] === k;
    },
  };
}

/** A strip of the workspace's own controls (one row; wraps on a narrow screen). */
const wsBar = (...groups) => h("div", { class: "ws-bar", role: "toolbar", "aria-label": "Workspace controls" }, ...groups.flat().filter(Boolean));

/**
 * Keys that act on the workspace on screen while it is in the page; removed when it leaves. Ignored while typing or with
 * a dialog or popover open.
 */
function pageKeys(root, onKey) {
  const handler = (e) => {
    if (!root.isConnected) return document.removeEventListener("keydown", handler);
    if (e.defaultPrevented || e.isComposing || document.querySelector("dialog[open], .sym-search")) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    if (onKey(e)) e.preventDefault();
  };
  document.addEventListener("keydown", handler);
}

/** Expiries and the chain of an underlying (the strike list, ATM, lot size and each leg's last quote). */
async function loadExpiries(u) {
  const r = await api(`/v1/expiries?underlying=${encodeURIComponent(u)}`, { paintOld: true });
  return r.data?.data?.expiries ?? [];
}
const loadChain = async (u, expiry, strikes = 20) => (await api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(expiry)}&strikes=${strikes}&greeks=false`)).data?.data ?? null;
const loadQuote = async (sym) => (await optional(api(`/v1/quotes?symbols=${encodeURIComponent(sym)}`))).data?.data?.[0] ?? null;
const expiryLabel = (e, i) => `${e}${i === 0 ? " · nearest" : ""}`;

// ───────────────────────── Scalper ─────────────────────────

export async function renderScalperPage() {
  const saved = readJson(SLOT.scalper) ?? {};
  const list = underlyings();
  const st = { u: list.includes(saved.u) ? saved.u : list[0], iv: savedInterval(saved.iv), expiry: null, expiries: [], chain: null, layout: scalperLayout(saved), strike: { call: null, put: null }, pinned: { call: false, put: false } };
  const persist = () => save(SLOT.scalper, { u: st.u, iv: st.iv, view: st.layout.view, arrange: st.layout.arrange });

  const uSel = capsuleSelect("Underlying", list.map((u) => [u, u]), st.u);
  const eSel = capsuleSelect("Expiry", [["", "Expiry"]], "", "ws-exp");
  const ivSel = intervalSelect("Chart interval", st.iv);
  ivSel.addEventListener("change", () => {
    st.iv = ivSel.value;
    persist();
    tiles.index.show(indexSym(), st.u, st.iv);
    drawContracts();
  });
  const viewSeg = segmented("Charts shown", [["all", "All three"], ["index", "Index"], ["call", "Call"], ["put", "Put"]], st.layout.view);
  const arrSeg = segmented("Arrangement", [["row", "Side by side"], ["stack", "Stacked"]], st.layout.arrange);
  viewSeg.title = "Which charts to show (Ctrl+Alt+L steps through the layouts)";
  const status = h("p", { class: "ws-status", role: "status" });

  const trade = (pane) => (side) => {
    const right = pane === "call" ? "CE" : pane === "put" ? "PE" : undefined;
    const strike = pane === "index" ? atmOf(st.chain) : st.strike[pane];
    openTicket(tradeLeg({ underlying: st.u, strike, right, side, pane }), st.expiry);
  };
  const callPick = strikePicker("Call", (k) => pickStrike("call", k));
  const putPick = strikePicker("Put", (k) => pickStrike("put", k));
  const atmBtn = h("button", { type: "button", class: "small quiet ws-atm", title: "Both option charts back to the ATM strike", onclick: () => toAtm() }, "ATM");
  const tiles = {
    index: chartTile({ pane: "index", id: "scalper-index", trade: trade("index"), buyLabel: "Buy CE", sellLabel: "Buy PE" }),
    call: chartTile({ pane: "call", id: "scalper-call", trade: trade("call"), picker: callPick.el }),
    put: chartTile({ pane: "put", id: "scalper-put", trade: trade("put"), picker: putPick.el }),
  };
  tiles.index.el.querySelector(".ws-buy").title = "Opens the ticket to buy the ATM call";
  tiles.index.el.querySelector(".ws-sell").title = "Opens the ticket to buy the ATM put";
  const grid = h("div", { class: "ws-scalper" }, tiles.index.el, tiles.call.el, tiles.put.el);
  const root = h(
    "div",
    { class: "ws-page ws-page-scalper" },
    wsBar(h("div", { class: "ws-bar-l" }, uSel, eSel, ivSel, atmBtn), h("div", { class: "ws-bar-r" }, viewSeg, arrSeg, switcherButton("scalper"))),
    status,
    grid,
  );

  function applyLayout() {
    const panes = scalperPanes(st.layout);
    grid.dataset.view = st.layout.view;
    grid.dataset.arrange = st.layout.view === "all" ? st.layout.arrange : "row";
    for (const [k, t] of Object.entries(tiles)) t.el.hidden = !panes.includes(k);
    arrSeg.hidden = st.layout.view !== "all";
    if (viewSeg.value !== st.layout.view) viewSeg.value = st.layout.view;
    if (arrSeg.value !== st.layout.arrange) arrSeg.value = st.layout.arrange;
  }
  viewSeg.addEventListener("change", () => {
    if (viewSeg.value === st.layout.view) return;
    st.layout = { ...st.layout, view: viewSeg.value };
    persist();
    applyLayout();
  });
  arrSeg.addEventListener("change", () => {
    if (arrSeg.value === st.layout.arrange) return;
    st.layout = { ...st.layout, arrange: arrSeg.value };
    persist();
    applyLayout();
  });
  pageKeys(root, (e) => {
    if (!isLayoutKey(e)) return false;
    st.layout = nextScalperLayout(st.layout);
    persist();
    applyLayout();
    toast(layoutText(st.layout), { tone: "info" });
    return true;
  });

  // ── data ──
  let watcher = null;
  const indexSym = () => INDEX_SYMBOLS[st.u];
  function drawContracts() {
    const ks = chainStrikes(st.chain);
    const atm = atmOf(st.chain);
    for (const pane of ["call", "put"]) {
      if (!st.pinned[pane] || !ks.includes(st.strike[pane])) {
        st.strike[pane] = atm;
        st.pinned[pane] = false;
      }
    }
    const lot = st.chain?.lotSize ? `Lot ${st.chain.lotSize}` : "";
    tiles.index.setTitle(st.u, `Index · ATM ${atm ?? DASH}`);
    tiles.index.setTradeLabel(`(the ATM ${atm ?? ""} call or put)`);
    tiles.index.setTradeEnabled(atm !== null && Boolean(st.expiry), "No ATM strike yet");
    for (const [pane, right, pick] of [["call", "CE", callPick], ["put", "PE", putPick]]) {
      const k = st.strike[pane];
      const leg = legOf(st.chain, k, right);
      pick.set(ks, atm, k);
      tiles[pane].setTitle(`${st.u} ${contractLabel(k, right)}`, [st.expiry, lot, k === atm ? "ATM" : null].filter(Boolean).join(" · "));
      tiles[pane].setTradeLabel(`${st.u} ${contractLabel(k, right)}`);
      tiles[pane].setTradeEnabled(Boolean(leg), "This strike has no contract listed");
      if (leg) tiles[pane].show(leg.symbol, `${st.u} ${contractLabel(k, right)}`, st.iv, leg);
    }
    const syms = [indexSym(), tiles.call.symbol, tiles.put.symbol].filter(Boolean);
    if (watcher) watcher.update(syms);
    else
      watcher = live.watch(syms, "quote", (ticks) => {
        if (!root.isConnected) return stop();
        const now = Date.now();
        for (const [sym, t] of ticks) for (const tile of Object.values(tiles)) if (tile.symbol === sym) tile.tick(t, now);
      });
  }
  function pickStrike(pane, k) {
    if (!Number.isFinite(k)) return;
    st.strike[pane] = k;
    st.pinned[pane] = k !== atmOf(st.chain);
    drawContracts();
  }
  function toAtm() {
    st.pinned = { call: false, put: false };
    drawContracts();
  }
  let seq = 0;
  async function loadAll({ newU = false } = {}) {
    const my = ++seq;
    try {
      if (newU || !st.expiries.length) {
        st.expiries = await loadExpiries(st.u);
        if (my !== seq) return;
        if (!st.expiries.includes(st.expiry)) st.expiry = st.expiries[0] ?? null;
        eSel.replaceChildren(...(st.expiries.length ? st.expiries.map((e, i) => h("option", { value: e, selected: e === st.expiry }, expiryLabel(e, i))) : [h("option", { value: "" }, "No expiries")]));
      }
      tiles.index.show(indexSym(), st.u, st.iv);
      const [chain, q] = await Promise.all([st.expiry ? loadChain(st.u, st.expiry) : null, loadQuote(indexSym())]);
      if (my !== seq) return;
      st.chain = chain;
      if (q) tiles.index.quote(q);
      status.textContent = st.expiry ? "" : `No upcoming expiries for ${st.u}: the option charts have nothing to show.`;
      status.hidden = !status.textContent;
      drawContracts();
    } catch (err) {
      if (my !== seq) return;
      status.hidden = false;
      status.replaceChildren(errorState(err, { onRetry: () => loadAll({ newU: true }) }));
    }
  }
  uSel.addEventListener("change", () => {
    st.u = uSel.value;
    st.pinned = { call: false, put: false };
    st.expiry = null;
    persist();
    loadAll({ newU: true });
  });
  eSel.addEventListener("change", () => {
    st.expiry = eSel.value || null;
    st.pinned = { call: false, put: false };
    loadAll();
  });
  const timer = setInterval(() => {
    if (!root.isConnected) return stop();
    if (!document.hidden) loadAll();
  }, CHAIN_REFRESH_MS);
  function stop() {
    clearInterval(timer);
    watcher?.stop();
    watcher = null;
    for (const t of Object.values(tiles)) t.destroy();
  }
  applyLayout();
  loadAll({ newU: true });
  return root;
}

// ───────────────────────── Options Trader ─────────────────────────

export async function renderTraderPage() {
  const saved = readJson(SLOT.trader) ?? {};
  const list = underlyings();
  const st = { u: list.includes(saved.u) ? saved.u : list[0], iv: savedInterval(saved.iv), expiry: null, expiries: [], chain: null, strike: null, pinned: false };
  const persist = () => save(SLOT.trader, { u: st.u, iv: st.iv });

  const uSel = capsuleSelect("Underlying", list.map((u) => [u, u]), st.u);
  const eSel = capsuleSelect("Expiry", [["", "Expiry"]], "", "ws-exp");
  const ivSel = intervalSelect("Chart interval", st.iv);
  ivSel.addEventListener("change", () => {
    st.iv = ivSel.value;
    persist();
    drawContracts();
  });
  const spot = priceBox();
  const status = h("p", { class: "ws-status", role: "status", hidden: true });
  const trade = (right) => (side) => openTicket(tradeLeg({ underlying: st.u, strike: st.strike, right, side }), st.expiry);
  const pickers = { CE: strikePicker("Call", (k) => pick(k, true)), PE: strikePicker("Put", (k) => pick(k, true)) };
  const tiles = { CE: chartTile({ pane: "call", id: "trader-call", trade: trade("CE"), picker: pickers.CE.el }), PE: chartTile({ pane: "put", id: "trader-put", trade: trade("PE"), picker: pickers.PE.el }) };

  // The compact chain: call LTP and change | strike | put change and LTP, around the ATM. Click, Enter or Space picks
  // a strike; ↑ ↓ move along the rows.
  const tbody = h("tbody", {});
  const table = h(
    "table",
    { class: "ws-chain", "aria-label": "Option chain: pick a strike to chart its call and put" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "ce" }, "Call"), h("th", { scope: "col", class: "ce" }, "Chg"), h("th", { scope: "col", class: "k" }, "Strike"), h("th", { scope: "col", class: "pe" }, "Chg"), h("th", { scope: "col", class: "pe" }, "Put"))),
    tbody,
  );
  const chainCard = h(
    "section",
    { class: "ws-chain-card", "aria-label": "Option chain" },
    h("header", { class: "ws-chain-head" }, h("div", { class: "ws-id" }, h("strong", { class: "ws-name" }, "Option chain"), h("small", { class: "ws-sub" }, keyHint("↑ ↓ to move · ↵ to chart") || "Pick a strike to chart it")), h("a", { href: "#/chain", class: "btn small quiet ws-full" }, "Full chain", icon("chevron"))),
    h("div", { class: "ws-chain-scroll" }, table),
  );
  const charts = h("div", { class: "ws-trader-charts" }, tiles.CE.el, tiles.PE.el);
  const root = h(
    "div",
    { class: "ws-page ws-page-trader" },
    wsBar(h("div", { class: "ws-bar-l" }, uSel, eSel, ivSel, h("span", { class: "ws-spot" }, h("small", {}, "Spot"), spot.el)), h("div", { class: "ws-bar-r" }, switcherButton("trader"))),
    status,
    h("div", { class: "ws-trader" }, chainCard, charts),
  );

  /** Row cells patched in place by tick: symbol -> { ltp: Text, chg: Text, chgEl } */
  const cells = new Map();
  let rowsSig = "";
  function drawChain() {
    const atm = atmOf(st.chain);
    // Around the ATM, so picking a strike never moves the rows under the pointer.
    const ks = strikeWindow(chainStrikes(st.chain), atm, 12);
    const sig = `${st.u}|${st.expiry}|${ks.join()}|${atm}`;
    if (sig !== rowsSig) {
      rowsSig = sig;
      cells.clear();
      const cell = (leg, side) => {
        const ltp = document.createTextNode(DASH);
        const chg = document.createTextNode("");
        const chgEl = h("td", { class: `${side} chg` }, chg);
        const ltpEl = h("td", { class: `${side} ltp` }, ltp);
        if (leg?.symbol) cells.set(leg.symbol, { ltp, chg, chgEl, base: leg });
        return { ltpEl, chgEl, ltp, chg };
      };
      tbody.replaceChildren(
        ...ks.map((k) => {
          const ce = cell(legOf(st.chain, k, "CE"), "ce");
          const pe = cell(legOf(st.chain, k, "PE"), "pe");
          const tr = h("tr", { tabindex: "-1", "data-strike": String(k), class: k === atm ? "atm" : undefined, "aria-selected": "false" }, ce.ltpEl, ce.chgEl, h("th", { scope: "row", class: "k" }, String(k), k === atm ? h("span", { class: "ws-atm-tag" }, "ATM") : null), pe.chgEl, pe.ltpEl);
          tr.addEventListener("click", () => pick(k, k !== atm));
          return tr;
        }),
      );
    }
    for (const [sym, c] of cells) paintCell(c, legQuote(sym, c.base));
    markSelected();
  }
  const legQuote = (sym, base) => overlay(base, live.lastTick(sym));
  function paintCell(c, q) {
    const t = changeOf(q);
    const price = t.ltp === null ? DASH : formatFixed(t.ltp, 2);
    const pct = t.pct === null ? "" : `${formatSigned(t.pct, 1)}%`;
    if (c.ltp.data !== price) c.ltp.data = price;
    if (c.chg.data !== pct) c.chg.data = pct;
    c.chgEl.classList.toggle("up", t.dir === "up");
    c.chgEl.classList.toggle("down", t.dir === "down");
  }
  function markSelected() {
    let sel = null;
    for (const tr of tbody.rows) {
      const on = Number(tr.dataset.strike) === st.strike;
      tr.setAttribute("aria-selected", String(on));
      tr.tabIndex = on ? 0 : -1;
      if (on) sel = tr;
    }
    // Keep the picked strike in view inside the chain's own scroll (never the page's).
    if (sel) {
      const box = sel.closest(".ws-chain-scroll");
      if (box && (sel.offsetTop < box.scrollTop || sel.offsetTop + sel.offsetHeight > box.scrollTop + box.clientHeight)) box.scrollTop = sel.offsetTop - box.clientHeight / 2 + sel.offsetHeight / 2;
    }
  }
  tbody.addEventListener("keydown", (e) => {
    const rows = [...tbody.rows];
    const i = rows.indexOf(/** @type {HTMLTableRowElement} */ (e.target.closest?.("tr")));
    if (i < 0) return;
    let j = i;
    if (e.key === "ArrowDown") j = Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = rows.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      return pick(Number(rows[i].dataset.strike), true);
    } else return;
    e.preventDefault();
    rows[j].tabIndex = 0;
    rows[i].tabIndex = rows[i].getAttribute("aria-selected") === "true" ? 0 : -1;
    rows[j].focus();
  });

  let watcher = null;
  function drawContracts() {
    const ks = chainStrikes(st.chain);
    const atm = atmOf(st.chain);
    if (!st.pinned || !ks.includes(st.strike)) {
      st.strike = atm;
      st.pinned = false;
    }
    for (const right of ["CE", "PE"]) {
      const leg = legOf(st.chain, st.strike, right);
      const name = `${st.u} ${contractLabel(st.strike, right)}`;
      pickers[right].set(ks, atm, st.strike);
      tiles[right].setTitle(name, [st.expiry, st.chain?.lotSize ? `Lot ${st.chain.lotSize}` : null, st.strike === atm ? "ATM" : null].filter(Boolean).join(" · "));
      tiles[right].setTradeLabel(name);
      tiles[right].setTradeEnabled(Boolean(leg), "This strike has no contract listed");
      if (leg) tiles[right].show(leg.symbol, name, st.iv, leg);
    }
    drawChain();
    const syms = [INDEX_SYMBOLS[st.u], ...cells.keys(), tiles.CE.symbol, tiles.PE.symbol].filter(Boolean);
    if (watcher) watcher.update([...new Set(syms)]);
    else
      watcher = live.watch([...new Set(syms)], "quote", (ticks) => {
        if (!root.isConnected) return stop();
        const now = Date.now();
        for (const [sym, t] of ticks) {
          if (sym === INDEX_SYMBOLS[st.u]) spot.set(overlay(spotBase, t));
          const c = cells.get(sym);
          if (c) paintCell(c, overlay(c.base, t));
          for (const tile of Object.values(tiles)) if (tile.symbol === sym) tile.tick(t, now);
        }
      });
  }
  function pick(k, pinned) {
    if (!Number.isFinite(k)) return;
    st.strike = k;
    st.pinned = pinned && k !== atmOf(st.chain);
    drawContracts();
  }
  let spotBase = null;
  let seq = 0;
  async function loadAll({ newU = false } = {}) {
    const my = ++seq;
    try {
      if (newU || !st.expiries.length) {
        st.expiries = await loadExpiries(st.u);
        if (my !== seq) return;
        if (!st.expiries.includes(st.expiry)) st.expiry = st.expiries[0] ?? null;
        eSel.replaceChildren(...(st.expiries.length ? st.expiries.map((e, i) => h("option", { value: e, selected: e === st.expiry }, expiryLabel(e, i))) : [h("option", { value: "" }, "No expiries")]));
      }
      const [chain, q] = await Promise.all([st.expiry ? loadChain(st.u, st.expiry, 25) : null, loadQuote(INDEX_SYMBOLS[st.u])]);
      if (my !== seq) return;
      st.chain = chain;
      spotBase = q;
      spot.set(q);
      status.hidden = Boolean(st.expiry);
      status.textContent = st.expiry ? "" : `No upcoming expiries for ${st.u}.`;
      drawContracts();
    } catch (err) {
      if (my !== seq) return;
      status.hidden = false;
      status.replaceChildren(errorState(err, { onRetry: () => loadAll({ newU: true }) }));
    }
  }
  uSel.addEventListener("change", () => {
    st.u = uSel.value;
    st.expiry = null;
    st.pinned = false;
    persist();
    loadAll({ newU: true });
  });
  eSel.addEventListener("change", () => {
    st.expiry = eSel.value || null;
    st.pinned = false;
    loadAll();
  });
  const timer = setInterval(() => {
    if (!root.isConnected) return stop();
    if (!document.hidden) loadAll();
  }, CHAIN_REFRESH_MS);
  function stop() {
    clearInterval(timer);
    watcher?.stop();
    watcher = null;
    for (const t of Object.values(tiles)) t.destroy();
  }
  loadAll({ newU: true });
  return root;
}

// ───────────────────────── Market Watch ─────────────────────────

export async function renderWatchPage() {
  const fallback = app.state.demo ? WATCH_DEMO_DEFAULT : WATCH_DEFAULT;
  let st = readWatch(app.local.get(SLOT.watch), fallback);
  const persist = () => save(SLOT.watch, st);
  const countSeg = segmented("Charts on screen", WATCH_COUNTS.map((n) => [String(n), String(n)]), String(st.count));
  countSeg.title = "How many charts to show";
  const reset = h("button", { type: "button", class: "small quiet", title: "Back to the starting symbols and intervals" }, "Reset");
  const grid = h("div", { class: "ws-watch" });
  const root = h("div", { class: "ws-page ws-page-watch" }, wsBar(h("div", { class: "ws-bar-l" }, h("span", { class: "ws-bar-k" }, "Charts"), countSeg), h("div", { class: "ws-bar-r" }, reset, switcherButton("watch"))), grid);

  const tiles = [];
  for (let i = 0; i < 6; i++) {
    const symBtn = h("button", { type: "button", class: "small quiet ws-sym", "aria-haspopup": "dialog", title: "Change this chart's symbol" }, h("span", {}, DASH), icon("chevron"));
    const ivSel = intervalSelect(`Chart ${i + 1} interval`, st.tiles[i].interval);
    const tile = chartTile({ pane: `tile-${i + 1}`, id: `watch-${i + 1}`, extra: h("div", { class: "ws-tile-ctl" }, ivSel) });
    tile.el.querySelector(".ws-id-top").replaceChildren(symBtn);
    symBtn.addEventListener("click", () =>
      openSymbolSearch({
        current: st.tiles[i].symbol,
        indices: underlyings(),
        quoteSymbol: quoteSymbolOf,
        exchangeOf: (u) => quoteSymbolOf(u).split(":")[0],
        onPick: (u) => change(i, { symbol: u }),
      }),
    );
    ivSel.addEventListener("change", () => change(i, { interval: ivSel.value }));
    tiles.push({ tile, symBtn, ivSel });
  }
  grid.append(...tiles.map((t) => t.tile.el));

  let watcher = null;
  function draw() {
    grid.dataset.count = String(st.count);
    grid.dataset.cols = String(watchGrid(st.count).cols);
    tiles.forEach(({ tile, symBtn, ivSel }, i) => {
      const on = i < st.count;
      tile.el.hidden = !on;
      const t = st.tiles[i];
      symBtn.firstChild.textContent = t.symbol;
      symBtn.setAttribute("aria-label", `Chart ${i + 1}: ${t.symbol}. Change the symbol`);
      if (ivSel.value !== t.interval) ivSel.value = t.interval;
      tile.setTitle(t.symbol, "");
      if (on) tile.show(quoteSymbolOf(t.symbol), t.symbol, t.interval);
    });
    const syms = [...new Set(tiles.slice(0, st.count).map(({ tile }) => tile.symbol).filter(Boolean))];
    if (watcher) watcher.update(syms);
    else
      watcher = live.watch(syms, "quote", (ticks) => {
        if (!root.isConnected) return stop();
        const now = Date.now();
        for (const [sym, t] of ticks) for (const { tile } of tiles) if (tile.symbol === sym) tile.tick(t, now);
      });
    // Each tile's price: one quotes read for the symbols on screen (the stream patches it from there).
    optional(api(`/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}`)).then((r) => {
      for (const q of r.data?.data ?? []) for (const { tile } of tiles) if (tile.symbol === q?.symbol) tile.quote(q);
    });
  }
  function change(i, patch) {
    const next = setTile(st, i, patch);
    if (next === st) return;
    st = next;
    persist();
    draw();
  }
  countSeg.addEventListener("change", () => {
    const n = Number(countSeg.value);
    if (n === st.count) return;
    st = { ...st, count: n };
    persist();
    draw();
  });
  reset.addEventListener("click", () => {
    st = readWatch(null, fallback);
    app.local.set(SLOT.watch, null);
    countSeg.value = String(st.count);
    draw();
    toast("Market Watch is back to its starting charts", { tone: "info" });
  });
  function stop() {
    watcher?.stop();
    watcher = null;
    for (const { tile } of tiles) tile.destroy();
  }
  draw();
  return root;
}
