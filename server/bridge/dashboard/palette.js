// Command palette (Spotlight style) and keyboard shortcuts for the dashboard.
// Browser only: nothing here touches the DOM until initPalette() runs (views.js calls it from startRouter()).
import { app, chooseDensity, chooseTheme, copyText, h, icon, iconTile, lockScroll, modal, toast, toggleSidebarRail } from "./app.js";
import { getMode, setMode } from "./easy-core.js";

/** The modifier shown in every shortcut hint. One label for everyone: the key handler accepts Control or Command alike. */
export const MOD = "Ctrl";
/**
 * The one helper for shortcut hints. shortcut("K") gives { keys: ["Ctrl", "K"], label: "Ctrl K", aria: "Control+K Meta+K" }:
 * `keys` for kbd(), `label` for a title or visible text, `aria` for aria-keyshortcuts.
 */
export function shortcut(key) {
  return { keys: [MOD, String(key)], label: `${MOD} ${key}`, aria: `Control+${key} Meta+${key}` };
}

/** A key cap (or several, e.g. kbd(...shortcut("K").keys)). */
export function kbd(...keys) {
  return h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", { class: "kbd" }, k)));
}

/** Magnifier icon (static markup from this file). */
export const searchIcon = () => icon("search");

/**
 * Match a query against a label. Higher is better, -1 means no match. Tiers: exact or prefix (1000s) > a word start
 * (800s) > a substring (600s) > every character in order (fuzzy, under 600). A fuzzy hit must score at least
 * 3 per query character, so "rate" finds Rate limits and not every label with an r, an a, a t and an e. Pure.
 */
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, " ").trim();
  const t = String(text).toLowerCase();
  if (!q) return 0;
  if (t === q) return 2000;
  const direct = t.indexOf(q);
  if (direct === 0) return 1000 - t.length;
  if (direct > 0) {
    // A later word start beats an earlier mid-word hit ("limits" in "Rate limits" before "slimits").
    const words = [...t.matchAll(/(^|\W)(\w)/g)].map((m) => m.index + m[1].length);
    const at = words.find((w) => t.startsWith(q, w));
    if (at !== undefined) return 800 - at - t.length / 10;
    return 600 - direct - t.length / 10;
  }
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
  return score >= q.replace(/ /g, "").length * 3 ? Math.min(score, 599) : -1;
}

/** Rank commands for a query (label, then keywords). Pure. */
export function rank(commands, query) {
  if (!query.trim()) return commands;
  return commands
    // Fuzzy on the visible label; keywords (synonyms) count only as whole-substring hits, so results stay relevant.
    .map((c, i) => ({ c, i, s: Math.max(fuzzyScore(query, c.label), `${c.keywords ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()) ? 50 : -1) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Where a query matches a label, as [start, end) ranges to highlight: the substring when there is one, else the
 * characters of a fuzzy match, with neighbours merged. [] when nothing in the label matches (a keyword hit). Pure.
 */
export function matchRanges(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, " ").trim();
  const t = String(text).toLowerCase();
  if (!q) return [];
  const at = t.indexOf(q);
  if (at >= 0) return [[at, at + q.length]];
  if (fuzzyScore(q, t) < 0) return [];
  const out = [];
  let ti = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return [];
    if (out.length && out[out.length - 1][1] === i) out[out.length - 1][1] = i + 1;
    else out.push([i, i + 1]);
    ti = i + 1;
  }
  return out;
}

/** The label as nodes with the matched parts in <mark>. Pure apart from creating elements. */
function highlighted(label, query) {
  const ranges = matchRanges(query, label);
  if (!ranges.length) return [label];
  const out = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) out.push(label.slice(at, a));
    out.push(h("mark", { class: "pal-mark" }, label.slice(a, b)));
    at = b;
  }
  if (at < label.length) out.push(label.slice(at));
  return out;
}

const RECENT_SLOT = "mcb.dashboard.palette.recent";
const RECENT_MAX = 4;
/** The last commands run from the palette (ids, newest first), kept in this browser. */
export function recentIds() {
  try {
    const v = JSON.parse(app.local.get(RECENT_SLOT) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
const remember = (id) => app.local.set(RECENT_SLOT, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX)));

let ctx = null; // { pages, go, refresh }
let dlg = null;
let input = null;
let list = null;
let say = null;
let results = [];
let activeIndex = 0;
let returnFocus = null;

const isTyping = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
/** The page sheet is open and not on its way out (a closing sheet is inert and gives way to the palette). */
const otherDialogOpen = () => {
  const d = document.getElementById("dialog");
  return Boolean(d?.open) && !("closing" in d.dataset);
};

function setTheme(choice) {
  chooseTheme(choice);
  toast(`Theme: ${choice === "auto" ? "Auto (matches your system)" : choice === "light" ? "Light" : "Dark"}`);
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") ?? "auto";
}

/** The group a page sits under in the palette: its sidebar group. */
const groupOf = (p) => p.group;

/**
 * The palette's commands: one per page, one per tab of a tabbed page (API › Keys …), the extra destinations a tab
 * lists (each Integrations tool, the audit log; found by searching only), then the actions. Shortcut hints come from
 * the page's curated `key`. Pure apart from reading `ctx`.
 */
export function pageCommands(pages) {
  const out = [];
  for (const p of pages) {
    const hint = p.key ? shortcut(p.key).keys : null;
    if (!p.tabs?.length) {
      out.push({ id: `page-${p.id}`, group: groupOf(p), label: p.label, keywords: `${p.title} ${p.sub} ${p.keywords ?? ""} go open page`, icon: p.icon, tint: p.tint, sub: p.sub, hint, route: p.id });
      continue;
    }
    p.tabs.forEach((t, i) => {
      out.push({ id: `page-${p.id}-${t.id}`, group: groupOf(p), label: t.command ?? `${p.label} ${t.label}`, keywords: `${p.label} ${t.label} ${t.page} ${t.keywords ?? ""} go open page tab`, icon: t.icon ?? p.icon, tint: t.tint ?? p.tint, sub: `${p.label} › ${t.label}`, hint: i === 0 ? hint : null, route: `${p.id}/${t.id}` });
      for (const x of t.extras ?? []) out.push({ id: `page-${p.id}-${t.id}-${x.id}`, group: groupOf(p), label: x.label, keywords: `${x.keywords ?? ""} ${t.label}`, icon: x.icon ?? t.icon ?? p.icon, tint: x.tint ?? t.tint ?? p.tint, sub: x.sub ?? `${p.label} › ${t.label}`, hint: null, route: x.route, searchOnly: true });
    });
  }
  return out;
}

const fineDesktop = () => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
const densityNow = () => document.documentElement.dataset.density;

/**
 * Everything the palette can do, in three sections: Pages (and each tab), Actions, Settings. A command may be
 * `navigates` (it moves to another page, so focus is not given back to where it was).
 */
function commands() {
  const pageCmds = pageCommands(ctx.pages()).map((c) => ({ ...c, section: "Pages", navigates: true, run: () => ctx.go(c.route) }));
  const theme = currentTheme();
  const sb = document.documentElement.dataset.sb;
  const actions = [
    { id: "kill", label: "Stop all orders", sub: "Kill switch: stop every new order, from every tool", keywords: "kill switch emergency halt engage safety", icon: "stop", tint: "red", navigates: true, run: () => ctx.go("safety", "#kill-action") },
    { id: "ready", label: "Check trading readiness now", sub: "Run the session, IP, limits and kill-switch checks", keywords: "safety status session static ip health", icon: "safety", tint: "green", run: () => import("./readiness.js").then((m) => m.checkNow(null)) },
    { id: "key", label: "Create API key", sub: "One key per tool, with only the access it needs", keywords: "new token keys access", icon: "keys", tint: "pink", navigates: true, run: () => ctx.go("api/keys", "#key-label") },
    { id: "console", label: "Open test console", sub: "Try any call and see what comes back", keywords: "try request call endpoint quote", icon: "console", tint: "teal", navigates: true, run: () => ctx.go("api/console") },
    { id: "paper", label: "Place a paper order", sub: "Practice buy or sell with pretend money", keywords: "buy sell trade order practice paper shares stock", icon: "orders", tint: "orange", navigates: true, run: () => ctx.go("orders?practice=1") },
    { id: "help", label: "Something wrong?", sub: "Rate limited, an old price, a key that does not work", keywords: "help problem trouble error rate limited slow old price prices delayed late stale stop why wrong", icon: "info", tint: "blue", run: () => import("./help.js").then((m) => m.openHelp(null)) },
    { id: "copy-url", label: "Copy dashboard URL", keywords: "link address share", icon: "copy", tint: "gray", run: () => copyText(`${location.origin}/dashboard`, "Dashboard URL copied") },
    { id: "refresh", label: "Refresh this page", keywords: "reload update data", icon: "refresh", tint: "gray", run: () => ctx.refresh() },
    { id: "shortcuts", label: "Keyboard shortcuts", keywords: "help keys hotkeys", icon: "info", tint: "gray", hint: ["?"], run: () => showShortcuts() },
  ].map((a) => ({ ...a, group: "Actions", section: "Actions" }));
  const themes = [["auto", "Theme: Auto (match system)", "monitor", "appearance system"], ["light", "Theme: Light", "sun", "appearance day"], ["dark", "Theme: Dark", "moon", "appearance night"]].map(([v, label, ic, kw]) => ({ id: `theme-${v}`, label, sub: theme === v ? "Current" : undefined, keywords: kw, icon: ic, tint: "indigo", run: () => setTheme(v) }));
  const density = fineDesktop() ? [["auto", "Density: Automatic"], ["comfortable", "Density: Comfortable"], ["compact", "Density: Compact"]].map(([v, label]) => ({ id: `density-${v}`, label, sub: v !== "auto" && densityNow() === v ? "Current" : undefined, keywords: "spacing rows tighter roomier", icon: "density", tint: "teal", run: () => (chooseDensity(v), toast(`Density: ${v === "auto" ? "Automatic" : v === "compact" ? "Compact" : "Comfortable"}`))})) : [];
  const sidebar = sb === "rail" || sb === "full" ? [{ id: "sidebar", label: sb === "rail" ? "Expand the sidebar" : "Collapse the sidebar to icons", keywords: "menu navigation rail", icon: sb === "rail" ? "rail" : "sidebar", tint: "blue", run: () => toggleSidebarRail() }] : [];
  const view = getMode() === "simple"
    ? [{ id: "view-advanced", label: "View: Advanced", sub: "Adds Developers, API keys, the test console, Activity and Quotas to the menu", keywords: "advanced everything all pages developer developers expert show more simple events", icon: "console", tint: "indigo", run: () => (setMode("advanced"), toast("Advanced view: every page is in the menu")) }]
    : [{ id: "view-simple", label: "View: Simple", sub: "Only the essentials in the menu; nothing is removed", keywords: "simple basic fewer pages essentials hide advanced", icon: "accounts", tint: "indigo", run: () => (setMode("simple"), toast("Simple view")) }];
  const settings = [...view, ...themes, ...density, ...sidebar].map((a) => ({ ...a, group: "Settings", section: "Settings" }));
  return [...pageCmds, ...actions, ...settings];
}

function build() {
  input = h("input", {
    type: "text",
    class: "palette-input",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-autocomplete": "list",
    "aria-label": "Search pages, actions and settings",
    placeholder: "Search pages and actions",
    autocomplete: "off",
    spellcheck: "false",
  });
  list = h("ul", { id: "palette-list", class: "palette-list", role: "listbox", "aria-label": "Results" });
  // What the list says, for screen readers: how many results, or that there are none.
  say = h("div", { class: "pal-sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" });
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
    say,
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

const SECTIONS = ["Pages", "Actions", "Settings"];

/** The groups to show: with no query, Recent first and then each section in order; with one, sections in order of their best match. */
function groupsFor(q) {
  const all = commands();
  if (q) {
    const hits = rank(all, q);
    const order = [...new Set(hits.map((c) => c.section))];
    return order.map((name) => [name, hits.filter((c) => c.section === name)]);
  }
  const recent = recentIds().map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const rest = all.filter((c) => !c.searchOnly && !recent.includes(c));
  return [["Recent", recent], ...SECTIONS.map((name) => [name, rest.filter((c) => c.section === name)])].filter(([, list]) => list.length);
}

function draw() {
  const q = input.value.trim();
  const groups = groupsFor(q);
  results = groups.flatMap(([, list]) => list);
  if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  const items = [];
  let i = 0;
  for (const [name, list] of groups) {
    const gid = `palette-group-${name}`;
    items.push(h("li", { class: "palette-group", role: "presentation", id: gid }, name));
    for (const c of list) {
      const n = i++;
      const hint = c.hint ? kbd(...c.hint) : null;
      const li = h(
        "li",
        { id: `palette-opt-${n}`, class: "palette-option", role: "option", "aria-selected": String(n === activeIndex) },
        iconTile(c.icon, c.tint ?? "gray", "md"),
        h("span", { class: "palette-text" }, h("span", { class: "palette-label" }, highlighted(c.label, q)), c.sub ? h("span", { class: "palette-sub" }, c.sub) : null),
        hint ? h("span", { class: "palette-right", "aria-hidden": "true" }, hint) : null,
      );
      li.addEventListener("mousemove", () => {
        if (activeIndex !== n) {
          activeIndex = n;
          markActive();
        }
      });
      li.addEventListener("click", () => runAt(n));
      items.push(li);
    }
  }
  if (!results.length) {
    items.push(h("li", { class: "palette-empty", role: "presentation" }, icon("search"), h("strong", {}, `No results for “${q}”`), h("span", {}, "Try a page such as Accounts, Orders or Keys, or an action such as Stop all orders.")));
  }
  list.replaceChildren(...items);
  markActive();
  if (q || !results.length) say.textContent = results.length ? `${results.length} ${results.length === 1 ? "result" : "results"}` : `No results for ${q}`;
  else say.textContent = "";
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
  remember(c.id);
  closePalette({ restore: !c.navigates });
  c.run();
}

export function openPalette() {
  if (!ctx || otherDialogOpen()) return;
  // A sheet still sliding away closes now, so its focus return cannot pull focus out of the palette.
  document.getElementById("dialog")?.closeNow?.();
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
  const pages = ctx?.pages() ?? [];
  return [
    { keys: shortcut("K").keys, what: "Search pages and actions" },
    { keys: ["/"], what: "Search (when not typing in a field)" },
    { keys: ["?"], what: "Show these shortcuts" },
    ...pages.filter((p) => p.key).sort((a, b) => a.key - b.key).map((p) => ({ keys: shortcut(p.key).keys, what: `Go to ${p.label}` })),
    { keys: ["↑", "↓"], what: "Move through search results" },
    { keys: ["↵"], what: "Open the selected result" },
    { keys: ["esc"], what: "Close search or a dialog" },
    { keys: ["Tab"], what: "Move to the next control (Shift+Tab goes back)" },
  ];
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
      { class: "stack" },
      h("table", { class: "shortcuts" }, h("caption", { class: "pal-sr-only" }, "Keyboard shortcuts"), h("thead", { class: "pal-sr-only" }, h("tr", {}, h("th", { scope: "col" }, "Keys"), h("th", { scope: "col" }, "Action"))), h("tbody", {}, rows)),
      h("p", { class: "muted small" }, "On a Mac, Command works in place of Ctrl. Some browsers keep Ctrl and a number for switching tabs; the search (Ctrl K) always works."),
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}

/** The shortcut of a page (its curated `key`, 1 to 9) or of a key number, e.g. "Ctrl 1"; null for a page without one. */
export function pageShortcut(pageOrKey) {
  const k = typeof pageOrKey === "object" ? pageOrKey?.key : pageOrKey;
  if (!Number.isInteger(k) || k < 1 || k > 9) return null;
  return shortcut(k);
}

function onGlobalKey(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const mod = e.ctrlKey !== e.metaKey; // Control or Command, not both
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && !e.shiftKey && key === "k") {
    e.preventDefault();
    if (dlg?.open) closePalette();
    else openPalette();
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    if (otherDialogOpen()) return;
    const k = Number(e.code.slice(5));
    const p = ctx.pages().find((x) => x.key === k);
    if (!p) return;
    e.preventDefault();
    closePalette({ restore: false });
    ctx.go(p.id);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || dlg?.open || otherDialogOpen()) return;
  if (e.key === "/") {
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
