// Dashboard pages. Each page renders into #content from live Bridge data; nothing here stores data outside this tab
// except small conveniences in localStorage (theme, a dismissed checklist, "you copied a snippet").
import {
  alertBox,
  api,
  app,
  brokerMatches,
  card,
  checklistState,
  codeBlock,
  confirmCodeNotice,
  copyButton,
  currentKey,
  emptyState,
  fillLoginUrl,
  h,
  highlightJson,
  icon,
  iconTile,
  istDateTime,
  istTime,
  loginBody,
  loginFormSpec,
  meterRow,
  modal,
  optional,
  pill,
  sectionEyebrow,
  table,
  ticketFields,
  toast,
  touchWord,
  sheetPopover,
  store,
  confirmEngageKillSwitch,
  DEMO_EXPLAINER,
  beginNavigation,
  onRevalidated,
  prefetchPage,
} from "./app.js";
import { STATE_TEXT, STATE_TONE, homeSafetyLine, readinessCard, readinessPill, refreshReadiness } from "./readiness.js";
import { DASH, formatFixed, formatGrouped, formatInt, formatRupee, formatRupeeGrouped, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { DENSITY_SLOT, parseDensity } from "./layout-prefs.js";
import { busiestClass, mountBudget, perSecondLimit, usageChart, windowText } from "./budget.js";
import * as live from "./live.js";
import { KEY_PRESETS, snippets } from "./snippets.js";
import { KEY_USES, WORKING_ORDER, afterDemoSaveSteps, brokerSetupSteps, capabilityLabel, contractName, orderStatusText, capabilitySummary, clearFieldError, defaultKeyName, fieldError, keyFormProblem, keyUse, sessionText } from "./flows.js";
import { TYPE_CREDIT, initPalette, kbd, modKey, openPalette, pageShortcut, searchIcon } from "./palette.js";

const $ = (id) => document.getElementById(id);

// ── Page modules, loaded on first visit ──
// The heavy pages (the Options desk, screeners, calendar, recorder, live events) are ES modules imported when first
// opened, so Home, Orders, Accounts and API start without them. Hovering or focusing a menu item loads its module and
// warms its data (prefetchPage), so the click paints at once.
const PAGE_MODULES = Object.freeze({
  desk: () => import("./desk.js"),
  calendar: () => import("./calendar.js"),
  screener: () => import("./screener.js"),
  participants: () => import("./participants.js"),
  recorder: () => import("./recorder.js"),
  events: () => import("./events.js"),
  journal: () => import("./journal.js"),
  watchlists: () => import("./watchlists.js"),
  scanner: () => import("./scanner.js"),
});
/** A page renderer that loads its module first. `.module` names it, for preloading. */
function lazyPage(mod, name) {
  const render = (...args) => PAGE_MODULES[mod]().then((m) => m[name](...args));
  render.module = mod;
  return render;
}
const renderChainPage = lazyPage("desk", "renderChainPage");
const renderStrategyPage = lazyPage("desk", "renderStrategyPage");
const renderPositionsPage = lazyPage("desk", "renderPositionsPage");
const renderOiPage = lazyPage("desk", "renderOiPage");
const renderVolPage = lazyPage("desk", "renderVolPage");
const renderArbPage = lazyPage("desk", "renderArbPage");
const renderCalendarPage = lazyPage("calendar", "renderCalendarPage");
const renderScreenerPage = lazyPage("screener", "renderScreenerPage");
const renderParticipantsPage = lazyPage("participants", "renderParticipantsPage");
const renderRecorderPage = lazyPage("recorder", "renderRecorderPage");
const renderEventsPage = lazyPage("events", "renderEventsPage");
const renderJournalPage = lazyPage("journal", "renderJournalPage");
const renderWatchlistsPage = lazyPage("watchlists", "renderWatchlistsPage");
const renderScannerPage = lazyPage("scanner", "renderScannerPage");

/** Load a page's module and warm its data ahead of a click (menu hover or focus). Idempotent and cheap. */
export function preloadPage(pageId) {
  const page = PAGES.find((p) => p.id === pageId);
  if (!page) return;
  const tab = page.tabs ? page.tabs.find((t) => t.id === (readLastTab(page.id) ?? page.defaultTab)) ?? page.tabs[0] : null;
  const render = tab?.render ?? page.render;
  if (render?.module) PAGE_MODULES[render.module]().catch(() => {});
  prefetchPage(tab?.page ?? page.id);
}
const local = app.local;
const tabStore = store("session");
const FLAG = { copied: "mcb.dashboard.copied", tested: "mcb.dashboard.tested", hideChecklist: "mcb.dashboard.hideChecklist", hideOwn: "mcb.dashboard.hideOwnRequests", chain: "mcb.dashboard.chainOpened", traded: "mcb.dashboard.paperTraded", checklistOpen: "mcb.dashboard.checklistOpen" };
const markCopied = () => local.set(FLAG.copied, "1");
/** A button at work (BUTTON-SYSTEM.md §9): disabled, its label swapped for a turning ring, its width kept. */
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
/** A signed change with an arrow and the gain / loss colour (never colour alone); "--" when missing. */
function delta(value, text) {
  if (!isFigure(value)) return h("span", { class: "delta flat" }, DASH);
  const n = Number(value);
  const dir = n > 0 ? "up" : n < 0 ? "down" : "flat";
  return h("span", { class: `delta ${dir}` }, h("span", { "aria-hidden": "true" }, n > 0 ? "▲" : n < 0 ? "▼" : "•"), text);
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

/** The Integrations tab's tools (its inner segmented control; each is also a ⌘K destination). */
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
 * The one list of pages: it feeds the sidebar, the phone tab bar, the More sheet and the ⌘K palette
 * (docs/design/ui-pass-3.md §5). `group` is the sidebar group ("" for Home, which has no label), `tint` an iOS system
 * colour name (the page's glyph colour everywhere), `key` the curated ⌘1 to ⌘9 shortcut, `tab: true` puts it in the
 * phone tab bar (`short` labels it there), `headline` is the large title when it differs from `title` (one serif accent
 * word at most). A page with `tabs` is one page with a tab strip: each tab names the legacy page id it renders (`page`,
 * which keeps every `:root[data-page]` rule and old link working), may set its own `layout` and `sub`, and `command`
 * is its ⌘K label; `extras` are further ⌘K destinations inside it.
 */
export const PAGES = [
  { id: "home", label: "Home", icon: "home", tint: "blue", tab: true, key: 1, group: "", title: "Home", headline: ["Your ", { serif: "Bridge" }], sub: "Your accounts, today's activity and safety, on this computer", render: renderHome },
  { id: "chain", label: "Option Chain", short: "Chain", icon: "chart", tint: "green", tab: true, key: 2, group: "Trade", layout: "desk", title: "Option Chain", get sub() { return `Live chain with OI, IV and Greeks. ${touchWord()} a bid or ask to trade`; }, render: renderChainPage },
  { id: "strategy", label: "Strategy Builder", icon: "strategy", tint: "purple", key: 3, group: "Trade", layout: "desk", title: "Strategy Builder", sub: "Payoff, breakevens, POP and margin before you trade", render: renderStrategyPage },
  { id: "positions", label: "Positions", icon: "wallet", tint: "teal", tab: true, key: 4, group: "Trade", layout: "desk", title: "Option positions", sub: "Open option positions with P&L, net Δ and θ", render: renderPositionsPage },
  {
    id: "orders", label: "Orders", icon: "orders", tint: "orange", tab: true, key: 5, group: "Trade", title: "Orders", sub: "Paper by default. Pending confirmations wait here",
    defaultTab: "book",
    tabs: [
      { id: "book", label: "Orders", page: "orders", command: "Orders", keywords: "orders confirmations tickets modify cancel paper", render: renderOrders },
      { id: "journal", label: "Journal", page: "journal", command: "Trade journal", icon: "list", tint: "teal", keywords: "journal trades tags notes setup win rate expectancy drawdown calendar heatmap daily pnl csv export", sub: "Every fill as a trade: tags, notes, a P&L calendar and stats", render: renderJournalPage },
    ],
  },
  { id: "safety", label: "Safety", icon: "safety", tint: "red", key: 6, group: "Trade", title: "Safety", sub: "Kill switch, daily limits and live-trading status", render: renderSafety },
  {
    id: "oi", label: "OI Analysis", icon: "bars", tint: "orange", key: 7, group: "Markets", layout: "desk", title: "OI Analysis", sub: "Open interest and OI chg by strike, build-up and walls",
    defaultTab: "strike",
    tabs: [
      { id: "strike", label: "By strike", page: "oi", command: "OI Analysis", keywords: "open interest build-up walls max pain pcr", render: renderOiPage },
      { id: "participants", label: "Participants", page: "participants", command: "Participant OI", icon: "people", tint: "teal", keywords: "participants fii dii client pro", sub: "NSE participant-wise open interest: Client, DII, FII and Pro, by day", render: renderParticipantsPage },
    ],
  },
  { id: "vol", label: "Volatility", icon: "wave", tint: "pink", group: "Markets", layout: "desk", title: "Volatility", sub: "Smile, skew, term structure and expected move", render: renderVolPage },
  {
    id: "screeners", label: "Screeners", icon: "radar", tint: "yellow", key: 8, group: "Markets", layout: "desk", title: "Screeners", sub: "Options, arbitrage, live events and stocks, ranked and scanned",
    defaultTab: "options",
    tabs: [
      { id: "options", label: "Options", page: "screener", layout: "desk", command: "Option Screener", keywords: "screener unusual activity build-up rich cheap premium hedges", sub: "Scan every underlying and expiry for unusual activity, build-ups, rich or cheap premium, hedges and arbitrage", render: renderScreenerPage },
      { id: "arbitrage", label: "Arbitrage", page: "arb", layout: "desk", command: "Arbitrage scanner", icon: "scale", tint: "indigo", keywords: "arb parity box conversion reversal basis", sub: "Parity, boxes and futures basis at executable prices, after charges", render: renderArbPage },
      { id: "events", label: "Live events", page: "events", layout: "desk", command: "Live events", icon: "bolt", tint: "orange", keywords: "events event selector spider circuit only buyers only sellers volume surge gap day high breakout alerts live oi build-up iv spike wall", sub: "Circuits, volume surges, gaps, breakouts, F&O OI and option events as they happen", render: renderEventsPage },
      { id: "watchlists", label: "Watchlists", page: "watchlists", layout: "", command: "Watchlists", icon: "list", tint: "blue", keywords: "watchlist watch list quotes change oi iv favourites", sub: "Your lists with live quotes, % change, OI change for F&O and IV. One feeds Live events, one shows on Home", render: renderWatchlistsPage },
      { id: "stocks", label: "Stocks", page: "scanner", layout: "", command: "Stock scanner", icon: "scan", tint: "mint", keywords: "scanner scan condition rsi universe gap 52-week circuit nr7 inside day build-up oi spike ban pcr iv rank basis rollover max pain straddle skew", sub: "Price, F&O and option-chain scans in plain words, saved and scheduled", render: renderScannerPage },
    ],
  },
  { id: "calendar", label: "Market calendar", icon: "calendar", tint: "teal", group: "Markets", layout: "desk", title: "Market calendar", sub: "Expiries, holidays, lot sizes, ban list and corporate actions, with their sources", render: renderCalendarPage },
  { id: "accounts", label: "Accounts", icon: "accounts", tint: "indigo", group: "Bridge", title: "Accounts and brokers", sub: "Broker accounts, sessions and the 41 supported brokers", render: renderAccounts },
  {
    id: "api", label: "API", icon: "keys", tint: "pink", key: 9, group: "Bridge", title: "API", sub: "Keys, integrations, a test console, rate limits and the request log",
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
  { id: "recorder", label: "Data recorder", icon: "clock", tint: "indigo", group: "Bridge", layout: "desk", title: "Data recorder", sub: "Option chains recorded every minute on this computer, with the browser closed", render: renderRecorderPage },
];

/**
 * Old page ids that became tabs (ui-pass-3.md §5.2): an old link or bookmark opens the tab, keeping its ?query.
 */
export const LEGACY = {
  console: "api/console",
  limits: "api/limits",
  keys: "api/keys",
  integrations: "api/integrations",
  activity: "api/activity",
  screener: "screeners/options",
  arb: "screeners/arbitrage",
  scanner: "screeners/stocks",
  events: "screeners/events",
  participants: "oi/participants",
  journal: "orders/journal",
  watchlists: "screeners/watchlists",
};

/**
 * Where a hash leads (pure): { page, tab, query, redirect, view, layout }. `#/<page>/<tab>?query`; a LEGACY id is
 * rewritten (`redirect` is the hash to put in its place; Integrations' old `?tab=` becomes `?tool=`); an unknown page
 * is Home, an unknown or missing tab the page's last tab (`lastTab(pageId)`) or its default. `view` is the legacy page
 * id the view renders as (the `data-page` value), `layout` the tab's layout, else the page's.
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
  return { page, tab, query, redirect, view: tab?.page ?? page.id, layout: tab?.layout ?? page.layout ?? "" };
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
      // The first group (Home) has no label.
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
  const anim = motionHooks?.animateNav;
  if (typeof anim === "function") anim($("nav"));
  tabbar(active);
}

/**
 * Overflow hints (ui-pass-3.md §1.4): a scroller gets fade-l / fade-r (or fade-b, axis "y") only while there is more
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
 * Card tables (ui-pass-3.md §4): a table that fits its card is not a scroll box (.fits), so its sticky head sticks to
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

/**
 * "More" (phones and tablets): the pages not in the tab bar, grouped as in the sidebar (labels only, one row per page;
 * the current one filled with a trailing check), then appearance and the signed-in key.
 */
function moreSheet(active) {
  // Safety leads Trade here: it is the one trading page a phone keeps a tap away (the toolbar's readiness pill too).
  const pages = PAGES.filter((p) => !p.tab).sort((a, b) => (b.id === "safety") - (a.id === "safety"));
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
        h(
          "div",
          { class: "lockup" },
          symbolSvg(),
          h("span", { class: "lockup-text" }, h("span", { class: "lockup-name" }, "API Bridge"), h("span", { class: "lockup-sub" }, "by Mr. Chartist")),
        ),
        groups.map((g) =>
          h(
            "section",
            {},
            g ? h("div", { class: "eyebrow list-label" }, g) : null,
            h(
              "div",
              { class: "list" },
              pages.filter((p) => p.group === g).map((p) =>
                h(
                  "button",
                  { type: "button", class: "list-row", "aria-current": p.id === active ? "page" : undefined, onclick: () => goTo(p.id) },
                  iconTile(p.icon, p.tint, "md"),
                  h("span", { class: "names" }, h("span", { class: "nm" }, p.label)),
                  p.id === active ? checkMark() : chevron(),
                ),
              ),
            ),
          ),
        ),
        h(
          "section",
          {},
          h("div", { class: "eyebrow list-label", id: "more-appearance" }, "Appearance"),
          appearanceControl("more-appearance"),
          h("div", { class: "eyebrow list-label density-ctl more-density", id: "more-density" }, "Density"),
          densityControl("more-density"),
        ),
        h(
          "section",
          {},
          h("div", { class: "eyebrow list-label" }, "This browser"),
          h(
            "div",
            { class: "list" },
            h("div", { class: "list-row" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "names" }, h("span", { class: "nm" }, "Signed in"), h("span", { class: "sub" }, app.state.who ?? ""))),
            h("button", { type: "button", class: "list-row more-shortcuts", onclick: () => { close(undefined); showShortcutsLater(); } }, iconTile("info", "gray", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Keyboard shortcuts")), chevron()),
            h("button", { type: "button", class: "list-row", "data-action": "logout" }, iconTile("logout", "red", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Forget key"), h("span", { class: "sub" }, "Sign out of this tab"))),
          ),
        ),
        h("p", { class: "type-credit" }, TYPE_CREDIT),
      );
    },
  });
}

/**
 * The sidebar's account row opens this (an L3 popover): appearance, keyboard shortcuts, the About line (the font
 * credit) and Forget key.
 */
function accountPopover(trigger) {
  const body = h(
    "div",
    { class: "acct-pop" },
    h("span", { class: "acct-pop-label", id: "acct-appearance" }, "Appearance"),
    appearanceControl("acct-appearance"),
    h("span", { class: "acct-pop-label density-ctl", id: "acct-density" }, "Density"),
    densityControl("acct-density"),
    h(
      "div",
      { class: "acct-pop-acts" },
      h("button", { type: "button", class: "small", onclick: () => { pop.close(); showShortcutsLater(); } }, icon("info"), "Keyboard shortcuts"),
      h("button", { type: "button", class: "small plain", "data-action": "logout" }, icon("logout"), "Forget key"),
    ),
    h("p", { class: "type-credit" }, h("strong", {}, "About. "), TYPE_CREDIT),
  );
  const pop = sheetPopover({ trigger, title: app.state.who ?? "Signed in", body, cls: "acct-popover" });
  return pop;
}
const showShortcutsLater = () => setTimeout(() => import("./palette.js").then((m) => m.showShortcuts()), 260);
const chevron = () => {
  const s = icon("chevron");
  s.classList.add("chev");
  return s;
};
/** The More sheet's mark for the current page: a check in the selection ink, where the others have a chevron. */
const checkMark = () => {
  const s = icon("check");
  s.classList.add("check");
  s.setAttribute("aria-hidden", "true");
  return s;
};
/** The Mr. Chartist symbol (the sprite in index.html). */
function symbolSvg(cls = "lockup-symbol") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", cls);
  s.setAttribute("viewBox", "0 0 1024 1024");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#mc-symbol");
  s.append(use);
  return s;
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
 * touch screens are always comfortable, so the control is hidden there (app.css section 16).
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

/** Stop the page's refresh timer (a page that pauses its own refresh). */
export const stopTimer = () => clearInterval(timer);
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

/** The page's large title: plain text, with at most one word in the serif accent. */
function headline(page) {
  return (page.headline ?? [page.title]).map((part) => (typeof part === "string" ? part : h("em", { class: "serif" }, part.serif)));
}
/** Home's eyebrow is today's date in IST; every other page names its group. */
const IST_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" });

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
  if (page.id === "chain") local.set(FLAG.chain, "1"); // ticks the Home checklist step
  const changed = route.view !== shownPage;
  shownPage = route.view;
  clearInterval(timer);
  $("toast").hidden = true;
  nav(page.id);
  // Pages can restyle the shell (the Option Desk hides the large title and runs edge to edge). data-page is the view's
  // own id (a tab's legacy page id), data-route the page in the menu.
  const root = $("content");
  document.documentElement.dataset.page = route.view;
  document.documentElement.dataset.route = page.id;
  document.documentElement.dataset.layout = route.layout;
  document.documentElement.classList.remove("panel-max-open");
  root.classList.toggle("api-page", page.id === "api");
  document.title = tab ? `${tab.label} · ${page.label} · Mr. Chartist API Bridge` : `${page.label} · Mr. Chartist API Bridge`;
  $("toolbar-icon").replaceChildren(pageGlyph(page));
  // The page name only: the tab strip right under it names the tab ("API: Integrations" clipped on phones).
  $("toolbar-label").textContent = page.label;
  $("page-eyebrow").textContent = page.id === "home" ? IST_DAY.format(new Date()) : page.group;
  $("page-title").replaceChildren(...headline(page));
  $("page-sub").textContent = tab?.sub ?? page.sub;
  $("toolbar-demo").hidden = !app.state.demo;
  // The Options pages mount their context (underlying, expiry, spot, live) here on render; every other page has none.
  const ctx = $("toolbar-ctx");
  if (changed || route.layout !== "desk") {
    ctx.replaceChildren();
    ctx.hidden = true;
  }
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
  root.replaceChildren(...[tabs, h("p", { class: "muted" }, "Loading…")].filter(Boolean));
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
 * The tab strip of a tabbed page (ui-pass-3.md §5.2): a segmented tab list, the page's first row. Picking a tab goes
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

/** The toolbar's search (a labelled pill on wide screens, an icon on phones) and refresh, and the sidebar's search. */
function setupChrome() {
  const mod = modKey();
  const shortcut = mod === "⌘" ? "⌘K" : "Ctrl+K";
  const aria = mod === "⌘" ? "Meta+K" : "Control+K";
  $("toolbar-actions").replaceChildren(
    h("button", { type: "button", class: "toolbar-search search-hint", title: `Search pages and actions (${shortcut})`, "aria-keyshortcuts": aria, onclick: () => openPalette() }, searchIcon(), h("span", { class: "lbl" }, "Search pages and actions"), kbd(mod, "K")),
    h("button", { type: "button", class: "icon-btn toolbar-search-m", "aria-label": "Search pages and actions", "aria-keyshortcuts": aria, onclick: () => openPalette() }, searchIcon()),
    h("button", { type: "button", class: "icon-btn toolbar-refresh", title: "Reload this page's data", "aria-label": "Reload this page's data", onclick: () => show({ refresh: true }) }, icon("refresh")),
  );
  // The API budget indicator (budget.js), fed by the shared live connection.
  const budgetSlot = $("toolbar-budget");
  if (budgetSlot && !budgetSlot.dataset.ready) {
    budgetSlot.dataset.ready = "1";
    mountBudget(budgetSlot, live);
    // A saved scan's new matches (Screeners › Stocks) as a toast on any page; they are rows in Live events too.
    live.onScanAlerts((m) => {
      const names = (m.newMatches ?? []).map((s) => String(s).split(":").pop());
      if (names.length) toast(`Scan "${m.name ?? "Saved scan"}": ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${formatInt(names.length - 4)} more` : ""} new`, { tone: "info" });
    });
  }
  // Hover or focus a menu item: load that page's module and warm its data, so the click paints at once.
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
  // A page painted from remembered answers is drawn again once, when a fresh answer differs. The Options pages
  // refresh themselves every few seconds, and a person typing or reading a dialog is never interrupted.
  onRevalidated(() => {
    if (redrawnFor === renderSeq) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      if (redrawnFor === renderSeq || document.documentElement.dataset.layout === "desk") return;
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
    sb.title = `Search pages and actions (${shortcut})`;
    sb.setAttribute("aria-label", "Search pages and actions");
    sb.setAttribute("aria-keyshortcuts", aria);
    sb.prepend(searchIcon());
    sb.append(kbd(mod, "K"));
    sb.addEventListener("click", () => openPalette());
  }
  // The IST clock in the toolbar (wide screens). It claims nothing about the market being open.
  const clock = $("clock");
  const IST_CLOCK = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const tick = () => {
    if (clock && clock.offsetParent !== null) clock.replaceChildren(IST_CLOCK.format(new Date()), h("small", {}, "IST"));
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

// Motion helpers (animatePage / animateNav), when motion.js provides them. Loaded lazily so Node tests never touch it.
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

// ── Home ──

async function renderHome() {
  const [accounts, keys, usage, safety, streams, orders] = await Promise.all([
    api("/v1/accounts"),
    optional(api("/v1/keys")),
    optional(api("/v1/usage")),
    optional(api("/v1/safety")),
    optional(api("/v1/stream/stats")),
    optional(api("/v1/orders?limit=100")),
  ]);
  const accs = accounts.data.data ?? [];
  const keyRows = keys.data?.data ?? [];
  const nodes = [];

  // Welcome checklist
  if (!local.get(FLAG.hideChecklist)) {
    const ordersAll = orders.data?.data ?? [];
    // Remember a paper trade once seen, so the step stays ticked after today's orders roll over.
    if (ordersAll.some((o) => o?.mode === "paper" && o.tag !== "DEMOSEED")) local.set(FLAG.traded, "1");
    const state = checklistState({ demo: app.state.demo, accounts: accs, keys: keyRows, chainOpened: local.get(FLAG.chain), traded: local.get(FLAG.traded), orders: ordersAll });
    const done = state.filter((s) => s.done).length;
    // The broker step goes straight to the next action: add a broker when there is none, else log in.
    const hasBroker = accs.some((a) => a.broker !== "paper");
    const ITEMS = {
      broker: app.state.demo
        ? { title: "Explore with sample data, or add your broker", text: "Demo mode is on: everything works with sample prices. Add your broker to see what connecting it takes and save it for your next normal start.", go: "accounts?add=1", cta: "Add your broker" }
        : hasBroker
          ? { title: "Log in to your broker", text: "Open Accounts and press Log in. Most brokers ask again every morning; it takes a few seconds.", go: "accounts", cta: "Log in" }
          : { title: "Add your broker and log in", text: "Choose your broker, then log in with its API details, right here. Nothing is sent anywhere but your broker.", go: "accounts?add=1", cta: "Add a broker" },
      key: { title: "Create a key for Excel or AI", text: "Pick the tool and get a key with a setup ready to paste (Excel formula, Claude config, Python).", go: "api/keys", cta: "Create a key" },
      chain: { title: "Open the option chain", text: "Prices, OI and Greeks for NIFTY, BANKNIFTY and SENSEX. Click any price to open a trade ticket.", go: "chain", cta: "Option Chain" },
      trade: { title: "Place a paper trade", text: "Click a bid or ask in the chain, check the ticket and send it. Paper only: no real money moves.", go: "chain", cta: "Try it" },
    };
    const fill = h("span");
    fill.style.width = `${(done / state.length) * 100}%`;
    const allDone = done === state.length;
    const hideBtn = h("button", { type: "button", class: "plain small", onclick: () => { local.set(FLAG.hideChecklist, "1"); show(); } }, "Hide");
    const list = h(
      "div",
      { class: "checklist", id: "home-checklist" },
      state.map((s) =>
        h("div", { class: `check-item${s.done ? " done" : ""}` }, h("span", { class: "tick", "aria-hidden": "true" }, icon("check")), h("div", { class: "what" }, h("strong", {}, ITEMS[s.id].title, s.done ? h("span", { class: "pal-sr-only" }, " (done)") : null), h("span", {}, ITEMS[s.id].text)), h("button", { type: "button", class: s.done ? "small" : "small primary", onclick: () => (location.hash = `#/${ITEMS[s.id].go}`) }, ITEMS[s.id].cta)),
      ),
    );
    const progress = h("div", { class: "progress", role: "img", "aria-label": `${done} of ${state.length} steps done` }, h("div", { class: "bar ok" }, fill));
    if (done === 0) {
      nodes.push(
        card({
          glyph: "check",
          tint: "green",
          cls: "home-start",
          title: "Get started",
          sub: `${formatInt(done)} of ${formatInt(state.length)} done. Each step ticks itself off as you go.`,
          actions: h("div", { class: "row" }, progress, hideBtn),
          flush: true,
          body: list,
        }),
      );
    } else {
      // Once a step is done the card is one line (title, count, progress, next step) that opens on a tap, so the
      // cockpit starts on the first screen of a phone. Open or shut is kept for this browser tab only.
      const next = state.find((s) => !s.done);
      const open = tabStore.get(FLAG.checklistOpen) === "1";
      list.hidden = !open;
      const foot = h("div", { class: "start-foot" }, h("span", {}, allDone ? "Every first step is done. Hide this when you like; it stays hidden." : "Each step ticks itself off as you go."), hideBtn);
      foot.hidden = !open;
      const toggle = h(
        "button",
        { type: "button", class: "start-row", "aria-expanded": String(open), "aria-controls": "home-checklist" },
        iconTile("check", "green", "sm"),
        h("span", { class: "start-t" }, h("strong", {}, allDone ? "You are all set" : "Get started"), h("small", {}, allDone ? `${formatInt(done)} of ${formatInt(state.length)} done` : `${formatInt(done)} of ${formatInt(state.length)} done · next: ${ITEMS[next.id].cta}`)),
        progress,
        h("span", { class: "start-chev", "aria-hidden": "true" }, icon("chevron")),
      );
      toggle.addEventListener("click", () => {
        const on = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(on));
        list.hidden = !on;
        foot.hidden = !on;
        tabStore.set(FLAG.checklistOpen, on ? "1" : null);
      });
      nodes.push(h("section", { class: "card home-start compact" }, toggle, list, foot));
    }
  }

  // The cockpit: indices, P&L today, open positions with risk, live events, today's calendar, API and broker health.
  const readySnap = await refreshReadiness();
  const { cockpit } = await import("./cockpit.js");
  const ck = await cockpit({ accs, orders, streams, usage, safety, keys, readyPill: readySnap ? readinessPill(readySnap) : null });
  nodes.push(...ck.nodes);
  every(5000, ck.refresh);
  return nodes;
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

/** A metric card: tinted icon and label, the figure, a footnote (IPO Decode's Metric). */
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
const field = (labelText, input, hint) => h("label", { class: "field", for: input.id }, h("span", {}, labelText), input, hint ? h("span", { class: "hint" }, hint) : null);

/** A failed call as an alert, with the Bridge's per-field messages (field names only, never values) when it sent any. */
function errorBox(err, labels = {}) {
  const box = alertBox(err);
  const errors = Array.isArray(err?.body?.errors) ? err.body.errors : [];
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

/** The holder text an account card shows (P1-13 §6.8): "Asha · Spouse · Family" / "friend · Other · Outside family". */
export function holderText(entry) {
  if (!entry) return null;
  const rel = entry.relationship ? HOLDER_REL[entry.relationship] ?? entry.relationship : "No relationship";
  const who = entry.label || entry.holder;
  return `${who} · ${rel} · ${entry.inFamily ? "Family" : "Outside family"}`;
}
/** The Accounts row's holder line under its Family pill: "You (demo) · Self". */
const holderWhoText = (e) => `${e.label || e.holder} · ${e.relationship ? HOLDER_REL[e.relationship] ?? e.relationship : "No relationship"}`;
const HOLDER_REL = { self: "Self", spouse: "Spouse", "dependent-child": "Dependent child", "dependent-parent": "Dependent parent", huf: "HUF", other: "Other" };

/** Edit a holder's relationship and label (PUT /v1/book/holders/{holder}: admin, this computer). */
function holderSheet(entry, relationships) {
  const err = h("div", { "aria-live": "polite" });
  const sel = h("select", { "aria-label": "Relationship" }, relationships.map((r) => h("option", { value: r.value, selected: r.value === entry.relationship }, `${r.label}${r.inFamily ? " · family" : ""}`)));
  const label = h("input", { type: "text", maxlength: "40", value: entry.label && entry.label !== entry.holder ? entry.label : "", placeholder: "A name you recognise (optional)" });
  return modal({
    title: `Holder: ${entry.holder}`,
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted small" }, `Accounts: ${entry.accounts.join(", ") || "none visible"}. The relationship decides whether guards and alert actions may act on these accounts.`),
      h("label", { class: "field" }, "Relationship", sel),
      h("label", { class: "field" }, "Label", label),
      err,
    ),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Save",
        cls: "primary",
        onClick: async () => {
          try {
            await api(`/v1/book/holders/${encodeURIComponent(entry.holder)}`, { method: "PUT", body: { relationship: sel.value, ...(label.value.trim() ? { label: label.value.trim() } : {}) } });
            return true;
          } catch (e) {
            err.replaceChildren(errorBox(e));
            return false;
          }
        },
      },
    ],
  }).then((saved) => {
    if (saved) show().then(() => toast(`Saved the relationship for ${entry.holder}`));
  });
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
  const [accounts, brokers, holdersRes] = await Promise.all([api("/v1/accounts"), api("/v1/brokers"), optional(api("/v1/book/holders"))]);
  const accs = accounts.data.data ?? [];
  const book = holdersRes.data?.data ?? null;
  const holderOfAcc = (id) => book?.holders.find((x) => x.accounts.includes(id)) ?? null;
  const holderCell = (a) => {
    const e = holderOfAcc(a.id);
    if (!e) return null;
    // Two short lines, like the Account cell beside it: the deciding Family pill and Edit, then who and how related.
    return h(
      "div",
      { class: "acct-holder", title: `Holder: ${holderText(e)}` },
      h(
        "span",
        { class: "acct-holder-top" },
        h("span", { class: "bk-rel", "data-tone": e.inFamily ? "ok" : "warn" }, e.inFamily ? "Family" : "Outside family"),
        e.locked ? h("span", { class: "muted small" }, "set in bridge.config.json") : h("button", { type: "button", class: "small link-btn", "aria-label": `Edit the relationship of holder ${e.holder}`, onclick: () => holderSheet(e, book.relationships) }, "Edit"),
      ),
      h("span", { class: "muted small acct-holder-who" }, holderWhoText(e)),
    );
  };
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
        ...(book ? [{ label: "Holder", cell: (a) => holderCell(a) ?? h("span", { class: "muted small" }, "No holder") }] : []),
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
  // P1-13 §6.8: what "family" means here, under the accounts.
  if (book && accs.length) {
    const fam = book.relationships.filter((r) => r.inFamily).map((r) => r.label.toLowerCase());
    accountsCard.querySelector(".card-body")?.append(h("p", { class: "muted small acct-family-note" }, `Family = ${fam.join(", ")} (book.family in the config file). Guards and alert actions work only on family accounts. Managing money for anyone else needs SEBI registration.`));
  }

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

  // #/accounts?reset=<paper id>, from a "short of margin" block: open the reset sheet for that paper account.
  const resetId = /[?&]reset=([a-z0-9-]+)/.exec(location.hash)?.[1];
  if (resetId) {
    history.replaceState(null, "", "#/accounts");
    const acc = accs.find((x) => x.id === resetId && x.broker === "paper");
    if (acc) setTimeout(() => paperResetSheet(acc), 0);
  }
  // #/accounts?add=1 (or ?add=<broker id>), from the Home page: open the sheet once the page is drawn.
  const want = /[?&]add=([a-z0-9]+)/.exec(location.hash)?.[1];
  if (want) {
    history.replaceState(null, "", "#/accounts");
    setTimeout(() => addAccountFlow(list, { preselect: want }), 0);
  }
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
    curlBox.replaceChildren(codeBlock(cmd, { title: "Same call from a terminal", onCopy: markCopied }));
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
      local.set(FLAG.tested, "1");
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
  nodes.push(
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
  nodes.push(
    card({
      glyph: "orders",
      tint: "orange",
      title: "Today's orders",
      // Orders are placed from the chain's ticket; the JSON route is for trying the API (API › Test console).
      actions: h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "small quiet", onclick: () => (location.hash = "#/api/console?endpoint=order") }, "Send as JSON"),
        h("button", { type: "button", class: "small primary", onclick: () => (location.hash = "#/chain") }, "Trade from the chain"),
      ),
      flush: true,
      body: orders.error
        ? h("div", { class: "card-body" }, alertBox(orders.error))
        : table(
            [
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
                  return h("div", { class: "order-status" }, pill(t.text, t.tone), o.statusMessage && ["rejected", "expired", "outcome_unknown"].includes(o.status) ? h("div", { class: "muted small order-why" }, o.statusMessage) : null);
                },
              },
              { label: "Mode", cell: (o) => (o.mode === "live" ? pill("Live", "bad") : pill("Paper")) },
              { label: "", cell: (o) => (WORKING_ORDER.has(o.status) ? orderActions(o) : "") },
            ],
            ord,
            emptyState("orders", "No orders today", "Paper orders from the option chain, your scripts, webhooks and AI assistants show up here.", nextStep("Trade from the chain", "#/chain")),
          ),
    }),
  );

  // One summary line per paper account; the positions themselves live on the Positions page.
  const paper = accs.filter((x) => x.broker === "paper");
  if (paper.length) {
    const sums = await Promise.all(
      paper.map(async (a) => {
        const [pos, funds] = await Promise.all([optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`))]);
        const f = funds.data?.data?.funds ?? funds.data?.data ?? {};
        const rows = pos.data?.data ?? null;
        return { a, f, open: rows ? rows.filter((p) => Number(p.netQty) !== 0).length : null };
      }),
    );
    nodes.push(
      card({
        glyph: "wallet",
        tint: "teal",
        title: "Paper accounts",
        sub: "Open positions, margin and P&L in one line each. Positions has the legs, the payoff and the exits.",
        flush: true,
        body: table(
          [
            { label: "Account", cell: ({ a }) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small mono" }, a.id)) },
            { label: "Open positions", num: true, cell: ({ open }) => formatInt(open) },
            { label: "Cash", num: true, cell: ({ f }) => formatRupee(f.availableCash) },
            { label: "Used margin", num: true, cell: ({ f }) => formatRupee(f.usedMargin) },
            { label: "Realised", num: true, cell: ({ f }) => pnl(f.realisedPnl) },
            { label: "Unrealised", num: true, cell: ({ f }) => pnl(f.unrealisedPnl) },
            { label: "", cell: ({ a }) => h("button", { type: "button", class: "small", "aria-label": `Positions of ${a.label}`, onclick: () => (location.hash = "#/positions") }, "Positions", icon("chevron")) },
          ],
          sums,
        ),
      }),
    );
  }
  return nodes;
}

/** Modify and Cancel for a working order (PATCH / DELETE /v1/orders/{id}); each answers with a toast and a redraw. */
function orderActions(o) {
  const name = contractName(o.symbol);
  const modify = async () => {
    const qty = h("input", { id: "mod-qty", type: "number", min: "1", step: "1", inputmode: "numeric", value: String(o.quantity ?? "") });
    const price = h("input", { id: "mod-price", type: "number", min: "0.05", step: "0.05", inputmode: "decimal", value: isFigure(o.price) ? String(o.price) : "" });
    const err = h("div", { "aria-live": "polite" });
    const limit = o.orderType === "LIMIT" || o.orderType === "SL";
    const ok = await modal({
      title: `Modify ${o.side === "BUY" ? "buy" : "sell"} ${name}`,
      body: h("div", { class: "stack" }, h("div", { class: "form-grid" }, field("Quantity", qty, `Filled so far: ${formatInt(o.filledQuantity ?? 0)}`), limit ? field("Limit price", price) : null), err),
      buttons: [
        { label: "Keep as is", value: false },
        {
          label: "Save change",
          cls: "primary",
          onClick: async () => {
            const body = {};
            const q = Math.floor(Number(qty.value));
            if (!(q >= 1)) return fieldError(qty, "Quantity must be 1 or more.");
            if (q !== o.quantity) body.quantity = q;
            if (limit) {
              const px = Number(price.value);
              if (!(px > 0)) return fieldError(price, "Enter a limit price above 0.");
              if (px !== o.price) body.price = px;
            }
            if (!Object.keys(body).length) return fieldError(limit ? price : qty, "Change the quantity or the price first.");
            try {
              await api(`/v1/orders/${encodeURIComponent(o.orderId)}`, { method: "PATCH", body });
              return true;
            } catch (e) {
              err.replaceChildren(errorBox(e, { quantity: "Quantity", price: "Limit price" }));
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
  const s = (await api("/v1/safety")).data.data;
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
    h("div", { class: "stack" }, h("h2", {}, ks.engaged ? "Kill switch is on: no orders are sent" : "Kill switch is off"), h("p", { class: "muted" }, ks.engaged ? `Engaged ${istDateTime(ks.at)} by ${ks.by ?? "?"}: ${ks.reason ?? ""}` : "One click stops every new order from every tool: REST, webhooks, AI assistants and the CLI. Also: mc-bridge kill.")),
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
        { label: "Account", cell: (a) => h("strong", {}, a.accountId) },
        { label: "Orders today", num: true, cell: (a) => `${formatInt((a.ordersToday ?? 0) + (a.paperOrdersToday ?? 0))} / ${formatInt(a.limits?.dailyMaxOrders)}` },
        { label: "P&L today", num: true, cell: (a) => pnl(isFigure(a.realisedPnlToday) || isFigure(a.paperRealisedPnlToday) ? (a.realisedPnlToday ?? 0) + (a.paperRealisedPnlToday ?? 0) : null) },
        { label: "Max loss", num: true, cell: (a) => formatRupeeGrouped(a.limits?.dailyMaxLoss, 2) },
        { label: "Max order value", num: true, cell: (a) => formatRupeeGrouped(a.limits?.maxOrderValue, 2) },
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
  // Trading readiness (docs/spec/p1-05-readiness.md §6.4): between the kill switch and live trading.
  const ready = await readinessCard({ cardFn: card, demo: app.state.demo }).catch(() => null);
  return [killCard, ready, limits, h("div", { class: "grid side" }, live, audit)].filter(Boolean);
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
  const draw = () => body.replaceChildren(...(all[seg.value] ?? []).map((sn) => codeBlock(sn.code, { title: sn.title, json: sn.lang === "json", onCopy: markCopied })));
  seg.addEventListener("change", draw);
  draw();
  const keyCode = h("code", { class: "new-key-value" }, key);
  return h(
    "section",
    { class: "new-key", "aria-label": `New key ${label}`, tabindex: "-1" },
    h("div", { class: "new-key-head" }, h("span", { class: "new-key-tick", "aria-hidden": "true" }, icon("check")), h("div", { class: "grow" }, h("strong", {}, `Key created: ${label}`), h("span", { class: "muted small" }, `${scopes.join(" + ")} access · ${use.label}`))),
    alertBox({ title: "Copy it now. It is shown only once.", detail: "The Bridge keeps only a fingerprint of it. If you lose it, revoke it below and create another." }, "warn"),
    h("div", { class: "new-key-row" }, keyCode, copyButton(key, { label: "Copy key", toastLabel: "Key copied", cls: "primary", onCopy: markCopied })),
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
    if (s.length) parts.push(h("div", { class: "card-body stack" }, s.map((sn) => codeBlock(sn.code, { title: sn.title, json: sn.lang === "json", onCopy: markCopied }))));
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
  const lots = h("input", { type: "number", value: "1", min: "1", max: "50" });
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
        h("div", { class: "secret-box" }, h("strong", {}, "Webhook URL (its secret token is shown once):"), h("code", {}, d.url), copyButton(d.url, { cls: "small primary", toastLabel: "URL copied", onCopy: markCopied })),
        d.signingSecret ? h("div", { class: "secret-box" }, h("strong", {}, "Signing secret (shown once; sign every request with it):"), h("code", {}, d.signingSecret), copyButton(d.signingSecret, { cls: "small primary", toastLabel: "Secret copied", onCopy: markCopied })) : null,
        ...(d.templates ?? []).slice(0, 1).map((t) => codeBlock(t.message, { title: t.name, json: t.contentType === "application/json" && t.message.startsWith("{"), onCopy: markCopied })),
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
  // #/api/activity?view=audit opens the audit log (the ⌘K "Audit log" entry).
  let active = hashParams().get("view") === "audit" ? "audit" : "requests";
  let showAll = false;
  const hideOwn = h("input", { type: "checkbox" });
  hideOwn.checked = local.get(FLAG.hideOwn) !== "0";
  hideOwn.addEventListener("change", () => {
    local.set(FLAG.hideOwn, hideOwn.checked ? null : "0");
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
