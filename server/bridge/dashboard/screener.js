// The Option Screener (#/screener, PRD 07): every underlying and expiry ranked at once. One sweep fetches each chain
// once (GET /v1/expiries, /v1/history daily candles for HV20, /v1/optionchain) through a strictly sequential queue
// that respects the broker's rate limits; every tab is then a filter + sort + column set over the same records, so
// switching tabs costs no network. The maths is options.js, the preset logic screens.js (both pure and tested);
// numbers are formatted by format.js only. There is no order button: trades go through the chain's ticket.
// Round 2 (docs/design/screener.md): a visible ranking (rank column, violet heat, movement since the last sweep),
// CE / PE identity, per-tab visual columns, phone cards with micro-visuals, an always-on detail column from 1280 px
// with a score ring and a risk payoff, the toolbar live control with the chain dots, pins and a match map.
import { candlesOf, screenerSpec, spotSymbol } from "./chart-specs.js";
import { DEMO_EXPLAINER, alertBox, api, app, chartSlot, h, icon, istTime, modal, mountToolbarCtx, optional, sheetPopover, toast } from "./app.js";
import { DASH, MINUS, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import { UNDERLYINGS } from "./desk.js";
import { barsEnter, countUp, flashValue, lineReveal, reducedMotion, stopCount } from "./motion.js";
import * as O from "./options.js";
import * as S from "./screens.js";
import { LIBRARY_BY_ID, OPTION_QUICK_SCANS, activeQuickScan, quickScanPatch } from "./scan-library.js";
import { readinessSheetRow } from "./readiness.js";
import { dayText, loadReference, refBanners, refCharges, refChip, refRate, refSession, refSignature } from "./reference.js";
import { every, segmented, stopTimer } from "./views.js";
import { hbar, heatCell, setBar, spotPill, svgEl } from "./viz.js";

const SLOT = "mcb.dashboard.screener";
const HV_SLOT = "mcb.dashboard.screener.hv";
const BASE_SLOT = "mcb.dashboard.screener.base";
const DESK_SLOT = "mcb.dashboard.desk";
const local = app.local;
const num = (v) => (isFigure(v) ? Number(v) : null);
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
const MQ_PHONE = "(max-width: 719px)";
const MQ_WIDE = "(min-width: 1280px)";
const MQ_REDUCED = "(prefers-reduced-motion: reduce)";
const phone = () => media(MQ_PHONE).matches;
const wide = () => media(MQ_WIDE).matches;
const BSE = new Set(["SENSEX", "BANKEX"]);
const indexSymbol = (u) => `${BSE.has(u) ? "BSE" : "NSE"}:${u}`;
const EXPIRIES_TTL = 5 * 60_000;
const CANCELLED = Symbol("cancelled");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (slot) => {
  try {
    return JSON.parse(local.get(slot) ?? "null");
  } catch {
    return null;
  }
};
const write = (slot, v) => local.set(slot, JSON.stringify(v));

// ── Scan engine: module level, so the results survive navigation within the tab ──

/** U|E → { chain, fetchedAt, asOf, stale, error, ms } */
const cache = new Map();
/** U → { list, at, error } */
const expCache = new Map();
/** Underlyings skipped for the session (no listed contracts or an error) until a manual rescan. */
const skipped = new Map();
/** HV fetches that failed today (no retry until tomorrow or a manual rescan). */
const hvFailed = new Set();
let sweepSeq = 0;
let lastCall = 0;
let nextGap = 0;

function hvStore() {
  const s = read(HV_SLOT);
  const today = S.istDate(Date.now());
  return s && s.date === today && s.values && typeof s.values === "object" ? s : { date: today, values: {} };
}
const visible = () =>
  new Promise((resolve) => {
    if (!document.hidden) return resolve();
    const on = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", on);
      resolve();
    };
    document.addEventListener("visibilitychange", on);
  });
/** Read the RateLimit header ("limit=50, remaining=47, reset=1"): with one call left, wait out the window. */
function rateLimit(headers) {
  const v = headers?.get?.("RateLimit") ?? "";
  const rem = /remaining=(\d+)/.exec(v);
  const reset = /reset=(\d+)/.exec(v);
  nextGap = rem && Number(rem[1]) <= 1 && reset ? Number(reset[1]) * 1000 : 0;
}
/**
 * One call through the queue: spaced by the demo / live gap (longer when the RateLimit header says so), paused while
 * the tab is hidden, cancelled when a newer sweep starts. A 429 backs off 2, 4, 8 s, then gives up.
 */
async function queued(path, seq) {
  for (let attempt = 0; ; attempt++) {
    const gap = Math.max(app.state.demo ? 300 : 1100, nextGap);
    const wait = lastCall + gap - Date.now();
    if (wait > 0) await sleep(wait);
    await visible();
    if (seq !== sweepSeq) throw CANCELLED;
    lastCall = Date.now();
    try {
      const r = await api(path);
      lastCall = Date.now();
      rateLimit(r.headers);
      return r;
    } catch (err) {
      lastCall = Date.now();
      if (err?.status === 429 && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        if (seq !== sweepSeq) throw CANCELLED;
        continue;
      }
      if (err?.status === 429) err.rateLimited = true;
      throw err;
    }
  }
}

/**
 * A sweep over the universe: expiries for every underlying first (so the total is known), with the first underlying's
 * nearest chain read as soon as its expiries are known (so rows show within a second, not after 15 expiry reads), then
 * the chains (nearest expiries of every underlying first), then HV20 once a day per underlying (it only feeds the IV
 * against HV figure, which fills in after). Chains fresher than 0.9 × TTL are kept unless `force`. Callbacks redraw
 * progressively.
 */
async function runSweep({ cfg, force, close, onProgress, onChain, onIssue, onHv }) {
  const seq = ++sweepSeq;
  const list = cfg.underlyings;
  const plan = new Map();
  if (force) {
    skipped.clear();
    hvFailed.clear();
  }
  const now = () => Date.now();
  let calls = 0;
  const ttl = (cfg.auto || 60) * 1000;
  const early = new Set(); // chains read during the expiries phase (not read again below)
  async function readChain(u, e) {
    const key = `${u}|${e}`;
    const t0 = performance.now();
    try {
      const r = await queued(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(e)}&strikes=${cfg.strikes}&greeks=true&maxAgeMs=5000`, seq);
      calls += 1;
      const c = r.data?.data ?? null;
      const fr = c?.freshness ?? r.data?.meta?.freshness ?? null;
      cache.set(key, { chain: c, fetchedAt: now(), asOf: fr?.asOf ?? new Date().toISOString(), stale: Boolean(fr?.stale), error: null, ms: Math.round(performance.now() - t0) });
      onIssue({ key, clear: true });
    } catch (err) {
      if (err === CANCELLED) throw err;
      const prev = cache.get(key);
      cache.set(key, { ...(prev ?? { chain: null, fetchedAt: 0, asOf: null }), error: err });
      onIssue({ key, label: S.chainName(u, e), message: err?.rateLimited ? "Rate limited" : String(err?.message ?? err), error: err, retry: { u, e } });
    }
    if (seq !== sweepSeq) throw CANCELLED;
    onChain(key);
  }
  try {
    for (const u of list) {
      if (skipped.has(u)) {
        onIssue({ key: u, label: u, message: skipped.get(u) });
        continue;
      }
      const have = expCache.get(u);
      let ex = have && !force && now() - have.at < EXPIRIES_TTL ? have.list : null;
      if (!ex) {
        onProgress({ phase: "expiries", label: u });
        try {
          const r = await queued(`/v1/expiries?underlying=${encodeURIComponent(u)}`, seq);
          calls += 1;
          ex = r.data?.data?.expiries ?? [];
          expCache.set(u, { list: ex, at: now() });
        } catch (err) {
          if (err === CANCELLED) throw err;
          skipped.set(u, String(err?.message ?? err));
          onIssue({ key: u, label: u, message: err?.rateLimited ? "Rate limited" : String(err?.message ?? err), error: err });
          continue;
        }
      }
      if (!ex.length) {
        skipped.set(u, "no listed contracts");
        onIssue({ key: u, label: u, message: "no listed contracts" });
        continue;
      }
      plan.set(u, S.scanExpiries(ex, { n: cfg.expiries, monthly: cfg.monthly, close }).map((e) => ({ expiry: e, monthly: O.isMonthly(e, ex) })));
      // The first underlying's nearest chain at once, unless one is remembered fresh: the table has rows early.
      if (plan.size === 1 && !early.size) {
        const e = plan.get(u)[0]?.expiry;
        const have = e ? cache.get(`${u}|${e}`) : null;
        if (e && (force || !have?.chain || have.error || now() - have.fetchedAt >= ttl * 0.9)) {
          onProgress({ phase: "chain", label: S.chainName(u, e), current: true });
          await readChain(u, e);
          early.add(`${u}|${e}`);
        }
      }
    }
    const order = S.scanOrder(new Map([...plan].map(([u, l]) => [u, l.map((x) => x.expiry)])));
    onProgress({ phase: "plan", plan, total: order.length, done: early.size });
    let done = 0;
    for (const { underlying: u, expiry: e } of order) {
      const key = `${u}|${e}`;
      const have = cache.get(key);
      if (early.has(key) || (!force && have?.chain && !have.error && now() - have.fetchedAt < ttl * 0.9)) {
        done += 1;
        onProgress({ phase: "chain", done, total: order.length, label: S.chainName(u, e) });
        continue;
      }
      onProgress({ phase: "chain", done, total: order.length, label: S.chainName(u, e), current: true });
      await readChain(u, e);
      done += 1;
      onProgress({ phase: "chain", done, total: order.length, label: S.chainName(u, e) });
    }
    // HV20: one daily call per underlying, cached for the IST day; a failure waits for tomorrow or a manual rescan.
    const hv = hvStore();
    for (const u of plan.keys()) {
      if (hv.values[u] || hvFailed.has(u)) continue;
      onProgress({ phase: "history", label: u });
      try {
        const r = await queued(`/v1/history?symbol=${encodeURIComponent(indexSymbol(u))}&interval=1d&countback=40`, seq);
        calls += 1;
        hv.values[u] = S.hvFromCandles(r.data?.data?.candles ?? []);
        write(HV_SLOT, hv);
      } catch (err) {
        if (err === CANCELLED) throw err;
        hvFailed.add(u);
      }
      onHv();
    }
    return { plan, total: order.length, calls, cancelled: false };
  } catch (err) {
    if (err === CANCELLED) return { plan, cancelled: true };
    throw err;
  }
}
/** Stop any sweep in flight: its pending awaits exit without drawing. */
const cancelSweep = () => {
  sweepSeq += 1;
};

// ── Keyboard: one listener for the tab; it acts on the screener on screen, if any ──
let activePage = null;
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    const p = activePage;
    if (!p || !p.root.isConnected || e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    // Enter and Space belong to the focused control (a button, link, tab or disclosure), never to the page shortcuts.
    if ((e.key === "Enter" || e.key === " ") && t instanceof Element && t.matches(ACTIVATES)) return;
    if (p.onKey(e)) e.preventDefault();
  });
}

const ACTIVATES = "button, a[href], summary, [role=tab], [role=button], [role=link], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=radio]";
/**
 * Replace a host's children and keep keyboard focus: a focused element carrying `data-fk` is refocused on the new node
 * with the same key, else the one at the same position, else `fallback`.
 */
function swapKeepFocus(host, nodes, fallback = null) {
  const a = document.activeElement;
  const inside = a && host.contains(a) && a !== host;
  const key = inside ? a.getAttribute("data-fk") : null;
  const idx = inside ? [...host.querySelectorAll("[data-fk]")].indexOf(a) : -1;
  host.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  if (!inside) return;
  const list = [...host.querySelectorAll("[data-fk]")];
  const t = list.find((x) => x.getAttribute("data-fk") === key) ?? (idx >= 0 && list.length ? list[Math.min(idx, list.length - 1)] : null) ?? fallback;
  t?.focus({ preventScroll: true });
}

const KEY_HINTS = [[["[", "]"], "Previous / next tab"], [["J", "K"], "Next / previous row"], [["↵"], "Open the detail"], [["C"], "Open in Option Chain"], [["B", "S"], "Add Buy / Sell to Strategy"], [["P"], "Pin or unpin the row"], [["R"], "Rescan every chain"], [["F"], "Filters"], [["A"], "Auto rescan on / off"], [["?"], "These shortcuts"], [["Esc"], "Close"]];
/** Tab labels for a narrow head (the full label stays in the tab's title and for screen readers). */
const TAB_TINY = { ivout: "IV out", arb: "Arb", buildup: "Build-up", unusual: "Unusual" };
const AUTO_LABEL = { 0: "Off", 60: "1m", 120: "2m", 300: "5m" };
/** Contract tabs: rows are single option legs (CE / PE capsule, side edge, match map, risk payoff). */
const CONTRACT = new Set(["unusual", "buildup", "sell", "buy", "ivout"]);

/**
 * Rank memory (docs/design/screener.md §8.1), module level so it survives navigation like the scan cache:
 * preset id → { keys: the ranking under the default sort at the end of the last sweep, diff: rankDiff map, at }.
 */
const rankMem = new Map();
/** The last score drawn in the detail ring, so the next one sweeps from it. */
let lastRing = 0;
/** Keys whose risk payoff has drawn once (the line reveal plays on the first open only). */
const revealed = new Set();

const sideOf = (r) => (r?.right === "PE" ? "put" : r?.right === "CE" ? "call" : null);
const cap = (right) => (right ? h("span", { class: `scr-cap ${right === "PE" ? "pe" : "ce"}` }, right) : null);
/** A chip: verdict, build-up tag or arbitrage status ({ text, tone, glyph, square, title }). */
function chipEl(c, extra = "") {
  if (!c) return null;
  return h("span", { class: `scr-pill t-${c.tone}${c.square ? " sq" : ""}${extra ? ` ${extra}` : ""}`, title: c.title ?? null }, c.glyph ? h("i", { "aria-hidden": "true" }, c.glyph) : null, c.text);
}
/** Arbitrage legs as tokens: [B|S] 2× 25450 PE @8.85. */
function legTokens(legs) {
  return (legs ?? []).map((l) =>
    h(
      "span",
      { class: "scr-leg" },
      h("b", { class: `scr-bs ${l.side === "BUY" ? "b" : "s"}`, title: l.side === "BUY" ? "Buy" : "Sell" }, l.side === "BUY" ? "B" : "S"),
      l.qty > 1 ? h("span", { class: "scr-leg-q" }, `${formatInt(l.qty)}×`) : null,
      h("span", { class: "scr-leg-k" }, formatInt(l.strike)),
      h("span", { class: `scr-leg-r ${l.right === "PE" ? "pe" : "ce"}` }, l.right),
      h("span", { class: "scr-leg-p" }, `@${formatFixed(l.price, 2)}`),
    ),
  );
}

/** The Option Screener page: the results panel and, from 1280 px, the detail column beside it. */
export function renderScreenerPage() {
  // A reload of the same route (header Reload, palette, go() to this page) renders again without a hashchange:
  // retire the previous instance first so its listeners, timers and sweep do not outlive it.
  activePage?.cleanup?.();
  const list = app.state.demo ? S.SCAN_DEMO_LIST : [...UNDERLYINGS, ...S.SCAN_STOCKS];
  let cfg = S.screenerConfig(read(SLOT), { list, demo: Boolean(app.state.demo) });
  const saved = read(SLOT);
  let autoOn = saved?.autoOn !== false;
  let mapOpen = saved?.mapOpen === true;
  const save = () => write(SLOT, { ...cfg, autoOn, mapOpen });
  const preset = () => S.presetById(cfg.preset);

  // Reference data (docs/spec/p1-02-reference.md §5): the charge table, rate and session close come from the first
  // scanned underlying's bundle (they are market-wide); the banners merge every scanned underlying's events.
  let ref = null;
  const refByU = new Map(); // underlying → its bundle, for the chip (the selected row's underlying)
  // The reference chip (spec §5.2): the selected row's underlying, else the first scanned one.
  const chipBundle = () => {
    const r = selKey ? recByKey(selKey) : null;
    return (r && refByU.get(r.underlying)) || ref;
  };
  const refChipEl = refChip({ getBundle: chipBundle, getLot: () => (selKey ? recByKey(selKey)?.lot ?? null : null) });
  refChipEl.el.classList.add("scr-ref");
  const refBannersEl = refBanners({ onMore: () => refChipEl.open() });
  const pctNow = () => O.chargesPct(refCharges(ref));
  // Brokerage per order: the user's setting, else the reference default (bundle.charges.brokerage, spec §5.6).
  const brokerage = () => cfg.brokerage ?? refCharges(ref).brokeragePerOrder;
  async function loadRefs() {
    const us = cfg.underlyings.length ? cfg.underlyings : list.slice(0, 1);
    const bs = await Promise.all(us.map((u) => loadReference(u)));
    if (destroyed) return;
    refByU.clear();
    us.forEach((u, i) => refByU.set(u, bs[i]));
    const first = bs[0] ?? null;
    // Compare what the bundle says, not the object, so an unchanged (or still failing) read does not redraw.
    const changed = refSignature(first) !== refSignature(ref);
    ref = first;
    refChipEl.update();
    const seen = new Set();
    const events = bs.flatMap((b) => b?.events ?? []).filter((e) => {
      const k = `${e.kind}|${e.underlying}|${e.effectiveOn}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    refBannersEl.update(first ? { ...first, events, lots: bs.find((b) => b?.lots?.stale)?.lots ?? first.lots } : null);
    if (changed) {
      memo.clear();
      draw();
    }
  }

  // Page state.
  let plan = null; // Map U → [{ expiry, monthly }]
  let progress = null; // { done, total, label, phase } while a sweep runs
  let scanning = false;
  let lastSweepFailed = false;
  let firstError = null;
  const issues = new Map(); // key → { label, message, retry? }
  let scan = null; // finishScan result
  let scanSig = "";
  const memo = new Map(); // U|E → { sig, rec }
  let result = null; // runPreset result for the current preset
  let entries = []; // what the results show: [{ r, rank, pinned, gone }]
  let shown = cfg.rows;
  let selKey = null;
  let autoSel = true; // the detail column picks rank 1 until the visitor closes it
  let destroyed = false;
  let current = null; // the chain being fetched now ("U|E")

  // ── Elements ──
  const tabs = h("div", { class: "scr-tabs", role: "tablist", "aria-label": "Screens" });
  const tabBtns = S.PRESETS.map((p) =>
    h("button", { type: "button", role: "tab", id: `scr-tab-${p.id}`, "aria-controls": "scr-results", class: "scr-tab", "data-id": p.id, "aria-label": p.label, title: p.description }, h("span", { class: "scr-tab-long" }, p.label), h("span", { class: "scr-tab-short" }, p.short), h("span", { class: "scr-tab-tiny", "aria-hidden": "true" }, TAB_TINY[p.id] ?? p.short)),
  );
  tabs.append(...tabBtns);
  const tabWrap = h("div", { class: "scr-tabwrap" }, tabs);
  const live = h("span", { class: "pal-sr-only", "aria-live": "polite", role: "status" });
  const rescanBtn = h("button", { type: "button", class: "small scr-btn scr-rescan", title: "Rescan every chain now (R)", "aria-label": "Rescan" }, icon("refresh"), h("span", { class: "scr-lbl" }, "Rescan"));
  const filtersBtn = h("button", { type: "button", class: "small scr-btn scr-filters-btn", "aria-haspopup": "dialog", title: "Filters (F)", "aria-label": "Filters" }, icon("sliders"), h("span", { class: "scr-lbl" }, "Filters"), h("span", { class: "scr-badge", hidden: true }));
  const gearBtn = h("button", { type: "button", class: "small scr-btn scr-gear", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Columns and scan settings", "aria-label": "Customise" }, icon("columns"));
  const keysBtn = h("button", { type: "button", class: "small scr-btn scr-keys-btn", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts" }, h("span", { "aria-hidden": "true" }, "?"));
  const sortChip = h("button", { type: "button", class: "small scr-btn scr-sortchip", "aria-haspopup": "dialog", "aria-expanded": "false" }, h("span", { class: "scr-sortchip-i", "aria-hidden": "true" }, "⇅"), h("span", { class: "scr-sortchip-t" }), h("span", { class: "scr-sortchip-d", "aria-hidden": "true" }));
  const countPhone = h("span", { class: "scr-count-m", "aria-hidden": "true" });
  const tools = h("div", { class: "scr-tools" }, sortChip, rescanBtn, filtersBtn, gearBtn, keysBtn, countPhone);
  const progressEl = h("div", { class: "scr-progress", role: "progressbar", "aria-label": "Scan progress", "aria-valuemin": "0", hidden: true }, h("span", {}));
  const uChips = h("div", { class: "scr-uchips", role: "group", "aria-label": "Underlyings" });
  const fChips = h("div", { class: "scr-fchips" });
  const countNum = h("b", {}, "");
  const countEl = h("span", { class: "scr-matches", "aria-live": "off" }, countNum, h("span", { class: "scr-matches-w" }, " matches"));
  const chipRow = h("div", { class: "scr-chips" }, uChips, h("span", { class: "scr-sep", "aria-hidden": "true" }), fChips, h("span", { class: "scr-grow" }), countEl);
  const legendEl = h("div", { class: "scr-legend-l" });
  const banners = h("div", { class: "scr-banners" });
  const mapBody = h("div", { class: "scr-map-body" });
  const mapEl = h("div", { class: "scr-map", id: "scr-map", hidden: true }, mapBody);
  // Overview, in the height a short list leaves (wide screens): every chain as a dot, IV/HV up, straddle % across.
  const scatBody = h("div", { class: "scr-scat-body" });
  const scatEl = h("div", { class: "scr-scat", hidden: true }, scatBody);
  const mapBtn = h("button", { type: "button", class: "small plain scr-map-btn", "aria-controls": "scr-map", "aria-expanded": String(mapOpen), title: "A scatter of every match: |Δ| across, the ranking up" }, h("span", { class: "scr-map-i", "aria-hidden": "true" }, "⁘"), "Match map");
  mapBtn.addEventListener("click", () => {
    mapOpen = !mapOpen;
    save();
    mapBtn.setAttribute("aria-expanded", String(mapOpen));
    drawMap(true);
  });
  const legendRow = h("div", { class: "scr-legend" }, legendEl, mapBtn);
  const caption = h("caption", { class: "pal-sr-only" });
  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", { class: "scr-table" }, caption, thead, tbody);
  const wrap = h("div", { class: "scr-wrap", id: "scr-results", role: "tabpanel" }, table);
  const cards = h("ul", { class: "scr-cards", "aria-label": "Results" });
  const emptyEl = h("div", { class: "scr-empty", hidden: true });
  const footCount = h("span", { class: "scr-count" });
  const moreBtn = h("button", { type: "button", class: "small scr-more", hidden: true });
  // A short list (Overview ranks chains, so 3 underlyings give 8 rows): the way to a longer one, beside the count.
  // Every underlying on: one more expiry each instead.
  const allOn = () => list.every((u) => cfg.underlyings.includes(u));
  const scanMoreBtn = h("button", {
    type: "button",
    class: "small plain scr-scan-more",
    hidden: true,
    onclick: () => (allOn() ? setCfg({ expiries: Math.min(3, cfg.expiries + 1) }, { rescan: true }) : openUnderlyings()),
  });
  const issuesEl = h("details", { class: "scr-issues", hidden: true });
  const methodEl = h("details", { class: "scr-method" });
  const foot = h("div", { class: "scr-foot" }, issuesEl, h("div", { class: "scr-foot-row" }, footCount, moreBtn, scanMoreBtn, h("span", { class: "scr-grow" }), methodEl));

  const head = h("header", { class: "scr-head" }, tabWrap, tools, progressEl);
  // Quick scans: the option-chain scans of the stock scanner's library, per strike here (a screen, a sort and a filter
  // over the records already swept: no network). The chip in use is pressed; any other change releases it.
  const dirOptions = S.FILTERS.direction?.options ?? [];
  const quickBtns = OPTION_QUICK_SCANS.map((q) =>
    h("button", { type: "button", class: "chip-btn scr-quick-chip", "data-id": q.id, "aria-pressed": "false", title: LIBRARY_BY_ID.get(q.library)?.plain ?? "", onclick: () => {
      const patch = quickScanPatch(cfg, q.id, dirOptions);
      if (!patch) return;
      shown = cfg.rows;
      if (patch.preset !== cfg.preset) {
        autoSel = true;
        swapPending = true;
      }
      setCfg(patch);
      centreTab(true);
    } }, q.label),
  );
  const quickRow = h("div", { class: "scr-quick", role: "group", "aria-label": "Quick scans" }, h("span", { class: "scr-quick-label" }, "Quick scans"), quickBtns);
  function drawQuick() {
    const on = activeQuickScan(cfg, dirOptions);
    for (const b of quickBtns) b.setAttribute("aria-pressed", String(b.dataset.id === on));
  }
  const main = h("section", { class: "desk-panel scr-main", "data-panel": "screener-main", "aria-label": "Option Screener" }, head, quickRow, chipRow, legendRow, banners, mapEl, wrap, scatEl, cards, emptyEl, foot, live);
  const paneBody = h("div", { class: "scr-pane" });
  const detail = h("section", { class: "desk-panel scr-detail", "data-panel": "screener-detail", "aria-label": "Selected row" }, paneBody);
  const root = main;

  // Toolbar: "3 underlyings · 7 chains" (a popover of the underlying chips) and the live control (auto + time + scan).
  const ctxMain = h("span", { class: "ctx-main" });
  const ctxBtn = h("button", { type: "button", class: "ctx-cap glass scr-ctx", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Underlyings in the scan" }, h("span", { class: "ctx-item ctx-scr" }, ctxMain));
  const liveDot = h("span", { class: "scr-ldot", "aria-hidden": "true" });
  const liveText = document.createTextNode("Starting");
  // Phones: the dot carries the time ("● 09:10") or the sweep count, so it reads without the popover.
  const liveDotBtn = h("button", { type: "button", class: "scr-live-dot", "aria-keyshortcuts": "A" }, liveDot);
  const liveTxtBtn = h("button", { type: "button", class: "scr-live-txt", "aria-haspopup": "dialog", "aria-expanded": "false" }, h("span", { class: "scr-live-w" }, liveText));
  const liveEl = h("div", { class: "scr-live glass" }, liveDotBtn, liveTxtBtn);

  // ── Config changes ──
  function setCfg(patch, { rescan = false } = {}) {
    cfg = S.screenerConfig({ ...cfg, ...patch }, { list, demo: Boolean(app.state.demo) });
    save();
    if (rescan) startSweep(false);
    draw();
  }
  const filters = () => cfg.filters[cfg.preset];
  const setFilter = (id, v) => {
    shown = cfg.rows;
    setCfg({ filters: { ...cfg.filters, [cfg.preset]: { ...filters(), [id]: v } } });
  };

  // ── Records ──
  function records() {
    const hv = hvStore().values;
    const parts = [];
    const keys = [];
    const universe = new Set(cfg.underlyings);
    const charges = { ...pctNow(), brokeragePerOrder: brokerage() };
    const rate = refRate(ref).value;
    const close = refSession(ref).close;
    const planned = plan ? new Set([...plan].flatMap(([u, l]) => l.map((x) => `${u}|${x.expiry}`))) : null;
    for (const [key, entry] of cache) {
      const [u, e] = key.split("|");
      if (!universe.has(u) || !entry.chain) continue;
      if (planned && !planned.has(key)) continue;
      const hv20 = hv[u]?.hv20 ?? null;
      const monthly = plan?.get(u)?.find((x) => x.expiry === e)?.monthly ?? O.isMonthly(e, expCache.get(u)?.list ?? []);
      const sig = `${entry.fetchedAt}|${hv20}|${charges.brokeragePerOrder}|${cfg.wingStrikes}|${cfg.hedgeNotional}|${monthly}|${rate}|${close}|${charges.asOf}`;
      let m = memo.get(key);
      if (!m || m.sig !== sig) {
        m = { sig, rec: S.chainRecords(entry.chain, { hv20, charges, rate, close, wingStrikes: cfg.wingStrikes, fetchedAt: entry.fetchedAt, monthly, notional: cfg.hedgeNotional }) };
        memo.set(key, m);
      }
      if (m.rec) {
        parts.push(m.rec);
        keys.push(`${key}|${m.sig}`);
      }
    }
    const sig = keys.sort().join(",");
    if (sig !== scanSig || !scan) {
      scanSig = sig;
      const base = read(BASE_SLOT);
      const today = S.istDate(Date.now());
      const b = base?.date === today ? base.rows : {};
      scan = S.finishScan(parts, { base: b });
    }
    const now = Date.now();
    const staleMs = staleAfter();
    const mark = (r) => {
      const entry = cache.get(`${r.underlying}|${r.expiry}`);
      r.age = now - (r.fetchedAt ?? now);
      r.stale = Boolean(entry?.stale) || r.age > staleMs;
    };
    for (const list of [scan.overview, scan.arbs, scan.legs, scan.hedges]) for (const r of list) mark(r);
    return scan;
  }
  const staleAfter = () => (cfg.auto ? cfg.auto * 2000 : 10 * 60_000);
  const presetRecords = (p) => S.recordsFor(scan, p).filter((r) => cfg.underlyings.includes(r.underlying));
  /** Is the current sort the tab's own ranking (the default sort)? Movement glyphs only make sense then. */
  const defaultSort = (p = preset()) => {
    const s = cfg.sort[p.id];
    return s.by === p.defaults.sort.by && s.dir === p.defaults.sort.dir;
  };
  function recompute() {
    records();
    const p = preset();
    const t0 = performance.now();
    result = S.runPreset(presetRecords(p), p, filters(), cfg.sort[p.id], { ctx: { expiries: scannedExpiries() } });
    result.ms = performance.now() - t0;
    // Pinned rows first (§8.6); the rank stays the row's place in the screen's ranking.
    const pins = cfg.pins?.[p.id] ?? [];
    const rankOf = new Map(result.rows.map((r, i) => [r.key, i + 1]));
    const pinned = [];
    if (pins.length) {
      const all = new Map(presetRecords(p).map((r) => [r.key, r]));
      for (const k of pins) {
        const r = rankOf.has(k) ? result.rows[rankOf.get(k) - 1] : all.get(k);
        if (r) pinned.push({ r, rank: rankOf.get(k) ?? null, pinned: true, gone: !rankOf.has(k) });
      }
    }
    const pinSet = new Set(pinned.map((e) => e.r.key));
    const rest = result.rows.filter((r) => !pinSet.has(r.key)).slice(0, shown).map((r) => ({ r, rank: rankOf.get(r.key), pinned: false, gone: false }));
    entries = [...pinned, ...rest];
    result.rankOf = rankOf;
    return result;
  }
  const scannedExpiries = () => [...new Set([...cache.keys()].filter((k) => cfg.underlyings.includes(k.split("|")[0])).map((k) => k.split("|")[1]))].sort();
  /** At the end of a sweep: every tab's ranking under its default sort, and the movement since the last sweep. */
  function snapshotRanks() {
    if (!scan) return;
    const at = Date.now();
    for (const p of S.PRESETS) {
      const keys = S.runPreset(presetRecords(p), p, cfg.filters[p.id], null, { ctx: { expiries: scannedExpiries() } }).rows.map((r) => r.key);
      const sig = JSON.stringify([cfg.filters[p.id], cfg.underlyings, cfg.expiries, cfg.monthly, cfg.strikes]);
      rankMem.set(p.id, S.rankSnapshot(rankMem.get(p.id), keys, sig, at));
    }
  }

  // ── Sweep driver ──
  function startSweep(force) {
    if (destroyed) return;
    loadRefs();
    scanning = true;
    lastSweepFailed = false;
    if (force) issues.clear();
    progress = { done: 0, total: plan ? [...plan.values()].reduce((a, l) => a + l.length, 0) : 0, label: "", phase: "start" };
    drawStatus();
    runSweep({
      cfg,
      force,
      close: refSession(ref).close,
      onProgress: (p) => {
        if (destroyed) return;
        if (p.phase === "plan") plan = p.plan;
        progress = { ...progress, ...p };
        current = p.phase === "chain" && p.current ? chainKeyOf(p.label) : null;
        drawStatus();
      },
      onChain: () => !destroyed && requestDraw(),
      onHv: () => !destroyed && requestDraw(),
      onIssue: (i) => {
        if (i.clear) issues.delete(i.key);
        else issues.set(i.key, i);
        if (!firstError && i.error) firstError = i.error;
        if (!destroyed) drawIssues();
      },
    })
      .then((r) => {
        if (destroyed || r.cancelled) return;
        scanning = false;
        sweepEndedAt = Date.now();
        progress = null;
        current = null;
        const planned = [...(plan ?? new Map())].flatMap(([u, l]) => l.map((x) => `${u}|${x.expiry}`));
        const ok = planned.filter((k) => cache.get(k)?.chain && !cache.get(k)?.error);
        lastSweepFailed = (planned.length > 0 && ok.length === 0) || (planned.length === 0 && issues.size > 0);
        if (ok.length) firstError = null;
        // The day's first snapshot per chain feeds "Δ since hh:mm" on Overview.
        if (scan?.overview?.length) {
          const today = S.istDate(Date.now());
          const next = S.dailyBaseline(read(BASE_SLOT), today, scan.overview.map((o) => ({ key: o.key, atmIv: o.atmIv, straddle: o.straddle, pcr: o.pcr, at: o.fetchedAt })));
          write(BASE_SLOT, next.stored);
          scanSig = "";
        }
        records();
        snapshotRanks();
        draw();
        liveTick();
        const n = result?.total ?? 0;
        live.textContent = lastSweepFailed ? "Scan failed" : `Scan complete: ${formatInt(ok.length)} chains, ${formatInt(n)} matches`;
      })
      .catch((err) => {
        if (destroyed) return;
        scanning = false;
        progress = null;
        current = null;
        firstError = err;
        lastSweepFailed = true;
        draw();
      });
  }
  /** "NIFTY 3 Nov" → "NIFTY|2026-11-03" from the plan (the progress callback carries the label). */
  function chainKeyOf(label) {
    for (const [u, l] of plan ?? new Map()) for (const x of l) if (S.chainName(u, x.expiry) === label) return `${u}|${x.expiry}`;
    return null;
  }
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }
  function startAuto() {
    if (!autoOn || !cfg.auto) return stopTimer();
    every(cfg.auto * 1000, async () => {
      if (scanning || destroyed) return;
      startSweep(false);
    });
  }

  // ── Tabs: a contrast capsule with a sliding thumb (foundation §3.3) ──
  let thumbMeasured = false;
  function placeThumb() {
    const b = tabBtns.find((x) => x.dataset.id === cfg.preset);
    if (!b || !tabs.isConnected || !b.offsetWidth) return;
    if (!thumbMeasured) tabs.classList.add("no-anim");
    tabs.style.setProperty("--seg-x", `${b.offsetLeft}px`);
    tabs.style.setProperty("--seg-w", `${b.offsetWidth}px`);
    tabs.classList.add("has-thumb");
    if (!thumbMeasured) {
      thumbMeasured = true;
      requestAnimationFrame(() => tabs.classList.remove("no-anim"));
    }
  }
  const tabRo =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          placeThumb();
          tabEdges();
          if (!wrap.hidden) {
            fitCols();
            wrapEdges();
          }
        })
      : null;
  tabRo?.observe(tabs);
  /** The scroll fades at each edge only while there is more to scroll that way. */
  function tabEdges() {
    const max = tabs.scrollWidth - tabs.clientWidth;
    tabWrap.classList.toggle("fade-l", tabs.scrollLeft > 2);
    tabWrap.classList.toggle("fade-r", max - tabs.scrollLeft > 2);
  }
  tabs.addEventListener("scroll", tabEdges, { passive: true });
  function drawTabs() {
    for (const b of tabBtns) {
      const on = b.dataset.id === cfg.preset;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    wrap.setAttribute("aria-labelledby", `scr-tab-${cfg.preset}`);
    placeThumb();
    tabEdges();
  }
  function centreTab(smooth) {
    const b = tabBtns.find((x) => x.dataset.id === cfg.preset);
    if (!b || tabs.scrollWidth <= tabs.clientWidth) return;
    const left = b.offsetLeft - (tabs.clientWidth - b.offsetWidth) / 2;
    tabs.scrollTo({ left: Math.max(0, left), behavior: smooth && !reducedMotion() ? "smooth" : "instant" });
  }
  function pickPreset(id, focus = false) {
    if (!S.PRESET_IDS.includes(id)) return;
    shown = cfg.rows;
    if (id !== cfg.preset) {
      autoSel = true;
      swapPending = true;
    }
    setCfg({ preset: id });
    const b = tabBtns.find((x) => x.dataset.id === id);
    if (focus) b?.focus({ preventScroll: true });
    centreTab(true);
  }
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) pickPreset(b.dataset.id);
  });
  tabs.addEventListener("keydown", (e) => {
    const i = S.PRESET_IDS.indexOf(cfg.preset);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? S.PRESET_IDS.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    pickPreset(S.PRESET_IDS[(j + S.PRESET_IDS.length) % S.PRESET_IDS.length], true);
  });
  rescanBtn.addEventListener("click", () => rescan());
  function rescan() {
    cancelSweep();
    startSweep(true);
  }
  function toggleAuto() {
    if (!cfg.auto) {
      openLive();
      return;
    }
    autoOn = !autoOn;
    save();
    drawStatus();
    startAuto();
  }
  filtersBtn.addEventListener("click", () => openFilters());
  gearBtn.addEventListener("click", () => openCustomise());
  keysBtn.addEventListener("click", () => openKeys());
  sortChip.addEventListener("click", () => openSort());
  ctxBtn.addEventListener("click", () => openUnderlyings());
  liveDotBtn.addEventListener("click", () => (phone() ? openLive() : toggleAuto()));
  liveTxtBtn.addEventListener("click", () => openLive());
  moreBtn.addEventListener("click", () => {
    shown += cfg.rows;
    draw();
  });

  // ── Status: the toolbar's live control, the progress line, the chain dots ──
  function chainState(key) {
    const e = cache.get(key);
    if (scanning && key === current) return "fetching";
    if (e?.error && !e?.chain) return "error";
    if (e?.error) return "error";
    if (!e?.chain) return "pending";
    if (e.stale || Date.now() - e.fetchedAt > staleAfter()) return "stale";
    return scanning && progress?.phase === "chain" && e.fetchedAt < sweepStartedAt ? "pending" : "done";
  }
  let sweepStartedAt = 0;
  let sweepEndedAt = 0;
  let liveSig = "";
  function drawStatus() {
    const running = scanning && progress;
    if (running && progress.phase === "start") sweepStartedAt = Date.now();
    const planned = [...(plan ?? new Map())].flatMap(([u, l]) => l.map((x) => `${u}|${x.expiry}`));
    const got = planned.map((k) => cache.get(k)).filter((x) => x?.chain);
    const total = planned.length;
    const oldest = got.reduce((a, x) => (a === null || x.fetchedAt < a.fetchedAt ? x : a), null);
    const stale = got.some((x) => x.stale || Date.now() - x.fetchedAt > staleAfter());
    const auto = autoOn && cfg.auto > 0;
    let kind;
    let words;
    if (running) {
      const at = Math.min(progress.done + (progress.current ? 1 : 0), progress.total || 0);
      kind = "scanning";
      words = progress.total ? `Scanning ${formatInt(at)}/${formatInt(progress.total)}` : "Scanning";
    } else if (lastSweepFailed) {
      kind = "error";
      words = "Not updating";
    } else if (!plan) {
      kind = "waiting";
      words = "Starting";
    } else if (stale && oldest) {
      kind = "stale";
      words = `Stale · ${S.ageText(Date.now() - oldest.fetchedAt)}`;
    } else if (!auto) {
      kind = "paused";
      words = `${cfg.auto ? "Paused" : "Auto off"}${oldest ? ` · ${S.istHm(oldest.fetchedAt)}` : ""}`;
    } else {
      kind = "live";
      words = `Auto ${AUTO_LABEL[cfg.auto] ?? `${formatInt(cfg.auto / 60)}m`}${oldest ? ` · ${istTime(oldest.asOf)}` : ""}`;
    }
    const sig = `${kind}|${words}|${auto}|${cfg.auto}`;
    if (sig !== liveSig) {
      liveSig = sig;
      if (liveText.data !== words) liveText.data = words;
      liveEl.dataset.kind = kind;
      liveDotBtn.setAttribute("aria-pressed", String(auto));
      const what = !cfg.auto ? "Auto rescan is off" : auto ? `Auto rescan every ${AUTO_LABEL[cfg.auto]}` : "Auto rescan paused";
      liveDotBtn.setAttribute("aria-label", phone() ? `${words}. Scan status and auto rescan` : `${what}. ${cfg.auto ? (auto ? "Pause" : "Resume") : "Choose an interval"} (A)`);
      liveDotBtn.title = phone() ? words : `${what}. Click to ${cfg.auto ? (auto ? "pause" : "resume") : "choose an interval"} (A)`;
      liveTxtBtn.setAttribute("aria-label", `${words}. Scan status, rescan and the auto interval`);
      liveTxtBtn.title = `${running ? "Chains are fetched one at a time within the broker's rate limits" : "The oldest chain's time"}. Click for the scan`;
    }
    // The context capsule: "3 underlyings · 7 chains" ("NIFTY+2 · 7 chains" on phones).
    const n = cfg.underlyings.length;
    const chainsText = running || got.length === total ? `${formatInt(total)} chain${total === 1 ? "" : "s"}` : `${formatInt(got.length)} of ${formatInt(total)} chains`;
    const uText = phone() ? (n === 1 ? cfg.underlyings[0] : `${cfg.underlyings[0]}+${formatInt(n - 1)}`) : `${formatInt(n)} underlying${n === 1 ? "" : "s"}`;
    const ctxText = `${uText}${plan && !phone() ? ` · ${chainsText}` : ""}`;
    if (ctxMain.textContent !== ctxText) ctxMain.textContent = ctxText;
    // The full list for screen readers (the phone text abbreviates it as "NIFTY+2").
    const ctxAria = `Underlyings in the scan: ${cfg.underlyings.join(", ")}${plan ? `, ${chainsText}` : ""}`;
    if (ctxBtn.getAttribute("aria-label") !== ctxAria) ctxBtn.setAttribute("aria-label", ctxAria);
    progressEl.hidden = !running;
    if (running) {
      const t = progress.total || 1;
      const d = Math.min(t, progress.done + (progress.current ? 1 : 0));
      progressEl.setAttribute("aria-valuemax", String(t));
      progressEl.setAttribute("aria-valuenow", String(d));
      progressEl.firstChild.style.setProperty("--v", String(Math.round((1000 * d) / t) / 1000));
    }
    main.setAttribute("aria-busy", String(Boolean(running && !scan?.chains)));
    if (livePop) drawLiveBody();
  }
  /** One ring pulse on the live dot per finished sweep (never an endless loop). */
  let tickFlip = false;
  function liveTick() {
    tickFlip = !tickFlip;
    liveDot.classList.toggle("tick-a", tickFlip);
    liveDot.classList.toggle("tick-b", !tickFlip);
  }

  // ── Chips ──
  // Underlying chips are built once and patched, so a focused chip keeps focus through every redraw.
  function toggleUnderlying(u, b) {
    const on = cfg.underlyings.includes(u);
    if (on && cfg.underlyings.length === 1) {
      b?.classList.remove("shake");
      requestAnimationFrame(() => b?.classList.add("shake"));
      return false;
    }
    shown = cfg.rows;
    setCfg({ underlyings: on ? cfg.underlyings.filter((x) => x !== u) : list.filter((x) => x === u || cfg.underlyings.includes(x)) }, { rescan: !on });
    return true;
  }
  const uBtnFor = (u) => {
    const b = h("button", { type: "button", class: "scr-uchip", "data-u": u }, u);
    b.addEventListener("click", () => toggleUnderlying(u, b));
    return b;
  };
  const uBtns = list.map(uBtnFor);
  uChips.append(...uBtns);
  function paintUChip(b) {
    const u = b.dataset.u;
    const on = cfg.underlyings.includes(u);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = on && cfg.underlyings.length === 1 ? "Keep at least one" : on ? `Leave ${u} out of the scan` : `Scan ${u}`;
  }
  let fChipSig = "";
  function drawChips() {
    for (const b of uBtns) paintUChip(b);
    const p = preset();
    const f = filters();
    const active = p.filters.filter((id) => S.filterActive(id, f[id]));
    // A chip only for a value that differs from the preset's default (the defaults are listed in Filters).
    const shownChips = active.filter((id) => JSON.stringify(f[id]) !== JSON.stringify(S.filterDefault(p, id)));
    const changed = p.filters.some((id) => JSON.stringify(f[id]) !== JSON.stringify(S.filterDefault(p, id)));
    const ctx = { expiries: scannedExpiries() };
    const sig = JSON.stringify([p.id, shownChips.map((id) => [id, S.filterText(id, f[id], ctx)]), changed]);
    if (sig !== fChipSig) {
      fChipSig = sig;
      swapKeepFocus(
        fChips,
        [
          ...shownChips.map((id) =>
            h(
              "span",
              { class: "scr-chip" },
              h("button", { type: "button", class: "scr-chip-body", "data-fk": `${id}:body`, title: "Change in Filters", onclick: () => openFilters(id) }, S.filterText(id, f[id], ctx)),
              h("button", { type: "button", class: "scr-chip-x", "data-fk": `${id}:x`, "aria-label": `Remove filter ${S.filterText(id, f[id], ctx)}`, onclick: () => setFilter(id, offValue(id)) }, icon("close")),
            ),
          ),
          ...(changed ? [h("button", { type: "button", class: "small plain scr-reset", "data-fk": "reset", onclick: () => resetFilters() }, "Reset")] : []),
        ],
        filtersBtn,
      );
      chipRow.classList.toggle("has-f", fChips.childElementCount > 0);
    }
    const badge = filtersBtn.querySelector(".scr-badge");
    // The badge counts the changed filters (the chips, which phones fold away).
    badge.hidden = !shownChips.length;
    badge.textContent = formatInt(shownChips.length);
    filtersBtn.setAttribute("aria-label", `Filters${shownChips.length ? `, ${shownChips.length} changed` : ""}`);
  }
  const offValue = (id) => {
    const f = S.FILTERS[id];
    return f.type === "range" ? [null, null] : f.type === "toggle" ? false : f.type === "seg" ? f.options[0][0] : null;
  };
  function resetFilters() {
    const p = preset();
    shown = cfg.rows;
    setCfg({ filters: { ...cfg.filters, [p.id]: S.defaultFilters(p) } });
  }

  // ── Match count: counts up from the last value (§7) ──
  let countVal = null;
  function drawCount(n) {
    const text = formatInt(n);
    if (countVal === n && countNum.textContent === text) return;
    const from = countVal;
    countVal = n;
    if (from === null || reducedMotion()) {
      stopCount(countNum);
      countNum.textContent = text;
    } else countUp(countNum, from, n, (v) => formatInt(Math.round(v)), text);
    countEl.lastChild.textContent = n === 1 ? " match" : " matches";
    const m = `${text} ${n === 1 ? "match" : "matches"}`;
    if (countPhone.textContent !== m) countPhone.textContent = m;
    countEl.setAttribute("aria-label", m);
  }

  // ── Legend row (§6.1) ──
  let legendSig = "";
  function drawLegend() {
    const p = preset();
    const popOn = p.id === "sell" && num(filters().pop) !== null ? filters().pop : null;
    // Bunched scores are shaded by rank: the ramp then reads low → high rank, not the fixed bands.
    const sc = p.columns.find((c) => c.viz?.kind === "score");
    const live = entries.filter((e) => !e.gone).map((e) => e.r);
    const bunched = sc ? S.scoreScale(live.map((r) => sc.get(r))).bunched : false;
    // No rows (an empty tab): no colours to explain.
    legendRow.hidden = Boolean(scan) && !live.length;
    const sig = `${p.id}|${popOn}|${bunched}`;
    if (sig === legendSig) return;
    legendSig = sig;
    const items = (p.legend ?? []).map((it) => {
      if (it.kind === "ramp")
        return h(
          "li",
          { class: "scr-lg-ramp" },
          h("span", {}, it.label === "Score" && bunched ? "Score, shaded by rank" : it.label),
          h("span", { class: "scr-ramp", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map((i) => h("i", { "data-seq": String(i) }))),
          it.label === "Score" && bunched ? h("span", { class: "scr-ramp-t" }, "lower · higher in this list") : it.ticks ? h("span", { class: "scr-ramp-t" }, it.ticks.join(" · ")) : null,
        );
      if (it.kind === "none") return h("li", { class: "scr-lg-note" }, it.label);
      const key = h("span", { class: `dv-key ${it.kind === "swatch" || !it.kind ? "" : it.kind}`.trim(), "aria-hidden": "true", "data-dv": it.token });
      const label = it.label === "POP" && popOn !== null ? `POP (tick at the ${formatInt(popOn)}% filter)` : it.label;
      return h("li", {}, key, h("span", {}, label));
    });
    legendEl.replaceChildren(h("ul", { class: "dv-legend scr-lg", "aria-label": `${p.label}: how to read the colours` }, items));
  }

  // ── Results: table (≥ 720 px) or cards ──
  let headSig = "";
  let bodySig = "";
  const rowEls = new Map();
  let groupRows = null;
  /** The visible columns, with the tab's ranking column moved next to the lead (rank first, §2). */
  function columns() {
    const p = preset();
    const cols = S.visibleColumns(p, cfg.cols[cfg.preset]);
    const i = cols.findIndex((c) => c.id === p.defaults.sort.by);
    if (i > 1) cols.splice(1, 0, ...cols.splice(i, 1));
    return cols;
  }
  function buildHead(cols) {
    const p = preset();
    const s = cfg.sort[p.id];
    const rankTh = h("th", { scope: "col", class: "rk", title: "Rank in this screen's own ranking. ▲ / ▼: places moved since the last scan; a dot: new since then" }, h("span", { "aria-hidden": "true" }, "#"), h("span", { class: "pal-sr-only" }, "Rank"));
    thead.replaceChildren(
      h(
        "tr",
        {},
        rankTh,
        cols.map((c) => {
          const sorted = s.by === c.id;
          const th = h("th", { scope: "col", class: [c.num && !c.text ? "num" : "", c.lead ? "lead" : "", c.p === 3 ? "p3" : c.p === 2 ? "p2" : "", c.wrap ? "wrap" : "", c.viz ? `vz-${c.viz.kind}` : "", c.id === p.defaults.sort.by ? "rank-col" : ""].join(" ").trim() || null, title: c.title || null, "aria-sort": sorted ? (s.dir === "asc" ? "ascending" : "descending") : null });
          if (!c.sortable) th.append(c.label);
          else th.append(h("button", { type: "button", class: "scr-sort-btn", "data-col": c.id }, c.label, h("span", { class: "scr-sort-i", "aria-hidden": "true" }, sorted ? (s.dir === "asc" ? "▲" : "▼") : "")));
          return th;
        }),
      ),
    );
  }
  thead.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-col]");
    if (!b) return;
    const p = preset();
    const c = p.columns.find((x) => x.id === b.dataset.col);
    const s = cfg.sort[p.id];
    const dir = s.by === c.id ? (s.dir === "asc" ? "desc" : "asc") : c.dir;
    setCfg({ sort: { ...cfg.sort, [p.id]: { by: c.id, dir } } });
    thead.querySelector(`button[data-col="${c.id}"]`)?.focus();
  });
  function setText(el, text) {
    if (el.__t !== text) {
      el.__t = text;
      el.textContent = text;
    }
  }
  const setCls = (el, cls) => {
    if (el.__cls !== cls) {
      el.__cls = cls;
      el.className = cls;
    }
  };
  /** Per-column scales over the rows shown: heat steps, bar maxima (p95), centred-bar scales. */
  function scalesFor(cols, rows) {
    const out = new Map();
    for (const c of cols) {
      const v = c.viz;
      if (!v) continue;
      const key = c.sortGet ?? c.get;
      if (v.kind === "seq" && v.scale === "rank") {
        const steps = S.rankHeat(rows.map((r) => key(r)), c.dir);
        out.set(c.id, { steps: new Map(rows.map((r, i) => [r.key, steps[i]])) });
      } else if (v.kind === "div") {
        const steps = S.signedHeat(rows.map((r) => c.get(r)));
        out.set(c.id, { steps: new Map(rows.map((r, i) => [r.key, steps[i]])) });
      } else if (v.kind === "bar") out.set(c.id, { max: v.max === "p95" ? S.p95Abs(rows.map((r) => c.get(r))) : v.max });
      else if (v.kind === "cbar" && v.signed) out.set(c.id, { m: S.p95Abs(rows.map((r) => v.signed(r))) });
      else if (v.kind === "score") {
        const ss = S.scoreScale(rows.map((r) => c.get(r)), rows.map((r) => v.of(r)?.raw ?? c.get(r)));
        out.set(c.id, { steps: ss.steps ? new Map(rows.map((r, i) => [r.key, ss.steps[i]])) : null, dec: ss.dec, bunched: ss.bunched });
      }
    }
    return out;
  }
  /** Build the visual part of a cell once (bars, dots, tracks, the score's composition). */
  function makeViz(td, c) {
    const v = c.viz;
    if (!v) return;
    if (v.kind === "bar") {
      td.__bar = hbar({ value: 0, max: 1 });
      td.__tick = v.tick ? h("i", { class: "scr-tick", hidden: true }) : null;
      td.append(h("span", { class: "scr-mbar", "aria-hidden": "true" }, td.__bar, td.__tick));
    } else if (v.kind === "cbar") {
      // The centred bar sits left of the value (one line, so the row stays 40 px with a sub line).
      td.__fill = h("span", { class: "scr-cbar-f" });
      td.__cbar = h("span", { class: "scr-cbar", "aria-hidden": "true" }, h("i", { class: "scr-cbar-z" }), td.__fill);
      const txt = h("span", { class: "scr-cell-t" }, ...td.childNodes);
      td.append(h("span", { class: "scr-cell-row" }, td.__cbar, txt));
    } else if (v.kind === "meter") {
      td.__dots = Array.from({ length: 5 }, () => h("i"));
      td.append(h("span", { class: "scr-dots", "aria-hidden": "true" }, td.__dots));
    } else if (v.kind === "sigma") {
      td.__sdot = h("i", { class: "scr-sig-d" });
      td.append(h("span", { class: "scr-sig", "aria-hidden": "true" }, h("i", { class: "scr-sig-band" }), h("i", { class: "scr-sig-1" }), td.__sdot));
    } else if (v.kind === "score") {
      td.__segs = Array.from({ length: 4 }, (_, i) => h("i", { "data-i": String(i) }, h("b")));
      td.__comp = h("span", { class: "scr-comp", "aria-hidden": "true" }, td.__segs);
      td.__warn = h("span", { class: "scr-pen", "aria-hidden": "true", hidden: true }, "⚠");
      td.__v.after(td.__warn);
      td.append(td.__comp);
    } else if (v.kind === "chip") {
      td.__chip = h("span", { class: "scr-chipbox" });
      td.prepend(td.__chip);
    } else if (v.kind === "legs") {
      td.__legs = h("span", { class: "scr-legs-t" });
      td.append(td.__legs);
    }
  }
  function paintViz(td, c, r, sc) {
    const v = c.viz;
    if (!v) return "";
    const val = c.get(r);
    if (v.kind === "seq") {
      const st = v.scale === "score" ? S.scoreStep(val) : sc?.steps.get(r.key) ?? 0;
      heatCell(td, st || null, "seq");
      return "";
    }
    if (v.kind === "score") {
      const sco = v.of(r);
      // Bunched scores are shaded by rank among the rows shown, so the order can be read by eye.
      const st = sc?.steps?.get(r.key) ?? S.scoreStep(val);
      heatCell(td, st || null, "seq");
      const parts = S.scoreParts(sco);
      const pen = Boolean(sco?.penalties?.length);
      td.__segs.forEach((seg, i) => {
        const pt = parts[i];
        seg.hidden = !pt;
        if (!pt) return;
        seg.style.setProperty("--w", String(Math.round(pt.share * 1000) / 1000));
        seg.style.setProperty("--v", String(Math.round(pt.fill * 1000) / 1000));
      });
      td.__comp.classList.toggle("pen", pen);
      td.__warn.hidden = !pen;
      return [pen ? `× 0.5: ${sco.penalties.join(", ")}` : "", sc?.steps ? "Shaded by rank among the rows shown: the scores are close together" : ""].filter(Boolean).join(" · ");
    }
    if (v.kind === "div") {
      const st = sc?.steps.get(r.key);
      heatCell(td, st === null || st === undefined ? null : st, "div");
      return "";
    }
    if (v.kind === "bar") {
      const tone = v.tone === "side" ? sideOf(r) ?? "call" : v.tone;
      if (td.__bar.dataset.dv !== tone) td.__bar.dataset.dv = tone;
      setBar(td.__bar, num(val) === null ? 0 : Math.abs(val), sc?.max ?? 1);
      if (td.__tick) {
        const t = v.tick === "pop" ? num(filters().pop) : null;
        td.__tick.hidden = t === null;
        if (t !== null) td.__tick.style.setProperty("--t", String(Math.min(1, t / 100)));
      }
      return "";
    }
    if (v.kind === "cbar") {
      const x = v.signed ? S.centred(v.signed(r), sc?.m) : v.at(r);
      const tone = v.tone(r);
      if (td.__cbar.dataset.tone !== tone) td.__cbar.dataset.tone = tone;
      td.__cbar.classList.toggle("dec", Boolean(v.dec?.(r)));
      td.__cbar.classList.toggle("outline", Boolean(v.outline?.(r)));
      td.__cbar.classList.toggle("none", x === null);
      const s = String(x === null ? 0 : Math.round(x * 1000) / 1000);
      if (td.__fill.style.getPropertyValue("--v") !== s) td.__fill.style.setProperty("--v", s);
      return "";
    }
    if (v.kind === "meter") {
      const n = num(val) ?? 0;
      td.__dots.forEach((d, i) => d.classList.toggle("lit", i < n));
      return "";
    }
    if (v.kind === "sigma") {
      const pos = S.sigmaPos(val);
      td.__sdot.hidden = pos === null;
      if (pos !== null) td.__sdot.style.setProperty("--p", String(Math.round(pos * 1000) / 1000));
      return "";
    }
    if (v.kind === "chip") {
      const ch = v.chip(r);
      const sig = ch ? `${ch.tone}|${ch.text}` : "";
      if (td.__chip.__sig !== sig) {
        td.__chip.__sig = sig;
        td.__chip.replaceChildren(...(ch ? [chipEl(ch)] : []));
      }
      return "";
    }
    if (v.kind === "legs") {
      const sig = r.legs?.length ? r.legs.map((l) => `${l.side}${l.qty}${l.strike}${l.right}${l.price}`).join(",") : r.legsText;
      if (td.__legs.__sig !== sig) {
        td.__legs.__sig = sig;
        td.__legs.replaceChildren(...(r.legs?.length ? legTokens(r.legs) : [h("span", { class: "scr-legs-note" }, r.legsText)]));
      }
      return "";
    }
    return "";
  }
  /** The text a cell shows: chips and leg tokens carry it themselves (the text stays for cards and labels). */
  function cellText(c, r) {
    if (c.viz?.kind === "chip") return c.viz.label ? c.viz.label(r) : "";
    if (c.viz?.kind === "legs") return "";
    return c.fmt(c.get(r), r) ?? DASH;
  }
  /** A score with one decimal when the top rows tie on the integer. */
  const scoreText = (c, r, sc) => (sc?.dec && num(c.viz.of(r)?.raw) !== null ? formatFixed(c.viz.of(r).raw, 1) : null);
  function fillCell(td, c, r, sc, flash) {
    if (c.lead) return fillLead(td, c, r);
    const text = (c.viz?.kind === "score" && scoreText(c, r, sc)) || cellText(c, r);
    const before = td.__v.__t;
    const prevNum = td.__num;
    setText(td.__v, text);
    const sub = c.sub ? c.sub(r) : "";
    if (td.__s) {
      setText(td.__s, sub);
      td.__s.hidden = !sub;
    }
    const extraTitle = paintViz(td, c, r, sc);
    const ink = c.ink ? c.ink(r) : null;
    const subInk = c.subInk ? c.subInk(r) : null;
    const cls = [c.num && !c.text ? "num" : "", c.p === 3 ? "p3" : c.p === 2 ? "p2" : "", c.wrap ? "wrap" : "", c.viz ? `vz vz-${c.viz.kind}` : "", ink ? `ink-${ink}` : "", subInk ? `sub-${subInk}` : "", c.id === preset().defaults.sort.by ? "rank-col" : "", td.classList.contains("dv-heat") ? "dv-heat" : ""].join(" ").trim();
    if (td.__cls !== cls) {
      td.__cls = cls;
      td.className = cls;
    }
    const ttl = [c.ttl ? c.ttl(r) : "", extraTitle].filter(Boolean).join(" · ");
    if ((td.title || "") !== ttl) td.title = ttl;
    // A value that changed with new data flashes once: up green, down red (never on a tab or sort change).
    const n = num(c.sortGet ? c.sortGet(r) : c.get(r));
    td.__num = n;
    if (flash && before !== undefined && before !== text && c.num && n !== null && prevNum !== null && prevNum !== undefined && n !== prevNum) flashValue(td, n > prevNum ? "up" : "down");
  }
  /** The lead cell: "NIFTY 3 Nov" + strike + the CE / PE capsule (contracts), or the name; the sub line below. */
  function fillLead(td, c, r) {
    const parts = r.kind === "contract" ? r.nameParts : null;
    const sig = parts ? `${parts.head}|${parts.strike}|${parts.right}` : `${c.get(r)}|${r.kind === "hedge" ? "PE" : ""}`;
    if (td.__sig !== sig) {
      td.__sig = sig;
      if (parts) td.__v.replaceChildren(h("span", { class: "nm" }, parts.head), " ", h("b", { class: "k" }, parts.strike), " ", cap(parts.right));
      else td.__v.replaceChildren(...[h("span", { class: "nm" }, c.fmt(c.get(r), r) ?? DASH), r.kind === "hedge" ? cap("PE") : null].filter(Boolean));
    }
    const sub = c.sub ? c.sub(r) ?? "" : "";
    if (td.__s) {
      // "Expires today" in the sub line is a warning (a warn dot and ink).
      const warn = /^Expires today/.test(sub);
      if (td.__s.__t !== sub) {
        td.__s.__t = sub;
        td.__s.replaceChildren(...(warn ? [h("i", { class: "scr-wdot", "aria-hidden": "true" }), h("span", { class: "ink-warn" }, "Expires today"), sub.slice("Expires today".length)] : [sub]));
      }
      td.__s.hidden = !sub;
    }
    const side = r.kind === "contract" ? (r.right === "PE" ? "side-pe" : "side-ce") : r.kind === "hedge" ? "side-pe" : "";
    setCls(td, ["lead", side].filter(Boolean).join(" "));
  }
  function makeCell(c) {
    const td = h(c.lead ? "th" : "td", c.lead ? { scope: "row" } : {});
    td.__v = h(c.lead ? "strong" : "span", { class: "v" });
    td.append(td.__v);
    if (c.sub) {
      td.__s = h("small", { class: "s" });
      td.append(td.__s);
    }
    makeViz(td, c);
    return td;
  }
  function makeRankCell() {
    const td = h("td", { class: "rk" });
    td.__n = h("span", { class: "rk-n" });
    td.__m = h("span", { class: "rk-m", hidden: true });
    td.__d = h("i", { class: "rk-d", hidden: true, "aria-hidden": "true" });
    td.append(td.__d, td.__n, td.__m);
    return td;
  }
  /** The rank cell: number (★ when pinned), ▲3 / ▼2 for one sweep, a dot when new or stale. */
  function fillRank(td, e, move) {
    const rank = e.rank;
    setText(td.__n, e.pinned ? "★" : rank === null ? DASH : formatInt(rank));
    td.classList.toggle("top", !e.pinned && rank !== null && rank <= 3);
    td.classList.toggle("pin", e.pinned);
    const m = move && !e.pinned && !e.gone ? move : null;
    const mv = m && m.delta ? `${m.delta > 0 ? "▲" : "▼"}${formatInt(Math.abs(m.delta))}` : "";
    setText(td.__m, mv);
    td.__m.hidden = !mv;
    td.__m.className = `rk-m ${m?.delta > 0 ? "up" : "down"}`;
    const dot = e.r.stale ? "stale" : m?.isNew ? "new" : "";
    td.__d.hidden = !dot;
    td.__d.className = `rk-d ${dot}`;
    const mem = rankMem.get(cfg.preset);
    const title = [e.pinned ? (e.gone ? "Pinned · no longer matches" : `Pinned · rank ${formatInt(rank)}`) : "", m?.isNew ? `New match since ${S.istHm(mem?.prevAt)}` : "", m?.delta ? `${m.delta > 0 ? "Up" : "Down"} ${formatInt(Math.abs(m.delta))} since the last scan` : "", e.r.stale ? `Data ${S.ageText(e.r.age)} old` : ""].filter(Boolean).join(" · ");
    if ((td.title || "") !== title) td.title = title;
  }
  /** "Rank 1, up 3. NIFTY 3 Nov 27000 CE. IV 7.9 pts under HV · …" */
  function rowLabel(e, move, p) {
    const m = move?.delta ? `, ${move.delta > 0 ? "up" : "down"} ${formatInt(Math.abs(move.delta))}` : move?.isNew ? ", new" : "";
    const lead = e.pinned ? (e.gone ? "Pinned, no longer matches" : `Pinned, rank ${formatInt(e.rank)}`) : `Rank ${formatInt(e.rank)}${m}`;
    return `${lead}. ${e.r.name}. ${S.reason(e.r, p.id)}`;
  }
  function groupRow(label, n) {
    const th = h("th", { colspan: String(n), scope: "colgroup" }, label);
    return h("tr", { class: "scr-group", "aria-hidden": "false" }, th);
  }
  let swapPending = false;
  function drawTable(list) {
    const cols = columns();
    const p = preset();
    const hs = `${p.id}|${cols.map((c) => c.id).join(",")}|${JSON.stringify(cfg.sort[p.id])}`;
    const bs = `${p.id}|${cols.map((c) => c.id).join(",")}`;
    const fresh = bs !== bodySig;
    if (hs !== headSig) {
      headSig = hs;
      buildHead(cols);
    }
    if (fresh) {
      bodySig = bs;
      tbody.replaceChildren();
      rowEls.clear();
      groupRows = null;
    }
    caption.textContent = `${p.label}: ${formatInt(result?.total ?? 0)} matches`;
    const live = list.filter((e) => !e.gone).map((e) => e.r);
    const scales = scalesFor(cols, live);
    const mem = defaultSort(p) ? rankMem.get(p.id) : null;
    const focusKey = selKey && list.some((e) => e.r.key === selKey) ? selKey : list[0]?.r.key;
    // FLIP (§7): where each kept row sits now, before the patch moves it (rows in view only).
    const anim = !fresh && !reducedMotion() && !wrap.hidden;
    const before = new Map();
    if (anim && rowEls.size && rowEls.size <= 400) {
      const box = wrap.getBoundingClientRect();
      for (const [k, tr] of rowEls) {
        const t = tr.getBoundingClientRect().top;
        if (t > box.top - 60 && t < box.bottom + 60) before.set(k, t);
      }
    }
    const pinned = list.some((e) => e.pinned);
    if (pinned && !groupRows) groupRows = [groupRow("Pinned", cols.length + 1), groupRow("All matches", cols.length + 1)];
    if (!pinned && groupRows) {
      for (const g of groupRows) g.remove();
      groupRows = null;
    }
    const keep = new Set();
    const created = [];
    let prev = null;
    const place = (el) => {
      const want = prev ? prev.nextSibling : tbody.firstChild;
      if (want !== el) tbody.insertBefore(el, want);
      prev = el;
    };
    if (groupRows) place(groupRows[0]);
    let restStarted = false;
    for (const e of list) {
      const r = e.r;
      if (groupRows && !e.pinned && !restStarted) {
        restStarted = true;
        place(groupRows[1]);
      }
      keep.add(r.key);
      let tr = rowEls.get(r.key);
      const isNewEl = !tr;
      if (!tr) {
        tr = h("tr", { "data-key": r.key });
        tr.__rank = makeRankCell();
        tr.__cells = cols.map((c) => makeCell(c));
        tr.append(tr.__rank, ...tr.__cells);
        rowEls.set(r.key, tr);
        if (!fresh) created.push(tr);
      }
      const flash = !isNewEl && tr.__at !== undefined && tr.__at !== r.fetchedAt;
      tr.__at = r.fetchedAt;
      const move = mem?.diff.get(r.key) ?? null;
      fillRank(tr.__rank, e, move);
      cols.forEach((c, i) => fillCell(tr.__cells[i], c, r, scales.get(c.id), flash));
      const sel = r.key === selKey;
      if (tr.__sel !== sel) {
        tr.__sel = sel;
        tr.setAttribute("aria-selected", String(sel));
        tr.classList.toggle("sel", sel);
      }
      tr.classList.toggle("stale", Boolean(r.stale));
      tr.classList.toggle("gone", Boolean(e.gone));
      const tab = r.key === focusKey ? 0 : -1;
      if (tr.tabIndex !== tab) tr.tabIndex = tab;
      const label = rowLabel(e, move, p);
      if (tr.getAttribute("aria-label") !== label) tr.setAttribute("aria-label", label);
      place(tr);
    }
    for (const [k, tr] of rowEls) {
      if (keep.has(k)) continue;
      tr.remove();
      rowEls.delete(k);
    }
    // Barred entry of the first draw of a tab: bars grow from zero once, later sweeps resize them.
    if (fresh) {
      barsEnter(tbody);
      if (swapPending && !reducedMotion()) wrap.animate?.([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      swapPending = false;
      return;
    }
    if (!anim) return;
    // FLIP: rows that moved slide from their old place; new rows fade in from the left with a short stagger.
    const moved = [];
    for (const [k, top] of before) {
      const tr = rowEls.get(k);
      if (!tr) continue;
      const dy = top - tr.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) moved.push([tr, dy]);
    }
    if (moved.length <= 40) for (const [tr, dy] of moved) tr.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    created.slice(0, 12).forEach((tr, i) => tr.animate?.([{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: Math.min(200, i * 20), easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }));
  }
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (tr) select(tr.dataset.key, { open: true });
  });
  const mousePin = (e) => (e.pointerType ? e.pointerType === "mouse" : e.button === 2 && matchMedia("(any-pointer: fine)").matches);
  tbody.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr[data-key]");
    // A right-click pins; a touch long-press (also a contextmenu) keeps the native menu and never pins by accident.
    if (!tr || !mousePin(e)) return;
    e.preventDefault();
    togglePin(tr.dataset.key);
  });
  tbody.addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(tr.dataset.key, { open: true });
    }
  });
  // Sticky rank + lead columns get their right edge only while the table is scrolled sideways; a right fade shows
  // while more columns sit off-screen.
  /**
   * Below the detail-column width (tablets), the table fits its panel instead of slicing a column mid-glyph: first
   * chip columns drop their words (the 2-letter chip stays), then priority-2 columns go. Desktop keeps every column
   * and scrolls, with the right-edge fade.
   */
  function fitCols() {
    if (wrap.hidden || phone()) return;
    const over = () => wrap.scrollWidth > wrap.clientWidth + 1;
    // Every width: beside the detail column a wide tab (Overview's 16 columns) overflows at 1920 px too, so chip
    // columns keep the chip, then priority-2 columns go, before anything is cut at the edge.
    delete wrap.dataset.fit;
    if (!over()) return;
    wrap.dataset.fit = "0";
    if (over()) wrap.dataset.fit = "1";
    if (over()) wrap.dataset.fit = "2";
  }
  function wrapEdges() {
    wrap.classList.toggle("scrolled-x", wrap.scrollLeft > 1);
    wrap.classList.toggle("more-x", wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 2);
  }
  wrap.addEventListener("scroll", wrapEdges, { passive: true });

  // ── Pins (§8.6) ──
  function togglePin(key) {
    const p = preset();
    const pins = cfg.pins?.[p.id] ?? [];
    const on = pins.includes(key);
    if (!on && pins.length >= S.MAX_PINS) return toast(`Up to ${S.MAX_PINS} pinned rows per tab`, { tone: "info" });
    const next = on ? pins.filter((k) => k !== key) : [...pins, key];
    setCfg({ pins: { ...cfg.pins, [p.id]: next } });
    paneSig = "";
    drawPane();
    toast(on ? "Unpinned" : "Pinned: it stays at the top of this tab");
  }
  const isPinned = (key) => (cfg.pins?.[cfg.preset] ?? []).includes(key);

  // ── Phone cards (§6.9) ──
  let cardSig = "";
  const cardEls = new Map();
  /** The card's badge: the ranking value on its heat step, or the tab's chip. */
  function badgeFor(c, r, sc) {
    const v = c.viz;
    if (v?.kind === "chip") return { chip: v.chip(r), text: c.fmt(c.get(r), r) };
    const text = (c.cardFmt ?? c.fmt)(c.get(r), r);
    if (v?.kind === "score") return { text: scoreText(c, r, sc) || text, seq: sc?.steps?.get(r.key) || S.scoreStep(c.get(r)) || null };
    if (v?.kind === "seq") return { text, seq: sc?.steps.get(r.key) || null };
    if (v?.kind === "div") return { text, div: sc?.steps.get(r.key) ?? null };
    if (v?.kind === "cbar") return { text, tone: v.tone(r), outline: Boolean(v.outline?.(r)) };
    return { text };
  }
  function cardFor(e, p, scales) {
    const r = e.r;
    let c = cardEls.get(r.key);
    if (!c) {
      const btn = h("button", { type: "button", class: "scr-card", "data-key": r.key });
      const rk = h("span", { class: "scr-c-rk" });
      const name = h("span", { class: "scr-c-nm" });
      const sub = h("span", { class: "scr-c-sub" });
      const badge = h("span", { class: "scr-c-badge" });
      const keys = [0, 1, 2].map(() => {
        const viz = h("span", { class: "scr-k-viz", "aria-hidden": "true" });
        const v = h("b", { class: "scr-k-v" });
        const l = h("span", { class: "scr-k-l" });
        return { viz, v, l, el: h("span", { class: "scr-k" }, viz, v, l) };
      });
      const whyChip = h("span", { class: "scr-c-whychip" });
      const whyT = h("span", { class: "scr-c-whyt" });
      const why = h("span", { class: "scr-c-why" }, whyChip, whyT);
      btn.append(rk, h("span", { class: "scr-c-main" }, h("span", { class: "scr-c-1" }, name), sub), badge, h("span", { class: "scr-c-keys" }, keys.map((k) => k.el)), why);
      c = { li: h("li", {}, btn), btn, rk, name, sub, badge, keys, why, whyChip, whyT };
      cardEls.set(r.key, c);
    }
    const col = (id) => p.columns.find((x) => x.id === id);
    const mem = defaultSort(p) ? rankMem.get(p.id) : null;
    const move = mem?.diff.get(r.key) ?? null;
    // Rank, movement, new / stale dot.
    const mv = move?.delta && !e.pinned ? `${move.delta > 0 ? "▲" : "▼"}${formatInt(Math.abs(move.delta))}` : "";
    const rkSig = `${e.pinned}|${e.rank}|${mv}|${move?.isNew}|${r.stale}`;
    if (c.rk.__sig !== rkSig) {
      c.rk.__sig = rkSig;
      c.rk.replaceChildren(
        ...[
          h("b", { class: e.rank !== null && e.rank <= 3 && !e.pinned ? "top" : "" }, e.pinned ? "★" : e.rank === null ? DASH : `#${formatInt(e.rank)}`),
          mv ? h("small", { class: move.delta > 0 ? "up" : "down" }, mv) : r.stale ? h("i", { class: "rk-d stale" }) : move?.isNew ? h("i", { class: "rk-d new" }) : null,
        ].filter(Boolean),
      );
    }
    const parts = r.kind === "contract" ? r.nameParts : null;
    const nmSig = parts ? `${parts.head}|${parts.strike}|${parts.right}` : `${r.name}|${r.chain ?? ""}`;
    if (c.name.__sig !== nmSig) {
      c.name.__sig = nmSig;
      if (parts) c.name.replaceChildren(h("span", {}, parts.head), " ", h("b", {}, parts.strike), " ", cap(parts.right));
      else if (r.kind === "hedge") c.name.replaceChildren(h("span", {}, r.chain), " ", h("b", {}, formatInt(r.strike)), " ", cap("PE"));
      else if (r.kind === "arb") c.name.replaceChildren(h("span", {}, r.type), h("span", { class: "scr-c-chain" }, ` · ${r.chain}`));
      else c.name.replaceChildren(h("span", {}, r.name));
    }
    const subText = r.kind === "arb" ? (r.legs?.length ? "" : r.legsText) : r.sub ?? "";
    setText(c.sub, subText);
    c.sub.hidden = !subText;
    if (r.kind === "arb" && r.legs?.length) {
      const sig = r.legs.map((l) => `${l.side}${l.qty}${l.strike}${l.right}${l.price}`).join(",");
      if (c.sub.__legs !== sig) {
        c.sub.__legs = sig;
        c.sub.__t = undefined;
        c.sub.replaceChildren(...legTokens(r.legs));
        c.sub.hidden = false;
      }
    }
    // Badge.
    const bc = col(p.card.badge);
    const b = badgeFor(bc, r, scales.get(bc.id));
    const bSig = JSON.stringify([b.text, b.seq, b.div, b.tone, b.outline, b.chip?.text, b.chip?.tone]);
    if (c.badge.__sig !== bSig) {
      c.badge.__sig = bSig;
      if (b.chip !== undefined) {
        c.badge.className = "scr-c-badge chip";
        c.badge.replaceChildren(...(b.chip ? [chipEl(b.chip)] : [h("span", {}, DASH)]));
      } else {
        c.badge.className = `scr-c-badge box${b.tone ? ` t-${b.tone}` : ""}${b.outline ? " outline" : ""}`;
        delete c.badge.dataset.seq;
        delete c.badge.dataset.div;
        if (b.seq) c.badge.dataset.seq = String(b.seq);
        if (b.div !== null && b.div !== undefined) c.badge.dataset.div = String(b.div);
        c.badge.replaceChildren(h("span", {}, b.text ?? DASH));
      }
    }
    const aria = [rowLabel(e, move, p).split(". ")[0], r.name, `${bc.label} ${b.chip ? b.chip.text : b.text}`];
    p.card.keys.forEach((id, i) => {
      const k = col(id);
      const kk = c.keys[i];
      setText(kk.l, k.cardLabel ?? k.label);
      const t = k.viz?.kind === "chip" ? k.viz.label?.(r) || k.fmt(k.get(r), r) : (k.cardFmt ?? k.fmt)(k.get(r), r);
      // A chip key (the build-up) shows its 2-letter chip on the card; the words stay in the label for readers.
      const chip = k.viz?.kind === "chip" ? k.viz.chip(r) : undefined;
      if (chip !== undefined) {
        const cs = `chip|${chip?.text ?? ""}|${chip?.tone ?? ""}`;
        if (kk.v.__t !== cs) {
          kk.v.__t = cs;
          kk.v.replaceChildren(chip ? chipEl({ ...chip, title: t || chip.title }) : DASH);
        }
      } else setText(kk.v, t);
      const ink = k.ink?.(r);
      setCls(kk.v, `scr-k-v${ink ? ` ink-${ink}` : ""}`);
      // The first key carries its micro-visual (POP bar, σ track, centred bar, depth bar).
      if (i === 0) paintCardViz(kk.viz, k, r, scales.get(k.id));
      aria.push(`${k.label} ${t}`);
    });
    // Overview and Hedge: one line of the two leading facts; Overview's build-up words become a chip.
    const why = S.reason(r, p.id);
    const brief = p.id === "overview" ? S.reason({ ...r, build: null, pcr: null }, p.id) : p.id === "hedge" ? why.split(" · ").slice(0, 2).join(" · ") : why;
    setText(c.whyT, brief);
    const bchip = p.id === "overview" && r.build ? { text: r.build.tag, tone: r.build.bias === "bullish" ? "pos" : "neg", square: true, title: r.build.text } : null;
    const bs = bchip ? `${bchip.text}|${bchip.tone}` : "";
    if (c.whyChip.__sig !== bs) {
      c.whyChip.__sig = bs;
      c.whyChip.replaceChildren(...(bchip ? [chipEl(bchip), h("span", {}, r.build.bias)] : []));
      c.whyChip.hidden = !bchip;
    }
    c.why.hidden = !brief && !bchip;
    if (why) aria.push(why);
    const label = aria.join(", ");
    if (c.btn.getAttribute("aria-label") !== label) c.btn.setAttribute("aria-label", label);
    const sel = r.key === selKey;
    const side = r.kind === "contract" ? (r.right === "PE" ? "side-pe" : "side-ce") : r.kind === "hedge" ? "side-pe" : r.kind === "arb" ? (r.status === "Executable" ? "side-pos" : r.status === "Near miss" ? "side-warn" : "") : "";
    setCls(c.btn, ["scr-card", side, sel ? "sel" : "", r.stale ? "stale" : "", e.gone ? "gone" : "", p.kind === "contract" ? "tall" : ""].filter(Boolean).join(" "));
    c.btn.setAttribute("aria-current", sel ? "true" : "false");
    return c;
  }
  function paintCardViz(host, k, r, sc) {
    const v = k.viz;
    const kind = v?.kind;
    if (host.__kind !== kind) {
      host.__kind = kind;
      host.replaceChildren();
      host.hidden = !["bar", "cbar", "sigma"].includes(kind);
      if (kind === "bar") host.append((host.__bar = hbar({ value: 0, max: 1 })));
      if (kind === "cbar") host.append((host.__cbar = h("span", { class: "scr-cbar" }, h("i", { class: "scr-cbar-z" }), (host.__fill = h("span", { class: "scr-cbar-f" })))));
      if (kind === "sigma") host.append(h("span", { class: "scr-sig" }, h("i", { class: "scr-sig-band" }), h("i", { class: "scr-sig-1" }), (host.__sdot = h("i", { class: "scr-sig-d" }))));
    }
    if (kind === "bar") {
      const tone = v.tone === "side" ? sideOf(r) ?? "call" : v.tone;
      host.__bar.dataset.dv = tone;
      setBar(host.__bar, Math.abs(num(k.get(r)) ?? 0), sc?.max ?? 1);
    } else if (kind === "cbar") {
      const x = v.signed ? S.centred(v.signed(r), sc?.m) : v.at(r);
      host.__cbar.dataset.tone = v.tone(r);
      host.__cbar.classList.toggle("dec", Boolean(v.dec?.(r)));
      host.__cbar.classList.toggle("outline", Boolean(v.outline?.(r)));
      host.__fill.style.setProperty("--v", String(x === null ? 0 : Math.round(x * 1000) / 1000));
    } else if (kind === "sigma") {
      const pos = S.sigmaPos(k.get(r));
      host.__sdot.hidden = pos === null;
      if (pos !== null) host.__sdot.style.setProperty("--p", String(pos));
    }
  }
  function drawCards(list) {
    const p = preset();
    const fresh = cardSig !== p.id;
    if (fresh) {
      cardSig = p.id;
      cards.replaceChildren();
      cardEls.clear();
    }
    const live = list.filter((e) => !e.gone).map((e) => e.r);
    const used = [p.card.badge, p.card.keys[0]].map((id) => p.columns.find((x) => x.id === id));
    const scales = scalesFor(used, live);
    const keep = new Set();
    const created = [];
    let prev = null;
    for (const e of list) {
      keep.add(e.r.key);
      const had = cardEls.has(e.r.key);
      const c = cardFor(e, p, scales);
      if (!had && !fresh) created.push(c.li);
      const want = prev ? prev.nextSibling : cards.firstChild;
      if (want !== c.li) cards.insertBefore(c.li, want);
      prev = c.li;
    }
    for (const [k, c] of cardEls) {
      if (keep.has(k)) continue;
      c.li.remove();
      cardEls.delete(k);
    }
    if (fresh) {
      barsEnter(cards);
      if (swapPending && !reducedMotion()) cards.animate?.([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      swapPending = false;
    } else if (!reducedMotion()) created.slice(0, 8).forEach((li, i) => li.animate?.([{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: Math.min(200, i * 20), easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }));
  }
  cards.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (b) select(b.dataset.key, { open: true });
  });
  cards.addEventListener("contextmenu", (e) => {
    const b = e.target.closest("button[data-key]");
    // A right-click pins; a touch long-press (also a contextmenu) keeps the native menu and never pins by accident.
    if (!b || !mousePin(e)) return;
    e.preventDefault();
    togglePin(b.dataset.key);
  });
  function skeleton() {
    if (phone()) {
      cardSig = "";
      cardEls.clear();
      cards.replaceChildren(...Array.from({ length: 5 }, () => h("li", { class: "scr-skel", "aria-hidden": "true" }, h("span", { class: "skel" }), h("span", { class: "skel short" }), h("span", { class: "skel mid" }))));
    } else {
      headSig = "";
      bodySig = "";
      rowEls.clear();
      groupRows = null;
      buildHead(columns());
      const n = columns().length + 1;
      tbody.replaceChildren(...Array.from({ length: 8 }, () => h("tr", { class: "scr-skel", "aria-hidden": "true" }, Array.from({ length: n }, (_, i) => h("td", { class: i === 0 ? "rk" : i === 1 ? "lead" : null }, h("span", { class: "skel" }))))));
    }
  }

  // ── Match map (§11.15): |Δ| across, the ranking metric up, one dot per match, linked to the table ──
  let mapSig = "";
  const MAP = { W: 720, H: 140, l: 34, r: 10, t: 10, b: 20 };
  function mapMetric(p) {
    if (p.id === "unusual") return { get: (r) => r.volOiRel, log: true, label: "× median (log scale)", fmt: (v) => `${formatFixed(v, 1)}×` };
    if (p.id === "buildup") return { get: (r) => r.committed, log: true, label: "₹ committed (log scale)", fmt: (v) => `₹${formatCompact(v)}` };
    if (p.id === "ivout") return { get: (r) => r.bump, log: false, label: "Bump (vol pts)", fmt: (v) => formatSigned(v, 1) };
    // Scores with their decimals, so bunched scores still spread out on the fitted axis.
    if (p.id === "buy") return { get: (r) => r.buy?.raw ?? r.scoreBuy, log: false, label: "Score", fixed: [0, 100], fmt: (v) => formatInt(v) };
    return { get: (r) => r.sell?.raw ?? r.scoreSell, log: false, label: "Score", fixed: [0, 100], fmt: (v) => formatInt(v) };
  }
  // ── The chain scatter (Overview, wide screens, when the list leaves room under the table) ──
  let scatSig = "";
  const SCAT = { l: 46, r: 14, t: 26, b: 26, minH: 180 };
  function drawScatter(force = false) {
    const p = preset();
    const rows = p.id === "overview" && wide() && result?.rows?.length ? result.rows : null;
    if (!rows) {
      scatEl.hidden = true;
      scatSig = "";
      return;
    }
    scatEl.hidden = false;
    const W = Math.round(scatEl.clientWidth);
    const H = Math.round(scatEl.clientHeight);
    // Too little room under the table: no chart (the list is long enough to fill the panel).
    if (W < 320 || H < SCAT.minH) {
      scatEl.classList.add("scr-scat-off");
      scatSig = "";
      return;
    }
    scatEl.classList.remove("scr-scat-off");
    const pts = rows.map((r) => ({ r, x: num(r.straddlePct), y: num(r.ivHvRatio) })).filter((d) => d.x !== null && d.y !== null);
    const sig = `${W}|${H}|${selKey}|${pts.map((d) => `${d.r.key}:${formatFixed(d.x, 2)}:${formatFixed(d.y, 2)}`).join(",")}`;
    if (!force && sig === scatSig) return;
    scatSig = sig;
    if (!pts.length) return scatBody.replaceChildren();
    const legendH = 26;
    const plotH = H - legendH;
    const { l, r: rr, t, b } = SCAT;
    const xs = pts.map((d) => d.x);
    const ys = pts.map((d) => d.y);
    const pad = (lo, hi, m) => [lo - Math.max((hi - lo) * 0.08, m), hi + Math.max((hi - lo) * 0.08, m)];
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs), 0.2);
    // The y axis always shows the 1.0x line (IV equal to HV), the line the verdict is read against.
    const [y0, y1] = pad(Math.min(1, ...ys), Math.max(1, ...ys), 0.05);
    const X = (v) => l + ((v - x0) / (x1 - x0)) * (W - l - rr);
    const Y = (v) => t + (1 - (v - y0) / (y1 - y0)) * (plotH - t - b);
    const svg = svgEl("svg", { class: "scr-scat-svg", viewBox: `0 0 ${W} ${plotH}`, width: W, height: plotH, role: "img", "aria-label": `${formatInt(pts.length)} chains by straddle % of spot and IV/HV` });
    for (const v of O.niceTicks(x0, x1, 6).filter((v) => v >= x0 && v <= x1)) {
      svg.append(svgEl("line", { class: "dv-grid", x1: X(v), x2: X(v), y1: t, y2: plotH - b }));
      svg.append(svgEl("text", { class: "dv-tick", x: X(v), y: plotH - 8, "text-anchor": "middle" }, `${formatFixed(v, 1)}%`));
    }
    for (const v of O.niceTicks(y0, y1, 4).filter((v) => v >= y0 && v <= y1)) {
      svg.append(svgEl("line", { class: "dv-grid", x1: l, x2: W - rr, y1: Y(v), y2: Y(v) }));
      svg.append(svgEl("text", { class: "dv-tick", x: l - 6, y: Y(v) + 4, "text-anchor": "end" }, `${formatFixed(v, 2)}×`));
    }
    svg.append(svgEl("line", { class: "scr-scat-one", x1: l, x2: W - rr, y1: Y(1), y2: Y(1) }));
    svg.append(svgEl("text", { class: "dv-tick", x: W - rr, y: Y(1) - 5, "text-anchor": "end" }, "IV = HV"));
    svg.append(svgEl("text", { class: "dv-tick", x: W - rr, y: plotH - 8 - 14, "text-anchor": "end" }, "Straddle % of spot"));
    svg.append(svgEl("text", { class: "dv-tick", x: l, y: t - 10 }, "IV/HV"));
    const g = svgEl("g", { class: "scr-scat-dots" });
    // Labels for as many dots as fit without overlapping a label or another dot, the highest IV/HV first.
    const boxes = pts.map((d) => [X(d.x) - 6, Y(d.y) - 6, X(d.x) + 6, Y(d.y) + 6]);
    const order = [...pts].sort((a, c) => c.y - a.y);
    const labels = svgEl("g", { class: "scr-scat-labels" });
    for (const d of order) {
      const v = d.r.verdict?.label ?? "";
      const tone = v.startsWith("Rich") ? "rich" : v.startsWith("Cheap") ? "cheap" : "fair";
      const sel = d.r.key === selKey;
      const cx = X(d.x);
      const cy = Y(d.y);
      g.append(svgEl("circle", { cx, cy, r: sel ? 6 : 4.5, class: `scr-sdot ${tone}${sel ? " sel" : ""}`, "data-key": d.r.key }, svgEl("title", {}, `${d.r.name} · IV/HV ${formatFixed(d.y, 2)}× · straddle ${formatFixed(d.x, 2)}% · ${v || "no verdict"}`)));
      const txt = d.r.name ?? d.r.underlying;
      const w = 7.2 * txt.length + 4;
      const box = [cx + 7, cy - 8, cx + 7 + w, cy + 6];
      if (box[2] > W - rr || boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      boxes.push(box);
      labels.append(svgEl("text", { class: "scr-scat-l", x: cx + 8, y: cy + 4 }, txt));
    }
    svg.append(g, labels);
    const sel = pts.find((d) => d.r.key === selKey);
    if (sel) svg.append(svgEl("circle", { class: "scr-dot-ring", cx: X(sel.x), cy: Y(sel.y), r: 9 }));
    scatBody.replaceChildren(
      h("ul", { class: "dv-legend scr-scat-lg", "aria-hidden": "true" }, h("li", {}, h("span", { class: "dv-key dot scr-k-rich" }), "Rich"), h("li", {}, h("span", { class: "dv-key dot scr-k-fair" }), "Fair"), h("li", {}, h("span", { class: "dv-key dot scr-k-cheap" }), "Cheap"), h("li", { class: "scr-lg-note" }, "Every scanned chain: IV/HV up, straddle % of spot across. Click a dot to select it")),
      svg,
    );
  }
  scatBody.addEventListener("click", (e) => {
    const c = e.target.closest?.("circle[data-key]");
    if (c) select(c.getAttribute("data-key"), { scroll: true });
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => drawScatter()).observe(scatEl);

  function drawMap(force = false) {
    const p = preset();
    const on = wide() && CONTRACT.has(p.id) && Boolean(result?.total);
    mapBtn.hidden = !on;
    mapEl.hidden = !on || !mapOpen;
    if (!on || !mapOpen) return;
    const rows = result.rows;
    const m = mapMetric(p);
    const sig = `${p.id}|${selKey}|${rows.length}|${rows.slice(0, 400).map((r) => `${r.key}:${m.get(r)}:${r.absDelta}`).join(",")}`;
    if (!force && sig === mapSig) return;
    mapSig = sig;
    const W = Math.max(320, Math.round(mapBody.clientWidth || MAP.W));
    const { H, l, r: rr, t, b } = MAP;
    const ys = rows.map((r) => num(m.get(r))).filter((v) => v !== null && (!m.log || v > 0));
    const tf = (v) => (m.log ? Math.log2(v) : v);
    // The y axis fits the values shown (p2–p98, padded 5%), never a fixed 0–100 that piles every dot on one line.
    const tvs = ys.map(tf);
    let lo = O.percentileOf(tvs, 0.02);
    let hi = O.percentileOf(tvs, 0.98);
    if (lo === null || hi === null) return mapBody.replaceChildren();
    const padY = Math.max((hi - lo) * 0.05, m.fixed ? 1 : 1e-6);
    lo -= padY;
    hi += padY;
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    if (m.fixed) {
      lo = Math.max(m.fixed[0], lo);
      hi = Math.min(m.fixed[1], hi);
    }
    // |Δ| from 0 to just past the widest match (at least 0.4), so a narrow Δ band still spreads out.
    const dMax = Math.min(1, Math.max(0.4, Math.ceil((Math.max(...rows.map((x) => num(x.absDelta) ?? 0)) + 0.04) * 10) / 10));
    const X = (d) => l + (Math.max(0, Math.min(dMax, d)) / dMax) * (W - l - rr);
    const Y = (v) => t + (1 - Math.max(0, Math.min(1, (tf(v) - lo) / (hi - lo)))) * (H - t - b);
    const svg = svgEl("svg", { class: "scr-map-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `Match map: ${formatInt(rows.length)} matches by |Δ| and ${m.label}` });
    for (const d of [0.1, 0.25, 0.5, 0.75].filter((x) => x <= dMax)) {
      svg.append(svgEl("line", { class: "dv-grid", x1: X(d), x2: X(d), y1: t, y2: H - b }));
      svg.append(svgEl("text", { class: "dv-tick", x: X(d), y: H - 5, "text-anchor": "middle" }, formatFixed(d, 2)));
    }
    const yTicks = m.log ? [lo, (lo + hi) / 2, hi].map((v) => 2 ** v) : O.niceTicks(lo, hi, 4).filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
    for (const v of yTicks) {
      svg.append(svgEl("line", { class: "dv-grid", x1: l, x2: W - rr, y1: Y(v), y2: Y(v) }));
      svg.append(svgEl("text", { class: "dv-tick", x: l - 5, y: Y(v) + 3.5, "text-anchor": "end" }, m.fmt(v)));
    }
    svg.append(svgEl("text", { class: "dv-tick", x: W - rr, y: H - 5, "text-anchor": "end" }, "|Δ|"));
    const g = svgEl("g", { class: "scr-map-dots" });
    const top = [];
    rows.forEach((row, i) => {
      const v = num(m.get(row));
      const d = num(row.absDelta);
      if (v === null || d === null || (m.log && v <= 0)) return;
      const sel = row.key === selKey;
      const c = svgEl("circle", { cx: X(d), cy: Y(v), r: sel ? 5 : 3.5, class: `scr-dot ${row.right === "PE" ? "pe" : "ce"}${sel ? " sel" : ""}`, "data-key": row.key }, svgEl("title", {}, `#${formatInt(i + 1)} ${row.name} · ${m.label} ${m.fmt(v)} · |Δ| ${formatFixed(d, 2)}`));
      g.append(c);
      if (i < 5) top.push([X(d), Y(v), i + 1]);
    });
    svg.append(g);
    // Ranks 1–5, each skipped when its box would overlap one already placed (rank 1 first).
    const boxes = [];
    for (const [x, y, n] of top) {
      const box = [x + 4, y - 14, x + 4 + 8 * String(n).length + 2, y - 2];
      if (boxes.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      boxes.push(box);
      svg.append(svgEl("text", { class: "scr-map-n", x: x + 5, y: y - 4 }, formatInt(n)));
    }
    const sel = rows.find((x) => x.key === selKey);
    if (sel && num(m.get(sel)) !== null && num(sel.absDelta) !== null) svg.append(svgEl("circle", { class: "scr-dot-ring", cx: X(sel.absDelta), cy: Y(m.get(sel)), r: 7 }));
    mapBody.replaceChildren(
      h("ul", { class: "dv-legend scr-map-lg", "aria-hidden": "true" }, h("li", {}, h("span", { class: "dv-key dot", "data-dv": "call" }), "CE"), h("li", {}, h("span", { class: "dv-key dot", "data-dv": "put" }), "PE"), h("li", { class: "scr-lg-note" }, `Up: ${m.label}. Numbers: the top 5`)),
      svg,
    );
  }
  mapBody.addEventListener("click", (e) => {
    const c = e.target.closest?.("circle[data-key]");
    if (c) select(c.getAttribute("data-key"), { scroll: true });
  });
  mapBody.addEventListener("pointerover", (e) => {
    const c = e.target.closest?.("circle[data-key]");
    for (const tr of tbody.querySelectorAll("tr.hl")) tr.classList.remove("hl");
    if (c) rowEls.get(c.getAttribute("data-key"))?.classList.add("hl");
  });
  mapBody.addEventListener("pointerleave", () => {
    for (const tr of tbody.querySelectorAll("tr.hl")) tr.classList.remove("hl");
  });

  // ── Empty, banners, footer ──
  let emptySig = "";
  function drawEmpty() {
    // Leave-one-out: name only the filters whose removal alone brings rows back, with how many.
    const blockers = S.topBlockers(result.funnel);
    const p = preset();
    const f = filters();
    const nearOff = p.id === "arb" && f.nearMiss === false;
    // At the tab's defaults with no single filter to blame, the market is the cause: say so, offer no reset.
    const atDefaults = p.filters.every((id) => JSON.stringify(f[id] ?? null) === JSON.stringify(S.filterDefault(p, id) ?? null));
    const quiet = !blockers.length && atDefaults;
    const next = autoOn && cfg.auto && sweepEndedAt ? ` · next scan ${S.istHm(sweepEndedAt + cfg.auto * 1000)}` : "";
    const sig = JSON.stringify([p.id, blockers.map((b) => [b.filter, b.label, b.without]), scan?.strikes, scan?.chains, nearOff, atDefaults, next]);
    if (sig === emptySig) return;
    emptySig = sig;
    const title = !quiet ? "No contracts pass these filters" : p.id === "arb" ? "No arbitrage right now" : p.id === "ivout" ? "No IV outliers right now" : "Nothing matches right now";
    const first =
      p.id === "arb"
        ? `${formatInt(0)} of ${formatInt(scan?.strikes ?? 0)} strikes clear costs in ${formatInt(scan?.chains ?? 0)} chains${next}`
        : quiet
          ? `${p.description}${next ? ` Scanned ${formatInt(scan?.chains ?? 0)} chains${next}.` : ""}`
          : p.description;
    const why = blockers.length ? "Switching off one filter brings rows back:" : quiet ? (p.id === "arb" ? "Edges this small rarely survive charges; the scan keeps looking." : "These are the tab's default filters; the scan keeps looking.") : "No single filter is the cause: reset to this tab's defaults.";
    const btns = [
      nearOff ? h("button", { type: "button", class: "small", "data-fk": "near", onclick: () => setFilter("nearMiss", true) }, "Show near misses") : null,
      ...blockers.map((b) => h("button", { type: "button", class: "small", "data-fk": `off:${b.filter}`, onclick: () => setFilter(b.filter, offValue(b.filter)) }, `Turn off ${S.FILTERS[b.filter].short ?? S.FILTERS[b.filter].label} (+${formatInt(b.without)})`)),
      atDefaults ? null : h("button", { type: "button", class: "small", "data-fk": "reset", onclick: () => resetFilters() }, "Reset all"),
    ].filter(Boolean);
    swapKeepFocus(
      emptyEl,
      [
        h("strong", {}, title),
        h("p", { class: "scr-empty-note" }, first),
        h("p", { class: "scr-empty-why" }, why),
        btns.length ? h("div", { class: "scr-empty-btns" }, btns) : null,
      ],
      filtersBtn,
    );
  }
  let bannerSig = "";
  function drawBanners() {
    const p = preset();
    const out = [];
    const sig = [];
    if (lastSweepFailed && !scan?.chains) {
      out.push(
        h(
          "div",
          { class: "scr-alert" },
          alertBox(firstError ?? { title: "Couldn't scan any chain", detail: "Check that an account can serve option chains." }),
          h("div", { class: "scr-alert-btns" }, h("button", { type: "button", class: "small", "data-fk": "retry", onclick: () => startSweep(true) }, icon("refresh"), "Retry"), h("a", { href: "#/accounts", class: "scr-link", "data-fk": "accounts" }, "Accounts")),
        ),
      );
      sig.push(`alert|${firstError?.message ?? firstError?.title ?? ""}`);
    }
    const text = (cls, t) => {
      out.push(h("p", { class: `scr-banner ${cls}` }, cls === "warn" ? icon("warn") : null, h("span", {}, t)));
      sig.push(t);
    };
    if (p.id === "buildup" && scan?.oiMissing?.length) {
      // One line, however many chains lack it.
      const names = scan.oiMissing.map((k) => k.split("|")).sort();
      const chainList = names.map(([u, e], i) => (i && names[i - 1][0] === u ? S.expiryText(e) : S.chainName(u, e))).join(", ");
      text("warn", scan.oiMissing.length === scan.chains ? "OI change unavailable from this broker for all scanned chains" : `OI change unavailable from this broker for ${chainList}`);
    }
    if (["overview", "sell", "buy"].includes(p.id) && plan && scan?.chains) {
      const hv = hvStore().values;
      const missing = [...plan.keys()].filter((u) => cfg.underlyings.includes(u) && !num(hv[u]?.hv20) && (hvFailed.has(u) || hv[u]));
      if (missing.length) text("info", `No daily history for ${missing.join(", ")}: IV/HV and IV − HV show --, verdicts use the other chains, scores renormalise.`);
    }
    const key = sig.join("\n");
    if (key === bannerSig) return;
    bannerSig = key;
    swapKeepFocus(banners, out, filtersBtn);
  }
  let issuesSig = "";
  function drawIssues() {
    const items = [...issues.values()];
    const sig = JSON.stringify(items.map((i) => [i.key, i.label, i.message]));
    if (sig === issuesSig) return;
    issuesSig = sig;
    issuesEl.hidden = !items.length;
    if (!items.length) return issuesEl.replaceChildren();
    const open = issuesEl.open;
    swapKeepFocus(
      issuesEl,
      [
        h("summary", { "data-fk": "summary" }, h("i", { class: "scr-wdot", "aria-hidden": "true" }), `${formatInt(items.length)} scan issue${items.length === 1 ? "" : "s"}`),
        h(
          "ul",
          {},
          items.map((i) => h("li", {}, h("span", {}, `${i.label}: ${i.message}`), h("button", { type: "button", class: "small plain", "data-fk": `retry:${i.key}`, onclick: () => (i.retry ? retryChain(i.retry) : startSweep(true)) }, "Retry"))),
        ),
      ],
      filtersBtn,
    );
    issuesEl.open = open;
  }
  async function retryChain({ u, e }) {
    cache.delete(`${u}|${e}`);
    startSweep(false);
  }
  let costsLi = null;
  const costsText = () => {
    const c = pctNow();
    return `Costs (estimates, as of ${c.asOf ? dayText(c.asOf, { year: true }) : DASH}): STT ${formatFixed(c.sttSellPct, 2)}% on sell premium and on the intrinsic of exercised longs, exchange ${formatFixed(c.txnPct.NFO, 5)}% NSE / ${formatFixed(c.txnPct.BFO, 4)}% BSE, SEBI ₹${formatInt(c.sebiPerCrore)}/crore, stamp ${formatFixed(c.stampBuyPct, 3)}% on buys, GST ${formatInt(c.gstPct)}% on brokerage + exchange + SEBI. Brokerage ₹${formatInt(brokerage())} per order (${cfg.brokerage === null ? "reference default" : "your setting"}); check your broker's contract note.`;
  };
  function drawMethod() {
    if (methodEl.childElementCount) {
      const t = costsText();
      if (costsLi.textContent !== t) costsLi.textContent = t;
      return;
    }
    costsLi = h("li", {}, costsText());
    methodEl.append(
      h("summary", { id: "scr-how" }, "How it works"),
      h(
        "ul",
        { class: "scr-method-list" },
        h("li", {}, "Each underlying's nearest expiries plus the current monthly are fetched once per sweep, one call at a time within the broker's rate limit; tabs re-rank the same data without new calls."),
        h("li", {}, "Colour: violet = how much (the ranking: darker is better), red / green = signed money or direction, blue / orange = calls / puts, amber = a warning. Score colours are fixed bands (45 · 55 · 65 · 75); other rankings are relative to the rows shown."),
        h("li", {}, `Unusual means Vol/OI against the median of the same side of the same chain (Indian index options routinely trade 5–50× their OI), with floors on OI, volume, turnover and price; strikes under ${formatInt(O.VOL_OI_MIN_LOTS)} lots of OI get no ratio.`),
        h("li", {}, "Cheap or rich is judged against 20-day realised vol (HV20) from daily closes. IV rank and IV percentile are not shown: there is no IV history yet."),
        h("li", {}, "POP is a log-normal probability on the forward at the leg's IV; it is always shown with the maximum loss. ±1σ = F·(e^{σ√T} − e^{−σ√T})/2 at ATM IV; an ATM straddle ≈ 0.8 × 1σ."),
        costsLi,
        h("li", {}, "Arbitrage is checked at asks to buy and bids to sell over ATM ±20 strikes, net of the opening charges (a bought box adds settlement STT on its width). Near misses are the closest of each type per chain, within 0.5 pts gross and ₹500/lot net; expiry-day chains are left out by default. Costs are estimates and quotes move: re-check in the chain before trading."),
        h("li", {}, "Context, not advice. There is no order button here: open a contract in the Option Chain to trade it through the ticket and its safety checks."),
      ),
    );
  }

  // ── Selection and detail ──
  const recByKey = (key) => {
    if (!key || !scan) return null;
    return (result?.rows ?? []).find((r) => r.key === key) ?? S.recordsFor(scan, preset()).find((r) => r.key === key) ?? null;
  };
  let sheetOpen = null; // { key }
  /** An explicit pick (click, map dot, J / K, Enter) or a close: either way the detail stops following rank 1. */
  function select(key, { open = false, scroll = false } = {}) {
    selKey = key;
    autoSel = false;
    // A map dot ranked past the rows shown: show enough rows for it to exist, so it can be scrolled to and focused.
    const rk = key === null ? null : result?.rankOf?.get(key);
    if (rk && rk > shown) shown = rk;
    draw();
    if (scroll) {
      const el = phone() ? cardEls.get(key)?.btn : rowEls.get(key);
      el?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "instant" : "smooth" });
      el?.focus({ preventScroll: true });
    }
    if (open && !wide()) openSheet();
  }
  function moveSel(d) {
    const rows = entries.map((e) => e.r);
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.key === selKey);
    const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d));
    select(rows[j].key, { scroll: true });
  }
  let paneSig = "";
  function drawPane() {
    if (!wide()) return;
    const r = recByKey(selKey);
    const rk = r ? result?.rankOf?.get(r.key) ?? null : null;
    const sig = r ? `${cfg.preset}|${r.key}|${r.fetchedAt}|${brokerage()}|${cfg.wingStrikes}|${isPinned(r.key)}|${r.stale}|${rk}|${result?.total}` : `none|${cfg.preset}`;
    if (sig === paneSig) return;
    paneSig = sig;
    if (!r) {
      paneBody.replaceChildren(h("div", { class: "scr-pane-empty" }, h("p", { class: "scr-pane-hint" }, "Select a row to see its score, risk, every number and the actions."), chartSlotBox(null)));  // h() drops a null slot
      return;
    }
    const keepScroll = paneBody.scrollTop;
    const sameKey = paneBody.__key === r.key;
    paneBody.__key = r.key;
    // A refresh of the same row keeps what the visitor had: the focused button and any open disclosure.
    const opened = sameKey ? [...paneBody.querySelectorAll("details")].map((d) => d.open) : [];
    const view = detailView(r, { pane: true });
    focusKeys(view);
    view.querySelectorAll("details").forEach((d, i) => opened[i] && (d.open = true));
    swapKeepFocus(paneBody, [view]);
    paneBody.scrollTop = sameKey ? keepScroll : 0;
  }
  /** Stable data-fk keys on a detail's controls, so a rebuild can put focus back on the same one. */
  function focusKeys(root) {
    for (const el of root.querySelectorAll("button, summary, a[href]")) {
      if (el.hasAttribute("data-fk")) continue;
      el.setAttribute("data-fk", el.classList.contains("scr-pin") ? "pin" : el.tagName === "SUMMARY" ? `sum|${el.firstElementChild?.textContent ?? ""}` : `${el.className}|${el.getAttribute("aria-label") ?? el.textContent}`);
    }
  }
  function openSheet() {
    const r = recByKey(selKey);
    if (!r) return;
    const d = document.getElementById("dialog");
    const opener = (phone() ? cardEls.get(r.key)?.btn : rowEls.get(r.key)) ?? null;
    sheetOpen = { key: r.key };
    const view = detailView(r, { pane: false });
    modal({ title: titleOf(r), body: view, buttons: [] }).then(() => {
      d.classList.remove("scr-sheet");
      sheetOpen = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
    d.classList.add("scr-sheet");
    // Pin and close as one group at the end of the sheet's title row.
    const pin = view.querySelector(".scr-d-head > .scr-pin");
    const closeBtn = d.querySelector(".sheet-head > .sheet-close");
    if (pin && closeBtn) {
      const group = h("div", { class: "scr-d-btns" });
      closeBtn.replaceWith(group);
      group.append(pin, closeBtn);
    }
  }
  const titleOf = (r) => (r.kind === "arb" ? `${r.type} · ${r.chain}` : r.name);
  // Price and IV of the selected row's underlying (chart-lite.js; chart-specs.js screenerSpec): daily candles and the
  // vol store's 30-day ATM IV, read once per underlying for 5 minutes however often the detail repaints.
  const chartData = new Map();
  const chartSpecFor = (u) => {
    const hit = chartData.get(u);
    if (hit && Date.now() - hit.at < 300_000) return hit.p;
    const p = Promise.all([
      api(`/v1/history?symbol=${encodeURIComponent(spotSymbol(u))}&interval=1d&countback=120`),
      optional(api(`/v1/vol/history?underlying=${encodeURIComponent(u)}&basis=cm30&series=iv&limit=500`)),
    ]).then(([px, iv]) => screenerSpec({ underlying: u, candles: candlesOf(px.data?.data), ivHistory: iv.error ? null : iv.data?.data }));
    p.catch(() => chartData.delete(u));
    chartData.set(u, { at: Date.now(), p });
    return p;
  };
  const chartSlotBox = (r) => {
    if (!r?.underlying) return null;
    const box = chartSlot("Price and IV history", { id: "screener", expand: true, studies: { symbol: () => spotSymbol(r.underlying) }, load: () => chartSpecFor(r.underlying) });
    box?.classList.add("scr-slot");
    return box;
  };

  /** The detail (§6.10): header, score ring, chart slot, risk payoff, risk per lot, warnings, metrics, costs, actions. */
  function detailView(r, { pane }) {
    const p = preset();
    const parts = [];
    const age = Date.now() - (r.fetchedAt ?? Date.now());
    const entry = cache.get(`${r.underlying}|${r.expiry}`);
    const S0 = r.S ?? entry?.chain?.underlyingLtp ?? null;
    const stale = entry?.stale || age > staleAfter();
    const pinned = isPinned(r.key);
    const pinBtn = r.kind === "underlying" && p.kind !== "underlying" ? null : h("button", { type: "button", class: `icon-btn tiny scr-pin${pinned ? " on-pin" : ""}`, "aria-pressed": String(pinned), "aria-label": pinned ? "Unpin this row" : "Pin this row to the top of the tab", title: `${pinned ? "Unpin" : "Pin to the top of this tab"} (P)`, onclick: () => togglePin(r.key) }, h("span", { "aria-hidden": "true" }, pinned ? "★" : "☆"));
    const titleEl = h("h3", { class: "scr-d-title" }, ...(r.kind === "contract" ? [r.nameParts.head, " ", h("b", {}, r.nameParts.strike), " ", cap(r.right)] : r.kind === "hedge" ? [r.chain, " ", h("b", {}, formatInt(r.strike)), " ", cap("PE")] : [titleOf(r)]));
    const sub = [S0 !== null ? `Spot ${formatFixed(S0, 2)}` : null, num(r.F) !== null ? `F ${formatFixed(r.F, 2)}` : null, S.daysLabel(r.days), `lot ${formatInt(r.lot)}`].filter(Boolean).join(" · ");
    parts.push(
      h(
        "header",
        { class: "scr-d-head" },
        // The title row ends in one group (pin, close); the sub line has the full width below it. In a sheet the
        // sheet's own head holds the title and close, and openSheet() moves the pin next to close.
        pane ? h("div", { class: "scr-d-top" }, titleEl, h("div", { class: "scr-d-btns" }, pinBtn, h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", title: "Close", onclick: () => select(null) }, icon("close")))) : null,
        h("p", { class: "scr-d-sub" }, sub, stale ? h("span", { class: "ink-warn" }, ` · Data ${S.ageText(age)} old`) : null),
        pane ? null : pinBtn,
      ),
    );
    if (r.kind === "contract") {
      const sc = p.id === "buy" ? r.buy : p.id === "sell" ? r.sell : null;
      if (sc) parts.push(scoreBlock(sc, p.id === "buy" ? "Buy score" : "Sell score"));
      else parts.push(heroBlock(r, p));
    } else parts.push(heroBlock(r, p));
    // No engine, no slot box (and no empty wrapper either).
    const slotBox = chartSlotBox(r);
    if (slotBox) parts.push(h("div", { class: "scr-d-slot" }, slotBox));
    if (r.kind === "contract") {
      const side = p.id === "sell" ? "SELL" : "BUY";
      parts.push(riskChart(r, side, p.id === "sell" ? r.wing : null));
      parts.push(riskBox(r, p.id));
      parts.push(warnBlock(r, p.id, age, entry));
      parts.push(...metricGroups(contractGroups(r)));
      parts.push(costsBlock(r.costsRt, "Round-trip costs per lot at mid"));
    } else if (r.kind === "underlying") {
      parts.push(warnBlock(r, p.id, age, entry));
      parts.push(...metricGroups(overviewGroups(r)));
    } else if (r.kind === "hedge") {
      parts.push(warnBlock(r, p.id, age, entry));
      parts.push(...metricGroups([["Hedge", hedgeMetrics(r)]]));
    } else if (r.kind === "arb") {
      parts.push(section("Legs", r.legs.length ? h("div", { class: "scr-legs-t big" }, legTokens(r.legs)) : h("p", { class: "scr-d-note" }, r.legsText)));
      if (r.costs) {
        parts.push(section("Edge per lot", kvGrid([["Gross", `${formatSigned(r.gross, 2)} pts · ${formatRupee(r.grossLot, 0)}`, r.gross > 0 ? "pos" : r.gross < 0 ? "neg" : null], ["Costs", `${MINUS}${formatRupee(r.costsTotal, 0)}`, "label"], ["Net", `${r.net > 0 ? "+" : ""}${formatRupee(r.net, 0)}`, r.net > 0 ? "pos" : "neg"], ["Capital", r.capital === null ? "Margin depends on broker" : formatRupee(r.capital, 0)]])));
        parts.push(costsBlock(r.costs, "Opening charges, one lot of every leg"));
      }
      parts.push(h("p", { class: "scr-d-note" }, r.type === "Calendar" ? "Model-based: total implied variance falls between these expiries. There is no executable edge to net; check the term structure." : "Costs are estimates. Quotes move; re-check in the chain before trading."));
      parts.push(warnBlock(r, p.id, age, entry));
    }
    parts.push(actions(r, p.id));
    const body = h("div", { class: `scr-detail-body${pane ? "" : " in-sheet"}` }, parts.filter(Boolean));
    return body;
  }
  function warnBlock(r, pid, age, entry) {
    const warns = warnings(r, pid, age, entry);
    return warns.length ? section("Warnings", h("ul", { class: "scr-warns" }, warns.map((w) => h("li", {}, icon("warn"), h("span", {}, w))))) : null;
  }
  const section = (title, body, cls = "") => h("section", { class: `scr-d-sec ${cls}`.trim() }, h("h4", {}, title), body);
  const kvGrid = (rows, cls = "") => h("dl", { class: `scr-kv ${cls}`.trim() }, rows.filter(Boolean).map(([k, v, ink]) => h("div", {}, h("dt", {}, k), h("dd", { class: ink ? `ink-${ink}` : null }, v ?? DASH))));
  const metricGroups = (groups) => groups.map(([title, rows]) => section(title, kvGrid(rows, "two"), "scr-d-grp"));
  /** The score ring (56 px) and the parts, each bar as long as its weight and filled by its value (§6.10). */
  function scoreBlock(sc, title) {
    const C = 2 * Math.PI * 24;
    const st = S.scoreStep(sc.score);
    const arc = svgEl("circle", { class: "scr-ring-arc", cx: 28, cy: 28, r: 24, "stroke-dasharray": String(C), "stroke-dashoffset": String(C * (1 - lastRing / 100)), transform: "rotate(-90 28 28)", "data-seq-stroke": String(st) });
    const ring = svgEl("svg", { class: "scr-ring", viewBox: "0 0 56 56", width: 56, height: 56, "aria-hidden": "true" }, svgEl("circle", { class: "scr-ring-track", cx: 28, cy: 28, r: 24 }), arc);
    const target = C * (1 - Math.max(0, Math.min(100, sc.score ?? 0)) / 100);
    lastRing = sc.score ?? 0;
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute("stroke-dashoffset", String(target))));
    const maxW = Math.max(...sc.parts.map((p) => p.weight));
    const rows = sc.parts.map((pt) => {
      const track = h("span", { class: `scr-pt-t${pt.value === null ? " na" : ""}`, title: pt.value === null ? "No data: its weight is shared by the others" : `${pt.label}: ${formatFixed(pt.value, 2)} of 1` });
      track.style.setProperty("--w", String(Math.round((pt.weight / maxW) * 1000) / 1000));
      const fill = h("span", { class: "scr-pt-f" });
      fill.style.setProperty("--v", String(pt.value === null ? 0 : Math.round(pt.value * 1000) / 1000));
      track.append(fill);
      return h("li", {}, h("span", { class: "scr-pt-l" }, pt.label), h("span", { class: "scr-pt-box" }, track), h("span", { class: "scr-pt-w" }, pt.value === null ? "n/a · weight shared" : `${formatInt(pt.weight * 100)}%`));
    });
    return h(
      "section",
      { class: "scr-d-sec scr-score" },
      h("h4", {}, title),
      h(
        "div",
        { class: "scr-score-row" },
        h("div", { class: "scr-ring-box", role: "img", "aria-label": `${title} ${formatInt(sc.score)} of 100` }, ring, h("strong", { class: "scr-ring-n" }, formatInt(sc.score))),
        h("ul", { class: "scr-parts" }, rows),
      ),
      sc.penalties.length ? h("p", { class: "scr-score-pen" }, h("span", { "aria-hidden": "true" }, "⚠ "), `Halved: ${sc.penalties.join(", ").toLowerCase()}`) : null,
    );
  }
  /** Tabs without a score: the ranking metric as a 22 px hero, with its chip or heat. */
  function heroBlock(r, p) {
    const c = p.columns.find((x) => x.id === p.defaults.sort.by);
    if (!c) return null;
    const val = c.fmt(c.get(r), r) ?? DASH;
    const v = h("strong", { class: "scr-hero-v" }, val);
    const st = c.viz?.kind === "seq" ? (c.viz.scale === "score" ? S.scoreStep(c.get(r)) : heatOfSelected(c, r)) : null;
    if (st) v.dataset.seq = String(st);
    if (c.viz?.kind === "div" && num(c.get(r)) !== null) v.dataset.div = String(S.signedHeat([c.get(r), ...(result?.rows ?? []).map((x) => c.get(x))])[0] ?? 0);
    const extra = [];
    if (r.kind === "underlying") extra.push(chipEl(S.verdictChip(r.verdict)));
    if (r.kind === "arb") extra.push(chipEl(S.statusChip(r.status)));
    if (r.kind === "contract" && r.tag) extra.push(chipEl(S.buildupChip(r.tag)), r.reading ? h("span", { class: "scr-hero-r" }, r.reading.text) : null);
    const rank = result?.rankOf?.get(r.key);
    return h("section", { class: "scr-d-sec scr-hero" }, h("h4", {}, c.label), h("div", { class: "scr-hero-row" }, v, ...extra.filter(Boolean), rank ? h("span", { class: "scr-hero-rank" }, `Rank ${formatInt(rank)} of ${formatInt(result.total)}`) : null));
  }
  function heatOfSelected(c, r) {
    const rows = (result?.rows ?? []).slice(0, Math.max(shown, 50));
    const key = c.sortGet ?? c.get;
    const steps = S.rankHeat(rows.map((x) => key(x)), c.dir);
    const i = rows.findIndex((x) => x.key === r.key);
    return i < 0 ? null : steps[i] || null;
  }
  /** One lot's expiry payoff with the ±1σ band, spot, breakeven and (Sell) the wing overlay (§6.10 item 4). */
  function riskChart(r, side, wing) {
    const c = S.riskCurve(r, { side, wing });
    if (!c) return null;
    const W = 320;
    const H = 116;
    const pt = 18;
    const pb = 16;
    const all = [...c.ys, ...(c.wing ?? [])];
    let ymin = Math.min(0, ...all);
    let ymax = Math.max(0, ...all);
    // Keep the small side readable: the large side is cut at 3× it (the line runs off the edge, "unlimited" says so).
    const small = Math.min(Math.abs(ymin), Math.abs(ymax)) || Math.max(Math.abs(ymin), Math.abs(ymax)) / 3;
    // …but never above the wing's capped loss, so the defined-risk line shows where it flattens.
    const wingLo = c.wing?.length ? Math.min(...c.wing) : null;
    ymin = Math.max(ymin, wingLo === null ? -3 * small : Math.min(-3 * small, wingLo * 1.12));
    ymax = Math.min(ymax, 3 * small);
    const span = ymax - ymin || 1;
    ymin -= span * 0.08;
    ymax += span * 0.08;
    const X = (x) => ((x - c.lo) / (c.hi - c.lo)) * W;
    const Y = (y) => pt + (1 - (y - ymin) / (ymax - ymin)) * (H - pt - pb);
    const r1 = (v) => Math.round(v * 10) / 10;
    const path = (ys) => ys.map((y, i) => `${i ? "L" : "M"}${r1(X(c.xs[i]))},${r1(Y(y))}`).join("");
    const area = (sign) => {
      const ys = c.ys.map((y) => (sign > 0 ? Math.max(0, y) : Math.min(0, y)));
      return `${path(ys)}L${W},${r1(Y(0))}L0,${r1(Y(0))}Z`;
    };
    const svg = svgEl("svg", { class: "scr-risk-svg", viewBox: `0 0 ${W} ${H}`, role: "img" });
    const clipId = `scr-clip-${++riskSeq}`;
    svg.append(svgEl("defs", {}, svgEl("clipPath", { id: clipId }, svgEl("rect", { x: 0, y: pt, width: W, height: H - pt - pb }))));
    const plot = svgEl("g", { "clip-path": `url(#${clipId})` });
    const bx0 = X(c.band[0]);
    const bx1 = X(c.band[1]);
    svg.append(svgEl("rect", { class: "scr-risk-band", x: bx0, y: pt, width: Math.max(0, bx1 - bx0), height: H - pt - pb }));
    svg.append(svgEl("text", { class: "dv-tick", x: bx0 + 3, y: H - 4 }, "−1σ"), svgEl("text", { class: "dv-tick", x: bx1 - 3, y: H - 4, "text-anchor": "end" }, "+1σ"));
    const profit = svgEl("path", { class: "scr-risk-pos", d: area(1) });
    const loss = svgEl("path", { class: "scr-risk-neg", d: area(-1) });
    plot.append(profit, loss);
    svg.append(plot, svgEl("line", { class: "dv-zero", x1: 0, x2: W, y1: Y(0), y2: Y(0) }));
    let wingLine = null;
    if (c.wing) plot.append((wingLine = svgEl("path", { class: "dv-line dash scr-risk-wing", d: path(c.wing) })));
    const line = svgEl("path", { class: "dv-line scr-risk-line", d: path(c.ys) });
    plot.append(line);
    svg.append(plot);
    // Breakeven tick on the zero line.
    const bx = X(c.be);
    // Its label sits where the line is not: a call's line is on the far side of zero left of BE, a put's right of it;
    // a long's line is below zero there (label above), a short's above (label below). A card-coloured halo.
    const call = r.right === "CE";
    const above = side !== "SELL";
    const by = above ? Math.max(pt + 10, Y(0) - 7) : Math.min(H - pb - 3, Y(0) + 15);
    const beText = svgEl("text", { class: "dv-tick scr-risk-bet", x: call ? Math.max(52, bx - 7) : Math.min(W - 52, bx + 7), y: by, "text-anchor": call ? "end" : "start" }, `BE ${formatInt(c.be)}`);
    svg.append(svgEl("line", { class: "scr-risk-be", x1: bx, x2: bx, y1: Y(0) - 5, y2: Y(0) + 5 }));
    if (c.spot !== null && c.spot > c.lo && c.spot < c.hi) {
      const sx = X(c.spot);
      svg.append(svgEl("line", { class: "dv-spot-line", x1: sx, x2: sx, y1: pt, y2: H - pb }));
      spotPill(svg, sx, `Spot ${formatInt(c.spot)}`, { y: 0, width: W });
    }
    // The BE label over the spot line (its halo hides the line behind the text).
    svg.append(beText);
    // "Unlimited" in the corner the line leaves empty: a long call rises right (top-left is clear), a short call
    // falls right (bottom-left is clear).
    if (c.unlimited) svg.append(svgEl("text", { class: `scr-risk-unl ${c.unlimited}`, x: 3, y: c.unlimited === "loss" ? H - pb - 4 : pt + 11, "text-anchor": "start" }, `Unlimited ${c.unlimited} above →`));
    const mp = c.maxProfit === null ? "unlimited" : formatRupee(c.maxProfit, 0);
    const ml = c.maxLoss === null ? `unlimited ${r.right === "CE" ? "above" : "below"}` : formatRupee(c.maxLoss, 0);
    svg.setAttribute("aria-label", `${side === "SELL" ? "Short" : "Long"} one lot at expiry: max profit ${mp}, breakeven ${formatInt(c.be)}, max loss ${ml}`);
    if (!revealed.has(`${r.key}|${side}`)) {
      revealed.add(`${r.key}|${side}`);
      requestAnimationFrame(() => lineReveal([line, ...(wingLine ? [wingLine] : [])], [profit, loss]));
    }
    const legendItems = [h("li", {}, h("span", { class: "dv-key line", "data-dv": "spot" }), side === "SELL" ? "Short, one lot" : "Long, one lot")];
    if (c.wing) legendItems.push(h("li", {}, h("span", { class: "dv-key dash", "data-dv": "today" }), `With the ${formatInt(wing.wingStrike)} wing`));
    legendItems.push(h("li", {}, h("span", { class: "dv-key", "data-dv": "iv" }), "±1σ"));
    return section("At expiry", h("div", { class: "scr-risk" }, h("ul", { class: "dv-legend scr-risk-lg", "aria-hidden": "true" }, legendItems), svg), "scr-risk-sec");
  }
  let riskSeq = 0;
  /** Contract metrics in three groups (§6.10 item 7), values coloured by meaning. */
  function contractGroups(r) {
    const signed = (v) => (num(v) === null ? null : v > 0 ? "pos" : v < 0 ? "neg" : null);
    return [
      [
        "Price",
        [
          ["Bid", formatFixed(r.bid, 2)],
          ["Ask", formatFixed(r.ask, 2)],
          ["Mid", `${formatFixed(r.mid, 2)}${r.priceQ === "ltp" ? " (LTP)" : ""}`],
          ["Spread", formatPercent(r.spread, 1), r.spread > 3 ? "warn" : null],
          ["IV", `${formatFixed(r.iv, 1)}${r.ivFallback ? " (ATM)" : ""}`],
          ["IV − HV20", num(r.ivHv) === null ? DASH : `${formatSigned(r.ivHv, 1)} pts`, r.ivHv > 0 ? "iv" : null],
          ["vs ATM IV", num(r.vsAtm) === null ? DASH : `${formatSigned(r.vsAtm, 1)} pts`],
          ["Neighbours IV", formatFixed(r.nbrIv, 1)],
          ["Liquidity", num(r.liq) === null ? DASH : `${formatInt(r.liq)}/5`],
        ],
      ],
      [
        "Greeks",
        [
          ["Δ", formatFixed(r.delta, 2)],
          ["Γ", formatFixed(r.gamma, 4)],
          ["θ ₹/day", formatRupee(r.thetaLot, 0)],
          ["θ %/day", formatPercent(r.thetaPct, 1), r.thetaPct > 8 ? "warn" : null],
          ["Vega %", formatPercent(r.vegaPct, 1)],
          ["σ OTM", num(r.sigmaOtm) === null ? DASH : `${formatFixed(r.sigmaOtm, 2)}σ`, num(r.sigmaOtm) !== null && r.sigmaOtm < 1 ? "warn" : null],
          ["Breakeven", formatFixed(r.beLong, 0)],
          ["BE σ", num(r.beSigma) === null ? DASH : `${formatFixed(r.beSigma, 2)}σ`],
          ["Leverage", num(r.leverage) === null ? DASH : `${formatFixed(r.leverage, 1)}×`],
        ],
      ],
      [
        "Activity",
        [
          ["Volume", `${formatCompact(r.volume)} · ${formatCompact(r.volLots)} lots`],
          ["OI", `${formatCompact(r.oi)} · ${formatCompact(r.oiLots)} lots`],
          ["OI chg", `${formatCompact(r.oiChange, { signed: true })}${num(r.oiChgPct) !== null ? ` · ${formatSigned(r.oiChgPct, 1)}%` : ""}`, signed(r.oiChange)],
          ["Vol/OI", num(r.volOi) === null ? DASH : `${formatFixed(r.volOi, 2)}×`],
          ["× median", num(r.volOiRel) === null ? DASH : `${formatFixed(r.volOiRel, 2)}×`],
          ["Turnover", num(r.turnover) === null ? DASH : `₹${formatCompact(r.turnover)}`],
          ["Build-up", r.tag && S.buildupChip(r.tag) ? h("span", { class: "scr-kv-chip" }, chipEl(S.buildupChip(r.tag)), r.reading?.action ?? "") : DASH],
          ["Price chg", num(r.changePct) === null ? DASH : `${formatSigned(r.changePct, 1)}%`, signed(r.changePct)],
        ],
      ],
    ];
  }
  /** Risk per lot: profit green, loss red, "Unlimited" red and bold, POP as a bar (§6.10 item 5). */
  function riskBox(r, pid) {
    const lot = r.lot;
    const rows = [];
    const popRow = (label, v) => {
      if (num(v) === null) return [label, DASH];
      const bar = hbar({ value: v, max: 1, side: "pos" });
      return [label, h("span", { class: "scr-kv-pop" }, h("span", { class: "dv-track" }, bar), formatPercent(v * 100, 0))];
    };
    const unl = () => h("b", { class: "ink-neg" }, "Unlimited");
    const sell = pid === "sell";
    if (sell && r.sellPrice !== null) {
      rows.push(["Max profit", formatRupee(r.sellPrice * lot, 0), "pos"]);
      rows.push(["Max loss", r.right === "CE" ? unl() : formatRupee((r.strike - r.sellPrice) * lot, 0), "neg"]);
      rows.push(popRow("POP", r.popShort));
      if (r.wing) {
        rows.push([`Wing`, `${formatInt(r.wing.wingStrike)} ${r.right}`]);
        rows.push(["Credit · R:R", `${formatFixed(r.wing.credit, 2)} · 1:${formatFixed(r.wing.rr, 1)}`]);
        rows.push(["Max loss with wing", formatRupee(r.wing.maxLoss, 0), "neg"]);
      }
    } else if (r.buyPrice !== null) {
      rows.push(["Max loss", formatRupee(r.buyPrice * lot, 0), "neg"]);
      rows.push(["Max profit", r.right === "CE" ? h("b", { class: "ink-pos" }, "Unlimited") : formatRupee((r.strike - r.buyPrice) * lot, 0), "pos"]);
      rows.push(popRow("POP", r.popLong));
    }
    // The level the index has to reach: the short's strike, the long's breakeven (from spot, before expiry).
    const lvl = sell ? r.strike : r.beLong;
    const tp = sell ? r.touchK : r.touchBe;
    if (num(lvl) !== null) rows.push([`Chance to touch ${sell ? "strike" : "BE"} ${formatInt(lvl)}`, num(tp) === null ? DASH : formatPercent(tp * 100, 0)]);
    return section(sell ? "Risk per lot · short" : "Risk per lot · long", kvGrid(rows), "scr-risk-kv");
  }
  function costsBlock(c, title) {
    if (!c) return null;
    return h(
      "details",
      { class: "scr-d-costs" },
      h("summary", {}, h("span", {}, title), h("b", {}, formatRupee(c.total, 2))),
      kvGrid([
        ["Brokerage", formatRupee(c.brokerage, 2)],
        ["STT", formatRupee(c.stt, 2)],
        ["Exchange", formatRupee(c.txn, 2)],
        ["SEBI", formatRupee(c.sebi, 2)],
        ["Stamp", formatRupee(c.stamp, 2)],
        ["GST", formatRupee(c.gst, 2)],
      ], "two"),
    );
  }
  function overviewGroups(r) {
    const signed = (v) => (num(v) === null ? null : v > 0 ? "pos" : v < 0 ? "neg" : null);
    return [
      [
        "Vol",
        [
          ["ATM IV", formatFixed(r.atmIv, 1)],
          ["Since first scan", num(r.ivChg) === null ? DASH : `${formatSigned(r.ivChg, 1)} pts · ${S.istHm(r.baseAt)}`, signed(r.ivChg)],
          ["HV20", num(r.hv20) === null ? "No history" : formatFixed(r.hv20, 1)],
          ["IV/HV", num(r.ivHvRatio) === null ? DASH : `${formatFixed(r.ivHvRatio, 2)}×`, r.ivHvRatio >= 1.2 ? "iv" : null],
          ["Verdict", S.verdictChip(r.verdict) ? chipEl(S.verdictChip(r.verdict)) : DASH],
          ["Skew 25Δ", r.skewInfo ? `${formatSigned(r.skew, 1)} pts` : DASH, r.skew > 1 ? "put" : r.skew < -1 ? "call" : null],
          ["Term", num(r.term) === null ? DASH : `${formatSigned(r.term, 1)} pts${r.termInfo?.inverted ? " · inverted" : ""}`, r.termInfo?.inverted ? "warn" : null],
          ["Fwd vol", num(r.termInfo?.vol) === null ? DASH : formatFixed(r.termInfo.vol, 1)],
        ],
      ],
      [
        "Move",
        [
          ["Straddle", formatFixed(r.straddle, 2)],
          ["Per lot", formatRupee(r.straddleLot, 0)],
          ["Straddle %", formatPercent(r.straddlePct, 2)],
          ["±1σ move", `${formatFixed(r.em, 0)} · ${formatPercent(r.emPct, 2)}`],
          ["16Δ strikes", r.strangle.pe !== null && r.strangle.ce !== null ? `${formatInt(r.strangle.pe)} / ${formatInt(r.strangle.ce)}` : DASH],
          ["Basis", `${formatSigned(r.basis, 1)}${num(r.carry) !== null ? ` · ${formatFixed(r.carry, 1)}%/yr` : ""}`],
        ],
      ],
      [
        "OI",
        [
          ["PCR", formatFixed(r.pcr, 2)],
          ["ΔOI PCR", formatFixed(r.pcrChange, 2)],
          ["Max pain", `${formatInt(r.maxPain)} (${formatSigned(r.mpDiff, 0)})`],
          ["Put wall", formatInt(r.support), "put"],
          ["Call wall", formatInt(r.resistance), "call"],
          ["Build-up", r.oiMissing ? "OI change unavailable" : r.build?.text ?? DASH],
        ],
      ],
    ];
  }
  function hedgeMetrics(r) {
    return [
      ["Put", `${formatInt(r.strike)} PE @ ${formatFixed(r.ask, 2)}`, "put"],
      ["Depth below F", formatPercent(r.depth, 2)],
      ["Cost", formatPercent(r.costPct, 3)],
      ["Per lot", formatRupee(r.perLot, 0)],
      ["Per day", formatRupee(r.perDay, 0)],
      ["Annualised", formatPercent(r.annualised, 1)],
      ["Payout at −2σ", num(r.payout) === null ? DASH : `${formatFixed(r.payout, 1)}× premium`, r.payout >= 3 ? "pos" : null],
      ["Skew paid", num(r.skewPaid) === null ? DASH : `${formatSigned(r.skewPaid, 1)} pts`, r.skewPaid > 3 ? "warn" : null],
      ["Lots for notional", r.lots === null ? "Set a notional in Filters" : `${formatInt(r.lots)} · ${formatRupee(r.total, 0)}`],
      ["Liquidity", num(r.liq) === null ? DASH : `${formatInt(r.liq)}/5`],
    ];
  }
  function warnings(r, pid, age, entry) {
    const out = [];
    if (num(r.days) !== null && r.days < 1) out.push("Expiry day: gamma is extreme and short options carry an extra 2% ELM.");
    if (r.kind === "contract") {
      if (pid !== "sell" && r.days <= 1 && r.absDelta >= 0.5) {
        const intrinsic = Math.max(0, r.right === "CE" ? r.S - r.strike : r.strike - r.S);
        out.push(`Held to expiry in the money, STT is 0.15% of intrinsic (about ${formatRupee((intrinsic * r.lot * pctNow().sttExercisePct) / 100, 0)}/lot). Exit before ${refSession(ref).close} to avoid it.`);
      }
      if (r.spread > 5) out.push(`Wide spread: about ${formatRupee(((r.ask - r.bid) / 2) * r.lot, 0)}/lot to cross.`);
      if (r.priceQ === "ltp") out.push("One-sided quote; price is the last trade.");
      if (pid === "sell") {
        if (r.tag === "SC") out.push("Short covering on this strike: writers are exiting.");
        if (num(r.sigmaOtm) !== null && r.sigmaOtm < 1) out.push("Strike sits inside the 1σ expected move.");
        if (r.right === "PE" && num(r.support) !== null) out.push(r.strike < r.support ? `Beyond the put wall at ${formatInt(r.support)}.` : `Inside the put wall at ${formatInt(r.support)}.`);
        if (r.right === "CE" && num(r.resistance) !== null) out.push(r.strike > r.resistance ? `Beyond the call wall at ${formatInt(r.resistance)}.` : `Inside the call wall at ${formatInt(r.resistance)}.`);
      }
    }
    if (entry?.stale || age > staleAfter()) out.push(`Data is ${S.ageText(age)} old.`);
    return out;
  }
  /** Sticky actions: Open in Option Chain first; then the tab's side in its fill; the other side as a text button. */
  function actions(r, pid) {
    const chainBtn = (strike, side) => h("button", { type: "button", class: "primary full scr-a-chain", onclick: () => openInChain(r.underlying, r.expiry, strike, side) }, icon("chart"), "Open in Option Chain");
    const fill = (side, label, legs, name = null) => h("button", { type: "button", class: `btn full scr-a-side ${side === "SELL" ? "sell" : "buy"}`, onclick: () => toStrategy(r, legs, name) }, label);
    const text = (label, legs, name = null) => h("button", { type: "button", class: "plain small scr-a-alt", onclick: () => toStrategy(r, legs, name) }, label);
    const sec = (label, legs, name = null) => h("button", { type: "button", class: "full scr-a-sec", onclick: () => toStrategy(r, legs, name) }, label);
    let first = null;
    const grid = [];
    const alt = [];
    if (r.kind === "contract") {
      first = chainBtn(r.strike, r.side);
      const one = (side) => [{ right: r.right, strike: r.strike, side }];
      if (pid === "sell") {
        grid.push(fill("SELL", "Sell → Strategy", one("SELL")));
        if (r.wing) grid.push(sec(`Sell with ${formatInt(r.wing.wingStrike)} wing`, [{ right: r.right, strike: r.strike, side: "SELL" }, { right: r.right, strike: r.wing.wingStrike, side: "BUY" }]));
        alt.push(text("Add Buy instead", one("BUY")));
      } else {
        grid.push(fill("BUY", "Buy → Strategy", one("BUY")));
        alt.push(text("Add Sell instead", one("SELL")));
      }
    } else if (r.kind === "underlying") {
      first = chainBtn(r.atmStrike, "ce");
      const straddle = (side) => [{ right: "CE", strike: r.atmStrike, side }, { right: "PE", strike: r.atmStrike, side }];
      grid.push(fill("BUY", "Buy straddle", straddle("BUY"), "Straddle"), fill("SELL", "Sell straddle", straddle("SELL"), "Straddle"));
      if (r.strangle.ce !== null && r.strangle.pe !== null) {
        const str = (side) => [{ right: "PE", strike: r.strangle.pe, side }, { right: "CE", strike: r.strangle.ce, side }];
        alt.push(text("Buy 16Δ strangle", str("BUY"), "16Δ strangle"), text("Sell 16Δ strangle", str("SELL"), "16Δ strangle"));
      }
    } else if (r.kind === "hedge") {
      first = chainBtn(r.strike, "pe");
      grid.push(fill("BUY", "Buy put → Strategy", [{ right: "PE", strike: r.strike, side: "BUY" }]));
    } else if (r.kind === "arb") {
      if (r.strike !== null) first = chainBtn(r.strike, r.right === "PE" ? "pe" : "ce");
      if (r.legs.length) grid.push(sec("Add legs to Strategy", r.legs.map((l) => ({ right: l.right, strike: l.strike, side: l.side, lots: l.qty ?? 1 })), r.type));
    }
    return h("div", { class: "scr-d-actions" }, first, grid.length ? h("div", { class: `scr-a-grid n${grid.length}` }, grid) : null, alt.length ? h("div", { class: "scr-a-alts" }, alt) : null);
  }

  // ── Hand-off to the desk (mcb.dashboard.desk) ──
  const readDesk = () => read(DESK_SLOT) ?? {};
  function openInChain(underlying, expiry, strike, side) {
    write(DESK_SLOT, S.handoffPrefs(readDesk(), { underlying, expiry, focus: { strike, side } }));
    closeSheet();
    location.hash = "#/chain";
  }
  function toStrategy(r, legs, name = null) {
    const prefs = readDesk();
    const key = `${r.underlying}|${r.expiry}`;
    const before = Array.isArray(prefs.baskets?.[key]) ? prefs.baskets[key].length : 0;
    const next = S.handoffPrefs(prefs, { underlying: r.underlying, expiry: r.expiry, legs });
    const after = next.baskets[key].length;
    write(DESK_SLOT, next);
    const merged = legs.length - (after - before);
    if (after >= O.MAX_LEGS && merged > 0 && !legs.every((l) => (prefs.baskets?.[key] ?? []).some((x) => x.strike === l.strike && x.right === l.right && x.side === l.side))) toast(`The strategy holds up to ${O.MAX_LEGS} legs`);
    else toast(name ? `${legs[0].side === "BUY" ? "Buy" : "Sell"} ${name} added to Strategy Builder` : legs.length === 1 ? `${legs[0].side === "BUY" ? "Buy" : "Sell"} ${formatInt(legs[0].strike)} ${legs[0].right} added to Strategy Builder` : `${formatInt(legs.length)} legs added to Strategy Builder`);
    closeSheet();
    location.hash = "#/strategy";
  }
  function closeSheet() {
    if (sheetOpen) document.querySelector("#dialog .sheet-close")?.click();
  }

  // ── Filters sheet: a live "Show N", per-filter "removes N", a dot on changed values (§8.4) ──
  function openFilters(focusId = null) {
    const p = preset();
    const host = h("div", { class: "scr-filters" });
    let showBtn = null;
    let lastN = null;
    // Leave-one-out over the current tab: what each filter alone removes, and the count the Show button carries.
    const funnel = () => {
      const f = filters();
      const ctx = { expiries: scannedExpiries() };
      const loo = S.runPreset(presetRecords(p), p, f, cfg.sort[p.id], { ctx, leaveOneOut: true });
      const n = loo.total;
      return { f, ctx, n, removes: new Map(loo.funnel.filter((x) => x.without !== undefined).map((x) => [x.filter, Math.max(0, x.without - n)])) };
    };
    const showCount = (n) => {
      if (!showBtn) return;
      const text = n ? `Show ${formatInt(n)}` : "No matches";
      if (lastN === null || reducedMotion() || !n || lastN === n) showBtn.textContent = text;
      else countUp(showBtn, lastN, n, (v) => `Show ${formatInt(Math.round(v))}`, text);
      lastN = n;
    };
    // While a number is typed: patch the counts, the "removes N" notes and the changed dots in place (the field
    // keeps its caret); the full rebuild waits for the change event.
    const live = () => {
      if (!host.isConnected) return;
      const { f, n, removes } = funnel();
      for (const id of p.filters) {
        const row = host.querySelector(`[data-filter="${id}"]`);
        if (!row) continue;
        const name = row.querySelector(".scr-f-name");
        const changed = JSON.stringify(f[id] ?? null) !== JSON.stringify(S.filterDefault(p, id) ?? null);
        const dot = name?.querySelector(".scr-f-dot");
        if (changed && !dot) name?.prepend(h("i", { class: "scr-f-dot", title: "Changed from this tab's default", "aria-label": "changed" }));
        if (!changed && dot) dot.remove();
        const rm = removes.get(id) ?? 0;
        let small = row.querySelector(".scr-f-rm");
        if (rm > 0 && !small) row.querySelector(".scr-f-l")?.append((small = h("small", { class: "scr-f-rm" })));
        if (small) small.textContent = rm > 0 ? `removes ${formatInt(rm)}` : "";
      }
      showCount(n);
    };
    const build = () => {
      const { f, ctx, n, removes } = funnel();
      const rows = [...p.filters.map((id) => filterControl(id, f[id], render, ctx, removes.get(id) ?? 0, live)), ...(p.id === "hedge" ? [notionalControl(render)] : [])];
      // Keys for focus: "<filter>:<n>" on each control, so a rebuild puts focus back where it was.
      for (const row of rows) row.querySelectorAll("input, button, select").forEach((el, i) => el.setAttribute("data-fk", `${row.dataset.filter}:${i}`));
      swapKeepFocus(host, [h("p", { class: "scr-f-intro" }, `${p.label}: changes apply as you go.`), ...rows]);
      showCount(n);
    };
    // Rebuild after the event that changed a value has finished moving focus (Tab, Enter or a tap), then refocus.
    let queuedBuild = false;
    const render = () => {
      if (queuedBuild) return;
      queuedBuild = true;
      setTimeout(() => {
        queuedBuild = false;
        if (host.isConnected) build();
      }, 0);
    };
    modal({
      title: "Filters",
      body: host,
      buttons: [
        { label: "Reset", cls: "", onClick: () => (resetFilters(), render(), false) },
        { label: "Show", cls: "primary scr-show", value: true, ref: (b) => (showBtn = b) },
      ],
    }).then(() => filtersBtn.isConnected && filtersBtn.focus({ preventScroll: true }));
    build();
    // Focus a field only when a chip asked for it; otherwise Close, so no soft keyboard covers the sheet on touch.
    if (focusId) requestAnimationFrame(() => host.querySelector(`[data-filter="${focusId}"] :is(input, button, select)`)?.focus());
    else document.querySelector("#dialog .sheet-close")?.focus({ preventScroll: true });
  }
  function notionalControl(render) {
    const input = h("input", { type: "number", inputmode: "decimal", min: "0", step: "100000", value: cfg.hedgeNotional ?? "", placeholder: "None", "aria-label": "Notional to hedge (₹)" });
    input.addEventListener("change", () => {
      const v = num(input.value);
      setCfg({ hedgeNotional: v && v > 0 ? v : null });
      render();
    });
    return h("div", { class: "scr-f", "data-filter": "notional" }, h("span", { class: "scr-f-l" }, h("span", { class: "scr-f-name" }, "Notional to hedge (₹)"), h("small", {}, "Index notional only; scale by your portfolio beta")), input);
  }
  function filterControl(id, v, render, ctx, removes = 0, live = null) {
    const f = S.FILTERS[id];
    const p = preset();
    const changed = JSON.stringify(v) !== JSON.stringify(S.filterDefault(p, id));
    const apply = (nv) => {
      setFilter(id, nv);
      render();
    };
    const label = h(
      "span",
      { class: "scr-f-l" },
      h("span", { class: "scr-f-name" }, changed ? h("i", { class: "scr-f-dot", title: "Changed from this tab's default", "aria-label": "changed" }) : null, f.label),
      removes > 0 ? h("small", { class: "scr-f-rm" }, `removes ${formatInt(removes)}`) : null,
    );
    const numIn = (val, lbl, onSet, toValue) => {
      const input = h("input", { type: "number", inputmode: "decimal", step: String(f.step ?? 1), value: val ?? "", placeholder: "Any", "aria-label": lbl });
      // Live while typing (150 ms after the last key): the filter applies and the counts follow, no rebuild.
      let t = 0;
      input.addEventListener("input", () => {
        if (!live) return;
        clearTimeout(t);
        t = setTimeout(() => {
          const raw = input.value.trim();
          const x = raw === "" ? null : num(raw);
          if (raw !== "" && x === null) return;
          setFilter(id, toValue(x));
          live();
        }, 150);
      });
      input.addEventListener("change", () => {
        clearTimeout(t);
        if (input.value.trim() === "") return onSet(null);
        const x = num(input.value);
        if (x === null) {
          input.value = val ?? "";
          return;
        }
        onSet(x);
      });
      return input;
    };
    const unit = f.unit ? h("small", {}, f.unit.trim()) : null;
    let ctl;
    if (f.type === "min" || f.type === "max") ctl = h("span", { class: "scr-f-num" }, h("span", { class: "scr-f-op" }, f.type === "min" ? "≥" : "≤"), numIn(v, f.label, (x) => apply(x), (x) => x), unit);
    else if (f.type === "range") {
      const [lo, hi] = v ?? [null, null];
      // A crossing edit carries the other end with it (never a silent swap): from 0.95 with to 0.30 gives 0.95–0.95.
      const fromV = (x) => [x, x !== null && hi !== null && x > hi ? x : hi];
      const toV = (x) => [x !== null && lo !== null && x < lo ? x : lo, x];
      ctl = h("span", { class: "scr-f-num" }, numIn(lo, `${f.label} from`, (x) => apply(fromV(x)), fromV), h("span", { class: "scr-f-op" }, "to"), numIn(hi, `${f.label} to`, (x) => apply(toV(x)), toV), unit);
    } else if (f.type === "toggle") {
      const input = h("input", { type: "checkbox", checked: Boolean(v) });
      input.addEventListener("change", () => apply(input.checked));
      return h("label", { class: "sw-row scr-f", "data-filter": id }, h("span", { class: "sw-text" }, label), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    } else if (f.type === "seg") {
      const seg = segmented(f.label, f.options, v);
      seg.addEventListener("change", () => seg.value !== v && apply(seg.value));
      ctl = seg;
    } else {
      const opts = f.options ?? (ctx.expiries ?? []).map((e) => [e, S.expiryText(e)]);
      const all = opts.map((o) => o[0]);
      const cur = v ?? all;
      ctl = h(
        "span",
        { class: "scr-f-multi", role: "group", "aria-label": f.label },
        opts.map(([val, text]) => {
          const on = cur.includes(val);
          return h(
            "button",
            {
              type: "button",
              class: `scr-uchip${on ? " on" : ""}`,
              "aria-pressed": String(on),
              onclick: () => {
                const next = on ? cur.filter((x) => x !== val) : [...cur, val];
                if (!next.length) return;
                apply(next.length === all.length && !f.options ? null : next);
              },
            },
            text,
          );
        }),
      );
    }
    return h("div", { class: `scr-f${f.type === "multi" ? " multi" : ""}`, "data-filter": id }, label, ctl);
  }

  // ── Customise: columns per preset and scan settings ──
  let closePop = null;
  function customiseBody(render) {
    const p = preset();
    const order = cfg.cols[p.id];
    const setCols = (next) => {
      setCfg({ cols: { ...cfg.cols, [p.id]: next } });
      render();
    };
    const ids = order.map((x) => x.replace(/^-/, ""));
    const colRows = order.map((x, i) => {
      const id = x.replace(/^-/, "");
      const c = p.columns.find((y) => y.id === id);
      const on = !x.startsWith("-");
      const lead = id === "name";
      const box = h("input", { type: "checkbox", checked: on, disabled: lead, "aria-label": `Show ${c.label}` });
      box.addEventListener("change", () => setCols(order.map((y, j) => (j === i ? (box.checked ? id : `-${id}`) : y))));
      const move = (d) => {
        const j = i + d;
        if (j < 1 || j >= order.length) return;
        const next = [...order];
        [next[i], next[j]] = [next[j], next[i]];
        setCols(next);
        requestAnimationFrame(() => document.querySelector(`.scr-pop [data-col-move="${id}${d < 0 ? "up" : "down"}"]`)?.focus());
      };
      return h(
        "div",
        { class: `col-row${on ? " on" : ""}` },
        h("span", {}),
        h("label", { class: "col-check", title: c.title }, box, c.label, c.p === 3 ? h("small", { class: "scr-p3", title: "Hidden while the table is narrower than 1100 px (for example beside the detail column)" }, " · wide tables") : null),
        lead
          ? h("span", { class: "scr-fixed" }, "Fixed")
          : h(
              "span",
              { class: "col-move" },
              h("button", { type: "button", class: "icon-btn tiny", "data-col-move": `${id}up`, "aria-label": `Move ${c.label} up`, disabled: i <= 1, onclick: () => move(-1) }, icon("up")),
              h("button", { type: "button", class: "icon-btn tiny", "data-col-move": `${id}down`, "aria-label": `Move ${c.label} down`, disabled: i >= ids.length - 1, onclick: () => move(1) }, icon("down")),
            ),
      );
    });
    const seg = (label, opts, value, onSet) => {
      const s = segmented(label, opts, String(value));
      s.addEventListener("change", () => s.value !== String(value) && onSet(s.value));
      return h("div", { class: "scr-set" }, h("span", { class: "scr-set-l" }, label), s);
    };
    const numSet = (label, value, min, max, onSet, hint) => {
      const input = h("input", { type: "number", inputmode: "decimal", min: String(min), max: String(max), value: String(value), "aria-label": label });
      input.addEventListener("change", () => {
        const x = num(input.value);
        if (x === null) input.value = String(value);
        else onSet(x);
      });
      return h("div", { class: "scr-set" }, h("span", { class: "scr-set-l" }, label, hint ? h("small", {}, hint) : null), input);
    };
    const monthly = h("input", { type: "checkbox", checked: cfg.monthly });
    monthly.addEventListener("change", () => {
      setCfg({ monthly: monthly.checked }, { rescan: true });
      render();
    });
    return [
      h("section", {}, h("h3", {}, `${p.label} columns`), h("div", { class: "col-list" }, colRows), h("button", { type: "button", class: "small plain", onclick: () => setCols(p.columns.map((c) => c.id)) }, "Reset columns")),
      h(
        "section",
        {},
        h("h3", {}, "Scan"),
        seg("Expiries per underlying", [["1", "1"], ["2", "2"], ["3", "3"]], cfg.expiries, (v) => (setCfg({ expiries: Number(v) }, { rescan: true }), render())),
        h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, "Include the monthly", h("small", {}, "The current month's last expiry")), h("span", { class: "switch" }, monthly, h("i", { "aria-hidden": "true" }))),
        seg("Strikes each side", S.STRIKE_CHOICES.map((x) => [String(x), `±${x}`]), cfg.strikes, (v) => (setCfg({ strikes: Number(v) }, { rescan: true }), render())),
        seg("Auto rescan", S.AUTO_CHOICES.map((x) => [String(x), AUTO_LABEL[x]]), cfg.auto, (v) => {
          setAutoInterval(Number(v));
          render();
        }),
        seg("Rows shown", S.ROW_CHOICES.map((x) => [String(x), String(x)]), cfg.rows, (v) => {
          shown = Number(v);
          setCfg({ rows: Number(v) });
          render();
        }),
        numSet("Brokerage ₹ per order", brokerage(), 0, 100, (x) => (setCfg({ brokerage: x }), render()), cfg.brokerage === null ? "Reference default" : null),
        numSet("Wing width (strikes)", cfg.wingStrikes, 1, 10, (x) => (setCfg({ wingStrikes: x }), render()), "Sell rows' defined-risk alternative"),
      ),
    ];
  }
  function setAutoInterval(sec) {
    if (sec > 0) autoOn = true;
    setCfg({ auto: sec });
    startAuto();
    drawStatus();
  }
  function openCustomise() {
    if (closePop) return closePop();
    if (phone()) {
      const host = h("div", { class: "pop-body scr-pop scr-sheet-body" });
      // Phones show cards, so the scan settings come first and the table's columns after.
      const render = () => host.replaceChildren(...customiseBody(render).reverse());
      render();
      closePop = () => document.querySelector("#dialog .sheet-close")?.click();
      modal({ title: "Customise", body: host, buttons: [{ label: "Done", cls: "primary", value: true }] }).then(() => {
        closePop = null;
        gearBtn.focus({ preventScroll: true });
      });
      return;
    }
    const bodyEl = h("div", { class: "pop-body" });
    const render = () => {
      const top = bodyEl.scrollTop;
      bodyEl.replaceChildren(...customiseBody(render));
      bodyEl.scrollTop = top;
    };
    const close = (refocus = true) => {
      pop.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      closePop = null;
      gearBtn.setAttribute("aria-expanded", "false");
      if (refocus && gearBtn.isConnected) gearBtn.focus({ preventScroll: true });
    };
    const outside = (e) => !pop.contains(e.target) && !gearBtn.contains(e.target) && close(false);
    const esc = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    const pop = h(
      "div",
      { class: "popover customise scr-pop vol-pop-float", role: "dialog", "aria-label": "Customise the screener" },
      h("div", { class: "pop-head" }, h("strong", {}, "Customise"), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close"))),
      bodyEl,
    );
    function place() {
      if (!gearBtn.isConnected) return close(false);
      const b = gearBtn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const w = Math.min(380, vw - 32);
      pop.style.width = `${w}px`;
      pop.style.left = `${Math.round(Math.max(16, Math.min(b.right - w, vw - w - 16)))}px`;
      const below = vh - b.bottom - 22;
      const above = b.top - 22;
      if (below >= 360 || below >= above) {
        pop.style.top = `${Math.round(Math.max(16, b.bottom + 6))}px`;
        pop.style.bottom = "";
        pop.style.maxHeight = `${Math.round(Math.max(220, Math.min(720, below)))}px`;
      } else {
        pop.style.top = "";
        pop.style.bottom = `${Math.round(vh - b.top + 6)}px`;
        pop.style.maxHeight = `${Math.round(Math.min(720, above))}px`;
      }
    }
    closePop = () => close();
    render();
    gearBtn.setAttribute("aria-expanded", "true");
    document.body.append(pop);
    place();
    pop.querySelector("input, select, button")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
  }

  // ── Popovers: shortcuts, the live control, the underlyings, the phone sort sheet ──
  function openKeys() {
    if (phone()) return;
    const body = h("dl", { class: "scr-keys-list" }, KEY_HINTS.map(([keys, what]) => h("div", {}, h("dt", {}, keys.map((k) => h("kbd", {}, k))), h("dd", {}, what))));
    sheetPopover({ trigger: keysBtn, title: "Keyboard shortcuts", body, cls: "scr-keys-pop" });
  }
  let livePop = null;
  let liveBody = null;
  /**
   * The scan popover. Its controls (Auto rescan, Rescan now) are built once per opening, so focus and the segmented
   * thumb stay put while a sweep runs; only the status line and the chain dots are redrawn as chains land.
   */
  function drawLiveBody() {
    if (!liveBody?.isConnected) return;
    const STATE = { done: "Scanned", fetching: "Fetching now", pending: "Waiting", error: "Failed", stale: "Stale" };
    if (!liveBody.__parts) {
      const now = h("p", { class: "scr-live-now" });
      const gridHost = h("div", { class: "scr-cg-host" });
      const seg = segmented("Auto rescan", S.AUTO_CHOICES.map((x) => [String(x), AUTO_LABEL[x]]), String(autoOn ? cfg.auto : 0));
      seg.addEventListener("change", () => {
        if (!liveBody?.__syncing) setAutoInterval(Number(seg.value));
      });
      liveBody.replaceChildren(
        now,
        gridHost,
        h(
          "ul",
          { class: "dv-legend scr-cg-lg", "aria-hidden": "true" },
          ["done", "fetching", "pending", "stale", "error"].map((st) => h("li", {}, h("span", { class: `scr-cg ${st}` }, h("i", {}, st === "error" ? "✕" : "")), STATE[st])),
          h("li", {}, h("sup", { class: "scr-mth" }, "M"), "Monthly expiry"),
        ),
        h("div", { class: "scr-live-row" }, h("span", {}, "Auto rescan"), seg),
        h("button", { type: "button", class: "primary small scr-live-rescan", "data-fk": "rescan", onclick: () => rescan() }, icon("refresh"), "Rescan now", h("kbd", {}, "R")),
      );
      liveBody.__parts = { now, gridHost, seg };
    }
    const { now, gridHost, seg } = liveBody.__parts;
    const groups = [...(plan ?? new Map())];
    const want = String(autoOn ? cfg.auto : 0);
    if (seg.value !== want) {
      liveBody.__syncing = true;
      seg.value = want;
      liveBody.__syncing = false;
    }
    const nowSig = `${liveEl.dataset.kind}|${liveText.data}`;
    if (now.__sig !== nowSig) {
      now.__sig = nowSig;
      now.className = `scr-live-now k-${liveEl.dataset.kind}`;
      now.replaceChildren(h("i", { class: "scr-ldot", "aria-hidden": "true" }), liveText.data);
    }
    const sig = JSON.stringify(groups.map(([u, l]) => [u, l.map((x) => [chainState(`${u}|${x.expiry}`), issues.get(`${u}|${x.expiry}`)?.message ?? ""])]));
    if (gridHost.__sig === sig) return;
    gridHost.__sig = sig;
    gridHost.replaceChildren(
      groups.length
        ? h(
            "div",
            { class: "scr-cgrid" },
            groups.map(([u, l]) =>
              h(
                "div",
                { class: "scr-cg-row" },
                h("span", { class: "scr-cg-u" }, u),
                h(
                  "span",
                  { class: "scr-cg-dots" },
                  l.map((x) => {
                    const st = chainState(`${u}|${x.expiry}`);
                    const iss = issues.get(`${u}|${x.expiry}`);
                    return h(
                      "span",
                      { class: `scr-cg ${st}`, title: `${S.chainName(u, x.expiry)}${x.monthly ? " (monthly)" : ""}: ${STATE[st]}${iss ? ` · ${iss.message}` : ""}` },
                      h("i", { "aria-hidden": "true" }, st === "error" ? "✕" : ""),
                      h("small", {}, S.expiryText(x.expiry), x.monthly ? h("sup", { class: "scr-mth", title: "Monthly expiry" }, "M") : null),
                      h("span", { class: "pal-sr-only" }, `${x.monthly ? "monthly, " : ""}${STATE[st]}`),
                    );
                  }),
                ),
              ),
            ),
          )
        : h("p", { class: "scr-cg-none" }, "Planning the scan…"),
    );
  }
  function openLive() {
    liveBody = h("div", { class: "scr-live-body" });
    livePop = sheetPopover({
      trigger: phone() ? liveDotBtn : liveTxtBtn,
      title: "Scan",
      body: liveBody,
      cls: "scr-live-pop",
      onClose: () => {
        livePop = null;
        liveBody = null;
      },
    });
    drawLiveBody();
  }
  function openUnderlyings() {
    const body = h("div", { class: "scr-u-pop" });
    const draw1 = () => {
      const btns = list.map((u) => {
        const b = uBtnFor(u);
        b.addEventListener("click", () => setTimeout(draw1, 0));
        paintUChip(b);
        return b;
      });
      body.replaceChildren(h("p", { class: "scr-f-intro" }, "Underlyings in the scan. Adding one fetches its chains; at least one stays."), h("div", { class: "scr-uchips" }, btns));
    };
    draw1();
    sheetPopover({ trigger: ctxBtn, title: "Underlyings", body, cls: "scr-u-popover" });
  }
  function openSort() {
    const p = preset();
    const s = cfg.sort[p.id];
    const close = () => handle?.close();
    const items = p.columns
      .filter((c) => c.sortable)
      .map((c) => {
        const on = s.by === c.id;
        const pick = (dir) => {
          setCfg({ sort: { ...cfg.sort, [p.id]: { by: c.id, dir } } });
          close();
        };
        return h(
          "div",
          { class: `scr-sort-row${on ? " on" : ""}` },
          h("button", { type: "button", role: "radio", "aria-checked": String(on), class: "scr-sort-pick", onclick: () => pick(on ? s.dir : c.dir) }, h("i", { class: "scr-radio", "aria-hidden": "true" }), c.label, c.id === p.defaults.sort.by ? h("small", {}, "ranking") : null),
          h("button", { type: "button", class: `scr-sort-dir${on ? " on" : ""}`, "aria-label": `${c.label}, ${on && s.dir === "asc" ? "descending" : "ascending"}`, onclick: () => pick(on ? (s.dir === "asc" ? "desc" : "asc") : c.dir === "asc" ? "desc" : "asc") }, on ? (s.dir === "asc" ? "↑" : "↓") : c.dir === "asc" ? "↑" : "↓"),
        );
      });
    const body = h("div", { class: "scr-sort-list" }, h("div", { role: "radiogroup", "aria-label": "Sort by" }, items), h("button", { type: "button", class: "small plain scr-sort-more", onclick: () => (close(), setTimeout(() => openCustomise(), 0)) }, icon("columns"), "Columns and scan settings"));
    const handle = sheetPopover({ trigger: sortChip, title: "Sort by", body, cls: "scr-sort-pop" });
  }

  // ── Draw ──
  function drawSort() {
    const p = preset();
    const s = cfg.sort[p.id];
    const c = p.columns.find((x) => x.id === s.by);
    const t = c?.label ?? s.by;
    const want = `${p.id}|${s.by}|${s.dir}`;
    if (sortChip.__sig === want) return;
    sortChip.__sig = want;
    sortChip.querySelector(".scr-sortchip-t").textContent = t;
    sortChip.querySelector(".scr-sortchip-d").textContent = s.dir === "asc" ? "↑" : "↓";
    sortChip.setAttribute("aria-label", `Sort: ${t}, ${s.dir === "asc" ? "ascending" : "descending"}`);
  }
  function draw() {
    drawQuick();
    if (destroyed) return;
    const t0 = performance.now();
    const p = preset();
    main.dataset.preset = p.id;
    drawTabs();
    drawStatus();
    drawChips();
    drawSort();
    const hasData = [...cache.keys()].some((k) => cfg.underlyings.includes(k.split("|")[0]) && cache.get(k)?.chain);
    recompute();
    drawBanners();
    drawIssues();
    drawMethod();
    const isPhone = phone();
    // The detail column (≥ 1280) follows rank 1 until the visitor picks a row or closes it (a tab switch resumes it).
    // A row picked by hand stays selected while it still exists in the scan, even if it drops out of the rows shown.
    if (wide() && autoSel) selKey = (entries.find((e) => !e.pinned && !e.gone) ?? entries[0])?.r.key ?? null;
    if (!hasData && (scanning || !lastSweepFailed)) {
      wrap.hidden = isPhone;
      cards.hidden = !isPhone;
      emptyEl.hidden = true;
      skeleton();
      footCount.textContent = "";
      countEl.hidden = true;
      countPhone.textContent = "";
      moreBtn.hidden = true;
    } else if (!hasData) {
      wrap.hidden = true;
      cards.hidden = true;
      emptyEl.hidden = true;
      footCount.textContent = "";
      countEl.hidden = true;
      moreBtn.hidden = true;
    } else if (!result.total && !entries.length) {
      wrap.hidden = true;
      cards.hidden = true;
      emptyEl.hidden = false;
      drawEmpty();
      countEl.hidden = false;
      drawCount(0);
      footCount.textContent = `0 of ${formatInt(S.recordsFor(scan, p).length)} · ${formatInt(scan.chains)} chains`;
      moreBtn.hidden = true;
    } else {
      emptyEl.hidden = true;
      wrap.hidden = isPhone;
      cards.hidden = !isPhone;
      if (isPhone) drawCards(entries);
      else {
        drawTable(entries);
        fitCols();
        wrapEdges();
      }
      countEl.hidden = false;
      drawCount(result.total);
      const showing = entries.filter((e) => !e.pinned).length;
      footCount.textContent = `Showing ${formatInt(showing)} of ${formatInt(result.total)} · ${formatInt(scan.chains)} chains`;
      const more = Math.min(cfg.rows, result.total - showing - entries.filter((e) => e.pinned && !e.gone).length);
      moreBtn.hidden = more <= 0;
      moreBtn.textContent = `Show ${formatInt(more)} more`;
      const canMore = !allOn() || cfg.expiries < 3;
      scanMoreBtn.hidden = more > 0 || result.total >= 20 || !canMore;
      scanMoreBtn.textContent = allOn() ? `Scan ${formatInt(Math.min(3, cfg.expiries + 1))} expiries each` : "Add underlyings to scan";
    }
    if (selKey && !recByKey(selKey)) selKey = null;
    refChipEl.update();
    drawLegend();
    drawMap();
    drawScatter();
    drawPane();
    try {
      if (local.get("mcb.debug")) window.__scrMs = Math.round((performance.now() - t0) * 10) / 10;
    } catch {
      /* debug only */
    }
  }

  // ── Keyboard ──
  function onKey(e) {
    const k = e.key;
    const i = S.PRESET_IDS.indexOf(cfg.preset);
    if (k === "[" || k === "]") return pickPreset(S.PRESET_IDS[(i + (k === "]" ? 1 : -1) + S.PRESET_IDS.length) % S.PRESET_IDS.length]), true;
    const inResults = main.contains(document.activeElement) && (wrap.contains(document.activeElement) || cards.contains(document.activeElement));
    if (k === "j" || k === "J" || (k === "ArrowDown" && inResults)) return moveSel(1), true;
    if (k === "k" || k === "K" || (k === "ArrowUp" && inResults)) return moveSel(-1), true;
    if (k === "Enter" && selKey) return wide() ? (paneBody.querySelector(".scr-d-actions button")?.focus(), true) : (openSheet(), true);
    const r = recByKey(selKey);
    if ((k === "c" || k === "C") && r) {
      const strike = r.kind === "underlying" ? r.atmStrike : r.strike;
      if (strike !== null && strike !== undefined) openInChain(r.underlying, r.expiry, strike, r.side ?? (r.right === "PE" ? "pe" : "ce"));
      return true;
    }
    if ((k === "b" || k === "B" || k === "s" || k === "S") && r && (r.kind === "contract" || r.kind === "hedge")) {
      toStrategy(r, [{ right: r.right, strike: r.strike, side: k.toLowerCase() === "b" ? "BUY" : "SELL" }]);
      return true;
    }
    if ((k === "p" || k === "P") && r) return togglePin(r.key), true;
    if (k === "r" || k === "R") return rescan(), true;
    if (k === "f" || k === "F") return openFilters(), true;
    if (k === "a" || k === "A") return toggleAuto(), true;
    if (k === "?") return openKeys(), true;
    if (k === "Escape") {
      if (closePop) return closePop(), true;
      if (selKey && wide()) return select(null), true;
    }
    return false;
  }

  // ── Life cycle ──
  const page = { root, onKey, cleanup: () => cleanup() };
  activePage = page;
  bindKeys();
  const mqs = [media(MQ_PHONE), media(MQ_WIDE)];
  const onDevice = () => {
    if (!root.isConnected) return cleanup();
    headSig = "";
    bodySig = "";
    cardSig = "";
    paneSig = "";
    mapSig = "";
    liveSig = "";
    draw();
  };
  for (const m of mqs) m.addEventListener("change", onDevice);
  const onRoute = () => setTimeout(() => !root.isConnected && cleanup(), 0);
  window.addEventListener("hashchange", onRoute);
  // Ages and "stale" move with the clock: a light status pass every 15 s (text only, no network).
  const clock = setInterval(() => {
    if (!root.isConnected) return cleanup();
    if (!scanning) drawStatus();
  }, 15_000);
  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    cancelSweep();
    closePop?.();
    livePop?.close?.();
    clearInterval(clock);
    refChipEl.destroy?.();
    tabRo?.disconnect();
    for (const m of mqs) m.removeEventListener("change", onDevice);
    window.removeEventListener("hashchange", onRoute);
    if (activePage === page) activePage = null;
  }
  // Start once the router has put the panels on the page.
  setTimeout(() => {
    if (!root.isConnected) return cleanup();
    draw();
    centreTab(false);
    startSweep(false);
    startAuto();
  }, 0);
  draw();
  // Read the reference bundles at once (charges, rate, session close and the chip), not only when a sweep starts.
  loadRefs();
  // Below 1024 px the page folds its toolbar like the other desk pages (ui-pass-3.md §6): ⋯ holds readiness, Rescan,
  // Search and Appearance; tablets keep a small Demo pill, phones fold the Demo word into ⋯ (an amber dot on it).
  let ctxSheet = null;
  const ctxMoreBtn = h("button", { type: "button", class: "icon-btn ctx-more", "aria-haspopup": "dialog", "aria-label": `More: trading readiness, rescan, search, theme${app.state.demo ? ", demo data" : ""}` }, icon("more"), h("span", { class: "rd-more-dot", "aria-hidden": "true" }), app.state.demo ? h("span", { class: "demo-badge", "aria-hidden": "true" }) : null);
  ctxMoreBtn.addEventListener("click", () => {
    if (ctxSheet) return ctxSheet.close();
    const theme = document.documentElement.getAttribute("data-theme") ?? "auto";
    const close = () => ctxSheet?.close();
    const body = h(
      "div",
      { class: "ctx-sheet" },
      app.state.demo ? h("p", { class: "ctx-demo-note" }, h("span", { class: "pill demo" }, "Demo"), h("span", {}, DEMO_EXPLAINER)) : null,
      readinessSheetRow(close, ctxMoreBtn),
      h(
        "div",
        { class: "ctx-acts" },
        h("button", { type: "button", class: "small", onclick: () => (close(), rescan()) }, icon("refresh"), "Rescan"),
        h("button", { type: "button", class: "small", onclick: () => (close(), document.querySelector(".toolbar-search-m")?.click()) }, icon("search"), "Search"),
      ),
      h(
        "div",
        { class: "segmented", role: "group", "aria-label": "Appearance" },
        [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["auto", "Auto", "monitor"]].map(([v, label, ic]) => h("button", { type: "button", "data-theme-choice": v, "aria-pressed": String(theme === v) }, icon(ic), label)),
      ),
    );
    ctxSheet = sheetPopover({ trigger: ctxMoreBtn, title: "Option Screener", body, onClose: () => (ctxSheet = null) });
  });
  const demoPill = app.state.demo ? h("span", { class: "ctx-demo", "data-demo-indicator": "", title: DEMO_EXPLAINER }, "Demo") : null;
  mountToolbarCtx("screener", ctxBtn, refChipEl.el, h("span", { class: "ctx-spacer" }), demoPill, liveEl, ctxMoreBtn);
  return [refBannersEl.el, main, detail];
}
