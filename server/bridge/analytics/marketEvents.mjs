/**
 * India market-events analytics — stream S15, read scope, no broker account. India analogues of Unusual Whales'
 * dark pool, congress/insider trades and earnings calendar, from NSE's public site.
 *
 *   GET /v1/analytics/deals?kind=block|bulk[&days=5][&symbol=][&minValue=]   block / bulk deals, top buyers and sellers
 *   GET /v1/analytics/insiders[?symbol=][&days=30]                           SEBI PIT insider disclosures, net buying
 *   GET /v1/analytics/events[?symbol=][&days=14]                             board meetings / results / events by day
 *
 * NSE endpoints (ASSUMED from NSE site knowledge, NOT verified from a live session; each is isolated in one mapper):
 *   block  /api/historical/block-deals?from=dd-mm-yyyy&to=dd-mm-yyyy[&symbol=]   -> { data: [{ BD_DT_DATE, BD_SYMBOL, BD_SCRIP_NAME, BD_CLIENT_NAME, BD_BUY_SELL, BD_QTY_TRD, BD_TP_WATP }] }
 *   bulk   /api/historical/bulk-deals?from=...&to=...[&symbol=]                  -> same shape
 *   pit    /api/corporates-pit?index=equities&from_date=...&to_date=...[&symbol=] -> { data: [{ symbol, company, acqName, personCategory, secType, secAcq, secVal, tdpTransactionType, acqMode, date }] }
 *   events /api/event-calendar?index=equities&from_date=...&to_date=...[&symbol=] -> [{ symbol, company, purpose, bm_desc, date }]
 * The snapshot shape (/api/snapshot-capital-market-largedeal: BLOCK_DEALS_DATA / BULK_DEALS_DATA with qty, watp) is
 * also tolerated by the deals mapper. A payload whose shape does not match raises UPSTREAM_ERROR.
 *
 * Same machinery as flows.mjs: cookie-primed createHttpClient, injected fetcher, per-query TTL cache with in-flight
 * dedupe, stale-serve when a refresh fails, and (when deps.paths.dataDir is set) lazy load / atomic 0600 save of the
 * last good result per query to <dataDir>/analytics/market-events.json (corrupt file moved aside, disk errors logged only).
 * Values are INR crore (quantity x price / 1e7; PIT secVal is rupees / 1e7).
 *
 * deps (all optional): marketEventsFetcher: async (kind, {from, to, symbol}) => json, with kind block|bulk|pit|events
 * (tests inject this), fetchImpl, clock, config.backup.timeoutMs, paths.dataDir, logger.
 */
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createHttpClient } from "../backup/httpClient.mjs";
import { NSE_BASE, nseDateToIso } from "../backup/providers/nse.mjs";

export const CACHE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 50;
const MAX_ROWS = 500;
const TOP_N = 5;
const IST_OFFSET_MS = 5.5 * 3600_000;
const CRORE = 1e7;
const LIMITS = Object.freeze({ deals: { def: 5, max: 90 }, insiders: { def: 30, max: 90 }, events: { def: 14, max: 60 } });

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const bad = (what) => new BridgeError("UPSTREAM_ERROR", `NSE answered the ${what} request with an unexpected shape.`);
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" || s === "-" ? null : s;
};
const pick = (row, ...keys) => {
  for (const k of keys) if (row?.[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  return null;
};
/** "30-Oct-2026", "30-Oct-2026 14:05:00" or "2026-10-30" -> "2026-10-30"; null otherwise. */
const isoDate = (v) => {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return nseDateToIso(s.split(/\s+/)[0]);
};
const crore = (v) => (v === null ? null : r2(v / CRORE));

/** Safe lookup: scoped deps throw on undeclared keys. */
function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

/** Unwrap an array of rows from `json` or json.data (or one of `alts`); UPSTREAM_ERROR when there is none. */
function rowsOf(json, what, ...alts) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const k of ["data", ...alts]) if (Array.isArray(json[k])) return json[k];
  }
  throw bad(what);
}

/** Every row dropped though input was not empty means the field names changed. */
function checked(out, input, what) {
  if (input.length && !out.length) throw new BridgeError("UPSTREAM_ERROR", `NSE returned ${what} rows with no recognisable fields.`);
  return out;
}

/** Raw block / bulk deals payload -> [{ date, symbol, name, client, side, quantity, price, valueCr }]. */
export function mapDeals(json) {
  let input;
  if (json && !Array.isArray(json) && !Array.isArray(json.data) && (Array.isArray(json.BLOCK_DEALS_DATA) || Array.isArray(json.BULK_DEALS_DATA))) {
    input = [...(json.BLOCK_DEALS_DATA ?? []), ...(json.BULK_DEALS_DATA ?? [])];
  } else input = rowsOf(json, "deals");
  const out = [];
  for (const r of input) {
    const symbol = str(pick(r, "BD_SYMBOL", "symbol"))?.toUpperCase() ?? null;
    const sideRaw = String(pick(r, "BD_BUY_SELL", "buySell", "buy_sell") ?? "").trim().toUpperCase();
    const side = sideRaw.startsWith("B") ? "BUY" : sideRaw.startsWith("S") ? "SELL" : null;
    const quantity = num(pick(r, "BD_QTY_TRD", "qty", "quantity"));
    const price = num(pick(r, "BD_TP_WATP", "watp", "price"));
    if (!symbol || !side || quantity === null) continue;
    out.push({
      date: isoDate(pick(r, "BD_DT_DATE", "date", "session")),
      symbol,
      name: str(pick(r, "BD_SCRIP_NAME", "name", "securityName")),
      client: str(pick(r, "BD_CLIENT_NAME", "clientName", "client")),
      side,
      quantity,
      price,
      valueCr: price === null ? null : r2((quantity * price) / CRORE),
    });
  }
  return checked(out, input, "deals");
}

/** Raw corporates-pit payload -> [{ date, symbol, company, person, category, direction, securityType, securities, valueCr, mode }]. */
export function mapInsiders(json) {
  const input = rowsOf(json, "insider-trading");
  const out = [];
  for (const r of input) {
    const symbol = str(r?.symbol)?.toUpperCase() ?? null;
    const t = String(pick(r, "tdpTransactionType", "transactionType") ?? "").trim().toLowerCase();
    const direction = /^(buy|acqui|purchase)/.test(t) ? "acquisition" : /^(sell|dispos)/.test(t) ? "disposal" : t ? "other" : null;
    if (!symbol || direction === null) continue;
    out.push({
      date: isoDate(pick(r, "date", "acqtoDt", "acqfromDt")),
      symbol,
      company: str(r.company),
      person: str(pick(r, "acqName", "person")),
      category: str(pick(r, "personCategory", "category")),
      direction,
      securityType: str(r.secType),
      securities: num(r.secAcq),
      valueCr: crore(num(r.secVal)),
      mode: str(pick(r, "acqMode", "mode")),
    });
  }
  return checked(out, input, "insider-trading");
}

/** Raw event-calendar payload -> [{ date, symbol, company, purpose, description }]. */
export function mapEvents(json) {
  const input = rowsOf(json, "event-calendar");
  const out = [];
  for (const r of input) {
    const symbol = str(r?.symbol)?.toUpperCase() ?? null;
    const date = isoDate(r?.date);
    if (!symbol || !date) continue;
    out.push({ date, symbol, company: str(r.company), purpose: str(r.purpose), description: str(pick(r, "bm_desc", "description")) });
  }
  return checked(out, input, "event-calendar");
}

const mappers = { block: mapDeals, bulk: mapDeals, pit: mapInsiders, events: mapEvents };

const byDateDesc = (a, b) => (a.date === b.date ? 0 : (a.date ?? "") < (b.date ?? "") ? 1 : -1);

/** Top buyers and sellers by client over deal rows. */
export function dealSummary(rows) {
  const agg = (side) => {
    const m = new Map();
    for (const r of rows) {
      if (r.side !== side) continue;
      const k = r.client ?? "(unknown)";
      const e = m.get(k) ?? { client: k, valueCr: 0, deals: 0 };
      e.valueCr += r.valueCr ?? 0;
      e.deals++;
      m.set(k, e);
    }
    return [...m.values()].map((e) => ({ ...e, valueCr: r2(e.valueCr) })).sort((a, b) => b.valueCr - a.valueCr || (a.client < b.client ? -1 : 1)).slice(0, TOP_N);
  };
  const sum = (side) => r2(rows.reduce((s, r) => s + (r.side === side ? r.valueCr ?? 0 : 0), 0));
  return { deals: rows.length, buyCr: sum("BUY"), sellCr: sum("SELL"), topBuyers: agg("BUY"), topSellers: agg("SELL") };
}

/** Net insider buying: acquisitions minus disposals (INR crore); other transaction kinds (pledge etc.) are counted apart. */
export function insiderSummary(rows) {
  let acq = 0;
  let disp = 0;
  let nA = 0;
  let nD = 0;
  let other = 0;
  const bySym = new Map();
  for (const r of rows) {
    if (r.direction === "other") {
      other++;
      continue;
    }
    const v = r.valueCr ?? 0;
    const s = r.direction === "acquisition" ? 1 : -1;
    if (s > 0) (acq += v, nA++);
    else (disp += v, nD++);
    bySym.set(r.symbol, (bySym.get(r.symbol) ?? 0) + s * v);
  }
  const net = r2(acq - disp);
  const syms = [...bySym].map(([symbol, v]) => ({ symbol, netCr: r2(v) }));
  return {
    acquisitionCr: r2(acq),
    disposalCr: r2(disp),
    netCr: net,
    acquisitions: nA,
    disposals: nD,
    other,
    bias: net > 0 ? "net buying" : net < 0 ? "net selling" : "flat",
    topNetBuyers: syms.filter((s) => s.netCr > 0).sort((a, b) => b.netCr - a.netCr || (a.symbol < b.symbol ? -1 : 1)).slice(0, TOP_N),
    topNetSellers: syms.filter((s) => s.netCr < 0).sort((a, b) => a.netCr - b.netCr || (a.symbol < b.symbol ? -1 : 1)).slice(0, TOP_N),
  };
}

/** Group events by date ascending (upcoming first). */
export function groupByDay(rows) {
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.date) ?? [];
    e.push({ symbol: r.symbol, company: r.company, purpose: r.purpose, description: r.description });
    m.set(r.date, e);
  }
  return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, events]) => ({ date, events: events.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)) }));
}

const PATHS = {
  block: (q) => `/api/historical/block-deals?${q({ from: "from", to: "to" })}`,
  bulk: (q) => `/api/historical/bulk-deals?${q({ from: "from", to: "to" })}`,
  pit: (q) => `/api/corporates-pit?index=equities&${q({ from: "from_date", to: "to_date" })}`,
  events: (q) => `/api/event-calendar?index=equities&${q({ from: "from_date", to: "to_date" })}`,
};
const REFERERS = { block: "/report-detail/display-bulk-and-block-deals", bulk: "/report-detail/display-bulk-and-block-deals", pit: "/companies-listing/corporate-filings-insider-trading", events: "/companies-listing/corporate-filings-event-calendar" };

/** Default fetcher: prime NSE cookies from the home page, then call the API. */
function defaultFetcher(deps) {
  const http = createHttpClient({
    fetchImpl: extra(deps, "fetchImpl") ?? globalThis.fetch,
    timeoutMs: extra(deps, "config")?.backup?.timeoutMs ?? 8000,
    provider: "NSE India",
  });
  return async (kind, { from, to, symbol }) => {
    if (!http.hasCookies()) await http.get(`${NSE_BASE}/`, { raw: true, headers: { Accept: "text/html" } });
    const q = (names) => {
      const p = new URLSearchParams({ [names.from]: ddmmyyyy(from), [names.to]: ddmmyyyy(to) });
      if (symbol) p.set("symbol", symbol);
      return p.toString();
    };
    const { json } = await http.get(`${NSE_BASE}${PATHS[kind](q)}`, { headers: { Referer: `${NSE_BASE}${REFERERS[kind]}` } });
    return json;
  };
}
const ddmmyyyy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** @returns {Array<[string, string, {scope: "read"}, (ctx: any) => Promise<object>]>} */
export function marketEventsRoutes(deps) {
  const fetcher = extra(deps, "marketEventsFetcher") ?? defaultFetcher(deps);
  const now = () => (extra(deps, "clock")?.now ? deps.clock.now() : Date.now());
  const dataDir = extra(deps, "paths")?.dataDir;
  const filePath = dataDir ? join(dataDir, "analytics", "market-events.json") : null;
  const baseLog = extra(deps, "logger");
  const log = baseLog?.child ? baseLog.child({ module: "market-events" }) : baseLog;
  const warn = (msg, err) => {
    try {
      log?.warn?.({ err: err?.message ?? String(err) }, msg);
    } catch {
      /* logging must never fail a request */
    }
  };

  /** cache key -> { fetchedAt, rows } */
  const cache = new Map();
  const inflight = new Map();
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") warn("market-events cache unreadable; starting empty", err);
      return;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || typeof doc.entries !== "object" || doc.entries === null || Array.isArray(doc.entries)) throw new Error("unexpected shape");
      for (const [k, e] of Object.entries(doc.entries)) if (e && Number.isFinite(e.fetchedAt) && Array.isArray(e.rows)) cache.set(k, { fetchedAt: e.fetchedAt, rows: e.rows });
      trim();
    } catch (err) {
      cache.clear();
      warn("market-events cache file is corrupt; moving it aside", err);
      try {
        renameSync(filePath, `${filePath}.corrupt-${now()}`);
      } catch (e2) {
        warn("could not move the corrupt market-events file aside", e2);
      }
    }
  }
  function trim() {
    const keep = [...cache].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, MAX_ENTRIES);
    cache.clear();
    for (const [k, v] of keep) cache.set(k, v);
  }
  function save() {
    if (!filePath) return;
    try {
      writeFileAtomic(filePath, `${JSON.stringify({ version: 1, entries: Object.fromEntries(cache) })}\n`);
    } catch (err) {
      warn("could not persist market-events cache", err);
    }
  }

  async function refresh(key, kind, params) {
    let json;
    try {
      json = await fetcher(kind, params);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError("UPSTREAM_ERROR", "The NSE market-events fetch failed unexpectedly.", { cause: err });
    }
    const rows = mappers[kind](json);
    cache.set(key, { fetchedAt: now(), rows });
    trim();
    save();
  }

  /** Returns { rows, fetchedAt, stale }. */
  async function get(kind, params) {
    load();
    const key = `${kind}|${params.from}|${params.to}|${params.symbol ?? ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS) return { ...hit, stale: false };
    let p = inflight.get(key);
    if (!p) {
      p = refresh(key, kind, params).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    try {
      await p;
    } catch (err) {
      if (!cache.has(key)) throw err; // nothing cached: surface the error; otherwise serve stale data below
    }
    const e = cache.get(key);
    return { ...e, stale: now() - e.fetchedAt >= CACHE_TTL_MS };
  }

  function window(days) {
    const t = now() + IST_OFFSET_MS;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    return { from: iso(t - days * 86_400_000), to: iso(t) };
  }
  function intParam(ctx, name, lim) {
    const raw = ctx.query.get(name);
    if (raw === null || raw === "") return lim.def;
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > lim.max) throw invalid(name, `${name} must be a whole number from 1 to ${lim.max}.`);
    return Number(raw);
  }
  function symbolParam(ctx) {
    const raw = ctx.query.get("symbol");
    if (raw === null || raw === "") return null;
    const s = raw.trim().toUpperCase();
    if (!/^[A-Z0-9&-]{1,20}$/.test(s)) throw invalid("symbol", "symbol must be an NSE ticker such as RELIANCE or M&M.");
    return s;
  }
  const meta = (ctx, r, extraMeta) => ({
    requestId: ctx.requestId,
    source: extra(deps, "config")?.demo ? "demo" : "nse",
    fetchedAt: new Date(r.fetchedAt).toISOString(),
    stale: r.stale,
    ...extraMeta,
  });
  const cap = (rows) => rows.slice(0, MAX_ROWS);

  async function deals(ctx) {
    const kind = ctx.query.get("kind");
    if (kind !== "block" && kind !== "bulk") throw invalid("kind", "kind must be block or bulk.");
    const days = intParam(ctx, "days", LIMITS.deals);
    const symbol = symbolParam(ctx);
    let minValue = null;
    const mv = ctx.query.get("minValue");
    if (mv !== null && mv !== "") {
      minValue = /^\d+(\.\d+)?$/.test(mv) ? Number(mv) : NaN;
      if (!Number.isFinite(minValue)) throw invalid("minValue", "minValue must be a non-negative number (INR crore).");
    }
    const r = await get(kind, { ...window(days), symbol });
    const rows = r.rows
      .filter((d) => (!symbol || d.symbol === symbol) && (minValue === null || (d.valueCr ?? 0) >= minValue))
      .sort((a, b) => byDateDesc(a, b) || (b.valueCr ?? 0) - (a.valueCr ?? 0) || (a.symbol < b.symbol ? -1 : 1));
    return {
      data: { kind, unit: "INR crore", deals: cap(rows), summary: dealSummary(rows) },
      meta: meta(ctx, r, { days, total: rows.length }),
    };
  }

  async function insiders(ctx) {
    const days = intParam(ctx, "days", LIMITS.insiders);
    const symbol = symbolParam(ctx);
    const r = await get("pit", { ...window(days), symbol });
    const rows = r.rows.filter((d) => !symbol || d.symbol === symbol).sort((a, b) => byDateDesc(a, b) || (b.valueCr ?? 0) - (a.valueCr ?? 0) || (a.symbol < b.symbol ? -1 : 1));
    return {
      data: { unit: "INR crore", disclosures: cap(rows), summary: insiderSummary(rows) },
      meta: meta(ctx, r, { days, total: rows.length }),
    };
  }

  async function events(ctx) {
    const days = intParam(ctx, "days", LIMITS.events);
    const symbol = symbolParam(ctx);
    const w = window(days);
    // The calendar looks forward: today .. today + days.
    const to = new Date(Date.parse(`${w.to}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const r = await get("events", { from: w.to, to, symbol });
    const rows = r.rows.filter((d) => !symbol || d.symbol === symbol);
    return {
      data: { days: groupByDay(rows.slice(0, MAX_ROWS)) },
      meta: meta(ctx, r, { requestedDays: days, total: rows.length }),
    };
  }

  return [
    ["GET", "/v1/analytics/deals", { scope: "read" }, deals],
    ["GET", "/v1/analytics/insiders", { scope: "read" }, insiders],
    ["GET", "/v1/analytics/events", { scope: "read" }, events],
  ];
}
