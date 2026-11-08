// Sources > Overview: how much room the Bridge has across your accounts and sources, who is using it, what happens
// next, and why a request went where it did. The page is built once and then patched in place every 2 seconds
// (sources-ui.js: createKeyedList, createMeter, countingNumber), so meters animate and nothing flickers or loses focus.
// All numbers and words come from sources-core.js (pure, tested).

import { alertBox, api, app, emptyState, h, icon, iconTile, istTime, modal, optional, pill } from "./app.js";
import {
  CAPABILITY_ASK,
  PURPOSES,
  PURPOSE_NOTE,
  SORTS,
  CLASS_NAME,
  TONE_WORD,
  agoText,
  annotateRows,
  attentionRows,
  attentionText,
  buildRows,
  withSwitches,
  capabilityForPath,
  classAdvice,
  classLabel,
  createRateTracker,
  createSmoother,
  createToneTracker,
  forecastSentence,
  heroText,
  meterSpeech,
  officialLabel,
  parseSymbols,
  percent,
  pooledRoom,
  requestVerdict,
  shortWait,
  sortRows,
  toneRank,
  traceModel,
  traceQuery,
  capabilityText,
} from "./sources-core.js";
import { DASH, formatFixed, formatInt, plural } from "./format.js";
import { brokerTile, chevron, classPill, countingNumber, createKeyedList, createMeter, createPoller, healthTag, labelsHelp, officialBadge, overviewSkeleton, prefersReducedMotion, setData, setText, setToneGlyph, sourceTile, toneGlyph, updateClassPill } from "./sources-ui.js";

/** The page's one dependency on views.js, handed over when views.js loads (it owns the segmented control). */
let segmented = null;
export function configureSources(deps) {
  segmented = deps.segmented ?? segmented;
}

const SORT_SLOT = "mcb.sources.sort";
const REQUEST_ROWS = 12;
const STALE_MS = 6000;
const LOST_MS = 30_000;
const BROKER_POLICY_EVERY = 5;

const go = (hash) => {
  location.hash = hash;
};
const isMissing = (err) => err && (err.status === 404 || err.status === 405 || err.status === 501);

// ── Sheets: the route trace ──

/**
 * The route trace sheet: ask the router which source would answer a call and why, nothing is sent to any source.
 * @param {{ capability?: string, symbols?: string[], purpose?: string, nameOf?: (id: string) => string }} [opts]
 */
export function openTraceSheet({ capability = "quotes", symbols = ["NSE:RELIANCE"], purpose = "display", nameOf = (id) => id } = {}) {
  const sel = (id, items, value, label) => {
    const s = h("select", { id, "aria-label": label }, items.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
    s.value = value;
    return s;
  };
  const cap = sel("rt-cap", CAPABILITY_ASK, capability, "What is being asked");
  const why = sel("rt-purpose", PURPOSES, purpose, "What the data is for");
  const syms = h("input", { id: "rt-symbols", type: "text", value: symbols.join(", "), autocomplete: "off", spellcheck: "false", placeholder: "NSE:RELIANCE", "aria-describedby": "rt-symbols-hint" });
  const note = h("span", { class: "hint", id: "rt-purpose-note" }, PURPOSE_NOTE[purpose]);
  why.setAttribute("aria-describedby", "rt-purpose-note");
  why.addEventListener("change", () => setText(note, PURPOSE_NOTE[why.value] ?? ""));
  const out = h("div", { class: "rt-result", "aria-live": "polite", "aria-busy": "false" });
  const check = h("button", { type: "button", class: "primary small rt-go" }, icon("route"), "Check the route");
  let seq = 0;

  const run = async () => {
    const mine = ++seq;
    check.disabled = true;
    check.setAttribute("aria-busy", "true");
    out.setAttribute("aria-busy", "true");
    out.replaceChildren(h("p", { class: "rt-wait" }, "Asking the router…"));
    try {
      const q = traceQuery({ capability: cap.value, symbols: parseSymbols(syms.value), purpose: why.value });
      const r = await api(`/v1/sources/trace?${q}`, { fresh: true });
      if (mine !== seq) return;
      out.replaceChildren(traceBody(traceModel(r.data?.data ?? r.data, nameOf)));
    } catch (err) {
      if (mine !== seq) return;
      out.replaceChildren(isMissing(err) ? alertBox({ title: "This Bridge cannot explain routes yet", detail: "Route traces need a newer Bridge. Everything else on this page still works." }, "info") : alertBox(err));
    } finally {
      if (mine === seq) {
        check.disabled = false;
        check.removeAttribute("aria-busy");
        out.setAttribute("aria-busy", "false");
      }
    }
  };
  check.addEventListener("click", run);
  syms.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });
  const sheet = modal({
    title: "Why this source?",
    body: h(
      "div",
      { class: "rt-sheet" },
      h("p", { class: "rt-intro" }, "Pick a kind of call and the Bridge shows which source would answer it, which ones are next in line, and why the others are left out. This is a dry run: nothing is sent to any source."),
      h("div", { class: "rt-form" }, h("label", { class: "field" }, h("span", {}, "What is asked"), cap), h("label", { class: "field" }, h("span", {}, "Symbols"), syms, h("span", { class: "hint", id: "rt-symbols-hint" }, "Separate several with commas.")), h("label", { class: "field" }, h("span", {}, "What the data is for"), why, note), check),
      out,
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
  run();
  return sheet;
}

/** The result of a trace: a sentence, the data class, and the sources in decision order. */
function traceBody(m) {
  const tone = { check: "green", arrow: "blue", skip: "gray" };
  return h(
    "div",
    { class: "rt-body" },
    h("div", { class: "rt-verdict", "data-has": m.chosen ? "1" : "0" }, h("p", { class: "rt-headline" }, m.headline), m.chosen ? classPill(m.cls, m.chosen.delaySec ?? (m.cls === "delayed" ? 900 : 0)) : null),
    m.detail ? h("p", { class: "rt-detail" }, m.detail) : null,
    m.chosen && m.cls !== "realtime" ? h("p", { class: "rt-detail" }, classAdvice(m.cls, m.chosen.delaySec ?? 900)) : null,
    m.steps.length
      ? h(
          "ol",
          { class: "rt-steps list", "aria-label": "Sources in the order the router weighed them" },
          m.steps.map((s, i) =>
            h(
              "li",
              { class: "list-row static rt-step", "data-verdict": s.verdict },
              iconTile(s.glyph, tone[s.glyph] ?? "gray", "sm"),
              h(
                "span",
                { class: "names" },
                h("span", { class: "nm" }, h("span", { class: "sr-only" }, `Step ${i + 1}. `), s.name, " ", h("span", { class: `chip rt-word ${s.verdict}` }, s.word), s.health ? h("span", { class: "pill warn tiny" }, s.health) : null),
                h("span", { class: "sub rt-reason" }, s.reason || "No reason was given."),
                s.spare ? h("span", { class: "sub" }, s.spare) : null,
              ),
            ),
          ),
        )
      : h("p", { class: "rt-detail" }, "The router did not list any source. Turn one on in Providers, or connect a broker account."),
  );
}

// ── Sheets: a source in detail, and how the pooled number is worked out ──

const budgetLine = (b) => `${b.clsName ? `${b.clsName}: ` : ""}${formatInt(b.used)} of ${formatInt(b.limit)} ${b.per}`;

/** Everything the Bridge knows about one row, in words, with the two next steps. */
function openSourceSheet(row, ctx) {
  const facts = [];
  const add = (k, v) => facts.push(h("dt", {}, k), h("dd", {}, v));
  add("Data", h("span", {}, classPill(row.cls, row.delaySec), " ", officialBadge(row.official)));
  add("What that means", classAdvice(row.cls, row.delaySec));
  add("Health", `${row.health.word}. ${row.health.detail}`);
  if (row.kind === "account") {
    for (const c of row.classes.filter((x) => x.binding)) add(c.name, `${formatInt(c.binding.used)} of ${formatInt(c.binding.limit)} ${c.binding.per}`);
  } else {
    const s = row.source;
    if (row.minute) add("This minute", `${formatInt(row.minute.used)} of ${plural(row.minute.limit, "call")}`);
    if (row.day) add("Today", `${formatInt(row.day.used)} of ${plural(row.day.limit, "call")}`);
    if (s?.capabilities) add("Gives", capabilityText(s.capabilities).replace(/^./, (c) => c.toUpperCase()));
  }
  add("Calls today", formatInt(row.counter));
  if (row.terms?.note) add("What you agreed to", row.terms.note);
  const link = row.terms?.url ? h("a", { href: row.terms.url, target: "_blank", rel: "noopener noreferrer", class: "sx-ext" }, "Read the vendor's terms", icon("external")) : null;
  return modal({
    title: row.name,
    body: h("div", { class: "sx-sheet" }, h("dl", { class: "kv sx-kv" }, facts), link),
    buttons: [
      { label: "Why this source?", cls: "tinted", value: "trace" },
      { label: row.kind === "account" ? "Open Accounts" : "Open Providers", value: "go" },
      { label: "Done", cls: "primary", value: "done" },
    ],
  }).then((v) => {
    if (v === "trace") openTraceSheet({ nameOf: ctx.nameOf });
    else if (v === "go") go(row.kind === "account" ? "#/accounts" : "#/sources/providers");
  });
}

/** How the pooled room is added up, and what is left out. */
function openPoolSheet(pool, rows) {
  const unit = pool.window === "day" ? "calls a day" : "calls a minute";
  return modal({
    title: "How the room is worked out",
    body: h(
      "div",
      { class: "sx-sheet" },
      h("p", {}, "Room adds up across the accounts and sources that can answer. Each one counts in calls a minute: a per-second budget is multiplied by 60. A source that is paused, backing off, switched off or without a key adds nothing. Free sources add room only for calls that can be delayed. The headline is never calmer than your busiest source."),
      pool.counted.length
        ? h(
            "div",
            { class: "list" },
            pool.counted.map((c) => h("div", { class: "list-row static" }, h("span", { class: "names" }, h("span", { class: "nm" }, c.name), h("span", { class: "sub" }, classLabel(c.cls, c.delaySec))), h("span", { class: "value" }, `${formatInt(c.remaining)} of ${formatInt(c.limit)} ${unit}`))),
          )
        : h("p", { class: "hint" }, "Nothing counts yet."),
      pool.notCounted.length ? h("div", {}, h("h3", { class: "group-title" }, "Not counted"), h("div", { class: "list" }, pool.notCounted.map((n) => h("div", { class: "list-row static" }, h("span", { class: "names" }, h("span", { class: "nm" }, n.name), h("span", { class: "sub sx-wrap" }, `Adds nothing because ${n.reason}.`)))))) : null,
      h("p", { class: "hint" }, `Estimates use the last 30 seconds of traffic. ${rows.length ? "" : "Nothing is connected yet."}`.trim()),
    ),
    buttons: [{ label: "Done", cls: "primary", value: true }],
  });
}

// ── The page ──

/**
 * @returns {Promise<HTMLElement>}  the Overview tab
 */
export async function renderOverview() {
  const root = h("div", { class: "sx-tab sx-overview" });
  const trackers = { tones: createToneTracker(), rates: createRateTracker(), smooth: createSmoother() };
  const local = app.local;
  let sortMode = SORTS.some(([v]) => v === local.get(SORT_SLOT)) ? local.get(SORT_SLOT) : "risk";
  let lastOkAt = 0;
  let lastSortAt = 0;
  let pollCount = 0;
  let onlySlow = false;
  let live = null;
  /** The last answers: each is { data } or { error }. */
  const got = { sources: null, usage: null, requests: null, limits: null, accounts: null };
  let model = { rows: [], pool: null, tone: "calm" };
  const spoken = { tone: null, at: 0, conn: "" };

  const nameOf = (id) => {
    const r = model.rows.find((x) => x.id === id);
    if (r) return r.name;
    const s = (got.sources?.data?.data ?? []).find((x) => x.id === id);
    return s?.name ?? id;
  };

  // ── Hero ──
  const glyph = toneGlyph("calm");
  const sentence = h("h2", { class: "sx-sentence", id: "sx-hero-h" }, "Plenty of room");
  const prefix = document.createTextNode("");
  const suffix = document.createTextNode("");
  const figure = countingNumber({ className: "sx-figure" });
  const detail = h("p", { class: "sx-detail" }, prefix, figure.el, suffix);
  const updated = h("span", { class: "pill sx-updated" }, "Updating…");
  const poolMeter = createMeter({ label: "Room used across all sources", tall: true });
  const capL = h("span", {}, "");
  const capR = h("span", {}, "");
  const forecastText = h("span", {}, "");
  const forecastRow = h("p", { class: "sx-forecast" }, icon("clock"), forecastText);
  const whyBtn = h("button", { type: "button", class: "small tinted", onclick: () => openTraceSheet({ nameOf }) }, icon("route"), "Why this source?");
  const howBtn = h("button", { type: "button", class: "small plain", onclick: () => model.pool && openPoolSheet(model.pool, model.rows) }, "How is this worked out?");
  const hero = h(
    "section",
    { class: "card sx-hero", "data-tone": "calm", "aria-labelledby": "sx-hero-h" },
    h("div", { class: "sx-hero-top" }, glyph, h("div", { class: "sx-hero-text" }, h("p", { class: "sx-eyebrow" }, "Room right now"), sentence), updated),
    detail,
    poolMeter.el,
    h("div", { class: "sx-cap" }, capL, capR),
    forecastRow,
    h("div", { class: "sx-hero-actions" }, whyBtn, howBtn),
  );

  // ── Banners ──
  const attnBox = h("div", { class: "sx-attn", "aria-label": "Heads up" });
  const attn = createKeyedList(attnBox, {
    key: (a) => `attn:${a.row.key}`,
    create: () => {
      const title = h("strong", {});
      const text = h("span", { class: "detail" });
      const show = h("button", { type: "button", class: "small" }, "Show it");
      const el = h("div", { class: "alert warn sx-alert" }, icon("warn"), h("div", {}, title, text, h("div", { class: "alert-actions" }, show)));
      el._parts = { title, text, show };
      return el;
    },
    update: (el, a) => {
      const t = attentionText(a.row, model.rows);
      el.className = `alert ${t.tone} sx-alert`;
      setText(el._parts.title, t.title);
      setText(el._parts.text, t.detail);
      el._parts.show.onclick = () => focusRow(a.row.key);
    },
  });
  const lost = h("div", { class: "alert warn sx-lost", role: "status", hidden: true }, icon("warn"), h("div", {}, h("strong", {}, "Live numbers have stopped"), h("span", { class: "detail" }, "The Bridge still enforces its limits. This page is showing the last reading until the connection comes back.")));

  // ── Sources ──
  const rowsBox = h("div", { class: "list sx-rows", role: "group", "aria-label": "Sources, most at risk first" });
  const rowsList = createKeyedList(rowsBox, { key: (r) => r.key, create: createSourceRow, update: updateSourceRow });
  const sortSeg = segmented ? segmented("Sort sources by", SORTS, sortMode) : h("span");
  sortSeg.classList?.add("sx-sort");
  const rowsFoot = h("p", { class: "group-foot" });
  const rowsEmpty = h("div", { class: "list sx-empty", hidden: true }, emptyState("sources", "No sources yet", "Connect a broker account or turn on a free data source. Each one adds room and a fallback.", h("span", { class: "sx-empty-acts" }, h("button", { type: "button", class: "primary", onclick: () => go("#/accounts") }, "Go to Accounts"), h("button", { type: "button", onclick: () => go("#/sources/providers") }, "Turn on a free source"))));
  const sourcesGroup = h(
    "section",
    { class: "group sx-group", "aria-labelledby": "sx-src-h" },
    h("div", { class: "sx-group-head" }, h("h2", { class: "group-title", id: "sx-src-h" }, "Sources"), sortSeg),
    rowsBox,
    rowsEmpty,
    rowsFoot,
    labelsHelp(),
  );
  sortSeg.addEventListener?.("change", () => {
    sortMode = sortSeg.value;
    local.set(SORT_SLOT, sortMode);
    paintRows(true);
  });

  // ── Broker budgets ──
  const budgetsBox = h("div", { class: "sx-budgets" });
  const budgetsList = createKeyedList(budgetsBox, { key: (r) => r.key, create: createBudgetCard, update: updateBudgetCard });
  const budgetsGroup = h("section", { class: "group sx-group", "aria-labelledby": "sx-bud-h", hidden: true }, h("h2", { class: "group-title", id: "sx-bud-h" }, "Broker budgets"), budgetsBox, h("p", { class: "group-foot" }, "What each broker lets the Bridge call, by kind of call. Orders have their own budget, apart from prices."));

  // ── Recent requests ──
  const reqBox = h("div", { class: "list sx-reqs", role: "group", "aria-label": "Recent requests, newest first" });
  const reqList = createKeyedList(reqBox, { key: (r) => r.requestId ?? `${r.at}${r.path}`, create: createRequestRow, update: (el, r) => updateRequestRow(el, r) });
  const reqEmpty = h("div", { class: "list", hidden: true }, emptyState("activity", "No requests yet", "Send one from the Test console and its route appears here.", h("button", { type: "button", onclick: () => go("#/api/console") }, "Open the Test console")));
  const reqError = h("div", { hidden: true });
  const slowBtn = h("button", { type: "button", class: "chip-btn", "aria-pressed": "false" }, "Only slow or held back");
  slowBtn.addEventListener("click", () => {
    onlySlow = !onlySlow;
    slowBtn.setAttribute("aria-pressed", String(onlySlow));
    paintRequests();
  });
  const reqFoot = h("p", { class: "group-foot" }, "The dashboard's own requests are hidden. Select a market-data request to see why it went where it did.");
  const reqGroup = h("section", { class: "group sx-group", "aria-labelledby": "sx-req-h" }, h("div", { class: "sx-group-head" }, h("h2", { class: "group-title", id: "sx-req-h" }, "Recent requests"), slowBtn), reqBox, reqEmpty, reqError, reqFoot);

  // ── Saved today and who used it ──
  const savedNums = {};
  const savedBox = h(
    "div",
    { class: "card sx-saved" },
    h(
      "div",
      { class: "card-body sx-saved-grid" },
      [
        ["servedFromStream", "Live stream", "No broker call at all"],
        ["servedFromCache", "Cache", "Fresh enough, labelled with its age"],
        ["coalesced", "Shared calls", "Identical requests shared one call"],
        ["batched", "Batched", "Symbols packed into fewer calls"],
      ].map(([k, name, sub]) => {
        const n = countingNumber({ className: "sx-stat-n" });
        savedNums[k] = n;
        return h("div", { class: "sx-stat" }, n.el, h("span", { class: "sx-stat-l" }, name), h("span", { class: "sx-stat-s" }, sub));
      }),
    ),
  );
  const savedGroup = h("section", { class: "group sx-group", "aria-labelledby": "sx-sav-h", hidden: true }, h("h2", { class: "group-title", id: "sx-sav-h" }, "Broker calls saved today"), savedBox, h("p", { class: "group-foot" }, "The Bridge answers many requests without calling a broker at all."));
  const consBox = h("div", { class: "list sx-cons" });
  const consList = createKeyedList(consBox, {
    key: (c) => c.name,
    create: (c) => {
      const bar = h("span", { class: "sx-cons-bar", "aria-hidden": "true" });
      const name = h("span", { class: "sx-cons-name" }, c.name);
      const n = h("span", { class: "sx-cons-n" });
      const el = h("div", { class: "list-row static sx-cons-row" }, name, h("span", { class: "sx-cons-track" }, bar), n);
      el._parts = { bar, n };
      return el;
    },
    update: (el, c) => {
      el.style.setProperty("--w", `${c.pct}%`);
      setText(el._parts.n, `${plural(c.calls, "broker call")}${c.saved ? `, ${formatInt(c.saved)} saved` : ""}`);
    },
  });
  const consGroup = h("section", { class: "group sx-group", "aria-labelledby": "sx-con-h", hidden: true }, h("h2", { class: "group-title", id: "sx-con-h" }, "Who used the budget today"), consBox);

  // ── What each broker allows (read once) ──
  const policyBox = h("div", { class: "sx-policy-box", hidden: true });

  const liveRegion = h("div", { class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  live = liveRegion;
  let built = false;
  /** Swap the skeleton for the page (the first answer has arrived). The same boxes, so nothing jumps. */
  const build = () => {
    built = true;
    root.replaceChildren(liveRegion, lost, hero, attnBox, sourcesGroup, budgetsGroup, reqGroup, savedGroup, consGroup, policyBox);
    if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("trace")) queueMicrotask(() => openTraceSheet({ nameOf }));
  };
  /** The first read failed: say so in place and keep trying; the page appears by itself when the Bridge answers. */
  const showFailure = (err) => {
    const retry = h("button", { type: "button", class: "small", onclick: () => poller.tick() }, icon("refresh"), "Try again");
    const box = alertBox(err);
    box.lastElementChild.append(h("div", { class: "alert-actions" }, retry));
    root.replaceChildren(box);
  };

  // ── Rows ──

  function createSourceRow(r) {
    const title = h("span", { class: "sx-title" }, r.name);
    const cls = classPill(r.cls, r.delaySec);
    const off = officialBadge(r.official);
    const tag = healthTag();
    const subText = h("span", { class: "sx-subtext" });
    const meter = createMeter({ label: r.name });
    meter.el.setAttribute("aria-hidden", "true");
    meter.el.firstChild.removeAttribute("role");
    const num = countingNumber({ className: "sx-left" });
    const leftText = h("span", { class: "sx-lefttext" });
    const word = h("span", { class: "sx-toneword" });
    const reset = h("time", { class: "sx-reset" });
    const gauge = h("span", { class: "sx-gauge" }, meter.el, h("span", { class: "sx-figs" }, h("span", { class: "sx-figs-l" }, num.el, leftText), h("span", { class: "sx-figs-r" }, word, reset)));
    const tile = sourceTile(r);
    const el = h("button", { type: "button", class: "list-row sx-row", "aria-haspopup": "dialog" }, tile, h("span", { class: "sx-main" }, h("span", { class: "sx-line1" }, title, cls, off), h("span", { class: "sx-line2" }, tag.el, subText)), gauge, chevron());
    el._parts = { title, cls, off, tag, subText, meter, num, leftText, word, reset, gauge, said: 0 };
    return el;
  }

  function updateSourceRow(el, r) {
    const p = el._parts;
    el._row = r;
    el.onclick = () => openSourceSheet(el._row, { nameOf });
    setText(p.title, r.name);
    updateClassPill(p.cls, r.cls, r.delaySec);
    p.off.className = `chip sx-official${r.official ? "" : " unofficial"}`;
    setText(p.off, officialLabel(r.official));
    p.tag.set(r.health);
    setText(p.subText, r.health.state === "working" || r.health.state === "off" ? r.sub : `${r.health.detail}`);
    setData(el, "tone", r.tone);
    setData(el, "health", r.health.state);
    const b = r.budget;
    if (b) {
      p.meter.set({ share: b.share, tone: r.tone, speech: meterSpeech(r) });
      p.num.set(b.remaining, { digits: String(formatInt(b.limit)).length });
      setText(p.leftText, ` left of ${formatInt(b.limit)} ${b.per}${b.clsName ? ` (${b.clsName.toLowerCase()})` : ""}`);
      setText(p.word, TONE_WORD[r.tone]);
      const until = (r.tone === "limit" || r.tone === "headsup") && b.resetInSec ? Date.now() + b.resetInSec * 1000 : null;
      setData(p.reset, "until", until);
      if (!until) setText(p.reset, "");
      p.gauge.hidden = false;
    } else {
      p.gauge.hidden = false;
      p.meter.set({ share: 0, tone: "calm", speech: "No call budget stated" });
      p.num.set(null);
      setText(p.leftText, "No call budget stated");
      setText(p.word, "");
      setData(p.reset, "until", null);
      setText(p.reset, "");
    }
    // The spoken name of the row changes at most every 5 s, or when its tone does.
    const key = `${r.tone}|${r.health.state}|${r.cls}`;
    const now = Date.now();
    if (p.saidKey !== key || now - p.said > 5000) {
      p.said = now;
      p.saidKey = key;
      el.setAttribute("aria-label", `${r.name}. ${r.health.word}. ${classLabel(r.cls, r.delaySec)}. ${officialLabel(r.official)}. ${b ? meterSpeech(r) : "No call budget stated"}. Select for details.`);
    }
  }

  // ── Broker budgets cards ──

  function createBudgetCard(r) {
    const meters = h("div", { class: "sx-class-meters" });
    const list = createKeyedList(meters, {
      key: (c) => c.cls,
      create: (c) => {
        const name = h("span", { class: "sx-class-name" }, c.name);
        const figs = h("span", { class: "sx-class-figs" });
        const word = h("span", { class: "sx-toneword" });
        const meter = createMeter({ label: `${r.name} ${c.name}` });
        const el = h("div", { class: "sx-class" }, h("div", { class: "sx-class-head" }, name, h("span", { class: "sx-class-r" }, figs, word)), meter.el);
        el._parts = { figs, word, meter };
        return el;
      },
      update: (el, c) => {
        const b = c.binding;
        const t = trackers.tones.update(`${r.key}:${c.cls}`, b.share, null, Date.now());
        el._parts.meter.set({ share: b.share, tone: t, speech: `${c.name}: ${formatInt(b.remaining)} of ${formatInt(b.limit)} calls left ${b.per}, ${TONE_WORD[t].toLowerCase()}`, label: `${r.name}, ${c.name}` });
        setText(el._parts.figs, `${formatInt(b.used)} of ${formatInt(b.limit)} ${b.per}`);
        setText(el._parts.word, TONE_WORD[t]);
      },
    });
    const today = h("p", { class: "sx-today" });
    const head = h("header", { class: "card-head" }, brokerTile(String(r.sub).split(",")[0].toLowerCase(), r.name), h("div", { class: "card-titles" }, h("h3", { class: "sx-card-title" }, r.name), h("p", { class: "sx-card-sub" }, "")), h("div", { class: "card-actions" }, healthTag().el));
    const tag = head.querySelector(".sx-health");
    const el = h("section", { class: "card sx-budget-card" }, head, h("div", { class: "card-body stack" }, meters, today));
    el._parts = { list, today, sub: head.querySelector(".sx-card-sub"), tag };
    return el;
  }

  function updateBudgetCard(el, r) {
    const p = el._parts;
    setText(p.sub, `${String(r.sub).split(",")[0]} · ${formatInt(r.inFlight)} in flight · ${formatInt(r.queued)} waiting`);
    setData(p.tag, "tone", r.health.tone);
    setText(p.tag.lastChild, r.health.word);
    p.list.sync(r.classes.filter((c) => c.binding), { reorder: false });
    const total = (k) => r.classes.reduce((n, c) => n + c[k], 0);
    setText(p.today, `Today: ${plural(total("callsToday"), "broker call")}, ${formatInt(total("throttledToday"))} throttled by the broker, ${formatInt(total("refusedToday"))} held back to stay inside limits.`);
  }

  // ── Request rows ──

  function createRequestRow(r) {
    const cap = capabilityForPath(r.path);
    const time = h("span", { class: "sx-req-time" });
    const method = h("span", { class: "method sx-req-method" }, r.method);
    const path = h("span", { class: "sx-req-path mono", title: r.path }, r.path);
    const who = h("span", { class: "sx-req-who" });
    const verdict = h("span", { class: "pill sx-req-verdict" });
    const ms = h("span", { class: "sx-req-ms" });
    const inner = [time, h("span", { class: "sx-req-main" }, h("span", { class: "sx-req-line" }, method, path), who), h("span", { class: "sx-req-end" }, verdict, ms), cap ? chevron() : null];
    const el = cap ? h("button", { type: "button", class: "list-row sx-req", "aria-haspopup": "dialog" }, inner) : h("div", { class: "list-row static sx-req" }, inner);
    el._parts = { time, verdict, ms, who };
    if (cap) el.onclick = () => openTraceSheet({ capability: cap, nameOf });
    return el;
  }

  function updateRequestRow(el, r) {
    const p = el._parts;
    const v = requestVerdict(r);
    setText(p.time, istTime(r.at));
    setText(p.ms, `${formatInt(r.ms)} ms`);
    setText(p.who, r.keyId ? `Key ${r.keyId}` : "No key");
    p.verdict.className = `pill sx-req-verdict ${v.tone}`.trim();
    const dot = p.verdict.firstChild?.className === "pdot" ? p.verdict.firstChild : null;
    if (["ok", "bad", "warn"].includes(v.tone)) {
      if (!dot) p.verdict.prepend(h("span", { class: "pdot", "aria-hidden": "true" }));
    } else dot?.remove();
    const textNode = p.verdict.lastChild?.nodeType === 3 ? p.verdict.lastChild : null;
    if (textNode) textNode.data = v.text;
    else p.verdict.append(document.createTextNode(v.text));
    setData(el, "slow", r.status >= 400 || r.ms >= 500 ? "1" : null);
    if (el.tagName === "BUTTON") el.setAttribute("aria-label", `${istTime(r.at)}, ${r.method} ${r.path}. ${v.text}. ${formatInt(r.ms)} milliseconds. Select to see why.`);
  }

  // ── Painting ──

  function focusRow(key) {
    const el = rowsList.nodes.get(key);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  }

  function paint(at) {
    const sources = withSwitches(got.sources?.data?.data ?? null);
    const usage = got.usage?.data?.data ?? null;
    const labels = Object.fromEntries((got.accounts?.data?.data ?? []).map((a) => [a.id, a.label]));
    const rows = buildRows({ sources, usage, time: istTime, labels });
    annotateRows(rows, { ...trackers, at });
    const keep = new Set(rows.map((r) => r.key));
    trackers.rates.prune(new Set([...keep, ...rows.flatMap((r) => r.classes.map((c) => `${r.key}:${c.cls}`))]));
    trackers.tones.prune(new Set([...keep, "pool", ...rows.flatMap((r) => r.classes.map((c) => `${r.key}:${c.cls}`))]));
    trackers.smooth.prune(keep);
    const pool = pooledRoom(rows);
    const poolTone = pool.window ? trackers.tones.update("pool", pool.share, null, at) : "calm";
    // The headline is never calmer than your busiest source: one account at the limit is at least a heads up.
    const worst = rows.reduce((n, r) => (r.enabled ? Math.max(n, toneRank(r.tone)) : n), 0);
    const floor = ["calm", "calm", "busy", "headsup"][worst];
    const tone = toneRank(floor) > toneRank(poolTone) ? floor : poolTone;
    model = { rows, pool, tone };
    paintHero();
    attn.sync(attentionRows(rows).slice(0, 3).map((row) => ({ row })), { reorder: true });
    paintRows(false, at);
    paintBudgets(rows);
    paintSaved(usage);
    announce(at);
  }

  function paintHero() {
    const { rows, pool, tone } = model;
    const t = heroText({ pool, tone, rows });
    hero.hidden = rows.length === 0;
    setData(hero, "tone", tone);
    setToneGlyph(glyph, tone);
    setText(sentence, t.sentence);
    if (prefix.data !== t.prefix) prefix.data = t.prefix;
    if (suffix.data !== t.suffix) suffix.data = t.suffix;
    figure.el.hidden = t.figure === null;
    figure.set(t.figure === null ? null : pool.remaining, { digits: String(formatInt(pool.limit)).length });
    const pooled = pool.window !== null;
    poolMeter.el.hidden = !pooled;
    if (pooled) {
      poolMeter.set({ share: pool.share, tone, speech: `${formatInt(pool.remaining)} of ${formatInt(pool.limit)} calls of room left ${pool.window === "minute" ? "per minute" : "today"}, ${TONE_WORD[tone].toLowerCase()}` });
      setText(capL, `${percent(pool.share)}% used`);
      setText(capR, `${plural(pool.limit, "call")} ${pool.window === "minute" ? "per minute" : "today"} in all`);
    } else {
      setText(capL, "");
      setText(capR, "");
    }
    const f = forecastSentence(rows, tone);
    setText(forecastText, f.text);
    setData(forecastRow, "tone", f.tone);
    forecastRow.hidden = !pooled && f.tone === "calm";
    howBtn.hidden = !pooled;
    whyBtn.hidden = got.sources?.error ? isMissing(got.sources.error) : false;
  }

  function paintRows(force, at = Date.now()) {
    const rows = model.rows;
    rowsEmpty.hidden = rows.length > 0;
    rowsBox.hidden = rows.length === 0;
    sortSeg.hidden = rows.length < 2;
    const busy = rowsBox.matches(":hover") || rowsBox.contains(document.activeElement);
    const first = rowsList.nodes.size === 0;
    const reorder = force || first || (at - lastSortAt >= 5000 && !busy);
    if (reorder) lastSortAt = at;
    rowsList.sync(sortRows(rows, sortMode), { reorder });
    const total = (got.sources?.data?.data ?? []).length;
    const off = (got.sources?.data?.data ?? []).filter((s) => !s.enabled).length;
    const missing = got.sources?.error ? isMissing(got.sources.error) : false;
    if (missing) setText(rowsFoot, "Free data sources and route traces need a newer Bridge. Your broker accounts are shown above.");
    else if (got.sources?.error) setText(rowsFoot, "The list of free sources could not be read just now. Broker accounts are still shown.");
    else if (total && off) {
      rowsFoot.replaceChildren(`${off === 1 ? "1 source is" : `${off} sources are`} switched off. `, h("a", { href: "#/sources/providers" }, "Turn them on in Providers"), ".");
    } else setText(rowsFoot, rows.length ? "Sorted by risk: what is busiest or in trouble comes first. Select a source for its details." : "");
  }

  function paintBudgets(rows) {
    const accts = rows.filter((r) => r.kind === "account" && r.classes.some((c) => c.binding));
    budgetsGroup.hidden = accts.length === 0;
    budgetsList.sync(accts, { reorder: false });
  }

  function paintSaved(usage) {
    const sv = usage?.savings;
    savedGroup.hidden = !sv;
    if (sv) for (const [k, n] of Object.entries(savedNums)) n.set(Number(sv[k]) || 0, { digits: 5 });
    const cons = Array.isArray(usage?.consumers) ? usage.consumers : [];
    consGroup.hidden = cons.length === 0;
    const top = Math.max(1, ...cons.map((c) => c.calls));
    consList.sync(cons.map((c) => ({ ...c, pct: Math.round((c.calls / top) * 100) })), { reorder: true });
  }

  function paintRequests() {
    const err = got.requests?.error;
    const all = got.requests?.data?.data ?? [];
    reqError.hidden = !err;
    if (err) reqError.replaceChildren(isMissing(err) || err.status === 403 ? alertBox({ title: "The request log needs an admin key", detail: "Sign in with an admin key to see recent requests." }, "info") : alertBox(err));
    const mine = all.filter((r) => r.client !== "dashboard");
    const slow = mine.filter((r) => r.status >= 400 || r.ms >= 500);
    const shown = (onlySlow ? slow : mine).slice(0, REQUEST_ROWS);
    reqEmpty.hidden = shown.length > 0 || Boolean(err);
    if (!shown.length && onlySlow && mine.length) reqEmpty.replaceChildren(emptyState("check", "Nothing slow or held back", "Every recent request was answered quickly.", h("button", { type: "button", onclick: () => slowBtn.click() }, "Show all requests")));
    else if (!shown.length) reqEmpty.replaceChildren(emptyState("activity", "No requests yet", "Send one from the Test console and its route appears here.", h("button", { type: "button", onclick: () => go("#/api/console") }, "Open the Test console")));
    reqBox.hidden = shown.length === 0;
    reqList.sync(shown, { reorder: true });
  }

  function paintPolicies() {
    const brokers = Object.values(got.limits?.data?.data?.brokers ?? {});
    if (!brokers.length || policyBox.dataset.done) return;
    policyBox.dataset.done = "1";
    policyBox.hidden = false;
    policyBox.append(
      h("h2", { class: "group-title" }, "What each broker allows"),
      ...brokers.map((p) =>
        h(
          "details",
          { class: "sx-policy-item" },
          h("summary", {}, h("span", {}, h("strong", {}, p.brokerId), p.notes ? h("span", { class: "muted small" }, ` · ${p.notes}`) : null)),
          h(
            "div",
            { class: "list sx-policy" },
            Object.entries(p.limits ?? {}).map(([cls, l]) => {
              const bits = [l.perSecond ? `${formatFixed(l.perSecond, Number.isInteger(Number(l.perSecond)) ? 0 : 1)} a second` : null, l.perMinute ? `${formatInt(l.perMinute)} a minute` : null, l.perDay ? `${formatInt(l.perDay)} a day` : null].filter(Boolean).join(", ");
              const src = String(l.source ?? "").includes("demo") ? pill("Sample (demo)", "demo") : l.verified ? pill("Broker docs", "ok") : pill("Conservative default", "warn");
              return h("div", { class: "list-row static" }, h("span", { class: "names" }, h("span", { class: "nm" }, CLASS_NAME[cls] ?? cls), h("span", { class: "sub sx-wrap" }, bits || DASH)), src);
            }),
          ),
        ),
      ),
    );
  }

  /** A change of tone is said once, politely, at most every 30 seconds. */
  function announce(at) {
    const key = `${model.tone}|${attentionRows(model.rows).map((r) => `${r.key}:${r.tone}`).join(",")}`;
    if (spoken.tone === null) {
      spoken.tone = key;
      return;
    }
    if (key === spoken.tone || at - spoken.at < 30_000) return;
    spoken.tone = key;
    spoken.at = at;
    const worst = attentionRows(model.rows)[0];
    const f = forecastSentence(model.rows, model.tone);
    setText(live, worst ? `${attentionText(worst, model.rows).title}. ${f.tone === "warn" ? f.text : ""}` : `${TONE_WORD[model.tone]}. ${heroText({ pool: model.pool, tone: model.tone, rows: model.rows }).detail}`);
  }

  // ── Fetching ──

  /** One poll: sources, usage and the request log together; the broker policy and consumers more slowly. */
  async function poll() {
    const at = Date.now();
    pollCount += 1;
    const slow = pollCount === 1 || pollCount % BROKER_POLICY_EVERY === 0;
    // A Bridge without the route is asked again only now and then, not every poll.
    const skipSources = got.sources?.error && isMissing(got.sources.error) && pollCount % 30 !== 0;
    const [s, u, r, l, acc] = await Promise.all([skipSources ? Promise.resolve(got.sources) : optional(api("/v1/sources", { fresh: true })), optional(api("/v1/usage", { fresh: true })), optional(api("/v1/requests?limit=60", { fresh: true })), slow && !policyBox.dataset.done ? optional(api("/v1/limits", { fresh: true })) : Promise.resolve(null), slow ? optional(api("/v1/accounts")) : Promise.resolve(null)]);
    if (!root.isConnected && pollCount > 1) return;
    got.sources = s;
    got.usage = u;
    got.requests = r;
    if (l) got.limits = l;
    if (acc?.data) got.accounts = acc;
    const ok = Boolean(s.data || u.data);
    if (!built && !ok) {
      showFailure(u.error ?? s.error);
      return;
    }
    if (ok) {
      lastOkAt = at;
      if (!built) build();
      paint(at);
    }
    paintRequests();
    paintPolicies();
    tickClock();
  }

  /** Once a second: "Updated 2 s ago", the stale and lost states, the countdowns. Text only. */
  function tickClock() {
    if (!root.isConnected) return;
    const now = Date.now();
    const age = lastOkAt ? now - lastOkAt : Infinity;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    const stale = age > STALE_MS || offline;
    setData(root, "stale", stale ? "1" : null);
    updated.className = `pill sx-updated${stale ? " warn" : ""}`;
    if (!lastOkAt) setText(updated, "Updating…");
    else if (offline) setText(updated, `Offline, last reading ${istTime(new Date(lastOkAt).toISOString())}`);
    else if (stale) setText(updated, `Not updating, last ${istTime(new Date(lastOkAt).toISOString())}`);
    else setText(updated, `Updated ${agoText(age)}`);
    lost.hidden = !(lastOkAt && (age > LOST_MS || offline));
    // The pill above changes every second and is not a live region; only a change of connection is said.
    const conn = offline ? "offline" : stale ? "stale" : "live";
    if (conn !== spoken.conn) {
      if (lastOkAt && conn !== "live") setText(live, offline ? "You are offline. These numbers are the last ones read." : "These numbers have stopped updating.");
      spoken.conn = conn;
    }
    for (const t of root.querySelectorAll("time.sx-reset[data-until]")) {
      const left = Number(t.dataset.until) - now;
      setText(t, left > 0 ? `, room back in ${shortWait(left)}` : "");
    }
  }

  const poller = createPoller({ root, ms: 2000, run: poll });
  const clock = setInterval(() => {
    if (root.isConnected) return tickClock();
    clearInterval(clock);
    window.removeEventListener("online", tickClock);
    window.removeEventListener("offline", tickClock);
    return undefined;
  }, 1000);
  window.addEventListener("online", tickClock);
  window.addEventListener("offline", tickClock);

  // Show the shape of the page at once, then fill it with the first answer.
  root.replaceChildren(overviewSkeleton());
  poller.start();
  poll();
  return root;
}
