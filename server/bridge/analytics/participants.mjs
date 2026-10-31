/**
 * Participant-wise F&O open interest (FII, DII, Pro, Client) in PR 17's shape — stream S15, read scope, no broker.
 *
 *   GET /v1/analytics/participants[?days=10]   per session: index futures, index options, stock futures, stock options
 *                                              (long, short, net, long/short ratio, long %), day-on-day change, sentiment
 *
 * An alias over the Bridge's one participant OI store (server/bridge/participants, GET /v1/participants/oi), which
 * fetches NSE's daily file, keeps the history and has a demo history. This file keeps PR 17's pure parts: the CSV
 * reader (for tests and tools), the product groups and the sentiment read.
 *
 * Sentiment (derived, not from NSE): futures score = index-futures net / gross (-1..1); options score = directional
 * index-option net, (call long + put short - put long - call short) / their sum (-1..1), contracts not delta-weighted.
 * score = 0.7 * futures + 0.3 * options; >= 0.5 strongly_bullish, >= 0.15 bullish, <= -0.5 strongly_bearish,
 * <= -0.15 bearish, else neutral. A positioning read, not a forecast.
 */
import { BridgeError } from "../core/errors.mjs";

export const ARCHIVE_BASE = "https://nsearchives.nseindia.com";
export const participantsUrl = (iso) => `${ARCHIVE_BASE}/content/nsccl/fao_participant_oi_${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}.csv`;
export const ROUTE_NOTES =
  "Read from the participant OI store (GET /v1/participants/oi). The NSE URL pattern (nsearchives.nseindia.com/content/nsccl/fao_participant_oi_ddmmyyyy.csv) and the CSV column layout are assumed from NSE site knowledge and unverified without network access. A changed shape raises UPSTREAM_ERROR.";
const MAX_DAYS = 60;
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

/** Our store's instrument rows ([long, short] each) as this module's raw keys. */
const FROM_STORE = Object.freeze({ IDX_FUT: ["fil", "fis"], IDX_CE: ["icl", "ics"], IDX_PE: ["ipl", "ips"], STK_FUT: ["sfl", "sfs"], STK_CE: ["scl", "scs"], STK_PE: ["spl", "sps"] });
const STORE_NAMES = Object.freeze({ FII: "FII", DII: "DII", PRO: "Pro", CLIENT: "Client" });

/** One stored day (participants/ series row) as { date, rows: { FII: { fil, ... }, ... } }, or null when a row is missing. */
export function fromStoreDay(day) {
  const rows = {};
  for (const [store, name] of Object.entries(STORE_NAMES)) {
    const src = day?.rows?.[store];
    if (!src) return null;
    const r = {};
    for (const [x, [lk, sk]] of Object.entries(FROM_STORE)) {
      const v = src[x];
      if (!Array.isArray(v) || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
      r[lk] = v[0];
      r[sk] = v[1];
    }
    rows[name] = r;
  }
  return { date: day.date, rows };
}

/**
 * GET /v1/analytics/participants: an alias over the Bridge's one participant OI store (server/bridge/participants,
 * GET /v1/participants/oi), kept for PR 17's shape: per session the four product groups, sentiment and day-on-day
 * change. It reads the store only (no NSE request of its own); docs/design/pr17-integration.md.
 */
export function participantsRoutes(deps) {
  async function handler(ctx) {
    const raw = ctx.query.get("days");
    let days = 10;
    if (raw !== null && raw !== "") {
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_DAYS) throw invalid("days", `days must be a whole number from 1 to ${MAX_DAYS}.`);
      days = Number(raw);
    }
    const svc = extra(deps, "participants");
    if (!svc || typeof svc.series !== "function") throw upstream("Participant OI is not available on this Bridge.");
    const from = new Date(Date.now() - (days * 2 + 14) * DAY_MS + IST_OFFSET_MS).toISOString().slice(0, 10);
    const all = svc
      .series({ from })
      .map(fromStoreDay)
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (!all.length) throw upstream("No participant OI has been stored yet. It arrives after the close; see Markets > OI Analysis > Participants.");
    const sessions = all.slice(0, days).map((s, i) => {
      const prev = all[i + 1] ?? null;
      const participants = {};
      for (const p of PARTICIPANTS) {
        const cur = productsOf(s.rows[p]);
        const prv = prev ? productsOf(prev.rows[p]) : null;
        participants[p] = { ...cur, sentiment: sentimentOf(s.rows[p]), change: prv ? Object.fromEntries([...GROUPS, "total"].map((g) => [g, change(cur[g], prv[g])])) : null };
      }
      return { date: s.date, previousDate: prev?.date ?? null, participants };
    });
    return {
      data: { unit: "contracts", sessions, latest: { date: sessions[0].date, sentiment: Object.fromEntries(PARTICIPANTS.map((p) => [p, sessions[0].participants[p].sentiment.label])) } },
      meta: { requestId: ctx.requestId, source: "participants-store", aliasOf: "/v1/participants/oi", requested: days, available: all.length, stale: false, notes: ROUTE_NOTES },
    };
  }
  return [["GET", "/v1/analytics/participants", { scope: "read" }, handler]];
}
