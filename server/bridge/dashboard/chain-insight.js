// The option chain's insight cards and its "How to read the chain" sheet (the drawing half; chain-insight-core.js has
// the content and the placement maths, chain-help.js the copy).
//
// Cards: rest the pointer on a chain cell (350 ms) or a column header; press I on the focused row (again for the next
// column out); tap a figure in the row's action sheet on a touch screen. One card element serves every cell: it is
// filled when it opens and once a second while it stays open, never per tick. It lives in the top layer (popover), so
// it shows over the action sheet too, and is placed to stay on screen. Esc, leaving the cell, a scroll or a tap closes it.
//
// desk.js hooks in with one call: installChainInsight(chainEl, { x: () => chain.x, cfg: () => st.cfg, keys: keysEl }).
import { h, modal } from "./app.js";
import { DASH, formatCompact, formatFixed, formatPercent, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { segmented } from "./views.js";
import { cardModel, placeCard, readCell } from "./chain-insight-core.js";
import { CELL_INDEX, FAMILIES, QUIZ, READING_ORDER, cellHelp, quizSummary, scoreQuiz, searchCells } from "./chain-help.js";
import { FACT_KEYS, cellFacts } from "./chain-facts.js";

const HOVER_MS = 350;
/** While a card is open, how often it re-reads the chain (ms). Nothing runs while it is closed. */
const REFRESH_MS = 1000;
const finePointer = () => typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Fact rows: the columns' own facts (chain-facts.js cellFacts) for the keys it knows, else chain-insight-core.js ──
const FACT_SET = new Set(FACT_KEYS);
const factsOf = (key, q, row, side, x) => {
  if (!FACT_SET.has(key)) return null;
  try {
    const f = cellFacts(key, q, row, side, x);
    return Array.isArray(f) && f.length ? f : null;
  } catch {
    return null;
  }
};

// ── The one card ──
let card = null;
/** What the card shows now: { el, mode: "hover"|"key"|"tap"|"head", read: () => model|null, sig }. */
let open = null;
let refreshTimer = 0;
function cardEl() {
  if (card) return card;
  card = h("div", { class: "chain-insight", id: "chain-insight", role: "tooltip", popover: "manual" });
  document.body.append(card);
  return card;
}
const isOpen = () => Boolean(open);

function hide() {
  clearInterval(refreshTimer);
  refreshTimer = 0;
  if (!open) return;
  open.el?.removeAttribute?.("aria-describedby");
  open.describer?.removeAttribute("aria-describedby");
  open = null;
  if (!card) return;
  card.classList.remove("on");
  try {
    if (card.matches(":popover-open")) card.hidePopover();
  } catch {
    /* no popover support: the class does it */
  }
  card.hidden = true;
}

function place(el) {
  const c = cardEl();
  const r = el.getBoundingClientRect();
  const p = placeCard(r, { w: c.offsetWidth, h: c.offsetHeight }, { w: innerWidth, h: innerHeight });
  c.style.left = `${p.left}px`;
  c.style.top = `${p.top}px`;
  c.dataset.place = p.place;
}

/** Open (or move) the card on `el`, filled from `read()`. */
function show(el, mode, read, describer = null) {
  const model = read();
  if (!model) return hide();
  const c = cardEl();
  const sig = JSON.stringify(model);
  const moved = open?.el !== el;
  open?.describer?.removeAttribute("aria-describedby");
  open = { el, mode, read, sig, describer };
  c.replaceChildren(...drawCard(model));
  c.hidden = false;
  try {
    // Re-entering the top layer puts the card above a dialog opened since (the action sheet).
    if (c.matches(":popover-open")) c.hidePopover();
    c.showPopover();
  } catch {
    /* no popover support: position: fixed and the z-index do it */
  }
  place(el);
  if (moved && !reducedMotion()) {
    c.classList.remove("on");
    void c.offsetWidth;
  }
  c.classList.add("on");
  describer?.setAttribute("aria-describedby", "chain-insight");
  clearInterval(refreshTimer);
  if (mode !== "head") refreshTimer = setInterval(refresh, REFRESH_MS);
}
function refresh() {
  if (!open || !open.el.isConnected) return hide();
  const m = open.read();
  if (!m) return hide();
  const sig = JSON.stringify(m);
  if (sig === open.sig) return;
  open.sig = sig;
  card.replaceChildren(...drawCard(m));
  place(open.el);
}

// ── Drawing ──
const arrow = (tone) => (tone === "up" ? "▲" : tone === "down" ? "▼" : "·");
const toneCls = (tone) => (tone === "up" ? "up" : tone === "down" ? "down" : undefined);
const toneOf = (v) => (!isFigure(v) || v === 0 ? null : v > 0 ? "up" : "down");
const g = (v, dp = 2) => (isFigure(v) ? formatFixed(v, dp) : DASH);

function drawCard(m) {
  const out = [h("div", { class: "ci-head" }, h("div", { class: "ci-title" }, m.title), m.sub ? h("div", { class: "ci-sub" }, m.sub) : null)];
  if (m.help) {
    out.push(h("p", { class: "ci-line" }, m.help.shows), h("dl", { class: "ci-facts ci-def" }, h("div", {}, h("dt", {}, "Worked out"), h("dd", {}, m.help.how)), h("div", {}, h("dt", {}, "When empty"), h("dd", {}, m.help.empty))));
    out.push(h("p", { class: "ci-foot" }, "Click the header for the full cell index."));
    return out;
  }
  if (m.headline) out.push(h("p", { class: `ci-line${m.tone ? ` ${m.tone}` : ""}` }, m.headline));
  const v = m.visual ? drawVisual(m.visual) : null;
  if (v) out.push(v);
  if (m.facts?.length) out.push(h("dl", { class: "ci-facts" }, m.facts.map((f) => h("div", {}, h("dt", {}, f.label, f.note ? h("small", {}, f.note) : null), h("dd", { class: toneCls(f.tone) }, f.value ?? DASH)))));
  if (m.how) out.push(h("p", { class: "ci-foot" }, m.how));
  return out;
}

function meter(frac, cls) {
  const el = h("span", { class: `ci-meter ${cls ?? ""}`.trim(), "aria-hidden": "true" }, h("i"));
  el.firstChild.style.transform = `scaleX(${Math.max(0, Math.min(1, frac || 0))})`;
  return el;
}

function drawVisual(v) {
  if (v.kind === "buildup") {
    const row = (label, mv, dp) =>
      h(
        "div",
        { class: "ci-move" },
        h("span", { class: "ci-move-l" }, label),
        h("span", { class: `ci-move-v ${toneCls(toneOf(mv.chg)) ?? ""}`.trim() }, arrow(toneOf(mv.chg)), " ", isFigure(mv.pct) ? `${formatSigned(mv.pct, dp)}%` : DASH),
        h("span", { class: "ci-move-r" }, `${label === "Premium" ? g(mv.from) : isFigure(mv.from) ? formatCompact(mv.from) : DASH} → ${label === "Premium" ? g(mv.to) : isFigure(mv.to) ? formatCompact(mv.to) : DASH}`),
      );
    const tone = v.tag === "LB" || v.tag === "SC" ? "up" : v.tag ? "down" : null;
    return h(
      "div",
      { class: "ci-vis ci-bu" },
      row("Premium", v.price, 2),
      row("Open interest", v.oi, 1),
      v.strength === null || !v.tag
        ? null
        : h("div", { class: "ci-move" }, h("span", { class: "ci-move-l" }, "Strength"), meter(v.strength, toneCls(tone)), h("span", { class: "ci-move-r" }, `${formatPercent(v.strength * 100, 0)} of largest`)),
    );
  }
  if (v.kind === "oi") {
    const scale = Math.max(v.prev, v.now) || 1;
    const add = v.chg > 0;
    const base = Math.min(v.prev, v.now);
    const track = (solid, extra, cls) => {
      const t = h("span", { class: "ci-track", "aria-hidden": "true" }, h("i", { class: "ci-solid" }), extra ? h("i", { class: `ci-stripe ${cls}` }) : null);
      t.children[0].style.width = `${(solid / scale) * 100}%`;
      if (extra) {
        t.children[1].style.left = `${(solid / scale) * 100}%`;
        t.children[1].style.width = `${(extra / scale) * 100}%`;
      }
      return t;
    };
    return h(
      "div",
      { class: "ci-vis ci-oi" },
      h("div", { class: "ci-bar-row" }, h("span", {}, "Baseline"), track(v.prev, 0), h("span", { class: "ci-bar-v" }, formatCompact(v.prev))),
      h("div", { class: "ci-bar-row" }, h("span", {}, "Now"), track(base, Math.abs(v.chg ?? 0), add ? "add up-fill" : "cut down-fill"), h("span", { class: "ci-bar-v" }, formatCompact(v.now))),
      v.chg ? h("p", { class: `ci-cap ${add ? "up" : "down"}` }, `${arrow(add ? "up" : "down")} Striped: ${formatCompact(Math.abs(v.chg))} ${add ? "added" : "cut"}`) : null,
    );
  }
  if (v.kind === "quote") {
    const gap = v.mid ? Math.min(1, v.spread / v.mid) : 0;
    const bar = meter(Math.max(0.04, gap * 4), "neutral");
    return h(
      "div",
      { class: "ci-vis ci-quote" },
      h("div", { class: "ci-touch" }, h("span", { class: "ci-q down" }, h("small", {}, "Bid"), g(v.bid)), bar, h("span", { class: "ci-q up" }, h("small", {}, "Ask"), g(v.ask))),
      h("p", { class: "ci-cap" }, `Spread ${g(v.spread)} · ${formatPercent(v.spreadPct, 2)} of mid`, isFigure(v.bidPct) ? ` · bid ${formatPercent(v.bidPct, 3)}, ask ${formatPercent(v.askPct, 3)} of spot` : ""),
    );
  }
  if (v.kind === "iv") {
    const src = { feed: "From the broker's feed", solved: "Solved by the Bridge from the price" }[v.source] ?? "Source not stated by the feed";
    const diff = (label, d) => (d === null ? null : h("div", { class: "ci-move" }, h("span", { class: "ci-move-l" }, label), h("span", { class: `ci-move-v ${toneCls(toneOf(Math.round(d * 10)))}` }, arrow(toneOf(Math.round(d * 10))), " ", `${formatSigned(d, 1)} pts`)));
    return h("div", { class: "ci-vis ci-iv" }, h("span", { class: "ci-src" }, src), diff(`Versus ATM${isFigure(v.atmIv) ? ` ${formatFixed(v.atmIv, 1)}%` : ""}`, v.vsAtm), diff(`Versus the ${v.other}`, v.vsOther));
  }
  if (v.kind === "greeks") {
    const r = (x) =>
      h(
        "tr",
        { class: x.id === v.focus ? "ci-hot" : undefined },
        h("th", { scope: "row" }, x.label),
        h("td", { class: toneCls(toneOf(x.unit)) }, isFigure(x.unit) ? formatSigned(x.unit, x.id === "delta" ? 3 : 2) : DASH),
        h("td", { class: toneCls(toneOf(x.lot)) }, isFigure(x.lot) ? formatSignedRupee(x.lot, 0) : DASH),
      );
    return h(
      "div",
      { class: "ci-vis ci-greeks" },
      h("table", {}, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Premium change for"), h("th", { scope: "col" }, "Per unit"), h("th", { scope: "col" }, "Per lot"))), h("tbody", {}, v.rows.map(r))),
      v.gamma && v.focus === "gamma"
        ? h("p", { class: "ci-cap" }, "Delta ", g(v.gamma.now, 3), " → ", h("span", { class: "up" }, g(v.gamma.up, 3)), " after ▲10 pts, → ", h("span", { class: "down" }, g(v.gamma.down, 3)), " after ▼10 pts")
        : null,
    );
  }
  if (v.kind === "gap") {
    const t = toneOf(Math.round(v.gap * 100));
    return h(
      "div",
      { class: "ci-vis ci-gap" },
      h("div", { class: "ci-move" }, h("span", { class: "ci-move-l" }, "Model price"), h("span", { class: "ci-move-v" }, g(v.theor)), h("span", { class: "ci-move-r" }, `LTP ${g(v.ltp)}`)),
      h("div", { class: "ci-move" }, h("span", { class: "ci-move-l" }, "LTP − model"), h("span", { class: `ci-move-v ${toneCls(t) ?? ""}`.trim() }, arrow(t), " ", formatSigned(v.gap, 2))),
      h("p", { class: "ci-cap" }, "Black-76 fed this leg's own IV, so a gap shows timing between the trade and the quote, not value."),
    );
  }
  return null;
}

// ── Reading a chain cell ──
function cellOf(target, host) {
  const el = target instanceof Element ? target.closest("td, th") : null;
  if (!el || !host.contains(el) || el.closest("tfoot")) return null;
  const id = readCell(el.className);
  if (!id) return null;
  if (el.closest("thead")) return { el, head: true, ...id };
  const tr = el.closest("tr[data-strike]");
  if (!tr) return null;
  return { el, head: false, strike: Number(tr.dataset.strike), ...id };
}
function headModel(c, host) {
  const help = cellHelp(c.key);
  const label = host.querySelector(`thead th.c-${c.key}`)?.textContent?.trim() || c.key;
  if (!help) return { title: label, sub: "", help: { shows: "A column added since this help was written.", how: DASH, empty: DASH } };
  return { title: help.name, sub: c.part === "ce" ? "Calls" : c.part === "pe" ? "Puts" : "", help };
}
function cellModel(c, host, getX) {
  const x = getX();
  const row = x?.c?.rows?.find((r) => r.strike === c.strike);
  if (!row) return null;
  const side = c.part === "ce" || c.part === "pe" ? c.part : null;
  const q = side ? row[side] : null;
  if (side && !q) return null;
  const label = cellHelp(c.key) ? null : host.querySelector(`thead th.c-${c.key}`)?.textContent?.trim() ?? null;
  return cardModel(c.key, q, row, side, x, { facts: factsOf(c.key, q, row, side, x), label });
}

/** Figures in the action sheet → the chain column that explains them. */
const SHEET_KEYS = Object.freeze({
  Bid: "bid", Ask: "ask", Mid: "ltp", Spread: "spread", Intrinsic: "intrinsic", "Time value": "ext", Delta: "delta", Gamma: "gamma", "θ / lot": "thetaLot", "Vega / lot": "vega", IV: "iv", "IV − ATM": "ivx",
  Breakeven: "be", "PoP buy": "pop", "PoP sell": "pops", "P(ITM)": "pitm", "Prem / lot": "premLot", OI: "oi", "OI chg": "chg", "OI chg %": "chg", Volume: "vol", "Vol / OI": "volOi", "Build-up": "bu",
});

// ── Keyboard: one listener for the tab, acting on the chain on screen ──
let active = null;
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && open) {
        hide();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      const a = active;
      if (!a || !a.host.isConnected) return;
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
      if ((e.key === "i" || e.key === "I") && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && !document.querySelector("dialog[open]")) {
        if (a.keyNext()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (open?.mode === "key" && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) hide();
    },
    true,
  );
  // A tap or click anywhere closes a card the pointer is not resting on; a figure in the action sheet opens its own.
  document.addEventListener(
    "pointerdown",
    (e) => {
      const m = e.target instanceof Element ? e.target.closest("dialog.chain-sheet .cs-m") : null;
      if (m && active) return;
      if (open && open.mode !== "hover") hide();
    },
    true,
  );
  addEventListener("hashchange", hide);
  addEventListener("resize", () => open && open.mode !== "tap" && hide());
  document.addEventListener("click", (e) => {
    const m = e.target instanceof Element ? e.target.closest("dialog.chain-sheet .cs-m") : null;
    if (!m || !active) return;
    const dlg = m.closest("dialog");
    const key = SHEET_KEYS[m.querySelector("dt")?.textContent?.trim() ?? ""];
    const strike = Number(dlg?.dataset.strike);
    const side = dlg?.dataset.side;
    if (!key || !Number.isFinite(strike) || (side !== "ce" && side !== "pe")) return;
    if (open?.el === m) return hide();
    const a = active;
    show(m, "tap", () => cellModel({ key, part: side, strike }, a.host, a.getX));
  });
}

/**
 * Wire the cards and the column help to the chain's host element.
 * @param {HTMLElement} host desk.js chainEl (the chain table is rebuilt inside it; listeners are delegated)
 * @param {{ x: () => any, cfg?: () => any, keys?: HTMLElement | null }} o x: the chain context (createChain's chain.x);
 *   cfg: the chain's settings (`insight: false` turns the hover cards off); keys: the key legend, which gets the "?" button
 */
export function installChainInsight(host, { x: getX, cfg = () => ({}), keys = null } = {}) {
  bindKeys();
  const enabled = () => (cfg()?.insight ?? cfg()?.hoverCards ?? true) !== false && finePointer();
  let hoverCell = null;
  let timer = 0;
  const showCell = (c, mode) => {
    if (c.head) return show(c.el, "head", () => headModel(c, host));
    show(c.el, mode, () => cellModel(c, host, getX));
  };

  host.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || !enabled()) return;
    const c = cellOf(e.target, host);
    if (!c) return;
    if (c.el === hoverCell) return;
    hoverCell = c.el;
    clearTimeout(timer);
    // The native tooltip would sit on top of the card: hold it back while the pointer rests on this cell.
    if (c.el.title) {
      c.el.dataset.ciTitle = c.el.title;
      c.el.removeAttribute("title");
    }
    // A card already open follows the pointer from cell to cell at once.
    if (open && (open.mode === "hover" || open.mode === "head")) return showCell(c, "hover");
    timer = setTimeout(() => hoverCell === c.el && c.el.isConnected && showCell(c, "hover"), HOVER_MS);
  });
  host.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse" || !hoverCell) return;
    const to = e.relatedTarget;
    if (to instanceof Node && hoverCell.contains(to)) return;
    if (hoverCell.dataset.ciTitle !== undefined) {
      hoverCell.title = hoverCell.dataset.ciTitle;
      delete hoverCell.dataset.ciTitle;
    }
    hoverCell = null;
    clearTimeout(timer);
    if (open && (open.mode === "hover" || open.mode === "head")) timer = setTimeout(() => !hoverCell && hide(), 90);
  });
  host.addEventListener("pointerdown", () => {
    clearTimeout(timer);
    if (open?.mode === "hover" || open?.mode === "head") hide();
  });
  host.addEventListener("scroll", () => open && hide(), { capture: true, passive: true });
  // A column header explains itself: a click (or tap) opens the cell index at that column.
  host.addEventListener("click", (e) => {
    const c = cellOf(e.target, host);
    if (!c?.head || e.target.closest("button")) return;
    hide();
    openChainHelp({ focus: c.key });
  });

  // The "?" in the key legend: the first child, so the legend's overflow never hides it.
  if (keys && !keys.querySelector(".chain-help-btn")) {
    keys.prepend(h("button", { type: "button", class: "small chain-help-btn", title: "How to read the chain: the reading order, every column, a self-check", onclick: () => openChainHelp() }, h("span", { class: "chain-help-q", "aria-hidden": "true" }, "?"), "How to read"));
  }

  // I on the focused row: the card for its first cell from the strike out; again, the next one.
  let kRow = null;
  let kIdx = -1;
  const inst = {
    host,
    getX,
    keyNext() {
      const tr = host.querySelector("tbody tr.focus[data-strike]");
      if (!tr || tr.hidden) return false;
      let cells = [...tr.querySelectorAll("td.fside")];
      if (!cells.length) cells = [...tr.querySelectorAll("td.mid-col")];
      const th = tr.querySelector("th.strike-col");
      if (th) cells.unshift(th);
      if (!cells.length) return false;
      const cx = (el) => {
        const r = el.getBoundingClientRect();
        return (r.left + r.right) / 2;
      };
      const mid = th ? cx(th) : 0;
      cells.sort((a, b) => Math.abs(cx(a) - mid) - Math.abs(cx(b) - mid));
      const sig = `${tr.dataset.strike}|${cells.length}|${cells[1]?.className ?? ""}`;
      kIdx = kRow === sig && open?.mode === "key" ? (kIdx + 1) % cells.length : th && cells.length > 1 ? 1 : 0;
      kRow = sig;
      const el = cells[kIdx];
      const c = cellOf(el, host);
      if (!c) return false;
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      show(el, "key", () => cellModel(c, host, getX), tr);
      return true;
    },
  };
  active = inst;
  return {
    openHelp: (o) => openChainHelp(o),
    hide,
    destroy() {
      if (active === inst) active = null;
      hide();
    },
  };
}

// ── The "How to read the chain" sheet ──
let quizAnswers = {};

/**
 * Open the help sheet: the reading order, the searchable cell index and the self-check.
 * @param {{ tab?: "order"|"index"|"quiz", focus?: string }} o focus: a column key to open the index at
 */
export function openChainHelp({ tab = "order", focus = null } = {}) {
  hide();
  const start = focus ? "index" : tab;
  const tabs = segmented("Help section", [["order", "Reading order"], ["index", "Cell index"], ["quiz", "Self-check"]], start);
  tabs.classList.add("ch-tabs");
  const panes = { order: orderPane((key) => go("index", key)), index: indexPane(), quiz: quizPane() };
  const body = h("div", { class: "chain-help" }, tabs, panes.order.el, panes.index.el, panes.quiz.el, h("p", { class: "ch-about" }, "The chain prints what has traded, been quoted or is held, and arithmetic on those figures. It describes; it does not predict, and nothing here is advice."));
  function go(id, key = null) {
    if (tabs.value !== id) tabs.value = id;
    for (const [k, p] of Object.entries(panes)) p.el.hidden = k !== id;
    if (id === "index" && key) panes.index.reveal(key);
  }
  tabs.addEventListener("change", () => go(tabs.value));
  go(start, focus);
  return modal({ title: "How to read the chain", body, buttons: [{ label: "Close", value: true }] });
}

function orderPane(onKey) {
  const el = h(
    "section",
    { class: "ch-pane", "aria-label": "Reading order" },
    h("p", { class: "ch-lead" }, "A chain has many columns. Read them in this order and each one answers only its own question."),
    h(
      "ol",
      { class: "ch-steps" },
      READING_ORDER.map((s, i) =>
        h(
          "li",
          { class: "ch-step" },
          h("span", { class: "ch-step-n", "aria-hidden": "true" }, String(i + 1)),
          h(
            "div",
            { class: "ch-step-b" },
            h("h3", {}, s.step, h("span", { class: "ch-q" }, s.question)),
            h("p", {}, s.text),
            h("div", { class: "ch-chips" }, s.keys.map((k) => h("button", { type: "button", class: "small", title: `What ${cellHelp(k)?.name ?? k} shows`, onclick: () => onKey(k) }, cellHelp(k)?.label ?? k))),
          ),
        ),
      ),
    ),
  );
  return { el };
}

function indexPane() {
  const search = h("input", { type: "search", class: "ch-search", placeholder: "Search columns: IV, build-up, spread…", "aria-label": "Search the cell index", autocomplete: "off", spellcheck: "false" });
  const count = h("p", { class: "ch-count", role: "status" });
  const list = h("div", { class: "ch-list" });
  const entries = new Map(
    CELL_INDEX.map((e) => [
      e.key,
      h(
        "article",
        { class: "ch-entry", id: `ch-e-${e.key}`, tabindex: "-1" },
        h("h4", {}, e.name, e.label !== e.name ? h("span", { class: "ch-label" }, e.label) : null),
        h("p", {}, e.shows),
        h("dl", {}, h("div", {}, h("dt", {}, "Worked out"), h("dd", {}, e.how)), h("div", {}, h("dt", {}, "When empty"), h("dd", {}, e.empty))),
      ),
    ]),
  );
  const draw = () => {
    const hits = searchCells(search.value);
    const q = search.value.trim();
    if (q) {
      // A search lists the matches best first, without the family headings.
      list.replaceChildren(...hits.map((e) => entries.get(e.key)));
    } else {
      list.replaceChildren(...FAMILIES.flatMap(([id, name]) => {
        const items = CELL_INDEX.filter((e) => e.family === id);
        return items.length ? [h("h3", { class: "ch-fam" }, name), ...items.map((e) => entries.get(e.key))] : [];
      }));
    }
    count.textContent = q ? (hits.length ? `${hits.length} column${hits.length === 1 ? "" : "s"} match` : "No column matches. Try a shorter word.") : `${CELL_INDEX.length} columns`;
  };
  search.addEventListener("input", draw);
  draw();
  const el = h("section", { class: "ch-pane", "aria-label": "Cell index" }, search, count, list);
  return {
    el,
    reveal(key) {
      if (search.value) {
        search.value = "";
        draw();
      }
      const e = entries.get(key);
      if (!e) return;
      requestAnimationFrame(() => {
        e.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
        e.classList.remove("hl");
        void e.offsetWidth;
        e.classList.add("hl");
        e.focus({ preventScroll: true });
      });
    },
  };
}

function quizPane() {
  const summary = h("p", { class: "ch-score", role: "status" });
  const items = QUIZ.map((item, qi) => {
    const why = h("p", { class: "ch-why", hidden: true });
    const name = `ch-quiz-${item.id}`;
    const opts = item.options.map((text, oi) =>
      h("label", { class: "ch-opt" }, h("input", { type: "radio", name, value: String(oi), onchange: () => answer(item, oi, why, fs) }), h("span", {}, text)),
    );
    const fs = h("fieldset", { class: "ch-qn" }, h("legend", {}, h("span", { class: "ch-qn-n" }, `${qi + 1}`), item.q), opts, why);
    return { item, fs, why };
  });
  const again = h("button", { type: "button", class: "small", onclick: () => reset() }, "Start again");
  function answer(item, oi, why, fs) {
    quizAnswers = { ...quizAnswers, [item.id]: oi };
    const ok = oi === item.answer;
    why.hidden = false;
    why.className = `ch-why ${ok ? "up" : "down"}`;
    why.replaceChildren(h("strong", {}, ok ? "✓ Right. " : `✗ Not quite: the answer is ${item.options[item.answer]}. `), item.why);
    for (const l of fs.querySelectorAll(".ch-opt")) {
      const i = Number(l.firstChild.value);
      l.classList.toggle("right", i === item.answer);
      l.classList.toggle("wrong", i === oi && !ok);
    }
    drawScore();
  }
  function drawScore() {
    summary.textContent = quizSummary(scoreQuiz(quizAnswers));
  }
  function reset() {
    quizAnswers = {};
    for (const { fs, why } of items) {
      why.hidden = true;
      for (const l of fs.querySelectorAll(".ch-opt")) {
        l.classList.remove("right", "wrong");
        l.firstChild.checked = false;
      }
    }
    drawScore();
  }
  // Answers given earlier in this tab come back when the sheet opens again.
  for (const { item, fs, why } of items) {
    const a = quizAnswers[item.id];
    if (Number.isInteger(a)) {
      const input = fs.querySelectorAll("input")[a];
      if (input) {
        input.checked = true;
        answer(item, a, why, fs);
      }
    }
  }
  drawScore();
  const el = h("section", { class: "ch-pane", "aria-label": "Self-check" }, h("p", { class: "ch-lead" }, "Five questions on how the cells are worked out. Each answer shows the rule behind it."), summary, h("div", { class: "ch-quiz" }, items.map((i) => i.fs)), h("div", { class: "ch-again" }, again));
  return { el };
}
