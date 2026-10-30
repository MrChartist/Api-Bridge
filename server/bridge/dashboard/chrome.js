// Trading-terminal chrome: collapsible sidebar groups, the workspace context bar, the market-status chip, the
// auto-refresh control, the density toggle and the "g …" key hint. Browser only (it draws DOM); the logic it uses lives
// in workspace.js, which is tested without a browser. No style attributes anywhere: the dashboard CSP is style-src 'self'.
import { animateNav, api, apiHealth, copyText, h, icon, lockScroll, modal, toast } from "./app.js";
import {
  DENSITIES,
  REFRESH_CHOICES,
  STRIKE_OPTIONS,
  UNDERLYING_CHIPS,
  codeOf,
  createRefresher,
  density,
  expiryNote,
  goKeyTable,
  isAutoRefreshable,
  isFormPage,
  marketStatus,
  navState,
  normalizeUnderlying,
  nowShowing,
  safeStore,
  stampText,
  upcomingExpiries,
  workspace,
} from "./workspace.js";
import { MAX_IMPORT_CHARS, MAX_NAME, createHistory, createHome, createLayouts, parseLayoutFile } from "./terminal.js";
import { downloadText } from "./export.js";
import { GUIDE_BASE, helpFor } from "./help.js";

const $ = (id) => document.getElementById(id);
/** @type {{ go: (id: string, sel?: string) => void, reload: () => void, silentReload: () => Promise<void>, pages: () => Array<{ id: string, label: string, group: string, title: string }> } | null} */
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
  syncGroupBadges();
  followHighlight();
}

/**
 * A folded group hides its pages' counters (the Orders ticket count), so its header shows their sum instead. The badge
 * reads the counters inside the group, so any page that carries a [data-tickets] counter is included automatically.
 */
export function syncGroupBadges() {
  for (const sec of document.querySelectorAll(".nav-section[data-group]")) {
    const badge = sec.querySelector(":scope > .nav-group-btn > .ng-badge");
    if (!badge) continue;
    let n = 0;
    for (const c of sec.querySelectorAll(":scope > .nav-items [data-tickets]")) if (!c.hidden) n += Number.parseInt(c.textContent.replace(/[^\d]/g, ""), 10) || 0;
    const show = n > 0 && sec.dataset.open !== "true";
    badge.hidden = !show;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.setAttribute("aria-label", show ? `${n} pending ${n === 1 ? "ticket" : "tickets"} in this group` : "");
    badge.title = show ? `${n} ${n === 1 ? "ticket waits" : "tickets wait"} for confirmation` : "";
  }
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
    // The pending-tickets total of the group's pages, shown while the group is folded (syncGroupBadges fills it).
    h("span", { class: "ng-badge", "data-group-badge": "", hidden: true }),
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
    if (workspace.set({ strikes: Number(strikes.value) }).length) contextChanged();
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

/**
 * The context changed from the bar (or the palette). A data page is re-run with it; a form page (payoff, calculators,
 * strategies, alerts, positions) keeps its state, and its controls follow the bar by themselves (analyticsViews.js).
 */
export function contextChanged() {
  if (isFormPage(nowShowing.id)) return;
  hooks?.reload();
}

/** Make `symbol` the underlying for every Analytics page and redraw the current page with it. */
export function setUnderlying(symbol, { navigateTo } = {}) {
  const u = normalizeUnderlying(symbol);
  if (!u) return false;
  const changed = workspace.set({ underlying: u }).includes("underlying");
  if (navigateTo) hooks?.go(navigateTo);
  else if (changed) contextChanged();
  return true;
}

/** A sheet listing the upcoming expiries of the current underlying; choosing one sets it for every Analytics page. */
export async function openExpirySheet() {
  const { underlying, expiry: current } = workspace.get();
  let rows;
  const pick = (close, e) => {
    close(undefined);
    if (workspace.set({ expiry: e }).includes("expiry")) contextChanged();
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
  // Runs every second: touch the DOM only when the text changes (each rewrite cost a style, layout and paint pass of the
  // top bar, every second, on every page).
  const sig = `${m.state}|${m.text}|${m.short}`;
  if (el.__sig === sig) return;
  el.__sig = sig;
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
  // Back and forward through the pages and contexts visited ([ and ] on the keyboard).
  const back = h("button", { type: "button", class: "icon-btn hist-btn", title: "Back to the previous page and context ( [ )", "aria-label": "Back", "aria-keyshortcuts": "[", disabled: true, onclick: () => historyBack() }, icon("chevron"));
  const fwd = h("button", { type: "button", class: "icon-btn hist-btn", title: "Forward ( ] )", "aria-label": "Forward", "aria-keyshortcuts": "]", disabled: true, onclick: () => historyForward() }, icon("chevron"));
  back.firstElementChild.classList.add("hist-back");
  host.replaceChildren(h("div", { class: "hist-pair", role: "group", "aria-label": "History" }, back, fwd), market, dens, ctl, stamp);
  return { market, density: dens, refreshSelect: select, stamp, back, fwd };
}

// ───────────────────────── back / forward history and the home page ─────────────────────────

const history = createHistory();
let suppressRecord = false;
let homeStore = null;
const isPageId = (id) => Boolean(hooks?.pages().some((p) => p.id === id));
const homePref = () => (homeStore ??= createHome(safeStore("local"), isPageId));

/** The page to open when the address names none: the saved home page, else Home. */
export const startPage = () => homePref().get();
/** Make `id` (default: the page on screen) the page the dashboard opens on. */
export function setHomePage(id = nowShowing.id) {
  if (!id || !homePref().set(id)) return false;
  const p = hooks?.pages().find((x) => x.id === id);
  toast(`Start page: ${p?.label ?? id}`);
  return true;
}
export const resetHomePage = () => {
  homePref().reset();
  toast("Start page: Home");
};

function recordHistory() {
  if (suppressRecord || !nowShowing.id) return;
  if (history.record({ page: nowShowing.id, ctx: workspace.get() })) paintHistory();
}

/** Go to a remembered { page, context }: the context is set first, then the page opens (or is redrawn) without adding a step. */
function restore(entry) {
  if (!entry) return false;
  suppressRecord = true;
  workspace.set(entry.ctx);
  paintHistory();
  const done = () => {
    suppressRecord = false;
  };
  if (entry.page === nowShowing.id) {
    if (!isFormPage(entry.page)) hooks?.reload();
    done();
  } else {
    hooks?.go(entry.page);
    setTimeout(done, 1200); // the router records through pageShown; this is only a safety release
  }
  return true;
}
export const historyBack = () => restore(history.back());
export const historyForward = () => restore(history.forward());

function paintHistory() {
  if (!ui?.back) return;
  ui.back.disabled = !history.canBack();
  ui.fwd.disabled = !history.canForward();
}

// ───────────────────────── saved layouts ─────────────────────────

let layoutStore = null;
const layouts = () => (layoutStore ??= createLayouts(safeStore("local"), { pageIds: hooks?.pages().map((p) => p.id), groups: [...new Set(hooks?.pages().map((p) => p.group) ?? [])] }));

export const savedLayouts = () => layouts().list();
/** Download every saved layout (the palette's "Layout: Export"). */
export function exportSavedLayouts() {
  const store = layouts();
  if (!store.list().length) return toast("No saved layouts to export yet");
  downloadText(store.exportText(), "mc-bridge-layouts.json", "application/json");
  toast("Exported layouts as mc-bridge-layouts.json");
}

/** What a layout saves: the workspace context, density, auto-refresh, the page on screen and which groups are folded. */
export const captureLayout = (name) => ({ name, ...workspace.get(), density: density.get(), autoRefresh: refresher?.intervalMs ?? 0, page: nowShowing.id ?? "", collapsed: navState.collapsed() });

/** Put a saved layout on screen. Plain data only: nothing in it is ever run. */
export function applyLayout(l) {
  suppressRecord = true;
  applyDensity(l.density);
  navState.replace(l.collapsed);
  syncGroups();
  setRefreshInterval(l.autoRefresh);
  workspace.set({ underlying: l.underlying, expiry: l.expiry, strikes: l.strikes });
  suppressRecord = false;
  if (l.page && l.page !== nowShowing.id) hooks?.go(l.page);
  else {
    if (!isFormPage(nowShowing.id)) hooks?.reload();
    recordHistory();
  }
  toast(`Layout: ${l.name}`);
}

const layoutSub = (l) => {
  const opens = l.page ? hooks?.pages().find((p) => p.id === l.page)?.label ?? null : null;
  return [l.underlying, l.expiry || "nearest expiry", `±${l.strikes}`, l.density, l.autoRefresh ? `refresh ${l.autoRefresh / 1000}s` : "no auto-refresh", opens ? `opens ${opens}` : "stays on the page", l.collapsed.length ? `${l.collapsed.length} folded` : null].filter(Boolean).join(" · ");
};

/** The layouts dialog: save the current workspace under a name, load or delete a saved one, export all, import a file. */
export function openLayouts({ focus = "save" } = {}) {
  const store = layouts();
  const note = h("p", { class: "layout-note", role: "status" });
  const nameInput = h("input", { id: "layout-name", type: "text", maxlength: String(MAX_NAME), placeholder: "Layout name", autocomplete: "off", spellcheck: "false" });
  const list = h("div", { class: "list layout-list", role: "list", "aria-label": "Saved layouts" });
  const fileInput = h("input", { type: "file", accept: "application/json,.json", class: "pal-sr-only", tabindex: "-1", "aria-hidden": "true" });
  const draw = (close) => {
    const all = store.list();
    list.replaceChildren(
      ...(all.length
        ? all.map((l) =>
            h(
              "div",
              { class: "list-row layout-row", role: "listitem" },
              h("span", { class: "names" }, h("span", { class: "nm" }, l.name), h("span", { class: "sub" }, layoutSub(l))),
              h("span", { class: "layout-actions" }, h("button", { type: "button", class: "small primary", "aria-label": `Load layout ${l.name}`, onclick: () => (close(undefined), applyLayout(l)) }, "Load"), h("button", { type: "button", class: "small", "aria-label": `Delete layout ${l.name}`, onclick: () => (store.remove(l.name), (note.textContent = `Deleted “${l.name}”.`), draw(close)) }, "Delete")),
            ),
          )
        : [h("p", { class: "muted small layout-empty" }, "No saved layouts yet. Name the current workspace above to keep it.")]),
    );
  };
  const body = (close) => {
    const save = () => {
      const r = store.save(captureLayout(nameInput.value));
      if (!r.ok) {
        note.textContent = r.error;
        note.dataset.state = "bad";
        return;
      }
      note.dataset.state = "ok";
      note.textContent = `Saved “${r.layout.name}”.`;
      nameInput.value = "";
      draw(close);
    };
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      note.dataset.state = "bad";
      if (file.size > MAX_IMPORT_CHARS * 4) {
        note.textContent = "That file is too large to be a layout export.";
        return;
      }
      const r = parseLayoutFile(await file.text(), { pageIds: hooks?.pages().map((p) => p.id), groups: [...new Set(hooks?.pages().map((p) => p.group) ?? [])] });
      if (!r.ok) {
        note.textContent = r.error;
        return;
      }
      const n = store.importAll(r.layouts);
      note.dataset.state = "ok";
      note.textContent = `Imported ${n} ${n === 1 ? "layout" : "layouts"}${r.skipped.length ? `; skipped ${r.skipped.length} that did not check out (${r.skipped[0]})` : ""}.`;
      draw(close);
    });
    draw(close);
    queueMicrotask(() => (focus === "save" ? nameInput : null)?.focus());
    return h(
      "div",
      { class: "stack layouts-sheet" },
      h("p", { class: "muted small" }, "A layout remembers the underlying, expiry, strikes, density, auto-refresh, the page you are on and which sidebar groups are folded. It is kept in this browser."),
      h("div", { class: "layout-save" }, h("label", { class: "pal-sr-only", for: "layout-name" }, "Name for the current workspace"), nameInput, h("button", { type: "button", class: "primary", onclick: save }, "Save current")),
      note,
      list,
      h(
        "div",
        { class: "row layout-io" },
        h("button", { type: "button", class: "small", onclick: () => {
          if (!store.list().length) {
            note.dataset.state = "bad";
            note.textContent = "Nothing to export yet.";
            return;
          }
          downloadText(store.exportText(), "mc-bridge-layouts.json", "application/json");
          note.dataset.state = "ok";
          note.textContent = "Exported every saved layout as mc-bridge-layouts.json.";
        } }, "Export JSON"),
        h("button", { type: "button", class: "small", onclick: () => fileInput.click() }, "Import JSON"),
        fileInput,
      ),
    );
  };
  return modal({ title: "Layouts", body, buttons: [{ label: "Done", cls: "primary", value: true }] });
}

// ───────────────────────── page help drawer ─────────────────────────

let drawer = null;
let drawerReturn = null;

/** The clickable page code in the page header: shows the code and opens the page's help. */
export function pageCodeChip(page) {
  const code = codeOf(page?.id);
  if (!code) return null;
  return h("button", { type: "button", class: "page-code", title: `Page code ${code}. Type it in search (or “help ${code.toLowerCase()}”) to open this page; press for help.`, "aria-label": `Page code ${code}. Open help for this page`, onclick: () => openHelp(page.id) }, code);
}

/** The help drawer for page `id`: what it is for, what its fields mean and where the guide is. Text only. */
export function openHelp(id) {
  const page = hooks?.pages().find((p) => p.id === id);
  const data = helpFor(id);
  if (!page || !data) return false;
  if (!drawer) {
    drawer = h("dialog", { class: "help-drawer", "aria-modal": "true", "aria-labelledby": "help-title" });
    drawer.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeHelp();
    });
    drawer.addEventListener("click", (e) => {
      if (e.target === drawer) closeHelp(); // the dialog box is the panel; a click on its backdrop lands on the dialog itself
    });
    document.body.append(drawer);
  }
  if (!drawer.open) drawerReturn = document.activeElement;
  const code = codeOf(id);
  const keys = goKeyTable(hooks.pages().map((p) => p.id));
  const goKey = Object.entries(keys).find(([, pid]) => pid === id)?.[0];
  const docPath = data.doc;
  drawer.replaceChildren(
    h(
      "header",
      { class: "help-head" },
      h("div", { class: "help-titles" }, h("span", { class: "eyebrow" }, `${page.group} · help`), h("h2", { id: "help-title" }, page.title), h("p", { class: "help-keys" }, h("span", { class: "page-code static" }, code), goKey ? h("span", {}, `  g ${[...goKey].join(" ")}`) : null)),
      h("button", { type: "button", class: "icon-btn help-close", "aria-label": "Close help", onclick: () => closeHelp() }, icon("close")),
    ),
    h(
      "div",
      { class: "help-body" },
      h("p", { class: "help-what" }, data.what),
      data.note ? h("p", { class: "help-note muted small" }, data.note) : null,
      h("h3", { class: "help-sub" }, "What the fields mean"),
      h("dl", { class: "help-fields" }, data.fields.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
      h("h3", { class: "help-sub" }, "Read more"),
      h("p", { class: "help-doc" }, h("code", {}, docPath), h("button", { type: "button", class: "small", onclick: () => copyText(docPath, "Path copied") }, icon("copy"), "Copy path")),
      h("p", { class: "muted small" }, `The guide ships in this Bridge's folder (${GUIDE_BASE}).`),
    ),
    h("footer", { class: "help-foot" }, h("button", { type: "button", class: "primary", onclick: () => (closeHelp({ restore: false }), hooks.go(id)) }, `Open ${page.label}`), h("button", { type: "button", onclick: () => closeHelp() }, "Close")),
  );
  if (!drawer.open) {
    drawer.showModal();
    lockScroll(true);
  }
  drawer.querySelector(".help-close")?.focus();
  return true;
}

export function closeHelp({ restore = true } = {}) {
  if (!drawer?.open) return;
  drawer.close();
  if (!document.getElementById("dialog")?.open) lockScroll(false);
  if (restore && drawerReturn && document.contains(drawerReturn)) drawerReturn.focus?.();
  drawerReturn = null;
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
    canRun: () => !document.getElementById("dialog")?.open && !document.querySelector("dialog.palette[open], dialog.help-drawer[open]") && $("content")?.getAttribute("aria-busy") !== "true" && !typingInContent(),
  });
  document.addEventListener("visibilitychange", () => refresher.visibilityChanged());
  workspace.subscribe(() => {
    paintContext();
    recordHistory();
  });
  paintContext();
  paintHistory();
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
  nowShowing.id = page?.id ?? null;
  if (!ui) return;
  recordHistory();
  suppressRecord = false;
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
