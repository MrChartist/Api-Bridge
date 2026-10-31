/**
 * Lot sizes and the F&O universe from NSE's fo_mktlots.csv (stream S16, docs/spec/p1-02-reference.md §6.3, §6.8).
 * Pure: parsing, the lot history merge, effective dates, the banner window, conflicts and universe intervals.
 *
 * Layout (NEEDS VERIFICATION against a real download): a header `UNDERLYING,SYMBOL,OCT-26,NOV-26,...` (cells padded
 * with spaces), index rows, then a section line such as `Derivatives on Individual Securities` and the stock rows.
 * A lot is a property of the contract's expiry month: lotFor(u, expiry) = lots[u][month(expiry)].
 */
import { calendarDaysBetween } from "./calendar.mjs";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Split one CSV line (double-quoted cells may hold commas; "" is a quote). */
export function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Text lines without a BOM, CRs or blank lines. */
export function csvLines(text) {
  return String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** "OCT-26" -> "2026-10"; null when the cell is not a month. */
export function parseMonthHeader(cell) {
  const m = /^([A-Z]{3})-?(\d{2}|\d{4})$/.exec(String(cell ?? "").trim().toUpperCase());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return null;
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${year}-${String(mi + 1).padStart(2, "0")}`;
}

/**
 * Parse fo_mktlots.csv.
 * @param {string} text
 * @returns {{ months: string[], rows: Array<{ name: string, symbol: string, kind: "index"|"stock", lots: Record<string, number> }> }}
 * @throws Error when the header is missing or no row parses (the caller keeps the previous data)
 */
export function parseMktLots(text) {
  const lines = csvLines(text);
  const headerAt = lines.findIndex((l) => /^"?UNDERLYING"?\s*,\s*"?SYMBOL"?/i.test(l));
  if (headerAt < 0) throw new Error("fo_mktlots: no UNDERLYING,SYMBOL header line");
  const header = splitCsvLine(lines[headerAt]);
  const months = header.map((h, i) => (i < 2 ? null : parseMonthHeader(h)));
  if (!months.some(Boolean)) throw new Error("fo_mktlots: no month columns in the header");
  const rows = [];
  let section = "index";
  for (const line of lines.slice(headerAt + 1)) {
    const cells = splitCsvLine(line);
    const name = cells[0] ?? "";
    const symbol = (cells[1] ?? "").toUpperCase();
    if (!symbol) {
      if (/individual securities|stock/i.test(name)) section = "stock";
      else if (/index/i.test(name)) section = "index";
      continue;
    }
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol)) continue;
    const lots = {};
    months.forEach((m, i) => {
      if (!m) return;
      const v = Number(String(cells[i] ?? "").replace(/,/g, ""));
      if (Number.isInteger(v) && v > 0) lots[m] = v;
    });
    if (Object.keys(lots).length) rows.push({ name, symbol, kind: section, lots });
  }
  if (!rows.length) throw new Error("fo_mktlots: no rows with lot sizes");
  return { months: months.filter(Boolean), rows };
}

/**
 * Merge a parsed file into the lot history (one row per exchange, underlying and expiry month; never deleted).
 * @param {Array<object>} history
 * @param {ReturnType<typeof parseMktLots>} parsed
 * @param {{ exchange?: string, date: string, source: string }} o
 * @returns {{ rows: Array<object>, changed: boolean, revisions: Array<{ underlying, expiryMonth, from, to }> }}
 */
export function mergeLotHistory(history, parsed, { exchange = "NFO", date, source }) {
  const byKey = new Map((history ?? []).map((r) => [`${r.exchange}|${r.underlying}|${r.expiryMonth}`, { ...r }]));
  let changed = false;
  const revisions = [];
  for (const row of parsed.rows) {
    for (const [month, lot] of Object.entries(row.lots)) {
      const k = `${exchange}|${row.symbol}|${month}`;
      const old = byKey.get(k);
      if (!old) {
        byKey.set(k, { exchange, underlying: row.symbol, kind: row.kind, expiryMonth: month, lot, firstSeen: date, lastSeen: date, source });
        changed = true;
      } else {
        if (old.lot !== lot) {
          revisions.push({ underlying: row.symbol, expiryMonth: month, from: old.lot, to: lot });
          old.previousLot = old.lot;
          old.lot = lot;
          old.revisedOn = date;
          changed = true;
        }
        old.lastSeen = date;
        old.source = source;
        old.kind = row.kind;
      }
    }
  }
  const rows = [...byKey.values()].sort((a, b) => (a.exchange + a.underlying + a.expiryMonth < b.exchange + b.underlying + b.expiryMonth ? -1 : 1));
  return { rows, changed, revisions };
}

/** One underlying's rows, oldest month first. */
export function lotTimeline(history, underlying, exchange = "NFO") {
  return (history ?? []).filter((r) => r.underlying === underlying && r.exchange === exchange).sort((a, b) => (a.expiryMonth < b.expiryMonth ? -1 : 1));
}

/** The lot of the contract month (YYYY-MM), or null. */
export function lotForMonth(timeline, month) {
  return timeline.find((r) => r.expiryMonth === month)?.lot ?? null;
}

/**
 * Lot changes between consecutive months (§6.3). lastOldExpiry is the last listed expiry of the old month;
 * effectiveFrom = nextTradingDay(lastOldExpiry), the first day the nearest listed contract carries the new lot. Both
 * are null when no expiry of the old month is listed.
 * @param {Array<{ expiryMonth: string, lot: number }>} timeline
 * @param {{ listedExpiries: string[], cal: { nextTradingDay(d: string, e?: string): string }, exchange?: string }} o
 */
export function lotTransitions(timeline, { listedExpiries = [], cal, exchange = "NFO" }) {
  const out = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const a = timeline[i - 1];
    const b = timeline[i];
    if (a.lot === b.lot) continue;
    const inMonth = listedExpiries.filter((d) => d.slice(0, 7) === a.expiryMonth).sort();
    const lastOldExpiry = inMonth.length ? inMonth[inMonth.length - 1] : null;
    out.push({ fromMonth: a.expiryMonth, toMonth: b.expiryMonth, lotBefore: a.lot, lotAfter: b.lot, lastOldExpiry, effectiveFrom: lastOldExpiry ? cal.nextTradingDay(lastOldExpiry, exchange) : null });
  }
  return out;
}

/** Banner window: 0 <= calendar days from today to effectiveFrom <= bannerDays. */
export function bannerDue(today, effectiveFrom, bannerDays = 7) {
  if (!effectiveFrom) return false;
  const d = calendarDaysBetween(today, effectiveFrom);
  return d >= 0 && d <= bannerDays;
}

/** A master's contract lot that differs from the reference lot (the master wins for orders). */
export function lotConflict(masterLot, referenceLot) {
  if (!Number.isInteger(masterLot) || !Number.isInteger(referenceLot) || masterLot === referenceLot) return null;
  return { master: masterLot, reference: referenceLot };
}

/** Universe members from a parsed file: index and stock symbols of NFO. */
export function membersFromMktLots(parsed, exchange = "NFO") {
  return parsed.rows.map((r) => ({ symbol: r.symbol, kind: r.kind, exchange }));
}

/**
 * Update membership intervals with the members seen on date d (§6.8): open intervals whose symbol is gone close on
 * prevTradingDay(d); new symbols open an interval from d (fromIsFirstFetch when d is the first fetch).
 * @param {{ knownSince: string, intervals: Array<object> } | null} universe
 * @param {Array<{ symbol, kind, exchange }>} members
 * @param {string} d
 * @param {(date: string) => string} prevTradingDay
 */
export function updateUniverse(universe, members, d, prevTradingDay) {
  const u = universe && universe.knownSince ? { version: 1, knownSince: universe.knownSince, intervals: universe.intervals.map((i) => ({ ...i })) } : { version: 1, knownSince: d, intervals: [] };
  const seen = new Set(members.map((m) => `${m.exchange}|${m.symbol}`));
  let changed = false;
  for (const i of u.intervals) {
    if (i.to === null && !seen.has(`${i.exchange}|${i.symbol}`) && i.from <= d) {
      i.to = prevTradingDay(d);
      changed = true;
    }
  }
  const open = new Set(u.intervals.filter((i) => i.to === null).map((i) => `${i.exchange}|${i.symbol}`));
  for (const m of members) {
    if (open.has(`${m.exchange}|${m.symbol}`)) continue;
    u.intervals.push({ symbol: m.symbol, kind: m.kind, exchange: m.exchange, from: d, to: null, fromIsFirstFetch: d === u.knownSince });
    open.add(`${m.exchange}|${m.symbol}`);
    changed = true;
  }
  return { universe: u, changed };
}

/**
 * Membership on a date. Before knownSince: coverage "not-recorded" with an empty list (never today's list).
 * @param {{ knownSince: string, intervals: Array<object> } | null} universe
 * @param {string} date
 * @param {"stock"|"index"|"all"} [kind]
 */
export function universeOn(universe, date, kind = "all") {
  if (!universe?.knownSince) return { date, coverage: "not-recorded", knownSince: null, items: [] };
  if (date < universe.knownSince) return { date, coverage: "not-recorded", knownSince: universe.knownSince, items: [] };
  const items = universe.intervals
    .filter((i) => i.from <= date && (i.to === null || i.to >= date) && (kind === "all" || i.kind === kind))
    .map((i) => ({ symbol: i.symbol, kind: i.kind, exchange: i.exchange, since: i.from, sinceIsFirstFetch: i.fromIsFirstFetch === true }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { date, coverage: "recorded", knownSince: universe.knownSince, items };
}

/** Additions and removals within [from, to] (removals dated the day after the interval closed). */
export function universeChanges(universe, from, to, nextDay) {
  if (!universe?.intervals) return [];
  const out = [];
  for (const i of universe.intervals) {
    if (!i.fromIsFirstFetch && i.from >= from && i.from <= to) out.push({ date: i.from, symbol: i.symbol, change: "added" });
    if (i.to) {
      const removed = nextDay(i.to);
      if (removed >= from && removed <= to) out.push({ date: removed, symbol: i.symbol, change: "removed" });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.symbol < b.symbol ? -1 : 1));
}
