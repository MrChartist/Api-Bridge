// The Arbitrage scanner (#/arb, PRD 06; round 2: docs/design/arb.md): put-call parity per strike (conversions and
// reversals against the same-expiry future), box spreads as lending / borrowing rates, and the futures term (basis,
// carry, calendar, roll). Everything is priced at the touch (bid to sell, ask to buy), after every statutory charge and
// brokerage, and after the cost of money at the user's hurdle rate. desk.js owns the top bar, the selected chain,
// futures quotes and the timer; this file owns the rates ladder, the opportunity rail, the scanner (heat strip, box
// matrix, term chart, table or phone cards), the detail pane / sheet (net hero, cost waterfall, locked payoff), the
// order preview, risk notes and the chart slot. Colour encodes edge after charges: green clears every cost, red does
// not. The maths is in options.js (pure, tested); numbers become text only through format.js.
import { api, chartSlot, copyText, emptyState, errorState, h, icon, istTime, modal, optional, toast } from "./app.js";
import { DASH, MINUS, formatCompact, formatFixed, formatInput, formatInt, formatPercent, formatRupee, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { flashValue, lineReveal, reducedMotion } from "./motion.js";
import * as O from "./options.js";
import { refCharges, refSession } from "./reference.js";
import { edgeFades, segmented } from "./views.js";
import { legend, setBar, spotPill, svgEl } from "./viz.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short" });
const dayMon = (e) => (ISO_DAY.test(e ?? "") ? DAY_MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const mon = (e) => (ISO_DAY.test(e ?? "") ? MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? ""));
const MQ_PHONE = "(max-width: 719px)";
const MQ_NARROW = "(max-width: 1023px)";
const MQ_WIDE = "(min-width: 1280px)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q).matches : false);
const EXTRA_EVERY_MS = 15_000;
const BOX_ROWS_MAX = 120;
const BOX_CARDS_MAX = 30;
const FLASH_BUDGET = 40; // value flashes per tick, at most (PRD 06 §14: ≤ 200 patched elements)
const FLIP_MAX = 30; // a re-sort that moves more rows than this jumps instead of sliding
const optFreeze = new Map(); // underlying -> option freeze quantity (all strikes share it)
const ungroup = (t) => (t === null || t === undefined ? t : String(t).replace(/(\d),(?=\d)/g, "$1"));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Signed rupees, whole: "+₹624", "−₹74", "₹0". */
export const rupeeSigned = (v) => formatSignedRupee(v, 0);
/** Rupees, whole, compact from 1 lakh up ("₹3.12L"). */
const money = (v) => (!isFigure(v) ? DASH : Math.abs(v) >= 1e5 ? `${v < 0 ? MINUS : ""}₹${formatCompact(Math.abs(v))}` : formatRupee(v, 0));
const pct = (v, dp = 1) => (num(v) === null ? DASH : formatPercent(v * 100, dp));
/** A signed rate: "+3.8%", "−2.88%". */
const pctSigned = (v, dp = 1) => (num(v) === null ? DASH : `${formatSigned(v * 100, dp)}%`);
/** The ink class for a signed figure: green above zero, red below, neutral when it rounds to zero at `dp`. */
export function inkOf(v, dp = 0) {
  if (!isFigure(v)) return "";
  const r = Number(formatFixed(Math.abs(Number(v)), dp).replace(/[^\d.]/g, ""));
  if (r === 0) return "ink-zero";
  return Number(v) > 0 ? "ink-pos" : "ink-neg";
}
const KIND_NAME = { conv: "Conversion", rev: "Reversal", lbox: "Long box", sbox: "Short box", cal: "Calendar", fut: "Futures basis" };
const KEY_HINTS = [[["1", "2", "3"], "tabs"], [["J", "K"], "row"], [["↵"], "detail"], [["B"], "best"], [["E"], "by edge"], [["M"], "matrix"], [["O"], "opps"], [["H"], "hold"], [["+", "−"], "lots"], [["C"], "copy"], [["Esc"], "clear"]];
const RISK_NOTES = [
  ["Executable only if every leg fills", " at these prices; legs are separate orders (legging risk)."],
  ["Quotes can be stale.", " Edges older than the stale limit are hidden from Best. Liquid NIFTY parity gaps are usually closed by algos within seconds; most visible edges are on illiquid strikes or stale quotes."],
  ["Index options are European and cash-settled", " at the final settlement price: no early assignment, and an index conversion has no basis mismatch at expiry."],
  ["Futures are marked to market daily:", " a locked structure still needs cash for MTM on the future."],
  ["Exercise STT:", " long ITM options held to expiry pay 0.15% of intrinsic value. Choose Close to compare."],
  ["Expiry day:", " +2% ELM on short index options and no calendar-spread margin benefit. Annualised figures are hidden on expiry day."],
  ["A short box blocks margin close to its width", " in India; it is not cheap leverage."],
  ["Charges as of 1 Apr 2026", " (STT 0.15% options sell, 0.05% futures sell); editable in Costs & filters. Verify the current statutory rates."],
  ["Tax:", " F&O gains are business income in India; this page does not compute tax."],
];
// Shown only while the Bridge runs on generated prices: the one place this page explains why parity breaks appear.
const SAMPLE_NOTE = ["", "Calls and puts use different volatility smiles here, so parity breaks are artificial."];

// ── Small shared glyphs: the liquidity meter, the cost-cover bar, a chip on the diverging bp scale ──

/** A 5-segment liquidity meter (1–2 warn, 3 fair, 4–5 good); update it with setLiq. */
function liqMeter() {
  return h("span", { class: "arb-liq", role: "img" }, [1, 2, 3, 4, 5].map(() => h("i")));
}
function setLiq(el, n) {
  const v = Math.max(0, Math.min(5, Math.round(num(n) ?? 0)));
  if (el.__n === v) return el;
  el.__n = v;
  el.dataset.liq = String(v);
  [...el.children].forEach((i, k) => i.classList.toggle("lit", k < v));
  const word = v <= 2 ? "thin" : v === 3 ? "fair" : "good";
  const label = v ? `Liquidity ${v} of 5 (${word})` : "No quote";
  el.setAttribute("aria-label", label);
  el.title = v ? `${label}: from spread and volume rank, the weaker leg` : "No two-sided quote";
  return el;
}
/**
 * The cost-cover bar: how much of the total cost the gross edge pays for. The cost marker sits at 70 % of the track,
 * so cover 1.0 reaches it and the bar caps near 1.43×. Green beyond the marker when the edge clears costs; a red part
 * fill when it covers only part of them; nothing when the gross is negative.
 */
/** Decimals for a run of ticks, from their step (0.25 → 2, 0.5 → 1, 1 → 0), so every label has the same precision. */
function tickDp(ticks) {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  for (let dp = 0; dp < 4; dp++) if (Math.abs(step * 10 ** dp - Math.round(step * 10 ** dp)) < 1e-6) return dp;
  return 4;
}
function coverBar(size = "card") {
  const fill = h("span", { class: "arb-cv-fill" });
  const over = h("span", { class: "arb-cv-over" });
  const mark = h("i", { class: "arb-cv-mark" }, size === "cell" ? null : h("b", {}, "cost"));
  const track = h("span", { class: "arb-cv-track", "aria-hidden": "true" }, fill, over, mark);
  const label = h("span", { class: "arb-cv-label" });
  const el = h("span", { class: `arb-cover cv-${size}` }, track, label);
  let sig = "";
  return {
    el,
    /** c = O.coverRatio(s); returns the tone ("pos" | "neg" | "none"). */
    set(c, { compact = size === "cell", brief = false } = {}) {
      const gross = c?.gross ?? null;
      const cover = c?.cover ?? null;
      const tone = gross === null || gross <= 0 ? "none" : cover === null || cover >= 1 ? "pos" : "neg";
      const x = gross === null || gross <= 0 ? 0 : cover === null ? 1 : clamp01(cover * 0.7);
      const base = tone === "pos" ? Math.min(x, 0.7) : tone === "neg" ? x : 0;
      const beyond = tone === "pos" ? clamp01((x - 0.7) / 0.3) : 0;
      let text;
      if (gross === null) text = DASH;
      else if (tone === "pos") text = cover === null ? "no cost" : compact ? `${formatFixed(cover, 1)}×` : `covers ${formatFixed(cover, 1)}×`;
      else if (compact) text = `${MINUS}${formatFixed(c.short, 2)} pts`;
      else if (brief) text = `needs ${formatFixed(c.short, 2)} pts`;
      else text = gross <= 0 ? `gross negative · needs ${formatFixed(c.short, 2)} pts` : `needs ${formatFixed(c.short, 2)} pts more`;
      const s = `${tone}|${Math.round(base * 1000)}|${Math.round(beyond * 1000)}|${text}`;
      if (s === sig) return tone;
      sig = s;
      el.dataset.tone = tone;
      fill.style.setProperty("--v", String(Math.round(base * 1000) / 1000));
      over.style.setProperty("--v", String(Math.round(beyond * 1000) / 1000));
      label.textContent = text;
      label.className = `arb-cv-label ${tone === "pos" ? "ink-pos" : gross === null ? "" : "ink-neg"}`;
      el.title = gross === null ? "" : `${gross <= 0 ? "Gross negative: " : ""}gross ${formatSigned(gross, 2)} pts against ${formatFixed(c.cost, 2)} pts of costs per unit`;
      return tone;
    },
  };
}
/** A chip on the diverging scale for a bp gap (fixed thresholds: 10 / 50 / 150 bp). */
function bpChip(bp, { suffix = " bp" } = {}) {
  const st = O.bpStep(bp);
  return h("span", { class: "arb-bp dv-heat", "data-div": st === null ? undefined : String(st) }, bp === null || bp === undefined ? DASH : `${formatSigned(bp, 0)}${suffix}`);
}
/** A floating tooltip inside a positioned host (F§4.5 look): show(x, y, content) / hide(). */
function tipper(host) {
  const tip = h("div", { class: "dv-tip arb-tip", hidden: true, role: "status" });
  host.append(tip);
  return {
    el: tip,
    show(x, y, content) {
      tip.replaceChildren(...[content].flat().filter((c) => c !== null && c !== undefined));
      tip.hidden = false;
      const W = host.clientWidth;
      const tw = tip.offsetWidth || 180;
      const tx = Math.max(0, Math.min(W - tw, x - tw / 2));
      tip.style.setProperty("--tx", `${Math.round(tx)}px`);
      tip.style.top = `${Math.round(y)}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}
/** Slide rows (or cards) from their old place to their new one after a re-order (FLIP). Reduced motion: jump. */
function flip(nodes, before) {
  if (reducedMotion() || !before?.size) return;
  let moved = 0;
  const jobs = [];
  for (const el of nodes) {
    const top = before.get(el);
    if (top === undefined) continue;
    const d = top - el.offsetTop;
    if (Math.abs(d) < 1) continue;
    if (++moved > FLIP_MAX) return;
    jobs.push([el, d]);
  }
  for (const [el, d] of jobs) el.animate?.([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" });
}

/**
 * @param {{ st: object, save: () => void, account: () => object|null, sendOrders: (bodies: object[]) => Promise<object>,
 *   openTicket: (o: object) => Promise<unknown>, selectExpiry: (e: string) => void, retry: () => void,
 *   demo: () => boolean, onPositions: () => void }} ctx
 */
export function arbPanels(ctx) {
  const { st, save } = ctx;
  const cfg = () => st.arb;
  let sel = null; // selected row key
  let detailKind = new Map(); // parity row key -> "conv" | "rev" (the user's pick in the detail)
  let last = null; // last model
  let destroyed = false;
  let closePop = null;
  let sheet = null; // { detail } while the bottom sheet is open
  let flashLeft = FLASH_BUDGET;
  let wfUnit = "rs"; // the waterfall's ₹ | pts toggle (shared by the pane and the sheet)
  const depth = new Map(); // symbol -> { bid, ask } top quantities
  const extra = new Map(); // expiry -> { chain, at, error }
  let extraAt = 0;
  let extraLoading = false;
  let lastAnnounce = { id: "", at: 0 };
  // The statutory table is the reference one (refCharges of the page's bundle), with the user's edits on top.
  let ratesMemo = { key: null, base: null, rates: null };
  const rates = () => {
    const key = JSON.stringify(cfg().rates);
    if (ratesMemo.key !== key || ratesMemo.base !== st.ref) ratesMemo = { key, base: st.ref, rates: O.ratesWith(cfg().rates, refCharges(st.ref)) };
    return ratesMemo.rates;
  };
  const setCfg = (patch) => {
    const tabBefore = cfg().tab;
    if (patch.cols || patch.tab || patch.boxMode) squeeze = 0;
    st.arb = O.arbConfig({ ...cfg(), ...patch });
    save();
    syncHead();
    if (cfg().tab !== tabBefore) crossFade();
    draw();
  };
  const phone = () => media(MQ_PHONE);
  const narrow = () => media(MQ_NARROW);
  /** Phones and tablets in portrait have no pane beside the list: the detail opens as a bottom sheet. */
  const sheetMode = () => narrow();
  /** Set text; flash the element green / red when a shown number changed (at most FLASH_BUDGET per tick). */
  function setVal(el, text, v, { rel = 0 } = {}) {
    if (el.textContent === text) return;
    const old = el.__v;
    el.textContent = text;
    el.__v = v;
    // Table cells pass rel: a tick that moves a value by less than that share of it (or keeps its sign) stays quiet.
    const big = !rel || Math.sign(old) !== Math.sign(v) || Math.abs(v - old) >= rel * Math.max(Math.abs(old), 1e-9);
    if (isFigure(old) && isFigure(v) && old !== v && big && flashLeft > 0) {
      flashLeft--;
      flashValue(el, v > old ? "up" : "down");
    }
  }

  // ── Rates ladder (replaces the six figure tiles): every rate on one %/yr axis against the hurdle ──
  const ladderSvg = svgEl("svg", { class: "arb-ladder-svg", role: "img", "aria-label": "Rates against the hurdle" });
  const ladderPlot = h("div", { class: "arb-ladder-plot" }, ladderSvg);
  const ladderTip = tipper(ladderPlot);
  const fig = (label) => {
    const value = h("strong", { class: "arb-fig-v" }, DASH);
    const sub = h("span", { class: "arb-fig-s" }, " ");
    return { el: h("div", { class: "arb-fig", role: "group", "aria-label": label }, h("span", { class: "arb-fig-l" }, label), value, sub), value, sub };
  };
  const figFut = fig("Future");
  const figFwd = fig("Implied fwd");
  const ladderEl = h("section", { class: "desk-panel arb-ladder", "data-panel": "rates", "aria-label": "Rates ladder" }, ladderPlot, h("div", { class: "arb-figs" }, figFut.el, figFwd.el));
  const ladderMarks = new Map(); // id -> { g, label }

  // ── Opportunity rail: the best parity, box and carry / calendar item, each with its edge after charges ──
  const railNote = h("p", { class: "arb-rail-note", hidden: true });
  const railErr = h("p", { class: "err-bar arb-rail-err", hidden: true });
  const SLOTS = ["parity", "box", "carry"];
  const railCards = SLOTS.map((slot) => railCard(slot));
  const railRow = h("div", { class: "arb-rail-row" }, railCards.map((c) => c.el));
  const railEl = h("section", { class: "arb-rail", "data-panel": "opportunities", "aria-label": "Best opportunities" }, railNote, railErr, railRow);
  // Phones scroll the rail sideways: a fade shows only on a side with more cards.
  edgeFades(railRow);
  function railCard(slot) {
    const kind = h("span", { class: "arb-o-kind" });
    const tags = h("span", { class: "arb-o-tags" });
    const liq = liqMeter();
    const net = h("strong", { class: "arb-o-net" }, DASH);
    const ret = h("span", { class: "arb-o-ret" });
    const cover = coverBar("card");
    const alt = h("span", { class: "arb-o-alt" });
    const meta = h("span", { class: "arb-o-meta" });
    const btn = h("button", { type: "button", class: "small arb-o-btn" }, "Preview");
    // The card is a plain group: a stretched "open in scanner" button covers it, Preview sits above that (no nested controls).
    const open = h("button", { type: "button", class: "arb-o-open", hidden: true });
    const body = h("div", { class: "arb-o-in" }, h("div", { class: "arb-o-r1" }, kind, tags, liq), h("div", { class: "arb-o-r2" }, net, ret), h("div", { class: "arb-o-r3" }, cover.el, alt), h("div", { class: "arb-o-r4" }, meta, btn));
    const el = h("div", { class: "arb-opp skel", role: "group", "data-slot": slot, "aria-busy": "true" }, open, body);
    const card = { el, open, kind, tags, liq, net, ret, cover, alt, meta, btn, body, key: null, net0: null, go: null, act: null };
    open.addEventListener("click", () => card.go?.());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      card.act?.();
    });
    return card;
  }

  // ── Scanner head ──
  const tabSeg = segmented("Scanner", [["parity", "Parity"], ["boxes", "Boxes"], ["futures", "Futures"]], cfg().tab);
  tabSeg.classList.add("arb-tabs");
  tabSeg.addEventListener("change", () => tabSeg.value !== cfg().tab && setCfg({ tab: tabSeg.value }));
  const lotsOut = h("output", { class: "arb-lots-n", "aria-live": "polite" });
  const lotBtn = (d) => h("button", { type: "button", class: "icon-btn tiny arb-step", "aria-label": d < 0 ? "One lot fewer" : "One lot more", onclick: () => stepLots(d) }, d < 0 ? "−" : "+");
  const lotsEl = h("div", { class: "arb-lots", role: "group", "aria-label": "Lots" }, lotBtn(-1), h("span", { class: "arb-lots-box" }, lotsOut, h("small", {}, "lots")), lotBtn(1));
  const stepLots = (d) => setCfg({ lots: Math.max(1, Math.min(100, cfg().lots + d)) });
  const holdSeg = segmented("Hold", [["expiry", "Expiry"], ["close", "Close"]], cfg().hold);
  holdSeg.classList.add("arb-hold");
  holdSeg.title = "Hold to expiry (cash-settled, exercise STT) or close before expiry at today's spreads";
  holdSeg.addEventListener("change", () => holdSeg.value !== cfg().hold && setCfg({ hold: holdSeg.value }));
  const oppsInput = h("input", { type: "checkbox", role: "switch" });
  oppsInput.addEventListener("change", () => setCfg({ onlyOpps: oppsInput.checked }));
  const oppsEl = h("label", { class: "sw-row arb-opps", title: "Only rows that clear your minimum net, liquidity and freshness (O)" }, h("span", { class: "sw-text" }, "Opps only"), h("span", { class: "switch" }, oppsInput, h("i", { "aria-hidden": "true" })));
  const gearDot = h("i", { class: "arb-gear-dot", hidden: true, "aria-hidden": "true" });
  const gearBtn = h("button", { type: "button", class: "small gear-btn arb-gear", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Hurdle rate, brokerage, statutory rates, filters and columns" }, icon("sliders"), h("span", { class: "gear-label" }, "Costs & filters"), gearDot);
  gearBtn.addEventListener("click", () => openSettings());
  const filtersBtn = h("button", { type: "button", class: "small arb-filters-btn", "aria-haspopup": "dialog", "aria-label": "Filters" }, icon("sliders"), h("span", {}, "Filters"));
  filtersBtn.addEventListener("click", () => openSettings());
  const chips = h("span", { class: "arb-chips" });
  const headEl = h("div", { class: "panel-head arb-head" }, h("div", { class: "arb-head-l" }, tabSeg, chips), h("div", { class: "arb-head-r" }, lotsEl, holdSeg, oppsEl, gearBtn, filtersBtn));
  function syncHead() {
    const c = cfg();
    if (tabSeg.value !== c.tab) tabSeg.value = c.tab;
    if (holdSeg.value !== c.hold) holdSeg.value = c.hold;
    oppsInput.checked = c.onlyOpps;
    lotsOut.textContent = formatInt(c.lots);
    // Hold and Opportunities live in Costs & filters on tablets and phones: a dot says one is not the default.
    const moved = c.onlyOpps || c.hold === "close";
    gearDot.hidden = !moved;
    gearBtn.setAttribute("aria-label", `Costs & filters${moved ? " (hold or opportunities changed)" : ""}`);
    filtersBtn.classList.toggle("on", moved);
    filtersBtn.lastChild.textContent = c.onlyOpps ? "Filters · on" : "Filters";
  }
  syncHead();

  // ── The tab's visual (parity heat strip / box matrix / term chart), the table or phone cards, the pane ──
  const vizEl = h("div", { class: "arb-viz" });
  const noteEl = h("div", { class: "arb-notes-inline" });
  const caption = h("caption", { class: "sr-only" });
  const thead = h("thead");
  const tbody = h("tbody");
  const tableEl = h("table", { class: "arb-table" }, caption, thead, tbody);
  const wrapEl = h("div", { class: "table-wrap arb-wrap" }, tableEl);
  const cardsEl = h("ul", { class: "arb-cards", role: "listbox", "aria-label": "Scanner results" });
  const emptyEl = h("div", { class: "arb-empty", hidden: true });
  const footEl = h("p", { class: "arb-foot" });
  const keysEl = h("div", { class: "desk-keys arb-keys" }, KEY_HINTS.map(([keys, label]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), label)));
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const mainEl = h("div", { class: "arb-main" }, noteEl, vizEl, wrapEl, cardsEl, emptyEl, footEl, keysEl);
  const paneDetail = createDetail({ pane: true });
  const paneEl = h("aside", { class: "arb-pane", "aria-label": "Selected structure" }, paneDetail.el);
  // The fade at the pane's foot shows only while more content sits below the fold.
  const paneMore = () => paneEl.classList.toggle("more", paneEl.scrollTop + paneEl.clientHeight < paneEl.scrollHeight - 2);
  paneEl.addEventListener("scroll", paneMore, { passive: true });
  const paneRO = typeof ResizeObserver === "function" ? new ResizeObserver(paneMore) : null;
  paneRO?.observe(paneDetail.el);
  paneRO?.observe(paneEl);
  const bodyEl = h("div", { class: "arb-body" }, mainEl, paneEl);
  const scanEl = h("section", { class: "desk-panel arb-scan", "data-panel": "scanner", "aria-label": "Arbitrage scanner" }, headEl, bodyEl, live);
  function crossFade() {
    if (reducedMotion()) return;
    for (const el of [vizEl, wrapEl, cardsEl]) el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }

  tbody.addEventListener("click", (e) => {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-key]") : null;
    if (tr) select(tr.dataset.key, { open: sheetMode() });
  });
  tbody.addEventListener("dblclick", (e) => {
    const tr = e.target instanceof Element ? e.target.closest("tr[data-key]") : null;
    if (tr) focusDetail();
  });
  cardsEl.addEventListener("click", (e) => {
    const li = e.target instanceof Element ? e.target.closest("li[data-key]") : null;
    if (li) select(li.dataset.key, { open: true });
  });
  cardsEl.addEventListener("keydown", (e) => {
    const li = e.target instanceof Element ? e.target.closest("li[data-key]") : null;
    if (li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.stopPropagation();
      select(li.dataset.key, { open: true });
    }
  });
  // Long-press a phone card: the order preview (same gates as the button in the sheet).
  let pressT = null;
  cardsEl.addEventListener("pointerdown", (e) => {
    const li = e.target instanceof Element ? e.target.closest("li[data-key]") : null;
    if (!li || e.pointerType === "mouse") return;
    clearTimeout(pressT);
    pressT = setTimeout(() => {
      const x = itemOf(li.dataset.key);
      if (x?.s?.legs?.length && last && !last.stale) {
        li.__pressed = true;
        openOrders(x.s, last);
      }
    }, 600);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) cardsEl.addEventListener(ev, () => clearTimeout(pressT));
  cardsEl.addEventListener(
    "click",
    (e) => {
      const li = e.target instanceof Element ? e.target.closest("li[data-key]") : null;
      if (li?.__pressed) {
        li.__pressed = false;
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  thead.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button[data-sort]") : null;
    if (b) cycleSort(b.dataset.sort);
  });

  // ── Risk notes (collapsed by default, one-line teaser) and the chart engine slot ──
  const notesList = h("ol", { class: "arb-note-list" });
  const notesSummary = h("summary", {});
  const notesDetails = h("details", { class: "arb-details" }, notesSummary, notesList);
  notesDetails.addEventListener("toggle", () => {
    if (notesDetails.open !== notesOpen()) {
      st.arb = O.arbConfig({ ...cfg(), notesOpen: notesDetails.open });
      save();
    }
    drawNotesSummary();
  });
  const notesOpen = () => cfg().notesOpen ?? false;
  const notesEl = h("section", { class: "desk-panel arb-notes", "data-panel": "risk-notes", "aria-label": "Risk notes" }, notesDetails);
  function drawNotes() {
    const lines = [...RISK_NOTES, ...(ctx.demo() ? [SAMPLE_NOTE] : [])];
    notesList.replaceChildren(...lines.map(([b, t]) => h("li", {}, b ? h("strong", {}, b) : null, t)));
    notesDetails.open = notesOpen();
    drawNotesSummary();
  }
  function drawNotesSummary() {
    const n = notesList.children.length;
    notesSummary.replaceChildren(h("strong", {}, `Risk notes · ${formatInt(n)}`), notesDetails.open ? null : h("span", { class: "arb-sub" }, `${RISK_NOTES[0][0]}…`));
  }
  drawNotes();
  // The chart-engine slot is a panel only once an engine is registered (no placeholder box until then).
  const chartBox = chartSlot("Implied forward and box rate by strike over time");
  const chartEl = chartBox ? h("section", { class: "desk-panel arb-chart", "data-panel": "chart-slot", "aria-label": "Chart engine slot" }, chartBox) : null;

  // ── Model: everything the page shows, from the chain, futures quotes and settings ──
  function futQuote(inst) {
    if (!inst) return null;
    const q = st.quotes.get(inst.symbol);
    return { symbol: inst.symbol, expiry: inst.expiry, lotSize: inst.lotSize, tickSize: inst.tickSize, freezeQty: inst.freezeQty, bid: num(q?.bid), ask: num(q?.ask), ltp: num(q?.ltp), asOf: q?.freshness?.asOf ?? null, quoted: Boolean(q) };
  }
  function model() {
    const c = st.chain;
    if (!c) return null;
    const conf = cfg();
    const now = Date.now();
    const days = O.timeToExpiry(c.expiry, now, refSession(st.ref).close).days;
    const hRate = conf.hurdle / 100;
    const R = rates();
    // The flat / per-lot value is the user's, else the reference brokerage per order (spec §5.6).
    const profile = { ...conf.profile, value: conf.profile.value ?? refCharges(st.ref).brokeragePerOrder };
    const inst = st.futures.find((f) => f.expiry === c.expiry) ?? null;
    const fut = futQuote(inst);
    const futError = Boolean(inst) && (!fut.quoted || st.quotesError);
    const fwd = O.impliedForward(c, { rate: hRate, days, window: 5 });
    const optRate = O.optionsImpliedRate(c, { days, window: 5 });
    const memo = new Map();
    const t0 = performance.now();
    const par = O.parityRows(c, { fut: inst ? fut : null, rate: hRate, days, lots: conf.lots, profile, hold: conf.hold, window: conf.window, rates: R, futMarginPct: conf.futMarginPct / 100, fwd, memo });
    const fresh = O.staleness({ chainAsOf: st.freshness?.asOf, futAsOf: fut?.asOf ?? null, now, maxAgeMs: conf.staleSec * 1000 });
    const stale = fresh.stale || Boolean(st.freshness?.stale);
    const boxArgs = { rate: hRate, days, lots: conf.lots, profile, hold: conf.hold, window: conf.window, maxSteps: conf.boxMaxSteps, rates: R, centre: fwd?.atm ?? null, settle: par.settle, memo };
    const lendBoxes = O.boxes(c, { ...boxArgs, mode: "lend" });
    const borrowBoxes = O.boxes(c, { ...boxArgs, mode: "borrow" });
    const spot = num(c.underlyingLtp);
    const futs = st.futures.map((f) => futQuote(f));
    const chains = new Map([...extra].filter(([, v]) => v.chain).map(([e, v]) => [e, v.chain]));
    chains.set(c.expiry, c);
    const term = O.futuresTerm(spot, futs, { now, rate: hRate, profile, rates: R, chains });
    const twoCount = c.rows.filter((r) => O.twoSided(r.ce) && O.twoSided(r.pe)).length;
    const m = {
      c,
      days,
      expiryDay: days !== null && days < 1,
      hRate,
      inst,
      fut,
      futError,
      fwd,
      optRate,
      par,
      heat: O.devHeat(par.rows),
      stale,
      fresh,
      lendBoxes,
      borrowBoxes,
      boxes: conf.boxMode === "lend" ? lendBoxes : borrowBoxes,
      term,
      chains,
      spot,
      oneSidedMarket: twoCount < 2,
      noFuture: !inst,
      nearestFut: st.futures.find((f) => f.expiry >= c.expiry) ?? st.futures[0] ?? null,
      nowMs: now,
    };
    // The futures carry the ladder shows: the same-expiry future's, else the nearest one with a carry.
    m.carryFut = term.futures.find((f) => f.expiry === c.expiry && f.carry !== null) ?? term.futures.find((f) => f.carry !== null) ?? null;
    m.isOpp = {
      parity: (r) => Boolean(r.best) && !stale && r.best.net >= conf.minNet && r.liq >= conf.minLiq,
      box: (b) => !stale && !b.crossed && !m.expiryDay && b.vsHurdleBp !== null && b.vsHurdleBp >= conf.minBoxBp && b.liq >= conf.minLiq,
    };
    m.computeMs = performance.now() - t0;
    return m;
  }

  /** The structure a parity row stands for in the detail: the user's pick, else the better net. */
  const parityStruct = (r) => {
    const want = detailKind.get(r.key);
    return (want === "conv" ? r.conv : want === "rev" ? r.rev : null) ?? r.best;
  };

  // ── Items per tab (filtered, sorted) ──
  function items(m) {
    const conf = cfg();
    const tab = conf.tab;
    if (tab === "parity") {
      let rows = m.par.rows.map((r, i) => ({ key: r.key, type: "parity", r, i, opp: m.isOpp.parity(r), s: parityStruct(r) }));
      if (conf.onlyOpps) rows = rows.filter((x) => x.opp);
      const s = phone() && conf.onlyOpps ? { key: "best", dir: "desc" } : conf.sort.parity;
      const val = (x) => {
        const r = x.r;
        if (s.key === "dev") return r.dev === null ? null : Math.abs(r.dev);
        if (s.key === "edge") return O.coverRatio(r.best).cover;
        if (s.key === "conv") return r.conv?.net ?? null;
        if (s.key === "rev") return r.rev?.net ?? null;
        if (s.key === "annual") return O.bestAnnualSigned(r)?.v ?? null;
        if (s.key === "best") return r.best?.net ?? null;
        return r.strike;
      };
      return sortBy(rows, val, s.dir);
    }
    if (tab === "boxes") {
      let list = m.boxes.map((b) => ({ key: b.key, type: "box", b, opp: m.isOpp.box(b), s: b }));
      if (conf.onlyOpps) list = list.filter((x) => x.opp);
      const s = conf.sort.boxes;
      const val = (x) => (s.key === "rate" ? x.b.rate : s.key === "locked" ? x.b.locked : s.key === "strikes" ? x.b.k1 * 1e6 + x.b.k2 : x.b.vsHurdleBp);
      return sortBy(list, val, s.dir);
    }
    const out = [];
    m.term.futures.forEach((f, i) => {
      out.push({ key: f.key, type: "fut", f, opp: false, s: futStruct(f, m) });
      const cal = m.term.calendars[i];
      if (cal) out.push({ key: cal.key, type: "cal", cal, opp: false, s: calStruct(cal, m) });
    });
    return out;
  }
  function sortBy(list, val, dir) {
    const k = dir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      return (x - y) * k;
    });
  }
  /** A futures row as a structure (no orders: the future alone is an ordinary ticket). */
  const futStruct = (f, m) => ({ kind: "fut", key: f.key, f, legs: [], U: f.lot * cfg().lots, lot: f.lot, lots: cfg().lots, m });
  /** A calendar as a structure: roll a long (sell the near at its bid, buy the far at its ask). */
  function calStruct(cal, m) {
    const near = m.term.futures.find((f) => f.expiry === cal.from);
    const far = m.term.futures.find((f) => f.expiry === cal.to);
    const N = cfg().lots;
    const U = cal.lot * N;
    const instOf = (e) => st.futures.find((x) => x.expiry === e) ?? {};
    const leg = (side, f) => ({ kind: "FUT", side, symbol: f?.symbol ?? null, price: side === "BUY" ? f?.ask : f?.bid, units: U, lots: N, quote: f ? { bid: f.bid, ask: f.ask } : null, tick: num(instOf(f?.expiry).tickSize) || 0.05, exchange: O.exchangeOfSymbol(f?.symbol), expiry: f?.expiry });
    // Different lot sizes: the far quantity would not be a whole number of its lots, so no orders (LOT_MISMATCH).
    const legs = near?.twoSided && far?.twoSided && !cal.lotMismatch ? [leg("SELL", near), leg("BUY", far)] : [];
    return { kind: "cal", key: cal.key, cal, legs, U, lot: cal.lot, lots: N };
  }

  // ── Columns ──
  const cell = (main, sub = "", o = {}) => ({ main, sub, ...o });
  const quoteCell = (q) => {
    if (!q) return cell(DASH, "", { aria: "No quote" });
    const b = num(q.bid) > 0 ? formatFixed(q.bid, 2) : DASH;
    const a = num(q.ask) > 0 ? formatFixed(q.ask, 2) : DASH;
    return cell(`${b}\u2009·\u2009${a}`, O.spreadPct(q) === null ? "" : formatPercent(O.spreadPct(q), 1), { aria: `${b} bid, ${a} ask, spread ${formatPercent(O.spreadPct(q), 1)}` });
  };
  /** Conversion / reversal: the row's better side carries the pos / neg ink (bold and tinted when it clears costs);
   *  the other side stays quiet, so each row has exactly one coloured money value. */
  const netCell = (s, r) => {
    if (!s) return cell(DASH, "", { aria: "Not executable" });
    const best = r.best === s;
    const ink = best ? inkOf(s.net) : "";
    return cell(rupeeSigned(s.net), `${formatSigned(s.grossPts, 2)} pts`, { cls: `${best ? "best" : "other"}${best && s.net > 0 ? " edge-cell" : ""}`, ink, v: s.net, aria: `Net ${rupeeSigned(s.net)}, gross ${formatSigned(s.grossPts, 2)} points${best ? ", the better side" : ""}` });
  };
  const PARITY_COLS = {
    strike: { head: "Strike", sort: "strike", cls: "k-col", cell: (x, m) => cell(formatInt(x.r.strike), "", { strike: true, atm: x.r.atm, opp: x.opp, stale: m.stale && Boolean(x.r.best) }) },
    call: { head: "Call bid·ask", cell: (x) => quoteCell(x.r.ce) },
    put: { head: "Put bid·ask", cell: (x) => quoteCell(x.r.pe) },
    syn: { head: "Synthetic sell·buy", title: "SynB = K + (Ca − Pb)·g, SynS = K + (Cb − Pa)·g, carried at the hurdle", cell: (x) => (x.r.synSell === null ? cell(DASH, x.r.synMid === null ? "" : `mid ${formatFixed(x.r.synMid, 1)}`, { cls: "quiet" }) : cell(`${formatFixed(x.r.synSell, 1)}\u2009·\u2009${formatFixed(x.r.synBuy, 1)}`, `mid ${formatFixed(x.r.synMid, 1)}`)) },
    dev: {
      head: "Dev",
      sort: "dev",
      title: "Synthetic mid minus the reference (future mid, or the implied forward). Calls rich: SynS > future ask. Puts rich: SynB < future bid",
      cell: (x, m) => {
        const r = x.r;
        if (r.dev === null) return cell(DASH);
        const hc = m.heat[x.i] ?? { side: null, step: 0 };
        const tag = r.tag === "callsRich" ? "calls rich" : r.tag === "putsRich" ? "puts rich" : "";
        const quiet = m.oneSidedMarket || r.oneSided;
        return cell(formatSigned(r.dev, 1), `${formatSigned(r.devBp, 0)} bp`, { heat: hc, tag, cls: quiet ? "quiet" : "", title: quiet ? "Indicative (mid)" : tag ? `${tag[0].toUpperCase()}${tag.slice(1)}: outside the bid-ask band` : "Inside the spread" });
      },
    },
    edge: { head: "Edge", sort: "edge", title: "Cost cover: gross edge ÷ every cost (charges and financing). The tick is the cost; 1.0× breaks even", cell: (x) => cell(null, "", { cover: O.coverRatio(x.r.best) }) },
    conv: { head: "Conversion", sort: "conv", title: "Sell CE at bid, buy PE at ask, buy FUT at ask. Net ₹ for your lots after financing and all charges", cell: (x) => netCell(x.r.conv, x.r) },
    rev: { head: "Reversal", sort: "rev", title: "Buy CE at ask, sell PE at bid, sell FUT at bid. Net ₹ for your lots after financing and all charges", cell: (x) => netCell(x.r.rev, x.r) },
    annual: {
      head: "Net %/yr",
      sort: "annual",
      title: "Net after charges and financing at your hurdle, per year on capital: this is return over the hurdle",
      cell: (x, m) => {
        const a = m.expiryDay ? null : O.bestAnnualSigned(x.r);
        return a ? cell(pctSigned(a.v, 1), a.k, { ink: inkOf(a.v * 100, 1), v: a.v }) : cell(DASH, "", { cls: "quiet" });
      },
    },
    liq: { head: "Liq", title: "1-5 from spread and volume rank; the weaker option leg", cell: (x) => cell(null, "", { liq: x.r.liq }) },
    fwdK: { head: "Implied fwd at K", cell: (x) => cell(formatFixed(x.r.synMid, 1)) },
    ivpc: { head: "IV P−C", title: "PE IV minus CE IV (broker IVs)", cell: (x) => cell(formatSigned(x.r.ivDiff, 2)) },
    oi: { head: "OI C·P", cell: (x) => cell(`${formatCompact(x.r.oiC)} · ${formatCompact(x.r.oiP)}`) },
    gross: { head: "Gross pts", cell: (x) => cell(x.r.best ? formatSigned(x.r.best.grossPts, 2) : DASH, x.r.best ? KIND_NAME[x.r.best.kind] : "", { ink: x.r.best ? inkOf(x.r.best.grossPts, 2) : "" }) },
    charges: { head: "Charges ₹", cell: (x) => cell(x.r.best ? formatRupee(x.r.best.chargesTotal, 0) : DASH, x.r.best ? `${formatFixed(x.r.best.chargesTotal / x.r.best.U, 2)} pts` : "") },
    capital: { head: "Capital ₹", cell: (x) => cell(x.r.best ? money(x.r.best.capital) : DASH, x.r.best ? "est." : "") },
  };
  const COMPACT_PARITY = ["strike", "dev", "edge", "conv", "rev", "annual", "liq"];
  const NEEDS_FUT = new Set(["conv", "rev", "annual", "gross", "charges", "capital", "edge"]);
  const lendMode = () => cfg().boxMode === "lend";
  const BOX_COLS = {
    strikes: { head: "Strikes", sort: "strikes", cls: "k-col", cell: (x) => cell(`${formatInt(x.b.k1)} / ${formatInt(x.b.k2)}`, `${formatInt(x.b.width)} pts`, { strike: true, opp: x.opp, crossed: x.b.crossed }) },
    price: { head: () => (lendMode() ? "Debit" : "Credit"), cell: (x) => cell(formatFixed(x.b.price, 2), formatRupee(x.b.priceRs, 0)) },
    charges: { head: "Charges", title: "All-in for the hold mode", cell: (x) => cell(formatRupee(x.b.chargesTotal, 0), `${formatFixed(x.b.chargesTotal / x.b.U, 2)} pts`) },
    locked: { head: "Locked ₹", sort: "locked", title: "Lend: W·U − D·U − charges. Borrow: Cr·U − W·U − charges (the interest you pay)", cell: (x) => cell(rupeeSigned(x.b.locked), "", { ink: inkOf(x.b.locked), v: x.b.locked }) },
    rate: {
      head: "Rate %/yr",
      sort: "rate",
      title: "Net of charges, simple ACT/365. Green when it beats your hurdle (lend above it, borrow below it)",
      cell: (x) => cell(pct(x.b.rate, 2), x.b.grossRate === null ? "" : `gross ${pct(x.b.grossRate, 2)}`, { ink: x.b.vsHurdleBp === null ? "" : x.b.vsHurdleBp >= 0 ? "ink-pos" : "ink-neg", v: x.b.rate }),
    },
    vsHurdle: { head: "vs hurdle", sort: "vsHurdle", title: "Lend: rate − hurdle. Borrow: hurdle − rate (positive = cheaper than your hurdle). Fixed steps at 10 / 50 / 150 bp", cell: (x) => cell(null, "", { bp: x.b.vsHurdleBp }) },
    capital: { head: "Capital", title: "Lend: debit + charges. Borrow: SPAN plus exposure on a short box is close to its width; verify with your broker", cell: (x) => cell(money(x.b.capital), lendMode() ? "" : "≈ width") },
    liq: { head: "Liq", cell: (x) => cell(null, "", { liq: x.b.liq }) },
  };
  const COMPACT_BOX = ["strikes", "price", "rate", "vsHurdle", "capital", "liq"];
  const FUT_COLS = {
    expiry: { head: "Expiry", cls: "k-col", cell: (x, m) => cell(dayMon(x.f.expiry), `${x.f.days === null ? DASH : formatInt(Math.max(0, x.f.days))} d · Monthly`, { strike: true, cur: x.f.expiry === m.c.expiry }) },
    bidask: { head: "Bid · Ask", cell: (x) => cell(x.f.twoSided ? `${formatFixed(x.f.bid, 2)} · ${formatFixed(x.f.ask, 2)}` : DASH, x.f.spread === null ? "" : `spread ${formatFixed(x.f.spread, 2)}`) },
    basis: { head: "Basis", cell: (x, m) => cell(formatSigned(x.f.basis, 2), x.f.basisPct === null ? "" : formatPercent(x.f.basisPct, 2), { bar: { value: x.f.basis, max: Math.max(...m.term.futures.map((f) => Math.abs(f.basis ?? 0))) } }) },
    carry: { head: "Carry %/yr", title: "(Fm/S − 1)·365/d against your hurdle", cell: (x) => cell(pct(x.f.carry, 2), "", { ink: x.f.carryVsBp === null ? "" : x.f.carryVsBp >= 0 ? "ink-pos" : "ink-neg", subBp: x.f.carryVsBp, v: x.f.carry }) },
    fwd: {
      head: "Options fwd",
      title: "The chain's implied forward for that expiry; Fut rich if its bid is above the ATM synthetic's sell, cheap if its ask is below the synthetic's buy",
      cell: (x) => (x.f.fwd ? cell(formatFixed(x.f.fwd.forward, 2), `${formatSigned(x.f.fwdGap, 2)} pts${x.f.fwdTag ? ` · Fut ${x.f.fwdTag}` : ""}`) : cell(DASH, !st.expiries.includes(x.f.expiry) ? "no options listed" : extra.get(x.f.expiry)?.loading ? "loading" : "", { cls: "quiet" })),
    },
    long: { head: "Cheaper long", cell: (x) => cheapCell(x.f.cheaper?.long) },
    short: { head: "Cheaper short", cell: (x) => cheapCell(x.f.cheaper?.short) },
  };
  const COMPACT_FUT = ["expiry", "basis", "carry", "fwd", "long", "short"];
  const cheapCell = (c) => (c ? cell(c.pick === "future" ? "Future" : "Synthetic", `by ${formatFixed(c.diffPts, 1)} pts · ${formatRupee(c.diffPerLot, 0)}/lot`, { subInk: "ink-pos" }) : cell(DASH, "", { cls: "quiet" }));

  // The column set steps down only when the table does not fit its area (squeeze 0 full, 1 compact + synthetic,
  // 2 compact); a resize starts again from the full set.
  let squeeze = 0;
  function columns(m) {
    const tab = cfg().tab;
    if (tab === "parity") {
      let ids = squeeze === 0 ? cfg().cols : squeeze === 1 ? ["strike", "syn", ...COMPACT_PARITY.slice(1)] : COMPACT_PARITY;
      if (m.noFuture || m.futError || m.par.lotMismatch) ids = ids.filter((k) => !NEEDS_FUT.has(k));
      return ids.map((k) => ({ id: k, ...PARITY_COLS[k] }));
    }
    if (tab === "boxes") return (squeeze ? COMPACT_BOX : Object.keys(BOX_COLS)).map((k) => ({ id: k, ...BOX_COLS[k] }));
    return (squeeze ? COMPACT_FUT : Object.keys(FUT_COLS)).map((k) => ({ id: k, ...FUT_COLS[k] }));
  }
  /** After a rebuild: step the column set down while the table is wider than its area. */
  function fitTable(m, rows) {
    const max = cfg().tab === "parity" ? 2 : 1;
    while (squeeze < max && rows.length && tableEl.offsetWidth > wrapEl.clientWidth + 1) {
      squeeze++;
      tableSig = "";
      drawTable(m, rows);
    }
  }
  let resizeT = null;
  const onResize = () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (destroyed) return;
      squeeze = 0;
      tableSig = "";
      vizSig = "";
      draw();
    }, 150);
  };
  if (typeof window !== "undefined") window.addEventListener("resize", onResize);

  // ── Table: built once per structure, patched per tick ──
  let tableSig = "";
  const rowEls = new Map(); // key -> { tr, tds: Map }
  function headText(c) {
    return typeof c.head === "function" ? c.head() : c.head;
  }
  function buildHead(cols) {
    const s = cfg().sort[cfg().tab];
    thead.replaceChildren(
      h(
        "tr",
        {},
        cols.map((c) => {
          const sorted = c.sort && s?.key === c.sort;
          const label = headText(c);
          return h(
            "th",
            { scope: "col", class: `${c.cls ?? ""} ${c.id === "strike" || c.id === "strikes" || c.id === "expiry" ? "" : "num"}`.trim() || undefined, title: c.title, "aria-sort": c.sort ? (sorted ? (s.dir === "asc" ? "ascending" : "descending") : "none") : undefined },
            c.sort ? h("button", { type: "button", class: "arb-sort", "data-sort": c.sort }, label, h("span", { class: "arb-sort-i", "aria-hidden": "true" }, sorted ? (s.dir === "asc" ? "▲" : "▼") : "")) : label,
          );
        }),
      ),
    );
  }
  function cycleSort(key) {
    const tab = cfg().tab;
    const def = O.ARB_DEFAULTS.sort[tab];
    const cur = cfg().sort[tab];
    let next;
    if (cur.key !== key) next = { key, dir: "desc" };
    else if (cur.dir === "desc") next = { key, dir: "asc" };
    else next = { ...def };
    setCfg({ sort: { ...cfg().sort, [tab]: next } });
  }
  const isKey = (col) => col.id === "strike" || col.id === "strikes" || col.id === "expiry";
  function renderCell(td, v, col) {
    const base = `${col.cls ?? ""} ${isKey(col) ? "" : "num"} ${v.cls ?? ""}`.trim();
    // Persistent glyphs: patched in place so their bars and segments move from the old value.
    if (v.cover !== undefined) {
      if (!td.__cover) {
        td.__cover = coverBar("cell");
        td.replaceChildren(td.__cover.el);
        td.className = `${base} arb-edge-td`;
      }
      const tone = td.__cover.set(v.cover);
      td.setAttribute("aria-label", v.cover.gross === null ? "No edge figure" : tone === "pos" ? `Covers costs ${formatFixed(v.cover.cover ?? 0, 1)} times` : `Needs ${formatFixed(v.cover.short, 2)} points more`);
      return;
    }
    if (v.liq !== undefined) {
      if (!td.__liq) {
        td.__liq = liqMeter();
        td.replaceChildren(td.__liq);
        td.className = base;
      }
      setLiq(td.__liq, v.liq);
      return;
    }
    const sig = JSON.stringify(v);
    if (td.__sig === sig) return;
    td.__sig = sig;
    td.className = base;
    if (v.title) td.title = v.title;
    else td.removeAttribute("title");
    if (v.aria) td.setAttribute("aria-label", v.aria);
    else td.removeAttribute("aria-label");
    if (v.heat) {
      td.classList.add("arb-dev-td", "dv-heat");
      td.dataset.side = v.heat.side ?? "";
      td.dataset.step = String(v.heat.side ? Math.min(3, v.heat.step) : 0);
    } else if (td.dataset.side !== undefined) {
      delete td.dataset.side;
      delete td.dataset.step;
    }
    if (v.bp !== undefined) return td.replaceChildren(bpChip(v.bp));
    if (v.strike) {
      const tags = [];
      if (v.opp) tags.push(h("span", { class: "arb-tag edge", title: "Clears your filters" }, "Edge"));
      if (v.stale) tags.push(h("span", { class: "arb-tag stale", title: "Quotes are stale" }, "Stale"));
      if (v.crossed) tags.push(h("span", { class: "arb-tag bad", title: "Almost certainly a stale or bad quote" }, "Crossed"));
      const k = h("strong", { title: v.atm ? "Nearest the implied forward (not spot)" : v.cur ? "The expiry selected in the toolbar" : undefined }, v.main);
      return td.replaceChildren(...[h("span", { class: "arb-k" }, k, v.sub ? h("small", {}, v.sub) : null), tags.length ? h("span", { class: "arb-tags" }, tags.slice(0, 2)) : null].filter(Boolean));
    }
    const strong = td.__strong && td.contains(td.__strong) ? td.__strong : null;
    const small = h("small", { class: v.subInk ?? "" }, v.sub || " ");
    if (v.tag) small.append(" · ", h("span", { class: v.tag === "calls rich" ? "ink-call" : "ink-put" }, v.tag));
    if (v.subBp !== undefined && v.subBp !== null) small.replaceChildren(bpChip(v.subBp));
    const main = strong ?? h("strong", {});
    main.className = v.ink ?? "";
    setVal(main, v.main ?? DASH, v.v, { rel: 0.05 });
    td.__strong = main;
    const bar = v.bar ? h("span", { class: "arb-basis", "aria-hidden": "true" }, setBar(h("span", { class: "dv-bar", "data-dv": "iv" }), v.bar.value, v.bar.max)) : null;
    // An opportunity's Net cell: pos ink with a small tick before the figure (no leading bar on the row).
    const tick = /\bedge-cell\b/.test(v.cls ?? "") ? h("span", { class: "arb-edge-ic", "aria-hidden": "true" }, icon("check")) : null;
    const lead = bar ?? tick;
    td.replaceChildren(h("span", { class: "two" }, lead ? h("span", { class: "arb-bar-row" }, lead, main) : main, small));
  }
  function calCells(cal, span) {
    const pair = (l, v, t) => h("span", { class: "arb-cal-f", title: t }, h("small", {}, l), v);
    return h(
      "td",
      { colspan: String(span), class: "arb-cal" },
      h(
        "span",
        { class: "arb-cal-in" },
        h("strong", { class: "arb-cal-l" }, `${mon(cal.from)} → ${mon(cal.to)}`),
        pair("Spread buy·sell far", cal.buyFar === null ? DASH : `${formatFixed(cal.buyFar, 2)} · ${formatFixed(cal.sellFar, 2)}`),
        pair("Fwd rate", pct(cal.fwdRate, 2), "(F2m/F1m − 1)·365/(d2 − d1)"),
        pair("Fair spread", cal.fair === null ? DASH : `${formatFixed(cal.fair, 2)} (${formatSigned(cal.vsFair, 1)} ${cal.tag ?? ""})`.trim(), "F1m·(e^(h·Δd/365) − 1) at your hurdle; mid spread minus fair"),
        cal.lotMismatch
          ? pair("Roll", "lot sizes differ", "The two futures have different lot sizes: there is no one-for-one roll")
          : pair("Roll long · short ₹/lot", cal.rollLong === null ? DASH : `${formatRupee(cal.rollLong, 0)} · ${formatRupee(cal.rollShort, 0)}`, "Roll long: sell near at its bid, buy far at its ask. Roll short: buy near at its ask, sell far at its bid. Both include charges. The spread is carry you pay or receive by holding the later contract: compare it with the fair spread"),
      ),
    );
  }
  function drawTable(m, list) {
    const cols = columns(m);
    const sig = JSON.stringify([cfg().tab, m.c.underlying, m.c.expiry, cfg().window, cols.map((c) => c.id), cfg().boxMode, m.noFuture]);
    const sortSig = JSON.stringify(cfg().sort[cfg().tab]);
    const fresh = sig !== tableSig;
    if (fresh) {
      tableSig = sig;
      tbody.replaceChildren();
      rowEls.clear();
    }
    drawTable.fresh = fresh;
    if (fresh || thead.__sort !== sortSig) {
      thead.__sort = sortSig;
      buildHead(cols);
    }
    caption.textContent = cfg().tab === "parity" ? `Put-call parity by strike, ${m.c.underlying} ${dayMon(m.c.expiry)}, ${m.noFuture ? "against the implied forward" : "against the future"}` : cfg().tab === "boxes" ? `Box spreads, ${lendMode() ? "lending" : "borrowing"} rates, ${m.c.underlying} ${dayMon(m.c.expiry)}` : `${m.c.underlying} futures term structure`;
    const keep = new Set(list.map((x) => x.key));
    for (const [k, r] of rowEls) {
      if (!keep.has(k)) {
        r.tr.remove();
        rowEls.delete(k);
      }
    }
    const frag = [];
    for (const x of list) {
      let r = rowEls.get(x.key);
      if (!r) {
        const tr = h("tr", { "data-key": x.key, tabindex: "-1" });
        r = { tr, tds: new Map(), cal: null, net: null };
        rowEls.set(x.key, r);
      }
      if (x.type === "cal") {
        const s = JSON.stringify(x.cal);
        if (r.cal !== s) {
          r.cal = s;
          r.tr.replaceChildren(calCells(x.cal, cols.length));
        }
      } else {
        for (const c of cols) {
          let td = r.tds.get(c.id);
          if (!td) {
            td = h("td");
            r.tds.set(c.id, td);
            r.tr.append(td);
          }
          renderCell(td, c.cell(x, m), c);
        }
      }
      const net = x.type === "parity" ? (x.r.best?.net ?? null) : null;
      const newEdge = x.opp && r.net !== null && r.net <= 0 && net > 0;
      r.net = net;
      const cls = ["arb-row", x.type === "cal" ? "cal-row" : "", x.opp ? "opp" : "", newEdge ? "new-edge" : "", m.stale && x.type !== "fut" && x.type !== "cal" ? "stale" : "", x.key === selKey() ? "sel" : "", x.type === "parity" && x.r.atm ? "atm" : "", x.type === "fut" && x.f.expiry === m.c.expiry ? "cur" : ""].filter(Boolean).join(" ");
      if (r.tr.className !== cls) r.tr.className = cls;
      r.tr.setAttribute("aria-selected", String(x.key === selKey()));
      frag.push(r.tr);
    }
    // Reorder the existing nodes only when the order changed; rows slide to their new place (FLIP).
    const cur = [...tbody.children];
    if (cur.length !== frag.length || cur.some((el, i) => el !== frag[i])) {
      const before = fresh ? null : new Map(cur.map((el) => [el, el.offsetTop]));
      tbody.append(...frag);
      flip(frag, before);
    }
  }

  // ── Phone cards: three rows, a leading bar for the edge, the cover bar and the liquidity meter ──
  const cardEls = new Map();
  let cardSig = "";
  function newCard(x) {
    const li = h("li", { "data-key": x.key, role: "option", tabindex: "0", class: "arb-card" });
    const p = { li, a: h("span", { class: "arb-ca" }), b: h("span", { class: "arb-cb" }), v: h("strong", { class: "arb-cv" }), sw: h("i", { class: "arb-sw dv-heat", "aria-hidden": "true" }), d: h("span", { class: "arb-cd" }), r: h("span", { class: "arb-cr" }), x3: h("span", { class: "arb-cx" }), liq: liqMeter(), cover: coverBar("cell") };
    li.append(h("span", { class: "arb-c1" }, p.a, p.b, p.v), h("span", { class: "arb-c2" }, p.sw, p.d, p.r), h("span", { class: "arb-c3" }, p.cover.el, p.x3, p.liq));
    li.__p = p;
    return li;
  }
  function patchCard(li, x, m) {
    const p = li.__p;
    let edge = "none";
    if (x.type === "parity") {
      const r = x.r;
      const s = r.best;
      const a = m.expiryDay ? null : O.bestAnnualSigned(r);
      const hc = m.heat[x.i] ?? { side: null, step: 0 };
      p.a.replaceChildren(h("strong", { class: r.atm ? "arb-atm" : "" }, formatInt(r.strike)));
      p.b.textContent = s ? KIND_NAME[s.kind] : m.noFuture ? "vs implied fwd" : "";
      p.v.className = `arb-cv ${s ? inkOf(s.net) : ""}`;
      setVal(p.v, s ? rupeeSigned(s.net) : r.dev === null ? DASH : `${formatSigned(r.dev, 1)} pts`, s ? s.net : null, { rel: 0.05 });
      p.sw.dataset.side = hc.side ?? "";
      p.sw.dataset.step = String(hc.step);
      p.d.replaceChildren(`dev ${formatSigned(r.dev, 1)}`, r.tag ? h("span", { class: r.tag === "callsRich" ? "ink-call" : "ink-put" }, r.tag === "callsRich" ? " · calls rich" : " · puts rich") : "");
      p.r.className = `arb-cr ${a ? inkOf(a.v * 100, 1) : ""}`;
      p.r.textContent = s ? (a ? `${pctSigned(a.v, 1)}/yr` : DASH) : (m.oneSidedMarket || r.oneSided) && r.dev !== null ? "indicative" : "";
      p.cover.el.hidden = !s;
      if (s) p.cover.set(O.coverRatio(s), { compact: false, brief: true });
      p.x3.replaceChildren(...[x.opp ? h("span", { class: "arb-tag edge" }, "Edge") : null, m.stale && s ? h("span", { class: "arb-tag stale" }, "Stale") : null].filter(Boolean));
      setLiq(p.liq, r.liq);
      edge = !s ? "none" : m.stale ? "stale" : s.net > 0 && x.opp ? "pos" : "neg";
    } else if (x.type === "box") {
      const b = x.b;
      p.a.replaceChildren(h("strong", {}, `${formatInt(b.k1)} / ${formatInt(b.k2)}`));
      // The Lend | Borrow capsule above the list already names the mode.
      p.b.textContent = "";
      p.v.className = `arb-cv ${b.vsHurdleBp === null ? "" : b.vsHurdleBp >= 0 ? "ink-pos" : "ink-neg"}`;
      setVal(p.v, pct(b.rate, 2), b.rate);
      p.sw.hidden = true;
      p.d.textContent = `${b.mode === "lend" ? "Debit" : "Credit"} ${formatFixed(b.price, 2)} · ${money(b.capital)}`;
      p.r.className = `arb-cr ${inkOf(b.locked)}`;
      p.r.textContent = rupeeSigned(b.locked);
      p.cover.el.hidden = true;
      p.x3.replaceChildren(...[bpChip(b.vsHurdleBp, { suffix: " bp vs hurdle" }), b.crossed ? h("span", { class: "arb-tag bad" }, "Crossed") : null].filter(Boolean));
      setLiq(p.liq, b.liq);
      edge = m.stale ? "stale" : x.opp ? "pos" : "neg";
    } else if (x.type === "fut") {
      const f = x.f;
      p.a.replaceChildren(h("strong", { class: f.expiry === m.c.expiry ? "arb-atm" : "" }, dayMon(f.expiry)));
      p.b.textContent = `${f.days === null ? DASH : formatInt(Math.max(0, f.days))} d`;
      p.v.className = `arb-cv ${f.carryVsBp === null ? "" : f.carryVsBp >= 0 ? "ink-pos" : "ink-neg"}`;
      setVal(p.v, `${pct(f.carry, 2)}/yr`, f.carry);
      p.sw.hidden = true;
      p.d.textContent = `Basis ${formatSigned(f.basis, 2)}${f.fwdTag ? ` · Fut ${f.fwdTag}` : ""}`;
      p.r.className = "arb-cr";
      p.r.textContent = f.cheaper ? `Long via ${f.cheaper.long.pick}` : f.twoSided ? `${formatFixed(f.bid, 2)} · ${formatFixed(f.ask, 2)}` : "";
      p.cover.el.hidden = true;
      p.x3.replaceChildren(bpChip(f.carryVsBp, { suffix: " bp vs hurdle" }));
      p.liq.hidden = true;
    } else {
      const c = x.cal;
      li.classList.add("cal");
      p.a.replaceChildren(h("strong", {}, `${mon(c.from)} → ${mon(c.to)}`));
      p.b.textContent = "Calendar";
      p.v.className = "arb-cv";
      setVal(p.v, pct(c.fwdRate, 2), c.fwdRate);
      p.sw.hidden = true;
      p.d.textContent = c.lotMismatch ? "Lot sizes differ: no roll" : c.rollLong === null ? `Roll long ${DASH}` : `Roll long ${formatRupee(c.rollLong, 0)}/lot`;
      p.r.textContent = c.fair === null ? "" : `fair ${formatFixed(c.fair, 1)}`;
      p.cover.el.hidden = true;
      p.x3.replaceChildren(...[c.tag ? h("span", { class: `arb-rc ${c.tag === "rich" ? "ink-neg" : "ink-pos"}` }, `${c.tag} ${formatSigned(c.vsFair, 1)}`) : null].filter(Boolean));
      p.liq.hidden = true;
    }
    if (li.dataset.edge !== edge) {
      // Flash on every neg → pos flip (restart the animation; drop the class when it ends or the edge goes away).
      li.classList.remove("new-edge");
      if (edge === "pos" && li.dataset.edge === "neg" && !reducedMotion()) {
        void li.offsetWidth;
        li.classList.add("new-edge");
        li.addEventListener("animationend", () => li.classList.remove("new-edge"), { once: true });
      }
      li.dataset.edge = edge;
    }
  }
  function drawCards(m, list) {
    const sig = JSON.stringify([cfg().tab, m.c.underlying, m.c.expiry, cfg().boxMode]);
    const fresh = sig !== cardSig;
    if (fresh) {
      cardSig = sig;
      cardsEl.replaceChildren();
      cardEls.clear();
    }
    const keep = new Set(list.map((x) => x.key));
    for (const [k, el] of cardEls) {
      if (!keep.has(k)) {
        el.remove();
        cardEls.delete(k);
      }
    }
    const order = [];
    for (const x of list) {
      let li = cardEls.get(x.key);
      if (!li) {
        li = newCard(x);
        cardEls.set(x.key, li);
      }
      patchCard(li, x, m);
      li.classList.toggle("opp", x.opp);
      li.classList.toggle("stale", Boolean(m.stale && x.type === "parity" && x.r.best));
      li.classList.toggle("sel", x.key === selKey());
      li.setAttribute("aria-selected", String(x.key === selKey()));
      order.push(li);
    }
    const cur = [...cardsEl.children];
    if (cur.length !== order.length || cur.some((el, i) => el !== order[i])) {
      const before = fresh ? null : new Map(cur.map((el) => [el, el.offsetTop]));
      cardsEl.append(...order);
      flip(order, before);
    }
  }

  // ── Selection ──
  let list = [];
  const selKey = () => sel;
  const itemOf = (k) => list.find((x) => x.key === k) ?? null;
  function bestItem() {
    const opps = list.filter((x) => x.opp);
    if (cfg().tab === "parity") return [...list].filter((x) => x.r.best).sort((a, b) => b.r.best.net - a.r.best.net)[0] ?? list.find((x) => x.r.atm) ?? list[0] ?? null;
    if (cfg().tab === "boxes") return opps[0] ?? list.find((x) => !x.b.crossed) ?? list[0] ?? null;
    return list.find((x) => x.type === "fut" && x.f.expiry === last?.c.expiry) ?? list[0] ?? null;
  }
  function select(key, { open = false, scroll = false } = {}) {
    sel = key;
    draw();
    const r = rowEls.get(key);
    const card = cardEls.get(key);
    if (scroll) (phone() ? card : r?.tr)?.scrollIntoView?.({ block: "nearest" });
    if (sheetMode() && open) openSheet();
    else if (!sheetMode()) r?.tr.focus({ preventScroll: !scroll });
  }
  /** Go to an item on another tab (rail cards, ladder marks, B). */
  function goTo(tab, key, { boxMode = null, open = sheetMode() } = {}) {
    const patch = {};
    if (boxMode && cfg().boxMode !== boxMode) patch.boxMode = boxMode;
    if (cfg().tab !== tab) patch.tab = tab;
    if (Object.keys(patch).length) setCfg(patch);
    select(key, { scroll: true, open });
  }
  function moveSel(d) {
    if (!list.length) return;
    const i = list.findIndex((x) => x.key === sel);
    const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? (d > 0 ? -1 : list.length) : i) + d));
    select(list[j].key, { scroll: true });
  }
  function focusDetail() {
    if (sheetMode()) return openSheet();
    paneDetail.el.querySelector(".arb-d-title")?.focus();
  }

  // ── Detail (the pane on desktop, the bottom sheet on tablets and phones) ──
  function createDetail({ pane = false, onTitle = null } = {}) {
    const title = h("h3", { class: "arb-d-title", tabindex: "-1" });
    const kindPill = h("span", { class: "arb-kind" });
    const kindSeg = h("div", { class: "arb-kind-seg" });
    const heroNet = h("strong", { class: "arb-h-net" });
    const heroLine = h("span", { class: "arb-h-line" });
    const heroCover = coverBar("pane");
    const hero = h("div", { class: "arb-hero", hidden: true }, h("div", { class: "arb-h-top" }, heroNet, heroLine), heroCover.el);
    const holdNote = h("p", { class: "arb-d-note" });
    const legsHost = h("div", { class: "arb-d-sec" });
    const lotsHost = h("div", { class: "arb-d-sec arb-d-lots" });
    const wfHost = h("div", { class: "arb-d-sec arb-wf-sec" });
    const payHost = h("div", { class: "arb-d-sec arb-pay" });
    const retHost = h("div", { class: "arb-d-sec" });
    const target = h("input", { type: "number", step: "0.05", min: "0", max: "100", inputmode: "decimal", class: "arb-target", "aria-label": "Target rate, percent a year" });
    const targetOut = h("output", { class: "arb-target-out" });
    const targetGap = h("span", { class: "arb-target-gap" });
    const calcHost = h("div", { class: "arb-d-sec arb-calc", hidden: true }, h("h4", {}, "Target rate → limit"), h("label", { class: "arb-calc-row" }, h("span", {}, "Target rate %/yr"), target), targetOut, targetGap, h("p", { class: "arb-d-fine" }, "Charges at today's quotes (approx.). Rounded to tick in the safe direction."));
    const flagsHost = h("ul", { class: "arb-flags" });
    const copyBtn = h("button", { type: "button", class: "small" }, icon("copy"), "Copy legs");
    const previewBtn = h("button", { type: "button", class: "small primary" }, "Preview orders");
    const why = h("p", { class: "arb-d-why", hidden: true });
    const ticketBtns = h("span", { class: "arb-d-tk" });
    const actions = h("div", { class: "arb-d-actions" }, why, copyBtn, ticketBtns, previewBtn);
    const msg = h("div", { class: "arb-d-msg" });
    const body = h("div", { class: "arb-d-body" }, wfHost, payHost, holdNote, legsHost, lotsHost, retHost, calcHost, flagsHost);
    const el = h("div", { class: `arb-detail${pane ? " in-pane" : ""}` }, h("div", { class: "arb-d-head" }, h("span", { class: "arb-d-eyebrow" }), title, h("div", { class: "arb-d-pills" }, kindPill, kindSeg), hero), msg, body, actions);
    const eyebrow = el.querySelector(".arb-d-eyebrow");
    let cur = null; // { item, s, m }
    let targetKey = null;
    let wfKey = null;
    let wfOpen = false; // small fees expanded
    const sigs = new Map();
    const put = (host, key, sig, build) => {
      if (sigs.get(key) === sig) return;
      sigs.set(key, sig);
      host.replaceChildren(...[build()].flat().filter(Boolean));
    };
    copyBtn.addEventListener("click", () => cur && copyLegs(cur.s));
    previewBtn.addEventListener("click", () => cur && !cur.m.stale && openOrders(cur.s, cur.m));
    target.addEventListener("input", () => drawCalc());
    function drawCalc() {
      const s = cur?.s;
      if (!s || (s.kind !== "lbox" && s.kind !== "sbox")) return;
      const t = num(target.value);
      const L = O.boxLimit({ mode: s.mode, width: s.width, units: s.U, cin: s.cin, x: s.x, target: t === null ? null : t / 100, days: cur.m.days, tick: 0.05 });
      targetOut.textContent = L ? `${s.mode === "lend" ? "Max debit" : "Min credit"} ${formatFixed(L.limit, 2)} per unit` : cur.m.expiryDay ? "Not on expiry day" : DASH;
      // The gap to the current touch: green when the touch already meets the target (lend: debit at or under the max).
      if (!L) {
        targetGap.textContent = "";
        return;
      }
      const gap = s.price - L.limit;
      const ok = s.mode === "lend" ? gap <= 0 : gap >= 0;
      targetGap.className = `arb-target-gap ${ok ? "ink-pos" : "ink-neg"}`;
      targetGap.textContent = `touch ${formatFixed(s.price, 2)}: ${formatFixed(Math.abs(gap), 2)} ${gap > 0 ? "above" : gap < 0 ? "below" : "at the limit"}${ok ? " · fills at this rate now" : ""}`;
    }
    function setHero(net, line, lineInk, cv) {
      hero.hidden = false;
      heroNet.className = `arb-h-net ${inkOf(net.v ?? null)}`;
      setVal(heroNet, net.text, net.v ?? null);
      heroLine.replaceChildren(...line);
      heroLine.className = `arb-h-line ${lineInk ?? ""}`;
      heroCover.el.hidden = !cv;
      if (cv) heroCover.set(cv, { compact: false });
    }
    function update(item, m, { best = false, failed = false, none = false } = {}) {
      if (!item || !m) {
        cur = null;
        el.classList.add("empty");
        eyebrow.textContent = "";
        // Loading only while a load is in flight: a failed or empty load settles to an empty state.
        title.textContent = failed ? "No data" : none ? "Nothing to show" : m ? "Nothing to show" : "Loading…";
        kindPill.textContent = "";
        kindSeg.replaceChildren();
        hero.hidden = true;
        sigs.delete("msg");
        msg.replaceChildren(failed ? h("p", { class: "muted" }, "The chain did not load. Retry it from the scanner.") : none ? h("p", { class: "muted" }, none) : m ? h("p", { class: "muted" }, "Pick a row to see its legs, costs and orders.") : h("div", { class: "arb-d-skel" }, h("span", { class: "skel" }), h("span", { class: "skel" }), h("span", { class: "skel short" })));
        body.hidden = true;
        actions.hidden = true;
        return;
      }
      el.classList.remove("empty");
      body.hidden = false;
      const s = item.s;
      cur = { item, s, m };
      const U = cfg().lots;
      eyebrow.textContent = best ? "Best on this tab" : "Selected";
      hero.hidden = true;
      // Header
      if (item.type === "parity") {
        const r = item.r;
        title.textContent = `${s ? KIND_NAME[s.kind] : "Parity"} · ${m.c.underlying} ${dayMon(m.c.expiry)} ${formatInt(r.strike)} · ${formatInt(U)} lot${U === 1 ? "" : "s"}`;
        kindPill.textContent = r.conv && r.rev ? "" : s ? KIND_NAME[s.kind] : m.noFuture ? "No future" : "Not executable";
        const sigK = JSON.stringify([r.key, Boolean(r.conv), Boolean(r.rev), s?.kind]);
        if (kindSeg.__sig !== sigK) {
          kindSeg.__sig = sigK;
          if (r.conv && r.rev) {
            const seg = segmented("Structure", [["conv", "Conversion"], ["rev", "Reversal"]], s.kind);
            seg.addEventListener("change", () => {
              detailKind.set(r.key, seg.value);
              draw();
            });
            kindSeg.replaceChildren(seg);
          } else kindSeg.replaceChildren();
        }
        if (s) {
          const a = m.expiryDay ? null : s.annual;
          const cv = O.coverRatio(s);
          const covers = cv.cover !== null && cv.cover >= 1 ? `covers ${formatFixed(cv.cover, 1)}×` : "";
          setHero({ text: rupeeSigned(s.net), v: s.net }, [a === null ? "" : `${pctSigned(a, 1)}/yr over hurdle`, a !== null && covers ? " · " : "", covers], a === null ? "" : inkOf(a * 100, 1), cv);
        }
      } else if (item.type === "box") {
        title.textContent = `${KIND_NAME[s.kind]} · ${m.c.underlying} ${dayMon(m.c.expiry)} ${formatInt(s.k1)} / ${formatInt(s.k2)} · ${formatInt(U)} lot${U === 1 ? "" : "s"}`;
        kindPill.textContent = s.mode === "lend" ? "Long box · lend" : "Short box · borrow";
        kindSeg.replaceChildren();
        setHero({ text: rupeeSigned(s.net), v: s.net }, [m.expiryDay ? "" : `${pct(s.rate, 2)}/yr net · `, s.vsHurdleBp === null ? "" : bpChip(s.vsHurdleBp, { suffix: " bp vs hurdle" })], "", O.coverRatio(s));
      } else if (item.type === "fut") {
        const f = item.f;
        title.textContent = `Futures basis · ${m.c.underlying} ${dayMon(f.expiry)}`;
        kindPill.textContent = KIND_NAME.fut;
        kindSeg.replaceChildren();
        setHero({ text: f.carry === null ? DASH : `${pct(f.carry, 2)}/yr` }, ["carry · ", f.carryVsBp === null ? "" : bpChip(f.carryVsBp, { suffix: " bp vs hurdle" })], "", null);
        heroNet.className = "arb-h-net";
      } else {
        const c = item.cal;
        title.textContent = `Calendar · ${m.c.underlying} ${mon(c.from)} → ${mon(c.to)} · ${formatInt(U)} lot${U === 1 ? "" : "s"}`;
        kindPill.textContent = KIND_NAME.cal;
        kindSeg.replaceChildren();
        setHero({ text: c.rollLong === null ? DASH : `${formatRupee(c.rollLong, 0)}/lot` }, ["to roll a long", c.tag ? h("span", { class: c.tag === "rich" ? "ink-neg" : "ink-pos" }, ` · ${c.tag} ${formatSigned(c.vsFair, 1)} pts vs fair`) : ""], "", null);
        heroNet.className = "arb-h-net";
      }
      onTitle?.(title.textContent);
      const structural = s && s.legs?.length;
      holdNote.textContent = item.type === "fut" || item.type === "cal" ? "Futures settle daily (MTM) and at the final settlement price." : "";
      holdNote.hidden = !holdNote.textContent;
      // Messages (no future, one-sided)
      const msgs = [];
      if (item.type === "parity" && !s) {
        if (m.noFuture) msgs.push(h("p", { class: "muted" }, "No listed future for this expiry: a deviation only, not executable as a futures arbitrage."));
        else if (m.futError) msgs.push(h("p", { class: "muted" }, "Futures quotes are unavailable: conversions and reversals need the future's bid and ask."));
        else if (m.par.lotMismatch) msgs.push(h("p", { class: "ink-neg" }, "The future's lot size differs from the options': conversions and reversals are off."));
        else msgs.push(h("p", { class: "muted" }, "A leg has no two-sided quote: nothing here is executable."));
        const r = item.r;
        const hc = m.heat[item.i] ?? { side: null, step: 0 };
        msgs.push(
          kv([
            ["Synthetic sell · buy", r.synSell === null ? DASH : `${formatFixed(r.synSell, 2)} · ${formatFixed(r.synBuy, 2)}`],
            ["Synthetic mid", formatFixed(r.synMid, 2)],
            ["Dev", r.dev === null ? DASH : h("span", { class: "arb-dev-kv" }, h("i", { class: "arb-sw dv-heat", "data-side": hc.side ?? "", "data-step": String(hc.step), "aria-hidden": "true" }), `${formatSigned(r.dev, 2)} pts (${formatSigned(r.devBp, 0)} bp)`, r.tag ? h("span", { class: r.tag === "callsRich" ? "ink-call" : "ink-put" }, r.tag === "callsRich" ? " · calls rich" : " · puts rich") : "")],
            ["Call bid · ask", quoteCell(r.ce).main],
            ["Put bid · ask", quoteCell(r.pe).main],
            ["IV P−C", formatSigned(r.ivDiff, 2)],
          ]),
        );
      }
      if (item.type === "fut") msgs.push(futDetail(item.f, m));
      if (item.type === "cal" && item.cal.lotMismatch) {
        const lotOf = (e) => m.term.futures.find((f) => f.expiry === e)?.lot;
        msgs.push(h("p", { class: "ink-neg" }, `Lot sizes differ (${mon(item.cal.from)} ${formatInt(lotOf(item.cal.from))}, ${mon(item.cal.to)} ${formatInt(lotOf(item.cal.to))}): there is no one-for-one roll, so no orders.`));
      }
      put(msg, "msg", JSON.stringify([item.key, msgs.length ? msgs.map((x) => x.textContent) : []]), () => msgs);
      body.hidden = !structural && item.type !== "fut" && item.type !== "cal";
      actions.hidden = !(structural || item.type === "fut");
      copyBtn.hidden = !structural;
      previewBtn.hidden = !structural;
      previewBtn.disabled = Boolean(m.stale);
      why.hidden = !(structural && m.stale);
      why.textContent = m.stale ? `Quotes are ${formatInt((m.fresh.ageMs ?? 0) / 1000)} s old: refresh before you preview.` : "";
      previewBtn.title = m.stale ? "Quotes are stale" : "";
      ticketBtns.replaceChildren();
      if (item.type === "fut" && item.f.symbol) {
        const f = item.f;
        const inst = st.futures.find((x) => x.expiry === f.expiry);
        const tk = (side) => ctx.openTicket({ kind: "FUT", side, symbol: f.symbol, quote: () => futQuote(inst), lotSize: f.lot, name: `${m.c.underlying} ${dayMon(f.expiry)} FUT`, tick: inst?.tickSize ?? 0.05, freezeQty: inst?.freezeQty ?? null, row: { strike: 0 }, right: "CE", product: "MARGIN", expiry: f.expiry });
        ticketBtns.append(h("button", { type: "button", class: "small", onclick: () => tk("BUY") }, "Buy future"), h("button", { type: "button", class: "small", onclick: () => tk("SELL") }, "Sell future"));
      }
      if (!structural) {
        for (const host of [legsHost, lotsHost, retHost, flagsHost]) host.replaceChildren();
        wfHost.hidden = true;
        payHost.hidden = true;
        sigs.clear();
        calcHost.hidden = true;
        return;
      }
      // Waterfall: gross to net, a floating step per cost (calendar: spread + charges = roll cost)
      const fresh = wfKey !== s.key;
      if (fresh) {
        wfKey = s.key;
        wfOpen = false;
      }
      wfHost.hidden = false;
      drawWf(s, fresh);
      // Locked payoff (not for a calendar: a roll is not locked)
      payHost.hidden = s.kind === "cal";
      if (s.kind !== "cal") drawPay(s, m);
      // Legs in send order, with depth and slices
      const legs = O.sendOrder(s.legs);
      const topQ = topQtyMap(s);
      put(legsHost, "legs", JSON.stringify([legs.map((l) => [l.symbol, l.side, l.price, l.units]), [...topQ], legs.map((l) => freezeOf(l))]), () => {
        // Columns only when they carry something: Top qty needs depth, Slices a leg over the freeze limit.
        const sl = legs.map((l) => O.freezeSlices(l.units, freezeOf(l), s.lot).length);
        const depth = legs.some((l) => num(topQ.get(l.symbol)) !== null);
        const sliced = sl.some((n) => n > 1);
        const heads = ["", "Contract", "Price", "Qty", depth ? "Top qty" : null, sliced ? "Slices" : null];
        return [
          h("h4", {}, "Legs ", h("small", {}, "in send order")),
          h(
            "table",
            { class: "arb-legs" },
            h("thead", {}, h("tr", {}, heads.map((t, i) => (t === null ? null : h("th", { scope: "col", class: i >= 2 ? "num" : undefined }, t))).filter(Boolean))),
            h(
              "tbody",
              {},
              legs.map((l, k) => {
                const tq = num(topQ.get(l.symbol));
                const thin = tq !== null && tq < l.units;
                return h(
                  "tr",
                  {},
                  ...[
                    h("td", {}, h("span", { class: `side-tag ${l.side === "BUY" ? "buy" : "sell"}`, "aria-label": l.side === "BUY" ? "Buy" : "Sell" }, l.side === "BUY" ? "B" : "S")),
                    h("td", { title: legName(l, m) }, l.kind === "FUT" ? `FUT ${dayMon(l.expiry ?? m.c.expiry)}` : `${formatInt(l.strike)} ${l.right}`),
                    h("td", { class: "num" }, formatFixed(l.price, 2)),
                    h("td", { class: "num" }, formatInt(l.units)),
                    depth ? h("td", { class: `num${thin ? " ink-warn" : ""}`, title: tq === null ? "Depth not available for this leg" : thin ? "Less than your quantity at the touch: the rest fills worse" : "Quantity at the touch" }, thin ? "⚠ " : "", formatInt(tq)) : null,
                    sliced ? h("td", { class: "num" }, sl[k] > 1 ? formatInt(sl[k]) : "1") : null,
                  ].filter(Boolean),
                );
              }),
            ),
          ),
          depth ? null : h("p", { class: "arb-d-fine" }, "Depth not available from this feed."),
        ].filter(Boolean);
      });
      const maxLots = O.maxLotsAtTouch(s.legs, topQ, s.lot);
      put(lotsHost, "lots", JSON.stringify([maxLots, s.lots]), () => {
        const meter = liqMeter();
        setLiq(meter, maxLots === null ? 0 : Math.max(1, Math.min(5, Math.floor(maxLots / Math.max(1, s.lots)))));
        meter.setAttribute("aria-label", maxLots === null ? "Depth not available" : `${formatInt(maxLots)} lots at the touch`);
        meter.title = meter.getAttribute("aria-label");
        // Without depth the legs table already says so: no row of dashes here.
        if (maxLots === null) return [];
        return [
          h("div", { class: "arb-kv" }, h("span", {}, "Max lots at the touch"), h("span", { class: "arb-kv-v" }, meter, h("strong", { title: "floor(min top-of-book qty ÷ lot)" }, formatInt(maxLots)))),
          maxLots !== null && maxLots < s.lots ? h("p", { class: "ink-warn arb-d-fine" }, `Only ${formatInt(maxLots)} lot${maxLots === 1 ? "" : "s"} available at these prices; the rest fills worse`) : null,
        ];
      });
      if (s.kind === "cal") {
        const c = s.cal;
        put(retHost, "ret", JSON.stringify([c.fair, c.midSpread, c.vsFair, c.rollShort]), () => h("p", { class: "arb-d-fine" }, `Fair spread at your hurdle ${formatFixed(c.fair, 2)} pts; mid spread ${formatFixed(c.midSpread, 2)} (${formatSigned(c.vsFair, 2)}${c.tag ? `, ${c.tag}` : ""}). Roll short ${formatRupee(c.rollShort, 0)}/lot.`));
        calcHost.hidden = true;
      } else {
        const isBox = s.kind === "lbox" || s.kind === "sbox";
        const annual = isBox ? s.rate : s.annual;
        const vs = isBox ? s.vsHurdleBp : annual === null ? null : annual * 1e4;
        put(retHost, "ret", JSON.stringify([s.breakEvenPts, s.capital, annual, vs, m.hRate, m.expiryDay]), () => [
          h("h4", {}, "Break-even and return"),
          kv([
            ["Break-even", `needs ${formatFixed(s.breakEvenPts, 2)} pts gross per unit`],
            ["Capital ≈", money(s.capital)],
            [isBox ? "Net rate %/yr" : "Net %/yr over hurdle", m.expiryDay ? `${DASH} (expiry day)` : h("span", { class: isBox ? (vs === null ? "" : vs >= 0 ? "ink-pos" : "ink-neg") : inkOf(annual === null ? null : annual * 100, 2) }, isBox ? pct(annual, 2) : pctSigned(annual, 2))],
            ["Hurdle", formatPercent(m.hRate * 100, 2)],
            [isBox ? "vs hurdle" : "Excess over hurdle", vs === null ? DASH : bpChip(vs)],
          ]),
          h("p", { class: "arb-d-fine" }, `Capital: ${s.capitalBasis}.${isBox ? "" : " Hedge benefit ignored (conservative)."}`),
        ]);
        calcHost.hidden = !isBox;
        if (isBox) {
          if (targetKey !== s.key) {
            targetKey = s.key;
            target.value = formatInput(m.hRate * 100, 2);
          }
          drawCalc();
        }
      }
      // Flags
      const flags = O.arbFlags(s, flagCtx(m, s, topQ));
      put(flagsHost, "flags", JSON.stringify(flags), () => flags.map((f) => h("li", { class: f.sev }, h("span", { class: "dot", "aria-hidden": "true" }), f.text)));
    }

    // The cost waterfall, drawn in HTML: label | track (floating bar + connector) | value. Rows are a <dl>.
    const wfToggle = segmented("Units", [["rs", "₹"], ["pts", "pts"]], wfUnit);
    wfToggle.classList.add("arb-wf-unit");
    wfToggle.addEventListener("change", () => {
      wfUnit = wfToggle.value;
      if (cur) drawWf(cur.s, false);
    });
    const wfTitle = h("h4", {});
    const wfDl = h("dl", { class: "arb-wfv" });
    const wfFine = h("p", { class: "arb-d-fine" });
    // One persistent toggle for the small fees: it survives the row rebuild, so focus stays on it both ways.
    const wfFees = h("button", { type: "button", class: "arb-wf-more arb-wf-fees", "aria-expanded": "false", hidden: true });
    wfFees.addEventListener("click", () => {
      wfOpen = !wfOpen;
      if (cur) drawWf(cur.s, false);
    });
    wfHost.append(h("div", { class: "arb-wf-head" }, wfTitle, wfToggle), wfDl, wfFees, wfFine);
    const wfRows = new Map(); // key -> { row, bar, conn, val }
    function wfLines(s) {
      if (s.kind === "cal") {
        const c = s.cal;
        // Whole rupees that add up to the shown roll cost; drawn as costs (paying a spread is negative).
        const parts = c.rollLong === null ? null : O.roundToSum([c.buyFar * c.lot, c.rollLong - c.buyFar * c.lot]);
        if (!parts) return { lines: [], net: null, per: c.lot, netLabel: "Roll cost", unitText: "per lot" };
        return { lines: [{ key: "spread", label: "Spread paid (far ask − near bid)", value: -parts.values[0], cost: true }, { key: "charges", label: "Charges", value: -parts.values[1], cost: true }], net: -parts.total, per: c.lot, netLabel: "Roll cost", unitText: "per lot", noGross: true };
      }
      const w = O.waterfall(s);
      const settle = s.charges.settle;
      let lines = w.lines.map((l, i) => ({ key: l.key, label: l.label.replace(" (incl. exercise)", ""), note: l.key === "exStt" && settle !== null ? `Estimated at a settlement of ${formatInt(settle)}` : l.label.includes("incl. exercise") ? "Includes brokerage on exercise" : "", value: l.shown, exact: l.value, gross: i === 0 }));
      // Small statutory fees (each under 2 % of the gross) fold into one line; a tap expands them.
      const gross = Math.abs(lines[0]?.value ?? 0);
      const small = lines.filter((l) => ["sebi", "stamp", "gst"].includes(l.key));
      const groupable = small.length > 1 && gross > 0 && small.every((l) => Math.abs(l.value) < 0.02 * gross);
      if (!wfOpen && groupable) {
        const at = lines.indexOf(small[0]);
        lines = lines.filter((l) => !small.includes(l));
        lines.splice(at, 0, { key: "small", label: "SEBI · Stamp · GST", value: small.reduce((a, l) => a + l.value, 0), exact: small.reduce((a, l) => a + l.exact, 0), group: true });
      }
      return { lines, net: w.netShown, exact: w.net, per: s.U, netLabel: "Net", unitText: `for ${formatInt(s.U)} units`, groupable };
    }
    function drawWf(s, grow) {
      const W = wfLines(s);
      const pts = wfUnit === "pts";
      const div = pts ? W.per || 1 : 1;
      // A roll shows its costs as positive amounts in both units; a gross-to-net waterfall is signed in both.
      const fmt = (v) => (v === null ? DASH : W.noGross ? (pts ? formatFixed(-v / div, 2) : formatRupee(-v, 0)) : pts ? formatSigned(v / div, 2) : rupeeSigned(v));
      wfFees.hidden = !W.groupable;
      wfFees.setAttribute("aria-expanded", String(wfOpen));
      const feesText = wfOpen ? "Group SEBI · Stamp · GST" : "Show SEBI · Stamp · GST";
      if (wfFees.textContent !== feesText) wfFees.textContent = feesText;
      wfTitle.replaceChildren(s.kind === "cal" ? "Roll a long " : "Costs: gross to net ", h("small", {}, pts ? `points ${W.unitText === "per lot" ? "per unit" : "per unit"}` : `₹ ${W.unitText}`));
      const steps = O.waterfallSteps(W.lines.map((l) => ({ key: l.key, value: l.value })));
      const lo = Math.min(steps.min, W.net ?? 0);
      const hi = Math.max(steps.max, W.net ?? 0);
      const span = hi - lo || 1;
      const x = (v) => (v - lo) / span;
      wfDl.style.setProperty("--z", String(Math.round(x(0) * 1000) / 1000));
      const keys = [...W.lines.map((l) => l.key), "net"];
      if (wfDl.__keys !== keys.join("|")) {
        wfDl.__keys = keys.join("|");
        wfRows.clear();
        wfDl.replaceChildren(
          ...keys.map((k) => {
            const bar = h("span", { class: `arb-wf-bar${k === "net" ? " net" : ""}` });
            const conn = h("i", { class: "arb-wf-conn" });
            const val = h("span", { class: "arb-wf-val" });
            const dt = h("dt", {});
            const row = h("div", { class: `arb-wf-row${k === "net" ? " net" : ""}` }, dt, h("dd", {}, h("span", { class: "arb-wf-track", "aria-hidden": "true" }, bar, conn), val));
            wfRows.set(k, { row, bar, conn, val, dt });
            return row;
          }),
        );
        grow = true;
      }
      W.lines.forEach((l, i) => {
        const r = wfRows.get(l.key);
        const st0 = steps.steps[i];
        const a = x(Math.min(st0.from, st0.to));
        const w = Math.abs(x(st0.to) - x(st0.from));
        r.dt.replaceChildren(
          l.group
            ? h("button", {
                type: "button",
                class: "arb-wf-more",
                "aria-expanded": "false",
                onclick: () => {
                  wfOpen = true;
                  drawWf(s, false);
                  wfFees.focus();
                },
              }, l.label, h("small", {}, " · show"))
            : l.label,
        );
        r.dt.title = l.note ?? "";
        r.bar.className = `arb-wf-bar ${l.gross ? (l.value >= 0 ? "gross pos" : "gross neg") : l.value > 0 ? "earn" : "cost"}`;
        r.bar.style.setProperty("--l", String(Math.round(a * 1000) / 1000));
        r.bar.style.setProperty("--w", String(Math.max(l.value ? 0.004 : 0, Math.round(w * 1000) / 1000)));
        r.bar.style.setProperty("--i", String(i));
        // The connector drops from this step's end to the next step's start.
        r.conn.hidden = i === W.lines.length - 1 && W.net === null;
        r.conn.style.left = `${Math.round(x(st0.to) * 1000) / 10}%`;
        r.val.className = `arb-wf-val ${l.gross ? inkOf(l.value) : ""}`;
        r.val.textContent = fmt(l.value);
        r.val.title = l.exact === undefined ? "" : formatRupee(l.exact, 2);
      });
      const n = wfRows.get("net");
      n.dt.textContent = `= ${W.netLabel}`;
      n.bar.className = `arb-wf-bar net ${W.net === null ? "" : W.net >= 0 ? "pos" : "neg"}`;
      n.bar.style.setProperty("--l", String(Math.round(x(Math.min(0, W.net ?? 0)) * 1000) / 1000));
      n.bar.style.setProperty("--w", String(Math.max(W.net ? 0.004 : 0, Math.round((Math.abs(W.net ?? 0) / span) * 1000) / 1000)));
      n.bar.style.setProperty("--i", String(W.lines.length));
      n.conn.hidden = true;
      n.val.className = `arb-wf-val ${W.noGross ? "" : inkOf(W.net)}`;
      setVal(n.val, fmt(W.net), W.net);
      n.val.title = W.exact === undefined ? "" : formatRupee(W.exact, 2);
      n.row.dataset.net = W.net === null ? "" : rupeeSigned(W.net);
      wfFine.textContent = s.kind === "cal" ? "" : "Whole rupees that add up to the net; hover a value for paise.";
      wfFine.hidden = !wfFine.textContent;
      if (grow && !reducedMotion()) {
        wfDl.classList.add("wf-grow");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            wfDl.classList.remove("wf-grow");
            wfDl.classList.add("wf-growing");
            setTimeout(() => wfDl.classList.remove("wf-growing"), 760);
          }),
        );
      }
    }

    // The locked payoff: a flat line at the net across settlement prices (a band when closed before expiry).
    const paySvg = svgEl("svg", { class: "arb-pay-svg", role: "img", height: "64" });
    const payCap = h("p", { class: "arb-pay-cap" });
    payHost.append(h("h4", {}, "Locked payoff"), paySvg, payCap);
    function drawPay(s, m) {
      const w = O.waterfall(s);
      const net = w.netShown;
      const F = s.charges.settle ?? m.fwd?.forward ?? m.spot;
      const close = cfg().hold === "close";
      const band = close ? Math.abs(s.charges.exitSpread ?? 0) : 0;
      const sig = JSON.stringify([net, F, band, Math.round(paySvg.getBoundingClientRect().width)]);
      if (paySvg.__sig === sig) return;
      paySvg.__sig = sig;
      const W = Math.max(200, Math.round(paySvg.getBoundingClientRect().width) || 300);
      const H = 64;
      paySvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const top = Math.max(0, net + band);
      const bot = Math.min(0, net - band);
      const pad = (top - bot || Math.abs(net) || 1) * 0.35;
      const y = (v) => 22 + ((top + pad - v) / (top - bot + 2 * pad)) * (H - 28);
      const kids = [svgEl("line", { class: "dv-zero", x1: 0, x2: W, y1: y(0), y2: y(0) }), svgEl("text", { class: "dv-tick", x: 2, y: y(0) - 3 }, "₹0")];
      if (band) kids.push(svgEl("rect", { class: "arb-pay-band", x: 0, width: W, y: y(net + band), height: Math.max(2, y(net - band) - y(net + band)) }));
      kids.push(svgEl("line", { class: `arb-pay-line ${net >= 0 ? "pos" : "neg"}`, x1: 0, x2: W, y1: y(net), y2: y(net) }));
      kids.push(svgEl("line", { class: "arb-pay-f", x1: W / 2, x2: W / 2, y1: 20, y2: H - 2 }));
      paySvg.replaceChildren(...kids);
      if (F) spotPill(paySvg, W / 2, `F ${formatInt(F)}`, { y: 0, width: W });
      paySvg.setAttribute("aria-label", `Locked payoff: ${rupeeSigned(net)} at every settlement price from ${formatInt(F * 0.97)} to ${formatInt(F * 1.03)}`);
      payCap.className = `arb-pay-cap ${inkOf(net)}`;
      payCap.textContent = close ? `About ${rupeeSigned(net)} if closed at today's spreads (band: ±${formatRupee(band, 0)} exit spread)` : `Flat: ${rupeeSigned(net)} at every settlement price · held to expiry (cash-settled)`;
    }
    return { el, update, focus: () => title.focus(), titleText: () => title.textContent };
  }
  const kv = (pairs) => h("dl", { class: "arb-kvs" }, pairs.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  function legName(l, m) {
    if (l.kind === "FUT") return `${m.c.underlying} ${dayMon(l.expiry ?? m.c.expiry)} FUT`;
    return `${m.c.underlying} ${dayMon(m.c.expiry)} ${formatInt(l.strike)} ${l.right}`;
  }
  function futDetail(f, m) {
    const ch = f.cheaper;
    const ex = extra.get(f.expiry);
    return h(
      "div",
      {},
      kv([
        ["Bid · ask", f.twoSided ? `${formatFixed(f.bid, 2)} · ${formatFixed(f.ask, 2)}` : DASH],
        ["Basis", `${formatSigned(f.basis, 2)} pts (${formatPercent(f.basisPct, 2)})`],
        f.days === null || f.days < 1 || f.carry === null ? ["Carry", h("span", { title: "Annualised figures are not meaningful on expiry day" }, DASH)] : ["Carry", `${pct(f.carry, 2)}/yr (${f.carryVsBp === null ? DASH : `${formatSigned(f.carryVsBp, 0)} bp vs hurdle`})`],
        ["Options forward", f.fwd ? `${formatFixed(f.fwd.forward, 2)} (fut ${formatSigned(f.fwdGap, 2)} pts${f.fwdTag ? `, ${f.fwdTag}` : ""})` : DASH],
        ["Cheaper long", ch ? `${ch.long.pick === "future" ? "Future" : "Synthetic"} by ${formatFixed(ch.long.diffPts, 2)} pts · ${formatRupee(ch.long.diffPerLot, 0)}/lot` : DASH],
        ["Cheaper short", ch ? `${ch.short.pick === "future" ? "Future" : "Synthetic"} by ${formatFixed(ch.short.diffPts, 2)} pts · ${formatRupee(ch.short.diffPerLot, 0)}/lot` : DASH],
      ]),
      h("p", { class: "arb-d-fine" }, `Synthetic at the ATM-forward strike${ch ? ` ${formatInt(ch.strike)}` : ""}, after entry charges and exercise STT. ${f.expiry === m.c.expiry ? "This expiry's chain." : ex?.at ? `Options forward updated ${formatInt((Date.now() - ex.at) / 1000)} s ago.` : "Options forward loads every 15 s on this tab."} Cash-and-carry needs a tradable underlying (stock or ETF): LATER.`),
    );
  }
  /** The option expiry to offer instead: the first later one with a listed future, else any listed one with a future. */
  function futureExpiry(m) {
    const listed = st.futures.map((f) => f.expiry).filter((e) => st.expiries.includes(e));
    return listed.find((e) => e >= m.c.expiry) ?? listed[listed.length - 1] ?? null;
  }
  function flagCtx(m, s, topQ) {
    const freeze = new Map((s.legs ?? []).map((l) => [l.symbol, freezeOf(l)]));
    return { stale: m.stale, ageMs: m.fresh.ageMs, days: m.days, hold: cfg().hold, noFuture: m.noFuture, lotMismatch: s.kind === "cal" ? Boolean(s.cal?.lotMismatch) : m.par.lotMismatch && s.kind !== "lbox" && s.kind !== "sbox", topQty: topQ, freezeQty: freeze, nowMs: m.nowMs, demo: ctx.demo(), session: refSession(st.ref) };
  }
  function freezeOf(l) {
    if (l.kind === "FUT") return num(st.futures.find((f) => f.symbol === l.symbol)?.freezeQty);
    return num(optFreeze.get(st.underlying));
  }
  function topQtyMap(s) {
    const out = new Map();
    for (const l of s.legs ?? []) {
      const d = depth.get(l.symbol);
      out.set(l.symbol, d ? (l.side === "BUY" ? d.ask : d.bid) : null);
    }
    return out;
  }
  function copyLegs(s) {
    if (!s?.legs?.length) return toast("Nothing to copy for this row", { tone: "info" });
    const lines = O.sendOrder(s.legs).map((l) => `${l.side} ${l.symbol} ${formatInt(l.units)} @ ${formatFixed(l.price, 2)}`);
    const sum = s.kind === "cal" ? `${KIND_NAME.cal} roll long ${formatRupee(s.cal.rollLong, 0)}/lot` : `${KIND_NAME[s.kind]} net ${rupeeSigned(s.net)} after charges${s.kind === "lbox" || s.kind === "sbox" ? ` · ${pct(s.rate, 2)}/yr` : ""}`;
    copyText([...lines, sum].join("\n"), "Legs copied");
  }

  // ── Bottom sheet (tablets and phones) ──
  function openSheet() {
    if (!last) return;
    const item = itemOf(sel) ?? bestItem();
    if (!item) return;
    sel = item.key;
    // The structure title is the sheet's own heading (no generic "Structure" above it); it follows the detail.
    const d = createDetail({
      onTitle: (t) => {
        const el = sheet ? document.getElementById("dialog-title") : null;
        if (el && el.textContent !== t) el.textContent = t;
      },
    });
    d.el.classList.add("in-sheet");
    const opener = cardEls.get(item.key) ?? rowEls.get(item.key)?.tr ?? null;
    d.update(item, last);
    sheet = { detail: d };
    modal({ title: d.titleText(), body: d.el, buttons: [] }).then(() => {
      sheet = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
    requestAnimationFrame(() => d.update(itemOf(sel) ?? item, last));
  }

  // ── Order preview, then place (safety gates unchanged: every leg previewed, then POST /v1/orders) ──
  async function openOrders(s, m) {
    const a = ctx.account();
    if (!a) return toast("Choose an account that can place orders first.", { tone: "warn" });
    if (!s?.legs?.length) return;
    // Freeze quantity for the option legs (one call per underlying), before slicing.
    await loadOptFreeze(s.legs.find((l) => l.kind !== "FUT")?.symbol);
    const legs = O.sendOrder(s.legs);
    const items = legs.flatMap((l) =>
      O.freezeSlices(l.units, freezeOf(l), s.lot).map((q, i, all) => ({ leg: l, qty: q, slice: i + 1, slices: all.length, price: O.roundToTick(l.price, l.tick || 0.05, l.side === "BUY" ? "buy" : "sell"), preview: null, status: "queued", error: null })),
    );
    const modeSeg = a.liveAllowedByConfig ? segmented("Mode", [["paper", "Paper"], ["live", "Live"]], "paper") : null;
    const ack = h("input", { type: "checkbox" });
    const ackRow = h("label", { class: "check live-ack", hidden: true }, ack, `I understand these are real orders to ${a.label}.`);
    const isLive = () => modeSeg?.value === "live";
    const body = (it, extraFields = {}) => ({ account: a.id, symbol: it.leg.symbol, side: it.leg.side, quantity: it.qty, product: "MARGIN", orderType: "LIMIT", price: it.price, ...(isLive() ? { mode: "live" } : {}), ...extraFields });
    const listHost = h("div", { class: "table-wrap arb-pv-wrap" });
    const blockHost = h("div", {});
    const resultHost = h("div", { class: "arb-pv-result", role: "status" });
    let phase = "confirm";
    let placeBtn = null;
    const STATUS = { queued: "Queued", sending: "Sending", sent: "Sent", failed: "Not sent", skipped: "Not sent" };
    function drawList() {
      listHost.replaceChildren(
        h(
          "table",
          { class: "desk-table arb-pv" },
          h("thead", {}, h("tr", {}, ["#", "Leg", "Qty", "Limit", "Checks"].map((t, i) => h("th", { scope: "col", class: i === 2 || i === 3 ? "num" : undefined }, t)))),
          h(
            "tbody",
            {},
            items.map((it, i) =>
              h(
                "tr",
                { class: `st-${it.status}` },
                h("td", { class: "num" }, formatInt(i + 1)),
                h("td", {}, h("span", { class: "pos-leg" }, h("span", { class: `side-tag ${it.leg.side === "BUY" ? "buy" : "sell"}` }, it.leg.side === "BUY" ? "B" : "S"), h("span", {}, h("strong", { title: legName(it.leg, m) }, it.leg.kind === "FUT" ? `FUT ${dayMon(it.leg.expiry ?? m.c.expiry)}` : `${formatInt(it.leg.strike)} ${it.leg.right}`), h("small", {}, it.slices > 1 ? `slice ${formatInt(it.slice)} of ${formatInt(it.slices)}` : it.leg.kind === "FUT" ? "future last" : i === 0 ? "least liquid first" : "option leg")))),
                h("td", { class: "num" }, formatInt(it.qty)),
                h("td", { class: "num" }, formatFixed(it.price, 2)),
                h(
                  "td",
                  {},
                  phase === "confirm"
                    ? it.preview
                      ? h("span", { class: `pv-dot ${it.preview.block ? "bad" : it.preview.warn ? "warn" : "ok"}`, "aria-label": it.preview.block ? `Blocked: ${it.preview.text}` : it.preview.text || "Checks passed", title: it.preview.text || "Checks passed" })
                      : h("span", { class: "pv-dot wait", "aria-label": "Checking" })
                    : h("span", { class: `st-chip ${it.status === "sent" ? "filled" : it.status === "failed" ? "rejected" : "queued"}` }, STATUS[it.status] ?? it.status),
                  it.preview?.block && phase === "confirm" ? h("small", { class: "block bad-text" }, "Blocked") : it.error ? h("small", { class: "block bad-text" }, ungroup(it.error)) : null,
                ),
              ),
            ),
          ),
        ),
      );
      const blocks = items.filter((it) => it.preview?.block);
      blockHost.replaceChildren(
        ...(blocks.length
          ? [
              h(
                "div",
                { class: "alert bad", role: "alert" },
                icon("warn"),
                h(
                  "div",
                  {},
                  h("strong", {}, "Nothing can be sent: a leg is blocked."),
                  h("span", { class: "detail" }, blocks.map((b) => `${legName(b.leg, m)}: ${b.preview.text}`).join(" · ")),
                  blocks.some((b) => /per-order limit/i.test(b.preview.text)) ? h("span", { class: "detail" }, "The per-order value limit is set on the Safety page. Sending the other legs alone would leave an unhedged position.") : null,
                  blocks.some((b) => /limit/i.test(b.preview.text)) ? h("button", { type: "button", class: "small arb-pv-safety", onclick: openSafety }, icon("safety"), "Open Safety") : null,
                ),
              ),
            ]
          : []),
      );
      drawPlace();
    }
    function drawPlace() {
      if (!placeBtn) return;
      const blocked = items.some((it) => it.preview?.block) || items.some((it) => !it.preview) || items.some((it) => !isFigure(it.price) || it.price <= 0);
      placeBtn.textContent = phase === "confirm" ? `Place ${formatInt(items.length)} order${items.length === 1 ? "" : "s"}${isLive() ? " · LIVE" : ""}` : "Done";
      placeBtn.className = "primary";
      placeBtn.disabled = phase === "running" || (phase === "confirm" && (blocked || (isLive() && !ack.checked)));
    }
    // Each run has a generation: a mode change starts a new run, and an older run's answers (asked in the old mode)
    // are dropped, so "every leg previewed in this mode" holds before Place is enabled.
    let gen = 0;
    async function previewAll() {
      const my = ++gen;
      let i = 0;
      const worker = async () => {
        while (i < items.length && my === gen) {
          const it = items[i++];
          if (!it.leg.symbol || !isFigure(it.price)) {
            it.preview = { block: true, text: it.leg.symbol ? "No limit price" : "Contract not found" };
            continue;
          }
          const r = await optional(api("/v1/orders/preview", { method: "POST", body: body(it) }));
          if (my !== gen) return;
          if (r.error) it.preview = { block: true, text: ungroup(r.error.message) };
          else {
            const checks = r.data?.data?.checks ?? [];
            const b = checks.find((c) => c.severity === "block");
            const w = checks.find((c) => c.severity !== "block");
            it.preview = { block: Boolean(b), warn: Boolean(w), text: ungroup((b ?? w)?.message ?? "") };
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (my === gen && phase === "confirm") drawList();
    }
    function openSafety() {
      if (phase === "running") return;
      document.querySelector("#dialog .sheet-close")?.click();
      location.hash = "#/safety";
    }
    const modeRow = modeSeg ? h("div", { class: "field seg-field" }, h("span", {}, "Mode"), modeSeg) : h("p", { class: "arb-pv-mode" }, h("span", { class: "pill" }, "Paper"), ` ${a.label}`);
    modeSeg?.addEventListener("change", () => {
      ackRow.hidden = !isLive();
      for (const it of items) it.preview = null;
      drawList();
      previewAll();
    });
    ack.addEventListener("change", drawPlace);
    const warn = h("p", { class: "arb-pv-warn" }, icon("warn"), h("span", {}, "LIMIT orders at today's touch. Legs are separate orders, not an atomic spread. If a later leg does not fill, the earlier ones are an unhedged position."));
    const name = s.kind === "cal" ? `Calendar ${mon(s.cal.from)} → ${mon(s.cal.to)}` : s.kind === "lbox" || s.kind === "sbox" ? `${KIND_NAME[s.kind]} ${formatInt(s.k1)} / ${formatInt(s.k2)}` : `${KIND_NAME[s.kind]} ${formatInt(s.strike)}`;
    const done = modal({
      title: `Preview · ${name}`,
      body: h("div", { class: "stack arb-preview" }, modeRow, ackRow, warn, listHost, blockHost, resultHost),
      canClose: () => phase !== "running",
      buttons: [
        { label: "Cancel", cls: "plain", value: false },
        {
          label: "Place",
          cls: "primary",
          ref: (el) => (placeBtn = el),
          onClick: async () => {
            if (phase === "done") return "done";
            phase = "running";
            for (const it of items) it.status = "queued";
            drawList();
            const res = await ctx.sendOrders(items.map((it) => body(it)), {
              onStatus: (i, status, error) => {
                items[i].status = status;
                items[i].error = error ?? null;
                drawList();
              },
            });
            phase = "done";
            for (const [i, it] of items.entries()) if (it.status === "queued" && res.failed && i > res.failed.index) it.status = "skipped";
            drawList();
            if (res.failed) {
              const sent = items.filter((it) => it.status === "sent");
              resultHost.replaceChildren(
                h(
                  "div",
                  { class: "alert bad", role: "alert" },
                  icon("warn"),
                  h(
                    "div",
                    {},
                    h("strong", {}, `Stopped at order ${formatInt(res.failed.index + 1)}: ${ungroup(res.failed.error)}`),
                    sent.length ? h("span", { class: "detail" }, `Open risk: you are now ${sent.map((it) => `${it.leg.side === "BUY" ? "long" : "short"} ${legName(it.leg, m)} (${formatInt(it.qty)})`).join(", ")} without the hedge.`) : h("span", { class: "detail" }, "Nothing was sent."),
                  ),
                ),
                sent.length ? h("button", { type: "button", class: "small", onclick: () => ctx.onPositions() }, "Open Positions") : "",
              );
            } else {
              resultHost.replaceChildren(h("p", { class: "ok-ink" }, `${formatInt(items.length)} order${items.length === 1 ? "" : "s"} sent${isLive() ? " · LIVE" : " · paper"}. Check fills in Orders.`));
              toast(`${name}: ${formatInt(items.length)} orders sent`);
            }
            drawPlace();
            return false;
          },
        },
      ],
    });
    drawList();
    previewAll();
    await done;
  }
  async function loadOptFreeze(symbol) {
    if (!symbol || optFreeze.has(st.underlying)) return;
    const u = st.underlying;
    const r = await optional(api(`/v1/instruments/${encodeURIComponent(symbol)}`));
    const f = num(r.data?.data?.freezeQty);
    if (f !== null) optFreeze.set(u, f);
  }

  // ── Settings: the Costs & filters popover (a bottom sheet on phones) ──
  function settingsBody(render) {
    const c = cfg();
    const numField = (label, value, { step = "1", min, max, hint, onSet, wide = false }) => {
      const i = h("input", { type: "number", inputmode: "decimal", step, min, max, value: String(value), "aria-label": label });
      i.addEventListener("change", () => {
        const v = Number(i.value);
        if (i.value === "" || !Number.isFinite(v) || (min !== undefined && v < Number(min)) || (max !== undefined && v > Number(max))) return render();
        onSet(v);
        render();
      });
      return h("label", { class: `arb-field${wide ? " wide" : ""}` }, h("span", {}, label, hint ? h("small", {}, hint) : null), i);
    };
    const seg = (label, opts, value, onPick) => {
      const sg = segmented(label, opts, value);
      sg.addEventListener("change", () => {
        onPick(sg.value);
        render();
      });
      return sg;
    };
    const sw = (label, get, set, hint) => {
      const input = h("input", { type: "checkbox", role: "switch" });
      input.checked = get();
      input.addEventListener("change", () => {
        set(input.checked);
        render();
      });
      return h("label", { class: "sw-row" }, h("span", { class: "sw-text" }, label, hint ? h("small", {}, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
    };
    const p = c.profile;
    const setP = (patch) => setCfg({ profile: { ...cfg().profile, ...patch } });
    const model = O.BROKERAGE_MODELS.find((x) => x[0] === p.brokerage);
    const brokerSel = h("select", { "aria-label": "Brokerage model" }, O.BROKERAGE_MODELS.map(([id, label]) => h("option", { value: id, selected: id === p.brokerage }, label)));
    brokerSel.addEventListener("change", () => {
      setP({ brokerage: brokerSel.value });
      render();
    });
    const brokerFields = [];
    if (p.brokerage === "flat") brokerFields.push(numField("₹ per order", p.value ?? refCharges(st.ref).brokeragePerOrder, { step: "1", min: "0", onSet: (v) => setP({ value: v }) }), numField("Futures cap, % of turnover", formatFixed(p.futPct * 100, 3), { step: "0.005", min: "0", max: "5", onSet: (v) => setP({ futPct: v / 100 }) }));
    if (p.brokerage === "perLot") brokerFields.push(numField("₹ per lot", p.value ?? refCharges(st.ref).brokeragePerOrder, { step: "1", min: "0", onSet: (v) => setP({ value: v }) }));
    if (p.brokerage === "pct") brokerFields.push(numField("% of turnover", formatFixed(p.pct * 100, 3), { step: "0.005", min: "0", max: "5", onSet: (v) => setP({ pct: v / 100 }) }), numField("Cap, ₹ per order", p.cap, { step: "1", min: "0", onSet: (v) => setP({ cap: v }) }));
    const rateRows = O.RATE_FIELDS.map(([path, label, unit]) => {
      const cur = c.rates[path] ?? O.rateDefault(path, refCharges(st.ref));
      const changed = c.rates[path] !== undefined;
      return numField(`${label}${unit === "pct" ? ", %" : ""}`, unit === "pct" ? formatFixed(cur * 100, 5).replace(/0+$/, "").replace(/\.$/, "") : formatFixed(cur, 2), {
        step: "any",
        min: "0",
        hint: changed ? "edited" : undefined,
        onSet: (v) => setCfg({ rates: { ...cfg().rates, [path]: unit === "pct" ? v / 100 : v } }),
      });
    });
    const sections = [];
    if (narrow()) {
      sections.push(
        h("section", {}, h("h3", {}, "Hold"), seg("Hold", [["expiry", "To expiry"], ["close", "Close before"]], c.hold, (v) => setCfg({ hold: v }))),
        h("section", {}, sw("Opportunities only", () => cfg().onlyOpps, (v) => setCfg({ onlyOpps: v }), "Rows that clear your minimum net, liquidity and freshness")),
      );
    }
    sections.push(
      h("section", {}, h("h3", {}, "Hurdle"), numField("Hurdle rate %/yr", formatFixed(c.hurdle, 2), { step: "0.05", min: "0", max: "50", hint: "Your cost of money or alternative yield: 91-day T-bill, FD or MIBOR. Simple ACT/365.", onSet: (v) => setCfg({ hurdle: v }), wide: true })),
      h(
        "section",
        {},
        h("h3", {}, "Brokerage"),
        h("label", { class: "arb-field wide" }, h("span", {}, "Model", h("small", {}, model?.[2] ?? "")), brokerSel),
        h("div", { class: "arb-fields" }, brokerFields),
        sw("Charge brokerage on exercise / assignment", () => cfg().profile.exerciseBrokerage, (v) => setP({ exerciseBrokerage: v }), "Conservative: one order's brokerage per option leg settled ITM"),
      ),
      h(
        "section",
        {},
        h(
          "details",
          { class: "arb-rates", open: Object.keys(c.rates).length > 0 },
          h("summary", {}, h("strong", {}, "Statutory rates"), h("small", {}, " · rates as of 1 Apr 2026; verify")),
          h("div", { class: "arb-fields" }, rateRows),
          h("button", { type: "button", class: "small plain reset", onclick: () => (setCfg({ rates: {} }), render()) }, icon("refresh"), "Reset to defaults"),
        ),
      ),
      h("section", {}, h("h3", {}, "Capital"), numField("Futures margin estimate %", formatFixed(c.futMarginPct, 1), { step: "0.5", min: "0", max: "100", hint: "Est.; hedge benefit ignored (conservative)", onSet: (v) => setCfg({ futMarginPct: v }), wide: true })),
      h(
        "section",
        {},
        h("h3", {}, "Filters"),
        h(
          "div",
          { class: "arb-fields" },
          numField("Minimum net ₹", formatInt(c.minNet), { step: "10", onSet: (v) => setCfg({ minNet: v }) }),
          numField("Minimum box vs hurdle, bp", formatInt(c.minBoxBp), { step: "5", onSet: (v) => setCfg({ minBoxBp: v }) }),
          numField("Minimum liquidity 0-5", formatInt(c.minLiq), { step: "1", min: "0", max: "5", onSet: (v) => setCfg({ minLiq: v }) }),
          numField("Box max width, strike steps", formatInt(c.boxMaxSteps), { step: "1", min: "1", max: "40", onSet: (v) => setCfg({ boxMaxSteps: v }) }),
        ),
        h("div", { class: "arb-seg-row" }, h("span", {}, "Stale after"), seg("Stale after", [["2", "2 s"], ["5", "5 s"], ["10", "10 s"], ["30", "30 s"]], String(c.staleSec), (v) => setCfg({ staleSec: Number(v) }))),
        h("div", { class: "arb-seg-row" }, h("span", {}, "Strikes ATM ±"), seg("Strikes ATM ±", [["5", "5"], ["10", "10"], ["20", "20"]], String(c.window), (v) => setCfg({ window: Number(v) }))),
      ),
    );
    if (!phone()) sections.push(h("section", {}, h("h3", {}, "Parity columns ", h("small", {}, narrow() ? "wide screens · drag or ↑ ↓ to reorder" : "drag or ↑ ↓ to reorder")), columnList(render)));
    return sections;
  }
  /** The parity column chooser: checkbox, drag handle and ↑/↓ (the chain Customise list pattern). */
  function columnList(render) {
    const on = cfg().cols;
    const off = O.ARB_PARITY_COLUMNS.map((c) => c[0]).filter((k) => !on.includes(k));
    const label = (k) => O.ARB_PARITY_COLUMNS.find((c) => c[0] === k)?.[1] ?? k;
    const locked = (k) => O.ARB_LOCKED_COLUMNS.includes(k);
    const move = (k, d) => {
      const a = [...on];
      const i = a.indexOf(k);
      const j = i + d;
      if (j < 1 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
      setCfg({ cols: a });
      render();
      document.querySelector(`.arb-pop [data-col="${k}"] [data-dir="${d}"]`)?.focus();
    };
    const row = (k, isOn) => {
      const box = h("input", { type: "checkbox", checked: isOn, disabled: locked(k) });
      box.addEventListener("change", () => {
        setCfg({ cols: isOn ? on.filter((x) => x !== k) : [...on, k] });
        render();
      });
      return h(
        "div",
        { class: `col-row ${isOn ? "on" : ""}`.trim(), draggable: isOn && k !== "strike" ? "true" : undefined, "data-col": k },
        isOn && k !== "strike" ? h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")) : h("span", { class: "grip" }),
        h("label", { class: "col-check" }, box, h("span", {}, label(k), locked(k) ? h("small", { class: "col-scope" }, " always") : null)),
        isOn && k !== "strike"
          ? h(
              "span",
              { class: "col-move" },
              h("button", { type: "button", class: "icon-btn tiny", "data-dir": "-1", "aria-label": `Move ${label(k)} left`, disabled: on.indexOf(k) <= 1, onclick: () => move(k, -1) }, icon("up")),
              h("button", { type: "button", class: "icon-btn tiny", "data-dir": "1", "aria-label": `Move ${label(k)} right`, disabled: on.indexOf(k) === on.length - 1, onclick: () => move(k, 1) }, icon("down")),
            )
          : null,
      );
    };
    const listEl = h("div", { class: "col-list" }, on.map((k) => row(k, true)), off.map((k) => row(k, false)));
    let dragKey = null;
    listEl.addEventListener("dragstart", (e) => {
      const r = e.target.closest(".col-row.on");
      if (!r) return;
      dragKey = r.dataset.col;
      r.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragKey);
    });
    listEl.addEventListener("dragover", (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const over = e.target.closest(".col-row.on");
      const from = listEl.querySelector(".dragging");
      if (!over || !from || over === from || over.dataset.col === "strike") return;
      const r = over.getBoundingClientRect();
      listEl.insertBefore(from, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
    });
    listEl.addEventListener("dragend", () => {
      if (!dragKey) return;
      dragKey = null;
      setCfg({ cols: [...listEl.querySelectorAll(".col-row.on")].map((r) => r.dataset.col) });
      render();
    });
    return h("div", {}, listEl, h("button", { type: "button", class: "small plain reset", onclick: () => (setCfg({ cols: [...O.ARB_DEFAULTS.cols] }), render()) }, icon("refresh"), "Reset columns"));
  }
  function openSettings() {
    if (closePop) return closePop();
    if (phone()) {
      const host = h("div", { class: "pop-body arb-pop arb-sheet-body" });
      const render = () => host.replaceChildren(...settingsBody(render));
      render();
      closePop = () => document.querySelector("#dialog .sheet-close")?.click();
      modal({ title: "Filters and costs", body: host, buttons: [{ label: "Done", cls: "primary", value: true }] }).then(() => {
        closePop = null;
        filtersBtn.focus();
      });
      return;
    }
    const bodyEl = h("div", { class: "pop-body" });
    const scrollKeep = () => bodyEl.scrollTop;
    const render = () => {
      const top = scrollKeep();
      bodyEl.replaceChildren(...settingsBody(render));
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
      if (refocus && gearBtn.isConnected) gearBtn.focus();
    };
    const outside = (e) => !pop.contains(e.target) && !gearBtn.contains(e.target) && close();
    const esc = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    const pop = h(
      "div",
      { class: "popover customise arb-pop vol-pop-float", role: "dialog", "aria-label": "Costs and filters" },
      h(
        "div",
        { class: "pop-head" },
        h("strong", {}, "Costs & filters"),
        h("button", { type: "button", class: "small plain reset", title: "Back to the default costs and filters (lots, tab and columns stay)", onclick: () => { st.arb = O.arbConfig({ tab: cfg().tab, lots: cfg().lots, hold: cfg().hold, onlyOpps: cfg().onlyOpps, boxMode: cfg().boxMode, sort: cfg().sort, cols: cfg().cols, notesOpen: cfg().notesOpen }); setCfg({}); render(); } }, icon("refresh"), "Reset"),
        h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close", onclick: () => close() }, icon("close")),
      ),
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

  // ── Draw: the rates ladder ──
  function drawLadder(m) {
    // Not laid out yet (first paint, a hidden page): draw on the next frame with the real width.
    if (!ladderPlot.clientWidth) return requestAnimationFrame(() => last && ladderPlot.clientWidth && drawLadder(last));
    const W = Math.round(ladderPlot.clientWidth);
    const H = phone() ? 52 : 60;
    const base = Math.round(H * 0.55);
    const hurdle = m.hRate;
    const lend = m.lendBoxes.find((b) => !b.crossed && b.rate !== null) ?? null;
    const borrow = m.borrowBoxes.find((b) => !b.crossed && b.rate !== null) ?? null;
    const carry = m.expiryDay ? null : (m.carryFut?.carry ?? null);
    const marks = [
      { id: "hurdle", v: hurdle, label: `Hurdle ${formatPercent(hurdle * 100, 2)}`, title: "Your hurdle: the cost of money or alternative yield (Costs & filters)" },
      carry === null ? null : { id: "carry", v: carry, label: `Carry ${pct(carry, 2)}`, ink: "ink-iv", shape: "diamond", title: `Futures carry = (Fm/S − 1)·365/d, ${dayMon(m.carryFut.expiry)} future, ${formatInt(m.carryFut.days)} days` },
      m.optRate === null || m.expiryDay ? null : { id: "opt", v: m.optRate, label: `Options ${pct(m.optRate, 2)}`, ink: "ink-iv", shape: "ring", title: "Options-implied rate: the rate the near-the-money box mids price in" },
      !lend || m.expiryDay ? null : { id: "lend", v: lend.rate, label: `Lend box ${pct(lend.rate, 2)}`, ink: lend.rate >= hurdle ? "ink-pos" : "ink-neg", shape: "sq", tone: lend.rate >= hurdle ? "pos" : "neg", go: () => goTo("boxes", lend.key, { boxMode: "lend" }), title: `Best long box (lend) net of charges: ${formatInt(lend.k1)} / ${formatInt(lend.k2)}. Click to select` },
      !borrow || m.expiryDay ? null : { id: "borrow", v: borrow.rate, label: `Borrow box ${pct(borrow.rate, 2)}`, ink: borrow.rate <= hurdle ? "ink-pos" : "ink-neg", shape: "sqo", tone: borrow.rate <= hurdle ? "pos" : "neg", go: () => goTo("boxes", borrow.key, { boxMode: "borrow" }), title: `Best short box (borrow) net of charges: ${formatInt(borrow.k1)} / ${formatInt(borrow.k2)}. Click to select` },
    ].filter(Boolean);
    const vals = marks.map((k) => k.v);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const span = Math.max(hi - lo, 0.02);
    lo = Math.max(-0.2, lo - span * 0.1);
    hi = Math.min(0.3, hi + span * 0.1);
    if (hi - lo < 0.01) hi = lo + 0.01;
    const padX = 14;
    const xOf = (v) => padX + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - 2 * padX);
    ladderSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    ladderSvg.setAttribute("height", String(H));
    if (!ladderSvg.__base) {
      ladderSvg.__base = svgEl("line", { class: "arb-l-base" });
      ladderSvg.__ticks = svgEl("g", { class: "arb-l-ticks" });
      ladderSvg.append(ladderSvg.__base, ladderSvg.__ticks);
    }
    ladderSvg.__base.setAttribute("x1", String(padX));
    ladderSvg.__base.setAttribute("x2", String(W - padX));
    ladderSvg.__base.setAttribute("y1", String(base));
    ladderSvg.__base.setAttribute("y2", String(base));
    const ticks = O.niceTicks(lo * 100, hi * 100, W < 500 ? 3 : 5).filter((t) => t >= lo * 100 - 1e-9 && t <= hi * 100 + 1e-9);
    // Labels: above the axis, or below when two marks are closer than their labels (greedy, left to right).
    const placed = marks.map((k) => ({ ...k, x: xOf(k.v), out: k.v < lo ? "◂ " : k.v > hi ? " ▸" : "" })).sort((a, b) => a.x - b.x);
    // Measured widths (not a character guess): a hidden text of the same class, laid out in the same SVG.
    if (!ladderSvg.__meas) {
      const t = svgEl("text", { class: "arb-l-label" });
      const pt = svgEl("text", {});
      const pg = svgEl("g", { class: "dv-pill arb-l-pill" }, pt);
      const mg = svgEl("g", { class: "arb-l-meas", "aria-hidden": "true", visibility: "hidden" }, t, pg);
      ladderSvg.append(mg);
      ladderSvg.__meas = { t, pt };
    }
    const measure = (text, pill) => {
      const el = pill ? ladderSvg.__meas.pt : ladderSvg.__meas.t;
      el.textContent = text;
      let w = 0;
      try {
        w = el.getComputedTextLength();
      } catch {
        w = 0;
      }
      return (w > 0 ? w : text.length * 7) + (pill ? 16 : 0);
    };
    // Shorter forms tried in turn when a label cannot fit; the last resort is no text (the value stays in the tooltip).
    const SHORT = { hurdle: "H", carry: "Carry", opt: "Opt", lend: "Lend", borrow: "Borrow" };
    const GAP = 6;
    const lastEnd = { a: -Infinity, b: -Infinity };
    for (const k of placed) {
      const arrow = (t) => (k.out === "◂ " ? `◂ ${t}` : k.out ? `${t} ▸` : t);
      const val = k.label.slice(k.label.lastIndexOf(" ") + 1);
      const forms = [k.label, `${SHORT[k.id]} ${val}`, val].filter((t, i, a) => a.indexOf(t) === i).map(arrow);
      k.row = null;
      for (const text of forms) {
        const w = measure(text, k.id === "hurdle");
        const ideal = Math.max(w / 2, Math.min(W - w / 2, k.x));
        for (const row of ["a", "b"]) {
          // At the ideal spot, or nudged right of the row's last label: never back onto it, never past the edge.
          const lx = ideal - w / 2 >= lastEnd[row] + GAP ? ideal : lastEnd[row] + GAP + w / 2;
          if (lx + w / 2 > W + 0.5 || Math.abs(lx - k.x) > Math.max(60, w)) continue;
          k.text = text;
          k.w = w;
          k.lx = lx;
          k.row = row;
          break;
        }
        if (k.row) break;
      }
      if (!k.row) {
        k.text = "";
        k.w = 0;
        k.lx = k.x;
        k.row = "a";
        continue;
      }
      lastEnd[k.row] = k.lx + k.w / 2;
    }
    const tickLabels = ticks.map((t) => ({ x: xOf(t / 100), t })).filter((tk) => !placed.some((k) => k.row === "b" && Math.abs(k.lx - tk.x) < k.w / 2 + 14));
    const tdp = tickDp(ticks);
    ladderSvg.__ticks.replaceChildren(...tickLabels.flatMap((tk) => [svgEl("line", { class: "dv-grid arb-l-tick", x1: tk.x, x2: tk.x, y1: base - 3, y2: base + 3 }), svgEl("text", { class: "dv-tick", x: tk.x, y: H - 3, "text-anchor": "middle" }, `${formatFixed(tk.t, tdp)}%`)]));
    const seen = new Set();
    for (const k of placed) {
      seen.add(k.id);
      let e = ladderMarks.get(k.id);
      if (!e) {
        const g = svgEl("g", { class: `arb-l-mark ${k.id}`, tabindex: k.go ? "0" : undefined, role: k.go ? "button" : undefined });
        if (k.id === "hurdle") g.append(svgEl("line", { class: "arb-l-hurdle", x1: 0, x2: 0, y1: -base + 18, y2: H - base - 14 }));
        else if (k.shape === "diamond") g.append(svgEl("rect", { class: "arb-l-shape", x: -4.5, y: -4.5, width: 9, height: 9, transform: "rotate(45)" }));
        else if (k.shape === "ring") g.append(svgEl("circle", { class: "arb-l-shape", r: 4.5 }));
        else g.append(svgEl("rect", { class: "arb-l-shape", x: -5, y: -5, width: 10, height: 10, rx: 1.5 }));
        const label = k.id === "hurdle" ? svgEl("g", { class: "dv-pill arb-l-pill" }, svgEl("rect", { rx: 9, ry: 9, height: 18 }), svgEl("text", { "text-anchor": "middle", "dominant-baseline": "central" })) : svgEl("text", { class: "arb-l-label", "text-anchor": "middle" });
        ladderSvg.append(g, label);
        g.addEventListener("pointerenter", () => ladderTip.show(e.x, base + 10, e.tip));
        g.addEventListener("pointerleave", () => ladderTip.hide());
        g.addEventListener("focus", () => ladderTip.show(e.x, base + 10, e.tip));
        g.addEventListener("blur", () => ladderTip.hide());
        g.addEventListener("click", () => e.go?.());
        g.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            e.go?.();
          }
        });
        e = { g, label };
        ladderMarks.set(k.id, e);
      }
      e.x = k.x;
      e.go = k.go ?? null;
      e.tip = [h("b", {}, k.label), h("div", {}, k.title)];
      e.g.dataset.tone = k.tone ?? "";
      e.g.style.transform = `translate(${Math.round(k.x * 10) / 10}px, ${base}px)`;
      const ly = k.row === "a" ? 2 : H - 18;
      if (k.id === "hurdle") {
        const [rect, t] = e.label.children;
        rect.setAttribute("x", String(-k.w / 2));
        rect.setAttribute("width", String(k.w));
        rect.setAttribute("y", "0");
        t.setAttribute("x", "0");
        t.setAttribute("y", "9.5");
        if (t.textContent !== k.text) t.textContent = k.text;
        e.label.style.visibility = k.text ? "" : "hidden";
        e.label.style.transform = `translate(${Math.round(k.lx * 10) / 10}px, ${ly}px)`;
      } else {
        e.label.setAttribute("class", `arb-l-label ${k.ink ?? ""}`);
        if (e.label.textContent !== k.text) e.label.textContent = k.text;
        e.label.style.transform = `translate(${Math.round(k.lx * 10) / 10}px, ${ly + 13}px)`;
      }
    }
    for (const [id, e] of ladderMarks) {
      if (seen.has(id)) continue;
      e.g.remove();
      e.label.remove();
      ladderMarks.delete(id);
    }
    ladderSvg.setAttribute("aria-label", `Rates against hurdle ${formatPercent(hurdle * 100, 2)}: ${placed.filter((k) => k.id !== "hurdle").map((k) => k.label.toLowerCase()).join(", ") || "no other rate"}`);
    // Figures beside the plot: the same-expiry future and the implied forward.
    const fut = m.fut;
    if (m.noFuture) {
      setVal(figFut.value, "No future", null);
      figFut.sub.textContent = m.nearestFut ? `Nearest ${dayMon(m.nearestFut.expiry)}` : "";
    } else if (m.futError || !O.twoSided(fut)) {
      setVal(figFut.value, DASH, null);
      figFut.sub.textContent = "Quote unavailable";
    } else {
      setVal(figFut.value, `${formatFixed(fut.bid, 2)} / ${formatFixed(fut.ask, 2)}`, (fut.bid + fut.ask) / 2);
      figFut.value.title = `Bid ${formatFixed(fut.bid, 2)}, ask ${formatFixed(fut.ask, 2)}`;
      const basis = m.spot ? (fut.bid + fut.ask) / 2 - m.spot : null;
      figFut.sub.textContent = basis === null ? `${dayMon(fut.expiry)}` : `basis ${formatSigned(basis, 2)} · ${formatPercent((basis / m.spot) * 100, 2)}`;
    }
    if (m.fwd) {
      setVal(figFwd.value, formatFixed(m.fwd.forward, 2), m.fwd.forward);
      figFwd.sub.textContent = `band ±${formatFixed((m.fwd.hi - m.fwd.lo) / 2, 1)} · ${formatInt(m.fwd.n)} strikes`;
    } else {
      setVal(figFwd.value, DASH, null);
      figFwd.sub.textContent = "one-sided quotes";
    }
  }

  // ── Draw: the opportunity rail ──
  function railPick(m) {
    const conf = cfg();
    const par = m.par.rows.filter((r) => r.best).sort((a, b) => b.best.net - a.best.net)[0] ?? null;
    const boxList = conf.boxMode === "borrow" ? m.borrowBoxes : m.lendBoxes;
    const box = boxList.find((b) => !b.crossed && b.vsHurdleBp !== null) ?? null;
    // Carry: the future furthest from fair carry or the calendar furthest from its fair spread, in ₹ per lot.
    let carry = null;
    for (const f of m.term.futures) {
      if (f.carryVsBp === null || f.mid === null || f.days === null || f.days < 1) continue;
      const rs = Math.abs(f.carryVsBp / 1e4) * (f.days / 365) * f.mid * f.lot;
      if (!carry || rs > carry.rs) carry = { type: "fut", f, rs };
    }
    for (const c of m.term.calendars) {
      if (c.vsFair === null || c.lotMismatch) continue;
      const rs = Math.abs(c.vsFair) * c.lot;
      if (!carry || rs > carry.rs) carry = { type: "cal", c, rs };
    }
    return { par, box, carry };
  }
  // Carry as a cover bar in points: the basis against the fair basis at the hurdle (spot · h · d/365). 1.0× = at hurdle.
  function carryCover(f, m) {
    if (f.basis === null || f.mid === null || f.days === null || f.days < 1) return null;
    const fair = (f.mid - f.basis) * m.hRate * (f.days / 365);
    return { cover: fair > 0 ? f.basis / fair : null, gross: f.basis, cost: fair, short: Math.max(0, fair - f.basis) };
  }
  // A future's liquidity from its own quote (spread, and volume when the feed sends it).
  function futLiq(f) {
    const inst = st.futures.find((x) => x.expiry === f.expiry);
    const q = inst ? st.quotes.get(inst.symbol) : null;
    if (!q || f.bid === null || f.ask === null) return 0;
    return O.liquidityScore({ bid: f.bid, ask: f.ask, volume: num(q.volume), oi: num(q.oi) }, num(q.volume) ? 1 : 0);
  }
  function drawRail(m) {
    railErr.hidden = true;
    railRow.hidden = false;
    if (!m) {
      if (st.error) {
        railErr.hidden = false;
        railErr.replaceChildren(icon("warn"), h("span", {}, "Opportunities need the chain: it did not load."));
        railRow.hidden = true;
        railNote.hidden = true;
        return;
      }
      for (const c of railCards) {
        c.el.classList.add("skel");
        c.el.setAttribute("aria-busy", "true");
      }
      railNote.hidden = true;
      return;
    }
    const { par, box, carry } = railPick(m);
    const age = `${formatInt((m.fresh.ageMs ?? 0) / 1000)} s old`;
    const lots = cfg().lots;
    const fill = (card, o) => {
      card.el.classList.remove("skel");
      card.el.removeAttribute("aria-busy");
      const changed = card.key !== o.key;
      if (changed && card.key !== null && !reducedMotion()) card.body.animate?.([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      const wasNeg = card.key === o.key && card.net0 !== null && card.net0 <= 0;
      card.key = o.key;
      card.kind.textContent = o.kind;
      card.tags.replaceChildren(...(o.tags ?? []));
      card.liq.hidden = o.liq === undefined;
      if (o.liq !== undefined) setLiq(card.liq, o.liq);
      card.net.className = `arb-o-net ${o.netInk ?? ""}${o.small ? " small" : ""}`;
      setVal(card.net, o.net, o.netV ?? null);
      card.ret.className = `arb-o-ret ${o.retInk ?? ""}`;
      card.ret.replaceChildren(...[o.ret].flat().filter((x) => x !== null && x !== undefined));
      card.cover.el.hidden = !o.cover;
      if (o.cover) card.cover.set(o.cover, { compact: false });
      card.alt.hidden = !o.alt;
      card.alt.replaceChildren(...[o.alt].flat().filter((x) => x !== null && x !== undefined));
      // Stale: a warn dot leads the meta line (the card also dims); no edge bar.
      card.meta.replaceChildren(...[o.edge === "stale" ? h("i", { class: "arb-wdot", "aria-hidden": "true" }) : null, o.meta ?? ""].filter((x) => x !== null));
      card.meta.className = `arb-o-meta ${o.metaInk ?? ""}`;
      card.btn.hidden = !o.btn;
      card.btn.textContent = o.btn ?? "";
      card.btn.disabled = Boolean(o.btnOff);
      card.btn.title = o.btnOff ? "Quotes are stale" : "";
      card.act = o.act ?? null;
      card.go = o.go ?? null;
      const label = `${o.kind}: ${o.net}${o.retText ? `, ${o.retText}` : ""}`;
      card.el.setAttribute("aria-label", label);
      card.el.classList.toggle("has-go", Boolean(card.go));
      card.open.hidden = !card.go;
      card.open.setAttribute("aria-label", `Open in the scanner: ${label}`);
      const edge = o.edge ?? "none";
      if (edge === "pos" && wasNeg && card.el.dataset.edge !== "pos" && !reducedMotion()) {
        card.el.classList.remove("new-edge");
        void card.el.offsetWidth;
        card.el.classList.add("new-edge");
      }
      card.el.dataset.edge = edge;
      card.el.classList.toggle("is-stale", edge === "stale");
      card.net0 = o.netV ?? null;
    };
    // 1 · Parity
    const pc = railCards[0];
    if (m.noFuture) {
      const big = m.par.rows.filter((r) => r.dev !== null).sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev))[0];
      const monthly = futureExpiry(m);
      fill(pc, {
        key: `nofut:${m.c.expiry}`,
        kind: "Parity · switch expiry",
        net: `No future on ${dayMon(m.c.expiry)}`,
        small: true,
        ret: "Conversions and reversals need a same-expiry future",
        alt: big ? ["Largest deviation ", h("strong", {}, formatInt(big.strike)), ` · ${formatSigned(big.dev, 1)} pts`, big.tag ? h("span", { class: big.tag === "callsRich" ? "ink-call" : "ink-put" }, big.tag === "callsRich" ? " · calls rich" : " · puts rich") : ""] : null,
        meta: `${monthly ? "Strip and table: vs implied fwd" : `No ${m.c.underlying} expiry with a future`} · ${age}`,
        btn: monthly ? `Use ${dayMon(monthly)}` : null,
        act: monthly ? () => ctx.selectExpiry(monthly) : null,
        go: big ? () => goTo("parity", big.key) : null,
        edge: "none",
      });
    } else if (m.futError || m.par.lotMismatch || !par) {
      fill(pc, { key: `nopar:${m.c.expiry}`, kind: "Parity", net: m.futError ? "Futures quotes unavailable" : m.par.lotMismatch ? "Lot sizes differ: no conversions" : "Nothing executable", small: true, ret: m.futError ? "Deviations show against the implied forward" : "", edge: "none" });
    } else {
      const s = par.best;
      const a = m.expiryDay ? null : s.annual;
      const opp = m.isOpp.parity(par);
      fill(pc, {
        key: par.key + s.kind,
        kind: `${KIND_NAME[s.kind]} · ${formatInt(par.strike)}`,
        tags: par.atm ? [h("span", { class: "arb-atm" }, "ATM")] : [],
        liq: par.liq,
        net: rupeeSigned(s.net),
        netV: s.net,
        netInk: inkOf(s.net),
        ret: a === null ? (m.expiryDay ? "Annualised: not on expiry day" : "") : `${pctSigned(a, 1)}/yr over hurdle`,
        retText: a === null ? "" : `${pctSigned(a, 1)} a year over hurdle`,
        retInk: a === null ? "" : inkOf(a * 100, 1),
        cover: O.coverRatio(s),
        meta: m.stale ? `Stale · ${age}` : `${formatInt(s.legs.length)} legs · ${money(s.capital)} capital · ${formatInt(lots)} lot${lots === 1 ? "" : "s"} · ${age}`,
        metaInk: m.stale ? "ink-warn" : "",
        btn: "Preview",
        btnOff: m.stale,
        act: () => !m.stale && openOrders(s, m),
        go: () => {
          detailKind.delete(par.key);
          goTo("parity", par.key);
        },
        edge: m.stale ? "stale" : s.net > 0 && opp ? "pos" : "neg",
      });
    }
    // 2 · Box
    const bc = railCards[1];
    if (!box || m.expiryDay) fill(bc, { key: "nobox", kind: "Box", net: m.expiryDay ? "Not on expiry day" : "No two-sided box", small: true, ret: "", edge: "none" });
    else {
      const lend = box.mode === "lend";
      fill(bc, {
        key: box.key,
        kind: `${lend ? "Lend" : "Borrow"} box · ${formatInt(box.k1)} / ${formatInt(box.k2)}`,
        liq: box.liq,
        net: rupeeSigned(box.net),
        netV: box.net,
        netInk: inkOf(box.net),
        ret: [h("span", { class: box.vsHurdleBp >= 0 ? "ink-pos" : "ink-neg" }, `${pct(box.rate, 2)}/yr`), " ", bpChip(box.vsHurdleBp, { suffix: " bp vs hurdle" })],
        retText: `${pct(box.rate, 2)} a year, ${formatSigned(box.vsHurdleBp, 0)} bp against the hurdle`,
        cover: O.coverRatio(box),
        meta: m.stale ? `Stale · ${age}` : `4 legs · ${money(box.capital)} ${lend ? "capital" : "margin ≈ width"} · ${formatInt(box.width)} pts wide · ${age}`,
        metaInk: m.stale ? "ink-warn" : "",
        btn: "Preview",
        btnOff: m.stale,
        act: () => !m.stale && openOrders(box, m),
        go: () => goTo("boxes", box.key, { boxMode: box.mode }),
        edge: m.stale ? "stale" : m.isOpp.box(box) ? "pos" : "neg",
      });
    }
    // 3 · Carry / calendar
    const cc = railCards[2];
    if (!carry) fill(cc, { key: "nocarry", kind: "Carry", net: st.futures.length ? "Futures quotes loading" : "No listed future", small: true, ret: "", edge: "none" });
    else if (carry.type === "fut") {
      const f = carry.f;
      const rich = f.carryVsBp > 0;
      fill(cc, {
        key: f.key,
        kind: `Futures carry · ${dayMon(f.expiry)}`,
        net: `${pct(f.carry, 2)}/yr`,
        ret: [bpChip(f.carryVsBp, { suffix: " bp vs hurdle" })],
        retText: `${formatSigned(f.carryVsBp, 0)} bp against the hurdle`,
        alt: [h("span", { class: "arb-o-gap" }, `≈ ${formatRupee(carry.rs, 0)}/lot ${rich ? "rich" : "cheap"} vs fair carry`), f.cheaper ? ` · long via ${f.cheaper.long.pick}` : ""],
        liq: futLiq(f),
        cover: carryCover(f, m),
        meta: m.stale ? `Stale · ${age}` : `basis ${formatSigned(f.basis, 2)} · ${formatInt(f.days)} d · ${age}`,
        metaInk: m.stale ? "ink-warn" : "",
        btn: "Open in Futures",
        act: () => goTo("futures", f.key),
        go: () => goTo("futures", f.key),
        edge: m.stale ? "stale" : f.carryVsBp > 0 ? "pos" : f.carryVsBp < 0 ? "neg" : "none",
      });
    } else {
      const c = carry.c;
      const cs = calStruct(c, m);
      fill(cc, {
        key: c.key,
        kind: `Calendar · ${mon(c.from)} → ${mon(c.to)}`,
        net: c.rollLong === null ? DASH : `${formatRupee(c.rollLong, 0)}/lot`,
        ret: c.tag ? h("span", { class: c.tag === "rich" ? "ink-neg" : "ink-pos" }, `${c.tag} ${formatSigned(c.vsFair, 1)} pts vs fair (long roll)`) : "at fair",
        retText: c.tag ? `${c.tag} by ${formatFixed(Math.abs(c.vsFair), 1)} points` : "",
        alt: `fwd rate ${pct(c.fwdRate, 2)} · fair spread ${formatFixed(c.fair, 1)}`,
        meta: m.stale ? `Stale · ${age}` : `Roll a long: sell near, buy far · ${age}`,
        metaInk: m.stale ? "ink-warn" : "",
        btn: cs.legs.length ? "Preview" : null,
        btnOff: m.stale,
        act: () => !m.stale && cs.legs.length && openOrders(cs, m),
        go: () => goTo("futures", c.key),
        edge: c.tag === "cheap" ? "pos" : c.tag === "rich" ? "neg" : "none",
      });
    }
    // One honest line when nothing clears costs (the normal case): no banner, no tint.
    // A box clears when its rate beats the hurdle after charges (a borrow always pays interest, so its net is never > 0).
    const clears = (par && par.best.net > 0) || (box && box.vsHurdleBp !== null && box.vsHurdleBp >= 0);
    let note = "";
    if (!clears && (par || box)) {
      const cv = par ? O.coverRatio(par.best) : O.coverRatio(box);
      const what = par ? `${KIND_NAME[par.best.kind]} ${formatInt(par.strike)}` : `${box.mode === "lend" ? "Lend" : "Borrow"} box ${formatInt(box.k1)} / ${formatInt(box.k2)}`;
      note = `No structure clears costs right now. Closest: ${what}, needs ${formatFixed(cv.short ?? 0, 2)} pts more.`;
    }
    railNote.hidden = !note;
    if (railNote.textContent !== note) railNote.textContent = note;
    if (par && !m.stale) announce(`best-${par.best.kind}-${par.strike}`, `Best ${KIND_NAME[par.best.kind].toLowerCase()} now ${formatInt(par.strike)}, ${par.best.net >= 0 ? "plus" : "minus"} ${formatRupee(Math.abs(par.best.net), 0)}`);
  }
  function announce(id, text) {
    const now = Date.now();
    if (id === lastAnnounce.id || now - lastAnnounce.at < 10_000) return;
    const first = !lastAnnounce.id;
    lastAnnounce = { id, at: now };
    if (!first) live.textContent = text;
  }

  // ── Draw: the tab's visual ──
  const vizTip = tipper(vizEl);
  let vizSig = "";
  const strip = { host: null, cells: [], keys: "", cursor: -1 };
  function drawViz(m) {
    const tab = cfg().tab;
    const mode = tab === "parity" ? "strip" : tab === "boxes" ? (cfg().boxView === "matrix" ? "matrix" : "boxlegend") : "term";
    const sig = `${mode}|${m.c.underlying}|${m.c.expiry}|${cfg().boxMode}|${phone()}`;
    if (sig !== vizSig) {
      vizSig = sig;
      vizEl.replaceChildren(vizTip.el);
      vizTip.hide();
      strip.host = null;
      matrix.host = null;
      term.host = null;
      vizEl.dataset.mode = mode;
    }
    if (mode === "strip") drawStrip(m);
    else if (mode === "matrix" || mode === "boxlegend") drawMatrix(m, mode === "matrix");
    else drawTerm(m);
  }

  // Parity: one cell per strike, coloured by which side is rich and by how much; dots mark edges after costs.
  function drawStrip(m) {
    const rows = m.par.rows;
    const keys = rows.map((r) => r.key).join(",");
    const hasFut = !m.noFuture && !m.futError && !m.par.lotMismatch;
    if (!strip.host || strip.keys !== keys) {
      // A new strike window (Strikes ATM ±, or the ATM re-centring on a tick): drop the old strip before building the new one.
      if (strip.host) {
        strip.host.legendEl.remove();
        strip.host.scroll.remove();
        vizTip.hide();
      }
      strip.cursor = -1;
      strip.keys = keys;
      const cellsEl = h("div", { class: "arb-strip-cells", "aria-hidden": "true" });
      strip.cells = rows.map((r) => {
        const c = h("div", { class: "arb-hc dv-heat", "data-key": r.key }, h("i", { class: "arb-hd" }), h("span", { class: "arb-hk" }));
        cellsEl.append(c);
        return c;
      });
      cellsEl.style.setProperty("--n", String(rows.length));
      const legendEl = h("div", { class: "arb-viz-head" });
      const scroll = h("div", { class: "arb-strip", tabindex: "0", role: "group" }, cellsEl);
      strip.host = { scroll, cellsEl, legendEl };
      vizEl.prepend(legendEl, scroll);
      const at = (e) => {
        const c = e.target instanceof Element ? e.target.closest(".arb-hc") : null;
        return c ? strip.cells.indexOf(c) : -1;
      };
      scroll.addEventListener("pointermove", (e) => showStripTip(at(e)));
      scroll.addEventListener("pointerleave", () => strip.cursor < 0 && vizTip.hide());
      scroll.addEventListener("click", (e) => {
        const i = at(e);
        if (i >= 0) selectStrip(i);
      });
      scroll.addEventListener("keydown", (e) => {
        const n = strip.cells.length;
        if (!n) return;
        let i = strip.cursor < 0 ? Math.max(0, last?.par.rows.findIndex((r) => r.atm) ?? 0) : strip.cursor;
        if (e.key === "ArrowRight") i = Math.min(n - 1, i + (e.shiftKey ? 5 : 1));
        else if (e.key === "ArrowLeft") i = Math.max(0, i - (e.shiftKey ? 5 : 1));
        else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (strip.cursor >= 0) selectStrip(strip.cursor);
          return;
        } else if (e.key === "Escape") {
          e.stopPropagation();
          strip.cursor = -1;
          vizTip.hide();
          for (const c of strip.cells) c.classList.remove("cursor");
          (rowEls.get(sel)?.tr ?? tbody.querySelector("tr"))?.focus();
          return;
        } else return;
        e.preventDefault();
        e.stopPropagation();
        strip.cursor = i;
        strip.cells.forEach((c, k) => c.classList.toggle("cursor", k === i));
        showStripTip(i);
      });
      scroll.addEventListener("blur", () => {
        strip.cursor = -1;
        vizTip.hide();
        for (const c of strip.cells) c.classList.remove("cursor");
      });
    }
    const atmI = rows.findIndex((r) => r.atm);
    const oneSided = m.oneSidedMarket;
    rows.forEach((r, i) => {
      const c = strip.cells[i];
      const hc = m.heat[i] ?? { side: null, step: 0 };
      const step = hc.side ? hc.step : 0;
      if (c.dataset.side !== (hc.side ?? "")) c.dataset.side = hc.side ?? "";
      const prev = Number(c.dataset.step ?? 0);
      if (c.dataset.step !== String(step)) {
        c.dataset.step = String(step);
        if (step - prev >= 2 && !reducedMotion()) {
          c.classList.remove("pulse");
          void c.offsetWidth;
          c.classList.add("pulse");
        }
      }
      c.classList.toggle("one", Boolean(oneSided || r.oneSided));
      const cv = hasFut && r.best ? O.coverRatio(r.best) : null;
      const dot = !cv ? "" : r.best.net > 0 ? "pos" : (cv.cover ?? -1) >= 0.8 ? "ring" : "";
      if (c.dataset.dot !== dot) c.dataset.dot = dot;
      c.classList.toggle("sel", r.key === sel);
      c.classList.toggle("atm", r.atm);
      const k = c.lastChild;
      // Every 5th strike from ATM, but not on the two cells at each end (their label would clip).
      const show = r.atm || ((atmI >= 0 ? (i - atmI) % 5 === 0 : i % 5 === 0) && i >= 2 && i <= rows.length - 3);
      const text = show ? formatInt(r.strike) : "";
      if (k.textContent !== text) k.textContent = text;
    });
    const m0 = m.heat[0]?.m ?? 5;
    const lsig = `${hasFut}|${formatInt(m0)}`;
    if (strip.host.legendEl.__sig !== lsig) {
      strip.host.legendEl.__sig = lsig;
      const ramp = h("li", { class: "arb-ramp" }, h("span", { class: "arb-ramp-sw", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map((s) => h("i", { "data-step": String(s) }))), h("span", {}, `0 → ${formatInt(m0)} bp`));
      const lg = legend([{ label: "Calls rich (conversion side)", token: "call" }, { label: "Puts rich (reversal side)", token: "put" }, hasFut ? { label: "Clears costs", token: "pos" } : null, hasFut ? { label: "Close (≥ 80 % covered)", token: "neg" } : null], { label: "Parity heat legend" });
      if (hasFut) {
        const keysEls = lg.querySelectorAll(".dv-key");
        keysEls[2]?.classList.add("arb-dot-key");
        keysEls[3]?.classList.add("arb-ring-key");
      }
      lg.append(ramp);
      strip.host.legendEl.replaceChildren(h("span", { class: "arb-viz-title" }, hasFut ? "Deviation by strike" : "Deviation vs the implied forward"), lg);
    }
    const rich = rows.filter((r, i) => m.heat[i]?.side);
    strip.host.scroll.setAttribute("aria-label", `Parity heat by strike, ${formatInt(rows.length)} strikes: ${formatInt(rich.filter((r, i) => r.dev > 0).length)} calls rich, ${formatInt(rich.filter((r) => r.dev < 0).length)} puts rich${hasFut ? `, ${formatInt(rows.filter((r) => r.best?.net > 0).length)} clear costs` : ""}. Arrow keys read strikes, Enter selects.`);
  }
  function showStripTip(i) {
    const m = last;
    const r = m?.par.rows[i];
    const c = strip.cells[i];
    if (!r || !c) return vizTip.hide();
    const box = vizEl.getBoundingClientRect();
    const b = c.getBoundingClientRect();
    const side = r.dev === null ? "" : r.dev > 0 ? "calls rich" : r.dev < 0 ? "puts rich" : "fair";
    vizTip.show(b.left - box.left + b.width / 2, b.bottom - box.top + 6, [
      h("b", {}, `${formatInt(r.strike)}${r.atm ? " · ATM" : ""}`),
      h("div", {}, `dev ${formatSigned(r.dev, 1)} pts (${formatSigned(r.devBp, 0)} bp)${side ? " · " : ""}`, side ? h("span", { class: r.dev > 0 ? "ink-call" : "ink-put" }, side) : ""),
      r.best ? h("div", {}, `best ${KIND_NAME[r.best.kind]} `, h("span", { class: inkOf(r.best.net) }, rupeeSigned(r.best.net))) : null,
    ]);
  }
  function selectStrip(i) {
    const r = last?.par.rows[i];
    if (!r) return;
    if (cfg().onlyOpps && !list.some((x) => x.key === r.key)) setCfg({ onlyOpps: false });
    select(r.key, { scroll: true, open: sheetMode() });
  }

  // Boxes: the K1 × K2 matrix on fixed bp thresholds (or, in List view, just its legend for the vs-hurdle chips).
  const matrix = { host: null, cells: new Map(), sig: "", cursor: null };
  const BP_LEGEND = [[-3, "≤ −150"], [-2, "−50"], [-1, "−10"], [0, "0"], [1, "+10"], [2, "+50"], [3, "≥ +150"]];
  const BP_WORD = { "-3": "≤ −150 bp", "-2": "−50 to −150 bp", "-1": "−10 to −50 bp", 0: "within ±10 bp", 1: "+10 to +50 bp", 2: "+50 to +150 bp", 3: "≥ +150 bp" };
  function boxViewSeg() {
    const seg = segmented("Box view", [["list", "List"], ["matrix", "Matrix"]], st.arb.boxView);
    seg.classList.add("arb-view");
    seg.title = "List: ranked boxes. Matrix: every K1 × K2 pair coloured by its rate against your hurdle (M)";
    seg.addEventListener("change", () => seg.value !== cfg().boxView && setCfg({ boxView: seg.value }));
    return seg;
  }
  function drawMatrix(m, on) {
    if (!matrix.host) {
      // The labelled 7-step legend only for the desktop matrix; elsewhere one continuous ramp with end labels (one line).
      const full = on && !phone();
      const scale = full
        ? h("ul", { class: "dv-legend arb-bp-legend", "aria-label": "Basis points against your hurdle" }, BP_LEGEND.map(([s, t]) => h("li", {}, h("span", { class: "dv-key dv-heat", "data-div": String(s), "aria-hidden": "true" }), h("span", {}, t))), h("li", { class: "arb-bp-unit" }, "bp"))
        : h("span", { class: "arb-bp-ramp", role: "img", "aria-label": "Basis points against your hurdle, from −150 or less to +150 or more" }, h("span", {}, "≤ −150"), h("span", { class: "arb-bp-ramp-sw", "aria-hidden": "true" }, BP_LEGEND.map(([s]) => h("i", { class: "dv-heat", "data-div": String(s) }))), h("span", {}, "≥ +150 bp"));
      const legendEl = h("div", { class: "arb-viz-head" }, h("span", { class: "arb-viz-title" }, on ? (phone() ? "vs hurdle" : "Rate vs hurdle by strike pair") : "vs hurdle"), scale, phone() ? boxViewSeg() : null);
      const caption = h("p", { class: "arb-mx-cap", hidden: true });
      const grid = on ? h("div", { class: "arb-matrix", tabindex: "0", role: "grid" }) : null;
      matrix.host = { legendEl, grid, caption };
      matrix.sig = "";
      vizEl.prepend(...[legendEl, grid ? caption : null, grid ? h("div", { class: "arb-matrix-scroll" }, grid) : null].filter(Boolean));
      if (grid) {
        grid.addEventListener("pointermove", (e) => {
          const c = e.target instanceof Element ? e.target.closest(".arb-mc[data-key]") : null;
          if (c) showMatrixTip(c);
          else vizTip.hide();
        });
        grid.addEventListener("pointerleave", () => vizTip.hide());
        grid.addEventListener("click", (e) => {
          const c = e.target instanceof Element ? e.target.closest(".arb-mc[data-key]") : null;
          if (c) selectBox(c.dataset.key);
        });
        grid.addEventListener("keydown", (e) => {
          const ks = [...matrix.cells.keys()];
          if (!ks.length) return;
          const at = matrix.cursor ? matrix.cells.get(matrix.cursor) : null;
          let dr = 0;
          let dc = 0;
          if (e.key === "ArrowRight") dc = 1;
          else if (e.key === "ArrowLeft") dc = -1;
          else if (e.key === "ArrowDown") dr = 1;
          else if (e.key === "ArrowUp") dr = -1;
          else if ((e.key === "Enter" || e.key === " ") && matrix.cursor) {
            e.preventDefault();
            e.stopPropagation();
            return selectBox(matrix.cells.get(matrix.cursor)?.el.dataset.key);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            vizTip.hide();
            return (rowEls.get(sel)?.tr ?? tbody.querySelector("tr"))?.focus();
          } else return;
          e.preventDefault();
          e.stopPropagation();
          const keyed = [...matrix.cells.entries()].filter(([, v]) => v.el.dataset.key);
          if (!keyed.length) return;
          let hit = null;
          if (!at) {
            // First key: land on the keyed cell nearest the ATM strike (shown, not implied).
            const a = matrix.atmIndex ?? 0;
            hit = keyed.slice().sort(([, x], [, y]) => Math.abs(x.r - a) + Math.abs(x.c - a - 1) - (Math.abs(y.r - a) + Math.abs(y.c - a - 1)))[0];
          } else {
            // Step past void and empty cells until a keyed one, or stop at the edge.
            const by = new Map(keyed.map(([id, v]) => [`${v.r},${v.c}`, [id, v]]));
            let r = at.r + dr;
            let c = at.c + dc;
            while (r >= 0 && r < matrix.size && c >= 1 && c <= matrix.size) {
              hit = by.get(`${r},${c}`) ?? null;
              if (hit) break;
              r += dr;
              c += dc;
            }
            // Nothing straight ahead: take the nearest keyed cell in that direction's half-plane.
            if (!hit) {
              const ahead = keyed.filter(([, v]) => (dc ? (v.c - at.c) * dc > 0 : (v.r - at.r) * dr > 0));
              hit = ahead.sort(([, x], [, y]) => Math.abs(x.r - at.r) + Math.abs(x.c - at.c) - (Math.abs(y.r - at.r) + Math.abs(y.c - at.c)))[0] ?? null;
            }
            if (!hit) return;
          }
          matrix.cursor = hit[0];
          for (const v of matrix.cells.values()) v.el.classList.toggle("cursor", v === hit[1]);
          grid.setAttribute("aria-activedescendant", hit[1].el.id);
          hit[1].el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          showMatrixTip(hit[1].el);
        });
      }
    }
    if (!on) return;
    const strikes = m.par.rows.map((r) => r.strike);
    const atm = m.par.rows.find((r) => r.atm)?.strike ?? null;
    const maxSteps = cfg().boxMaxSteps;
    const by = new Map(m.boxes.map((b) => [`${b.k1}-${b.k2}`, b]));
    const grid = matrix.host.grid;
    const sig = `${strikes.join(",")}|${maxSteps}|${cfg().boxMode}`;
    if (matrix.sig !== sig) {
      matrix.sig = sig;
      matrix.cells.clear();
      const n = strikes.length;
      grid.style.setProperty("--n", String(Math.max(1, n - 1)));
      matrix.size = n - 1;
      matrix.atmIndex = Math.max(0, strikes.indexOf(atm));
      matrix.cursor = null;
      grid.removeAttribute("aria-activedescendant");
      // Rows own their cells (role=row with display: contents keeps the CSS grid), so the grid is valid ARIA.
      const head = [h("span", { class: "arb-mh corner", role: "columnheader" }, "K1 \\ K2")];
      for (let j = 1; j < n; j++) head.push(h("span", { class: `arb-mh col${strikes[j] === atm ? " atm" : ""}`, role: "columnheader" }, formatInt(strikes[j])));
      const kids = [h("div", { class: "arb-mrow", role: "row" }, head)];
      for (let i = 0; i < n - 1; i++) {
        const cells = [h("span", { class: `arb-mh row${strikes[i] === atm ? " atm" : ""}`, role: "rowheader" }, formatInt(strikes[i]))];
        for (let j = 1; j < n; j++) {
          const id = `${strikes[i]}-${strikes[j]}`;
          const el = h("span", { class: "arb-mc dv-heat", role: "gridcell", id: `arb-mc-${id}` });
          if (j <= i || j - i > maxSteps) el.classList.add("void");
          matrix.cells.set(id, { el, r: i, c: j });
          cells.push(el);
        }
        kids.push(h("div", { class: "arb-mrow", role: "row" }, cells));
      }
      grid.replaceChildren(...kids);
    }
    let filled = 0;
    // Rank 1 (the box on the rail and in the pane's "Best on this tab") is always ringed, whatever the colours say.
    const best = m.boxes.find((b) => !b.crossed && b.vsHurdleBp !== null) ?? null;
    const steps = new Set();
    for (const [id, v] of matrix.cells) {
      if (v.el.classList.contains("void")) continue;
      const b = by.get(id);
      const key = b ? b.key : "";
      if (v.el.dataset.key !== key) {
        if (key) v.el.dataset.key = key;
        else delete v.el.dataset.key;
      }
      const stp = !b || b.crossed ? null : O.bpStep(b.vsHurdleBp);
      if (stp !== null) {
        filled++;
        steps.add(stp);
      }
      const isBest = Boolean(b && best && b.key === best.key);
      v.el.classList.toggle("best", isBest);
      const want = stp === null ? undefined : String(stp);
      if (v.el.dataset.div !== want) {
        if (want === undefined) delete v.el.dataset.div;
        else v.el.dataset.div = want;
      }
      v.el.classList.toggle("empty", !b);
      v.el.classList.toggle("x", Boolean(b?.crossed));
      v.el.classList.toggle("opp", Boolean(b && m.isOpp.box(b)));
      v.el.classList.toggle("sel", Boolean(b && b.key === sel));
      const t = b?.crossed ? "×" : isBest ? "★" : "";
      if (v.el.textContent !== t) v.el.textContent = t;
    }
    // When every cell sits in one colour bucket, say so in words, with the best box.
    const cap = filled && steps.size === 1 && best ? `All ${formatInt(filled)} boxes ${BP_WORD[[...steps][0]]} vs hurdle; best ${formatSigned(best.vsHurdleBp, 0)} bp at ${formatInt(best.k1)} / ${formatInt(best.k2)} (★)` : best ? `★ best: ${formatInt(best.k1)} / ${formatInt(best.k2)}, ${formatSigned(best.vsHurdleBp, 0)} bp vs hurdle` : "";
    if (matrix.host.caption.textContent !== cap) matrix.host.caption.textContent = cap;
    matrix.host.caption.hidden = !cap;
    grid.setAttribute("aria-label", `Box matrix: ${formatInt(filled)} ${lendMode() ? "lending" : "borrowing"} boxes by lower strike (rows) and upper strike (columns), coloured by basis points against your hurdle. Arrow keys move, Enter selects.`);
  }
  function showMatrixTip(el) {
    const b = last?.boxes.find((x) => x.key === el.dataset.key);
    if (!b) return vizTip.hide();
    const box = vizEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    vizTip.show(r.left - box.left + r.width / 2, r.bottom - box.top + 6, [
      h("b", {}, `${formatInt(b.k1)} / ${formatInt(b.k2)} · width ${formatInt(b.width)}`),
      h("div", {}, `${b.mode === "lend" ? "lend" : "borrow"} ${pct(b.rate, 2)}/yr net · `, h("span", { class: b.vsHurdleBp >= 0 ? "ink-pos" : "ink-neg" }, `${formatSigned(b.vsHurdleBp, 0)} bp vs hurdle`)),
      h("div", {}, `${money(b.capital)} · locked `, h("span", { class: inkOf(b.locked) }, rupeeSigned(b.locked)), b.crossed ? " · crossed quotes" : ""),
    ]);
  }
  function selectBox(key) {
    if (cfg().onlyOpps && !list.some((x) => x.key === key)) setCfg({ onlyOpps: false });
    select(key, { scroll: true, open: sheetMode() });
  }

  // Futures: the term structure (carry, options-implied, forward segments rich / cheap for a long roll, the hurdle).
  const term = { host: null, sig: "" };
  function drawTerm(m) {
    if (!term.host) {
      const svg = svgEl("svg", { class: "arb-term-svg", role: "img" });
      const legendEl = h("div", { class: "arb-viz-head" }, h("span", { class: "arb-viz-title" }, "Term structure"), legend([{ label: "Futures carry", token: "iv", kind: "line" }, { label: "Options-implied", token: "iv", kind: "dash" }, { label: "Forward (rich / cheap for a long roll)", token: "neg", kind: "line" }, { label: "Hurdle", token: "spot", kind: "line" }], { label: "Term chart legend" }));
      const plot = h("div", { class: "arb-term" }, svg);
      term.host = { svg, plot, legendEl, revealed: false };
      term.sig = "";
      vizEl.prepend(legendEl, plot);
    }
    const futs = m.term.futures.filter((f) => f.days !== null && f.days >= 1);
    if (!term.host.plot.clientWidth) return requestAnimationFrame(() => last && term.host?.plot.clientWidth && drawTerm(last));
    const W = Math.round(term.host.plot.clientWidth);
    const H = phone() ? 120 : 140;
    const opt = futs.map((f) => {
      const ch = m.chains.get(f.expiry);
      return ch ? O.optionsImpliedRate(ch, { days: f.days, window: 5 }) : null;
    });
    const sig = JSON.stringify([W, H, m.hRate, futs.map((f) => [f.days, Math.round((f.carry ?? 0) * 1e5)]), opt.map((v) => (v === null ? null : Math.round(v * 1e5))), m.term.calendars.map((c) => [c.fwdRate === null ? null : Math.round(c.fwdRate * 1e5), c.tag]), m.c.expiry]);
    if (term.sig === sig) return;
    term.sig = sig;
    const svg = term.host.svg;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", String(H));
    if (!futs.length) {
      svg.replaceChildren(svgEl("text", { class: "dv-tick", x: W / 2, y: H / 2, "text-anchor": "middle" }, "No futures with days left"));
      return;
    }
    const L = 40;
    const R = 14;
    const T = 24;
    const B = 22;
    const maxD = Math.max(...futs.map((f) => f.days)) * 1.1;
    const vals = [m.hRate, ...futs.map((f) => f.carry), ...opt, ...m.term.calendars.map((c) => c.fwdRate)].filter((v) => v !== null && Number.isFinite(v));
    const vlo = Math.min(...vals) * 100;
    const vhi = Math.max(...vals) * 100;
    const pad = Math.max(0.05, (vhi - vlo) * 0.12);
    let ticks = O.niceTicks(vlo - pad, vhi + pad, 4);
    const stepT = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    if (ticks[ticks.length - 1] < vhi) ticks = [...ticks, ticks[ticks.length - 1] + stepT];
    if (ticks[0] > vlo) ticks = [ticks[0] - stepT, ...ticks];
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const x = (d) => L + (d / maxD) * (W - L - R);
    const y = (v) => T + ((hi - v * 100) / (hi - lo || 1)) * (H - T - B);
    const kids = [];
    const tdp = tickDp(ticks);
    for (const t of ticks) kids.push(svgEl("line", { class: "dv-grid", x1: L, x2: W - R, y1: y(t / 100), y2: y(t / 100) }), svgEl("text", { class: "dv-tick", x: L - 6, y: y(t / 100) + 3.5, "text-anchor": "end" }, `${formatFixed(t, tdp)}%`));
    for (const f of futs) kids.push(svgEl("text", { class: "dv-tick", x: x(f.days), y: H - 6, "text-anchor": "middle" }, dayMon(f.expiry)));
    // The hurdle: a horizontal rule with its contrast pill at the right end.
    kids.push(svgEl("line", { class: "dv-spot-line arb-t-hurdle", x1: L, x2: W - R, y1: y(m.hRate), y2: y(m.hRate) }));
    // Forward segments over each [d1, d2]: red when the spread is rich for a long roll, green when cheap.
    m.term.calendars.forEach((c) => {
      const a = futs.find((f) => f.expiry === c.from);
      const b = futs.find((f) => f.expiry === c.to);
      if (!a || !b || c.fwdRate === null) return;
      const tone = c.tag === "rich" ? "neg" : c.tag === "cheap" ? "pos" : "flat";
      kids.push(svgEl("line", { class: `arb-t-fwd ${tone}`, x1: x(a.days), x2: x(b.days), y1: y(c.fwdRate), y2: y(c.fwdRate) }));
      if (c.tag) kids.push(svgEl("text", { class: `arb-t-fwdl ${tone === "neg" ? "ink-neg" : "ink-pos"}`, x: (x(a.days) + x(b.days)) / 2, y: y(c.fwdRate) - 5, "text-anchor": "middle" }, `${c.tag} ${formatSigned(c.vsFair, 1)}`));
    });
    const path = (pts) => pts.map(([px, py], i) => `${i ? "L" : "M"}${Math.round(px * 10) / 10} ${Math.round(py * 10) / 10}`).join(" ");
    const carryPts = futs.filter((f) => f.carry !== null).map((f) => [x(f.days), y(f.carry)]);
    const optPts = futs.map((f, i) => (opt[i] === null ? null : [x(f.days), y(opt[i])])).filter(Boolean);
    const carryLine = carryPts.length > 1 ? svgEl("path", { class: "dv-line arb-t-carry", d: path(carryPts) }) : null;
    const optLine = optPts.length > 1 ? svgEl("path", { class: "dv-line sec dash arb-t-opt", d: path(optPts) }) : null;
    if (carryLine) kids.push(carryLine);
    if (optLine) kids.push(optLine);
    for (const [px, py] of optPts) kids.push(svgEl("circle", { class: "arb-t-ring", cx: px, cy: py, r: 3.5 }));
    futs.forEach((f) => {
      if (f.carry === null) return;
      const cur = f.expiry === m.c.expiry;
      kids.push(svgEl("circle", { class: `arb-t-dot${cur ? " cur" : ""}`, cx: x(f.days), cy: y(f.carry), r: cur ? 4.5 : 3 }, svgEl("title", {}, `${dayMon(f.expiry)}: carry ${pct(f.carry, 2)}/yr, ${formatSigned(f.carryVsBp, 0)} bp vs hurdle`)));
    });
    svg.replaceChildren(...kids);
    spotPill(svg, W - R - 44, `Hurdle ${formatPercent(m.hRate * 100, 2)}`, { y: Math.max(0, Math.min(H - B - 18, y(m.hRate) - 9)), width: W });
    const curF = futs.find((f) => f.expiry === m.c.expiry && f.carry !== null);
    if (curF) spotPill(svg, x(curF.days), dayMon(curF.expiry), { y: Math.max(0, y(curF.carry) - 26), width: W });
    svg.setAttribute("aria-label", `Futures term: ${futs.map((f) => `${dayMon(f.expiry)} carry ${pct(f.carry, 2)}`).join(", ")}; hurdle ${formatPercent(m.hRate * 100, 2)}`);
    if (!term.host.revealed) {
      term.host.revealed = true;
      lineReveal([carryLine, optLine].filter(Boolean));
    }
  }

  // ── Draw: chips, inline notes, the empty state, skeletons ──
  // The head's chips: built once and patched (a rebuild per tick would drop focus and clicks on the capsules).
  const staleChip = h("span", { class: "arb-chip stale", hidden: true, title: "Quotes older than your stale limit, or chain and future far apart in time" });
  const expChip = h("span", { class: "expiry-chip", hidden: true, title: "+2% ELM on short options; annualised figures hidden" }, "Expiry day");
  const modeSeg = boxModeSeg();
  const viewSeg = boxViewSeg();
  chips.append(staleChip, expChip, modeSeg, viewSeg);
  function drawChips(m) {
    staleChip.hidden = !m?.stale;
    const t = m?.stale ? `Stale · ${formatInt((m.fresh.ageMs ?? 0) / 1000)} s` : "";
    if (staleChip.textContent !== t) staleChip.textContent = t;
    expChip.hidden = !m?.expiryDay;
    const boxes = Boolean(m) && cfg().tab === "boxes";
    modeSeg.hidden = !boxes;
    viewSeg.hidden = !boxes;
    if (modeSeg.value !== cfg().boxMode) modeSeg.value = cfg().boxMode;
    if (viewSeg.value !== cfg().boxView) viewSeg.value = cfg().boxView;
    chips.classList.toggle("is-empty", !m?.stale && !m?.expiryDay && !boxes);
  }
  function boxModeSeg() {
    const seg = segmented("Box mode", [["lend", "Lend"], ["borrow", "Borrow"]], cfg().boxMode);
    seg.classList.add("arb-mode");
    seg.title = "Lend: long box (pay a debit, receive the width). Borrow: short box (receive a credit, owe the width)";
    seg.addEventListener("change", () => seg.value !== cfg().boxMode && setCfg({ boxMode: seg.value }));
    return seg;
  }
  function drawInline(m) {
    const notes = [];
    const tab = cfg().tab;
    if (tab === "parity" && m.noFuture) {
      const monthly = futureExpiry(m);
      notes.push(h("p", { class: "arb-slim" }, h("span", {}, `No future on ${dayMon(m.c.expiry)}: deviations vs the implied forward only.`), monthly ? h("button", { type: "button", class: "small", onclick: () => ctx.selectExpiry(monthly) }, `Use ${dayMon(monthly)}`) : null));
    } else if (tab === "parity" && m.futError) notes.push(h("p", { class: "err-bar" }, icon("warn"), h("span", {}, "Could not load futures quotes: showing deviations against the implied forward.")));
    if (m.oneSidedMarket) notes.push(h("p", { class: "arb-slim warn" }, "Quotes are one-sided (market closed?). Nothing is executable; mid-based Dev shows, hatched, as indicative."));
    if (tab === "boxes") notes.push(h("p", { class: "arb-slim" }, lendMode() ? "Long box: pay the debit now, receive the width at expiry. Rate after charges, simple ACT/365." : "Short box: receive the credit now, owe the width at expiry. In India it blocks margin close to its width: not cheap leverage."));
    if (tab === "futures") notes.push(h("p", { class: "arb-slim" }, `Every listed ${m.c.underlying} future; options forwards for other expiries refresh every 15 s. Cash-and-carry needs a tradable underlying: LATER.`));
    const sig = JSON.stringify([tab, m.noFuture, m.futError, m.oneSidedMarket, cfg().boxMode, m.c.expiry, m.nearestFut?.expiry]);
    if (noteEl.__sig === sig) return;
    noteEl.__sig = sig;
    noteEl.replaceChildren(...notes);
  }
  function drawEmpty(m, shown) {
    const conf = cfg();
    if (shown.length || !conf.onlyOpps) {
      emptyEl.hidden = true;
      return;
    }
    emptyEl.hidden = false;
    const tab = conf.tab;
    let closest = null;
    if (tab === "parity") {
      const best = m.par.rows.filter((r) => r.best).sort((a, b) => b.best.net - a.best.net)[0];
      if (best) {
        const cv = O.coverRatio(best.best);
        closest = `Closest: ${KIND_NAME[best.best.kind]} ${formatInt(best.strike)}, ${best.best.net < conf.minNet ? `needs ${formatFixed(Math.max(cv.short ?? 0, (conf.minNet - best.best.net) / best.best.U), 2)} pts more` : m.stale ? "quotes stale" : best.liq < conf.minLiq ? "liquidity too low" : rupeeSigned(best.best.net)}.`;
      }
    } else if (tab === "boxes") {
      const b = m.boxes.find((x) => !x.crossed && x.vsHurdleBp !== null);
      if (b) closest = `Closest: ${formatInt(b.k1)} / ${formatInt(b.k2)} at ${pct(b.rate, 2)}/yr, ${formatSigned(b.vsHurdleBp, 0)} bp vs hurdle.`;
    }
    const text = tab === "boxes" ? `No box beats your hurdle by ${formatInt(conf.minBoxBp)} bp at ${formatInt(conf.lots)} lot${conf.lots === 1 ? "" : "s"}.` : `No row clears your filters at ${formatInt(conf.lots)} lot${conf.lots === 1 ? "" : "s"}.`;
    const sig = JSON.stringify([text, closest]);
    if (emptyEl.__sig === sig) return;
    emptyEl.__sig = sig;
    emptyEl.replaceChildren(emptyState("scale", "Nothing clears your filters", text, h("div", { class: "arb-empty-x" }, closest ? h("p", { class: "arb-closest" }, closest) : null, h("button", { type: "button", class: "small", onclick: () => setCfg({ onlyOpps: false }) }, "Show all rows")), { compact: true }));
  }
  function shimmer() {
    if (phone()) {
      cardsEl.replaceChildren(...Array.from({ length: 8 }, () => h("li", { class: "arb-card arb-skel-card", "aria-hidden": "true" }, h("span", { class: "skel" }), h("span", { class: "skel short" }), h("span", { class: "skel tiny" }))));
      cardSig = "";
      cardEls.clear();
    } else {
      thead.replaceChildren();
      thead.__sort = "";
      tbody.replaceChildren(...Array.from({ length: 8 }, () => h("tr", { class: "arb-skel-row", "aria-hidden": "true" }, h("td", {}, h("span", { class: "skel" })))));
      tableSig = "";
      rowEls.clear();
    }
    vizSig = "";
    vizEl.replaceChildren(h("div", { class: "arb-viz-skel skel", "aria-hidden": "true" }));
    if (!ladderMarks.size) ladderPlot.classList.add("skel");
  }
  let errorShown = false;
  function draw() {
    if (destroyed) return;
    syncHead();
    flashLeft = FLASH_BUDGET;
    const isPhone = phone();
    scanEl.classList.toggle("is-phone", isPhone);
    scanEl.classList.toggle("is-sheet", sheetMode());
    wrapEl.hidden = isPhone;
    cardsEl.hidden = !isPhone;
    const t0 = performance.now();
    if (!st.chain) {
      last = null;
      list = [];
      drawRail(null);
      drawChips(null);
      emptyEl.hidden = true;
      footEl.textContent = "";
      scanEl.setAttribute("aria-busy", String(!st.error && !st.empty));
      if (st.error) {
        errorShown = true;
        noteEl.__sig = "";
        noteEl.replaceChildren(errorState(st.error, { onRetry: () => ctx.retry() }));
        wrapEl.hidden = true;
        cardsEl.hidden = true;
        vizEl.replaceChildren();
        vizSig = "";
        if (st.lastOk) figFwd.sub.textContent = `as of ${istTime(st.lastOk)}`;
      } else if (st.empty) {
        noteEl.__sig = "";
        noteEl.replaceChildren(emptyState("clock", "No expiries", st.empty, null, { compact: true }));
        wrapEl.hidden = true;
        cardsEl.hidden = true;
      } else {
        noteEl.__sig = "";
        noteEl.replaceChildren();
        shimmer();
      }
      paneDetail.update(null, null, { failed: Boolean(st.error), none: st.empty || false });
      return;
    }
    scanEl.removeAttribute("aria-busy");
    ladderPlot.classList.remove("skel");
    if (errorShown) {
      errorShown = false;
      noteEl.__sig = "";
    }
    const m = model();
    last = m;
    list = items(m);
    let shown = list;
    let capped = 0;
    const boxCap = isPhone ? BOX_CARDS_MAX : BOX_ROWS_MAX;
    if (cfg().tab === "boxes" && list.length > boxCap) {
      capped = list.length;
      shown = list.slice(0, boxCap);
      if (sel && !shown.some((x) => x.key === sel)) {
        const s = list.find((x) => x.key === sel);
        if (s) shown = [...shown, s];
      }
    }
    if (sel && !list.some((x) => x.key === sel)) sel = null;
    drawLadder(m);
    drawRail(m);
    drawChips(m);
    drawInline(m);
    drawViz(m);
    const matrixView = cfg().tab === "boxes" && cfg().boxView === "matrix";
    scanEl.classList.toggle("matrix-view", matrixView);
    if (isPhone) drawCards(m, matrixView ? [] : shown);
    else {
      drawTable(m, matrixView ? [] : shown);
      if (drawTable.fresh && !matrixView) fitTable(m, shown);
    }
    if (matrixView) wrapEl.hidden = true;
    drawEmpty(m, shown);
    const conf = cfg();
    footEl.textContent =
      conf.tab === "parity"
        ? `${formatInt(shown.length)} strikes · ATM ±${formatInt(conf.window)} from the implied forward · ${conf.hold === "close" ? "closed before expiry" : "held to expiry"} · hurdle ${formatPercent(conf.hurdle, 2)}`
        : conf.tab === "boxes"
          ? `${capped ? `Best ${formatInt(boxCap)} of ${formatInt(capped)}` : formatInt(shown.length)} boxes · up to ${formatInt(conf.boxMaxSteps)} strike steps wide · hurdle ${formatPercent(conf.hurdle, 2)}`
          : `${formatInt(m.term.futures.length)} futures · roll ₹ per lot including charges`;
    // Detail: the selection, else the best of this tab (desktop pane); the open sheet follows the selection.
    const selItem = itemOf(sel);
    if (!sheetMode()) paneDetail.update(selItem ?? bestItem(), m, { best: !selItem });
    if (sheet) sheet.detail.update(selItem ?? bestItem(), m, { best: !selItem });
    st.patchMs = Math.round((performance.now() - t0) * 10) / 10;
    if (debug) console.debug(`arb tick: compute ${formatFixed(m.computeMs, 2)} ms, total ${formatFixed(performance.now() - t0, 2)} ms`);
  }
  const debug = (() => {
    try {
      return Boolean(localStorage.getItem("mcb.debug"));
    } catch {
      return false;
    }
  })();

  // ── Data this page adds per tick: depth for the visible detail's legs, other expiries' chains (Futures tab) ──
  async function tick() {
    if (destroyed) return;
    const jobs = [];
    const item = itemOf(sel) ?? (last ? bestItem() : null);
    const detailVisible = phone() ? Boolean(sheet) : true;
    if (detailVisible && item?.s?.legs?.length) {
      for (const l of item.s.legs.slice(0, 4)) {
        if (!l.symbol) continue;
        jobs.push(
          optional(api(`/v1/depth?symbol=${encodeURIComponent(l.symbol)}`)).then((r) => {
            const d = r.data?.data;
            if (d) depth.set(l.symbol, { bid: num(d.bids?.[0]?.qty), ask: num(d.asks?.[0]?.qty) });
          }),
        );
      }
      const opt = item.s.legs.find((l) => l.kind !== "FUT");
      if (opt) jobs.push(loadOptFreeze(opt.symbol));
    }
    if (cfg().tab === "futures" && !extraLoading && Date.now() - extraAt >= EXTRA_EVERY_MS) jobs.push(loadExtra());
    await Promise.all(jobs);
    // No draw here: desk.js runs this beside the chain load and draws once when both have settled.
    return jobs.length > 0;
  }
  async function loadExtra() {
    const u = st.underlying;
    const want = st.futures.filter((f) => f.expiry !== st.expiry && st.expiries.includes(f.expiry)).slice(0, 3);
    if (!want.length) return;
    extraLoading = true;
    for (const f of want) if (!extra.has(f.expiry)) extra.set(f.expiry, { chain: null, at: 0, loading: true });
    await Promise.all(
      want.map(async (f) => {
        const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(f.expiry)}&strikes=4&greeks=false`));
        if (u !== st.underlying) return;
        const prev = extra.get(f.expiry);
        extra.set(f.expiry, r.error ? { chain: prev?.chain ?? null, at: prev?.at ?? 0, error: r.error } : { chain: r.data?.data ?? null, at: Date.now() });
      }),
    );
    extraLoading = false;
    extraAt = Date.now();
  }

  // ── Keyboard (desk.js routes keys here while this page is on screen) ──
  function onKey(e) {
    const k = e.key;
    if (k === "1" || k === "2" || k === "3") return setCfg({ tab: ["parity", "boxes", "futures"][Number(k) - 1] }), true;
    if (k === "j" || k === "ArrowDown") return moveSel(1), true;
    if (k === "k" || k === "ArrowUp") return moveSel(-1), true;
    if (k === "Enter") {
      if (e.target instanceof Element && e.target.closest("button, a, summary, input, select, [role=button], .arb-strip, .arb-matrix")) return false;
      return focusDetail(), true;
    }
    if (k === "Escape") {
      if (closePop) return closePop(), true;
      if (sel === null) return false;
      // Focus goes back to the row (PRD §15), not left on the detail heading.
      const back = rowEls.get(sel)?.tr ?? null;
      sel = null;
      draw();
      if (!sheetMode() && back?.isConnected) back.focus({ preventScroll: true });
      return true;
    }
    if (k === "o") return setCfg({ onlyOpps: !cfg().onlyOpps }), true;
    if (k === "h") return setCfg({ hold: cfg().hold === "expiry" ? "close" : "expiry" }), true;
    if (k === "+" || k === "=") return stepLots(1), true;
    if (k === "-" || k === "_") return stepLots(-1), true;
    if (k === "b") {
      // The best opportunity card's item: parity when there is one, else the box.
      const c = railCards.find((x) => x.go && x.el.dataset.edge !== "none") ?? railCards.find((x) => x.go);
      c?.go?.();
      return true;
    }
    if (k === "m") {
      if (cfg().tab === "boxes") setCfg({ boxView: cfg().boxView === "matrix" ? "list" : "matrix" });
      return true;
    }
    if (k === "e") {
      if (cfg().tab === "parity") setCfg({ sort: { ...cfg().sort, parity: { key: "edge", dir: "desc" } } });
      return true;
    }
    if (k === "c") {
      const item = itemOf(sel) ?? bestItem();
      return copyLegs(item?.s), true;
    }
    if (k === "g") {
      const atm = list.find((x) => x.type === "parity" && x.r.atm) ?? list.find((x) => x.type === "fut" && x.f.expiry === last?.c.expiry);
      if (atm) select(atm.key, { scroll: true });
      return true;
    }
    return false;
  }

  return {
    panels: [ladderEl, railEl, scanEl, notesEl, chartEl].filter(Boolean),
    root: scanEl,
    draw,
    tick,
    onKey,
    /** A new underlying or expiry: forget the selection, depth and (for an underlying) the other chains. */
    reset({ underlying = false } = {}) {
      sel = null;
      detailKind = new Map();
      depth.clear();
      tableSig = "";
      cardSig = "";
      vizSig = "";
      lastAnnounce = { id: "", at: 0 };
      for (const c of railCards) c.key = null;
      if (underlying) {
        extra.clear();
        extraAt = 0;
      }
    },
    destroy() {
      destroyed = true;
      paneRO?.disconnect();
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
      closePop?.();
    },
  };
}
