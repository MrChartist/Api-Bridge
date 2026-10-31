// vol-today.js: Volatility › Overview › "IV today", the four answers about the expiry in view, then the ATM IV
// through the session.
//   1. The ATM IV now, its change since the open and the day's range (IV at the forward, from the recorder's minutes).
//   2. The priced move to expiry in points (spot × IV × √time) and per session (÷ √sessions left).
//   3. That priced day against an actual day (HV20 in points): bigger, like or smaller than recent days.
//   4. The IV against its own year: High, Normal or Low by IV percentile (the Bridge's daily vol store, via vol.js).
// Data: GET /v1/options/snapshots (read at most once a minute, and only for the chain in view); maths in
// vol-suite-core.js. The panel patches its text in place; the chart is the shared chart-lite slot.
import { api, chartSlot, h } from "./app.js";
import { DASH, formatDayMonth, formatFixed, formatInt, formatPercent, formatSigned, isFigure } from "./format.js";
import { ivTodayModel, ivTodaySpec, snapshotPoints } from "./vol-suite-core.js";

const IST_MS = 330 * 60_000;
const REFRESH_MS = 60_000;
const clock = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const toneOf = (v) => (isFigure(v) && Number(v) > 0 ? "vs-pos" : isFigure(v) && Number(v) < 0 ? "vs-neg" : "");
const PRICED_WORDS = { bigger: "Priced for bigger days than recent ones", like: "Priced for days like recent ones", smaller: "Priced for smaller days than recent ones" };
const IV_WORDS = { high: "High IV", normal: "Normal IV", low: "Low IV" };

/**
 * The panel. `underlying()`, `expiry()`, `hv20()` and `rank()` read vol.js's state when asked; `sync()` is cheap to call
 * on every draw (it reads at most once a minute, or at once for a new chain).
 */
export function createVolToday({ underlying, expiry, hv20, rank }) {
  const sub = h("span", { class: "vol-sub" }, "ATM IV at the forward, from the recorder's minutes");
  const cell = (k) => {
    const v = h("span", { class: "vt-value" }, DASH);
    const s = h("span", { class: "vt-sub" }, "");
    const word = h("span", { class: "vs-verdict small", hidden: true });
    return { k, v, s, word, el: h("div", { class: "vt-answer" }, h("span", { class: "vt-k" }, k), word, v, s) };
  };
  const a = { iv: cell("ATM IV"), move: cell("Priced move"), day: cell("Against recent days"), year: cell("Against its year") };
  const slot = chartSlot("ATM IV through today", { id: "vol-today" });
  const el = h(
    "section",
    { class: "desk-panel vol-today", "data-panel": "vol-today", "aria-label": "IV today" },
    h("div", { class: "panel-head" }, h("div", { class: "vol-title" }, h("strong", {}, "IV today"), sub)),
    h("div", { class: "vt-answers" }, Object.values(a).map((c) => c.el)),
    slot,
  );
  let key = "";
  let at = 0;
  let busy = false;
  let points = [];
  let sig = "";

  const put = (c, value, subText, { tone = "", word = null, wordTone = "", title = "" } = {}) => {
    c.v.textContent = value;
    c.v.className = `vt-value ${tone}`.trim();
    if (typeof subText === "string") c.s.textContent = subText;
    else c.s.replaceChildren(...subText);
    c.word.hidden = !word;
    c.word.textContent = word ?? "";
    c.word.className = `vs-verdict small ${wordTone}`.trim();
    c.el.title = title;
  };

  function paint() {
    const e = expiry();
    const m = ivTodayModel(points, { expiry: e, nowMs: Date.now(), hv20: hv20(), rank: rank() });
    if (!m) {
      for (const c of Object.values(a)) put(c, DASH, "");
      a.iv.s.textContent = "Nothing recorded for this expiry today";
      return;
    }
    sub.textContent = `${formatDayMonth(e)} expiry · as of ${clock(m.t)} IST${m.gaps ? ` · ${formatInt(m.gaps)} minutes gave no reading` : ""}`;
    put(a.iv, isFigure(m.atmIv) ? formatPercent(m.atmIv, 2) : DASH, [
      h("span", { class: toneOf(m.sinceOpen !== null ? Math.round(m.sinceOpen * 100) : null) }, isFigure(m.sinceOpen) ? `${formatSigned(m.sinceOpen, 2)} pts` : DASH),
      " since the open",
      m.range ? ` · range ${formatFixed(m.range.lo, 2)} – ${formatFixed(m.range.hi, 2)}%` : "",
    ], { title: "IV at the forward, linear between the two strikes either side of it (each the mean of its Call and Put IV). The change is the latest reading minus the session's first, in IV points." });
    put(a.move, isFigure(m.move) ? `±${formatInt(m.move)}` : DASH, isFigure(m.move) ? `${formatPercent(m.movePct, 2)} to ${formatDayMonth(e)}${isFigure(m.day) ? ` · ±${formatInt(m.day)} ${m.lastSession ? "left today" : "a session"}` : ""}` : "", { title: "One standard deviation to expiry: spot × ATM IV × √(time left). Per session: ÷ √(sessions left), weekdays only (exchange holidays are not removed). A model range, not a forecast." });
    const va = m.vsActual;
    put(a.day, va ? `${formatFixed(va.ratio, 2)}×` : DASH, va ? `±${formatInt(va.priced)} priced vs ±${formatInt(va.actual)} actual (HV20 ${formatPercent(hv20(), 1)})` : isFigure(hv20()) ? "Needs the ATM IV and time left" : "No daily closes to compare with", { word: va ? PRICED_WORDS[va.word] : null, wordTone: va?.word === "bigger" ? "iv" : "", title: "The priced day (the move per session) against an actual day (HV20 of daily closes, in points at today's spot). A side is named only from 1.2× (or under 1 ÷ 1.2), since a 20-session HV is itself uncertain by about 16%." });
    put(a.year, isFigure(m.ivp) ? formatInt(m.ivp) : DASH, isFigure(m.ivp) ? `IV percentile${isFigure(m.ivr) ? ` · rank ${formatInt(m.ivr)}` : ""}${isFigure(m.rankDays) ? ` · ${formatInt(m.rankDays)} days` : ""}` : "Needs a stored year of 30-day IV", { word: m.verdict ? IV_WORDS[m.verdict] : null, wordTone: m.verdict === "high" ? "iv" : m.verdict === "low" ? "quiet" : "", title: "High at an IV percentile of 80 or more, Low at 20 or less, tested on the whole number shown. The percentile uses every day of the lookback; the rank rests on its highest and lowest days." });
  }

  async function load(u, e) {
    busy = true;
    try {
      const r = await api(`/v1/options/snapshots?${new URLSearchParams({ underlying: u, expiry: e, fields: "ltp,iv", strikes: "6", limit: "500" })}`);
      if (`${u}|${e}` !== key) return;
      points = snapshotPoints(r.data?.data?.snapshots ?? []);
      slot?.chart.set(ivTodaySpec(points, { underlying: u, expiry: e }));
    } catch {
      if (`${u}|${e}` !== key) return;
      points = [];
      slot?.chart.set({ empty: { title: "Not recorded", text: `The Bridge has no minutes recorded for ${u} ${e} today.` } });
    } finally {
      busy = false;
      at = Date.now();
    }
    paint();
  }

  return {
    el,
    /** Read the chain in view when it changed or the last read is a minute old; repaint the answers otherwise. */
    sync() {
      const u = underlying();
      const e = expiry();
      if (!u || !e) return;
      const k = `${u}|${e}`;
      if (k !== key) {
        key = k;
        points = [];
        load(u, e);
        return;
      }
      if (!busy && Date.now() - at > REFRESH_MS) return load(u, e);
      // HV20 or the rank arrived since the last paint: repaint the answers (cheap, and only then).
      const now = `${hv20()}|${JSON.stringify(rank() ?? null)}`;
      if (now !== sig && !busy) {
        sig = now;
        paint();
      }
    },
    /** Repaint the answers (HV20 or the rank arrived). */
    paint,
  };
}
