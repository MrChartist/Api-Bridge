/**
 * ParticipantOI service — stream S26 (docs/spec/p1-12-guard-participants.md §2.5, §3, §4.2). Store S4: NSE's daily
 * participant-wise OI file, fetched politely through the reference module's NSE archive client, behind its switch.
 *
 *  - Daily fetch at fetchAt (19:10 IST) + a per-Bridge jitter, then every retryEveryMinutes until retryUntil (22:10),
 *    on trading days; a morning catch-up (08:40) for a missed previous trading day.
 *  - Back-fill: newest first, one file per gapSeconds, at most maxPerRun an hour, never during notDuring
 *    (09:00–15:45 IST), until `days` trading days are covered. The cursor is persisted, so a restart resumes.
 *    A 404 is recorded; after two 404s the date is "noFile" (not published or no longer in the archive).
 *  - Demo mode: a deterministic generator (demo.mjs); nothing is fetched or stored.
 *
 * No broker call, no order path. Every figure is in contracts, NSE only, summed over all strikes and expiries.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { addDays, calendarDaysBetween, istClockOf, istDateOf, istInstant, isIsoDate, weekdayOf } from "../reference/calendar.mjs";
import { parseParticipantsConfig, pathFor } from "./config.mjs";
import { DEMO_SOURCE, demoHasFile, demoParticipantDay, demoRevisions } from "./demo.mjs";
import { buildSummary, csvRows, lotRegimeOn } from "./metrics.mjs";
import { INSTRUMENTS, PARTICIPANTS, PARTICIPANT_ROWS, ParticipantParseError, parseParticipantOi } from "./parser.mjs";
import { createParticipantStore } from "./store.mjs";

/** Failure codes a later retry can fix by itself: never counted toward the back-fill skip threshold. */
const TRANSIENT_CODES = new Set(["UPSTREAM_RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "BROKER_UNAVAILABLE", "SOURCE_OFF", "SOURCE_UNAVAILABLE"]);
/**
 * Failures that mean NSE is refusing or not answering (a 429, a 403 block, a lasting 5xx, a timeout): the back-fill
 * stops and pauses (30 min, doubling to 6 h while it keeps happening; reset on the first success), so the Bridge
 * never keeps asking a host that is turning it away (§8, §9.2, BRD §8.3).
 */
const BACKOFF_CODES = new Set(["UPSTREAM_RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "BROKER_UNAVAILABLE"]);
export const BACKOFF_FIRST_MS = 30 * 60_000;
export const BACKOFF_MAX_MS = 6 * 3_600_000;

const SHIPPED_REVISIONS = (() => {
  try {
    const doc = JSON.parse(readFileSync(new URL("./data/lot-revisions.json", import.meta.url), "utf8"));
    return Array.isArray(doc.revisions) ? doc.revisions : [];
  } catch {
    return [];
  }
})();

export const SUMMARY_HISTORY_DAYS = 20;
export const MAX_RANGE_DAYS = 750;
const DEMO_PUBLISH = "19:10";

/** IST ISO timestamp "2026-10-28T19:11:42.003+05:30". */
export function istIso(ms) {
  const d = new Date(ms + 330 * 60_000);
  return `${d.toISOString().slice(0, 23)}+05:30`;
}

/** Deterministic jitter of hash(dataDir) % 300 seconds (§2.5), so many Bridges do not ask NSE at the same instant. */
export function jitterMsFor(dataDir) {
  let h = 2166136261;
  for (const ch of String(dataDir ?? "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 300) * 1000;
}

/** A weekday-only calendar for when the reference service is not running. */
const WEEKDAYS = Object.freeze({
  isTradingDay: (d) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6,
  prevTradingDay(d) {
    let x = addDays(d, -1);
    while (!WEEKDAYS.isTradingDay(x)) x = addDays(x, -1);
    return x;
  },
  nextTradingDay(d) {
    let x = addDays(d, 1);
    while (!WEEKDAYS.isTradingDay(x)) x = addDays(x, 1);
    return x;
  },
});

const notFound = (date) => new BridgeError("NOT_FOUND", `No participant OI for ${date} (no file: likely a holiday or a day NSE did not publish).`);
const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

/**
 * @param {object} deps  config, logger, bus, clock, paths, reference
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, jitterMs?: number, client?: object,
 *   timers?: { setInterval: Function, clearInterval: Function } }} [opts]
 */
export function createParticipantsService(deps, opts = {}) {
  const config = deps.config ?? {};
  const cfg = config.participants && config.participants.backfill ? config.participants : parseParticipantsConfig(config.participants);
  const demo = config.demo === true;
  const ref = deps.reference && !isStub(deps.reference) ? deps.reference : null;
  const log = typeof deps.logger?.child === "function" ? deps.logger.child({ module: "participants" }) : deps.logger;
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const dataDir = deps.paths?.dataDir ?? config.dataDir ?? null;
  const store = !demo && dataDir ? createParticipantStore(join(dataDir, "participants"), { now, logger: log }) : null;
  const timers = opts.timers ?? { setInterval, clearInterval };
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  const jitterMs = opts.jitterMs ?? jitterMsFor(dataDir);

  let days = store ? store.loadDays() : new Map();
  let state = store ? store.readState() : null;
  const save = () => {
    try {
      store?.writeState(state);
    } catch (err) {
      log?.warn?.("participants: state could not be saved", { err: String(err?.message ?? err) });
    }
  };

  const today = () => istDateOf(now());
  const cal = () => {
    try {
      return ref ? ref.calendar() : WEEKDAYS;
    } catch {
      return WEEKDAYS;
    }
  };
  const revisions = () => (demo ? demoRevisions(today()) : SHIPPED_REVISIONS);

  // ── source switch and archive client ──
  function archiveInfo() {
    if (demo) return { enabled: false, setBy: "demo", client: null };
    if (!ref) return { enabled: false, setBy: "unavailable", client: null };
    try {
      // ReferenceData.archives() is a contract method (core/contracts.mjs): the switch and the shared archive client.
      const a = ref.archives();
      return { enabled: Boolean(a?.enabled), setBy: a?.setBy ?? null, client: opts.client ?? a?.client ?? null };
    } catch {
      return { enabled: false, setBy: "unavailable", client: null };
    }
  }

  // ── demo days ──
  const demoCache = new Map();
  /**
   * The demo's back-fill window: `backfill.days` weekdays ending on the newest weekday whose file is "out" (today
   * after 19:10 IST, else the weekday before). The demo history holds exactly this window, so the status line
   * ("483 of 500 trading days") and the history panel count the same days.
   */
  let demoWin = { key: null, dates: [] };
  function demoWindow() {
    const t = today();
    const key = `${t}|${istClockOf(now()) >= DEMO_PUBLISH}`;
    if (demoWin.key === key) return demoWin.dates;
    const isWd = (d) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6;
    let d = isWd(t) && istClockOf(now()) >= DEMO_PUBLISH ? t : addDays(t, -1);
    const dates = [];
    for (let i = 0; dates.length < Math.max(1, cfg.backfill.days) && i < 4000; i += 1, d = addDays(d, -1)) if (isWd(d)) dates.push(d);
    demoWin = { key, dates };
    return dates;
  }
  /** The demo day for a date, or null (no file, outside the demo window, or not yet "published": 19:10 IST). */
  function demoDay(date) {
    const t = today();
    if (date > t) return null;
    if (date === t && istClockOf(now()) < DEMO_PUBLISH) return null;
    const win = demoWindow();
    if (date < win[win.length - 1]) return null;
    if (demoCache.has(date)) return demoCache.get(date);
    const base = demoParticipantDay(date);
    const day = base
      ? {
          v: 1,
          date,
          exchange: "NSE",
          source: DEMO_SOURCE,
          fetchedAt: istIso(istInstant(date, "19:11") + 42_003),
          sha256: null,
          quality: "ok",
          unit: "contracts",
          lotRegime: lotRegimeOn(date, revisions()),
          rows: base.rows,
        }
      : null;
    if (demoCache.size > 2000) demoCache.clear();
    demoCache.set(date, day);
    return day;
  }

  const dayOf = (date) => (demo ? demoDay(date) : (days.get(date) ?? null));

  /** Newest stored (or demo) day on or before `date`. */
  function dayOnOrBefore(date) {
    if (demo) {
      let d = date;
      for (let i = 0; i < 20; i += 1, d = addDays(d, -1)) {
        const x = demoDay(d);
        if (x) return x;
      }
      return null;
    }
    let best = null;
    for (const [d, v] of days) if (d <= date) best = v;
    return best;
  }
  const latestDay = () => dayOnOrBefore(today());
  const previousDay = (date) => dayOnOrBefore(addDays(date, -1));

  /** Days in [from, to], oldest first. */
  function daysIn(from, to) {
    if (demo) {
      const out = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const x = demoDay(d);
        if (x) out.push(x);
      }
      return out;
    }
    return [...days.values()].filter((d) => d.date >= from && d.date <= to);
  }
  /** The last n days ending on `date`, oldest first. */
  function lastDays(date, n) {
    if (demo) {
      const out = [];
      let d = date;
      for (let i = 0; out.length < n && i < n * 2 + 30; i += 1, d = addDays(d, -1)) {
        const x = demoDay(d);
        if (x) out.unshift(x);
      }
      return out;
    }
    const list = [...days.values()].filter((d) => d.date <= date);
    return list.slice(-n);
  }

  // ── contract: latest ──
  function latest({ exchange = "NSE" } = {}) {
    const ex = String(exchange ?? "NSE").toUpperCase();
    if (ex === "BSE" || ex === "BFO") return { available: false, reason: "NOT_FOR_BSE", detail: "No BSE participant file: NSE publishes participant-wise OI; no BSE equivalent was located." };
    const d = latestDay();
    if (!d) {
      if (!demo && !ref) return { available: false, reason: "SOURCE_UNAVAILABLE", detail: "Reference data is not running on this Bridge." };
      if (!demo && !archiveInfo().enabled) return { available: false, reason: "SOURCE_OFF", detail: "Turn on NSE archive downloads (Market calendar page) to fetch participant OI." };
      return { available: false, reason: "NO_PARTICIPANT_DATA", detail: `No participant OI file yet. The first one arrives after ${cfg.fetchAt} IST on a trading day.` };
    }
    if (!demo) {
      const prev = cal().prevTradingDay(today(), "NFO");
      if (d.date < prev) return { available: false, reason: "PARTICIPANT_STALE", detail: `The latest participant file is for ${d.date}, older than the previous trading day (${prev}).`, asOfDate: d.date };
    }
    const rows = [];
    for (const participant of PARTICIPANTS) for (const instrument of INSTRUMENTS) {
      const v = d.rows?.[participant]?.[instrument];
      if (Array.isArray(v)) rows.push({ participant, instrument, long: v[0], short: v[1] });
    }
    return { available: true, asOfDate: d.date, source: demo ? DEMO_SOURCE : "nse-participant-oi", file: d.source, unit: "contracts", quality: d.quality ?? "ok", lotRegime: d.lotRegime ?? null, rows };
  }

  // ── contract: series ──
  function series({ from, to, participants, instruments } = {}) {
    const t = today();
    const end = to ?? t;
    const start = from ?? addDays(end, -59);
    if (!isIsoDate(start)) throw invalid("from", "from must be a real date, YYYY-MM-DD.");
    if (!isIsoDate(end)) throw invalid("to", "to must be a real date, YYYY-MM-DD.");
    if (start > end) throw invalid("from", "from must not be after to.");
    if (calendarDaysBetween(start, end) > MAX_RANGE_DAYS) throw invalid("to", `The range is at most ${MAX_RANGE_DAYS} days.`);
    const ps = participants?.length ? participants : PARTICIPANT_ROWS;
    const xs = instruments?.length ? instruments : INSTRUMENTS;
    for (const p of ps) if (!PARTICIPANT_ROWS.includes(p)) throw invalid("participants", `participants must be from ${PARTICIPANT_ROWS.join(", ")}.`);
    for (const x of xs) if (!INSTRUMENTS.includes(x)) throw invalid("instruments", `instruments must be from ${INSTRUMENTS.join(", ")}.`);
    return daysIn(start, end).map((d) => ({
      date: d.date,
      exchange: "NSE",
      unit: "contracts",
      quality: d.quality ?? "ok",
      lotRegime: d.lotRegime ?? null,
      source: d.source,
      rows: Object.fromEntries(ps.filter((p) => d.rows?.[p]).map((p) => [p, Object.fromEntries(xs.filter((x) => d.rows[p][x]).map((x) => [x, d.rows[p][x]]))])),
    }));
  }

  /** CSV rows (header first) for a series request. */
  function seriesCsv(q) {
    return csvRows(series(q), { participants: q.participants?.length ? q.participants : PARTICIPANT_ROWS, instruments: q.instruments?.length ? q.instruments : INSTRUMENTS });
  }

  // ── summary (§4.2.2) ──
  function summary({ date, historyDays = SUMMARY_HISTORY_DAYS } = {}) {
    if (date !== undefined && date !== null && date !== "" && !isIsoDate(String(date))) throw invalid("date", "date must be a real date, YYYY-MM-DD.");
    const day = date ? dayOf(String(date)) : latestDay();
    if (!day) {
      if (date) {
        if (!demo && (!ref || !archiveInfo().enabled) && !days.size) return unavailableSummary();
        throw notFound(date);
      }
      return unavailableSummary();
    }
    const prev = previousDay(day.date);
    const history = lastDays(day.date, Math.max(2, Math.min(750, historyDays)));
    // Freshness (§6.7): the latest day is "stale" when it is older than the previous trading day. A day asked for by
    // date is what was asked for, so it is never stale.
    let fresh = {};
    if (!demo && !date) {
      const expected = expectedLatest();
      const prevTd = cal().prevTradingDay(today(), "NFO");
      fresh = { stale: day.date < prevTd, expectedDate: expected };
    } else fresh = { stale: false, expectedDate: day.date };
    return { available: true, ...buildSummary({ day, prev, history, revisions: revisions() }), source: day.source, fetchedAt: day.fetchedAt ?? null, ...fresh, demo };
  }
  function unavailableSummary() {
    const l = latest({ exchange: "NSE" });
    return { available: false, reason: l.reason, detail: l.detail, exchange: "NSE", unit: "contracts", demo };
  }

  // ── trading-day helpers ──
  /** The newest date a file can exist for now: today after the publish time on a trading day, else the previous one. */
  function expectedLatest() {
    const t = today();
    const c = cal();
    if (c.isTradingDay(t, "NFO") && istClockOf(now() - jitterMs) >= cfg.fetchAt) return t;
    return c.prevTradingDay(t, "NFO");
  }
  /** The back-fill target: `days` trading days ending at expectedLatest(), newest first. */
  function targetDates() {
    const c = cal();
    const out = [];
    let d = expectedLatest();
    for (let i = 0; i < cfg.backfill.days; i += 1) {
      out.push(d);
      d = c.prevTradingDay(d, "NFO");
    }
    return out;
  }

  // ── fetching ──
  /**
   * Fetch, parse, validate and store one date.
   * @param {string} date @param {"daily"|"catchup"|"backfill"|"manual"} kind
   * @returns {Promise<{ ok: true, date, changed } | { ok: false, date, code, noFile?: boolean }>}
   */
  async function fetchDay(date, kind) {
    const info = archiveInfo();
    if (!ref) return { ok: false, date, code: "SOURCE_UNAVAILABLE" };
    if (!info.enabled) return { ok: false, date, code: "SOURCE_OFF" };
    const client = info.client;
    if (!client || !store) return { ok: false, date, code: "SOURCE_UNAVAILABLE" };
    const at = istIso(now());
    state.lastFetch = { date, kind, at };
    if (kind === "daily") state.lastDaily = { date, at };
    let lastErr = null;
    let all404 = true;
    for (const tpl of cfg.urls) {
      const path = pathFor(tpl, date);
      let file;
      try {
        file = await client.fetchFile("participantoi", date, { path });
      } catch (err) {
        lastErr = err;
        if (err?.httpStatus !== 404) all404 = false;
        if (err?.code === "UPSTREAM_RATE_LIMITED") break;
        continue;
      }
      let parsed;
      try {
        parsed = parseParticipantOi(file.buf.toString("utf8"), { date });
      } catch (err) {
        const code = err instanceof ParticipantParseError ? "PARSE_FAILED" : "INTERNAL";
        state.lastError = { code, detail: String(err?.detail ?? err?.message ?? err).slice(0, 300), date, at };
        bumpFailed(date, code, kind);
        save();
        return { ok: false, date, code };
      }
      const name = basename(path);
      try {
        store.saveRaw(date, name, file.buf, file.sha256);
      } catch (err) {
        log?.warn?.("participants: raw copy not kept", { err: String(err?.message ?? err) });
      }
      const day = {
        v: 1,
        date,
        exchange: "NSE",
        source: `nse-archives:${name}`,
        fetchedAt: at,
        sha256: file.sha256,
        quality: parsed.quality,
        ...(parsed.mismatches.length ? { mismatches: parsed.mismatches } : {}),
        ...(parsed.missing.length ? { missing: parsed.missing } : {}),
        unit: "contracts",
        lotRegime: lotRegimeOn(date, revisions()),
        rows: parsed.rows,
      };
      const before = days.get(date);
      const changed = !before || before.sha256 !== day.sha256;
      if (changed) {
        store.putDay(day);
        days.set(date, day);
        days = new Map([...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      }
      if (!state.lastSuccessDate || date > state.lastSuccessDate) state.lastSuccessDate = date;
      delete state.attempts[date];
      delete state.backfill.failed[date];
      state.backfill.noFile = state.backfill.noFile.filter((d) => d !== date);
      state.lastError = null;
      save();
      try {
        deps.bus?.emit?.("participants.updated", { date, source: day.source, changed });
      } catch {
        /* a listener failing never fails the fetch */
      }
      return { ok: true, date, changed };
    }
    const code = all404 && lastErr ? "NO_FILE" : (lastErr?.code ?? "UPSTREAM_ERROR");
    state.lastError = { code, detail: String(lastErr?.detail ?? lastErr?.message ?? "fetch failed").slice(0, 300), date, at };
    let noFile = false;
    if (all404 && lastErr) {
      // Today's file may simply not be out yet: while today's publish window is open (until retryUntil), a 404 for
      // today never counts, whoever asked (the daily fetch or a manual sync). Otherwise a back-fill, catch-up or
      // manual 404 counts, and two make "noFile".
      const windowOpen = date >= today() && istClockOf(now() - jitterMs) <= cfg.retryUntil;
      const n = (state.attempts[date]?.notFound ?? 0) + (kind === "daily" || windowOpen ? 0 : 1);
      state.attempts[date] = { notFound: n, at };
      if ((kind === "catchup" && !windowOpen) || n >= 2) {
        noFile = true;
        if (!state.backfill.noFile.includes(date)) state.backfill.noFile.push(date);
        state.backfill.noFile.sort();
        delete state.attempts[date];
      }
    } else bumpFailed(date, code, kind);
    save();
    return { ok: false, date, code, ...(noFile ? { noFile: true } : {}) };
  }
  /**
   * Count a failure toward the back-fill's skip threshold (3). Only back-fill attempts count, and only failures that
   * a retry will not fix by itself: a rate limit, a timeout or an NSE 5xx is transient, and the daily fetch's evening
   * retries never count, so one evening of NSE outage never drops that day from the history (§2.5: a missed day is
   * picked up later). 404s are counted separately (state.attempts, two make "noFile").
   */
  function bumpFailed(date, code, kind) {
    if (kind !== "backfill" || TRANSIENT_CODES.has(code)) return;
    state.backfill.failed[date] = (state.backfill.failed[date] ?? 0) + 1;
  }
  const isNoFile = (date) => Boolean(state?.backfill.noFile.includes(date));

  // ── back-fill ──
  let backfilling = false;
  let stopped = false;
  /** Back-fill fetch times in the last hour: the maxPerRun cap is over a rolling 60 minutes (§8: ≤ 120 files an hour). */
  let recentFetches = [];
  /** True while the back-fill is paused after NSE refused it (state.backfill.pausedUntil). */
  const backfillPaused = (ms) => {
    const until = state?.backfill.pausedUntil ? Date.parse(state.backfill.pausedUntil) : NaN;
    return Number.isFinite(until) && ms < until;
  };
  function pauseBackfill(code) {
    const n = Math.max(0, Number(state.backfill.pauses) || 0) + 1;
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(n - 1, 10));
    state.backfill.pauses = n;
    state.backfill.pausedUntil = istIso(now() + ms);
    state.backfill.lastErrorCode = code;
  }
  const inQuietHours = (ms) => {
    const t = istClockOf(ms);
    return t >= cfg.backfill.notDuring.from && t < cfg.backfill.notDuring.to;
  };
  /** The next date the back-fill should try (newest first, below the cursor), or null when covered. */
  function nextBackfillDate() {
    const t = today();
    const targets = targetDates();
    const pick = (cursor) => {
      for (const d of targets) {
        if (d >= t) continue; // today's file belongs to the daily fetch
        if (cursor && d >= cursor) continue;
        if (days.has(d) || isNoFile(d)) continue;
        if ((state.backfill.failed[d] ?? 0) >= 3) continue;
        return d;
      }
      return null;
    };
    const d = pick(state.backfill.cursor);
    if (d || !state.backfill.cursor) return d;
    // End of a pass: start again from the newest date for the ones that failed once (a second 404 makes "noFile").
    const again = pick(null);
    if (again) state.backfill.cursor = null;
    return again;
  }
  /** Run one back-fill batch (respects quiet hours, gap and the hourly cap). Resolves with what it did. */
  async function runBackfill({ max = cfg.backfill.maxPerRun } = {}) {
    const out = { fetched: [], noFile: [], failed: [] };
    if (backfilling || demo || !store || !cfg.backfill.enabled) return out;
    backfilling = true;
    try {
      while (!stopped) {
        const t = now();
        recentFetches = recentFetches.filter((x) => t - x < 3_600_000);
        if (recentFetches.length >= cfg.backfill.maxPerRun || out.fetched.length + out.noFile.length + out.failed.length >= max) break;
        if (inQuietHours(t) || backfillPaused(t)) break;
        if (!archiveInfo().enabled) break;
        const d = nextBackfillDate();
        if (!d) {
          state.backfill.done = true;
          save();
          break;
        }
        state.backfill.done = false;
        recentFetches.push(t);
        const r = await fetchDay(d, "backfill");
        state.backfill.cursor = d;
        save();
        if (r.ok) {
          out.fetched.push(d);
          if (state.backfill.pauses || state.backfill.lastErrorCode) {
            state.backfill.pauses = 0;
            state.backfill.pausedUntil = null;
            state.backfill.lastErrorCode = null;
            save();
          }
        } else if (r.noFile) out.noFile.push(d);
        else {
          out.failed.push({ date: d, code: r.code });
          if (BACKOFF_CODES.has(r.code)) {
            pauseBackfill(r.code);
            save();
            break;
          }
          if (r.code === "SOURCE_OFF" || r.code === "SOURCE_UNAVAILABLE") break;
          // A 404 that is not yet "noFile" is retried once later: step the cursor back over it for now.
        }
        if (!stopped) await sleep(cfg.backfill.gapSeconds * 1000);
      }
    } finally {
      backfilling = false;
    }
    return out;
  }

  // ── scheduler (minute tick) ──
  let ticking = false;
  let catchUpDone = null; // IST date of the last morning catch-up
  let prunedOn = null; // IST date of the last raw-file retention pass
  /** One scheduler step (exported for tests). */
  async function tick() {
    if (ticking || demo || !cfg.enabled || !store) return null;
    if (!archiveInfo().enabled) return null;
    ticking = true;
    try {
      const t = now();
      const d = today();
      const c = cal();
      const clock = istClockOf(t - jitterMs);
      const done = [];
      // Daily: fetchAt .. retryUntil on trading days, every retryEveryMinutes.
      if (c.isTradingDay(d, "NFO") && clock >= cfg.fetchAt && clock <= cfg.retryUntil && !days.has(d) && !isNoFile(d)) {
        const last = state.lastDaily?.date === d ? Date.parse(state.lastDaily.at) : 0;
        if (!last || t - last >= cfg.retryEveryMinutes * 60_000 - 1000) done.push(await fetchDay(d, "daily"));
      }
      // Catch-up for the previous trading day: once per IST day, at the first tick between morningCatchUp and
      // fetchAt (one file through the shared gap-limited client; notDuring is a back-fill rule and does not block
      // it), so a Bridge started at 10:30 after a night off gets the previous day's file instead of staying stale
      // until 15:45. From fetchAt on, the daily fetch and the evening back-fill cover a missing day.
      if (clock >= cfg.morningCatchUp && clock < cfg.fetchAt && catchUpDone !== d) {
        catchUpDone = d;
        const p = c.prevTradingDay(d, "NFO");
        if (!days.has(p) && !isNoFile(p)) done.push(await fetchDay(p, "catchup"));
      }
      // Back-fill whenever a target day is missing, not only until the first pass is done: a day missed while the
      // Bridge was off, or a failed daily fetch, is picked up on a later tick (BRD §7.7).
      if (cfg.backfill.enabled && !backfilling && !inQuietHours(t) && !backfillPaused(t) && (!state.backfill.done || nextBackfillDate())) {
        runBackfill().catch((err) => log?.warn?.("participants back-fill failed", { err: String(err?.message ?? err) }));
      }
      if (prunedOn !== d) {
        prunedOn = d;
        store.prune(cfg.retentionDays, d);
      }
      return done;
    } finally {
      ticking = false;
    }
  }

  function nextRunAt() {
    if (demo || !cfg.enabled || !archiveInfo().enabled) return null;
    const t = now();
    const d = today();
    const c = cal();
    const start = istInstant(d, cfg.fetchAt) + jitterMs;
    const end = istInstant(d, cfg.retryUntil) + jitterMs;
    if (c.isTradingDay(d, "NFO") && !days.has(d) && !isNoFile(d) && t <= end) {
      if (t < start) return istIso(start);
      const last = state.lastDaily?.date === d ? Date.parse(state.lastDaily.at) : 0;
      return istIso(Math.max(t, last + cfg.retryEveryMinutes * 60_000));
    }
    return istIso(istInstant(c.nextTradingDay(d, "NFO"), cfg.fetchAt) + jitterMs);
  }

  // ── contract: status ──
  function status() {
    const info = archiveInfo();
    if (demo) {
      const target = demoWindow();
      const have = target.filter((x) => demoHasFile(x)).length;
      return {
        enabled: cfg.enabled,
        demo: true,
        source: { nseArchives: "demo", setBy: "demo", verified: false },
        latestDate: latestDay()?.date ?? null,
        lastAttemptAt: null,
        lastError: null,
        nextRunAt: istIso(istInstant(demoHasFile(today()) && istClockOf(now()) < DEMO_PUBLISH ? today() : addDays(today(), 1), DEMO_PUBLISH)),
        backfill: { enabled: true, target: target.length, have, noFile: target.length - have, failed: 0, running: false, cursor: target[target.length - 1] ?? null, done: true, pausedUntil: null, lastErrorCode: null },
        rows: have,
        diskBytes: 0,
      };
    }
    const target = cfg.enabled ? targetDates() : [];
    const have = target.filter((x) => days.has(x)).length;
    const noFile = target.filter((x) => isNoFile(x)).length;
    return {
      enabled: cfg.enabled,
      demo: false,
      source: { nseArchives: !ref ? "unavailable" : info.enabled ? "on" : "off", setBy: info.setBy, verified: false },
      latestDate: [...days.keys()].pop() ?? null,
      lastAttemptAt: state?.lastFetch?.at ?? null,
      lastError: !ref ? { code: "SOURCE_UNAVAILABLE", detail: "Reference data is not running on this Bridge." } : (state?.lastError ?? null),
      nextRunAt: nextRunAt(),
      backfill: {
        enabled: cfg.backfill.enabled,
        target: target.length,
        have,
        noFile,
        failed: Object.keys(state?.backfill.failed ?? {}).length,
        running: backfilling,
        cursor: state?.backfill.cursor ?? null,
        done: Boolean(state?.backfill.done),
        pausedUntil: state && backfillPaused(now()) ? state.backfill.pausedUntil : null,
        lastErrorCode: state?.backfill.lastErrorCode ?? null,
      },
      rows: days.size,
      diskBytes: store ? store.diskBytes() : 0,
    };
  }

  // ── contract: sync ──
  async function sync({ date, backfill = false } = {}) {
    if (date !== undefined && date !== null && !isIsoDate(String(date))) throw invalid("date", "date must be a real date, YYYY-MM-DD.");
    if (demo) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Demo mode generates participant OI on this computer; nothing is fetched.");
    if (!ref) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Reference data (NSE archive client) is not running on this Bridge.");
    if (!archiveInfo().enabled) throw new BridgeError("CAPABILITY_UNSUPPORTED", "NSE archive downloads are off. Turn them on on the Market calendar page first.");
    const out = { fetched: [], noFile: [], failed: [] };
    const d = date ?? expectedLatest();
    if (d > today()) throw invalid("date", "date must not be in the future.");
    const r = await fetchDay(d, "manual");
    if (r.ok) out.fetched.push(d);
    else if (r.noFile) out.noFile.push(d);
    else out.failed.push({ date: d, code: r.code });
    if (backfill) {
      const b = await runBackfill();
      out.fetched.push(...b.fetched);
      out.noFile.push(...b.noFile);
      out.failed.push(...b.failed);
    }
    return out;
  }

  let interval = null;
  function start() {
    if (demo || interval || !cfg.enabled || !store) return;
    stopped = false;
    interval = timers.setInterval(() => {
      tick().catch((err) => log?.warn?.("participants tick failed", { err: String(err?.message ?? err) }));
    }, 60_000);
    interval?.unref?.();
  }
  function stop() {
    stopped = true;
    if (interval) timers.clearInterval(interval);
    interval = null;
  }

  return {
    // contract
    latest,
    series,
    status,
    sync,
    // extras for routes, MCP and tests
    summary,
    seriesCsv,
    isDemo: () => demo,
    tick,
    runBackfill,
    fetchDay,
    nextBackfillDate,
    start,
    stop,
  };
}
