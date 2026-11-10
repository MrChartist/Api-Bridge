// Data page: Downloads, Recordings (with auto-record rules), Datasets and Collections, plus the "Saving API calls" card.
// Loaded when the page is opened (views.js). The words and numbers come from data-core.js (pure, tested); this file
// draws them. Live parts (job progress, recording stats, the saved-calls number) are patched in place every few seconds:
// a card keeps its DOM node for as long as its job exists, so a focused button, an open file list or a half-typed
// field never loses its place.

import { alertBox, api, app, copyButton, currentKey, emptyState, friendlyError, h, icon, iconTile, ICONS, modal, optional, toast } from "./app.js";
import { countTo, patchList, setAttr, setClass, setText } from "./motion.js";
import { createPoller } from "./sources-ui.js";
import {
  CLASS_GUIDE,
  DEFAULT_INTERVALS,
  DEFAULT_RANGE,
  DEFAULT_SHARE,
  FORMATS,
  INTERVALS,
  LAYOUTS,
  MAX_SYMBOLS,
  RANGES,
  ZIP_MAX_BYTES,
  zipName,
  rangeLimitNote,
  RECORD_PRESETS,
  COMMON_UNDERLYINGS,
  EXPIRY_CHOICES,
  agoText,
  autoRecordSummary,
  buildUniverse,
  classInfo,
  collectionNameProblem,
  collectionToCsv,
  collectionToJson,
  collectionView,
  createDataClient,
  datasetView,
  defaultUniverse,
  dayText,
  diskView,
  estimateJob,
  estimateLines,
  estimateRecording,
  estimateWarning,
  filterItems,
  formatBytes,
  folderPath,
  formatCount,
  isUnavailable,
  jobView,
  needsLogin,
  noLogin,
  parseCollectionImport,
  parseSymbolList,
  parseTags,
  presetPlan,
  recordingBody,
  rangeDates,
  recordingProblem,
  recordingView,
  resolveModel,
  ruleSentence,
  ruleStatus,
  savedSummary,
  scheduleText,
  sharePercent,
  shareSentence,
  slug,
  staleAtmNotice,
  sortJobs,
  symbolLabel,
  tagCounts,
  universeProblem,
  universeSentence,
  universeSize,
  usageOf,
  usageText,
} from "./data-core.js";
import { DASH, formatInt, plural } from "./format.js";

// Icons used only here.
Object.assign(ICONS, {
  record: '<circle cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="3.4"/>',
  dataset: '<ellipse cx="12" cy="6.5" rx="7.5" ry="2.8"/><path d="M4.5 6.5v5.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6.5"/><path d="M4.5 12v5.5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V12"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
  tag: '<path d="M3.8 12.4V5.8a2 2 0 0 1 2-2h6.6l8 8a2 2 0 0 1 0 2.8l-5.8 5.8a2 2 0 0 1-2.8 0z"/><path d="M8.2 8.2h.01" stroke-width="2.6"/>',
  upload: '<path d="M12 15.5v-11M7.5 9 12 4.5 16.5 9M5 19.5h14"/>',
  pause: '<path d="M9 6v12M15 6v12" stroke-width="2.6"/>',
  pencil: '<path d="M4.5 19.5 5.6 15 16.4 4.2a1.9 1.9 0 0 1 2.7 0l.7.7a1.9 1.9 0 0 1 0 2.7L9 18.4z"/><path d="m14.5 6.2 3.3 3.3"/>',
});

/** Handed over by views.js (it owns the segmented control, so this page does not import views.js). */
let segmented = null;
export function configureData(deps) {
  segmented = deps.segmented ?? segmented;
}

const go = (hash) => {
  location.hash = hash;
};
/** The dashboard's api() as a plain call for the client: the parsed body of the answer, a failed answer thrown. */
const client = createDataClient(async (method, path, body) => (await api(path, { method, body, fresh: true })).data);
const POLL_MS = 2500;
const IDLE_REFRESH_MS = 12_000;

// ── Small pieces ──

const btn = (label, cls, onclick, ic = null, attrs = {}) => h("button", { type: "button", class: cls, onclick, ...attrs }, ic ? icon(ic) : null, label);
const iconBtn = (name, label, onclick, cls = "icon-btn") => h("button", { type: "button", class: cls, "aria-label": label, "data-tip": label, onclick }, icon(name));
const toneOf = (t) => (t === "ok" || t === "bad" || t === "warn" || t === "info" ? t : "");
/** A status pill that is patched in place. */
function statePill() {
  const dot = h("span", { class: "pdot", "aria-hidden": "true" });
  const text = h("span", {});
  const el = h("span", { class: "pill", "data-gloss": "" }, dot, text);
  return {
    el,
    set(tone, word) {
      el.className = `pill ${toneOf(tone)}`.trim();
      setText(text, word);
      dot.hidden = !(tone === "ok" || tone === "bad" || tone === "warn");
    },
  };
}
/** A data-class pill: Real-time, Delayed 15 min, End of day. */
function classPill(cls) {
  const p = statePill();
  p.set(cls.tone, cls.label);
  p.el.title = cls.note;
  p.el.classList.add("dt-class");
  return p;
}
function busy(button, on) {
  if (!button) return;
  setAttr(button, "aria-busy", on ? "true" : null);
  button.disabled = Boolean(on);
}
/** An error box next to the buttons of a sheet: filled, scrolled into view and focused so nobody presses the button blind. */
function showFormError(box, title, detail = "") {
  box.replaceChildren(h("div", { class: "alert bad", role: "alert", tabindex: "-1" }, icon("warn"), h("div", {}, h("strong", {}, title), detail ? h("span", { class: "detail" }, detail) : null)));
  const a = box.firstElementChild;
  a.scrollIntoView?.({ block: "nearest" });
  a.focus?.({ preventScroll: true });
}
/** Run a button's action: show it working, then a toast on failure. Returns the result or undefined on failure. */
async function run(button, fn, { ok = null } = {}) {
  busy(button, true);
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r ?? true;
  } catch (e) {
    const f = friendlyError(e);
    toast(`${f.title}. ${f.detail}`.trim(), { tone: "error" });
    return undefined;
  } finally {
    busy(button, false);
  }
}
async function confirmSheet({ title, text, confirm, destructive = true }) {
  return modal({
    title,
    body: h("p", { class: "dt-confirm" }, text),
    buttons: [
      { label: "Keep it", value: false },
      { label: confirm, cls: destructive ? "destructive" : "primary", value: true },
    ],
  });
}
/** replaceChildren that leaves out null, false and empty text (the DOM would print them as words). */
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false && x !== ""));
const hint = (text, cls = "") => h("p", { class: `hint ${cls}`.trim() }, text);
const field = (label, control, help) => h("label", { class: "field" }, h("span", {}, label), control, help ? h("span", { class: "hint" }, help) : null);
const input = (attrs) => h("input", { autocomplete: "off", spellcheck: "false", ...attrs });
const select = (items, value, attrs = {}) => {
  const s = h("select", attrs, items.map(([v, t]) => h("option", { value: v }, t)));
  s.value = value;
  return s;
};
const chip = (text) => h("span", { class: "chip", "data-gloss": "" }, text);
const chipsOf = (tags) => (tags?.length ? h("span", { class: "chips" }, tags.map(chip)) : null);
const seg = (label, options, value) => segmented(label, options, value);
/** One-of-many choices as wrapping chips (long labels never squeeze): `.value` and a change event, like a select. */
function radioChips(label, options, initial) {
  let value = initial;
  const el = h("div", { class: "chips dt-radio", role: "radiogroup", "aria-label": label });
  const buttons = options.map(([v, t]) => h("button", { type: "button", class: "chip-btn", role: "radio", "data-value": v, onclick: () => pick(v, true) }, t));
  const pick = (v, fire) => {
    value = v;
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("aria-pressed", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (fire) el.dispatchEvent(new Event("change"));
  };
  el.addEventListener("keydown", (e) => {
    const i = buttons.findIndex((b) => b.dataset.value === value);
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const b = buttons[(i + d + buttons.length) % buttons.length];
    pick(b.dataset.value, true);
    b.focus();
  });
  el.append(...buttons);
  Object.defineProperty(el, "value", { get: () => value, set: (v) => pick(String(v), false) });
  pick(initial, false);
  return el;
}

/** Download a file the Bridge streams (it needs the key, so a plain link would not work): fetched, then saved. */
async function saveFile(path, name) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${currentKey()}`, "X-MCB-Client": "dashboard" } });
  if (!res.ok) throw Object.assign(new Error(`The Bridge answered ${res.status}.`), { status: res.status });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}
function saveText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

/** A first read of a list: its data, or why there is none. `unavailable` = this Bridge has no such route yet. */
async function load(fn) {
  const r = await optional(fn());
  if (r.error) return { error: r.error, unavailable: isUnavailable(r.error), data: [], meta: {} };
  return { data: Array.isArray(r.data) ? r.data : (r.data ?? []), meta: r.meta ?? {} };
}
const notThere = (what) => emptyState("inbox", `${what} are not in this Bridge yet`, "Update the Bridge to the latest version and they appear here.", null);
const problem = (res, retry) => h("div", { class: "dt-problem" }, alertBox(res.error), btn("Try again", "small tinted", retry, "refresh"));

/** The two banners every tab can show: no login, and the disk getting full. */
function banners({ login, disk, diskWhat = "downloads and recordings" }) {
  const out = [];
  if (login) {
    out.push(
      h(
        "div",
        { class: "alert info dt-banner", role: "status" },
        icon("info"),
        h("div", {}, h("strong", {}, "No broker is logged in"), h("span", { class: "detail" }, "Downloads and recordings need prices from your broker. Log in once and they carry on by themselves."), h("div", { class: "alert-actions" }, btn("Log in on Accounts", "small tinted", () => go("#/accounts")))),
      ),
    );
  }
  const d = diskView(disk);
  if (d?.low) {
    out.push(h("div", { class: "alert warn dt-banner", role: "status" }, icon("warn"), h("div", {}, h("strong", {}, "The disk is nearly full"), h("span", { class: "detail" }, `${d.text ? `${d.text}. ` : ""}The Bridge stops writing ${diskWhat} before the disk fills up. Delete what you no longer need, or raise the limit in the configuration.`))));
  }
  return out;
}

// ── Saving API calls ──

/**
 * The "Saving API calls" card: how many broker calls were avoided today, and the share of the spare broker room that
 * background work (downloads, recordings) may use. `refresh()` re-reads it; it patches in place.
 */
function savingCard() {
  const num = h("strong", { class: "dt-big mc-count" }, "0");
  const lead = h("p", { class: "dt-saved-lead" }, "calls saved today");
  const parts = h("ul", { class: "dt-parts" });
  const percentText = h("output", { class: "dt-share-num" }, `${Math.round(DEFAULT_SHARE * 100)}%`);
  const range = h("input", { type: "range", min: 5, max: 100, step: 5, value: Math.round(DEFAULT_SHARE * 100), id: "dt-share", class: "dt-range", "aria-describedby": "dt-share-text" });
  const shareText = h("p", { class: "hint", id: "dt-share-text" }, shareSentence(Math.round(DEFAULT_SHARE * 100)));
  const after = h("input", { type: "checkbox", id: "dt-after" });
  const afterRow = h("label", { class: "check dt-after" }, after, "Only download after market hours");
  const note = h("p", { class: "hint dt-share-note", hidden: true }, "Setting the share needs a newer Bridge.");
  let settings = { downloads: null, recorder: null };
  let timer = null;
  const paintShare = (p) => {
    percentText.textContent = `${p}%`;
    range.style.setProperty("--p", `${((p - 5) / 95) * 100}%`);
    setText(shareText, shareSentence(p));
    range.setAttribute("aria-valuetext", `${p} percent of the spare room`);
  };
  range.addEventListener("input", () => {
    paintShare(Number(range.value));
    clearTimeout(timer);
    timer = setTimeout(save, 450);
  });
  async function save() {
    const share = Number(range.value) / 100;
    const results = await Promise.allSettled([client.downloads.setSettings({ maxBudgetShare: share }), client.recordings.setSettings({ maxBudgetShare: share })]);
    if (results.every((r) => r.status === "fulfilled")) toast(`Saved. Background work may use up to ${Math.round(share * 100)}% of the spare room.`);
    else if (results.every((r) => r.status === "rejected" && isUnavailable(r.reason))) toast("This Bridge cannot change the share yet.", { tone: "info" });
    else toast("Could not save the share. Try again.", { tone: "error" });
  }
  after.addEventListener("change", async () => {
    try {
      await client.downloads.setSettings({ afterHoursOnly: after.checked });
      toast(after.checked ? "Downloads now wait for after market hours." : "Downloads may run any time again.");
    } catch (e) {
      after.checked = !after.checked;
      toast(isUnavailable(e) ? "This Bridge cannot change that yet." : friendlyError(e).title, { tone: isUnavailable(e) ? "info" : "error" });
    }
  });
  const el = h(
    "section",
    { class: "card dt-saving", "aria-labelledby": "dt-saving-h" },
    h("header", { class: "card-head" }, iconTile("bolt", "teal"), h("div", { class: "card-titles" }, h("h2", { id: "dt-saving-h" }, "Saving API calls"), h("p", {}, "Data you already have is never asked for twice, and background work stays out of the way of live use."))),
    h(
      "div",
      { class: "card-body dt-saving-body" },
      h("div", { class: "dt-saved" }, h("div", { class: "dt-saved-row", "aria-live": "polite" }, num, lead), parts),
      h(
        "div",
        { class: "dt-share" },
        h("div", { class: "dt-share-head" }, h("label", { for: "dt-share" }, "Share of spare room for background work"), percentText),
        range,
        shareText,
        afterRow,
        note,
      ),
    ),
  );
  paintShare(Math.round(DEFAULT_SHARE * 100));
  return {
    el,
    async refresh() {
      const [usage, dl, rc] = await Promise.all([optional(client.usage()), optional(client.downloads.settings()), optional(client.recordings.settings())]);
      if (!usage.error) {
        const s = savedSummary(usage.data?.savings);
        countTo(num, s.total, { format: formatInt, animate: true });
        setText(lead, s.total === 1 ? "call saved today" : "calls saved today");
        const shown = s.parts.length ? s.parts : [["Nothing saved yet today", null]];
        patchList(parts, shown, ([label]) => label, ([label, n], had) => {
          const li = had ?? h("li", {}, h("span", { class: "dt-part-name" }), h("span", { class: "dt-part-n" }));
          setText(li.firstChild, label);
          setText(li.lastChild, n === null ? "" : formatInt(n));
          return li;
        }, { animate: false });
      }
      settings = { downloads: dl.error ? null : dl.data, recorder: rc.error ? null : rc.data };
      const have = settings.downloads ?? settings.recorder;
      note.hidden = Boolean(have);
      range.disabled = !have;
      after.disabled = !settings.downloads;
      afterRow.hidden = !settings.downloads;
      if (have && document.activeElement !== range) {
        const p = sharePercent(have.maxBudgetShare);
        range.value = String(p);
        paintShare(p);
      }
      if (settings.downloads && document.activeElement !== after) after.checked = settings.downloads.afterHoursOnly === true;
    },
    share: () => Number(range.value) / 100,
  };
}

// ── Job and recording cards (kept for as long as the job exists; refreshed in place) ──

function actionsRow() {
  return h("div", { class: "dt-actions" });
}
/** Replace a card's buttons only when the set of buttons changed (so a focused button stays focused). */
function setActions(row, sig, build) {
  if (row.dataset.sig === sig) return;
  const had = row.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  row.dataset.sig = sig;
  row.replaceChildren(...build());
  if (had) row.querySelector(`[data-act="${had}"]`)?.focus({ preventScroll: true });
}
const act = (name, button) => {
  button.dataset.act = name;
  return button;
};

function whyBlock() {
  const title = h("strong", {});
  const text = h("span", { class: "detail" });
  const fix = h("div", { class: "alert-actions" });
  const el = h("div", { class: "alert warn dt-why", role: "status", hidden: true }, icon("warn"), h("div", {}, title, text, fix));
  return {
    el,
    set(why, onRetry) {
      el.hidden = !why;
      if (!why) return;
      setText(title, why.title);
      setText(text, why.fix);
      const sig = `${why.route ?? ""}|${onRetry ? 1 : 0}`;
      if (fix.dataset.sig !== sig) {
        fix.dataset.sig = sig;
        fix.replaceChildren(...[why.route ? btn(why.route === "accounts" ? "Log in on Accounts" : why.route === "safety" ? "Open Safety" : "Open", "small tinted", () => go(`#/${why.route}`)) : null].filter(Boolean));
      }
    },
  };
}

/** A download job card. `ops` = { pause, resume, cancel, retry, files, remove } (each takes the job). */
function makeJobCard(ops) {
  const title = h("h3", { class: "dt-job-title", "data-gloss": "" });
  const sub = h("p", { class: "dt-job-sub" });
  const state = statePill();
  const fill = h("span", {});
  const bar = h("div", { class: "bar dt-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const line = h("p", { class: "dt-line" });
  const now = h("p", { class: "dt-now" });
  const why = whyBlock();
  const failedBox = h("details", { class: "dt-failed", hidden: true }, h("summary", {}, "Items that failed"), h("ul", {}));
  const row = actionsRow();
  const clsSlot = h("span", { class: "dt-clsslot" });
  const el = h("article", { class: "card dt-job" }, h("div", { class: "dt-job-head" }, h("div", { class: "dt-job-titles" }, title, sub), state.el), bar, line, now, why.el, failedBox, h("div", { class: "dt-job-foot" }, clsSlot, row));
  el._p = { title, sub, state, fill, bar, line, now, why, failedBox, row, clsSlot, cls: "" };
  return el;
}
function paintJob(el, job, ops, nowMs) {
  const p = el._p;
  el._job = job;
  const v = jobView(job, nowMs);
  el.dataset.status = v.status ?? "";
  setText(p.title, v.title);
  const bits = [v.whenText, v.dataset ? `Dataset ${v.dataset}` : ""].filter(Boolean);
  setText(p.sub, bits.join(" · "));
  p.state.set(v.tone, v.word);
  const showBar = v.status === "running" || v.status === "queued" || v.status === "paused";
  p.bar.hidden = !showBar;
  p.fill.style.width = `${v.percent}%`;
  setAttr(p.bar, "aria-valuenow", v.percent);
  setAttr(p.bar, "aria-label", `${v.title}: ${v.percent} percent`);
  setClass(p.bar, "ok", v.status === "done");
  setText(p.line, v.summary);
  p.line.hidden = !v.summary;
  setText(p.now, v.current);
  p.now.hidden = !v.current || v.status !== "running";
  p.why.set(v.why, v.status === "failed");
  const items = v.failedItems.slice(0, 20);
  p.failedBox.hidden = !items.length;
  if (items.length) {
    const ul = p.failedBox.querySelector("ul");
    patchList(ul, items, (i) => `${i.symbol}|${i.interval}`, (i, had) => {
      const li = had ?? h("li", {});
      setText(li, `${symbolLabel(i.symbol)} ${i.interval}${i.error ? `: ${typeof i.error === "string" ? i.error : (i.error.message ?? "failed")}` : ""}`);
      return li;
    }, { animate: false });
  }
  const sig = `${v.actions.join(",")}`;
  const clsSig = `${v.cls.label}`;
  if (p.cls !== clsSig) {
    p.cls = clsSig;
    p.clsSlot.replaceChildren(classPill(v.cls).el);
  }
  setActions(p.row, sig, () =>
    v.actions.map((a) =>
      act(
        a,
        a === "pause" ? btn("Pause", "small", (e) => ops.pause(el._job, e.currentTarget), "pause")
          : a === "resume" ? btn("Resume", "small tinted", (e) => ops.resume(el._job, e.currentTarget), "play")
          : a === "cancel" ? btn("Cancel", "small plain destructive", (e) => ops.cancel(el._job, e.currentTarget))
          : a === "retry" ? btn("Retry", "small primary", (e) => ops.retry(el._job, e.currentTarget), "refresh")
          : a === "files" ? btn("Files", "small tinted", (e) => ops.files(el._job, e.currentTarget), "download")
          : btn("Delete", "small plain destructive", (e) => ops.remove(el._job, e.currentTarget), "trash"),
      ),
    ),
  );
}

function makeRecCard(ops) {
  const title = h("h3", { class: "dt-job-title", "data-gloss": "" });
  const sub = h("p", { class: "dt-job-sub" });
  const state = statePill();
  const stats = h("p", { class: "dt-line" });
  const why = whyBlock();
  const row = actionsRow();
  const clsSlot = h("span", { class: "dt-clsslot" });
  const el = h("article", { class: "card dt-job dt-rec" }, h("div", { class: "dt-job-head" }, h("div", { class: "dt-job-titles" }, title, sub), state.el), stats, why.el, h("div", { class: "dt-job-foot" }, clsSlot, row));
  el._p = { title, sub, state, stats, why, row, clsSlot, cls: "" };
  return el;
}
function paintRec(el, rec, ops, nowMs) {
  const p = el._p;
  el._rec = rec;
  const v = recordingView(rec, nowMs);
  el.dataset.status = v.status ?? "";
  setText(p.title, v.title);
  setText(p.sub, [v.sub, v.startedText].filter(Boolean).join(" · "));
  p.state.set(v.tone, v.word);
  setText(p.stats, v.stats);
  p.stats.hidden = !v.stats;
  p.why.set(v.why, false);
  if (p.cls !== v.cls.label) {
    p.cls = v.cls.label;
    p.clsSlot.replaceChildren(classPill(v.cls).el);
  }
  setActions(p.row, v.actions.join(","), () =>
    v.actions.map((a) =>
      act(
        a,
        a === "pause" ? btn("Pause", "small", (e) => ops.pause(el._rec, e.currentTarget), "pause")
          : a === "resume" ? btn("Resume", "small tinted", (e) => ops.resume(el._rec, e.currentTarget), "play")
          : a === "stop" ? btn("Stop", "small plain destructive", (e) => ops.stop(el._rec, e.currentTarget))
          : a === "files" ? btn("Files", "small tinted", (e) => ops.files(el._rec, e.currentTarget), "download")
          : btn("Delete", "small plain destructive", (e) => ops.remove(el._rec, e.currentTarget), "trash"),
      ),
    ),
  );
}

// ── File lists ──

/** A sheet that lists a job's or recording's files, each with a download button, and says what the data class means. */
async function openFiles({ title, kind, id, cls, manifestUrl }) {
  const where = folderPath(app.state.meta?.dataDir, kind, id);
  const listBox = h("div", { class: "dt-files" }, h("p", { class: "hint" }, "Loading files…"));
  const what = h("details", { class: "dt-what" }, h("summary", {}, "What do these labels mean?"), h("ul", { class: "dt-guide" }, CLASS_GUIDE.map((c) => h("li", {}, h("strong", {}, c.label), h("span", {}, c.note)))));
  const head = h("div", { class: "dt-fields" }, h("p", { class: "dt-files-head" }, "These files are labelled", classPill(cls).el), h("p", { class: "hint" }, cls.note));
  const sheet = modal({ title, body: h("div", { class: "dt-sheet" }, head, listBox, what), buttons: [{ label: "Done", cls: "primary", value: true }] });
  const res = await optional(kind === "downloads" ? client.downloads.files(id) : client.recordings.files(id));
  if (res.error) listBox.replaceChildren(alertBox(res.error));
  else {
    const files = Array.isArray(res.data) ? res.data : [];
    if (!files.length) listBox.replaceChildren(emptyState("inbox", "No files yet", kind === "downloads" ? "Files appear here as each symbol finishes." : "A file is made for each trading day once the first row is written.", null, { compact: true }));
    else {
      const total = files.reduce((n, f) => n + (Number(f.bytes) || 0), 0);
      const zipAll = files.length > 1
        ? btn(`Download all ${files.length} files as one .zip`, "primary", (e) => run(e.currentTarget, async () => {
            if (total > ZIP_MAX_BYTES) throw new Error(`These files are ${formatBytes(total)}, too big to pack in the browser. Download them one by one, or copy the folder below.`);
            const parts = [];
            for (const f of files) {
              const res = await fetch(`/v1/${kind}/${encodeURIComponent(id)}/files/${encodeURIComponent(f.name)}`, { headers: { Authorization: `Bearer ${currentKey()}`, "X-MCB-Client": "dashboard" } });
              if (!res.ok) throw new Error(`The Bridge answered ${res.status} for ${f.name}.`);
              parts.push({ name: f.name, data: new Uint8Array(await res.arrayBuffer()) });
            }
            const blob = new Blob([(await import("./xlsx-core.js")).zipStore(parts)], { type: "application/zip" });
            const url = URL.createObjectURL(blob);
            const a = h("a", { href: url, download: zipName(title, id), hidden: true });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 15_000);
          }), "download")
        : null;
      const folder = where
        ? h("div", { class: "dt-folder" }, h("span", { class: "hint" }, "Saved on this computer in"), h("code", { class: "dev-code", tabindex: "0" }, where), copyButton(where, { label: "Copy folder", toastLabel: "Folder copied", ariaLabel: "Copy the folder these files are saved in" }))
        : null;
      listBox.replaceChildren(
        ...[zipAll, folder].filter(Boolean),
        h(
          "div",
          { class: "list dt-file-list" },
          files.map((f) => {
            const b = btn("Download", "small tinted", async (e) => {
              await run(e.currentTarget, () => saveFile(`/v1/${kind}/${encodeURIComponent(id)}/files/${encodeURIComponent(f.name)}`, f.name));
            }, "download");
            const meta = [f.symbol ? symbolLabel(f.symbol) : null, f.interval, f.rows ? `${formatCount(f.rows)} rows` : null, f.bytes ? formatBytes(f.bytes) : null, f.firstBar ? `${dayText(f.firstBar)} to ${dayText(f.lastBar)}` : null, f.date ? dayText(f.date) : null].filter(Boolean).join(" · ");
            return h("div", { class: "list-row static dt-file" }, h("span", { class: "names" }, h("span", { class: "nm" }, f.name), h("span", { class: "sub dt-wrap" }, meta)), b);
          }),
        ),
      );
      if (kind === "downloads" && !files.some((f) => f.name === "manifest.json")) {
        listBox.append(btn("Download the manifest (what is in these files)", "small plain", async (e) => run(e.currentTarget, () => saveFile(manifestUrl || `/v1/downloads/${encodeURIComponent(id)}/files/manifest.json`, "manifest.json")), "download"));
      }
    }
  }
  return sheet;
}

// ── The wizard: a new download ──

/**
 * Three plain steps: which symbols, which bars and dates, how to save. The estimate (bars, size, broker calls, time at the
 * allowed share) is on screen from step 2, before anything starts.
 * @param {{ collections: object[], share: () => number, preset?: { collection?: string }, onStarted: () => void }} o
 */
function openDownloadWizard({ collections, share, preset = {}, onStarted }) {
  const st = {
    step: preset.collection ? 1 : 0,
    symbols: [],
    collection: preset.collection ?? null,
    source: "search",
    intervals: [...DEFAULT_INTERVALS],
    range: DEFAULT_RANGE,
    custom: { from: "", to: "" },
    format: "csv",
    layout: "per-symbol",
    name: "",
    keep: false,
    dataset: "",
    pending: "", // text pasted but not added yet: Next adds it
    error: null,
    starting: false,
  };
  const colByName = (n) => collections.find((c) => c.name === n);
  const count = () => {
    if (st.collection) {
      const c = colByName(st.collection);
      return c?.kind === "option-universe" ? (universeSize(c.universe).count ?? 40) : (c?.symbols?.length ?? c?.count ?? 0);
    }
    return st.symbols.length;
  };
  const pendingSymbols = () => (st.collection ? [] : parseSymbolList(st.pending).symbols);
  const dates = () => rangeDates(st.range, Date.now(), st.intervals, st.custom);
  const estimate = () => estimateJob({ symbols: count(), intervals: st.intervals, from: dates().from, to: dates().to, format: st.format, share: share() });

  return modal({
    title: "New download",
    dirty: () => !st.starting && (st.symbols.length > 0 || st.name !== ""),
    body: (close) => {
      const stepLabel = h("p", { class: "dt-step-label", "aria-live": "polite" });
      const dots = h("ol", { class: "dt-dots", "aria-hidden": "true" }, [0, 1, 2].map(() => h("li", {})));
      const stepBox = h("div", { class: "dt-step" });
      const errBox = h("div", { class: "dt-err", "aria-live": "assertive" });
      const sumBox = h("div", { class: "dt-estimate", "aria-live": "polite" });
      const back = btn("Back", "", () => to(st.step - 1));
      const next = btn("Next", "primary", () => (st.step === 2 ? start() : to(st.step + 1)));
      const foot = h("div", { class: "dt-wiz-foot" }, back, next);
      const TITLES = ["Which symbols?", "Which bars, and how far back?", "How should it be saved?"];

      const paintSummary = () => {
        if (st.step === 0) {
          const n = count();
          const c = st.collection ? colByName(st.collection) : null;
          const waiting = pendingSymbols().length;
          const label = c ? (c.kind === "option-universe" ? `Collection ${c.name}: its symbols are worked out when the download runs` : `Collection ${c.name}: ${plural(n, "symbol")}`) : n ? plural(n, "symbol") : waiting ? `${plural(waiting, "symbol")} pasted. Press Next to use them.` : "Nothing picked yet. Search, paste a list or pick a collection.";
          put(sumBox, h("p", { class: "dt-estimate-main" }, label), n > MAX_SYMBOLS ? hint(`A download takes ${MAX_SYMBOLS} symbols at most.`, "bad") : null);
          return;
        }
        const est = estimate();
        const l = estimateLines(est);
        const warn = estimateWarning(est);
        put(sumBox, 
          h("p", { class: "dt-estimate-head" }, icon("clock"), "Before you start"),
          h("p", { class: "dt-estimate-main" }, l.size),
          l.calls ? h("p", {}, l.calls) : null,
          l.time ? h("p", {}, l.time) : null,
          warn ? h("p", { class: "dt-estimate-warn" }, warn) : null,
          est.ok && est.calls ? h("p", { class: "hint" }, `Worked out at ${est.callsPerSec} calls a second. Range: ${dayText(dates().from)} to ${dayText(dates().to)}.`) : null,
        );
      };
      const valid = () => {
        if (st.step === 0) return (count() > 0 || pendingSymbols().length > 0) && count() <= MAX_SYMBOLS;
        if (st.step === 1) return st.intervals.length > 0 && Boolean(dates().from) && estimate().ok;
        return !st.keep || /^[a-z0-9][a-z0-9-]{0,39}$/.test(st.dataset);
      };
      const paintFoot = () => {
        back.hidden = st.step === 0;
        next.disabled = !valid() || st.starting;
        setText(next.lastChild, st.step === 2 ? "Start download" : "Next");
        next.className = "primary";
      };
      const refresh = () => {
        paintSummary();
        paintFoot();
      };
      const showError = (e) => {
        if (!e) return errBox.replaceChildren();
        const f = friendlyError(e);
        const extra = needsLogin(e.code) ? btn("Log in on Accounts", "small tinted", () => (close(false, true), go("#/accounts"))) : null;
        errBox.replaceChildren(h("div", { class: "alert bad", role: "alert" }, icon("warn"), h("div", {}, h("strong", {}, f.title), f.detail ? h("span", { class: "detail" }, f.detail) : null, extra ? h("div", { class: "alert-actions" }, extra) : null)));
      };

      // Step 1: symbols
      const stepSymbols = () => {
        const chipsBox = h("div", { class: "dt-picked" });
        const paintPicked = () => {
          chipsBox.replaceChildren();
          if (st.collection) {
            const c = colByName(st.collection);
            chipsBox.append(h("div", { class: "dt-picked-head" }, h("strong", {}, `Collection ${st.collection}`), h("span", { class: "hint" }, c ? collectionView(c).sizeText : ""), btn("Remove", "xs plain", () => ((st.collection = null), paintPicked(), refresh()))));
          } else if (st.symbols.length) {
            chipsBox.append(
              h("div", { class: "dt-picked-head" }, h("strong", {}, plural(st.symbols.length, "symbol")), btn("Clear all", "xs plain", () => ((st.symbols = []), paintPicked(), refresh()))),
              h("div", { class: "chips dt-picked-chips" }, st.symbols.slice(0, 24).map((s) => h("button", { type: "button", class: "chip-btn", "aria-label": `Remove ${symbolLabel(s)}`, onclick: () => ((st.symbols = st.symbols.filter((x) => x !== s)), paintPicked(), refresh()) }, symbolLabel(s), icon("close"))), st.symbols.length > 24 ? h("span", { class: "chip" }, `+${st.symbols.length - 24} more`) : null),
            );
          }
        };
        const add = (list) => {
          st.collection = null;
          const have = new Set(st.symbols);
          for (const s of list) if (!have.has(s) && st.symbols.length < MAX_SYMBOLS) st.symbols.push(s);
          paintPicked();
          refresh();
        };
        // Search
        const q = input({ type: "search", id: "dt-q", placeholder: "Search by name, for example reliance or nifty", "aria-label": "Search instruments" });
        const results = h("div", { class: "dt-results", "aria-live": "polite" });
        let seq = 0;
        let timer = null;
        const search = async () => {
          const text = q.value.trim();
          if (text.length < 2) return results.replaceChildren(hint("Type at least two letters."));
          const mine = ++seq;
          results.replaceChildren(hint("Searching…"));
          const r = await optional(client.searchInstruments(text));
          if (mine !== seq) return;
          if (r.error) return results.replaceChildren(h("p", { class: "hint" }, "The search did not work. If you have not logged in to your broker today, log in on Accounts: the contract list comes from your broker."));
          const list = Array.isArray(r.data) ? r.data : [];
          if (!list.length) return results.replaceChildren(hint("Nothing matched. Try the symbol itself, like RELIANCE or NIFTY."));
          results.replaceChildren(h("div", { class: "list" }, list.map((i) => h("button", { type: "button", class: "list-row", onclick: () => add([i.symbol]), "aria-label": `Add ${symbolLabel(i.symbol)}` }, h("span", { class: "names" }, h("span", { class: "nm" }, symbolLabel(i.symbol)), h("span", { class: "sub" }, [i.name, i.exchange, i.kind].filter(Boolean).join(" · "))), icon("plus")))));
        };
        q.addEventListener("input", () => (clearTimeout(timer), (timer = setTimeout(search, 250))));
        const searchPane = h("div", { class: "dt-pane" }, q, results);
        // Paste
        const ta = h("textarea", { id: "dt-paste", rows: 5, placeholder: "NSE:RELIANCE\nNSE:TCS\nINFY", "aria-label": "Paste symbols", spellcheck: "false" });
        ta.value = st.pending;
        ta.addEventListener("input", () => ((st.pending = ta.value), refresh()));
        const pasteMsg = h("p", { class: "hint", "aria-live": "polite" });
        const pastePane = h("div", { class: "dt-pane" }, ta, h("div", { class: "dt-pane-act" }, btn("Add these", "small tinted", () => {
          const r = parseSymbolList(ta.value);
          add(r.symbols);
          ta.value = "";
          st.pending = "";
          setText(pasteMsg, [r.symbols.length ? `Added ${plural(r.symbols.length, "symbol")}.` : "No symbols found.", r.duplicates ? `${plural(r.duplicates, "repeat")} skipped.` : "", r.invalid.length ? `Not recognised: ${r.invalid.slice(0, 4).join(", ")}${r.invalid.length > 4 ? "…" : ""}.` : "", r.over ? `${plural(r.over, "symbol")} over the ${MAX_SYMBOLS} limit were left out.` : ""].filter(Boolean).join(" "));
        }), pasteMsg), hint("Separate them with commas, spaces or new lines. A bare name like RELIANCE means NSE:RELIANCE."));
        // Collections
        const colPane = h("div", { class: "dt-pane" }, collections.length ? h("div", { class: "list" }, collections.map((c) => { const v = collectionView(c); return h("button", { type: "button", class: "list-row", onclick: () => ((st.collection = c.name), (st.symbols = []), paintPicked(), refresh()), "aria-pressed": String(st.collection === c.name) }, iconTile(v.universe ? "chart" : "folder", v.universe ? "indigo" : "teal", "sm"), h("span", { class: "names" }, h("span", { class: "nm" }, c.name), h("span", { class: "sub" }, [v.kindWord, v.sub].filter(Boolean).join(" · "))), icon("plus")); })) : emptyState("folder", "No collections yet", "A collection is a saved list of symbols you can reuse. Make one on the Collections tab.", btn("Open Collections", "small tinted", () => (close(false, true), go("#/data/collections"))), { compact: true }));
        const panes = { search: searchPane, paste: pastePane, collection: colPane };
        const body = h("div", { class: "dt-pane-wrap" });
        const tabs = seg("Where the symbols come from", [["search", "Search"], ["paste", "Paste a list"], ["collection", "My collections"]], st.source);
        const show = () => {
          st.source = tabs.value;
          body.replaceChildren(panes[st.source]);
        };
        tabs.addEventListener("change", show);
        show();
        paintPicked();
        return h("div", {}, tabs, body, chipsBox);
      };

      // Step 2: bars and dates
      const stepBars = () => {
        const ivBox = h("div", { class: "chips dt-iv", role: "group", "aria-label": "Bar sizes" });
        const paintIv = () =>
          ivBox.replaceChildren(
            ...INTERVALS.map((i) =>
              h("button", { type: "button", class: "chip-btn", "aria-pressed": String(st.intervals.includes(i.id)), onclick: () => {
                st.intervals = st.intervals.includes(i.id) ? st.intervals.filter((x) => x !== i.id) : [...st.intervals, i.id];
                paintIv();
                paintRangeNote();
                refresh();
              } }, i.label),
            ),
          );
        const rangeSeg = radioChips("How far back", RANGES.map((r) => [r.id, r.label]), st.range);
        const from = input({ type: "date", id: "dt-from", value: st.custom.from, "aria-label": "From" });
        const toIn = input({ type: "date", id: "dt-to", value: st.custom.to, "aria-label": "To" });
        const custom = h("div", { class: "dt-custom form-grid", hidden: st.range !== "custom" }, field("From", from), field("To (empty means today)", toIn));
        const note = h("p", { class: "hint", "aria-live": "polite" });
        const paintRangeNote = () => {
          const d = dates();
          const limit = d.from ? rangeLimitNote(d.from, d.to, st.intervals) : "";
          setText(note, `${st.range === "max" ? `Asks for ${dayText(d.from)} onwards. Your broker may keep less history than that; the file says what it got.` : d.from ? `${dayText(d.from)} to ${dayText(d.to)}.` : "Pick the first date."}${limit ? ` ${limit}` : ""}`);
        };
        rangeSeg.addEventListener("change", () => {
          st.range = rangeSeg.value;
          custom.hidden = st.range !== "custom";
          paintRangeNote();
          refresh();
        });
        for (const [el, key] of [[from, "from"], [toIn, "to"]]) el.addEventListener("input", () => ((st.custom[key] = el.value), paintRangeNote(), refresh()));
        paintIv();
        paintRangeNote();
        return h("div", { class: "dt-fields" }, h("div", { class: "field" }, h("span", { class: "dt-label" }, "Bar size (pick one or more)"), ivBox, hint("Smaller bars mean more rows. 5 minutes is a good start.")), h("div", { class: "field" }, h("span", { class: "dt-label" }, "How far back"), rangeSeg), custom, note);
      };

      // Step 3: format and name
      const stepSave = () => {
        const fmt = seg("File format", FORMATS.map((f) => [f.id, f.label]), st.format);
        const fmtNote = hint(FORMATS.find((f) => f.id === st.format).note);
        fmt.addEventListener("change", () => ((st.format = fmt.value), setText(fmtNote, FORMATS.find((f) => f.id === st.format).note), refresh()));
        const lay = radioChips("File layout", LAYOUTS.map((l) => [l.id, l.label]), st.layout);
        const layNote = hint(LAYOUTS.find((l) => l.id === st.layout).note);
        lay.addEventListener("change", () => ((st.layout = lay.value), setText(layNote, LAYOUTS.find((l) => l.id === st.layout).note)));
        const name = input({ id: "dt-name", value: st.name, placeholder: "Optional, for example Nifty 50 5-minute bars", maxlength: 60 });
        name.addEventListener("input", () => (st.name = name.value));
        const keep = h("input", { type: "checkbox", id: "dt-keep", checked: st.keep });
        const ds = input({ id: "dt-dataset", value: st.dataset, placeholder: "nifty-5m", maxlength: 40, "aria-describedby": "dt-ds-hint" });
        const dsBox = h("div", { class: "dt-ds", hidden: !st.keep }, field("Dataset name", ds, "Lower case letters, numbers and dashes. Next time, Update now fetches only what is new."));
        keep.addEventListener("change", () => {
          st.keep = keep.checked;
          dsBox.hidden = !st.keep;
          if (st.keep && !st.dataset) {
            st.dataset = slug(st.collection || st.name || (st.symbols.length === 1 ? symbolLabel(st.symbols[0]) : "my-data")) + (st.intervals.length === 1 ? `-${st.intervals[0].toLowerCase()}` : "");
            ds.value = st.dataset;
          }
          refresh();
        });
        ds.addEventListener("input", () => ((st.dataset = ds.value.trim().toLowerCase()), refresh()));
        const what = h("details", { class: "dt-what" }, h("summary", {}, "What do the data labels mean?"), h("ul", { class: "dt-guide" }, CLASS_GUIDE.map((c) => h("li", {}, h("strong", {}, c.label), h("span", {}, c.note)))));
        return h("div", { class: "dt-fields" }, h("div", { class: "field seg-field" }, h("span", { class: "dt-label" }, "Format"), fmt, fmtNote), h("div", { class: "field" }, h("span", { class: "dt-label" }, "Files"), lay, layNote), field("Name", name), h("label", { class: "check" }, keep, "Keep this up to date as a dataset"), dsBox, what);
      };

      const builders = [stepSymbols, stepBars, stepSave];
      const to = (n) => {
        if (st.step === 0 && n > 0) {
          // Pasted symbols that were never added come along: the person pressed Next, not "Add these".
          const have = new Set(st.symbols);
          for (const s of pendingSymbols()) if (!have.has(s) && st.symbols.length < MAX_SYMBOLS) st.symbols.push(s);
          st.pending = "";
        }
        st.step = Math.max(0, Math.min(2, n));
        setText(stepLabel, `Step ${st.step + 1} of 3: ${TITLES[st.step]}`);
        [...dots.children].forEach((d, i) => setClass(d, "on", i <= st.step));
        stepBox.replaceChildren(builders[st.step]());
        showError(null);
        refresh();
      };
      async function start() {
        st.starting = true;
        paintFoot();
        busy(next, true);
        const d = dates();
        const body = { ...(st.collection ? { collection: st.collection } : { symbols: st.symbols }), intervals: st.intervals, from: d.from, ...(st.range === "custom" && d.to ? { to: d.to } : {}), format: st.format, layout: st.layout, ...(st.name.trim() ? { name: st.name.trim() } : {}), ...(st.keep && st.dataset ? { dataset: st.dataset } : {}) };
        try {
          await client.downloads.create(body);
          toast("Download started. You can watch it here.");
          close(true, true);
          onStarted();
        } catch (e) {
          st.starting = false;
          busy(next, false);
          showError(e);
          paintFoot();
        }
      }
      to(st.step);
      return h("div", { class: "dt-wiz" }, h("div", { class: "dt-wiz-top" }, stepLabel, dots), stepBox, sumBox, errBox, foot);
    },
    buttons: [],
  });
}

// ── Downloads tab ──

export async function renderDownloads() {
  const root = h("div", { class: "dt-tab" });
  const [first, accounts, colRes] = await Promise.all([load(() => client.downloads.list()), optional(client.accounts()), load(() => client.collections.list())]);
  if (first.unavailable) return h("div", { class: "dt-tab" }, notThere("Downloads"));
  const saving = savingCard();
  let collections = Array.isArray(colRes.data) ? colRes.data : [];
  let jobs = Array.isArray(first.data) ? first.data : [];
  let meta = first.meta;
  let loginMissing = !accounts.error && noLogin(accounts.data, app.state.demo);
  let lastFull = 0;
  let showAll = false;
  const bannerBox = h("div", { class: "dt-banners" });
  const activeBox = h("div", { class: "dt-list" });
  const doneBox = h("div", { class: "dt-list" });
  const moreBtn = btn("Show older downloads", "small plain", () => ((showAll = true), draw()));
  const emptyBox = h("div", {});
  const finishedHead = h("div", { class: "dt-list-head" }, h("h3", { class: "group-title" }, "Finished"));
  const headActs = h("div", { class: "sec-acts" }, btn("New download", "primary", () => openWizard(), "plus"));
  const secHead = h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", {}, "Downloads"), h("p", {}, "Save history for the symbols you pick, as files you can open anywhere. It runs in the background and never slows live prices.")), headActs);

  const refresh = async () => {
    const r = await load(() => client.downloads.list());
    if (r.error) return;
    jobs = Array.isArray(r.data) ? r.data : [];
    meta = r.meta;
    draw();
  };
  const ops = {
    pause: (j, b) => run(b, async () => (await client.downloads.pause(j.id), refresh()), { ok: "Paused." }),
    resume: (j, b) => run(b, async () => (await client.downloads.resume(j.id), refresh()), { ok: "Carrying on." }),
    cancel: async (j, b) => {
      if (!(await confirmSheet({ title: "Cancel this download?", text: "What was already saved is kept. The rest will not be downloaded.", confirm: "Cancel the download" }))) return;
      await run(b, async () => (await client.downloads.cancel(j.id), refresh()), { ok: "Cancelled." });
    },
    retry: (j, b) => run(b, async () => {
      const req = j.request ?? {};
      await client.downloads.create({ ...req });
      await refresh();
    }, { ok: "Trying again as a new download." }),
    files: (j) => openFiles({ title: jobView(j).title, kind: "downloads", id: j.id, cls: classInfo({ dataClass: j.dataClass, source: j.source, delaySec: j.delaySec }), manifestUrl: j.manifestUrl }),
    remove: async (j, b) => {
      if (!(await confirmSheet({ title: "Delete this download?", text: "Its files are deleted from this computer. This cannot be undone.", confirm: "Delete files" }))) return;
      await run(b, async () => (await client.downloads.remove(j.id), refresh()), { ok: "Deleted." });
    },
  };
  function openWizard(preset) {
    openDownloadWizard({ collections, share: saving.share, preset, onStarted: refresh });
  }
  let firstDraw = true;
  function draw() {
    const nowMs = Date.now();
    const sorted = sortJobs(jobs);
    const active = sorted.filter((j) => ["running", "queued", "paused"].includes(j.status));
    const finished = sorted.filter((j) => !active.includes(j));
    const shownFinished = showAll ? finished : finished.slice(0, 6);
    const make = (j, had) => {
      const el = had ?? makeJobCard(ops);
      paintJob(el, j, ops, nowMs);
      return el;
    };
    patchList(activeBox, active, (j) => j.id, make, { animate: !firstDraw });
    patchList(doneBox, shownFinished, (j) => j.id, make, { animate: !firstDraw });
    moreBtn.hidden = showAll || finished.length <= 6;
    activeBox.hidden = !active.length;
    doneBox.hidden = !shownFinished.length;
    finishedHead.hidden = doneBox.hidden;
    emptyBox.replaceChildren(
      ...(jobs.length
        ? []
        : [
            emptyState("download", "No downloads yet", "Pick some symbols and how far back to go, and the Bridge saves the history as files. It tells you the size and the number of broker calls before anything starts.", [btn("New download", "primary", () => openWizard(), "plus"), btn("Use a collection", "tinted", () => go("#/data/collections"))]),
          ]),
    );
    bannerBox.replaceChildren(...banners({ login: loginMissing, disk: meta.disk, diskWhat: "downloads" }));
    firstDraw = false;
  }
  root.append(secHead, bannerBox, emptyBox, activeBox, finishedHead, doneBox, moreBtn, saving.el);
  draw();
  saving.refresh();
  const poll = createPoller({
    root,
    ms: POLL_MS,
    run: async () => {
      const anyActive = jobs.some((j) => ["running", "queued"].includes(j.status));
      const due = Date.now() - lastFull > IDLE_REFRESH_MS;
      if (!anyActive && !due) return;
      lastFull = Date.now();
      await refresh();
      if (due) {
        const [a, c] = await Promise.all([optional(client.accounts()), load(() => client.collections.list())]);
        if (!a.error) loginMissing = noLogin(a.data, app.state.demo);
        if (!c.error) collections = Array.isArray(c.data) ? c.data : collections;
        saving.refresh();
      }
    },
  });
  poll.start();
  const pending = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (pending.get("collection") && collections.some((c) => c.name === pending.get("collection"))) {
    history.replaceState(history.state, "", "#/data/downloads");
    queueMicrotask(() => openWizard({ collection: pending.get("collection") }));
  }
  return root;
}

// ── Recordings tab ──

/**
 * The recording form (one-off recording or an auto-record rule).
 * @param {{ mode: "rule" | "once", rule?: object, collections: object[], preset?: object, onSaved: () => void }} o
 */
function openRecordingSheet({ mode, rule = null, collections, preset = {}, onSaved }) {
  const f = {
    name: rule?.name ?? "",
    kind: rule?.kind ?? preset.kind ?? "chain",
    source: rule ? (rule.collection ? "collection" : rule.underlying || rule.universe ? "index" : "symbols") : preset.collection ? "collection" : "index",
    collection: rule?.collection ?? preset.collection ?? collections[0]?.name ?? "",
    underlying: rule?.underlying ?? rule?.universe?.underlying ?? "NIFTY",
    expiries: typeof rule?.universe?.expiries === "string" ? rule.universe.expiries : "current-weekly",
    count: rule?.universe?.strikes?.count ?? 10,
    symbols: Array.isArray(rule?.symbols) ? rule.symbols.join("\n") : "",
    everySec: rule?.everySec ?? (rule?.kind === "quotes" ? 5 : 30),
    custom: typeof rule?.schedule === "object" && rule?.schedule !== null,
    start: rule?.schedule?.start ?? "",
    end: rule?.schedule?.end ?? "",
    days: (rule?.schedule?.days ?? ["mon", "tue", "wed", "thu", "fri"]).map((d) => String(d).slice(0, 1).toUpperCase() + String(d).slice(1).toLowerCase()),
    keepDays: rule?.keepDays ?? "",
    format: rule?.format ?? "csv",
  };
  return modal({
    title: mode === "rule" ? (rule ? "Edit auto-record rule" : "New auto-record rule") : "Start a recording",
    body: (close) => {
      const err = h("div", { class: "dt-err", "aria-live": "assertive" });
      const sizeBox = h("p", { class: "hint dt-size", "aria-live": "polite" });
      const kind = seg("What to record", [["chain", "Option chain"], ["quotes", "Prices"]], f.kind);
      const srcOptions = () => (f.kind === "chain" ? [["index", "An index (set up here)"], ["collection", "A collection"]] : [["collection", "A collection"], ["symbols", "Symbols I paste"]]);
      const srcSel = select(srcOptions(), f.source, { id: "rc-src" });
      const body = h("div", { class: "dt-fields" });
      const name = input({ id: "rc-name", value: f.name, placeholder: "Optional", maxlength: 60 });
      const every = input({ id: "rc-every", type: "number", min: f.kind === "chain" ? 15 : 1, step: 1, value: f.everySec, inputmode: "numeric" });
      const fmt = select(FORMATS.filter((x) => x.id !== "amibroker").map((x) => [x.id, x.label]), f.format, { id: "rc-format" });
      const hoursSel = select([["market", "During market hours (trading days)"], ["custom", "Choose days and hours"]], f.custom ? "custom" : "market", { id: "rc-hours" });
      const hoursBox = h("div", { class: "dt-custom form-grid" });
      const keep = input({ id: "rc-keep", type: "number", min: 1, value: f.keepDays, placeholder: "Keep everything", inputmode: "numeric" });
      const bodyOf = () => recordingBody({ ...f, symbols: f.source === "symbols" ? parseSymbolList(f.symbols).symbols : [] }, mode, { enabled: rule ? rule.enabled !== false : true });
      const paintSize = () => {
        const b = bodyOf();
        let n = 0;
        if (b.collection) {
          const c = collections.find((x) => x.name === b.collection);
          n = c?.kind === "option-universe" ? (universeSize(c.universe).count ?? 0) : (c?.symbols?.length ?? 0);
        } else if (b.universe) n = universeSize(b.universe).count ?? 0;
        else n = b.symbols?.length ?? 0;
        const e = estimateRecording({ kind: f.kind, symbolCount: n, everySec: Number(f.everySec) || 30, format: f.format });
        setText(sizeBox, n ? `About ${plural(n, "symbol")}: roughly ${formatBytes(e.bytesPerDay)} a trading day. It uses your live stream, so it costs no extra broker calls when the stream is up.` : "");
      };
      const drawBody = () => {
        const parts = [];
        if (f.source === "index") {
          const und = input({ id: "rc-und", value: f.underlying, list: "rc-und-list", maxlength: 30 });
          und.addEventListener("input", () => ((f.underlying = und.value), paintSize()));
          const exp = select(EXPIRY_CHOICES.map((c) => [c.id, c.label]), f.expiries, { id: "rc-exp" });
          exp.addEventListener("change", () => ((f.expiries = exp.value), paintSize()));
          const cnt = input({ id: "rc-count", type: "number", min: 1, max: 100, value: f.count, inputmode: "numeric" });
          cnt.addEventListener("input", () => ((f.count = cnt.value), paintSize()));
          parts.push(h("div", { class: "form-grid" }, field("Index or stock", und), field("Expiry", exp), field("Strikes either side of the current price", cnt, "10 means the middle strike plus 10 above and 10 below.")), h("datalist", { id: "rc-und-list" }, COMMON_UNDERLYINGS.map((u) => h("option", { value: u }))));
        } else if (f.source === "collection") {
          const c = select(collections.length ? collections.map((x) => [x.name, x.name]) : [["", "No collections yet"]], f.collection, { id: "rc-col" });
          c.addEventListener("change", () => ((f.collection = c.value), paintSize()));
          parts.push(field("Collection", c, collections.length ? "An option universe is worked out again each day, so the strikes follow the market." : "Make a collection on the Collections tab first."));
        } else {
          const ta = h("textarea", { id: "rc-syms", rows: 4, placeholder: "NSE:RELIANCE\nNSE:TCS", spellcheck: "false" }, f.symbols);
          ta.addEventListener("input", () => ((f.symbols = ta.value), paintSize()));
          parts.push(field("Symbols", ta, "One per line or separated by commas."));
        }
        body.replaceChildren(...parts);
      };
      const drawHours = () => {
        hoursBox.hidden = !f.custom;
        if (!f.custom) return hoursBox.replaceChildren();
        const st = input({ id: "rc-start", type: "time", value: f.start, required: true });
        const en = input({ id: "rc-end", type: "time", value: f.end, required: true });
        st.addEventListener("input", () => (f.start = st.value));
        en.addEventListener("input", () => (f.end = en.value));
        const days = h("div", { class: "chips", role: "group", "aria-label": "Days" }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("button", { type: "button", class: "chip-btn", "aria-pressed": String(f.days.includes(d)), onclick: (e) => {
          f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d];
          e.currentTarget.setAttribute("aria-pressed", String(f.days.includes(d)));
        } }, d)));
        hoursBox.replaceChildren(field("From (IST)", st), field("To (IST)", en), h("div", { class: "field wide" }, h("span", {}, "Days"), days, hint("Only trading days from the exchange calendar are recorded, whatever you pick.")));
      };
      kind.addEventListener("change", () => {
        f.kind = kind.value;
        const opts = srcOptions();
        if (!opts.some(([v]) => v === f.source)) f.source = opts[0][0];
        srcSel.replaceChildren(...opts.map(([v, t]) => h("option", { value: v }, t)));
        srcSel.value = f.source;
        every.min = f.kind === "chain" ? 15 : 1;
        if (f.kind === "chain" && Number(f.everySec) < 15) every.value = f.everySec = 30;
        drawBody();
        paintSize();
      });
      srcSel.addEventListener("change", () => ((f.source = srcSel.value), drawBody(), paintSize()));
      name.addEventListener("input", () => (f.name = name.value));
      every.addEventListener("input", () => ((f.everySec = every.value), paintSize()));
      fmt.addEventListener("change", () => ((f.format = fmt.value), paintSize()));
      hoursSel.addEventListener("change", () => ((f.custom = hoursSel.value === "custom"), drawHours()));
      keep.addEventListener("input", () => (f.keepDays = keep.value));
      drawBody();
      drawHours();
      paintSize();
      const save = btn(mode === "rule" ? (rule ? "Save rule" : "Add rule and turn it on") : "Start recording", "primary", async () => {
        const p = recordingProblem({ kind: f.kind, everySec: f.everySec, collection: f.source === "collection" ? f.collection : null, underlying: f.source === "index" ? f.underlying : null, symbols: f.source === "symbols" ? parseSymbolList(f.symbols).symbols : [], keepDays: f.keepDays, custom: mode === "rule" && f.custom, start: f.start, end: f.end });
        if (p) return showFormError(err, p);
        busy(save, true);
        try {
          if (mode === "rule") await (rule ? client.recordings.rules.patch(rule.id, bodyOf()) : client.recordings.rules.create(bodyOf()));
          else await client.recordings.create(bodyOf());
          toast(mode === "rule" ? "Saved. The Bridge records by itself from the next market session." : "Recording started.");
          close(true, true);
          onSaved();
        } catch (e) {
          busy(save, false);
          const fe = friendlyError(e);
          showFormError(err, fe.title, fe.detail);
        }
      });
      return h("div", { class: "dt-wiz" }, h("div", { class: "dt-fields" }, h("div", { class: "field seg-field" }, h("span", { class: "dt-label" }, "What to record"), kind), field("Where from", srcSel), body, field("Save every (seconds)", every, f.kind === "chain" ? "At least 15 seconds for an option chain." : "At least 1 second."), ...(mode === "rule" ? [field("When", hoursSel), hoursBox, field("Delete files older than (days)", keep, "Leave empty to keep everything. Old days can be removed by hand on the Recordings tab.")] : []), field("Format", fmt), field("Name", name), sizeBox, hint("Recordings are saved from your own live data only (real-time), never from a delayed or end-of-day source.")), h("div", { class: "dt-wiz-foot" }, err, btn("Cancel", "", () => close(false)), save));
    },
    buttons: [],
    dirty: () => false,
  });
}

export async function renderRecordings() {
  const root = h("div", { class: "dt-tab" });
  const [recRes, ruleRes, colRes, accounts] = await Promise.all([load(() => client.recordings.list()), load(() => client.recordings.rules.list()), load(() => client.collections.list()), optional(client.accounts())]);
  if (recRes.unavailable) return h("div", { class: "dt-tab" }, notThere("Recordings"));
  const saving = savingCard();
  let recs = Array.isArray(recRes.data) ? recRes.data : [];
  let rules = Array.isArray(ruleRes.data) ? ruleRes.data : [];
  const rulesMissing = ruleRes.unavailable;
  let collections = Array.isArray(colRes.data) ? colRes.data : [];
  let meta = recRes.meta;
  let loginMissing = !accounts.error && noLogin(accounts.data, app.state.demo);
  let lastFull = 0;
  const bannerBox = h("div", { class: "dt-banners" });
  const statusLine = h("p", { class: "dt-auto-status", "aria-live": "polite" });
  const statusDot = h("span", { class: "dot dt-auto-dot", "aria-hidden": "true" });
  const presetsBox = h("div", { class: "dt-presets" });
  const ruleBox = h("div", { class: "list dt-rules" });
  const recBox = h("div", { class: "dt-list" });
  const recEmpty = h("div", {});
  const recHead = h("div", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", {}, "Recordings"), h("p", {}, "Brokers do not give history for option chains or prices tick by tick, so the Bridge saves them from its own live data, going forward.")), h("div", { class: "sec-acts" }, btn("Start a recording", "tinted", () => openRecordingSheet({ mode: "once", collections, onSaved: refresh }), "record")));

  const refresh = async () => {
    const [r, u, c] = await Promise.all([load(() => client.recordings.list()), load(() => client.recordings.rules.list()), load(() => client.collections.list())]);
    if (!r.error) {
      recs = Array.isArray(r.data) ? r.data : [];
      meta = r.meta;
    }
    if (!u.error) rules = Array.isArray(u.data) ? u.data : rules;
    if (!c.error) collections = Array.isArray(c.data) ? c.data : collections;
    draw();
  };
  const recOps = {
    pause: (r, b) => run(b, async () => (await client.recordings.pause(r.id), refresh()), { ok: "Paused." }),
    resume: (r, b) => run(b, async () => (await client.recordings.resume(r.id), refresh()), { ok: "Recording again." }),
    stop: async (r, b) => {
      if (!(await confirmSheet({ title: "Stop this recording?", text: "What was written is kept. You can start a new recording any time.", confirm: "Stop recording" }))) return;
      await run(b, async () => (await client.recordings.stop(r.id), refresh()), { ok: "Stopped." });
    },
    files: (r) => openFiles({ title: recordingView(r).title, kind: "recordings", id: r.id, cls: classInfo({ dataClass: r.dataClass ?? "realtime", source: r.source }) }),
    remove: async (r, b) => {
      if (!(await confirmSheet({ title: "Delete this recording?", text: "Its files are deleted from this computer. This cannot be undone.", confirm: "Delete files" }))) return;
      await run(b, async () => (await client.recordings.remove(r.id), refresh()), { ok: "Deleted." });
    },
  };

  async function applyPreset(p) {
    let collection = null;
    if (p.needs === "collection") {
      if (!collections.length) {
        toast("Make a collection of your symbols first.", { tone: "info" });
        return go("#/data/collections");
      }
      collection = collections[0].name;
      if (collections.length > 1) {
        const sel = select(collections.map((c) => [c.name, c.name]), collection, { id: "pre-col" });
        const ok = await modal({ title: p.title, body: h("div", { class: "dt-fields" }, field("Which collection?", sel)), buttons: [{ label: "Cancel", value: false }, { label: "Next", cls: "primary", value: true }] });
        if (!ok) return;
        collection = sel.value;
      }
    }
    const c = collections.find((x) => x.name === collection);
    const plan = presetPlan(p, { collection, collectionSize: c ? (c.kind === "option-universe" ? universeSize(c.universe).count : (c.symbols?.length ?? 0)) : 0 });
    const unavailable = (e) => isUnavailable(e);
    const done = await modal({
      title: p.title,
      body: (close) => {
        const err = h("div", { class: "dt-err", "aria-live": "assertive" });
        let made = 0; // a second try carries on after the rules that were already made
        const go1 = btn("Turn it on", "primary", async () => {
          busy(go1, true);
          try {
            while (made < plan.bodies.length) {
              await client.recordings.rules.create(plan.bodies[made]);
              made += 1;
            }
            close(true, true);
          } catch (e) {
            busy(go1, false);
            const f = friendlyError(e);
            if (unavailable(e)) showFormError(err, "This Bridge cannot auto-record yet.");
            else showFormError(err, f.title, f.detail);
          }
        });
        return h("div", { class: "dt-wiz" }, h("div", { class: "dt-fields" }, h("p", { class: "dt-confirm" }, p.sub, "."), plan.symbols ? h("p", { class: "hint" }, `About ${plural(plan.symbols, "symbol")} and roughly ${formatBytes(plan.bytesPerDay)} a trading day. It uses your live stream and starts by itself at each market open. You can turn it off any time.`) : null, hint("Recorded from your own real-time data only.")), h("div", { class: "dt-wiz-foot" }, err, btn("Not now", "", () => close(false)), go1));
      },
      buttons: [],
    });
    if (!done) return;
    toast("Auto-record is on. It starts at the next market session.");
    refresh();
  }

  function drawRules() {
    const sum = autoRecordSummary({ rules, recordings: recs });
    setText(statusLine, sum.detail ? `${sum.headline}. ${sum.detail}` : sum.headline);
    statusDot.className = `dot dt-auto-dot ${sum.tone === "ok" ? "" : sum.tone === "warn" ? "warn" : "idle"}`;
    presetsBox.replaceChildren(
      ...RECORD_PRESETS.map((p) => h("button", { type: "button", class: "dt-preset", onclick: () => applyPreset(p) }, iconTile(p.id === "my-watchlist" ? "folder" : "chart", p.id === "my-watchlist" ? "teal" : "indigo", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, p.title), h("span", { class: "sub" }, p.sub)), icon("plus"))),
    );
    patchList(ruleBox, rules, (r) => r.id, (r, had) => {
      const s = ruleStatus(r);
      const el = had ?? h("div", { class: "list-row static dt-rule" }, iconTile("record", "red", "sm"), h("span", { class: "names" }, h("span", { class: "nm" }), h("span", { class: "sub dt-wrap" }), h("span", { class: "dt-rule-state" })), h("span", { class: "dt-rule-acts" }));
      const names = el.querySelector(".names");
      setText(names.children[0], r.name || "Recording rule");
      setText(names.children[1], ruleSentence(r, collections));
      const stEl = names.children[2];
      stEl.className = `dt-rule-state pill ${toneOf(s.tone)}`.trim();
      setText(stEl, s.word + (r.keepDays ? ` · keeps ${r.keepDays} days` : ""));
      const acts = el.querySelector(".dt-rule-acts");
      if (acts.dataset.sig !== r.id) {
        acts.dataset.sig = r.id;
        const sw = h("label", { class: "switch" }, h("input", { type: "checkbox", "aria-label": `Turn on ${r.name || "this rule"}` }), h("i", {}));
        const input_ = sw.querySelector("input");
        input_.addEventListener("change", async () => {
          const on = input_.checked;
          try {
            await client.recordings.rules.patch(el._rule.id, { enabled: on });
            toast(on ? "Turned on. It records from the next market session." : "Turned off.");
            refresh();
          } catch (e) {
            input_.checked = !on;
            toast(friendlyError(e).title, { tone: "error" });
          }
        });
        acts.replaceChildren(sw, iconBtn("pencil", "Edit rule", () => openRecordingSheet({ mode: "rule", rule: el._rule, collections, onSaved: refresh })), iconBtn("trash", "Delete rule", async () => {
          if (!(await confirmSheet({ title: "Delete this rule?", text: "It stops recording from now on. Files already saved are kept.", confirm: "Delete rule" }))) return;
          try {
            await client.recordings.rules.remove(el._rule.id);
            toast("Rule deleted.");
            refresh();
          } catch (e) {
            toast(friendlyError(e).title, { tone: "error" });
          }
        }));
      }
      el._rule = r;
      const sw = acts.querySelector("input");
      sw.checked = r.enabled !== false;
      return el;
    }, { animate: false });
    ruleBox.hidden = !rules.length;
  }
  let firstDraw = true;
  function draw() {
    const nowMs = Date.now();
    drawRules();
    patchList(recBox, recs, (r) => r.id, (r, had) => {
      const el = had ?? makeRecCard(recOps);
      paintRec(el, r, recOps, nowMs);
      return el;
    }, { animate: !firstDraw });
    recBox.hidden = !recs.length;
    recEmpty.replaceChildren(...(recs.length ? [] : [emptyState("record", "Nothing is recording", "Start a recording of an option chain or of prices, or turn on auto-record above and the Bridge does it every trading day.", btn("Start a recording", "tinted", () => openRecordingSheet({ mode: "once", collections, onSaved: refresh }), "record"), { compact: true })]));
    bannerBox.replaceChildren(...banners({ login: loginMissing, disk: meta.disk, diskWhat: "recordings" }));
    firstDraw = false;
  }
  const autoCard = h(
    "section",
    { class: "card dt-auto", "aria-labelledby": "dt-auto-h" },
    h("header", { class: "card-head" }, iconTile("clock", "red"), h("div", { class: "card-titles" }, h("h2", { id: "dt-auto-h" }, "Auto-record"), h("p", {}, "The Bridge records by itself every trading day, starts at the open, stops at the close and carries on after a restart. Off until you turn it on.")), h("div", { class: "card-actions" }, rulesMissing ? null : btn("New rule", "small tinted", () => openRecordingSheet({ mode: "rule", collections, onSaved: refresh }), "plus"))),
    h("div", { class: "card-body" }, rulesMissing ? hint("Auto-record rules are not in this Bridge yet.") : h("div", { class: "dt-auto-body" }, h("p", { class: "dt-auto-line" }, statusDot, statusLine), presetsBox, ruleBox)),
  );
  root.append(bannerBox, autoCard, recHead, recEmpty, recBox, saving.el);
  draw();
  saving.refresh();
  const poll = createPoller({
    root,
    ms: POLL_MS,
    run: async () => {
      const anyLive = recs.some((r) => r.status === "running");
      const due = Date.now() - lastFull > IDLE_REFRESH_MS;
      if (!anyLive && !due) return;
      lastFull = Date.now();
      await refresh();
      if (due) {
        const a = await optional(client.accounts());
        if (!a.error) loginMissing = noLogin(a.data, app.state.demo);
        saving.refresh();
      }
    },
  });
  poll.start();
  return root;
}

// ── Datasets tab ──

export async function renderDatasets() {
  const root = h("div", { class: "dt-tab" });
  const first = await load(() => client.datasets.list());
  if (first.unavailable) return h("div", { class: "dt-tab" }, notThere("Datasets"));
  let datasets = Array.isArray(first.data) ? first.data : [];
  let tags = [];
  let query = "";
  let jobs = [];
  const updating = new Set();
  const tagBox = h("div", { class: "chips dt-tagbar", role: "group", "aria-label": "Filter by tag" });
  const search = h("div", { class: "search-field" }, icon("search"), input({ type: "search", placeholder: "Search datasets", "aria-label": "Search datasets" }), h("button", { type: "button", class: "clear", "aria-label": "Clear", onclick: () => ((search.querySelector("input").value = ""), (query = ""), draw()) }, icon("close")));
  const listBox = h("div", { class: "dt-list" });
  const emptyBox = h("div", {});
  const refresh = async () => {
    const [d, j] = await Promise.all([load(() => client.datasets.list()), load(() => client.downloads.list())]);
    if (!d.error) datasets = Array.isArray(d.data) ? d.data : datasets;
    if (!j.error) jobs = Array.isArray(j.data) ? j.data : jobs;
    draw();
  };
  const jobFor = (name) => sortJobs(jobs).find((j) => (j.request?.dataset ?? j.dataset) === name && ["running", "queued", "paused"].includes(j.status));
  async function updateNow(d, button) {
    updating.add(d.name);
    const r = await run(button, async () => {
      await client.datasets.update(d.name);
      await refresh();
    }, { ok: "Updating. Only what is new is fetched." });
    if (!r) updating.delete(d.name);
  }
  function openDetails(d) {
    const v = datasetView(d);
    const tagsIn = input({ id: "ds-tags", value: (d.tags ?? []).join(", "), placeholder: "index, daily" });
    const nameIn = input({ id: "ds-name", value: d.name, maxlength: 40 });
    const files = h("div", { class: "dt-files" }, h("p", { class: "hint" }, "Loading…"));
    optional(client.datasets.get(d.name)).then((r) => {
      const list = r.error ? [] : (r.data?.files ?? []);
      files.replaceChildren(list.length ? h("div", { class: "list" }, list.slice(0, 40).map((f) => h("div", { class: "list-row static" }, h("span", { class: "names" }, h("span", { class: "nm" }, f.name), h("span", { class: "sub dt-wrap" }, [f.symbol ? symbolLabel(f.symbol) : null, f.interval, f.rows ? `${formatCount(f.rows)} bars` : null, f.bytes ? formatBytes(f.bytes) : null].filter(Boolean).join(" · "))), f.url || f.name ? btn("Download", "small tinted", (e) => run(e.currentTarget, () => saveFile(f.url ?? `/v1/datasets/${encodeURIComponent(d.name)}/files/${encodeURIComponent(f.name)}`, f.name)), "download") : null))) : hint("File details are not available for this dataset."));
    });
    return modal({
      title: v.title,
      body: h("div", { class: "dt-sheet dt-fields" }, h("p", { class: "dt-files-head" }, classPill(v.cls).el, h("span", {}, v.cls.note)), h("dl", { class: "kv" }, h("dt", {}, "Contents"), h("dd", {}, v.sub || DASH), h("dt", {}, "Range"), h("dd", {}, v.range), h("dt", {}, "Updated"), h("dd", {}, v.updated || DASH)), field("Name", nameIn, "Lower case letters, numbers and dashes. Scripts that read this dataset by name need the new name."), field("Tags", tagsIn, "Separate with commas."), files),
      buttons: [{ label: "Close", value: false }, { label: "Save changes", cls: "primary", onClick: async () => {
        const nn = nameIn.value.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(nn)) {
          toast("Use lower case letters, numbers and dashes for the name.", { tone: "error" });
          return false;
        }
        try {
          await client.datasets.patch(d.name, { ...(nn !== d.name ? { name: nn } : {}), tags: parseTags(tagsIn.value) });
          toast("Saved.");
          refresh();
        } catch (e) {
          toast(isUnavailable(e) ? "This Bridge cannot rename or tag datasets yet." : friendlyError(e).title, { tone: isUnavailable(e) ? "info" : "error" });
          return false;
        }
      } }],
    });
  }
  const active = new Set();
  function draw() {
    const counts = tagCounts(datasets);
    patchList(tagBox, counts, (t) => t.tag, (t, had) => {
      const el = had ?? h("button", { type: "button", class: "chip-btn", onclick: () => ((active.has(el.dataset.tag) ? active.delete(el.dataset.tag) : active.add(el.dataset.tag)), draw()) });
      el.dataset.tag = t.tag;
      setText(el, `${t.tag} ${t.count}`);
      setAttr(el, "aria-pressed", String(active.has(t.tag)));
      return el;
    }, { animate: false });
    tagBox.hidden = !counts.length;
    const shown = filterItems(datasets.map((d) => ({ ...d, description: d.title ?? "" })), { tags: [...active], query });
    const nowMs = Date.now();
    patchList(listBox, shown, (d) => d.name, (d, had) => {
      const v = datasetView(d, nowMs);
      const jb = jobFor(d.name);
      const jv = jb ? jobView(jb, nowMs) : null;
      let el = had;
      if (!el) {
        const title = h("h3", { class: "dt-job-title", "data-gloss": "" });
        const sub = h("p", { class: "dt-job-sub" });
        const range = h("p", { class: "dt-line" });
        const pillSlot = h("span", { class: "dt-clsslot" });
        const prog = h("div", { class: "dt-ds-prog" }, h("div", { class: "bar dt-bar" }, h("span", {})), h("p", { class: "dt-line" }));
        const tagSlot = h("div", {});
        const row = actionsRow();
        el = h("article", { class: "card dt-job dt-ds" }, h("div", { class: "dt-job-head" }, h("div", { class: "dt-job-titles" }, title, sub), pillSlot), range, tagSlot, prog, h("div", { class: "dt-job-foot" }, h("span", {}), row));
        el._p = { title, sub, range, pillSlot, prog, tagSlot, row, cls: "" };
      }
      const p = el._p;
      el._d = d;
      setText(p.title, v.title);
      setText(p.sub, [v.sub, v.updated].filter(Boolean).join(" · "));
      setText(p.range, `Bars from ${v.range}`);
      if (p.cls !== v.cls.label) {
        p.cls = v.cls.label;
        p.pillSlot.replaceChildren(classPill(v.cls).el);
      }
      const sigTags = v.tags.join("|");
      if (p.tagSlot.dataset.sig !== sigTags) {
        p.tagSlot.dataset.sig = sigTags;
        p.tagSlot.replaceChildren(...(v.tags.length ? [chipsOf(v.tags)] : []));
      }
      p.prog.hidden = !jv;
      if (jv) {
        p.prog.firstChild.firstChild.style.width = `${jv.percent}%`;
        setText(p.prog.lastChild, `Updating: ${jv.summary || jv.word}`);
      }
      const upBusy = Boolean(jb);
      if (jb) updating.delete(d.name);
      setActions(p.row, `${upBusy}`, () => [
        act("update", btn(upBusy ? "Updating…" : "Update now", "small primary", (e) => updateNow(el._d, e.currentTarget), "refresh", { disabled: upBusy })),
        act("details", btn("Details", "small tinted", () => openDetails(el._d))),
      ]);
      return el;
    }, { animate: false });
    listBox.hidden = !shown.length;
    emptyBox.replaceChildren(
      ...(datasets.length
        ? shown.length ? [] : [emptyState("search", "No dataset matches", "Clear the search or a tag to see them all.", null, { compact: true })]
        : [emptyState("dataset", "No datasets yet", "Give a download a dataset name and it appears here. After that, Update now fetches only the bars that are new, so you never download the same history twice.", btn("New download", "primary", () => go("#/data/downloads"), "plus"))]),
    );
  }
  search.querySelector("input").addEventListener("input", (e) => ((query = e.target.value), draw()));
  root.append(h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", {}, "Datasets"), h("p", {}, "Histories you keep up to date. Update now fetches only what is new and saves the rest of the broker's room for live use."))), h("div", { class: "dt-toolbar" }, search, tagBox), emptyBox, listBox);
  jobs = (await load(() => client.downloads.list())).data ?? [];
  draw();
  const poll = createPoller({ root, ms: POLL_MS, run: async () => (jobs.some((j) => ["running", "queued"].includes(j.status)) || updating.size ? refresh() : undefined) });
  poll.start();
  return root;
}

// ── Collections tab ──

/**
 * Work out a saved option universe right now and show it in `box`: how many symbols, a few examples, the rule used, where the
 * middle strike's price came from and any warning. A delayed, end-of-day or stale price is refused by the Bridge (422 or 503);
 * the box says so and offers to show the labelled guess, never a quiet one.
 */
async function showResolve(box, name, { sample = 12, allowStale = false, onData = () => {}, keep = null, extra = null } = {}) {
  const r = await optional(client.collections.resolve(name, { allowStale }));
  if (r.error) {
    const n = staleAtmNotice(r.error);
    if (n && !allowStale) {
      put(box, keep, h("div", { class: "alert warn dt-atm", role: "status" }, icon("warn"), h("div", {}, h("strong", {}, n.title), h("span", { class: "detail" }, n.text), h("div", { class: "alert-actions" }, btn("Show it anyway, labelled", "small tinted", () => showResolve(box, name, { sample, allowStale: true, onData, keep }))))));
      return;
    }
    put(box, keep, hint(isUnavailable(r.error) ? "This Bridge cannot work out the symbols yet." : `Could not work out the symbols: ${friendlyError(r.error).title}.`));
    return;
  }
  const m = resolveModel(r.data, { sample });
  onData(r.data);
  put(
    box,
    keep,
    h("p", { class: "dt-preview-count" }, h("strong", {}, plural(m.count, "symbol")), m.resolvedAt ? h("span", { class: "hint" }, ` worked out ${agoText(m.resolvedAt)}`) : null),
    allowStale ? h("div", { class: "alert warn dt-atm", role: "status" }, icon("warn"), h("div", {}, h("span", {}, "Labelled guess: this uses a price that is not real-time. Do not record or trade from it."))) : null,
    m.atm ? h("div", { class: `alert ${m.atm.tone === "ok" && !allowStale ? "ok" : "warn"} dt-atm`, role: "status" }, icon(m.atm.tone === "ok" && !allowStale ? "check" : "warn"), h("div", {}, h("span", {}, m.atm.text))) : null,
    ...m.notes.map((n) => h("p", { class: "hint" }, n)),
    m.sample.length ? h("div", { class: "chips dt-sample" }, m.sample.map((s) => chip(symbolLabel(s))), m.more ? chip(`+${formatInt(m.more)} more`) : null) : null,
    m.rule ? h("p", { class: "hint" }, `Rule used: ${m.rule}`) : null,
    extra ? h("p", { class: "hint" }, extra) : null,
  );
}

/** The collection builder: a fixed list, or an option universe with a live preview of the symbols it works out. */
function openCollectionSheet({ collection = null, kind = "static", names = [], onSaved }) {
  const edit = Boolean(collection);
  const f = {
    name: collection?.name ?? "",
    description: collection?.description ?? "",
    tags: (collection?.tags ?? []).join(", "),
    kind: collection?.kind ?? kind,
    symbols: (collection?.symbols ?? []).join("\n"),
    u: collection?.universe ? { ...defaultUniverse(collection.universe.underlying), ...collection.universe } : defaultUniverse("NIFTY"),
    range: collection?.universe?.strikes?.from !== undefined,
  };
  const others = names.filter((n) => n !== collection?.name);
  return modal({
    title: edit ? "Edit collection" : f.kind === "option-universe" ? "New option universe" : "New collection",
    dirty: () => !edit && (f.name !== "" || f.symbols !== ""),
    body: (close) => {
      const err = h("div", { class: "dt-err", "aria-live": "assertive" });
      const name = input({ id: "co-name", value: f.name, maxlength: 40, placeholder: "For example Nifty 50" });
      const desc = input({ id: "co-desc", value: f.description, maxlength: 120, placeholder: "Optional" });
      const tags = input({ id: "co-tags", value: f.tags, placeholder: "index, weekly" });
      const nameMsg = h("span", { class: "field-msg", hidden: true });
      const kindSeg = seg("Kind of collection", [["static", "Fixed list"], ["option-universe", "Option universe"]], f.kind);
      const kindBody = h("div", { class: "dt-fields" });
      const preview = h("div", { class: "dt-preview", "aria-live": "polite" });
      let seq = 0;
      let timer = null;
      const setUniverse = (patch) => {
        f.u = buildUniverse({ ...f.u, ...patch });
        schedulePreview();
      };
      const schedulePreview = () => {
        clearTimeout(timer);
        timer = setTimeout(paintPreview, 400);
        paintPreviewNow();
      };
      const paintPreviewNow = () => {
        if (f.kind !== "option-universe") return;
        const p = universeProblem(f.u);
        const size = universeSize(f.u);
        put(preview, 
          h("p", { class: "dt-preview-sentence" }, p || universeSentence(f.u)),
          !p ? h("p", { class: "hint" }, size.count === null ? "Working out the symbols…" : `${size.approx ? "About " : ""}${plural(size.count, "symbol")} now. Expiries and the middle strike are worked out again every time a download or recording uses it.`) : null,
        );
      };
      async function paintPreview() {
        if (f.kind !== "option-universe" || universeProblem(f.u)) return;
        const mine = ++seq;
        const r = await optional(client.collections.resolveDraft(f.u));
        if (mine !== seq) return;
        const keep = preview.querySelector(".dt-preview-sentence")?.cloneNode(true);
        if (r.error) {
          if (isUnavailable(r.error) && edit) return showResolve(preview, collection.name, { sample: 8, keep, extra: "This is the saved version. Save to see your changes." });
          const size = universeSize(f.u);
          put(preview, keep ?? "", h("p", { class: "hint" }, isUnavailable(r.error) ? `${size.count === null ? "" : `${size.approx ? "About " : ""}${plural(size.count, "symbol")}. `}The live list shows after you save.` : `The preview did not work: ${friendlyError(r.error).title}.`));
          return;
        }
        drawResolved(r.data, keep);
      }
      function drawResolved(data, keep, extra) {
        const m = resolveModel(data);
        put(preview, 
          keep ?? "",
          h("p", { class: "dt-preview-count" }, h("strong", {}, plural(m.count, "symbol")), m.resolvedAt ? h("span", { class: "hint" }, ` worked out ${agoText(m.resolvedAt)}`) : null),
          m.atm ? h("div", { class: `alert ${m.atm.tone === "ok" ? "ok" : "warn"} dt-atm`, role: "status" }, icon(m.atm.tone === "ok" ? "check" : "warn"), h("div", {}, h("span", {}, m.atm.text))) : null,
          ...m.notes.map((n) => h("p", { class: "hint" }, n)),
          m.sample.length ? h("div", { class: "chips dt-sample" }, m.sample.map((s) => chip(symbolLabel(s))), m.more ? chip(`+${formatInt(m.more)} more`) : null) : null,
          m.rule ? h("p", { class: "hint" }, `Rule used: ${m.rule}`) : null,
          extra ? h("p", { class: "hint" }, extra) : null,
        );
      }
      const drawKind = () => {
        f.kind = kindSeg.value;
        if (f.kind === "static") {
          const ta = h("textarea", { id: "co-syms", rows: 8, placeholder: "NSE:RELIANCE\nNSE:TCS\nNSE:INFY", spellcheck: "false", "aria-describedby": "co-syms-hint" }, f.symbols);
          const msg = h("p", { class: "hint", id: "co-syms-hint", "aria-live": "polite" });
          const paint = () => {
            const r = parseSymbolList(ta.value);
            setText(msg, `${plural(r.symbols.length, "symbol")}${r.duplicates ? `, ${plural(r.duplicates, "repeat")} skipped` : ""}${r.invalid.length ? `. Not recognised: ${r.invalid.slice(0, 4).join(", ")}` : ""}.`);
          };
          ta.addEventListener("input", () => ((f.symbols = ta.value), paint()));
          paint();
          kindBody.replaceChildren(field("Symbols", ta), msg);
          put(preview, );
        } else {
          const und = input({ id: "co-und", value: f.u.underlying, list: "co-und-list", maxlength: 30 });
          und.addEventListener("input", () => setUniverse({ underlying: und.value }));
          const exp = select([...EXPIRY_CHOICES.map((c) => [c.id, c.label]), ["dates", "Specific dates"]], Array.isArray(f.u.expiries) ? "dates" : f.u.expiries, { id: "co-exp" });
          const dates = input({ id: "co-dates", value: Array.isArray(f.u.expiries) ? f.u.expiries.join(", ") : "", placeholder: "2026-11-12, 2026-11-19" });
          const datesField = field("Expiry dates", dates, "Separate with commas.");
          datesField.hidden = exp.value !== "dates";
          exp.addEventListener("change", () => {
            datesField.hidden = exp.value !== "dates";
            setUniverse({ expiries: exp.value === "dates" ? (dates.value.split(/[\s,]+/).filter(Boolean).length ? dates.value.split(/[\s,]+/).filter(Boolean) : []) : exp.value });
          });
          dates.addEventListener("input", () => setUniverse({ expiries: dates.value.split(/[\s,]+/).filter(Boolean) }));
          const mode = seg("Strikes", [["atm", "Around the current price"], ["range", "A fixed range"]], f.range ? "range" : "atm");
          const cnt = input({ id: "co-count", type: "number", min: 1, max: 100, value: f.u.strikes?.count ?? 10, inputmode: "numeric" });
          const cntField = field("Strikes either side", cnt, "10 means the middle strike plus 10 above and 10 below.");
          const lo = input({ id: "co-lo", type: "number", value: f.u.strikes?.from ?? "", inputmode: "numeric" });
          const hi = input({ id: "co-hi", type: "number", value: f.u.strikes?.to ?? "", inputmode: "numeric" });
          const rangeFields = h("div", { class: "form-grid" }, field("Lowest strike", lo), field("Highest strike", hi));
          const showMode = () => ((cntField.hidden = f.range), (rangeFields.hidden = !f.range));
          mode.addEventListener("change", () => {
            f.range = mode.value === "range";
            showMode();
            setUniverse({ strikes: f.range ? { from: lo.value, to: hi.value } : { around: "atm", count: cnt.value } });
          });
          cnt.addEventListener("input", () => setUniverse({ strikes: { around: "atm", count: cnt.value } }));
          for (const el of [lo, hi]) el.addEventListener("input", () => setUniverse({ strikes: { from: lo.value, to: hi.value } }));
          showMode();
          const side = (v, label) => {
            const c = h("input", { type: "checkbox", checked: f.u.sides.includes(v) });
            c.addEventListener("change", () => setUniverse({ sides: [...new Set([...(c.checked ? [v] : []), ...f.u.sides.filter((x) => x !== v)])] }));
            return h("label", { class: "check" }, c, label);
          };
          const toggle = (key, label) => {
            const c = h("input", { type: "checkbox", checked: Boolean(f.u[key]) });
            c.addEventListener("change", () => setUniverse({ [key]: c.checked }));
            return h("label", { class: "check" }, c, label);
          };
          kindBody.replaceChildren(
            h("div", { class: "form-grid" }, field("Index or stock", und), field("Expiry", exp)),
            h("datalist", { id: "co-und-list" }, COMMON_UNDERLYINGS.map((u) => h("option", { value: u }))),
            datesField,
            h("div", { class: "field seg-field" }, h("span", { class: "dt-label" }, "Strikes"), mode),
            cntField,
            rangeFields,
            h("div", { class: "dt-checks" }, side("CE", "Calls"), side("PE", "Puts"), toggle("includeUnderlying", "The index itself"), toggle("includeFuture", "The nearest future")),
          );
          paintPreviewNow();
          paintPreview();
        }
      };
      kindSeg.addEventListener("change", drawKind);
      name.addEventListener("input", () => {
        f.name = name.value;
        const p = collectionNameProblem(f.name, others);
        nameMsg.hidden = !f.name || !p;
        setText(nameMsg, p);
        setAttr(name, "aria-invalid", f.name && p ? "true" : null);
      });
      desc.addEventListener("input", () => (f.description = desc.value));
      tags.addEventListener("input", () => (f.tags = tags.value));
      drawKind();
      const save = btn(edit ? "Save changes" : "Save collection", "primary", async () => {
        const p = collectionNameProblem(f.name, others);
        const showErr = (title, detail) => showFormError(err, title, detail);
        if (p) return showErr(p);
        const body = { name: f.name.trim(), description: f.description.trim(), tags: parseTags(f.tags), kind: f.kind };
        if (f.kind === "static") {
          const r = parseSymbolList(f.symbols);
          if (!r.symbols.length) return showErr("Add at least one symbol.", "Paste them one per line, for example NSE:RELIANCE.");
          body.symbols = r.symbols;
        } else {
          const up = universeProblem(f.u);
          if (up) return showErr(up);
          body.universe = f.u;
        }
        busy(save, true);
        try {
          if (edit) await client.collections.patch(collection.name, body);
          else await client.collections.create(body);
          toast(edit ? "Saved." : "Collection saved.");
          close(true, true);
          onSaved(body.name);
        } catch (e) {
          busy(save, false);
          const fe = friendlyError(e);
          showErr(isUnavailable(e) ? "This Bridge cannot save collections yet" : fe.title, isUnavailable(e) ? "Update the Bridge to the latest version." : fe.detail);
        }
      });
      return h("div", { class: "dt-wiz" }, h("div", { class: "dt-fields" }, h("div", { class: "form-grid" }, field("Name", name), field("Tags", tags, "Separate with commas, for example index, weekly.")), nameMsg, field("Description", desc), h("div", { class: "field seg-field" }, h("span", { class: "dt-label" }, "What kind"), kindSeg), kindBody, preview), h("div", { class: "dt-wiz-foot" }, err, btn("Cancel", "", () => close(false)), save));
    },
    buttons: [],
  });
}

export async function renderCollections() {
  const root = h("div", { class: "dt-tab" });
  const [first, dls, recs, rules, dss] = await Promise.all([load(() => client.collections.list()), load(() => client.downloads.list()), load(() => client.recordings.list()), load(() => client.recordings.rules.list()), load(() => client.datasets.list())]);
  if (first.unavailable) return h("div", { class: "dt-tab" }, notThere("Collections"));
  let cols = Array.isArray(first.data) ? first.data : [];
  const lists = { downloads: dls.data ?? [], recordings: recs.data ?? [], rules: rules.data ?? [], datasets: dss.data ?? [] };
  const active = new Set();
  let query = "";
  const tagBox = h("div", { class: "chips dt-tagbar", role: "group", "aria-label": "Filter by tag" });
  const searchIn = input({ type: "search", placeholder: "Search collections", "aria-label": "Search collections" });
  const search = h("div", { class: "search-field" }, icon("search"), searchIn, h("button", { type: "button", class: "clear", "aria-label": "Clear", onclick: () => ((searchIn.value = ""), (query = ""), draw()) }, icon("close")));
  const listBox = h("div", { class: "list dt-collist" });
  const emptyBox = h("div", {});
  const fileIn = h("input", { type: "file", accept: ".csv,.json,.txt,text/csv,application/json,text/plain", hidden: true, "aria-label": "Import a collection file" });
  const refresh = async (name) => {
    const [c, d, r, u, s] = await Promise.all([load(() => client.collections.list()), load(() => client.downloads.list()), load(() => client.recordings.list()), load(() => client.recordings.rules.list()), load(() => client.datasets.list())]);
    if (!c.error) cols = Array.isArray(c.data) ? c.data : cols;
    lists.downloads = d.data ?? lists.downloads;
    lists.recordings = r.data ?? lists.recordings;
    lists.rules = u.data ?? lists.rules;
    lists.datasets = s.data ?? lists.datasets;
    draw();
    if (name && typeof name === "string") listBox.querySelector(`[data-key="${CSS.escape(name)}"]`)?.focus?.({ preventScroll: true });
  };
  const names = () => cols.map((c) => c.name);
  const toWizard = (c) => go(`#/data/downloads?collection=${encodeURIComponent(c.name)}`);

  async function openDetails(c) {
    const v = collectionView(c);
    const usage = usageOf(c.name, lists);
    const body = h("div", { class: "dt-sheet dt-fields" });
    const symbolsBox = h("div", { class: "dt-preview" }, hint(c.kind === "option-universe" ? "Working out the symbols for right now…" : ""));
    if (c.kind === "option-universe") {
      body.append(h("p", { class: "dt-preview-sentence" }, universeSentence(c.universe)));
      showResolve(symbolsBox, c.name, { sample: 12, onData: (d) => ((c._resolved = d), paintEst()) });
    } else {
      const sy = c.symbols ?? [];
      put(symbolsBox, h("p", { class: "dt-preview-count" }, h("strong", {}, plural(sy.length, "symbol"))), h("div", { class: "chips dt-sample" }, sy.slice(0, 24).map((s) => chip(symbolLabel(s))), sy.length > 24 ? chip(`+${formatInt(sy.length - 24)} more`) : null));
    }
    // The size estimate: symbols x bars x days.
    const ivSel = select(INTERVALS.map((i) => [i.id, i.label]), "5m", { id: "co-iv" });
    const rgSel = select(RANGES.filter((r) => r.id !== "custom").map((r) => [r.id, r.label]), "1y", { id: "co-rg" });
    const est = h("p", { class: "dt-estimate-main", "aria-live": "polite" });
    const paintEst = () => {
      const n = c.kind === "option-universe" ? (c._resolved?.symbols?.length ?? universeSize(c.universe).count ?? 0) : (c.symbols?.length ?? 0);
      const d = rangeDates(rgSel.value, Date.now(), [ivSel.value]);
      const e = estimateJob({ symbols: n, intervals: [ivSel.value], from: d.from, to: d.to });
      setText(est, e.ok ? `${estimateLines(e).size} ${estimateLines(e).calls}` : "Nothing to estimate yet.");
    };
    ivSel.addEventListener("change", paintEst);
    rgSel.addEventListener("change", paintEst);
    paintEst();
    const acts = h(
      "div",
      { class: "dt-sheet-acts" },
      btn("Download history", "small primary", () => (close(), toWizard(c)), "download"),
      btn("Record", "small tinted", () => (close(), openRecordingSheet({ mode: "once", collections: cols, preset: { collection: c.name, kind: c.kind === "option-universe" ? "chain" : "quotes" }, onSaved: () => go("#/data/recordings") })), "record"),
      btn("Edit", "small", () => (close(), openCollectionSheet({ collection: c, names: names(), onSaved: refresh })), "pencil"),
      btn("Duplicate", "small", async (e) => {
        let n = `${c.name} copy`;
        let i = 2;
        while (names().includes(n)) n = `${c.name} copy ${i++}`;
        const r = await run(e.currentTarget, async () => {
          const { name: _n, ...rest } = c;
          delete rest._resolved;
          try {
            await client.collections.duplicate(c.name, { name: n });
          } catch (err) {
            if (!isUnavailable(err)) throw err;
            await client.collections.create({ ...rest, name: n });
          }
          await refresh(n);
        }, { ok: `Made ${n}.` });
        if (r) close();
      }),
      btn("Export CSV", "small", () => saveText(collectionToCsv(c, c._resolved), `${slug(c.name)}.csv`, "text/csv"), "download"),
      btn("Export JSON", "small", () => saveText(collectionToJson(c), `${slug(c.name)}.json`, "application/json"), "download"),
      btn("Delete", "small plain destructive", async (e) => {
        const used = usageOf(c.name, lists);
        if (!(await confirmSheet({ title: `Delete ${c.name}?`, text: `${usageText(used)} Downloads and files already made are kept. Auto-record rules that use it will stop finding symbols.`, confirm: "Delete collection" }))) return;
        const r = await run(e.currentTarget, async () => (await client.collections.remove(c.name), refresh()), { ok: "Deleted." });
        if (r) close();
      }, "trash"),
    );
    let close = () => {};
    body.append(h("p", { class: "hint" }, [v.kindWord, v.description].filter(Boolean).join(" · ")), v.tags.length ? chipsOf(v.tags) : null, symbolsBox, h("div", { class: "dt-estimate-box" }, h("strong", {}, "What a download would cost"), h("div", { class: "form-grid" }, field("Bar size", ivSel), field("How far back", rgSel)), est), h("p", { class: "dt-usage" }, usageText(usage)), acts);
    return modal({
      title: c.name,
      body: (cl) => {
        close = (v2) => cl(v2, true);
        return body;
      },
      buttons: [{ label: "Done", cls: "primary", value: true }],
    });
  }

  function draw() {
    const counts = tagCounts(cols);
    patchList(tagBox, counts, (t) => t.tag, (t, had) => {
      const el = had ?? h("button", { type: "button", class: "chip-btn", onclick: () => ((active.has(el.dataset.tag) ? active.delete(el.dataset.tag) : active.add(el.dataset.tag)), draw()) });
      el.dataset.tag = t.tag;
      setText(el, `${t.tag} ${t.count}`);
      setAttr(el, "aria-pressed", String(active.has(t.tag)));
      return el;
    }, { animate: false });
    tagBox.hidden = !counts.length;
    const shown = filterItems(cols, { tags: [...active], query });
    patchList(listBox, shown, (c) => c.name, (c, had) => {
      const v = collectionView(c);
      let el = had;
      if (!el) {
        const tile = iconTile(v.universe ? "chart" : "folder", v.universe ? "indigo" : "teal");
        el = h("button", { type: "button", class: "list-row dt-col" }, tile, h("span", { class: "names" }, h("span", { class: "nm" }), h("span", { class: "sub dt-wrap" }), h("span", { class: "dt-col-tags" })), h("span", { class: "value" }), icon("chevron"));
        el.querySelector("svg:last-child").classList.add("chev");
        el.addEventListener("click", () => openDetails(el._c));
      }
      el._c = c;
      const names_ = el.querySelector(".names");
      setText(names_.children[0], c.name);
      setText(names_.children[1], [v.kindWord, v.sub, c.description].filter(Boolean).join(" · "));
      const sig = v.tags.join("|");
      if (names_.children[2].dataset.sig !== sig) {
        names_.children[2].dataset.sig = sig;
        names_.children[2].replaceChildren(...(v.tags.length ? [chipsOf(v.tags)] : []));
      }
      setText(el.querySelector(".value"), v.universe ? v.sizeText : "");
      return el;
    }, { animate: false });
    listBox.hidden = !shown.length;
    emptyBox.replaceChildren(
      ...(cols.length
        ? shown.length ? [] : [emptyState("search", "No collection matches", "Clear the search or a tag to see them all.", null, { compact: true })]
        : [emptyState("folder", "No collections yet", "A collection is a saved list of symbols, or an option universe that works out its own strikes and expiries. Downloads, recordings and sheets can all use it instead of pasting symbols again.", [btn("New option universe", "primary", () => openCollectionSheet({ kind: "option-universe", names: names(), onSaved: refresh }), "plus"), btn("New list of symbols", "tinted", () => openCollectionSheet({ kind: "static", names: names(), onSaved: refresh }))])]),
    );
  }
  fileIn.addEventListener("change", async () => {
    const file = fileIn.files?.[0];
    fileIn.value = "";
    if (!file) return;
    const text = await file.text();
    const base = file.name.replace(/\.[^.]+$/, "").slice(0, 40);
    const r = parseCollectionImport(text, base);
    if (r.error) return toast(r.error, { tone: "error" });
    let name = r.body.name || base;
    let i = 2;
    const have = names();
    const stem = name;
    while (have.some((n) => n.toLowerCase() === name.toLowerCase())) name = `${stem} ${i++}`;
    try {
      await client.collections.create({ ...r.body, name });
      toast(`Imported ${name}${r.skipped ? `. ${plural(r.skipped, "entry", "entries")} were not recognised and left out.` : "."}`);
      refresh(name);
    } catch (e) {
      toast(isUnavailable(e) ? "This Bridge cannot save collections yet." : friendlyError(e).title, { tone: isUnavailable(e) ? "info" : "error" });
    }
  });
  searchIn.addEventListener("input", () => ((query = searchIn.value), draw()));
  root.append(
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", {}, "Collections"), h("p", {}, "Named, tagged lists of symbols. Downloads, recordings, sheets and the Python library can all use one instead of pasting symbols again. An option universe works out its own strikes and expiries each time.")), h("div", { class: "sec-acts" }, btn("New option universe", "primary", () => openCollectionSheet({ kind: "option-universe", names: names(), onSaved: refresh }), "plus"), btn("New list", "tinted", () => openCollectionSheet({ kind: "static", names: names(), onSaved: refresh })), btn("Import", "", () => fileIn.click(), "upload"), fileIn)),
    h("div", { class: "dt-toolbar" }, search, tagBox),
    emptyBox,
    listBox,
  );
  draw();
  return root;
}
