// Command palette (Spotlight style) and keyboard shortcuts for the dashboard.
// Browser only: nothing here touches the DOM until initPalette() runs (views.js calls it from startRouter()).
import { applyTheme, copyText, h, icon, modal, toast } from "./app.js";

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
  // The sidebar's own theme buttons apply and remember the choice; fall back to applyTheme alone.
  const btn = document.querySelector(`[data-theme-choice="${choice}"]`);
  if (btn) btn.click();
  else applyTheme(choice);
  toast(`Theme: ${choice === "auto" ? "Auto (matches your system)" : choice === "light" ? "Light" : "Dark"}`);
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") ?? "auto";
}

function commands() {
  const pages = ctx.pages();
  const mod = modKey();
  const pageCmds = pages.map((p, i) => ({
    id: `page-${p.id}`,
    group: "Pages",
    label: p.label,
    keywords: `${p.title} ${p.sub} go open page`,
    icon: p.icon,
    hint: i < 9 ? [mod, String(i + 1)] : null,
    run: () => ctx.go(p.id),
  }));
  const actions = [
    { id: "scan", label: "Run a scan", keywords: "scanner screener condition rsi", icon: "scan", run: () => ctx.go("scanner", "#scan-condition") },
    { id: "kill", label: "Engage kill switch", keywords: "stop all orders safety emergency halt", icon: "power", run: () => ctx.go("safety", "#kill-action") },
    { id: "key", label: "Create API key", keywords: "new token keys access", icon: "keys", run: () => ctx.go("keys", "#key-label") },
    { id: "console", label: "Open test console", keywords: "try request call endpoint quote", icon: "console", run: () => ctx.go("console") },
    { id: "paper", label: "Place a paper order", keywords: "buy sell trade order console", icon: "orders", run: () => ctx.go("console?endpoint=order") },
    { id: "theme", label: "Toggle theme", keywords: "dark light appearance mode", icon: "bolt", hintText: `now ${currentTheme()}`, run: () => setTheme({ auto: "light", light: "dark", dark: "auto" }[currentTheme()] ?? "auto") },
    { id: "theme-light", label: "Theme: Light", keywords: "appearance", icon: "bolt", run: () => setTheme("light") },
    { id: "theme-dark", label: "Theme: Dark", keywords: "appearance night", icon: "bolt", run: () => setTheme("dark") },
    { id: "theme-auto", label: "Theme: Auto (match system)", keywords: "appearance system", icon: "bolt", run: () => setTheme("auto") },
    { id: "copy-url", label: "Copy dashboard URL", keywords: "link address share", icon: "copy", run: () => copyText(`${location.origin}/dashboard`, "Dashboard URL copied") },
    { id: "refresh", label: "Refresh this page", keywords: "reload update data", icon: "refresh", run: () => ctx.refresh() },
    { id: "shortcuts", label: "Keyboard shortcuts", keywords: "help keys hotkeys", icon: "info", hint: ["?"], run: () => showShortcuts() },
  ].map((a) => ({ ...a, group: "Actions" }));
  return [...pageCmds, ...actions];
}

function build() {
  input = h("input", {
    type: "text",
    class: "palette-input",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-autocomplete": "list",
    "aria-label": "Search pages and actions",
    placeholder: "Search pages and actions",
    autocomplete: "off",
    spellcheck: "false",
  });
  list = h("ul", { id: "palette-list", class: "palette-list", role: "listbox", "aria-label": "Results" });
  const footer = h(
    "div",
    { class: "palette-foot", "aria-hidden": "true" },
    h("span", {}, kbd("↑"), kbd("↓"), " to move"),
    h("span", {}, kbd("↵"), " to open"),
    h("span", {}, kbd("esc"), " to close"),
  );
  dlg = h(
    "dialog",
    { class: "palette vibrant", "aria-modal": "true", "aria-label": "Command palette" },
    h("div", { class: "palette-search" }, searchIcon(), input, h("kbd", { class: "kbd", "aria-hidden": "true" }, "esc")),
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

function draw() {
  results = rank(commands(), input.value);
  if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  const items = [];
  let group = null;
  results.forEach((c, i) => {
    if (!input.value.trim() && c.group !== group) {
      group = c.group;
      items.push(h("li", { class: "palette-group", role: "presentation" }, group));
    }
    const hint = c.hint ? kbd(...c.hint) : c.hintText ? h("span", { class: "palette-hint" }, c.hintText) : null;
    const li = h(
      "li",
      { id: `palette-opt-${c.id}`, class: "palette-option", role: "option", "aria-selected": String(i === activeIndex) },
      h("span", { class: "palette-icon" }, icon(c.icon)),
      h("span", { class: "palette-label" }, c.label, input.value.trim() ? h("span", { class: "palette-kind" }, c.group === "Pages" ? "Page" : "Action") : null),
      hint ? h("span", { class: "palette-right", "aria-hidden": "true" }, hint) : null,
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
  const navigates = c.group === "Pages" || ["scan", "kill", "key", "console", "paper"].includes(c.id);
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
  input.focus();
}

export function closePalette({ restore = true } = {}) {
  if (!dlg?.open) return;
  dlg.close();
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
    ...pages.slice(0, 9).map((p, i) => ({ keys: [mod, String(i + 1)], what: `Go to ${p.label}` })),
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
      { class: "stack shortcuts-sheet" },
      h("table", { class: "shortcuts" }, h("caption", { class: "pal-sr-only" }, "Keyboard shortcuts"), h("thead", { class: "pal-sr-only" }, h("tr", {}, h("th", { scope: "col" }, "Keys"), h("th", { scope: "col" }, "Action"))), h("tbody", {}, rows)),
      h("p", { class: "muted small" }, isMac() ? "Some browsers keep ⌘1 to ⌘9 for switching tabs; the search (⌘K) always works." : "Some browsers keep Ctrl+1 to Ctrl+9 for switching tabs; the search (Ctrl+K) always works."),
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}

/** The shortcut label for page n (0-based), e.g. "⌘1", or null past the ninth page. */
export function pageShortcut(i) {
  if (i > 8) return null;
  return { label: isMac() ? `⌘${i + 1}` : `Ctrl+${i + 1}`, aria: `${ariaMod()}+${i + 1}` };
}

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
