// Markets › Volatility › Forward, RR and BF, Event vol: PR 17's derivatives-depth routes, drawn in the analytics host
// (analytics.js). Read-only; the Bridge computes everything from its own option chains (analytics/derivDepth.mjs).
//  - Forward: the implied forward of each expiry from put-call parity, its basis to spot, the carry rate and the
//    implied dividend yield (GET /v1/analytics/forward-curve).
//  - RR and BF: the risk reversal and butterfly at 25 and 10 delta for each upcoming expiry, as a term structure
//    (GET /v1/analytics/rr-bf, one call per expiry, through the shared fetch layer).
//  - Event vol: the 1σ move the options price in for a dated event (a policy meeting, results, a vote), read from the
//    total variance of the expiries either side of it (GET /v1/analytics/event-vol), beside the ATM term structure and
//    the forward vol between expiries (GET /v1/analytics/vol-cone).
// Reads go through api(); nothing polls. Figures become text through format.js only.
import { api, card, emptyState, h, table } from "./app.js";
import { DASH, formatDayMonth, formatFixed, formatInput, formatInt, formatPercent, formatSigned, formatSignedPercent, isFigure } from "./format.js";
import { legend, nextId, statusRow, tile, tiles } from "./analyticsViews.js";
import { seriesChart } from "./analyticsMore.js";
import { workspace } from "./workspace.js";

/** How many expiries the term-structure tabs read. */
export const DEPTH_EXPIRIES = 6;
/** The deltas the RR and BF tab can centre on (the route always adds 25 and 10). */
export const RR_DELTAS = [10, 15, 25, 35];

const num = (v) => (isFigure(v) ? Number(v) : null);
const loading = () => h("p", { class: "muted", role: "status" }, "Loading…");

/**
 * The forward curve's rows (pure): expiries with a forward first in time order, every figure a number or null.
 * @param {Array<object>} curve  data.curve of /v1/analytics/forward-curve
 */
export function forwardRows(curve) {
  return (curve ?? [])
    .filter((r) => r && typeof r.expiry === "string")
    .map((r) => ({
      expiry: r.expiry,
      dte: num(r.dte),
      forward: num(r.forward),
      basis: num(r.basis),
      basisPct: num(r.basisPct),
      carryPct: num(r.carryPct),
      dividendPct: num(r.impliedDividendYieldPct),
      dispersion: num(r.dispersion),
      strikes: Array.isArray(r.strikesUsed) ? r.strikesUsed.length : 0,
      quality: r.quality ?? (num(r.forward) === null ? "none" : "ok"),
      reason: r.reason ?? null,
    }))
    .sort((a, b) => (a.dte ?? 0) - (b.dte ?? 0));
}

/**
 * The RR and BF term structure (pure): one row per answered expiry, `delta` the centre delta. A delta the route could
 * not read (a thin smile, a far wing) stays null.
 * @param {Array<{ expiry, data }>} answers  data = data of /v1/analytics/rr-bf, or null when the call failed
 */
export function rrBfTerm(answers, delta = 25) {
  const at = (d, k) => (d?.deltas ?? []).find((x) => Number(x.delta) === k) ?? null;
  return (answers ?? [])
    .filter((a) => a && a.data)
    .map(({ expiry, data }) => {
      const c = at(data, delta);
      const ten = at(data, 10);
      return {
        expiry,
        dte: num(data.daysToExpiry),
        atm: num(c?.atmIvPct ?? ten?.atmIvPct),
        callIv: num(c?.callIvPct),
        putIv: num(c?.putIvPct),
        rr: num(c?.riskReversal),
        bf: num(c?.butterfly),
        rr10: num(ten?.riskReversal),
        bf10: num(ten?.butterfly),
        points: num(data.smilePoints) ?? 0,
        reason: c?.reason ?? null,
      };
    })
    .sort((a, b) => (a.dte ?? 0) - (b.dte ?? 0));
}

/** What a risk reversal says in words (pure): puts over calls is the usual equity-index skew. */
export function rrWords(rr) {
  if (!isFigure(rr)) return "No reading";
  if (rr <= -0.25) return "Puts dearer than calls";
  if (rr >= 0.25) return "Calls dearer than puts";
  return "Calls and puts level";
}

/**
 * The first event date worth asking about (pure): the weekday after the nearest expiry that has a later one, so the
 * route has an expiry on each side. Null when fewer than two expiries are listed.
 * @param {string[]} expiries  YYYY-MM-DD, any order
 */
export function defaultEventDate(expiries) {
  const list = [...new Set((expiries ?? []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)))].sort();
  if (list.length < 2) return null;
  const d = new Date(`${list[0]}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  const iso = d.toISOString().slice(0, 10);
  return iso < list[1] ? iso : list[1];
}

/**
 * The event's total variance split into what is known before it, the ordinary drift between the expiries and the
 * event itself (pure), in variance units (σ² × years). The event part is 0 when there is no premium.
 * @param {object} d  data of /v1/analytics/event-vol
 */
export function varianceParts(d) {
  const pre = num(d?.preEventExpiry?.totalVariance) ?? 0;
  const total = num(d?.postEventExpiry?.totalVariance);
  if (total === null) return null;
  const b = num(d?.baseline?.volPct);
  const T2 = (num(d?.postEventExpiry?.daysToExpiry) ?? 0) / 365;
  const T1 = d?.preEventExpiry ? (num(d.preEventExpiry.daysToExpiry) ?? 0) / 365 : 0;
  const drift = b === null ? 0 : (b / 100) ** 2 * Math.max(0, T2 - T1);
  const event = Math.max(0, num(d?.eventVariance) ?? 0);
  return { pre, drift, event, total, eventShare: total > 0 ? Math.round((event / total) * 1000) / 10 : null };
}

/**
 * The calmest forward vol between two expiries (pure): a common ex-event baseline, the vol the market prices for an
 * ordinary stretch of days. Null when no window has one.
 * @param {Array<{ forwardVolPct }>} forwardVol  data.forwardVol of /v1/analytics/vol-cone
 */
export function calmestForwardVol(forwardVol) {
  const xs = (forwardVol ?? []).map((w) => num(w?.forwardVolPct)).filter((v) => v !== null && v > 0);
  return xs.length ? Math.min(...xs) : null;
}

/**
 * The event premium each window between consecutive expiries holds over a baseline vol (pure): an event dated inside
 * the window gets the window's extra variance, whatever its day (the route reads only the expiries either side).
 * Same formula as the route: event variance = s2² T2 − s1² T1 − b² (T2 − T1), T in days / 365, the move √ of it.
 * @param {Array<{ expiry, daysToExpiry, atmIvPct }>} atmTerm  data.atmTerm of /v1/analytics/vol-cone
 * @param {number} baselinePct
 */
export function eventWindows(atmTerm, baselinePct) {
  const pts = (atmTerm ?? []).filter((x) => x && num(x.daysToExpiry) > 0 && num(x.atmIvPct) > 0).sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  const b = num(baselinePct);
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const c = pts[i];
    const T1 = a.daysToExpiry / 365;
    const T2 = c.daysToExpiry / 365;
    const v1 = (a.atmIvPct / 100) ** 2 * T1;
    const v2 = (c.atmIvPct / 100) ** 2 * T2;
    const fwd = T2 > T1 && v2 > v1 ? Math.sqrt((v2 - v1) / (T2 - T1)) * 100 : null;
    const ev = b === null ? null : v2 - v1 - (b / 100) ** 2 * (T2 - T1);
    out.push({ from: a.expiry, to: c.expiry, days: Math.round((c.daysToExpiry - a.daysToExpiry) * 10) / 10, forwardVolPct: fwd === null ? null : Math.round(fwd * 100) / 100, movePct: ev !== null && ev > 0 ? Math.round(Math.sqrt(ev) * 100_000) / 1000 : null });
  }
  return out;
}

/** An expiry's axis label: "3 Nov". */
const axisDay = (iso) => formatDayMonth(iso) || DASH;

// ───────────────────────── Forward curve ─────────────────────────

async function renderForward(H) {
  const u = workspace.state.underlying;
  try {
    const res = await api(`/v1/analytics/forward-curve?${new URLSearchParams({ underlying: u, expiries: String(DEPTH_EXPIRIES) })}`);
    const d = res.data?.data ?? {};
    const rows = forwardRows(d.curve);
    const priced = rows.filter((r) => r.forward !== null);
    if (!priced.length) return [statusRow(res.data?.meta?.freshness), emptyState("info", "No forward to show", rows[0]?.reason ?? "No expiry had a call and a put priced near spot.")];
    const spot = num(d.spot);
    const near = priced[0];
    const far = priced.at(-1);
    const meanCarry = priced.reduce((a, r) => a + (r.carryPct ?? 0), 0) / priced.length;
    const pts = (key) => rows.map((r) => ({ label: axisDay(r.expiry), y: r[key] }));
    const cols = [
      { label: "Expiry", cell: (r) => h("strong", { title: r.expiry }, axisDay(r.expiry)) },
      { label: "Days", num: true, cell: (r) => formatFixed(r.dte, 1) },
      { label: "Forward", num: true, cell: (r) => formatFixed(r.forward, 2) },
      { label: "Basis", num: true, cell: (r) => formatSigned(r.basis, 2) },
      { label: "Basis %", num: true, cell: (r) => formatSignedPercent(r.basisPct, 3) },
      { label: "Carry, a year", num: true, cell: (r) => formatSignedPercent(r.carryPct, 2) },
      { label: "Dividend yield", num: true, cell: (r) => formatSignedPercent(r.dividendPct, 2) },
      { label: "Spread of strikes", num: true, cell: (r) => (r.dispersion === null ? DASH : formatFixed(r.dispersion, 2)) },
      { label: "Strikes", num: true, cell: (r) => (r.strikes ? formatInt(r.strikes) : r.reason ?? DASH) },
    ];
    return [
      statusRow(res.data?.meta?.freshness),
      tiles(
        tile(`${u} spot`, formatFixed(spot, 2), `Rate ${formatPercent(d.ratePct, 2)} a year`),
        tile(`Forward, ${axisDay(near.expiry)}`, formatFixed(near.forward, 2), `${formatSigned(near.basis, 2)} to spot in ${formatFixed(near.dte, 1)} days`),
        tile(`Forward, ${axisDay(far.expiry)}`, formatFixed(far.forward, 2), `${formatSigned(far.basis, 2)} to spot in ${formatFixed(far.dte, 1)} days`),
        tile("Carry the options price", formatSignedPercent(meanCarry, 2), `Implied dividend yield ${formatSignedPercent(Number(d.ratePct) - meanCarry, 2)}`),
      ),
      card({
        title: "Forward by expiry",
        sub: "Put-call parity at the strikes nearest spot: F = K + (C − P) e^(rT)",
        body: h("div", { class: "stack" }, legend([{ cls: "s1", label: "Implied forward" }, { cls: "s4", label: "Spot, dashed" }]), seriesChart(
          [
            { id: "f", label: "Forward", cls: "s1", points: pts("forward") },
            { id: "s", label: "Spot", cls: "s4", dash: "6 4", points: rows.map((r) => ({ label: axisDay(r.expiry), y: spot })) },
          ],
          { label: `${u} implied forward by expiry against spot`, yDecimals: 0 },
        )),
      }),
      card({
        title: "Carry and dividend yield, % a year",
        sub: "Carry = ln(F / S) / T; dividend yield = rate − carry",
        body: h("div", { class: "stack" }, legend([{ cls: "s3", label: "Carry" }, { cls: "s2", label: "Implied dividend yield, dashed" }]), seriesChart(
          [
            { id: "c", label: "Carry", cls: "s3", points: pts("carryPct") },
            { id: "q", label: "Dividend yield", cls: "s2", dash: "6 4", points: pts("dividendPct") },
          ],
          { label: `${u} carry and implied dividend yield by expiry, percent a year`, yDecimals: 2 },
        )),
      }),
      card({ title: "The curve", sub: "Each expiry's forward, from the mean of up to three strikes", body: table(cols, rows, emptyState("list", "No expiries", "")), flush: true }),
    ];
  } catch (err) {
    return H.errorBox(err);
  }
}

// ───────────────────────── RR and BF term structure ─────────────────────────

async function renderRrBf(H) {
  const u = workspace.state.underlying;
  let expiries;
  try {
    expiries = (await api(`/v1/expiries?underlying=${encodeURIComponent(u)}`)).data?.data?.expiries ?? [];
  } catch (err) {
    return H.errorBox(err);
  }
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const list = expiries.filter((e) => e >= today).slice(0, DEPTH_EXPIRIES);
  if (!list.length) return emptyState("info", "No expiries", "Pick an underlying with upcoming expiries in the top bar.");
  const seg = H.segmented("Delta", RR_DELTAS.map((d) => [String(d), `${d}Δ`]), "25");
  const out = h("div", { class: "an-contents" });
  const chartBody = h("div", { class: "stack" });
  let answers = null;
  let fresh = null;
  const draw = () => {
    const delta = Number(seg.value);
    const rows = rrBfTerm(answers, delta);
    if (!rows.length) {
      chartBody.replaceChildren(emptyState("info", "No smile to read", "No expiry answered with enough priced strikes."));
      return;
    }
    const lbl = (r) => axisDay(r.expiry);
    chartBody.replaceChildren(
      legend([{ cls: "s2", label: `Risk reversal ${delta}Δ` }, { cls: "s1", label: `Butterfly ${delta}Δ` }, { cls: "s4", label: "Risk reversal 10Δ, dashed" }, { cls: "s3", label: "Butterfly 10Δ, dashed" }]),
      seriesChart(
        [
          { id: "rr", label: `RR ${delta}Δ`, cls: "s2", points: rows.map((r) => ({ label: lbl(r), y: r.rr })) },
          { id: "bf", label: `BF ${delta}Δ`, cls: "s1", points: rows.map((r) => ({ label: lbl(r), y: r.bf })) },
          ...(delta === 10 ? [] : [
            { id: "rr10", label: "RR 10Δ", cls: "s4", dash: "6 4", points: rows.map((r) => ({ label: lbl(r), y: r.rr10 })) },
            { id: "bf10", label: "BF 10Δ", cls: "s3", dash: "6 4", points: rows.map((r) => ({ label: lbl(r), y: r.bf10 })) },
          ]),
        ],
        { label: `${u} risk reversal and butterfly by expiry, vol points`, yDecimals: 2, refs: [{ y: 0, label: "0" }] },
      ),
    );
    const near = rows[0];
    const cols = [
      { label: "Expiry", cell: (r) => h("strong", { title: r.expiry }, axisDay(r.expiry)) },
      { label: "Days", num: true, cell: (r) => formatFixed(r.dte, 1) },
      { label: "ATM IV", num: true, cell: (r) => formatPercent(r.atm, 2) },
      { label: `Call ${delta}Δ IV`, num: true, cell: (r) => formatPercent(r.callIv, 2) },
      { label: `Put ${delta}Δ IV`, num: true, cell: (r) => formatPercent(r.putIv, 2) },
      { label: `RR ${delta}Δ`, num: true, cell: (r) => formatSigned(r.rr, 2) },
      { label: `BF ${delta}Δ`, num: true, cell: (r) => formatSigned(r.bf, 2) },
      { label: "RR 10Δ", num: true, cell: (r) => formatSigned(r.rr10, 2) },
      { label: "BF 10Δ", num: true, cell: (r) => formatSigned(r.bf10, 2) },
      { label: "Smile points", num: true, cell: (r) => formatInt(r.points) },
    ];
    const rrs = rows.map((r) => r.rr).filter(isFigure);
    const slope = rrs.length > 1 ? rrs.at(-1) - rrs[0] : null;
    out.replaceChildren(
      tiles(
        tile(`RR ${delta}Δ, ${lbl(near)}`, isFigure(near.rr) ? `${formatSigned(near.rr, 2)} pts` : DASH, rrWords(near.rr)),
        tile(`BF ${delta}Δ, ${lbl(near)}`, isFigure(near.bf) ? `${formatSigned(near.bf, 2)} pts` : DASH, "Wings over ATM: the price of a big move either way"),
        tile("RR across the term", isFigure(slope) ? `${formatSigned(slope, 2)} pts` : DASH, isFigure(slope) ? `${lbl(rows[0])} to ${lbl(rows.at(-1))}: ${slope < 0 ? "skew steeper further out" : slope > 0 ? "skew flatter further out" : "level"}` : "One expiry read"),
        tile(`ATM IV, ${lbl(near)}`, formatPercent(near.atm, 2), `Call ${formatPercent(near.callIv, 1)}, put ${formatPercent(near.putIv, 1)} at ${delta}Δ`),
      ),
      card({ title: "Risk reversal and butterfly by expiry, vol points", sub: "RR = IV(call) − IV(put) at the same delta; BF = their mean − ATM IV", body: h("div", { class: "stack" }, H.segField("Delta", seg), chartBody) }),
      card({ title: "By expiry", sub: "Read in delta space, never extrapolated", body: table(cols, rows, emptyState("list", "No expiries", "")), flush: true }),
    );
  };
  seg.addEventListener("change", () => answers && draw());
  try {
    const delta = Number(seg.value);
    answers = await Promise.all(
      list.map(async (expiry) => {
        try {
          const r = await api(`/v1/analytics/rr-bf?${new URLSearchParams({ underlying: u, expiry, delta: String(delta) })}`);
          fresh ??= r.data?.meta?.freshness ?? null;
          return { expiry, data: r.data?.data ?? null };
        } catch {
          return { expiry, data: null };
        }
      }),
    );
  } catch (err) {
    return H.errorBox(err);
  }
  // The route always answers 25 and 10; 15 and 35 need their own read, made when picked.
  const extra = new Map();
  seg.addEventListener("change", async () => {
    const delta = Number(seg.value);
    if (delta === 25 || delta === 10 || extra.has(delta)) return;
    extra.set(delta, true);
    const more = await Promise.all(list.map((expiry) => api(`/v1/analytics/rr-bf?${new URLSearchParams({ underlying: u, expiry, delta: String(delta) })}`).then((r) => r.data?.data ?? null, () => null)));
    answers = answers.map((a, i) => (a.data && more[i] ? { expiry: a.expiry, data: { ...a.data, deltas: [...a.data.deltas.filter((x) => x.delta !== delta), ...more[i].deltas.filter((x) => x.delta === delta)] } } : a));
    if (Number(seg.value) === delta) draw();
  });
  if (!answers.some((a) => a.data)) return [statusRow(fresh), emptyState("info", "No smile to read", "No expiry answered; try again in a moment.")];
  draw();
  return [statusRow(fresh), out];
}

// ───────────────────────── Event vol ─────────────────────────

async function renderEventVol(H) {
  const u = workspace.state.underlying;
  let expiries;
  let term = null;
  try {
    // The term structure first: it draws beside the event, and its calmest forward vol is the baseline offered.
    const [ex, cone] = await Promise.all([
      api(`/v1/expiries?underlying=${encodeURIComponent(u)}`),
      api(`/v1/analytics/vol-cone?${new URLSearchParams({ underlying: u, expiries: String(DEPTH_EXPIRIES) })}`).catch((err) => ({ error: err })),
    ]);
    expiries = ex.data?.data?.expiries ?? [];
    term = cone.error ? cone : (cone.data ?? null);
  } catch (err) {
    return H.errorBox(err);
  }
  const td = term?.data ?? {};
  const atm = td.atmTerm ?? [];
  const fwd = td.forwardVol ?? [];
  const calm = calmestForwardVol(fwd);
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const upcoming = expiries.filter((e) => e >= today);
  const dateEl = h("input", { id: nextId("an-ev"), type: "date", min: today, value: defaultEventDate(upcoming) ?? "" });
  const baseEl = h("input", { id: nextId("an-ev"), type: "number", inputmode: "decimal", min: "1", max: "300", step: "0.05", placeholder: "Pre-event ATM IV", value: calm === null ? "" : formatInput(calm, 2) });
  const result = h("div", { class: "stack", "aria-live": "polite" });
  const tileBox = h("div", { class: "an-contents" });
  const windowsBox = h("div", { class: "stack an-ev-windows" });
  const sourceOf = (d) => (d.baseline?.source === "request" && calm !== null && Math.abs(Number(baseEl.value) - calm) < 0.005 ? "The calmest forward vol in the term" : d.baseline?.source === "request" ? "Your baseline" : (d.baseline?.source ?? "Not set"));
  const capital = (t) => (t ? `${t[0].toUpperCase()}${t.slice(1)}` : "");
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    if (!dateEl.value) {
      result.replaceChildren(emptyState("calendar", "Pick the event's date", "The options of the expiries either side of it give its priced move."));
      tileBox.replaceChildren();
      return;
    }
    result.replaceChildren(loading());
    try {
      const q = new URLSearchParams({ underlying: u, event: dateEl.value });
      if (baseEl.value) q.set("baselineVolPct", baseEl.value);
      const r = await api(`/v1/analytics/event-vol?${q}`);
      if (mine !== seq) return;
      const d = r.data?.data ?? {};
      const parts = varianceParts(d);
      const has = isFigure(d.impliedEventMovePct);
      tileBox.replaceChildren(
        tiles(
          tile("Priced event move, 1σ", has ? `±${formatFixed(d.impliedEventMovePct, 2)}%` : DASH, has ? `±${formatFixed(d.impliedEventMovePoints, 0)} points on ${formatFixed(d.spot, 0)}` : "No premium for the event"),
          tile("Average move either way", isFigure(d.expectedAbsMovePct) ? `${formatFixed(d.expectedAbsMovePct, 2)}%` : DASH, "√(2/π) × 1σ, what a straddle pays on average"),
          tile("Baseline vol", formatPercent(d.baseline?.volPct, 2), sourceOf(d)),
          tile("Share of the variance", isFigure(parts?.eventShare) ? formatPercent(parts.eventShare, 1) : DASH, `Of ${d.postEventExpiry ? axisDay(d.postEventExpiry.expiry) : "the expiry"}'s total variance`),
        ),
      );
      const rows = [
        d.preEventExpiry ? { what: "before", expiry: d.preEventExpiry.expiry, days: d.preEventExpiry.daysToExpiry, iv: d.preEventExpiry.atmIvPct, variance: d.preEventExpiry.totalVariance } : null,
        d.postEventExpiry ? { what: "after", expiry: d.postEventExpiry.expiry, days: d.postEventExpiry.daysToExpiry, iv: d.postEventExpiry.atmIvPct, variance: d.postEventExpiry.totalVariance } : null,
      ].filter(Boolean);
      const cols = [
        { label: "Expiry", cell: (x) => h("span", {}, h("strong", { title: x.expiry }, axisDay(x.expiry)), h("span", { class: "muted" }, ` ${x.what}`)) },
        { label: "Days", num: true, cell: (x) => formatFixed(x.days, 1) },
        { label: "ATM IV", num: true, cell: (x) => formatPercent(x.iv, 2) },
        { label: "Total variance", num: true, cell: (x) => formatFixed(x.variance, 5) },
      ];
      // replaceChildren prints a null as "null": the parts that may be missing are filtered out first.
      const partsList = [
        d.reason && !has ? h("p", { class: "muted" }, `${capital(d.reason)}.`) : null,
        rows.length ? table(cols, rows, null) : null,
        parts
          ? h(
              "dl",
              { class: "an-ev-parts" },
              h("dt", {}, "Known before the event"),
              h("dd", {}, formatFixed(parts.pre, 5)),
              h("dt", {}, "Ordinary drift between the expiries"),
              h("dd", {}, formatFixed(parts.drift, 5)),
              h("dt", {}, "The event"),
              h("dd", {}, formatFixed(parts.event, 5)),
            )
          : null,
        h("p", { class: "muted small" }, `Event assumed at ${d.eventTimeAssumed ?? "the session open"}. Event variance = s2² T2 − s1² T1 − b² (T2 − T1); the 1σ move is its square root.`),
      ];
      result.replaceChildren(...partsList.filter(Boolean));
    } catch (err) {
      if (mine === seq) result.replaceChildren(H.errorBox(err));
    }
  };
  // Every window between expiries at the baseline in the field: where the options hold an event's worth of variance.
  const drawWindows = () => {
    const list = eventWindows(atm, baseEl.value === "" ? null : Number(baseEl.value));
    const cols = [
      { label: "Window", cell: (w) => h("strong", {}, `${axisDay(w.from)} to ${axisDay(w.to)}`) },
      { label: "Days", num: true, cell: (w) => formatFixed(w.days, 1) },
      { label: "Forward vol", num: true, cell: (w) => formatPercent(w.forwardVolPct, 2) },
      { label: "Event move, 1σ", num: true, cell: (w) => (isFigure(w.movePct) ? `±${formatFixed(w.movePct, 2)}%` : DASH) },
    ];
    windowsBox.replaceChildren(
      h("h3", { class: "an-sub-head" }, "Event premium by window"),
      h("p", { class: "muted small" }, baseEl.value === "" ? "Set a baseline vol to price the windows between expiries." : `Over the ${formatPercent(Number(baseEl.value), 2)} baseline: an event on any day inside a window gets that window's move.`),
      table(cols, list, emptyState("list", "No windows", "Two expiries at least 3 days out are needed.")),
    );
  };
  dateEl.addEventListener("change", load);
  baseEl.addEventListener("change", () => (drawWindows(), load()));
  drawWindows();
  await load();
  const termBody = term?.error
    ? H.errorBox(term.error)
    : atm.length
      ? h(
          "div",
          { class: "stack" },
          legend([{ cls: "s1", label: "ATM IV" }, { cls: "s2", label: "Forward vol into the expiry, dashed" }]),
          seriesChart(
            [
              { id: "atm", label: "ATM IV", cls: "s1", points: atm.map((x) => ({ label: axisDay(x.expiry), at: x.daysToExpiry, y: x.atmIvPct })) },
              { id: "fwd", label: "Forward vol", cls: "s2", dash: "6 4", points: atm.map((x, i) => ({ label: axisDay(x.expiry), at: x.daysToExpiry, y: i === 0 ? x.atmIvPct : (fwd[i - 1]?.forwardVolPct ?? null) })) },
            ],
            { label: `${u} ATM IV and forward vol by expiry, percent`, yDecimals: 1, refs: calm === null ? [] : [{ y: calm, label: "Calmest" }] },
          ),
          // What the underlying has actually moved, beside what the options price: the other baseline to weigh.
          (td.cone ?? []).length
            ? h(
                "div",
                { class: "stack an-ev-windows" },
                h("h3", { class: "an-sub-head" }, "Realised vol by tenor"),
                table(
                  [
                    { label: "Tenor", cell: (c) => h("strong", {}, `${formatInt(c.tenorDays)} days`) },
                    { label: "Now", num: true, cell: (c) => formatPercent(c.current, 2) },
                    { label: "Middle half", num: true, cell: (c) => (isFigure(c.p25) && isFigure(c.p75) ? `${formatFixed(c.p25, 1)} to ${formatFixed(c.p75, 1)}%` : DASH) },
                    { label: "Percentile", num: true, cell: (c) => (isFigure(c.currentPercentile) ? formatFixed(c.currentPercentile, 0) : DASH) },
                  ],
                  td.cone,
                  null,
                ),
              )
            : null,
        )
      : emptyState("info", "No term structure", "No expiry at least 3 days out had an ATM IV.");
  const vrp = td.vrp;
  return [
    term?.data ? statusRow(term.meta?.freshness) : null,
    tileBox,
    card({ title: "Event", sub: "The date and the vol to assume without it", body: h("div", { class: "stack" }, h("div", { class: "form-grid" }, H.field("Event date", dateEl), H.field("Baseline vol %", baseEl, calm === null ? "Empty: the pre-event ATM IV" : "Set to the calmest forward vol")), result, windowsBox) }),
    card({
      title: "Term structure",
      sub: vrp ? `ATM IV ${formatPercent(vrp.atmIvPct, 1)} against ${formatInt(vrp.hvTenorDays)}-day realised ${formatPercent(vrp.hvPct, 1)}: ${formatSigned(vrp.spreadPts, 2)} pts` : "ATM IV by expiry and the forward vol between them",
      body: termBody,
    }),
  ];
}

/** The pages this module draws, for analytics.js's sources(). */
export function analyticsDepthPages(getHelpers) {
  return [
    {
      id: "depth",
      render: () => {
        const H = getHelpers();
        return H.tab === "rrbf" ? renderRrBf(H) : H.tab === "event" ? renderEventVol(H) : renderForward(H);
      },
    },
  ];
}
