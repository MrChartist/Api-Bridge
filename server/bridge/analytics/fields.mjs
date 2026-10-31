/**
 * Bloomberg-style data access over what the Bridge already has — stream S15 (docs: fields.openapi.yaml, tag "Analytics").
 * Read-only: every call goes through deps.marketData, nothing here can place an order.
 *
 *   GET  /v1/fields/search?q=&category=[&limit=][&format=csv]              ranked match over id, aliases, description (FLDS)
 *   GET  /v1/fields?symbols=A,B&fields=ltp,oi,iv[&override=expiry:2026-11-27,rate:6.5]   symbol x field grid (BDP)
 *   GET  /v1/fields/history?symbols=&fields=close,volume&from=&to=&period=D|W|M&fill=prev|none   (BDH)
 *   GET  /v1/fields/bulk?symbol=NIFTY&field=CHAIN|EXPIRIES[&expiry=][&strikes=]   (BDS)
 *   POST /v1/batch  { requests: [{ id, path, query }] }                     up to 20 allow-listed GETs in one call
 *
 * Every GET also takes format=csv (core/http.mjs csv()), plus the usual account, maxAgeMs and backup.
 *
 * A grid never fails because one cell cannot be filled: the cell is null and `errors` says why (code, symbol, field).
 * Only a request that is itself wrong (an unknown field id, too many symbols, a bad date) is a 400.
 *
 * Batching: BDP asks marketData for all quotes in ONE quotes() call, one optionChain() per distinct (underlying,
 * expiry) and one expiries() per underlying that needs its nearest expiry, all in parallel. A cash symbol asking for a
 * chain field with no expiry takes a second round (expiries first, then the chain).
 *
 * /v1/batch dispatches in-process to the handlers of the field routes, /v1/quotes, /v1/ltp and the core
 * /v1/analytics/{oi,gex,skew,surface,basis,greeks} routes. app.router is not reachable from a module's deps, so other
 * /v1/analytics/* feature routes pass the path allow-list but answer 404 per item ("call it directly").
 */
import { BridgeError, ERROR_CODES } from "../core/errors.mjs";
import { csv } from "../core/http.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { daysBetween, computeIVAndGreeks } from "../../lib/blackScholes.mjs";
import { defaultOptionExchange } from "../market/chain.mjs";
import { createMarketRoutes, autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { istDate } from "../market/time.mjs";
import { createAnalyticsRoutes } from "./routes.mjs";
import { ivSkew, nowMsOf, oiAnalysis, upcomingExpiries } from "./math.mjs";
import { FIELDS, FIELD_CATALOGUE_VERSION, FIELD_CATEGORIES } from "./fieldCatalogue.mjs";

export const MAX_GRID_SYMBOLS = 50;
export const MAX_GRID_FIELDS = 20;
export const MAX_HISTORY_SYMBOLS = 10;
export const MAX_BATCH = 20;
/** History range cap: about ten years of calendar days, so a request is at most this many daily bars per symbol. */
export const MAX_HISTORY_DAYS = 3660;
const CONCURRENCY = 4;
const SEARCH_LIMIT = 25;

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const round = (v, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const KIND_KEY = Object.freeze({ EQ: "equity", INDEX: "index", FUT: "future", OPT: "option" });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function dateParam(q, name, { required = false } = {}) {
  const v = opt(q, name);
  if (v === undefined) {
    if (required) throw invalid(name, `${name} is required as YYYY-MM-DD.`);
    return undefined;
  }
  if (!isRealDate(v)) throw invalid(name, `${name} must be a real date as YYYY-MM-DD.`);
  return v;
}

function formatParam(q) {
  const f = (opt(q, "format") ?? "json").toLowerCase();
  if (f !== "json" && f !== "csv") throw invalid("format", "format must be json or csv.");
  return f;
}

function intParam(q, name, min, max, dflt) {
  const v = opt(q, name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw invalid(name, `${name} must be a whole number from ${min} to ${max}.`);
  return Number(v);
}

// ── field lookup and search ─────────────────────────────────────────────────

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const NAME_INDEX = (() => {
  const m = new Map();
  for (const f of FIELDS) m.set(f.id, f);
  for (const f of FIELDS) for (const a of f.aliases) if (!m.has(norm(a))) m.set(norm(a), f);
  return m;
})();

/** Rank catalogue fields for a query: exact id, alias, prefix, substring, then words in the description. */
export function searchFields(q, { category, limit = SEARCH_LIMIT } = {}) {
  const needle = norm(q);
  const tokens = needle.split(/[\s,]+/).filter(Boolean);
  const pool = category ? FIELDS.filter((f) => f.category === category) : FIELDS;
  if (!needle) return pool.slice(0, limit).map((f) => ({ ...f, score: 0 }));
  const scored = [];
  for (const f of pool) {
    const id = f.id;
    const aliases = f.aliases.map(norm);
    const desc = norm(f.description);
    let s = 0;
    if (id === needle) s = 100;
    else if (aliases.includes(needle)) s = 90;
    else if (id.startsWith(needle)) s = 80;
    else if (aliases.some((a) => a.startsWith(needle))) s = 70;
    else if (id.includes(needle)) s = 60;
    else if (aliases.some((a) => a.includes(needle))) s = 50;
    let words = 0;
    for (const t of tokens) {
      if (id.includes(t) || aliases.some((a) => a.includes(t))) words += 2;
      else if (desc.includes(t)) words += 1;
    }
    if (s === 0 && words === 0) continue;
    if (s === 0) s = 10;
    scored.push({ ...f, score: s + words * 3 });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Resolve a field id or alias ("open interest") to its catalogue entry, or null. */
export const resolveField = (name) => NAME_INDEX.get(norm(name)) ?? null;

function parseFieldList(raw, { max = MAX_GRID_FIELDS } = {}) {
  const names = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw invalid("fields", "fields is required: a comma-separated list such as ltp,oi,iv. Search them with /v1/fields/search.");
  const out = [];
  for (const n of names) {
    const f = resolveField(n);
    if (!f) {
      const near = searchFields(n, { limit: 3 }).map((x) => x.id);
      throw invalid("fields", `Unknown field "${n}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} Search them with /v1/fields/search.`);
    }
    if (!out.includes(f)) out.push(f);
  }
  if (out.length > max) throw invalid("fields", `Ask for at most ${max} fields at a time.`);
  return out;
}

function parseSymbols(raw, max) {
  const seen = new Set();
  const list = [];
  for (const s of String(raw ?? "").split(",")) {
    const t = s.trim();
    if (t && !seen.has(t.toUpperCase())) {
      seen.add(t.toUpperCase());
      list.push(t);
    }
  }
  if (!list.length) throw invalid("symbols", "symbols is required: a comma-separated list such as NSE:NIFTY,NSE:RELIANCE.");
  if (list.length > max) throw invalid("symbols", `Ask for at most ${max} symbols at a time.`);
  return list;
}

/** `expiry:2026-11-27,rate:6.5` -> { expiry, rate }. Only these two keys. */
export function parseOverride(raw) {
  const out = {};
  if (raw === undefined || raw === "") return out;
  for (const part of String(raw).split(",")) {
    const i = part.indexOf(":");
    const k = i < 0 ? "" : part.slice(0, i).trim().toLowerCase();
    const v = i < 0 ? "" : part.slice(i + 1).trim();
    if (k === "expiry") {
      if (!isRealDate(v)) throw invalid("override", "override expiry must be a date as expiry:YYYY-MM-DD.");
      out.expiry = v;
    } else if (k === "rate") {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n) || n < 0 || n > 100) throw invalid("override", "override rate must be a percent from 0 to 100, as rate:6.5.");
      out.rate = n;
    } else {
      throw invalid("override", `Unknown override "${part}". Use expiry:YYYY-MM-DD and rate:PERCENT, separated by commas.`);
    }
  }
  return out;
}

/** Run async jobs a few at a time. */
async function pool(jobs, n = CONCURRENCY) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

const settle = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e };
  }
};
/** History is not served from a max-age cache window: drop maxAgeMs. */
const noAge = (opts) => {
  const { maxAgeMs, ...rest } = opts;
  void maxAgeMs;
  return rest;
};
const codeOf = (e) => (e instanceof BridgeError ? e.code : "INTERNAL");
const textOf = (e) => (e instanceof BridgeError ? e.detail : "Unexpected error.");

// ── BDP grid ────────────────────────────────────────────────────────────────

/**
 * Fill a symbol x field grid. Exposed for tests and for other modules.
 * @param {{ md: object, opts: object, nowMs: number }} env
 * @param {string[]} symbols
 * @param {object[]} fields catalogue entries
 * @param {{ expiry?: string, rate?: number }} override
 */
export async function buildGrid(env, symbols, fields, override = {}) {
  const { md, opts, nowMs } = env;
  const errors = [];
  const fail = (symbol, field, code, message) => errors.push({ symbol, field, code, message });
  const rows = [];
  const items = [];

  for (const input of symbols) {
    const row = { symbol: input, values: Object.fromEntries(fields.map((f) => [f.id, null])), freshness: null };
    rows.push(row);
    let parts;
    try {
      parts = parseSymbol(input);
    } catch (e) {
      for (const f of fields) fail(input, f.id, codeOf(e), textOf(e));
      continue;
    }
    row.symbol = parts.canonical;
    const kind = KIND_KEY[parts.kind] ?? "equity";
    const item = { row, parts, kind, needs: [] };
    items.push(item);
    for (const f of fields) {
      if (!f.applies_to.includes(kind)) fail(parts.canonical, f.id, "FIELD_NOT_APPLICABLE", `${f.id} applies to ${f.applies_to.join(", ")} symbols, not ${kind}.`);
      else item.needs.push(f);
    }
  }

  // What to fetch.
  const quoteSyms = new Set();
  const expiryUnderlyings = new Set();
  const vwapSyms = new Set();
  const chainKeys = new Map(); // key -> { underlying, expiry }
  const spotOf = (parts) => `${defaultOptionExchange(parts.underlying) === "BFO" ? "BSE" : "NSE"}:${parts.underlying}`;
  const chainKey = (u, e) => `${u}|${e}`;
  const wantChain = (u, e) => chainKeys.set(chainKey(u, e), { underlying: u, expiry: e });
  /** Expiry for a chain-sourced field of this symbol, or null when the nearest listed one must be looked up. */
  const expiryFor = (item, f) => (f.override && override.expiry) || item.parts.expiry || null;

  for (const item of items) {
    const { parts } = item;
    for (const f of item.needs) {
      const k = f.source.kind;
      if (k === "quote") quoteSyms.add(parts.canonical);
      else if (k === "basis") {
        quoteSyms.add(parts.canonical);
        if (parts.exchange === "NFO" || parts.exchange === "BFO") quoteSyms.add(spotOf(parts));
      } else if (k === "vwap") vwapSyms.add(parts.canonical);
      else if (k === "expiries") expiryUnderlyings.add(parts.underlying);
      else if (k === "leg" || k === "chain" || k === "lot") {
        const e = expiryFor(item, f);
        if (e) wantChain(parts.underlying, e);
        else expiryUnderlyings.add(parts.underlying);
      }
    }
  }

  // Round A: everything whose parameters are already known, in parallel.
  const quoteJob = quoteSyms.size ? settle(() => md.quotes([...quoteSyms], opts)) : null;
  const expiryJobs = new Map([...expiryUnderlyings].map((u) => [u, settle(() => md.expiries(u, opts))]));
  const chainJobs = new Map();
  const startChain = (key, { underlying, expiry }) => {
    if (!chainJobs.has(key)) chainJobs.set(key, settle(() => md.optionChain({ underlying, expiry, greeks: true }, opts)));
  };
  for (const [key, v] of chainKeys) startChain(key, v);
  const today = istDate(nowMs);
  const vwapJob = vwapSyms.size
    ? pool([...vwapSyms].map((s) => async () => [s, await settle(() => md.history({ symbol: s, interval: "5m", from: today }, noAge(opts)))]))
    : null;

  const quotesRes = quoteJob ? await quoteJob : null;
  const expiryRes = new Map();
  for (const [u, p] of expiryJobs) expiryRes.set(u, await p);

  // Round B: chains for cash symbols whose nearest expiry just came back.
  const nearest = new Map();
  for (const [u, r] of expiryRes) if (r.ok) nearest.set(u, upcomingExpiries(r.value.expiries, nowMs)[0] ?? null);
  for (const item of items) {
    for (const f of item.needs) {
      if (!["leg", "chain", "lot"].includes(f.source.kind) || expiryFor(item, f)) continue;
      const e = nearest.get(item.parts.underlying);
      if (e) startChain(chainKey(item.parts.underlying, e), { underlying: item.parts.underlying, expiry: e });
    }
  }
  const chainRes = new Map();
  for (const [key, p] of chainJobs) chainRes.set(key, await p);
  const vwapRes = new Map(vwapJob ? await vwapJob : []);

  const quoteBySym = new Map();
  const quoteErr = new Map();
  if (quotesRes?.ok) {
    for (const q of quotesRes.value.items) quoteBySym.set(q.symbol, q);
    for (const e of quotesRes.value.errors ?? []) quoteErr.set(e.symbol, e);
  }
  const quoteProblem = (symbol) => {
    if (quotesRes && !quotesRes.ok) return { code: codeOf(quotesRes.error), message: textOf(quotesRes.error) };
    const e = quoteErr.get(symbol);
    if (e) return { code: e.code ?? "UPSTREAM_ERROR", message: e.message ?? "No quote." };
    return quoteBySym.has(symbol) ? null : { code: "SYMBOL_NOT_FOUND", message: `No quote came back for ${symbol}.` };
  };

  const days = (expiry) => daysBetween(new Date(nowMs), expiry);

  for (const item of items) {
    const { parts, row } = item;
    const sym = parts.canonical;
    const set = (f, v) => {
      row.values[f.id] = v ?? null;
    };
    for (const f of item.needs) {
      const src = f.source;
      const bad = (code, message) => fail(sym, f.id, code, message);
      switch (src.kind) {
        case "quote": {
          const p = quoteProblem(sym);
          if (p) {
            bad(p.code, p.message);
            break;
          }
          const q = quoteBySym.get(sym);
          row.freshness ??= q.freshness ?? null;
          set(f, q[src.field]);
          break;
        }
        case "symbol":
          set(f, src.field === "kind" ? parts.kind : parts[src.field]);
          break;
        case "days":
          set(f, round(days(parts.expiry), 2));
          break;
        case "basis": {
          if (parts.exchange !== "NFO" && parts.exchange !== "BFO") {
            bad("FIELD_NOT_APPLICABLE", `basis needs a cash price to compare with; ${parts.exchange} futures have none.`);
            break;
          }
          const fp = quoteProblem(sym) ?? null;
          const sp = quoteProblem(spotOf(parts));
          if (fp || sp) {
            const p = fp ?? sp;
            bad(p.code, `${fp ? "Future" : `Spot ${spotOf(parts)}`}: ${p.message}`);
            break;
          }
          const fq = quoteBySym.get(sym);
          const spot = quoteBySym.get(spotOf(parts)).ltp;
          row.freshness ??= fq.freshness ?? null;
          set(f, f.id === "basis" ? round(fq.ltp - spot, 4) : round(((fq.ltp - spot) / spot) * 100, 4));
          break;
        }
        case "expiries": {
          const r = expiryRes.get(parts.underlying);
          if (!r.ok) bad(codeOf(r.error), textOf(r.error));
          else if (!nearest.get(parts.underlying)) bad("NO_DATA", `No upcoming expiry is listed for ${parts.underlying}.`);
          else set(f, nearest.get(parts.underlying));
          break;
        }
        case "vwap": {
          const r = vwapRes.get(sym);
          if (!r?.ok) {
            bad(r ? codeOf(r.error) : "INTERNAL", r ? textOf(r.error) : "No history.");
            break;
          }
          let pv = 0;
          let vol = 0;
          for (const c of r.value.candles ?? []) {
            const v = Number(c.volume) || 0;
            pv += ((c.high + c.low + c.close) / 3) * v;
            vol += v;
          }
          if (vol > 0) set(f, round(pv / vol, 4));
          else bad("NO_DATA", "No traded volume in today's candles yet.");
          break;
        }
        case "leg":
        case "chain":
        case "lot": {
          // A symbol's own expiry, or the override, or the nearest listed one.
          let expiry = expiryFor(item, f);
          if (!expiry) {
            const r = expiryRes.get(parts.underlying);
            if (!r?.ok) {
              bad(r ? codeOf(r.error) : "INTERNAL", r ? textOf(r.error) : "No expiries.");
              break;
            }
            expiry = nearest.get(parts.underlying);
            if (!expiry) {
              bad("NO_DATA", `No upcoming expiry is listed for ${parts.underlying}.`);
              break;
            }
          }
          const r = chainRes.get(chainKey(parts.underlying, expiry));
          if (!r?.ok) {
            bad(r ? codeOf(r.error) : "INTERNAL", `Chain ${parts.underlying} ${expiry}: ${r ? textOf(r.error) : "not fetched."}`);
            break;
          }
          const chain = r.value;
          row.freshness ??= chain.freshness ?? null;
          if (src.kind === "lot") {
            if (chain.lotSize == null) bad("NO_DATA", "The chain did not carry a lot size.");
            else set(f, chain.lotSize);
          } else if (src.kind === "chain") {
            const v = src.field === "atm_iv" ? ivSkew(chain).atmIv : src.field === "max_pain" ? oiAnalysis(chain).maxPain : oiAnalysis(chain)[src.field === "pcr_oi" ? "pcrOi" : "pcrVolume"];
            if (v == null) bad("NO_DATA", `${f.id} cannot be computed for ${parts.underlying} ${expiry} (no usable rows).`);
            else set(f, v);
          } else {
            const r0 = chain.rows.find((x) => x.strike === parts.strike);
            const l = r0?.[parts.right === "CE" ? "ce" : "pe"];
            if (!l) {
              bad("SYMBOL_NOT_FOUND", `Strike ${parts.strike} ${parts.right} is not in the ${expiry} chain.`);
              break;
            }
            if (override.rate !== undefined && f.override) {
              if (!(l.ltp > 0) || !(chain.underlyingLtp > 0)) {
                bad("NO_DATA", "A rate override needs the option's price and the underlying's price.");
                break;
              }
              const g = computeIVAndGreeks({ ltp: l.ltp, spot: chain.underlyingLtp, strike: parts.strike, daysToExpiry: Math.max(days(expiry), 0), type: parts.right, rate: override.rate / 100 });
              if (!(g.iv > 0)) {
                bad("NO_DATA", "That price cannot be explained by any volatility below 500 % at this rate.");
                break;
              }
              set(f, round(g[f.id], 4));
            } else if (l[src.field] == null) {
              bad("NO_DATA", `The ${src.field} is not available for this option right now.`);
            } else set(f, l[src.field]);
          }
          break;
        }
        default:
          bad("INTERNAL", `Unhandled source ${src.kind}.`);
      }
    }
  }
  return { rows, errors };
}

// ── BDH helpers ─────────────────────────────────────────────────────────────

const addDays = (date, n) => new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const weekStart = (date) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const periodKey = (date, period) => (period === "W" ? weekStart(date) : period === "M" ? date.slice(0, 7) : date);
const periodEnd = (key, period) => {
  if (period === "W") return addDays(key, 6);
  if (period === "M") return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return key;
};

/** Daily candles -> one bar per period. `date` is the last trading day in the period. */
export function aggregatePeriods(candles, period) {
  const groups = new Map();
  for (const c of [...candles].sort((a, b) => a.time - b.time)) {
    const date = istDate(c.time * 1000);
    const key = periodKey(date, period);
    const g = groups.get(key);
    if (!g) groups.set(key, { key, date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, oi: c.oi ?? null });
    else {
      g.date = date;
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume ?? 0;
      if (c.oi != null) g.oi = c.oi;
    }
  }
  return [...groups.values()];
}

/** Add one row per calendar period with no bar, carrying prices and OI forward (volume 0). Starts at the first bar. */
export function fillPrevious(bars, period, to) {
  if (!bars.length) return [];
  const byKey = new Map(bars.map((b) => [b.key, b]));
  const out = [];
  let prev = null;
  let key = bars[0].key;
  const step = (k) => (period === "M" ? new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 1)).toISOString().slice(0, 7) : addDays(k, period === "W" ? 7 : 1));
  const last = periodKey(to, period);
  for (let guard = 0; key <= last && guard < 5000; guard += 1, key = step(key)) {
    const b = byKey.get(key);
    if (b) {
      out.push(b);
      prev = b;
    } else if (prev) out.push({ key, date: periodEnd(key, period), open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0, oi: prev.oi, filled: true });
  }
  return out;
}

function historyValue(bar, prevBar, id) {
  switch (id) {
    case "open": case "high": case "low": case "close": case "volume": case "oi":
      return bar[id] ?? null;
    case "prev_close":
      return prevBar ? prevBar.close : null;
    case "change":
      return prevBar && !bar.filled ? round(bar.close - prevBar.close, 4) : null;
    case "change_pct":
      return prevBar && !bar.filled && prevBar.close ? round(((bar.close - prevBar.close) / prevBar.close) * 100, 4) : null;
    default:
      return null;
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

const PROBLEM_TYPE = "https://docs.mrchartist.com/errors/";
function problemBody(err, requestId) {
  const be = err instanceof BridgeError ? err : new BridgeError("INTERNAL", "Unexpected error.");
  const spec = ERROR_CODES[be.code];
  return { type: `${PROBLEM_TYPE}${be.code}`, title: spec?.title ?? "Error", status: be.status, detail: be.detail, code: be.code, retryable: be.retryable, requestId, ...(be.errors ? { errors: be.errors } : {}) };
}

const BATCH_PATH = /^\/v1\/(?:fields(?:\/(?:search|history|bulk))?|quotes|ltp|analytics\/[a-z0-9-]+)$/;

/** @param {object} deps full deps passed to register() */
export function fieldsRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const meta = (ctx, opts, extra = {}) => ({ requestId: ctx.requestId, accountId: opts?.accountId ?? null, catalogueVersion: FIELD_CATALOGUE_VERSION, ...extra });
  const field = (f) => ({ id: f.id, dataType: f.dataType, unit: f.unit, cadence: f.cadence });

  async function search(ctx) {
    const q = ctx.query;
    const format = formatParam(q);
    const category = opt(q, "category")?.toLowerCase();
    if (category !== undefined && !FIELD_CATEGORIES.includes(category)) throw invalid("category", `category must be one of ${FIELD_CATEGORIES.join(", ")}.`);
    const limit = intParam(q, "limit", 1, 100, SEARCH_LIMIT);
    const found = searchFields(opt(q, "q") ?? "", { category, limit });
    if (format === "csv") {
      const head = ["id", "category", "dataType", "unit", "cadence", "applies_to", "aliases", "description", "excelCall"];
      return csv([head, ...found.map((f) => [f.id, f.category, f.dataType, f.unit, f.cadence, f.applies_to.join("|"), f.aliases.join("|"), f.description, f.excelCall])], { filename: "fields.csv" });
    }
    return { data: { version: FIELD_CATALOGUE_VERSION, categories: FIELD_CATEGORIES, count: found.length, fields: found }, meta: meta(ctx, null) };
  }

  async function bdp(ctx) {
    const q = ctx.query;
    const format = formatParam(q);
    const symbols = parseSymbols(q.get("symbols"), MAX_GRID_SYMBOLS);
    const fields = parseFieldList(q.get("fields"));
    const override = parseOverride(opt(q, "override"));
    const opts = readOptions(ctx);
    const { rows, errors } = await buildGrid({ md: md(), opts, nowMs: nowMsOf(deps) }, symbols, fields, override);
    if (format === "csv") return csv([["symbol", ...fields.map((f) => f.id)], ...rows.map((r) => [r.symbol, ...fields.map((f) => r.values[f.id])])], { filename: "fields.csv", headers: { "X-MCB-Errors": String(errors.length) } });
    return { data: { fields: fields.map(field), rows }, errors, meta: meta(ctx, opts, Object.keys(override).length ? { overrides: override } : {}) };
  }

  async function bdh(ctx) {
    const q = ctx.query;
    const format = formatParam(q);
    const symbols = parseSymbols(q.get("symbols"), MAX_HISTORY_SYMBOLS);
    const fields = parseFieldList(q.get("fields") ?? "close");
    const period = (opt(q, "period") ?? "D").toUpperCase();
    if (!["D", "W", "M"].includes(period)) throw invalid("period", "period must be D, W or M.");
    const fill = (opt(q, "fill") ?? "none").toLowerCase();
    if (fill !== "prev" && fill !== "none") throw invalid("fill", "fill must be prev or none.");
    const from = dateParam(q, "from", { required: true });
    const today = istDate(nowMsOf(deps));
    const to = dateParam(q, "to") ?? today;
    if (from > to) throw invalid("from", "from must not be after to.");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_HISTORY_DAYS) throw invalid("to", `Ask for at most ${MAX_HISTORY_DAYS} days at a time.`);
    const opts = readOptions(ctx);
    const errors = [];
    const usable = [];
    for (const f of fields) {
      if (f.history) usable.push(f);
      else for (const s of symbols) errors.push({ symbol: s, field: f.id, code: "FIELD_NOT_HISTORICAL", message: `${f.id} has no history; /v1/fields/history serves ${FIELDS.filter((x) => x.history).map((x) => x.id).join(", ")}.` });
    }
    const series = await pool(
      symbols.map((input) => async () => {
        let parts;
        try {
          parts = parseSymbol(input);
        } catch (e) {
          errors.push({ symbol: input, field: null, code: codeOf(e), message: textOf(e) });
          return { symbol: input, rows: [], count: 0, freshness: null };
        }
        const kind = KIND_KEY[parts.kind];
        const ok = usable.filter((f) => f.applies_to.includes(kind));
        for (const f of usable) if (!ok.includes(f)) errors.push({ symbol: parts.canonical, field: f.id, code: "FIELD_NOT_APPLICABLE", message: `${f.id} applies to ${f.applies_to.join(", ")} symbols, not ${kind}.` });
        const r = await settle(() => md().history({ symbol: parts.canonical, interval: "1d", from, to }, noAge(opts)));
        if (!r.ok) {
          errors.push({ symbol: parts.canonical, field: null, code: codeOf(r.error), message: textOf(r.error) });
          return { symbol: parts.canonical, rows: [], count: 0, freshness: null };
        }
        let bars = aggregatePeriods(r.value.candles ?? [], period);
        if (fill === "prev") bars = fillPrevious(bars, period, to);
        const rows = bars.map((b, i) => {
          const row = { date: b.date };
          for (const f of usable) row[f.id] = ok.includes(f) ? historyValue(b, bars[i - 1] ?? null, f.id) : null;
          if (b.filled) row.filled = true;
          return row;
        });
        return { symbol: parts.canonical, rows, count: rows.length, partial: Boolean(r.value.partial), freshness: r.value.freshness ?? null };
      }),
    );
    if (format === "csv") {
      const ids = usable.map((f) => f.id);
      return csv([["symbol", "date", ...ids], ...series.flatMap((s) => s.rows.map((r) => [s.symbol, r.date, ...ids.map((id) => r[id])]))], { filename: "fields_history.csv", headers: { "X-MCB-Errors": String(errors.length) } });
    }
    return { data: { period, fill, from, to, fields: usable.map(field), series }, errors, meta: meta(ctx, opts) };
  }

  async function bulk(ctx) {
    const q = ctx.query;
    const format = formatParam(q);
    const raw = opt(q, "symbol");
    if (!raw) throw invalid("symbol", "symbol is required, for example NIFTY.");
    const underlying = (raw.includes(":") ? raw.split(":")[1] : raw).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9&_-]{0,29}$/.test(underlying)) throw invalid("symbol", "symbol must be an underlying name such as NIFTY or NSE:NIFTY.");
    const which = (opt(q, "field") ?? "").toUpperCase();
    if (which !== "CHAIN" && which !== "EXPIRIES") throw invalid("field", "field must be CHAIN or EXPIRIES.");
    const opts = readOptions(ctx);
    if (which === "EXPIRIES") {
      const r = await md().expiries(underlying, opts);
      const nowMs = nowMsOf(deps);
      const rows = r.expiries.map((expiry) => ({ expiry, days_to_expiry: round(daysBetween(new Date(nowMs), expiry), 2) }));
      if (format === "csv") return csv([["expiry", "days_to_expiry"], ...rows.map((x) => [x.expiry, x.days_to_expiry])], { filename: `${underlying}_expiries.csv` });
      return { data: { underlying, field: "EXPIRIES", columns: ["expiry", "days_to_expiry"], rows }, meta: meta(ctx, opts, { freshness: r.freshness }) };
    }
    const expiry = dateParam(q, "expiry", { required: true });
    const params = { underlying, expiry, greeks: (opt(q, "greeks") ?? "true") !== "false" };
    const strikes = intParam(q, "strikes", 1, 100, undefined);
    if (strikes !== undefined) params.strikes = strikes;
    const c = await md().optionChain(params, opts);
    const cols = ["ltp", "bid", "ask", "oi", "oiChange", "volume", "iv", "delta", "gamma", "theta", "vega"];
    const columns = ["strike", ...["ce", "pe"].flatMap((s) => cols.map((k) => `${s}_${k}`))];
    const rows = c.rows.map((r) => Object.fromEntries([["strike", r.strike], ...["ce", "pe"].flatMap((s) => cols.map((k) => [`${s}_${k}`, r[s]?.[k] ?? null]))]));
    if (format === "csv") return csv([columns, ...rows.map((r) => columns.map((k) => r[k]))], { filename: `${underlying}_${expiry}_chain.csv` });
    return { data: { underlying, expiry, field: "CHAIN", underlyingLtp: c.underlyingLtp ?? null, atmStrike: c.atmStrike ?? null, lotSize: c.lotSize ?? null, columns, rows }, meta: meta(ctx, opts, { freshness: c.freshness }) };
  }

  // ── POST /v1/batch ──
  let table = null;
  const dispatchTable = () => {
    if (table) return table;
    const market = createMarketRoutes(deps);
    const an = createAnalyticsRoutes(deps);
    table = new Map([
      ["/v1/fields", bdp],
      ["/v1/fields/search", search],
      ["/v1/fields/history", bdh],
      ["/v1/fields/bulk", bulk],
      ["/v1/quotes", market.quotes],
      ["/v1/ltp", market.ltp],
      ...["oi", "gex", "skew", "surface", "basis", "greeks"].map((n) => [`/v1/analytics/${n}`, an[n]]),
    ]);
    return table;
  };

  function toQuery(path, query) {
    let url;
    try {
      url = new URL(path, "http://bridge.local");
    } catch {
      throw invalid("path", "path is not a valid URL path.");
    }
    const sp = new URLSearchParams(url.search);
    if (query !== undefined && query !== null) {
      if (typeof query !== "object" || Array.isArray(query)) throw invalid("query", "query must be an object of strings.");
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (typeof v === "object" && !Array.isArray(v)) throw invalid(`query.${k}`, "query values must be strings, numbers, booleans or arrays of them.");
        sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
      }
    }
    return { pathname: url.pathname, sp };
  }

  async function runOne(ctx, item) {
    const id = item.id;
    try {
      if (typeof item.path !== "string") throw invalid("path", "path is required.");
      const { pathname, sp } = toQuery(item.path, item.query);
      if (!BATCH_PATH.test(pathname)) throw invalid("path", "path is not allowed in a batch. Use GET /v1/fields*, /v1/quotes, /v1/ltp or /v1/analytics/*.");
      const handler = dispatchTable().get(pathname);
      if (!handler) throw new BridgeError("NOT_FOUND", `${pathname} cannot be run inside a batch yet. Call it directly.`);
      const sub = Object.create(ctx, { query: { value: sp }, body: { value: undefined }, method: { value: "GET" } });
      const res = await handler(sub);
      if (res && typeof res.status === "number" && "body" in res) {
        const type = res.headers?.["Content-Type"] ?? "";
        return { id, status: res.status, ...(type.startsWith("application/json") ? { body: JSON.parse(res.body) } : { contentType: type, body: String(res.body) }) };
      }
      return { id, status: 200, body: res };
    } catch (err) {
      const body = problemBody(err, ctx.requestId);
      return { id, status: body.status, body };
    }
  }

  async function batch(ctx) {
    const raw = ctx.body;
    const list = Array.isArray(raw) ? raw : raw?.requests;
    if (!Array.isArray(list) || !list.length) throw invalid("requests", "Send { requests: [{ id, path, query }] } with at least one request.");
    if (list.length > MAX_BATCH) throw invalid("requests", `Send at most ${MAX_BATCH} requests in a batch.`);
    const ids = new Set();
    list.forEach((r, i) => {
      if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || r.id.length > 64) throw invalid(`requests.${i}.id`, "Each request needs an id: a string of 1 to 64 characters.");
      if (ids.has(r.id)) throw invalid(`requests.${i}.id`, `id "${r.id}" is used twice.`);
      ids.add(r.id);
    });
    const results = await pool(list.map((item) => () => runOne(ctx, item)));
    return { data: { results }, meta: { requestId: ctx.requestId } };
  }

  return [
    ["GET", "/v1/fields/search", { scope: "read" }, search],
    ["GET", "/v1/fields", { scope: "read" }, bdp],
    ["GET", "/v1/fields/history", { scope: "read" }, bdh],
    ["GET", "/v1/fields/bulk", { scope: "read" }, bulk],
    ["POST", "/v1/batch", { scope: "read" }, batch],
  ];
}
