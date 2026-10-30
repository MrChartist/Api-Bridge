// Command palette (Spotlight style) and keyboard shortcuts for the dashboard.
// Browser only: nothing here touches the DOM until initPalette() runs (views.js calls it from startRouter()).
import { chooseTheme, copyText, h, icon, iconTile, lockScroll, modal, toast } from "./app.js";
import { applyLayout, exportSavedLayouts, historyBack, historyForward, openExpirySheet, openHelp, openLayouts, resetHomePage, savedLayouts, setHomePage, setKeyHint, setRefreshInterval, setUnderlying, toggleDensity } from "./chrome.js";
import { PAGE_KEYWORDS, REFRESH_CHOICES, UNDERLYING_CHIPS, createSequencer, codeOf, goKeyTable, nowShowing, recents, workspace } from "./workspace.js";
import { parseCommand } from "./terminal.js";

/** True on Apple platforms, where shortcuts use ⌘ instead of Ctrl. */
export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
/** The label of the modifier key: "⌘" on a Mac, "Ctrl" elsewhere. */
export const modKey = () => (isMac() ? "⌘" : "Ctrl");
const ariaMod = () => (isMac() ? "Meta" : "Control");

/** A key cap (or several, e.g. kbd("⌘", "K")). */
export function kbd(...keys) {
  return h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", { class: "kbd" }, k)));
}

/** Magnifier icon (static markup from this file). */
export function searchIcon() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
  return s;
}

/**
 * Fuzzy match: every character of the query appears in order in the text. Higher is better, -1 means no match.
 * Prefix and word-start hits score more; gaps cost a little. Pure.
 */
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, " ").trim();
  const t = String(text).toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct === 0) return 1000 - t.length;
  if (direct > 0) return (/\W/.test(t[direct - 1]) ? 800 : 600) - direct - t.length / 10;
  let score = 0;
  let ti = 0;
  let last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    score += at === 0 || /\W/.test(t[at - 1]) ? 10 : 1;
    if (last >= 0) score -= Math.min(at - last - 1, 5);
    last = at;
    ti = at + 1;
  }
  return score;
}

/** Every word of the query appears somewhere in the keywords ("open interest" finds the OI page). Pure. */
function keywordHit(keywords, query) {
  const hay = `${keywords ?? ""}`.toLowerCase();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

/** Rank commands for a query (label, then keywords). Pure. */
export function rank(commands, query) {
  if (!query.trim()) return commands;
  return commands
    // Fuzzy on the visible label; keywords (synonyms) count only as whole-substring hits, so results stay relevant.
    .map((c, i) => ({ c, i, s: Math.max(fuzzyScore(query, c.label), keywordHit(c.keywords, query) ? 50 : -1) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

let ctx = null; // { pages, go, refresh }
let dlg = null;
let input = null;
let list = null;
let results = [];
let activeIndex = 0;
let returnFocus = null;

const isTyping = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
const otherDialogOpen = () => Boolean(document.getElementById("dialog")?.open);

function setTheme(choice) {
  chooseTheme(choice);
  toast(`Theme: ${choice === "auto" ? "Auto (matches your system)" : choice === "light" ? "Light" : "Dark"}`);
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") ?? "auto";
}

const SYMBOL_QUERY = /^(?:go to |set |use |switch to )?(?:underlying|symbol)\s+([A-Za-z0-9&_-]{1,30})$/i;
const onAnalytics = () => ctx.pages().find((p) => p.id === ctx.currentPage?.())?.group === "Analytics";

/** Make `u` the underlying everywhere; from a non-Analytics page go to the option chain with it. */
function goUnderlying(u) {
  setUnderlying(u, { navigateTo: onAnalytics() ? undefined : "chain" });
  toast(`Underlying: ${u}`);
}

function commands() {
  const pages = ctx.pages();
  const mod = modKey();
  const keyOf = (() => {
    const t = goKeyTable(pages.map((p) => p.id));
    const byId = Object.fromEntries(Object.entries(t).map(([k, id]) => [id, k]));
    return (id) => byId[id];
  })();
  const pageCmds = pages.map((p, i) => ({
    id: `page-${p.id}`,
    group: "Pages",
    label: p.label,
    keywords: `${p.title} ${p.sub} ${p.group} ${p.id} ${codeOf(p.id) ?? ""} ${PAGE_KEYWORDS[p.id] ?? ""} go open page`,
    icon: p.icon,
    tint: p.tint,
    sub: p.sub,
    code: codeOf(p.id),
    hint: keyOf(p.id) ? ["g", ...keyOf(p.id)] : i < 9 ? [mod, String(i + 1)] : null,
    run: () => ctx.go(p.id),
  }));
  // The last few pages visited (not the one open now), only while the search box is empty.
  const recent = recents
    .list()
    .filter((id) => id !== ctx.currentPage?.())
    .map((id) => pageCmds.find((c) => c.id === `page-${id}`))
    .filter(Boolean)
    .slice(0, 4)
    .map((c) => ({ ...c, id: `recent-${c.id}`, group: "Recent", emptyOnly: true }));
  const c = workspace.get();
  const actions = [
    { id: "scan", label: "Run a scan", sub: "Write a condition on the Scanner page", keywords: "scanner screener condition rsi", icon: "scan", tint: "mint", run: () => ctx.go("scanner", "#scan-condition") },
    { id: "kill", label: "Engage kill switch", sub: "Stop every new order, from every tool", keywords: "stop all orders safety emergency halt", icon: "power", tint: "red", run: () => ctx.go("safety", "#kill-action") },
    { id: "key", label: "Create API key", sub: "One key per tool, with only the access it needs", keywords: "new token keys access", icon: "keys", tint: "pink", run: () => ctx.go("keys", "#key-label") },
    { id: "console", label: "Open test console", sub: "Try any call and see what comes back", keywords: "try request call endpoint quote", icon: "console", tint: "teal", run: () => ctx.go("console") },
    { id: "paper", label: "Place a paper order", sub: "The order form in the test console", keywords: "buy sell trade order console", icon: "orders", tint: "orange", run: () => ctx.go("console?endpoint=order") },
    { id: "set-expiry", label: "Set expiry…", sub: `For ${c.underlying} on every Analytics page (now ${c.expiry || "not chosen"})`, keywords: "expiry expiration date contract weekly monthly change choose", icon: "clock", tint: "red", opensDialog: true, run: () => openExpirySheet() },
    { id: "density", label: "Toggle compact density", sub: `Now ${document.body.classList.contains("density-compact") ? "Compact" : "Comfortable"}. Tighter tables and cards`, keywords: "density compact comfortable tight rows spacing", icon: "list", tint: "gray", run: () => toast(`Density: ${toggleDensity() === "compact" ? "Compact" : "Comfortable"}`) },
    { id: "theme", label: "Toggle theme", sub: `Now ${currentTheme() === "auto" ? "Auto" : currentTheme() === "light" ? "Light" : "Dark"}`, keywords: "dark light appearance mode", icon: "moon", tint: "indigo", run: () => setTheme({ auto: "light", light: "dark", dark: "auto" }[currentTheme()] ?? "auto") },
    { id: "theme-light", label: "Theme: Light", keywords: "appearance", icon: "sun", tint: "gray", run: () => setTheme("light") },
    { id: "theme-dark", label: "Theme: Dark", keywords: "appearance night", icon: "moon", tint: "gray", run: () => setTheme("dark") },
    { id: "theme-auto", label: "Theme: Auto (match system)", keywords: "appearance system", icon: "monitor", tint: "gray", run: () => setTheme("auto") },
    { id: "copy-url", label: "Copy dashboard URL", keywords: "link address share", icon: "copy", tint: "gray", run: () => copyText(`${location.origin}/dashboard`, "Dashboard URL copied") },
    { id: "refresh", label: "Refresh this page", keywords: "reload update data", icon: "refresh", tint: "gray", run: () => ctx.refresh() },
    { id: "layouts", label: "Layouts…", sub: "Save, load, export or import named workspaces", keywords: "layout layouts preset workspace save load export import", icon: "list", tint: "indigo", opensDialog: true, run: () => openLayouts() },
    { id: "history-back", label: "Back", sub: "To the previous page and context", keywords: "history back previous", icon: "chevron", tint: "gray", hint: ["["], run: () => historyBack() },
    { id: "history-fwd", label: "Forward", sub: "To the next page and context", keywords: "history forward next", icon: "chevron", tint: "gray", hint: ["]"], run: () => historyForward() },
    { id: "set-home", label: "Start page: use this page", sub: "Open here when the address names no page", keywords: "home start landing default page", icon: "home", tint: "blue", run: () => setHomePage() },
    { id: "page-help", label: "Help for this page", sub: "What it is for and what its fields mean (also: help <code>)", keywords: "help ? explain docs guide fields", icon: "info", tint: "gray", opensDialog: true, run: () => openHelp(nowShowing.id) },
    { id: "shortcuts", label: "Keyboard shortcuts", keywords: "help keys hotkeys vim go", icon: "info", tint: "gray", hint: ["?"], opensDialog: true, run: () => showShortcuts() },
  ].map((a) => ({ ...a, group: "Actions" }));
  // Shown only when searching: one command per quick underlying, and each auto-refresh cadence.
  const searchOnly = [
    ...UNDERLYING_CHIPS.map((u) => ({
      id: `underlying-${u}`,
      group: "Actions",
      label: `Go to underlying ${u}`,
      sub: `Use ${u} on every Analytics page${u === c.underlying ? " (current)" : ""}`,
      keywords: `underlying symbol index switch set ${u}`,
      icon: "chart",
      tint: "orange",
      run: () => goUnderlying(u),
    })),
    ...REFRESH_CHOICES.map((r) => ({
      id: `refresh-${r.ms}`,
      group: "Actions",
      label: `Auto-refresh: ${r.short}`,
      sub: r.ms ? `Re-run the page's data every ${r.short} (data pages only)` : "Stop refreshing automatically",
      keywords: "auto refresh automatic poll live update interval timer",
      icon: "refresh",
      tint: "gray",
      run: () => {
        setRefreshInterval(r.ms);
        toast(r.ms ? `Auto-refresh every ${r.short}` : "Auto-refresh off");
      },
    })),
    { id: "layout-save", group: "Actions", label: "Layout: Save current…", sub: "Name this workspace to keep it", keywords: "layout save preset workspace", icon: "list", tint: "indigo", opensDialog: true, run: () => openLayouts({ focus: "save" }) },
    { id: "layout-manage", group: "Actions", label: "Layout: Manage…", sub: "Load, delete, export or import", keywords: "layout manage load delete import export", icon: "list", tint: "indigo", opensDialog: true, run: () => openLayouts({ focus: "none" }) },
    { id: "layout-export", group: "Actions", label: "Layout: Export all (JSON file)", keywords: "layout export download backup json", icon: "copy", tint: "indigo", run: () => exportSavedLayouts() },
    { id: "layout-import", group: "Actions", label: "Layout: Import from a JSON file…", sub: "Opens the layouts dialog", keywords: "layout import upload restore json", icon: "inbox", tint: "indigo", opensDialog: true, run: () => openLayouts({ focus: "none" }) },
    ...savedLayouts().map((l) => ({ id: `layout-load-${l.name}`, group: "Actions", label: `Layout: ${l.name}`, sub: `Load ${l.underlying}${l.expiry ? ` ${l.expiry}` : ""}, ±${l.strikes}, ${l.density}`, keywords: "layout load preset workspace", icon: "list", tint: "indigo", navigates: true, run: () => applyLayout(l) })),
    { id: "reset-home", group: "Actions", label: "Reset start page to Home", keywords: "home start landing default page reset", icon: "home", tint: "blue", run: () => resetHomePage() },
  ].map((x) => ({ ...x, searchOnly: true }));
  return [...recent, ...pageCmds, ...actions, ...searchOnly];
}

function build() {
  input = h("input", {
    type: "text",
    class: "palette-input",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-autocomplete": "list",
    "aria-label": "Search pages and actions, or type a command such as banknifty oc",
    placeholder: "Search, or type a command: banknifty oc · oi nifty · help gx",
    autocomplete: "off",
    spellcheck: "false",
  });
  list = h("ul", { id: "palette-list", class: "palette-list", role: "listbox", "aria-label": "Results" });
  const footer = h(
    "div",
    { class: "palette-foot", "aria-hidden": "true" },
    h("span", {}, kbd("↑"), kbd("↓"), " navigate"),
    h("span", {}, kbd("↵"), " open"),
    h("span", {}, kbd("esc"), " close"),
  );
  // The close button is for pointers and touch; the keyboard closes with Escape (focus stays in the field).
  const closeBtn = h("button", { type: "button", class: "palette-x", "aria-label": "Close search", tabindex: "-1", onclick: () => closePalette() }, icon("close"));
  dlg = h(
    "dialog",
    { class: "palette", "aria-modal": "true", "aria-label": "Command palette" },
    h("div", { class: "palette-search" }, searchIcon(), input, closeBtn),
    list,
    footer,
  );
  input.addEventListener("input", () => {
    activeIndex = 0;
    draw();
  });
  input.addEventListener("keydown", onKey);
  // A click on the dimmed area outside the panel closes it (the dialog element itself is the panel box).
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closePalette();
    }
  });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    closePalette();
  });
  document.body.append(dlg);
}

/**
 * "banknifty oc", "oi nifty", "reliance fut" or "help gx" as a command (terminal.js has the grammar). It is offered as the
 * first result, except when its symbol is also an ordinary word of a page name ("oi change"), where the page match stays first.
 */
function commandResult(q) {
  const pages = ctx.pages();
  const cmd = parseCommand(q, pages.map((p) => p.id));
  if (!cmd) return null;
  if (cmd.kind === "help") {
    if (!cmd.id) return { item: { id: "cmd-help", group: "Actions", label: "Help", sub: "Type help <page code>, for example help oc", icon: "info", tint: "gray", opensDialog: true, run: () => showShortcuts() } };
    const p = pages.find((x) => x.id === cmd.id);
    return { item: { id: `cmd-help-${cmd.id}`, group: "Actions", label: `Help: ${cmd.code}`, sub: `What ${p.title} is for and what its fields mean`, icon: "info", tint: "blue", opensDialog: true, run: () => openHelp(cmd.id) } };
  }
  const p = pages.find((x) => x.id === cmd.id);
  const word = cmd.symbol?.toLowerCase();
  const isWord = word && !UNDERLYING_CHIPS.includes(cmd.symbol) && pages.some((x) => `${x.label} ${x.title} ${x.sub} ${PAGE_KEYWORDS[x.id] ?? ""}`.toLowerCase().split(/\W+/).includes(word));
  const sym = cmd.symbol ? ` · ${cmd.symbol}` : "";
  return {
    afterFirst: Boolean(isWord),
    item: {
      id: "cmd-go",
      group: "Actions",
      label: `${cmd.code}${sym}${cmd.asset ? ` · ${cmd.asset}` : ""}`,
      sub: `${p.title}${cmd.symbol ? `, underlying set to ${cmd.symbol}` : ""}${cmd.hints.length ? `. ${cmd.hints[0]}` : ""}`,
      icon: p.icon,
      tint: p.tint,
      navigates: true,
      kind: "Command",
      run: () => {
        if (cmd.symbol) setUnderlying(cmd.symbol, { navigateTo: p.id });
        else ctx.go(p.id);
        if (cmd.hints.length) toast(cmd.hints[0]);
      },
    },
  };
}

function draw() {
  const q = input.value.trim();
  results = rank(commands().filter((c) => (q ? !c.emptyOnly : !c.searchOnly)), input.value);
  // "underlying reliance" (or "go to underlying X"): any symbol, not only the five quick picks (a prefix of a quick pick, like "fin", finds the pick instead).
  const sym = SYMBOL_QUERY.exec(q)?.[1]?.toUpperCase();
  if (sym && !UNDERLYING_CHIPS.some((u) => u.startsWith(sym))) results.unshift({ id: `underlying-custom`, group: "Actions", label: `Go to underlying ${sym}`, sub: `Use ${sym} on every Analytics page`, icon: "chart", tint: "orange", run: () => goUnderlying(sym) });
  const cmd = commandResult(q);
  if (cmd) results.splice(cmd.afterFirst && results.length ? 1 : 0, 0, cmd.item);
  if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  const items = [];
  let group = null;
  results.forEach((c, i) => {
    if (!input.value.trim() && c.group !== group) {
      group = c.group;
      items.push(h("li", { class: "palette-group", role: "presentation" }, group === "Pages" ? "Go to" : group));
    }
    const hint = c.hint ? kbd(...c.hint) : c.hintText ? h("span", { class: "palette-hint" }, c.hintText) : null;
    const li = h(
      "li",
      { id: `palette-opt-${c.id}`, class: "palette-option", role: "option", "aria-selected": String(i === activeIndex) },
      iconTile(c.icon, c.tint ?? "gray", "md"),
      h(
        "span",
        { class: "palette-text" },
        h("span", { class: "palette-label" }, c.label, input.value.trim() ? h("span", { class: "palette-kind" }, c.kind ?? (c.group === "Pages" || c.group === "Recent" ? "Page" : "Action")) : null),
        c.sub ? h("span", { class: "palette-sub" }, c.sub) : null,
      ),
      hint || c.code ? h("span", { class: "palette-right", "aria-hidden": "true" }, c.code ? h("span", { class: "palette-code" }, c.code) : null, hint) : null,
    );
    li.addEventListener("mousemove", () => {
      if (activeIndex !== i) {
        activeIndex = i;
        markActive();
      }
    });
    li.addEventListener("click", () => runAt(i));
    items.push(li);
  });
  if (!results.length) items.push(h("li", { class: "palette-empty", role: "presentation" }, `No page or action matches “${input.value.trim()}”.`));
  list.replaceChildren(...items);
  markActive();
}

function markActive() {
  const opts = list.querySelectorAll('[role="option"]');
  opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === activeIndex)));
  const cur = opts[activeIndex];
  if (cur) {
    input.setAttribute("aria-activedescendant", cur.id);
    cur.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}

function onKey(e) {
  const n = results.length;
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault();
    if (n) activeIndex = (activeIndex + 1) % n;
    markActive();
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault();
    if (n) activeIndex = (activeIndex - 1 + n) % n;
    markActive();
  } else if (e.key === "Home" && e.ctrlKey) {
    e.preventDefault();
    activeIndex = 0;
    markActive();
  } else if (e.key === "End" && e.ctrlKey) {
    e.preventDefault();
    activeIndex = Math.max(0, n - 1);
    markActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    runAt(activeIndex);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  } else if (e.key === "Tab") {
    // Focus stays in the search field: the list is navigated with the arrow keys.
    e.preventDefault();
  }
}

function runAt(i) {
  const c = results[i];
  if (!c) return;
  const navigates = c.navigates || c.group === "Pages" || c.group === "Recent" || c.opensDialog || c.id.startsWith("underlying-") || ["scan", "kill", "key", "console", "paper"].includes(c.id);
  closePalette({ restore: !navigates });
  c.run();
}

export function openPalette() {
  if (!ctx || otherDialogOpen()) return;
  if (!dlg) build();
  if (dlg.open) return input.focus();
  returnFocus = document.activeElement;
  input.value = "";
  activeIndex = 0;
  draw();
  dlg.showModal();
  lockScroll(true);
  input.focus();
}

export function closePalette({ restore = true } = {}) {
  if (!dlg?.open) return;
  dlg.close();
  if (!otherDialogOpen()) lockScroll(false);
  if (restore && returnFocus && document.contains(returnFocus) && typeof returnFocus.focus === "function") returnFocus.focus();
  returnFocus = null;
}

// ── Shortcuts ──

export function shortcutList() {
  const mod = modKey();
  const pages = ctx?.pages() ?? [];
  return [
    { keys: [mod, "K"], what: "Search pages and actions" },
    { keys: ["/"], what: "Search (when not typing in a field)" },
    { keys: ["?"], what: "Show these shortcuts" },
    { keys: ["g", "then 1 or 2 keys"], what: "Go to a page (Vim style), for example g c or g e x; see the list below" },
    { keys: ["["], what: "Back to the previous page and context" },
    { keys: ["]"], what: "Forward" },
    { keys: ["help oc"], what: "In search: type help or ? and a page code to open that page's help" },
    { keys: ["banknifty oc"], what: "In search: a symbol and a page code (either order) sets the underlying and opens the page; add EQ, FUT or OPT for the instrument type" },
    ...(pages.length ? [{ keys: [mod, "1 to 9"], what: `Go to the first nine pages, in sidebar order (${pages.slice(0, 3).map((p) => p.label).join(", ")} ...)` }] : []),
    { keys: ["↑", "↓"], what: "Move through search results" },
    { keys: ["↵"], what: "Open the selected result" },
    { keys: ["esc"], what: "Close search or a dialog" },
    { keys: ["Tab"], what: "Move to the next control (Shift+Tab goes back)" },
  ];
}

/** The "g then <key>" table for the pages that exist: [{ key, id, label }] in page order. */
export function goShortcutList() {
  const pages = ctx?.pages() ?? [];
  const table = goKeyTable(pages.map((p) => p.id));
  const keyOf = Object.fromEntries(Object.entries(table).map(([k, id]) => [id, k]));
  return pages.filter((p) => keyOf[p.id]).map((p) => ({ key: keyOf[p.id], id: p.id, label: p.label, group: p.group, code: codeOf(p.id) }));
}

export function showShortcuts() {
  if (otherDialogOpen()) return;
  closePalette({ restore: false });
  const rows = shortcutList().map((s) => h("tr", {}, h("td", { class: "shortcut-keys" }, kbd(...s.keys)), h("td", {}, s.what)));
  // Chrome can swallow the first Escape on a dialog opened from a key press; close it through its own button instead.
  const d = document.getElementById("dialog");
  const onEsc = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    d.querySelector(".dialog-actions button")?.click();
  };
  d.addEventListener("keydown", onEsc);
  d.addEventListener("close", () => d.removeEventListener("keydown", onEsc), { once: true });
  return modal({
    title: "Keyboard shortcuts",
    body: h(
      "div",
      { class: "stack shortcuts-sheet" },
      h("table", { class: "shortcuts" }, h("caption", { class: "pal-sr-only" }, "Keyboard shortcuts"), h("thead", { class: "pal-sr-only" }, h("tr", {}, h("th", { scope: "col" }, "Keys"), h("th", { scope: "col" }, "Action"))), h("tbody", {}, rows)),
      goSection(),
      h("p", { class: "muted small" }, isMac() ? "Some browsers keep ⌘1 to ⌘9 for switching tabs; the search (⌘K) always works." : "Some browsers keep Ctrl+1 to Ctrl+9 for switching tabs; the search (Ctrl+K) always works."),
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}

/** The Vim-style section of the shortcuts sheet: every page with its second key, grouped as in the sidebar. */
function goSection() {
  const all = goShortcutList();
  const groups = [...new Set(all.map((x) => x.group))];
  return h(
    "section",
    { class: "go-keys", "aria-labelledby": "go-keys-title" },
    h("h3", { id: "go-keys-title", class: "go-keys-title" }, h("span", {}, "Go to a page: press"), kbd("g"), h("span", {}, "then the page's key")),
    groups.map((g) =>
      h(
        "div",
        { class: "go-group" },
        h("div", { class: "eyebrow" }, g),
        h("ul", { class: "go-list" }, all.filter((x) => x.group === g).map((x) => h("li", {}, kbd(...x.key), h("span", {}, x.label), x.code ? h("span", { class: "go-code" }, x.code) : null))),
      ),
    ),
    h("p", { class: "muted small" }, "These keys never fire while you are typing in a field. Press Esc to cancel after g. The grey code on the right is the page's code for the search bar (for example banknifty oc)."),
  );
}

/** The shortcut label for page n (0-based), e.g. "⌘1", or null past the ninth page. */
export function pageShortcut(i) {
  if (i > 8) return null;
  return { label: isMac() ? `⌘${i + 1}` : `Ctrl+${i + 1}`, aria: `${ariaMod()}+${i + 1}` };
}

let seq = null;
const sequencer = () => (seq ??= createSequencer({ table: () => goKeyTable(ctx.pages().map((p) => p.id)) }));

function onGlobalKey(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && !e.shiftKey && key === "k") {
    e.preventDefault();
    if (dlg?.open) closePalette();
    else openPalette();
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    if (otherDialogOpen()) return;
    const i = Number(e.code.slice(5)) - 1;
    const p = ctx.pages()[i];
    if (!p) return;
    e.preventDefault();
    closePalette({ restore: false });
    ctx.go(p.id);
    return;
  }
  if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph)$/.test(e.key)) return;
  const blocked = e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || dlg?.open || otherDialogOpen() || Boolean(document.querySelector("dialog[open]"));
  // Vim-style "g then a key": never while typing in a field or with a dialog open (that also disarms the g).
  const step = sequencer().feed(e.key, { typing: blocked, shift: e.shiftKey, repeat: e.repeat });
  if (blocked) {
    setKeyHint(false);
    return;
  }
  if (step.kind === "pending") {
    setKeyHint(true);
    return;
  }
  setKeyHint(false);
  if (step.kind === "go") {
    e.preventDefault();
    ctx.go(step.id);
    return;
  }
  if ((e.key === "[" || e.key === "]") && !e.shiftKey && !e.repeat) {
    e.preventDefault();
    if (e.key === "[") historyBack();
    else historyForward();
  } else if (e.key === "/") {
    e.preventDefault();
    openPalette();
  } else if (e.key === "?") {
    e.preventDefault();
    showShortcuts();
  }
}

/**
 * Wire up the palette and global shortcuts once.
 * @param {{ pages: () => Array<{id,label,icon,title,sub}>, go: (id: string, focusSelector?: string) => void, refresh: () => void }} options
 */
export function initPalette(options) {
  if (ctx || typeof document === "undefined") return;
  ctx = options;
  document.addEventListener("keydown", onGlobalKey);
}
