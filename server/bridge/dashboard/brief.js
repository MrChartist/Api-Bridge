// The Market brief: one underlying's market in plain facts, opened with Shift+Y from any page (a panel on the right
// from 720 px up, a bottom sheet on phones) and summed up in one strip on Home. Deterministic: every line is computed
// from the Bridge's own data by brief-core.js (pure, tested); there is no language model and no advice.
//
// Reads, all GET and all shared with other pages through the dashboard's cache:
//   /v1/reference/bundle            expiries (the nearest, and the monthly whose future gives VWAP), session times
//   /v1/optionchain                 walls, max pain, PCR, ATM IV, expected move (today-core keyLevels, as Home)
//   /v1/history 5m (index, future)  trend regime, RSI, MACD, day high / low; VWAP from the near future's volume
//   /v1/history 1d (index)          the previous session for pivots and CPR
//   /v1/analytics/markets/movers    advance / decline (NIFTY 50 for NIFTY, F&O stocks otherwise)
//   /v1/vol/rank                    where IV sits in its stored range
//   /v1/options/snapshots           the recorder's minutes, for what changed in the last 15 minutes
// The answers are kept for 60 s while the market is open (5 minutes when it is closed), so the panel and the Home
// strip share one read.
import { api, h, icon, loadingState, optional, store } from "./app.js";
import { DASH, formatFixed, formatGrouped, formatInt, formatPercent, formatSigned } from "./format.js";
import {
  INDEX_SYMBOL,
  TREND_RULE,
  breadthFact,
  briefLevels,
  changeSentences,
  classicPivots,
  istDateOf,
  istHm,
  ivRange,
  macd,
  macdFact,
  mergeLevels,
  oiShift,
  oiWindow,
  pickWindow,
  prevSession,
  rsi,
  rsiFact,
  sessionStart,
  sessionVwap,
  snapOfChain,
  snapTime,
  trendRegime,
  trendWords,
  vwapCross,
} from "./brief-core.js";
import { dataLine, dayText, keyLevels, marketClock, upcomingExpiries } from "./today-core.js";

/** The underlyings the brief follows (the three with a reference bundle on Home). */
export const BRIEF_UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "SENSEX"]);
const U_KEY = "mcb.brief.underlying";
const HOME_KEY = "mcb.home.levelsUnderlying";
const local = store("local");
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const istToday = (ms) => new Date(ms + 19_800_000).toISOString().slice(0, 10);
const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  el.append(...kids.filter(Boolean));
  return el;
};
const toneCls = (t) => (t === "up" ? "up" : t === "down" ? "down" : "");
const distText = (d) => (num(d) === null ? "" : Math.abs(d) < 0.5 ? "At spot" : d > 0 ? `${formatInt(d)} above` : `${formatInt(-d)} below`);

/** The underlying the brief shows: its own choice, else Home's key-levels choice, else NIFTY. */
export function briefUnderlying() {
  const own = local.get(U_KEY);
  if (BRIEF_UNDERLYINGS.includes(own)) return own;
  const home = local.get(HOME_KEY);
  return BRIEF_UNDERLYINGS.includes(home) ? home : "NIFTY";
}

// ── Reading ──

const cache = new Map(); // underlying -> { at, ttl, data } | { pending }
/** The chains this tab read itself, per underlying and expiry (the 15-minute fallback when the recorder is off). */
const seen = new Map();
const json = (r) => r?.data?.data ?? null;

/**
 * Everything the brief prints for one underlying, computed once and kept for a minute. Never throws: a part that
 * cannot be read is null and prints a dash.
 */
export async function readBrief(u, { force = false } = {}) {
  const c = cache.get(u);
  if (c?.pending) return c.pending;
  if (!force && c?.data && Date.now() - c.at < c.ttl) return c.data;
  const pending = compose(u)
    .then((data) => {
      const open = data.clock?.phase === "open";
      cache.set(u, { at: Date.now(), ttl: open ? 60_000 : 300_000, data });
      return data;
    })
    .catch((err) => {
      cache.delete(u);
      throw err;
    });
  cache.set(u, { ...(c ?? {}), pending });
  return pending;
}

async function compose(u) {
  const now = Date.now();
  const today = istToday(now);
  const bundle = json(await optional(api(`/v1/reference/bundle?underlying=${u}`)));
  const clock = bundle ? marketClock({ nowMs: now, session: bundle.session, holidays: bundle.holidays }) : null;
  const near = upcomingExpiries([bundle].filter(Boolean), today, 60)[0] ?? null;
  const monthly = (bundle?.expiries ?? []).find((e) => e.kind === "monthly" && e.date >= today) ?? null;
  const idx = INDEX_SYMBOL[u];
  const fut = monthly && bundle?.exchange ? `${bundle.exchange}:${u}-${monthly.date}-FUT` : null;
  const q = (o) => new URLSearchParams(o).toString();
  const [chainR, idxR, futR, dayR, mvR, rankR, snapR] = await Promise.all([
    near ? optional(api(`/v1/optionchain?${q({ underlying: u, expiry: near.date, strikes: "40" })}`)) : null,
    optional(api(`/v1/history?${q({ symbol: idx, interval: "5m", countback: "200" })}`)),
    fut ? optional(api(`/v1/history?${q({ symbol: fut, interval: "5m", countback: "80" })}`)) : null,
    optional(api(`/v1/history?${q({ symbol: idx, interval: "1d", countback: "6" })}`)),
    optional(api(`/v1/analytics/markets/movers?${q({ universe: u === "NIFTY" ? "NIFTY50" : "FNO", limit: "1" })}`)),
    optional(api(`/v1/vol/rank?${q({ underlying: u })}`)),
    near ? optional(api(`/v1/options/snapshots?${q({ underlying: u, expiry: near.date, fields: "oi", strikes: "7", every: "5", limit: "100" })}`)) : null,
  ]);

  // The index: trend, RSI, MACD, day range.
  const candles = json(idxR)?.candles ?? [];
  const s0 = sessionStart(candles);
  const todayBars = s0 < 0 ? [] : candles.slice(s0);
  const trend = trendRegime(candles);
  const closes = candles.map((x) => Number(x.close));
  const rsiV = closes.length ? rsi(closes).at(-1) : null;
  const m = closes.length ? macdFact(macd(closes), candles.map((x) => x.time)) : null;
  const dayHigh = todayBars.length ? Math.max(...todayBars.map((x) => Number(x.high))) : null;
  const dayLow = todayBars.length ? Math.min(...todayBars.map((x) => Number(x.low))) : null;
  const session = todayBars.length ? istDateOf(todayBars[0].time) : today;

  // The chain: the same key levels as Home.
  const chain = json(chainR);
  const lv = chain?.rows?.length ? keyLevels(chain) : null;
  const spot = lv?.spot ?? (closes.length ? closes.at(-1) : null);

  // VWAP of the near future.
  const v = sessionVwap(json(futR)?.candles ?? []);
  const cross = vwapCross(v);

  // Pivots from the previous session.
  const prev = prevSession(json(dayR)?.candles ?? [], session);
  const piv = classicPivots(prev);
  const levels = briefLevels({ callWall: lv?.callWall?.strike, putWall: lv?.putWall?.strike, maxPain: lv?.maxPain?.strike, dayHigh, dayLow, rangeLo: lv?.rangeLo, rangeHi: lv?.rangeHi, pivots: piv });
  const reach = num(lv?.move) !== null && lv.move > 0 ? 3 * lv.move : spot === null ? null : spot * 0.05;
  const ladder = mergeLevels(levels, spot, { span: reach });

  // What changed: the recorder's minutes, else the chains this tab read.
  const key = `${u}|${near?.date ?? ""}`;
  const mine = seen.get(key) ?? [];
  const snapOfThis = chain ? snapOfChain(chain, now) : null;
  if (snapOfThis && (!mine.length || snapOfThis.at > mine.at(-1).at)) mine.push(snapOfThis);
  while (mine.length > 60) mine.shift();
  seen.set(key, mine);
  const recorded = json(snapR)?.snapshots ?? [];
  const win = pickWindow(recorded) ?? pickWindow(mine);
  const shift = win ? oiShift(oiWindow(win.before), oiWindow(win.after)) : null;
  const sentences = changeSentences({ shift, cross, vwapSide: v?.side ?? null, minutes: 15 });

  const asOf = Date.parse(chain?.freshness?.asOf ?? json(idxR)?.freshness?.asOf ?? "");
  return {
    u,
    at: now,
    clock,
    near,
    asOfMs: Number.isFinite(asOf) ? asOf : null,
    spot,
    todayBars,
    trend,
    words: trendWords(trend),
    rsi: rsiFact(rsiV),
    macd: m,
    vwap: v,
    fut,
    breadth: breadthFact(json(mvR)?.summary),
    breadthScope: u === "NIFTY" ? "NIFTY 50 stocks" : "F&O stocks",
    lv,
    iv: ivRange(json(rankR)),
    ladder,
    piv,
    sentences,
    shiftSource: win ? (pickWindow(recorded) ? "recorder" : "tab") : null,
    windowEnd: win ? snapTime(win.after) : null,
  };
}

// ── Pictures ──

/** Today's closes as a line, the current regime's part in its colour, a dot at the last close. */
function trendSpark(b) {
  const bars = b.todayBars;
  if (bars.length < 2) return null;
  const W = 280;
  const H = 56;
  const ys = bars.map((x) => Number(x.close));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const x = (i) => (i / (bars.length - 1)) * (W - 4) + 2;
  const y = (v) => (hi > lo ? H - 4 - ((v - lo) / (hi - lo)) * (H - 8) : H / 2);
  const path = (from, to) => ys.slice(from, to + 1).map((v, k) => `${k ? "L" : "M"}${Math.round(x(from + k) * 10) / 10},${Math.round(y(v) * 10) / 10}`).join("");
  const s = b.trend?.sinceIndex ?? bars.length - 1;
  const tone = b.trend?.state ?? "flat";
  return svg(
    "svg",
    { class: `mb-spark ${tone}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    s > 0 ? svg("path", { class: "mb-spark-old", d: path(0, s) }) : null,
    svg("path", { class: "mb-spark-now", d: path(s, bars.length - 1) }),
    svg("circle", { class: "mb-spark-dot", cx: x(bars.length - 1), cy: y(ys.at(-1)), r: 3 }),
  );
}

/** A 0–1 position on a short track, with an optional pair of guide marks (30 and 70 for RSI). */
function meter(at, { guides = [], tone = "" } = {}) {
  if (num(at) === null) return null;
  const dot = h("i", { class: `mb-meter-dot ${tone}`.trim() });
  dot.style.left = `${Math.round(Math.max(0, Math.min(1, at)) * 1000) / 10}%`;
  return h("span", { class: "mb-meter", "aria-hidden": "true" }, ...guides.map((g) => {
    const m = h("b");
    m.style.left = `${g * 100}%`;
    return m;
  }), dot);
}

// ── The brief's sections ──

function trendCard(b) {
  const w = b.words;
  const t = b.trend;
  const sub = t ? `${istHm(t.since)} IST${t.fromOpen ? " · the open" : ""}` : "";
  return h(
    "section",
    { class: `mb-trend ${w.tone}`, "aria-label": `Trend: ${w.title}` },
    h("div", { class: "mb-trend-top" }, h("span", { class: "mb-trend-k" }, `${b.u} · 5-minute trend`), h("span", { class: "mb-trend-since" }, sub)),
    h("div", { class: "mb-trend-word" }, h("strong", {}, w.word), t ? h("span", {}, ` since ${istHm(t.since)}`) : null),
    trendSpark(b),
    h("p", { class: "mb-trend-detail" }, w.detail),
    h(
      "details",
      { class: "mb-rule" },
      h("summary", {}, "How this is read"),
      h(
        "p",
        {},
        `EMA ${formatInt(TREND_RULE.ema)} of the index's 5-minute closes. Rising: the EMA climbed at least ${formatFixed(TREND_RULE.slopeK, 1)}× the median candle range over the last ${formatInt(TREND_RULE.lookback)} candles and the close is above it. Falling: the mirror image. Anything else is Sideways. A new state counts once it holds for ${formatInt(TREND_RULE.confirm)} candles; the time is the first of them.`,
      ),
    ),
  );
}

function factRow(label, value, note, { tone = "", extra = null, tip = "" } = {}) {
  return h("div", { class: "mb-fact", title: tip || undefined }, h("dt", {}, label), h("dd", { class: toneCls(tone) }, value), h("span", { class: "mb-fact-note" }, note, extra));
}

function facts(b) {
  const br = b.breadth;
  const lv = b.lv;
  const iv = b.iv;
  const m = b.macd;
  const v = b.vwap;
  const rows = [
    factRow("Breadth", br ? `${formatInt(br.up)} up · ${formatInt(br.down)} down` : DASH, br ? `${b.breadthScope}${br.flat ? ` · ${formatInt(br.flat)} unchanged` : ""}` : "No quotes yet", { tone: br?.tone, extra: br ? splitBar(br) : null }),
    factRow("OI PCR", num(lv?.pcr) === null ? DASH : formatFixed(lv.pcr, 2), lv ? `Put ÷ Call OI · ${formatInt(lv.pcrStrikes)} strikes · expiry ${dayText(b.near?.date ?? "")}` : "Chain unavailable", { tip: "Put open interest ÷ Call open interest over the strikes read" }),
    factRow("RSI 14", b.rsi ? formatFixed(b.rsi.value, 1) : DASH, b.rsi ? `5-minute · ${b.rsi.zone}` : "Needs more candles", { extra: b.rsi ? meter(b.rsi.value / 100, { guides: [0.3, 0.7] }) : null }),
    factRow(
      "MACD",
      m ? (m.above ? "Above its average" : "Below its average") : DASH,
      m ? `12, 26, 9 · 5-minute${m.since ? ` · since ${istHm(m.since)}` : ""} · histogram ${formatSigned(m.hist, 2)}` : "Needs more candles",
      { tone: m ? (m.above ? "up" : "down") : "", tip: "The MACD line against its own 9-period EMA" },
    ),
    factRow(
      "ATM IV",
      num(lv?.atmIv) === null ? DASH : formatPercent(lv.atmIv, 1),
      iv ? `30-day IV ${formatFixed(iv.iv, 1)} · range ${formatFixed(iv.lo, 1)} to ${formatFixed(iv.hi, 1)} over ${formatInt(iv.days)} days${num(iv.rank) !== null ? ` · rank ${formatInt(iv.rank)}` : ""}` : "IV range: collecting stored days",
      { extra: iv ? meter(iv.at) : null, tip: "Nearest expiry's ATM IV; the range is the Bridge's stored 30-day constant-maturity IV" },
    ),
    factRow(
      "VWAP",
      v ? (v.side === "at" ? "At VWAP" : `${v.side === "above" ? "Above" : "Below"} by ${formatGrouped(Math.abs(v.close - v.last), 2)}`) : DASH,
      v ? `Near future ${formatGrouped(v.close, 2)} · VWAP ${formatGrouped(v.last, 2)} · today` : "Needs the near future's volume",
      { tone: v?.side === "above" ? "up" : v?.side === "below" ? "down" : "", tip: b.fut ? `${b.fut}: volume-weighted typical price of today's 5-minute candles` : "" },
    ),
  ];
  return h("section", { class: "mb-sec" }, h("h3", {}, "At a glance"), h("dl", { class: "mb-facts" }, rows));
}

function splitBar(br) {
  const a = h("i", { class: "up" });
  const d = h("i", { class: "down" });
  a.style.flexGrow = String(br.up || 0);
  d.style.flexGrow = String(br.down || 0);
  return br.up + br.down ? h("span", { class: "mb-split", "aria-hidden": "true" }, a, d) : null;
}

function ladder(b) {
  const { rows, off } = b.ladder;
  const lv = b.lv;
  if (!rows.length || rows.length === 1) return h("section", { class: "mb-sec" }, h("h3", {}, "Key levels"), h("p", { class: "mb-quiet" }, "No levels to place yet."));
  const kindCls = (r) => (r.spot ? "spot" : r.kinds[0] === "ce" ? "ce" : r.kinds[0] === "pe" ? "pe" : r.kinds[0] === "mp" ? "mp" : r.kinds.some((k) => k === "hi" || k === "lo") ? "day" : r.kinds.some((k) => k === "mhi" || k === "mlo") ? "rng" : "piv");
  const list = h(
    "ol",
    { class: "mb-ladder", "aria-label": "Levels, highest first" },
    rows.map((r) =>
      h(
        "li",
        { class: kindCls(r) },
        h("i", { class: "mb-pin", "aria-hidden": "true" }),
        h("span", { class: "mb-lv-name" }, r.labels.join(" · ")),
        h("span", { class: "mb-lv-px" }, r.spot ? formatGrouped(r.price, 2) : formatInt(r.price)),
        h("span", { class: "mb-lv-d" }, r.spot ? "" : distText(r.dist)),
      ),
    ),
  );
  const move = num(lv?.move) === null ? null : `Expected move ±${formatGrouped(lv.move, 0)} to expiry (0.85 × ATM straddle, a pricing convention)`;
  const pivNote = b.piv ? "Pivots and CPR from the previous session" : null;
  return h(
    "section",
    { class: "mb-sec" },
    h("div", { class: "mb-sec-head" }, h("h3", {}, "Key levels"), h("a", { class: "lk small", href: "#/chain" }, "Chain")),
    list,
    h("p", { class: "mb-quiet" }, [move, pivNote, off.length ? `${off.join(" and ")} more than three expected moves away` : null].filter(Boolean).join(" · ")),
  );
}

function changes(b) {
  const xs = b.sentences;
  const end = num(b.windowEnd);
  const head = h("div", { class: "mb-sec-head" }, h("h3", {}, "Last 15 minutes"), end === null ? null : h("span", { class: "mb-quiet" }, `to ${istHm(end / 1000)}`));
  if (!xs.length) return h("section", { class: "mb-sec" }, head, h("p", { class: "mb-quiet" }, "Nothing to compare yet. The Bridge's recorder keeps the chain's minutes; until it has 15 of them, this fills in while the brief stays open."));
  return h("section", { class: "mb-sec" }, head, h("ul", { class: "mb-changes" }, xs.map((s) => h("li", { class: toneCls(s.tone) }, h("i", { "aria-hidden": "true" }), h("span", {}, s.text)))));
}

/** The brief as nodes, for the panel. */
function briefNodes(b) {
  return [trendCard(b), facts(b), ladder(b), changes(b)];
}

// ── The panel (Shift+Y) ──

let panel = null;

/** Open the brief (or bring it to the front). */
export function openBrief(u = briefUnderlying()) {
  if (panel?.dlg.open) return panel.setU(u);
  panel = buildPanel(u);
}

/** Close the brief if it is open. */
export function closeBrief() {
  panel?.close();
}

/** Shift+Y: open or close. */
export function toggleBrief() {
  if (panel?.dlg.open) closeBrief();
  else openBrief();
}

async function segmentedControl(u) {
  const { segmented } = await import("./views.js");
  return segmented("Underlying", BRIEF_UNDERLYINGS.map((x) => [x, x]), u);
}

function buildPanel(u0) {
  let u = u0;
  const phone = matchMedia("(max-width: 719px)").matches;
  const body = h("div", { class: "mb-body" }, loadingState({ rows: 6, cols: 2, label: "Reading the market" }));
  const sub = h("p", { class: "mb-sub" }, "");
  const dl = h("span", { class: "mb-dl" }, "");
  const segSlot = h("div", { class: "mb-seg" });
  const closeBtn = h("button", { type: "button", class: "icon-btn tiny", "aria-label": "Close the brief", onclick: () => close() }, icon("close"));
  const foot = h(
    "footer",
    { class: "mb-foot" },
    h("span", {}, "Facts from your Bridge's data, not advice."),
    h("a", { class: "lk small", href: "#/api/integrations?tool=claude", onclick: () => close() }, "Ask an AI assistant"),
  );
  const dlg = h(
    "dialog",
    { class: `mb-panel${phone ? " sheet" : ""}`, "aria-labelledby": "mb-title" },
    h("div", { class: "mb-grab", "aria-hidden": "true" }),
    h("header", { class: "mb-head" }, h("div", { class: "mb-titles" }, h("h2", { id: "mb-title" }, "Market brief"), sub), closeBtn),
    h("div", { class: "mb-dlrow" }, segSlot, dl),
    body,
    foot,
  );
  document.body.append(dlg);
  let seq = 0;
  let timer = 0;
  let sig = "";
  let closed = false;
  const paint = async (force = false) => {
    const my = ++seq;
    let b;
    try {
      b = await readBrief(u, { force });
    } catch {
      if (my === seq) body.replaceChildren(h("p", { class: "mb-quiet" }, "The brief could not be read. Check that the Bridge is running."));
      return;
    }
    if (my !== seq || closed) return;
    sub.textContent = `${b.u}${b.near ? ` · nearest expiry ${dayText(b.near.date)}` : ""}${b.spot !== null ? ` · spot ${formatGrouped(b.spot, 2)}` : ""}`;
    const d = dataLine({ phase: b.clock?.phase ?? "closed", asOfMs: b.asOfMs, nowMs: Date.now() });
    dl.className = `mb-dl ${d.state}`;
    dl.textContent = d.text;
    // Unchanged figures: nothing is rebuilt.
    const s = JSON.stringify([b.u, b.at]);
    if (s === sig) return;
    sig = s;
    const keepOpen = body.querySelector(".mb-rule")?.open;
    body.replaceChildren(...briefNodes(b));
    if (keepOpen) body.querySelector(".mb-rule").open = true;
  };
  const setU = (x) => {
    if (!BRIEF_UNDERLYINGS.includes(x) || x === u) return;
    u = x;
    local.set(U_KEY, u);
    if (seg && seg.value !== u) seg.value = u;
    body.replaceChildren(loadingState({ rows: 6, cols: 2, label: "Reading the market" }));
    paint().catch(() => {});
  };
  let seg = null;
  segmentedControl(u).then((s) => {
    seg = s;
    seg.addEventListener("change", () => setU(seg.value));
    segSlot.append(seg);
  });
  const onKey = (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      close();
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("hashchange", onHash);
    if (dlg.open) dlg.close();
    dlg.remove();
    if (panel?.dlg === dlg) panel = null;
    returnTo?.focus?.({ preventScroll: true });
  }
  // A link inside the brief (Chain, Ask an AI assistant) closes it; a route change from elsewhere keeps it open on wide
  // screens (it is a side panel) and closes the phone sheet.
  const onHash = () => phone && close();
  addEventListener("hashchange", onHash);
  const returnTo = document.activeElement;
  dlg.addEventListener("close", () => close());
  document.addEventListener("keydown", onKey, true);
  if (phone) dlg.showModal();
  else dlg.show();
  closeBtn.focus({ preventScroll: true });
  paint().catch(() => {});
  timer = setInterval(() => {
    if (!dlg.isConnected) return clearInterval(timer);
    if (document.visibilityState === "visible") paint().catch(() => {});
  }, 30_000);
  return { dlg, close, setU };
}

const typing = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
let keyed = false;
/** Install Shift+Y once (views.js calls this when the router starts). */
export function initBrief() {
  if (keyed || typeof document === "undefined") return;
  keyed = true;
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing || e.repeat || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== "KeyY" && e.key !== "Y") return;
    if (typing(e.target)) return;
    // Another modal (the palette, an order ticket, a confirm) keeps the keyboard.
    const other = [...document.querySelectorAll("dialog[open]")].some((d) => !d.classList.contains("mb-panel"));
    if (other) return;
    e.preventDefault();
    toggleBrief();
  });
}

// ── Home: one strip ──

/**
 * Home's brief strip: the trend, breadth, PCR, RSI and VWAP in one line, opening the full brief. It follows the
 * underlying Home's Key levels card shows (that card has the levels; this strip does not repeat them).
 * @returns {{ el: HTMLElement, refresh: () => Promise<void> }}
 */
export function briefStrip() {
  const trend = h("span", { class: "mb-chip mb-chip-trend" }, h("i", { "aria-hidden": "true" }), h("strong", {}, "Reading the trend"));
  const chips = h("span", { class: "mb-chips" });
  const open = h("button", { type: "button", class: "small mb-open", "aria-keyshortcuts": "Shift+Y", onclick: () => openBrief(homeU()) }, "Market brief", h("kbd", { "aria-hidden": "true" }, "⇧Y"));
  const el = h("section", { class: "mb-strip", "aria-label": "Market brief" }, trend, chips, open);
  const homeU = () => {
    const x = local.get(HOME_KEY);
    return BRIEF_UNDERLYINGS.includes(x) ? x : "NIFTY";
  };
  let last = "";
  const chip = (k, v, tone = "", tip = "") => h("span", { class: "mb-chip", title: tip || undefined }, h("small", {}, k), h("b", { class: toneCls(tone) }, v));
  const fill = async () => {
    const u = homeU();
    const b = await readBrief(u).catch(() => null);
    if (!b || !el.isConnected) return;
    const s = JSON.stringify([u, b.at]);
    if (s === last) return;
    last = s;
    const w = b.words;
    trend.className = `mb-chip mb-chip-trend ${w.tone}`;
    trend.replaceChildren(h("i", { "aria-hidden": "true" }), h("small", {}, u), h("strong", {}, w.title));
    trend.title = w.detail;
    const v = b.vwap;
    chips.replaceChildren(
      chip("Breadth", b.breadth ? `${formatInt(b.breadth.up)} up · ${formatInt(b.breadth.down)} down` : DASH, b.breadth?.tone, b.breadthScope),
      chip("PCR", num(b.lv?.pcr) === null ? DASH : formatFixed(b.lv.pcr, 2), "", "Put ÷ Call OI, nearest expiry"),
      chip("RSI", b.rsi ? formatFixed(b.rsi.value, 0) : DASH, "", "RSI 14 on 5-minute candles"),
      chip("MACD", b.macd ? (b.macd.above ? "Above avg" : "Below avg") : DASH, b.macd ? (b.macd.above ? "up" : "down") : "", "MACD line against its 9-period EMA, 5-minute"),
      chip("VWAP", v ? (v.side === "above" ? "Above" : v.side === "below" ? "Below" : "At") : DASH, v?.side === "above" ? "up" : v?.side === "below" ? "down" : "", "Near future against its VWAP today"),
    );
  };
  fill().catch(() => {});
  return { el, refresh: fill };
}
