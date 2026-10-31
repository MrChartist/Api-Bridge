// exposure-suite.js: Analytics › Exposure › By strike, By expiry and Straddle.
//
// One clear reading per view, at the top: the GEX verdict and the solved gamma flip; the ATM straddle with its moves.
// The figures behind each reading are a hover (a strike's card, a point on the curve) or a row further down.
//   By strike   GET /v1/analytics/exposure (greekExposure + gexProfile): the strike profile with level badges, where
//               the sign changes (the re-priced curve), the levels and every strike; then the session
//               (GET /v1/analytics/exposure/session: the book re-solved at each recorded reading) as three cards, and
//               the replay, which moves every figure above to the reading picked (`&at=` gives that reading in full).
//   By expiry   GET /v1/analytics/exposure/expiries: each expiry's net gamma, flip, walls and verdict side by side.
//   Straddle    GET /v1/options/snapshots (the recorder's minutes: the forward-anchored ATM straddle through the day,
//               the time-alone line and the split of its change), GET /v1/optionchain per expiry (the comparison), and
//               GET /v1/analytics/straddle when the recorder has nothing for this chain. The same minutes feed the
//               four leg views beside the Overview (straddle-views.js). Sessions left come from the exchange holiday
//               calendar (vol-today.js tradingCalendar).
// Maths in vol-suite-core.js (tested); pricing in pricing.js. Read-only; nothing here polls (the replay reads one
// recorded reading per step, only while it is open).
import { api, chartSlot, emptyState, h, icon } from "./app.js";
import { DASH, MINUS, formatDayMonth, formatFixed, formatInt, formatPercent, formatSigned, isFigure } from "./format.js";
import { TAG_CHAR_W, chartHeight, compact, chartHost, dataDisclosure, niceScale, s, statusRow, svgRoot } from "./analyticsViews.js";
import { workspace } from "./workspace.js";
import { tradingCalendar } from "./vol-today.js";
import { STRADDLE_VIEWS, straddleView } from "./straddle-views.js";
import {
  GEX_WORDS,
  badgeLanes,
  changeOver,
  expiryRow,
  extremes,
  flipGist,
  gexSessionModel,
  gexSessionSpecs,
  leanText,
  nearestIndex,
  nearestStrikes,
  premiumVerdict,
  rupeeCr,
  sigmaMovePts,
  snapshotPoints,
  straddleLevels,
  straddleSpec,
  straddleSplit,
} from "./vol-suite-core.js";

const IST_MS = 330 * 60_000;
const shortDay = (iso) => formatDayMonth(iso) || DASH;
const r1 = (v) => Math.round(v * 10) / 10;
const clock = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const toneOf = (v) => (isFigure(v) && Number(v) > 0 ? "vs-pos" : isFigure(v) && Number(v) < 0 ? "vs-neg" : "");
const pts = (v, dp = 0) => (isFigure(v) ? `${formatFixed(v, dp)}` : DASH);
const level = (v) => (isFigure(v) ? formatInt(v) : DASH);
const signedPts = (v, dp = 0) => (isFigure(v) ? formatSigned(v, dp) : DASH);
const rupee = (v, dp = 2) => (isFigure(v) ? `₹${formatFixed(v, dp)}` : DASH);
const signedRupee = (v, dp = 2) => (isFigure(v) ? `${Number(v) < 0 ? MINUS : "+"}₹${formatFixed(Math.abs(v), dp)}` : DASH);
const span = (cls, text) => h("span", { class: cls || undefined }, text);
const loading = () => h("p", { class: "muted", role: "status" }, "Loading…");

/** A card the desk lays out as a panel; `tools` sit in its head, `wide` spans the row. */
function panel({ title, sub, tools = [], body, wide = false, cls = "" }) {
  return h(
    "section",
    { class: `card vs-panel ${cls}${wide ? " an-wide" : ""}`.trim() },
    h("header", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", {}, title), sub ? h("p", {}, sub) : null), tools.length ? h("div", { class: "card-actions vs-tools" }, tools) : null),
    h("div", { class: "card-body" }, body),
  );
}

/** The hero: one reading in large type with its pill, and the few figures that qualify it as quiet chips. */
function hero({ pillText, pillTone, label, value, valueTone = "", gist, chips = [], replay = false }) {
  return h(
    "section",
    { class: `card vs-hero an-wide${replay ? " is-replay" : ""}`, "aria-label": label },
    h(
      "div",
      { class: "card-body vs-hero-body" },
      h(
        "div",
        { class: "vs-hero-main" },
        pillText ? h("span", { class: `vs-verdict ${pillTone ?? ""}`.trim() }, pillText) : null,
        h("div", { class: "vs-hero-figure" }, h("span", { class: "vs-hero-label" }, label), h("span", { class: `vs-hero-value ${valueTone}`.trim() }, value)),
        gist ? h("p", { class: "vs-hero-gist" }, gist) : null,
      ),
      h(
        "dl",
        { class: "vs-chips" },
        chips.filter(Boolean).map((c) => h("div", { class: "vs-chip", title: c.title ?? undefined }, h("dt", {}, c.k), h("dd", { class: c.tone || undefined }, c.v))),
      ),
    ),
  );
}

// ───────────────────────── GEX: the strike profile ─────────────────────────

/** Small rupee figures (delta, vanna, charm) in K / L / Cr with a true minus; gamma uses rupeeCr. */
const rupeeShort = (v) => (isFigure(v) ? `${Number(v) < 0 ? MINUS : ""}₹${compact(Math.abs(Number(v)))}` : DASH);
const GREEKS = {
  gamma: { label: "Gamma", call: "callGex", put: "putGex", net: "netGex", fmt: rupeeCr, unit: "₹ per 1% move" },
  delta: { label: "Delta", call: "callDelta", put: "putDelta", net: "netDelta", fmt: rupeeShort, unit: "₹ per index point" },
  vanna: { label: "Vanna", call: "callVanna", put: "putVanna", net: "netVanna", fmt: rupeeShort, unit: "₹ per point per vol point" },
  charm: { label: "Charm", call: "callCharm", put: "putCharm", net: "netCharm", fmt: rupeeShort, unit: "₹ per point per day" },
};
const PLOTS = [["net", "Net"], ["split", "Call vs Put"], ["both", "Both sides"]];

/** Where a price falls on the bar axis: interpolated between the centres of the two strikes around it; null outside. */
function priceX(price, rows, xOf) {
  if (!isFigure(price) || !rows.length) return null;
  const P = Number(price);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].strike === P) return xOf(i);
    if (i + 1 < rows.length && rows[i].strike < P && rows[i + 1].strike > P) return xOf(i) + ((xOf(i + 1) - xOf(i)) * (P - rows[i].strike)) / (rows[i + 1].strike - rows[i].strike);
  }
  return null;
}

/**
 * The strike profile: one bar per strike (Net from the zero rule, Call above and Put below, or both sides from the
 * floor), level badges on lanes over the bars with a thin rule at their price, the value axis on the right, and a
 * card for the strike under the pointer (a click pins it).
 */
function strikeProfile({ rows, greek, plot, levels, spot, label }) {
  const g = GREEKS[greek];
  const val = (r) => {
    const c = Number(r[g.call]) || 0;
    const p = Number(r[g.put]) || 0;
    return plot === "net" ? { a: Number(r[g.net]) || 0, b: 0 } : plot === "split" ? { a: c, b: p } : { a: Math.abs(c) + Math.abs(p), b: 0 };
  };
  const vals = rows.map(val);
  const peakAbs = Math.max(0, ...vals.map((v) => Math.max(Math.abs(v.a), Math.abs(v.b))));
  const maxIdx = vals.findIndex((v) => Math.max(Math.abs(v.a), Math.abs(v.b)) === peakAbs);
  let pinned = null;
  const wrap = h("div", { class: "vs-profile" });
  const tip = h("div", { class: "vs-tip", role: "status", "aria-live": "polite", hidden: true });
  const host = chartHost((w) => {
    const H = Math.max(300, Math.min(520, chartHeight(w) - 20));
    const padL = 6;
    const padR = 70;
    const padB = 28;
    const n = rows.length;
    const slot = (w - padL - padR) / Math.max(1, n);
    const xOf = (i) => padL + slot * (i + 0.5);
    // Badges first: their lanes set how much room sits above the plot.
    const badges = [];
    for (const lv of levels) {
      const x = priceX(lv.price, rows, xOf);
      const text = `${lv.name} ${level(lv.price)}`;
      const bw = text.length * TAG_CHAR_W + 18;
      if (x === null) {
        if (!isFigure(lv.price) || !rows.length) continue;
        const left = Number(lv.price) < rows[0].strike;
        badges.push({ ...lv, text: `${left ? "‹ " : ""}${text}${left ? "" : " ›"}`, x: left ? padL + bw / 2 : w - padR - bw / 2, w: bw + 10, off: true });
      } else badges.push({ ...lv, text, x: Math.min(w - padR - bw / 2, Math.max(padL + bw / 2, x)), at: x, w: bw });
    }
    const laid = badgeLanes(badges);
    const lanes = laid.reduce((m, b) => Math.max(m, b.lane + 1), 0);
    const padT = 10 + lanes * 26;
    const plotH = H - padT - padB;
    const lo = plot === "both" ? 0 : -peakAbs;
    const scale = niceScale(lo, peakAbs || 1, 4);
    const top = scale.max;
    const bottom = plot === "both" ? 0 : -Math.max(Math.abs(scale.min), top);
    const yOf = (v) => padT + ((top - v) / (top - bottom || 1)) * plotH;
    const svg = svgRoot(w, H, label);
    svg.setAttribute("class", "vs-svg"); // not .chart: the analytics chart text rules would override the badges
    for (const t of scale.ticks.filter((t) => t >= bottom - 1e-9 && t <= top + 1e-9)) {
      svg.append(s("line", { class: "vs-grid", x1: padL, x2: w - padR, y1: yOf(t), y2: yOf(t) }), s("text", { class: "vs-tick", x: w - padR + 8, y: yOf(t) + 4 }, t === 0 ? "0" : g.fmt(t)));
    }
    if (plot !== "both") svg.append(s("line", { class: "vs-zero", x1: padL, x2: w - padR, y1: yOf(0), y2: yOf(0) }));
    // Columns: a hover target over the whole height, then the bars.
    const cols = s("g", { class: "vs-cols" });
    const bw = Math.max(2, Math.min(28, slot * 0.68));
    rows.forEach((r, i) => {
      const x = xOf(i);
      const v = vals[i];
      const col = s("g", { class: `vs-col${i === maxIdx ? " is-max" : ""}${r.strike === pinned ? " is-pinned" : ""}`, "data-i": i });
      col.append(s("rect", { class: "vs-hit", x: x - slot / 2, y: padT, width: slot, height: plotH }));
      const bar = (value, cls) => {
        if (!value) return;
        const y1 = yOf(Math.max(0, value));
        const y2 = yOf(Math.min(0, value));
        col.append(s("rect", { class: `vs-bar ${cls}`, x: x - bw / 2, y: y1, width: bw, height: Math.max(1, y2 - y1), rx: Math.min(3, bw / 3) }));
      };
      if (plot === "net") bar(v.a, v.a >= 0 ? "pos" : "neg");
      else if (plot === "split") {
        bar(v.a, "call");
        bar(v.b, "put");
      } else bar(v.a, "both");
      cols.append(col);
    });
    svg.append(cols);
    // Strike rail: every k-th strike, always the one nearest spot.
    const every = Math.max(1, Math.ceil(46 / slot));
    const near = rows.reduce((b, r, i) => (isFigure(spot) && (b < 0 || Math.abs(r.strike - spot) < Math.abs(rows[b].strike - spot)) ? i : b), -1);
    rows.forEach((r, i) => {
      if (i === near || (i % every === 0 && (near < 0 || Math.abs(i - near) >= every / 2))) svg.append(s("text", { class: `vs-rail${i === near ? " is-near" : ""}`, x: xOf(i), y: H - 9, "text-anchor": "middle" }, formatInt(r.strike)));
    });
    // Levels: a thin rule at the price (not for a level off the plot), and its badge on a lane above.
    for (const b of laid) {
      const y = 6 + b.lane * 26;
      if (!b.off) svg.append(s("line", { class: `vs-rule lv-${b.id}`, x1: b.at, x2: b.at, y1: y + 20, y2: padT + plotH }));
      svg.append(s("g", { class: `vs-badge lv-${b.id}${b.off ? " is-off" : ""}` }, s("rect", { x: b.x - b.w / 2 + (b.off ? 5 : 0), y, width: b.w - (b.off ? 10 : 0), height: 20, rx: 10 }), s("text", { x: b.x, y: y + 14, "text-anchor": "middle" }, b.text)));
    }
    // Hover and pin.
    const show = (i, at) => {
      const r = rows[i];
      if (!r) return;
      for (const c of cols.children) c.classList.toggle("is-hover", Number(c.getAttribute("data-i")) === i);
      const both = Math.abs(Number(r[g.call]) || 0) + Math.abs(Number(r[g.put]) || 0);
      const measured = [g.call, g.put, g.net].some((k) => (Number(r[k]) || 0) !== 0);
      tip.replaceChildren(
        h("div", { class: "vs-tip-head" }, h("strong", {}, formatInt(r.strike)), r.strike === pinned ? h("span", { class: "vs-tip-pin" }, "pinned") : null, ...(levels.filter((lv) => lv.strike === r.strike).map((lv) => h("span", { class: `vs-tip-mark lv-${lv.id}` }, lv.name)))),
        measured
          ? h(
              "dl",
              { class: "vs-tip-grid" },
              h("dt", {}, "Call"),
              h("dd", {}, g.fmt(r[g.call])),
              h("dt", {}, "Put"),
              h("dd", {}, g.fmt(r[g.put])),
              h("dt", {}, "Net"),
              h("dd", { class: toneOf(r[g.net]) }, g.fmt(r[g.net])),
              h("dt", {}, "Both sides"),
              h("dd", {}, g.fmt(both)),
            )
          : h("p", { class: "muted small" }, "Not measured at this strike"),
      );
      tip.hidden = false;
      const x = xOf(i);
      tip.classList.toggle("flip", x > w * 0.6);
      tip.style.setProperty("--tip-x", `${Math.round(at ?? x)}px`);
      tip.style.setProperty("--tip-y", `${padT + 4}px`);
    };
    const hide = () => {
      if (pinned !== null) return show(rows.findIndex((r) => r.strike === pinned));
      tip.hidden = true;
      for (const c of cols.children) c.classList.remove("is-hover");
    };
    const colAt = (e) => {
      const box = svg.getBoundingClientRect();
      const x = ((e.clientX - box.left) / box.width) * w;
      return Math.max(0, Math.min(n - 1, Math.floor((x - padL) / slot)));
    };
    svg.addEventListener("pointermove", (e) => pinned === null && show(colAt(e)));
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("click", (e) => {
      const i = colAt(e);
      pinned = pinned === rows[i].strike ? null : rows[i].strike;
      for (const c of cols.children) c.classList.toggle("is-pinned", rows[Number(c.getAttribute("data-i"))].strike === pinned);
      if (pinned === null) hide();
      else show(i);
    });
    // Keyboard: the plot is one slider over the strikes.
    svg.setAttribute("tabindex", "0");
    svg.setAttribute("role", "slider");
    svg.setAttribute("aria-valuemin", String(rows[0]?.strike ?? 0));
    svg.setAttribute("aria-valuemax", String(rows[n - 1]?.strike ?? 0));
    let ki = near >= 0 ? near : 0;
    svg.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
      if (step) ki = Math.max(0, Math.min(n - 1, ki + step));
      else if (e.key === "Home") ki = 0;
      else if (e.key === "End") ki = n - 1;
      else if (e.key === "Escape") return (pinned = null), hide();
      else return;
      e.preventDefault();
      svg.setAttribute("aria-valuenow", String(rows[ki].strike));
      svg.setAttribute("aria-valuetext", `Strike ${formatInt(rows[ki].strike)}`);
      show(ki);
    });
    svg.addEventListener("blur", () => pinned === null && hide());
    return svg;
  });
  wrap.append(host, tip);
  return wrap;
}

/** Where the sign changes: the book re-priced at each price across the strikes, the flip where it crosses zero. */
function signCurve(profile, { underlying, from = null, to = null }) {
  // The span of the strikes drawn, widened to take in the flip, so the crossing is where the eye is.
  const lo = Math.min(...[from, profile?.flip].filter(isFigure).map(Number));
  const hi = Math.max(...[to, profile?.flip].filter(isFigure).map(Number));
  const pad = Number.isFinite(lo) && Number.isFinite(hi) ? (hi - lo) * 0.04 : 0;
  const curve = (profile?.curve ?? []).filter((p) => isFigure(p.price) && isFigure(p.net) && (!Number.isFinite(lo) || p.price >= lo - pad) && (!Number.isFinite(hi) || p.price <= hi + pad));
  if (curve.length < 2) return emptyState("chart", "No curve to draw", "The book needs strikes with a price and open interest either side of spot.", null, { compact: true });
  const readout = h("p", { class: "vs-readout", role: "status", "aria-live": "polite" }, "Hold the pointer over the curve to read the total at a price.");
  const host = chartHost((w) => {
    const H = Math.max(200, Math.min(300, Math.round(w * 0.32)));
    const padL = 6;
    const padR = 70;
    const padT = 14;
    const padB = 28;
    const x0 = curve[0].price;
    const x1 = curve[curve.length - 1].price;
    const xOf = (p) => padL + ((p - x0) / (x1 - x0)) * (w - padL - padR);
    const peak = Math.max(1, ...curve.map((p) => Math.abs(p.net)));
    const sc = niceScale(-peak, peak, 4);
    const top = Math.max(sc.max, -sc.min);
    const yOf = (v) => padT + ((top - v) / (2 * top)) * (H - padT - padB);
    const svg = svgRoot(w, H, `Net gamma exposure if ${underlying} stood at each price from ${formatInt(x0)} to ${formatInt(x1)}. Gamma flip ${level(profile.flip)}, spot ${level(profile.spot)}.`);
    svg.setAttribute("class", "vs-svg"); // not .chart: the analytics chart text rules would override the badges
    for (const t of sc.ticks.filter((t) => Math.abs(t) <= top + 1e-9)) svg.append(s("line", { class: "vs-grid", x1: padL, x2: w - padR, y1: yOf(t), y2: yOf(t) }), s("text", { class: "vs-tick", x: w - padR + 8, y: yOf(t) + 4 }, t === 0 ? "0" : rupeeCr(t)));
    const xt = niceScale(x0, x1, Math.max(3, Math.floor(w / 140)));
    for (const t of xt.ticks.filter((t) => t >= x0 && t <= x1)) svg.append(s("text", { class: "vs-rail", x: xOf(t), y: H - 9, "text-anchor": "middle" }, formatInt(t)));
    const line = curve.map((p, i) => `${i ? "L" : "M"}${r1(xOf(p.price))} ${r1(yOf(p.net))}`).join(" ");
    const area = `${line} L${r1(xOf(x1))} ${r1(yOf(0))} L${r1(xOf(x0))} ${r1(yOf(0))} Z`;
    const id = `vs-clip-${Math.random().toString(36).slice(2, 8)}`;
    svg.append(
      s("defs", {}, s("clipPath", { id: `${id}-up` }, s("rect", { x: padL, y: 0, width: w, height: yOf(0) })), s("clipPath", { id: `${id}-dn` }, s("rect", { x: padL, y: yOf(0), width: w, height: H }))),
      s("path", { class: "vs-area pos", d: area, "clip-path": `url(#${id}-up)` }),
      s("path", { class: "vs-area neg", d: area, "clip-path": `url(#${id}-dn)` }),
      s("line", { class: "vs-zero", x1: padL, x2: w - padR, y1: yOf(0), y2: yOf(0) }),
      s("path", { class: "vs-line", d: line }),
    );
    if (isFigure(profile.spot) && profile.spot >= x0 && profile.spot <= x1) svg.append(s("line", { class: "vs-rule lv-spot", x1: xOf(profile.spot), x2: xOf(profile.spot), y1: padT, y2: H - padB }), s("text", { class: "vs-mark-text", x: xOf(profile.spot) + 6, y: padT + 10 }, `Spot ${level(profile.spot)}`));
    if (isFigure(profile.flip) && profile.flip >= x0 && profile.flip <= x1) svg.append(s("circle", { class: "vs-flip-dot", cx: xOf(profile.flip), cy: yOf(0), r: 5 }), s("text", { class: "vs-mark-text lv-flip", x: xOf(profile.flip) + 8, y: yOf(0) - 8 }, `Flip ${level(profile.flip)}`));
    const cross = s("line", { class: "vs-cross", x1: 0, x2: 0, y1: padT, y2: H - padB, visibility: "hidden" });
    svg.append(cross);
    svg.addEventListener("pointermove", (e) => {
      const box = svg.getBoundingClientRect();
      const x = ((e.clientX - box.left) / box.width) * w;
      const price = x0 + ((x - padL) / (w - padL - padR)) * (x1 - x0);
      const p = curve.reduce((b, c) => (Math.abs(c.price - price) < Math.abs(b.price - price) ? c : b));
      cross.setAttribute("x1", String(xOf(p.price)));
      cross.setAttribute("x2", String(xOf(p.price)));
      cross.setAttribute("visibility", "visible");
      readout.replaceChildren(`If ${underlying} stood at `, h("strong", {}, formatInt(p.price)), ": net ", span(toneOf(p.net), rupeeCr(p.net)), " per 1% move", p.net > 0 ? ", hedging would lean against moves." : p.net < 0 ? ", hedging would run with moves." : ".");
    });
    svg.addEventListener("pointerleave", () => cross.setAttribute("visibility", "hidden"));
    return svg;
  });
  return h("div", { class: "vs-curve" }, host, readout);
}

const LEVEL_INFO = {
  spot: "The price of the underlying at the reading",
  flip: "Where the re-priced book's net gamma changes sign (solved, within 25% of spot)",
  cross: "Where the running total of Net, added from the lowest strike up, crosses zero. A display level: it does not re-price the book",
  callWall: "The strike above spot with the most Call gamma exposure (not the most Call OI)",
  putWall: "The strike below spot with the most Put gamma exposure (not the most Put OI)",
  heaviest: "The strike with the most gamma on both sides: where hedging would be heaviest, not which way it would lean",
};

function gexLevels(p) {
  return [
    { id: "putWall", name: "Put wall", price: p.putWall, strike: p.putWall },
    { id: "flip", name: "Flip", price: p.flip },
    { id: "spot", name: "Spot", price: p.spot },
    { id: "callWall", name: "Call wall", price: p.callWall, strike: p.callWall },
    { id: "cross", name: "Cross", price: p.ladderCross },
  ].filter((l) => isFigure(l.price));
}

/**
 * One reading of the book, as the hero, the strike profile, the sign curve and the levels: the live chain, or a
 * recorded reading the replay shows (`asOf`, epoch ms). `ctl` holds the Greek and Plot controls, which outlive a
 * reading (a replay keeps the choice).
 */
function gexReading(d, { u, e, st, ctl, asOf = null }) {
  const p = d.profile ?? {};
  const all = (d.strikes ?? []).filter((r) => isFigure(r.strike));
  const tone = p.verdict === "dampens" ? "pos" : p.verdict === "amplifies" ? "neg" : "";
  const levels = gexLevels(p);
  const slot = h("div", {});
  const shown = () => nearestStrikes(all, p.spot ?? d.underlyingLtp, 2 * (Number(st.strikes) || 10) + 1);
  ctl.paint = () => {
    const rows = shown();
    const g = GREEKS[ctl.state.greek];
    slot.replaceChildren(
      strikeProfile({ rows, greek: ctl.state.greek, plot: ctl.state.plot, levels: ctl.state.greek === "gamma" ? levels : levels.filter((l) => l.id === "spot"), spot: p.spot, label: `${g.label} exposure by strike for ${u} ${e}, ${PLOTS.find((x) => x[0] === ctl.state.plot)[1]}. ${rows.length} of ${all.length} strikes drawn. Gamma flip ${level(p.flip)}, call wall ${level(p.callWall)}, put wall ${level(p.putWall)}.` }),
      h("p", { class: "vs-foot" }, `${g.unit} · ${rows.length} of ${all.length} strikes drawn${rows.length < all.length ? "; the levels and totals use all of them" : ""}${d.skippedLegs ? ` · ${formatInt(d.skippedLegs)} legs without a usable IV left out` : ""}`),
    );
  };
  ctl.paint();
  const marks = (r) => [r.strike === p.callWall && "Call gamma wall", r.strike === p.putWall && "Put gamma wall", r.strike === p.heaviest && "Heaviest strike"].filter(Boolean);
  const levelRows = [
    ["spot", "Spot", p.spot],
    ["flip", "Gamma flip", p.flip],
    ["cross", "Ladder cross", p.ladderCross],
    ["callWall", "Call gamma wall", p.callWall],
    ["putWall", "Put gamma wall", p.putWall],
    ["heaviest", "Heaviest strike", p.heaviest],
  ];
  const when = asOf !== null ? `Replay at ${clock(asOf)} IST, a recorded reading. ` : "";
  return [
    hero({
      pillText: GEX_WORDS[p.verdict ?? "unmeasured"],
      pillTone: tone,
      label: asOf !== null ? `Gamma flip at ${clock(asOf)}` : "Gamma flip",
      value: level(p.flip),
      gist: `${when}${flipGist(u, p.distanceToFlip)} · ${shortDay(e)} expiry. A model of dealer hedging (Calls +, Puts −), not an observed position.`,
      chips: [
        { k: "Net", v: rupeeCr(p.net ?? d.totals?.netGex), tone: toneOf(p.net), title: "Net gamma exposure, rupees of hedging per 1% move, all strikes read" },
        { k: "Lean", v: leanText(p.lean), title: "How much of the strike-by-strike exposure survives the sum. Under 10% the page names no side" },
        { k: "Call wall", v: level(p.callWall), title: LEVEL_INFO.callWall },
        { k: "Put wall", v: level(p.putWall), title: LEVEL_INFO.putWall },
        { k: "Regime at spot", v: p.regimeAtSpot === "positive" ? "Positive γ" : p.regimeAtSpot === "negative" ? "Negative γ" : DASH, tone: p.regimeAtSpot === "positive" ? "vs-pos" : p.regimeAtSpot === "negative" ? "vs-neg" : "" },
      ],
      replay: asOf !== null,
    }),
    panel({ title: "Gamma exposure by strike", sub: "Each bar is one strike's rupees of hedging per 1% move. Positive gamma steadies the price in the model; it is not a bullish signal. Hover a strike for its figures; click to pin it.", tools: [ctl.greekSeg, ctl.plotSeg], body: slot, wide: true, cls: "vs-gex" }),
    panel({ title: "Where the sign changes", sub: "The whole book re-priced as if the underlying stood at each price, every strike keeping its IV and the time to expiry held. Where the line crosses zero is the gamma flip.", body: signCurve(p, { underlying: u, from: shown()[0]?.strike, to: shown().at(-1)?.strike }) }),
    panel({
      title: "Levels",
      sub: asOf !== null ? `Each level and its distance from spot at ${clock(asOf)}, in points.` : "Each level and its distance from spot, in points.",
      body: h(
        "div",
        { class: "vs-levels" },
        levelRows.map(([id, name, v]) =>
          h(
            "div",
            { class: `vs-level lv-${id}`, title: LEVEL_INFO[id] },
            h("span", { class: "vs-level-dot", "aria-hidden": "true" }),
            h("span", { class: "vs-level-name" }, name),
            h("span", { class: "vs-level-value" }, level(v)),
            h("span", { class: "vs-level-dist" }, id === "spot" || !isFigure(v) || !isFigure(p.spot) ? "" : `${signedPts(Number(v) - Number(p.spot))} pts`),
          ),
        ),
        dataDisclosure(
          `Every strike (${formatInt(all.length)})`,
          [
            { label: "Strike", cell: (r) => h("strong", {}, formatInt(r.strike)) },
            { label: "Call", num: true, cell: (r) => rupeeCr(r.callGex) },
            { label: "Put", num: true, cell: (r) => rupeeCr(r.putGex) },
            { label: "Net", num: true, cell: (r) => span(toneOf(r.netGex), rupeeCr(r.netGex)) },
            { label: "Both sides", num: true, cell: (r) => rupeeCr(Math.abs(r.callGex) + Math.abs(r.putGex)) },
            { label: "Marks", cell: (r) => marks(r).join(" · ") },
          ],
          all,
        ),
      ),
    }),
  ];
}

const SPEEDS = [["1", "1×"], ["2", "2×"], ["4", "4×"]];
const REPLAY_STEP_MS = 1200;

/**
 * GEX through the session: the three cards (price against the levels, price and the heaviest strikes, exposure through
 * the session) from GET /v1/analytics/exposure/session, and the replay: a scrubber over the recorded readings that
 * moves every figure on the page (the hero, the bars, the badges, the curve, the levels and the cards). The replay is
 * never remembered; a new underlying or expiry draws the page again with it closed.
 */
function gexSession(H, { u, e, live, show }) {
  const sess = { points: [], ladder: null, i: -1, on: false, playing: false, timer: 0, seq: 0, cache: new Map() };
  const replayBtn = h("button", { type: "button", class: "small plain", "aria-pressed": "false", disabled: true, title: "Needs two or more recorded readings today" }, icon("clock"), "Replay");
  const facts = h("dl", { class: "vs-chips vs-session-chips" });
  const note = h("p", { class: "vs-foot" }, "Reading the recorder's minutes…");
  // The replay strip.
  const range = h("input", { type: "range", class: "vs-scrub", min: "0", max: "0", step: "1", value: "0", "aria-label": "Reading shown" });
  const timeEl = h("span", { class: "vs-scrub-time", "aria-live": "polite" }, DASH);
  const back = h("button", { type: "button", class: "icon-btn vs-step back", "aria-label": "One reading back" }, icon("chevron"));
  const fwd = h("button", { type: "button", class: "icon-btn vs-step", "aria-label": "One reading on" }, icon("chevron"));
  const playBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Play" }, icon("play"));
  const speed = H.segmented("Speed", SPEEDS, "1");
  const latestBtn = h("button", { type: "button", class: "small plain" }, "Latest");
  const closeBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Close the replay" }, icon("close"));
  const strip = h("div", { class: "vs-replay", hidden: true, role: "group", "aria-label": "Session replay" }, h("div", { class: "vs-replay-keys" }, back, playBtn, fwd), h("div", { class: "vs-replay-track" }, range, timeEl), h("div", { class: "vs-replay-tools" }, speed, latestBtn, closeBtn));
  const slots = {
    levels: chartSlot("Price against the levels", { id: "gex-s-levels" }),
    strikes: chartSlot("Price and the heaviest strikes", { id: "gex-s-strikes" }),
    exposure: chartSlot("Exposure through the session", { id: "gex-s-exposure" }),
  };
  const head = panel({
    title: "Through the session",
    sub: "The book re-solved at each recorded reading (one in five minutes), so the levels and the exposure can be read as the day went. Replay moves every figure on this page to the reading you pick.",
    tools: [replayBtn],
    body: h("div", { class: "vs-session" }, strip, facts, note),
    wide: true,
  });
  const cards = [
    panel({ title: "Price against the levels", sub: "Spot through the day against the gamma flip and the walls as each reading solved them: where the price met, turned at or ran through a level.", body: slots.levels ?? h("p", { class: "muted" }, "Chart unavailable.") }),
    panel({ title: "Price and the heaviest strikes", sub: "Spot through the day with the five strikes carrying the most net gamma at the reading shown (green positive, red negative).", body: slots.strikes ?? h("p", { class: "muted" }, "Chart unavailable.") }),
    panel({ title: "Exposure through the session", sub: "Net gamma, filled green above zero and red below: where the fill crosses zero the book changed sign. Both sides runs on its own scale beneath and is never filled.", body: slots.exposure ?? h("p", { class: "muted" }, "Chart unavailable."), wide: true }),
  ];

  const signedCr = (c) => (c ? `${Number(c.change) > 0 ? "+" : ""}${rupeeCr(c.change)}` : DASH);
  function paintSession(i, reading) {
    const list = sess.points;
    const latest = i === list.length - 1;
    const specs = gexSessionSpecs(list, { underlying: u, at: latest ? null : list[i]?.t ?? null, reading });
    slots.levels?.chart.set(specs.levels);
    slots.strikes?.chart.set(specs.strikes);
    slots.exposure?.chart.set(specs.exposure);
    const m = gexSessionModel(list, i, { ladder: sess.ladder });
    if (!m) {
      facts.replaceChildren();
      return;
    }
    const chip = (k, v, tone, title) => h("div", { class: "vs-chip", title }, h("dt", {}, k), h("dd", { class: tone || undefined }, v));
    const ch = m.changes;
    facts.replaceChildren(
      chip(latest ? "Net, latest reading" : `Net at ${clock(m.t)}`, rupeeCr(m.net), toneOf(m.net), "Net gamma exposure at that reading, rupees per 1% move"),
      chip("5 min", signedCr(ch.m5), toneOf(ch.m5?.change), "The change of net over the 5 minutes before the reading shown"),
      chip("15 min", signedCr(ch.m15), toneOf(ch.m15?.change), "The change of net over the 15 minutes before the reading shown"),
      chip("Today", signedCr(ch.day), toneOf(ch.day?.change), "The change of net since the session's first reading"),
      chip("Sign changes", formatInt(m.signChanges), m.signChanges ? "vs-hi" : "", "How many times net changed sign between readings so far today"),
      m.flipRange ? chip("Flip range", `${level(m.flipRange.lo)} – ${level(m.flipRange.hi)}`, "", "The lowest and highest gamma flip solved so far today") : null,
    );
    const n = list.length;
    note.textContent = `${formatInt(n)} readings from ${clock(list[0].t)} to ${clock(list[n - 1].t)} IST${m.grew ? ` · the ladder gained ${formatInt(m.grew)} strikes through the day, so part of any rise is the book being listed, not positions taken` : ""}. Volatility is re-solved from traded prices at each reading.`;
  }

  async function readingAt(i) {
    const t = sess.points[i].t;
    if (sess.cache.has(t)) return sess.cache.get(t);
    const r = await api(`/v1/analytics/exposure/session?${new URLSearchParams({ underlying: u, expiry: e, at: String(t) })}`);
    const reading = r.data?.data?.reading ?? null;
    sess.cache.set(t, reading);
    return reading;
  }

  /** Show reading i everywhere: the live chain at the latest, a recorded reading before it. */
  async function go(i) {
    const n = sess.points.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    sess.i = i;
    range.value = String(i);
    range.style.setProperty("--fill", `${n > 1 ? Math.round((i / (n - 1)) * 1000) / 10 : 100}%`);
    timeEl.textContent = `${clock(sess.points[i].t)} IST${i === n - 1 ? " · latest" : ""}`;
    back.disabled = i === 0;
    fwd.disabled = i === n - 1;
    const mine = ++sess.seq;
    if (i === n - 1 || !sess.on) {
      show(live, null);
      paintSession(i, live);
      return;
    }
    let reading = null;
    try {
      reading = await readingAt(i);
    } catch {
      reading = null;
    }
    if (mine !== sess.seq || !sess.on) return;
    if (reading) show(reading, sess.points[i].t);
    paintSession(i, reading);
  }

  const stop = () => {
    sess.playing = false;
    clearTimeout(sess.timer);
    playBtn.replaceChildren(icon("play"));
    playBtn.setAttribute("aria-label", "Play");
  };
  const tick = async () => {
    if (!sess.playing || !head.isConnected) return stop();
    if (sess.i >= sess.points.length - 1) return stop();
    await go(sess.i + 1);
    if (sess.playing) sess.timer = setTimeout(tick, REPLAY_STEP_MS / Number(speed.value || 1));
  };
  playBtn.addEventListener("click", () => {
    if (sess.playing) return stop();
    if (sess.i >= sess.points.length - 1) go(0);
    sess.playing = true;
    playBtn.replaceChildren(icon("pause"));
    playBtn.setAttribute("aria-label", "Pause");
    sess.timer = setTimeout(tick, REPLAY_STEP_MS / Number(speed.value || 1));
  });
  back.addEventListener("click", () => (stop(), go(sess.i - 1)));
  fwd.addEventListener("click", () => (stop(), go(sess.i + 1)));
  let scrubT = 0;
  range.addEventListener("input", () => {
    stop();
    clearTimeout(scrubT);
    const i = Number(range.value);
    timeEl.textContent = `${clock(sess.points[i].t)} IST`;
    scrubT = setTimeout(() => go(i), 140);
  });
  latestBtn.addEventListener("click", () => (stop(), go(sess.points.length - 1)));
  const setOn = (on) => {
    sess.on = on;
    strip.hidden = !on;
    replayBtn.setAttribute("aria-pressed", String(on));
    if (!on) {
      stop();
      go(sess.points.length - 1);
    } else go(Math.max(0, sess.points.length - 2));
  };
  replayBtn.addEventListener("click", () => setOn(!sess.on));
  closeBtn.addEventListener("click", () => setOn(false));

  api(`/v1/analytics/exposure/session?${new URLSearchParams({ underlying: u, expiry: e })}`).then(
    (r) => {
      const d = r.data?.data ?? {};
      sess.points = d.points ?? [];
      sess.ladder = d.ladder ?? null;
      const n = sess.points.length;
      range.max = String(Math.max(0, n - 1));
      if (n >= 2) {
        replayBtn.disabled = false;
        replayBtn.removeAttribute("title");
      }
      if (!n) {
        note.textContent = d.unavailable?.detail ?? "The recorder has no readings of this chain yet.";
        paintSession(-1, null);
        const empty = gexSessionSpecs([], {});
        for (const k of Object.keys(slots)) slots[k]?.chart.set(empty[k]);
        return;
      }
      sess.i = n - 1;
      paintSession(n - 1, live);
      // Not today's: say which session the cards are from (the bars above are the live chain).
      if (d.day && d.day !== new Date(Date.now() + IST_MS).toISOString().slice(0, 10)) note.textContent = `${note.textContent} These readings are from ${shortDay(d.day)}, the latest recorded session.`;
    },
    (err) => {
      note.textContent = `The session could not be read: ${err?.message ?? "no answer"}.`;
      const empty = gexSessionSpecs([], {});
      for (const k of Object.keys(slots)) slots[k]?.chart.set(empty[k]);
    },
  );
  return [head, ...cards];
}

async function renderGexStrike(H) {
  const st = workspace.state;
  const u = st.underlying;
  const e = st.expiry;
  if (!e) return emptyState("info", "No expiry to show", "Pick an underlying with upcoming expiries in the top bar.");
  // Read a wide ladder so the flip, the walls and the totals never depend on how many strikes are drawn.
  const res = await api(`/v1/analytics/exposure?${new URLSearchParams({ underlying: u, expiry: e, strikes: String(Math.max(40, Number(st.strikes) || 10)) })}`);
  const d = res.data?.data ?? {};
  if (!(d.strikes ?? []).some((r) => isFigure(r.strike))) return [statusRow(res.data?.meta?.freshness), emptyState("chart", "No exposure to draw", "No strike has open interest with a usable IV and gamma.")];
  const ctl = { state: { greek: "gamma", plot: "net" }, paint: () => {} };
  ctl.plotSeg = H.segmented("Plot", PLOTS, ctl.state.plot);
  ctl.greekSeg = H.segmented("Greek", Object.entries(GREEKS).map(([k, g]) => [k, g.label]), ctl.state.greek);
  ctl.plotSeg.addEventListener("change", () => ((ctl.state.plot = ctl.plotSeg.value), ctl.paint()));
  ctl.greekSeg.addEventListener("change", () => ((ctl.state.greek = ctl.greekSeg.value), ctl.paint()));
  // The reading's cards sit in one display: contents box, so a replay swaps them without moving the page grid.
  const readingBox = h("div", { class: "vs-contents" });
  const show = (data, asOf) => readingBox.replaceChildren(...gexReading(data, { u, e, st, ctl, asOf }));
  show(d, null);
  return [statusRow(res.data?.meta?.freshness), readingBox, ...gexSession(H, { u, e, live: d, show })];
}

// ───────────────────────── GEX: by expiry ─────────────────────────

async function renderGexExpiry(H) {
  const st = workspace.state;
  const u = st.underlying;
  const res = await api(`/v1/analytics/exposure/expiries?${new URLSearchParams({ underlying: u, expiries: "4", strikes: String(Math.max(40, Number(st.strikes) || 10)) })}`);
  const d = res.data?.data ?? {};
  const list = d.expiries ?? [];
  if (!list.length) return [statusRow(res.data?.meta?.freshness), emptyState("chart", "No expiries to show", "The Bridge found no upcoming expiry with prices for this underlying.")];
  const spot = list.find((x) => isFigure(x.profile?.spot))?.profile?.spot ?? null;
  const biggest = list.reduce((b, x) => (b === null || Math.abs(x.netGex) > Math.abs(b.netGex) ? x : b), null);
  const maxAbs = Math.max(1, ...list.map((x) => Math.abs(Number(x.netGex) || 0)));
  const net = d.totals?.netGex;
  const rows = list.map((x) => {
    const pr = x.profile ?? {};
    const frac = Math.abs(Number(x.netGex) || 0) / maxAbs;
    const bar = h("span", { class: `vs-meter ${Number(x.netGex) >= 0 ? "pos" : "neg"}`, "aria-hidden": "true" }, h("i", {}));
    bar.style.setProperty("--f", String(Math.round(frac * 1000) / 1000));
    return h(
      "div",
      { class: `vs-exp-row${x === biggest ? " is-top" : ""}`, role: "row" },
      h("span", { class: "vs-exp-name", role: "cell" }, h("strong", {}, shortDay(x.expiry)), h("span", { class: "muted" }, `${formatFixed(x.daysToExpiry, 1)} d · ${formatPercent(Number(x.gexShare) * 100, 0)} of gamma`)),
      h("span", { class: "vs-exp-bar", role: "cell" }, bar, span(toneOf(x.netGex), rupeeCr(x.netGex))),
      h("span", { class: "vs-exp-cell", role: "cell" }, h("span", { class: "muted" }, "Flip"), level(pr.flip)),
      h("span", { class: "vs-exp-cell", role: "cell" }, h("span", { class: "muted" }, "Walls"), `${level(pr.putWall)} – ${level(pr.callWall)}`),
      h("span", { class: `vs-verdict small ${pr.verdict === "dampens" ? "pos" : pr.verdict === "amplifies" ? "neg" : ""}`.trim(), role: "cell" }, GEX_WORDS[pr.verdict ?? "unmeasured"]),
    );
  });
  const strikes = nearestStrikes((d.strikes ?? []), spot, 2 * (Number(st.strikes) || 10) + 1);
  return [
    statusRow(res.data?.meta?.freshness),
    hero({
      pillText: Number(net) > 0 ? "Positive gamma overall" : Number(net) < 0 ? "Negative gamma overall" : "Flat",
      pillTone: Number(net) > 0 ? "pos" : Number(net) < 0 ? "neg" : "",
      label: "Most gamma",
      value: biggest ? shortDay(biggest.expiry) : DASH,
      gist: biggest ? `${formatPercent(Number(biggest.gexShare) * 100, 0)} of the gamma across ${list.length} expiries sits in ${shortDay(biggest.expiry)}. Nearer expiries carry more gamma per contract.` : "",
      chips: [
        { k: "Net, all expiries", v: rupeeCr(net), tone: toneOf(net) },
        { k: "Spot", v: level(spot) },
        { k: "Running cross", v: level(d.zeroGammaLevel), title: "Where the running total of Net across all expiries changes sign, by strike" },
        { k: "Peak strike", v: level(d.peakStrike), title: "The strike with the largest net gamma, all expiries added" },
      ],
    }),
    panel({ title: "Each expiry", sub: "Net gamma per expiry (the bar is its size against the largest), its own solved flip, walls either side of spot and verdict.", body: h("div", { class: "vs-exp", role: "table", "aria-label": `Gamma exposure by expiry for ${u}` }, rows), wide: true }),
    panel({ title: "Net gamma by strike, all expiries", sub: "Each strike's net gamma added up across the expiries above.", body: strikeProfile({ rows: strikes, greek: "gamma", plot: "net", levels: isFigure(spot) ? [{ id: "spot", name: "Spot", price: spot }] : [], spot, label: `Net gamma by strike summed over ${list.length} expiries for ${u}` }), wide: true }),
  ];
}

// ───────────────────────── Straddle ─────────────────────────

const WINDOWS = [["5", "5 min"], ["15", "15 min"], ["day", "Day"]];
/** The Straddle view in use, kept while the page is open (not remembered across reloads). */
let straddleViewId = "overview";
const VERDICT_WORDS = { rising: "Premium rising", falling: "Premium falling", steady: "Premium steady" };

/** Snapshots of today for one chain (one page of up to 500 minutes covers a session). */
async function todaysSnapshots(u, e) {
  const r = await api(`/v1/options/snapshots?${new URLSearchParams({ underlying: u, expiry: e, fields: "ltp,iv,oi", strikes: "15", limit: "500" })}`);
  return r.data?.data?.snapshots ?? [];
}

/** The split of the straddle's change since the first reading, as signed bars on one scale. */
function splitCard(split) {
  if (!split) return emptyState("chart", "Nothing to split yet", "Needs two readings with both legs priced at the at-the-money strike.", null, { compact: true });
  // One scale for the four bars, never finer than 2% of the premium (a few paise do not fill a bar).
  const scale = Math.max(...split.parts.map((p) => Math.abs(p.value)), 0.02 * split.before, 0.05);
  const sub = { spot: isFigure(split.spotPts) ? `spot ${signedPts(split.spotPts)} pts` : "", iv: `IV ${formatSigned(split.ivPts, 2)} pts`, time: `${Math.floor(split.minutes / 60)}h ${split.minutes % 60}m of decay`, other: "a large move, or a stale price" };
  return h(
    "div",
    { class: "vs-split" },
    h("p", { class: "vs-split-head" }, `Call + Put ${rupee(split.before)} → ${rupee(split.after)}, `, span(toneOf(split.total), signedRupee(split.total))),
    split.parts.map((p) => {
      const bar = h("span", { class: `vs-split-bar ${p.value >= 0 ? "pos" : "neg"}`, "aria-hidden": "true" }, h("i", {}));
      bar.style.setProperty("--f", String(Math.round((Math.abs(p.value) / scale) * 1000) / 1000));
      return h("div", { class: "vs-split-row" }, h("span", { class: "vs-split-name" }, p.label, h("span", { class: "muted" }, sub[p.id])), bar, span(`vs-split-val ${toneOf(Math.round(p.value * 100))}`, signedRupee(p.value)));
    }),
    split.rough ? h("p", { class: "muted small" }, "More than a third of the movement is left unexplained, so read this split as rough.") : null,
  );
}

/** Every listed expiry's ATM straddle side by side (one chain each). */
async function compareCard(u, nowMs) {
  const list = (await api(`/v1/expiries?underlying=${encodeURIComponent(u)}`)).data?.data?.expiries ?? [];
  const today = new Date(nowMs + IST_MS).toISOString().slice(0, 10);
  const next = list.filter((x) => x >= today).sort().slice(0, 4);
  const [chains, cal] = await Promise.all([Promise.all(next.map((x) => api(`/v1/optionchain?${new URLSearchParams({ underlying: u, expiry: x, strikes: "3" })}`).then((r) => r.data?.data, () => null))), tradingCalendar(u, nowMs)]);
  const rows = chains.filter(Boolean).map((c) => expiryRow(c, nowMs, { isTradingDay: cal }));
  if (!rows.length) return emptyState("list", "No expiries could be read", "Try again in a minute.", null, { compact: true });
  const ivEx = extremes(rows, "atmIv");
  const dayEx = extremes(rows, "perDay");
  const maxDay = Math.max(1, ...rows.map((r) => r.perDay ?? 0));
  const cell = (k, v, cls) => h("span", { class: `vs-cmp-cell ${cls ?? ""}`.trim(), role: "cell" }, h("span", { class: "vs-cmp-k" }, k), v);
  return h(
    "div",
    { class: "vs-cmp", role: "table", "aria-label": `ATM straddle by expiry for ${u}` },
    rows.map((r) => {
      const meter = h("span", { class: "vs-meter iv", "aria-hidden": "true" }, h("i", {}));
      meter.style.setProperty("--f", String(isFigure(r.perDay) ? Math.round((r.perDay / maxDay) * 1000) / 1000 : 0));
      return h(
        "div",
        { class: `vs-cmp-row${r.expiry === workspace.state.expiry ? " is-current" : ""}`, role: "row" },
        h("span", { class: "vs-cmp-name", role: "cell" }, h("strong", {}, shortDay(r.expiry)), h("span", { class: "muted" }, `${isFigure(r.days) ? formatFixed(r.days, 1) : DASH} d${isFigure(r.sessions) ? ` · ${formatFixed(r.sessions, 1)} sessions` : ""}`)),
        cell("Straddle", h("span", {}, rupee(r.premium), h("span", { class: "muted" }, ` at ${level(r.strike)}`))),
        cell("Expected move", r.levels ? `±${pts(r.levels.expectedMove)} (${formatPercent(r.levels.movePct, 2)})` : DASH),
        cell("Breakevens", r.levels ? `${level(r.levels.beLo)} – ${level(r.levels.beHi)}` : DASH),
        cell("ATM IV", h("span", { class: r.expiry === ivEx.hi ? "vs-hi" : undefined }, isFigure(r.atmIv) ? formatPercent(r.atmIv, 1) : DASH)),
        cell("Move per day", h("span", { class: "vs-cmp-day" }, meter, h("span", { class: r.expiry === dayEx.hi ? "vs-hi" : undefined }, isFigure(r.perDay) ? `±${pts(r.perDay)}` : DASH))),
      );
    }),
    h("p", { class: "vs-foot" }, `Compare the move per day down the rows: IV counts calendar days, so a near expiry reads high in IV for that reason alone. Expected move is 0.85 × the straddle, a pricing convention, not a forecast. Each row is priced at its chain's ATM strike (nearest spot), which can be one strike from the forward-anchored strike in the reading above. ${cal.calendar ? "Sessions are trading days on the exchange calendar: holidays are left out." : "Sessions count weekdays: the exchange holiday calendar could not be read."}`),
  );
}

async function renderStraddle(H) {
  const st = workspace.state;
  const u = st.underlying;
  const e = st.expiry;
  if (!e) return emptyState("info", "No expiry to show", "Pick an underlying with upcoming expiries in the top bar.");
  const nowMs = Date.now();
  let snaps = [];
  try {
    snaps = await todaysSnapshots(u, e);
  } catch {
    snaps = [];
  }
  const points = snapshotPoints(snaps);
  const compareSlot = h("div", {}, loading());
  compareCard(u, nowMs).then(
    (n) => compareSlot.replaceChildren(n),
    (err) => compareSlot.replaceChildren(H.errorBox(err)),
  );
  const compare = panel({ title: "Across expiries", sub: "Each expiry's at-the-money straddle, the move it prices and where a bought straddle breaks even.", body: compareSlot, wide: true });
  if (points.length < 1) return renderStraddleFromChain(H, { u, e, compare });
  const last = points[points.length - 1];
  const firstRaw = points[0].raw;
  const lastRaw = last.raw;
  const levels = straddleLevels({ premium: last.straddle, strike: last.atm, spot: last.spot });
  const sigma = sigmaMovePts(last.spot, last.atmIv, last.years);
  const steps = points.reduce((n, p, i) => n + (i && p.atm !== points[i - 1].atm ? 1 : 0), 0);
  const windowSeg = H.segmented("Measured over", WINDOWS, "15");
  const heroSlot = h("div", { class: "an-wide" });
  const paintHero = () => {
    const w = windowSeg.value;
    const ch = changeOver(points, "straddle", w === "day" ? "day" : Number(w), { tolMs: w === "5" ? 90_000 : 150_000 });
    const verdict = points.length < 2 ? null : premiumVerdict(ch);
    const changes = WINDOWS.map(([k, name]) => {
      const c = changeOver(points, "straddle", k === "day" ? "day" : Number(k), { tolMs: k === "5" ? 90_000 : 150_000 });
      return { k: name, v: c ? signedPts(c.change, 2) : DASH, tone: c ? toneOf(Math.round(c.change * 100)) : "", title: c ? `${formatFixed(c.base, 2)} at ${clock(c.baseT)} → ${formatFixed(c.now, 2)} (${formatSigned(c.pct, 1)}%)` : "No reading close enough to that time" };
    });
    heroSlot.replaceChildren(
      hero({
        pillText: points.length < 2 ? "First reading" : verdict ? VERDICT_WORDS[verdict] : `Not measured over ${WINDOWS.find((x) => x[0] === w)[1]}`,
        pillTone: verdict === "rising" ? "pos" : verdict === "falling" ? "neg" : "",
        label: `ATM straddle · ${level(last.atm)} Call + Put`,
        value: rupee(last.straddle),
        gist: `${u} ${level(last.spot)} · ${shortDay(e)} expiry · as of ${clock(last.t)} IST. ${steps ? `The at-the-money strike stepped ${steps} time${steps === 1 ? "" : "s"} today; a jump in the line at a step is a change of contract.` : "Priced at the strike nearest the forward."}`,
        chips: [
          ...changes,
          { k: "Expected move", v: levels ? `±${pts(levels.expectedMove)}` : DASH, title: "0.85 × the straddle, around spot: a pricing convention, not a forecast" },
          { k: "Range", v: levels ? `${level(levels.rangeLo)} – ${level(levels.rangeHi)}` : DASH, title: "Spot ± the expected move" },
          { k: "Breakevens", v: levels ? `${level(levels.beLo)} – ${level(levels.beHi)}` : DASH, title: "Strike ± the whole premium: where a bought straddle gets its money back at expiry, before costs" },
          { k: "1σ from IV", v: isFigure(sigma) ? `±${pts(sigma)}` : DASH, title: `Spot × ATM IV (${isFigure(last.atmIv) ? formatPercent(last.atmIv, 2) : DASH}) × √time to expiry: one standard deviation, wider than the expected move` },
        ],
      }),
    );
  };
  windowSeg.addEventListener("change", paintHero);
  paintHero();
  const chart = chartSlot("ATM straddle through the session", { id: "vs-straddle" });
  chart?.chart.set(straddleSpec(points, { underlying: u, expiry: e }));
  const split = points.length >= 2 ? straddleSplit(firstRaw, lastRaw, last.atm) : null;
  const overview = [
    heroSlot,
    panel({ title: "Through the session", sub: "The straddle of the strike nearest the forward at each recorded minute, with the time-alone line: where the first premium would be if only time had passed.", tools: [windowSeg], body: chart ?? emptyState("chart", "Chart unavailable", "Reload the page to try again."), wide: true, cls: "vs-chartpanel" }),
    panel({ title: `What moved the ${level(last.atm)} straddle`, sub: `Since ${clock(points[0].t)}: the change split into the price move, the IV change and time passing (Black-76 at each reading's forward and time, each leg at its own IV). What is left is "Other".`, body: splitCard(split) }),
    compare,
  ];
  // The view switch: the Overview above, or one of the four leg views (straddle-views.js) from the same minutes.
  const viewSeg = H.segmented("View", STRADDLE_VIEWS, straddleViewId);
  const body = h("div", { class: "vs-contents" });
  const draw = () => body.replaceChildren(...(straddleViewId === "overview" ? overview : straddleView(straddleViewId, { points, u, e, H, rerender: draw })));
  viewSeg.addEventListener("change", () => ((straddleViewId = viewSeg.value), draw()));
  draw();
  return [
    statusRow({ source: "Recorder", ageMs: Math.max(0, nowMs - last.t), asOf: new Date(last.t).toISOString() }),
    h("div", { class: "vs-viewbar an-wide" }, viewSeg),
    body,
  ];
}

/** No recorded minutes for this chain: the chain's ATM straddle now and its candle history (GET /v1/analytics/straddle). */
async function renderStraddleFromChain(H, { u, e, compare }) {
  const res = await api(`/v1/analytics/straddle?${new URLSearchParams({ underlying: u, expiry: e, interval: "5m", countback: "75", strikes: "15" })}`);
  const d = res.data?.data ?? {};
  const levels = straddleLevels({ premium: d.premium, strike: d.atmStrike, spot: d.spot });
  const hist = (d.history ?? []).filter((x) => isFigure(x.straddle));
  const chart = chartSlot("ATM straddle, 5-minute candles", { id: "vs-straddle" });
  chart?.chart.set(
    hist.length >= 2
      ? { label: `${u} ${e}: the ${level(d.atmStrike)} straddle, 5-minute closes`, panes: [{ id: "prem", format: (v) => formatFixed(v, 0) }], series: [{ id: "st", type: "line", pane: "prem", label: `${level(d.atmStrike)} straddle`, tone: "iv", data: hist.map((x) => ({ t: x.time * 1000, v: x.straddle })), format: (v) => rupee(v) }] }
      : { empty: { title: "No straddle history", text: "The broker had no candles for both legs of the at-the-money strike." } },
  );
  return [
    statusRow(res.data?.meta?.freshness),
    hero({
      pillText: isFigure(d.changePct) ? (Math.abs(d.changePct) <= 1 ? "Premium steady" : d.changePct > 0 ? "Premium rising" : "Premium falling") : null,
      pillTone: isFigure(d.changePct) && Math.abs(d.changePct) > 1 ? (d.changePct > 0 ? "pos" : "neg") : "",
      label: `ATM straddle · ${level(d.atmStrike)} Call + Put`,
      value: rupee(d.premium),
      gist: `${u} ${level(d.spot)} · ${shortDay(e)} expiry. The Bridge has not recorded this chain today, so the line is the fixed strike's candles, not the moving at-the-money straddle.`,
      chips: [
        { k: "Since the first candle", v: isFigure(d.change) ? signedPts(d.change, 2) : DASH, tone: toneOf(d.change) },
        { k: "Expected move", v: levels ? `±${pts(levels.expectedMove)}` : DASH },
        { k: "Breakevens", v: levels ? `${level(levels.beLo)} – ${level(levels.beHi)}` : DASH },
      ],
    }),
    panel({ title: "Through the session", sub: "The at-the-money call plus put at 5-minute closes.", body: chart ?? emptyState("chart", "Chart unavailable", "Reload the page to try again."), wide: true, cls: "vs-chartpanel" }),
    compare,
  ];
}

/** The pages analytics.js hosts: gexsuite (tabs strike, expiry) and straddlesuite. */
export function exposureSuitePages(getHelpers) {
  return [
    { id: "gexsuite", render: () => (getHelpers().tab === "expiry" ? renderGexExpiry(getHelpers()) : renderGexStrike(getHelpers())) },
    { id: "straddlesuite", render: () => renderStraddle(getHelpers()) },
  ];
}
