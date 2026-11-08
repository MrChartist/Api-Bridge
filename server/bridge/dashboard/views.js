// Dashboard pages. Each page renders into #content from live Bridge data; nothing here stores data outside this tab
// except small conveniences in localStorage (theme, density, the last tab of each page).
import { alertBox, api, app, brokerMatches, card, codeBlock, confirmCodeNotice, copyButton, currentKey, emptyState, fillLoginUrl, h, highlightJson, icon, iconTile, istDateTime, istTime, loginBody, loginFormSpec, meterRow, modal, optional, pill, table, ticketFields, toast, sheetPopover, confirmEngageKillSwitch, DEMO_EXPLAINER, beginNavigation, onRevalidated, pageSkeleton, prefetchPage } from "./app.js";
import { STATE_TEXT, STATE_TONE, readinessCard, refreshReadiness } from "./readiness.js";
import { DASH, formatFixed, formatInt, formatRupee, formatRupeeGrouped, formatSignedRupee, isFigure } from "./format.js";
import { DENSITY_SLOT, parseDensity } from "./layout-prefs.js";
import { busiestClass, mountBudget, perSecondLimit, usageChart, windowText } from "./budget.js";
import * as live from "./live.js";
import { KEY_PRESETS, snippets } from "./snippets.js";
import { KEY_USES, WORKING_ORDER, afterDemoSaveSteps, brokerSetupSteps, capabilityLabel, contractName, orderStatusText, capabilitySummary, clearFieldError, defaultKeyName, fieldError, keyFormProblem, keyUse, modifyChange } from "./flows.js";
import { initPalette, kbd, openPalette, pageShortcut, searchIcon, shortcut } from "./palette.js";
import { fundsCard, ordersCard, renderTradesPage } from "./orders-book.js";
import { whatToDo } from "./reasons-core.js";

const $ = (id) => document.getElementById(id);

/** Warm the data of a page ahead of a click (menu hover or focus). Idempotent and cheap. */
export function preloadPage(pageId) {
  const page = PAGES.find((p) => p.id === pageId);
  if (!page) return;
  const tab = page.tabs ? page.tabs.find((t) => t.id === (readLastTab(page.id) ?? page.defaultTab)) ?? page.tabs[0] : null;
  prefetchPage(tab?.page ?? page.id);
}
const local = app.local;
const HIDE_OWN_SLOT = "mcb.dashboard.hideOwnRequests";
/** A button at work: disabled, its label swapped for a turning ring, its width kept. */
const busy = (b, on) => {
  b.disabled = on;
  if (on) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
};
const scopeChip = (s) => h("span", { class: `chip scope-${s}` }, s);
/** Sentence case for a status word from the API ("filled" → "Filled"). */
export const cap = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : DASH);
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
const initials = (name) => String(name).replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
/**
 * A broker's logo tile (served from dashboard/brokers/<id>.png), or its initials when there is no logo for it.
 * @param {{ id: string, name: string }} b @param {string} [extra] more classes
 */
function brokerAvatar(b, extra = "") {
  const tile = h("span", { class: `avatar logo ${extra}`.trim(), "aria-hidden": "true" });
  const fallback = () => {
    tile.classList.remove("logo");
    tile.replaceChildren(initials(b.name));
  };
  // The demo broker has no logo file (it is not a real broker): its initials, without a request that would 404.
  if (!/^[a-z0-9]{2,32}$/.test(String(b.id)) || b.id === "demo") {
    fallback();
    return tile;
  }
  tile.append(h("img", { src: `/dashboard/broker-${b.id}.png`, alt: "", loading: "lazy", decoding: "async", width: 64, height: 64, onerror: fallback }));
  return tile;
}
/** Money with the gain / loss colour and an explicit sign (P&L). */
export function pnl(v, dp = 2) {
  if (!isFigure(v)) return DASH;
  const text = formatSignedRupee(v, dp);
  const n = Number(v);
  return h("span", { class: text.startsWith("₹") ? undefined : n > 0 ? "up" : "down" }, text);
}
/** A button for an empty state's next step: goes to a page (hash) or runs a function. */
const nextStep = (label, to, cls = "primary") => h("button", { type: "button", class: cls, onclick: typeof to === "function" ? to : () => (location.hash = to) }, label);

/**
 * A macOS segmented control for 2-4 mutually exclusive options. The returned element has a `.value` like a <select>,
 * so the code that reads it does not change. Arrow keys move the choice; only the chosen button is in the Tab order.
 */
export function segmented(label, options, initial = options[0][0]) {
  let value = initial;
  const el = h("div", { class: "segmented", role: "group", "aria-label": label });
  const buttons = options.map(([v, text]) => h("button", { type: "button", "data-value": v, onclick: () => pick(v, false) }, text));
  /** Slide the contrast thumb (a ::before on the track) under the chosen button: --seg-x / --seg-w. The button's
   *  own background is the fallback until it is measured (not in the document yet, or a hidden panel). */
  let measured = false;
  const place = () => {
    const b = buttons.find((x) => x.dataset.value === value);
    if (!b || !el.isConnected || !b.offsetWidth) return;
    if (!measured) el.classList.add("no-anim");
    el.style.setProperty("--seg-x", `${b.offsetLeft}px`);
    el.style.setProperty("--seg-w", `${b.offsetWidth}px`);
    el.classList.add("has-thumb");
    if (!measured) {
      measured = true;
      requestAnimationFrame(() => el.classList.remove("no-anim"));
    }
  };
  // Measure once it is laid out, and again whenever the track changes size (fonts, rotation, wrap). A detached
  // control stops observing (a 0 × 0 callback) and starts again on its next pick.
  let ro = null;
  const watch = () => {
    if (ro || typeof ResizeObserver !== "function") return;
    let seen = false;
    ro = new ResizeObserver(() => {
      if (el.isConnected) return (seen = true), place();
      if (!seen) return;
      ro?.disconnect();
      ro = null;
    });
    ro.observe(el);
  };
  const pick = (v, focus) => {
    value = v;
    watch();
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute("aria-pressed", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    place();
    el.dispatchEvent(new Event("change"));
  };
  el.addEventListener("keydown", (e) => {
    const i = buttons.findIndex((b) => b.dataset.value === value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    pick(buttons[(i + step + buttons.length) % buttons.length].dataset.value, true);
  });
  el.append(...buttons);
  Object.defineProperty(el, "value", { get: () => value, set: (v) => pick(String(v), false) });
  pick(initial, false);
  watch();
  return el;
}
/** A labelled field around a segmented control (a <label> would forward clicks on its text to the first button). */
export const segField = (label, seg, { wide = false } = {}) => {
  const id = `seg-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${++segField.n}`;
  seg.removeAttribute("aria-label");
  seg.setAttribute("aria-labelledby", id);
  return h("div", { class: wide ? "field seg-field wide" : "field seg-field" }, h("span", { id }, label), seg);
};
segField.n = 0;

/**
 * Tabs with the WAI-ARIA keyboard pattern: arrow keys, Home and End move between tabs; focus stays on the chosen tab
 * after the panel is redrawn. `onPick(id)` redraws.
 */
function drawTabs(bar, panel, tabs, active, onPick) {
  const hadFocus = bar.contains(document.activeElement);
  const base = bar.id || (bar.id = `tabs-${++drawTabs.n}`);
  panel.id ||= `${base}-panel`;
  panel.setAttribute("role", "tabpanel");
  const buttons = tabs.map(([id, label]) =>
    h("button", { type: "button", role: "tab", id: `${base}-${id}`, "aria-selected": String(id === active), "aria-controls": panel.id, tabindex: id === active ? "0" : "-1", onclick: () => onPick(id) }, label),
  );
  bar.replaceChildren(...buttons);
  panel.setAttribute("aria-labelledby", `${base}-${active}`);
  bar.onkeydown = (e) => {
    const i = tabs.findIndex(([id]) => id === active);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    onPick(tabs[(j + tabs.length) % tabs.length][0]);
  };
  if (hadFocus) buttons.find((b) => b.getAttribute("aria-selected") === "true")?.focus();
}
drawTabs.n = 0;

/**
 * Pages that redraw on a timer would drop keyboard focus every few seconds. Run `fn` (which replaces the children of
 * `container`) and put focus back on the equivalent control if it was inside.
 */
export function keepFocus(container, fn) {
  const sig = focusSignature(container);
  const r = fn();
  restoreFocus(container, sig);
  return r;
}
async function keepFocusAsync(container, fn) {
  const sig = focusSignature(container);
  await fn();
  restoreFocus(container, sig);
}
function focusSignature(container) {
  const a = document.activeElement;
  if (!a || a === document.body || !container.contains(a)) return null;
  return { el: a, sig: `${a.tagName}|${a.id}|${a.getAttribute("aria-label") ?? ""}|${a.textContent.trim()}` };
}
function restoreFocus(container, saved) {
  if (!saved || document.activeElement === saved.el) return;
  if (saved.el.isConnected) return saved.el.focus({ preventScroll: true });
  const same = [...container.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")].find((e) => `${e.tagName}|${e.id}|${e.getAttribute("aria-label") ?? ""}|${e.textContent.trim()}` === saved.sig);
  same?.focus({ preventScroll: true });
}

// ── Pages ──

/** The Integrations tab's tools (its inner segmented control; each is also a Ctrl K destination). */
const INTEGRATION_TOOLS = [
  ["webhooks", "Webhooks"],
  ["python", "Python"],
  ["node", "Node"],
  ["excel", "Excel and Sheets"],
  ["amibroker", "AmiBroker"],
  ["claude", "Claude (MCP)"],
  ["chatgpt", "ChatGPT / OpenAI"],
  ["rest", "REST / curl"],
];

/**
 * The one list of pages: it feeds the sidebar, the phone tab bar, the More sheet and the Ctrl K palette
 * `group` is the sidebar group, `tint` an iOS system
 * colour name (the page's glyph colour everywhere), `key` the curated Ctrl 1 to Ctrl 9 shortcut, `tab: true` puts it in the
 * phone tab bar (`short` labels it there),  `headline` is the large title when it differs from `title`. A page with `tabs` is one page with a tab strip: each tab names the page id it renders as (`page`, the
 * `:root[data-page]` value that scopes its CSS and the id older links used), may set its own `sub`, and `command` is its
 * Ctrl K label; `extras` are further Ctrl K destinations inside it.
 */
export const PAGES = [
  { id: "accounts", label: "Accounts", icon: "accounts", tint: "indigo", tab: true, group: "Bridge", title: "Accounts and brokers", sub: "Broker accounts, sessions and the 41 supported brokers", render: renderAccounts },
  {
    id: "api", label: "API", icon: "keys", tint: "pink", tab: true, key: 9, group: "Bridge", title: "API", sub: "Keys, integrations, a test console, rate limits and the request log",
    defaultTab: "keys",
    tabs: [
      { id: "keys", label: "Keys", page: "keys", command: "API keys", keywords: "keys token access create revoke", render: renderKeys },
      {
        id: "integrations", label: "Integrations", page: "integrations", command: "Integrations", icon: "integrations", tint: "blue", keywords: "integrations snippets connect tools sdk", render: renderIntegrations,
        extras: INTEGRATION_TOOLS.map(([id, label]) => ({ id, label: id === "webhooks" ? "Webhooks" : `${label} snippet`, route: `api/integrations?tool=${id}`, keywords: id === "webhooks" ? "webhook alert chartink gocharting hooks" : `${id} snippet setup code`, sub: `API › Integrations › ${label}` })),
      },
      { id: "console", label: "Test console", page: "console", command: "Test console", icon: "console", tint: "teal", keywords: "console try request call endpoint", render: renderConsole },
      { id: "limits", label: "Rate limits", page: "limits", command: "Rate limits", icon: "limits", tint: "purple", keywords: "limits usage throttle budget", render: renderLimits },
      {
        id: "activity", label: "Activity", page: "activity", command: "Activity", icon: "activity", tint: "gray", keywords: "activity requests log", render: renderActivity,
        extras: [{ id: "audit", label: "Audit log", route: "api/activity?view=audit", keywords: "audit log hash chain tamper", sub: "API › Activity › Audit log" }],
      },
    ],
  },
  {
    id: "orders", label: "Orders", icon: "orders", tint: "orange", tab: true, key: 5, group: "Trade", title: "Orders", sub: "Paper by default. Pending confirmations wait here",
    defaultTab: "book",
    tabs: [
      { id: "book", label: "Orders", page: "orders", command: "Orders", keywords: "orders confirmations tickets modify cancel paper", render: renderOrders },
      { id: "trades", label: "Trades", page: "trades", command: "Trade book", icon: "list", tint: "orange", keywords: "trades trade book fills executions turnover charges csv", sub: "Every fill with buy, sell and turnover totals", render: renderTradesPage },
    ],
  },
  { id: "safety", label: "Safety", icon: "safety", tint: "red", tab: true, key: 6, group: "Trade", title: "Safety", sub: "Kill switch, daily limits and live-trading status", render: renderSafety },
];

/** Old page ids that became tabs: an old link or bookmark opens the tab, keeping its ?query. */
export const LEGACY = {
  console: "api/console",
  limits: "api/limits",
  keys: "api/keys",
  integrations: "api/integrations",
  activity: "api/activity",
};

/**
 * Where a hash leads (pure): { page, tab, query, redirect, view }. `#/<page>/<tab>?query`; a LEGACY id is
 * rewritten (`redirect` is the hash to put in its place; Integrations' old `?tab=` becomes `?tool=`); an unknown page
 * is the first page, an unknown or missing tab the page's last tab (`lastTab(pageId)`) or its default. `view` is the legacy page
 * id the view renders as (the `data-page` value).
 */
export function resolveRoute(hash, { pages = PAGES, lastTab = () => null } = {}) {
  let raw = String(hash ?? "").replace(/^#\/?/, "");
  // A one-time sign-in fragment (#signin=..., app.js removes it at start-up) is never a page name.
  if (raw.startsWith("signin=")) raw = "";
  const q = raw.indexOf("?");
  let path = (q < 0 ? raw : raw.slice(0, q)).toLowerCase();
  let query = q < 0 ? "" : raw.slice(q + 1);
  let redirect = null;
  const head = path.split("/")[0];
  if (Object.hasOwn(LEGACY, head) && !path.includes("/")) {
    path = LEGACY[head];
    if (head === "integrations") {
      const qs = new URLSearchParams(query);
      if (qs.has("tab") && !qs.has("tool")) qs.set("tool", qs.get("tab"));
      qs.delete("tab");
      query = qs.toString();
    }
    redirect = `#/${path}${query ? `?${query}` : ""}`;
  }
  const [pageId, tabId] = path.split("/");
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  let tab = null;
  if (page.tabs?.length) {
    const find = (id) => (id ? page.tabs.find((t) => t.id === id) : undefined);
    tab = find(tabId) ?? find(lastTab(page.id)) ?? find(page.defaultTab) ?? page.tabs[0];
    // A tab that no longer exists (#/api/nope) shows its stand-in under the stand-in's own address.
    if (tabId && tab.id !== tabId) redirect = `#/${page.id}/${tab.id}${query ? `?${query}` : ""}`;
  }
  return { page, tab, query, redirect, view: tab?.page ?? page.id };
}

const TAB_SLOT = (pageId) => `mcb.tab.${pageId}`;
const readLastTab = (pageId) => {
  try {
    return localStorage.getItem(TAB_SLOT(pageId));
  } catch {
    return null;
  }
};
const rememberTab = (pageId, tabId) => {
  try {
    localStorage.setItem(TAB_SLOT(pageId), tabId);
  } catch {
    /* private mode or storage off: the default tab opens next time */
  }
};

let timer = null;
let renderSeq = 0;

/** A tinted page glyph for the sidebar and toolbar. */
const pageGlyph = (p) => {
  const s = icon(p.icon);
  s.classList.add(`tint-${p.tint}`);
  return s;
};

function nav(active) {
  const out = [];
  let group = null;
  for (const p of PAGES) {
    if (p.group !== group) {
      group = p.group;
      // A group label heads each run of pages.
      if (group) out.push(h("div", { class: "nav-group" }, group));
    }
    const sc = pageShortcut(p);
    out.push(
      h(
        "a",
        { href: `#/${p.id}`, class: `tint-${p.tint}`, "aria-current": p.id === active ? "page" : undefined, "data-page": p.id, title: sc ? `${p.label} (${sc.label})` : p.label, "aria-keyshortcuts": sc?.aria },
        icon(p.icon),
        h("span", { class: "lbl" }, p.label),
        p.id === "orders" ? h("span", { class: "count", id: "nav-tickets", "data-tickets": "", hidden: true }) : null,
      ),
    );
  }
  $("nav").replaceChildren(...out);
  edgeFades($("nav"), "y");
  tabbar(active);
}

/**
 * Overflow hints: a scroller gets fade-l / fade-r (or fade-b, axis "y") only while there is more
 * to see on that side. Wired once per element; call again after its content changes.
 */
export function edgeFades(el, axis = "x") {
  if (!el) return;
  const update = () => {
    if (axis === "y") {
      el.classList.toggle("fade-b", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
      return;
    }
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("fade-l", max > 1 && el.scrollLeft > 1);
    el.classList.toggle("fade-r", max > 1 && el.scrollLeft < max - 1);
  };
  if (!el.dataset.fades) {
    el.dataset.fades = axis;
    el.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(el);
  }
  update();
}

/**
 * Card tables: a table that fits its card is not a scroll box (.fits), so its sticky head sticks to
 * the page; a wider one scrolls sideways with a fade on the side that has more.
 */
function fitTables(root) {
  for (const w of root.querySelectorAll(".card .table-wrap")) {
    const t = w.querySelector(":scope > table");
    if (!t) continue;
    const fits = t.offsetWidth <= w.clientWidth + 1;
    w.classList.toggle("fits", fits);
    if (fits) w.classList.remove("fade-l", "fade-r");
    else edgeFades(w);
  }
}

/** The phone / tablet tab bar: the four `tab` pages and More (a sheet with the other pages, appearance and the key). */
function tabbar(active) {
  const bar = $("tabbar");
  if (!bar) return;
  const inTabs = PAGES.filter((p) => p.tab);
  const moreActive = !inTabs.some((p) => p.id === active);
  bar.replaceChildren(
    ...inTabs.map((p) =>
      h(
        "a",
        { href: `#/${p.id}`, class: "tab", "data-page": p.id, "aria-current": p.id === active ? "page" : undefined },
        icon(p.icon),
        h("span", {}, p.short ?? p.label),
        p.id === "orders" ? h("span", { class: "count", "data-tickets": "", hidden: true }) : null,
      ),
    ),
    h("button", { type: "button", class: "tab", "aria-haspopup": "dialog", "aria-current": moreActive ? "page" : undefined, onclick: () => moreSheet(active) }, icon("more"), h("span", {}, "More")),
  );
}

/** The bridge mark on its accent tile (the same mark as the sidebar and sign-in). */
const markTile = (large = false) => h("span", { class: `lockup-mark${large ? " lg" : ""}`, "aria-hidden": "true" }, icon("bridge"));
/** One row of an inset grouped list: an optional tile, a title with optional secondary line, and a trailing chevron or value. */
function listRow({ tag = "button", tile, title, sub, value, cls = "", ...attrs }) {
  const interactive = tag === "button";
  return h(
    tag,
    { ...(interactive ? { type: "button" } : {}), class: `list-row ${interactive ? "" : "static"} ${cls}`.replace(/\s+/g, " ").trim(), ...attrs },
    tile ?? null,
    h("span", { class: "names" }, h("span", { class: "nm" }, title), sub ? h("span", { class: "sub" }, sub) : null),
    value ? h("span", { class: "value" }, value) : null,
    interactive && !attrs["data-action"] ? chevron() : null,
  );
}

/**
 * "More" (phones and tablets): any page that is not in the tab bar (grouped as in the sidebar, the current one filled with
 * a check), then appearance, density and this browser (the signed-in key, keyboard shortcuts, About and Forget key).
 */
function moreSheet(active) {
  const pages = PAGES.filter((p) => !p.tab);
  const groups = [...new Set(pages.map((p) => p.group))];
  return modal({
    title: "More",
    body: (close) => {
      const goTo = (id) => {
        close(undefined);
        go(id);
      };
      return h(
        "div",
        { class: "more-sheet" },
        groups.map((g) =>
          h(
            "section",
            { class: "group" },
            g ? h("h3", { class: "group-title" }, g) : null,
            h(
              "div",
              { class: "list" },
              pages.filter((p) => p.group === g).map((p) => {
                const row = listRow({ tile: iconTile(p.icon, p.tint, "md"), title: p.label, "aria-current": p.id === active ? "page" : undefined, onclick: () => goTo(p.id) });
                if (p.id === active) row.lastElementChild.replaceWith(checkMark());
                return row;
              }),
            ),
          ),
        ),
        h(
          "section",
          { class: "group" },
          h("h3", { class: "group-title", id: "more-appearance" }, "Appearance"),
          appearanceControl("more-appearance"),
        ),
        h(
          "section",
          { class: "group density-ctl" },
          h("h3", { class: "group-title", id: "more-density" }, "Density"),
          densityControl("more-density"),
        ),
        h(
          "section",
          { class: "group" },
          h("h3", { class: "group-title" }, "This browser"),
          h(
            "div",
            { class: "list" },
            listRow({ tag: "div", tile: iconTile("user", "indigo", "md"), title: "Signed in", sub: app.state.who ?? "" }),
            listRow({ tile: iconTile("bolt", "orange", "md"), title: "Keyboard shortcuts", cls: "more-shortcuts", onclick: () => { close(undefined); showShortcutsLater(); } }),
            listRow({ tile: iconTile("info", "gray", "md"), title: "About API Bridge", onclick: () => { close(undefined); aboutLater(); } }),
            listRow({ tile: iconTile("logout", "red", "md"), title: "Forget key", sub: "Sign out of this tab", cls: "destructive", "data-action": "logout" }),
          ),
        ),
      );
    },
  });
}

/**
 * The sidebar's account row opens this (a popover, a bottom sheet on phones): who is signed in, appearance, density,
 * keyboard shortcuts, About and Forget key.
 */
function accountPopover(trigger) {
  const body = h(
    "div",
    { class: "acct-pop" },
    h("div", { class: "acct-head" }, iconTile("user", "indigo", "lg"), h("div", { class: "names" }, h("strong", {}, "Signed in"), h("span", { class: "sub" }, app.state.who ?? ""))),
    h("section", { class: "group" }, h("h3", { class: "group-title", id: "acct-appearance" }, "Appearance"), appearanceControl("acct-appearance")),
    h("section", { class: "group density-ctl" }, h("h3", { class: "group-title", id: "acct-density" }, "Density"), densityControl("acct-density")),
    h(
      "div",
      { class: "list" },
      listRow({ tile: iconTile("bolt", "orange", "sm"), title: "Keyboard shortcuts", onclick: () => { pop.close(); showShortcutsLater(); } }),
      listRow({ tile: iconTile("info", "gray", "sm"), title: "About API Bridge", onclick: () => { pop.close(); aboutLater(); } }),
      listRow({ tile: iconTile("logout", "red", "sm"), title: "Forget key", sub: "Sign out of this tab", cls: "destructive", "data-action": "logout" }),
    ),
  );
  const pop = sheetPopover({ trigger, title: "Account", body, cls: "acct-popover" });
  return pop;
}

/** About: what this is, the version, the licence and the author credit (the credit also lives in LICENSE). */
function aboutSheet() {
  return modal({
    title: "About",
    body: () =>
      h(
        "div",
        { class: "stack about-body" },
        markTile(true),
        h("h3", {}, "API Bridge"),
        h("p", { class: "muted" }, `Version ${app.state.health?.version ?? ""}`),
        h("p", { class: "muted small" }, "One local API for your broker accounts, with rate-limit-aware routing, streaming and safety gates. Paper trading is the default."),
        h(
          "div",
          { class: "list" },
          listRow({ tag: "div", title: "Licence", value: "MIT" }),
          listRow({ tag: "div", title: "Created by", value: "Mr. Chartist" }),
          listRow({ tag: "div", title: "Fonts", value: "Your system fonts" }),
        ),
      ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}
const aboutLater = () => setTimeout(aboutSheet, 260);
const showShortcutsLater = () => setTimeout(() => import("./palette.js").then((m) => m.showShortcuts()), 260);
const chevron = () => {
  const s = icon("chevron");
  s.classList.add("chev");
  return s;
};
/** The More sheet's mark for the current page: a check in the accent, where the others have a chevron. */
const checkMark = () => {
  const s = icon("check");
  s.classList.add("check");
  return s;
};
/** Light / Dark / Auto, as in the sidebar (app.js handles the clicks for every copy). */
function appearanceControl(labelledBy) {
  const current = document.documentElement.getAttribute("data-theme") ?? "auto";
  return h(
    "div",
    { class: "segmented appearance", role: "group", "aria-labelledby": labelledBy },
    [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["auto", "Auto", "monitor"]].map(([v, label, ic]) => h("button", { type: "button", "data-theme-choice": v, "aria-pressed": String(current === v) }, icon(ic), label)),
  );
}

/**
 * Compact / Comfortable / Auto (app.js handles the clicks for every copy). Auto is compact with a mouse on a desktop;
 * touch screens are always comfortable, so the control is hidden there (app.css section 11).
 */
function densityControl(labelledBy) {
  let current = "auto";
  try {
    current = parseDensity(localStorage.getItem(DENSITY_SLOT));
  } catch {
    /* storage blocked: auto */
  }
  return h(
    "div",
    { class: "segmented density density-ctl", role: "group", "aria-labelledby": labelledBy },
    [["compact", "Compact"], ["comfortable", "Comfortable"], ["auto", "Auto"]].map(([v, label]) => h("button", { type: "button", "data-density-choice": v, "aria-pressed": String(current === v), title: v === "auto" ? "Compact with a mouse on a desktop, comfortable on touch" : undefined }, label)),
  );
}

/** Re-run `fn` every `ms` while this page is shown and the tab is visible. */
export function every(ms, fn) {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden) fn().catch(() => {});
  }, ms);
}

let shownPage = null;
let pendingFocus = null;
/** The render (renderSeq) already redrawn after fresh data, and the debounce for it. */
let redrawnFor = 0;
let redrawTimer = null;

/** The page's large title: plain text. */
const headline = (page) => page.headline ?? page.title;
/**
 * Draw the page the hash names. `opts.refresh`: the Reload button, the palette or a redraw after fresh data came in;
 * a reload never paints from remembered answers.
 */
async function show(opts) {
  const reload = opts?.refresh === true;
  const route = resolveRoute(location.hash, { lastTab: readLastTab });
  // An old link (#/console?endpoint=order) becomes its tab's address, without a second history entry.
  if (route.redirect && typeof history !== "undefined") history.replaceState(history.state, "", route.redirect);
  const { page, tab } = route;
  if (tab) rememberTab(page.id, tab.id);
  const changed = route.view !== shownPage;
  shownPage = route.view;
  clearInterval(timer);
  $("toast").hidden = true;
  nav(page.id);
  // data-page is the view's own id (a tab's page id, for CSS), data-route the page in the menu.
  const root = $("content");
  document.documentElement.dataset.page = route.view;
  document.documentElement.dataset.route = page.id;
  document.documentElement.classList.remove("panel-max-open");
  root.classList.toggle("api-page", page.id === "api");
  document.title = tab ? `${tab.label} · ${page.label} · API Bridge` : `${page.label} · API Bridge`;
  $("toolbar-icon").replaceChildren(pageGlyph(page));
  // The page name only: the tab strip right under it names the tab ("API: Integrations" clipped on phones).
  $("toolbar-label").textContent = page.label;
  $("page-eyebrow").textContent = page.group;
  $("page-title").textContent = headline(page);
  $("page-sub").textContent = tab?.sub ?? page.sub;
  $("toolbar-demo").hidden = !app.state.demo;
  const seq = ++renderSeq;
  // Its first reads may paint from what the dashboard already has (app.js api), then refresh behind it.
  if (!reload) beginNavigation(route.view);
  redrawnFor = reload ? seq : 0;
  // A tabbed page: the tab strip is the first row of the page; only the chosen tab renders (and refreshes).
  const tabs = tab ? pageTabs(page, tab, root) : null;
  if (!tabs) {
    root.removeAttribute("role");
    root.setAttribute("aria-labelledby", "page-title");
  }
  root.setAttribute("aria-busy", "true");
  root.replaceChildren(...[tabs, pageSkeleton()].filter(Boolean));
  if (tabs) edgeFades(tabs.firstElementChild);
  try {
    const nodes = await (tab?.render ?? page.render)();
    if (seq !== renderSeq) return;
    root.replaceChildren(...[tabs, nodes].flat().filter(Boolean));
    arrangePanels(root, route.view);
    fitTables(root);
  } catch (err) {
    if (seq !== renderSeq) return;
    root.replaceChildren(...[tabs, alertBox(err)].filter(Boolean));
  }
  root.removeAttribute("aria-busy");
  if (tabs) revealActiveTab(tabs.firstElementChild);
  const title = tab ?`${page.title}: ${tab.label}` : page.title;
  announce(changed ? `${title} page` : `${title} refreshed`);
  if (pendingFocus) {
    const target = pendingFocus === true ? null : root.querySelector(pendingFocus);
    pendingFocus = null;
    (target ?? root).focus({ preventScroll: !target });
  }
  if (changed) window.scrollTo({ top: 0 });
  const anim = motionHooks?.animatePage;
  if (typeof anim === "function") anim(root);
  refreshTicketCount();
}

/**
 * On a phone the page tab strip scrolls sideways: bring the current tab fully into view (API › Rate limits sat half
 * cut off at the right edge). Called once the strip is in the page for good (re-inserting it resets its scroll).
 */
function revealActiveTab(bar) {
  const sel = bar?.querySelector('[aria-selected="true"]');
  if (!sel || bar.scrollWidth <= bar.clientWidth) return;
  const b = bar.getBoundingClientRect();
  const s = sel.getBoundingClientRect();
  if (s.right > b.right - 4) bar.scrollLeft += s.right - b.right + 24;
  else if (s.left < b.left + 4) bar.scrollLeft -= b.left - s.left + 24;
}

/**
 * The tab strip of a tabbed page: a segmented tab list, the page's first row. Picking a tab goes
 * to `#/<page>/<tab>` (the hash is the state), so back and forward walk the tabs. #content is its tab panel.
 */
function pageTabs(page, tab, panel) {
  const bar = h("div", { class: "segmented page-tabs", role: "tablist", id: `page-tabs-${page.id}`, "aria-label": `${page.label} sections` });
  drawTabs(bar, panel, page.tabs.map((t) => [t.id, t.label]), tab.id, (id) => go(`${page.id}/${id}`, `#page-tabs-${page.id}-${id}`));
  // A full-width row of its own (pages that lay their panels out in a wrapping row stretch every child).
  return h("div", { class: "page-tabs-row", "data-fixed": "" }, bar);
}

// ── Movable panels ──

const layoutSlot = (pageId) => `mcb.dashboard.layout.${pageId}`;
const panelKey = (el, i) => el.dataset.panel || el.querySelector(".card-head h2")?.textContent?.trim() || el.getAttribute("aria-label") || `panel-${i}`;
const movables = (root) => [...root.children].filter((el) => el.classList.contains("movable"));
const saveLayout = (root, pageId) => local.set(layoutSlot(pageId), JSON.stringify(movables(root).map((el) => el.dataset.panelKey)));

/**
 * Give each top-level panel of a page a handle to move it (drag, or arrow keys on the handle) and a button to
 * maximise it, and put the panels in the order this browser saved for the page. Panels marked data-fixed stay put.
 */
function arrangePanels(root, pageId) {
  // Empty hosts (an error or notice slot that fills later) are not panels: a move strip on them is a bare rule.
  const items = [...root.children].filter((el) => !el.hasAttribute("data-fixed") && !el.matches("p, .alert") && (el.firstElementChild || el.textContent.trim()));
  if (items.length < 2 && !items.some((el) => el.dataset.panel)) return;
  items.forEach((el, i) => {
    el.dataset.panelKey = panelKey(el, i);
    el.classList.add("movable");
    if (!el.querySelector(":scope > .panel-tools") && !el.querySelector(":scope > * > .panel-tools.in-head")) {
      const tools = panelTools(el, root, pageId);
      el.prepend(panelEdge(el), tools);
      // Touch tablets: the tools sit in flow in the panel's own head row (never over its content); a panel without a
      // head gets a 44 px strip instead (CSS). Phones hide them (one column).
      const head = typeof matchMedia === "function" && matchMedia("(pointer: coarse) and (min-width: 720px)").matches ? el.querySelector(":scope > :is(.panel-head, .card-head, header)") : null;
      if (head) {
        tools.classList.add("in-head");
        // On the head's first line: right after its title (or its only control group).
        head.insertBefore(tools, head.children[1] ?? null);
      }
    }
  });
  let saved = [];
  try {
    saved = JSON.parse(local.get(layoutSlot(pageId)) ?? "[]");
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved) || !saved.length) return;
  const rank = (el) => {
    const i = saved.indexOf(el.dataset.panelKey);
    return i < 0 ? saved.length + items.indexOf(el) : i;
  };
  root.append(...[...items].sort((a, b) => rank(a) - rank(b)));
}

/**
 * A thin strip on the panel's top edge: hovering it (or tapping it on a touch screen) shows the move / maximise pill,
 * so the pill never sits over the panel's own controls while you work in it.
 */
function panelEdge(panel) {
  let timer = 0;
  const edge = h("div", { class: "panel-edge", "aria-hidden": "true" });
  edge.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    panel.classList.add("tools-shown");
    clearTimeout(timer);
    timer = setTimeout(() => panel.classList.remove("tools-shown"), 4000);
  });
  return edge;
}

function panelTools(panel, root, pageId) {
  const grip = h("button", { type: "button", class: "grip-btn", title: "Drag to move (or use the arrow keys). Double-click to reset this page's layout", "aria-label": "Move panel: arrow up or down" }, icon("grip"));
  const max = h("button", { type: "button", class: "max-btn", title: "Maximise", "aria-label": "Maximise panel", "aria-pressed": "false" }, icon("expand"));
  const moveBy = (d) => {
    const list = movables(root);
    const i = list.indexOf(panel);
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    if (d < 0) root.insertBefore(panel, list[j]);
    else root.insertBefore(panel, list[j].nextSibling);
    saveLayout(root, pageId);
    grip.focus();
  };
  grip.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      moveBy(e.key === "ArrowUp" ? -1 : 1);
    }
  });
  grip.addEventListener("dblclick", () => {
    local.set(layoutSlot(pageId), null);
    toast("Layout reset");
    show();
  });
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    panel.classList.add("dragging");
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev) => {
      if (Math.abs(ev.clientY - startY) > 4) moved = true;
      // Swap with a neighbour once the pointer passes its middle.
      for (const other of movables(root)) {
        if (other === panel) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const before = panel.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING;
        if (before && ev.clientY < mid) root.insertBefore(panel, other);
        else if (!before && ev.clientY > mid) root.insertBefore(panel, other.nextSibling);
      }
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      panel.classList.remove("dragging");
      if (moved) saveLayout(root, pageId);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });
  const setMax = (on) => {
    panel.classList.toggle("panel-max", on);
    document.documentElement.classList.toggle("panel-max-open", on);
    max.setAttribute("aria-pressed", String(on));
    max.title = on ? "Restore (Esc)" : "Maximise";
    max.setAttribute("aria-label", on ? "Restore panel" : "Maximise panel");
    max.replaceChildren(icon(on ? "shrink" : "expand"));
    if (on) {
      const esc = (e) => {
        if (e.key !== "Escape" || document.querySelector("dialog[open]") || !panel.classList.contains("panel-max")) return;
        if (panel.querySelector(".popover")) return;
        document.removeEventListener("keydown", esc);
        setMax(false);
      };
      document.addEventListener("keydown", esc);
    }
  };
  max.addEventListener("click", () => setMax(!panel.classList.contains("panel-max")));
  return h("div", { class: "panel-tools" }, grip, max);
}

// ── Accessibility plumbing (created from here because index.html is static) ──

/** Tell screen readers what just happened (page changes and refreshes). */
function announce(text) {
  const el = $("route-announcer");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => (el.textContent = text), 50);
}

/** Every table gets an accessible name from its card's heading (or the selected tab), however it was drawn. */
function labelTables(root) {
  for (const t of root.querySelectorAll("table:not([aria-label]):not([aria-labelledby])")) {
    if (t.querySelector("caption")) continue;
    const c = t.closest(".card");
    const name = c?.querySelector(".card-head h2, .card-head h3")?.textContent || c?.querySelector('[role="tab"][aria-selected="true"]')?.textContent || $("page-title")?.textContent || "Table";
    t.setAttribute("aria-label", name);
  }
  // Fallback for any icon-only button: use its title as the name.
  for (const b of root.querySelectorAll("button[title]:not([aria-label])")) if (!b.textContent.trim()) b.setAttribute("aria-label", b.title);
}

function setupA11y() {
  if (!$("skip-link")) {
    const skip = h("a", { id: "skip-link", class: "skip-link", href: "#content" }, "Skip to content");
    // Not a hash change: the router owns the hash.
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      $("content").focus();
    });
    document.body.prepend(skip);
  }
  if (!$("route-announcer")) document.body.append(h("div", { id: "route-announcer", class: "pal-sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" }));
  const content = $("content");
  content.setAttribute("aria-labelledby", "page-title");
  // Once a frame at most: live pages change cells many times a second, and running this on each change searched the
  // whole page and read a table's width (a forced layout) on every tick.
  let queued = 0;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      labelTables(content);
      fitTables(content);
    });
  });
  mo.observe(content, { childList: true, subtree: true });
}

/**
 * The compact toolbar title: the page's large title is watched with an IntersectionObserver (no scroll handler). Once it has
 * scrolled up under the toolbar, <html> gets .title-collapsed (app.css 10): the bar frosts and shows the page name. The
 * observer margin is the toolbar's height, read again when the density or the window changes.
 */
function watchTitleCollapse() {
  const title = $("page-title");
  const root = document.documentElement;
  if (!title || typeof IntersectionObserver !== "function") return;
  let io = null;
  let margin = -1;
  const observe = () => {
    const bar = document.querySelector(".toolbar");
    const m = Math.round(bar?.getBoundingClientRect().height || 52);
    if (m === margin) return;
    margin = m;
    io?.disconnect();
    io = new IntersectionObserver(([e]) => root.classList.toggle("title-collapsed", !e.isIntersecting && e.boundingClientRect.top < m), { rootMargin: `-${m}px 0px 0px 0px`, threshold: 0 });
    io.observe(title);
  };
  observe();
  addEventListener("resize", observe, { passive: true });
}

/** The toolbar's search and refresh icons, the budget and readiness slots, and the sidebar's search and account row. */
function setupChrome() {
  const kc = shortcut("K");
  $("toolbar-actions").replaceChildren(
    h("button", { type: "button", class: "icon-btn toolbar-search-m", "aria-label": "Search pages and actions", title: `Search pages and actions (${kc.label})`, "aria-keyshortcuts": kc.aria, onclick: () => openPalette() }, searchIcon()),
    h("button", { type: "button", class: "icon-btn toolbar-refresh", title: "Reload this page's data", "aria-label": "Reload this page's data", onclick: () => show({ refresh: true }) }, icon("refresh")),
  );
  watchTitleCollapse();
  // The API budget indicator (budget.js), fed by the shared live connection.
  const budgetSlot = $("toolbar-budget");
  if (budgetSlot && !budgetSlot.dataset.ready) {
    budgetSlot.dataset.ready = "1";
    mountBudget(budgetSlot, live);
  }
  // Hover or focus a menu item: warm that page's data, so the click paints at once.
  const warmed = new Map();
  const warm = (e) => {
    const id = e.target?.closest?.("a[data-page]")?.dataset.page;
    if (!id || Date.now() - (warmed.get(id) ?? 0) < 3000) return;
    warmed.set(id, Date.now());
    preloadPage(id);
  };
  for (const bar of [$("nav"), $("tabbar")]) {
    if (!bar || bar.dataset.warm) continue;
    bar.dataset.warm = "1";
    bar.addEventListener("pointerover", warm, { passive: true });
    bar.addEventListener("focusin", warm);
  }
  // A page painted from remembered answers is drawn again once, when a fresh answer differs. A person typing or
  // reading a dialog is never interrupted.
  onRevalidated(() => {
    if (redrawnFor === renderSeq) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      if (redrawnFor === renderSeq) return;
      const busy = document.activeElement?.closest?.("input, textarea, select, dialog[open], .popover") || $("dialog")?.open;
      if (busy) return;
      redrawnFor = renderSeq + 1;
      show({ refresh: true });
    }, 120);
  });
  // The sidebar's foot: one account row that opens appearance, shortcuts, About and Forget key.
  const acct = $("sb-account");
  if (acct && !acct.dataset.ready) {
    acct.dataset.ready = "1";
    acct.append(icon("chevron"));
    acct.addEventListener("click", () => accountPopover(acct));
  }
  addEventListener("resize", () => fitTables($("content")));
  // The one demo indicator explains itself.
  const demo = $("toolbar-demo");
  if (demo && !demo.dataset.ready) {
    demo.dataset.ready = "1";
    demo.addEventListener("click", () => sheetPopover({ trigger: demo, title: "Demo data", cls: "demo-pop", body: h("p", {}, DEMO_EXPLAINER) }));
  }
  const sb = $("sb-search");
  if (sb && !sb.dataset.ready) {
    sb.dataset.ready = "1";
    sb.title = `Search pages and actions (${kc.label})`;
    sb.setAttribute("aria-label", "Search pages and actions");
    sb.setAttribute("aria-keyshortcuts", kc.aria);
    sb.prepend(searchIcon());
    sb.append(kbd(...kc.keys));
    sb.addEventListener("click", () => openPalette());
  }
  // The IST clock in the toolbar (wide screens). It claims nothing about the market being open.
  const clock = $("clock");
  const IST_CLOCK = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // Each second only the time's text node changes (new nodes every second restyled the toolbar).
  let clockText = null;
  const tick = () => {
    if (!clock || clock.offsetParent === null) return;
    if (!clockText || clockText.parentNode !== clock) {
      clockText = document.createTextNode("");
      clock.replaceChildren(clockText, h("small", {}, "IST"));
    }
    clockText.data = IST_CLOCK.format(new Date());
  };
  tick();
  setInterval(tick, 1000);
}

/**
 * Go to a page from the palette, a shortcut or a tab: `id` is a page id, `page/tab` or either with a `?query`
 * (`api/integrations?tool=python`). Focus moves into the page (or to `focusSelector`) once it is drawn.
 */
function go(id, focusSelector) {
  pendingFocus = focusSelector ?? true;
  const hash = `#/${id}`;
  if (location.hash === hash) show();
  else location.hash = hash;
}

async function refreshTicketCount() {
  const r = await optional(api("/v1/tickets"));
  const n = r.data?.data?.length ?? 0;
  for (const el of document.querySelectorAll("[data-tickets]")) {
    el.hidden = n === 0;
    el.textContent = formatInt(n);
    el.setAttribute("aria-label", `${n} waiting`);
  }
}

// Motion helper (animatePage), when motion.js provides it. Loaded lazily so Node tests never touch it.
let motionHooks = null;

export async function startRouter() {
  setupA11y();
  setupChrome();
  initPalette({ pages: () => PAGES, go, refresh: () => show({ refresh: true }) });
  try {
    motionHooks = await import("./motion.js");
  } catch {
    motionHooks = null;
  }
  window.addEventListener("hashchange", show);
  show();
}

/** A metric card: tinted icon and label, the figure, a footnote. */
function stat(label, value, sub, glyph, tint) {
  return h("section", { class: "card stat" }, h("div", { class: "stat-head" }, glyph ? iconTile(glyph, tint, "sm") : null, h("span", { class: "label" }, label)), h("span", { class: "value" }, value), h("span", { class: "sub" }, sub));
}

// ── Accounts ──
// The page: "Your accounts" (an inset list: one row per account, a status you can read at a glance, the next step one tap
// away, details in a sheet) and "Supported brokers" (a searchable, filterable catalogue that starts the guided Add flow).

const AUTH_KIND_LABEL = { apiKeyToken: "API key", oauthRedirect: "OAuth login", requestTokenExchange: "One-time code", sessionLogin: "Session login" };
const LOGIN_KINDS = ["apiKeyToken", "oauthRedirect", "requestTokenExchange", "sessionLogin"];
/** The paper simulator as an entry in the "Add a broker" list. */
const PAPER_CHOICE = { id: "paper", name: "Paper account", authKind: null, verified: false, paper: true };
/** The 41 real brokers, by the name people see (the API lists by id, which put "5paisa" between Firstock and Flattrade). */
const realBrokers = (list) => list.filter((b) => b.id !== "demo").sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), undefined, { sensitivity: "base", numeric: true }));
const cliHint = () => app.state.meta?.cliCommand || "npm run bridge --";
export const field = (labelText, input, hint) => h("label", { class: "field", for: input.id }, h("span", {}, labelText), input, hint ? h("span", { class: "hint" }, hint) : null);

/** A failed call as an alert, with the Bridge's per-field messages (field names only, never values) when it sent any. */
export function errorBox(err, labels = {}) {
  const box = alertBox(err);
  // A field message that only repeats the alert's own text is not listed again.
  const errors = (Array.isArray(err?.body?.errors) ? err.body.errors : []).filter((e) => e?.message && e.message !== err?.message && e.message !== err?.body?.detail);
  if (errors.length) {
    const list = h("ul", { class: "field-errors" }, errors.slice(0, 6).map((e) => {
      const key = String(e.path ?? "").split(".").pop();
      return h("li", {}, labels[key] ? `${labels[key]}: ${e.message}` : e.message);
    }));
    box.querySelector("div")?.append(list);
  }
  return box;
}

/** Redraw the page, then put keyboard focus back on an account's row (or the page when the row is gone). */
const redraw = (focusId) => {
  if (focusId) pendingFocus = `[data-acct-open="${CSS.escape(focusId)}"]`;
  return show();
};

/**
 * An account's status in words (state is never colour alone): the pill text and tone, a footnote (what it may do, and
 * until when), and the one next step: "login", "test" or "reset".
 */
function acctStatus(a) {
  if (a.broker === "paper") return { text: "Paper", tone: "ok", foot: "Practice money", next: "reset" };
  const s = a.session?.state;
  const word = s === "connected" ? { text: "Logged in", tone: "ok" } : s === "expired" ? { text: "Session ended", tone: "bad" } : s === "error" ? { text: "Login failed", tone: "bad" } : s === "connecting" ? { text: "Logging in", tone: "warn" } : { text: "Needs login", tone: "warn" };
  const until = a.session?.expiresAt ? ` · until ${istDateTime(a.session.expiresAt)}` : "";
  const mode = a.broker === "demo" ? "Sample prices" : a.liveAllowedByConfig ? "Live orders on" : "Live orders off";
  return { ...word, foot: `${mode}${until}`, next: s === "connected" || app.state.demo ? "test" : "login" };
}

/** Run an account's connection test; a button, when given, shows it is working. */
async function testAccount(a, btn) {
  if (btn) busy(btn, true);
  try {
    const r = await api(`/v1/accounts/${encodeURIComponent(a.id)}/test`, { method: "POST" });
    const ok = r.data?.data?.ok;
    toast(ok ? `${a.label}: connection OK` : `${a.label}: ${r.data?.data?.message ?? "the broker did not answer"}`, { tone: ok ? "ok" : "error" });
  } catch (err) {
    modal({ title: `Test ${a.id}`, body: alertBox(err), buttons: [{ label: "Close", value: true }] });
  } finally {
    if (btn) busy(btn, false);
  }
}

// ── Today's figures (positions, funds and orders; today-core.js) ──

const todayCells = new Map();
const todayFigures = new Map();
/** One figure: the value over a one-line caption. */
const fig = (cls, value, caption) => h("span", { class: `acct-fig ${cls}` }, h("span", { class: "acct-fig-v" }, value), h("small", {}, caption));
const readable = (a) => a.broker === "paper" || a.session?.state === "connected";
/** The row's "today" area: a placeholder that fills itself (fillToday). */
function todayCell(a) {
  const el = h(
    "div",
    { class: "acct-today", "data-acct": a.id },
    readable(a) ? [h("span", { class: "acct-fig acct-pnl" }, h("span", { class: "skeleton skel-line acct-skel" }), h("small", { class: "acct-fig-note" }, "Reading today")), h("span", { class: "acct-fig acct-margin" }, h("span", { class: "skeleton skel-line acct-skel" }))] : h("span", { class: "acct-idle" }, "Log in to see today"),
  );
  todayCells.set(a.id, el);
  return el;
}
async function fillToday(accs) {
  const ones = accs.filter(readable).slice(0, 8);
  const { accountToday } = await import("./today-core.js");
  const orders = await optional(api("/v1/orders?limit=200"));
  await Promise.all(
    ones.map(async (a) => {
      const [p, f] = await Promise.all([optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`))]);
      const el = todayCells.get(a.id);
      if (p.error && f.error) {
        todayFigures.set(a.id, null);
        if (el?.isConnected) el.replaceChildren(h("span", { class: "acct-idle" }, "Not available right now"));
        return;
      }
      const t = accountToday({ accountId: a.id, positions: p.data?.data ?? null, funds: f.data?.data ?? null, orders: orders.data?.data ?? [], nowMs: Date.now() });
      todayFigures.set(a.id, t);
      if (!el?.isConnected) return;
      el.replaceChildren(fig("acct-pnl", pnl(t.pnl, 0), `${formatInt(t.open)} open`), fig("acct-margin", t.margin === null ? DASH : formatRupeeGrouped(t.margin), "Margin used"));
    }),
  );
}

// ── The accounts list ──

/** A broker's tile, or the paper icon, at the size the row wants. */
const accountTile = (a, broker) => (a.broker === "paper" ? iconTile("wallet", "teal") : brokerAvatar({ id: a.broker, name: broker?.name ?? a.label }));

/**
 * One account as a row. The whole row opens its details (a button laid over it); the one next step, as a button, sits
 * on top. On a phone the row has two lines: name and id on the left, status and today's P&L (or Log in) on the right.
 */
function accountRow(a, ctx) {
  const st = acctStatus(a);
  const broker = ctx.brokerOf(a);
  const brokerName = a.broker === "demo" ? "Sample data" : broker?.name ?? a.broker;
  const next =
    st.next === "reset"
      ? { text: "Reset funds", aria: `Reset ${a.label} or add paper money`, cls: "small", run: () => paperResetSheet(a) }
      : st.next === "login"
        ? { text: "Log in", aria: `Log in to ${a.label}`, cls: "small tinted", run: () => loginSheet(a, broker) }
        : { text: "Test", aria: `Test ${a.id}`, cls: "small", run: (btn) => testAccount(a, btn) };
  const act = h("button", { type: "button", class: `acct-act ${next.cls}`, "aria-label": next.aria }, next.text);
  act.addEventListener("click", () => next.run(act));
  return h(
    "div",
    { class: "acct-row", role: "listitem", "data-next": st.next, "data-tone": st.tone, "data-acct-row": a.id },
    h("button", { type: "button", class: "acct-open", "data-acct-open": a.id, "aria-label": `${a.label}, ${st.text}. Open details`, onclick: () => ctx.details(a) }),
    accountTile(a, broker),
    h("div", { class: "acct-names" }, h("span", { class: "acct-nm" }, a.label), h("span", { class: "acct-sub" }, h("span", { class: "mono" }, a.id), a.broker === "paper" ? null : ` · ${brokerName}`)),
    h("div", { class: "acct-status" }, pill(st.text, st.tone), h("span", { class: "acct-foot" }, st.foot)),
    todayCell(a),
    act,
    h("span", { class: "acct-chev", "aria-hidden": "true" }, icon("chevron")),
  );
}

/** An account's details in a sheet: status, today, what it can do, and every action (one tap each). */
async function accountDetails(a, ctx) {
  const st = acctStatus(a);
  const broker = ctx.brokerOf(a);
  const t = todayFigures.get(a.id);
  const kv = (k, v) => [h("dt", {}, k), h("dd", {}, v)];
  const caps = a.capabilities ?? [];
  const canRemove = !app.state.demo && a.broker !== "demo" && (a.broker === "paper" ? ctx.paperCount > 1 : !a.liveAllowedByConfig);
  const connected = a.session?.state === "connected";
  const actions = [
    { id: "test", glyph: "activity", tint: "teal", title: "Test connection", sub: "Checks the Bridge can reach this account now", show: a.broker !== "paper" },
    { id: "login", glyph: "keys", tint: "indigo", title: connected ? "Log in again" : "Log in", sub: connected ? "Replace today's session with a fresh one" : "Type your details to start a session", show: a.broker !== "paper" && a.broker !== "demo" && !app.state.demo },
    { id: "reset", glyph: "refresh", tint: "orange", title: "Reset paper funds", sub: "Start again with the money you choose", show: a.broker === "paper" },
    { id: "remove", glyph: "trash", tint: "red", title: "Remove account", sub: "Takes it out of your config file", show: canRemove, destructive: true },
  ]
    .filter((x) => x.show)
    // The account's next step comes first.
    .sort((x, y) => Number(y.id === st.next) - Number(x.id === st.next));
  const choice = await modal({
    title: a.label,
    body: (close) =>
      h(
        "div",
        { class: "stack acct-sheet" },
        h("div", { class: "acct-sheet-head" }, accountTile(a, broker), h("div", { class: "acct-names" }, h("span", { class: "acct-nm" }, a.label), h("span", { class: "acct-sub" }, h("span", { class: "mono" }, a.id), ` · ${a.broker === "paper" ? "Paper simulator" : broker?.name ?? a.broker}`)), pill(st.text, st.tone)),
        h(
          "dl",
          { class: "kv" },
          kv("Status", st.text),
          kv("Orders", a.broker === "paper" ? "Practice only" : a.liveAllowedByConfig ? "Live orders are on" : "Paper only (live orders off)"),
          a.session?.expiresAt ? kv("Session ends", istDateTime(a.session.expiresAt)) : null,
          t ? [kv("Today's profit and loss", pnl(t.pnl, 0)), kv("Open positions", formatInt(t.open)), kv("Orders today", `${formatInt(t.orders)}${t.orders ? ` (${formatInt(t.filled)} filled)` : ""}`), kv("Margin used", t.margin === null ? DASH : formatRupeeGrouped(t.margin))] : kv("Today", readable(a) ? (t === null ? "Not available right now" : "Still reading") : "Log in to see today"),
        ),
        caps.length ? h("div", { class: "stack acct-caps-box" }, h("div", { class: "group-label" }, `What it can do · ${capabilitySummary(caps)}`), h("div", { class: "chips" }, caps.map((c) => h("span", { class: "chip" }, capabilityLabel(c))))) : null,
        actions.length
          ? h(
              "div",
              { class: "list acct-actions" },
              actions.map((x) =>
                h("button", { type: "button", class: `list-row${x.destructive ? " destructive" : ""}`, onclick: () => close(x.id) }, iconTile(x.glyph, x.tint, "sm"), h("span", { class: "names" }, h("span", { class: "nm" }, x.title), h("span", { class: "sub" }, x.sub)), icon("chevron")),
              ),
            )
          : null,
      ),
    buttons: [{ label: "Done", value: null }],
  });
  if (choice === "test") return testAccount(a, null);
  if (choice === "login") return loginSheet(a, broker);
  if (choice === "reset") return paperResetSheet(a);
  if (choice === "remove") return removeAccountSheet(a);
}

// ── Add a broker (a two-step sheet) ──

/** A paste that carries a stray space or line break (or a code typed "123 456") is cleaned as it lands. */
function pasteFriendly(input, { digits = false } = {}) {
  input.addEventListener("paste", (e) => {
    const raw = e.clipboardData?.getData("text");
    if (typeof raw !== "string") return;
    const clean = digits ? raw.replace(/\s+/g, "") : raw.trim();
    if (clean === raw) return;
    e.preventDefault();
    input.setRangeText(clean, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A search box with its icon and a clear button (app.css 6). */
function searchBox(placeholder, label, onInput) {
  const input = h("input", { type: "search", placeholder, "aria-label": label, autocomplete: "off", spellcheck: "false", enterkeyhint: "search" });
  const clear = h("button", { type: "button", class: "clear", "aria-label": "Clear search" }, icon("close"));
  const box = h("div", { class: "search-field" }, icon("search"), input, clear);
  input.addEventListener("input", onInput);
  clear.addEventListener("click", () => {
    input.value = "";
    onInput();
    input.focus();
  });
  return { box, input };
}

/** One broker as a row of the pick list: a radio (hidden, for the keyboard and screen readers), its tile, name and login type. */
function brokerPickRow(b, checked, onPick) {
  const radio = h("input", { type: "radio", name: "add-broker", value: b.id, checked });
  radio.addEventListener("change", () => onPick(b.id));
  const sub = b.paper ? "Practice with simulated orders, no broker" : `${AUTH_KIND_LABEL[b.authKind] ?? b.authKind} · ${b.verified ? "Verified" : "Beta"}`;
  return h("label", { class: "acct-pick-row" }, radio, b.paper ? iconTile("wallet", "teal") : brokerAvatar(b), h("span", { class: "acct-names" }, h("span", { class: "acct-nm" }, b.name), h("span", { class: "acct-sub" }, sub)), icon("check"));
}

/** A searchable broker list: the search field, the radio list, and redraw/selection plumbing. */
function brokerPicker(brokers, initial, onPick) {
  let chosen = brokers.some((b) => b.id === initial) ? initial : null;
  const realCount = brokers.filter((b) => !b.paper).length;
  const picker = h("div", { class: "acct-pick", role: "radiogroup", "aria-label": "Broker" });
  const draw = () => {
    const q = search.input.value;
    const rows = brokers.filter((b) => brokerMatches(b, q));
    picker.replaceChildren(...rows.map((b) => brokerPickRow(b, b.id === chosen, (id) => ((chosen = id), onPick(id)))));
    if (!rows.length) {
      const clear = h("button", { type: "button", class: "small", onclick: () => ((search.input.value = ""), draw(), search.input.focus()) }, "Clear search");
      picker.replaceChildren(h("div", { class: "acct-pick-empty", role: "status" }, h("p", {}, `No broker matches “${q}”.`), h("p", { class: "muted small" }, "Try its short name, like “kite” or “angel”."), clear));
    }
  };
  const search = searchBox(`Search ${formatInt(realCount)} brokers`, "Search brokers", draw);
  // Enter in the search picks the only match (or the first), so a typed name plus Enter is enough.
  search.input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = picker.querySelector("input[type=radio]");
    if (!first) return;
    e.preventDefault();
    e.stopPropagation();
    first.checked = true;
    first.dispatchEvent(new Event("change"));
    first.focus();
  });
  draw();
  return { search: search.box, input: search.input, picker, chosen: () => chosen, scrollToChosen: () => picker.querySelector("input:checked")?.closest(".acct-pick-row")?.scrollIntoView?.({ block: "nearest" }) };
}

/** A two-segment progress line: where you are, in words. */
function wizardSteps(step, names) {
  return h(
    "ol",
    { class: "acct-progress", "aria-label": `Step ${step} of ${names.length}` },
    names.map((n, i) => h("li", { "aria-current": i + 1 === step ? "step" : undefined, "data-done": i + 1 < step ? "" : undefined }, h("span", { class: "acct-progress-n", "aria-hidden": "true" }, i + 1 < step ? icon("check") : String(i + 1)), h("span", {}, n))),
  );
}

/**
 * "Add a broker": step 1 chooses the broker (a searchable list), step 2 names it (real mode) or shows what connecting it
 * takes (demo mode, where nothing is connected: the choice is saved for the next normal start). A broker chosen on the
 * catalogue starts at step 2. Resolves with the POST /v1/accounts answer, or null when cancelled.
 */
function addBrokerSheet(list, { preselect, accounts = [] } = {}) {
  const demo = app.state.demo;
  const brokers = demo ? realBrokers(list) : [PAPER_CHOICE, ...realBrokers(list).filter((b) => b.available !== false)];
  const nameInput = h("input", { id: "add-label", type: "text", maxlength: "60", autocomplete: "off", placeholder: "A name you will recognise" });
  const idInput = h("input", { id: "add-id", type: "text", maxlength: "32", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: "Picked for you, e.g. zerodha-main" });
  const idBox = h("details", { class: "acct-more" }, h("summary", {}, "Account id (optional)"), field("Account id", idInput, "How scripts and spreadsheets pick this account: 2 to 32 lowercase letters, digits or hyphens."));
  const leave = h("input", { type: "checkbox", checked: true });
  const pickErr = h("div", { "aria-live": "polite" });
  const err = h("div", { "aria-live": "polite" });
  const panel = h("div", { class: "stack" });
  const pick = brokerPicker(brokers, preselect, () => pickErr.replaceChildren());
  let step = pick.chosen() ? 2 : 1;
  let primary = null;
  const chosenBroker = () => brokers.find((b) => b.id === pick.chosen());
  const STEP_NAMES = ["Choose your broker", demo ? "What it takes" : "Name it"];

  const summary = (b) =>
    h(
      "div",
      { class: "acct-chosen" },
      b.paper ? iconTile("wallet", "teal") : brokerAvatar(b),
      h("span", { class: "acct-names" }, h("span", { class: "acct-nm" }, b.name), h("span", { class: "acct-sub" }, b.paper ? "Practice with simulated orders" : `${AUTH_KIND_LABEL[b.authKind] ?? b.authKind} · ${b.verified ? "Verified" : "Beta"}`)),
      h("button", { type: "button", class: "small plain", "aria-label": `Change broker, now ${b.name}`, onclick: () => go1() }, "Change"),
    );
  const need = (b) => {
    if (b.paper) return h("p", { class: "muted small" }, "Nothing to type: a paper account is ready as soon as it is added.");
    const labels = loginFormSpec(b).fields.map((f) => f.label);
    return labels.length ? h("div", { class: "acct-need" }, h("span", { class: "group-label" }, "At the next step you will type"), h("div", { class: "chips" }, labels.map((l) => h("span", { class: "chip" }, l)))) : null;
  };
  const drawStep1 = () => {
    step = 1;
    panel.replaceChildren(
      wizardSteps(1, STEP_NAMES),
      demo ? alertBox({ title: "You are in demo mode", detail: "Demo runs on sample prices, so no broker is connected here. Choose yours to see what connecting it takes, then save it for when you start the Bridge normally." }, "info") : h("p", { class: "muted" }, "Choose your broker. You log in on the next step; nothing is sent to the broker yet."),
      pick.search,
      pick.picker,
      pickErr,
    );
    if (primary) primary.textContent = "Continue";
  };
  const drawStep2 = () => {
    step = 2;
    const b = chosenBroker();
    err.replaceChildren();
    nameInput.placeholder = b.paper ? "Paper account" : `${b.name} (main)`;
    idInput.placeholder = `Picked for you, e.g. ${b.paper ? "paper-2" : `${b.id}-main`}`;
    if (demo) {
      const steps = brokerSetupSteps(b, loginFormSpec(b), { demo: true });
      panel.replaceChildren(
        wizardSteps(2, STEP_NAMES),
        summary(b),
        h("ol", { class: "setup-steps acct-steps" }, steps.map((st) => h("li", {}, h("strong", {}, st.title), h("span", {}, st.text), st.fields?.length ? h("span", { class: "chips" }, st.fields.map((f) => h("span", { class: "chip" }, f))) : null))),
        h("label", { class: "check" }, leave, "Start normally next time (turns demo mode off in the config file)"),
        err,
      );
    } else {
      panel.replaceChildren(wizardSteps(2, STEP_NAMES), summary(b), need(b), field("Name (optional)", nameInput, b.paper ? "Shown in the dashboard." : `Shown in the dashboard. Left empty it is “${b.name} (main)”.`), idBox, h("p", { class: "group-foot acct-foot-note" }, "New accounts are paper only. Live orders are a separate switch in the config file."), err);
    }
    if (primary) primary.textContent = demo ? "Save for normal mode" : "Add and log in";
  };
  const go1 = () => {
    drawStep1();
    pick.scrollToChosen();
    pick.input.focus();
  };
  const go2 = () => {
    drawStep2();
    (demo ? panel.querySelector(".acct-chosen button") : nameInput)?.focus();
  };
  const sheet = modal({
    title: "Add a broker",
    body: panel,
    buttons: [
      { label: "Cancel", value: null },
      {
        label: "Continue",
        cls: "primary",
        ref: (el) => (primary = el),
        onClick: async () => {
          if (step === 1) {
            if (!pick.chosen()) {
              pickErr.replaceChildren(h("p", { class: "field-msg", role: "alert" }, "Choose your broker from the list first."));
              pick.input.focus();
              return false;
            }
            go2();
            return false;
          }
          const b = chosenBroker();
          if (demo) {
            try {
              const r = await api("/v1/accounts", { method: "POST", body: { broker: b.id, leaveDemo: leave.checked } });
              return { ...r.data.data, broker: b };
            } catch (e) {
              err.replaceChildren(errorBox(e, { broker: "Broker" }));
              return false;
            }
          }
          const id = idInput.value.trim();
          if (id && !/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
            idBox.open = true;
            return fieldError(idInput, "Use 2 to 32 lowercase letters, digits or hyphens, for example zerodha-main.");
          }
          if (id && accounts.some((x) => x.id === id)) {
            idBox.open = true;
            return fieldError(idInput, `You already have an account called ${id}. Pick another id, or leave it empty.`);
          }
          const body = { broker: b.id };
          if (nameInput.value.trim()) body.label = nameInput.value.trim();
          if (id) body.id = id;
          try {
            const r = await api("/v1/accounts", { method: "POST", body });
            return r.data.data;
          } catch (e) {
            // A problem with one field goes under that field; anything else above the buttons.
            const paths = (Array.isArray(e?.body?.errors) ? e.body.errors : []).map((x) => String(x.path ?? "").split(".").pop());
            const one = e?.body?.errors?.[0];
            if (paths[0] === "id") {
              idBox.open = true;
              return fieldError(idInput, one.message ? `${cap(one.message)}.` : e.message);
            }
            if (paths[0] === "label") return fieldError(nameInput, one.message ? `${cap(one.message)}.` : e.message);
            err.replaceChildren(errorBox(e, { id: "Account id", label: "Name", broker: "Broker" }));
            return false;
          }
        },
      },
    ],
  });
  // modal() has drawn and focused the first field it found; the step we start on decides where focus really goes.
  if (step === 2) go2();
  else {
    drawStep1();
    pick.input.focus();
  }
  return sheet;
}

/** After a demo-mode save: what happens next, step by step. */
function demoSavedSheet(r) {
  const name = r.broker?.name ?? "your broker";
  return modal({
    title: `${name} is saved`,
    body: h(
      "div",
      { class: "stack" },
      h("p", {}, `It will be ready to log in the next time the Bridge starts normally, as a paper account (${r.savedId}). Demo keeps running until then.`),
      h("ol", { class: "setup-steps acct-steps" }, afterDemoSaveSteps(r, name).map((t) => h("li", {}, h("span", {}, t)))),
      h("p", { class: "muted small" }, `Saved in ${r.configFile}`),
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}

/** Add an account, then go straight on to logging in to it. */
async function addAccountFlow(list, opts) {
  const added = await addBrokerSheet(list, opts);
  if (!added) return;
  if (added.savedForLater) {
    await demoSavedSheet(added);
    return redraw();
  }
  if (added.restartNeeded || !added.account) {
    await modal({
      title: "Saved: one more step",
      body: h(
        "div",
        { class: "stack" },
        alertBox({ title: "Restart the Bridge to use the new account", detail: "This Bridge could not load it while running, so it was saved for the next start." }, "info"),
        h("ol", { class: "setup-steps acct-steps" }, ["Close the Bridge window (or press Ctrl+C in it).", "Start it again from the Start menu, the Desktop or the same command.", "Open Accounts and press Log in next to the new account."].map((t) => h("li", {}, h("span", {}, t)))),
        h("p", { class: "muted small" }, `Saved in ${added.configFile}`),
      ),
      buttons: [{ label: "Done", cls: "primary", value: true }],
    });
    return redraw();
  }
  await redraw(added.account.id);
  if (added.account.broker === "paper") return toast(`Added ${added.account.label}. It is ready for paper orders.`);
  toast(`Added ${added.account.label}. Now log in to it.`);
  await loginSheet(added.account, list.find((b) => b.id === added.account.broker));
}

// ── Log in ──

/** A login field: label, the input (with a show/hide button when it is secret), its hint. */
function loginField(f, input) {
  let control = input;
  const hintId = f.hint ? `${input.id}-hint` : null;
  if (hintId) input.setAttribute("aria-describedby", hintId);
  if (input.type === "password") {
    const eye = h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Show ${f.label}`, "aria-pressed": "false" }, icon("eye"));
    eye.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      eye.setAttribute("aria-pressed", String(reveal));
      eye.replaceChildren(icon(reveal ? "eyeoff" : "eye"));
      input.focus();
    });
    control = h("div", { class: "input-affix" }, input, eye);
  }
  return h("div", { class: "field" }, h("label", { for: input.id }, f.label), control, hintId ? h("span", { class: "hint", id: hintId }, f.hint) : null);
}

/**
 * "Log in" sheet: the broker's fields (saved keys) and one-time login fields (PIN / password, TOTP), sent to
 * POST /v1/accounts/{id}/session. What was typed is cleared from the form as soon as it is sent and is never put in
 * storage or a URL; only the broker's login page address may carry the (public) API key, as the broker designs it.
 */
function loginSheet(a, broker) {
  if (!broker) {
    return modal({ title: `Log in to ${a.label}`, body: alertBox({ title: "Unknown broker", detail: `This Bridge does not know the broker ${a.broker}.` }), buttons: [{ label: "Close", value: null }] });
  }
  const spec = loginFormSpec(broker, { saved: a.session?.state && a.session.state !== "missing" });
  const labels = Object.fromEntries(spec.fields.map((f) => [f.key, f.label]));
  const inputs = new Map();
  const groups = { values: [], secrets: [] };
  for (const f of spec.fields) {
    const input = h("input", {
      id: `login-${f.key}`,
      type: f.type,
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      inputmode: f.inputmode,
      pattern: f.pattern,
      maxlength: f.maxlength,
      required: f.required,
      placeholder: f.group === "values" && spec.keepHint ? "Saved: leave empty to keep" : undefined,
      "data-1p-ignore": "true",
      "data-lpignore": "true",
    });
    pasteFriendly(input, { digits: Boolean(f.pattern) });
    inputs.set(f, input);
    groups[f.group].push(loginField(f, input));
  }
  const result = h("div", { "aria-live": "polite" });
  const typed = () => Object.fromEntries([...inputs].map(([f, i]) => [f.key, i.value]));
  // The broker's own login page (where it declares one), filled in from what was typed (usually the API key).
  let loginLink = null;
  if (broker.loginUrl) {
    const needs = [...broker.loginUrl.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => labels[m[1]] ?? m[1]);
    const note = h("span", { class: "hint" }, `Type your ${needs.join(" and ")} above first.`);
    const open = h("button", { type: "button", class: "small", disabled: true }, icon("external"), `Open ${broker.name} login page`);
    const sync = () => {
      const ok = fillLoginUrl(broker.loginUrl, typed()) !== null;
      open.disabled = !ok;
      note.hidden = ok;
    };
    open.addEventListener("click", () => {
      const url = fillLoginUrl(broker.loginUrl, typed());
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
    for (const i of inputs.values()) i.addEventListener("input", sync);
    loginLink = h("div", { class: "row" }, open, note);
  }
  const section = (title, sub, fields) => h("fieldset", { class: "acct-fieldset" }, h("legend", {}, title), sub ? h("p", { class: "hint" }, sub) : null, h("div", { class: "form-grid" }, fields));
  const form = h(
    "form",
    { class: "stack login-form", autocomplete: "off", novalidate: true },
    groups.values.length ? section(spec.keepHint ? "Saved on this computer" : "Your API details", spec.keepHint ? "Already saved. Leave a field empty to keep what is saved." : "Typed once, then saved encrypted on this computer.", groups.values) : null,
    loginLink,
    groups.secrets.length ? section("To log in now", "Used once to log in. Never saved.", groups.secrets) : null,
  );
  const focusFirst = () => {
    const empty = [...inputs.values()].find((i) => !i.value) ?? inputs.values().next().value;
    empty?.focus();
  };
  let busy = false;
  const submit = async () => {
    if (busy) return false;
    result.replaceChildren();
    // Checked before anything leaves the page, and shown on the field itself: a missing or malformed one-time code or
    // PIN. (Saved fields are not all required: some brokers fill a token in themselves from the day's code.)
    for (const [f, input] of inputs) {
      if (f.group === "secrets" && !input.value.trim()) return fieldError(input, `Type your ${f.label} to log in.`);
      if (f.group === "secrets" && f.pattern && !new RegExp(`^${f.pattern}$`).test(input.value.trim())) return fieldError(input, `${f.label} is ${f.maxlength ?? 6} digits. Copy the current one from your authenticator app.`);
    }
    let body = loginBody(spec, (f) => inputs.get(f).value);
    if (!Object.keys(body.values).length && !body.secrets) {
      const firstInput = inputs.values().next().value;
      return fieldError(firstInput, spec.keepHint ? "Type at least the fields that changed (for most brokers: today's token or code)." : `Type your ${broker.name} details first.`);
    }
    // Off the page at once, whatever happens next.
    for (const i of inputs.values()) i.value = "";
    busy = true;
    loginBtn?.setAttribute("aria-busy", "true");
    result.replaceChildren(h("p", { class: "muted small", role: "status" }, `Logging in to ${broker.name}…`));
    let state;
    try {
      state = (await api(`/v1/accounts/${encodeURIComponent(a.id)}/session`, { method: "POST", body })).data.data;
    } catch (err) {
      result.replaceChildren(errorBox(err, labels));
      focusFirst();
      return false;
    } finally {
      body = null;
      busy = false;
      loginBtn?.removeAttribute("aria-busy");
    }
    if (state?.state === "connected") {
      redraw(a.id).then(() => toast(`${a.label}: logged in${state.expiresAt ? `, until ${istDateTime(state.expiresAt)}` : ""}`));
      return true;
    }
    result.replaceChildren(alertBox({ title: `${broker.name} did not accept this`, detail: `${state?.message ?? "No reason given."} What you typed was cleared when it was sent: type the fields again and check each one. One-time codes change every 30 seconds.` }));
    focusFirst();
    return false;
  };
  let loginBtn = null;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    loginBtn?.click();
  });
  const st = acctStatus(a);
  return modal({
    title: `Log in to ${a.label}`,
    body: h(
      "div",
      { class: "stack" },
      h("div", { class: "acct-chosen" }, brokerAvatar(broker), h("span", { class: "acct-names" }, h("span", { class: "acct-nm" }, broker.name), h("span", { class: "acct-sub" }, `${AUTH_KIND_LABEL[broker.authKind] ?? broker.authKind} · ${broker.verified ? "Verified" : "Beta"}`)), pill(st.text, st.tone)),
      h("ol", { class: "acct-help" }, spec.help.map((t) => h("li", {}, t))),
      spec.fields.length ? form : alertBox({ title: "Nothing to type", detail: "This broker needs no fields." }, "info"),
      result,
      h("details", { class: "acct-more" }, h("summary", {}, "Prefer the terminal?"), h("div", { class: "stack" }, h("p", { class: "muted small" }, "With the Bridge running, this asks for the same fields with hidden input:"), codeBlock(`${cliHint()} accounts connect ${a.id} --key <your admin key>`))),
      h("p", { class: "acct-privacy" }, icon("lock"), h("span", {}, "What you type goes only to the Bridge on this computer, and from there only to your broker.")),
    ),
    buttons: [
      { label: "Cancel", value: null },
      { label: "Log in", cls: "primary", onClick: submit, ref: (el) => (loginBtn = el) },
    ],
  }).finally(() => {
    for (const i of inputs.values()) i.value = "";
  });
}

/** Confirm, then DELETE /v1/accounts/{id}. */
function removeAccountSheet(a) {
  const err = h("div", { "aria-live": "polite" });
  return modal({
    title: `Remove ${a.label}?`,
    body: h(
      "div",
      { class: "stack" },
      h("p", {}, `This takes ${a.id} out of your config file and deletes its saved keys from this computer. You can add it again any time.`),
      a.broker === "paper" ? h("p", { class: "muted small" }, "Its practice orders and positions stay in the data folder.") : null,
      err,
    ),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Remove",
        cls: "destructive",
        onClick: async () => {
          try {
            await api(`/v1/accounts/${encodeURIComponent(a.id)}`, { method: "DELETE" });
            return true;
          } catch (e) {
            err.replaceChildren(errorBox(e));
            return false;
          }
        },
      },
    ],
  }).then((removed) => {
    if (removed) redraw().then(() => toast(`Removed ${a.label}`));
  });
}

/** Reset a paper account, optionally with more (or less) paper money: POST /v1/paper/accounts/{id}/reset. */
async function paperResetSheet(a) {
  const info = (await optional(api(`/v1/paper/accounts/${encodeURIComponent(a.id)}`))).data?.data ?? null;
  const funds = info?.funds ?? null;
  const start = Number(info?.startingCapital) || 1_000_000;
  const CHOICES = [1_000_000, 2_500_000, 5_000_000, 10_000_000];
  const pick = segmented("Starting money", CHOICES.map((v) => [String(v), formatRupeeGrouped(v)]), String(CHOICES.includes(start) ? start : CHOICES[0]));
  const err = h("div", { "aria-live": "polite" });
  const done = await modal({
    title: `Reset ${a.label}?`,
    body: h(
      "div",
      { class: "stack" },
      funds
        ? h("div", { class: "ticket-figs" }, h("div", {}, h("small", {}, "Started with"), formatRupeeGrouped(start)), h("div", {}, h("small", {}, "Margin in use"), formatRupeeGrouped(funds.usedMargin)), h("div", {}, h("small", {}, "Free now"), formatRupeeGrouped(funds.availableCash)))
        : null,
      alertBox({ title: "This clears the account's paper orders and positions", detail: "It starts again with the money you choose below. Only this paper account changes; no real account or money is touched." }, "warn"),
      segField("Starting money", pick, { wide: true }),
      err,
    ),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Reset paper account",
        cls: "primary",
        onClick: async () => {
          try {
            await api(`/v1/paper/accounts/${encodeURIComponent(a.id)}/reset`, { method: "POST", body: { startingCapital: Number(pick.value) } });
            return true;
          } catch (e) {
            err.replaceChildren(errorBox(e));
            return false;
          }
        },
      },
    ],
  });
  // Undo for 2 minutes, while nothing has been placed since: the Bridge keeps the book from before the reset.
  const undo = async () => {
    const r = await optional(api(`/v1/paper/accounts/${encodeURIComponent(a.id)}/reset/undo`, { method: "POST" }));
    if (r.error) return toast(r.error.message ?? "The reset could not be undone.", { tone: "error" });
    redraw(a.id).then(() => toast(`${a.label}: positions, orders and funds put back`));
  };
  if (done) redraw(a.id).then(() => toast(h("span", { class: "toast-undo-row" }, `${a.label} starts again with ${formatRupeeGrouped(Number(pick.value))} · `, h("button", { type: "button", class: "toast-undo", onclick: undo }, "Undo"))));
}

// ── The supported brokers ──

/** One line on what a broker offers: how you log in, then the data and orders it covers. */
function brokerLine(b) {
  const caps = b.capabilities ?? [];
  const feats = [caps.includes("feed") && "live feed", caps.includes("historical") && "history", caps.includes("placeOrder") && "orders"].filter(Boolean);
  return [AUTH_KIND_LABEL[b.authKind] ?? b.authKind, feats.join(", ")].filter(Boolean).join(" · ");
}
const CATALOG_FIRST = 9;

/**
 * The catalogue: search, filters (All / Verified / Beta, and by how you log in), a count, and tiles with an Add action.
 * It shows the first few and "Show all"; any search or filter shows every match.
 */
function brokerCatalog(list, ctx) {
  const real = realBrokers(list).sort((a, b) => Number(b.verified) - Number(a.verified));
  const verified = real.filter((b) => b.verified).length;
  const state = { status: "all", kind: null, all: false };
  const grid = h("div", { class: "acct-cat", role: "list", "aria-label": "Supported brokers" });
  const count = h("p", { class: "acct-count", role: "status", "aria-live": "polite" });
  const more = h("button", { type: "button", class: "tinted acct-more-btn", "aria-expanded": "false" });
  const chips = h("div", { class: "acct-filters" });
  const search = searchBox(`Search ${formatInt(real.length)} brokers`, "Search brokers", () => draw());
  const kindCount = (k) => real.filter((b) => b.authKind === k).length;

  // The chips are built once; picking one only moves aria-pressed, so keyboard focus stays where it is.
  const chipBtn = (text, n, pick) => h("button", { type: "button", class: "chip-btn", "aria-pressed": "false", onclick: pick }, text, h("span", { class: "acct-chip-n" }, formatInt(n)));
  const statusChips = [["all", "All", real.length], ["verified", "Verified", verified], ["beta", "Beta", real.length - verified]].map(([v, t, n]) => [v, chipBtn(t, n, () => ((state.status = v), draw()))]);
  const kindChips = LOGIN_KINDS.filter(kindCount).map((k) => [k, chipBtn(AUTH_KIND_LABEL[k], kindCount(k), () => ((state.kind = state.kind === k ? null : k), draw()))]);
  chips.append(
    h("div", { class: "acct-filter-group", role: "group", "aria-label": "Show" }, statusChips.map(([, b]) => b)),
    h("div", { class: "acct-filter-group", role: "group", "aria-label": "How you log in" }, kindChips.map(([, b]) => b)),
  );
  const syncChips = () => {
    for (const [v, b] of statusChips) b.setAttribute("aria-pressed", String(state.status === v));
    for (const [k, b] of kindChips) b.setAttribute("aria-pressed", String(state.kind === k));
  };
  const activeFilter = () => state.status !== "all" || state.kind !== null || search.input.value.trim() !== "";
  const reset = () => {
    state.status = "all";
    state.kind = null;
    search.input.value = "";
    draw();
    search.input.focus();
  };
  const tile = (b) =>
    h(
      "div",
      { class: "acct-tile", role: "listitem" },
      brokerAvatar(b),
      h("div", { class: "acct-names" }, h("span", { class: "acct-nm" }, b.name, b.verified ? pill("Verified", "ok") : null), h("span", { class: "acct-sub", title: brokerLine(b) }, brokerLine(b))),
      h("button", { type: "button", class: "small tinted", "aria-label": `${app.state.demo ? "Set up" : "Add"} a ${b.name} account`, onclick: () => ctx.add(b.id) }, app.state.demo ? "Set up" : "Add"),
    );
  function draw() {
    const rows = real.filter((b) => brokerMatches(b, search.input.value) && (state.status === "all" || (state.status === "verified") === Boolean(b.verified)) && (!state.kind || b.authKind === state.kind));
    const filtered = activeFilter();
    const shown = filtered || state.all ? rows : rows.slice(0, CATALOG_FIRST);
    syncChips();
    grid.replaceChildren(...shown.map(tile));
    if (!rows.length) {
      grid.replaceChildren(emptyState("search", "No broker matches", search.input.value.trim() ? `Nothing found for “${search.input.value.trim()}”. Try its short name, like “kite” or “angel”.` : "Nothing fits these filters.", h("button", { type: "button", class: "small", onclick: reset }, "Clear search and filters")));
    }
    count.textContent = filtered ? `${formatInt(rows.length)} of ${formatInt(real.length)} brokers` : `${formatInt(real.length)} brokers`;
    const canFold = !filtered && rows.length > CATALOG_FIRST;
    more.hidden = !canFold;
    more.textContent = state.all ? "Show fewer" : `Show all ${formatInt(rows.length)} brokers`;
    more.setAttribute("aria-expanded", String(state.all));
  }
  more.addEventListener("click", () => {
    state.all = !state.all;
    draw();
  });
  draw();
  return h(
    "div",
    { class: "acct-cat-wrap" },
    h("div", { class: "acct-tools" }, search.box, chips),
    count,
    grid,
    h("div", { class: "acct-more-row" }, more),
  );
}

// ── The page ──

/** A section: a title with its actions on the right, and what goes under it. */
function acctSection(id, title, sub, actions, ...body) {
  return h(
    "section",
    { class: "acct-section", "aria-labelledby": id, "data-fixed": "" },
    h("header", { class: "acct-head" }, h("div", { class: "acct-head-titles" }, h("h2", { id }, title), sub ? h("p", {}, sub) : null), actions ? h("div", { class: "acct-head-actions" }, actions) : null),
    ...body,
  );
}

/** A request that failed: what happened, how to fix it, and a button to try again. */
function retryBox(err, what) {
  const box = alertBox(err);
  const text = box.querySelector("div");
  if (!text.querySelector(".detail") && typeof navigator !== "undefined" && navigator.onLine === false) text.append(h("span", { class: "detail" }, "This computer looks offline."));
  text.append(h("div", { class: "alert-actions" }, h("button", { type: "button", class: "small", onclick: () => show({ refresh: true }) }, icon("refresh"), `Try loading ${what} again`)));
  return box;
}

async function renderAccounts() {
  let accounts;
  let brokers;
  try {
    [accounts, brokers] = await Promise.all([api("/v1/accounts"), optional(api("/v1/brokers"))]);
  } catch (err) {
    return acctSection("acct-h-accounts", "Your accounts", null, null, retryBox(err, "your accounts"));
  }
  const accs = accounts.data.data ?? [];
  const list = brokers.data?.data ?? [];
  todayCells.clear();
  todayFigures.clear();
  const brokerOf = (a) => list.find((b) => b.id === a.broker);
  const paperCount = accs.filter((a) => a.broker === "paper").length;
  const demo = app.state.demo;
  const ctx = { brokerOf, paperCount, details: (a) => accountDetails(a, ctx), add: (id) => addAccountFlow(list, { preselect: id, accounts: accs }) };
  const addBtn = (cls = "primary small") => h("button", { type: "button", class: cls, disabled: list.length ? undefined : true, title: list.length ? undefined : "The broker list did not load", onclick: () => addAccountFlow(list, { accounts: accs }) }, icon("plus"), demo ? "Add your broker" : "Add a broker");
  const excel = h("button", { type: "button", class: "small quiet acct-xl", "aria-label": "Download Excel workbook", title: "A .xlsx with your watchlist and open positions as live formulas against this Bridge", onclick: () => import("./workbook.js").then((m) => m.downloadWorkbook()) }, icon("download"), h("span", {}, "Excel workbook"));

  const rows = accs.map((a) => accountRow(a, ctx));
  const needLogin = accs.filter((a) => acctStatus(a).next === "login").length;
  const mine = acctSection(
    "acct-h-accounts",
    "Your accounts",
    null,
    h("div", { class: "row nowrap" }, excel, addBtn()),
    accs.length
      ? h("div", { class: "list acct-list", role: "list", "aria-labelledby": "acct-h-accounts" }, rows)
      : h("div", { class: "card" }, emptyState("accounts", "No accounts yet", "Add your broker to get started: choose it, then log in with its API details. It takes a minute.", addBtn("primary"))),
    accs.length ? h("p", { class: "group-foot" }, `${needLogin ? `${formatInt(needLogin)} ${needLogin === 1 ? "account needs" : "accounts need"} a login. ` : ""}You can add several brokers, and several accounts for one broker. New accounts are paper only.`) : null,
  );

  const catalog = acctSection(
    "acct-h-brokers",
    "Supported brokers",
    `Dhan is verified with a live account. The others are in beta: tested against recorded broker responses.${demo ? " In demo mode, Set up saves a broker for your next normal start." : ""}`,
    null,
    list.length ? brokerCatalog(list, ctx) : h("div", { class: "card" }, h("div", { class: "acct-retry" }, retryBox({ title: "The list of brokers did not load", detail: brokers.error?.message ?? "Try again in a moment." }, "the broker list"))),
  );

  setTimeout(() => fillToday(accs).catch(() => {}), 0);
  return [mine, catalog];
}

// ── Test console ──

const ENDPOINTS = [
  { id: "ltp", label: "Last price (LTP)", method: "GET", path: "/v1/ltp", fields: [["symbols", "NSE:NIFTY,NSE:RELIANCE"]] },
  { id: "quotes", label: "Quotes", method: "GET", path: "/v1/quotes", fields: [["symbols", "NSE:NIFTY,NSE:BANKNIFTY,BSE:SENSEX"]] },
  { id: "depth", label: "Market depth", method: "GET", path: "/v1/depth", fields: [["symbol", "NSE:RELIANCE"]] },
  { id: "history", label: "Candles (history)", method: "GET", path: "/v1/history", fields: [["symbol", "NSE:NIFTY"], ["interval", "15m"], ["countback", "20"]] },
  { id: "expiries", label: "Expiries", method: "GET", path: "/v1/expiries", fields: [["underlying", "NIFTY"]] },
  { id: "optionchain", label: "Option chain", method: "GET", path: "/v1/optionchain", fields: [["underlying", "NIFTY"], ["expiry", ""], ["strikes", "5"], ["greeks", "true"]] },
  { id: "search", label: "Find a symbol", method: "GET", path: "/v1/instruments/search", fields: [["q", "banknifty fut"], ["limit", "5"]] },
  { id: "convert", label: "Convert a symbol", method: "GET", path: "/v1/symbols/convert", fields: [["input", "NSE:NIFTY1!"]] },
  { id: "positions", label: "Positions", method: "GET", path: "/v1/positions", fields: [["account", ""]] },
  { id: "funds", label: "Funds", method: "GET", path: "/v1/funds", fields: [["account", ""]] },
  { id: "order", label: "Place a paper order", method: "POST", path: "/v1/orders", body: { account: "", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" } },
];

async function renderConsole() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? accounts[0]?.id ?? "paper";
  const dataAcc = accounts.find((a) => a.broker !== "paper")?.id ?? paperAcc;
  const select = h("select", { "aria-label": "Endpoint" }, ENDPOINTS.map((e) => h("option", { value: e.id }, e.label)));
  // #/api/console?endpoint=order opens a given endpoint (the Orders page links straight to the order form).
  const wanted = new URLSearchParams(location.hash.split("?")[1] ?? "").get("endpoint");
  if (ENDPOINTS.some((e) => e.id === wanted)) select.value = wanted;
  const fieldsBox = h("div", { class: "stack" });
  const curlBox = h("div");
  const out = h("div", { class: "response" });
  const runBtn = h("button", { type: "button", class: "primary" }, icon("play"), "Send request");
  let inputs = {};
  const firstExpiry = async () => {
    const r = await optional(api("/v1/expiries?underlying=NIFTY"));
    return r.data?.data?.expiries?.[0] ?? "";
  };

  const build = () => {
    const ep = ENDPOINTS.find((e) => e.id === select.value);
    if (ep.method === "POST") {
      const body = { ...ep.body, account: paperAcc };
      return { ep, url: ep.path, body: JSON.parse(inputs.body?.value || JSON.stringify(body)) };
    }
    const qs = new URLSearchParams();
    for (const [k] of ep.fields) if (inputs[k]?.value) qs.set(k, inputs[k].value.trim());
    return { ep, url: `${ep.path}${qs.size ? `?${qs}` : ""}` };
  };
  const drawCurl = () => {
    let b;
    try {
      b = build();
    } catch {
      return;
    }
    const base = location.origin;
    const cmd = b.ep.method === "POST" ? `curl -X POST "${base}${b.url}" -H "Authorization: Bearer $MCB_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $(node -e "console.log(crypto.randomUUID())")" -d '${JSON.stringify(b.body)}'` : `curl -H "Authorization: Bearer $MCB_API_KEY" "${base}${b.url}"`;
    curlBox.replaceChildren(codeBlock(cmd, { title: "Same call from a terminal" }));
  };
  const drawFields = async () => {
    const ep = ENDPOINTS.find((e) => e.id === select.value);
    inputs = {};
    const rows = [];
    if (ep.method === "POST") {
      const ta = h("textarea", { rows: 9, spellcheck: "false" }, JSON.stringify({ ...ep.body, account: paperAcc }, null, 2));
      ta.addEventListener("input", drawCurl);
      inputs.body = ta;
      rows.push(h("label", { class: "field" }, "Order (JSON)", h("span", { class: "hint" }, "Paper by default. The dashboard adds an Idempotency-Key, so a retry never places it twice."), ta));
    } else {
      for (const [k, def] of ep.fields) {
        let value = def;
        if (k === "expiry") value = await firstExpiry();
        if (k === "account") value = ep.id === "funds" || ep.id === "positions" ? paperAcc : dataAcc;
        const input = h("input", { value, spellcheck: "false" });
        input.addEventListener("input", drawCurl);
        inputs[k] = input;
        rows.push(h("label", { class: "field" }, k, input));
      }
    }
    fieldsBox.replaceChildren(...rows);
    drawCurl();
  };

  const run = async () => {
    let b;
    try {
      b = build();
    } catch {
      out.replaceChildren(alertBox({ title: "The order JSON is not valid", detail: "Check the commas and quotes." }));
      return;
    }
    busy(runBtn, true);
    try {
      const idem = b.ep.method === "POST" ? `dash-${crypto.randomUUID()}` : null;
      const opts = { method: b.ep.method, raw: true, body: b.body };
      let r;
      if (idem) {
        const res = await fetch(b.url, { method: "POST", headers: { Authorization: `Bearer ${currentKey()}`, "Content-Type": "application/json", "Idempotency-Key": idem, "X-MCB-Client": "dashboard" }, body: JSON.stringify(b.body) });
        const text = await res.text();
        r = { status: res.status, headers: res.headers, text, ms: 0, data: (() => { try { return JSON.parse(text); } catch { return text; } })() };
      } else r = await api(b.url, opts);
      const pretty = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
      const pre = h("pre");
      pre.innerHTML = highlightJson(pretty);
      const hdr = (n) => r.headers.get(n);
      const ok = r.status < 400;
      const friendly = !ok && typeof r.data === "object" ? alertBox({ code: r.data.code, status: r.status, message: r.data.detail }) : null;
      out.replaceChildren(
        card({
          glyph: "inbox",
          tint: ok ? "green" : "red",
          title: "Response",
          actions: h("div", { class: "row" }, pill(`${r.status} ${ok ? "OK" : "Error"}`, ok ? "ok" : "bad"), r.ms ? pill(`${formatInt(r.ms)} ms`) : null, hdr("x-mcb-data") === "demo" ? pill("Sample prices", "demo") : null),
          flush: true,
          body: h(
            "div",
            {},
            friendly ? h("div", { class: "card-body" }, friendly) : null,
            h("dl", { class: "kv" }, ...["x-request-id", "ratelimit", "ratelimit-policy", "x-mcb-data", "content-type"].flatMap((n) => (hdr(n) ? [h("dt", {}, n), h("dd", {}, hdr(n))] : []))),
            h("div", { class: "code" }, h("div", { class: "code-head" }, h("span", { class: "code-title" }, "Body"), copyButton(() => pretty, { ariaLabel: "Copy the response body" })), pre),
          ),
        }),
      );
    } catch (err) {
      out.replaceChildren(alertBox(err));
    } finally {
      busy(runBtn, false);
    }
  };

  select.addEventListener("change", drawFields);
  runBtn.addEventListener("click", run);
  await drawFields();
  out.replaceChildren(card({ glyph: "inbox", tint: "gray", title: "Response", body: emptyState("console", "Send a request to see the answer", "The response shows the status, the rate-limit headers and the JSON exactly as your scripts would get it.") }));
  return h(
    "div",
    { class: "console" },
    h(
      "div",
      { class: "stack" },
      card({
        glyph: "console",
        tint: "teal",
        title: "Request",
        sub: "Uses your dashboard key. Scripts should use their own key.",
        body: h("div", { class: "stack" }, h("label", { class: "field" }, "Endpoint", select), fieldsBox, h("div", { class: "row" }, runBtn)),
      }),
      curlBox,
    ),
    out,
  );
}

// ── Rate limits ──

async function renderLimits() {
  const root = h("div", { class: "stack" });
  /** accountId -> the endpoint class its chart shows (the busiest, until a person picks another) */
  const chartClass = new Map();
  let limitsData = null;
  const draw = async () => {
    // The policy table changes only with the config: read it once. Usage (with the per-second history) every 1.5 s.
    const [usage, limits] = await Promise.all([api("/v1/usage?series=1"), limitsData ? Promise.resolve(limitsData) : api("/v1/limits")]);
    limitsData = limits;
    const u = usage.data.data ?? {};
    const lim = limits.data.data ?? {};
    const sv = u.savings ?? {};
    const nodes = [
      h(
        "div",
        { class: "grid cols-4 stats" },
        stat("Served from live stream", formatInt(sv.servedFromStream), "No broker call at all", "activity", "teal"),
        stat("Served from cache", formatInt(sv.servedFromCache), "Fresh enough, labelled with its age", "clock", "indigo"),
        stat("Coalesced", formatInt(sv.coalesced), "Identical requests shared one call", "integrations", "purple"),
        stat("Batched", formatInt(sv.batched), "Symbols packed into fewer calls", "list", "blue"),
      ),
    ];
    const accounts = (u.accounts ?? []).filter((a) => a.broker !== "paper");
    const tryBtn = h("button", { type: "button", class: "primary" }, icon("bolt"), "Send 20 identical requests");
    tryBtn.addEventListener("click", async () => {
      busy(tryBtn, true);
      const before = (await api("/v1/usage")).data.data;
      const calls = (x) => (x.accounts ?? []).reduce((n, a) => n + sum(Object.fromEntries(Object.entries(a.classes ?? {}).map(([k, v]) => [k, v.callsToday ?? 0]))), 0);
      await Promise.all(Array.from({ length: 20 }, () => optional(api("/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE"))));
      const after = (await api("/v1/usage")).data.data;
      busy(tryBtn, false);
      const used = calls(after) - calls(before);
      toast(`20 requests → ${formatInt(used)} broker call${used === 1 ? "" : "s"}. The rest came from the live stream, the cache or a shared call.`);
      await draw();
    });
    nodes.push(
      card({
        glyph: "bolt",
        tint: "purple",
        title: "Try it",
        sub: "Twenty tools asking for the same price at once should cost the broker about one call. Watch the counters.",
        body: h("div", { class: "row" }, tryBtn, h("span", { class: "muted small" }, accounts.length ? "Uses /v1/ltp for NIFTY and RELIANCE." : "Needs a connected broker or demo mode.")),
      }),
    );
    if (!accounts.length) nodes.push(card({ glyph: "limits", tint: "purple", title: "Broker budgets", body: emptyState("limits", "No broker account in use yet", "Once a broker account is connected, its live budget per endpoint class shows here.", nextStep("Go to Accounts", "#/accounts")) }));
    // Live: calls per second over two minutes against the per-second limit, one chart per account.
    for (const a of accounts) {
      const classes = Object.keys(a.classes ?? {}).filter((c) => (a.classes[c].callsToday ?? 0) > 0 || a.series?.classes?.[c]);
      const cls = chartClass.get(a.accountId) ?? busiestClass(a);
      const c = a.classes?.[cls] ?? {};
      const counts = a.series?.classes?.[cls] ?? new Array(a.series?.seconds ?? 120).fill(0);
      const limit = perSecondLimit(c);
      const sec = (c.windows ?? []).find((w) => w.window === "1s");
      const min = (c.windows ?? []).find((w) => w.window === "1m");
      const pick = classes.length > 1
        ? h(
            "div",
            { class: "segmented", role: "group", "aria-label": "Endpoint class" },
            classes.map((k) => h("button", { type: "button", "aria-pressed": String(k === cls), onclick: () => (chartClass.set(a.accountId, k), draw()) }, k)),
          )
        : null;
      nodes.push(
        card({
          glyph: "activity",
          tint: "blue",
          title: `Live usage · ${a.accountId}`,
          sub: `${cls}: ${sec ? `${windowText(sec)} this second` : "no per-second limit"}${min ? ` · ${windowText(min)} this minute` : ""}`,
          actions: pick,
          body: h(
            "div",
            { class: "stack" },
            usageChart(counts, limit, `${cls} calls per second over the last two minutes${limit ? `, limit ${formatInt(limit)} a second` : ""}`),
            h("div", { class: "rl-axis" }, h("span", {}, "2 min ago"), h("span", {}, "now")),
            h("div", { class: "rl-legend" }, h("span", {}, h("i", { class: "sw" }), "Calls per second"), limit ? h("span", {}, h("i", { class: "sw limit" }), `Limit ${formatInt(limit)} a second`) : null),
          ),
        }),
      );
    }
    // Who used the budget today (admin keys only: it names API keys).
    if (Array.isArray(u.consumers) && u.consumers.length) {
      const top = Math.max(1, ...u.consumers.map((x) => x.calls));
      nodes.push(
        card({
          glyph: "people",
          tint: "teal",
          title: "Top consumers today",
          sub: "Broker calls each page, key or job caused, and the calls it got from the stream, the cache or a shared call instead",
          flush: true,
          body: table(
            [
              { label: "Consumer", cell: (r) => h("strong", {}, r.name) },
              { label: "Broker calls", num: true, cell: (r) => formatInt(r.calls) },
              {
                label: "Share",
                cell: (r) => {
                  const bar = h("span", { class: "rl-cons-bar", "aria-hidden": "true" });
                  bar.style.setProperty("--w", `${Math.round((r.calls / top) * 100)}%`);
                  return bar;
                },
              },
              { label: "Saved", num: true, cell: (r) => formatInt(r.saved) },
            ],
            u.consumers,
            emptyState("limits", "No broker calls yet today", ""),
          ),
        }),
      );
    }
    for (const a of accounts) {
      const classes = Object.entries(a.classes ?? {});
      nodes.push(
        card({
          glyph: "limits",
          tint: "purple",
          title: `${a.accountId} · ${a.broker}`,
          sub: `${a.healthy === false ? "Backing off" : "Healthy"} · ${formatInt(a.inFlight ?? 0)} in flight · ${formatInt(a.queued ?? 0)} queued`,
          actions: h("div", { class: "row" }, a.healthy === false ? pill("Backing off", "bad") : pill("Healthy", "ok")),
          body: h(
            "div",
            {},
            classes.map(([cls, c]) => meterRow(cls, c.used ?? 0, c.limit ?? 0, `${formatInt(c.used ?? 0)} / ${isFigure(c.limit) ? formatInt(c.limit) : "∞"} per ${c.window ?? "s"} · ${formatInt(c.callsToday)} today`)),
            h("p", { class: "muted small" }, `Today: ${formatInt(sum(Object.fromEntries(classes.map(([k, c]) => [k, c.callsToday ?? 0]))))} broker calls, ${formatInt(sum(Object.fromEntries(classes.map(([k, c]) => [k, c.throttledToday ?? 0]))))} throttled by the broker, ${formatInt(sum(Object.fromEntries(classes.map(([k, c]) => [k, c.refusedToday ?? 0]))))} refused to stay inside limits.`),
          ),
        }),
      );
    }
    const policies = Object.values(lim.brokers ?? {});
    for (const p of policies) {
      nodes.push(
        card({
          glyph: "list",
          tint: "gray",
          title: `Policy: ${p.brokerId}`,
          sub: p.notes ?? "",
          flush: true,
          body: table(
            [
              { label: "Endpoint class", cell: (r) => h("strong", {}, r[0]) },
              { label: "Per second", num: true, cell: (r) => formatFixed(r[1].perSecond, Object.values(p.limits ?? {}).some((x) => isFigure(x.perSecond) && !Number.isInteger(Number(x.perSecond))) ? 1 : 0) },
              { label: "Per minute", num: true, cell: (r) => formatInt(r[1].perMinute) },
              { label: "Per day", num: true, cell: (r) => formatInt(r[1].perDay) },
              { label: "Source", wrap: true, cell: (r) => (String(r[1].source ?? "").includes("demo") ? pill("Sample (demo)", "demo") : r[1].verified ? pill("Broker docs", "ok") : pill("Conservative default", "warn")) },
            ],
            Object.entries(p.limits ?? {}),
            emptyState("limits", "No limits", ""),
          ),
        }),
      );
    }
    keepFocus(root, () => root.replaceChildren(...nodes));
  };
  await draw();
  every(1500, draw);
  return root;
}

// ── Orders ──

async function renderOrders() {
  const [tickets, orders, accounts] = await Promise.all([optional(api("/v1/tickets")), optional(api("/v1/orders?limit=100")), api("/v1/accounts")]);
  const accs = accounts.data.data ?? [];
  const byId = new Map(accs.map((a) => [a.id, a]));
  const nodes = [];

  const tk = tickets.data?.data ?? [];
  // Nothing waiting: the card is its head line only (it was a 300 px empty state above the day's orders).
  if (!tickets.error && !tk.length)
    nodes.push(
      card({
        glyph: "inbox",
        tint: "orange",
        title: "Pending confirmations",
        sub: "Nothing waiting. When an AI assistant or a confirmation-required webhook prepares an order, it waits here until you check every field and confirm.",
        cls: "orders-pending none",
        actions: nextStep("Set up an AI assistant", "#/api/integrations?tool=claude", "small"),
        flush: true,
        body: null,
      }),
    );
  else nodes.push(
    card({
      glyph: "inbox",
      tint: "orange",
      title: "Pending confirmations",
      sub: "Orders prepared by AI assistants or confirmation-required webhooks wait here. Nothing is sent until you confirm.",
      flush: true,
      body: tickets.error
        ? h("div", { class: "card-body" }, alertBox(tickets.error))
        : table(
            [
              { label: "Ticket", cell: (t) => h("span", { class: "mono" }, t.ticketId) },
              { label: "From", cell: (t) => `${t.source} · ${t.client}` },
              { label: "Order", wrap: true, cell: (t) => `${t.order?.side} ${t.order?.lots ? `${t.order.lots} lot(s)` : t.order?.quantity} ${t.order?.symbol} (${t.order?.mode ?? "paper"})` },
              { label: "Value", num: true, cell: (t) => formatRupee(t.estimatedValue) },
              {
                label: "",
                cell: (t) => {
                  const blocked = (t.checks ?? []).some((c) => c?.severity === "block");
                  return h("button", { type: "button", class: "small primary", disabled: blocked, "aria-label": `${blocked ? "Blocked" : "Review"} ticket ${t.ticketId}`, onclick: () => confirmTicket(t, byId) }, blocked ? "Blocked" : "Review");
                },
              },
            ],
            tk,
            emptyState("inbox", "Nothing waiting", "When an AI assistant prepares an order, it appears here for you to check every field and confirm.", nextStep("Set up an AI assistant", "#/api/integrations?tool=claude")),
          ),
    }),
  );

  const ord = orders.data?.data ?? [];
  // The day's orders with status and side filters, a search and Cancel all (orders-book.js).
  nodes.push(
    ordersCard({
      ord,
      error: orders.error ?? null,
      byId,
      refresh: () => show(),
      // Orders come in through the API; the test console sends one as JSON (API › Test console).
      actions: [h("button", { type: "button", class: "small primary", onclick: () => (location.hash = "#/api/console?endpoint=order") }, "Send a paper order")],
      columns: [
              { label: "Time", cell: (o) => istTime(o.placedAt) },
              { label: "Account", cell: (o) => byId.get(o.accountId)?.label ?? o.accountId },
              { label: "Contract", wrap: true, cell: (o) => h("div", { title: o.symbol, class: "order-contract" }, h("strong", {}, contractName(o.symbol)), h("div", { class: "muted small" }, `${o.orderType ?? ""}${isFigure(o.price) ? ` @ ${formatFixed(o.price, 2)}` : ""} · ${o.product ?? ""}`)) },
              { label: "Side", cell: (o) => h("span", { class: "order-side" }, o.side) },
              { label: "Qty", num: true, cell: (o) => (o.filledQuantity && o.filledQuantity !== o.quantity ? `${formatInt(o.filledQuantity)}/${formatInt(o.quantity)}` : formatInt(o.quantity)) },
              { label: "Avg price", num: true, cell: (o) => formatFixed(o.avgPrice, 2) },
              {
                label: "Status",
                wrap: true,
                cell: (o) => {
                  const t = orderStatusText(o.status);
                  // Why it was refused or cancelled, right under the pill (the broker's or the paper engine's words).
                  // ...and the next step, in plain words, when there is one (reasons-core.js).
                  const why = o.statusMessage && ["rejected", "expired", "outcome_unknown"].includes(o.status) ? o.statusMessage : null;
                  const fix = why || o.status === "outcome_unknown" ? whatToDo({ code: o.status === "outcome_unknown" ? "OUTCOME_UNKNOWN" : null, message: why ?? "", mode: o.mode }) : null;
                  return h("div", { class: "order-status" }, pill(t.text, t.tone), why ? h("div", { class: "muted small order-why" }, why) : null, fix ? h("div", { class: "small bk-fix" }, fix) : null);
                },
              },
              { label: "Mode", cell: (o) => (o.mode === "live" ? pill("Live", "bad") : pill("Paper")) },
              { label: "", cell: (o) => (WORKING_ORDER.has(o.status) ? orderActions(o) : "") },
      ],
      empty: emptyState("orders", "No orders today", "Paper orders from your scripts, webhooks and AI assistants show up here.", nextStep("Send a paper order", "#/api/console?endpoint=order")),
    }),
  );

  // The Funds card in whole rupees with Indian grouping (the P&L columns too, with an explicit + for gains), like the
  // other money summaries.
  const pnlGrouped = (v) => {
    if (!isFigure(v)) return DASH;
    const text = formatRupeeGrouped(v, 0);
    const zero = text === "₹0";
    const n = Number(v);
    return h("span", { class: zero ? undefined : n > 0 ? "up" : "down" }, n > 0 && !zero ? `+${text}` : text);
  };
  // Funds for every account (orders-book.js): available, margin used, collateral, utilisation and P&L.
  const funds = await fundsCard(accs, pnlGrouped);
  if (funds) nodes.push(funds);
  return nodes;
}

/** Modify and Cancel for a working order (PATCH / DELETE /v1/orders/{id}); each answers with a toast and a redraw. */
function orderActions(o) {
  const name = contractName(o.symbol);
  const modify = async () => {
    // Asked in lots, as on the ticket (the quantity in units under it). The lot size is the instrument's; without one
    // (an equity, or the master not loaded) a lot is one unit and the field says "Quantity".
    const inst = await optional(api(`/v1/instruments/${encodeURIComponent(o.symbol)}`));
    const lotSize = Number(inst.data?.data?.lotSize) > 0 ? Number(inst.data.data.lotSize) : 1;
    const inLots = lotSize > 1;
    const lotsNow = (o.quantity ?? 0) / lotSize;
    const qty = h("input", { id: "mod-qty", type: "number", min: "1", step: "1", inputmode: "numeric", value: Number.isInteger(lotsNow) ? String(lotsNow) : String(o.quantity ?? "") });
    const price = h("input", { id: "mod-price", type: "number", min: "0.05", step: "0.05", inputmode: "decimal", value: isFigure(o.price) ? String(o.price) : "" });
    const units = h("span", { class: "hint", "aria-live": "polite" });
    const filled = o.filledQuantity ?? 0;
    const filledText = filled > 0 ? `${inLots ? `${formatInt(Math.floor(filled / lotSize))} lots` : formatInt(filled)} filled` : "none filled yet";
    const showUnits = () => {
      const c = modifyChange({ lots: qty.value, lotSize, order: o, price: price.value, limit: false });
      units.textContent = inLots ? `${c.quantity === null ? DASH : formatInt(c.quantity)} qty · lot ${formatInt(lotSize)} · ${filledText}` : `Filled so far: ${formatInt(filled)}`;
    };
    qty.addEventListener("input", showUnits);
    showUnits();
    // A refusal from the Bridge, said once: under its field when it names one, else on one line above the buttons.
    const err = h("p", { class: "bad-text", role: "alert", hidden: true });
    const limit = o.orderType === "LIMIT" || o.orderType === "SL";
    // A stop-loss order (SL, SL-M) changes its trigger here too.
    const stop = o.orderType === "SL" || o.orderType === "SL-M";
    const trig = h("input", { id: "mod-trigger", type: "number", min: "0.05", step: "0.05", inputmode: "decimal", value: isFigure(o.triggerPrice) ? String(o.triggerPrice) : "" });
    const ok = await modal({
      title: `Modify ${o.side === "BUY" ? "buy" : "sell"} ${name}`,
      // Lots on its own row with its hint; the trigger and the limit side by side (a pair), or one full width.
      body: h(
        "div",
        { class: "stack" },
        h("label", { class: "field", for: "mod-qty" }, h("span", {}, inLots ? "Lots" : "Quantity"), qty, units),
        stop || limit ? h("div", { class: "form-grid bk-pair" }, stop ? field("Trigger price", trig) : null, limit ? field("Limit price", price) : null) : null,
        err,
      ),
      buttons: [
        { label: "Keep as is", value: false },
        {
          label: "Save change",
          cls: "primary",
          onClick: async () => {
            err.hidden = true;
            const c = modifyChange({ lots: qty.value, lotSize, order: o, price: price.value, limit, trigger: trig.value, stop });
            if (c.error) return fieldError(c.error.field === "price" ? price : c.error.field === "trigger" ? trig : qty, c.error.message);
            try {
              await api(`/v1/orders/${encodeURIComponent(o.orderId)}`, { method: "PATCH", body: c.body });
              return true;
            } catch (e) {
              const f = (Array.isArray(e?.body?.errors) ? e.body.errors : []).find((x) => /^(quantity|lots|price|triggerPrice)$/.test(String(x.path ?? "").split(".").pop()));
              const msg = String(f?.message ?? e?.message ?? "Not changed").replace(/(\d),(?=\d)/g, "$1");
              if (f) return fieldError(String(f.path).endsWith("triggerPrice") ? trig : String(f.path).endsWith("price") ? price : qty, msg);
              err.textContent = `Not changed: ${msg}`;
              err.hidden = false;
              return false;
            }
          },
        },
      ],
    });
    if (ok) show().then(() => toast(`Modified ${name}`));
  };
  const cancel = async () => {
    const err = h("div", { "aria-live": "polite" });
    const ok = await modal({
      title: `Cancel ${o.side === "BUY" ? "buy" : "sell"} ${name}?`,
      body: h("div", { class: "stack" }, h("p", {}, `The unfilled part (${formatInt((o.quantity ?? 0) - (o.filledQuantity ?? 0))} qty) is withdrawn. What already filled stays in Positions.`), err),
      buttons: [
        { label: "Keep it", value: false },
        {
          label: "Cancel order",
          cls: "primary",
          onClick: async () => {
            try {
              await api(`/v1/orders/${encodeURIComponent(o.orderId)}`, { method: "DELETE" });
              return true;
            } catch (e) {
              err.replaceChildren(errorBox(e));
              return false;
            }
          },
        },
      ],
    });
    if (!ok) return;
    // Undo (paper only): place the unfilled part again, as it was. The order goes through every normal check, so a
    // price that is no longer valid is refused and said so. Live orders are never re-sent from a toast.
    const left = (o.quantity ?? 0) - (o.filledQuantity ?? 0);
    const again = async () => {
      const body = { account: o.accountId, symbol: o.symbol, side: o.side, quantity: left, product: o.product, orderType: o.orderType, validity: o.validity ?? "DAY", mode: "paper", ...(o.price ? { price: o.price } : {}), ...(o.triggerPrice ? { triggerPrice: o.triggerPrice } : {}), ...(o.tag ? { tag: o.tag } : {}) };
      const r = await optional(api("/v1/orders", { method: "POST", body }));
      if (r.error) return toast(`Could not place ${name} again: ${r.error.message ?? "refused"}`, { tone: "error" });
      const placed = r.data?.data ?? {};
      show().then(() => toast(placed.status === "rejected" ? `Placed again but rejected: ${placed.statusMessage ?? "no reason given"}` : `${name} placed again`, { tone: placed.status === "rejected" ? "warn" : "ok" }));
    };
    const canUndo = o.mode === "paper" && left > 0;
    show().then(() => toast(canUndo ? h("span", { class: "toast-undo-row" }, `Cancelled ${name} · `, h("button", { type: "button", class: "toast-undo", onclick: again }, "Undo")) : `Cancelled ${name}`));
  };
  return h("div", { class: "row order-acts" }, h("button", { type: "button", class: "small", "aria-label": `Modify ${name}`, onclick: modify }, "Modify"), h("button", { type: "button", class: "small", "aria-label": `Cancel ${name}`, onclick: cancel }, "Cancel"));
}

async function confirmTicket(t, byId) {
  const fields = ticketFields(t, byId);
  const ok = await modal({
    title: `Confirm ticket ${t.ticketId}?`,
    body: h("div", { class: "stack" }, h("p", { class: "muted" }, "The client that prepared it can then send exactly this order, once."), h("dl", { class: "kv" }, ...fields.flatMap(([k, v, cls]) => [h("dt", {}, k), h("dd", { class: cls ? `${cls}-text` : undefined }, v)]))),
    buttons: [{ label: "Cancel", value: false }, { label: t.order?.mode === "live" ? "Confirm LIVE order" : "Confirm", cls: "primary", value: true }],
  });
  if (!ok) return;
  try {
    const r = await api(`/v1/tickets/${encodeURIComponent(t.ticketId)}/confirm`, { method: "POST" });
    const n = confirmCodeNotice(t.ticketId, r.data);
    if (n) await modal({ title: "Confirmed", body: h("div", { class: "stack" }, h("p", {}, n.text), h("div", { class: "secret-box" }, h("code", {}, n.token), copyButton(n.token, { cls: "small" }))), buttons: [{ label: "Done", cls: "primary", value: true }] });
  } catch (err) {
    await modal({ title: "Could not confirm", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
  }
  show();
}

// ── Safety ──

async function renderSafety() {
  const [safety, accounts] = await Promise.all([api("/v1/safety"), optional(api("/v1/accounts"))]);
  const s = safety.data.data;
  // Accounts by their names, as everywhere else; the id stays in the tooltip for API users.
  const names = new Map((accounts.data?.data ?? []).map((a) => [a.id, a.label]));
  const ks = s.killSwitch ?? {};
  const engage = async () => {
    if (await confirmEngageKillSwitch()) refreshReadiness();
    show();
  };
  const release = async () => {
    const typed = h("input", { placeholder: "RELEASE", autocomplete: "off", spellcheck: "false" });
    const go = await modal({
      title: "Allow orders again?",
      body: h("div", { class: "stack" }, h("p", {}, "Needs an admin key, from this computer."), h("label", { class: "field" }, "Type RELEASE to confirm", typed)),
      buttons: [{ label: "Cancel", value: false }, { label: "Release", cls: "primary", onClick: () => (typed.value === "RELEASE" ? true : (toast("Type RELEASE exactly, in capitals", { tone: "warn" }), false)) }],
    });
    if (!go) return;
    try {
      await api("/v1/safety/kill-switch", { method: "DELETE", body: { confirm: "RELEASE" } });
      toast("Kill switch released");
      refreshReadiness();
    } catch (err) {
      await modal({ title: "Could not release", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    }
    show();
  };
  const verify = async (btn) => {
    busy(btn, true);
    try {
      const r = await api("/v1/audit/verify");
      const d = r.data.data ?? {};
      toast(d.ok ? `Audit chain intact (${formatInt(d.checked)} records)` : `Audit chain broken at ${d.brokenAt}`, { tone: d.ok ? "ok" : "error" });
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      busy(btn, false);
    }
  };
  const verifyBtn = h("button", { type: "button", class: "small" }, "Verify audit log");
  verifyBtn.addEventListener("click", () => verify(verifyBtn));

  const killCard = h(
    "section",
    { class: `card kill${ks.engaged ? " engaged" : ""}` },
    iconTile(ks.engaged ? "stop" : "power", ks.engaged ? "red" : "green", "lg"),
    h("div", { class: "stack" }, h("h2", {}, ks.engaged ? "Kill switch is on: no orders are sent" : "Kill switch is off"), h("p", { class: "muted" }, ks.engaged ? `Engaged ${istDateTime(ks.at)} by ${ks.by ?? "?"}: ${ks.reason ?? ""}` : ["One click stops every new order from every tool: REST, webhooks, AI assistants and the CLI. Also: ", h("span", { class: "cli-cmd" }, "mc-bridge kill"), "."])),
    h("div", { class: "actions" }, ks.engaged ? h("button", { type: "button", id: "kill-action", class: "primary", onclick: release }, "Release (admin)") : h("button", { type: "button", id: "kill-action", class: "primary", onclick: engage }, icon("stop"), "Stop all orders")),
  );
  const live = card({
    glyph: "bolt",
    tint: s.liveTrading ? "red" : "gray",
    title: "Live trading",
    actions: s.liveTrading ? pill("On", "bad") : pill("Off: paper only"),
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, "A live order needs every one of these. Nothing in the API, a webhook or an AI tool can switch live trading on."),
      h(
        "div",
        { class: "stack small" },
        [
          ["safety.liveTrading is true in bridge.config.json", s.liveTrading],
          ["the account has live.enabled and allows the request's source", (s.accounts ?? []).some((a) => a.liveAllowedByConfig)],
          ["the key has the live scope and the request says mode: live", null],
          ["a person confirmed it, for AI-prepared orders and confirmation webhooks", null],
          ["every safety check passes (rate cap, daily limits, price band)", null],
        ].map(([t, v]) => h("div", { class: "req" }, v === true ? pill("Yes", "ok") : v === false ? pill("No") : pill("Per order"), h("span", {}, t))),
      ),
      app.state.demo ? h("p", { class: "small warn-text" }, "Demo mode forces live trading off.") : null,
    ),
  });
  const limits = card({
    glyph: "limits",
    tint: "orange",
    title: "Daily limits per account",
    sub: `IST day ${s.day ?? ""}. Paper and live are counted separately.`,
    flush: true,
    body: table(
      [
        { label: "Account", cell: (a) => h("strong", { title: `Account id ${a.accountId}` }, names.get(a.accountId) || a.accountId) },
        { label: "Orders today", num: true, cell: (a) => `${formatInt((a.ordersToday ?? 0) + (a.paperOrdersToday ?? 0))} / ${formatInt(a.limits?.dailyMaxOrders)}` },
        { label: "P&L today", num: true, cell: (a) => pnl(isFigure(a.realisedPnlToday) || isFigure(a.paperRealisedPnlToday) ? (a.realisedPnlToday ?? 0) + (a.paperRealisedPnlToday ?? 0) : null, 0) },
        // Limits are whole rupees: no paise.
        { label: "Max loss", num: true, cell: (a) => formatRupeeGrouped(a.limits?.dailyMaxLoss, 0) },
        { label: "Max order value", num: true, cell: (a) => formatRupeeGrouped(a.limits?.maxOrderValue, 0) },
        { label: "Max lots", num: true, cell: (a) => formatInt(a.limits?.maxLotsPerOrder) },
        { label: "Orders / s", num: true, cell: (a) => formatInt(a.limits?.orderRatePerSecond) },
        { label: "Market orders", cell: (a) => cap(a.limits?.marketOrders ?? "protect") },
      ],
      s.accounts ?? [],
      emptyState("safety", "No accounts", "Daily limits appear once an account is configured.", nextStep("Go to Accounts", "#/accounts")),
    ),
  });
  // The audit chain check: a narrow card beside Live trading (the limits table gets the full width so no column is cut).
  const audit = card({
    glyph: "activity",
    tint: "indigo",
    title: "Audit log",
    body: h("div", { class: "stack" }, h("p", { class: "muted" }, "Every order, key change and kill-switch action is written to a hash chain. Verify checks that no record was changed or removed."), h("div", { class: "row" }, verifyBtn)),
  });
  // Trading readiness: between the kill switch and live trading.
  const ready = await readinessCard({ cardFn: card, demo: app.state.demo }).catch(() => null);
  return [killCard, ready, limits, h("div", { class: "grid side safety-row" }, live, audit)].filter(Boolean);
}

// ── Keys ──

/** Where each snippet group goes, as the "Paste it into" tabs after a key is made. */
const SNIPPET_TABS = Object.freeze({ excel: "Excel and Sheets", claude: "Claude (MCP)", chatgpt: "ChatGPT / OpenAI", python: "Python", node: "Node", amibroker: "AmiBroker", rest: "curl" });
const CLIENT_LABEL = Object.freeze({ excel: "Excel / Sheets", mcp: "AI assistant", script: "Script", ui: "App", other: "Other" });
const ACCESS_LABEL = Object.freeze({ read: "Read only: prices, charts, AI", paper: "Paper trading: read + paper orders", "admin,paper": "Admin: manage the Bridge" });

/**
 * The key just made, shown big: the key with Copy (and a Copied state), a clear shown-once warning, and setups ready
 * to paste for the tool it is for (the key already filled in). Nothing here is stored; leaving the page forgets it.
 */
function newKeyPanel({ key, label, use, scopes, account, onDone }) {
  const tabs = [...new Set([...use.snippets, "excel", "python", "node", "claude", "rest"])].filter((id) => SNIPPET_TABS[id]);
  // A key that may not sit in a URL gets no spreadsheet tab (spreadsheets can only send it that way).
  const usable = tabs.filter((id) => !(id === "excel" || id === "amibroker") || use.allowQuery);
  const all = snippets({ base: location.origin, key, account, symbol: "NSE:NIFTY", folder: app.state.meta?.installDir || undefined });
  const body = h("div", { class: "stack" });
  const seg = segmented("Paste it into", usable.map((id) => [id, SNIPPET_TABS[id]]), usable[0]);
  const draw = () => body.replaceChildren(...(all[seg.value] ?? []).map((sn) => codeBlock(sn.code, { title: sn.title, json: sn.lang === "json" })));
  seg.addEventListener("change", draw);
  draw();
  const keyCode = h("code", { class: "new-key-value" }, key);
  return h(
    "section",
    { class: "new-key", "aria-label": `New key ${label}`, tabindex: "-1" },
    h("div", { class: "new-key-head" }, h("span", { class: "new-key-tick", "aria-hidden": "true" }, icon("check")), h("div", { class: "grow" }, h("strong", {}, `Key created: ${label}`), h("span", { class: "muted small" }, `${scopes.join(" + ")} access · ${use.label}`))),
    alertBox({ title: "Copy it now. It is shown only once.", detail: "The Bridge keeps only a fingerprint of it. If you lose it, revoke it below and create another." }, "warn"),
    h("div", { class: "new-key-row" }, keyCode, copyButton(key, { label: "Copy key", toastLabel: "Key copied", cls: "primary" })),
    h("div", { class: "new-key-snips stack" }, h("div", { class: "row" }, h("strong", {}, "Paste it into"), seg), body),
    h("div", { class: "row" }, h("span", { class: "grow muted small" }, "Leaving this page hides the key for good."), h("button", { type: "button", class: "small", onclick: onDone }, "I have copied it, hide it")),
  );
}

async function renderKeys() {
  const [keys, accounts] = await Promise.all([api("/v1/keys"), api("/v1/accounts")]);
  const rows = keys.data.data ?? [];
  const accs = accounts.data.data ?? [];
  const paperAcc = accs.find((a) => a.broker === "paper")?.id ?? "paper";
  let labels = rows.map((k) => k.label);
  const createdBox = h("div", { class: "new-key-box" });
  const formErr = h("div", { "aria-live": "polite" });
  // "Used by" comes first: it fills in the name, the access, the expiry and URL use, so Create works first time.
  const usedBy = h("select", { id: "key-use" }, KEY_USES.map((u) => h("option", { value: u.id }, u.label)));
  const label = h("input", { id: "key-label", maxlength: "60", "aria-required": "true", autocomplete: "off" });
  const scope = h("select", { id: "key-access" }, Object.entries(ACCESS_LABEL).map(([v, t]) => h("option", { value: v }, t)));
  const acct = h("select", { id: "key-accounts" }, h("option", { value: "*" }, "All accounts"), accs.map((a) => h("option", { value: a.id }, `${a.label} (${a.id})`)));
  const expires = segmented("Expires", [["", "Never"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]], "");
  const urlUse = h("input", { type: "checkbox", id: "key-url" });
  const createBtn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create key");
  // What the person changed by hand is kept when they switch "Used by"; the rest follows the tool.
  const touched = { label: false, scope: false, expires: false, url: false };
  label.addEventListener("input", () => (touched.label = label.value.trim() !== ""));
  scope.addEventListener("change", () => (touched.scope = true));
  expires.addEventListener("click", () => (touched.expires = true));
  urlUse.addEventListener("change", () => (touched.url = true));
  const applyUse = () => {
    const u = keyUse(usedBy.value);
    if (!touched.label) {
      label.value = defaultKeyName(u.id, new Date(), labels);
      clearFieldError(label);
    }
    if (!touched.scope) {
      scope.value = u.scopes.join(",");
      clearFieldError(scope);
    }
    if (!touched.expires) expires.value = u.expiresDays ? String(u.expiresDays) : "";
    if (!touched.url) urlUse.checked = u.allowQuery;
  };
  usedBy.addEventListener("change", applyUse);
  applyUse();
  const create = async () => {
    formErr.replaceChildren();
    const u = keyUse(usedBy.value);
    const scopes = scope.value.split(",");
    const problem = keyFormProblem({ label: label.value, scopes, allowQuery: urlUse.checked });
    if (problem) return fieldError(problem.field === "label" ? label : scope, problem.message);
    busy(createBtn, true);
    try {
      const body = { label: label.value.trim(), scopes, accounts: acct.value === "*" ? "*" : [acct.value], clientKind: u.clientKind };
      if (expires.value) body.expiresAt = new Date(Date.now() + Number(expires.value) * 86_400_000).toISOString();
      if (urlUse.checked) body.allowQuery = true;
      const r = await api("/v1/keys", { method: "POST", body });
      const k = r.data.data?.key;
      const made = body.label;
      createdBox.replaceChildren(newKeyPanel({ key: k, label: made, use: { ...u, allowQuery: urlUse.checked }, scopes, account: acct.value === "*" ? paperAcc : acct.value, onDone: () => createdBox.replaceChildren() }));
      createdBox.firstElementChild?.scrollIntoView?.({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      createdBox.querySelector(".new-key-row button")?.focus({ preventScroll: true });
      toast(`Key created: ${made}. Copy it now.`);
      labels = [...labels, made];
      touched.label = false;
      applyUse();
      await drawTable();
    } catch (err) {
      const one = err?.body?.errors?.[0];
      const at = String(one?.path ?? "").split(".").pop();
      if (at === "label") fieldError(label, one.message ? `${cap(one.message)}.` : err.message);
      else formErr.replaceChildren(errorBox(err, { label: "Name", scopes: "Access", accounts: "Accounts", expiresAt: "Expires" }));
    } finally {
      busy(createBtn, false);
    }
  };
  createBtn.addEventListener("click", create);
  label.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      create();
    }
  });

  const ownId = String(currentKey() ?? "").split("_")[1] ?? null;
  const tableBox = h("div");
  const drawTable = async (list) => {
    const data = list ?? (await api("/v1/keys")).data.data ?? [];
    const status = (k) => (k.revokedAt ? pill("Revoked", "bad") : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? pill("Expired", "warn") : pill("Active", "ok"));
    tableBox.replaceChildren(
      table(
        [
          { label: "Name", cell: (k) => h("div", {}, h("strong", {}, k.label), h("div", { class: "muted small mono" }, k.id, k.id === ownId ? h("span", { class: "chip own-key" }, "this browser") : null)) },
          { label: "Scopes", cell: (k) => h("div", { class: "chips" }, k.scopes.slice().sort().map(scopeChip), k.allowQuery ? h("span", { class: "chip" }, "URL ok") : null) },
          { label: "Accounts", cell: (k) => (k.accounts === "*" ? "All" : k.accounts.join(", ")) },
          { label: "For", cell: (k) => CLIENT_LABEL[k.clientKind] ?? k.clientKind ?? DASH },
          { label: "Last used", cell: (k) => (k.lastUsedAt ? istDateTime(k.lastUsedAt) : "Never") },
          { label: "Expires", cell: (k) => (k.expiresAt ? istDateTime(k.expiresAt) : "Never") },
          { label: "Status", cell: status },
          {
            label: "",
            cell: (k) =>
              k.revokedAt
                ? ""
                : h("button", {
                    type: "button",
                    class: "small plain",
                    "aria-label": `Revoke key ${k.label}`,
                    onclick: async (e) => {
                      const btn = e.currentTarget;
                      const own = k.id === ownId;
                      const ok = await modal({
                        title: `Revoke “${k.label}”?`,
                        body: h(
                          "div",
                          { class: "stack" },
                          h("p", {}, "It stops working on its very next request, and its open streams close. This cannot be undone."),
                          own ? alertBox({ title: "This browser is signed in with this key", detail: "You will be signed out at once. Sign in again with another admin key, or make a sign-in link with the CLI." }, "warn") : null,
                        ),
                        buttons: [{ label: "Cancel", value: false }, { label: own ? "Revoke and sign out" : "Revoke", cls: "primary", value: true }],
                      });
                      if (!ok) return;
                      busy(btn, true);
                      try {
                        await api(`/v1/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
                        toast(`Revoked ${k.label}`);
                      } catch (err) {
                        toast(`Could not revoke ${k.label}: ${err.message}`, { tone: "error" });
                      }
                      busy(btn, false);
                      drawTable();
                    },
                  }, "Revoke"),
          },
        ],
        data,
        emptyState("keys", "No keys yet", "Create one key per tool so you can revoke one without touching the others.", nextStep("Create a key", () => label.focus())),
        { mobile: "stack-wide" },
      ),
    );
  };
  await drawTable(rows);
  // Wide screens (1700 px and up): create on the left, the keys beside it (app.css .keys-split).
  return [
    h("div", { class: "keys-split" }, card({
      glyph: "plus",
      tint: "pink",
      title: "Create a key",
      sub: "One key per tool. Pick the tool and the rest is filled in with the least access it needs. Live keys are made from the terminal only.",
      body: h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "form-grid" },
          field("Used by", usedBy, "Sets the name, the access and the expiry for you"),
          field("Name", label),
          h("label", { class: "field wide", for: "key-access" }, h("span", {}, "Access"), scope),
          h("label", { class: "field", for: "key-accounts" }, h("span", {}, "Accounts"), acct),
          segField("Expires", expires, { wide: true }),
        ),
        h("div", { class: "row" }, h("label", { class: "check" }, urlUse, "Allow in URLs (?key=), for Excel and Google Sheets. Read-only keys only."), h("span", { class: "grow" }), createBtn),
        formErr,
        createdBox,
      ),
    }),
    card({ glyph: "keys", tint: "pink", title: "Your keys", sub: "Only a fingerprint (hash) of each key is stored. The key itself was shown once.", flush: true, body: tableBox })),
  ];
}

// ── Integrations ──

const TABS = INTEGRATION_TOOLS;
const INTRO = {
  webhooks: "Alerts that place paper orders through a webhook: signed generic JSON from your scripts, ChartInk scans or GoCharting alerts.",
  python: "The Python SDK: standard library only, Python 3.9+. Paper orders get an Idempotency-Key automatically.",
  node: "The Node SDK (ESM). Streaming on Node 20 needs ws; Node 22 has a built-in WebSocket.",
  excel: "Live prices in cells with WEBSERVICE. The key goes in the URL, so make a read-only URL key with an expiry.",
  amibroker: "Live values in AFL from the Bridge's cache and stream. History imports use /xl/history with the shipped .format files.",
  claude: "The Bridge is an MCP server. Claude can read prices, chains and your positions; it can only prepare orders for you to confirm.",
  chatgpt: "ChatGPT connectors cannot reach a local server. Use the same tools from your own script with OpenAI function calling.",
  rest: "Every route answers { data, meta } JSON with freshness labels; errors are problem+json with a stable code.",
};
const GUIDES = { webhooks: "webhooks", python: "python", node: "typescript", excel: "excel-sheets", amibroker: "amibroker", claude: "mcp", chatgpt: "chatgpt-openai", rest: "streaming" };

/** The hash's query (`#/api/integrations?tool=python` → URLSearchParams). */
const hashParams = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
/** Put one query value in the address without a navigation (the page is already showing it). */
function setHashParam(key, value) {
  const [path] = location.hash.split("?");
  const qs = hashParams();
  qs.set(key, value);
  history.replaceState(history.state, "", `${path}?${qs}`);
}

/**
 * API › Integrations: one panel. Its tools are an inner segmented control (?tool=, and the old ?tab=); the webhook
 * form sits straight in the panel and the code blocks are its only inner surfaces.
 */
async function renderIntegrations() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? "paper";
  const createdKeys = {};
  const tabsBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Tools" });
  const panel = h("div", { class: "integ-panel" });
  const params = hashParams();
  const asked = params.get("tool") ?? params.get("tab");
  let active = TABS.some(([id]) => id === asked) ? asked : "webhooks";

  const draw = async () => {
    drawTabs(tabsBar, panel, TABS, active, (id) => {
      active = id;
      setHashParam("tool", id);
      draw();
    });
    edgeFades(tabsBar);
    const s = snippets({ base: location.origin, key: createdKeys[active] ?? null, account: paperAcc, symbol: "NSE:NIFTY", folder: app.state.meta?.installDir || undefined })[active];
    const preset = KEY_PRESETS[active];
    const keyBtn = preset && h("button", { type: "button", class: "small" }, icon("keys"), createdKeys[active] ? "Key created" : `Create a ${preset.scopes.join("+")} key for this`);
    if (keyBtn) keyBtn.disabled = Boolean(createdKeys[active]);
    keyBtn?.addEventListener("click", async () => {
      try {
        const body = { label: preset.label, scopes: preset.scopes, accounts: "*", clientKind: preset.clientKind };
        if (preset.allowQuery) body.allowQuery = true;
        if (preset.expiresDays) body.expiresAt = new Date(Date.now() + preset.expiresDays * 86_400_000).toISOString();
        const r = await api("/v1/keys", { method: "POST", body });
        createdKeys[active] = r.data.data.key;
        toast("Key created and filled in below. Copy it now: it is shown only once.");
        draw();
      } catch (err) {
        toast(err.message, { tone: "error" });
      }
    });
    const intro = h(
      "div",
      { class: "card-body stack" },
      h("div", { class: "row" }, h("p", { class: "grow muted" }, INTRO[active], " ", h("span", { class: "nowrap" }, `Your Bridge address: ${location.origin}`)), ...(keyBtn ? [keyBtn] : []), h("a", { href: `https://github.com/MrChartist/api-bridge/blob/main/docs/guides/${GUIDES[active]}.md`, target: "_blank", rel: "noopener", "aria-label": `${TABS.find(([id]) => id === active)[1]} guide (opens in a new tab)` }, "Guide ↗")),
      createdKeys[active] ? h("div", { class: "alert info" }, icon("info"), h("div", {}, h("strong", {}, "Your new key is in the snippets below."), h("span", { class: "detail" }, "It is shown only on this page and only until you leave it."))) : null,
    );
    const parts = [intro];
    if (active === "webhooks") parts.push(...(await webhookPanel(paperAcc)));
    if (s.length) parts.push(h("div", { class: "card-body stack" }, s.map((sn) => codeBlock(sn.code, { title: sn.title, json: sn.lang === "json" }))));
    panel.replaceChildren(...parts.filter(Boolean));
  };
  await draw();
  return card({ flush: true, cls: "integ-card", body: h("div", {}, tabsBar, panel) });
}

async function webhookPanel(paperAcc) {
  const hooks = await optional(api("/v1/hooks"));
  const list = hooks.data?.data ?? [];
  const box = h("div", { class: "stack" });
  const label = h("input", { value: "NIFTY breakout", maxlength: "60" });
  const source = h("select", {}, [["generic", "Generic (signed JSON)"], ["chartink", "ChartInk"], ["gocharting", "GoCharting"]].map(([v, t]) => h("option", { value: v }, t)));
  const side = segmented("Side", [["", "From the alert"], ["BUY", "BUY"], ["SELL", "SELL"]], "");
  const orderType = segmented("Order type", [["LIMIT", "LIMIT (safer)"], ["MARKET", "MARKET (protected)"]], "LIMIT");
  const product = segmented("Product", ["INTRADAY", "MARGIN", "CNC"].map((p) => [p, p]), "INTRADAY");
  const lots = h("input", { type: "number", inputmode: "numeric", value: "1", min: "1", max: "50" });
  const btn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create webhook");
  const columns = [
    { label: "Hook", cell: (x) => h("div", {}, h("strong", {}, x.label), h("div", { class: "muted small mono" }, x.id)) },
    { label: "Source", cell: (x) => x.source },
    { label: "Account", cell: (x) => x.account },
    { label: "Mode", cell: (x) => (x.mode === "live" ? pill("Live", "bad") : pill("Paper")) },
    // Live hooks: their account's trading readiness (GET /v1/hooks `readiness`; paper hooks have none).
    { label: "Readiness", cell: (x) => (x.mode === "live" && x.readiness ? pill(STATE_TEXT[x.readiness] ?? x.readiness, STATE_TONE[x.readiness] ?? "") : h("span", { class: "muted" }, DASH)) },
    { label: "Last alert", cell: (x) => istDateTime(x.lastSignalAt) },
    {
      label: "",
      cell: (x) =>
        h("button", {
          type: "button",
          class: "small plain",
          "aria-label": `Delete webhook ${x.label}`,
          onclick: async () => {
            if (!(await modal({ title: `Delete “${x.label}”?`, body: h("p", {}, "Alerts sent to its URL are refused from now on."), buttons: [{ label: "Cancel", value: false }, { label: "Delete", cls: "primary", value: true }] }))) return;
            await optional(api(`/v1/hooks/${encodeURIComponent(x.id)}`, { method: "DELETE" }));
            show();
          },
        }, "Delete"),
    },
  ];
  // Only the table is redrawn when a hook is added, so the one-time secret URL in `box` stays on screen.
  const tableSlot = h("div", { class: "integ-hooks" });
  const drawTable = () => tableSlot.replaceChildren(...[table(columns, list, h("p", { class: "integ-empty muted small" }, "No webhooks yet. Fill in the form above and choose Create webhook."))].filter(Boolean));
  drawTable();
  btn.addEventListener("click", async () => {
    busy(btn, true);
    try {
      const r = await api("/v1/hooks", { method: "POST", body: { source: source.value, label: label.value.trim() || "Webhook", account: paperAcc, orderType: orderType.value, product: product.value, maxLotsPerSignal: Number(lots.value) || 1, ...(side.value ? { side: side.value } : {}) } });
      const d = r.data.data;
      list.push(d);
      drawTable();
      box.replaceChildren(...[
        h("div", { class: "secret-box" }, h("strong", {}, "Webhook URL (its secret token is shown once):"), h("code", {}, d.url), copyButton(d.url, { cls: "small primary", toastLabel: "URL copied" })),
        d.signingSecret ? h("div", { class: "secret-box" }, h("strong", {}, "Signing secret (shown once; sign every request with it):"), h("code", {}, d.signingSecret), copyButton(d.signingSecret, { cls: "small primary", toastLabel: "Secret copied" })) : null,
        ...(d.templates ?? []).slice(0, 1).map((t) => codeBlock(t.message, { title: t.name, json: t.contentType === "application/json" && t.message.startsWith("{") })),
        ...(d.warnings ?? []).map((w) => alertBox({ title: "Note", detail: w }, "warn")),
        h("p", { class: "muted small" }, "Hosted alert services post from the internet, so point a tunnel (for example Cloudflare Tunnel) at the public ingress listener, which serves /hooks only. Paper orders by default."),
      ].filter(Boolean));
    } catch (err) {
      box.replaceChildren(alertBox(err));
    } finally {
      busy(btn, false);
    }
  });
  return [
    h(
      "div",
      { class: "card-body stack integ-hook-form" },
      h("div", { class: "card-titles" }, h("h3", {}, "Alert webhook"), h("p", {}, `Each hook has its own secret URL and places paper orders on ${paperAcc}.`)),
      h("div", { class: "form-grid" }, h("label", { class: "field" }, "Name", label), h("label", { class: "field" }, "Source", source), segField("Side", side), segField("Order type", orderType, { wide: true }), segField("Product", product), h("label", { class: "field" }, "Max lots per alert", lots), btn),
      box,
    ),
    tableSlot,
  ];
}

// ── Activity ──

async function renderActivity() {
  const tabsBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Activity" });
  const body = h("div");
  // #/api/activity?view=audit opens the audit log (the Ctrl K "Audit log" entry).
  let active = hashParams().get("view") === "audit" ? "audit" : "requests";
  let showAll = false;
  const hideOwn = h("input", { type: "checkbox" });
  hideOwn.checked = local.get(HIDE_OWN_SLOT) !== "0";
  hideOwn.addEventListener("change", () => {
    local.set(HIDE_OWN_SLOT, hideOwn.checked ? null : "0");
    draw();
  });
  const draw = () => keepFocusAsync(body, drawActivity);
  const drawActivity = async () => {
    drawTabs(tabsBar, body, [["requests", "Requests"], ["audit", "Audit log"]], active, (id) => {
      active = id;
      setHashParam("view", id);
      draw();
    });
    if (active === "requests") {
      const r = await api("/v1/requests?limit=200");
      const all = (r.data.data ?? []).filter((x) => !hideOwn.checked || x.client !== "dashboard");
      const rows = all.slice(0, showAll ? 200 : 40);
      const more = all.length > rows.length ? h("div", { class: "card-body row" }, h("span", { class: "muted small" }, `Showing the latest ${formatInt(rows.length)} of ${formatInt(all.length)}.`), h("button", { type: "button", class: "small", onclick: () => { showAll = true; draw(); } }, "Show all")) : null;
      body.replaceChildren(
        h("div", { class: "card-body row" }, h("label", { class: "check" }, hideOwn, "Hide the dashboard's own requests"), h("span", { class: "grow" }), h("span", { class: "muted small" }, "Kept in memory only: the last 200 requests. Paths only, never query strings, bodies or keys.")),
        table(
          [
            { label: "Time", cell: (x) => istTime(x.at) },
            { label: "Method", cell: (x) => h("span", { class: `method ${x.method}` }, x.method) },
            { label: "Path", cell: (x) => h("span", { class: "mono" }, x.path) },
            { label: "Status", cell: (x) => pill(String(x.status), x.status < 300 ? "ok" : x.status < 500 ? "warn" : "bad") },
            { label: "Time taken", num: true, cell: (x) => `${formatInt(x.ms)} ms` },
            { label: "Key", cell: (x) => (x.keyId ? h("span", { class: "mono small" }, x.keyId) : h("span", { class: "muted" }, "None")) },
          ],
          rows,
          emptyState("activity", "No requests yet", hideOwn.checked ? "Requests from your scripts, charts, Excel and AI tools appear here. Untick the box to see the dashboard's own." : "Requests appear here as they arrive.", nextStep("Make a call in the test console", "#/api/console")),
          { mobile: "scroll" },
        ),
        ...(more ? [more] : []), // replaceChildren would print a null as the text "null"
      );
    } else {
      const r = await api("/v1/audit?limit=100");
      const rows = r.data.data ?? [];
      body.replaceChildren(
        h("div", { class: "card-body" }, h("p", { class: "muted small" }, "Append-only and hash-chained, one file per IST day in data/audit/. Secrets are redacted. Verify the chain on the Safety page.")),
        table(
          [
            { label: "#", num: true, cell: (x) => formatInt(x.seq) },
            { label: "When", cell: (x) => istDateTime(x.at) },
            { label: "Event", cell: (x) => h("strong", {}, x.type) },
            { label: "By", cell: (x) => `${x.actor?.kind ?? ""}:${x.actor?.id ?? ""}` },
            { label: "Source", cell: (x) => x.source },
            { label: "Account", cell: (x) => x.accountId ?? DASH },
            { label: "Details", wrap: true, cell: (x) => h("span", { class: "mono small" }, JSON.stringify(x.data ?? {}).slice(0, 140)) },
          ],
          rows,
          emptyState("activity", "The audit log is empty today", "Key changes, orders, kill-switch actions and webhook events are recorded here."),
          { mobile: "scroll" },
        ),
      );
    }
  };
  await draw();
  every(4000, draw);
  return card({ flush: true, body: h("div", {}, tabsBar, body) });
}
