/**
 * Pure helpers for the Python strategy runner (docs/STRATEGIES-PYTHON.md): strategy ids from file names, the order
 * prefix that marks a strategy's orders, its positions and P&L from those orders, param checks, the log ring buffer,
 * restart back-off and the runner protocol. No I/O here; runner.mjs does the processes and files.
 */

/** A strategy id: lowercase letters and digits joined by "_" (no "-", which separates the parts of a client order id). */
export const STRATEGY_ID_RE = /^[a-z0-9][a-z0-9_]{0,31}$/;
/** Lines on a strategy's stdout that start with this are runner messages (sdk/python/mrchartist_bridge/strategy.py). */
export const PROTOCOL_PREFIX = "@@mcb ";
export const PARAM_KINDS = Object.freeze(["int", "float", "bool", "str", "choice"]);

/**
 * The id for a file name, or null when the file is not a strategy: `EMA-Cross.py` -> `ema_cross`. Files that start
 * with "_" or "." are helpers and are never run.
 * @param {string} file
 */
export function strategyIdOf(file) {
  const m = /^([^._][^/\\]*)\.py$/.exec(String(file));
  if (!m) return null;
  const id = m[1].toLowerCase().replace(/[-\s]+/g, "_");
  return STRATEGY_ID_RE.test(id) ? id : null;
}

/** clientOrderId prefix of every order a strategy places: `A-<id>-<run>-<n>` (the SDK writes it). */
export const orderPrefix = (id) => `A-${id}-`;

/**
 * Net position and P&L per symbol from a strategy's orders (filled quantity at the average price), average cost
 * method: the same rule as build_book() in the Python SDK, so the page and the strategy agree.
 * @param {Array<{ symbol: string, side: "BUY"|"SELL", filledQuantity?: number, avgPrice?: number|null, placedAt?: string, orderId?: string }>} orders
 * @param {Map<string, number> | Record<string, number>} [ltps]
 */
export function strategyBook(orders, ltps = {}) {
  const ltpOf = (s) => (ltps instanceof Map ? ltps.get(s) : ltps[s]);
  const pos = new Map();
  const sorted = [...orders].sort((a, b) => String(a.placedAt ?? "").localeCompare(String(b.placedAt ?? "")) || String(a.orderId ?? "").localeCompare(String(b.orderId ?? "")));
  for (const o of sorted) {
    const q = Math.trunc(Number(o.filledQuantity) || 0);
    const px = Number(o.avgPrice);
    if (q <= 0 || o.avgPrice === null || o.avgPrice === undefined || !Number.isFinite(px)) continue;
    const p = pos.get(o.symbol) ?? { qty: 0, avg: 0, realised: 0 };
    pos.set(o.symbol, p);
    const s = o.side === "BUY" ? q : -q;
    const qty = p.qty;
    if (qty === 0 || qty > 0 === s > 0) {
      p.avg = (p.avg * Math.abs(qty) + px * q) / (Math.abs(qty) + q);
      p.qty = qty + s;
    } else {
      const closing = Math.min(Math.abs(qty), q);
      p.realised += closing * (px - p.avg) * (qty > 0 ? 1 : -1);
      p.qty = qty + s;
      if (p.qty === 0) p.avg = 0;
      else if (p.qty > 0 !== qty > 0) p.avg = px;
    }
  }
  const round = (v) => Math.round(v * 100) / 100;
  let realised = 0;
  let unrealised = 0;
  const positions = [];
  for (const [symbol, p] of pos) {
    const ltp = ltpOf(symbol);
    const u = p.qty && Number.isFinite(ltp) ? p.qty * (ltp - p.avg) : 0;
    positions.push({ symbol, qty: p.qty, avg: round(p.avg), ltp: Number.isFinite(ltp) ? ltp : null, realised: round(p.realised), unrealised: round(u) });
    realised += p.realised;
    unrealised += u;
  }
  return { positions, realised: round(realised), unrealised: round(unrealised), total: round(realised + unrealised), open: positions.filter((p) => p.qty !== 0).length };
}

/**
 * Check params against a strategy's declared params (from the SDK's describe), the same rules as Param.coerce in the
 * SDK. Unknown names are refused. Returns { values, errors } where values holds only the given, checked params.
 * @param {Array<{ name: string, kind: string, default: unknown, min?: number, max?: number, choices?: unknown[] }>} declared
 * @param {Record<string, unknown>} given
 */
export function checkParams(declared, given) {
  const byName = new Map((declared ?? []).map((p) => [p.name, p]));
  const values = {};
  const errors = [];
  if (given === null || given === undefined) return { values, errors };
  if (typeof given !== "object" || Array.isArray(given)) return { values, errors: [{ path: "params", message: "send params as an object" }] };
  for (const [name, raw] of Object.entries(given)) {
    const p = byName.get(name);
    if (!p) {
      errors.push({ path: `params.${name}`, message: "not a param of this strategy" });
      continue;
    }
    const r = coerceParam(p, raw);
    if (r.error) errors.push({ path: `params.${name}`, message: r.error });
    else values[name] = r.value;
  }
  return { values, errors };
}

/** One value as a declared param's kind: { value } or { error }. */
export function coerceParam(p, raw) {
  if (p.kind === "bool") {
    if (typeof raw === "boolean") return { value: raw };
    if (typeof raw === "string" && /^(true|false)$/i.test(raw)) return { value: raw.toLowerCase() === "true" };
    return { error: "must be true or false" };
  }
  if (p.kind === "choice") return (p.choices ?? []).some((c) => c === raw) ? { value: raw } : { error: `must be one of ${(p.choices ?? []).join(", ")}` };
  if (p.kind === "str") {
    if (typeof raw !== "string") return { error: "must be text" };
    return raw.length > 200 ? { error: "must be at most 200 characters" } : { value: raw };
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return { error: "must be a number" };
  if (p.kind === "int" && !Number.isInteger(n)) return { error: "must be a whole number" };
  if (p.min !== undefined && p.min !== null && n < p.min) return { error: `must be at least ${p.min}` };
  if (p.max !== undefined && p.max !== null && n > p.max) return { error: `must be at most ${p.max}` };
  return { value: n };
}

/** Back-off before restart number `attempt` (0-based): base, 2 x base, 4 x base ..., at most maxMs. */
export function backoffMs(attempt, baseMs = 2000, maxMs = 60_000) {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}

/**
 * A line from a strategy's stdout or stderr as a log entry or a runner message.
 * @returns {{ kind: "msg", msg: object } | { kind: "log", level: string, text: string }}
 */
export function parseLine(line, stream = "out") {
  const s = String(line).replace(/\r$/, "");
  if (stream === "out" && s.startsWith(PROTOCOL_PREFIX)) {
    try {
      const msg = JSON.parse(s.slice(PROTOCOL_PREFIX.length));
      if (msg && typeof msg === "object" && typeof msg.t === "string") return { kind: "msg", msg };
    } catch {
      /* not JSON: shown as text below */
    }
  }
  return { kind: "log", level: stream === "err" ? "error" : "info", text: s };
}

const LEVELS = new Set(["debug", "info", "warn", "error"]);
export const logLevel = (l) => (LEVELS.has(l) ? l : "info");

/**
 * A bounded log: the newest `capacity` lines, each numbered, so a page can ask for what came after the last line it has.
 */
export class RingLog {
  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.lines = [];
    this.seq = 0;
  }
  /** @param {{ at: number, level: string, text: string, run?: string|null }} e */
  push(e) {
    const line = { seq: ++this.seq, at: e.at, level: logLevel(e.level), text: String(e.text).slice(0, 4000), run: e.run ?? null };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    return line;
  }
  /** Lines after `after` (a seq), at most `limit`, oldest first; `truncated` when older lines fell out of the buffer. */
  since(after = 0, limit = 500) {
    const a = Math.max(0, Number(after) || 0);
    const rest = this.lines.filter((l) => l.seq > a);
    const items = rest.slice(-Math.max(1, Math.min(2000, limit)));
    return { items, last: this.seq, truncated: a > 0 && this.lines.length > 0 && this.lines[0].seq > a + 1 };
  }
}

/** The environment a strategy process gets: only what Python needs, never the Bridge's own secrets. */
export const ENV_KEEP = Object.freeze(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "VIRTUAL_ENV", "PYTHONHOME"]);

/** @param {Record<string, string|undefined>} parent @param {Record<string, string>} extra */
export function childEnv(parent, extra) {
  const env = {};
  for (const k of ENV_KEEP) if (typeof parent[k] === "string") env[k] = parent[k];
  return { ...env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", ...extra };
}
