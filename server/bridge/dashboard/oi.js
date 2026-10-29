// OI Analysis (#/oi): where option writers and buyers are positioned, read for every trader on the desk
// (docs/design/oi.md, round 2). A verdict with a tone pill and six tiles with micro-visuals; a legend, the OI profile
// chart (grouped call / put bars per strike) and the mirrored OI ladder (calls blue on the left, puts orange on the
// right, OI added green and OI cut red-hatched); walls with share bars, build-up as a direction meter and heat cells,
// the biggest additions and unwinds, the max pain curve; several expiries side by side, and a labelled slot for the
// owner's chart engine with its series (and a table of the recorded snapshots).
//
// Colour: side = hue (calls --dv-call, puts --dv-put), change = green / red (--pos / --neg), spot and ATM = the
// contrast colour, the expected move = violet. Never colour alone: calls left / first, cuts hatched, signs, letters
// and ▲ ▼ ↔ glyphs. One selected strike is shared by the chart, ladder, walls, movers and tiles.
//
// Windows: Prev close uses the broker's oiChange; 5m / 15m / 30m / 1h / Since open use the snapshots this page
// records (oi-store.js). Everything is built once and patched on each 3 s refresh (bars resize with a transform on
// --v, never regrow). The maths is in options.js (pure, tested); numbers become text through format.js only.
import { api, chartSlot, emptyState, errorState, h, icon, loadingState, modal, optional, sheetPopover, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";
import { countUp, flashValue, lineReveal, reducedMotion, stopCount } from "./motion.js";
import * as O from "./options.js";
import { oiStore, snapKey } from "./oi-store.js";
import { segmented } from "./views.js";
import { legend, scrubber, setBar, spotPill, svgEl } from "./viz.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const WINDOW_IDS = O.OI_WINDOWS.map((w) => w[0]);
const WINDOW_NAME = Object.fromEntries(O.OI_WINDOWS);
const METRICS = [["oi", "OI"], ["chg", "OI chg"], ["vol", "Volume"]];
const METRIC_SHORT = { oi: "OI", chg: "Δ", vol: "Vol" };
const BANDS = [["10", "±10"], ["20", "±20"], ["30", "±30"], ["all", "All"]];
const EXTRA_MAX = 3;
/** Extra expiries reload every 10th refresh tick (30 s at the desk's 3 s). */
const EXTRA_EVERY = 10;
const MQ_PHONE = "(max-width: 719px)";
const MQ_COARSE = "(pointer: coarse)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false });
const isPhone = () => media(MQ_PHONE).matches;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryText = (e) => (ISO_DAY.test(e ?? "") ? EXPIRY_DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
const SIDE = { ce: "CE", pe: "PE" };
const SIDE_DV = { ce: "call", pe: "put" };
const DISCLAIMER = "Shows position activity, not guaranteed direction.";
const CLASSES = ["LB", "SB", "SC", "LU", "CH"];
/** The PCR gauge's zones (oi.md §7.3), on PCR_BANDS: [from, to, diverging step]. */
const GAUGE_ZONES = [[0.4, 0.6, "n2"], [0.6, 0.8, "n1"], [0.8, 1.2, "0"], [1.2, 1.5, "p1"], [1.5, 2.5, "p2"]];
const TONE = {
  up: ["▲", "Bullish tilt"],
  down: ["▼", "Bearish tilt"],
  range: ["↔", "Range"],
  mixed: ["·", "Mixed"],
};

export const OI_DEFAULTS = Object.freeze({
  window: "prev",
  metric: "oi",
  band: "10",
  unit: "lots",
  scope: "one",
  chart: true,
  extra: Object.freeze({}),
  th: Object.freeze({ minLots: 10, minOiPct: 1, minPxPct: 0.5 }),
});

/**
 * The OI page's saved settings (mcb.dashboard.desk → oi), validated: unknown values fall back to the defaults, extra
 * expiries are real dates (at most 3 per underlying), and those no longer listed for `underlying` are dropped.
 */
export function oiConfig(saved, { underlying = null, expiries = null } = {}) {
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const pick = (v, list, d) => (list.includes(String(v)) ? String(v) : d);
  const extra = {};
  if (s.extra && typeof s.extra === "object" && !Array.isArray(s.extra)) {
    for (const [u, list] of Object.entries(s.extra)) {
      if (!/^[A-Z0-9&]{1,30}$/.test(u) || !Array.isArray(list)) continue;
      let l = [...new Set(list.filter((e) => typeof e === "string" && ISO_DAY.test(e)))];
      if (u === underlying && Array.isArray(expiries)) l = l.filter((e) => expiries.includes(e));
      if (l.length) extra[u] = l.slice(0, EXTRA_MAX);
    }
  }
  const t = s.th && typeof s.th === "object" ? s.th : {};
  const clamp = (v, hi, d) => (isFigure(v) && Number(v) >= 0 && Number(v) <= hi ? Number(v) : d);
  return {
    window: pick(s.window, WINDOW_IDS, OI_DEFAULTS.window),
    metric: pick(s.metric, METRICS.map((m) => m[0]), OI_DEFAULTS.metric),
    band: pick(s.band, BANDS.map((b) => b[0]), OI_DEFAULTS.band),
    unit: pick(s.unit, ["lots", "qty"], OI_DEFAULTS.unit),
    scope: pick(s.scope, ["one", "all"], OI_DEFAULTS.scope),
    chart: typeof s.chart === "boolean" ? s.chart : OI_DEFAULTS.chart,
    extra,
    th: { minLots: clamp(t.minLots, 100000, 10), minOiPct: clamp(t.minOiPct, 100, 1), minPxPct: clamp(t.minPxPct, 100, 0.5) },
  };
}

/** A small control group: a select that looks like the desk's. */
function select(label, options, value, cls) {
  return h("select", { "aria-label": label, class: cls }, options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
}
const signedPct = (v, dp = 1) => (v === null || v === undefined ? DASH : `${formatSigned(v, dp)}%`);
/** "1 snapshot", "2 snapshots". */
const plural = (n, word) => `${formatInt(n)} ${word}${n === 1 ? "" : "s"}`;
const tagOf = (side, rank) => `${side === "ce" ? "R" : "S"}${rank}`;
/** The ink class of a signed figure: pos / neg / zero. */
const signCls = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v > 0 ? "ink-pos" : v < 0 ? "ink-neg" : "ink-zero");
/** A PCR in its band's ink (writer view: put-heavy = supportive = pos). */
const pcrCls = (p) => {
  const b = O.pcrBand(p);
  if (!b) return "";
  return b.min >= 1.2 ? "ink-pos" : b.min <= 0.6 ? "ink-neg" : "";
};
const effectGlyph = (eff) => (eff === "pos" ? "▲" : eff === "neg" ? "▼" : "");
/** "capping ▼" in the underlying-effect ink. */
const effectWord = (side, cls) => {
  if (!cls) return null;
  const word = O.BUILDUP_READ[side][cls][1];
  const eff = O.buildupEffect(word);
  return h("span", { class: `oi-eff ink-${eff === "neutral" ? "zero" : eff}` }, `${word}${eff === "neutral" ? "" : ` ${effectGlyph(eff)}`}`);
};
/** A build-up tag (LB / SB / SC / LU / CH), coloured by the premium direction (foundation §4.6). */
const buTag = (cls, title = "") => (cls ? h("span", { class: `obu obu-${cls}`, title }, cls) : null);
/** A wall tag (R1 / S2) in its side tint. */
const wallChip = (tag) => (tag ? h("span", { class: `oi-rk ${tag[0] === "R" ? "ce" : "pe"}` }, tag) : null);
const sideChip = (side) => h("span", { class: `oi-sc ${side}` }, SIDE[side]);

/** Slide a marker to p (0..1; null hides it) and size a bar to v (0..1): custom properties only. */
const setP = (el, p) => {
  const v = p === null || p === undefined || !Number.isFinite(p) ? null : String(Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000);
  if (v === null) {
    if (!el.hidden) el.hidden = true;
    return;
  }
  if (el.hidden) el.hidden = false;
  if (el.style.getPropertyValue("--p") !== v) el.style.setProperty("--p", v);
};
const setV = (el, v) => {
  const s = String(Math.round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 1000) / 1000);
  if (el.style.getPropertyValue("--v") !== s) el.style.setProperty("--v", s);
};

/** Lots held, without trailing zeros (2, 1.5). */
function formatNumberLots(v) {
  return Number.isInteger(v) ? formatInt(v) : formatFixed(v, 2).replace(/0$/, "");
}

/**
 * The OI page. desk.js owns the toolbar, data and timer; this owns the panels.
 * @param {{ st: object, save: () => void, retry: () => void, openInChain: (strike: number, side: string) => void,
 *   demo: () => boolean }} o
 */
export function createOiPage({ st, save, retry, openInChain, demo }) {
  const store = oiStore();
  const isDemo = () => Boolean(demo?.());
  const cfg = () => st.oi;
  const extras = new Map(); // expiry -> { chain, error, loading }
  let ticks = 0;
  let lastX = null;
  let model = null;
  let seriesCache = { sig: "", data: [] };
  let toastSig = "";
  let liveText = "";
  let liveAt = 0;
  let liveCtx = "";
  let moverTab = "adds";
  let loadingKey = null;
  let selK = null;
  let wallPrev = { ctx: "", r1: null, s1: null };
  let firstTiles = true;

  // ── Summary: verdict + tiles ──
  const tonePill = h("span", { class: "oi-tone-pill", hidden: true });
  const verdictText = h("span", { class: "oi-verdict-text" }, "Reading the chain…");
  const verdictEl = h("p", { class: "oi-verdict" }, tonePill, verdictText, h("span", { class: "oi-quiet" }, " Context, not advice."));
  const liveEl = h("p", { class: "sr-only", "aria-live": "polite" });

  /** A tile: label, value (+ trend), a 12 px micro-visual and a sub-line. Built once; setTile patches it. */
  function makeTile(key, label, mv, { jump = false } = {}) {
    const value = h("span", { class: "value" });
    const vt = h("span", { class: "vt" }, DASH);
    const trend = h("span", { class: "vtr" });
    value.append(vt, trend);
    const sub = h("span", { class: "sub" }, " ");
    const el = h(jump ? "button" : "div", { class: `desk-stat oi-t t-${key}${jump ? " jump" : ""}`, type: jump ? "button" : undefined, role: jump ? undefined : "group", "aria-label": label }, h("span", { class: "label" }, label), value, mv.el, sub);
    return { el, value, vt, trend, sub, mv, sig: "", n: null };
  }
  /** Markers that slide (translateX of a full-width layer by --p of its width; clipped by the visual). */
  const marker = (cls) => h("span", { class: `oi-mk ${cls}`, "aria-hidden": "true" });
  function gaugeMv() {
    const zones = h("span", { class: "oi-zones" });
    for (const [a, b, z] of GAUGE_ZONES) {
      const seg = h("i", { "data-z": z });
      seg.style.flexGrow = String(Math.round((O.pcrGaugePos(b) - O.pcrGaugePos(a)) * 1000));
      zones.append(seg);
    }
    const ref = marker("ref");
    const now = marker("now");
    ref.hidden = true;
    now.hidden = true;
    return { el: h("span", { class: "oi-mv oi-gauge", "aria-hidden": "true" }, zones, ref, now), ref, now };
  }
  function splitMv(diverging) {
    if (diverging) {
      const l = h("span", { class: "b", "data-dv": "call" });
      const r = h("span", { class: "b", "data-dv": "put" });
      return { el: h("span", { class: "oi-mv oi-split div", "aria-hidden": "true" }, h("span", { class: "half l" }, l), h("span", { class: "half r" }, r), h("span", { class: "c" })), l, r };
    }
    const l = h("span", { class: "b l", "data-dv": "call" });
    const r = h("span", { class: "b r", "data-dv": "put" });
    return { el: h("span", { class: "oi-mv oi-split vol", "aria-hidden": "true" }, l, r), l, r };
  }
  function distMv() {
    const dia = marker("dia");
    dia.hidden = true;
    return { el: h("span", { class: "oi-mv oi-dist", "aria-hidden": "true" }, h("span", { class: "trk" }), h("span", { class: "c" }), dia), dia };
  }
  function shareMv(side) {
    const bar = h("span", { class: "b", "data-dv": SIDE_DV[side] });
    const tick = marker("fresh");
    tick.hidden = true;
    return { el: h("span", { class: "oi-mv oi-share", "aria-hidden": "true" }, h("span", { class: "trk" }, bar), tick), bar, tick };
  }
  const tiles = new Map([
    ["pcr", makeTile("pcr", "PCR OI", gaugeMv())],
    ["chg", makeTile("chg", "PCR OI chg", splitMv(true))],
    ["vol", makeTile("vol", "PCR Vol", splitMv(false))],
    ["mp", makeTile("mp", "Max Pain", distMv(), { jump: true })],
    ["res", makeTile("res", "Call wall", shareMv("ce"), { jump: true })],
    ["sup", makeTile("sup", "Put wall", shareMv("pe"), { jump: true })],
  ]);
  const tilesEl = h("div", { class: "desk-stats oi-tiles" }, [...tiles.values()].map((t) => t.el));
  tiles.get("mp").el.addEventListener("click", () => model?.mp && selectStrike(model.mp.strike, "tile"));
  tiles.get("res").el.addEventListener("click", () => model?.R1 && selectStrike(model.R1.strike, "tile"));
  tiles.get("sup").el.addEventListener("click", () => model?.S1 && selectStrike(model.S1.strike, "tile"));
  /**
   * Patch one tile. `sub` is text or a list of [class, text] parts; `n` (a number) gives the flash direction when the
   * value text changes; `vcls` colours the value by meaning.
   */
  function setTile(key, { value = DASH, trend = "", tcls = "", vcls = "", sub = "", title = "", warn = false, n = null, label = null, count = false }) {
    const t = tiles.get(key);
    const sig = JSON.stringify([value, trend, tcls, vcls, sub, title, warn, label]);
    if (t.sig === sig) return;
    const prevText = t.vt.textContent;
    const prevN = t.n;
    t.sig = sig;
    t.n = n;
    if (label) t.el.setAttribute("aria-label", label);
    if (prevText !== value) {
      if (count && firstTiles && n !== null && value !== DASH && !reducedMotion()) countUp(t.vt, 0, n, (v) => formatFixed(v, 2), value);
      else {
        stopCount(t.vt);
        t.vt.textContent = value;
      }
      if (!firstTiles && prevN !== null && n !== null && prevN !== n && prevText !== DASH) flashValue(t.value, n > prevN ? "up" : "down");
    }
    const vc = `value ${vcls}`.trim();
    if (t.value.className !== vc) t.value.className = vc;
    if (t.trend.textContent !== trend) t.trend.textContent = trend;
    const tc = `vtr ${tcls}`.trim();
    if (t.trend.className !== tc) t.trend.className = tc;
    if (Array.isArray(sub)) t.sub.replaceChildren(...sub.filter(Boolean).map((p) => (Array.isArray(p) ? (p[0] ? h("span", { class: p[0] }, p[1]) : p[1]) : p)));
    else t.sub.textContent = sub || " ";
    t.el.title = title;
    t.el.classList.toggle("warn", warn);
  }
  const summaryEl = h("section", { class: "desk-panel oi-summary", "data-panel": "oi-summary", "data-fixed": "", "aria-label": "OI summary" }, verdictEl, liveEl, tilesEl);

  // ── Controls ──
  const winChips = h("div", { class: "segmented oi-win", role: "group", "aria-label": "Window" });
  const winBtns = new Map(
    O.OI_WINDOWS.map(([id, name]) => {
      // Tablets show "Open" for "Since open", so all six windows fit without a scroll mask.
      const short = id === "open" ? "Open" : name;
      const b = h("button", { type: "button", "data-value": id, "aria-pressed": "false", "aria-label": name }, h("span", { class: "wl" }, name), h("span", { class: "ws", "aria-hidden": "true" }, short));
      b.addEventListener("click", () => pickWindow(id, true));
      winChips.append(b);
      return [id, b];
    }),
  );
  const winSel = select("Window", O.OI_WINDOWS, cfg().window, "oi-win-sel");
  winSel.addEventListener("change", () => pickWindow(winSel.value, true));
  const metricSeg = segmented("Metric", METRICS, cfg().metric);
  metricSeg.classList.add("oi-metric");
  // Phones show the short labels (OI | Δ | Vol); the full name stays for screen readers.
  for (const b of metricSeg.querySelectorAll("button")) {
    const full = b.textContent;
    b.replaceChildren(h("span", { class: "ml" }, full), h("span", { class: "ms", "aria-hidden": "true" }, METRIC_SHORT[b.dataset.value]));
    b.setAttribute("aria-label", full);
  }
  metricSeg.addEventListener("change", () => setCfg({ metric: metricSeg.value }));
  const bandSel = select("Strikes each side of ATM", BANDS, cfg().band, "oi-band");
  bandSel.addEventListener("change", () => setCfg({ band: bandSel.value }));
  const unitSeg = segmented("Unit", [["lots", "Lots"], ["qty", "Qty"]], cfg().unit);
  unitSeg.classList.add("oi-unit");
  unitSeg.addEventListener("change", () => setCfg({ unit: unitSeg.value }));
  const scopeSeg = segmented("Scope", [["one", "This expiry"], ["all", "Combined"]], cfg().scope);
  scopeSeg.classList.add("oi-scope");
  scopeSeg.addEventListener("change", () => {
    if (scopeSeg.value !== cfg().scope) setCfg({ scope: scopeSeg.value }, true);
  });
  const helpBtn = h("button", { type: "button", class: "small oi-help-btn", "aria-label": "How to read this page", title: "How to read this page (?)", onclick: () => openHelp() }, "?");
  const gearBtn = h("button", { type: "button", class: "small oi-gear-btn", "aria-label": "OI settings: band, unit, scope, chart", title: "Band, unit, scope and chart", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => openSettings() }, icon("sliders"));
  const coverEl = h("span", { class: "oi-cover" });
  const controls = h("div", { class: "oi-controls" }, h("div", { class: "oi-ctl-row" }, winChips, winSel, metricSeg, bandSel, unitSeg, scopeSeg, helpBtn, gearBtn));

  function setCfg(patch, recentre = false) {
    Object.assign(st.oi, patch);
    save();
    if (recentre) ladder.reset();
    if (lastX) draw(lastX);
  }
  function pickWindow(id, user) {
    const av = model?.avail?.get(id);
    if (av && !av.ok) {
      if (user) {
        // Refused, not done: a neutral toast and a short nudge on the segment that is not ready yet.
        toast(av.reason, { tone: "info" });
        const b = winBtns.get(id);
        if (b && !reducedMotion()) {
          b.classList.remove("oi-nudge");
          requestAnimationFrame(() => {
            b.classList.add("oi-nudge");
            setTimeout(() => b.classList.remove("oi-nudge"), 420);
          });
        }
      }
      syncWindowControls();
      return;
    }
    setCfg({ window: id });
  }
  /** ⚙ (phones): band, unit, scope, chart, expiries, how to read. Built fresh on each open. */
  function openSettings() {
    const seg = (label, opts, value, onPick, cls = "") => {
      const s = segmented(label, opts, value);
      if (cls) s.classList.add(cls);
      s.addEventListener("change", () => onPick(s.value));
      return h("div", { class: "seg-field" }, h("span", {}, label), s);
    };
    const combinedOk = extraList().some((e) => extras.get(e)?.chain);
    let pop = null;
    const body = h(
      "div",
      { class: "oi-sheet" },
      seg("Strikes each side of ATM", BANDS, cfg().band, (v) => setCfg({ band: v })),
      seg("Unit", [["lots", "Lots"], ["qty", "Qty"]], cfg().unit, (v) => setCfg({ unit: v })),
      combinedOk ? seg("Scope", [["one", "This expiry"], ["all", "Combined"]], cfg().scope, (v) => setCfg({ scope: v }, true)) : null,
      seg("OI profile chart", [["on", "Show"], ["off", "Hide"]], cfg().chart ? "on" : "off", (v) => setCfg({ chart: v === "on" })),
      h(
        "div",
        { class: "oi-sheet-links" },
        h("button", { type: "button", class: "small", onclick: () => (pop?.close(), setTimeout(() => expEl.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }), 60)) }, "Expiries…"),
        h("button", { type: "button", class: "small", onclick: () => (pop?.close(), setTimeout(() => openHelp(), 60)) }, "How to read"),
      ),
    );
    pop = sheetPopover({ trigger: gearBtn, title: "OI settings", body, cls: "oi-settings" });
  }

  // ── Legend ──
  const legendHost = h("div", { class: "oi-legend-row" });
  const infoBtn = h("button", { type: "button", class: "icon-btn oi-legend-info", "aria-label": "What the colours and marks mean", title: "Legend", "aria-haspopup": "dialog", "aria-expanded": "false" }, h("span", { "aria-hidden": "true" }, "ⓘ"));
  infoBtn.addEventListener("click", () => sheetPopover({ trigger: infoBtn, title: "Legend", body: h("div", { class: "oi-legend-pop" }, legendList(cfg().metric, true), legendNotes()), cls: "oi-legend-sheet" }));
  let legendSig = "";
  function legendList(metric, full) {
    const items = [
      { label: full ? "Calls (CE)" : "CE", token: "call" },
      { label: full ? "Puts (PE)" : "PE", token: "put" },
      metric !== "vol" ? { label: full ? "OI added" : "added", token: "pos", kind: "line" } : null,
      metric !== "vol" ? { label: full ? "OI cut" : "cut", token: "neg", kind: "hatch" } : null,
      metric === "oi" && full ? { label: "At window start", token: "spot", kind: "dash" } : null,
    ];
    const ul = legend(items, { label: "Legend" });
    if (!full) return ul;
    ul.append(
      h("li", {}, h("span", { class: "dv-key oi-key-spot", "aria-hidden": "true" }), h("span", {}, "Spot")),
      h("li", {}, h("span", { class: "oi-key-mp", "aria-hidden": "true" }, "◆"), h("span", {}, "Max pain")),
      h("li", {}, h("span", { class: "dv-key oi-key-band", "aria-hidden": "true" }), h("span", {}, "±1σ move")),
      h("li", {}, h("span", { class: "oi-rk ce" }, "R1"), h("span", { class: "oi-rk pe" }, "S1"), h("span", {}, "Walls")),
    );
    return ul;
  }
  function legendNotes() {
    return h(
      "div",
      { class: "oi-legend-notes" },
      h("p", {}, "Bars: calls grow left of the strike, puts right, on one shared scale. The thin bar under each OI bar is the change since the window start: green added, red cut. A hatched ghost is OI cut since then."),
      h("p", {}, "Build-up tags follow the option premium: LB and SC (premium up) are green, SB and LU (premium down) red. What that means for the underlying differs by side: SB on calls is capping ▼, SB on puts supportive ▲."),
    );
  }
  function drawLegend() {
    const metric = cfg().metric;
    const sig = `${metric}`;
    if (legendSig === sig) return;
    legendSig = sig;
    legendHost.replaceChildren(h("div", { class: "oi-legend-full" }, legendList(metric, true)), h("div", { class: "oi-legend-compact" }, legendList(metric, false)), profile.head, infoBtn);
  }

  // ── Profile chart + ladder ──
  const profile = createProfile({
    onPick: (k) => selectStrike(k, "chart"),
    onToggle: () => setCfg({ chart: !cfg().chart }),
    onJump: () => ladder.focusTable(),
  });
  const ladder = createLadder({
    detailFor: (strike) => detailFor(strike),
    onOpenChain: (strike, side) => openInChain(strike, side),
    onSelect: (k) => selectStrike(k, "ladder"),
  });
  const keysEl = h(
    "div",
    { class: "desk-keys oi-keys" },
    [
      [["J", "K"], "strike"],
      [["↵"], "details"],
      [["G"], "ATM"],
      [["1", "6"], "window"],
      [["M"], "metric"],
      [["[", "]"], "band"],
      [["C"], "chart"],
      [["?"], "help"],
    ].map(([keys, t]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k, i) => [i ? (keys[0] === "1" ? "–" : "") : "", h("kbd", {}, k)])), t)),
  );

  // ── Side blocks ──
  const wallsEl = h("div", { class: "oi-block oi-walls" });
  const buildEl = h("div", { class: "oi-block oi-build" });
  const moversEl = h("div", { class: "oi-block oi-movers" });
  const pain = createPainCurve();
  const painEl = h("div", { class: "oi-block oi-painb" }, pain.el);
  const sideEl = h("div", { class: "oi-side" }, wallsEl, buildEl, moversEl, painEl);
  const ladderCol = h("div", { class: "oi-ladder-col" }, ladder.el, keysEl);
  const errBar = h("p", { class: "err-bar oi-err-bar", hidden: true, role: "status" });
  const mainEl = h(
    "section",
    { class: "desk-panel oi-main", "data-panel": "oi-main", "aria-label": "OI by strike" },
    h("div", { class: "panel-head oi-head" }, h("div", { class: "oi-title" }, h("strong", {}, "OI by strike"), coverEl), controls),
    errBar,
    legendHost,
    profile.el,
    h("div", { class: "oi-body" }, ladderCol, sideEl),
  );

  // ── Expiries ──
  const expBody = h("div", { class: "oi-exp-body" });
  const expEl = h(
    "section",
    { class: "desk-panel oi-expiries", "data-panel": "oi-expiries", "aria-label": "Expiries" },
    h("div", { class: "panel-head oi-head" }, h("div", { class: "oi-title" }, h("strong", {}, "Expiries"), h("span", { class: "oi-cover" }, `Include up to ${EXTRA_MAX} more · OI in lots`))),
    expBody,
    h("p", { class: "oi-note" }, "Monthly expiries carry positional and hedge OI; rollovers distort OI chg in the final days."),
  );

  // ── Timeline (the owner's chart engine plugs in here) ──
  const slot = chartSlot("Call OI, Put OI, PCR, Max Pain and spot vs time");
  slot.classList.add("oi-tslot");
  const slotLabel = slot.querySelector(".chart-slot-label");
  const coverageEl = h("p", { class: "oi-note" });
  const migrateEl = h("p", { class: "oi-note oi-migrate" });
  const snapBody = h("div", { class: "oi-snaps-body" });
  const snapsEl = h("details", { class: "oi-snaps" }, h("summary", {}, "Show as table"), snapBody);
  const timelineEl = h(
    "section",
    { class: "desk-panel oi-timeline", "data-panel": "oi-timeline", "aria-label": "OI over time" },
    h("div", { class: "panel-head oi-head" }, h("div", { class: "oi-title" }, h("strong", {}, "OI over time"), h("span", { class: "oi-cover" }, "From the snapshots this page records"))),
    slot,
    coverageEl,
    migrateEl,
    snapsEl,
  );

  // ── Linking: one selected strike for the chart, ladder, walls, movers and tiles ──
  function selectStrike(k, from) {
    if (k === null || k === undefined) return;
    // Walls, max pain and movers read every strike loaded: one outside the band widens it to the smallest that shows it.
    if (model) {
      const i = model.rows.findIndex((r) => r.strike === k);
      const N = cfg().band === "all" ? Infinity : Number(cfg().band);
      if (i >= 0 && model.ai >= 0 && Math.abs(i - model.ai) > N) {
        const d = Math.abs(i - model.ai);
        const band = BANDS.find(([v]) => v === "all" || Number(v) >= d)[0];
        toast(`${formatInt(k)} is outside ±${N}: band widened to ${band === "all" ? "All" : `±${band}`}`, { tone: "info" });
        setCfg({ band });
      }
    }
    selK = k;
    if (from !== "ladder") ladder.select(k, true, false);
    if (from !== "chart") profile.pin(k);
    paintLinked();
  }
  function clearSel() {
    if (selK === null) return false;
    selK = null;
    ladder.unselect();
    profile.clear();
    paintLinked();
    return true;
  }
  function paintLinked() {
    for (const el of mainEl.querySelectorAll(".oi-side [data-k]")) {
      const on = selK !== null && Number(el.dataset.k) === selK;
      if (el.classList.contains("sel") !== on) el.classList.toggle("sel", on);
    }
    for (const [key, t] of tiles) {
      const k = key === "mp" ? model?.mp?.strike : key === "res" ? model?.R1?.strike : key === "sup" ? model?.S1?.strike : null;
      const on = selK !== null && k === selK;
      if (t.el.classList.contains("sel") !== on) t.el.classList.toggle("sel", on);
    }
  }

  /**
   * Replace a block's content, keeping keyboard focus on the same control (matched by data-fk), so a refresh that
   * changes a figure never drops focus to <body> mid-Tab or mid-Enter.
   */
  function rebuild(host, nodes) {
    const a = document.activeElement;
    const fk = a && a !== document.body && host.contains(a) ? a.getAttribute("data-fk") : null;
    host.replaceChildren(...nodes);
    if (fk === null) return;
    const next = [...host.querySelectorAll("[data-fk]")].find((n) => n.getAttribute("data-fk") === fk && n.getClientRects().length);
    next?.focus({ preventScroll: true });
  }
  const sign = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.sign(v));
  const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

  // ── Extra expiries ──
  const extraList = () => (cfg().extra[st.underlying] ?? []).filter((e) => e !== st.expiry && st.expiries.includes(e)).slice(0, EXTRA_MAX);
  async function loadExtra(expiry) {
    const u = st.underlying;
    const e = extras.get(expiry) ?? { chain: null, error: null, loading: false };
    if (e.loading) return;
    e.loading = true;
    extras.set(expiry, e);
    const r = await optional(api(`/v1/optionchain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(expiry)}&strikes=40&greeks=false`));
    e.loading = false;
    if (u !== st.underlying) return;
    if (r.error) e.error = r.error;
    else {
      e.chain = r.data.data;
      e.error = null;
      store.offer(e.chain, Date.now(), { demo: isDemo() }).catch(() => {});
    }
    if (lastX) draw(lastX);
  }
  function toggleExtra(expiry, on) {
    const all = { ...cfg().extra };
    const list = new Set(all[st.underlying] ?? []);
    if (on) {
      if (extraList().length >= EXTRA_MAX) return toast(`Up to ${EXTRA_MAX} more expiries`, { tone: "info" });
      list.add(expiry);
    } else list.delete(expiry);
    all[st.underlying] = [...list].filter((e) => st.expiries.includes(e)).slice(0, EXTRA_MAX);
    if (!all[st.underlying].length) delete all[st.underlying];
    st.oi.extra = all;
    if (on) loadExtra(expiry);
    else extras.delete(expiry);
    if (!extraList().length && cfg().scope === "all") st.oi.scope = "one";
    save();
    if (lastX) draw(lastX);
  }

  // ── The draw ──
  function windowState(chain, snaps, now, session) {
    const hasPrev = chain.rows.some((r) => num(r.ce?.oiChange) !== null || num(r.pe?.oiChange) !== null);
    const combined = cfg().scope === "all" && extraList().length > 0;
    const avail = new Map();
    for (const id of WINDOW_IDS) {
      let a = O.pickRef(snaps, now, id, { hasPrev });
      if (combined && id !== "prev") a = { ...a, ok: false, reason: "Combined OI uses the previous close: snapshots are kept per expiry" };
      else if (!a.ok && id !== "prev" && session.phase !== "open" && !isDemo() && !snaps.length) a = { ...a, reason: "Market closed: no snapshots were recorded today" };
      avail.set(id, a);
    }
    let win = cfg().window;
    if (!avail.get(win)?.ok) {
      const fb = avail.get("prev").ok ? "prev" : avail.get("open").ok ? "open" : WINDOW_IDS.find((w) => avail.get(w).ok) ?? null;
      const sig = `${st.underlying}|${st.expiry}|${win}`;
      // Say so once when a window the user chose is not available here (not while the page is still warming up). The
      // default (Prev close) falling back to Since open is how a source without oiChange works: no toast for that.
      if (fb && fb !== win && win !== OI_DEFAULTS.window && toastSig !== sig && snaps.length) {
        toastSig = sig;
        toast(`${WINDOW_NAME[win]} is not available here: showing ${WINDOW_NAME[fb]}`, { tone: "info" });
      }
      win = fb ?? (hasPrev ? "prev" : "open");
    }
    return { avail, win, hasPrev, combined, ref: avail.get(win) };
  }

  function draw(x) {
    lastX = x;
    syncControls();
    drawLegend();
    if (!x) return drawEmpty();
    const c = x.c;
    const now = Date.now();
    const session = O.marketSession(now);
    const noOi = !c.rows.some((r) => num(r.ce?.oi) !== null || num(r.pe?.oi) !== null);
    const key = snapKey(c.underlying, c.expiry, now);
    if (!noOi) store.offer(c, now, { demo: isDemo() }).catch(() => {});
    let snaps = store.peek(key);
    if (!snaps) {
      snaps = [];
      if (loadingKey !== key) {
        loadingKey = key;
        store.list(key).then(() => key === loadingKey && lastX && draw(lastX));
      }
    }
    if (noOi) return drawNoOi(c);
    // Data kept while refreshes fail: a slim bar on top, the figures stay (dimmed by the desk).
    const errTxt = st.error ? `Couldn't refresh: ${st.error.message ?? "the broker did not answer"}. Showing the last good data.` : "";
    if (errBar.textContent !== errTxt) errBar.textContent = errTxt;
    if (errBar.hidden === !errTxt) errBar.hidden = !errTxt;

    const w = windowState(c, snaps, now, session);
    const combined = w.combined;
    const lot = combined ? 1 : x.lot;
    const div = combined || cfg().unit === "lots" ? lot : 1;
    const unit = combined || cfg().unit === "lots" ? "lots" : "qty";
    const fq = (v) => formatCompact(v === null || v === undefined ? null : v / div);
    // A change under 10 lots keeps one decimal, so a sub-lot move never prints a bare "0" beside a large %.
    const fd = (v) => {
      if (v === null || v === undefined || !isFigure(v)) return DASH;
      const q = v / div;
      if (unit !== "lots" || q === 0 || Math.abs(q) >= 10 || Number.isInteger(q)) return formatCompact(q, { signed: true });
      return Math.abs(q) < 0.05 ? `${q > 0 ? "+" : "−"}<0.1` : formatSigned(q, 1);
    };
    const chains = combined ? [c, ...extraList().map((e) => extras.get(e)?.chain).filter(Boolean)] : [c];
    const rows = combined ? O.cumulativeOi(chains, now).rows : O.oiWindowRows(c, w.ref?.ok ? w.ref.snap : null);
    const th = { lot, ...cfg().th };
    O.annotateBuildup(rows, th);
    // The toolbar shows the index quote's last price when there is one: use the same figure here (chart pill, ladder,
    // distances), so the page never shows two spots at once.
    const spot = num(x.indexQuote?.ltp) ?? x.spot;
    const atm = O.atmRow(c)?.strike ?? null;
    const ai = rows.findIndex((r) => r.strike === atm);
    const N = cfg().band === "all" ? Infinity : Number(cfg().band);
    const inBand = (i) => ai < 0 || N === Infinity || Math.abs(i - ai) <= N;
    const band = rows.filter((_, i) => inBand(i));
    const pcrChain = O.pcrSet(rows);
    const pcrB = O.pcrSet(band);
    const mp = O.maxPainCurve(rows, spot);
    const relevance = O.maxPainRelevance(c.expiry, now);
    const sessions = O.sessionsLeft(c.expiry, now);
    const walls = { ce: O.oiWalls(rows, "ce", spot, { band, move: x.move }), pe: O.oiWalls(rows, "pe", spot, { band, move: x.move }) };
    const wallMap = { ce: new Map(walls.ce.map((v) => [v.strike, tagOf("ce", v.rank)])), pe: new Map(walls.pe.map((v) => [v.strike, tagOf("pe", v.rank)])) };
    const R1 = walls.ce[0] ?? null;
    const S1 = walls.pe[0] ?? null;
    const bu = O.buildupSummary(band, { ...th, range: { lo: S1?.strike, hi: R1?.strike } });
    const movers = O.oiMovers(rows, { n: 5, walls: wallMap, ...th });
    // OI at the window's start, as rows: the walls then (wall shift) and the PCR then (trend arrow).
    const refRows = rows.map((r) => ({ strike: r.strike, ce: r.ce ? { oi: r.ce.oiRef } : null, pe: r.pe ? { oi: r.pe.oiRef } : null }));
    const hasRef = rows.some((r) => num(r.ce?.oiRef) !== null || num(r.pe?.oiRef) !== null);
    const refSpot = w.ref?.snap?.spot ?? spot;
    const R1ref = hasRef ? O.oiWalls(refRows, "ce", refSpot, { top: 1 })[0]?.strike ?? null : null;
    const S1ref = hasRef ? O.oiWalls(refRows, "pe", refSpot, { top: 1 })[0]?.strike ?? null : null;
    const pcrRef = hasRef ? O.pcrSet(refRows).oi : null;
    const pin = sessions !== null && sessions <= 2 ? O.pinZone(rows, spot) : null;
    mainEl.classList.remove("oi-msg");
    const expiryDay = O.isExpiryDay(c.expiry, now);
    const winLabel = w.ref?.ok ? WINDOW_NAME[w.win] : "Warming up";
    const refLabel = w.ref?.ok ? w.ref.label : "";
    const avail = w.avail;
    const em = x.em1 ?? {};
    // Wall migration (same underlying / expiry / window): pulse the new R1 / S1 once and say so at once.
    const ctx = `${c.underlying}|${c.expiry}|${combined ? "all" : "one"}`;
    const moved = { ce: false, pe: false };
    if (wallPrev.ctx === ctx) {
      if (R1 && wallPrev.r1 !== null && R1.strike !== wallPrev.r1) moved.ce = R1.strike > wallPrev.r1 ? "up" : "down";
      if (S1 && wallPrev.s1 !== null && S1.strike !== wallPrev.s1) moved.pe = S1.strike > wallPrev.s1 ? "up" : "down";
    }
    wallPrev = { ctx, r1: R1?.strike ?? null, s1: S1?.strike ?? null };
    model = { avail, win: w.win, combined, lot, div, unit, rows, ai, walls, wallMap, R1, S1, mp, x, fq, fd, th, refLabel, winLabel };

    // Verdict: the tone pill carries the direction (or the range); the text drops what the pill already says.
    const verdict = O.oiVerdict({ walls: { r1: R1?.strike, s1: S1?.strike }, pcr: pcrChain.oi, buildup: bu, maxPain: mp?.strike, relevance }) ?? "Not enough OI to read";
    const showPill = !bu.empty && !combined;
    const parts = verdict.split(" · ").filter((p) => !(showPill && (bu.tone === "range" ? p.startsWith("Range ") : p === bu.short)));
    const vText = parts.join(" · ") || verdict;
    if (verdictText.textContent !== vText) verdictText.textContent = vText;
    const pillTxt = showPill ? (bu.tone === "range" && S1 && R1 ? `${TONE.range[0]} Range ${formatInt(S1.strike)}–${formatInt(R1.strike)}` : `${TONE[bu.tone][0]} ${TONE[bu.tone][1]}`) : "";
    if (tonePill.textContent !== pillTxt) tonePill.textContent = pillTxt;
    if (tonePill.dataset.tone !== bu.tone) tonePill.dataset.tone = bu.tone;
    if (tonePill.hidden === showPill) tonePill.hidden = !showPill;
    const fullVerdict = `${pillTxt ? `${pillTxt} · ` : ""}${vText}`;
    if (verdictEl.title !== fullVerdict) verdictEl.title = fullVerdict;
    // The polite region speaks at most once a minute, but at once for a new underlying, expiry or scope, and for a
    // wall that moved.
    if (ctx !== liveCtx) {
      liveCtx = ctx;
      liveAt = 0;
    }
    const migr = [moved.ce ? `Call wall moved ${moved.ce} to ${formatInt(R1.strike)}` : null, moved.pe ? `Put wall moved ${moved.pe} to ${formatInt(S1.strike)}` : null].filter(Boolean).join(". ");
    if (migr) {
      liveEl.textContent = migr;
      liveAt = now;
    } else if (verdict !== liveText && now - liveAt >= 60_000) {
      liveText = verdict;
      liveAt = now;
      liveEl.textContent = verdict;
    }

    // Tiles.
    const scopeTxt = N === Infinity ? "All" : `±${N}`;
    const bandWord = O.pcrBand(pcrChain.oi);
    const up = pcrChain.oi !== null && pcrRef !== null && Math.abs(pcrChain.oi - pcrRef) >= 0.005 ? pcrChain.oi > pcrRef : null;
    setTile("pcr", {
      value: formatFixed(pcrChain.oi, 2),
      n: pcrChain.oi,
      count: true,
      vcls: pcrCls(pcrChain.oi),
      trend: up === null ? "" : up ? "▲" : "▼",
      tcls: up === null ? "" : up ? "ink-pos" : "ink-neg",
      sub: [["", `${scopeTxt} ${formatFixed(pcrB.oi, 2)}`], ["", bandWord ? ` · ${bandWord.word}` : ""]],
      title: `PCR ${formatFixed(pcrChain.oi, 2)}${bandWord ? ` (${bandWord.word})` : ""}: put OI ÷ call OI over the ${formatInt(rows.length)} strikes loaded. Writer view: higher = more put writing below spot (support), lower = call writing above (a cap). Context, not a signal.${up !== null ? ` Was ${formatFixed(pcrRef, 2)} at the window start (${refLabel}).` : ""}`,
    });
    const g = tiles.get("pcr").mv;
    setP(g.now, O.pcrGaugePos(pcrChain.oi));
    setP(g.ref, hasRef ? O.pcrGaugePos(pcrRef) : null);
    const chg = pcrB.chg;
    setTile("chg", {
      value: !chg ? DASH : chg.kind === "ratio" ? formatFixed(chg.ratio, 2) : chg.kind === "flat" ? "Flat" : chg.kind === "both-cut" ? "Both cut" : chg.kind === "put-add-call-cut" ? "PE+ CE−" : "CE+ PE−",
      n: chg?.kind === "ratio" ? chg.ratio : null,
      count: true,
      vcls: chg?.kind === "ratio" ? pcrCls(chg.ratio) : chg?.kind === "put-add-call-cut" ? "ink-pos" : chg?.kind === "call-add-put-cut" ? "ink-neg" : "",
      sub: !chg ? "No OI chg in this window" : [["", "PE "], [signCls(chg.p), fd(chg.p)], ["", " · CE "], [signCls(chg.c), fd(chg.c)]],
      title: `Put OI chg ÷ call OI chg over the window (${winLabel}) and the band (${scopeTxt})${chg ? `: PE ${fd(chg.p)} · CE ${fd(chg.c)} (${unit})${chg.text && chg.kind !== "ratio" ? `. ${chg.text}` : ""}` : ""}`,
    });
    const sm = tiles.get("chg").mv;
    const mAbs = chg ? Math.max(Math.abs(chg.c), Math.abs(chg.p)) : 0;
    setV(sm.l, mAbs ? Math.abs(chg.c) / mAbs : 0);
    setV(sm.r, mAbs ? Math.abs(chg.p) / mAbs : 0);
    sm.l.classList.toggle("dec", Boolean(chg && chg.c < 0));
    sm.r.classList.toggle("dec", Boolean(chg && chg.p < 0));
    setTile("vol", { value: formatFixed(pcrB.vol, 2), n: pcrB.vol, count: true, sub: `${winLabel} window${expiryDay ? " · expiry-day noise" : ""}`, title: `Put volume ÷ call volume in the window (${winLabel}). CE ${fq(pcrB.ceVol)} · PE ${fq(pcrB.peVol)} (${unit}). Noisy on expiry day.` });
    const vm = tiles.get("vol").mv;
    const vt = pcrB.ceVol + pcrB.peVol;
    setV(vm.l, vt > 0 ? pcrB.ceVol / vt : 0);
    setV(vm.r, vt > 0 ? pcrB.peVol / vt : 0);
    const mpDist = mp && spot !== null ? mp.strike - spot : null;
    setTile("mp", {
      value: formatInt(mp?.strike),
      n: mp?.strike ?? null,
      sub: mp ? `${formatSigned(mpDist, 0)} (${signedPct(mpDist === null ? null : (mpDist / spot) * 100, 2)}) · ${mp.edge ? "at range edge" : `${relevance} relevance`}` : "",
      warn: Boolean(mp?.edge),
      label: mp ? `Show max pain ${formatInt(mp.strike)} in the ladder` : "Max Pain",
      title: mp ? `Settlement where option buyers collect the least, over ${formatInt(mp.n)} strikes ${formatInt(mp.lo)}–${formatInt(mp.hi)}. Matters mainly in the last 1–2 sessions (${formatInt(sessions)} left). Not a forecast.${mp.edge ? " At range edge: chain may be partial." : ""}` : "Not enough OI for max pain",
    });
    // ±2 % of spot either side; the ◆ sits at (mp − spot) / spot.
    setP(tiles.get("mp").mv.dia, mpDist === null || !spot ? null : 0.5 + mpDist / spot / 0.04);
    const freshCls = (f) => (f === "fresh" ? "ink-pos" : f === "unwinding" ? "ink-neg" : "oi-q");
    const freshTxt = (f) => (f === "fresh" ? "▲ fresh" : f === "unwinding" ? "▼ unwinding" : f ?? "");
    const wallSub = (v) => (v ? [["", `${fq(v.oi)} · `], [signCls(v.d), fd(v.d)], v.fresh ? ["", " · "] : null, v.fresh ? [freshCls(v.fresh), freshTxt(v.fresh)] : null].filter(Boolean) : "");
    for (const [key, v, side] of [["res", R1, "ce"], ["sup", S1, "pe"]]) {
      setTile(key, {
        value: formatInt(v?.strike),
        n: v?.strike ?? null,
        vcls: v ? `ink-${SIDE_DV[side]}` : "",
        sub: wallSub(v),
        label: v ? `Show ${side === "ce" ? "call" : "put"} wall ${formatInt(v.strike)} in the ladder` : side === "ce" ? "Call wall" : "Put wall",
        title: v ? `${side === "ce" ? "Call strike at or above spot" : "Put strike at or below spot"} with the most OI: ${fq(v.oi)} ${unit}, ${v.share === null ? "" : `${formatFixed(v.share * 100, 0)}% of all ${side === "ce" ? "call" : "put"} OI, `}Δ ${fd(v.d)} ${winLabel}${v.strength !== null ? `, ${formatFixed(v.strength, 1)}× the band's average` : ""}.` : `No ${side === "ce" ? "call" : "put"} OI on this side of spot`,
      });
      const mv = tiles.get(key).mv;
      setV(mv.bar, v?.share ?? 0);
      setP(mv.tick, v && (v.fresh === "fresh" || v.fresh === "unwinding") ? v.share : null);
      if (v) mv.tick.dataset.f = v.fresh === "fresh" ? "pos" : "neg";
      const tEl = tiles.get(key).value;
      if (moved[side]) ring(tEl);
    }
    firstTiles = false;

    // Head: coverage, with the window it is measured against.
    const lo = rows[0]?.strike;
    const hi = rows[rows.length - 1]?.strike;
    const vs = w.ref?.ok ? (w.win === "prev" ? "vs Prev close" : `vs ${refLabel.replace(/^since /, "")} (${plural(snaps.length, "snap")})`) : snaps.length ? `Recording · ${plural(snaps.length, "snap")} since ${O.istHm(snaps[0].t)}` : "Recording starts now";
    const cover = `${formatInt(rows.length)} strikes · ${formatInt(lo)}–${formatInt(hi)} · ${unit}${combined ? ` · ${formatInt(chains.length)} expiries` : ""} · ${vs}`;
    if (coverEl.textContent !== cover) coverEl.textContent = cover;
    const coverTitle = `${cover} · ${coverage(snaps, session)}${store.persistent ? "" : " · Not saved: browser storage unavailable"}`;
    if (coverEl.title !== coverTitle) coverEl.title = coverTitle;
    syncWindowControls();

    // The chart and the ladder share one model of the band.
    const lm = ladderModel({ x, rows, inBand, atm, spot, mp, wallMap, combined, unit, fq, fd, winLabel, em });
    profile.draw(profileModel({ rows, inBand, ai, atm, spot, mp, wallMap, em, lm, fq, fd, div, combined, unit, winLabel, R1, S1, chartOn: cfg().chart }), moved);
    ladder.draw(lm, moved);

    drawWalls({ walls, rows, fq, fd, R1ref, S1ref, R1, S1, pin, unit, winLabel });
    drawBuildup(bu, { scopeTxt, winLabel, th, combined });
    drawMovers(movers, { fd, winLabel });
    pain.draw({ mp, spot, em, relevance, key: ctx });
    drawExpiries(c, now);
    drawTimeline(key, snaps, session);
    paintLinked();
  }

  /** A one-time ring pulse (a wall that moved); reduced motion: a static outline for 3 s. */
  function ring(el) {
    if (!el) return;
    el.classList.remove("oi-ring");
    // Restart the animation without a forced reflow: next frame.
    requestAnimationFrame(() => {
      el.classList.add("oi-ring");
      setTimeout(() => el.classList.remove("oi-ring"), reducedMotion() ? 3000 : 950);
    });
  }

  function coverage(snaps, session) {
    if (session.phase !== "open" && !isDemo()) return "Market closed · showing the last session";
    if (isDemo() && session.phase !== "open") return `Snapshots recorded off-hours${snaps.length ? ` · ${plural(snaps.length, "snapshot")} since ${O.istHm(snaps[0].t)}` : ""}`;
    return snaps.length ? `Recording since ${O.istHm(snaps[0].t)} · ${plural(snaps.length, "snapshot")} · every 1 min` : "Recording starts with the next update · every 1 min";
  }

  function ladderModel({ x, rows, inBand, atm, spot, mp, wallMap, combined, unit, fq, fd, winLabel, em }) {
    const metric = cfg().metric;
    const held = new Map();
    for (const r of x.c.rows) {
      for (const side of ["ce", "pe"]) {
        const l = r[side]?.symbol ? x.held.get(r[side].symbol) : null;
        if (l) held.set(`${r.strike}|${side}`, l);
      }
    }
    const hasEm = em.lo !== null && em.lo !== undefined && em.hi !== null && em.hi !== undefined;
    const spotIdx = spot === null ? -1 : rows.findIndex((r) => r.strike > spot);
    const val = (leg) => {
      if (!leg) return null;
      if (metric === "oi") return num(leg.oi);
      if (metric === "chg") return num(leg.d) === null ? null : Math.abs(leg.d);
      return num(leg.v);
    };
    let max = 0;
    rows.forEach((r, i) => {
      if (!inBand(i)) return;
      for (const s of ["ce", "pe"]) {
        max = Math.max(max, val(r[s]) ?? 0);
        if (metric === "oi") max = Math.max(max, num(r[s]?.oiRef) ?? 0);
      }
    });
    const metricName = metric === "oi" ? "OI" : metric === "chg" ? "OI chg" : "Vol";
    const out = rows.map((r, i) => {
      // Priority: walls, max pain, held, then the ±1σ edges (oi.md §6.5).
      const tags = [];
      for (const s of ["ce", "pe"]) {
        const wt = wallMap[s].get(r.strike);
        if (wt) tags.push({ t: wt, cls: `wall ${s}`, title: `${s === "ce" ? "Call" : "Put"} wall rank ${wt.slice(1)} (${s === "ce" ? "resistance" : "support"})` });
      }
      if (mp && r.strike === mp.strike) tags.push({ t: "◆ MP", cls: "mp", title: "Max Pain" });
      for (const s of ["ce", "pe"]) {
        const l = held.get(`${r.strike}|${s}`);
        // "+1 CE" / "−2 PE": lots held, with the side (never "L", which reads as lakh beside OI figures).
        if (l) tags.push({ t: `${l > 0 ? "+" : "−"}${formatNumberLots(Math.abs(l))} ${SIDE[s]}`, cls: `held ${s}`, title: `You hold ${l > 0 ? "+" : "−"}${formatNumberLots(Math.abs(l))} ${Math.abs(l) === 1 ? "lot" : "lots"} of ${formatInt(r.strike)} ${SIDE[s]}` });
      }
      if (hasEm && r.strike === em.hi) tags.push({ t: "+1σ", cls: "em", title: "Upper edge of the ±1σ expected move to expiry" });
      if (hasEm && r.strike === em.lo) tags.push({ t: "−1σ", cls: "em", title: "Lower edge of the ±1σ expected move to expiry" });
      const inEm = hasEm && r.strike >= em.lo && r.strike <= em.hi;
      const side = (s) => {
        const leg = r[s];
        if (!leg) return { val: null, ref: null, d: null, txt: DASH, dTxt: DASH, pTxt: "", bu: null, rank: 0, title: "" };
        const v = val(leg);
        // In "OI chg" the bar is the change, so its figure is the OI (the Δ column already prints the change).
        const shown = fq(metric === "vol" ? leg.v : leg.oi);
        const read = leg.cls ? O.BUILDUP_READ[s][leg.cls] : null;
        const wt = wallMap[s].get(r.strike);
        return {
          val: v,
          ref: metric === "oi" ? num(leg.oiRef) : null,
          d: metric === "vol" ? null : num(leg.d),
          txt: shown,
          dTxt: fd(leg.d),
          dNum: num(leg.d),
          pTxt: leg.dPct === null ? (leg.d > 0 && leg.oiRef === 0 ? "new" : "") : signedPct(leg.dPct),
          bu: leg.cls,
          buTitle: leg.cls ? `${O.BUILDUP_NAMES[leg.cls]} on ${s === "ce" ? "calls" : "puts"} = ${read[0]}: ${read[1]} for the underlying` : "",
          rank: wt ? Number(wt.slice(1)) : 0,
          title: `${formatInt(r.strike)} ${SIDE[s]} · OI ${fq(leg.oi)} (${unit}) · Δ ${fd(leg.d)} ${winLabel}${leg.v !== null ? ` · Vol ${fq(leg.v)}` : ""}`,
        };
      };
      return {
        strike: r.strike,
        inBand: inBand(i),
        atm: r.strike === atm,
        inEm,
        out: hasEm && !inEm,
        spotLine: i === spotIdx && i > 0 ? `Spot ${formatFixed(spot, 2)}` : null,
        tags,
        held: tags.some((t) => t.cls === "held"),
        ce: side("ce"),
        pe: side("pe"),
      };
    });
    const ctxKey = `${x.c.underlying}|${x.c.expiry}|${combined ? "all" : "one"}`;
    return {
      // The table's structure: the strikes are not in it (when ATM moves the ladder slides its rows, oi.md §8).
      key: `${ctxKey}|${metric}|${unit}`,
      ks: rows.map((r) => r.strike).join(","),
      ekey: `${ctxKey}|${metric}`,
      spotTxt: spot === null ? "" : formatFixed(spot, 2),
      caption: `Open interest by strike, ${winLabel}, ${unit}${spot === null ? "" : `. Spot ${formatFixed(spot, 2)}`}`,
      head: { ce: metric === "chg" ? "Calls OI chg" : `Calls ${metricName}`, pe: metric === "chg" ? "Puts OI chg" : `Puts ${metricName}`, unit, tail: metric === "chg" ? " · OI" : "" },
      rows: out,
      metric,
      max,
      atm,
    };
  }

  /** The profile chart's model: the band (phones ±10 around ATM, desktop up to ±20), from the ladder's rows. */
  function profileModel({ rows, ai, atm, spot, mp, wallMap, em, lm, fq, fd, div, combined, unit, winLabel, R1, S1, chartOn }) {
    const N = cfg().band === "all" ? Infinity : Number(cfg().band);
    const cap = isPhone() ? 10 : 20;
    const n = Math.min(N, cap);
    const idx = rows.map((_, i) => i).filter((i) => ai < 0 || Math.abs(i - ai) <= n);
    const metric = lm.metric;
    const pts = idx.map((i) => {
      const r = rows[i];
      const l = lm.rows[i];
      const leg = (s) => ({ oi: num(r[s]?.oi), ref: combined ? null : num(r[s]?.oiRef), d: num(r[s]?.d), v: num(r[s]?.v), cls: r[s]?.cls ?? null, dPct: num(r[s]?.dPct) });
      return { k: r.strike, ce: leg("ce"), pe: leg("pe"), held: l.held, tags: l.tags.filter((t) => t.cls.startsWith("wall") || t.cls === "mp").map((t) => t.t) };
    });
    const capped = N > cap;
    const caption = `${combined ? `Combined · ${formatInt(1 + extraList().filter((e) => extras.get(e)?.chain).length)} expiries · ` : ""}${capped ? `±${cap} shown · ` : ""}${metric === "oi" ? "OI" : metric === "chg" ? "OI chg" : "Volume"} in ${unit}${metric !== "vol" ? ` · Δ ${winLabel}` : ""}`;
    const top = (s) => {
      let best = null;
      for (const p of pts) if (p[s].oi !== null && (!best || p[s].oi > best[s].oi)) best = p;
      return best;
    };
    const tc = top("ce");
    const tp = top("pe");
    const aria = `OI by strike, ±${n} around ${formatInt(atm)}. Largest call OI ${formatInt(tc?.k)} (${fq(tc?.ce.oi)} ${unit}), largest put OI ${formatInt(tp?.k)} (${fq(tp?.pe.oi)} ${unit}).${spot !== null ? ` Spot ${formatFixed(spot, 2)}.` : ""}`;
    return {
      key: `${lm.key}|${n}`,
      ekey: lm.ekey,
      metric,
      pts,
      atm,
      spot,
      spotTxt: spot === null ? "" : formatFixed(spot, 2),
      mp: mp?.strike ?? null,
      em,
      wallMap,
      fq,
      fd,
      div,
      caption,
      aria,
      on: chartOn,
      summary: `OI profile · R1 ${formatInt(R1?.strike)} · S1 ${formatInt(S1?.strike)} · MP ${formatInt(mp?.strike)}`,
    };
  }

  /** The detail row's content for one strike: both sides, structured (the ladder builds the card). */
  function detailFor(strike) {
    const m = model;
    if (!m) return null;
    const r = m.rows.find((q) => q.strike === strike);
    if (!r) return null;
    const sides = ["ce", "pe"].map((s) => {
      const leg = r[s];
      if (!leg) return { side: s, listed: false };
      const sym = m.x.c.rows.find((q) => q.strike === strike)?.[s]?.symbol;
      const lots = sym ? m.x.held.get(sym) : null;
      return {
        side: s,
        listed: true,
        oiFrom: m.fq(leg.oiRef),
        oiTo: m.fq(leg.oi),
        d: num(leg.d),
        dTxt: m.fd(leg.d),
        pct: leg.dPct !== null ? signedPct(leg.dPct) : leg.d > 0 && leg.oiRef === 0 ? "new" : "",
        ltp: leg.ltp !== null ? formatFixed(leg.ltp, 2) : null,
        dLtp: num(leg.dLtp),
        dLtpTxt: leg.dLtp !== null ? formatSigned(leg.dLtp, 2) : "",
        vol: leg.v !== null ? m.fq(leg.v) : null,
        cls: leg.cls,
        wall: m.wallMap[s].get(strike) ?? null,
        held: lots ? `You ${lots > 0 ? "+" : "−"}${formatNumberLots(Math.abs(lots))} ${Math.abs(lots) === 1 ? "lot" : "lots"}` : null,
      };
    });
    return { sides, unit: m.unit, window: m.refLabel || WINDOW_NAME[m.win] };
  }

  // ── Walls ──
  function drawWalls({ walls, rows, fq, fd, R1ref, S1ref, R1, S1, pin, unit, winLabel }) {
    const fwC = O.freshWall(rows, "ce");
    const fwP = O.freshWall(rows, "pe");
    const shift = (now, ref) => (now && ref !== null && now.strike !== ref ? { up: now.strike > ref, from: formatInt(ref) } : null);
    const maxShare = r3(Math.max(0, ...walls.ce.map((v) => v.share ?? 0), ...walls.pe.map((v) => v.share ?? 0)));
    const sideRows = (list, s) =>
      list.map((v) => ({
        tag: tagOf(s, v.rank),
        k: v.strike,
        rank: v.rank,
        strike: formatInt(v.strike),
        oi: fq(v.oi),
        share: r3(v.share),
        shareTxt: v.share === null ? DASH : `${formatFixed(v.share * 100, 0)}%`,
        d: sign(v.d),
        dTxt: fd(v.d),
        dist: formatSigned(v.dist, 0),
        sigma: v.sigma !== null ? `${formatFixed(v.sigma, 1)}σ` : "",
        strong: v.strong,
        fresh: v.fresh,
        title: `${v.strong ? "Strong wall: " : ""}${v.strength === null ? "" : `${formatFixed(v.strength, 1)}× the band's average ${s === "ce" ? "call" : "put"} OI · `}${v.share === null ? "" : `${formatFixed(v.share * 100, 0)}% of all ${s === "ce" ? "call" : "put"} OI`}`,
      }));
    const data = {
      ce: sideRows(walls.ce, "ce"),
      pe: sideRows(walls.pe, "pe"),
      maxShare,
      shiftC: shift(R1, R1ref),
      shiftP: shift(S1, S1ref),
      fresh: [fwC ? { k: fwC.strike, s: "ce", d: fd(fwC.d) } : null, fwP ? { k: fwP.strike, s: "pe", d: fd(fwP.d) } : null].filter(Boolean),
      pin: pin ? `Pin zone ${formatInt(pin.lo)}–${formatInt(pin.hi)}: ${formatFixed(pin.share * 100, 0)}% of OI` : "",
      unit,
      winLabel,
    };
    const sig = JSON.stringify(data);
    if (wallsEl.__sig === sig) return;
    wallsEl.__sig = sig;
    const row = (r, s) => {
      const bar = h("span", { class: "dv-bar", "data-dv": SIDE_DV[s] });
      setBar(bar, r.share ?? 0, maxShare || 1);
      const b = h(
        "button",
        { type: "button", class: "oi-wrow", "data-k": String(r.k), "data-fk": `w|${s}|${r.k}`, "aria-label": `${r.tag} ${r.strike}: OI ${r.oi}, ${r.shareTxt} share, change ${r.dTxt}${r.fresh ? `, ${r.fresh}` : ""}. Show in the ladder`, title: r.title, onclick: () => selectStrike(r.k, "walls") },
        h("span", { class: "c-rk" }, wallChip(r.tag)),
        h("span", { class: "c-k" }, h("span", { class: `oi-wk${r.rank === 1 ? ` ink-${SIDE_DV[s]}` : ""}${r.strong ? " strong" : ""}` }, r.strike), r.fresh ? h("span", { class: `oi-fr ${r.fresh === "fresh" ? "ink-pos" : r.fresh === "unwinding" ? "ink-neg" : ""}` }, r.fresh === "fresh" ? "▲ fresh" : r.fresh === "unwinding" ? "▼ unwinding" : "steady") : null),
        h("span", { class: "c-bar" }, h("span", { class: "dv-track" }, bar), h("span", { class: "oi-woi" }, r.oi)),
        h("span", { class: `c-d ${signCls(r.d)}` }, r.dTxt),
        h("span", { class: "c-dist" }, r.dist, r.sigma ? h("span", { class: "oi-sig" }, " · ", h("span", { class: "ink-iv" }, r.sigma)) : null),
      );
      return b;
    };
    const group = (title, list, s, sh) =>
      h(
        "div",
        { class: `oi-wgroup ${s}`, role: "group", "aria-label": title },
        h("div", { class: "oi-wcap" }, h("span", { class: "dv-key", "data-dv": SIDE_DV[s], "aria-hidden": "true" }), h("span", {}, title), sh ? h("span", { class: "oi-shift", title: `Rank-1 wall at the window start (${winLabel}): ${sh.from}` }, h("span", { class: sh.up ? "ink-pos" : "ink-neg" }, sh.up ? "↑" : "↓"), ` from ${sh.from}`) : null),
        h("div", { class: "oi-whead", "aria-hidden": "true" }, h("span", {}), h("span", {}, "Strike"), h("span", {}, `Share · OI`), h("span", {}, "Δ"), h("span", {}, "Dist")),
        list.length ? list.map((r) => row(r, s)) : h("p", { class: "oi-none" }, "No OI on this side of spot"),
      );
    rebuild(wallsEl, [
      h("h3", { class: "oi-block-head" }, "Walls", h("small", {}, `OI in ${unit} · Δ vs ${winLabel}`)),
      group("Call walls (resistance)", data.ce, "ce", data.shiftC),
      group("Put walls (support)", data.pe, "pe", data.shiftP),
      ...[
        data.fresh.length ? h("p", { class: "oi-foot" }, "Most added: ", data.fresh.map((f, i) => [i ? " · " : "", h("span", { class: `ink-${SIDE_DV[f.s]} oi-fk` }, `${formatInt(f.k)} ${SIDE[f.s]}`), " ", h("span", { class: "ink-pos" }, f.d)])) : null,
        data.pin ? h("p", { class: "oi-foot oi-pin", title: "OI on the 3 strikes nearest spot ÷ all OI: the higher, the stronger the pull to pin near expiry" }, h("span", { class: "oi-warn-dot", "aria-hidden": "true" }), data.pin) : null,
      ].filter(Boolean),
    ]);
  }

  // ── Build-up: a direction meter and heat cells ──
  const meterFillL = h("span", { class: "f l" });
  const meterFillR = h("span", { class: "f r" });
  const meterMk = marker("now");
  const meterTone = h("span", { class: "oi-tone-pill" });
  const meterNote = h("span", { class: "oi-meter-note" });
  const meterEl = h(
    "div",
    { class: "oi-meter", role: "img" },
    h("span", { class: "end", "aria-hidden": "true" }, "Bearish ◀"),
    h("span", { class: "oi-meter-trk", "aria-hidden": "true" }, h("span", { class: "half l" }, meterFillL), h("span", { class: "half r" }, meterFillR), h("i", { class: "t t1" }), h("i", { class: "t t2" }), h("i", { class: "t t0" }), meterMk),
    h("span", { class: "end", "aria-hidden": "true" }, "▶ Bullish"),
    meterTone,
  );
  const buildBody = h("div", { class: "oi-build-body" });
  let buildMode = "";
  function drawBuildup(bu, { scopeTxt, winLabel, th, combined }) {
    const mode = combined ? "combined" : "one";
    if (buildMode !== mode) {
      buildMode = mode;
      buildEl.__sig = "";
    }
    if (combined) {
      if (buildEl.__sig === "combined") return;
      buildEl.__sig = "combined";
      // Combined OI has no price change, so no strike can be classed: say so and offer the per-expiry view.
      buildEl.replaceChildren(
        h("h3", { class: "oi-block-head" }, "Build-up", h("small", {}, "Combined")),
        h("p", { class: "oi-foot muted" }, "Combined OI carries no price change, so build-up is read per expiry."),
        h("button", { type: "button", class: "link-btn oi-filter", onclick: () => setCfg({ scope: "one" }, true) }, "Show this expiry"),
      );
      return;
    }
    if (!buildEl.contains(meterEl)) {
      buildEl.__sig = "";
      buildEl.replaceChildren(h("h3", { class: "oi-block-head" }, "Build-up", h("small", { class: "oi-bu-sub" })), meterEl, buildBody);
    }
    const subTxt = `${scopeTxt} · vs ${winLabel} · strikes · lots`;
    const subEl = buildEl.querySelector(".oi-bu-sub");
    if (subEl.textContent !== subTxt) subEl.textContent = subTxt;
    // Meter: patched in place, so the fill and marker slide.
    const sc = bu.score;
    setV(meterFillL, sc !== null && sc < 0 ? -sc : 0);
    setV(meterFillR, sc !== null && sc > 0 ? sc : 0);
    setP(meterMk, sc === null ? null : 0.5 + sc / 2);
    const tt = sc === null ? "" : `${TONE[bu.tone][0]} ${bu.tone === "range" ? "Writers both sides" : TONE[bu.tone][1]}`;
    if (meterTone.textContent !== tt) meterTone.textContent = tt;
    meterTone.dataset.tone = bu.tone;
    meterTone.hidden = sc === null;
    const nt = sc === null ? "No classified build-up" : "";
    if (meterNote.textContent !== nt) meterNote.textContent = nt;
    if (nt && !meterEl.contains(meterNote)) meterEl.append(meterNote);
    meterEl.setAttribute("aria-label", sc === null ? "Direction: no classified build-up" : `Direction score ${formatSigned(sc, 2)} from −1 (bearish) to +1 (bullish): ${bu.text}`);

    const heat = O.buildupHeat(bu);
    const data = { heat, dom: { ce: bu.ce.dom, pe: bu.pe.dom }, empty: bu.empty, th, text: bu.text };
    const sig = JSON.stringify(data);
    if (buildEl.__sig === sig) return;
    buildEl.__sig = sig;
    const NAMES = { LB: "Long build", SB: "Short build", SC: "Short cover", LU: "Long unwind", CH: "Churn" };
    const head = (k) =>
      h(
        "th",
        { scope: "col", title: k === "CH" ? "Churn: heavy volume, but OI or price barely moved. No direction." : `${O.BUILDUP_NAMES[k]}. On calls = ${O.BUILDUP_READ.ce[k].join(": ")}. On puts = ${O.BUILDUP_READ.pe[k].join(": ")}.` },
        h("span", {}, k),
        h("small", {}, NAMES[k]),
      );
    const cell = (s, k) => {
      const c = heat[s][k];
      const dom = bu[s].dom === k;
      const td = h("td", { class: `oi-heat${dom ? " dom" : ""}`, title: `${k === "CH" ? "Churn" : O.BUILDUP_NAMES[k]} on ${s === "ce" ? "calls" : "puts"}: ${formatInt(c.n)} strikes, ${formatCompact(c.lots)} lots → ${O.BUILDUP_READ[s][k][1]}` }, c.n ? [h("strong", {}, formatInt(c.n)), h("small", {}, formatCompact(c.lots))] : h("span", { class: "oi-q" }, "–"));
      if (c.step && c.effect !== "neutral") td.dataset.div = String(c.effect === "pos" ? c.step : -c.step);
      else if (c.step) td.dataset.ch = String(c.step);
      return td;
    };
    const row = (s, label) => h("tr", {}, h("th", { scope: "row" }, h("span", { class: `oi-sc ${s}` }, SIDE[s]), h("span", { class: "oi-rl" }, label)), CLASSES.map((k) => cell(s, k)));
    const word = (s) => (bu[s].dom ? [h("strong", {}, `${bu[s].dom}`), " dominant → ", effectWord(s, bu[s].dom)] : ["nothing dominant"]);
    const filterBtn = h("button", { type: "button", class: "link-btn oi-filter", title: "Edit the noise filter", onclick: () => openHelp(true) }, h("span", { "aria-hidden": "true" }, "⧩ "), `${formatInt(th.minLots)} lots · ${formatFixed(th.minOiPct, 1)}% OI · ${formatFixed(th.minPxPct, 1)}% price`);
    buildBody.replaceChildren(
      h("table", { class: "oi-matrix" }, h("caption", { class: "sr-only" }, "Build-up by side and class: strikes and lots; colour = effect on the underlying"), h("thead", {}, h("tr", {}, h("td", {}), CLASSES.map(head))), h("tbody", {}, row("ce", "Calls"), row("pe", "Puts"))),
      h("p", { class: "oi-foot oi-bu-line" }, "Calls: ", ...word("ce"), " · Puts: ", ...word("pe")),
      ...[bu.empty ? h("p", { class: "oi-foot muted" }, "No strike passed the noise filter in this window: try a longer window or a wider band.") : null].filter(Boolean),
      filterBtn,
    );
  }

  // ── Movers ──
  function drawMovers(movers, { fd, winLabel }) {
    const maxAbs = Math.max(0, ...movers.adds.map((m) => Math.abs(m.d)), ...movers.unwinds.map((m) => Math.abs(m.d)));
    // Only what is shown goes into the signature (formatted text, the bar's rounded share, signs), so a tick that moves
    // a raw figure without changing what reads on screen rebuilds nothing.
    const item = (m) => ({ k: m.strike, side: m.side, d: sign(m.d), f: r3(maxAbs ? Math.abs(m.d) / maxAbs : 0), dTxt: fd(m.d), pct: m.dPct === null ? "new" : signedPct(m.dPct, 0), dLtp: sign(m.dLtp), ltp: m.dLtp === null ? "" : formatSigned(m.dLtp, 1), cls: m.cls, wall: m.wall ?? "" });
    const data = { adds: movers.adds.map(item), unwinds: movers.unwinds.map(item), winLabel, tab: moverTab };
    const sig = JSON.stringify(data);
    if (moversEl.__sig === sig) return;
    moversEl.__sig = sig;
    const row = (it) => {
      const bar = h("span", { class: `dv-bar${it.d < 0 ? " dec" : ""}`, "data-dv": it.d < 0 ? "neg" : "pos" });
      setBar(bar, it.d < 0 ? -it.f : it.f, 1);
      return h(
        "li",
        {},
        h(
          "button",
          { type: "button", class: "oi-mrow", "data-k": String(it.k), "data-fk": `m|${it.side}|${it.k}`, "aria-label": `${formatInt(it.k)} ${SIDE[it.side]} ${it.dTxt} (${it.pct}). Show in the ladder`, onclick: () => selectStrike(it.k, "movers") },
          h("span", { class: "m-l" }, sideChip(it.side), h("span", { class: "m-k" }, formatInt(it.k)), it.wall ? h("span", { title: it.side === "ce" ? "A call wall: unwinding here is the breakout cue" : "A put wall: unwinding here is the breakdown cue" }, wallChip(it.wall)) : null),
          h("span", { class: "m-bar" }, h("span", { class: "dv-track" }, bar)),
          h("span", { class: `m-d ${signCls(it.d)}` }, it.dTxt, h("small", {}, ` (${it.pct})`)),
          h("span", { class: "m-sub" }, ...[it.ltp ? h("span", {}, "LTP ", h("span", { class: signCls(it.dLtp) }, it.ltp)) : null, buTag(it.cls), it.cls ? effectWord(it.side, it.cls) : null].filter(Boolean)),
        ),
      );
    };
    const list = (title, items, cls) =>
      h(
        "div",
        { class: `oi-mlist ${cls}${moverTab === cls ? " on" : ""}` },
        h("h4", { class: cls === "adds" ? "ink-pos" : "ink-neg" }, title),
        items.length ? h("ol", {}, items.map(row)) : h("p", { class: "oi-none" }, cls === "adds" ? "No additions in this window" : "No unwinding in this window"),
      );
    const seg = segmented("Movers", [["adds", "Adds ▲"], ["unwinds", "Unwinds ▼"]], moverTab);
    seg.classList.add("oi-mseg");
    seg.addEventListener("change", () => {
      moverTab = seg.value;
      moversEl.__sig = "";
      drawMovers(movers, { fd, winLabel });
      moversEl.querySelector(".oi-mseg button[aria-pressed=true]")?.focus();
    });
    for (const b of seg.querySelectorAll("button")) b.setAttribute("data-fk", `seg|${b.dataset.value}`);
    rebuild(moversEl, [h("h3", { class: "oi-block-head" }, "Movers", h("small", {}, `Top 5 · vs ${winLabel} · all strikes`)), seg, h("div", { class: "oi-mlists" }, list("Biggest additions ▲", data.adds, "adds"), list("Biggest unwinds ▼", data.unwinds, "unwinds"))]);
  }

  // ── Expiries ──
  function drawExpiries(c, now) {
    const included = new Set(extraList());
    const rowsFor = [c.expiry, ...st.expiries.filter((e) => e !== c.expiry)];
    const stats = new Map(O.cumulativeOi([c, ...[...included].map((e) => extras.get(e)?.chain).filter(Boolean)], now).perExpiry.map((p) => [p.expiry, p]));
    let maxTotal = 0;
    let maxSide = 0;
    for (const p of stats.values()) {
      maxTotal = Math.max(maxTotal, (p.ceOi ?? 0) + (p.peOi ?? 0));
      maxSide = Math.max(maxSide, p.ceOi ?? 0, p.peOi ?? 0);
    }
    // One compact scale for every CE / PE OI figure in the table (100K beside 93.5K, never 1.00L beside 93.5K).
    const scale = maxSide >= 1e8 ? [1e7, "Cr"] : maxSide >= 1e6 ? [1e5, "L"] : maxSide >= 1e3 ? [1e3, "K"] : [1, ""];
    const fOi = (v) => {
      if (v === null || v === undefined || !isFigure(v)) return DASH;
      const q = Number(v) / scale[0];
      return `${formatFixed(q, q >= 100 || scale[0] === 1 ? 0 : 1)}${scale[1]}`;
    };
    const data = rowsFor.map((e) => {
      const p = stats.get(e);
      const ex = extras.get(e);
      return {
        e,
        main: e === c.expiry,
        on: e === c.expiry || included.has(e),
        p: p ? { dte: p.dte, lot: formatInt(p.lot), ce: Math.round(p.ceOi ?? 0), pe: Math.round(p.peOi ?? 0), ceT: fOi(p.ceOi), peT: fOi(p.peOi), pcr: p.pcr, pcrT: formatFixed(p.pcr, 2), mp: `${formatInt(p.maxPain)}${p.edge ? " (edge)" : ""}`, s1: formatInt(p.s1), r1: formatInt(p.r1) } : null,
        err: Boolean(ex?.error),
        loading: Boolean(ex?.loading) && !ex?.chain,
        monthly: O.isMonthlyExpiry(e, st.expiries),
      };
    });
    const sig = JSON.stringify([data, Math.round(maxTotal)]);
    if (expBody.__sig === sig) return;
    expBody.__sig = sig;
    const check = (d, where) =>
      h("input", {
        type: "checkbox",
        class: "oi-inc",
        "data-fk": `e|${d.e}|${where}`,
        checked: d.on,
        disabled: d.main || (!d.on && included.size >= EXTRA_MAX),
        "aria-label": d.main ? `${expiryText(d.e)}: the toolbar expiry` : `Include ${expiryText(d.e)}`,
        title: d.main ? "The toolbar expiry is always included" : !d.on && included.size >= EXTRA_MAX ? `Up to ${EXTRA_MAX} more expiries` : "",
        onchange: (ev) => toggleExtra(d.e, ev.target.checked),
      });
    const status = (d) => {
      if (!d.on) return h("span", { class: "oi-q" }, "Tick to compare");
      if (d.err) return h("span", { class: "oi-err ink-neg" }, "Not loaded ", h("button", { type: "button", class: "icon-btn small-x", "aria-label": `Retry ${expiryText(d.e)}`, title: "Retry", onclick: () => loadExtra(d.e) }, icon("refresh")));
      return h("span", { class: "skel oi-esk", "aria-label": "Loading" });
    };
    const split = (p) => {
      const ce = h("i", { "data-dv": "call" });
      const pe = h("i", { "data-dv": "put" });
      ce.style.flexGrow = String(Math.round(p.ce));
      pe.style.flexGrow = String(Math.round(p.pe));
      const bar = h("span", { class: "oi-esplit", role: "img", "aria-label": `CE OI ${p.ceT}, PE OI ${p.peT}` }, ce, pe);
      bar.style.width = `${maxTotal > 0 ? Math.max(4, Math.round(((p.ce + p.pe) / maxTotal) * 1000) / 10) : 0}%`;
      return bar;
    };
    const name = (d) => h("span", { class: "oi-ename" }, h("strong", {}, expiryText(d.e)), d.monthly ? h("span", { class: "oi-m", title: "Monthly expiry" }, "M") : null);
    const thead = h("thead", {}, h("tr", {}, ["Include", "Expiry", "DTE", "Lot", "CE / PE OI", "PCR", "Max Pain", "Put wall", "Call wall"].map((t, i) => h("th", { scope: "col", class: i >= 2 && i !== 4 ? "num" : i === 4 ? "split" : undefined }, t))));
    const tbody = h(
      "tbody",
      {},
      data.map((d) =>
        h(
          "tr",
          { class: d.on ? "on" : "off" },
          h("td", { class: "inc" }, check(d, "t")),
          h("td", {}, name(d)),
          ...(d.p
            ? [
                h("td", { class: "num" }, d.p.dte),
                h("td", { class: "num" }, d.p.lot),
                h("td", { class: "split" }, h("span", { class: "oi-esw" }, split(d.p)), h("span", { class: "oi-efig" }, h("span", { class: "ink-call" }, d.p.ceT), " / ", h("span", { class: "ink-put" }, d.p.peT))),
                h("td", { class: `num ${pcrCls(d.p.pcr)}` }, d.p.pcrT),
                h("td", { class: "num" }, d.p.mp),
                h("td", { class: "num ink-put" }, d.p.s1),
                h("td", { class: "num ink-call" }, d.p.r1),
              ]
            : [h("td", { colspan: "7", class: "oi-erest" }, status(d))]),
        ),
      ),
    );
    const t = h("div", { class: "table-wrap oi-exp-table" }, h("table", { class: "oi-etable" }, h("caption", { class: "sr-only" }, `${st.underlying} expiries side by side`), thead, tbody));
    // Phone / tablet: one compact card per expiry (an included expiry shows its figures; the others one line).
    const cards = h(
      "ul",
      { class: "oi-exp-cards" },
      data.map((d) =>
        h(
          "li",
          { class: d.on ? "on" : undefined },
          h("label", { class: "oi-exp-card-head" }, check(d, "c"), name(d), d.p ? h("span", { class: "oi-q" }, d.p.dte) : h("span", { class: "oi-q" }, status(d))),
          d.p ? h("div", { class: "oi-ecard-bar" }, split(d.p)) : null,
          d.p
            ? h(
                "dl",
                {},
                [
                  ["CE OI", d.p.ceT, "ink-call"],
                  ["PE OI", d.p.peT, "ink-put"],
                  ["PCR", d.p.pcrT, pcrCls(d.p.pcr)],
                  ["Max Pain", d.p.mp, ""],
                  ["Put wall", d.p.s1, "ink-put"],
                  ["Call wall", d.p.r1, "ink-call"],
                  ["Lot", d.p.lot, ""],
                ].map(([l, v, cl]) => h("div", {}, h("dt", {}, l), h("dd", { class: cl || undefined }, v))),
              )
            : null,
        ),
      ),
    );
    rebuild(expBody, [t, cards]);
    const n = 1 + extraList().filter((e) => extras.get(e)?.chain).length;
    const allBtn = scopeSeg.querySelector('[data-value="all"]');
    if (allBtn) allBtn.textContent = `Combined (${formatInt(n)})`;
  }

  // ── Timeline ──
  function drawTimeline(key, snaps, session) {
    const sig = `${key}|${snaps.length}|${snaps[snaps.length - 1]?.t ?? 0}`;
    if (seriesCache.sig !== sig) seriesCache = { sig, data: O.oiSeries(snaps) };
    const series = seriesCache.data;
    const n = series.length;
    const label = `Call OI, Put OI, PCR, Max Pain and spot vs time · ${plural(n, "point")} ready`;
    if (slotLabel.textContent !== label) {
      slotLabel.textContent = label;
      slot.setAttribute("aria-label", `Chart engine slot: ${label}`);
    }
    slot.classList.toggle("short", n < 10);
    const cov = `${coverage(snaps, session)}${store.persistent ? "" : " · Not saved: browser storage unavailable"}`;
    if (coverageEl.textContent !== cov) coverageEl.textContent = cov;
    const mig = O.wallMigrationText(series) ?? "Wall migration appears once snapshots are recorded";
    if (migrateEl.__sig !== mig) {
      migrateEl.__sig = mig;
      // The strikes in side ink: "Call wall: 26400 (09:31) → 26500 …".
      const parts = mig.split(" · ").map((p) => {
        const ink = p.startsWith("Call wall") ? "ink-call" : p.startsWith("Put wall") ? "ink-put" : "";
        if (!ink) return p;
        const [name, rest] = [p.slice(0, p.indexOf(":") + 1), p.slice(p.indexOf(":") + 1)];
        // Strikes only: a run of 3+ digits not touching a ":" (so the "26" of "13:26" stays plain).
        return [name, ...rest.split(/((?<![\d:])\d[\d,]{2,}(?![\d:]))/).map((s, i) => (i % 2 ? h("span", { class: ink }, s) : s))];
      });
      migrateEl.replaceChildren(...parts.flatMap((p, i) => (i ? [" · ", p] : [p])).flat());
    }
    // The last 10 snapshots, newest first (useful before the chart engine arrives).
    const last = series.slice(-10).reverse();
    const tsig = JSON.stringify(last);
    if (snapBody.__sig !== tsig) {
      snapBody.__sig = tsig;
      const sum = snapsEl.querySelector("summary");
      sum.textContent = `Show as table · ${plural(Math.min(10, n), "snapshot")}`;
      const glyph = (cur, below) => (cur === null || below === null || below === undefined || cur === below ? "" : cur > below ? " ↑" : " ↓");
      snapBody.replaceChildren(
        last.length
          ? h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                { class: "oi-snap-table" },
                h("caption", { class: "sr-only" }, "Recorded snapshots, newest first (OI in lots)"),
                h("thead", {}, h("tr", {}, ["Time", "Spot", "CE OI", "PE OI", "PCR", "MP", "R1", "S1"].map((t, i) => h("th", { scope: "col", class: i ? "num" : undefined }, t)))),
                h(
                  "tbody",
                  {},
                  last.map((p, i) => {
                    const below = last[i + 1];
                    return h(
                      "tr",
                      {},
                      h("td", {}, O.istHm(p.t)),
                      h("td", { class: "num" }, formatFixed(p.spot, 2)),
                      h("td", { class: "num ink-call" }, formatCompact(p.ceOi)),
                      h("td", { class: "num ink-put" }, formatCompact(p.peOi)),
                      h("td", { class: `num ${pcrCls(p.pcr)}` }, formatFixed(p.pcr, 2)),
                      h("td", { class: "num" }, formatInt(p.maxPain)),
                      h("td", { class: "num ink-call" }, `${formatInt(p.r1)}${glyph(p.r1, below?.r1)}`),
                      h("td", { class: "num ink-put" }, `${formatInt(p.s1)}${glyph(p.s1, below?.s1)}`),
                    );
                  }),
                ),
              ),
            )
          : h("p", { class: "oi-none" }, "No snapshots yet: one is recorded every minute while this page is open."),
      );
    }
  }

  // ── States ──
  function blankTiles() {
    for (const [k, t] of tiles) {
      setTile(k, {});
      t.el.classList.add("skel-t");
    }
  }
  function drawEmpty() {
    model = null;
    mainEl.classList.add("oi-msg");
    blankTiles();
    tonePill.hidden = true;
    const msg = st.error ? "Not updating" : st.empty ? "No expiries" : "Reading the chain…";
    if (verdictText.textContent !== msg) verdictText.textContent = msg;
    coverEl.textContent = "";
    errBar.hidden = true;
    profile.message(st.error || st.empty ? null : "loading");
    if (st.error) {
      ladder.message(errorState(st.error, { onRetry: () => retry() }));
    } else if (st.empty) ladder.message(emptyState("clock", "No expiries", st.empty, null, { compact: true }));
    else ladder.message(loadingState({ rows: 12, cols: 5, label: `Loading the ${st.underlying} ${expiryText(st.expiry)} chain` }));
    for (const el of [wallsEl, buildEl, moversEl, expBody]) {
      el.__sig = "";
      el.replaceChildren();
    }
    buildMode = "";
    pain.clear();
  }
  function drawNoOi(c) {
    model = null;
    mainEl.classList.add("oi-msg");
    blankTiles();
    tonePill.hidden = true;
    verdictText.textContent = "No open interest to read";
    profile.message(null);
    ladder.message(emptyState("chart", "No open interest yet", `The broker returned no OI for ${c.underlying} ${expiryText(c.expiry)}. It usually appears after the first trades of the day.`, null, { compact: true }));
    for (const el of [wallsEl, buildEl, moversEl]) {
      el.__sig = "";
      el.replaceChildren();
    }
    buildMode = "";
    pain.clear();
  }

  // ── Controls state ──
  function syncControls() {
    for (const [, t] of tiles) t.el.classList.remove("skel-t");
    const combinedOk = extraList().length > 0;
    const scopeOn = combinedOk && extraList().some((e) => extras.get(e)?.chain);
    if (scopeSeg.hidden === scopeOn) scopeSeg.hidden = !scopeOn;
    if (!combinedOk && cfg().scope === "all") st.oi.scope = "one";
    if (scopeSeg.value !== cfg().scope) scopeSeg.value = cfg().scope;
    const combined = cfg().scope === "all" && combinedOk;
    const unitBtns = unitSeg.querySelectorAll("button");
    for (const b of unitBtns) {
      b.disabled = combined;
      b.title = combined ? "Combined OI is in lots: lot sizes differ by expiry" : "";
    }
    unitSeg.classList.toggle("off", combined);
    if (unitSeg.value !== cfg().unit) unitSeg.value = cfg().unit;
    if (metricSeg.value !== cfg().metric) metricSeg.value = cfg().metric;
    if (bandSel.value !== cfg().band) bandSel.value = cfg().band;
  }
  function syncWindowControls() {
    const win = model?.win ?? cfg().window;
    for (const [id, b] of winBtns) {
      const a = model?.avail?.get(id);
      const off = Boolean(a && !a.ok);
      if (b.getAttribute("aria-pressed") !== String(id === win)) b.setAttribute("aria-pressed", String(id === win));
      if (b.tabIndex !== (id === win ? 0 : -1)) b.tabIndex = id === win ? 0 : -1;
      if (off !== b.hasAttribute("aria-disabled")) {
        if (off) b.setAttribute("aria-disabled", "true");
        else b.removeAttribute("aria-disabled");
      }
      const title = off ? a.reason : a?.label ? `${WINDOW_NAME[id]}: ${a.label}` : WINDOW_NAME[id];
      if (b.title !== title) b.title = title;
    }
    for (const o of winSel.options) {
      const a = model?.avail?.get(o.value);
      if (o.disabled !== Boolean(a && !a.ok)) o.disabled = Boolean(a && !a.ok);
      const ot = a && !a.ok ? a.reason : "";
      if (o.title !== ot) o.title = ot;
    }
    if (winSel.value !== win) winSel.value = win;
  }
  winChips.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const id = cycleWindow(step);
    if (id) winBtns.get(id)?.focus();
  });
  /** The next available window in a direction (W / ⇧W). */
  function cycleWindow(step) {
    const cur = model?.win ?? cfg().window;
    const i = WINDOW_IDS.indexOf(cur);
    for (let k = 1; k <= WINDOW_IDS.length; k += 1) {
      const id = WINDOW_IDS[(i + step * k + WINDOW_IDS.length * 2) % WINDOW_IDS.length];
      if (model?.avail?.get(id)?.ok ?? true) {
        pickWindow(id, false);
        return id;
      }
    }
    return null;
  }

  // ── How to read ──
  function openHelp(toFilter = false) {
    const th = cfg().th;
    const field = (label, k, step, hint) => {
      const inp = h("input", { type: "number", min: "0", step, value: String(th[k]), inputmode: "decimal", "aria-label": label });
      inp.addEventListener("change", () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v) || v < 0) return (inp.value = String(cfg().th[k]));
        setCfg({ th: { ...cfg().th, [k]: v } });
      });
      return h("label", { class: "field" }, h("span", {}, label), inp, h("small", { class: "muted" }, hint));
    };
    const filter = h(
      "section",
      { class: "oi-help-filter", id: "oi-filter" },
      h("h3", {}, "Noise filter"),
      h("p", {}, "A strike counts as build-up only when its OI change and its price change are both big enough. Heavy volume with little change is Churn."),
      h("div", { class: "oi-filter-grid" }, field("Min lots", "minLots", "1", "OI chg at least this many lots"), field("Min OI %", "minOiPct", "0.1", "and this % of OI"), field("Min price %", "minPxPct", "0.1", "price move (2 ticks at least)")),
      h("button", { type: "button", class: "small", onclick: (e) => {
        setCfg({ th: { ...OI_DEFAULTS.th } });
        const box = e.target.closest(".oi-help-filter");
        box.querySelectorAll("input").forEach((inp, i) => (inp.value = String([OI_DEFAULTS.th.minLots, OI_DEFAULTS.th.minOiPct, OI_DEFAULTS.th.minPxPct][i])));
      } }, "Reset to 10 lots · 1% · 0.5%"),
    );
    const buRows = ["LB", "SB", "SC", "LU"].map((k) => h("tr", {}, h("th", { scope: "row" }, buTag(k), ` ${O.BUILDUP_NAMES[k]}`), h("td", {}, `${O.BUILDUP_READ.ce[k][0]}: `, effectWord("ce", k)), h("td", {}, `${O.BUILDUP_READ.pe[k][0]}: `, effectWord("pe", k))));
    const body = h(
      "div",
      { class: "oi-help" },
      h("p", { class: "oi-help-lead" }, `${DISCLAIMER} Every figure states its window, strike band and coverage.`),
      h("h3", {}, "Colours"),
      h("div", { class: "oi-help-legend" }, legendList(cfg().metric, true)),
      legendNotes(),
      h("h3", {}, "Tiles"),
      h(
        "dl",
        { class: "oi-help-dl" },
        [
          ["PCR OI", "Put OI ÷ call OI over every strike loaded. The gauge runs from 0.4 to 2.5 on a log scale: red = call-heavy (a cap above), green = put-heavy (support below); the thin tick is where it stood at the window start."],
          ["PCR OI chg", "Put OI chg ÷ call OI chg over the window and band. The bar diverges from the centre: calls left, puts right, solid = added, hatched = cut."],
          ["PCR Vol", "Put volume ÷ call volume in the window; the bar splits call and put volume. Noisy on expiry day."],
          ["Max Pain", "The settlement at which option buyers collect the least. The bar spans ±2 % of spot (the centre tick) and the ◆ is max pain. It matters mainly in the last 1–2 sessions; at the range edge the chain may be partial. Not a forecast."],
          ["Call wall / Put wall", "The call strike at or above spot (put strike at or below) with the most OI. The bar is its share of all call (put) OI; ▲ fresh = being added to, ▼ unwinding = being cut. Click to find it in the ladder."],
        ].map(([t, d]) => [h("dt", {}, t), h("dd", {}, d)]),
      ),
      h("h3", {}, "Build-up and direction"),
      h("p", {}, "The same build-up means opposite things on calls and puts. Long build-up on puts is put buying: bearish for the underlying. The matrix is coloured by that effect (green bullish or supportive, red bearish or capping); the meter weighs them into one score from −1 to +1."),
      h("table", { class: "oi-help-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Class"), h("th", { scope: "col" }, "On calls"), h("th", { scope: "col" }, "On puts"))), h("tbody", {}, buRows)),
      h("h3", {}, "Two ways to read PCR"),
      h("p", {}, "India, writer view (this page): most index option OI is written by sellers, so heavy put OI means put writing below spot (support) and low PCR means call writing above (a cap). US, contrarian view: PCR measures buyers' hedging, so a high PCR reads as fear. This page uses the writer view because Indian index options are seller-dominated. Bands: ≥ 1.5 very put-heavy, ≥ 1.2 put-heavy, above 0.8 balanced, above 0.6 call-heavy, else very call-heavy."),
      h("h3", {}, "Units"),
      h("p", {}, "NSE publishes OI in contracts (lots); brokers show quantity (lots × lot size). Lots is the default; Combined across expiries is always in lots, because lot sizes differ by expiry."),
      h("h3", {}, "Keys"),
      h("p", {}, "J / K or ↑ ↓ move the strike, Enter opens its details, G goes to ATM, 1–6 pick a window, W cycles windows, M the metric, [ ] the band, U lots / qty, C shows or hides the chart, Esc clears the selection."),
      filter,
    );
    modal({ title: "How to read OI", body, buttons: [{ label: "Close", value: true }] });
    if (toFilter) setTimeout(() => filter.scrollIntoView({ block: "start" }), 60);
  }

  // ── Keyboard ──
  function onKey(e) {
    const k = e.key;
    if (k === "?") return openHelp(), true;
    if (k === "w") return cycleWindow(1), true;
    if (k === "W") return cycleWindow(-1), true;
    if (/^[1-6]$/.test(k)) return pickWindow(WINDOW_IDS[Number(k) - 1], true), true;
    if (k === "c" || k === "C") return setCfg({ chart: !cfg().chart }), true;
    if (k === "m" || k === "M") {
      const i = METRICS.findIndex((m) => m[0] === cfg().metric);
      return setCfg({ metric: METRICS[(i + 1) % METRICS.length][0] }), true;
    }
    if (k === "[" || k === "]") {
      const i = BANDS.findIndex((b) => b[0] === cfg().band);
      const j = Math.max(0, Math.min(BANDS.length - 1, i + (k === "]" ? 1 : -1)));
      return setCfg({ band: BANDS[j][0] }), true;
    }
    if (k === "u" || k === "U") {
      if (cfg().scope === "all" && extraList().length) return toast("Combined OI is in lots: lot sizes differ by expiry", { tone: "info" }), true;
      return setCfg({ unit: cfg().unit === "lots" ? "qty" : "lots" }), true;
    }
    if (e.target instanceof Element && e.target.closest(".oi-prof-hit")) return false;
    if (k === "j" || k === "ArrowDown") return ladder.move(1) || k === "j";
    if (k === "k" || k === "ArrowUp") return ladder.move(-1) || k === "k";
    if (k === "g" || k === "Home") return ladder.centre(true, true), true;
    if (k === "Enter") {
      if (e.target instanceof Element && e.target.closest("button, a, summary, input, select")) return false;
      return ladder.toggle(), true;
    }
    if (k === "Escape") return ladder.close() || clearSel();
    return false;
  }

  return {
    panels: [summaryEl, mainEl, expEl, timelineEl],
    root: mainEl,
    draw,
    onKey,
    /** Called on every refresh tick: extra expiries reload every 30 s. */
    tick() {
      ticks += 1;
      if (ticks % EXTRA_EVERY !== 0) return Promise.resolve();
      return Promise.all(extraList().map((e) => loadExtra(e)));
    },
    /** A new underlying or expiry: forget the extras and centre the ladder again. */
    reset({ underlying = false } = {}) {
      if (underlying) extras.clear();
      model = null;
      loadingKey = null;
      selK = null;
      firstTiles = true;
      ladder.reset();
      profile.reset();
    },
    /** Expiries are known: drop saved extras no longer listed, then load the included ones. */
    expiriesLoaded() {
      st.oi = oiConfig(st.oi, { underlying: st.underlying, expiries: st.expiries });
      for (const e of extraList()) if (!extras.get(e)?.chain) loadExtra(e);
    },
    /** The series prepared for the owner's chart engine: [{ t, spot, ceOi, peOi, pcr, maxPain, r1, s1 }] (lots). */
    series: () => seriesCache.data,
  };
}

// ── The OI profile chart (oi.md §6.3): grouped call / put bars per strike, purpose-built SVG ──
const PAD = { l: 40, r: 8, t: 31, b: 30 };
function createProfile({ onPick, onToggle, onJump }) {
  const svg = svgEl("svg", { class: "oi-prof-svg", role: "img", "aria-label": "OI by strike", focusable: "false" });
  const gBand = svgEl("g", { class: "band" });
  const gSel = svgEl("g", { class: "sel" });
  const gGrid = svgEl("g", { class: "grid" });
  const gBars = svgEl("g", { class: "bars" });
  const gMarks = svgEl("g", { class: "marks" });
  const gAxis = svgEl("g", { class: "axis" });
  const gSelAx = svgEl("g", { class: "sel-ax" });
  const gLabels = svgEl("g", { class: "labels" });
  const gSpot = svgEl("g", { class: "spot" });
  svg.append(gBand, gSel, gGrid, gBars, gMarks, gAxis, gSelAx, gLabels, gSpot);
  const hit = h("div", { class: "oi-prof-hit" });
  const caption = h("span", { class: "oi-prof-cap" });
  const jump = h("button", { type: "button", class: "link-btn oi-prof-jump", onclick: () => onJump() }, "Jump to the OI table");
  const hideBtn = h("button", { type: "button", class: "link-btn oi-prof-hide", title: "Hide the chart (C)", onclick: () => onToggle() }, "Hide chart");
  const box = h("div", { class: "oi-prof-box" }, svg, hit);
  const skel = h("div", { class: "oi-prof-skel", "aria-hidden": "true", hidden: true }, Array.from({ length: 21 }, (_, i) => h("span", { class: "skel", "data-i": String(i % 5) })));
  const collapsed = h("button", { type: "button", class: "oi-prof-collapsed", hidden: true, "aria-expanded": "false", title: "Show the chart (C)", onclick: () => onToggle() });
  const head = h("div", { class: "oi-prof-head" }, caption, h("span", { class: "oi-prof-acts" }, jump, hideBtn));
  const el = h("div", { class: "oi-prof" }, box, skel, collapsed);
  let built = null;
  let m = null;
  let W = 0;
  let ymax = 0;
  let entered = new Set();
  let pinK = null;
  let touchTimer = 0;
  const scrub = scrubber(hit, {
    steps: () => built?.n ?? 0,
    bigStep: 5,
    label: "OI profile: use the arrow keys to read each strike, Enter to select it in the ladder",
    at: (i) => (built && m ? { x: i * built.slot, content: tip(i) } : null),
  });
  // The tooltip shows only while the pointer or the keyboard is reading the chart. A click or tap selects the strike
  // (a column highlight and an axis pill mark it); the tip then follows the pointer again, or on touch fades after 1.5 s.
  hit.addEventListener("pointerdown", (e) => {
    queueMicrotask(() => {
      if (!(scrub.pinned && scrub.index >= 0 && built)) return;
      pinK = built.ks[scrub.index];
      onPick(pinK);
      paintSel();
      clearTimeout(touchTimer);
      if (e.pointerType === "touch") touchTimer = setTimeout(() => scrub.clear(), 1500);
      else scrub.unpin();
    });
  });
  hit.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && scrub.index >= 0 && built) {
      e.preventDefault();
      pinK = built.ks[scrub.index];
      onPick(pinK);
      paintSel();
    }
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      const w = Math.round(box.clientWidth);
      if (w && w !== W && m) {
        W = w;
        built = null;
        render(false);
      }
    }).observe(box);
  }
  function tip(i) {
    const p = m.pts[i];
    if (!p) return null;
    const line = (s) => {
      const q = p[s];
      const pct = q.dPct === null ? "" : ` (${signedPct(q.dPct)})`;
      return h(
        "div",
        { class: "row oi-tip-row" },
        h("b", { class: `ink-${SIDE_DV[s]}` }, SIDE[s]),
        h("span", {}, `OI ${m.fq(q.oi)}`),
        h("span", { class: signCls(q.d) }, `Δ ${m.fd(q.d)}${pct}`),
        buTag(q.cls),
      );
    };
    const pcr = p.ce.oi > 0 && p.pe.oi !== null ? formatFixed(p.pe.oi / p.ce.oi, 2) : DASH;
    return [h("div", { class: "oi-tip-head" }, h("b", {}, formatInt(p.k)), ...p.tags.map((t) => [" · ", t])), line("ce"), line("pe"), h("div", { class: "oi-tip-foot" }, `PCR ${pcr}`)];
  }
  const fmtTick = (v) => formatCompact(v / (m?.div ?? 1));
  /** One strike's column: its bars (in the bars layer) and marks (ghost, window-start dash, OI-added cap), each a
   *  group translated to the strike's x, so when ATM moves the columns slide instead of being rebuilt. */
  function makeCol(p, { bw, span, zeroY, metric }) {
    const gb = svgEl("g", { class: "oi-col" });
    const gm = svgEl("g", { class: "oi-col" });
    const mk = (s, dx) => {
      const cls = `oi-b ${s}`;
      // Drawn at the full half / plot height and scaled (scaleY(var(--v))): a refresh resizes from the old value.
      const up = svgEl("rect", { class: `${cls} up`, x: dx, y: PAD.t, width: bw, height: span, rx: 1 });
      const dn = metric === "chg" ? svgEl("rect", { class: `${cls} dn`, x: dx, y: zeroY, width: bw, height: span, rx: 1, fill: `url(#dv-hatch-${SIDE_DV[s]})` }) : null;
      const ghost = metric === "oi" ? svgEl("rect", { class: `oi-ghost ${s}`, x: dx, y: 0, width: bw, height: 0, visibility: "hidden", fill: `url(#dv-hatch-${SIDE_DV[s]})` }) : null;
      const ref = metric === "oi" ? svgEl("line", { class: "oi-ref", x1: dx - 2, x2: dx + bw + 2, y1: 0, y2: 0, visibility: "hidden" }) : null;
      const cap = metric === "oi" ? svgEl("rect", { class: "oi-cap", x: dx, y: 0, width: bw, height: 2, visibility: "hidden" }) : null;
      gb.append(...[up, dn].filter(Boolean));
      gm.append(...[ghost, ref, cap].filter(Boolean));
      return { up, dn, ghost, ref, cap, v: -1, gy: "", ry: "", cy: "" };
    };
    gBars.append(gb);
    gMarks.append(gm);
    return { k: p.k, gb, gm, ce: mk("ce", -bw - 0.5), pe: mk("pe", 0.5), x: null };
  }
  function render(refresh) {
    if (!m) return;
    W = W || Math.round(box.clientWidth);
    if (!W) return;
    const phone = isPhone();
    const H = phone ? 160 : 200;
    const n = m.pts.length;
    const metric = m.metric;
    const plotW = Math.max(10, W - PAD.l - PAD.r);
    const plotH = H - PAD.t - PAD.b;
    const slot = plotW / Math.max(1, n);
    const bw = Math.max(3, Math.min(14, slot * 0.36));
    const xOf = (i) => PAD.l + slot * (i + 0.5);
    const key = `${m.key}|${W}|${H}|${n}`;
    const ks = m.pts.map((p) => p.k);
    const ksSig = ks.join(",");
    // y scale: 12 % headroom over the tallest bar, so no bar reaches the label lane (spot pill, R / S labels). It grows
    // at once when the data needs more room (a bar is never clamped) and shrinks only on a 15 % drop (no jitter).
    let top = 0;
    for (const p of m.pts) {
      for (const s of ["ce", "pe"]) {
        const q = p[s];
        if (metric === "oi") top = Math.max(top, q.oi ?? 0, q.ref ?? 0);
        else if (metric === "chg") top = Math.max(top, Math.abs(q.d ?? 0));
        else top = Math.max(top, q.v ?? 0);
      }
    }
    const fresh = !built || built.key !== key;
    const want = (top || 1) * 1.12;
    if (fresh || !ymax || top * 1.04 > ymax || want < ymax * 0.85) ymax = want;
    // Ticks are round in the unit shown (lots or qty), not in raw quantity.
    const dv = m.div || 1;
    const ticks = O.niceTicks(0, ymax / dv, 4).map((t) => t * dv);
    const yTop = Math.max(ymax, ticks[ticks.length - 1] ?? ymax);
    const zeroY = metric === "chg" ? PAD.t + plotH / 2 : PAD.t + plotH;
    const span = metric === "chg" ? plotH / 2 : plotH;
    const yOf = (v) => zeroY - (v / yTop) * span;
    if (fresh) {
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      for (const g of [gBand, gSel, gGrid, gBars, gMarks, gAxis, gSelAx, gLabels, gSpot]) g.replaceChildren();
      const cols = new Map();
      for (const p of m.pts) cols.set(p.k, makeCol(p, { bw, span, zeroY, metric }));
      built = { key, n, slot, cols, ks, ksSig, H, phone };
      hit.style.left = `${Math.round(PAD.l + slot / 2)}px`;
      hit.style.right = `${Math.round(PAD.r + slot / 2)}px`;
      hit.style.setProperty("--slot", `${Math.round(slot)}px`);
      box.style.height = `${H}px`;
    } else if (built.ksSig !== ksSig) {
      // The strikes slid (ATM moved): drop the columns that left, add the edge ones; the rest slide to their new x.
      const keep = new Set(ks);
      for (const [k, c] of built.cols) {
        if (keep.has(k)) continue;
        c.gb.remove();
        c.gm.remove();
        built.cols.delete(k);
      }
      for (const p of m.pts) if (!built.cols.has(p.k)) built.cols.set(p.k, makeCol(p, { bw, span, zeroY, metric }));
      built.ks = ks;
      built.ksSig = ksSig;
    }
    built.yTop = yTop;
    m.pts.forEach((p, i) => {
      const c = built.cols.get(p.k);
      const x = Math.round(xOf(i) * 10) / 10;
      if (c.x === x) return;
      // A new column takes its place at once; one that already stood somewhere slides there.
      if (c.x === null) c.gb.classList.add("still"), c.gm.classList.add("still");
      c.x = x;
      c.gb.style.transform = `translateX(${x}px)`;
      c.gm.style.transform = `translateX(${x}px)`;
    });
    // Grid and y ticks (rebuilt when the scale changes).
    const gridSig = `${key}|${yTop}|${ticks.join(",")}`;
    if (built.gridSig !== gridSig) {
      built.gridSig = gridSig;
      gGrid.replaceChildren();
      const all = metric === "chg" ? [...ticks.filter((t) => t > 0).map((t) => -t).reverse(), ...ticks] : ticks;
      for (const t of all) {
        const y = Math.round(yOf(t)) + 0.5;
        if (y < PAD.t - 1 || y > H - PAD.b + 1) continue;
        gGrid.append(svgEl("line", { class: t === 0 ? "dv-zero" : "dv-grid", x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }));
        gGrid.append(svgEl("text", { class: "dv-tick", x: PAD.l - 6, y: y + 3.5, "text-anchor": "end" }, t === 0 ? "0" : `${t < 0 ? "−" : ""}${fmtTick(Math.abs(t))}`));
      }
    }
    // Bars: write --v only where the scaled value moved by ≥ 0.5 px (≤ 200 writes per tick).
    const ranks = (s, k) => {
      const t = m.wallMap[s].get(k);
      return t ? Number(t.slice(1)) : 0;
    };
    const emLo = m.em?.lo ?? null;
    const emHi = m.em?.hi ?? null;
    m.pts.forEach((p) => {
      const b = built.cols.get(p.k);
      for (const s of ["ce", "pe"]) {
        const q = p[s];
        const e = b[s];
        const raw = metric === "oi" ? q.oi ?? 0 : metric === "chg" ? q.d ?? 0 : q.v ?? 0;
        const v = Math.min(1, Math.abs(raw) / yTop);
        const neg = metric === "chg" && raw < 0;
        if (Math.abs(v - e.v) * span >= 0.5 || e.neg !== neg) {
          e.v = v;
          e.neg = neg;
          const shown = v > 0 ? Math.max(v, 2 / span) : 0;
          setV(e.up, neg ? 0 : shown);
          if (e.dn) setV(e.dn, neg ? shown : 0);
        }
        const rk = ranks(s, p.k);
        const out = emLo !== null && emHi !== null && (p.k < emLo || p.k > emHi);
        const cls = `${rk === 1 ? "r1" : rk ? "r2" : ""}${out ? " out" : ""}`;
        if (e.cls !== cls) {
          e.cls = cls;
          for (const r of [e.up, e.dn]) if (r) r.setAttribute("class", `oi-b ${s} ${r === e.up ? "up" : "dn"} ${cls}`.trim());
        }
        if (metric === "oi") {
          const ref = q.ref;
          const has = ref !== null && ref !== undefined;
          const gy = has && ref > (q.oi ?? 0) ? `${Math.round(yOf(ref) * 10) / 10}|${Math.round((yOf(q.oi ?? 0) - yOf(ref)) * 10) / 10}` : "";
          // Hidden marks keep their last geometry: only a visible one is moved.
          if (e.gy !== gy) {
            if (gy) {
              const [y, hh] = gy.split("|");
              setAttr(e.ghost, "y", y);
              setAttr(e.ghost, "height", hh);
            }
            setAttr(e.ghost, "visibility", gy ? "visible" : "hidden");
            e.gy = gy;
          }
          const ry = has ? String(Math.round(yOf(ref)) + 0.5) : "";
          if (e.ry !== ry) {
            e.ry = ry;
            if (ry) {
              setAttr(e.ref, "y1", ry);
              setAttr(e.ref, "y2", ry);
            }
            setAttr(e.ref, "visibility", ry ? "visible" : "hidden");
          }
          const cy = has && (q.oi ?? 0) > ref ? String(Math.round(yOf(q.oi) * 10) / 10) : "";
          if (e.cy !== cy) {
            e.cy = cy;
            if (cy) setAttr(e.cap, "y", cy);
            setAttr(e.cap, "visibility", cy ? "visible" : "hidden");
          }
        }
      }
    });
    if (typeof requestAnimationFrame === "function") {
      const still = [...gBars.querySelectorAll(".still"), ...gMarks.querySelectorAll(".still")];
      if (still.length) requestAnimationFrame(() => requestAnimationFrame(() => still.forEach((g) => g.classList.remove("still"))));
    }
    // Overlays: ±1σ band, axis labels (ATM pill, MP ◆, held dots), wall labels, spot line + pill.
    const iOf = (k) => m.pts.findIndex((p) => p.k === k);
    const oSig = `${key}|${ksSig}|${emLo}|${emHi}|${m.atm}|${m.mp}|${m.pts.map((p) => `${p.held ? 1 : 0}${p.tags.join("")}`).join(",")}`;
    if (built.oSig !== oSig) {
      built.oSig = oSig;
      gBand.replaceChildren();
      gAxis.replaceChildren();
      const a = emLo === null ? -1 : m.pts.findIndex((p) => p.k >= emLo);
      let b = -1;
      if (emHi !== null) for (let i = m.pts.length - 1; i >= 0; i -= 1) if (m.pts[i].k <= emHi) (b = i), (i = -1);
      if (a >= 0 && b >= a) {
        const x0 = PAD.l + slot * a;
        const x1 = PAD.l + slot * (b + 1);
        gBand.append(svgEl("rect", { class: "oi-band", x: x0, y: PAD.t - 4, width: x1 - x0, height: plotH + 4 }));
        gAxis.append(svgEl("text", { class: "oi-band-l", x: x0 + 3, y: PAD.t + 8 }, "±1σ"));
      }
      // Strike ticks ≥ 48 px apart; ATM, R1 and S1 first, then every k-th.
      const every = Math.max(1, Math.ceil(48 / slot));
      const want = [iOf(m.atm), ...m.pts.map((p, i) => (p.tags.includes("R1") || p.tags.includes("S1") ? i : -1)), ...m.pts.map((_, i) => (i % every === 0 ? i : -1))].filter((i) => i >= 0);
      const taken = [];
      const y = H - PAD.b + 19;
      let atmW = 0;
      for (const i of want) {
        if (taken.includes(i)) continue;
        const x = xOf(i);
        if (taken.some((j) => Math.abs(xOf(j) - x) < 44)) continue;
        taken.push(i);
        const txt = formatInt(m.pts[i].k);
        if (m.pts[i].k === m.atm) {
          // Max pain on the ATM strike: its ◆ goes inside the ATM pill ("◆ 26450"), never on top of it.
          const t2 = m.mp === m.atm ? `◆ ${txt}` : txt;
          atmW = Math.round(t2.length * 6.4 + 12);
          const cx = Math.max(atmW / 2, Math.min(W - atmW / 2, x));
          gAxis.append(svgEl("g", { class: "dv-pill oi-atm-pill" }, svgEl("title", {}, m.mp === m.atm ? `ATM ${txt} · Max pain` : `ATM ${txt}`), svgEl("rect", { x: cx - atmW / 2, y: y - 9.5, width: atmW, height: 15, rx: 7.5 }), svgEl("text", { x: cx, y: y - 1.5, "text-anchor": "middle", "dominant-baseline": "central" }, t2)));
        } else gAxis.append(svgEl("text", { class: "dv-tick", x, y: y + 2, "text-anchor": "middle" }, txt));
      }
      // Max pain: a ◆ under the plot at its strike. On the ATM strike it sits beside the ATM pill (never on it); the
      // "MP" word only where no strike label is near.
      const mi = iOf(m.mp);
      if (mi >= 0 && !(m.mp === m.atm && atmW > 0)) {
        const x = xOf(mi);
        const dy = H - PAD.b + 1;
        gAxis.append(svgEl("path", { class: "oi-mp", d: `M${x} ${dy - 4}L${x + 4} ${dy}L${x} ${dy + 4}L${x - 4} ${dy}Z` }, svgEl("title", {}, `Max pain ${formatInt(m.mp)}`)));
        // The word only where no strike label is near (beside one it would read as that strike's label).
        if (!taken.some((j) => Math.abs(xOf(j) - x) < 52)) gAxis.append(svgEl("text", { class: "oi-mp-l", x, y: y + 2, "text-anchor": "middle" }, "MP"));
      }
      m.pts.forEach((p, i) => {
        if (p.held) gAxis.append(svgEl("circle", { class: "oi-held", cx: xOf(i), cy: H - 3, r: 2 }, svgEl("title", {}, "You hold this strike")));
      });
    }
    // Wall labels on the top row, placed so they never overlap (merged when they would).
    const lSig = `${key}|${ksSig}|${m.pts.map((p) => p.tags.filter((t) => /^[RS]\d$/.test(t)).join("")).join(",")}`;
    if (built.lSig !== lSig) {
      built.lSig = lSig;
      gLabels.replaceChildren();
      const items = [];
      m.pts.forEach((p, i) => {
        // Narrow slots (phones): only the rank-1 walls are labelled; the rest stay in the tooltip and the ladder.
        for (const t of p.tags) if (/^[RS]\d$/.test(t) && (slot >= 20 || t.endsWith("1"))) items.push({ x: xOf(i) + (t[0] === "R" ? -bw / 2 : bw / 2), w: 16, text: t });
      });
      for (const l of O.placeLabels(items, { gap: 3, maxShift: 10, lo: PAD.l, hi: W - PAD.r, join: " " })) {
        const side = /^R/.test(l.text) && !/S/.test(l.text) ? "ce" : /^S/.test(l.text) && !/R/.test(l.text) ? "pe" : "";
        gLabels.append(svgEl("text", { class: `oi-wl ${side}`, x: l.x, y: 10, "text-anchor": "middle", "data-t": l.text }, l.text));
      }
    }
    // Spot: a line at the interpolated x with a contrast pill; the group slides (translateX).
    const fx = O.spotX(ks, m.spot);
    if (fx === null || !m.spotTxt) gSpot.setAttribute("visibility", "hidden");
    else {
      gSpot.removeAttribute("visibility");
      const x = Math.round((PAD.l + slot * (fx + 0.5)) * 10) / 10;
      if (!built.spotBuilt) {
        built.spotBuilt = true;
        gSpot.append(svgEl("line", { class: "dv-spot-line", x1: 0, x2: 0, y1: PAD.t, y2: H - PAD.b }));
      }
      const label = m.spotTxt;
      const w = Math.round(label.length * 6.4 + 14);
      const c = Math.max(w / 2, Math.min(W - w / 2, x)) - x;
      built.pill = spotPill(gSpot, c, label, { y: 12, width: 0, g: built.pill ?? null });
      const tx = `translateX(${x}px)`;
      if (gSpot.style.transform !== tx) gSpot.style.transform = tx;
    }
    if (svg.getAttribute("aria-label") !== m.aria) svg.setAttribute("aria-label", m.aria);
    // First draw of this (underlying, expiry, scope, metric): bars grow from the baseline, outward from ATM. Never on
    // a refresh, a resize or a strike slide.
    if (!refresh && !entered.has(m.ekey)) {
      entered.add(m.ekey);
      grow(iOf(m.atm));
    }
    paintSel();
    // A tooltip being read keeps its figures current.
    if (scrub.index >= 0) scrub.set(scrub.index);
  }
  /** The selected strike: a column highlight behind its bars and an outlined pill on the axis (ATM has its own). */
  function paintSel() {
    const i = built && m && pinK !== null ? built.ks.indexOf(pinK) : -1;
    const sig = i < 0 ? "" : `${built.key}|${built.ksSig}|${i}|${m.atm}`;
    if (!built || built.selSig === sig) return;
    built.selSig = sig;
    gSel.replaceChildren();
    gSelAx.replaceChildren();
    if (i < 0) return;
    const H = built.H;
    const x = PAD.l + built.slot * (i + 0.5);
    gSel.append(svgEl("rect", { class: "oi-selcol", x: x - built.slot / 2 + 1, y: PAD.t - 4, width: Math.max(2, built.slot - 2), height: H - PAD.t - PAD.b + 4, rx: 3 }));
    if (pinK === m.atm) return;
    const txt = formatInt(pinK);
    const w = Math.round(txt.length * 6.4 + 12);
    const y = H - PAD.b + 19;
    const cx = Math.max(w / 2, Math.min(W - w / 2, x));
    gSelAx.append(svgEl("g", { class: "oi-sel-pill" }, svgEl("rect", { x: cx - w / 2, y: y - 9.5, width: w, height: 15, rx: 7.5 }), svgEl("text", { x: cx, y: y - 1.5, "text-anchor": "middle", "dominant-baseline": "central" }, txt)));
  }
  function grow(ai) {
    if (reducedMotion() || typeof requestAnimationFrame !== "function") return;
    m.pts.forEach((p, i) => {
      const b = built.cols.get(p.k);
      const d = String(Math.min(20, Math.abs(i - (ai < 0 ? 0 : ai))));
      for (const s of ["ce", "pe"]) for (const r of [b[s].up, b[s].dn]) r?.style.setProperty("--i", d);
    });
    el.classList.add("enter");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.classList.add("entering");
        el.classList.remove("enter");
        setTimeout(() => el.classList.remove("entering"), 650);
      }),
    );
  }
  return {
    el,
    /** The caption and the Jump / Hide links: the page puts them on the legend row (one line, not two). */
    head,
    draw(model, moved = {}) {
      skel.hidden = true;
      el.classList.remove("empty");
      const on = model.on;
      el.classList.toggle("off", !on);
      const ht = on ? "Hide chart" : "Show chart";
      if (hideBtn.textContent !== ht) hideBtn.textContent = ht;
      jump.hidden = !on;
      box.hidden = !on;
      collapsed.hidden = on;
      collapsed.setAttribute("aria-expanded", String(on));
      if (!on) {
        if (collapsed.textContent !== model.summary) collapsed.textContent = model.summary;
        m = model;
        return;
      }
      if (caption.textContent !== model.caption) caption.textContent = model.caption;
      if (el.dataset.metric !== model.metric) el.dataset.metric = model.metric;
      const refresh = Boolean(m && built && m.key === model.key);
      m = model;
      render(refresh);
      if (moved.ce || moved.pe)
        for (const t of gLabels.querySelectorAll("text")) {
          const txt = t.getAttribute("data-t") ?? "";
          if ((moved.ce && txt.includes("R1")) || (moved.pe && txt.includes("S1"))) {
            t.classList.remove("oi-ring-svg");
            requestAnimationFrame(() => t.classList.add("oi-ring-svg"));
          }
        }
    },
    /** Mark a strike selected elsewhere (ladder, walls, movers, tiles): a column highlight, no pinned tooltip. */
    pin(k) {
      pinK = k;
      paintSel();
    },
    clear() {
      pinK = null;
      clearTimeout(touchTimer);
      scrub.clear();
      paintSel();
    },
    reset() {
      built = null;
      m = null;
      ymax = 0;
      pinK = null;
      entered = new Set();
      scrub.clear();
    },
    /** No data: a skeleton while loading, nothing otherwise. */
    message(kind) {
      built = null;
      m = null;
      box.hidden = true;
      collapsed.hidden = true;
      caption.textContent = "";
      skel.hidden = kind !== "loading";
      el.classList.toggle("empty", kind !== "loading");
    },
  };
}

// ── The max pain curve (oi.md §7.2): a valley, the minimum at the bottom ──
let painUid = 0;
function createPainCurve() {
  const svg = svgEl("svg", { class: "oi-pain-svg", role: "img", focusable: "false" });
  const host = h("div", { class: "oi-pain-box" }, svg);
  const relChip = h("span", { class: "oi-rel" });
  const head = h("h3", { class: "oi-block-head" }, "Max pain curve", relChip);
  const cap = h("p", { class: "oi-foot muted" });
  const el = h("div", { class: "oi-pain", hidden: true }, head, host, cap);
  let m = null;
  let pts = [];
  let W = 0;
  let revealKey = "";
  let sig = "";
  const H = () => (isPhone() ? 100 : 120);
  const scrub = scrubber(host, {
    steps: () => pts.length,
    bigStep: 5,
    label: "Max pain curve: use the arrow keys to read each strike",
    at: (i) => {
      const p = pts[i];
      if (!p) return null;
      const pct = p.min > 0 ? ((p.pain - p.min) / p.min) * 100 : null;
      return { x: p.x, content: [h("b", {}, formatInt(p.k)), h("div", {}, p.pain === p.min ? "Max pain: buyers collect the least here" : pct === null ? DASH : `writers pay ${formatSigned(pct, 1)}% more than at max pain`)] };
    },
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      const w = Math.round(host.clientWidth);
      if (w && w !== W && m) {
        W = w;
        sig = "";
        render();
      }
    }).observe(host);
  }
  function render() {
    const { mp, spot, em, relevance, key } = m;
    W = W || Math.round(host.clientWidth);
    if (!W) return;
    const Hh = H();
    const pad = { l: 6, r: 6, t: 26, b: 18 };
    const ai = mp.curve.findIndex((c) => c.strike === mp.strike);
    const curve = mp.curve.slice(Math.max(0, ai - 15), ai + 16);
    const s2 = JSON.stringify([curve, spot, em?.lo, em?.hi, W, Hh, mp.edge]);
    if (s2 === sig) return;
    sig = s2;
    const lo = Math.min(...curve.map((c) => c.pain));
    const hi = Math.max(...curve.map((c) => c.pain));
    const n = curve.length;
    const step = (W - pad.l - pad.r) / Math.max(1, n - 1);
    const xOf = (i) => pad.l + step * i;
    // A valley: the least pain (max pain's strike) at the bottom, the most at the top.
    const valley = (p) => Hh - pad.b - (hi > lo ? (p - lo) / (hi - lo) : 0) * (Hh - pad.t - pad.b);
    pts = curve.map((c, i) => ({ k: c.strike, pain: c.pain, min: lo, x: xOf(i), y: valley(c.pain) }));
    svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(Hh));
    svg.replaceChildren();
    const ks = curve.map((c) => c.strike);
    if (em?.lo !== null && em?.lo !== undefined && em?.hi !== null && em?.hi !== undefined) {
      const a = O.spotX(ks, Math.max(ks[0], em.lo));
      const b = O.spotX(ks, Math.min(ks[n - 1], em.hi));
      if (a !== null && b !== null && b > a) svg.append(svgEl("rect", { class: "oi-band", x: xOf(a), y: pad.t - 6, width: xOf(b) - xOf(a), height: Hh - pad.t - pad.b + 6 }));
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${Math.round(xOf(i) * 10) / 10} ${Math.round(p.y * 10) / 10}`).join("");
    // The area above the valley, shaded from the rim (most pain) down to the floor: the valley reads at a glance.
    const gid = `oi-pain-g-${++painUid}`;
    const grad = svgEl("linearGradient", { id: gid, x1: "0", x2: "0", y1: "0", y2: "1" }, svgEl("stop", { offset: "0", class: "oi-pg-a" }), svgEl("stop", { offset: "1", class: "oi-pg-b" }));
    const area = svgEl("path", { class: "oi-pain-area", d: `${d}L${xOf(n - 1)} ${Hh - pad.b}L${xOf(0)} ${Hh - pad.b}Z`, fill: `url(#${gid})` });
    const line = svgEl("path", { class: "oi-pain-line", d });
    svg.append(svgEl("defs", {}, grad), area, line);
    const sx = O.spotX(ks, spot);
    const spotPx = sx === null ? null : Math.round(xOf(sx)) + 0.5;
    if (spotPx !== null) svg.append(svgEl("line", { class: "oi-pain-spot", x1: spotPx, x2: spotPx, y1: pad.t - 4, y2: Hh - pad.b }));
    const vi = curve.findIndex((c) => c.strike === mp.strike);
    const vx = xOf(vi);
    const vy = valley(curve[vi].pain);
    svg.append(svgEl("path", { class: "oi-mp", d: `M${vx} ${vy - 5}L${vx + 5} ${vy}L${vx} ${vy + 5}L${vx - 5} ${vy}Z` }));
    spotPill(svg, vx, `MP ${formatInt(mp.strike)}`, { y: 2, width: W });
    // The x axis: spot's value at its line (it never meets the MP pill on top), then 3–4 round strikes that keep clear.
    const axY = Hh - 4;
    const used = [];
    if (spotPx !== null) {
      const t = `Spot ${formatInt(Math.round(spot))}`;
      const w = t.length * 6;
      const cx = Math.max(w / 2, Math.min(W - w / 2, spotPx));
      used.push([cx - w / 2 - 6, cx + w / 2 + 6]);
      svg.append(svgEl("text", { class: "dv-tick oi-pain-spot-l", x: cx, y: axY, "text-anchor": "middle" }, t));
    }
    for (const t of O.niceTicks(ks[0], ks[n - 1], 4)) {
      const fxi = O.spotX(ks, t);
      if (fxi === null) continue;
      const x = xOf(fxi);
      const txt = formatInt(t);
      const w = txt.length * 6;
      const a = Math.max(0, x - w / 2);
      const b = Math.min(W, x + w / 2);
      if (used.some(([u, v]) => b > u && a < v)) continue;
      used.push([a - 6, b + 6]);
      svg.append(svgEl("line", { class: "dv-grid oi-pain-tick", x1: Math.round(x) + 0.5, x2: Math.round(x) + 0.5, y1: Hh - pad.b, y2: Hh - pad.b + 3 }), svgEl("text", { class: "dv-tick", x: Math.max(w / 2, Math.min(W - w / 2, x)), y: axY, "text-anchor": "middle" }, txt));
    }
    if (mp.edge) {
      const ex = vi === 0 ? xOf(0) + 4 : xOf(n - 1) - 4;
      svg.append(svgEl("circle", { class: "oi-edge-dot", cx: ex, cy: pad.t - 14, r: 4 }, svgEl("title", {}, "At the edge of the loaded range: the chain may be partial")));
    }
    const dist = spot !== null ? mp.strike - spot : null;
    svg.setAttribute("aria-label", `Max pain curve: lowest at ${formatInt(mp.strike)}${dist === null ? "" : `, ${formatInt(Math.abs(Math.round(dist)))} points ${dist >= 0 ? "above" : "below"} spot`}.`);
    if (revealKey !== key) {
      revealKey = key;
      lineReveal(line, [area]);
    }
    const capTxt = `Total payout to option buyers if expiry settles at each strike; the lowest point is max pain. Matters mainly in the last 1–2 sessions.${mp.edge ? " At the edge of the loaded range: the chain may be partial." : ""}`;
    if (cap.textContent !== capTxt) cap.textContent = capTxt;
    const rel = relevance ? `${relevance} relevance` : "";
    if (relChip.textContent !== rel) relChip.textContent = rel;
    relChip.dataset.rel = relevance ?? "";
  }
  return {
    el,
    draw(model) {
      if (!model.mp || !model.mp.curve?.length) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      m = model;
      render();
    },
    clear() {
      el.hidden = true;
      m = null;
      sig = "";
      scrub.clear();
    },
  };
}

// ── The ladder: a mirrored table, built once per (underlying, expiry, scope, metric, unit) and patched after. When ATM
// moves and the loaded strikes slide, rows are added or removed at the ends instead of rebuilding the table ──
let uid = 0;
/** Writes only what changed, so a refresh tick stays well under 200 DOM writes (oi.md §8). */
const setText = (el, t) => {
  const v = t ?? "";
  const n = el.firstChild;
  if (n && n.nodeType === 3 && !n.nextSibling) {
    if (n.data !== v) n.data = v;
  } else if (el.textContent !== v) el.textContent = v;
};
const setClass = (el, c) => {
  if (el.className !== c) el.className = c;
};
const setTitle = (el, t) => {
  if (el.title !== t) el.title = t;
};
const setAttr = (el, k, v) => {
  if (el.getAttribute(k) !== v) el.setAttribute(k, v);
};
const setProp = (el, k, v) => {
  if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
};
/** The top of the tab bar (phones and tablets), or the viewport's bottom where there is none. */
function viewBottom() {
  const tab = document.getElementById("tabbar");
  const r = tab?.getBoundingClientRect();
  return r && r.height > 0 && r.top < innerHeight ? r.top : innerHeight;
}
function createLadder({ detailFor, onOpenChain, onSelect }) {
  const wrap = h("div", { class: "oi-ladder-wrap" });
  const atmPill = h("button", { type: "button", class: "oi-atm-pill", hidden: true, onclick: () => centre(true, true) });
  const el = h("div", { class: "oi-ladder-host" }, wrap, atmPill);
  let built = null;
  let sel = null;
  let open = null;
  let needCentre = true;
  let atm = null;
  let entered = new Set();
  const coarse = () => media(MQ_COARSE).matches;

  function barCell(side) {
    const ghost = h("span", { class: "ghost" });
    const now = h("span", { class: "now" });
    const chg = h("span", { class: "chg" });
    const v = h("span", { class: "v" });
    return { td: h("td", { class: `ob ${side}` }, h("span", { class: "trk", "aria-hidden": "true" }, ghost, now, chg), v), ghost, now, chg, v, sig: "" };
  }
  function dCell(side) {
    const val = h("span", { class: "dv" });
    const pct = h("small", { class: "dp" });
    const bu = h("span", { class: "obu" });
    return { td: h("td", { class: `d ${side}` }, h("span", { class: "dwrap" }, val, h("span", { class: "dsub" }, pct, bu))), val, pct, bu, sig: "" };
  }
  function makeRow(k) {
    const cd = dCell("ce");
    const cb = barCell("ce");
    const pb = barCell("pe");
    const pd = dCell("pe");
    const tags = h("span", { class: "tags" });
    const kv = h("span", { class: "kv" }, formatInt(k));
    const th = h("th", { scope: "row", class: "k" }, kv, tags);
    const tr = h("tr", { tabindex: "-1", "aria-selected": "false", "aria-expanded": "false", "data-k": String(k) }, cd.td, cb.td, th, pb.td, pd.td);
    return { tr, th, kv, tags, ce: { d: cd, b: cb }, pe: { d: pd, b: pb }, sig: "", tagSig: "" };
  }
  function build(m) {
    const caption = h("caption", { class: "sr-only" }, m.caption);
    const hce = h("span", {});
    const hpe = h("span", {});
    // Spot lives in the strike column's head (a contrast pill) and as a line between the two strikes it sits between,
    // so no label ever covers a row's tags or the ATM pill.
    const kSpot = h("span", { class: "oi-kspot", "aria-hidden": "true", hidden: true });
    const head = h("tr", {}, h("th", { scope: "col", class: "d ce", "aria-label": "Call OI chg" }, "Δ OI"), h("th", { scope: "col", class: "ob ce" }, hce), h("th", { scope: "col", class: "k" }, h("span", { class: "kt" }, "Strike"), kSpot), h("th", { scope: "col", class: "ob pe" }, hpe), h("th", { scope: "col", class: "d pe", "aria-label": "Put OI chg" }, "Δ OI"));
    const tbody = h("tbody");
    const rows = new Map();
    const order = [];
    for (const r of m.rows) {
      const b = makeRow(r.strike);
      tbody.append(b.tr);
      rows.set(r.strike, b);
      order.push(r.strike);
    }
    const detail = h("tr", { class: "oi-detail", id: `oi-detail-${++uid}`, hidden: true }, h("td", { colspan: "5" }));
    const tbl = h("table", { class: `oi-ladder m-${m.metric}`, tabindex: "-1" }, caption, h("thead", {}, head), tbody);
    tbody.addEventListener("click", onClick);
    tbody.addEventListener("pointerover", (e) => {
      const td = e.target.closest?.("td.ob");
      if (td && td.__title !== undefined) setTitle(td, td.__title);
    });
    const hadFocus = wrap.contains(document.activeElement) && document.activeElement?.matches?.("tr[data-k]");
    wrap.replaceChildren(tbl);
    built = { key: m.key, ks: m.ks, tbl, caption, hce, hpe, kSpot, tbody, rows, order, detail, max: 0, first: true };
    if (sel !== null && !rows.has(sel)) sel = null;
    if (open !== null && !rows.has(open)) open = null;
    // A rebuild (metric, unit, scope) keeps the selection: mark it again, keep it tabbable and keep focus on it.
    // The scroll position carries over (same strikes, same row height); a fresh ladder centres on ATM.
    if (sel !== null) select(sel, false, hadFocus);
    else needCentre = true;
  }
  /** The loaded strikes slid (ATM moved): add and drop rows at the ends; the rows that stay keep their state. */
  function slide(m) {
    const ks = m.rows.map((r) => r.strike);
    const keep = new Set(ks);
    // An anchor row present before and after holds the scroll position steady.
    const anchor = ks.find((k) => built.rows.has(k) && !built.rows.get(k).tr.hidden);
    const before = anchor !== undefined ? built.rows.get(anchor).tr.offsetTop : null;
    for (const [k, b] of built.rows) {
      if (keep.has(k)) continue;
      if (open === k) {
        open = null;
        built.detail.hidden = true;
      }
      if (sel === k) sel = null;
      b.tr.remove();
      built.rows.delete(k);
    }
    let next = null;
    for (let i = ks.length - 1; i >= 0; i -= 1) {
      let b = built.rows.get(ks[i]);
      if (!b) {
        b = makeRow(ks[i]);
        built.rows.set(ks[i], b);
        built.tbody.insertBefore(b.tr, next);
      }
      next = b.tr;
    }
    built.order = ks;
    built.ks = m.ks;
    if (before !== null) {
      const d = built.rows.get(anchor).tr.offsetTop - before;
      if (d) wrap.scrollTop += d;
    }
  }
  function onClick(e) {
    if (e.target.closest("a, button")) return;
    const tr = e.target.closest("tr[data-k]");
    if (!tr) return;
    const k = Number(tr.dataset.k);
    // Touch: a tap selects and opens. Desktop: a click on the strike opens at once; elsewhere select, then open.
    if (coarse() || e.target.closest("th.k")) {
      select(k, false);
      toggle(k);
    } else if (sel === k) toggle(k);
    else select(k, false);
    onSelect(k);
  }
  function select(k, scroll = true, focus = true) {
    if (!built) {
      sel = k;
      return;
    }
    sel = k;
    for (const [s, b] of built.rows) {
      const on = s === k;
      if ((b.tr.getAttribute("aria-selected") === "true") !== on) b.tr.setAttribute("aria-selected", String(on));
      const ti = on ? 0 : -1;
      if (b.tr.tabIndex !== ti) b.tr.tabIndex = ti;
    }
    const b = built.rows.get(k);
    if (!b || b.tr.hidden) return;
    if (focus) b.tr.focus({ preventScroll: true });
    if (scroll) into(b.tr);
  }
  /** Bring a row into view inside the ladder only (the page does not jump). */
  function into(tr) {
    // A hidden row (outside the band) has no box: offsetTop 0 would jump the ladder to its top.
    if (!tr || tr.hidden || !tr.offsetHeight) return;
    const head = wrap.querySelector("thead")?.offsetHeight ?? 0;
    const top = tr.offsetTop;
    const bottom = top + tr.offsetHeight;
    const viewTop = wrap.scrollTop + head;
    const viewBottom = wrap.scrollTop + wrap.clientHeight;
    const behavior = reducedMotion() ? "auto" : "smooth";
    if (top < viewTop) wrap.scrollTo({ top: top - head - 4, behavior });
    else if (bottom > viewBottom) wrap.scrollTo({ top: bottom - wrap.clientHeight + 4, behavior });
  }
  function toggle(k = sel ?? atm) {
    if (!built || k === null || k === undefined) return;
    if (open === k) return close();
    open = k;
    if (sel !== k) select(k, false);
    paintDetail(true);
    into(built.rows.get(k)?.tr);
    // Once the card has opened: the whole card in view, in the ladder and on the page (above the tab bar).
    const d = built.detail;
    setTimeout(() => {
      if (open === k && !d.hidden && d.isConnected) d.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }, reducedMotion() ? 0 : 230);
  }
  function close() {
    if (open === null || !built) return false;
    const b = built.rows.get(open);
    b?.tr.setAttribute("aria-expanded", "false");
    b?.tr.removeAttribute("aria-controls");
    open = null;
    const d = built.detail;
    const box = d.querySelector(".oi-dx");
    if (box && !reducedMotion()) {
      box.classList.remove("in");
      setTimeout(() => {
        if (open === null) d.hidden = true;
      }, 160);
    } else d.hidden = true;
    return true;
  }
  function detailSide(s, k) {
    if (!s.listed) return h("div", { class: `oi-dside ${s.side}` }, h("div", { class: "oi-dh" }, sideChip(s.side), h("strong", {}, `${formatInt(k)} ${SIDE[s.side]}`)), h("p", { class: "oi-q" }, "Not listed"));
    return h(
      "div",
      { class: `oi-dside ${s.side}` },
      h("div", { class: "oi-dh" }, sideChip(s.side), h("strong", {}, `${formatInt(k)} ${SIDE[s.side]}`), wallChip(s.wall), s.held ? h("span", { class: `oi-held-b ${s.side}` }, s.held) : null),
      h("p", {}, "OI ", h("span", { class: "oi-q" }, s.oiFrom), " → ", h("b", {}, s.oiTo), " ", h("span", { class: signCls(s.d) }, s.dTxt), s.pct ? h("span", { class: "oi-q" }, ` (${s.pct})`) : null),
      s.ltp !== null ? h("p", {}, "LTP ", h("b", {}, s.ltp), s.dLtpTxt ? [" ", h("span", { class: signCls(s.dLtp) }, `(${s.dLtpTxt})`)] : null) : null,
      s.vol !== null ? h("p", {}, "Vol ", h("b", {}, s.vol)) : null,
      s.cls ? h("p", {}, buTag(s.cls), " ", O.BUILDUP_NAMES[s.cls], " → ", effectWord(s.side, s.cls)) : null,
      h("button", { type: "button", class: "link-btn", onclick: () => onOpenChain(k, s.side) }, `Open ${SIDE[s.side]} in chain →`),
    );
  }
  function paintDetail(opening = false) {
    if (!built || open === null) return;
    const b = built.rows.get(open);
    const info = detailFor(open);
    if (!b || !info || b.tr.hidden) return close();
    for (const [, r] of built.rows) if (r.tr.getAttribute("aria-expanded") === "true" && r !== b) r.tr.setAttribute("aria-expanded", "false");
    if (b.tr.getAttribute("aria-expanded") !== "true") b.tr.setAttribute("aria-expanded", "true");
    if (b.tr.getAttribute("aria-controls") !== built.detail.id) b.tr.setAttribute("aria-controls", built.detail.id);
    const td = built.detail.firstChild;
    const sig = JSON.stringify([open, info]);
    if (td.__sig !== sig) {
      td.__sig = sig;
      const k = open;
      const wasIn = td.querySelector(".oi-dx.in") && !opening;
      td.replaceChildren(h("div", { class: `oi-dx${wasIn ? " in" : ""}` }, h("div", { class: "oi-dx-in" }, h("div", { class: "oi-dcols" }, info.sides.map((s) => detailSide(s, k))), h("p", { class: "oi-q oi-dfoot" }, `Δ ${/^(vs|since) /.test(info.window) ? info.window : `vs ${info.window}`} · OI in ${info.unit}`))));
    }
    if (b.tr.nextSibling !== built.detail) b.tr.after(built.detail);
    if (built.detail.hidden) built.detail.hidden = false;
    if (opening) {
      const box = td.querySelector(".oi-dx");
      box.classList.remove("in");
      if (reducedMotion()) box.classList.add("in");
      else requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("in")));
    }
  }
  /**
   * The part of the ladder the reader can actually see, in viewport px: the wrap under its sticky head, clipped to the
   * viewport and kept above the tab bar (phones, tablets).
   */
  function visible() {
    const r = wrap.getBoundingClientRect();
    const head = wrap.querySelector("thead")?.offsetHeight ?? 0;
    return { top: Math.max(r.top + head, 0), bottom: Math.min(r.bottom, viewBottom()), boxTop: r.top, head };
  }
  /**
   * Centre ATM in the visible part of the ladder (on a phone at first view that is the slice above the tab bar, not
   * the wrap's own middle below the fold), snapped to a whole row (the first row is never cut in half).
   */
  function centre(focusRow = false, smooth = false) {
    if (!built || atm === null) return;
    const b = built.rows.get(atm);
    if (!b || b.tr.hidden) return;
    const v = visible();
    const rowH = b.tr.offsetHeight || 36;
    // Where the ATM row's middle should land, in px from the wrap box's top.
    const mid = v.bottom - v.top >= rowH * 3 ? (v.top + v.bottom) / 2 - v.boxTop : v.head + (wrap.clientHeight - v.head) / (coarse() ? 3 : 2);
    const top = b.tr.offsetTop + rowH / 2 - mid;
    const first = [...b.tr.parentNode.children].find((r) => r.offsetHeight && r.offsetTop + r.offsetHeight / 2 > top + v.head);
    const snapped = Math.max(0, first ? first.offsetTop - v.head : top);
    if (smooth && !reducedMotion() && typeof wrap.scrollTo === "function") wrap.scrollTo({ top: snapped, behavior: "smooth" });
    else wrap.scrollTop = snapped;
    if (focusRow) select(atm, false);
    scheduleAtmCheck();
  }
  let rafPending = false;
  function scheduleAtmCheck() {
    if (rafPending || typeof requestAnimationFrame !== "function") return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      checkAtm();
    });
  }
  wrap.addEventListener("scroll", scheduleAtmCheck, { passive: true });
  // The page scrolls too (phones and tablets: the ladder sits below the chart): ATM can leave the view either way.
  const onPageScroll = () => {
    if (!el.isConnected) return removeEventListener("scroll", onPageScroll);
    scheduleAtmCheck();
  };
  addEventListener("scroll", onPageScroll, { passive: true });
  /** The floating "↕ ATM 26400" pill: shown while the ATM row is out of the visible part, pointing towards it. */
  function checkAtm() {
    const b = built && atm !== null ? built.rows.get(atm) : null;
    if (!b || b.tr.hidden || !wrap.isConnected) {
      if (!atmPill.hidden) atmPill.hidden = true;
      return;
    }
    const v = visible();
    const r = b.tr.getBoundingClientRect();
    // Only while some of the ladder is on screen (the pill sits on it).
    const onScreen = v.bottom - v.top > 40;
    const above = r.bottom <= v.top + 2;
    const below = r.top >= v.bottom - 2;
    const show = onScreen && (above || below);
    if (atmPill.hidden === show) atmPill.hidden = !show;
    if (show) {
      const t = `${above ? "↑" : "↓"} ATM ${formatInt(atm)}`;
      if (atmPill.textContent !== t) atmPill.textContent = t;
      atmPill.setAttribute("aria-label", `Back to ATM ${formatInt(atm)} (G)`);
    }
  }
  /** First draw of an (underlying, expiry, scope, metric): bars grow outward from ATM (12 ms per row, ≤ 240 ms). */
  function grow() {
    if (reducedMotion() || typeof requestAnimationFrame !== "function") return;
    const ai = built.order.indexOf(atm);
    built.order.forEach((k, i) => built.rows.get(k)?.tr.style.setProperty("--i", String(Math.min(20, Math.abs(i - (ai < 0 ? 0 : ai))))));
    const t = built.tbl;
    t.classList.add("enter");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        t.classList.add("entering");
        t.classList.remove("enter");
        setTimeout(() => t.classList.remove("entering"), 650);
      }),
    );
  }
  const frac = (v, max) => (v === null || v === undefined || !max ? 0 : v === 0 ? 0 : Math.max(0.02, Math.min(1, Math.abs(v) / max)));
  const fmt3 = (f) => String(Math.round(f * 1000) / 1000);
  function draw(m, moved = {}) {
    if (!built || built.key !== m.key || !wrap.querySelector("table")) build(m);
    else if (built.ks !== m.ks) slide(m);
    atm = m.atm;
    setText(built.caption, m.caption);
    setText(built.hce, `${m.head.ce} (${m.head.unit})${m.head.tail}`);
    setText(built.hpe, `${m.head.pe} (${m.head.unit})${m.head.tail}`);
    // Spot in the strike head: "Spot 26446.85" (phones: the figure).
    const ks = built.kSpot;
    if (ks.hidden === Boolean(m.spotTxt)) ks.hidden = !m.spotTxt;
    setText(ks, m.spotTxt ? `${isPhone() ? "" : "Spot "}${m.spotTxt}` : "");
    // Grow at once when the data outgrows the scale (a bar is never clamped); shrink only on a 10 % drop, so bars do
    // not jitter every tick.
    if (!built.max || m.max > built.max || m.max < built.max * 0.9) built.max = m.max || 1;
    const max = built.max;
    const first = built.first;
    const phone = isPhone();
    for (const r of m.rows) {
      const b = built.rows.get(r.strike);
      if (!b) continue;
      if (b.tr.hidden === r.inBand) b.tr.hidden = !r.inBand;
      // Rows outside the band are not drawn: they are patched when the band shows them (their signatures differ then).
      if (!r.inBand) continue;
      const isSpot = Boolean(r.spotLine);
      const rowSig = `${r.atm}|${r.inEm}|${r.out}|${isSpot}`;
      if (b.sig !== rowSig) {
        const hop = b.sig !== "" && isSpot && !b.tr.classList.contains("spot-line");
        b.sig = rowSig;
        b.tr.classList.toggle("atm", r.atm);
        b.tr.classList.toggle("in-em", r.inEm);
        b.tr.classList.toggle("out-em", r.out);
        b.tr.classList.toggle("spot-line", isSpot);
        if (hop) {
          b.th.classList.remove("spot-in");
          requestAnimationFrame(() => b.th.classList.add("spot-in"));
        }
      }
      const tagSig = JSON.stringify(r.tags);
      if (b.tagSig !== tagSig) {
        b.tagSig = tagSig;
        // At most two tags; the rest as "+n" (all of them in the title and the detail row).
        const shown = r.tags.length > 2 ? r.tags.slice(0, 1) : r.tags;
        const more = r.tags.length - shown.length;
        b.tags.replaceChildren(...shown.map((t) => h("span", { class: `tag ${t.cls}`, title: t.title }, t.t)), ...(more ? [h("span", { class: "tag more", title: r.tags.slice(1).map((t) => t.t).join(" · ") }, `+${more}`)] : []));
        b.th.title = r.tags.map((t) => t.title).join(" · ");
      }
      if (moved.ce || moved.pe) {
        for (const t of b.tags.querySelectorAll(".tag.wall")) if ((moved.ce && t.textContent === "R1") || (moved.pe && t.textContent === "S1")) ring(t);
      }
      for (const s of ["ce", "pe"]) {
        const q = r[s];
        const bc = b[s].b;
        const f = frac(q.val, max);
        const neg = m.metric === "chg" && (q.dNum ?? 0) < 0;
        const fs = fmt3(f);
        const sig = `${fs}|${q.ref}|${q.d}|${q.txt}|${q.rank}|${neg}|${max}|${phone}|${r.out}|${q.title}`;
        if (bc.sig !== sig) {
          bc.sig = sig;
          // One write: the bar (and the phone figure's position) read --v from the cell.
          setProp(bc.td, "--v", fs);
          // Phones: the figure goes inside a long bar, on a solid chip of the bar's colour (dark ink ≥ 4.5:1 on
          // every side and metric colour, in both themes).
          setClass(bc.td, `ob ${s}${q.rank === 1 ? " r1" : q.rank ? " r2" : ""}${neg ? " neg" : ""}${phone && f >= 0.4 ? " vin" : ""}`);
          // Ghost: OI cut since the window start (ref > now), the same scale; the change micro-bar under the bar.
          const ref = q.ref;
          const ghostOn = m.metric === "oi" && ref !== null && ref > (q.val ?? 0);
          if (bc.ghost.hidden === ghostOn) bc.ghost.hidden = !ghostOn;
          if (ghostOn) setProp(bc.ghost, "--v", fmt3(frac(ref, max)));
          const chgOn = m.metric === "oi" && q.d !== null && q.d !== 0;
          if (bc.chg.hidden === chgOn) bc.chg.hidden = !chgOn;
          if (chgOn) {
            setProp(bc.chg, "--v", fmt3(frac(q.d, max)));
            bc.chg.classList.toggle("cut", q.d < 0);
          }
          setText(bc.v, q.txt);
          // The tooltip text changes with every figure: it is written when the pointer comes over the cell.
          bc.td.__title = q.title;
          if (bc.td.matches(":hover")) setTitle(bc.td, q.title);
        }
        const dc = b[s].d;
        const dsig = `${q.dTxt}|${q.pTxt}|${q.bu}`;
        if (dc.sig !== dsig) {
          const had = dc.sig !== "";
          const prev = dc.val.textContent;
          dc.sig = dsig;
          if (prev !== q.dTxt) {
            setText(dc.val, q.dTxt);
            if (had && !first && prev !== DASH && q.dNum !== null && dc.n !== undefined && dc.n !== null && dc.n !== q.dNum) flashValue(dc.val, q.dNum > dc.n ? "up" : "down");
          }
          // Tone by toggles (a className write would also wipe a running flash).
          const tone = q.dNum === null ? "" : q.dNum > 0 ? "pos" : q.dNum < 0 ? "neg" : "zero";
          if (dc.tone !== tone) {
            dc.tone = tone;
            for (const t of ["pos", "neg", "zero"]) if (dc.val.classList.contains(t) !== (t === tone)) dc.val.classList.toggle(t, t === tone);
          }
          setText(dc.pct, q.pTxt);
          setText(dc.bu, q.bu ?? "");
          if (dc.bu.hidden === Boolean(q.bu)) dc.bu.hidden = !q.bu;
          setTitle(dc.bu, q.buTitle ?? "");
          setClass(dc.bu, `obu${q.bu ? ` obu-${q.bu}` : ""}`);
        }
        dc.n = q.dNum;
      }
    }
    if (needCentre && wrap.isConnected && wrap.clientHeight) {
      needCentre = false;
      centre();
    }
    if (sel === null && atm !== null) {
      const b = built.rows.get(atm);
      if (b && b.tr.tabIndex !== 0) b.tr.tabIndex = 0;
    }
    if (open !== null) paintDetail();
    if (first) {
      built.first = false;
      // The entrance plays once per (underlying, expiry, scope, metric), never on a refresh or a strike slide.
      if (!entered.has(m.ekey)) {
        entered.add(m.ekey);
        grow();
      }
    }
    // Reading row positions forces a layout: do it after the frame paints, not inside the refresh.
    scheduleAtmCheck();
  }
  function ring(t) {
    t.classList.remove("oi-ring");
    requestAnimationFrame(() => {
      t.classList.add("oi-ring");
      setTimeout(() => t.classList.remove("oi-ring"), reducedMotion() ? 3000 : 950);
    });
  }
  function move(d) {
    if (!built) return false;
    const vis = built.order.filter((k) => built.rows.get(k) && !built.rows.get(k).tr.hidden);
    if (!vis.length) return false;
    const i = vis.indexOf(sel ?? atm);
    const j = Math.max(0, Math.min(vis.length - 1, (i < 0 ? vis.indexOf(atm) : i) + d));
    const k = vis[j < 0 ? 0 : j];
    select(k);
    onSelect(k);
    return true;
  }
  return {
    el,
    draw,
    move,
    select,
    toggle: () => toggle(),
    close,
    centre,
    unselect() {
      sel = null;
      if (!built) return;
      for (const [, b] of built.rows) if (b.tr.getAttribute("aria-selected") === "true") b.tr.setAttribute("aria-selected", "false");
    },
    focusTable() {
      const b = built?.rows.get(sel ?? atm);
      if (b) {
        b.tr.tabIndex = 0;
        b.tr.focus({ preventScroll: true });
        wrap.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      }
    },
    reset() {
      built = null;
      sel = null;
      open = null;
      needCentre = true;
      entered = new Set();
    },
    message(node) {
      built = null;
      needCentre = true;
      wrap.replaceChildren(node);
      atmPill.hidden = true;
    },
  };
}
