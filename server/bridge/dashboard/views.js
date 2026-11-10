// Dashboard pages. Each page renders into #content from live Bridge data; nothing here stores data outside this tab
// except small conveniences in localStorage (theme, density, the last tab of each page).
import { alertBox, api, app, brokerMatches, card, codeBlock, confirmCodeNotice, copyButton, currentKey, emptyState, fillLoginUrl, h, highlightJson, icon, iconTile, istDateTime, istTime, loginBody, loginFormSpec, modal, optional, pill, table, ticketFields, toast, sheetPopover, DEMO_EXPLAINER, beginNavigation, onRevalidated, pageSkeleton, prefetchPage, whenIdle } from "./app.js";
import { STATE_TEXT, STATE_TONE, engageKillSwitch, heroModel, killBanner, limitsModel, liveConditions, loadReadiness, onReadiness, readinessSection, refreshReadiness, releaseKillSwitch } from "./readiness.js";
import { DASH, formatFixed, formatInt, formatRupeeGrouped, formatSignedRupee, guideUrl, isFigure, plural } from "./format.js";
import { DENSITY_SLOT, parseDensity } from "./layout-prefs.js";
import { mountBudget } from "./budget.js";
import { exposeCard } from "./expose-card.js";
import { backupSection } from "./backup-card.js";
import { driftSection } from "./drift-card.js";
import "./sources-ui.js";
import { onReconnected } from "./connection.js";
import { createGetStarted } from "./getstarted.js";
import { createTelegramCard } from "./telegram-card.js";
import { keyStepLink } from "./getstarted-core.js";
import { morningLoginButton } from "./morning.js";
import { ladderSummary, levelCounts, levelOf, levelRank, levelText, levelTone } from "./morning-core.js";
import * as live from "./live.js";
import { KEY_PRESETS, countsLine, finalHookUrl, outcomeView, presetKeyBody, silentHint, snippets } from "./snippets.js";
import { KEY_USES, afterDemoSaveSteps, brokerSetupSteps, capabilityLabel, contractName, capabilitySummary, clearFieldError, defaultKeyName, fieldError, keyFormProblem, keyUse, modifyChange } from "./flows.js";
import { initPalette, kbd, openPalette, pageShortcut, searchIcon, shortcut } from "./palette.js";
import { configureOrdersBook, fundsSection, ordersBook, pendingSection, renderTradesPage, sidePill } from "./orders-book.js";
import { animatePage, installPullToRefresh, navigationHint, pageLeave, setAttr, trackSelection } from "./motion.js";
import { getMode, markMode, onMode, pageShown, setMode, tabsShown } from "./easy-core.js";
import { watchGlossary } from "./glossary.js";
import { helpRow, openHelp, toolbarHelp } from "./help.js";
import { configureConnect, renderConnect, simpleSourcesNote } from "./connect.js";
import { configureDevelopers, renderDevelopers } from "./developers.js";

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
  // The thumb is a real element that motion.js moves with springs (translate and width): a tap, a key or `.value =` retargets
  // it with the velocity it has, and on touch it can be dragged. The button's own background is the look until it is
  // measured (not in the document yet, or a hidden panel); a ResizeObserver re-measures without animating.
  const thumb = h("i", { class: "seg-thumb", "aria-hidden": "true" });
  const selection = trackSelection(el, {
    indicator: thumb,
    items: () => buttons,
    current: () => buttons.find((x) => x.dataset.value === value),
    placedClass: "has-thumb",
    drag: {
      onCommit: (b) => b.dataset.value !== value && pick(b.dataset.value, false),
      onPeek: (b) => {
        for (const x of buttons) setAttr(x, "data-peek", x === b);
      },
    },
  });
  el.classList.add("seg-drag");
  const pick = (v, focus) => {
    value = v;
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute("aria-pressed", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    selection.update();
    el.dispatchEvent(new Event("change"));
  };
  el.addEventListener("keydown", (e) => {
    const i = buttons.findIndex((b) => b.dataset.value === value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    pick(buttons[(i + step + buttons.length) % buttons.length].dataset.value, true);
  });
  el.append(thumb, ...buttons);
  edgeFades(el);
  Object.defineProperty(el, "value", { get: () => value, set: (v) => pick(String(v), false) });
  pick(initial, false);
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
  // The same tabs as last time: keep the buttons (and the sliding thumb under them) and only move the selection, so the
  // thumb glides to the new tab and the strip keeps its scroll position and focus.
  const sig = tabs.map(([id]) => id).join("|");
  let buttons;
  if (bar.dataset.tabs === sig && bar.__selection) {
    buttons = [...bar.querySelectorAll('[role="tab"]')];
    tabs.forEach(([id], i) => {
      const b = buttons[i];
      b.setAttribute("aria-selected", String(id === active));
      b.tabIndex = id === active ? 0 : -1;
      b.onclick = () => onPick(id);
    });
    bar.__selection.update();
  } else {
    buttons = tabs.map(([id, label]) =>
      h("button", { type: "button", role: "tab", id: `${base}-${id}`, "aria-selected": String(id === active), "aria-controls": panel.id, tabindex: id === active ? "0" : "-1", onclick: () => onPick(id) }, label),
    );
    const thumb = h("i", { class: "seg-thumb", "aria-hidden": "true" });
    bar.replaceChildren(thumb, ...buttons);
    bar.dataset.tabs = sig;
    bar.__selection?.destroy();
    bar.__selection = trackSelection(bar, { indicator: thumb, items: () => buttons, current: () => bar.querySelector('[role="tab"][aria-selected="true"]'), placedClass: "has-thumb" });
    bar.__selection.update();
  }
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

// ── Pages ──

/** The Integrations tab's tools (its inner segmented control; each is also a Ctrl K destination). */
const INTEGRATION_TOOLS = [
  ["webhooks", "Alert webhooks"],
  ["python", "Python"],
  ["node", "Node"],
  ["excel", "Excel and Sheets"],
  ["amibroker", "AmiBroker"],
  ["telegram", "Telegram"],
  ["claude", "Claude (MCP)"],
  ["chatgpt", "ChatGPT / OpenAI"],
  ["rest", "REST / curl"],
];

/**
 * The one list of pages: it feeds the sidebar, the phone tab bar, the More sheet and the Ctrl K palette
 * `group` is the sidebar group, `tint` an iOS system
 * colour name (the page's glyph colour everywhere), `key` the Ctrl 1 to Ctrl 4 shortcut (one per page), `tab: true` puts it in the
 * phone tab bar (`short` labels it there),  `headline` is the large title when it differs from `title`. A page with `tabs` is one page with a tab strip: each tab names the page id it renders as (`page`, the
 * `:root[data-page]` value that scopes its CSS and the id older links used), may set its own `sub`, and `command` is its
 * Ctrl K label; `extras` are further Ctrl K destinations inside it.
 */
export const PAGES = [
  { id: "accounts", label: "Accounts", icon: "accounts", tint: "indigo", tab: true, key: 1, group: "Bridge", title: "Accounts and brokers", sub: "Broker accounts, sessions and the 41 supported brokers", render: renderAccounts },
  { id: "connect", label: "Connect a tool", icon: "plug", tint: "green", key: 6, group: "Bridge", keywords: "excel sheets spreadsheet claude chatgpt ai assistant python node script amibroker app key setup integration", title: "Connect a tool", sub: "Give Excel, an AI assistant or a script its own key, with the setup ready to copy", render: renderConnect },
  { id: "developers", advanced: true, label: "Developers", icon: "console", tint: "purple", key: 7, group: "Bridge", keywords: "developer api key app scope quota snippet curl python node sdk starter openapi errors error codes requests log webhook events order events subscription receiver signed", title: "Developers", sub: "Your first call, the key each job needs, your requests live, and every error explained", render: renderDevelopers },
  // Sources has a place in the phone tab bar and API (set up once, used at a desk) moves to More: whether the data is
  // flowing is the question people open the Bridge on a phone to ask, a key is made once.
  {
    id: "sources", label: "Sources", icon: "sources", tint: "teal", tab: true, key: 5, group: "Bridge", title: "Sources", sub: "Where your data comes from, how much room is left, and why a request went where it did",
    defaultTab: "overview",
    simpleTab: "providers",
    tabs: [
      {
        id: "overview", advanced: true, label: "Overview", page: "sources", sub: "How much room your brokers and sources have, and why requests go where they do", command: "Sources and rate limits", icon: "sources", tint: "teal", keywords: "sources limits rate limits budget usage room health forecast throttle pooled requests recent", render: renderSourcesOverview,
        extras: [{ id: "trace", label: "Why this source?", route: "sources/overview?trace=1", keywords: "route trace explain source why which broker answered", sub: "Sources › Overview › Route trace" }],
      },
      { id: "providers", label: "Providers", page: "providers", sub: "Your brokers and the free and key-based sources you can turn on", command: "Data providers", icon: "sources", tint: "teal", keywords: "providers free sources key yahoo delayed pooling brokers terms notice switch", render: renderSourcesProviders },
      { id: "quotas", advanced: true, label: "Quotas", page: "quotas", sub: "How much each API key and tool may ask for", command: "Key quotas", icon: "limits", tint: "purple", keywords: "quota quotas key tool throttle per second burst weight fair share", render: renderSourcesQuotas },
    ],
  },
  {
    id: "data", label: "Data", icon: "download", tint: "blue", group: "Bridge", title: "Data", sub: "Save history, record what brokers do not keep, and keep it all tidy",
    defaultTab: "downloads",
    tabs: [
      { id: "downloads", label: "Downloads", page: "data", sub: "Save history for your symbols as files, without slowing live prices", command: "Data downloads", icon: "download", tint: "blue", keywords: "data downloads history download csv bars candles save export amibroker wizard", render: dataTab("renderDownloads") },
      { id: "recordings", label: "Recordings", page: "data-recordings", sub: "Record option chains and prices by yourself every trading day", command: "Data recordings", icon: "activity", tint: "red", keywords: "recordings record auto record option chain rules schedule market hours disk", render: dataTab("renderRecordings") },
      { id: "datasets", label: "Datasets", page: "data-datasets", sub: "Histories you keep up to date, fetching only what is new", command: "Datasets", icon: "list", tint: "indigo", keywords: "datasets update incremental tags history", render: dataTab("renderDatasets") },
      { id: "collections", label: "Collections", page: "data-collections", sub: "Named lists of symbols and option universes that everything can reuse", command: "Collections", icon: "inbox", tint: "teal", keywords: "collections watchlist option universe strikes expiry atm tags import export symbols list", render: dataTab("renderCollections") },
    ],
  },
  {
    id: "api", advanced: true, label: "API", icon: "keys", tint: "pink", key: 2, group: "Bridge", title: "API", sub: "Keys, integrations, a test console and the request log",
    defaultTab: "keys",
    tabs: [
      { id: "keys", label: "Keys", page: "keys", sub: "One key per tool, with only the access it needs", command: "API keys", keywords: "keys token access create revoke", render: renderKeys },
      {
        id: "integrations", label: "Integrations", page: "integrations", sub: "Connect Excel, a script, an AI assistant or a webhook", command: "Integrations", icon: "integrations", tint: "blue", keywords: "integrations snippets connect tools sdk", render: renderIntegrations,
        extras: INTEGRATION_TOOLS.map(([id, label]) => ({ id, label: id === "webhooks" ? "Alert webhooks (TradingView, ChartInk)" : `${label} snippet`, route: `api/integrations?tool=${id}`, keywords: id === "webhooks" ? "webhook alert alerts incoming tradingview chartink gocharting hooks" : `${id} snippet setup code`, sub: `API › Integrations › ${label}` })),
      },
      { id: "console", label: "Test console", page: "console", sub: "Try any call and see what a script would get back", command: "Test console", icon: "console", tint: "teal", keywords: "console try request call endpoint", render: renderConsole },
      {
        id: "activity", label: "Activity", page: "activity", sub: "Every request the Bridge handled, and its audit log", command: "Activity", icon: "activity", tint: "gray", keywords: "activity requests log", render: renderActivity,
        extras: [{ id: "audit", label: "Audit log", route: "api/activity?view=audit", keywords: "audit log hash chain tamper", sub: "API › Activity › Audit log" }],
      },
    ],
  },
  {
    id: "orders", label: "Orders", icon: "orders", tint: "orange", tab: true, key: 3, group: "Trade", title: "Orders", sub: "Paper by default. Pending confirmations wait here",
    defaultTab: "book",
    tabs: [
      { id: "book", label: "Orders", page: "orders", command: "Orders", keywords: "orders confirmations tickets modify cancel paper", render: renderOrders },
      { id: "trades", label: "Trades", page: "trades", command: "Trade book", icon: "list", tint: "orange", keywords: "trades trade book fills executions turnover charges csv", sub: "Every fill with buy, sell and turnover totals", render: renderTradesPage },
    ],
  },
  { id: "safety", label: "Safety", icon: "safety", tint: "red", tab: true, key: 4, group: "Trade", title: "Safety", sub: "Kill switch, daily limits and live-trading status", render: renderSafety },
];

/** Old page ids that became tabs: an old link or bookmark opens the tab, keeping its ?query. */
export const LEGACY = {
  console: "api/console",
  limits: "sources/overview",
  keys: "api/keys",
  integrations: "api/integrations",
  activity: "api/activity",
};

/** Old `page/tab` addresses of a tab that moved to another page. */
export const LEGACY_PATHS = {
  "api/limits": "sources/overview",
};

/**
 * Where a hash leads (pure): { page, tab, query, redirect, view }. `#/<page>/<tab>?query`; a LEGACY id is
 * rewritten (`redirect` is the hash to put in its place; Integrations' old `?tab=` becomes `?tool=`); an unknown page
 * is the first page, an unknown or missing tab the page's last tab (`lastTab(pageId)`) or its default. `view` is the legacy page
 * id the view renders as (the `data-page` value).
 */
export function resolveRoute(hash, { pages = PAGES, lastTab = () => null, mode = "advanced" } = {}) {
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
  // A tab that moved to another page (API › Rate limits is now Sources › Overview) keeps its old address working.
  if (Object.hasOwn(LEGACY_PATHS, path)) {
    path = LEGACY_PATHS[path];
    redirect = `#/${path}${query ? `?${query}` : ""}`;
  }
  const [pageId, tabId] = path.split("/");
  const page = pages.find((p) => p.id === pageId) ?? pages[0];
  // A page that does not exist shows the first page under its own address, not under the stale one.
  if (pageId && !pages.some((p) => p.id === pageId)) redirect = `#/${pages[0].id}`;
  let tab = null;
  if (page.tabs?.length) {
    const find = (id) => (id ? page.tabs.find((t) => t.id === id) : undefined);
    // Simple opens a page that has a plain tab on that tab, whatever tab Advanced last showed; a named tab is always honoured.
    tab = find(tabId) ?? (mode === "simple" ? find(page.simpleTab) : undefined) ?? find(lastTab(page.id)) ?? find(page.defaultTab) ?? page.tabs[0];
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
  const navEl = $("nav");
  const shown = PAGES.filter((p) => pageShown(p, getMode(), active));
  const sig = shown.map((p) => p.id).join("|");
  // Built once: later routes only move aria-current and the indicator (the nodes persist, so the selection can slide and
  // the ticket count and focus are never rebuilt).
  if (navEl.dataset.pages === sig && navEl.__selection) {
    for (const a of navEl.querySelectorAll("a[data-page]")) setAttr(a, "aria-current", a.dataset.page === active ? "page" : null);
    navEl.__selection.update();
    tabbar(active);
    return;
  }
  const out = [];
  let group = null;
  for (const p of shown) {
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
  const ind = h("i", { class: "nav-ind", "aria-hidden": "true" });
  navEl.replaceChildren(ind, ...out);
  navEl.dataset.pages = sig;
  navEl.classList.add("has-ind");
  navEl.__selection?.destroy();
  navEl.__selection = trackSelection(navEl, { indicator: ind, items: () => [...navEl.querySelectorAll("a[data-page]")], current: () => navEl.querySelector('a[aria-current="page"]'), axes: "xy" });
  navEl.__selection.update();
  edgeFades(navEl, "y");
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
  bar.dataset.active = active;
  const sig = inTabs.map((p) => p.id).join("|");
  // Built once; a route only moves aria-current and the pill under the tabs.
  if (bar.dataset.pages === sig && bar.__selection) {
    for (const a of bar.querySelectorAll("a[data-page]")) setAttr(a, "aria-current", a.dataset.page === active ? "page" : null);
    setAttr(bar.querySelector("button.tab"), "aria-current", moreActive ? "page" : null);
    bar.__selection.update();
    return;
  }
  const ind = h("i", { class: "tab-ind", "aria-hidden": "true" });
  bar.replaceChildren(
    ind,
    ...inTabs.map((p) =>
      h(
        "a",
        { href: `#/${p.id}`, class: "tab", "data-page": p.id, "aria-current": p.id === active ? "page" : undefined },
        icon(p.icon),
        h("span", {}, p.short ?? p.label),
        p.id === "orders" ? h("span", { class: "count", "data-tickets": "", hidden: true }) : null,
      ),
    ),
    h("button", { type: "button", class: "tab", "aria-haspopup": "dialog", "aria-current": moreActive ? "page" : undefined, onclick: () => moreSheet(bar.dataset.active) }, icon("more"), h("span", {}, "More")),
  );
  bar.dataset.pages = sig;
  bar.classList.add("has-ind");
  bar.__selection?.destroy();
  bar.__selection = trackSelection(bar, { indicator: ind, items: () => [...bar.querySelectorAll(".tab")], current: () => bar.querySelector('.tab[aria-current="page"]'), axes: "xy" });
  bar.__selection.update();
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
  const pages = PAGES.filter((p) => !p.tab && pageShown(p, getMode(), active));
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
        h("section", { class: "group" }, h("div", { class: "list" }, helpRow(() => { close(undefined); setTimeout(() => openHelp(null), 260); }))),
        h("section", { class: "group" }, h("h3", { class: "group-title", id: "more-view" }, "View"), viewControl("more-view"), h("p", { class: "group-foot" }, "Advanced adds Developers (events, apps, errors), API keys, the test console, Activity and Quotas.")),
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
    h("div", { class: "acct-pop-head" }, iconTile("user", "indigo", "lg"), h("div", { class: "names" }, h("strong", {}, "Signed in"), h("span", { class: "sub" }, app.state.who ?? ""))),
    h("section", { class: "group" }, h("h3", { class: "group-title", id: "acct-view" }, "View"), viewControl("acct-view"), h("p", { class: "group-foot" }, "Simple shows the essentials. Advanced adds Developers (events, apps, errors), API keys, the test console, Activity and Quotas.")),
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
/** Simple / Advanced: the one view setting (easy-core.js). Nothing is removed in Simple; the menu only lists fewer pages. */
function viewControl(labelledBy) {
  const seg = segmented("View", [["simple", "Simple"], ["advanced", "Advanced"]], getMode());
  seg.removeAttribute("aria-label");
  seg.setAttribute("aria-labelledby", labelledBy);
  seg.addEventListener("change", () => setMode(seg.value));
  return seg;
}
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
  const route = resolveRoute(location.hash, { lastTab: readLastTab, mode: getMode() });
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
  // A redraw replaces the page's controls (the tab strip too): remember which one had focus, put it back when it is done.
  const focusId = root.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : null;
  // Its first reads may paint from what the dashboard already has (app.js api), then refresh behind it.
  if (!reload) beginNavigation(route.view);
  redrawnFor = reload ? seq : 0;
  // A tabbed page: the tab strip is the first row of the page; only the chosen tab renders (and refreshes).
  const tabs = tab ? pageTabs(page, tab) : null;
  // #content names itself by the page; the tab panel is the part below the tab strip (pageTabs), never the strip's own parent.
  root.removeAttribute("role");
  root.setAttribute("aria-labelledby", "page-title");
  root.setAttribute("aria-busy", "true");
  // Navigating (not reloading): the old page fades out in 90 ms (sub-tabs slide along X), then the new one starts.
  const way = travel(page, tab);
  if (changed && !reload) {
    navigationHint(way);
    await pageLeave(root, way);
    if (seq !== renderSeq) return;
  }
  setPage(root, tabs, pageSkeleton());
  if (tabs) edgeFades(tabs.firstElementChild);
  try {
    const nodes = await (tab?.render ?? page.render)();
    if (seq !== renderSeq) return;
    setPage(root, tabs, nodes);
    fitTables(root);
  } catch (err) {
    if (seq !== renderSeq) return;
    setPage(root, tabs, alertBox(err));
  }
  root.removeAttribute("aria-busy");
  if (tabs) revealActiveTab(tabs.firstElementChild);
  const title = tab ?`${page.title}: ${tab.label}` : page.title;
  announce(changed ? `${title} page` : `${title} refreshed`);
  if (pendingFocus) {
    const target = pendingFocus === true ? null : root.querySelector(pendingFocus);
    pendingFocus = null;
    (target ?? root).focus({ preventScroll: !target });
  } else if (focusId && (!document.activeElement || document.activeElement === document.body)) {
    document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  if (changed) window.scrollTo({ top: 0 });
  animatePage(root);
  refreshTicketCount();
  flushFirstPage();
}

// ── Work that waits for the first page ──
// The live connection (and with it the budget chip) is not part of the first screen. It starts when the first page is
// drawn and the browser is idle, or after FIRST_PAGE_MAX_MS whatever happens (a page that never finishes must not
// leave the chip out for good).
const FIRST_PAGE_MAX_MS = 6000;
let firstPageDrawn = false;
const afterFirst = [];
/** Run `fn` once the first page is drawn and the browser is idle (at once, when it already is). */
function afterFirstPage(fn) {
  if (firstPageDrawn) whenIdle(fn);
  else {
    if (!afterFirst.length) setTimeout(flushFirstPage, FIRST_PAGE_MAX_MS);
    afterFirst.push(fn);
  }
}
function flushFirstPage() {
  firstPageDrawn = true;
  for (const fn of afterFirst.splice(0)) whenIdle(fn);
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
 * to `#/<page>/<tab>` (the hash is the state), so back and forward walk the tabs. The tab panel is the block under the strip
 * (kept on the returned row as `__panel`), so the tab list is not inside the panel it controls.
 */
function pageTabs(page, tab) {
  const shown = tabsShown(page, getMode(), tab.id);
  if (shown.length < 2) return null;
  // Moving between the tabs of one page keeps the strip: its buttons, its scroll position and the thumb that slides under it.
  const kept = document.getElementById(`page-tabs-${page.id}`);
  const bar = kept?.__selection && kept.parentElement?.classList.contains("page-tabs-row") ? kept : h("div", { class: "segmented page-tabs", role: "tablist", id: `page-tabs-${page.id}`, "aria-label": `${page.label} sections` });
  const panel = (bar === kept && kept.parentElement?.__panel) || h("div", { class: "tab-panel", id: `page-panel-${page.id}` });
  drawTabs(bar, panel, shown.map((t) => [t.id, t.label]), tab.id, (id) => go(`${page.id}/${id}`, `#page-tabs-${page.id}-${id}`));
  // A full-width row of its own (pages that lay their panels out in a wrapping row stretch every child).
  const row = bar.parentElement?.classList.contains("page-tabs-row") ? bar.parentElement : h("div", { class: "page-tabs-row" }, bar);
  row.__panel = panel;
  return row;
}

/**
 * Put a page's nodes into #content. When the tab strip is already there (a tab of the same page) only what follows it is
 * replaced, so the strip is never torn down: its scroll position, focus and sliding thumb survive.
 */
function setPage(root, tabs, nodes) {
  const rest = [nodes].flat().filter(Boolean);
  if (!tabs) return root.replaceChildren(...rest);
  const panel = tabs.__panel;
  panel.replaceChildren(...rest);
  if (tabs.parentNode === root) {
    for (const c of [...root.childNodes]) if (c !== tabs && c !== panel) c.remove();
    if (panel.parentNode !== root) root.append(panel);
  } else root.replaceChildren(tabs, panel);
}

/** Which way a tab change travels, for the shared-axis slide: by the index of the tab among its page's tabs. */
let lastPlace = null;
function travel(page, tab) {
  const here = { page: page.id, index: tab ? page.tabs.findIndex((t) => t.id === tab.id) : -1 };
  const prev = lastPlace;
  lastPlace = here;
  if (prev && prev.page === here.page && tab && prev.index >= 0 && prev.index !== here.index) return { axis: "x", dir: here.index > prev.index ? 1 : -1 };
  return {};
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
    ...toolbarHelp(),
    h("button", { type: "button", class: "icon-btn toolbar-search-m", "aria-label": "Search pages and actions", title: `Search pages and actions (${kc.label})`, "aria-keyshortcuts": kc.aria, onclick: () => openPalette() }, searchIcon()),
    h("button", { type: "button", class: "icon-btn", title: "Reload this page's data", "aria-label": "Reload this page's data", onclick: () => show({ refresh: true }) }, icon("refresh")),
  );
  watchTitleCollapse();
  // The API budget indicator (budget.js), fed by the shared live connection.
  const budgetSlot = $("toolbar-budget");
  if (budgetSlot && !budgetSlot.dataset.ready) {
    budgetSlot.dataset.ready = "1";
    // Not needed for the first screen: it opens the live connection, so it waits until the first page is drawn.
    afterFirstPage(() => mountBudget(budgetSlot, live));
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
    sb.setAttribute("aria-keyshortcuts", kc.aria);
    sb.prepend(searchIcon());
    sb.append(kbd(...kc.keys));
    // The name starts with what is written on the button (voice control says it), then says what it opens.
    sb.setAttribute("aria-label", `${sb.textContent.replace(/\s+/g, " ").trim()}: pages and actions`);
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

/** Panels used to be draggable, with the order kept per page. That feature is gone: forget what it stored. */
function forgetOldPanelLayouts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("mcb.dashboard.layout.")) localStorage.removeItem(k);
  } catch {
    /* storage blocked: nothing was stored */
  }
}

export async function startRouter() {
  forgetOldPanelLayouts();
  markMode();
  setupA11y();
  setupChrome();
  // Plain words: a "?" after the first use of each technical word on a page (glossary.js).
  watchGlossary($("content"));
  // Switching between Simple and Advanced redraws the menu and the page.
  onMode(() => {
    nav(document.documentElement.dataset.route);
    show({ refresh: true });
  });
  initPalette({ pages: () => PAGES, go, refresh: () => show({ refresh: true }) });
  // Pull to refresh on touch screens: the same reload as the toolbar button, except on Sources and limits, which already
  // updates live (a pull there would be a second way to do the same thing).
  const ptr = h("div", { class: "ptr", "aria-hidden": "true" }, icon("refresh"), h("span", { class: "ptr-lbl" }, "Refreshing…"));
  document.body.append(ptr);
  installPullToRefresh({
    target: $("content"),
    indicator: ptr,
    refresh: () => show({ refresh: true }),
    enabled: () => !String(shownPage ?? "").startsWith("sources") && matchMedia("(max-width: 1023px)").matches,
    onDone: () => announce("Updated"),
  });
  window.addEventListener("hashchange", show);
  // The Bridge came back after a restart or a dropped connection: redraw this page with fresh data, no reload needed.
  onReconnected(() => show({ refresh: true }));
  show();
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
      ? { text: "Reset funds", aria: `Reset funds for ${a.label}, or add paper money`, cls: "small", run: () => paperResetSheet(a) }
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
  const sub = b.paper ? "Practice with simulated orders, no broker" : `${AUTH_KIND_LABEL[b.authKind] ?? b.authKind} · ${levelText(b)}`;
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
  const search = searchBox(`Search ${plural(realCount, "broker")}`, "Search brokers", draw);
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
      h("span", { class: "acct-names" }, h("span", { class: "acct-nm" }, b.name), h("span", { class: "acct-sub" }, b.paper ? "Practice with simulated orders" : `${AUTH_KIND_LABEL[b.authKind] ?? b.authKind} · ${levelText(b)}`)),
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
    dirty: () => !busy && [...inputs.values()].some((i) => i.value !== ""),
    title: `Log in to ${a.label}`,
    body: h(
      "div",
      { class: "stack" },
      h("div", { class: "acct-chosen" }, brokerAvatar(broker), h("span", { class: "acct-names" }, h("span", { class: "acct-nm" }, broker.name), h("span", { class: "acct-sub" }, `${AUTH_KIND_LABEL[broker.authKind] ?? broker.authKind} · ${levelText(broker)}`)), pill(st.text, st.tone)),
      h("ol", { class: "acct-help" }, spec.help.map((t) => h("li", {}, t))),
      broker.singleSession ? alertBox({ title: "This login ends your other session", detail: "This broker allows one session per app. Logging in here ends any session you already have open for it, for example in another tool." }, "warn") : null,
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
  const real = realBrokers(list).sort((a, b) => levelRank(b) - levelRank(a));
  const state = { status: "all", kind: null, all: false };
  const grid = h("div", { class: "acct-cat", role: "list", "aria-label": "Supported brokers" });
  const count = h("p", { class: "acct-count", role: "status", "aria-live": "polite" });
  const more = h("button", { type: "button", class: "tinted acct-more-btn", "aria-expanded": "false" });
  const chips = h("div", { class: "acct-filters" });
  const search = searchBox(`Search ${plural(real.length, "broker")}`, "Search brokers", () => draw());
  const kindCount = (k) => real.filter((b) => b.authKind === k).length;

  // The chips are built once; picking one only moves aria-pressed, so keyboard focus stays where it is.
  const chipBtn = (text, n, pick) => h("button", { type: "button", class: "chip-btn", "aria-pressed": "false", onclick: pick }, text, h("span", { class: "acct-chip-n" }, formatInt(n)));
  const statusChips = [["all", "All", real.length], ...levelCounts(real).map((l) => [l.level, l.text, l.n])].map(([v, t, n]) => [v, chipBtn(t, n, () => ((state.status = v), draw()))]);
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
      h("div", { class: "acct-names" }, h("span", { class: "acct-nm" }, b.name, levelOf(b) === "beta" ? null : pill(levelText(b), levelTone(b))), h("span", { class: "acct-sub", title: brokerLine(b) }, brokerLine(b))),
      h("button", { type: "button", class: "small tinted", "aria-label": `${app.state.demo ? "Set up" : "Add"} a ${b.name} account`, onclick: () => ctx.add(b.id) }, app.state.demo ? "Set up" : "Add"),
    );
  function draw() {
    const rows = real.filter((b) => brokerMatches(b, search.input.value) && (state.status === "all" || levelOf(b) === state.status) && (!state.kind || b.authKind === state.kind));
    const filtered = activeFilter();
    const shown = filtered || state.all ? rows : rows.slice(0, CATALOG_FIRST);
    syncChips();
    grid.replaceChildren(...shown.map(tile));
    if (!rows.length) {
      grid.replaceChildren(emptyState("search", "No broker matches", search.input.value.trim() ? `Nothing found for “${search.input.value.trim()}”. Try its short name, like “kite” or “angel”.` : "Nothing fits these filters.", h("button", { type: "button", class: "small", onclick: reset }, "Clear search and filters")));
    }
    count.textContent = filtered ? `${formatInt(rows.length)} of ${plural(real.length, "broker")}` : plural(real.length, "broker");
    const canFold = !filtered && rows.length > CATALOG_FIRST;
    more.hidden = !canFold;
    more.textContent = state.all ? "Show fewer" : `Show all ${plural(rows.length, "broker")}`;
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
    { class: "sec", "aria-labelledby": id, "data-fixed": "" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id }, title), sub ? h("p", {}, sub) : null), actions ? h("div", { class: "sec-acts" }, actions) : null),
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
  const excel = h("button", { type: "button", class: "small quiet acct-xl", "aria-label": "Download Excel workbook", title: "A .xlsx that reads prices and your book from this Bridge with one request per sheet (read-only). More choices under Integrations › Excel and Sheets", onclick: () => import("./workbook.js").then((m) => m.downloadWorkbook()) }, icon("download"), h("span", {}, "Excel workbook"));

  const rows = accs.map((a) => accountRow(a, ctx));
  const needLogin = accs.filter((a) => acctStatus(a).next === "login").length;
  const mine = acctSection(
    "acct-h-accounts",
    "Your accounts",
    null,
    h("div", { class: "row nowrap" }, h("a", { class: "btn small tinted acct-connect", href: "#/connect" }, icon("plug"), "Connect a tool"), morningLoginButton({ accounts: accs, brokers: list, loginSheet }), excel, addBtn(accs.length ? "primary small" : "tinted small")),
    accs.length
      ? h("div", { class: "list acct-list", role: "list", "aria-labelledby": "acct-h-accounts" }, rows)
      : h("div", { class: "card" }, emptyState("accounts", "No accounts yet", "Add your broker to get started: choose it, then log in with its API details. It takes a minute.", addBtn("primary"))),
    accs.length ? h("p", { class: "group-foot" }, `${needLogin ? `${plural(needLogin, "account")} ${needLogin === 1 ? "needs" : "need"} a login. ` : ""}You can add several brokers, and several accounts for one broker. New accounts are paper only.`) : null,
  );

  const catalog = acctSection(
    "acct-h-brokers",
    "Supported brokers",
    `${ladderSummary(list.filter((b) => b.id !== "demo"))}${demo ? " In demo mode, Set up saves a broker for your next normal start." : ""}`,
    null,
    list.length ? brokerCatalog(list, ctx) : h("div", { class: "card" }, h("div", { class: "acct-retry" }, retryBox({ title: "The list of brokers did not load", detail: brokers.error?.message ?? "Try again in a moment." }, "the broker list"))),
  );

  setTimeout(() => fillToday(accs).catch(() => {}), 0);
  // The Get started checklist draws with the page when its answers are quick (so nothing jumps), else when they arrive.
  const gs = createGetStarted({ accounts: accs, keyLink: keyStepLink(resolveRoute), addBroker: () => addAccountFlow(list, { accounts: accs }), every: (fn) => every(5000, fn) });
  await Promise.race([gs.ready, new Promise((r) => setTimeout(r, 800))]);
  return [gs.el, mine, catalog];
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
  const curlBtn = copyButton(curlText, { label: "Copy as curl", toastLabel: "curl copied", cls: "small quiet", ariaLabel: "Copy as curl: this request" });

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
        { class: "card", "aria-label": "Response" },
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
  const form = h("section", { class: "card", "aria-label": "Request" });
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

// ── Sources (sources-page.js, sources-providers.js, quotas-view.js: loaded when the page is opened) ──

async function renderSourcesOverview() {
  const m = await import("./sources-page.js");
  m.configureSources({ segmented });
  return m.renderOverview();
}
async function renderSourcesProviders() {
  const page = (await import("./sources-providers.js")).renderProviders();
  if (getMode() !== "simple") return page;
  // Simple: where your prices come from, in one sentence, above the provider cards.
  return [await simpleSourcesNote(), await page];
}
async function renderSourcesQuotas() {
  const m = await import("./quotas-view.js");
  m.configureQuotas({ segmented });
  return m.renderQuotas();
}

// ── Data (data-page.js, data-core.js: loaded when the page is opened) ──

function dataTab(name) {
  return async () => {
    const m = await import("./data-page.js");
    m.configureData({ segmented });
    return m[name]();
  };
}

// ── Orders ──

import { clockText, createOrderKeys, orderTypeText, placeAgainBody, qtyText, ticketLife } from "./orders-core.js";
configureOrdersBook({ segmented });
configureConnect({ segmented, snippetBlock });
configureDevelopers({ segmented, snippetBlock, every, stop: () => clearInterval(timer), hashParams: () => hashParams(), setHashParam: (k, v) => setHashParam(k, v) });

/** The order a sheet is about, on one line: side, contract, size and type. */
const orderBrief = (o) => h("div", { class: "ob-brief" }, sidePill(o.side), h("div", {}, h("strong", {}, contractName(o.symbol)), h("span", { class: "ob-sub" }, `${qtyText(o)} qty · ${orderTypeText(o.orderType)}${isFigure(o.price) ? ` at ${formatFixed(o.price, 2)}` : ""}`)));

async function renderOrders() {
  const [tickets, orders, accounts, declined] = await Promise.all([optional(api("/v1/tickets")), optional(api("/v1/orders?limit=100")), optional(api("/v1/accounts")), optional(api("/v1/tickets?state=rejected"))]);
  if (accounts.error)
    return card({
      glyph: "orders",
      tint: "orange",
      title: "Orders",
      cls: "ob-orders",
      body: h("div", { class: "stack" }, alertBox(accounts.error), h("div", { class: "row" }, nextStep("Try again", () => show({ refresh: true }), "small"))),
    });
  const accs = accounts.data?.data ?? [];
  const byId = new Map(accs.map((a) => [a.id, a]));
  const send = () => import("./practice.js").then((m) => (m.configurePractice({ segmented }), m.practiceOrderSheet({ onPlaced: () => show({ refresh: true }) })));
  // #/orders?practice=1 (the palette's "Place a paper order") opens the form.
  if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("practice")) {
    history.replaceState(history.state, "", "#/orders");
    setTimeout(send, 0);
  }
  // Paper orders are priced from a data source: the demo, or any connected broker account. Without one the console answers 404.
  const canSend = Boolean(app.state.demo) || accs.some((a) => a.broker !== "paper");

  // What waits for a person, first and unmistakable; then the day's orders; then the money behind them (it fills in
  // as each account answers, so a slow broker never holds the page).
  const pending = pendingSection({
    tickets: tickets.data?.data ?? [],
    declined: declined.data?.data ?? [],
    error: tickets.error ?? null,
    byId,
    review: (t) => confirmTicket(t, byId),
    changed: refreshTicketCount,
    setup: nextStep("Set up an AI assistant", "#/connect?tool=ai", "small"),
    retry: () => show({ refresh: true }),
  });
  const book = ordersBook({ ord: orders.data?.data ?? [], error: orders.error ?? null, byId, actions: orderActions, refresh: () => show(), send, canSend });
  const funds = fundsSection(accs);

  // A ticket or an order that arrives while the page is open shows up without a reload (and the nav count follows).
  every(4000, async () => {
    const [t, o, d] = await Promise.all([optional(api("/v1/tickets", { fresh: true })), optional(api("/v1/orders?limit=100", { fresh: true })), optional(api("/v1/tickets?state=rejected", { fresh: true }))]);
    if (!t.error) pending.update(t.data?.data ?? [], null, d.error ? null : (d.data?.data ?? []));
    if (!o.error) book.update(o.data?.data ?? []);
    refreshTicketCount();
  });
  return [killBanner(), pending.el, book.el, funds];
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
        orderBrief(o),
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
    const left = (o.quantity ?? 0) - (o.filledQuantity ?? 0);
    const ok = await modal({
      title: `Cancel ${o.side === "BUY" ? "buy" : "sell"} ${name}?`,
      body: h("div", { class: "stack" }, orderBrief(o), h("p", {}, `The unfilled part (${formatInt(left)} qty) is withdrawn. What already filled stays in Positions.`), err),
      buttons: [
        { label: "Keep it", value: false },
        {
          label: "Cancel order",
          cls: "destructive",
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
    // One key for this Undo: pressing it twice, or again after a lost answer, can never place two orders. The button is
    // off while the order is going out and stays off once it was placed.
    const keys = createOrderKeys();
    const again = async (ev) => {
      const button = ev?.currentTarget;
      if (button?.disabled) return;
      if (button) button.disabled = true;
      const body = placeAgainBody(o, left);
      const r = await optional(api("/v1/orders", { method: "POST", body, idempotencyKey: keys.keyFor(body) }));
      if (r.error) {
        if (button) button.disabled = false;
        return toast(`Could not place ${name} again: ${r.error.message ?? "refused"}`, { tone: "error" });
      }
      const placed = r.data?.data ?? {};
      show().then(() => toast(placed.status === "rejected" ? `Placed again but rejected: ${placed.statusMessage ?? "no reason given"}` : `${name} placed again`, { tone: placed.status === "rejected" ? "warn" : "ok" }));
    };
    const canUndo = o.mode === "paper" && left > 0;
    show().then(() => toast(canUndo ? h("span", { class: "toast-undo-row" }, `Cancelled ${name} · `, h("button", { type: "button", class: "toast-undo", onclick: again }, "Undo")) : `Cancelled ${name}`));
  };
  return { modify, cancel };
}

/**
 * The confirmation sheet for a pending ticket: the order in one line, every field again, the time left, and (for a
 * live order) a box to tick before the button works. Confirming lets the client that prepared it send exactly this
 * order, once; a single-use code is then shown for it.
 */
async function confirmTicket(t, byId) {
  const o = t.order ?? {};
  const live = o.mode === "live";
  const fields = ticketFields(t, byId);
  const left = h("p", { class: "ob-sub ob-left", role: "timer" });
  const sure = live ? h("input", { type: "checkbox", id: "confirm-live" }) : null;
  let go = null;
  const paint = () => {
    const life = ticketLife(t);
    left.textContent = life.known ? (life.over ? "This request has expired. Close this and ask the client to prepare it again." : `Expires in ${clockText(life.left)}`) : "";
    if (go) go.disabled = life.over || (sure ? !sure.checked : false);
  };
  const tick = setInterval(paint, 1000);
  sure?.addEventListener("change", paint);
  const qtyLine = o.lots ? plural(o.lots, "lot") : `${formatInt(o.quantity)} qty`;
  const ok = await modal({
    title: "Confirm this order?",
    body: h(
      "div",
      { class: "stack ob-confirm" },
      h("div", { class: "ob-brief" }, sidePill(o.side), h("div", {}, h("strong", {}, `${qtyLine} ${contractName(o.symbol)}`), h("span", { class: "ob-sub" }, `${isFigure(t.estimatedValue) ? `About ${formatRupeeGrouped(t.estimatedValue, 0)} · ` : ""}${live ? "Live, real money" : "Paper"} · ticket ${t.ticketId}`))),
      h("p", { class: "muted" }, "Confirming lets the client that prepared it send exactly this order, once."),
      live ? h("div", { class: "alert warn", role: "note" }, icon("warn"), h("div", {}, h("strong", {}, "This order uses real money."), h("span", { class: "detail" }, "It goes to your broker as soon as the client sends it."))) : null,
      h("dl", { class: "kv" }, ...fields.flatMap(([k, v, cls]) => [h("dt", {}, k), h("dd", { class: cls ? `${cls}-text` : undefined }, v)])),
      sure ? h("label", { class: "check", for: "confirm-live" }, sure, "I have checked every field and want this live order sent") : null,
      left,
    ),
    buttons: [
      { label: "Not now", value: false },
      { label: live ? "Confirm live order" : "Confirm order", cls: live ? "destructive" : "primary", value: true, ref: (el) => ((go = el), paint()) },
    ],
  });
  clearInterval(tick);
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
  let safety, accounts, ready;
  try {
    [safety, accounts, ready] = await Promise.all([api("/v1/safety"), optional(api("/v1/accounts")), loadReadiness()]);
  } catch (err) {
    return [h("div", { class: "sf-fail" }, alertBox(err), h("div", {}, h("button", { type: "button", class: "small", onclick: () => show() }, icon("refresh"), "Try again")))];
  }
  const s = safety.data.data;
  // Accounts by their names, as everywhere else; the id stays in the tooltip for API users.
  const names = new Map((accounts.data?.data ?? []).map((a) => [a.id, a.label]));
  const ks = s.killSwitch ?? {};
  const demo = app.state.demo;

  // ── Status hero: one calm answer, and the kill switch as a deliberate control under it ──
  const heroMain = h("div", { class: "sf-hero-main" });
  const drawHero = (snap) => {
    if (!hero.isConnected && hero.dataset.drawn) return offHero();
    hero.dataset.drawn = "1";
    const m = heroModel(s, snap, { demo });
    hero.dataset.state = m.state;
    hero.dataset.tone = m.tone;
    heroMain.replaceChildren(
      h("span", { class: "sf-hero-tile", "aria-hidden": "true" }, icon(m.icon)),
      h("div", { class: "sf-hero-text" }, h("h2", { id: "sf-hero-h" }, m.title), h("p", {}, m.sub), m.reasons.length ? h("ul", { class: "sf-hero-why" }, m.reasons.map((r) => h("li", {}, r))) : null),
    );
  };
  const stopped = async () => {
    await refreshReadiness();
    show();
  };
  const engage = async () => {
    if (await engageKillSwitch()) stopped();
  };
  const release = async () => {
    if (await releaseKillSwitch()) stopped();
  };
  const killRow = ks.engaged
    ? h(
        "div",
        { class: "sf-kill engaged" },
        h("div", { class: "sf-kill-text" }, h("p", { class: "sf-kill-title" }, "Kill switch", pill("On", "bad")), h("p", {}, `Turned on ${istDateTime(ks.at)} by ${ks.by ?? "unknown"}${ks.reason ? `: ${ks.reason}` : ""}`), h("p", { class: "sf-kill-note" }, "Releasing works from this computer only, with an admin key.")),
        h("button", { type: "button", id: "kill-action", class: "primary lg", onclick: release }, "Release kill switch"),
      )
    : h(
        "div",
        { class: "sf-kill" },
        h(
          "div",
          { class: "sf-kill-text" },
          h("p", { class: "sf-kill-title" }, "Kill switch", pill("Off")),
          h("p", {}, "Stops every new order, from every tool: the API, webhooks, AI assistants, the CLI and this dashboard. Cancels still work."),
          h("p", { class: "sf-kill-note" }, "From a terminal: ", h("span", { class: "cli-cmd" }, `${cliHint()} kill`)),
        ),
        h("button", { type: "button", id: "kill-action", class: "destructive lg", onclick: engage }, icon("stop"), "Stop all orders"),
      );
  const hero = h("section", { class: "sf-hero", "aria-labelledby": "sf-hero-h" }, heroMain, killRow);
  const offHero = onReadiness((snap) => drawHero(snap));
  drawHero(ready.snap);

  // ── Trading readiness (checklist, timeline, how it is checked) and the demo tools ──
  const readiness = readinessSection({ demo, initial: ready });

  // ── Daily limits per account ──
  const usage = (label, u, extra) => {
    const fill = h("span");
    fill.style.width = `${u.pct}%`; // set through the style object: the page's CSP refuses a style attribute
    const bar = h("div", { class: `bar ${u.tone}`, role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(u.pct) }, fill);
    return h("div", { class: "sf-use" }, h("div", { class: "sf-use-top" }, h("span", {}, label), h("strong", {}, u.text)), bar, u.word || extra ? h("p", { class: `sf-use-note ${u.tone}` }, u.word, u.word && extra ? " · " : null, extra) : null);
  };
  const limitCards = (s.accounts ?? []).map((a) => {
    const m = limitsModel(a);
    const name = names.get(a.accountId) || a.accountId;
    return h(
      "article",
      { class: "sf-lim sf-card", "aria-label": `Daily limits for ${name}` },
      h("header", {}, h("h3", { title: `Account id ${a.accountId}` }, name), h("p", {}, a.accountId)),
      usage("Orders today", m.orders),
      usage("Loss against the daily limit", m.loss, m.loss.pnl === null ? "No P&L yet" : h("span", {}, "P&L today ", pnl(m.loss.pnl, 0))),
      h("dl", { class: "sf-lim-facts" }, m.facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
    );
  });
  const limits = h(
    "section",
    { class: "sec", "aria-labelledby": "sf-lim-h" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id: "sf-lim-h" }, "Daily limits"), h("p", {}, `Per account, for the IST day ${s.day ?? ""}. The figures add paper and live orders.`))),
    limitCards.length ? h("div", { class: "sf-lim-grid" }, limitCards) : h("div", { class: "sf-card" }, emptyState("safety", "No accounts", "Daily limits appear once an account is configured.", nextStep("Go to Accounts", "#/accounts"), { compact: true })),
  );

  // ── Live trading: the five conditions ──
  const answer = (v) => (v === "yes" ? pill("Yes", "ok") : v === "no" ? pill("No") : pill("Per order", "info"));
  const liveGroup = h(
    "section",
    { class: "sec", "aria-labelledby": "sf-live-h" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id: "sf-live-h" }, "Live trading"), h("p", {}, "A live order needs all five. Nothing in the API, a webhook or an AI tool can switch live trading on.")), h("div", { class: "sec-acts" }, s.liveTrading ? pill("On", "bad") : pill("Off: paper only"))),
    h("div", { class: "list" }, liveConditions(s).map((c) => h("div", { class: "list-row static sf-cond" }, h("span", { class: "names" }, h("span", { class: "nm" }, c.text), c.detail ? h("span", { class: "sub" }, c.detail) : null), answer(c.value)))),
    demo ? h("div", { class: "alert info sf-demo-note" }, icon("info"), h("div", {}, h("strong", {}, "Demo mode forces live trading off."))) : null,
  );

  // ── Audit log: verify the hash chain ──
  const verifyOut = h("div", { class: "sf-verify", "aria-live": "polite" });
  const verifyBtn = h("button", { type: "button", class: "small" }, icon("check"), "Verify now");
  verifyBtn.addEventListener("click", async () => {
    busy(verifyBtn, true);
    try {
      const d = (await api("/v1/audit/verify")).data.data ?? {};
      const at = istTime(new Date().toISOString());
      verifyOut.replaceChildren(d.ok ? alertBox({ title: "The audit log is intact", detail: `${plural(d.checked, "record")} checked. None was changed or removed. Verified at ${at} IST.` }, "ok") : alertBox({ title: "The audit log was changed", detail: `The chain breaks at ${d.brokenAt ?? "an unknown record"}. Records after it cannot be trusted. Verified at ${at} IST.` }, "bad"));
    } catch (err) {
      verifyOut.replaceChildren(alertBox(err));
    } finally {
      busy(verifyBtn, false);
    }
  });
  const audit = h(
    "section",
    { class: "sec", "aria-labelledby": "sf-audit-h" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id: "sf-audit-h" }, "Audit log"), h("p", {}, "Every order, key change and kill-switch action is written to a hash chain. Verify checks that no record was changed or removed."))),
    h("div", { class: "list" }, h("div", { class: "list-row static sf-audit-row" }, iconTile("activity", "indigo", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Hash chain"), h("span", { class: "sub" }, "Admin key, this computer only")), verifyBtn)),
    verifyOut,
  );

  return [hero, readiness.main, limits, driftSection(), h("div", { class: "sf-pair" }, liveGroup, audit), backupSection(), readiness.demo].filter(Boolean);
}

// ── API page: shared pieces (Keys, Integrations, Test console, Rate limits, Activity) ──

/** Icon and tile hue of each tool, as the key form and the Integrations gallery show them. */
const API_TILE = Object.freeze({
  webhooks: ["integrations", "teal"],
  python: ["console", "blue"],
  node: ["bolt", "green"],
  excel: ["chart", "orange"],
  amibroker: ["activity", "indigo"],
  telegram: ["inbox", "blue"],
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
    alertBox({ title: "Copy it and store it now. It is shown only once.", detail: "The Bridge keeps only a short code that recognises the key, so it cannot show it again. If you lose it, revoke it and make another." }, "warn"),
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
const USE_BLURB = Object.freeze({ excel: "Live prices in cells", claude: "Claude, ChatGPT and others", python: "Scripts and notebooks", node: "Scripts and services", amibroker: "Live values in your charts", app: "Your own tool or bot", other: "Anything not listed" });
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
  const root = h("div", { class: "api-tab" });
  const createdBox = h("div", { class: "ak-created" });
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
    const urlUse = h("input", { type: "checkbox", id: "key-url", role: "switch", "aria-describedby": "key-url-warn" });
    const urlWarn = h("p", { id: "key-url-warn", class: "ak-url-warn", role: "status" });
    const drawUrlWarn = () => (urlWarn.textContent = urlUse.checked ? "A key in a URL shows in the address bar, in the spreadsheet and in browser history. Keep it read only, give it an expiry, and revoke it when you are done." : "");
    const summary = h("p", { class: "ak-summary", "aria-live": "polite" });
    const createBtn = h("button", { type: "button", class: "primary lg full" }, icon("plus"), "Create key");
    // What the person changed by hand is kept when they pick another tool; the rest follows the tool.
    const touched = { label: false, scope: false, expires: false, url: false };
    label.addEventListener("input", () => (touched.label = label.value.trim() !== ""));
    for (const ev of ["click", "keydown"]) {
      access.addEventListener(ev, () => (touched.scope = true));
      expires.addEventListener(ev, () => (touched.expires = true));
    }
    urlUse.addEventListener("change", () => ((touched.url = true), drawUrlWarn()));
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
      drawUrlWarn();
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
        h("section", { class: "group" }, h("h2", { class: "group-title" }, `Your keys · ${formatInt(live.length)} active`), live.length ? h("div", { class: "list" }, live.map(keyRow)) : h("div", { class: "list" }, emptyState("keys", "No active keys", "Create one key per tool, so you can revoke one without touching the others.", nextStep("Create a key", () => label.focus()))), h("p", { class: "group-foot" }, "The Bridge keeps only a short code for each key. The key itself was shown once, when you made it.")),
        gone.length ? h("details", { class: "ak-gone", open: wasOpen }, h("summary", {}, `Revoked keys (${formatInt(gone.length)})`), h("div", { class: "list" }, gone.map(keyRow))) : null,
      ].filter(Boolean));
    };
    drawList(rows);

    const create$ = h(
      "section",
      { class: "card" },
      h("header", { class: "card-head" }, iconTile("plus", "pink"), h("div", { class: "card-titles" }, h("h2", {}, "Create a key"), h("p", {}, "One key per tool, with only the access it needs. Live keys are made in the terminal."))),
      h(
        "div",
        { class: "card-body ak-form" },
        h("div", { class: "ak-step" }, h("h3", {}, h("span", { class: "ak-n", "aria-hidden": "true" }, "1"), "What will use it?"), picker),
        h(
          "div",
          { class: "ak-step" },
          h("h3", {}, h("span", { class: "ak-n", "aria-hidden": "true" }, "2"), "Check what it can do"),
          h("div", { class: "stack" }, h("label", { class: "field", for: "key-label" }, h("span", {}, "Name"), label), segField("Access", access, { wide: true }), caps, h("label", { class: "field", for: "key-accounts" }, h("span", {}, "Accounts"), acct), segField("Expires", expires, { wide: true }), h("label", { class: "ak-switch", for: "key-url" }, h("span", { class: "names" }, h("strong", {}, "Allow in URLs"), h("span", { class: "hint" }, "For Excel and Google Sheets, which can only send a key in the address (?key=). Read only keys.")), h("span", { class: "switch" }, urlUse, h("i"))), urlWarn),
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
  webhooks: "Alerts from TradingView, your scripts, ChartInk scans or GoCharting place paper orders through a webhook. Each hook has its own secret address.",
  python: "The Python client: standard library only, Python 3.9 or newer. Paper orders get an Idempotency-Key for you.",
  node: "The Node client (ESM). Streaming on Node 20 needs the ws package; Node 22 has a WebSocket built in.",
  excel: "Prices and your book in a spreadsheet, one request per refresh instead of one per cell. Read-only: a sheet cannot place an order.",
  amibroker: "Live values in AFL from the Bridge's cache and stream. History imports use /xl/history with the shipped .format files.",
  telegram: "Alerts on your phone, and read-only prices and status from Telegram. The bot token is typed on this computer only.",
  claude: "The Bridge is an MCP server. An assistant can read prices, chains and your positions; it can only prepare orders for you to confirm.",
  chatgpt: "ChatGPT connectors cannot reach a server on your computer. Use the same tools from your own script with OpenAI function calling.",
  rest: "Every route answers { data, meta } JSON with freshness labels. Errors are problem+json with a stable code.",
};
const TOOL_BLURB = { webhooks: "Alerts place paper orders", python: "Scripts and notebooks", node: "Scripts and services", excel: "Live prices in cells", amibroker: "Live values in your charts", telegram: "Alerts and prices on your phone", claude: "MCP server for assistants", chatgpt: "Function calling", rest: "Plain HTTP and JSON" };
const GUIDES = { webhooks: "webhooks", python: "python", node: "typescript", excel: "excel-sheets", amibroker: "amibroker", telegram: "telegram", claude: "mcp", chatgpt: "chatgpt-openai", rest: "streaming" };

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
      if (active === "telegram") {
        // Its own card (telegram-card.js): no key, no snippets. The token is typed here, on this computer.
        const telegramGuide = guideUrl(GUIDES.telegram);
        panel.replaceChildren(h("header", { class: "card-head" }, iconTile(glyph, tint, "lg"), h("div", { class: "card-titles" }, h("h2", {}, name), h("p", {}, INTRO.telegram))), h("div", { class: "card-body ai-body" }, createTelegramCard({ guideHref: telegramGuide })));
        return;
      }
      const s = snippets({ base: location.origin, key: createdKeys[active] ?? null, account: paperAcc, symbol: "NSE:NIFTY", folder: app.state.meta?.installDir || undefined })[active] ?? [];
      const preset = active === "excel" ? null : KEY_PRESETS[active]; // Excel and Sheets make their key inside their own panel
      const keyBtn = preset && h("button", { type: "button", class: "small tinted" }, icon("keys"), createdKeys[active] ? "Key created" : `Create a ${preset.scopes.join(" + ")} key for this`);
      if (keyBtn) {
        keyBtn.disabled = Boolean(createdKeys[active]);
        keyBtn.addEventListener("click", async () => {
          busy(keyBtn, true);
          try {
            const body = presetKeyBody(preset);
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
      const sheets = active === "excel" ? (await import("./sheets-panel.js")).sheetsPanel({ accounts, download: (opts) => import("./workbook.js").then((m) => m.downloadWorkbook(opts)) }) : null;
      const guide = h("a", { class: "btn small quiet", href: guideUrl(GUIDES[active]), target: "_blank", rel: "noopener", "aria-label": `${name} guide (opens in a new tab)` }, "Guide", icon("external"));
      const parts = [
        h("header", { class: "card-head" }, iconTile(glyph, tint, "lg"), h("div", { class: "card-titles" }, h("h2", {}, name), h("p", {}, INTRO[active])), h("div", { class: "card-actions" }, guide)),
        h(
          "div",
          { class: "card-body ai-body" },
          h("div", { class: "ai-meta" }, h("div", { class: "ai-addr" }, h("span", { class: "ai-addr-label" }, "Your Bridge address"), h("code", {}, location.origin), copyButton(location.origin, { ariaLabel: "Copy your Bridge address", toastLabel: "Address copied", cls: "small copy" })), keyBtn ?? null),
          createdKeys[active] ? alertBox({ title: "Your new key is filled into the code below.", detail: "It is shown only on this page, and only until you leave it. Copy it now." }, "info") : null,
          sheets,
          active === "webhooks" ? h("div", { class: "ai-hooks" }) : null,
          active === "webhooks" || active === "excel" ? h("div", { class: "ai-expose" }) : null,
          s.length ? h("div", { class: "stack" }, active === "webhooks" ? h("h3", { class: "ai-sub" }, "How to send an alert") : active === "excel" ? h("h3", { class: "ai-sub" }, "Formulas and code, if you would rather build your own") : null, s.map(snippetBlock)) : null,
        ),
      ];
      panel.replaceChildren(...parts);
      if (active === "webhooks" || active === "excel") exposeCard(panel.querySelector(".ai-expose"), active === "excel" ? "sheets" : "alerts");
      if (active === "webhooks") await webhookPanel(paperAcc, panel.querySelector(".ai-hooks"));
    }
    drawTool();
    return [picker, panel];
  };

  loadInto(root, async () => (await api("/v1/accounts")).data.data ?? [], drawAll, { rows: 3 });
  return root;
}

/** Where the dashboard remembers the public address typed for hooks (this browser only; a convenience, never required). */
const HOOK_PUBLIC_SLOT = "mcb.dashboard.hookPublicAddress";
const TV_GUIDE = guideUrl("webhooks", "#tradingview");
const EXPOSE_GUIDE = guideUrl("expose-alerts");

/** One test alert: the button, and a slot that shows what happened in plain words. `onDone` runs after an answer. */
function hookTester(hook, onDone) {
  const slot = h("div", { class: "ai-test-result", role: "status", "aria-live": "polite" });
  const btn = h("button", { type: "button", class: "tinted" }, icon("play"), "Send a test alert");
  btn.addEventListener("click", async () => {
    busy(btn, true);
    slot.replaceChildren(h("p", { class: "muted small" }, "Sending a test alert through the same checks a real one passes…"));
    try {
      const r = await api(`/v1/hooks/${encodeURIComponent(hook.id)}/test`, { method: "POST", body: {} });
      const d = r.data.data;
      const v = outcomeView(d);
      const tone = v.tone === "ok" ? "ok" : v.tone === "bad" ? "bad" : v.tone === "warn" ? "warn" : "info";
      const sent = typeof d.message === "string" ? d.message : JSON.stringify(d.message);
      slot.replaceChildren(
        alertBox({ title: `${v.word}: ${d.summary}`, detail: [d.reason, d.orderId ? `Paper order ${d.orderId}.` : null].filter(Boolean).join(" ") }, tone),
        h("details", { class: "ai-details" }, h("summary", {}, "What the test sent"), h("pre", { class: "snip-code", tabindex: "0" }, sent)),
        h("p", { class: "muted small" }, d.note),
      );
      onDone?.();
    } catch (err) {
      slot.replaceChildren(alertBox(err));
    } finally {
      busy(btn, false);
    }
  });
  return { btn, slot };
}

/** The recent alerts of one hook, with what happened to each, in a sheet. */
function openHookAlerts(hook) {
  const body = h("div", { class: "stack ai-alerts" });
  const test = hookTester(hook, () => draw());
  const reload = h("button", { type: "button", class: "small plain", onclick: () => draw() }, icon("refresh"), "Refresh");
  async function draw() {
    const r = await optional(api(`/v1/hooks/${encodeURIComponent(hook.id)}/signals?limit=30`));
    if (r.error) {
      body.replaceChildren(alertBox(r.error));
      return;
    }
    const d = r.data.data;
    const real = d.signals.filter((s) => !s.test);
    const quiet = silentHint({ lastSignalAt: d.lastSignalAt, createdAt: hook.createdAt }, Date.parse(d.serverTime) || Date.now());
    const line = countsLine(d.counts);
    const rows = d.signals.map((s) => {
      const v = outcomeView(s);
      const detail = [s.symbol, s.side, s.id ? `id ${s.id}` : null, s.orderId ? `order ${s.orderId}` : null].filter(Boolean).join(" · ");
      return h("li", { class: "ai-alert" }, h("span", { class: "ai-alert-time" }, istDateTime(s.receivedAt)), pill(v.word, v.tone), h("div", { class: "ai-alert-text" }, h("span", {}, v.text), detail || s.test ? h("span", { class: "ai-alert-sub" }, [s.test ? "Test alert" : null, detail].filter(Boolean).join(" · ")) : null));
    });
    body.replaceChildren(
      !real.length || quiet.tone === "warn" ? (quiet.hint ? alertBox({ title: quiet.text, detail: quiet.hint }, quiet.tone === "warn" ? "warn" : "info") : null) : null,
      h("div", { class: "ai-alerts-bar" }, line ? h("p", { class: "muted small" }, line) : h("p", { class: "muted small" }, d.countsSince ? `Counting since ${istDateTime(d.countsSince)}.` : ""), reload),
      rows.length ? h("ol", { class: "list ai-alert-list", "aria-label": "Recent alerts, newest first" }, rows) : emptyState("activity", "No alert received yet", "Send a test alert above to check the hook. Real alerts appear here a moment after TradingView sends them.", null, { compact: true }),
      h("p", { class: "muted small" }, "Kept in memory only (the last alerts since the Bridge started). The Activity page has the permanent audit log."),
    );
  }
  modal({
    title: `Alerts: ${hook.label}`,
    body: h("div", { class: "stack" }, h("div", { class: "ai-test" }, test.btn, h("span", { class: "muted small" }, "Places a paper order only, never a real one.")), test.slot, body),
    buttons: [{ label: "Close", value: true }],
  });
  draw();
}

async function webhookPanel(paperAcc, host) {
  const presets = (await optional(api("/v1/hooks/presets"))).data?.data ?? null;
  const box = h("div", { class: "stack", "aria-live": "polite" });
  const listSlot = h("div", { class: "ai-hook-list" });
  const label = h("input", { id: "hook-name", value: "NIFTY breakout", maxlength: "60", autocomplete: "off" });
  const source = h("select", { id: "hook-source" }, [["tradingview", "TradingView"], ["generic", "Generic (signed JSON)"], ["chartink", "ChartInk"], ["gocharting", "GoCharting"]].map(([v, t]) => h("option", { value: v }, t)));
  const side = segmented("Side", [["", "From the alert"], ["BUY", "BUY"], ["SELL", "SELL"]], "");
  const orderType = segmented("Order type", [["LIMIT", "LIMIT (safer)"], ["MARKET", "MARKET (protected)"]], "LIMIT");
  const product = segmented("Product", ["INTRADAY", "MARGIN", "CNC"].map((p) => [p, p]), "INTRADAY");
  const lots = h("input", { id: "hook-lots", type: "number", inputmode: "numeric", value: "1", min: "1", max: "50" });
  const maxAge = h("input", { id: "hook-maxage", type: "number", inputmode: "numeric", value: "120", min: "5", max: "3600" });
  const ipSwitch = h("input", { type: "checkbox", role: "switch", id: "hook-ips" });
  ipSwitch.checked = Boolean(presets?.clientIpHeader);
  const publicBase = h("input", { id: "hook-public", type: "url", inputmode: "url", placeholder: "https://your-name.example.com", autocomplete: "off", spellcheck: "false" });
  publicBase.value = local.get(HOOK_PUBLIC_SLOT) ?? presets?.publicIngress?.urls?.[0] ?? "";
  const btn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create webhook");
  const ipList = presets?.ipPresets?.find((p) => p.name === "tradingview") ?? null;
  const ipNote = presets?.clientIpHeader
    ? `Behind a tunnel the Bridge reads the real sender from the “${presets.clientIpHeader}” header (hooks.clientIpHeader), so this check works.`
    : "hooks.clientIpHeader is not set in your config. Through a tunnel the Bridge then sees the tunnel, not TradingView, and would refuse every alert. Leave this off, or set it first (see the guide).";
  const tvFields = [
    h("label", { class: "field", for: "hook-maxage" }, h("span", {}, "Refuse alerts older than (seconds)"), maxAge),
    h("label", { class: "field", for: "hook-public" }, h("span", {}, "Your public address (optional)"), publicBase, h("span", { class: "field-hint" }, "From your tunnel. Used to show the final address to paste into TradingView.")),
    h(
      "div",
      { class: "field wide ai-ips" },
      h("label", { class: "ai-switch", for: "hook-ips" }, h("span", {}, "Only accept alerts from TradingView's own addresses"), h("span", { class: "switch" }, ipSwitch, h("i"))),
      h("p", { class: "muted small" }, ipNote),
      ipList ? h("details", { class: "ai-details" }, h("summary", {}, `TradingView's addresses, checked ${ipList.verifiedAt ?? "on an unknown date"}${ipList.edited ? " (your edited list)" : ""}`), h("p", { class: "mono small" }, ipList.ips.join("   ")), /^https:\/\//i.test(ipList.source ?? "") ? h("a", { href: ipList.source, target: "_blank", rel: "noopener noreferrer" }, "TradingView's own page for this list") : null) : null,
    ),
  ];
  const syncSource = () => {
    for (const f of tvFields) f.hidden = source.value !== "tradingview";
  };
  source.addEventListener("change", syncSource);
  syncSource();
  let list = [];
  const hookRow = (x) => {
    const quiet = silentHint(x, Date.now());
    return apiRow({
      glyph: "integrations",
      tint: "teal",
      title: x.label,
      sub: h("span", {}, h("span", { class: "mono" }, x.id), ` · ${x.source === "tradingview" ? "TradingView" : cap(x.source)} · ${x.account}`),
      chips: [x.mode === "live" ? pill("Live", "bad") : pill("Paper"), x.mode === "live" && x.readiness ? pill(STATE_TEXT[x.readiness] ?? x.readiness, STATE_TONE[x.readiness] ?? "") : null, quiet.tone === "warn" ? pill(quiet.state === "quiet" ? "Quiet" : "Nothing yet", "warn") : null],
      aside: [h("span", { class: "api-row-note" }, quiet.state === "recent" ? `${quiet.text} (${istDateTime(x.lastSignalAt)})` : quiet.text)],
      action: h(
        "div",
        { class: "api-row-acts" },
        h("button", { type: "button", class: "small tinted", "aria-label": `Recent alerts and test for ${x.label}`, onclick: () => openHookAlerts(x) }, icon("activity"), "Alerts"),
        h("button", {
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
      ),
    });
  };
  const listNode = () => h("section", { class: "group" }, h("h3", { class: "group-title" }, `Your webhooks · ${formatInt(list.length)}`), list.length ? h("div", { class: "list" }, list.map(hookRow)) : h("div", { class: "list" }, emptyState("integrations", "No webhooks yet", "Fill in the form above and choose Create webhook. Its secret address appears here once.", null, { compact: true })));
  const drawList = () => listSlot.replaceChildren(listNode());

  /** What the person does in TradingView, in order, after a TradingView hook is made. */
  const tvSteps = (d, base) => {
    const f = finalHookUrl({ path: d.path, localUrl: d.url, publicBase: base });
    return { f, steps: h("ol", { class: "ai-steps" }, h("li", {}, "In TradingView, open a chart and create an alert (the alarm-clock icon, or Alt+A)."), h("li", {}, "Open the Notifications tab, tick Webhook URL and paste the address above."), h("li", {}, "On the Settings tab, replace the whole Message box with one of the messages below."), h("li", {}, "Create the alert. When it fires, it appears under Alerts for this webhook."), h("li", {}, "TradingView needs two-step sign-in turned on, and webhook alerts are a paid-plan feature.")) };
  };

  btn.addEventListener("click", async () => {
    busy(btn, true);
    try {
      const isTv = source.value === "tradingview";
      const body = { source: source.value, label: label.value.trim() || "Webhook", account: paperAcc, orderType: orderType.value, product: product.value, maxLotsPerSignal: Number(lots.value) || 1, ...(side.value ? { side: side.value } : {}) };
      if (isTv) {
        body.maxAgeSec = Number(maxAge.value) || 120;
        if (ipSwitch.checked) body.sourceIpPreset = "tradingview";
      }
      const r = await api("/v1/hooks", { method: "POST", body });
      const d = r.data.data;
      list = [...list, d];
      drawList();
      const tester = hookTester(d, () => {});
      const warnings = (d.warnings ?? []).map((w) => alertBox({ title: "Note", detail: w }, "warn"));
      let fields;
      let content;
      if (isTv) {
        const { f: current, steps } = tvSteps(d, publicBase.value);
        if (current.isPublic) local.set(HOOK_PUBLIC_SLOT, publicBase.value.trim());
        fields = [{ label: "Webhook address (paste into TradingView's Webhook URL box)", value: current.url, toast: "Address copied" }, { label: "Passphrase (it goes inside every alert message)", value: d.passphrase, toast: "Passphrase copied" }];
        const helper = current.isPublic ? null : addressHelper(d, (v) => finalHookUrl({ path: d.path, localUrl: d.url, publicBase: v }));
        const tpl = (i) => d.templates[i] && snippetBlock({ title: d.templates[i].name, lang: d.templates[i].contentType === "application/json" ? "json" : "text", code: d.templates[i].message });
        content = h(
          "div",
          { class: "stack" },
          current.problem ? alertBox({ title: "Check the public address", detail: current.problem }, "warn") : null,
          helper,
          h("h3", { class: "ai-sub" }, "Set it up in TradingView"),
          steps,
          h("h3", { class: "ai-sub" }, "Alert messages to paste"),
          tpl(0),
          tpl(1),
          h("details", { class: "ai-details" }, h("summary", {}, "Plain-text alternative"), tpl(2)),
          h("div", { class: "ai-test" }, tester.btn, h("span", { class: "muted small" }, "Places a paper order only, never a real one.")),
          tester.slot,
          ...warnings,
          h("p", { class: "muted small" }, "More: ", h("a", { href: TV_GUIDE, target: "_blank", rel: "noopener" }, "the TradingView guide"), " and ", h("a", { href: EXPOSE_GUIDE, target: "_blank", rel: "noopener" }, "how to give TradingView a safe public address"), "."),
        );
      } else {
        fields = [{ label: "Webhook address (its secret token is shown once)", value: d.url, toast: "Address copied" }, ...(d.signingSecret ? [{ label: "Signing secret (shown once; sign every request with it)", value: d.signingSecret, toast: "Secret copied" }] : [])];
        content = h("div", { class: "stack" }, ...(d.templates ?? []).slice(0, 1).map((t) => snippetBlock({ title: t.name, lang: t.contentType === "application/json" && t.message.startsWith("{") ? "json" : "text", code: t.message })), h("div", { class: "ai-test" }, tester.btn, h("span", { class: "muted small" }, "Places a paper order only, never a real one.")), tester.slot, ...warnings, h("p", { class: "muted small" }, "Hosted alert services post from the internet, so point a tunnel (for example Cloudflare Tunnel) at the public ingress listener, which serves /hooks only. Paper orders by default."));
      }
      const panel = oncePanel({ title: `Webhook created: ${d.label ?? "Webhook"}`, sub: `Paper orders on ${paperAcc}`, ariaLabel: "New webhook", fields, body: content, doneLabel: "Done, hide it", onDone: () => box.replaceChildren() });
      box.replaceChildren(panel);
      panel.focusFirst();
    } catch (err) {
      box.replaceChildren(alertBox(err));
    } finally {
      busy(btn, false);
    }
  });

  /** Typed after creation: the public address of the tunnel, turned into the final address with a live Copy button. */
  function addressHelper(d, build) {
    const input = h("input", { id: "hook-final-base", type: "url", inputmode: "url", placeholder: "https://your-name.example.com", autocomplete: "off", spellcheck: "false", "aria-describedby": "hook-final-note" });
    const out = h("code", { class: "once-value", tabindex: "0", "aria-label": "Final webhook address" }, d.url);
    const note = h("p", { class: "muted small", id: "hook-final-note", role: "status" }, "This address only works on this computer. TradingView needs an address on the internet: type yours here to see the final address.");
    let current = build("");
    const copy = copyButton(() => current.url, { label: "Copy", toastLabel: "Address copied", cls: "primary lg once-copy", ariaLabel: "Copy the final webhook address" });
    input.addEventListener("input", () => {
      current = build(input.value);
      out.textContent = current.url;
      note.textContent = current.problem ?? (current.isPublic ? "This is the address to paste into TradingView." : "This address only works on this computer. TradingView needs an address on the internet: type yours here to see the final address.");
      if (current.isPublic && !current.problem) local.set(HOOK_PUBLIC_SLOT, input.value.trim());
    });
    return h("div", { class: "once-field" }, h("label", { class: "once-label", for: "hook-final-base" }, "Your public address"), input, h("div", { class: "once-row" }, out, copy), note, h("p", { class: "muted small" }, "No public address yet? ", h("a", { href: EXPOSE_GUIDE, target: "_blank", rel: "noopener" }, "See how to set one up safely"), "."));
  }

  host.replaceChildren(
    h(
      "section",
      { class: "ai-hook-form" },
      h("div", { class: "card-titles" }, h("h3", {}, "Create an alert webhook"), h("p", {}, `Each hook has its own secret address and places paper orders on ${paperAcc}.`)),
      h("div", { class: "form-grid" }, h("label", { class: "field", for: "hook-name" }, h("span", {}, "Name"), label), h("label", { class: "field", for: "hook-source" }, h("span", {}, "Source"), source), segField("Side", side), segField("Product", product), segField("Order type", orderType, { wide: true }), h("label", { class: "field", for: "hook-lots" }, h("span", {}, "Max lots per alert"), lots), ...tvFields, btn),
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
  const root = h("div", { class: "api-tab" });
  // #/api/activity?view=audit opens the audit log (the Ctrl K "Audit log" entry).
  let view = hashParams().get("view") === "audit" ? "audit" : "requests";
  const seg = segmented("Log", [["requests", "Requests"], ["audit", "Audit log"]], view);
  const body = h("div", { class: "aa-body" });
  const head = h("div", { class: "aa-head" }, h("h2", { class: "sr-only" }, "Activity"), seg);
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
        result.replaceChildren(d.ok ? alertBox({ title: `The chain is intact (${plural(d.checked, "record")})`, detail: "No record was changed or removed." }, "ok") : alertBox({ title: `The chain is broken at ${d.brokenAt}`, detail: "A record was changed or removed after it was written. Keep the audit files and investigate before trusting this log." }));
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
          { class: "list" },
          shown.map((x) =>
            h(
              "details",
              { class: "list-row static aa-rec" },
              h("summary", {}, h("span", { class: "aa-seq" }, `#${formatInt(x.seq)}`), h("strong", { class: "aa-event" }, x.type), h("span", { class: "aa-when" }, istDateTime(x.at)), h("span", { class: "aa-who" }, `${x.actor?.kind ?? ""}${x.actor?.id ? `:${x.actor.id}` : ""}`, x.accountId ? ` · ${x.accountId}` : "")),
              h("div", { class: "aa-rec-body" }, h("dl", { class: "kv" }, h("dt", {}, "Source"), h("dd", {}, x.source ?? DASH), h("dt", {}, "Hash"), h("dd", {}, String(x.hash ?? "").slice(0, 16) || DASH)), h("pre", { class: "snip-code" }, JSON.stringify(x.data ?? {}, null, 2))),
            ),
          ),
        ),
        h("p", { class: "aa-foot" }, `Showing ${formatInt(shown.length)} of ${plural(rows.length, "record")}.`, h("span", { class: "aa-fine" }, "Append-only and hash-chained, one file per IST day in data/audit/. Secrets are redacted.")),
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
