// scan-builder.js: the plain-word scan builder (pure, no DOM; the Bridge imports it too). A scan is a model of rules
// in AND / OR groups; each rule reads like a sentence ("Close is above 20-day high", "Volume is more than 2× 20-day
// average volume") and compiles to the scanner's condition language (server/bridge/scanner/expr.mjs). The Advanced
// text mode round-trips through the Bridge (POST /v1/scanner/compile), which matches each side of a comparison
// against the value templates here (matchOperand).
//
//   model = { join: "and" | "or", rules: [rule | { join, rules: [rule] }] }      one level of groups
//   rule  = { left: { id, p? }, op, right?: { id, p? } | { num }, mult? }
//
// Values are either live facts the scanner works out per symbol (FACTS: OI change, PCR, IV rank ...) or candle
// expressions over daily bars with today's bar live at the end ("20-day high" is highest(20)[1]: the 20 days before
// today). Numbers become text only through format.js.

import { formatNumber } from "./format.js";

/** Value groups, in picker order. */
export const GROUPS = Object.freeze([
  { id: "price", label: "Price" },
  { id: "range", label: "Ranges and levels" },
  { id: "volume", label: "Volume" },
  { id: "trend", label: "Averages and oscillators" },
  { id: "fno", label: "Futures and F&O" },
  { id: "options", label: "Options and volatility" },
]);

/**
 * Facts: one number per symbol, worked out by the scanner (server/bridge/scanner/facts.mjs) from daily bars cached
 * once a day, live quotes, futures, the recorder's or the sweep's option chains, the IV history and the MWPL list.
 * unit: price | pct | x (a multiple) | qty | ratio | pts (vol points) | days | bool | rupee
 */
export const FACTS = Object.freeze([
  { id: "range_pct", label: "Day range %", unit: "pct", group: "range", doc: "Today's high minus low, as a % of the previous close." },
  { id: "prev_high", label: "Previous day high", unit: "price", group: "range", doc: "The high of the last full day." },
  { id: "prev_low", label: "Previous day low", unit: "price", group: "range", doc: "The low of the last full day." },
  { id: "high_52w", label: "52-week high", unit: "price", group: "range", doc: "Highest high of the 252 full days before today." },
  { id: "low_52w", label: "52-week low", unit: "price", group: "range", doc: "Lowest low of the 252 full days before today." },
  { id: "from_52w_high_pct", label: "Below 52-week high %", unit: "pct", group: "range", doc: "How far the price is under the 52-week high, in %." },
  { id: "upper_circuit", label: "Upper circuit", unit: "price", group: "range", doc: "The broker's upper band when the feed sends it; else the band of the stock (10 % for F&O stocks, 20 % otherwise) over the previous close." },
  { id: "lower_circuit", label: "Lower circuit", unit: "price", group: "range", doc: "The lower band, worked out the same way." },
  { id: "to_upper_circuit_pct", label: "Distance to upper circuit %", unit: "pct", group: "range", doc: "How far the price is under the upper band, in % of the price." },
  { id: "to_lower_circuit_pct", label: "Distance to lower circuit %", unit: "pct", group: "range", doc: "How far the price is over the lower band, in % of the price." },
  { id: "nr7", label: "Yesterday was NR7", unit: "bool", group: "range", doc: "The last full day had the narrowest high-low range of the last 7 days." },
  { id: "inside_day", label: "Yesterday was an inside day", unit: "bool", group: "range", doc: "The last full day's high and low stayed inside the day before." },
  { id: "vol_pace", label: "Volume pace", unit: "x", group: "volume", doc: "Volume so far against what an average day (20 days) has traded by this minute, on the NSE intraday volume curve. 2 means twice the usual pace." },
  { id: "avg_volume_20", label: "20-day average volume", unit: "qty", group: "volume", doc: "Average daily volume of the 20 full days before today." },
  { id: "hv20", label: "HV 20", unit: "pct", group: "options", doc: "20-day historical volatility from daily closes, annualised, in %." },
  { id: "fut_change_pct", label: "Futures % change", unit: "pct", group: "fno", doc: "The near-month future's change from its previous close." },
  { id: "fut_oi", label: "Futures OI", unit: "qty", group: "fno", doc: "Open interest of the near-month future." },
  { id: "fut_oi_change_pct", label: "Futures OI change %", unit: "pct", group: "fno", doc: "Change of the near-month future's OI since the previous day (or since the first OI seen today)." },
  { id: "basis", label: "Futures basis", unit: "rupee", group: "fno", doc: "Near-month future minus the stock price." },
  { id: "basis_pct", label: "Futures basis %", unit: "pct", group: "fno", doc: "The basis as a % of the stock price." },
  { id: "basis_ann_pct", label: "Futures basis, annualised %", unit: "pct", group: "fno", doc: "The basis % scaled to a year by the days to the future's expiry: the carry a cash-futures trade would lock in, before costs." },
  { id: "rollover_pct", label: "Rollover %", unit: "pct", group: "fno", doc: "Next-month futures OI as a % of near plus next month." },
  { id: "mwpl_pct", label: "MWPL used %", unit: "pct", group: "fno", doc: "Open interest as a % of the market-wide position limit (NSE). The ban starts at 95 %." },
  { id: "in_ban", label: "In the F&O ban", unit: "bool", group: "fno", doc: "On today's NSE F&O ban list." },
  { id: "pcr", label: "PCR (OI)", unit: "ratio", group: "options", doc: "Put OI divided by call OI over the chain's strikes (near expiry)." },
  { id: "atm_iv", label: "ATM IV", unit: "pct", group: "options", doc: "Implied volatility at the at-the-money strike, average of call and put." },
  { id: "iv_rank", label: "IV rank", unit: "pct", group: "options", doc: "Where ATM IV sits between its lowest (0) and highest (100) of the stored days (up to 252)." },
  { id: "iv_percentile", label: "IV percentile", unit: "pct", group: "options", doc: "% of the stored days with a lower ATM IV." },
  { id: "iv_hv_gap", label: "IV minus HV", unit: "pts", group: "options", doc: "ATM IV minus HV 20, in vol points." },
  { id: "put_skew", label: "OTM put IV over ATM", unit: "pts", group: "options", doc: "IV of the put about 5 % out of the money minus ATM IV, in vol points." },
  { id: "call_skew", label: "OTM call IV over ATM", unit: "pts", group: "options", doc: "IV of the call about 5 % out of the money minus ATM IV, in vol points." },
  { id: "max_pain_dist_pct", label: "Distance from max pain %", unit: "pct", group: "options", doc: "Price minus the max pain strike, in % of the price." },
  { id: "straddle_pct", label: "ATM straddle %", unit: "pct", group: "options", doc: "ATM call plus put premium, in % of the price." },
  { id: "expected_move_pct", label: "Expected move %", unit: "pct", group: "options", doc: "One standard deviation to expiry from ATM IV: IV × √(days ÷ 365)." },
  { id: "straddle_vs_move", label: "Straddle ÷ expected move", unit: "ratio", group: "options", doc: "The straddle premium against the expected move (about 0.8 is usual: a straddle prices the mean absolute move)." },
  { id: "top_oi_chg_pct", label: "Largest strike OI change %", unit: "pct", group: "options", doc: "The strike whose OI changed most today, as a % of its previous OI." },
  { id: "max_vol_oi", label: "Highest strike volume ÷ OI", unit: "x", group: "options", doc: "The largest volume / OI among strikes with real OI: high values mean heavy trading against open positions." },
  { id: "dte", label: "Days to expiry", unit: "days", group: "options", doc: "Calendar days to the option chain's expiry." },
]);
export const FACT_IDS = Object.freeze(FACTS.map((f) => f.id));
const FACT_BY_ID = new Map(FACTS.map((f) => [f.id, f]));

const n = (key, label, def, min, max) => Object.freeze({ key, label, def, min, max, int: true });
const DAYS = (def) => n("n", "Days", def, 2, 250);

/**
 * Builder values. expr is a template over the condition language ({n} is the parameter); facts are their own id.
 * Candle values run on daily bars with today's bar live at the end.
 */
export const OPERANDS = Object.freeze(
  [
    { id: "close", label: "Close", unit: "price", group: "price", expr: "close", doc: "The last price (today's bar is live)." },
    { id: "open", label: "Open", unit: "price", group: "price", expr: "open", doc: "Today's open." },
    { id: "high", label: "Day high", unit: "price", group: "price", expr: "high", doc: "Today's high so far." },
    { id: "low", label: "Day low", unit: "price", group: "price", expr: "low", doc: "Today's low so far." },
    { id: "prev_close", label: "Previous close", unit: "price", group: "price", expr: "prev_close", doc: "The last full day's close." },
    { id: "change_pct", label: "% change", unit: "pct", group: "price", expr: "change_pct", doc: "Change from the previous close, in %." },
    { id: "gap_pct", label: "Gap %", unit: "pct", group: "price", expr: "gap_pct", doc: "Today's open against the previous close, in %." },
    { id: "high_n", label: "{n}-day high", unit: "price", group: "range", expr: "highest({n})[1]", params: [DAYS(20)], doc: "Highest high of the n full days before today." },
    { id: "low_n", label: "{n}-day low", unit: "price", group: "range", expr: "lowest({n})[1]", params: [DAYS(20)], doc: "Lowest low of the n full days before today." },
    { id: "volume", label: "Volume", unit: "qty", group: "volume", expr: "volume", doc: "Today's volume so far." },
    { id: "avg_volume_n", label: "{n}-day average volume", unit: "qty", group: "volume", expr: "avg_volume({n})[1]", params: [DAYS(20)], doc: "Average daily volume of the n full days before today." },
    { id: "sma_n", label: "{n}-day average", unit: "price", group: "trend", expr: "sma({n})", params: [DAYS(50)], doc: "Simple moving average of the closes (today's live close included)." },
    { id: "ema_n", label: "{n}-day EMA", unit: "price", group: "trend", expr: "ema({n})", params: [DAYS(20)], doc: "Exponential moving average of the closes." },
    { id: "rsi_n", label: "RSI ({n})", unit: "num", group: "trend", expr: "rsi({n})", params: [n("n", "Days", 14, 2, 100)], doc: "Wilder's RSI of the daily closes." },
    { id: "atr_n", label: "ATR ({n})", unit: "price", group: "trend", expr: "atr({n})", params: [n("n", "Days", 14, 2, 100)], doc: "Average true range of the daily bars." },
    { id: "roc_n", label: "{n}-day change %", unit: "pct", group: "trend", expr: "roc({n})", params: [DAYS(20)], doc: "Change of the close over n days, in %." },
    ...FACTS.map((f) => ({ ...f, expr: f.id, fact: true })),
  ].map((o) => Object.freeze({ ...o, params: Object.freeze(o.params ?? []) })),
);
export const OPERAND_BY_ID = new Map(OPERANDS.map((o) => [o.id, o]));

/** Comparisons: the sign in the language, and the words for a price-like and a quantity-like left side. */
export const OPS = Object.freeze([
  { id: "gt", sign: ">", price: "is above", qty: "is more than" },
  { id: "gte", sign: ">=", price: "is at or above", qty: "is at least" },
  { id: "lt", sign: "<", price: "is below", qty: "is less than" },
  { id: "lte", sign: "<=", price: "is at or below", qty: "is at most" },
  { id: "xa", sign: "crosses above", price: "crosses above", qty: "crosses above" },
  { id: "xb", sign: "crosses below", price: "crosses below", qty: "crosses below" },
]);
const OP_BY_ID = new Map(OPS.map((o) => [o.id, o]));
const OP_BY_SIGN = new Map(OPS.map((o) => [o.sign, o.id]));
/** Yes / no for a true-or-false fact (NR7, inside day, in ban). */
export const BOOL_OPS = Object.freeze([
  { id: "yes", words: "is yes" },
  { id: "no", words: "is no" },
]);

export const isBool = (operandId) => OPERAND_BY_ID.get(operandId)?.unit === "bool";
const priceLike = (unit) => unit === "price" || unit === "rupee";

/** The words for a comparison given its left value. */
export function opWords(opId, leftId) {
  if (opId === "yes" || opId === "no") return opId === "yes" ? "is yes" : "is no";
  const o = OP_BY_ID.get(opId);
  if (!o) return "";
  return priceLike(OPERAND_BY_ID.get(leftId)?.unit) ? o.price : o.qty;
}

/** The value's label with its parameters filled in ("20-day high"). */
export function operandLabel(ref) {
  if (!ref) return "";
  if (ref.num !== undefined) return formatNumber(ref.num, { maximumFractionDigits: 4 });
  const o = OPERAND_BY_ID.get(ref.id);
  if (!o) return String(ref.id ?? "");
  return o.label.replace(/\{(\w+)\}/g, (_, k) => formatNumber(paramValue(o, ref, k), { maximumFractionDigits: 2 }));
}

function paramValue(o, ref, key) {
  const spec = o.params.find((p) => p.key === key);
  const v = ref?.p?.[key];
  return v === undefined || v === null || v === "" ? spec?.def : Number(v);
}

/** Check one parameter value against its spec; returns a message or null. */
export function paramError(spec, value) {
  const v = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(v)) return `${spec.label}: give a number.`;
  if (spec.int && !Number.isInteger(v)) return `${spec.label}: a whole number.`;
  if (v < spec.min || v > spec.max) return `${spec.label}: from ${formatNumber(spec.min)} to ${formatNumber(spec.max)}.`;
  return null;
}

/** The expression text of one value reference. */
function operandExpr(ref, errors, path) {
  if (!ref) {
    errors.push({ path, message: "Pick a value." });
    return null;
  }
  if (ref.num !== undefined) {
    const v = Number(ref.num);
    if (ref.num === "" || !Number.isFinite(v)) {
      errors.push({ path, message: "Give a number." });
      return null;
    }
    return numText(v);
  }
  const o = OPERAND_BY_ID.get(ref.id);
  if (!o) {
    errors.push({ path, message: `Unknown value "${ref.id}".` });
    return null;
  }
  let text = o.expr;
  for (const spec of o.params) {
    const v = paramValue(o, ref, spec.key);
    const e = paramError(spec, v);
    if (e) errors.push({ path: `${path}.${spec.key}`, message: e });
    text = text.replaceAll(`{${spec.key}}`, numText(Number(v)));
  }
  return text;
}

/** A number as condition-language text (plain digits, a leading - for negatives: never display text). */
function numText(v) {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 1e6) / 1e6;
  const s = String(Math.abs(r));
  return r < 0 ? `-${s}` : s;
}

function ruleText(rule, errors, path) {
  const left = operandExpr(rule.left, errors, `${path}.left`);
  if (rule.left && isBool(rule.left.id)) {
    if (rule.op !== "yes" && rule.op !== "no") errors.push({ path: `${path}.op`, message: "Pick yes or no." });
    return left === null ? null : `${left} == ${rule.op === "no" ? 0 : 1}`;
  }
  const op = OP_BY_ID.get(rule.op);
  if (!op) errors.push({ path: `${path}.op`, message: "Pick a comparison." });
  const right = operandExpr(rule.right, errors, `${path}.right`);
  let rightText = right;
  if (rule.mult !== undefined && rule.mult !== null && rule.mult !== "" && rule.right?.num === undefined) {
    const m = Number(rule.mult);
    if (!Number.isFinite(m) || m <= 0 || m > 1000) errors.push({ path: `${path}.mult`, message: "The multiple is a number above 0, up to 1000." });
    else if (m !== 1) rightText = `${numText(m)} * ${right}`;
  }
  if (left === null || right === null || !op) return null;
  if (rule.left.id && rule.right.id && rule.left.id === rule.right.id && JSON.stringify(rule.left.p ?? {}) === JSON.stringify(rule.right.p ?? {}) && !rule.mult) {
    errors.push({ path, message: "Both sides are the same value." });
  }
  return `${left} ${op.sign} ${rightText}`;
}

/**
 * Compile a model to condition text. { text, errors: [{ path, message }] }; text is "" when there are no rules.
 * @param {object} model
 */
export function compileModel(model) {
  const errors = [];
  const join = model?.join === "or" ? "or" : "and";
  const parts = [];
  const rules = Array.isArray(model?.rules) ? model.rules : [];
  rules.forEach((r, i) => {
    if (r && Array.isArray(r.rules)) {
      const j = r.join === "or" ? "or" : "and";
      const inner = r.rules.map((x, k) => ruleText(x, errors, `rules.${i}.rules.${k}`)).filter((t) => t !== null);
      if (!inner.length) return;
      const body = inner.join(` ${j} `);
      parts.push(inner.length > 1 && j !== join ? `(${body})` : body);
    } else {
      const t = ruleText(r, errors, `rules.${i}`);
      if (t !== null) parts.push(t);
    }
  });
  return { text: parts.join(` ${join} `), errors };
}

/** One rule as plain words: "Volume is more than 2× 20-day average volume". */
export function ruleWords(rule) {
  const left = operandLabel(rule?.left);
  const words = opWords(rule?.op, rule?.left?.id);
  if (rule?.left && isBool(rule.left.id)) return rule.op === "no" ? `${left} is no` : left;
  const mult = rule?.mult !== undefined && rule?.mult !== null && rule.mult !== "" && Number(rule.mult) !== 1 && rule.right?.num === undefined ? `${formatNumber(rule.mult, { maximumFractionDigits: 2 })}× ` : "";
  const unit = rule?.right?.num !== undefined ? unitSuffix(OPERAND_BY_ID.get(rule.left?.id)?.unit) : "";
  return `${left} ${words} ${mult}${operandLabel(rule?.right)}${unit}`;
}

const unitSuffix = (unit) => (unit === "pct" ? "%" : unit === "x" ? "×" : unit === "pts" ? " pts" : unit === "days" ? " days" : "");

/** The whole model in words, for cards and saved lists. */
export function describeModel(model) {
  const join = model?.join === "or" ? " or " : " and ";
  const rules = Array.isArray(model?.rules) ? model.rules : [];
  return rules
    .map((r) => (Array.isArray(r?.rules) ? `(${r.rules.map(ruleWords).join(r.join === "or" ? " or " : " and ")})` : ruleWords(r)))
    .join(join);
}

// ── Advanced text back to the builder ──

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMPLATES = OPERANDS.map((o) => {
  const keys = [];
  const src = escapeRe(o.expr).replace(/\\\{(\w+)\\\}/g, (_, k) => {
    keys.push(k);
    return "(\\d+(?:\\.\\d+)?)";
  });
  return { o, keys, re: new RegExp(`^${src}$`) };
});

/**
 * The value a piece of canonical condition text is (scanner expr.mjs toText), or null. "highest(20)[1]" →
 * { id: "high_n", p: { n: 20 } }; a plain number → { num }.
 * @param {string} text
 */
export function matchOperand(text) {
  const t = String(text ?? "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return { num: Number(t) };
  for (const { o, keys, re } of TEMPLATES) {
    const m = re.exec(t);
    if (!m) continue;
    if (!keys.length) return { id: o.id };
    const p = {};
    keys.forEach((k, i) => (p[k] = Number(m[i + 1])));
    return { id: o.id, p };
  }
  return null;
}

/** A comparison sign → op id ("crosses above" → "xa"), or null. */
export const opOfSign = (sign) => OP_BY_SIGN.get(sign) ?? null;

/** A new rule to start from. */
export const emptyRule = () => ({ left: { id: "close" }, op: "gt", right: { id: "high_n", p: { n: 20 } } });

/** Search the values by label, id, group or definition (the picker's search box). */
export function searchOperands(query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...OPERANDS];
  const words = q.split(/\s+/);
  const groupLabel = new Map(GROUPS.map((g) => [g.id, g.label.toLowerCase()]));
  return OPERANDS.filter((o) => {
    const hay = `${o.label} ${o.id} ${groupLabel.get(o.group) ?? ""} ${o.doc ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Result columns the table can show (every row carries these facts). `sector` is text. */
export const COLUMNS = Object.freeze([
  { id: "ltp", label: "LTP", unit: "price", def: true },
  { id: "change_pct", label: "% chg", unit: "pct", def: true },
  { id: "vol_pace", label: "Vol ×", unit: "x", def: true },
  { id: "fut_oi_change_pct", label: "OI chg %", unit: "pct", def: true },
  { id: "atm_iv", label: "IV", unit: "pct", def: true },
  { id: "iv_rank", label: "IV rank", unit: "rank", def: true },
  { id: "pcr", label: "PCR", unit: "ratio", def: false },
  { id: "basis_pct", label: "Basis %", unit: "pct", def: false },
  { id: "mwpl_pct", label: "MWPL %", unit: "pct", def: false },
  { id: "gap_pct", label: "Gap %", unit: "pct", def: false },
  { id: "rollover_pct", label: "Rollover %", unit: "pct", def: false },
  { id: "iv_hv_gap", label: "IV − HV", unit: "pts", def: false },
  { id: "straddle_vs_move", label: "Straddle ÷ move", unit: "ratio", def: false },
  { id: "sector", label: "Sector", unit: "text", def: true },
]);

/** Rows sorted by a column (pure): missing values last, text A to Z, numbers by `dir` (1 up, -1 down). */
export function sortRows(rows, col, dir = -1) {
  const val = (r) => (col === "symbol" ? r.symbol : col === "sector" ? (r.facts?.sector ?? null) : (r.facts?.[col] ?? r.values?.[col] ?? null));
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * (dir > 0 ? 1 : -1);
    return (x - y) * dir;
  });
}

/** Filter result rows by sector, index membership and F&O (pure). */
export function filterRows(rows, { sector = "", index = "", fnoOnly = false } = {}) {
  return rows.filter((r) => (!sector || r.facts?.sector === sector) && (!index || (r.facts?.indices ?? []).includes(index)) && (!fnoOnly || r.facts?.fno === true));
}

/** CSV of result rows over the shown columns (pure). Numbers are plain (a spreadsheet reads them), text is quoted. */
export function resultsCsv(rows, cols) {
  const q = (v) => (v === null || v === undefined ? "" : typeof v === "number" ? numText(v) : `"${String(v).replace(/"/g, '""')}"`);
  const head = ["symbol", "new", ...cols.map((c) => c.id)].join(",");
  return [head, ...rows.map((r) => [q(r.symbol), r.isNew ? "1" : "0", ...cols.map((c) => q(c.id === "sector" ? r.facts?.sector : (r.facts?.[c.id] ?? null)))].join(","))].join("\n");
}

export const factInfo = (id) => FACT_BY_ID.get(id) ?? null;
