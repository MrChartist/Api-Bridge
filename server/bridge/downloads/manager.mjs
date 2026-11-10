/**
 * The download manager: jobs that fetch history from the broker in the background and write it to files.
 *
 *  - A job is a list of items (one per symbol and interval). Items run one after another; each is fetched in windows of
 *    one broker call, written to a part file as it arrives, and only moved into place when the item is whole. The job's
 *    state (job.json) is saved after every window, so a restart, a pause or a crash continues from the last window.
 *  - Every broker call goes through marketData.history() at priority "background" (the lowest), paced by pacer.mjs to
 *    the configured share of the account's budget. A live read, an order check or another key always goes first.
 *  - A dataset job continues from the last stored bar. Without a dataset, ranges already stored in a dataset of this
 *    Bridge are copied from disk (localFirst) and only the missing parts are fetched.
 *  - The kill switch and a lost broker session pause the job with a clear reason and resume it when they clear.
 *  - The still-forming bar is never written, so a file only holds finished bars.
 *
 * Folder: <dataDir>/downloads/jobs/<id>/{job.json, manifest.json, <files>, parts/}  and  .../datasets/<name>/.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { INTERVALS, planInterval } from "../market/history.mjs";
import { parseMarketConfig } from "../market/config.mjs";
import { createLocalStore, subtractCoverage } from "../market/localStore.mjs";
import { MAX_BACKGROUND_SHARE } from "../ratelimit/backgroundGate.mjs";
import { freeBytesOf } from "../recorder/files.mjs";
import { record as recordSaved } from "../market/savedCalls.mjs";
import { DAY_MS, istDate, parseTimeInput, toIstIso } from "../market/time.mjs";
import { EXTENSIONS, FORMATS, LAYOUTS, coveredUpTo, decodeLine, encodeBars, exchangeOf, findHoles, headerText, isClosedBar, lastBarOf, normaliseBar, readBars, trimPartialTail } from "./bars.mjs";
import { CALENDAR_EXCHANGES, sharedCalendar } from "./calendar.mjs";
import { SHARE_MAX, SHARE_MIN, parseDownloadsConfig } from "./config.mjs";
import { checkDatasetName, cleanTags, createDatasets, toPublicDataset } from "./datasets.mjs";
import { estimateDownload, planWindows, timeAtShare } from "./estimate.mjs";
import { JOB_ID_RE, folderBytes, removeQuiet, safeFileName, sha256File, sizeOf, uniqueName, writeJsonAtomic } from "./files.mjs";
import { createPacer } from "./pacer.mjs";
import { filterByTags } from "./tagsCompat.mjs";

const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MB = 1024 * 1024;
const FINISHED = new Set(["done", "failed", "cancelled"]);
/** Pause reasons that clear by themselves: the job continues when the cause is gone. */
const AUTO_REASONS = new Set(["kill_switch", "session_lost", "market_hours", "disk_low"]);
const CLASS_RANK = Object.freeze({ realtime: 0, delayed: 1, eod: 2 });
const TRANSIENT = new Set(["UPSTREAM_RATE_LIMITED", "UPSTREAM_TIMEOUT", "BROKER_UNAVAILABLE"]);
/** Longest single wait inside a job before it looks at pause, cancel and the kill switch again. */
const SLICE_MS = 5000;
const HOUSEKEEPING_MS = 30_000;

const requestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    symbols: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
    collection: z.string().trim().min(1).max(64).optional(),
    intervals: z.array(z.enum(INTERVALS)).min(1).max(10),
    from: z.union([z.string().min(1).max(40), z.number()]),
    to: z.union([z.string().min(1).max(40), z.number()]).optional(),
    format: z.enum(FORMATS).default("csv"),
    layout: z.enum(LAYOUTS).default("per-symbol"),
    dataset: z.string().min(1).max(64).optional(),
    account: z.string().regex(ACCOUNT_RE).optional(),
    backup: z.boolean().optional(),
    afterHoursOnly: z.boolean().optional(),
    tags: z.array(z.string()).max(20).optional(),
  })
  .strict();

const patchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), tags: z.array(z.string()).max(20).optional() }).strict();

/** Thrown inside a run to pause the job with a reason (not a failure). */
class PauseJob extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
/** Thrown when writing would pass the disk limit. */
class DiskLimit extends Error {}


/**
 * @param {object} deps core deps plus accounts, scheduler, marketData, safety (a stub or missing one is tolerated)
 * @param {{ sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, calendar?: any, random?: () => number, getLibrary?: () => any,
 *   statfs?: (dir: string) => number | null }} [opts] statfs: free bytes of the disk that holds a folder (tests; the real one is used otherwise)
 */
export function createDownloadManager(deps, opts = {}) {
  const { bus, logger } = deps;
  const now = () => deps.clock.now();
  const baseCfg = () => parseDownloadsConfig(deps.config?.downloads);
  /** Changes made at run time (Data page, PATCH /v1/downloads/settings), kept in <dataDir>/downloads/settings.json. */
  let overrides = {};
  const settingsFile = join(deps.paths.dataDir, "downloads", "settings.json");
  /** The config with the run-time changes on top: every pacing decision reads this, so a change applies at once. */
  const cfg = () => ({ ...baseCfg(), ...overrides });
  const dataDir = deps.paths.dataDir;
  const jobsRoot = join(dataDir, "downloads", "jobs");
  const calendar = opts.calendar ?? sharedCalendar();
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const freeBytes = opts.statfs ?? freeBytesOf;
  let getLibrary = opts.getLibrary ?? (() => undefined);

  const datasets = createDatasets({ dataDir, now });
  const localStore = datasets.store;
  const pacer = createPacer({ scheduler: deps.scheduler, share: () => cfg().maxBudgetShare, now: opts.pacerNow ?? (() => Date.now()), sleep });

  /** @type {Map<string, any>} */
  const jobs = new Map();
  /** id -> { controller, promise, lastEmitAt, persistTimer, waiting, runStart, startFraction } */
  const running = new Map();
  /** id -> tail of the job.json write chain */
  const writes = new Map();
  let started = false;
  let stopped = false;
  let diskBytes = 0;
  let housekeeping = null;
  const unsubs = [];

  const jobDir = (id) => join(jobsRoot, id);
  const nowIso = () => new Date(now()).toISOString();
  const iso = (sec) => (Number.isFinite(sec) ? toIstIso(sec * 1000) : null);
  const isTradingDay = (date, exchange) => (CALENDAR_EXCHANGES.includes(exchange) ? calendar.isTradingDay(date, exchange) : [1, 2, 3, 4, 5].includes(new Date(`${date}T00:00:00Z`).getUTCDay()));

  // ───────────────────────── who may change what ─────────────────────────

  const isOpen = (j) => j.status === "queued" || j.status === "running" || j.status === "paused";
  const writtenBytes = (j) => j.items.reduce((a, it) => a + (it.bytes ?? 0), 0);
  /** Bytes that open jobs are still expected to write (their estimate minus what they have written), so queued jobs count against the disk limit. */
  const pendingBytes = () => {
    let total = 0;
    for (const j of jobs.values()) if (isOpen(j)) total += Math.max(0, (j.estBytes ?? 0) - writtenBytes(j));
    return total;
  };

  /**
   * Only the key that started a job or dataset, or an admin, may change it. `actor` ({ id, admin }) comes from the route;
   * calls from inside the Bridge (pause on kill switch, retention) pass none. A job or dataset made before owners were
   * recorded has no owner, so only an admin may change it.
   */
  function authorize(owner, actor, what) {
    if (!actor || actor.admin === true) return;
    if (owner && owner === actor.id) return;
    throw new BridgeError("SCOPE_REQUIRED", `Only the key that started this ${what}, or an admin key, may change it.`);
  }

  /** Refuse a new job when too many are open or stored. Run twice in create(): before the slow work and again right before the job is added. */
  function checkRoom(actor) {
    const c = cfg();
    const open = [...jobs.values()].filter(isOpen);
    if (open.length >= c.maxQueuedJobs) {
      throw new BridgeError("RATE_LIMITED", `${open.length} download jobs are already waiting, running or paused (downloads.maxQueuedJobs is ${c.maxQueuedJobs}). Wait for some to finish, or cancel and delete the ones you do not need.`, { retryAfterMs: 60_000 });
    }
    if (actor?.id && actor.id !== "local") {
      const mine = open.filter((j) => j.createdBy === actor.id).length;
      if (mine >= c.maxQueuedJobsPerKey) {
        throw new BridgeError("RATE_LIMITED", `This key already has ${mine} open download jobs (downloads.maxQueuedJobsPerKey is ${c.maxQueuedJobsPerKey}). Wait for some to finish, or cancel the ones you do not need.`, { retryAfterMs: 60_000 });
      }
    }
    if (jobs.size >= c.maxStoredJobs) {
      throw new BridgeError("RATE_LIMITED", `${jobs.size} download jobs are stored (downloads.maxStoredJobs is ${c.maxStoredJobs}). Delete old jobs, or set downloads.retentionDays so finished ones are removed by themselves.`, { retryAfterMs: 60_000 });
    }
  }

  // ───────────────────────── persistence ─────────────────────────

  function persistNow(job) {
    const rt = running.get(job.id);
    if (rt?.persistTimer) {
      clearTimeout(rt.persistTimer);
      rt.persistTimer = null;
    }
    const prev = writes.get(job.id) ?? Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(job));
    const next = prev.catch(() => {}).then(() => writeJsonAtomic(join(jobDir(job.id), "job.json"), snapshot, { compact: true }));
    writes.set(job.id, next);
    next.then(
      () => writes.get(job.id) === next && writes.delete(job.id),
      (err) => {
        logger?.warn?.("could not save a download job", { id: job.id, err });
        if (writes.get(job.id) === next) writes.delete(job.id);
      },
    );
    return next;
  }

  function persistSoon(job) {
    const rt = running.get(job.id);
    if (!rt) return persistNow(job);
    if (!rt.persistTimer) {
      rt.persistTimer = setTimeout(() => {
        rt.persistTimer = null;
        persistNow(job).catch(() => {});
      }, 300);
      rt.persistTimer.unref?.();
    }
    return Promise.resolve();
  }

  async function loadJobs() {
    let ids = [];
    try {
      ids = await readdir(jobsRoot);
    } catch {
      return;
    }
    for (const id of ids) {
      if (!JOB_ID_RE.test(id)) continue;
      try {
        const job = JSON.parse(await readFile(join(jobDir(id), "job.json"), "utf8"));
        if (job?.id !== id || !Array.isArray(job.items)) continue;
        if (job.status === "running") {
          // The Bridge stopped while this job ran: it continues from its last saved window.
          job.status = "queued";
          job.reason = "restart";
          job.message = "Continuing after the Bridge restarted.";
        }
        jobs.set(id, job);
      } catch (err) {
        logger?.warn?.("a download job could not be read and was skipped", { id, err });
      }
    }
  }

  // ───────────────────────── views ─────────────────────────

  function fractionOf(item) {
    if (item.status === "done") return 1;
    if (item.status === "failed" || item.fromSec == null || item.toSec == null || item.cursor == null) return 0;
    const total = item.toSec - item.fromSec + 1;
    return total > 0 ? Math.min(1, Math.max(0, (item.cursor - item.fromSec) / total)) : 1;
  }

  function progressOf(job) {
    const items = job.items;
    let done = 0;
    let failed = 0;
    let rows = 0;
    let bytes = 0;
    let frac = 0;
    let current = null;
    for (const it of items) {
      if (it.status === "done") done += 1;
      else if (it.status === "failed") failed += 1;
      rows += it.rows ?? 0;
      bytes += it.bytes ?? 0;
      frac += fractionOf(it);
      if (!current && it.status === "running" && job.status === "running") current = { symbol: it.symbol, interval: it.interval };
    }
    const rt = running.get(job.id);
    let etaSec = null;
    if (job.status === "running" && rt && items.length) {
      const f = frac / items.length;
      const gained = f - (rt.startFraction ?? 0);
      const elapsed = (now() - rt.runStart) / 1000;
      if (gained > 0.001 && elapsed > 0) etaSec = Math.ceil((elapsed / gained) * (1 - f));
    }
    return { total: items.length, done, failed, rows, bytes, etaSec, current, waiting: rt?.waiting ?? null };
  }

  function publicJob(job, { withItems = true } = {}) {
    const out = {
      id: job.id,
      name: job.name,
      status: job.status,
      reason: job.reason ?? null,
      message: job.message ?? null,
      progress: progressOf(job),
      request: job.request,
      dataset: job.dataset ?? null,
      tags: job.tags ?? [],
      dataClass: job.dataClass,
      source: job.sources?.length ? job.sources.join(", ") : null,
      official: job.official ?? null,
      delaySec: job.delaySec ?? null,
      callsSaved: job.savedCalls ?? 0,
      notes: job.notes ?? [],
      createdBy: job.createdBy ?? null,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      manifestUrl: `/v1/downloads/${job.id}/files/manifest.json`,
    };
    if (job.collection) out.collection = job.collection;
    if (withItems) out.items = job.items.map((it) => ({ symbol: it.symbol, interval: it.interval, status: it.status, rows: it.rows ?? 0, ...(it.error ? { error: it.error } : {}) }));
    return out;
  }

  function manifestOf(job, status = job.status) {
    return {
      id: job.id,
      name: job.name,
      createdAt: job.createdAt,
      request: job.request,
      status,
      dataset: job.dataset ?? null,
      files: (job.outputs ?? []).map((f) => ({ name: f.name, symbol: f.symbol, interval: f.interval, rows: f.rows, bytes: f.bytes, firstBar: iso(f.firstBar), lastBar: iso(f.lastBar), sha256: f.sha256 })),
      dataClass: job.dataClass,
      source: job.sources?.length ? job.sources.join(", ") : null,
      official: job.official ?? null,
      delaySec: job.delaySec ?? null,
      notes: job.notes ?? [],
    };
  }

  async function writeManifest(job, status) {
    await writeJsonAtomic(join(jobDir(job.id), "manifest.json"), manifestOf(job, status));
  }

  const emitSafe = (topic, payload) => {
    try {
      bus.emit(topic, payload);
    } catch (err) {
      logger?.warn?.("download event failed", { topic, err });
    }
  };

  function emitProgress(job, force = false) {
    const rt = running.get(job.id);
    const t = now();
    if (!force && rt && t - (rt.lastEmitAt ?? 0) < cfg().progressThrottleMs) return;
    if (rt) rt.lastEmitAt = t;
    const p = progressOf(job);
    emitSafe("download.progress", { id: job.id, name: job.name, status: job.status, reason: job.reason ?? null, total: p.total, done: p.done, failed: p.failed, rows: p.rows, bytes: p.bytes, etaSec: p.etaSec, current: p.current, dataset: job.dataset ?? null });
  }

  // ───────────────────────── labels ─────────────────────────

  function noteLabel(job, { dataClass, source, official, delaySec }) {
    if (dataClass && (CLASS_RANK[dataClass] ?? 0) >= (CLASS_RANK[job.dataClass] ?? 0)) job.dataClass = dataClass;
    if (source) for (const s of String(source).split(", ")) if (s && !job.sources.includes(s)) job.sources.push(s);
    if (official !== undefined && official !== null) job.official = job.official === false ? false : official;
    if (Number.isFinite(delaySec)) job.delaySec = Math.max(job.delaySec ?? 0, delaySec);
  }
  const labelOf = (f) => ({ dataClass: f?.class ?? "realtime", source: f?.provider ?? f?.broker ?? f?.source ?? null, official: f?.official ?? null, delaySec: f?.delaySec ?? null });

  // ───────────────────────── request handling ─────────────────────────

  function spanFor(broker, symbol, interval) {
    const h = parseMarketConfig(deps.config?.market).history;
    let daily;
    try {
      daily = planInterval(interval, undefined).base === "1d";
    } catch {
      daily = interval === "1d" || interval === "1w" || interval === "1M";
    }
    void symbol;
    const spans = h.brokers?.[broker] ?? {};
    return (daily ? spans.daily : spans.intraday) ?? (daily ? h.maxSpanDays.daily : h.maxSpanDays.intraday);
  }

  const brokerOfAccount = (accountId) => {
    try {
      return deps.accounts.get(accountId)?.broker ?? null;
    } catch {
      return null;
    }
  };

  async function candidatesFor(job) {
    const req = job.request;
    let list = [];
    try {
      list = (await deps.accounts.marketDataCandidates({ capability: "historical", accountId: req.account, allowedAccounts: job.allowedAccounts ?? undefined })) ?? [];
    } catch (err) {
      if (err?.code === "ACCOUNT_NOT_FOUND") throw err;
      list = [];
    }
    return list;
  }

  /** Days one broker call may cover for this item: the span of the broker that will serve it. */
  async function spanOf(job, item) {
    let broker = job.request.account ? brokerOfAccount(job.request.account) : null;
    if (!broker) {
      const cands = await candidatesFor(job).catch(() => []);
      if (cands[0]) broker = brokerOfAccount(cands[0]);
    }
    return spanFor(broker, item.symbol, item.interval);
  }

  async function resolveCollection(name) {
    const lib = getLibrary();
    if (typeof lib?.resolve !== "function") {
      throw new BridgeError("CAPABILITY_UNSUPPORTED", "Collections are not available in this Bridge. Give the symbols directly.", { errors: [{ path: "collection", message: "collections are not available" }] });
    }
    const r = await lib.resolve(name);
    const list = Array.isArray(r) ? r : Array.isArray(r?.symbols) ? r.symbols : Array.isArray(r?.items) ? r.items : Array.isArray(r?.data?.symbols) ? r.data.symbols : null;
    const symbols = (list ?? []).map((x) => (typeof x === "string" ? x : (x?.symbol ?? x?.canonical))).filter((x) => typeof x === "string" && x);
    if (!symbols.length) throw new BridgeError("VALIDATION_FAILED", `Collection "${name}" has no symbols right now.`, { errors: [{ path: "collection", message: "no symbols" }] });
    return { symbols, resolvedAt: r?.resolvedAt ?? nowIso(), rule: r?.rule ?? null };
  }

  /** Validate a body and work out everything a job needs. @returns the normalised plan */
  async function plan(body, { allowedAccounts, fromDataset } = {}) {
    const c = cfg();
    if (!c.enabled) throw new BridgeError("CAPABILITY_UNSUPPORTED", "Downloads are switched off (downloads.enabled is false in the config).");
    const parsed = requestSchema.safeParse(body ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const r = parsed.data;
    if ((r.symbols === undefined) === (r.collection === undefined)) {
      throw new BridgeError("VALIDATION_FAILED", "Give either symbols or collection, not both and not neither.", { errors: [{ path: "symbols", message: "symbols or collection is required (one of them)" }] });
    }
    let collection = null;
    let rawSymbols = r.symbols;
    if (r.collection !== undefined) {
      const res = await resolveCollection(r.collection);
      collection = { name: r.collection, resolvedAt: res.resolvedAt, rule: res.rule };
      rawSymbols = res.symbols;
    }
    const symbols = [];
    for (const s of rawSymbols) {
      let canonical;
      try {
        canonical = parseSymbol(s).canonical;
      } catch (err) {
        throw new BridgeError("VALIDATION_FAILED", `"${String(s).slice(0, 60)}" is not a symbol the Bridge understands. Use the canonical form, for example NSE:NIFTY. ${err.detail ?? ""}`.trim(), { errors: [{ path: "symbols", message: "not a valid symbol" }] });
      }
      if (!symbols.includes(canonical)) symbols.push(canonical);
    }
    if (symbols.length > c.maxSymbolsPerJob) {
      throw new BridgeError("VALIDATION_FAILED", `A job may have at most ${c.maxSymbolsPerJob} symbols (downloads.maxSymbolsPerJob); this one has ${symbols.length}. Split it into several jobs.`, { errors: [{ path: "symbols", message: `at most ${c.maxSymbolsPerJob} symbols` }] });
    }
    const intervals = [...new Set(r.intervals)];
    const t = now();
    const fromMs = parseTimeInput(r.from, { field: "from" });
    let toMs = r.to !== undefined ? parseTimeInput(r.to, { endOfDay: true, field: "to" }) : t;
    if (toMs > t) toMs = t;
    if (fromMs > toMs) throw new BridgeError("VALIDATION_FAILED", "from must be before to.", { errors: [{ path: "from", message: "after to" }] });
    if (r.dataset !== undefined) {
      checkDatasetName(r.dataset);
      if (r.layout === "combined") throw new BridgeError("VALIDATION_FAILED", "A dataset keeps one file per symbol and interval, so layout must be per-symbol.", { errors: [{ path: "layout", message: "datasets are per-symbol" }] });
    }
    if (r.account !== undefined) {
      if (Array.isArray(allowedAccounts) && !allowedAccounts.includes(r.account)) throw new BridgeError("ACCOUNT_FORBIDDEN", `This key may not use account ${r.account}.`);
      deps.accounts.get(r.account); // ACCOUNT_NOT_FOUND
    }
    const tags = cleanTags(r.tags);
    const request = {
      symbols,
      intervals,
      from: String(r.from),
      to: r.to === undefined ? null : String(r.to),
      format: r.format,
      layout: r.layout,
      dataset: r.dataset ?? null,
      account: r.account ?? null,
      backup: r.backup === true,
      // null: follows the downloads setting at the time the job runs (it can be changed while the job waits).
      afterHoursOnly: r.afterHoursOnly ?? null,
      ...(r.collection ? { collection: r.collection } : {}),
    };
    return { request, collection, fromSec: Math.floor(fromMs / 1000), toSec: Math.floor(toMs / 1000), name: r.name, tags, fromDataset };
  }

  /** The estimate for a plan (broker calls, rows, bytes, time at the share, disk). */
  async function estimateOf(p, { allowedAccounts }) {
    const c = cfg();
    const req = p.request;
    const ds = req.dataset ? datasets.get(req.dataset) : null;
    let accountId = req.account;
    let broker = null;
    const probe = { request: req, allowedAccounts: allowedAccounts ?? null };
    if (!accountId) {
      try {
        const cands = await candidatesFor(probe);
        accountId = cands.length > 1 ? (deps.scheduler.pickAccount?.({ candidates: cands, endpointClass: "history" }) ?? cands[0]) : cands[0];
      } catch {
        accountId = undefined;
      }
    }
    if (accountId) broker = brokerOfAccount(accountId);
    const coverageOf = (symbol, interval) => {
      if (ds) return ds.series?.[`${symbol}|${interval}`]?.coverage ?? null;
      if (!c.localFirst) return null;
      let best = null;
      for (const name of localStore.names()) {
        const cov = datasets.get(name)?.series?.[`${symbol}|${interval}`]?.coverage;
        if (cov && cov.from <= p.toSec && cov.to >= p.fromSec && (!best || cov.to - cov.from > best.to - best.from)) best = cov;
      }
      return best;
    };
    const est = estimateDownload({
      symbols: req.symbols,
      intervals: req.intervals,
      fromSec: p.fromSec,
      toSec: p.toSec,
      format: req.format,
      nowMs: now(),
      spanDays: (symbol, interval) => spanFor(broker, symbol, interval),
      coverageOf,
      isTradingDay,
    });
    let windows = [];
    if (accountId && typeof deps.scheduler?.headroomWindows === "function") {
      try {
        windows = deps.scheduler.headroomWindows(accountId, "history").windows;
      } catch {
        windows = [];
      }
    }
    const time = timeAtShare(est.calls, windows, c.maxBudgetShare);
    const used = diskBytes;
    const queued = pendingBytes();
    const max = c.maxDiskMb * MB;
    const free = freeBytes(dataDir);
    const minFree = c.minFreeDiskMb * MB;
    const notes = ["Rows assume every trading minute has a bar; a thin stock has fewer. The time assumes the broker's published limit is the only limit."];
    if (!accountId) notes.push(req.backup ? "No broker account was found; the time depends on the data source." : "No connected broker account can serve history right now, so the job would wait for a login.");
    if (est.callsSaved > 0) notes.push(`${est.callsSaved} broker calls are saved because that part is already stored on this computer.`);
    if (time.days && time.days > 1) notes.push(`The broker's daily limit at your ${Math.round(c.maxBudgetShare * 100)}% share makes this take about ${time.days} days.`);
    return {
      symbols: req.symbols.length,
      intervals: req.intervals.length,
      items: est.items,
      brokerCalls: est.calls,
      callsSaved: est.callsSaved,
      rows: est.rows,
      rowsToFetch: est.rowsToFetch,
      bytes: est.bytes,
      bytesPerRow: est.bytesPerRow,
      etaSec: time.etaSec,
      callsPerSecond: time.callsPerSecond,
      limitingWindow: time.binding,
      budgetShare: c.maxBudgetShare,
      account: accountId ?? null,
      broker,
      alreadyStored: est.upToDate,
      disk: {
        usedBytes: used,
        queuedBytes: queued,
        maxBytes: max,
        freeBytes: free,
        minFreeBytes: minFree,
        wouldExceed: used + queued + est.bytes > max || (free !== null && minFree > 0 && free - queued - est.bytes < minFree),
      },
      notes,
    };
  }

  // ───────────────────────── create ─────────────────────────

  /** POST /v1/downloads?dryRun=1: the estimate, nothing started. */
  async function estimate(body, o = {}) {
    const p = await plan(body, o);
    return estimateOf(p, o);
  }

  async function create(body, o = {}) {
    const c = cfg();
    const p = await plan(body, o);
    const req = p.request;
    // A dataset someone else made is not written to by a key that does not own it (an admin may).
    if (req.dataset && !p.fromDataset) {
      const meta = datasets.get(req.dataset);
      if (meta) authorize(meta.createdBy, o.actor, "dataset");
    }
    const updating = req.dataset && p.fromDataset && [...jobs.values()].some((j) => j.dataset === req.dataset && (j.status === "queued" || j.status === "running"));
    if (!updating) checkRoom(o.actor);
    const est = await estimateOf(p, o);
    if (est.disk.wouldExceed) {
      const d = est.disk;
      const low = d.freeBytes !== null && d.minFreeBytes > 0 && d.freeBytes - d.queuedBytes - est.bytes < d.minFreeBytes;
      throw new BridgeError(
        "VALIDATION_FAILED",
        low && d.usedBytes + d.queuedBytes + est.bytes <= d.maxBytes
          ? `This download is about ${Math.ceil(est.bytes / MB)} MB but the disk has only ${Math.floor(d.freeBytes / MB)} MB free, and downloads stop at ${c.minFreeDiskMb} MB free (downloads.minFreeDiskMb). Free some disk space or ask for less.`
          : `This download is about ${Math.ceil(est.bytes / MB)} MB and the downloads folder is at ${Math.ceil(d.usedBytes / MB)} MB${d.queuedBytes ? ` plus ${Math.ceil(d.queuedBytes / MB)} MB still expected from queued jobs` : ""} of ${c.maxDiskMb} MB (downloads.maxDiskMb). Delete old downloads, ask for less, or raise the limit.`,
        { errors: [{ path: low ? "downloads.minFreeDiskMb" : "downloads.maxDiskMb", message: low ? "would leave too little free disk" : "would exceed the disk limit" }] },
      );
    }
    if (req.dataset) {
      const active = [...jobs.values()].find((j) => j.dataset === req.dataset && (j.status === "queued" || j.status === "running"));
      if (active) {
        if (p.fromDataset) return { job: publicJob(active), existing: true };
        throw new BridgeError("STATE_CONFLICT", `Dataset ${req.dataset} is already being updated by job ${active.id}. Wait for it, or cancel it first.`);
      }
      await datasets.ensure(req.dataset, { format: req.format, request: { symbols: req.symbols, collection: req.collection ?? null, intervals: req.intervals, from: req.from, backup: req.backup, account: req.account, afterHoursOnly: req.afterHoursOnly }, tags: p.tags, createdBy: o.actor?.id ?? null, guard: p.fromDataset ? undefined : (meta) => authorize(meta.createdBy, o.actor, "dataset") });
    }
    const id = `dl_${randomBytes(6).toString("hex")}`;
    const name = p.name ?? req.dataset ?? `download-${istDate(now())}`;
    const taken = new Set();
    const ext = EXTENSIONS[req.format];
    const combined = req.layout === "combined" && !req.dataset;
    const combinedBase = safeFileName(name);
    const items = [];
    for (const symbol of req.symbols) {
      for (const interval of req.intervals) {
        items.push({ symbol, interval, status: "pending", rows: 0, bytes: 0, error: null, file: req.dataset || combined ? null : uniqueName(`${safeFileName(symbol)}_${interval}`, ext, taken), cursor: null, fromSec: null, toSec: null, partBytes: 0, firstBar: null, lastBar: null, holes: 0, holesNote: null, sha256: null, attempts: 0 });
      }
    }
    const job = {
      id,
      name,
      status: "queued",
      reason: null,
      message: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      request: req,
      tags: p.tags ?? [],
      dataset: req.dataset,
      collection: p.collection,
      fromSec: p.fromSec,
      toSec: p.toSec,
      allowedAccounts: o.allowedAccounts ?? null,
      createdBy: o.actor?.id ?? null,
      estBytes: est.bytes,
      combinedBase: combined ? combinedBase : null,
      dataClass: "realtime",
      sources: [],
      official: null,
      delaySec: null,
      notes: [],
      outputs: [],
      savedCalls: 0,
      localBars: 0,
      items,
    };
    if (p.collection) job.notes.push(`Symbols come from collection "${p.collection.name}", resolved ${p.collection.resolvedAt}${p.collection.rule ? ` (${typeof p.collection.rule === "string" ? p.collection.rule : JSON.stringify(p.collection.rule)})` : ""}.`);
    // Checked again with no wait in between: two requests that passed the first check together cannot both take the last place.
    checkRoom(o.actor);
    jobs.set(id, job);
    await mkdir(join(jobDir(id), "parts"), { recursive: true, mode: 0o700 });
    await persistNow(job);
    await writeManifest(job);
    // job.json and the manifest are on the disk now: count them (a 5000-item job is about a megabyte).
    diskBytes += (await sizeOf(join(jobDir(id), "job.json"))) + (await sizeOf(join(jobDir(id), "manifest.json")));
    queueMicrotask(pump);
    return { job: publicJob(job), existing: false };
  }

  // ───────────────────────── the run loop ─────────────────────────

  function pump() {
    if (!started || stopped) return;
    const c = cfg();
    if (!c.enabled) return;
    const queued = [...jobs.values()].filter((j) => j.status === "queued" && !running.has(j.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of queued) {
      if (running.size >= c.maxConcurrentJobs) break;
      if (job.dataset && [...running.keys()].some((id) => jobs.get(id)?.dataset === job.dataset)) continue;
      startRun(job);
    }
  }

  function startRun(job) {
    const controller = new AbortController();
    const rt = { controller, promise: null, lastEmitAt: 0, persistTimer: null, waiting: null, runStart: now(), startFraction: 0 };
    running.set(job.id, rt);
    job.status = "running";
    job.reason = null;
    job.message = null;
    job.startedAt ??= nowIso();
    rt.startFraction = job.items.length ? job.items.reduce((a, it) => a + fractionOf(it), 0) / job.items.length : 0;
    rt.promise = runJob(job, controller).finally(() => {
      if (rt.persistTimer) clearTimeout(rt.persistTimer);
      running.delete(job.id);
      queueMicrotask(pump);
    });
  }

  async function runJob(job, controller) {
    const signal = controller.signal;
    try {
      await persistNow(job);
      emitProgress(job, true);
      for (const item of job.items) {
        if (signal.aborted) return;
        if (item.status === "done" || item.status === "failed") continue;
        await runItem(job, item, signal);
      }
      if (signal.aborted) return;
      await finishJob(job);
    } catch (err) {
      // Paused, cancelled or stopped from outside: whoever aborted has already set the state.
      if (signal.aborted) return;
      if (err instanceof PauseJob) {
        job.status = "paused";
        job.reason = err.reason;
        job.message = err.message;
        await persistNow(job);
        await writeManifest(job).catch(() => {});
        emitProgress(job, true);
        return;
      }
      if (err instanceof DiskLimit) {
        job.status = "failed";
        job.reason = "disk_limit";
        job.message = err.message;
        job.finishedAt = nowIso();
        await persistNow(job);
        await writeManifest(job).catch(() => {});
        emitSafe("download.failed", { id: job.id, name: job.name, reason: "disk_limit", message: job.message, failed: job.items.filter((i) => i.status === "failed").length, dataset: job.dataset });
        return;
      }
      logger?.error?.("download job crashed", { id: job.id, err });
      job.status = "failed";
      job.reason = "internal";
      job.message = "The job stopped because of an internal error. Resume it to try again.";
      job.finishedAt = nowIso();
      await persistNow(job).catch(() => {});
      emitSafe("download.failed", { id: job.id, name: job.name, reason: "internal", message: job.message, failed: 0, dataset: job.dataset });
    }
  }

  const partPath = (job, index) => join(jobDir(job.id), "parts", `${index}.part`);

  function killEngaged() {
    try {
      return deps.safety?.killSwitchStatus?.().engaged === true;
    } catch {
      return false;
    }
  }

  function marketOpen() {
    try {
      const st = calendar.sessionAt("NSE", now()).state;
      return st === "OPEN" || st === "PRE_OPEN" || st === "SPECIAL";
    } catch {
      return false;
    }
  }

  /** Wait (in slices) while an outside condition holds; checks the kill switch first. */
  async function gate(job, signal) {
    const rt = running.get(job.id);
    if (killEngaged()) throw new PauseJob("kill_switch", "The kill switch is on, so downloads are paused. They continue when it is released.");
    while ((job.request.afterHoursOnly ?? cfg().afterHoursOnly) && marketOpen()) {
      if (rt) rt.waiting = { reason: "market-hours", waitMs: SLICE_MS };
      await sleep(SLICE_MS, signal);
      if (killEngaged()) throw new PauseJob("kill_switch", "The kill switch is on, so downloads are paused. They continue when it is released.");
    }
    if (rt) rt.waiting = null;
    checkFree(0); // no point asking the broker for bars there is no room to write
  }

  /** Pause (reason disk_low) while the disk that holds the data folder would be left with less than downloads.minFreeDiskMb free. */
  function checkFree(extra) {
    const c = cfg();
    if (c.minFreeDiskMb <= 0) return;
    const free = freeBytes(dataDir);
    if (free !== null && free - extra < c.minFreeDiskMb * MB) {
      throw new PauseJob("disk_low", `The disk has only ${Math.floor(free / MB)} MB free (downloads.minFreeDiskMb is ${c.minFreeDiskMb}), so downloads are paused so nothing else on this computer is starved. They continue when there is room.`);
    }
  }

  async function ensureDisk(extra) {
    const max = cfg().maxDiskMb * MB;
    if (diskBytes + extra > max) throw new DiskLimit(`The downloads folder reached its limit of ${cfg().maxDiskMb} MB (downloads.maxDiskMb), so writing stopped. Free some space (delete old downloads) and resume the job.`);
    checkFree(extra);
  }

  /**
   * The share passed to the scheduler as a hard floor: the product's own limit (never below half of any window). The
   * pacer keeps the stricter configured share on top. A window of ONE call a second can never keep a floor (half of one
   * call leaves nothing), so for such a broker the pacer alone spaces the calls.
   */
  function floorShareFor(accountId) {
    if (!accountId) return undefined;
    try {
      const v = deps.scheduler?.headroomWindows?.(accountId, "history");
      if (v?.windows?.some((w) => Number.isFinite(w.limit) && w.limit <= 1)) return undefined;
    } catch {
      /* a scheduler that cannot list its windows: keep the floor */
    }
    return MAX_BACKGROUND_SHARE;
  }

  /** One window = one broker call, with the budget share, retries and the pause conditions. */
  async function fetchWindow(job, item, win, signal) {
    const c = cfg();
    const rt = running.get(job.id);
    for (let attempt = 0; ; attempt += 1) {
      await gate(job, signal);
      const cands = await candidatesFor(job);
      let accountId = null;
      if (cands.length) accountId = cands.length > 1 ? (deps.scheduler.pickAccount?.({ candidates: cands, endpointClass: "history" }) ?? cands[0]) : cands[0];
      if (!accountId && !job.request.backup) throw new PauseJob("session_lost", "No broker account that can give history is connected, so the download is paused. It continues when you log in.");
      if (accountId) {
        try {
          await pacer.acquire(accountId, "history", { signal, onWait: (w) => rt && (rt.waiting = w) });
        } finally {
          if (rt) rt.waiting = null;
        }
      }
      const callOpts = { priority: "background", purpose: "analysis", signal };
      if (job.allowedAccounts) callOpts.allowedAccounts = job.allowedAccounts;
      if (job.request.backup) callOpts.allowBackup = true;
      if (job.request.account) callOpts.accountId = job.request.account;
      else if (!job.request.backup && accountId) callOpts.accountId = accountId;
      // The pacer above only waits. The scheduler must also re-check the floor when it takes the budget, or live traffic
      // that spends the budget between that check and the call pushes the account below half (ratelimit/backgroundGate.mjs).
      const floor = floorShareFor(callOpts.accountId);
      if (floor !== undefined) callOpts.backgroundShare = floor;
      try {
        const res = await deps.marketData.history({ symbol: item.symbol, interval: item.interval, from: win.from, to: win.to }, callOpts);
        if (res.partial) throw new BridgeError("UPSTREAM_ERROR", "The broker answered only part of this window.", { retryable: true });
        item.calls = (item.calls ?? 0) + 1;
        return res;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err?.code === "SESSION_EXPIRED") throw new PauseJob("session_lost", "The broker session ended, so the download is paused. Log in again and it continues.");
        const retryable = TRANSIENT.has(err?.code) || (err?.code === "UPSTREAM_ERROR" && err?.retryable === true);
        if (!retryable || attempt >= c.retries) throw err;
        const base = Number.isFinite(err?.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : Math.min(60_000, 1000 * 2 ** attempt);
        const wait = Math.ceil(base + random() * 250);
        if (rt) rt.waiting = { reason: "retry", waitMs: wait, window: null };
        for (let left = wait; left > 0; left -= SLICE_MS) await sleep(Math.min(left, SLICE_MS), signal);
        if (rt) rt.waiting = null;
      }
    }
  }

  /** Bars of a window as stored bars: normalised, ascending, finished, inside [from, to], after what is already written. */
  function acceptBars(candles, item, from, to) {
    const ex = exchangeOf(item.symbol);
    const t = now();
    const out = [];
    let last = item.lastBar ?? -Infinity;
    const sorted = candles.map((c) => normaliseBar(c, item.interval)).filter(Boolean).sort((a, b) => a.time - b.time);
    for (const b of sorted) {
      if (b.time < from || b.time > to || b.time <= last) continue;
      if (!isClosedBar(b, item.interval, ex, t)) continue;
      out.push(b);
      last = b.time;
    }
    return out;
  }

  async function writeBars(job, item, index, bars) {
    if (!bars.length) return;
    const req = job.request;
    const combined = job.combinedBase !== null;
    const withHeader = !job.dataset && !combined && item.partBytes === 0;
    const text = (withHeader ? headerText({ format: req.format, layout: req.layout, interval: item.interval }) : "") + encodeBars(bars, { symbol: item.symbol, interval: item.interval, format: req.format, layout: combined ? "combined" : "per-symbol" });
    const n = Buffer.byteLength(text);
    await ensureDisk(n);
    await appendFile(partPath(job, index), text);
    diskBytes += n;
    item.partBytes += n;
    item.bytes += n;
    item.rows += bars.length;
    item.firstBar ??= bars[0].time;
    item.lastBar = bars.at(-1).time;
  }

  /**
   * Add the bars of a part file to a dataset file, skipping any bar the file already holds (a crash between the append
   * and the saved state leaves the bars in the file, and the part is appended again on resume).
   */
  async function appendNewBars(part, file, { format, interval, headerFirst }) {
    const existing = await trimPartialTail(file);
    const last = existing ? ((await lastBarOf(file, { format, layout: "per-symbol", interval }))?.bar.time ?? -Infinity) : -Infinity;
    const out = createWriteStream(file, { flags: "a" });
    if (existing === 0) out.write(headerFirst);
    const rl = createInterface({ input: createReadStream(part, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const d = decodeLine(line, { format, layout: "per-symbol", interval });
      if (!d || d.bar.time <= last) continue;
      if (!out.write(`${line.replace(/\r$/, "")}${format === "jsonl" ? "\n" : "\r\n"}`)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((resolve, reject) => {
      out.on("error", reject);
      out.end(resolve);
    });
  }

  async function runItem(job, item, signal) {
    const index = job.items.indexOf(item);
    const ex = exchangeOf(item.symbol);
    const req = job.request;
    const c = cfg();
    item.status = "running";
    const span = await spanOf(job, item);
    // First start of this item: decide its range once, so a resume continues where it stopped.
    if (item.fromSec === null) {
      let from = job.fromSec;
      const to = Math.min(job.toSec, coveredUpTo(now(), item.interval, ex));
      if (job.dataset) {
        const s = datasets.get(job.dataset)?.series?.[`${item.symbol}|${item.interval}`];
        if (s?.coverage) {
          from = s.coverage.to + 1;
          const full = planWindows(job.fromSec, to, span).length;
          const left = planWindows(from, to, span).length;
          if (full > left) {
            job.savedCalls += full - left;
            recordSaved(full - left, "dataset-incremental");
          }
        }
      }
      item.fromSec = from;
      item.toSec = to;
      item.cursor = from;
    }
    // A cut-off write from a crash: the part file may be longer than the saved size.
    const part = partPath(job, index);
    const have = await sizeOf(part);
    if (have > item.partBytes) {
      await truncate(part, item.partBytes);
      diskBytes = Math.max(0, diskBytes - (have - item.partBytes));
    } else if (have < item.partBytes) {
      // the part file is gone or does not match: start the item again
      await removeQuiet(part);
      Object.assign(item, { partBytes: 0, bytes: 0, rows: 0, firstBar: null, lastBar: null, cursor: item.fromSec });
    }
    await persistSoon(job);
    emitProgress(job);

    try {
      if (item.cursor <= item.toSec) {
        let segments = [{ kind: "fetch", from: item.cursor, to: item.toSec }];
        if (!job.dataset && c.localFirst) {
          const local = await localStore.readRange(item.symbol, item.interval, item.cursor, item.toSec);
          if (local.covered) {
            segments = [];
            const before = local.gaps.find((g) => g.to < local.covered.from);
            const after = local.gaps.find((g) => g.from > local.covered.to);
            if (before) segments.push({ kind: "fetch", ...before });
            segments.push({ kind: "local", from: local.covered.from, to: local.covered.to, bars: local.bars, source: local.source });
            if (after) segments.push({ kind: "fetch", ...after });
          }
        }
        for (const seg of segments) {
          if (seg.kind === "local") {
            const bars = acceptBars(seg.bars, item, seg.from, seg.to);
            await writeBars(job, item, index, bars);
            noteLabel(job, { dataClass: seg.source.dataClass, source: seg.source.source, official: seg.source.official, delaySec: seg.source.delaySec });
            const saved = planWindows(seg.from, seg.to, span).length;
            job.savedCalls += saved;
            job.localBars += bars.length;
            recordSaved(saved, "local-dataset");
            const note = `${item.symbol} ${item.interval}: ${bars.length} bars came from dataset ${seg.source.dataset} on this computer (no broker call).`;
            if (!job.notes.includes(note) && job.notes.length < 40) job.notes.push(note);
            item.cursor = seg.to + 1;
            await persistSoon(job);
            continue;
          }
          let start = Math.max(seg.from, item.cursor);
          for (const win of planWindows(start, seg.to, span)) {
            if (signal.aborted) return;
            const res = await fetchWindow(job, item, win, signal);
            noteLabel(job, labelOf(res.freshness));
            const bars = acceptBars(res.candles ?? [], item, Math.max(win.from, start), win.to);
            await writeBars(job, item, index, bars);
            item.cursor = Math.min(seg.to, win.to) + 1;
            await persistSoon(job);
            emitProgress(job);
          }
        }
      }
      if (signal.aborted) return;
      await finishItem(job, item, index);
    } catch (err) {
      if (err instanceof PauseJob || err instanceof DiskLimit || signal.aborted) throw err;
      item.status = "failed";
      item.error = { code: err?.code ?? "INTERNAL", message: String(err?.detail ?? err?.message ?? err).slice(0, 300) };
      if (!(err instanceof BridgeError)) logger?.error?.("a download item failed", { id: job.id, symbol: item.symbol, err });
      await persistNow(job);
      emitProgress(job);
    }
  }

  /** The item is whole: put its file in place (or into the dataset) and record what it holds. */
  async function finishItem(job, item, index) {
    const part = partPath(job, index);
    const req = job.request;
    const combined = job.combinedBase !== null;
    const exchange = exchangeOf(item.symbol);
    /** Rows, first and last bar and the holes of a file. */
    const scan = async (file, layout) => {
      const bars = [];
      for await (const { bar } of readBars(file, { format: req.format, layout, interval: item.interval })) bars.push(bar);
      const holes = findHoles(bars, { interval: item.interval, exchange, isTradingDay: CALENDAR_EXCHANGES.includes(exchange) ? (d) => calendar.isTradingDay(d, exchange) : undefined });
      return { rows: bars.length, first: bars[0]?.time ?? null, last: bars.at(-1)?.time ?? null, holes };
    };
    if (job.dataset) {
      const meta = datasets.get(job.dataset);
      const s = datasets.seriesOf(meta, item.symbol, item.interval);
      const file = datasets.filePath(meta, s);
      await mkdir(datasets.dirOf(job.dataset), { recursive: true });
      // The part file and the dataset file both exist for a moment: count the second copy.
      if (item.rows > 0) await ensureDisk(item.partBytes);
      if (item.rows > 0) await appendNewBars(part, file, { format: meta.format, interval: item.interval, headerFirst: headerText({ format: meta.format, layout: "per-symbol", interval: item.interval }) });
      await removeQuiet(part);
      const size = await sizeOf(file);
      const st = size ? await scan(file, "per-symbol") : { rows: 0, first: null, last: null, holes: [] };
      const next = {
        ...s,
        rows: st.rows,
        bytes: size,
        firstBar: st.first,
        lastBar: st.last,
        coverage: { from: s.coverage?.from ?? item.fromSec, to: Math.max(item.toSec, s.coverage?.to ?? 0) },
        holes: st.holes,
        holesTotal: st.holes.length,
        sha256: size ? await sha256File(file) : null,
      };
      await datasets.commitSeries(job.dataset, next, { dataClass: job.dataClass, source: job.sources.join(", ") || null, official: job.official, delaySec: job.delaySec, jobId: job.id });
      item.holes = st.holes.length;
      if (st.holes.length) item.holesNote = `${st.holes.length} stretch${st.holes.length === 1 ? "" : "es"} with missing bars, first at ${iso(st.holes[0].from)}`;
      item.sha256 = next.sha256;
      item.file = s.file;
    } else if (item.rows > 0) {
      const st = await scan(part, combined ? "combined" : "per-symbol");
      item.holes = st.holes.length;
      if (st.holes.length) item.holesNote = `${st.holes.length} stretch${st.holes.length === 1 ? "" : "es"} with missing bars, first at ${iso(st.holes[0].from)}`;
      if (!combined) {
        const final = join(jobDir(job.id), item.file);
        await rename(part, final);
        item.sha256 = await sha256File(final);
      }
    } else {
      await removeQuiet(part);
      const note = `${item.symbol} ${item.interval}: the broker had no bars in this range.`;
      if (!job.notes.includes(note) && job.notes.length < 40) job.notes.push(note);
    }
    item.status = "done";
    item.error = null;
    await persistNow(job);
    emitProgress(job);
  }

  /** Every item has been tried: assemble combined files, list the outputs, write the manifest and say how it ended. */
  async function finishJob(job) {
    const req = job.request;
    const outputs = [];
    if (job.dataset) {
      const meta = datasets.get(job.dataset);
      for (const it of job.items.filter((i) => i.status === "done")) {
        const s = meta?.series?.[`${it.symbol}|${it.interval}`];
        if (s) outputs.push({ name: s.file, symbol: s.symbol, interval: s.interval, rows: s.rows, bytes: s.bytes, firstBar: s.firstBar, lastBar: s.lastBar, sha256: s.sha256 });
      }
    } else if (job.combinedBase !== null) {
      const ext = EXTENSIONS[req.format];
      const taken = new Set();
      for (const interval of req.intervals) {
        const parts = job.items.map((it, i) => ({ it, i })).filter(({ it }) => it.interval === interval && it.status === "done" && it.rows > 0);
        if (!parts.length) continue;
        await ensureDisk(parts.reduce((a, { it }) => a + (it.partBytes ?? 0), 0)); // the combined file is a second copy of the parts
        const name = uniqueName(`${job.combinedBase}_${interval}`, ext, taken);
        const final = join(jobDir(job.id), name);
        const tmp = `${final}.tmp`;
        const out = createWriteStream(tmp);
        out.write(headerText({ format: req.format, layout: "combined", interval }));
        let rows = 0;
        let firstBar = null;
        let lastBar = null;
        for (const { it, i } of parts) {
          await new Promise((resolve, reject) => {
            const rs = createReadStream(partPath(job, i));
            rs.on("error", reject);
            rs.on("end", resolve);
            rs.pipe(out, { end: false });
          });
          rows += it.rows;
          firstBar = firstBar === null ? it.firstBar : Math.min(firstBar, it.firstBar);
          lastBar = lastBar === null ? it.lastBar : Math.max(lastBar, it.lastBar);
        }
        await new Promise((resolve, reject) => {
          out.on("error", reject);
          out.end(resolve);
        });
        await rename(tmp, final);
        for (const { i } of parts) await removeQuiet(partPath(job, i));
        outputs.push({ name, symbol: null, interval, rows, bytes: await sizeOf(final), firstBar, lastBar, sha256: await sha256File(final) });
      }
    } else {
      for (const it of job.items) {
        if (it.status === "done" && it.rows > 0 && it.file) outputs.push({ name: it.file, symbol: it.symbol, interval: it.interval, rows: it.rows, bytes: it.bytes, firstBar: it.firstBar, lastBar: it.lastBar, sha256: it.sha256 });
      }
    }
    job.outputs = outputs;
    // A dataset job that asked the broker for nothing (the dataset was already up to date) still says where its data came from.
    if (job.dataset && !job.sources.length) {
      const ds = datasets.get(job.dataset);
      if (ds?.source) {
        job.dataClass = ds.dataClass ?? job.dataClass;
        job.sources = String(ds.source).split(", ");
        job.official = ds.official ?? job.official;
        job.delaySec = ds.delaySec ?? job.delaySec;
      }
    }
    const gapNotes = job.items.filter((i) => i.holesNote).map((i) => `${i.symbol} ${i.interval}: ${i.holesNote}.`);
    for (const n of [...gapNotes.slice(0, 10), ...(gapNotes.length > 10 ? [`... and ${gapNotes.length - 10} more series with missing bars. A thin stock has no bar for a minute with no trade.`] : [])]) if (!job.notes.includes(n)) job.notes.push(n);
    const pushNote = (n) => {
      if (!job.notes.includes(n)) job.notes.push(n);
    };
    pushNote("The bar still forming when the job ran is left out; every bar in the files is finished.");
    if (job.dataClass !== "realtime") pushNote(`Data class: ${job.dataClass}${job.delaySec ? ` (delayed by about ${job.delaySec} seconds)` : ""}. It must never be used for orders, risk checks, paper fills or alerts.`);
    const failed = job.items.filter((i) => i.status === "failed");
    const finalStatus = failed.length ? "failed" : "done";
    job.finishedAt = nowIso();
    job.reason = failed.length ? "items_failed" : null;
    job.message = failed.length ? `${failed.length} of ${job.items.length} items failed (first: ${failed[0].symbol} ${failed[0].interval}: ${failed[0].error?.message}). Resume the job to try those again.` : null;
    // The manifest is on disk before anyone can see the job as finished.
    await writeManifest(job, finalStatus);
    diskBytes = await folderBytes(join(dataDir, "downloads"));
    job.status = finalStatus;
    const p = progressOf(job);
    if (finalStatus === "done") emitSafe("download.done", { id: job.id, name: job.name, files: outputs.length, rows: p.rows, bytes: p.bytes, dataClass: job.dataClass, source: job.sources.join(", ") || null, dataset: job.dataset ?? null });
    else emitSafe("download.failed", { id: job.id, name: job.name, reason: job.reason, message: job.message, failed: failed.length, dataset: job.dataset ?? null });
    emitProgress(job, true);
    await persistNow(job);
  }

  // ───────────────────────── control ─────────────────────────

  const need = (id) => {
    const job = JOB_ID_RE.test(String(id)) ? jobs.get(id) : null;
    if (!job) throw new BridgeError("NOT_FOUND", `There is no download job "${String(id).slice(0, 40)}".`);
    return job;
  };

  async function settle(id) {
    const rt = running.get(id);
    if (rt) await rt.promise.catch(() => {});
  }

  async function pause(id, { reason = "user", message, actor } = {}) {
    const job = need(id);
    authorize(job.createdBy, actor, "job");
    if (job.status !== "running" && job.status !== "queued") throw new BridgeError("STATE_CONFLICT", `Job ${id} is ${job.status}; only a queued or running job can be paused.`);
    job.status = "paused";
    job.reason = reason;
    job.message = message ?? (reason === "user" ? "Paused." : null);
    const rt = running.get(id);
    rt?.controller.abort(new DOMException("paused", "AbortError"));
    await settle(id);
    await persistNow(job);
    await writeManifest(job).catch(() => {});
    emitProgress(job, true);
    return publicJob(job);
  }

  async function resume(id, { actor } = {}) {
    const job = need(id);
    authorize(job.createdBy, actor, "job");
    if (job.status === "paused") {
      job.status = "queued";
      job.reason = null;
      job.message = null;
    } else if (job.status === "failed") {
      for (const it of job.items) if (it.status === "failed") Object.assign(it, { status: "pending", error: null });
      job.status = "queued";
      job.reason = null;
      job.message = null;
      job.finishedAt = null;
    } else throw new BridgeError("STATE_CONFLICT", `Job ${id} is ${job.status}; only a paused or failed job can be resumed.`);
    await persistNow(job);
    pump();
    return publicJob(job);
  }

  async function cancel(id, { actor } = {}) {
    const job = need(id);
    authorize(job.createdBy, actor, "job");
    if (FINISHED.has(job.status)) throw new BridgeError("STATE_CONFLICT", `Job ${id} is already ${job.status}.`);
    job.status = "cancelled";
    job.reason = "user";
    job.message = "Cancelled.";
    job.finishedAt = nowIso();
    running.get(id)?.controller.abort(new DOMException("cancelled", "AbortError"));
    await settle(id);
    // keep whole per-symbol files; drop half-written parts
    await removeQuiet(join(jobDir(id), "parts"));
    await mkdir(join(jobDir(id), "parts"), { recursive: true });
    job.outputs = job.dataset ? [] : job.items.filter((i) => i.status === "done" && i.rows > 0 && i.file && job.combinedBase === null).map((i) => ({ name: i.file, symbol: i.symbol, interval: i.interval, rows: i.rows, bytes: i.bytes, firstBar: i.firstBar, lastBar: i.lastBar, sha256: i.sha256 }));
    await persistNow(job);
    await writeManifest(job);
    diskBytes = await folderBytes(join(dataDir, "downloads"));
    emitProgress(job, true);
    return publicJob(job);
  }

  async function remove(id) {
    const job = need(id);
    if (!FINISHED.has(job.status) && job.status !== "paused") {
      job.status = "cancelled";
      running.get(id)?.controller.abort(new DOMException("removed", "AbortError"));
    }
    await settle(id);
    await writes.get(id)?.catch(() => {});
    jobs.delete(id);
    await removeQuiet(jobDir(id));
    diskBytes = await folderBytes(join(dataDir, "downloads"));
  }

  async function patchJob(id, body, { actor } = {}) {
    const job = need(id);
    authorize(job.createdBy, actor, "job");
    const parsed = patchSchema.safeParse(body ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    if (parsed.data.name !== undefined) job.name = parsed.data.name;
    const tags = cleanTags(parsed.data.tags);
    if (tags !== undefined) job.tags = tags;
    return persistNow(job).then(() => writeManifest(job)).then(() => publicJob(job));
  }

  function list({ status, tag, items = false } = {}) {
    return filterByTags([...jobs.values()].filter((j) => !status || j.status === status), tag)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((j) => publicJob(j, { withItems: items }));
  }

  const get = (id) => publicJob(need(id));

  /** Files of a job (the manifest's list). */
  function files(id) {
    return manifestOf(need(id)).files;
  }

  /** Where a file of a job is on disk, from names the job itself holds: { path, size, name, contentType, labels }. */
  async function fileOf(id, name) {
    const job = need(id);
    let path;
    if (name === "manifest.json") path = join(jobDir(id), "manifest.json");
    else {
      const f = (job.outputs ?? []).find((o) => o.name === name);
      if (!f) throw new BridgeError("NOT_FOUND", `Job ${id} has no file "${String(name).slice(0, 80)}".`);
      path = job.dataset ? join(datasets.dirOf(job.dataset), f.name) : join(jobDir(id), f.name);
    }
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new BridgeError("NOT_FOUND", `The file "${String(name).slice(0, 80)}" is no longer on disk.`);
    }
    const format = name === "manifest.json" ? "json" : job.request.format;
    // A dataset file keeps growing after the job that wrote it: a later backup or end-of-day update may have added bars of
    // a worse class. The labels are the dataset's own (its least current class), never the job's older ones.
    const ds = job.dataset && name !== "manifest.json" ? datasets.get(job.dataset) : null;
    const labels = ds ? { dataClass: ds.dataClass, source: ds.source ?? null, official: ds.official ?? null, delaySec: ds.delaySec ?? null } : { dataClass: job.dataClass, source: job.sources.join(", ") || null, official: job.official, delaySec: job.delaySec };
    return { path, size, name, format, job: labels };
  }

  // ───────────────────────── datasets ─────────────────────────

  const activeJobOf = (name) => [...jobs.values()].find((j) => j.dataset === name && (j.status === "queued" || j.status === "running" || j.status === "paused"))?.id ?? null;

  function listDatasets({ tag } = {}) {
    return datasets.list({ tag }).map((m) => toPublicDataset(m, { activeJobId: activeJobOf(m.name) }));
  }

  function getDataset(name) {
    const meta = datasets.get(name);
    if (!meta) throw new BridgeError("NOT_FOUND", `There is no dataset "${String(name).slice(0, 64)}".`);
    return toPublicDataset(meta, { detail: true, activeJobId: activeJobOf(name) });
  }

  async function updateDataset(name, o = {}) {
    checkDatasetName(name);
    const meta = datasets.get(name);
    if (!meta) throw new BridgeError("NOT_FOUND", `There is no dataset "${name}".`);
    const r = meta.request ?? {};
    const body = { name: meta.title ?? name, intervals: r.intervals, from: r.from, format: meta.format, layout: "per-symbol", dataset: name, backup: r.backup === true, ...(r.account ? { account: r.account } : {}), ...(r.afterHoursOnly != null ? { afterHoursOnly: r.afterHoursOnly } : {}) };
    if (r.collection) body.collection = r.collection;
    else body.symbols = r.symbols;
    return create(body, { ...o, fromDataset: true });
  }

  async function patchDataset(name, body, { actor } = {}) {
    checkDatasetName(name);
    const schema = z.object({ name: z.string().optional(), title: z.string().max(120).nullable().optional(), tags: z.array(z.string()).max(20).optional() }).strict();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) throw fromValidation(parsed.error);
    const existing = datasets.get(name);
    if (!existing) throw new BridgeError("NOT_FOUND", `There is no dataset "${name}".`);
    authorize(existing.createdBy, actor, "dataset");
    let current = name;
    if (parsed.data.name !== undefined && parsed.data.name !== name) {
      if (activeJobOf(name)) throw new BridgeError("STATE_CONFLICT", `Dataset ${name} has a job that is not finished. Wait for it or cancel it, then rename.`);
      await datasets.rename(name, parsed.data.name);
      current = parsed.data.name;
      // Every job that wrote into it follows the new name, on disk too (after a restart it must not point at the old name,
      // which a new dataset may use again).
      for (const j of jobs.values()) {
        if (j.dataset !== name) continue;
        j.dataset = current;
        if (j.request) j.request = { ...j.request, dataset: current };
        await persistNow(j).catch(() => {});
        if (!isOpen(j)) await writeManifest(j).catch(() => {});
      }
    }
    const tags = cleanTags(parsed.data.tags);
    if (tags !== undefined || parsed.data.title !== undefined) await datasets.patch(current, { tags, title: parsed.data.title });
    return getDataset(current);
  }

  async function removeDataset(name) {
    checkDatasetName(name);
    if (activeJobOf(name)) throw new BridgeError("STATE_CONFLICT", `Dataset ${name} has a job that is not finished. Wait for it or cancel it, then delete.`);
    await datasets.remove(name);
    diskBytes = await folderBytes(join(dataDir, "downloads"));
  }

  /** What was made from a collection (for the library's usage view): jobs, and datasets that update from it. */
  function usageOfCollection({ name, names } = {}) {
    const wanted = new Set([name, ...(names ?? [])].filter(Boolean));
    const jobsUsing = [...jobs.values()]
      .filter((j) => j.request?.collection && wanted.has(j.request.collection))
      .map((j) => ({ id: j.id, label: j.name, status: j.status, active: j.status === "queued" || j.status === "running" }));
    const dsUsing = datasets
      .list()
      .filter((m) => m.request?.collection && wanted.has(m.request.collection))
      .map((m) => ({ id: m.name, label: m.title ?? m.name, status: "dataset", active: false }));
    return { jobs: jobsUsing, datasets: dsUsing };
  }

  // ───────────────────────── automatic pause and resume ─────────────────────────

  async function resumeAuto(reason) {
    for (const job of jobs.values()) {
      if (job.status === "paused" && job.reason === reason) {
        job.status = "queued";
        job.reason = null;
        job.message = null;
        await persistNow(job);
      }
    }
    pump();
  }

  async function pauseAuto(reason, message, only) {
    for (const job of [...jobs.values()]) {
      if ((job.status === "running" || job.status === "queued") && (!only || only(job))) await pause(job.id, { reason, message }).catch(() => {});
    }
  }

  async function hasCandidates(job) {
    try {
      return (await candidatesFor(job)).length > 0;
    } catch {
      return false;
    }
  }

  async function onAccountChange() {
    for (const job of [...jobs.values()]) {
      if (job.status === "running" && !job.request.backup && !(await hasCandidates(job))) {
        await pause(job.id, { reason: "session_lost", message: "The broker session ended, so the download is paused. Log in again and it continues." }).catch(() => {});
      }
    }
    for (const job of [...jobs.values()]) {
      if (job.status === "paused" && job.reason === "session_lost" && (await hasCandidates(job))) await resume(job.id).catch(() => {});
    }
  }

  /** Jobs paused for lack of disk continue once the disk has clearly more room than the floor (a quarter more, at least 50 MB). */
  async function resumeIfRoom() {
    if (![...jobs.values()].some((j) => j.status === "paused" && j.reason === "disk_low")) return;
    const floor = cfg().minFreeDiskMb * MB;
    const free = freeBytes(dataDir);
    if (floor <= 0 || free === null || free >= floor + Math.max(50 * MB, floor / 4)) await resumeAuto("disk_low");
  }

  /** Pause the open jobs of a key that was revoked: a leaked key must not keep using the broker budget and the disk. */
  async function pauseJobsOfKey(keyId) {
    if (!cfg().pauseOnKeyRevoked) return;
    await pauseAuto("key_revoked", "The API key that started this job was revoked, so the job is paused. An admin key can resume or cancel it.", (j) => j.createdBy === `key:${keyId}`);
  }

  /** A key revoked by another process (`mc-bridge keys revoke` while the Bridge runs) sends no event: look at the keys of open jobs. */
  async function checkKeysOfOpenJobs() {
    if (!cfg().pauseOnKeyRevoked || typeof deps.keyStore?.get !== "function") return;
    const ids = new Set([...jobs.values()].filter((j) => (j.status === "running" || j.status === "queued") && typeof j.createdBy === "string" && j.createdBy.startsWith("key:")).map((j) => j.createdBy.slice(4)));
    for (const id of ids) {
      let rec;
      try {
        rec = await deps.keyStore.get(id);
      } catch {
        continue;
      }
      if (!rec || rec.revokedAt) await pauseJobsOfKey(id);
    }
  }

  /** Periodic checks: automatic resume and pause, retention. Exposed so tests can run it. */
  async function tick() {
    if (killEngaged()) await pauseAuto("kill_switch", "The kill switch is on, so downloads are paused. They continue when it is released.");
    else await resumeAuto("kill_switch");
    await resumeIfRoom();
    await checkKeysOfOpenJobs();
    await onAccountChange();
    await sweepRetention();
  }

  /** Delete finished jobs older than downloads.retentionDays. Datasets are never touched. @returns {Promise<string[]>} ids removed */
  async function sweepRetention() {
    const days = cfg().retentionDays;
    if (!days) return [];
    const cutoff = now() - days * DAY_MS;
    const gone = [];
    for (const job of [...jobs.values()]) {
      if (!FINISHED.has(job.status) || !job.finishedAt) continue;
      if (Date.parse(job.finishedAt) < cutoff) {
        await remove(job.id).catch(() => {});
        gone.push(job.id);
      }
    }
    return gone;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  // ───────────────────────── run-time settings ─────────────────────────

  const SETTINGS_SCHEMA = z
    .object({
      maxBudgetShare: z.number({ error: "maxBudgetShare must be a number." }).min(SHARE_MIN, `maxBudgetShare must be at least ${SHARE_MIN} (${Math.round(SHARE_MIN * 100)}%).`).max(SHARE_MAX, `maxBudgetShare must be at most ${SHARE_MAX} (${Math.round(SHARE_MAX * 100)}%).`).optional(),
      afterHoursOnly: z.boolean({ error: "afterHoursOnly must be true or false." }).optional(),
    })
    .strict();

  /** What is in force now, the config defaults and the allowed range. */
  function settings() {
    const base = baseCfg();
    const c = cfg();
    return {
      maxBudgetShare: c.maxBudgetShare,
      afterHoursOnly: c.afterHoursOnly,
      defaults: { maxBudgetShare: base.maxBudgetShare, afterHoursOnly: base.afterHoursOnly },
      limits: { minBudgetShare: SHARE_MIN, maxBudgetShare: SHARE_MAX },
      changed: Object.keys(overrides),
    };
  }

  async function loadSettings() {
    try {
      const raw = JSON.parse(await readFile(settingsFile, "utf8"));
      const r = SETTINGS_SCHEMA.safeParse(raw);
      // A hand-edited or old file never stops the Bridge: take the good fields, ignore the rest.
      overrides = r.success ? r.data : {};
      if (!r.success && raw && typeof raw === "object") {
        for (const key of ["maxBudgetShare", "afterHoursOnly"]) {
          const one = SETTINGS_SCHEMA.safeParse({ [key]: raw[key] });
          if (one.success && raw[key] !== undefined) overrides[key] = raw[key];
        }
      }
    } catch (err) {
      overrides = {};
      if (err?.code !== "ENOENT") logger?.warn?.("downloads settings file ignored", { err: err?.message });
    }
  }

  /** Change the share or the after-hours switch. Applies to running jobs at their next call; kept across restarts. */
  async function setSettings(body) {
    const r = SETTINGS_SCHEMA.safeParse(body ?? {});
    if (!r.success) throw fromValidation(r.error, "Send { maxBudgetShare?: 0.05 to 0.8, afterHoursOnly?: true | false }.");
    if (!Object.keys(r.data).length) throw new BridgeError("VALIDATION_FAILED", "Send maxBudgetShare and/or afterHoursOnly.", { errors: [{ path: "", message: "nothing to change" }] });
    const next = { ...overrides, ...r.data };
    await mkdir(join(dataDir, "downloads"), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(settingsFile, next);
    overrides = next;
    return settings();
  }

  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    await loadSettings();
    if (!cfg().enabled) return;
    await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
    await loadJobs();
    diskBytes = await folderBytes(join(dataDir, "downloads"));
    unsubs.push(
      bus.on("safety.kill_switch", (e) => {
        if (e?.engaged) pauseAuto("kill_switch", "The kill switch is on, so downloads are paused. They continue when it is released.").catch(() => {});
        else resumeAuto("kill_switch").catch(() => {});
      }),
      bus.on("key.revoked", (e) => (e?.keyId ? pauseJobsOfKey(e.keyId).catch(() => {}) : undefined)),
      bus.on("account.status", () => onAccountChange().catch(() => {})),
      bus.on("account.session_rejected", () => onAccountChange().catch(() => {})),
    );
    housekeeping = setInterval(() => tick().catch(() => {}), HOUSEKEEPING_MS);
    housekeeping.unref?.();
    pump();
  }

  async function stop() {
    stopped = true;
    for (const u of unsubs.splice(0)) u();
    if (housekeeping) clearInterval(housekeeping);
    housekeeping = null;
    const waits = [];
    for (const [id, rt] of running) {
      rt.controller.abort(new DOMException("shutdown", "AbortError"));
      waits.push(rt.promise.catch(() => {}));
      void id;
    }
    await Promise.all(waits);
    for (const job of jobs.values()) if (job.status === "running" || job.status === "queued") await persistNow(job).catch(() => {});
    await Promise.all([...writes.values()].map((p) => p.catch(() => {})));
    started = false;
  }

  return {
    start,
    stop,
    settings,
    setSettings,
    estimate,
    create,
    get,
    list,
    pause,
    resume,
    cancel,
    remove,
    patchJob,
    files,
    fileOf,
    listDatasets,
    getDataset,
    updateDataset,
    patchDataset,
    removeDataset,
    tick,
    sweepRetention,
    usageOfCollection,
    /** The library lookup collections use (set by the module once every service exists). */
    attachLibrary(fn) {
      getLibrary = fn;
    },
    /** Tests and status pages. */
    internals: { jobs, running, localStore, datasets, pump, diskBytes: () => diskBytes, resolveCollection },
  };
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
