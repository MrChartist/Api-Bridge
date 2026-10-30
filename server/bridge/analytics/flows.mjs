/**
 * FII / DII cash-market flows — stream S15, read scope, no broker account.
 *
 *   GET /v1/analytics/fii-dii[?days=10]   daily FII and DII buy, sell and net (INR crore), rolling sums, net-flow streak
 *
 * Source: NSE's public /api/fiidiiTradeReact, fetched with the backup module's cookie-aware HTTP client (same
 * timeout, browser headers and BridgeError mapping). NSE publishes only the latest session per call, so each fetch is
 * merged by date (newest source wins) into a history of the newest 250 sessions. When deps.paths.dataDir is set the
 * history is loaded lazily on first use from, and saved atomically (0600) to, <dataDir>/analytics/fii-dii.json; a
 * corrupt file is moved aside, and disk errors are logged, never surfaced. meta.available counts persisted plus
 * fetched sessions; rows are always ordered newest date first.
 *
 * deps (all optional): fiiDiiFetcher: async () => rows[] (tests inject this), fetchImpl, clock, config.backup.timeoutMs,
 * paths.dataDir, logger.
 */
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createHttpClient } from "../backup/httpClient.mjs";
import { NSE_BASE, nseDateToIso } from "../backup/providers/nse.mjs";

export const FII_DII_URL = `${NSE_BASE}/api/fiidiiTradeReact`;
export const CACHE_TTL_MS = 5 * 60_000;
const MAX_HISTORY = 250;
const MAX_DAYS = 60;
const WINDOWS = Object.freeze([1, 5, 10, 20]);

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Safe lookup: scoped deps throw on undeclared keys. */
function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

/** Raw NSE rows -> [{ date, fii: {buy,sell,net}, dii: {...} }] (one entry per session found). Throws UPSTREAM_ERROR on a bad shape. */
export function parseFiiDii(json) {
  if (!Array.isArray(json)) throw new BridgeError("UPSTREAM_ERROR", "NSE answered the FII/DII request with an unexpected shape.");
  const byDate = new Map();
  for (const row of json) {
    const cat = String(row?.category ?? "").trim().toUpperCase();
    const side = cat.startsWith("FII") || cat.startsWith("FPI") ? "fii" : cat.startsWith("DII") ? "dii" : null;
    const date = nseDateToIso(row?.date);
    const buy = num(row?.buyValue);
    const sell = num(row?.sellValue);
    if (!side || !date || buy === null || sell === null) continue;
    const net = num(row?.netValue) ?? buy - sell;
    const e = byDate.get(date) ?? { date };
    e[side] = { buy: r2(buy), sell: r2(sell), net: r2(net) };
    byDate.set(date, e);
  }
  const out = [...byDate.values()].filter((e) => e.fii && e.dii);
  if (!out.length) throw new BridgeError("UPSTREAM_ERROR", "NSE returned no usable FII/DII rows.");
  return out;
}

/** Sums of net over the newest n sessions, for each window; `days` is how many sessions actually went in. */
export function rollingSums(rows, windows = WINDOWS) {
  return windows.map((w) => {
    const slice = rows.slice(0, w);
    const sum = (k) => r2(slice.reduce((s, d) => s + d[k].net, 0));
    return { window: w, days: slice.length, fiiNet: sum("fii"), diiNet: sum("dii") };
  });
}

/** Consecutive newest sessions with the same net sign. count > 0 buying, < 0 selling, 0 when flat or no data. */
export function netStreak(rows, key) {
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const first = rows.length ? sign(rows[0][key].net) : 0;
  if (!first) return { direction: "flat", count: 0 };
  let n = 0;
  for (const d of rows) {
    if (sign(d[key].net) !== first) break;
    n++;
  }
  return { direction: first > 0 ? "buying" : "selling", count: n };
}

/** Default fetcher: prime NSE cookies from the home page, then call the API. */
function defaultFetcher(deps) {
  const http = createHttpClient({
    fetchImpl: extra(deps, "fetchImpl") ?? globalThis.fetch,
    timeoutMs: extra(deps, "config")?.backup?.timeoutMs ?? 8000,
    provider: "NSE India",
  });
  return async () => {
    if (!http.hasCookies()) await http.get(`${NSE_BASE}/`, { raw: true, headers: { Accept: "text/html" } });
    const { json } = await http.get(FII_DII_URL, { headers: { Referer: `${NSE_BASE}/reports/fii-dii` } });
    return json;
  };
}

/** @returns {Array<[string, string, {scope: "read"}, (ctx: any) => Promise<object>]>} */
export function flowsRoutes(deps) {
  const fetcher = extra(deps, "fiiDiiFetcher") ?? defaultFetcher(deps);
  const now = () => (extra(deps, "clock")?.now ? deps.clock.now() : Date.now());
  const dataDir = extra(deps, "paths")?.dataDir;
  const filePath = dataDir ? join(dataDir, "analytics", "fii-dii.json") : null;
  const baseLog = extra(deps, "logger");
  const log = baseLog?.child ? baseLog.child({ module: "fii-dii" }) : baseLog;
  const warn = (msg, err) => {
    try {
      log?.warn?.({ err: err?.message ?? String(err) }, msg);
    } catch {
      /* logging must never fail a request */
    }
  };
  /** iso date -> session row */
  const history = new Map();
  let loaded = false;

  const validSide = (x) => x && ["buy", "sell", "net"].every((k) => typeof x[k] === "number" && Number.isFinite(x[k]));
  const validRow = (r) => r && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && validSide(r.fii) && validSide(r.dii);
  const trim = () => {
    for (const k of [...history.keys()].sort().reverse().slice(MAX_HISTORY)) history.delete(k);
  };

  /** Lazy, once: read persisted sessions. Never throws. */
  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") warn("fii-dii history unreadable; starting empty", err);
      return;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || !Array.isArray(doc.rows)) throw new Error("unexpected shape");
      for (const r of doc.rows) if (validRow(r)) history.set(r.date, { date: r.date, fii: r.fii, dii: r.dii });
      trim();
    } catch (err) {
      history.clear();
      warn("fii-dii history file is corrupt; moving it aside", err);
      try {
        renameSync(filePath, `${filePath}.corrupt-${now()}`);
      } catch (e2) {
        warn("could not move the corrupt fii-dii file aside", e2);
      }
    }
  }

  function save() {
    if (!filePath) return;
    try {
      const rows = sortedRows().map((d) => ({ date: d.date, fii: d.fii, dii: d.dii }));
      writeFileAtomic(filePath, `${JSON.stringify({ version: 1, rows }, null, 2)}\n`);
    } catch (err) {
      warn("could not persist fii-dii history", err);
    }
  }

  /** Newest date first; dates are unique keys so the order is total and deterministic. */
  const sortedRows = () => [...history.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  let fetchedAt = 0;
  let inflight = null;

  async function refresh() {
    let json;
    try {
      json = await fetcher();
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError("UPSTREAM_ERROR", "The FII/DII fetch failed unexpectedly.", { cause: err });
    }
    for (const e of parseFiiDii(json)) history.set(e.date, e);
    trim();
    fetchedAt = now();
    save();
  }

  async function ensureFresh() {
    load();
    if (history.size && now() - fetchedAt < CACHE_TTL_MS) return;
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    try {
      await inflight;
    } catch (err) {
      if (!history.size) throw err; // nothing cached: surface the error; otherwise serve stale data below
    }
  }

  async function handler(ctx) {
    const raw = ctx.query.get("days");
    let days = 10;
    if (raw !== null && raw !== "") {
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_DAYS) throw invalid("days", `days must be a whole number from 1 to ${MAX_DAYS}.`);
      days = Number(raw);
    }
    await ensureFresh();
    const all = sortedRows();
    const rows = all.slice(0, days);
    const stale = now() - fetchedAt >= CACHE_TTL_MS;
    return {
      data: {
        unit: "INR crore",
        days: rows.map((d) => ({ date: d.date, fii: d.fii, dii: d.dii })),
        rolling: rollingSums(all, WINDOWS.filter((w) => w <= MAX_DAYS)),
        streak: { fii: netStreak(all, "fii"), dii: netStreak(all, "dii") },
      },
      meta: { requestId: ctx.requestId, source: "nse", fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null, requested: days, available: all.length, stale },
    };
  }

  return [["GET", "/v1/analytics/fii-dii", { scope: "read" }, handler]];
}
