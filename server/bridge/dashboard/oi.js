// OI Analysis (#/oi): where option writers and buyers are positioned, read for every trader on the desk. A verdict
// line and OI tiles, a mirrored OI ladder (calls left, puts right, the same neutral ink on both sides), walls with
// freshness, build-up translated into the underlying's direction, the biggest additions and unwinds, several
// expiries side by side, and a labelled slot for the owner's chart engine with its series prepared.
//
// Windows: Prev close uses the broker's oiChange; 5m / 15m / 30m / 1h / Since open use the snapshots this page
// records (oi-store.js). Everything is built once and patched on each 3 s refresh. The maths is in options.js (pure,
// tested); numbers become text through format.js only. Every reading is context, not a signal.
import { api, chartSlot, emptyState, errorState, h, icon, loadingState, modal, optional, table, toast } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";
import { oiStore, snapKey } from "./oi-store.js";
import { segmented } from "./views.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const WINDOW_IDS = O.OI_WINDOWS.map((w) => w[0]);
const WINDOW_NAME = Object.fromEntries(O.OI_WINDOWS);
const METRICS = [["oi", "OI"], ["chg", "OI chg"], ["vol", "Volume"]];
const BANDS = [["10", "±10"], ["20", "±20"], ["30", "±30"], ["all", "All"]];
const EXTRA_MAX = 3;
/** Extra expiries reload every 10th refresh tick (30 s at the desk's 3 s). */
const EXTRA_EVERY = 10;
const MQ_PHONE = "(max-width: 719px)";
const MQ_COARSE = "(pointer: coarse)";
const media = (q) => (typeof matchMedia === "function" ? matchMedia(q) : { matches: false });
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const EXPIRY_DAY = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const expiryText = (e) => (ISO_DAY.test(e ?? "") ? EXPIRY_DAY.format(new Date(`${e}T00:00:00Z`)) : e ?? "");
const SIDE = { ce: "CE", pe: "PE" };
const DISCLAIMER = "Shows position activity, not guaranteed direction.";

export const OI_DEFAULTS = Object.freeze({
  window: "prev",
  metric: "oi",
  band: "10",
  unit: "lots",
  scope: "one",
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
    extra,
    th: { minLots: clamp(t.minLots, 100000, 10), minOiPct: clamp(t.minOiPct, 100, 1), minPxPct: clamp(t.minPxPct, 100, 0.5) },
  };
}

/** A small control group: a select that looks like the desk's. */
function select(label, options, value, cls) {
  return h("select", { "aria-label": label, class: cls }, options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
}
/** A tile of the summary strip (built once; patched by setTile). */
function makeTile(label, cls) {
  const el = h("div", { class: `desk-stat ${cls ?? ""}`.trim(), role: "group", "aria-label": label }, h("span", { class: "label" }, label), h("span", { class: "value" }, DASH), h("span", { class: "sub" }, " "));
  return { el, label: el.children[0], value: el.children[1], sub: el.children[2], sig: "" };
}
const signedPct = (v, dp = 1) => (v === null ? DASH : `${formatSigned(v, dp)}%`);
/** "1 snapshot", "2 snapshots". */
const plural = (n, word) => `${formatInt(n)} ${word}${n === 1 ? "" : "s"}`;
const tagOf = (side, rank) => `${side === "ce" ? "R" : "S"}${rank}`;

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

  // ── Summary: verdict + tiles ──
  const verdictText = h("span", { class: "oi-verdict-text" }, "Reading the chain…");
  const verdictEl = h("p", { class: "oi-verdict" }, verdictText, h("span", { class: "oi-quiet" }, " Context, not advice."));
  const liveEl = h("p", { class: "sr-only", "aria-live": "polite" });
  const TILE_DEFS = [["spot", "Spot", "t-spot"], ["pcr", "PCR OI"], ["chg", "PCR OI chg"], ["vol", "PCR Vol", "t-vol"], ["mp", "Max Pain"], ["res", "Call wall"], ["sup", "Put wall"], ["win", "Window"]];
  const tiles = new Map(TILE_DEFS.map(([k, l, c]) => [k, makeTile(l, c)]));
  const tilesEl = h("div", { class: "desk-stats oi-tiles" }, [...tiles.values()].map((t) => t.el));
  /** Patch one tile. `sub` is text or a list of [class, text] parts (a class hides a part on some screens). */
  function setTile(key, { value = DASH, sub = "", title = "", cls = "", label = null }) {
    const t = tiles.get(key);
    const sig = JSON.stringify([value, sub, title, cls, label]);
    if (t.sig === sig) return;
    t.sig = sig;
    if (label) t.label.textContent = label;
    t.value.textContent = value;
    if (Array.isArray(sub)) t.sub.replaceChildren(...sub.map(([c, s]) => (c ? h("span", { class: c }, s) : s)));
    else t.sub.textContent = sub || " ";
    t.el.title = title;
    t.el.classList.toggle("warn", cls === "warn");
  }
  const summaryEl = h("section", { class: "desk-panel oi-summary", "data-panel": "oi-summary", "aria-label": "OI summary" }, verdictEl, liveEl, tilesEl);

  // ── Controls ──
  const winChips = h("div", { class: "segmented oi-win", role: "group", "aria-label": "Window" });
  const winBtns = new Map(
    O.OI_WINDOWS.map(([id, name]) => {
      const b = h("button", { type: "button", "data-value": id, "aria-pressed": "false" }, name);
      b.addEventListener("click", () => pickWindow(id, true));
      winChips.append(b);
      return [id, b];
    }),
  );
  const winSel = select("Window", O.OI_WINDOWS, cfg().window, "oi-win-sel");
  winSel.addEventListener("change", () => pickWindow(winSel.value, true));
  const metricSeg = segmented("Metric", METRICS, cfg().metric);
  metricSeg.classList.add("oi-metric");
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
  const expBtn = h("button", { type: "button", class: "small oi-exp-btn", onclick: () => expEl.scrollIntoView({ behavior: "smooth", block: "start" }) }, "Expiries");
  const helpBtn = h("button", { type: "button", class: "small oi-help-btn", "aria-label": "How to read this page", title: "How to read this page (?)", onclick: () => openHelp() }, "?");
  const atmBtn = h("button", { type: "button", class: "small oi-atm-btn", hidden: true, onclick: () => ladder.centre(true) }, "Back to ATM");
  const coverEl = h("span", { class: "oi-cover" });
  const controls = h(
    "div",
    { class: "oi-controls" },
    h("div", { class: "oi-ctl-row" }, winChips, winSel, metricSeg),
    h("div", { class: "oi-ctl-row" }, bandSel, unitSeg, scopeSeg, expBtn, atmBtn, helpBtn),
  );

  function setCfg(patch, recentre = false) {
    Object.assign(st.oi, patch);
    save();
    if (recentre) ladder.reset();
    if (lastX) draw(lastX);
  }
  function pickWindow(id, user) {
    const av = model?.avail?.get(id);
    if (av && !av.ok) {
      if (user) toast(av.reason);
      syncWindowControls();
      return;
    }
    setCfg({ window: id });
  }

  // ── Ladder ──
  const ladder = createLadder({
    detailFor: (strike) => detailLines(strike),
    onOpenChain: (strike, side) => openInChain(strike, side),
    onAtmVisible: (visible) => {
      if (atmBtn.hidden !== visible) atmBtn.hidden = visible;
    },
  });
  const keysEl = h(
    "div",
    { class: "desk-keys oi-keys" },
    [
      [["J", "K"], "strike"],
      [["↵"], "details"],
      [["G"], "ATM"],
      [["W"], "window"],
      [["M"], "metric"],
      [["[", "]"], "band"],
      [["U"], "lots / qty"],
      [["P"], "pause"],
      [["?"], "how to read"],
    ].map(([keys, t]) => h("span", { class: "kbd-pair" }, h("span", { class: "kbd-group" }, keys.map((k) => h("kbd", {}, k))), t)),
  );

  // ── Side blocks ──
  const wallsEl = h("div", { class: "oi-block oi-walls" });
  const buildEl = h("div", { class: "oi-block oi-build" });
  const moversEl = h("div", { class: "oi-block oi-movers" });
  const sideEl = h("div", { class: "oi-side" }, wallsEl, buildEl, moversEl);
  const ladderCol = h("div", { class: "oi-ladder-col" }, ladder.el, keysEl);
  const mainEl = h(
    "section",
    { class: "desk-panel oi-main", "data-panel": "oi-main", "aria-label": "OI by strike" },
    h("div", { class: "panel-head oi-head" }, h("div", { class: "oi-title" }, h("strong", {}, "OI by strike"), coverEl), controls),
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
  const slotLabel = slot.querySelector(".chart-slot-label");
  const coverageEl = h("p", { class: "oi-note" });
  const migrateEl = h("p", { class: "oi-note oi-migrate" });
  const timelineEl = h(
    "section",
    { class: "desk-panel oi-timeline", "data-panel": "oi-timeline", "aria-label": "OI over time" },
    h("div", { class: "panel-head oi-head" }, h("div", { class: "oi-title" }, h("strong", {}, "OI over time"), h("span", { class: "oi-cover" }, "From the snapshots this page records"))),
    slot,
    coverageEl,
    migrateEl,
  );

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
      if (extraList().length >= EXTRA_MAX) return toast(`Up to ${EXTRA_MAX} more expiries`);
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
        toast(`${WINDOW_NAME[win]} is not available here: showing ${WINDOW_NAME[fb]}`);
      }
      win = fb ?? (hasPrev ? "prev" : "open");
    }
    return { avail, win, hasPrev, combined, ref: avail.get(win) };
  }

  function draw(x) {
    lastX = x;
    syncControls();
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
    const spot = x.spot;
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
    const t = O.timeToExpiry(c.expiry, now);
    const expiryDay = O.isExpiryDay(c.expiry, now);
    const winLabel = w.ref?.ok ? WINDOW_NAME[w.win] : "Warming up";
    const refLabel = w.ref?.ok ? w.ref.label : "";
    const avail = w.avail;
    model = { avail, win: w.win, combined, lot, div, unit, rows, walls, wallMap, R1, S1, x, fq, fd, th, refLabel };

    // Verdict.
    const verdict = O.oiVerdict({ walls: { r1: R1?.strike, s1: S1?.strike }, pcr: pcrChain.oi, buildup: bu, maxPain: mp?.strike, relevance }) ?? "Not enough OI to read";
    if (verdictText.textContent !== verdict) verdictText.textContent = verdict;
    // The polite region speaks at most once a minute, but at once for a new underlying, expiry or scope.
    const ctx = `${c.underlying}|${c.expiry}|${combined ? "all" : "one"}`;
    if (ctx !== liveCtx) {
      liveCtx = ctx;
      liveAt = 0;
    }
    if (verdict !== liveText && now - liveAt >= 60_000) {
      liveText = verdict;
      liveAt = now;
      liveEl.textContent = verdict;
    }

    // Tiles.
    const scopeTxt = N === Infinity ? "All" : `±${N}`;
    setTile("spot", { value: formatFixed(spot, 2), sub: `ATM ${formatInt(atm)} · ${expiryDay ? "expiry today" : t.label}`, title: "Underlying LTP and the strike closest to it" });
    const bandWord = O.pcrBand(pcrChain.oi);
    const arrow = pcrChain.oi !== null && pcrRef !== null && Math.abs(pcrChain.oi - pcrRef) >= 0.005 ? (pcrChain.oi > pcrRef ? "\u00a0▲" : "\u00a0▼") : "";
    setTile("pcr", {
      // The trend arrow sits with the value (never orphaned or clipped at the end of the sub-line).
      value: `${formatFixed(pcrChain.oi, 2)}${arrow}`,
      sub: [["oi-wide", `${scopeTxt} ${formatFixed(pcrB.oi, 2)} · `], ["", `Vol ${formatFixed(pcrB.vol, 2)}`], ["", bandWord ? ` · ${bandWord.word}` : ""]],
      title: `Put OI ÷ call OI over the ${formatInt(rows.length)} strikes loaded. Writer view: high = put writing below (support), low = call writing above (cap). Context, not a signal.${arrow ? ` PCR ${formatFixed(pcrRef, 2)} ${refLabel}.` : ""}`,
    });
    const chg = pcrB.chg;
    setTile("chg", {
      value: !chg ? DASH : chg.kind === "ratio" ? formatFixed(chg.ratio, 2) : "n/a",
      sub: !chg ? "No OI chg in this window" : chg.kind === "ratio" ? `PE ${fd(chg.p)} · CE ${fd(chg.c)}` : chg.text,
      title: `Put OI chg ÷ call OI chg over the window (${winLabel}) and the band (${scopeTxt})${chg && chg.kind !== "ratio" ? `: PE ${fd(chg.p)} · CE ${fd(chg.c)} (${unit})` : ""}`,
    });
    setTile("vol", { value: formatFixed(pcrB.vol, 2), sub: `window ${winLabel}${expiryDay ? " · expiry-day noise" : ""}`, title: "Put volume ÷ call volume in the window. Noisy on expiry day." });
    const mpDist = mp && spot !== null ? mp.strike - spot : null;
    setTile("mp", {
      value: formatInt(mp?.strike),
      sub: mp ? `${formatSigned(mpDist, 0)} (${signedPct(mpDist === null ? null : (mpDist / spot) * 100, 2)}) · ${mp.edge ? "at range edge" : `${relevance} relevance`}` : "",
      cls: mp?.edge ? "warn" : "",
      title: mp ? `Settlement where option buyers collect the least, over ${formatInt(mp.n)} strikes ${formatInt(mp.lo)}–${formatInt(mp.hi)}. Matters mainly in the last 1–2 sessions (${formatInt(sessions)} left). Not a forecast.${mp.edge ? " At range edge: chain may be partial." : ""}` : "Not enough OI for max pain",
    });
    const wallSub = (v) => (v ? `${fq(v.oi)} · ${formatSigned(v.dist, 0)}${v.sigma !== null ? ` · ${formatFixed(v.sigma, 1)}σ` : ""}${v.fresh ? ` · ${v.fresh}` : ""}` : "");
    setTile("res", { value: formatInt(R1?.strike), sub: wallSub(R1), title: `Call strike at or above spot with the most OI (${unit})` });
    setTile("sup", { value: formatInt(S1?.strike), sub: wallSub(S1), title: `Put strike at or below spot with the most OI (${unit})` });
    const cov = coverage(snaps, session);
    setTile("win", {
      value: winLabel,
      sub: w.ref?.ok ? (w.win === "prev" ? "vs previous close" : `${refLabel} · ${plural(snaps.length, "snap")}`) : snaps.length ? `Recording since ${O.istHm(snaps[0].t)}` : session.phase !== "open" && !isDemo() ? "Market closed · last session" : "Recording starts now",
      title: `${cov}${store.persistent ? "" : " · Not saved: browser storage unavailable"}`,
    });

    // Head.
    const lo = rows[0]?.strike;
    const hi = rows[rows.length - 1]?.strike;
    const cover = `${formatInt(rows.length)} strikes · ${formatInt(lo)}–${formatInt(hi)} · ${unit}${combined ? ` · ${formatInt(chains.length)} expiries` : ""}`;
    if (coverEl.textContent !== cover) coverEl.textContent = cover;
    syncWindowControls();

    // Ladder.
    ladder.draw(ladderModel({ x, rows, inBand, atm, spot, mp, wallMap, combined, unit, fq, fd, winLabel }));

    drawWalls({ walls, rows, fq, fd, R1ref, S1ref, R1, S1, pin, unit, winLabel });
    drawBuildup(bu, { scopeTxt, winLabel, th, combined });
    drawMovers(movers, { fd, winLabel });
    drawExpiries(c, now);
    drawTimeline(key, snaps, session);
  }

  function coverage(snaps, session) {
    if (session.phase !== "open" && !isDemo()) return "Market closed · showing the last session";
    if (isDemo() && session.phase !== "open") return `Snapshots recorded off-hours${snaps.length ? ` · ${plural(snaps.length, "snapshot")} since ${O.istHm(snaps[0].t)}` : ""}`;
    return snaps.length ? `Recording since ${O.istHm(snaps[0].t)} · ${plural(snaps.length, "snapshot")} · every 1 min` : "Recording starts with the next update · every 1 min";
  }

  function ladderModel({ x, rows, inBand, atm, spot, mp, wallMap, combined, unit, fq, fd, winLabel }) {
    const metric = cfg().metric;
    const held = new Map();
    for (const r of x.c.rows) {
      for (const side of ["ce", "pe"]) {
        const l = r[side]?.symbol ? x.held.get(r[side].symbol) : null;
        if (l) held.set(`${r.strike}|${side}`, l);
      }
    }
    const em = x.em1 ?? {};
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
      const tags = [];
      if (mp && r.strike === mp.strike) tags.push({ t: "MP", cls: "mp", title: "Max Pain" });
      for (const s of ["ce", "pe"]) {
        const wt = wallMap[s].get(r.strike);
        if (wt) tags.push({ t: wt, cls: "wall", title: `${s === "ce" ? "Call" : "Put"} wall rank ${wt.slice(1)} (${s === "ce" ? "resistance" : "support"})` });
      }
      if (em.hi !== null && em.hi !== undefined && r.strike === em.hi) tags.push({ t: "+1σ", cls: "em", title: "Upper edge of the ±1σ expected move to expiry" });
      if (em.lo !== null && em.lo !== undefined && r.strike === em.lo) tags.push({ t: "−1σ", cls: "em", title: "Lower edge of the ±1σ expected move to expiry" });
      for (const s of ["ce", "pe"]) {
        const l = held.get(`${r.strike}|${s}`);
        if (l) tags.push({ t: `${l > 0 ? "+" : "−"}${formatNumberLots(Math.abs(l))}L`, cls: "held", title: `You hold ${l > 0 ? "+" : "−"}${formatNumberLots(Math.abs(l))} lots of ${formatInt(r.strike)} ${SIDE[s]}` });
      }
      const side = (s) => {
        const leg = r[s];
        if (!leg) return { val: null, ref: null, txt: DASH, dTxt: DASH, pTxt: "", bu: null, neg: false, wall: false, title: "" };
        const v = val(leg);
        // ΔOI bars carry no text: the Δ column beside them already prints the signed change.
        const shown = metric === "chg" ? "" : fq(metric === "oi" ? leg.oi : leg.v);
        const read = leg.cls ? O.BUILDUP_READ[s][leg.cls] : null;
        return {
          val: v,
          ref: metric === "oi" ? num(leg.oiRef) : null,
          txt: shown,
          dTxt: fd(leg.d),
          pTxt: leg.dPct === null ? (leg.d > 0 && leg.oiRef === 0 ? "new" : "") : signedPct(leg.dPct),
          bu: leg.cls,
          buTitle: leg.cls ? `${O.BUILDUP_NAMES[leg.cls]} on ${s === "ce" ? "calls" : "puts"} = ${read[0]}: ${read[1]}` : "",
          neg: metric === "chg" && leg.d < 0,
          wall: wallMap[s].get(r.strike) === tagOf(s, 1),
          title: `${formatInt(r.strike)} ${SIDE[s]} · OI ${fq(leg.oi)} (${unit}) · Δ ${fd(leg.d)} ${winLabel}`,
        };
      };
      return {
        strike: r.strike,
        inBand: inBand(i),
        atm: r.strike === atm,
        inEm: em.lo !== null && em.lo !== undefined && em.hi !== null && em.hi !== undefined && r.strike >= em.lo && r.strike <= em.hi,
        spotAbove: i === spotIdx && i > 0 ? `Spot ${formatFixed(spot, 2)}` : null,
        tags,
        ce: side("ce"),
        pe: side("pe"),
      };
    });
    return {
      key: `${x.c.underlying}|${x.c.expiry}|${combined ? "all" : "one"}|${rows.map((r) => r.strike).join(",")}|${metric}|${unit}`,
      caption: `Open interest by strike, ${winLabel}, ${unit}`,
      head: { ce: `Calls ${metricName}`, pe: `Puts ${metricName}`, unit },
      rows: out,
      metric,
      max,
      atm,
    };
  }

  function detailLines(strike) {
    const m = model;
    if (!m) return null;
    const r = m.rows.find((q) => q.strike === strike);
    if (!r) return null;
    const lines = ["ce", "pe"].map((s) => {
      const leg = r[s];
      if (!leg) return `${SIDE[s]} · not listed`;
      const held = m.x.c.rows.find((q) => q.strike === strike)?.[s]?.symbol;
      const lots = held ? m.x.held.get(held) : null;
      const read = leg.cls ? O.BUILDUP_READ[s][leg.cls] : null;
      const parts = [
        `${SIDE[s]} · OI ${m.fq(leg.oiRef)} → ${m.fq(leg.oi)} (${m.fd(leg.d)}${leg.dPct !== null ? `, ${signedPct(leg.dPct)}` : leg.d > 0 && leg.oiRef === 0 ? ", new" : ""})`,
        leg.ltp !== null ? `LTP ${formatFixed(leg.ltp, 2)}${leg.dLtp !== null ? ` (${formatSigned(leg.dLtp, 2)})` : ""}` : null,
        leg.v !== null ? `Vol ${m.fq(leg.v)}` : null,
        read ? `${leg.cls} → ${read[1]}` : null,
        lots ? `held ${lots > 0 ? "+" : "−"}${formatNumberLots(Math.abs(lots))}L` : null,
      ];
      return parts.filter(Boolean).join(" · ");
    });
    return { lines, unit: m.unit, window: m.refLabel || WINDOW_NAME[m.win] };
  }

  // ── Walls ──
  function drawWalls({ walls, rows, fq, fd, R1ref, S1ref, R1, S1, pin, unit, winLabel }) {
    const fwC = O.freshWall(rows, "ce");
    const fwP = O.freshWall(rows, "pe");
    const shift = (now, ref) => (now && ref !== null && now.strike !== ref ? `${now.strike > ref ? "↑" : "↓"} from ${formatInt(ref)}` : "");
    const sideRows = (list, s) =>
      list.map((v) => [
        tagOf(s, v.rank),
        formatInt(v.strike),
        fq(v.oi),
        fd(v.d),
        v.share === null ? DASH : `${formatFixed(v.share * 100, 0)}%`,
        [formatSigned(v.dist, 0), v.sigma !== null ? ` · ${formatFixed(v.sigma, 1)}σ` : ""],
        [v.strong, v.fresh ?? ""],
        v.strength === null ? "" : `${formatFixed(v.strength, 1)}× the band's average ${s === "ce" ? "call" : "put"} OI`,
      ]);
    const data = {
      ce: sideRows(walls.ce, "ce"),
      pe: sideRows(walls.pe, "pe"),
      shiftC: shift(R1, R1ref),
      shiftP: shift(S1, S1ref),
      fresh: [fwC ? `${formatInt(fwC.strike)} CE ${fd(fwC.d)}` : null, fwP ? `${formatInt(fwP.strike)} PE ${fd(fwP.d)}` : null].filter(Boolean).join(" · "),
      pin: pin ? `Pin zone ${formatInt(pin.lo)}–${formatInt(pin.hi)}: ${formatFixed(pin.share * 100, 0)}% of OI` : "",
      unit,
      winLabel,
    };
    const sig = JSON.stringify(data);
    if (wallsEl.__sig === sig) return;
    wallsEl.__sig = sig;
    // "strong · fresh": on a phone the word "strong" gives way to bold, so the tag stays on one line.
    const wallTag = ([strong, fresh], title) =>
      h("td", { class: `oi-tag${strong ? " strong" : ""}`, title: strong ? `Strong wall: ${title}` : title }, ...[strong ? (fresh ? h("span", { class: "oi-strong" }, "strong · ") : "strong") : null, fresh].filter(Boolean));
    const mini = (title, list, shiftTxt) =>
      h(
        "table",
        { class: "oi-mini" },
        h("caption", {}, h("span", {}, title), shiftTxt ? h("span", { class: "oi-shift", title: `Rank-1 wall at the window start (${winLabel})` }, shiftTxt) : null),
        h("thead", {}, h("tr", {}, ["", "Strike", `OI`, "Δ", "Share", "Dist", ""].map((t, i) => h("th", { scope: "col", class: i >= 2 && i <= 5 ? `num${i === 4 ? " oi-share" : ""}` : undefined }, t)))),
        h(
          "tbody",
          {},
          list.length
            ? list.map((r) => h("tr", {}, h("td", { class: "oi-rank" }, r[0]), h("th", { scope: "row" }, r[1]), h("td", { class: "num" }, r[2]), h("td", { class: "num" }, r[3]), h("td", { class: "num oi-share" }, r[4]), h("td", { class: "num" }, r[5][0], r[5][1] ? h("span", { class: "oi-sig" }, r[5][1]) : null), wallTag(r[6], r[7])))
            : h("tr", {}, h("td", { colspan: "7", class: "oi-none" }, "No OI on this side of spot")),
        ),
      );
    wallsEl.replaceChildren(
      h("h3", { class: "oi-block-head" }, "Walls", h("small", {}, `OI in ${unit} · Δ ${winLabel}`)),
      mini("Calls · call walls", data.ce, data.shiftC),
      mini("Puts · put walls", data.pe, data.shiftP),
      ...[data.fresh ? h("p", { class: "oi-foot" }, `Most added: ${data.fresh}`) : null, data.pin ? h("p", { class: "oi-foot", title: "OI on the 3 strikes nearest spot ÷ all OI: the higher, the stronger the pull to pin near expiry" }, data.pin) : null].filter(Boolean),
    );
  }

  // ── Build-up ──
  function drawBuildup(bu, { scopeTxt, winLabel, th, combined }) {
    const COLS = ["LB", "SB", "SC", "LU", "CH"];
    const cell = (s, k) => [bu[s][k].n, formatCompact(bu[s][k].lots), bu[s].dom === k];
    const word = (s) => (bu[s].dom ? `${bu[s].dom} dominant → ${O.BUILDUP_READ[s][bu[s].dom][1]}` : "nothing dominant");
    const data = { ce: COLS.map((k) => cell("ce", k)), pe: COLS.map((k) => cell("pe", k)), tone: bu.tone, text: bu.text, empty: bu.empty, line: `Calls: ${word("ce")} · Puts: ${word("pe")}`, scopeTxt, winLabel, th, combined };
    const sig = JSON.stringify(data);
    if (buildEl.__sig === sig) return;
    buildEl.__sig = sig;
    if (combined) {
      // Combined OI has no price change, so no strike can be classed: say so and offer the per-expiry view.
      buildEl.replaceChildren(
        h("h3", { class: "oi-block-head" }, "Build-up", h("small", {}, "Combined")),
        h("p", { class: "oi-foot muted" }, "Combined OI carries no price change, so build-up is read per expiry."),
        h("button", { type: "button", class: "link-btn oi-filter", onclick: () => setCfg({ scope: "one" }, true) }, "Show this expiry"),
      );
      return;
    }
    const glyph = bu.tone === "up" ? "▲" : bu.tone === "down" ? "▼" : "↔";
    const head = (k) =>
      h(
        "th",
        { scope: "col", title: k === "CH" ? "Churn: heavy volume, but OI or price barely moved. No direction." : `${O.BUILDUP_NAMES[k]}. On calls = ${O.BUILDUP_READ.ce[k].join(": ")}. On puts = ${O.BUILDUP_READ.pe[k].join(": ")}.` },
        k === "CH" ? "Churn" : k,
      );
    const row = (s, label) => h("tr", {}, h("th", { scope: "row" }, label), data[s].map(([n, lots, dom]) => h("td", { class: dom ? "dom" : undefined }, h("strong", {}, formatInt(n)), h("small", {}, lots))));
    const filterBtn = h("button", { type: "button", class: "link-btn oi-filter", title: "Edit the noise filter", onclick: () => openHelp(true) }, `Filter: ${formatInt(th.minLots)} lots · ${formatFixed(th.minOiPct, 1)}% OI · ${formatFixed(th.minPxPct, 1)}% price`);
    buildEl.replaceChildren(
      h("h3", { class: "oi-block-head" }, "Build-up", h("small", {}, `${scopeTxt} · ${winLabel} · strikes · lots`)),
      h("table", { class: "oi-matrix" }, h("thead", {}, h("tr", {}, h("td", {}), COLS.map(head))), h("tbody", {}, row("ce", "Calls"), row("pe", "Puts"))),
      h("p", { class: "oi-foot" }, data.line),
      h("p", { class: `oi-tone tone-${bu.tone}` }, h("span", { "aria-hidden": "true" }, glyph), ` ${bu.text}`),
      ...[bu.empty ? h("p", { class: "oi-foot muted" }, "No strike passed the noise filter in this window: try a longer window or a wider band.") : null].filter(Boolean),
      filterBtn,
    );
  }

  // ── Movers ──
  function drawMovers(movers, { fd, winLabel }) {
    const line = (m) => [
      `${formatInt(m.strike)} ${SIDE[m.side]}`,
      `${fd(m.d)} (${m.dPct === null ? "new" : signedPct(m.dPct, 0)})`,
      m.dLtp === null ? "" : `LTP ${formatSigned(m.dLtp, 1)}`,
      m.cls ? `${m.cls} · ${O.BUILDUP_READ[m.side][m.cls][1]}` : "",
      m.wall ?? "",
    ];
    const data = { adds: movers.adds.map(line), unwinds: movers.unwinds.map(line), winLabel, tab: moverTab };
    const sig = JSON.stringify(data);
    if (moversEl.__sig === sig) return;
    moversEl.__sig = sig;
    const list = (title, items, cls) =>
      h(
        "div",
        { class: `oi-mlist ${cls}${moverTab === cls ? " on" : ""}` },
        h("h4", {}, title),
        items.length
          ? h("ol", {}, items.map((it) => h("li", {}, h("span", { class: "m-k" }, it[0]), h("span", { class: "m-d" }, it[1]), h("span", { class: "m-sub" }, ...[it[2] ? h("span", { class: "m-p" }, it[2]) : null, it[3] ? h("span", { class: "m-c" }, it[3]) : null, it[4] ? h("span", { class: "m-w", title: it[0].endsWith("CE") ? "A call wall: unwinding here is the breakout cue" : "A put wall: unwinding here is the breakdown cue" }, `wall ${it[4]}`) : null].filter(Boolean)))))
          : h("p", { class: "oi-none" }, cls === "adds" ? "No additions in this window" : "No unwinding in this window"),
      );
    const seg = segmented("Movers", [["adds", "Adds"], ["unwinds", "Unwinds"]], moverTab);
    seg.classList.add("oi-mseg");
    seg.addEventListener("change", () => {
      moverTab = seg.value;
      moversEl.__sig = "";
      drawMovers(movers, { fd, winLabel });
      moversEl.querySelector(".oi-mseg button[aria-pressed=true]")?.focus();
    });
    moversEl.replaceChildren(h("h3", { class: "oi-block-head" }, "Movers", h("small", {}, `Top 5 · ${winLabel} · all strikes`)), seg, h("div", { class: "oi-mlists" }, list("Biggest additions", data.adds, "adds"), list("Biggest unwinds", data.unwinds, "unwinds")));
  }

  // ── Expiries ──
  function drawExpiries(c, now) {
    const included = new Set(extraList());
    const rowsFor = [c.expiry, ...st.expiries.filter((e) => e !== c.expiry)];
    const stats = new Map(O.cumulativeOi([c, ...[...included].map((e) => extras.get(e)?.chain).filter(Boolean)], now).perExpiry.map((p) => [p.expiry, p]));
    const data = rowsFor.map((e) => {
      const p = stats.get(e);
      const ex = extras.get(e);
      return { e, main: e === c.expiry, on: e === c.expiry || included.has(e), p: p ? [p.dte, formatInt(p.lot), formatCompact(p.ceOi), formatCompact(p.peOi), formatFixed(p.pcr, 2), `${formatInt(p.maxPain)}${p.edge ? " (edge)" : ""}`, formatInt(p.s1), formatInt(p.r1)] : null, err: Boolean(ex?.error), loading: Boolean(ex?.loading) && !ex?.chain, monthly: O.isMonthlyExpiry(e, st.expiries) };
    });
    const sig = JSON.stringify(data);
    if (expBody.__sig === sig) return;
    expBody.__sig = sig;
    const columns = [
      { label: "Expiry", cell: (d) => h("strong", {}, `${expiryText(d.e)}${d.monthly ? " · M" : ""}`) },
      {
        label: "Include",
        cell: (d) =>
          h("input", {
            type: "checkbox",
            class: "oi-inc",
            checked: d.on,
            disabled: d.main || (!d.on && included.size >= EXTRA_MAX),
            "aria-label": d.main ? `${expiryText(d.e)}: the toolbar expiry` : `Include ${expiryText(d.e)}`,
            title: d.main ? "The toolbar expiry is always included" : !d.on && included.size >= EXTRA_MAX ? `Up to ${EXTRA_MAX} more expiries` : "",
            onchange: (ev) => toggleExtra(d.e, ev.target.checked),
          }),
      },
      { label: "DTE", cell: (d) => (d.p ? d.p[0] : status(d)) },
      { label: "Lot", num: true, cell: (d) => d.p?.[1] ?? DASH },
      { label: "CE OI", num: true, cell: (d) => d.p?.[2] ?? DASH },
      { label: "PE OI", num: true, cell: (d) => d.p?.[3] ?? DASH },
      { label: "PCR", num: true, cell: (d) => d.p?.[4] ?? DASH },
      { label: "Max Pain", num: true, cell: (d) => d.p?.[5] ?? DASH },
      { label: "Put wall", num: true, cell: (d) => d.p?.[6] ?? DASH },
      { label: "Call wall", num: true, cell: (d) => d.p?.[7] ?? DASH },
    ];
    function status(d) {
      if (!d.on) return h("span", { class: "muted" }, "Not included");
      if (d.err) return h("span", { class: "oi-err" }, "Not loaded ", h("button", { type: "button", class: "icon-btn small-x", "aria-label": `Retry ${expiryText(d.e)}`, title: "Retry", onclick: () => loadExtra(d.e) }, icon("refresh")));
      return h("span", { class: "muted" }, "Loading…");
    }
    const n = 1 + extraList().filter((e) => extras.get(e)?.chain).length;
    const t = table(columns, data, emptyState("clock", "No expiries listed", "", null, { compact: true }), { mobile: "stack", caption: `${st.underlying} expiries side by side` });
    t.classList.add("oi-exp-table");
    // Phone: one compact card per expiry (an included expiry shows its figures; the others one line).
    const FIG = ["DTE", "Lot", "CE OI", "PE OI", "PCR", "Max Pain", "Put wall", "Call wall"];
    const cards = h(
      "ul",
      { class: "oi-exp-cards" },
      data.map((d) =>
        h(
          "li",
          { class: d.on ? "on" : undefined },
          h("label", { class: "oi-exp-card-head" }, columns[1].cell(d), h("strong", {}, `${expiryText(d.e)}${d.monthly ? " · M" : ""}`), d.p ? h("span", { class: "muted" }, d.p[0]) : h("span", { class: "muted" }, status(d))),
          d.p ? h("dl", {}, FIG.slice(1).map((l, i) => h("div", {}, h("dt", {}, l), h("dd", {}, d.p[i + 1])))) : null,
        ),
      ),
    );
    expBody.replaceChildren(t, cards);
    const allBtn = scopeSeg.querySelector('[data-value="all"]');
    if (allBtn) allBtn.textContent = `Combined (${formatInt(n)})`;
  }

  // ── Timeline ──
  function drawTimeline(key, snaps, session) {
    const sig = `${key}|${snaps.length}|${snaps[snaps.length - 1]?.t ?? 0}`;
    if (seriesCache.sig !== sig) seriesCache = { sig, data: O.oiSeries(snaps) };
    const n = seriesCache.data.length;
    const label = `Call OI, Put OI, PCR, Max Pain and spot vs time (${plural(n, "point")} ready)`;
    if (slotLabel.textContent !== label) {
      slotLabel.textContent = label;
      slot.setAttribute("aria-label", `Chart engine slot: ${label}`);
    }
    const cov = `${coverage(snaps, session)}${store.persistent ? "" : " · Not saved: browser storage unavailable"}`;
    if (coverageEl.textContent !== cov) coverageEl.textContent = cov;
    const mig = O.wallMigrationText(seriesCache.data) ?? "Wall migration appears once snapshots are recorded";
    if (migrateEl.textContent !== mig) migrateEl.textContent = mig;
  }

  // ── States ──
  function drawEmpty() {
    model = null;
    mainEl.classList.add("oi-msg");
    for (const [k] of tiles) setTile(k, {});
    const msg = st.error ? "Not updating" : st.empty ? "No expiries" : "Reading the chain…";
    if (verdictText.textContent !== msg) verdictText.textContent = msg;
    coverEl.textContent = "";
    if (st.error) {
      ladder.message(errorState(st.error, { onRetry: () => retry() }));
    } else if (st.empty) ladder.message(emptyState("clock", "No expiries", st.empty, null, { compact: true }));
    else ladder.message(loadingState({ rows: 12, cols: 5, label: `Loading the ${st.underlying} ${expiryText(st.expiry)} chain` }));
    for (const el of [wallsEl, buildEl, moversEl, expBody]) {
      el.__sig = "";
      el.replaceChildren();
    }
  }
  function drawNoOi(c) {
    model = null;
    mainEl.classList.add("oi-msg");
    for (const [k] of tiles) setTile(k, {});
    verdictText.textContent = "No open interest to read";
    ladder.message(emptyState("chart", "No open interest yet", `The broker returned no OI for ${c.underlying} ${expiryText(c.expiry)}. It usually appears after the first trades of the day.`, null, { compact: true }));
    for (const el of [wallsEl, buildEl, moversEl]) {
      el.__sig = "";
      el.replaceChildren();
    }
  }

  // ── Controls state ──
  function syncControls() {
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
      b.setAttribute("aria-pressed", String(id === win));
      b.tabIndex = id === win ? 0 : -1;
      if (off) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
      const title = off ? a.reason : a?.label ? `${WINDOW_NAME[id]}: ${a.label}` : WINDOW_NAME[id];
      if (b.title !== title) b.title = title;
    }
    for (const o of winSel.options) {
      const a = model?.avail?.get(o.value);
      o.disabled = Boolean(a && !a.ok);
      o.title = a && !a.ok ? a.reason : "";
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
    const buRows = ["LB", "SB", "SC", "LU"].map((k) => h("tr", {}, h("th", { scope: "row" }, `${k} · ${O.BUILDUP_NAMES[k]}`), h("td", {}, O.BUILDUP_READ.ce[k].join(": ")), h("td", {}, O.BUILDUP_READ.pe[k].join(": "))));
    const body = h(
      "div",
      { class: "oi-help" },
      h("p", { class: "oi-help-lead" }, `${DISCLAIMER} Every figure states its window, strike band and coverage.`),
      h("h3", {}, "Tiles"),
      h(
        "dl",
        { class: "oi-help-dl" },
        [
          ["PCR OI", "Put OI ÷ call OI over every strike loaded; the sub-line gives the band and volume PCR."],
          ["PCR OI chg", "Put OI chg ÷ call OI chg over the window and band. When one side unwinds while the other adds, it says so instead of printing a ratio."],
          ["PCR Vol", "Put volume ÷ call volume in the window. Noisy on expiry day."],
          ["Max Pain", "The settlement at which option buyers collect the least. It matters mainly in the last 1–2 sessions; at the range edge the chain may be partial. Not a forecast."],
          ["Call wall / Put wall", "The call strike at or above spot (put strike at or below) with the most OI, with its distance in points and in σ of the expected move, and whether it is being added to (fresh) or unwound."],
          ["Window", "What Δ is measured against: the previous close (from the broker) or a snapshot this page recorded 5, 15, 30 or 60 minutes ago, or at the open."],
        ].map(([t, d]) => [h("dt", {}, t), h("dd", {}, d)]),
      ),
      h("h3", {}, "Build-up and direction"),
      h("p", {}, "The same build-up means opposite things on calls and puts. Long build-up on puts is put buying: bearish for the underlying."),
      h("table", { class: "oi-help-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Class"), h("th", { scope: "col" }, "On calls"), h("th", { scope: "col" }, "On puts"))), h("tbody", {}, buRows)),
      h("h3", {}, "Two ways to read PCR"),
      h("p", {}, "India, writer view (this page): most index option OI is written by sellers, so heavy put OI means put writing below spot (support) and low PCR means call writing above (a cap). US, contrarian view: PCR measures buyers' hedging, so a high PCR reads as fear. This page uses the writer view because Indian index options are seller-dominated. Bands: ≥ 1.5 very put-heavy, ≥ 1.2 put-heavy, above 0.8 balanced, above 0.6 call-heavy, else very call-heavy."),
      h("h3", {}, "Units"),
      h("p", {}, "NSE publishes OI in contracts (lots); brokers show quantity (lots × lot size). Lots is the default; Combined across expiries is always in lots, because lot sizes differ by expiry."),
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
      if (cfg().scope === "all" && extraList().length) return toast("Combined OI is in lots: lot sizes differ by expiry"), true;
      return setCfg({ unit: cfg().unit === "lots" ? "qty" : "lots" }), true;
    }
    if (k === "j" || k === "ArrowDown") return ladder.move(1) || k === "j";
    if (k === "k" || k === "ArrowUp") return ladder.move(-1) || k === "k";
    if (k === "g" || k === "Home") return ladder.centre(true, true), true;
    if (k === "Enter") {
      if (e.target instanceof Element && e.target.closest("button, a, summary, input, select")) return false;
      return ladder.toggle(), true;
    }
    if (k === "Escape") return ladder.close();
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
      ladder.reset();
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

/** Lots held, without trailing zeros (2, 1.5). */
function formatNumberLots(v) {
  return Number.isInteger(v) ? formatInt(v) : formatFixed(v, 2).replace(/0$/, "");
}

// ── The ladder: a mirrored table, built once per (underlying, expiry, scope, strikes, metric, unit), patched after ──
let uid = 0;
function createLadder({ detailFor, onOpenChain, onAtmVisible }) {
  const wrap = h("div", { class: "oi-ladder-wrap" });
  const el = h("div", { class: "oi-ladder-host" }, wrap);
  let built = null;
  let sel = null;
  let open = null;
  let needCentre = true;
  let atm = null;
  const coarse = () => media(MQ_COARSE).matches;
  const phone = () => media(MQ_PHONE).matches;

  function barCell(side) {
    const ghost = h("span", { class: "ghost" });
    const now = h("span", { class: "now" });
    const mark = h("span", { class: "mark" });
    const v = h("span", { class: "v" });
    return { td: h("td", { class: `ob ${side}` }, h("span", { class: "trk", "aria-hidden": "true" }, ghost, now, mark), v), ghost, now, mark, v, sig: "" };
  }
  function dCell(side) {
    const val = h("span", { class: "dv" });
    const pct = h("small", { class: "dp" });
    const bu = h("span", { class: "obu" });
    return { td: h("td", { class: `d ${side}` }, h("span", { class: "dwrap" }, val, h("span", { class: "dsub" }, pct, bu))), val, pct, bu, sig: "" };
  }
  function build(m) {
    const caption = h("caption", { class: "sr-only" }, m.caption);
    const hce = h("span", {});
    const hpe = h("span", {});
    const head = h("tr", {}, h("th", { scope: "col", class: "d ce" }, "OI chg"), h("th", { scope: "col", class: "ob ce" }, hce), h("th", { scope: "col", class: "k" }, "Strike"), h("th", { scope: "col", class: "ob pe" }, hpe), h("th", { scope: "col", class: "d pe" }, "OI chg"));
    const tbody = h("tbody");
    const rows = new Map();
    for (const r of m.rows) {
      const cd = dCell("ce");
      const cb = barCell("ce");
      const pb = barCell("pe");
      const pd = dCell("pe");
      const tags = h("span", { class: "tags" });
      const th = h("th", { scope: "row", class: "k" }, h("span", { class: "kv" }, formatInt(r.strike)), tags);
      const tr = h("tr", { tabindex: "-1", "aria-selected": "false", "aria-expanded": "false", "data-k": String(r.strike) }, cd.td, cb.td, th, pb.td, pd.td);
      tbody.append(tr);
      rows.set(r.strike, { tr, th, tags, ce: { d: cd, b: cb }, pe: { d: pd, b: pb }, sig: "", tagSig: "" });
    }
    const detail = h("tr", { class: "oi-detail", id: `oi-detail-${++uid}`, hidden: true }, h("td", { colspan: "5" }));
    const tbl = h("table", { class: "oi-ladder" }, caption, h("thead", {}, head), tbody);
    tbl.classList.toggle("m-chg", m.metric === "chg");
    tbody.addEventListener("click", onClick);
    const hadFocus = wrap.contains(document.activeElement) && document.activeElement?.matches?.("tr[data-k]");
    wrap.replaceChildren(tbl);
    built = { key: m.key, caption, hce, hpe, tbody, rows, detail, max: 0 };
    if (sel !== null && !rows.has(sel)) sel = null;
    if (open !== null && !rows.has(open)) open = null;
    // A rebuild (metric, unit, strikes) keeps the selection: mark it again, keep it tabbable and keep focus on it.
    // The scroll position carries over (same strikes, same row height); a fresh ladder centres on ATM.
    if (sel !== null) select(sel, false, hadFocus);
    else needCentre = true;
  }
  function onClick(e) {
    if (e.target.closest("a, button")) return;
    const tr = e.target.closest("tr[data-k]");
    if (!tr) return;
    const k = Number(tr.dataset.k);
    if (coarse()) {
      select(k, false);
      toggle(k);
    } else if (sel === k) toggle(k);
    else select(k, false);
  }
  function select(k, scroll = true, focus = true) {
    sel = k;
    for (const [s, b] of built.rows) {
      const on = s === k;
      if ((b.tr.getAttribute("aria-selected") === "true") !== on) b.tr.setAttribute("aria-selected", String(on));
      const ti = on ? 0 : -1;
      if (b.tr.tabIndex !== ti) b.tr.tabIndex = ti;
    }
    const b = built.rows.get(k);
    if (!b) return;
    if (focus) b.tr.focus({ preventScroll: true });
    if (scroll) into(b.tr);
  }
  /** Bring a row into view in the ladder and in the window (scroll-margin keeps it clear of the sticky header). */
  function into(tr) {
    tr.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function toggle(k = sel ?? atm) {
    if (!built || k === null || k === undefined) return;
    if (open === k) return close();
    open = k;
    if (sel !== k) select(k, false);
    paintDetail();
    into(built.detail);
  }
  function close() {
    if (open === null || !built) return false;
    const b = built.rows.get(open);
    b?.tr.setAttribute("aria-expanded", "false");
    b?.tr.removeAttribute("aria-controls");
    open = null;
    built.detail.hidden = true;
    return true;
  }
  function paintDetail() {
    if (!built || open === null) return;
    const b = built.rows.get(open);
    const info = detailFor(open);
    if (!b || !info || b.tr.hidden) return close();
    for (const [, r] of built.rows) if (r.tr.getAttribute("aria-expanded") === "true" && r !== b) r.tr.setAttribute("aria-expanded", "false");
    b.tr.setAttribute("aria-expanded", "true");
    b.tr.setAttribute("aria-controls", built.detail.id);
    const td = built.detail.firstChild;
    const sig = JSON.stringify([open, info]);
    if (td.__sig !== sig) {
      td.__sig = sig;
      const k = open;
      td.replaceChildren(
        h("div", { class: "oi-dl" }, info.lines.map((l) => h("p", {}, l)), h("p", { class: "muted" }, `${info.window} · OI in ${info.unit}`)),
        h("button", { type: "button", class: "link-btn", onclick: () => onOpenChain(k, "ce") }, "Open in chain →"),
      );
    }
    if (b.tr.nextSibling !== built.detail) b.tr.after(built.detail);
    built.detail.hidden = false;
  }
  function centre(focusRow = false, smooth = false) {
    if (!built || atm === null) return;
    const b = built.rows.get(atm);
    if (!b) return;
    const top = b.tr.offsetTop - wrap.clientHeight / 2 + b.tr.offsetHeight / 2;
    if (smooth && typeof wrap.scrollTo === "function") wrap.scrollTo({ top, behavior: "smooth" });
    else wrap.scrollTop = top;
    if (focusRow) select(atm, false);
  }
  let rafPending = false;
  function scheduleAtmCheck() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      checkAtm();
    });
  }
  wrap.addEventListener("scroll", scheduleAtmCheck);
  function checkAtm() {
    if (!built || atm === null) return onAtmVisible(true);
    const b = built.rows.get(atm);
    if (!b) return onAtmVisible(true);
    const head = wrap.querySelector("thead")?.offsetHeight ?? 0;
    const top = b.tr.offsetTop;
    const vis = top + b.tr.offsetHeight > wrap.scrollTop + head && top < wrap.scrollTop + wrap.clientHeight;
    onAtmVisible(vis);
  }
  const scale = (f) => `scaleX(${Math.round(Math.max(0, Math.min(1, f)) * 1000) / 1000})`;
  function draw(m) {
    if (!built || built.key !== m.key || !wrap.querySelector("table")) build(m);
    atm = m.atm;
    if (built.caption.textContent !== m.caption) built.caption.textContent = m.caption;
    const hc = `${m.head.ce} (${m.head.unit})`;
    const hp = `${m.head.pe} (${m.head.unit})`;
    if (built.hce.textContent !== hc) built.hce.textContent = hc;
    if (built.hpe.textContent !== hp) built.hpe.textContent = hp;
    // Rescale only on a 10% change in the largest value, so bars do not jitter every tick.
    if (!built.max || Math.abs(m.max - built.max) > built.max * 0.1) built.max = m.max || 1;
    const max = built.max;
    for (const r of m.rows) {
      const b = built.rows.get(r.strike);
      if (!b) continue;
      if (b.tr.hidden === r.inBand) b.tr.hidden = !r.inBand;
      const rowSig = `${r.atm}|${r.inEm}|${r.spotAbove}`;
      if (b.sig !== rowSig) {
        b.sig = rowSig;
        b.tr.classList.toggle("atm", r.atm);
        b.tr.classList.toggle("in-em", r.inEm);
        b.tr.classList.toggle("spot-above", Boolean(r.spotAbove));
        if (r.spotAbove) b.th.setAttribute("data-spot", r.spotAbove);
        else b.th.removeAttribute("data-spot");
      }
      const tagSig = JSON.stringify(r.tags);
      if (b.tagSig !== tagSig) {
        b.tagSig = tagSig;
        b.tags.replaceChildren(...r.tags.map((t) => h("span", { class: `tag ${t.cls}`, title: t.title }, t.t)));
        b.th.title = r.tags.map((t) => t.title).join(" · ");
      }
      for (const s of ["ce", "pe"]) {
        const q = r[s];
        const bc = b[s].b;
        const sig = `${q.val}|${q.ref}|${q.txt}|${q.neg}|${q.wall}|${max}`;
        if (bc.sig !== sig) {
          bc.sig = sig;
          bc.now.style.transform = scale((q.val ?? 0) / max);
          bc.now.classList.toggle("neg", q.neg);
          bc.td.classList.toggle("wall", q.wall);
          const ref = q.ref ?? 0;
          const fr = Math.max(0, Math.min(1, ref / max));
          bc.mark.style.width = `${Math.round(fr * 1000) / 10}%`;
          bc.mark.hidden = q.ref === null;
          bc.ghost.style.width = `${Math.round(fr * 1000) / 10}%`;
          bc.ghost.hidden = !(q.ref !== null && ref > (q.val ?? 0));
          bc.v.textContent = q.txt;
          bc.td.title = q.title;
        }
        const dc = b[s].d;
        const dsig = `${q.dTxt}|${q.pTxt}|${q.bu}`;
        if (dc.sig !== dsig) {
          dc.sig = dsig;
          dc.val.textContent = q.dTxt;
          dc.pct.textContent = q.pTxt;
          dc.bu.textContent = q.bu ?? "";
          dc.bu.hidden = !q.bu;
          dc.bu.title = q.buTitle ?? "";
          dc.bu.className = `obu${q.bu ? ` obu-${q.bu}` : ""}`;
        }
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
    // Reading row positions forces a layout: do it after the frame paints, not inside the refresh.
    scheduleAtmCheck();
  }
  function move(d) {
    if (!built) return false;
    const vis = [...built.rows.entries()].filter(([, b]) => !b.tr.hidden).map(([k]) => k);
    if (!vis.length) return false;
    const i = vis.indexOf(sel ?? atm);
    const j = Math.max(0, Math.min(vis.length - 1, (i < 0 ? vis.indexOf(atm) : i) + d));
    select(vis[j < 0 ? 0 : j]);
    return true;
  }
  return {
    el,
    draw,
    move,
    toggle: () => toggle(),
    close,
    centre,
    reset() {
      built = null;
      sel = null;
      open = null;
      needCentre = true;
    },
    message(node) {
      built = null;
      needCentre = true;
      wrap.replaceChildren(node);
      onAtmVisible(true);
    },
    phone,
  };
}
