/**
 * Participant-wise F&O open interest (FII, DII, Pro, Client) — stream S15, read scope, no broker account.
 *
 *   GET /v1/analytics/participants[?days=10]   per session: index futures, index options, stock futures, stock options
 *                                              (long, short, net, long/short ratio, long %), day-on-day change, sentiment
 *
 * Source: NSE's daily fao_participant_oi_DDMMYYYY.csv on nsearchives.nseindia.com (ASSUMED URL pattern and column
 * layout, NOT verified against a live session; see ROUTE_NOTES). Each missing weekday in the lookback window is fetched
 * with the backup module's cookie-aware HTTP client, parsed by header name (case, spacing and column order tolerated)
 * and merged by date into a history of the newest 250 sessions, loaded lazily from and saved atomically (0600) to
 * <dataDir>/analytics/participants.json when deps.paths.dataDir is set (corrupt file moved aside, disk errors logged
 * only). A 404 means "not published yet or a holiday": today is retried on every refresh, older dates are remembered as
 * absent for the process lifetime. A file whose shape is not recognised raises UPSTREAM_ERROR. Refresh failures serve
 * the cached history with meta.stale true.
 *
 * Sentiment (derived, not from NSE): futures score = index-futures net / gross (-1..1); options score = directional
 * index-option net, (call long + put short - put long - call short) / their sum (-1..1), contracts not delta-weighted.
 * score = 0.7 * futures + 0.3 * options; >= 0.5 strongly_bullish, >= 0.15 bullish, <= -0.5 strongly_bearish,
 * <= -0.15 bearish, else neutral. A positioning read, not a forecast.
 *
 * deps (all optional): participantsFetcher: async (isoDate) => csv text | null (null = not published; tests inject
 * this), fetchImpl, clock, config.backup.timeoutMs, paths.dataDir, logger.
 */
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createHttpClient } from "../backup/httpClient.mjs";
import { NSE_BASE } from "../backup/providers/nse.mjs";

export const ARCHIVE_BASE = "https://nsearchives.nseindia.com";
export const participantsUrl = (iso) => `${ARCHIVE_BASE}/content/nsccl/fao_participant_oi_${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}.csv`;
export const CACHE_TTL_MS = 5 * 60_000;
export const ROUTE_NOTES =
  "The URL pattern (nsearchives.nseindia.com/content/nsccl/fao_participant_oi_ddmmyyyy.csv) and the CSV column layout are assumed from NSE site knowledge and unverified without network access. A changed shape raises UPSTREAM_ERROR.";
const MAX_HISTORY = 250;
const MAX_DAYS = 60;
const MAX_FETCH_PER_REFRESH = 40;
const BATCH = 4;
const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;
export const PARTICIPANTS = Object.freeze(["FII", "DII", "Pro", "Client"]);
const ALIASES = Object.freeze({ fii: "FII", fpi: "FII", dii: "DII", pro: "Pro", client: "Client" });

/** normalised header -> short key */
const COLUMNS = Object.freeze({
  futureindexlong: "fil", futureindexshort: "fis", futurestocklong: "sfl", futurestockshort: "sfs",
  optionindexcalllong: "icl", optionindexputlong: "ipl", optionindexcallshort: "ics", optionindexputshort: "ips",
  optionstockcalllong: "scl", optionstockputlong: "spl", optionstockcallshort: "scs", optionstockputshort: "sps",
});
const KEYS = Object.freeze(Object.values(COLUMNS));

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const upstream = (msg) => new BridgeError("UPSTREAM_ERROR", msg);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const num = (v) => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function extra(deps, k) {
  try {
    return deps?.[k];
  } catch {
    return undefined;
  }
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** CSV text -> { FII: {fil, fis, ...}, DII, Pro, Client } (raw contract counts). Throws UPSTREAM_ERROR on a bad shape. */
export function parseParticipantCsv(text) {
  if (typeof text !== "string" || !text.trim()) throw upstream("NSE answered the participant OI request with an empty or non-text body.");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const h = lines.findIndex((l) => /client\s*type/i.test(l));
  if (h < 0) throw upstream("NSE participant OI file has no 'Client Type' header; its layout may have changed.");
  const idx = {};
  splitCsv(lines[h]).forEach((name, i) => {
    const key = COLUMNS[name.toLowerCase().replace(/[^a-z]/g, "")];
    if (key) idx[key] = i;
  });
  const missing = KEYS.filter((k) => idx[k] === undefined);
  if (missing.length) throw upstream(`NSE participant OI file is missing expected columns (${missing.length} of ${KEYS.length}); its layout may have changed.`);
  const out = {};
  for (const line of lines.slice(h + 1)) {
    const cells = splitCsv(line);
    const who = ALIASES[String(cells[0] ?? "").toLowerCase().replace(/[^a-z]/g, "")];
    if (!who) continue;
    const row = {};
    for (const k of KEYS) {
      const v = num(cells[idx[k]]);
      if (v === null || v < 0) throw upstream(`NSE participant OI file has a non-numeric ${k} value for ${who}.`);
      row[k] = v;
    }
    out[who] = row;
  }
  const absent = PARTICIPANTS.filter((p) => !out[p]);
  if (absent.length) throw upstream(`NSE participant OI file has no row for ${absent.join(", ")}.`);
  return out;
}

const stat = (long, short) => ({
  long, short, net: long - short, gross: long + short,
  longPct: long + short > 0 ? r2((long / (long + short)) * 100) : null,
  longShortRatio: short > 0 ? r2(long / short) : null,
});

/** Raw participant row -> the four product groups plus total. */
export function productsOf(r) {
  const idxOpt = stat(r.icl + r.ipl, r.ics + r.ips);
  const stkOpt = stat(r.scl + r.spl, r.scs + r.sps);
  const idxFut = stat(r.fil, r.fis);
  const stkFut = stat(r.sfl, r.sfs);
  return {
    indexFutures: idxFut,
    indexOptions: { ...idxOpt, call: stat(r.icl, r.ics), put: stat(r.ipl, r.ips) },
    stockFutures: stkFut,
    stockOptions: { ...stkOpt, call: stat(r.scl, r.scs), put: stat(r.spl, r.sps) },
    total: stat(idxFut.long + idxOpt.long + stkFut.long + stkOpt.long, idxFut.short + idxOpt.short + stkFut.short + stkOpt.short),
  };
}

/** Net-position sentiment for one participant from raw counts (see the module header for the formula). */
export function sentimentOf(r) {
  const fg = r.fil + r.fis;
  const fut = fg > 0 ? (r.fil - r.fis) / fg : 0;
  const og = r.icl + r.ipl + r.ics + r.ips;
  const opt = og > 0 ? (r.icl + r.ips - r.ipl - r.ics) / og : 0;
  const score = r4(0.7 * fut + 0.3 * opt);
  const label = score >= 0.5 ? "strongly_bullish" : score >= 0.15 ? "bullish" : score <= -0.5 ? "strongly_bearish" : score <= -0.15 ? "bearish" : "neutral";
  return { label, score, indexFuturesScore: r4(fut), indexOptionsScore: r4(opt) };
}

const GROUPS = ["indexFutures", "indexOptions", "stockFutures", "stockOptions"];
const change = (cur, prev) => ({ long: cur.long - prev.long, short: cur.short - prev.short, net: cur.net - prev.net });

function defaultFetcher(deps) {
  const base = extra(deps, "fetchImpl") ?? globalThis.fetch;
  // The shared client parses JSON; wrap the CSV body so the same client (cookies, timeout, error mapping) carries it.
  const wrapped = async (url, init) => {
    const res = await base(url, init);
    if (!String(url).startsWith(ARCHIVE_BASE)) return res;
    const csv = res.status >= 200 && res.status < 300 ? await res.text() : "";
    return { status: res.status, headers: res.headers, text: async () => JSON.stringify({ csv }) };
  };
  const http = createHttpClient({ fetchImpl: wrapped, timeoutMs: extra(deps, "config")?.backup?.timeoutMs ?? 8000, provider: "NSE India" });
  return async (iso) => {
    const { status, json } = await http.get(participantsUrl(iso), { accept404: true, headers: { Accept: "text/csv, */*", Referer: `${NSE_BASE}/all-reports-derivatives` } });
    if (status === 404 || status === 403) return null;
    if (status >= 400) throw upstream(`NSE archives answered HTTP ${status} for the participant OI file.`);
    return json?.csv ?? null;
  };
}

/** @returns {Array<[string, string, {scope: "read"}, (ctx: any) => Promise<object>]>} */
export function participantsRoutes(deps) {
  const fetcher = extra(deps, "participantsFetcher") ?? defaultFetcher(deps);
  const now = () => (extra(deps, "clock")?.now ? deps.clock.now() : Date.now());
  const dataDir = extra(deps, "paths")?.dataDir;
  const filePath = dataDir ? join(dataDir, "analytics", "participants.json") : null;
  const baseLog = extra(deps, "logger");
  const log = baseLog?.child ? baseLog.child({ module: "participants" }) : baseLog;
  const warn = (msg, err) => {
    try {
      log?.warn?.({ err: err?.message ?? String(err) }, msg);
    } catch {
      /* logging must never fail a request */
    }
  };
  /** iso date -> { date, rows: { FII: raw, ... } } */
  const history = new Map();
  /** iso dates known to have no file (holidays), this process only */
  const absent = new Set();
  let loaded = false;

  const validRow = (r) => r && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.rows && PARTICIPANTS.every((p) => KEYS.every((k) => Number.isFinite(r.rows[p]?.[k])));
  const trim = () => {
    for (const k of [...history.keys()].sort().reverse().slice(MAX_HISTORY)) history.delete(k);
  };
  const sortedRows = () => [...history.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") warn("participants history unreadable; starting empty", err);
      return;
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || !Array.isArray(doc.rows)) throw new Error("unexpected shape");
      for (const r of doc.rows) if (validRow(r)) history.set(r.date, { date: r.date, rows: r.rows });
      trim();
    } catch (err) {
      history.clear();
      warn("participants history file is corrupt; moving it aside", err);
      try {
        renameSync(filePath, `${filePath}.corrupt-${now()}`);
      } catch (e2) {
        warn("could not move the corrupt participants file aside", e2);
      }
    }
  }

  function save() {
    if (!filePath) return;
    try {
      writeFileAtomic(filePath, `${JSON.stringify({ version: 1, rows: sortedRows() }, null, 2)}\n`);
    } catch (err) {
      warn("could not persist participants history", err);
    }
  }

  const istToday = () => new Date(now() + IST_OFFSET_MS).toISOString().slice(0, 10);

  /** Weekdays newest first, within a lookback sized for `want` sessions, that are neither held nor known absent. */
  function missingDates(want) {
    const out = [];
    const today = Date.parse(`${istToday()}T00:00:00Z`);
    const span = Math.min(Math.ceil(want * 1.6) + 6, 400);
    for (let i = 0; i < span && out.length < MAX_FETCH_PER_REFRESH; i++) {
      const d = new Date(today - i * DAY_MS);
      if ([0, 6].includes(d.getUTCDay())) continue;
      const iso = d.toISOString().slice(0, 10);
      if (!history.has(iso) && !absent.has(iso)) out.push(iso);
    }
    return out;
  }

  let fetchedAt = 0;
  let inflight = null;
  let wantSessions = 11;
  let covered = 0;

  async function fetchOne(iso) {
    let text;
    try {
      text = await fetcher(iso);
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError("UPSTREAM_ERROR", "The participant OI fetch failed unexpectedly.", { cause: err });
    }
    return { iso, rows: text === null || text === undefined ? null : parseParticipantCsv(text) };
  }

  async function refresh() {
    const want = wantSessions;
    const dates = missingDates(want);
    const today = istToday();
    let firstErr = null;
    for (let i = 0; i < dates.length; i += BATCH) {
      const settled = await Promise.allSettled(dates.slice(i, i + BATCH).map(fetchOne));
      for (const [j, s] of settled.entries()) {
        const iso = dates[i + j];
        if (s.status === "rejected") firstErr ??= s.reason;
        else if (s.value.rows) history.set(iso, { date: iso, rows: s.value.rows });
        else if (iso < today) absent.add(iso);
      }
    }
    trim();
    if (dates.length) save();
    if (firstErr) throw firstErr;
    if (!history.size) throw upstream("NSE has published no participant OI files in the lookback window.");
    fetchedAt = now();
    covered = Math.max(covered, want);
  }

  async function ensureFresh(days) {
    load();
    wantSessions = Math.max(wantSessions, days + 1);
    if (history.size && now() - fetchedAt < CACHE_TTL_MS && covered >= days + 1) return;
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    try {
      await inflight;
    } catch (err) {
      if (!history.size) throw err;
    }
  }

  async function handler(ctx) {
    const raw = ctx.query.get("days");
    let days = 10;
    if (raw !== null && raw !== "") {
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_DAYS) throw invalid("days", `days must be a whole number from 1 to ${MAX_DAYS}.`);
      days = Number(raw);
    }
    await ensureFresh(days);
    const all = sortedRows();
    const sessions = all.slice(0, days).map((s) => {
      const prev = all[all.indexOf(s) + 1] ?? null;
      const participants = {};
      for (const p of PARTICIPANTS) {
        const cur = productsOf(s.rows[p]);
        const prv = prev ? productsOf(prev.rows[p]) : null;
        participants[p] = {
          ...cur,
          sentiment: sentimentOf(s.rows[p]),
          change: prv ? Object.fromEntries([...GROUPS, "total"].map((g) => [g, change(cur[g], prv[g])])) : null,
        };
      }
      return { date: s.date, previousDate: prev?.date ?? null, participants };
    });
    const stale = !fetchedAt || now() - fetchedAt >= CACHE_TTL_MS;
    return {
      data: {
        unit: "contracts",
        sessions,
        latest: sessions[0] ? { date: sessions[0].date, sentiment: Object.fromEntries(PARTICIPANTS.map((p) => [p, sessions[0].participants[p].sentiment.label])) } : null,
      },
      meta: {
        requestId: ctx.requestId, source: "nse-archives", fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
        requested: days, available: all.length, stale, notes: ROUTE_NOTES,
      },
    };
  }

  return [["GET", "/v1/analytics/participants", { scope: "read" }, handler]];
}
