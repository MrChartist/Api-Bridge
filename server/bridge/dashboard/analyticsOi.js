// Markets › OI Analysis › OI change, Spurts, PCR and Max pain, and Analytics › Exposure › OI heatmap, drawn in the
// analytics host (analytics.js). Every view reads the Bridge recorder's day for the chain in the top bar
// (GET /v1/options/snapshots: what it recorded, gaps never filled) once, keeps it for 30 s, and tops it up every
// minute while the view is open. While the market is open the chain's own quotes (the shared stream, quote mode) are
// laid over the newest recorded minute as a live reading: a tick only updates a map, and the view is patched in place
// at most every 2.5 s. Replay steps or plays through the recorded readings (never remembered); OI change, Spurts and
// the heatmap also take a custom From–To window. The maths is in oi-suite-core.js (pure, tested); this file only draws.
//
// Each view leads with one reading (a hero panel: the word, one sentence, three or four figures) and puts its window
// in the hero's head as a capsule; everything optional sits behind Customise. Direction is always coloured
// (--pos / --neg), the side by its hue (calls blue, puts orange); details are on hover, not printed.
import { api, app, emptyState, h, icon, pill, sheetPopover } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";
import { niceScale, s, svgRoot, tickDecimals } from "./analyticsViews.js";
import { heatmapTable } from "./analyticsFlow.js";
import { istClock, marketSession, maxPainRelevance, pcrBand } from "./options.js";
import { watch } from "./live.js";
import { spotSymbolOf } from "./alert-core.js";
import { workspace } from "./workspace.js";
import * as C from "./oi-suite-core.js";

// ───────────────────────── shared ─────────────────────────

const PREFS_KEY = "mcb.dashboard.oix";
const DEFAULTS = Object.freeze({ win: "15", bar: "20", legs: "both", each: "10", pcrEach: "20", step: "30", lead: "oi", colour: "buildup", side: "both", hmMode: "day", from: "09:15", to: "15:30", hmWin: "all", spcr: "near" });
/** This browser's choices for these views (a convenience: a blocked store just means the defaults). */
function prefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return { ...DEFAULTS, ...(v && typeof v === "object" ? v : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}
function savePref(k, v) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), [k]: v }));
  } catch {
    /* private window: the choice lasts this view only */
  }
}

const EACH = [["5", "±5"], ["10", "±10"], ["20", "±20"], ["all", "All"]];
const eachOf = (v) => (v === "all" ? null : Number(v));
const eachText = (v) => (v === "all" ? "all strikes" : `±${v} strikes`);
const sideName = (side) => (side === "ce" ? "Call" : "Put");
const legName = (m) => `${formatInt(m.strike)} ${sideName(m.side)}`;
const cnt = (v) => formatCompact(v);
const sCnt = (v) => (isFigure(v) ? formatCompact(v, { signed: true }) : DASH);
const sPct = (v) => (isFigure(v) ? `${formatSigned(v, Math.abs(v) >= 100 ? 0 : 1)}%` : DASH);
const signCls = (v) => (!isFigure(v) || Number(v) === 0 ? "ink-zero" : v > 0 ? "ink-pos" : "ink-neg");
const rupees = (v) => (isFigure(v) ? `₹${formatCompact(v)}` : DASH);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "") ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : DASH);

/** Bars and tiles carry their size as data-v / data-a; set it as a custom property (CSSOM, no style attributes). */
export function applyVars(root) {
  for (const el of root.querySelectorAll?.("[data-v],[data-a]") ?? []) {
    if (el.dataset.v !== undefined) el.style.setProperty("--v", el.dataset.v);
    if (el.dataset.a !== undefined) el.style.setProperty("--a", el.dataset.a);
  }
  return root;
}

// ── The recorder's day, per chain ──

const days = new Map();
/**
 * The day's frames for a chain: read once (pages of 500 snapshots), then topped up with what was recorded after the
 * last one held. Kept 30 s, so moving between these views reads nothing again.
 */
async function loadDay(u, e, { force = false } = {}) {
  const key = `${u}|${e}`;
  const held = days.get(key);
  if (held && !force && Date.now() - held.at < 30_000) return held;
  const raw = held?.raw ? [...held.raw] : [];
  const lastT = held?.frames?.at(-1)?.t ?? null;
  let cursor = null;
  let unavailable = null;
  for (let page = 0; page < 8; page += 1) {
    const q = new URLSearchParams({ underlying: u, expiry: e, fields: "oi,ltp", limit: "500" });
    if (lastT !== null) q.set("from", String(Math.floor(lastT / 1000) + 1));
    if (cursor) q.set("cursor", cursor);
    const d = (await api(`/v1/options/snapshots?${q}`)).data?.data ?? {};
    raw.push(...(d.snapshots ?? []));
    unavailable = d.unavailable ?? null;
    cursor = d.nextCursor;
    if (!cursor) break;
  }
  const day = { raw, frames: C.framesFrom(raw), unavailable: raw.length ? null : unavailable, at: Date.now() };
  days.set(key, day);
  return day;
}

// ── Patching in place ──
// A live repaint, a replay step or a minute's top-up builds the view again off-screen and walks it against what is on
// screen: only changed text, attributes and charts are written, so hover, scroll, focus and open details stay put.
// Card heads (the analytics host restyles them) and the hero's tools (live controls) are kept as they are.

/** Classes the analytics host adds to a fitted card (fitDesk): kept through a patch. */
const FIT_CLASSES = new Set(["an-panel", "an-wide", "an-gone", "an-formbar"]);
/** Chart hosts drawn on demand: host -> { sig, build, last, draw }. A patch redraws a chart only when its sig changed. */
const charts = new WeakMap();
const chartRo =
  typeof ResizeObserver !== "undefined"
    ? new ResizeObserver((entries) => {
        for (const { target } of entries) {
          if (!target.isConnected) chartRo.unobserve(target);
          else charts.get(target)?.draw();
        }
      })
    : null;

/**
 * A chart host that draws `build(width)` once it is laid out and again when its width changes. `sig` names the data
 * drawn: a patch with the same sig keeps the drawn chart (and its hover); a new sig redraws it at its current width.
 */
function liveHost(sig, build) {
  const host = h("div", { class: "chart-host" });
  const c = {
    sig,
    build,
    last: 0,
    draw(force = false) {
      const w = Math.max(260, Math.floor(host.clientWidth || 640));
      if (!force && w === c.last) return;
      c.last = w;
      host.replaceChildren(c.build(w));
    },
  };
  charts.set(host, c);
  if (chartRo) chartRo.observe(host);
  else c.draw();
  return host;
}

function syncAttrs(a, b) {
  const details = a.tagName === "DETAILS";
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && name !== "data-fit" && !(details && name === "open")) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) {
    if (details && name === "open") continue;
    let v = value;
    if (name === "class" && a.dataset.fit) v = [...new Set([...value.split(/\s+/).filter(Boolean), ...[...a.classList].filter((c) => FIT_CLASSES.has(c))])].join(" ");
    if (a.getAttribute(name) !== v) a.setAttribute(name, v);
  }
}

/** Walk `b` (fresh, off-screen) against `a` (on screen), writing only the differences into `a`. */
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return a.replaceWith(b);
  if (a.nodeType === 3 || a.nodeType === 8) {
    if (a.data !== b.data) a.data = b.data;
    return;
  }
  if (a.nodeType !== 1) return;
  if (a.hasAttribute("data-keep") || a.classList.contains("card-head")) return;
  // The freshness row is read by the host when it is added: a new reading is a new row.
  if (a.classList.contains("analytics-status")) {
    if (a.textContent !== b.textContent) a.replaceWith(b);
    return;
  }
  const ca = charts.get(a);
  const cb = charts.get(b);
  if (ca || cb) {
    if (!ca || !cb) return a.replaceWith(b);
    chartRo?.unobserve(b);
    if (ca.sig !== cb.sig) {
      ca.sig = cb.sig;
      ca.build = cb.build;
      ca.draw(true);
    }
    return;
  }
  syncAttrs(a, b);
  morphChildren(a, b);
}
/** Children pairwise; a pinned child (data-pin: the replay strip) is not the drawing's and stays where it is. */
function morphChildren(a, b) {
  const old = [...a.childNodes].filter((n) => !(n.nodeType === 1 && n.hasAttribute("data-pin")));
  const next = [...b.childNodes];
  let prev = null;
  next.forEach((n, i) => {
    if (i < old.length) {
      morph(old[i], n);
      prev = old[i].isConnected ? old[i] : n;
    } else {
      a.insertBefore(n, prev ? prev.nextSibling : a.firstChild);
      prev = n;
    }
  });
  for (let i = next.length; i < old.length; i += 1) old[i].remove();
}

// ── The live reading: the chain's quotes laid over the newest recorded minute ──

/** A view repaints from live quotes at most this often; a tick itself only updates a map. */
const LIVE_MS = 2500;
const hmNow = () => {
  const m = istClock(Date.now()).mins;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Live only for today's recording, while the market is open (or the demo feed runs). */
function liveAllowed(day) {
  const last = day.frames.at(-1);
  if (!last || istClock(last.t).date !== istClock(Date.now()).date) return false;
  return Boolean(app.state.demo) || marketSession(Date.now()).phase === "open";
}

/**
 * The chain's legs and index, watched on the shared stream (quote mode, one delivery a second at most). One read of
 * the chain gives the symbols and a first reading; ticks then replace OI and premium per leg. `onChange` is told when
 * something arrived; the view decides when to repaint.
 */
function liveSource(u, e, onChange) {
  const quotes = new Map();
  const bySymbol = new Map();
  const index = spotSymbolOf(u);
  let spot = null;
  let at = 0;
  let feed = null;
  let stopped = false;
  (async () => {
    try {
      const d = (await api(`/v1/optionchain?${new URLSearchParams({ underlying: u, expiry: e, strikes: "100", greeks: "false" })}`)).data?.data ?? {};
      if (stopped) return;
      for (const r of d.rows ?? []) {
        for (const side of ["ce", "pe"]) {
          const leg = r[side];
          if (!leg) continue;
          const key = `${Number(r.strike)}|${side}`;
          quotes.set(key, { oi: leg.oi ?? null, ltp: leg.ltp ?? null });
          if (leg.symbol) bySymbol.set(leg.symbol, key);
        }
      }
      if (isFigure(d.underlyingLtp)) spot = Number(d.underlyingLtp);
      at = Date.now();
      onChange();
      feed = watch(
        [index, ...bySymbol.keys()],
        "quote",
        (ticks) => {
          for (const [sym, t] of ticks) {
            if (sym === index) {
              if (isFigure(t.ltp)) spot = Number(t.ltp);
              continue;
            }
            const key = bySymbol.get(sym);
            if (!key) continue;
            const q = quotes.get(key) ?? { oi: null, ltp: null };
            quotes.set(key, { oi: isFigure(t.oi) ? t.oi : q.oi, ltp: isFigure(t.ltp) ? t.ltp : q.ltp });
          }
          at = Date.now();
          onChange();
        },
        { minGapMs: 1000 },
      );
    } catch {
      /* no live layer: the recorder's minutes still draw */
    }
  })();
  return {
    frame: (base) => (at ? C.liveFrame(base, quotes, { spot, t: at, hm: hmNow() }) : null),
    stop() {
      stopped = true;
      feed?.stop();
    },
  };
}

// ── Replay: the recorded day, one reading at a time ──

const SPEEDS = [["1", "1×"], ["2", "2×"], ["4", "4×"]];

/** The replay strip: transport, a slider over the readings, the time and state, speed, Latest and close. */
function replayStrip(H, T, act) {
  const btn = (name, label, fn, cls = "") => {
    const b = h("button", { type: "button", class: `icon-btn small oix-rp-btn${cls ? ` ${cls}` : ""}`, "aria-label": label, title: label }, h("span", { class: "oix-rp-ic", "aria-hidden": "true" }, [name].flat().map((n) => icon(n))));
    b.addEventListener("click", fn);
    return b;
  };
  const first = btn(["chevron", "chevron"], "First reading", () => act("first"), "back dbl");
  const prev = btn("chevron", "Previous reading", () => act("prev"), "back");
  const play = btn("play", "Play", () => act("toggle"));
  const next = btn("chevron", "Next reading", () => act("next"));
  const slider = h("input", { type: "range", class: "oix-rp-range", min: "0", max: "0", step: "1", value: "0", "aria-label": "Replay position" });
  slider.addEventListener("input", () => act(Number(slider.value)));
  const time = h("b", { class: "oix-rp-time" });
  const state = h("span", { class: "oix-rp-state" });
  const ends = [h("span", { class: "oix-rp-end" }), h("span", { class: "oix-rp-end" })];
  const speed = H.segmented("Replay speed", SPEEDS, String(T.speed));
  speed.classList.add("oix-cap", "oix-rp-speed");
  speed.addEventListener("change", () => act({ speed: Number(speed.value) }));
  const latest = h("button", { type: "button", class: "small oix-rp-latest" }, "Latest");
  latest.addEventListener("click", () => act("latest"));
  const close = btn("close", "Close replay", () => act("close"));
  const el = h(
    "div",
    { class: "oix-replay", role: "group", "aria-label": "Session replay", hidden: true, "data-pin": "" },
    h("div", { class: "oix-rp-transport" }, first, prev, play, next),
    h("div", { class: "oix-rp-track" }, slider, h("div", { class: "oix-rp-ends" }, ends)),
    h("div", { class: "oix-rp-read" }, time, state),
    h("div", { class: "oix-rp-tail" }, speed, latest, close),
  );
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      act("close");
    }
  });
  /** Text and attributes only: called on every step. */
  const sync = (frames) => {
    el.hidden = !T.open;
    if (!T.open) return;
    const n = frames.length;
    const at = T.cursor ?? n - 1;
    slider.max = String(Math.max(0, n - 1));
    slider.value = String(at);
    time.textContent = frames[at]?.hm ?? DASH;
    state.textContent = T.playing ? "Playing" : T.cursor === null ? "Latest reading" : `Paused · ${formatInt(n - 1 - at)} reading${n - 1 - at === 1 ? "" : "s"} before the newest`;
    ends[0].textContent = frames[0]?.hm ?? "";
    ends[1].textContent = frames.at(-1)?.hm ?? "";
    play.replaceChildren(icon(T.playing ? "pause" : "play"));
    play.setAttribute("aria-label", T.playing ? "Pause" : T.cursor !== null && at >= n - 1 ? "Replay from the start" : "Play");
    play.title = play.getAttribute("aria-label");
    latest.disabled = T.cursor === null;
  };
  return { el, sync };
}

/**
 * A view's frame: the context, a root that holds what is drawn, a first load, a quiet top-up every minute, the live
 * layer and the replay. `draw(day, again)` returns the nodes: `day.frames` is what to read (cut at the replay cursor,
 * or with the live reading as its newest frame), `again()` redraws after a control change. Live repaints, replay steps
 * and top-ups patch what is on screen in place.
 */
async function recorderView(H, draw) {
  const u = workspace.state.underlying;
  const e = workspace.state.expiry;
  if (!e) return emptyState("info", "No expiry to show", "Pick an underlying with upcoming expiries in the top bar.");
  const root = h("div", { class: "stack oix-root" });
  let day;
  try {
    day = await loadDay(u, e);
  } catch (err) {
    return H.errorBox(err);
  }
  /** Replay state: never remembered (an old board must not pass for the current one). */
  const T = { open: false, cursor: null, playing: false, speed: 1 };
  let liveF = null;
  let playTimer = null;
  const view = () => {
    if (T.cursor !== null) return { ...day, frames: day.frames.slice(0, T.cursor + 1), replay: true };
    if (liveF) return { ...day, frames: [...day.frames, liveF], live: true };
    return day;
  };
  const replayBtn = h("button", { type: "button", class: "small oix-custom oix-replay-btn", "aria-pressed": "false", title: "Step or play through today's recorded readings" }, icon("clock"), "Replay");
  const strip = replayStrip(H, T, (a) => act(a));
  const placeTools = () => {
    const tools = root.querySelector(".oix-hero .oix-tools");
    if (tools && replayBtn.parentNode !== tools) tools.append(replayBtn);
    if (tools) tools.dataset.keep = "";
    const hero = root.querySelector(".oix-hero");
    if (hero && strip.el.parentNode !== hero.parentNode) hero.after(strip.el);
    replayBtn.setAttribute("aria-pressed", String(T.open));
    strip.sync(day.frames);
  };
  const paint = (soft = false) => {
    try {
      const fresh = h("div", {}, ...[draw(view(), () => paint(false))].flat().filter(Boolean));
      applyVars(fresh);
      if (soft && root.firstChild) morphChildren(root, fresh);
      else root.replaceChildren(...fresh.childNodes);
      placeTools();
    } catch (err) {
      root.replaceChildren(H.errorBox(err));
    }
  };
  const stopPlay = () => {
    T.playing = false;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
  };
  const startPlay = () => {
    stopPlay();
    const n = day.frames.length;
    if (T.cursor === null || T.cursor >= n - 1) T.cursor = 0;
    T.playing = true;
    playTimer = setInterval(() => {
      if (!root.isConnected || (typeof document !== "undefined" && document.hidden)) {
        stopPlay();
        return placeTools();
      }
      T.cursor = C.moveCursor(T.cursor, "next", day.frames.length);
      if (T.cursor >= day.frames.length - 1) stopPlay();
      paint(true);
    }, 1000 / T.speed);
  };
  function act(a) {
    if (a === "close") {
      stopPlay();
      T.open = false;
      T.cursor = null;
      paint(true);
      return replayBtn.focus();
    }
    if (a === "toggle") {
      if (T.playing) stopPlay();
      else startPlay();
      return paint(true);
    }
    if (a && typeof a === "object" && "speed" in a) {
      T.speed = a.speed;
      if (T.playing) startPlay();
      return placeTools();
    }
    stopPlay();
    T.cursor = C.moveCursor(T.cursor, a, day.frames.length);
    paint(true);
  }
  replayBtn.addEventListener("click", () => {
    if (T.open) return act("close");
    T.open = true;
    paint(true);
    strip.el.querySelector(".oix-rp-range")?.focus();
  });
  paint();
  // Live: ticks mark the reading dirty; a repaint happens at most every LIVE_MS, only while following the newest.
  let live = null;
  let dirty = false;
  let seen = false;
  const startLive = () => {
    if (live || !liveAllowed(day)) return;
    live = liveSource(u, e, () => (dirty = true));
  };
  startLive();
  const liveTimer = setInterval(() => {
    if (root.isConnected) seen = true;
    else if (seen) {
      clearInterval(liveTimer);
      stopPlay();
      return live?.stop();
    }
    if (!dirty || T.cursor !== null || (typeof document !== "undefined" && document.hidden)) return;
    dirty = false;
    const f = live?.frame(day.frames.at(-1));
    if (!f) return;
    liveF = f;
    paint(true);
  }, LIVE_MS);
  const timer = setInterval(async () => {
    if (!root.isConnected) return clearInterval(timer);
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const next = await loadDay(u, e, { force: true });
      if (next.frames.at(-1)?.t !== day.frames.at(-1)?.t) {
        day = next;
        // The live reading is laid over the new minute on the next tick.
        liveF = live?.frame(day.frames.at(-1)) ?? null;
        startLive();
        if (!T.playing) paint(true);
      }
    } catch {
      /* the next minute tries again; what is drawn stays */
    }
  }, 60_000);
  return root;
}

/** The freshness row the host moves into the top bar: where the figures come from and the time of the newest one. */
const freshRow = (day) =>
  h(
    "div",
    { class: "row analytics-status" },
    pill(day.replay ? "Replay · Bridge recorder" : day.live ? "Live · Bridge recorder" : "Bridge recorder", day.frames.length ? (day.replay ? "info" : "ok") : "warn"),
    day.frames.length ? h("span", { class: "muted small" }, `as of ${day.frames.at(-1).hm} IST`) : null,
  );

/** Where the reading stands in time, for the hero's scope line: "Live", or the replay's time. */
const whenText = (day, latest = day.frames.at(-1)) => (day.replay ? ` · replay at ${day.frames.at(-1)?.hm ?? DASH}` : latest?.live ? " · live" : "");

/** Nothing recorded for this chain today: say why, and how to fill it. */
function noDay(day, what) {
  const why = day.unavailable?.detail ?? "The Bridge records index chains every minute while it runs in market hours.";
  return [freshRow(day), emptyState("clock", `No recorded session for ${what} yet`, `${why} These views read the Bridge's own recording, so they fill in as the session is recorded.`)];
}

/** A capsule control bound to a preference. */
function capsule(H, label, key, options, onChange, cls = "") {
  const seg = H.segmented(label, options, prefs()[key]);
  seg.classList.add("oix-cap");
  if (cls) seg.classList.add(cls);
  seg.addEventListener("change", () => {
    if (prefs()[key] === seg.value) return;
    savePref(key, seg.value);
    onChange();
  });
  return seg;
}

/** The Customise button: a sheet of labelled capsules (the optional settings, out of the way). */
function customise(H, title, fields, onChange) {
  const btn = h("button", { type: "button", class: "small oix-custom", "aria-haspopup": "dialog" }, icon("sliders"), "Customise");
  btn.addEventListener("click", () => {
    const body = h(
      "div",
      { class: "stack oix-sheet" },
      fields.map(([label, key, options, hint]) => {
        const seg = capsule(H, label, key, options, onChange);
        return h("div", { class: "stack" }, H.segField(label, seg), hint ? h("p", { class: "muted small" }, hint) : null);
      }),
    );
    sheetPopover({ trigger: btn, title, body });
  });
  return btn;
}

/**
 * The hero: a title and the view's capsules in the head; in the body the reading (a coloured word), one sentence, the
 * scope line and up to four figures. `tone`: pos | neg | zero.
 */
export function hero({ title, word, tone = "zero", detail, scope, figs = [], tools = [], extra = null }) {
  return h(
    "section",
    { class: "card an-wide oix-hero" },
    h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, title)), h("div", { class: "an-head-tools oix-tools" }, tools)),
    h(
      "div",
      { class: "card-body" },
      h(
        "div",
        { class: "oix-read" },
        h("div", { class: "oix-lead" }, h("p", { class: "oix-word", "data-tone": tone }, word), detail ? h("p", { class: "oix-detail" }, detail) : null, scope ? h("p", { class: "oix-scope" }, scope) : null),
        figs.length ? h("dl", { class: "oix-figs" }, figs.filter(Boolean).map(([k, v, cls, sub]) => h("div", { class: "oix-fig" }, h("dt", {}, k), h("dd", { class: cls || undefined }, v), sub ? h("span", { class: "oix-fig-sub" }, sub) : null))) : null,
      ),
      extra,
    ),
  );
}

/** A plain panel. */
const panel = (title, sub, body, { wide = false, cls = "" } = {}) =>
  h("section", { class: `card oix-panel${wide ? " an-wide" : ""}${cls ? ` ${cls}` : ""}` }, h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, title), sub ? h("p", {}, sub) : null)), h("div", { class: "card-body" }, body));

/** The window capsule's choices: the rolling windows, Day and a custom stretch of the session. */
const WINDOWS = [...C.OIX_WINDOWS, ["custom", "Custom"]];
const CLOCKS = C.clockChoices(15);

/** The window a view reads: a rolling one, Day, or the custom From–To stretch. */
const windowFor = (frames, p) => (p.win === "custom" ? C.customWindow(frames, p.from, p.to) : C.windowFrames(frames, p.win));

/**
 * The window capsule, and with Custom the From and To clocks beside it (15-minute steps; To always after From).
 * Returns the tools to put in the hero's head.
 */
function windowTools(H, again, key = "win") {
  const win = capsule(H, "Window", key, key === "win" ? WINDOWS : HM_WINDOWS, again);
  const p = prefs();
  if (p[key] !== "custom") return [win];
  const clock = (label, k, list) => {
    const sel = h("select", { class: "oix-clock", "aria-label": label }, list.map(([v, t]) => h("option", { value: v }, t)));
    sel.value = list.some((x) => x[0] === p[k]) ? p[k] : list[k === "from" ? 0 : list.length - 1][0];
    sel.addEventListener("change", () => {
      savePref(k, sel.value);
      const q = prefs();
      // To is always later than From: move the other end one step past this one.
      if ((C.hmMinutes(q.to) ?? 0) <= (C.hmMinutes(q.from) ?? 0)) {
        if (k === "from") savePref("to", CLOCKS.to.find((x) => C.hmMinutes(x[0]) > C.hmMinutes(q.from))?.[0] ?? "15:30");
        else savePref("from", [...CLOCKS.from].reverse().find((x) => C.hmMinutes(x[0]) < C.hmMinutes(q.to))?.[0] ?? "09:15");
      }
      again();
    });
    return sel;
  };
  return [win, h("div", { class: "oix-range", role: "group", "aria-label": "Custom window" }, h("span", {}, "From"), clock("From", "from", CLOCKS.from), h("span", {}, "to"), clock("To", "to", CLOCKS.to))];
}

/** "15m · since 10:05", "30m of 1h · since 09:15", "10:00–11:30 · since 10:00", or why it is not measured. */
function windowText(w) {
  if (w.custom) {
    if (w.state === "none") return `Fewer than two readings between ${w.from} and ${w.to}`;
    return w.base.hm === w.from && w.latest.hm === w.to ? `${w.from}–${w.to}` : `${w.from}–${w.to} · read ${w.base.hm}–${w.latest.hm}`;
  }
  if (w.state === "none") return "Needs two recorded readings";
  if (w.state === "gap") return `No reading close enough to ${w.wantMin} min back; not measured`;
  const len = w.wantMin === null ? "Day" : w.state === "short" ? `${w.spanMin}m of ${w.wantMin >= 60 ? `${w.wantMin / 60}h` : `${w.wantMin}m`}` : w.wantMin >= 60 ? `${w.wantMin / 60}h` : `${w.wantMin}m`;
  return `${len} · since ${w.base.hm}`;
}

/** A window that cannot be measured, as the hero says it. */
const unmeasured = (title, w, tools) => hero({ title, word: w.state === "none" ? "At the open" : "Window not measured", tone: "zero", detail: windowText(w), tools });

// ── Charts: a line through the day with a hover readout ──

/**
 * Lines over time. `series`: [{ cls, points: [{ t, v }], step? }]; `refs`: horizontal rules [{ v, label, cls }];
 * `band`: [lo, hi] a quiet band; `marks`: [{ t, v, cls, title }] dots; `readout(i)`: the text for the i-th time.
 */
function timeChart({ series, refs = [], band = null, marks = [], yFmt = (v, dp) => formatFixed(v, Math.max(2, dp)), readout, label, height = 260 }) {
  const times = series[0]?.points.map((p) => p.t) ?? [];
  // Redrawn when a point is added or the newest one moves (the live reading), not on every patch.
  const sig = `${times.length}|${times.at(-1)}|${series.map((x) => x.points.at(-1)?.v).join(",")}|${marks.length}|${label}`;
  return liveHost(sig, (w) => {
    const H = height;
    const pad = { l: 52, r: 14, t: 28, b: 24 };
    const vals = [...series.flatMap((x) => x.points.map((p) => p.v)), ...refs.map((r) => r.v), ...(band ?? [])].filter(isFigure);
    const svg = svgRoot(w, H, label);
    svg.classList.add("oix-chart");
    if (!vals.length || times.length < 2) return svg;
    const sc = niceScale(Math.min(...vals), Math.max(...vals), 4);
    const t0 = times[0];
    const t1 = times.at(-1);
    const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + ((sc.max - v) / Math.max(1e-12, sc.max - sc.min)) * (H - pad.t - pad.b);
    const dp = tickDecimals(sc.step);
    if (band) svg.append(s("rect", { class: "oix-band", x: pad.l, y: Y(band[1]), width: w - pad.l - pad.r, height: Math.max(0, Y(band[0]) - Y(band[1])), rx: 4 }));
    for (const v of sc.ticks) svg.append(s("line", { class: "grid-line", x1: pad.l, x2: w - pad.r, y1: Y(v), y2: Y(v) }), s("text", { class: "tick", x: pad.l - 6, y: Y(v) + 4, "text-anchor": "end" }, yFmt(v, dp)));
    // Hour ticks along the foot.
    for (let hr = 9; hr <= 15; hr += 1) {
      const at = series[0].points.find((p) => p.hm === `${String(hr).padStart(2, "0")}:15` || p.hm === `${String(hr).padStart(2, "0")}:30`);
      if (at) svg.append(s("text", { class: "tick", x: X(at.t), y: H - 6, "text-anchor": "middle" }, at.hm));
    }
    for (const r of refs) svg.append(s("line", { class: `oix-ref ${r.cls ?? ""}`, x1: pad.l, x2: w - pad.r, y1: Y(r.v), y2: Y(r.v) }), r.label ? s("text", { class: "oix-ref-label", x: w - pad.r - 2, y: Y(r.v) - 5, "text-anchor": "end" }, r.label) : null);
    for (const x of series) {
      let d = "";
      let prev = null;
      for (const p of x.points) {
        if (!isFigure(p.v)) {
          prev = null;
          continue;
        }
        const px = Math.round(X(p.t) * 10) / 10;
        const py = Math.round(Y(p.v) * 10) / 10;
        d += prev === null ? `M${px} ${py}` : x.step ? `H${px}V${py}` : `L${px} ${py}`;
        prev = p;
      }
      if (d) svg.append(s("path", { class: `oix-line ${x.cls}`, d }));
    }
    for (const m of marks) if (isFigure(m.v)) svg.append(s("circle", { class: `oix-dot ${m.cls ?? ""}`, cx: X(m.t), cy: Y(m.v), r: 4 }, s("title", {}, m.title)));
    // Hover: a hairline and the readout at the top left; nothing redraws.
    const cross = s("line", { class: "oix-cross", x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, visibility: "hidden" });
    const read = s("text", { class: "oix-readout", x: pad.l, y: 16 }, readout ? readout(times.length - 1) : "");
    const hit = s("rect", { x: pad.l, y: pad.t, width: w - pad.l - pad.r, height: H - pad.t - pad.b, fill: "transparent" });
    const at = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * w;
      const t = t0 + ((x - pad.l) / Math.max(1, w - pad.l - pad.r)) * (t1 - t0);
      let i = 0;
      for (let j = 1; j < times.length; j += 1) if (Math.abs(times[j] - t) < Math.abs(times[i] - t)) i = j;
      return i;
    };
    hit.addEventListener("pointermove", (ev) => {
      const i = at(ev);
      cross.setAttribute("x1", String(X(times[i])));
      cross.setAttribute("x2", String(X(times[i])));
      cross.setAttribute("visibility", "visible");
      if (readout) read.textContent = readout(i);
    });
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      if (readout) read.textContent = readout(times.length - 1);
    });
    svg.append(cross, read, hit);
    return svg;
  });
}

// ───────────────────────── OI change ─────────────────────────

async function renderOiChange(H) {
  return recorderView(H, (day, again) => {
    const u = workspace.state.underlying;
    const e = workspace.state.expiry;
    if (!day.frames.length) return noDay(day, `${u} ${dayText(e)}`);
    const p = prefs();
    const custom = customise(H, "OI change", [["Strikes", "each", EACH, "Counted in listed strikes either side of ATM"]], again);
    const tools = [...windowTools(H, again), custom];
    const w = windowFor(day.frames, p);
    if (w.state === "none" || w.state === "gap") return [freshRow(day), unmeasured("OI change", w, tools)];
    const latest = w.latest;
    const moves = C.legMoves(w.base, latest, { strikes: C.scopeStrikes(latest, eachOf(p.each)), thinOi: Math.max(5000, 20 * latest.lot) });
    const ch = C.changeByStrike(moves);
    const t = ch.totals;
    const reading = C.changeReading(t);
    const net = t.pe - t.ce;
    const adds = moves.filter((m) => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 5);
    const cuts = moves.filter((m) => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 5);
    return [
      freshRow(day),
      hero({
        title: "OI change",
        word: reading.word,
        tone: reading.tone,
        detail: changeSentence(reading.key, t),
        scope: `${u} ${dayText(e)} · ${windowText(w)} · ${eachText(p.each)} · contracts${whenText(day, latest)}`,
        figs: [
          ["Calls", sCnt(t.ce), signCls(t.ce), `+${cnt(t.ceAdd)} added · ${cnt(t.ceCut)} cut`],
          ["Puts", sCnt(t.pe), signCls(t.pe), `+${cnt(t.peAdd)} added · ${cnt(t.peCut)} cut`],
          ["Puts − calls", sCnt(net), signCls(net), "Put change less call change"],
          adds[0] ? ["Largest add", legName(adds[0]), `oix-leg ${adds[0].side}`, `${sCnt(adds[0].d)} · ${sPct(adds[0].pct)}`] : null,
        ],
        tools,
      }),
      panel("Change by strike", "Calls on the left, puts on the right. Added in green, cut in red and hatched. Hover a bar for its figures.", changeLadder(ch.rows, latest), { wide: true }),
      panel("Biggest additions", "The legs that added the most contracts in the window", moverList(adds)),
      panel("Biggest cuts", "The legs that closed the most contracts in the window", moverList(cuts)),
    ];
  });
}

/** One sentence under the OI change word: the two sides' net changes. Describes the book, never a view. */
function changeSentence(key, t) {
  const c = `calls ${t.ce >= 0 ? "added" : "cut"} ${cnt(Math.abs(t.ce))}`;
  const p = `puts ${t.pe >= 0 ? "added" : "cut"} ${cnt(Math.abs(t.pe))}`;
  if (key === "flat") return "Neither side changed in this window.";
  return `On the strikes read, ${p} and ${c}, net. The count says how many contracts opened or closed, not who holds them.`;
}

/** The mirrored ladder: strike in the middle, call change to the left, put change to the right, one shared scale. */
function changeLadder(rows, latest) {
  const atm = C.atmOf(latest);
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.ce?.d ?? 0), Math.abs(r.pe?.d ?? 0)]));
  const top = (side, sign) => rows.reduce((b, r) => (r[side] && Math.sign(r[side].d) === sign && (!b || Math.abs(r[side].d) > Math.abs(b[side].d)) ? r : b), null)?.strike;
  const peaks = { ce: [top("ce", 1), top("ce", -1)], pe: [top("pe", 1), top("pe", -1)] };
  const bar = (r, side) => {
    const x = r[side];
    if (!x || !x.d) return h("span", { class: `oix-cbar ${side}` }, h("span", { class: "oix-cfig ink-zero" }, x ? "0" : DASH));
    const peak = peaks[side].includes(r.strike);
    const el = h("span", { class: `oix-cbar ${side}${peak ? " peak" : ""}`, title: `${formatInt(r.strike)} ${sideName(side)}: ${sCnt(x.d)} (${sPct(x.pct)}) · OI ${cnt(x.oi0)} → ${cnt(x.oi1)}${x.code ? ` · ${C.BUILDUPS[x.code].name}` : ""}` }, h("span", { class: `oix-cfill ${x.d > 0 ? "add" : "cut"}`, "data-v": Math.round((Math.abs(x.d) / max) * 1000) / 1000 }), h("span", { class: `oix-cfig ${x.d > 0 ? "ink-pos" : "ink-neg"}` }, sCnt(x.d)));
    return el;
  };
  const spot = latest.spot;
  const out = [];
  const desc = [...rows].sort((a, b) => b.strike - a.strike);
  desc.forEach((r, i) => {
    const next = desc[i + 1];
    out.push(h("div", { class: `oix-crow${r.strike === atm ? " atm" : ""}` }, bar(r, "ce"), h("span", { class: "oix-ck" }, formatInt(r.strike), r.ce?.code ? h("span", { class: `obu obu-${r.ce.code}`, title: `Call: ${C.BUILDUPS[r.ce.code].name}` }, r.ce.code) : null, r.pe?.code ? h("span", { class: `obu obu-${r.pe.code}`, title: `Put: ${C.BUILDUPS[r.pe.code].name}` }, r.pe.code) : null), bar(r, "pe")));
    if (next && r.strike > spot && next.strike <= spot) out.push(h("div", { class: "oix-spot", role: "separator" }, h("span", {}, `Spot ${formatFixed(spot, 2)}`)));
  });
  return h("div", { class: "oix-ladder" }, h("div", { class: "oix-chead" }, h("span", { class: "ce" }, "Calls"), h("span", {}, "Strike"), h("span", { class: "pe" }, "Puts")), out);
}

/** A short list of legs: name, change, share of its own book, build-up. */
function moverList(list) {
  if (!list.length) return h("p", { class: "muted small" }, "None in this window.");
  return h(
    "ol",
    { class: "oix-movers" },
    list.map((m) =>
      h(
        "li",
        { title: `OI ${cnt(m.oi0)} → ${cnt(m.oi1)} · premium ${sPct(m.pxPct)}` },
        h("span", { class: `oix-leg ${m.side}` }, legName(m)),
        m.code ? h("span", { class: `obu obu-${m.code}`, title: C.BUILDUPS[m.code].name }, m.code) : h("span"),
        h("span", { class: `oix-num ${m.d > 0 ? "ink-pos" : "ink-neg"}` }, sCnt(m.d)),
        h("span", { class: "oix-num oix-quiet" }, m.thin ? "thin start" : sPct(m.pct)),
      ),
    ),
  );
}

// ───────────────────────── Spurts ─────────────────────────

const BARS = [["10", "10%"], ["20", "20%"], ["30", "30%"]];
const LEGS = [["both", "Calls and puts"], ["ce", "Calls"], ["pe", "Puts"]];

async function renderSpurts(H) {
  return recorderView(H, (day, again) => {
    const u = workspace.state.underlying;
    const e = workspace.state.expiry;
    if (!day.frames.length) return noDay(day, `${u} ${dayText(e)}`);
    const p = prefs();
    const bar = Number(p.bar);
    const custom = customise(
      H,
      "Spurts",
      [
        ["Big move ≥", "bar", BARS, "A leg that moved this share of its own book or more is a spurt"],
        ["Legs", "legs", LEGS, null],
        ["Strikes", "each", EACH, "Counted in listed strikes either side of ATM"],
      ],
      again,
    );
    const tools = [...windowTools(H, again), custom];
    const w = windowFor(day.frames, p);
    if (w.state === "none" || w.state === "gap") return [freshRow(day), unmeasured("Spurts", w, tools)];
    const latest = w.latest;
    const moves = C.legMoves(w.base, latest, { strikes: C.scopeStrikes(latest, eachOf(p.each)), legs: p.legs, thinOi: Math.max(5000, 20 * latest.lot) });
    // The fourth check reads the readings up to the window's newest (one-reading steps).
    const upTo = day.frames.slice(0, day.frames.indexOf(latest) + 1);
    const kept = C.keptGoing(moves, upTo, { n: 5, steps: 3 });
    const r = C.boardReading(moves, { bar, lot: latest.lot, spot: latest.spot, kept });
    const top = C.topMoves(moves, 3);
    const lvl = (m) => (m ? `${legName(m)} ${sCnt(m.d)}` : DASH);
    const against = r.against ? `${legName(r.against)} ${sCnt(r.against.d)} (${C.BUILDUPS[r.against.code]?.plain.toLowerCase() ?? "no build-up"}) points the other way.` : "";
    return [
      freshRow(day),
      hero({
        title: "Spurts",
        word: r.word,
        tone: r.tone,
        detail: r.detail,
        scope: `${u} ${dayText(e)} · ${windowText(w)} · ${eachText(p.each)}${p.legs === "both" ? "" : p.legs === "ce" ? " · calls only" : " · puts only"} · big move ≥ ${bar}%${whenText(day, latest)}`,
        figs: [
          ["Opened", `+${cnt(r.opened)}`, "ink-pos", "Contracts added"],
          ["Closed", r.closed ? `−${cnt(r.closed)}` : "0", r.closed ? "ink-neg" : "ink-zero", "Contracts removed"],
          ["Points up", isFigure(r.upShare) ? `${formatInt(r.upShare * 100)}%` : DASH, isFigure(r.upShare) ? (r.upShare >= 0.6 ? "ink-pos" : r.upShare <= 0.4 ? "ink-neg" : "ink-zero") : "", "Of the size with a direction"],
          ["Backing", `${r.firmness[0].toUpperCase()}${r.firmness.slice(1)} · ${r.passes} of ${r.counted}`, `oix-firm f-${r.firmness}`, `${r.big} of ${r.legs} legs over ${bar}%`],
        ],
        tools,
        extra: h(
          "details",
          { class: "oix-more" },
          h("summary", {}, "How this reading is reached"),
          h(
            "div",
            { class: "oix-more-body" },
            h(
              "div",
              { class: "stack" },
              h("ul", { class: "oix-checks" }, r.checks.map((c) => h("li", { "data-pass": String(c.pass) }, h("span", { class: "oix-tick", "aria-hidden": "true" }, c.pass === null ? DASH : c.pass ? "✓" : "✗"), h("b", {}, c.label), h("span", {}, c.detail)))),
              against ? h("p", { class: "oix-hint" }, `Against the reading: ${against}`) : null,
            ),
            h(
              "dl",
              { class: "oix-levels" },
              h("div", {}, h("dt", {}, "Possible ceiling"), h("dd", {}, lvl(r.levels.ceiling)), h("span", { class: "oix-hint" }, "The call at or above price with the most short build-up in this window")),
              h("div", {}, h("dt", {}, "Possible floor"), h("dd", {}, lvl(r.levels.floor)), h("span", { class: "oix-hint" }, "The put at or below price with the most short build-up in this window")),
              h("div", {}, h("dt", {}, "Coming off"), h("dd", {}, lvl(r.levels.covering)), h("span", { class: "oix-hint" }, "The largest short covering on either side of price")),
            ),
            h("p", { class: "oix-hint" }, "Opened against closed decides the regime (one sixth either way); the lean weighs every leg by the contracts it moved. Four checks say how firmly the board backs it (three or four firm, two partial) and never change it. A rule of thumb over what already happened, not a forecast. Legs that opened with very few contracts are left out of the lean."),
          ),
        ),
      }),
      panel("Top moves", "Each build-up's loudest legs, by contracts moved. Bold percentages are big moves.", topMovesGrid(top, bar), { wide: true }),
      panel("Rotation map", "Each leg sits at its premium move (across) and OI move (up); the corner is its build-up. Green points up for the underlying, red down. Circles are calls, diamonds puts; size is OI held.", rotationMap(moves, { bar, label: `Rotation map of ${moves.length} legs, ${windowText(w)}` }), { wide: true }),
    ];
  });
}

/** Four cards in the map's own corners. */
function topMovesGrid(top, bar) {
  const max = Math.max(1, ...C.BUILDUP_ORDER.flatMap((c) => top[c].rows.map((m) => Math.abs(m.d))));
  return h(
    "div",
    { class: "oix-quad" },
    C.BUILDUP_ORDER.map((code) => {
      const b = C.BUILDUPS[code];
      const t = top[code];
      return h(
        "div",
        { class: `oix-qcard q-${code}` },
        h("div", { class: "oix-qhead" }, h("span", { class: `obu obu-${code}` }, code), h("b", {}, b.plain), h("span", { class: "oix-quiet" }, b.name), h("span", { class: `oix-num ${t.sum > 0 ? "ink-pos" : t.sum < 0 ? "ink-neg" : "ink-zero"}` }, t.rows.length ? sCnt(t.sum) : "None")),
        t.rows.length
          ? h(
              "ol",
              { class: "oix-qrows" },
              t.rows.map((m) =>
                h(
                  "li",
                  { title: `OI ${cnt(m.oi0)} → ${cnt(m.oi1)} · premium ${formatFixed(m.px0 ?? 0, 2)} → ${formatFixed(m.px1 ?? 0, 2)}` },
                  h("span", { class: `oix-leg ${m.side}` }, legName(m)),
                  h("span", { class: "oix-rail" }, h("span", { class: `oix-rfill ${m.d > 0 ? "add" : "cut"}`, "data-v": Math.round((Math.abs(m.d) / max) * 1000) / 1000 })),
                  h("span", { class: `oix-num ${m.d > 0 ? "ink-pos" : "ink-neg"}` }, sCnt(m.d)),
                  h("span", { class: `oix-num${Math.abs(m.pct ?? 0) >= bar ? " oix-big" : " oix-quiet"}` }, sPct(m.pct)),
                  h("span", { class: `oix-num ${signCls(m.pxPct)}` }, `prem ${sPct(m.pxPct)}`),
                ),
              ),
            )
          : h("p", { class: "muted small" }, "No leg in this corner."),
        t.more ? h("p", { class: "oix-hint" }, `and ${formatInt(t.more)} smaller`) : null,
      );
    }),
  );
}

/** Straight within ±10 %, compressed beyond, so +900 % and +12 % share one chart. */
const squash = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v) / 10);

/** The rotation map: premium move across, OI move up, a mark per leg. */
function rotationMap(moves, { bar, label }) {
  const pts = moves.filter((m) => !m.thin && isFigure(m.pct) && isFigure(m.pxPct));
  const sig = `${bar}|${label}|${pts.map((m) => `${m.d}:${Math.round(m.pxPct * 10)}`).join(",")}`;
  return liveHost(sig, (w) => {
    const H = Math.round(Math.min(520, Math.max(300, w * 0.55)));
    const pad = { l: 18, r: 18, t: 30, b: 30 };
    const svg = svgRoot(w, H, label);
    svg.classList.add("oix-chart", "oix-map");
    const q97 = (arr) => {
      const a = arr.map(Math.abs).sort((x, y) => x - y);
      return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.97))] : 0;
    };
    const fx = Math.max(squash(2), q97(pts.map((m) => squash(m.pxPct)))) * 1.1;
    const fy = Math.max(squash(3), q97(pts.map((m) => squash(m.pct)))) * 1.1;
    const pw = w - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const X = (v) => pad.l + ((Math.max(-fx, Math.min(fx, squash(v))) + fx) / (2 * fx)) * pw;
    const Y = (v) => pad.t + ((fy - Math.max(-fy, Math.min(fy, squash(v)))) / (2 * fy)) * ph;
    const cx = X(0);
    const cy = Y(0);
    // Corner words, the axes and the spurt bar.
    const corner = (code, x, y, anchor) => s("text", { class: `oix-corner c-${code}`, x, y, "text-anchor": anchor }, `${C.BUILDUPS[code].plain} · ${code}`);
    svg.append(
      corner("SB", pad.l + 6, pad.t + 14, "start"),
      corner("LB", w - pad.r - 6, pad.t + 14, "end"),
      corner("LU", pad.l + 6, H - pad.b - 8, "start"),
      corner("SC", w - pad.r - 6, H - pad.b - 8, "end"),
      s("line", { class: "zero-line", x1: pad.l, x2: w - pad.r, y1: cy, y2: cy }),
      s("line", { class: "zero-line", x1: cx, x2: cx, y1: pad.t, y2: H - pad.b }),
      s("text", { class: "tick", x: cx, y: pad.t - 10, "text-anchor": "middle" }, "OI added ↑"),
      s("text", { class: "tick", x: cx, y: H - 8, "text-anchor": "middle" }, "OI closed ↓"),
      s("text", { class: "tick", x: pad.l, y: cy - 6, "text-anchor": "start" }, "← premium down"),
      s("text", { class: "tick", x: w - pad.r, y: cy - 6, "text-anchor": "end" }, "premium up →"),
    );
    for (const v of [bar, -bar]) if (Math.abs(squash(v)) < fy) svg.append(s("line", { class: "oix-ref bar", x1: pad.l, x2: w - pad.r, y1: Y(v), y2: Y(v) }), s("text", { class: "oix-ref-label", x: w - pad.r - 2, y: Y(v) + (v > 0 ? -5 : 13), "text-anchor": "end" }, `${v > 0 ? "+" : "−"}${bar}%`));
    const maxOi = Math.max(1, ...pts.map((m) => m.oi1));
    const sorted = [...pts].sort((a, b) => b.oi1 - a.oi1);
    const loud = new Set([...pts].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, w >= 560 ? 6 : 0));
    for (const m of sorted) {
      const x = X(m.pxPct);
      const y = Y(m.pct);
      const r = 3 + 9 * Math.sqrt(m.oi1 / maxOi);
      const cls = `oix-mk ${m.lean > 0 ? "up" : m.lean < 0 ? "down" : "flat"}${Math.abs(m.pct) >= bar ? " big" : ""}${Math.abs(squash(m.pct)) > fy || Math.abs(squash(m.pxPct)) > fx ? " edge" : ""}`;
      const title = `${legName(m)} · ${m.code ? `${C.BUILDUPS[m.code].plain} (${C.BUILDUPS[m.code].name})` : "no build-up"} · OI ${sCnt(m.d)} (${sPct(m.pct)}) · premium ${sPct(m.pxPct)} · holds ${cnt(m.oi1)}`;
      const mark = m.side === "ce" ? s("circle", { class: cls, cx: x, cy: y, r }, s("title", {}, title)) : s("path", { class: cls, d: `M${x} ${y - r * 1.15}L${x + r * 1.15} ${y}L${x} ${y + r * 1.15}L${x - r * 1.15} ${y}Z` }, s("title", {}, title));
      svg.append(mark);
      if (loud.has(m)) svg.append(s("text", { class: "oix-mlabel", x: x + r + 4, y: y + 4 }, `${formatInt(m.strike)} ${m.side === "ce" ? "C" : "P"}`));
    }
    if (!pts.length) svg.append(s("text", { class: "tick", x: w / 2, y: H / 2 - 12, "text-anchor": "middle" }, "No leg moved on both OI and premium in this window"));
    return svg;
  });
}

// ───────────────────────── PCR ─────────────────────────

/** The house PCR words (options.js PCR_BANDS) and their ink: put-heavy reads green, call-heavy red. */
function pcrWord(v) {
  const b = pcrBand(v);
  if (!b) return { word: DASH, tone: "zero" };
  return { word: b.word[0].toUpperCase() + b.word.slice(1), tone: b.min >= 1.2 ? "pos" : b.min <= 0.6 ? "neg" : "zero" };
}
const pcrText = (v) => (isFigure(v) ? formatFixed(v, 2) : DASH);
const toneCls = (t) => (t === "pos" ? "ink-pos" : t === "neg" ? "ink-neg" : "ink-zero");

async function renderPcr(H) {
  const u = workspace.state.underlying;
  // The OI explorer reads every expiry's chain: its columns give the PCR by expiry (read once with the view).
  // Kept here (not filled into a drawn node later): a patch draws off-screen, so the list must be part of each drawing.
  let expiries;
  let redraw = null;
  api(`/v1/analytics/oi-explorer?${new URLSearchParams({ underlying: u, expiries: "4" })}`).then(
    (r) => C.expiryPcrs(r.data?.data?.columns),
    () => null,
  ).then((list) => {
    expiries = list;
    redraw?.();
  });
  return recorderView(H, (day, again) => {
    redraw = again;
    const e = workspace.state.expiry;
    if (!day.frames.length) return noDay(day, `${u} ${dayText(e)}`);
    const p = prefs();
    const each = eachOf(p.pcrEach);
    const scope = capsule(H, "Strikes in the ratio", "pcrEach", EACH, again);
    const latest = day.frames.at(-1);
    const now = C.scopedTotals(latest, each);
    const whole = C.scopedTotals(latest, null);
    const series = C.pcrSeries(day.frames, each);
    const st = C.seriesStats(series);
    const crossings = C.pcrCrossings(series);
    const word = pcrWord(now.pcr);
    const wholeWord = pcrWord(whole.pcr);
    const pts = series.map((x) => ({ t: x.t, hm: x.hm, v: x.pcr }));
    const reach = now.lo !== null ? `${formatInt(now.n)} strikes ${formatInt(now.lo)}–${formatInt(now.hi)} around ${formatInt(now.centre)}` : "";
    const expiryPanel = h("div", { class: "oix-exp" }, expiries === undefined ? h("p", { class: "muted small" }, "Reading the other expiries…") : expiryRows(expiries, e));
    return [
      freshRow(day),
      hero({
        title: "Put-call ratio",
        word: `${pcrText(now.pcr)} · ${word.word}`,
        tone: word.tone,
        detail: isFigure(now.pcr) ? `${formatInt(Math.round(now.pcr * 100))} puts open for every 100 calls on ${eachText(p.pcrEach)}. A ratio of open positions, not of trades, and it cannot say who holds them.` : "No call OI in scope, so there is no ratio.",
        scope: `${u} ${dayText(e)} · ${reach} · as of ${latest.hm}${whenText(day)}${p.pcrEach !== "all" && wholeWord.word !== word.word && isFigure(whole.pcr) ? ` · the whole expiry reads ${pcrText(whole.pcr)} (${wholeWord.word.toLowerCase()})` : ""}`,
        figs: [
          ["Since open", isFigure(st.change) ? formatSigned(st.change, 2) : DASH, signCls(st.change), isFigure(st.first) ? `From ${pcrText(st.first)} at ${series.find((x) => isFigure(x.pcr))?.hm ?? ""}` : ""],
          ["Day range", isFigure(st.lo) ? `${pcrText(st.lo)}–${pcrText(st.hi)}` : DASH, "", isFigure(st.lo) ? `Low ${st.loAt} · high ${st.hiAt}` : ""],
          ["Put OI", cnt(now.pe), "", "In scope"],
          ["Call OI", cnt(now.ce), "", `${formatInt(crossings.length)} crossing${crossings.length === 1 ? "" : "s"} of 1.00 today`],
        ],
        tools: [scope],
      }),
      panel(
        "Through the day",
        "The ratio at each recorded minute. The band is the balanced zone (0.80–1.20); dots mark crossings of 1.00. Hover for any minute.",
        timeChart({
          series: [{ cls: "pcr", points: pts }],
          refs: [{ v: 1, label: "1.00", cls: "one" }],
          band: [0.8, 1.2],
          marks: crossings.map((c) => ({ t: c.t, v: c.to, cls: c.dir === "up" ? "up" : "down", title: `${c.hm}: crossed ${c.dir === "up" ? "above" : "below"} 1.00 (${pcrText(c.from)} → ${pcrText(c.to)})` })),
          readout: (i) => `${series[i].hm} · PCR ${pcrText(series[i].pcr)} · puts ${cnt(series[i].pe)} · calls ${cnt(series[i].ce)} · spot ${formatFixed(series[i].spot, 2)}`,
          label: `Put-call ratio of ${u} ${e} through the session`,
        }),
        { wide: true },
      ),
      panel("By expiry", "The whole-chain ratio of each of the next expiries", expiryPanel),
      panel("By strike", "Put OI over call OI at each strike near the money, on a log scale around 1.00. Thin far strikes swing to extremes.", strikePcrBars(C.strikePcrs(latest, Math.min(each ?? 10, 10)), C.atmOf(latest))),
    ];
  });
}

/** One row per expiry: the date, a call / put split bar and the ratio in its band's ink. */
function expiryRows(list, current) {
  if (!list?.length) return h("p", { class: "muted small" }, "The other expiries could not be read.");
  return h(
    "ul",
    { class: "oix-xrows" },
    list.map((x) => {
      const w = pcrWord(x.pcr);
      const share = isFigure(x.ce) && isFigure(x.pe) && x.ce + x.pe > 0 ? x.pe / (x.ce + x.pe) : null;
      return h(
        "li",
        { class: x.expiry === current ? "cur" : undefined, title: `${dayText(x.expiry)}: puts ${cnt(x.pe)}, calls ${cnt(x.ce)}` },
        h("span", { class: "oix-xday" }, dayText(x.expiry)),
        h("span", { class: "oix-split", "data-v": share === null ? 0.5 : Math.round(share * 1000) / 1000 }, h("span", { class: "ce" }), h("span", { class: "pe" })),
        h("span", { class: `oix-num ${toneCls(w.tone)}` }, pcrText(x.pcr)),
        h("span", { class: "oix-quiet" }, w.word.toLowerCase()),
      );
    }),
  );
}

/** Strike PCR bars on a log scale: right of 1.00 for put-heavy (green), left for call-heavy (red). */
function strikePcrBars(rows, atm) {
  const lim = Math.log10(5);
  return h(
    "div",
    { class: "oix-spcr" },
    [...rows]
      .sort((a, b) => b.strike - a.strike)
      .map((r) => {
        const v = isFigure(r.pcr) && r.pcr > 0 ? Math.max(-lim, Math.min(lim, Math.log10(r.pcr))) / lim : null;
        return h(
          "div",
          { class: `oix-sprow${r.strike === atm ? " atm" : ""}`, title: `${formatInt(r.strike)}: puts ${cnt(r.pe)} ÷ calls ${cnt(r.ce)} = ${pcrText(r.pcr)}` },
          h("span", { class: "oix-ck" }, formatInt(r.strike)),
          h("span", { class: "oix-sptrack" }, v === null ? null : h("span", { class: `oix-spfill ${v >= 0 ? "pos" : "neg"}`, "data-v": Math.round(Math.abs(v) * 1000) / 1000 })),
          h("span", { class: `oix-num ${v === null ? "ink-zero" : v >= 0 ? "ink-pos" : "ink-neg"}` }, pcrText(r.pcr)),
        );
      }),
  );
}

// ───────────────────────── Max pain ─────────────────────────

async function renderMaxPain(H) {
  return recorderView(H, (day) => {
    const u = workspace.state.underlying;
    const e = workspace.state.expiry;
    if (!day.frames.length) return noDay(day, `${u} ${dayText(e)}`);
    const latest = day.frames.at(-1);
    const pc = C.painCurve(latest);
    if (!pc) return [freshRow(day), emptyState("chart", "Not enough open interest to read max pain", "Max pain needs at least three strikes with open interest.")];
    const floor = C.painFloor(pc);
    const series = C.painSeries(day.frames);
    const moves = C.painMoves(series);
    const first = series.find((x) => x.strike !== null);
    const gap = latest.spot - pc.strike;
    const rel = maxPainRelevance(e);
    const edge = pc.strike === latest.k[0] || pc.strike === latest.k.at(-1);
    return [
      freshRow(day),
      hero({
        title: "Max pain",
        word: formatInt(pc.strike),
        tone: "zero",
        detail: `The settlement price at which option holders of this expiry would collect least: ${rupees(pc.pain)} in all. Spot ${formatFixed(latest.spot, 2)} is ${formatFixed(Math.abs(gap), 0)} pts (${formatFixed((Math.abs(gap) / latest.spot) * 100, 2)}%) ${gap >= 0 ? "above" : "below"} it. A summary of the book, not a target.`,
        scope: `${u} ${dayText(e)} · ${formatInt(latest.k.length)} recorded strikes · as of ${latest.hm}${whenText(day)}${edge ? " · at the edge of the recorded strikes, so the true level may lie beyond" : ""}`,
        figs: [
          ["Floor", floor.word ? floor.word[0].toUpperCase() + floor.word.slice(1) : DASH, "", isFigure(floor.pct) ? `Next strike costs ${formatFixed(floor.pct, floor.pct < 1 ? 2 : 1)}% more` : ""],
          ["Moved today", formatInt(moves.length), "", first ? `From ${formatInt(first.strike)} at ${first.hm}` : ""],
          ["Spot gap", `${formatSigned(gap, 0)} pts`, signCls(gap), "Spot less max pain"],
          ["Relevance", rel ? rel[0].toUpperCase() + rel.slice(1) : DASH, "", "Higher in the last sessions before expiry"],
        ],
      }),
      panel("Pain by strike", "What holders would collect at each settlement price: calls (blue) and puts (orange) stacked. The lowest column is max pain. Hover for figures.", painColumns(pc, latest), { wide: true }),
      panel(
        "Through the day",
        "Max pain (step line) and spot at each recorded minute",
        timeChart({
          series: [
            { cls: "pain", step: true, points: series.map((x) => ({ t: x.t, hm: x.hm, v: x.strike })) },
            { cls: "spot", points: series.map((x) => ({ t: x.t, hm: x.hm, v: x.spot })) },
          ],
          marks: moves.map((m) => ({ t: m.t, v: m.to, cls: m.to > m.from ? "up" : "down", title: `${m.hm}: ${formatInt(m.from)} → ${formatInt(m.to)}` })),
          yFmt: (v) => formatInt(v),
          readout: (i) => `${series[i].hm} · max pain ${series[i].strike === null ? DASH : formatInt(series[i].strike)} · spot ${formatFixed(series[i].spot, 2)}`,
          label: `Max pain and spot of ${u} ${e} through the session`,
        }),
      ),
      panel(
        "Where it moved",
        "Each change of strike today, newest first",
        moves.length
          ? h("ol", { class: "oix-movers" }, [...moves].reverse().slice(0, 8).map((m) => h("li", {}, h("span", { class: "oix-quiet" }, m.hm), h("span", {}, `${formatInt(m.from)} → ${formatInt(m.to)}`), h("span", { class: `oix-num ${m.to > m.from ? "ink-pos" : "ink-neg"}` }, `${formatSigned(m.to - m.from, 0)} pts`))))
          : h("p", { class: "muted small" }, "It has held one strike all session."),
      ),
    ];
  });
}

/** Stacked columns of the pain at each strike, within ±12 strikes of the level, the level ringed and spot marked. */
function painColumns(pc, latest) {
  const i = pc.curve.findIndex((c) => c.strike === pc.strike);
  const list = pc.curve.slice(Math.max(0, i - 12), i + 13);
  const sig = `${pc.strike}|${Math.round(pc.pain)}|${Math.round(latest.spot)}|${list.length}`;
  return liveHost(sig, (w) => {
    const H = 260;
    const pad = { l: 8, r: 8, t: 20, b: 26 };
    const svg = svgRoot(w, H, `Pain by settlement strike; the lowest is ${formatInt(pc.strike)}`);
    svg.classList.add("oix-chart");
    const max = Math.max(1, ...list.map((c) => c.pain));
    const bw = (w - pad.l - pad.r) / list.length;
    const Y = (v) => (v / max) * (H - pad.t - pad.b);
    const every = Math.max(1, Math.ceil(56 / bw));
    list.forEach((c, j) => {
      const x = pad.l + j * bw + bw * 0.15;
      const cw = Math.max(2, bw * 0.7);
      const yc = H - pad.b - Y(c.call);
      const yp = yc - Y(c.put);
      const on = c.strike === pc.strike;
      const title = `${formatInt(c.strike)}: calls ${rupees(c.call)} + puts ${rupees(c.put)} = ${rupees(c.pain)}${on ? " · max pain" : ` · ${rupees(c.pain - pc.pain)} more than max pain`}`;
      svg.append(s("g", { class: `oix-pcol${on ? " lvl" : ""}` }, s("rect", { class: "ce", x, y: yc, width: cw, height: Math.max(0, Y(c.call)), rx: 2 }), s("rect", { class: "pe", x, y: yp, width: cw, height: Math.max(0, Y(c.put)), rx: 2 }), s("title", {}, title)));
      if (on || j % every === 0) svg.append(s("text", { class: on ? "tick strong" : "tick", x: x + cw / 2, y: H - 8, "text-anchor": "middle" }, formatInt(c.strike)));
      if (on) svg.append(s("text", { class: "oix-ref-label lvl", x: x + cw / 2, y: yp - 6, "text-anchor": "middle" }, "Max pain"));
    });
    // Spot between strikes.
    const lo = list[0].strike;
    const hi = list.at(-1).strike;
    if (latest.spot >= lo && latest.spot <= hi && list.length > 1) {
      const step = (hi - lo) / (list.length - 1);
      const sx = pad.l + ((latest.spot - lo) / step) * bw + bw / 2;
      svg.append(s("line", { class: "oix-spotline", x1: sx, x2: sx, y1: pad.t - 6, y2: H - pad.b }), s("text", { class: "oix-ref-label", x: sx, y: pad.t - 8, "text-anchor": "middle" }, `Spot ${formatFixed(latest.spot, 0)}`));
    }
    return svg;
  });
}

// ───────────────────────── OI heatmap ─────────────────────────

const STEPS = [["15", "15m"], ["30", "30m"], ["60", "1h"]];
const HM_WINDOWS = [["all", "Session"], ["60", "Last 1h"], ["30", "Last 30m"], ["15", "Last 15m"], ["custom", "Custom"]];

/** The readings the heatmap is built from: the whole session, the last stretch before the newest, or From–To. */
function hmFrames(frames, p) {
  if (p.hmWin === "custom") return C.framesBetween(frames, p.from, p.to);
  if (p.hmWin === "all" || !frames.length) return frames;
  const from = frames.at(-1).t - Number(p.hmWin) * 60_000;
  return frames.filter((f) => f.t >= from);
}

async function renderHeatmap(H) {
  const host = h("div", { class: "stack" });
  // A fresh switch for every drawing (a patch draws off-screen: a shared node would be taken out of the page).
  const makeMode = () => {
    const m = H.segmented("Heatmap", [["day", "Through the day"], ["expiry", "By expiry"]], prefs().hmMode);
    m.classList.add("oix-cap");
    m.addEventListener("change", () => {
      if (m.value === prefs().hmMode) return;
      savePref("hmMode", m.value);
      show();
    });
    return m;
  };
  const show = async () => {
    host.replaceChildren(h("p", { class: "muted", role: "status" }, "Loading…"));
    const node = prefs().hmMode === "expiry" ? await byExpiryHeat(H, makeMode()) : await throughTheDay(H, makeMode);
    host.replaceChildren(...[node].flat().filter(Boolean));
  };
  await show();
  return host;
}

/** Strike × time for one expiry: calls on the left, puts on the right, the newest column beside the strike. */
function throughTheDay(H, makeMode) {
  return recorderView(H, (day, again) => {
    const u = workspace.state.underlying;
    const e = workspace.state.expiry;
    const mode = makeMode();
    if (!day.frames.length) return [...noDay(day, `${u} ${dayText(e)}`), hero({ title: "OI heatmap", word: "Nothing recorded yet", tools: [mode] })];
    const p = prefs();
    const lead = capsule(H, "Tiles lead with", "lead", [["oi", "OI"], ["chg", "Change"]], again);
    const custom = customise(
      H,
      "OI heatmap",
      [
        ["Chart shows", "hmWin", HM_WINDOWS, "The plane is built from this stretch only, and its colours are measured again for it. Custom picks From and To in 15-minute steps"],
        ["Column step", "step", STEPS, "Each column is the last reading in its step"],
        ["Tile colour", "colour", [["buildup", "Build-up"], ["amount", "Amount"]], "Build-up: green where the premium rose, red where it fell. Amount: deeper is more OI"],
        ["Sides", "side", [["both", "Both"], ["ce", "Calls"], ["pe", "Puts"]], null],
      ],
      again,
    );
    const range = p.hmWin === "custom" ? windowTools(H, again, "hmWin").slice(1) : [];
    const shown = hmFrames(day.frames, p);
    const tools = [mode, lead, ...range, custom];
    if (!shown.length) return [freshRow(day), hero({ title: "OI heatmap", word: "No readings in this window", detail: p.hmWin === "custom" ? `Nothing was recorded between ${p.from} and ${p.to}. Pick another stretch in Customise.` : "Nothing was recorded in this stretch yet.", tools })];
    const latest = shown.at(-1);
    const cols = C.timeColumns(shown, Number(p.step));
    const strikes = C.scopeStrikes(latest, workspace.state.strikes ?? 10);
    const plane = C.heatPlane(cols, strikes);
    const atm = C.atmOf(latest);
    const mp = C.painCurve(latest)?.strike ?? null;
    const moves = C.legMoves(cols[0], latest, { strikes, thinOi: Math.max(5000, 20 * latest.lot) });
    const t = C.changeByStrike(moves).totals;
    const reading = C.changeReading(t);
    const loudest = [...moves].sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    const sides = p.side === "both" ? ["ce", "pe"] : [p.side];
    return [
      freshRow(day),
      hero({
        title: "OI heatmap",
        word: cols.length < 2 ? "One reading so far" : reading.word,
        tone: cols.length < 2 ? "zero" : reading.tone,
        detail: cols.length < 2 ? "A change needs two columns; the plane grows as the session is recorded." : `Since ${cols[0].hm}: puts ${sCnt(t.pe)}, calls ${sCnt(t.ce)} on the strikes drawn.${loudest ? ` The largest single move is ${legName(loudest)} at ${sCnt(loudest.d)}.` : ""}`,
        scope: `${u} ${dayText(e)} · ${HM_WINDOWS.find((x) => x[0] === p.hmWin)?.[1] ?? "Session"}${p.hmWin === "custom" ? ` ${p.from}–${p.to}` : ""} · ${formatInt(cols.length)} columns of ${STEPS.find((x) => x[0] === p.step)?.[1] ?? ""} · ±${workspace.state.strikes ?? 10} strikes · newest ${latest.hm}${whenText(day, latest)}`,
        figs: [
          ["Spot", formatFixed(latest.spot, 2), "", `ATM ${formatInt(atm)}`],
          ["Max pain", mp === null ? DASH : formatInt(mp), "", "Whole recorded expiry"],
          ["Call OI", cnt(C.scopedTotals(latest, workspace.state.strikes ?? 10).ce), "", "On the strikes drawn"],
          ["Put OI", cnt(C.scopedTotals(latest, workspace.state.strikes ?? 10).pe), "", "On the strikes drawn"],
        ],
        tools,
      }),
      panel(
        "Open interest through the session",
        p.colour === "buildup" ? "Each tile is one strike at one time. Green: premium rose against the column before; red: it fell; deeper is a bigger change. Codes name the build-up. The three largest tiles of each side are ringed." : "Each tile is one strike at one time; deeper is more open interest within its side. The three largest tiles of each side are ringed.",
        heatTable(plane, cols, { sides, lead: p.lead, colour: p.colour, atm, mp, spot: latest.spot }),
        { wide: true },
      ),
    ];
  });
}

/** The plane as a table. */
function heatTable(plane, cols, { sides, lead, colour, atm, mp, spot }) {
  const tops = { ce: C.planeTop(plane, "ce", 3, lead === "chg" ? "d" : "oi"), pe: C.planeTop(plane, "pe", 3, lead === "chg" ? "d" : "oi") };
  // Calls run oldest → newest towards the strike; puts newest → oldest away from it.
  const order = (side) => (side === "ce" ? cols.map((_, i) => i) : cols.map((_, i) => cols.length - 1 - i));
  const head = h(
    "tr",
    {},
    sides.includes("ce") ? order("ce").map((i) => h("th", { scope: "col", class: `oix-th ce${i === cols.length - 1 ? " now" : ""}` }, cols[i].hm)) : null,
    h("th", { scope: "col", class: "oix-th k" }, "Strike"),
    sides.includes("pe") ? order("pe").map((i) => h("th", { scope: "col", class: `oix-th pe${i === cols.length - 1 ? " now" : ""}` }, cols[i].hm)) : null,
  );
  const tile = (row, side, i) => {
    const c = row[side][i];
    const lit = tops[side].has(`${row.strike}|${i}`);
    const strength = colour === "amount" ? C.shade(c.oi, plane.max[side]) : C.shade(c.d, plane.max[`d${side}`]);
    const hue = colour === "amount" ? side : c.code === "LB" || c.code === "SC" ? "pos" : c.code === "SB" || c.code === "LU" ? "neg" : "none";
    const fig = lead === "chg" ? (c.d === null ? DASH : sCnt(c.d)) : c.oi === null ? DASH : cnt(c.oi);
    const title = `${formatInt(row.strike)} ${sideName(side)} at ${cols[i].hm}: OI ${c.oi === null ? DASH : cnt(c.oi)} · change ${c.d === null ? "first reading" : sCnt(c.d)}${c.code ? ` · ${C.BUILDUPS[c.code].name}` : ""}${c.px !== null ? ` · premium ${formatFixed(c.px, 2)}` : ""}`;
    return h("td", { class: `oix-tile h-${hue}${lit ? " lit" : ""}`, "data-a": strength, title }, h("span", { class: "oix-tfig" }, fig), c.code ? h("span", { class: "oix-tcode" }, c.code) : null);
  };
  const body = plane.rows.map((row, ri) => {
    const next = plane.rows[ri + 1];
    const tr = h(
      "tr",
      { class: `${row.strike === atm ? "atm" : ""}${next && row.strike > spot && next.strike <= spot ? " above-spot" : ""}` },
      sides.includes("ce") ? order("ce").map((i) => tile(row, "ce", i)) : null,
      h("th", { scope: "row", class: "oix-tk" }, formatInt(row.strike), row.strike === atm ? h("span", { class: "oix-tag" }, "ATM") : null, row.strike === mp ? h("span", { class: "oix-tag mp" }, "MP") : null),
      sides.includes("pe") ? order("pe").map((i) => tile(row, "pe", i)) : null,
    );
    return tr;
  });
  return h("div", { class: "table-wrap scroll-x oix-heat" }, h("table", {}, h("thead", {}, head), h("tbody", {}, body)));
}

/** Strike × expiry (the OI explorer), with the PCR of each expiry above it. */
async function byExpiryHeat(H, mode) {
  const u = workspace.state.underlying;
  let d;
  try {
    d = (await api(`/v1/analytics/oi-explorer?${new URLSearchParams({ underlying: u, expiries: "4", strikes: String(workspace.state.strikes ?? 10) })}`)).data?.data ?? {};
  } catch (err) {
    return H.errorBox(err);
  }
  if (!(d.strikes ?? []).length) return [hero({ title: "OI heatmap", word: "No open interest to show", tools: [mode] })];
  const side = H.segmented("Show", [["total", "Calls + puts"], ["call", "Calls"], ["put", "Puts"]], "total");
  side.classList.add("oix-cap");
  const slot = h("div", {});
  const paint = () => slot.replaceChildren(heatmapTable(d, side.value));
  side.addEventListener("change", paint);
  paint();
  const pcrs = C.expiryPcrs(d.columns);
  const top = (d.topCells ?? [])[0];
  const word = pcrWord(d.totals?.pcr);
  return [
    hero({
      title: "OI heatmap",
      word: top ? `Largest: ${formatInt(top.strike)} ${top.side === "CE" ? "Call" : "Put"} · ${dayText(top.expiry)}` : DASH,
      tone: "zero",
      detail: top ? `${cnt(top.oi)} contracts open, the most of any strike, side and expiry shown. Across these expiries puts and calls read ${pcrText(d.totals?.pcr)} (${word.word.toLowerCase()}).` : "",
      scope: `${u} · ${formatInt((d.expiries ?? []).length)} expiries · ${formatInt(d.strikes.length)} strikes`,
      figs: pcrs.map((x) => [dayText(x.expiry), pcrText(x.pcr), toneCls(pcrWord(x.pcr).tone), "PCR"]).slice(0, 4),
      tools: [mode, side],
    }),
    panel("Open interest by strike and expiry", "Darker cells hold more open interest; the five largest carry their rank.", slot, { wide: true }),
  ];
}

// ───────────────────────── pages ─────────────────────────

/** The source pages analytics.js hosts (each one view). */
export function analyticsOiPages(getHelpers) {
  const group = "Markets";
  return [
    { id: "oix-change", label: "OI change", group, title: "OI change", sub: "Open interest added or cut over a window, by strike", render: () => renderOiChange(getHelpers()) },
    { id: "oix-spurts", label: "Spurts", group, title: "OI spurts", sub: "Legs whose open interest moved most, by build-up", render: () => renderSpurts(getHelpers()) },
    { id: "oix-pcr", label: "PCR", group, title: "Put-call ratio", sub: "Put OI over call OI, by scope, expiry, strike and through the day", render: () => renderPcr(getHelpers()) },
    { id: "oix-maxpain", label: "Max pain", group, title: "Max pain", sub: "The settlement strike that costs option holders least, and how it moved", render: () => renderMaxPain(getHelpers()) },
    { id: "oix-heatmap", label: "OI heatmap", group: "Analytics", title: "OI heatmap", sub: "Open interest by strike through the session, or by strike and expiry", render: () => renderHeatmap(getHelpers()) },
  ];
}
