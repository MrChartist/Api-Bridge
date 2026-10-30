// Participant OI page (#/participants, stream S26; docs/spec/p1-12-guard-participants.md §6.7) and the one-line tile
// on the OI page. NSE's participant-wise open interest: Client, DII, FII and Pro long and short contracts in index and
// stock futures and options, one file a day after the close.
//
// The view-models (tilesModel, tableModel, cardsModel, historyModel, sparkGeometry, oiTileText, pageState) are pure
// and tested in participants.test.mjs; the page code only builds DOM from them. Copy is descriptive ("FII held 31.1 %
// of their index-futures positions long"), never a market view (copyRules.mjs). Numbers become text only through
// format.js. The history panel holds the shared chart-engine slot (chartSlot) with the SVG small multiples, a data
// table toggle and CSV as the fallback until the owner's chart engine replaces them.
import { api, chartSlot, emptyState, errorState, h, icon, loadingState, mountToolbarCtx, sheetPopover, toast } from "./app.js";
import { DASH, formatCompact, formatCompactTick, formatFixed, formatPercent, formatSigned, isFigure } from "./format.js";
import { niceTicks } from "./options.js";
import { PAGES, segmented } from "./views.js";
import { scrubber, svgEl } from "./viz.js";

export const PT_PARTICIPANTS = Object.freeze(["CLIENT", "DII", "FII", "PRO", "TOTAL"]);
export const PT_NAMES = Object.freeze({ CLIENT: "Client", DII: "DII", FII: "FII", PRO: "Pro", TOTAL: "Total" });
export const PT_INSTRUMENTS = Object.freeze({ IDX_FUT: "Index fut", IDX_CE: "Index CE", IDX_PE: "Index PE", STK_FUT: "Stock fut", STK_CE: "Stock CE", STK_PE: "Stock PE" });
export const PT_GROUPS = Object.freeze([
  { id: "fut", label: "Futures", instruments: ["IDX_FUT", "STK_FUT"] },
  // Options are two tables of two instruments, like futures, so each fits without sideways scroll from 1024 px up.
  { id: "idxopt", label: "Index options", instruments: ["IDX_CE", "IDX_PE"] },
  { id: "stkopt", label: "Stock options", instruments: ["STK_CE", "STK_PE"] },
]);
/** History ranges in trading days (the segmented control). */
export const PT_RANGES = Object.freeze([
  ["20", "20d"],
  ["60", "60d"],
  ["250", "250d"],
  ["all", "All"],
]);
/** The four history series (§6.7): what each reads and how it is drawn. */
export const PT_SERIES = Object.freeze([
  { key: "fiiLongPct", label: "FII index futures long %", p: "FII", x: "IDX_FUT", kind: "pct", dv: "spot" },
  { key: "fiiNet", label: "FII index futures net", p: "FII", x: "IDX_FUT", kind: "net", dv: "spot" },
  { key: "clientCallNet", label: "Client index calls net", p: "CLIENT", x: "IDX_CE", kind: "net", dv: "call" },
  { key: "clientPutNet", label: "Client index puts net", p: "CLIENT", x: "IDX_PE", kind: "net", dv: "put" },
]);
export const PT_NOTE = "NSE only · all strikes and expiries · number of contracts";
export const PT_DISCLAIMER = "NSE only; aggregated; contracts; published after the close. For information only, not advice.";
export const BSE_UNDERLYINGS = Object.freeze(["SENSEX", "BANKEX"]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SLOT = "mcb.dashboard.participants";
const DAY_MS = 86_400_000;

// ───────────────────────────── pure helpers ─────────────────────────────

/** "28 Oct" */
export const shortDate = (d) => (typeof d === "string" && d.length >= 10 ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : DASH);
/** "28 Oct 2026" */
export const longDate = (d) => (typeof d === "string" && d.length >= 10 ? `${shortDate(d)} ${d.slice(0, 4)}` : DASH);
/** The two ends of a range: "10 Oct – 29 Oct" within a year, "10 Oct 2024 – 29 Oct 2026" across years. */
export function rangeEnds(from, to) {
  const span = typeof from === "string" && typeof to === "string" && from.slice(0, 4) !== to.slice(0, 4);
  return span ? [longDate(from), longDate(to)] : [shortDate(from), shortDate(to)];
}
/** "+1.25L", "−15.6K", "0" */
export const signedCount = (n) => formatCompact(n, { signed: true });
/** "+2.04 pts" / "−2.04 pts" */
export const ptsText = (n, dp = 2) => (isFigure(n) ? `${formatSigned(n, dp)} pts` : DASH);
/** The gain / loss tone of a signed figure (direction: net long / net short; up / down change). */
export const toneOf = (n) => (!isFigure(n) || Number(n) === 0 ? "" : Number(n) > 0 ? "up" : "down");
/** Long / short wording for a net figure: "net long", "net short", "flat". */
export const netWord = (n) => (!isFigure(n) ? "" : Number(n) > 0 ? "net long" : Number(n) < 0 ? "net short" : "flat");

/** Table / card cell for one participant × instrument from the summary table. */
function rowOf(summary, p, x) {
  return (summary?.table ?? []).find((r) => r.participant === p && r.instrument === x) ?? null;
}

/** "Next check: 30 Oct, 19:10 IST" from an IST ISO time (status.nextRunAt), or "". */
export function nextCheckText(at) {
  if (typeof at !== "string" || at.length < 16) return "";
  return `Next check: ${shortDate(at.slice(0, 10))}, ${at.slice(11, 16)} IST`;
}

/**
 * What the page shows instead of data, or "ok".
 * @param {object} summary  /v1/participants/oi/summary
 * @param {object} [status]  /v1/participants/status (next check time and back-fill progress)
 * @param {{ hasCalendar?: boolean }} [o]  whether the Market calendar page exists (it switches the downloads on)
 * @returns {{ kind: "ok"|"source-off"|"not-here"|"no-data"|"stale"|"unavailable", title?: string, text?: string, note?: string }}
 */
export function pageState(summary, status = null, { hasCalendar = false } = {}) {
  if (summary?.available) return { kind: "ok" };
  const reason = summary?.reason;
  const bf = status?.backfill && (status.backfill.running || status.backfill.have > 0) ? backfillText(status) : "";
  if (reason === "SOURCE_OFF") {
    const where = hasCalendar ? "on the Market calendar page" : "with reference.sources.nseArchives.enabled in the Bridge config";
    return { kind: "source-off", title: "NSE archive downloads are off", text: `Turn on NSE archive downloads ${where} to fetch participant OI. Nothing is fetched until then.` };
  }
  // Reference data (and with it the NSE archive client) is not running on this Bridge: no switch can help here.
  if (reason === "SOURCE_UNAVAILABLE") return { kind: "not-here", title: "Participant OI is not available on this Bridge", text: `${summary.detail ?? "Reference data is not running on this Bridge."} Participant files are fetched through it, so there is nothing to show.` };
  if (reason === "PARTICIPANT_STALE") return { kind: "stale", title: "The latest file is old", text: summary.detail ?? "The newest participant file is older than the previous trading day.", note: bf };
  if (reason === "NO_PARTICIPANT_DATA") {
    const next = nextCheckText(status?.nextRunAt);
    return { kind: "no-data", title: "No participant OI yet", text: `NSE publishes the file after the close on each trading day.${next ? ` ${next}.` : ""} Older days fill in from the NSE archive outside market hours.`, note: bf };
  }
  return { kind: "unavailable", title: "Participant OI is not available", text: summary?.detail ?? "" };
}

/** The totals-mismatch chip: names the instruments, in the text (touch screens have no hover). */
export function mismatchText(summary) {
  const xs = (summary?.mismatches ?? []).map((x) => PT_INSTRUMENTS[x] ?? x);
  return xs.length ? `NSE totals did not add up for ${xs.join(", ")} on this day; shown as published` : "NSE totals did not add up on this day; shown as published";
}

/** The stale-file line for the headline (summary.stale), or "". */
export function staleText(summary) {
  if (!summary?.available || !summary.stale) return "";
  return `Latest file is for ${shortDate(summary.date)}; NSE's newer file${summary.expectedDate ? ` (${shortDate(summary.expectedDate)})` : ""} has not been fetched`;
}

/** "NSE only · all strikes and expiries · contracts · for the day ended 28 Oct" */
export const topLine = (summary) => `${PT_NOTE} · for the day ended ${shortDate(summary?.date)}`;

/** Back-fill progress line from /v1/participants/status: "History: 487 of 500 trading days; 13 not available from NSE". */
export function backfillText(status) {
  const b = status?.backfill;
  if (!b || !b.target) return "";
  const missing = b.noFile ? `; ${b.noFile} not available from NSE` : "";
  const running = b.running ? " (filling in)" : "";
  // The back-fill pauses (30 min, up to 6 h) while NSE refuses or does not answer; say so rather than look stuck.
  const paused = !b.running && b.pausedUntil ? `; paused while NSE is not answering (next try ${nextCheckText(b.pausedUntil).replace(/^Next check: /, "")})` : "";
  return `History: ${b.have} of ${b.target} trading days${missing}${running}${paused}`;
}

/**
 * The six headline tiles (§6.7): FII index-futures long % and net, client and pro index calls / puts net.
 * @returns {Array<{ key, label, value, tone, sub, title, longPct?: number|null, aria }>}
 */
export function tilesModel(summary) {
  const hd = summary?.headline ?? {};
  const prev = summary?.previousDate ? shortDate(summary.previousDate) : "the previous day";
  const fii = rowOf(summary, "FII", "IDX_FUT");
  const netTile = (key, label, p, x) => {
    const r = rowOf(summary, p, x);
    const value = r ? signedCount(r.net) : DASH;
    const subMain = r ? (isFigure(r.netChange) ? `${signedCount(r.netChange)} vs ${prev}` : "no previous day") : "";
    const subNote = r ? netWord(r.net) : "";
    const sub = r ? `${subMain} · ${subNote}` : "";
    return { key, label, value, tone: toneOf(r?.net), sub, subMain, subNote, title: r ? `${label}: long ${formatCompact(r.long)}, short ${formatCompact(r.short)}, net ${value} contracts` : "", aria: `${label}: ${value}${r ? `, ${netWord(r.net)}` : ""}` };
  };
  const lp = hd.fiiIndexFutLongPct;
  return [
    {
      key: "fiiLongPct",
      label: "FII index fut long %",
      value: isFigure(lp) ? formatPercent(lp, 1) : DASH,
      tone: "",
      sub: isFigure(hd.fiiIndexFutLongPctChange) ? `${ptsText(hd.fiiIndexFutLongPctChange)} vs ${prev}` : "no previous day",
      title: `${hd.formula ?? "FII long ÷ (FII long + FII short) × 100"}. ${fii ? `FII held ${formatPercent(lp, 1)} of their index-futures positions long (${formatCompact(fii.long)} long, ${formatCompact(fii.short)} short).` : ""}`.trim(),
      longPct: isFigure(lp) ? Number(lp) : null,
      aria: `FII index futures long: ${isFigure(lp) ? formatPercent(lp, 1) : DASH}`,
    },
    netTile("fiiNet", "FII index fut net", "FII", "IDX_FUT"),
    netTile("clientCall", "Client index calls net", "CLIENT", "IDX_CE"),
    netTile("clientPut", "Client index puts net", "CLIENT", "IDX_PE"),
    netTile("proCall", "Pro index calls net", "PRO", "IDX_CE"),
    netTile("proPut", "Pro index puts net", "PRO", "IDX_PE"),
  ];
}

/** One cell's display: long, short, net, Δ net, long %, shares, with tones. */
export function cellModel(r) {
  if (!r) return { long: DASH, short: DASH, net: DASH, dnet: DASH, netTone: "", dTone: "", longPct: null, longPctText: DASH, share: "" };
  return {
    long: formatCompact(r.long),
    short: formatCompact(r.short),
    net: signedCount(r.net),
    dnet: isFigure(r.netChange) ? signedCount(r.netChange) : DASH,
    netTone: toneOf(r.net),
    dTone: toneOf(r.netChange),
    longPct: isFigure(r.longPct) ? Number(r.longPct) : null,
    longPctText: isFigure(r.longPct) ? `${formatPercent(r.longPct, 1)} long` : DASH,
    share: isFigure(r.shareOfLong) && isFigure(r.shareOfShort) ? `${formatPercent(r.shareOfLong, 1)} of all longs · ${formatPercent(r.shareOfShort, 1)} of all shorts` : "",
  };
}

/**
 * The desktop / tablet table for one instrument group: rows = participants (TOTAL last), cells per instrument.
 * @returns {{ group, columns: Array<{ id, label }>, rows: Array<{ participant, name, total: boolean, cells: Record<string, ReturnType<typeof cellModel>> }> }}
 */
export function tableModel(summary, group) {
  const g = PT_GROUPS.find((x) => x.id === group) ?? PT_GROUPS[0];
  return {
    group: g.id,
    label: g.label,
    columns: g.instruments.map((id) => ({ id, label: PT_INSTRUMENTS[id] })),
    rows: PT_PARTICIPANTS.map((p) => ({ participant: p, name: PT_NAMES[p], total: p === "TOTAL", cells: Object.fromEntries(g.instruments.map((x) => [x, cellModel(rowOf(summary, p, x))])) })),
  };
}

/** Phone cards for one instrument: one card per participant, TOTAL as the footer line. */
export function cardsModel(summary, instrument) {
  const total = rowOf(summary, "TOTAL", instrument);
  return {
    instrument,
    label: PT_INSTRUMENTS[instrument] ?? instrument,
    cards: PT_PARTICIPANTS.filter((p) => p !== "TOTAL").map((p) => ({ participant: p, name: PT_NAMES[p], ...cellModel(rowOf(summary, p, instrument)) })),
    total: total ? `Total open interest: ${formatCompact(total.long)} contracts each side` : "",
  };
}

/** The value of a series on one ParticipantDay. */
export function seriesValue(day, s) {
  const v = day?.rows?.[s.p]?.[s.x];
  if (!Array.isArray(v)) return null;
  if (s.kind === "pct") {
    const g = v[0] + v[1];
    return g > 0 ? Math.round((v[0] / g) * 10000) / 100 : null;
  }
  return v[0] - v[1];
}

/** Weekday count since Mon 5 Jan 1970 for a date (the history x axis; weekends are not on it). */
export function weekdayIndex(date) {
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(1970, 0, 5)) / DAY_MS);
  const dow = ((d % 7) + 7) % 7;
  return Math.floor(d / 7) * 5 + Math.min(dow, 4);
}

/**
 * History for a range: the last `range` published days (or all), on a weekday axis so a day without a file is a gap.
 * @param {Array<{ date, rows }>} days  oldest first
 * @param {string} range  "20" | "60" | "250" | "all"
 * @param {Array<{ date, text }>} [revisions]
 */
export function historyModel(days, range, revisions = []) {
  const list = (days ?? []).filter((d) => d && typeof d.date === "string").sort((a, b) => (a.date < b.date ? -1 : 1));
  const n = range === "all" ? list.length : Math.max(2, Number(range) || 20);
  const shown = list.slice(-n);
  if (!shown.length) return { dates: [], slots: 0, series: [], revisions: [], from: null, to: null };
  const base = weekdayIndex(shown[0].date);
  const slots = weekdayIndex(shown[shown.length - 1].date) - base + 1;
  const series = PT_SERIES.map((s) => {
    const points = shown.map((d) => ({ i: weekdayIndex(d.date) - base, date: d.date, value: seriesValue(d, s) })).filter((p) => p.value !== null);
    const vals = points.map((p) => p.value);
    const first = points[0]?.value ?? null;
    const last = points[points.length - 1]?.value ?? null;
    const change = first !== null && last !== null ? last - first : null;
    return {
      ...s,
      points,
      min: vals.length ? Math.min(...vals) : null,
      max: vals.length ? Math.max(...vals) : null,
      last,
      change,
      lastText: valueText(s, last),
      changeText: change === null ? DASH : s.kind === "pct" ? ptsText(change, 1) : signedCount(change),
    };
  });
  const from = shown[0].date;
  const to = shown[shown.length - 1].date;
  const revs = (revisions ?? []).filter((r) => r.date > from && r.date <= to).map((r) => ({ i: weekdayIndex(r.date) - base, date: r.date, text: r.text }));
  return { dates: shown.map((d) => d.date), slots, series, revisions: revs, from, to, gaps: slots - shown.length };
}

/** A series value as text: "31.1%" or "−1.37L". */
export function valueText(s, v) {
  if (!isFigure(v)) return DASH;
  return s.kind === "pct" ? formatPercent(v, 1) : signedCount(v);
}

/**
 * SVG geometry for one small multiple: x by weekday slot, y scaled to the values (and the reference line: 50 % for
 * long %, zero for nets, always in view). A missing slot breaks the line.
 * @returns {{ d: string, x: (i: number) => number, y: (v: number) => number, ticks: number[], ref: number, lo: number, hi: number }}
 */
export function sparkGeometry(points, slots, { w, h, padL = 40, padR = 10, padT = 10, padB = 18, kind = "net" } = {}) {
  const ref = kind === "pct" ? 50 : 0;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  // The reference line (50 % long, zero net) is kept in view when the data comes near it, not when that would
  // squash a series that sits far from it into a flat line.
  const near = ref >= lo - (hi - lo) * 0.6 && ref <= hi + (hi - lo) * 0.6;
  if (near || !vals.length) {
    lo = Math.min(lo, ref);
    hi = Math.max(hi, ref);
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  let ticks = niceTicks(lo, hi, 4);
  // A small multiple needs a readable scale: with fewer than three ticks in range, snap the ends out to whole steps
  // (and, if that is still short, ask for a finer step).
  if (ticks.length < 3) {
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : niceTicks(lo, hi, 6)[1] - niceTicks(lo, hi, 6)[0];
    if (isFigure(step) && step > 0) {
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
      ticks = niceTicks(lo, hi, 4);
      if (ticks.length < 3) ticks = niceTicks(lo, hi, 6);
    }
  }
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const iw = Math.max(1, w - padL - padR);
  const ih = Math.max(1, h - padT - padB);
  const x = (i) => padL + (slots > 1 ? (i / (slots - 1)) * iw : iw / 2);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ih;
  let d = "";
  let prev = null;
  for (const p of points) {
    const cmd = prev !== null && p.i === prev + 1 ? "L" : "M";
    d += `${cmd}${Math.round(x(p.i) * 10) / 10} ${Math.round(y(p.value) * 10) / 10}`;
    prev = p.i;
  }
  return { d, x, y, ticks, ref: near ? ref : null, lo, hi };
}

/** CSV rows (header first) for the history in view. */
export function historyCsv(model) {
  const head = ["date", ...model.series.map((s) => s.label)];
  const byDate = new Map(model.dates.map((d) => [d, []]));
  for (const s of model.series) for (const p of s.points) byDate.get(p.date)?.push([s.key, p.value]);
  const rows = [head];
  for (const d of model.dates) {
    const vals = Object.fromEntries(byDate.get(d) ?? []);
    rows.push([d, ...model.series.map((s) => (vals[s.key] === undefined ? "" : String(vals[s.key])))]);
  }
  return rows;
}

/** RFC 4180 text for CSV rows built here (cells are dates, labels and plain numbers). */
export function toCsvText(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/**
 * The OI page's one line (§6.7): "FII index futures: 31.1 % long (−2.0 pts) · Participants →" for NSE underlyings;
 * "No BSE participant file" for SENSEX / BANKEX.
 * @returns {{ text: string, tone: string, title: string } | null}  null when there is nothing to show
 */
export function oiTileText(summary, underlying) {
  if (BSE_UNDERLYINGS.includes(String(underlying ?? "").toUpperCase())) return { text: "No BSE participant file", main: "No BSE participant file", delta: "", tone: "", title: "NSE publishes participant-wise OI; no BSE equivalent was located. NSE figures cover NSE contracts only." };
  if (!summary?.available) return summary ? { text: "Participant OI not available yet", main: "Participant OI not available yet", delta: "", tone: "", title: summary.detail ?? "" } : null;
  const hd = summary.headline ?? {};
  if (!isFigure(hd.fiiIndexFutLongPct)) return null;
  // The day is always in view; an old file (summary.stale) says so and takes the warn tone (§1.3 honesty).
  const stale = summary.stale === true;
  const main = `FII index futures (${shortDate(summary.date)}): ${formatPercent(hd.fiiIndexFutLongPct, 1)} long`;
  const delta = isFigure(hd.fiiIndexFutLongPctChange) ? `(${ptsText(hd.fiiIndexFutLongPctChange, 1)})` : "";
  const flag = stale ? "not current" : "";
  return {
    text: [delta ? `${main} ${delta}` : main, flag].filter(Boolean).join(" · "),
    main,
    delta,
    flag,
    // A change in long % is a fact, not good or bad news: no gain / loss colour (neutral copy, as on the page tile).
    tone: "",
    stale,
    title: `${PT_NOTE}, day ended ${longDate(summary.date)}.${stale ? ` ${staleText(summary)}.` : ""} ${hd.formula ?? ""}`.trim(),
  };
}

// ───────────────────────────── OI page tile (oi.js) ─────────────────────────────

let tileCache = { at: 0, data: null, loading: null, failedAt: 0 };
/** Forget the cached summary (tests). */
export function resetParticipantSummaryCache() {
  tileCache = { at: 0, data: null, loading: null, failedAt: 0 };
}
/**
 * Latest summary for the OI page line, fetched at most every 10 minutes; after a failed fetch, not again for 60 s
 * (the OI page redraws on every chain refresh, so an erroring route must not be asked on each redraw).
 * @param {number} [now] @param {typeof api} [fetcher]
 */
export async function participantSummaryCached(now = Date.now(), fetcher = api) {
  if (tileCache.data && now - tileCache.at < 600_000) return tileCache.data;
  if (tileCache.loading) return tileCache.loading;
  if (tileCache.failedAt && now - tileCache.failedAt < 60_000) return tileCache.data;
  tileCache.loading = Promise.resolve()
    .then(() => fetcher("/v1/participants/oi/summary"))
    .then((r) => {
      tileCache = { at: now, data: r?.data?.data ?? null, loading: null, failedAt: 0 };
      return tileCache.data;
    })
    .catch(() => {
      tileCache = { ...tileCache, loading: null, failedAt: now };
      return tileCache.data;
    });
  return tileCache.loading;
}

/** The OI page's participant line: an <a> that updates itself for the underlying in view. */
export function oiParticipantLine() {
  const text = h("span", { class: "oi-part-text" });
  const el = h("a", { class: "oi-part", href: "#/oi/participants", hidden: true }, icon("people"), text, h("span", { class: "oi-part-go" }, h("span", { class: "oi-part-sep", "aria-hidden": "true" }, "· "), "Participants", h("span", { "aria-hidden": "true" }, " →")));
  let sig = "";
  return {
    el,
    async update(underlying) {
      const s = await participantSummaryCached();
      const m = oiTileText(s, underlying);
      const next = m ? `${m.text}|${m.tone}|${m.title}` : "";
      if (next === sig) return;
      sig = next;
      el.hidden = !m;
      if (!m) return;
      text.replaceChildren(...[m.main, m.delta ? " " : null, m.delta ? h("b", { class: m.tone || null }, m.delta) : null, m.flag ? h("span", { class: "oi-part-flag" }, ` · ${m.flag}`) : null].filter((x) => x !== null));
      el.classList.toggle("stale", Boolean(m.stale));
      el.title = m.title;
    },
  };
}

// ───────────────────────────── page ─────────────────────────────

const readPrefs = () => {
  try {
    const v = JSON.parse(localStorage.getItem(SLOT) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const writePrefs = (v) => {
  try {
    localStorage.setItem(SLOT, JSON.stringify(v));
  } catch {
    /* private window */
  }
};

/** Save rows as a CSV file (the dashboard keeps its key in memory, so downloads go through fetch, not a link). */
function saveCsv(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const isoMinusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

/** One tile element. The FII long % tile has an info button with the formula and the long / short breakdown. */
function tileEl(t) {
  const value = h("span", { class: `value${t.tone ? ` ${t.tone}` : ""}` }, t.value);
  const mv = t.key === "fiiLongPct" ? h("span", { class: "pt-lp", "aria-hidden": "true" }, h("i", { class: "fill" }), h("i", { class: "mid" })) : null;
  if (mv && t.longPct !== null) mv.firstChild.style.setProperty("--v", String(Math.max(0, Math.min(100, t.longPct)) / 100));
  let label = h("span", { class: "label" }, t.label);
  // "+13.1K vs 28 Oct · net short": the net word wraps as one unit, never a lone "short" on the next line.
  const sub = h("span", { class: "sub" }, ...(t.subNote ? [t.subMain, " ", h("span", { class: "pt-sub-note" }, `· ${t.subNote}`)] : [t.sub || " "]));
  let desc = null;
  if (t.key === "fiiLongPct" && t.title) {
    const id = "pt-lp-formula";
    desc = h("span", { id, class: "sr-only" }, t.title);
    const btn = h("button", { type: "button", class: "icon-btn tiny pt-info", "aria-label": "How FII long % is worked out", "aria-describedby": id, "aria-haspopup": "dialog", "aria-expanded": "false" }, icon("info"));
    btn.addEventListener("click", () => {
      btn.setAttribute("aria-expanded", "true");
      sheetPopover({ trigger: btn, title: "FII index futures long %", body: h("p", { class: "pt-info-text" }, t.title), cls: "pt-info-pop" });
    });
    label = h("span", { class: "label pt-label-row" }, h("span", { class: "pt-label-t" }, t.label), btn);
  }
  return h("div", { class: `desk-stat pt-tile pt-t-${t.key}`, role: "group", "aria-label": t.aria, title: t.title || null }, label, value, mv, sub, desc);
}

/** A long % bar for a card or cell: long share filled, a 50 % tick. */
function longBar(pct) {
  const el = h("span", { class: "pt-lp", "aria-hidden": "true" }, h("i", { class: "fill" }), h("i", { class: "mid" }));
  if (pct !== null) el.firstChild.style.setProperty("--v", String(Math.max(0, Math.min(100, pct)) / 100));
  return el;
}

function tableEl(model) {
  const head1 = h("tr", {}, h("th", { class: "pt-p", rowspan: 2, scope: "col" }, "Participant"), model.columns.map((c) => h("th", { colspan: 4, scope: "colgroup", class: "pt-g" }, c.label)));
  const head2 = h("tr", {}, model.columns.map(() => [h("th", { scope: "col", class: "pt-c g0" }, "Long"), h("th", { scope: "col", class: "pt-c" }, "Short"), h("th", { scope: "col", class: "pt-c" }, "Net"), h("th", { scope: "col", class: "pt-c", title: "Change in net since the previous day" }, "Δ net")]));
  const body = model.rows.map((r) =>
    h(
      "tr",
      { class: r.total ? "pt-total" : null },
      h("th", { scope: "row", class: "pt-p" }, r.name),
      model.columns.map((c) => {
        const x = r.cells[c.id];
        return [
          h("td", { class: "g0", title: x.longPctText !== DASH ? x.longPctText : null }, x.long),
          h("td", {}, x.short),
          h("td", { class: r.total ? "" : x.netTone }, r.total ? DASH : x.net),
          h("td", { class: r.total ? "" : x.dTone }, r.total ? DASH : x.dnet),
        ];
      }),
    ),
  );
  // One column grid for every group table (see table.pt-grid in app.css), so the columns line up between tables.
  const cols = h("colgroup", {}, h("col", { class: "pt-col-p" }), model.columns.map(() => [h("col", {}), h("col", {}), h("col", {}), h("col", {})]));
  const wrap = h(
    "div",
    { class: "table-wrap pt-wrap", role: "region", "aria-label": `${model.label} by participant` },
    h("table", { class: "pt-table pt-grid" }, h("caption", { class: "sr-only" }, `${model.label}: long, short, net and change in net by participant, in contracts`), cols, h("thead", {}, head1, head2), h("tbody", {}, body)),
  );
  wrap.__label = `${model.label} by participant`;
  return wrap;
}

/**
 * A table that scrolls sideways is a tab stop (so the keyboard can scroll it) and says so; one that fits is neither.
 * Checked after layout and on every resize.
 */
export function syncScrollable(wrap) {
  const label = wrap.__label ?? wrap.getAttribute("aria-label") ?? "";
  const scrolls = wrap.scrollWidth > wrap.clientWidth + 1;
  if (scrolls) wrap.setAttribute("tabindex", "0");
  else wrap.removeAttribute("tabindex");
  wrap.setAttribute("aria-label", scrolls ? `${label} (scrolls sideways)` : label);
}

function cardsEl(model) {
  return h(
    "div",
    { class: "pt-cards" },
    h(
      "ul",
      { class: "pt-card-list", "aria-label": `${model.label} by participant` },
      model.cards.map((c) =>
        h(
          "li",
          { class: "pt-card" },
          h("div", { class: "pt-card-head" }, h("strong", {}, c.name), h("span", { class: "pt-card-lp" }, c.longPctText)),
          longBar(c.longPct),
          h(
            "dl",
            { class: "pt-card-grid" },
            h("div", {}, h("dt", {}, "Long"), h("dd", {}, c.long)),
            h("div", {}, h("dt", {}, "Short"), h("dd", {}, c.short)),
            h("div", {}, h("dt", {}, "Net"), h("dd", { class: c.netTone }, c.net)),
            h("div", {}, h("dt", {}, "Δ net"), h("dd", { class: c.dTone }, c.dnet)),
          ),
          c.share ? h("p", { class: "pt-card-share" }, c.share) : null,
        ),
      ),
    ),
    model.total ? h("p", { class: "pt-card-total" }, model.total) : null,
  );
}

/** Draw one small multiple into its host (re-run on resize). `first`: the multiple that labels revision marks. */
function drawSpark(host, s, model, first = false) {
  const W = Math.max(220, Math.round(host.clientWidth || 320));
  const H = 136;
  const revs = model.revisions.length > 0;
  // With revision marks, the label sits in a strip above the plot (never over the lines).
  const padT = revs ? 22 : 10;
  const g = sparkGeometry(s.points, model.slots, { w: W, h: H, kind: s.kind, padT });
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "pt-svg", "aria-hidden": "true" });
  for (const t of g.ticks) {
    svg.append(svgEl("line", { class: "dv-grid", x1: 40, x2: W - 10, y1: g.y(t), y2: g.y(t) }));
    svg.append(svgEl("text", { class: "dv-tick", x: 34, y: g.y(t), "text-anchor": "end", "dominant-baseline": "central" }, s.kind === "pct" ? `${formatFixed(t, 0)}%` : formatCompactTick(t)));
  }
  if (g.ref !== null) svg.append(svgEl("line", { class: "dv-zero", x1: 40, x2: W - 10, y1: g.y(g.ref), y2: g.y(g.ref) }));
  for (const r of model.revisions) {
    const x = g.x(r.i);
    svg.append(svgEl("line", { class: "pt-rev", x1: x, x2: x, y1: first ? 4 : padT, y2: H - 18 }));
    if (first) svg.append(svgEl("text", { class: "dv-tick pt-rev-t", x: x > W - 150 ? x - 4 : x + 4, y: 11, "text-anchor": x > W - 150 ? "end" : "start" }, "Contract size changed"));
  }
  svg.append(svgEl("path", { class: "pt-line", d: g.d, "data-dv": s.dv }));
  const lastP = s.points[s.points.length - 1];
  if (lastP) svg.append(svgEl("circle", { class: "pt-dot", cx: g.x(lastP.i), cy: g.y(lastP.value), r: 3, "data-dv": s.dv }));
  const [a, b] = rangeEnds(model.from, model.to);
  svg.append(svgEl("text", { class: "dv-tick", x: 40, y: H - 4, "text-anchor": "start" }, a));
  svg.append(svgEl("text", { class: "dv-tick", x: W - 10, y: H - 4, "text-anchor": "end" }, b));
  host.querySelector("svg")?.remove();
  host.prepend(svg);
  return g;
}

export async function renderParticipantsPage() {
  const prefs = readPrefs();
  const st = { range: PT_RANGES.some(([v]) => v === prefs.range) ? prefs.range : "60", side: prefs.side === "STK" ? "STK" : "IDX", kind: ["FUT", "CE", "PE"].includes(prefs.kind) ? prefs.kind : "FUT", showTable: prefs.showTable === true };
  const save = () => writePrefs(st);

  const [sumR, statusR] = await Promise.all([api("/v1/participants/oi/summary").then((r) => ({ r }), (e) => ({ e })), api("/v1/participants/status").then((r) => ({ r }), (e) => ({ e }))]);
  if (sumR.e) return h("section", { class: "desk-panel pt-panel" }, errorState(sumR.e, { onRetry: () => window.dispatchEvent(new HashChangeEvent("hashchange")) }));
  const summary = sumR.r.data?.data ?? null;
  const status = statusR.r?.data?.data ?? null;
  const state = pageState(summary, status, { hasCalendar: PAGES.some((p) => p.id === "calendar") });
  const stale = staleText(summary);

  // ── Toolbar: what the data is, and how fresh ──
  const day = state.kind === "ok" ? summary.date : status?.latestDate ?? null;
  const cap = h(
    "div",
    { class: "ctx-cap glass pt-ctx" },
    h("span", { class: "ctx-item ctx-pt-ex", title: "NSE publishes participant-wise OI; no BSE file" }, h("span", { class: "ctx-main" }, "NSE")),
    day ? h("span", { class: "ctx-item ctx-pt-day", title: "Trading day the figures are for" }, h("span", { class: "ctx-main" }, h("span", { class: "ctx-k" }, "Day ended"), h("b", {}, shortDate(day)))) : null,
    state.kind === "ok" && summary.fetchedAt ? h("span", { class: "ctx-item ctx-pt-at", title: summary.demo ? "Sample file time (demo)" : "When this Bridge fetched the file" }, h("span", { class: "ctx-main" }, h("span", { class: "ctx-k" }, summary.demo ? "Sample" : "Fetched"), h("b", {}, String(summary.fetchedAt).slice(11, 16)))) : null,
  );
  const srcOk = (status?.source?.nseArchives === "on" || status?.demo) && !stale;
  const srcText = stale ? "Not current" : status?.demo ? "Sample history" : status?.source?.nseArchives === "on" ? "NSE archives" : status?.source?.nseArchives === "off" ? "Downloads off" : "Unavailable";
  const srcChip = h("span", { class: `pt-src${srcOk ? "" : " warn"}`, title: [stale, backfillText(status)].filter(Boolean).join(". ") || null }, srcText);
  mountToolbarCtx("participants", cap, h("span", { class: "ctx-spacer" }), srcChip);

  if (state.kind !== "ok") {
    const recheck = () => window.dispatchEvent(new HashChangeEvent("hashchange"));
    const act =
      state.kind === "source-off" && PAGES.some((p) => p.id === "calendar")
        ? h("button", { type: "button", class: "small", onclick: () => (location.hash = "#/calendar") }, icon("clock"), "Market calendar")
        : state.kind === "stale" || state.kind === "no-data" || state.kind === "unavailable"
          ? h("button", { type: "button", class: "small", onclick: recheck }, icon("refresh"), "Check again")
          : null;
    const empty = emptyState("people", state.title, state.text, act);
    // The back-fill line is shown once: here, under the state; the notes panel then keeps its plain subtitle.
    if (state.note) empty.insertBefore(h("p", { class: "pt-empty-note" }, state.note), empty.querySelector(".empty-acts"));
    return [
      h("section", { class: "desk-panel pt-panel pt-empty", "data-panel": "pt-state", "aria-label": "Participant OI" }, empty),
      notesPanel(summary, status, { backfillShown: Boolean(state.note) }),
    ];
  }

  // ── Tiles ──
  const tiles = tilesModel(summary);
  const qualityChip =
    summary.quality === "totals-mismatch"
      ? h("span", { class: "pt-chip warn", title: mismatchText(summary) }, mismatchText(summary))
      : summary.quality === "partial"
        ? h("span", { class: "pt-chip warn" }, "Some participant rows were missing in NSE's file")
        : null;
  const kpi = h(
    "section",
    { class: "desk-panel pt-kpi", "data-panel": "pt-kpi", "data-fixed": "", "aria-label": "Participant OI headline" },
    h("p", { class: "pt-top" }, h("span", {}, topLine(summary)), stale ? h("span", { class: "pt-chip warn" }, stale) : null, qualityChip),
    h("div", { class: "desk-stats pt-tiles" }, tiles.map(tileEl)),
  );

  // ── Table (desktop / tablet) and cards (phone) ──
  const csvBtn = h("button", { type: "button", class: "small pt-csv", title: "Download this day's table as CSV" }, icon("download"), h("span", { class: "pt-csv-l" }, "CSV"));
  csvBtn.addEventListener("click", async () => {
    try {
      const r = await api(`/v1/participants/oi?from=${summary.date}&to=${summary.date}&format=csv`);
      saveCsv(`participant-oi_${summary.date}.csv`, r.text);
      toast("CSV saved");
    } catch (err) {
      toast(err?.message ?? "Could not make the CSV", { tone: "bad" });
    }
  });
  const sideSeg = segmented("Index or stock", [["IDX", "Index"], ["STK", "Stock"]], st.side);
  const kindSeg = segmented("Instrument", [["FUT", "Futures"], ["CE", "Calls"], ["PE", "Puts"]], st.kind);
  const picker = h("div", { class: "pt-picker" }, sideSeg, kindSeg);
  const cardsHost = h("div", { class: "pt-cards-host" });
  const drawCards = () => cardsHost.replaceChildren(cardsEl(cardsModel(summary, `${st.side}_${st.kind}`)));
  sideSeg.addEventListener("change", () => {
    st.side = sideSeg.value;
    save();
    drawCards();
  });
  kindSeg.addEventListener("change", () => {
    st.kind = kindSeg.value;
    save();
    drawCards();
  });
  drawCards();
  const prevNote = summary.previousDate ? `Δ vs ${shortDate(summary.previousDate)}` : "No previous day";
  const tablePanel = h(
    "section",
    { class: "desk-panel pt-table-panel", "data-panel": "pt-table", "aria-label": "Positions by participant" },
    h("div", { class: "panel-head" }, h("div", { class: "pt-title" }, h("strong", {}, "By participant"), h("span", { class: "pt-sub" }, `Contracts · ${prevNote}`)), h("div", { class: "pt-ctl" }, csvBtn)),
    h("div", { class: "pt-tables" }, PT_GROUPS.map((g) => h("div", { class: "pt-group" }, h("h3", { class: "pt-group-h" }, g.label), tableEl(tableModel(summary, g.id))))),
    h("div", { class: "pt-phone" }, picker, cardsHost),
  );

  // ── History (chart-engine slot: SVG small multiples, table toggle, CSV) ──
  // The skeleton mirrors the small multiples: a 2 × 2 grid (one column on phones).
  const histBody = h(
    "div",
    { class: "pt-hist-body", "aria-busy": "true" },
    h("div", { class: "pt-multiples pt-skel" }, PT_SERIES.map((s, k) => h("div", { class: "pt-multiple" }, loadingState({ rows: 4, cols: 2, height: 34, label: k === 0 ? "Loading history" : s.label })))),
  );
  const rangeSeg = segmented("History range", PT_RANGES, st.range);
  const tableBtn = h("button", { type: "button", class: "small pt-tbl-btn", "aria-pressed": String(st.showTable) }, icon("list"), h("span", { class: "pt-csv-l" }, "Table"));
  const histCsv = h("button", { type: "button", class: "small pt-csv", title: "Download the history in view as CSV" }, icon("download"), h("span", { class: "pt-csv-l" }, "CSV"));
  const histSub = h("span", { class: "pt-sub" }, "Trading days · gaps are days without a file");
  const histPanel = h(
    "section",
    { class: "desk-panel pt-hist", "data-panel": "pt-hist", "aria-label": "Participant OI history" },
    h("div", { class: "panel-head" }, h("div", { class: "pt-title" }, h("strong", {}, "History"), histSub), h("div", { class: "pt-ctl" }, rangeSeg, tableBtn, histCsv)),
    // The owner's chart engine plugs in here; the SVG small multiples, table and CSV below are the fallback.
    h("div", { class: "pt-slot-wrap" }, chartSlot("Participant OI history", "FII index-futures long %, FII net, client index call and put nets by day")),
    histBody,
  );
  let days = null;
  let model = null;
  const scrubs = [];
  /** The range, Table and CSV controls work on loaded history only: off (aria-disabled) until it arrives. */
  const setHistControls = (on) => {
    for (const el of [rangeSeg, tableBtn, histCsv]) {
      if (on) el.removeAttribute("aria-disabled");
      else el.setAttribute("aria-disabled", "true");
      el.classList.toggle("pt-off", !on);
    }
  };
  setHistControls(false);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => redrawSparks()) : null;
  const hosts = [];
  function redrawSparks() {
    if (!model || !histPanel.isConnected) {
      if (!histPanel.isConnected) ro?.disconnect();
      return;
    }
    hosts.forEach(({ host, s }, k) => {
      const w = Math.round(host.clientWidth);
      if (host.__w === w) return;
      host.__w = w;
      host.__g = drawSpark(host, s, model, k === 0);
    });
  }
  function drawHistory() {
    scrubs.splice(0).forEach((x) => x.destroy());
    hosts.length = 0;
    ro?.disconnect();
    model = historyModel(days ?? [], st.range, allRevisions);
    if (!model.dates.length) {
      histBody.replaceChildren(emptyState("people", "No history yet", "Older days fill in from the NSE archive outside market hours.", null, { compact: true }));
      return;
    }
    const [a, b] = rangeEnds(model.from, model.to);
    histSub.textContent = `${a} – ${b} · ${model.dates.length} trading days${model.gaps ? ` · ${model.gaps} without a file` : ""}`;
    const grid = h("div", { class: "pt-multiples", "data-chart-slot": "participant-oi-history" });
    for (const s of model.series) {
      const host = h("div", { class: "pt-chart" });
      const card = h(
        "figure",
        { class: "pt-multiple" },
        h("figcaption", {}, h("span", { class: "pt-m-label" }, h("span", { class: "dv-key line", "data-dv": s.dv, "aria-hidden": "true" }), s.label), h("span", { class: "pt-m-val" }, h("b", { class: s.kind === "net" ? toneOf(s.last) : "" }, s.lastText), h("span", { class: "pt-m-chg" }, ` ${s.changeText} in range`))),
        host,
        h("p", { class: "sr-only" }, `${s.label}: ${s.lastText} on ${longDate(model.to)}, ${s.changeText} since ${longDate(model.from)}; low ${valueText(s, s.min)}, high ${valueText(s, s.max)}.`),
      );
      grid.append(card);
      hosts.push({ host, s });
    }
    const parts = [grid];
    if (model.revisions.length) parts.push(h("p", { class: "pt-rev-note" }, icon("info"), model.revisions.map((r) => `${longDate(r.date)}: ${r.text}.`).join(" "), " Long % and shares are ratios and stay comparable."));
    if (st.showTable) parts.push(historyTable(model));
    histBody.replaceChildren(...parts);
    histBody.removeAttribute("aria-busy");
    requestAnimationFrame(() => {
      redrawSparks();
      for (const { host, s } of hosts) {
        scrubs.push(
          scrubber(host, {
            steps: () => s.points.length,
            label: `${s.label}: use the arrow keys to read each day`,
            // Points sit on weekday slots inside the plot padding: read the nearest plotted day, not a linear guess.
            indexAt: (x) => {
              const g = host.__g;
              if (!g || !s.points.length) return -1;
              let best = 0;
              for (let k = 1; k < s.points.length; k += 1) if (Math.abs(g.x(s.points[k].i) - x) < Math.abs(g.x(s.points[best].i) - x)) best = k;
              return best;
            },
            at: (i) => {
              const p = s.points[i];
              const g = host.__g;
              if (!p || !g) return null;
              return { x: g.x(p.i), content: [h("b", {}, longDate(p.date)), h("div", {}, valueText(s, p.value))] };
            },
          }),
        );
        ro?.observe(host);
      }
    });
  }
  let allRevisions = summary.revisions ?? [];
  rangeSeg.addEventListener("change", () => {
    if (!days) {
      if (rangeSeg.value !== st.range) rangeSeg.value = st.range;
      return;
    }
    st.range = rangeSeg.value;
    save();
    drawHistory();
  });
  tableBtn.addEventListener("click", () => {
    if (!days) return toast("History is still loading");
    st.showTable = !st.showTable;
    tableBtn.setAttribute("aria-pressed", String(st.showTable));
    save();
    drawHistory();
  });
  histCsv.addEventListener("click", () => {
    if (!days) return toast("History is still loading");
    if (!model?.dates.length) return toast("No history to save yet");
    saveCsv(`participant-oi-history_${model.from}_${model.to}.csv`, toCsvText(historyCsv(model)));
    toast("CSV saved");
  });
  (async () => {
    try {
      const from = isoMinusDays(summary.date, 749);
      const r = await api(`/v1/participants/oi?from=${from}&to=${summary.date}&participants=FII,CLIENT&instruments=IDX_FUT,IDX_CE,IDX_PE`);
      days = r.data?.data?.days ?? [];
      allRevisions = revisionsFrom(days, summary);
      setHistControls(true);
      drawHistory();
    } catch (err) {
      histBody.replaceChildren(errorState(err, { onRetry: () => window.dispatchEvent(new HashChangeEvent("hashchange")) }));
      histBody.removeAttribute("aria-busy");
    }
  })();

  // Tab stops and "(scrolls sideways)" only for group tables that do scroll at this width.
  const wraps = [...tablePanel.querySelectorAll(".pt-tables .pt-wrap")];
  const syncWraps = () => {
    if (!tablePanel.isConnected) return wrapRo?.disconnect();
    wraps.forEach(syncScrollable);
  };
  const wrapRo = typeof ResizeObserver === "function" ? new ResizeObserver(syncWraps) : null;
  wraps.forEach((w) => {
    syncScrollable(w);
    wrapRo?.observe(w);
  });
  requestAnimationFrame(syncWraps);

  return [kpi, tablePanel, histPanel, notesPanel(summary, status)];
}

/** Revision marks: where lotRegime changes between consecutive days (the server's dates when it names them). */
export function revisionsFrom(days, summary) {
  const out = [];
  const known = new Map((summary?.revisions ?? []).map((r) => [r.date, r.text]));
  for (let i = 1; i < (days ?? []).length; i += 1) {
    const a = days[i - 1].lotRegime;
    const b = days[i].lotRegime;
    if (a && b && a !== b) out.push({ date: days[i].date, text: known.get(days[i].date) ?? "Contract size changed; counts before and after are not like for like" });
  }
  return out;
}

function historyTable(model) {
  const rows = [...model.dates].reverse();
  const val = new Map(model.series.map((s) => [s.key, new Map(s.points.map((p) => [p.date, p.value]))]));
  return h(
    "div",
    { class: "table-wrap pt-wrap pt-hist-table", tabindex: "0", role: "region", "aria-label": "History table (scrolls)" },
    h(
      "table",
      { class: "pt-table" },
      h("caption", { class: "sr-only" }, "Participant OI history by day, newest first"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "pt-p" }, "Date"), model.series.map((s) => h("th", { scope: "col", class: "pt-c" }, s.label)))),
      h("tbody", {}, rows.map((d) => h("tr", {}, h("th", { scope: "row", class: "pt-p" }, longDate(d)), model.series.map((s) => h("td", { class: s.kind === "net" ? toneOf(val.get(s.key).get(d)) : "" }, valueText(s, val.get(s.key).get(d))))))),
    ),
  );
}

function notesPanel(summary, status, { backfillShown = false } = {}) {
  const items = [
    h("li", {}, h("strong", {}, "What it is. "), "NSE's daily participant-wise open interest: contracts held long and short by clients, domestic institutions (DII), foreign investors (FII) and proprietary desks (Pro), summed over every strike, expiry and NSE index or stock."),
    h("li", {}, h("strong", {}, "Long %. "), summary?.headline?.formula ?? "FII long ÷ (FII long + FII short) × 100, in contracts", "."),
    h("li", {}, h("strong", {}, "Contract sizes. "), "Counts before and after a lot-size revision are not like for like; the history marks each change. Long % and shares are ratios and stay comparable."),
    h("li", {}, h("strong", {}, "BSE. "), "No BSE participant file was located, so SENSEX and BANKEX have no participant figures."),
  ];
  const bf = backfillShown ? "" : backfillText(status);
  return h(
    "section",
    { class: "desk-panel pt-notes", "data-panel": "pt-notes", "aria-label": "About participant OI" },
    h("div", { class: "panel-head" }, h("div", { class: "pt-title" }, h("strong", {}, "About this data"), h("span", { class: "pt-sub" }, bf || PT_NOTE))),
    h("ul", { class: "pt-notes-list" }, items),
    h("p", { class: "pt-disclaimer" }, PT_DISCLAIMER, summary?.source ? ` Source: ${summary.source === "demo" ? "sample data generated on this computer (demo)" : summary.source}.` : ""),
  );
}
