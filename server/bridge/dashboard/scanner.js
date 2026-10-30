// Stock scanner (#/screeners/stocks, docs/guides/scanner.md). Number scans over the F&O stocks: a library of
// ready-made scans (price levels and ranges, F&O build-ups, OI, IV, basis, option chain), a plain-word builder that
// compiles to the scanner's condition language with an Advanced text mode that round-trips, a debounced live count
// while editing, saved scans with schedules, and a compact results table with a side sheet per symbol.
//
// The builder and the library are pure modules (scan-builder.js, scan-library.js), shared with the Bridge. Data:
// POST /v1/scanner/jobs (live scans read cached daily bars, the shared quotes and the recorder's or the sweep's
// chains), POST /v1/scanner/count (no broker call), POST /v1/scanner/compile (text → builder), /v1/scanner/saved.
// Numbers become text through format.js only.
import { api, app, card, copyButton, copyText, emptyState, h, icon, istDateTime, modal, optional, sheetPopover, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatNumber, formatSigned, isFigure } from "./format.js";
import { excelFormula } from "./flows.js";
import { COLUMNS, GROUPS, OPERAND_BY_ID, OPS, BOOL_OPS, compileModel, describeModel, emptyRule, filterRows, isBool, operandLabel, opWords, resultsCsv, searchOperands, sortRows } from "./scan-builder.js";
import { LIBRARY, LIBRARY_BY_ID, LIBRARY_GROUPS, libraryEdited, libraryRequest, savedScanName } from "./scan-library.js";
import { fieldError } from "./flows.js";
import { handoffPrefs } from "./screens.js";
import { segmented } from "./views.js";
import { setBar } from "./viz.js";

/** Up to this many matches, the results card also shows the sector and % change charts under the table. */
const SUMMARY_MAX = 12;

const PREFS_SLOT = "mcb.dashboard.scanner";
const DESK_SLOT = "mcb.dashboard.desk";
const COUNT_DEBOUNCE_MS = 450;
const local = { get: (k) => app.local?.get?.(k) ?? null, set: (k, v) => app.local?.set?.(k, v) };
const readJson = (slot, fallback) => {
  try {
    return JSON.parse(local.get(slot) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (slot, v) => {
  try {
    local.set(slot, JSON.stringify(v));
  } catch {
    /* storage off: defaults next time */
  }
};
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const ticker = (s) => String(s ?? "").split(":").pop();
const clone = (x) => structuredClone(x);

/** Result columns that are changes: shown with their sign, as % chg is. */
const SIGNED_COLS = new Set(["fut_oi_change_pct", "gap_pct", "basis_pct"]);

/** A fact value as text by its unit (pure). */
export function factText(v, unit) {
  if (!isFigure(v)) return DASH;
  switch (unit) {
    case "pct":
      return `${formatFixed(v, 2)}%`;
    case "spct":
      return `${formatSigned(v, 2)}%`;
    case "pts":
      return formatSigned(v, 1);
    case "x":
      return `${formatFixed(v, 2)}×`;
    case "ratio":
      return formatFixed(v, 2);
    case "qty":
      return formatCompact(v);
    case "rank":
      return formatFixed(v, 0);
    case "days":
      return formatFixed(v, 1);
    case "bool":
      return Number(v) === 1 ? "Yes" : "No";
    default:
      return formatFixed(v, 2);
  }
}

/** "Ran in 0.42 s · 204 symbols · 0 broker calls" (pure). */
export function runLine(stats) {
  if (!stats) return "";
  const secs = formatNumber((stats.ms ?? 0) / 1000, { maximumFractionDigits: 2 });
  const calls = `${formatInt(stats.brokerCalls ?? 0)} broker call${stats.brokerCalls === 1 ? "" : "s"}`;
  return `Ran in ${secs} s · ${formatInt(stats.symbols ?? 0)} symbols · ${calls}${stats.demo ? " (demo data)" : ""}`;
}

/** The copy-ready Excel formula for a scan's matches: a spilled list of tickers (pure). */
export function scanFormula(origin, { savedId = null, request = null } = {}) {
  const host = String(origin ?? "").replace(/\/$/, "");
  if (savedId) return `=TEXTSPLIT(WEBSERVICE("${host}/v1/scanner/saved/${encodeURIComponent(savedId)}/results?format=text&key="&BridgeKey),",")`;
  return `=TEXTSPLIT(WEBSERVICE("${host}${scanUrl(request, "text")}&key="&BridgeKey),",")`;
}

/** GET /v1/scanner/scan for a request (pure): the API URL that runs the same scan. */
export function scanUrl(request, format = "json") {
  const q = new URLSearchParams();
  q.set("condition", request?.condition ?? "");
  if (request?.universe) q.set("universe", request.universe);
  if (request?.interval && request.interval !== "live") q.set("interval", request.interval);
  if (request?.sort?.by) {
    q.set("sort", request.sort.by);
    q.set("order", request.sort.order ?? "desc");
  }
  q.set("format", format);
  return `/v1/scanner/scan?${q.toString()}`;
}

// ── Page ──

export async function renderScannerPage() {
  const prefs = { group: "price", columns: COLUMNS.filter((c) => c.def).map((c) => c.id), sector: "", index: "", fnoOnly: false, sort: null, ...readJson(PREFS_SLOT, {}) };
  const savePrefs = () => writeJson(PREFS_SLOT, prefs);
  const [savedRes, unis] = await Promise.all([optional(api("/v1/scanner/saved")), optional(api("/v1/scanner/universes"))]);
  let saved = savedRes.data?.data ?? [];

  /** The scan being edited. */
  const st = {
    name: "",
    libraryId: null,
    savedId: null,
    universe: "FNO",
    interval: "live",
    mode: "builder",
    model: clone(LIBRARY[0].model),
    text: LIBRARY[0].condition,
    sort: { by: LIBRARY[0].sort, order: LIBRARY[0].order },
    job: null,
    running: false,
  };

  // ── Library and saved scans ──
  const libHost = h("div", { class: "sc-lib-list", role: "list" });
  const groupSeg = segmented("Scan group", [...LIBRARY_GROUPS.map((g) => [g.id, g.label]), ["saved", "Saved"]], prefs.group);
  groupSeg.addEventListener("change", () => {
    prefs.group = groupSeg.value;
    savePrefs();
    drawLibrary();
  });

  function scheduleText(s) {
    const parts = [];
    // Demo: the demo market ticks at any hour, so schedules run after hours too (the Bridge allows it in demo only).
    if (s.everyMinutes) parts.push(`Every ${formatInt(s.everyMinutes)} min${s.marketHoursOnly === false ? "" : app.state.demo ? " (demo: any hour)" : " in market hours"}`);
    if (s.atClose) parts.push("At the close");
    return parts.length ? parts.join(" · ") : "On demand";
  }

  function drawLibrary() {
    if (prefs.group === "saved") {
      if (!saved.length) return fill(libHost, emptyState("bell", "No saved scans yet", "Run a scan, then Save it to run on a schedule and get its new matches in Live events.", null, { compact: true }));
      return fill(
        libHost,
        saved.map((s) => {
          const last = s.lastRun;
          const row = h(
            "div",
            { class: `sc-lib-row${st.savedId === s.id ? " is-cur" : ""}`, role: "listitem" },
            h(
              "button",
              { type: "button", class: "sc-lib-main no-dot", onclick: () => openSaved(s, true), title: s.request?.condition ?? "" },
              h("strong", {}, s.name),
              h("small", {}, `${scheduleText(s)}${last ? ` · ${formatInt(last.matched?.length ?? 0)} matched ${istDateTime(last.at)}` : ""}${last?.newMatches?.length ? ` · ${formatInt(last.newMatches.length)} new` : ""}`),
            ),
            h("button", { type: "button", class: "icon-btn tiny quiet", "aria-label": `Actions for ${s.name}`, onclick: (e) => savedMenu(e.currentTarget, s) }, icon("more")),
          );
          return row;
        }),
      );
    }
    const list = LIBRARY.filter((s) => s.group === prefs.group);
    fill(
      libHost,
      list.map((s) =>
        h(
          "div",
          { class: `sc-lib-row${st.libraryId === s.id && !st.savedId ? " is-cur" : ""}`, role: "listitem" },
          h("button", { type: "button", class: "sc-lib-main", onclick: () => openLibrary(s.id, true) }, h("span", { class: `sc-side ${s.side}`, "aria-hidden": "true" }), h("strong", {}, s.name), h("small", {}, s.plain)),
          h("button", { type: "button", class: "icon-btn tiny quiet", "aria-label": `Edit ${s.name}`, title: "Open in the builder without running", onclick: () => openLibrary(s.id, false) }, icon("sliders")),
        ),
      ),
    );
  }

  function savedMenu(trigger, s) {
    const item = (label, glyph, fn) => h("button", { type: "button", class: "menu-item", onclick: () => (pop.close(), fn()) }, icon(glyph), label);
    const pop = sheetPopover({
      trigger,
      title: s.name,
      cls: "sc-menu",
      body: h(
        "div",
        { class: "menu-list" },
        item("Run now", "play", () => openSaved(s, true)),
        item("Rename", "sliders", () => renameSaved(s)),
        item("Schedule and alerts", "bell", () => saveSheet(s)),
        item("Duplicate", "copy", () => duplicateSaved(s)),
        item("Copy Excel formula", "copy", () => copyText(scanFormula(location.origin, { savedId: s.id }), "Excel formula copied: put your key in a cell named BridgeKey")),
        item("Delete", "close", () => deleteSaved(s)),
      ),
    });
  }

  async function reloadSaved() {
    const r = await optional(api("/v1/scanner/saved", { fresh: true }));
    if (r.data) saved = r.data.data ?? [];
    drawLibrary();
  }

  async function renameSaved(s) {
    const input = h("input", { value: s.name, maxlength: "80", "aria-label": "Name" });
    const v = await modal({ title: "Rename scan", body: h("label", { class: "field" }, "Name", input), buttons: [{ label: "Cancel", value: null }, { label: "Rename", cls: "primary", value: "ok" }] });
    if (v !== "ok" || !input.value.trim()) return;
    const r = await optional(api(`/v1/scanner/saved/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { name: input.value.trim() } }));
    if (r.error) return toast(r.error.message ?? "Could not rename", { tone: "error" });
    if (st.savedId === s.id) {
      st.name = input.value.trim();
      nameInput.value = st.name;
    }
    toast("Renamed");
    reloadSaved();
  }
  async function duplicateSaved(s) {
    const r = await optional(api(`/v1/scanner/saved/${encodeURIComponent(s.id)}/duplicate`, { method: "POST" }));
    if (r.error) return toast(r.error.message ?? "Could not duplicate", { tone: "error" });
    toast(`Saved a copy: ${r.data.data.name}`);
    reloadSaved();
  }
  async function deleteSaved(s) {
    const v = await modal({ title: `Delete ${s.name}?`, body: h("p", {}, "The scan, its schedule and its last results go. Live events rows it made stay."), buttons: [{ label: "Cancel", value: null }, { label: "Delete", cls: "primary", value: "ok" }] });
    if (v !== "ok") return;
    const r = await optional(api(`/v1/scanner/saved/${encodeURIComponent(s.id)}`, { method: "DELETE" }));
    if (r.error) return toast(r.error.message ?? "Could not delete", { tone: "error" });
    if (st.savedId === s.id) st.savedId = null;
    toast("Deleted");
    reloadSaved();
  }

  function openLibrary(id, run) {
    const s = LIBRARY_BY_ID.get(id);
    if (!s) return;
    Object.assign(st, { name: s.name, libraryId: id, savedId: null, interval: "live", mode: "builder", model: clone(s.model), text: s.condition, sort: { by: s.sort, order: s.order } });
    loadEditor();
    if (run) runScan();
  }
  function openSaved(s, run) {
    const req = s.request ?? {};
    Object.assign(st, { name: s.name, libraryId: s.libraryId ?? null, savedId: s.id, universe: req.universe ?? "FNO", interval: req.interval ?? "live", sort: req.sort ?? null, text: req.condition ?? "", model: s.builder ? clone(s.builder) : null, mode: s.builder ? "builder" : "advanced" });
    if (Array.isArray(s.columns) && s.columns.length) prefs.columns = s.columns.filter((c) => COLUMNS.some((x) => x.id === c));
    loadEditor();
    if (run) runScan();
  }

  // ── Builder ──
  const nameInput = h("input", { class: "sc-name", maxlength: "80", placeholder: "Untitled scan", "aria-label": "Scan name" });
  nameInput.addEventListener("input", () => (st.name = nameInput.value));
  const uniSel = h(
    "select",
    { "aria-label": "Universe", class: "sc-uni" },
    [["FNO", "F&O stocks"], ["NIFTY50", "NIFTY 50"]].map(([v, l]) => h("option", { value: v }, l)),
    (unis.data?.data ?? []).filter((u) => !["FNO", "NIFTY50", "INDICES"].includes(u.name)).map((u) => h("option", { value: u.name }, u.name)),
  );
  uniSel.addEventListener("change", () => {
    st.universe = uniSel.value;
    scheduleCount();
  });
  const modeSeg = segmented("Editor", [["builder", "Builder"], ["advanced", "Advanced"]], "builder");
  modeSeg.addEventListener("change", () => switchMode(modeSeg.value));
  const rulesHost = h("div", { class: "sc-rules" });
  const textArea = h("textarea", { class: "sc-text", rows: "3", spellcheck: "false", "aria-label": "Condition" });
  textArea.addEventListener("input", () => {
    st.text = textArea.value;
    scheduleCount();
  });
  const advNote = h("p", { class: "muted small sc-adv-note" });
  // Advanced mode can also scan candles of another interval (no live facts then).
  const barsSel = h("select", { "aria-label": "Bars", class: "sc-bars" }, [["live", "Today, live"], ["1d", "Daily bars"], ["1w", "Weekly bars"], ["60m", "60 min bars"], ["15m", "15 min bars"], ["5m", "5 min bars"]].map(([v, l]) => h("option", { value: v }, l)));
  barsSel.addEventListener("change", () => {
    st.interval = barsSel.value;
    scheduleCount();
  });
  const errHost = h("div", { class: "sc-err", role: "status", "aria-live": "polite" });
  const countHost = h("div", { class: "sc-count", role: "status", "aria-live": "polite" });
  const runBtn = h("button", { type: "button", class: "primary small", onclick: () => runScan() }, icon("play"), "Run scan");
  const saveBtn = h("button", { type: "button", class: "small", onclick: () => saveSheet(null) }, icon("bell"), "Save");

  function currentText() {
    return st.mode === "builder" ? compileModel(st.model).text : st.text.trim();
  }
  function currentRequest() {
    const r = { universe: st.universe, interval: st.mode === "advanced" ? st.interval : "live", condition: currentText() };
    if (st.name.trim()) r.name = st.name.trim().slice(0, 80);
    if (st.sort?.by) r.sort = { by: st.sort.by, order: st.sort.order ?? "desc" };
    return r;
  }

  async function switchMode(mode) {
    if (mode === st.mode) return;
    if (mode === "advanced") {
      st.text = compileModel(st.model).text;
      st.mode = "advanced";
      st.interval = "live";
      return loadEditor();
    }
    const r = await optional(api("/v1/scanner/compile", { method: "POST", body: { condition: textArea.value } }));
    if (r.error) {
      modeSeg.value = "advanced";
      return fill(errHost, h("p", { class: "bad-text" }, r.error.message ?? "The condition does not parse."));
    }
    const d = r.data.data;
    if (!d.model) {
      modeSeg.value = "advanced";
      return fill(errHost, h("p", { class: "warn-text" }, `The builder cannot show this condition: ${d.reason} It still runs; keep editing it as text.`));
    }
    st.model = d.model;
    st.mode = "builder";
    st.interval = "live";
    loadEditor();
  }

  function loadEditor() {
    nameInput.value = st.name;
    uniSel.value = st.universe;
    if (modeSeg.value !== st.mode) modeSeg.value = st.mode;
    fill(errHost);
    if (st.mode === "builder") {
      if (!st.model) st.model = { join: "and", rules: [emptyRule()] };
      drawRules();
      rulesHost.hidden = false;
      textArea.hidden = true;
      advNote.hidden = true;
      barsSel.hidden = true;
    } else {
      textArea.value = st.text;
      barsSel.value = st.interval;
      rulesHost.hidden = true;
      textArea.hidden = false;
      advNote.hidden = false;
      barsSel.hidden = false;
      fill(advNote, "Fields: close, open, high, low, volume, change_pct, gap_pct and every value in the builder (fut_oi_change_pct, iv_rank, pcr …). Functions: sma, ema, rsi, atr, highest, lowest, avg_volume … x[1] is the day before.");
    }
    drawLibrary();
    scheduleCount();
  }

  /** The value picker: a button that opens a searchable list of values. */
  function valuePicker(ref, onPick, label) {
    const btn = h("button", { type: "button", class: "small sc-pick", "aria-haspopup": "dialog", "aria-label": `${label}: ${operandLabel(ref)}` }, h("span", {}, operandLabel(ref)), icon("chevron"));
    btn.addEventListener("click", () => {
      const search = h("input", { type: "search", placeholder: "Search values", "aria-label": "Search values", class: "sc-search" });
      const list = h("div", { class: "sc-pick-list", role: "listbox", "aria-label": "Values" });
      const draw = () => {
        const found = searchOperands(search.value);
        fill(
          list,
          GROUPS.map((g) => {
            const items = found.filter((o) => o.group === g.id);
            if (!items.length) return null;
            return [
              h("div", { class: "sc-pick-group" }, g.label),
              items.map((o) =>
                h(
                  "button",
                  { type: "button", role: "option", class: `sc-pick-item${o.id === ref?.id ? " is-cur" : ""}`, "aria-selected": String(o.id === ref?.id), title: o.doc ?? "", onclick: () => (pop.close(), onPick(o.params.length ? { id: o.id, p: Object.fromEntries(o.params.map((p) => [p.key, ref?.id === o.id ? (ref.p?.[p.key] ?? p.def) : p.def])) } : { id: o.id })) },
                  h("span", {}, o.label.replace("{n}", "n")),
                  h("small", {}, o.doc ?? ""),
                ),
              ),
            ];
          }),
          found.length ? null : h("p", { class: "muted small" }, "No value matches."),
        );
      };
      search.addEventListener("input", draw);
      search.addEventListener("keydown", (e) => {
        if (e.key === "Enter") list.querySelector("button")?.click();
      });
      draw();
      const pop = sheetPopover({ trigger: btn, title: label, cls: "sc-pick-pop", body: h("div", { class: "sc-pick-body" }, search, list) });
      search.focus();
    });
    return btn;
  }

  function paramInputs(ref, onChange, path) {
    const o = ref?.id ? OPERAND_BY_ID.get(ref.id) : null;
    if (!o?.params.length) return null;
    return o.params.map((p) => {
      const input = h("input", { type: "number", inputmode: "numeric", class: "sc-param", min: String(p.min), max: String(p.max), step: "1", value: String(ref.p?.[p.key] ?? p.def), "aria-label": `${operandLabel(ref)}: ${p.label}`, "data-path": `${path}.${p.key}` });
      input.addEventListener("input", () => {
        ref.p = { ...(ref.p ?? {}), [p.key]: input.value === "" ? "" : Number(input.value) };
        onChange(false);
      });
      return h("label", { class: "sc-param-wrap" }, h("span", {}, p.label), input);
    });
  }

  function ruleRow(rule, path, remove) {
    const changed = (redraw = true) => {
      if (redraw) drawRules();
      else validate();
      scheduleCount();
    };
    const left = valuePicker(rule.left, (ref) => {
      rule.left = ref;
      if (isBool(ref.id)) {
        rule.op = rule.op === "no" ? "no" : "yes";
        delete rule.right;
        delete rule.mult;
      } else {
        if (rule.op === "yes" || rule.op === "no") rule.op = "gt";
        rule.right ??= { num: 0 };
      }
      changed();
    }, "Value");
    const parts = [left, paramInputs(rule.left, changed, `${path}.left`)];
    const ops = isBool(rule.left?.id) ? BOOL_OPS.map((o) => [o.id, o.words]) : OPS.map((o) => [o.id, opWords(o.id, rule.left?.id)]);
    const opSel = h("select", { class: "sc-op", "aria-label": "Comparison", "data-path": `${path}.op` }, ops.map(([v, l]) => h("option", { value: v, selected: v === rule.op }, l)));
    opSel.addEventListener("change", () => {
      rule.op = opSel.value;
      changed();
    });
    parts.push(opSel);
    if (!isBool(rule.left?.id)) {
      const kind = rule.right?.num !== undefined ? "num" : "value";
      const kindSel = h("select", { class: "sc-kind", "aria-label": "Compare with" }, h("option", { value: "num", selected: kind === "num" }, "a number"), h("option", { value: "value", selected: kind === "value" }, "a value"));
      kindSel.addEventListener("change", () => {
        rule.right = kindSel.value === "num" ? { num: 0 } : { id: "close" };
        delete rule.mult;
        changed();
      });
      parts.push(kindSel);
      if (kind === "num") {
        const unit = OPERAND_BY_ID.get(rule.left?.id)?.unit;
        const n = h("input", { type: "number", step: "any", inputmode: "decimal", class: "sc-num", value: isFigure(rule.right.num) ? String(rule.right.num) : "", "aria-label": "Number", "data-path": `${path}.right` });
        n.addEventListener("input", () => {
          rule.right = { num: n.value === "" ? "" : Number(n.value) };
          changed(false);
        });
        parts.push(h("span", { class: "sc-num-wrap" }, n, unit === "pct" ? h("span", { class: "sc-unit" }, "%") : unit === "x" ? h("span", { class: "sc-unit" }, "×") : unit === "pts" ? h("span", { class: "sc-unit" }, "pts") : null));
      } else {
        const mult = h("input", { type: "number", step: "any", inputmode: "decimal", class: "sc-mult", value: isFigure(rule.mult) ? String(rule.mult) : "1", "aria-label": "Multiple", title: "Multiple of the value: 2 means twice", "data-path": `${path}.mult` });
        mult.addEventListener("input", () => {
          rule.mult = mult.value === "" ? "" : Number(mult.value);
          if (rule.mult === 1) delete rule.mult;
          changed(false);
        });
        parts.push(h("span", { class: "sc-num-wrap" }, mult, h("span", { class: "sc-unit" }, "×")));
        parts.push(valuePicker(rule.right, (ref) => {
          rule.right = ref;
          changed();
        }, "Compared with"));
        parts.push(paramInputs(rule.right, changed, `${path}.right`));
      }
    }
    parts.push(h("button", { type: "button", class: "icon-btn tiny quiet sc-del", "aria-label": "Remove this rule", onclick: () => (remove(), changed()) }, icon("close")));
    return h("div", { class: "sc-rule", "data-path": path }, parts);
  }

  function joinSeg(obj, label) {
    const seg = segmented(label, [["and", "All of"], ["or", "Any of"]], obj.join === "or" ? "or" : "and");
    seg.classList.add("sc-join");
    seg.addEventListener("change", () => {
      obj.join = seg.value;
      validate();
      scheduleCount();
    });
    return seg;
  }

  function drawRules() {
    const m = st.model;
    const rows = m.rules.map((r, i) => {
      if (Array.isArray(r.rules)) {
        return h(
          "div",
          { class: "sc-group" },
          h("div", { class: "sc-group-head" }, joinSeg(r, "Group match"), h("span", { class: "muted small" }, "these"), h("button", { type: "button", class: "xs quiet", onclick: () => (r.rules.push(emptyRule()), drawRules(), scheduleCount()) }, icon("plus"), "Rule"), h("button", { type: "button", class: "icon-btn tiny quiet", "aria-label": "Remove this group", onclick: () => (m.rules.splice(i, 1), drawRules(), scheduleCount()) }, icon("close"))),
          r.rules.map((x, k) => ruleRow(x, `rules.${i}.rules.${k}`, () => (r.rules.splice(k, 1), r.rules.length || m.rules.splice(i, 1)))),
        );
      }
      return ruleRow(r, `rules.${i}`, () => m.rules.splice(i, 1));
    });
    fill(
      rulesHost,
      h("div", { class: "sc-rules-head" }, h("span", { class: "muted small" }, "Match"), joinSeg(m, "Match"), h("span", { class: "muted small" }, "these rules")),
      rows.length ? rows : h("p", { class: "muted small" }, "No rules yet. Add one to start."),
      h(
        "div",
        { class: "sc-rules-add" },
        h("button", { type: "button", class: "xs", onclick: () => (m.rules.push(emptyRule()), drawRules(), scheduleCount()) }, icon("plus"), "Add rule"),
        h("button", { type: "button", class: "xs quiet", onclick: () => (m.rules.push({ join: m.join === "and" ? "or" : "and", rules: [emptyRule()] }), drawRules(), scheduleCount()) }, icon("plus"), "Add group"),
      ),
    );
    validate();
  }

  /** Mark invalid inputs and say what is wrong. Returns true when the builder compiles. */
  function validate() {
    if (st.mode !== "builder") return true;
    const c = compileModel(st.model);
    for (const el of rulesHost.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    for (const e of c.errors) rulesHost.querySelector(`[data-path="${e.path}"]`)?.setAttribute("aria-invalid", "true");
    fill(errHost, c.errors.length ? h("p", { class: "bad-text" }, c.errors[0].message) : !c.text ? h("p", { class: "muted small" }, "Add a rule to scan.") : h("p", { class: "muted small sc-words" }, describeModel(st.model)));
    runBtn.disabled = Boolean(c.errors.length) || !c.text;
    return !c.errors.length && Boolean(c.text);
  }

  // ── Live count (debounced; the Bridge re-reads the facts the last run collected: no broker call) ──
  let countTimer = null;
  let countSeq = 0;
  function scheduleCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(doCount, COUNT_DEBOUNCE_MS);
  }
  async function doCount() {
    const text = currentText();
    if (!text || (st.mode === "builder" && compileModel(st.model).errors.length)) return fill(countHost);
    if (st.mode === "advanced" && st.interval !== "live") return fill(countHost, h("span", { class: "muted small" }, "Live counts work on today's live scans; run this one to see its matches."));
    const seq = ++countSeq;
    fill(countHost, h("span", { class: "muted small" }, "Counting…"));
    const r = await optional(api("/v1/scanner/count", { method: "POST", body: { universe: st.universe, interval: "live", condition: text } }));
    if (st.mode === "advanced" && st.interval !== "live") return;
    if (seq !== countSeq) return;
    if (r.error) {
      if (st.mode === "advanced") fill(errHost, h("p", { class: "bad-text" }, r.error.message ?? "The condition does not parse."));
      return fill(countHost);
    }
    if (st.mode === "advanced") fill(errHost);
    const c = r.data.data;
    if (!c.evaluated) return fill(countHost, h("span", { class: "muted small" }, "Run the scan once; the count then follows each edit."));
    fill(
      countHost,
      h("strong", { class: "sc-count-n" }, formatInt(c.matched)),
      h("span", { class: "muted small" }, ` of ${formatInt(c.evaluated)} match now`),
      c.sample.length ? h("span", { class: "muted small sc-count-sample" }, ` · ${c.sample.map(ticker).join(", ")}${c.matched > c.sample.length ? " …" : ""}`) : null,
      c.missing?.length ? h("span", { class: "warn-text small" }, ` · Run to load ${c.missing.join(", ")} data`) : null,
    );
  }

  // ── Running ──
  async function runScan() {
    if (st.mode === "builder" && !validate()) return;
    const req = currentRequest();
    if (!req.condition) return;
    st.running = true;
    runBtn.disabled = true;
    fill(resHead, h("span", { class: "muted small" }, "Scanning…"));
    try {
      const path = st.savedId ? `/v1/scanner/saved/${encodeURIComponent(st.savedId)}/run?waitMs=20000` : "/v1/scanner/jobs?waitMs=20000";
      // A saved scan runs its stored request: save the edits first when they differ.
      if (st.savedId) await syncSaved(req);
      let job = (await api(path, { method: "POST", body: st.savedId ? undefined : req })).data.data;
      while (job.status === "queued" || job.status === "running") {
        fill(resHead, h("span", { class: "muted small" }, `Scanning ${formatInt(job.progress?.done ?? 0)} of ${formatInt(job.progress?.total ?? 0)}…`));
        await new Promise((r) => setTimeout(r, 1000));
        job = (await api(`/v1/scanner/jobs/${encodeURIComponent(job.id)}`, { fresh: true })).data.data;
      }
      st.job = job;
      if (job.status !== "completed") toast(job.error?.message ?? `Scan ${job.status}`, { tone: "warn" });
      drawResults();
      if (st.savedId) reloadSaved();
      scheduleCount();
    } catch (err) {
      fill(resHead, h("p", { class: "bad-text" }, err?.message ?? "The scan failed."));
    } finally {
      st.running = false;
      runBtn.disabled = false;
    }
  }

  async function syncSaved(req) {
    const s = saved.find((x) => x.id === st.savedId);
    if (!s || JSON.stringify(s.request) === JSON.stringify({ ...req, source: s.request?.source ?? req.source })) return;
    if (s.request?.condition === req.condition && s.request?.universe === req.universe) return;
    await api(`/v1/scanner/saved/${encodeURIComponent(st.savedId)}`, { method: "PATCH", body: { request: req, builder: st.mode === "builder" ? st.model : null } });
  }

  async function saveSheet(existing) {
    const s = existing ?? saved.find((x) => x.id === st.savedId) ?? null;
    // A library scan saved with changes gets a name of its own ("Gap up (edited)"), never the library's name.
    const lib = !s && st.libraryId ? (LIBRARY_BY_ID.get(st.libraryId) ?? null) : null;
    const req0 = currentRequest();
    const edited = Boolean(lib) && libraryEdited(lib.id, { condition: req0.condition, universe: req0.universe, sort: req0.sort });
    const name = h("input", { id: "sc-save-name", value: s?.name ?? (lib ? savedScanName(st.name, lib.id, edited) : st.name || ""), maxlength: "80", "aria-label": "Name" });
    const initial = s?.atClose ? "close" : s?.everyMinutes ? "every" : "demand";
    const when = segmented("When it runs", [["demand", "On demand"], ["every", "Every N min"], ["close", "At the close"]], initial);
    const every = h("input", { type: "number", inputmode: "numeric", min: "1", max: "1440", step: "1", value: String(s?.everyMinutes ?? 15), "aria-label": "Minutes", class: "sc-every" });
    const everyWrap = h("label", { class: "field sc-every-wrap" }, app.state.demo ? "Every (minutes; demo: also after hours)" : "Every (minutes, in market hours)", every);
    const notify = h("input", { type: "checkbox", checked: s ? s.notify !== false : true });
    const sync = () => (everyWrap.hidden = when.value !== "every");
    when.addEventListener("change", sync);
    sync();
    const asNew = existing === null && Boolean(s);
    const err = h("p", { class: "bad-text", hidden: true });
    const body = h(
      "div",
      { class: "stack sc-save" },
      h("label", { class: "field", for: "sc-save-name" }, "Name", name, edited ? h("span", { class: "hint" }, `Changed from the library's ${lib.name}: save it under a name of its own.`) : null),
      h("div", { class: "field" }, h("span", {}, "When it runs"), when),
      everyWrap,
      h("label", { class: "check" }, notify, h("span", {}, "Also send new matches to my notification channels")),
      h("p", { class: "muted small" }, "Each new match since the last run becomes a Scan hit row in Live events and a toast here."),
      err,
    );
    const buttons = [{ label: "Cancel", value: null }];
    if (asNew) buttons.push({ label: "Save as new", value: "new" });
    // An edited library scan cannot keep the library's name: the sheet stays open and says so under the field.
    const named = (v) => () => (edited && name.value.trim() === lib.name ? fieldError(name, `${lib.name} is the library scan's name. Name your edited copy, for example ${lib.name} (edited).`) : v);
    buttons.push({ label: s ? "Save changes" : "Save", cls: "primary", onClick: named(s ? "update" : "new") });
    const v = await modal({ title: s ? `Save ${s.name}` : edited ? `Save your edited ${lib.name}` : "Save scan", body, buttons });
    if (!v) return;
    const mins = Number(every.value);
    if (when.value === "every" && (!Number.isInteger(mins) || mins < 1 || mins > 1440)) return toast("Minutes: a whole number from 1 to 1440", { tone: "error" });
    const payload = {
      name: name.value.trim() || "Untitled scan",
      request: currentRequest(),
      everyMinutes: when.value === "every" ? mins : null,
      atClose: when.value === "close",
      notify: notify.checked,
      builder: st.mode === "builder" ? st.model : null,
      libraryId: st.libraryId,
      columns: prefs.columns,
    };
    payload.request.name = payload.name;
    const r = v === "update" ? await optional(api(`/v1/scanner/saved/${encodeURIComponent(s.id)}`, { method: "PATCH", body: payload })) : await optional(api("/v1/scanner/saved", { method: "POST", body: payload }));
    if (r.error) return toast(r.error.message ?? "Could not save", { tone: "error" });
    st.savedId = r.data.data.id;
    st.name = r.data.data.name;
    nameInput.value = st.name;
    prefs.group = "saved";
    groupSeg.value = "saved";
    toast(v === "update" ? "Saved" : `Saved: ${st.name}`);
    reloadSaved();
  }

  // ── Results ──
  const resHead = h("div", { class: "sc-res-head" });
  const resTools = h("div", { class: "sc-res-tools" });
  const resBody = h("div", { class: "sc-res-body" });
  const shownCols = () => COLUMNS.filter((c) => prefs.columns.includes(c.id));

  function drawResults() {
    const job = st.job;
    if (!job) {
      fill(resHead, h("span", { class: "muted small" }, "Pick a scan from the library, or build one, and run it."));
      fill(resTools);
      return fill(resBody);
    }
    const all = job.results ?? [];
    const newCount = all.filter((r) => r.isNew).length;
    fill(
      resHead,
      h("strong", { class: "sc-res-n" }, `${formatInt(all.length)} match${all.length === 1 ? "" : "es"}`),
      newCount ? h("span", { class: "pill info" }, `${formatInt(newCount)} new since last run`) : job.firstRun ? h("span", { class: "muted small" }, "First run: later runs mark new symbols") : null,
      h("span", { class: "muted small sc-runline" }, runLine(job.stats)),
      job.errors?.length ? h("span", { class: "warn-text small" }, `${formatInt(job.errors.length)} symbol${job.errors.length === 1 ? "" : "s"} skipped`) : null,
    );
    drawTools(all);
    drawTable(all);
  }

  function drawTools(all) {
    const sectors = [...new Set(all.map((r) => r.facts?.sector).filter(Boolean))].sort();
    const secSel = h("select", { "aria-label": "Sector", class: "sc-filter" }, h("option", { value: "" }, "All sectors"), sectors.map((s) => h("option", { value: s, selected: s === prefs.sector }, s)));
    secSel.addEventListener("change", () => {
      prefs.sector = secSel.value;
      savePrefs();
      drawTable(all);
    });
    const indexSel = h("select", { "aria-label": "Index", class: "sc-filter" }, h("option", { value: "" }, "Any index"), ["NIFTY 50", "NIFTY BANK", "NIFTY IT"].map((s) => h("option", { value: s, selected: s === prefs.index }, s)));
    indexSel.addEventListener("change", () => {
      prefs.index = indexSel.value;
      savePrefs();
      drawTable(all);
    });
    const fno = h("button", { type: "button", class: "chip-btn", "aria-pressed": String(prefs.fnoOnly), onclick: () => ((prefs.fnoOnly = !prefs.fnoOnly), fno.setAttribute("aria-pressed", String(prefs.fnoOnly)), savePrefs(), drawTable(all)) }, "F&O only");
    const colsBtn = h("button", { type: "button", class: "small quiet", "aria-haspopup": "dialog" }, icon("columns"), "Columns");
    colsBtn.addEventListener("click", () => {
      const list = h(
        "div",
        { class: "sc-cols" },
        COLUMNS.map((c) => {
          const box = h("input", { type: "checkbox", checked: prefs.columns.includes(c.id) });
          box.addEventListener("change", () => {
            prefs.columns = COLUMNS.filter((x) => (x.id === c.id ? box.checked : prefs.columns.includes(x.id))).map((x) => x.id);
            savePrefs();
            drawTable(all);
          });
          return h("label", { class: "check" }, box, h("span", {}, c.label));
        }),
      );
      sheetPopover({ trigger: colsBtn, title: "Columns", body: list, cls: "sc-cols-pop" });
    });
    const exportBtn = h("button", { type: "button", class: "small quiet", "aria-haspopup": "dialog" }, icon("download"), "Export");
    exportBtn.addEventListener("click", () => exportSheet(exportBtn, all));
    fill(resTools, secSel, indexSel, fno, h("span", { class: "sc-tools-gap" }), colsBtn, exportBtn);
  }

  function exportSheet(trigger, all) {
    const req = st.job?.request ?? currentRequest();
    const rows = filterRows(all, prefs);
    const csvBtn = h("button", { type: "button", class: "small", onclick: () => download(`scan-${(st.name || "results").replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase()}.csv`, resultsCsv(sortRows(rows, prefs.sort?.col ?? "symbol", prefs.sort?.dir ?? 1), shownCols())) }, icon("download"), "Download CSV");
    const url = `${location.origin}${scanUrl(req, "json")}`;
    const curl = `curl -H "Authorization: Bearer $KEY" "${url}"`;
    const body = h(
      "div",
      { class: "stack sc-export" },
      h("div", { class: "row" }, csvBtn, h("span", { class: "muted small" }, `${formatInt(rows.length)} rows, the columns shown`)),
      h("div", { class: "field" }, h("span", {}, "Excel formula (the matched tickers, one per cell)"), h("code", { class: "sc-code" }, scanFormula(location.origin, { savedId: st.savedId, request: req })), copyButton(() => scanFormula(location.origin, { savedId: st.savedId, request: req }), { label: "Copy formula", toastLabel: "Excel formula copied: put your key in a cell named BridgeKey" })),
      h("div", { class: "field" }, h("span", {}, "API URL (runs the same scan; csv or text with format=)"), h("code", { class: "sc-code" }, url), copyButton(() => curl, { label: "Copy curl", toastLabel: "curl command copied" })),
    );
    sheetPopover({ trigger, title: "Export", body, cls: "sc-export-pop" });
  }

  function download(name, text) {
    const href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = h("a", { href, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function drawTable(all) {
    const rows0 = filterRows(all, prefs);
    const sort = prefs.sort ?? { col: st.sort?.by && COLUMNS.some((c) => c.id === st.sort.by) ? st.sort.by : "symbol", dir: st.sort?.order === "asc" ? 1 : -1 };
    const rows = prefs.sort ? sortRows(rows0, sort.col, sort.dir) : rows0;
    const cols = shownCols();
    const sortBtn = (id, label) => {
      const on = (prefs.sort?.col ?? null) === id;
      return h(
        "button",
        { type: "button", class: "sc-th", "aria-label": `Sort by ${label}`, onclick: () => {
          prefs.sort = { col: id, dir: on ? -prefs.sort.dir : id === "symbol" || id === "sector" ? 1 : -1 };
          savePrefs();
          drawTable(all);
        } },
        label,
        on ? h("span", { class: "sc-sort", "aria-hidden": "true" }, prefs.sort.dir > 0 ? "▲" : "▼") : null,
      );
    };
    if (!rows.length) {
      return fill(resBody, emptyState("scan", all.length ? "No rows after the filters" : "Nothing matched", all.length ? "Clear the sector, index or F&O filter." : "No symbol meets the condition right now. Scheduled runs check again.", null, { compact: true }));
    }
    const table = h(
      "table",
      { class: "sc-table" },
      h("caption", { class: "sr-only" }, "Scan results"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", "aria-sort": prefs.sort?.col === "symbol" ? (prefs.sort.dir > 0 ? "ascending" : "descending") : "none" }, sortBtn("symbol", "Symbol")), cols.map((c) => h("th", { scope: "col", class: c.unit === "text" ? "" : "num", "aria-sort": prefs.sort?.col === c.id ? (prefs.sort.dir > 0 ? "ascending" : "descending") : "none" }, sortBtn(c.id, c.label))))),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            { tabindex: "0", class: r.isNew ? "is-new" : undefined, onclick: () => openSheet(r), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openSheet(r)) },
            h("td", { class: "lead" }, h("span", { class: "sc-sym" }, ticker(r.symbol)), r.isNew ? h("span", { class: "pill info sc-new" }, "New") : null),
            cols.map((c) => h("td", { class: `${c.unit === "text" ? "sc-text-cell" : "num"}${c.id === "change_pct" && isFigure(r.facts?.change_pct) ? (r.facts.change_pct >= 0 ? " up" : " down") : ""}` }, c.id === "sector" ? (r.facts?.sector ?? DASH) : c.id === "change_pct" ? (isFigure(r.facts?.change_pct) ? `${formatSigned(r.facts.change_pct, 2)}%` : DASH) : factText(r.facts?.[c.id], SIGNED_COLS.has(c.id) ? "spct" : c.unit))),
          ),
        ),
      ),
    );
    fill(resBody, h("div", { class: "table-wrap scroll-x sc-table-wrap" }, table), rows.length <= SUMMARY_MAX ? matchSummary(rows) : null);
  }

  /**
   * A short match list (up to SUMMARY_MAX rows) also reads as two small charts under the table: the matches by sector
   * and each match's % change on the day, so the card's spare height says something.
   */
  function matchSummary(rows) {
    const bySector = new Map();
    for (const r of rows) {
      const s = r.facts?.sector || "Other";
      bySector.set(s, (bySector.get(s) ?? 0) + 1);
    }
    const sectors = [...bySector].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = sectors[0]?.[1] ?? 1;
    const chg = rows.filter((r) => isFigure(r.facts?.change_pct)).map((r) => ({ sym: r.symbol, v: r.facts.change_pct })).sort((a, b) => b.v - a.v);
    const big = Math.max(0.01, ...chg.map((c) => Math.abs(c.v)));
    // The fill's length goes through the CSSOM (setBar), never a style attribute (the page's CSP is self-only).
    const bar = (v, cls) => h("span", { class: `sc-sum-trk${cls ? ` ${cls}` : ""}` }, setBar(h("i"), v, 1));
    return h(
      "div",
      { class: "sc-sum" },
      h(
        "section",
        { class: "sc-sum-part", "aria-label": "Matches by sector" },
        h("h3", { class: "sc-sum-h" }, "By sector", h("small", {}, `${formatInt(rows.length)} matches · ${formatInt(sectors.length)} sectors`)),
        h("ul", { class: "sc-sum-list" }, sectors.map(([s, n]) => h("li", {}, h("span", { class: "sc-sum-k" }, s), bar(n / top), h("span", { class: "sc-sum-v" }, formatInt(n))))),
      ),
      chg.length
        ? h(
            "section",
            { class: "sc-sum-part", "aria-label": "Change on the day" },
            h("h3", { class: "sc-sum-h" }, "% change today", h("small", {}, "Each match, largest first")),
            h("ul", { class: "sc-sum-list sc-sum-chg" }, chg.map((c) => h("li", {}, h("span", { class: "sc-sum-k" }, ticker(c.sym)), bar(Math.abs(c.v) / big, c.v >= 0 ? "up" : "down"), h("span", { class: `sc-sum-v ${c.v >= 0 ? "up" : "down"}` }, `${formatSigned(c.v, 2)}%`)))),
          )
        : null,
    );
  }

  // ── Side sheet ──
  const readDesk = () => readJson(DESK_SLOT, {});
  function openSheet(r) {
    const f = r.facts ?? {};
    const u = ticker(r.symbol);
    const kv = (label, value, cls = "") => h("div", { class: `sc-kv ${cls}`.trim() }, h("span", {}, label), h("strong", {}, value));
    const strike = (k) => (isFigure(k) ? formatNumber(k, { maximumFractionDigits: 2 }) : DASH);
    const groups = [
      ["Price", [kv("LTP", factText(f.ltp, "price")), kv("Change", isFigure(f.change_pct) ? `${formatSigned(f.change_pct, 2)}%` : DASH, isFigure(f.change_pct) ? (f.change_pct >= 0 ? "up" : "down") : ""), kv("Gap", factText(f.gap_pct, "pct")), kv("Day range", `${factText(f.day_low, "price")} to ${factText(f.day_high, "price")}`), kv("Previous day", `${factText(f.prev_low, "price")} to ${factText(f.prev_high, "price")}`), kv("52 weeks", `${factText(f.low_52w, "price")} to ${factText(f.high_52w, "price")}`), kv("Volume pace", factText(f.vol_pace, "x")), kv("Circuits", `${factText(f.lower_circuit, "price")} to ${factText(f.upper_circuit, "price")}`)]],
      ["Futures", [kv("Future", factText(f.fut_ltp, "price")), kv("OI change", factText(f.fut_oi_change_pct, "pct")), kv("Basis", `${factText(f.basis, "price")} (${factText(f.basis_pct, "pct")})`), kv("Annualised", factText(f.basis_ann_pct, "pct")), kv("Rollover", factText(f.rollover_pct, "pct")), kv("MWPL used", `${factText(f.mwpl_pct, "pct")}${f.in_ban === 1 ? " · in ban" : ""}`)]],
      ["Options", [kv("PCR", factText(f.pcr, "ratio")), kv("ATM IV", factText(f.atm_iv, "pct")), kv("IV rank", `${factText(f.iv_rank, "rank")}${f.iv_days ? ` (${formatInt(f.iv_days)} days)` : ""}`), kv("IV percentile", factText(f.iv_percentile, "rank")), kv("HV 20", factText(f.hv20, "pct")), kv("Max pain", `${strike(f.max_pain)} (${factText(f.max_pain_dist_pct, "pct")})`), kv("Straddle", `${factText(f.straddle, "price")} · move ${factText(f.expected_move_pct, "pct")}`), kv("Walls", `put ${strike(f.put_wall)} · call ${strike(f.call_wall)}`), kv("Largest OI change", isFigure(f.top_oi_chg_strike) ? `${strike(f.top_oi_chg_strike)} ${f.top_oi_chg_right ?? ""} ${factText(f.top_oi_chg_pct, "pct")}` : DASH), kv("Volume ÷ OI", isFigure(f.max_vol_oi_strike) ? `${strike(f.max_vol_oi_strike)} ${f.max_vol_oi_right ?? ""} ${factText(f.max_vol_oi, "x")}` : DASH)]],
    ];
    const expiry = f.chain_expiry ?? f.fut_expiry ?? null;
    const focusStrike = isFigure(f.top_oi_chg_strike) && st.libraryId === "oi-change-strike" ? f.top_oi_chg_strike : isFigure(f.max_vol_oi_strike) && st.libraryId === "unusual-option-volume" ? f.max_vol_oi_strike : f.atm_strike;
    const focusSide = focusStrike === f.top_oi_chg_strike ? f.top_oi_chg_right : focusStrike === f.max_vol_oi_strike ? f.max_vol_oi_right : "CE";
    const toChain = () => {
      writeJson(DESK_SLOT, handoffPrefs(readDesk(), { underlying: u, expiry, focus: isFigure(focusStrike) ? { strike: focusStrike, side: focusSide === "PE" ? "pe" : "ce" } : null }));
      document.querySelector("#dialog .sheet-close")?.click();
      location.hash = "#/chain";
    };
    const toStrategy = () => {
      if (!isFigure(f.atm_strike) || !expiry) return toast("No option chain for this symbol yet", { tone: "warn" });
      writeJson(DESK_SLOT, handoffPrefs(readDesk(), { underlying: u, expiry, legs: [{ right: "CE", strike: f.atm_strike, side: "BUY", lots: 1 }, { right: "PE", strike: f.atm_strike, side: "BUY", lots: 1 }] }));
      toast(`ATM ${formatNumber(f.atm_strike)} straddle added to Strategy Builder`);
      document.querySelector("#dialog .sheet-close")?.click();
      location.hash = "#/strategy";
    };
    const body = h(
      "div",
      { class: "sc-sheet" },
      h("p", { class: "muted small" }, [f.sector, (f.indices ?? []).join(", "), r.isNew ? "new since the last run" : null].filter(Boolean).join(" · ") || DASH),
      groups.map(([title, items]) => h("section", { class: "sc-sheet-sec" }, h("h3", {}, title), h("div", { class: "sc-kvs" }, items))),
      h(
        "div",
        { class: "sc-sheet-acts" },
        h("button", { type: "button", class: "small", onclick: toChain }, icon("chart"), isFigure(focusStrike) ? `Option Chain at ${formatNumber(focusStrike)}` : "Option Chain"),
        h("button", { type: "button", class: "small", onclick: toStrategy }, icon("strategy"), "Strategy Builder at ATM"),
        h("button", { type: "button", class: "small quiet", onclick: () => addToWatchlist(r.symbol) }, icon("plus"), "Watchlist"),
        copyButton(() => excelFormula(location.origin, r.symbol), { label: "Excel LTP", toastLabel: "Excel formula copied: put your key in a cell named BridgeKey", cls: "small quiet" }),
      ),
    );
    modal({ title: u, body, buttons: [] });
  }

  /** The watchlist hook: the Live events watchlist (the one list the Bridge keeps today). */
  async function addToWatchlist(symbol) {
    const r = await optional(api("/v1/events/selection"));
    const sel = r.data?.data;
    if (!sel) return toast(r.error?.message ?? "Could not read the watchlist.", { tone: "error" });
    if ((sel.watchlist ?? []).includes(symbol)) return toast("Already on the watchlist");
    const w = await optional(api("/v1/events/selection", { method: "PUT", body: { ...sel, watchlist: [...(sel.watchlist ?? []), symbol], universes: sel.universes.includes("WATCHLIST") ? sel.universes : [...sel.universes, "WATCHLIST"] } }));
    if (w.error) return toast(w.error.message ?? "Could not add", { tone: "error" });
    toast(`${ticker(symbol)} added to the watchlist`);
  }

  // ── Layout ──
  const libCard = card({ glyph: "list", tint: "mint", title: "Scans", sub: "One click runs a scan; the slider icon opens it in the builder.", body: h("div", { class: "stack sc-lib" }, groupSeg, libHost) });
  const builderCard = card({
    glyph: "sliders",
    tint: "blue",
    title: "Builder",
    actions: modeSeg,
    body: h(
      "div",
      { class: "stack sc-builder" },
      h("div", { class: "sc-builder-top" }, nameInput, uniSel, barsSel),
      rulesHost,
      textArea,
      advNote,
      errHost,
      h("div", { class: "sc-builder-foot" }, countHost, h("div", { class: "sc-builder-acts" }, saveBtn, runBtn)),
    ),
  });
  const resultsCard = card({ glyph: "scan", tint: "mint", title: "Results", cls: "sc-results", body: h("div", { class: "sc-res" }, resHead, resTools, resBody), flush: true });


  loadEditor();
  drawResults();
  // Open with the first library scan's results, so the page is never empty.
  queueMicrotask(() => openLibrary(LIBRARY[0].id, true));
  return [h("div", { class: "sc-page" }, h("div", { class: "sc-side-col" }, libCard), h("div", { class: "sc-main-col" }, builderCard, resultsCard))];
}
