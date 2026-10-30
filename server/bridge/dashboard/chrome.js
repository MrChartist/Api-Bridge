// Trading-terminal chrome: collapsible sidebar groups, the workspace context bar, the market-status chip, the
// auto-refresh control, the density toggle and the "g …" key hint. Browser only (it draws DOM); the logic it uses lives
// in workspace.js, which is tested without a browser. No style attributes anywhere: the dashboard CSP is style-src 'self'.
import { animateNav, api, apiHealth, h, icon, modal, toast } from "./app.js";
import {
  DENSITIES,
  REFRESH_CHOICES,
  STRIKE_OPTIONS,
  UNDERLYING_CHIPS,
  createRefresher,
  density,
  expiryNote,
  isAutoRefreshable,
  marketStatus,
  navState,
  normalizeUnderlying,
  stampText,
  upcomingExpiries,
  workspace,
} from "./workspace.js";

const $ = (id) => document.getElementById(id);
/** @type {{ go: (id: string, sel?: string) => void, reload: () => void, silentReload: () => Promise<void> } | null} */
let hooks = null;
let activeGroup = null;
let refresher = null;
let lastStampMs = null;
let ui = null;

// ───────────────────────── collapsible nav groups ─────────────────────────

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * The sidebar's selection highlight (motion.js) is placed by script, and the nav is a fixed-height scroller, so folding a
 * group above the current page does not resize anything it watches. Re-place it on every frame while the fold animates.
 */
let followUntil = 0;
function followHighlight(ms = 450) {
  const nav = $("nav");
  if (!nav || typeof requestAnimationFrame !== "function") return;
  const running = followUntil > performance.now();
  followUntil = performance.now() + ms;
  if (running) return;
  const step = () => {
    animateNav(nav);
    if (performance.now() < followUntil) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Apply the saved open/closed state to every group on the page (the sidebar and the More sheet share it). */
export function syncGroups() {
  for (const sec of document.querySelectorAll(".nav-section[data-group]")) {
    const name = sec.dataset.group;
    const locked = name === activeGroup;
    const open = navState.isOpen(name, activeGroup);
    sec.dataset.open = String(open);
    const btn = sec.querySelector(":scope > .nav-group-btn");
    btn?.setAttribute("aria-expanded", String(open));
    if (locked) btn?.setAttribute("aria-disabled", "true");
    else btn?.removeAttribute("aria-disabled");
    const items = sec.querySelector(":scope > .nav-items");
    if (items) items.inert = !open;
  }
  followHighlight();
}

/**
 * One collapsible group: a real <button aria-expanded> that controls its list of links. The group that holds the current
 * page is always open (its button says so with aria-disabled). The open state animates by CSS only (and not at all with
 * prefers-reduced-motion); collapsed links are inert so Tab skips them.
 * @param {{ name: string, children: Node[], active: string | null, variant?: "nav" | "more", count?: number }} o
 */
export function navGroup({ name, children, active, variant = "nav", count = children.length }) {
  activeGroup = active;
  const id = `ng-${variant}-${slug(name)}`;
  const locked = name === active;
  const open = navState.isOpen(name, active);
  const chev = icon("chevron");
  chev.classList.add("ng-chev");
  const btn = h(
    "button",
    {
      type: "button",
      class: "nav-group-btn",
      "aria-expanded": String(open),
      "aria-controls": id,
      "aria-disabled": locked ? "true" : undefined,
      title: locked ? `${name} holds the page you are on, so it stays open` : undefined,
      onclick: () => {
        if (btn.getAttribute("aria-disabled") === "true") return;
        navState.toggle(name);
        syncGroups();
      },
    },
    chev,
    h("span", { class: "ng-name" }, name),
    h("span", { class: "ng-count", "aria-hidden": "true" }, String(count)),
  );
  const items = h("div", { id, class: "nav-items", role: "group", "aria-label": name }, h("div", { class: "nav-items-inner" }, children));
  items.inert = !open;
  return h("div", { class: `nav-section${variant === "more" ? " more-group" : ""}`, "data-group": name, "data-open": String(open) }, btn, items);
}

// ───────────────────────── context bar ─────────────────────────

function buildContextBar() {
  const bar = $("context-bar");
  if (!bar) return null;
  const chips = UNDERLYING_CHIPS.map((u) =>
    h("button", { type: "button", class: "ctx-chip", "data-underlying": u, "aria-pressed": "false", onclick: () => setUnderlying(u) }, u),
  );
  const symbol = h("input", { id: "ctx-symbol", class: "ctx-symbol", type: "text", placeholder: "Symbol", spellcheck: "false", autocomplete: "off", autocapitalize: "characters", maxlength: 30, enterkeyhint: "go" });
  symbol.addEventListener("change", () => {
    if (!normalizeUnderlying(symbol.value)) {
      toast("A symbol uses letters, numbers, & _ or -, up to 30 characters.");
      symbol.value = workspace.get().underlying;
      return;
    }
    setUnderlying(symbol.value);
  });
  const expiry = h("button", { type: "button", class: "ctx-expiry", "aria-haspopup": "dialog", title: "Choose the expiry", onclick: () => openExpirySheet() });
  const strikes = h("select", { id: "ctx-strikes", class: "ctx-strikes", "aria-label": "Strikes each side of the money" });
  strikes.addEventListener("change", () => {
    workspace.set({ strikes: Number(strikes.value) });
    hooks?.reload();
  });
  bar.replaceChildren(
    h("div", { class: "segmented ctx-chips", role: "group", "aria-label": "Underlying" }, chips),
    h("label", { class: "ctx-field ctx-sym-field" }, h("span", { class: "pal-sr-only" }, "Underlying symbol"), symbol),
    expiry,
    h("label", { class: "ctx-field ctx-strikes-field" }, h("span", { class: "ctx-strikes-lbl" }, "Strikes"), strikes),
  );
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Workspace context, shared by the Analytics pages");
  return { bar, chips, symbol, expiry, strikes };
}

/** Bring the context bar in line with the workspace (called on every change, from any page's own controls too). */
function paintContext() {
  if (!ui?.ctx) return;
  const c = workspace.get();
  for (const b of ui.ctx.chips) b.setAttribute("aria-pressed", String(b.dataset.underlying === c.underlying));
  if (document.activeElement !== ui.ctx.symbol) ui.ctx.symbol.value = c.underlying;
  ui.ctx.expiry.replaceChildren(h("span", { class: "ctx-k" }, "Expiry"), h("b", {}, c.expiry || "--"), (() => {
    const s = icon("chevron");
    s.classList.add("ng-chev");
    return s;
  })());
  ui.ctx.expiry.setAttribute("aria-label", `Expiry ${c.expiry || "not chosen"}. Choose another`);
  const opts = [...new Set([...STRIKE_OPTIONS, c.strikes])].sort((a, b) => a - b);
  ui.ctx.strikes.replaceChildren(...opts.map((n) => h("option", { value: String(n), selected: n === c.strikes }, `±${n}`)));
  ui.ctx.strikes.value = String(c.strikes);
}

/** Make `symbol` the underlying for every Analytics page and redraw the current page with it. */
export function setUnderlying(symbol, { navigateTo } = {}) {
  const u = normalizeUnderlying(symbol);
  if (!u) return false;
  const changed = workspace.set({ underlying: u }).includes("underlying");
  if (navigateTo) hooks?.go(navigateTo);
  else if (changed) hooks?.reload();
  return true;
}

/** A sheet listing the upcoming expiries of the current underlying; choosing one sets it for every Analytics page. */
export async function openExpirySheet() {
  const { underlying, expiry: current } = workspace.get();
  let rows;
  const pick = (close, e) => {
    close(undefined);
    if (workspace.set({ expiry: e }).includes("expiry")) hooks?.reload();
  };
  const sheet = modal({
    title: `Expiry for ${underlying}`,
    body: (close) => {
      const box = h("div", { class: "list expiry-list", "aria-busy": "true" }, h("p", { class: "muted small ctx-loading" }, "Loading expiries…"));
      api(`/v1/expiries?underlying=${encodeURIComponent(underlying)}`)
        .then((r) => {
          const all = upcomingExpiries(r.data?.data?.expiries);
          rows = all.map((e) =>
            h(
              "button",
              { type: "button", class: "list-row", "aria-current": e === current ? "true" : undefined, onclick: () => pick(close, e) },
              h("span", { class: "names" }, h("span", { class: "nm" }, e), h("span", { class: "sub" }, expiryNote(e))),
            ),
          );
          box.replaceChildren(...(rows.length ? rows : [h("p", { class: "muted small ctx-loading" }, `No upcoming expiries for ${underlying}.`)]));
          const dlg = $("dialog");
          if (rows.length && dlg?.contains(document.activeElement) && !document.activeElement.matches("input, select, textarea")) (rows.find((r) => r.getAttribute("aria-current")) ?? rows[0]).focus({ preventScroll: true });
        })
        .catch((err) => box.replaceChildren(h("p", { class: "bad-text small ctx-loading" }, err?.message || "Could not load the expiries.")))
        .finally(() => box.removeAttribute("aria-busy"));
      return box;
    },
    buttons: [{ label: "Cancel", value: undefined }],
  });
  return sheet;
}

// ───────────────────────── header controls: market, density, refresh ─────────────────────────

const MARKET_TIP = "NSE cash and F&O hours in IST: pre-open 09:00 to 09:15, open 09:15 to 15:30, Monday to Friday. Exchange holidays are not included.";

function paintMarket() {
  const el = ui?.market;
  if (!el) return;
  const m = marketStatus(Date.now());
  el.className = `pill market-chip ${m.state === "open" ? "ok" : m.state === "preopen" ? "warn" : ""}`.trim();
  el.dataset.state = m.state;
  el.replaceChildren(h("span", { class: "pdot", "aria-hidden": "true" }), h("span", { class: "mk-long" }, m.text), h("span", { class: "mk-short" }, m.short));
  el.title = MARKET_TIP;
}

function applyDensity(value) {
  const v = density.set(value);
  document.body.classList.toggle("density-compact", v === "compact");
  if (ui?.density) {
    ui.density.setAttribute("aria-pressed", String(v === "compact"));
    ui.density.title = v === "compact" ? "Compact rows and cards. Press for comfortable." : "Comfortable rows and cards. Press for compact.";
  }
  return v;
}
export const toggleDensity = () => applyDensity(density.get() === "compact" ? "comfortable" : "compact");
export const currentDensity = () => density.get();

/** The "updated hh:mm:ss" stamp, or what the refresher is doing (updating, backing off). */
function paintStamp() {
  const el = ui?.stamp;
  if (!el || !refresher) return;
  const s = refresher.snapshot();
  let text = lastStampMs ? `updated ${stampText(lastStampMs)}` : "";
  let state = "ok";
  if (s.status === "running") {
    text = "updating…";
    state = "busy";
  } else if (s.status === "backoff" && s.dueAt) {
    const secs = Math.max(0, Math.round((s.dueAt - Date.now()) / 1000));
    text = `${s.lastError?.status === 429 ? "rate limited" : "update failed"} · retry in ${secs >= 90 ? `${Math.round(secs / 60)}m` : `${secs}s`}`;
    state = "warn";
  } else if (s.status === "paused") {
    text = lastStampMs ? `paused · updated ${stampText(lastStampMs)}` : "paused";
  }
  el.dataset.state = state;
  el.textContent = text;
  el.hidden = !text;
  if (ui.refreshSelect) {
    ui.refreshSelect.disabled = !s.eligible;
    ui.refreshSelect.title = s.eligible ? "Re-run this page's data loader on a timer. Pauses while the tab is hidden and slows down after errors." : "This page has forms, so it is not refreshed automatically. Use Reload.";
    if (String(s.intervalMs) !== ui.refreshSelect.value) ui.refreshSelect.value = String(s.intervalMs);
  }
}

function buildHeaderControls() {
  const host = $("page-actions");
  if (!host) return null;
  const market = h("span", { class: "pill market-chip", "data-state": "closed" });
  const dens = h("button", { type: "button", class: "small density-btn", "aria-pressed": "false", onclick: () => toggleDensity() }, icon("list"), h("span", {}, "Compact"));
  const select = h(
    "select",
    { id: "refresh-select", class: "refresh-select", "aria-label": "Auto-refresh" },
    REFRESH_CHOICES.map((c) => h("option", { value: String(c.ms) }, c.label)),
  );
  select.addEventListener("change", () => {
    refresher?.setInterval(Number(select.value));
    paintStamp();
  });
  const stamp = h("span", { id: "refresh-stamp", class: "refresh-stamp", hidden: true, "data-state": "ok" });
  const ctl = h("label", { class: "refresh-ctl" }, icon("refresh"), select);
  host.replaceChildren(market, dens, ctl, stamp);
  return { market, density: dens, refreshSelect: select, stamp };
}

// ───────────────────────── key hint (the "g" leader) ─────────────────────────

let hintTimer = null;
/** Show or hide the small "g, then a page key" hint while a two-key sequence is armed. */
export function setKeyHint(on, timeoutMs = 1500) {
  let el = $("key-hint");
  if (!el && on) {
    el = h("div", { id: "key-hint", class: "key-hint glass", role: "status", hidden: true }, h("kbd", {}, "g"), h("span", {}, "then a page key, "), h("kbd", {}, "?"), h("span", {}, "for the list"));
    document.body.append(el);
  }
  if (!el) return;
  clearTimeout(hintTimer);
  el.hidden = !on;
  if (on) hintTimer = setTimeout(() => (el.hidden = true), timeoutMs);
}

// ───────────────────────── wiring ─────────────────────────

const typingInContent = () => {
  const a = document.activeElement;
  if (!a || !$("content")?.contains(a)) return false;
  if (a.tagName === "TEXTAREA") return true;
  return a.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset)$/.test(a.type);
};

/**
 * Wire everything up once, after sign-in. `silentReload()` re-runs the shown page's loader without the Loading… state
 * and rejects when the Bridge could not be reached (so the refresher backs off).
 * @param {{ go: (id: string, sel?: string) => void, reload: () => void, silentReload: () => Promise<void> }} options
 */
export function initChrome(options) {
  if (ui) return;
  hooks = options;
  ui = { ctx: buildContextBar(), ...(buildHeaderControls() ?? {}) };
  applyDensity(density.get());
  refresher = createRefresher({
    run: async () => {
      const mark = apiHealth.seq;
      try {
        await hooks.silentReload();
      } catch (err) {
        return { ok: false, status: err?.status ?? apiHealth.failure?.status, retryAfterMs: err?.retryAfterMs ?? apiHealth.failure?.retryAfterMs, error: err };
      }
      if (apiHealth.seq > mark) return { ok: false, status: apiHealth.failure?.status, retryAfterMs: apiHealth.failure?.retryAfterMs };
      lastStampMs = Date.now();
      return { ok: true };
    },
    onState: () => paintStamp(),
    isHidden: () => document.hidden,
    canRun: () => !document.getElementById("dialog")?.open && !document.querySelector("dialog.palette[open]") && $("content")?.getAttribute("aria-busy") !== "true" && !typingInContent(),
  });
  document.addEventListener("visibilitychange", () => refresher.visibilityChanged());
  workspace.subscribe(() => paintContext());
  paintContext();
  paintMarket();
  paintStamp();
  // One 1s heartbeat: the market countdown and the retry countdown.
  setInterval(() => {
    if (document.hidden) return;
    paintMarket();
    if (refresher.snapshot().status === "backoff") paintStamp();
  }, 1000);
}

/** The page changed: show the context bar on Analytics pages and tell the refresher whether this page may be refreshed. */
export function pageShown(page) {
  if (!ui) return;
  const analytics = page?.group === "Analytics";
  if (ui.ctx) ui.ctx.bar.hidden = !analytics;
  paintContext();
  refresher?.pageChanged(isAutoRefreshable(page?.id));
  paintStamp();
}

/** A page finished drawing (opened, or Reload pressed): stamp the time and restart the wait. */
export function pageRendered() {
  lastStampMs = Date.now();
  refresher?.loaded();
  paintStamp();
}

/** A silent re-draw succeeded (called by the refresher's own run through views.js; the stamp is set by run()). */
export const setRefreshInterval = (ms) => {
  refresher?.setInterval(ms);
  paintStamp();
};
export const refreshState = () => refresher?.snapshot() ?? null;
export const DENSITY_VALUES = DENSITIES;
