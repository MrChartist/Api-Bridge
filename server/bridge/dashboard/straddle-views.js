// straddle-views.js: Analytics › Straddle, the four views beside the Overview, all from the recorder's minutes of the
// chain in view (GET /v1/options/snapshots, read once by exposure-suite.js and handed in as snapshotPoints):
//   Premium decay    each picked leg's change through the session (from the first reading, or from the reading
//                    before), and the legs' raw last prices on one scale beneath.
//   Multi-strike     up to 20 legs on one chart: one line each, Calls added against Puts added, or all added.
//   Multi-straddle   up to 10 strikes, each strike's Call + Put: one line each, or all added.
//   Price vs OI      one strike: its Call and Put prices, its straddle, its Call and Put OI and the OI change since the
//                    first reading, with that strike's own Put Call Ratio.
// A leg missing from a reading is a gap in its line, never a zero; a sum counts a reading only when every leg in it
// has a price (vol-suite-core.js sumLines). Picks are kept for the chain in view while the page is open.
import { chartSlot, h, icon } from "./app.js";
import { DASH, formatCompact, formatFixed, formatInt, formatSigned, isFigure } from "./format.js";
import { legend } from "./viz.js";
import {
  MULTI_LEG_MAX,
  MULTI_STRADDLE_MAX,
  decayLine,
  legLine,
  legName,
  lineEnds,
  nearestStrike,
  sessionStrikes,
  shadeOf,
  strikePcrLine,
  straddleTone,
  strikesAround,
  sumLines,
  changeSinceFirst,
} from "./vol-suite-core.js";

const IST_MS = 330 * 60_000;
const clock = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const rupee = (v) => (isFigure(v) ? `₹${formatFixed(v, 2)}` : DASH);
const signed2 = (v) => (isFigure(v) ? formatSigned(v, 2) : DASH);
const toneOf = (v) => (isFigure(v) && Number(v) > 0 ? "vs-pos" : isFigure(v) && Number(v) < 0 ? "vs-neg" : "");
const lakh = (v) => (isFigure(v) ? formatCompact(v) : DASH);
const AROUND = [["1", "±1"], ["2", "±2"], ["3", "±3"], ["5", "±5"], ["7", "±7"], ["10", "±10"]];

/** The picks per chain (underlying|expiry), kept while the page is open. */
const picks = new Map();
function picksFor(key, points) {
  if (!picks.has(key)) {
    const atm = points[points.length - 1]?.atm ?? null;
    picks.set(key, {
      decay: atm ? [{ strike: atm, side: "ce" }, { strike: atm, side: "pe" }] : [],
      multi: atm ? [{ strike: atm, side: "ce" }, { strike: atm, side: "pe" }] : [],
      straddles: atm ? strikesAround(sessionStrikes(points), atm, 1) : [],
      oiStrike: atm,
      baseline: "open",
      multiLines: "each",
      straddleLines: "each",
      hidden: new Set(),
    });
  }
  return picks.get(key);
}

/** A card the page lays out as a panel. */
function card({ title, sub, tools = [], body, wide = false }) {
  return h(
    "section",
    { class: `card vs-panel${wide ? " an-wide" : ""}` },
    h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, title), sub ? h("p", {}, sub) : null), tools.length ? h("div", { class: "card-actions vs-tools" }, tools) : null),
    h("div", { class: "card-body" }, body),
  );
}

/** The underlying beneath a chart, on its own scale. */
const spotPane = (u) => ({ id: "spot", weight: 0.9, label: `${u} spot`, format: (v) => formatInt(v) });
const spotSeries = (points) => ({ id: "spot", type: "line", pane: "spot", label: "Spot", tone: "spot", dash: true, legend: false, data: points.filter((p) => isFigure(p.spot)).map((p) => ({ t: p.t, v: p.spot })), format: (v) => formatFixed(v, 2) });

/** A leg's tone and shade: Calls in the Call colour, Puts in the Put colour, each later pick on a side paler. */
function legStyles(legs) {
  const count = { ce: 0, pe: 0 };
  return legs.map((l) => ({ ...l, tone: l.side === "pe" ? "put" : "call", shade: shadeOf(count[l.side]++) }));
}

/** The key under a chart: one toggle per line (a hidden line keeps its colour and place), shaded like its line. */
function keyRow(items, onToggle) {
  const el = legend(
    items.map((it) => ({ label: it.label, token: it.tone, kind: it.dash ? "dash" : "line", on: !it.hidden, onToggle: (on) => onToggle(it.id, on) })),
    { label: "Lines" },
  );
  const keys = el.querySelectorAll(".dv-key");
  items.forEach((it, i) => {
    if (it.shade && keys[i]) keys[i].setAttribute("data-shade", String(it.shade));
  });
  return el;
}

/** The figures under a chart: each line's last value and its change over the window, the largest move marked. */
function endsRow(items) {
  const rows = items.map((it) => ({ ...it, ends: lineEnds(it.data) })).filter((it) => it.ends);
  if (!rows.length) return null;
  const big = rows.reduce((b, r) => (Math.abs(r.ends.change) > Math.abs(b.ends.change) ? r : b));
  return h(
    "dl",
    { class: "vs-ends" },
    rows.map((r) =>
      h(
        "div",
        { class: `vs-end${r === big && rows.length > 1 ? " is-top" : ""}`, title: `${rupee(r.ends.first)} at ${clock(r.ends.firstT)} → ${rupee(r.ends.last)} at ${clock(r.ends.lastT)}` },
        h("dt", {}, h("span", { class: "vs-end-dot", "data-dv": r.tone, "data-shade": r.shade ? String(r.shade) : undefined, "aria-hidden": "true" }), r.label),
        h("dd", {}, rupee(r.ends.last), " ", h("span", { class: toneOf(Math.round(r.ends.change * 100)) }, signed2(r.ends.change))),
      ),
    ),
  );
}

/**
 * The leg picker: the picked legs as capsules (each removable), a strike and side to add one, and a quick add of
 * both legs of every strike within ±n of the ATM. `max` caps the picks (the Add buttons go quiet at it).
 */
function legPicker({ legs, strikes, atm, max, onChange, sides = true }) {
  const at = legs.length >= max;
  const styled = sides ? legStyles(legs) : legs.map((k, i) => ({ strike: k, ...straddleTone(i) }));
  const chips = styled.map((l, i) =>
    h(
      "span",
      { class: "vs-pick" },
      h("span", { class: "vs-end-dot", "data-dv": l.tone, "data-shade": l.shade ? String(l.shade) : undefined, "aria-hidden": "true" }),
      sides ? legName(l.strike, l.side) : formatInt(l.strike),
      l.strike === atm ? h("span", { class: "vs-pick-atm" }, "ATM") : null,
      h("button", { type: "button", class: "icon-btn tiny", "aria-label": `Remove ${sides ? legName(l.strike, l.side) : formatInt(l.strike)}`, onclick: () => onChange(legs.filter((_, j) => j !== i)) }, icon("close")),
    ),
  );
  const strikeSel = h("select", { "aria-label": "Strike" }, strikes.map((k) => h("option", { value: String(k), selected: k === atm || undefined }, `${formatInt(k)}${k === atm ? " · ATM" : ""}`)));
  const sideSel = sides ? h("select", { "aria-label": "Side" }, h("option", { value: "ce" }, "Call"), h("option", { value: "pe" }, "Put")) : null;
  const addOne = () => {
    const k = Number(strikeSel.value);
    const next = sides ? { strike: k, side: sideSel.value } : k;
    const same = (x) => (sides ? x.strike === next.strike && x.side === next.side : x === next);
    if (!legs.some(same) && legs.length < max) onChange([...legs, next]);
  };
  const aroundSel = h("select", { "aria-label": "Strikes around the ATM" }, AROUND.map(([v, t]) => h("option", { value: v }, `ATM ${t}`)));
  const addAround = () => {
    const ks = strikesAround(strikes, atm, Number(aroundSel.value));
    const add = sides ? ks.flatMap((k) => [{ strike: k, side: "ce" }, { strike: k, side: "pe" }]) : ks;
    const key = (x) => (sides ? `${x.strike}${x.side}` : String(x));
    const have = new Set(legs.map(key));
    onChange([...legs, ...add.filter((x) => !have.has(key(x)))].slice(0, max));
  };
  return h(
    "div",
    { class: "vs-picker" },
    h("div", { class: "vs-picks", role: "list", "aria-label": sides ? "Picked legs" : "Picked strikes" }, chips.length ? chips : h("span", { class: "muted small" }, sides ? "No legs picked" : "No strikes picked")),
    h(
      "div",
      { class: "vs-pick-add" },
      strikeSel,
      sideSel,
      h("button", { type: "button", class: "small", disabled: at || undefined, onclick: addOne }, icon("plus"), "Add"),
      atm ? aroundSel : null,
      atm ? h("button", { type: "button", class: "small plain", disabled: at || undefined, onclick: addAround }, "Add around ATM") : null,
      h("span", { class: "muted small vs-pick-count" }, at ? `${formatInt(max)} is the most this chart draws. Remove one to add another.` : Number.isFinite(max) ? `${formatInt(legs.length)} of ${formatInt(max)}` : `${formatInt(legs.length)} picked`),
    ),
  );
}

/** A chart card with its key and figures, redrawn in place by `draw()`. */
function chartCard({ title, sub, id, tools = [], wide = true }) {
  const slot = chartSlot(title, { id });
  const keys = h("div", { class: "vs-keys" });
  const ends = h("div", {});
  const el = card({ title, sub, tools, body: h("div", { class: "vs-chartbody" }, slot ?? h("p", { class: "muted" }, "Chart unavailable. Reload the page to try again."), keys, ends), wide });
  return { el, set: (spec) => slot?.chart.set(spec), keys, ends };
}

// ───────────────────────── Premium decay ─────────────────────────

function decayView({ points, u, e, H, p, rerender }) {
  const strikes = sessionStrikes(points);
  const atm = points[points.length - 1]?.atm ?? null;
  const base = H.segmented("Baseline", [["open", "Since open"], ["prev", "Per reading"]], p.baseline);
  base.addEventListener("change", () => ((p.baseline = base.value), draw()));
  const top = chartCard({ title: "Premium decay", sub: "Each picked leg's change in points: from its first reading, or from the reading before (the first reading has nothing before it and is left out).", id: "vs-decay", tools: [base] });
  const raw = chartCard({ title: "Call vs Put premium", sub: "The same legs' last traded prices on one scale.", id: "vs-decay-raw" });
  const picker = legPicker({ legs: p.decay, strikes, atm, max: Infinity, onChange: (legs) => ((p.decay = legs), rerender()) });
  function draw() {
    const legs = legStyles(p.decay).map((l) => ({ ...l, id: `${l.strike}${l.side}`, label: legName(l.strike, l.side), line: legLine(points, l.strike, l.side) }));
    if (!legs.length) {
      for (const c of [top, raw]) {
        c.set({ empty: { title: "No legs picked", text: "Pick legs above: a strike and a side, or both legs around the ATM." } });
        c.keys.replaceChildren();
        c.ends.replaceChildren();
      }
      return;
    }
    const shown = legs.filter((l) => !p.hidden.has(l.id));
    const decayed = legs.map((l) => ({ ...l, data: decayLine(l.line, p.baseline) }));
    const series = (list, fmt) => list.filter((l) => !p.hidden.has(l.id)).map((l) => ({ id: l.id, type: "line", pane: "main", label: l.label, tone: l.tone, shade: l.shade, legend: false, data: l.data, format: fmt }));
    top.set({ label: `${u} ${e}: the change of ${shown.length} legs through the session`, panes: [{ id: "main", weight: 3, include: [0], format: (v) => formatFixed(v, 0) }, spotPane(u)], series: [...series(decayed, signed2), spotSeries(points)] });
    raw.set({ label: `${u} ${e}: the last traded price of ${shown.length} legs through the session`, panes: [{ id: "main", weight: 3, format: (v) => formatFixed(v, 0) }, spotPane(u)], series: [...series(legs.map((l) => ({ ...l, data: l.line })), rupee), spotSeries(points)] });
    const toggle = (id, on) => {
      if (on) p.hidden.delete(id);
      else p.hidden.add(id);
      draw();
    };
    for (const c of [top, raw]) c.keys.replaceChildren(keyRow(legs.map((l) => ({ ...l, hidden: p.hidden.has(l.id) })), toggle));
    raw.ends.replaceChildren(endsRow(legs.map((l) => ({ ...l, data: l.line }))) ?? "");
    top.ends.replaceChildren();
  }
  draw();
  return [card({ title: "Legs", sub: "Both legs of the ATM strike to start. A leg missing from a reading is a gap in its line.", body: picker, wide: true }), top.el, raw.el];
}

// ───────────────────────── Multi-strike ─────────────────────────

function multiView({ points, u, e, H, p, rerender }) {
  const strikes = sessionStrikes(points);
  const atm = points[points.length - 1]?.atm ?? null;
  const lines = H.segmented("Lines", [["each", "Individual"], ["sides", "Call vs Put"], ["all", "Combined"]], p.multiLines);
  lines.addEventListener("change", () => ((p.multiLines = lines.value), draw()));
  const c = chartCard({ title: "Multi-strike", sub: "The picked legs' last traded prices. Added lines count a reading only when every leg in them has a price. A sum of legs is a price per unit, not a position.", id: "vs-multi", tools: [lines] });
  const picker = legPicker({ legs: p.multi, strikes, atm, max: MULTI_LEG_MAX, onChange: (legs) => ((p.multi = legs), rerender()) });
  function draw() {
    const legs = legStyles(p.multi).map((l) => ({ ...l, id: `${l.strike}${l.side}`, label: legName(l.strike, l.side), data: legLine(points, l.strike, l.side) }));
    if (!legs.length) {
      c.set({ empty: { title: "No legs picked yet", text: "Pick up to 20 legs above." } });
      c.keys.replaceChildren();
      c.ends.replaceChildren();
      return;
    }
    let items = legs;
    if (p.multiLines === "sides") {
      const ce = legs.filter((l) => l.side === "ce");
      const pe = legs.filter((l) => l.side === "pe");
      items = [ce.length ? { id: "ce", label: `Calls added (${ce.length})`, tone: "call", shade: 0, data: sumLines(ce.map((l) => l.data)) } : null, pe.length ? { id: "pe", label: `Puts added (${pe.length})`, tone: "put", shade: 0, data: sumLines(pe.map((l) => l.data)) } : null].filter(Boolean);
    } else if (p.multiLines === "all") items = [{ id: "all", label: `All ${legs.length} legs added`, tone: "iv", shade: 0, data: sumLines(legs.map((l) => l.data)) }];
    const shown = items.filter((l) => !p.hidden.has(l.id));
    c.set({ label: `${u} ${e}: ${shown.length} lines of picked legs through the session`, panes: [{ id: "main", weight: 3, format: (v) => formatFixed(v, 0) }, spotPane(u)], series: [...shown.map((l) => ({ id: l.id, type: "line", pane: "main", label: l.label, tone: l.tone, shade: l.shade, legend: false, data: l.data, format: rupee })), spotSeries(points)] });
    c.keys.replaceChildren(keyRow(items.map((l) => ({ ...l, hidden: p.hidden.has(l.id) })), (id, on) => (on ? p.hidden.delete(id) : p.hidden.add(id), draw())));
    c.ends.replaceChildren(endsRow(items) ?? "");
  }
  draw();
  return [card({ title: "Legs", sub: "Up to 20 legs: a Call far above and a Put far below, or a basket of several.", body: picker, wide: true }), c.el];
}

// ───────────────────────── Multi-straddle ─────────────────────────

function straddlesView({ points, u, e, H, p, rerender }) {
  const strikes = sessionStrikes(points);
  const atm = points[points.length - 1]?.atm ?? null;
  const lines = H.segmented("Lines", [["each", "Individual"], ["all", "Combined"]], p.straddleLines);
  lines.addEventListener("change", () => ((p.straddleLines = lines.value), draw()));
  const c = chartCard({ title: "Multi-straddle", sub: "Each picked strike's Call plus Put through the session: the premium falls away from the money. Combined adds them at readings where every strike has a price.", id: "vs-straddles", tools: [lines] });
  const picker = legPicker({ legs: p.straddles, strikes, atm, max: MULTI_STRADDLE_MAX, sides: false, onChange: (ks) => ((p.straddles = ks), rerender()) });
  function draw() {
    const items0 = p.straddles.map((k, i) => ({ id: `s${k}`, strike: k, label: `${formatInt(k)} straddle${k === atm ? " · ATM" : ""}`, ...straddleTone(i), data: sumLines([legLine(points, k, "ce"), legLine(points, k, "pe")]) }));
    if (!items0.length) {
      c.set({ empty: { title: "No strikes picked yet", text: "Pick up to 10 strikes above." } });
      c.keys.replaceChildren();
      c.ends.replaceChildren();
      return;
    }
    const items = p.straddleLines === "all" ? [{ id: "all", label: `${items0.length} straddles added`, tone: "iv", shade: 0, data: sumLines(items0.map((x) => x.data)) }] : items0;
    const shown = items.filter((l) => !p.hidden.has(l.id));
    c.set({ label: `${u} ${e}: ${shown.length} straddles through the session`, panes: [{ id: "main", weight: 3, format: (v) => formatFixed(v, 0) }, spotPane(u)], series: [...shown.map((l) => ({ id: l.id, type: "line", pane: "main", label: l.label, tone: l.tone, shade: l.shade, legend: false, data: l.data, format: rupee })), spotSeries(points)] });
    c.keys.replaceChildren(keyRow(items.map((l) => ({ ...l, hidden: p.hidden.has(l.id) })), (id, on) => (on ? p.hidden.delete(id) : p.hidden.add(id), draw())));
    c.ends.replaceChildren(endsRow(items) ?? "");
  }
  draw();
  return [card({ title: "Strikes", sub: "Up to 10 whole strikes; the ATM and one either side to start.", body: picker, wide: true }), c.el];
}

// ───────────────────────── Price vs OI ─────────────────────────

function oiView({ points, u, e, p, rerender }) {
  const strikes = sessionStrikes(points);
  const atm = points[points.length - 1]?.atm ?? null;
  const k = strikes.includes(p.oiStrike) ? p.oiStrike : nearestStrike(strikes, atm);
  const sel = h("select", { "aria-label": "Strike" }, strikes.map((x) => h("option", { value: String(x), selected: x === k || undefined }, `${formatInt(x)}${x === atm ? " · ATM" : ""}`)));
  sel.addEventListener("change", () => ((p.oiStrike = Number(sel.value)), rerender()));
  if (!k) return [card({ title: "Price vs OI", body: h("p", { class: "muted" }, "No strike recorded for this chain today."), wide: true })];
  const ce = legLine(points, k, "ce");
  const pe = legLine(points, k, "pe");
  const ceOi = legLine(points, k, "ce", "oi");
  const peOi = legLine(points, k, "pe", "oi");
  const pcr = strikePcrLine(points, k);
  const pcrPane = { id: "pcr", weight: 0.8, label: "Strike PCR", format: (v) => formatFixed(v, 2) };
  const pcrSeries = { id: "pcr", type: "line", pane: "pcr", label: "Strike PCR", tone: "muted", dash: true, data: pcr, format: (v) => formatFixed(v, 2) };
  const name = `${formatInt(k)}`;
  const price = chartCard({ title: "Price, Call vs Put", sub: `The ${name} Call and Put last prices, and the strike's own Put Call Ratio (its Put OI ÷ Call OI) beneath.`, id: "vs-oi-price", wide: false });
  price.set({ label: `${u} ${e} ${name}: Call and Put last price and strike PCR`, panes: [{ id: "main", weight: 3, format: (v) => formatFixed(v, 0) }, pcrPane], series: [{ id: "ce", type: "line", pane: "main", label: `${name} CE`, tone: "call", data: ce, format: rupee }, { id: "pe", type: "line", pane: "main", label: `${name} PE`, tone: "put", data: pe, format: rupee }, pcrSeries] });
  const st = chartCard({ title: "Straddle premium", sub: `The ${name} Call plus Put, and the same ratio beneath.`, id: "vs-oi-straddle", wide: false });
  st.set({ label: `${u} ${e} ${name}: straddle premium and strike PCR`, panes: [{ id: "main", weight: 3, format: (v) => formatFixed(v, 0) }, pcrPane], series: [{ id: "st", type: "line", pane: "main", label: `${name} straddle`, tone: "iv", data: sumLines([ce, pe]), format: rupee }, pcrSeries] });
  const oi = chartCard({ title: "Open interest, Call vs Put", sub: "Published by the exchange in steps, so the lines move in steps.", id: "vs-oi-oi", wide: false });
  oi.set({ label: `${u} ${e} ${name}: Call and Put open interest`, panes: [{ id: "main", format: lakh }], series: [{ id: "ceoi", type: "line", pane: "main", label: `${name} CE OI`, tone: "call", data: ceOi, format: lakh }, { id: "peoi", type: "line", pane: "main", label: `${name} PE OI`, tone: "put", data: peOi, format: lakh }] });
  const ch = chartCard({ title: "OI change since the first reading", sub: "Each side's open interest against its first reading today, signed. A gap where either is not known, never a zero.", id: "vs-oi-chg", wide: false });
  const ceCh = changeSinceFirst(ceOi);
  const peCh = changeSinceFirst(peOi);
  ch.set({ label: `${u} ${e} ${name}: Call and Put OI change since the first reading`, panes: [{ id: "main", include: [0], format: lakh }], series: [{ id: "cech", type: "line", pane: "main", label: `${name} CE change`, tone: "call", data: ceCh, format: (v) => formatCompact(v, { signed: true }) }, { id: "pech", type: "line", pane: "main", label: `${name} PE change`, tone: "put", data: peCh, format: (v) => formatCompact(v, { signed: true }) }] });
  const e1 = lineEnds(ceOi);
  const e2 = lineEnds(peOi);
  ch.ends.replaceChildren(
    e1 || e2
      ? h(
          "dl",
          { class: "vs-ends" },
          [["CE", e1, "call"], ["PE", e2, "put"]].map(([s, x, tone]) => h("div", { class: "vs-end" }, h("dt", {}, h("span", { class: "vs-end-dot", "data-dv": tone, "aria-hidden": "true" }), `${name} ${s} OI`), h("dd", {}, x ? lakh(x.last) : DASH, " ", h("span", { class: toneOf(x?.change) }, x ? formatCompact(x.change, { signed: true }) : "")))),
        )
      : "",
  );
  return [card({ title: "Strike", sub: "One strike's prices and the positions built at it, from the same readings.", tools: [sel], body: h("p", { class: "muted small" }, "The ratio is this strike's Put OI ÷ Call OI only, left out where the Call OI is zero or a leg is missing."), wide: true }), price.el, st.el, oi.el, ch.el];
}

/** The views the Straddle page offers beside its Overview. */
export const STRADDLE_VIEWS = Object.freeze([
  ["overview", "Overview"],
  ["decay", "Premium decay"],
  ["multi", "Multi-strike"],
  ["straddles", "Multi-straddle"],
  ["oi", "Price vs OI"],
]);

/**
 * The nodes of one view for the chain in view. `rerender()` asks the page to draw the view again (after a pick).
 * @param {"decay"|"multi"|"straddles"|"oi"} view
 */
export function straddleView(view, { points, u, e, H, rerender }) {
  const p = picksFor(`${u}|${e}`, points);
  const args = { points, u, e, H, p, rerender };
  if (view === "decay") return decayView(args);
  if (view === "multi") return multiView(args);
  if (view === "straddles") return straddlesView(args);
  return oiView(args);
}
