// Live events (#/screeners/events, docs/guides/live-events.md): market events as they are detected on the Bridge,
// streamed over the tab's one live connection (live.js, op subscribe_events) and painted once per animation frame. A summary strip (counts, bull and
// bear balance, the busiest kinds), the controls (stocks or options, bull / bear, kind, search, feed or by stock, pause,
// sound, the event picker, custom conditions, CSV), and a virtualised list: only the visible rows exist, keyed by
// event id, so an update touches only the cells that changed. A row opens a side sheet with the stock's levels and
// events today (or, for an option event, that strike's chain row) and the actions.
//
// Data: GET /v1/events (once, then again only to catch up after a reconnect), GET /v1/events/summary and catalogue
// (once), the stream for everything live. Never polled.
//
// Pure helpers (matches, groupByStock, csvOf, rowModel, stockRowModel, percentile, applyPreset) are exported for
// events.test.mjs; DOM code runs only in a browser. Numbers become text through format.js only.
import { api, app, h, icon, istTime, modal, mountToolbarCtx, optional, toast } from "./app.js";
import { DASH, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";
import { handoffPrefs } from "./screens.js";
import { segmented } from "./views.js";
import { liveState, onLiveState, onMarketEvents } from "./live.js";

const DESK_SLOT = "mcb.dashboard.desk";
const local = { get: (k) => app.local?.get?.(k) ?? null, set: (k, v) => app.local?.set?.(k, v) };
const PREFS_SLOT = "mcb.dashboard.events";
/** Rows painted beyond the viewport on each side. */
const OVERSCAN = 8;
/** Events kept in the browser (the Bridge keeps the whole day). */
export const MAX_CLIENT_EVENTS = 20_000;
const num = (v) => (isFigure(v) ? Number(v) : null);
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false, addEventListener() {}, removeEventListener() {} });
const phone = () => media("(max-width: 719px)").matches;
const reduced = () => media("(prefers-reduced-motion: reduce)").matches;
const readPrefs = () => {
  try {
    return JSON.parse(local.get(PREFS_SLOT) ?? "null") ?? {};
  } catch {
    return {};
  }
};
const writePrefs = (p) => {
  try {
    local.set(PREFS_SLOT, JSON.stringify(p));
  } catch {
    /* storage off: defaults next time */
  }
};
const signedPct = (v, dp = 2) => (isFigure(v) ? `${formatSigned(v, dp)}%` : DASH);
const hhmmss = (iso) => istTime(iso);

// ── Pure view-model ──

/** Whether an event passes the filters { asset, side, kind, q, minPrice }. */
export function matches(ev, f) {
  if (!ev) return false;
  if (f.asset && ev.asset !== f.asset) return false;
  if (f.side && f.side !== "all" && ev.side !== f.side) return false;
  if (f.kind && ev.kind !== f.kind) return false;
  if (isFigure(f.minPrice) && Number(f.minPrice) > 0) {
    const px = ev.asset === "option" ? ev.option?.premium ?? ev.ltp : ev.ltp;
    if (!isFigure(px) || Number(px) < Number(f.minPrice)) return false;
  }
  if (f.q) {
    const n = String(f.q).trim().toUpperCase();
    if (n && !`${ev.symbol} ${ev.name ?? ""} ${ev.label}`.toUpperCase().includes(n)) return false;
  }
  return true;
}

/** One row per symbol: its events, the latest time and its bull / bear counts. Newest first. */
export function groupByStock(events) {
  const by = new Map();
  for (const e of events) {
    let g = by.get(e.symbol);
    if (!g) by.set(e.symbol, (g = { id: `g:${e.symbol}`, symbol: e.symbol, name: e.name, tags: e.tags ?? {}, n: 0, bull: 0, bear: 0, kinds: new Map(), latest: e, ltp: e.ltp, changePct: e.changePct }));
    g.n += 1;
    if (e.side === "bull") g.bull += 1;
    else if (e.side === "bear") g.bear += 1;
    g.kinds.set(e.label, (g.kinds.get(e.label) ?? 0) + 1);
    if (!g.latest || e.ts >= g.latest.ts) {
      g.latest = e;
      g.ltp = e.ltp;
      g.changePct = e.changePct;
    }
  }
  return [...by.values()].sort((a, b) => b.latest.ts - a.latest.ts);
}

/**
 * The Strength cell, in the unit each event is measured in: a % move ("+1.45%"), a multiple ("2.3×"), lots
 * ("+120 lots"), vol points ("+2.1 pts") or a circuit band ("5%"). Crosses of a level (VWAP, pivots, a strike) and
 * custom conditions have no size worth a number at the moment they fire (the distance is about 0), so the cell is
 * empty for them, and so is a breakout that is still within 0.05 % of its level. Pure.
 */
const STRENGTH_PCT = new Set(["gap_up", "gap_down", "gap_filled", "day_high", "day_low", "move_pct", "swing_up", "swing_down", "oi_buildup", "oi_surge", "opt_premium_spike", "opt_near_band"]);
const STRENGTH_BREAK = new Set(["prev_high_break", "prev_low_break", "all_time_high", "all_time_low", "high_52w", "low_52w"]);
const STRENGTH_TIMES = new Set(["vol_above_prev", "vol_surge", "opt_oi_surge", "opt_unusual_volume"]);
const STRENGTH_BAND = new Set(["only_buyers", "only_sellers", "circuit_unlocked"]);
export function strengthText(kind, v) {
  if (!isFigure(v)) return DASH;
  const x = Number(v);
  if (STRENGTH_PCT.has(kind)) return signedPct(x);
  if (STRENGTH_BREAK.has(kind)) return Math.abs(x) < 0.05 ? DASH : signedPct(x);
  if (STRENGTH_TIMES.has(kind)) return `${formatFixed(x, 1)}×`;
  if (STRENGTH_BAND.has(kind)) return x > 0 ? `${formatFixed(x, x % 1 ? 1 : 0)}%` : DASH;
  if (kind === "opt_buildup") return `${formatSigned(x, 0)} lots`;
  if (String(kind).startsWith("opt_iv")) return `${formatSigned(x, 1)} pts`;
  return DASH; // vwap_cross, pivot_cross, ul_cross_strike, custom, and anything new
}
/** What the Strength cell measures, for its tooltip. */
export function strengthTitle(kind) {
  if (STRENGTH_PCT.has(kind) || STRENGTH_BREAK.has(kind)) return "Size of the move, % (from the level, the open or the previous close)";
  if (STRENGTH_TIMES.has(kind)) return "Volume or OI as a multiple of its usual pace";
  if (STRENGTH_BAND.has(kind)) return "Circuit band, %";
  if (kind === "opt_buildup") return "Change in open interest, lots";
  if (String(kind).startsWith("opt_iv")) return "Change in implied volatility, vol points";
  return "No size for a level cross: see Context";
}

/** The text of every cell of a feed row (format.js does the numbers). */
export function rowModel(ev) {
  const o = ev.option ?? null;
  const strike = o?.strike ?? null;
  return {
    time: hhmmss(ev.time),
    symbol: ev.symbol.split(":")[1] ?? ev.symbol,
    name: ev.name ?? "",
    tags: [ev.tags?.index ? "IDX" : null, ev.tags?.fno && !ev.tags?.index ? "F&O" : null].filter(Boolean),
    ltp: isFigure(ev.ltp) ? formatFixed(ev.ltp, 2) : DASH,
    chg: signedPct(ev.changePct),
    chgTone: !isFigure(ev.changePct) ? "" : ev.changePct > 0 ? "up" : ev.changePct < 0 ? "down" : "",
    label: ev.label,
    side: ev.side,
    context: ev.context ?? "",
    also: ev.also?.length ? ev.also.length : 0,
    count: ev.count > 1 ? `×${formatInt(ev.count)}` : "",
    strength: strengthText(ev.kind, ev.strength),
    strengthTitle: strengthTitle(ev.kind),
    strike: strike === null ? DASH : formatFixed(strike, Number.isInteger(strike) ? 0 : 2),
    right: o?.right ?? DASH,
    expiry: o?.expiry ? o.expiry.slice(5) : DASH,
    premium: isFigure(o?.premium) ? formatFixed(o.premium, 2) : DASH,
    doi: isFigure(o?.dOiLots) ? formatSigned(o.dOiLots, 0) : DASH,
    iv: isFigure(o?.iv) ? formatFixed(o.iv, 1) : DASH,
  };
}

/** A by-stock row's cells. */
export function stockRowModel(g) {
  const top = [...g.kinds.entries()].sort((a, b) => b[1] - a[1]);
  return {
    symbol: g.symbol.split(":")[1] ?? g.symbol,
    name: g.name ?? "",
    ltp: isFigure(g.ltp) ? formatFixed(g.ltp, 2) : DASH,
    chg: signedPct(g.changePct),
    chgTone: !isFigure(g.changePct) ? "" : g.changePct > 0 ? "up" : g.changePct < 0 ? "down" : "",
    kinds: top.slice(0, 3).map(([k, n]) => (n > 1 ? `${k} ×${formatInt(n)}` : k)),
    more: top.length > 3 ? `+${formatInt(top.length - 3)}` : "",
    n: formatInt(g.n),
    bull: formatInt(g.bull),
    bear: formatInt(g.bear),
    latest: hhmmss(g.latest.time),
  };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** The events as CSV (newest first), numbers as the API sends them. */
export function csvOf(events) {
  const head = ["time", "symbol", "name", "asset", "event", "side", "ltp", "change_pct", "context", "count", "first", "strike", "right", "expiry", "premium", "doi_lots", "iv"];
  const lines = [head.join(",")];
  for (const e of events) {
    const o = e.option ?? {};
    lines.push([e.time, e.symbol, e.name, e.asset, e.label, e.side, e.ltp, e.changePct, e.context, e.count, e.first, o.strike, o.right, o.expiry, o.premium, o.dOiLots, o.iv].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** p-th percentile of a list of numbers (null when empty). */
export function percentile(list, p) {
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

/** A preset turns its kinds on and the other kinds of the same asset off. */
export function applyPreset(selection, preset, catalogue) {
  const next = structuredClone(selection);
  for (const k of catalogue.kinds) {
    if (k.asset !== preset.asset) continue;
    next.kinds[k.kind] = { ...(next.kinds[k.kind] ?? { params: {} }), on: preset.kinds.includes(k.kind) };
  }
  return next;
}

// ── Page ──

export async function renderEventsPage() {
  const prefs = readPrefs();
  const debug = /[?&]debug=1\b/.test(location.hash) || prefs.debug === true;
  const [listRes, sumRes, catRes] = await Promise.all([api("/v1/events?limit=5000"), optional(api("/v1/events/summary")), optional(api("/v1/events/catalogue"))]);
  const catalogue = catRes.data?.data ?? { kinds: [], categories: [], presets: [] };
  const kindLabel = new Map(catalogue.kinds.map((k) => [k.kind, k.label]));

  /** oldest first */
  let all = (listRes.data.data ?? []).slice().reverse();
  const byId = new Map(all.map((e) => [e.id, e]));
  let lastSeq = listRes.data.meta?.lastSeq ?? all.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  const summary = sumRes.data?.data ?? null;

  const f = { asset: prefs.asset === "option" ? "option" : "stock", side: prefs.side ?? "all", kind: "", q: "", minPrice: null };
  let mode = prefs.mode === "stock" ? "stock" : "feed";
  let paused = false;
  let sound = false;
  let notify = false;
  /** the filtered events, oldest first; or the by-stock groups, newest first */
  let view = [];
  let held = []; // events that arrived while paused
  let selectedId = null;
  const paintSamples = [];

  // ── Controls ──
  const assetSeg = segmented("Asset", [["stock", "Stocks"], ["option", "Options"]], f.asset);
  const sideSeg = segmented("Side", [["all", "All"], ["bull", "Bull"], ["bear", "Bear"]], f.side);
  const modeSeg = segmented("View", [["feed", "Feed"], ["stock", "By stock"]], mode);
  const kindSel = h("select", { "aria-label": "Event kind", class: "ev-kind" });
  const search = h("input", { type: "search", placeholder: "Search symbol or event", "aria-label": "Search events", class: "ev-search", autocomplete: "off", spellcheck: "false" });
  const minPx = h("input", { type: "number", min: "0", step: "1", inputmode: "decimal", placeholder: "Min price", "aria-label": "Minimum price", class: "ev-minpx" });
  const pauseBtn = h("button", { type: "button", class: "small ev-pause", "aria-pressed": "false" }, icon("pause"), h("span", {}, "Pause"));
  const soundBtn = h("button", { type: "button", class: "small chip-btn ev-sound", "aria-pressed": "false", title: "Play a sound for new events that match the filters" }, "Sound");
  const notifyBtn = h("button", { type: "button", class: "small chip-btn ev-notify", "aria-pressed": "false", title: "Browser notification for first-of-day events that match the filters" }, "Notify");
  const pickBtn = h("button", { type: "button", class: "small", "aria-haspopup": "dialog" }, icon("sliders"), h("span", {}, "Events"));
  const condBtn = h("button", { type: "button", class: "small", "aria-haspopup": "dialog" }, icon("plus"), h("span", {}, "Conditions"));
  const csvBtn = h("button", { type: "button", class: "small plain", title: "Download the events shown as CSV" }, icon("download"), h("span", {}, "CSV"));
  const fillKinds = () => {
    const kinds = catalogue.kinds.filter((k) => k.asset === f.asset);
    if (!kinds.some((k) => k.kind === f.kind)) f.kind = "";
    fill(kindSel, h("option", { value: "" }, "All events"), kinds.map((k) => h("option", { value: k.kind, selected: k.kind === f.kind ? "" : undefined }, k.label)));
  };
  fillKinds();

  // ── Summary strip ──
  const counts = { total: summary?.total ?? all.length, bull: summary?.bySide?.bull ?? 0, bear: summary?.bySide?.bear ?? 0, byKind: new Map(Object.entries(summary?.byKind ?? {})) };
  if (!summary) for (const e of all) bump(e);
  else if (!counts.total) counts.total = all.length;
  function bump(e) {
    counts.byKind.set(e.kind, (counts.byKind.get(e.kind) ?? 0) + 1);
    if (e.side === "bull") counts.bull += 1;
    else if (e.side === "bear") counts.bear += 1;
  }
  const strip = h("div", { class: "ev-strip", role: "group", "aria-label": "Today" });
  const totalV = h("strong", {});
  const bullV = h("strong", { class: "up" });
  const bearV = h("strong", { class: "down" });
  const meter = h("span", { class: "ev-meter", role: "img" }, h("i", { class: "b" }), h("i", { class: "s" }));
  const topKinds = h("div", { class: "ev-topkinds chips" });
  const perfV = h("span", { class: "ev-perf", hidden: !debug });
  fill(
    strip,
    h("div", { class: "ev-stat" }, h("small", {}, "Events today"), totalV),
    h("div", { class: "ev-stat" }, h("small", {}, "Bull"), bullV),
    h("div", { class: "ev-stat" }, h("small", {}, "Bear"), bearV),
    h("div", { class: "ev-stat ev-bal" }, h("small", {}, "Balance"), meter),
    topKinds,
    perfV,
  );
  let stripDirty = true;
  function drawStrip() {
    stripDirty = false;
    totalV.textContent = formatInt(counts.total);
    bullV.textContent = formatInt(counts.bull);
    bearV.textContent = formatInt(counts.bear);
    const dir = counts.bull + counts.bear;
    const share = dir ? counts.bull / dir : 0.5;
    meter.style.setProperty("--bull", String(share));
    meter.setAttribute("aria-label", dir ? `${formatInt(share * 100)}% bull` : "No directional events yet");
    // The busiest kinds of the view in front of the person (Stocks or Options), never the other view's.
    const assetOf = (k) => catalogue.kinds.find((x) => x.kind === k)?.asset ?? null;
    const top = [...counts.byKind.entries()].filter(([k]) => !f.asset || assetOf(k) === f.asset).sort((a, b) => b[1] - a[1]).slice(0, phone() ? 3 : 6);
    fill(
      topKinds,
      top.map(([k, n]) =>
        h("button", { type: "button", class: "small chip-btn", "aria-pressed": String(f.kind === k), onclick: () => setKind(f.kind === k ? "" : k) }, `${kindLabel.get(k) ?? k} ${formatInt(n)}`),
      ),
    );
    if (debug) {
      const p95 = percentile(paintSamples, 95);
      perfV.textContent = p95 === null ? "Paint p95 waiting" : `Paint p95 ${formatInt(p95)} ms (${formatInt(paintSamples.length)})`;
    }
  }
  function setKind(k) {
    const kind = catalogue.kinds.find((x) => x.kind === k);
    if (kind && kind.asset !== f.asset) assetSeg.value = kind.asset;
    f.kind = k;
    fillKinds();
    rebuild();
  }

  // ── List ──
  const head = h("div", { class: "ev-head", role: "row" });
  const spacer = h("div", { class: "ev-spacer", role: "presentation" });
  const rowsHost = h("div", { class: "ev-rows", role: "rowgroup" });
  const scroller = h("div", { class: "ev-scroll", role: "table", "aria-label": "Live events. Arrow keys or J and K move, Enter opens the details", tabindex: "0" }, head, h("div", { class: "ev-body" }, spacer, rowsHost));
  const empty = h("p", { class: "ev-empty", hidden: true });
  const liveNote = h("p", { class: "sr-only", "aria-live": "polite" });
  /** id -> row element currently in the DOM */
  const rowEls = new Map();

  // Dense on a fine pointer (30 px rows), 44 px on touch, cards on a phone. Must match app.css (--ev-rh).
  const rowH = () => (phone() ? (mode === "stock" ? 92 : f.asset === "option" ? 112 : 96) : media("(pointer: coarse)").matches ? 44 : 30);
  const headCells = () =>
    mode === "stock"
      ? ["Symbol", "LTP", "% chg", "Events today", "Bull", "Bear", "Latest"]
      : f.asset === "option"
        ? ["Time", "Underlying", "Strike", "Side", "Expiry", "Event", "Premium", "ΔOI lots", "IV", "Context", "Count"]
        : ["Time", "Symbol", "Event", "Strength", "LTP", "% chg", "Context", "Count"];
  const NUMERIC = new Set(["LTP", "% chg", "Strike", "Premium", "ΔOI lots", "IV", "Bull", "Bear", "Strength", "Count"]);
  function drawHead() {
    scroller.dataset.mode = mode;
    scroller.dataset.asset = f.asset;
    fill(head, headCells().map((t) => h("span", { role: "columnheader", class: NUMERIC.has(t) ? "num" : undefined }, t)));
  }

  function cellsFor(item) {
    if (mode === "stock") {
      const m = stockRowModel(item);
      return [
        h("span", { role: "cell", class: "c-sym", title: m.name || m.symbol }, h("strong", {}, m.symbol)),
        h("span", { role: "cell", class: "num c-ltp" }, m.ltp),
        h("span", { role: "cell", class: `num c-chg ${m.chgTone}` }, m.chg),
        h("span", { role: "cell", class: "c-kinds" }, m.kinds.map((k) => h("span", { class: "ev-chip" }, k)), m.more ? h("span", { class: "ev-more" }, m.more) : null),
        h("span", { role: "cell", class: "num c-bull up" }, m.bull),
        h("span", { role: "cell", class: "num c-bear down" }, m.bear),
        h("span", { role: "cell", class: "c-time" }, m.latest),
      ];
    }
    const m = rowModel(item);
    // The company name only as a tooltip (and in the side sheet): cut to a few letters beside the ticker it was noise.
    const sym = h("span", { role: "cell", class: "c-sym", title: m.name || m.symbol }, h("strong", {}, m.symbol, m.tags.map((t) => h("span", { class: "ev-tag" }, t))));
    const chip = h("span", { role: "cell", class: "c-ev" }, h("span", { class: `ev-chip ${m.side}` }, m.label));
    const count = h("span", { role: "cell", class: "num c-count" }, m.count);
    const ctx = h("span", { role: "cell", class: "c-ctx", title: m.context }, m.context, m.also ? h("span", { class: "ev-more" }, `+${formatInt(m.also)}`) : null);
    if (f.asset === "option") {
      return [
        h("span", { role: "cell", class: "c-time" }, m.time),
        sym,
        h("span", { role: "cell", class: "num c-strike" }, m.strike),
        h("span", { role: "cell", class: "c-right" }, m.right === "CE" || m.right === "PE" ? h("span", { class: `side-tag ${m.right === "CE" ? "buy" : "sell"}` }, m.right) : m.right),
        h("span", { role: "cell", class: "c-exp" }, m.expiry),
        chip,
        h("span", { role: "cell", class: "num c-prem" }, m.premium),
        h("span", { role: "cell", class: "num c-doi" }, m.doi),
        h("span", { role: "cell", class: "num c-iv" }, m.iv),
        ctx,
        count,
      ];
    }
    return [h("span", { role: "cell", class: "c-time" }, m.time), sym, chip, h("span", { role: "cell", class: "num c-str", title: m.strengthTitle }, m.strength), h("span", { role: "cell", class: "num c-ltp" }, m.ltp), h("span", { role: "cell", class: `num c-chg ${m.chgTone}` }, m.chg), ctx, count];
  }

  function makeRow(item) {
    const el = h("div", { role: "row", class: "ev-row", tabindex: "-1", "data-id": item.id }, cellsFor(item));
    el.addEventListener("click", () => open(item.id));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(item.id);
      }
    });
    el.__sig = sigOf(item);
    return el;
  }
  const sigOf = (item) => (mode === "stock" ? `${item.n}|${item.latest.id}|${item.latest.count}` : `${item.count}|${item.ltp}|${item.context}|${item.kind}`);

  /** Patch only the cells of a row whose event changed (count, LTP, context), with a brief flash. */
  function patchRow(el, item) {
    const sig = sigOf(item);
    if (el.__sig === sig) return;
    el.__sig = sig;
    const next = cellsFor(item);
    const cur = [...el.children];
    for (let i = 0; i < next.length; i++) {
      if (!cur[i] || cur[i].textContent === next[i].textContent) continue;
      el.replaceChild(next[i], cur[i]);
      if (!reduced()) {
        next[i].classList.add("ev-flash");
        next[i].addEventListener("animationend", () => next[i].classList.remove("ev-flash"), { once: true });
      }
    }
  }

  const itemAt = (i) => (mode === "stock" ? view[i] : view[view.length - 1 - i]);
  let lastTop = -1;
  /** Draw the visible window. New events at the top keep a scrolled reader's place. */
  function paintRows(fresh = new Set()) {
    const H = rowH();
    const n = view.length;
    spacer.style.height = `${n * H}px`;
    const top = scroller.scrollTop;
    const vis = Math.ceil((scroller.clientHeight || 600) / H);
    const start = Math.max(0, Math.floor(top / H) - OVERSCAN);
    const end = Math.min(n, start + vis + OVERSCAN * 2);
    const keep = new Set();
    for (let i = start; i < end; i++) {
      const item = itemAt(i);
      if (!item) continue;
      keep.add(item.id);
      let el = rowEls.get(item.id);
      if (!el) {
        el = makeRow(item);
        rowEls.set(item.id, el);
        rowsHost.append(el);
        if (fresh.has(item.id) && !reduced()) el.classList.add("ev-new");
      } else patchRow(el, item);
      el.style.transform = `translateY(${i * H}px)`;
      el.setAttribute("aria-rowindex", String(i + 2));
      el.classList.toggle("sel", item.id === selectedId);
      if (item.id === selectedId) el.setAttribute("aria-selected", "true");
      else el.removeAttribute("aria-selected");
    }
    for (const [id, el] of rowEls) {
      if (keep.has(id)) continue;
      if (el.contains(document.activeElement)) continue;
      el.remove();
      rowEls.delete(id);
    }
    scroller.setAttribute("aria-rowcount", String(n + 1));
    empty.hidden = n > 0;
    if (!n) empty.textContent = all.length ? "No events match these filters." : paused ? "Paused." : "Waiting for the first events of the session.";
    lastTop = top;
  }

  function rebuild() {
    f.asset = assetSeg.value;
    f.side = sideSeg.value;
    mode = modeSeg.value;
    writePrefs({ ...readPrefs(), asset: f.asset, side: f.side, mode });
    stripDirty = true; // the busiest-kind chips follow the Stocks / Options view
    const list = all.filter((e) => matches(e, f));
    view = mode === "stock" ? groupByStock(list) : list;
    for (const el of rowEls.values()) el.remove();
    rowEls.clear();
    drawHead();
    scroller.scrollTop = 0;
    paintRows();
  }
  for (const c of [assetSeg, sideSeg, modeSeg]) c.addEventListener("change", () => (c === assetSeg ? (fillKinds(), rebuild()) : rebuild()));
  kindSel.addEventListener("change", () => setKind(kindSel.value));
  let qTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => ((f.q = search.value), rebuild()), 120);
  });
  minPx.addEventListener("change", () => ((f.minPrice = num(minPx.value)), rebuild()));
  scroller.addEventListener("scroll", () => schedule(), { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => schedule()).observe(scroller);

  // ── Incoming events: queue, then one paint per animation frame ──
  let inbox = [];
  let frame = 0;
  function schedule() {
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function accept(action, ev) {
    if (!ev?.id) return;
    if (paused && action === "new") {
      held.push(ev);
      pauseBtn.querySelector("span").textContent = `Resume (${formatInt(held.length)})`;
      return;
    }
    inbox.push([action, ev]);
    schedule();
  }
  function flush() {
    frame = 0;
    const batch = inbox;
    inbox = [];
    const fresh = new Set();
    let added = 0;
    let addedAbove = 0;
    let firstMatch = null;
    let touchedGroups = false;
    const H = rowH();
    for (const [action, ev] of batch) {
      const known = byId.get(ev.id);
      if (known) {
        // an update (or a new we already had from the REST catch-up): keep the newest fields
        const wasMatch = matches(known, f);
        Object.assign(known, ev);
        if (mode === "stock") touchedGroups = true;
        else if (!wasMatch && matches(known, f)) {
          view.push(known);
          added += 1;
        }
        continue;
      }
      if (action === "update" && !known) {
        // an update for an event we never saw (opened mid-day): treat as new
      }
      byId.set(ev.id, ev);
      all.push(ev);
      lastSeq = Math.max(lastSeq, ev.seq ?? 0);
      counts.total += 1;
      bump(ev);
      stripDirty = true;
      if (matches(ev, f)) {
        if (mode === "stock") touchedGroups = true;
        else {
          view.push(ev);
          added += 1;
          fresh.add(ev.id);
          if (scroller.scrollTop > 0) addedAbove += 1;
        }
        if (!firstMatch) firstMatch = ev;
        alertFor(ev);
      }
    }
    if (all.length > MAX_CLIENT_EVENTS) {
      const drop = all.splice(0, all.length - MAX_CLIENT_EVENTS);
      for (const d of drop) byId.delete(d.id);
      if (mode !== "stock") view = view.filter((e) => byId.has(e.id));
    }
    if (touchedGroups) view = groupByStock(all.filter((e) => matches(e, f)));
    if (addedAbove && mode !== "stock") scroller.scrollTop += addedAbove * H;
    paintRows(fresh);
    if (stripDirty) drawStrip();
    if (firstMatch && added) liveNote.textContent = `${formatInt(added)} new: ${firstMatch.label} ${firstMatch.symbol.split(":")[1] ?? ""}`;
    // Tick to paint: from the moment the Bridge detected the event to this frame being painted.
    if (fresh.size) {
      const stamp = () => {
        const now = performance.timeOrigin + performance.now();
        for (const id of fresh) {
          const ev = byId.get(id);
          if (ev && isFigure(ev.detectedAt)) paintSamples.push(now - ev.detectedAt);
        }
        if (paintSamples.length > 2000) paintSamples.splice(0, paintSamples.length - 2000);
        if (debug) drawStrip();
      };
      requestAnimationFrame(stamp);
    }
  }
  // For scripts/events-paint.mjs (Playwright): the measured tick-to-paint samples.
  window.__mcbEventsPerf = { samples: () => paintSamples.slice(), p95: () => percentile(paintSamples, 95) };

  // ── Sound and notifications ──
  let audio = null;
  function alertFor(ev) {
    if (sound) {
      try {
        audio = audio ?? new AudioContext();
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = ev.side === "bull" ? 880 : ev.side === "bear" ? 440 : 660;
        g.gain.setValueAtTime(0.05, audio.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.15);
        o.connect(g).connect(audio.destination);
        o.start();
        o.stop(audio.currentTime + 0.16);
      } catch {
        /* no audio */
      }
    }
    if (notify && ev.first && typeof Notification === "function" && Notification.permission === "granted") {
      try {
        new Notification(`${ev.label}: ${ev.symbol.split(":")[1] ?? ev.symbol}`, { body: ev.context, tag: ev.id, silent: true });
      } catch {
        /* blocked */
      }
    }
  }
  soundBtn.addEventListener("click", () => {
    sound = !sound;
    soundBtn.setAttribute("aria-pressed", String(sound));
  });
  notifyBtn.addEventListener("click", async () => {
    if (!notify && typeof Notification === "function" && Notification.permission !== "granted") {
      const p = await Notification.requestPermission().catch(() => "denied");
      if (p !== "granted") return toast("The browser did not allow notifications.", { tone: "warn" });
    }
    notify = !notify;
    notifyBtn.setAttribute("aria-pressed", String(notify));
  });
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.setAttribute("aria-pressed", String(paused));
    pauseBtn.replaceChildren(icon(paused ? "play" : "pause"), h("span", {}, paused ? "Resume" : "Pause"));
    if (!paused && held.length) {
      for (const ev of held) inbox.push(["new", ev]);
      held = [];
      schedule();
    }
  });
  csvBtn.addEventListener("click", () => {
    const list = all.filter((e) => matches(e, f)).reverse();
    const url = URL.createObjectURL(new Blob([csvOf(list)], { type: "text/csv" }));
    const a = h("a", { href: url, download: `events-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ── Keyboard: ↑ ↓ (or j k) move, Enter opens, / searches, p pauses ──
  scroller.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (step) {
      e.preventDefault();
      const ids = view.length ? Array.from({ length: view.length }, (_, i) => itemAt(i).id) : [];
      const i = Math.max(0, Math.min(ids.length - 1, ids.indexOf(selectedId) + step));
      selectedId = ids[i] ?? null;
      const H = rowH();
      if (i * H < scroller.scrollTop + H) scroller.scrollTop = Math.max(0, i * H - H);
      else if ((i + 1) * H > scroller.scrollTop + scroller.clientHeight - H) scroller.scrollTop = (i + 2) * H - scroller.clientHeight;
      paintRows();
      rowEls.get(selectedId)?.focus({ preventScroll: true });
    } else if (e.key === "Enter" && (selectedId || view.length)) {
      e.preventDefault();
      open(selectedId ?? itemAt(0).id);
    }
  });
  const onKey = (e) => {
    if (!scroller.isConnected) return removeEventListener("keydown", onKey);
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]") || e.target.closest?.("input, select, textarea")) return;
    if (e.key === "/") {
      e.preventDefault();
      search.focus();
    } else if (e.key === "p") pauseBtn.click();
  };
  addEventListener("keydown", onKey);

  // ── Side sheet ──
  async function open(id) {
    selectedId = id;
    paintRows();
    const item = mode === "stock" ? view.find((g) => g.id === id)?.latest : byId.get(id);
    if (!item) return;
    const d = document.getElementById("dialog");
    d.classList.add("ev-sheet");
    const body = h("div", { class: "ev-sheet-body" }, h("p", { class: "muted" }, "Loading"));
    const done = modal({ title: item.asset === "option" && item.option?.strike !== null && item.option?.strike !== undefined ? `${item.option.underlying} ${formatFixed(item.option.strike, Number.isInteger(item.option.strike) ? 0 : 2)}${item.option.right ? ` ${item.option.right}` : ""}` : item.symbol.split(":")[1] ?? item.symbol, body, buttons: [] });
    done.then(() => d.classList.remove("ev-sheet"));
    fill(body, item.asset === "option" ? await optionSheet(item) : await stockSheet(item));
  }

  const kv = (pairs) => h("dl", { class: "ev-kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  const px = (v) => (isFigure(v) ? formatFixed(v, 2) : DASH);
  const eventList = (events) =>
    h(
      "ol",
      { class: "ev-sheet-list" },
      events.map((e) => h("li", {}, h("span", { class: "c-time" }, hhmmss(e.time)), h("span", { class: `ev-chip ${e.side}` }, e.label), h("span", { class: "ev-sheet-ctx" }, e.context, e.count > 1 ? ` ×${formatInt(e.count)}` : "", e.also?.length ? ` · also ${e.also.map((k) => kindLabel.get(k) ?? k).join(", ")}` : ""))),
    );

  async function paperAccount() {
    const r = await optional(api("/v1/accounts"));
    const list = r.data?.data ?? [];
    return list.find((a) => a.broker === "paper" || /paper/.test(a.id)) ?? null;
  }
  async function ticket(item, side) {
    const a = await paperAccount();
    if (!a) return toast("No paper account to trade on.", { tone: "warn" });
    const { openPlacement } = await import("./strategy-place.js");
    document.querySelector("#dialog .sheet-close")?.click();
    await new Promise((r) => setTimeout(r, 250));
    const sym = item.symbol;
    openPlacement({
      title: `${side === "BUY" ? "Buy" : "Sell"} ${sym.split(":")[1]} (paper)`,
      account: { ...a, liveAllowedByConfig: false },
      items: [{ leg: 1, side, phase: side === "BUY" ? "hedge" : "short", symbol: sym, label: sym.split(":")[1], lots: 1, lotSize: 1, price: item.ltp, product: "INTRADAY", quote: () => ({ ltp: item.ltp, bid: null, ask: null }) }],
      cfg: { product: "INTRADAY", hedgeWait: 15 },
    });
  }

  async function stockSheet(item) {
    const r = await optional(api(`/v1/events/symbols/${encodeURIComponent(item.symbol)}`));
    const v = r.data?.data;
    if (!v) return h("p", {}, r.error?.message ?? "Could not load this symbol.");
    const L = v.levels ?? {};
    const pv = L.pivots ?? {};
    const band5 = (L.bands ?? []).find((b) => b.pct === 5);
    const underlying = item.symbol.split(":")[1];
    const canChain = Boolean(v.tags?.fno || v.tags?.index || (v.chains ?? []).length);
    const watchBtn = h("button", { type: "button", class: "small", onclick: () => addToWatchlist(item.symbol, watchBtn) }, icon("plus"), h("span", {}, "Watchlist"));
    return [
      h("div", { class: "ev-sheet-hero" }, h("strong", {}, px(v.ltp)), h("span", { class: `delta ${isFigure(v.changePct) && v.changePct < 0 ? "down" : "up"}` }, signedPct(v.changePct)), v.name ? h("small", {}, v.name) : null, L.lock ? h("span", { class: "pill warn" }, h("span", { class: "pdot" }), L.lock === "upper" ? "Only buyers" : "Only sellers") : null),
      h("h3", { class: "ev-sheet-h" }, "Key levels"),
      kv([
        ["Day high", px(L.dayHigh)],
        ["Day low", px(L.dayLow)],
        ["Prev close", px(L.prevClose)],
        ["Prev high", px(L.prevHigh)],
        ["Prev low", px(L.prevLow)],
        ["VWAP", px(L.vwap)],
        ["Pivot P", px(pv.P)],
        ["R1", px(pv.R1)],
        ["S1", px(pv.S1)],
        ["52-week high", px(L.high52)],
        ["52-week low", px(L.low52)],
        band5 ? ["5% band", `${px(band5.lower)} to ${px(band5.upper)}`] : null,
      ]),
      h("div", { class: "ev-sheet-actions" },
        canChain ? h("button", { type: "button", class: "small", onclick: () => toChain(underlying, v.chains?.[0]?.expiry ?? null, null, null) }, icon("chart"), h("span", {}, "Option Chain")) : null,
        watchBtn,
        h("button", { type: "button", class: "small btn buy", onclick: () => ticket(v.ltp === null ? item : { ...item, ltp: v.ltp }, "BUY") }, "Buy"),
        h("button", { type: "button", class: "small btn sell", onclick: () => ticket(v.ltp === null ? item : { ...item, ltp: v.ltp }, "SELL") }, "Sell"),
      ),
      h("p", { class: "muted small" }, app.state.demo ? "Orders from here are paper orders on demo prices." : "Orders from here are paper orders."),
      h("h3", { class: "ev-sheet-h" }, `Events today (${formatInt((v.events ?? []).length)})`),
      eventList(v.events ?? []),
    ];
  }

  async function optionSheet(item) {
    const o = item.option ?? {};
    const r = isFigure(o.strike) ? await optional(api(`/v1/events/chain?underlying=${encodeURIComponent(o.underlying)}&expiry=${encodeURIComponent(o.expiry)}&strike=${encodeURIComponent(o.strike)}`)) : { data: null };
    const row = r.data?.data ?? null;
    const legRow = (leg, right) =>
      h("tr", {}, h("th", { scope: "row" }, h("span", { class: `side-tag ${right === "CE" ? "buy" : "sell"}` }, right)), h("td", { class: "num" }, px(leg?.ltp)), h("td", { class: "num" }, isFigure(leg?.oi) ? formatInt(leg.oi / (row?.lot || 1)) : DASH), h("td", { class: "num" }, isFigure(leg?.oiChange) ? formatSigned(leg.oiChange / (row?.lot || 1), 0) : DASH), h("td", { class: "num" }, isFigure(leg?.iv) ? formatFixed(leg.iv, 1) : DASH));
    const s = row?.summary ?? {};
    const evs = all.filter((e) => e.option?.underlying === o.underlying && e.option?.strike === o.strike).reverse();
    const legBtn = (right, side) => h("button", { type: "button", class: `small btn ${side === "BUY" ? "buy" : "sell"}`, onclick: () => toStrategy(o.underlying, o.expiry, { right, strike: o.strike, side }) }, `${side === "BUY" ? "Buy" : "Sell"} ${right}`);
    return [
      h("div", { class: "ev-sheet-hero" }, h("strong", {}, px(row?.spot ?? item.ltp)), h("small", {}, `${o.underlying} spot · expiry ${o.expiry ?? DASH}`)),
      row
        ? h("div", { class: "table-wrap" }, h("table", { class: "desk-table ev-legs" }, h("thead", {}, h("tr", {}, ["", "LTP", "OI lots", "ΔOI lots", "IV"].map((t, i) => h("th", { scope: "col", class: i ? "num" : undefined }, t)))), h("tbody", {}, legRow(row.ce, "CE"), legRow(row.pe, "PE"))))
        : null,
      kv([
        ["ATM", isFigure(s.atm) ? formatInt(s.atm) : DASH],
        ["PCR", isFigure(s.pcr) ? formatFixed(s.pcr, 2) : DASH],
        ["Max pain", isFigure(s.maxPain) ? formatInt(s.maxPain) : DASH],
        ["Call wall", isFigure(s.callWall) ? formatInt(s.callWall) : DASH],
        ["Put wall", isFigure(s.putWall) ? formatInt(s.putWall) : DASH],
        ["ATM straddle", px(s.straddle)],
        ["ATM IV", isFigure(s.atmIv) ? `${formatFixed(s.atmIv, 1)}%` : DASH],
      ]),
      h("div", { class: "ev-sheet-actions" },
        h("button", { type: "button", class: "small", onclick: () => toChain(o.underlying, o.expiry, o.strike, o.right) }, icon("chart"), h("span", {}, "Open in Option Chain")),
        isFigure(o.strike) ? legBtn(o.right ?? "CE", "BUY") : null,
        isFigure(o.strike) ? legBtn(o.right ?? "CE", "SELL") : null,
      ),
      h("p", { class: "muted small" }, "Buy and Sell add the leg to Strategy Builder; nothing is sent from here."),
      h("h3", { class: "ev-sheet-h" }, `This strike today (${formatInt(evs.length)})`),
      eventList(evs),
    ];
  }

  const readDesk = () => {
    try {
      return JSON.parse(local.get(DESK_SLOT) ?? "null") ?? {};
    } catch {
      return {};
    }
  };
  function toChain(underlying, expiry, strike, right) {
    local.set(DESK_SLOT, JSON.stringify(handoffPrefs(readDesk(), { underlying, expiry, focus: strike === null ? null : { strike, side: right === "PE" ? "pe" : "ce" } })));
    document.querySelector("#dialog .sheet-close")?.click();
    location.hash = "#/chain";
  }
  function toStrategy(underlying, expiry, leg) {
    local.set(DESK_SLOT, JSON.stringify(handoffPrefs(readDesk(), { underlying, expiry, leg: { ...leg, lots: 1 } })));
    toast(`${leg.side === "BUY" ? "Buy" : "Sell"} ${formatInt(leg.strike)} ${leg.right} added to Strategy Builder`);
    document.querySelector("#dialog .sheet-close")?.click();
    location.hash = "#/strategy";
  }
  async function addToWatchlist(symbol, btn) {
    const r = await optional(api("/v1/events/selection"));
    const sel = r.data?.data;
    if (!sel) return toast(r.error?.message ?? "Could not read the selection.", { tone: "bad" });
    if (sel.watchlist.includes(symbol)) return toast("Already on the watchlist");
    const w = await optional(api("/v1/events/selection", { method: "PUT", body: { ...sel, watchlist: [...sel.watchlist, symbol], universes: sel.universes.includes("WATCHLIST") ? sel.universes : [...sel.universes, "WATCHLIST"] } }));
    if (w.error) return toast(w.error.message, { tone: "bad" });
    btn.disabled = true;
    toast(`${symbol.split(":")[1]} added to the events watchlist`);
  }

  // ── Event picker ──
  pickBtn.addEventListener("click", async () => {
    const r = await optional(api("/v1/events/selection"));
    if (r.error) return toast(r.error.message, { tone: "bad" });
    let sel = r.data.data;
    const host = h("div", { class: "ev-picker" });
    const draw = () => {
      const presets = catalogue.presets.filter((p) => p.asset === f.asset);
      fill(
        host,
        h("p", { class: "muted small" }, "Choose the events the Bridge tracks. They are saved on the Bridge and run with the browser closed."),
        h("div", { class: "ev-presets chips", role: "group", "aria-label": "Presets" }, presets.map((p) => h("button", { type: "button", class: "small chip-btn", "aria-pressed": "false", onclick: () => ((sel = applyPreset(sel, p, catalogue)), draw()) }, p.label))),
        catalogue.categories
          .filter((c) => c.asset === f.asset)
          .map((c) =>
            h(
              "fieldset",
              { class: "ev-cat" },
              h("legend", {}, c.label),
              catalogue.kinds
                .filter((k) => k.category === c.id)
                .map((k) => {
                  const cur = sel.kinds[k.kind] ?? { on: false, params: {} };
                  const box = h("input", { type: "checkbox", checked: cur.on ? "" : undefined });
                  box.addEventListener("change", () => (sel.kinds[k.kind] = { ...cur, on: box.checked }));
                  const params = k.params.map((p) => {
                    const v = cur.params?.[p.key] ?? p.default;
                    const inp = h("input", { type: Array.isArray(p.default) ? "text" : "number", value: Array.isArray(v) ? v.join(", ") : String(v), min: Array.isArray(p.default) ? undefined : String(p.min), max: Array.isArray(p.default) ? undefined : String(p.max), step: Array.isArray(p.default) ? undefined : String(p.step), inputmode: "decimal", "aria-label": `${k.label}: ${p.label}` });
                    inp.addEventListener("change", () => {
                      const val = Array.isArray(p.default) ? inp.value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : Number(inp.value);
                      sel.kinds[k.kind] = { ...(sel.kinds[k.kind] ?? cur), params: { ...(sel.kinds[k.kind]?.params ?? cur.params), [p.key]: val } };
                    });
                    return h("label", { class: "ev-param" }, h("span", {}, p.label), inp, p.unit ? h("small", {}, p.unit) : null);
                  });
                  return h("div", { class: "ev-kindrow" }, h("label", { class: "check" }, box, h("span", {}, h("strong", {}, k.label), h("small", {}, k.def))), params.length ? h("div", { class: "ev-params" }, params) : null);
                }),
            ),
          ),
      );
    };
    draw();
    const d = document.getElementById("dialog");
    d.classList.add("ev-sheet");
    await modal({
      title: f.asset === "option" ? "Option events" : "Stock events",
      body: host,
      buttons: [
        { label: "Cancel", cls: "plain", value: false },
        {
          label: "Save",
          cls: "primary",
          onClick: async () => {
            const w = await optional(api("/v1/events/selection", { method: "PUT", body: sel }));
            if (w.error) {
              toast(w.error.message, { tone: "bad" });
              return false;
            }
            toast("Event selection saved");
            return true;
          },
        },
      ],
    });
    d.classList.remove("ev-sheet");
  });

  // ── Custom conditions ──
  condBtn.addEventListener("click", async () => {
    const host = h("div", { class: "ev-conds" });
    const name = h("input", { type: "text", maxlength: "60", placeholder: "Strong close", "aria-label": "Condition name" });
    const expr = h("textarea", { rows: 3, spellcheck: "false", placeholder: "close = high and close > pclose and close > open and close > pivot", "aria-label": "Condition" });
    const side = segmented("Side", [["neutral", "Neutral"], ["bull", "Bull"], ["bear", "Bear"]], "neutral");
    const err = h("p", { class: "bad-text small", hidden: true });
    const listEl = h("ul", { class: "ev-cond-list" });
    const load = async () => {
      const r = await optional(api("/v1/events/conditions"));
      const list = r.data?.data ?? [];
      fill(
        listEl,
        list.length
          ? list.map((c) =>
              h(
                "li",
                {},
                h("span", {}, h("strong", {}, c.name), h("code", {}, c.expr)),
                h("span", { class: `ev-chip ${c.side}` }, c.side === "bull" ? "Bull" : c.side === "bear" ? "Bear" : "Neutral"),
                h("button", { type: "button", class: "small plain", "aria-label": `Delete ${c.name}`, onclick: async () => {
                  const d = await optional(api(`/v1/events/conditions/${encodeURIComponent(c.id)}`, { method: "DELETE" }));
                  if (d.error) return toast(d.error.message, { tone: "bad" });
                  load();
                } }, icon("close")),
              ),
            )
          : h("li", { class: "muted" }, "No conditions yet."),
      );
    };
    const add = h("button", { type: "button", class: "small primary" }, "Add condition");
    add.addEventListener("click", async () => {
      err.hidden = true;
      const r = await optional(api("/v1/events/conditions", { method: "POST", body: { name: name.value.trim(), expr: expr.value, side: side.value } }));
      if (r.error) {
        err.textContent = r.error.message;
        err.hidden = false;
        return;
      }
      name.value = "";
      expr.value = "";
      load();
      toast("Condition added: it fires when it turns true on a tick");
    });
    fill(
      host,
      h("p", { class: "muted small" }, "Live fields: ltp (close), open, high, low, pclose, phigh, plow, pivot, vwap, volume, avgvol20, changepct. A condition fires when it turns true; matches show as Custom condition events. Adding and deleting needs an admin key on this computer."),
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "Condition"), expr),
      h("div", { class: "field" }, h("span", {}, "Side"), side),
      err,
      h("div", { class: "ev-sheet-actions" }, add),
      h("h3", { class: "ev-sheet-h" }, "Your conditions"),
      listEl,
    );
    load();
    const d = document.getElementById("dialog");
    d.classList.add("ev-sheet");
    await modal({ title: "Custom conditions", body: host, buttons: [] });
    d.classList.remove("ev-sheet");
  });

  // ── Stream ──
  const connPill = h("span", { class: "pill tiny ev-conn" }, h("span", { class: "pdot" }), "Connecting");
  // Events arrive on the tab's one live connection (live.js), shared with the budget capsule and any page watching
  // symbols: no second WebSocket and no second stream token.
  const setConn = (text, tone) => {
    connPill.className = `pill tiny ev-conn ${tone}`;
    connPill.replaceChildren(h("span", { class: "pdot" }), text);
  };
  const showState = (s) => (s === "live" ? setConn("Live", "ok") : s === "down" ? setConn("Reconnecting", "warn") : setConn("Connecting", ""));
  /** After a reconnect: fetch what was missed, once. */
  async function catchUp() {
    const r = await optional(api(`/v1/events?since=${lastSeq}&limit=5000`));
    for (const ev of (r.data?.data ?? []).reverse()) accept("new", ev);
  }
  const offEvents = onMarketEvents((msg) => accept(msg.action, msg.event), { onReconnect: () => catchUp() });
  const offState = onLiveState(showState);
  showState(liveState());
  const stop = () => {
    offEvents();
    offState();
    window.removeEventListener("hashchange", onHash);
  };
  const onHash = () => {
    if (!/^#\/?(screeners\/events|events)\b/.test(location.hash)) stop();
  };
  window.addEventListener("hashchange", onHash);

  mountToolbarCtx("events", h("div", { class: "ctx-cap glass" }, h("span", { class: "ctx-item ev-ctx" }, h("span", { class: "ctx-main" }, "Live events"), connPill)), h("span", { class: "ctx-spacer" }));

  const controls = h(
    "div",
    { class: "ev-controls" },
    h("div", { class: "ev-ctl-row" }, assetSeg, sideSeg, modeSeg, kindSel, search, minPx),
    h("div", { class: "ev-ctl-row ev-ctl-actions" }, pauseBtn, soundBtn, notifyBtn, pickBtn, condBtn, csvBtn),
  );
  const panel = h("section", { class: "desk-panel ev-panel", "aria-label": "Live events" }, controls, strip, scroller, empty, liveNote);
  drawStrip();
  drawHead();
  requestAnimationFrame(() => rebuild());
  return [panel];
}
