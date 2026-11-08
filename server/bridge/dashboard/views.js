// Dashboard pages. Each page renders into #content from live Bridge data; nothing here stores data outside this tab
// except small conveniences in localStorage (theme, density, the last tab of each page).
import { alertBox, api, app, brokerMatches, card, codeBlock, confirmCodeNotice, copyButton, currentKey, emptyState, fillLoginUrl, h, highlightJson, icon, iconTile, istDateTime, istTime, loginBody, loginFormSpec, meterRow, modal, optional, pill, table, ticketFields, toast, sheetPopover, confirmEngageKillSwitch, DEMO_EXPLAINER, beginNavigation, onRevalidated, pageSkeleton, prefetchPage } from "./app.js";
import { STATE_TEXT, STATE_TONE, readinessCard, refreshReadiness } from "./readiness.js";
import { DASH, formatFixed, formatInt, formatRupee, formatRupeeGrouped, formatSignedRupee, isFigure } from "./format.js";
import { DENSITY_SLOT, parseDensity } from "./layout-prefs.js";
import { busiestClass, mountBudget, perSecondLimit, usageChart, windowText } from "./budget.js";
import * as live from "./live.js";
import { KEY_PRESETS, snippets } from "./snippets.js";
import { KEY_USES, WORKING_ORDER, afterDemoSaveSteps, brokerSetupSteps, capabilityLabel, contractName, orderStatusText, capabilitySummary, clearFieldError, defaultKeyName, fieldError, keyFormProblem, keyUse, modifyChange, sessionText } from "./flows.js";
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
/** A broker session in plain words ("Logged in", "Not logged in", "Expired: log in again"); a paper account is "Ready". */
const sessionPill = (s, broker) => {
  if (broker === "paper") return pill("Ready", "ok");
  const t = sessionText(s);
  return pill(t.text, t.tone);
};
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
const initials = (name) => String(name).replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
/** A table cell: the broker's small logo and its name (paper accounts and unknown brokers: the name alone). */
const brokerCell = (id, name) => (id === "paper" ? name : h("span", { class: "broker-cell" }, brokerAvatar({ id, name }, "sm"), h("span", {}, name)));
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

/**
 * An account's capabilities on one line: the first as a chip, then a "+N" chip (two chips at most) that opens the rest in a popover,
 * so every account row keeps one height (about 64px on a desktop) however much its broker can do.
 */
function capabilityChips(a) {
  const caps = a.capabilities ?? [];
  // One summary chip in words ("Data and orders"); the full list, also in words, behind "+N".
  const more = caps.length
    ? h("button", { type: "button", class: "chip-btn acct-caps-more", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": `Everything ${a.label} can do (${formatInt(caps.length)})` }, `+${formatInt(caps.length)}`)
    : null;
  more?.addEventListener("click", () => {
    more.setAttribute("aria-expanded", "true");
    sheetPopover({ trigger: more, title: `${a.label} can do`, body: h("div", { class: "chips acct-caps-all" }, caps.map((c) => h("span", { class: "chip" }, capabilityLabel(c)))) });
  });
  return h("div", { class: "chips acct-caps" }, caps.length ? h("span", { class: "chip" }, capabilitySummary(caps)) : null, more);
}

/** A metric card: tinted icon and label, the figure, a footnote. */
function stat(label, value, sub, glyph, tint) {
  return h("section", { class: "card stat" }, h("div", { class: "stat-head" }, glyph ? iconTile(glyph, tint, "sm") : null, h("span", { class: "label" }, label)), h("span", { class: "value" }, value), h("span", { class: "sub" }, sub));
}

// ── Accounts ──

const AUTH_KIND_LABEL = { apiKeyToken: "API key", oauthRedirect: "OAuth login", requestTokenExchange: "One-time code", sessionLogin: "Session login" };
/** The paper simulator as an entry in the "Add a broker" list. */
const PAPER_CHOICE = { id: "paper", name: "Paper account (practice, no broker)", authKind: null, verified: false, paper: true };
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

/** One broker as a row of the pick lists (name, how it logs in, Verified / Beta). */
function brokerPickRow(b, checked, onPick) {
  const radio = h("input", { type: "radio", name: "add-broker", value: b.id, checked });
  radio.addEventListener("change", () => onPick(b.id));
  return h(
    "label",
    { class: "pick-row" },
    radio,
    b.paper ? h("span", { class: "avatar" }, "P") : brokerAvatar(b),
    h("span", { class: "names" }, h("span", { class: "nm" }, b.name), h("span", { class: "sub" }, b.paper ? "Simulated orders with real prices" : AUTH_KIND_LABEL[b.authKind] ?? b.authKind)),
    b.paper ? pill("Simulator") : b.verified ? pill("Verified", "ok") : pill("Beta", "warn"),
  );
}

/** A searchable broker list: the search field, the radio list, and redraw/selection plumbing. */
function brokerPicker(brokers, initial, onPick) {
  let chosen = brokers.some((b) => b.id === initial) ? initial : null;
  const realCount = brokers.filter((b) => !b.paper).length;
  const search = h("input", { type: "search", placeholder: `Search ${formatInt(realCount)} brokers…`, "aria-label": "Search brokers", autocomplete: "off", spellcheck: "false" });
  const picker = h("div", { class: "pick-list", role: "radiogroup", "aria-label": "Broker" });
  const draw = () => {
    const rows = brokers.filter((b) => brokerMatches(b, search.value));
    picker.replaceChildren(...rows.map((b) => brokerPickRow(b, b.id === chosen, (id) => ((chosen = id), onPick(id)))));
    if (!rows.length) picker.replaceChildren(h("p", { class: "muted small pick-empty" }, `No broker matches “${search.value}”. Try its short name, like “kite” or “angel”.`));
  };
  search.addEventListener("input", draw);
  // Enter in the search picks the only match (or the first), so a typed name plus Enter is enough.
  search.addEventListener("keydown", (e) => {
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
  // A preselected broker is scrolled into view once the sheet is open.
  if (chosen) setTimeout(() => picker.querySelector("input:checked")?.closest(".pick-row")?.scrollIntoView?.({ block: "nearest" }), 60);
  return { search, picker, chosen: () => chosen };
}

/**
 * Demo mode's "Add a broker": demo runs on sample prices, so nothing is connected here. Pick a broker, see what
 * connecting it takes (its fields, step by step), and save it to the config file for the next normal start
 * (POST /v1/accounts in demo mode). Resolves with the answer, or null when cancelled.
 */
function demoBrokerSheet(list, { preselect } = {}) {
  const brokers = realBrokers(list);
  const guide = h("div", { class: "setup-guide", "aria-live": "polite" });
  const pickErr = h("div", { "aria-live": "polite" });
  const err = h("div", { "aria-live": "polite" });
  const leave = h("input", { type: "checkbox", checked: true });
  const drawGuide = (id) => {
    pickErr.replaceChildren();
    const b = brokers.find((x) => x.id === id);
    if (!b) {
      guide.replaceChildren(h("p", { class: "muted small" }, "Choose your broker to see what connecting it takes."));
      return;
    }
    const steps = brokerSetupSteps(b, loginFormSpec(b), { demo: true });
    guide.replaceChildren(
      h("div", { class: "setup-head" }, brokerAvatar(b), h("strong", {}, `Connecting ${b.name}`), b.verified ? pill("Verified", "ok") : pill("Beta", "warn")),
      h(
        "ol",
        { class: "setup-steps" },
        steps.map((st) => h("li", {}, h("strong", {}, st.title), h("span", {}, st.text), st.fields?.length ? h("span", { class: "chips" }, st.fields.map((f) => h("span", { class: "chip" }, f))) : null)),
      ),
    );
  };
  const pick = brokerPicker(brokers, preselect, drawGuide);
  drawGuide(pick.chosen());
  return modal({
    title: "Add a broker",
    body: h(
      "div",
      { class: "stack" },
      alertBox({ title: "You are in demo mode", detail: "Demo runs on sample prices, so no broker is connected here. Pick yours to see what connecting it takes, and save it for when you start the Bridge normally." }, "info"),
      pick.search,
      pick.picker,
      pickErr,
      guide,
      h("label", { class: "check" }, leave, "Start normally next time (turns demo mode off in the config file)"),
      err,
    ),
    buttons: [
      { label: "Cancel", value: null },
      {
        label: "Save for normal mode",
        cls: "primary",
        onClick: async () => {
          const chosen = pick.chosen();
          if (!chosen) {
            pickErr.replaceChildren(h("p", { class: "field-msg", role: "alert" }, "Choose your broker from the list first."));
            pick.search.focus();
            return false;
          }
          try {
            const r = await api("/v1/accounts", { method: "POST", body: { broker: chosen, leaveDemo: leave.checked } });
            return { ...r.data.data, broker: brokers.find((b) => b.id === chosen) };
          } catch (e) {
            err.replaceChildren(errorBox(e, { broker: "Broker" }));
            return false;
          }
        },
      },
    ],
  });
}

/**
 * "Add a broker" sheet: a searchable list of the brokers (verified / beta), an optional name and id. Resolves with
 * the POST /v1/accounts answer ({ account, restartNeeded, configFile }) or null when cancelled. Demo mode opens
 * demoBrokerSheet instead (never a dead end).
 */
function addBrokerSheet(list, { preselect } = {}) {
  if (app.state.demo) return demoBrokerSheet(list, { preselect });
  const brokers = [...realBrokers(list).filter((b) => b.available !== false), PAPER_CHOICE];
  const nameInput = h("input", { id: "add-label", type: "text", maxlength: "60", autocomplete: "off", placeholder: "A name you will recognise" });
  const idInput = h("input", { id: "add-id", type: "text", maxlength: "32", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: "Picked for you, e.g. zerodha-main" });
  const pickErr = h("div", { "aria-live": "polite" });
  const err = h("div", { "aria-live": "polite" });
  const idBox = h("details", { class: "disclosure" }, h("summary", {}, "Account id (optional)"), field("Account id", idInput, "Used by scripts and spreadsheets to pick this account: 2-32 lowercase letters, digits or hyphens."));
  const describe = (id) => {
    pickErr.replaceChildren();
    const b = brokers.find((x) => x.id === id);
    nameInput.placeholder = b ? (b.paper ? "Paper account" : `${b.name} (main)`) : "A name you will recognise";
    idInput.placeholder = b ? `Picked for you, e.g. ${b.paper ? "paper-2" : `${b.id}-main`}` : "Picked for you, e.g. zerodha-main";
  };
  const pick = brokerPicker(brokers, preselect, describe);
  describe(pick.chosen());
  return modal({
    title: "Add a broker",
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, "Choose your broker. You log in on the next step; nothing is sent to the broker yet. New accounts are paper only."),
      pick.search,
      pick.picker,
      pickErr,
      field("Name (optional)", nameInput),
      idBox,
      err,
    ),
    buttons: [
      { label: "Cancel", value: null },
      {
        label: "Add and log in",
        cls: "primary",
        onClick: async () => {
          const chosen = pick.chosen();
          if (!chosen) {
            pickErr.replaceChildren(h("p", { class: "field-msg", role: "alert" }, "Choose your broker from the list first."));
            pick.search.focus();
            return false;
          }
          const body = { broker: chosen };
          if (nameInput.value.trim()) body.label = nameInput.value.trim();
          if (idInput.value.trim()) body.id = idInput.value.trim();
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
      h("ol", { class: "setup-steps" }, afterDemoSaveSteps(r, name).map((t) => h("li", {}, h("span", {}, t)))),
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
    return show();
  }
  if (added.restartNeeded || !added.account) {
    await modal({
      title: "Saved: one more step",
      body: h(
        "div",
        { class: "stack" },
        alertBox({ title: "Restart the Bridge to use the new account", detail: "This Bridge could not load it while running, so it was saved for the next start." }, "info"),
        h("ol", { class: "setup-steps" }, ["Close the Bridge window (or press Ctrl+C in it).", "Start it again from the Start menu, the Desktop or the same command.", "Open Accounts and press Log in next to the new account."].map((t) => h("li", {}, h("span", {}, t)))),
        h("p", { class: "muted small" }, `Saved in ${added.configFile}`),
      ),
      buttons: [{ label: "Done", cls: "primary", value: true }],
    });
    return show();
  }
  await show();
  if (added.account.broker === "paper") return toast(`Added ${added.account.label}. It is ready for paper orders.`);
  toast(`Added ${added.account.label}. Now log in to it.`);
  await loginSheet(added.account, list.find((b) => b.id === added.account.broker));
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
    inputs.set(f, input);
    groups[f.group].push(field(f.label, input, f.hint));
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
  const form = h(
    "form",
    { class: "stack login-form", autocomplete: "off", novalidate: true },
    groups.values.length ? h("div", { class: "form-grid" }, groups.values) : null,
    loginLink,
    groups.secrets.length ? h("div", { class: "secret-fields stack" }, h("div", { class: "group-label" }, "To log in now"), h("div", { class: "form-grid" }, groups.secrets)) : null,
  );
  let busy = false;
  const submit = async () => {
    if (busy) return false;
    result.replaceChildren();
    // Checked before anything leaves the page, and shown on the field itself: a missing or malformed one-time code or
    // PIN. (Saved fields are not all required: some brokers fill a token in themselves from the day's code.)
    for (const [f, input] of inputs) {
      if (f.group === "secrets" && !input.value.trim()) return fieldError(input, `Type your ${f.label} to log in.`);
      if (f.group === "secrets" && f.pattern && !new RegExp(`^${f.pattern}$`).test(input.value.trim())) return fieldError(input, `${f.label} is ${f.maxlength ?? 6} digits.`);
    }
    let body = loginBody(spec, (f) => inputs.get(f).value);
    // Off the page at once, whatever happens next.
    for (const i of inputs.values()) i.value = "";
    if (!Object.keys(body.values).length && !body.secrets) {
      const firstInput = inputs.values().next().value;
      return fieldError(firstInput, spec.keepHint ? "Type at least the fields that changed (for most brokers: today's token or code)." : `Type your ${broker.name} details first.`);
    }
    busy = true;
    loginBtn?.setAttribute("aria-busy", "true");
    result.replaceChildren(h("p", { class: "muted small", role: "status" }, `Logging in to ${broker.name}…`));
    let state;
    try {
      state = (await api(`/v1/accounts/${encodeURIComponent(a.id)}/session`, { method: "POST", body })).data.data;
    } catch (err) {
      result.replaceChildren(errorBox(err, labels));
      return false;
    } finally {
      body = null;
      busy = false;
      loginBtn?.removeAttribute("aria-busy");
    }
    if (state?.state === "connected") {
      show().then(() => toast(`${a.label}: logged in${state.expiresAt ? `, until ${istDateTime(state.expiresAt)}` : ""}`));
      return true;
    }
    result.replaceChildren(alertBox({ title: `${broker.name} did not accept this`, detail: `${state?.message ?? "No reason given."} Check the fields and try again. One-time codes change every 30 seconds.` }));
    return false;
  };
  let loginBtn = null;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    loginBtn?.click();
  });
  return modal({
    title: `Log in to ${a.label}`,
    body: h(
      "div",
      { class: "stack" },
      h("div", { class: "row" }, brokerAvatar(broker), h("strong", {}, broker.name), broker.verified ? pill("Verified", "ok") : pill("Beta", "warn"), sessionPill(a.session?.state)),
      h("div", { class: "login-help" }, spec.help.map((t) => h("p", {}, t))),
      spec.fields.length ? form : alertBox({ title: "Nothing to type", detail: "This broker needs no fields." }, "info"),
      result,
      h(
        "details",
        { class: "disclosure" },
        h("summary", {}, "Prefer the terminal?"),
        h("div", { class: "stack" }, h("p", { class: "muted small" }, "With the Bridge running, this asks for the same fields with hidden input:"), codeBlock(`${cliHint()} accounts connect ${a.id} --key <your admin key>`)),
      ),
      h("p", { class: "muted small" }, "Everything you type goes only to the Bridge on this computer, and from there only to your broker."),
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
        cls: "primary",
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
    if (removed) show().then(() => toast(`Removed ${a.label}`));
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
    show().then(() => toast(`${a.label}: positions, orders and funds put back`));
  };
  if (done) show().then(() => toast(h("span", { class: "toast-undo-row" }, `${a.label} starts again with ${formatRupeeGrouped(Number(pick.value))} · `, h("button", { type: "button", class: "toast-undo", onclick: undo }, "Undo"))));
}

/** The Accounts "Today" cell: a placeholder that fills itself (positions, funds, today's orders; today-core.js). */
const todayCells = new Map();
function todayCell(a) {
  const el = h("div", { class: "acct-today", "data-acct": a.id }, a.broker === "paper" || a.session?.state === "connected" ? h("span", { class: "muted small" }, "Reading") : h("span", { class: "muted small" }, "Log in to see today"));
  todayCells.set(a.id, el);
  return el;
}
async function fillToday(accs) {
  const readable = accs.filter((a) => a.broker === "paper" || a.session?.state === "connected").slice(0, 8);
  const { accountToday } = await import("./today-core.js");
  const orders = await optional(api("/v1/orders?limit=200"));
  await Promise.all(
    readable.map(async (a) => {
      const [p, f] = await Promise.all([optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`))]);
      const el = todayCells.get(a.id);
      if (!el?.isConnected) return;
      if (p.error && f.error) {
        el.replaceChildren(h("span", { class: "muted small" }, "Not available"));
        return;
      }
      const t = accountToday({ accountId: a.id, positions: p.data?.data ?? null, funds: f.data?.data ?? null, orders: orders.data?.data ?? [], nowMs: Date.now() });
      el.replaceChildren(
        h("div", { class: "acct-today-pnl" }, pnl(t.pnl, 0), h("span", { class: "muted small" }, ` · ${formatInt(t.open)} open`)),
        h("div", { class: "muted small" }, `${formatInt(t.orders)} order${t.orders === 1 ? "" : "s"}${t.orders ? ` (${formatInt(t.filled)} filled)` : ""} · margin ${t.margin === null ? DASH : formatRupeeGrouped(t.margin)}`),
      );
    }),
  );
}
async function renderAccounts() {
  const [accounts, brokers] = await Promise.all([api("/v1/accounts"), api("/v1/brokers")]);
  const accs = accounts.data.data ?? [];
  const list = brokers.data.data ?? [];
  const brokerOf = (a) => list.find((b) => b.id === a.broker);
  const paperCount = accs.filter((a) => a.broker === "paper").length;
  const testAccount = async (a, btn) => {
    busy(btn, true);
    try {
      const r = await api(`/v1/accounts/${encodeURIComponent(a.id)}/test`, { method: "POST" });
      toast(r.data?.data?.ok ? `${a.label}: connection OK` : `${a.label}: ${r.data?.data?.message ?? "the broker did not answer"}`, { tone: r.data?.data?.ok ? "ok" : "error" });
    } catch (err) {
      modal({ title: `Test ${a.id}`, body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    } finally {
      busy(btn, false);
    }
  };
  const addButton = (cls = "primary", text = "Add a broker") => h("button", { type: "button", class: cls, onclick: () => addAccountFlow(list) }, icon("plus"), text);
  const removeButton = (a) => h("button", { type: "button", class: "small", "aria-label": `Remove ${a.label}`, onclick: () => removeAccountSheet(a) }, "Remove");

  const accountsCard = card({
    cls: "accounts-card",
    glyph: "accounts",
    tint: "indigo",
    title: "Your accounts",
    sub: "Several brokers and several accounts per broker are fine. New accounts are paper only.",
    actions: h("div", { class: "row" }, h("button", { type: "button", class: "small quiet", title: "A .xlsx with your watchlist and open positions as live formulas against this Bridge", onclick: () => import("./workbook.js").then((m) => m.downloadWorkbook()) }, icon("download"), h("span", {}, "Excel workbook")), addButton("small primary", app.state.demo ? "Add your broker" : "Add a broker")),
    flush: true,
    body: table(
      [
        { label: "Account", wrap: true, cell: (a) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small mono" }, a.id)) },
        // Broker and what it can do share a cell, and Session carries the mode under its pill, so the table fits its
        // card from 1100px up without a sideways scroll (two fewer columns).
        { label: "Broker", wrap: true, cell: (a) => h("div", { class: "acct-broker" }, a.broker === "paper" ? h("span", {}, "Paper (simulator)") : brokerCell(a.broker, brokerOf(a)?.name ?? a.broker), capabilityChips(a)) },
        {
          label: "Session and today",
          cell: (a) =>
            h(
              "div",
              { class: "acct-session" },
              h("span", { class: "acct-session-pills" }, sessionPill(a.session?.state, a.broker), a.liveAllowedByConfig ? pill("Live enabled", "bad") : pill("Paper")),
              a.session?.expiresAt ? h("div", { class: "muted small" }, `until ${istDateTime(a.session.expiresAt)}`) : null,
              // Today: P&L, orders and margin used, filled in after the table draws (paper and logged-in accounts). It
              // shares the Session cell so the table keeps fitting its card from 1024 px without a sideways scroll.
              todayCell(a),
            ),
        },
        {
          label: "",
          cell: (a) => {
            if (a.broker === "paper") return h("div", { class: "row" }, h("button", { type: "button", class: "small", "aria-label": `Reset ${a.label} or add paper money`, onclick: () => paperResetSheet(a) }, "Reset funds"), !app.state.demo && paperCount > 1 ? removeButton(a) : null);
            const t = h("button", { type: "button", class: "small", "aria-label": `Test ${a.id}` }, "Test");
            t.addEventListener("click", () => testAccount(a, t));
            if (app.state.demo) return t;
            const connected = a.session?.state === "connected";
            const loginText = connected ? "Log in again" : "Log in";
            const login = () => loginSheet(a, brokerOf(a));
            // A narrow card (accounts-card container < 1080px, app.css) shows these as one ⋯ menu instead of a row.
            const more = h("button", { type: "button", class: "icon-btn acct-acts-more", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-label": `Actions for ${a.label}: test, ${loginText.toLowerCase()}${a.liveAllowedByConfig ? "" : ", remove"}` }, icon("more"));
            more.addEventListener("click", () => {
              more.setAttribute("aria-expanded", "true");
              let handle = null;
              const item = (label, fn, cls = "") => h("button", { type: "button", class: `menu-item${cls}`, onclick: () => (handle?.close(), setTimeout(fn, 0)) }, label);
              const items = [item("Test connection", () => testAccount(a, more)), item(loginText, login), a.liveAllowedByConfig ? null : item("Remove", () => removeAccountSheet(a), " destructive")].filter(Boolean);
              handle = sheetPopover({ trigger: more, title: a.label, body: h("div", { class: "menu-list stack" }, items), cls: "menu-pop" });
            });
            return h(
              "div",
              { class: "acct-acts" },
              h("div", { class: "row acct-acts-inline" }, t, h("button", { type: "button", class: connected ? "small" : "small primary", "aria-label": `${loginText === "Log in" ? "Log in to" : "Log in again to"} ${a.label}`, onclick: login }, loginText), a.liveAllowedByConfig ? null : removeButton(a)),
              more,
            );
          },
        },
      ],
      accs,
      emptyState("accounts", "No accounts yet", "Add your broker to get started: choose it, then log in with its API details. It takes a minute.", addButton()),
      { mobile: "stack-wide" },
    ),
  });
  // Directory
  const search = h("input", { type: "search", class: "dir-search", placeholder: "Search 41 brokers…", "aria-label": "Search brokers" });
  const grid = h("div", { class: "brokers" });
  const real = realBrokers(list);
  const draw = () => {
    const rows = real.filter((b) => brokerMatches(b, search.value));
    grid.replaceChildren(
      ...rows.map((b) =>
        h(
          "div",
          { class: "broker" },
          h("div", { class: "top" }, brokerAvatar(b), h("div", { class: "names" }, h("div", { class: "nm", title: b.name }, b.name), h("div", { class: "id" }, b.id)), b.verified ? pill("Verified", "ok") : pill("Beta", "warn")),
          h(
            "div",
            { class: "row broker-foot" },
            h("div", { class: "chips grow" }, h("span", { class: "chip" }, AUTH_KIND_LABEL[b.authKind] ?? b.authKind), b.capabilities.includes("feed") ? h("span", { class: "chip" }, "live feed") : null, b.capabilities.includes("historical") ? h("span", { class: "chip" }, "history") : null, b.capabilities.includes("placeOrder") ? h("span", { class: "chip" }, "orders") : null),
            h("button", { type: "button", class: "small", "aria-label": `Add a ${b.name} account`, onclick: () => addAccountFlow(list, { preselect: b.id }) }, app.state.demo ? "Set up" : "Add"),
          ),
        ),
      ),
    );
    if (!rows.length) grid.replaceChildren(h("div", { class: "row" }, h("p", { class: "muted" }, `No broker matches “${search.value}”.`), nextStep("Clear search", () => { search.value = ""; draw(); search.focus(); }, "small")));
  };
  search.addEventListener("input", draw);
  draw();
  const dirCard = card({
    glyph: "plug",
    tint: "blue",
    title: "Supported brokers",
    sub: `${real.length} brokers. Dhan is verified with a live account; the others are beta (tested against recorded samples).${app.state.demo ? " In demo mode, Set up shows what connecting one takes and saves it for your next normal start." : ""}`,
    actions: search,
    flush: true,
    body: grid,
  });

  setTimeout(() => fillToday(accs).catch(() => {}), 0);
  return [accountsCard, dirCard];
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
const CONSOLE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CONSOLE_HISTORY_SLOT = "mcb.dashboard.consoleHistory";
const STATUS_TEXT = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No content", 304: "Not modified", 400: "Bad request", 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 405: "Method not allowed", 409: "Conflict", 422: "Unprocessable", 429: "Too many requests", 500: "Server error", 502: "Bad gateway", 503: "Unavailable" };
/** Where in a JSON text the parser gave up ("line 3, column 5"), or a plain fallback. Pure. */
function jsonProblem(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const msg = String(err?.message ?? "");
    const lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc) return `Not valid JSON: line ${lc[1]}, column ${lc[2]}. Check the commas and quotes.`;
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      return `Not valid JSON: line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")}. Check the commas and quotes.`;
    }
    return `Not valid JSON${msg ? ` (${msg.replace(/^JSON\.parse: /, "").replace(/ in JSON.*$/, "").toLowerCase()})` : ""}. Check the commas and quotes.`;
  }
}
const sizeText = (n) => (n < 1024 ? `${formatInt(n)} B` : `${formatFixed(n / 1024, n < 10_240 ? 1 : 0)} KB`);
const readHistory = () => {
  try {
    const v = JSON.parse(local.get(CONSOLE_HISTORY_SLOT) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && CONSOLE_METHODS.includes(x.method) && typeof x.path === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
};

/**
 * API › Test console: an API playground. Pick an example or type a method and a path, edit the body, send it with
 * Ctrl or Cmd + Enter, and read the answer: status, time, size, headers (collapsed) and pretty JSON. Recent requests are
 * chips that load a request back into the form.
 */
async function renderConsole() {
  const root = h("div", { class: "api-tab" });
  loadInto(root, async () => (await api("/v1/accounts")).data.data ?? [], (accounts) => drawConsole(accounts), { rows: 2 });
  return root;
}

async function drawConsole(accounts) {
  const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? accounts[0]?.id ?? "paper";
  const dataAcc = accounts.find((a) => a.broker !== "paper")?.id ?? paperAcc;
  const example = h("select", { id: "ac-example", "aria-label": "Endpoint" }, h("option", { value: "" }, "Custom request"), ENDPOINTS.map((e) => h("option", { value: e.id }, e.label)));
  const method = h("select", { id: "ac-method", class: "ac-method", "aria-label": "Method" }, CONSOLE_METHODS.map((m) => h("option", { value: m }, m)));
  const path = h("input", { id: "ac-path", class: "ac-path mono", spellcheck: "false", autocomplete: "off", autocapitalize: "off", placeholder: "/v1/ltp?symbols=NSE:NIFTY", "aria-label": "Request path", "aria-describedby": "ac-path-msg" });
  const pathMsg = h("span", { id: "ac-path-msg", class: "ac-hint" }, "Starts with /v1/. Add a query after a question mark.");
  const bodyBox = h("textarea", { id: "ac-body", class: "ac-body mono", rows: 9, spellcheck: "false", autocapitalize: "off", "aria-label": "Request body (JSON)", "aria-describedby": "ac-body-msg" });
  const bodyMsg = h("span", { id: "ac-body-msg", class: "ac-hint" });
  const sendBtn = h("button", { type: "button", class: "primary ac-send" }, icon("play"), "Send", h("span", { class: "ac-send-keys" }, ...shortcut("Enter").keys.map((k) => h("kbd", { class: "kbd" }, k))));
  sendBtn.setAttribute("aria-keyshortcuts", shortcut("Enter").aria);
  const formatBtn = h("button", { type: "button", class: "small quiet", onclick: () => (tryFormat(), updateBody()) }, "Format JSON");
  const bodyField = h("div", { class: "ac-bodyfield" }, h("div", { class: "ac-bodyhead" }, h("label", { for: "ac-body" }, "Body (JSON)"), formatBtn), bodyBox, bodyMsg, h("p", { class: "ac-hint" }, "Tab inserts two spaces. Press Esc, then Tab, to move on."));
  const out = h("div", { class: "ac-out" });
  const historyBox = h("div", { class: "ac-history" });
  let busyNow = false;
  let history = readHistory();

  const firstExpiry = async () => (await optional(api("/v1/expiries?underlying=NIFTY"))).data?.data?.expiries?.[0] ?? "";
  const hasBody = () => method.value !== "GET";
  const curlText = () => {
    const url = `${location.origin}${path.value.trim() || "/v1/"}`;
    const parts = [`curl -X ${method.value}`, `"${url}"`, `-H "Authorization: Bearer $MCB_API_KEY"`];
    if (hasBody() && bodyBox.value.trim()) {
      parts.push(`-H "Content-Type: application/json"`);
      if (method.value === "POST" && /^\/v1\/orders\b/.test(path.value)) parts.push(`-H "Idempotency-Key: $(node -e "console.log(crypto.randomUUID())")"`);
      parts.push(`-d '${bodyBox.value.trim().replace(/\s*\n\s*/g, " ").replace(/'/g, "'\\''")}'`);
    }
    return method.value === "GET" ? `curl -H "Authorization: Bearer $MCB_API_KEY" "${url}"` : parts.join(" ");
  };
  const curlBtn = copyButton(curlText, { label: "Copy as curl", toastLabel: "curl copied", cls: "small quiet", ariaLabel: "Copy this request as a curl command" });

  const tryFormat = () => {
    try {
      bodyBox.value = JSON.stringify(JSON.parse(bodyBox.value), null, 2);
    } catch {
      /* the hint already says what is wrong */
    }
  };
  const updateBody = () => {
    bodyField.hidden = !hasBody();
    const t = bodyBox.value.trim();
    const problem = t ? jsonProblem(t) : null;
    if (problem) bodyBox.setAttribute("aria-invalid", "true");
    else bodyBox.removeAttribute("aria-invalid");
    bodyMsg.className = `ac-hint ${problem ? "bad" : t ? "ok" : ""}`.trim();
    bodyMsg.replaceChildren(...(problem ? [icon("warn"), problem] : t ? [icon("check"), "Valid JSON"] : ["Optional. An empty body sends nothing."]));
  };
  const setPathProblem = (msg) => {
    pathMsg.className = `ac-hint${msg ? " bad" : ""}`;
    pathMsg.textContent = msg ?? "Starts with /v1/. Add a query after a question mark.";
    if (msg) path.setAttribute("aria-invalid", "true");
    else path.removeAttribute("aria-invalid");
  };

  /** Load an example into the form: its method, path with default values, and body. */
  const applyExample = async (id) => {
    const ep = ENDPOINTS.find((e) => e.id === id);
    if (!ep) return;
    method.value = ep.method;
    setPathProblem(null);
    if (ep.method === "POST") {
      path.value = ep.path;
      bodyBox.value = JSON.stringify({ ...ep.body, account: paperAcc }, null, 2);
    } else {
      const qs = new URLSearchParams();
      for (const [k, def] of ep.fields) {
        let value = def;
        if (k === "expiry") value = await firstExpiry();
        if (k === "account") value = ep.id === "funds" || ep.id === "positions" ? paperAcc : dataAcc;
        if (value) qs.set(k, value);
      }
      path.value = `${ep.path}${qs.size ? `?${qs.toString().replace(/%3A/g, ":").replace(/%2C/g, ",")}` : ""}`;
      bodyBox.value = "";
    }
    updateBody();
  };

  const drawHistory = () => {
    historyBox.hidden = !history.length;
    historyBox.replaceChildren(
      h("span", { class: "ac-history-label", id: "ac-history-label" }, "Recent"),
      h(
        "div",
        { class: "ac-chips", role: "group", "aria-labelledby": "ac-history-label" },
        history.map((x) =>
          h(
            "button",
            { type: "button", class: "chip-btn ac-chip", title: `${x.method} ${x.path}`, "aria-label": `Load ${x.method} ${x.path}, answered ${x.status || "with an error"}`, onclick: () => ((method.value = x.method), (path.value = x.path), (bodyBox.value = x.body ?? ""), (example.value = ""), setPathProblem(null), updateBody(), path.focus()) },
            h("span", { class: "ac-chip-m" }, x.method),
            h("span", { class: "ac-chip-p" }, x.path),
            h("span", { class: "ac-chip-s" }, x.status ? String(x.status) : "failed"),
          ),
        ),
      ),
      h("button", { type: "button", class: "small plain", onclick: () => ((history = []), local.set(CONSOLE_HISTORY_SLOT, null), drawHistory()) }, "Clear"),
    );
  };
  const remember = (entry) => {
    history = [entry, ...history.filter((x) => !(x.method === entry.method && x.path === entry.path && x.body === entry.body))].slice(0, 8);
    local.set(CONSOLE_HISTORY_SLOT, JSON.stringify(history));
    drawHistory();
  };

  const showResponse = ({ status, ms, size, headers, text }) => {
    const ok = status < 400;
    let data = text;
    let json = false;
    try {
      data = JSON.parse(text);
      json = true;
    } catch {
      /* not JSON: shown as it came */
    }
    const pretty = !text ? "" : json ? JSON.stringify(data, null, 2) : text;
    const pre = h("pre", { class: "snip-code ac-pre", tabindex: "0", "aria-label": "Response body" });
    const LIMIT = 300_000;
    if (!pretty) pre.append(h("span", { class: "muted" }, "No body in the answer."));
    else if (json && pretty.length <= LIMIT) pre.innerHTML = highlightJson(pretty);
    else pre.textContent = pretty.slice(0, LIMIT);
    const order = ["x-request-id", "ratelimit", "ratelimit-policy", "retry-after", "x-mcb-data", "content-type"];
    const names = [...headers.keys()].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b));
    const friendly = !ok && json && typeof data === "object" && data ? alertBox({ code: data.code, status, message: data.detail }) : null;
    out.replaceChildren(
      h(
        "section",
        { class: "card ac-res", "aria-label": "Response" },
        h("header", { class: "card-head" }, iconTile(ok ? "check" : "warn", ok ? "green" : status >= 500 ? "red" : "orange"), h("div", { class: "card-titles" }, h("h2", {}, "Response")), h("div", { class: "card-actions" }, pill(`${status} ${STATUS_TEXT[status] ?? (ok ? "OK" : "Error")}`, statusTone(status)), pill(`${formatInt(ms)} ms`), pill(sizeText(size)), headers.get("x-mcb-data") === "demo" ? pill("Sample prices", "demo") : null)),
        h(
          "div",
          { class: "card-body stack" },
          h("span", { class: "sr-only", role: "status" }, `Response ${status} in ${ms} milliseconds`),
          friendly,
          h("details", { class: "ac-headers" }, h("summary", {}, `Headers (${formatInt(names.length)})`), h("dl", { class: "kv" }, names.flatMap((n) => [h("dt", {}, n), h("dd", {}, headers.get(n))]))),
          h("div", { class: "snip" }, h("div", { class: "snip-head" }, h("span", { class: "snip-lang" }, json ? "JSON" : "Text"), h("span", { class: "snip-title" }, "Body"), pretty ? copyButton(pretty, { ariaLabel: "Copy the response body", cls: "small copy snip-copy" }) : null), pre),
        ),
      ),
    );
  };

  const send = async () => {
    if (busyNow) return;
    const p = path.value.trim();
    if (!/^\/v1\/[^\s]*$/.test(p)) {
      setPathProblem("The path must start with /v1/ and have no spaces. Example: /v1/ltp?symbols=NSE:NIFTY");
      path.focus();
      return;
    }
    setPathProblem(null);
    const text = hasBody() ? bodyBox.value.trim() : "";
    if (text && jsonProblem(text)) {
      updateBody();
      bodyBox.focus();
      return;
    }
    busyNow = true;
    busy(sendBtn, true);
    const entry = { method: method.value, path: p, body: text.length <= 2000 ? text : "" };
    const t0 = performance.now();
    try {
      const headers = { Authorization: `Bearer ${currentKey()}`, "X-MCB-Client": "dashboard", "X-MCB-Page": "console" };
      if (text) headers["Content-Type"] = "application/json";
      if (method.value === "POST" && /^\/v1\/orders\b/.test(p)) headers["Idempotency-Key"] = `dash-${crypto.randomUUID()}`;
      let res;
      try {
        res = await fetch(p, { method: method.value, headers, body: text || undefined, cache: "no-store" });
      } catch {
        remember({ ...entry, status: 0 });
        out.replaceChildren(alertBox({ network: true }));
        return;
      }
      const raw = await res.text();
      const ms = Math.round(performance.now() - t0);
      showResponse({ status: res.status, ms, size: new TextEncoder().encode(raw).length, headers: res.headers, text: raw });
      remember({ ...entry, status: res.status });
    } finally {
      busyNow = false;
      busy(sendBtn, false);
    }
  };

  example.addEventListener("change", () => (example.value ? applyExample(example.value) : null));
  method.addEventListener("change", () => (updateBody(), (example.value = "")));
  path.addEventListener("input", () => {
    example.value = "";
    if (path.getAttribute("aria-invalid")) setPathProblem(null);
  });
  bodyBox.addEventListener("input", () => ((example.value = ""), updateBody()));
  // Tab writes two spaces, like an editor, until Esc is pressed (then Tab moves on): a keyboard-only person is never trapped.
  let freeTab = false;
  bodyBox.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return void (freeTab = true);
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !freeTab) {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = bodyBox;
      bodyBox.value = `${value.slice(0, a)}  ${value.slice(b)}`;
      bodyBox.selectionStart = bodyBox.selectionEnd = a + 2;
      updateBody();
    }
  });
  bodyBox.addEventListener("blur", () => (freeTab = false));
  sendBtn.addEventListener("click", send);
  const form = h("section", { class: "card ac-req", "aria-label": "Request" });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Enter" && e.target === path && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  form.append(
    h("header", { class: "card-head" }, iconTile("console", "teal"), h("div", { class: "card-titles" }, h("h2", {}, "Request"), h("p", {}, "Sent with your dashboard key. Scripts should use their own key.")), h("div", { class: "card-actions" }, curlBtn)),
    h(
      "div",
      { class: "card-body stack" },
      h("label", { class: "field", for: "ac-example" }, h("span", {}, "Start from an example"), example),
      h("div", { class: "ac-line" }, method, path, sendBtn),
      pathMsg,
      bodyField,
    ),
  );
  out.replaceChildren(card({ glyph: "inbox", tint: "gray", title: "Response", body: emptyState("console", "Send a request to see the answer", "You will see the status, how long it took, the rate-limit headers and the JSON, exactly as your scripts would get it.", null, { compact: true }) }));
  const res = h("div", { class: "ac-right" }, historyBox, out);
  const wanted = new URLSearchParams(location.hash.split("?")[1] ?? "").get("endpoint");
  const first = ENDPOINTS.some((e) => e.id === wanted) ? wanted : "ltp";
  await applyExample(first);
  example.value = first;
  drawHistory();
  return h("div", { class: "ac" }, form, res);
}

// ── Rate limits ──

const CLASS_NAME = Object.freeze({ order: "Orders", quote: "Quotes", depth: "Market depth", history: "History (candles)", chain: "Option chains", portfolio: "Positions and funds", master: "Instrument list", other: "Other calls" });
/** How full a budget is, in words and in the tone that colours its bar (calm, then amber, then red). Pure. */
function pressure(used, limit) {
  if (!(limit > 0)) return { tone: "calm", word: "No limit", pct: 0 };
  const p = used / limit;
  const pct = Math.min(100, Math.round(p * 100));
  if (p >= 0.85) return { tone: "high", word: "Near the limit", pct };
  if (p >= 0.6) return { tone: "busy", word: "Busy", pct };
  return { tone: "calm", word: "Calm", pct };
}
const limitSpan = (w) => ({ "1s": "per second", "1m": "per minute", "1d": "per day" })[w] ?? `per ${w ?? "second"}`;

/** One budget: name, a bar with the figures beside it, and what it did today. Colour follows pressure; the word says it too. */
function budgetMeter(name, c) {
  const limit = isFigure(c.limit) ? Number(c.limit) : 0;
  const used = Number(c.used ?? 0);
  const p = pressure(used, limit);
  const fill = h("i");
  fill.style.width = `${Math.max(p.pct, used > 0 ? 2 : 0)}%`;
  const others = (c.windows ?? []).filter((w) => w.bucket === `class:${c.cls}` && w.window !== c.window);
  const today = [`${formatInt(c.callsToday)} broker calls today`, c.throttledToday ? `${formatInt(c.throttledToday)} throttled by the broker` : null, c.refusedToday ? `${formatInt(c.refusedToday)} held back to stay inside limits` : null, ...others.map((w) => `${windowText(w)} ${limitSpan(w.window)}`)].filter(Boolean);
  return h(
    "div",
    { class: `al-meter ${p.tone}` },
    h("div", { class: "al-meter-head" }, h("span", { class: "al-name" }, name), h("span", { class: "al-figs" }, limit ? h("span", {}, h("strong", {}, formatInt(used)), ` of ${formatInt(limit)} ${limitSpan(c.window)}`) : h("span", {}, `${formatInt(used)} ${limitSpan(c.window)}, no limit`), h("span", { class: "al-word" }, p.word))),
    h("div", { class: "al-track", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(limit || used || 1), "aria-valuenow": String(used), "aria-label": `${name}: ${formatInt(used)} of ${limit ? formatInt(limit) : "no limit"} ${limitSpan(c.window)}, ${p.word.toLowerCase()}` }, fill),
    h("div", { class: "al-sub" }, today.join(" · ")),
  );
}

/**
 * API › Rate limits: how much of each broker budget is in use right now (calm, busy, near the limit), a two-minute
 * chart, who spent the budget today, and what the broker allows. Usage refreshes every 1.5 seconds; the policy, which
 * changes only with the configuration, is read once.
 */
async function renderLimits() {
  const root = h("div", { class: "api-tab al" });
  /** accountId -> the endpoint class its chart shows (the busiest, until a person picks another) */
  const chartClass = new Map();
  const openPolicies = new Set();
  let limitsData = null;
  let policyNodes = null;
  const policyCards = (lim) => {
    const policies = Object.values(lim.brokers ?? {});
    if (!policies.length) return null;
    return h(
      "section",
      { class: "group" },
      h("h2", { class: "group-title" }, "What the broker allows"),
      ...policies.map((p) => {
        const dec = Object.values(p.limits ?? {}).some((x) => isFigure(x.perSecond) && !Number.isInteger(Number(x.perSecond))) ? 1 : 0;
        const d = h(
          "details",
          { class: "al-policy", open: openPolicies.has(p.brokerId) },
          h("summary", {}, h("span", {}, h("strong", {}, p.brokerId), h("span", { class: "muted small" }, p.notes ? ` · ${p.notes}` : ""))),
          table(
            [
              { label: "Endpoint class", cell: (r) => h("strong", {}, CLASS_NAME[r[0]] ?? r[0]) },
              { label: "Per second", num: true, cell: (r) => formatFixed(r[1].perSecond, dec) },
              { label: "Per minute", num: true, cell: (r) => formatInt(r[1].perMinute) },
              { label: "Per day", num: true, cell: (r) => formatInt(r[1].perDay) },
              { label: "Source", wrap: true, cell: (r) => (String(r[1].source ?? "").includes("demo") ? pill("Sample (demo)", "demo") : r[1].verified ? pill("Broker docs", "ok") : pill("Conservative default", "warn")) },
            ],
            Object.entries(p.limits ?? {}),
            emptyState("limits", "No limits", "", null, { compact: true }),
          ),
        );
        d.addEventListener("toggle", () => (d.open ? openPolicies.add(p.brokerId) : openPolicies.delete(p.brokerId)));
        return d;
      }),
    );
  };

  const draw = async () => {
    const [usage, limits] = await Promise.all([api("/v1/usage?series=1"), limitsData ? Promise.resolve(limitsData) : api("/v1/limits")]);
    if (!limitsData) {
      limitsData = limits;
      policyNodes = policyCards(limits.data.data ?? {});
    }
    const u = usage.data.data ?? {};
    const sv = u.savings ?? {};
    const accounts = (u.accounts ?? []).filter((a) => a.broker !== "paper");
    const nodes = [];

    nodes.push(
      h(
        "section",
        { class: "card al-intro" },
        h("div", { class: "card-body stack" }, h("p", { class: "al-lead" }, "Every broker allows only so many calls. The Bridge keeps each account under its budget, and most requests never reach the broker at all."), h("div", { class: "al-stats" }, ...[
          ["Served from the live stream", sv.servedFromStream, "No broker call at all"],
          ["Served from cache", sv.servedFromCache, "Fresh enough, labelled with its age"],
          ["Shared calls", sv.coalesced, "Identical requests shared one call"],
          ["Batched calls", sv.batched, "Symbols packed into fewer calls"],
        ].map(([name, n, sub]) => h("div", { class: "al-stat" }, h("span", { class: "al-stat-n" }, formatInt(n)), h("span", { class: "al-stat-l" }, name), h("span", { class: "al-stat-s" }, sub))))),
      ),
    );

    if (!accounts.length) nodes.push(h("section", { class: "card" }, h("div", { class: "card-body flush" }, emptyState("limits", "No broker account in use yet", "Once a broker account is connected (or demo mode is on), its live budget per endpoint class shows here.", nextStep("Go to Accounts", "#/accounts")))));
    for (const a of accounts) {
      const classes = Object.entries(a.classes ?? {});
      const active = Object.keys(a.classes ?? {}).filter((c) => (a.classes[c].callsToday ?? 0) > 0 || a.series?.classes?.[c]);
      const cls = chartClass.get(a.accountId) ?? busiestClass(a);
      const c = a.classes?.[cls] ?? {};
      const counts = a.series?.classes?.[cls] ?? new Array(a.series?.seconds ?? 120).fill(0);
      const limit = perSecondLimit(c);
      const pick = active.length > 1 ? h("div", { class: "segmented", role: "group", "aria-label": "Endpoint class" }, active.map((k) => h("button", { type: "button", "aria-pressed": String(k === cls), onclick: () => (chartClass.set(a.accountId, k), draw()) }, CLASS_NAME[k] ?? k))) : null;
      const total = (key) => sum(Object.fromEntries(classes.map(([k, x]) => [k, x[key] ?? 0])));
      nodes.push(
        h(
          "section",
          { class: "card al-acct" },
          h("header", { class: "card-head" }, iconTile("limits", "purple"), h("div", { class: "card-titles" }, h("h2", {}, a.accountId), h("p", {}, `${cap(a.broker)} · ${formatInt(a.inFlight ?? 0)} in flight · ${formatInt(a.queued ?? 0)} waiting`)), h("div", { class: "card-actions" }, a.healthy === false ? pill("Backing off", "bad") : pill("Healthy", "ok"))),
          h(
            "div",
            { class: "card-body stack" },
            h("div", { class: "al-meters" }, classes.map(([k, x]) => budgetMeter(CLASS_NAME[k] ?? cap(k), { ...x, cls: k }))),
            h("p", { class: "al-today" }, `Today: ${formatInt(total("callsToday"))} broker calls, ${formatInt(total("throttledToday"))} throttled by the broker, ${formatInt(total("refusedToday"))} held back to stay inside limits.`),
            h(
              "div",
              { class: "al-chart" },
              h("div", { class: "al-chart-head" }, h("h3", {}, "Calls per second, last two minutes"), pick),
              usageChart(counts, limit, `${CLASS_NAME[cls] ?? cls} calls per second over the last two minutes${limit ? `, limit ${formatInt(limit)} a second` : ""}`),
              h("div", { class: "rl-axis" }, h("span", {}, "2 min ago"), h("span", {}, "now")),
              h("div", { class: "rl-legend" }, h("span", {}, h("i", { class: "sw" }), "Calls per second"), limit ? h("span", {}, h("i", { class: "sw limit" }), `Limit ${formatInt(limit)} a second`) : null),
            ),
          ),
        ),
      );
    }

    // Who used the budget today (admin keys only: it names API keys).
    if (Array.isArray(u.consumers) && u.consumers.length) {
      const top = Math.max(1, ...u.consumers.map((x) => x.calls));
      nodes.push(
        h(
          "section",
          { class: "group" },
          h("h2", { class: "group-title" }, "Who used the budget today"),
          h(
            "ul",
            { class: "list al-cons" },
            u.consumers.map((r) => {
              const bar = h("span", { class: "rl-cons-bar", "aria-hidden": "true" });
              bar.style.setProperty("--w", `${Math.round((r.calls / top) * 100)}%`);
              return h("li", { class: "list-row static" }, h("span", { class: "al-cons-name" }, r.name), h("span", { class: "al-cons-bar" }, bar), h("span", { class: "al-cons-n" }, h("strong", {}, formatInt(r.calls)), " broker calls", r.saved ? h("span", { class: "muted" }, ` · ${formatInt(r.saved)} saved`) : null));
            }),
          ),
          h("p", { class: "group-foot" }, "Broker calls each page, key or job caused, and the calls it got from the stream, the cache or a shared call instead."),
        ),
      );
    }
    if (policyNodes) nodes.push(policyNodes);

    const tryBtn = h("button", { type: "button", class: "small tinted" }, icon("bolt"), "Send 20 identical requests");
    tryBtn.disabled = !accounts.length;
    tryBtn.addEventListener("click", async () => {
      busy(tryBtn, true);
      try {
        const calls = (x) => (x.accounts ?? []).reduce((n, a) => n + sum(Object.fromEntries(Object.entries(a.classes ?? {}).map(([k, v]) => [k, v.callsToday ?? 0]))), 0);
        const before = (await api("/v1/usage")).data.data;
        await Promise.all(Array.from({ length: 20 }, () => optional(api("/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE"))));
        const after = (await api("/v1/usage")).data.data;
        const used = calls(after) - calls(before);
        toast(`20 requests became ${formatInt(used)} broker call${used === 1 ? "" : "s"}. The rest came from the live stream, the cache or a shared call.`);
      } finally {
        busy(tryBtn, false);
      }
      await draw();
    });
    nodes.push(h("section", { class: "group" }, h("div", { class: "list" }, h("div", { class: "list-row static al-try" }, iconTile("bolt", "purple"), h("span", { class: "names" }, h("span", { class: "nm" }, "See the savings"), h("span", { class: "sub al-wrap" }, accounts.length ? "Twenty tools asking for the same price at once should cost the broker about one call." : "Needs a connected broker or demo mode.")), tryBtn))));
    keepFocus(root, () => root.replaceChildren(...nodes));
  };
  const start = async () => {
    root.replaceChildren(apiSkeleton(3));
    try {
      await draw();
      every(1500, draw);
    } catch (err) {
      root.replaceChildren(errorPanel(err, start));
    }
  };
  await start();
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

// ── API page: shared pieces (Keys, Integrations, Test console, Rate limits, Activity) ──

/** Icon and tile hue of each tool, as the key form and the Integrations gallery show them. */
const API_TILE = Object.freeze({
  webhooks: ["integrations", "teal"],
  python: ["console", "blue"],
  node: ["bolt", "green"],
  excel: ["chart", "orange"],
  amibroker: ["activity", "indigo"],
  claude: ["plug", "purple"],
  chatgpt: ["inbox", "pink"],
  rest: ["arrow", "gray"],
  app: ["accounts", "teal"],
  other: ["keys", "gray"],
});

/** A calm placeholder while a tab loads (the shape of what is coming, no spinner). */
const apiSkeleton = (rows = 3) => h("div", { class: "api-skel", "aria-hidden": "true" }, h("span", { class: "skel-title" }), Array.from({ length: rows }, () => h("span", { class: "skel-block" })));

/** A failure in plain words, with the one thing to do about it. */
function errorPanel(err, retry) {
  const box = alertBox(err);
  if (retry) box.lastElementChild.append(h("div", { class: "alert-actions" }, h("button", { type: "button", class: "small", onclick: retry }, icon("refresh"), "Try again")));
  return box;
}

/**
 * Fill `slot` with a skeleton, then with `draw(data)` once `load()` answers. A failure shows what happened and a Try
 * again button in the same place, so one slow or failing read never blanks the whole tab.
 */
function loadInto(slot, load, draw, { rows = 3 } = {}) {
  const run = async () => {
    slot.setAttribute("aria-busy", "true");
    slot.replaceChildren(h("span", { class: "sr-only", role: "status" }, "Loading…"), apiSkeleton(rows));
    try {
      const data = await load();
      slot.replaceChildren(...[await draw(data)].flat().filter(Boolean));
    } catch (err) {
      slot.replaceChildren(errorPanel(err, run));
    } finally {
      slot.removeAttribute("aria-busy");
    }
  };
  return run();
}

/**
 * A gallery of choices as a roving-tabindex group: a radiogroup (`role: "radio"`, a form choice) or a tablist
 * (`role: "tab"`, switches a panel). Arrow keys move and choose; Home and End jump. The chosen one carries a check.
 * Returns the element, with a `.value` and `pick(id)`.
 */
function pickGrid({ label, role, items, value, onPick, panelId }) {
  const tab = role === "tab";
  const base = `pick-${++pickGrid.n}`;
  const el = h("div", { class: "api-pick", role: tab ? "tablist" : "radiogroup", "aria-label": label });
  const btns = items.map((it) => {
    const [glyph, tint] = API_TILE[it.id] ?? ["keys", "gray"];
    return h(
      "button",
      { type: "button", class: "api-pick-item", role: tab ? "tab" : "radio", "data-id": it.id, id: `${base}-${it.id}`, ...(tab && panelId ? { "aria-controls": panelId } : {}), onclick: () => pick(it.id, false) },
      iconTile(glyph, tint, "sm"),
      h("span", { class: "api-pick-text" }, h("span", { class: "api-pick-name" }, it.name), it.blurb ? h("span", { class: "api-pick-sub" }, it.blurb) : null),
      icon("check"),
    );
  });
  const pick = (id, focus) => {
    value = id;
    for (const b of btns) {
      const on = b.dataset.id === id;
      b.setAttribute(tab ? "aria-selected" : "aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    onPick?.(id);
  };
  el.addEventListener("keydown", (e) => {
    const i = btns.findIndex((b) => b.dataset.id === value);
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    pick(btns[(j + btns.length) % btns.length].dataset.id, true);
  });
  el.append(...btns);
  Object.defineProperty(el, "value", { get: () => value });
  // Mark the starting choice without telling the page about it.
  for (const b of btns) {
    const on = b.dataset.id === value;
    b.setAttribute(tab ? "aria-selected" : "aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  el.pick = pick;
  return el;
}
pickGrid.n = 0;

/** The language names a code block shows (snippets.js `lang`). */
const LANG_LABEL = Object.freeze({ bash: "Shell", json: "JSON", python: "Python", js: "JavaScript", excel: "Formula", afl: "AFL", bat: "Batch", text: "Text" });

/**
 * A code block that is made to be copied: a head with the language and what it is for, a Copy button that says
 * "Copied", and code that scrolls sideways inside its own box instead of wrapping.
 */
function snippetBlock({ title, lang = "text", code }) {
  const pre = h("pre", { class: "snip-code", tabindex: "0", "aria-label": title || LANG_LABEL[lang] || "Code" });
  if (lang === "json") pre.innerHTML = highlightJson(code);
  else pre.textContent = code;
  return h(
    "figure",
    { class: "snip" },
    h("figcaption", { class: "snip-head" }, h("span", { class: "snip-lang" }, LANG_LABEL[lang] ?? lang), title ? h("span", { class: "snip-title" }, title) : null, copyButton(code, { ariaLabel: `Copy: ${title || LANG_LABEL[lang] || "code"}`, cls: "small copy snip-copy" })),
    pre,
  );
}

/**
 * Something the Bridge shows only once (a new key, a webhook's secret URL): large, high contrast, with a Copy button
 * for each value, the warning, and a confirmation before it can be hidden. Nothing here is stored.
 */
function oncePanel({ title, sub, fields, body, ariaLabel, doneLabel = "Done, hide it", onDone }) {
  const ack = h("input", { type: "checkbox", id: `once-ack-${++oncePanel.n}` });
  const done = h("button", { type: "button", class: "primary", disabled: true, onclick: onDone }, doneLabel);
  ack.addEventListener("change", () => (done.disabled = !ack.checked));
  const copies = [];
  const rows = fields.map((f) => {
    const btn = copyButton(f.value, { label: f.copyLabel ?? "Copy", toastLabel: f.toast ?? "Copied", cls: "primary lg once-copy", ariaLabel: `Copy ${f.label.toLowerCase()}` });
    copies.push(btn);
    return h("div", { class: "once-field" }, h("span", { class: "once-label" }, f.label), h("div", { class: "once-row" }, h("code", { class: "once-value", tabindex: "0", "aria-label": f.label }, f.value), btn));
  });
  const el = h(
    "section",
    { class: "once", "aria-label": ariaLabel ?? title, tabindex: "-1" },
    h("header", { class: "once-head" }, iconTile("check", "green", "lg"), h("div", { class: "once-titles" }, h("h2", {}, title), sub ? h("p", {}, sub) : null)),
    alertBox({ title: "Copy it and store it now. It is shown only once.", detail: "The Bridge keeps only a fingerprint, so it cannot show this again. If you lose it, revoke it and make another." }, "warn"),
    ...rows,
    body ? h("div", { class: "once-body" }, body) : null,
    h("div", { class: "once-foot" }, h("label", { class: "check once-ack", for: ack.id }, ack, "I have copied it and stored it safely"), done),
  );
  el.focusFirst = () => copies[0]?.focus({ preventScroll: true });
  return el;
}
oncePanel.n = 0;

/**
 * One row of an API list (a key, a webhook): tile, name and fingerprint, pills, a side column for status and dates,
 * and one action. On a phone the side column drops under the name. Rows sit in a `.list` group.
 */
function apiRow({ glyph = "keys", tint = "pink", title, badge, sub, chips, aside = [], action, dim = false }) {
  return h(
    "div",
    { class: `list-row static api-row${dim ? " dim" : ""}` },
    iconTile(glyph, dim ? "gray" : tint),
    h("div", { class: "api-row-main" }, h("div", { class: "api-row-title" }, h("strong", {}, title), badge ?? null), sub ? h("div", { class: "api-row-sub" }, sub) : null, chips ? h("div", { class: "chips" }, chips) : null),
    h("div", { class: "api-row-aside" }, aside),
    action ? h("div", { class: "api-row-act" }, action) : null,
  );
}

// ── Keys ──

/** Where each snippet group goes, as the "Paste it into" tabs after a key is made. */
const SNIPPET_TABS = Object.freeze({ excel: "Excel and Sheets", claude: "Claude (MCP)", chatgpt: "ChatGPT / OpenAI", python: "Python", node: "Node", amibroker: "AmiBroker", rest: "curl" });
const CLIENT_LABEL = Object.freeze({ excel: "Excel / Sheets", mcp: "AI assistant", script: "Script", ui: "App", other: "Other" });
const USE_NAME = Object.freeze({ excel: "Excel or Sheets", claude: "AI assistant", python: "Python script", node: "Node script", amibroker: "AmiBroker", app: "My own app", other: "Something else" });
const USE_BLURB = Object.freeze({ excel: "Live prices in cells", claude: "Claude, ChatGPT and others", python: "Scripts and notebooks", node: "Scripts and services", amibroker: "Live values in AFL", app: "Your own tool or bot", other: "Anything not listed" });
const SCOPE_WORD = Object.freeze({ read: "Read", paper: "Paper orders", admin: "Admin", live: "Live orders" });
const SCOPE_HELP = Object.freeze({ read: "Prices, charts and option chains", paper: "Paper (practice) orders", admin: "Manage keys, accounts and webhooks", live: "Real orders with real money" });
/** The three access levels the dashboard can make, in plain words: what the key can do and what it cannot. */
const ACCESS_LEVELS = Object.freeze([
  { value: "read", name: "Read only", can: ["Read prices, candles and option chains", "Use the AI tools to look things up"], cannot: ["Place any order", "Change keys or accounts"] },
  { value: "paper", name: "Paper trading", can: ["Everything in Read only", "Place and cancel paper orders"], cannot: ["Place live orders", "Change keys or accounts"] },
  { value: "admin,paper", name: "Admin", can: ["Everything in Paper trading", "Create and revoke keys, manage accounts"], cannot: ["Place live orders (live keys are made in the terminal)"] },
]);
const EXPIRY_WORD = Object.freeze({ "": "never expires", 7: "expires in 7 days", 30: "expires in 30 days", 90: "expires in 90 days" });

const keyScopeChip = (s) => h("span", { class: `chip scope-${s}`, title: SCOPE_HELP[s] ?? "" }, SCOPE_WORD[s] ?? cap(s));
const keyStatus = (k) => (k.revokedAt ? "revoked" : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? "expired" : "active");
const dayMonth = (iso) => (iso ? istDateTime(iso).replace(/,.*$/, "") : DASH);

/**
 * The key just made: the key itself, copyable, with a confirmation before it can be hidden, then the setups ready to
 * paste for the tool it is for (the key already filled in).
 */
function newKeyPanel({ key, label, use, scopes, account, onDone }) {
  const tabs = [...new Set([...use.snippets, "excel", "python", "node", "claude", "rest"])].filter((id) => SNIPPET_TABS[id]);
  // A key that may not sit in a URL gets no spreadsheet tab (spreadsheets can only send it that way).
  const usable = tabs.filter((id) => !(id === "excel" || id === "amibroker") || use.allowQuery);
  const all = snippets({ base: location.origin, key, account, symbol: "NSE:NIFTY", folder: app.state.meta?.installDir || undefined });
  const body = h("div", { class: "stack" });
  const seg = segmented("Paste it into", usable.map((id) => [id, SNIPPET_TABS[id]]), usable[0]);
  const draw = () => body.replaceChildren(...(all[seg.value] ?? []).map(snippetBlock));
  seg.addEventListener("change", draw);
  draw();
  return oncePanel({
    title: `Key created: ${label}`,
    sub: `${scopes.map((s) => SCOPE_WORD[s] ?? s).join(" + ")} access · ${use.label}`,
    ariaLabel: `New key ${label}`,
    fields: [{ label: "Your new key", value: key, copyLabel: "Copy key", toast: "Key copied" }],
    body: h("div", { class: "stack" }, h("div", { class: "once-use" }, h("h3", {}, "Paste it into"), seg), body),
    doneLabel: "Done, hide the key",
    onDone,
  });
}

async function renderKeys() {
  const root = h("div", { class: "api-tab ak" });
  const createdBox = h("div", { class: "ak-created", "aria-live": "polite" });
  const cols = h("div", { class: "ak-cols" });
  root.append(createdBox, cols);
  const ownId = String(currentKey() ?? "").split("_")[1] ?? null;

  const drawAll = ({ rows, accs }) => {
    const paperAcc = accs.find((a) => a.broker === "paper")?.id ?? "paper";
    let labels = rows.map((k) => k.label);
    const formErr = h("div", { "aria-live": "polite" });

    // 1 · What will use it. The tool decides the name, the access, the expiry and URL use.
    const picker = pickGrid({
      label: "What will use this key",
      role: "radio",
      items: KEY_USES.map((u) => ({ id: u.id, name: USE_NAME[u.id] ?? u.label, blurb: USE_BLURB[u.id] })),
      value: KEY_USES[0].id,
      onPick: () => applyUse(),
    });
    // 2 · The details, already filled in.
    const label = h("input", { id: "key-label", maxlength: "60", "aria-required": "true", autocomplete: "off", spellcheck: "false" });
    const access = segmented("Access", ACCESS_LEVELS.map((a) => [a.value, a.name]), "read");
    const caps = h("div", { class: "ak-caps", "aria-live": "polite" });
    const acct = h("select", { id: "key-accounts" }, h("option", { value: "*" }, "All accounts"), accs.map((a) => h("option", { value: a.id }, `${a.label} (${a.id})`)));
    const expires = segmented("Expires", [["", "Never"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]], "");
    const urlUse = h("input", { type: "checkbox", id: "key-url", role: "switch" });
    const summary = h("p", { class: "ak-summary", "aria-live": "polite" });
    const createBtn = h("button", { type: "button", class: "primary lg full" }, icon("plus"), "Create key");
    // What the person changed by hand is kept when they pick another tool; the rest follows the tool.
    const touched = { label: false, scope: false, expires: false, url: false };
    label.addEventListener("input", () => (touched.label = label.value.trim() !== ""));
    for (const ev of ["click", "keydown"]) {
      access.addEventListener(ev, () => (touched.scope = true));
      expires.addEventListener(ev, () => (touched.expires = true));
    }
    urlUse.addEventListener("change", () => (touched.url = true));
    const drawCaps = () => {
      const lvl = ACCESS_LEVELS.find((a) => a.value === access.value) ?? ACCESS_LEVELS[0];
      const list = (cls, head, items, glyph) => h("div", { class: `ak-caps-col ${cls}` }, h("h4", {}, head), h("ul", {}, items.map((t) => h("li", {}, icon(glyph), h("span", {}, t)))));
      caps.replaceChildren(...[list("can", "Can", lvl.can, "check"), list("cannot", "Cannot", lvl.cannot, "close"), lvl.value === "admin,paper" ? h("p", { class: "ak-caps-note" }, "An admin key can create and revoke other keys. Give it only to tools you run yourself.") : null].filter(Boolean));
    };
    const drawSummary = () => {
      const lvl = ACCESS_LEVELS.find((a) => a.value === access.value) ?? ACCESS_LEVELS[0];
      summary.textContent = `“${label.value.trim() || "Unnamed key"}”: ${lvl.name.toLowerCase()}, ${acct.value === "*" ? "all accounts" : acct.value}, ${EXPIRY_WORD[expires.value] ?? "never expires"}${urlUse.checked ? ", works in URLs" : ""}.`;
    };
    function applyUse() {
      const u = keyUse(picker.value);
      if (!touched.label) {
        label.value = defaultKeyName(u.id, new Date(), labels);
        clearFieldError(label);
      }
      if (!touched.scope) access.value = u.scopes.join(",");
      if (!touched.expires) expires.value = u.expiresDays ? String(u.expiresDays) : "";
      if (!touched.url) urlUse.checked = u.allowQuery;
      drawCaps();
      drawSummary();
    }
    for (const el of [label, acct, urlUse]) el.addEventListener(el === label ? "input" : "change", drawSummary);
    access.addEventListener("change", () => (drawCaps(), drawSummary()));
    expires.addEventListener("change", drawSummary);
    applyUse();

    const create = async () => {
      formErr.replaceChildren();
      const u = keyUse(picker.value);
      const scopes = access.value.split(",");
      const problem = keyFormProblem({ label: label.value, scopes, allowQuery: urlUse.checked });
      if (problem) {
        if (problem.field === "label") fieldError(label, problem.message);
        else (formErr.replaceChildren(alertBox({ title: problem.message }, "warn")), urlUse.focus());
        return;
      }
      busy(createBtn, true);
      try {
        const body = { label: label.value.trim(), scopes, accounts: acct.value === "*" ? "*" : [acct.value], clientKind: u.clientKind };
        if (expires.value) body.expiresAt = new Date(Date.now() + Number(expires.value) * 86_400_000).toISOString();
        if (urlUse.checked) body.allowQuery = true;
        const r = await api("/v1/keys", { method: "POST", body });
        const k = r.data.data?.key;
        const made = body.label;
        const panel = newKeyPanel({ key: k, label: made, use: { ...u, allowQuery: urlUse.checked }, scopes, account: acct.value === "*" ? paperAcc : acct.value, onDone: () => (createdBox.replaceChildren(), label.focus({ preventScroll: true })) });
        createdBox.replaceChildren(panel);
        panel.scrollIntoView?.({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        panel.focusFirst();
        toast(`Key created: ${made}. Copy it now.`);
        labels = [...labels, made];
        touched.label = false;
        applyUse();
        await drawList();
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

    // The list of keys, redrawn after a key is made or revoked.
    const listBox = h("div", { class: "ak-list" });
    const revokeKey = async (k, btn) => {
      const own = k.id === ownId;
      const ok = await modal({
        title: `Revoke “${k.label}”?`,
        body: h("div", { class: "stack" }, h("p", {}, "It stops working on its very next request, and its open streams close. This cannot be undone."), own ? alertBox({ title: "This browser is signed in with this key", detail: "You will be signed out at once. Sign in again with another admin key, or make a sign-in link with the CLI." }, "warn") : null),
        buttons: [{ label: "Cancel", value: false }, { label: own ? "Revoke and sign out" : "Revoke key", cls: "destructive", value: true }],
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
      drawList();
    };
    const keyRow = (k) => {
      const st = keyStatus(k);
      const used = k.lastUsedAt ? `Last used ${istDateTime(k.lastUsedAt)}` : "Never used";
      const exp = k.expiresAt ? `${st === "expired" ? "Expired" : "Expires"} ${dayMonth(k.expiresAt)}` : "No expiry";
      return apiRow({
        title: k.label,
        dim: st !== "active",
        badge: k.id === ownId ? h("span", { class: "chip own-key" }, "This browser") : null,
        sub: h("span", {}, h("span", { class: "mono" }, `mcb_${k.id}_…`), ` · ${CLIENT_LABEL[k.clientKind] ?? k.clientKind ?? "Other"} · ${k.accounts === "*" ? "All accounts" : k.accounts.join(", ")}`),
        chips: [...k.scopes.slice().sort().map(keyScopeChip), k.allowQuery ? h("span", { class: "chip", title: "May be sent in the address (?key=)" }, "Works in URLs") : null],
        aside: [st === "active" ? pill("Active", "ok") : st === "expired" ? pill("Expired", "warn") : pill("Revoked", "bad"), h("span", { class: "api-row-note" }, k.revokedAt ? `Revoked ${dayMonth(k.revokedAt)}` : used), k.revokedAt ? null : h("span", { class: "api-row-note" }, exp)],
        action: k.revokedAt ? null : h("button", { type: "button", class: "small tinted destructive", "aria-label": `Revoke key ${k.label}`, onclick: (e) => revokeKey(k, e.currentTarget) }, icon("trash"), "Revoke"),
      });
    };
    const drawList = async (list) => {
      let data = list;
      try {
        data = list ?? (await api("/v1/keys")).data.data ?? [];
      } catch (err) {
        listBox.replaceChildren(errorPanel(err, () => drawList()));
        return;
      }
      const live = data.filter((k) => !k.revokedAt);
      const gone = data.filter((k) => k.revokedAt);
      const wasOpen = listBox.querySelector("details")?.open;
      listBox.replaceChildren(...[
        h("section", { class: "group" }, h("h2", { class: "group-title" }, `Your keys · ${formatInt(live.length)} active`), live.length ? h("div", { class: "list" }, live.map(keyRow)) : h("div", { class: "list" }, emptyState("keys", "No active keys", "Create one key per tool, so you can revoke one without touching the others.", nextStep("Create a key", () => label.focus()))), h("p", { class: "group-foot" }, "Only a fingerprint of each key is stored. The key itself was shown once, when you made it.")),
        gone.length ? h("details", { class: "ak-gone", open: wasOpen }, h("summary", {}, `Revoked keys (${formatInt(gone.length)})`), h("div", { class: "list" }, gone.map(keyRow))) : null,
      ].filter(Boolean));
    };
    drawList(rows);

    const create$ = h(
      "section",
      { class: "card ak-create" },
      h("header", { class: "card-head" }, iconTile("plus", "pink"), h("div", { class: "card-titles" }, h("h2", {}, "Create a key"), h("p", {}, "One key per tool, with only the access it needs. Live keys are made in the terminal."))),
      h(
        "div",
        { class: "card-body ak-form" },
        h("div", { class: "ak-step" }, h("h3", {}, h("span", { class: "ak-n", "aria-hidden": "true" }, "1"), "What will use it?"), picker),
        h(
          "div",
          { class: "ak-step" },
          h("h3", {}, h("span", { class: "ak-n", "aria-hidden": "true" }, "2"), "Check what it can do"),
          h("div", { class: "stack" }, h("label", { class: "field", for: "key-label" }, h("span", {}, "Name"), label), segField("Access", access, { wide: true }), caps, h("label", { class: "field", for: "key-accounts" }, h("span", {}, "Accounts"), acct), segField("Expires", expires, { wide: true }), h("label", { class: "ak-switch", for: "key-url" }, h("span", { class: "names" }, h("strong", {}, "Allow in URLs"), h("span", { class: "hint" }, "For Excel and Google Sheets, which can only send a key in the address (?key=). Read only keys.")), h("span", { class: "switch" }, urlUse, h("i")))),
        ),
        h("div", { class: "ak-go" }, summary, formErr, createBtn),
      ),
    );
    return [create$, listBox];
  };

  loadInto(
    cols,
    async () => {
      const [keys, accounts] = await Promise.all([api("/v1/keys"), api("/v1/accounts")]);
      return { rows: keys.data.data ?? [], accs: accounts.data.data ?? [] };
    },
    drawAll,
    { rows: 4 },
  );
  return root;
}

// ── Integrations ──

const INTRO = {
  webhooks: "Alerts from your scripts, ChartInk scans or GoCharting place paper orders through a webhook. Each hook has its own secret address.",
  python: "The Python client: standard library only, Python 3.9 or newer. Paper orders get an Idempotency-Key for you.",
  node: "The Node client (ESM). Streaming on Node 20 needs the ws package; Node 22 has a WebSocket built in.",
  excel: "Live prices in cells with WEBSERVICE. The key goes in the address, so use a read-only key with an expiry.",
  amibroker: "Live values in AFL from the Bridge's cache and stream. History imports use /xl/history with the shipped .format files.",
  claude: "The Bridge is an MCP server. An assistant can read prices, chains and your positions; it can only prepare orders for you to confirm.",
  chatgpt: "ChatGPT connectors cannot reach a server on your computer. Use the same tools from your own script with OpenAI function calling.",
  rest: "Every route answers { data, meta } JSON with freshness labels. Errors are problem+json with a stable code.",
};
const TOOL_BLURB = { webhooks: "Alerts place paper orders", python: "Scripts and notebooks", node: "Scripts and services", excel: "Live prices in cells", amibroker: "Live values in AFL", claude: "MCP server for assistants", chatgpt: "Function calling", rest: "Plain HTTP and JSON" };
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
 * API › Integrations: pick a tool (the gallery is a tablist; ?tool= and the old ?tab= choose one), then read one
 * panel: what it is, your Bridge address, a key if the tool needs one, and code that is ready to paste.
 */
async function renderIntegrations() {
  const root = h("div", { class: "api-tab ai" });
  const params = hashParams();
  const asked = params.get("tool") ?? params.get("tab");
  const start = INTEGRATION_TOOLS.some(([id]) => id === asked) ? asked : "webhooks";
  const createdKeys = {};

  const drawAll = (accounts) => {
    const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? "paper";
    let active = start;
    const panel = h("section", { class: "card ai-panel", role: "tabpanel", id: "ai-panel" });
    const picker = pickGrid({ label: "Tools", role: "tab", items: INTEGRATION_TOOLS.map(([id, name]) => ({ id, name, blurb: TOOL_BLURB[id] })), value: start, panelId: "ai-panel", onPick: (id) => ((active = id), setHashParam("tool", id), drawTool()) });

    async function drawTool() {
      const [, name] = INTEGRATION_TOOLS.find(([id]) => id === active);
      const [glyph, tint] = API_TILE[active] ?? ["keys", "gray"];
      panel.setAttribute("aria-labelledby", picker.querySelector(`[data-id="${active}"]`)?.id ?? "");
      const s = snippets({ base: location.origin, key: createdKeys[active] ?? null, account: paperAcc, symbol: "NSE:NIFTY", folder: app.state.meta?.installDir || undefined })[active] ?? [];
      const preset = KEY_PRESETS[active];
      const keyBtn = preset && h("button", { type: "button", class: "small tinted" }, icon("keys"), createdKeys[active] ? "Key created" : `Create a ${preset.scopes.join(" + ")} key for this`);
      if (keyBtn) {
        keyBtn.disabled = Boolean(createdKeys[active]);
        keyBtn.addEventListener("click", async () => {
          busy(keyBtn, true);
          try {
            const body = { label: preset.label, scopes: preset.scopes, accounts: "*", clientKind: preset.clientKind };
            if (preset.allowQuery) body.allowQuery = true;
            if (preset.expiresDays) body.expiresAt = new Date(Date.now() + preset.expiresDays * 86_400_000).toISOString();
            const r = await api("/v1/keys", { method: "POST", body });
            createdKeys[active] = r.data.data.key;
            toast("Key created and filled in below. Copy it now: it is shown only once.");
            drawTool();
          } catch (err) {
            busy(keyBtn, false);
            toast(err.message, { tone: "error" });
          }
        });
      }
      const guide = h("a", { class: "btn small quiet", href: `https://github.com/MrChartist/api-bridge-v2/blob/main/docs/guides/${GUIDES[active]}.md`, target: "_blank", rel: "noopener", "aria-label": `${name} guide (opens in a new tab)` }, "Guide", icon("external"));
      const parts = [
        h("header", { class: "card-head" }, iconTile(glyph, tint, "lg"), h("div", { class: "card-titles" }, h("h2", {}, name), h("p", {}, INTRO[active])), h("div", { class: "card-actions" }, guide)),
        h(
          "div",
          { class: "card-body ai-body" },
          h("div", { class: "ai-meta" }, h("div", { class: "ai-addr" }, h("span", { class: "ai-addr-label" }, "Your Bridge address"), h("code", {}, location.origin), copyButton(location.origin, { ariaLabel: "Copy your Bridge address", toastLabel: "Address copied", cls: "small copy" })), keyBtn ?? null),
          createdKeys[active] ? alertBox({ title: "Your new key is filled into the code below.", detail: "It is shown only on this page, and only until you leave it. Copy it now." }, "info") : null,
          active === "webhooks" ? h("div", { class: "ai-hooks" }) : null,
          s.length ? h("div", { class: "ai-snips stack" }, active === "webhooks" ? h("h3", { class: "ai-sub" }, "How to send an alert") : null, s.map(snippetBlock)) : null,
        ),
      ];
      panel.replaceChildren(...parts);
      if (active === "webhooks") await webhookPanel(paperAcc, panel.querySelector(".ai-hooks"));
    }
    drawTool();
    return [picker, panel];
  };

  loadInto(root, async () => (await api("/v1/accounts")).data.data ?? [], drawAll, { rows: 3 });
  return root;
}

async function webhookPanel(paperAcc, host) {
  const box = h("div", { class: "stack", "aria-live": "polite" });
  const listSlot = h("div", { class: "ai-hook-list" });
  const label = h("input", { id: "hook-name", value: "NIFTY breakout", maxlength: "60", autocomplete: "off" });
  const source = h("select", { id: "hook-source" }, [["generic", "Generic (signed JSON)"], ["chartink", "ChartInk"], ["gocharting", "GoCharting"]].map(([v, t]) => h("option", { value: v }, t)));
  const side = segmented("Side", [["", "From the alert"], ["BUY", "BUY"], ["SELL", "SELL"]], "");
  const orderType = segmented("Order type", [["LIMIT", "LIMIT (safer)"], ["MARKET", "MARKET (protected)"]], "LIMIT");
  const product = segmented("Product", ["INTRADAY", "MARGIN", "CNC"].map((p) => [p, p]), "INTRADAY");
  const lots = h("input", { id: "hook-lots", type: "number", inputmode: "numeric", value: "1", min: "1", max: "50" });
  const btn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create webhook");
  let list = [];
  const hookRow = (x) =>
    apiRow({
      glyph: "integrations",
      tint: "teal",
      title: x.label,
      sub: h("span", {}, h("span", { class: "mono" }, x.id), ` · ${cap(x.source)} · ${x.account}`),
      chips: [x.mode === "live" ? pill("Live", "bad") : pill("Paper"), x.mode === "live" && x.readiness ? pill(STATE_TEXT[x.readiness] ?? x.readiness, STATE_TONE[x.readiness] ?? "") : null],
      aside: [h("span", { class: "api-row-note" }, x.lastSignalAt ? `Last alert ${istDateTime(x.lastSignalAt)}` : "No alerts yet")],
      action: h("button", {
        type: "button",
        class: "small plain destructive",
        "aria-label": `Delete webhook ${x.label}`,
        onclick: async () => {
          if (!(await modal({ title: `Delete “${x.label}”?`, body: h("p", {}, "Alerts sent to its address are refused from now on."), buttons: [{ label: "Cancel", value: false }, { label: "Delete webhook", cls: "destructive", value: true }] }))) return;
          await optional(api(`/v1/hooks/${encodeURIComponent(x.id)}`, { method: "DELETE" }));
          list = list.filter((h2) => h2.id !== x.id);
          drawList();
          toast(`Deleted ${x.label}`);
        },
      }, icon("trash"), "Delete"),
    });
  const listNode = () => h("section", { class: "group" }, h("h3", { class: "group-title" }, `Your webhooks · ${formatInt(list.length)}`), list.length ? h("div", { class: "list" }, list.map(hookRow)) : h("div", { class: "list" }, emptyState("integrations", "No webhooks yet", "Fill in the form above and choose Create webhook. Its secret address appears here once.", null, { compact: true })));
  const drawList = () => listSlot.replaceChildren(listNode());
  btn.addEventListener("click", async () => {
    busy(btn, true);
    try {
      const r = await api("/v1/hooks", { method: "POST", body: { source: source.value, label: label.value.trim() || "Webhook", account: paperAcc, orderType: orderType.value, product: product.value, maxLotsPerSignal: Number(lots.value) || 1, ...(side.value ? { side: side.value } : {}) } });
      const d = r.data.data;
      list = [...list, d];
      drawList();
      const panel = oncePanel({
        title: `Webhook created: ${d.label ?? "Webhook"}`,
        sub: `Paper orders on ${paperAcc}`,
        ariaLabel: "New webhook",
        fields: [{ label: "Webhook address (its secret token is shown once)", value: d.url, toast: "Address copied" }, ...(d.signingSecret ? [{ label: "Signing secret (shown once; sign every request with it)", value: d.signingSecret, toast: "Secret copied" }] : [])],
        body: h("div", { class: "stack" }, ...(d.templates ?? []).slice(0, 1).map((t) => snippetBlock({ title: t.name, lang: t.contentType === "application/json" && t.message.startsWith("{") ? "json" : "text", code: t.message })), ...(d.warnings ?? []).map((w) => alertBox({ title: "Note", detail: w }, "warn")), h("p", { class: "muted small" }, "Hosted alert services post from the internet, so point a tunnel (for example Cloudflare Tunnel) at the public ingress listener, which serves /hooks only. Paper orders by default.")),
        doneLabel: "Done, hide it",
        onDone: () => box.replaceChildren(),
      });
      box.replaceChildren(panel);
      panel.focusFirst();
    } catch (err) {
      box.replaceChildren(alertBox(err));
    } finally {
      busy(btn, false);
    }
  });
  host.replaceChildren(
    h(
      "section",
      { class: "ai-hook-form" },
      h("div", { class: "card-titles" }, h("h3", {}, "Create an alert webhook"), h("p", {}, `Each hook has its own secret address and places paper orders on ${paperAcc}.`)),
      h("div", { class: "form-grid" }, h("label", { class: "field", for: "hook-name" }, h("span", {}, "Name"), label), h("label", { class: "field", for: "hook-source" }, h("span", {}, "Source"), source), segField("Side", side), segField("Product", product), segField("Order type", orderType, { wide: true }), h("label", { class: "field", for: "hook-lots" }, h("span", {}, "Max lots per alert"), lots), btn),
      box,
    ),
    listSlot,
  );
  await loadInto(listSlot, async () => (await optional(api("/v1/hooks"))).data?.data ?? [], (data) => ((list = data), listNode()), { rows: 1 });
}

// ── Activity ──

/** The word that goes with each status code on a pill, so the number is never the only signal. */
const statusTone = (n) => (n < 300 ? "ok" : n < 500 ? "warn" : "bad");

async function renderActivity() {
  const root = h("div", { class: "api-tab aa" });
  // #/api/activity?view=audit opens the audit log (the Ctrl K "Audit log" entry).
  let view = hashParams().get("view") === "audit" ? "audit" : "requests";
  const seg = segmented("Log", [["requests", "Requests"], ["audit", "Audit log"]], view);
  const body = h("div", { class: "aa-body" });
  const head = h("div", { class: "aa-head" }, seg);
  root.append(head, body);
  let token = 0;
  seg.addEventListener("change", () => {
    view = seg.value;
    setHashParam("view", view);
    build();
  });

  const build = () => {
    const mine = ++token;
    clearInterval(timer);
    body.replaceChildren();
    return (view === "audit" ? auditView(mine) : requestsView(mine)).catch((err) => {
      if (mine === token) body.replaceChildren(errorPanel(err, build));
    });
  };

  async function requestsView(mine) {
    let all = [];
    let q = "";
    let status = "all";
    let showAll = false;
    const hideOwn = h("input", { type: "checkbox", role: "switch", id: "aa-hide-own" });
    hideOwn.checked = local.get(HIDE_OWN_SLOT) !== "0";
    const search = h("input", { type: "search", id: "aa-search", placeholder: "Filter by path, method, status or key", "aria-label": "Filter requests", autocomplete: "off", spellcheck: "false" });
    const clear = h("button", { type: "button", class: "clear", "aria-label": "Clear the filter", onclick: () => ((search.value = ""), (q = ""), drawList(), search.focus()) }, icon("close"));
    const chips = h("div", { class: "aa-chips", role: "group", "aria-label": "Status" });
    const chipN = {};
    for (const [id, text] of [["all", "All"], ["ok", "Succeeded"], ["err", "Errors"]]) {
      chipN[id] = h("span", { class: "aa-n" }, "0");
      chips.append(h("button", { type: "button", class: "chip-btn", "data-status": id, "aria-pressed": String(id === "all"), onclick: () => ((status = id), draw()) }, `${text} `, chipN[id]));
    }
    const listBox = h("div", { class: "aa-results" });
    const draw = () => {
      const base = all.filter((x) => !hideOwn.checked || x.client !== "dashboard");
      const ok = base.filter((x) => x.status < 400).length;
      chipN.all.textContent = formatInt(base.length);
      chipN.ok.textContent = formatInt(ok);
      chipN.err.textContent = formatInt(base.length - ok);
      for (const b of chips.children) b.setAttribute("aria-pressed", String(b.dataset.status === status));
      drawList(base);
    };
    const drawList = (given) => {
      const base = given ?? all.filter((x) => !hideOwn.checked || x.client !== "dashboard");
      const needle = q.trim().toLowerCase();
      const rows = base.filter((x) => (status === "all" || (status === "ok" ? x.status < 400 : x.status >= 400)) && (!needle || `${x.method} ${x.path} ${x.status} ${x.keyId ?? ""}`.toLowerCase().includes(needle)));
      const shown = rows.slice(0, showAll ? 200 : 50);
      if (!shown.length) {
        listBox.replaceChildren(
          h("div", { class: "list" }, base.length ? emptyState("search", "No requests match", "Change the filter or the status to see more.", nextStep("Clear filters", () => ((q = ""), (status = "all"), (search.value = ""), draw()), "small")) : emptyState("activity", "No requests yet", hideOwn.checked ? "Requests from your scripts, charts, Excel and AI tools appear here. Turn off the switch to see the dashboard's own." : "Requests appear here as they arrive.", nextStep("Make a call in the test console", "#/api/console"))),
        );
        return;
      }
      listBox.replaceChildren(
        h(
          "ul",
          { class: "list aa-log", "aria-label": "Requests, newest first" },
          shown.map((x) =>
            h(
              "li",
              { class: "aa-row" },
              h("span", { class: "aa-time" }, istTime(x.at)),
              h("span", { class: `method aa-method m-${x.method}` }, x.method),
              h("span", { class: "aa-path mono", title: x.path }, x.path),
              h("span", { class: "aa-status" }, pill(String(x.status), statusTone(x.status))),
              h("span", { class: "aa-ms" }, `${formatInt(x.ms)} ms`),
              h("span", { class: "aa-key mono" }, x.keyId ?? "no key"),
            ),
          ),
        ),
        h("p", { class: "aa-foot" }, `Showing ${formatInt(shown.length)} of ${formatInt(rows.length)}${rows.length > shown.length ? "." : ""}`, rows.length > shown.length ? h("button", { type: "button", class: "small plain", onclick: () => ((showAll = true), drawList()) }, "Show up to 200") : null, h("span", { class: "aa-fine" }, "Kept in memory only: the last 200 requests. Paths only, never query strings, bodies or keys.")),
      );
    };
    search.addEventListener("input", () => ((q = search.value), drawList()));
    hideOwn.addEventListener("change", () => (local.set(HIDE_OWN_SLOT, hideOwn.checked ? null : "0"), draw()));
    body.replaceChildren(h("div", { class: "aa-bar" }, h("div", { class: "search-field aa-search" }, searchIcon(), search, clear), chips, h("label", { class: "aa-own", for: "aa-hide-own" }, h("span", {}, "Hide the dashboard's own requests"), h("span", { class: "switch" }, hideOwn, h("i")))), listBox);
    const refresh = async () => {
      const r = await api("/v1/requests?limit=200");
      if (mine !== token) return;
      all = r.data.data ?? [];
      draw();
    };
    listBox.replaceChildren(apiSkeleton(4));
    await refresh();
    every(4000, refresh);
  }

  async function auditView(mine) {
    let rows = [];
    let q = "";
    const search = h("input", { type: "search", id: "aa-audit-search", placeholder: "Filter by event, who, account or details", "aria-label": "Filter the audit log", autocomplete: "off", spellcheck: "false" });
    const clear = h("button", { type: "button", class: "clear", "aria-label": "Clear the filter", onclick: () => ((search.value = ""), (q = ""), drawList(), search.focus()) }, icon("close"));
    const verifyBtn = h("button", { type: "button", class: "small tinted" }, icon("safety"), "Verify the chain");
    const result = h("div", { class: "aa-verify", role: "status" });
    const listBox = h("div", { class: "aa-results" });
    verifyBtn.addEventListener("click", async () => {
      busy(verifyBtn, true);
      try {
        const d = (await api("/v1/audit/verify")).data.data ?? {};
        result.replaceChildren(d.ok ? alertBox({ title: `The chain is intact (${formatInt(d.checked)} records)`, detail: "No record was changed or removed." }, "ok") : alertBox({ title: `The chain is broken at ${d.brokenAt}`, detail: "A record was changed or removed after it was written. Keep the audit files and investigate before trusting this log." }));
      } catch (err) {
        result.replaceChildren(alertBox(err));
      } finally {
        busy(verifyBtn, false);
      }
    });
    const drawList = () => {
      const needle = q.trim().toLowerCase();
      const shown = rows.filter((x) => !needle || `${x.type} ${x.actor?.kind}:${x.actor?.id} ${x.source} ${x.accountId ?? ""} ${JSON.stringify(x.data ?? {})}`.toLowerCase().includes(needle));
      if (!shown.length) {
        listBox.replaceChildren(h("div", { class: "list" }, rows.length ? emptyState("search", "No records match", "Change the filter to see more.", nextStep("Clear the filter", () => ((search.value = ""), (q = ""), drawList()), "small")) : emptyState("activity", "The audit log is empty today", "Key changes, orders, kill-switch actions and webhook events are recorded here.")));
        return;
      }
      listBox.replaceChildren(
        h(
          "div",
          { class: "list aa-audit" },
          shown.map((x) =>
            h(
              "details",
              { class: "list-row static aa-rec" },
              h("summary", {}, h("span", { class: "aa-seq" }, `#${formatInt(x.seq)}`), h("strong", { class: "aa-event" }, x.type), h("span", { class: "aa-when" }, istDateTime(x.at)), h("span", { class: "aa-who" }, `${x.actor?.kind ?? ""}${x.actor?.id ? `:${x.actor.id}` : ""}`, x.accountId ? ` · ${x.accountId}` : "")),
              h("div", { class: "aa-rec-body" }, h("dl", { class: "kv" }, h("dt", {}, "Source"), h("dd", {}, x.source ?? DASH), h("dt", {}, "Hash"), h("dd", {}, String(x.hash ?? "").slice(0, 16) || DASH)), h("pre", { class: "snip-code" }, JSON.stringify(x.data ?? {}, null, 2))),
            ),
          ),
        ),
        h("p", { class: "aa-foot" }, `Showing ${formatInt(shown.length)} of ${formatInt(rows.length)} records.`, h("span", { class: "aa-fine" }, "Append-only and hash-chained, one file per IST day in data/audit/. Secrets are redacted.")),
      );
    };
    search.addEventListener("input", () => ((q = search.value), drawList()));
    body.replaceChildren(h("div", { class: "aa-bar" }, h("div", { class: "search-field aa-search" }, searchIcon(), search, clear), verifyBtn), result, listBox);
    listBox.replaceChildren(apiSkeleton(4));
    const refresh = async () => {
      const r = await api("/v1/audit?limit=100");
      if (mine !== token) return;
      const next = r.data.data ?? [];
      // Redraw only when a record arrived, so a record the person opened stays open.
      if (rows.length && next.length === rows.length && next[0]?.seq === rows[0]?.seq) return;
      rows = next;
      drawList();
    };
    await refresh();
    every(8000, refresh);
  }

  build();
  return root;
}
