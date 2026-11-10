/**
 * RecorderService (deps.recorder): saves the Bridge's own real-time data going forward, because brokers do not give
 * history for option chains, open-interest snapshots or ticks. Manual recordings (start, pause, stop) and AUTO RECORDING
 * by rules (every trading day, by itself). Real-time data only: a delayed, end-of-day or out-of-date answer is refused,
 * counted and explained, never written.
 *
 *   rule / request -> universe (symbols, collection, option window) -> session clock (market calendar)
 *     -> sampler (live feed first, then cache, then one background-priority broker call within a share cap)
 *     -> one file per symbol per IST day (files.mjs) + gaps log + counters (state.json)
 *
 * Time and I/O are injected (`now`, timers, `statfs`, the services), and nothing runs by itself except through start():
 * tests drive a manual clock. Files: <dataDir>/recordings/ (layout in files.mjs and docs/guides/recording.md).
 *
 * Disk safety: a per-recording limit, a total limit and a free-space floor. Writing stops BEFORE a limit would be passed
 * (the whole sample is dropped, a gap is logged, `recording.disk_low` says so) and starts again when room appears.
 * A warning event comes first at 90 %. Retention deletes day files older than N days and can gzip finished days.
 */
import { randomBytes } from "node:crypto";
import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { createCalendarView } from "../market/calendarView.mjs";
import { toIstIso } from "../market/time.mjs";
import { addDays, istClockOf, istDateOf } from "../reference/calendar.mjs";
import { SHARE_MAX, SHARE_MIN, createSchema, recorderConfig, rulePatchSchema, ruleSchema } from "./config.mjs";
import { createFileStore } from "./files.mjs";
import { encodeRow, rowOf } from "./format.mjs";
import { PRESETS, newRuleId, presetList, recordingIdOfRule, ruleFingerprint } from "./rules.mjs";
import { createSampler } from "./sampler.mjs";
import { createSessionClock, exchangeOfSymbols, exchangeOfUnderlying } from "./schedule.mjs";
import { createUniverseResolver } from "./universe.mjs";

const MB = 1024 * 1024;
const PERSIST_EVERY_MS = 10_000;
const HOUSEKEEPING_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
const RESOLVE_RETRY_MS = 60_000;
const WAIT_POLL_MS = 30_000;
const WAIT_MAX_MS = 5 * 60_000; // while waiting for a session: look again at least this often
const LOGIN_POLL_MS = 15_000;
const BLOCKED_POLL_MS = 30_000;
const REST_MIN_SEC = 5;
const DISK_WARN_RATIO = 0.9;

/** Plain words for each gap reason. */
export const GAP_REASONS = Object.freeze({
  "login-missing": "No broker login, so there was no data to record.",
  "feed-down": "The live feed was down and the broker could not be read instead.",
  "feed-silent": "The feed sent nothing.",
  budget: "The API budget was in use by other work; background recording yields to it.",
  "delayed-source": "The only data available was not real-time, and a recording never saves that.",
  "universe-unresolved": "The symbols to record could not be chosen (see the note on the recording).",
  "bridge-stopped": "The Bridge was not running.",
  "computer-asleep": "The computer was asleep (or the Bridge was frozen), so nothing could be recorded.",
  "disk-full": "Writing stopped because a disk limit was reached.",
  error: "The data could not be read.",
});

const iso = (ms) => toIstIso(ms);
const clock = (ms) => `${istClockOf(ms)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const friendlyAt = (ms) => {
  const d = istDateOf(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d.slice(8))} ${months[Number(d.slice(5, 7)) - 1]} ${istClockOf(ms)} IST`;
};
const mbText = (bytes) => (bytes < 0.95 * MB ? `${Math.max(0, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`);
const cutoffOf = (today, keepDays) => addDays(today, -(keepDays - 1));

/**
 * @param {any} deps  scoped deps: config, logger, bus, clock, paths, accounts, scheduler, symbols, streamHub, marketData
 * @param {{ now?: () => number, calendarView?: any, statfs?: (dir: string) => number | null, library?: () => any,
 *   setTimer?: Function, clearTimer?: Function }} [opts]
 */
export function createRecorderService(deps, opts = {}) {
  const cfg = recorderConfig(deps.config);
  const log = deps.logger.child({ module: "recorder" });
  const now = opts.now ?? (() => deps.clock.now());
  const setTimer = opts.setTimer ?? (deps.clock.setTimeout ? deps.clock.setTimeout.bind(deps.clock) : setTimeout);
  const clearTimer = opts.clearTimer ?? (deps.clock.clearTimeout ? deps.clock.clearTimeout.bind(deps.clock) : clearTimeout);
  const bus = deps.bus;
  const store = createFileStore({ root: join(deps.paths.dataDir, "recordings"), statfs: opts.statfs });
  const sessions = createSessionClock({ calendarView: opts.calendarView ?? createCalendarView({ now }) });
  let libraryFn = opts.library ?? (() => null);
  /** The share in force: the one set at run time (settings.json) or else the config value. Read on every call. */
  const share = () => settings.maxBudgetShare ?? cfg.maxBudgetShare;
  const sampler = createSampler({ marketData: deps.marketData, streamHub: deps.streamHub, scheduler: deps.scheduler, accounts: deps.accounts, now, share });
  const resolver = createUniverseResolver({ marketData: deps.marketData, symbols: deps.symbols, library: () => libraryFn(), now, share });

  /** @type {Map<string, any>} */
  const recs = new Map();
  let rules = []; // user rules (rules.json)
  let settings = { autoRecord: {} };
  const ruleBlocked = new Map(); // ruleId -> why its recording is not running
  const loginNeededOn = new Set(); // IST dates account.login_needed was emitted
  const warned = new Set(); // "<date>|<scope>|<id>" disk warnings sent
  let backoffUntil = 0;
  let started = false;
  let housekeeping = null;
  let lastSweepAt = 0;
  let lastSweepDate = "";
  const offBus = [];

  const emit = (topic, payload) => {
    try {
      bus?.emit(topic, payload);
    } catch (err) {
      log.warn("event could not be emitted", { topic, err: err?.message });
    }
  };

  // ───────────────────────────── persistence ─────────────────────────────

  const loadRoot = () => {
    rules = (store.readRoot("rules.json", { rules: [] }).rules ?? []).filter((r) => r && typeof r.id === "string");
    settings = store.readRoot("settings.json", { autoRecord: {} });
    // A hand-edited file never breaks a read: a share outside the range is ignored (the config value stays).
    if (!(Number.isFinite(settings.maxBudgetShare) && settings.maxBudgetShare >= SHARE_MIN && settings.maxBudgetShare <= SHARE_MAX)) delete settings.maxBudgetShare;
  };
  const saveRules = () => store.writeRoot("rules.json", { rules });
  const saveSettings = () => store.writeRoot("settings.json", settings);

  function persist(rec, force = false) {
    const t = now();
    if (!force && t - rec.persistedAt < PERSIST_EVERY_MS) return;
    rec.persistedAt = t;
    try {
      store.writeJson(rec.def.id, "recording.json", rec.def);
      store.writeJson(rec.def.id, "state.json", {
        phase: rec.phase,
        rows: rec.rows,
        lastWriteMs: rec.lastWriteMs,
        lastDataMs: rec.lastDataMs,
        today: rec.today,
        gap: rec.gap,
        gapsTotal: rec.gapsTotal,
        calls: rec.calls,
        refused: rec.refused,
        resolved: rec.resolved,
        symbols: rec.symbols,
        windowEndMs: rec.windowEndMs,
        sessionDate: rec.sessionDate,
      });
      store.flushIndex(rec.def.id);
    } catch (err) {
      log.warn("recording state could not be saved", { id: rec.def.id, err: err?.message });
    }
  }

  // ───────────────────────────── runtime objects ─────────────────────────────

  const emptyToday = (date) => ({ date, rows: 0, bytes: 0, gaps: 0 });

  function makeRuntime(def, state = {}) {
    const id = def.id;
    return {
      def,
      timer: null,
      running: false,
      again: false,
      closed: false,
      phase: state.phase ?? "idle", // recording | waiting | blocked | idle
      rows: state.rows ?? 0,
      bytes: store.usedBytes(id),
      lastWriteMs: state.lastWriteMs ?? null,
      lastDataMs: state.lastDataMs ?? null,
      today: state.today ?? emptyToday(null),
      gap: state.gap ?? null,
      gapsTotal: state.gapsTotal ?? 0,
      calls: state.calls ?? { made: 0, saved: 0, date: null },
      refused: state.refused ?? { total: 0, last: null },
      resolved: state.resolved ?? null,
      symbols: Array.isArray(state.symbols) ? state.symbols : [],
      windowEndMs: state.windowEndMs ?? null,
      sessionDate: state.sessionDate ?? null,
      sessionBaseMs: null,
      subscribed: new Set(),
      streamRejected: 0,
      blocked: null,
      lastBlockedSweep: 0,
      lastIssue: null,
      nextAt: null,
      nextStartMs: null,
      persistedAt: 0,
      resolveRetryAt: 0,
      restored: Object.keys(state).length > 0,
      firstReason: null,
    };
  }

  const streamClient = (rec) => `recorder:${rec.def.id}`;
  const activeCount = () => [...recs.values()].filter((r) => r.def.status !== "stopped").length;
  const totalBytes = () => [...recs.values()].reduce((n, r) => n + r.bytes, 0);
  const gapAfterMs = (rec) => (cfg.gapAfterSec ?? Math.max(30, 3 * rec.def.everySec)) * 1000;
  const isDynamic = (def) => def.target.collection !== undefined || def.target.underlying !== undefined;

  // ───────────────────────────── disk ─────────────────────────────

  /** null when a write of `extra` more bytes is allowed, else why not. */
  function diskProblem(rec, extra = 0) {
    const d = rec.def;
    if (d.maxDiskMb && rec.bytes + extra > d.maxDiskMb * MB) return { scope: "recording", limitMb: d.maxDiskMb, usedMb: Math.round(rec.bytes / MB), message: `This recording has reached its own limit of ${d.maxDiskMb} MB.` };
    const total = totalBytes();
    if (total + extra > cfg.maxDiskMb * MB) return { scope: "total", limitMb: cfg.maxDiskMb, usedMb: Math.round(total / MB), message: `All recordings together have reached the limit of ${cfg.maxDiskMb} MB (recorder.maxDiskMb).` };
    const free = store.free();
    if (free !== null && free - extra < cfg.minFreeDiskMb * MB) return { scope: "volume", limitMb: cfg.minFreeDiskMb, usedMb: null, freeMb: Math.round(free / MB), message: `The disk has only ${Math.round(free / MB)} MB free (recorder.minFreeDiskMb is ${cfg.minFreeDiskMb}).` };
    return null;
  }

  function warnDisk(rec, t) {
    const date = istDateOf(t);
    const total = totalBytes();
    const checks = [];
    if (rec.def.maxDiskMb) checks.push(["recording", rec.bytes / (rec.def.maxDiskMb * MB), rec.def.maxDiskMb, rec.bytes]);
    checks.push(["total", total / (cfg.maxDiskMb * MB), cfg.maxDiskMb, total]);
    for (const [scope, ratio, limitMb, used] of checks) {
      if (ratio < DISK_WARN_RATIO) continue;
      const key = `${date}|${scope}|${scope === "total" ? "all" : rec.def.id}`;
      if (warned.has(key)) continue;
      warned.add(key);
      emit("recording.disk_low", { id: scope === "total" ? null : rec.def.id, name: rec.def.name, scope, level: "warning", stopped: false, usedMb: Math.round(used / MB), limitMb, message: `Recording uses ${Math.round(ratio * 100)} % of its ${scope === "total" ? "total" : "own"} disk limit (${limitMb} MB). It stops writing at the limit.` });
    }
    const free = store.free();
    if (free !== null && free < 2 * cfg.minFreeDiskMb * MB && cfg.minFreeDiskMb > 0) {
      const key = `${date}|volume|all`;
      if (!warned.has(key)) {
        warned.add(key);
        emit("recording.disk_low", { id: null, name: null, scope: "volume", level: "warning", stopped: false, freeMb: Math.round(free / MB), limitMb: cfg.minFreeDiskMb, message: `The disk has ${Math.round(free / MB)} MB free. Recording stops below ${cfg.minFreeDiskMb} MB.` });
      }
    }
  }

  function block(rec, problem, t) {
    if (rec.blocked) return;
    rec.blocked = { ...problem, at: iso(t) };
    rec.phase = "blocked";
    emit("recording.disk_low", { id: rec.def.id, name: rec.def.name, scope: problem.scope, level: "stopped", stopped: true, usedMb: problem.usedMb ?? null, limitMb: problem.limitMb ?? null, freeMb: problem.freeMb ?? null, message: `${problem.message} Nothing more is written until there is room.` });
    openGap(rec, t, "disk-full", problem.message);
  }

  /** Delete old days and compress finished ones, for one recording or all. */
  function sweep(rec, t = now()) {
    const today = istDateOf(t);
    const keepDays = rec.def.keepDays ?? cfg.retentionDays;
    const compress = rec.def.compress ?? cfg.compressFinished;
    if (!keepDays && !compress) return { deleted: 0, compressed: 0, freedBytes: 0 };
    const r = store.sweep(rec.def.id, { keepDays, compress, today, cutoff: cutoffOf });
    if (r.deleted || r.compressed) {
      rec.bytes = store.usedBytes(rec.def.id);
      log.info("recording files tidied", { id: rec.def.id, ...r });
    }
    return r;
  }
  function sweepAll(t = now()) {
    lastSweepAt = t;
    lastSweepDate = istDateOf(t);
    let freed = 0;
    for (const rec of recs.values()) freed += sweep(rec, t).freedBytes;
    return freed;
  }

  // ───────────────────────────── gaps ─────────────────────────────

  const gapsFile = (id) => join(store.dirOf(id), "gaps.jsonl");
  function writeGapLine(rec, g, state) {
    try {
      store.ensure(rec.def.id);
      appendFileSync(gapsFile(rec.def.id), `${JSON.stringify({ id: g.id, state, from: iso(g.from), to: g.to ? iso(g.to) : null, reason: g.reason, detail: g.detail ?? null, seconds: g.to ? Math.round((g.to - g.from) / 1000) : null })}\n`, { mode: 0o600 });
    } catch (err) {
      log.warn("a gap could not be written", { id: rec.def.id, err: err?.message });
    }
  }
  function openGap(rec, from, reason, detail) {
    if (rec.gap) return;
    rec.gap = { id: `gap_${randomBytes(3).toString("hex")}`, from, reason, detail: detail ?? GAP_REASONS[reason] ?? null };
    rec.gapsTotal += 1;
    rec.today.gaps = (rec.today.gaps ?? 0) + 1;
    writeGapLine(rec, rec.gap, "open");
    emit("recording.gap", { id: rec.def.id, name: rec.def.name, state: "open", gapId: rec.gap.id, from: iso(from), to: null, reason, message: rec.gap.detail });
    persist(rec, true);
  }
  function closeGap(rec, to) {
    const g = rec.gap;
    if (!g) return;
    g.to = Math.max(to, g.from);
    rec.gap = null;
    writeGapLine(rec, g, "closed");
    emit("recording.gap", { id: rec.def.id, name: rec.def.name, state: "closed", gapId: g.id, from: iso(g.from), to: iso(g.to), reason: g.reason, message: g.detail });
  }
  /** A stretch that is already over when we notice it (the Bridge was down). */
  function addClosedGap(rec, from, to, reason, detail) {
    openGap(rec, from, reason, detail);
    closeGap(rec, to);
  }
  function readGaps(id, limit = 20) {
    const file = gapsFile(id);
    if (!existsSync(file)) return [];
    const byId = new Map();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const g = JSON.parse(line);
        byId.set(g.id, g);
      } catch {
        /* a torn line */
      }
    }
    return [...byId.values()].slice(-limit).reverse();
  }

  // ───────────────────────────── login and feed ─────────────────────────────

  function loginState() {
    let list = [];
    try {
      list = deps.accounts?.list?.() ?? [];
    } catch {
      list = [];
    }
    const real = list.filter((a) => a.broker !== "paper" && a.enabled !== false);
    if (!real.length) return { ok: true, none: true, missing: null };
    const connected = real.some((a) => (a.session?.state ?? a.state) === "connected");
    const first = real.find((a) => (a.session?.state ?? a.state) !== "connected") ?? real[0];
    return { ok: connected, none: false, missing: connected ? null : first };
  }

  function feedDown() {
    try {
      const s = deps.streamHub?.stats?.();
      return Boolean(s?.upstreams?.length) && s.upstreams.every((u) => u.state && u.state !== "up");
    } catch {
      return false;
    }
  }

  function noteLoginNeeded(t, missing) {
    const date = istDateOf(t);
    if (loginNeededOn.has(date) || !missing) return;
    loginNeededOn.add(date);
    const st = missing.session?.state ?? missing.state;
    emit("account.login_needed", {
      accountId: missing.id,
      label: missing.label ?? missing.id,
      broker: missing.broker,
      method: missing.authKind ?? "apiKeyToken",
      reason: st === "expired" || st === "error" ? st : "missing",
      kind: "preopen",
      source: "recorder",
    });
  }

  // ───────────────────────────── the loop ─────────────────────────────

  function arm(rec, ms) {
    if (rec.timer) clearTimer(rec.timer);
    const delay = Math.max(0, Math.round(ms));
    rec.nextAt = now() + delay;
    rec.timer = setTimer(() => {
      rec.timer = null;
      void run(rec);
    }, delay);
    rec.timer?.unref?.();
  }
  function disarm(rec) {
    if (rec.timer) clearTimer(rec.timer);
    rec.timer = null;
    rec.nextAt = null;
  }
  const kick = (rec) => {
    if (rec.closed || rec.def.status !== "active") return;
    if (rec.running) rec.again = true;
    else arm(rec, 0);
  };

  async function run(rec) {
    if (rec.closed) return;
    if (rec.running) {
      rec.again = true;
      return;
    }
    rec.running = true;
    let next = WAIT_POLL_MS;
    try {
      next = (await step(rec)) ?? WAIT_POLL_MS;
    } catch (err) {
      log.error("recording step failed", { id: rec.def.id, err: err?.message });
      rec.lastIssue = { at: iso(now()), code: err?.code ?? "INTERNAL", message: err?.detail ?? err?.message ?? "unexpected error" };
    } finally {
      rec.running = false;
    }
    if (!rec.closed && rec.def.status === "active") {
      const again = rec.again;
      rec.again = false;
      arm(rec, again ? 0 : next);
    }
  }

  function targetExchange(rec) {
    if (rec.symbols.length) return exchangeOfSymbols(rec.symbols);
    const u = rec.def.target.underlying;
    if (u !== undefined) return exchangeOfUnderlying(Array.isArray(u) ? u[0] : u);
    if (rec.def.target.symbols) return exchangeOfSymbols(rec.def.target.symbols);
    return "NFO";
  }

  /** Where the recording stands against its schedule. */
  function sessionOf(rec, t) {
    if (!rec.def.schedule) return { state: "active", window: null, nextStartMs: null };
    return sessions.stateAt(t, rec.def.schedule, targetExchange(rec));
  }

  function startSession(rec, t, date, sess) {
    const wasRestored = rec.restored && rec.sessionDate === date && rec.lastDataMs !== null;
    rec.phase = "recording";
    rec.sessionDate = date;
    rec.windowEndMs = sess.window?.endMs ?? null;
    if (rec.today.date !== date) rec.today = emptyToday(date);
    const base = Math.max(sess.window?.startMs ?? 0, rec.def.activatedAt ?? 0);
    rec.sessionBaseMs = base || t;
    if (!wasRestored) rec.lastDataMs = null;
    rec.firstReason = rec.restored ? "bridge-stopped" : null;
    rec.restored = false;
    if (rec.def.source === "rule" && !wasRestored) {
      emit("recording.started", { id: rec.def.id, name: rec.def.name, auto: true, ruleId: rec.def.ruleId, date, kind: rec.def.kind, everySec: rec.def.everySec, until: sess.window?.end ?? null });
    }
    persist(rec, true);
  }

  function endSession(rec, t) {
    if (rec.gap) closeGap(rec, rec.windowEndMs ?? t);
    dropStream(rec);
    const wasRecording = rec.phase === "recording" || rec.phase === "blocked";
    rec.phase = "waiting";
    rec.blocked = null;
    persist(rec, true);
    if (wasRecording && rec.def.source === "rule") emit("recording.stopped", { id: rec.def.id, name: rec.def.name, auto: true, ruleId: rec.def.ruleId, reason: "session-end", rows: rec.today.rows, bytes: rec.today.bytes, gaps: rec.today.gaps ?? 0 });
    if (istDateOf(t) !== lastSweepDate) sweepAll(t);
  }

  function rollDay(rec, t, date) {
    rec.today = emptyToday(date);
    rec.sessionDate = date;
    rec.resolved = null;
    rec.sessionBaseMs = t;
    dropStream(rec);
    sweep(rec, t);
  }

  function dropStream(rec) {
    if (rec.subscribed.size === 0) return;
    try {
      deps.streamHub?.dropClient?.(streamClient(rec));
    } catch {
      /* the hub may be stopping */
    }
    rec.subscribed.clear();
  }

  async function ensureSubscribed(rec) {
    if (!deps.streamHub?.subscribe || cfg.maxStreamSymbols === 0) return;
    const want = rec.symbols.filter((s) => !rec.subscribed.has(s)).slice(0, Math.max(0, cfg.maxStreamSymbols - rec.subscribed.size));
    if (!want.length) return;
    try {
      const r = await deps.streamHub.subscribe(streamClient(rec), want, "quote");
      for (const s of r.accepted ?? []) rec.subscribed.add(s);
      rec.streamRejected += (r.rejected ?? []).length;
    } catch (err) {
      log.debug("live feed subscription failed", { id: rec.def.id, err: err?.message });
    }
  }

  /** Re-resolve when the day changed, on a moving window every reResolveMinutes, and after a failure. */
  async function maybeResolve(rec, t, date) {
    const r = rec.resolved;
    const dyn = isDynamic(rec.def);
    const due = !r || r.date !== date || (!r.ok && t >= rec.resolveRetryAt) || (dyn && cfg.reResolveMinutes > 0 && r.ok && t - r.atMs >= cfg.reResolveMinutes * 60_000);
    if (!due) return;
    const res = await resolver.resolve(rec.def.target, t);
    const same = r && r.date === date;
    if (res.ok) {
      const merged = same ? [...new Set([...rec.symbols, ...res.symbols])] : res.symbols;
      rec.symbols = merged.slice(0, cfg.maxSymbolsPerRecording);
      const cut = merged.length - rec.symbols.length;
      rec.resolved = { date, atMs: t, at: iso(t), ok: true, source: res.source, rule: res.rule, notes: [...res.notes, ...(cut > 0 ? [`${cut} symbol(s) were left out: a recording holds at most ${cfg.maxSymbolsPerRecording} (recorder.maxSymbolsPerRecording).`] : [])], reason: null, stale: false, count: res.symbols.length };
      rec.resolveRetryAt = 0;
      await ensureSubscribed(rec);
    } else {
      rec.resolveRetryAt = t + RESOLVE_RETRY_MS;
      if (same && rec.symbols.length) {
        rec.resolved = { ...r, atMs: r.atMs, stale: true, reason: res.reason, notes: [...(res.notes ?? [])] };
        rec.resolveRetryAt = t + RESOLVE_RETRY_MS;
      } else {
        if (!same) rec.symbols = [];
        rec.resolved = { date, atMs: t, at: iso(t), ok: false, source: res.source, rule: res.rule, notes: res.notes, reason: res.reason, stale: false, count: 0 };
      }
      rec.lastIssue = { at: iso(t), code: "UNIVERSE_UNRESOLVED", message: res.reason };
    }
  }

  function writeRows(rec, rows, t) {
    const date = istDateOf(t);
    const bySymbol = new Map();
    let bytes = 0;
    for (const r of rows) {
      const line = encodeRow(rowOf(r), rec.def.format);
      bytes += Buffer.byteLength(line);
      (bySymbol.get(r.symbol) ?? bySymbol.set(r.symbol, []).get(r.symbol)).push(line);
    }
    // Headers of new CSV files are small; count them so the cap is never passed.
    const problem = diskProblem(rec, bytes + (rec.def.format === "csv" ? 400 * bySymbol.size : 0));
    if (problem) return { blocked: problem, written: 0 };
    let written = 0;
    let wroteBytes = 0;
    try {
      for (const [symbol, lines] of bySymbol) {
        const w = store.append(rec.def.id, date, symbol, rec.def.format, lines);
        written += w.rows;
        wroteBytes += w.bytes;
      }
    } catch (err) {
      return { blocked: { scope: "volume", message: `The disk refused the write (${err?.code ?? err?.message}).`, limitMb: null, usedMb: null }, written, error: err };
    } finally {
      rec.bytes += wroteBytes;
      rec.rows += written;
      rec.today.rows += written;
      rec.today.bytes += wroteBytes;
      if (written > 0) rec.lastWriteMs = t;
    }
    return { blocked: null, written };
  }

  /** The reason an empty sample gives, most specific first. */
  function causeOf(rec, res, login) {
    if (!login.ok) return "login-missing";
    if (!rec.symbols.length) return "universe-unresolved";
    if (res.refused.length) return "delayed-source";
    if (res.deferred) return "budget";
    if (res.errors.some((e) => e.code === "UPSTREAM_RATE_LIMITED" || e.code === "RATE_LIMITED")) return "budget";
    if (feedDown() || res.errors.some((e) => ["FEED_NOT_LIVE", "UPSTREAM_ERROR", "BROKER_UNAVAILABLE", "UPSTREAM_TIMEOUT", "SESSION_EXPIRED"].includes(e.code))) return "feed-down";
    if (res.errors.length) return "error";
    return "feed-silent";
  }

  /** Stretches when the computer slept (system.resumed): a silent feed in one of them is the computer's doing, not the broker's. */
  const sleeps = [];
  const duringSleep = (from, to) => sleeps.some((s) => s.from <= to && s.to >= from);
  const sleepReason = (reason, from, to) => ((reason === "feed-silent" || reason === "feed-down") && duringSleep(from, to) ? "computer-asleep" : reason);

  function afterSample(rec, t, wrote, cause, detail) {
    const since = Math.max(rec.lastDataMs ?? 0, rec.sessionBaseMs ?? 0);
    const limit = gapAfterMs(rec);
    if (wrote) {
      if (rec.gap) {
        if (rec.gap.reason === "feed-silent" || rec.gap.reason === "feed-down") {
          const asleep = sleepReason(rec.gap.reason, rec.gap.from, t);
          if (asleep !== rec.gap.reason) Object.assign(rec.gap, { reason: asleep, detail: GAP_REASONS[asleep] });
        }
        closeGap(rec, t);
      } else if (since && t - since >= limit) {
        const reason = sleepReason(rec.firstReason ?? "feed-silent", since, t);
        addClosedGap(rec, since, t, reason, reason === "computer-asleep" ? GAP_REASONS[reason] : rec.firstReason ? GAP_REASONS[rec.firstReason] : undefined);
      }
      rec.firstReason = null;
      rec.lastDataMs = t;
      return;
    }
    if (!rec.gap && (cause === "login-missing" || (since && t - since >= limit))) openGap(rec, since || t, rec.firstReason && cause === "feed-silent" ? rec.firstReason : cause, detail);
  }

  /** One pass for a recording. Returns the delay until the next one (ms). */
  async function step(rec) {
    const d = rec.def;
    if (d.status !== "active") return null;
    const t = now();
    const date = istDateOf(t);
    let sess;
    try {
      sess = sessionOf(rec, t);
    } catch (err) {
      rec.lastIssue = { at: iso(t), code: err?.code ?? "INTERNAL", message: err?.detail ?? err?.message };
      rec.phase = "waiting";
      return WAIT_POLL_MS * 2;
    }
    if (sess.state === "waiting") {
      if (rec.phase === "recording" || rec.phase === "blocked") endSession(rec, t);
      else if (rec.phase !== "waiting") rec.phase = "waiting";
      rec.nextStartMs = sess.nextStartMs;
      persist(rec);
      return sess.nextStartMs ? Math.min(WAIT_MAX_MS, Math.max(1000, sess.nextStartMs - t)) : WAIT_MAX_MS;
    }
    rec.nextStartMs = null;
    if (rec.phase === "waiting" || rec.phase === "idle" || rec.sessionBaseMs === null) startSession(rec, t, date, sess);
    else if (rec.today.date !== date) {
      rollDay(rec, t, date);
      rec.windowEndMs = sess.window?.endMs ?? null;
    }
    rec.windowEndMs = sess.window?.endMs ?? rec.windowEndMs;
    const untilEnd = rec.windowEndMs ? Math.max(200, rec.windowEndMs - t + 500) : Infinity;

    // Disk: while blocked, look again for room (retention may have made some).
    if (rec.blocked) {
      if (t - rec.lastBlockedSweep >= 10 * 60_000) {
        rec.lastBlockedSweep = t;
        sweepAll(t);
      }
      if (diskProblem(rec, 0)) return Math.min(BLOCKED_POLL_MS, untilEnd);
      rec.blocked = null;
      rec.phase = "recording";
    }

    const login = loginState();
    if (!login.ok) {
      noteLoginNeeded(t, login.missing);
      rec.lastIssue = { at: iso(t), code: "LOGIN_MISSING", message: `${login.missing?.label ?? "The broker account"} is not logged in. Recording starts as soon as a login or a feed is available.` };
      afterSample(rec, t, false, "login-missing");
      persist(rec);
      return Math.min(LOGIN_POLL_MS, untilEnd, d.everySec * 1000);
    }

    await maybeResolve(rec, t, date);
    await ensureSubscribed(rec);
    if (!rec.symbols.length) {
      afterSample(rec, t, false, "universe-unresolved", rec.resolved?.reason);
      persist(rec);
      return Math.min(WAIT_POLL_MS, untilEnd, d.everySec * 1000);
    }

    const o = { everySec: d.everySec, maxTickAgeMs: Math.max(600_000, d.everySec * 10_000), restMinSec: REST_MIN_SEC, at: t, greeks: true, noRest: t < backoffUntil, noRestMs: Math.max(0, backoffUntil - t) };
    const res = d.kind === "chain" ? await sampler.chains(rec.symbols, o) : await sampler.quotes(rec.symbols, o);
    rec.calls = rec.calls.date === date ? rec.calls : { made: 0, saved: 0, date };
    rec.calls.made += res.madeCalls;
    rec.calls.saved += res.savedCalls;
    if (res.refused.length) {
      rec.refused.total += res.refused.length;
      rec.refused.last = { at: iso(t), count: res.refused.length, reason: res.refused[0].reason };
      rec.lastIssue = { at: iso(t), code: "NOT_REALTIME", message: `Not recorded: ${res.refused.length} answer(s) were ${res.refused[0].reason}. A recording saves real-time data only.` };
    } else if (res.errors.length && !res.rows.length) {
      rec.lastIssue = { at: iso(t), code: res.errors[0].code, message: res.errors[0].message };
    } else if (res.rows.length) rec.lastIssue = null;

    let wrote = 0;
    if (res.rows.length) {
      const w = writeRows(rec, res.rows, t);
      wrote = w.written;
      if (w.blocked) {
        block(rec, w.blocked, t);
        persist(rec, true);
        return Math.min(BLOCKED_POLL_MS, untilEnd);
      }
      warnDisk(rec, t);
    }
    afterSample(rec, t, wrote > 0, causeOf(rec, res, login), res.errors[0]?.message ?? (res.refused[0] ? `Not real-time: ${res.refused[0].reason}` : undefined));
    persist(rec);
    const spent = now() - t;
    return Math.min(Math.max(200, d.everySec * 1000 - spent), untilEnd);
  }

  // ───────────────────────────── recordings ─────────────────────────────

  function newId() {
    for (let i = 0; i < 10; i += 1) {
      const id = `rec_${randomBytes(4).toString("hex")}`;
      if (!recs.has(id)) return id;
    }
    return `rec_${randomBytes(8).toString("hex")}`;
  }

  const badRequest = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

  function checkSymbols(list, path = "symbols") {
    const out = [];
    for (const s of list) {
      try {
        out.push(parseSymbol(s).canonical);
      } catch (err) {
        throw badRequest(path, `${s}: ${err.detail ?? err.message}`);
      }
    }
    return [...new Set(out)];
  }

  /** The target part of a definition, checked and normalised. */
  function normaliseTarget(t) {
    if (t.symbols) {
      const symbols = checkSymbols(t.symbols);
      if (symbols.length > cfg.maxSymbolsPerRecording) throw badRequest("symbols", `A recording holds at most ${cfg.maxSymbolsPerRecording} symbols (recorder.maxSymbolsPerRecording); this has ${symbols.length}.`);
      return { symbols };
    }
    if (t.collection) {
      if (!libraryFn()) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Collections are not available in this Bridge, so a recording cannot use one. List the symbols instead.");
      return { collection: t.collection };
    }
    const list = (Array.isArray(t.underlying) ? t.underlying : [t.underlying]).map((u) => String(u).trim().toUpperCase());
    for (const u of list) if (!/^[A-Z0-9&_-]{1,30}$/.test(u)) throw badRequest("underlying", `${u} is not an underlying name like NIFTY or RELIANCE.`);
    const out = { underlying: list.length === 1 ? list[0] : list };
    if (t.universe) out.universe = t.universe;
    if (t.expiry) out.expiry = t.expiry;
    if (t.strikes !== undefined) out.strikes = t.strikes;
    return out;
  }

  function scheduleFor(sessionOnly, schedule, target) {
    if (!sessionOnly) return null;
    const exchange = target.symbols ? exchangeOfSymbols(target.symbols) : target.underlying ? exchangeOfUnderlying(Array.isArray(target.underlying) ? target.underlying[0] : target.underlying) : "NFO";
    if (schedule === undefined || schedule === "market-hours") {
      if (exchange === "MCX" || exchange === "CDS") throw new BridgeError("CAPABILITY_UNSUPPORTED", `The Bridge's calendar covers NSE, BSE, NFO and BFO only; ${exchange} has its own hours. Set sessionOnly to false, or use a rule with an explicit schedule.`);
      return "market-hours";
    }
    return schedule;
  }

  /** @returns {Promise<any>} the recording view */
  async function create(input, { who = "api" } = {}) {
    if (!cfg.enabled) throw new BridgeError("STATE_CONFLICT", "The recorder is switched off in the config (recorder.enabled).");
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new BridgeError("VALIDATION_FAILED", `The recording is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`, { errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const b = parsed.data;
    if (b.dataClass !== undefined && b.dataClass !== "realtime") {
      throw badRequest("dataClass", `Recordings save real-time data only. ${b.dataClass === "eod" ? "End-of-day" : "Delayed"} data is refused so that a file never mixes data of different quality; use a download for history.`);
    }
    if (activeCount() >= cfg.maxRecordings) throw new BridgeError("STATE_CONFLICT", `There are already ${cfg.maxRecordings} recordings (recorder.maxRecordings). Stop or delete one first.`);
    const target = normaliseTarget(b);
    if (target.collection) await assertCollection(target.collection);
    const schedule = scheduleFor(b.sessionOnly, "market-hours", target);
    const id = newId();
    const t = now();
    const def = {
      id,
      name: b.name ?? defaultName(b, target),
      kind: b.kind,
      source: "manual",
      ruleId: null,
      target,
      everySec: b.everySec,
      sessionOnly: b.sessionOnly,
      schedule,
      format: b.format,
      keepDays: b.keepDays ?? null,
      maxDiskMb: b.maxDiskMb ?? null,
      compress: b.compress,
      status: "active",
      createdAt: iso(t),
      activatedAt: t,
      createdBy: who,
    };
    const rec = makeRuntime(def);
    recs.set(id, rec);
    store.ensure(id);
    persist(rec, true);
    emit("recording.started", { id, name: def.name, auto: false, kind: def.kind, everySec: def.everySec, date: istDateOf(t) });
    if (started) kick(rec);
    return view(rec);
  }

  const defaultName = (b, target) => {
    const what = target.collection ? target.collection : target.underlying ? [].concat(target.underlying).join("+") : `${target.symbols.length} symbol${target.symbols.length === 1 ? "" : "s"}`;
    return `${b.kind === "chain" ? "Option chain" : "Quotes"}: ${what}`.slice(0, 60);
  };

  async function assertCollection(name) {
    const lib = libraryFn();
    if (!lib?.resolve) return;
    try {
      await lib.resolve(name);
    } catch (err) {
      if (err?.code === "NOT_FOUND") throw err;
    }
  }

  function get(id) {
    const rec = recs.get(id);
    if (!rec) throw new BridgeError("NOT_FOUND", "No recording with this id.");
    return rec;
  }

  function setStatus(rec, status, reason) {
    rec.def.status = status;
    rec.def.statusReason = reason ?? null;
    if (status === "active") rec.def.activatedAt = now();
    persist(rec, true);
  }

  function pause(id) {
    const rec = get(id);
    if (rec.def.status === "stopped") throw new BridgeError("STATE_CONFLICT", "This recording is stopped. Start a new one.");
    if (rec.def.status === "paused") return view(rec);
    disarm(rec);
    if (rec.gap) closeGap(rec, now());
    dropStream(rec);
    rec.phase = "idle";
    setStatus(rec, "paused", "manual");
    return view(rec);
  }
  function resume(id) {
    const rec = get(id);
    if (rec.def.status === "stopped") throw new BridgeError("STATE_CONFLICT", "This recording is stopped. Start a new one.");
    if (rec.def.status === "active") return view(rec);
    rec.phase = "idle";
    rec.restored = false;
    setStatus(rec, "active");
    kick(rec);
    return view(rec);
  }
  function stop(id, reason = "manual") {
    const rec = get(id);
    if (rec.def.status === "stopped") return view(rec);
    if (rec.def.source === "rule" && reason === "manual") throw new BridgeError("STATE_CONFLICT", `This recording belongs to the auto-record rule "${rec.def.ruleId}". Turn the rule off (PATCH /v1/recordings/rules/${rec.def.ruleId}) or switch auto-record off.`);
    disarm(rec);
    if (rec.gap) closeGap(rec, now());
    dropStream(rec);
    const wasRecording = rec.phase === "recording" || rec.phase === "blocked";
    rec.phase = "idle";
    setStatus(rec, "stopped", reason);
    if (rec.def.source === "manual" || wasRecording) emit("recording.stopped", { id, name: rec.def.name, auto: rec.def.source === "rule", ruleId: rec.def.ruleId, reason, rows: rec.rows, bytes: rec.bytes, gaps: rec.gapsTotal });
    return view(rec);
  }
  function remove(id) {
    const rec = get(id);
    if (rec.def.source === "rule" && allRules().some((r) => r.id === rec.def.ruleId)) throw new BridgeError("STATE_CONFLICT", `This recording belongs to the auto-record rule "${rec.def.ruleId}". Delete the rule instead (DELETE /v1/recordings/rules/${rec.def.ruleId}?deleteFiles=true).`);
    destroy(rec, "deleted");
  }
  function destroy(rec, reason) {
    const id = rec.def.id;
    rec.closed = true;
    disarm(rec);
    dropStream(rec);
    if (rec.def.status !== "stopped" && rec.def.source === "manual") emit("recording.stopped", { id, name: rec.def.name, auto: false, reason, rows: rec.rows, bytes: rec.bytes, gaps: rec.gapsTotal });
    recs.delete(id);
    store.removeAll(id);
  }

  // ───────────────────────────── views ─────────────────────────────

  function statusText(rec) {
    const d = rec.def;
    if (d.damaged) return "Damaged: the recording's settings file could not be read and was set aside. Its saved files are kept. Delete it, or start a new recording.";
    if (d.status === "stopped") return d.statusReason === "rule-off" ? "Stopped: the rule is off." : "Stopped.";
    if (d.status === "paused") return "Paused.";
    if (rec.blocked) return `Not writing: ${rec.blocked.message}`;
    if (!d.schedule && rec.phase === "idle") return "Starting.";
    if (rec.phase === "waiting" || rec.phase === "idle") return rec.nextStartMs ? `Waiting for the next session: ${friendlyAt(rec.nextStartMs)}.` : "Waiting for the next trading session.";
    if (rec.resolved && !rec.resolved.ok) return `Waiting to choose the symbols: ${rec.resolved.reason}`;
    if (rec.gap) return `${GAP_REASONS[rec.gap.reason] ?? "No data."} Since ${clock(rec.gap.from)} IST.`;
    return `Recording ${rec.symbols.length} symbol${rec.symbols.length === 1 ? "" : "s"} every ${d.everySec} s${rec.lastWriteMs ? `, last write ${clock(rec.lastWriteMs)} IST` : ""}.`;
  }

  function view(rec, { detail = false } = {}) {
    const d = rec.def;
    const t = now();
    const files = detail ? store.list(d.id) : null;
    const state = d.status !== "active" ? d.status : rec.blocked ? "blocked" : rec.phase === "recording" ? "recording" : "waiting";
    const out = {
      id: d.id,
      name: d.name,
      kind: d.kind,
      status: state,
      statusText: statusText(rec),
      ...(d.damaged ? { damaged: true } : {}),
      auto: d.source === "rule",
      ruleId: d.ruleId,
      target: d.target,
      everySec: d.everySec,
      sessionOnly: d.sessionOnly,
      schedule: d.schedule ?? "always",
      format: d.format,
      createdAt: d.createdAt,
      dataClass: "realtime",
      delaySec: 0,
      source: "this Bridge's own live feed and broker reads (real-time class only; delayed and end-of-day data is refused)",
      symbols: { count: rec.symbols.length, sample: rec.symbols.slice(0, 10), resolvedAt: rec.resolved?.at ?? null, rule: rec.resolved?.rule ?? null, via: rec.resolved?.source ?? null, notes: rec.resolved?.notes ?? [], stale: rec.resolved?.stale === true, problem: rec.resolved && !rec.resolved.ok ? rec.resolved.reason : rec.resolved?.stale ? rec.resolved.reason : null, onLiveFeed: rec.subscribed.size, notOnLiveFeed: rec.streamRejected },
      rows: rec.rows,
      bytes: rec.bytes,
      today: { date: rec.today.date, rows: rec.today.rows, bytes: rec.today.bytes, gaps: rec.today.gaps ?? 0 },
      lastWriteAt: rec.lastWriteMs ? iso(rec.lastWriteMs) : null,
      gaps: { total: rec.gapsTotal, today: rec.today.gaps ?? 0, open: rec.gap ? { from: iso(rec.gap.from), reason: rec.gap.reason, message: rec.gap.detail } : null, recent: detail ? readGaps(d.id, 20) : undefined },
      refused: { total: rec.refused.total, last: rec.refused.last },
      apiCalls: { madeToday: rec.calls.date === istDateOf(t) ? rec.calls.made : 0, savedToday: rec.calls.date === istDateOf(t) ? rec.calls.saved : 0 },
      disk: { usedBytes: rec.bytes, limitMb: d.maxDiskMb ?? null, totalUsedBytes: totalBytes(), totalLimitMb: cfg.maxDiskMb, blocked: rec.blocked ? { scope: rec.blocked.scope, message: rec.blocked.message, at: rec.blocked.at } : null },
      keepDays: d.keepDays ?? cfg.retentionDays,
      nextStartAt: rec.nextStartMs ? iso(rec.nextStartMs) : null,
      issue: rec.lastIssue,
      filesUrl: `/v1/recordings/${d.id}/files`,
    };
    if (detail) out.files = { count: files.length, firstDate: files[0]?.date ?? null, lastDate: files.at(-1)?.date ?? null };
    return out;
  }

  const list = () => [...recs.values()].sort((a, b) => a.def.createdAt.localeCompare(b.def.createdAt)).map((r) => view(r));
  const getView = (id) => view(get(id), { detail: true });
  const files = (id) => store.list(get(id).def.id).map((f) => ({ ...f, url: `/v1/recordings/${id}/files/${f.name}` }));
  function openFile(id, name) {
    const rec = get(id);
    const f = store.open(rec.def.id, name);
    if (!f) throw new BridgeError("NOT_FOUND", "No such file in this recording.");
    return { ...f, name, stream: () => store.stream(f.path) };
  }

  // ───────────────────────────── rules ─────────────────────────────

  const configRules = () =>
    cfg.autoRecord.rules.map((r, i) => ({ ...r, id: r.id ?? `cfg-${i + 1}`, source: "config", createdAt: null, updatedAt: null }));
  const allRules = () => [...configRules(), ...rules.map((r) => ({ ...r, source: "user" }))];
  const autoOn = () => settings.autoRecord?.enabled ?? cfg.autoRecord.enabled;

  function ruleView(r) {
    const rec = recs.get(recordingIdOfRule(r.id));
    const { source, ...plan } = r;
    return { ...plan, source, recordingId: rec ? rec.def.id : null, state: rec ? view(rec).status : autoOn() && r.enabled ? "waiting" : "off", statusText: rec ? statusText(rec) : ruleBlocked.get(r.id) ?? (autoOn() ? (r.enabled ? "Starting." : "This rule is off.") : "Auto-record is off."), blockedBy: ruleBlocked.get(r.id) ?? null };
  }

  function defFromRule(rule, prev) {
    const target = normaliseRuleTarget(rule);
    return {
      id: recordingIdOfRule(rule.id),
      name: rule.name,
      kind: rule.kind,
      source: "rule",
      ruleId: rule.id,
      fingerprint: ruleFingerprint(rule),
      target,
      everySec: rule.everySec,
      sessionOnly: true,
      schedule: rule.schedule ?? "market-hours",
      format: rule.format ?? "csv",
      keepDays: rule.keepDays ?? null,
      maxDiskMb: rule.maxDiskMb ?? null,
      compress: rule.compress,
      status: prev?.status ?? "active",
      statusReason: prev?.statusReason ?? null,
      createdAt: prev?.createdAt ?? iso(now()),
      activatedAt: prev?.activatedAt ?? now(),
    };
  }
  function normaliseRuleTarget(rule) {
    const t = {};
    if (rule.symbols) t.symbols = checkSymbols(rule.symbols);
    else if (rule.collection) t.collection = rule.collection;
    else {
      t.underlying = (Array.isArray(rule.underlying) ? rule.underlying : [rule.underlying]).map((u) => String(u).toUpperCase());
      if (t.underlying.length === 1) t.underlying = t.underlying[0];
      t.universe = rule.universe ?? { expiries: "current-weekly", strikes: { around: "atm", count: 10 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false };
    }
    return t;
  }

  /** Make the recordings match the rules and the auto-record switch. Safe to call at any time. */
  function syncRules() {
    const on = autoOn() && cfg.enabled;
    const seen = new Set();
    for (const rule of allRules()) {
      const rid = recordingIdOfRule(rule.id);
      seen.add(rid);
      const rec = recs.get(rid);
      const want = on && rule.enabled !== false;
      if (want) {
        ruleBlocked.delete(rule.id);
        if (!rec) {
          if (activeCount() >= cfg.maxRecordings) {
            ruleBlocked.set(rule.id, `Not started: there are already ${cfg.maxRecordings} recordings (recorder.maxRecordings).`);
            continue;
          }
          let def;
          try {
            def = defFromRule(rule);
          } catch (err) {
            ruleBlocked.set(rule.id, `Not started: ${err.detail ?? err.message}`);
            continue;
          }
          const fresh = makeRuntime(def);
          recs.set(rid, fresh);
          store.ensure(rid);
          persist(fresh, true);
          if (started) kick(fresh);
        } else {
          const fp = ruleFingerprint(rule);
          const changed = rec.def.fingerprint !== fp;
          const wasOff = rec.def.status === "stopped";
          if (changed || rec.def.name !== rule.name) {
            let def;
            try {
              def = defFromRule(rule, rec.def);
            } catch (err) {
              ruleBlocked.set(rule.id, `Not updated: ${err.detail ?? err.message}`);
              continue;
            }
            rec.def = def;
            if (changed) {
              rec.resolved = null;
              rec.symbols = [];
              dropStream(rec);
            }
          }
          if (wasOff) {
            rec.def.status = "active";
            rec.def.statusReason = null;
            rec.def.activatedAt = now();
            rec.phase = "idle";
            rec.restored = false;
          }
          persist(rec, true);
          if (started && rec.def.status === "active") kick(rec);
        }
      } else if (rec && rec.def.status === "active") {
        disarm(rec);
        if (rec.gap) closeGap(rec, now());
        dropStream(rec);
        const wasRecording = rec.phase === "recording" || rec.phase === "blocked";
        rec.phase = "idle";
        setStatus(rec, "stopped", "rule-off");
        if (wasRecording) emit("recording.stopped", { id: rid, name: rec.def.name, auto: true, ruleId: rule.id, reason: on ? "rule-off" : "auto-record-off", rows: rec.today.rows, bytes: rec.today.bytes, gaps: rec.today.gaps ?? 0 });
      } else ruleBlocked.delete(rule.id);
    }
    for (const rec of recs.values()) {
      if (rec.def.source === "rule" && !seen.has(rec.def.id) && rec.def.status !== "stopped") {
        disarm(rec);
        if (rec.gap) closeGap(rec, now());
        dropStream(rec);
        rec.phase = "idle";
        setStatus(rec, "stopped", "rule-removed");
      }
    }
  }

  const checkRule = (value) => {
    const r = ruleSchema.safeParse(value);
    if (!r.success) throw new BridgeError("VALIDATION_FAILED", `The rule is not valid: ${r.error.issues.map((i) => `${i.path.join(".") || "rule"}: ${i.message}`).join("; ")}`, { errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return r.data;
  };

  async function createRule(input, extra = {}) {
    if (!cfg.enabled) throw new BridgeError("STATE_CONFLICT", "The recorder is switched off in the config (recorder.enabled).");
    const rule = checkRule(input);
    const taken = new Set(allRules().map((r) => r.id));
    if (rule.id && taken.has(rule.id)) throw new BridgeError("STATE_CONFLICT", `There is already a rule with the id ${rule.id}.`);
    if (rule.collection) {
      if (!libraryFn()) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Collections are not available in this Bridge, so a rule cannot use one. List the symbols instead.");
      await assertCollection(rule.collection);
    }
    normaliseRuleTarget(rule); // refuses bad symbols now
    if (rule.schedule === "market-hours") scheduleFor(true, "market-hours", normaliseRuleTarget(rule));
    const t = iso(now());
    const saved = { ...rule, id: rule.id ?? newRuleId(rule.name, taken), createdAt: t, updatedAt: t, ...(extra.preset ? { preset: extra.preset } : {}) };
    rules.push(saved);
    saveRules();
    syncRules();
    return ruleView({ ...saved, source: "user" });
  }

  function findRule(id) {
    const r = allRules().find((x) => x.id === id);
    if (!r) throw new BridgeError("NOT_FOUND", "No auto-record rule with this id.");
    return r;
  }
  const getRule = (id) => ruleView(findRule(id));
  const listRules = () => allRules().map(ruleView);

  async function patchRule(id, patch) {
    const current = findRule(id);
    if (current.source === "config") throw new BridgeError("STATE_CONFLICT", "This rule is written in bridge.config.json (recorder.autoRecord.rules). Change it there.");
    const p = rulePatchSchema.safeParse(patch);
    if (!p.success) throw new BridgeError("VALIDATION_FAILED", `The change is not valid: ${p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`, { errors: p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const body = p.data;
    const merged = { ...current };
    delete merged.source;
    delete merged.createdAt;
    delete merged.updatedAt;
    delete merged.preset;
    if (body.symbols !== undefined || body.collection !== undefined || body.underlying !== undefined) {
      delete merged.symbols;
      delete merged.collection;
      delete merged.underlying;
      delete merged.universe;
    }
    Object.assign(merged, body);
    const rule = checkRule(merged);
    if (rule.collection && !libraryFn()) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Collections are not available in this Bridge.");
    normaliseRuleTarget(rule);
    const i = rules.findIndex((r) => r.id === id);
    rules[i] = { ...rules[i], ...rule, id, updatedAt: iso(now()) };
    saveRules();
    syncRules();
    return ruleView({ ...rules[i], source: "user" });
  }

  function deleteRule(id, { deleteFiles = false } = {}) {
    const current = findRule(id);
    if (current.source === "config") throw new BridgeError("STATE_CONFLICT", "This rule is written in bridge.config.json (recorder.autoRecord.rules). Remove it there.");
    rules = rules.filter((r) => r.id !== id);
    saveRules();
    syncRules();
    const rec = recs.get(recordingIdOfRule(id));
    if (rec && deleteFiles) destroy(rec, "rule-deleted");
    ruleBlocked.delete(id);
  }

  async function setAuto(enabled) {
    settings.autoRecord = { ...(settings.autoRecord ?? {}), enabled: Boolean(enabled) };
    saveSettings();
    syncRules();
    return autoView();
  }
  const autoView = () => ({ enabled: autoOn(), setBy: settings.autoRecord?.enabled !== undefined ? "user" : "config", rules: allRules().length, activeRules: [...recs.values()].filter((r) => r.def.source === "rule" && r.def.status === "active").length });

  const settingsSchema = z
    .object({
      maxBudgetShare: z.number({ error: "maxBudgetShare must be a number." }).min(SHARE_MIN, `maxBudgetShare must be at least ${SHARE_MIN} (${Math.round(SHARE_MIN * 100)}%).`).max(SHARE_MAX, `maxBudgetShare must be at most ${SHARE_MAX} (${Math.round(SHARE_MAX * 100)}%).`),
    })
    .strict();
  /** What is in force now, the config default and the allowed range. */
  const settingsView = () => ({
    maxBudgetShare: share(),
    defaults: { maxBudgetShare: cfg.maxBudgetShare },
    limits: { minBudgetShare: SHARE_MIN, maxBudgetShare: SHARE_MAX },
    changed: settings.maxBudgetShare !== undefined ? ["maxBudgetShare"] : [],
  });
  /** Change the share a recording may use of the spare broker budget. Applies at the next read; kept across restarts. */
  async function setSettings(body) {
    const r = settingsSchema.safeParse(body ?? {});
    if (!r.success) throw fromValidation(r.error, "Send { maxBudgetShare: 0.05 to 0.8 }. Recordings have no after-hours switch: they record during market hours.");
    settings = { ...settings, maxBudgetShare: r.data.maxBudgetShare };
    saveSettings();
    return settingsView();
  }

  async function applyPreset(presetId, body = {}) {
    const p = PRESETS[presetId];
    if (!p) throw new BridgeError("NOT_FOUND", `No preset named ${presetId}. Presets: ${Object.keys(PRESETS).join(", ")}.`);
    const existing = rules.find((r) => r.preset === presetId);
    let rule;
    if (existing) rule = ruleView({ ...existing, source: "user" });
    else {
      const input = structuredClone(p.rule);
      if (presetId === "my-watchlist" && body.collection) input.collection = String(body.collection);
      if (input.collection && !libraryFn()) throw new BridgeError("CAPABILITY_UNSUPPORTED", "This preset reads a collection and the library of collections is not available in this Bridge yet.");
      rule = await createRule(input, { preset: presetId });
    }
    await setAuto(true);
    return { preset: presetId, created: !existing, rule: getRule(rule.id), auto: autoView() };
  }

  /** Recordings and rules that use a collection: one name, several (a renamed collection keeps its old names) or none (all of them). */
  function usageOf(name) {
    const wanted = new Set((Array.isArray(name) ? name : [name]).filter(Boolean));
    const out = [];
    for (const r of allRules()) {
      if (!r.collection || (wanted.size && !wanted.has(r.collection))) continue;
      out.push({ type: "recording-rule", module: "recorder", id: r.id, name: r.name, collection: r.collection, kind: r.kind, enabled: r.enabled !== false, status: ruleView(r).state, url: `/v1/recordings/rules/${r.id}` });
    }
    for (const rec of recs.values()) {
      if (rec.def.source !== "manual" || !rec.def.target.collection || (wanted.size && !wanted.has(rec.def.target.collection))) continue;
      out.push({ type: "recording", module: "recorder", id: rec.def.id, name: rec.def.name, collection: rec.def.target.collection, kind: rec.def.kind, enabled: rec.def.status === "active", status: view(rec).status, url: `/v1/recordings/${rec.def.id}` });
    }
    return out;
  }
  /** The rows the library's usage view shows ({ id, label, status, active }); an active one stops a collection being deleted without force. */
  const usageRows = (type, { name, names } = {}) =>
    usageOf([name, ...(names ?? [])])
      .filter((u) => u.type === type)
      .map((u) => ({ id: u.id, label: u.name ?? u.id, status: u.status, active: u.enabled === true }));

  // ───────────────────────────── status line ─────────────────────────────

  function status() {
    const t = now();
    const date = istDateOf(t);
    const all = [...recs.values()];
    const today = all.filter((r) => r.today.date === date);
    const writing = today.filter((r) => r.today.rows > 0);
    const rulesToday = writing.filter((r) => r.def.source === "rule").length;
    const manualToday = writing.length - rulesToday;
    const symbols = new Set();
    for (const r of writing) for (const s of r.symbols) symbols.add(s);
    const bytesToday = today.reduce((n, r) => n + r.today.bytes, 0);
    const lastWrite = all.reduce((m, r) => Math.max(m, r.lastWriteMs ?? 0), 0) || null;
    const gapsToday = today.reduce((n, r) => n + (r.today.gaps ?? 0), 0);
    const openGaps = all.filter((r) => r.gap).length;
    const blocked = all.filter((r) => r.blocked).length;
    const running = all.filter((r) => r.def.status === "active" && r.phase === "recording").length;
    const waiting = all.filter((r) => r.def.status === "active" && r.phase !== "recording" && r.phase !== "blocked");
    const nextStart = waiting.map((r) => r.nextStartMs).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
    const parts = [];
    if (rulesToday) parts.push(`${rulesToday} rule${rulesToday === 1 ? "" : "s"}`);
    if (manualToday) parts.push(`${manualToday} manual recording${manualToday === 1 ? "" : "s"}`);
    let line;
    if (!cfg.enabled) line = "Recording is switched off in the config (recorder.enabled)";
    else if (writing.length) line = `Recording today: ${parts.join(", ")}, ${symbols.size} symbol${symbols.size === 1 ? "" : "s"}, ${mbText(bytesToday)}, last write ${clock(lastWrite)}`;
    else if (running) line = `Recording is on, waiting for the first data of the day (${running} recording${running === 1 ? "" : "s"})`;
    else if (waiting.length) line = `${autoOn() ? "Auto-record is on" : "Recording is on"}: ${waiting.length} recording${waiting.length === 1 ? "" : "s"} waiting${nextStart ? ` for ${friendlyAt(nextStart)}` : " for the market to open"}`;
    else line = autoOn() ? "Auto-record is on but no rule is running. Add a rule or use a preset" : "Recording is off. Nothing is being saved";
    if (gapsToday) line += `; ${gapsToday} gap${gapsToday === 1 ? "" : "s"} today${openGaps ? " (one is open now)" : ""}`;
    if (blocked) line += "; writing stopped on a disk limit";
    line += ".";
    const free = store.free();
    return {
      line,
      enabled: cfg.enabled,
      auto: autoView(),
      today: { date, recordings: today.length, rules: rulesToday, manual: manualToday, symbols: symbols.size, rows: today.reduce((n, r) => n + r.today.rows, 0), bytes: bytesToday, lastWriteAt: lastWrite ? iso(lastWrite) : null, gaps: gapsToday, openGaps },
      recordings: { total: all.length, running, waiting: waiting.length, paused: all.filter((r) => r.def.status === "paused").length, stopped: all.filter((r) => r.def.status === "stopped").length, blocked },
      disk: { usedBytes: totalBytes(), limitMb: cfg.maxDiskMb, freeBytes: free, minFreeMb: cfg.minFreeDiskMb, retentionDays: cfg.retentionDays, compressFinished: cfg.compressFinished },
      apiCalls: callsToday(),
      budgetShare: share(),
      dataClass: "realtime",
    };
  }

  /** Calls avoided and made by recordings today (the Data page's "API calls saved"). */
  function callsToday() {
    const date = istDateOf(now());
    let made = 0;
    let saved = 0;
    for (const r of recs.values()) {
      if (r.calls.date !== date) continue;
      made += r.calls.made;
      saved += r.calls.saved;
    }
    return { made, saved };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  function loadRecordings() {
    for (const id of store.ids()) {
      // A recording.json that cannot be read is set aside and replaced by a "damaged" stub: the recording stays in the
      // list (with its day files counted and a way to delete it) instead of vanishing and leaving orphan data.
      const def = store.loadDef(id, { log, now: now() });
      if (!def || def.id !== id) continue;
      const state = store.readJson(id, "state.json", {});
      recs.set(id, makeRuntime(def, state));
    }
  }

  function onBus() {
    const wake = () => {
      for (const rec of recs.values()) if (rec.def.status === "active" && (rec.gap || rec.lastIssue)) kick(rec);
    };
    offBus.push(
      bus.on("system.resumed", (e) => {
        const to = now();
        sleeps.push({ from: to - (Number(e?.sleptMs) || 0) - 5000, to: to + 5000 });
        if (sleeps.length > 20) sleeps.shift();
        wake();
      }),
    );
    offBus.push(bus.on("account.status", (e) => (e?.session === "connected" ? wake() : undefined)));
    offBus.push(bus.on("stream.status", (e) => (e?.state === "up" || e?.connected === true ? wake() : undefined)));
    offBus.push(
      bus.on("limits.throttled", (e) => {
        if (e?.upstream === false) return;
        backoffUntil = Math.max(backoffUntil, now() + Math.min(Number(e?.retryAfterMs) || 5000, 300_000));
      }),
    );
  }

  async function start() {
    if (started) return;
    started = true;
    if (!cfg.enabled) return;
    mkdirSync(store.root, { recursive: true, mode: 0o700 });
    loadRoot();
    loadRecordings();
    onBus();
    sweepAll();
    syncRules();
    for (const rec of recs.values()) if (rec.def.status === "active") arm(rec, 0);
    housekeeping = setTimer(function beat() {
      const t = now();
      for (const rec of recs.values()) {
        persist(rec);
        if (rec.def.status === "active") warnDisk(rec, t);
      }
      if (t - lastSweepAt >= SWEEP_EVERY_MS) sweepAll(t);
      housekeeping = setTimer(beat, HOUSEKEEPING_MS);
      housekeeping?.unref?.();
    }, HOUSEKEEPING_MS);
    housekeeping?.unref?.();
  }

  async function close() {
    started = false;
    if (housekeeping) clearTimer(housekeeping);
    housekeeping = null;
    for (const off of offBus.splice(0)) off();
    for (const rec of recs.values()) {
      rec.closed = true;
      disarm(rec);
      persist(rec, true);
      dropStream(rec);
    }
  }

  const service = {
    // contract
    create,
    list,
    get: getView,
    pause,
    resume,
    stop,
    remove,
    files,
    status,
    // rules and auto-record
    listRules,
    getRule,
    createRule,
    patchRule,
    deleteRule,
    auto: autoView,
    setAuto,
    settings: settingsView,
    setSettings,
    presets: presetList,
    applyPreset,
    // extras
    openFile,
    callsToday,
    usageOf,
    sweepNow: () => sweepAll(),
    /** The library of collections, when that module is present (set by the module at start). */
    attach({ library } = {}) {
      if (!library) return;
      libraryFn = () => library;
      // Let the library's usage view list the recordings and rules that use a collection (when it has such a hook).
      try {
        library.registerUsageProvider?.("recordings", (c) => usageRows("recording", c));
        library.registerUsageProvider?.("rules", (c) => usageRows("recording-rule", c));
      } catch (err) {
        log.debug("library usage provider not registered", { err: err?.message });
      }
    },
    start,
    close,
    /** Run one pass of every recording now (tests). */
    async pumpAll() {
      for (const rec of recs.values()) if (rec.def.status === "active") await run(rec);
    },
  };
  return service;
}
