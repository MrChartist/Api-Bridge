// Command palette (Spotlight style) and keyboard shortcuts for the dashboard.
// Browser only: nothing here touches the DOM until initPalette() runs (views.js calls it from startRouter()).
import { api, app, chooseTheme, copyText, h, icon, iconTile, lockScroll, modal, toast } from "./app.js";
import { intentHandoff, intentLabel, parseTradeIntent, pickExpiry } from "./trade-intent.js";
import { parseCommand } from "./terminal.js";
import { helpFor } from "./help.js";
import { PAGE_CODES, createSequencer, goKeyTable, workspace } from "./workspace.js";

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

/** The type credit the SIL Open Font License asks for (dashboard/fonts/LICENSE.md): the About line. */
export const TYPE_CREDIT = "Type: Chartist Sans Flex (from Google Sans Flex by Google), Chartist Sans (from Plus Jakarta Sans by Tokotype) and Chartist Serif (from Instrument Serif by Instrument), under the SIL Open Font License 1.1.";

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

let ctx = null; // { pages, go, refresh }
let dlg = null;
let input = null;
let list = null;
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

/** The group a page sits under in the palette: its sidebar group, "Home" for the first (unlabelled) one. */
const groupOf = (p) => p.group || "Home";

/**
 * The palette's commands: one per page, one per tab of a tabbed page (API › Keys …), the extra destinations a tab
 * lists (each Integrations tool, the audit log; found by searching only), then the actions. Shortcut hints come from
 * the page's curated `key`. Pure apart from reading `ctx`.
 */
export function pageCommands(pages, mod = modKey()) {
  const out = [];
  for (const p of pages) {
    const hint = p.key ? [mod, String(p.key)] : null;
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

/**
 * A typed command line as a palette result (pure apart from `codes`): "banknifty oc" opens the Option Chain on
 * BANKNIFTY, "help oc" explains the page, "help" lists the codes. `codes` is [{ id, label }] for the page ids that
 * open a page here (PR 17's codes, workspace.js PAGE_CODES). Returns null when the text is not a command.
 */
export function commandResult(text, codes) {
  const cmd = parseCommand(text, codes.map((c) => c.id));
  if (!cmd) return null;
  const name = (id) => codes.find((c) => c.id === id)?.label ?? id;
  if (cmd.kind === "help") {
    return cmd.id
      ? { id: "cmd-help", label: `Help: ${name(cmd.id)}`, sub: `What ${cmd.code} shows and what its figures mean`, kind: "help", page: cmd.id }
      : { id: "cmd-help", label: "Page codes", sub: "Type a code, with an underlying if you like: banknifty oc", kind: "codes" };
  }
  return { id: "cmd-go", label: cmd.symbol ? `${name(cmd.id)} for ${cmd.symbol}` : name(cmd.id), sub: [`Typed ${cmd.code}${cmd.symbol ? ` ${cmd.symbol}` : ""}`, ...cmd.hints].join(". "), kind: "go", page: cmd.id, route: codes.find((c) => c.id === cmd.id)?.route ?? cmd.id, symbol: cmd.symbol };
}

const DESK_SLOT = "mcb.dashboard.desk";
/** Run a typed command: point the pages at the underlying (the workspace and the desk), then open the page. */
function runCommand(r) {
  if (r.kind === "go") {
    if (r.symbol) {
      workspace.set({ underlying: r.symbol });
      try {
        const desk = JSON.parse(app.local.get(DESK_SLOT) ?? "{}") ?? {};
        if (desk.underlying !== r.symbol) app.local.set(DESK_SLOT, JSON.stringify({ ...desk, underlying: r.symbol, expiry: null }));
      } catch {
        // No desk prefs yet: the workspace carries the underlying.
      }
    }
    return ctx.go(r.route);
  }
  const codes = ctx.codes?.() ?? [];
  if (r.kind === "codes") {
    return modal({ title: "Page codes", body: h("dl", { class: "pal-codes" }, codes.map((c) => h("div", {}, h("dt", {}, PAGE_CODES[c.id]), h("dd", {}, c.label)))), buttons: [{ label: "Close", value: true }] });
  }
  const help = helpFor(r.page);
  const label = codes.find((c) => c.id === r.page)?.label ?? r.page;
  return modal({
    title: label,
    body: h("div", { class: "stack" }, h("p", {}, help?.what ?? "No help for this page yet."), help?.fields?.length ? h("dl", { class: "pal-codes" }, help.fields.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))) : null, help?.doc ? h("p", { class: "muted small" }, `More in ${help.doc}`) : null),
    buttons: [{ label: "Open the page", value: true, cls: "primary", onClick: () => (ctx.go(codes.find((c) => c.id === r.page)?.route ?? r.page), true) }, { label: "Close", value: false }],
  });
}

function commands() {
  const pageCmds = pageCommands(ctx.pages()).map((c) => ({ ...c, run: () => ctx.go(c.route) }));
  const actions = [
    { id: "kill", label: "Engage kill switch", sub: "Stop every new order, from every tool", keywords: "stop all orders safety emergency halt", icon: "power", tint: "red", run: () => ctx.go("safety", "#kill-action") },
    { id: "key", label: "Create API key", sub: "One key per tool, with only the access it needs", keywords: "new token keys access", icon: "keys", tint: "pink", run: () => ctx.go("api/keys", "#key-label") },
    { id: "console", label: "Open test console", sub: "Try any call and see what comes back", keywords: "try request call endpoint quote", icon: "console", tint: "teal", run: () => ctx.go("api/console") },
    { id: "paper", label: "New order", sub: "Buy or sell by hand: Limit, Market, SL or SL-M", keywords: "buy sell trade order ticket place paper stop loss", icon: "orders", tint: "orange", run: () => ctx.go("orders?new=1") },
    { id: "project", label: "Connect your project", sub: "The address, a ready .env, starters and order updates to your URL", keywords: "connect project api env sdk forward webhook url updates other", icon: "integrations", tint: "blue", run: () => ctx.go("api/integrations?tool=project") },
    { id: "theme", label: "Toggle theme", sub: `Now ${currentTheme() === "auto" ? "Auto" : currentTheme() === "light" ? "Light" : "Dark"}`, keywords: "dark light appearance mode", icon: "moon", tint: "indigo", run: () => setTheme({ auto: "light", light: "dark", dark: "auto" }[currentTheme()] ?? "auto") },
    { id: "theme-light", label: "Theme: Light", keywords: "appearance", icon: "sun", tint: "gray", run: () => setTheme("light") },
    { id: "theme-dark", label: "Theme: Dark", keywords: "appearance night", icon: "moon", tint: "gray", run: () => setTheme("dark") },
    { id: "theme-auto", label: "Theme: Auto (match system)", keywords: "appearance system", icon: "monitor", tint: "gray", run: () => setTheme("auto") },
    { id: "copy-url", label: "Copy dashboard URL", keywords: "link address share", icon: "copy", tint: "gray", run: () => copyText(`${location.origin}/dashboard`, "Dashboard URL copied") },
    { id: "refresh", label: "Refresh this page", keywords: "reload update data", icon: "refresh", tint: "gray", run: () => ctx.refresh() },
    { id: "shortcuts", label: "Keyboard shortcuts", keywords: "help keys hotkeys", icon: "info", tint: "gray", hint: ["?"], run: () => showShortcuts() },
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

function draw() {
  const q = input.value.trim();
  // A typed trade ("buy 2 nifty 26000 ce", "sell nifty straddle 3 nov") comes first: it opens a filled ticket or the
  // Strategy Builder, where the normal confirm applies. Nothing is sent from the palette.
  const intent = q ? parseTradeIntent(q) : null;
  const trade = intent
    ? [{ id: "trade", group: "Actions", label: intentLabel(intent), sub: intent.kind === "leg" ? "Opens the order ticket filled in. Nothing is sent until you confirm it (paper by default)" : "Opens the Strategy Builder with these legs. Place asks before anything is sent", icon: "orders", tint: "green", run: () => openIntent(intent) }]
    : [];
  // A typed command line ("banknifty oc", "help gx") comes next: page codes from the terminal-style command bar.
  const cmd = q && !intent ? commandResult(q, ctx.codes?.() ?? []) : null;
  const typed = cmd ? [{ ...cmd, group: "Pages", icon: cmd.kind === "go" ? "chevron" : "info", tint: "blue", run: () => runCommand(cmd) }] : [];
  results = [...trade, ...typed, ...rank(q ? commands() : commands().filter((c) => !c.searchOnly), input.value)];
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
      iconTile(c.icon, c.tint ?? "gray", "md"),
      h(
        "span",
        { class: "palette-text" },
        h("span", { class: "palette-label" }, c.label, input.value.trim() ? h("span", { class: "palette-kind" }, c.group === "Actions" ? "Action" : "Page") : null),
        c.sub ? h("span", { class: "palette-sub" }, c.sub) : null,
      ),
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

/** Open a typed trade: a filled ticket on the chain (one leg) or the Strategy Builder (a structure). Never sends. */
async function openIntent(x) {
  const DESK = "mcb.dashboard.desk";
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const ex = await api(`/v1/expiries?underlying=${encodeURIComponent(x.underlying)}`).catch((err) => ({ error: err }));
  const expiry = pickExpiry(ex?.data?.data?.expiries ?? [], x.date, today);
  if (!expiry) return toast(ex?.error ? `Couldn't read ${x.underlying} expiries: ${ex.error.message}` : `No ${x.underlying} expiry on that date`, { tone: "warn" });
  let desk = {};
  try {
    desk = JSON.parse(app.local.get(DESK) ?? "{}") ?? {};
  } catch {
    desk = {};
  }
  if (x.kind === "leg") {
    const go = intentHandoff(x, { expiry, desk, nowHash: location.hash });
    app.local.set(DESK, JSON.stringify(go.prefs));
    app.local.set("mcb.dashboard.tradeHandoff", JSON.stringify({ underlying: go.prefs.underlying, expiry: go.prefs.expiry, jump: go.prefs.jump, ticket: go.prefs.ticket }));
    location.hash = go.hash;
    return;
  }
  const r = await api(`/v1/optionchain?underlying=${encodeURIComponent(x.underlying)}&expiry=${encodeURIComponent(expiry)}&strikes=40`).catch((err) => ({ error: err }));
  const chain = r?.data?.data;
  if (!chain?.rows?.length) return toast(`Couldn't load the ${x.underlying} chain`, { tone: "error" });
  const O = await import("./options.js");
  const legs = O.presetLegs(x.preset, chain).map((l) => ({ ...l, lots: (l.lots ?? 1) * x.lots }));
  if (!legs.length) return toast("That structure needs more strikes than the chain lists", { tone: "warn" });
  const go = intentHandoff(x, { expiry, desk, legs, nowHash: location.hash });
  app.local.set(DESK, JSON.stringify(go.prefs));
  app.local.set("mcb.dashboard.tradeHandoff", JSON.stringify({ underlying: go.prefs.underlying, expiry: go.prefs.expiry, baskets: go.prefs.baskets }));
  location.hash = go.hash;
  toast(`${intentLabel(x)} is in the Strategy Builder. Review, then Place`);
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
  const navigates = c.group !== "Actions" || ["scan", "kill", "key", "console", "paper", "trade"].includes(c.id);
  closePalette({ restore: !navigates });
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
  const mod = modKey();
  const pages = ctx?.pages() ?? [];
  return [
    { keys: [mod, "K"], what: "Search pages and actions" },
    { keys: ["/"], what: "Search (when not typing in a field)" },
    { keys: ["?"], what: "Show these shortcuts" },
    ...pages.filter((p) => p.key).sort((a, b) => a.key - b.key).map((p) => ({ keys: [mod, String(p.key)], what: `Go to ${p.label}` })),
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
      h("p", { class: "type-credit" }, h("strong", {}, "About. "), TYPE_CREDIT),
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}

/** The shortcut of a page (its curated `key`, 1 to 9) or of a key number, e.g. "⌘1"; null for a page without one. */
export function pageShortcut(pageOrKey) {
  const k = typeof pageOrKey === "object" ? pageOrKey?.key : pageOrKey;
  if (!Number.isInteger(k) || k < 1 || k > 9) return null;
  return { label: isMac() ? `⌘${k}` : `Ctrl+${k}`, aria: `${ariaMod()}+${k}` };
}

let seq = null;
/** g then a page's go-key ("g c" the chain, "g o" OI): the go-keys of the pages that open here. */
function goSequencer() {
  if (!seq) seq = createSequencer({ table: () => goKeyTable((ctx.codes?.() ?? []).map((c) => c.id)) });
  return seq;
}
/** The route a go-key's page id opens (PR 17 ids such as gex open their tab here). */
function routeOf(id) {
  return (ctx.codes?.() ?? []).find((c) => c.id === id)?.route ?? id;
}
function onGlobalKey(e) {
  if (e.defaultPrevented || e.isComposing) return;
  // Pages that use g themselves (the chain, OI and the Strategy Builder go back to ATM with g) keep it.
  const ownG = ["chain", "strategy", "positions", "oi", "vol", "arb"].includes(document.documentElement.dataset.page ?? "");
  if (ctx.codes && !ownG) {
    const r = goSequencer().feed(e.key, { typing: isTyping(e.target) || Boolean(dlg?.open) || otherDialogOpen(), modifier: e.ctrlKey || e.metaKey || e.altKey, shift: e.shiftKey, repeat: e.repeat });
    if (r.kind === "go") {
      e.preventDefault();
      ctx.go(routeOf(r.id));
      return;
    }
    if (r.kind === "pending") {
      e.preventDefault();
      return;
    }
  }
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
