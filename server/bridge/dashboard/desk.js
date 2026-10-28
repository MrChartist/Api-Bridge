// The Option Desk: a live option chain you can trade from, a strategy builder with payoffs, OI analysis and your
// positions on the same underlying. Data is GET /v1/expiries, /v1/optionchain and /v1/positions; orders go through
// POST /v1/orders/preview and /v1/orders like every other client, so the Bridge's safety gates apply unchanged.
//
// Built for refresh every few seconds: the chain table is built once per (underlying, expiry, strikes, columns) and
// then patched cell by cell, so nothing flickers, scroll and keyboard focus stay put, and only cells that changed
// flash. The maths lives in options.js (pure, tested); numbers are formatted by format.js only.
import { alertBox, api, app, card, emptyState, h, icon, istTime, modal, optional, pill, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import { openChainSheet } from "./chain-sheet.js";
import { createOiPage, oiConfig } from "./oi.js";
import { createBuilder } from "./strategy.js";
import * as O from "./options.js";
import { createPositionsPage } from "./positions.js";
import { cap, every, segField, segmented, stopTimer } from "./views.js";

const SLOT = "mcb.dashboard.desk";
const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const DEMO_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"];
/** Strikes fetched either side of ATM: wide enough for PCR and max pain, whatever is shown. */
const FETCH_STRIKES = 40;
/** The OI page reads the whole listed chain (the API maximum), so max pain and PCR are not biased by a partial one. */
const OI_FETCH_STRIKES = 100;
const REFRESH_MS = 3000;
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryText = (e) => (/^\d{4}-\d{2}-\d{2}$/.test(e ?? "") ? EXPIRY_DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
/** "NIFTY 3 Nov 26400 CE" */
const contractName = (u, expiry, strike, right) => `${u} ${expiryText(expiry)} ${formatInt(strike)} ${right}`;
const num = (v) => (isFigure(v) ? Number(v) : null);
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
const KEY_LEGEND = CHAIN_KEYS.filter((k) => !["R", "Esc"].includes(k[0][0]));
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

/** @param {"chain"|"strategy"|"oi"|"positions"} kind */
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
  };
  st.strikesView = st.strikes;
  const save = () => local.set(SLOT, JSON.stringify({ underlying: st.underlying, expiry: st.expiry, strikes: st.strikes, chain: st.cfg, account: st.account, live: st.live, baskets: st.baskets, oi: st.oi, strategy: st.scfg ?? undefined, whatIf: st.whatIf ?? undefined, pos: st.pos }));
  const account = () => tradable.find((a) => a.id === st.account) ?? null;
  const basketKey = () => `${st.underlying}|${st.expiry}`;
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
  const search = h("input", { type: "search", inputmode: "decimal", enterkeyhint: "go", autocomplete: "off", spellcheck: "false", class: "strike-search", "aria-label": "Go to strike", placeholder: "Strike, +3, 1σ" });
  const searchBtn = h("button", { type: "button", class: "icon-btn search-btn", "aria-label": "Go to strike", title: "Go to strike (/)" }, icon("search"));
  const searchBox = h("div", { class: "chain-search" }, searchBtn, search, h("kbd", { class: "search-kbd", "aria-hidden": "true" }, "/"));
  const chainTitle = h("span", { class: "chain-title" });
  const aSel = h(
    "select",
    { "aria-label": "Orders go to", disabled: !tradable.length },
    tradable.length ? tradable.map((a) => h("option", { value: a.id, selected: a.id === st.account }, `${a.label}${a.broker === "paper" ? " · paper" : a.liveAllowedByConfig ? " · live on" : ""}`)) : h("option", { value: "" }, "No account can place orders"),
  );
  const liveBtn = h("button", { type: "button", class: "small live-toggle" });
  const clock = h("span", { class: "desk-clock" });
  const drawLive = () => {
    liveBtn.setAttribute("aria-pressed", String(st.live));
    liveBtn.classList.toggle("on", st.live);
    liveBtn.replaceChildren(h("span", { class: "live-dot", "aria-hidden": "true" }), st.live ? "Live" : "Paused");
    liveBtn.title = st.live ? `Refreshing every ${REFRESH_MS / 1000} s (P to pause)` : "Paused (P to resume)";
    sheet?.update();
  };
  const statsEl = h("div", { class: "desk-stats", role: "group", "aria-label": "Chain summary" });
  const chainEl = h("div", { class: "desk-chain" });
  const keysEl = h(
    "div",
    { class: "desk-keys" },
    KEY_LEGEND.map(([keys, short]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), short)),
  );
  let sheet = null;
  /** "Open in chain" from the OI page: the chain focuses this strike once, then forgets it. */
  let jump = kind === "chain" && prefs.jump && typeof prefs.jump === "object" ? prefs.jump : null;
  if (prefs.jump) {
    const { jump: _drop, ...rest } = prefs;
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
          onClock: () => drawClock(),
          openInChain: (expiry, strike, side) => {
            st.expiry = expiry;
            openInChain(strike, side);
          },
          setUnderlying: (u) => {
            if (!list.includes(u)) return toast(`${u} is not on this desk's list`);
            st.underlying = u;
            uSel.value = u;
            save();
            reloadAll();
          },
        })
      : null;
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
      eSel.replaceChildren(...ex.map((e) => h("option", { value: e, selected: e === st.expiry }, `${expiryText(e)} · ${O.isExpiryDay(e) ? "today" : O.timeToExpiry(e).label}${O.isMonthlyExpiry(e, ex) ? " · M" : ""}`)));
      eSel.disabled = false;
      oiPage?.expiriesLoaded();
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
  /** The underlying's futures (once per underlying): the same-expiry one is the arbitrage reference. */
  async function loadFutures() {
    const u = st.underlying;
    const r = await optional(api(`/v1/instruments/search?q=${encodeURIComponent(u)}&kind=FUT&underlying=${encodeURIComponent(u)}`));
    if (u !== st.underlying) return;
    st.futures = (r.data?.data ?? []).filter((f) => f.kind === "FUT" && f.underlying === u && /^\d{4}-\d{2}-\d{2}$/.test(f.expiry ?? "")).sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  }
  /** The index and its futures, for the spot row: a failed call leaves the page as it was. */
  async function loadQuotes() {
    const syms = [INDEX_SYMBOL[st.underlying], ...st.futures.map((f) => f.symbol)].filter(Boolean);
    if (!syms.length) return;
    const r = await optional(api(`/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}`));
    if (r.error) return;
    for (const q of r.data?.data ?? []) if (q?.symbol) st.quotes.set(q.symbol, q);
  }
  async function loadChain() {
    if (!st.expiry) return;
    const seq = st.seq;
    const t0 = performance.now();
    try {
      const [r] = await Promise.all([api(`/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(st.expiry)}&strikes=${kind === "oi" ? OI_FETCH_STRIKES : FETCH_STRIKES}&greeks=true`), loadQuotes()]);
      if (seq !== st.seq) return;
      st.chain = r.data.data;
      st.freshness = r.data.data?.freshness ?? r.data.meta?.freshness ?? null;
      st.ms = Math.round(performance.now() - t0);
      st.error = null;
      st.lastOk = new Date().toISOString();
    } catch (err) {
      if (seq !== st.seq) return;
      st.error = err;
    }
    drawAll();
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
  const refresh = () => (posPage ? posPage.tick() : Promise.all([loadChain(), loadPositions(), oiPage?.tick()]));
  const startTimer = () => (st.live ? every(REFRESH_MS, refresh) : stopTimer());
  async function reloadAll() {
    if (posPage) {
      posPage.reset();
      return posPage.tick();
    }
    chain.reset();
    oiPage?.reset({ underlying: true });
    sheet?.close();
    st.chain = null;
    st.focus = null;
    st.futures = [];
    st.quotes = new Map();
    drawAll();
    const ok = await loadExpiries();
    if (ok) {
      await loadFutures();
      await refresh();
    } else await loadPositions();
  }

  // ── Derived context for one draw ──
  function context() {
    const c = st.chain;
    const sm = O.chainSummary(c);
    const years = O.yearsToExpiry(c.expiry);
    const growth = O.parityGrowth(years);
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
      hot: unusualVolume(c.rows),
      maxVol: c.rows.reduce((m, r) => Math.max(m, num(r.ce?.volume) ?? 0, num(r.pe?.volume) ?? 0), 0),
      held: heldLots(st.cfg.positions ? st.positions : [], lot),
      em1: { lo: near(b1?.lo), hi: near(b1?.hi) },
      em2: { lo: near(b2?.lo), hi: near(b2?.hi) },
      band1: b1,
      topOi: { ce: tops("ce"), pe: tops("pe") },
      ref: ref ?? null,
      refKind: num(sameQ?.ltp) !== null ? "fut" : "F",
      medianDev: devs.length ? devs[Math.floor(devs.length / 2)] : null,
      syn,
      edge,
      sameFut: same && num(sameQ?.ltp) !== null ? { expiry: same.expiry, ltp: sameQ.ltp } : null,
      indexQuote: st.quotes.get(INDEX_SYMBOL[c.underlying] ?? "") ?? null,
      netDelta,
      hedgeOwn: own,
    };
  }

  let lastX = null;
  let chainTools = null;
  /** The chain's tools act on a chain: switched off (inert, dimmed) while there is none. */
  function syncTools() {
    if (!chainTools) return;
    const off = !st.chain;
    if (chainTools.inert !== off) chainTools.inert = off;
    chainTools.classList.toggle("off", off);
  }
  function drawAll() {
    drawClock();
    syncTools();
    if (!st.chain) {
      if (st.empty) {
        chainTitle.__sig = "";
        chainTitle.replaceChildren(h("strong", {}, st.underlying));
      }
      chain.reset();
      lastX = null;
      if (kind !== "oi") drawStats(null);
      const retry = h("button", { type: "button", class: "small", onclick: () => reloadAll() }, icon("refresh"), "Retry");
      chainEl.replaceChildren(
        st.error
          ? h("div", { class: "desk-pad stack" }, alertBox(st.error), h("div", {}, retry))
          : st.empty
            ? emptyState("clock", "No expiries", st.empty)
            : h("p", { class: "muted chain-loading" }, "Loading the chain…"),
      );
      builder?.draw(null, { error: st.error });
      oiPage?.draw(null);
      return;
    }
    const t0 = performance.now();
    const x = context();
    lastX = x;
    if (kind !== "oi") drawStats(x);
    if (kind === "chain") {
      drawTitle(x);
      chain.draw(x);
      if (jump) {
        if (jump.underlying === x.c.underlying && jump.expiry === x.c.expiry && x.c.rows.some((r) => r.strike === jump.strike)) {
          st.focus = { strike: jump.strike, side: jump.side === "pe" ? "pe" : "ce" };
          chain.paintFocus(true, true);
        }
        jump = null;
      }
      chain.note(st.error ? `Last update ${istTime(st.lastOk)} · retrying every ${REFRESH_MS / 1000} s` : null);
      st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
      sheet?.update();
      drawClock();
    }
    if (kind === "strategy") builder.draw(x);
    if (kind === "oi") {
      oiPage.draw(x);
      st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
      drawClock();
    }
  }
  function drawTitle(x) {
    const t = O.timeToExpiry(x.c.expiry);
    const today = O.isExpiryDay(x.c.expiry);
    const sig = `${x.c.underlying}|${x.c.expiry}|${t.label}|${x.lot}|${today}`;
    if (chainTitle.__sig === sig) return;
    chainTitle.__sig = sig;
    chainTitle.replaceChildren(
      h("strong", {}, `${x.c.underlying} ${expiryText(x.c.expiry)}`),
      h("span", { class: "muted" }, `${today ? "" : ` · ${t.label}`} · lot ${formatInt(x.lot)}`),
      ...(today ? [h("span", { class: "expiry-chip", title: EXPIRY_DAY_NOTE }, "Expiry today")] : []),
    );
  }
  function drawClock() {
    const asOf = st.freshness?.asOf;
    // The OI page says when the market is shut, so a quiet ΔOI does not look live.
    const session = kind === "oi" && !app.state.demo ? O.marketSession() : null;
    const closed = session && session.phase !== "open" ? session.label : "";
    const sig = JSON.stringify([Boolean(st.error), st.freshness?.stale, asOf, st.ms, closed]);
    if (clock.__sig !== sig) {
      clock.__sig = sig;
      clock.classList.toggle("bad", Boolean(st.error));
      clock.classList.toggle("stale", Boolean(st.freshness?.stale));
      clock.replaceChildren(
        st.error ? "Not updating" : st.freshness?.stale ? "Stale" : "",
        ...(asOf && !st.error ? [` ${istTime(asOf)}`] : []),
        ...(st.ms !== null && !st.error ? [h("small", {}, ` ${formatInt(st.ms)} ms`)] : []),
        ...(closed ? [h("small", { class: "desk-closed" }, ` · ${closed}`)] : []),
      );
    }
    const title = [st.error ? String(st.error.message ?? st.error) : st.freshness?.accountId ? `Data from ${st.freshness.accountId}` : "", st.patchMs !== null ? `render ${formatFixed(st.patchMs, 1)} ms` : ""].filter(Boolean).join(" · ");
    if (clock.title !== title) clock.title = title;
  }

  // ── Summary strip (built once, then patched) ──
  function tile(label, value, sub, { cls, title } = {}) {
    return h("div", { class: `desk-stat ${cls ?? ""}`.trim(), title }, h("span", { class: "label" }, label), h("span", { class: "value" }, value), h("span", { class: "sub" }, sub ?? " "));
  }
  const tiles = new Map();
  function setTile(key, label, value, sub, { cls, title } = {}) {
    let t = tiles.get(key);
    if (!t || !statsEl.contains(t.el)) {
      const el = tile(label, value, sub, { cls, title });
      t = { el, label: el.children[0], value: el.children[1], sub: el.children[2], sig: "" };
      tiles.set(key, t);
      statsEl.append(el);
    }
    const sig = JSON.stringify([label, value, sub, title]);
    if (t.sig === sig) return;
    t.sig = sig;
    t.label.textContent = label;
    t.value.textContent = value;
    t.sub.textContent = sub || " ";
    t.el.title = title ?? "";
  }
  function drawStats(x) {
    if (!x) {
      for (const [k, l] of [["spot", st.underlying], ["iv", "ATM IV"], ["em", "Expected move"], ["straddle", "Straddle"], ["pcr", "PCR"], ["mp", "Max pain"], ["pw", "Put wall"], ["cw", "Call wall"]]) setTile(k, l, DASH, "");
      return;
    }
    const { sm, c, F, move } = x;
    const day = O.sigmaMove(F, sm.atmIv, 1 / 365);
    const t = O.timeToExpiry(c.expiry);
    const n = c.rows.length;
    const pcrWord = sm.pcr === null ? "" : sm.pcr >= 1.2 ? "put-heavy" : sm.pcr <= 0.8 ? "call-heavy" : "balanced";
    const fut = x.sameFut;
    setTile(
      "spot",
      c.underlying,
      formatFixed(sm.spot, 2),
      fut ? `Fut ${formatFixed(fut.ltp, 1)} (${formatSigned(fut.ltp - sm.spot, 1)})` : F !== null ? `F ${formatInt(F)} (syn)` : "",
      { title: fut ? "The same-expiry future and its basis to spot" : "Synthetic future from put-call parity (K + (C − P)·e^(rT)); no future is listed for this expiry" },
    );
    setTile("iv", "ATM IV", formatPercent(sm.atmIv, 2), day ? `1-day ±${formatInt(day)}` : t.label, { title: "Average of the ATM call and put IV; the 1-day 1σ move it implies" });
    setTile("em", "Expected move", move ? `±${formatInt(move)}` : DASH, x.band1 ? `${formatInt(x.band1.lo)} – ${formatInt(x.band1.hi)}` : "", { title: `Log-normal 1σ band to expiry at ATM IV (${t.label}): about 68% of outcomes land inside` });
    setTile("straddle", "Straddle", formatFixed(sm.straddle, 2), sm.straddle && sm.spot ? `${formatPercent((sm.straddle / sm.spot) * 100, 2)} of spot` : "", { title: "ATM call + put. The market's price for a move either way" });
    setTile("pcr", "PCR", formatFixed(sm.pcr, 2), `Net ΔOI ${formatCompact(sm.netOiChange, { signed: true })}`, {
      title: `Put OI ÷ call OI over the ${formatInt(n)} strikes loaded (±${FETCH_STRIKES} around ATM; ${pcrWord}). Net ΔOI = put OI added − call OI added today${sm.pcrChange !== null ? ` (ratio ${formatFixed(sm.pcrChange, 2)})` : ""}. Volume PCR ${formatFixed(sm.pcrVolume, 2)}`,
    });
    setTile("mp", "Max pain", formatInt(sm.maxPain), sm.maxPain !== null && sm.spot !== null ? `${formatSigned(sm.maxPain - sm.spot, 0)} from spot` : "", { title: `Settlement at which option buyers would collect the least, over the ${formatInt(n)} strikes loaded` });
    setTile("pw", "Put wall", formatInt(sm.support?.strike), sm.support ? `OI ${formatCompact(sm.support.oi)}` : "", { title: `Strike with the most put OI of the ${formatInt(n)} loaded (often read as support)` });
    setTile("cw", "Call wall", formatInt(sm.resistance?.strike), sm.resistance ? `OI ${formatCompact(sm.resistance.oi)}` : "", { title: `Strike with the most call OI of the ${formatInt(n)} loaded (often read as resistance)` });
  }

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
  });
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
    else if (legs.length >= O.MAX_LEGS) return toast(`The strategy holds up to ${O.MAX_LEGS} legs`);
    else legs.push({ right: leg.right, strike: leg.strike, side: leg.side, lots: leg.lots ?? 1 });
    save();
    toast(`${leg.side === "BUY" ? "Buy" : "Sell"} ${formatInt(leg.strike)} ${leg.right} added to Strategy Builder`);
  }

  // ── Order ticket ──
  /**
   * The order ticket. From the chain: `row` + `right`. From positions (any expiry, futures too): `quote` (a getter for
   * the live quote), `lotSize`, `units` (an odd quantity: the ticket works in units and sends `quantity`), `kind`, `name`
   * and `tick`. An exit starts as a LIMIT at mid rounded toward a fill, with 25 / 50 / 75 / 100 % chips.
   */
  async function openTicket({ row, right, side, qty, symbol, product, expiry, exit = false, quote: quoteIn = null, units: oddUnits = false, lotSize: lotIn = null, kind = "OPT", name: nameIn = null, tick: tickIn = null, freezeQty = null, price: priceIn = null }) {
    const a = account();
    if (!a) return toast("Choose an account that can place orders first.");
    const c = st.chain;
    const ex = expiry ?? c?.expiry;
    const fut = kind === "FUT";
    const sym = symbol ?? row?.[right.toLowerCase()]?.symbol;
    if (!sym) return toast("This contract has no symbol in the chain.");
    const lotSize = num(lotIn) || num(c?.lotSize) || 1;
    const tick = num(tickIn) || 0.05;
    const quote = quoteIn ?? (() => (st.chain?.expiry === ex ? st.chain.rows.find((r) => r.strike === row.strike)?.[right.toLowerCase()] : row?.[right.toLowerCase()]) ?? null);
    const clientOrderId = `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const held = num(qty) ? Math.abs(num(qty)) : null;
    const inUnits = Boolean(oddUnits) || (held !== null && held % lotSize !== 0);
    const sideSeg = segmented("Side", [["BUY", "Buy"], ["SELL", "Sell"]], side);
    const lots = inUnits
      ? h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(held ?? lotSize) })
      : h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(held ? Math.max(1, Math.round(held / lotSize)) : 1) });
    const lotHint = h("span", { class: "hint" });
    const typeSeg = segmented("Order type", [["LIMIT", "Limit"], ["MARKET", "Market"]], "LIMIT");
    const midPx = (sd) => O.roundToTick(O.mid(quote()), tick, sd === "BUY" ? "buy" : "sell");
    const startPx = isFigure(priceIn) ? Number(priceIn) : exit ? midPx(side) ?? O.touchPrice(quote(), side, tick) : O.touchPrice(quote(), side, tick);
    const price = h("input", { type: "number", min: "0.05", step: String(tick), inputmode: "decimal", value: String(startPx ?? "") });
    const prodSeg = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Carry (NRML)"]], product === "MARGIN" || product === "CNC" ? "MARGIN" : "INTRADAY");
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand this sends a real order to ${a.label}.`);
    const quoteLine = h("div", { class: "ticket-quote" });
    // Advisory warnings from the chain (spread, liquidity, freeze qty, expiry day...): the server checks still decide.
    const warnEl = h("ul", { class: "ticket-checks ticket-warns", "aria-label": "Before you trade", hidden: true });
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
      h("div", { class: "price-row" }, price, h("div", { class: "touch-btns", role: "group", "aria-label": "Use a quote" }, [["Bid", "bid"], ["Mid", "mid"], ["Ask", "ask"]].map(([l, k]) => h("button", { type: "button", class: "small", onclick: () => (k === "mid" ? ((price.value = String(midPx(sideSeg.value) ?? "")), changed()) : touch(k)) }, l)))),
    );
    // Exit size: 25 / 50 / 75 % in whole lots (at least one), 100 % the exact quantity held.
    const sizeFor = (pct) => {
      if (held === null) return null;
      if (pct >= 100) return inUnits ? held : Math.max(1, Math.round(held / lotSize));
      const whole = Math.floor(held / lotSize);
      if (whole < 1) return inUnits ? held : 1;
      const l = Math.min(whole, Math.max(1, Math.floor((whole * pct) / 100 + 0.5)));
      return inUnits ? l * lotSize : l;
    };
    const pctBtns = exit && held !== null ? [25, 50, 75, 100].map((p) => h("button", { type: "button", class: "small", "data-pct": String(p), "aria-pressed": String(p === 100), onclick: () => ((lots.value = String(sizeFor(p))), changed()) }, `${p}%`)) : [];
    const pctRow = pctBtns.length ? h("div", { class: "touch-btns pct-btns", role: "group", "aria-label": "Exit size" }, pctBtns) : null;
    const live = () => modeSeg?.value === "live";
    const body = () => {
      const b = { account: a.id, symbol: sym, side: sideSeg.value, product: prodSeg.value, orderType: typeSeg.value };
      if (inUnits) b.quantity = units();
      else b.lots = Math.max(1, Math.floor(Number(lots.value) || 1));
      if (typeSeg.value === "LIMIT" && isFigure(price.value)) b.price = Number(price.value);
      if (live()) b.mode = "live";
      return b;
    };
    let placeBtn = null;
    let last = null;
    const drawButton = () => {
      if (!placeBtn) return;
      const b = body();
      const blocked = (last?.checks ?? []).some((x) => x?.severity === "block");
      placeBtn.textContent = `${b.side === "BUY" ? "Buy" : "Sell"} ${inUnits ? `${formatInt(b.quantity)} qty` : `${formatInt(b.lots)} lot${b.lots === 1 ? "" : "s"}`}${live() ? " · LIVE" : ""}`;
      placeBtn.className = live() ? "danger" : b.side === "BUY" ? "primary" : "primary sell";
      placeBtn.disabled = blocked || (live() && !ack.checked) || (typeSeg.value === "LIMIT" && !isFigure(price.value));
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
      if (b.orderType === "LIMIT" && b.price === undefined) {
        last = null;
        previewEl.replaceChildren(h("p", { class: "muted small pad" }, "Enter a limit price."));
        return drawButton();
      }
      try {
        const r = (await api("/v1/orders/preview", { method: "POST", body: b })).data.data;
        if (seq !== previewSeq) return;
        last = r;
        const checks = [...(r.checks ?? [])].sort((x, y) => (x.severity === "block" ? -1 : 0) - (y.severity === "block" ? -1 : 0));
        previewEl.replaceChildren(
          h(
            "div",
            { class: "ticket-figs" },
            h("div", {}, h("small", {}, "Quantity"), `${formatInt(r.quantity)}`),
            h("div", {}, h("small", {}, b.side === "BUY" ? "You pay" : "You receive"), formatRupee(r.estimatedValue, 0)),
            h("div", {}, h("small", {}, "Mode"), r.mode === "live" ? h("span", { class: "down" }, "LIVE") : "Paper"),
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
    const quoteTimer = setInterval(() => (drawQuote(), drawWarnings()), 1000);
    drawQuote();

    const name = nameIn ?? contractName(c?.underlying ?? st.underlying, ex, row.strike, right);
    const done = modal({
      title: exit ? `Exit ${name}` : name,
      body: h(
        "div",
        { class: "stack ticket" },
        quoteLine,
        segField("Side", sideSeg),
        h("div", { class: "ticket-grid" }, h("label", { class: "field" }, h("span", {}, inUnits ? "Quantity " : "Lots ", lotHint), lots), segField("Type", typeSeg)),
        pctRow,
        priceField,
        h("div", { class: "ticket-grid" }, segField("Product", prodSeg), modeSeg ? segField("Mode", modeSeg) : h("div", { class: "field" }, h("span", {}, "Account"), h("span", { class: "ticket-acct" }, `${a.label}\u00a0`, h("span", { class: "muted" }, "· paper")))),
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
          onClick: async () => {
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
    placeBtn = document.querySelector("#dialog .dialog-actions button:last-child");
    changed();
    const result = await done;
    clearInterval(quoteTimer);
    clearTimeout(previewTimer);
    if (result === "placed") refresh();
    return result;
  }

  // ── Chain settings ──
  function setCfg(patch) {
    st.cfg = chainConfig({ ...st.cfg, ...patch });
    save();
    syncPreset();
    chain.reset(true);
    if (st.chain) drawAll();
  }
  function openCustomise() {
    const close = () => {
      pop.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
      gearBtn.setAttribute("aria-expanded", "false");
      gearBtn.focus();
    };
    const outside = (e) => {
      if (!pop.contains(e.target) && !gearBtn.contains(e.target)) close();
    };
    const esc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const sw = (label, get, set, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        draw();
      });
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const body = h("div", { class: "pop-body" });
    const draw = () => {
      const c = st.cfg;
      // One "Show" control: the one that applies at this width (phones keep their own side setting).
      const phone = device().phone;
      const sideSeg = segmented("Show", [["ce", "Calls"], ["pe", "Puts"], ["both", "Both"]], phone ? c.phoneSide : c.side);
      sideSeg.addEventListener("change", () => setCfg(phone ? { phoneSide: sideSeg.value } : { side: sideSeg.value }));
      const enabled = c.cols;
      const others = CHAIN_COLUMNS.map(([k]) => k).filter((k) => !enabled.includes(k));
      const label = (k) => CHAIN_COLUMNS.find(([x]) => x === k)?.[1] ?? k;
      const move = (k, d) => {
        const a = [...enabled];
        const i = a.indexOf(k);
        const j = i + d;
        if (j < 0 || j >= a.length) return;
        [a[i], a[j]] = [a[j], a[i]];
        setCfg({ cols: a });
        draw();
      };
      const colRow = (k, on) =>
        h(
          "div",
          { class: `col-row ${on ? "on" : ""}`.trim(), draggable: on ? "true" : undefined, "data-col": k },
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
          })(), h("span", { title: chain.colTitle(k) }, label(k), chain.isRowCol(k) ? h("small", { class: "col-scope" }, " per strike") : null)),
          on ? h("span", { class: "col-move" }, h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${label(k)} towards the strike`, disabled: enabled.indexOf(k) === 0, onclick: () => move(k, -1) }, icon("up")), h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${label(k)} away from the strike`, disabled: enabled.indexOf(k) === enabled.length - 1, onclick: () => move(k, 1) }, icon("down"))) : null,
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
      const presetBtn = (p) => h("button", { type: "button", class: `preset ${c.preset === p ? "on" : ""}`.trim(), "aria-pressed": String(c.preset === p), onclick: () => { setCfg({ cols: [...CHAIN_PRESETS[p]] }); draw(); } }, PRESET_NAMES[p]);
      const presets = h("div", { class: "preset-row" }, TOOLBAR_PRESETS.map(presetBtn), h("span", { class: "preset-more" }, "More presets"), ["greeks", "value"].map(presetBtn));
      body.replaceChildren(
        h("section", {}, h("h3", {}, "Show"), sideSeg),
        h("section", {}, h("h3", {}, "Columns ", h("small", {}, "from the strike outwards · drag to reorder")), presets, list, (() => {
          const row = sw("Bid and ask (click to trade)", () => c.quotes, (v) => setCfg({ quotes: v }), c.preset === "arb" ? "Always on in the Arb view" : "Touch screens trade from the row's sheet instead");
          if (c.preset === "arb") row.querySelector("input").disabled = true;
          return row;
        })()),
        h("section", {}, h("h3", {}, "Bars"), sw("OI bars", () => c.bars.oi, (v) => setCfg({ bars: { ...st.cfg.bars, oi: v } })), sw("OI change bars", () => c.bars.chg, (v) => setCfg({ bars: { ...st.cfg.bars, chg: v } })), sw("Volume bars", () => c.bars.vol, (v) => setCfg({ bars: { ...st.cfg.bars, vol: v } }))),
        h(
          "section",
          {},
          h("h3", {}, "Display"),
          sw("% change under values", () => c.pct, (v) => setCfg({ pct: v })),
          sw("Values in lots", () => c.lots, (v) => setCfg({ lots: v }), "OI and volume ÷ lot size"),
          sw("Highlight in-the-money", () => c.itm, (v) => setCfg({ itm: v })),
          sw("My positions in the chain", () => c.positions, (v) => setCfg({ positions: v }), "Lots you hold, beside the LTP"),
          sw("Compact rows", () => c.dense, (v) => setCfg({ dense: v })),
        ),
        h(
          "section",
          {},
          h("h3", {}, "Strike tags"),
          sw("Max Pain", () => c.tags.mp, (v) => setCfg({ tags: { ...st.cfg.tags, mp: v } })),
          sw("Support / Resistance (OI walls)", () => c.tags.walls, (v) => setCfg({ tags: { ...st.cfg.tags, walls: v } })),
          sw("Expected move (±1σ)", () => c.tags.em, (v) => setCfg({ tags: { ...st.cfg.tags, em: v } })),
          sw("±2σ", () => c.tags.em2, (v) => setCfg({ tags: { ...st.cfg.tags, em2: v } }), "Strikes two standard deviations out"),
        ),
      );
    };
    const pop = h(
      "div",
      { class: "popover customise", role: "dialog", "aria-label": "Customise the chain" },
      h("div", { class: "pop-head" }, h("strong", {}, "Customise"), h("button", { type: "button", class: "small plain reset", onclick: () => { st.cfg = chainConfig({}); setCfg({}); draw(); } }, icon("refresh"), "Reset"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close"))),
      body,
    );
    draw();
    gearBtn.setAttribute("aria-expanded", "true");
    gearBtn.closest(".panel-head").append(pop);
    pop.querySelector("button, input")?.focus();
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ── Strike search ──
  function runSearch() {
    const x = lastX;
    if (!x) return;
    const strikes = x.c.rows.map((r) => r.strike);
    const sigmaPts = x.F !== null && x.sm.atmIv && x.years > 0 ? (x.sm.atmIv / 100) * Math.sqrt(x.years) * x.F : null;
    const k = O.strikeQuery(search.value, { strikes, atm: x.sm.atm, F: x.F, sigmaPts, maxPain: x.sm.maxPain });
    search.setAttribute("aria-invalid", String(k === null));
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
      search.blur();
      searchBox.classList.remove("open");
    }
  });
  search.addEventListener("input", () => search.removeAttribute("aria-invalid"));
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
      if (k === "p") return liveBtn.click(), true;
      if (k === "r") return refresh(), true;
      if (k === "[" || k === "]") {
        const i = eSel.selectedIndex + (k === "]" ? 1 : -1);
        if (i < 0 || i >= eSel.options.length || eSel.disabled) return true;
        eSel.selectedIndex = i;
        eSel.dispatchEvent(new Event("change"));
        return true;
      }
      if (/^[1-5]$/.test(k)) return setCfg({ cols: [...CHAIN_PRESETS[TOOLBAR_PRESETS[Number(k) - 1]]] }), true;
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
      if (k === "Enter") {
        if (e.target instanceof Element && e.target.closest("button, a, summary")) return false;
        return openSheet(row.strike, target.side), true;
      }
      if (k === "b" || k === "s") return openTicket({ row, right, side: k === "b" ? "BUY" : "SELL" }), true;
      if (k === "B" || k === "S") return addLeg({ right, strike: row.strike, side: k === "B" ? "BUY" : "SELL" }), true;
      if (k === "x") {
        const sym = row[target.side]?.symbol;
        const p = sym ? st.positions.find((q) => q.symbol === sym && Number(q.netQty)) : null;
        return p ? exitPosition(p) : toast(`No position in ${formatInt(row.strike)} ${right}`), true;
      }
      return false;
    },
  };
  const oiDesk = oiPage && {
    root: oiPage.root,
    onKey(e) {
      if (e.key === "p") return liveBtn.click(), true;
      if (e.key === "r") return refresh(), true;
      return oiPage.onKey(e);
    },
  };
  const stratDesk = builder && {
    root: builder.panel,
    onKey(e) {
      if (e.key === "p") return liveBtn.click(), true;
      if (e.key === "r") return refresh(), true;
      return builder.onKey(e);
    },
  };
  const posDesk = posPage && {
    root: posPage.root,
    onKey(e) {
      if (e.key === "p") return liveBtn.click(), true;
      if (e.key === "r") return refresh(), true;
      return posPage.onKey(e);
    },
  };
  activeDesk = kind === "chain" ? desk : kind === "oi" ? oiDesk : kind === "strategy" ? stratDesk : kind === "positions" ? posDesk : null;
  bindKeys();

  // ── Wiring ──
  uSel.addEventListener("change", () => {
    st.underlying = uSel.value;
    st.expiry = null;
    save();
    reloadAll();
  });
  eSel.addEventListener("change", () => {
    st.expiry = eSel.value;
    st.seq++;
    st.focus = null;
    sheet?.close();
    chain.reset();
    oiPage?.reset();
    save();
    loadChain();
  });
  strikesSeg.addEventListener("change", () => {
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
  aSel.addEventListener("change", () => {
    st.account = aSel.value;
    save();
    if (posPage) posPage.accountChanged();
    else loadPositions();
    builder?.accountChanged();
  });
  liveBtn.addEventListener("click", () => {
    st.live = !st.live;
    save();
    drawLive();
    startTimer();
    if (st.live) refresh();
  });
  drawLive();
  // Back to the tab: refresh at once instead of on the next tick. Device class changes (rotation, a phone-width
  // window, a touch screen) re-lay the chain. Both listeners go when the page does.
  const pageRoot = kind === "chain" ? chainEl : kind === "strategy" ? builder.panel : kind === "oi" ? oiPage.root : posPage.root;
  const onVisible = () => {
    if (!pageRoot.isConnected) return cleanup();
    if (!document.hidden && st.live) refresh();
  };
  const mqs = [MQ_PHONE, MQ_NARROW, MQ_COARSE].map((q) => media(q));
  const onDevice = () => {
    if (!chainEl.isConnected) return cleanup();
    setCfg({});
  };
  // Leaving the page: the router swaps #content on hashchange, so check once it has.
  const onRoute = () => setTimeout(() => !pageRoot.isConnected && cleanup(), 0);
  function cleanup() {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("hashchange", onRoute);
    for (const m of mqs) m.removeEventListener("change", onDevice);
    chain.reset();
    sheet?.close();
    builder?.destroy();
    posPage?.destroy();
  }
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("hashchange", onRoute);
  if (kind === "chain") for (const m of mqs) m.addEventListener("change", onDevice);

  await reloadAll();
  startTimer();

  const bar = h(
    "div",
    { class: "desk-bar" },
    h("div", { class: "desk-pick" }, uSel, eSel),
    h("div", { class: "desk-acct", title: "Orders from these pages go to this account" }, aSel),
    h("div", { class: "desk-live" }, clock, liveBtn),
  );
  if (kind === "chain") {
    const out = [
      h("section", { class: "desk-panel desk-top", "data-fixed": "" }, bar),
      h("section", { class: "desk-panel", "data-panel": "summary", "aria-label": "Chain summary" }, statsEl),
      h(
        "section",
        { class: "desk-panel chain-panel", "data-panel": "chain", "aria-label": "Option chain" },
        h("div", { class: "chain-head panel-head" }, chainTitle, (chainTools = h("div", { class: "chain-tools" }, searchBox, strikesSeg, viewSeg, presetSel, gearBtn))),
        chainEl,
        keysEl,
      ),
    ];
    syncTools();
    return out;
  }
  const top = h("section", { class: "desk-panel desk-top", "data-fixed": "" }, bar);
  const summary = h("section", { class: "desk-panel", "data-panel": "summary", "aria-label": "Chain summary" }, statsEl);
  if (kind === "strategy") return [top, summary, builder.panel, builder.slot];
  if (kind === "oi") return [top, ...oiPage.panels];
  // The page covers every expiry: the toolbar's expiry select is hidden (st.expiry stays for the other pages).
  eSel.hidden = true;
  aSel.classList.add("wide");
  return [top, ...posPage.panels];
}

// ── Chain table (built once, patched on every refresh) ──

/**
 * Every column the chain can show: [key, name in Customise, scope]. Scope "row" columns are one per strike (put-call
 * parity) and sit beside the strike; the rest repeat per side. `v` = what a cell depends on (unchanged → skipped),
 * `r` = its content.
 */
export const CHAIN_COLUMNS = [
  ["ltp", "LTP"], ["iv", "IV"], ["oi", "OI"], ["chg", "OI change"], ["vol", "Volume"], ["bu", "Build-up"],
  ["delta", "Delta"], ["gamma", "Gamma"], ["theta", "Theta"], ["vega", "Vega"], ["pitm", "P(ITM)"], ["potm", "P(OTM)"],
  ["ext", "Time value"], ["spread", "Spread %"], ["liq", "Liquidity"], ["prem", "Premium traded"],
  ["be", "Breakeven"], ["pop", "PoP buy"], ["pops", "PoP sell"], ["dist", "Distance from spot"], ["premLot", "Premium per lot"],
  ["thetaLot", "Theta per lot"], ["ivx", "IV − ATM IV"], ["hedge", "Hedge lots"], ["costPct", "Cost % of spot"],
  ["syn", "Synthetic future", "row"], ["dev", "Deviation from future", "row"], ["edge", "Parity edge", "row"], ["ivskew", "IV put − call", "row"],
];
const ROW_SCOPE = new Set(CHAIN_COLUMNS.filter((c) => c[2] === "row").map((c) => c[0]));
/** Column presets, listed from the strike outwards. The first five are the toolbar's (one per persona). */
export const CHAIN_PRESETS = {
  oi: ["ltp", "iv", "vol", "chg", "oi", "bu"],
  buyer: ["ltp", "be", "pop", "delta", "thetaLot", "ivx", "spread"],
  seller: ["ltp", "dist", "pops", "delta", "premLot", "thetaLot", "oi"],
  hedger: ["ltp", "delta", "hedge", "costPct", "be", "dist", "vega"],
  arb: ["syn", "dev", "edge", "ivskew", "ltp", "iv"],
  greeks: ["ltp", "iv", "delta", "gamma", "theta", "vega", "pitm"],
  value: ["ltp", "iv", "ext", "spread", "liq", "prem"],
};
export const PRESET_NAMES = Object.freeze({ oi: "OI", buyer: "Buyer", seller: "Seller", hedger: "Hedger", arb: "Arb", greeks: "Greeks", value: "Value" });
const TOOLBAR_PRESETS = ["oi", "buyer", "seller", "hedger", "arb"];
/** Per preset, the columns that drop out below 1100 px (so a tablet shows at most five a side). */
const PRESET_OPT_X = { oi: ["vol", "bu"], buyer: ["ivx", "spread"], seller: ["thetaLot", "oi"], hedger: ["dist", "vega"], arb: ["ivskew", "iv"], greeks: ["gamma", "vega"], value: ["liq", "prem"] };
export const presetOf = (cols) => Object.keys(CHAIN_PRESETS).find((k) => CHAIN_PRESETS[k].join() === (cols ?? []).join()) ?? "custom";
/** The chain's settings (Customise panel); stored with the desk's other preferences. */
export const CHAIN_DEFAULTS = Object.freeze({
  cols: CHAIN_PRESETS.oi,
  side: "both",
  phoneSide: "ce",
  quotes: true,
  bars: { oi: true, chg: true, vol: true },
  pct: true,
  lots: false,
  itm: true,
  positions: true,
  dense: false,
  tags: { mp: true, walls: true, em: true, em2: false },
});
export function chainConfig(saved) {
  const d = CHAIN_DEFAULTS;
  const c = saved && typeof saved === "object" ? saved : {};
  const known = new Set(CHAIN_COLUMNS.map(([k]) => k));
  const cols = Array.isArray(c.cols) ? c.cols.filter((k, i, a) => known.has(k) && a.indexOf(k) === i) : d.cols;
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  const out = {
    cols: cols.length ? cols : [...d.cols],
    side: ["both", "ce", "pe"].includes(c.side) ? c.side : d.side,
    phoneSide: ["both", "ce", "pe"].includes(c.phoneSide) ? c.phoneSide : d.phoneSide,
    quotes: bool(c.quotes, d.quotes),
    bars: { oi: bool(c.bars?.oi, d.bars.oi), chg: bool(c.bars?.chg, d.bars.chg), vol: bool(c.bars?.vol, d.bars.vol) },
    pct: bool(c.pct, d.pct),
    lots: bool(c.lots, d.lots),
    itm: bool(c.itm, d.itm),
    positions: bool(c.positions, d.positions),
    dense: bool(c.dense, d.dense),
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
const MQ_NARROW = "(max-width: 1099px)";
export const device = () => ({ phone: media(MQ_PHONE).matches, narrow: media(MQ_NARROW).matches, coarse: media(MQ_COARSE).matches });
const reducedMotion = () => media("(prefers-reduced-motion: reduce)").matches;

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

function createChain({ st, host, onTrade, onFocus, onOpen, onSide, onPhoneSide, onWindowAll }) {
  let built = null;
  let centred = false;
  let lastX = null;

  const g = (v, dp) => (isFigure(v) ? formatFixed(v, dp) : DASH);
  const pct1 = (v) => (isFigure(v) ? `${formatSigned(v, 1)}%` : DASH);
  const rupees = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? `${v < 0 ? "-" : ""}₹${formatCompact(Math.abs(v))}` : formatRupee(v, 0));
  const dots = (n) => h("span", { class: "liq", title: `Liquidity ${n} of 5`, "aria-label": `Liquidity ${n} of 5` }, [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= n ? "on" : undefined })));
  const two = (main, sub, cls) => h("span", { class: "two" }, h("span", { class: cls }, main), cfg().pct || sub?.force ? h("small", { class: sub?.cls }, sub?.text ?? "") : null);
  /** A value with an optional bar under it (length = share of the chain's largest), growing away from the strike. */
  const barred = (text, frac, cls, on) => {
    if (!on) return text;
    const bar = h("span", { class: `vbar ${cls ?? ""}`.trim(), "aria-hidden": "true" }, h("span"));
    bar.firstChild.style.transform = `scaleX(${r1(Math.max(0, Math.min(1, frac)) * 100) / 100})`;
    return h("span", { class: "barred" }, h("span", {}, text), bar);
  };
  const cfg = () => st.cfg;
  const unit = (x) => (cfg().lots ? x.lot : 1);
  const R = (side) => (side === "ce" ? "CE" : "PE");
  const prem = (q) => O.mid(q);
  const COLS = {
    bu: { label: "Build-up", title: "OI build-up: LB long build-up, SB short build-up, SC short covering, LU long unwinding", cls: "opt-x", v: (q) => O.buildup(q), r: (q) => { const b = O.buildup(q); return b ? h("span", { class: `bu bu-${b}`, title: O.BUILDUP_NAMES[b] }, b) : h("span", { class: "muted" }, DASH); } },
    oi: {
      label: "OI",
      title: "Open interest; the three largest per side are the OI walls",
      v: (q, row, side, x) => [q?.oi, x.sm.maxOi, x.topOi[side].get(row.strike) ?? 0],
      r: (q, row, side, x) => {
        const rank = x.topOi[side].get(row.strike);
        return barred(formatCompact(num(q?.oi) === null ? null : q.oi / unit(x)), x.sm.maxOi ? (num(q?.oi) ?? 0) / x.sm.maxOi : 0, `oi ${rank === 1 ? "wall" : rank ? "wall2" : ""}`, cfg().bars.oi);
      },
    },
    chg: {
      label: "OI chg",
      v: (q, row, side, x) => [q?.oiChange, q?.oi, x.sm.maxOiChange],
      r: (q, row, side, x) => {
        const v = num(q?.oiChange);
        const pct = O.oiChangePct(q);
        const text = two(formatCompact(v === null ? null : v / unit(x), { signed: true }), { text: pct === null ? "" : formatPercent(pct, 1) }, v > 0 ? "up" : v < 0 ? "down" : undefined);
        return barred(text, x.sm.maxOiChange ? Math.abs(v ?? 0) / x.sm.maxOiChange : 0, v < 0 ? "neg" : "pos", cfg().bars.chg);
      },
    },
    vol: {
      label: "Volume",
      cls: "opt-x",
      v: (q, row, side, x) => [q?.volume, x.hot.has(q?.symbol), x.maxVol],
      r: (q, row, side, x) => {
        const hot = x.hot.has(q?.symbol);
        const text = h("span", { class: hot ? "hot" : undefined, title: hot ? "Unusual: volume ÷ OI well above the rest of the chain" : undefined }, formatCompact(num(q?.volume) === null ? null : q.volume / unit(x)));
        return barred(text, x.maxVol ? (num(q?.volume) ?? 0) / x.maxVol : 0, "vol", cfg().bars.vol);
      },
    },
    iv: { label: "IV", v: (q) => q?.iv, r: (q) => g(q?.iv, 1) },
    ltp: {
      label: "LTP",
      ltp: true,
      v: (q, row, side, x) => [q?.ltp, q?.change, x.held.get(q?.symbol)],
      r: (q, row, side, x) => {
        const pct = O.changePct(q);
        const held = x.held.get(q?.symbol);
        return h(
          "span",
          { class: "two" },
          h("strong", {}, held ? h("span", { class: `held ${held > 0 ? "long" : "short"}`, title: `You hold ${formatSigned(held, 0)} lot(s)` }, formatSigned(held, 0)) : null, g(q?.ltp, 2)),
          cfg().pct ? h("small", { class: pct > 0 ? "up" : pct < 0 ? "down" : undefined }, pct === null ? "" : formatSigned(pct, 1)) : null,
        );
      },
    },
    delta: { label: "Delta", v: (q) => q?.delta, r: (q) => g(q?.delta, 2) },
    gamma: { label: "Gamma", cls: "opt-x", v: (q) => q?.gamma, r: (q) => g(q?.gamma, 4) },
    theta: { label: "Theta", v: (q) => q?.theta, r: (q) => g(q?.theta, 1) },
    vega: { label: "Vega", cls: "opt-x", v: (q) => q?.vega, r: (q) => g(q?.vega, 1) },
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
      title: "Premium above intrinsic value on the forward (what decays to zero by expiry)",
      v: (q, row, side, x) => [prem(q), Math.round((x.F ?? 0) * 10)],
      r: (q, row, side, x) => {
        const v = O.extrinsic(row.strike, R(side), prem(q), x.F);
        return v !== null && v < -0.05 ? h("span", { class: "down", title: "Below intrinsic on the forward: parity break or stale quote" }, g(v, 2)) : g(v, 2);
      },
    },
    spread: {
      label: "Spread",
      title: "Bid-ask spread as % of mid",
      v: (q) => [q?.bid, q?.ask],
      r: (q) => {
        const p = O.spreadPct(q);
        return h("span", { class: p > 10 ? "down" : p > 5 ? "warn-ink" : undefined }, formatPercent(p, 1));
      },
    },
    liq: { label: "Liquidity", cls: "opt-x", v: (q, row, side, x) => O.liquidityScore(q, x.ranks[side].get(row.strike)), r: (q, row, side, x) => dots(O.liquidityScore(q, x.ranks[side].get(row.strike))) },
    prem: { label: "Traded", title: "Premium traded today (volume × lot × LTP)", cls: "opt-x", v: (q, row, side, x) => [q?.volume, q?.ltp, x.lot], r: (q, row, side, x) => (isFigure(q?.volume) && isFigure(q?.ltp) ? `₹${formatCompact(q.volume * x.lot * q.ltp)}` : DASH) },
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
      label: "PoP buy",
      title: "A buyer's chance of profit at expiry: P(price beyond the breakeven), log-normal at the leg's IV",
      v: (q, row, side, x) => [prem(q), q?.iv, Math.round(x.F ?? 0)],
      r: (q, row, side, x) => {
        const p = O.chanceOfProfit(x.F, row.strike, x.years, num(q?.iv) ?? x.sm.atmIv, R(side), prem(q));
        return formatPercent(p === null ? null : p * 100, 0);
      },
    },
    pops: {
      label: "PoP sell",
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
    thetaLot: { label: "θ/lot", title: "Theta per lot: rupees a long position loses in a day", v: (q, row, side, x) => [q?.theta, x.lot], r: (q, row, side, x) => rupees(num(q?.theta) === null ? null : q.theta * x.lot) },
    ivx: {
      label: "IV−ATM",
      title: "This strike's IV minus ATM IV (vol points): what you pay over the at-the-money volatility",
      v: (q, row, side, x) => [q?.iv, x.sm.atmIv, cfg().preset === "buyer"],
      r: (q, row, side, x) => {
        const v = num(q?.iv) !== null && x.sm.atmIv !== null ? q.iv - x.sm.atmIv : null;
        return h("span", { class: cfg().preset === "buyer" && v > 2 ? "warn-ink" : undefined }, isFigure(v) ? formatSigned(v, 1) : DASH);
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
        return h("span", { class: `two${s.twoSided ? "" : " quiet"}` }, h("span", {}, formatFixed(s.mid, 1)), h("small", {}, s.twoSided ? `${formatFixed(s.sell, 1)} – ${formatFixed(s.buy, 1)}` : ""));
      },
    },
    dev: {
      label: "Dev",
      row: true,
      head: (x) => (x.refKind === "fut" ? "Dev" : "Dev vs F"),
      title: "Synthetic minus the same-expiry future (or the chain forward when none is listed), in points; under it, ₹ per lot",
      v: (row, r_, s_, x) => [x.syn.get(row.strike)?.mid, x.ref, x.lot],
      r: (row, r_, s_, x) => {
        const m = x.syn.get(row.strike)?.mid;
        const d = m !== undefined && m !== null && x.ref !== null ? m - x.ref : null;
        return two(isFigure(d) ? formatSigned(d, 1) : DASH, { text: isFigure(d) ? formatRupee(d * x.lot, 0) : "", force: true });
      },
    },
    edge: {
      label: "Edge",
      row: true,
      title: "Best of conversion (sell synthetic, buy the future at its ask) and reversal (buy synthetic, sell the future at its bid) at the touch, before costs",
      v: (row, r_, s_, x) => { const e = x.edge.get(row.strike); return [e?.edge, e?.kind]; },
      r: (row, r_, s_, x) => {
        const e = x.edge.get(row.strike);
        if (!e) return DASH;
        return h("span", { class: "two", title: x.refKind === "fut" ? undefined : "vs chain forward: a relative break across strikes, not a futures arbitrage" }, h("span", { class: e.edge > 0 ? "pos-accent" : undefined }, formatSigned(e.edge, 2)), h("small", {}, e.kind));
      },
    },
    ivskew: {
      label: "IV P−C",
      row: true,
      title: "Put IV minus call IV at this strike (vol points)",
      v: (row) => [row.pe?.iv, row.ce?.iv],
      r: (row) => (num(row.pe?.iv) !== null && num(row.ce?.iv) !== null ? formatSigned(row.pe.iv - row.ce.iv, 1) : DASH),
    },
    bid: { label: "Bid", trade: "SELL" },
    ask: { label: "Ask", trade: "BUY" },
  };
  for (const [k, , scope] of CHAIN_COLUMNS) if (scope === "row") COLS[k].row = true;

  /**
   * Cells per part, in screen order. Both sides: calls mirror puts around the strike (row columns just right of
   * it). One side: the strike comes first and that side reads outwards from it. Phones show the strike and at most
   * three columns; touch screens trade from the action sheet instead of the bid / ask buttons.
   */
  const layout = () => {
    const c = cfg();
    const d = device();
    const preset = c.preset;
    const sideCols = c.cols.filter((k) => COLS[k] && !COLS[k].row);
    const rowCols = c.cols.filter((k) => COLS[k]?.row);
    const optX = (k, list) => (preset !== "custom" ? (PRESET_OPT_X[preset] ?? []).includes(k) : COLS[k].cls === "opt-x" || list.indexOf(k) >= 5);
    const ox = new Set([...sideCols.filter((k) => optX(k, sideCols)), ...rowCols.filter((k) => optX(k, rowCols))]);
    let side = d.phone ? c.phoneSide : c.side;
    let inner = sideCols;
    let mid = rowCols;
    if (d.phone) {
      if (preset === "arb") {
        mid = rowCols.filter((k) => !ox.has(k)).slice(0, 3);
        inner = [];
        side = "none";
      } else if (side === "both") {
        inner = ["ltp", "oi"];
        mid = [];
      } else {
        inner = sideCols.filter((k) => !ox.has(k)).slice(0, 3);
        mid = [];
      }
      ox.clear();
    } else if (d.narrow) {
      // Tablets: the columns marked opt-x are left out (not just hidden, so the side headers span the right cells).
      inner = sideCols.filter((k) => !ox.has(k));
      mid = rowCols.filter((k) => !ox.has(k));
      ox.clear();
    }
    const near = c.quotes && !d.phone && !d.coarse ? ["bid", "ask"] : [];
    const out = [...near, ...inner];
    const base = { side, mid, ox, phone: d.phone, narrow: d.narrow, coarse: d.coarse };
    if (side === "none") return { ...base, order: ["strike", "mid"], ce: [], pe: [] };
    if (side === "ce") return { ...base, order: ["strike", "mid", "ce"], ce: out, pe: [] };
    if (side === "pe") return { ...base, order: ["strike", "mid", "pe"], ce: [], pe: out };
    return { ...base, order: ["ce", "strike", "mid", "pe"], ce: [...inner].reverse().concat(near), pe: out };
  };
  const layoutSig = (L) => JSON.stringify([L.order, L.ce, L.pe, L.mid, [...L.ox], L.phone, L.narrow, L.coarse, cfg().dense, cfg().lots, cfg().pct, cfg().bars, cfg().tags, cfg().itm, cfg().positions]);

  function tradeButton(q, row, side, trade) {
    const price = trade === "BUY" ? q?.ask : q?.bid;
    if (!q || !isFigure(price)) return h("span", { class: "muted", title: "No quote on this side" }, DASH);
    const right = R(side);
    const label = `${trade === "BUY" ? "Buy" : "Sell"} ${formatInt(row.strike)} ${right} at ${formatFixed(price, 2)}`;
    return h("button", { type: "button", class: `q-btn ${trade === "BUY" ? "buy" : "sell"}`, title: st.account ? label : "Choose an account that can place orders", "aria-label": label, disabled: !st.account, onclick: (e) => { e.stopPropagation(); onTrade(row, right, trade); } }, formatFixed(price, 2));
  }
  const cellCls = (k, L, extra = "") => `num ${L.ox.has(k) ? "opt-x" : ""} c-${k} ${extra}`.replace(/\s+/g, " ").trim();
  const headText = (k, x) => (COLS[k].head && x ? COLS[k].head(x) : k === "oi" && cfg().lots ? "OI (lots)" : k === "vol" && cfg().lots ? "Vol (lots)" : COLS[k].label);
  const headCell = (k, L, extra) => h("th", { scope: "col", class: cellCls(k, L, extra), title: COLS[k].title }, COLS[k].short ? [h("span", { class: "lbl-long" }, headText(k, null)), h("span", { class: "lbl-short", "aria-hidden": "true" }, COLS[k].short)] : headText(k, null));

  /** One strike's row: its cells by part, and the click / double-click that focus it or open its sheet. */
  function makeRow(strike, L) {
    const ce = L.ce.map((k) => h("td", { class: cellCls(k, L) }));
    const pe = L.pe.map((k) => h("td", { class: cellCls(k, L) }));
    const mid = L.mid.map((k) => h("td", { class: cellCls(k, L, "mid-col") }));
    const th = h("th", { scope: "row", class: "strike-col" });
    const tr = h("tr", { "data-strike": strike, tabindex: "-1" }, L.order.map((part) => (part === "strike" ? th : part === "ce" ? ce : part === "pe" ? pe : mid)));
    const sideOf = (e) => {
      const cell = e.target.closest("td");
      if (cell && pe.includes(cell)) return "pe";
      if (cell && ce.includes(cell)) return "ce";
      if (L.side === "ce" || L.side === "pe") return L.side;
      return st.focus?.side ?? "ce";
    };
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const side = sideOf(e);
      onFocus({ strike, side });
      const d = device();
      if (d.phone || d.coarse) onOpen(strike, side);
    });
    tr.addEventListener("dblclick", (e) => {
      if (e.target.closest("button") || device().coarse) return;
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
      h("button", { type: "button", class: "side-btn", title: c.side === side ? "Show calls and puts" : `Show ${label.toLowerCase()} only`, "aria-pressed": String(c.side === side), onclick: () => onSide(c.side === side ? "both" : side) }, side === "ce" ? "‹ " : "", label, side === "pe" ? " ›" : "");
    const midHead = L.mid.length ? [h("th", { colspan: L.mid.length, scope: "colgroup", class: "mid-col" }, "Parity")] : [];
    const sideHead = L.phone
      ? null
      : L.side === "both"
        ? h("tr", { class: "side-head" }, h("th", { colspan: L.ce.length, scope: "colgroup" }, sideBtn("ce", "Calls")), h("th", { class: "strike-col" }, ""), midHead, h("th", { colspan: L.pe.length, scope: "colgroup" }, sideBtn("pe", "Puts")))
        : h("tr", { class: "side-head" }, h("th", { class: "strike-col" }, ""), midHead, h("th", { colspan: L.ce.length + L.pe.length, scope: "colgroup" }, h("button", { type: "button", class: "side-btn on", onclick: () => onSide("both") }, `${L.side === "ce" ? "Calls" : "Puts"} only`, h("span", { "aria-hidden": "true" }, " ×"))));
    const heads = [];
    const colHead = L.order.flatMap((part) => {
      if (part === "strike") return [h("th", { scope: "col", class: "strike-col" }, "Strike")];
      return L[part].map((k) => {
        const th = headCell(k, L, part === "mid" ? "mid-col" : "");
        if (COLS[k].head) heads.push([th, k]);
        return th;
      });
    });
    const thead = h("thead", {}, sideHead, h("tr", { class: `col-head${L.phone ? " first" : ""}` }, colHead));
    const map = new Map();
    const body = h("tbody");
    for (const row of x.c.rows) {
      const r = makeRow(row.strike, L);
      body.append(r.tr);
      map.set(row.strike, r);
    }
    const spotTag = h("span", { class: "spot-tag" });
    const spotTr = h("tr", { class: "spot-row", "aria-hidden": "true" }, h("td", { colspan: span }, spotTag));
    const cells = (part) => L[part].map((k) => h("td", { class: cellCls(k, L, part === "mid" ? "mid-col" : "") }));
    const foot = { ce: cells("ce"), th: h("th", { scope: "row", class: "strike-col" }), mid: cells("mid"), pe: cells("pe") };
    const caption = h("caption", { class: "sr-only" });
    const table = h(
      "table",
      { class: `chain side-${L.side}${c.dense ? " dense" : ""}${L.phone ? " phone" : ""}` },
      caption,
      thead,
      body,
      h("tfoot", {}, h("tr", {}, L.order.map((part) => (part === "strike" ? foot.th : foot[part])))),
    );
    const wrap = h("div", { class: "table-wrap chain-wrap" }, table);
    built = { key, table, thead, rows: map, spotTr, spotTag, foot, L, body, wrap, heads, caption, atmObserved: null };
    return wrap;
  }

  /** Patch one cell when what it depends on changed; LTP changes are queued to flash in one frame. */
  function patchCell(td, k, q, row, side, x, flashes) {
    const col = COLS[k];
    if (col.trade) {
      const price = col.trade === "BUY" ? q?.ask : q?.bid;
      const sig = `${price}|${st.account ? 1 : 0}`;
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
    if (col.ltp) {
      const now = num(q?.ltp);
      const prev = td.__ltp;
      td.__ltp = now;
      if (prev !== undefined && prev !== null && now !== null && now !== prev) flashes.push([td, now > prev]);
    }
  }

  /**
   * Put new content in a cell by changing the live nodes in place (text, classes, titles) when the shape is the same:
   * far fewer DOM mutations per tick than replacing the cell's children.
   */
  function setCell(td, content) {
    if (typeof content === "string" || typeof content === "number") {
      const t = String(content);
      const f = td.firstChild;
      if (f && f === td.lastChild && f.nodeType === 3) {
        if (f.data !== t) f.data = t;
      } else td.textContent = t;
      return;
    }
    const f = td.firstChild;
    if (!(f && f === td.lastChild && morph(f, content))) td.replaceChildren(content);
  }

  /** The row to keep still while rows above it appear or disappear: the focus when on screen, else the top row. */
  function captureAnchor() {
    const wrap = built?.wrap;
    if (!wrap?.isConnected || !wrap.clientHeight) return null;
    const top = wrap.getBoundingClientRect().top + (built.thead.offsetHeight || 0);
    const bottom = wrap.getBoundingClientRect().top + wrap.clientHeight;
    const f = st.focus ? built.rows.get(st.focus.strike) : null;
    if (f && !f.tr.hidden) {
      const r = f.tr.getBoundingClientRect();
      if (r.bottom > top && r.top < bottom) return { strike: st.focus.strike, off: r.top - top };
    }
    for (const [strike, b] of built.rows) {
      if (b.tr.hidden) continue;
      const r = b.tr.getBoundingClientRect();
      if (r.bottom > top) return { strike, off: r.top - top };
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
  const visibleSet = (x) => new Set(O.rowsAroundAtm(x.c, st.strikesView === "all" ? Infinity : Number(st.strikesView) || 10).map((r) => r.strike));

  function patch(x) {
    const { sm, spot } = x;
    const c = cfg();
    const L = built.L;
    const flashes = [];
    // The ±N window: rows are hidden, never rebuilt, and the view stays put through an anchor row.
    const vis = visibleSet(x);
    let moved = false;
    for (const [strike, b] of built.rows) if (b.tr.hidden === vis.has(strike)) moved = true;
    if (moved) {
      const a = captureAnchor();
      for (const [strike, b] of built.rows) b.tr.hidden = !vis.has(strike);
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
        const dt = x.targets[side].get(row.strike);
        L[side].forEach((k, i) => {
          const td = cells[i];
          patchCell(td, k, q, row, side, x, flashes);
          if (td.__itm !== itm) td.classList.toggle("itm", (td.__itm = itm));
          if (k === "delta" && td.__dt !== (dt ?? "")) {
            td.__dt = dt ?? "";
            td.classList.toggle("dt", Boolean(dt));
            td.title = dt ? `${dt} strike` : "";
          }
        });
      }
      L.mid.forEach((k, i) => patchCell(b.mid[i], k, null, row, "mid", x, flashes));
      const tags = [];
      if (row.strike === sm.atm) tags.push(["atm", "ATM", "At the money"]);
      if (c.tags.mp && row.strike === sm.maxPain) tags.push(["mp", "Max Pain", "Settlement at which option buyers collect the least"]);
      if (c.tags.walls && row.strike === sm.resistance?.strike) tags.push(["cw", "Resistance", "Most call OI loaded"]);
      if (c.tags.walls && row.strike === sm.support?.strike) tags.push(["pw", "Support", "Most put OI loaded"]);
      if (c.tags.em && row.strike === x.em1.hi) tags.push(["em", "+1σ", "Upper edge of the expected move (log-normal, ATM IV to expiry)"]);
      if (c.tags.em && row.strike === x.em1.lo) tags.push(["em", "−1σ", "Lower edge of the expected move (log-normal, ATM IV to expiry)"]);
      if (c.tags.em2 && row.strike === x.em2.hi) tags.push(["em2", "+2σ", "Two standard deviations up (about 2.3% of outcomes land above)"]);
      if (c.tags.em2 && row.strike === x.em2.lo) tags.push(["em2", "−2σ", "Two standard deviations down (about 2.3% of outcomes land below)"]);
      const shown = L.phone ? tags.slice(0, 2) : tags;
      const sig = `${row.strike}|${shown.map((t) => t[1]).join(",")}`;
      if (b.th.__sig !== sig) {
        b.th.__sig = sig;
        b.th.replaceChildren(h("span", { class: "k" }, formatInt(row.strike)), ...(shown.length ? [h("span", { class: "tags" }, shown.map(([cl, t, title]) => h("span", { class: `tag ${cl}`, title }, t)))] : []));
      }
      const atm = row.strike === sm.atm;
      const inEm = c.tags.em && x.em1.lo !== null && row.strike >= x.em1.lo && row.strike <= x.em1.hi;
      if (b.__atm !== atm) b.tr.classList.toggle("atm", (b.__atm = atm));
      if (b.__em !== inEm) b.tr.classList.toggle("in-em", (b.__em = inEm));
    }
    for (const [th, k] of built.heads) {
      const t = headText(k, x);
      if (th.textContent !== t) th.textContent = t;
    }
    drawSpot(x);
    // Footer: totals over the strikes loaded; PCR under the strikes; the median deviation under Dev.
    const u = unit(x);
    const totals = { oi: [sm.ceOi / u, sm.peOi / u], chg: [sm.ceOiChange / u, sm.peOiChange / u], vol: [sm.ceVolume / u, sm.peVolume / u] };
    for (const [i, side] of [[0, "ce"], [1, "pe"]]) {
      L[side].forEach((k, j) => {
        const v = totals[k]?.[i];
        const t = v === undefined ? "" : k === "chg" ? formatCompact(v, { signed: true }) : formatCompact(v);
        if (built.foot[side][j].textContent !== t) built.foot[side][j].textContent = t;
      });
    }
    L.mid.forEach((k, j) => {
      const t = k === "dev" && x.medianDev !== null ? `${formatSigned(x.medianDev, 1)} med` : "";
      if (built.foot.mid[j].textContent !== t) built.foot.mid[j].textContent = t;
    });
    const pcrSig = `${sm.pcr}|${x.c.rows.length}`;
    if (built.foot.th.__sig !== pcrSig) {
      built.foot.th.__sig = pcrSig;
      built.foot.th.replaceChildren(h("small", {}, "PCR "), formatFixed(sm.pcr, 2));
      built.foot.th.title = `Put OI ÷ call OI over the ${formatInt(x.c.rows.length)} strikes loaded (±${FETCH_STRIKES} around ATM)`;
    }
    const cap = `${x.c.underlying} ${expiryText(x.c.expiry)} option chain, ${L.side === "both" ? "calls left, puts right" : L.side === "ce" ? "calls" : L.side === "pe" ? "puts" : "put-call parity"}`;
    if (built.caption.textContent !== cap) built.caption.textContent = cap;
    watchAtm(sm.atm);
    if (flashes.length && !reducedMotion()) {
      // One frame for every flash; two identical keyframe names restart the animation without a forced reflow.
      requestAnimationFrame(() => {
        for (const [td, up] of flashes) {
          const base = up ? "flash-up" : "flash-down";
          const next = td.__fl === base ? `${base}2` : base;
          if (td.__fl) td.classList.remove(td.__fl);
          td.classList.add(next);
          td.__fl = next;
        }
      });
    }
  }

  function drawSpot(x) {
    const { spot } = x;
    if (spot === null) return built.spotTr.remove();
    const q = x.indexQuote;
    const ch = num(q?.change);
    const chp = num(q?.changePct);
    const fut = x.sameFut;
    const sig = JSON.stringify([spot, ch, chp, fut?.ltp, x.F]);
    if (built.spotTag.__sig !== sig) {
      built.spotTag.__sig = sig;
      // Phones drop the absolute change and the basis (class "wide") so the row never widens the table.
      built.spotTag.replaceChildren(
        ...[
          h("strong", {}, `${x.c.underlying} ${formatFixed(spot, 2)}`),
          ch !== null ? h("span", { class: ch > 0 ? "up" : ch < 0 ? "down" : undefined }, h("span", { class: "wide" }, ` ${formatSigned(ch, 2)}`), chp !== null ? ` (${formatSigned(chp, 2)}%)` : "") : null,
          fut && num(fut.ltp) !== null
            ? h("span", { class: "fut", title: "Same-expiry future and its basis to spot" }, ` · Fut ${formatFixed(fut.ltp, 2)}`, h("span", { class: "wide" }, ` (${formatSigned(fut.ltp - spot, 2)})`))
            : x.F !== null
              ? h("span", { class: "fut", title: "No future is listed for this expiry: the forward from put-call parity" }, ` · F ${formatFixed(x.F, 1)}`, h("span", { class: "wide" }, " (synthetic)"))
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
    if (built.spotTr.nextSibling !== anchor || !built.spotTr.isConnected) built.body.insertBefore(built.spotTr, anchor);
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

  // ── Phone: one side at a time, a sticky Calls | Puts | Both switch, and a swipe between calls and puts ──
  const phoneSeg = segmented("Show on phone", [["ce", "Calls"], ["pe", "Puts"], ["both", "Both"]], cfg().phoneSide);
  phoneSeg.addEventListener("change", () => onPhoneSide(phoneSeg.value));
  const parityNote = h("span", { class: "parity-note" }, "Parity view");
  const phoneBar = h("div", { class: "phone-side" }, phoneSeg, parityNote);
  const note = h("div", { class: "chain-note", role: "status", hidden: true });
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
    const view = w.clientHeight - (built.thead.offsetHeight || 0) - 30;
    w.scrollTop += tr.getBoundingClientRect().top - top - (view - tr.offsetHeight) / 2;
  };

  const self = {
    reset(keepView = false) {
      if (!keepView) {
        built = null;
        centred = false;
        observer?.disconnect();
        pill.hidden = true;
      } else if (built) built.stale = true;
    },
    draw(x) {
      lastX = x;
      if (!x.c.rows.length) {
        host.replaceChildren(emptyState("chart", "No strikes", `No strikes for ${x.c.underlying} ${expiryText(x.c.expiry)}.`));
        built = null;
        return;
      }
      const L = layout();
      const key = [x.c.underlying, x.c.expiry, layoutSig(L)].join("|");
      drawPhoneBar(L);
      if (built && built.key === key && !built.stale) {
        syncRows(x);
        return patch(x);
      }
      // A new table: only when the strike list or the layout changed. Keep the view on the same strike.
      const old = built;
      const anchor = old?.wrap.isConnected ? captureAnchor() : null;
      const keepX = old?.wrap.isConnected ? old.wrap.scrollLeft : null;
      const wrap = build(x, L, key);
      patch(x);
      if (old?.wrap.isConnected && host.contains(old.wrap)) old.wrap.replaceWith(wrap);
      else host.replaceChildren(phoneBar, note, wrap, pill, live);
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
        if (keepX !== null) wrap.scrollLeft = keepX;
        else if (L.side === "both") wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;
        if (anchor && restoreAnchor(anchor)) centred = true;
        else if (!centred) {
          const atm = built?.rows.get(x.sm.atm)?.tr;
          if (atm && wrap.scrollHeight > wrap.clientHeight) centre(atm);
          centred = true;
        }
      };
      if (wrap.isConnected && wrap.clientWidth) place();
      else requestAnimationFrame(place);
    },
    /** A one-line status above the table (errors after data), or null to hide it. */
    note(text) {
      note.hidden = !text;
      if (note.textContent !== (text ?? "")) note.textContent = text ?? "";
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
          else if (r.bottom > wr.top + w.clientHeight - 30) w.scrollTop += r.bottom - (wr.top + w.clientHeight - 30);
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
    visibleStrikes: () => (built?.rows ? [...built.rows].filter(([, b]) => !b.tr.hidden).map(([k]) => k) : []),
    atmStrike: () => O.atmRow(st.chain)?.strike ?? null,
    /** The side a key or tap acts on in the current layout. */
    sideNow: () => (built?.L.side === "ce" || built?.L.side === "pe" ? built.L.side : st.focus?.side ?? "ce"),
    layoutSide: () => built?.L.side ?? null,
    colTitle: (k) => COLS[k]?.title,
    isRowCol: (k) => Boolean(COLS[k]?.row),
    get x() {
      return lastX;
    },
  };
  return self;
}

/** Contracts whose volume ÷ OI stands out from the rest of the chain (at least 3× the median, top 4 per side). */
function unusualVolume(rows) {
  const out = new Set();
  for (const side of ["ce", "pe"]) {
    const legs = rows.map((r) => r[side]).filter((q) => num(q?.volume) > 0 && num(q?.oi) > 0).map((q) => ({ symbol: q.symbol, r: q.volume / q.oi }));
    if (legs.length < 5) continue;
    const sorted = legs.map((l) => l.r).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    legs.sort((a, b) => b.r - a.r).slice(0, 4).filter((l) => l.r >= 3 * median).forEach((l) => out.add(l.symbol));
  }
  return out;
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
