// The Option Desk: a live option chain you can trade from, a strategy builder with payoffs, OI analysis and your
// positions on the same underlying. Data is GET /v1/expiries, /v1/optionchain and /v1/positions; orders go through
// POST /v1/orders/preview and /v1/orders like every other client, so the Bridge's safety gates apply unchanged.
//
// Built for refresh every few seconds: the chain table is built once per (underlying, expiry, strikes, columns) and
// then patched cell by cell, so nothing flickers, scroll and keyboard focus stay put, and only cells that changed
// flash. The maths lives in options.js (pure, tested); numbers are formatted by format.js only.
import { DEMO_EXPLAINER, alertBox, api, app, emptyState, errorState, h, icon, liveControl, loadingState, modal, mountToolbarCtx, optional, prefetch, sheetPopover, toast, touchWord } from "./app.js";
import { DASH, MINUS, ageText, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, formatSignedPercent, formatSignedRupee, isFigure } from "./format.js";
import { arbPanels } from "./arbitrage.js";
import { openChainSheet } from "./chain-sheet.js";
import { installChainInsight, openChainHelp } from "./chain-insight.js";
import { createOiPage, oiConfig } from "./oi.js";
import { oiStore, snapKey } from "./oi-store.js";
import { createBuilder } from "./strategy.js";
import * as O from "./options.js";
import * as M from "./chain-metrics.js";
import * as CF from "./chain-facts.js";
import { createPositionsPage } from "./positions.js";
import { cap, every, segField, segmented, stopTimer } from "./views.js";
import { openSymbolSearch } from "./symbol-search.js";
import { wideExtras } from "./layout-prefs.js";
import { createVolPage, volConfig } from "./vol.js";
import { demoStaleAsked, lotConfirmGate, lotStaleCheck, loadReference, refBanners, refCalendar, refCharges, refChip, refRate, refSession, refSignature } from "./reference.js";
import { readinessSheetRow } from "./readiness.js";
import { loadPricingContext } from "./vol-context.js";
import { animatePage, barsEnter, flashValue } from "./motion.js";
import { riskAfterCharges, ticketRisk } from "./flows.js";
import { depthView } from "./orders-core.js";
import { whatToDo } from "./reasons-core.js";
import { watch } from "./live.js";
import { SPAN_METHOD, marginLegsOf, portfolioMargin } from "./span-margin.js";
import { checksForLaterDay, gttFillPrice, gttLimit, gttLimitWarning, gttValidityText, marketClosedAt, opFor, slTriggerStart, stopOrderProblem, stopOrderText, triggerBody, triggerProblem } from "./trigger-core.js";

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
/** After a chain loads, the next expiry is prefetched this much later (background priority). */
const NEXT_EXPIRY_DELAY_MS = 1500;
/** Shortest gap between two price flashes on one chain cell (live ticks arrive every frame on liquid strikes). */
const FLASH_GAP_MS = 2500;
/** The chain's work per frame on a tick or a refresh (ms of script); the rows left over go to the next frame. */
const FRAME_BUDGET_MS = 5;
/** OI Analysis takes live ticks at most this often (ms). */
const OI_GAP_MS = 50;
/** Outside market hours nothing moves: refresh every 30 s instead. */
const CLOSED_REFRESH_MS = 30000;
/** Pages that place orders show the account select (P1: a control only where it changes what the page does). */
const TRADING = new Set(["chain", "strategy", "positions", "arb"]);
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const WEEKDAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", weekday: "short" });
/** The IST date (YYYY-MM-DD) of an ISO time, or of now. */
const istDay = (iso) => {
  const t = iso ? Date.parse(iso) : Date.now();
  return new Date((Number.isFinite(t) ? t : Date.now()) + 330 * 60_000).toISOString().slice(0, 10);
};
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
/**
 * The quotes a desk page waits for before it draws: the index, the two nearest futures (the ones the recorder streams,
 * so they answer at once) and the selected expiry's own future. The farther futures are cold broker reads (about one
 * round trip), so while any of them has no quote yet they are read alongside and filled in when they come (`later`).
 * Once every far future has a quote the page reads them all in one call, as before (no extra request per refresh).
 */
export const NEAR_FUTURES = 2;
export function quotePlan(indexSymbol, futures, expiry, have = () => false) {
  const now = indexSymbol ? [indexSymbol] : [];
  const later = [];
  (futures ?? []).forEach((f, i) => {
    if (f?.symbol) (i < NEAR_FUTURES || f.expiry === expiry ? now : later).push(f.symbol);
  });
  return later.every(have) ? { now: [...now, ...later], later: [] } : { now, later };
}
/**
 * Read `plan.now` and resolve with its answer; `plan.later` is read at the same time and never awaited: `onLater`
 * gets its answer when it arrives. `read(symbols)` returns a promise of the page's { data, error } answer.
 */
export function readQuotes(read, plan, onLater) {
  if (plan.later.length) read(plan.later).then(onLater, () => {});
  return plan.now.length ? read(plan.now) : Promise.resolve(null);
}
const INDEX_SYMBOL = { NIFTY: "NSE:NIFTY", BANKNIFTY: "NSE:BANKNIFTY", FINNIFTY: "NSE:FINNIFTY", MIDCPNIFTY: "NSE:MIDCPNIFTY", SENSEX: "BSE:SENSEX", BANKEX: "BSE:BANKEX" };
const EXPIRY_DAY_NOTE = "Index option shorts carry +2% ELM today; no calendar-spread margin benefit; ITM longs left to exercise pay STT 0.125% of intrinsic. Square off to pay 0.1% of premium instead.";
/** Freeze quantities by symbol (GET /v1/instruments/{symbol}), for the session. */
const freezeCache = new Map();
const freezeLoading = new Set();
/** The chain's keys: [keys, what they do] (the legend under the table and the ? overlay). */
const CHAIN_KEYS = [
  [["J", "K"], "strike", "Next / previous strike (↓ ↑ too)"],
  [["←", "→"], "side", "Calls / puts side (H L too)"],
  [["/"], "search", "Search: a symbol (NIFTY, RELIANCE) or a strike (26400, 264, +3, -2σ, atm, mp). Typing any letter that is not a key here (n, f, a…) opens it too"],
  [["[", "]"], "expiry", "Previous / next expiry"],
  [["1–5"], "view", "Columns: OI, Buyer, Seller, Hedger, Arb (Customise has every view)"],
  [["C", "V"], "calls / puts", "Calls only / puts only (again: both)"],
  [["M"], "select", "Select contracts for the Strategy Builder (Space ticks one)"],
  [["↵"], "sheet", "Open the action sheet for the strike"],
  [["B"], "buy", "Order ticket: buy at the ask"],
  [["S"], "sell", "Order ticket: sell at the bid"],
  [["⇧B", "⇧S"], "add to strategy", "Add a buy / sell leg to the strategy"],
  [["T"], "build around", "Build a strategy around the strike: straddle, strangle, condor, spreads, butterfly, calendar (right-click or long-press the strike too)"],
  [["X"], "exit", "Exit the position you hold in this contract"],
  [["G"], "ATM", "Back to ATM (Home too)"],
  [["P"], "pause", "Pause / resume live updates"],
  [["R"], "refresh", "Refresh now"],
  [["I"], "explain", "Explain a cell of the focused row (again: the next column out)"],
  [["?"], "keys", "This list"],
  [["Esc"], "clear", "Clear the focus; close the sheet or the search"],
];
const KEY_LEGEND = CHAIN_KEYS.filter((k) => !["R", "Esc", "M", "X", "T"].includes(k[0][0]));
/** A strategy built from the chain, handed to the Strategy Builder (which offers Undo): { u, label, prev }. */
export const FROM_CHAIN_SLOT = "mcb.dashboard.fromChain";
/** A typed trade from the palette (trade-intent.js intentHandoff): { underlying, expiry, jump, ticket } or { ..., baskets }. */
export const TRADE_HANDOFF_SLOT = "mcb.dashboard.tradeHandoff";
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
    if (d.onKey(e)) {
      e.preventDefault();
      return true;
    }
    // The symbol search: "/", or a letter that is not one of the page's keys (desk.bound). Not over an open popover,
    // menu or the search itself.
    const letter = /^[a-z]$/i.test(e.key) && !(d.bound ?? "").includes(e.key.toLowerCase());
    if (!d.search || !(e.key === "/" || letter) || document.querySelector(".popover.floating, .ctx-menu, .sym-search")) return false;
    e.preventDefault();
    d.search(e.key === "/" ? "" : e.key);
    return true;
  };
  // "/" and "?" mean the symbol search and the page's keys here, ahead of the app-wide palette and shortcuts.
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
  // A typed trade from the Ctrl K palette arrives in its own slot (TRADE_HANDOFF_SLOT), which the page on screen
  // cannot overwrite when it saves its state on the way out; it is read once here and cleared.
  let prefs = readPrefs();
  try {
    const ho = JSON.parse(local.get(TRADE_HANDOFF_SLOT) ?? "null");
    if (ho && typeof ho === "object" && (kind === "chain" ? ho.ticket : ho.baskets)) {
      local.set(TRADE_HANDOFF_SLOT, null);
      prefs = { ...prefs, ...ho };
      local.set(SLOT, JSON.stringify(prefs));
    }
  } catch {
    // No handoff.
  }
  const base = app.state.demo ? DEMO_UNDERLYINGS : UNDERLYINGS;
  // A stock opened from a watchlist's Chain link (prefs.stockChain) joins the underlying list for the session.
  const stock = typeof prefs.stockChain === "string" && /^[A-Z0-9&-]{1,20}$/.test(prefs.stockChain) ? prefs.stockChain : null;
  // Mutable: a stock picked in the symbol search replaces the session's stock (one at a time, as before).
  const list = stock && !base.includes(stock) ? [...base, stock] : [...base];
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
  const save = () => local.set(SLOT, JSON.stringify({ underlying: st.underlying, stockChain: list.find((u) => !base.includes(u)) ?? null, expiry: st.expiry, strikes: st.strikes, chain: st.cfg, account: st.account, live: st.live, baskets: st.baskets, oi: st.oi, strategy: st.scfg ?? undefined, whatIf: st.whatIf ?? undefined, pos: st.pos, vol: st.vol, arb: st.arb }));
  const account = () => tradable.find((a) => a.id === st.account) ?? null;
  // Strategy drafts are keyed by underlying; each leg carries its own expiry (docs/design/strategy.md §5.1).
  const basketKey = () => st.underlying;
  const basket = () => (st.baskets[basketKey()] ??= []);

  // ── Toolbar ──
  const uSel = h("select", { "aria-label": "Underlying", class: "desk-u" }, list.map((u) => h("option", { value: u, selected: u === st.underlying }, u)));
  const eSel = h("select", { "aria-label": "Expiry" });
  // Simple | Advanced (the chain's toolbar; on a phone the first section of Customise, Chain view).
  const modeSeg = segmented("Chain view", [["simple", "Simple"], ["advanced", "Advanced"]], st.cfg.mode);
  modeSeg.classList.add("mode-seg");
  modeSeg.title = "Simple prints plain figures; Advanced adds bars, the market line's extras, the straddle table and pinning";
  const gearBtn = h("button", { type: "button", class: "small gear-btn", "aria-haspopup": "dialog", "aria-label": "Customise the chain", title: "Customise the chain: view, strikes, market line, columns" }, icon("sliders"), h("span", { class: "gear-label" }, "Customise"));
  const staleText = document.createTextNode("Stale");
  const stalePill = h("span", { class: "pill warn chain-stale", role: "status", hidden: true }, h("span", { class: "pdot", "aria-hidden": "true" }), staleText);
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
  const uItem = h("label", { class: "ctx-item ctx-pick ctx-u", title: "Underlying: type a letter or / to search", "data-search": "" }, h("span", { class: "ctx-main" }, uMain), h("span", { class: "ctx-sub", "aria-hidden": "true" }, uSub, h("span", { class: "ctx-sub-chg" }, uChg)), uSel);
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
    drawExpiryCap();
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
    if (kind === "chain") spotItem.title = `Spot (the index) and its change today. ${fut ? "Future" : "Synthetic forward"} ${futV.data}${basis === null ? "" : ` (basis ${formatSigned(basis, 1)})`} · ATM IV ${ivV.data}`;
    fitCtxIfNeeded();
  }
  /** Drop the line's figures in order (ATM IV, Lot, the basis, Fut / F, the expiry's long form, the absolute change;
   *  on the chain, whose market line repeats it, then the spot's whole move) until it fits. */
  const CTX_DROP = ["d-sig", "d-iv", "d-lot", "d-basis", "d-fut", "d-elong", "d-chg", ...(kind === "chain" ? ["d-move"] : [])];
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
    if (!cap?.isConnected) return;
    cap.classList.remove(...CTX_DROP);
    // The page pill is always its icon here (the sidebar and the tab bar name the page), in every state, so the line
    // never shifts when the data arrives; then figures drop.
    document.querySelector(".toolbar-title")?.classList.add("icon-only");
    const bar = cap.parentElement;
    bar?.classList.remove("ctx-no-ref");
    for (const c of CTX_DROP) {
      if (cap.scrollWidth <= cap.clientWidth + 1) break;
      cap.classList.add(c);
    }
    // Still cut (a phone: the expiry read "3"): the reference chip gives way last; the lot size stays in the ⋯ sheet
    // and the contract facts.
    if (bar && cap.scrollWidth > cap.clientWidth + 1) bar.classList.add("ctx-no-ref");
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
  // A typed trade from the Ctrl K palette: once the chain is on screen, the ticket opens filled in (never sent).
  let ticketIntent = kind === "chain" && prefs.ticket && typeof prefs.ticket === "object" ? prefs.ticket : null;
  if (prefs.jump || prefs.focus || prefs.ticket) {
    const { jump: _drop, focus: _drop2, ticket: _drop3, ...rest } = prefs;
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
      // An expiry list read up to 30 s ago (the picker warmed it) answers at once; it changes once a day.
      const r = await api(`/v1/expiries?underlying=${encodeURIComponent(st.underlying)}`, { paintOld: true });
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
  }
  /** The underlying's futures (once per underlying): the same-expiry one is the arbitrage reference. */
  async function loadFutures() {
    const u = st.underlying;
    const r = await optional(api(`/v1/instruments/search?q=${encodeURIComponent(u)}&kind=FUT&underlying=${encodeURIComponent(u)}`));
    if (u !== st.underlying) return;
    st.futures = (r.data?.data ?? []).filter((f) => f.kind === "FUT" && f.underlying === u && /^\d{4}-\d{2}-\d{2}$/.test(f.expiry ?? "")).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    if (st.futures.length && st.expiries.length) drawExpiryOptions();
  }
  /**
   * The index and its futures, for the spot row: a failed call leaves the page as it was. A far future without a quote
   * yet does not hold the draw (quotePlan): its quote is filled in, and the page redrawn, when it arrives.
   */
  async function loadQuotes() {
    const u = st.underlying;
    const plan = quotePlan(INDEX_SYMBOL[u], st.futures, st.expiry, (sym) => st.quotes.has(sym));
    const read = (syms) => optional(api(`/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}`));
    const r = await readQuotes(read, plan, (late) => {
      if (u !== st.underlying || late.error || !pageRoot.isConnected) return;
      for (const q of late.data?.data ?? []) if (q?.symbol) st.quotes.set(q.symbol, q);
      if (st.chain) drawAll();
    });
    if (!r) return;
    st.quotesError = r.error ?? null;
    if (r.error) return;
    for (const q of r.data?.data ?? []) if (q?.symbol) st.quotes.set(q.symbol, q);
  }
  /** The chain read of this page for an expiry (one URL, so a prefetch and the load share the answer). */
  function chainPath(expiry) {
    const strikes = kind === "oi" ? OI_FETCH_STRIKES : kind === "vol" ? VOL_STRIKES : FETCH_STRIKES;
    return `/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(expiry)}&strikes=${strikes}&greeks=${kind === "vol" ? "false" : "true"}&ivModel=b76-forward`;
  }
  /** underlying|expiry of the last chain loaded (a new one may paint from a prefetch and warms the next expiry). */
  let loadedKey = null;
  let nextTimer = 0;
  /**
   * After a chain loads, warm the next expiry's (background priority, one read): the most likely next click. Waits
   * for a quiet moment so it never competes with this page's own first reads.
   */
  function prefetchNextExpiry() {
    if (!["chain", "oi", "strategy"].includes(kind)) return;
    clearTimeout(nextTimer);
    nextTimer = setTimeout(() => {
      const i = st.expiries.indexOf(st.expiry);
      const next = i >= 0 ? st.expiries[i + 1] : null;
      if (!next || !pageRoot.isConnected || document.hidden) return;
      const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : (fn) => setTimeout(fn, 0);
      idle(() => prefetch(chainPath(next)));
    }, NEXT_EXPIRY_DELAY_MS);
  }
  async function loadChain({ draw = true } = {}) {
    if (!st.expiry) return;
    const seq = st.seq;
    const t0 = performance.now();
    try {
      // The Volatility page recomputes IVs and deltas itself (no server Greeks); every page loads the index quote,
      // which the top bar's spot and its change come from.
      // The first read of an expiry may paint a prefetched answer at once (its freshness label says how old) while
      // the fresh one is fetched; the read right after joins that fetch.
      const key = `${st.underlying}|${st.expiry}`;
      const first = key !== loadedKey;
      const [r] = await Promise.all([api(chainPath(st.expiry), { paintOld: first }), loadQuotes()]);
      if (seq !== st.seq) return;
      st.chain = r.data.data;
      st.freshness = r.data.data?.freshness ?? r.data.meta?.freshness ?? null;
      st.ms = Math.round(performance.now() - t0);
      st.error = null;
      st.lastOk = new Date().toISOString();
      syncLive();
      if (store && st.chain) store.offer(st.chain, Date.now(), { demo: Boolean(app.state.demo), session: refSession(st.ref), isTradingDay: refCalendar(st.ref).isTradingDay }).catch(() => {});
      if (r.cached === "paint") setTimeout(() => seq === st.seq && loadChain({ draw }), 0);
      if (first) {
        loadedKey = key;
        prefetchNextExpiry();
      }
    } catch (err) {
      if (seq !== st.seq) return;
      st.error = err;
    }
    if (draw) drawAll();
  }
  // ── Live ticks (live.js): between refreshes the legs on screen, the index and its futures stream in over the one
  // shared connection. The Bridge then builds this page's chain reads from the same ticks (no broker call), so the
  // refresh below costs the broker nothing while the stream is up. The chain and the Strategy Builder redraw on each
  // frame that brought ticks, OI Analysis patches its ladder and tiles (its panels every 2 s). Greeks stay from the
  // last refresh (a few seconds).
  const LIVE_KINDS = new Set(["chain", "strategy", "oi"]);
  // The chain patches only the cells a tick changed, so it takes every frame. OI Analysis patches its ladder and tiles
  // (a few ms) and takes ticks every OI_GAP_MS: with the default 150 ms, a tick that came just after a delivery
  // waited for the next one (its 200 ms tick-to-cell outliers). The builder redraws a whole view and keeps the default.
  const feed = LIVE_KINDS.has(kind) ? watch([], "quote", (ticks) => applyTicks(ticks), kind === "chain" ? { minGapMs: 0 } : kind === "oi" ? { minGapMs: OI_GAP_MS } : undefined) : null;
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
    let futMoved = false;
    /** strike -> sides whose leg ticked (the chain patches only these cells) */
    const touched = new Map();
    const pricing = st.chain.pricing ?? null;
    for (const [sym, t] of ticks) {
      if (Number.isFinite(t.receivedAt)) newest = Math.max(newest, t.receivedAt);
      const at = legIndex.get(sym);
      if (at) {
        rows ??= st.chain.rows.slice();
        const [i, side] = at;
        const row = rows[i] === st.chain.rows[i] ? { ...rows[i] } : rows[i];
        const leg = row[side];
        if (!leg) continue;
        let next = { ...leg };
        if (isFigure(t.ltp)) next.ltp = t.ltp;
        delete next.tickAgeMs; // it just ticked: no longer a quiet leg
        if (isFigure(t.bid)) next.bid = t.bid;
        if (isFigure(t.ask)) next.ask = t.ask;
        if (isFigure(t.volume)) next.volume = t.volume;
        if (isFigure(t.change)) next.change = t.change;
        // Depth sizes and the day's range, when the stream carries them (the Customise columns that show them).
        for (const f of ["bidQty", "askQty", "high", "low"]) if (isFigure(t[f])) next[f] = t[f];
        if (isFigure(t.oi) && sameUnit(t.oi, leg.oi)) {
          if (isFigure(leg.oiChange)) next.oiChange = leg.oiChange + (t.oi - leg.oi);
          next.oi = t.oi;
        }
        // IV and Greeks follow the new mid (Black-76 on the last refresh's forward and clock), for this leg only.
        if (next.bid !== leg.bid || next.ask !== leg.ask || next.ltp !== leg.ltp) next = O.repriceLeg(next, row.strike, side === "ce" ? "CE" : "PE", pricing);
        row[side] = next;
        rows[i] = row;
        if (!touched.has(row.strike)) touched.set(row.strike, new Set());
        touched.get(row.strike).add(side);
        continue;
      }
      const isIndex = sym === INDEX_SYMBOL[st.underlying];
      if (isIndex || st.futures.some((f) => f.symbol === sym)) {
        const q = st.quotes.get(sym) ?? { symbol: sym };
        st.quotes.set(sym, { ...q, ltp: t.ltp ?? q.ltp, change: t.change ?? q.change, changePct: t.changePct ?? q.changePct, bid: t.bid ?? q.bid, ask: t.ask ?? q.ask, oi: t.oi ?? q.oi, volume: t.volume ?? q.volume });
        if (isIndex && isFigure(t.ltp)) rows ??= st.chain.rows.slice();
        else if (!isIndex) futMoved = true;
      }
    }
    if (!rows) return;
    const idxTick = ticks.get(INDEX_SYMBOL[st.underlying]);
    const prevSpot = num(st.chain.underlyingLtp);
    st.chain = { ...st.chain, rows, ...(idxTick && isFigure(idxTick.ltp) ? { underlyingLtp: idxTick.ltp } : {}) };
    if (newest) st.freshness = { ...(st.freshness ?? {}), asOf: new Date(newest).toISOString(), ageMs: 0, stale: false, source: "stream" };
    st.lastOk = new Date().toISOString();
    // The chain patches the cells that changed on this frame (a full redraw only when the table's structure moves);
    // the builder redraws on this frame; OI Analysis its ladder and tiles.
    if (kind === "chain") return patchLive(touched, prevSpot, futMoved) || drawAll();
    if (kind !== "oi") return drawAll();
    // OI Analysis: the ladder rows and the tiles follow on this frame (each cell writes only what changed); the panels
    // under them at most every 2 s, in a task of their own (oi.js draw `live`).
    oiLive = true;
    try {
      drawAll();
    } finally {
      oiLive = false;
    }
  }
  let oiLive = false;
  /**
   * The chain's live-tick path: the legs that ticked get their cells patched (text nodes and classes only, their IV
   * and Greeks repriced above, the parity cells of their strikes redone), the spot divider and the top bar follow the
   * index. Chain-wide figures (totals, PCR, max pain, bar scales, tags) wait for the next refresh (3 s). False when
   * the table's structure would change (ATM moved, the index crossed a strike, a snapshot OI window, a parity column
   * on a futures tick, nothing built yet): the caller then draws in full.
   */
  function patchLive(touched, prevSpot, futMoved) {
    const x0 = lastX;
    if (!x0 || x0.windowed || x0.c.underlying !== st.chain.underlying || x0.c.expiry !== st.chain.expiry) return false;
    const spot = num(st.chain.underlyingLtp);
    const spotMoved = spot !== null && spot !== prevSpot;
    if (spotMoved) {
      const lo = Math.min(spot, prevSpot ?? spot);
      const hi = Math.max(spot, prevSpot ?? spot);
      let atm = null;
      for (const r of st.chain.rows) {
        if (prevSpot !== null && r.strike > lo && r.strike <= hi) return false; // an ITM boundary moved
        if (atm === null || Math.abs(r.strike - spot) < Math.abs(atm - spot)) atm = r.strike;
      }
      if (atm !== x0.sm.atm) return false;
    }
    const same = futMoved ? st.futures.find((f) => f.expiry === st.chain.expiry) : null;
    if (same && x0.syn.size && chain.hasParity()) return false; // Dev and Edge read the future: draw them all
    const t0 = performance.now();
    const sameQ = same ? st.quotes.get(same.symbol) : null;
    const x = {
      ...x0,
      c: st.chain,
      ...(spotMoved ? { spot, sm: { ...x0.sm, spot } } : {}),
      indexQuote: st.quotes.get(INDEX_SYMBOL[st.chain.underlying] ?? "") ?? x0.indexQuote,
      ...(sameQ && num(sameQ.ltp) !== null ? { sameFut: { expiry: same.expiry, ltp: sameQ.ltp } } : {}),
    };
    if (!chain.patchLegs(x, touched, { spot: spotMoved || Boolean(sameQ) })) return false;
    lastX = x;
    st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
    if (spotMoved || sameQ) drawCtx();
    sheet?.update();
    drawClock();
    return true;
  }

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
  /** The OI-change windows' readiness at the last draw ({ avail, eff }), for Customise. */
  let winState = null;
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
    const eff = ref ? want : "day";
    // Customise → View → OI change shows the window in use; one not ready yet is disabled and says why.
    winState = { avail, eff };
    custom?.syncWin();
    return { win: eff, ref, label: ref ? WIN_LABEL[eff] : null, snaps, now };
  }

  // ── Derived context for one draw ──
  function context() {
    const w = chainWindow();
    const c = w?.ref ? O.withOiWindow(st.chain, w.ref.snap) : st.chain;
    const sm = O.chainSummary(c);
    const ses = refSession(st.ref);
    const years = O.yearsToExpiry(c.expiry, Date.now(), ses.close);
    const tcal = O.calendarYearsToExpiry(c.expiry, Date.now(), ses.close);
    const growth = O.parityGrowth(tcal, refRate(st.ref).value);
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
      // The Volume bar's scale: the largest of today's and the previous session's volume (both sides).
      maxVolAll: c.rows.reduce((m, r) => Math.max(m, num(r.ce?.volume) ?? 0, num(r.pe?.volume) ?? 0, num(r.ce?.prevVolume) ?? 0, num(r.pe?.prevVolume) ?? 0), 0),
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
      sameFutChange: same ? num(sameQ?.change) : null,
      indexQuote: st.quotes.get(INDEX_SYMBOL[c.underlying] ?? "") ?? null,
      netDelta,
      hedgeOwn: own,
      winLabel: w?.label ?? null,
      // What the live-tick path (patchLive) needs to redo the parity cells of one strike, and whether the rows are a
      // window over stored snapshots (then a tick is drawn in full).
      growth,
      edgeRef,
      windowed: Boolean(w?.ref),
      // Build-up over the window reads the price change over the same window.
      winQ: w?.ref ? (q) => q && { ltp: q.ltp, oi: q.oi, change: q.winChange, oiChange: q.oiChange, close: null } : (q) => q,
      // The build-up rule's floors: the day's, or the 15 min ones over a recorded window.
      buWin: w?.ref ? "15" : "day",
      // Rho, Theoretical price and the annualised yields: calendar years to expiry (interest) and the discount factor.
      tcal,
      df: growth > 0 ? 1 / growth : 1,
      // 5 / 15 min build-up: the baseline snapshots, found once per refresh (only while a column needs them).
      ...minuteRefs(w, c.rows),
      // The build-up meter's scale: the largest |OI change| on each side (each window has its own).
      maxChg: { ce: c.rows.reduce((m, r) => Math.max(m, Math.abs(num(r.ce?.oiChange) ?? 0)), 0), pe: c.rows.reduce((m, r) => Math.max(m, Math.abs(num(r.pe?.oiChange) ?? 0)), 0) },
    };
  }
  /** The 5 / 15 min build-up baselines (chain-metrics.js windowRef). "Now" is this device's clock while the session is
   *  live (or the demo runs); otherwise the last snapshot recorded, so the windows read the last minutes of trading. */
  function minuteRefs(w, rows) {
    const want5 = st.cfg.cols.includes("bu5");
    const want15 = st.cfg.cols.includes("bu15");
    if (!w || (!want5 && !want15)) return { bu5: null, bu15: null };
    const snaps = w.snaps ?? [];
    const live = Boolean(app.state.demo) || (O.marketSession(w.now, refSession(st.ref), { isTradingDay: refCalendar(st.ref).isTradingDay }).phase === "open" && !st.freshness?.stale);
    const now = live ? w.now : snaps.reduce((m, s) => (Number.isFinite(s?.t) ? Math.max(m, s.t) : m), -Infinity);
    // Each window's meter scale: the largest |OI change| over that window on each side, once per refresh.
    const withMax = (ref) => {
      if (ref.state !== "ok") return ref;
      const max = { ce: 0, pe: 0 };
      for (const r of rows) for (const side of ["ce", "pe"]) {
        const rd = M.windowBuildup(r[side], ref, r.strike, side);
        if (rd.state === "ok") max[side] = Math.max(max[side], Math.abs(rd.dOi));
      }
      return { ...ref, max };
    };
    return { bu5: want5 ? withMax(M.windowRef(snaps, now, "5", { live })) : null, bu15: want15 ? withMax(M.windowRef(snaps, now, "15", { live })) : null };
  }

  let lastX = null;
  /** The open order ticket's close, so leaving the page closes it (it would sit over the next page otherwise). */
  let ticketCloser = null;
  let enteredKey = null;
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
          const row = ticketIntent ? x.c.rows.find((r) => r.strike === ticketIntent.strike) : null;
          if (row) {
            const t = ticketIntent;
            ticketIntent = null;
            setTimeout(() => openTicket({ row, right: t.right, side: t.side, qty: t.lots * (num(x.lot) || num(x.c.lotSize) || 1) }), 0);
          }
        }
        if (ticketIntent) {
          toast(`${ticketIntent.strike} is not listed in this chain`, { tone: "warn" });
          ticketIntent = null;
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
      oiPage.draw(x, { live: oiLive });
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

  // ── The chain ──
  const effSideKey = () => (device().phone ? "phoneSide" : "side");
  // "+N hidden": the columns the fit engine left out at this width; a click opens Customise.
  const hiddenChip = h("button", { type: "button", class: "small hidden-chip", hidden: true, onclick: () => openCustomise() });
  // The chain's tools (stale pill, +N hidden, Select, Customise) sit in the CALLS / PUTS header row of the table; on a
  // phone (no such row) in the head row above it, beside Calls | Puts | Both. createChain places them on each build.
  // The chain's tools as one row of capsules (stale pill, +N hidden, Select, Customise, Simple | Advanced): in the app
  // toolbar beside the page's capsule, or on a phone in the head row above the table beside Calls | Puts | Both.
  // createChain places them on each build. Select and Customise are icons; their names are their labels and titles.
  const chainTools = h("div", { class: "chain-tools icons" }, stalePill, hiddenChip, selectBtn, gearBtn, kind === "chain" ? modeSeg : null);
  const toolSlot = h("div", { class: "ctx-tools" });
  const headRow = h("div", { class: "chain-head panel-head" });
  /** The data's own date (IST) when there is one, else today: days to expiry count from it, not from this clock. */
  const dataDay = () => istDay(st.freshness?.asOf ?? null);
  // The toolbar's expiry names its days-to-expiry tone (plain from 3 days, amber at 1-2, red on expiry day) and, on the
  // chain with a mouse or the keyboard, opens the list of expiries (Monthly, Moved, days to expiry); touch keeps the
  // native list. [ and ] step through them.
  function drawExpiryCap() {
    const e = st.expiry;
    const n = e ? dteOf(e, dataDay()) : null;
    const tone = dteTone(n);
    if ((eItem.dataset.dte ?? "") !== tone) {
      if (tone) eItem.dataset.dte = tone;
      else delete eItem.dataset.dte;
    }
  }
  if (kind === "chain") {
    eItem.setAttribute("data-search", "");
    eItem.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !media("(pointer: fine)").matches || eSel.disabled) return;
      e.preventDefault();
      openExpiryList();
    }, true);
    eSel.addEventListener("keydown", (e) => {
      if (!media("(pointer: fine)").matches || !(e.key === "Enter" || e.key === " " || (e.key === "ArrowDown" && e.altKey) || e.key === "F4")) return;
      e.preventDefault();
      openExpiryList();
    });
  }
  function openExpiryList() {
    const ex = st.expiries;
    if (!ex.length) return;
    const futs = st.futures.length ? new Set(st.futures.map((f) => f.expiry)) : null;
    const day = dataDay();
    const shifted = new Map((st.ref?.expiries ?? []).filter((x) => x?.shifted).map((x) => [x.date, x]));
    let pop = null;
    const items = ex.map((e) => {
      const n = dteOf(e, day);
      const monthly = futs ? futs.has(e) : O.isMonthlyExpiry(e, ex);
      const moved = shifted.get(e);
      return h(
        "button",
        { type: "button", class: "menu-item exp-item", role: "option", "aria-selected": String(e === st.expiry), onclick: () => (pop?.close(), selectExpiry(e)) },
        h("span", { class: "exp-tick", "aria-hidden": "true" }, e === st.expiry ? icon("check") : null),
        h("span", { class: "exp-d" }, expiryText(e), h("small", {}, WEEKDAY.format(new Date(`${e}T00:00:00Z`)))),
        monthly ? h("span", { class: "exp-tag" }, "Monthly") : null,
        moved ? h("span", { class: "exp-tag moved", title: moved.ruleDate ? `Moved from ${expiryText(moved.ruleDate)} (a holiday)` : "Moved for a holiday" }, "Moved") : null,
        h("span", { class: `dte${dteTone(n) ? ` ${dteTone(n)}` : ""}` }, n === 0 ? "TODAY" : `${formatInt(n)} DTE`),
      );
    });
    pop = sheetPopover({ trigger: eItem, title: `${st.underlying} expiries`, body: h("div", { class: "menu-list stack exp-list", role: "listbox", "aria-label": "Expiry" }, items), cls: "menu-pop exp-pop" });
  }
  const chain = createChain({
    st,
    host: chainEl,
    tools: chainTools,
    toolSlot,
    headRow,
    onToolsPlaced: () => queueMicrotask(fitHead),
    // Picking a side (the header buttons, C / V, the phone switch) leaves the straddle table.
    onSide: (side) => setCfg({ side, straddle: false }),
    onPhoneSide: (side) => setCfg({ phoneSide: side, straddle: false }),
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
    onStrikeMenu: (strike, anchor) => strategyMenu(strike, anchor),
    // null on the last listed expiry: the empty state then shows no button that would do nothing.
    onNextExpiry: () => {
      const i = st.expiries.indexOf(st.expiry);
      if (i < 0 || i + 1 >= st.expiries.length) return null;
      return () => selectExpiry(st.expiries[i + 1]);
    },
  });
  // Insight cards on the chain's cells and headers, and the "How to read the chain" sheet (chain-insight.js).
  if (kind === "chain") installChainInsight(chainEl, { x: () => chain.x, cfg: () => st.cfg, keys: keysEl });
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
  /** The key legend shows only on a panel of 900 px or more, and drops trailing keys that do not fit. */
  function fitHead() {
    const t = chainTools;
    if (!t.isConnected) return;
    const narrow = chainEl.clientWidth < 900;
    if (keysEl.classList.contains("narrow") !== narrow) keysEl.classList.toggle("narrow", narrow);
    if (!narrow) {
      for (const p of keysEl.children) p.hidden = false;
      for (let i = keysEl.children.length - 1; i > 0 && keysEl.scrollWidth > keysEl.clientWidth + 1; i -= 1) keysEl.children[i].hidden = true;
    }
  }
  const headRo = typeof ResizeObserver === "function" ? new ResizeObserver(() => fitHead()) : null;
  const COL_NAME = (k) => (k === "quotes" ? "Bid / Ask" : CHAIN_COLUMNS.find((c) => c[0] === k)?.[1] ?? k);
  function drawHidden(f) {
    const n = f.hidden.length;
    if (hiddenChip.hidden !== !n) queueMicrotask(fitHead);
    hiddenChip.hidden = !n;
    const t = `+${formatInt(n)} hidden`;
    if (hiddenChip.textContent !== t) hiddenChip.textContent = t;
    hiddenChip.title = n ? `Hidden at this width: ${f.hidden.map(COL_NAME).join(", ")}. Customise to choose` : "";
  }
  /** A focused strike outside the window: show every strike for now (the saved choice stays). */
  function showAllStrikes() {
    if (st.strikesView === "all") return;
    st.strikesView = "all";
    custom?.redraw("strikes");
    if (st.chain) drawAll();
  }
  /** Customise → Strikes: the stepper's choice is the window, and it is kept. */
  function setStrikes(v) {
    st.strikes = strikesPref(v);
    st.strikesView = st.strikes;
    save();
    if (st.chain) drawAll();
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

  /**
   * Right-click (or long-press the strike, or T): build a strategy around this strike. The legs replace the
   * underlying's draft in the Strategy Builder, which opens with the payoff and an Undo for the old draft.
   */
  function strategyMenu(strike, anchor) {
    const x = lastX;
    if (!x) return;
    const back = O.backExpiry(st.expiries ?? [], x.c.expiry);
    let handle = null;
    const legText = (ls) => ls.map((l) => `${l.side === "SELL" ? "Sell" : "Buy"}${l.lots > 1 ? ` ${formatInt(l.lots)}×` : ""} ${formatInt(l.strike)} ${l.right}${l.expiry && l.expiry !== x.c.expiry ? " next" : ""}`).join(" · ");
    const items = O.AROUND_STRIKE.map(([id, label, what]) => {
      const legs = O.aroundStrikeLegs(id, x.c, strike, { move: x.move, back });
      return h("button", { type: "button", class: "menu-item", disabled: !legs.length, title: what, onclick: () => (handle?.close(), buildAround(label, strike, legs)) }, label, h("small", {}, legs.length ? legText(legs) : id === "call-calendar" ? "No later expiry is listed" : what));
    });
    handle = sheetPopover({ trigger: anchor, title: `Build around ${formatInt(strike)}`, body: h("div", { class: "menu-list stack" }, items), cls: "menu-pop strike-menu" });
  }
  function buildAround(label, strike, legs) {
    const x = lastX;
    if (!x || !legs.length) return;
    const u = st.underlying;
    const prev = structuredClone(basket());
    st.baskets[u] = legs.map((l) => ({ right: l.right, strike: l.strike, side: l.side, lots: l.lots, expiry: l.expiry ?? x.c.expiry }));
    save();
    local.set(FROM_CHAIN_SLOT, JSON.stringify({ u, label: `${label} at ${formatInt(strike)}`, prev }));
    location.hash = "#/strategy";
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
    sideSeg.classList.add("side-seg");
    const lots = inUnits
      ? h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(start ?? lotSize) })
      : h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(start ? Math.max(1, Math.round(start / lotSize)) : 1) });
    const lotHint = h("span", { class: "hint" });
    const typeSeg = segmented("Order type", [["LIMIT", "Limit"], ["MARKET", "Market"], ["SL", "SL"], ["SL-M", "SL-M"]], ["MARKET", "SL", "SL-M"].includes(orderType) ? orderType : "LIMIT");
    // Stop-loss orders (SL: a limit once triggered; SL-M: market once triggered) rest at the exchange (paper: the
    // paper engine) until LTP reaches the trigger. Not a Bridge trigger: the broker holds them.
    typeSeg.classList.add("bk-type-seg");
    const isStop = () => typeSeg.value === "SL" || typeSeg.value === "SL-M";
    const slTrig = h("input", { id: "bk-sl-trig", type: "number", min: "0.05", step: String(tick), inputmode: "decimal" });
    const slField = h("label", { class: "field bk-sl", for: "bk-sl-trig", hidden: true }, h("span", {}, "Trigger price"), slTrig);
    const slHint = h("p", { class: "hint bk-trig-hint", "aria-live": "polite", hidden: true });
    // When: now, or at a price (a GTT the Bridge holds and sends through every check when LTP reaches the trigger).
    // After the close (and before 09:15) a third choice: an after-market order the Bridge sends at the next open.
    const closedNow = marketClosedAt(Date.now(), refSession(st.ref), refCalendar(st.ref).isTradingDay);
    const whenSeg = exit ? null : segmented("When", [["now", "Now"], ["gtt", "At a price"], ...(closedNow ? [["amo", "At the open"]] : [])], closedNow ? "amo" : "now");
    const gtt = () => whenSeg?.value === "gtt";
    const amo = () => whenSeg?.value === "amo";
    /** Sent later (a GTT or an AMO): today's refusals are said as what would happen then. */
    const later = () => gtt() || amo();
    const trig = h("input", { type: "number", min: "0.05", step: String(tick), inputmode: "decimal", "aria-describedby": "bk-trig-hint" });
    const trigHint = h("p", { class: "hint bk-trig-hint", id: "bk-trig-hint", "aria-live": "polite", hidden: true });
    const trigField = h("label", { class: "field bk-trig", hidden: true }, h("span", {}, "Trigger price"), trig);
    // Stop and target on the entry (bracket-style): set on the Bridge when the order is placed; they arm when it
    // fills, with the filled quantity, and the first to touch exits (the other is gone). Reduce-only.
    const exitInput = (label) => h("input", { type: "number", min: "0.05", step: String(tick), inputmode: "decimal", "aria-label": label });
    const stopIn = exitInput("Stop price");
    const targetIn = exitInput("Target price");
    const trailIn = h("input", { type: "number", min: "0", step: String(tick), inputmode: "decimal", "aria-label": "Trail the stop by, points", placeholder: "Off" });
    const exitsHint = h("p", { class: "hint bk-exits-hint", "aria-live": "polite" });
    const exitsBox = exit
      ? null
      : h(
          "details",
          { class: "bk-exits" },
          h("summary", {}, h("span", {}, "Stop and target"), h("span", { class: "muted small bk-exits-sum" }, "Optional. Exits on the Bridge after a fill")),
          h(
            "div",
            { class: "bk-exits-grid" },
            h("label", { class: "field" }, h("span", {}, "Stop"), stopIn),
            h("label", { class: "field" }, h("span", {}, "Target"), targetIn),
            h("label", { class: "field" }, h("span", {}, "Trail stop by"), trailIn),
          ),
          exitsHint,
        );
    const exitsWanted = () => !exit && (isFigure(stopIn.value) || isFigure(targetIn.value));
    const whenRow = whenSeg ? h("div", { class: "ticket-grid bk-when" }, segField("When", whenSeg), trigField) : null;
    const midPx = (sd) => O.roundToTick(O.mid(quote()), tick, sd === "BUY" ? "buy" : "sell");
    const startPx = isFigure(priceIn) ? Number(priceIn) : exit ? midPx(side) ?? O.touchPrice(quote(), side, tick) : O.touchPrice(quote(), side, tick);
    const price = h("input", { type: "number", min: "0.05", step: String(tick), inputmode: "decimal", value: String(startPx ?? "") });
    const prodSeg = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Margin (NRML)"]], O.ticketProduct(product));
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand this sends a real order to ${a.label}.`);
    const quoteLine = h("div", { class: "ticket-quote" });
    // A refusal from the Bridge, in its own words, then the next step (reasons-core.js) when there is one.
    const refusalNodes = (err) => {
      const fix = whatToDo({ code: err?.code, message: err?.message ?? err?.detail, mode: live() ? "live" : "paper" });
      return [alertBox(err), ...(fix ? [h("p", { class: "bk-fix" }, h("strong", {}, "What to do: "), fix)] : [])];
    };
    // Market depth (GET /v1/depth): read every 2 s only while it is open and the tab is in view, so a closed panel or a
    // hidden tab costs no broker calls.
    // Five levels a side; twenty where the source sends them. A tap on a price makes it the limit.
    const depthSum = h("span", { class: "muted small bk-depth-sum" });
    const depthBody = h("div", { class: "bk-depth-body" });
    const depthBox = h("details", { class: "bk-depth" }, h("summary", {}, h("span", {}, "Market depth"), depthSum), depthBody);
    let depthTimer = null;
    let depthMax = 5;
    let depthLast = null;
    const pickPrice = (px) => {
      if (typeSeg.value !== "LIMIT" && typeSeg.value !== "SL") typeSeg.value = "LIMIT";
      price.value = String(px);
      priceTyped = true;
      changed();
    };
    function drawDepth() {
      const r = depthLast;
      if (!r) return;
      if (r.error) {
        depthSum.textContent = "";
        return depthBody.replaceChildren(h("p", { class: "muted small" }, `Depth is not available: ${r.error.message ?? "the source sent none"}.`));
      }
      const v = depthView(r.data?.data, depthMax);
      depthSum.textContent = `Bid ${formatInt(v.totalBid)} · Ask ${formatInt(v.totalAsk)}`;
      const bar = (qty, cls) => {
        const el = h("span", { class: `bk-depth-bar ${cls}`, "aria-hidden": "true" });
        el.style.setProperty("--w", v.maxQty ? String(Number(qty) / v.maxQty) : "0");
        return el;
      };
      const cell = (l, side) =>
        l
          ? h(
              "button",
              { type: "button", class: `bk-depth-lvl ${side}`, title: `Use ${formatFixed(l.price, 2)} as the limit price` },
              bar(l.qty, side),
              side === "bid" ? h("span", { class: "bk-depth-o" }, l.orders === null || l.orders === undefined ? DASH : formatInt(l.orders)) : null,
              side === "bid" ? h("span", { class: "bk-depth-q" }, formatInt(l.qty)) : null,
              h("span", { class: "bk-depth-p" }, formatFixed(l.price, 2)),
              side === "ask" ? h("span", { class: "bk-depth-q" }, formatInt(l.qty)) : null,
              side === "ask" ? h("span", { class: "bk-depth-o" }, l.orders === null || l.orders === undefined ? DASH : formatInt(l.orders)) : null,
            )
          : h("span", { class: `bk-depth-lvl empty ${side}` }, DASH);
      const rows = v.rows.map((row) => {
        const b = cell(row.bid, "bid");
        const s = cell(row.ask, "ask");
        if (row.bid) b.addEventListener("click", () => pickPrice(row.bid.price));
        if (row.ask) s.addEventListener("click", () => pickPrice(row.ask.price));
        return h("div", { class: "bk-depth-row" }, b, s);
      });
      const share = h("span", { class: "bk-depth-share", "aria-hidden": "true" });
      share.style.setProperty("--w", v.bidShare === null ? "0.5" : String(v.bidShare));
      depthBody.replaceChildren(
        h("div", { class: "bk-depth-row bk-depth-headrow", "aria-hidden": "true" }, h("span", {}, h("span", {}, "Orders"), h("span", {}, "Qty"), h("span", {}, "Bid")), h("span", {}, h("span", {}, "Ask"), h("span", {}, "Qty"), h("span", {}, "Orders"))),
        ...rows,
        h("div", { class: "bk-depth-foot" }, h("span", {}, `Total bid ${formatInt(v.totalBid)}`), share, h("span", {}, `Total ask ${formatInt(v.totalAsk)}`)),
        v.available > 5
          ? h("button", { type: "button", class: "small plain", onclick: () => ((depthMax = depthMax === 5 ? 20 : 5), drawDepth()) }, depthMax === 5 ? `Show ${formatInt(Math.min(20, v.available))} levels` : "Show 5 levels")
          : h("p", { class: "muted small" }, "Five levels a side from the source. Twenty-level depth shows here when the broker sends it."),
      );
    }
    async function loadDepth() {
      const r = await optional(api(`/v1/depth?symbol=${encodeURIComponent(sym)}`));
      if (!depthBox.isConnected) return;
      depthLast = r;
      drawDepth();
      drawQuote();
    }
    depthBox.addEventListener("toggle", () => {
      clearInterval(depthTimer);
      depthTimer = null;
      if (depthBox.open) {
        loadDepth();
        depthTimer = setInterval(() => (depthBox.isConnected && depthBox.open ? document.hidden || loadDepth() : clearInterval(depthTimer)), 2000);
      }
    });
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
      priceTyped = true;
      changed();
    };
    const priceField = h(
      "div",
      { class: "field" },
      h("span", {}, "Limit price"),
      h("div", { class: "price-row" }, price, h("div", { class: "join rect touch-btns", role: "group", "aria-label": "Use a quote" }, [["Bid", "bid"], ["Mid", "mid"], ["Ask", "ask"]].map(([l, k]) => h("button", { type: "button", class: "small", onclick: () => (k === "mid" ? ((price.value = String(midPx(sideSeg.value) ?? "")), (priceTyped = true), changed()) : touch(k)) }, l)))),
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
      if ((typeSeg.value === "LIMIT" || typeSeg.value === "SL") && isFigure(price.value)) b.price = Number(price.value);
      if (isStop() && isFigure(slTrig.value)) b.triggerPrice = Number(slTrig.value);
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
      // A disabled button says why on hover and to screen readers (the reason may be below the fold).
      const firstBlock = blocked && !later() ? (last.checks.find((x) => x?.severity === "block")?.message ?? null) : null;
      placeBtn.title = firstBlock ?? "";
      if (firstBlock) placeBtn.setAttribute("aria-description", firstBlock);
      else placeBtn.removeAttribute("aria-description");
      const size = `${b.side === "BUY" ? "Buy" : "Sell"} ${inUnits ? `${formatInt(b.quantity)} qty` : `${formatInt(b.lots)} lot${b.lots === 1 ? "" : "s"}`}`;
      // On a phone the footer has room for "Set GTT" only (the side is the button's colour, the size is above).
      const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 719px)").matches;
      placeBtn.textContent = `${gtt() ? (narrow ? "Set GTT" : `Set GTT: ${size}`) : amo() ? (narrow ? "Queue AMO" : `Queue AMO: ${size}`) : size}${live() ? " · LIVE" : ""}`;
      placeBtn.className = b.side === "BUY" ? "btn buy" : "btn sell";
      // Refused by a check: the standard disabled button, saying so (the reason is its title and in the preview).
      if (firstBlock) {
        placeBtn.textContent = "Blocked";
        placeBtn.className = "btn";
      }
      // A GTT is checked again when it fires: a price band against today's price does not stop setting it.
      const gttBad = gtt() && (!isFigure(trig.value) || Number(trig.value) <= 0);
      const slBad = isStop() && Boolean(stopOrderProblem({ side: b.side, orderType: b.orderType, trigger: b.triggerPrice, price: b.price, ltp: num(quote()?.ltp) }));
      placeBtn.disabled = (!later() && blocked) || gttBad || slBad || !gateOk() || (live() && !ack.checked) || ((typeSeg.value === "LIMIT" || typeSeg.value === "SL") && !isFigure(price.value));
    };
    const drawQuote = () => {
      const q = quote();
      // While the depth panel is open, the strip's bid and ask are its top of book (one snapshot, so they agree);
      // otherwise the chain's quote.
      const top = depthBox.open && !depthLast?.error ? depthLast?.data?.data : null;
      const bid = num(top?.bids?.[0]?.price) ?? q?.bid;
      const ask = num(top?.asks?.[0]?.price) ?? q?.ask;
      const cell = (l, v, cls) => h("span", { class: cls }, h("small", {}, l), isFigure(v) ? formatFixed(v, 2) : DASH);
      quoteLine.replaceChildren(cell("Bid", bid, "bid"), cell("LTP", q?.ltp), cell("Ask", ask, "ask"), h("span", {}, h("small", {}, "IV"), fut ? DASH : formatFixed(q?.iv, 1)), h("span", {}, h("small", {}, "Δ"), fut ? "1.00" : formatFixed(q?.delta, 2)));
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
      const slProblem = isStop() ? stopOrderProblem({ side: b.side, orderType: b.orderType, trigger: b.triggerPrice, price: b.price, ltp: num(quote()?.ltp) }) : null;
      if (slProblem) {
        last = null;
        previewEl.replaceChildren(h("p", { class: "muted small pad" }, slProblem.message));
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
        const checks = [...(amo() ? checksForLaterDay(r.checks) : (r.checks ?? []))].sort((x, y) => (x.severity === "block" ? -1 : 0) - (y.severity === "block" ? -1 : 0));
        // What this order risks before it is sent (an opening option order): max loss, breakeven at expiry and, for a
        // sell, the approximate margin. Before charges; the broker's own margin figure is final.
        const q0 = quote();
        // A GTT fills when it fires: at its limit, or about the trigger for a market order.
        const px = gtt() ? gttFillPrice({ orderType: b.orderType, price: b.price, trigger: num(trig.value) }) : isStop() ? gttFillPrice({ orderType: b.orderType === "SL" ? "LIMIT" : "MARKET", price: b.price, trigger: b.triggerPrice }) : b.price ?? (b.side === "BUY" ? num(q0?.ask) : num(q0?.bid)) ?? num(q0?.ltp);
        const risk = !fut && !exit && row ? ticketRisk({ side: b.side, right, strike: row.strike, price: px, qty: r.quantity }) : null;
        const fwd = num(st.chain?.underlyingLtp);
        // Margin: the same portfolio model as the paper engine, Strategy and Positions (span-margin.js).
        const u = st.chain?.underlying ?? st.underlying;
        const leg = { kind: fut ? "FUT" : "OPT", side: b.side, strike: fut ? null : row?.strike, right: fut ? null : right, expiry: ex, units: r.quantity, price: px, iv: fut ? null : num(quote()?.iv) };
        const mg = !exit && (b.side === "SELL" || fut) && fwd && isFigure(px) ? portfolioMargin(marginLegsOf([leg], { underlying: u }), { nowMs: Date.now(), forwards: { [u]: fwd } }) : null;
        // The paper engine's own figure counts what the account holds (a hedge adds little or nothing).
        const withBook = num(r.margin?.required);
        // Charges: open at this price, square off at the same price (brokerage, STT, exchange, SEBI, stamp, GST).
        const rates = refCharges(st.ref);
        const chLeg = (sd) => ({ kind: fut ? "FUT" : "OPT", side: sd, price: px, lots: 1, lotSize: r.quantity, strike: row?.strike, right, symbol: sym });
        const entryCh = isFigure(px) && r.quantity > 0 ? O.charges([chLeg(b.side)], rates, { lotSize: r.quantity }).total : null;
        const exitCh = isFigure(entryCh) ? O.charges([chLeg(b.side === "BUY" ? "SELL" : "BUY")], rates, { lotSize: r.quantity }).total : null;
        const after = risk && isFigure(entryCh) ? riskAfterCharges(risk, { side: b.side, right, qty: r.quantity, entry: entryCh, exit: exitCh }) : null;
        const lossText = risk ? (risk.maxLoss === null ? "Unlimited" : formatRupee(risk.maxLoss, 0)) : null;
        // With a stop and target on the entry: the loss at the stop and the reward at the target, from the expected
        // fill; the full max loss stays on screen as what a gap through the stop can cost.
        const exitF = !later() && exitsWanted() && !triggerProblem(exitsFields()) ? exitsFields() : null;
        const atStop = exitF && isFigure(exitF.stop) && isFigure(px) ? Math.abs(px - exitF.stop) * r.quantity : null;
        const atTarget = exitF && isFigure(exitF.target) && isFigure(px) ? Math.abs(exitF.target - px) * r.quantity : null;
        const exitFigs =
          atStop !== null || atTarget !== null
            ? h(
                "div",
                { class: "ticket-figs bk-exit-figs" },
                atStop !== null && risk ? h("div", { title: "The most this order can lose at expiry if the price gaps through the stop" }, h("small", {}, "If it gaps"), h("span", { class: risk.maxLoss === null ? "down" : "" }, lossText)) : null,
                atTarget !== null ? h("div", { title: "What the target exits at, before charges" }, h("small", {}, "Reward at target"), h("span", { class: "up" }, formatRupee(atTarget, 0))) : null,
                atStop && atTarget !== null ? h("div", {}, h("small", {}, "Reward : risk"), `${formatFixed(atTarget / atStop, 1)} : 1`) : null,
              )
            : null;
        previewEl.replaceChildren(
          h(
            "div",
            { class: `ticket-figs${risk ? " with-risk" : ""}` },
            h("div", {}, h("small", {}, "Quantity"), `${formatInt(r.quantity)}`),
            h("div", {}, h("small", {}, b.side === "BUY" ? "You pay" : "You receive"), formatRupee(gtt() && isFigure(px) ? px * r.quantity : r.estimatedValue, 0)),
            risk && atStop === null ? h("div", { title: "The most this order can lose at expiry, before charges" }, h("small", {}, "Max loss"), h("span", { class: risk.maxLoss === null ? "down" : "" }, lossText)) : null,
            risk && atStop !== null ? h("div", { title: "What the stop exits at, before charges and slippage. A gap past the stop can cost more (below)." }, h("small", {}, "Max loss at stop"), formatRupee(atStop, 0)) : null,
            risk ? h("div", { title: "Where the underlying must settle at expiry for this order to break even, before charges" }, h("small", {}, "Breakeven"), formatFixed(risk.breakeven, 2)) : null,
            mg ? h("div", { title: SPAN_METHOD }, h("small", {}, "Margin ≈"), formatRupee(mg.required, 0)) : null,
            // Paper is said once (the account); only a live order gets a Mode figure, in red.
            r.mode === "live" ? h("div", {}, h("small", {}, "Mode"), h("span", { class: "down" }, "LIVE")) : null,
          ),
          ...(exitFigs ? [exitFigs] : []),
          isFigure(entryCh)
            ? h(
                "p",
                { class: "ticket-after", title: "Charges from the reference table: brokerage, STT, exchange and SEBI fees, stamp duty and GST. Round trip: open now, square off at the same price." },
                h("span", {}, "Charges ≈ ", h("strong", {}, formatRupee(entryCh + exitCh, 0)), " round trip"),
                after ? h("span", {}, "After charges: max loss ", h("strong", {}, after.maxLoss === null ? "Unlimited" : formatRupee(after.maxLoss, 0)), ", breakeven ", h("strong", {}, formatFixed(after.breakeven, 2))) : null,
                mg && isFigure(withBook) && Math.abs(withBook - mg.required) > Math.max(1, mg.required * 0.02) ? h("span", { title: "From the paper engine, with the positions this account already holds." }, "With your positions: adds ", h("strong", {}, formatRupee(Math.max(0, withBook), 0))) : null,
              )
            : null,
          // A GTT's order is checked against the market when it fires: today's refusals are said as "When it fires".
          ...(checks.length ? [h("ul", { class: "ticket-checks" }, checks.map((x) => h("li", { class: x.severity === "block" && !later() ? "bad" : "warn" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", {}, `${x.severity === "block" ? (later() ? `If this held when it ${amo() ? "goes at the open" : "fires"}, it would be refused: ` : "Blocked: ") : ""}${x.message}`, x.severity === "block" && whatToDo({ ...x, mode: live() ? "live" : "paper" }) ? h("span", { class: "bk-fix" }, `What to do: ${whatToDo({ ...x, mode: live() ? "live" : "paper" })}`) : null))))] : []),
        );
      } catch (err) {
        if (seq !== previewSeq) return;
        last = null;
        previewEl.replaceChildren(...refusalNodes(err));
      }
      drawButton();
    }
    // The entry price the stop and target are measured from: the limit, else the touch.
    const entryPx = () => (typeSeg.value === "LIMIT" && isFigure(price.value) ? Number(price.value) : num(sideSeg.value === "BUY" ? quote()?.ask : quote()?.bid) ?? num(quote()?.ltp));
    const exitSide = () => (sideSeg.value === "BUY" ? "SELL" : "BUY");
    function exitsFields() {
      return { account: a.id, symbol: sym, product: prodSeg.value, mode: live() ? "live" : "paper", side: exitSide(), units: units(), origin: "bracket", stop: isFigure(stopIn.value) ? Number(stopIn.value) : null, target: isFigure(targetIn.value) ? Number(targetIn.value) : null, trail: isFigure(trailIn.value) && Number(trailIn.value) > 0 ? Number(trailIn.value) : null, orderType: "MARKET", ref: entryPx() };
    }
    function exitsText() {
      if (!exitsWanted()) return "Exits at market when LTP touches the stop or the target; the first to touch cancels the other.";
      const f = exitsFields();
      const bad = triggerProblem(f);
      if (bad) return bad.message;
      const e = f.ref;
      const q = f.units;
      const long = sideSeg.value === "BUY";
      const parts = [];
      if (isFigure(f.stop) && isFigure(e)) parts.push(`risk ≈ ${formatRupee(Math.abs(e - f.stop) * q, 0)}`);
      if (isFigure(f.target) && isFigure(e)) parts.push(`reward ≈ ${formatRupee(Math.abs(f.target - e) * q, 0)}`);
      const rr = isFigure(f.stop) && isFigure(f.target) && isFigure(e) && Math.abs(e - f.stop) > 0 ? ` (1 : ${formatFixed(Math.abs(f.target - e) / Math.abs(e - f.stop), 1)})` : "";
      return `On fill: ${long ? "sell" : "buy"} at market when LTP ${isFigure(f.stop) ? `${long ? "≤" : "≥"} ${formatFixed(f.stop, 2)}` : ""}${isFigure(f.stop) && isFigure(f.target) ? " or " : ""}${isFigure(f.target) ? `${long ? "≥" : "≤"} ${formatFixed(f.target, 2)}` : ""}${f.trail ? `, the stop trailing by ${formatFixed(f.trail, 2)}` : ""}.${parts.length ? ` ${cap(parts.join(", "))}${rr}.` : ""}`;
    }
    const changed = () => {
      drawWarnings();
      const n = Math.max(1, Math.floor(Number(lots.value) || 1));
      lotHint.textContent = inUnits ? `odd quantity · lot ${formatInt(lotSize)}` : `${formatInt(n * lotSize)} qty`;
      for (const btn of pctBtns) btn.setAttribute("aria-pressed", String(sizeFor(Number(btn.dataset.pct)) === n && (Number(btn.dataset.pct) === 100 || sizeFor(100) !== n)));
      priceField.hidden = typeSeg.value !== "LIMIT" && typeSeg.value !== "SL";
      slField.hidden = !isStop();
      slHint.hidden = !isStop();
      if (isStop()) {
        // An SL's limit follows its trigger (plus 0.5 % for a buy, minus for a sell) until it is typed in.
        if (typeSeg.value === "SL" && !priceTyped) {
          const lp = gttLimit(Number(slTrig.value), sideSeg.value, tick);
          if (lp !== null) price.value = String(lp);
        }
        const f = { side: sideSeg.value, orderType: typeSeg.value, trigger: num(slTrig.value), price: num(price.value), ltp: num(quote()?.ltp) };
        const bad = stopOrderProblem(f);
        slHint.textContent = bad ? bad.message : stopOrderText(f);
        slHint.classList.toggle("bad-text", Boolean(bad));
      }
      // A stop-loss order is already conditional: the When row (a Bridge GTT) is for limit and market orders.
      if (whenRow) whenRow.hidden = isStop();
      trigField.hidden = !gtt();
      trigHint.hidden = !later();
      if (amo()) {
        // Held on this Bridge (no adapter queues a native AMO yet): it must be running at 09:15. Limit by default;
        // a market order takes the opening price and is not sent if the open gaps beyond the price band.
        const mkt = typeSeg.value === "MARKET";
        const open = refSession(st.ref).open;
        trigHint.textContent = `Goes at ${open} IST on the next trading day, through every check. Held on this Bridge: it must be running at ${open} IST.${mkt ? " A market order takes the opening price, which can gap far from today's close; it is not sent if the open is beyond your price band." : ""}`;
        trigHint.classList.toggle("bad-text", mkt);
      }
      if (exitsBox) {
        // GTT and AMO entries carry no exits here (set them on the position once it fills).
        exitsBox.hidden = later();
        exitsHint.textContent = exitsText();
      }
      if (gtt()) {
        const ltp = num(quote()?.ltp);
        const op = isFigure(trig.value) && ltp ? opFor(Number(trig.value), ltp) : null;
        // The limit follows the trigger (plus 0.5 % for a buy, minus for a sell) until it is typed in, so the order
        // fills when it fires; a typed limit on the wrong side of the trigger is warned about here.
        if (!priceTyped && typeSeg.value === "LIMIT") {
          const lp = gttLimit(Number(trig.value), sideSeg.value, tick);
          if (lp !== null) price.value = String(lp);
        }
        const warn = typeSeg.value === "LIMIT" ? gttLimitWarning(sideSeg.value, Number(trig.value), Number(price.value)) : null;
        const sends = op ? `Sends when LTP ${op === "above" ? "rises to" : "falls to"} ${formatFixed(Number(trig.value), 2)} (now ${formatFixed(ltp, 2)}). ${gttValidityText(prodSeg.value)}` : ltp ? `LTP now ${formatFixed(ltp, 2)}` : "";
        trigHint.textContent = warn ? `${sends} ${warn}` : sends;
        trigHint.classList.toggle("bad-text", Boolean(warn));
      }
      ackRow.hidden = !live();
      drawButton();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(preview, 200);
    };
    sideSeg.addEventListener("change", () => {
      const p = exit ? midPx(sideSeg.value) ?? O.touchPrice(quote(), sideSeg.value, tick) : O.touchPrice(quote(), sideSeg.value, tick);
      if (p !== null) price.value = String(p);
      if (gtt() || isStop()) priceTyped = false;
      if (isStop()) {
        const s = slTriggerStart(sideSeg.value, num(quote()?.ltp), tick);
        if (s !== null) slTrig.value = String(s);
      }
      changed();
    });
    for (const el of [prodSeg, modeSeg].filter(Boolean)) el.addEventListener("change", changed);
    typeSeg.addEventListener("change", () => {
      if (isStop()) {
        if (whenSeg && later()) whenSeg.value = "now";
        if (!isFigure(slTrig.value)) {
          const s = slTriggerStart(sideSeg.value, num(quote()?.ltp), tick);
          if (s !== null) slTrig.value = String(s);
        }
        priceTyped = false;
      }
      changed();
    });
    slTrig.addEventListener("input", changed);
    // Typed before `changed` reads it (the listener order matters: changed would otherwise move the limit back).
    let priceTyped = false;
    price.addEventListener("input", () => (priceTyped = true));
    for (const el of [lots, price, trig, stopIn, targetIn, trailIn]) el.addEventListener("input", changed);
    whenSeg?.addEventListener("change", () => {
      // An after-market order defaults to Limit (Market is allowed, with the gap warning under it).
      if (amo() && typeSeg.value === "MARKET") typeSeg.value = "LIMIT";
      if (gtt()) {
        priceTyped = false;
        // Intraday orders sent on a later day are squared off: a GTT starts as carry (NRML); Intraday stays possible
        // and then ends at today's square-off, as the line under the trigger says.
        if (prodSeg.value === "INTRADAY") prodSeg.value = "MARGIN";
      }
      if (gtt() && !isFigure(trig.value)) {
        const ltp = num(quote()?.ltp);
        // A start: 2 % beyond the price on the side a breakout entry usually waits for.
        if (ltp) trig.value = String(O.roundToTick(ltp * (sideSeg.value === "BUY" ? 1.02 : 0.98), tick, sideSeg.value === "BUY" ? "buy" : "sell"));
      }
      changed();
    });
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
      body: (close) => (closeTicket = ticketCloser = close) && h(
        "div",
        { class: "stack ticket" },
        quoteLine,
        depthBox,
        // An exit's side is fixed (the other side would add to the position): a label, not a control.
        exit ? h("div", { class: "field" }, h("span", {}, "Side"), h("span", { class: "ticket-acct" }, side === "BUY" ? "Buy to close" : "Sell to close", h("span", { class: "muted small" }, "· to add, use the chain"))) : segField("Side", sideSeg),
        h("div", { class: "ticket-grid" }, h("label", { class: "field" }, h("span", {}, inUnits ? "Quantity " : "Lots ", lotHint), lots), segField("Type", typeSeg)),
        whenRow,
        whenSeg ? trigHint : null,
        gateRow,
        pctRow,
        slField,
        slHint,
        priceField,
        h("div", { class: "ticket-grid" }, segField("Product", prodSeg), acctField ?? h("div", { class: "field" }, h("span", {}, "Account"), h("span", { class: "ticket-acct one-line", title: a.label }, h("span", { class: "acct-name" }, a.label), modeSeg || /paper/i.test(a.label ?? "") ? null : h("span", { class: "acct-badge", "data-mode": "paper" }, "Paper")))),
        exitsBox,
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
            if (amo()) {
              const b = body();
              const f = { account: a.id, symbol: sym, product: b.product, mode: b.mode, side: b.side, units: units(), origin: "amo", orderType: b.orderType, price: b.price };
              const bad = triggerProblem(f);
              if (bad) {
                previewEl.replaceChildren(alertBox({ title: bad.message }));
                drawButton();
                return false;
              }
              try {
                await api("/v1/triggers", { method: "POST", body: triggerBody(f) });
                toast(`After-market order queued: ${b.side === "BUY" ? "buy" : "sell"} ${name} at ${refSession(st.ref).open}. Held on this Bridge: it must be running then. See Orders › Triggers.`);
                return "placed";
              } catch (err) {
                previewEl.replaceChildren(...refusalNodes(err));
                drawButton();
                return false;
              }
            }
            if (gtt()) {
              const b = body();
              const f = { account: a.id, symbol: sym, product: b.product, mode: b.mode, side: b.side, units: units(), origin: "gtt", entry: Number(trig.value), orderType: b.orderType, price: b.price, ltp: num(quote()?.ltp) };
              const bad = triggerProblem(f);
              if (bad) {
                previewEl.replaceChildren(alertBox({ title: bad.message }));
                drawButton();
                return false;
              }
              try {
                const t = (await api("/v1/triggers", { method: "POST", body: triggerBody(f) })).data.data;
                toast(`GTT set: ${b.side === "BUY" ? "buy" : "sell"} ${name} when LTP ${t.legs?.[0]?.op === "above" ? "≥" : "≤"} ${formatFixed(t.legs?.[0]?.trigger, 2)}. See Orders › Triggers.`);
                return "placed";
              } catch (err) {
                previewEl.replaceChildren(...refusalNodes(err));
                drawButton();
                return false;
              }
            }
            const exits = exitsWanted() ? exitsFields() : null;
            const exitsBad = exits ? triggerProblem(exits) : null;
            if (exitsBad) {
              previewEl.replaceChildren(alertBox({ title: `Stop and target: ${exitsBad.message}` }));
              drawButton();
              return false;
            }
            try {
              const r = (await api("/v1/orders", { method: "POST", body: { ...body(), clientOrderId } })).data.data;
              const refused = r.status === "rejected" || r.status === "cancelled";
              let exitsNote = "";
              if (exits && !refused) {
                // The entry is placed; its exits wait on the Bridge for the fill, in the mode the entry went in (the
                // Bridge refuses a bracket whose mode differs). If they are refused, say so plainly.
                const t = await optional(api("/v1/triggers", { method: "POST", body: triggerBody({ ...exits, mode: r.mode === "live" ? "live" : "paper", parentOrderId: r.orderId }) }));
                exitsNote = t.error ? `. Stop and target NOT set: ${t.error.message ?? "refused"}` : `. Stop and target set (Orders › Triggers)`;
              }
              toast(`${r.status === "filled" ? "Filled" : cap(r.status)}: ${r.side} ${formatInt(r.quantity)} ${name}${isFigure(r.avgPrice) ? ` @ ${formatFixed(r.avgPrice, 2)}` : ""}${r.mode === "live" ? " · LIVE" : " · paper"}${refused && r.statusMessage ? `. ${r.statusMessage}` : ""}${exitsNote}`, { tone: refused || exitsNote.includes("NOT") ? "error" : "ok" });
              return "placed";
            } catch (err) {
              previewEl.replaceChildren(...refusalNodes(err));
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
    clearInterval(depthTimer);
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
    chain.reset(true);
    if (st.chain) drawAll();
  }
  /** The open Customise sheet ({ el, close, redraw, syncWin }), or null. */
  let custom = null;
  /** Simple or Advanced: one column selection, drawn two ways; the Customise panel adapts. */
  function setMode(m) {
    setCfg({ mode: m === "simple" ? "simple" : "advanced" });
    if (modeSeg.value !== st.cfg.mode) modeSeg.value = st.cfg.mode;
    if (!custom) return;
    custom.redraw(...custom.names);
    const t = custom.el?.querySelector("#pop-title");
    if (t) t.textContent = st.cfg.mode === "simple" ? "Customise · Simple" : "Customise · Advanced";
  }
  /**
   * Customise, laid out like iOS Settings: captions over grouped inset sections (Column preset, View, Strikes, Market
   * line, Display, Columns, Add columns), 44 px rows with the label left and the control right. A switch only writes
   * its setting (its own state is already on screen); a change that moves other controls redraws only the sections it
   * touches, and the keyboard stays on the same control.
   */
  function openCustomise() {
    if (custom) return custom.close();
    const say = h("div", { class: "sr-only", "aria-live": "polite" });
    const label = (k) => CHAIN_COLUMNS.find(([x]) => x === k)?.[1] ?? k;
    const known = (k) => CHAIN_COLUMNS.some(([x]) => x === k);
    let refocus = null;
    /** A row: the label (and a quiet hint under it) on the left, the control on the right. */
    const row = (text, control, { hint = null, cls = "" } = {}) => h("div", { class: `cz-row${cls ? ` ${cls}` : ""}` }, text ? h("span", { class: "cz-label" }, text, hint ? h("small", {}, hint) : null) : null, control);
    /** A switch row: it writes the setting; `after` names the sections the change moves. */
    const sw = (text, get, set, { hint = null, disabled = false, after = [] } = {}) => {
      const input = h("input", { type: "checkbox", role: "switch", disabled });
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        if (after.length) redraw(...after);
      });
      return h("label", { class: `cz-row cz-sw${disabled ? " off" : ""}` }, h("span", { class: "cz-label" }, text, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const group = (...rows) => h("div", { class: "cz-group" }, rows);
    const caption = (text, extra = null) => h("h3", { class: "cz-cap" }, h("span", {}, text), extra ? h("small", {}, extra) : null);
    /** A segmented control that calls `onPick` with a new value (not on its first paint). */
    const seg = (name, options, value, onPick) => {
      const s = segmented(name, options, value);
      let cur = value;
      s.addEventListener("change", () => {
        if (s.value === cur) return;
        cur = s.value;
        onPick(cur);
      });
      return s;
    };
    const cfgSw = (text, key, opts) => sw(text, () => st.cfg[key], (v) => setCfg({ [key]: v }), opts);
    const tagSw = (text, key, opts) => sw(text, () => st.cfg.tags[key], (v) => setCfg({ tags: { ...st.cfg.tags, [key]: v } }), opts);
    const lineSw = (text, key) => sw(text, () => st.cfg.line[key], (v) => setCfg({ line: { ...st.cfg.line, [key]: v } }));
    /** The column list changed: write it, then redraw what lists or reflects it. */
    const setCols = (cols) => {
      setCfg({ cols });
      redraw("preset", "columns", "add", "display");
    };
    let winSeg = null;
    const adv = () => st.cfg.mode !== "simple";
    const build = {
      // Phones and tablets have no Simple | Advanced in the toolbar (its room is the capsule's): it is the panel's first section.
      chainView() {
        if (!device().narrow) return [];
        const s = seg("Chain view", [["simple", "Simple"], ["advanced", "Advanced"]], st.cfg.mode, (v) => setMode(v));
        return [caption("Chain view"), group(row(null, s, { cls: "full" }))];
      },
      preset() {
        if (!adv()) return [];
        const c = st.cfg;
        const pick = (p) => {
          setCfg(presetPatch(p, st.cfg));
          redraw("preset", "columns", "add", "display");
          say.textContent = `${PRESET_NAMES[p]} columns`;
        };
        const more = Object.keys(CHAIN_PRESETS).filter((p) => !MAIN_PRESETS.includes(p));
        const main = seg("Column preset", MAIN_PRESETS.map((p) => [p, PRESET_NAMES[p]]), c.preset, pick);
        const desk = seg("More layouts", more.map((p) => [p, PRESET_NAMES[p]]), c.preset, pick);
        main.classList.add("cz-presets");
        desk.classList.add("cz-presets");
        // Picking a preset replaces the whole selection; a list of your own reads Custom and no preset is picked.
        return [
          caption("Column preset", c.preset === "custom" ? "Custom" : null),
          group(row(null, main, { cls: "full" }), row("More layouts", desk, { cls: "stack", hint: c.preset === "custom" ? "Your own columns. A preset replaces them." : "Start with the columns that suit how you trade." })),
        ];
      },
      view() {
        const c = st.cfg;
        const sideKey = effSideKey();
        const opts = [["both", "Both"], ["ce", "Calls"], ["pe", "Puts"], ...(adv() ? [["straddle", "Straddle"]] : [])];
        const table = seg("Table", opts, c.straddle && adv() ? "straddle" : c[sideKey], (v) => {
          setCfg(v === "straddle" ? { straddle: true } : { [sideKey]: v, straddle: false });
          redraw("view");
        });
        const straddle = c.straddle && adv();
        const contracts = seg("Contracts", [["all", "All"], ["itm", "ITM"], ["otm", "OTM"]], c.contracts, (v) => setCfg({ contracts: v }));
        // The straddle table pairs a call with a put at each strike: moneyness does not apply.
        for (const b of contracts.querySelectorAll("button")) b.disabled = straddle;
        winSeg = seg("OI change over", [["day", "Day"], ["60", "1h"], ["15", "15m"]], c.oiWin, (v) => setCfg({ oiWin: v }));
        syncWin();
        const what = straddle ? "One row per strike: the call and its put added together" : c[sideKey] === "ce" ? "Call columns only, the strike at the edge" : c[sideKey] === "pe" ? "Put columns only, the strike at the edge" : "Calls, the strike, puts";
        return [
          caption("View"),
          group(
            row("Table", table, { cls: "stack", hint: what }),
            row("Contracts", contracts, { hint: straddle ? "Calls and puts only" : "Blanks the others; the ATM row keeps both" }),
            row("OI change", winSeg, { hint: "1h and 15m from snapshots taken in this browser" }),
          ),
        ];
      },
      strikes() {
        const v = st.strikesView;
        const i = STRIKE_STEPS.indexOf(v);
        const step = (d) => {
          setStrikes(stepStrikes(st.strikesView, d));
          refocus = `[data-step="${d}"]`;
          redraw("strikes");
          say.textContent = `${st.strikes === "all" ? "All strikes" : `${st.strikes} strikes each side`}`;
        };
        const stepper = h(
          "span",
          { class: "cz-stepper", role: "group", "aria-label": "Strikes each side of ATM" },
          h("button", { type: "button", class: "step-btn", "data-step": "-1", "aria-label": "Fewer strikes", disabled: i === 0, onclick: () => step(-1) }, icon("minus")),
          h("output", { class: "cz-step-v", "aria-live": "polite" }, v === "all" ? "All" : v),
          h("button", { type: "button", class: "step-btn", "data-step": "1", "aria-label": "More strikes", disabled: i === STRIKE_STEPS.length - 1, onclick: () => step(1) }, icon("plus")),
        );
        const bad = h("small", { class: "cz-bad", role: "status", hidden: true }, "Try 26400, +3, 1σ, atm, mp");
        const jump = h("input", { type: "search", inputmode: "decimal", enterkeyhint: "go", autocomplete: "off", spellcheck: "false", class: "cz-jump", "aria-label": "Jump to strike", placeholder: "26400, +3, atm" });
        jump.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const k = strikeFor(jump.value);
          jump.setAttribute("aria-invalid", String(k === null));
          bad.hidden = k !== null;
          if (k === null) return;
          custom?.close();
          chain.jump(k, chain.sideNow());
        });
        jump.addEventListener("input", () => {
          jump.removeAttribute("aria-invalid");
          bad.hidden = true;
        });
        const n = v === "all" ? null : Number(v);
        return [caption("Strikes"), group(row("Strikes each side of ATM", stepper, { hint: n ? `${n} below + ATM + ${n} above` : "Every strike loaded" }), row(h("span", {}, "Jump to strike", bad), jump))];
      },
      line() {
        const price = seg("Price line", [["spot", "Spot"], ["fut", "Futures"]], st.cfg.priceLine, (v) => setCfg({ priceLine: v }));
        const rows = [row("Price line", price, { hint: "Spot, or the same-expiry future (the forward when none is listed)" })];
        // Simple: the price and the day's move only.
        if (adv()) rows.push(...LINE_CHIPS.map(([k, t]) => lineSw(t, k)));
        return [caption("Market line", adv() ? "The price is always on the line" : null), group(...rows)];
      },
      display() {
        const c = st.cfg;
        const style = seg("Bar style", [["bar", "Under value"], ["fill", "Cell fill"]], c.barStyle, (v) => setCfg({ barStyle: v }));
        const has = (k) => st.cfg.cols.includes(k);
        const toggleCols = (keys, on) => setCfg({ cols: on ? [...st.cfg.cols, ...keys.filter((k) => !has(k))] : st.cfg.cols.filter((k) => !keys.includes(k)) });
        const first = adv()
          ? sw("Open interest profile", () => st.cfg.bars.oi, (v) => setCfg({ bars: { ...st.cfg.bars, oi: v } }), { hint: "OI as a bar, calls and puts on one scale" })
          : sw("Open interest & change", () => has("oi"), (v) => (v ? toggleCols(["oi"], true) : toggleCols(["oi", "chg"], false)), { hint: "OI and its change under it, as plain figures", after: ["preset", "columns", "add"] });
        const main = [
          first,
          cfgSw("Percentage changes", "pct"),
          cfgSw("Open interest & volume in lots", "lots"),
          cfgSw("Highlight ITM contracts", "itm"),
          tagSw("Open interest & volume levels", "walls", { hint: "Put wall (support) and call wall (resistance) on the strike" }),
          adv() ? sw("Put/call ratio (PCR)", () => has("pcrK"), (v) => toggleCols(["pcrK"], v), { hint: "Put OI ÷ call OI per strike", after: ["preset", "columns", "add"] }) : null,
          tagSw("Max pain", "mp"),
          cfgSw("Show all Greeks", "greeks", { hint: "IV, Delta, Gamma, Theta, Vega and Rho together" }),
          adv() ? cfgSw("Keep Call & Put LTP fixed beside Strike", "pinLtp", { hint: "Whatever the column order" }) : null,
        ];
        const extra = [
          adv() ? sw("OI change & volume bars", () => st.cfg.bars.chg && st.cfg.bars.vol, (v) => setCfg({ bars: { ...st.cfg.bars, chg: v, vol: v } })) : null,
          adv() ? row("Bar style", style) : null,
          tagSw("±1σ band", "em", { hint: "The expected move to expiry, on the strikes" }),
          tagSw("±2σ", "em2"),
          cfgSw("Compact rows", "dense"),
          // The insight cards on a resting pointer (mouse, trackpad); a tap, the I key and the help sheet work either way.
          typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches ? cfgSw("Hover cards", "insight", { hint: "What a cell shows and how it is worked out, when the pointer rests on it" }) : null,
          cfgSw("My positions", "positions", { hint: "Lots you hold, beside the LTP" }),
          cfgSw("Bid & ask", "quotes", { hint: c.preset === "arb" ? "Always on in the Arb view" : `${touchWord()} to trade; touch screens use the row's sheet`, disabled: c.preset === "arb" }),
          adv() ? cfgSw("More columns on wide screens", "wide", { hint: "A preset adds Greeks or OI columns while there is room" }) : null,
        ];
        return [caption("Display"), group(...main.filter(Boolean)), h("h4", { class: "cz-sub" }, "More"), group(...extra.filter(Boolean))];
      },
      columns() {
        const enabled = st.cfg.cols;
        const fit = chain.fitInfo();
        const cut = new Set(fit.hidden);
        const move = (k, d) => {
          const a = [...enabled];
          const i = a.indexOf(k);
          const j = i + d;
          if (j < 0 || j >= a.length) return;
          [a[i], a[j]] = [a[j], a[i]];
          // Keep the keyboard on the same button (or its twin when that one is now disabled at the end of the list).
          refocus = `[data-move="${k}|${j === 0 ? 1 : j === a.length - 1 ? -1 : d}"]`;
          setCols(a);
          say.textContent = `${label(k)} moved to position ${j + 1}`;
        };
        const colRow = (k, i) =>
          h(
            "div",
            { class: `cz-row cz-col${cut.has(k) ? " cut" : ""}`, draggable: "true", "data-col": k },
            h("button", { type: "button", class: "cz-rm", "aria-label": `Remove ${label(k)}`, disabled: enabled.length === 1, onclick: () => ((refocus = ".cz-col .cz-rm"), setCols(enabled.filter((x) => x !== k))) }, icon("remove")),
            h("span", { class: "cz-label", title: chain.colTitle(k) }, label(k), chain.isRowCol(k) ? h("small", {}, "Per strike") : null, cut.has(k) ? h("small", {}, "Hidden at this width") : null),
            h(
              "span",
              { class: "col-move" },
              h("button", { type: "button", class: "icon-btn tiny reorder", "data-move": `${k}|-1`, "aria-label": `Move ${label(k)} up (towards the strike)`, disabled: i === 0, onclick: () => move(k, -1) }, icon("up")),
              h("button", { type: "button", class: "icon-btn tiny reorder", "data-move": `${k}|1`, "aria-label": `Move ${label(k)} down (away from the strike)`, disabled: i === enabled.length - 1, onclick: () => move(k, 1) }, icon("down")),
            ),
            h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")),
          );
        const list = group(...enabled.map(colRow));
        list.classList.add("cz-cols");
        // Drag a row by its grip (mouse) to reorder; the arrow buttons do the same from the keyboard.
        let dragKey = null;
        list.addEventListener("dragstart", (e) => {
          const r = e.target.closest?.(".cz-col");
          if (!r) return;
          dragKey = r.dataset.col;
          r.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", dragKey);
        });
        list.addEventListener("dragover", (e) => {
          if (!dragKey) return;
          e.preventDefault();
          const over = e.target.closest?.(".cz-col");
          const from = list.querySelector(".dragging");
          if (!over || !from || over === from) return;
          const r = over.getBoundingClientRect();
          list.insertBefore(from, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
        });
        list.addEventListener("dragend", () => {
          if (!dragKey) return;
          dragKey = null;
          setCols([...list.querySelectorAll(".cz-col")].map((r) => r.dataset.col));
        });
        const note = fit.hidden.length ? h("p", { class: "cz-note" }, `Hidden at this width: ${fit.hidden.map(COL_NAME).join(", ")}. From the strike outwards; ${device().phone ? "use the arrows" : "drag or use the arrows"} to reorder.`) : h("p", { class: "cz-note" }, `From the strike outwards; ${device().phone ? "use the arrows" : "drag or use the arrows"} to reorder.`);
        return [caption("Columns", `${formatInt(enabled.length)} selected`), list, note];
      },
      add() {
        const enabled = new Set(st.cfg.cols);
        // A column no group lists (a new one) goes under the last group, so nothing is left out.
        const grouped = new Set(COLUMN_GROUPS.flatMap((g) => g.keys));
        const extra = CHAIN_COLUMNS.map(([k]) => k).filter((k) => !grouped.has(k));
        const groups = COLUMN_GROUPS.map((g, i) => ({ ...g, keys: [...g.keys, ...(i === COLUMN_GROUPS.length - 1 ? extra : [])].filter((k) => known(k) && !enabled.has(k)) })).filter((g) => g.keys.length);
        const n = groups.reduce((a, g) => a + g.keys.length, 0);
        const addRow = (k) => h("div", { class: "cz-row cz-add" }, h("button", { type: "button", class: "cz-plus", "aria-label": `Add ${label(k)}`, onclick: () => ((refocus = ".cz-add .cz-plus"), setCols([...st.cfg.cols, k])) }, icon("add")), h("span", { class: "cz-label", title: chain.colTitle(k) }, label(k), chain.isRowCol(k) ? h("small", {}, "Per strike") : null));
        return [caption("Add columns", `${formatInt(n)} available`), ...groups.flatMap((g) => [h("h4", { class: "cz-sub" }, g.label), group(...g.keys.map(addRow))])];
      },
    };
    const NAMES = Object.keys(build);
    const nodes = new Map(NAMES.map((n) => [n, h("section", { class: "cz-sec", "data-sec": n }, build[n]())]));
    /** Redraw these sections only, keeping the keyboard on the same control (by position) or on `refocus`. */
    function redraw(...names) {
      const active = document.activeElement;
      let at = null;
      for (const n of names) {
        const sec = nodes.get(n);
        if (!sec?.contains(active)) continue;
        at = [n, [...sec.querySelectorAll("button, input")].indexOf(active)];
      }
      for (const n of names) nodes.get(n)?.replaceChildren(...build[n]());
      const sel = refocus;
      refocus = null;
      const target = (sel && wrap.querySelector(sel)) || (at && at[1] >= 0 ? [...nodes.get(at[0]).querySelectorAll("button, input")][at[1]] : null);
      if (target && !target.disabled) target.focus({ preventScroll: true });
    }
    /** OI change: the window in use; one not ready yet is disabled and its title says why. */
    function syncWin() {
      if (!winSeg) return;
      const w = winState;
      for (const b of winSeg.querySelectorAll("button")) {
        const a = w?.avail[b.dataset.value];
        b.disabled = Boolean(a && !a.ok);
        b.title = a ? (a.ok ? `OI change ${a.label}` : `Collecting: ${a.reason}`) : "OI change since the previous close";
      }
    }
    const reset = h("button", { type: "button", class: "small plain reset", onclick: () => {
      // Reset: the Core preset and every default; Simple or Advanced is left as it is.
      st.cfg = chainConfig({ mode: st.cfg.mode });
      setStrikes("10");
      setCfg({});
      redraw(...NAMES);
      say.textContent = "Chain settings reset";
    } }, icon("refresh"), "Reset");
    const wrap = h("div", { class: "pop-body cz" }, [...nodes.values()], say);
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
    const pop = sheetPopover({ trigger: gearBtn, title: adv() ? "Customise · Advanced" : "Customise · Simple", head: [reset], body: wrap, cls: "customise", onClose: () => { unanchor(); custom = null; } });
    custom = { el: pop.el, close: pop.close, redraw, syncWin, names: NAMES };
    if (custom.el?.classList.contains("floating")) {
      anchor();
      addEventListener("resize", anchor);
      addEventListener("scroll", anchor, true);
    }
  }

  // ── Strike search: 26400, 264, +3, -2σ, atm, mp (O.strikeQuery) ──
  /** The strike a query names in the chain on screen, or null. */
  function strikeFor(text) {
    const x = lastX;
    if (!x) return null;
    const strikes = x.c.rows.map((r) => r.strike);
    const sigmaPts = x.F !== null && x.sm.atmIv && x.years > 0 ? (x.sm.atmIv / 100) * Math.sqrt(x.years) * x.F : null;
    return O.strikeQuery(text, { strikes, atm: x.sm.atm, F: x.F, sigmaPts, maxPain: x.sm.maxPain });
  }

  function showKeys() {
    modal({
      title: "Option chain keys",
      body: h(
        "table",
        { class: "keys-table" },
        h("tbody", {}, CHAIN_KEYS.map(([keys, , long]) => h("tr", {}, h("th", { scope: "row" }, keys.map((k) => h("kbd", {}, k))), h("td", {}, long)))),
      ),
      buttons: [{ label: "How to read the chain", value: "help" }, { label: "Close", value: true }],
    }).then((v) => v === "help" && openChainHelp());
  }

  // ── Keyboard ──
  // Symbol search (symbol-search.js): "/" or a letter that is not one of the page's own keys opens it, filled in with
  // that letter (n → NIFTY). Each page lists its letter keys in `bound` (either case): they keep their meaning even
  // where they do nothing at that moment (H with no focused row), so a key never acts one way here and another there.
  const desk = {
    root: chainEl,
    bound: "jkhlgprmcvbstx",
    search: (q) => openSearch(q),
    onKey(e) {
      const k = e.key;
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
      if (/^[1-5]$/.test(k)) return setCfg(presetPatch(TOOLBAR_PRESETS[Number(k) - 1], st.cfg)), custom?.redraw("preset", "columns", "add", "display"), true;
      if (k === "m") return chain.toggleSelect(), true;
      if (k === "Escape" && chain.selecting) return chain.toggleSelect(false), true;
      if (k === "c" || k === "v") {
        const want = k === "c" ? "ce" : "pe";
        const key = effSideKey();
        return setCfg({ [key]: st.cfg[key] === want && !st.cfg.straddle ? "both" : want, straddle: false }), true;
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
      if (k === "t") return strategyMenu(row.strike, chain.rowHead?.(row.strike) ?? null), true;
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
    bound: "cgjkmuwpr",
    search: (q) => openSearch(q),
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return oiPage.onKey(e);
    },
  };
  const stratDesk = builder && {
    root: builder.panel,
    bound: "abegstzpr",
    search: (q) => openSearch(q),
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return builder.onKey(e);
    },
  };
  const posDesk = posPage && {
    root: posPage.root,
    bound: "abcghijkrxp",
    search: (q) => openSearch(q),
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return posPage.onKey(e);
    },
  };
  const volDesk = volPage && {
    root: volPage.root,
    bound: "cgjktxpr",
    search: (q) => openSearch(q),
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return volPage.onKey(e);
    },
  };
  const arbDesk = arbPage && {
    root: arbPage.root,
    bound: "bceghjkmopr",
    search: (q) => openSearch(q),
    onKey(e) {
      if (e.key === "p") return toggleLive(), true;
      if (e.key === "r") return refresh(), true;
      return arbPage.onKey(e);
    },
  };
  activeDesk = kind === "chain" ? desk : kind === "oi" ? oiDesk : kind === "strategy" ? stratDesk : kind === "positions" ? posDesk : kind === "vol" ? volDesk : kind === "arb" ? arbDesk : null;
  bindKeys();

  // ── Wiring ──
  // Reaching for the underlying picker warms the other underlyings' expiry lists (one cached read each, background
  // priority), so a switch goes straight to its chain. Their chains are not prefetched: a native select does not say
  // which option is under the pointer, and a chain read per underlying would spend the chain budget on guesses.
  let warmedU = false;
  const warmUnderlyings = () => {
    if (warmedU) return;
    warmedU = true;
    for (const u of list) if (u !== st.underlying) prefetch(`/v1/expiries?underlying=${encodeURIComponent(u)}`);
  };
  uSel.addEventListener("pointerenter", warmUnderlyings);
  uSel.addEventListener("focus", warmUnderlyings);
  // The underlying's name in the toolbar opens the symbol search with a mouse or the keyboard; touch keeps the native
  // list (app.js installCtxPicker skips a picker marked data-search).
  uItem.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !media("(pointer: fine)").matches) return;
    e.preventDefault();
    openSearch("");
  }, true);
  uSel.addEventListener("keydown", (e) => {
    if (!media("(pointer: fine)").matches || !(e.key === "Enter" || e.key === " " || (e.key === "ArrowDown" && e.altKey) || e.key === "F4")) return;
    e.preventDefault();
    openSearch("");
  });
  /** Switch the desk to an underlying (the search's pick): the same path as the toolbar's select. A stock not on the
   *  list replaces the session's stock, as the watchlist's Chain link does. */
  function pickUnderlying(u) {
    if (u === st.underlying) return;
    if (!list.includes(u)) {
      const old = list.findIndex((x) => !base.includes(x));
      if (old >= 0) {
        for (const o of uSel.options) if (o.value === list[old]) o.remove();
        list.splice(old, 1);
      }
      list.push(u);
      uSel.append(h("option", { value: u }, u));
    }
    uSel.value = u;
    uSel.dispatchEvent(new Event("change"));
  }
  function openSearch(q) {
    openSymbolSearch({
      initial: q,
      current: st.underlying,
      indices: base,
      demo: Boolean(app.state.demo),
      quoteSymbol: (u) => INDEX_SYMBOL[u] ?? `NSE:${u}`,
      exchangeOf: (u) => (INDEX_SYMBOL[u] ?? "NSE:").split(":")[0],
      // The chain: a strike typed here (26400, +3, atm) is a row of its own, first.
      strike: kind === "chain" ? (t) => (/^[+-]?\d|^(atm|mp)$|σ$/i.test(t.trim()) ? strikeFor(t) : null) : null,
      onStrike: (k) => chain.jump(k, chain.sideNow()),
      onPick: (u) => pickUnderlying(u),
    });
  }
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
  gearBtn.addEventListener("click", () => openCustomise());
  modeSeg.addEventListener("change", () => modeSeg.value !== st.cfg.mode && setMode(modeSeg.value));
  selectBtn.addEventListener("click", () => chain.toggleSelect());
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
  // Left while still loading (not mounted yet): check again once the load is done, else nothing ever tidied this page
  // up (its live watch, timers and observers kept the whole page alive).
  const onRoute = () =>
    setTimeout(() => {
      if (pageRoot.isConnected) return;
      if (mounted) cleanup();
      else loaded?.then(() => setTimeout(() => !pageRoot.isConnected && cleanup(), 0));
    }, 0);
  let refRo = null;
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    // The document-wide key handler reads activeDesk: let go of this page (it kept the whole left page alive).
    if (activeDesk && !activeDesk.root?.isConnected) activeDesk = null;
    feed?.stop();
    clearInterval(ageTimer);
    refRo?.disconnect();
    ctxRo?.disconnect();
    headRo?.disconnect();
    refChipEl.destroy?.();
    document.querySelector(".toolbar-title")?.classList.remove("icon-only");
    chain.destroy();
    document.getElementById("content")?.removeAttribute("data-stale");
    custom?.close();
    ctxSheet?.close();
    ticketCloser?.(undefined, true);
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
  // The chain's capsule is underlying │ expiry │ spot only: the future, its basis and ATM IV are in the spot's title,
  // on the market line (Customise → Market line) and in the hover cards, so the bar stays calm.
  const strat = kind === "strategy";
  capsule = h("div", { class: `ctx-cap glass${wide ? " ctx-chain" : ""}` }, uItem, kind === "positions" ? null : eItem, spotItem, strat ? futItem : null, strat ? ivItem : null, strat ? sigItem : null);
  // The chain is read-only until an order is placed: its account picker lives in the ticket and the action sheet
  // ("Orders go to"), and the line shows only a red LIVE-orders pill when orders would go to a live account.
  // The Strategy Builder picks the account in its confirm sheet ("Orders go to"), like the chain's ticket.
  const acctItem = TRADING.has(kind) && kind !== "chain" && kind !== "strategy" ? h("span", { class: "ctx-acct glass" }, tradable.length ? [aSel, acctBadge] : h("a", { href: "#/accounts", class: "acct-connect" }, icon("plug"), "Connect an account")) : null;
  mountToolbarCtx(kind, capsule, expiryChip, refChipEl.el, h("span", { class: "ctx-spacer" }), kind === "chain" ? toolSlot : null, acctItem, wide ? liveOrders : null, demoPill, liveBtn.el, moreBtn);
  if (wide) document.querySelector(".toolbar-title")?.classList.add("icon-only");
  // The chain fits its table to the viewport: a banner that appears or goes moves where the table starts.
  if (kind === "chain" && typeof ResizeObserver === "function") {
    refRo = new ResizeObserver(() => chain.fitHeight());
    refRo.observe(refBannersEl.el);
  }
  // Every desk page fits its capsule (OI, Volatility, Positions too: at 1280 px the % change was cut to "(−1").
  // Only the room it has decides that: the bar's width. The capsule's own size moves with every tick's figures (and
  // fitCtx itself resizes it), and observing it ran this measure-and-refit loop about once a second on a live chain;
  // a change in its text length is fitCtxIfNeeded's job.
  if (typeof ResizeObserver === "function") {
    let roomW = -1;
    ctxRo = new ResizeObserver((entries) => {
      // It watches the shared toolbar slot, which outlives this page: let go once the capsule is gone.
      if (!capsule.isConnected && mounted) return ctxRo?.disconnect();
      const w = Math.round(entries[entries.length - 1]?.contentRect?.width ?? -1);
      if (w === roomW) return;
      roomW = w;
      fitCtx();
    });
    ctxRo.observe(capsule.parentNode ?? capsule);
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
    // No summary strip above the chain: the market line in the table (Customise → Market line) carries ATM straddle,
    // expected move, ATM IV and the rest. No tool row either: expiry is in the toolbar ([ and ]), strikes, presets
    // and strike search are in Customise, and the chain's tools sit in its CALLS / PUTS header row.
    headRow.prepend(chain.phoneBar);
    const out = [
      refBannersEl.el,
      h("section", { class: "desk-panel chain-panel", "data-panel": "chain", "aria-label": "Option chain" }, headRow, chainEl, keysEl),
    ];
    syncTools();
    headRo?.observe(chainEl);
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
  // Added by the columns round (some in the Buyer, Seller and Hedger presets): figures from chain-metrics.js. Bid / Ask here are plain
  // figures; the "Bid and ask" switch keeps its own trade buttons (keys "bid" / "ask", outside this list).
  ["ltpChg", "LTP change"], ["prevClose", "Previous close"], ["avgPx", "Average price"], ["high", "Today's high"], ["low", "Today's low"],
  ["prevVol", "Previous volume"], ["volOi", "Volume / OI"],
  ["bidPx", "Bid"], ["bidQty", "Bid quantity"], ["askPx", "Ask"], ["askQty", "Ask quantity"],
  ["rho", "Rho"], ["bu5", "5 min build-up"], ["bu15", "15 min build-up"],
  ["intrinsic", "Intrinsic value"], ["bePct", "Breakeven %"], ["spreadAbs", "Bid-ask spread"], ["theo", "Theoretical price"],
  ["relDist", "Relative distance"], ["bidPct", "Bid %"], ["askPct", "Ask %"], ["bidPctAnn", "Annualised bid %"], ["askPctAnn", "Annualised ask %"],
];
/**
 * Column presets, listed from the strike outwards. The first five (Core, Buyer, Seller, Hedger, Other: keys 1-5) follow
 * the order a chain is read in: the price beside the strike, then the Greeks (what the premium prices), then where
 * contracts are held and what changed (OI, OI change, volume), the one-day build-up at the outer edge, and the
 * buyer's cost last. The other four are the desk's own views (OI, Arb, Greeks, Value).
 */
export const CHAIN_PRESETS = {
  core: ["ltp", "delta", "iv", "oi", "vol", "bu"],
  buyer: ["ltp", "ltpChg", "ext", "delta", "iv", "theta", "oi", "vol", "bu", "be", "bePct"],
  seller: ["ltp", "iv", "theta", "vega", "oi", "vol", "volOi", "bu5", "bu", "be"],
  hedger: ["ltp", "spreadAbs", "dist", "relDist", "delta", "gamma", "iv", "theta", "vega", "oi"],
  other: ["ltp", "oi", "vol", "bu"],
  oi: ["ltp", "iv", "vol", "bu", "chg", "oi"],
  arb: ["syn", "dev", "edge", "ivskew", "ltp", "iv"],
  greeks: ["ltp", "iv", "delta", "gamma", "theta", "vega", "rho", "pitm"],
  value: ["ltp", "iv", "ext", "spread", "liq", "prem"],
};
/** The display switches a preset sets with its columns (the rest are left as they are). Bid / Ask: on in Hedger (it
 *  reads the spread), off in the others (one switch away in Customise → Display), so a preset never inherits them. */
export const PRESET_DISPLAY = Object.freeze({
  core: { bars: { oi: true, chg: true, vol: true }, pct: true, itm: false, quotes: false, tags: { mp: true, walls: true } },
  buyer: { bars: { oi: true, chg: true, vol: true }, pct: true, itm: true, quotes: false, tags: { mp: true, walls: true } },
  seller: { bars: { oi: true, chg: true, vol: true }, pct: true, itm: true, quotes: false, tags: { mp: true, walls: true } },
  hedger: { bars: { oi: true, chg: false, vol: false }, pct: false, quotes: true, tags: { mp: false, walls: false } },
  other: { bars: { oi: true, chg: true, vol: true }, pct: false, quotes: false, tags: { mp: true, walls: true } },
});
/** The config patch for picking a preset: its columns and its display switches (tags merge with the ±σ ones). */
export function presetPatch(p, cfg = CHAIN_DEFAULTS) {
  const d = PRESET_DISPLAY[p] ?? {};
  return { cols: [...(CHAIN_PRESETS[p] ?? CHAIN_PRESETS.core)], ...d, ...(d.tags ? { tags: { ...cfg.tags, ...d.tags } } : {}) };
}
/** The round-1 OI preset (build-up at the outer edge): a saved copy of it becomes today's OI preset. */
const OLD_OI_PRESET = "ltp,iv,vol,chg,oi,bu";
export const PRESET_NAMES = Object.freeze({ core: "Core", buyer: "Buyer", seller: "Seller", hedger: "Hedger", other: "Other", oi: "OI", arb: "Arb", greeks: "Greeks", value: "Value" });
/** Customise's first row of presets (the reader's layouts); the desk's own views are a second row. */
export const MAIN_PRESETS = Object.freeze(["core", "buyer", "seller", "hedger", "other"]);
/**
 * Customise → Add columns, in groups. Every CHAIN_COLUMNS key sits in exactly one group (desk.test.mjs). Customise
 * skips a key that is not a column (yet), so a group may list keys added by a later change.
 */
export const COLUMN_GROUPS = Object.freeze([
  { id: "price", label: "Price & volume", keys: ["ltp", "ltpChg", "prevClose", "avgPx", "high", "low", "vol", "prevVol", "volOi", "prem", "premLot"] },
  { id: "depth", label: "Market depth", keys: ["bidPx", "bidQty", "askPx", "askQty", "spread", "liq"] },
  { id: "greeks", label: "Greeks", keys: ["iv", "delta", "gamma", "theta", "vega", "rho", "thetaLot", "ivx", "ivskew"] },
  { id: "oi", label: "Open interest signals", keys: ["oi", "chg", "bu", "bu5", "bu15", "pcrK"] },
  {
    id: "other",
    label: "Other metrics",
    keys: ["pitm", "potm", "ext", "intrinsic", "be", "bePct", "pop", "pops", "dist", "relDist", "spreadAbs", "theo", "bidPct", "askPct", "bidPctAnn", "askPctAnn", "hedge", "costPct", "syn", "dev", "edge", "strad"],
  },
]);
/** Keys 1-5 pick these presets. */
const TOOLBAR_PRESETS = MAIN_PRESETS;

/**
 * Fit engine (docs/design/chain.md §3.4). Minimum widths per column (px, padding included), and per preset the order
 * in which columns drop out when the panel is too narrow ("quotes" = the Bid / Ask pair). LTP and the strike never
 * drop. A custom column list drops from the outer edge inwards.
 */
// Estimates, measured from the demo chain at desktop size with the clean cells (a figure over its quiet sub figure, the
// bar a hairline at the cell's foot, build-up a short capsule; 9 px gutters; the header text counts). The chain
// replaces them with the real minimum of each column once its table is on screen (measureCols in createChain); a
// column that has never been on screen keeps its estimate, so these must not be short (Build-up at 124 against a real
// 165 px card was why it dropped first).
export const COL_MIN = Object.freeze({
  ltp: 78, iv: 52, oi: 64, chg: 70, vol: 74, bu: 120, bid: 68, ask: 68, delta: 60, gamma: 70, theta: 60, vega: 52, pitm: 58, potm: 64,
  ext: 82, spread: 74, liq: 70, prem: 110, be: 70, pop: 60, pops: 62, dist: 72, premLot: 76, thetaLot: 76, ivx: 64, hedge: 84,
  costPct: 62, syn: 126, dev: 98, edge: 96, ivskew: 58, pcrK: 54, strad: 78,
  ltpChg: 70, prevClose: 80, avgPx: 74, high: 68, low: 68, prevVol: 74, volOi: 60, bidPx: 64, bidQty: 68, askPx: 64, askQty: 68,
  rho: 70, bu5: 120, bu15: 120, intrinsic: 70, bePct: 60, spreadAbs: 72, theo: 68, relDist: 64, bidPct: 60, askPct: 60, bidPctAnn: 76,
  askPctAnn: 76, sdOi: 70, sdBu: 120, default: 64,
});
/** The strike column's estimate (the soft capsule and its gutters), before the table measures it. */
export const STRIKE_W = 96;
/** Touch screens: 44 px rows and wider padding, so every minimum grows by 8 px. */
export const coarseMin = (w = COL_MIN) => Object.freeze(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v + 8])));
const COL_MIN_COARSE = coarseMin();
/** Phones: tighter minimums (one side shows Strike | LTP | OI chg | OI; Both shows OI | LTP | Strike | LTP | OI). */
export const PHONE_MIN = Object.freeze({ ltp: 72, oi: 66, chg: 72, iv: 46, vol: 62, bu: 104, syn: 84, dev: 74, edge: 70, default: 62 });
export const PRESET_DROP = Object.freeze({
  core: ["bu", "vol", "quotes", "iv", "delta", "oi"],
  buyer: ["bePct", "ltpChg", "be", "bu", "vol", "theta", "ext", "quotes", "iv", "oi", "delta"],
  seller: ["bu5", "volOi", "be", "quotes", "bu", "vega", "vol", "theta", "iv", "oi"],
  hedger: ["relDist", "vega", "theta", "gamma", "dist", "spreadAbs", "quotes", "iv", "oi", "delta"],
  other: ["bu", "vol", "quotes", "oi"],
  oi: ["bu", "vol", "iv", "quotes", "chg", "oi"],
  arb: ["iv", "ivskew", "edge", "quotes", "dev", "syn"],
  greeks: ["pitm", "rho", "vega", "gamma", "quotes", "theta", "delta", "iv"],
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
export function fitColumns({ side = [], mid = [], quotes = false, sides = 2, avail = Infinity, widths = COL_MIN, strikeW = STRIKE_W, order = [], cap = Infinity, extra = 0 } = {}) {
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
  // Simple prints plain figures (no bars, nothing on the market line but the price, no straddle table, no pinning);
  // Advanced draws everything chosen. Both read the one column selection, so switching resets nothing.
  mode: "advanced",
  cols: CHAIN_PRESETS.core,
  side: "both",
  phoneSide: "ce",
  // Bid / Ask are one switch away (Customise → Display); Core reads LTP, so the default chain leaves them off.
  quotes: false,
  bars: { oi: true, chg: true, vol: true },
  barStyle: "bar",
  pct: true,
  lots: false,
  itm: false,
  positions: true,
  dense: false,
  wide: true,
  oiWin: "day",
  tags: { mp: true, walls: true, em: true, em2: false },
  // Customise → View: one row per strike (call + put) instead of the two sides, and a moneyness filter.
  straddle: false,
  contracts: "all",
  // Customise → Market line: the divider row's price (spot or the future) and the figures it carries.
  priceLine: "spot",
  line: { straddle: true, em: true, iv: false, range: false, pcr: false, mp: false, walls: false },
  // Customise → Display: every Greek for now (added to the chosen columns), LTP kept next to the strike.
  greeks: false,
  pinLtp: false,
  insight: true,
  // The settings' revision: 2 turned Bid / Ask off in the Core view (a Core chain saved before then is moved once).
  rev: 2,
});
/** The market line's chips, in the order they show: [key, Customise label]. */
export const LINE_CHIPS = Object.freeze([["straddle", "ATM straddle"], ["em", "Expected move"], ["iv", "ATM implied volatility"], ["range", "Day low & day high"], ["pcr", "Put/call ratio (PCR)"], ["mp", "Max pain"], ["walls", "Put wall / Call wall"]]);
export function chainConfig(saved) {
  const d = CHAIN_DEFAULTS;
  const c = saved && typeof saved === "object" ? saved : {};
  const known = new Set(CHAIN_COLUMNS.map(([k]) => k));
  let cols = Array.isArray(c.cols) ? c.cols.filter((k, i, a) => known.has(k) && a.indexOf(k) === i) : d.cols;
  if (cols.join() === OLD_OI_PRESET) cols = [...CHAIN_PRESETS.oi];
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  const out = {
    mode: c.mode === "simple" ? "simple" : "advanced",
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
    straddle: bool(c.straddle, d.straddle),
    contracts: ["all", "itm", "otm"].includes(c.contracts) ? c.contracts : d.contracts,
    priceLine: c.priceLine === "fut" ? "fut" : "spot",
    line: Object.fromEntries(LINE_CHIPS.map(([k]) => [k, bool(c.line?.[k], d.line[k])])),
    greeks: bool(c.greeks, d.greeks),
    pinLtp: bool(c.pinLtp, d.pinLtp),
    insight: bool(c.insight, d.insight),
    rev: d.rev,
  };
  out.preset = presetOf(out.cols);
  // Revision 2: Core leaves Bid / Ask off. A Core chain saved before it had them on by default, not by choice.
  if (!(c.rev >= 2) && saved && typeof saved === "object" && out.preset === "core") out.quotes = false;
  // Bid and ask are what an arbitrage is read from: the Arb preset always shows them.
  if (out.preset === "arb") out.quotes = true;
  return out;
}
/** Calendar days from the data's date to an expiry (both YYYY-MM-DD, IST), never below zero; null when unreadable. */
export function dteOf(expiry, day) {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${expiry}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : null;
}
/** The days-to-expiry pill's tone: "today" (red) on expiry day, "near" (amber) at one or two days, else plain. */
export const dteTone = (n) => (n === null || n === undefined ? "" : n <= 0 ? "today" : n <= 2 ? "near" : "");
/** The Strikes stepper's steps (strikes each side of ATM). */
export const STRIKE_STEPS = Object.freeze(["3", "5", "10", "15", "20", "25", "30", "40", "all"]);
/** Strikes each side of ATM: one of STRIKE_STEPS (the old ±8 / ±12, and anything unknown, become ±10). */
export const strikesPref = (v) => (STRIKE_STEPS.includes(v) ? v : "10");
/** One step up (+1) or down (-1) the stepper, stopping at either end. */
export const stepStrikes = (v, d) => STRIKE_STEPS[Math.max(0, Math.min(STRIKE_STEPS.length - 1, STRIKE_STEPS.indexOf(strikesPref(v)) + Math.sign(d)))];
/** Show all Greeks adds these (the ones that are columns) after the chosen columns. */
export const GREEK_KEYS = Object.freeze(["iv", "delta", "gamma", "theta", "vega", "rho"]);
/**
 * What the chain draws for a config: Simple prints plain figures, so its bars, the market line's extras, the straddle
 * table and LTP pinning are off whatever is saved (they come back with Advanced, untouched).
 */
export function viewCfg(c) {
  if (c?.mode !== "simple") return c;
  return { ...c, bars: { oi: false, chg: false, vol: false }, barStyle: "bar", straddle: false, pinLtp: false, line: Object.fromEntries(Object.keys(c.line ?? {}).map((k) => [k, false])) };
}
/**
 * The columns the chain lays out for a config: the chosen ones, then every Greek not already chosen (Show all
 * Greeks), with LTP moved next to the strike (Pin LTP). `has(k)`: whether k is a column the chain can draw.
 */
export function effectiveCols(c, has = () => true) {
  let cols = (c?.cols ?? []).filter(has);
  if (c?.greeks) cols = [...cols, ...GREEK_KEYS.filter((k) => has(k) && !cols.includes(k))];
  if (c?.pinLtp && cols.includes("ltp")) cols = ["ltp", ...cols.filter((k) => k !== "ltp")];
  return cols;
}
/**
 * Customise → Contracts: whether a strike's call ("ce") or put ("pe") is shown. ITM / OTM against spot; with no
 * spot every contract shows.
 */
export function contractShown(strike, side, spot, filter = "all") {
  if (filter !== "itm" && filter !== "otm") return true;
  if (!isFigure(spot)) return true;
  return O.inTheMoney(strike, side, Number(spot)) === (filter === "itm");
}
/**
 * The straddle table's row for one strike (Customise → View → Straddle): the call and its put added together. Price is
 * call LTP + put LTP; Change is Price minus the two previous closes added (and that as a % of them); OI, OI change and
 * volume are summed; the breakevens are strike ± Price; IV is the mean of the two; Analysis is the build-up rule fed
 * the combined premium change and OI change. A figure needs both legs (else null).
 */
export function straddleRow(row) {
  const ce = row?.ce ?? null;
  const pe = row?.pe ?? null;
  const both = (f) => {
    const a = ce ? f(ce) : null;
    const b = pe ? f(pe) : null;
    return a === null || b === null ? null : a + b;
  };
  const ltp = both((q) => num(q.ltp));
  // A leg's previous close: its own close, else its LTP less today's change.
  const prevOf = (q) => num(q.close) ?? (num(q.ltp) !== null && num(q.change) !== null ? num(q.ltp) - num(q.change) : null);
  const prev = both(prevOf);
  const change = ltp !== null && prev !== null ? ltp - prev : null;
  const oiChange = both((q) => num(q.oiChange));
  const ivs = [num(ce?.iv), num(pe?.iv)].filter((v) => v !== null && v > 0);
  const strike = isFigure(row?.strike) ? Number(row.strike) : null;
  return {
    strike,
    ltp,
    ceLtp: num(ce?.ltp),
    peLtp: num(pe?.ltp),
    prev,
    change,
    changePct: change !== null && prev ? (change / prev) * 100 : null,
    oi: both((q) => num(q.oi)),
    oiChange,
    volume: both((q) => num(q.volume)),
    iv: ivs.length === 2 ? (ivs[0] + ivs[1]) / 2 : null,
    be: ltp !== null && strike !== null ? [strike - ltp, strike + ltp] : null,
    bu: O.buildup({ change, oiChange }),
  };
}
/**
 * The market line's parts (Customise → Market line), around the price and its move, as
 * [key, label, value, title, at, fill]: `at` "pre" draws before the price, "post" after it. In order: the ATM straddle
 * with its IV note (the IV stands alone as ATM IV when the straddle is off), the day's low with a fill running up to
 * the price (`fill`, 0-1), then after the price the day's high, the expected move (0.85 × the straddle: a size, not a
 * forecast) with the straddle's own breakevens (ATM strike ± straddle), and the desk's extras (PCR, max pain, walls).
 * A value is text, or parts [text | [text, "up" | "down"]]: a figure with a direction carries its colour (the low in
 * the loss colour and the high in the gain colour; a put-heavy PCR, a bullish read, in the gain colour). Only parts
 * switched on and with a figure. `x` is the chain's draw context (sm, spot, indexQuote).
 */
export function lineChips(x, line) {
  const sm = x?.sm ?? {};
  const out = [];
  const on = (k) => Boolean(line?.[k]);
  const straddle = isFigure(sm.straddle) && sm.straddle > 0 ? Number(sm.straddle) : null;
  const iv = isFigure(sm.atmIv) ? formatPercent(sm.atmIv, 1) : null;
  if (on("straddle") && straddle !== null) out.push(["straddle", "ATM straddle", [formatFixed(straddle, 2), ...(on("iv") && iv ? [[` · IV ${iv}`, "quiet"]] : [])], "Call LTP + put LTP at the ATM strike; IV is the mean of their IVs", "pre"]);
  else if (on("iv") && iv) out.push(["iv", "ATM IV", iv, "The mean of the ATM call and put IV", "pre"]);
  const lo = num(x?.indexQuote?.low);
  const hi = num(x?.indexQuote?.high);
  const spot = num(x?.spot);
  if (on("range") && lo !== null && hi !== null && hi > lo) {
    const fill = spot === null ? null : Math.max(0, Math.min(1, (spot - lo) / (hi - lo)));
    out.push(["lo", "L", [[formatFixed(lo, 2), "down"]], "The day's low; the fill runs up to the price", "pre", fill]);
    out.push(["hi", "H", [[formatFixed(hi, 2), "up"]], "The day's high", "post"]);
  }
  if (on("em") && straddle !== null) {
    const atm = num(sm.atm);
    out.push(["em", "Exp move", `±${formatFixed(0.85 * straddle, 2)}${atm !== null ? ` · ${formatInt(Math.round(atm - straddle))} – ${formatInt(Math.round(atm + straddle))}` : ""}`, "0.85 × the ATM straddle: a size, not a forecast. Then the straddle's own breakevens, ATM strike ± straddle", "post"]);
  }
  const lean = pcrSide(sm.pcr);
  if (on("pcr") && isFigure(sm.pcr)) out.push(["pcr", "PCR", [[formatFixed(sm.pcr, 2), lean === "put" ? "up" : lean === "call" ? "down" : ""]], "Put OI ÷ call OI over the strikes loaded: 1.2 and up put-heavy (bullish), 0.8 and below call-heavy (bearish)", "post"]);
  if (on("mp") && isFigure(sm.maxPain)) out.push(["mp", "Max pain", formatInt(sm.maxPain), "Settlement at which option buyers would collect the least", "post"]);
  if (on("walls") && (sm.support || sm.resistance)) out.push(["walls", "Walls", [[sm.support ? formatInt(sm.support.strike) : DASH, "up"], " – ", [sm.resistance ? formatInt(sm.resistance.strike) : DASH, "down"]], "Put wall (support) to call wall (resistance): the strikes with the most put and call OI loaded", "post"]);
  return out;
}

const MQ_PHONE = "(max-width: 719px)";
const MQ_COARSE = "(pointer: coarse)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
/** Device class: phone (≤ 719 px) and touch (coarse pointer) change the chain's layout, so they are part of its key. */
const MQ_NARROW = "(max-width: 1023px)";
export const device = () => ({ phone: media(MQ_PHONE).matches, narrow: media(MQ_NARROW).matches, coarse: media(MQ_COARSE).matches });
const reducedMotion = () => media("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => media("(hover: hover) and (pointer: fine)").matches;

/**
 * Make live node `a` match freshly built node `b` (same tags and child counts): true when done in place. Only what
 * differs is written (a text node's data, an attribute), so a live tick costs the browser a text change, not a new
 * subtree. No arrays are allocated: it runs for every changed chain cell on every frame that brought ticks.
 * `snap`: a style change (a bar's length) is applied without its CSS transition. Live ticks move a bar by a hair;
 * animating each one kept 30 to 70 transitions running and the table repainting on most frames. A refresh (snap
 * false) animates again from wherever the bar is.
 */
function morph(a, b, snap = false) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType === 3) {
    if (a.data !== b.data) a.data = b.data;
    return true;
  }
  const an = a.childNodes;
  const bn = b.childNodes;
  if (a.nodeType !== 1 || an.length !== bn.length) return false;
  const aa = a.attributes;
  const ba = b.attributes;
  for (let i = aa.length - 1; i >= 0; i -= 1) {
    const name = aa[i].name;
    if (!b.hasAttribute(name)) a.removeAttribute(name);
  }
  for (let i = 0; i < ba.length; i += 1) {
    const at = ba[i];
    if (at.name === "style") {
      // Through the CSSOM: the dashboard's CSP refuses inline style attributes.
      const want = b.style.cssText;
      const snapped = Boolean(a.style.transition);
      if (snapped) a.style.removeProperty("transition");
      if (a.style.cssText !== want) {
        a.style.cssText = want;
        if (snap) a.style.transition = "none";
      } else if (snapped && snap) a.style.transition = "none";
    } else if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  }
  // From the end: a child that cannot be morphed moves out of `b`, which shifts only the indices after it.
  for (let i = an.length - 1; i >= 0; i -= 1) if (!morph(an[i], bn[i], snap)) a.replaceChild(bn[i], an[i]);
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

function createChain({ st, host, tools = null, headRow = null, toolSlot = null, onToolsPlaced = null, onTrade, onFocus, onOpen, onSide, onPhoneSide, onWindowAll, onLeg = null, onPick = null, onRelayout = null, onNextExpiry = null, onSelectChange = null, onHold = null, onStrikeMenu = null }) {
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
  /**
   * A cell with a bar: line 1 the figure, line 2 its quiet sub figure (or nothing), and the bar as a hairline along the
   * cell's foot (app.css: out of the grid, so it costs no width and the sub figure keeps its line).
   */
  const cgBar = (l1, l2, barEl, c1 = "") => {
    const el = cg(l1, l2, c1);
    if (barEl) el.append(barEl);
    return el;
  };
  /** A bar at the cell's foot: length = share of the chain's largest (both sides), growing away from the strike. */
  const bar = (frac, cls) => {
    const el = h("span", { class: `vbar ${cls ?? ""}`.trim(), "aria-hidden": "true" }, h("span"));
    const f = Math.max(0, Math.min(1, frac || 0));
    // A non-zero value never draws under 2 % (the 2 px minimum mark); zero draws no fill at all.
    el.firstChild.style.transform = `scaleX(${f > 0 ? Math.max(0.02, r1(f * 100) / 100) : 0})`;
    return el;
  };
  // What this view draws (viewCfg: Simple turns the bars and extras off without touching the saved settings).
  let cfgFor = null;
  let cfgView = null;
  const cfg = () => (cfgFor === st.cfg ? cfgView : ((cfgFor = st.cfg), (cfgView = viewCfg(st.cfg))));
  const unit = (x) => (cfg().lots ? x.lot : 1);
  /** A bar length 0..1: a non-zero share never under 2 % (the 2 px minimum mark), zero no fill at all. */
  const barLen = (f) => (f > 0 ? Math.max(0.02, r1(Math.min(1, f) * 100) / 100) : 0);
  /**
   * A layered bar in line 2 (OI, volume): absolutely stacked fills on one track, back to front, every layer anchored
   * at the strike side. Each gets its length as `--f`; app.css draws solid layers with scaleX and striped ones with a
   * clip (stripes keep their pitch), so a refresh morphs the same nodes and the CSS transition resizes them.
   * `layers` = [[class, fraction], ...].
   */
  const layered = (cls, layers) => {
    const el = h("span", { class: `vbar split ${cls}`, "aria-hidden": "true" }, layers.map(([c]) => h("span", { class: c })));
    layers.forEach(([, f], i) => el.childNodes[i].style.setProperty("--f", String(barLen(f))));
    return el;
  };
  /** A quiet sub figure in a direction's ink (OI change, volume change): green when it rose, red when it fell. */
  const chgSub = (v) => sub(v === null ? "" : formatCompact(v, { signed: true }), v > 0 ? "up" : v < 0 ? "down" : "");
  /**
   * The build-up cell (bu, bu5, bu15) for one reading (chain-metrics.js dayBuildup / windowBuildup): one small tinted
   * capsule with the reading's name ("Long build-up"), green when the premium rose (LB, SC), red when it fell (SB, LU),
   * neutral for Neutral; new positions (LB, SB) a fuller tint than closing ones (SC, LU), deepening a little with the
   * reading's intensity. Its strength (|OI change| ÷ the largest on that side in that window) is a hairline at the
   * cell's foot; the OI change, its % and the premium move are in the title and the hover card. No reading: a dash
   * whose title names the cause; a window still warming up counts down instead.
   */
  const buCard = (rd, max, x, winLabel) => {
    if (!rd || rd.state !== "ok") {
      const why = M.BUILDUP_STATE_TEXT[rd?.state] ?? "";
      if (rd?.state === "warming" && isFigure(rd.waitMs)) return cg(h("span", { class: "muted", title: why }, `in ${waitText(rd.waitMs)}`));
      return cg(h("span", { class: "muted", title: why || undefined }, DASH));
    }
    const ticks = M.strengthTicks(rd.dOi, max) ?? 0;
    const code = rd.code === "NT" ? "CH" : rd.code;
    const tone = code === "LB" || code === "SC" ? "pos" : code === "SB" || code === "LU" ? "neg" : "";
    const title = `${M.BUILDUP_LABELS[rd.code]} ${winLabel}: premium ${formatSignedPercent(rd.pxPct, 2)} (${formatSigned(rd.dPx, 2)}), OI ${rd.isNew ? "new at this strike" : formatSignedPercent(rd.oiPct, 1)} (${formatCompact(rd.dOi / unit(x), { signed: true })}). ${rd.code === "NT" ? "One move is inside its floor, so neither side is named. " : ""}Premium up and OI up = Long build-up; down and up = Short build-up; up and down = Short covering; down and down = Long unwinding. The line under it = OI change as a share of the largest on this side (${formatInt(ticks)} of 10)`;
    const el = cgBar(h("span", { class: `bu-pill bu-${code}` }, M.BUILDUP_LABELS[rd.code]), null, bar(ticks / 10, `bu-m${tone ? ` ${tone}` : ""}`), "bu-l1");
    el.classList.add("bu-cell");
    el.title = title;
    el.style.setProperty("--bw", String(r1(M.buildupIntensity(rd, max) * 100) / 100));
    return el;
  };
  /** "2m 30s", "48s", "4m": a wait on the build-up windows. */
  const waitText = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m && s % 60 ? `${formatInt(m)}m ${formatInt(s % 60)}s` : m ? `${formatInt(m)}m` : `${formatInt(s)}s`;
  };
  /**
   * A Greek cell with its three dashes (chain-metrics.js greekState): a figure; a plain dash for exactly 0 (Delta
   * prints 0.00); a muted dash when the leg has no IV or Greek, its title saying why.
   */
  const greek = (key, q, v, dp) => {
    const s = M.greekState(key, v);
    if (s === "value") return g(v, dp);
    if (s === "zero") return cg(h("span", { title: "Exactly zero" }, DASH));
    return cg(h("span", { class: "muted", title: `Greek unavailable: ${CF.ivSourceText(q)}` }, DASH));
  };
  /** The window build-up columns' cell and dependencies (bu5 / bu15). */
  const buWinCol = (win, label) => ({
    v: (q, row, side, x) => {
      const rd = M.windowBuildup(q, x[`bu${win}`], row.strike, side);
      return [rd.state, rd.code, rd.dOi, rd.pxPct, isFigure(rd.waitMs) ? Math.ceil(rd.waitMs / 1000) : null, x[`bu${win}`]?.max?.[side], unit(x)];
    },
    r: (q, row, side, x) => buCard(M.windowBuildup(q, x[`bu${win}`], row.strike, side), x[`bu${win}`]?.max?.[side], x, `over the last ${label}`),
  });
  const R = (side) => (side === "ce" ? "CE" : "PE");
  const prem = (q) => O.mid(q);
  const picked = new Map();
  let selecting = false;
  const pickKey = (strike, side) => `${strike}|${side}`;
  const COLS = {
    bu: {
      label: "Build-up",
      short: "B-up",
      title: "Build-up since the previous close: the premium's move and the OI move read together. Both must clear a floor (OI 2 %, premium 0.5 %; 1 % and 0.5 % over a recorded window), else Neutral. Green = premium rose, red = premium fell. Meter = OI change as a share of the largest on this side; then the OI change and its % of OI",
      v: (q, row, side, x) => {
        const rd = M.dayBuildup(x.winQ(q, row, side), x.buWin);
        return [rd.state, rd.code, rd.dOi, rd.pxPct, x.maxChg[side], unit(x)];
      },
      r: (q, row, side, x) => buCard(M.dayBuildup(x.winQ(q, row, side), x.buWin), x.maxChg[side], x, x.winLabel ? `over the last ${x.winLabel}` : "since the previous close"),
    },
    oi: {
      label: "OI",
      title: "Open interest; under it, the change today (or over the OI window). Bar = share of the largest OI on the chain (both sides): solid = the previous OI, striped = OI added today, red striped ghost = OI cut today. Brightest = OI wall",
      v: (q, row, side, x) => [q?.oi, q?.oiChange, x.sm.maxOi, x.topOi[side].get(row.strike) ?? 0, heat(), cfg().bars.oi, unit(x)],
      r: (q, row, side, x) => {
        const rank = x.topOi[side].get(row.strike);
        const d = num(q?.oiChange);
        // Line 1 the OI, line 2 its change (green added, red cut), the bar a hairline at the cell's foot.
        const s = cfg().bars.oi && !heat() ? M.oiBarSplit(q?.oi, d, x.sm.maxOi) : null;
        const b = s ? layered(`oi ${side}${rank === 1 ? " r1" : rank ? " r2" : ""}${s.kind ? ` ${s.kind}` : ""}`, [[s.kind === "cut" ? "seg-cut" : "seg-add", s.outer], ["seg-solid", s.solid]]) : null;
        return cgBar(formatCompact(num(q?.oi) === null ? null : q.oi / unit(x)), chgSub(d === null ? null : d / unit(x)), b, rank === 1 ? "wall" : "");
      },
      heat: (q, row, side, x) => [side === "ce" ? "call" : "put", x.sm.maxOi ? (num(q?.oi) ?? 0) / x.sm.maxOi : 0],
    },
    chg: {
      label: "OI chg",
      title: "OI added (green) or cut (red). Bar = share of the largest change on the chain",
      v: (q, row, side, x) => [q?.oiChange, q?.oi, x.sm.maxOiChange, heat(), cfg().bars.chg, cfg().pct],
      r: (q, row, side, x) => {
        const v = num(q?.oiChange);
        const pct = O.oiChangePct(q);
        const text = h("span", { title: pct === null ? undefined : `${formatPercent(pct, 1)} of OI` }, formatCompact(v === null ? null : v / unit(x), { signed: true }));
        const ink = v > 0 ? "up" : v < 0 ? "down" : "";
        // Line 2 the % of OI (Percentage changes); with bars on, the bar is a hairline at the cell's foot.
        const b = cfg().bars.chg && !heat() ? bar(x.sm.maxOiChange ? Math.abs(v ?? 0) / x.sm.maxOiChange : 0, v < 0 ? "neg" : "pos") : null;
        return cgBar(text, cfg().pct ? sub(pct === null ? "" : formatPercent(pct, 1)) : null, b, ink);
      },
      heat: (q, row, side, x) => {
        const v = num(q?.oiChange) ?? 0;
        return [v < 0 ? "neg" : "pos", x.sm.maxOiChange ? Math.abs(v) / x.sm.maxOiChange : 0];
      },
    },
    vol: {
      label: "Volume",
      title: "Contracts traded today; under it, the change from the previous session's volume (when the data source sends it). Bar = share of the largest volume (both sides, both days): dark = today, light = the previous session; amber = unusual for its OI",
      v: (q, row, side, x) => [q?.volume, q?.prevVolume, x.hot.has(q?.symbol), x.maxVolAll, cfg().bars.vol, heat(), unit(x)],
      r: (q, row, side, x) => {
        const hot = x.hot.has(q?.symbol);
        const dv = M.volumeChange(q?.volume, q?.prevVolume);
        const main = h("span", { title: hot ? "Unusual: volume ÷ OI well above the rest of the chain" : undefined }, formatCompact(num(q?.volume) === null ? null : q.volume / unit(x)));
        const s = cfg().bars.vol && !heat() ? M.volBarSplit(q?.volume, q?.prevVolume, x.maxVolAll) : null;
        const b = s ? layered("vol", [["seg-prev", s.prev ?? 0], ["seg-today", s.today]]) : null;
        return cgBar(main, chgSub(dv === null ? null : dv / unit(x)), b, hot ? "hot" : "");
      },
    },
    iv: {
      label: "IV",
      title: "Implied volatility: the yearly volatility (%) at which Black-76 on the forward gives the option's price. Hover a dash for why there is none",
      v: (q) => [g(q?.iv, 1), q?.ivReason ?? "", q?.greeksSource ?? ""],
      r: (q) => (num(q?.iv) > 0 ? g(q.iv, 1) : cg(h("span", { class: "muted", title: CF.ivSourceText(q) }, DASH))),
    },
    ltp: {
      label: "LTP",
      ltp: true,
      v: (q, row, side, x) => [q?.ltp, q?.change, x.held.get(q?.symbol), selecting, picked.has(pickKey(row.strike, side)), isFigure(q?.tickAgeMs) ? Math.floor(q.tickAgeMs / 10_000) : null],
      r: (q, row, side, x) => {
        const pct = O.changePct(q);
        const held = x.held.get(q?.symbol);
        const on = picked.has(pickKey(row.strike, side));
        return cg(
          [
            selecting ? h("span", { class: `pick${on ? " on" : ""}`, role: "checkbox", "aria-checked": String(on), "aria-label": `Select ${formatInt(row.strike)} ${R(side)}` }) : null,
            held ? h("span", { class: `held ${held > 0 ? "long" : "short"}`, title: heldTitle(held), "aria-label": heldTitle(held) }, formatSigned(held, 0)) : null,
            h("strong", isFigure(q?.tickAgeMs) ? { class: "quiet-leg", title: `Last trade, ${ageText(q.tickAgeMs)}: no trade since on a live feed` } : {}, g(q?.ltp, 2)),
          ].filter(Boolean),
          cfg().pct ? sub(pct === null ? "" : formatSignedPercent(pct, 1), pct > 0 ? "up" : pct < 0 ? "down" : "") : null,
        );
      },
    },
    delta: {
      label: "Delta",
      title: "Delta. 16Δ / 30Δ mark the strikes nearest those deltas on each side",
      v: (q, row, side, x) => [g(q?.delta, 2), q?.ivReason ?? "", x.targets[side].get(row.strike) ?? ""],
      r: (q, row, side, x) => {
        const dt = x.targets[side].get(row.strike);
        if (M.greekState("delta", q?.delta) !== "value") return greek("delta", q, q?.delta, 2);
        // 16Δ / 30Δ: under the delta, in the ATM ink (the figure keeps its column's width).
        return cg(g(q?.delta, 2), dt ? h("small", { class: "l2 dt", title: `Nearest the ${dt} target on this side` }, dt) : null);
      },
    },
    gamma: { label: "Gamma", title: "Gamma: how much Delta changes for a 1-point move in the underlying (per unit)", v: (q) => [g(q?.gamma, 4), q?.ivReason ?? ""], r: (q) => greek("gamma", q, q?.gamma, 4) },
    theta: { label: "Theta", title: "Theta: rupees per unit the premium loses in one trading day from time alone, other things equal", v: (q) => [g(q?.theta, 1), q?.ivReason ?? ""], r: (q) => greek("theta", q, q?.theta, 1) },
    vega: { label: "Vega", title: "Vega: rupees per unit the premium changes for a 1-point change in IV", v: (q) => [g(q?.vega, 1), q?.ivReason ?? ""], r: (q) => greek("vega", q, q?.vega, 1) },
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
    // ── Added through Customise (chain-metrics.js). Missing inputs show a dash, never 0. ──
    ltpChg: {
      label: "LTP chg",
      title: "LTP change in rupees: last traded price minus the previous session's close",
      v: (q) => M.ltpChange(q),
      r: (q) => {
        const v = M.ltpChange(q);
        return cg(isFigure(v) ? formatSigned(v, 2) : DASH, null, v > 0 ? "up" : v < 0 ? "down" : "");
      },
    },
    prevClose: { label: "Prev close", title: "Previous close: the option's closing price in the last session", v: (q) => q?.close, r: (q) => g(M.quotePrice(q?.close), 2) },
    avgPx: { label: "Avg price", short: "ATP", title: "Average traded price today (volume-weighted, as the broker sends it). A dash when the data source does not send it", v: (q) => q?.avgPrice, r: (q) => g(M.quotePrice(q?.avgPrice), 2) },
    high: { label: "High", title: "Today's high: the highest premium this contract traded at today, never below the live LTP (max of the day high and LTP). A dash when the data source sends no day high", v: (q) => [q?.high, q?.ltp], r: (q) => g(M.dayHigh(q), 2) },
    low: { label: "Low", title: "Today's low: the lowest premium this contract traded at today, never above the live LTP (min of the day low and LTP). A dash when the data source sends no day low", v: (q) => [q?.low, q?.ltp], r: (q) => g(M.dayLow(q), 2) },
    prevVol: {
      label: "Prev vol",
      head: () => (cfg().lots ? "Prev vol (lots)" : "Prev vol"),
      title: "Previous volume: contracts traded in the last session. A dash when the data source does not send it",
      v: (q, row, side, x) => [q?.prevVolume, unit(x)],
      r: (q, row, side, x) => formatCompact(num(q?.prevVolume) === null ? null : q.prevVolume / unit(x)),
    },
    volOi: { label: "Vol/OI", title: "Volume ÷ open interest: today's volume as a multiple of the open position (both in contracts)", v: (q) => [q?.volume, q?.oi], r: (q) => g(M.volumeOiRatio(q), 2) },
    bidPx: { label: "Bid", title: "Bid: the highest price bid for the contract right now", v: (q) => q?.bid, r: (q) => cg(g(M.quotePrice(q?.bid), 2), null, "bid-ink") },
    askPx: { label: "Ask", title: "Ask: the lowest price offered for the contract right now", v: (q) => q?.ask, r: (q) => cg(g(M.quotePrice(q?.ask), 2), null, "ask-ink") },
    bidQty: {
      label: "Bid qty",
      head: () => (cfg().lots ? "Bid qty (lots)" : "Bid qty"),
      title: "Quantity waiting at the top bid. A dash when the data source does not send it",
      v: (q, row, side, x) => [q?.bidQty, unit(x)],
      r: (q, row, side, x) => cg(formatCompact(M.quoteQty(q?.bidQty) === null ? null : q.bidQty / unit(x)), null, "bid-ink"),
    },
    askQty: {
      label: "Ask qty",
      head: () => (cfg().lots ? "Ask qty (lots)" : "Ask qty"),
      title: "Quantity waiting at the top ask. A dash when the data source does not send it",
      v: (q, row, side, x) => [q?.askQty, unit(x)],
      r: (q, row, side, x) => cg(formatCompact(M.quoteQty(q?.askQty) === null ? null : q.askQty / unit(x)), null, "ask-ink"),
    },
    rho: {
      label: "Rho",
      title: "Rho (Black-76, the forward held fixed): change in the option's price for a 1 percentage-point rise in the interest rate, = −(calendar years to expiry) × price ÷ 100, at the leg's IV",
      v: (q, row, side, x) => [q?.iv, Math.round(x.F ?? 0), x.tcal],
      r: (q, row, side, x) => greek("rho", q, M.rho76(x.F, row.strike, x.years, q?.iv, R(side), x.tcal, x.df), 3),
    },
    bu5: {
      label: "B-up 5m",
      title: "Build-up over the last 5 minutes: premium and OI now against the snapshot this page recorded nearest 5 minutes ago (within 90 s; never a wider window). Floors: OI 1 %, premium 0.5 %, else Neutral. A dash names its cause on hover; a window still recording counts down",
      ...buWinCol("5", "5 min"),
    },
    bu15: {
      label: "B-up 15m",
      title: "Build-up over the last 15 minutes: premium and OI now against the snapshot this page recorded nearest 15 minutes ago (within 2 min 30 s; never a wider window). Floors: OI 1 %, premium 0.5 %, else Neutral. A dash names its cause on hover; a window still recording counts down",
      ...buWinCol("15", "15 min"),
    },
    intrinsic: {
      label: "Intrinsic",
      short: "Intr",
      title: "Intrinsic value: the part of the premium already in the money against spot. Call max(0, spot − strike), put max(0, strike − spot); 0.00 out of the money",
      v: (q, row, side, x) => Math.round((x.spot ?? 0) * 100),
      r: (q, row, side, x) => g(M.intrinsicValue(row.strike, R(side), x.spot), 2),
    },
    bePct: {
      label: "BE %",
      title: "Breakeven % from spot: (breakeven − spot) ÷ spot × 100, breakeven = call strike + premium, put strike − premium (premium = mid)",
      v: (q, row, side, x) => [prem(q), Math.round(x.spot ?? 0)],
      r: (q, row, side, x) => {
        const v = M.breakevenPct(row.strike, R(side), prem(q), x.spot);
        return cg(pct1(v), null, v > 0 ? "up" : v < 0 ? "down" : "");
      },
    },
    spreadAbs: { label: "Spread ₹", short: "Sprd ₹", title: "Bid-ask spread in rupees: ask − bid, what crossing the book costs per unit. With no bid it is the whole ask; a dash when the ask is not above the bid (locked or crossed quote) or there is no ask", v: (q) => [q?.bid, q?.ask], r: (q) => g(M.spreadAbs(q), 2) },
    theo: {
      label: "Theo",
      title: "Theoretical price: Black-76 on the chain's forward at the chain's ATM IV for every strike (not this option's own IV), discounted. Mid minus this is what the IV smile adds or takes away",
      v: (q, row, side, x) => [Math.round((x.F ?? 0) * 10), x.sm.atmIv, x.years],
      r: (q, row, side, x) => {
        const t = M.theoPrice(x.F, row.strike, x.years, x.sm.atmIv, R(side), x.df);
        return t === null ? cg(h("span", { class: "muted", title: "No theoretical price: the chain has no ATM IV or no forward (never priced on a guessed volatility)" }, DASH)) : g(t, 2);
      },
    },
    relDist: {
      label: "Rel dist",
      title: "Relative distance: (strike − spot) ÷ spot × 100, negative below spot. Under it, the same distance in standard deviations to expiry at ATM IV (out of the money positive)",
      v: (q, row, side, x) => [Math.round((x.spot ?? 0) * 100), Math.round(x.F ?? 0), x.sm.atmIv, x.years],
      r: (q, row, side, x) => {
        const d = M.relativeDistance(row.strike, x.spot);
        const sd = M.sigmaDist(row.strike, R(side), x.F, x.sm.atmIv, x.years);
        return two(isFigure(d) ? `${formatSigned(d, 2)}%` : DASH, { text: isFigure(sd) ? `${formatSigned(sd, 2)}σ` : "", force: true });
      },
    },
    bidPct: { label: "Bid %", title: "Bid as % of spot: bid ÷ spot × 100, the premium a writer collects per rupee of the underlying", v: (q, row, side, x) => [q?.bid, Math.round((x.spot ?? 0) * 100)], r: (q, row, side, x) => cg(formatPercent(M.pctOfSpot(q?.bid, x.spot), 2), null, "bid-ink") },
    askPct: { label: "Ask %", title: "Ask as % of spot: ask ÷ spot × 100, the premium a holder pays per rupee of the underlying", v: (q, row, side, x) => [q?.ask, Math.round((x.spot ?? 0) * 100)], r: (q, row, side, x) => cg(formatPercent(M.pctOfSpot(q?.ask, x.spot), 2), null, "ask-ink") },
    bidPctAnn: {
      label: "Bid % ann.",
      title: "Bid % annualised: Bid % × 365 ÷ days to expiry (whole calendar days, at least 1; simple, not compounded)",
      v: (q, row, side, x) => [q?.bid, x.tcal, Math.round((x.spot ?? 0) * 100)],
      r: (q, row, side, x) => cg(formatPercent(M.annualisedPct(M.pctOfSpot(q?.bid, x.spot), x.tcal), 1), null, "bid-ink"),
    },
    askPctAnn: {
      label: "Ask % ann.",
      title: "Ask % annualised: Ask % × 365 ÷ days to expiry (whole calendar days, at least 1; simple, not compounded)",
      v: (q, row, side, x) => [q?.ask, x.tcal, Math.round((x.spot ?? 0) * 100)],
      r: (q, row, side, x) => cg(formatPercent(M.annualisedPct(M.pctOfSpot(q?.ask, x.spot), x.tcal), 1), null, "ask-ink"),
    },
    // The straddle table (Customise → View → Straddle, Advanced): one row per strike, the call and its put added
    // together, in a fixed set of columns. A table mode, not columns of the chain (straddleRow does the sums).
    sdPrice: { label: "Price", row: true, title: "Call LTP + put LTP", v: (row) => straddleRow(row).ltp, r: (row) => cg(h("strong", {}, g(straddleRow(row).ltp, 2))) },
    sdChg: {
      label: "Change",
      row: true,
      title: "Price minus the two previous closes added; under it, as a % of them",
      v: (row) => { const s = straddleRow(row); return [s.change, s.changePct, cfg().pct]; },
      r: (row) => {
        const s = straddleRow(row);
        const ink = s.change > 0 ? "up" : s.change < 0 ? "down" : "";
        return cg(isFigure(s.change) ? formatSigned(s.change, 2) : DASH, cfg().pct ? sub(s.changePct === null ? "" : formatSignedPercent(s.changePct, 2), ink) : null, ink);
      },
    },
    sdCe: { label: "Call LTP", short: "Call", row: true, title: "The call leg's own last price", v: (row) => row.ce?.ltp, r: (row) => cg(g(row.ce?.ltp, 2), null, "call-ink") },
    sdPe: { label: "Put LTP", short: "Put", row: true, title: "The put leg's own last price", v: (row) => row.pe?.ltp, r: (row) => cg(g(row.pe?.ltp, 2), null, "put-ink") },
    sdOi: {
      label: "Open interest",
      short: "OI",
      row: true,
      title: "Call OI + put OI; under it, the change today. Bar = share of the largest on the chain: solid = the previous OI, striped = OI added today, red striped ghost = OI cut today",
      v: (row, r_, s_, x) => { const s = straddleRow(row); return [s.oi, s.oiChange, sdMax(x).oi, heat(), cfg().bars.oi, cfg().lots]; },
      r: (row, r_, s_, x) => {
        // The chain's OI cell (a figure pair over a layered bar), fed the two legs added together.
        const s = straddleRow(row);
        const d = s.oiChange;
        const sp = cfg().bars.oi && !heat() ? M.oiBarSplit(s.oi, d, sdMax(x).oi) : null;
        const b = sp ? layered(`oi sd${sp.kind ? ` ${sp.kind}` : ""}`, [[sp.kind === "cut" ? "seg-cut" : "seg-add", sp.outer], ["seg-solid", sp.solid]]) : null;
        return cgBar(formatCompact(s.oi === null ? null : s.oi / unit(x)), chgSub(d === null ? null : d / unit(x)), b);
      },
    },
    sdVol: { label: "Volume", short: "Vol", row: true, title: "Call volume + put volume today", v: (row, r_, s_, x) => [straddleRow(row).volume, cfg().lots], r: (row, r_, s_, x) => { const v = straddleRow(row).volume; return formatCompact(v === null ? null : v / unit(x)); } },
    sdUbe: { label: "Upper BE", short: "Up BE", row: true, title: "Upper breakeven at expiry: strike + Price", v: (row) => straddleRow(row).be?.[1], r: (row) => { const b = straddleRow(row).be; return b ? formatFixed(b[1], 2) : DASH; } },
    sdLbe: { label: "Lower BE", short: "Low BE", row: true, title: "Lower breakeven at expiry: strike − Price", v: (row) => straddleRow(row).be?.[0], r: (row) => { const b = straddleRow(row).be; return b ? formatFixed(b[0], 2) : DASH; } },
    sdPrev: { label: "Prev close", short: "Prev", row: true, title: "The two previous closes added", v: (row) => straddleRow(row).prev, r: (row) => g(straddleRow(row).prev, 2) },
    sdIv: { label: "Avg IV", short: "IV", row: true, title: "The mean of the call and put IV", v: (row) => straddleRow(row).iv, r: (row) => g(straddleRow(row).iv, 2) },
    sdBu: {
      label: "Analysis",
      short: "Build",
      row: true,
      title: "The chain's build-up card fed the combined premium (call + put against the two previous closes) and the combined OI change. Meter = the OI change as a share of the largest on the chain",
      v: (row, r_, s_, x) => {
        const rd = M.dayBuildup(sdLeg(row));
        return [rd.state, rd.code, rd.dOi, rd.pxPct, sdMax(x).chg, unit(x)];
      },
      r: (row, r_, s_, x) => buCard(M.dayBuildup(sdLeg(row)), sdMax(x).chg, x, "since the previous close"),
    },
    bid: { label: "Bid", trade: "SELL", title: "Bid: you sell here" },
    ask: { label: "Ask", trade: "BUY", title: "Ask: you buy here. Under it, the spread when it is wide (amber over 5%, red over 10%)" },
  };
  for (const [k, , scope] of CHAIN_COLUMNS) if (scope === "row") COLS[k].row = true;
  /** The straddle table's columns, from the strike outwards (the last ones drop first on a narrow panel). */
  const STRADDLE_COLS = ["sdPrice", "sdChg", "sdCe", "sdPe", "sdOi", "sdVol", "sdUbe", "sdLbe", "sdPrev", "sdIv", "sdBu"];
  /** A strike's straddle as one leg for the build-up rule (chain-metrics.js dayBuildup): price, close, OI and its change. */
  const sdLeg = (row) => {
    const s = straddleRow(row);
    return { ltp: s.ltp, close: s.prev, oi: s.oi, oiChange: s.oiChange };
  };
  /** The straddle table's bar scales, once per chain read. */
  const sdScale = new WeakMap();
  const sdMax = (x) => {
    let m = sdScale.get(x.c);
    if (!m) {
      m = { oi: 0, chg: 0 };
      for (const r of x.c.rows) {
        const s = straddleRow(r);
        m.oi = Math.max(m.oi, s.oi ?? 0);
        m.chg = Math.max(m.chg, Math.abs(s.oiChange ?? 0));
      }
      sdScale.set(x.c, m);
    }
    return m;
  };

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
    // Show all Greeks and Pin LTP (effectiveCols): what this layout draws; the saved list is unchanged.
    const cols = effectiveCols(c, (k) => Boolean(COLS[k]));
    let sideCols = cols.filter((k) => !COLS[k].row);
    let rowCols = cols.filter((k) => COLS[k].row);
    let side = d.phone ? c.phoneSide : c.side;
    let quotes = c.quotes && !d.phone && !d.coarse;
    let cap = Infinity;
    if (c.straddle) {
      // One row per strike: the strike, then the straddle's own cells.
      sideCols = [];
      rowCols = STRADDLE_COLS;
      side = "straddle";
      quotes = false;
    } else if (d.phone) {
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
    const sides = side === "both" ? 2 : side === "none" || side === "straddle" ? 0 : 1;
    // A new context (columns, side, strikes window, chain, device, density): measure afresh, no extra drops.
    const fk = JSON.stringify([st.chain?.underlying, st.chain?.expiry, cols, side, quotes, st.strikesView, c.oiWin, c.dense, c.lots, c.pct, d.phone, d.narrow, d.coarse, typeof document === "undefined" ? "" : document.documentElement.dataset.density]);
    if (fk !== fitKey) {
      fitKey = fk;
      measured = {};
      measuredStrike = 0;
      extraDrop = 0;
    }
    const est = d.phone ? PHONE_MIN : d.coarse ? COL_MIN_COARSE : COL_MIN;
    const widths = { ...est, ...measured };
    const strikeW = measuredStrike || (d.phone ? 68 : STRIKE_W);
    const order = c.straddle ? [...STRADDLE_COLS].reverse().slice(0, -1) : dropOrder(preset, cols);
    const fit = fitColumns({ side: sideCols, mid: rowCols, quotes, sides, avail: availW() - sbW, widths, strikeW, order, cap, extra: extraDrop });
    const all = new Set([...(c.straddle ? STRADDLE_COLS : cols), ...(quotes && sides ? ["quotes"] : [])]);
    // Phones: columns the layout leaves out before fitting (Both = LTP and OI only; Parity = three row columns)
    // count as hidden too, so "+N hidden" and Customise tell the truth.
    const kept = new Set([...sideCols, ...rowCols]);
    const pre = d.phone && !c.straddle ? cols.filter((k) => !kept.has(k)) : [];
    const hidden = [...new Set([...pre, ...fit.hidden])].filter((k) => all.has(k));
    // Wide screens (layout-prefs.js wideExtras): with every chosen column on screen and room to spare, a preset adds
    // its extra columns (Greeks for OI, and so on) next to IV. Never on touch or phones, never for a custom list, and
    // not while the table's own overflow check is dropping columns.
    const extras = !d.phone && !d.coarse && c.wide && !hidden.length && !extraDrop && sides ? wideExtras({ preset, cols: c.cols, slack: availW() - sbW - fit.width, sides, widths, used: fit.width }).filter((k) => COLS[k] && !COLS[k].row && !cols.includes(k)) : [];
    lastFit = { hidden, kept: all.size - hidden.length, total: all.size, added: extras };
    const at = Math.max(fit.side.indexOf("iv"), fit.side.indexOf("ltp")) + 1;
    const sideCols2 = extras.length ? [...fit.side.slice(0, at), ...extras, ...fit.side.slice(at)] : fit.side;
    const near = fit.quotes ? ["bid", "ask"] : [];
    // Pin LTP: LTP stays next to the strike, Bid / Ask after it.
    const pin = c.pinLtp && sideCols2[0] === "ltp";
    const out = pin ? ["ltp", ...near, ...sideCols2.slice(1)] : [...near, ...sideCols2];
    const base = { side, mid: fit.mid, phone: d.phone, narrow: d.narrow, coarse: d.coarse, hidden };
    if (side === "none" || side === "straddle") return { ...base, order: ["strike", "mid"], ce: [], pe: [] };
    if (side === "ce") return { ...base, order: ["strike", "mid", "ce"], ce: out, pe: [] };
    if (side === "pe") return { ...base, order: ["strike", "mid", "pe"], ce: [], pe: out };
    // Calls mirror puts around the strike, but Bid / Ask keep their reading order on both sides.
    const ce = pin ? [...sideCols2.slice(1)].reverse().concat(near, ["ltp"]) : [...sideCols2].reverse().concat(near);
    return { ...base, order: ["ce", "strike", "mid", "pe"], ce, pe: out };
  };
  const layoutSig = (L) => JSON.stringify([L.side, L.order, L.ce, L.pe, L.mid, L.phone, L.narrow, L.coarse, cfg().dense, cfg().lots, cfg().pct, cfg().bars, cfg().barStyle, cfg().tags, cfg().itm, cfg().positions, cfg().contracts]);

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
      if (!onHold || e.pointerType === "mouse" || !device().coarse || selecting || L.side === "none" || L.side === "straddle" || e.target.closest("button")) return;
      const side = sideOf(e);
      // Holding the strike itself opens "Build around this strike"; holding a call or put cell adds a buy leg.
      const onStrike = Boolean(onStrikeMenu) && Boolean(e.target.closest("th.strike-col"));
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
        if (onStrike) onStrikeMenu(strike, th);
        else onHold(strike, side);
      }, 500);
      hold = h0;
    });
    tr.addEventListener("pointermove", (e) => {
      if (hold && !hold.fired && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 8) dropHold();
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) tr.addEventListener(ev, dropHold);
    tr.addEventListener("contextmenu", (e) => {
      if (hold?.fired) return e.preventDefault();
      // Right-click a strike: build a strategy around it (selection mode keeps the browser's menu).
      if (!onStrikeMenu || selecting) return;
      e.preventDefault();
      onStrikeMenu(strike, th);
    });
    tr.addEventListener("click", (e) => {
      if (hold?.fired) {
        hold = null;
        return;
      }
      if (e.target.closest("button")) return;
      const side = sideOf(e);
      if (selecting && L.side !== "none" && L.side !== "straddle") {
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
      h("button", { type: "button", class: "side-btn", title: c.side === side ? "Show calls and puts" : `Show ${label.toLowerCase()} only (${side === "ce" ? "C" : "V"})`, "aria-pressed": String(c.side === side), onclick: () => onSide(c.side === side ? "both" : side) }, label);
    const onlyBtn = (text) => h("button", { type: "button", class: "side-btn on", title: "Show calls and puts", "aria-label": `${text} only: show calls and puts`, onclick: () => onSide("both") }, text, h("span", { class: "side-x", "aria-hidden": "true" }, "×"));
    // One header row (no CALLS / PUTS row above the titles): the side names ride in the outermost title cells, Calls at
    // the far left and Puts at the far right (a click shows that side only); a one-side or straddle view names itself
    // at its far end, with × back to both. Phones name the side in the Strike title (a CE / PE chip).
    const edge = L.phone
      ? null
      : L.side === "both"
        ? { first: sideBtn("ce", "Calls"), last: sideBtn("pe", "Puts") }
        : { first: null, last: onlyBtn(L.side === "straddle" ? "Straddle" : L.side === "ce" ? "Calls" : L.side === "pe" ? "Puts" : "Parity") };
    // The chain's tools sit in the app toolbar beside the page's capsule (desktop and tablet), or in the head row above
    // the table on a phone.
    if (tools) {
      if (!L.phone && toolSlot) toolSlot.append(tools);
      else if (headRow) headRow.append(tools);
      onToolsPlaced?.();
    }
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
    // The side names share the outermost title cells: name at the outer edge, the title at the cell's own alignment.
    const withEdge = (th, btn, outer) => {
      if (!btn || !th || th.classList.contains("strike-col")) return;
      th.classList.add(`th-edge-${outer}`);
      th.replaceChildren(h("span", { class: "th-edge" }, outer === "l" ? [btn, h("span", { class: "th-t" }, ...th.childNodes)] : [h("span", { class: "th-t" }, ...th.childNodes), btn]));
    };
    withEdge(colHead[0], edge?.first, "l");
    withEdge(colHead[colHead.length - 1], edge?.last, "r");
    const thead = h("thead", {}, h("tr", { class: `col-head first${L.phone && (L.side === "ce" || L.side === "pe") ? ` edge-${L.side}` : ""}` }, colHead));
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
  function patchCell(td, k, q, row, side, x, flashes, snap = false) {
    const col = COLS[k];
    if (col.trade) {
      const price = col.trade === "BUY" ? q?.ask : q?.bid;
      const sig = `${price}|${col.trade === "BUY" ? q?.bid : ""}|${st.account ? 1 : 0}`;
      if (td.__sig === sig) return;
      td.__sig = sig;
      setCell(td, tradeButton(q, row, side, col.trade), snap);
      return;
    }
    const v = col.row ? col.v(row, row, side, x) : col.v(q, row, side, x);
    const sig = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    if (td.__sig === sig) return;
    td.__sig = sig;
    setCell(td, col.row ? col.r(row, row, side, x) : q ? col.r(q, row, side, x) : DASH, snap);
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
  function setCell(td, content, snap = false) {
    const node = typeof content === "string" || typeof content === "number" ? cg(String(content)) : content;
    const f = td.firstChild;
    if (!(f && f === td.lastChild && morph(f, node, snap))) td.replaceChildren(node);
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
  /** The rows on screen: Customise → Strikes each side of ATM, exactly (the stepper's 3 … 40 or All). */
  // The density the table was last drawn with: a switch redraws at once (onWinResize), not on the next refresh.
  let drawnDensity = null;
  const densityNow = () => (typeof document === "undefined" ? "" : document.documentElement.dataset.density ?? "");
  const visibleSet = (x) => {
    drawnDensity = densityNow();
    return new Set(O.rowsAroundAtm(x.c, st.strikesView === "all" ? Infinity : Number(st.strikesView) || 10).map((r) => r.strike));
  };

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
    const { sm } = x;
    const flashes = [];
    const motion = !reducedMotion();
    // The ±N window: rows are hidden, never rebuilt, and the view stays put through an anchor row. Rows that come
    // into the window fade in (staggered 8 ms, 120 ms at most).
    const vis = visibleSet(x);
    let moved = false;
    /** rows that just came into the window: drawn now, never left blank for a frame */
    const fresh = new Set();
    for (const [strike, b] of built.rows) if (b.tr.hidden === vis.has(strike)) moved = true;
    if (moved) {
      const a = captureAnchor();
      let n = 0;
      for (const [strike, b] of built.rows) {
        const show = vis.has(strike);
        if (b.tr.hidden && show) fresh.add(strike);
        if (b.tr.hidden && show && !built.first && motion) {
          b.tr.classList.add("row-in");
          b.tr.style.setProperty("--i", String(Math.min(15, n++)));
          setTimeout(() => b.tr.classList.remove("row-in"), 420);
        }
        b.tr.hidden = !show;
      }
      restoreAnchor(a);
    }
    // A new table draws every row now. A refresh patches the rows nearest the focus (or spot) in this task and the
    // rest on the next frames, a few milliseconds of work each (drainRows): one task for every row and the chain-wide
    // figures was the refresh's long task.
    if (built.first) {
      later.clear();
      for (const row of x.c.rows) patchRow(row, x, flashes, motion);
    } else {
      const want = [];
      for (const row of x.c.rows) {
        const b = built.rows.get(row.strike);
        if (!b || b.tr.hidden) continue;
        if (fresh.has(row.strike)) {
          later.delete(row.strike);
          patchRow(row, x, flashes, motion);
        } else want.push([row.strike, FULL]);
      }
      runRows(want, x, flashes, motion);
    }
    for (const [th, k] of built.heads) {
      const t = headText(k, x);
      const lbl = th.querySelector(".lbl-long") ?? th.querySelector(".th-t") ?? th;
      if (lbl.textContent !== t) lbl.textContent = t;
    }
    drawSpot(x);
    patchFoot(x, vis);
    watchAtm(sm.atm);
    drawPicks(x);
    built.first = false;
    flushFlashes(flashes);
  }

  /** One frame's flashes, in one frame: the shared dv-flash keyframes (calmer in the chain: 0.14 alpha, 600 ms),
   *  restarted by alternating data-flash a / b instead of a forced reflow. */
  function flushFlashes(flashes) {
    if (!flashes.length) return;
    requestAnimationFrame(() => {
      for (const [td, up] of flashes) flashValue(td, up ? "up" : "down");
    });
  }

  // ── Work split across frames ──
  // A tick or a refresh patches rows in order of distance from the focused strike (else spot) until FRAME_BUDGET_MS of
  // work is done; the rows left wait in `later` for the next frame, merged with whatever comes meanwhile (a row waiting
  // for a full patch and also ticked stays a full patch). A waiting row is patched against the newest data (lastX).
  const FULL = "full";
  const later = new Map();
  let laterFrame = 0;
  const rowPriority = (x) => {
    const at = st.focus?.strike ?? x.spot ?? x.sm.atm ?? 0;
    return (strike) => Math.abs(strike - at);
  };
  function runRows(items, x, flashes, motion = !reducedMotion()) {
    for (const [strike, what] of items) mergeLater(strike, what);
    drainRows(x, flashes, motion);
  }
  function mergeLater(strike, what) {
    const had = later.get(strike);
    if (had === FULL || what === FULL) later.set(strike, FULL);
    else if (had) for (const s of what) had.add(s);
    else later.set(strike, new Set(what));
  }
  function drainRows(x, flashes, motion) {
    if (!later.size) return;
    const pri = rowPriority(x);
    const order = [...later.keys()].sort((a, b) => pri(a) - pri(b));
    const rowAt = new Map(x.c.rows.map((r) => [r.strike, r]));
    const t0 = performance.now();
    let n = 0;
    for (const strike of order) {
      // At least two rows a frame, then as many as fit the budget.
      if (n >= 2 && performance.now() - t0 > FRAME_BUDGET_MS) break;
      const what = later.get(strike);
      later.delete(strike);
      const b = built?.rows.get(strike);
      const row = rowAt.get(strike);
      // Rows outside the window are patched when they come back into it.
      if (!b || b.tr.hidden || !row) continue;
      if (what === FULL) patchRow(row, x, flashes, motion);
      else patchRowLegs(row, what, x, flashes);
      n += 1;
    }
    if (later.size && !laterFrame) {
      laterFrame = requestAnimationFrame(() => {
        laterFrame = 0;
        const x1 = lastX;
        if (!built || !x1 || !host.contains(built.wrap) || built.key !== [x1.c.underlying, x1.c.expiry, built.sig].join("|")) return later.clear();
        const fl = [];
        drainRows(x1, fl, !reducedMotion());
        flushFlashes(fl);
      });
    }
  }
  function dropLater() {
    later.clear();
    if (laterFrame) cancelAnimationFrame(laterFrame);
    laterFrame = 0;
  }
  /** The cells of the legs that ticked (`sides`), and the parity cells of their strike. */
  function patchRowLegs(row, sides, x, flashes) {
    const b = built.rows.get(row.strike);
    const L = built.L;
    for (const side of sides) {
      const cells = b[side];
      if (!cells?.length) continue;
      const q = row[side];
      L[side].forEach((k, i) => patchCell(cells[i], k, q, row, side, x, flashes, true));
    }
    if (L.mid.length) {
      x.syn.set(row.strike, O.synthetic(row, x.growth));
      x.edge.set(row.strike, O.parityEdge(row, x.edgeRef, x.growth));
      L.mid.forEach((k, i) => patchCell(b.mid[i], k, null, row, "mid", x, flashes, true));
    }
  }
  /** Every cell, the tags and the row classes of one strike. */
  function patchRow(row, x, flashes, motion) {
    const { sm, spot } = x;
    const c = cfg();
    const L = built.L;
    const b = built.rows.get(row.strike);
    if (!b || b.tr.hidden) return;
    for (const side of ["ce", "pe"]) {
      const cells = b[side];
      if (!cells.length) continue;
      const q = row[side];
      // Customise → Contracts (ITM / OTM) blanks the other contracts' cells; rows stay (the ladder and the spot line
      // keep their places) and the ATM row keeps both legs.
      const out = row.strike !== sm.atm && !contractShown(row.strike, side, spot, c.contracts);
      const itm = c.itm && !out && O.inTheMoney(row.strike, side, spot);
      L[side].forEach((k, i) => {
        const td = cells[i];
        patchCell(td, k, q, row, side, x, flashes);
        if (td.__itm !== itm) td.classList.toggle("itm", (td.__itm = itm));
        if (td.__out !== out) td.classList.toggle("cx-out", (td.__out = out));
      });
    }
    L.mid.forEach((k, i) => patchCell(b.mid[i], k, null, row, "mid", x, flashes));
    const tags = tagsFor(row, x);
    // At most two tags in a cell (one, in short form, on a phone's narrow strike column); the rest are in its title.
    const shown = strikeTagsShown(tags, L.phone);
    const sig = `${row.strike}|${shown.map((t) => t[1]).join(",")}|${tags.length}`;
    if (b.th.__sig !== sig) {
      const before = new Set((b.th.__tags ?? "").split(",").filter(Boolean));
      const pop = !built.first && motion && b.th.__sig !== undefined;
      b.th.__sig = sig;
      b.th.__tags = shown.map((t) => t[1]).join(",");
      b.th.title = tags.length > 1 ? tags.map((t) => t[1]).join(" · ") : "";
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
    // Strikes beyond the ±1σ move read a little quieter (the money is near spot); the band itself is a tag setting.
    const far = x.em1.lo !== null && x.em1.hi !== null && (row.strike < x.em1.lo || row.strike > x.em1.hi);
    if (b.__far !== far) b.tr.classList.toggle("far", (b.__far = far));
  }
  /** The totals row: totals over the strikes loaded; PCR under the strikes; the median deviation under Dev. */
  function patchFoot(x, vis) {
    const { sm } = x;
    const L = built.L;
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
    // Row columns: the median deviation under Dev; the straddle table's OI and OI change totals.
    const both = (a, b) => (isFigure(a) && isFigure(b) ? (a + b) / u : null);
    L.mid.forEach((k, j) => {
      const sd = k === "sdOi" ? both(sm.ceOi, sm.peOi) : k === "sdVol" ? both(sm.ceVolume, sm.peVolume) : null;
      const t = k === "dev" && x.medianDev !== null ? `Median dev ${formatSigned(x.medianDev, 1)}` : sd !== null ? formatCompact(sd) : "";
      if (built.foot.mid[j].textContent !== t) built.foot.mid[j].textContent = t;
    });
    const pcrSig = `${sm.pcr}|${x.c.rows.length}`;
    if (built.foot.th.__sig !== pcrSig) {
      built.foot.th.__sig = pcrSig;
      built.foot.th.replaceChildren(h("span", { class: "foot-total" }, "Total"), h("span", { class: "foot-pcr" }, h("small", {}, "PCR "), formatFixed(sm.pcr, 2)));
      built.foot.th.title = `Put OI ÷ call OI over the ${formatInt(x.c.rows.length)} strikes loaded (±${FETCH_STRIKES} around ATM)`;
    }
    const cap = `${x.c.underlying} ${expiryText(x.c.expiry)} option chain, ${formatInt(vis.size)} strikes, ${L.side === "both" ? "calls left, puts right" : L.side === "ce" ? "calls" : L.side === "pe" ? "puts" : L.side === "straddle" ? "straddles (call + put)" : "put-call parity"}`;
    if (built.caption.textContent !== cap) built.caption.textContent = cap;
  }

  /**
   * The market line between the strikes (Customise → Market line): spot, or the same-expiry future (the chain's
   * forward when none is listed), with the day's change, then the chips switched on (ATM straddle, expected move, ATM
   * IV, day range, PCR, max pain, walls). It sits where its price falls among the strikes.
   */
  function drawSpot(x) {
    const c = cfg();
    const futLtp = x.sameFut ? num(x.sameFut.ltp) : null;
    const fwd = futLtp ?? x.F ?? null;
    const futLine = c.priceLine === "fut" && fwd !== null;
    const price = futLine ? fwd : x.spot;
    if (price === null) return built.spotTr.remove();
    const q = x.indexQuote;
    const chp = num(q?.changePct);
    const chips = lineChips(x, c.line);
    const sig = JSON.stringify([x.spot, chp, num(q?.change), futLtp, x.sameFutChange, x.F, futLine, chips]);
    if (built.spotTag.__sig !== sig) {
      built.spotTag.__sig = sig;
      const fk = futLtp !== null ? "Fut" : "F";
      // The move: points and % against the previous close (spot); with the future, the future's own change when it is
      // known, else its premium over spot. Gain or loss colour.
      const ch = num(q?.change);
      const futCh = num(x.sameFutChange);
      const mv = futLine ? (futCh !== null ? futCh : x.spot !== null ? fwd - x.spot : null) : ch;
      const ink = mv > 0 ? "up" : mv < 0 ? "down" : "";
      const move = mv === null ? null : h("span", { class: `sp-chg ${ink}`.trim() }, `${formatSigned(mv, 2)}${!futLine && chp !== null ? ` (${formatSigned(chp, 2)}%)` : ""}`);
      /** The day's range: a short track, filled from the low up to the price. */
      const gauge = (f) => {
        const i = h("i");
        i.style.transform = `scaleX(${r1(f * 100) / 100})`;
        return h("span", { class: "sp-gauge", "aria-hidden": "true" }, i);
      };
      const part = ([k, label, value, , , fill]) =>
        h(
          "span",
          { class: `sp-chip${k === "straddle" || k === "em" || k === "pcr" || k === "mp" || k === "walls" ? " wide" : ""}`, "data-chip": k },
          h("span", { class: "sp-k" }, label),
          typeof value === "string" ? value : value.map((p) => (typeof p === "string" ? p : h("span", { class: p[1] }, p[0]))),
          isFigure(fill) ? gauge(fill) : null,
        );
      // The price prints no caption: Spot or Futures is the Customise choice (the future is named on a wide screen).
      built.spotTag.replaceChildren(
        ...[
          ...chips.filter((c) => c[4] === "pre").map(part),
          futLine ? h("span", { class: "wide sp-u" }, `${fk} `) : null,
          h("strong", {}, formatFixed(price, 2)),
          move,
          ...chips.filter((c) => c[4] === "post").map(part),
        ].filter(Boolean),
      );
    }
    let anchor = null;
    for (const row of x.c.rows) {
      if (row.strike <= price) continue;
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
  pickSide.classList.add("side-seg");
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
    if (Math.abs(dx) < 56 || Math.abs(dx) <= 2 * Math.abs(dy) || built.L.side === "both" || built.L.side === "none" || built.L.side === "straddle") return;
    onPhoneSide(dx < 0 ? "pe" : "ce");
  }, { passive: true });
  const drawPhoneBar = (L) => {
    const arb = L.side === "none";
    if (phoneSeg.value !== cfg().phoneSide) phoneSeg.value = cfg().phoneSide;
    for (const b of phoneSeg.querySelectorAll("button")) b.disabled = arb;
    // The straddle table: no side is picked (a tap on one leaves the straddle table).
    phoneSeg.classList.toggle("custom", arb || L.side === "straddle");
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
      // Compact / comfortable rows change the columns' measured widths: redraw now.
      if (lastX && built && drawnDensity !== null && densityNow() !== drawnDensity) {
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
      dropLater();
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
    /** True when the table shows parity columns (Synthetic, Dev, Edge: they read the future and both legs). */
    hasParity: () => Boolean(built?.L.mid.length),
    /**
     * Live ticks: patch only the cells of the legs that ticked (`touched`: strike -> Set of "ce" / "pe"), the parity
     * cells of their strikes and, with `spot`, the spot divider. Every cell keeps its node; only changed text nodes
     * and classes are written (patchCell compares each cell's own signature). False when the table on screen is not
     * built for this chain and layout (the caller then draws in full).
     * @param {object} x  the last full draw's context with this chain's rows (desk.js patchLive)
     * @param {Map<number, Set<string>>} touched
     */
    patchLegs(x, touched, { spot = false } = {}) {
      if (!built || built.stale || !host.contains(built.wrap) || built.key !== [x.c.underlying, x.c.expiry, built.sig].join("|")) return false;
      lastX = x;
      const flashes = [];
      const items = [];
      for (const [strike, sides] of touched) {
        const b = built.rows.get(strike);
        // Rows outside the window are patched when they come back into it.
        if (b && !b.tr.hidden) items.push([strike, sides]);
      }
      // The legs nearest the focus (or spot) now, the rest on the next frames (drainRows).
      runRows(items, x, flashes);
      if (spot) drawSpot(x);
      flushFlashes(flashes);
      return true;
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
    /** The strike cell of a row (the anchor of the build-around menu), or the row itself. */
    rowHead: (strike) => {
      const b = built?.rows?.get(strike);
      return b ? (b.tr.querySelector("th.strike-col") ?? b.tr) : null;
    },
    /** The side a key or tap acts on in the current layout. */
    sideNow: () => (built?.L.side === "ce" || built?.L.side === "pe" ? built.L.side : st.focus?.side ?? "ce"),
    layoutSide: () => built?.L.side ?? null,
    colTitle: (k) => COLS[k]?.title,
    /** The facts behind one cell (chain-facts.js cellFacts), for a hover card: [{ label, value, note }]. */
    cellFacts: (k, strike, side) => {
      const row = lastX?.c.rows.find((r) => r.strike === strike);
      return row ? CF.cellFacts(k, row[side], row, side, lastX) : [];
    },
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

/** The held-lots badge before a chain LTP: what the signed number means, in words. */
export function heldTitle(lots) {
  const n = Math.abs(lots);
  return `Your position: ${lots > 0 ? "long" : "short"} ${formatInt(n)} lot${n === 1 ? "" : "s"} in this contract`;
}

const PHONE_TAG = { mp: "MP", cw: "C wall", pw: "P wall" };
const SHORT_TAG = { mp: "MP", cw: "CW", pw: "PW" };
/**
 * The strike tags a chain cell shows, from tagsFor's [class, text, title] list in priority order. A phone shows one
 * (short form); a desktop cell shows two, and in short form whenever there are two, so ATM + Max Pain + a wall never
 * spill out of the strike column. A shortened tag keeps its full name in its title.
 */
export function strikeTagsShown(tags, phone = false) {
  const list = Array.isArray(tags) ? tags : [];
  if (phone) return list.slice(0, 1).map(([cl, t, title]) => [cl, PHONE_TAG[cl] ?? t, `${t}: ${title}`]);
  const two = list.slice(0, 2);
  return two.length < 2 ? two : two.map(([cl, t, title]) => (SHORT_TAG[cl] ? [cl, SHORT_TAG[cl], `${t}: ${title}`] : [cl, t, title]));
}
