/**
 * Data you keep: downloads, datasets, recordings, collections (`bridge.downloads` and friends).
 *
 *   const job = await bridge.downloads.create({ symbols: ["NSE:RELIANCE", "NSE:TCS"], intervals: "5m", from: "2024-01-01", dataset: "large-caps-5m" });
 *   const done = await bridge.downloads.wait(job, { onProgress: (j) => console.log(j.progress.done, "of", j.progress.total) });
 *   await bridge.downloads.save(done, "data/");                       // each file is checked against the manifest's SHA-256
 *   await bridge.datasets.update("large-caps-5m", { wait: true });    // later: only the bars after the last one are fetched
 *   const rows = await bridge.downloads.read(done);                   // array of plain objects (csv and jsonl files)
 *
 *   await bridge.recordings.create({ kind: "chain", underlying: "NIFTY", expiry: "2026-11-12", everySec: 30 });
 *   await bridge.recordings.rules.create({ name: "Index chains", kind: "chain", everySec: 30, collection: "index-options" });
 *   await bridge.collections.create("nifty-near", { universe: optionUniverse({ underlying: "NIFTY", count: 10 }) });
 *   (await bridge.collections.resolve("nifty-near")).symbols;
 *
 * These groups return the `data` of the Bridge's reply (plain objects, shaped as in docs/openapi.yaml); the one-route-one-
 * method calls on the client (`bridge.createDownload(...)`) return the whole envelope. Jobs run in the background at the
 * lowest priority, so they never slow live reads or orders; they survive a restart and stop with a stated reason
 * (`job.reason`) on a kill switch or a lost login. Every job, dataset and recording says its data class (`realtime`,
 * `delayed`, `eod`), source and delay, and `save()` writes that into `manifest.json` next to the files. Delayed and
 * end-of-day files are for analysis only: nothing in the Bridge uses them for orders, risk, paper fills or alerts.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { BridgeConnectionError } from "./errors.mjs";
import { ChecksumMismatchError, DownloadFailedError, WaitTimeoutError } from "./errors.mjs";
import { HistoryAll } from "./history.mjs";
import { parseTable, toCsv } from "./table.mjs";

export { parseTable, toCsv };

const fsp = fs.promises;
const seg = (s) => encodeURIComponent(String(s));

export const TERMINAL_JOB_STATUSES = Object.freeze(["done", "failed", "cancelled"]);
export const DOWNLOAD_FORMATS = Object.freeze(["csv", "jsonl", "amibroker"]);
export const DOWNLOAD_LAYOUTS = Object.freeze(["per-symbol", "combined"]);
export const RECORDING_KINDS = Object.freeze(["quotes", "chain"]);
export const MIN_EVERY_SEC = Object.freeze({ quotes: 1, chain: 15 });

// ── helpers ──

/** A Date becomes ISO text (a date-only value stays a date); text and numbers pass through. */
export function iso(v) {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const idOf = (x, key = "id") => String(typeof x === "object" && x !== null ? x[key] : x);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const need = (cond, msg) => {
  if (!cond) throw new TypeError(msg);
};

/** A file name from the Bridge reduced to a plain name: it can never write outside the folder you chose. */
export function safeName(name) {
  const base = String(name).replace(/\\/g, "/").split("/").pop();
  if (!base || base === "." || base === "..") throw new TypeError(`the Bridge sent an unusable file name: ${JSON.stringify(name)}`);
  return base;
}

/** A plain sentence for a data class, for logs: `delayed data from yahoo (about 900 s behind)`. */
export function describeDataClass({ dataClass, source, delaySec } = {}) {
  if (dataClass === "realtime" || dataClass === undefined) return `real-time data from ${source ?? "the Bridge"}`;
  if (dataClass === "eod") return `end-of-day data from ${source ?? "a free source"}`;
  return `delayed data from ${source ?? "a free source"} (about ${delaySec ?? "unknown"} s behind)`;
}

function fileFormat(name) {
  let n = String(name).toLowerCase();
  if (n.endsWith(".gz")) n = n.slice(0, -3);
  if (/\.(jsonl|ndjson)$/.test(n)) return "jsonl";
  if (/\.(csv|txt)$/.test(n)) return "csv";
  return n.split(".").pop();
}

async function sha256OfFile(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

/** Stream a GET reply into `dest` (as `dest.part`, renamed when complete); returns { path, bytes, sha256 }. */
async function downloadTo(client, urlPath, dest, { expectSha256, signal, query } = {}) {
  const res = await client.openStream("GET", urlPath, { signal, query });
  const part = `${dest}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  const fh = await fsp.open(part, "w");
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
      hash.update(value);
      bytes += value.length;
    }
    await fh.close();
  } catch (cause) {
    await fh.close().catch(() => {});
    await fsp.rm(part, { force: true });
    if (signal?.aborted) throw cause;
    throw new BridgeConnectionError(`The transfer from ${client.baseUrl} broke off after ${bytes} bytes (${cause?.message ?? "network error"}).`, { cause, method: "GET", path: urlPath, outcomeUnknown: false });
  }
  const actual = hash.digest("hex");
  if (expectSha256 && actual !== String(expectSha256).toLowerCase()) {
    await fsp.rm(part, { force: true });
    throw new ChecksumMismatchError(`${path.basename(dest)} does not match its manifest (expected sha256 ${expectSha256}, got ${actual}). It was not kept.`, { expected: expectSha256, actual });
  }
  await fsp.rename(part, dest);
  return { path: dest, bytes, sha256: actual };
}

const dataOf = (reply) => (reply && typeof reply === "object" && "data" in reply ? reply.data : reply);
const rowsOf = (reply, key = "files") => {
  const d = dataOf(reply);
  return Array.isArray(d) ? d : d?.[key] ?? [];
};

/** Shared by downloads and recordings: list, save and read the files of one job or recording. */
class FileOwner {
  constructor(client, base) {
    this.client = client;
    this._base = base; // "/v1/downloads"
  }

  _fileUrl(id, name) {
    return `${this._base}/${seg(id)}/files/${seg(name)}`;
  }

  async _save(id, files, directory, { names, overwrite = false, verify = true, signal } = {}, manifest) {
    await fsp.mkdir(directory, { recursive: true });
    const wanted = names ? new Set(names) : null;
    const saved = [];
    for (const f of files) {
      if (wanted && !wanted.has(f.name)) continue;
      const name = safeName(f.name);
      const dest = path.join(directory, name);
      if (!overwrite && f.sha256 && fs.existsSync(dest) && (await sha256OfFile(dest)) === String(f.sha256).toLowerCase()) {
        saved.push({ name, path: dest, bytes: fs.statSync(dest).size, sha256: String(f.sha256).toLowerCase(), skipped: true });
        continue;
      }
      const r = await downloadTo(this.client, this._fileUrl(id, f.name), dest, { expectSha256: verify ? f.sha256 : undefined, signal });
      saved.push({ name, path: dest, bytes: r.bytes, sha256: r.sha256, skipped: false });
    }
    const mpath = path.join(directory, "manifest.json");
    if (manifest && !fs.existsSync(mpath)) await fsp.writeFile(mpath, `${JSON.stringify(manifest, null, 2)}\n`);
    return saved;
  }

  async _read(id, files, names) {
    const out = [];
    for (const f of files) {
      if (names && !names.includes(f.name)) continue;
      const fmt = fileFormat(f.name);
      need(fmt === "csv" || fmt === "jsonl", `${f.name} is a ${fmt} file: read() understands csv and jsonl. Use save() to keep it, then open it in the program it was made for.`);
      const res = await this.client.openStream("GET", this._fileUrl(id, f.name));
      let buf = Buffer.from(await res.arrayBuffer());
      if (/\.gz$/i.test(f.name) || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = gunzipSync(buf);
      const rows = parseTable(buf.toString("utf8"), fmt);
      for (const r of rows) {
        if (f.symbol && !("symbol" in r)) r.symbol = f.symbol;
        if (f.interval && !("interval" in r)) r.interval = f.interval;
      }
      out.push(...rows);
    }
    return out;
  }
}

export class Downloads extends FileOwner {
  constructor(client) {
    super(client, "/v1/downloads");
  }

  /**
   * Queue a download (POST /v1/downloads) and return the job at once; it runs in the background.
   * Give `symbols` (canonical, up to 500) or the name of a `collection`; `intervals` ("5m" or a list); `from` (and `to`,
   * default now). With `dataset: "name"` the job continues that dataset from its last stored bar. `format` is csv
   * (default), jsonl or amibroker; `layout` per-symbol or combined. `backup: true` lets a free source serve it (labelled
   * delayed or end-of-day on the job and in every file).
   * @param {{ symbols?: string|string[], collection?: string, intervals: string|string[], from?: string|Date, to?: string|Date, name?: string, format?: string,
   *   layout?: string, dataset?: string, account?: string, backup?: boolean, tags?: string[] }} p
   */
  async create(p = {}) {
    const symbols = list(p.symbols);
    const intervals = list(p.intervals);
    need(Boolean(symbols.length) !== Boolean(p.collection), "give either symbols or collection: <name>, not both and not neither");
    need(intervals.length > 0, 'intervals is required, for example "5m" or ["5m", "1d"]');
    need(p.from !== undefined || p.dataset, 'from is required (an ISO date such as "2024-01-01"), unless dataset: <name> continues an existing dataset');
    need(p.format === undefined || DOWNLOAD_FORMATS.includes(p.format), `format must be one of ${DOWNLOAD_FORMATS.join(", ")}`);
    need(p.layout === undefined || DOWNLOAD_LAYOUTS.includes(p.layout), `layout must be one of ${DOWNLOAD_LAYOUTS.join(", ")}`);
    const body = clean({ name: p.name, symbols: symbols.length ? symbols : undefined, collection: p.collection, intervals, from: iso(p.from), to: iso(p.to), format: p.format, layout: p.layout,
      dataset: p.dataset, account: p.account, backup: p.backup, tags: p.tags?.length ? p.tags : undefined });
    return dataOf(await this.client.createDownload(body));
  }

  async get(job) { return dataOf(await this.client.download(idOf(job))); }
  /** Jobs, newest first. */
  async list(o = {}) { return dataOf(await this.client.listDownloads(o)) ?? []; }
  async pause(job) { return dataOf(await this.client.pauseDownload(idOf(job))); }
  async resume(job) { return dataOf(await this.client.resumeDownload(idOf(job))); }
  async cancel(job) { return dataOf(await this.client.cancelDownload(idOf(job))); }
  /** Remove the job and its files from the Bridge's disk (files you saved elsewhere are untouched). */
  async delete(job) { await this.client.deleteDownload(idOf(job)); }
  async rename(job, { name, tags } = {}) {
    need(name !== undefined || tags !== undefined, "give a new name or tags");
    return dataOf(await this.client.editDownload(idOf(job), clean({ name, tags })));
  }

  /**
   * Poll until the job is done, failed or cancelled and return it. `onProgress(job)` runs after every poll. A job that
   * ends failed or cancelled throws DownloadFailedError (with `job.reason`) unless `throwOnFailure: false`. A paused job
   * keeps waiting (resume it). Running out of `timeoutMs` throws WaitTimeoutError: the job carries on in the Bridge.
   * @param {string|object} job
   * @param {{ timeoutMs?: number, pollMs?: number, onProgress?: (job: any) => void, throwOnFailure?: boolean, signal?: AbortSignal }} [o]
   */
  async wait(job, { timeoutMs, pollMs = 1000, onProgress, throwOnFailure = true, signal } = {}) {
    const id = idOf(job);
    const t0 = this.client._now();
    for (;;) {
      const cur = await this.get(id);
      onProgress?.(cur);
      if (TERMINAL_JOB_STATUSES.includes(cur.status)) {
        if (throwOnFailure && cur.status !== "done") throw new DownloadFailedError(`Download ${id} ended ${cur.status}${cur.reason ? `: ${cur.reason}` : ""}.`, cur);
        return cur;
      }
      if (timeoutMs !== undefined && this.client._now() - t0 >= timeoutMs) {
        throw new WaitTimeoutError(`Download ${id} is still ${cur.status} after ${Math.round(timeoutMs / 1000)} s (${cur.progress?.done ?? 0} of ${cur.progress?.total ?? 0} items). It keeps running in the Bridge: look again with bridge.downloads.get(${JSON.stringify(id)}).`, cur);
      }
      await this.client._sleep(pollMs, signal);
    }
  }

  /** The job's files with rows, bytes, first and last bar and SHA-256 (the manifest's list). */
  async files(job) { return rowsOf(await this.client.downloadFiles(idOf(job))); }

  /** The manifest as an object: the job's label (data class, source, delay) plus its file list. */
  async manifest(job) {
    const j = typeof job === "object" && job.status ? job : await this.get(idOf(job));
    return this._manifest(j, await this.files(j.id));
  }

  _manifest(job, files) {
    const { progress, items, ...rest } = job;
    return { ...rest, files };
  }

  /**
   * Download the job's files into `directory` (created if needed) and write `manifest.json` beside them. Each file is
   * streamed to a `.part` file, checked against the manifest's SHA-256 and renamed only when it matches
   * (ChecksumMismatchError otherwise). A file already there with the same checksum is not fetched again, so an
   * interrupted save can simply be run again. Returns [{ name, path, bytes, sha256, skipped }].
   * @param {string|object} job
   * @param {string} directory
   * @param {{ names?: string[], overwrite?: boolean, verify?: boolean, signal?: AbortSignal }} [o]
   */
  async save(job, directory, o = {}) {
    const id = idOf(job);
    const j = typeof job === "object" && job.status ? job : await this.get(id);
    const files = await this.files(id);
    return this._save(id, files, directory, o, this._manifest(j, files));
  }

  /** Rows of one file (or all files, with `symbol` and `interval` added) as objects: csv and jsonl files. */
  async read(job, name) {
    const id = idOf(job);
    return this._read(id, await this.files(id), name ? [name] : undefined);
  }

  /** The instrument master (GET /v1/instruments/export): saved to `dest` when given (returns the path) or returned as text. */
  async exportInstruments({ dest, exchange, kind, format = "csv" } = {}) {
    need(format === "csv" || format === "jsonl", "format must be csv or jsonl");
    const query = clean({ exchange, kind, format });
    if (dest) return (await downloadTo(this.client, "/v1/instruments/export", dest, { query })).path;
    return (await this.client.openStream("GET", "/v1/instruments/export", { query })).text();
  }
}

export class Datasets {
  constructor(client) {
    this.client = client;
  }

  async list({ tag } = {}) { return dataOf(await this.client.listDatasets({ tag })) ?? []; }
  async get(name) { return dataOf(await this.client.dataset(name)); }

  /** Fetch only what is new since the dataset's last stored bar. Returns the job; with `wait: true` waits for it. */
  async update(name, { wait = false, ...waitOpts } = {}) {
    const job = dataOf(await this.client.updateDataset(name));
    return wait ? this.client.downloads.wait(job, waitOpts) : job;
  }

  /** Rename a dataset (`newName`), or change its tags or description. */
  async edit(name, { newName, tags, description } = {}) {
    need(newName !== undefined || tags !== undefined || description !== undefined, "give newName, tags or description");
    return dataOf(await this.client.editDataset(name, clean({ name: newName, tags, description })));
  }

  _pairs(ds) {
    const fromFiles = [...new Map((ds.files ?? []).filter((f) => f.symbol && f.interval).map((f) => [`${f.symbol}|${f.interval}`, [f.symbol, f.interval]])).values()];
    return fromFiles.length ? fromFiles : (ds.symbols ?? []).flatMap((s) => (ds.intervals ?? []).map((i) => [s, i]));
  }

  /**
   * The bars of one symbol and interval of a dataset, from the Bridge's own disk (no broker call for bars it has):
   * GET /v1/history?dataset=<name>&localFirst=true. Returns { symbol, interval, candles, freshness, partial } with the
   * data-class label. Without `symbol` and `interval` the dataset must hold exactly one pair.
   * @param {string} name
   * @param {{ symbol?: string, interval?: string, from?: string|number|Date, to?: string|number|Date, account?: string }} [o]
   */
  async read(name, { symbol, interval, from, to, account } = {}) {
    const ds = await this.get(name);
    const pairs = this._pairs(ds);
    let pair = [symbol, interval];
    if (symbol === undefined || interval === undefined) {
      const cand = pairs.filter((p) => (symbol === undefined || p[0] === symbol) && (interval === undefined || p[1] === interval));
      need(cand.length === 1, `dataset ${JSON.stringify(name)} holds ${pairs.length} symbol/interval pairs; say which one: symbol and interval (${pairs.slice(0, 8).map((p) => p.join(" ")).join(", ")})`);
      pair = cand[0];
    }
    const start = from ?? ds.firstBar;
    need(start, `dataset ${JSON.stringify(name)} has no bars yet: run an update first`);
    return new HistoryAll(this.client, { symbol: pair[0], interval: pair[1], from: start, to: to ?? ds.lastBar, localFirst: true, dataset: name, account }).toHistory();
  }

  /** Every symbol and interval of a dataset as [{ symbol, interval, candles, freshness, partial }]. */
  async readAll(name, { from, to } = {}) {
    const ds = await this.get(name);
    const out = [];
    for (const [symbol, interval] of this._pairs(ds)) out.push(await this.read(name, { symbol, interval, from, to }));
    return out;
  }
}

class RecordingRules {
  constructor(client) {
    this.client = client;
  }

  async list() { return dataOf(await this.client.recordingRules()) ?? []; }
  async get(idOrName) {
    const r = (await this.list()).find((x) => x.id === idOrName || x.name === idOrName);
    if (!r) throw new TypeError(`No recording rule ${JSON.stringify(idOrName)}.`);
    return r;
  }

  /**
   * Add a rule: the Bridge starts and stops the recording by itself on trading days. Name the instruments with exactly
   * one of `collection`, `symbols` or `underlying` (with `universe`). `schedule` is "market-hours" (trading days, from the
   * calendar) or { days, start: "09:15", end: "15:30" } (IST). `keepDays` deletes older files.
   * @param {{ name: string, kind: "quotes"|"chain", everySec: number, collection?: string, symbols?: string[], underlying?: string, universe?: object,
   *   schedule?: string|object, enabled?: boolean, keepDays?: number, format?: "csv"|"jsonl" }} r
   */
  async create(r = {}) {
    need(RECORDING_KINDS.includes(r.kind), `kind must be one of ${RECORDING_KINDS.join(", ")}`);
    need(r.everySec >= MIN_EVERY_SEC[r.kind], `everySec must be at least ${MIN_EVERY_SEC[r.kind]} for ${r.kind} recordings`);
    need([r.collection, r.symbols?.length ? r.symbols : undefined, r.underlying].filter(Boolean).length === 1, "name the instruments with exactly one of collection, symbols or underlying (with universe)");
    const body = clean({ name: r.name, enabled: r.enabled ?? true, kind: r.kind, collection: r.collection, symbols: r.symbols?.length ? r.symbols : undefined, underlying: r.underlying, universe: r.universe,
      everySec: r.everySec, schedule: r.schedule ?? "market-hours", keepDays: r.keepDays, format: r.format });
    return dataOf(await this.client.createRecordingRule(body));
  }

  async update(id, changes = {}) {
    need(Object.keys(clean(changes)).length > 0, "nothing to change");
    return dataOf(await this.client.updateRecordingRule(id, clean(changes)));
  }
  enable(id) { return this.update(id, { enabled: true }); }
  disable(id) { return this.update(id, { enabled: false }); }
  async delete(id) { await this.client.deleteRecordingRule(id); }
}

export class Recordings extends FileOwner {
  constructor(client) {
    super(client, "/v1/recordings");
    this.rules = new RecordingRules(client);
  }

  /**
   * Start a recording (POST /v1/recordings) of quotes or option chains saved going forward from the Bridge's own real-time
   * data (it refuses delayed or end-of-day sources). `kind: "quotes"` needs `symbols` or `collection` and `everySec` >= 1;
   * `kind: "chain"` needs `underlying` (and `expiry`) or `collection` and `everySec` >= 15. `sessionOnly` (default true)
   * records inside market hours only.
   * @param {{ kind: "quotes"|"chain", symbols?: string|string[], collection?: string, underlying?: string, expiry?: string, everySec: number, sessionOnly?: boolean,
   *   format?: "csv"|"jsonl", name?: string }} p
   */
  async create(p = {}) {
    need(RECORDING_KINDS.includes(p.kind), `kind must be one of ${RECORDING_KINDS.join(", ")}`);
    need(p.everySec >= MIN_EVERY_SEC[p.kind], `everySec must be at least ${MIN_EVERY_SEC[p.kind]} for ${p.kind} recordings`);
    const symbols = list(p.symbols);
    if (p.kind === "quotes") need(Boolean(symbols.length) !== Boolean(p.collection), "a quotes recording needs symbols or collection: <name> (not both)");
    else need(p.underlying || p.collection, "a chain recording needs underlying (and expiry) or collection: <name>");
    need(p.format === undefined || p.format === "csv" || p.format === "jsonl", "format must be csv or jsonl");
    return dataOf(await this.client.createRecording(clean({ name: p.name, kind: p.kind, symbols: symbols.length ? symbols : undefined, collection: p.collection, underlying: p.underlying, expiry: p.expiry, everySec: p.everySec,
      sessionOnly: p.sessionOnly, format: p.format })));
  }

  async get(rec) { return dataOf(await this.client.recording(idOf(rec))); }
  async list({ status } = {}) { return dataOf(await this.client.listRecordings({ status })) ?? []; }
  async pause(rec) { return dataOf(await this.client.pauseRecording(idOf(rec))); }
  async resume(rec) { return dataOf(await this.client.resumeRecording(idOf(rec))); }
  async stop(rec) { return dataOf(await this.client.stopRecording(idOf(rec))); }
  /** Delete a recording and its files from the Bridge's disk. */
  async delete(rec) { await this.client.deleteRecording(idOf(rec)); }
  async files(rec) { return rowsOf(await this.client.recordingFiles(idOf(rec))); }

  /** Download the recording's day files into `directory` (same rules as downloads.save). */
  async save(rec, directory, o = {}) {
    const id = idOf(rec);
    const r = typeof rec === "object" && rec.status ? rec : await this.get(id);
    const { files: _ignored, ...manifest } = r;
    return this._save(id, await this.files(id), directory, o, manifest);
  }

  /** Rows of one day file (or all) as objects. */
  async read(rec, name) {
    const id = idOf(rec);
    return this._read(id, await this.files(id), name ? [name] : undefined);
  }
}

/**
 * The body of an option-universe collection (a dynamic rule, not a fixed list). `expiries` is current-weekly, next-weekly,
 * current-monthly, all-weekly or an array of ISO dates. Strikes are `count` either side of the at-the-money strike (the
 * default) or a fixed `fromStrike` to `toStrike`. The Bridge recomputes ATM and rolling expiries each time it is resolved.
 * @param {{ underlying: string, expiries?: string|string[], count?: number, fromStrike?: number, toStrike?: number, sides?: Array<"CE"|"PE">,
 *   includeUnderlying?: boolean, includeFuture?: boolean }} p
 */
export function optionUniverse({ underlying, expiries = "current-weekly", count = 10, fromStrike, toStrike, sides = ["CE", "PE"], includeUnderlying = true, includeFuture = false } = {}) {
  need(underlying, "underlying is required");
  let strikes;
  if (fromStrike !== undefined || toStrike !== undefined) {
    need(fromStrike !== undefined && toStrike !== undefined, "give both fromStrike and toStrike, or neither (then count strikes around ATM are used)");
    strikes = { from: fromStrike, to: toStrike };
  } else {
    need(Number.isInteger(count) && count >= 0, "count must be 0 or more");
    strikes = { around: "atm", count };
  }
  need(sides.every((s) => s === "CE" || s === "PE"), "sides are CE and PE");
  return { underlying, expiries: Array.isArray(expiries) ? [...expiries] : expiries, strikes, sides: [...sides], includeUnderlying: Boolean(includeUnderlying), includeFuture: Boolean(includeFuture) };
}

const symbolOf = (s) => (typeof s === "object" && s !== null ? s.symbol : s);

export class Collections {
  constructor(client) {
    this.client = client;
  }

  async list({ tag, kind } = {}) { return dataOf(await this.client.listCollections({ tag, kind })) ?? []; }
  async get(name) { return dataOf(await this.client.collection(name)); }

  /**
   * A static list (`symbols: [...]`) or an option universe (`universe: optionUniverse({...})`).
   * @param {string} name
   * @param {{ symbols?: string[], universe?: object, description?: string, tags?: string[] }} [p]
   */
  async create(name, { symbols, universe, description, tags } = {}) {
    need(Boolean(symbols?.length) !== Boolean(universe), "give either symbols (a fixed list) or universe (an option universe), not both and not neither");
    const body = clean({ name, description, tags: tags ?? [], kind: universe ? "option-universe" : "static", symbols: universe ? undefined : [...symbols], universe });
    return dataOf(await this.client.createCollection(body));
  }

  async update(name, { symbols, universe, description, tags, newName } = {}) {
    const ch = clean({ name: newName, description, tags, symbols, universe });
    need(Object.keys(ch).length > 0, "nothing to change");
    return dataOf(await this.client.updateCollection(name, ch));
  }

  rename(name, newName) { return this.update(name, { newName }); }

  /** Add tags (and drop the ones in `remove`). */
  async tag(name, tags = [], { remove = [] } = {}) {
    const cur = await this.get(name);
    const next = (cur.tags ?? []).filter((t) => !remove.includes(t));
    for (const t of tags) if (!next.includes(t)) next.push(t);
    return this.update(name, { tags: next });
  }

  /** A copy under a new name (same symbols or universe, description and tags). */
  async duplicate(name, newName) {
    const c = await this.get(name);
    return this.create(newName, c.kind === "option-universe" ? { universe: c.universe, description: c.description, tags: c.tags } : { symbols: c.symbols, description: c.description, tags: c.tags });
  }

  async delete(name) { await this.client.deleteCollection(name); }

  /**
   * The concrete symbols now. An option universe is recomputed on each call (rolling expiry, moving ATM). The Bridge refuses
   * to work out an ATM from a delayed or end-of-day price (422) or a stale one (503): that throws BridgeApiError.
   * `allowStale: true` accepts a stale price; the answer is then labelled (`warnings`, `atmSource`, `freshness`): read them,
   * and never trade on such a resolution silently.
   * @param {string} name
   * @param {{ allowStale?: boolean }} [o]
   * @returns {Promise<{ name: string, symbols: string[], resolvedAt?: string, rule?: any, atm?: number, atmSource?: any, freshness?: object, warnings: string[] }>}
   */
  async resolve(name, { allowStale = false } = {}) {
    const d = dataOf(await this.client.resolveCollection(name, { allowStale })) ?? {};
    const warn = d.warnings ?? d.notes ?? [];
    return { ...d, name: d.name ?? name, symbols: (d.symbols ?? []).map(symbolOf), warnings: Array.isArray(warn) ? warn : [String(warn)] };
  }

  /** True when the Bridge flagged nothing about the price behind a resolution (no warnings, fresh real-time label). */
  isReliable(resolution) {
    if (resolution.warnings?.length) return false;
    const f = resolution.freshness;
    return !f || ((f.class ?? "realtime") === "realtime" && !f.stale);
  }

  async symbols(name, o) { return (await this.resolve(name, o)).symbols; }
  /** Which downloads, recordings and datasets use the collection. */
  async usage(name) { return dataOf(await this.client.collectionUsage(name)) ?? {}; }
  /** Size estimate: symbols x intervals x days (rows, bytes and broker calls, as the Bridge reports them). */
  async estimate(name, { intervals, days } = {}) { return dataOf(await this.client.collectionEstimate(name, { intervals: intervals === undefined ? undefined : list(intervals), days })) ?? {}; }

  /** The collection as JSON text or CSV text (a `symbol` column; for an option universe the current resolved symbols); also written to `path`. */
  async export(name, { format = "json", path: file } = {}) {
    const c = await this.get(name);
    let text;
    if (format === "json") {
      const { name: n, description, tags, kind, symbols, universe } = c;
      text = `${JSON.stringify(clean({ name: n, description, tags, kind, ...(kind === "option-universe" ? { universe } : { symbols }) }), null, 2)}\n`;
    } else if (format === "csv") {
      const syms = c.kind === "option-universe" ? await this.symbols(name) : (c.symbols ?? []).map(symbolOf);
      text = toCsv(syms.map((symbol) => ({ symbol })), ["symbol"]);
    } else throw new TypeError("format must be json or csv");
    if (file) await fsp.writeFile(file, text);
    return text;
  }

  /**
   * Create a collection from a file path or text: JSON (the shape `export` writes, or a plain array of symbols) or CSV (a
   * `symbol` column, or one symbol per line). `name` is needed unless the JSON carries one.
   * @param {string} source
   * @param {{ name?: string, format?: "json"|"csv", tags?: string[], description?: string }} [o]
   */
  async importFrom(source, { name, format, tags, description } = {}) {
    let text = source;
    if (!source.includes("\n") && source.length < 4096 && fs.existsSync(source) && fs.statSync(source).isFile()) {
      text = await fsp.readFile(source, "utf8");
      format ??= source.toLowerCase().endsWith(".json") ? "json" : "csv";
    }
    text = text.replace(/^﻿/, "");
    format ??= /^\s*[{[]/.test(text) ? "json" : "csv";
    if (format === "json") {
      let doc = JSON.parse(text);
      if (Array.isArray(doc)) doc = { symbols: doc };
      const cname = name ?? doc.name;
      need(cname, "give name, the JSON has none");
      if (doc.universe) return this.create(cname, { universe: doc.universe, description: description ?? doc.description, tags: tags ?? doc.tags });
      return this.create(cname, { symbols: (doc.symbols ?? []).map(symbolOf), description: description ?? doc.description, tags: tags ?? doc.tags });
    }
    need(name, "give name for a CSV import");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let syms;
    if (lines.length && /^["']?symbols?["']?(,|$)/i.test(lines[0])) {
      const col = lines[0].split(",")[0].replace(/["']/g, "");
      syms = parseTable(lines.join("\n")).map((r) => String(r[col] ?? "").trim()).filter(Boolean);
    } else syms = lines.map((l) => l.split(",")[0].trim().replace(/^["']|["']$/g, ""));
    return this.create(name, { symbols: syms, description, tags });
  }
}

/** Signed outbound webhooks (the Bridge posts events to your URL). Needs an admin key from the Bridge's computer. Verify each delivery with `verifySignature`. */
export class Subscriptions {
  constructor(client) {
    this.client = client;
  }

  async list() { return dataOf(await this.client.listSubscriptions()) ?? []; }
  /** `secret` (at least 16 characters) is write-only: the Bridge never shows it again. */
  async create({ url, topics, secret, active = true } = {}) {
    need(url, "url is required");
    need(Array.isArray(topics) && topics.length > 0, 'topics is required, for example ["download.done"]');
    need(secret, "secret is required (it signs every delivery)");
    return dataOf(await this.client.createSubscription({ url, topics, secret, active }));
  }

  async update(id, { url, topics, secret, active } = {}) {
    const ch = clean({ url, topics, secret, active });
    need(Object.keys(ch).length > 0, "nothing to change");
    return dataOf(await this.client.updateSubscription(id, ch));
  }

  async delete(id) { await this.client.deleteSubscription(id); }
  /** Send a test delivery to the subscription's URL and return the outcome. */
  async test(id) { return dataOf(await this.client.testSubscription(id)) ?? {}; }
  /** The delivery log (status, attempts, response code). */
  async deliveries(id, o = {}) { return dataOf(await this.client.subscriptionDeliveries(id, o)) ?? []; }
}
