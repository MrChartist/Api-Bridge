// Analytics › Risk (book VaR, exposure and concentration; execution costs) and Strategy lab › Backtest, drawn in the
// desk's analytics host (analytics.js). PR 17 shipped these routes without pages (docs/design/pr17-integration.md):
//  - GET /v1/analytics/risk/var, /exposure, /concentration, /tca read one account's book. Read-only; nothing here can
//    place or change an order. The scenario grid and what-if stay on Positions (the desk's own, see the integration doc);
//  - POST /v1/analytics/backtest replays a scanner condition over candles (read scope, no orders).
// Reads go through api(); nothing polls. Figures become text through format.js only.
import { api, app, card, emptyState, h, icon, pill, table } from "./app.js";
import { DASH, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import { chartHeight, chartHost, compact, niceScale, nextId, readNumber, s as svgEl, statusRow, strikeBars, svgRoot, tile, tiles } from "./analyticsViews.js";
import { seriesChart } from "./analyticsMore.js";
import { contractName } from "./flows.js";

const DESK_SLOT = "mcb.dashboard.desk";

/** Rupees in the desk's short form (₹69.05 L, −₹4.8k), the sign a true minus. */
export const inrShort = (v) => (isFigure(v) ? `${Number(v) < 0 ? "−" : ""}₹${compact(Math.abs(Number(v)))}` : DASH);

/** A weight (0 to 1) as a percent. */
export const weightText = (w) => (isFigure(w) ? formatPercent(Number(w) * 100, 1) : DASH);

/**
 * The account a risk read starts on (pure): the desk's own account when it can hold positions, else the first paper
 * account, else the first that can.
 */
export function pickAccount(accounts, deskAccount) {
  const usable = (accounts ?? []).filter((a) => a.enabled !== false && (a.capabilities ?? []).includes("positions"));
  return (usable.find((a) => a.id === deskAccount) ?? usable.find((a) => a.broker === "paper") ?? usable[0])?.id ?? null;
}

/** What concentration means in words (pure): `effective` is 1 / HHI over underlyings. */
export function concentrationWords(effective, n) {
  if (!isFigure(effective) || !(n > 0)) return "No priced positions";
  if (n === 1) return "All in one underlying";
  const e = Number(effective);
  return e >= n * 0.8 ? `Spread evenly over ${formatInt(n)} underlyings` : `Weighted like ${formatFixed(e, 1)} even underlyings`;
}

/**
 * A backtest form's values as the POST body (pure). `f`: strings from the fields. Returns { body } or { problems }.
 */
export function backtestBody(f) {
  const problems = [];
  const body = { symbol: String(f.symbol ?? "").trim().toUpperCase(), interval: f.interval || "1d", entry: String(f.entry ?? "").trim(), side: f.side === "short" ? "short" : "long" };
  if (!/^[A-Z]{2,4}:[A-Z0-9&_-]{1,40}$/.test(body.symbol)) problems.push("Symbol must look like NSE:RELIANCE.");
  if (!body.entry) problems.push("Entry needs a condition, for example rsi(14) < 30.");
  const exit = String(f.exit ?? "").trim();
  if (exit) body.exit = exit;
  const num = (text, key, name, { min, max, int = false }) => {
    if (!String(text ?? "").trim()) return;
    const n = readNumber(text);
    if (n === null || n < min || n > max || (int && !Number.isInteger(n))) problems.push(`${name} must be ${int ? "a whole number" : "a number"} from ${min} to ${max}.`);
    else body[key] = n;
  };
  num(f.countback, "countback", "Bars", { min: 2, max: 5000, int: true });
  num(f.stopLossPct, "stopLossPct", "Stop loss %", { min: 0.01, max: 100 });
  num(f.targetPct, "targetPct", "Target %", { min: 0.01, max: 1000 });
  num(f.maxBarsInTrade, "maxBarsInTrade", "Bars in a trade", { min: 1, max: 5000, int: true });
  return problems.length ? { problems } : { body };
}

/**
 * The equity curve as one series for seriesChart (pure): the return in % on the starting capital (an axis of 0 to
 * 900 % reads at a glance; one of 100000 to 1500000 rupees does not), thinned to at most `max` points.
 */
export function equitySeries(curve, start, max = 400) {
  const pts = curve ?? [];
  const step = Math.max(1, Math.ceil(pts.length / max));
  const keep = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const base = Number(start) > 0 ? Number(start) : Number(pts[0]?.equity) || 1;
  return [{ id: "eq", label: "Return %", cls: "s1", points: keep.map((p) => ({ label: String(p.date ?? "").slice(0, 10), y: isFigure(p.equity) ? Math.round((Number(p.equity) / base - 1) * 10000) / 100 : null })) }];
}

/**
 * The VaR histogram's geometry (pure): bins [{ from, to, count }] as bars across `width`, the bins at or beyond the VaR
 * loss marked as the tail, and the x of the VaR and expected-shortfall lines (a loss is a P&L of minus that figure).
 */
export function histogramLayout(bins, { width = 640, height = 260, varLoss = null, esLoss = null, padL = 40, padR = 12, padT = 18, padB = 28 } = {}) {
  const list = bins ?? [];
  if (!list.length) return { width, height, bars: [], ticks: [], lines: [], empty: true };
  const lo = list[0].from;
  const hi = list.at(-1).to;
  const span = hi > lo ? hi - lo : 1;
  const x = (v) => padL + ((v - lo) / span) * (width - padL - padR);
  const maxN = Math.max(1, ...list.map((b) => b.count));
  const ys = niceScale(0, maxN, 4);
  const y = (n) => height - padB - (n / ys.max) * (height - padT - padB);
  const cut = isFigure(varLoss) ? -Number(varLoss) : null;
  const bars = list.map((b) => ({ x: x(b.from) + 1, w: Math.max(1, x(b.to) - x(b.from) - 2), y: y(b.count), h: height - padB - y(b.count), tail: cut !== null && b.to <= cut + 1e-9, title: b.count }));
  const lines = [
    isFigure(varLoss) ? { x: x(-Number(varLoss)), label: "VaR", cls: "var" } : null,
    isFigure(esLoss) ? { x: x(-Number(esLoss)), label: "ES", cls: "es" } : null,
  ].filter((l) => l && l.x >= padL && l.x <= width - padR);
  const xt = niceScale(lo, hi, Math.max(3, Math.floor((width - padL - padR) / 110)));
  return { width, height, padL, padR, padB, bars, lines, yTicks: ys.ticks.map((t) => ({ y: y(t), label: formatInt(t) })), ticks: xt.ticks.filter((t) => t >= lo && t <= hi).map((t) => ({ x: x(t), label: inrShort(t) })), empty: false };
}

function varHistogram(bins, v) {
  return chartHost((w) => {
    const L = histogramLayout(bins, { width: w, height: Math.min(chartHeight(w) * 0.7, 340), varLoss: v.var, esLoss: v.expectedShortfall });
    const svg = svgRoot(L.width, L.height, `Distribution of ${formatInt(v.observations)} simulated one-day P&Ls, with the VaR and expected shortfall.`);
    if (L.empty) return svg;
    for (const t of L.yTicks) svg.append(svgEl("line", { class: "grid-line", x1: L.padL, x2: L.width - L.padR, y1: t.y, y2: t.y }), svgEl("text", { class: "tick", x: L.padL - 6, y: t.y + 4, "text-anchor": "end" }, t.label));
    for (const t of L.ticks) svg.append(svgEl("text", { class: "tick", x: t.x, y: L.height - 8, "text-anchor": "middle" }, t.label));
    for (const b of L.bars) svg.append(svgEl("rect", { class: `bar ${b.tail ? "tail" : "body"}`, x: b.x, y: b.y, width: b.w, height: Math.max(0, b.h), rx: 2 }, svgEl("title", {}, `${formatInt(b.title)} days`)));
    for (const l of L.lines) svg.append(svgEl("line", { class: `marker-line ${l.cls}`, x1: l.x, x2: l.x, y1: 12, y2: L.height - L.padB }), svgEl("text", { class: "tag", x: l.x + (l.cls === "es" ? -4 : 4), y: 12, "text-anchor": l.cls === "es" ? "end" : "start" }, l.label));
    return svg;
  });
}

const signed = (v, dp = 2, suffix = "") => (isFigure(v) ? h("span", { class: Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : undefined }, `${formatSigned(v, dp)}${suffix}`) : DASH);
const loading = () => h("p", { class: "muted", role: "status" }, "Loading…");

// ───────────────────────── Risk ─────────────────────────

async function accountBar(H, onChange, extra = []) {
  const accounts = (await api("/v1/accounts")).data?.data ?? [];
  let desk = null;
  try {
    desk = JSON.parse(app.local.get(DESK_SLOT) ?? "null")?.account ?? null;
  } catch {
    desk = null;
  }
  const first = pickAccount(accounts, desk);
  if (!first) return { empty: emptyState("accounts", "No account holds positions", "Risk reads an account's open positions. Add a broker or use the paper account.", h("a", { class: "lk", href: "#/accounts" }, "Open Accounts")) };
  const usable = accounts.filter((a) => a.enabled !== false && (a.capabilities ?? []).includes("positions"));
  const acct = h("select", { id: nextId("an-acct") }, usable.map((a) => h("option", { value: a.id }, a.label && a.label !== a.id ? `${a.label} (${a.id})` : a.id)));
  acct.value = first;
  acct.addEventListener("change", onChange);
  for (const x of extra) x.el.addEventListener("change", onChange);
  const bar = h("section", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "form-grid" }, H.field("Account", acct), ...extra.map((x) => H.field(x.label, x.el)))));
  return { bar, acct };
}

function drawRisk(v, ex, co, account) {
  const var_ = v.data?.data ?? {};
  const e = ex.data?.data ?? {};
  const c = co.data?.data ?? {};
  const fr = v.data?.meta?.freshness ?? ex.data?.meta?.freshness;
  const errors = [...(v.data?.errors ?? []), ...(ex.data?.errors ?? [])];
  const und = (e.byUnderlying ?? []).map((u) => ({ ...u, weight: (c.byUnderlying ?? []).find((x) => x.underlying === u.underlying)?.weight }));
  const conf = var_.confidence ?? 95;
  const strip = tiles(
    tile(`1-day VaR, ${conf}%`, var_.var === null || var_.var === undefined ? DASH : formatRupee(var_.var, 0), var_.var === null || var_.var === undefined ? var_.reason ?? "Not enough history" : `Expected shortfall ${formatRupee(var_.expectedShortfall, 0)}`, var_.var ? "down" : undefined),
    tile("Gross notional", inrShort(e.grossNotional), `Net ${inrShort(e.netNotional)}`),
    tile("Net delta exposure", inrShort(e.deltaAdjusted?.net), "Rupees the book moves with the underlyings"),
    tile("Margin used", isFigure(e.marginUtilisationPct) ? formatPercent(e.marginUtilisationPct, 1) : DASH, e.funds ? `Of ${inrShort(Number(e.funds.usedMargin) + Number(e.funds.availableCash))} the account reports` : e.fundsNote ?? "Funds not reported"),
    tile("Concentration", isFigure(c.effectiveUnderlyings) ? `${formatFixed(c.effectiveUnderlyings, 1)} underlyings` : DASH, concentrationWords(c.effectiveUnderlyings, (c.byUnderlying ?? []).length)),
  );
  const undCols = [
    { label: "Underlying", cell: (r) => h("strong", {}, r.underlying) },
    { label: "Legs", num: true, cell: (r) => formatInt(r.positions) },
    { label: "Long", num: true, cell: (r) => inrShort(r.longNotional) },
    { label: "Short", num: true, cell: (r) => inrShort(r.shortNotional) },
    { label: "Net", num: true, cell: (r) => inrShort(r.netNotional) },
    { label: "Delta exposure", num: true, cell: (r) => inrShort(r.deltaExposure) },
    { label: "Weight", num: true, cell: (r) => weightText(r.weight) },
  ];
  const posCols = [
    { label: "Position", cell: (r) => h("span", { class: "an-wrap", title: r.symbol }, contractName(r.symbol)) },
    { label: "Notional", num: true, cell: (r) => inrShort(r.notional) },
    { label: "Weight", num: true, cell: (r) => weightText(r.weight) },
  ];
  const dn = var_.deltaNormal;
  const method =
    var_.method === "historical-simulation"
      ? `Historical simulation over ${formatInt(var_.observations)} days (${var_.period?.from ?? DASH} to ${var_.period?.to ?? DASH}): the book repriced for each past daily move of its underlyings.`
      : var_.method === "delta-normal"
        ? var_.note ?? "Delta-normal from past daily returns."
        : var_.reason ?? "Not worked out.";
  const varRows = [
    ["Value at risk", isFigure(var_.var) ? formatRupee(var_.var, 0) : DASH, "down"],
    ["Expected shortfall", isFigure(var_.expectedShortfall) ? formatRupee(var_.expectedShortfall, 0) : DASH, "down"],
    ["Worst day in the window", isFigure(var_.worstDayPnl) ? formatRupee(var_.worstDayPnl, 0) : DASH, Number(var_.worstDayPnl) < 0 ? "down" : ""],
    ["Delta-normal VaR", isFigure(dn?.var) ? formatRupee(dn.var, 0) : DASH, ""],
    ["VaR of gross notional", isFigure(var_.varPctOfGross) ? formatPercent(var_.varPctOfGross, 2) : DASH, ""],
  ];
  const kv = (rows) => h("dl", { class: "kv" }, rows.map(([k, val, tone]) => h("div", {}, h("dt", {}, k), h("dd", { class: tone || undefined }, val))));
  const warn = [...(var_.warnings ?? []), ...errors.map((x) => `${x.underlying ?? x.symbol ?? ""}: ${x.message}`)];
  const skipped = [...new Map([...(var_.skipped ?? []), ...(e.skipped ?? [])].map((s) => [s.symbol, s])).values()];
  return [
    statusRow(fr),
    strip,
    card({ title: "Exposure by underlying", sub: "Notional is quantity times the underlying's price", body: table(undCols, und, emptyState("list", "No open positions", `${account} has no priced positions.`, null, { compact: true }), { mobile: "stack" }), flush: true }),
    card({ title: "Value at risk", sub: `${var_.label ?? "Estimate only."} ${method}`, actions: pill(`${conf}%, 1 day`, "info"), body: h("div", { class: "stack" }, kv(varRows), (var_.distribution ?? []).length ? varHistogram(var_.distribution, var_) : null, warn.length ? h("ul", { class: "note-list muted small" }, warn.map((w) => h("li", {}, w))) : null) }),
    und.length
      ? card({
          title: "Delta exposure by underlying",
          sub: "Rupees each underlying moves the book for a 1x move in its price; right is long, left is short",
          body: strikeBars(
            und.map((u) => ({ label: u.underlying, bars: [{ value: Number(u.deltaExposure) || 0, cls: Number(u.deltaExposure) >= 0 ? "call" : "put", title: `${u.underlying}: ${inrShort(u.deltaExposure)}` }] })),
            { label: "Delta exposure by underlying, in rupees", layout: { rowH: 34, labelW: 96, tickFormat: (x) => inrShort(x) } },
          ),
        })
      : null,
    card({ title: "Largest positions", sub: `By gross notional; HHI ${isFigure(c.hhi10000) ? formatInt(c.hhi10000) : DASH} of 10000. ${c.note ?? ""}`, body: table(posCols, c.topPositions ?? [], emptyState("list", "No positions", "", null, { compact: true }), { mobile: "stack" }), flush: true }),
    card({ title: "By sector", sub: "Sectors come from a small built-in map", body: h("dl", { class: "kv" }, (c.bySector ?? []).map((s) => h("div", {}, h("dt", {}, s.sector), h("dd", {}, `${weightText(s.weight)} · ${inrShort(s.notional)}`)))) }),
    skipped.length ? card({ title: "Left out", sub: "Legs the risk figures could not price", body: h("ul", { class: "note-list muted small" }, skipped.map((x) => h("li", {}, `${contractName(x.symbol)}: ${x.reason}`))) }) : null,
  ];
}

async function renderRiskBook(H) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  const confEl = h("select", { id: nextId("an-conf") }, [["95", "95%"], ["99", "99%"]].map(([v, t]) => h("option", { value: v }, t)));
  const daysEl = h("select", { id: nextId("an-days") }, [["60", "60 days"], ["125", "125 days"], ["250", "250 days"], ["500", "500 days"]].map(([v, t]) => h("option", { value: v }, t)));
  daysEl.value = "250";
  let seq = 0;
  const ab = await accountBar(H, () => load(), [{ label: "Confidence", el: confEl }, { label: "History", el: daysEl }]);
  if (ab.empty) return ab.empty;
  async function load() {
    const mine = ++seq;
    const a = ab.acct.value;
    const q = `account=${encodeURIComponent(a)}`;
    out.replaceChildren(loading());
    try {
      const [v, ex, co] = await Promise.all([api(`/v1/analytics/risk/var?${q}&confidence=${confEl.value}&days=${daysEl.value}`), api(`/v1/analytics/risk/exposure?${q}`), api(`/v1/analytics/risk/concentration?${q}&top=8`)]);
      if (mine === seq) out.replaceChildren(...drawRisk(v, ex, co, a).filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  }
  await load();
  return h("div", { class: "stack" }, ab.bar, out);
}

function drawCosts(res) {
  const d = res.data?.data ?? {};
  const fills = d.fills ?? [];
  const cols = [
    { label: "Contract", cell: (r) => h("span", { class: "an-wrap", title: r.symbol }, contractName(r.symbol)) },
    { label: "Side", cell: (r) => pill(r.side === "SELL" ? "Sell" : "Buy", r.side === "SELL" ? "warn" : "info") },
    { label: "Quantity", num: true, cell: (r) => formatInt(r.qty) },
    { label: "Price", num: true, cell: (r) => formatFixed(r.price, 2) },
    { label: "Order", cell: (r) => (r.orderType === "LIMIT" ? "Limit" : r.orderType === "MARKET" ? "Market" : r.orderType ?? DASH) },
    { label: "Slippage (bps)", num: true, cell: (r) => signed(r.slippageBps, 2) },
    { label: "Charges", num: true, cell: (r) => (isFigure(r.charges) ? formatRupee(r.charges) : DASH) },
    { label: "Latency (ms)", num: true, cell: (r) => (isFigure(r.latencyMs) ? formatInt(r.latencyMs) : DASH) },
  ];
  return [
    tiles(
      tile("Paper fills", formatInt(d.fillCount ?? 0), `${inrShort(d.totals?.notional)} traded${d.truncated ? ", latest only" : ""}`),
      tile("Average slippage", isFigure(d.slippage?.avgBps) ? `${formatSigned(d.slippage.avgBps, 2)} bps` : DASH, `${formatInt(d.slippage?.measuredFills ?? 0)} limit fills measured`),
      tile("Charges", isFigure(d.totals?.chargesBps) ? `${formatFixed(d.totals.chargesBps, 2)} bps` : DASH, isFigure(d.totals?.charges) ? formatRupee(d.totals.charges) : "Not reported"),
      tile("Median latency", isFigure(d.latencyMs?.median) ? `${formatInt(d.latencyMs.median)} ms` : DASH, isFigure(d.latencyMs?.p95) ? `95th percentile ${formatInt(d.latencyMs.p95)} ms` : "No timed fills"),
    ),
    card({ title: "Fills", sub: d.slippage?.note ?? "", body: table(cols, fills, emptyState("list", "No paper fills yet", "Costs appear once the paper account has filled an order.", null, { compact: true }), { mobile: "stack" }), flush: true }),
    card({ title: "Not measured", sub: "What the paper store does not record", body: h("ul", { class: "note-list muted small" }, (d.unavailable ?? []).map((t) => h("li", {}, t))) }),
  ];
}

async function renderRiskCosts(H) {
  const out = h("div", { class: "stack", "aria-live": "polite" });
  let seq = 0;
  const ab = await accountBar(H, () => load());
  if (ab.empty) return ab.empty;
  async function load() {
    const mine = ++seq;
    out.replaceChildren(loading());
    try {
      const res = await api(`/v1/analytics/risk/tca?account=${encodeURIComponent(ab.acct.value)}`);
      if (mine === seq) out.replaceChildren(...drawCosts(res).filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  }
  await load();
  return h("div", { class: "stack" }, ab.bar, out);
}

// ───────────────────────── Backtest ─────────────────────────

const EXIT_WORDS = { signal: "Exit rule", stop: "Stop loss", target: "Target", time: "Time limit", end: "End of data" };
const INTERVALS = [["1d", "Daily"], ["1w", "Weekly"], ["60m", "60 minutes"], ["15m", "15 minutes"], ["5m", "5 minutes"]];

function drawBacktest(res) {
  const d = res.data?.data ?? {};
  const st = d.stats ?? {};
  const bh = d.buyAndHold ?? {};
  const fr = res.data?.meta?.freshness;
  const trades = d.trades ?? [];
  const cols = [
    { label: "Entry", cell: (r) => r.entryDate ?? DASH },
    { label: "Closed", cell: (r) => r.exitDate ?? DASH },
    { label: "Prices", num: true, cell: (r) => `${formatFixed(r.entryPrice, 2)} to ${formatFixed(r.exitPrice, 2)}` },
    { label: "Net P&L", num: true, cell: (r) => (isFigure(r.netPnl) ? h("span", { class: Number(r.netPnl) >= 0 ? "up" : "down" }, formatRupee(r.netPnl, 0)) : DASH) },
    { label: "Return", num: true, cell: (r) => signed(r.returnPct, 2, "%") },
    { label: "Exit", cell: (r) => EXIT_WORDS[r.exitReason] ?? r.exitReason ?? DASH },
  ];
  const kv = (rows) => h("dl", { class: "kv" }, rows.map(([k, v, tone]) => h("div", {}, h("dt", {}, k), h("dd", { class: tone || undefined }, v))));
  return [
    statusRow(fr),
    tiles(
      tile("Total return", isFigure(st.totalReturnPct) ? `${formatSigned(st.totalReturnPct, 2)}%` : DASH, `Ends at ${formatRupee(st.finalEquity, 0)}`, Number(st.totalReturnPct) >= 0 ? "up" : "down"),
      tile("Against buy and hold", isFigure(st.totalReturnPct) && isFigure(bh.totalReturnPct) ? `${formatSigned(st.totalReturnPct, 1)}% vs ${formatSigned(bh.totalReturnPct, 1)}%` : DASH, "Buy and hold: the same capital, first open to last close"),
      tile("Win rate", isFigure(st.winRatePct) ? formatPercent(st.winRatePct, 1) : DASH, `${formatInt(st.trades ?? 0)} trades`),
      tile("Max drawdown", isFigure(st.maxDrawdownPct) ? `${formatFixed(st.maxDrawdownPct, 2)}%` : DASH, st.troughDate ? `Low on ${String(st.troughDate).slice(0, 10)}` : "", Number(st.maxDrawdownPct) > 0 ? "down" : undefined),
    ),
    card({ title: "Return on capital, %", sub: `${d.symbol ?? ""} ${d.interval ?? ""}, ${formatInt(d.period?.bars ?? 0)} bars from ${String(d.period?.from ?? DASH).slice(0, 10)} to ${String(d.period?.to ?? DASH).slice(0, 10)}`, actions: res.data?.meta?.demo ? pill("Demo history: not real prices", "warn") : null, body: seriesChart(equitySeries(d.equityCurve, d.request?.initialCapital), { label: `Return of the backtest in percent, ${d.symbol}`, yDecimals: 0, refs: [{ y: 0, label: "" }] }) }),
    card({
      title: "Statistics",
      sub: d.method?.summary ?? "",
      body: h(
        "div",
        { class: "stack" },
        kv([
          ["Net P&L", formatRupee(st.netPnl, 0), Number(st.netPnl) >= 0 ? "up" : "down"],
          ["CAGR", isFigure(st.cagrPct) ? `${formatSigned(st.cagrPct, 2)}%` : DASH, ""],
          ["Sharpe", isFigure(st.sharpe) ? formatFixed(st.sharpe, 2) : DASH, ""],
          ["Profit factor", isFigure(st.profitFactor) ? formatFixed(st.profitFactor, 2) : DASH, ""],
          ["Expectancy", isFigure(st.expectancy) ? formatRupee(st.expectancy, 0) : DASH, ""],
          ["Time in market", isFigure(st.exposurePct) ? formatPercent(st.exposurePct, 1) : DASH, ""],
          ["Fees", formatRupee(st.totalFees, 0), ""],
          ["Average win", isFigure(st.avgWin) ? formatRupee(st.avgWin, 0) : DASH, "up"],
          ["Average loss", isFigure(st.avgLoss) ? formatRupee(st.avgLoss, 0) : DASH, "down"],
        ]),
        (d.warnings ?? []).length ? h("ul", { class: "note-list muted small" }, d.warnings.map((w) => h("li", {}, w))) : null,
      ),
    }),
    card({ title: "Trades", sub: `${formatInt(trades.length)} in the window, latest last`, body: table(cols, trades, emptyState("list", "No trades", "The entry condition never fired in this window.", null, { compact: true }), { mobile: "stack" }), flush: true }),
  ];
}

async function renderBacktest(H) {
  const ex = (await api("/v1/analytics/backtest/examples")).data?.data?.examples ?? [];
  const mk = (tag, props = {}) => h(tag, { id: nextId("an-bt"), spellcheck: "false", autocomplete: "off", ...props });
  const els = {
    example: mk("select", {}),
    symbol: mk("input", { placeholder: "NSE:RELIANCE", autocapitalize: "characters" }),
    interval: mk("select"),
    countback: mk("input", { type: "number", inputmode: "numeric", min: "2", max: "5000", step: "1" }),
    side: mk("select"),
    entry: mk("input", { placeholder: "rsi(14) < 30" }),
    exit: mk("input", { placeholder: "Optional" }),
    stopLossPct: mk("input", { type: "number", inputmode: "decimal", min: "0", step: "any", placeholder: "None" }),
    targetPct: mk("input", { type: "number", inputmode: "decimal", min: "0", step: "any", placeholder: "None" }),
    maxBarsInTrade: mk("input", { type: "number", inputmode: "numeric", min: "1", step: "1", placeholder: "None" }),
  };
  els.example.append(h("option", { value: "" }, "My own rule"), ...ex.map((e) => h("option", { value: e.id }, e.title)));
  els.interval.append(...INTERVALS.map(([v, t]) => h("option", { value: v }, t)));
  els.side.append(h("option", { value: "long" }, "Long"), h("option", { value: "short" }, "Short"));
  const fill = (b) => {
    for (const k of ["symbol", "interval", "countback", "side", "entry", "exit", "stopLossPct", "targetPct", "maxBarsInTrade"]) els[k].value = b?.[k] === undefined ? (k === "interval" ? "1d" : k === "side" ? "long" : "") : String(b[k]);
  };
  els.example.addEventListener("change", () => {
    const e = ex.find((x) => x.id === els.example.value);
    if (e) fill(e.body);
  });
  // A rule with both an entry and an exit starts the page (RSI mean reversion when the Bridge lists it).
  const start = ex.find((x) => x.id === "rsi-mean-reversion") ?? ex[0];
  els.example.value = start?.id ?? "";
  fill(start?.body ?? { symbol: "NSE:RELIANCE", interval: "1d", countback: 500, entry: "rsi(14) < 30", exit: "rsi(14) > 55" });
  const out = h("div", { class: "stack", "aria-live": "polite" });
  let seq = 0;
  const run = async () => {
    const r = backtestBody(Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value])));
    if (r.problems) return out.replaceChildren(H.errorBox({ title: "Check the rule", detail: r.problems.join(" ") }));
    const mine = ++seq;
    out.replaceChildren(loading());
    try {
      const res = await api("/v1/analytics/backtest", { method: "POST", body: r.body });
      if (mine === seq) out.replaceChildren(...drawBacktest(res).filter(Boolean));
    } catch (err) {
      if (mine === seq) out.replaceChildren(H.errorBox(err));
    }
  };
  const runBtn = h("button", { type: "submit", class: "primary" }, icon("play"), "Run backtest");
  const form = h(
    "form",
    { class: "stack", novalidate: true, onsubmit: (e) => (e.preventDefault(), run()) },
    h("div", { class: "form-grid an-bt-rules" }, H.field("Start from", els.example), H.field("Enter when", els.entry), H.field("Exit when", els.exit)),
    h(
      "div",
      { class: "form-grid" },
      H.field("Symbol", els.symbol),
      H.field("Bars", els.interval),
      H.field("How many bars", els.countback),
      H.field("Side", els.side),
      H.field("Stop loss %", els.stopLossPct),
      H.field("Target %", els.targetPct),
      H.field("Most bars in a trade", els.maxBarsInTrade),
    ),
    h("div", { class: "row" }, runBtn, h("span", { class: "muted small" }, "Conditions use the scanner language, read on each bar's close and filled at the next open. Read-only: nothing here places an order.")),
  );
  await run();
  return h("div", { class: "stack" }, card({ title: "Rule", sub: "Pick an example or write your own; fees and slippage are 0.05% each way", body: form, cls: "an-bt-form" }), out);
}

/** The pages this module draws, for analytics.js's sources(). */
export function analyticsRiskPages(getHelpers) {
  return [
    { id: "risk", render: () => (getHelpers().tab === "costs" ? renderRiskCosts(getHelpers()) : renderRiskBook(getHelpers())) },
    { id: "backtest", render: () => renderBacktest(getHelpers()) },
  ];
}
