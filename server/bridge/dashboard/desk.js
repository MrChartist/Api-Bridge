// The Option Desk: a live option chain you can trade from, a strategy builder with payoffs, the OI profile and your
// positions on the same underlying. Data is GET /v1/expiries, /v1/optionchain and /v1/positions; orders go through
// POST /v1/orders/preview and /v1/orders like every other client, so the Bridge's safety gates apply unchanged.
//
// Built for refresh every few seconds: the chain table is built once per (underlying, expiry, strikes, columns) and
// then patched cell by cell, so nothing flickers, scroll and keyboard focus stay put, and only cells that changed
// flash. The maths lives in options.js (pure, tested); numbers are formatted by format.js only.
import { alertBox, api, app, card, emptyState, h, icon, istTime, modal, optional, pill, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { cap, every, keepFocus, pnl, segField, segmented, stopTimer } from "./views.js";

const SLOT = "mcb.dashboard.desk";
const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const DEMO_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"];
/** Strikes fetched either side of ATM: wide enough for PCR, max pain and the OI profile, whatever is shown. */
const FETCH_STRIKES = 40;
const REFRESH_MS = 3000;
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryText = (e) => (/^\d{4}-\d{2}-\d{2}$/.test(e ?? "") ? EXPIRY_DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
/** "NIFTY 3 Nov 26400 CE" */
const contractName = (u, expiry, strike, right) => `${u} ${expiryText(expiry)} ${formatInt(strike)} ${right}`;
const num = (v) => (isFigure(v) ? Number(v) : null);
/** One decimal for SVG coordinates (geometry, not display text). */
const r1 = (v) => Math.round(v * 10) / 10;
const local = app.local;
const readPrefs = () => {
  try {
    return JSON.parse(local.get(SLOT) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

// ── SVG helper (h() makes HTML elements) ──
const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

// Keyboard: one listener for the life of the tab; it acts on the desk on screen, if any.
let activeDesk = null;
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    const d = activeDesk;
    if (!d || !d.root.isConnected || e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    if (d.onKey(e)) e.preventDefault();
  });
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
    strikes: ["8", "12", "20"].includes(prefs.strikes) ? prefs.strikes : "12",
    view: ["oi", "greeks", "value"].includes(prefs.view) ? prefs.view : "oi",
    account: tradable.some((a) => a.id === prefs.account) ? prefs.account : (tradable.find((a) => a.broker === "paper") ?? tradable[0])?.id ?? null,
    live: prefs.live !== false,
    baskets: prefs.baskets && typeof prefs.baskets === "object" ? prefs.baskets : {},
    profile: prefs.profile === "change" ? "change" : "oi",
    chain: null,
    freshness: null,
    error: null,
    ms: null,
    positions: [],
    positionsError: null,
    focus: null, // { strike, side: "ce" | "pe" }
    seq: 0,
  };
  const save = () => local.set(SLOT, JSON.stringify({ underlying: st.underlying, expiry: st.expiry, strikes: st.strikes, view: st.view, account: st.account, live: st.live, baskets: st.baskets, profile: st.profile }));
  const account = () => tradable.find((a) => a.id === st.account) ?? null;
  const basketKey = () => `${st.underlying}|${st.expiry}`;
  const basket = () => (st.baskets[basketKey()] ??= []);

  // ── Toolbar ──
  const uSel = h("select", { "aria-label": "Underlying", class: "desk-u" }, list.map((u) => h("option", { value: u, selected: u === st.underlying }, u)));
  const eSel = h("select", { "aria-label": "Expiry" });
  const strikesSeg = segmented("Strikes each side of ATM", [["8", "±8"], ["12", "±12"], ["20", "±20"]], st.strikes);
  const viewSeg = segmented("Columns", [["oi", "OI"], ["greeks", "Greeks"], ["value", "Value"]], st.view);
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
  };
  const statsEl = h("div", { class: "desk-stats", role: "group", "aria-label": "Chain summary" });
  const chainEl = h("div", { class: "desk-chain" });
  const keysEl = h(
    "div",
    { class: "desk-keys" },
    [["J", "K"], "strike", ["←", "→"], "side", ["B"], "buy", ["S"], "sell", ["⇧B", "⇧S"], "add to strategy", ["G"], "ATM", ["P"], "pause"].map((x) =>
      Array.isArray(x) ? h("span", { class: "kbd-group" }, x.map((k) => h("kbd", {}, k))) : h("span", {}, x),
    ),
  );
  const builderEl = h("div");
  const adderEl = h("div");
  const profileEl = h("div");
  const oiMoreEl = h("div", { class: "grid desk-split" });
  const posEl = h("div");

  // ── Data ──
  async function loadExpiries() {
    const seq = ++st.seq;
    eSel.disabled = true;
    try {
      const r = await api(`/v1/expiries?underlying=${encodeURIComponent(st.underlying)}`);
      if (seq !== st.seq) return false;
      const ex = r.data.data?.expiries ?? [];
      if (!ex.length) throw new Error(`No upcoming expiries for ${st.underlying}.`);
      if (!ex.includes(st.expiry)) st.expiry = ex[0];
      eSel.replaceChildren(...ex.map((e) => h("option", { value: e, selected: e === st.expiry }, `${expiryText(e)} · ${O.timeToExpiry(e).label}`)));
      eSel.disabled = false;
      return true;
    } catch (err) {
      if (seq !== st.seq) return false;
      eSel.replaceChildren(h("option", { value: "" }, "No expiries"));
      st.chain = null;
      st.error = err;
      drawAll();
      return false;
    }
  }
  async function loadChain() {
    if (!st.expiry) return;
    const seq = st.seq;
    const t0 = performance.now();
    try {
      const r = await api(`/v1/optionchain?underlying=${encodeURIComponent(st.underlying)}&expiry=${encodeURIComponent(st.expiry)}&strikes=${FETCH_STRIKES}&greeks=true`);
      if (seq !== st.seq) return;
      st.chain = r.data.data;
      st.freshness = r.data.data?.freshness ?? r.data.meta?.freshness ?? null;
      st.ms = Math.round(performance.now() - t0);
      st.error = null;
    } catch (err) {
      if (seq !== st.seq) return;
      st.error = err;
    }
    drawAll();
  }
  async function loadPositions() {
    if (!st.account) return drawPositions();
    const r = await optional(api(`/v1/positions?account=${encodeURIComponent(st.account)}`));
    st.positions = O.positionsFor(r.data?.data ?? [], st.underlying);
    st.positionsError = r.error ?? null;
    drawPositions();
  }
  const refresh = () => Promise.all([loadChain(), loadPositions()]);
  const startTimer = () => (st.live ? every(REFRESH_MS, refresh) : stopTimer());
  async function reloadAll() {
    chain.reset();
    st.chain = null;
    st.focus = null;
    drawAll();
    if (await loadExpiries()) await refresh();
    else await loadPositions();
  }

  // ── Derived context for one draw ──
  function context() {
    const c = st.chain;
    const sm = O.chainSummary(c);
    const years = O.yearsToExpiry(c.expiry);
    const F = O.forwardPrice(c) ?? sm.spot;
    const move = O.sigmaMove(F, sm.atmIv, years);
    const strikes = c.rows.map((r) => r.strike);
    const near = (x) => (x === null ? null : strikes.reduce((b, k) => (Math.abs(k - x) < Math.abs(b - x) ? k : b), strikes[0]));
    return {
      c,
      sm,
      years,
      F,
      move,
      spot: sm.spot,
      lot: num(c.lotSize) || 1,
      targets: O.deltaTargets(c.rows),
      ranks: { ce: O.volumeRanks(c.rows, "ce"), pe: O.volumeRanks(c.rows, "pe") },
      hot: unusualVolume(c.rows),
      emUp: move ? near(F + move) : null,
      emDown: move ? near(F - move) : null,
    };
  }

  function drawAll() {
    drawClock();
    if (!st.chain) {
      chain.reset();
      statsEl.replaceChildren();
      chainEl.replaceChildren(st.error ? h("div", { class: "desk-pad" }, alertBox(st.error)) : h("p", { class: "muted desk-pad" }, "Loading the chain…"));
      builderEl.replaceChildren();
      profileEl.replaceChildren();
      oiMoreEl.replaceChildren();
      return;
    }
    const x = context();
    drawStats(x);
    if (kind === "chain") chain.draw(x);
    if (kind === "strategy") {
      drawAdder(x);
      drawBuilder(x);
    }
    if (kind === "oi") {
      drawProfile(x);
      drawOiMore(x);
    }
  }
  function drawClock() {
    const asOf = st.freshness?.asOf;
    clock.classList.toggle("bad", Boolean(st.error));
    clock.classList.toggle("stale", Boolean(st.freshness?.stale));
    clock.replaceChildren(
      st.error ? "Not updating" : st.freshness?.stale ? "Stale" : "",
      asOf ? ` ${istTime(asOf)}` : "",
      st.ms !== null && !st.error ? h("small", {}, ` ${formatInt(st.ms)} ms`) : null,
    );
    clock.title = st.error ? String(st.error.message ?? st.error) : st.freshness?.accountId ? `Data from ${st.freshness.accountId}` : "";
  }

  // ── Summary strip ──
  function tile(label, value, sub, { cls, title } = {}) {
    return h("div", { class: `desk-stat ${cls ?? ""}`.trim(), title }, h("span", { class: "label" }, label), h("span", { class: "value" }, value), h("span", { class: "sub" }, sub ?? " "));
  }
  function drawStats(x) {
    const { sm, c, F, move, years } = x;
    const day = O.sigmaMove(F, sm.atmIv, 1 / 365);
    const basis = F !== null && sm.spot !== null ? F - sm.spot : null;
    const pcrWord = sm.pcr === null ? "" : sm.pcr >= 1.2 ? "put-heavy" : sm.pcr <= 0.8 ? "call-heavy" : "balanced";
    const t = O.timeToExpiry(c.expiry);
    statsEl.replaceChildren(
      tile(c.underlying, formatFixed(sm.spot, 2), `Fut ${formatInt(F)} (${formatSigned(basis, 1)})`, { title: "Synthetic future from put-call parity (K + C − P), and its basis to spot" }),
      tile("ATM IV", formatPercent(sm.atmIv, 2), day ? `1-day ±${formatInt(day)}` : t.label, { title: "Average of the ATM call and put IV; the 1-day 1σ move it implies" }),
      tile("Expected move", move ? `±${formatInt(move)}` : DASH, move ? `${formatInt(F - move)} – ${formatInt(F + move)}` : "", { title: `IV 1σ to expiry (${t.label}): about 68% of outcomes land inside` }),
      tile("Straddle", formatFixed(sm.straddle, 2), sm.straddle && sm.spot ? `${formatPercent((sm.straddle / sm.spot) * 100, 2)} of spot` : "", { title: "ATM call + put. The market's price for a move either way" }),
      tile("PCR", formatFixed(sm.pcr, 2), `ΔOI ${formatFixed(sm.pcrChange, 2)} · Vol ${formatFixed(sm.pcrVolume, 2)}`, { title: `Put OI ÷ call OI over the whole chain (${pcrWord}); then the same on today's OI change and on volume` }),
      tile("Max pain", formatInt(sm.maxPain), sm.maxPain !== null && sm.spot !== null ? `${formatSigned(sm.maxPain - sm.spot, 0)} from spot` : "", { title: "Settlement at which option buyers would collect the least" }),
      tile("Put wall", formatInt(sm.support?.strike), sm.support ? `OI ${formatCompact(sm.support.oi)}` : "", { cls: "support", title: "Strike with the most put OI (often read as support)" }),
      tile("Call wall", formatInt(sm.resistance?.strike), sm.resistance ? `OI ${formatCompact(sm.resistance.oi)}` : "", { cls: "resistance", title: "Strike with the most call OI (often read as resistance)" }),
    );
    void years;
  }

  // ── The chain ──
  const chain = createChain({
    st,
    host: chainEl,
    onTrade: (row, right, side) => openTicket({ row, right, side }),
    onFocus: (f) => {
      st.focus = f;
      chain.paintFocus();
    },
  });

  function drawAdder() {}
  function drawOiMore() {}
  function drawProfile(x) {
    profileEl.replaceChildren(oiProfile(x, st.profile, (p) => {
      st.profile = p;
      save();
      drawProfile(context());
    }));
  }

  // ── Positions ──
  function drawPositions() {
    const a = account();
    const rows = st.positions.filter((p) => Number(p.netQty) !== 0);
    const lot = num(st.chain?.lotSize);
    const total = rows.reduce((t, p) => t + (Number(p.pnl) || 0), 0);
    const g = { delta: 0, theta: 0 };
    for (const p of rows) {
      const o = O.parseOptionSymbol(p.symbol);
      const q = o && st.chain?.expiry === o.expiry ? st.chain.rows.find((r) => r.strike === o.strike)?.[o.right.toLowerCase()] : null;
      g.delta += (num(q?.delta) ?? 0) * Number(p.netQty);
      g.theta += (num(q?.theta) ?? 0) * Number(p.netQty);
    }
    const exitAll = rows.length ? h("button", { type: "button", class: "small", onclick: () => exitAllPositions(rows) }, "Exit all") : null;
    const analyse = rows.length ? h("button", { type: "button", class: "small tinted", title: "Load these positions into the strategy builder to see their payoff", onclick: () => analysePositions(rows) }, "Analyse") : null;
    keepFocus(posEl, () =>
      posEl.replaceChildren(
        card({
          title: `${st.underlying} positions`,
          sub: a ? (rows.length ? `Net Δ ${formatFixed(g.delta, 0)} · θ ${formatRupee(g.theta, 0)} a day` : a.label) : "Choose an account that can place orders",
          actions: rows.length ? [h("span", { class: "desk-total" }, pnl(total)), analyse, exitAll] : null,
          flush: true,
          cls: "desk-card",
          body: st.positionsError
            ? h("div", { class: "card-body" }, alertBox(st.positionsError))
            : rows.length
              ? h(
                  "div",
                  { class: "table-wrap" },
                  h(
                    "table",
                    { class: "desk-table" },
                    h("thead", {}, h("tr", {}, ["Contract", lot ? "Lots" : "Qty", "Avg", "LTP", "P&L", ""].map((l, i) => h("th", { scope: "col", class: [i > 0 && i < 5 ? "num" : "", i === 2 ? "opt-x" : ""].join(" ").trim() || undefined }, l)))),
                    h(
                      "tbody",
                      {},
                      rows.map((p) => {
                        const o = O.parseOptionSymbol(p.symbol);
                        const q = Number(p.netQty);
                        return h(
                          "tr",
                          {},
                          h("td", {}, h("span", { class: "pos-leg" }, h("span", { class: `side-tag ${q > 0 ? "buy" : "sell"}` }, q > 0 ? "B" : "S"), h("span", {}, h("strong", {}, o ? `${formatInt(o.strike)} ${o.right}` : p.symbol), h("small", {}, o ? `${expiryText(o.expiry)} · ${cap(String(p.product).toLowerCase())}` : p.product)))),
                          h("td", { class: "num", title: `${formatInt(q)} qty` }, lot ? `${formatFixed(q / lot, 0)}` : formatInt(q)),
                          h("td", { class: "num opt-x" }, formatFixed(p.avgPrice, 2)),
                          h("td", { class: "num" }, formatFixed(p.ltp, 2)),
                          h("td", { class: "num" }, pnl(p.pnl)),
                          h("td", { class: "act" }, h("button", { type: "button", class: "small plain", "aria-label": `Exit ${p.symbol}`, onclick: () => exitPosition(p) }, "Exit")),
                        );
                      }),
                    ),
                  ),
                )
              : h("p", { class: "desk-empty" }, `No open ${st.underlying} options. Click a bid or ask in the chain, or press B / S on a strike.`),
        }),
      ),
    );
  }
  function exitPosition(p) {
    const o = O.parseOptionSymbol(p.symbol);
    if (!o) return;
    const row = st.chain?.expiry === o.expiry ? st.chain.rows.find((r) => r.strike === o.strike) : null;
    openTicket({ row: row ?? { strike: o.strike, ce: null, pe: null }, right: o.right, side: Number(p.netQty) > 0 ? "SELL" : "BUY", qty: Math.abs(Number(p.netQty)), symbol: p.symbol, product: p.product, expiry: o.expiry, exit: true });
  }
  async function exitAllPositions(rows) {
    const a = account();
    const ok = await modal({
      title: `Exit all ${st.underlying} positions?`,
      body: h(
        "div",
        { class: "stack" },
        h("p", { class: "muted" }, `${formatInt(rows.length)} market order(s) to ${a?.label}. Short positions are bought back first.`),
        h("ul", { class: "desk-list" }, rows.map((p) => h("li", {}, `${Number(p.netQty) > 0 ? "Sell" : "Buy"} ${formatInt(Math.abs(Number(p.netQty)))} ${p.symbol}`))),
      ),
      buttons: [{ label: "Cancel", value: false }, { label: "Exit all", cls: "danger", value: true }],
    });
    if (!ok) return;
    const ordered = [...rows].sort((x, y) => Number(x.netQty) - Number(y.netQty));
    const out = await sendOrders(ordered.map((p) => ({ account: a.id, symbol: p.symbol, side: Number(p.netQty) > 0 ? "SELL" : "BUY", quantity: Math.abs(Number(p.netQty)), product: p.product, orderType: "MARKET" })), "exit");
    toast(out);
    refresh();
  }
  function analysePositions(rows) {
    const lot = num(st.chain?.lotSize) || 1;
    const legs = [];
    for (const p of rows) {
      const o = O.parseOptionSymbol(p.symbol);
      if (!o || o.expiry !== st.expiry) continue;
      legs.push({ right: o.right, strike: o.strike, side: Number(p.netQty) > 0 ? "BUY" : "SELL", lots: Math.max(1, Math.round(Math.abs(Number(p.netQty)) / lot)), entry: num(p.avgPrice) });
    }
    if (!legs.length) return toast(`Positions on other expiries: switch the expiry to analyse them.`);
    st.baskets[basketKey()] = legs;
    save();
    location.hash = "#/strategy";
  }

  /** Send orders one by one (hedges first is the caller's job); stop at the first refusal. Returns a summary line. */
  async function sendOrders(bodies, tag) {
    const batch = `${tag}-${Date.now().toString(36)}`;
    let done = 0;
    for (const [i, b] of bodies.entries()) {
      try {
        await api("/v1/orders", { method: "POST", body: { ...b, clientOrderId: `${batch}-${i}` } });
        done += 1;
      } catch (err) {
        await modal({ title: `Stopped after ${done} of ${bodies.length}`, body: h("div", { class: "stack" }, h("p", {}, `${b.side} ${b.symbol} was refused; the rest were not sent.`), alertBox(err)), buttons: [{ label: "Close", value: true }] });
        return `${done} of ${bodies.length} orders sent`;
      }
    }
    return `${done} order${done === 1 ? "" : "s"} sent`;
  }

  // ── Strategy builder ──
  const legQuote = (l) => st.chain?.rows.find((r) => r.strike === l.strike)?.[l.right.toLowerCase()] ?? null;
  /** A leg with its price: a fixed entry (analysed positions) or the live touch (ask to buy, bid to sell). */
  const pricedLegs = () => basket().map((l) => {
    const q = legQuote(l);
    return { ...l, symbol: q?.symbol, price: l.entry ?? O.touchPrice(q, l.side) ?? num(q?.ltp), iv: num(q?.iv) ?? O.chainSummary(st.chain).atmIv };
  });
  function addLeg(leg) {
    const legs = basket();
    const same = legs.find((l) => l.strike === leg.strike && l.right === leg.right && l.side === leg.side && l.entry === undefined);
    if (same) same.lots += leg.lots ?? 1;
    else legs.push({ right: leg.right, strike: leg.strike, side: leg.side, lots: leg.lots ?? 1 });
    save();
    if (kind === "strategy") drawBuilder(context());
    toast(`${leg.side === "BUY" ? "Buy" : "Sell"} ${formatInt(leg.strike)} ${leg.right} added${kind === "strategy" ? "" : " to Strategy Builder"}`);
  }
  function drawBuilder(x) {
    const legs = pricedLegs();
    const typing = builderEl.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";
    const presets = h(
      "div",
      { class: "preset-row", role: "group", "aria-label": "Ready-made strategies" },
      O.PRESETS.map((p) =>
        h(
          "button",
          {
            type: "button",
            class: "preset",
            title: p.view,
            onclick: () => {
              st.baskets[basketKey()] = O.presetLegs(p.id, x.c, { move: x.move });
              save();
              drawBuilder(context());
            },
          },
          p.name,
        ),
      ),
    );
    const actions = legs.length
      ? [
          h("button", { type: "button", class: "small plain", onclick: () => { st.baskets[basketKey()] = []; save(); drawBuilder(context()); } }, "Clear"),
          h("button", { type: "button", class: "small primary", disabled: !st.account || legs.some((l) => l.entry !== undefined && l.entry !== null), title: legs.some((l) => l.entry != null) ? "These legs are your open positions" : undefined, onclick: () => placeStrategy(legs) }, `Place ${formatInt(legs.length)} leg${legs.length === 1 ? "" : "s"}`),
        ]
      : null;
    if (!legs.length) {
      builderEl.replaceChildren(
        card({
          title: "Strategy builder",
          sub: `${st.underlying} ${expiryText(st.expiry)}: payoff, breakevens and probability before you trade`,
          cls: "desk-card",
          body: h("div", { class: "stack" }, presets, h("p", { class: "desk-empty flush" }, "Pick a strategy above, press ⇧B / ⇧S on a strike, or use “Add to strategy” in an order ticket.")),
        }),
      );
      return;
    }
    const stats = O.strategyStats(legs, x.lot, { forward: x.F, ivPct: x.sm.atmIv, years: x.years });
    const g = O.netGreeks(legs, x.c);
    const money = (v, unlimited) => (v === null ? h("span", { class: unlimited }, "Unlimited") : pnl(v));
    const legRows = legs.map((l, i) => {
      const q = legQuote(l);
      const lotsIn = h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(l.lots), "aria-label": `Lots for ${l.side} ${l.strike} ${l.right}`, class: "lots-in" });
      lotsIn.addEventListener("input", () => {
        const v = Math.floor(Number(lotsIn.value));
        if (v >= 1) {
          basket()[i].lots = v;
          save();
          drawBuilder(context());
        }
      });
      return h(
        "tr",
        {},
        h("td", {}, h("button", { type: "button", class: `side-tag ${l.side === "BUY" ? "buy" : "sell"}`, title: "Switch buy / sell", "aria-label": `${l.side}: switch`, onclick: () => { basket()[i].side = l.side === "BUY" ? "SELL" : "BUY"; delete basket()[i].entry; save(); drawBuilder(context()); } }, l.side === "BUY" ? "B" : "S")),
        h("td", {}, h("strong", {}, `${formatInt(l.strike)} ${l.right}`)),
        h("td", { class: "num" }, lotsIn),
        h("td", { class: "num" }, formatFixed(l.price, 2), l.entry != null ? h("span", { class: "muted small" }, " avg") : null),
        h("td", { class: "num opt-x" }, formatFixed(q?.iv, 1)),
        h("td", { class: "num opt-x" }, formatFixed(q?.delta, 2)),
        h("td", { class: "act" }, h("button", { type: "button", class: "icon-btn small-x", "aria-label": `Remove ${l.side} ${l.strike} ${l.right}`, onclick: () => { basket().splice(i, 1); save(); drawBuilder(context()); } }, icon("close"))),
      );
    });
    const legsTable = h("div", { class: "table-wrap" }, h("table", { class: "desk-table legs" }, h("thead", {}, h("tr", {}, ["", "Leg", "Lots", "Price", "IV", "Delta", ""].map((l, i) => h("th", { scope: "col", class: [i >= 2 && i <= 5 ? "num" : "", i >= 4 && i <= 5 ? "opt-x" : ""].join(" ").trim() || undefined }, l)))), h("tbody", {}, legRows)));
    const summary = h(
      "div",
      { class: "desk-stats compact" },
      tile(stats.net >= 0 ? "Credit" : "Debit", formatRupee(Math.abs(stats.net), 0), `${formatInt(legs.reduce((a, l) => a + l.lots, 0))} lot(s) · lot ${formatInt(x.lot)}`),
      tile("Max profit", money(stats.maxProfit, "up"), ""),
      tile("Max loss", money(stats.maxLoss, "down"), ""),
      tile("Breakeven", stats.breakevens.length ? stats.breakevens.map((b) => formatInt(b)).join(" · ") : DASH, stats.breakevens.length && x.spot ? stats.breakevens.map((b) => formatPercent(((b - x.spot) / x.spot) * 100, 1)).join(" · ") : ""),
      tile("Win chance", formatPercent(stats.pop === null ? null : stats.pop * 100, 0), "at expiry, IV model", { title: "Probability the strategy finishes in profit, from a log-normal model at ATM IV" }),
      tile("Greeks", `Δ ${formatFixed(g.delta, 0)}`, `θ ${formatRupee(g.theta, 0)}/day · ν ${formatRupee(g.vega, 0)}`, { title: "Net delta (units), theta (₹ per day) and vega (₹ per IV point)" }),
    );
    const chart = payoffChart(legs, x);
    const body = h("div", { class: "builder" }, h("div", { class: "builder-side" }, presets, legsTable, summary), chart);
    if (typing) {
      // Keep the input being typed in; refresh the figures and the chart only.
      const old = builderEl.querySelector(".builder");
      old?.querySelector(".desk-stats")?.replaceWith(summary);
      old?.querySelector(".payoff")?.replaceWith(chart);
      return;
    }
    keepFocus(builderEl, () =>
      builderEl.replaceChildren(card({ title: "Strategy builder", sub: `${st.underlying} ${expiryText(st.expiry)} · prices at the touch, live`, actions, cls: "desk-card", body })),
    );
  }
  async function placeStrategy(legs) {
    const a = account();
    if (!a) return;
    const live = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand these are real orders to ${a.label}.`);
    live?.addEventListener("change", () => (ackRow.hidden = live.value !== "live"));
    const ordered = [...legs].sort((x, y) => (x.side === y.side ? 0 : x.side === "BUY" ? -1 : 1));
    const ok = await modal({
      title: `Place ${legs.length}-leg strategy?`,
      body: h(
        "div",
        { class: "stack" },
        h("p", { class: "muted" }, `Limit orders at the touch to ${a.label}. Buys go first, so the hedges are in before the short legs.`),
        h("ul", { class: "desk-list" }, ordered.map((l) => h("li", {}, `${l.side === "BUY" ? "Buy" : "Sell"} ${formatInt(l.lots)} lot · ${contractName(st.underlying, st.expiry, l.strike, l.right)} @ ${formatFixed(l.price, 2)}`))),
        live ? segField("Mode", live) : null,
        ackRow,
      ),
      buttons: [{ label: "Cancel", value: false }, { label: "Place orders", cls: "primary", value: true, onClick: () => (live?.value === "live" && !ack.checked ? false : true) }],
    });
    if (!ok) return;
    const bodies = ordered.map((l) => ({ account: a.id, symbol: l.symbol, side: l.side, lots: l.lots, product: "MARGIN", orderType: "LIMIT", price: l.price, ...(live?.value === "live" ? { mode: "live" } : {}) }));
    toast(await sendOrders(bodies, "strat"));
    refresh();
  }

  // ── Order ticket ──
  async function openTicket({ row, right, side, qty, symbol, product, expiry, exit = false }) {
    const a = account();
    if (!a) return toast("Choose an account that can place orders first.");
    const c = st.chain;
    const ex = expiry ?? c?.expiry;
    const sym = symbol ?? row?.[right.toLowerCase()]?.symbol;
    if (!sym) return toast("This contract has no symbol in the chain.");
    const lotSize = num(c?.lotSize) || 1;
    const quote = () => (st.chain?.expiry === ex ? st.chain.rows.find((r) => r.strike === row.strike)?.[right.toLowerCase()] : row?.[right.toLowerCase()]) ?? null;
    const clientOrderId = `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sideSeg = segmented("Side", [["BUY", "Buy"], ["SELL", "Sell"]], side);
    const lots = h("input", { type: "number", min: "1", step: "1", inputmode: "numeric", value: String(qty ? Math.max(1, Math.round(qty / lotSize)) : 1) });
    const lotHint = h("span", { class: "hint" });
    const typeSeg = segmented("Order type", [["LIMIT", "Limit"], ["MARKET", "Market"]], "LIMIT");
    const price = h("input", { type: "number", min: "0.05", step: "0.05", inputmode: "decimal", value: String(O.touchPrice(quote(), side) ?? "") });
    const prodSeg = segmented("Product", [["INTRADAY", "Intraday"], ["MARGIN", "Carry (NRML)"]], product === "MARGIN" ? "MARGIN" : "INTRADAY");
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand this sends a real order to ${a.label}.`);
    const quoteLine = h("div", { class: "ticket-quote" });
    const previewEl = h("div", { class: "ticket-preview", "aria-live": "polite" });
    const touch = (k) => {
      const q = quote();
      if (!isFigure(q?.[k])) return;
      price.value = String(O.roundToTick(q[k], 0.05, sideSeg.value === "BUY" ? "buy" : "sell"));
      changed();
    };
    const priceField = h(
      "div",
      { class: "field" },
      h("span", {}, "Limit price"),
      h("div", { class: "price-row" }, price, h("div", { class: "touch-btns", role: "group", "aria-label": "Use a quote" }, [["Bid", "bid"], ["Mid", "mid"], ["Ask", "ask"]].map(([l, k]) => h("button", { type: "button", class: "small", onclick: () => (k === "mid" ? ((price.value = String(O.roundToTick(O.mid(quote()), 0.05))), changed()) : touch(k)) }, l)))),
    );
    const live = () => modeSeg?.value === "live";
    const body = () => {
      const b = { account: a.id, symbol: sym, side: sideSeg.value, lots: Math.max(1, Math.floor(Number(lots.value) || 1)), product: prodSeg.value, orderType: typeSeg.value };
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
      placeBtn.textContent = `${b.side === "BUY" ? "Buy" : "Sell"} ${formatInt(b.lots)} lot${b.lots === 1 ? "" : "s"}${live() ? " · LIVE" : ""}`;
      placeBtn.className = live() ? "danger" : b.side === "BUY" ? "primary" : "primary sell";
      placeBtn.disabled = blocked || (live() && !ack.checked) || (typeSeg.value === "LIMIT" && !isFigure(price.value));
    };
    const drawQuote = () => {
      const q = quote();
      const cell = (l, v, cls) => h("span", { class: cls }, h("small", {}, l), isFigure(v) ? formatFixed(v, 2) : DASH);
      quoteLine.replaceChildren(cell("Bid", q?.bid, "bid"), cell("LTP", q?.ltp), cell("Ask", q?.ask, "ask"), h("span", {}, h("small", {}, "IV"), formatFixed(q?.iv, 1)), h("span", {}, h("small", {}, "Δ"), formatFixed(q?.delta, 2)));
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
      lotHint.textContent = `${formatInt(Math.max(1, Math.floor(Number(lots.value) || 1)) * lotSize)} qty`;
      priceField.hidden = typeSeg.value !== "LIMIT";
      ackRow.hidden = !live();
      drawButton();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(preview, 200);
    };
    sideSeg.addEventListener("change", () => {
      const p = O.touchPrice(quote(), sideSeg.value);
      if (p !== null) price.value = String(p);
      changed();
    });
    for (const el of [typeSeg, prodSeg, modeSeg].filter(Boolean)) el.addEventListener("change", changed);
    for (const el of [lots, price]) el.addEventListener("input", changed);
    ack.addEventListener("change", drawButton);
    const quoteTimer = setInterval(drawQuote, 1000);
    drawQuote();

    const name = contractName(c?.underlying ?? st.underlying, ex, row.strike, right);
    const done = modal({
      title: exit ? `Exit ${name}` : name,
      body: h(
        "div",
        { class: "stack ticket" },
        quoteLine,
        segField("Side", sideSeg),
        h("div", { class: "ticket-grid" }, h("label", { class: "field" }, h("span", {}, "Lots ", lotHint), lots), segField("Type", typeSeg)),
        priceField,
        h("div", { class: "ticket-grid" }, segField("Product", prodSeg), modeSeg ? segField("Mode", modeSeg) : h("div", { class: "field" }, h("span", {}, "Account"), h("span", { class: "ticket-acct" }, `${a.label}\u00a0`, h("span", { class: "muted" }, "· paper")))),
        ackRow,
        previewEl,
      ),
      buttons: [
        ...(exit ? [] : [{ label: "Add to strategy", cls: "plain", onClick: () => { addLeg({ right, strike: row.strike, side: sideSeg.value, lots: body().lots }); return "added"; } }]),
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
  }

  // ── Keyboard ──
  const desk = {
    root: chainEl,
    onKey(e) {
      const k = e.key;
      const rows = chain.visibleStrikes();
      if (!rows.length) return false;
      const f = st.focus;
      const move = (d) => {
        const i = f ? rows.indexOf(f.strike) : rows.indexOf(chain.atmStrike());
        const j = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + d));
        st.focus = { strike: rows[j], side: f?.side ?? "ce" };
        chain.paintFocus(true);
      };
      if (k === "j" || (k === "ArrowDown" && f)) return move(1), true;
      if (k === "k" || (k === "ArrowUp" && f)) return move(-1), true;
      if ((k === "ArrowLeft" || k === "h") && f) return (st.focus = { ...f, side: "ce" }), chain.paintFocus(true), true;
      if ((k === "ArrowRight" || k === "l") && f) return (st.focus = { ...f, side: "pe" }), chain.paintFocus(true), true;
      if (k === "g") return (st.focus = { strike: chain.atmStrike(), side: f?.side ?? "ce" }), chain.paintFocus(true), true;
      if (k === "Escape" && f) return (st.focus = null), chain.paintFocus(), true;
      if (k === "p") return liveBtn.click(), true;
      if (k === "r") return refresh(), true;
      const target = f ?? { strike: chain.atmStrike(), side: "ce" };
      const row = st.chain?.rows.find((r) => r.strike === target.strike);
      if (!row) return false;
      const right = target.side === "ce" ? "CE" : "PE";
      if (k === "b" || k === "s") return openTicket({ row, right, side: k === "b" ? "BUY" : "SELL" }), true;
      if (k === "B" || k === "S") return addLeg({ right, strike: row.strike, side: k === "B" ? "BUY" : "SELL" }), true;
      return false;
    },
  };
  activeDesk = kind === "chain" ? desk : null;
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
    chain.reset();
    save();
    loadChain();
  });
  strikesSeg.addEventListener("change", () => {
    st.strikes = strikesSeg.value;
    save();
    chain.reset();
    drawAll();
  });
  viewSeg.addEventListener("change", () => {
    st.view = viewSeg.value;
    save();
    chain.reset(true);
    drawAll();
  });
  aSel.addEventListener("change", () => {
    st.account = aSel.value;
    save();
    loadPositions();
  });
  liveBtn.addEventListener("click", () => {
    st.live = !st.live;
    save();
    drawLive();
    startTimer();
    if (st.live) refresh();
  });
  drawLive();

  await reloadAll();
  startTimer();

  const bar = h(
    "div",
    { class: "desk-bar" },
    h("div", { class: "desk-pick" }, uSel, eSel),
    kind === "chain" ? h("div", { class: "desk-opts" }, strikesSeg, viewSeg) : null,
    h("div", { class: "desk-acct", title: "Orders from these pages go to this account" }, aSel),
    h("div", { class: "desk-live" }, clock, liveBtn),
  );
  if (kind === "chain") return [h("section", { class: "desk-panel" }, bar, statsEl, chainEl, keysEl)];
  if (kind === "strategy") return [h("section", { class: "desk-panel" }, bar, statsEl), adderEl, builderEl];
  if (kind === "oi") return [h("section", { class: "desk-panel" }, bar, statsEl), profileEl, oiMoreEl];
  return [h("section", { class: "desk-panel" }, bar), posEl];
}

// ── Chain table (built once, patched on every refresh) ──

function createChain({ st, host, onTrade, onFocus }) {
  let built = null; // { key, table, rows: Map<strike, { tr, th, ce: td[], pe: td[] }>, spotTr, foot }
  let centred = false;

  const g = (v, dp) => (isFigure(v) ? formatFixed(v, dp) : DASH);
  const dots = (n) => h("span", { class: "liq", title: `Liquidity ${n} of 5`, "aria-label": `Liquidity ${n} of 5` }, [1, 2, 3, 4, 5].map((i) => h("i", { class: i <= n ? "on" : undefined })));
  /** Column: v = what the cell depends on (compared to skip unchanged cells), r = the cell's content. */
  const COLS = {
    bu: { label: "Build-up", title: "OI build-up: LB long build-up, SB short build-up, SC short covering, LU long unwinding", cls: "opt-x bu-col", v: (q) => O.buildup(q), r: (q) => { const b = O.buildup(q); return b ? h("span", { class: `bu bu-${b}`, title: O.BUILDUP_NAMES[b] }, b) : h("span", { class: "muted" }, DASH); } },
    oi: {
      label: "OI",
      v: (q, row, side, x) => [q?.oi, q?.oiChange, x.sm.maxOi, x.sm.maxOiChange],
      r: (q, row, side, x) => {
        const bar = h("span", { class: "oi-bar", "aria-hidden": "true" }, h("span"), h("span", { class: `chg ${num(q?.oiChange) < 0 ? "neg" : ""}`.trim() }));
        bar.children[0].style.width = `${x.sm.maxOi > 0 ? Math.min(100, ((num(q?.oi) ?? 0) / x.sm.maxOi) * 100) : 0}%`;
        bar.children[1].style.width = `${x.sm.maxOiChange > 0 ? Math.min(100, (Math.abs(num(q?.oiChange) ?? 0) / x.sm.maxOiChange) * 100) : 0}%`;
        return h("span", { class: "oi-cell" }, h("span", {}, formatCompact(q?.oi)), bar);
      },
    },
    chg: {
      label: "Chg OI",
      v: (q) => [q?.oiChange, q?.oi],
      r: (q) => {
        const v = num(q?.oiChange);
        const pct = O.oiChangePct(q);
        return h("span", { class: "two" }, h("span", { class: v > 0 ? "up" : v < 0 ? "down" : undefined }, formatCompact(v, { signed: true })), h("small", {}, pct === null ? "" : formatPercent(pct, 1)));
      },
    },
    vol: {
      label: "Volume",
      cls: "opt-x",
      v: (q, row, side, x) => [q?.volume, x.hot.has(q?.symbol)],
      r: (q, row, side, x) => {
        const hot = x.hot.has(q?.symbol);
        return h("span", { class: hot ? "hot" : undefined, title: hot ? "Unusual: volume ÷ OI well above the rest of the chain" : undefined }, formatCompact(q?.volume));
      },
    },
    iv: { label: "IV", v: (q) => q?.iv, r: (q) => g(q?.iv, 1) },
    ltp: {
      label: "LTP",
      ltp: true,
      v: (q) => [q?.ltp, q?.change],
      r: (q) => {
        const pct = O.changePct(q);
        return h("span", { class: "two" }, h("strong", {}, g(q?.ltp, 2)), h("small", { class: pct > 0 ? "up" : pct < 0 ? "down" : undefined }, pct === null ? "" : formatSigned(pct, 1)));
      },
    },
    delta: { label: "Delta", v: (q) => q?.delta, r: (q) => g(q?.delta, 2) },
    gamma: { label: "Gamma", cls: "opt-x", v: (q) => q?.gamma, r: (q) => g(q?.gamma, 4) },
    theta: { label: "Theta", v: (q) => q?.theta, r: (q) => g(q?.theta, 1) },
    vega: { label: "Vega", cls: "opt-x", v: (q) => q?.vega, r: (q) => g(q?.vega, 1) },
    pitm: {
      label: "P(ITM)",
      title: "Probability of finishing in the money (Black-76 on the forward)",
      v: (q, row, side, x) => [q?.iv, Math.round((x.F ?? 0) * 10)],
      r: (q, row, side, x) => formatPercent(O.probItm(x.F, row.strike, x.years, q?.iv, side === "ce" ? "CE" : "PE") === null ? null : O.probItm(x.F, row.strike, x.years, q?.iv, side === "ce" ? "CE" : "PE") * 100, 0),
    },
    ext: {
      label: "Time value",
      title: "Extrinsic value: premium above intrinsic value (what decays to zero by expiry)",
      v: (q, row, side, x) => [q?.ltp, x.spot],
      r: (q, row, side, x) => {
        if (!isFigure(q?.ltp) || x.spot === null) return DASH;
        const intrinsic = side === "ce" ? Math.max(0, x.spot - row.strike) : Math.max(0, row.strike - x.spot);
        return g(Math.max(0, q.ltp - intrinsic), 2);
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
    bid: { label: "Bid", trade: "SELL" },
    ask: { label: "Ask", trade: "BUY" },
  };
  const VIEWS = { oi: ["bu", "oi", "chg", "vol", "iv", "ltp"], greeks: ["pitm", "vega", "theta", "gamma", "delta", "iv", "ltp"], value: ["prem", "liq", "spread", "ext", "iv", "ltp"] };
  const layout = (view) => {
    const inner = VIEWS[view] ?? VIEWS.oi;
    return { ce: [...inner, "bid", "ask"], pe: ["bid", "ask", ...[...inner].reverse()] };
  };

  function tradeButton(q, row, side, trade) {
    const price = trade === "BUY" ? q?.ask : q?.bid;
    if (!q || !isFigure(price)) return h("span", { class: "muted" }, DASH);
    const right = side === "ce" ? "CE" : "PE";
    const label = `${trade === "BUY" ? "Buy" : "Sell"} ${formatInt(row.strike)} ${right} at ${formatFixed(price, 2)}`;
    return h("button", { type: "button", class: `q-btn ${trade === "BUY" ? "buy" : "sell"}`, title: label, "aria-label": label, disabled: !st.account, onclick: (e) => { e.stopPropagation(); onTrade(row, right, trade); } }, formatFixed(price, 2));
  }

  function build(x, rows, key) {
    const cols = layout(st.view);
    const n = cols.ce.length;
    const head = h(
      "thead",
      {},
      h("tr", { class: "side-head" }, h("th", { colspan: n, scope: "colgroup" }, "Calls"), h("th", { class: "strike-col" }, ""), h("th", { colspan: n, scope: "colgroup" }, "Puts")),
      h(
        "tr",
        { class: "col-head" },
        cols.ce.map((k) => h("th", { scope: "col", class: `num ${COLS[k].cls ?? ""}`.trim(), title: COLS[k].title }, COLS[k].label)),
        h("th", { scope: "col", class: "strike-col" }, "Strike"),
        cols.pe.map((k) => h("th", { scope: "col", class: `num ${COLS[k].cls ?? ""}`.trim(), title: COLS[k].title }, COLS[k].label)),
      ),
    );
    const map = new Map();
    const body = h("tbody");
    for (const row of rows) {
      const ce = cols.ce.map((k) => h("td", { class: `num ${COLS[k].cls ?? ""} c-${k}`.trim() }));
      const pe = cols.pe.map((k) => h("td", { class: `num ${COLS[k].cls ?? ""} c-${k}`.trim() }));
      const th = h("th", { scope: "row", class: "strike-col" });
      const tr = h("tr", { "data-strike": row.strike }, ce, th, pe);
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const cell = e.target.closest("td");
        const side = cell && pe.includes(cell) ? "pe" : cell && ce.includes(cell) ? "ce" : st.focus?.side ?? "ce";
        onFocus({ strike: row.strike, side });
      });
      body.append(tr);
      map.set(row.strike, { tr, th, ce, pe, cols });
    }
    const spotTr = h("tr", { class: "spot-row", "aria-hidden": "true" }, h("td", { colspan: n * 2 + 1 }, h("span", { class: "spot-tag" })));
    const foot = { ce: cols.ce.map((k) => h("td", { class: `num ${COLS[k].cls ?? ""}`.trim() })), th: h("th", { scope: "row", class: "strike-col" }), pe: cols.pe.map((k) => h("td", { class: `num ${COLS[k].cls ?? ""}`.trim() })) };
    const table = h("table", { class: `chain v-${st.view}` }, head, body, h("tfoot", {}, h("tr", {}, foot.ce, foot.th, foot.pe)));
    built = { key, table, rows: map, spotTr, foot, cols, body };
    const wrap = h("div", { class: "table-wrap chain-wrap" }, table);
    const old = st.__wrap;
    const keepX = old?.isConnected ? old.scrollLeft : null;
    st.__wrap = wrap;
    return { wrap, keepX };
  }

  function patchCell(td, k, q, row, side, x) {
    const col = COLS[k];
    if (col.trade) {
      const price = col.trade === "BUY" ? q?.ask : q?.bid;
      const sig = `${price}|${st.account ? 1 : 0}`;
      if (td.__sig === sig) return;
      td.__sig = sig;
      td.replaceChildren(tradeButton(q, row, side, col.trade));
      return;
    }
    const v = col.v(q, row, side, x);
    const sig = JSON.stringify(v ?? null);
    if (td.__sig === sig) return;
    const prevLtp = td.__ltp;
    td.__sig = sig;
    td.replaceChildren(q ? col.r(q, row, side, x) : DASH);
    if (col.ltp) {
      const now = num(q?.ltp);
      td.__ltp = now;
      if (prevLtp !== undefined && now !== null && prevLtp !== null && now !== prevLtp) {
        td.classList.remove("flash-up", "flash-down");
        void td.offsetWidth;
        td.classList.add(now > prevLtp ? "flash-up" : "flash-down");
      }
    }
  }

  function patch(x, rows) {
    const { sm, spot } = x;
    const mp = sm.maxPain;
    for (const row of rows) {
      const b = built.rows.get(row.strike);
      if (!b) continue;
      for (const side of ["ce", "pe"]) {
        const q = row[side];
        const itm = O.inTheMoney(row.strike, side, spot);
        const dt = x.targets[side].get(row.strike);
        b.cols[side].forEach((k, i) => {
          const td = b[side][i];
          patchCell(td, k, q, row, side, x);
          td.classList.toggle("itm", itm);
          td.classList.toggle("dt", Boolean(dt) && k === "delta");
          if (k === "delta") td.title = dt ? `${dt} strike` : "";
        });
      }
      const tags = [];
      if (row.strike === sm.atm) tags.push(["atm", "ATM", "At the money"]);
      if (row.strike === mp) tags.push(["mp", "MP", "Max pain"]);
      if (row.strike === sm.resistance?.strike) tags.push(["cw", "CW", "Call wall: most call OI"]);
      if (row.strike === sm.support?.strike) tags.push(["pw", "PW", "Put wall: most put OI"]);
      if (row.strike === x.emUp) tags.push(["em", "+1σ", "Upper edge of the expected move (IV 1σ)"]);
      if (row.strike === x.emDown) tags.push(["em", "−1σ", "Lower edge of the expected move (IV 1σ)"]);
      const sig = `${row.strike}|${tags.map((t) => t[1]).join(",")}`;
      if (b.th.__sig !== sig) {
        b.th.__sig = sig;
        b.th.replaceChildren(...[h("span", { class: "k" }, formatInt(row.strike)), tags.length ? h("span", { class: "tags" }, tags.map(([c, t, title]) => h("span", { class: `tag ${c}`, title }, t))) : null].filter(Boolean));
      }
      b.tr.classList.toggle("atm", row.strike === sm.atm);
      b.tr.classList.toggle("in-em", x.emDown !== null && row.strike >= x.emDown && row.strike <= x.emUp);
    }
    // Spot marker: between the last strike below spot and the first above it.
    if (spot !== null) {
      built.spotTr.querySelector(".spot-tag").textContent = `${st.chain.underlying} ${formatFixed(spot, 2)}`;
      const after = rows.find((r) => r.strike > spot);
      const anchor = after ? built.rows.get(after.strike).tr : null;
      if (built.spotTr.nextSibling !== anchor || !built.spotTr.isConnected) built.body.insertBefore(built.spotTr, anchor);
    } else built.spotTr.remove();
    // Footer: totals over the whole chain, PCR in the strike column.
    const totals = { oi: [sm.ceOi, sm.peOi], chg: [sm.ceOiChange, sm.peOiChange], vol: [sm.ceVolume, sm.peVolume] };
    for (const [i, side] of [[0, "ce"], [1, "pe"]]) {
      built.cols[side].forEach((k, j) => {
        const v = totals[k]?.[i];
        built.foot[side][j].textContent = v === undefined ? "" : k === "chg" ? formatCompact(v, { signed: true }) : formatCompact(v);
      });
    }
    built.foot.th.replaceChildren(h("small", {}, "PCR "), formatFixed(sm.pcr, 2));
  }

  const api_ = {
    reset(keepX = false) {
      built = null;
      if (!keepX) centred = false;
    },
    draw(x) {
      const rows = O.rowsAroundAtm(x.c, Number(st.strikes));
      if (!rows.length) {
        host.replaceChildren(emptyState("chart", "No strikes", `No strikes for ${x.c.underlying} ${expiryText(x.c.expiry)}.`));
        return;
      }
      const key = [x.c.underlying, x.c.expiry, st.view, rows.map((r) => r.strike).join(",")].join("|");
      if (!built || built.key !== key) {
        const { wrap, keepX } = build(x, rows, key);
        patch(x, rows);
        host.replaceChildren(wrap);
        this.paintFocus();
        // The first draw happens before the page is on screen: wait until the table has a size, then place it.
        let frames = 0;
        const place = () => {
          if (!wrap.isConnected || !wrap.clientWidth) {
            if (++frames < 120) requestAnimationFrame(place);
            return;
          }
          if (keepX !== null) wrap.scrollLeft = keepX;
          else wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2;
          if (!centred) {
            const atm = built?.rows.get(x.sm.atm)?.tr;
            if (atm && wrap.scrollHeight > wrap.clientHeight) wrap.scrollTop = atm.offsetTop - wrap.clientHeight / 2 + atm.offsetHeight;
            centred = true;
          }
        };
        requestAnimationFrame(place);
      } else patch(x, rows);
    },
    paintFocus(scroll = false) {
      if (!built?.rows) return;
      for (const [strike, b] of built.rows) {
        const on = st.focus?.strike === strike;
        b.tr.classList.toggle("focus", on);
        for (const side of ["ce", "pe"]) for (const td of b[side]) td.classList.toggle("fside", on && st.focus.side === side);
        if (on && scroll) b.tr.scrollIntoView({ block: "nearest" });
      }
    },
    visibleStrikes: () => (built?.rows ? [...built.rows.keys()] : []),
    atmStrike: () => O.atmRow(st.chain)?.strike ?? null,
  };
  return api_;
}

// ── OI profile chart ──

function oiProfile(x, mode, onMode) {
  const rows = O.rowsAroundAtm(x.c, 15);
  const pick = (q) => num(mode === "change" ? q?.oiChange : q?.oi) ?? 0;
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(pick(r.ce)), Math.abs(pick(r.pe))]));
  const W = 640;
  const H = 260;
  const padL = 44;
  const padB = 34;
  const padT = 14;
  const innerW = W - padL - 10;
  const innerH = H - padB - padT;
  const zeroY = mode === "change" ? padT + innerH / 2 : padT + innerH;
  const scale = mode === "change" ? innerH / 2 / max : innerH / max;
  const bw = innerW / rows.length;
  const bars = [];
  rows.forEach((r, i) => {
    const x0 = padL + i * bw;
    for (const [side, off] of [["ce", 0.12], ["pe", 0.5]]) {
      const v = pick(r[side]);
      const hgt = Math.abs(v) * scale;
      bars.push(s("rect", { x: x0 + bw * off, width: bw * 0.36, y: v >= 0 ? zeroY - hgt : zeroY, height: Math.max(0.5, hgt), class: `bar-${side}`, rx: 1.5 }, s("title", {}, `${formatInt(r.strike)} ${side.toUpperCase()}: ${formatCompact(v, { signed: mode === "change" })}`)));
    }
  });
  const xAt = (k) => {
    const i = rows.findIndex((r) => r.strike >= k);
    if (i <= 0) return padL + (i === 0 ? bw / 2 : innerW);
    const a = rows[i - 1].strike;
    const b = rows[i].strike;
    return padL + (i - 1) * bw + bw / 2 + ((k - a) / (b - a)) * bw;
  };
  const marks = [];
  if (x.spot !== null) marks.push(s("line", { x1: xAt(x.spot), x2: xAt(x.spot), y1: padT, y2: padT + innerH, class: "mark-spot" }), s("text", { x: xAt(x.spot), y: padT - 3, class: "mark-label spot", "text-anchor": "middle" }, `Spot ${formatInt(x.spot)}`));
  if (x.sm.maxPain !== null) marks.push(s("line", { x1: xAt(x.sm.maxPain), x2: xAt(x.sm.maxPain), y1: padT, y2: padT + innerH, class: "mark-mp" }));
  const every = Math.ceil(rows.length / 8);
  const labels = rows.map((r, i) => (i % every === 0 ? s("text", { x: padL + i * bw + bw / 2, y: H - padB + 16, class: "axis", "text-anchor": "middle" }, formatInt(r.strike)) : null));
  const ticks = niceTicks(mode === "change" ? -max : 0, max, mode === "change" ? 5 : 4).map((v) => {
    const y = zeroY - v * scale;
    return [s("line", { x1: padL, x2: W - 10, y1: y, y2: y, class: v === 0 ? "grid zero" : "grid" }), s("text", { x: padL - 6, y: y + 3.5, class: "axis", "text-anchor": "end" }, formatCompact(v))];
  });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "oi-chart", role: "img", "aria-label": `${mode === "change" ? "OI change" : "Open interest"} by strike, calls and puts` }, ticks, bars, marks, labels);
  const seg = segmented("Profile", [["oi", "OI"], ["change", "Change"]], mode);
  seg.addEventListener("change", () => onMode(seg.value));
  return card({
    title: "OI by strike",
    actions: [h("span", { class: "legend" }, h("i", { class: "ce" }), "Calls", h("i", { class: "pe" }), "Puts", h("i", { class: "mp" }), "Max pain"), seg],
    cls: "desk-card",
    body: svg,
  });
}

// ── Payoff chart ──

function payoffChart(legs, x) {
  const host = h("div", { class: "payoff" });
  const spot = x.spot ?? x.F;
  if (spot === null) return host;
  const strikes = legs.map((l) => l.strike);
  const span = Math.max((x.move ?? spot * 0.02) * 2.6, ...strikes.map((k) => Math.abs(k - spot) * 1.35), spot * 0.015);
  const lo = spot - span;
  const hi = spot + span;
  const N = 140;
  const xs = [...Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N), ...strikes.filter((k) => k > lo && k < hi)].sort((a, b) => a - b);
  const basis = x.F !== null && x.spot !== null ? x.F - x.spot : 0;
  const exp = xs.map((p) => O.payoffAt(legs, p, x.lot));
  const today = x.years > 0 ? xs.map((p) => O.valueAt(legs, p, x.lot, x.years, basis)) : null;
  const all = [...exp, ...(today ?? []).filter((v) => v !== null), 0];
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  const pad = (yMax - yMin || Math.abs(yMax) || 1) * 0.12;
  yMin -= pad;
  yMax += pad;
  const W = 720;
  const H = 300;
  const L = 64;
  const R = 12;
  const T = 16;
  const B = 30;
  const X = (p) => L + ((p - lo) / (hi - lo)) * (W - L - R);
  const Y = (v) => T + ((yMax - v) / (yMax - yMin)) * (H - T - B);
  const path = (vals) => vals.map((v, i) => (v === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${r1(X(xs[i]))},${r1(Y(v))}`)).join("");
  const zy = Y(0);
  const area = `M${r1(X(xs[0]))},${r1(zy)}${exp.map((v, i) => `L${r1(X(xs[i]))},${r1(Y(v))}`).join("")}L${r1(X(xs[xs.length - 1]))},${r1(zy)}Z`;
  const id = `pc${Math.random().toString(36).slice(2, 7)}`;
  const yTicks = niceTicks(yMin, yMax, 5);
  const xTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const stats = O.strategyStats(legs, x.lot);
  const svg = s(
    "svg",
    { viewBox: `0 0 ${W} ${H}`, class: "payoff-svg", role: "img", "aria-label": "Payoff at expiry and today" },
    s("defs", {}, s("clipPath", { id: `${id}-up` }, s("rect", { x: 0, y: 0, width: W, height: Math.max(0, zy) })), s("clipPath", { id: `${id}-dn` }, s("rect", { x: 0, y: zy, width: W, height: Math.max(0, H - zy) }))),
    x.move ? s("rect", { x: X(Math.max(lo, (x.F ?? spot) - x.move)), y: T, width: Math.max(0, X(Math.min(hi, (x.F ?? spot) + x.move)) - X(Math.max(lo, (x.F ?? spot) - x.move))), height: H - T - B, class: "band" }) : null,
    yTicks.map((v) => [s("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: "grid" }), s("text", { x: L - 8, y: Y(v) + 3.5, class: "axis", "text-anchor": "end" }, formatCompact(v))]),
    xTicks.map((p) => s("text", { x: X(p), y: H - 10, class: "axis", "text-anchor": "middle" }, formatInt(p))),
    s("path", { d: area, class: "area-up", "clip-path": `url(#${id}-up)` }),
    s("path", { d: area, class: "area-dn", "clip-path": `url(#${id}-dn)` }),
    s("line", { x1: L, x2: W - R, y1: zy, y2: zy, class: "zero" }),
    today ? s("path", { d: path(today), class: "line-today" }) : null,
    s("path", { d: path(exp), class: "line-exp" }),
    s("line", { x1: X(spot), x2: X(spot), y1: T, y2: H - B, class: "mark-spot" }),
    s("text", { x: X(spot), y: T - 4, class: "mark-label spot", "text-anchor": "middle" }, formatInt(spot)),
    stats.breakevens.filter((b) => b > lo && b < hi).map((b) => [s("circle", { cx: X(b), cy: zy, r: 3.5, class: "be" }), s("text", { x: X(b), y: zy + 15, class: "mark-label", "text-anchor": "middle" }, formatInt(b))]),
  );
  // Crosshair readout.
  const cross = s("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
  const dotE = s("circle", { r: 3.5, class: "dot-exp", visibility: "hidden" });
  const dotT = s("circle", { r: 3.5, class: "dot-today", visibility: "hidden" });
  svg.append(cross, dotE, dotT);
  const readout = h("div", { class: "payoff-readout" }, h("span", { class: "muted" }, "Hover the chart to read P&L at a price"));
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const p = lo + ((Math.max(L, Math.min(W - R, px)) - L) / (W - L - R)) * (hi - lo);
    const ve = O.payoffAt(legs, p, x.lot);
    const vt = x.years > 0 ? O.valueAt(legs, p, x.lot, x.years, basis) : null;
    for (const [el, v] of [[dotE, ve], [dotT, vt]]) {
      if (v === null) continue;
      el.setAttribute("cx", X(p));
      el.setAttribute("cy", Y(Math.max(yMin, Math.min(yMax, v))));
      el.setAttribute("visibility", "visible");
    }
    cross.setAttribute("x1", X(p));
    cross.setAttribute("x2", X(p));
    cross.setAttribute("visibility", "visible");
    readout.replaceChildren(...[h("strong", {}, formatInt(p)), h("span", { class: "muted" }, ` (${formatSigned(((p - spot) / spot) * 100, 2)}%)  `), h("span", { class: "muted" }, "Expiry "), pnl(ve), ...(vt !== null ? [h("span", { class: "muted" }, "  Today "), pnl(vt)] : [])]);
  });
  svg.addEventListener("pointerleave", () => {
    for (const el of [cross, dotE, dotT]) el.setAttribute("visibility", "hidden");
  });
  host.append(
    h("div", { class: "payoff-head" }, h("span", { class: "legend" }, h("i", { class: "exp" }), "At expiry", h("i", { class: "today" }), "Today", x.move ? [h("i", { class: "band" }), "±1σ"] : null), readout),
    svg,
  );
  return host;
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

/** Round axis values (1, 2, 2.5 or 5 × 10^n) covering [lo, hi]. */
function niceTicks(lo, hi, count) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
