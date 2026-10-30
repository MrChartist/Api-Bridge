// The Option Desk: a live option chain you can trade from, a strategy builder with payoffs, OI analysis and your
// positions on the same underlying. Data is GET /v1/expiries, /v1/optionchain and /v1/positions; orders go through
// POST /v1/orders/preview and /v1/orders like every other client, so the Bridge's safety gates apply unchanged.
//
// Built for refresh every few seconds: the chain table is built once per (underlying, expiry, strikes, columns) and
// then patched cell by cell, so nothing flickers, scroll and keyboard focus stay put, and only cells that changed
// flash. The maths lives in options.js (pure, tested); numbers are formatted by format.js only.
import { DEMO_EXPLAINER, alertBox, api, app, emptyState, errorState, h, icon, liveControl, loadingState, modal, mountToolbarCtx, optional, sheetPopover, toast, touchWord } from "./app.js";
import { DASH, MINUS, ageText, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { arbPanels } from "./arbitrage.js";
import { openChainSheet } from "./chain-sheet.js";
import { createOiPage, oiConfig } from "./oi.js";
import { oiStore, snapKey } from "./oi-store.js";
import { createBuilder } from "./strategy.js";
import * as O from "./options.js";
import { createPositionsPage } from "./positions.js";
import { cap, every, segField, segmented, stopTimer } from "./views.js";
import { wideExtras } from "./layout-prefs.js";
import { createVolPage, volConfig } from "./vol.js";
import { demoStaleAsked, lotConfirmGate, lotStaleCheck, loadReference, refBanners, refCalendar, refChip, refRate, refSession, refSignature } from "./reference.js";
import { readinessSheetRow } from "./readiness.js";
import { clockNote, loadPricingContext } from "./vol-context.js";
import { animatePage, barsEnter, countUp, flashValue, stopCount } from "./motion.js";
import { ticketRisk } from "./flows.js";
import { watch } from "./live.js";

const SLOT = "mcb.dashboard.desk";
/** The index underlyings the Options pages list (live) and the three the demo serves; the Option Screener shares them. */
export const UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);
export const DEMO_UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "SENSEX"]);
/** Strikes fetched either side of ATM: wide enough for PCR and max pain, whatever is shown. */
const FETCH_STRIKES = 40;
/** The OI page reads the whole listed chain (the API maximum), so max pain and PCR are not biased by a partial one. */
const OI_FETCH_STRIKES = 100;
/** The Volatility page reads the 10Δ wings of monthlies: a wider window than the chain. */
const VOL_STRIKES = 60;
const REFRESH_MS = 3000;
/** Shortest gap between two price flashes on one chain cell (live ticks arrive every frame on liquid strikes). */
const FLASH_GAP_MS = 2500;
/** Outside market hours nothing moves: refresh every 30 s instead. */
const CLOSED_REFRESH_MS = 30000;
/** Pages that place orders show the account select (P1: a control only where it changes what the page does). */
const TRADING = new Set(["chain", "strategy", "positions", "arb"]);
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryText = (e) => (/^\d{4}-\d{2}-\d{2}$/.test(e ?? "") ? EXPIRY_DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
/** "NIFTY 3 Nov 26400 CE" */
const contractName = (u, expiry, strike, right) => `${u} ${expiryText(expiry)} ${formatInt(strike)} ${right}`;
const num = (v) => (isFigure(v) ? Number(v) : null);
/** Which way a PCR leans, from O.PCR_BANDS (one set of thresholds for the tile, its title and the strike column):
 *  "put" from 1.2 up, "call" at 0.8 and below, "" balanced or none. */
const pcrSide = (p) => {
  const w = O.pcrBand(p)?.word ?? "";
  return w.includes("put-heavy") ? "put" : w.includes("call-heavy") ? "call" : "";
};
/** One decimal for SVG coordinates (geometry, not display text). */
const r1 = (v) => Math.round(v * 10) / 10;
const local = app.local;
/** Index symbols for GET /v1/quotes (the spot row's day change). */
const INDEX_SYMBOL = { NIFTY: "NSE:NIFTY", BANKNIFTY: "NSE:BANKNIFTY", FINNIFTY: "NSE:FINNIFTY", MIDCPNIFTY: "NSE:MIDCPNIFTY", SENSEX: "BSE:SENSEX", BANKEX: "BSE:BANKEX" };
const EXPIRY_DAY_NOTE = "Index option shorts carry +2% ELM today; no calendar-spread margin benefit; ITM longs left to exercise pay STT 0.125% of intrinsic. Square off to pay 0.1% of premium instead.";
/** Freeze quantities by symbol (GET /v1/instruments/{symbol}), for the session. */
const freezeCache = new Map();
const freezeLoading = new Set();
/** The chain's keys: [keys, what they do] (the legend under the table and the ? overlay). */
const CHAIN_KEYS = [
  [["J", "K"], "strike", "Next / previous strike (↓ ↑ too)"],
  [["←", "→"], "side", "Calls / puts side (H L too)"],
  [["/"], "search", "Go to strike: 26400, 264, +3, -2σ, atm, mp"],
  [["[", "]"], "expiry", "Previous / next expiry"],
  [["1–5"], "view", "Columns: OI, Buyer, Seller, Hedger, Arb"],
  [["C", "V"], "calls / puts", "Calls only / puts only (again: both)"],
  [["M"], "select", "Select contracts for the Strategy Builder (Space ticks one)"],
  [["↵"], "sheet", "Open the action sheet for the strike"],
  [["B"], "buy", "Order ticket: buy at the ask"],
  [["S"], "sell", "Order ticket: sell at the bid"],
  [["⇧B", "⇧S"], "add to strategy", "Add a buy / sell leg to the strategy"],
  [["X"], "exit", "Exit the position you hold in this contract"],
  [["G"], "ATM", "Back to ATM (Home too)"],
  [["P"], "pause", "Pause / resume live updates"],
  [["R"], "refresh", "Refresh now"],
  [["?"], "keys", "This list"],
  [["Esc"], "clear", "Clear the focus; close the sheet or search"],
];
const KEY_LEGEND = CHAIN_KEYS.filter((k) => !["R", "Esc", "M", "X"].includes(k[0][0]));
const readPrefs = () => {
  try {
    return JSON.parse(local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

// Keyboard: one listener for the life of the tab; it acts on the desk on screen, if any.
let activeDesk = null;
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  const handle = (e) => {
    const d = activeDesk;
    if (!d || !d.root.isConnected || e.defaultPrevented || e.isComposing) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return false;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return false;
    if (!d.onKey(e)) return false;
    e.preventDefault();
    return true;
  };
  // "/" and "?" mean strike search and the chain's keys here, ahead of the app-wide palette and shortcuts.
  document.addEventListener("keydown", (e) => (e.key === "/" || e.key === "?") && handle(e) && e.stopPropagation(), true);
  document.addEventListener("keydown", (e) => e.key !== "/" && e.key !== "?" && handle(e));
}

/** The four Options pages share one state (underlying, expiry, account, strategy), kept in localStorage. */
export const renderChainPage = () => renderDesk("chain");
export const renderStrategyPage = () => renderDesk("strategy");
export const renderOiPage = () => renderDesk("oi");
export const renderPositionsPage = () => renderDesk("positions");
export const renderVolPage = () => renderDesk("vol");
export const renderArbPage = () => renderDesk("arb");

/** @param {"chain"|"strategy"|"oi"|"positions"|"vol"|"arb"} kind */
async function renderDesk(kind) {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const tradable = accounts.filter((a) => a.enabled && (a.capabilities ?? []).includes("placeOrder"));
  const prefs = readPrefs();
  const list = app.state.demo ? DEMO_UNDERLYINGS : UNDERLYINGS;
  const st = {
    underlying: list.includes(prefs.underlying) ? prefs.underlying : list[0],
    expiry: prefs.expiry ?? null,
    expiries: [],
    strikes: strikesPref(prefs.strikes),
    strikesView: null,
    cfg: chainConfig(prefs.chain),
    account: tradable.some((a) => a.id === prefs.account) ? prefs.account : (tradable.find((a) => a.broker === "paper") ?? tradable[0])?.id ?? null,
    live: prefs.live !== false,
    baskets: prefs.baskets && typeof prefs.baskets === "object" ? prefs.baskets : {},
    oi: oiConfig(prefs.oi),
    scfg: prefs.strategy ?? null,
    whatIf: prefs.whatIf ?? null,
    pos: O.positionsConfig(prefs.pos),
    vol: volConfig(prefs.vol),
    arb: O.arbConfig(prefs.arb),
    quotesError: null,
    chain: null,
    freshness: null,
    error: null,
    ms: null,
    patchMs: null,
    lastOk: null,
    quotes: new Map(),
    futures: [],
    positions: [],
    futPositions: [],
    positionsError: null,
    focus: null, // { strike, side: "ce" | "pe" }
    seq: 0,
    // The reference bundle for st.underlying (reference.js): session, holidays, rate, lots, events, charges. Null
    // until the first read; a failed read is the labelled fallback bundle.
    ref: null,
  };
  st.strikesView = st.strikes;
  /** The page (the order ticket's own `kind` parameter is the contract kind). */
  const pageKind = kind;
  const save = () => local.set(SLOT, JSON.stringify({ underlying: st.underlying, expiry: st.expiry, strikes: st.strikes, chain: st.cfg, account: st.account, live: st.live, baskets: st.baskets, oi: st.oi, strategy: st.scfg ?? undefined, whatIf: st.whatIf ?? undefined, pos: st.pos, vol: st.vol, arb: st.arb }));
  const account = () => tradable.find((a) => a.id === st.account) ?? null;
  // Strategy drafts are keyed by underlying; each leg carries its own expiry (docs/design/strategy.md §5.1).
  const basketKey = () => st.underlying;
  const basket = () => (st.baskets[basketKey()] ??= []);

  // ── Toolbar ──
  const uSel = h("select", { "aria-label": "Underlying", class: "desk-u" }, list.map((u) => h("option", { value: u, selected: u === st.underlying }, u)));
  const eSel = h("select", { "aria-label": "Expiry" });
  const strikesSeg = segmented("Strikes each side of ATM", [["10", "±10"], ["20", "±20"], ["all", "All"]], st.strikes);
  strikesSeg.classList.add("strikes-seg");
  const viewSeg = segmented("Columns for", TOOLBAR_PRESETS.map((p) => [p, PRESET_NAMES[p]]), TOOLBAR_PRESETS.includes(st.cfg.preset) ? st.cfg.preset : "oi");
  viewSeg.classList.add("preset-seg");
  const presetSel = h("select", { class: "preset-sel", "aria-label": "Columns for" }, [...Object.keys(CHAIN_PRESETS).map((p) => h("option", { value: p }, PRESET_NAMES[p])), h("option", { value: "custom", disabled: true }, "Custom")]);
  let presetLock = false;
  const syncPreset = () => {
    const p = st.cfg.preset;
    presetLock = true;
    if (TOOLBAR_PRESETS.includes(p) && viewSeg.value !== p) viewSeg.value = p;
    presetLock = false;
    viewSeg.classList.toggle("custom", !TOOLBAR_PRESETS.includes(p));
    presetSel.value = p;
  };
  syncPreset();
  const gearBtn = h("button", { type: "button", class: "small gear-btn", "aria-haspopup": "dialog", "aria-label": "Customise the chain", title: "Customise the chain: columns, bars, tags" }, icon("sliders"), h("span", { class: "gear-label" }, "Customise"));
  const search = h("input", { type: "search", inputmode: "decimal", enterkeyhint: "go", autocomplete: "off", spellcheck: "false", class: "strike-search", "aria-label": "Go to strike", placeholder: "Strike or ±n" });
  const searchBtn = h("button", { type: "button", class: "icon-btn search-btn", "aria-label": "Go to strike", title: "Go to strike (/)" }, icon("search"));
  const staleText = document.createTextNode("Stale");
  const stalePill = h("span", { class: "pill warn chain-stale", role: "status", hidden: true }, h("span", { class: "pdot", "aria-hidden": "true" }), staleText);
  const searchHint = h("span", { class: "search-hint", id: "strike-search-hint", role: "status", hidden: true }, "Try 26400, +3, 1σ, atm, mp");
  search.setAttribute("aria-describedby", "strike-search-hint");
  // The hint is a line of its own under the head row (it pushes the table down, never covers the column headers).
  const searchBox = h("div", { class: "chain-search" }, searchBtn, search, h("kbd", { class: "search-kbd", "aria-hidden": "true" }, "/"));
  const showHint = (on) => {
    if (searchHint.hidden === !on) return;
    searchHint.hidden = !on;
    chain.fitHeight();
  };
  // Phones: the strikes window is a compact select in the head row ("±10 ▾"), beside Calls | Puts | Both.
  const strikesSel = h("label", { class: "strikes-pick", title: "Strikes each side of ATM" }, h("span", { class: "sp-text" }, ""), h("select", { "aria-label": "Strikes each side of ATM" }, [["10", "±10 strikes"], ["20", "±20 strikes"], ["all", "All strikes"]].map(([v, t]) => h("option", { value: v }, t))));
  const syncStrikesSel = () => {
    const v = strikesSeg.value;
    strikesSel.lastChild.value = v;
    strikesSel.firstChild.textContent = v === "all" ? "All" : `±${v}`;
  };
  strikesSel.lastChild.addEventListener("change", () => (strikesSeg.value = strikesSel.lastChild.value));
  // OI change over the day (the broker's oiChange) or over the last hour / 15 minutes, from the snapshots the OI pages
  // record in this browser (oi-store.js). A window without enough snapshots yet is disabled and says why.
  const winSeg = segmented("OI change over", [["day", "Day"], ["60", "1h"], ["15", "15m"]], st.cfg.oiWin);
  winSeg.classList.add("win-seg");
  winSeg.title = "OI change over the day, or over the last hour / 15 minutes (from snapshots recorded in this browser)";
  // A narrow panel: the same choice as a compact select (fitHead), so the head stays one row.
  const winSel = h("select", { class: "win-sel", "aria-label": "OI change over", title: winSeg.title }, [["day", "Day"], ["60", "1h"], ["15", "15m"]].map(([v, t]) => h("option", { value: v }, `OI chg ${t}`)));
  winSel.addEventListener("change", () => (winSeg.value = winSel.value));
  // Multi-select: tick contracts, then open them in the Strategy Builder (m).
  const selectBtn = h("button", { type: "button", class: "small select-btn", "aria-pressed": "false", title: "Select contracts for the Strategy Builder (M)" }, icon("check"), h("span", { class: "gear-label" }, "Select"));
  const aSel = h(
    "select",
    { "aria-label": "Orders go to", disabled: !tradable.length },
    tradable.length ? tradable.map((a) => h("option", { value: a.id, selected: a.id === st.account }, a.label)) : h("option", { value: "" }, "No account can place orders"),
  );
  const acctBadge = h("span", { class: "acct-badge" });
  /** The account's mode as a badge after the select (never "· paper" inside the option text; no "Paper" badge when
   *  the label already says paper; "LIVE" always shows). */
  const drawAcct = () => {
    const a = account();
    aSel.title = a ? `Orders go to ${a.label} (${a.broker ?? ""})` : "No account can place orders";
    const live = Boolean(a && a.broker !== "paper" && a.liveAllowedByConfig);
    acctBadge.textContent = !a ? "" : live ? "Live" : "Paper";
    acctBadge.dataset.mode = live ? "live" : "paper";
    acctBadge.hidden = !a || (!live && /paper/i.test(a.label ?? ""));
  };

  /**
   * "Orders go to": the account picker for the order ticket and the action sheet (the chain's line has none: it is
   * read-only until an order is placed). A live account carries a red LIVE badge; paper shows its name only.
   */
  function acctPicker(onChange = null, { label = true, badge: withBadge = true } = {}) {
    if (!tradable.length) return h("a", { href: "#/accounts", class: "acct-connect" }, icon("plug"), "Connect an account");
    const sel = h("select", { class: "acct-pick", "aria-label": "Orders go to" }, tradable.map((a) => h("option", { value: a.id, selected: a.id === st.account }, a.label)));
    const isLive = () => {
      const a = account();
      return Boolean(a && a.broker !== "paper" && a.liveAllowedByConfig);
    };
    // The LIVE badge follows the picked account (the sheet stays open across a change).
    const badge = h("span", { class: "acct-badge", "data-mode": "live", hidden: !isLive() }, "Live");
    sel.disabled = tradable.length < 2;
    sel.addEventListener("change", () => {
      aSel.value = sel.value;
      aSel.dispatchEvent(new Event("change"));
      badge.hidden = !isLive();
      onChange?.();
    });
    // badge: false when the host shows its own mode (the strategy confirm sheet: its Mode switch decides paper / live).
    return h("span", { class: "acct-pick-row" }, label ? h("span", { class: "acct-pick-k" }, "Orders go to") : null, sel, withBadge ? badge : null);
  }

  // ── The compact top bar (docs/design/foundation.md §5): mounted into the app toolbar's #toolbar-ctx. One glass
  // capsule (underlying │ expiry │ spot ±chg │ lot), then the account and its mode, the one live control and, below
  // 1280 px, a ⋯ sheet. Text nodes only on refresh. ──
  const liveBtn = liveControl({ onToggle: () => toggleLive(), refreshMs: REFRESH_MS });
  const expiryChip = h("span", { class: "ctx-chip expiry-chip", title: EXPIRY_DAY_NOTE, hidden: true }, "Expiry today");
  const uMain = document.createTextNode(st.underlying);
  const uSub = document.createTextNode("");
  const uChg = document.createTextNode(""); // the day's change after the spot; phones drop it (app.css .ctx-sub-chg)
  const eLong = document.createTextNode("");
  const eShort = document.createTextNode("");
  const eSub = document.createTextNode("");
  const spotV = document.createTextNode(DASH);
  const spotChg = h("span", { class: "ctx-chg" });
  const lotV = document.createTextNode(DASH);
  const uItem = h("label", { class: "ctx-item ctx-pick ctx-u", title: "Underlying" }, h("span", { class: "ctx-main" }, uMain), h("span", { class: "ctx-sub", "aria-hidden": "true" }, uSub, h("span", { class: "ctx-sub-chg" }, uChg)), uSel);
  const eItem = h("label", { class: "ctx-item ctx-pick ctx-e", title: "Expiry ([ and ])" }, h("span", { class: "ctx-main" }, h("span", { class: "ctx-long" }, eLong), h("span", { class: "ctx-short" }, eShort)), h("span", { class: "ctx-sub", "aria-hidden": "true" }, eSub), eSel);
  const spotItem = h("span", { class: "ctx-item ctx-spot", title: "Spot (the index) and its change today" }, h("span", { class: "ctx-main" }, h("span", {}, spotV), spotChg));
  const lotItem = h("span", { class: "ctx-item ctx-lot", title: "Lot size" }, h("span", { class: "ctx-main" }, "Lot ", h("b", {}, lotV)));
  // The chain's line also carries the future (or the synthetic forward) with its basis, and ATM IV (docs/design/
  // chain.md §3.1); they drop first when the line runs out of room (fitCtx).
  const futK = document.createTextNode("Fut");
  const futV = document.createTextNode(DASH);
  const futB = h("span", { class: "ctx-basis" });
  const futItem = h("span", { class: "ctx-item ctx-fut", title: "Same-expiry future and its basis to spot" }, h("span", { class: "ctx-main" }, h("span", { class: "ctx-k" }, futK), h("b", {}, futV), futB));
  const ivV = document.createTextNode(DASH);
  const ivItem = h("span", { class: "ctx-item ctx-iv", title: "ATM IV: average of the ATM call and put IV" }, h("span", { class: "ctx-main" }, h("span", { class: "ctx-k" }, "ATM IV"), h("b", {}, ivV)));
  // The Strategy Builder's line also carries the expected move (±1σ to expiry).
  const sigV = document.createTextNode(DASH);
  const sigItem = h("span", { class: "ctx-item ctx-sig", title: "Expected move: ±1σ to expiry at ATM IV" }, h("span", { class: "ctx-main" }, h("span", { class: "ctx-k" }, "±1σ"), h("b", {}, sigV)));
  /** A solid red pill only when orders would go to a live broker account (paper shows nothing). */
  const liveOrders = h("span", { class: "ctx-live-orders", hidden: true, title: "Orders from this page go to a live broker account" }, "LIVE orders");
  // Tablets and phones: the one demo indicator is a small "Demo" pill of its own before the live control (a safety
  // marker, not a badge on ⋯ that reads as a count). Desktop has the toolbar's own Demo pill.
  // Phones (< 720 px): the Demo word folds into ⋯ (an amber dot on it, the explanation in its sheet; ui-pass-3.md §6).
  const moreBtn = h("button", { type: "button", class: "icon-btn ctx-more", "aria-haspopup": "dialog", "aria-label": `More: account, trading readiness, refresh, search, theme${app.state.demo ? ", demo data" : ""}`, onclick: () => openCtxSheet() }, icon("more"), h("span", { class: "rd-more-dot", "aria-hidden": "true" }), app.state.demo ? h("span", { class: "demo-badge", "aria-hidden": "true" }) : null);
  const demoPill = app.state.demo ? h("span", { class: "ctx-demo", "data-demo-indicator": "", title: `Demo data: ${DEMO_EXPLAINER}` }, "Demo") : null;
  let ctxSig = "";
  let capsule = null;
  let ctxRo = null;
  /** Patch the top bar: underlying, expiry parts, spot ±change (flash on change), lot. */
  function drawCtx() {
    const x = lastX;
    const c = st.chain;
    const e = st.expiry;
    const ex = st.expiries;
    const exTag = e && ex.length ? O.expiryTag(e, ex).days : "";
    const futs = st.futures.length ? new Set(st.futures.map((f) => f.expiry)) : null;
    const monthly = e && ex.length ? (futs ? futs.has(e) : O.isMonthlyExpiry(e, ex)) : false;
    // Positions covers every expiry (no chain of its own here): its lot is the underlying's futures lot.
    const lot = num(c?.lotSize) ?? (posPage ? num(posPage.lot?.()) : null);
    let spot = x?.spot ?? (c ? num(c.underlyingLtp) : null);
    let q = st.quotes.get(INDEX_SYMBOL[st.underlying] ?? "") ?? null;
    if (posPage) {
      const p = posPage.spot?.() ?? {};
      spot = p.spot ?? spot;
      q = p.quote ?? q;
    }
    // One source for the number and its change: the index quote when there is one (its ltp, change and % move
    // together), else the chain's spot with no change.
    const qLtp = num(q?.ltp);
    spot = qLtp ?? spot;
    const ch = qLtp === null ? null : num(q?.change);
    const chp = qLtp === null ? null : num(q?.changePct);
    const sig = JSON.stringify([st.underlying, e, exTag, monthly, lot, spot, ch, chp, device().phone]);
    if (kind === "chain" || kind === "strategy") drawCtxChain(spot);
    if (sig === ctxSig) return;
    const prevSpot = Number(spotItem.dataset.v);
    ctxSig = sig;
    if (uMain.data !== st.underlying) uMain.data = st.underlying;
    const spotText = spot === null ? DASH : formatFixed(spot, 2);
    const uSubText = spot === null ? "" : spotText;
    const uChgText = spot === null || chp === null ? "" : ` ${formatSigned(chp, 2)}%`;
    if (uSub.data !== uSubText) uSub.data = uSubText;
    if (uChg.data !== uChgText) uChg.data = uChgText;
    const day = e ? expiryText(e) : DASH;
    const mk = monthly ? "M" : "W";
    const long = e ? `${day} · ${exTag} · ${mk}` : DASH;
    if (eLong.data !== long) eLong.data = long;
    if (eShort.data !== day) eShort.data = day;
    // Phones: the reference chip beside the pill already reads "Lot 65" (and the chain's ATM IV tile carries it too),
    // so the expiry pill does not repeat it and keeps its width.
    const lotHere = lot && !device().phone;
    // Strategy on a phone: "3 Nov · 5d" only (the lot is in each leg's qty title; W / M would clip the pill).
    // OI and Volatility on a phone: "5d · lot 75" (the lot matters more there than W / M, and the pill must not clip it).
    const sub = !e ? "" : kind === "strategy" && device().phone ? exTag : (kind === "oi" || kind === "vol") && device().phone ? `${exTag}${lot ? ` · lot ${formatInt(lot)}` : ""}` : `${exTag} · ${mk}${lotHere ? ` · lot ${formatInt(lot)}` : ""}`;
    if (eSub.data !== sub) eSub.data = sub;
    if (spotV.data !== spotText) spotV.data = spotText;
    const chText = ch === null ? "" : `${formatSigned(ch, 2)}${chp !== null ? ` (${formatSigned(chp, 2)}%)` : ""}`;
    if (spotChg.textContent !== chText) spotChg.replaceChildren(...(ch === null ? [] : chp === null ? [formatSigned(ch, 2)] : [h("span", { class: "chg-abs" }, `${formatSigned(ch, 2)} `), `(${formatSigned(chp, 2)}%)`]));
    spotChg.className = `ctx-chg ${ch > 0 ? "up" : ch < 0 ? "down" : ""}`.trim();
    // The figure itself flashes (ink + a 2 px underline, chain.md §6), not the capsule segment behind it.
    if (spot !== null && Number.isFinite(prevSpot) && prevSpot !== spot) flashValue(spotItem.firstChild, spot > prevSpot ? "up" : "down");
    spotItem.dataset.v = spot === null ? "" : String(spot);
    const lotText = lot ? formatInt(lot) : DASH;
    if (lotV.data !== lotText) lotV.data = lotText;
    lotItem.title = lot ? "Lot size" : "Lot size unavailable";
    refChipEl.update();
    fitCtxIfNeeded();
  }
  let ctxChainSig = "";
  /** The chain's extra figures on the line: Fut (or F, synthetic) with its basis, ATM IV, the LIVE-orders pill. */
  function drawCtxChain(spot) {
    const x = lastX;
    const fut = x?.sameFut ?? null;
    const fwd = fut ? num(fut.ltp) : x?.F ?? null;
    const basis = fwd !== null && spot !== null ? fwd - spot : null;
    const a = account();
    const live = Boolean(a && a.broker !== "paper" && a.liveAllowedByConfig);
    const sig = JSON.stringify([fut ? 1 : 0, fwd, basis, x?.sm.atmIv, live, x?.move ?? null]);
    if (sig === ctxChainSig) return;
    ctxChainSig = sig;
    sigV.data = isFigure(x?.move) ? formatInt(Math.round(x.move)) : DASH;
    futK.data = fut ? "Fut" : "F";
    futV.data = fwd === null ? DASH : formatFixed(fwd, 1);
    futB.textContent = basis === null ? "" : `(${formatSigned(basis, 1)})`;
    futItem.title = fut ? "Same-expiry future and its basis to spot" : "Synthetic forward from put-call parity (no future is listed for this expiry) and its basis to spot";
    ivV.data = formatPercent(x?.sm.atmIv ?? null, 2);
    liveOrders.hidden = !live;
    fitCtxIfNeeded();
  }
  /** Drop the line's figures in order (ATM IV, Lot, the basis, Fut / F, the absolute change) until it fits. */
  const CTX_DROP = ["d-sig", "d-iv", "d-lot", "d-basis", "d-fut", "d-chg"];
  let ctxFitSig = "";
  /** Refit only when the line's text lengths or its width changed: the figures are tabular, so a new price of the
   *  same length takes the same room. Each pass below forces a layout, which made every refresh a long task. */
  function fitCtxIfNeeded() {
    const cap = capsule;
    if (!cap?.isConnected) return;
    const sig = String(cap.textContent.length);
    if (sig === ctxFitSig) return;
    ctxFitSig = sig;
    // In the next frame, after every write of this refresh: one layout instead of one per figure. Width changes
    // come through ctxRo (a ResizeObserver).
    if (ctxFitFrame) return;
    ctxFitFrame = requestAnimationFrame(() => {
      ctxFitFrame = 0;
      fitCtx();
    });
  }
  let ctxFitFrame = 0;
  function fitCtx() {
    const cap = capsule;
    if (!cap?.isConnected || (kind !== "chain" && kind !== "strategy")) return;
    cap.classList.remove(...CTX_DROP);
    // The page pill is always its icon here (the sidebar and the tab bar name the page), in every state, so the line
    // never shifts when the data arrives; then figures drop.
    document.querySelector(".toolbar-title")?.classList.add("icon-only");
    for (const c of CTX_DROP) {
      if (cap.scrollWidth <= cap.clientWidth + 1) break;
      cap.classList.add(c);
    }
  }
  /** Phones and tablets: account, refresh, live, search, theme and (in demo mode) what the demo data is. */
  let ctxSheet = null;
  function openCtxSheet() {
    // One sheet per trigger: a second click on ⋯ closes it instead of stacking another.
    if (ctxSheet) return ctxSheet.close();
    const home = aSel.parentNode;
    const next = aSel.nextSibling;
    const theme = document.documentElement.getAttribute("data-theme") ?? "auto";
    const body = h(
      "div",
      { class: "ctx-sheet" },
      TRADING.has(kind) && tradable.length ? h("label", { class: "field" }, "Orders go to", h("span", { class: "ctx-row" }, aSel, acctBadge)) : null,
      h("div", { class: "ctx-row" }, h("span", {}, "Lot size"), h("strong", {}, lotV.data)),
      app.state.demo ? h("p", { class: "ctx-demo-note" }, h("span", { class: "pill demo" }, "Demo"), h("span", {}, DEMO_EXPLAINER)) : null,
      // Trading readiness: the toolbar badge folds away here on tablets and phones (docs/spec/p1-05-readiness.md §6.5).
      readinessSheetRow(() => sheetRef?.close(), moreBtn),
      h(
        "div",
        { class: "ctx-acts" },
        h("button", { type: "button", class: "small", onclick: () => (sheetRef?.close(), refresh()) }, icon("refresh"), "Refresh"),
        h("button", { type: "button", class: "small", onclick: () => (sheetRef?.close(), toggleLive()) }, icon(st.live ? "pause" : "play"), st.live ? "Pause" : "Resume"),
        h("button", { type: "button", class: "small", onclick: () => (sheetRef?.close(), document.querySelector(".toolbar-search-m")?.click()) }, icon("search"), "Search"),
      ),
      h(
        "div",
        { class: "segmented", role: "group", "aria-label": "Appearance" },
        [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["auto", "Auto", "monitor"]].map(([v, label, ic]) => h("button", { type: "button", "data-theme-choice": v, "aria-pressed": String(theme === v) }, icon(ic), label)),
      ),
    );
    const sheetRef = (ctxSheet = sheetPopover({
      trigger: moreBtn,
      title: `${st.underlying} ${expiryText(st.expiry) || ""}`.trim(),
      body,
      onClose: () => {
        ctxSheet = null;
        if (home && aSel.parentNode !== home) home.insertBefore(aSel, next && next.parentNode === home ? next : null);
        if (home && acctBadge.parentNode !== home) home.append(acctBadge);
      },
    }));
  }
  function toggleLive() {
    st.live = !st.live;
    save();
    drawLive();
    syncLive();
    startTimer();
    if (st.live) refresh();
  }
  const drawLive = () => {
    drawClock();
    sheet?.update();
  };
  const statsEl = h("div", { class: `desk-stats sum-strip${kind === "chain" ? " chain-kpis" : ""}`, role: "group", "aria-label": "Chain summary" });
  const chainEl = h("div", { class: "desk-chain" });
  const keysEl = h(
    "div",
    { class: "desk-keys" },
    KEY_LEGEND.map(([keys, short]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), short)),
  );
  let sheet = null;
  /** "Open in chain" from the OI page (`jump`) or the Option Screener (`focus`): the chain focuses this strike once,
   *  scrolled to the middle of the table, then forgets it. save() never writes either key. */
  const handoff = prefs.focus ?? prefs.jump;
  let jump = kind === "chain" && handoff && typeof handoff === "object" ? handoff : null;
  if (prefs.jump || prefs.focus) {
    const { jump: _drop, focus: _drop2, ...rest } = prefs;
    local.set(SLOT, JSON.stringify(rest));
  }
  const oiPage = kind === "oi" ? createOiPage({ st, save, retry: () => reloadAll(), openInChain, demo: () => Boolean(app.state.demo) }) : null;
  // Positions and risk (positions.js): its own data (every expiry, futures, funds); desk.js keeps the toolbar and timer.
  const posPage =
    kind === "positions"
      ? createPositionsPage({
          st,
          save,
          account,
          openTicket: (o) => openTicket(o),
          onClock: () => (drawClock(), drawCtx()),
          openInChain: (expiry, strike, side) => {
            st.expiry = expiry;
            openInChain(strike, side);
          },
          setUnderlying: (u) => {
            if (!list.includes(u)) return toast(`${u} is not on this desk's list`, { tone: "info" });
            st.underlying = u;
            uSel.value = u;
            save();
            reloadAll();
          },
        })
      : null;
  // Volatility (vol.js): the other expiries' chains, futures and history are its own; desk.js keeps the selected chain.
  const volPage = kind === "vol" ? createVolPage({ st, save, selectExpiry, retry: () => reloadAll() }) : null;
  // Arbitrage (arbitrage.js): figures, scanner, detail and order preview; desk.js keeps the chain, futures quotes and timer.
  const arbPage =
    kind === "arb"
      ? arbPanels({ st, save, account, openTicket: (o) => openTicket(o), sendOrders: (bodies, o) => sendOrders(bodies, o), selectExpiry, retry: () => reloadAll(), demo: () => Boolean(app.state.demo), onPositions: () => (location.hash = "#/positions") })
      : null;
  /** Select an expiry as the toolbar does (the Volatility page's term table and curve). */
  function selectExpiry(e) {
    if (!st.expiries.includes(e) || e === st.expiry) return;
    eSel.value = e;
    eSel.dispatchEvent(new Event("change"));
  }
  function openInChain(strike, side) {
    save();
    local.set(SLOT, JSON.stringify({ ...readPrefs(), jump: { underlying: st.underlying, expiry: st.expiry, strike, side: side === "pe" ? "pe" : "ce" } }));
    location.hash = "#/chain";
  }

  // ── Data ──
  async function loadExpiries() {
    const seq = ++st.seq;
    eSel.disabled = true;
    try {
      const r = await api(`/v1/expiries?underlying=${encodeURIComponent(st.underlying)}`);
      if (seq !== st.seq) return false;
      const ex = r.data.data?.expiries ?? [];
      if (!ex.length) {
        // A normal state, not an error: nothing is listed to show.
        eSel.replaceChildren(h("option", { value: "" }, "No expiries"));
        st.chain = null;
        st.error = null;
        st.freshness = null;
        st.ms = null;
        st.empty = `No upcoming expiries for ${st.underlying}.`;
        drawAll();
        return false;
      }
      st.empty = null;
      if (!ex.includes(st.expiry)) st.expiry = ex[0];
      st.expiries = ex;
      drawExpiryOptions();
      eSel.disabled = false;
      oiPage?.expiriesLoaded();
      volPage?.expiriesLoaded();
      return true;
    } catch (err) {
      if (seq !== st.seq) return false;
      eSel.replaceChildren(h("option", { value: "" }, "No expiries"));
      st.chain = null;
      st.empty = null;
      st.error = err;
      drawAll();
      return false;
    }
  }
  /** The expiry picker. "M" marks a monthly expiry: one with a listed future when the futures are known (the last
   *  expiry in a truncated list is not necessarily the monthly), else the last expiry of its month. */
  function drawExpiryOptions() {
    const ex = st.expiries;
    const futs = st.futures.length ? new Set(st.futures.map((f) => f.expiry)) : null;
    const monthly = (e) => (futs ? futs.has(e) : O.isMonthlyExpiry(e, ex));
    eSel.replaceChildren(...ex.map((e) => h("option", { value: e, selected: e === st.expiry }, `${expiryText(e)} · ${O.expiryTag(e, ex).days} · ${monthly(e) ? "M" : "W"}`)));
    drawExpStrip();
  }
  /** Desktop and tablet: the next six expiries as chips under the line ("3 Nov 5d", "27 Nov 29d M"); phones keep the select. */
  const expStrip = h("div", { class: "exp-strip", role: "group", "aria-label": "Expiry" });
  function drawExpStrip() {
    if (kind !== "chain") return;
    const ex = st.expiries;
    const futs = st.futures.length ? new Set(st.futures.map((f) => f.expiry)) : null;
    const list = ex.slice(0, 6);
    if (st.expiry && !list.includes(st.expiry)) list.push(st.expiry);
    const sig = JSON.stringify([list, st.expiry, futs ? [...futs] : null]);
    if (expStrip.__sig === sig) return;
    expStrip.__sig = sig;
    expStrip.replaceChildren(
      ...list.map((e) => {
        const m = futs ? futs.has(e) : O.isMonthlyExpiry(e, ex);
        const on = e === st.expiry;
        return h("button", { type: "button", class: "chip-btn exp-chip", "aria-pressed": String(on), title: `${expiryText(e)} · ${O.expiryTag(e, ex).days} to expiry${m ? " · monthly" : ""}`, onclick: () => selectExpiry(e) }, h("span", { class: "ec-d" }, expiryText(e)), h("span", { class: "ec-t" }, `${O.expiryTag(e, ex).days}${m ? " · M" : ""}`));
      }),
    );
  }
  /** The underlying's futures (once per underlying): the same-expiry one is the arbitrage reference. */
  async function loadFutures() {
    const u = st.underlying;
    const r = await optional(api(`/v1/instruments/search?q=${encodeURIComponent(u)}&kind=FUT&underlying=${encodeURIComponent(u)}`));
    if (u !== st.underlying) return;
    st.futures = (r.data?.data ?? []).filter((f) => f.kind === "FUT" && f.underlying === u && /^\d{4}-\d{2}-\d{2}$/.test(f.expiry ?? "")).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    if (st.futures.length && st.expiries.length) drawExpiryOptions();
  }
  /** The index and its futures, for the spot row: a failed call leaves the page as it was. */
  async function loadQuotes() {
    const syms = [INDEX_SYMBOL[st.underlying], ...st.futures.map((f) => f.symbol)].filter(Boolean);
    if (!syms.length) return;
    const r = await optional(api(`/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}`));
    st.quotesError = r.error ?? null;
    if (r.error) return;
    for (const q of r.data?.data ?? []) if (q?.symbol) st.quotes.set(q.symbol, q);
  }
  async function loadChain({ draw = true } = {}) {
    if (!st.expiry) return;
    const seq = st.seq;
    const t0 = performance.now();
    try {
      // The Volatility page recomputes IVs and deltas itself (no server Greeks); every page loads the index quote,
      // which the top bar's spot and its change come from.
      const strikes = kind === "oi" ? OI_FETCH_STRIKES : kind === "vol" ? VOL_STRIKES : FETCH_STRIKES;
      const [r] = await Promise.all([api(`/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(st.expiry)}&strikes=${strikes}&greeks=${kind === "vol" ? "false" : "true"}&ivModel=b76-forward`), loadQuotes()]);
      if (seq !== st.seq) return;
      st.chain = r.data.data;
      st.freshness = r.data.data?.freshness ?? r.data.meta?.freshness ?? null;
      st.ms = Math.round(performance.now() - t0);
      st.error = null;
      st.lastOk = new Date().toISOString();
      syncLive();
      if (store && st.chain) store.offer(st.chain, Date.now(), { demo: Boolean(app.state.demo), session: refSession(st.ref), isTradingDay: refCalendar(st.ref).isTradingDay }).catch(() => {});
    } catch (err) {
      if (seq !== st.seq) return;
      st.error = err;
    }
    if (draw) drawAll();
  }
  // ── Live ticks (live.js): between refreshes the legs on screen, the index and its futures stream in over the one
  // shared connection. The Bridge then builds this page's chain reads from the same ticks (no broker call), so the
  // refresh below costs the broker nothing while the stream is up. The chain and the Strategy Builder redraw on each
  // frame that brought ticks, OI Analysis at most once a second. Greeks stay from the last refresh (a few seconds).
  const LIVE_KINDS = new Set(["chain", "strategy", "oi"]);
  const feed = LIVE_KINDS.has(kind) ? watch([], "quote", (ticks) => applyTicks(ticks)) : null;
  /** canonical symbol -> [row index, "ce" | "pe"] for the chain on screen */
  let legIndex = new Map();
  function syncLive() {
    if (!feed) return;
    if (!st.live || !st.chain) return feed.update([]);
    legIndex = new Map();
    st.chain.rows.forEach((r, i) => {
      if (r.ce?.symbol) legIndex.set(r.ce.symbol, [i, "ce"]);
      if (r.pe?.symbol) legIndex.set(r.pe.symbol, [i, "pe"]);
    });
    const idx = INDEX_SYMBOL[st.underlying];
    feed.update([...(idx ? [idx] : []), ...st.futures.map((f) => f.symbol).filter(Boolean), ...legIndex.keys()]);
  }
  /** A tick's OI is taken only when it is plainly in the same unit as the chain's (within 2x), else left as it was. */
  const sameUnit = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 && a / b < 2 && a / b > 0.5;
  function applyTicks(ticks) {
    if (!st.chain || !st.live) return;
    let rows = null;
    let newest = 0;
    for (const [sym, t] of ticks) {
      if (Number.isFinite(t.receivedAt)) newest = Math.max(newest, t.receivedAt);
      const at = legIndex.get(sym);
      if (at) {
        rows ??= st.chain.rows.slice();
        const [i, side] = at;
        const row = rows[i] === st.chain.rows[i] ? { ...rows[i] } : rows[i];
        const leg = row[side];
        if (!leg) continue;
        const next = { ...leg };
        if (isFigure(t.ltp)) next.ltp = t.ltp;
        if (isFigure(t.bid)) next.bid = t.bid;
        if (isFigure(t.ask)) next.ask = t.ask;
        if (isFigure(t.volume)) next.volume = t.volume;
        if (isFigure(t.change)) next.change = t.change;
        if (isFigure(t.oi) && sameUnit(t.oi, leg.oi)) {
          if (isFigure(leg.oiChange)) next.oiChange = leg.oiChange + (t.oi - leg.oi);
          next.oi = t.oi;
        }
        row[side] = next;
        rows[i] = row;
        continue;
      }
      if (sym === INDEX_SYMBOL[st.underlying] || st.futures.some((f) => f.symbol === sym)) {
        const q = st.quotes.get(sym) ?? { symbol: sym };
        st.quotes.set(sym, { ...q, ltp: t.ltp ?? q.ltp, change: t.change ?? q.change, changePct: t.changePct ?? q.changePct, bid: t.bid ?? q.bid, ask: t.ask ?? q.ask, oi: t.oi ?? q.oi, volume: t.volume ?? q.volume });
        if (sym === INDEX_SYMBOL[st.underlying] && isFigure(t.ltp)) {
          rows ??= st.chain.rows.slice();
        }
      }
    }
    if (!rows) return;
    const idxTick = ticks.get(INDEX_SYMBOL[st.underlying]);
    st.chain = { ...st.chain, rows, ...(idxTick && isFigure(idxTick.ltp) ? { underlyingLtp: idxTick.ltp } : {}) };
    if (newest) st.freshness = { ...(st.freshness ?? {}), asOf: new Date(newest).toISOString(), ageMs: 0, stale: false, source: "stream" };
    st.lastOk = new Date().toISOString();
    // The chain and the builder redraw on this frame; OI Analysis (it charts every strike) at most once a second.
    if (kind !== "oi") return drawAll();
    if (oiDrawTimer) return;
    const wait = Math.max(0, 1000 - (performance.now() - oiDrawnAt));
    oiDrawTimer = setTimeout(() => {
      oiDrawTimer = 0;
      oiDrawnAt = performance.now();
      if (pageRoot.isConnected) drawAll();
    }, wait);
  }
  let oiDrawTimer = 0;
  let oiDrawnAt = 0;

  async function loadPositions() {
    if (!st.account) return;
    const r = await optional(api(`/v1/positions?account=${encodeURIComponent(st.account)}`));
    const all = r.data?.data ?? [];
    st.positions = O.positionsFor(all, st.underlying);
    const fut = new RegExp(`^(NFO|BFO):${st.underlying.replace(/[^A-Z0-9&]/g, "")}-\\d{4}-\\d{2}-\\d{2}-FUT$`);
    st.futPositions = all.filter((p) => fut.test(String(p.symbol ?? "")) && Number(p.netQty));
    st.positionsError = r.error ?? null;
  }
  // ── Reference data (docs/spec/p1-02-reference.md §5): one bundle per underlying, re-read every 10 minutes ──
  // Volatility and Arbitrage price with the rate: the chip says where it comes from when it is a default or old.
  const refChipEl = refChip({ getBundle: () => st.ref, getLot: () => num(st.chain?.lotSize) ?? num(st.ref?.lots?.current), rate: kind === "vol" || kind === "arb" });
  const refBannersEl = refBanners({ onMore: () => refChipEl.open() });
  async function loadRef() {
    const u = st.underlying;
    // The reference bundle and the vol-time clock (GET /v1/vol/clock: every page prices on the Bridge's clock).
    const [b, clock] = await Promise.all([loadReference(u, { demoStale: Boolean(app.state.demo) && demoStaleAsked() }), loadPricingContext(u)]);
    if (u !== st.underlying) return;
    // Compare what the bundle says, not the object: a re-read fallback (or the same data) does not redraw the page.
    const changed = refSignature(b) !== refSignature(st.ref) || clock !== st.clock;
    st.ref = b;
    st.clock = clock;
    refChipEl.update();
    if (!changed) return;
    refBannersEl.update(b);
    posPage?.refChanged?.();
    volPage?.refChanged?.();
    arbPage?.refChanged?.();
    builder?.refChanged?.();
    oiPage?.refChanged?.();
  }
  const refresh = () => (loadRef(), posPage ? posPage.tick() : volPage ? Promise.all([loadChain(), volPage.tick()]) : arbPage ? Promise.all([loadChain({ draw: false }), arbPage.tick()]).then(() => drawAll()) : Promise.all([loadChain(), loadPositions(), oiPage?.tick()]));
  let timerMs = REFRESH_MS;
  let timerReady = false;
  /** The refresh period: one predicate (is the market open) for both startTimer and drawClock, so an error
   *  outside market hours cannot make them disagree and reset the interval every second. */
  const wantMs = () => (O.freshnessState({ marketOpen: st.freshness?.marketOpen, demo: Boolean(app.state.demo), session: refSession(st.ref) }).kind === "closed" ? CLOSED_REFRESH_MS : REFRESH_MS);
  const startTimer = () => {
    timerMs = wantMs();
    return st.live ? every(timerMs, refresh) : stopTimer();
  };
  async function reloadAll() {
    if (st.ref && st.ref.underlying !== st.underlying) st.ref = null;
    loadRef();
    if (posPage) {
      posPage.reset();
      return posPage.tick();
    }
    chain.reset();
    oiPage?.reset({ underlying: true });
    volPage?.reset({ underlying: true });
    arbPage?.reset({ underlying: true });
    sheet?.close();
    st.chain = null;
    st.focus = null;
    st.futures = [];
    st.quotes = new Map();
    drawAll();
    const ok = await loadExpiries();
    if (ok) {
      if (!volPage) await loadFutures();
      await refresh();
    } else if (!volPage) await loadPositions();
  }

  // ── OI-change window (chain): Day, or 1h / 15m from the snapshots recorded in this browser (oi-store.js) ──
  const store = kind === "chain" ? oiStore() : null;
  let winLock = false;
  const WIN_LABEL = { 60: "1h", 15: "15m" };
  /** The window to read and what each one can do now: { win, ref, avail }. */
  function chainWindow() {
    const c = st.chain;
    if (!store || !c) return null;
    const now = Date.now();
    const key = snapKey(c.underlying, c.expiry, now);
    let snaps = store.peek(key);
    if (!snaps) {
      store.list(key).then(() => st.chain && drawAll()).catch(() => {});
      snaps = [];
    }
    const open = refSession(st.ref).open;
    const avail = { 60: O.pickRef(snaps, now, "60", { open }), 15: O.pickRef(snaps, now, "15", { open }) };
    const want = st.cfg.oiWin;
    const ref = want !== "day" && avail[want]?.ok && avail[want].snap ? avail[want] : null;
    // The segmented shows the window in use; one not ready yet is disabled and its title says why.
    winLock = true;
    for (const b of winSeg.querySelectorAll("button")) {
      const a = avail[b.dataset.value];
      b.disabled = Boolean(a && !a.ok);
      b.title = a ? (a.ok ? `OI change ${a.label}` : `Collecting: ${a.reason}`) : "OI change since the previous close";
    }
    const eff = ref ? want : "day";
    if (winSeg.value !== eff) winSeg.value = eff;
    winLock = false;
    for (const o of winSel.options) {
      const a = avail[o.value];
      o.disabled = Boolean(a && !a.ok);
    }
    if (winSel.value !== eff) winSel.value = eff;
    const winOff = st.cfg.preset !== "oi" || device().phone;
    if (winSeg.hidden !== winOff) {
      winSeg.hidden = winOff;
      winSel.hidden = winOff;
      queueMicrotask(fitHead);
    }
    return { win: eff, ref, label: ref ? WIN_LABEL[eff] : null };
  }

  // ── Derived context for one draw ──
  function context() {
    const w = chainWindow();
    const c = w?.ref ? O.withOiWindow(st.chain, w.ref.snap) : st.chain;
    const sm = O.chainSummary(c);
    const ses = refSession(st.ref);
    const years = O.yearsToExpiry(c.expiry, Date.now(), ses.close);
    const growth = O.parityGrowth(O.calendarYearsToExpiry(c.expiry, Date.now(), ses.close), refRate(st.ref).value);
    const F = O.forwardPrice(c, growth) ?? sm.spot;
    const move = O.sigmaMove(F, sm.atmIv, years);
    const strikes = c.rows.map((r) => r.strike);
    const near = (v) => (v === null || v === undefined ? null : strikes.reduce((b, k) => (Math.abs(k - v) < Math.abs(b - v) ? k : b), strikes[0]));
    const b1 = O.sigmaBand(F, sm.atmIv, years, 1);
    const b2 = O.sigmaBand(F, sm.atmIv, years, 2);
    const lot = num(c.lotSize) || 1;
    // Same-expiry future = the arbitrage reference; else the chain's own forward (the spot row and the tile agree).
    const same = st.futures.find((f) => f.expiry === c.expiry);
    const sameQ = same ? st.quotes.get(same.symbol) : null;
    // Dev compares mids against the future's last price (or F); Edge trades the future at its touch.
    const ref = num(sameQ?.ltp) ?? F;
    const edgeRef = same ? (sameQ ? { bid: sameQ.bid, ask: sameQ.ask } : null) : F;
    // Position delta in units: held options of this expiry (chain deltas) plus held futures.
    let netDelta = 0;
    let own = false;
    for (const p of st.positions) {
      const o = O.parseOptionSymbol(p.symbol);
      if (!o || o.expiry !== c.expiry || !Number(p.netQty)) continue;
      const d = num(c.rows.find((r) => r.strike === o.strike)?.[o.right.toLowerCase()]?.delta);
      if (d === null) continue;
      netDelta += d * Number(p.netQty);
      own = true;
    }
    for (const p of st.futPositions) {
      netDelta += Number(p.netQty);
      own = true;
    }
    if (!own || Math.abs(netDelta) < 1e-9) netDelta = lot;
    const syn = new Map(c.rows.map((r) => [r.strike, O.synthetic(r, growth)]));
    const edge = new Map(c.rows.map((r) => [r.strike, O.parityEdge(r, edgeRef, growth)]));
    const devs = [...syn.values()].map((v) => v?.mid).filter((v) => v !== null && v !== undefined).map((v) => v - ref).sort((a, b) => a - b);
    // The Arb columns' shared scale (Dev bars) and the strike with the best edge (its "Best" / "Closest" chip).
    const devMax = devs.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    let bestEdge = null;
    for (const [k, e] of edge) if (e && isFigure(e.edge) && (!bestEdge || e.edge > bestEdge.edge)) bestEdge = { strike: k, edge: e.edge };
    const tops = (side) => new Map(O.topOi(c.rows, side, 3).map((t) => [t.strike, t.rank]));
    return {
      c,
      sm,
      years,
      F,
      move,
      spot: sm.spot,
      lot,
      targets: O.deltaTargets(c.rows),
      ranks: { ce: O.volumeRanks(c.rows, "ce"), pe: O.volumeRanks(c.rows, "pe") },
      hot: O.unusualVolume(c.rows),
      maxVol: c.rows.reduce((m, r) => Math.max(m, num(r.ce?.volume) ?? 0, num(r.pe?.volume) ?? 0), 0),
      held: heldLots(st.cfg.positions ? st.positions : [], lot),
      em1: { lo: near(b1?.lo), hi: near(b1?.hi) },
      em2: { lo: near(b2?.lo), hi: near(b2?.hi) },
      band1: b1,
      topOi: { ce: tops("ce"), pe: tops("pe") },
      ref: ref ?? null,
      refKind: num(sameQ?.ltp) !== null ? "fut" : "F",
      medianDev: devs.length ? devs[Math.floor(devs.length / 2)] : null,
      devMax,
      bestEdge,
      syn,
      edge,
      sameFut: same && num(sameQ?.ltp) !== null ? { expiry: same.expiry, ltp: sameQ.ltp } : null,
      indexQuote: st.quotes.get(INDEX_SYMBOL[c.underlying] ?? "") ?? null,
      netDelta,
      hedgeOwn: own,
      winLabel: w?.label ?? null,
      // Build-up over the window reads the price change over the same window.
      winQ: w?.ref ? (q) => q && { change: q.winChange, oiChange: q.oiChange } : (q) => q,
    };
  }

  let lastX = null;
  let enteredKey = null;
  let chainTools = null;
  /** The chain's tools act on a chain: switched off (inert, dimmed) while there is none. */
  function syncTools() {
    if (!chainTools) return;
    const off = !st.chain;
    if (chainTools.inert !== off) chainTools.inert = off;
    chainTools.classList.toggle("off", off);
  }
  function drawAll() {
    drawBody();
    drawCtx();
  }
  function drawBody() {
    if (arbPage) {
      arbPage.draw();
      drawClock();
      return;
    }
    if (volPage) {
      const t0 = performance.now();
      volPage.draw();
      st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
      drawClock();
      return;
    }
    drawClock();
    syncTools();
    // The key legend is for a chain on screen: none after a failed first load or with nothing listed.
    keysEl.classList.toggle("off", !st.chain && Boolean(st.error || st.empty));
    if (!st.chain) {
      chain.reset();
      lastX = null;
      if (kind !== "oi") drawStats(null);
      // Nothing loaded and the load failed: no strip of empty "--" tiles above the error card.
      showStats(!st.error);
      const waiting = !st.error && !st.empty;
      chainEl.toggleAttribute("aria-busy", waiting);
      chainEl.replaceChildren(
        st.error
          ? errorState(st.error, { onRetry: () => reloadAll() })
          : st.empty
            ? emptyState("clock", "No expiries", st.empty, null, { compact: true })
            : kind === "chain"
              ? chainSkeleton(`Loading the ${st.underlying} ${expiryText(st.expiry)} chain`)
              : loadingState({ rows: 12, cols: 7, label: `Loading the ${st.underlying} ${expiryText(st.expiry)} chain` }),
      );
      builder?.draw(null, { error: st.error, onRetry: () => reloadAll() });
      oiPage?.draw(null);
      return;
    }
    const t0 = performance.now();
    const x = context();
    lastX = x;
    if (kind !== "oi") drawStats(x);
    showStats(true);
    chainEl.removeAttribute("aria-busy");
    if (kind === "chain") {
      chain.draw(x);
      // Bars grow on the first draw of each chain (underlying + expiry), then only resize.
      const enterKey = `${x.c.underlying}|${x.c.expiry}`;
      if (enteredKey !== enterKey) {
        enteredKey = enterKey;
        barsEnter(chainEl);
      }
      if (jump) {
        if (jump.underlying === x.c.underlying && jump.expiry === x.c.expiry && x.c.rows.some((r) => r.strike === jump.strike)) {
          const side = jump.side === "pe" || jump.side === "PE" ? "pe" : "ce";
          if (!chain.jump(jump.strike, side)) {
            st.focus = { strike: jump.strike, side };
            chain.paintFocus(true, true);
          }
        }
        jump = null;
      }
      chain.note(st.error ? errorState(st.error, { onRetry: () => refresh(), lastGood: st.lastOk }) : null);
      st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
      sheet?.update();
      drawClock();
    }
    if (kind === "strategy") builder.draw(x, { stale: st.error ?? null, lastOk: st.lastOk ?? null, live: st.live, onRetry: () => refresh() });
    if (kind === "oi") {
      oiPage.draw(x);
      st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
      drawClock();
    }
  }
  let lastTick = null;
  /** The live control (text nodes only), the dot's pulse per successful load, and the timer period: 30 s while the
   *  market is shut. */
  function drawClock() {
    const f = O.freshnessState({ asOf: st.freshness?.asOf ?? null, stale: Boolean(st.freshness?.stale), marketOpen: st.freshness?.marketOpen, error: Boolean(st.error), live: st.live, refreshMs: REFRESH_MS, demo: Boolean(app.state.demo), session: refSession(st.ref) });
    liveBtn.update({ kind: f.kind, asOf: st.freshness?.asOf ?? st.lastOk, ageMs: f.ageMs, source: st.freshness?.accountId ?? null, live: st.live });
    if (st.lastOk && st.lastOk !== lastTick && f.kind !== "error") {
      lastTick = st.lastOk;
      liveBtn.tick();
    }
    // Stale or failing data dims to 0.7 (§9) so old prices do not read as live; the live control says why.
    const content = document.getElementById("content");
    const staleNow = (f.kind === "stale" || f.kind === "error") && Boolean(st.lastOk);
    if (content && content.hasAttribute("data-stale") !== staleNow) content.toggleAttribute("data-stale", staleNow);
    // The chain says so in its head too: an amber "Stale · 12 s old" pill (no bar across the panel).
    if (stalePill.hidden === staleNow) stalePill.hidden = !staleNow;
    if (staleNow) {
      const t = `${f.kind === "error" ? "Not updating" : "Stale"}${f.ageMs === null ? "" : ` · ${ageText(f.ageMs)}`}`;
      if (staleText.data !== t) staleText.data = t;
    }
    const today = O.isExpiryDay(st.expiry);
    if (expiryChip.hidden === today) expiryChip.hidden = !today;
    if (st.live && timerReady && wantMs() !== timerMs) startTimer();
  }

  // ── Summary strip (built once, then patched) ──
  function tile(label, value, sub, { cls, title } = {}) {
    return h("div", { class: `desk-stat ${cls ?? ""}`.trim(), title }, h("span", { class: "label" }, label), h("span", { class: "value" }, value), h("span", { class: "sub" }, sub ?? " "));
  }
  const tiles = new Map();
  /** Show or hide the summary panel (with its movable-panel frame, once mounted). */
  const showStats = (on) => {
    for (const el of new Set([statsEl, statsEl.closest(".desk-panel"), statsEl.closest(".movable")])) if (el && el.hidden === on) el.hidden = !on;
  };
  /** One tile, patched in place. `n` + `fmt`: the figure counts up on its first real paint (after a page or
   *  underlying change) and flashes up / down when a later refresh changes it. */
  function setTile(key, label, value, sub, { cls, title, n = null, fmt = null, vcls = "", mv = null, mvSig = "" } = {}) {
    let t = tiles.get(key);
    if (!t || !statsEl.contains(t.el)) {
      const el = tile(label, value, sub, { cls, title });
      t = { el, label: el.children[0], value: el.children[1], sub: el.children[2], sig: "", n: null, painted: false, mv: null };
      // A micro-visual (64 × 16 SVG, decorative: the figures say the same) beside the value.
      if (mv) {
        t.mv = h("span", { class: "mv", "aria-hidden": "true" });
        el.classList.add("has-mv");
        el.append(t.mv);
      }
      tiles.set(key, t);
      statsEl.append(el);
    }
    if (t.mv && mv && t.mv.__sig !== mvSig) {
      t.mv.__sig = mvSig;
      mv(t.mv);
    }
    const sig = JSON.stringify([label, value, sub, title, vcls]);
    if (t.sig === sig) return;
    t.sig = sig;
    t.label.textContent = label;
    const ec = `desk-stat${cls ? ` ${cls}` : ""}${t.mv ? " has-mv" : ""}`;
    if (t.el.className !== ec) t.el.className = ec;
    const vc = `value${vcls ? ` ${vcls}` : ""}`;
    if (t.value.className !== vc) t.value.className = vc;
    const real = value !== DASH && Number.isFinite(n);
    if (real && !t.painted && fmt) countUp(t.value, 0, n, fmt, value);
    else {
      stopCount(t.value);
      if (real && t.painted && t.value.textContent !== value && Number.isFinite(t.n) && n !== t.n) flashValue(t.value, n > t.n ? "up" : "down");
      t.value.textContent = value;
    }
    if (real) t.painted = true;
    else if (value === DASH) t.painted = false;
    t.n = real ? n : null;
    t.sub.textContent = sub || " ";
    t.el.title = title ?? (sub ? `${label}: ${value} · ${sub}` : "");
  }
  function drawStats(x) {
    if (kind === "chain") return drawChainStats(x);
    if (!x) {
      for (const [k, l] of [["fut", "Future"], ["iv", "ATM IV"], ["em", "Expected move"], ["straddle", "Straddle"], ["pcr", "PCR"], ["mp", "Max Pain"], ["pw", "Put wall"], ["cw", "Call wall"]]) setTile(k, l, DASH, "", { cls: k === "fut" ? "t-fut" : "" });
      return;
    }
    const { sm, c, F, move } = x;
    const day = O.sigmaMove(F, sm.atmIv, O.tradingDayYears());
    const t = O.timeToExpiry(c.expiry, Date.now(), refSession(st.ref).close);
    const n = c.rows.length;
    const pcrWord = O.pcrBand(sm.pcr)?.word ?? "";
    const fut = x.sameFut;
    // The spot is in the top bar: this tile is the future (or the synthetic forward) and its basis to spot.
    const fwd = fut ? num(fut.ltp) : F;
    setTile(
      "fut",
      fut ? "Future" : "Synthetic F",
      fwd === null ? DASH : formatFixed(fwd, fut ? 2 : 0),
      `${num(c.lotSize) ? "" : "lot size unavailable · "}${fwd !== null && sm.spot !== null ? `Basis ${formatSigned(fwd - sm.spot, 1)}` : ""}`,
      { cls: "t-fut", title: `${fut ? "The same-expiry future and its basis to spot" : "Synthetic future from put-call parity (K + (C − P)·e^(rT)); no future is listed for this expiry"}` },
    );
    setTile("iv", "ATM IV", formatPercent(sm.atmIv, 2), day ? `1 trading day ±${formatInt(day)}` : t.label, { title: `Average of the ATM call and put IV; the 1σ move over one trading day it implies. ${clockNote().join(" ")}`, n: sm.atmIv, fmt: (v) => formatPercent(v, 2), vcls: "ink-iv" });
    setTile("em", "Expected move", move ? `±${formatInt(move)}` : DASH, x.band1 ? `${formatInt(x.band1.lo)} – ${formatInt(x.band1.hi)}` : "", { title: `Log-normal 1σ band to expiry at ATM IV (${t.label}): about 68% of outcomes land inside` });
    setTile("straddle", "Straddle", formatFixed(sm.straddle, 2), sm.straddle && sm.spot ? `${formatPercent((sm.straddle / sm.spot) * 100, 2)} of spot` : "", { title: "ATM call + put. The market's price for a move either way", n: sm.straddle, fmt: (v) => formatFixed(v, 2) });
    setTile("pcr", "PCR", formatFixed(sm.pcr, 2), `Net OI chg ${formatCompact(sm.netOiChange, { signed: true })}`, {
      n: sm.pcr,
      fmt: (v) => formatFixed(v, 2),
      vcls: pcrSide(sm.pcr) === "put" ? "ink-pos" : pcrSide(sm.pcr) === "call" ? "ink-neg" : "",
      title: `Put OI ÷ call OI over the ${formatInt(n)} strikes loaded (±${FETCH_STRIKES} around ATM; ${pcrWord}). Net OI chg = put OI added − call OI added today${sm.pcrChange !== null ? ` (ratio ${formatFixed(sm.pcrChange, 2)})` : ""}. Volume PCR ${formatFixed(sm.pcrVolume, 2)}`,
    });
    setTile("mp", "Max Pain", formatInt(sm.maxPain), sm.maxPain !== null && sm.spot !== null ? `${formatSigned(sm.maxPain - sm.spot, 0)} from spot` : "", { title: `Settlement at which option buyers would collect the least, over the ${formatInt(n)} strikes loaded`, n: sm.maxPain, fmt: (v) => formatInt(v) });
    setTile("pw", "Put wall", formatInt(sm.support?.strike), sm.support ? `OI ${formatCompact(sm.support.oi)}` : "", { title: `Strike with the most put OI of the ${formatInt(n)} loaded`, vcls: "ink-put" });
    setTile("cw", "Call wall", formatInt(sm.resistance?.strike), sm.resistance ? `OI ${formatCompact(sm.resistance.oi)}` : "", { title: `Strike with the most call OI of the ${formatInt(n)} loaded`, vcls: "ink-call" });
  }

  /** A 64 × 16 SVG for a KPI tile (geometry only; every figure is text in the tile). */
  const svgNS = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  /** Expected move: the −1σ … +1σ range as a bar, a tick at spot and a quiet one at max pain. */
  function emViz(el, lo, hi, spot, mp) {
    const svg = sv("svg", { viewBox: "0 0 64 16", width: 64, height: 16, class: "mv-svg" });
    if (lo !== null && hi !== null && hi > lo) {
      const pad = (hi - lo) * 0.35;
      const a = lo - pad;
      const b = hi + pad;
      const X = (v) => r1(((Math.min(b, Math.max(a, v)) - a) / (b - a)) * 64);
      svg.append(sv("rect", { x: 0, y: 7, width: 64, height: 2, rx: 1, class: "mv-track" }), sv("rect", { x: X(lo), y: 5, width: r1(X(hi) - X(lo)), height: 6, rx: 3, class: "mv-band" }));
      if (mp !== null) svg.append(sv("rect", { x: r1(X(mp) - 0.75), y: 3, width: 1.5, height: 10, class: "mv-mp" }));
      if (spot !== null) svg.append(sv("rect", { x: r1(X(spot) - 1), y: 1, width: 2, height: 14, rx: 1, class: "mv-spot" }));
    }
    el.replaceChildren(svg);
  }
  /** PCR: a bar centred on 1 (0.5 … 1.5); below 1 it fills left in the call colour, above 1 right in the put colour. */
  function pcrViz(el, pcr) {
    const svg = sv("svg", { viewBox: "0 0 64 16", width: 64, height: 16, class: "mv-svg" });
    svg.append(sv("rect", { x: 0, y: 6, width: 64, height: 4, rx: 2, class: "mv-track" }));
    if (pcr !== null) {
      const v = Math.max(0.5, Math.min(1.5, pcr));
      const w = r1(Math.abs(v - 1) * 64);
      svg.append(sv("rect", { x: v < 1 ? 32 - w : 32, y: 5, width: Math.max(1, w), height: 6, rx: 2, class: v < 1 ? "mv-call" : "mv-put" }));
    }
    svg.append(sv("rect", { x: 31.5, y: 2, width: 1, height: 12, class: "mv-mid" }));
    el.replaceChildren(svg);
  }
  /** The chain's KPI strip (docs/design/chain.md §3.2): seven tiles; spot, the future and the lot are on the line. */
  function drawChainStats(x) {
    if (!x) {
      for (const [k, l] of [["iv", "ATM IV"], ["em", "Expected move"], ["straddle", "Straddle"], ["pcr", "PCR"], ["mp", "Max Pain"], ["pw", "Put wall"], ["cw", "Call wall"]]) setTile(k, l, DASH, "", { mv: k === "em" || k === "pcr" ? () => {} : null });
      for (const [k, l, cls] of WIDE_KPIS) setTile(k, l, DASH, "", { cls });
      return;
    }
    const { sm, c, F, move } = x;
    const day = O.sigmaMove(F, sm.atmIv, O.tradingDayYears());
    const t = O.timeToExpiry(c.expiry, Date.now(), refSession(st.ref).close);
    const n = c.rows.length;
    const pcrWord = O.pcrBand(sm.pcr)?.word ?? "";
    const phone = device().phone;
    const fut = x.sameFut;
    const fwd = fut ? num(fut.ltp) : F;
    const lot = num(c.lotSize);
    // Phones: the line has no room for the lot and the future, so the first tile's sub line carries them.
    const ivSub = phone ? `${lot ? `Lot ${formatInt(lot)}` : `Lot ${DASH}`}${fwd !== null ? ` · ${fut ? "Fut" : "F"} ${formatInt(fwd)}` : ""}` : day ? `1 trading day ±${formatInt(day)}` : t.label;
    // Foreground ink: on the chain violet means "put" (bars, header, the put wall), so IV takes no hue.
    setTile("iv", "ATM IV", formatPercent(sm.atmIv, 2), ivSub, { title: `Average of the ATM call and put IV${day ? `; 1σ move over one trading day ±${formatInt(day)}` : ""}. ${clockNote().join(" ")}`, n: sm.atmIv, fmt: (v) => formatPercent(v, 2) });
    setTile("em", "Expected move", move ? `±${formatInt(move)}` : DASH, x.band1 ? `${formatInt(x.band1.lo)} – ${formatInt(x.band1.hi)}` : "", {
      title: `Log-normal 1σ band to expiry at ATM IV (${t.label}): about 68% of outcomes land inside. Bar: the band, the tick is spot, the thin mark max pain`,
      mv: (el) => emViz(el, x.band1?.lo ?? null, x.band1?.hi ?? null, sm.spot, sm.maxPain),
      mvSig: JSON.stringify([x.band1?.lo, x.band1?.hi, Math.round(sm.spot ?? 0), sm.maxPain]),
    });
    const be = sm.straddle && sm.atm ? [sm.atm - sm.straddle, sm.atm + sm.straddle] : null;
    setTile("straddle", "Straddle", formatFixed(sm.straddle, 2), sm.straddle && sm.spot ? `${formatPercent((sm.straddle / sm.spot) * 100, 2)} of spot${be ? ` · BE ${formatInt(be[0])} – ${formatInt(be[1])}` : ""}` : "", { title: "ATM call + put: the market's price for a move either way; BE = the ATM strike ± the straddle", n: sm.straddle, fmt: (v) => formatFixed(v, 2) });
    setTile("pcr", "PCR", formatFixed(sm.pcr, 2), `Net OI chg ${formatCompact(sm.netOiChange, { signed: true })}`, {
      n: sm.pcr,
      fmt: (v) => formatFixed(v, 2),
      vcls: pcrSide(sm.pcr) === "put" ? "ink-pos" : pcrSide(sm.pcr) === "call" ? "ink-neg" : "",
      title: `Put OI ÷ call OI over the ${formatInt(n)} strikes loaded (±${FETCH_STRIKES} around ATM; ${pcrWord}). Bar: centred on 1, left (call colour) below, right (put colour) above. Net OI chg = put OI added − call OI added${x.winLabel ? ` (last ${x.winLabel})` : " today"}. Volume PCR ${formatFixed(sm.pcrVolume, 2)}`,
      mv: (el) => pcrViz(el, sm.pcr),
      mvSig: String(sm.pcr === null ? "" : Math.round(sm.pcr * 100)),
    });
    setTile("mp", "Max Pain", formatInt(sm.maxPain), sm.maxPain !== null && sm.spot !== null ? `${formatSigned(sm.maxPain - sm.spot, 0)} from spot` : "", { title: `Settlement at which option buyers would collect the least, over the ${formatInt(n)} strikes loaded`, n: sm.maxPain, fmt: (v) => formatInt(v) });
    const away = (k) => (k !== null && k !== undefined && sm.spot ? ((k - sm.spot) / sm.spot) * 100 : null);
    const wallSub = (w) => {
      if (!w) return "";
      const p = away(w.strike);
      return `OI ${formatCompact(w.oi)}${p === null ? "" : ` · ${formatPercent(Math.abs(p), 1)} ${p < 0 ? "below" : "above"} spot`}`;
    };
    setTile("pw", "Put wall", formatInt(sm.support?.strike), wallSub(sm.support), { title: `Strike with the most put OI of the ${formatInt(n)} loaded: support`, vcls: "ink-put" });
    setTile("cw", "Call wall", formatInt(sm.resistance?.strike), wallSub(sm.resistance), { title: `Strike with the most call OI of the ${formatInt(n)} loaded: resistance`, vcls: "ink-call" });
    // Wide screens (app.css section 16 shows them from 1600 and 1920 px): the future and its basis, call and put OI
    // with today's change, and the volume PCR. The figures exist already; a wide screen has room for them.
    const chg = (v) => `chg ${formatCompact(v, { signed: true })}`;
    setTile("fut", fut ? "Future" : "Synthetic F", fwd === null ? DASH : formatFixed(fwd, fut ? 2 : 0), fwd !== null && sm.spot !== null ? `Basis ${formatSigned(fwd - sm.spot, 1)}` : "", { cls: "kpi-wide", title: fut ? "The same-expiry future and its basis to spot" : "Synthetic future from put-call parity; no future is listed for this expiry" });
    setTile("ceoi", "Call OI", formatCompact(sm.ceOi), chg(sm.ceOiChange), { cls: "kpi-wide", vcls: "ink-call", title: `Call OI over the ${formatInt(n)} strikes loaded, and today's change` });
    setTile("peoi", "Put OI", formatCompact(sm.peOi), chg(sm.peOiChange), { cls: "kpi-xwide", vcls: "ink-put", title: `Put OI over the ${formatInt(n)} strikes loaded, and today's change` });
    setTile("vpcr", "Volume PCR", formatFixed(sm.pcrVolume, 2), `Calls ${formatCompact(sm.ceVolume)} · Puts ${formatCompact(sm.peVolume)}`, { cls: "kpi-xwide", title: "Put volume ÷ call volume today, over the strikes loaded" });
  }
  /** The chain's extra KPI tiles: [key, label, class] (shown from 1600 px, kpi-wide, and 1920 px, kpi-xwide). */
  const WIDE_KPIS = [["fut", "Future", "kpi-wide"], ["ceoi", "Call OI", "kpi-wide"], ["peoi", "Put OI", "kpi-xwide"], ["vpcr", "Volume PCR", "kpi-xwide"]];

  // ── The chain ──
  const effSideKey = () => (device().phone ? "phoneSide" : "side");
  const chain = createChain({
    st,
    host: chainEl,
    onSide: (side) => setCfg({ side }),
    onPhoneSide: (side) => setCfg({ phoneSide: side }),
    onTrade: (row, right, side) => openTicket({ row, right, side }),
    onFocus: (f) => {
      st.focus = f;
      chain.paintFocus(false, true);
    },
    onOpen: (strike, side) => openSheet(strike, side),
    onWindowAll: () => showAllStrikes(),
    onLeg: (leg) => addLeg(leg),
    onPick: (items, side) => openPicked(items, side),
    onRelayout: (f) => drawHidden(f),
    // The toolbar's Select button mirrors select mode however it changes (m, Esc, Done, a new expiry).
    onSelectChange: (on) => selectBtn.setAttribute("aria-pressed", String(on)),
    onHold: (strike, side) => holdLeg({ right: side === "pe" ? "PE" : "CE", strike, side: "BUY" }),
    // null on the last listed expiry: the empty state then shows no button that would do nothing.
    onNextExpiry: () => {
      const i = st.expiries.indexOf(st.expiry);
      if (i < 0 || i + 1 >= st.expiries.length) return null;
      return () => selectExpiry(st.expiries[i + 1]);
    },
  });
  /** Multi-select → Strategy Builder: the ticked contracts become legs of this expiry's basket, then the builder opens. */
  function openPicked(items, side) {
    if (!items.length) return;
    const legs = basket();
    let n = 0;
    for (const it of items) {
      const right = it.side === "ce" ? "CE" : "PE";
      const same = legs.find((l) => (l.kind ?? "OPT") === "OPT" && l.strike === it.strike && l.right === right && l.side === side && (l.entry === undefined || l.entry === null));
      if (same) same.lots += 1;
      else if (legs.length >= O.MAX_LEGS) continue;
      else legs.push({ right, strike: it.strike, side, lots: 1, expiry: st.expiry });
      n += 1;
    }
    const skipped = items.length - n;
    save();
    chain.toggleSelect(false);
    toast(`${formatInt(n)} leg${n === 1 ? "" : "s"} added to Strategy Builder${skipped ? ` · ${formatInt(skipped)} not added: the strategy holds up to ${formatInt(O.MAX_LEGS)} legs` : ""}`);
    location.hash = "#/strategy";
  }
  /**
   * The chain head stays one row (chain.md §3.3): when it runs out of room, step by step the presets become a select
   * (they give way first, so search keeps its width), the Select / Customise labels fold to icons, search folds to its
   * button and the OI window becomes a compact select. The key
   * legend shows only on a panel of 900 px or more, and drops trailing keys that do not fit.
   */
  const HEAD_STEPS = ["ch-presets", "ch-icons", "ch-search", "ch-win"];
  function fitHead() {
    const t = chainTools;
    if (!t?.isConnected || !t.clientWidth) return;
    const head = t.parentNode;
    head.classList.remove(...HEAD_STEPS);
    const over = () => t.scrollWidth > t.clientWidth + 1 || [...t.children].some((el) => el.offsetWidth && el.scrollWidth > el.clientWidth + 1);
    for (const c of HEAD_STEPS) {
      if (!over()) break;
      head.classList.add(c);
    }
    const narrow = head.clientWidth < 900;
    if (keysEl.classList.contains("narrow") !== narrow) keysEl.classList.toggle("narrow", narrow);
    if (!narrow) {
      for (const p of keysEl.children) p.hidden = false;
      for (let i = keysEl.children.length - 1; i > 0 && keysEl.scrollWidth > keysEl.clientWidth + 1; i -= 1) keysEl.children[i].hidden = true;
    }
  }
  const headRo = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitHead()) : null;
  // "+N hidden": the columns the fit engine left out at this width; a click opens Customise.
  const hiddenChip = h("button", { type: "button", class: "small hidden-chip", hidden: true, onclick: () => openCustomise() });
  const COL_NAME = (k) => (k === "quotes" ? "Bid / Ask" : CHAIN_COLUMNS.find((c) => c[0] === k)?.[1] ?? k);
  function drawHidden(f) {
    const n = f.hidden.length;
    if (hiddenChip.hidden !== !n) queueMicrotask(fitHead);
    hiddenChip.hidden = !n;
    const t = `+${formatInt(n)} hidden`;
    if (hiddenChip.textContent !== t) hiddenChip.textContent = t;
    hiddenChip.title = n ? `Hidden at this width: ${f.hidden.map(COL_NAME).join(", ")}. Customise to choose` : "";
  }
  let windowLock = false;
  function showAllStrikes() {
    if (st.strikesView === "all") return;
    windowLock = true;
    strikesSeg.value = "all";
    windowLock = false;
  }

  // ── Action sheet (tap a row on touch screens; Enter or double-click on desktop) ──
  /** Units the account holds long in options of this right and expiry (positions only: a basket leg is a plan, not cover). */
  function longQty(right, expiry) {
    let q = 0;
    for (const p of st.positions) {
      const o = O.parseOptionSymbol(p.symbol);
      if (o && o.right === right && o.expiry === expiry && Number(p.netQty) > 0) q += Number(p.netQty);
    }
    return q;
  }
  /** Advisory warnings (options.js tradeWarnings) for one contract and order. */
  function warningsFor({ strike, right, side, lots = 1, orderType = "LIMIT", exit = false, freezeQty = null, quote = null, lot: lotIn = null, expiry = null, spot: spotIn = null }) {
    const x = lastX && (!expiry || lastX.c.expiry === expiry) ? lastX : null;
    const row = x?.c.rows.find((r) => r.strike === strike);
    const s = right.toLowerCase();
    const leg = quote ?? row?.[s] ?? null;
    const spot = x?.spot ?? spotIn ?? null;
    const intrinsic = spot === null ? null : Math.max(0, right === "CE" ? spot - strike : strike - spot);
    const lot = lotIn ?? x?.lot ?? 1;
    return O.tradeWarnings({
      side,
      right,
      leg,
      lots,
      lot,
      freezeQty: freezeQty ?? freezeCache.get(leg?.symbol) ?? null,
      liq: x && row ? O.liquidityScore(leg, x.ranks[s].get(strike)) : null,
      stale: Boolean(st.freshness?.stale),
      isExpiryDay: O.isExpiryDay(expiry ?? x?.c.expiry ?? st.expiry),
      itm: O.inTheMoney(strike, s, spot),
      intrinsic,
      // Covered only when the long quantity covers the whole short.
      hasLongSameExpiry: longQty(right, expiry ?? x?.c.expiry ?? st.expiry) >= Math.max(1, Math.floor(Number(lots) || 1)) * lot,
      orderType,
      years: x?.years ?? null,
      exit,
    });
  }
  function openSheet(strike, side) {
    if (!st.chain) return;
    const s = side === "pe" ? "pe" : "ce";
    sheet = openChainSheet({
      strike,
      side: s,
      acct: () => acctPicker(() => sheet?.update()),
      underlying: st.underlying,
      read: (k, sd) => {
        const x = lastX;
        const row = x?.c.rows.find((r) => r.strike === k) ?? null;
        const q = row?.[sd] ?? null;
        const position = q ? st.positions.find((p) => p.symbol === q.symbol && Number(p.netQty)) ?? null : null;
        const right = sd === "ce" ? "CE" : "PE";
        if (q?.symbol) loadFreeze(q.symbol);
        let warnings = [];
        if (q && position) {
          // A held contract: the sheet's trade is the exit.
          warnings = warningsFor({ strike: k, right, side: Number(position.netQty) < 0 ? "BUY" : "SELL", exit: true });
        } else if (q) {
          // Fresh trade: what applies either way, then what applies only to one side, labelled with that side.
          const buy = warningsFor({ strike: k, right, side: "BUY" });
          const sell = warningsFor({ strike: k, right, side: "SELL" });
          const inBuy = new Set(buy.map((w) => w.code));
          const inSell = new Set(sell.map((w) => w.code));
          warnings = [
            ...buy.filter((w) => inSell.has(w.code)),
            ...buy.filter((w) => !inSell.has(w.code)).map((w) => ({ ...w, text: `If you buy: ${w.text}` })),
            ...sell.filter((w) => !inBuy.has(w.code)).map((w) => ({ ...w, text: `If you sell: ${w.text}` })),
          ];
        }
        return { x, row, q, position, name: contractName(st.underlying, x?.c.expiry ?? st.expiry, k, right), canTrade: Boolean(st.account), paused: !st.live, warnings };
      },
      onTrade: (k, sd, tradeSide) => {
        const row = st.chain?.rows.find((r) => r.strike === k);
        if (row) openTicket({ row, right: sd === "ce" ? "CE" : "PE", side: tradeSide });
      },
      onLeg: (k, sd, legSide) => addLeg({ right: sd === "ce" ? "CE" : "PE", strike: k, side: legSide }),
      onExit: (p) => exitPosition(p),
      onClose: (k, sd) => {
        sheet = null;
        if (st.chain?.rows.some((r) => r.strike === k)) {
          st.focus = { strike: k, side: sd };
          chain.paintFocus(false, true);
        }
      },
    });
  }
  /** Freeze quantity per symbol, from GET /v1/instruments/{symbol}, once per session. */
  function loadFreeze(symbol) {
    if (!symbol || freezeCache.has(symbol) || freezeLoading.has(symbol)) return;
    freezeLoading.add(symbol);
    optional(api(`/v1/instruments/${encodeURIComponent(symbol)}`)).then((r) => {
      freezeLoading.delete(symbol);
      const f = num(r.data?.data?.freezeQty);
      freezeCache.set(symbol, f);
      sheet?.update();
    });
  }

  // ── Positions (chain sheet and X: exit the contract you hold) ──
  function exitPosition(p) {
    const o = O.parseOptionSymbol(p.symbol);
    if (!o) return;
    const row = st.chain?.expiry === o.expiry ? st.chain.rows.find((r) => r.strike === o.strike) : null;
    openTicket({ row: row ?? { strike: o.strike, ce: null, pe: null }, right: o.right, side: Number(p.netQty) > 0 ? "SELL" : "BUY", qty: Math.abs(Number(p.netQty)), symbol: p.symbol, product: p.product, expiry: o.expiry, exit: true });
  }
  // ── Strategy builder (strategy.js; built once, patched on every tick) ──
  const builder =
    kind === "strategy"
      ? createBuilder({
          st,
          save,
          account,
          acctPicker: (onChange) => acctPicker(onChange),
          refresh: () => refresh(),
          onPositions: () => (location.hash = "#/positions"),
          switchTo: async (u, e) => {
            st.underlying = u;
            uSel.value = u;
            st.expiry = e;
            save();
            await reloadAll();
          },
        })
      : null;
  /** ⇧B / ⇧S on the chain and "Add to strategy" in the ticket: the same contract and side merge into one leg. */
  function addLeg(leg) {
    if (builder) return toast(builder.addLeg(leg) ?? "");
    const legs = basket();
    const same = legs.find((l) => (l.kind ?? "OPT") === "OPT" && l.strike === leg.strike && l.right === leg.right && l.side === leg.side && (l.entry === undefined || l.entry === null));
    if (same) same.lots += leg.lots ?? 1;
    else if (legs.length >= O.MAX_LEGS) return toast(`The strategy holds up to ${O.MAX_LEGS} legs`, { tone: "warn" });
    else legs.push({ right: leg.right, strike: leg.strike, side: leg.side, lots: leg.lots ?? 1, expiry: st.expiry });
    save();
    toast(`${leg.side === "BUY" ? "Buy" : "Sell"} ${formatInt(leg.strike)} ${leg.right} added to Strategy Builder`);
  }

  /** A press-and-hold on a chain row (touch): one buy lot of that contract into this expiry's strategy, with Undo. */
  function holdLeg(leg) {
    const legs = basket();
    const match = (l) => (l.kind ?? "OPT") === "OPT" && l.strike === leg.strike && l.right === leg.right && l.side === leg.side && (l.entry === undefined || l.entry === null);
    const same = legs.find(match);
    if (same) same.lots += 1;
    else if (legs.length >= O.MAX_LEGS) return toast(`The strategy holds up to ${O.MAX_LEGS} legs`, { tone: "warn" });
    else legs.push({ right: leg.right, strike: leg.strike, side: leg.side, lots: 1, expiry: st.expiry });
    save();
    const undo = () => {
      const now = basket();
      const i = now.findIndex(match);
      if (i < 0) return;
      if (now[i].lots > 1) now[i].lots -= 1;
      else now.splice(i, 1);
      save();
      toast("Removed from Strategy Builder");
    };
    toast(h("span", { class: "toast-undo-row" }, `Buy ${formatInt(leg.strike)} ${leg.right} added to Strategy Builder · `, h("button", { type: "button", class: "toast-undo", onclick: undo }, "Undo")));
  }

  // ── Order ticket ──
  /**
   * The order ticket. From the chain: `row` + `right`. From positions (any expiry, futures too): `quote` (a getter for
   * the live quote), `lotSize`, `units` (an odd quantity: the ticket works in units and sends `quantity`), `kind`, `name`
   * and `tick`. An exit starts as a LIMIT at mid rounded toward a fill, with 25 / 50 / 75 / 100 % chips.
   */
  async function openTicket({ row, right, side, qty, symbol, product, orderType = "LIMIT", expiry, exit = false, quote: quoteIn = null, units: oddUnits = false, lotSize: lotIn = null, kind = "OPT", name: nameIn = null, tick: tickIn = null, freezeQty = null, price: priceIn = null, held: heldIn = null, account: accountIn = null }) {
    // `account` presets the leg's own account (Positions All accounts / Family: every exit goes to that account).
    const a = accountIn ? tradable.find((x) => x.id === accountIn) ?? null : account();
    if (!a) return toast(accountIn ? `${accountIn} cannot place orders from this dashboard.` : "Choose an account that can place orders first.", { tone: "warn" });
    const c = st.chain;
    const ex = expiry ?? c?.expiry;
    const fut = kind === "FUT";
    const sym = symbol ?? row?.[right.toLowerCase()]?.symbol;
    if (!sym) return toast("This contract has no symbol in the chain.", { tone: "error" });
    const lotSize = num(lotIn) || num(c?.lotSize) || 1;
    const tick = num(tickIn) || 0.05;
    const quote = quoteIn ?? (() => (st.chain?.expiry === ex ? st.chain.rows.find((r) => r.strike === row.strike)?.[right.toLowerCase()] : row?.[right.toLowerCase()]) ?? null);
    const clientOrderId = `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // `qty` is the starting size; `held` (exits) the whole position, which the 25-100 % chips are measured from.
    const start = num(qty) ? Math.abs(num(qty)) : null;
    const held = num(heldIn) ? Math.abs(num(heldIn)) : start;
    const inUnits = Boolean(oddUnits) || (held !== null && held % lotSize !== 0) || (start !== null && start % lotSize !== 0);
    const sideSeg = segmented("Side", [["BUY", "Buy"], ["SELL", "Sell"]], side);
    const lots = inUnits
      ? h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(start ?? lotSize) })
      : h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(start ? Math.max(1, Math.round(start / lotSize)) : 1) });
    const lotHint = h("span", { class: "hint" });
    const typeSeg = segmented("Order type", [["LIMIT", "Limit"], ["MARKET", "Market"]], orderType === "MARKET" ? "MARKET" : "LIMIT");
    const midPx = (sd) => O.roundToTick(O.mid(quote()), tick, sd === "BUY" ? "buy" : "sell");
    const startPx = isFigure(priceIn) ? Number(priceIn) : exit ? midPx(side) ?? O.touchPrice(quote(), side, tick) : O.touchPrice(quote(), side, tick);
    const price = h("input", { type: "number", min: "0.05", step: String(tick), inputmode: "decimal", value: String(startPx ?? "") });
    const prodSeg = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Margin (NRML)"]], product === "MARGIN" || product === "CNC" ? "MARGIN" : "INTRADAY");
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand this sends a real order to ${a.label}.`);
    const quoteLine = h("div", { class: "ticket-quote" });
    // Advisory warnings from the chain (spread, liquidity, freeze qty, expiry day...): the server checks still decide.
    const warnEl = h("ul", { class: "ticket-checks ticket-warns", "aria-label": "Before you trade", hidden: true });
    // Lot-size confirmation (docs/spec/p1-02-reference.md §5.4): when the reference lot data is stale or disagrees
    // with the broker's contract, an order in lots needs this box ticked; the lot is then sent as lotSizeConfirmed.
    // Quantity in units needs no confirmation. Futures in lots get the same gate (the server checks FUT and OPT).
    // The gate is re-worked out on every 1 s tick (syncGate): the bundle may arrive after the ticket opened, or the
    // 10-minute re-read may turn the lots stale or into a conflict while it is open. Until the first bundle has
    // resolved, an order in lots waits ("Reading contract data") rather than going out unchecked. The bundle describes
    // the current contract only; the server checks each contract's own expiry, so a LOT_SIZE_STALE in the order
    // preview (serverLot) opens the gate too, with the server's reason.
    let serverLot = null;
    let gate = lotConfirmGate(st.ref, lotSize, { units: inUnits });
    const refPending = () => !inUnits && !st.ref;
    const gateBox = h("input", { type: "checkbox", required: true });
    const gateOk = () => !refPending() && (!gate.needed || gateBox.checked);
    const gateText = h("span", {}, gate.text);
    const gateRow = h(
      "div",
      { class: "ticket-lotgate", role: "group", "aria-label": "Lot size check" },
      h("label", { class: "check lot-gate" }, gateBox, gateText),
      h("button", { type: "button", class: "small plain lot-gate-units", onclick: () => ((reopen = { row, right, side: sideSeg.value, qty: units(), symbol, product: prodSeg.value, orderType: typeSeg.value, expiry, exit, quote: quoteIn, units: true, lotSize: lotIn, kind, name: nameIn, tick: tickIn, freezeQty, price: isFigure(price.value) ? Number(price.value) : priceIn, held: heldIn }), closeTicket?.(undefined, true)) }, "Enter quantity in units instead"),
    );
    gateRow.hidden = !gate.needed;
    let wasPending = refPending();
    const syncGate = () => {
      const g = lotConfirmGate(st.ref, lotSize, { units: inUnits, server: serverLot });
      const pending = refPending();
      if (g.needed === gate.needed && g.text === gate.text && pending === wasPending) return;
      // A new or changed question is asked afresh: an earlier tick does not carry over to different words.
      if (g.text !== gate.text) gateBox.checked = false;
      gate = g;
      wasPending = pending;
      gateText.textContent = g.text;
      gateRow.hidden = !g.needed;
      changed();
    };
    if (freezeQty === null) loadFreeze(sym);
    const units = () => (inUnits ? Math.max(1, Math.floor(Number(lots.value) || 1)) : Math.max(1, Math.floor(Number(lots.value) || 1)) * lotSize);
    const drawWarnings = () => {
      if (fut) return;
      const b = body();
      const w = warningsFor({ strike: row.strike, right, side: b.side, lots: inUnits ? units() / lotSize : b.lots, orderType: b.orderType, exit, quote: quote(), lot: lotSize, expiry: ex, freezeQty });
      const sig = JSON.stringify(w);
      if (warnEl.__sig === sig) return;
      warnEl.__sig = sig;
      warnEl.replaceChildren(...w.map((x) => h("li", { class: x.level }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, x.text))));
      warnEl.hidden = !w.length;
    };
    const previewEl = h("div", { class: "ticket-preview", "aria-live": "polite" });
    const touch = (k) => {
      const q = quote();
      if (!isFigure(q?.[k])) return;
      price.value = String(O.roundToTick(q[k], tick, sideSeg.value === "BUY" ? "buy" : "sell"));
      changed();
    };
    const priceField = h(
      "div",
      { class: "field" },
      h("span", {}, "Limit price"),
      h("div", { class: "price-row" }, price, h("div", { class: "join rect touch-btns", role: "group", "aria-label": "Use a quote" }, [["Bid", "bid"], ["Mid", "mid"], ["Ask", "ask"]].map(([l, k]) => h("button", { type: "button", class: "small", onclick: () => (k === "mid" ? ((price.value = String(midPx(sideSeg.value) ?? "")), changed()) : touch(k)) }, l)))),
    );
    // Exit size: 25 / 50 / 75 % as floor(lots · p) whole lots, 100 % the exact quantity held. A part that rounds to
    // 0 lots (a 1-lot leg at 50 %) is disabled, never widened to a full exit.
    const partLots = (pct) => (held === null ? 0 : Math.floor((Math.floor(held / lotSize) * pct) / 100 + 1e-9));
    const sizeFor = (pct) => {
      if (held === null) return null;
      if (pct >= 100) return inUnits ? held : Math.max(1, Math.round(held / lotSize));
      const l = partLots(pct);
      if (l < 1) return null;
      return inUnits ? l * lotSize : l;
    };
    const pctBtns = exit && held !== null ? [25, 50, 75, 100].map((p) => h("button", { type: "button", class: "small", "data-pct": String(p), "aria-pressed": String(p === 100), disabled: p < 100 && partLots(p) < 1, title: p < 100 && partLots(p) < 1 ? "Cannot split: less than one whole lot" : null, onclick: () => sizeFor(p) !== null && ((lots.value = String(sizeFor(p))), changed()) }, `${p}%`)) : [];
    const pctRow = pctBtns.length ? h("div", { class: "segmented pct-btns", role: "group", "aria-label": "Exit size" }, pctBtns) : null;
    const live = () => modeSeg?.value === "live";
    const body = () => {
      const b = { account: a.id, symbol: sym, side: sideSeg.value, product: prodSeg.value, orderType: typeSeg.value };
      if (inUnits) b.quantity = units();
      else b.lots = Math.max(1, Math.floor(Number(lots.value) || 1));
      if (typeSeg.value === "LIMIT" && isFigure(price.value)) b.price = Number(price.value);
      if (live()) b.mode = "live";
      if (gate.needed && gateBox.checked && b.lots !== undefined) b.lotSizeConfirmed = lotSize;
      return b;
    };
    let placeBtn = null;
    let last = null;
    const drawButton = () => {
      if (!placeBtn) return;
      const b = body();
      const blocked = (last?.checks ?? []).some((x) => x?.severity === "block");
      placeBtn.textContent = `${b.side === "BUY" ? "Buy" : "Sell"} ${inUnits ? `${formatInt(b.quantity)} qty` : `${formatInt(b.lots)} lot${b.lots === 1 ? "" : "s"}`}${live() ? " · LIVE" : ""}`;
      placeBtn.className = b.side === "BUY" ? "btn buy" : "btn sell";
      placeBtn.disabled = blocked || !gateOk() || (live() && !ack.checked) || (typeSeg.value === "LIMIT" && !isFigure(price.value));
    };
    const drawQuote = () => {
      const q = quote();
      const cell = (l, v, cls) => h("span", { class: cls }, h("small", {}, l), isFigure(v) ? formatFixed(v, 2) : DASH);
      quoteLine.replaceChildren(cell("Bid", q?.bid, "bid"), cell("LTP", q?.ltp), cell("Ask", q?.ask, "ask"), h("span", {}, h("small", {}, "IV"), fut ? DASH : formatFixed(q?.iv, 1)), h("span", {}, h("small", {}, "Δ"), fut ? "1.00" : formatFixed(q?.delta, 2)));
    };
    let previewSeq = 0;
    let previewTimer = null;
    async function preview() {
      const seq = ++previewSeq;
      const b = body();
      if (refPending()) {
        last = null;
        previewEl.replaceChildren(h("p", { class: "muted small pad" }, "Reading contract data"));
        return drawButton();
      }
      if (!gateOk()) {
        last = null;
        previewEl.replaceChildren(h("p", { class: "muted small pad" }, "Check the lot size above to see the order preview."));
        return drawButton();
      }
      if (b.orderType === "LIMIT" && b.price === undefined) {
        last = null;
        previewEl.replaceChildren(h("p", { class: "muted small pad" }, "Enter a limit price."));
        return drawButton();
      }
      try {
        const r = (await api("/v1/orders/preview", { method: "POST", body: b })).data.data;
        if (seq !== previewSeq) return;
        // A LOT_SIZE_STALE for this contract that the bundle did not show: ask for the confirmation (spec §5.4).
        const ls = b.lotSizeConfirmed === undefined ? lotStaleCheck(r.checks) : null;
        if (ls && !gate.needed) {
          serverLot = ls;
          syncGate();
          return;
        }
        last = r;
        const checks = [...(r.checks ?? [])].sort((x, y) => (x.severity === "block" ? -1 : 0) - (y.severity === "block" ? -1 : 0));
        // What this order risks before it is sent (an opening option order): max loss, breakeven at expiry and, for a
        // sell, the approximate margin. Before charges; the broker's own margin figure is final.
        const q0 = quote();
        const px = b.price ?? (b.side === "BUY" ? num(q0?.ask) : num(q0?.bid)) ?? num(q0?.ltp);
        const risk = !fut && !exit && row ? ticketRisk({ side: b.side, right, strike: row.strike, price: px, qty: r.quantity }) : null;
        const fwd = num(st.chain?.underlyingLtp);
        const mg = risk && b.side === "SELL" && fwd ? O.marginEstimate([{ strike: row.strike, right, side: "SELL", lots: Math.max(1, Math.round(r.quantity / lotSize)), lotSize, price: px }], lotSize, { forward: fwd }) : null;
        const lossText = risk ? (risk.maxLoss === null ? "Unlimited" : formatRupee(risk.maxLoss, 0)) : null;
        previewEl.replaceChildren(
          h(
            "div",
            { class: `ticket-figs${risk ? " with-risk" : ""}` },
            h("div", {}, h("small", {}, "Quantity"), `${formatInt(r.quantity)}`),
            h("div", {}, h("small", {}, b.side === "BUY" ? "You pay" : "You receive"), formatRupee(r.estimatedValue, 0)),
            risk ? h("div", { title: "The most this order can lose at expiry, before charges" }, h("small", {}, "Max loss"), h("span", { class: risk.maxLoss === null ? "down" : "" }, lossText)) : null,
            risk ? h("div", { title: "Where the underlying must settle at expiry for this order to break even, before charges" }, h("small", {}, "Breakeven"), formatFixed(risk.breakeven, 2)) : null,
            mg ? h("div", { title: "An estimate (price scan plus exposure). The broker's figure is final." }, h("small", {}, "Margin ≈"), formatRupee(mg.required, 0)) : null,
            // Paper is said once (the account); only a live order gets a Mode figure, in red.
            r.mode === "live" ? h("div", {}, h("small", {}, "Mode"), h("span", { class: "down" }, "LIVE")) : null,
          ),
          ...(checks.length ? [h("ul", { class: "ticket-checks" }, checks.map((x) => h("li", { class: x.severity === "block" ? "bad" : "warn" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, `${x.severity === "block" ? "Blocked: " : ""}${x.message}`))))] : []),
        );
      } catch (err) {
        if (seq !== previewSeq) return;
        last = null;
        previewEl.replaceChildren(alertBox(err));
      }
      drawButton();
    }
    const changed = () => {
      drawWarnings();
      const n = Math.max(1, Math.floor(Number(lots.value) || 1));
      lotHint.textContent = inUnits ? `odd quantity · lot ${formatInt(lotSize)}` : `${formatInt(n * lotSize)} qty`;
      for (const btn of pctBtns) btn.setAttribute("aria-pressed", String(sizeFor(Number(btn.dataset.pct)) === n && (Number(btn.dataset.pct) === 100 || sizeFor(100) !== n)));
      priceField.hidden = typeSeg.value !== "LIMIT";
      ackRow.hidden = !live();
      drawButton();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(preview, 200);
    };
    sideSeg.addEventListener("change", () => {
      const p = exit ? midPx(sideSeg.value) ?? O.touchPrice(quote(), sideSeg.value, tick) : O.touchPrice(quote(), sideSeg.value, tick);
      if (p !== null) price.value = String(p);
      changed();
    });
    for (const el of [typeSeg, prodSeg, modeSeg].filter(Boolean)) el.addEventListener("change", changed);
    for (const el of [lots, price]) el.addEventListener("input", changed);
    ack.addEventListener("change", drawButton);
    gateBox.addEventListener("change", changed);
    const quoteTimer = setInterval(() => (drawQuote(), drawWarnings(), syncGate()), 1000);
    drawQuote();

    const name = nameIn ?? contractName(c?.underlying ?? st.underlying, ex, row.strike, right);
    let closeTicket = null;
    // The chain has no account picker on its line: the ticket says where the order goes, and changing it reopens the
    // ticket for that account (its live / paper gates are per account).
    // Always shown on the chain, live-capable accounts too (their Paper / Live switch is a line of its own below).
    // The new ticket opens once this one has closed, with what was entered so far.
    let reopen = null;
    const acctField = pageKind === "chain" ? h("div", { class: "field" }, h("span", {}, "Orders go to"), acctPicker(() => {
      reopen = { row, right, side: sideSeg.value, qty: units(), symbol, product: prodSeg.value, orderType: typeSeg.value, expiry, exit, quote: quoteIn, units: oddUnits, lotSize: lotIn, kind, name: nameIn, tick: tickIn, freezeQty, price: isFigure(price.value) ? Number(price.value) : priceIn, held: heldIn };
      closeTicket?.(undefined, true);
    }, { label: false })) : null;
    const done = modal({
      title: exit ? `Exit ${name}` : name,
      body: (close) => (closeTicket = close) && h(
        "div",
        { class: "stack ticket" },
        quoteLine,
        // An exit's side is fixed (the other side would add to the position): a label, not a control.
        exit ? h("div", { class: "field" }, h("span", {}, "Side"), h("span", { class: "ticket-acct" }, side === "BUY" ? "Buy to close" : "Sell to close", h("span", { class: "muted small" }, "· to add, use the chain"))) : segField("Side", sideSeg),
        h("div", { class: "ticket-grid" }, h("label", { class: "field" }, h("span", {}, inUnits ? "Quantity " : "Lots ", lotHint), lots), segField("Type", typeSeg)),
        gateRow,
        pctRow,
        priceField,
        h("div", { class: "ticket-grid" }, segField("Product", prodSeg), acctField ?? h("div", { class: "field" }, h("span", {}, "Account"), h("span", { class: "ticket-acct one-line", title: a.label }, h("span", { class: "acct-name" }, a.label), modeSeg || /paper/i.test(a.label ?? "") ? null : h("span", { class: "acct-badge", "data-mode": "paper" }, "Paper")))),
        modeSeg ? segField("Mode", modeSeg) : null,
        ackRow,
        warnEl,
        previewEl,
      ),
      buttons: [
        ...(exit || fut ? [] : [{ label: "Add to strategy", cls: "plain", onClick: () => { addLeg({ right, strike: row.strike, side: sideSeg.value, lots: body().lots ?? 1 }); return "added"; } }]),
        { label: "Cancel", value: false },
        {
          label: "Place",
          cls: "primary",
          ref: (el) => (placeBtn = el),
          onClick: async () => {
            syncGate();
            if (!gateOk()) return (drawButton(), false);
            placeBtn.disabled = true;
            try {
              const r = (await api("/v1/orders", { method: "POST", body: { ...body(), clientOrderId } })).data.data;
              toast(`${r.status === "filled" ? "Filled" : cap(r.status)}: ${r.side} ${formatInt(r.quantity)} ${name}${isFigure(r.avgPrice) ? ` @ ${formatFixed(r.avgPrice, 2)}` : ""}${r.mode === "live" ? " · LIVE" : " · paper"}`);
              return "placed";
            } catch (err) {
              previewEl.replaceChildren(alertBox(err));
              drawButton();
              return false;
            }
          },
        },
      ],
    });
    changed();
    const result = await done;
    clearInterval(quoteTimer);
    clearTimeout(previewTimer);
    if (reopen) {
      // The account changed: a new ticket for it (its paper / live gates differ), unless the page has gone.
      if (pageRoot.isConnected && !document.querySelector("dialog[open]")) openTicket(reopen);
      return;
    }
    if (result === "placed") refresh();
    return result;
  }

  /**
   * Send order bodies one at a time through POST /v1/orders (every Bridge gate applies) and stop at the first refusal.
   * An unknown outcome is looked up by its client order id, never resent. `onStatus(i, "sending"|"sent"|"failed", error)`
   * reports progress. Resolves with { sent: [{ index, order }], failed: { index, error } | null }.
   */
  async function sendOrders(bodies, { onStatus = () => {}, tag = "mcbarb" } = {}) {
    const batch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const sent = [];
    for (const [i, b] of bodies.entries()) {
      const clientOrderId = `${tag}-${batch}-${i}`;
      onStatus(i, "sending");
      let order = null;
      try {
        order = (await api("/v1/orders", { method: "POST", body: { ...b, clientOrderId, tag } })).data.data;
      } catch (err) {
        if (err.network || err.code === "OUTCOME_UNKNOWN" || err.status >= 500) {
          const found = await optional(api(`/v1/orders/by-client-id/${encodeURIComponent(clientOrderId)}`));
          order = found.data?.data ?? null;
          if (!order) {
            const error = "Outcome unknown: check the order book before trying again";
            onStatus(i, "failed", error);
            return { sent, failed: { index: i, error } };
          }
        } else {
          onStatus(i, "failed", err.message);
          return { sent, failed: { index: i, error: err.message } };
        }
      }
      if (["rejected", "cancelled", "expired"].includes(order?.status)) {
        const error = order.statusMessage ?? `Order ${order.status}`;
        onStatus(i, "failed", error);
        return { sent, failed: { index: i, error } };
      }
      sent.push({ index: i, order });
      onStatus(i, "sent");
    }
    if (sent.length) refresh();
    return { sent, failed: null };
  }

  // ── Chain settings ──
  function setCfg(patch) {
    st.cfg = chainConfig({ ...st.cfg, ...patch });
    save();
    syncPreset();
    chain.reset(true);
    if (st.chain) drawAll();
  }
  let custom = null;
  function openCustomise() {
    if (custom) return custom.close();
    const say = h("div", { class: "sr-only", "aria-live": "polite" });
    let refocus = null;
    const sw = (label, get, set, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        draw();
      });
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const body = h("div", {});
    let draw = () => {
      const c = st.cfg;
      // One "Show" control: the one that applies at this width (phones keep their own side setting).
      const phone = device().phone;
      const sideSeg = segmented("Show", [["ce", "Calls"], ["pe", "Puts"], ["both", "Both"]], phone ? c.phoneSide : c.side);
      sideSeg.addEventListener("change", () => setCfg(phone ? { phoneSide: sideSeg.value } : { side: sideSeg.value }));
      const enabled = c.cols;
      const others = CHAIN_COLUMNS.map(([k]) => k).filter((k) => !enabled.includes(k));
      const label = (k) => CHAIN_COLUMNS.find(([x]) => x === k)?.[1] ?? k;
      const fit = chain.fitInfo();
      const hiddenSet = new Set(fit.hidden);
      const move = (k, d) => {
        const a = [...enabled];
        const i = a.indexOf(k);
        const j = i + d;
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        setCfg({ cols: a });
        // Keep the keyboard on the same button (or its twin when that one is now disabled at the end of the list).
        refocus = `[data-move="${k}|${j === 0 ? 1 : j === a.length - 1 ? -1 : d}"]`;
        draw();
        say.textContent = `${label(k)} moved to position ${j + 1}`;
      };
      const colRow = (k, on) =>
        h(
          "div",
          { class: `col-row ${on ? "on" : ""}${on && hiddenSet.has(k) ? " cut" : ""}`.trim(), draggable: on ? "true" : undefined, "data-col": k },
          on ? h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")) : h("span", { class: "grip" }),
          h("label", { class: "col-check" }, (() => {
            const i = h("input", { type: "checkbox" });
            i.checked = on;
            i.addEventListener("change", () => {
              const next = on ? enabled.filter((x) => x !== k) : [...enabled, k];
              if (!next.length) return draw();
              setCfg({ cols: next });
              draw();
            });
            return i;
          })(), h("span", { title: chain.colTitle(k) }, label(k), chain.isRowCol(k) ? h("small", { class: "col-scope" }, " per strike") : null, on && hiddenSet.has(k) ? h("small", { class: "col-cut" }, " hidden at this width") : null)),
          on ? h("span", { class: "col-move" }, h("button", { type: "button", class: "icon-btn tiny reorder", "data-move": `${k}|-1`, "aria-label": `Move ${label(k)} up (towards the strike)`, disabled: enabled.indexOf(k) === 0, onclick: () => move(k, -1) }, icon("up")), h("button", { type: "button", class: "icon-btn tiny reorder", "data-move": `${k}|1`, "aria-label": `Move ${label(k)} down (away from the strike)`, disabled: enabled.indexOf(k) === enabled.length - 1, onclick: () => move(k, 1) }, icon("down"))) : null,
        );
      const list = h("div", { class: "col-list" }, enabled.map((k) => colRow(k, true)), others.map((k) => colRow(k, false)));
      // Drag a column row to reorder (mouse); the arrow buttons do the same from the keyboard.
      let dragKey = null;
      list.addEventListener("dragstart", (e) => {
        const r = e.target.closest(".col-row.on");
        if (!r) return;
        dragKey = r.dataset.col;
        r.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragKey);
      });
      list.addEventListener("dragover", (e) => {
        if (!dragKey) return;
        e.preventDefault();
        const over = e.target.closest(".col-row.on");
        const from = list.querySelector(".dragging");
        if (!over || !from || over === from) return;
        const r = over.getBoundingClientRect();
        list.insertBefore(from, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
      });
      list.addEventListener("dragend", () => {
        if (!dragKey) return;
        dragKey = null;
        setCfg({ cols: [...list.querySelectorAll(".col-row.on")].map((r) => r.dataset.col) });
        draw();
      });
      // Presets: one chip each, the chosen one in the contrast colour (the same selection as every capsule bar).
      const presetBtn = (p) => h("button", { type: "button", class: `preset-chip${c.preset === p ? " on" : ""}`, "aria-pressed": String(c.preset === p), onclick: () => { setCfg({ cols: [...CHAIN_PRESETS[p]] }); draw(); } }, PRESET_NAMES[p]);
      const presets = h("div", { class: "preset-row" }, Object.keys(CHAIN_PRESETS).map(presetBtn), c.preset === "custom" ? h("span", { class: "preset-custom" }, "Custom") : null);
      const styleSeg = segmented("Bar style", [["bar", "Under value"], ["fill", "Cell fill"]], c.barStyle);
      styleSeg.addEventListener("change", () => setCfg({ barStyle: styleSeg.value }));
      const quotesRow = (() => {
        const row = sw(`Bid and ask (${touchWord().toLowerCase()} to trade)`, () => c.quotes, (v) => setCfg({ quotes: v }), c.preset === "arb" ? "Always on in the Arb view" : "Touch screens trade from the row's sheet instead");
        if (c.preset === "arb") row.querySelector("input").disabled = true;
        return row;
      })();
      const eyebrow = (t, extra) => h("h3", {}, t, extra ? h("small", {}, extra) : null);
      body.replaceChildren(
        h("section", {}, eyebrow("Show"), sideSeg),
        h("section", {}, eyebrow("Preset"), presets),
        h("section", {}, eyebrow("Columns", ` · from the strike outwards · ${phone ? "use the arrows" : "drag or use the arrows"} to reorder`), h("p", { class: "fit-note" }, h("strong", {}, `Fits ${formatInt(fit.kept)} of ${formatInt(fit.total)}`), " at this width", fit.hidden.length ? ` · hidden: ${fit.hidden.map((k) => (k === "quotes" ? "Bid / Ask" : label(k))).join(", ")}` : "", fit.added?.length ? ` · added for the width: ${fit.added.map((k) => label(k)).join(", ")}` : ""), list),
        h("section", {}, eyebrow("Bars"), sw("OI bars", () => c.bars.oi, (v) => setCfg({ bars: { ...st.cfg.bars, oi: v } }), "Calls and puts in their colours, one scale"), sw("OI change bars", () => c.bars.chg, (v) => setCfg({ bars: { ...st.cfg.bars, chg: v } }), "Green added, red cut"), sw("Volume bars", () => c.bars.vol, (v) => setCfg({ bars: { ...st.cfg.bars, vol: v } })), h("div", { class: "seg-field" }, h("span", {}, "Bar style"), styleSeg)),
        h(
          "section",
          {},
          eyebrow("Display"),
          sw("% change under values", () => c.pct, (v) => setCfg({ pct: v })),
          sw("Values in lots", () => c.lots, (v) => setCfg({ lots: v }), "OI and volume ÷ lot size"),
          sw("Highlight in-the-money", () => c.itm, (v) => setCfg({ itm: v })),
          sw("My positions in the chain", () => c.positions, (v) => setCfg({ positions: v }), "Lots you hold, beside the LTP"),
          sw("Compact rows", () => c.dense, (v) => setCfg({ dense: v })),
          sw("More columns on wide screens", () => c.wide, (v) => setCfg({ wide: v }), "A preset adds Greeks or OI columns while there is room"),
          quotesRow,
        ),
        h(
          "section",
          {},
          eyebrow("Tags"),
          sw("Max Pain", () => c.tags.mp, (v) => setCfg({ tags: { ...st.cfg.tags, mp: v } })),
          sw("Call wall / Put wall", () => c.tags.walls, (v) => setCfg({ tags: { ...st.cfg.tags, walls: v } })),
          sw("±1σ band (expected move)", () => c.tags.em, (v) => setCfg({ tags: { ...st.cfg.tags, em: v } })),
          sw("±2σ", () => c.tags.em2, (v) => setCfg({ tags: { ...st.cfg.tags, em2: v } }), "Strikes two standard deviations out"),
        ),
      );
    };
    const reset = h("button", { type: "button", class: "small plain reset", onclick: () => { st.cfg = chainConfig({}); setCfg({}); draw(); } }, icon("refresh"), "Reset");
    const wrap = h("div", { class: "pop-body" }, body, say);
    const origDraw = draw;
    // A redraw replaces the controls: keep the keyboard where it was (same control by position).
    const focusables = () => [...wrap.querySelectorAll("button, input")];
    draw = () => {
      const i = focusables().indexOf(document.activeElement);
      origDraw();
      if (refocus) {
        wrap.querySelector(refocus)?.focus();
        refocus = null;
      } else if (i >= 0) focusables()[i]?.focus({ preventScroll: true });
    };
    origDraw();
    // Desktop and tablet: anchored under the button (6 px gap), never flipped above it; a tall list scrolls inside
    // (max-height = the room left to the viewport's bottom less 16 px). Runs after the popover's own placement.
    let raf = 0;
    const anchor = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = custom?.el;
        if (!el?.isConnected || !el.classList.contains("floating")) return;
        const top = Math.max(8, Math.round(gearBtn.getBoundingClientRect().bottom + 6));
        // Tablets: it ends above the floating tab bar too, not over it.
        const bar = document.querySelector(".tabbar");
        const floor = bar && getComputedStyle(bar).display !== "none" ? Math.min(innerHeight - 16, bar.getBoundingClientRect().top - 8) : innerHeight - 16;
        el.style.top = `${top}px`;
        el.style.maxHeight = `${Math.max(160, floor - top)}px`;
      });
    };
    const unanchor = () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", anchor);
      removeEventListener("scroll", anchor, true);
    };
    custom = sheetPopover({ trigger: gearBtn, title: "Customise", head: [reset], body: wrap, cls: "customise", onClose: () => { unanchor(); custom = null; } });
    if (custom.el?.classList.contains("floating")) {
      anchor();
      addEventListener("resize", anchor);
      addEventListener("scroll", anchor, true);
    }
  }

  // ── Strike search ──
  function runSearch() {
    const x = lastX;
    if (!x) return;
    const strikes = x.c.rows.map((r) => r.strike);
    const sigmaPts = x.F !== null && x.sm.atmIv && x.years > 0 ? (x.sm.atmIv / 100) * Math.sqrt(x.years) * x.F : null;
    const k = O.strikeQuery(search.value, { strikes, atm: x.sm.atm, F: x.F, sigmaPts, maxPain: x.sm.maxPain });
    search.setAttribute("aria-invalid", String(k === null));
    showHint(k === null);
    if (k === null) return;
    chain.jump(k, chain.sideNow());
    search.value = "";
    search.blur();
    searchBox.classList.remove("open");
  }
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      search.value = "";
      search.removeAttribute("aria-invalid");
      showHint(false);
      search.blur();
      searchBox.classList.remove("open");
    }
  });
  search.addEventListener("input", () => {
    search.removeAttribute("aria-invalid");
    showHint(false);
  });
  search.addEventListener("blur", () => setTimeout(() => !search.value && searchBox.classList.remove("open"), 150));
  searchBtn.addEventListener("click", () => {
    searchBox.classList.add("open");
    search.focus();
  });
  const focusSearch = () => {
    searchBox.classList.add("open");
    search.focus();
    search.select();
  };

  function showKeys() {
    modal({
      title: "Option chain keys",
      body: h(
        "table",
        { class: "keys-table" },
        h("tbody", {}, CHAIN_KEYS.map(([keys, , long]) => h("tr", {}, h("th", { scope: "row" }, keys.map((k) => h("kbd", {}, k))), h("td", {}, long)))),
      ),
      buttons: [{ label: "Close", value: true }],
    });
  }

  // ── Keyboard ──
  const desk = {
    root: chainEl,
    onKey(e) {
      const k = e.key;
      if (k === "/") return focusSearch(), true;
      if (k === "?") return showKeys(), true;
      if (k === "p") return toggleLive(), true;
      if (k === "r") return refresh(), true;
      if (k === "[" || k === "]") {
        const i = eSel.selectedIndex + (k === "]" ? 1 : -1);
        if (i < 0 || i >= eSel.options.length || eSel.disabled) return true;
        eSel.selectedIndex = i;
        eSel.dispatchEvent(new Event("change"));
        return true;
      }
      if (/^[1-5]$/.test(k)) return setCfg({ cols: [...CHAIN_PRESETS[TOOLBAR_PRESETS[Number(k) - 1]]] }), true;
      if (k === "m") return chain.toggleSelect(), true;
      if (k === "Escape" && chain.selecting) return chain.toggleSelect(false), true;
      if (k === "c" || k === "v") {
        const want = k === "c" ? "ce" : "pe";
        const key = effSideKey();
        return setCfg({ [key]: st.cfg[key] === want ? "both" : want }), true;
      }
      const rows = chain.visibleStrikes();
      if (!rows.length) return false;
      const f = st.focus;
      const lside = chain.layoutSide();
      const oneSide = lside === "ce" || lside === "pe" ? lside : null;
      const move = (d) => {
        const i = f ? rows.indexOf(f.strike) : rows.indexOf(chain.atmStrike());
        const j = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + d));
        st.focus = { strike: rows[j], side: oneSide ?? f?.side ?? "ce" };
        chain.paintFocus(true, true);
      };
      if (k === "j" || (k === "ArrowDown" && f)) return move(1), true;
      if (k === "k" || (k === "ArrowUp" && f)) return move(-1), true;
      if ((k === "ArrowLeft" || k === "h") && f && lside === "both") return (st.focus = { ...f, side: "ce" }), chain.paintFocus(true, true), true;
      if ((k === "ArrowRight" || k === "l") && f && lside === "both") return (st.focus = { ...f, side: "pe" }), chain.paintFocus(true, true), true;
      if (k === "g" || k === "Home") return chain.goAtm(), true;
      if (k === "Escape" && f) return (st.focus = null), chain.paintFocus(), true;
      const target = f ?? { strike: chain.atmStrike(), side: oneSide ?? "ce" };
      const row = st.chain?.rows.find((r) => r.strike === target.strike);
      if (!row) return false;
      const right = target.side === "ce" ? "CE" : "PE";
      if (k === "Enter" || (k === " " && chain.selecting)) {
        if (e.target instanceof Element && e.target.closest("button, a, summary")) return false;
        if (chain.pick(row.strike, target.side)) return true;
        return openSheet(row.strike, target.side), true;
      }
      if (k === "b" || k === "s") return openTicket({ row, right, side: k === "b" ? "BUY" : "SELL" }), true;
      if (k === "B" || k === "S") return addLeg({ right, strike: row.strike, side: k === "B" ? "BUY" : "SELL" }), true;
      if (k === "x") {
        const sym = row[target.side]?.symbol;
        const p = sym ? st.positions.find((q) => q.symbol === sym && Number(q.netQty)) : null;
        return p ? exitPosition(p) : toast(`No position in ${formatInt(row.strike)} ${right}`, { tone: "info" }), true;
      }
      return false;
    },
  };
  const oiDesk = oiPage && {
    root: oiPage.root,
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return oiPage.onKey(e);
    },
  };
  const stratDesk = builder && {
    root: builder.panel,
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return builder.onKey(e);
    },
  };
  const posDesk = posPage && {
    root: posPage.root,
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return posPage.onKey(e);
    },
  };
  const volDesk = volPage && {
    root: volPage.root,
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return volPage.onKey(e);
    },
  };
  const arbDesk = arbPage && {
    root: arbPage.root,
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return arbPage.onKey(e);
    },
  };
  activeDesk = kind === "chain" ? desk : kind === "oi" ? oiDesk : kind === "strategy" ? stratDesk : kind === "positions" ? posDesk : kind === "vol" ? volDesk : kind === "arb" ? arbDesk : null;
  bindKeys();

  // ── Wiring ──
  uSel.addEventListener("change", () => {
    st.underlying = uSel.value;
    st.expiry = null;
    save();
    drawCtx();
    // A new underlying is a new page of data: the sections enter again (never on a refresh).
    reloadAll().then(() => animatePage(document.getElementById("content"), { force: true }));
  });
  eSel.addEventListener("change", () => {
    st.expiry = eSel.value;
    drawExpStrip();
    st.seq++;
    st.focus = null;
    sheet?.close();
    chain.reset();
    // The chain shows its skeleton while the new expiry loads (the old one's figures would read as this one's).
    if (kind === "chain") {
      st.chain = null;
      drawAll();
    }
    oiPage?.reset();
    volPage?.reset();
    arbPage?.reset();
    save();
    loadChain();
  });
  strikesSeg.addEventListener("change", () => {
    syncStrikesSel();
    st.strikesView = strikesSeg.value;
    if (!windowLock) {
      st.strikes = strikesSeg.value;
      save();
    }
    if (st.chain) drawAll();
  });
  viewSeg.addEventListener("change", () => !presetLock && setCfg({ cols: [...CHAIN_PRESETS[viewSeg.value]] }));
  presetSel.addEventListener("change", () => CHAIN_PRESETS[presetSel.value] && setCfg({ cols: [...CHAIN_PRESETS[presetSel.value]] }));
  gearBtn.addEventListener("click", () => openCustomise());
  winSeg.addEventListener("change", () => !winLock && winSeg.value !== st.cfg.oiWin && setCfg({ oiWin: winSeg.value }));
  selectBtn.addEventListener("click", () => chain.toggleSelect());
  syncStrikesSel();
  aSel.addEventListener("change", () => {
    st.account = aSel.value;
    drawAcct();
    drawCtx();
    save();
    if (posPage) posPage.accountChanged();
    else loadPositions();
    builder?.accountChanged();
  });
  drawLive();
  // Back to the tab: refresh at once instead of on the next tick. Device class changes (rotation, a phone-width
  // window, a touch screen) re-lay the chain. Both listeners go when the page does.
  const pageRoot = kind === "chain" ? chainEl : kind === "strategy" ? builder.panel : kind === "oi" ? oiPage.root : kind === "vol" ? volPage.root : kind === "arb" ? arbPage.root : posPage.root;
  let ageTimer = 0;
  let mounted = false;
  const onVisible = () => {
    if (!mounted) return;
    if (!pageRoot.isConnected) return cleanup();
    if (!document.hidden && st.live) refresh();
  };
  const mqs = [MQ_PHONE, MQ_NARROW, MQ_COARSE].map((q) => media(q));
  const onDevice = () => {
    if (!chainEl.isConnected) return cleanup();
    setCfg({});
  };
  // Leaving the page: the router swaps #content on hashchange, so check once it has.
  // Before the first load finishes the page is not in the document yet: wait for it, then check.
  const onRoute = () => setTimeout(() => mounted && !pageRoot.isConnected && cleanup(), 0);
  let refRo = null;
  function cleanup() {
    feed?.stop();
    clearInterval(ageTimer);
    refRo?.disconnect();
    ctxRo?.disconnect();
    headRo?.disconnect();
    document.querySelector(".toolbar-title")?.classList.remove("icon-only");
    chain.destroy();
    document.getElementById("content")?.removeAttribute("data-stale");
    custom?.close();
    ctxSheet?.close();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("hashchange", onRoute);
    for (const m of mqs) m.removeEventListener("change", onDevice);
    chain.reset();
    sheet?.close();
    builder?.destroy();
    posPage?.destroy();
    volPage?.destroy();
    arbPage?.destroy();
  }
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("hashchange", onRoute);
  if (kind === "chain") for (const m of mqs) m.addEventListener("change", onDevice);

  drawAcct();
  // The top bar: one capsule, then (trading pages) the account and its mode, the live control and the ⋯ sheet.
  // The chain and the Strategy Builder carry the future, ATM IV (and, on the builder, ±1σ) on their one line.
  const wide = kind === "chain" || kind === "strategy";
  // The lot lives in the reference chip after the capsule (Lot · Freeze · events, docs/spec/p1-02-reference.md §5.2).
  capsule = h("div", { class: `ctx-cap glass${wide ? " ctx-chain" : ""}` }, uItem, kind === "positions" ? null : eItem, spotItem, wide ? futItem : null, wide ? ivItem : null, kind === "strategy" ? sigItem : null);
  // The chain is read-only until an order is placed: its account picker lives in the ticket and the action sheet
  // ("Orders go to"), and the line shows only a red LIVE-orders pill when orders would go to a live account.
  // The Strategy Builder picks the account in its confirm sheet ("Orders go to"), like the chain's ticket.
  const acctItem = TRADING.has(kind) && kind !== "chain" && kind !== "strategy" ? h("span", { class: "ctx-acct glass" }, tradable.length ? [aSel, acctBadge] : h("a", { href: "#/accounts", class: "acct-connect" }, icon("plug"), "Connect an account")) : null;
  mountToolbarCtx(kind, capsule, expiryChip, refChipEl.el, h("span", { class: "ctx-spacer" }), acctItem, wide ? liveOrders : null, demoPill, liveBtn.el, moreBtn);
  if (wide) document.querySelector(".toolbar-title")?.classList.add("icon-only");
  // The chain fits its table to the viewport: a banner that appears or goes moves where the table starts.
  if (kind === "chain" && typeof ResizeObserver === "function") {
    refRo = new ResizeObserver(() => chain.fitHeight());
    refRo.observe(refBannersEl.el);
  }
  if (wide && typeof ResizeObserver === "function") {
    ctxRo = new ResizeObserver(() => fitCtx());
    ctxRo.observe(capsule);
    if (capsule.parentNode) ctxRo.observe(capsule.parentNode);
  }
  drawCtx();
  // The chain shows its layout-shaped skeleton at once and fills in when the data arrives; the other pages wait.
  const loaded = reloadAll().then(() => {
    // Left before the first load finished (the chain does not wait for it): tidy up instead of starting the timer.
    if (kind === "chain" && !pageRoot.isConnected) return cleanup();
    mounted = true;
    startTimer();
    timerReady = true;
  });
  if (kind !== "chain") await loaded;
  // The pill's age ticks once a second (text node only); cleared when the page goes.
  ageTimer = setInterval(() => (pageRoot.isConnected ? drawClock() : clearInterval(ageTimer)), 1000);

  if (kind === "chain") {
    const out = [
      refBannersEl.el,
      h("section", { class: "desk-panel", "data-panel": "summary", "data-fixed": "", "aria-label": "Chain summary" }, statsEl),
      h(
        "section",
        { class: "desk-panel chain-panel", "data-panel": "chain", "aria-label": "Option chain" },
        expStrip,
        h("div", { class: "chain-head panel-head" }, (chainTools = h("div", { class: "chain-tools" }, searchBox, chain.phoneBar, strikesSel, strikesSeg, viewSeg, presetSel, winSeg, winSel, h("span", { class: "tools-spacer" }), stalePill, hiddenChip, selectBtn, gearBtn)), searchHint),
        chainEl,
        keysEl,
      ),
    ];
    syncTools();
    if (headRo) queueMicrotask(() => chainTools?.parentNode && headRo.observe(chainTools.parentNode));
    return out;
  }
  // The builder's own hero strip and the one top line replace the chain summary here (strategy.md §3.1).
  // Every page: the reference banners (events within 7 days, stale data) first, above the page body.
  if (kind === "strategy") return [refBannersEl.el, builder.panel];
  if (kind === "oi") return [refBannersEl.el, ...oiPage.panels];
  // Volatility: its own KPI strip, so no shared summary.
  if (kind === "vol") return [refBannersEl.el, ...volPage.panels];
  if (kind === "arb") return [refBannersEl.el, ...arbPage.panels];
  // The page covers every expiry: the bar has no expiry (st.expiry stays for the other pages).
  return [refBannersEl.el, ...posPage.panels];
}

// ── Chain table (built once, patched on every refresh) ──

/**
 * Every column the chain can show: [key, name in Customise, scope]. Scope "row" columns are one per strike (put-call
 * parity, strike PCR, straddle) and sit beside the strike; the rest repeat per side. `v` = what a cell depends on
 * (unchanged → skipped), `r` = its content.
 */
export const CHAIN_COLUMNS = [
  ["ltp", "LTP"], ["iv", "IV"], ["oi", "OI"], ["chg", "OI chg"], ["vol", "Volume"], ["bu", "Build-up"],
  ["delta", "Delta"], ["gamma", "Gamma"], ["theta", "Theta"], ["vega", "Vega"], ["pitm", "P(ITM)"], ["potm", "P(OTM)"],
  ["ext", "Time value"], ["spread", "Spread %"], ["liq", "Liquidity"], ["prem", "Premium traded"],
  ["be", "Breakeven"], ["pop", "POP buy"], ["pops", "POP sell"], ["dist", "Distance from spot"], ["premLot", "Premium per lot"],
  ["thetaLot", "Theta per lot"], ["ivx", "IV − ATM IV"], ["hedge", "Hedge lots"], ["costPct", "Cost % of spot"],
  ["syn", "Synthetic future", "row"], ["dev", "Deviation from future", "row"], ["edge", "Parity edge", "row"], ["ivskew", "IV put − call", "row"],
  ["pcrK", "Strike PCR", "row"], ["strad", "Straddle", "row"],
];
/** Column presets, listed from the strike outwards. The first five are the toolbar's (one per persona). Build-up
 *  sits next to OI chg (what it is read with), not at the outer edge. */
export const CHAIN_PRESETS = {
  oi: ["ltp", "iv", "vol", "bu", "chg", "oi"],
  buyer: ["ltp", "be", "pop", "delta", "thetaLot", "ivx", "spread"],
  seller: ["ltp", "dist", "pops", "delta", "premLot", "thetaLot", "oi"],
  hedger: ["ltp", "delta", "hedge", "costPct", "be", "dist", "vega"],
  arb: ["syn", "dev", "edge", "ivskew", "ltp", "iv"],
  greeks: ["ltp", "iv", "delta", "gamma", "theta", "vega", "pitm"],
  value: ["ltp", "iv", "ext", "spread", "liq", "prem"],
};
/** The round-1 OI preset (build-up at the outer edge): a saved copy of it becomes today's OI preset. */
const OLD_OI_PRESET = "ltp,iv,vol,chg,oi,bu";
export const PRESET_NAMES = Object.freeze({ oi: "OI", buyer: "Buyer", seller: "Seller", hedger: "Hedger", arb: "Arb", greeks: "Greeks", value: "Value" });
const TOOLBAR_PRESETS = ["oi", "buyer", "seller", "hedger", "arb"];

/**
 * Fit engine (docs/design/chain.md §3.4). Minimum widths per column (px, padding included), and per preset the order
 * in which columns drop out when the panel is too narrow ("quotes" = the Bid / Ask pair). LTP and the strike never
 * drop. A custom column list drops from the outer edge inwards.
 */
// Estimates, measured from the demo chain at desktop size (the header text counts: "Build-up" sets bu's width). The chain
// replaces them with the real minimum of each column once its table is on screen (measureCols in createChain).
export const COL_MIN = Object.freeze({
  ltp: 76, iv: 46, oi: 66, chg: 64, vol: 62, bu: 64, bid: 62, ask: 62, delta: 58, gamma: 64, theta: 56, vega: 54, pitm: 58, potm: 60,
  ext: 68, spread: 62, liq: 62, prem: 82, be: 70, pop: 58, pops: 60, dist: 64, premLot: 74, thetaLot: 70, ivx: 60, hedge: 74,
  costPct: 60, syn: 90, dev: 82, edge: 74, ivskew: 58, pcrK: 54, strad: 78, default: 62,
});
/** Touch screens: 44 px rows and wider padding, so every minimum grows by 8 px. */
export const coarseMin = (w = COL_MIN) => Object.freeze(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v + 8])));
const COL_MIN_COARSE = coarseMin();
/** Phones: tighter minimums (one side shows Strike | LTP | OI chg | OI; Both shows OI | LTP | Strike | LTP | OI). */
export const PHONE_MIN = Object.freeze({ ltp: 72, oi: 66, chg: 72, iv: 46, vol: 62, bu: 40, syn: 84, dev: 74, edge: 70, default: 62 });
export const PRESET_DROP = Object.freeze({
  oi: ["bu", "vol", "iv", "quotes", "chg", "oi"],
  buyer: ["spread", "ivx", "thetaLot", "quotes", "delta", "pop", "be"],
  seller: ["thetaLot", "oi", "premLot", "quotes", "pops", "dist", "delta"],
  hedger: ["vega", "dist", "be", "quotes", "costPct", "hedge", "delta"],
  arb: ["iv", "ivskew", "edge", "quotes", "dev", "syn"],
  greeks: ["pitm", "vega", "gamma", "quotes", "theta", "delta", "iv"],
  value: ["prem", "liq", "spread", "quotes", "ext", "iv"],
});
/** The drop sequence for a column list: the preset's own order, then anything else from the outer edge inwards. */
export function dropOrder(preset, cols) {
  const list = cols ?? [];
  const base = (PRESET_DROP[preset] ?? []).filter((k) => k === "quotes" || list.includes(k));
  const rest = [...list].reverse().filter((k) => !base.includes(k));
  const all = [...base, ...rest].filter((k) => k !== "ltp");
  if (all.includes("quotes")) return all;
  const at = Math.max(0, all.length - 2);
  return [...all.slice(0, at), "quotes", ...all.slice(at)];
}
/**
 * Keep the columns that fit `avail` px: the strike + the row columns + `sides` × (side columns + Bid / Ask). First at
 * most `cap` side columns, then drop in `order` until the sum of minimum widths fits, then bring back (most important
 * first) any dropped column that fits again once a wider one has gone (IV returns after Bid / Ask drops), then `extra`
 * more (the table's own overflow check, a last resort). Pure: { side, mid, quotes, hidden, width }.
 */
export function fitColumns({ side = [], mid = [], quotes = false, sides = 2, avail = Infinity, widths = COL_MIN, strikeW = 96, order = [], cap = Infinity, extra = 0 } = {}) {
  const hasQ = Boolean(quotes) && sides > 0;
  const off = new Set();
  const w = (k) => widths[k] ?? widths.default ?? 64;
  const sum = (list) => list.reduce((a, k) => a + (off.has(k) ? 0 : w(k)), 0);
  const total = () => strikeW + sum(mid) + sides * (sum(side) + (hasQ && !off.has("quotes") ? w("bid") + w("ask") : 0));
  const present = (k) => !off.has(k) && (k === "quotes" ? hasQ : k !== "ltp" && (side.includes(k) || mid.includes(k)));
  const next = (pred) => order.find((k) => present(k) && pred(k));
  const dropped = [];
  const drop = (k) => {
    off.add(k);
    dropped.push(k);
  };
  const sideCount = () => side.filter((k) => !off.has(k)).length;
  for (let k = next((x) => side.includes(x)); sideCount() > cap && k; k = next((x) => side.includes(x))) drop(k);
  const fitFrom = dropped.length;
  for (let k = next(() => true); total() > avail && k; k = next(() => true)) drop(k);
  for (const k of dropped.slice(fitFrom).reverse()) {
    off.delete(k);
    if (total() > avail) off.add(k);
  }
  for (let n = 0; n < extra; n += 1) {
    const k = next(() => true);
    if (!k) break;
    drop(k);
  }
  const hidden = dropped.filter((k, i) => off.has(k) && dropped.indexOf(k) === i);
  return { side: side.filter((k) => !off.has(k)), mid: mid.filter((k) => !off.has(k)), quotes: hasQ && !off.has("quotes"), hidden, width: total() };
}

export const presetOf = (cols) => Object.keys(CHAIN_PRESETS).find((k) => CHAIN_PRESETS[k].join() === (cols ?? []).join()) ?? "custom";
/** The chain's settings (Customise panel); stored with the desk's other preferences. */
export const CHAIN_DEFAULTS = Object.freeze({
  cols: CHAIN_PRESETS.oi,
  side: "both",
  phoneSide: "ce",
  quotes: true,
  bars: { oi: true, chg: true, vol: true },
  barStyle: "bar",
  pct: true,
  lots: false,
  itm: true,
  positions: true,
  dense: false,
  wide: true,
  oiWin: "day",
  tags: { mp: true, walls: true, em: true, em2: false },
});
export function chainConfig(saved) {
  const d = CHAIN_DEFAULTS;
  const c = saved && typeof saved === "object" ? saved : {};
  const known = new Set(CHAIN_COLUMNS.map(([k]) => k));
  let cols = Array.isArray(c.cols) ? c.cols.filter((k, i, a) => known.has(k) && a.indexOf(k) === i) : d.cols;
  if (cols.join() === OLD_OI_PRESET) cols = [...CHAIN_PRESETS.oi];
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  const out = {
    cols: cols.length ? cols : [...d.cols],
    side: ["both", "ce", "pe"].includes(c.side) ? c.side : d.side,
    phoneSide: ["both", "ce", "pe"].includes(c.phoneSide) ? c.phoneSide : d.phoneSide,
    quotes: bool(c.quotes, d.quotes),
    bars: { oi: bool(c.bars?.oi, d.bars.oi), chg: bool(c.bars?.chg, d.bars.chg), vol: bool(c.bars?.vol, d.bars.vol) },
    barStyle: c.barStyle === "fill" ? "fill" : "bar",
    pct: bool(c.pct, d.pct),
    lots: bool(c.lots, d.lots),
    itm: bool(c.itm, d.itm),
    positions: bool(c.positions, d.positions),
    dense: bool(c.dense, d.dense),
    wide: bool(c.wide, d.wide),
    oiWin: ["day", "60", "15"].includes(c.oiWin) ? c.oiWin : d.oiWin,
    tags: { mp: bool(c.tags?.mp, d.tags.mp), walls: bool(c.tags?.walls, d.tags.walls), em: bool(c.tags?.em, d.tags.em), em2: bool(c.tags?.em2, d.tags.em2) },
  };
  out.preset = presetOf(out.cols);
  // Bid and ask are what an arbitrage is read from: the Arb preset always shows them.
  if (out.preset === "arb") out.quotes = true;
  return out;
}
/** Strikes each side of ATM: "10", "20" or "all" (the old ±8 / ±12 become ±10). */
export const strikesPref = (v) => (v === "20" || v === "all" ? v : "10");

const MQ_PHONE = "(max-width: 719px)";
const MQ_COARSE = "(pointer: coarse)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
/** Device class: phone (≤ 719 px) and touch (coarse pointer) change the chain's layout, so they are part of its key. */
const MQ_NARROW = "(max-width: 1023px)";
export const device = () => ({ phone: media(MQ_PHONE).matches, narrow: media(MQ_NARROW).matches, coarse: media(MQ_COARSE).matches });
const reducedMotion = () => media("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => media("(hover: hover) and (pointer: fine)").matches;

/** Make live node `a` match freshly built node `b` (same tags and child counts): true when done in place. */
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType === 3) {
    if (a.data !== b.data) a.data = b.data;
    return true;
  }
  if (a.nodeType !== 1 || a.childNodes.length !== b.childNodes.length) return false;
  for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
  for (const at of b.attributes) {
    if (at.name === "style") {
      // Through the CSSOM: the dashboard's CSP refuses inline style attributes.
      if (a.style.cssText !== b.style.cssText) a.style.cssText = b.style.cssText;
    } else if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  }
  const ac = [...a.childNodes];
  const bc = [...b.childNodes];
  for (let i = 0; i < ac.length; i += 1) if (!morph(ac[i], bc[i])) a.replaceChild(bc[i], ac[i]);
  return true;
}

/** A loading placeholder shaped like the chain: two sticky header rows, 12 strike rows with a figure and a bar slot
 *  per cell, and the totals row. One shimmer (dv-shimmer via .skel). */
function chainSkeleton(label) {
  const cell = () => h("span", { class: "sk-cell" }, h("i", { class: "skel sk-fig" }), h("i", { class: "skel sk-bar" }));
  const side = () => h("span", { class: "sk-side" }, cell(), cell(), cell());
  const row = () => h("div", { class: "sk-row" }, side(), h("span", { class: "sk-strike" }, h("i", { class: "skel sk-k" })), side());
  return h(
    "div",
    { class: "chain-skel", role: "status" },
    h("span", { class: "sr-only" }, label),
    h("div", { class: "sk-head", "aria-hidden": "true" }, h("i", { class: "skel" }), h("i", { class: "skel" })),
    h("div", { "aria-hidden": "true" }, Array.from({ length: 12 }, row)),
    h("div", { class: "sk-foot", "aria-hidden": "true" }, h("i", { class: "skel" })),
  );
}

function createChain({ st, host, onTrade, onFocus, onOpen, onSide, onPhoneSide, onWindowAll, onLeg = null, onPick = null, onRelayout = null, onNextExpiry = null, onSelectChange = null, onHold = null }) {
  let built = null;
  let centred = false;
  let lastX = null;
  /** Columns dropped beyond the measured widths because the table still overflowed: a last resort, reset whenever
   *  the layout's context changes (and retried one lower every 10 s). */
  let extraDrop = 0;
  let overflowCheck = 0;
  let lastAvail = 0;
  let lastFit = { hidden: [], kept: 0, total: 0 };
  /** Measured minimum widths (px) of the columns as laid out: they replace the COL_MIN estimates for this context
   *  (underlying, expiry, columns, side, strikes window, device), so the fit engine is exact and deterministic. */
  let measured = {};
  let measuredStrike = 0;
  let fitKey = "";
  /** The wrap's own vertical scrollbar (classic scrollbars take width; overlay ones take none). */
  let sbW = 0;
  /** A table rebuilt again from place() (a measured refit) keeps the anchor and horizontal scroll of the first. */
  let pending = null;
  let refits = 0;
  let retryAt = 0;

  const g = (v, dp) => (isFigure(v) ? formatFixed(v, dp) : DASH);
  const pct1 = (v) => (isFigure(v) ? `${formatSigned(v, 1)}%` : DASH);
  const rupees = (v, signed = false) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? `${v < 0 ? MINUS : signed && v > 0 ? "+" : ""}₹${formatCompact(Math.abs(v))}` : signed ? formatSignedRupee(v, 0) : formatRupee(v, 0));
  const dots = (n) => h("span", { class: "liq", title: `Liquidity ${n} of 5`, "aria-label": `Liquidity ${n} of 5` }, [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= n ? "on" : undefined })));
  /**
   * The baseline grid (§3.4): every cell is two fixed rows, line 1 the main figure (16 px) and line 2 a sub figure or a
   * bar (12 px), so the main figures of a row sit on one baseline whatever the cell holds.
   */
  const cg = (l1, l2 = null, c1 = "") => h("span", { class: "cg" }, h("span", { class: c1 ? `l1 ${c1}` : "l1" }, l1), l2 ?? h("span", { class: "l2" }));
  const sub = (text, cls) => h("small", { class: cls ? `l2 ${cls}` : "l2" }, text ?? "");
  const two = (main, s, cls) => cg(main, cfg().pct || s?.force ? sub(s?.text, s?.cls) : null, cls);
  const heat = () => cfg().barStyle === "fill";
  /** A bar in line 2: length = share of the chain's largest (both sides), growing away from the strike. */
  const bar = (frac, cls) => {
    const el = h("span", { class: `l2 vbar ${cls ?? ""}`.trim(), "aria-hidden": "true" }, h("span"));
    const f = Math.max(0, Math.min(1, frac || 0));
    // A non-zero value never draws under 2 % (the 2 px minimum mark); zero draws no fill at all.
    el.firstChild.style.transform = `scaleX(${f > 0 ? Math.max(0.02, r1(f * 100) / 100) : 0})`;
    return el;
  };
  const barred = (text, frac, cls, on, c1 = "") => cg(text, on && !heat() ? bar(frac, cls) : null, c1);
  const cfg = () => st.cfg;
  const unit = (x) => (cfg().lots ? x.lot : 1);
  const R = (side) => (side === "ce" ? "CE" : "PE");
  const prem = (q) => O.mid(q);
  const picked = new Map();
  let selecting = false;
  const pickKey = (strike, side) => `${strike}|${side}`;
  const COLS = {
    bu: {
      label: "Build-up",
      short: "B-up",
      title: "Build-up: LB long build-up and SB short build-up are new positions (filled); SC short covering and LU long unwinding are positions closing (outline). Green = price rising, red = price falling",
      v: (q, row, side, x) => O.buildup(x.winQ(q, row, side)),
      r: (q, row, side, x) => {
        const b = O.buildup(x.winQ(q, row, side));
        return cg(b ? h("span", { class: `bu bu-${b}`, title: O.BUILDUP_NAMES[b] }, b) : h("span", { class: "muted" }, DASH));
      },
    },
    oi: {
      label: "OI",
      title: "Open interest. Bar = share of the largest OI on the chain (both sides). Brightest = OI wall",
      v: (q, row, side, x) => [q?.oi, x.sm.maxOi, x.topOi[side].get(row.strike) ?? 0, heat()],
      r: (q, row, side, x) => {
        const rank = x.topOi[side].get(row.strike);
        const text = formatCompact(num(q?.oi) === null ? null : q.oi / unit(x));
        return barred(text, x.sm.maxOi ? (num(q?.oi) ?? 0) / x.sm.maxOi : 0, `oi ${side}${rank === 1 ? " r1" : rank ? " r2" : ""}`, cfg().bars.oi, rank === 1 ? "wall" : "");
      },
      heat: (q, row, side, x) => [side === "ce" ? "call" : "put", x.sm.maxOi ? (num(q?.oi) ?? 0) / x.sm.maxOi : 0],
    },
    chg: {
      label: "OI chg",
      title: "OI added (green) or cut (red). Bar = share of the largest change on the chain",
      v: (q, row, side, x) => [q?.oiChange, q?.oi, x.sm.maxOiChange, heat(), cfg().bars.chg],
      r: (q, row, side, x) => {
        const v = num(q?.oiChange);
        const pct = O.oiChangePct(q);
        const text = h("span", { title: pct === null ? undefined : `${formatPercent(pct, 1)} of OI` }, formatCompact(v === null ? null : v / unit(x), { signed: true }));
        const ink = v > 0 ? "up" : v < 0 ? "down" : "";
        // With bars on, line 2 is the bar and the % of OI moves into the title; bars off (or heat), line 2 is the %.
        if (cfg().bars.chg && !heat()) return cg(text, bar(x.sm.maxOiChange ? Math.abs(v ?? 0) / x.sm.maxOiChange : 0, v < 0 ? "neg" : "pos"), ink);
        return two(text, { text: pct === null ? "" : formatPercent(pct, 1) }, ink);
      },
      heat: (q, row, side, x) => {
        const v = num(q?.oiChange) ?? 0;
        return [v < 0 ? "neg" : "pos", x.sm.maxOiChange ? Math.abs(v) / x.sm.maxOiChange : 0];
      },
    },
    vol: {
      label: "Volume",
      title: "Contracts traded today. Bar = share of the largest volume (both sides); amber = unusual for its OI",
      v: (q, row, side, x) => [q?.volume, x.hot.has(q?.symbol), x.maxVol],
      r: (q, row, side, x) => {
        const hot = x.hot.has(q?.symbol);
        const text = h("span", { title: hot ? "Unusual: volume ÷ OI well above the rest of the chain" : undefined }, formatCompact(num(q?.volume) === null ? null : q.volume / unit(x)));
        return barred(text, x.maxVol ? (num(q?.volume) ?? 0) / x.maxVol : 0, "vol", cfg().bars.vol, hot ? "hot" : "");
      },
    },
    iv: { label: "IV", v: (q) => q?.iv, r: (q) => g(q?.iv, 1) },
    ltp: {
      label: "LTP",
      ltp: true,
      v: (q, row, side, x) => [q?.ltp, q?.change, x.held.get(q?.symbol), selecting, picked.has(pickKey(row.strike, side))],
      r: (q, row, side, x) => {
        const pct = O.changePct(q);
        const held = x.held.get(q?.symbol);
        const on = picked.has(pickKey(row.strike, side));
        return cg(
          [
            selecting ? h("span", { class: `pick${on ? " on" : ""}`, role: "checkbox", "aria-checked": String(on), "aria-label": `Select ${formatInt(row.strike)} ${R(side)}` }) : null,
            held ? h("span", { class: `held ${held > 0 ? "long" : "short"}`, title: `You hold ${formatSigned(held, 0)} lot(s)` }, formatSigned(held, 0)) : null,
            h("strong", {}, g(q?.ltp, 2)),
          ].filter(Boolean),
          cfg().pct ? sub(pct === null ? "" : formatSigned(pct, 1), pct > 0 ? "up" : pct < 0 ? "down" : "") : null,
        );
      },
    },
    delta: {
      label: "Delta",
      title: "Delta. 16Δ / 30Δ mark the strikes nearest those deltas on each side",
      v: (q, row, side, x) => [q?.delta, x.targets[side].get(row.strike) ?? ""],
      r: (q, row, side, x) => {
        const dt = x.targets[side].get(row.strike);
        return cg(dt ? [g(q?.delta, 2), h("sup", { class: "dt", title: `Nearest the ${dt} target on this side` }, dt)] : g(q?.delta, 2));
      },
    },
    gamma: { label: "Gamma", v: (q) => q?.gamma, r: (q) => g(q?.gamma, 4) },
    theta: { label: "Theta", v: (q) => q?.theta, r: (q) => g(q?.theta, 1) },
    vega: { label: "Vega", v: (q) => q?.vega, r: (q) => g(q?.vega, 1) },
    pitm: {
      label: "P(ITM)",
      title: "Probability of finishing in the money (Black-76 on the forward)",
      v: (q, row, side, x) => [q?.iv, Math.round(x.F ?? 0)],
      r: (q, row, side, x) => {
        const p = O.probItm(x.F, row.strike, x.years, q?.iv, R(side));
        return formatPercent(p === null ? null : p * 100, 0);
      },
    },
    potm: {
      label: "P(OTM)",
      title: "Probability of finishing out of the money: 1 − P(ITM)",
      v: (q, row, side, x) => [q?.iv, Math.round(x.F ?? 0)],
      r: (q, row, side, x) => {
        const p = O.probItm(x.F, row.strike, x.years, q?.iv, R(side));
        return formatPercent(p === null ? null : (1 - p) * 100, 0);
      },
    },
    ext: {
      label: "Time value",
      short: "Time val",
      title: "Premium above intrinsic value on the forward (what decays to zero by expiry)",
      v: (q, row, side, x) => [prem(q), Math.round((x.F ?? 0) * 10)],
      r: (q, row, side, x) => {
        const v = O.extrinsic(row.strike, R(side), prem(q), x.F);
        return v !== null && v < -0.05 ? cg(h("span", { title: "Below intrinsic on the forward: parity break or stale quote" }, g(v, 2)), null, "down") : g(v, 2);
      },
    },
    spread: {
      label: "Spread %",
      short: "Sprd",
      title: "Bid-ask spread as % of mid",
      v: (q) => [q?.bid, q?.ask],
      r: (q) => {
        const p = O.spreadPct(q);
        return cg(formatPercent(p, 1), null, p > 10 ? "down" : p > 5 ? "warn-ink" : "");
      },
    },
    liq: { label: "Liquidity", short: "Liq", v: (q, row, side, x) => O.liquidityScore(q, x.ranks[side].get(row.strike)), r: (q, row, side, x) => cg(dots(O.liquidityScore(q, x.ranks[side].get(row.strike)))) },
    prem: { label: "Premium traded", short: "Prem. traded", title: "Premium traded today (volume × lot × LTP)", v: (q, row, side, x) => [q?.volume, q?.ltp, x.lot], r: (q, row, side, x) => (isFigure(q?.volume) && isFigure(q?.ltp) ? `₹${formatCompact(q.volume * x.lot * q.ltp)}` : DASH) },
    be: {
      label: "Breakeven",
      short: "BE",
      title: "Expiry breakeven for a buyer: CE strike + premium, PE strike − premium; under it, the move from spot it needs",
      v: (q, row, side, x) => [prem(q), Math.round(x.spot ?? 0)],
      r: (q, row, side, x) => {
        const be = O.breakeven(row.strike, R(side), prem(q));
        const move = be !== null && x.spot ? ((be - x.spot) / x.spot) * 100 : null;
        return two(be === null ? DASH : be >= 1000 ? formatInt(be) : formatFixed(be, 1), { text: move === null ? "" : pct1(move), force: true });
      },
    },
    pop: {
      label: "POP buy",
      title: "A buyer's chance of profit at expiry: P(price beyond the breakeven), log-normal at the leg's IV",
      v: (q, row, side, x) => [prem(q), q?.iv, Math.round(x.F ?? 0)],
      r: (q, row, side, x) => {
        const p = O.chanceOfProfit(x.F, row.strike, x.years, num(q?.iv) ?? x.sm.atmIv, R(side), prem(q));
        return formatPercent(p === null ? null : p * 100, 0);
      },
    },
    pops: {
      label: "POP sell",
      title: "A seller's chance of keeping a profit at expiry: 1 − the buyer's chance",
      v: (q, row, side, x) => [prem(q), q?.iv, Math.round(x.F ?? 0)],
      r: (q, row, side, x) => {
        const p = O.chanceOfProfit(x.F, row.strike, x.years, num(q?.iv) ?? x.sm.atmIv, R(side), prem(q));
        return formatPercent(p === null ? null : (1 - p) * 100, 0);
      },
    },
    dist: {
      label: "Distance",
      short: "Dist",
      title: "Distance from spot, out of the money positive (%); under it, in standard deviations to expiry at ATM IV",
      v: (q, row, side, x) => [Math.round(x.spot ?? 0), Math.round(x.F ?? 0), x.sm.atmIv],
      r: (q, row, side, x) => {
        const d = O.distance(row.strike, R(side), x.spot);
        const sd = O.sigmaDistance(row.strike, R(side), x.F, x.sm.atmIv, x.years);
        return two(d ? pct1(d.pct) : DASH, { text: sd === null ? "" : `${formatSigned(sd, 1)}σ`, force: true });
      },
    },
    premLot: { label: "Prem/lot", title: "Premium for one lot (mid × lot size)", v: (q, row, side, x) => [prem(q), x.lot], r: (q, row, side, x) => rupees(prem(q) === null ? null : prem(q) * x.lot) },
    thetaLot: { label: "θ/lot", title: "Theta per lot: rupees a long position loses in a day", v: (q, row, side, x) => [q?.theta, x.lot], r: (q, row, side, x) => rupees(num(q?.theta) === null ? null : q.theta * x.lot, true) },
    ivx: {
      label: "IV−ATM",
      title: "This strike's IV minus ATM IV (vol points): what you pay over the at-the-money volatility",
      v: (q, row, side, x) => [q?.iv, x.sm.atmIv, cfg().preset === "buyer"],
      r: (q, row, side, x) => {
        const v = num(q?.iv) !== null && x.sm.atmIv !== null ? q.iv - x.sm.atmIv : null;
        return cg(isFigure(v) ? formatSigned(v, 1) : DASH, null, cfg().preset === "buyer" && v > 2 ? "warn-ink" : "");
      },
    },
    hedge: {
      label: "Hedge lots",
      head: (x) => (x.hedgeOwn ? "Hedge lots" : "Lots / fut lot"),
      title: "Lots of this option that offset your position delta (with none, one long futures lot)",
      v: (q, row, side, x) => [q?.delta, x.netDelta, x.lot],
      r: (q, row, side, x) => formatInt(O.hedgeLots(x.netDelta, q?.delta, x.lot)),
    },
    costPct: { label: "Cost %", title: "Premium as % of spot", v: (q, row, side, x) => [prem(q), Math.round(x.spot ?? 0)], r: (q, row, side, x) => formatPercent(prem(q) !== null && x.spot ? (prem(q) / x.spot) * 100 : null, 2) },
    syn: {
      label: "Synthetic",
      row: true,
      title: "Synthetic future K + (C − P)·e^(rT) at mids; under it, executable sell – buy at the touch",
      v: (row, r_, s_, x) => { const s = x.syn.get(row.strike); return [s?.mid, s?.buy, s?.sell]; },
      r: (row, r_, s_, x) => {
        const s = x.syn.get(row.strike);
        if (!s) return DASH;
        return cg(formatFixed(s.mid, 1), sub(s.twoSided ? `${formatFixed(s.sell, 1)} – ${formatFixed(s.buy, 1)}` : ""), s.twoSided ? "" : "quiet");
      },
    },
    dev: {
      label: "Dev",
      row: true,
      head: (x) => (x.refKind === "fut" ? "Dev" : "Dev vs F"),
      title: "Synthetic minus the same-expiry future (or the chain forward when none is listed), in points; under it, ₹ per lot",
      v: (row, r_, s_, x) => [x.syn.get(row.strike)?.mid, x.ref, x.lot, x.devMax],
      r: (row, r_, s_, x) => {
        const m = x.syn.get(row.strike)?.mid;
        const d = m !== undefined && m !== null && x.ref !== null ? m - x.ref : null;
        if (!isFigure(d)) return cg(DASH);
        // Line 2: a diverging bar on one scale for every strike (left, red: the synthetic is below the reference;
        // right, green: above), so the outliers stand out down the column. ₹ per lot in the tooltip.
        const f = x.devMax > 0 ? Math.min(1, Math.abs(d) / x.devMax) : 0;
        const bar = h("span", { class: `dev-bar ${d < 0 ? "neg" : "pos"}`, "aria-hidden": "true" }, h("i"));
        bar.firstChild.style.transform = `scaleX(${r1(f * 100) / 100})`;
        return h("span", { class: "cg", title: `${formatSignedRupee(d * x.lot, 0)} per lot` }, h("span", { class: `l1${Math.abs(d) >= 0.5 ? (d < 0 ? " neg-accent" : " pos-accent") : ""}` }, formatSigned(d, 1)), h("span", { class: "l2" }, bar));
      },
    },
    edge: {
      label: "Edge",
      row: true,
      title: "Best of conversion (sell synthetic, buy the future at its ask) and reversal (buy synthetic, sell the future at its bid) at the touch, before costs",
      v: (row, r_, s_, x) => { const e = x.edge.get(row.strike); return [e?.edge, e?.kind, x.bestEdge?.strike === row.strike]; },
      r: (row, r_, s_, x) => {
        const e = x.edge.get(row.strike);
        if (!e) return DASH;
        // Green when the trade pays at the touch, quiet otherwise; the best strike carries a chip ("Best" when it
        // pays, "Closest" when nothing does), so the column answers "which strike, if any".
        const best = x.bestEdge?.strike === row.strike;
        const chip = best ? h("span", { class: `edge-chip${e.edge > 0 ? " pays" : ""}`, title: e.edge > 0 ? "The best edge in the chain" : "No strike pays at the touch: this one comes closest" }, e.edge > 0 ? "Best" : "Closest") : null;
        return cg(h("span", { title: x.refKind === "fut" ? undefined : "vs chain forward: a relative break across strikes, not a futures arbitrage" }, formatSigned(e.edge, 2)), h("small", { class: "l2" }, chip, chip ? " " : "", e.kind), e.edge > 0 ? "pos-accent" : "quiet");
      },
    },
    ivskew: {
      label: "IV P−C",
      row: true,
      title: "Put IV minus call IV at this strike (vol points)",
      v: (row) => [row.pe?.iv, row.ce?.iv],
      r: (row) => (num(row.pe?.iv) !== null && num(row.ce?.iv) !== null ? formatSigned(row.pe.iv - row.ce.iv, 1) : DASH),
    },
    pcrK: {
      label: "PCR",
      row: true,
      title: "Put OI ÷ call OI at this strike: 1.2 and up put-heavy (support), 0.8 and below call-heavy (resistance)",
      v: (row) => [row.ce?.oi, row.pe?.oi],
      r: (row) => {
        const p = O.strikePcr(row);
        return cg(formatFixed(p, 2), null, pcrSide(p) === "put" ? "put-ink" : pcrSide(p) === "call" ? "call-ink" : "");
      },
    },
    strad: {
      label: "Straddle",
      short: "Strad",
      row: true,
      title: "Call mid + put mid at this strike; under it, as % of spot",
      v: (row, r_, s_, x) => [O.strikeStraddle(row), Math.round(x.spot ?? 0)],
      r: (row, r_, s_, x) => {
        const s = O.strikeStraddle(row);
        return two(g(s, 2), { text: s !== null && x.spot ? formatPercent((s / x.spot) * 100, 2) : "", force: true });
      },
    },
    bid: { label: "Bid", trade: "SELL", title: "Bid: you sell here" },
    ask: { label: "Ask", trade: "BUY", title: "Ask: you buy here. Under it, the spread when it is wide (amber over 5%, red over 10%)" },
  };
  for (const [k, , scope] of CHAIN_COLUMNS) if (scope === "row") COLS[k].row = true;

  /** The width the chain can use: its panel (or, before it is on screen, the page column). */
  // The ResizeObserver below keeps lastAvail current, so a refresh never forces a layout just to read the width.
  const availW = () => lastAvail || host.clientWidth || document.getElementById("content")?.clientWidth || (typeof innerWidth === "number" ? innerWidth - 32 : 1200);
  /**
   * Cells per part, in screen order. Both sides: calls mirror puts around the strike (row columns just right of
   * it). One side: the strike comes first and that side reads outwards from it. The fit engine keeps what fits the
   * panel; touch screens trade from the action sheet instead of the bid / ask buttons.
   */
  const layout = () => {
    const c = cfg();
    const d = device();
    const preset = c.preset;
    let sideCols = c.cols.filter((k) => COLS[k] && !COLS[k].row);
    let rowCols = c.cols.filter((k) => COLS[k]?.row);
    let side = d.phone ? c.phoneSide : c.side;
    let quotes = c.quotes && !d.phone && !d.coarse;
    let cap = Infinity;
    if (d.phone) {
      if (preset === "arb") {
        rowCols = rowCols.slice(0, 3);
        sideCols = [];
        side = "none";
        quotes = false;
      } else if (side === "both") {
        sideCols = ["ltp", "oi"];
        rowCols = [];
      } else {
        rowCols = [];
        cap = 3;
      }
    } else if (d.narrow) cap = 5;
    const sides = side === "both" ? 2 : side === "none" ? 0 : 1;
    // A new context (columns, side, strikes window, chain, device, density): measure afresh, no extra drops.
    const fk = JSON.stringify([st.chain?.underlying, st.chain?.expiry, c.cols, side, quotes, st.strikesView, c.oiWin, c.dense, c.lots, c.pct, d.phone, d.narrow, d.coarse, typeof document === "undefined" ? "" : document.documentElement.dataset.density]);
    if (fk !== fitKey) {
      fitKey = fk;
      measured = {};
      measuredStrike = 0;
      extraDrop = 0;
    }
    const est = d.phone ? PHONE_MIN : d.coarse ? COL_MIN_COARSE : COL_MIN;
    const widths = { ...est, ...measured };
    const strikeW = measuredStrike || (d.phone ? 68 : 96);
    const fit = fitColumns({ side: sideCols, mid: rowCols, quotes, sides, avail: availW() - sbW, widths, strikeW, order: dropOrder(preset, c.cols), cap, extra: extraDrop });
    const all = new Set([...c.cols.filter((k) => COLS[k]), ...(c.quotes && sides && !d.phone && !d.coarse ? ["quotes"] : [])]);
    // Phones: columns the layout leaves out before fitting (Both = LTP and OI only; Parity = three row columns)
    // count as hidden too, so "+N hidden" and Customise tell the truth.
    const kept = new Set([...sideCols, ...rowCols]);
    const pre = d.phone ? c.cols.filter((k) => COLS[k] && !kept.has(k)) : [];
    const hidden = [...new Set([...pre, ...fit.hidden])].filter((k) => all.has(k));
    // Wide screens (layout-prefs.js wideExtras): with every chosen column on screen and room to spare, a preset adds
    // its extra columns (Greeks for OI, and so on) next to IV. Never on touch or phones, never for a custom list, and
    // not while the table's own overflow check is dropping columns.
    const extras = !d.phone && !d.coarse && c.wide && !hidden.length && !extraDrop && sides ? wideExtras({ preset, cols: c.cols, slack: availW() - sbW - fit.width, sides, widths, used: fit.width }).filter((k) => COLS[k] && !COLS[k].row) : [];
    lastFit = { hidden, kept: all.size - hidden.length, total: all.size, added: extras };
    const at = Math.max(fit.side.indexOf("iv"), fit.side.indexOf("ltp")) + 1;
    const sideCols2 = extras.length ? [...fit.side.slice(0, at), ...extras, ...fit.side.slice(at)] : fit.side;
    const near = fit.quotes ? ["bid", "ask"] : [];
    const out = [...near, ...sideCols2];
    const base = { side, mid: fit.mid, phone: d.phone, narrow: d.narrow, coarse: d.coarse, hidden };
    if (side === "none") return { ...base, order: ["strike", "mid"], ce: [], pe: [] };
    if (side === "ce") return { ...base, order: ["strike", "mid", "ce"], ce: out, pe: [] };
    if (side === "pe") return { ...base, order: ["strike", "mid", "pe"], ce: [], pe: out };
    return { ...base, order: ["ce", "strike", "mid", "pe"], ce: [...sideCols2].reverse().concat(near), pe: out };
  };
  const layoutSig = (L) => JSON.stringify([L.order, L.ce, L.pe, L.mid, L.phone, L.narrow, L.coarse, cfg().dense, cfg().lots, cfg().pct, cfg().bars, cfg().barStyle, cfg().tags, cfg().itm, cfg().positions]);

  function tradeButton(q, row, side, trade) {
    const price = trade === "BUY" ? q?.ask : q?.bid;
    if (!q || !isFigure(price) || Number(price) <= 0) return cg(h("span", { class: "muted", title: "No quote on this side" }, DASH));
    const right = R(side);
    const label = `${trade === "BUY" ? "Buy" : "Sell"} ${contractName(st.chain?.underlying ?? st.underlying, st.chain?.expiry ?? st.expiry, row.strike, right)} at ${formatFixed(price, 2)}`;
    const btn = h("button", { type: "button", class: `q-btn ${trade === "BUY" ? "buy" : "sell"}`, title: st.account ? label : "Choose an account that can place orders", "aria-label": label, disabled: !st.account, onclick: (e) => { e.stopPropagation(); onTrade(row, right, trade); } }, formatFixed(price, 2));
    // The spread's health under the ask, only when it is wide.
    const sp = trade === "BUY" ? O.spreadPct(q) : null;
    return cg(btn, sp !== null && sp > 5 ? sub(formatPercent(sp, 1), sp > 10 ? "down" : "warn-ink") : null);
  }
  const cellCls = (k, extra = "") => `num c-${k} ${extra}`.replace(/\s+/g, " ").trim();
  const headText = (k, x) => (COLS[k].head && x ? COLS[k].head(x) : k === "chg" && x?.winLabel ? `OI chg ${x.winLabel}` : k === "oi" && cfg().lots ? "OI (lots)" : k === "vol" && cfg().lots ? "Vol (lots)" : COLS[k].label);
  const headCell = (k, extra) => h("th", { scope: "col", class: cellCls(k, extra), title: COLS[k].title }, COLS[k].short ? [h("span", { class: "lbl-long" }, headText(k, null)), h("span", { class: "lbl-short", "aria-hidden": "true" }, COLS[k].short)] : headText(k, null));

  /** One strike's row: its cells by part, and the click / double-click that focus it, select it or open its sheet. */
  function makeRow(strike, L) {
    const ce = L.ce.map((k) => h("td", { class: cellCls(k, "s-ce") }));
    const pe = L.pe.map((k) => h("td", { class: cellCls(k, "s-pe") }));
    const mid = L.mid.map((k) => h("td", { class: cellCls(k, "mid-col") }));
    const th = h("th", { scope: "row", class: "strike-col" });
    const tr = h("tr", { "data-strike": strike, tabindex: "-1" }, L.order.map((part) => (part === "strike" ? th : part === "ce" ? ce : part === "pe" ? pe : mid)));
    const sideOf = (e) => {
      const cell = e.target.closest("td");
      if (cell && pe.includes(cell)) return "pe";
      if (cell && ce.includes(cell)) return "ce";
      if (L.side === "ce" || L.side === "pe") return L.side;
      return st.focus?.side ?? "ce";
    };
    // Touch: press and hold a row (500 ms, still) to add a buy leg of that side to the strategy; the tap that ends the
    // hold does not open the sheet.
    let hold = null;
    const dropHold = () => {
      if (hold && !hold.fired) {
        clearTimeout(hold.t);
        hold = null;
      }
    };
    tr.addEventListener("pointerdown", (e) => {
      if (!onHold || e.pointerType === "mouse" || !device().coarse || selecting || L.side === "none" || e.target.closest("button")) return;
      const side = sideOf(e);
      clearTimeout(hold?.t);
      const h0 = { x: e.clientX, y: e.clientY, fired: false, t: 0 };
      h0.t = setTimeout(() => {
        h0.fired = true;
        if (!reducedMotion()) {
          tr.classList.remove("hold-pulse");
          void tr.offsetWidth;
          tr.classList.add("hold-pulse");
          setTimeout(() => tr.classList.remove("hold-pulse"), 260);
        }
        navigator.vibrate?.(12);
        onHold(strike, side);
      }, 500);
      hold = h0;
    });
    tr.addEventListener("pointermove", (e) => {
      if (hold && !hold.fired && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) dropHold();
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) tr.addEventListener(ev, dropHold);
    tr.addEventListener("contextmenu", (e) => hold?.fired && e.preventDefault());
    tr.addEventListener("click", (e) => {
      if (hold?.fired) {
        hold = null;
        return;
      }
      if (e.target.closest("button")) return;
      const side = sideOf(e);
      if (selecting && L.side !== "none") {
        togglePick(strike, side);
        onFocus({ strike, side });
        return;
      }
      onFocus({ strike, side });
      const d = device();
      if (d.phone || d.coarse) onOpen(strike, side);
    });
    tr.addEventListener("dblclick", (e) => {
      if (e.target.closest("button") || device().coarse || selecting) return;
      onOpen(strike, sideOf(e));
    });
    return { tr, th, ce, pe, mid };
  }
  /**
   * The fetch window (±40 around ATM) slides when ATM moves: add the strikes that appeared and drop the ones that
   * left, in place, keeping the view on the same strike. No rebuild.
   */
  function syncRows(x) {
    const want = x.c.rows.map((r) => r.strike);
    if (want.length === built.rows.size && want.every((k) => built.rows.has(k))) return;
    const a = captureAnchor();
    const next = new Map();
    let prev = null;
    for (const k of want) {
      let b = built.rows.get(k);
      if (!b) {
        b = makeRow(k, built.L);
        b.tr.hidden = true;
        if (prev) prev.tr.after(b.tr);
        else built.body.prepend(b.tr);
      }
      next.set(k, b);
      prev = b;
    }
    for (const [k, b] of built.rows) if (!next.has(k)) b.tr.remove();
    built.rows = next;
    if (built.atmObserved && !built.atmObserved.isConnected) built.atmObserved = null;
    restoreAnchor(a);
  }

  function build(x, L, key) {
    const c = cfg();
    const span = L.ce.length + L.pe.length + L.mid.length + 1;
    const sideBtn = (side, label) =>
      h("button", { type: "button", class: "side-btn", title: c.side === side ? "Show calls and puts" : `Show ${label.toLowerCase()} only (${side === "ce" ? "C" : "V"})`, "aria-pressed": String(c.side === side), onclick: () => onSide(c.side === side ? "both" : side) }, side === "ce" ? "‹ " : "", h("i", { class: "side-sw", "aria-hidden": "true" }), label, side === "pe" ? " ›" : "");
    const midHead = L.mid.length ? [h("th", { colspan: L.mid.length, scope: "colgroup", class: "mid-col" }, L.mid.some((k) => ["syn", "dev", "edge"].includes(k)) ? "Parity" : "Strike")] : [];
    const sideHead = L.phone
      ? null
      : L.side === "both"
        ? h("tr", { class: "side-head" }, h("th", { colspan: L.ce.length, scope: "colgroup", class: "sh-ce" }, sideBtn("ce", "Calls")), h("th", { class: "strike-col" }, ""), midHead, h("th", { colspan: L.pe.length, scope: "colgroup", class: "sh-pe" }, sideBtn("pe", "Puts")))
        : h("tr", { class: "side-head" }, h("th", { class: "strike-col" }, ""), midHead, h("th", { colspan: L.ce.length + L.pe.length, scope: "colgroup", class: L.side === "pe" ? "sh-pe" : L.side === "ce" ? "sh-ce" : undefined }, h("button", { type: "button", class: "side-btn on", onclick: () => onSide("both") }, h("i", { class: "side-sw", "aria-hidden": "true" }), `${L.side === "ce" ? "Calls" : "Puts"} only`, h("span", { "aria-hidden": "true" }, " ×"))));
    const heads = [];
    const colCells = [];
    const colHead = L.order.flatMap((part) => {
      if (part === "strike") {
        // A one-side phone view has no side head: the Strike header names the side with a CE / PE chip.
        const oneSide = L.phone && (L.side === "ce" || L.side === "pe");
        const th = h("th", { scope: "col", class: "strike-col" }, "Strike", oneSide ? h("span", { class: `side-chip ${L.side}` }, L.side.toUpperCase()) : null);
        colCells.push([th, "strike"]);
        return [th];
      }
      return L[part].map((k) => {
        const th = headCell(k, part === "mid" ? "mid-col" : part === "ce" ? "s-ce" : "s-pe");
        if (COLS[k].head || k === "chg") heads.push([th, k]);
        colCells.push([th, k]);
        return th;
      });
    });
    const thead = h("thead", {}, sideHead, h("tr", { class: `col-head${L.phone ? " first" : ""}${L.phone && L.side !== "none" ? ` edge-${L.side}` : ""}` }, colHead));
    const map = new Map();
    const body = h("tbody");
    for (const row of x.c.rows) {
      const r = makeRow(row.strike, L);
      body.append(r.tr);
      map.set(row.strike, r);
    }
    const spotTag = h("span", { class: "spot-tag" });
    const spotTr = h("tr", { class: "spot-row", "aria-hidden": "true" }, h("td", { colspan: span }, spotTag));
    const cells = (part) => L[part].map((k) => h("td", { class: cellCls(k, part === "mid" ? "mid-col" : `s-${part}`) }));
    const foot = { ce: cells("ce"), th: h("th", { scope: "row", class: "strike-col" }), mid: cells("mid"), pe: cells("pe") };
    const caption = h("caption", { class: "sr-only" });
    const table = h(
      "table",
      { class: `chain side-${L.side}${c.dense ? " dense" : ""}${L.phone ? " phone" : ""}${heat() ? " heat" : ""}${selecting ? " selecting" : ""}` },
      caption,
      thead,
      body,
      h("tfoot", {}, h("tr", {}, L.order.map((part) => (part === "strike" ? foot.th : foot[part])))),
    );
    const wrap = h("div", { class: "table-wrap chain-wrap" }, table);
    wrap.addEventListener("scroll", () => hideCluster(), { passive: true });
    built = { key, table, thead, rows: map, spotTr, spotTag, foot, L, body, wrap, heads, colCells, caption, atmObserved: null, spotAnchor: null, first: true };
    return wrap;
  }

  /** Patch one cell when what it depends on changed; LTP changes are queued to flash in one frame. */
  function patchCell(td, k, q, row, side, x, flashes) {
    const col = COLS[k];
    if (col.trade) {
      const price = col.trade === "BUY" ? q?.ask : q?.bid;
      const sig = `${price}|${col.trade === "BUY" ? q?.bid : ""}|${st.account ? 1 : 0}`;
      if (td.__sig === sig) return;
      td.__sig = sig;
      setCell(td, tradeButton(q, row, side, col.trade));
      return;
    }
    const v = col.row ? col.v(row, row, side, x) : col.v(q, row, side, x);
    const sig = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    if (td.__sig === sig) return;
    td.__sig = sig;
    setCell(td, col.row ? col.r(row, row, side, x) : q ? col.r(q, row, side, x) : DASH);
    // Cell-fill heat (Customise → Bar style): the side (OI) or the change's sign (OI chg) at an alpha that grows with
    // the share of the largest; the figure stays in the foreground ink.
    if (col.heat) {
      const on = heat() && q && (k === "oi" ? cfg().bars.oi : cfg().bars.chg);
      const [kind, frac] = on ? col.heat(q, row, side, x) : ["", 0];
      const cls = on ? `heat-${kind}` : "";
      if (td.__heat !== cls) {
        if (td.__heat) td.classList.remove(td.__heat);
        if (cls) td.classList.add(cls);
        td.__heat = cls;
      }
      if (on) td.style.setProperty("--hf", String(r1(O.heatShape(frac) * 100) / 100));
      else td.style.removeProperty("--hf");
    }
    if (col.ltp) {
      const now = num(q?.ltp);
      const prev = td.__ltp;
      td.__ltp = now;
      // At most one flash per cell every FLASH_GAP_MS: with the live stream a liquid strike ticks every frame, and a
      // flash on each tick was a constant repaint (most of the page's main-thread time) and read as noise.
      const t = performance.now();
      if (prev !== undefined && prev !== null && now !== null && now !== prev && !(t - (td.__flashAt ?? -Infinity) < FLASH_GAP_MS)) {
        td.__flashAt = t;
        flashes.push([td, now > prev]);
      }
    }
  }

  /**
   * Put new content in a cell by changing the live nodes in place (text, classes, titles, bar transforms) when the
   * shape is the same: far fewer DOM mutations per tick, and a bar keeps its element, so its CSS transition resizes it
   * from the old length instead of regrowing it.
   */
  function setCell(td, content) {
    const node = typeof content === "string" || typeof content === "number" ? cg(String(content)) : content;
    const f = td.firstChild;
    if (!(f && f === td.lastChild && morph(f, node))) td.replaceChildren(node);
  }

  /**
   * Measure each column's real minimum width: the table squeezed to 0 lays every column out at its min-content (the
   * widest figure or header in it), read off the header cells, then the table is let go again. Two layouts, only on a
   * rebuild, an overflow or the 10 s retry. Returns true when a measurement changed.
   */
  function measureCols() {
    const t = built?.table;
    const wrap = built?.wrap;
    if (!t?.isConnected || !wrap.clientWidth) return false;
    sbW = Math.max(0, wrap.offsetWidth - wrap.clientWidth - 2 * wrap.clientLeft);
    t.style.width = "0px";
    t.style.minWidth = "0px";
    const got = {};
    let strike = 0;
    for (const [th, k] of built.colCells) {
      const px = Math.round(th.getBoundingClientRect().width * 10) / 10;
      if (k === "strike") strike = px;
      else got[k] = Math.max(got[k] ?? 0, px);
    }
    t.style.width = "";
    t.style.minWidth = "";
    let changed = Math.abs(strike - measuredStrike) > 0.5;
    for (const [k, v] of Object.entries(got)) if (!(Math.abs((measured[k] ?? 0) - v) <= 0.5)) changed = true;
    measured = { ...measured, ...got };
    measuredStrike = strike;
    return changed;
  }

  /** The row to keep still while rows above it appear or disappear: the focus when on screen, else the top row
   *  (`middle`: the row at the middle of the view, for a new table whose rows differ in height). */
  function captureAnchor(middle = false) {
    const wrap = built?.wrap;
    if (!wrap?.isConnected || !wrap.clientHeight) return null;
    const top = wrap.getBoundingClientRect().top + (built.thead.offsetHeight || 0);
    const bottom = wrap.getBoundingClientRect().top + wrap.clientHeight;
    const f = st.focus ? built.rows.get(st.focus.strike) : null;
    if (f && !f.tr.hidden) {
      const r = f.tr.getBoundingClientRect();
      if (r.bottom > top && r.top < bottom) return { strike: st.focus.strike, off: r.top - top };
    }
    const mid = (top + bottom) / 2;
    for (const [strike, b] of built.rows) {
      if (b.tr.hidden) continue;
      const r = b.tr.getBoundingClientRect();
      if (middle ? r.bottom > mid : r.bottom > top) return { strike, off: r.top - top };
    }
    return null;
  }
  function restoreAnchor(a) {
    const b = a && built?.rows.get(a.strike);
    if (!b || b.tr.hidden || !built.wrap.isConnected) return false;
    const top = built.wrap.getBoundingClientRect().top + (built.thead.offsetHeight || 0);
    built.wrap.scrollTop += b.tr.getBoundingClientRect().top - top - a.off;
    return true;
  }
  /**
   * Tall screens with a mouse: the ±10 / ±20 window grows to fill the table's height (strikes each side that fit
   * under the head, above the totals), never below the choice. Phones and touch keep the window as chosen.
   */
  // Measured once per table, window height and density (fitHeight clears it when the page above the table moves):
  // measuring on every refresh forced a full layout of the chain each time.
  let fillMemo = null;
  const fillStrikes = () => {
    const d = device();
    const w = built?.wrap;
    if (d.phone || d.coarse || !w?.isConnected || typeof innerHeight !== "number") return 0;
    const key = `${innerHeight}|${cfg().dense}|${densityNow()}`;
    if (fillMemo && fillMemo.key === key && fillMemo.wrap === w) return fillMemo.value;
    const top = w.getBoundingClientRect().top + (built.thead?.offsetHeight || 0);
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cfg().dense ? "--chain-row-1" : "--chain-row")) || 40;
    // Less the totals row, the key legend, the page's bottom padding and the spot divider row.
    const rows = Math.floor((innerHeight - top - 36 - 30 - 24) / rowH) - 1;
    const value = Math.max(0, Math.floor(rows / 2));
    fillMemo = { key, wrap: w, value };
    return value;
  };
  // The fill count the table was last drawn with: a density or window-height change that alters it redraws at once
  // (onWinResize), instead of waiting for the next data refresh.
  let drawnFill = null;
  let drawnDensity = null;
  const densityNow = () => (typeof document === "undefined" ? "" : document.documentElement.dataset.density ?? "");
  const visibleSet = (x) => {
    drawnFill = fillStrikes();
    drawnDensity = densityNow();
    return new Set(O.rowsAroundAtm(x.c, st.strikesView === "all" ? Infinity : Math.max(Number(st.strikesView) || 10, drawnFill)).map((r) => r.strike));
  };

  const PHONE_TAG = { mp: "MP", cw: "C wall", pw: "P wall" };
  /** Strike tags in priority order (ATM > Max pain > walls > ±1σ > ±2σ): [class, text, title]. */
  function tagsFor(row, x) {
    const c = cfg();
    const sm = x.sm;
    const t = [];
    if (row.strike === sm.atm) t.push(["atm", "ATM", "At the money"]);
    if (c.tags.mp && row.strike === sm.maxPain) t.push(["mp", "Max Pain", "Settlement at which option buyers collect the least"]);
    if (c.tags.walls && row.strike === sm.resistance?.strike) t.push(["cw", "Call wall", "Most call OI loaded: resistance"]);
    if (c.tags.walls && row.strike === sm.support?.strike) t.push(["pw", "Put wall", "Most put OI loaded: support"]);
    if (c.tags.em && row.strike === x.em1.hi) t.push(["em", "+1σ", "Upper edge of the expected move (log-normal, ATM IV to expiry)"]);
    if (c.tags.em && row.strike === x.em1.lo) t.push(["em", "−1σ", "Lower edge of the expected move (log-normal, ATM IV to expiry)"]);
    if (c.tags.em2 && row.strike === x.em2.hi) t.push(["em2", "+2σ", "Two standard deviations up (about 2.3% of outcomes land above)"]);
    if (c.tags.em2 && row.strike === x.em2.lo) t.push(["em2", "−2σ", "Two standard deviations down (about 2.3% of outcomes land below)"]);
    return t;
  }

  function patch(x) {
    const { sm, spot } = x;
    const c = cfg();
    const L = built.L;
    const flashes = [];
    const motion = !reducedMotion();
    // The ±N window: rows are hidden, never rebuilt, and the view stays put through an anchor row. Rows that come
    // into the window fade in (staggered 8 ms, 120 ms at most).
    const vis = visibleSet(x);
    let moved = false;
    for (const [strike, b] of built.rows) if (b.tr.hidden === vis.has(strike)) moved = true;
    if (moved) {
      const a = captureAnchor();
      let n = 0;
      for (const [strike, b] of built.rows) {
        const show = vis.has(strike);
        if (b.tr.hidden && show && !built.first && motion) {
          b.tr.classList.add("row-in");
          b.tr.style.setProperty("--i", String(Math.min(15, n++)));
          setTimeout(() => b.tr.classList.remove("row-in"), 420);
        }
        b.tr.hidden = !show;
      }
      restoreAnchor(a);
    }
    for (const row of x.c.rows) {
      const b = built.rows.get(row.strike);
      // Rows outside the window are patched when they come back into it (the window is applied above, first).
      if (!b || b.tr.hidden) continue;
      for (const side of ["ce", "pe"]) {
        const cells = b[side];
        if (!cells.length) continue;
        const q = row[side];
        const itm = c.itm && O.inTheMoney(row.strike, side, spot);
        L[side].forEach((k, i) => {
          const td = cells[i];
          patchCell(td, k, q, row, side, x, flashes);
          if (td.__itm !== itm) td.classList.toggle("itm", (td.__itm = itm));
        });
      }
      L.mid.forEach((k, i) => patchCell(b.mid[i], k, null, row, "mid", x, flashes));
      const tags = tagsFor(row, x);
      // At most two tags in a cell (one, in short form, on a phone's narrow strike column); the rest are in its title.
      const shown = L.phone ? tags.slice(0, 1).map(([cl, t, title]) => [cl, PHONE_TAG[cl] ?? t, `${t}: ${title}`]) : tags.slice(0, 2);
      const sig = `${row.strike}|${shown.map((t) => t[1]).join(",")}|${tags.length}`;
      if (b.th.__sig !== sig) {
        const before = new Set((b.th.__tags ?? "").split(",").filter(Boolean));
        const pop = !built.first && motion && b.th.__sig !== undefined;
        b.th.__sig = sig;
        b.th.__tags = shown.map((t) => t[1]).join(",");
        b.th.title = tags.length > shown.length ? tags.map((t) => t[1]).join(" · ") : "";
        b.th.replaceChildren(
          h(
            "span",
            { class: "cg strike-cg" },
            h("span", { class: "l1 k" }, formatInt(row.strike)),
            shown.length ? h("span", { class: "l2 tags" }, shown.map(([cl, t, title]) => h("span", { class: `tag ${cl}${pop && !before.has(t) ? " pop" : ""}`, title }, t))) : h("span", { class: "l2" }),
          ),
        );
      }
      const atm = row.strike === sm.atm;
      const inEm = c.tags.em && x.em1.lo !== null && row.strike >= x.em1.lo && row.strike <= x.em1.hi;
      const emEdge = inEm && (row.strike === x.em1.lo || row.strike === x.em1.hi);
      if (b.__atm !== atm) b.tr.classList.toggle("atm", (b.__atm = atm));
      if (b.__em !== inEm) b.tr.classList.toggle("in-em", (b.__em = inEm));
      if (b.__emE !== emEdge) b.tr.classList.toggle("em-edge", (b.__emE = emEdge));
    }
    for (const [th, k] of built.heads) {
      const t = headText(k, x);
      const lbl = th.querySelector(".lbl-long") ?? th;
      if (lbl.textContent !== t) lbl.textContent = t;
    }
    drawSpot(x);
    // Footer: totals over the strikes loaded; PCR under the strikes; the median deviation under Dev.
    const u = unit(x);
    const totals = { oi: [sm.ceOi / u, sm.peOi / u], chg: [sm.ceOiChange / u, sm.peOiChange / u], vol: [sm.ceVolume / u, sm.peVolume / u] };
    for (const [i, side] of [[0, "ce"], [1, "pe"]]) {
      L[side].forEach((k, j) => {
        const v = totals[k]?.[i];
        const t = v === undefined ? "" : k === "chg" ? formatCompact(v, { signed: true }) : formatCompact(v);
        const td = built.foot[side][j];
        if (td.textContent !== t) td.textContent = t;
        const cls = k === "chg" && v > 0 ? "up" : k === "chg" && v < 0 ? "down" : "";
        if (td.__ink !== cls) {
          if (td.__ink) td.classList.remove(td.__ink);
          if (cls) td.classList.add(cls);
          td.__ink = cls;
        }
      });
    }
    L.mid.forEach((k, j) => {
      const t = k === "dev" && x.medianDev !== null ? `Median dev ${formatSigned(x.medianDev, 1)}` : "";
      if (built.foot.mid[j].textContent !== t) built.foot.mid[j].textContent = t;
    });
    const pcrSig = `${sm.pcr}|${x.c.rows.length}`;
    if (built.foot.th.__sig !== pcrSig) {
      built.foot.th.__sig = pcrSig;
      built.foot.th.replaceChildren(h("span", { class: "foot-total" }, "Total"), h("span", { class: "foot-pcr" }, h("small", {}, "PCR "), formatFixed(sm.pcr, 2)));
      built.foot.th.title = `Put OI ÷ call OI over the ${formatInt(x.c.rows.length)} strikes loaded (±${FETCH_STRIKES} around ATM)`;
    }
    const cap = `${x.c.underlying} ${expiryText(x.c.expiry)} option chain, ${formatInt(vis.size)} strikes, ${L.side === "both" ? "calls left, puts right" : L.side === "ce" ? "calls" : L.side === "pe" ? "puts" : "put-call parity"}`;
    if (built.caption.textContent !== cap) built.caption.textContent = cap;
    watchAtm(sm.atm);
    drawPicks(x);
    built.first = false;
    if (flashes.length) {
      // One frame for every flash: the shared dv-flash keyframes (calmer in the chain: 0.14 alpha, 600 ms), restarted
      // by alternating data-flash a / b instead of a forced reflow.
      requestAnimationFrame(() => {
        for (const [td, up] of flashes) flashValue(td, up ? "up" : "down");
      });
    }
  }

  function drawSpot(x) {
    const { spot } = x;
    if (spot === null) return built.spotTr.remove();
    const q = x.indexQuote;
    const chp = num(q?.changePct);
    const fut = x.sameFut;
    const sig = JSON.stringify([spot, chp, fut?.ltp, x.F]);
    if (built.spotTag.__sig !== sig) {
      built.spotTag.__sig = sig;
      // Spot in the foreground ink, the change in gain / loss ink, the future (or forward) quiet. Phones drop the
      // future (class "wide") so the pill never widens the table.
      built.spotTag.replaceChildren(
        ...[
          h("span", { class: "wide sp-u" }, `${x.c.underlying} `),
          h("strong", {}, formatFixed(spot, 2)),
          chp !== null ? h("span", { class: `sp-chg ${chp > 0 ? "up" : chp < 0 ? "down" : ""}`.trim() }, `${formatSigned(chp, 2)}%`) : null,
          fut && num(fut.ltp) !== null
            ? h("span", { class: "fut wide", title: "Same-expiry future" }, `Fut ${formatFixed(fut.ltp, 1)}`)
            : x.F !== null
              ? h("span", { class: "fut wide", title: "No future is listed for this expiry: the forward from put-call parity" }, `F ${formatFixed(x.F, 1)}`)
              : null,
        ].filter(Boolean),
      );
    }
    let anchor = null;
    for (const row of x.c.rows) {
      if (row.strike <= spot) continue;
      const b = built.rows.get(row.strike);
      if (b && !b.tr.hidden) {
        anchor = b.tr;
        break;
      }
    }
    if (built.spotTr.nextSibling === anchor && built.spotTr.isConnected) return;
    // FLIP: the divider glides to its new gap (280 ms spring) instead of jumping.
    const td = built.spotTr.firstChild;
    const from = built.spotTr.isConnected && built.wrap.isConnected && !reducedMotion() && !built.first ? built.spotTr.getBoundingClientRect().top : null;
    built.body.insertBefore(built.spotTr, anchor);
    if (from !== null) {
      const dy = from - built.spotTr.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && Math.abs(dy) < 600) {
        td.classList.remove("flip");
        td.style.transform = `translateY(${r1(dy)}px)`;
        requestAnimationFrame(() => {
          td.classList.add("flip");
          td.style.transform = "";
          setTimeout(() => td.classList.remove("flip"), 320);
        });
      }
    }
  }

  // ── Back to ATM: a pill shows when the ATM row is scrolled out of the table's view ──
  const pill = h("button", { type: "button", class: "atm-pill", hidden: true, "aria-hidden": "true", tabindex: "-1", onclick: () => self.goAtm() });
  let observer = null;
  function watchAtm(atm) {
    if (!built || typeof IntersectionObserver !== "function") return;
    const b = built.rows.get(atm);
    if (!b || built.atmObserved === b.tr) return;
    observer?.disconnect();
    built.atmObserved = b.tr;
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target !== built?.atmObserved) continue;
          const away = !e.isIntersecting && !e.target.hidden && e.rootBounds;
          pill.hidden = !away;
          pill.setAttribute("aria-hidden", String(!away));
          pill.tabIndex = away ? 0 : -1;
          if (away) pill.textContent = `${e.boundingClientRect.top < e.rootBounds.top ? "↑" : "↓"} ATM ${formatInt(atm)}`;
        }
      },
      { root: built.wrap, rootMargin: "-56px 0px -30px 0px" },
    );
    observer.observe(b.tr);
  }

  // ── Hover: a B / S pair inside the hovered side's LTP cell, on its second line at the outer edge (fine pointers), so
  // it never covers another column. B opens the ticket at the ask, S at the bid; Shift+click adds a leg to the
  // strategy instead. Keyboard users have the Bid / Ask buttons. ──
  let hoverAt = null;
  let hoverCell = null;
  const clusterBtn = (trade) =>
    h("button", { type: "button", class: `bs-btn ${trade === "BUY" ? "buy" : "sell"}`, tabindex: "-1", title: `${trade === "BUY" ? "Buy at the ask" : "Sell at the bid"} (Shift: add a ${trade === "BUY" ? "buy" : "sell"} leg)`, onclick: (e) => {
      e.stopPropagation();
      const at = hoverAt;
      if (!at) return;
      const row = st.chain?.rows.find((r) => r.strike === at.strike);
      if (!row) return;
      if (e.shiftKey && onLeg) onLeg({ right: R(at.side), strike: at.strike, side: trade });
      else onTrade(row, R(at.side), trade);
    } }, trade === "BUY" ? "B" : "S");
  const cluster = h("div", { class: "bs-cluster", hidden: true, "aria-hidden": "true" }, clusterBtn("BUY"), clusterBtn("SELL"));
  function hideCluster() {
    if (!cluster.hidden) cluster.hidden = true;
    hoverCell?.classList.remove("bs-host");
    hoverCell = null;
    hoverAt = null;
  }
  host.addEventListener("mouseover", (e) => {
    if (!built || selecting || !finePointer()) return;
    const tr = e.target.closest?.("tbody tr[data-strike]");
    if (!tr) return;
    const strike = Number(tr.dataset.strike);
    const b = built.rows.get(strike);
    if (!b) return;
    const td = e.target.closest("td");
    const side = td && b.pe.includes(td) ? "pe" : td && b.ce.includes(td) ? "ce" : built.L.side === "pe" ? "pe" : built.L.side === "ce" ? "ce" : null;
    const i = side ? built.L[side].indexOf("ltp") : -1;
    if (i < 0 || !st.chain?.rows.find((r) => r.strike === strike)?.[side]) return hideCluster();
    if (hoverAt?.strike === strike && hoverAt?.side === side) return;
    hideCluster();
    hoverAt = { strike, side };
    const cell = b[side][i];
    const hr = host.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    const cs = getComputedStyle(cell);
    // Calls read right to left from the strike (outer edge = left); puts left to right (outer edge = right). The pair
    // sits on the cell's second line at that edge, inside its padding box: the price above it stays readable and no
    // other column is covered. The change it covers (line 2) steps aside while the pair is up.
    const outerLeft = side === "ce" && built.L.side === "both";
    const l2 = cell.querySelector(".l2");
    const lr = l2?.getBoundingClientRect();
    const y = lr && lr.height ? lr.top + lr.height / 2 : cr.top + cr.height / 2;
    cluster.hidden = false;
    cluster.style.top = `${r1(y - hr.top)}px`;
    cluster.style.left = outerLeft ? `${r1(cr.left - hr.left + parseFloat(cs.paddingLeft))}px` : `${r1(cr.right - hr.left - parseFloat(cs.paddingRight))}px`;
    cluster.classList.toggle("at-right", !outerLeft);
    hoverCell = cell;
    cell.classList.add("bs-host");
  });
  host.addEventListener("mouseleave", hideCluster);

  // ── Multi-select (m, or Select in the chain head): tick contracts, then open them in the strategy builder ──
  const pickSide = segmented("Legs", [["BUY", "Buy"], ["SELL", "Sell"]], "BUY");
  pickSide.classList.add("pick-side");
  const pickText = h("span", { class: "pick-text" });
  const pickOpen = h("button", { type: "button", class: "primary small", onclick: () => onPick?.([...picked.values()], pickSide.value) }, "Open in builder");
  const pickClear = h("button", { type: "button", class: "small plain", onclick: () => { picked.clear(); self.toggleSelect(false); } }, "Done");
  const pickBar = h("div", { class: "pick-bar", hidden: true, role: "region", "aria-label": "Selected contracts" }, pickText, pickSide, pickOpen, pickClear);
  pickSide.addEventListener("change", () => lastX && drawPicks(lastX));
  function togglePick(strike, side) {
    const k = pickKey(strike, side);
    if (picked.has(k)) picked.delete(k);
    else if (picked.size >= O.MAX_LEGS) return;
    else picked.set(k, { strike, side });
    if (lastX && built) {
      const b = built.rows.get(strike);
      const i = built.L[side]?.indexOf("ltp") ?? -1;
      const row = lastX.c.rows.find((r) => r.strike === strike);
      if (b && i >= 0 && row) patchCell(b[side][i], "ltp", row[side], row, side, lastX, []);
      drawPicks(lastX);
    }
  }
  function drawPicks(x) {
    pickBar.hidden = !selecting;
    if (!selecting) return;
    const sgn = pickSide.value === "BUY" ? -1 : 1;
    let net = 0;
    for (const p of picked.values()) {
      const m = prem(x.c.rows.find((r) => r.strike === p.strike)?.[p.side]);
      if (m !== null) net += sgn * m * x.lot;
    }
    const t = picked.size ? `${formatInt(picked.size)} leg${picked.size === 1 ? "" : "s"} · Net ${rupees(net, true)}` : "Tap contracts to select";
    if (pickText.textContent !== t) pickText.textContent = t;
    pickOpen.disabled = !picked.size;
  }

  // ── Phone: one side at a time, a Calls | Puts | Both switch in the head row, and a swipe between calls and puts ──
  const phoneSeg = segmented("Show on phone", [["ce", "Calls"], ["pe", "Puts"], ["both", "Both"]], cfg().phoneSide);
  phoneSeg.addEventListener("change", () => onPhoneSide(phoneSeg.value));
  const parityNote = h("span", { class: "parity-note" }, "Parity view");
  const phoneBar = h("div", { class: "phone-side" }, phoneSeg, parityNote);
  const note = h("div", { class: "chain-note", hidden: true });
  const live = h("div", { class: "sr-only", "aria-live": "polite" });
  let sx = null;
  host.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    sx = e.touches.length === 1 && e.target.closest?.(".chain-wrap") ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  host.addEventListener("touchend", (e) => {
    if (!sx || !built?.L.phone) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx.x;
    const dy = t.clientY - sx.y;
    sx = null;
    if (Math.abs(dx) < 56 || Math.abs(dx) <= 2 * Math.abs(dy) || built.L.side === "both" || built.L.side === "none") return;
    onPhoneSide(dx < 0 ? "pe" : "ce");
  }, { passive: true });
  const drawPhoneBar = (L) => {
    const arb = L.side === "none";
    if (phoneSeg.value !== cfg().phoneSide) phoneSeg.value = cfg().phoneSide;
    for (const b of phoneSeg.querySelectorAll("button")) b.disabled = arb;
    phoneSeg.classList.toggle("custom", arb);
    parityNote.hidden = !arb;
  };

  // ── Fit and height: the panel's width decides the columns; the viewport decides the table's height, so its sticky
  // totals row is always on screen (above the phone tab bar). ──
  let roTimer = 0;
  const ro =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          clearTimeout(roTimer);
          roTimer = setTimeout(() => {
            const w = host.clientWidth;
            if (!w || !built || !lastX || Math.abs(w - lastAvail) < 2) return;
            lastAvail = w;
            extraDrop = 0;
            fitHeight();
            const L = layout();
            if (layoutSig(L) !== built.sig) self.draw(lastX);
          }, 120);
        })
      : null;
  ro?.observe(host);
  // The note above the table (a failed refresh) changes where the table starts: refit its height so the totals row
  // and the key legend stay on screen without page scroll.
  const noteRo = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitHeight()) : null;
  function fitHeight() {
    fillMemo = null;
    const w = built?.wrap;
    if (!w?.isConnected) return;
    const top = w.getBoundingClientRect().top + (window.scrollY || 0);
    const bar = document.querySelector(".tabbar");
    const barH = bar && getComputedStyle(bar).display !== "none" ? Math.max(0, innerHeight - bar.getBoundingClientRect().top) + 8 : 0;
    const keys = host.parentNode?.querySelector?.(".desk-keys");
    // Wide screens put the key legend beside the expiry chips (app.css section 16): then it is not below the table.
    const below = keys && getComputedStyle(keys).display !== "none" && keys.getBoundingClientRect().top >= w.getBoundingClientRect().top ? keys.offsetHeight : 0;
    const want = Math.max(320, Math.floor(innerHeight - top - below - 14 - barH));
    const px = `${want}px`;
    if (w.style.maxHeight !== px) w.style.maxHeight = px;
    // Whatever sits below the panel (the page's bottom padding) must fit too: no page scroll on desktop.
    const over = Math.ceil(document.documentElement.scrollHeight - innerHeight);
    if (!barH && over > 0 && over < 120 && want - over >= 320) w.style.maxHeight = `${want - over}px`;
  }
  // Its own timer: the ResizeObserver above clears roTimer when the same change resizes the host, which used to drop
  // this refit (a density switch then waited for the next data refresh).
  let winTimer = 0;
  const onWinResize = () => {
    clearTimeout(winTimer);
    winTimer = setTimeout(() => {
      fitHeight();
      // Compact / comfortable rows (or a taller window) change how many strikes fill the table: redraw now.
      if (lastX && built && drawnFill !== null && (densityNow() !== drawnDensity || (st.strikesView !== "all" && fillStrikes() !== drawnFill))) {
        built.stale = true;
        self.draw(lastX);
      }
    }, 120);
  };
  addEventListener("resize", onWinResize);

  // ── Focus: one row at a time (roving tabindex), announced to screen readers ──
  let sayTimer = null;
  let lastSaid = "";
  function announce() {
    const f = st.focus;
    const row = f && st.chain?.rows.find((r) => r.strike === f.strike);
    const q = row?.[f.side];
    if (!q) return;
    const text = `${formatInt(f.strike)} ${f.side === "ce" ? "call" : "put"}, LTP ${g(q.ltp, 2)}, delta ${g(q.delta, 2)}, OI ${formatCompact(q.oi)}`;
    if (text === lastSaid) return;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => {
      lastSaid = text;
      live.textContent = text;
    }, 600);
  }
  /** Touch layouts: scroll the page so the whole table sits above the floating tab bar before moving inside it. */
  const bringIntoView = () => {
    const w = built?.wrap;
    if (!w?.isConnected) return;
    const bar = document.querySelector(".tabbar");
    const barTop = bar && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().top : window.innerHeight;
    const r = w.getBoundingClientRect();
    if (r.top < 0 || r.bottom > barTop) (w.closest("section") ?? w).scrollIntoView({ block: "start", behavior: "instant" });
  };
  const centre = (tr) => {
    const w = built.wrap;
    const top = w.getBoundingClientRect().top + (built.thead.offsetHeight || 0);
    const view = w.clientHeight - (built.thead.offsetHeight || 0) - 36;
    w.scrollTop += tr.getBoundingClientRect().top - top - (view - tr.offsetHeight) / 2;
    // Snap so the first visible row starts right under the sticky header, not cut in half (rows differ in height:
    // the spot row is shorter, so this looks at the actual row there).
    const first = [...tr.parentNode.children].find((r) => r.offsetHeight && r.getBoundingClientRect().bottom > top + 1);
    const cut = first ? top - first.getBoundingClientRect().top : 0;
    if (cut > 0.5) w.scrollTop -= cut;
  };

  const self = {
    /** Phones: the Calls | Puts | Both switch, placed in the chain's head row by desk.js (hidden from 720 px up). */
    phoneBar,
    reset(keepView = false) {
      extraDrop = 0;
      if (!keepView) {
        built = null;
        centred = false;
        // Picks are contracts of this underlying and expiry: a new chain starts with none (and select mode off).
        picked.clear();
        pickBar.hidden = true;
        if (selecting) {
          selecting = false;
          onSelectChange?.(false);
        }
        observer?.disconnect();
        pill.hidden = true;
        hideCluster();
      } else if (built) built.stale = true;
    },
    draw(x) {
      lastX = x;
      if (!x.c.rows.length) {
        const next = onNextExpiry?.();
        host.replaceChildren(emptyState("chart", `No strikes for ${x.c.underlying} ${expiryText(x.c.expiry)}`, "This expiry has no listed strikes yet. Pick another expiry.", next ? h("button", { type: "button", class: "small", onclick: next }, "Next expiry") : null, { compact: true }));
        built = null;
        return;
      }
      // Read the width only until the ResizeObserver has measured it: a read here, after the page's other writes,
      // forced a full layout of the chain on every refresh.
      if (!lastAvail) lastAvail = host.clientWidth || lastAvail;
      const L = layout();
      const sig = layoutSig(L);
      const key = [x.c.underlying, x.c.expiry, sig].join("|");
      drawPhoneBar(L);
      onRelayout?.(lastFit);
      if (built && built.key === key && !built.stale) {
        syncRows(x);
        patch(x);
        // Content can outgrow its minimum (a wider figure): never scroll sideways. Re-measure and refit (a column
        // drops when it truly no longer fits); every 10 s, also when something is hidden, so it comes back once the
        // figures shrink again.
        if (!overflowCheck) {
          overflowCheck = requestAnimationFrame(() => {
            overflowCheck = 0;
            const w = built?.wrap;
            if (!w?.isConnected || !w.clientWidth) return;
            const over = w.scrollWidth > w.clientWidth + 1;
            const now = Date.now();
            const retry = !over && now >= retryAt && (lastFit.hidden.length > 0 || extraDrop > 0) && !document.hidden && !w.matches(":hover") && !w.contains(document.activeElement);
            if (!over && !retry) return;
            if (retry) retryAt = now + 10000;
            measureCols();
            if (retry && extraDrop > 0) extraDrop -= 1;
            if (layoutSig(layout()) !== built.sig) {
              refits = 0;
              built.stale = true;
              self.draw(lastX);
            } else if (over && extraDrop < 6) {
              extraDrop += 1;
              built.stale = true;
              self.draw(lastX);
            }
          });
        }
        return;
      }
      // A new table: only when the strike list or the layout changed. Keep the view on the same strike (the one at
      // the middle of the view: rows differ in height between presets).
      const old = built;
      const carried = pending;
      pending = null;
      const anchor = carried ? carried.anchor : old?.wrap.isConnected ? captureAnchor(true) : null;
      const keepX = carried ? carried.keepX : old?.wrap.isConnected ? old.wrap.scrollLeft : null;
      const keepH = old?.wrap.style.maxHeight ?? "";
      const wrap = build(x, L, key);
      built.sig = sig;
      if (keepH) wrap.style.maxHeight = keepH;
      patch(x);
      if (old?.wrap.isConnected && host.contains(old.wrap)) old.wrap.replaceWith(wrap);
      else {
        host.replaceChildren(note, wrap, pill, cluster, pickBar, live);
        noteRo?.observe(note);
      }
      self.paintFocus();
      built.atmObserved = null;
      observer?.disconnect();
      watchAtm(x.sm.atm);
      // The first draw happens before the page is on screen: wait until the table has a size, then place it.
      let frames = 0;
      const place = () => {
        if (!wrap.isConnected || !wrap.clientWidth) {
          if (++frames < 120) requestAnimationFrame(place);
          return;
        }
        fitHeight();
        if (built?.wrap !== wrap) return;
        // Laid out against estimates: measure the real column widths (and the page's real width), then refit. The
        // rebuild happens before the browser paints, keeping this table's anchor; at most 3 refits in a row.
        lastAvail = host.clientWidth || lastAvail;
        const redo = () => {
          refits += 1;
          pending = { anchor, keepX };
          built.stale = true;
          return self.draw(lastX);
        };
        if (refits < 3) {
          measureCols();
          if (layoutSig(layout()) !== built.sig) return redo();
          // Still wider than the panel (a measurement missed something): drop one more column (at most 6).
          if (wrap.scrollWidth > wrap.clientWidth + 1 && extraDrop < 6 && L.ce.length + L.pe.length + L.mid.length > 2) {
            extraDrop += 1;
            return redo();
          }
        }
        refits = 0;
        retryAt = Date.now() + 10000;
        if (keepX !== null) wrap.scrollLeft = keepX;
        else if (L.side === "both") wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;
        if (anchor && restoreAnchor(anchor)) centred = true;
        else if (!centred) {
          // A strike handed over from another page (OI, Option Screener) is centred instead of ATM.
          const focusTr = st.focus ? built?.rows.get(st.focus.strike)?.tr : null;
          const atm = focusTr && !focusTr.hidden ? focusTr : built?.rows.get(x.sm.atm)?.tr;
          if (atm && wrap.scrollHeight > wrap.clientHeight) centre(atm);
          if (focusTr && !focusTr.hidden) {
            bringIntoView();
            focusTr.focus({ preventScroll: true });
          }
          centred = true;
        }
      };
      if (wrap.isConnected && wrap.clientWidth) place();
      else requestAnimationFrame(place);
    },
    /** A one-line status above the table (errors after data), or null to hide it. */
    note(content) {
      const was = note.hidden;
      note.hidden = !content;
      const sig = content ? content.textContent : "";
      if (note.__sig === sig) {
        if (was !== note.hidden) fitHeight();
        return;
      }
      note.__sig = sig;
      note.replaceChildren(...(content ? [content] : []));
      fitHeight();
    },
    paintFocus(scroll = false, focusRow = false) {
      if (!built?.rows) return;
      const atm = O.atmRow(st.chain)?.strike;
      for (const [strike, b] of built.rows) {
        const on = st.focus?.strike === strike;
        if (b.__on !== on) {
          b.__on = on;
          b.tr.classList.toggle("focus", on);
          if (on) b.tr.setAttribute("aria-current", "true");
          else b.tr.removeAttribute("aria-current");
        }
        const tab = on || (!st.focus && strike === atm) ? 0 : -1;
        if (b.tr.tabIndex !== tab) b.tr.tabIndex = tab;
        for (const side of ["ce", "pe"]) for (const td of b[side]) {
          const fs = on && st.focus.side === side;
          if (td.__fs !== fs) td.classList.toggle("fside", (td.__fs = fs));
        }
        if (on && scroll) {
          if (b.tr.hidden) onWindowAll();
          const w = built.wrap;
          const r = b.tr.getBoundingClientRect();
          const wr = w.getBoundingClientRect();
          const top = wr.top + (built.thead.offsetHeight || 0);
          if (r.top < top) w.scrollTop -= top - r.top;
          else if (r.bottom > wr.top + w.clientHeight - 36) w.scrollTop += r.bottom - (wr.top + w.clientHeight - 36);
        }
        if (on && focusRow && document.activeElement !== b.tr && !b.tr.contains(document.activeElement)) b.tr.focus({ preventScroll: true });
      }
      if (st.focus) announce();
    },
    /** Scroll a strike to the middle of the table, focus it and tint it briefly. */
    jump(strike, side) {
      if (!built) return false;
      let b = built.rows.get(strike);
      if (!b) return false;
      if (b.tr.hidden) {
        onWindowAll();
        b = built.rows.get(strike);
        if (!b) return false;
      }
      bringIntoView();
      centre(b.tr);
      st.focus = { strike, side };
      self.paintFocus(false, true);
      if (!reducedMotion()) {
        b.tr.classList.remove("jump");
        requestAnimationFrame(() => {
          b.tr.classList.add("jump");
          setTimeout(() => b.tr.classList.remove("jump"), 700);
        });
      }
      return true;
    },
    goAtm() {
      const atm = O.atmRow(st.chain)?.strike;
      if (atm === undefined || !built) return;
      const L = built.L;
      const side = L.side === "ce" || L.side === "pe" ? L.side : st.focus?.side ?? "ce";
      self.jump(atm, side);
    },
    /** Multi-select on / off (m). Returns the new state. */
    toggleSelect(on = !selecting) {
      selecting = Boolean(on);
      if (!selecting) picked.clear();
      onSelectChange?.(selecting);
      hideCluster();
      if (built) built.table.classList.toggle("selecting", selecting);
      if (built) built.stale = true;
      if (lastX) self.draw(lastX);
      else drawPicks(lastX);
      return selecting;
    },
    /** Keyboard: Space / Enter in select mode ticks the focused contract. */
    pick(strike, side) {
      if (!selecting) return false;
      togglePick(strike, side);
      return true;
    },
    clearPicks() {
      picked.clear();
      if (built) built.stale = true;
      if (lastX) self.draw(lastX);
    },
    get selecting() {
      return selecting;
    },
    /** What the fit engine kept at this width: { kept, total, hidden: [keys] } ("quotes" = Bid / Ask). */
    fitInfo: () => lastFit,
    visibleStrikes: () => (built?.rows ? [...built.rows].filter(([, b]) => !b.tr.hidden).map(([k]) => k) : []),
    atmStrike: () => O.atmRow(st.chain)?.strike ?? null,
    /** The side a key or tap acts on in the current layout. */
    sideNow: () => (built?.L.side === "ce" || built?.L.side === "pe" ? built.L.side : st.focus?.side ?? "ce"),
    layoutSide: () => built?.L.side ?? null,
    colTitle: (k) => COLS[k]?.title,
    isRowCol: (k) => Boolean(COLS[k]?.row),
    fitHeight: () => fitHeight(),
    destroy() {
      ro?.disconnect();
      noteRo?.disconnect();
      removeEventListener("resize", onWinResize);
      clearTimeout(winTimer);
      clearTimeout(roTimer);
    },
    get x() {
      return lastX;
    },
  };
  return self;
}

/** symbol -> signed lots held, from GET /v1/positions rows. */
function heldLots(positions, lot) {
  const out = new Map();
  for (const p of positions ?? []) {
    const q = Number(p.netQty);
    if (q) out.set(p.symbol, Math.round((q / lot) * 100) / 100);
  }
  return out;
}
