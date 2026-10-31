// right-rail.js: the right rail on wide screens (1024 px and up). A slim floating icon card on the right edge, drawn
// like the sidebar, that opens one tool at a time in a side panel: Watchlist, Option chain (a mini chain around ATM),
// Market depth, Positions, Super Alerts, Sector heatmap and Customise (which tools show, in what order). The panel
// narrows the page when the window has room for both, and floats over the page's right side when it has not; when
// the page is tight (a 1280 px laptop beside the sidebar) the rail folds to a thin handle on the right edge, so the
// option chain keeps every column. Remembered per browser (localStorage). Phones and tablets have no rail.
//
// Keys: Shift+O opens or closes the option chain panel; in the rail, the arrow keys move between tools and Enter or
// Space opens one; Esc in a panel closes it and returns to its tool.
//
// Reads and lists only, apart from the alerts it creates and switches: a price in the mini chain opens the order
// ticket on the Option Chain page (the same hand-off as the command palette), which places nothing by itself and is
// paper unless the account's live opt-ins say otherwise. Numbers become text through format.js; the maths is
// right-rail-core.js (pure, tested).
import { api, app, h, icon, optional, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatGrouped, formatInt, formatSigned, formatSignedPercent, formatSignedRupee, isFigure } from "./format.js";
import { CUSTOMISE, PANEL_W, RAIL_TOOLS, groupBySector, heatStep, heatmapLayout, mergeMovers, miniChainRows, moveTool, normalizeRail, pctMoveLevel, railLayout, railToStore, setToolHidden, toggleTool, toolInfo, visibleTools } from "./right-rail-core.js";
import { sectorLabel } from "./sector-map.js";
import { depthView } from "./orders-core.js";
import { symbolParts } from "./alert-core.js";
import { intentHandoff } from "./trade-intent.js";
import { heatCell } from "./viz.js";
import { workspace } from "./workspace.js";

const SLOT = "mcb.dashboard.rightRail";
const DESK = "mcb.dashboard.desk";
const HANDOFF = "mcb.dashboard.tradeHandoff";
const enc = encodeURIComponent;

/** The tools' glyphs: small stroked SVGs (static strings), drawn like the sidebar's. */
const GLYPHS = {
  watchlist: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="m3.5 6 .9.9L6 5.3M3.5 12l.9.9L6 11.3M3.5 18l.9.9L6 17.3"/>',
  chain: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16M3 9.5h18M3 14.5h18"/>',
  depth: '<path d="M4 6h7M4 10h5M4 14h8M4 18h4"/><path d="M20 6h-5M20 10h-7M20 14h-4M20 18h-8"/>',
  positions: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M3 12h18"/>',
  alerts: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M19.5 4.5l1.5-1.5M4.5 4.5 3 3"/>',
  heatmap: '<rect x="3" y="3" width="10" height="10" rx="1.5"/><rect x="15" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="11" width="6" height="10" rx="1.5"/><rect x="3" y="15" width="10" height="6" rx="1.5"/>',
  customise: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  edge: '<path d="m14 6-6 6 6 6"/>',
};
function glyph(id) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  s.innerHTML = GLYPHS[id] ?? "";
  return s;
}

const tone = (v) => (isFigure(v) && Number(v) > 0 ? "up" : isFigure(v) && Number(v) < 0 ? "down" : "flat");
const price = (v) => (!isFigure(v) ? DASH : Math.abs(Number(v)) >= 1000 ? formatGrouped(v, 2) : formatFixed(v, 2));
const pctText = (v) => (isFigure(v) ? formatSignedPercent(v, 2) : DASH);
/** Replace children, skipping the empty ones. */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const readJson = (slot) => {
  try {
    const v = JSON.parse(app.local.get(slot) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
/** The underlying the Options pages are on (their shared state), else the Analytics pages' context. */
const pageUnderlying = () => {
  const d = readJson(DESK);
  return typeof d.underlying === "string" && d.underlying ? d.underlying : workspace.state.underlying || "NIFTY";
};
const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

// ── State ──

let st = normalizeRail(app.local.get(SLOT));
const save = () => app.local.set(SLOT, railToStore(st));
/** A tool's own memory (the watchlist picked, the depth symbol, the heatmap's sizing), kept with the rail's state. */
const mem = (key, value) => {
  if (value === undefined) return st[key];
  st = { ...st, [key]: value };
  save();
  return value;
};

// ── The shell: rail, edge handle, panel ──

let rail = null;
let bar = null;
let edge = null;
let panel = null;
let titleEl = null;
let actsEl = null;
let bodyEl = null;
let tip = null;
let running = null; // { id, stop() }
let mode = { rail: "off", panel: null };
let peek = false;
let animTimer = 0;

/** Mount the rail once after sign-in (app.js). */
export function mountRightRail() {
  if (rail || typeof document === "undefined") return;
  const shell = document.getElementById("app");
  if (!shell) return;
  bar = h("div", { class: "rr-bar", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Tools" });
  rail = h("aside", { id: "rrail", class: "rrail", "aria-label": "Tools" }, bar);
  edge = h("button", { type: "button", class: "rr-edge", "aria-label": "Show the tools", "aria-controls": "rrail", "aria-expanded": "false", title: "Tools" }, glyph("edge"));
  titleEl = h("h2", { id: "rr-title", class: "rr-title" });
  actsEl = h("div", { class: "rr-acts" });
  bodyEl = h("div", { class: "rr-body" });
  const close = h("button", { type: "button", class: "rr-close", "aria-label": "Close the panel", title: "Close (Esc)" }, icon("close"));
  close.addEventListener("click", () => openTool(null, { focusTool: true }));
  panel = h("section", { id: "rr-panel", class: "rr-panel", role: "region", "aria-labelledby": "rr-title", hidden: true }, h("header", { class: "rr-head" }, h("span", { class: "rr-head-glyph", "aria-hidden": "true" }), titleEl, close), actsEl, bodyEl);
  tip = h("div", { class: "sb-tip rr-tip", "aria-hidden": "true", hidden: true });
  shell.append(edge, rail, panel, tip);
  drawBar();
  wire();
  layout();
  if (st.open) openTool(st.open, { restore: true });
}

function drawBar() {
  const ids = visibleTools(st);
  const btns = ids.map((id) => {
    const t = toolInfo(id);
    const b = h("button", { type: "button", class: `rr-btn tint-${t.tint}${id === CUSTOMISE.id ? " rr-btn-cz" : ""}`, "data-tool": id, "aria-label": t.label, "aria-controls": "rr-panel", "aria-expanded": String(st.open === id), "aria-keyshortcuts": t.key, "data-tip": t.label, "data-tip-key": t.key, tabindex: "-1" }, glyph(id));
    b.addEventListener("click", () => openTool(st.open === id ? null : id, { focusPanel: false }));
    return b;
  });
  const sep = h("span", { class: "rr-sep", role: "separator", "aria-hidden": "true" });
  fill(bar, btns.slice(0, -1), sep, btns.at(-1));
  const cur = btns.find((b) => b.dataset.tool === st.open) ?? btns[0];
  if (cur) cur.tabIndex = 0;
}
const toolButtons = () => [...bar.querySelectorAll("button.rr-btn")];

function wire() {
  // Roving focus in the rail: the arrow keys, Home and End move; Enter and Space are the buttons' own.
  bar.addEventListener("keydown", (e) => {
    const list = toolButtons();
    const i = list.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const j = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
    if (j === null || i < 0) return;
    e.preventDefault();
    const k = (j + list.length) % list.length;
    list.forEach((b, n) => (b.tabIndex = n === k ? 0 : -1));
    list[k].focus();
  });
  bar.addEventListener("focusin", (e) => {
    const b = /** @type {Element} */ (e.target).closest?.("button.rr-btn");
    if (b) toolButtons().forEach((x) => (x.tabIndex = x === b ? 0 : -1));
  });
  // The tooltip beside the hovered or focused tool (the sidebar's look, on the left of the rail).
  const showTip = (b) => {
    if (!b || !tip) return;
    const key = b.dataset.tipKey;
    fill(tip, h("span", {}, b.dataset.tip), key ? h("kbd", {}, key) : null);
    tip.hidden = false;
    const r = b.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.round(r.left - w - 10)}px`;
    tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
    requestAnimationFrame(() => tip.classList.add("on"));
  };
  const hideTip = () => {
    if (!tip) return;
    tip.classList.remove("on");
    tip.hidden = true;
  };
  bar.addEventListener("pointerover", (e) => showTip(/** @type {Element} */ (e.target).closest?.("button.rr-btn")));
  bar.addEventListener("pointerleave", hideTip);
  bar.addEventListener("focusin", (e) => /** @type {HTMLElement} */ (e.target).matches?.(":focus-visible") && showTip(/** @type {Element} */ (e.target).closest("button.rr-btn")));
  bar.addEventListener("focusout", hideTip);
  bar.addEventListener("click", hideTip);
  // The thin edge: hover or focus shows the rail over the page; it folds back when the pointer and focus leave.
  let leaveTimer = 0;
  const setPeek = (on) => {
    clearTimeout(leaveTimer);
    if (peek === on) return;
    peek = on;
    edge.setAttribute("aria-expanded", String(on));
    applyAttrs();
  };
  edge.addEventListener("pointerenter", () => setPeek(true));
  edge.addEventListener("click", () => {
    setPeek(true);
    (toolButtons().find((b) => b.tabIndex === 0) ?? toolButtons()[0])?.focus();
  });
  for (const el of [rail, panel]) {
    el.addEventListener("pointerenter", () => clearTimeout(leaveTimer));
    el.addEventListener("pointerleave", () => {
      if (mode.rail !== "edge" || st.open) return;
      leaveTimer = setTimeout(() => !rail.contains(document.activeElement) && setPeek(false), 360);
    });
  }
  edge.addEventListener("pointerleave", () => {
    leaveTimer = setTimeout(() => !rail.matches(":hover") && !rail.contains(document.activeElement) && setPeek(false), 360);
  });
  rail.addEventListener("focusout", (e) => {
    if (mode.rail === "edge" && !st.open && !rail.contains(/** @type {Node} */ (e.relatedTarget))) setPeek(false);
  });
  // Esc: in a panel it closes the panel and goes back to its tool; on a peeking rail it folds the rail.
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    e.stopPropagation();
    openTool(null, { focusTool: true });
  });
  rail.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || st.open || mode.rail !== "edge") return;
    setPeek(false);
    edge.focus();
  });
  // Shift+O: the option chain panel (a capital O, so it never clashes with a page's own o key or the symbol search).
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "O" || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing || e.defaultPrevented) return;
      if (mode.rail === "off" || typing(e.target) || document.querySelector("dialog[open], .sym-search, .popover.floating")) return;
      e.preventDefault();
      e.stopPropagation();
      if (st.hidden.includes("chain")) st = setToolHidden(st, "chain", false);
      openTool(st.open === "chain" ? null : "chain", { focusPanel: true, focusTool: st.open === "chain" });
    },
    true,
  );
  // A window resize or the sidebar's toggle (app.js applyLayout sets data-sb) changes the room the page has. When that
  // moves the rail or the panel, the page is told once more so what measures itself (the chain) fits the new width.
  const onRoom = () => {
    const changed = layout();
    if (mode.rail === "off" && running) stopRunning();
    else if (mode.rail !== "off" && st.open && !running) openTool(st.open, { restore: true });
    if (changed) requestAnimationFrame(() => dispatchEvent(new Event("resize")));
  };
  // Once now and once on the next frame: an emulated or zoomed viewport can report its new width a frame late.
  addEventListener("resize", () => (onRoom(), requestAnimationFrame(onRoom)), { passive: true });
  if (typeof matchMedia === "function") matchMedia("(min-width: 1024px)").addEventListener?.("change", onRoom);
  // A viewport change that sends no resize event (device emulation, some zoom paths) still reaches the root's box.
  let lastW = innerWidth;
  if (typeof ResizeObserver === "function") new ResizeObserver(() => innerWidth !== lastW && ((lastW = innerWidth), onRoom())).observe(document.documentElement);
  new MutationObserver(onRoom).observe(document.documentElement, { attributes: true, attributeFilter: ["data-sb"] });
  // Leaving a page with an overlay panel open keeps it (it is a tool, not part of the page).
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && running?.wake?.());
}

/** Work out where the rail and panel go; when the page's width changes, tell what measures itself (the chain). */
function layout() {
  if (!rail) return;
  const width = innerWidth;
  const sb = document.getElementById("sidebar");
  const sbRight = sb && getComputedStyle(sb).display !== "none" ? sb.getBoundingClientRect().right : 0;
  const next = railLayout({ width, pageW: width - sbRight, open: Boolean(st.open), place: st.place });
  const changed = next.rail !== mode.rail || next.panel !== mode.panel;
  mode = next;
  if (mode.rail !== "edge") peek = false;
  applyAttrs();
  return changed;
}

function applyAttrs() {
  const root = document.documentElement;
  const set = (k, v) => (v === null ? root.removeAttribute(k) : root.getAttribute(k) !== v && root.setAttribute(k, v));
  set("data-rr", mode.rail);
  set("data-rr-panel", mode.rail === "off" ? null : mode.panel);
  set("data-rr-peek", mode.rail === "edge" && (peek || st.open) ? "" : null);
  edge.hidden = mode.rail !== "edge";
  panel.hidden = mode.rail === "off" || !st.open;
}

/** Re-fit the page after the panel pushed it or let it go (the sidebar's toggle does the same). */
function relayoutPage() {
  const root = document.documentElement;
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce) root.dataset.rrAnim = "";
  clearTimeout(animTimer);
  animTimer = setTimeout(
    () => {
      root.removeAttribute("data-rr-anim");
      dispatchEvent(new Event("resize"));
    },
    reduce ? 0 : 340,
  );
}

function stopRunning() {
  try {
    running?.stop?.();
  } catch {
    // A tool that fails to stop must not keep the rail from closing.
  }
  running = null;
}

/**
 * Open a tool's panel (or close the panel with null).
 * @param {string|null} id
 * @param {{ focusPanel?: boolean, focusTool?: boolean, restore?: boolean }} [o]
 */
function openTool(id, { focusPanel = false, focusTool = false, restore = false } = {}) {
  if (!rail) return;
  const was = st.open;
  if (!restore) {
    st = id === null ? { ...st, open: null } : toggleTool({ ...st, open: null }, id);
    save();
  }
  for (const b of toolButtons()) b.setAttribute("aria-expanded", String(b.dataset.tool === st.open));
  const before = { ...mode };
  layout();
  if (before.panel !== mode.panel && (before.panel === "push" || mode.panel === "push")) relayoutPage();
  if (restore && running?.id === st.open) return;
  stopRunning();
  if (!st.open) {
    if (focusTool && was) toolButtons().find((b) => b.dataset.tool === was)?.focus();
    return;
  }
  if (mode.rail === "off") return;
  const t = toolInfo(st.open);
  titleEl.textContent = t.label;
  panel.dataset.tool = t.id;
  panel.querySelector(".rr-head-glyph").replaceChildren(glyph(t.id));
  panel.querySelector(".rr-head-glyph").className = `rr-head-glyph tint-${t.tint}`;
  fill(actsEl);
  fill(bodyEl);
  const tool = TOOLS[t.id];
  running = { id: t.id, ...(tool ? tool({ body: bodyEl, acts: actsEl }) : {}) };
  if (focusPanel) requestAnimationFrame(() => (panel.querySelector(".rr-acts select, .rr-acts input, .rr-body button, .rr-body select, .rr-body input") ?? panel.querySelector(".rr-close"))?.focus());
}

/**
 * Poll while the panel is open and the tab is in view: `fn` now, then every `ms`. Returns stop() and wake().
 * @param {() => Promise<void>|void} fn
 */
function poll(fn, ms) {
  let timer = 0;
  let stopped = false;
  const tick = async () => {
    clearTimeout(timer);
    if (stopped) return;
    if (document.visibilityState === "visible") {
      try {
        await fn();
      } catch {
        // A failed read shows in the tool; the next tick tries again.
      }
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  tick();
  return { stop: () => ((stopped = true), clearTimeout(timer)), wake: () => tick() };
}

const note = (text, cls = "") => h("p", { class: `rr-note ${cls}`.trim() }, text);
const footLink = (text, href, onclick) => h("a", { class: "rr-foot-link", href, onclick }, text, icon("chevron"));
const sel = (label, options, value) => {
  const el = h("select", { class: "rr-sel", "aria-label": label }, options.map(([v, t]) => h("option", { value: v }, t)));
  if (value !== undefined && value !== null) el.value = String(value);
  return el;
};

// ── Watchlist ──

function watchlistTool({ body, acts }) {
  const pick = sel("Watchlist", []);
  const list = h("ul", { class: "rr-list", "aria-label": "Watchlist prices" });
  const status = note("");
  fill(acts, h("div", { class: "rr-row-acts" }, pick));
  fill(body, list, status, footLink("Open Watchlists", "#/screeners/watchlists"));
  let lists = [];
  let cells = new Map();
  let sig = "";
  const cur = () => lists.find((l) => l.id === pick.value) ?? null;
  pick.addEventListener("change", () => {
    mem("wl", pick.value);
    sig = "";
    p?.wake();
  });
  const draw = (rows) => {
    const s = rows.map((r) => r.symbol).join(",");
    if (s !== sig) {
      sig = s;
      cells = new Map();
      fill(
        list,
        rows.map((r) => {
          const ltp = h("span", { class: "rr-num" });
          const chg = h("span", { class: "rr-chg" });
          cells.set(r.symbol, { ltp, chg });
          return h(
            "li",
            {},
            h(
              "button",
              { type: "button", class: "rr-item", "aria-label": `${r.name}: readouts, chart and depth`, onclick: () => import("./pulse.js").then((m) => m.openSymbolSheet(r.symbol)) },
              h("span", { class: "rr-name" }, h("strong", {}, r.name), h("small", {}, r.symbol.split(":")[0])),
              ltp,
              chg,
            ),
          );
        }),
      );
    }
    for (const r of rows) {
      const c = cells.get(r.symbol);
      if (!c) continue;
      c.ltp.textContent = price(r.ltp);
      c.chg.textContent = pctText(r.changePct);
      c.chg.className = `rr-chg ${tone(r.changePct)}`;
    }
  };
  const p = poll(async () => {
    if (!lists.length) {
      const r = await optional(api("/v1/watchlists"));
      if (r.error) return fill(list, h("li", {}, note(`Watchlists are not available: ${r.error.message}`)));
      lists = r.data.data.items ?? [];
      if (!lists.length) return fill(list, h("li", {}, note("No watchlists yet. Make one on the Watchlists page.")));
      fill(pick, lists.map((l) => h("option", { value: l.id }, l.name)));
      pick.value = lists.some((l) => l.id === mem("wl")) ? mem("wl") : lists[0].id;
    }
    const l = cur();
    if (!l) return;
    if (!l.symbols.length) return fill(list, h("li", {}, note(`${l.name} has no symbols yet.`)));
    const r = await optional(api(`/v1/watchlists/${enc(l.id)}/quotes`, { fresh: true }));
    if (pick.value !== l.id) return;
    if (r.error) return void (status.textContent = `Not refreshed: ${r.error.message}`);
    draw(r.data.data?.rows ?? []);
    status.textContent = "Prices every 5 s while this panel is open.";
  }, 5000);
  return p;
}

// ── Option chain (mini) ──

/** Open the order ticket for one contract on the Option Chain page (the palette's hand-off, trade-intent.js). */
function openTicket({ underlying, expiry, strike, right }) {
  const desk = readJson(DESK);
  const go = intentHandoff({ kind: "leg", underlying, strike, right, side: "BUY", lots: 1 }, { expiry, desk, nowHash: location.hash });
  app.local.set(DESK, JSON.stringify(go.prefs));
  app.local.set(HANDOFF, JSON.stringify({ underlying: go.prefs.underlying, expiry: go.prefs.expiry, jump: go.prefs.jump, ticket: go.prefs.ticket }));
  location.hash = go.hash;
}

/** The expiries of an underlying (a 30 s old list answers at once; it changes once a day). */
async function expiriesOf(u) {
  const r = await optional(api(`/v1/expiries?underlying=${enc(u)}`, { paintOld: true }));
  return r.error ? { error: r.error, list: [] } : { list: r.data.data?.expiries ?? [] };
}

function chainTool({ body, acts }) {
  const deskU = pageUnderlying();
  // The rail follows the page's underlying; picking another here points the rail elsewhere until the page changes.
  if (mem("chainFollow") !== deskU) {
    mem("chainFollow", deskU);
    mem("chainU", deskU);
  }
  const uSel = sel("Underlying", [[mem("chainU"), mem("chainU")]], mem("chainU"));
  const eSel = sel("Expiry", []);
  fill(acts, h("div", { class: "rr-row-acts" }, uSel, eSel));
  const spot = h("div", { class: "rr-spot" });
  const table = h("table", { class: "rr-chain" });
  const status = note("");
  fill(body, spot, h("div", { class: "rr-chain-wrap" }, table), status, footLink("Open the full chain", "#/chain", () => setDesk()));
  (async () => {
    const { UNDERLYINGS, DEMO_UNDERLYINGS } = await import("./desk.js");
    const base = app.state.demo ? DEMO_UNDERLYINGS : UNDERLYINGS;
    const list = base.includes(mem("chainU")) ? base : [...base, mem("chainU")];
    fill(uSel, list.map((u) => h("option", { value: u }, u)));
    uSel.value = mem("chainU");
  })().catch(() => {});
  const setDesk = () => {
    const d = readJson(DESK);
    app.local.set(DESK, JSON.stringify({ ...d, underlying: uSel.value, expiry: eSel.value || null }));
  };
  let expiries = [];
  let cellMap = new Map();
  let sig = "";
  const loadExpiries = async () => {
    const u = uSel.value;
    const r = await expiriesOf(u);
    if (uSel.value !== u) return false;
    expiries = r.list.slice(0, 8);
    const want = readJson(DESK).underlying === u ? readJson(DESK).expiry : null;
    fill(eSel, expiries.map((e) => h("option", { value: e }, e)));
    if (expiries.includes(want)) eSel.value = want;
    if (!expiries.length) {
      fill(table);
      status.textContent = r.error ? `Expiries are not available: ${r.error.message}` : `No upcoming expiries for ${u}.`;
    }
    sig = "";
    return expiries.length > 0;
  };
  uSel.addEventListener("change", async () => {
    mem("chainU", uSel.value);
    if (await loadExpiries()) p.wake();
  });
  eSel.addEventListener("change", () => ((sig = ""), p.wake()));
  const legCell = (leg, strike, right, itm) => {
    const ltp = h("button", { type: "button", class: "rr-ltp", "aria-label": `${formatInt(strike)} ${right}: open the order ticket` });
    ltp.addEventListener("click", () => openTicket({ underlying: uSel.value, expiry: eSel.value, strike, right }));
    const bar = h("i", { class: `rr-oi-bar ${right === "CE" ? "call" : "put"}`, "aria-hidden": "true" });
    const oi = h("span", { class: "rr-oi-v" });
    const oiTd = h("td", { class: `rr-oi${itm ? " itm" : ""}` }, bar, oi);
    const ltpTd = h("td", { class: `rr-px${itm ? " itm" : ""}` }, ltp);
    return { ltp, bar, oi, oiTd, ltpTd, leg };
  };
  const draw = (chain) => {
    const m = miniChainRows(chain, 5);
    const s = `${chain.underlying}|${chain.expiry}|${m.rows.map((r) => r.strike).join(",")}`;
    fill(spot, h("span", {}, chain.underlying), h("strong", { class: "rr-num" }, price(m.spot)), h("small", {}, `Lot ${formatInt(chain.lotSize)}`));
    if (!m.rows.length) {
      fill(table);
      status.textContent = "No strikes listed for this expiry yet.";
      return;
    }
    if (s !== sig) {
      sig = s;
      cellMap = new Map();
      const rows = m.rows.map((r) => {
        const c = legCell(r.ce, r.strike, "CE", r.ceItm);
        const pe = legCell(r.pe, r.strike, "PE", r.peItm);
        cellMap.set(r.strike, { c, pe });
        return h("tr", { class: r.atm ? "atm" : undefined }, c.oiTd, c.ltpTd, h("th", { scope: "row", class: "rr-k" }, h("span", {}, formatInt(r.strike))), pe.ltpTd, pe.oiTd);
      });
      fill(
        table,
        h("caption", { class: "pal-sr-only" }, `${chain.underlying} ${chain.expiry}: calls and puts, five strikes either side of ATM`),
        h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "rr-oi" }, "OI"), h("th", { scope: "col", class: "rr-px call" }, "Calls"), h("th", { scope: "col", class: "rr-k" }, "Strike"), h("th", { scope: "col", class: "rr-px put" }, "Puts"), h("th", { scope: "col", class: "rr-oi" }, "OI"))),
        h("tbody", {}, rows),
      );
    }
    for (const r of m.rows) {
      const c = cellMap.get(r.strike);
      if (!c) continue;
      for (const [cell, leg] of [
        [c.c, r.ce],
        [c.pe, r.pe],
      ]) {
        cell.ltp.textContent = leg ? price(leg.ltp) : DASH;
        cell.ltp.disabled = !leg;
        cell.oi.textContent = leg && isFigure(leg.oi) ? formatCompact(leg.oi) : DASH;
        cell.bar.style.setProperty("--w", String(leg?.oiShare ?? 0));
      }
    }
    status.textContent = `${touch()} a price to open its order ticket on the Option Chain page. Paper unless your live opt-ins say otherwise.`;
  };
  const p = poll(async () => {
    if (!expiries.length && !(await loadExpiries())) return;
    const u = uSel.value;
    const e = eSel.value;
    const r = await optional(api(`/v1/optionchain?underlying=${enc(u)}&expiry=${enc(e)}&strikes=12&greeks=false`));
    if (uSel.value !== u || eSel.value !== e) return;
    if (r.error) return void (status.textContent = `The chain is not available: ${r.error.message}`);
    draw(r.data.data);
  }, 3000);
  return p;
}
const touch = () => (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches ? "Tap" : "Click");

// ── Market depth ──

const normSym = (s) => {
  const t = String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return "";
  return t.includes(":") ? t : `NSE:${t}`;
};

function depthTool({ body, acts }) {
  const input = h("input", { type: "text", class: "rr-in", value: mem("depthSym") ?? "NSE:RELIANCE", "aria-label": "Symbol", placeholder: "Symbol, e.g. RELIANCE", autocomplete: "off", spellcheck: "false", autocapitalize: "characters" });
  const go = h("button", { type: "button", class: "small" }, "Show");
  fill(acts, h("form", { class: "rr-row-acts", onsubmit: (e) => (e.preventDefault(), setSym(input.value)) }, input, go));
  go.addEventListener("click", () => setSym(input.value));
  const recent = h("div", { class: "rr-chips", role: "group", "aria-label": "Recent symbols" });
  const sum = h("div", { class: "rr-depth-sum" });
  const ladder = h("div", { class: "bk-depth-body rr-depth" });
  const status = note("");
  const full = footLink("Full depth ladder", "#/screeners/depth");
  fill(body, recent, sum, ladder, status, full);
  let sym = normSym(input.value);
  const drawRecent = () => {
    const list = (Array.isArray(mem("depthRecent")) ? mem("depthRecent") : []).filter((s) => s !== sym).slice(0, 5);
    fill(recent, list.map((s) => h("button", { type: "button", class: "chip-btn", onclick: () => setSym(s) }, s.split(":").pop())));
    recent.hidden = !list.length;
  };
  const setSym = (s) => {
    const n = normSym(s);
    if (!n) return;
    const prev = sym;
    sym = n;
    input.value = n;
    mem("depthSym", n);
    if (prev && prev !== n) mem("depthRecent", [prev, ...(Array.isArray(mem("depthRecent")) ? mem("depthRecent") : []).filter((x) => x !== prev && x !== n)].slice(0, 6));
    full.setAttribute("href", `#/screeners/depth?symbol=${enc(n)}`);
    drawRecent();
    p.wake();
  };
  full.setAttribute("href", `#/screeners/depth?symbol=${enc(sym)}`);
  drawRecent();
  const draw = (d) => {
    const v = depthView(d, 5);
    const share = h("span", { class: "bk-depth-share", "aria-hidden": "true" });
    share.style.setProperty("--w", v.bidShare === null ? "0.5" : String(v.bidShare));
    fill(sum, h("strong", {}, sym.split(":").pop()), h("span", { class: "rr-depth-tot" }, h("span", { class: "bid" }, `Bid ${formatInt(v.totalBid)}`), share, h("span", { class: "ask" }, `Ask ${formatInt(v.totalAsk)}`)));
    if (!v.rows.length) return fill(ladder, note("No depth for this symbol from the connected source."));
    const bar = (qty, cls) => {
      const el = h("span", { class: `bk-depth-bar ${cls}`, "aria-hidden": "true" });
      el.style.setProperty("--w", v.maxQty ? String(Number(qty) / v.maxQty) : "0");
      return el;
    };
    const cell = (l, side) =>
      l
        ? h(
            "span",
            { class: `bk-depth-lvl ${side}` },
            bar(l.qty, side),
            side === "bid" ? h("span", { class: "bk-depth-o" }, isFigure(l.orders) ? formatInt(l.orders) : DASH) : null,
            side === "bid" ? h("span", { class: "bk-depth-q" }, formatInt(l.qty)) : null,
            h("span", { class: "bk-depth-p" }, formatFixed(l.price, 2)),
            side === "ask" ? h("span", { class: "bk-depth-q" }, formatInt(l.qty)) : null,
            side === "ask" ? h("span", { class: "bk-depth-o" }, isFigure(l.orders) ? formatInt(l.orders) : DASH) : null,
          )
        : h("span", { class: `bk-depth-lvl empty ${side}` }, DASH);
    fill(
      ladder,
      h("div", { class: "bk-depth-row bk-depth-headrow", "aria-hidden": "true" }, h("span", {}, h("span", {}, "Orders"), h("span", {}, "Qty"), h("span", {}, "Bid")), h("span", {}, h("span", {}, "Ask"), h("span", {}, "Qty"), h("span", {}, "Orders"))),
      v.rows.map((row) => h("div", { class: "bk-depth-row" }, cell(row.bid, "bid"), cell(row.ask, "ask"))),
    );
  };
  // Read every 2 s, only while this panel is open and the tab is in view (the ticket's depth does the same).
  const p = poll(async () => {
    const s = sym;
    const r = await optional(api(`/v1/depth?symbol=${enc(s)}`));
    if (s !== sym) return;
    if (r.error) {
      fill(sum);
      fill(ladder, note(`Depth is not available: ${r.error.message ?? "the source sent none"}.`));
      return;
    }
    draw(r.data?.data);
    status.textContent = "Five levels a side, every 2 s while this panel is open.";
  }, 2000);
  return p;
}

// ── Positions ──

const legName = (symbol) => {
  const x = symbolParts(symbol);
  if (!x) return { main: String(symbol), sub: "" };
  if (x.kind === "OPT") return { main: `${x.underlying} ${formatInt(x.strike)} ${x.right}`, sub: x.expiry ?? "" };
  if (x.kind === "FUT") return { main: `${x.underlying} FUT`, sub: x.expiry ?? "" };
  return { main: x.underlying, sub: x.exchange };
};

function positionsTool({ body }) {
  const hero = h("div", { class: "rr-hero" });
  const list = h("ul", { class: "rr-list", "aria-label": "Open positions" });
  const status = note("");
  fill(body, hero, list, status, footLink("Open Positions", "#/positions"));
  let accounts = null;
  const p = poll(async () => {
    if (!accounts) {
      const r = await optional(api("/v1/accounts"));
      if (r.error) return fill(list, h("li", {}, note(`Accounts are not available: ${r.error.message}`)));
      // Accounts readable without a broker call storm: paper ones and logged-in live ones (at most 6), as Home reads.
      accounts = (r.data.data ?? []).filter((a) => a.enabled !== false && (a.capabilities ?? []).includes("positions") && (a.broker === "paper" || a.session?.state === "connected")).slice(0, 6);
    }
    if (!accounts.length) return fill(list, h("li", {}, note("No account to read positions from yet.")));
    const res = await Promise.all(accounts.map((a) => optional(api(`/v1/positions?account=${enc(a.id)}`))));
    const rows = [];
    let total = 0;
    let known = 0;
    res.forEach((r, i) => {
      for (const q of r.data?.data ?? []) {
        if (isFigure(q.pnl)) (total += Number(q.pnl)), (known += 1);
        if (Number(q.netQty)) rows.push({ ...q, account: accounts[i] });
      }
    });
    rows.sort((a, b) => Math.abs(Number(b.pnl) || 0) - Math.abs(Number(a.pnl) || 0));
    const many = accounts.length > 1;
    fill(
      hero,
      h("span", { class: "rr-hero-l" }, "P&L"),
      h("strong", { class: `rr-hero-v ${known ? tone(total) : "flat"}` }, known ? formatSignedRupee(total, 0) : DASH),
      h("small", {}, rows.length ? `${formatInt(rows.length)} open` : "Nothing open"),
    );
    fill(
      list,
      rows.slice(0, 40).map((q) => {
        const n = legName(q.symbol);
        const qty = Number(q.netQty);
        return h(
          "li",
          {},
          h(
            "a",
            { class: "rr-item", href: "#/positions" },
            h("span", { class: "rr-name" }, h("strong", {}, n.main), h("small", {}, [n.sub, many ? q.account.label ?? q.account.id : ""].filter(Boolean).join(" · "))),
            h("span", { class: `rr-qty ${qty > 0 ? "up" : "down"}`, title: qty > 0 ? "Long" : "Short" }, formatSigned(qty, 0)),
            h("span", { class: "rr-num" }, price(q.ltp)),
            h("span", { class: `rr-chg ${tone(q.pnl)}` }, isFigure(q.pnl) ? formatSignedRupee(q.pnl, 0) : DASH),
          ),
        );
      }),
    );
    const failed = res.filter((r) => r.error).length;
    status.textContent = failed ? `${formatInt(failed)} account${failed === 1 ? "" : "s"} did not answer.` : "Every 5 s while this panel is open.";
  }, 5000);
  return p;
}

// ── Super Alerts ──

function alertsTool({ body }) {
  const kinds = [
    ["price", "Price"],
    ["oi", "OI"],
    ["move", "% move"],
  ];
  const kindSeg = h("div", { class: "segmented rr-seg", role: "group", "aria-label": "Alert type" });
  let kind = mem("alertKind") ?? "price";
  const kindBtns = kinds.map(([v, t]) => h("button", { type: "button", "data-value": v, "aria-pressed": String(v === kind), onclick: () => setKind(v) }, t));
  kindSeg.append(...kindBtns);
  const uIn = h("input", { type: "text", class: "rr-in", value: pageUnderlying(), "aria-label": "Underlying", autocapitalize: "characters", spellcheck: "false" });
  const op = sel("When it", [
    ["either", "Crosses"],
    ["above", "Rises through"],
    ["below", "Falls through"],
  ]);
  const level = h("input", { type: "number", class: "rr-in", inputmode: "decimal", step: "any", "aria-label": "Price level" });
  const eSel = sel("Expiry", []);
  const kSel = sel("Strike", []);
  const rSel = sel("Side", [
    ["CE", "Call"],
    ["PE", "Put"],
  ]);
  const oiPct = h("input", { type: "number", class: "rr-in", inputmode: "decimal", step: "any", value: "25", "aria-label": "OI change, % since the previous close" });
  const movePct = h("input", { type: "number", class: "rr-in", inputmode: "decimal", step: "any", value: "1", "aria-label": "Move in percent (negative for a fall)" });
  const preview = h("p", { class: "rr-preview", role: "status" });
  const err = h("p", { class: "field-msg", role: "alert" });
  const create = h("button", { type: "button", class: "primary small" }, icon("plus"), "Create alert");
  const more = h("button", { type: "button", class: "small" }, "More alert types");
  const f = (label, el) => h("label", { class: "rr-field" }, h("span", {}, label), el);
  const fPrice = h("div", { class: "rr-fields" }, f("When it", op), f("Level", level));
  const fOi = h("div", { class: "rr-fields" }, f("Expiry", eSel), f("Strike", kSel), f("Side", rSel), f("OI change above (%)", oiPct));
  const fMove = h("div", { class: "rr-fields" }, f("Move (%)", movePct));
  const form = h("div", { class: "rr-card rr-form" }, kindSeg, f("Underlying", uIn), fPrice, fOi, fMove, preview, err, h("div", { class: "rr-form-acts" }, create, more));
  const lists = h("div", { class: "rr-alists" });
  fill(body, form, lists, note("Checked on the Bridge, with this page closed too. Alerts only notify: nothing is placed."));
  let spot = null;
  let chain = null;
  const setKind = (v) => {
    kind = v;
    mem("alertKind", v);
    for (const b of kindBtns) b.setAttribute("aria-pressed", String(b.dataset.value === v));
    fPrice.hidden = v !== "price";
    fOi.hidden = v !== "oi";
    fMove.hidden = v !== "move";
    err.textContent = "";
    sync();
  };
  kindSeg.addEventListener("keydown", (e) => {
    const i = kinds.findIndex(([v]) => v === kind);
    const s = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!s) return;
    e.preventDefault();
    const v = kinds[(i + s + kinds.length) % kinds.length][0];
    setKind(v);
    kindBtns.find((b) => b.dataset.value === v)?.focus();
  });
  const sync = () => {
    const u = uIn.value.trim().toUpperCase() || "the underlying";
    if (kind === "price") {
      if (!level.value && isFigure(spot)) level.placeholder = formatFixed(spot, 2);
      preview.textContent = isFigure(spot) ? `${u} now ${price(spot)}.` : "";
    } else if (kind === "move") {
      const m = pctMoveLevel(spot, movePct.value);
      preview.textContent = m ? `Fires when ${u} ${m.op === "above" ? "rises through" : "falls through"} ${price(m.level)} (${formatSignedPercent(Number(movePct.value), 2)} from ${price(spot)}).` : isFigure(spot) ? "Type a move such as 1 or -1.5." : "Waiting for the price.";
    } else preview.textContent = kSel.value ? `${u} ${formatInt(Number(kSel.value))} ${rSel.value}: OI added since the previous close, in percent of that close.` : "";
  };
  for (const el of [level, movePct, oiPct]) el.addEventListener("input", sync);
  for (const el of [op, kSel, rSel]) el.addEventListener("change", sync);
  /** Spot, the expiries and the strikes around ATM, for the form. */
  const loadMarket = async () => {
    const u = uIn.value.trim().toUpperCase();
    if (!u) return;
    const ex = await expiriesOf(u);
    if (uIn.value.trim().toUpperCase() !== u) return;
    const keepE = eSel.value;
    fill(eSel, ex.list.slice(0, 8).map((e) => h("option", { value: e }, e)));
    if (ex.list.slice(0, 8).includes(keepE)) eSel.value = keepE;
    if (!ex.list.length) {
      spot = null;
      fill(kSel);
      return sync();
    }
    const r = await optional(api(`/v1/optionchain?underlying=${enc(u)}&expiry=${enc(eSel.value)}&strikes=12&greeks=false`));
    if (uIn.value.trim().toUpperCase() !== u) return;
    chain = r.data?.data ?? null;
    spot = isFigure(chain?.underlyingLtp) ? Number(chain.underlyingLtp) : null;
    const m = miniChainRows(chain, 6);
    const keep = kSel.value;
    fill(kSel, m.rows.map((x) => h("option", { value: String(x.strike) }, `${formatInt(x.strike)}${x.atm ? " (ATM)" : ""}`)));
    kSel.value = m.rows.some((x) => String(x.strike) === keep) ? keep : String(m.atm ?? "");
    sync();
  };
  uIn.addEventListener("change", loadMarket);
  eSel.addEventListener("change", loadMarket);
  more.addEventListener("click", () => import("./alerts.js").then((m) => m.openMarketAlertSheet()).then(() => p.wake()));
  create.addEventListener("click", async () => {
    err.textContent = "";
    const M = await import("./analyticsMore.js");
    const u = uIn.value.trim().toUpperCase();
    let f2;
    if (kind === "price") f2 = { metric: "spot_cross", op: op.value, value: level.value };
    else if (kind === "oi") f2 = { metric: "strike_oi_change", op: "above", value: oiPct.value, expiry: eSel.value, strike: kSel.value, right: rSel.value };
    else {
      const m = pctMoveLevel(spot, movePct.value);
      if (!m) return void (err.textContent = isFigure(spot) ? "Type a move in percent, such as 1 or -1.5." : `No price for ${u} yet.`);
      f2 = { metric: "spot_cross", op: m.op, value: String(m.level), name: `${u} ${formatSignedPercent(Number(movePct.value), 2)} move (through ${price(m.level)})` };
    }
    const r = M.ruleBody({ name: f2.name ?? "", underlying: u, expiry: f2.expiry ?? eSel.value, metric: f2.metric, op: f2.op, value: f2.value, to: "", every: "1", marketHoursOnly: true, strike: f2.strike ?? "", right: f2.right ?? "CE" });
    if (!r.ok) return void (err.textContent = r.errors.join(" "));
    create.disabled = true;
    const res = await optional(api("/v1/alerts/market", { method: "POST", body: r.body }));
    create.disabled = false;
    if (res.error) return void (err.textContent = res.error.message ?? "Could not create the alert.");
    toast(`Alert on: ${res.data?.data?.name ?? r.body.name}`);
    import("./alerts.js").then((m) => m.alertsChanged()).catch(() => {});
    p.wake();
  });
  /** The fired list and every alert, with on / off (position alerts) and delete. */
  const drawLists = async () => {
    const [inbox, rules, market] = await Promise.all([optional(api("/v1/alerts/inbox")), optional(api("/v1/alerts")), optional(api("/v1/alerts/market"))]);
    const M = await import("./analyticsMore.js");
    const fires = inbox.data?.data?.items ?? [];
    const pos = rules.data?.data?.items ?? [];
    const mkt = Array.isArray(market.data?.data) ? market.data.data : market.data?.data?.items ?? [];
    const del = (path, name) => {
      const b = h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Delete ${name}`, title: "Delete" }, icon("close"));
      b.addEventListener("click", async () => {
        const res = await optional(api(path, { method: "DELETE" }));
        if (res.error) return toast(res.error.message ?? "Could not delete the alert.", { tone: "error" });
        toast(`Deleted: ${name}`);
        import("./alerts.js").then((m) => m.alertsChanged()).catch(() => {});
        drawLists();
      });
      return b;
    };
    const posRow = (r) => {
      const sw = h("input", { type: "checkbox", role: "switch", checked: r.enabled, "aria-label": `${r.name}: ${r.enabled ? "on" : "off"}` });
      sw.addEventListener("change", async () => {
        const res = await optional(api(`/v1/alerts/${enc(r.id)}`, { method: "PUT", body: { enabled: sw.checked } }));
        if (res.error) return toast(res.error.message ?? "Could not change the alert.", { tone: "error" }), (sw.checked = !sw.checked);
        import("./alerts.js").then((m) => m.alertsChanged()).catch(() => {});
      });
      return h("li", { class: `rr-alert${r.enabled ? "" : " off"}` }, h("label", { class: "switch" }, sw, h("i")), h("span", { class: "rr-name" }, h("strong", {}, r.name), h("small", {}, `${r.underlying} · position alert`)), del(`/v1/alerts/${enc(r.id)}`, r.name));
    };
    const mktRow = (r) => {
      const state = M.ruleState(r);
      return h("li", { class: `rr-alert${r.enabled === false ? " off" : ""}` }, h("span", { class: "rr-name" }, h("strong", {}, r.name), h("small", {}, state.text)), del(`/v1/alerts/market/${enc(r.id)}`, r.name));
    };
    fill(
      lists,
      fires.length ? [h("h3", { class: "rr-h" }, "Fired lately"), h("ul", { class: "rr-list rr-fires" }, fires.slice(0, 3).map((x) => h("li", {}, h("span", { class: "rr-name" }, h("strong", {}, x.name), h("small", {}, x.text)))))] : null,
      h("h3", { class: "rr-h" }, `Your alerts${pos.length + mkt.length ? ` · ${formatInt(pos.length + mkt.length)}` : ""}`),
      pos.length + mkt.length ? h("ul", { class: "rr-list" }, mkt.map(mktRow), pos.map(posRow)) : note("None yet. Make one above, or from Positions for your book."),
    );
  };
  setKind(kind);
  loadMarket();
  const p = poll(drawLists, 15000);
  const pm = poll(() => (kind === "oi" ? null : loadMarket()), 15000);
  return { stop: () => (p.stop(), pm.stop()), wake: () => p.wake() };
}

// ── Sector heatmap ──

function heatmapTool({ body, acts }) {
  const sizes = [
    ["turnover", "Turnover"],
    ["equal", "Equal"],
  ];
  let sizeBy = mem("heatSize") === "equal" ? "equal" : "turnover";
  const seg = h("div", { class: "segmented rr-seg", role: "group", "aria-label": "Tile size by" });
  const segBtns = sizes.map(([v, t]) => h("button", { type: "button", "data-value": v, "aria-pressed": String(v === sizeBy), tabindex: v === sizeBy ? "0" : "-1", onclick: () => setSize(v) }, t));
  seg.append(...segBtns);
  seg.addEventListener("keydown", (e) => {
    const s = e.key === "ArrowRight" || e.key === "ArrowLeft" ? 1 : 0;
    if (!s) return;
    e.preventDefault();
    const v = sizeBy === "turnover" ? "equal" : "turnover";
    setSize(v);
    segBtns.find((b) => b.dataset.value === v)?.focus();
  });
  fill(acts, h("div", { class: "rr-row-acts" }, h("span", { class: "rr-acts-l" }, "Size by"), seg));
  const breadth = h("div", { class: "rr-breadth" });
  const map = h("div", { class: "rr-heat", role: "group", "aria-label": "F&O stocks by sector, coloured by today's % change" });
  const sectors = h("ul", { class: "rr-list rr-sectors", "aria-label": "Sectors by today's change" });
  const status = note("");
  fill(body, breadth, map, h("div", { class: "rr-legend", "aria-hidden": "true" }, h("span", {}, "Fall"), [-3, -2, -1, 1, 2, 3].map((s) => heatCell(h("i"), s, "div")), h("span", {}, "Rise")), sectors, status);
  let items = [];
  let summary = null;
  const setSize = (v) => {
    sizeBy = v;
    mem("heatSize", v);
    for (const b of segBtns) {
      b.setAttribute("aria-pressed", String(b.dataset.value === v));
      b.tabIndex = b.dataset.value === v ? 0 : -1;
    }
    draw();
  };
  // Roving focus over the tiles: one tab stop; the arrow keys walk them (largest first), Enter opens the sheet.
  map.addEventListener("keydown", (e) => {
    const tiles = [...map.querySelectorAll("button.rr-tile")];
    const i = tiles.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
    if (!d || i < 0) return;
    e.preventDefault();
    const k = d === -Infinity ? 0 : d === Infinity ? tiles.length - 1 : (i + d + tiles.length) % tiles.length;
    tiles.forEach((t, n) => (t.tabIndex = n === k ? 0 : -1));
    tiles[k].focus();
  });
  const draw = () => {
    const groups = groupBySector(items, { sizeBy });
    const W = map.clientWidth || PANEL_W - 32;
    const H = Math.round(Math.max(300, Math.min(520, W * 1.25)));
    map.style.height = `${H}px`;
    const blocks = heatmapLayout(groups, { w: W, h: H, head: 20, gap: 4 });
    let first = true;
    const px = (v) => `${Math.round(v * 10) / 10}px`;
    fill(
      map,
      blocks.map((b) => {
        const block = h("div", { class: "rr-block" });
        Object.assign(block.style, { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h) });
        const label = b.labelled ? h("span", { class: "rr-block-l" }, h("span", {}, sectorLabel(b.sector)), h("span", { class: tone(b.changePct) }, pctText(b.changePct))) : null;
        const tiles = b.tiles.map((t) => {
          const big = t.w >= 46 && t.h >= 30;
          const tile = h(
            "button",
            { type: "button", class: `rr-tile${big ? "" : " small"}`, tabindex: first ? "0" : "-1", "aria-label": `${t.ticker}, ${sectorLabel(t.sector)}: ${pctText(t.changePct)} today${isFigure(t.turnover) ? `, turnover ${formatCompact(t.turnover)}` : ""}`, title: `${t.ticker} · ${pctText(t.changePct)}`, onclick: () => import("./pulse.js").then((m) => m.openSymbolSheet(t.symbol)) },
            big ? h("span", { class: "rr-tile-t" }, t.ticker) : null,
            big && t.h >= 40 ? h("span", { class: "rr-tile-v" }, pctText(t.changePct)) : null,
          );
          first = false;
          Object.assign(tile.style, { left: px(t.x - b.x), top: px(t.y - b.y), width: px(t.w), height: px(t.h) });
          heatCell(tile, heatStep(t.changePct) ?? 0, "div");
          return tile;
        });
        block.append(...[label, ...tiles].filter(Boolean));
        return block;
      }),
    );
    fill(
      sectors,
      [...groups]
        .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity))
        .map((g) => h("li", { class: "rr-sector" }, h("span", { class: "rr-name" }, h("strong", {}, sectorLabel(g.sector)), h("small", {}, `${formatInt(g.stocks.length)} stocks · ${formatInt(g.up)} up · ${formatInt(g.down)} down`)), h("span", { class: `rr-chg ${tone(g.changePct)}` }, pctText(g.changePct)))),
    );
    if (summary) {
      const total = (summary.advances ?? 0) + (summary.declines ?? 0) + (summary.unchanged ?? 0);
      fill(breadth, h("span", { class: "up" }, `${formatInt(summary.advances)} up`), h("span", { class: "down" }, `${formatInt(summary.declines)} down`), summary.unchanged ? h("span", {}, `${formatInt(summary.unchanged)} flat`) : null, h("small", {}, `of ${formatInt(total)} F&O stocks`));
    }
  };
  // The movers route's one shared quote pass (15 s): turnover, gainers and losers, 50 each, as one list.
  const p = poll(async () => {
    const q = (by) => optional(api(`/v1/analytics/markets/movers?universe=FNO&by=${by}&limit=50`));
    const [t, g, l] = await Promise.all([q("turnover"), q("gainers"), q("losers")]);
    if (t.error && g.error && l.error) {
      fill(map, note(`The heatmap is not available: ${t.error.message}`));
      return;
    }
    items = mergeMovers(t.data?.data?.items, g.data?.data?.items, l.data?.data?.items);
    summary = t.data?.data?.summary ?? g.data?.data?.summary ?? null;
    draw();
    status.textContent = `${formatInt(items.length)} F&O stocks (the 50 largest by turnover, with the 50 largest moves each way). ${touch()} a tile for its readouts, chart and depth. Every 15 s while this panel is open.`;
  }, 15000);
  return p;
}

// ── Customise ──

function customiseTool({ body }) {
  const list = h("ul", { class: "rr-cz", "aria-label": "Tools in the rail" });
  const placeSeg = h("div", { class: "segmented rr-seg", role: "group", "aria-label": "The rail on wide screens" });
  const places = [
    ["auto", "Beside the page"],
    ["edge", "Thin edge"],
  ];
  const placeBtns = places.map(([v, t]) => h("button", { type: "button", "data-value": v, onclick: () => setPlace(v) }, t));
  placeSeg.append(...placeBtns);
  const setPlace = (v) => {
    st = { ...st, place: v };
    save();
    for (const b of placeBtns) b.setAttribute("aria-pressed", String(b.dataset.value === st.place));
    const before = { ...mode };
    layout();
    if (before.rail !== mode.rail || before.panel !== mode.panel) relayoutPage();
  };
  for (const b of placeBtns) b.setAttribute("aria-pressed", String(b.dataset.value === st.place));
  const reset = h("button", { type: "button", class: "small" }, "Reset");
  reset.addEventListener("click", () => {
    st = normalizeRail({ ...st, order: null, hidden: [], open: "customise" });
    save();
    drawBar();
    draw();
  });
  const draw = (focusId = null, focusWhat = null) => {
    fill(
      list,
      st.order.map((id, i) => {
        const t = toolInfo(id);
        const shown = !st.hidden.includes(id);
        const sw = h("input", { type: "checkbox", role: "switch", checked: shown, "aria-label": `Show ${t.label}` });
        sw.addEventListener("change", () => {
          st = setToolHidden(st, id, !sw.checked);
          save();
          drawBar();
        });
        const up = h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${t.label} up`, disabled: i === 0, "data-move": "up" }, icon("up"));
        const down = h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Move ${t.label} down`, disabled: i === st.order.length - 1, "data-move": "down" }, icon("down"));
        const move = (d) => {
          st = moveTool(st, id, d);
          save();
          drawBar();
          draw(id, d < 0 ? "up" : "down");
        };
        up.addEventListener("click", () => move(-1));
        down.addEventListener("click", () => move(1));
        return h("li", { class: `rr-cz-row${shown ? "" : " off"}`, "data-id": id }, h("span", { class: `rr-cz-glyph tint-${t.tint}`, "aria-hidden": "true" }, glyph(id)), h("span", { class: "rr-name" }, h("strong", {}, t.label), t.key ? h("small", {}, t.key) : null), up, down, h("label", { class: "switch" }, sw, h("i")));
      }),
    );
    if (focusId) {
      const row = list.querySelector(`[data-id="${focusId}"]`);
      const b = row?.querySelector(`[data-move="${focusWhat}"]`);
      (b && !b.disabled ? b : row?.querySelector("[data-move]:not(:disabled)"))?.focus();
    }
  };
  draw();
  fill(
    body,
    h("h3", { class: "rr-h" }, "Tools"),
    list,
    h("h3", { class: "rr-h" }, "Where the rail sits"),
    placeSeg,
    note("Beside the page: the rail sits on the right while the page has room for it, and folds to a thin edge when it has not. Thin edge: always the edge; hover or focus it to show the tools."),
    h("h3", { class: "rr-h" }, "Keys"),
    h("dl", { class: "rr-keys" }, h("dt", {}, h("kbd", {}, "Shift+O")), h("dd", {}, "Option chain panel"), h("dt", {}, h("kbd", {}, "↑ ↓")), h("dd", {}, "Move between tools in the rail"), h("dt", {}, h("kbd", {}, "Esc")), h("dd", {}, "Close the panel")),
    h("div", { class: "rr-form-acts" }, reset),
  );
  return {};
}

const TOOLS = { watchlist: watchlistTool, chain: chainTool, depth: depthTool, positions: positionsTool, alerts: alertsTool, heatmap: heatmapTool, customise: customiseTool };
/** Every tool the rail can open (tests check each is wired). */
export const RAIL_TOOL_IDS = Object.freeze([...RAIL_TOOLS.map((t) => t.id), CUSTOMISE.id]);
