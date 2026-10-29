// The Option Screener (#/screener, PRD 07): every underlying and expiry ranked at once. One sweep fetches each chain
// once (GET /v1/expiries, /v1/history daily candles for HV20, /v1/optionchain) through a strictly sequential queue
// that respects the broker's rate limits; every tab is then a filter + sort + column set over the same records, so
// switching tabs costs no network. The maths is options.js, the preset logic screens.js (both pure and tested);
// numbers are formatted by format.js only. There is no order button: trades go through the chain's ticket.
import { alertBox, api, app, chartSlot, h, icon, istTime, modal, mountToolbarCtx, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import { DEMO_UNDERLYINGS, UNDERLYINGS } from "./desk.js";
import * as O from "./options.js";
import * as S from "./screens.js";
import { every, segmented, stopTimer } from "./views.js";

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
 * A sweep over the universe: expiries for every underlying first (so the total is known), HV20 once a day per
 * underlying, then the chains (nearest expiries of every underlying first). Chains fresher than 0.9 × TTL are kept
 * unless `force`. Callbacks redraw progressively.
 */
async function runSweep({ cfg, force, onProgress, onChain, onIssue, onHv }) {
  const seq = ++sweepSeq;
  const list = cfg.underlyings;
  const plan = new Map();
  if (force) {
    skipped.clear();
    hvFailed.clear();
  }
  const now = () => Date.now();
  let calls = 0;
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
      plan.set(u, S.scanExpiries(ex, { n: cfg.expiries, monthly: cfg.monthly }).map((e) => ({ expiry: e, monthly: O.isMonthly(e, ex) })));
    }
    const order = S.scanOrder(new Map([...plan].map(([u, l]) => [u, l.map((x) => x.expiry)])));
    onProgress({ phase: "plan", plan, total: order.length, done: 0 });
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
    const ttl = (cfg.auto || 60) * 1000;
    let done = 0;
    for (const { underlying: u, expiry: e } of order) {
      const key = `${u}|${e}`;
      const have = cache.get(key);
      if (!force && have?.chain && !have.error && now() - have.fetchedAt < ttl * 0.9) {
        done += 1;
        onProgress({ phase: "chain", done, total: order.length, label: S.chainName(u, e) });
        continue;
      }
      onProgress({ phase: "chain", done, total: order.length, label: S.chainName(u, e), current: true });
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
      done += 1;
      if (seq !== sweepSeq) throw CANCELLED;
      onChain(key);
      onProgress({ phase: "chain", done, total: order.length, label: S.chainName(u, e) });
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

const KEY_HINTS = [[["[", "]"], "tabs"], [["J", "K"], "row"], [["↵"], "detail"], [["C"], "chain"], [["B", "S"], "strategy"], [["R"], "rescan"], [["F"], "filters"], [["A"], "auto"], [["Esc"], "close"]];

/** The Option Screener page: three movable panels (results, detail column, chart engine slot). */
export function renderScreenerPage() {
  // A reload of the same route (header Reload, palette, go() to this page) renders again without a hashchange:
  // retire the previous instance first so its listeners, timers and sweep do not outlive it.
  activePage?.cleanup?.();
  const list = app.state.demo ? DEMO_UNDERLYINGS : UNDERLYINGS;
  let cfg = S.screenerConfig(read(SLOT), { list, demo: Boolean(app.state.demo) });
  const saved = read(SLOT);
  let autoOn = saved?.autoOn !== false;
  const save = () => write(SLOT, { ...cfg, autoOn });
  const preset = () => S.presetById(cfg.preset);

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
  let shown = cfg.rows;
  let selKey = null;
  let destroyed = false;

  // ── Elements ──
  const tabs = h("div", { class: "scr-tabs", role: "tablist", "aria-label": "Screens" });
  const tabBtns = S.PRESETS.map((p) =>
    h("button", { type: "button", role: "tab", id: `scr-tab-${p.id}`, "aria-controls": "scr-results", class: "scr-tab", "data-id": p.id, title: p.description }, h("span", { class: "scr-tab-long" }, p.label), h("span", { class: "scr-tab-short" }, p.short)),
  );
  tabs.append(...tabBtns);
  const status = h("span", { class: "desk-clock scr-status" });
  const ctxMain = h("span", { class: "ctx-main" });
  const live = h("span", { class: "pal-sr-only", "aria-live": "polite", role: "status" });
  const rescanBtn = h("button", { type: "button", class: "small scr-btn", title: "Rescan every chain now (R)", "aria-label": "Rescan" }, icon("refresh"), h("span", { class: "scr-lbl" }, "Rescan"));
  const autoBtn = h("button", { type: "button", class: "small live-toggle scr-auto" });
  const filtersBtn = h("button", { type: "button", class: "small scr-btn", "aria-haspopup": "dialog", title: "Filters (F)", "aria-label": "Filters" }, icon("sliders"), h("span", { class: "scr-lbl" }, "Filters"), h("span", { class: "scr-badge", hidden: true }));
  const gearBtn = h("button", { type: "button", class: "small gear-btn scr-gear", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Columns and scan settings", "aria-label": "Customise" }, icon("columns"), h("span", { class: "gear-label scr-lbl" }, "Customise"));
  const sortSel = h("select", { class: "scr-sort", "aria-label": "Sort by" });
  const progressEl = h("div", { class: "scr-progress", role: "progressbar", "aria-label": "Scan progress", "aria-valuemin": "0", hidden: true }, h("span", {}));
  const uChips = h("div", { class: "scr-uchips", role: "group", "aria-label": "Underlyings" });
  const fChips = h("div", { class: "scr-fchips" });
  const desc = h("p", { class: "scr-desc" });
  const banners = h("div", { class: "scr-banners" });
  const caption = h("caption", { class: "pal-sr-only" });
  const thead = h("thead");
  const tbody = h("tbody");
  const table = h("table", { class: "scr-table" }, caption, thead, tbody);
  const wrap = h("div", { class: "scr-wrap", id: "scr-results", role: "tabpanel" }, table);
  const cards = h("ul", { class: "scr-cards", "aria-label": "Results" });
  const emptyEl = h("div", { class: "scr-empty", hidden: true });
  const countEl = h("span", { class: "scr-count" });
  const moreBtn = h("button", { type: "button", class: "small plain scr-more", hidden: true });
  const issuesEl = h("details", { class: "scr-issues", hidden: true });
  const methodEl = h("details", { class: "scr-method" });
  const keysEl = h("div", { class: "desk-keys scr-keys" }, KEY_HINTS.map(([keys, short]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), short)));
  const foot = h("div", { class: "scr-foot" }, h("div", { class: "scr-foot-row" }, countEl, moreBtn), issuesEl, methodEl);

  const head = h(
    "div",
    { class: "scr-head" },
    h("div", { class: "scr-bar" }, h("div", { class: "scr-tabrow" }, tabs), h("div", { class: "scr-tools" }, status, rescanBtn, autoBtn, filtersBtn, sortSel, gearBtn)),
    progressEl,
  );
  const main = h(
    "section",
    { class: "desk-panel scr-main", "data-panel": "screener-main", "aria-label": "Option Screener" },
    head,
    h("div", { class: "scr-chips" }, uChips, fChips),
    desc,
    banners,
    wrap,
    cards,
    emptyEl,
    foot,
    keysEl,
    live,
  );
  const paneBody = h("div", { class: "scr-pane" });
  const detail = h("section", { class: "desk-panel scr-detail", "data-panel": "screener-detail", "aria-label": "Selected row" }, paneBody);
  const slotBox = chartSlot("Price and IV history");
  const slotText = slotBox.querySelector(".chart-slot-label");
  const chart = h("section", { class: "desk-panel scr-chart", "data-panel": "screener-chart", "aria-label": "Chart engine slot" }, slotBox);
  const root = main;

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
    const charges = { ...O.CHARGES, brokeragePerOrder: cfg.brokerage };
    const planned = plan ? new Set([...plan].flatMap(([u, l]) => l.map((x) => `${u}|${x.expiry}`))) : null;
    for (const [key, entry] of cache) {
      const [u, e] = key.split("|");
      if (!universe.has(u) || !entry.chain) continue;
      if (planned && !planned.has(key)) continue;
      const hv20 = hv[u]?.hv20 ?? null;
      const monthly = plan?.get(u)?.find((x) => x.expiry === e)?.monthly ?? O.isMonthly(e, expCache.get(u)?.list ?? []);
      const sig = `${entry.fetchedAt}|${hv20}|${cfg.brokerage}|${cfg.wingStrikes}|${cfg.hedgeNotional}|${monthly}`;
      let m = memo.get(key);
      if (!m || m.sig !== sig) {
        m = { sig, rec: S.chainRecords(entry.chain, { hv20, charges, wingStrikes: cfg.wingStrikes, fetchedAt: entry.fetchedAt, monthly, notional: cfg.hedgeNotional }) };
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
    const staleMs = cfg.auto ? cfg.auto * 2000 : 10 * 60_000;
    const mark = (r) => {
      const entry = cache.get(`${r.underlying}|${r.expiry}`);
      r.age = now - (r.fetchedAt ?? now);
      r.stale = Boolean(entry?.stale) || r.age > staleMs;
    };
    for (const r of scan.overview) mark(r);
    for (const r of scan.arbs) mark(r);
    return scan;
  }
  function recompute() {
    const s = records();
    const p = preset();
    const recs = S.recordsFor(s, p).filter((r) => cfg.underlyings.includes(r.underlying));
    const t0 = performance.now();
    result = S.runPreset(recs, p, filters(), cfg.sort[p.id], { ctx: { expiries: scannedExpiries() } });
    result.ms = performance.now() - t0;
    return result;
  }
  const scannedExpiries = () => [...new Set([...cache.keys()].filter((k) => cfg.underlyings.includes(k.split("|")[0])).map((k) => k.split("|")[1]))].sort();

  // ── Sweep driver ──
  function startSweep(force) {
    if (destroyed) return;
    scanning = true;
    lastSweepFailed = false;
    if (force) issues.clear();
    progress = { done: 0, total: plan ? [...plan.values()].reduce((a, l) => a + l.length, 0) : 0, label: "", phase: "start" };
    drawStatus();
    runSweep({
      cfg,
      force,
      onProgress: (p) => {
        if (destroyed) return;
        if (p.phase === "plan") plan = p.plan;
        progress = { ...progress, ...p };
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
        progress = null;
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
        draw();
        const n = result?.total ?? 0;
        live.textContent = lastSweepFailed ? "Scan failed" : `Scan complete: ${formatInt(ok.length)} chains, ${formatInt(n)} matches`;
      })
      .catch((err) => {
        if (destroyed) return;
        scanning = false;
        progress = null;
        firstError = err;
        lastSweepFailed = true;
        draw();
      });
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

  // ── Toolbar ──
  function drawTabs() {
    for (const b of tabBtns) {
      const on = b.dataset.id === cfg.preset;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    wrap.setAttribute("aria-labelledby", `scr-tab-${cfg.preset}`);
  }
  function pickPreset(id, focus = false) {
    if (!S.PRESET_IDS.includes(id)) return;
    shown = cfg.rows;
    setCfg({ preset: id });
    const b = tabBtns.find((x) => x.dataset.id === id);
    if (focus) b?.focus();
    b?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: media(MQ_REDUCED).matches ? "instant" : "smooth" });
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
  rescanBtn.addEventListener("click", () => {
    cancelSweep();
    startSweep(true);
  });
  autoBtn.addEventListener("click", () => toggleAuto());
  function toggleAuto() {
    if (!cfg.auto) return toast("Auto refresh is off: choose an interval in Customise");
    autoOn = !autoOn;
    save();
    drawAuto();
    startAuto();
  }
  function drawAuto() {
    const on = autoOn && cfg.auto > 0;
    autoBtn.setAttribute("aria-pressed", String(on));
    autoBtn.classList.toggle("on", on);
    autoBtn.replaceChildren(h("span", { class: "live-dot", "aria-hidden": "true" }), h("span", { class: "scr-lbl-auto" }, cfg.auto ? `Auto ${formatInt(cfg.auto / 60)}m` : "Auto off"));
    autoBtn.title = on ? `Rescanning every ${formatInt(cfg.auto / 60)} min (A to pause)` : cfg.auto ? "Paused (A to resume)" : "Auto refresh is off (Customise)";
    autoBtn.setAttribute("aria-label", on ? `Auto refresh every ${formatInt(cfg.auto / 60)} minutes: on` : "Auto refresh: off");
  }
  filtersBtn.addEventListener("click", () => openFilters());
  gearBtn.addEventListener("click", () => openCustomise());
  sortSel.addEventListener("change", () => {
    const [by, dir] = sortSel.value.split(":");
    setCfg({ sort: { ...cfg.sort, [cfg.preset]: { by, dir } } });
  });
  moreBtn.addEventListener("click", () => {
    shown += cfg.rows;
    draw();
  });

  function drawStatus() {
    const running = scanning && progress;
    const entries = [...(plan ?? new Map())].flatMap(([u, l]) => l.map((x) => cache.get(`${u}|${x.expiry}`))).filter((x) => x?.chain);
    const total = plan ? [...plan.values()].reduce((a, l) => a + l.length, 0) : 0;
    let text;
    let cls = "";
    if (running) {
      const label = progress.phase === "expiries" ? `expiries · ${progress.label}` : progress.phase === "history" ? `history · ${progress.label}` : progress.label;
      text = `Scanning ${formatInt(Math.min(progress.done + (progress.current ? 1 : 0), progress.total || 0))}/${formatInt(progress.total || 0)}${label ? ` · ${label}` : ""}`;
    } else if (lastSweepFailed) {
      text = "Not updating";
      cls = "bad";
    } else if (!plan) {
      text = "Starting the scan…";
    } else {
      const oldest = entries.reduce((a, x) => (a === null || x.fetchedAt < a.fetchedAt ? x : a), null);
      const staleMs = cfg.auto ? cfg.auto * 2000 : 10 * 60_000;
      const stale = entries.some((x) => x.stale || Date.now() - x.fetchedAt > staleMs);
      text = `${stale ? "Stale · " : ""}${formatInt(entries.length)}/${formatInt(total)} chains${oldest ? ` · ${istTime(oldest.asOf)}` : ""}`;
      if (stale) cls = "stale";
    }
    if (status.__t !== text) {
      status.__t = text;
      // " chains" and "Scanning" fold away on phones; the full text stays in the title.
      status.replaceChildren(...text.split(/( chains|Scanning )/).map((part) => (part === " chains" || part === "Scanning " ? h("span", { class: "scr-st-w" }, part) : part)));
    }
    // The top bar's summary (foundation §5.1): "3 underlyings · 7 chains".
    const n = cfg.underlyings.length;
    const ctxText = `${formatInt(n)} underlying${n === 1 ? "" : "s"}${plan ? ` · ${formatInt(total)} chain${total === 1 ? "" : "s"}` : ""}`;
    if (ctxMain.textContent !== ctxText) ctxMain.textContent = ctxText;
    status.classList.toggle("bad", cls === "bad");
    status.classList.toggle("stale", cls === "stale");
    status.title = `${text}. ${running ? "Chains are fetched one at a time within the broker's rate limits" : "Chains scanned · the oldest chain's time"}`;
    progressEl.hidden = !running;
    if (running) {
      const t = progress.total || 1;
      const d = Math.min(t, progress.done);
      progressEl.setAttribute("aria-valuemax", String(t));
      progressEl.setAttribute("aria-valuenow", String(d));
      progressEl.firstChild.style.width = `${Math.round((100 * d) / t)}%`;
    }
    rescanBtn.disabled = false;
  }

  // ── Chips ──
  // Underlying chips are built once and patched, so a focused chip keeps focus through every redraw.
  const uBtns = list.map((u) => {
    const b = h("button", { type: "button", class: "scr-uchip", "data-u": u }, u);
    b.addEventListener("click", () => {
      const on = cfg.underlyings.includes(u);
      if (on && cfg.underlyings.length === 1) {
        b.classList.remove("shake");
        requestAnimationFrame(() => b.classList.add("shake"));
        return;
      }
      shown = cfg.rows;
      setCfg({ underlyings: on ? cfg.underlyings.filter((x) => x !== u) : list.filter((x) => x === u || cfg.underlyings.includes(x)) }, { rescan: !on });
    });
    return b;
  });
  uChips.append(...uBtns);
  let fChipSig = "";
  function drawChips() {
    for (const b of uBtns) {
      const u = b.dataset.u;
      const on = cfg.underlyings.includes(u);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.title = on && cfg.underlyings.length === 1 ? "Keep at least one" : on ? `Leave ${u} out of the scan` : `Scan ${u}`;
    }
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

  // ── Results: table (≥ 720 px) or cards ──
  let tableSig = "";
  const rowEls = new Map();
  let cardSig = "";
  const cardEls = new Map();
  function columns() {
    return S.visibleColumns(preset(), cfg.cols[cfg.preset]);
  }
  function buildHead(cols) {
    const p = preset();
    const s = cfg.sort[p.id];
    thead.replaceChildren(
      h(
        "tr",
        {},
        cols.map((c) => {
          const sorted = s.by === c.id;
          const th = h("th", { scope: "col", class: [c.num ? "num" : "", c.lead ? "lead" : "", c.p === 3 ? "p3" : "", c.wrap ? "wrap" : ""].join(" ").trim() || null, title: c.title || null, "aria-sort": sorted ? (s.dir === "asc" ? "ascending" : "descending") : null });
          if (!c.sortable) th.append(c.label);
          else
            th.append(
              h(
                "button",
                { type: "button", class: "scr-sort-btn", "data-col": c.id },
                c.label,
                h("span", { class: "scr-sort-i", "aria-hidden": "true" }, sorted ? (s.dir === "asc" ? "▲" : "▼") : ""),
              ),
            );
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
  /** Heat: a neutral wash in 3 steps by rank among the shown rows (never good or bad by colour). */
  function heatOf(rows, c) {
    const key = c.sortGet ?? c.get;
    const vals = rows.map((r) => num(key(r))).filter((v) => v !== null).sort((a, b) => a - b);
    if (vals.length < 3) return () => 0;
    const q1 = vals[Math.floor(vals.length / 3)];
    const q2 = vals[Math.floor((2 * vals.length) / 3)];
    const asc = c.dir === "asc";
    return (r) => {
      const v = num(key(r));
      if (v === null) return 0;
      const step = v >= q2 ? 3 : v >= q1 ? 2 : 1;
      return asc ? 4 - step : step;
    };
  }
  function setText(el, text) {
    if (el.__t !== text) {
      el.__t = text;
      el.textContent = text;
    }
  }
  function fillCell(td, c, r, heat) {
    const v = c.get(r);
    setText(td.__v, c.fmt(v, r) ?? DASH);
    const sub = c.sub ? c.sub(r) : "";
    if (td.__s) {
      setText(td.__s, sub);
      td.__s.hidden = !sub;
    }
    const ink = c.ink ? c.ink(r) : null;
    const subInk = c.subInk ? c.subInk(r) : null;
    const cls = [c.num ? "num" : "", c.lead ? "lead" : "", c.p === 3 ? "p3" : "", c.wrap ? "wrap" : "", ink ? `ink-${ink}` : "", subInk ? `sub-${subInk}` : "", heat ? `heat-${heat}` : ""].join(" ").trim();
    if (td.__cls !== cls) {
      td.__cls = cls;
      td.className = cls;
    }
    const ttl = c.ttl ? c.ttl(r) : "";
    if ((td.title || "") !== ttl) td.title = ttl;
  }
  function makeCell(c) {
    const td = h(c.lead ? "th" : "td", c.lead ? { scope: "row" } : {});
    td.__v = h(c.lead ? "strong" : "span", { class: "v" });
    td.append(td.__v);
    if (c.sub) {
      td.__s = h("small", { class: "s" });
      td.append(td.__s);
    }
    return td;
  }
  function drawTable(rows) {
    const cols = columns();
    const p = preset();
    const sig = `${p.id}|${cols.map((c) => c.id).join(",")}|${JSON.stringify(cfg.sort[p.id])}`;
    if (sig !== tableSig) {
      tableSig = sig;
      buildHead(cols);
      tbody.replaceChildren();
      rowEls.clear();
    }
    caption.textContent = `${p.label}: ${formatInt(result?.total ?? 0)} matches`;
    const heats = new Map(cols.filter((c) => c.heat).map((c) => [c.id, heatOf(rows, c)]));
    const keep = new Set();
    let prev = null;
    const focusKey = selKey && rows.some((r) => r.key === selKey) ? selKey : rows[0]?.key;
    for (const r of rows) {
      keep.add(r.key);
      let tr = rowEls.get(r.key);
      if (!tr) {
        tr = h("tr", { "data-key": r.key });
        tr.__cells = cols.map((c) => makeCell(c));
        tr.append(...tr.__cells);
        rowEls.set(r.key, tr);
      }
      cols.forEach((c, i) => fillCell(tr.__cells[i], c, r, heats.get(c.id)?.(r) ?? 0));
      const sel = r.key === selKey;
      if (tr.__sel !== sel) {
        tr.__sel = sel;
        tr.setAttribute("aria-selected", String(sel));
        tr.classList.toggle("sel", sel);
      }
      tr.classList.toggle("stale", Boolean(r.stale));
      const tab = r.key === focusKey ? 0 : -1;
      if (tr.tabIndex !== tab) tr.tabIndex = tab;
      const label = `${r.name}. ${S.reason(r, p.id)}`;
      if (tr.getAttribute("aria-label") !== label) tr.setAttribute("aria-label", label);
      const want = prev ? prev.nextSibling : tbody.firstChild;
      if (want !== tr) tbody.insertBefore(tr, want);
      prev = tr;
    }
    for (const [k, tr] of rowEls) {
      if (keep.has(k)) continue;
      tr.remove();
      rowEls.delete(k);
    }
  }
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (tr) select(tr.dataset.key, { open: true });
  });
  tbody.addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(tr.dataset.key, { open: true, force: true });
    }
  });
  function cardFor(r, p) {
    let c = cardEls.get(r.key);
    if (!c) {
      const btn = h("button", { type: "button", class: "scr-card", "data-key": r.key });
      const name = h("strong", { class: "scr-card-name" });
      const badge = h("span", { class: "scr-card-badge" });
      const metrics = [0, 1, 2].map(() => {
        const l = h("span", { class: "scr-m-l" });
        const v = h("span", { class: "scr-m-v" });
        return { l, v, el: h("span", { class: "scr-m" }, l, v) };
      });
      const why = h("span", { class: "scr-reason" });
      btn.append(h("span", { class: "scr-card-1" }, name, badge), h("span", { class: "scr-metrics" }, metrics.map((m) => m.el)), why);
      c = { li: h("li", {}, btn), btn, name, badge, metrics, why };
      cardEls.set(r.key, c);
    }
    const col = (id) => p.columns.find((x) => x.id === id);
    const b = col(p.card.badge);
    setText(c.name, r.name);
    setText(c.badge, (b.cardFmt ?? b.fmt)(b.get(r), r));
    c.badge.className = `scr-card-badge${b.ink?.(r) ? ` ink-${b.ink(r)}` : ""}`;
    const parts = [r.name, `${b.label} ${(b.cardFmt ?? b.fmt)(b.get(r), r)}`];
    p.card.keys.forEach((id, i) => {
      const k = col(id);
      setText(c.metrics[i].l, k.label);
      const t = k.fmt(k.get(r), r);
      setText(c.metrics[i].v, t);
      c.metrics[i].v.className = `scr-m-v${k.ink?.(r) ? ` ink-${k.ink(r)}` : ""}`;
      parts.push(`${k.label} ${t}`);
    });
    const why = S.reason(r, p.id);
    setText(c.why, why);
    c.why.hidden = !why;
    if (why) parts.push(why);
    const label = parts.join(", ");
    if (c.btn.getAttribute("aria-label") !== label) c.btn.setAttribute("aria-label", label);
    const sel = r.key === selKey;
    c.btn.classList.toggle("sel", sel);
    c.btn.setAttribute("aria-current", sel ? "true" : "false");
    c.btn.classList.toggle("stale", Boolean(r.stale));
    return c;
  }
  function drawCards(rows) {
    const p = preset();
    if (cardSig !== p.id) {
      cardSig = p.id;
      cards.replaceChildren();
      cardEls.clear();
    }
    const keep = new Set();
    let prev = null;
    for (const r of rows) {
      keep.add(r.key);
      const c = cardFor(r, p);
      const want = prev ? prev.nextSibling : cards.firstChild;
      if (want !== c.li) cards.insertBefore(c.li, want);
      prev = c.li;
    }
    for (const [k, c] of cardEls) {
      if (keep.has(k)) continue;
      c.li.remove();
      cardEls.delete(k);
    }
  }
  cards.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (b) select(b.dataset.key, { open: true, force: true });
  });
  function skeleton() {
    if (phone()) {
      cardSig = "";
      cardEls.clear();
      cards.replaceChildren(...Array.from({ length: 4 }, () => h("li", { class: "scr-skel", "aria-hidden": "true" }, h("span", { class: "sh" }), h("span", { class: "sh short" }))));
    } else {
      tableSig = "";
      rowEls.clear();
      buildHead(columns());
      const n = columns().length;
      tbody.replaceChildren(...Array.from({ length: 6 }, () => h("tr", { class: "scr-skel", "aria-hidden": "true" }, Array.from({ length: n }, (_, i) => h("td", { class: i === 0 ? "lead" : null }, h("span", { class: "sh" }))))));
    }
  }

  // ── Empty, banners, footer ──
  let emptySig = "";
  function drawEmpty() {
    // Leave-one-out: name only the filters whose removal alone brings rows back, with how many.
    const blockers = S.topBlockers(result.funnel);
    const p = preset();
    const sig = JSON.stringify([p.id, blockers.map((b) => [b.filter, b.label, b.without]), scan?.strikes, scan?.chains]);
    if (sig === emptySig) return;
    emptySig = sig;
    const arbNote = p.id === "arb" ? h("p", { class: "scr-empty-note" }, `No executable edge after costs across ${formatInt(scan?.strikes ?? 0)} strikes in ${formatInt(scan?.chains ?? 0)} chains.`) : null;
    swapKeepFocus(
      emptyEl,
      [
        h("strong", {}, "No contracts pass these filters"),
        arbNote,
        h("p", { class: "scr-empty-why" }, blockers.length ? `Switching off one filter brings rows back: ${blockers.map((b) => `${b.label} (${formatInt(b.without)})`).join(" · ")}` : "No single filter is the cause: reset to this tab's defaults."),
        h(
          "div",
          { class: "scr-empty-btns" },
          blockers.map((b) => h("button", { type: "button", class: "small tinted", "data-fk": `off:${b.filter}`, onclick: () => setFilter(b.filter, offValue(b.filter)) }, `Turn off ${S.FILTERS[b.filter].short ?? S.FILTERS[b.filter].label}`)),
          h("button", { type: "button", class: "small", "data-fk": "reset", onclick: () => resetFilters() }, "Reset all"),
        ),
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
          alertBox(firstError ?? { title: "No chain could be scanned", detail: "Check that an account can serve option chains." }),
          h("div", { class: "scr-alert-btns" }, h("button", { type: "button", class: "small", "data-fk": "retry", onclick: () => startSweep(true) }, icon("refresh"), "Retry"), h("a", { href: "#/accounts", class: "scr-link", "data-fk": "accounts" }, "Accounts")),
        ),
      );
      sig.push(`alert|${firstError?.message ?? firstError?.title ?? ""}`);
    }
    const text = (cls, t) => {
      out.push(h("p", { class: `scr-banner ${cls}` }, t));
      sig.push(t);
    };
    if (p.id === "buildup" && scan?.oiMissing?.length) {
      // One line, however many chains lack it.
      const names = scan.oiMissing.map((k) => k.split("|")).sort();
      const list = names.map(([u, e], i) => (i && names[i - 1][0] === u ? S.expiryText(e) : S.chainName(u, e))).join(", ");
      text("warn", scan.oiMissing.length === scan.chains ? "OI change unavailable from this broker for all scanned chains" : `OI change unavailable from this broker for ${list}`);
    }
    if (p.id === "arb" && scan?.chains) text("info", "Costs are estimates (How it works). Quotes move; re-check in the chain before trading.");
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
    const list = [...issues.values()];
    const sig = JSON.stringify(list.map((i) => [i.key, i.label, i.message]));
    if (sig === issuesSig) return;
    issuesSig = sig;
    issuesEl.hidden = !list.length;
    if (!list.length) return issuesEl.replaceChildren();
    const open = issuesEl.open;
    swapKeepFocus(
      issuesEl,
      [
        h("summary", { "data-fk": "summary" }, `Scan issues (${formatInt(list.length)})`),
        h(
          "ul",
          {},
          list.map((i) =>
            h(
              "li",
              {},
              h("span", {}, `${i.label}: ${i.message}`),
              h("button", { type: "button", class: "small plain", "data-fk": `retry:${i.key}`, onclick: () => (i.retry ? retryChain(i.retry) : startSweep(true)) }, "Retry"),
            ),
          ),
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
    const c = O.CHARGES;
    return `Costs (estimates, as of ${c.asOf}): STT ${formatFixed(c.sttSellPct, 2)}% on sell premium and on the intrinsic of exercised longs, exchange ${formatFixed(c.txnPct.NFO, 5)}% NSE / ${formatFixed(c.txnPct.BFO, 4)}% BSE, SEBI ₹${formatInt(c.sebiPerCrore)}/crore, stamp ${formatFixed(c.stampBuyPct, 3)}% on buys, GST ${formatInt(c.gstPct)}% on brokerage + exchange + SEBI. Brokerage is your setting (₹${formatInt(cfg.brokerage)} per order); check your broker's contract note.`;
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
        h("li", {}, `Unusual means Vol/OI against the median of the same side of the same chain (Indian index options routinely trade 5–50× their OI), with floors on OI, volume, turnover and price; strikes under ${formatInt(O.VOL_OI_MIN_LOTS)} lots of OI get no ratio.`),
        h("li", {}, "Cheap or rich is judged against 20-day realised vol (HV20) from daily closes. IV rank and IV percentile are not shown: there is no IV history yet."),
        h("li", {}, "POP is a log-normal probability on the forward at the leg's IV; it is always shown with the maximum loss. ±1σ = F·(e^{σ√T} − e^{−σ√T})/2 at ATM IV; an ATM straddle ≈ 0.8 × 1σ."),
        costsLi,
        h("li", {}, "Arbitrage is checked at asks to buy and bids to sell over ATM ±20 strikes, net of the opening charges (a bought box adds settlement STT on its width). Near misses are the closest of each type per chain, within 0.5 pts gross and ₹500/lot net; expiry-day chains are left out by default. Quotes move; re-check in the chain before trading."),
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
  function select(key, { open = false, force = false, scroll = false } = {}) {
    selKey = key;
    draw();
    if (scroll) {
      const el = phone() ? cardEls.get(key)?.btn : rowEls.get(key);
      el?.scrollIntoView({ block: "nearest", behavior: media(MQ_REDUCED).matches ? "instant" : "smooth" });
      el?.focus({ preventScroll: true });
    }
    if (open && (!wide() || force) && !wide()) openSheet();
  }
  function moveSel(d) {
    const rows = result?.rows.slice(0, shown) ?? [];
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.key === selKey);
    const j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d));
    select(rows[j].key, { scroll: true });
  }
  let paneSig = "";
  function drawPane() {
    if (!wide()) return;
    const r = recByKey(selKey);
    const sig = r ? `${cfg.preset}|${r.key}|${r.fetchedAt}|${cfg.brokerage}|${cfg.wingStrikes}` : `none|${cfg.preset}`;
    if (sig === paneSig) return;
    paneSig = sig;
    // With nothing selected the column folds away (CSS) and the results take the full width.
    detail.classList.toggle("scr-detail-empty", !r);
    if (!r) {
      paneBody.replaceChildren(h("p", { class: "scr-pane-hint" }, "Select a row to see every number, the score breakdown and actions."));
      return;
    }
    const keepScroll = paneBody.scrollTop;
    paneBody.replaceChildren(detailView(r, { pane: true }));
    paneBody.scrollTop = keepScroll;
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
  }
  const titleOf = (r) => (r.kind === "arb" ? `${r.type} · ${r.chain}` : r.name);

  /** The detail: header, score bars, metrics, risk, costs, warnings, actions. */
  function detailView(r, { pane }) {
    const p = preset();
    const parts = [];
    const age = Date.now() - (r.fetchedAt ?? Date.now());
    const entry = cache.get(`${r.underlying}|${r.expiry}`);
    const S0 = r.S ?? entry?.chain?.underlyingLtp ?? null;
    parts.push(
      h(
        "header",
        { class: "scr-d-head" },
        pane ? h("div", { class: "scr-d-top" }, h("h3", { class: "scr-d-title" }, titleOf(r)), h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", title: "Close", onclick: () => select(null) }, icon("close"))) : null,
        h("p", { class: "scr-d-sub" }, `${r.underlying} spot ${formatFixed(S0, 2)} · F ${formatFixed(r.F, 2)} · ${S.daysLabel(r.days)} · lot ${formatInt(r.lot)} · as of ${istTime(entry?.asOf)}`),
      ),
    );
    if (r.kind === "contract") {
      const sc = p.id === "buy" ? r.buy : p.id === "sell" ? r.sell : null;
      if (sc) parts.push(scoreBlock(sc, p.id === "buy" ? "Buy score" : "Sell score"));
      parts.push(warnBlock(r, p.id, age, entry));
      parts.push(riskBox(r, p.id));
      parts.push(section("Metrics", kvGrid(contractMetrics(r))));
      parts.push(costsBlock(r.costsRt, "Round-trip costs per lot at mid"));
    } else if (r.kind === "underlying") {
      parts.push(section("Metrics", kvGrid(overviewMetrics(r))));
    } else if (r.kind === "hedge") {
      parts.push(section("Metrics", kvGrid(hedgeMetrics(r))));
    } else if (r.kind === "arb") {
      parts.push(section("Legs", r.legs.length ? h("ul", { class: "scr-legs" }, r.legs.map((l) => h("li", {}, `${l.side === "BUY" ? "Buy" : "Sell"} ${l.qty > 1 ? `${formatInt(l.qty)}× ` : ""}${formatInt(l.strike)} ${l.right} @ ${formatFixed(l.price, 2)}`))) : h("p", { class: "scr-d-note" }, r.legsText)));
      if (r.costs) {
        parts.push(section("Edge per lot", kvGrid([["Gross", `${formatSigned(r.gross, 2)} pts · ${formatRupee(r.grossLot, 0)}`], ["Costs", `-${formatRupee(r.costsTotal, 0)}`], ["Net", `${r.net > 0 ? "+" : ""}${formatRupee(r.net, 0)}`, r.net > 0 ? "pos" : "neg"], ["Capital", r.capital === null ? "Margin depends on broker" : formatRupee(r.capital, 0)], ["Status", r.status]])));
        parts.push(costsBlock(r.costs, "Opening charges, one lot of every leg"));
      }
      parts.push(h("p", { class: "scr-d-note" }, r.type === "Calendar" ? "Model-based: total implied variance falls between these expiries. There is no executable edge to net; check the term structure." : "Costs are estimates. Quotes move; re-check in the chain before trading."));
    }
    if (r.kind !== "contract") parts.push(warnBlock(r, p.id, age, entry));
    parts.push(actions(r, p.id));
    return h("div", { class: `scr-detail-body${pane ? "" : " in-sheet"}` }, parts.filter(Boolean));
  }
  function warnBlock(r, pid, age, entry) {
    const warns = warnings(r, pid, age, entry);
    return warns.length ? section("Warnings", h("ul", { class: "scr-warns" }, warns.map((w) => h("li", {}, icon("warn"), h("span", {}, w))))) : null;
  }
  const section = (title, body) => h("section", { class: "scr-d-sec" }, h("h4", {}, title), body);
  const kvGrid = (rows) => h("dl", { class: "scr-kv" }, rows.filter(Boolean).flatMap(([k, v, cls]) => [h("dt", {}, k), h("dd", { class: cls ? `ink-${cls}` : null }, v ?? DASH)]));
  function scoreBlock(sc, title) {
    return h(
      "section",
      { class: "scr-d-sec scr-score" },
      h("h4", {}, title),
      h("div", { class: "scr-score-row" }, h("strong", { class: "scr-score-n" }, formatInt(sc.score)), sc.penalties.length ? h("span", { class: "scr-score-pen" }, `× 0.5: ${sc.penalties.join(", ")}`) : null),
      h(
        "ul",
        { class: "scr-bars" },
        sc.parts.map((pt) => {
          const fill = h("span", {});
          fill.style.width = `${Math.round((pt.value ?? 0) * 100)}%`;
          return h("li", {}, h("span", { class: "scr-bar-l" }, pt.label), h("span", { class: "scr-bar-t", "aria-hidden": "true" }, fill), h("span", { class: "scr-bar-v" }, pt.value === null ? "n/a · weight redistributed" : `${formatFixed(pt.value, 2)} × ${formatInt(pt.weight * 100)}%`));
        }),
      ),
    );
  }
  function contractMetrics(r) {
    return [
      ["Bid / ask", `${formatFixed(r.bid, 2)} / ${formatFixed(r.ask, 2)}`],
      ["Mid", `${formatFixed(r.mid, 2)}${r.priceQ === "ltp" ? " (LTP)" : ""}`],
      ["Spread", formatPercent(r.spread, 1)],
      ["Liquidity", num(r.liq) === null ? DASH : `${formatInt(r.liq)}/5`],
      ["IV", `${formatFixed(r.iv, 1)}${r.ivFallback ? " (ATM IV used)" : ""}`],
      ["IV − HV20", num(r.ivHv) === null ? DASH : `${formatSigned(r.ivHv, 1)} pts`],
      ["vs ATM IV", num(r.vsAtm) === null ? DASH : `${formatSigned(r.vsAtm, 1)} pts`],
      ["Neighbours IV", formatFixed(r.nbrIv, 1)],
      ["Δ / Γ", `${formatFixed(r.delta, 2)} / ${formatFixed(r.gamma, 4)}`],
      ["θ ₹/day per lot", formatRupee(r.thetaLot, 0)],
      ["θ %/day", formatPercent(r.thetaPct, 1)],
      ["Vega %", formatPercent(r.vegaPct, 1)],
      ["σ OTM", num(r.sigmaOtm) === null ? DASH : `${formatFixed(r.sigmaOtm, 2)}σ`],
      ["Breakeven (long)", formatFixed(r.beLong, 2)],
      ["BE σ", num(r.beSigma) === null ? DASH : `${formatFixed(r.beSigma, 2)}σ`],
      ["Leverage", num(r.leverage) === null ? DASH : `${formatFixed(r.leverage, 1)}×`],
      ["Volume", `${formatCompact(r.volume)} · ${formatCompact(r.volLots)} lots`],
      ["OI", `${formatCompact(r.oi)} · ${formatCompact(r.oiLots)} lots`],
      ["OI change", `${formatCompact(r.oiChange, { signed: true })}${num(r.oiChgPct) !== null ? ` · ${formatSigned(r.oiChgPct, 1)}%` : ""}`],
      ["Vol/OI", num(r.volOi) === null ? DASH : `${formatFixed(r.volOi, 2)}× · ${num(r.volOiRel) === null ? DASH : formatFixed(r.volOiRel, 2)}× median`],
      ["Turnover", num(r.turnover) === null ? DASH : `₹${formatCompact(r.turnover)}`],
      ["Build-up", r.reading?.text ?? DASH],
      ["Price change", num(r.changePct) === null ? DASH : `${formatSigned(r.changePct, 1)}%`, r.changePct > 0 ? "pos" : r.changePct < 0 ? "neg" : null],
    ];
  }
  function riskBox(r, pid) {
    const lot = r.lot;
    const buy = pid !== "sell";
    const sell = pid !== "buy";
    const rows = [];
    if (buy && r.buyPrice !== null) {
      rows.push(["Buy: max loss / lot", formatRupee(r.buyPrice * lot, 0)]);
      rows.push(["Buy: max profit / lot", r.right === "CE" ? "Unlimited" : formatRupee((r.strike - r.buyPrice) * lot, 0)]);
      rows.push(["Buy: POP", num(r.popLong) === null ? DASH : formatPercent(r.popLong * 100, 0)]);
    }
    if (sell && r.sellPrice !== null) {
      rows.push(["Sell: max profit / lot", formatRupee(r.sellPrice * lot, 0)]);
      rows.push(["Sell: max loss / lot", r.right === "CE" ? "Unlimited" : formatRupee((r.strike - r.sellPrice) * lot, 0)]);
      rows.push(["Sell: POP", num(r.popShort) === null ? DASH : formatPercent(r.popShort * 100, 0)]);
      if (r.wing) rows.push([`With wing ${formatInt(r.wing.wingStrike)} ${r.right}`, `credit ${formatFixed(r.wing.credit, 2)} · max loss ${formatRupee(r.wing.maxLoss, 0)} · R:R 1:${formatFixed(r.wing.rr, 1)}`]);
    }
    rows.push(["Chance of touch", num(r.touch) === null ? DASH : formatPercent(r.touch * 100, 0)]);
    return h("section", { class: "scr-d-sec scr-risk" }, h("h4", {}, "Risk per lot"), kvGrid(rows));
  }
  function costsBlock(c, title) {
    if (!c) return null;
    return section(
      title,
      kvGrid([
        ["Brokerage", formatRupee(c.brokerage, 2)],
        ["STT", formatRupee(c.stt, 2)],
        ["Exchange", formatRupee(c.txn, 2)],
        ["SEBI", formatRupee(c.sebi, 2)],
        ["Stamp", formatRupee(c.stamp, 2)],
        ["GST", formatRupee(c.gst, 2)],
        ["Total", formatRupee(c.total, 2)],
      ]),
    );
  }
  function overviewMetrics(r) {
    return [
      ["ATM strike", formatInt(r.atmStrike)],
      ["ATM IV", formatFixed(r.atmIv, 1)],
      ["Since first scan", num(r.ivChg) === null ? DASH : `${formatSigned(r.ivChg, 1)} pts since ${S.istHm(r.baseAt)}`],
      ["HV20", num(r.hv20) === null ? "No daily history" : formatFixed(r.hv20, 1)],
      ["IV/HV", num(r.ivHvRatio) === null ? DASH : `${formatFixed(r.ivHvRatio, 2)}×`],
      ["Verdict", S.verdictText(r.verdict)],
      ["Skew 25Δ", r.skewInfo ? `${formatSigned(r.skew, 1)} pts (${formatInt(r.skewInfo.putStrike)} PE ${formatFixed(r.skewInfo.put, 1)} · ${formatInt(r.skewInfo.callStrike)} CE ${formatFixed(r.skewInfo.call, 1)})` : DASH],
      ["Term", num(r.term) === null ? DASH : `${formatSigned(r.term, 1)} pts${r.termInfo?.inverted ? " · inverted" : r.termInfo?.vol ? ` · fwd vol ${formatFixed(r.termInfo.vol, 1)}` : ""}`],
      ["Straddle", `${formatFixed(r.straddle, 2)} · ${formatRupee(r.straddleLot, 0)}/lot · ${formatPercent(r.straddlePct, 2)}`],
      ["±1σ move", `${formatFixed(r.em, 0)} · ${formatPercent(r.emPct, 2)}`],
      ["PCR", `${formatFixed(r.pcr, 2)}${num(r.pcrChange) !== null ? ` · chg PCR ${formatFixed(r.pcrChange, 2)}` : ""}`],
      ["Max pain", `${formatInt(r.maxPain)} (${formatSigned(r.mpDiff, 0)})`],
      ["Put wall / call wall", `${formatInt(r.support)} / ${formatInt(r.resistance)}`],
      ["Build-up", r.oiMissing ? "OI change unavailable" : r.build?.text ?? DASH],
      ["16Δ strikes", r.strangle.pe !== null && r.strangle.ce !== null ? `${formatInt(r.strangle.pe)} PE · ${formatInt(r.strangle.ce)} CE` : DASH],
      ["Basis", `${formatSigned(r.basis, 1)}${num(r.carry) !== null ? ` · ${formatFixed(r.carry, 1)}%/yr` : ""}`],
    ];
  }
  function hedgeMetrics(r) {
    return [
      ["Put", `${formatInt(r.strike)} PE @ ${formatFixed(r.ask, 2)}`],
      ["Depth below F", formatPercent(r.depth, 2)],
      ["Cost", `${formatPercent(r.costPct, 3)} · ${formatRupee(r.perLot, 0)}/lot · ${formatRupee(r.perDay, 0)}/day`],
      ["Annualised", formatPercent(r.annualised, 1)],
      ["Payout at −2σ", num(r.payout) === null ? DASH : `${formatFixed(r.payout, 1)}× premium`],
      ["Skew paid", num(r.skewPaid) === null ? DASH : `${formatSigned(r.skewPaid, 1)} pts`],
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
        out.push(`Held to expiry in the money, STT is 0.15% of intrinsic (about ${formatRupee((intrinsic * r.lot * O.CHARGES.sttExercisePct) / 100, 0)}/lot). Exit before 15:30 to avoid it.`);
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
    const staleMs = cfg.auto ? cfg.auto * 2000 : 10 * 60_000;
    if (entry?.stale || age > staleMs) out.push(`Data is ${S.ageText(age)} old.`);
    return out;
  }
  function actions(r, pid) {
    const btns = [];
    const chainBtn = (strike, side) => h("button", { type: "button", class: "small tinted", onclick: () => openInChain(r.underlying, r.expiry, strike, side) }, icon("chart"), "Open in Option Chain");
    if (r.kind === "contract") {
      const buy = h("button", { type: "button", class: "small", onclick: () => toStrategy(r, [{ right: r.right, strike: r.strike, side: "BUY" }]) }, icon("plus"), "Add Buy to Strategy");
      const sell = h("button", { type: "button", class: "small", onclick: () => toStrategy(r, [{ right: r.right, strike: r.strike, side: "SELL" }]) }, icon("plus"), "Add Sell to Strategy");
      const wing = r.wing && pid !== "buy" ? h("button", { type: "button", class: "small", onclick: () => toStrategy(r, [{ right: r.right, strike: r.strike, side: "SELL" }, { right: r.right, strike: r.wing.wingStrike, side: "BUY" }]) }, icon("plus"), `Sell with ${formatInt(r.wing.wingStrike)} wing`) : null;
      btns.push(chainBtn(r.strike, r.side), ...(pid === "sell" ? [sell, wing, buy] : [buy, sell, wing]).filter(Boolean));
    } else if (r.kind === "underlying") {
      btns.push(chainBtn(r.atmStrike, "ce"));
      const straddle = (side) => [{ right: "CE", strike: r.atmStrike, side }, { right: "PE", strike: r.atmStrike, side }];
      btns.push(h("button", { type: "button", class: "small", onclick: () => toStrategy(r, straddle("BUY"), "Straddle") }, icon("plus"), "Buy straddle → Strategy"));
      btns.push(h("button", { type: "button", class: "small", onclick: () => toStrategy(r, straddle("SELL"), "Straddle") }, icon("plus"), "Sell straddle → Strategy"));
      if (r.strangle.ce !== null && r.strangle.pe !== null) {
        const str = (side) => [{ right: "PE", strike: r.strangle.pe, side }, { right: "CE", strike: r.strangle.ce, side }];
        btns.push(h("button", { type: "button", class: "small", onclick: () => toStrategy(r, str("BUY"), "16Δ strangle") }, icon("plus"), "Buy 16Δ strangle"));
        btns.push(h("button", { type: "button", class: "small", onclick: () => toStrategy(r, str("SELL"), "16Δ strangle") }, icon("plus"), "Sell 16Δ strangle"));
      }
    } else if (r.kind === "hedge") {
      btns.push(chainBtn(r.strike, "pe"));
      btns.push(h("button", { type: "button", class: "small", onclick: () => toStrategy(r, [{ right: "PE", strike: r.strike, side: "BUY" }]) }, icon("plus"), "Add Buy to Strategy"));
    } else if (r.kind === "arb") {
      if (r.strike !== null) btns.push(chainBtn(r.strike, r.right === "PE" ? "pe" : "ce"));
      if (r.legs.length) btns.push(h("button", { type: "button", class: "small", onclick: () => toStrategy(r, r.legs.map((l) => ({ right: l.right, strike: l.strike, side: l.side, lots: l.qty ?? 1 })), r.type) }, icon("plus"), "Add legs to Strategy"));
    }
    return h("div", { class: "scr-d-actions" }, btns);
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

  // ── Filters sheet ──
  function openFilters(focusId = null) {
    const p = preset();
    const host = h("div", { class: "scr-filters" });
    const build = () => {
      const f = filters();
      const ctx = { expiries: scannedExpiries() };
      const rows = [...p.filters.map((id) => filterControl(id, f[id], render, ctx)), ...(p.id === "hedge" ? [notionalControl(render)] : [])];
      // Keys for focus: "<filter>:<n>" on each control, so a rebuild puts focus back where it was.
      for (const row of rows) row.querySelectorAll("input, button, select").forEach((el, i) => el.setAttribute("data-fk", `${row.dataset.filter}:${i}`));
      swapKeepFocus(host, [h("p", { class: "scr-f-intro" }, `${p.label}: changes apply as you go. ${formatInt(recompute().total)} match.`), ...rows]);
    };
    // Rebuild after the event that changed a value has finished moving focus (Tab, Enter or a tap), then refocus.
    let queued = false;
    const render = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        if (host.isConnected) build();
      }, 0);
    };
    build();
    modal({
      title: "Filters",
      body: host,
      buttons: [
        { label: "Reset", cls: "", onClick: () => (resetFilters(), render(), false) },
        { label: "Done", cls: "primary", value: true },
      ],
    }).then(() => filtersBtn.isConnected && filtersBtn.focus({ preventScroll: true }));
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
    return h("div", { class: "scr-f", "data-filter": "notional" }, h("span", { class: "scr-f-l" }, "Notional to hedge (₹)", h("small", {}, "Index notional only; scale by your portfolio beta")), input);
  }
  function filterControl(id, v, render, ctx) {
    const f = S.FILTERS[id];
    const apply = (nv) => {
      setFilter(id, nv);
      render();
    };
    const numIn = (val, label, onSet) => {
      const input = h("input", { type: "number", inputmode: "decimal", step: String(f.step ?? 1), value: val ?? "", placeholder: "Any", "aria-label": label });
      input.addEventListener("change", () => {
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
    if (f.type === "min" || f.type === "max") ctl = h("span", { class: "scr-f-num" }, h("span", { class: "scr-f-op" }, f.type === "min" ? "≥" : "≤"), numIn(v, f.label, (x) => apply(x)), unit);
    else if (f.type === "range") {
      const [lo, hi] = v ?? [null, null];
      // A crossing edit carries the other end with it (never a silent swap): from 0.95 with to 0.30 gives 0.95–0.95.
      ctl = h(
        "span",
        { class: "scr-f-num" },
        numIn(lo, `${f.label} from`, (x) => apply([x, x !== null && hi !== null && x > hi ? x : hi])),
        h("span", { class: "scr-f-op" }, "to"),
        numIn(hi, `${f.label} to`, (x) => apply([x !== null && lo !== null && x < lo ? x : lo, x])),
        unit,
      );
    } else if (f.type === "toggle") {
      const input = h("input", { type: "checkbox", checked: Boolean(v) });
      input.addEventListener("change", () => apply(input.checked));
      return h("label", { class: "sw-row scr-f", "data-filter": id }, h("span", { class: "sw-text" }, f.label), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
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
    return h("div", { class: "scr-f", "data-filter": id }, h("span", { class: "scr-f-l" }, f.label), ctl);
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
      h(
        "section",
        {},
        h("h3", {}, `${p.label} columns`),
        h("div", { class: "col-list" }, colRows),
        h("button", { type: "button", class: "small plain", onclick: () => setCols(p.columns.map((c) => c.id)) }, "Reset columns"),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Scan"),
        seg("Expiries per underlying", [["1", "1"], ["2", "2"], ["3", "3"]], cfg.expiries, (v) => (setCfg({ expiries: Number(v) }, { rescan: true }), render())),
        h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, "Include the monthly", h("small", {}, "The current month's last expiry")), h("span", { class: "switch" }, monthly, h("i", { "aria-hidden": "true" }))),
        seg("Strikes each side", S.STRIKE_CHOICES.map((x) => [String(x), `±${x}`]), cfg.strikes, (v) => (setCfg({ strikes: Number(v) }, { rescan: true }), render())),
        seg("Auto refresh", [["0", "Off"], ["60", "1m"], ["120", "2m"], ["300", "5m"]], cfg.auto, (v) => {
          setCfg({ auto: Number(v) });
          drawAuto();
          startAuto();
          render();
        }),
        seg("Rows shown", S.ROW_CHOICES.map((x) => [String(x), String(x)]), cfg.rows, (v) => {
          shown = Number(v);
          setCfg({ rows: Number(v) });
          render();
        }),
        numSet("Brokerage ₹ per order", cfg.brokerage, 0, 100, (x) => (setCfg({ brokerage: x }), render())),
        numSet("Wing width (strikes)", cfg.wingStrikes, 1, 10, (x) => (setCfg({ wingStrikes: x }), render()), "Sell rows' defined-risk alternative"),
      ),
    ];
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

  // ── Draw ──
  function drawSort() {
    const p = preset();
    const s = cfg.sort[p.id];
    const want = `${p.id}|${s.by}|${s.dir}`;
    if (sortSel.__sig === want) return;
    sortSel.__sig = want;
    sortSel.replaceChildren(
      ...p.columns.filter((c) => c.sortable).flatMap((c) => [h("option", { value: `${c.id}:desc` }, `${c.label} ↓`), h("option", { value: `${c.id}:asc` }, `${c.label} ↑`)]),
    );
    sortSel.value = `${s.by}:${s.dir}`;
  }
  function draw() {
    if (destroyed) return;
    const t0 = performance.now();
    const p = preset();
    drawTabs();
    drawAuto();
    drawStatus();
    drawChips();
    drawSort();
    if (desc.__p !== p.id) {
      desc.__p = p.id;
      if (!desc.__how) desc.__how = h("a", { href: "#scr-how", class: "scr-how", onclick: (e) => (e.preventDefault(), (methodEl.open = true), methodEl.scrollIntoView({ block: "nearest" })) }, "How it works");
      if (!desc.__text) desc.append((desc.__text = document.createTextNode("")), " ", desc.__how);
      desc.__text.data = p.description;
    }
    slotText.textContent = `Price and IV history for ${recByKey(selKey)?.underlying ?? cfg.underlyings[0]}. Your chart engine plugs in here.`;
    const hasData = [...cache.keys()].some((k) => cfg.underlyings.includes(k.split("|")[0]) && cache.get(k)?.chain);
    recompute();
    drawBanners();
    drawIssues();
    drawMethod();
    const isPhone = phone();
    const rows = result.rows.slice(0, shown);
    if (!hasData && (scanning || !lastSweepFailed)) {
      wrap.hidden = isPhone;
      cards.hidden = !isPhone;
      emptyEl.hidden = true;
      skeleton();
      countEl.textContent = "";
      moreBtn.hidden = true;
    } else if (!hasData) {
      wrap.hidden = true;
      cards.hidden = true;
      emptyEl.hidden = true;
      countEl.textContent = "";
      moreBtn.hidden = true;
    } else if (!result.total) {
      wrap.hidden = true;
      cards.hidden = true;
      emptyEl.hidden = false;
      drawEmpty();
      countEl.textContent = `0 of ${formatInt(S.recordsFor(scan, p).length)} · ${formatInt(scan.chains)} chains`;
      moreBtn.hidden = true;
    } else {
      emptyEl.hidden = true;
      wrap.hidden = isPhone;
      cards.hidden = !isPhone;
      if (isPhone) drawCards(rows);
      else drawTable(rows);
      countEl.textContent = `Showing ${formatInt(rows.length)} of ${formatInt(result.total)} · ${formatInt(scan.chains)} chains`;
      const more = Math.min(cfg.rows, result.total - rows.length);
      moreBtn.hidden = more <= 0;
      moreBtn.textContent = `Show ${formatInt(more)} more`;
    }
    if (selKey && !recByKey(selKey)) selKey = null;
    drawPane();
    if (p.id === "arb" && !methodEl.open) {
      /* the arbitrage footer note lives in the methodology */
    }
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
    if (k === "Enter" && selKey) return wide() ? (paneBody.querySelector("button")?.focus(), true) : (openSheet(), true);
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
    if (k === "r" || k === "R") return cancelSweep(), startSweep(true), true;
    if (k === "f" || k === "F") return openFilters(), true;
    if (k === "a" || k === "A") return toggleAuto(), true;
    if (k === "Escape") {
      if (closePop) return closePop(), true;
      if (selKey) return select(null), true;
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
    tableSig = "";
    cardSig = "";
    paneSig = "";
    draw();
  };
  for (const m of mqs) m.addEventListener("change", onDevice);
  const onRoute = () => setTimeout(() => !root.isConnected && cleanup(), 0);
  window.addEventListener("hashchange", onRoute);
  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    cancelSweep();
    closePop?.();
    for (const m of mqs) m.removeEventListener("change", onDevice);
    window.removeEventListener("hashchange", onRoute);
    if (activePage === page) activePage = null;
  }
  // Start once the router has put the panels on the page.
  setTimeout(() => {
    if (!root.isConnected) return cleanup();
    draw();
    startSweep(false);
    startAuto();
  }, 0);
  draw();
  mountToolbarCtx("screener", h("div", { class: "ctx-cap glass" }, h("span", { class: "ctx-item ctx-scr", title: "Underlyings and chains in the scan" }, ctxMain)));
  return [main, detail, chart];
}
