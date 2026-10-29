/**
 * Option Screener logic (PRD 07), pure: the eight preset tabs (columns with formula titles and priorities, filters,
 * sorts, phone card keys), the per-chain records the tabs read, settings validation, the filter funnel, the one-line
 * "why" reasons, the hand-off into the desk's saved state and the daily IV baseline. No DOM, no fetch: tested in
 * screens.test.mjs. Every number becomes text through format.js.
 */
import { DASH, formatCompact, formatFixed, formatInt, formatPercent, formatRupee, formatSigned, isFigure } from "./format.js";
import * as O from "./options.js";

const num = (v) => (isFigure(v) ? Number(v) : null);
const DAY_MON = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
const IST_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const IST_HM = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "3 Nov" */
const EXPIRY_TEXT = new Map();
export function expiryText(e) {
  let t = EXPIRY_TEXT.get(e);
  if (t === undefined) {
    t = ISO_DAY.test(String(e ?? "")) ? DAY_MON.format(new Date(`${e}T00:00:00Z`)) : String(e ?? "");
    if (EXPIRY_TEXT.size < 500) EXPIRY_TEXT.set(e, t);
  }
  return t;
}
/** "NIFTY 3 Nov" */
export const chainName = (u, e) => `${u} ${expiryText(e)}`;
/** "NIFTY 3 Nov 26200 PE" */
export const contractName = (r) => `${r.underlying} ${expiryText(r.expiry)} ${formatInt(r.strike)} ${r.right}`;
/** The IST calendar date (YYYY-MM-DD) of a time. */
export const istDate = (ms) => IST_DATE.format(new Date(ms));
/** "14:32" in IST. */
export const istHm = (ms) => (Number.isFinite(ms) ? IST_HM.format(new Date(ms)) : DASH);
/** "5d 14h", "Expires today". */
export function daysLabel(days) {
  const d = num(days);
  if (d === null) return DASH;
  if (d < 1) return "Expires today";
  const whole = Math.floor(d);
  return `${whole}d ${Math.floor((d - whole) * 24)}h`;
}
/** "12 s", "3 m", "2 h". */
export function ageText(ms) {
  const v = num(ms);
  if (v === null) return DASH;
  if (v < 60_000) return `${formatInt(Math.max(0, v) / 1000)} s`;
  if (v < 3_600_000) return `${formatInt(Math.floor(v / 60_000))} m`;
  return `${formatInt(Math.floor(v / 3_600_000))} h`;
}

// ── Formatting helpers (format.js only) ──
const f2 = (v) => formatFixed(v, 2);
const f1 = (v) => formatFixed(v, 1);
const pts = (v) => (num(v) === null ? DASH : `${formatSigned(v, 1)} pts`);
const pct1 = (v) => formatPercent(v, 1);
const pop = (v) => (num(v) === null ? DASH : formatPercent(v * 100, 0));
const rupee = (v) => formatRupee(v, 0);
const bigRupee = (v) => (num(v) === null ? DASH : `${v < 0 ? "-" : ""}₹${formatCompact(Math.abs(v))}`);
const times = (v) => (num(v) === null ? DASH : `${formatFixed(v, 2)}×`);
const sigma = (v) => (num(v) === null ? DASH : `${formatFixed(v, 2)}σ`);
const compact = (v) => formatCompact(v);
const lots = (v, lot) => (num(v) === null || !lot ? "" : `${formatCompact(v / lot)} lots`);
const signInk = (v) => (num(v) === null || v === 0 ? null : v > 0 ? "pos" : "neg");

// ── Records: one chain → the rows every tab reads ──

/** Turn a hit's legs into "Buy 26400 CE @195.70 · Sell 2× 26450 CE @170.15". */
export const legsText = (legs) => (legs ?? []).map((l) => `${l.side === "BUY" ? "Buy" : "Sell"} ${l.qty > 1 ? `${formatInt(l.qty)}× ` : ""}${formatInt(l.strike)} ${l.right} @${formatFixed(l.price, 2)}`).join(" · ");
const ARB_TYPE = (kind) => (/vertical bound/i.test(kind) ? "Vertical bound" : /vertical/i.test(kind) ? "Vertical" : /butterfly/i.test(kind) ? "Butterfly" : /box \(buy\)/i.test(kind) ? "Buy box" : /box \(sell\)/i.test(kind) ? "Sell box" : /calendar/i.test(kind) ? "Calendar" : String(kind));
/** Arbitrage is checked down to this edge (points): the negative part is the near misses. */
export const ARB_MIN_EDGE = -2;

/**
 * Every record of one chain: contract legs (with wing and scores), the Overview row, hedge puts (0–20 % deep; the tab
 * narrows them) and arbitrage hits (near misses included). Null for an expired or empty chain.
 * @param {object} chain GET /v1/optionchain data
 * @param {{ now?: number, hv20?: number|null, charges?: object, wingStrikes?: number, fetchedAt?: number, monthly?: boolean, notional?: number|null }} o
 */
export function chainRecords(chain, { now = Date.now(), hv20 = null, charges = O.CHARGES, wingStrikes = 4, fetchedAt = now, monthly = false, notional = null } = {}) {
  if (!chain?.rows?.length) return null;
  const ctx = O.chainContext(chain, { now, hv20, charges });
  if (ctx.expired || ctx.T === null) return null;
  const { sm, lot, F, S } = ctx;
  const support = sm.support?.strike ?? null;
  const resistance = sm.resistance?.strike ?? null;
  const tag = monthly ? "M" : "W";
  const legs = [];
  for (const row of ctx.rows) {
    for (const side of ["ce", "pe"]) {
      const rec = O.legMetrics(row[side], row, side, ctx);
      if (!rec) continue;
      rec.name = contractName(rec);
      rec.sub = `${daysLabel(rec.days)} · lot ${formatInt(lot)}${monthly ? " · M" : ""}`;
      rec.monthly = monthly;
      rec.fetchedAt = fetchedAt;
      rec.support = support;
      rec.resistance = resistance;
      rec.em = ctx.em;
      rec.atmIv = ctx.atmIv;
      rec.hv20 = ctx.hv20;
      rec.exchange = ctx.exchange;
      rec.wing = rec.otm ? O.wingFor(rec, chain, wingStrikes) : null;
      rec.sell = O.sellScore(rec);
      rec.buy = O.buyScore(rec);
      rec.scoreSell = rec.sell?.score ?? null;
      rec.scoreBuy = rec.buy?.score ?? null;
      rec.reading = O.buildupReading(rec.tag, rec.right);
      rec.premLot = rec.sellPrice === null ? null : rec.sellPrice * lot;
      rec.capital = rec.buyPrice === null ? null : rec.buyPrice * lot;
      rec.costsPct = rec.capital ? (rec.costsRt.total / rec.capital) * 100 : null;
      rec.richLot = rec.fair === null ? null : (rec.mid - rec.fair) * lot;
      rec.beMovePct = rec.beLong !== null && S ? ((rec.beLong - S) / S) * 100 : null;
      rec.oiLots = rec.oi === null ? null : rec.oi / lot;
      rec.volLots = rec.volume === null ? null : rec.volume / lot;
      legs.push(rec);
    }
  }
  const skew = O.skew25(ctx.rows);
  const targets = O.deltaTargets(ctx.rows);
  const at16 = (m) => [...m].find(([, v]) => v === "16Δ")?.[0] ?? null;
  const build = O.dominantBuildup(chain);
  const days = ctx.days;
  const overview = {
    kind: "underlying",
    key: `${ctx.underlying}|${ctx.expiry}`,
    underlying: ctx.underlying,
    expiry: ctx.expiry,
    name: chainName(ctx.underlying, ctx.expiry),
    sub: `${tag} ${daysLabel(days)}`,
    days,
    monthly,
    lot,
    S,
    F,
    T: ctx.T,
    atmIv: ctx.atmIv,
    atmStrike: sm.atm,
    hv20: ctx.hv20,
    ivHvRatio: ctx.atmIv !== null && ctx.hv20 > 0 ? ctx.atmIv / ctx.hv20 : null,
    skew: skew?.rr ?? null,
    skewInfo: skew,
    straddle: sm.straddle,
    straddleLot: sm.straddle === null ? null : sm.straddle * lot,
    straddlePct: sm.straddle !== null && S ? (sm.straddle / S) * 100 : null,
    em: ctx.em,
    emPct: ctx.em !== null && F ? (ctx.em / F) * 100 : null,
    pcr: sm.pcr,
    pcrChange: sm.pcrChange,
    maxPain: sm.maxPain,
    mpDiff: sm.maxPain !== null && S !== null ? sm.maxPain - S : null,
    support,
    resistance,
    build,
    oiMissing: !legs.some((l) => l.oiChange !== null),
    basis: F !== null && S !== null ? F - S : null,
    carry: F > 0 && S > 0 && ctx.T > 0 ? (Math.log(F / S) / ctx.T) * 100 : null,
    strangle: { ce: at16(targets.ce), pe: at16(targets.pe) },
    fetchedAt,
    term: null,
    termInfo: null,
    verdict: null,
  };
  const hedges = O.hedgeRows(chain, ctx, { minDepth: 0, maxDepth: 20, notional }).map((r) => ({
    ...r,
    name: `${chainName(r.underlying, r.expiry)} ${formatInt(r.strike)} PE`,
    sub: `${daysLabel(r.days)} · lot ${formatInt(lot)}${monthly ? " · M" : ""}`,
    chain: chainName(r.underlying, r.expiry),
    monthly,
    fetchedAt,
    atmIv: ctx.atmIv,
    F,
    S,
  }));
  const df = Math.exp(-O.RATE * ctx.T);
  const hits = O.arbChecks(chain, { df, minEdge: ARB_MIN_EDGE, span: 20 });
  const arbs = hits.map((hit) => {
    const gross = hit.edge;
    const grossLot = gross === null ? null : gross * lot;
    const costs = O.arbCosts(hit, lot, ctx.exchange, charges);
    const net = grossLot === null ? null : grossLot - costs.total;
    const type = ARB_TYPE(hit.kind);
    const outlay = hit.legs.reduce((a, l) => a + (l.side === "BUY" ? 1 : -1) * l.price * (l.qty ?? 1), 0);
    return {
      kind: "arb",
      key: `${ctx.underlying}|${ctx.expiry}|${hit.kind}|${hit.legs.map((l) => `${l.side[0]}${l.strike}${l.right}`).join(",")}`,
      type,
      name: type,
      sub: chainName(ctx.underlying, ctx.expiry),
      chain: chainName(ctx.underlying, ctx.expiry),
      underlying: ctx.underlying,
      expiry: ctx.expiry,
      lot,
      days,
      legs: hit.legs,
      /** Built when shown: formatting every near miss of every chain would cost more than the maths. */
      get legsText() {
        return (this._lt ??= legsText(this.legs));
      },
      minLeg: hit.legs.length ? Math.min(...hit.legs.map((l) => l.price)) : null,
      gross,
      grossLot,
      costs,
      costsTotal: costs.total,
      net,
      capital: type === "Buy box" ? outlay * lot : null,
      status: net !== null && net > 0 ? "Executable" : "Near miss",
      strike: hit.legs[0]?.strike ?? null,
      right: hit.legs[0]?.right ?? null,
      fetchedAt,
    };
  });
  return { ctx, legs, overview, hedges, arbs, arbStrikes: hits.strikes ?? 0, oiMissing: overview.oiMissing };
}

/**
 * Join the chains of one sweep: the Overview term (vs the next scanned expiry of the same underlying), the straddle
 * verdict (HV, else peers), the daily-baseline change, and calendar rows where total variance falls.
 * @param {ReturnType<typeof chainRecords>[]} parts
 * @param {{ base?: Record<string, { atmIv: number|null, at: number }> }} o
 */
export function finishScan(parts, { base = {} } = {}) {
  const ok = (parts ?? []).filter(Boolean);
  const overview = ok.map((p) => ({ ...p.overview }));
  const byU = new Map();
  for (const o of overview) byU.set(o.underlying, [...(byU.get(o.underlying) ?? []), o]);
  const calendars = [];
  for (const list of byU.values()) {
    list.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (!b) continue;
      a.term = a.atmIv !== null && b.atmIv !== null ? a.atmIv - b.atmIv : null;
      const fv = O.forwardVol({ atmIv: a.atmIv, years: a.T }, { atmIv: b.atmIv, years: b.T });
      a.termInfo = { next: b.expiry, ...fv };
      if (fv.inverted && a.days >= 1) {
        calendars.push({
          kind: "arb",
          key: `${a.underlying}|${a.expiry}|cal|${b.expiry}`,
          type: "Calendar",
          name: "Calendar",
          sub: chainName(a.underlying, a.expiry),
          chain: `${chainName(a.underlying, a.expiry)} → ${expiryText(b.expiry)}`,
          underlying: a.underlying,
          expiry: a.expiry,
          lot: a.lot,
          days: a.days,
          legs: [],
          legsText: `ATM IV ${f1(a.atmIv)} → ${f1(b.atmIv)}: total variance falls to ${expiryText(b.expiry)}`,
          gross: null,
          grossLot: null,
          costs: null,
          costsTotal: null,
          net: null,
          capital: null,
          status: "Check",
          strike: a.atmStrike,
          right: null,
          fetchedAt: Math.min(a.fetchedAt, b.fetchedAt),
        });
      }
    }
  }
  for (const o of overview) {
    o.verdict = O.straddleVerdict({ days: o.days, atmIv: o.atmIv, hv20: o.hv20, straddle: o.straddle, S: o.S }, overview.map((p) => ({ days: p.days, straddle: p.straddle, S: p.S })));
    const b = base?.[o.key];
    o.ivChg = b && num(b.atmIv) !== null && o.atmIv !== null ? o.atmIv - b.atmIv : null;
    o.baseAt = b?.at ?? null;
  }
  return {
    overview,
    legs: ok.flatMap((p) => p.legs),
    hedges: ok.flatMap((p) => p.hedges),
    arbs: [...ok.flatMap((p) => p.arbs), ...calendars],
    oiMissing: ok.filter((p) => p.oiMissing).map((p) => p.overview.key),
    strikes: ok.reduce((a, p) => a + (p.arbStrikes ?? 0), 0),
    chains: ok.length,
  };
}

/** The verdict as text: "Rich ×1.24", "Cheap vs peers", "Expiry day", "--". */
export function verdictText(v) {
  if (!v?.label) return DASH;
  if (v.basis === "hv" && num(v.ratio) !== null) return `${v.label} ×${formatFixed(v.ratio, 2)}`;
  return v.label;
}

// ── Filters ──

/**
 * Every filter the presets use. `type`: "range" ([lo, hi]), "min" / "max" (a number), "toggle" (boolean), "seg" (an
 * option id) or "multi" (an array, null = all). A filter is "off" at [null, null], null, false, the first seg option
 * or null; `step` widens it one notch when relaxed.
 */
export const FILTERS = Object.freeze({
  expiries: { label: "Expiries", type: "multi", get: (r) => r.expiry, dynamic: "expiries" },
  days: { label: "Days to expiry", short: "Days", type: "range", get: (r) => r.days, step: 1, dp: 0, unit: "d" },
  side: { label: "Side", type: "seg", options: [["both", "Both"], ["CE", "CE"], ["PE", "PE"]], test: (r, v) => v === "both" || r.right === v },
  liq: { label: "Min liquidity", short: "Liq", type: "min", get: (r) => r.liq, step: 1, dp: 0, min: 1, max: 5, unit: "/5" },
  spread: { label: "Max spread", short: "Spread", type: "max", get: (r) => r.spread, step: 2, dp: 0, unit: "%" },
  oiLots: { label: "Min OI", short: "OI", type: "min", get: (r) => r.oiLots, step: 50, dp: 0, unit: " lots" },
  volLots: { label: "Min volume", short: "Volume", type: "min", get: (r) => r.volLots, step: 10, dp: 0, unit: " lots" },
  twoSided: { label: "Two-sided quotes only", short: "Two-sided", type: "toggle", test: (r, v) => !v || r.priceQ === "mid" },
  volOiRel: { label: "Min × median", short: "× median", type: "min", get: (r) => r.volOiRel, step: 1, dp: 1, unit: "×" },
  turnover: { label: "Min turnover", short: "Turnover", type: "min", get: (r) => r.turnover, step: 500000, unit: "₹" },
  midMin: { label: "Min mid", short: "Mid", type: "min", get: (r) => r.mid, step: 0.5, dp: 2, unit: "₹" },
  fresh: { label: "Include fresh strikes (OI 0)", short: "Fresh strikes", type: "toggle", test: (r, v) => v || r.oi > 0 },
  oiChgLots: { label: "Min |OI chg|", short: "|OI chg|", type: "min", get: (r) => (r.oiChangeLots === null ? null : Math.abs(r.oiChangeLots)), step: 25, dp: 0, unit: " lots" },
  tags: { label: "Build-up", type: "multi", options: [["LB", "Long build-up"], ["SB", "Short build-up"], ["SC", "Short covering"], ["LU", "Long unwinding"]], get: (r) => r.tag },
  committed: { label: "Min ₹ committed", short: "₹ committed", type: "min", get: (r) => r.committed, step: 1000000, unit: "₹" },
  otm: { label: "OTM only", short: "OTM", type: "toggle", test: (r, v) => !v || r.otm },
  absDelta: { label: "|Δ| band", short: "Δ", type: "range", get: (r) => r.absDelta, step: 0.05, dp: 2 },
  premLot: { label: "Min premium ₹/lot", short: "Premium", type: "min", get: (r) => r.premLot, step: 100, unit: "₹" },
  pop: { label: "Min POP", short: "POP", type: "min", get: (r) => (r.popShort === null ? null : r.popShort * 100), step: 5, dp: 0, unit: "%" },
  noExpiryDay: { label: "Exclude expiry day", short: "No expiry day", type: "toggle", test: (r, v) => !v || (r.days ?? 0) >= 1 },
  thetaPct: { label: "Max θ %/day", short: "θ", type: "max", get: (r) => r.thetaPct, step: 2, dp: 0, unit: "%/day" },
  capital: { label: "Max capital ₹/lot", short: "Capital", type: "max", get: (r) => r.capital, step: 5000, unit: "₹" },
  bump: { label: "Min |bump|", short: "|Bump|", type: "min", get: (r) => (r.bump === null ? null : Math.abs(r.bump)), step: 0.5, dp: 1, unit: " pts" },
  direction: { label: "Direction", type: "seg", options: [["both", "Both"], ["rich", "Rich"], ["cheap", "Cheap"]], test: (r, v) => v === "both" || (v === "rich" ? r.bump > 0 : r.bump < 0) },
  depth: { label: "Depth below F", short: "Depth", type: "range", get: (r) => r.depth, step: 1, dp: 0, unit: "%" },
  best: { label: "Best per expiry", short: "Best per expiry", type: "toggle", apply: (rows, v) => (v ? O.bestHedges(rows) : rows) },
  minLeg: { label: "Min leg price", short: "Min leg", type: "min", get: (r) => r.minLeg, test: (r, v) => v === null || r.type === "Calendar" || (r.minLeg !== null && r.minLeg >= v - 1e-9), step: 0.5, dp: 2, unit: "₹" },
  nearMiss: { label: "Show near misses (net ≥ −₹500/lot)", short: "Near misses", type: "toggle", test: (r, v) => r.net === null || r.net > 0 || (v && r.net >= -500) },
});
const offValue = (f) => (f.type === "range" ? [null, null] : f.type === "toggle" ? false : f.type === "seg" ? f.options[0][0] : null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** True when a filter does something at value `v`. */
export const filterActive = (id, v) => !same(v, offValue(FILTERS[id]));
const unitText = (f, v) => {
  if (num(v) === null) return DASH;
  if (f.unit === "₹") return Math.abs(v) >= 1e5 ? `₹${formatCompact(v)}` : formatRupee(v, Number.isInteger(v) ? 0 : 2);
  return `${formatFixed(v, f.dp ?? 0)}${f.unit && f.unit !== "₹" ? (f.unit === "d" ? "d" : f.unit) : ""}`;
};
/** A filter's chip text: "Δ 0.10–0.30", "Spread ≤ 3%", "POP ≥ 65%", "Two-sided". */
export function filterText(id, v, ctx = {}) {
  const f = FILTERS[id];
  const label = f.short ?? f.label;
  if (f.type === "range") {
    const [lo, hi] = v ?? [null, null];
    if (lo !== null && hi !== null) return `${label} ${unitText({ ...f, unit: "" }, lo)}–${unitText(f, hi)}`;
    return lo !== null ? `${label} ≥ ${unitText(f, lo)}` : hi !== null ? `${label} ≤ ${unitText(f, hi)}` : label;
  }
  if (f.type === "min") return `${label} ≥ ${unitText(f, v)}`;
  if (f.type === "max") return `${label} ≤ ${unitText(f, v)}`;
  if (f.type === "toggle") return label;
  if (f.type === "seg") return `${label}: ${f.options.find((o) => o[0] === v)?.[1] ?? v}`;
  const opts = f.options ?? (ctx.expiries ?? []).map((e) => [e, expiryText(e)]);
  return `${label}: ${(v ?? []).map((x) => opts.find((o) => o[0] === x)?.[1] ?? x).join(", ")}`;
}
/** One notch looser: back to the default when changed, else a step wider (a toggle goes off, a multi to all). */
export function relaxValue(id, value, def) {
  const f = FILTERS[id];
  if (!same(value, def)) return structuredClone(def ?? offValue(f));
  if (f.type === "min") return value === null ? null : value - f.step > (f.min ?? 0) - 1e-9 && value - f.step > 1e-9 ? round(value - f.step) : null;
  if (f.type === "max") return value === null ? null : round(value + f.step);
  if (f.type === "range") {
    const [lo, hi] = value ?? [null, null];
    return [lo === null || lo - f.step <= 1e-9 ? null : round(lo - f.step), hi === null ? null : round(hi + f.step)];
  }
  return offValue(f);
}
const round = (v) => Math.round(v * 1e6) / 1e6;
function passes(f, r, v) {
  if (f.test) return f.test(r, v);
  const x = num(f.get(r));
  if (f.type === "min") return v === null || (x !== null && x >= v - 1e-9);
  if (f.type === "max") return v === null || (x !== null && x <= v + 1e-9);
  if (f.type === "range") {
    const [lo, hi] = v ?? [null, null];
    if (lo === null && hi === null) return true;
    return x !== null && (lo === null || x >= lo - 1e-9) && (hi === null || x <= hi + 1e-9);
  }
  if (f.type === "multi") return v === null || v.includes(f.get(r));
  return true;
}

// ── Presets ──

const COMMON = ["expiries", "days", "side", "liq", "spread", "oiLots", "volLots", "twoSided"];
const col = (id, label, p, get, fmt, extra = {}) => ({ id, label, p, num: true, sortable: true, dir: "desc", title: "", get, fmt, ...extra });
const lead = (label = "Contract", title = "Underlying, expiry, strike and right. Sub line: time to expiry, lot size, M for a monthly") => ({ id: "name", label, p: 1, num: false, sortable: true, dir: "asc", lead: true, title, get: (r) => r.name, fmt: (v) => v ?? DASH, sub: (r) => r.sub });
const age = () => col("age", "Age", 2, (r) => r.age ?? null, (v) => ageText(v), { dir: "asc", title: "How long ago this chain was fetched", ink: (r) => (r.stale ? "warn" : null) });

/**
 * The eight tabs. Each column: { id, label, p (priority: 3 hides below 1100 px), num, sortable, dir (first-click
 * direction), title (its formula), get(rec), fmt(value, rec), sub?(rec), ink?(rec), sortGet?(rec), heat? }.
 */
export const PRESETS = Object.freeze([
  {
    id: "overview",
    label: "Overview",
    short: "Overview",
    kind: "underlying",
    description: "One row per underlying and expiry: implied vs realised vol, skew, the priced move and where OI sits.",
    columns: [
      lead("Underlying · expiry", "W weekly, M monthly; time to expiry"),
      col("atmIv", "ATM IV", 1, (r) => r.atmIv, f1, { title: "Average IV of the ATM call and put (as on the Chain page). Sub: change since the day's first scan", sub: (r) => (r.ivChg === null || r.ivChg === undefined || r.baseAt === r.fetchedAt ? "" : `Δ ${formatSigned(r.ivChg, 1)} since ${istHm(r.baseAt)}`) }),
      col("hv20", "HV20", 2, (r) => r.hv20, f1, { title: "20-day realised vol of the index from daily closes (annualised, √252)" }),
      col("ivHvRatio", "IV/HV", 1, (r) => r.ivHvRatio, times, { title: "ATM IV ÷ HV20. Above 1 the options price more movement than the index has shown", heat: true }),
      col("skew", "Skew 25Δ", 2, (r) => r.skew, pts, { title: "IV of the put nearest Δ −0.25 minus the call nearest Δ +0.25. Positive: puts richer" }),
      col("term", "Term", 3, (r) => r.term, pts, { title: "ATM IV minus the next scanned expiry's ATM IV", ttl: (r) => (r.termInfo ? (r.termInfo.inverted ? "Inverted: total variance falls" : r.termInfo.vol !== null ? `Forward vol to ${expiryText(r.termInfo.next)}: ${f1(r.termInfo.vol)}` : "") : "") }),
      col("straddle", "Straddle", 1, (r) => r.straddle, f2, { title: "ATM call + put last price, as on the Chain page. Sub: ₹ per lot", sub: (r) => (r.straddleLot === null ? "" : `${rupee(r.straddleLot)}/lot`) }),
      col("straddlePct", "Straddle %", 2, (r) => r.straddlePct, (v) => formatPercent(v, 2), { title: "Straddle ÷ spot × 100" }),
      col("em", "±1σ move", 1, (r) => r.em, (v) => formatFixed(v, 0), { title: "±1σ = F·(e^{σ√T} − e^{−σ√T})/2 ≈ F·σ·√T at ATM IV. Sub: as % of F", sub: (r) => (r.emPct === null ? "" : formatPercent(r.emPct, 2)) }),
      col("verdict", "Verdict", 1, (r) => r.verdict?.ratio ?? null, (v, r) => verdictText(r.verdict), { cardFmt: (v, r) => r.verdict?.label ?? DASH, title: "ATM IV ÷ HV20: ≥ 1.20 rich, ≤ 0.90 cheap. Without HV: straddle % ÷ √days against the other chains. An ATM straddle ≈ 0.8 × 1σ, so the straddle alone is not a verdict; it is judged against realised vol", text: true }),
      col("pcr", "PCR", 2, (r) => r.pcr, f2, { title: "Put OI ÷ call OI over the fetched strikes. Sub: put OI added ÷ call OI added today", sub: (r) => (r.pcrChange === null ? "" : `Δ ${f2(r.pcrChange)}`) }),
      col("maxPain", "Max pain", 3, (r) => r.maxPain, formatInt, { title: "The expiry price where option buyers collect the least. Sub: vs spot", sub: (r) => (r.mpDiff === null ? "" : formatSigned(r.mpDiff, 0)) }),
      col("walls", "Walls", 2, (r) => r.support, (v, r) => (r.support === null && r.resistance === null ? DASH : `${formatInt(r.support)} / ${formatInt(r.resistance)}`), { title: "Put wall (most put OI) / call wall (most call OI)", sortable: false, text: true }),
      col("build", "Build-up", 3, (r) => r.build?.rupees ?? null, (v, r) => (r.build ? r.build.action : DASH), { title: "The build-up with the most money behind it: Σ |OI change| × mid by tag and side", text: true, ttl: (r) => (r.oiMissing ? "OI change unavailable from this broker" : r.build?.text ?? "") }),
      col("basis", "Basis", 3, (r) => r.basis, (v) => formatSigned(v, 1), { title: "Forward from put-call parity minus spot. Sub: implied carry, % a year", sub: (r) => (r.carry === null ? "" : `${formatFixed(r.carry, 1)}%/yr`) }),
      age(),
    ],
    filters: ["expiries", "days"],
    defaults: { filters: {}, sort: { by: "ivHvRatio", dir: "desc" } },
    card: { badge: "verdict", keys: ["atmIv", "ivHvRatio", "em"] },
  },
  {
    id: "unusual",
    label: "Unusual volume",
    short: "Unusual",
    kind: "contract",
    description: "Contracts trading far more than their chain's normal turnover: Vol/OI against the median of the same side.",
    columns: [
      lead(),
      col("ltp", "LTP", 1, (r) => r.ltp, f2, { title: "Last traded price. Sub: change since the previous close", sub: (r) => (r.changePct === null ? "" : `${formatSigned(r.changePct, 1)}%`), subInk: (r) => signInk(r.changePct) }),
      col("volume", "Volume", 1, (r) => r.volume, compact, { title: "Contracts traded today (units). Sub: in lots", sub: (r) => lots(r.volume, r.lot) }),
      col("oi", "OI", 2, (r) => r.oi, compact, { title: "Open interest (units)" }),
      col("volOi", "Vol/OI", 2, (r) => r.volOi, times, { title: "Volume ÷ open interest", ttl: (r) => (r.oi === 0 ? "Fresh strike: no open interest yet" : "") }),
      col("volOiRel", "× median", 1, (r) => r.volOiRel, times, { title: "(Vol/OI) ÷ the median Vol/OI of the same side of the same chain (legs with volume and OI; needs 5)", heat: true }),
      col("turnover", "Turnover", 1, (r) => r.turnover, bigRupee, { title: "Volume × mid" }),
      col("oiChgPct", "OI chg %", 2, (r) => r.oiChgPct, (v) => (num(v) === null ? DASH : `${formatSigned(v, 1)}%`), { title: "OI change ÷ previous OI (only when the previous OI is at least 100 lots)" }),
      col("build", "Build-up", 2, (r) => r.tag, (v, r) => (r.reading ? r.reading.action : DASH), { title: "Price and OI change read from the writer's side", sortable: false, text: true, cardFmt: (v, r) => (r.reading ? r.reading.action.replace("short covering", "covering") : DASH) }),
      col("iv", "IV", 3, (r) => r.iv, f1, { title: "The leg's implied volatility (broker / server)" }),
      col("delta", "Δ", 3, (r) => r.delta, f2, { title: "Delta" }),
    ],
    filters: [...COMMON, "volOiRel", "volLots", "turnover", "midMin", "fresh"].filter((v, i, a) => a.indexOf(v) === i),
    defaults: { filters: { volOiRel: 3, volLots: 20, turnover: 1000000, midMin: 1, fresh: false }, sort: { by: "volOiRel", dir: "desc" } },
    card: { badge: "volOiRel", keys: ["turnover", "volume", "build"] },
  },
  {
    id: "buildup",
    label: "OI build-up",
    short: "Build-up",
    kind: "contract",
    description: "Where money moved into or out of open interest today, read from the writer's side.",
    columns: [
      lead(),
      col("changePct", "Price chg %", 1, (r) => r.changePct, (v) => (num(v) === null ? DASH : `${formatSigned(v, 1)}%`), { title: "Change since the previous close", ink: (r) => signInk(r.changePct) }),
      col("oi", "OI", 2, (r) => r.oi, compact, { title: "Open interest (units)" }),
      col("oiChange", "OI chg", 1, (r) => r.oiChange, (v) => formatCompact(v, { signed: true }), { title: "OI change today (units). Sub: in lots", sub: (r) => (r.oiChangeLots === null ? "" : `${formatCompact(r.oiChangeLots, { signed: true })} lots`), sortGet: (r) => (r.oiChange === null ? null : Math.abs(r.oiChange)) }),
      col("oiChgPct", "OI chg %", 2, (r) => r.oiChgPct, (v) => (num(v) === null ? DASH : `${formatSigned(v, 1)}%`), { title: "OI change ÷ previous OI, only when the previous OI is at least 100 lots", ttl: (r) => (r.oiChgPct === null && r.oiChange !== null ? "Prior OI too small" : "") }),
      col("committed", "₹ committed", 1, (r) => r.committed, bigRupee, { title: "|OI change| × mid", heat: true }),
      col("tag", "Tag", 1, (r) => r.tag, (v) => (v ? O.BUILDUP_NAMES[v] : DASH), { title: "LB price ↑ OI ↑ · SB price ↓ OI ↑ · SC price ↑ OI ↓ · LU price ↓ OI ↓", sortable: false, text: true }),
      col("reading", "Reading", 1, (r) => r.reading?.text ?? null, (v) => v ?? DASH, { title: "What the build-up says, from the writer's side", sortable: false, text: true }),
      col("volume", "Volume", 3, (r) => r.volume, compact, { title: "Contracts traded today (units)" }),
      col("iv", "IV", 3, (r) => r.iv, f1, { title: "The leg's implied volatility" }),
    ],
    filters: [...COMMON, "oiChgLots", "tags", "committed"],
    defaults: { filters: { oiChgLots: 50, tags: ["LB", "SB", "SC", "LU"], committed: 2500000 }, sort: { by: "committed", dir: "desc" } },
    card: { badge: "tag", keys: ["oiChange", "committed", "reading"] },
  },
  {
    id: "sell",
    label: "Sell premium",
    short: "Sell",
    kind: "contract",
    description: "Short OTM options ranked by richness over realised vol, chance of profit, decay and liquidity.",
    columns: [
      lead(),
      col("bid", "Bid", 1, (r) => r.sellPrice, f2, { title: "The price you sell at (the last price when there is no bid, flagged LTP)", sub: (r) => (r.bid === null ? "LTP" : "") }),
      col("absDelta", "Δ", 1, (r) => r.absDelta, f2, { title: "|delta|", dir: "asc" }),
      col("popShort", "POP", 1, (r) => r.popShort, pop, { title: "Chance the short keeps a profit at expiry: P(price stays beyond strike ± bid), log-normal on the forward at the leg's IV" }),
      col("sigmaOtm", "σ OTM", 1, (r) => r.sigmaOtm, sigma, { title: "ln(K/F) (calls) or ln(F/K) (puts) ÷ (ATM IV·√T). Below 1: inside the expected move" }),
      col("premLot", "₹/lot", 1, (r) => r.premLot, rupee, { title: "Bid × lot: premium collected per lot" }),
      col("thetaLot", "θ ₹/day", 2, (r) => r.thetaLot, rupee, { title: "|θ| × lot: decay earned per day per lot" }),
      col("thetaPct", "θ %/day", 3, (r) => r.thetaPct, (v) => formatPercent(v, 1), { title: "|θ| ÷ mid × 100 (blank under ₹0.50)" }),
      col("ivHv", "IV − HV", 2, (r) => r.ivHv, pts, { title: "Leg IV minus HV20, vol points" }),
      col("wing", "Max loss (wing)", 3, (r) => r.wing?.maxLoss ?? null, (v, r) => (r.wing ? `${rupee(r.wing.maxLoss)} · R:R 1:${formatFixed(r.wing.rr, 1)}` : DASH), { title: "Buy the strike 4 steps further out: max loss per lot = (width − credit) × lot; R:R = max loss ÷ credit", dir: "asc" }),
      col("liq", "Liq", 2, (r) => r.liq, (v) => (num(v) === null ? DASH : `${formatInt(v)}/5`), { title: "Liquidity 1–5 from the spread and the volume rank" }),
      col("costs", "Costs", 3, (r) => r.costsRt?.total ?? null, rupee, { title: "Round-trip charges per lot at mid (estimate): brokerage, STT, exchange, SEBI, stamp, GST", dir: "asc" }),
      col("scoreSell", "Score", 1, (r) => r.scoreSell, formatInt, { title: "Richness 35% (IV − HV −2→+6 pts) · Safety 25% (POP 60→90%) · Decay 20% (θ 0→15%/day) · Liquidity 20%. Halved inside 1σ or on expiry day", heat: true }),
    ],
    filters: [...COMMON, "otm", "absDelta", "premLot", "pop", "noExpiryDay"],
    defaults: { filters: { otm: true, absDelta: [0.1, 0.3], spread: 3, liq: 3, premLot: 300, pop: 65, noExpiryDay: true }, sort: { by: "scoreSell", dir: "desc" } },
    card: { badge: "scoreSell", keys: ["popShort", "sigmaOtm", "premLot"] },
  },
  {
    id: "buy",
    label: "Buy options",
    short: "Buy",
    kind: "contract",
    description: "Options with the most reach per rupee: breakeven within the priced move, slow decay, IV not overpaid.",
    columns: [
      lead(),
      col("ask", "Ask", 1, (r) => r.buyPrice, f2, { title: "The price you buy at (the last price when there is no ask, flagged LTP)", sub: (r) => (r.ask === null ? "LTP" : "") }),
      col("absDelta", "Δ", 1, (r) => r.absDelta, f2, { title: "|delta|" }),
      col("capital", "Capital", 1, (r) => r.capital, rupee, { title: "Ask × lot: premium paid per lot (the most you can lose)", dir: "asc" }),
      col("be", "Breakeven", 2, (r) => r.beLong, formatInt, { title: "Strike ± ask at expiry. Sub: distance from spot", sub: (r) => (r.beMovePct === null ? "" : `${formatSigned(r.beMovePct, 2)}%`), dir: "asc" }),
      col("beSigma", "BE σ", 1, (r) => r.beSigma, sigma, { title: "|ln(breakeven ÷ F)| ÷ (ATM IV·√T): how many σ the index must move", dir: "asc" }),
      col("popLong", "POP", 2, (r) => r.popLong, pop, { title: "Chance the long finishes beyond its breakeven" }),
      col("thetaPct", "θ %/day", 1, (r) => r.thetaPct, (v) => formatPercent(v, 1), { title: "|θ| ÷ mid × 100: premium lost per day", dir: "asc" }),
      col("vegaPct", "Vega %", 3, (r) => r.vegaPct, (v) => formatPercent(v, 1), { title: "Vega ÷ ask: premium change per +1 vol point" }),
      col("leverage", "Leverage", 3, (r) => r.leverage, (v) => (num(v) === null ? DASH : `${formatFixed(v, 1)}×`), { title: "|Δ| × spot ÷ ask" }),
      col("ivHv", "IV − HV", 2, (r) => r.ivHv, pts, { title: "Leg IV minus HV20, vol points", dir: "asc" }),
      col("liq", "Liq", 2, (r) => r.liq, (v) => (num(v) === null ? DASH : `${formatInt(v)}/5`), { title: "Liquidity 1–5" }),
      col("costsPct", "Costs %", 3, (r) => r.costsPct, (v) => formatPercent(v, 2), { title: "Round-trip charges ÷ (ask × lot)", dir: "asc" }),
      col("scoreBuy", "Score", 1, (r) => r.scoreBuy, formatInt, { title: "Cheapness 30% (IV − HV +2→−6 pts) · Reach 30% (BE 1.5σ→0.5σ) · Decay 20% (θ 10→0%/day) · Liquidity 20%. Halved for POP < 10% or on expiry day", heat: true }),
    ],
    filters: [...COMMON, "absDelta", "thetaPct", "capital"],
    defaults: { filters: { absDelta: [0.25, 0.6], spread: 3, liq: 3, days: [2, null], thetaPct: 10 }, sort: { by: "scoreBuy", dir: "desc" } },
    card: { badge: "scoreBuy", keys: ["capital", "beSigma", "thetaPct"] },
  },
  {
    id: "ivout",
    label: "IV outliers",
    short: "IV outliers",
    kind: "contract",
    description: "Strikes priced off their own smile: IV against the median of the neighbouring strikes on the same side.",
    columns: [
      lead(),
      col("iv", "IV", 1, (r) => r.iv, f1, { title: "The leg's implied volatility" }),
      col("nbrIv", "Neighbours", 2, (r) => r.nbrIv, f1, { title: "Median IV of the 2 nearest strikes each side (same side, IV > 0)" }),
      col("bump", "Bump", 1, (r) => r.bump, pts, { title: "IV − neighbours. Sorted by size", sortGet: (r) => (r.bump === null ? null : Math.abs(r.bump)), heat: true }),
      col("vsAtm", "vs ATM", 2, (r) => r.vsAtm, pts, { title: "IV − ATM IV" }),
      col("mid", "Mid", 1, (r) => r.mid, f2, { title: "Mid of bid and ask" }),
      col("fair", "Fair", 2, (r) => r.fair, f2, { title: "Black-76 at the neighbours' IV on the forward" }),
      col("richLot", "Rich ₹/lot", 1, (r) => r.richLot, (v) => (num(v) === null ? DASH : `${v > 0 ? "+" : ""}${rupee(v)}`), { title: "(mid − fair) × lot. Positive: priced above its neighbours" }),
      col("spread", "Spread %", 2, (r) => r.spread, (v) => formatPercent(v, 1), { title: "(ask − bid) ÷ mid", dir: "asc" }),
      col("liq", "Liq", 3, (r) => r.liq, (v) => (num(v) === null ? DASH : `${formatInt(v)}/5`), { title: "Liquidity 1–5" }),
    ],
    filters: [...COMMON, "bump", "direction"],
    defaults: { filters: { bump: 1, spread: 5, liq: 2, twoSided: true, direction: "both" }, sort: { by: "bump", dir: "desc" } },
    card: { badge: "bump", keys: ["richLot", "iv", "spread"] },
  },
  {
    id: "hedge",
    label: "Hedge",
    short: "Hedge",
    kind: "hedge",
    description: "Protective puts ranked by cost per year at the depth you choose, with the payout in a 2σ fall.",
    columns: [
      lead("Underlying · expiry", "The put's underlying and expiry"),
      col("strike", "Put", 1, (r) => r.strike, formatInt, { title: "Put strike", dir: "asc" }),
      col("depth", "Depth", 1, (r) => r.depth, (v) => formatPercent(v, 1), { title: "(F − K) ÷ F × 100", dir: "asc" }),
      col("ask", "Ask", 2, (r) => r.ask, f2, { title: "The price you buy at" }),
      col("costPct", "Cost %", 2, (r) => r.costPct, (v) => formatPercent(v, 2), { title: "Ask ÷ F × 100", dir: "asc" }),
      col("perLot", "₹/lot", 1, (r) => r.perLot, rupee, { title: "Ask × lot", dir: "asc" }),
      col("perDay", "₹/day", 2, (r) => r.perDay, rupee, { title: "Ask × lot ÷ days (at least ¼ day)", dir: "asc" }),
      col("annualised", "Annualised", 1, (r) => r.annualised, (v) => formatPercent(v, 1), { title: "Cost % × 365 ÷ days: the price of a year of this protection", dir: "asc", heat: true }),
      col("payout", "Payout @−2σ", 2, (r) => r.payout, (v) => (num(v) === null ? DASH : `${formatFixed(v, 1)}×`), { title: "max(0, K − F·e^(−2σ√T)) ÷ ask at ATM IV" }),
      col("skewPaid", "Skew paid", 3, (r) => r.skewPaid, pts, { title: "Put IV − ATM IV", dir: "asc" }),
      col("lots", "Lots", 2, (r) => r.lots, formatInt, { title: "Index notional only; scale by your portfolio beta. ceil(notional ÷ (F × lot)). Sub: total cost", sub: (r) => (r.total === null ? "" : rupee(r.total)) }),
      col("liq", "Liq", 3, (r) => r.liq, (v) => (num(v) === null ? DASH : `${formatInt(v)}/5`), { title: "Liquidity 1–5" }),
    ],
    filters: ["expiries", "days", "depth", "liq", "best"],
    defaults: { filters: { days: [1, null], depth: [2, 8], liq: 2, best: true }, sort: { by: "annualised", dir: "asc" } },
    card: { badge: "annualised", keys: ["depth", "perLot", "payout"] },
  },
  {
    id: "arb",
    label: "Arbitrage",
    short: "Arbitrage",
    kind: "arb",
    description: "Static arbitrage at bid and ask, net of charges, with near misses; calendar inversions to check.",
    columns: [
      { ...lead("Type", "Vertical, vertical bound, butterfly, box (buy or sell), or a calendar variance inversion"), get: (r) => r.type, sub: null },
      col("chain", "Underlying · expiry", 1, (r) => r.chain, (v) => v ?? DASH, { num: false, dir: "asc", text: true, title: "The chain the legs come from" }),
      col("legs", "Legs", 1, (r) => r.legsText, (v) => v || DASH, { num: false, sortable: false, wrap: true, text: true, title: "Executable prices: asks to buy, bids to sell" }),
      col("net", "Net ₹/lot", 1, (r) => r.net, (v) => (num(v) === null ? DASH : `${v > 0 ? "+" : ""}${formatRupee(v, 0)}`), { title: "Gross ₹ − costs. Positive: executable after charges", ink: (r) => signInk(r.net), heat: true }),
      col("status", "Status", 1, (r) => r.status, (v) => v ?? DASH, { num: false, dir: "asc", text: true, title: "Executable (net > 0), near miss, or Check (a model-based calendar inversion)" }),
      col("gross", "Gross", 2, (r) => r.gross, (v) => (num(v) === null ? DASH : `${formatSigned(v, 2)} pts`), { title: "Edge per unit at bid/ask before charges" }),
      col("grossLot", "Gross ₹/lot", 2, (r) => r.grossLot, (v) => (num(v) === null ? DASH : formatRupee(v, 0)), { title: "Gross × lot" }),
      col("costsTotal", "Costs ₹", 2, (r) => r.costsTotal, rupee, { title: "Opening charges for one lot of every leg (estimate); boxes add settlement STT on the width", dir: "asc" }),
      col("capital", "Capital", 3, (r) => r.capital, rupee, { title: "A bought box: net debit × lot. Others: margin depends on the broker" }),
      age(),
    ],
    filters: ["expiries", "minLeg", "nearMiss"],
    defaults: { filters: { minLeg: 1, nearMiss: true }, sort: { by: "net", dir: "desc" } },
    card: { badge: "status", keys: ["net", "gross", "age"] },
  },
]);
export const PRESET_IDS = Object.freeze(PRESETS.map((p) => p.id));
export const presetById = (id) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];
/** The default value of one filter in a preset. */
export const filterDefault = (preset, id) => structuredClone(preset.defaults.filters[id] ?? offValue(FILTERS[id]));
/** Every filter value of a preset at its default. */
export const defaultFilters = (preset) => Object.fromEntries(preset.filters.map((id) => [id, filterDefault(preset, id)]));

/** The records a preset reads from a finished scan. */
export function recordsFor(scan, preset) {
  if (!scan) return [];
  return preset.kind === "underlying" ? scan.overview : preset.kind === "hedge" ? scan.hedges : preset.kind === "arb" ? scan.arbs : scan.legs;
}

/**
 * Filter (in the preset's fixed order, counting what each step removes), then sort (stable; ties by the lead text;
 * missing values last either way). `limit` cuts the returned rows; `total` counts them all.
 * @returns {{ rows: object[], total: number, funnel: { filter: string, label: string, removed: number }[] }}
 */
export function runPreset(records, preset, filters = {}, sort = null, { limit = null, ctx = {} } = {}) {
  let rows = [...(records ?? [])];
  const funnel = [];
  for (const id of preset.filters) {
    const f = FILTERS[id];
    const v = filters?.[id] === undefined ? filterDefault(preset, id) : filters[id];
    const before = rows.length;
    rows = f.apply ? f.apply(rows, v) : rows.filter((r) => passes(f, r, v));
    funnel.push({ filter: id, label: filterActive(id, v) ? filterText(id, v, ctx) : f.label, removed: before - rows.length });
  }
  const s = sort ?? preset.defaults.sort;
  const c = preset.columns.find((x) => x.id === s?.by && x.sortable) ?? preset.columns.find((x) => x.id === preset.defaults.sort.by);
  const key = c.sortGet ?? c.get;
  const dir = s?.dir === "asc" ? 1 : s?.dir === "desc" ? -1 : c.dir === "asc" ? 1 : -1;
  const decorated = rows.map((r, i) => ({ r, i, k: key(r), t: String(r.name ?? "") }));
  decorated.sort((a, b) => {
    const an = a.k === null || a.k === undefined || (typeof a.k === "number" && !Number.isFinite(a.k));
    const bn = b.k === null || b.k === undefined || (typeof b.k === "number" && !Number.isFinite(b.k));
    if (an !== bn) return an ? 1 : -1;
    if (!an && a.k !== b.k) return (a.k < b.k ? -1 : 1) * dir;
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    return a.i - b.i;
  });
  const sorted = decorated.map((d) => d.r);
  return { rows: num(limit) !== null ? sorted.slice(0, limit) : sorted, total: sorted.length, funnel };
}

/** The empty-result help: the two filters that removed the most rows. */
export const topBlockers = (funnel, n = 2) => [...(funnel ?? [])].filter((f) => f.removed > 0).sort((a, b) => b.removed - a.removed).slice(0, n);

// ── Reasons ──

const MAX_REASON = 80;
const join = (parts) => {
  const use = parts.filter(Boolean).slice(0, 3);
  while (use.length > 1 && use.join(" · ").length > MAX_REASON) use.pop();
  const text = use.join(" · ");
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
};
const has = (v) => num(v) !== null;
/**
 * One line, 1–3 phrases, ≤ 80 characters: why this row ranks where it does, adding what the phone card's three
 * metrics and badge do not already say. Missing figures are skipped.
 */
export function reason(rec, presetId) {
  if (!rec) return "";
  const ivHv = has(rec.ivHv) ? `IV ${formatFixed(Math.abs(rec.ivHv), 1)} pts ${rec.ivHv >= 0 ? "over" : "under"} HV` : null;
  const wall = rec.right === "PE" && has(rec.support) && rec.strike < rec.support ? "beyond put wall" : rec.right === "CE" && has(rec.resistance) && rec.strike > rec.resistance ? "beyond call wall" : null;
  switch (presetId) {
    case "overview":
      return join([
        has(rec.skew) ? (rec.skew >= 0 ? `Puts ${formatFixed(rec.skew, 1)} pts richer` : `Calls ${formatFixed(-rec.skew, 1)} pts richer`) : null,
        has(rec.emPct) ? `${formatFixed(rec.emPct, 1)}% move priced` : null,
        rec.build ? rec.build.text.toLowerCase() : has(rec.pcr) ? `PCR ${formatFixed(rec.pcr, 2)}` : null,
      ]);
    case "unusual":
      return join([
        has(rec.volOi) ? `Vol/OI ${formatFixed(rec.volOi, 1)}× on ${formatCompact(rec.oiLots)} lots OI` : null,
        has(rec.oiChgPct) ? `OI ${formatSigned(rec.oiChgPct, 1)}%` : null,
        has(rec.changePct) ? `price ${formatSigned(rec.changePct, 1)}%` : null,
      ]);
    case "buildup":
      return join([has(rec.oiChgPct) ? `OI ${formatSigned(rec.oiChgPct, 1)}%` : null, has(rec.changePct) ? `price ${formatSigned(rec.changePct, 1)}%` : null, has(rec.volume) ? `${formatCompact(rec.volLots)} lots traded` : null]);
    case "sell":
      return join([ivHv, wall, has(rec.thetaLot) ? `θ ${rupee(rec.thetaLot)}/day` : null]);
    case "buy":
      return join([ivHv, has(rec.popLong) ? `POP ${formatFixed(rec.popLong * 100, 0)}%` : null, has(rec.leverage) ? `${formatFixed(rec.leverage, 0)}× leverage` : null]);
    case "ivout":
      return join([has(rec.nbrIv) ? `Neighbours ${formatFixed(rec.nbrIv, 1)}` : null, has(rec.vsAtm) ? `${formatSigned(rec.vsAtm, 1)} pts vs ATM` : null, has(rec.fair) ? `fair ${formatFixed(rec.fair, 2)}` : null]);
    case "hedge":
      return join([has(rec.costPct) ? `${formatFixed(rec.costPct, 2)}% of F` : null, has(rec.perDay) ? `${rupee(rec.perDay)}/day` : null, has(rec.skewPaid) ? `skew ${formatSigned(rec.skewPaid, 1)} pts` : null]);
    case "arb":
      if (rec.type === "Calendar") return join(["Total variance falls", "model-based: check the term"]);
      return join([has(rec.costsTotal) ? `${rupee(rec.costsTotal)} costs` : null, rec.legs?.length ? rec.legsText : null]);
    default:
      return "";
  }
}

// ── Settings ──

export const SCAN_UNDERLYINGS = Object.freeze(["NIFTY", "BANKNIFTY", "SENSEX"]);
export const AUTO_CHOICES = Object.freeze([0, 60, 120, 300]);
export const ROW_CHOICES = Object.freeze([25, 50, 100]);
export const STRIKE_CHOICES = Object.freeze([20, 30, 40]);
/** Defaults (PRD 07 §9); `auto` is 60 s in demo, 120 s live. */
export const SCREENER_DEFAULTS = Object.freeze({ v: 1, preset: "overview", underlyings: SCAN_UNDERLYINGS, expiries: 2, monthly: true, strikes: 30, auto: 120, rows: 50, brokerage: 20, wingStrikes: 4, hedgeNotional: null });

function validFilter(id, v, def, ctx) {
  const f = FILTERS[id];
  const n = (x) => (x === null ? null : num(x));
  if (v === undefined) return def;
  if (f.type === "min" || f.type === "max") {
    if (v === null) return null;
    const x = n(v);
    if (x === null) return def;
    return f.min !== undefined || f.max !== undefined ? Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, x)) : x;
  }
  if (f.type === "range") {
    if (!Array.isArray(v) || v.length !== 2) return def;
    const lo = v[0] === null ? null : n(v[0]);
    const hi = v[1] === null ? null : n(v[1]);
    if ((v[0] !== null && lo === null) || (v[1] !== null && hi === null)) return def;
    return lo !== null && hi !== null && lo > hi ? [hi, lo] : [lo, hi];
  }
  if (f.type === "toggle") return typeof v === "boolean" ? v : def;
  if (f.type === "seg") return f.options.some((o) => o[0] === v) ? v : def;
  if (f.type === "multi") {
    if (v === null) return null;
    if (!Array.isArray(v)) return def;
    const allowed = f.options ? f.options.map((o) => o[0]) : null;
    const out = v.filter((x, i, a) => typeof x === "string" && a.indexOf(x) === i && (!allowed || allowed.includes(x)));
    return out.length ? out : def;
  }
  return def;
}
/** Saved column order for a preset: "-id" = hidden. Unknown ids dropped, new columns appended, the lead first. */
function validCols(preset, saved) {
  const ids = preset.columns.map((c) => c.id);
  const out = [];
  for (const x of Array.isArray(saved) ? saved : []) {
    if (typeof x !== "string") continue;
    const id = x.replace(/^-/, "");
    if (!ids.includes(id) || out.some((y) => y.replace(/^-/, "") === id)) continue;
    out.push(id === "name" ? "name" : x);
  }
  for (const id of ids) if (!out.some((y) => y.replace(/^-/, "") === id)) out.push(id);
  return ["name", ...out.filter((x) => x !== "name")];
}
/** The visible columns of a preset, in the saved order. */
export const visibleColumns = (preset, cols) => validCols(preset, cols).filter((x) => !x.startsWith("-")).map((id) => preset.columns.find((c) => c.id === id));

/**
 * The screener's saved settings (mcb.dashboard.screener), validated: unknown presets, columns and values fall back
 * to defaults, ranges are clamped, `auto` under 60 s is raised to 60 (0 = off).
 * @param {object} saved @param {{ list?: string[], demo?: boolean }} o
 */
export function screenerConfig(saved, { list = SCAN_UNDERLYINGS, demo = false } = {}) {
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const d = SCREENER_DEFAULTS;
  const int = (v, lo, hi, def) => (num(v) === null ? def : Math.round(Math.min(hi, Math.max(lo, Number(v)))));
  const pick = (v, choices, def) => (num(v) !== null && choices.includes(Number(v)) ? Number(v) : def);
  let auto = num(s.auto);
  if (auto === null) auto = demo ? 60 : d.auto;
  else if (auto <= 0) auto = 0;
  else if (auto < 60) auto = 60;
  else auto = AUTO_CHOICES.filter((x) => x > 0).reduce((b, x) => (Math.abs(x - auto) < Math.abs(b - auto) ? x : b), 60);
  const defU = d.underlyings.filter((u) => list.includes(u));
  let underlyings = Array.isArray(s.underlyings) ? s.underlyings.filter((u, i, a) => list.includes(u) && a.indexOf(u) === i) : [];
  if (!underlyings.length) underlyings = defU.length ? [...defU] : [list[0]];
  const filters = {};
  const sort = {};
  const cols = {};
  for (const p of PRESETS) {
    const sf = s.filters?.[p.id] && typeof s.filters[p.id] === "object" ? s.filters[p.id] : {};
    filters[p.id] = Object.fromEntries(p.filters.map((id) => [id, validFilter(id, sf[id], filterDefault(p, id))]));
    const so = s.sort?.[p.id];
    sort[p.id] = so && p.columns.some((c) => c.id === so.by && c.sortable) && ["asc", "desc"].includes(so.dir) ? { by: so.by, dir: so.dir } : { ...p.defaults.sort };
    cols[p.id] = validCols(p, s.cols?.[p.id]);
  }
  return {
    v: 1,
    preset: PRESET_IDS.includes(s.preset) ? s.preset : d.preset,
    underlyings,
    expiries: int(s.expiries, 1, 3, d.expiries),
    monthly: typeof s.monthly === "boolean" ? s.monthly : d.monthly,
    strikes: pick(s.strikes, STRIKE_CHOICES, d.strikes),
    auto,
    rows: pick(s.rows, ROW_CHOICES, d.rows),
    brokerage: num(s.brokerage) === null ? d.brokerage : Math.min(100, Math.max(0, Number(s.brokerage))),
    wingStrikes: int(s.wingStrikes, 1, 10, d.wingStrikes),
    hedgeNotional: num(s.hedgeNotional) > 0 ? Math.min(1e11, Number(s.hedgeNotional)) : null,
    filters,
    sort,
    cols,
  };
}

/**
 * The expiries one sweep reads for an underlying: the first `n` listed plus the current monthly (the first expiry
 * that is the last of its month among those listed) when `monthly` is on.
 */
export function scanExpiries(expiries, { n = 2, monthly = true } = {}) {
  const list = [...(expiries ?? [])].filter((e) => ISO_DAY.test(String(e))).sort();
  const out = list.slice(0, n);
  if (monthly) {
    const m = list.find((e) => O.isMonthly(e, list));
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}
/** Sweep order: every underlying's nearest expiry first, then the second ones, then the monthlies. */
export function scanOrder(byU) {
  const out = [];
  const lists = [...byU].map(([u, list]) => [u, list]);
  const depth = Math.max(0, ...lists.map(([, l]) => l.length));
  for (let i = 0; i < depth; i++) for (const [u, l] of lists) if (l[i]) out.push({ underlying: u, expiry: l[i] });
  return out;
}

// ── Hand-off into the desk (mcb.dashboard.desk) ──

/**
 * The desk's saved state after a screener hand-off: underlying and expiry set, an optional one-shot `focus` for the
 * Chain page, and legs merged into the strategy basket of that underlying × expiry (same strike, right and side add
 * lots, as the desk's own addLeg). Other keys and baskets are kept. Pure: returns a new object.
 * @param {object} prefs @param {{ underlying: string, expiry: string, focus?: { strike: number, side: "ce"|"pe" }, leg?: object, legs?: object[] }} h
 */
export function handoffPrefs(prefs, { underlying, expiry, focus = null, leg = null, legs = null } = {}) {
  const base = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? structuredClone(prefs) : {};
  const out = { ...base, underlying, expiry };
  if (focus) out.focus = { underlying, expiry, strike: focus.strike, side: focus.side === "pe" || focus.side === "PE" ? "pe" : "ce" };
  const add = [...(legs ?? []), ...(leg ? [leg] : [])];
  if (add.length) {
    const baskets = out.baskets && typeof out.baskets === "object" && !Array.isArray(out.baskets) ? out.baskets : {};
    const key = `${underlying}|${expiry}`;
    const list = Array.isArray(baskets[key]) ? baskets[key] : [];
    for (const l of add) {
      const same = list.find((x) => (x.kind ?? "OPT") === "OPT" && x.strike === l.strike && x.right === l.right && x.side === l.side && (x.entry === undefined || x.entry === null));
      if (same) same.lots = (Number(same.lots) || 0) + (l.lots ?? 1);
      else if (list.length < O.MAX_LEGS) list.push({ right: l.right, strike: l.strike, side: l.side, lots: l.lots ?? 1 });
    }
    out.baskets = { ...baskets, [key]: list };
  }
  return out;
}

// ── Daily baseline (mcb.dashboard.screener.base) ──

/**
 * Keep the first snapshot of each IST day per underlying × expiry; a new day starts over.
 * @param {{ date: string, rows: Record<string, { atmIv, straddle, pcr, at }> }|null} stored
 * @param {string} todayIst YYYY-MM-DD
 * @param {{ key: string, atmIv: number|null, straddle: number|null, pcr: number|null, at?: number }[]} rows
 */
export function dailyBaseline(stored, todayIst, rows, at = Date.now()) {
  const keep = stored && typeof stored === "object" && stored.date === todayIst && stored.rows && typeof stored.rows === "object" ? stored.rows : {};
  const next = { ...keep };
  for (const r of rows ?? []) {
    if (!r?.key || next[r.key] || num(r.atmIv) === null) continue;
    next[r.key] = { atmIv: r.atmIv, straddle: num(r.straddle), pcr: num(r.pcr), at: num(r.at) ?? at };
  }
  const out = { date: todayIst, rows: next };
  return { stored: out, base: next };
}

// ── HV from daily candles ──

/** HV20 and HV10 from GET /v1/history candles, leaving out a final candle dated today (IST, still trading). */
export function hvFromCandles(candles, now = Date.now()) {
  const list = [...(candles ?? [])];
  const today = istDate(now);
  if (list.length && istDate(Number(list[list.length - 1].time) * 1000) === today) list.pop();
  const closes = list.map((c) => num(c.close)).filter((v) => v !== null && v > 0);
  return { hv20: O.realisedVol(closes, 20), hv10: O.realisedVol(closes, 10), closes: closes.length };
}
