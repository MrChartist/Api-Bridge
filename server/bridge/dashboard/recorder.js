// Data recorder (#/recorder, docs/spec/p1-01-recorder.md §7.1): what the Bridge records with the browser closed.
// A status strip (state, feeding account, today, disk); coverage per chain (recorded / expected minutes, gaps, last
// snapshot age; a row opens its gap list) with the refused chains below it; the recorder's share of the live feed and
// of the REST budget; disk use; the settings with a live plan verdict (local admin only); which brokers can record
// what (generated from the code, the same rows as docs/guides/recorder.md); the footer.
//
// Data: GET /v1/options/recorder every 10 s while the tab is visible (the feasibility rows once), POST
// /v1/options/recorder/plan 400 ms after a settings edit, PUT /v1/options/recorder/config on Save.
//
// Pure view-model helpers (statePill, tilesModel, coverageRows, budgetModel, diskModel, recorderAttention, verdictView, formBody,
// fitToCarry, stocksFromSearch, gapRange, stackCoverage) are exported for recorder.test.mjs; DOM code runs only in a
// browser. Numbers become text through format.js only. Copy describes facts and never advises (copyRules.mjs).
import { alertBox, api, app, emptyState, h, icon, istTime, meterRow, modal, mountToolbarCtx, optional, pill, sheetPopover, toast } from "./app.js";
import { DASH, ageText, formatDayMonth, formatFixed, formatInt, isFigure } from "./format.js";
import { every, keepFocus } from "./views.js";

/** The page footer (§7.1 panel 6). */
export const FOOTER = "Recorded on this computer from your own broker account, for your personal use. Nothing is uploaded.";
export const DEMO_FOOTER = "Demo recordings are sample data and are kept for 3 days in a separate folder.";
/** Below this width the coverage table stacks into one card per chain and the settings open in a sheet. */
export const PHONE_BELOW_PX = 720;
export const stackCoverage = (width) => Number(width) < PHONE_BELOW_PX;
export const POLL_MS = 10_000;
export const PLAN_DEBOUNCE_MS = 400;
/** The indices the recorder knows by default, in priority order (recorder/config.mjs DEFAULT_INDICES). */
export const INDEX_CHOICES = Object.freeze(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const num = (v) => (isFigure(v) ? Number(v) : null);
const plural = (n, one, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`;
const pct = (share) => `${formatInt(Number(share) * 100)}%`;
const onThisComputer = () => typeof location !== "undefined" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
const toMs = (v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);

// ── Pure view-model ──

const STATES = Object.freeze({
  recording: ["Recording", "ok"],
  "idle-closed": ["Market closed", ""],
  paused: ["Paused", ""],
  "not-configured": ["Not configured", "warn"],
  degraded: ["Degraded", "warn"],
  "holiday-suspected": ["Holiday suspected", "warn"],
  "disk-full": ["Disk full", "bad"],
  error: ["Error", "bad"],
});
/** The state word and its tone (ok / warn / bad / "" neutral) for a recorder state. Unknown states read as given. */
export function statePill(state) {
  const s = STATES[state];
  return s ? { text: s[0], tone: s[1] } : { text: state ? String(state) : DASH, tone: "" };
}

/** Binary units ("41.7 MB", "10.0 GB", "512 B"): 1 decimal under 100, none above. Missing → "--". */
export function bytesText(n) {
  if (!isFigure(n) || Number(n) < 0) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 || v >= 100 ? formatInt(v) : formatFixed(v, 1)} ${units[i]}`;
}

const SOURCE_WORD = Object.freeze({ stream: "Stream", rest: "REST", "nse-backup": "NSE website", backfill: "Sample back-fill" });
export const sourceWord = (s) => SOURCE_WORD[s] ?? (s ? String(s) : DASH);
const BROKER_WORD = (b) => (b === "demo" ? "Demo" : b ? `${b[0].toUpperCase()}${b.slice(1)}` : DASH);

/** Gap reasons in a few plain words (the full sentence is the gap's detail). */
export const GAP_REASON = Object.freeze({
  "stream-down": "Feed down",
  budget: "REST budget used",
  "broker-error": "Broker error",
  "session-expired": "Session expired",
  "not-subscribed-yet": "Subscribing",
  "bridge-down": "Bridge not running",
  "disk-full": "Disk full",
  paused: "Paused",
});
export const gapReason = (r) => GAP_REASON[r] ?? (r ? String(r) : "Gap");

/** "10:41–10:43" (one minute: "10:41"). Accepts epoch ms or ISO times. */
export function gapRange(g) {
  const hm = (v) => (Number.isFinite(toMs(v)) ? istTime(new Date(toMs(v)).toISOString()).slice(0, 5) : DASH);
  const a = hm(g?.from);
  const b = hm(g?.to ?? g?.from);
  return a === b ? a : `${a}–${b}`;
}

/** The four status tiles: [{ key, label, value, sub, tone, glyph }]. */
export function tilesModel(st) {
  const s = statePill(st?.state);
  const acc = st?.account ?? null;
  const today = st?.today ?? {};
  const disk = st?.disk ?? {};
  const feed = acc?.feedAccount && acc.feedAccount !== acc.id ? ` · feed ${acc.feedAccount}` : "";
  const last = today.lastSnapshotAt ? `last ${istTime(today.lastSnapshotAt)}` : "nothing yet today";
  return [
    { key: "state", label: "State", value: s.text, tone: s.tone, glyph: "clock", sub: st?.stateDetail ?? "" },
    {
      key: "account",
      label: "Feeding account",
      value: acc?.id ?? (acc ? "Hidden" : "None"),
      glyph: "accounts",
      sub: acc ? [`${BROKER_WORD(acc.broker)} · ${acc.chosen === "config" ? "chosen" : "auto"} · ${acc.session ?? DASH}${feed}`, acc.costNote ?? ""].filter(Boolean).join(". ") : "No connected account serves option chains.",
    },
    {
      key: "today",
      label: "Today",
      value: formatInt(today.snapshots ?? 0),
      glyph: "list",
      sub: `snapshots · ${formatInt(today.legRows ?? 0)} leg rows · ${plural(today.gapMinutes ?? today.gapSlots ?? 0, "gap minute")} · ${last}`,
    },
    {
      key: "disk",
      label: "Disk",
      value: bytesText(disk.bytes),
      glyph: "columns",
      sub: `${bytesText(disk.todayBytes)} today · ${plural(disk.days ?? 0, "day")} kept of ${formatInt(disk.retentionDays)} · ${bytesText(disk.freeBytes)} free`,
    },
  ];
}

/** Sort order of recorded rows: indices first (in INDEX_CHOICES priority), then stocks by name; each by expiry. */
const rowOrder = (r) => [r.kind === "stock" ? 1 : 0, INDEX_CHOICES.indexOf(r.underlying) < 0 ? 99 : INDEX_CHOICES.indexOf(r.underlying), r.kind === "stock" ? r.underlying : "", r.expiry ?? ""];
const byOrder = (a, b) => {
  const x = rowOrder(a);
  const y = rowOrder(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

/**
 * Coverage rows, recorded chains first (indices in priority order, then stocks; each by expiry), then the refused
 * ones (`refused: true`, greyed, with the reason). Figures are minutes: each slot stands for its chain's cadence
 * (`*Minutes` from the status; older statuses: slots × everyMinutes). A chain with nothing due yet is `waiting`.
 * @returns {Array<object>}
 */
export function coverageRows(st) {
  const plan = new Map((st?.plan?.chains ?? []).map((c) => [`${c.underlying}|${c.expiry}`, c]));
  const rows = (st?.coverage ?? []).map((c) => {
    const p = plan.get(`${c.underlying}|${c.expiry}`) ?? {};
    const slotMin = num(c.everyMinutes ?? p.everyMinutes) ?? 1;
    const minutes = (m, slots) => num(m) ?? (num(slots) ?? 0) * slotMin;
    const expected = minutes(c.expectedMinutes, c.expectedSlots);
    const recorded = minutes(c.recordedMinutes, c.recordedSlots);
    const gapMin = minutes(c.gapMinutes, c.gapSlots);
    const waiting = expected <= 0 && recorded <= 0;
    const ratio = expected > 0 ? Math.min(1, recorded / expected) : null;
    const gaps = c.gaps ?? [];
    const every = num(c.everyMinutesNow) ?? slotMin;
    return {
      key: `${c.underlying}|${c.expiry}`,
      refused: false,
      waiting,
      underlying: c.underlying,
      expiry: c.expiry,
      expiryText: formatDayMonth(c.expiry),
      kind: c.kind ?? p.kind ?? null,
      every: `${formatInt(every)} min`,
      source: sourceWord(c.source ?? p.source),
      sourceKey: c.source ?? p.source ?? null,
      strikes: `±${formatInt(c.strikesEachSide ?? p.strikesEachSide)}`,
      recorded,
      expected,
      ratio,
      tone: ratio === null ? "" : ratio >= 0.99 ? "ok" : ratio >= 0.9 ? "warn" : "bad",
      recText: waiting ? "Not due yet" : `${formatInt(recorded)} / ${formatInt(expected)} min`,
      gapMinutes: gapMin,
      gapText: waiting ? DASH : gapMin ? `${formatInt(gapMin)} min` : "None",
      lastGap: gaps.length ? `${gapRange(gaps[gaps.length - 1])} ${gapReason(gaps[gaps.length - 1].reason).toLowerCase()}` : "",
      gaps: gaps.map((g) => ({ ...g, minutes: num(g.minutes) ?? (num(g.slots) ?? 1) * slotMin })),
      last: c.lastSlot ? istTime(c.lastSlot) : DASH,
      lastAge: isFigure(c.lastAgeMs) ? ageText(c.lastAgeMs) : "",
      partial: num(c.partialSlots) ?? 0,
    };
  });
  rows.sort(byOrder);
  const refused = (st?.plan?.refused ?? []).map((r) => ({
    key: `refused|${r.underlying}|${r.expiry ?? ""}`,
    refused: true,
    underlying: r.underlying,
    expiry: r.expiry ?? null,
    expiryText: r.expiry ? formatDayMonth(r.expiry) : "All expiries",
    reason: r.reason === "capacity" ? "Over capacity" : r.reason === "not-offered" ? "Not offered" : r.reason ? String(r.reason).replace(/-/g, " ") : "Refused",
    detail: r.detail ?? "",
  }));
  return [...rows, ...refused];
}

/** The coverage card's sub-title counts: "11 chains recording · 9 waiting · 1 not recorded". */
export function coverageCounts(rows) {
  const waiting = rows.filter((r) => !r.refused && r.waiting).length;
  const recording = rows.filter((r) => !r.refused && !r.waiting).length;
  const refused = rows.filter((r) => r.refused).length;
  return [recording || !waiting ? `${plural(recording, "chain")} recording` : null, waiting ? `${formatInt(waiting)} waiting` : null, refused ? `${formatInt(refused)} not recorded` : null].filter(Boolean).join(" · ");
}

/**
 * The budget panel: { feed: { used, cap, text } | null, feedNote, rest: { used, cap, text } | null, restWhy, planned }.
 */
export function budgetModel(st) {
  const cap = st?.plan?.capacity ?? {};
  const s = cap.stream ?? {};
  const r = cap.rest ?? {};
  const b = st?.budget ?? {};
  const feed = num(s.cap) > 0 ? { used: num(s.used) ?? 0, cap: num(s.cap), text: `${formatInt(s.used ?? 0)} of ${formatInt(s.cap)} (${pct(s.share ?? 0)} of ${formatInt(s.feedLimit)})` } : null;
  const feedNote = feed ? "" : st?.sources?.stream === false ? "Live feed turned off in the settings." : "This account has no live feed the recorder can use.";
  const restOn = r.allowed !== false && num(b.restCapPerMinute) > 0;
  const rest = restOn ? { used: num(b.restCallsLastMinute) ?? 0, cap: num(b.restCapPerMinute), text: `${formatInt(b.restCallsLastMinute ?? 0)} of ${formatInt(b.restCapPerMinute)} calls/min (${pct(b.share ?? 0.5)} of ${formatInt(b.brokerPerMinute)})` } : null;
  const restWhy = restOn ? "" : (r.why ?? (st?.sources?.rest === false ? "REST turned off in the settings." : "No REST budget for the recorder on this account."));
  const planned = restOn && isFigure(b.plannedPerMinute) ? `Planned: ${plural(b.plannedPerMinute, "call")} a minute. Your own requests always go first.` : "";
  return { feed, feedNote, rest, restWhy, planned };
}

/** The disk panel: { used, cap, text, lines[] }. */
export function diskModel(st) {
  const d = st?.disk ?? {};
  const used = num(d.bytes) ?? 0;
  const cap = num(d.maxBytes) ?? 0;
  return {
    used,
    cap,
    text: `${bytesText(used)} of ${bytesText(cap)}`,
    lines: [
      ["Today", bytesText(d.todayBytes)],
      ["Days kept", `${formatInt(d.days ?? 0)} of ${formatInt(d.retentionDays)}`],
      ["Oldest day", d.oldestDay ? formatDayMonth(d.oldestDay) : DASH],
      ["Free on this disk", bytesText(d.freeBytes)],
    ],
  };
}

/**
 * What needs attention on the recorder (pure), most urgent first: [{ tone: "bad" | "warn", title, detail, action? }].
 * Stopped (disk full, an error), nothing set up, gaps, the feeding account logged out, the disk or the REST share
 * nearly used, then the Bridge's own warnings (`extra`, plain strings) and a suspected holiday.
 * @param {object} st  GET /v1/options/recorder
 * @param {{ extra?: string[] }} [o]
 */
export function recorderAttention(st, { extra = [] } = {}) {
  const out = [];
  const state = st?.state;
  if (state === "disk-full") out.push({ tone: "bad", title: "The disk is full, so recording has stopped", detail: "Free some space on this disk, or keep fewer days in the settings below." });
  else if (state === "error") out.push({ tone: "bad", title: "The recorder stopped with an error", detail: st?.stateDetail || "The Bridge's log has the reason." });
  else if (state === "not-configured") out.push({ tone: "warn", title: "Nothing is set up to record", detail: st?.stateDetail || "Choose the indices and the account in the settings below." });
  else if (state === "degraded") out.push({ tone: "warn", title: "Recording with gaps", detail: st?.stateDetail || "Some chains are missing minutes; the coverage table shows which." });
  const acc = st?.account;
  if (acc?.id && ["expired", "missing", "error"].includes(acc.session)) {
    out.push({ tone: acc.session === "missing" ? "warn" : "bad", title: `${acc.id} is not logged in`, detail: "The recorder reads chains through this account. Log in again and recording carries on with the next minute.", action: { label: "Accounts", href: "#/accounts" } });
  }
  const d = st?.disk ?? {};
  const share = num(d.maxBytes) > 0 ? (num(d.bytes) ?? 0) / num(d.maxBytes) : null;
  if (state !== "disk-full" && share !== null && share >= 0.75) out.push({ tone: share >= 0.9 ? "bad" : "warn", title: `Recordings use ${pct(share)} of their disk allowance`, detail: `${bytesText(d.bytes)} of ${bytesText(d.maxBytes)}. The oldest days are dropped once it is full.` });
  const b = st?.budget ?? {};
  if (num(b.restCapPerMinute) > 0 && (num(b.restCallsLastMinute) ?? 0) / num(b.restCapPerMinute) >= 0.9) out.push({ tone: "warn", title: "The recorder is using its whole REST share", detail: "New chains wait for the next minute. Your own requests still go first." });
  for (const w of extra) if (w) out.push({ tone: "warn", title: String(w), detail: "" });
  if (st?.holidaySuspected) out.push({ tone: "warn", title: "Today looks like an unlisted holiday", detail: "The first minutes had no change and no volume. Today's records are kept but left out of reads unless asked for." });
  const rank = { bad: 0, warn: 1 };
  return out.map((x, i) => ({ x, i })).sort((p, q) => rank[p.x.tone] - rank[q.x.tone] || p.i - q.i).map((p) => p.x);
}

/** The plan verdict above Save: { text, tone: "ok" | "warn" | "busy" | "bad" }. */
export function verdictView(result, { busy = false, error = null } = {}) {
  if (error) return { text: error, tone: "bad" };
  if (busy && !result) return { text: "Checking what this account can carry…", tone: "busy" };
  if (!result) return { text: "", tone: "" };
  return { text: result.message ?? "", tone: result.ok ? "ok" : "warn" };
}

/** The settings form's starting values from the status settings. */
export function formFrom(settings = {}) {
  return {
    enabled: settings.enabled !== false,
    account: settings.account ?? null,
    indices: [...(settings.indices ?? INDEX_CHOICES)],
    indexExpiries: settings.indexExpiries ?? 3,
    indexStrikes: settings.indexStrikes ?? 40,
    stocks: [...(settings.stocks ?? [])],
    stockStrikes: settings.stockStrikes ?? 15,
    stockEveryMinutes: settings.stockEveryMinutes ?? 5,
    budgetShare: settings.budgetShare ?? 0.5,
    streamShare: settings.streamShare ?? 0.6,
    retentionDays: settings.retentionDays ?? 365,
    sources: { stream: true, rest: true, nseBackup: false, ...(settings.sources ?? {}) },
  };
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : dflt;
};

/**
 * The body for /plan and PUT /config from the form (bounded to the schema; indices in the default priority order).
 * `acknowledge`: the "I understand" of the NSE website backup, sent with the write that turns it on.
 */
export function formBody(f, { acknowledge = false } = {}) {
  const order = (u) => (INDEX_CHOICES.indexOf(u) < 0 ? 99 : INDEX_CHOICES.indexOf(u));
  const body = {
    enabled: Boolean(f.enabled),
    account: f.account || null,
    indices: [...new Set(f.indices)].sort((a, b) => order(a) - order(b)),
    indexExpiries: clampInt(f.indexExpiries, 1, 4, 3),
    indexStrikes: clampInt(f.indexStrikes, 1, 60, 40),
    stocks: [...new Set(f.stocks)].slice(0, 200),
    stockStrikes: clampInt(f.stockStrikes, 1, 30, 15),
    stockEveryMinutes: [5, 10, 15].includes(Number(f.stockEveryMinutes)) ? Number(f.stockEveryMinutes) : 5,
    budgetShare: clampNum(f.budgetShare, 0.05, 0.5, 0.5),
    streamShare: clampNum(f.streamShare, 0.1, 0.9, 0.6),
    retentionDays: clampInt(f.retentionDays, 7, 3650, 365),
    sources: { stream: f.sources?.stream !== false, rest: f.sources?.rest !== false, nseBackup: Boolean(f.sources?.nseBackup) },
  };
  if (acknowledge && body.sources.nseBackup) body.acknowledgeNseTerms = true;
  return body;
}

/**
 * "Use what fits" after 422 CAPACITY_EXCEEDED: keep only what the account can carry (order kept). Index chains are
 * planned nearest expiry first, so a kept index whose later expiries were refused lowers the expiry count (by the most
 * refused for any kept index): trimming the lists alone would ask for the same chains again.
 * @param {object} f  the form
 * @param {{ indices?: string[], stocks?: string[] }} canCarry
 * @param {Array<{ underlying: string, kind?: string }>} [refused]  the 422's refused chains
 */
export function fitToCarry(f, canCarry, refused = []) {
  const idx = new Set(canCarry?.indices ?? []);
  const stk = new Set(canCarry?.stocks ?? []);
  const indices = f.indices.filter((u) => idx.has(u));
  const cut = new Map();
  for (const r of refused ?? []) if (r && r.kind !== "stock" && indices.includes(r.underlying)) cut.set(r.underlying, (cut.get(r.underlying) ?? 0) + 1);
  const most = Math.max(0, ...cut.values());
  return { ...f, indices, stocks: f.stocks.filter((u) => stk.has(u)), indexExpiries: Math.max(1, Number(f.indexExpiries) - most) };
}

/** Exchanges whose derivatives the recorder plans (equity F&O); MCX and CDS contracts are not stock options. */
export const STOCK_DERIV_EXCHANGES = Object.freeze(["NFO", "BFO"]);

/**
 * Stock underlyings from an instrument search answer: equity derivatives only (NFO/BFO, not MCX or CDS), unique,
 * not an index, not already chosen.
 */
export function stocksFromSearch(rows, chosen = []) {
  const skip = new Set([...INDEX_CHOICES, ...chosen]);
  const out = [];
  for (const r of rows ?? []) {
    if (r?.exchange && !STOCK_DERIV_EXCHANGES.includes(String(r.exchange).toUpperCase())) continue;
    if (r?.kind && !["FUT", "OPT"].includes(String(r.kind).toUpperCase())) continue;
    const u = String(r?.underlying ?? "").toUpperCase();
    if (!u || skip.has(u) || out.includes(u) || !/^[A-Z0-9&-]{1,30}$/.test(u)) continue;
    out.push(u);
  }
  return out;
}

/** The note under the feasibility table's title for the account in use. */
export function feasibilityNote(rows, broker) {
  const r = (rows ?? []).find((x) => x.broker === broker);
  return r ? `${r.label}: index chains ${r.indices}; stocks ${r.stocks}.` : "";
}

// ── DOM ──

const dot = (tone) => h("span", { class: `rec-dot${tone ? ` ${tone}` : ""}`, "aria-hidden": "true" });

function tileEl(t) {
  return h(
    "section",
    { class: `desk-panel stat rec-tile`, "data-tile": t.key },
    h("div", { class: "stat-head" }, h("span", { class: "label" }, t.label)),
    h("span", { class: "value" }, t.key === "state" ? dot(t.tone) : null, h("span", { class: "rec-val" }, t.value)),
    t.sub ? h("span", { class: "sub" }, t.sub) : null,
  );
}

/** Open the OI page on this chain (the desk's shared prefs). */
function openOnOi(underlying, expiry) {
  try {
    const slot = "mcb.dashboard.desk";
    const prefs = JSON.parse(app.local.get(slot) ?? "{}") ?? {};
    app.local.set(slot, JSON.stringify({ ...prefs, underlying, expiry }));
  } catch {
    /* storage unavailable: the OI page opens on its own choice */
  }
  location.hash = "#/oi";
}

function gapSheet(trigger, r, within = null) {
  const list = r.gaps.length
    ? h(
        "ul",
        { class: "rec-gaps" },
        [...r.gaps].reverse().map((g) => h("li", {}, h("span", { class: "rec-gap-when" }, gapRange(g)), h("span", { class: "rec-gap-what" }, h("strong", {}, `${gapReason(g.reason)} · ${formatInt(g.minutes)} min`), g.detail ? h("span", {}, g.detail) : null))),
      )
    : h("p", { class: "muted small rec-gap-none" }, r.waiting ? "Nothing is due for this chain yet today." : r.recorded >= r.expected ? "No gaps today. Every expected minute was recorded." : "No gaps are listed for today.");
  const body = h(
    "div",
    { class: "rec-gap-body" },
    h("p", { class: "muted small" }, `${r.waiting ? "Not due yet" : `${r.recText} recorded`} · ${r.source} · every ${r.every} · ${r.strikes} strikes. Gaps are never filled in.`),
    list,
    h("div", { class: "rec-gap-acts" }, h("button", { type: "button", class: "small", onclick: () => openOnOi(r.underlying, r.expiry) }, icon("bars"), "Open on OI page")),
  );
  // `within`: the coverage card, so on wide screens the popover opens from the row's left edge inside the card
  // (anchored to the narrow name button alone it was pushed over the sidebar and the row itself).
  sheetPopover({ trigger, title: `${r.underlying} ${r.expiryText}`, body, cls: "rec-pop", within });
}

/** The coverage table: our own markup on the shared table classes (stacks on phones), rows act as buttons. */
function coverageTable(rows, within = null) {
  const head = ["Underlying", "Expiry", "Source", "Strikes", "Recorded", "Gaps", "Last"];
  const body = rows.map((r) => {
    if (r.refused) {
      return h(
        "tr",
        { class: "rec-refused" },
        h("td", { class: "lead", "data-label": "Underlying" }, h("span", { class: "rec-u" }, r.underlying), h("span", { class: "rec-exp-m" }, r.expiryText)),
        h("td", { class: "c-exp", "data-label": "Expiry" }, r.expiryText),
        h("td", { class: "c-status", "data-label": "Status" }, pill(r.reason)),
        h("td", { class: "wrap rec-why", colspan: "4", "data-label": "Why" }, r.detail),
      );
    }
    const open = h("button", { type: "button", class: "rec-row-btn", "aria-haspopup": "dialog", "aria-label": r.waiting ? `${r.underlying} ${r.expiryText}: not due yet. Show details` : `${r.underlying} ${r.expiryText}: ${r.recText} recorded, ${r.gapText === "None" ? "no" : r.gapText} gaps. Show gaps` }, h("span", { class: "rec-u" }, r.underlying), h("span", { class: "rec-exp-m" }, r.expiryText), r.kind === "stock" ? h("span", { class: "rec-kind" }, "Stock") : null);
    open.addEventListener("click", () => gapSheet(open, r, within));
    const bar = r.waiting ? null : h("span", { class: `bar rec-bar ${r.tone}`.trim(), "aria-hidden": "true" }, h("span"));
    if (bar) bar.firstChild.style.width = `${Math.round((r.ratio ?? 0) * 100)}%`;
    const tr = h(
      "tr",
      { class: "rec-row", "data-key": r.key },
      h("td", { class: "lead", "data-label": "Underlying" }, open),
      h("td", { class: "c-exp", "data-label": "Expiry" }, r.expiryText),
      h("td", { class: "c-src", "data-label": "Source" }, h("span", { class: `rec-src src-${r.sourceKey ?? "x"}` }, r.source), h("span", { class: "rec-age" }, `every ${r.every}`)),
      h("td", { class: "num c-k", "data-label": "Strikes" }, r.strikes),
      h("td", { class: `num rec-cov c-rec${r.waiting ? " rec-wait" : ""}`, "data-label": "Recorded" }, h("span", { class: "rec-cov-t" }, r.recText), bar),
      h("td", { class: `num c-gap${r.gapSlots ? " rec-has-gap" : ""}`, "data-label": "Gaps", title: r.lastGap || undefined }, r.gapText),
      h("td", { class: "num c-last", "data-label": "Last" }, h("span", {}, r.last), r.lastAge ? h("span", { class: "rec-age" }, r.lastAge) : null),
    );
    // The whole row opens the gap list with a pointer; the keyboard uses the row's button.
    tr.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("button")) return;
      gapSheet(open, r, within);
    });
    return tr;
  });
  return h(
    "div",
    { class: "table-wrap stack rec-cov-table" },
    h("table", {}, h("caption", { class: "sr-only" }, "Recorded chains today"), h("thead", {}, h("tr", {}, head.map((t, i) => h("th", { scope: "col", class: i >= 3 ? "num" : undefined }, t)))), h("tbody", {}, body)),
  );
}

function stepper(label, value, { min, max, onChange, disabled = false }) {
  const out = h("output", { class: "rec-step-v", "aria-live": "off" }, formatInt(value));
  let v = value;
  const set = (n) => {
    v = Math.min(max, Math.max(min, n));
    out.textContent = formatInt(v);
    dec.disabled = disabled || v <= min;
    inc.disabled = disabled || v >= max;
    onChange(v);
  };
  const dec = h("button", { type: "button", class: "icon-btn tiny rec-step-b", "aria-label": `Fewer ${label.toLowerCase()}`, disabled: disabled || v <= min, onclick: () => set(v - 1) }, "−");
  const inc = h("button", { type: "button", class: "icon-btn tiny rec-step-b", "aria-label": `More ${label.toLowerCase()}`, disabled: disabled || v >= max, onclick: () => set(v + 1) }, "+");
  return h("div", { class: "rec-step", role: "group", "aria-label": label }, h("span", { class: "rec-step-l" }, label), h("div", { class: "rec-step-c" }, dec, out, inc));
}

function slider(label, value, { min, max, step, text, onChange, disabled = false, hint = "" }) {
  const val = h("span", { class: "rec-range-v" }, text(value));
  const input = h("input", { type: "range", class: "rec-range", min: String(min), max: String(max), step: String(step), value: String(value), disabled, "aria-label": label });
  const paint = () => input.style.setProperty("--fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  input.addEventListener("input", () => {
    val.textContent = text(Number(input.value));
    paint();
    onChange(Number(input.value));
  });
  paint();
  return h("label", { class: "field rec-slider" }, h("span", { class: "rec-range-h" }, h("span", {}, label), val), input, hint ? h("span", { class: "hint" }, hint) : null);
}

function switchRow(label, checked, { hint = "", disabled = false, onChange }) {
  const input = h("input", { type: "checkbox", role: "switch", disabled });
  input.checked = Boolean(checked);
  input.addEventListener("change", () => onChange(input.checked, input));
  return h("label", { class: "rec-switch-row" }, h("span", { class: "rec-sw-text" }, h("strong", {}, label), hint ? h("span", { class: "hint" }, hint) : null), h("span", { class: "switch" }, input, h("i", { "aria-hidden": "true" })));
}

const NSE_TERMS =
  "The NSE website's option chain is meant for people reading it in a browser. Reading it from a program may be against its terms of use, and NSE may block this computer. The Bridge reads it only when your broker cannot carry a chain, at most once a minute per chain.";

/**
 * The settings form. Calls onPlan(body) (debounced by the caller) on every edit and onSave(body) on Save.
 * @returns {{ el: HTMLElement, verdict: (v: {text: string, tone: string}) => void, problem: (node: Node | null) => void, form: () => object, setForm: (f: object) => void, saving: (on: boolean) => void }}
 */
function settingsForm({ status, accounts, canEdit, demo, onPlan, onSave, inSheet = false }) {
  let f = formFrom(status.settings);
  let acknowledged = Boolean(f.sources.nseBackup);
  const dis = !canEdit;
  const saved = () => JSON.stringify(formBody(formFrom(status.settings)));
  // Undo is live only when the form differs from the saved settings.
  const syncUndo = () => {
    resetBtn.disabled = dis || JSON.stringify(formBody(f)) === saved();
  };
  const edited = () => {
    syncUndo();
    onPlan(formBody(f));
  };
  const host = h("div", { class: "rec-form-host" });
  const verdictEl = h("p", { class: "rec-verdict", role: "status", "aria-live": "polite" });
  const problemEl = h("div", { class: "rec-problem" });
  const saveBtn = h("button", { type: "button", class: "primary", disabled: dis }, icon("check"), "Save");
  const resetBtn = h("button", { type: "button", class: "small quiet rec-reset", disabled: true }, "Undo changes");
  saveBtn.addEventListener("click", () => {
    if (inSheet && f.sources.nseBackup && !acknowledged && !formFrom(status.settings).sources.nseBackup) {
      toast("Tick “I understand” under NSE website backup first", { tone: "info" });
      return;
    }
    onSave(formBody(f, { acknowledge: acknowledged }));
  });
  resetBtn.addEventListener("click", () => {
    f = formFrom(status.settings);
    acknowledged = Boolean(f.sources.nseBackup);
    draw();
    edited();
  });

  function draw() {
    // Account.
    const sel = h("select", { class: "rec-acct", disabled: dis, "aria-label": "Account that records" }, h("option", { value: "" }, "Auto"), accounts.map((a) => h("option", { value: a.id }, `${a.id} · ${a.label ?? BROKER_WORD(a.broker)}`)));
    sel.value = f.account ?? "";
    sel.addEventListener("change", () => {
      f.account = sel.value || null;
      edited();
    });
    // Indices.
    const indexBoxes = INDEX_CHOICES.map((u) => {
      const box = h("input", { type: "checkbox", disabled: dis });
      box.checked = f.indices.includes(u);
      box.addEventListener("change", () => {
        f.indices = box.checked ? [...f.indices, u] : f.indices.filter((x) => x !== u);
        edited();
      });
      return h("label", { class: "check rec-check" }, box, h("span", {}, u));
    });
    // Stocks.
    const chips = h("div", { class: "chips rec-stock-chips" });
    const drawChips = () =>
      fill(
        chips,
        f.stocks.length
          ? f.stocks.map((u) =>
              h(
                "span",
                { class: "rec-stock" },
                h("span", {}, u),
                h("button", { type: "button", class: "icon-btn tiny", disabled: dis, "aria-label": `Stop recording ${u}`, onclick: () => ((f.stocks = f.stocks.filter((x) => x !== u)), drawChips(), edited()) }, icon("close")),
              ),
            )
          : h("span", { class: "muted small" }, "No stocks. Indices are recorded by default; stocks are opt-in."),
      );
    drawChips();
    const found = h("div", { class: "chips rec-found", "aria-live": "polite" });
    const search = h("input", { type: "search", class: "rec-search", placeholder: "Add a stock (RELIANCE, SBIN…)", autocomplete: "off", spellcheck: "false", disabled: dis, "aria-label": "Search stock options to record" });
    let seq = 0;
    let timer = 0;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim().toUpperCase();
      if (q.length < 2) return fill(found);
      timer = setTimeout(async () => {
        const mine = ++seq;
        // kind=FUT, not OPT: an OPT search returns one row per strike, so 40 rows are a single underlying's ladder;
        // futures give a few rows per underlying. Only NFO is asked for (stock F&O); stocksFromSearch drops the rest.
        const r = await optional(api(`/v1/instruments/search?q=${encodeURIComponent(q)}&kind=FUT&exchange=NFO&limit=60`));
        if (mine !== seq) return;
        const list = r.error ? [] : stocksFromSearch(r.data.data, f.stocks).slice(0, 8);
        fill(
          found,
          list.length
            ? list.map((u) => h("button", { type: "button", class: "chip-btn rec-add", onclick: () => ((f.stocks = [...f.stocks, u]), (search.value = ""), fill(found), drawChips(), edited()) }, icon("plus"), u))
            : h("span", { class: "muted small" }, r.error ? "Search is not available right now." : `No stock options match ${q}.`),
        );
      }, 250);
    });
    const everySel = h("select", { disabled: dis, "aria-label": "Stocks every" }, [5, 10, 15].map((m) => h("option", { value: String(m) }, `Every ${m} min`)));
    everySel.value = String(f.stockEveryMinutes);
    everySel.addEventListener("change", () => {
      f.stockEveryMinutes = Number(everySel.value);
      edited();
    });
    // NSE website backup.
    const nse = switchRow("NSE website backup", f.sources.nseBackup, {
      disabled: dis || demo,
      hint: demo ? "Not used in demo mode." : "Off by default. Used only for chains your broker cannot carry.",
      onChange: async (on, input) => {
        if (!on) {
          f.sources = { ...f.sources, nseBackup: false };
          acknowledged = false;
          return edited();
        }
        if (inSheet) {
          // In the phone sheet the form already sits in the dialog: the terms and "I understand" show inline under
          // the switch (a second modal would replace the sheet and lose its edits).
          acknowledged = false;
          f.sources = { ...f.sources, nseBackup: true };
          drawAck();
          return edited();
        }
        const ok = await confirmNse();
        if (!ok) {
          input.checked = false;
          return;
        }
        acknowledged = true;
        f.sources = { ...f.sources, nseBackup: true };
        edited();
      },
    });
    const ackHost = h("div", { class: "rec-nse-ack-host" });
    const drawAck = () => {
      const show = inSheet && f.sources.nseBackup && !formFrom(status.settings).sources.nseBackup;
      if (!show) return fill(ackHost);
      const box = h("input", { type: "checkbox" });
      box.checked = acknowledged;
      box.addEventListener("change", () => {
        acknowledged = box.checked;
      });
      fill(ackHost, h("div", { class: "rec-nse-ack", role: "group", "aria-label": "NSE website backup terms" }, h("p", { class: "small" }, NSE_TERMS), h("label", { class: "check" }, box, h("span", {}, "I understand"))));
    };
    drawAck();

    fill(
      host,
      h(
        "div",
        { class: "rec-form" },
        h(
          "section",
          { class: "rec-group" },
          h("h3", {}, "Recording"),
          switchRow("Record option chains", f.enabled, { disabled: dis, hint: "Off stops recording; what is on disk stays.", onChange: (on) => ((f.enabled = on), edited()) }),
          h("label", { class: "field" }, h("span", {}, "Account that records"), sel, h("span", { class: "hint" }, "Auto uses the first connected account that serves option chains. One account only, never pooled across holders.")),
        ),
        h(
          "section",
          { class: "rec-group" },
          h("h3", {}, "Indices", h("span", { class: "rec-h-sub" }, "every minute · in priority order")),
          h("div", { class: "rec-checks" }, indexBoxes),
          h("div", { class: "rec-steps" }, stepper("Expiries", f.indexExpiries, { min: 1, max: 4, disabled: dis, onChange: (v) => ((f.indexExpiries = v), edited()) }), stepper("Strikes each side", f.indexStrikes, { min: 1, max: 60, disabled: dis, onChange: (v) => ((f.indexStrikes = v), edited()) })),
        ),
        h(
          "section",
          { class: "rec-group" },
          h("h3", {}, "Stocks", h("span", { class: "rec-h-sub" }, "opt-in · nearest expiry")),
          chips,
          h("div", { class: "rec-search-row" }, search, everySel),
          found,
          h("div", { class: "rec-steps" }, stepper("Strikes each side", f.stockStrikes, { min: 1, max: 30, disabled: dis, onChange: (v) => ((f.stockStrikes = v), edited()) })),
          h("p", { class: "hint" }, "Recording stocks may need a paid data plan with some brokers."),
        ),
        h(
          "section",
          { class: "rec-group" },
          h("h3", {}, "Budget and storage"),
          slider("REST budget share", f.budgetShare, { min: 0.05, max: 0.5, step: 0.05, disabled: dis, text: pct, hint: "At most half of every broker window; your own requests go first.", onChange: (v) => ((f.budgetShare = v), edited()) }),
          slider("Live feed share", f.streamShare, { min: 0.1, max: 0.9, step: 0.05, disabled: dis, text: pct, hint: "Of the account's feed subscriptions; pages keep the rest.", onChange: (v) => ((f.streamShare = v), edited()) }),
          demo
            ? h("p", { class: "hint rec-ret" }, "Demo recordings are kept for 3 days.")
            : h("div", { class: "rec-steps" }, stepper("Days kept", f.retentionDays, { min: 7, max: 3650, disabled: dis, onChange: (v) => ((f.retentionDays = v), edited()) })),
          nse,
          ackHost,
        ),
      ),
    );
  }
  draw();

  const bar = h("div", { class: `rec-savebar${inSheet ? " in-sheet" : ""}` }, verdictEl, problemEl, h("div", { class: "rec-save-acts" }, resetBtn, saveBtn));
  const el = h("div", { class: "rec-settings" }, dis ? alertBox({ title: "Change these from this computer", detail: "Settings can be changed only with an admin key at http://127.0.0.1 on the computer running the Bridge." }, "info") : null, host, bar);
  return {
    el,
    verdict(v) {
      verdictEl.dataset.tone = v.tone;
      fill(verdictEl, v.tone === "warn" || v.tone === "bad" ? icon("warn") : v.tone === "ok" ? icon("check") : null, h("span", {}, v.text));
    },
    problem(node) {
      fill(problemEl, node);
    },
    form: () => f,
    setForm(next) {
      f = { ...f, ...next };
      draw();
      edited();
    },
    saving(on) {
      saveBtn.disabled = dis || on;
      saveBtn.setAttribute("aria-busy", String(on));
    },
  };
}

async function confirmNse() {
  const box = h("input", { type: "checkbox" });
  const ok = await modal({
    title: "Turn on the NSE website backup?",
    body: h("div", { class: "stack" }, h("p", {}, NSE_TERMS), h("label", { class: "check" }, box, h("span", {}, "I understand"))),
    buttons: [
      { label: "Cancel", value: false },
      {
        label: "Turn on",
        cls: "primary",
        onClick: () => {
          if (box.checked) return true;
          toast("Tick “I understand” first", { tone: "info" });
          return false;
        },
      },
    ],
  });
  return ok === true;
}

function feasibilityEl(rows, broker) {
  if (!rows?.length) return null;
  const table = h(
    "div",
    { class: "table-wrap stack stack-wide rec-feas-table" },
    h(
      "table",
      {},
      h("caption", { class: "sr-only" }, "Which brokers can record what, with the default settings"),
      h("thead", {}, h("tr", {}, ["Broker", "Live feed: recorder share", "REST for the recorder", "Index chains (18 at ±40)", "Stocks at 5 min (±15)"].map((t) => h("th", { scope: "col" }, t)))),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            { class: r.broker === broker ? "rec-mine" : undefined, "aria-current": r.broker === broker ? "true" : undefined },
            h("td", { class: "lead", "data-label": "Broker" }, h("strong", {}, r.label), r.broker === broker ? h("span", { class: "rec-yours" }, "Yours") : null),
            h("td", { "data-label": "Live feed" }, r.feed),
            h("td", { class: "wrap", "data-label": "REST" }, r.rest),
            h("td", { "data-label": "Index chains" }, r.indices),
            h("td", { "data-label": "Stocks" }, r.stocks),
          ),
        ),
      ),
    ),
  );
  return h(
    "details",
    { class: "desk-panel rec-feas", "data-panel": "rec-feas" },
    h("summary", {}, h("span", { class: "rec-feas-t" }, "Which brokers can record what"), h("span", { class: "rec-feas-s" }, feasibilityNote(rows, broker) || "Default settings, from each broker's published limits")),
    h("div", { class: "rec-feas-body" }, h("p", { class: "muted small" }, "Generated from the broker limit table and the recorder's planner with the default settings. Figures marked unverified are conservative defaults."), table),
  );
}

/** "Needs attention" as on the Bridge pages (app.css 12z .bx-attn): one row per item, red stopped, orange about to. */
function attentionEl(items) {
  if (!items.length) return null;
  const bad = items.some((x) => x.tone === "bad");
  return h(
    "section",
    { class: `bx-attn ${bad ? "bad" : "warn"}`, "aria-label": "Needs attention" },
    h("div", { class: "bx-attn-head" }, h("span", { class: `icon-tile tint-${bad ? "red" : "orange"} tile-sm`, "aria-hidden": "true" }, icon("warn")), h("h2", {}, items.length === 1 ? "One thing needs attention" : `${formatInt(items.length)} things need attention`)),
    h(
      "div",
      { class: "list bx-list" },
      items.map((x) =>
        h(
          "div",
          { class: "list-row bx-row" },
          h("span", { class: `bx-dot ${x.tone}`, "aria-hidden": "true" }),
          h("div", { class: "names" }, h("span", { class: "nm" }, x.title), x.detail ? h("span", { class: "sub" }, x.detail) : null),
          x.action ? h("div", { class: "bx-trail" }, h("a", { class: "btn small", href: x.action.href }, x.action.label)) : null,
        ),
      ),
    ),
  );
}

export async function renderRecorderPage() {
  const demo = Boolean(app.state.demo);
  const [first, accountsRes] = await Promise.all([api("/v1/options/recorder?feasibility=true"), optional(api("/v1/accounts"))]);
  let status = first.data.data;
  const feasibility = status.feasibility ?? [];
  const accounts = (accountsRes.data?.data ?? []).filter((a) => a.broker !== "paper" && (a.capabilities ?? []).includes("optionChain"));
  const canEdit = onThisComputer();

  // The tiles, notices and the coverage row keep their place (data-fixed); only the full-width panels move.
  const tilesEl = h("div", { class: "grid cols-4 stats rec-tiles", "data-fixed": "" });
  const warnEl = h("div", { class: "rec-warns", "data-fixed": "" });
  const covBody = h("div", { class: "rec-cov-body" });
  const covSub = h("p", {});
  const budgetBody = h("div", { class: "rec-budget-body" });
  const diskBody = h("div", { class: "rec-disk-body" });
  const settingsHost = h("div", { class: "rec-settings-host" });
  const errEl = h("div", { class: "rec-err", "data-fixed": "" });

  // Desk panels, as on the data pages the recordings feed (OI, Volatility): one edge, one radius, the dense gap.
  const panel = (cls, key, title, sub, body, flush = false) =>
    h("section", { class: `desk-panel ${cls}`, "data-panel": key, "aria-label": title }, h("header", { class: "panel-head rec-head" }, h("div", { class: "rec-titles" }, h("h2", {}, title), sub)), h("div", { class: flush ? "rec-body flush" : "rec-body" }, body));
  const covCard = panel("rec-coverage", "rec-coverage", "Coverage today", covSub, covBody, true);
  const budgetCard = panel("rec-budget", "rec-budget", "Budget", h("p", {}, "The recorder's share of this account's limits"), budgetBody);
  const diskCard = panel("rec-disk", "rec-disk", "Disk", h("p", {}, "Day files, compressed at the end of each day"), diskBody);
  const settingsCard = panel("rec-settings-card", "rec-settings", "Settings", h("p", {}, "What to record, from which account, and how much of its budget to use"), settingsHost);

  // The desk top bar names the page and its state (the page head is hidden on desk pages), as the other desk pages do.
  const ctxSub = h("span", { class: "ctx-sub" });
  mountToolbarCtx("recorder", h("div", { class: "ctx-cap glass" }, h("span", { class: "ctx-item ctx-rec" }, h("span", { class: "ctx-main" }, "Data recorder"), ctxSub)), h("span", { class: "ctx-spacer" }));

  function drawStatus() {
    keepFocus(tilesEl, () => fill(tilesEl, tilesModel(status).map(tileEl)));
    const st = tilesModel(status).find((t) => t.key === "state");
    ctxSub.textContent = [st?.value, status.account?.id].filter(Boolean).join(" · ");
    const warns = (status.warnings ?? []).filter((w) => !(demo && /^Demo clock/.test(w)));
    fill(warnEl, attentionEl(recorderAttention(status, { extra: warns })));
    const rows = coverageRows(status);
    const ses = status.session ?? {};
    covSub.textContent = [
      coverageCounts(rows),
      ses.alwaysOpen ? "Demo clock: always open" : ses.tradingDay === false ? "Not a trading day" : ses.start ? `Session ${ses.start}–${ses.end} IST` : null,
      ses.nextSlot && ses.open !== false ? `next ${istTime(ses.nextSlot).slice(0, 5)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    keepFocus(covBody, () => fill(covBody, rows.length ? coverageTable(rows, covCard) : emptyState("clock", "Nothing recorded yet", status.stateDetail ?? "The recorder starts with the next minute of the session.", null, { compact: true })));
    const b = budgetModel(status);
    fill(
      budgetBody,
      b.feed ? meterRow("Live feed", b.feed.used, b.feed.cap, b.feed.text) : h("p", { class: "rec-off" }, h("strong", {}, "Live feed"), h("span", {}, b.feedNote)),
      b.rest ? meterRow("REST", b.rest.used, b.rest.cap, b.rest.text) : h("p", { class: "rec-off" }, h("strong", {}, "REST"), h("span", {}, b.restWhy)),
      b.planned ? h("p", { class: "muted small rec-planned" }, b.planned) : null,
      status.oiUnits && status.oiUnits.verified === false ? h("p", { class: "muted small" }, "OI units for this broker are not verified yet: OI is recorded as sent.") : null,
    );
    const d = diskModel(status);
    fill(diskBody, meterRow("Used", d.used, d.cap, d.text), h("dl", { class: "rec-kv" }, d.lines.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
  }

  // ── Settings ──
  let planTimer = 0;
  let planSeq = 0;
  const phone = () => typeof matchMedia === "function" && matchMedia(`(max-width: ${PHONE_BELOW_PX - 1}px)`).matches;
  function wire(form) {
    const plan = (body) => {
      clearTimeout(planTimer);
      form.verdict(verdictView(null, { busy: true }));
      form.problem(null);
      planTimer = setTimeout(async () => {
        const mine = ++planSeq;
        const r = await optional(api("/v1/options/recorder/plan", { method: "POST", body }));
        if (mine !== planSeq) return;
        form.verdict(r.error ? verdictView(null, { error: r.error.message }) : verdictView(r.data.data));
      }, PLAN_DEBOUNCE_MS);
    };
    return plan;
  }
  async function save(form, body, done) {
    form.saving(true);
    form.problem(null);
    const r = await optional(api("/v1/options/recorder/config", { method: "PUT", body }));
    form.saving(false);
    if (r.error) {
      const e = r.error;
      if (e.code === "CAPACITY_EXCEEDED" && e.body?.canCarry) {
        const c = e.body.canCarry;
        const fit = fitToCarry(form.form(), c, e.body.refused ?? []);
        const fits = [fit.indices.length ? `indices ${fit.indices.join(", ")} at ${plural(fit.indexExpiries, "expiry", "expiries")}` : null, fit.stocks.length ? `${plural(fit.stocks.length, "stock")}` : null].filter(Boolean).join(" and ") || "nothing more";
        const use = h("button", { type: "button", class: "small", onclick: () => form.setForm(fit) }, "Use what fits");
        return form.problem(h("div", { class: "rec-cap" }, alertBox({ title: "This account cannot carry all of it. Nothing was saved.", detail: `It can carry ${fits}.` }, "warn"), use));
      }
      return form.problem(alertBox(e));
    }
    status = r.data.data.status;
    toast(r.data.data.persisted ? "Saved to the config file and applied" : "Applied until the Bridge stops (the config file is not edited)");
    drawStatus();
    done?.();
    drawSettings();
  }
  function drawSettings() {
    if (phone()) {
      // Phones: a summary and a button; the form opens in a full-height sheet with the Save bar pinned.
      const s = formFrom(status.settings);
      const open = h("button", { type: "button", class: "primary" }, icon("sliders"), canEdit ? "Change settings" : "View settings");
      open.addEventListener("click", () => {
        let closeSheet = null;
        let form = null;
        const p = modal({
          title: "Recorder settings",
          body: (close) => {
            closeSheet = close;
            form = settingsForm({ status, accounts, canEdit, demo, inSheet: true, onPlan: (body) => plan(body), onSave: (body) => save(form, body, () => closeSheet?.(undefined, true)) });
            const plan = wire(form);
            plan(formBody(form.form()));
            return form.el;
          },
        });
        document.getElementById("dialog")?.classList.add("rec-sheet");
        p.then(() => document.getElementById("dialog")?.classList.remove("rec-sheet"));
      });
      fill(
        settingsHost,
        h(
          "dl",
          { class: "rec-kv rec-sum" },
          [
            ["Recording", s.enabled ? "On" : "Off"],
            ["Account", s.account ?? "Auto"],
            ["Indices", `${s.indices.join(", ") || "None"} · ${plural(s.indexExpiries, "expiry", "expiries")} · ±${formatInt(s.indexStrikes)}`],
            ["Stocks", s.stocks.length ? `${s.stocks.join(", ")} · every ${formatInt(s.stockEveryMinutes)} min` : "None"],
            ["Budget", `REST ${pct(s.budgetShare)} · feed ${pct(s.streamShare)}`],
          ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
        ),
        h("div", { class: "row" }, open),
      );
      return;
    }
    let form = null;
    form = settingsForm({ status, accounts, canEdit, demo, onPlan: (body) => plan(body), onSave: (body) => save(form, body) });
    const plan = wire(form);
    fill(settingsHost, form.el);
    plan(formBody(form.form()));
  }

  const footer = h("p", { class: "rec-foot" }, FOOTER, demo ? ` ${DEMO_FOOTER}` : "");
  drawStatus();
  drawSettings();
  // Crossing the phone breakpoint swaps the inline form and the sheet button (a rotation, a resized window).
  const mq = typeof matchMedia === "function" ? matchMedia(`(max-width: ${PHONE_BELOW_PX - 1}px)`) : null;
  let wasPhone = phone();
  // Removed with the page (leaving #/recorder, or the first change or poll after the page is gone), so the listener
  // and the page it holds do not pile up with each visit.
  const mqOff = new AbortController();
  mq?.addEventListener?.(
    "change",
    () => {
      if (!settingsHost.isConnected) return mqOff.abort();
      if (phone() === wasPhone) return;
      wasPhone = phone();
      drawSettings();
    },
    { signal: mqOff.signal },
  );
  addEventListener("hashchange", () => !/^#\/?recorder\b/.test(location.hash) && mqOff.abort(), { signal: mqOff.signal });

  every(POLL_MS, async () => {
    if (!tilesEl.isConnected) return mqOff.abort();
    const r = await optional(api("/v1/options/recorder"));
    if (r.error) return fill(errEl, alertBox({ title: "Couldn't refresh the recorder status", detail: `${r.error.message} Showing the last good status.` }, "warn"));
    fill(errEl);
    status = r.data.data;
    drawStatus();
  });

  return [
    errEl,
    tilesEl,
    warnEl,
    h("div", { class: "rec-main", "data-fixed": "" }, covCard, h("div", { class: "rec-side" }, budgetCard, diskCard)),
    settingsCard,
    feasibilityEl(feasibility, status.account?.broker ?? null),
    footer,
  ].filter(Boolean);
}
