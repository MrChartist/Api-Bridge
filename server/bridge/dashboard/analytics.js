// PR 17's analytics pages inside this dashboard's shell (docs/design/pr17-integration.md).
//
// The pages' own code stays in PR 17's three analytics page modules (their maths is tested there).
// This module hosts them the way every desk page is hosted:
//  - the context (underlying, expiry, strikes, data freshness) is a capsule in the top bar (#toolbar-ctx), like the
//    Option Chain's, instead of PR 17's separate context bar. It writes the shared workspace context; a data page is
//    drawn again, a form page keeps its draft and just follows (chainControls does that);
//  - each inner tab of a PR 17 page is a page tab of ours (`H.tab`), so there is one tab strip;
//  - the page fills the content area as a grid of panels (app.css "15 · ANALYTICS"): KPI tiles become one figures
//    strip, cards become desk panels, a panel's own view switch moves into its head, wide tables span the row.
// Reads go through api() (shared answers, one request per URL at a time); nothing here polls.
import { DEMO_EXPLAINER, alertBox, api, app, emptyState, h, icon, istDateTime, istTime, mountToolbarCtx, pill, sheetPopover, table } from "./app.js";
import { openPalette } from "./palette.js";
import { DASH } from "./format.js";
import { analyticsPages } from "./analyticsViews.js";
import { analyticsMorePages } from "./analyticsMore.js";
import { analyticsFlowPages, filingsTabs, tabbedPage } from "./analyticsFlow.js";
import { UNDERLYING_CHIPS, isFormPage, nowShowing, workspace } from "./workspace.js";
import { errorBox, field, segField, segmented } from "./views.js";

const STRIKES = [5, 10, 15, 20, 30];

/** Which PR 17 page draws a view, and which of its inner tabs: view id -> [source page id, tab or null, context]. */
export const VIEWS = Object.freeze({
  // Analytics › Exposure
  "an-gex": ["exposure", "strike", { expiry: true, strikes: true }],
  "an-gex-expiry": ["exposure", "expiry", { expiry: false, strikes: true }],
  "an-oi-heatmap": ["exposure", "oi", { expiry: false, strikes: true }],
  greeksgrid: ["greeksgrid", "grid", { expiry: true, strikes: true }],
  "an-straddle": ["greeksgrid", "straddle", { expiry: true, strikes: false }],
  // Analytics › Flow
  unusual: ["unusual", null, { underlying: false, expiry: false, strikes: false }],
  tide: ["tide", null, { expiry: true, strikes: false }],
  flows: ["flows", null, { underlying: false, expiry: false, strikes: false }],
  "an-filings": ["filings", null, { underlying: false, expiry: false, strikes: false }],
  // Analytics › Futures
  futures: ["futures", "chain", { expiry: false, strikes: false }],
  "an-basis": ["futures", "basis", { expiry: false, strikes: false }],
  "an-synthetic": ["futures", "synthetic", { expiry: true, strikes: true }],
  // Analytics › Strategy lab
  strategies: ["strategies", "find", { expiry: true, strikes: false }],
  "an-templates": ["strategies", "build", { expiry: true, strikes: false }],
  calculators: ["calculators", null, { underlying: false, expiry: false, strikes: false }],
  // Markets › Volatility, Markets › OI Analysis
  skew: ["skew", "skew", { expiry: true, strikes: true }],
  "an-surface": ["skew", "surface", { expiry: false, strikes: true }],
  "an-volstats": ["screener", "vol", { expiry: false, strikes: false }],
  oichange: ["oichange", "change", { expiry: true, strikes: true }],
  "an-spurts": ["oichange", "spurts", { expiry: true, strikes: true }],
  expiry: ["expiry", "digest", { expiry: true, strikes: false }],
});

/**
 * A public page (NSE, SEBI, RBI) that did not answer as expected is not a broker refusal: say what it is, that the
 * addresses are unverified, and that Refresh tries again. Everything else goes to the shell's error box.
 */
export function analyticsError(err, labels) {
  if (err?.code === "UPSTREAM_ERROR") {
    return alertBox({ title: "The public data source did not answer as expected", detail: `${err.message ?? "No answer."} NSE, SEBI and RBI addresses are unverified and change without notice. Refresh tries again; nothing else on the page is affected.` }, "warn");
  }
  return errorBox(err, labels);
}

/** The helpers PR 17's pages take (views.js owns them), plus the tab to draw. */
const helpers = (tab) => ({ segmented, segField, field, errorBox: analyticsError, tab });

/** NSE announcements and SEBI / RBI notices (GET /v1/analytics/news/*): a table each, unverified sources labelled. */
function newsTab(kind) {
  return async (H) => {
    const path = kind === "announcements" ? "/v1/analytics/news/announcements?days=7" : "/v1/analytics/news/regulatory?source=all&days=30";
    let res;
    try {
      res = await api(path);
    } catch (err) {
      return H.errorBox(err);
    }
    const items = res.data?.data?.items ?? [];
    const meta = res.data?.meta ?? {};
    const label = meta.source === "demo" || app.state.demo ? "Demo rows" : "Public source, unverified address";
    const cols =
      kind === "announcements"
        ? [
            { label: "Time", cell: (r) => istDateTime(r.publishedAt) },
            { label: "Symbol", cell: (r) => h("strong", {}, r.symbol) },
            { label: "Subject", cell: (r) => r.subject },
            { label: "Detail", cell: (r) => h("span", { class: "an-wrap" }, r.detail ?? "") },
          ]
        : [
            { label: "Time", cell: (r) => istDateTime(r.publishedAt) },
            { label: "Source", cell: (r) => (r.source === "sebi" ? "SEBI" : "RBI") },
            { label: "Title", cell: (r) => h("span", { class: "an-wrap" }, r.title) },
            { label: "Tags", cell: (r) => h("span", { class: "flags" }, (r.tags ?? []).map((t) => pill(t, "sm"))) },
          ];
    const title = kind === "announcements" ? "NSE corporate announcements" : "SEBI and RBI notices";
    const sub = kind === "announcements" ? "The last 7 days, newest first." : "Circulars, press releases, notifications and speeches from the last 30 days.";
    return h(
      "section",
      { class: "card an-wide" },
      h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, title), h("p", {}, sub)), h("div", { class: "card-actions" }, pill(label, "info"))),
      h("div", { class: "card-body flush" }, items.length ? table(cols, items) : emptyState("list", "Nothing published in this window", "Try again later; the source is read when this tab opens.")),
    );
  };
}

function sources(tab) {
  const H = () => helpers(tab);
  const all = [...analyticsPages(H), ...analyticsMorePages(H), ...analyticsFlowPages(H)];
  const filings = [...filingsTabs(), { id: "announcements", label: "Announcements", build: newsTab("announcements") }, { id: "regulatory", label: "SEBI and RBI", build: newsTab("regulatory") }];
  all.push({ id: "filings", render: () => tabbedPage(H(), { label: "Filings", tabs: filings }) });
  return all;
}

// ── The top-bar capsule ──

/**
 * Underlying, expiry and strikes as one glass capsule in the top bar, and the freshness of what the page shows.
 * `onChange(changedFields)` runs after a pick.
 */
export function contextCapsule({ underlying = true, expiry = true, strikes = true } = {}, onChange) {
  const st = workspace.state;
  const list = UNDERLYING_CHIPS.includes(st.underlying) ? UNDERLYING_CHIPS : [...UNDERLYING_CHIPS, st.underlying];
  const uSel = h("select", { "aria-label": "Underlying", class: "desk-u" }, list.map((u) => h("option", { value: u, selected: u === st.underlying }, u)));
  const uMain = document.createTextNode(st.underlying);
  const eSel = h("select", { "aria-label": "Expiry" }, h("option", { value: st.expiry }, st.expiry || "Loading"));
  const eMain = document.createTextNode(st.expiry ? shortDay(st.expiry) : "Expiry");
  const kSel = h("select", { "aria-label": "Strikes each side of ATM" }, STRIKES.map((n) => h("option", { value: String(n), selected: n === st.strikes }, `±${n} strikes`)));
  const kMain = document.createTextNode(`±${st.strikes}`);
  const item = (cls, title, main, sel) => h("label", { class: `ctx-item ctx-pick ${cls}`, title }, h("span", { class: "ctx-main" }, main), sel);
  const cap = h(
    "div",
    { class: "ctx-cap glass an-cap" },
    underlying ? item("ctx-u", "Underlying", uMain, uSel) : h("span", { class: "ctx-item ctx-u an-all" }, h("span", { class: "ctx-main" }, "All markets")),
    expiry ? item("ctx-e", "Expiry", eMain, eSel) : null,
    strikes ? item("ctx-k", "Strikes each side of ATM", kMain, kSel) : null,
  );
  // Under 1024 px, as on the Option Chain: a ⋯ button holds what the bar has no room for (every pick, the demo note,
  // search). Under 720 px the strikes pick lives only there, so the capsule never clips.
  const mirror = (label, src) => {
    const sel = h("select", { "aria-label": label }, [...src.options].map((o) => h("option", { value: o.value, selected: o.value === src.value }, o.textContent)));
    sel.addEventListener("change", () => {
      src.value = sel.value;
      src.dispatchEvent(new Event("change"));
    });
    return h("label", { class: "field" }, h("span", {}, label), sel);
  };
  const more = h("button", { type: "button", class: "icon-btn ctx-more", "aria-haspopup": "dialog", "aria-label": `More: underlying, expiry, strikes, search${app.state.demo ? ", demo data" : ""}` }, icon("more"), app.state.demo ? h("span", { class: "demo-badge", "aria-hidden": "true" }) : null);
  more.addEventListener("click", () => {
    const search = h("button", { type: "button", class: "small" }, icon("search"), "Search pages and actions");
    search.addEventListener("click", () => {
      document.querySelector(".an-ctx-sheet")?.closest("dialog")?.close?.();
      openPalette();
    });
    sheetPopover({
      trigger: more,
      title: "This page",
      cls: "an-ctx-sheet",
      body: h(
        "div",
        { class: "stack" },
        underlying ? mirror("Underlying", uSel) : null,
        expiry ? mirror("Expiry", eSel) : null,
        strikes ? mirror("Strikes each side of ATM", kSel) : null,
        h("p", { class: "muted small" }, freshText.data),
        app.state.demo ? h("p", { class: "muted small" }, DEMO_EXPLAINER) : null,
        search,
      ),
    });
  });
  const freshText = document.createTextNode("Waiting");
  const fresh = h("span", { class: "ctx-item an-fresh", "data-tone": "wait", role: "status", title: "Where the figures on this page come from" }, h("span", { class: "live-dot", "aria-hidden": "true" }), h("span", { class: "ctx-main" }, freshText));
  const freshCap = h("div", { class: "ctx-cap glass an-fresh-cap" }, fresh);
  async function loadExpiries() {
    if (!expiry) return;
    try {
      const r = await api(`/v1/expiries?underlying=${encodeURIComponent(workspace.state.underlying)}`);
      const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
      const all = (r.data?.data?.expiries ?? []).filter((e) => e >= today);
      eSel.replaceChildren(...(all.length ? all.map((e) => h("option", { value: e }, e)) : [h("option", { value: "" }, "No expiries")]));
      const pick = all.includes(workspace.state.expiry) ? workspace.state.expiry : (all[0] ?? "");
      eSel.value = pick;
      eMain.data = pick ? shortDay(pick) : "No expiry";
      if (pick !== workspace.state.expiry) workspace.set({ expiry: pick });
    } catch {
      eMain.data = "Expiry";
    }
  }
  uSel.addEventListener("change", async () => {
    workspace.set({ underlying: uSel.value });
    uMain.data = uSel.value;
    await loadExpiries();
    onChange?.(["underlying"]);
  });
  eSel.addEventListener("change", () => {
    workspace.set({ expiry: eSel.value });
    eMain.data = shortDay(eSel.value);
    onChange?.(["expiry"]);
  });
  kSel.addEventListener("change", () => {
    workspace.set({ strikes: Number(kSel.value) });
    kMain.data = `±${kSel.value}`;
    onChange?.(["strikes"]);
  });
  return {
    nodes: [cap, h("span", { class: "ctx-spacer" }), freshCap, more],
    loadExpiries,
    /** Show what a page's freshness row says ("Live stream · just now", "as of 10:31:02"). */
    setFresh(text, tone) {
      freshText.data = text;
      fresh.dataset.tone = tone ?? "info";
    },
  };
}

/** "2026-11-03" -> "3 Nov". */
export function shortDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return DASH;
  return `${Number(m[3])} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1]}`;
}

// ── Fitting PR 17's DOM into the desk ──

/** The tone of a freshness pill (PR 17's pill classes). */
const toneOf = (pill) => (pill?.classList.contains("ok") ? "ok" : pill?.classList.contains("warn") ? "warn" : pill?.classList.contains("bad") ? "bad" : "info");

/**
 * Restyle one drawn result in place: freshness to the top bar, controls the capsule owns out of sight, a panel's own
 * view switch into its head, wide tables across the row. Runs again whenever the page redraws a part of itself.
 */
export function fitDesk(root, cap) {
  for (const row of root.querySelectorAll(".analytics-status:not([data-fit])")) {
    row.dataset.fit = "1";
    const pill = row.querySelector(".pill");
    const asOf = [...row.querySelectorAll(".muted")].map((x) => x.textContent).find((t) => /as of/.test(t));
    // Public-data pages (NSE files) carry no market freshness: say when they were read instead of "unknown".
    if (pill && /unknown/i.test(pill.textContent)) cap?.setFresh(`${app.state.demo ? "Demo rows" : "Public data"} · read ${istTime(new Date().toISOString())}`, "info");
    else if (pill) cap?.setFresh([pill.textContent, asOf?.replace(/^as of /, "")].filter(Boolean).join(" · "), toneOf(pill));
  }
  // Controls whose every field the capsule owns: hide their whole card.
  for (const c of root.querySelectorAll(".analytics-controls:not([data-fit])")) {
    c.dataset.fit = "1";
    const own = [...c.children].filter((x) => !x.matches(".ctx-owned, .ctx-summary, .ctx-refresh, datalist") && !x.hidden);
    const card = c.closest(".card");
    const rest = card ? [...card.querySelectorAll(".card-body > *, .card-body > .stack > *")].filter((x) => x !== c && !c.contains(x) && !x.hidden && !x.matches(".stack")) : [];
    if (!own.length && card && !rest.length) card.classList.add("an-gone");
    else if (!own.length) c.classList.add("an-gone");
  }
  // A plain wrapper around a figures strip (a page that redraws its tiles) spans the row like the strip.
  for (const s of root.querySelectorAll(".grid.stats")) {
    const p = s.parentElement;
    if (p && p !== root && !p.classList.contains("stack") && !p.closest(".card")) p.classList.add("an-wide");
  }
  for (const card of root.querySelectorAll(".card:not(.stat):not([data-fit])")) {
    card.dataset.fit = "1";
    card.classList.add("an-panel");
    const head = card.querySelector(":scope > .card-head");
    const body = card.querySelector(":scope > .card-body");
    // One head height on every panel: a long description moves behind a "?" beside the title (as the Market calendar's
    // panels do); a short one stays inline.
    const sub = head?.querySelector(".card-titles > p");
    if (sub && sub.textContent.length > 44) {
      const title = head.querySelector(".card-titles h2")?.textContent ?? "About this panel";
      const text = sub.textContent;
      const help = h("button", { type: "button", class: "icon-btn tiny an-help", "aria-label": `About ${title}`, title: text }, h("span", { "aria-hidden": "true" }, "?"));
      help.addEventListener("click", () => sheetPopover({ trigger: help, title, body: h("p", { class: "an-help-text" }, text) }));
      sub.replaceWith(help);
    }
    // A view switch (segmented control) at the top of the body sits in the head on the right, as on every desk panel.
    const sf = body?.querySelector(":scope > .stack > .seg-field, :scope > .seg-field");
    if (head && sf && (sf === body.firstElementChild || sf === body.firstElementChild?.firstElementChild)) {
      const seg = sf.querySelector(".segmented");
      const label = sf.querySelector(":scope > span")?.textContent ?? "";
      if (seg) {
        seg.setAttribute("aria-label", label);
        seg.removeAttribute("aria-labelledby");
        seg.classList.add("an-head-seg");
        head.append(h("div", { class: "an-head-tools" }, seg));
        sf.remove();
      }
    }
    // A head-less card that only holds a few form fields is a compact filter bar across the row.
    if (!head && body) {
      const shown = [...body.children].filter((x) => !x.hidden && !x.classList.contains("an-gone") && x.tagName !== "DATALIST");
      const fields = shown.flatMap((x) => [...x.querySelectorAll(":scope > .field:not(.ctx-owned):not(.ctx-refresh)")]).filter((f) => !f.hidden);
      if (shown.length && shown.every((x) => x.classList.contains("form-grid")) && fields.length <= 7) card.classList.add("an-formbar");
    }
    const t = card.querySelector("table");
    if (t && t.querySelectorAll("thead th").length > 6) card.classList.add("an-wide");
    if (card.querySelector(".heatmap, .scroll-box")) card.classList.add("an-wide");
  }
}

/**
 * How many columns of the row the last panel spans so a row is never left part empty (pure): `n` panels in `cols`
 * columns; 1 when the last row is full.
 */
export function lastSpan(n, cols) {
  if (!(n > 0) || !(cols > 1)) return 1;
  const r = n % cols;
  return r === 0 ? 1 : cols - r + 1;
}

/** The grid's items: children of the page and of its flattened stacks that draw a box. */
function gridItems(root) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      const d = getComputedStyle(c).display;
      if (d === "contents") walk(c);
      else if (d !== "none") out.push(c);
    }
  };
  walk(root);
  return out;
}

/** Let the last panel of the panels between two full-width rows take what is left of its row (no empty band). */
/** Rows of the masonry grid, in px (app.css .an-page.an-masonry grid-auto-rows). */
export const MASONRY_ROW = 4;
/** How many masonry rows a panel `h` px tall takes with `gap` px between rows (pure). */
export const masonrySpan = (h, gap, row = MASONRY_ROW) => Math.max(1, Math.ceil((h + gap) / (row + gap)));

/**
 * Lay the panels out as a masonry: each panel takes as many 4 px rows as its height, and the grid fills holes
 * (grid-auto-flow: dense), so a short panel beside a tall one is followed by the next panel instead of a band of
 * nothing. Panels between two full-width rows that are fewer than the columns widen to fill the row.
 */
function balanceRows(root, watch) {
  const cs = getComputedStyle(root);
  const cols = cs.gridTemplateColumns.split(" ").filter(Boolean).length;
  const gap = parseFloat(cs.rowGap) || 0;
  const items = gridItems(root);
  for (const el of items) {
    el.style.removeProperty("grid-column");
    el.style.removeProperty("grid-row-end");
  }
  let run = [];
  const flush = () => {
    if (run.length && run.length < cols) {
      const span = lastSpan(run.length, cols);
      if (span > 1) run.at(-1).style.setProperty("grid-column", `span ${span}`);
    }
    run = [];
  };
  for (const el of items) {
    if (getComputedStyle(el).gridColumnEnd === "-1") flush();
    else run.push(el);
  }
  flush();
  // Heights after the widths are settled (a widened panel may redraw shorter or taller).
  for (const el of items) {
    el.style.setProperty("grid-row-end", `span ${masonrySpan(el.getBoundingClientRect().height, gap)}`);
    watch?.(el);
  }
  root.classList.toggle("an-masonry", cols > 1);
}

/**
 * Draw one analytics view: the capsule in the top bar, then the PR 17 page (or one of its tabs), fitted to the desk.
 * @param {string} view  a key of VIEWS (it is also the view's data-page id)
 */
export async function renderAnalyticsView(view) {
  const spec = VIEWS[view];
  if (!spec) throw new Error(`No analytics view ${view}`);
  const [source, tab, ctxOpts] = spec;
  const page = sources(tab).find((p) => p.id === source);
  nowShowing.id = source;
  const wrap = h("div", { class: "an-page", "data-an": view });
  const cap = contextCapsule(ctxOpts, () => {
    // A data page is drawn again with the new context; a form page keeps its draft (its controls follow the context).
    if (!isFormPage(source)) window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  mountToolbarCtx(view, ...cap.nodes);
  if (ctxOpts.expiry !== false) await cap.loadExpiries();
  if (ctxOpts.underlying === false && ctxOpts.expiry === false) cap.setFresh(`Updated ${istTime(new Date().toISOString())}`, "info");
  const nodes = await page.render();
  wrap.append(...[nodes].flat().filter(Boolean));
  fitDesk(wrap, cap);
  // Parts of a page redraw themselves (a filter, a tab inside a panel): fit what they add, at most once a frame.
  let queued = false;
  const again = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!wrap.isConnected) return;
      fitDesk(wrap, cap);
      balanceRows(wrap, watch);
    });
  };
  const mo = new MutationObserver((list) => {
    if (!wrap.isConnected) return mo.disconnect();
    // Only structure changes outside the panels' insides matter for the grid (a chart redraw does not).
    if (list.some((m) => m.target === wrap || m.target.classList?.contains("stack") || m.target.classList?.contains("an-panel"))) again();
  });
  mo.observe(wrap, { childList: true, subtree: true });
  let watch = null;
  if (typeof ResizeObserver !== "undefined") {
    let lastW = 0;
    const ro = new ResizeObserver(([e]) => {
      if (!wrap.isConnected) return ro.disconnect();
      const w = Math.round(e.contentRect.width);
      if (w !== lastW) ((lastW = w), again());
    });
    ro.observe(wrap);
    // A panel whose height changes (a chart redrawn at its width, rows loaded) takes its new number of rows.
    const heights = new WeakMap();
    const panels = new ResizeObserver((entries) => {
      if (!wrap.isConnected) return panels.disconnect();
      if (entries.some((e) => Math.abs((heights.get(e.target) ?? -1) - e.contentRect.height) > 2)) {
        for (const e of entries) heights.set(e.target, e.contentRect.height);
        again();
      }
    });
    const seen = new WeakSet();
    watch = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      panels.observe(el);
    };
  }
  return wrap;
}
