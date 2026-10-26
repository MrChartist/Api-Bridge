/**
 * Scanner condition language (stream S13). A small, safe expression language (no eval, no property access, no
 * loops): it is parsed into a tree and evaluated over candle series.
 *
 *   rsi(14) > 60 and close > sma(50)
 *   close crosses above ema(20) and volume > 2 * avg_volume(20)
 *   change_pct >= 3 or (close > highest(20, high)[1] and atr(14) / close < 0.03)
 *
 * Values are series aligned to the candles (oldest first). `x[k]` is x k bars ago. Comparisons and `crosses above`
 * / `crosses below` give true/false per bar; the scan matches when the whole condition is true on the LAST bar.
 * Anything not computable yet (too few bars) is NaN, and a comparison with NaN is false.
 *
 * Fields: open high low close volume oi ltp (= close) prev_close change change_pct gap_pct hl2 hlc3 range
 * Functions: see FUNCTIONS below (periods must be plain numbers).
 */
import { BridgeError } from "../core/errors.mjs";
import * as ind from "./indicators.mjs";

export const MAX_EXPRESSION_LENGTH = 1000;
const MAX_NODES = 300;
const MAX_PERIOD = 500;

const isNum = Number.isFinite;
const bad = (msg) => new BridgeError("VALIDATION_FAILED", `Scan condition: ${msg}`, { errors: [{ path: "condition", message: msg }] });

/** Fields as series builders over the candle columns { time, open, high, low, close, volume, oi }. */
const FIELDS = Object.freeze({
  open: (c) => c.open,
  high: (c) => c.high,
  low: (c) => c.low,
  close: (c) => c.close,
  ltp: (c) => c.close,
  volume: (c) => c.volume,
  oi: (c) => c.oi,
  prev_close: (c) => shift(c.close, 1),
  change: (c) => c.close.map((v, i) => v - c.close[i - 1]),
  change_pct: (c) => c.close.map((v, i) => ((v - c.close[i - 1]) / c.close[i - 1]) * 100),
  gap_pct: (c) => c.open.map((v, i) => ((v - c.close[i - 1]) / c.close[i - 1]) * 100),
  hl2: (c) => c.high.map((h, i) => (h + c.low[i]) / 2),
  hlc3: (c) => c.high.map((h, i) => (h + c.low[i] + c.close[i]) / 3),
  range: (c) => c.high.map((h, i) => h - c.low[i]),
});

/**
 * name -> { periods: number of leading constant args (with defaults), series: whether a trailing series arg is
 * allowed (default close), fn(cols, periods, seriesArgs) }
 */
const FUNCTIONS = Object.freeze({
  sma: { periods: [null], src: true, fn: (c, [n], s) => ind.sma(s ?? c.close, n), doc: "sma(n[, src]) simple moving average" },
  ema: { periods: [null], src: true, fn: (c, [n], s) => ind.ema(s ?? c.close, n), doc: "ema(n[, src]) exponential moving average" },
  wma: { periods: [null], src: true, fn: (c, [n], s) => wma(s ?? c.close, n), doc: "wma(n[, src]) weighted moving average" },
  rsi: { periods: [14], src: true, fn: (c, [n], s) => ind.rsi(s ?? c.close, n), doc: "rsi(n = 14[, src]) Wilder RSI" },
  atr: { periods: [14], fn: (c, [n]) => ind.atr(c.high, c.low, c.close, n), doc: "atr(n = 14) average true range" },
  highest: { periods: [null], src: true, fn: (c, [n], s) => ind.highest(s ?? c.high, n), doc: "highest(n[, src = high]) highest value of the last n bars" },
  lowest: { periods: [null], src: true, fn: (c, [n], s) => ind.lowest(s ?? c.low, n), doc: "lowest(n[, src = low]) lowest value of the last n bars" },
  stddev: { periods: [null], src: true, fn: (c, [n], s) => ind.stddev(s ?? c.close, n), doc: "stddev(n[, src]) standard deviation" },
  roc: { periods: [null], src: true, fn: (c, [n], s) => ind.roc(s ?? c.close, n), doc: "roc(n[, src]) rate of change in percent" },
  avg_volume: { periods: [20], fn: (c, [n]) => ind.sma(c.volume, n), doc: "avg_volume(n = 20) average volume" },
  macd: { periods: [12, 26], src: true, fn: (c, [f, s], src) => ind.macd(src ?? c.close, f, s), doc: "macd(fast = 12, slow = 26[, src]) MACD line" },
  macd_signal: { periods: [12, 26, 9], fn: (c, [f, s, g]) => ind.macdSignal(c.close, f, s, g), doc: "macd_signal(fast = 12, slow = 26, signal = 9)" },
  bb_upper: { periods: [20, 2], fn: (c, [n, k]) => bb(c.close, n, k), doc: "bb_upper(n = 20, k = 2) upper Bollinger band" },
  bb_lower: { periods: [20, 2], fn: (c, [n, k]) => bb(c.close, n, -k), doc: "bb_lower(n = 20, k = 2) lower Bollinger band" },
  supertrend: { periods: [10, 3], fn: (c, [n, m]) => ind.supertrend(c.high, c.low, c.close, n, m), doc: "supertrend(n = 10, mult = 3) Supertrend line" },
  vwap: { periods: [], fn: (c) => ind.vwap(c.time, c.high, c.low, c.close, c.volume), doc: "vwap() intraday VWAP (resets each day)" },
  abs: { periods: [], args: 1, fn: (c, p, s, a) => a[0].map(Math.abs), doc: "abs(x)" },
  min: { periods: [], args: 2, fn: (c, p, s, a) => a[0].map((v, i) => Math.min(v, a[1][i])), doc: "min(a, b)" },
  max: { periods: [], args: 2, fn: (c, p, s, a) => a[0].map((v, i) => Math.max(v, a[1][i])), doc: "max(a, b)" },
});

function bb(src, n, k) {
  const m = ind.sma(src, n);
  const sd = ind.stddev(src, n);
  return m.map((v, i) => v + k * sd[i]);
}

function wma(src, n) {
  const d = (n * (n + 1)) / 2;
  return src.map((_, i) => {
    if (i + 1 < n) return NaN;
    let s = 0;
    for (let k = 0; k < n; k += 1) s += src[i - k] * (n - k);
    return s / d;
  });
}

function shift(series, k) {
  if (k === 0) return series;
  return series.map((_, i) => (i - k >= 0 ? series[i - k] : NaN));
}

/** The language reference served at GET /v1/scanner/indicators. */
export function languageReference() {
  return {
    fields: Object.keys(FIELDS),
    functions: Object.entries(FUNCTIONS).map(([name, f]) => ({ name, usage: f.doc })),
    operators: ["+", "-", "*", "/", ">", ">=", "<", "<=", "==", "!=", "crosses above", "crosses below", "and", "or", "not", "x[k] (k bars ago)"],
    examples: [
      "rsi(14) > 60 and close > sma(50)",
      "close crosses above ema(20) and volume > 2 * avg_volume(20)",
      "close > highest(20)[1]",
      "change_pct >= 3 and close > vwap()",
      "macd() crosses above macd_signal()",
      "close > supertrend(10, 3)",
    ],
  };
}

// ── tokenizer ──

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(>=|<=|==|!=|&&|\|\||[-+*/()<>=,[\]!]))/y;

function tokenize(src) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m) throw bad(`unexpected character at position ${pos + 1}: "${src.slice(pos, pos + 10).trim()}"`);
    pos = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) out.push({ k: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ k: "id", v: m[2].toLowerCase() });
    else {
      const op = { "&&": "and", "||": "or", "!": "not", "=": "==" }[m[3]] ?? m[3];
      out.push(op === "and" || op === "or" || op === "not" ? { k: "id", v: op } : { k: "op", v: op });
    }
  }
  return out;
}

// ── parser (recursive descent) ──

/**
 * Parse a condition (or a value expression for a column) into a tree. Throws VALIDATION_FAILED with a readable
 * message. @param {string} src @returns {object}
 */
export function parseExpression(src) {
  if (typeof src !== "string" || !src.trim()) throw bad("it is empty.");
  if (src.length > MAX_EXPRESSION_LENGTH) throw bad(`keep it under ${MAX_EXPRESSION_LENGTH} characters.`);
  const toks = tokenize(src);
  let i = 0;
  let nodes = 0;
  const peek = () => toks[i];
  const node = (n) => {
    nodes += 1;
    if (nodes > MAX_NODES) throw bad("it is too long.");
    return n;
  };
  const isOp = (v) => peek()?.k === "op" && peek().v === v;
  const isWord = (v) => peek()?.k === "id" && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw bad(`expected "${v}"${peek() ? ` before "${peek().v}"` : " at the end"}.`);
    i += 1;
  };

  function parseOr() {
    let l = parseAnd();
    while (isWord("or")) {
      i += 1;
      l = node({ t: "or", l, r: parseAnd() });
    }
    return l;
  }
  function parseAnd() {
    let l = parseNot();
    while (isWord("and")) {
      i += 1;
      l = node({ t: "and", l, r: parseNot() });
    }
    return l;
  }
  function parseNot() {
    if (isWord("not")) {
      i += 1;
      return node({ t: "not", x: parseNot() });
    }
    return parseCmp();
  }
  function parseCmp() {
    const l = parseSum();
    if (isWord("crosses")) {
      i += 1;
      const dir = peek()?.v;
      if (dir !== "above" && dir !== "below") throw bad('write "crosses above" or "crosses below".');
      i += 1;
      return node({ t: "cross", dir, l, r: parseSum() });
    }
    const t = peek();
    if (t?.k === "op" && [">", ">=", "<", "<=", "==", "!="].includes(t.v)) {
      i += 1;
      return node({ t: "cmp", op: t.v, l, r: parseSum() });
    }
    return l;
  }
  function parseSum() {
    let l = parseTerm();
    while (isOp("+") || isOp("-")) {
      const op = toks[i++].v;
      l = node({ t: "bin", op, l, r: parseTerm() });
    }
    return l;
  }
  function parseTerm() {
    let l = parseUnary();
    while (isOp("*") || isOp("/")) {
      const op = toks[i++].v;
      l = node({ t: "bin", op, l, r: parseUnary() });
    }
    return l;
  }
  function parseUnary() {
    if (isOp("-")) {
      i += 1;
      return node({ t: "neg", x: parseUnary() });
    }
    if (isOp("+")) {
      i += 1;
      return parseUnary();
    }
    return parsePostfix(parsePrimary());
  }
  function parsePostfix(base) {
    let n = base;
    while (isOp("[")) {
      i += 1;
      const k = peek();
      if (k?.k !== "num" || !Number.isInteger(k.v) || k.v < 0 || k.v > MAX_PERIOD) throw bad(`an offset like [1] must be a whole number from 0 to ${MAX_PERIOD}.`);
      i += 1;
      expect("]");
      n = node({ t: "shift", k: k.v, x: n });
    }
    return n;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw bad("it ends too early.");
    if (t.k === "num") {
      i += 1;
      return node({ t: "num", v: t.v });
    }
    if (isOp("(")) {
      i += 1;
      const e = parseOr();
      expect(")");
      return e;
    }
    if (t.k === "id") {
      i += 1;
      const name = t.v;
      if (isOp("(")) {
        i += 1;
        const args = [];
        if (!isOp(")")) {
          args.push(parseOr());
          while (isOp(",")) {
            i += 1;
            args.push(parseOr());
          }
        }
        expect(")");
        return node(checkCall(name, args));
      }
      if (!Object.hasOwn(FIELDS, name)) {
        throw bad(Object.hasOwn(FUNCTIONS, name) ? `${name} is a function: write ${name}(...).` : `unknown name "${name}". Fields: ${Object.keys(FIELDS).join(", ")}.`);
      }
      return node({ t: "field", name });
    }
    throw bad(`unexpected "${t.v}".`);
  }

  const tree = parseOr();
  if (i < toks.length) throw bad(`unexpected "${toks[i].v}".`);
  return tree;
}

function checkCall(name, args) {
  const f = FUNCTIONS[name];
  if (!f) throw bad(`unknown function "${name}". Functions: ${Object.keys(FUNCTIONS).join(", ")}.`);
  if (f.args) {
    if (args.length !== f.args) throw bad(`${name} takes ${f.args} argument(s).`);
    return { t: "call", name, periods: [], src: null, args };
  }
  const periods = [];
  let k = 0;
  for (; k < f.periods.length && k < args.length && args[k].t === "num"; k += 1) {
    const v = args[k].v;
    if (!(v > 0) || v > MAX_PERIOD) throw bad(`${name}: ${v} is not a period from 1 to ${MAX_PERIOD}.`);
    periods.push(v);
  }
  for (let d = periods.length; d < f.periods.length; d += 1) {
    if (f.periods[d] === null) throw bad(`${name} needs a period, for example ${name}(20).`);
    periods.push(f.periods[d]);
  }
  const rest = args.slice(k);
  if (rest.length > (f.src ? 1 : 0)) throw bad(`${f.doc}`);
  for (const [idx, p] of periods.entries()) if (!Number.isInteger(p) && !(name === "supertrend" && idx === 1) && !(name.startsWith("bb_") && idx === 1)) throw bad(`${name}: periods must be whole numbers.`);
  return { t: "call", name, periods, src: rest[0] ?? null, args: [] };
}

/** The most bars any part of the tree looks back, plus a margin for EMA/RSI warm-up. */
export function lookbackOf(tree) {
  let max = 2;
  const walk = (n, extra = 0) => {
    if (!n) return;
    if (n.t === "shift") return walk(n.x, extra + n.k);
    if (n.t === "call") {
      const p = n.periods.length ? Math.max(...n.periods.filter(Number.isInteger)) : 1;
      // smoothed indicators need warm-up bars to settle
      const warm = ["ema", "rsi", "atr", "macd", "macd_signal", "supertrend"].includes(n.name) ? p * 3 : p;
      max = Math.max(max, warm + extra + 1);
      walk(n.src, extra);
      for (const a of n.args) walk(a, extra);
      return;
    }
    if (n.t === "cross") max = Math.max(max, extra + 2);
    for (const k of ["l", "r", "x"]) if (n[k]) walk(n[k], extra);
  };
  walk(tree);
  return max;
}

/** Candle list -> column arrays. */
export function columns(candles) {
  const c = { time: [], open: [], high: [], low: [], close: [], volume: [], oi: [] };
  for (const k of candles) {
    c.time.push(k.time);
    c.open.push(k.open);
    c.high.push(k.high);
    c.low.push(k.low);
    c.close.push(k.close);
    c.volume.push(isNum(k.volume) ? k.volume : NaN);
    c.oi.push(isNum(k.oi) ? k.oi : NaN);
  }
  return c;
}

const bool = (b) => (b ? 1 : 0);

/**
 * Evaluate a tree over column arrays.
 * @returns {number[]} the series (booleans are 1/0)
 */
export function evaluate(tree, cols) {
  const memo = new Map();
  const ev = (n) => {
    const key = JSON.stringify(n);
    if (memo.has(key)) return memo.get(key);
    const out = compute(n);
    memo.set(key, out);
    return out;
  };
  const len = cols.close.length;
  const compute = (n) => {
    switch (n.t) {
      case "num":
        return new Array(len).fill(n.v);
      case "field":
        return FIELDS[n.name](cols);
      case "shift":
        return shift(ev(n.x), n.k);
      case "neg":
        return ev(n.x).map((v) => -v);
      case "not":
        return ev(n.x).map((v) => bool(!(v === 1)));
      case "and": {
        const l = ev(n.l);
        const r = ev(n.r);
        return l.map((v, i) => bool(v === 1 && r[i] === 1));
      }
      case "or": {
        const l = ev(n.l);
        const r = ev(n.r);
        return l.map((v, i) => bool(v === 1 || r[i] === 1));
      }
      case "bin": {
        const l = ev(n.l);
        const r = ev(n.r);
        if (n.op === "+") return l.map((v, i) => v + r[i]);
        if (n.op === "-") return l.map((v, i) => v - r[i]);
        if (n.op === "*") return l.map((v, i) => v * r[i]);
        return l.map((v, i) => (r[i] === 0 ? NaN : v / r[i]));
      }
      case "cmp": {
        const l = ev(n.l);
        const r = ev(n.r);
        const f = { ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, "==": (a, b) => a === b, "!=": (a, b) => a !== b }[n.op];
        return l.map((v, i) => bool(isNum(v) && isNum(r[i]) && f(v, r[i])));
      }
      case "cross": {
        const l = ev(n.l);
        const r = ev(n.r);
        return l.map((v, i) => {
          if (i === 0 || ![v, r[i], l[i - 1], r[i - 1]].every(isNum)) return 0;
          return bool(n.dir === "above" ? v > r[i] && l[i - 1] <= r[i - 1] : v < r[i] && l[i - 1] >= r[i - 1]);
        });
      }
      case "call": {
        const f = FUNCTIONS[n.name];
        return f.fn(cols, n.periods, n.src ? ev(n.src) : null, n.args.map(ev));
      }
      default:
        throw new Error(`unknown node ${n.t}`);
    }
  };
  return ev(tree);
}

/** True when the condition holds on the last bar. */
export function matchesLast(tree, cols) {
  const s = evaluate(tree, cols);
  return s.length > 0 && s[s.length - 1] === 1;
}

/** The last value of an expression (a column), rounded; null when not computable. */
export function lastValue(tree, cols) {
  const s = evaluate(tree, cols);
  const v = s[s.length - 1];
  return isNum(v) ? Math.round(v * 10_000) / 10_000 : null;
}
