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
  copyText,
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
  DEMO_EXPLAINER,
} from "./app.js";
import { DASH, formatFixed, formatInt, formatRupee, formatSigned, isFigure } from "./format.js";
import { renderArbPage, renderChainPage, renderOiPage, renderPositionsPage, renderStrategyPage, renderVolPage } from "./desk.js";
import { renderCalendarPage } from "./calendar.js";
import { renderScreenerPage } from "./screener.js";
import { KEY_PRESETS, snippets } from "./snippets.js";
import { initPalette, kbd, modKey, openPalette, pageShortcut, searchIcon } from "./palette.js";

const $ = (id) => document.getElementById(id);
const local = app.local;
const FLAG = { copied: "mcb.dashboard.copied", tested: "mcb.dashboard.tested", hideChecklist: "mcb.dashboard.hideChecklist", hideOwn: "mcb.dashboard.hideOwnRequests" };
const markCopied = () => local.set(FLAG.copied, "1");
const scopeChip = (s) => h("span", { class: `chip scope-${s}` }, s);
/** Sentence case for a status word from the API ("filled" → "Filled"). */
export const cap = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : DASH);
const sessionPill = (s) => pill(cap(s), s === "connected" ? "ok" : s === "expired" || s === "error" ? "bad" : "warn");
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
export function pnl(v) {
  if (!isFigure(v)) return DASH;
  const text = formatRupee(Math.abs(Number(v)));
  const n = Number(formatFixed(v, 2));
  return h("span", { class: n > 0 ? "up" : n < 0 ? "down" : undefined }, n > 0 ? `+${text}` : n < 0 ? `-${text}` : text);
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

/**
 * The one list of pages: it feeds the sidebar, the phone tab bar, the More sheet and the ⌘K palette. `tint` is an iOS
 * system colour name (the page's glyph colour everywhere), `tab: true` puts it in the phone tab bar (`short` labels it there), `headline` is the
 * large title when it differs from `title` (one serif accent word at most).
 */
export const PAGES = [
  { id: "home", label: "Home", icon: "home", tint: "blue", tab: true, group: "Overview", title: "Home", headline: ["Your ", { serif: "Bridge" }], sub: "Your accounts, today's activity and safety, on this computer", render: renderHome },
  { id: "accounts", label: "Accounts", icon: "accounts", tint: "indigo", group: "Overview", title: "Accounts and brokers", sub: "Broker accounts, sessions and the 41 supported brokers", render: renderAccounts },
  { id: "console", label: "Test console", icon: "console", tint: "teal", group: "Overview", title: "Test console", sub: "Try any call and see exactly what comes back", render: renderConsole },
  { id: "limits", label: "Rate limits", icon: "limits", tint: "purple", group: "Overview", title: "Rate limits", sub: "Live usage against each broker's limits, and the calls the Bridge saved", render: renderLimits },
  { id: "scanner", label: "Scanner", icon: "scan", tint: "mint", group: "Overview", title: "Scanner", sub: "Scan big universes with a readable condition, shared out over your accounts", render: renderScanner },
  { id: "chain", label: "Option Chain", short: "Chain", icon: "chart", tint: "green", tab: true, group: "Options", layout: "desk", title: "Option Chain", get sub() { return `Live chain with OI, IV and Greeks. ${touchWord()} a bid or ask to trade`; }, render: renderChainPage },
  { id: "strategy", label: "Strategy Builder", icon: "strategy", tint: "purple", group: "Options", layout: "desk", title: "Strategy Builder", sub: "Payoff, breakevens, POP and margin before you trade", render: renderStrategyPage },
  { id: "oi", label: "OI Analysis", icon: "bars", tint: "orange", group: "Options", layout: "desk", title: "OI Analysis", sub: "Open interest and OI chg by strike, build-up and walls", render: renderOiPage },
  { id: "vol", label: "Volatility", icon: "wave", tint: "pink", group: "Options", layout: "desk", title: "Volatility", sub: "Smile, skew, term structure and expected move", render: renderVolPage },
  { id: "screener", label: "Option Screener", short: "Screener", icon: "radar", tint: "yellow", group: "Options", layout: "desk", title: "Option Screener", sub: "Scan every underlying and expiry for unusual activity, build-ups, rich or cheap premium, hedges and arbitrage", render: renderScreenerPage },
  { id: "arb", label: "Arbitrage", icon: "scale", tint: "indigo", group: "Options", layout: "desk", title: "Arbitrage scanner", sub: "Parity, boxes and futures basis at executable prices, after charges", render: renderArbPage },
  { id: "positions", label: "Positions", icon: "wallet", tint: "teal", group: "Options", layout: "desk", title: "Option positions", sub: "Open option positions with P&L, net Δ and θ", render: renderPositionsPage },
  { id: "calendar", label: "Market calendar", icon: "calendar", tint: "teal", group: "Options", layout: "desk", title: "Market calendar", sub: "Expiries, holidays, lot sizes, ban list and corporate actions, with their sources", render: renderCalendarPage },
  { id: "orders", label: "Orders", icon: "orders", tint: "orange", tab: true, group: "Trading", title: "Orders and positions", sub: "Paper by default. Pending confirmations wait here", render: renderOrders },
  { id: "safety", label: "Safety", icon: "safety", tint: "red", tab: true, group: "Trading", title: "Safety", sub: "Kill switch, daily limits and live-trading status", render: renderSafety },
  { id: "keys", label: "API keys", icon: "keys", tint: "pink", group: "Connect", title: "API keys", sub: "One key per tool, with only the access it needs", render: renderKeys },
  { id: "integrations", label: "Integrations", icon: "integrations", tint: "blue", group: "Connect", title: "Integrations", sub: "Copy-paste setup for webhooks, Python, Excel, Claude and more", render: renderIntegrations },
  { id: "activity", label: "Activity", icon: "activity", tint: "gray", group: "Connect", title: "Activity", sub: "Recent requests and the tamper-evident audit log", render: renderActivity },
];

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
      out.push(h("div", { class: "nav-group" }, group));
    }
    const sc = pageShortcut(PAGES.indexOf(p));
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
  const anim = motionHooks?.animateNav;
  if (typeof anim === "function") anim($("nav"));
  tabbar(active);
}

/** The phone / tablet tab bar: the four `tab` pages and More (a sheet with every page, appearance and the key). */
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

/** "More" (phones and tablets): every page grouped as in the sidebar, appearance, and the signed-in key. */
function moreSheet(active) {
  const groups = [...new Set(PAGES.map((p) => p.group))];
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
            h("div", { class: "eyebrow list-label" }, g),
            h(
              "div",
              { class: "list" },
              PAGES.filter((p) => p.group === g).map((p) =>
                h(
                  "button",
                  { type: "button", class: "list-row", "aria-current": p.id === active ? "page" : undefined, onclick: () => goTo(p.id) },
                  iconTile(p.icon, p.tint, "md"),
                  h("span", { class: "names" }, h("span", { class: "nm" }, p.label), h("span", { class: "sub" }, p.sub)),
                  chevron(),
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
        ),
        h(
          "section",
          {},
          h("div", { class: "eyebrow list-label" }, "This browser"),
          h(
            "div",
            { class: "list" },
            h("div", { class: "list-row" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { class: "names" }, h("span", { class: "nm" }, "Signed in"), h("span", { class: "sub" }, app.state.who ?? ""))),
            h("button", { type: "button", class: "list-row", onclick: () => { close(undefined); showShortcutsLater(); } }, iconTile("info", "gray", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Keyboard shortcuts")), chevron()),
            h("button", { type: "button", class: "list-row", "data-action": "logout" }, iconTile("logout", "red", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Forget key"), h("span", { class: "sub" }, "Sign out of this tab"))),
          ),
        ),
      );
    },
  });
}
const showShortcutsLater = () => setTimeout(() => import("./palette.js").then((m) => m.showShortcuts()), 260);
const chevron = () => {
  const s = icon("chevron");
  s.classList.add("chev");
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

/** The page's large title: plain text, with at most one word in the serif accent. */
function headline(page) {
  return (page.headline ?? [page.title]).map((part) => (typeof part === "string" ? part : h("em", { class: "serif" }, part.serif)));
}
/** Home's eyebrow is today's date in IST; every other page names its group. */
const IST_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" });

async function show() {
  const raw = location.hash.replace(/^#\/?/, "").split("?")[0];
  // A one-time sign-in fragment (#signin=..., app.js removes it at start-up) is never a page name.
  const id = (raw && !raw.startsWith("signin=") ? raw : "home").toLowerCase();
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0];
  const changed = page.id !== shownPage;
  shownPage = page.id;
  clearInterval(timer);
  $("toast").hidden = true;
  nav(page.id);
  // Pages can restyle the shell (the Option Desk hides the large title and runs edge to edge).
  document.documentElement.dataset.page = page.id;
  document.documentElement.dataset.layout = page.layout ?? "";
  document.documentElement.classList.remove("panel-max-open");
  document.title = `${page.label} · Mr. Chartist API Bridge`;
  $("toolbar-icon").replaceChildren(pageGlyph(page));
  $("toolbar-label").textContent = page.label;
  $("page-eyebrow").textContent = page.id === "home" ? IST_DAY.format(new Date()) : page.group;
  $("page-title").replaceChildren(...headline(page));
  $("page-sub").textContent = page.sub;
  $("toolbar-demo").hidden = !app.state.demo;
  // The Options pages mount their context (underlying, expiry, spot, live) here on render; every other page has none.
  const ctx = $("toolbar-ctx");
  if (changed || page.layout !== "desk") {
    ctx.replaceChildren();
    ctx.hidden = true;
  }
  const seq = ++renderSeq;
  const root = $("content");
  root.setAttribute("aria-busy", "true");
  root.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  try {
    const nodes = await page.render();
    if (seq !== renderSeq) return;
    root.replaceChildren(...[nodes].flat());
    arrangePanels(root, page.id);
  } catch (err) {
    if (seq !== renderSeq) return;
    root.replaceChildren(alertBox(err));
  }
  root.removeAttribute("aria-busy");
  announce(changed ? `${page.title} page` : `${page.title} refreshed`);
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
  const items = [...root.children].filter((el) => !el.hasAttribute("data-fixed") && !el.matches("p, .alert"));
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
  const mo = new MutationObserver(() => labelTables(content));
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
    h("button", { type: "button", class: "icon-btn toolbar-refresh", title: "Reload this page's data", "aria-label": "Reload this page's data", onclick: () => show() }, icon("refresh")),
  );
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
  // The sidebar's appearance buttons get their glyphs here (index.html carries the words).
  for (const b of document.querySelectorAll("#theme [data-theme-choice]")) if (!b.querySelector("svg")) b.prepend(icon({ light: "sun", dark: "moon", auto: "monitor" }[b.dataset.themeChoice] ?? "monitor"));
  // The IST clock in the toolbar (wide screens). It claims nothing about the market being open.
  const clock = $("clock");
  const IST_CLOCK = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const tick = () => {
    if (clock && clock.offsetParent !== null) clock.replaceChildren(IST_CLOCK.format(new Date()), h("small", {}, "IST"));
  };
  tick();
  setInterval(tick, 1000);
}

/** Go to a page from the palette or a shortcut; focus moves into the page (or to `focusSelector`) once it is drawn. */
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
  initPalette({ pages: () => PAGES, go, refresh: () => show() });
  try {
    motionHooks = await import("./motion.js");
  } catch {
    motionHooks = null;
  }
  window.addEventListener("hashchange", show);
  show();
}

// ── Scanner ──

const SCAN_EXAMPLES = [
  "rsi(14) > 60 and close > sma(50)",
  "close crosses above ema(20) and volume > 1.5 * avg_volume(20)",
  "close > highest(20)[1]",
  "macd() crosses above macd_signal()",
  "close > supertrend(10, 3) and change_pct > 2",
];

async function renderScanner() {
  const [universes, backup, jobs] = await Promise.all([optional(api("/v1/scanner/universes")), optional(api("/v1/backup/status")), optional(api("/v1/scanner/jobs"))]);
  const uni = h("select", { "aria-label": "Universe" }, h("option", { value: "" }, "My symbols (below)"), (universes.data?.data ?? []).map((u) => h("option", { value: u.name, selected: u.name === "NIFTY50" }, `${u.name}${u.size ? ` (${u.size})` : ""}`)));
  const syms = h("input", { placeholder: "NSE:RELIANCE, NSE:TCS …", spellcheck: "false" });
  syms.disabled = Boolean(uni.value);
  uni.addEventListener("change", () => (syms.disabled = Boolean(uni.value)));
  const interval = h("select", { "aria-label": "Interval" }, ["1d", "1w", "60m", "30m", "15m", "5m", "1m"].map((i) => h("option", { value: i }, i)));
  const source = h("select", { "aria-label": "Source" }, h("option", { value: "auto" }, "Brokers, then backup"), h("option", { value: "broker" }, "Brokers only"), h("option", { value: "backup" }, "Backup only (Yahoo)"));
  const cond = h("textarea", { id: "scan-condition", rows: 3, spellcheck: "false" }, SCAN_EXAMPLES[0]);
  const cols = h("input", { value: "rsi(14), close / sma(50) - 1", spellcheck: "false" });
  const sortBy = h("input", { value: "rsi(14)", spellcheck: "false" });
  const examples = h("div", { class: "row", role: "group", "aria-label": "Example conditions" }, SCAN_EXAMPLES.map((e) => h("button", { type: "button", class: "small example", title: "Use this condition", onclick: () => { cond.value = e; cond.focus(); } }, e)));
  const out = h("div", { class: "stack" });
  const planBtn = h("button", { type: "button", class: "" }, icon("info"), "Plan");
  const runBtn = h("button", { type: "button", class: "primary" }, icon("play"), "Run scan");

  const request = () => {
    const r = { interval: interval.value, condition: cond.value.trim(), source: source.value };
    if (uni.value) r.universe = uni.value;
    else r.symbols = syms.value.split(/[\s,]+/).filter(Boolean);
    const c = cols.value.split(",").map((x) => x.trim()).filter(Boolean);
    if (c.length) r.columns = c;
    if (sortBy.value.trim()) r.sort = { by: sortBy.value.trim(), order: "desc" };
    return r;
  };
  const drawJob = (job) => {
    const p = job.progress ?? {};
    const pools = (job.plan?.pools ?? []).map((x) => (x.kind === "backup" ? "backup sources" : `${x.accountId} ×${x.concurrency}`)).join(", ");
    const head = h("div", { class: "row" }, pill(cap(job.status), job.status === "completed" ? "ok" : job.status === "failed" ? "bad" : "info"), h("span", { class: "muted small" }, `${formatInt(p.done ?? 0)}/${formatInt(p.total ?? 0)} symbols · ${formatInt(p.matched ?? 0)} matched · ${formatInt(p.errors ?? 0)} errors${pools ? ` · served by ${pools}` : ""}`));
    const results = job.results ?? [];
    const labels = Object.keys(results[0]?.values ?? {});
    // Fixed decimals per column: whole numbers when every value in the column is whole, else 2.
    const dp = Object.fromEntries(labels.map((l) => [l, results.every((r) => !isFigure(r.values[l]) || Number.isInteger(Number(r.values[l]))) ? 0 : 2]));
    const rows = h(
      "div",
      { class: "card" },
      table(
        [{ label: "Symbol", cell: (r) => h("strong", {}, r.symbol) }, ...labels.map((l) => ({ label: l, num: true, cell: (r) => formatFixed(r.values[l], dp[l]) })), { label: "Data", cell: (r) => pill(r.source === "backup" ? `backup · ${r.provider}` : r.accountId ?? r.source, r.source === "backup" ? "warn" : "") }],
        results,
        emptyState("scan", job.status === "completed" ? "Nothing matched" : "Scanning…", job.status === "completed" ? "No symbol met the condition on its last candle." : "Results appear here when the scan finishes."),
        { mobile: "scroll" },
      ),
    );
    const errs = (job.errors ?? []).length ? h("details", { class: "disclosure" }, h("summary", {}, `${formatInt(job.errors.length)} symbol(s) could not be scanned`), h("div", { class: "card" }, table([{ label: "Symbol", cell: (e) => e.symbol }, { label: "Code", cell: (e) => e.code }, { label: "Message", wrap: true, cell: (e) => e.message }], job.errors.slice(0, 100), null))) : null;
    out.replaceChildren(head, rows, errs ?? "");
  };
  planBtn.addEventListener("click", async () => {
    try {
      const r = (await api("/v1/scanner/plan", { method: "POST", body: request() })).data.data;
      toast(`${formatInt(r.symbols)} symbols · about ${formatInt(r.estimatedSeconds)} s · ${r.pools.map((x) => x.accountId ?? "backup").join(", ")}`);
    } catch (err) {
      out.replaceChildren(alertBox(err));
    }
  });
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    out.replaceChildren(h("p", { class: "muted" }, "Scanning…"));
    try {
      let job = (await api("/v1/scanner/jobs?waitMs=2000", { method: "POST", body: request() })).data.data;
      drawJob(job);
      while (job.status === "queued" || job.status === "running") {
        await new Promise((r) => setTimeout(r, 1000));
        job = (await api(`/v1/scanner/jobs/${encodeURIComponent(job.id)}`)).data.data;
        drawJob(job);
      }
    } catch (err) {
      out.replaceChildren(alertBox(err));
    } finally {
      runBtn.disabled = false;
    }
  });

  const b = backup.data?.data;
  const backupCard = card({
    glyph: "plug",
    tint: "gray",
    title: "Backup data",
    sub: "Used only when no broker account can answer; every value is labelled source \"backup\".",
    actions: b ? pill(b.enabled ? "On" : b.demo ? "Off in demo mode" : "Off", b.enabled ? "ok" : "warn") : null,
    flush: Boolean(b),
    body: b
      ? table(
          [
            { label: "Provider", cell: (p) => h("strong", {}, p.name) },
            { label: "State", cell: (p) => (!p.enabled ? pill("Off", "warn") : p.paused ? pill("Paused", "bad") : pill("Ready", "ok")) },
            { label: "Calls", num: true, cell: (p) => formatInt(p.calls) },
            { label: "Errors", num: true, cell: (p) => formatInt(p.errors) },
            { label: "Last error", wrap: true, cell: (p) => p.lastError?.message ?? DASH },
          ],
          b.providers ?? [],
          null,
        )
      : alertBox(backup.error ?? "Backup status is not available."),
  });
  const recent = (jobs.data?.data ?? []).slice(0, 10);
  const recentCard = card({
    glyph: "clock",
    tint: "mint",
    title: "Recent scans",
    flush: true,
    body: table(
      [
        { label: "Started", cell: (j) => istTime(j.startedAt) },
        { label: "Condition", wrap: true, cell: (j) => h("code", {}, j.request?.condition ?? "") },
        { label: "Status", cell: (j) => pill(cap(j.status), j.status === "completed" ? "ok" : j.status === "failed" ? "bad" : "warn") },
        { label: "Matched", num: true, cell: (j) => formatInt(j.progress?.matched) },
      ],
      recent,
      emptyState("scan", "No scans yet", "Run one above, or from Python, Node, Excel or an AI assistant.", nextStep("Write a condition", () => cond.focus())),
    ),
  });

  return [
    card({
      glyph: "scan",
      tint: "mint",
      title: "New scan",
      sub: "The condition is checked on each symbol's last candle. Scans run behind charts and orders, and share the work over your pooled accounts.",
      body: h(
        "div",
        { class: "stack" },
        h("div", { class: "form-grid" }, h("label", { class: "field" }, "Universe", uni), h("label", { class: "field" }, "Interval", interval), h("label", { class: "field" }, "Data", source)),
        h("label", { class: "field" }, "Symbols", h("span", { class: "hint" }, "Only when Universe is “My symbols”."), syms),
        h("label", { class: "field" }, "Condition", h("span", { class: "hint" }, "Fields: open high low close volume change_pct. Functions: sma ema rsi atr macd supertrend vwap highest lowest avg_volume … “crosses above”, x[1] for the previous bar."), cond),
        examples,
        h("div", { class: "form-grid" }, h("label", { class: "field" }, "Columns", h("span", { class: "hint" }, "Comma-separated expressions."), cols), h("label", { class: "field" }, "Sort by", sortBy)),
        h("div", { class: "row" }, runBtn, planBtn),
        out,
      ),
    }),
    h("div", { class: "grid cols-2" }, recentCard, backupCard),
  ];
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
  let section = 0;
  const eyebrow = (label) => sectionEyebrow(String(++section).padStart(2, "0"), label);

  // Welcome checklist
  if (!local.get(FLAG.hideChecklist)) {
    const state = checklistState({ demo: app.state.demo, accounts: accs, keys: keyRows, copied: local.get(FLAG.copied), tested: local.get(FLAG.tested) });
    const done = state.filter((s) => s.done).length;
    // The broker step goes straight to the next action: add a broker when there is none, else log in.
    const hasBroker = accs.some((a) => a.broker !== "paper");
    const ITEMS = {
      broker: app.state.demo
        ? { title: "Demo mode is on: sample data is ready", text: "Everything works with sample prices. When you are ready, close the Bridge and start it normally to add your broker.", go: "accounts", cta: "Accounts" }
        : hasBroker
          ? { title: "Log in to your broker", text: "Open Accounts and press Log in. Most brokers ask again every morning; it takes a few seconds.", go: "accounts", cta: "Log in" }
          : { title: "Add your broker and log in", text: "Choose your broker, then log in with its API details, right here. Nothing is sent anywhere but your broker.", go: "accounts?add=1", cta: "Add a broker" },
      key: { title: "Create a key for each tool", text: "A read-only key for spreadsheets and AI, a paper key for scripts. Never share your admin key.", go: "keys", cta: "Create a key" },
      snippet: { title: "Copy a snippet for Python, Excel, Claude or webhooks", text: "Ready-made setup with your Bridge address filled in.", go: "integrations", cta: "Integrations" },
      test: { title: "Make your first call", text: "Fetch a quote or an option chain in the test console and see the rate-limit headers.", go: "console", cta: "Test console" },
    };
    const fill = h("span");
    fill.style.width = `${(done / state.length) * 100}%`;
    nodes.push(
      eyebrow("Get started"),
      card({
        glyph: "check",
        tint: "green",
        title: "Welcome to your Bridge",
        sub: `${formatInt(done)} of ${formatInt(state.length)} done. One local API for all your broker accounts.`,
        actions: h(
          "div",
          { class: "row" },
          h("div", { class: "progress", role: "img", "aria-label": `${done} of ${state.length} steps done` }, h("div", { class: "bar ok" }, fill)),
          h("button", { type: "button", class: "plain small", onclick: () => { local.set(FLAG.hideChecklist, "1"); show(); } }, "Hide"),
        ),
        flush: true,
        body: h(
          "div",
          { class: "checklist" },
          state.map((s) =>
            h("div", { class: `check-item${s.done ? " done" : ""}` }, h("span", { class: "tick", "aria-hidden": "true" }, icon("check")), h("div", { class: "what" }, h("strong", {}, ITEMS[s.id].title, s.done ? h("span", { class: "pal-sr-only" }, " (done)") : null), h("span", {}, ITEMS[s.id].text)), h("button", { type: "button", class: s.done ? "small" : "small primary", onclick: () => (location.hash = `#/${ITEMS[s.id].go}`) }, ITEMS[s.id].cta)),
          ),
        ),
      }),
    );
  }

  // Today: the figures, then the market snapshot
  const connected = accs.filter((a) => a.session?.state === "connected").length;
  const sv = usage.data?.data?.savings;
  const saved = sv ? (sv.servedFromStream ?? 0) + (sv.servedFromCache ?? 0) + (sv.coalesced ?? 0) + (sv.batched ?? 0) : null;
  const ord = orders.data?.data ?? null;
  const sd = streams.data?.data;
  nodes.push(
    eyebrow("Today"),
    h(
      "div",
      { class: "grid cols-4 stats" },
      stat("Accounts connected", `${formatInt(connected)}/${formatInt(accs.length)}`, accs.length ? accs.map((a) => a.id).join(", ") : "None configured", "accounts", "indigo"),
      stat("Broker calls saved today", formatInt(saved), "Stream, cache, coalescing and batching", "bolt", "purple"),
      stat("Live symbols", formatInt(sd?.symbols), sd ? `${formatInt(sd.downstream?.connections ?? 0)} client connection(s)` : "Stream statistics are not available", "activity", "teal"),
      stat("Orders today", formatInt(ord?.length), ord ? `${formatInt(ord.filter((o) => o.mode === "paper").length)} paper · ${formatInt(ord.filter((o) => o.mode === "live").length)} live` : "Orders are not available", "orders", "orange"),
    ),
  );

  const marketAccount = accs.find((a) => a.broker !== "paper" && a.session?.state === "connected");
  const snapshot = h("div", { class: "quotes" });
  const fillQuotes = async () => {
    const r = await api("/v1/quotes?symbols=NSE:NIFTY,NSE:BANKNIFTY,BSE:SENSEX");
    snapshot.replaceChildren(
      ...(r.data.data ?? []).map((q) =>
        h(
          "div",
          { class: "quote" },
          h("span", { class: "sym" }, h("span", {}, q.symbol.split(":")[1]), h("small", {}, q.freshness?.source ?? "")),
          h("span", { class: "px" }, formatFixed(q.ltp, 2)),
          delta(q.change, `${formatSigned(q.change)} (${formatSigned(q.changePct)}%)`),
        ),
      ),
    );
  };
  if (marketAccount) {
    await fillQuotes().catch(() => snapshot.replaceChildren(h("div", { class: "quote" }, h("span", { class: "muted" }, "Prices are not available right now."))));
    every(5000, fillQuotes);
  }
  nodes.push(
    card({
      glyph: "chart",
      tint: "blue",
      title: "Market snapshot",
      sub: marketAccount ? `From ${marketAccount.label}, through the rate-limit engine` : "Connect a broker to see prices",
      flush: true,
      body: marketAccount ? snapshot : emptyState("plug", "No market data yet", "Quotes, charts and paper orders need one connected broker account, or demo mode.", h("button", { type: "button", class: "primary", onclick: () => (location.hash = accs.some((a) => a.broker !== "paper") || app.state.demo ? "#/accounts" : "#/accounts?add=1") }, "Connect a broker")),
    }),
  );

  // Your Bridge: accounts and safety
  const ks = safety.data?.data?.killSwitch;
  nodes.push(
    eyebrow("Your Bridge"),
    h(
      "div",
      { class: "grid side" },
      card({
        glyph: "accounts",
        tint: "indigo",
        title: "Broker accounts",
        flush: true,
        actions: h("button", { type: "button", class: "small tinted", onclick: () => (location.hash = "#/accounts") }, "Manage"),
        body: table(
          [
            { label: "Account", cell: (a) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small mono" }, a.id)) },
            { label: "Broker", cell: (a) => brokerCell(a.broker, a.broker) },
            { label: "Session", cell: (a) => sessionPill(a.session?.state) },
            { label: "Mode", cell: (a) => (a.liveAllowedByConfig ? pill("Live enabled", "bad") : pill("Paper")) },
          ],
          accs,
          emptyState("accounts", "No accounts yet", "Add your broker: choose it, then log in with its API details.", app.state.demo ? null : nextStep("Add a broker", "#/accounts?add=1")),
        ),
      }),
      card({
        glyph: "safety",
        tint: ks?.engaged ? "red" : "green",
        title: "Safety",
        actions: h("button", { type: "button", class: "small tinted", onclick: () => (location.hash = "#/safety") }, "Open"),
        body: h(
          "div",
          { class: "stack" },
          h("div", { class: "row" }, ks?.engaged ? pill("Kill switch on", "bad") : pill("Kill switch off", "ok"), safety.data?.data?.liveTrading ? pill("Live trading on", "bad") : pill("Paper only")),
          h("p", { class: "muted" }, ks?.engaged ? `Engaged ${istDateTime(ks.at)}: ${ks.reason ?? ""}` : "Orders pass every safety check: order-rate cap, daily limits, price band, market-order protection."),
          h("p", { class: "muted small" }, `Bridge ${app.state.health?.version ?? ""} · up ${formatInt((app.state.health?.uptimeSeconds ?? 0) / 60)} min · listening on this computer only`),
        ),
      }),
    ),
    // The type credit the SIL Open Font License asks for (dashboard/fonts/LICENSE.md).
    h(
      "p",
      { class: "muted small type-credit" },
      "Type: Chartist Sans Flex (from Google Sans Flex by Google), Chartist Sans (from Plus Jakarta Sans by Tokotype) and Chartist Serif (from Instrument Serif by Instrument), under the SIL Open Font License 1.1.",
    ),
  );
  return nodes;
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

/**
 * "Add a broker" sheet: a searchable list of the brokers (verified / beta), an optional name and id. Resolves with
 * the POST /v1/accounts answer ({ account, restartNeeded, configFile }) or null when cancelled.
 */
function addBrokerSheet(list, { preselect } = {}) {
  if (app.state.demo) {
    return modal({
      title: "Add a broker",
      body: alertBox({ title: "Demo mode is on", detail: "Demo mode uses sample accounts only. Close the Bridge and start it normally (not in demo mode) to add your own broker." }, "info"),
      buttons: [{ label: "OK", cls: "primary", value: null }],
    });
  }
  const brokers = [...realBrokers(list).filter((b) => b.available !== false), PAPER_CHOICE];
  let chosen = brokers.some((b) => b.id === preselect) ? preselect : null;
  const search = h("input", { type: "search", placeholder: `Search ${brokers.length - 1} brokers…`, "aria-label": "Search brokers", autocomplete: "off", spellcheck: "false" });
  const picker = h("div", { class: "pick-list", role: "radiogroup", "aria-label": "Broker" });
  const nameInput = h("input", { id: "add-label", type: "text", maxlength: "60", autocomplete: "off", placeholder: "A name you will recognise" });
  const idInput = h("input", { id: "add-id", type: "text", maxlength: "32", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: "Picked for you, e.g. zerodha-main" });
  const err = h("div", { "aria-live": "polite" });
  const describe = () => {
    const b = brokers.find((x) => x.id === chosen);
    nameInput.placeholder = b ? (b.paper ? "Paper account" : `${b.name} (main)`) : "A name you will recognise";
    idInput.placeholder = b ? `Picked for you, e.g. ${b.paper ? "paper-2" : `${b.id}-main`}` : "Picked for you, e.g. zerodha-main";
  };
  const option = (b) => {
    const radio = h("input", { type: "radio", name: "add-broker", value: b.id, checked: b.id === chosen });
    radio.addEventListener("change", () => {
      chosen = b.id;
      err.replaceChildren();
      describe();
    });
    return h(
      "label",
      { class: "pick-row" },
      radio,
      b.paper ? h("span", { class: "avatar" }, "P") : brokerAvatar(b),
      h("span", { class: "names" }, h("span", { class: "nm" }, b.name), h("span", { class: "sub" }, b.paper ? "Simulated orders with real prices" : AUTH_KIND_LABEL[b.authKind] ?? b.authKind)),
      b.paper ? pill("Simulator") : b.verified ? pill("Verified", "ok") : pill("Beta", "warn"),
    );
  };
  const draw = () => {
    const rows = brokers.filter((b) => brokerMatches(b, search.value));
    picker.replaceChildren(...rows.map(option));
    if (!rows.length) picker.replaceChildren(h("p", { class: "muted small pick-empty" }, `No broker matches “${search.value}”.`));
  };
  search.addEventListener("input", draw);
  draw();
  describe();
  return modal({
    title: "Add a broker",
    body: h(
      "div",
      { class: "stack" },
      h("p", { class: "muted" }, "Choose your broker. You log in on the next step; nothing is sent to the broker yet. New accounts are paper only."),
      search,
      picker,
      field("Name (optional)", nameInput),
      h("details", { class: "disclosure" }, h("summary", {}, "Account id (optional)"), field("Account id", idInput, "Used by scripts and spreadsheets to pick this account: 2-32 lowercase letters, digits or hyphens.")),
      err,
    ),
    buttons: [
      { label: "Cancel", value: null },
      {
        label: "Add",
        cls: "primary",
        onClick: async () => {
          if (!chosen) {
            err.replaceChildren(alertBox({ title: "Choose a broker", detail: "Pick your broker from the list first." }, "warn"));
            return false;
          }
          const body = { broker: chosen };
          if (nameInput.value.trim()) body.label = nameInput.value.trim();
          if (idInput.value.trim()) body.id = idInput.value.trim();
          try {
            const r = await api("/v1/accounts", { method: "POST", body });
            return r.data.data;
          } catch (e) {
            err.replaceChildren(errorBox(e, { id: "Account id", label: "Name", broker: "Broker" }));
            return false;
          }
        },
      },
    ],
  });
}

/** Add an account, then go straight on to logging in to it. */
async function addAccountFlow(list, opts) {
  const added = await addBrokerSheet(list, opts);
  if (!added) return;
  if (added.restartNeeded || !added.account) {
    await modal({
      title: "Saved",
      body: alertBox({ title: "Restart the Bridge to use the new account", detail: `It was saved to ${added.configFile}. Close the Bridge and start it again, then log in on this page.` }, "info"),
      buttons: [{ label: "OK", cls: "primary", value: true }],
    });
    return show();
  }
  await show();
  toast(`Added ${added.account.label}`);
  if (added.account.broker !== "paper") await loginSheet(added.account, list.find((b) => b.id === added.account.broker));
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
    const open = h("button", { type: "button", class: "small tinted", disabled: true }, icon("external"), `Open ${broker.name} login page`);
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
    let body = loginBody(spec, (f) => inputs.get(f).value);
    // Off the page at once, whatever happens next.
    for (const i of inputs.values()) i.value = "";
    if (!Object.keys(body.values).length && !body.secrets) {
      result.replaceChildren(alertBox({ title: "Nothing to send", detail: spec.keepHint ? "Type at least the fields that changed (for most brokers: today's token or code)." : "Fill in the fields above first." }, "warn"));
      return false;
    }
    busy = true;
    result.replaceChildren(h("p", { class: "muted small" }, `Logging in to ${broker.name}…`));
    let state;
    try {
      state = (await api(`/v1/accounts/${encodeURIComponent(a.id)}/session`, { method: "POST", body })).data.data;
    } catch (err) {
      result.replaceChildren(errorBox(err, labels));
      return false;
    } finally {
      body = null;
      busy = false;
    }
    if (state?.state === "connected") {
      show().then(() => toast(`${a.label}: logged in${state.expiresAt ? `, until ${istDateTime(state.expiresAt)}` : ""}`));
      return true;
    }
    result.replaceChildren(alertBox({ title: "The broker did not accept this", detail: `${state?.message ?? "No reason given."} Check the fields and try again.` }));
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
        cls: "danger",
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

async function renderAccounts() {
  const [accounts, brokers] = await Promise.all([api("/v1/accounts"), api("/v1/brokers")]);
  const accs = accounts.data.data ?? [];
  const list = brokers.data.data ?? [];
  const brokerOf = (a) => list.find((b) => b.id === a.broker);
  const paperCount = accs.filter((a) => a.broker === "paper").length;
  const testAccount = async (a, btn) => {
    btn.disabled = true;
    try {
      const r = await api(`/v1/accounts/${encodeURIComponent(a.id)}/test`, { method: "POST" });
      toast(r.data?.data?.ok ? `${a.id}: connection OK` : `${a.id}: ${r.data?.data?.message ?? "not OK"}`);
    } catch (err) {
      modal({ title: `Test ${a.id}`, body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    } finally {
      btn.disabled = false;
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
    actions: app.state.demo ? null : addButton("small primary"),
    flush: true,
    body: table(
      [
        { label: "Account", cell: (a) => h("div", {}, h("strong", {}, a.label), h("div", { class: "muted small mono" }, a.id)) },
        { label: "Broker", cell: (a) => (a.broker === "paper" ? "Paper (simulator)" : brokerCell(a.broker, brokerOf(a)?.name ?? a.broker)) },
        { label: "Session", cell: (a) => h("div", {}, sessionPill(a.session?.state), a.session?.expiresAt ? h("div", { class: "muted small" }, `until ${istDateTime(a.session.expiresAt)}`) : null) },
        { label: "Mode", cell: (a) => (a.liveAllowedByConfig ? pill("Live enabled", "bad") : pill("Paper")) },
        { label: "Can do", wrap: true, cell: (a) => h("div", { class: "chips" }, (a.capabilities ?? []).slice(0, 6).map((c) => h("span", { class: "chip" }, c)), (a.capabilities?.length ?? 0) > 6 ? h("span", { class: "chip" }, `+${a.capabilities.length - 6}`) : null) },
        {
          label: "",
          cell: (a) => {
            if (a.broker === "paper") return h("div", { class: "row" }, h("span", { class: "muted small" }, "Simulator"), !app.state.demo && paperCount > 1 ? removeButton(a) : null);
            const t = h("button", { type: "button", class: "small", "aria-label": `Test ${a.id}` }, "Test");
            t.addEventListener("click", () => testAccount(a, t));
            if (app.state.demo) return t;
            const connected = a.session?.state === "connected";
            return h(
              "div",
              { class: "row" },
              t,
              h("button", { type: "button", class: connected ? "small" : "small primary", "aria-label": `${connected ? "Log in again to" : "Log in to"} ${a.label}`, onclick: () => loginSheet(a, brokerOf(a)) }, connected ? "Log in again" : "Log in"),
              a.liveAllowedByConfig ? null : removeButton(a),
            );
          },
        },
      ],
      accs,
      emptyState("accounts", "No accounts yet", "Add your broker to get started: choose it, then log in with its API details. It takes a minute.", app.state.demo ? null : addButton()),
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
            app.state.demo ? null : h("button", { type: "button", class: "small tinted", "aria-label": `Add a ${b.name} account`, onclick: () => addAccountFlow(list, { preselect: b.id }) }, "Add"),
          ),
        ),
      ),
    );
    if (!rows.length) grid.replaceChildren(h("div", { class: "row" }, h("p", { class: "muted" }, `No broker matches “${search.value}”.`), nextStep("Clear search", () => { search.value = ""; draw(); search.focus(); }, "small tinted")));
  };
  search.addEventListener("input", draw);
  draw();
  const dirCard = card({
    glyph: "plug",
    tint: "blue",
    title: "Supported brokers",
    sub: `${real.length} brokers. Dhan is verified with a live account; the others are beta (tested against recorded samples).${app.state.demo ? " Demo mode loads none of them." : ""}`,
    actions: search,
    flush: true,
    body: grid,
  });

  // #/accounts?add=1 (or ?add=<broker id>), from the Home page: open the sheet once the page is drawn.
  const want = /[?&]add=([a-z0-9]+)/.exec(location.hash)?.[1];
  if (want) {
    history.replaceState(null, "", "#/accounts");
    setTimeout(() => addAccountFlow(list, { preselect: want }), 0);
  }
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
  // #/console?endpoint=order opens a given endpoint (the Orders page links straight to the order form).
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
    runBtn.disabled = true;
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
            h("div", { class: "code" }, pre, h("button", { type: "button", class: "small copy", onclick: () => copyText(pretty) }, icon("copy"), "Copy")),
          ),
        }),
      );
    } catch (err) {
      out.replaceChildren(alertBox(err));
    } finally {
      runBtn.disabled = false;
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
  const draw = async () => {
    const [usage, limits] = await Promise.all([api("/v1/usage"), api("/v1/limits")]);
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
      tryBtn.disabled = true;
      const before = (await api("/v1/usage")).data.data;
      const calls = (x) => (x.accounts ?? []).reduce((n, a) => n + sum(Object.fromEntries(Object.entries(a.classes ?? {}).map(([k, v]) => [k, v.callsToday ?? 0]))), 0);
      await Promise.all(Array.from({ length: 20 }, () => optional(api("/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE"))));
      const after = (await api("/v1/usage")).data.data;
      tryBtn.disabled = false;
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
  every(2500, draw);
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
                  return h("button", { type: "button", class: t.order?.mode === "live" ? "small danger" : "small primary", disabled: blocked, "aria-label": `${blocked ? "Blocked" : "Review"} ticket ${t.ticketId}`, onclick: () => confirmTicket(t, byId) }, blocked ? "Blocked" : "Review");
                },
              },
            ],
            tk,
            emptyState("inbox", "Nothing waiting", "When an AI assistant prepares an order, it appears here for you to check every field and confirm.", nextStep("Set up an AI assistant", "#/integrations?tab=claude", "tinted")),
          ),
    }),
  );

  const ord = orders.data?.data ?? [];
  nodes.push(
    card({
      glyph: "orders",
      tint: "orange",
      title: "Today's orders",
      actions: h("button", { type: "button", class: "small tinted", onclick: () => (location.hash = "#/console?endpoint=order") }, icon("plus"), "Place a paper order"),
      flush: true,
      body: orders.error
        ? h("div", { class: "card-body" }, alertBox(orders.error))
        : table(
            [
              { label: "Time", cell: (o) => istTime(o.placedAt) },
              { label: "Account", cell: (o) => o.accountId },
              { label: "Symbol", cell: (o) => h("strong", {}, o.symbol) },
              { label: "Side", cell: (o) => h("span", { class: "order-side" }, o.side) },
              { label: "Qty", num: true, cell: (o) => formatInt(o.quantity) },
              { label: "Avg price", num: true, cell: (o) => formatFixed(o.avgPrice, 2) },
              { label: "Status", cell: (o) => pill(cap(o.status), o.status === "filled" ? "ok" : o.status === "rejected" ? "bad" : "warn") },
              { label: "Mode", cell: (o) => (o.mode === "live" ? pill("Live", "bad") : pill("Paper")) },
            ],
            ord,
            emptyState("orders", "No orders today", "Paper orders from the test console, your scripts, webhooks and AI assistants show up here.", nextStep("Place a paper order", "#/console?endpoint=order")),
          ),
    }),
  );

  for (const a of accs.filter((x) => x.broker === "paper")) {
    const [pos, funds] = await Promise.all([optional(api(`/v1/positions?account=${encodeURIComponent(a.id)}`)), optional(api(`/v1/funds?account=${encodeURIComponent(a.id)}`))]);
    const f = funds.data?.data?.funds ?? funds.data?.data ?? {};
    const rows = pos.data?.data ?? [];
    nodes.push(
      card({
        glyph: "wallet",
        tint: "teal",
        title: /paper/i.test(a.label ?? "") ? a.label : `${a.label} (paper)`,
        sub: `Cash ${formatRupee(f.availableCash)} · used margin ${formatRupee(f.usedMargin)} · realised ${formatRupee(f.realisedPnl)} · unrealised ${formatRupee(f.unrealisedPnl)}`,
        flush: true,
        body: table(
          [
            { label: "Symbol", cell: (p) => h("strong", {}, p.symbol) },
            { label: "Product", cell: (p) => p.product },
            { label: "Net qty", num: true, cell: (p) => formatInt(p.netQty) },
            { label: "Avg", num: true, cell: (p) => formatFixed(p.avgPrice, 2) },
            { label: "LTP", num: true, cell: (p) => formatFixed(p.ltp, 2) },
            { label: "P&L", num: true, cell: (p) => pnl(p.pnl) },
          ],
          rows,
          emptyState("orders", "No open paper positions", `Place a paper order to practise with ${formatRupee(1000000, 0)} of virtual money.`, nextStep("Place a paper order", "#/console?endpoint=order", "tinted")),
        ),
      }),
    );
  }
  return nodes;
}

async function confirmTicket(t, byId) {
  const fields = ticketFields(t, byId);
  const ok = await modal({
    title: `Confirm ticket ${t.ticketId}?`,
    body: h("div", { class: "stack" }, h("p", { class: "muted" }, "The client that prepared it can then send exactly this order, once."), h("dl", { class: "kv" }, ...fields.flatMap(([k, v, cls]) => [h("dt", {}, k), h("dd", { class: cls ? `${cls}-text` : undefined }, v)]))),
    buttons: [{ label: "Cancel", value: false }, { label: t.order?.mode === "live" ? "Confirm LIVE order" : "Confirm", cls: t.order?.mode === "live" ? "danger" : "primary", value: true }],
  });
  if (!ok) return;
  try {
    const r = await api(`/v1/tickets/${encodeURIComponent(t.ticketId)}/confirm`, { method: "POST" });
    const n = confirmCodeNotice(t.ticketId, r.data);
    if (n) await modal({ title: "Confirmed", body: h("div", { class: "stack" }, h("p", {}, n.text), h("div", { class: "secret-box" }, h("code", {}, n.token), h("button", { type: "button", class: "small", onclick: () => copyText(n.token) }, icon("copy"), "Copy"))), buttons: [{ label: "Done", cls: "primary", value: true }] });
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
    const reason = h("input", { value: "Stopped from the dashboard", maxlength: "200" });
    const cancel = h("input", { type: "checkbox" });
    const go = await modal({
      title: "Stop all orders?",
      body: h("div", { class: "stack" }, h("p", {}, "New orders are refused at once, including ones already queued. Cancels still work."), h("label", { class: "field" }, "Reason", reason), h("label", { class: "check" }, cancel, "Also cancel open orders the Bridge placed")),
      buttons: [{ label: "Keep trading", value: false }, { label: "Stop all orders", cls: "danger", value: true }],
    });
    if (!go) return;
    try {
      await api("/v1/safety/kill-switch", { method: "POST", body: { reason: reason.value || "manual", cancelOpenOrders: cancel.checked } });
      toast("Kill switch engaged");
    } catch (err) {
      await modal({ title: "Could not engage", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    }
    show();
  };
  const release = async () => {
    const typed = h("input", { placeholder: "RELEASE", autocomplete: "off", spellcheck: "false" });
    const go = await modal({
      title: "Allow orders again?",
      body: h("div", { class: "stack" }, h("p", {}, "Needs an admin key, from this computer."), h("label", { class: "field" }, "Type RELEASE to confirm", typed)),
      buttons: [{ label: "Cancel", value: false }, { label: "Release", cls: "primary", onClick: () => (typed.value === "RELEASE" ? true : (toast("Type RELEASE exactly"), false)) }],
    });
    if (!go) return;
    try {
      await api("/v1/safety/kill-switch", { method: "DELETE", body: { confirm: "RELEASE" } });
      toast("Kill switch released");
    } catch (err) {
      await modal({ title: "Could not release", body: alertBox(err), buttons: [{ label: "Close", value: true }] });
    }
    show();
  };
  const verify = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api("/v1/audit/verify");
      const d = r.data.data ?? {};
      toast(d.ok ? `Audit chain intact (${formatInt(d.checked)} records)` : `Audit chain broken at ${d.brokenAt}`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  };
  const verifyBtn = h("button", { type: "button", class: "small tinted" }, "Verify audit log");
  verifyBtn.addEventListener("click", () => verify(verifyBtn));

  const killCard = h(
    "section",
    { class: `card kill${ks.engaged ? " engaged" : ""}` },
    iconTile(ks.engaged ? "stop" : "power", ks.engaged ? "red" : "green", "lg"),
    h("div", { class: "stack" }, h("h2", {}, ks.engaged ? "Kill switch is on: no orders are sent" : "Kill switch is off"), h("p", { class: "muted" }, ks.engaged ? `Engaged ${istDateTime(ks.at)} by ${ks.by ?? "?"}: ${ks.reason ?? ""}` : "One click stops every new order from every tool: REST, webhooks, AI assistants and the CLI. Also: mc-bridge kill.")),
    h("div", { class: "actions" }, ks.engaged ? h("button", { type: "button", id: "kill-action", class: "primary", onclick: release }, "Release (admin)") : h("button", { type: "button", id: "kill-action", class: "danger", onclick: engage }, icon("stop"), "Stop all orders")),
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
    actions: verifyBtn,
    flush: true,
    body: table(
      [
        { label: "Account", cell: (a) => h("strong", {}, a.accountId) },
        { label: "Orders today", num: true, cell: (a) => `${formatInt((a.ordersToday ?? 0) + (a.paperOrdersToday ?? 0))} / ${formatInt(a.limits?.dailyMaxOrders)}` },
        { label: "P&L today", num: true, cell: (a) => pnl(isFigure(a.realisedPnlToday) || isFigure(a.paperRealisedPnlToday) ? (a.realisedPnlToday ?? 0) + (a.paperRealisedPnlToday ?? 0) : null) },
        { label: "Max loss", num: true, cell: (a) => formatRupee(a.limits?.dailyMaxLoss) },
        { label: "Max order value", num: true, cell: (a) => formatRupee(a.limits?.maxOrderValue) },
        { label: "Max lots", num: true, cell: (a) => formatInt(a.limits?.maxLotsPerOrder) },
        { label: "Orders / s", num: true, cell: (a) => formatInt(a.limits?.orderRatePerSecond) },
        { label: "Market orders", cell: (a) => a.limits?.marketOrders ?? "protect" },
      ],
      s.accounts ?? [],
      emptyState("safety", "No accounts", "Daily limits appear once an account is configured.", nextStep("Go to Accounts", "#/accounts", "tinted")),
    ),
  });
  return [killCard, h("div", { class: "grid side" }, limits, live)];
}

// ── Keys ──

async function renderKeys() {
  const [keys, accounts] = await Promise.all([api("/v1/keys"), api("/v1/accounts")]);
  const rows = keys.data.data ?? [];
  const accs = accounts.data.data ?? [];
  const createdBox = h("div");
  const label = h("input", { id: "key-label", placeholder: "e.g. Excel prices", maxlength: "60", "aria-required": "true" });
  const scope = h("select", {}, h("option", { value: "read" }, "Read only: prices, charts, AI"), h("option", { value: "paper" }, "Paper trading: read + paper orders"), h("option", { value: "admin,paper" }, "Admin: manage the Bridge"));
  const acct = h("select", {}, h("option", { value: "*" }, "All accounts"), accs.map((a) => h("option", { value: a.id }, a.id)));
  const client = h("select", {}, ["script", "excel", "mcp", "ui", "other"].map((c) => h("option", { value: c }, { script: "Script (Python, Node)", excel: "Excel / Sheets", mcp: "AI assistant (MCP)", ui: "App / dashboard", other: "Other" }[c])));
  const expires = segmented("Expires", [["", "Never"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]], "");
  const urlUse = h("input", { type: "checkbox" });
  const createBtn = h("button", { type: "button", class: "primary" }, icon("plus"), "Create key");
  createBtn.addEventListener("click", async () => {
    if (!label.value.trim()) {
      label.focus();
      return toast("Give the key a name");
    }
    createBtn.disabled = true;
    try {
      const body = { label: label.value.trim(), scopes: scope.value.split(","), accounts: acct.value === "*" ? "*" : [acct.value], clientKind: client.value };
      if (expires.value) body.expiresAt = new Date(Date.now() + Number(expires.value) * 86_400_000).toISOString();
      if (urlUse.checked) body.allowQuery = true;
      const r = await api("/v1/keys", { method: "POST", body });
      const k = r.data.data?.key;
      createdBox.replaceChildren(
        h("div", { class: "secret-box" }, h("strong", {}, "Copy it now, it is shown only once:"), h("code", {}, k), h("button", { type: "button", class: "small primary", onclick: () => copyText(k, "Key copied") }, icon("copy"), "Copy")),
      );
      label.value = "";
      await drawTable();
    } catch (err) {
      createdBox.replaceChildren(alertBox(err));
    } finally {
      createBtn.disabled = false;
    }
  });

  const tableBox = h("div");
  const drawTable = async (list) => {
    const data = list ?? (await api("/v1/keys")).data.data ?? [];
    const status = (k) => (k.revokedAt ? pill("Revoked", "bad") : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? pill("Expired", "warn") : pill("Active", "ok"));
    tableBox.replaceChildren(
      table(
        [
          { label: "Name", cell: (k) => h("div", {}, h("strong", {}, k.label), h("div", { class: "muted small mono" }, k.id)) },
          { label: "Scopes", cell: (k) => h("div", { class: "chips" }, k.scopes.slice().sort().map(scopeChip), k.allowQuery ? h("span", { class: "chip" }, "URL ok") : null) },
          { label: "Accounts", cell: (k) => (k.accounts === "*" ? "All" : k.accounts.join(", ")) },
          { label: "For", cell: (k) => k.clientKind ?? DASH },
          { label: "Last used", cell: (k) => istDateTime(k.lastUsedAt) },
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
                    onclick: async () => {
                      const ok = await modal({ title: `Revoke “${k.label}”?`, body: h("p", {}, "It stops working on its very next request, and its open streams close. This cannot be undone."), buttons: [{ label: "Cancel", value: false }, { label: "Revoke", cls: "danger", value: true }] });
                      if (!ok) return;
                      try {
                        await api(`/v1/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
                        toast("Key revoked");
                      } catch (err) {
                        toast(err.message);
                      }
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
  return [
    card({
      glyph: "plus",
      tint: "pink",
      title: "Create a key",
      sub: "Least access wins: charts and AI need read, scripts that trade on paper need paper. Live keys are made from the terminal only.",
      body: h(
        "div",
        { class: "stack" },
        h("div", { class: "form-grid" }, h("label", { class: "field" }, "Name", label), h("label", { class: "field wide" }, "Access", scope), h("label", { class: "field" }, "Accounts", acct), h("label", { class: "field" }, "Used by", client), segField("Expires", expires, { wide: true })),
        h("div", { class: "row" }, h("label", { class: "check" }, urlUse, "Allow in URLs (?key=), for Excel and Google Sheets. Read-only keys only."), h("span", { class: "grow" }), createBtn),
        createdBox,
      ),
    }),
    card({ glyph: "keys", tint: "pink", title: "Your keys", sub: "Only a hash of each key is stored. The key itself was shown once.", flush: true, body: tableBox }),
  ];
}

// ── Integrations ──

const TABS = [
  ["webhooks", "Webhooks"],
  ["python", "Python"],
  ["node", "Node"],
  ["excel", "Excel & Sheets"],
  ["amibroker", "AmiBroker"],
  ["claude", "Claude (MCP)"],
  ["chatgpt", "ChatGPT / OpenAI"],
  ["rest", "REST / curl"],
];
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

async function renderIntegrations() {
  const accounts = (await api("/v1/accounts")).data.data ?? [];
  const paperAcc = accounts.find((a) => a.broker === "paper")?.id ?? "paper";
  const createdKeys = {};
  const tabsBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Tools" });
  const panel = h("div", { class: "card-body stack" });
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  let active = TABS.some(([id]) => id === params.get("tab")) ? params.get("tab") : "webhooks";

  const draw = async () => {
    drawTabs(tabsBar, panel, TABS, active, (id) => {
      active = id;
      draw();
    });
    const s = snippets({ base: location.origin, key: createdKeys[active] ?? null, account: paperAcc, symbol: "NSE:NIFTY", folder: app.state.meta?.installDir || undefined })[active];
    const preset = KEY_PRESETS[active];
    const keyBtn = preset && h("button", { type: "button", class: createdKeys[active] ? "small" : "small tinted" }, icon("keys"), createdKeys[active] ? "Key created" : `Create a ${preset.scopes.join("+")} key for this`);
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
        toast(err.message);
      }
    });
    const parts = [
      h("div", { class: "row" }, h("p", { class: "grow muted" }, INTRO[active]), ...(keyBtn ? [keyBtn] : []), h("a", { href: `https://github.com/MrChartist/api-bridge/blob/main/docs/guides/${GUIDES[active]}.md`, target: "_blank", rel: "noopener", "aria-label": `${TABS.find(([id]) => id === active)[1]} guide (opens in a new tab)` }, "Guide ↗")),
      createdKeys[active] ? h("div", { class: "alert info" }, icon("info"), h("div", {}, h("strong", {}, "Your new key is in the snippets below."), h("span", { class: "detail" }, "It is shown only on this page and only until you leave it."))) : null,
    ];
    if (active === "webhooks") parts.push(await webhookPanel(paperAcc));
    for (const sn of s) parts.push(codeBlock(sn.code, { title: sn.title, json: sn.lang === "json", onCopy: markCopied }));
    panel.replaceChildren(...parts.filter(Boolean));
  };
  await draw();
  return card({ glyph: "integrations", tint: "blue", title: "Connect your tools", sub: `Your Bridge address: ${location.origin}`, flush: true, body: h("div", {}, tabsBar, panel) });
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
    { label: "Last alert", cell: (x) => istDateTime(x.lastSignalAt) },
    {
      label: "",
      cell: (x) =>
        h("button", {
          type: "button",
          class: "small plain",
          "aria-label": `Delete webhook ${x.label}`,
          onclick: async () => {
            if (!(await modal({ title: `Delete “${x.label}”?`, body: h("p", {}, "Alerts sent to its URL are refused from now on."), buttons: [{ label: "Cancel", value: false }, { label: "Delete", cls: "danger", value: true }] }))) return;
            await optional(api(`/v1/hooks/${encodeURIComponent(x.id)}`, { method: "DELETE" }));
            show();
          },
        }, "Delete"),
    },
  ];
  // Only the table is redrawn when a hook is added, so the one-time secret URL in `box` stays on screen.
  const tableSlot = h("div");
  const drawTable = () => tableSlot.replaceChildren(...[table(columns, list, h("p", { class: "card-body muted small" }, "No webhooks yet. Fill in the form above and choose Create webhook."))].filter(Boolean));
  drawTable();
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const r = await api("/v1/hooks", { method: "POST", body: { source: source.value, label: label.value.trim() || "Webhook", account: paperAcc, orderType: orderType.value, product: product.value, maxLotsPerSignal: Number(lots.value) || 1, ...(side.value ? { side: side.value } : {}) } });
      const d = r.data.data;
      list.push(d);
      drawTable();
      box.replaceChildren(...[
        h("div", { class: "secret-box" }, h("strong", {}, "Webhook URL (its secret token is shown once):"), h("code", {}, d.url), h("button", { type: "button", class: "small primary", onclick: () => copyText(d.url, "URL copied").then(markCopied) }, icon("copy"), "Copy")),
        d.signingSecret ? h("div", { class: "secret-box" }, h("strong", {}, "Signing secret (shown once; sign every request with it):"), h("code", {}, d.signingSecret), h("button", { type: "button", class: "small primary", onclick: () => copyText(d.signingSecret, "Secret copied").then(markCopied) }, icon("copy"), "Copy")) : null,
        ...(d.templates ?? []).slice(0, 1).map((t) => codeBlock(t.message, { title: t.name, json: t.contentType === "application/json" && t.message.startsWith("{"), onCopy: markCopied })),
        ...(d.warnings ?? []).map((w) => alertBox({ title: "Note", detail: w }, "warn")),
        h("p", { class: "muted small" }, "Hosted alert services post from the internet, so point a tunnel (for example Cloudflare Tunnel) at the public ingress listener, which serves /hooks only. Paper orders by default."),
      ].filter(Boolean));
    } catch (err) {
      box.replaceChildren(alertBox(err));
    } finally {
      btn.disabled = false;
    }
  });
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, iconTile("bolt", "orange"), h("div", { class: "card-titles" }, h("h3", {}, "Alert webhook"), h("p", {}, `Each hook has its own secret URL and places paper orders on ${paperAcc}.`))),
    h("div", { class: "card-body stack" }, h("div", { class: "form-grid" }, h("label", { class: "field" }, "Name", label), h("label", { class: "field" }, "Source", source), segField("Side", side), segField("Order type", orderType, { wide: true }), segField("Product", product), h("label", { class: "field" }, "Max lots per alert", lots), btn), box),
    tableSlot,
  );
}

// ── Activity ──

async function renderActivity() {
  const tabsBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Activity" });
  const body = h("div");
  let active = "requests";
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
      draw();
    });
    if (active === "requests") {
      const r = await api("/v1/requests?limit=200");
      const all = (r.data.data ?? []).filter((x) => !hideOwn.checked || x.client !== "dashboard");
      const rows = all.slice(0, showAll ? 200 : 40);
      const more = all.length > rows.length ? h("div", { class: "card-body row" }, h("span", { class: "muted small" }, `Showing the latest ${formatInt(rows.length)} of ${formatInt(all.length)}.`), h("button", { type: "button", class: "small tinted", onclick: () => { showAll = true; draw(); } }, "Show all")) : null;
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
          emptyState("activity", "No requests yet", hideOwn.checked ? "Requests from your scripts, charts, Excel and AI tools appear here. Untick the box to see the dashboard's own." : "Requests appear here as they arrive.", nextStep("Make a call in the test console", "#/console", "tinted")),
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
