// whatif.js: the one what-if panel the Positions page and the Strategy Builder share (docs/design/ux-audit.md, trading
// pass 2). Spot ±%, IV ± vol points and days forward, with quick chips (±σ; Today, +1, +3, Expiry), Reset, an
// optional scope switch (the whole book or one group) and a row of figures at the scenario: P&L and its change, Δ, Γ,
// Θ, vega and margin (span-margin.js, through whatif-core.js). Both pages hand it the same state object (the desk's
// st.whatIf), so a scenario set on one page is there on the other. Numbers become text only through format.js.
import { h, icon } from "./app.js";
import { formatFixed, formatInt, formatRupee, formatSigned, formatSignedRupee, isFigure } from "./format.js";
import { WHATIF_LIMITS, clampWhatIf, daysStep } from "./whatif-core.js";

const rs = (v, dp = 0) => formatSignedRupee(v, dp);
const tone = (v) => (isFigure(v) && Math.round(v) > 0 ? "up" : isFigure(v) && Math.round(v) < 0 ? "down" : "");
const r1 = (v) => Math.round(v * 10) / 10;

/** "+2 d", "+6 h", "Today". */
export function daysText(d) {
  if (!(d > 0)) return "Today";
  if (d < 1) return `+${formatInt(Math.round(d * 24))} h`;
  return Number.isInteger(d) ? `+${formatInt(d)} d` : `+${formatFixed(d, 2)} d`;
}

/**
 * @param {{ state: { pct: number, dIv: number, days: number }, onInput: () => void, onCommit?: () => void,
 *   title?: string, compact?: boolean }} o
 *   onInput runs on every slider move (redraw from the state); onCommit when a move ends (save the state).
 */
export function createWhatIf({ state, onInput, onCommit = () => {}, title = "What if" }) {
  const W = state;
  let maxDays = 30;
  let firstDays = 0;
  let sigmaPct = null;
  let spot = null;
  const range = (cls, min, max, step, label) => h("input", { type: "range", class: `pos-range ${cls}`, min: String(min), max: String(max), step: String(step), value: "0", "aria-label": label });
  const spotIn = range("div", -WHATIF_LIMITS.pct, WHATIF_LIMITS.pct, WHATIF_LIMITS.pctStep, "Spot move");
  const ivIn = range("div iv", -WHATIF_LIMITS.dIv, WHATIF_LIMITS.dIv, WHATIF_LIMITS.dIvStep, "IV change in vol points");
  const daysIn = range("days", 0, 30, 1, "Days forward");
  const spotVal = h("output", {});
  const ivVal = h("output", {});
  const daysVal = h("output", {});
  const spotChips = h("div", { class: "pos-chips" });
  const dayChips = h("div", { class: "pos-chips" });
  const ivChips = h("div", { class: "pos-chips" });
  const scopeHost = h("div", { class: "wi-scope", hidden: true });
  const resetBtn = h("button", { type: "button", class: "small plain wi-reset-btn", onclick: () => set({ pct: 0, dIv: 0, days: 0 }, true) }, icon("refresh"), "Reset");
  const figs = h("div", { class: "wi-figs", role: "group", "aria-label": "Figures at the scenario", "aria-live": "polite" });
  const row = (label, input, out, chips) => h("div", { class: "pos-slider" }, h("label", {}, h("span", {}, label), out), input, chips);
  const sliders = h("div", { class: "pos-sliders" }, row("Spot", spotIn, spotVal, spotChips), row("IV", ivIn, ivVal, ivChips), row("Days", daysIn, daysVal, dayChips));
  const el = h(
    "section",
    { class: "wi-panel", "aria-label": title },
    h("div", { class: "wi-bar" }, h("span", { class: "wi-title" }, title), scopeHost, resetBtn),
    sliders,
    figs,
  );

  function paint(input) {
    const mn = Number(input.min);
    const mx = Number(input.max);
    const v = Number(input.value);
    const at = mx > mn ? ((v - mn) / (mx - mn)) * 100 : 0;
    const zero = input.classList.contains("div") ? ((0 - mn) / (mx - mn)) * 100 : 0;
    input.style.setProperty("--a", `${r1(Math.min(at, zero))}%`);
    input.style.setProperty("--b", `${r1(Math.max(at, zero))}%`);
  }
  function labels() {
    const S = spot;
    const at = isFigure(S) ? S * (1 + W.pct / 100) : null;
    spotVal.textContent = `${formatSigned(W.pct, 2)}% · ${formatInt(at)}`;
    spotIn.setAttribute("aria-valuetext", `${W.pct < 0 ? "minus " : ""}${formatFixed(Math.abs(W.pct), 2)} percent${at !== null ? `, ${formatInt(at)}` : ""}`);
    ivVal.textContent = `${formatSigned(W.dIv, 1)} pts`;
    ivIn.setAttribute("aria-valuetext", `${W.dIv < 0 ? "minus " : ""}${formatFixed(Math.abs(W.dIv), 1)} vol points`);
    daysVal.textContent = daysText(W.days);
    daysIn.setAttribute("aria-valuetext", daysText(W.days));
    resetBtn.hidden = !W.pct && !W.dIv && !W.days;
    for (const b of spotChips.children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === W.pct));
    for (const b of ivChips.children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === W.dIv));
    for (const b of dayChips.children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === W.days));
  }
  function toInputs() {
    spotIn.value = String(W.pct);
    ivIn.value = String(W.dIv);
    daysIn.value = String(W.days);
    for (const i of [spotIn, ivIn, daysIn]) paint(i);
    labels();
  }
  function chip(host, label, v, key) {
    const b = h("button", { type: "button", class: "small chip-btn", "data-v": String(v), onclick: () => set({ [key]: v }, true) }, label);
    host.append(b);
  }
  function drawChips() {
    spotChips.replaceChildren();
    for (const k of [-2, -1, 0, 1, 2]) {
      const p = sigmaPct ? Math.max(-WHATIF_LIMITS.pct, Math.min(WHATIF_LIMITS.pct, Math.round((k * sigmaPct) / WHATIF_LIMITS.pctStep) * WHATIF_LIMITS.pctStep)) : null;
      if (p === null && k) continue;
      chip(spotChips, k === 0 ? "0" : `${k > 0 ? "+" : "−"}${Math.abs(k)}σ`, k === 0 ? 0 : p, "pct");
    }
    ivChips.replaceChildren();
    for (const v of [-2, 0, 2]) chip(ivChips, v === 0 ? "0" : `${formatSigned(v, 0)}`, v, "dIv");
    dayChips.replaceChildren();
    const fd = Math.min(maxDays, firstDays);
    const opts = [["Today", 0], ["+1", 1], ["+3", 3], ["Expiry", fd]].filter(([, v], i, a) => v <= maxDays && a.findIndex((x) => x[1] === v) === i);
    for (const [l, v] of opts) chip(dayChips, l, v, "days");
    labels();
  }
  /** Change the scenario (clamped to the range). `commit` also saves. */
  function set(patch, commit = false) {
    Object.assign(W, clampWhatIf({ ...W, ...patch }, maxDays));
    toInputs();
    onInput();
    if (commit) onCommit();
  }
  let raf = 0;
  const slide = () => {
    W.pct = Number(spotIn.value);
    W.dIv = Number(ivIn.value);
    W.days = Number(daysIn.value);
    for (const i of [spotIn, ivIn, daysIn]) paint(i);
    labels();
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (el.isConnected) onInput();
    });
  };
  for (const i of [spotIn, ivIn, daysIn]) {
    i.addEventListener("input", slide);
    i.addEventListener("change", () => onCommit());
  }

  /**
   * The page's range: spot (for the label), 1σ in % of spot (the σ chips), days to the first and the last expiry.
   * Clamps the state to it.
   */
  function setRange({ S = spot, sigma = sigmaPct, first = firstDays, max = maxDays } = {}) {
    const m = Math.max(0, Math.ceil((max ?? 0) * 4) / 4);
    const sig = `${formatFixed(sigma, 2)}|${first}|${m}`;
    spot = S;
    const changed = sig !== el.__sig;
    el.__sig = sig;
    sigmaPct = sigma;
    firstDays = Math.max(0, Math.ceil((first ?? 0) * 4) / 4);
    if (m !== maxDays) {
      maxDays = m;
      daysIn.max = String(m);
      daysIn.step = String(daysStep(m));
      daysIn.disabled = m <= 0;
    }
    // Clamp only: a target set elsewhere (the builder's P&L grid, an expiry chip) keeps its exact time.
    W.days = Math.max(0, Math.min(maxDays, Number(W.days) || 0));
    if (changed) drawChips();
    toInputs();
  }

  /** A scope switch (Positions: the whole book or one group). `options`: [[value, label]]; null hides it. */
  function setScopes(options, current, onPick) {
    if (!options || options.length < 2) {
      scopeHost.hidden = true;
      scopeHost.replaceChildren();
      return;
    }
    scopeHost.hidden = false;
    const sel = h("select", { class: "wi-scope-sel", "aria-label": "Scenario applies to" }, ...options.map(([v, l]) => h("option", { value: v, selected: v === current }, l)));
    sel.addEventListener("change", () => onPick(sel.value));
    scopeHost.replaceChildren(sel);
  }

  /** The figures at the scenario (whatif-core.js whatIfFigures), or a reason when there are none. */
  function drawFigures(f, { note = "" } = {}) {
    if (!f || !f.legs) {
      figs.replaceChildren(h("p", { class: "muted wi-none" }, note || "No priced legs to run the scenario on."));
      return;
    }
    const fig = (k, v, sub, cls = "") => h("div", { class: `wi-fig ${cls}` }, h("span", { class: "wi-k" }, k), h("span", { class: `wi-v ${tone(cls === "pnl" ? v : null)}` }, typeof v === "string" ? v : rs(v)), sub ? h("span", { class: "wi-s" }, sub) : null);
    const g = f.greeks;
    figs.replaceChildren(
      fig("P&L", f.pnl, h("span", { class: tone(f.change) }, `${rs(f.change)} vs now`), "pnl"),
      fig("Δ", formatSigned(g.delta, 0), `now ${formatSigned(f.greeks0.delta, 0)}`),
      fig("Γ", formatSigned(g.gamma, 2), `now ${formatSigned(f.greeks0.gamma, 2)}`),
      fig("Θ /day", rs(g.theta), `now ${rs(f.greeks0.theta)}`),
      fig("Vega /pt", rs(g.vega), `now ${rs(f.greeks0.vega)}`),
      fig("Margin ≈", formatRupee(f.margin, 0), f.marginChange === null ? "" : h("span", { class: f.marginChange > 0.5 ? "down" : f.marginChange < -0.5 ? "up" : "" }, `${rs(f.marginChange)} vs now`)),
    );
    if (note) figs.append(h("p", { class: "muted wi-note" }, note));
  }

  toInputs();
  return { el, set, setRange, setScopes, drawFigures, parts: { spotIn, ivIn, daysIn, spotChips, dayChips, resetBtn, figs } };
}
