/**
 * Datasets: named, growing collections of bars on disk, one file per symbol and interval, updated incrementally
 * (a job with `dataset: "nifty-5m"` continues from the last stored bar instead of fetching everything again).
 *
 * Layout: <dataDir>/downloads/datasets/<name>/dataset.json  and  <SYMBOL>_<interval>.<ext>  next to it.
 *
 * dataset.json: { name, title, tags, format, createdAt, updatedAt, lastJobId, request, dataClass, source, official,
 *   delaySec, notes, series: { "<symbol>|<interval>": { symbol, interval, file, rows, bytes, firstBar, lastBar,
 *   coverage: { from, to } | null, holes: [{ from, to, missing, kind }], holesTotal, sha256, updatedAt } } }
 * Times in a series are epoch seconds. `coverage` is the stretch the Bridge has asked the broker about and written
 * down, with no failed call inside it (see market/localStore.mjs); `holes` are bars missing inside the stored range.
 */
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { DATASET_META_FILE, DATASET_NAME_RE, createLocalStore, datasetsRoot, readDatasetMeta, seriesKey } from "../market/localStore.mjs";
import { toIstIso } from "../market/time.mjs";
import { EXTENSIONS } from "./bars.mjs";
import { removeQuiet, safeFileName, uniqueName, writeJsonAtomic } from "./files.mjs";

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,31}$/;
/** Holes kept per series in dataset.json (the count is always exact). */
const MAX_HOLES = 200;

/** Validate a dataset name; returns it. */
export function checkDatasetName(name) {
  if (typeof name !== "string" || !DATASET_NAME_RE.test(name)) {
    throw new BridgeError("VALIDATION_FAILED", "A dataset name is 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit (for example nifty-5m).", { errors: [{ path: "dataset", message: "not a valid dataset name" }] });
  }
  return name;
}

/** Clean a tag list: trimmed, de-duplicated, at most 20, each a short plain label. */
export function cleanTags(tags) {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags) || tags.length > 20) throw new BridgeError("VALIDATION_FAILED", "tags must be a list of at most 20 short labels.", { errors: [{ path: "tags", message: "too many or not a list" }] });
  const out = [];
  for (const t of tags) {
    const s = String(t ?? "").trim();
    if (!TAG_RE.test(s)) throw new BridgeError("VALIDATION_FAILED", `"${s.slice(0, 40)}" is not a valid tag: use up to 32 letters, digits, spaces, dots, dashes or colons.`, { errors: [{ path: "tags", message: "bad tag" }] });
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

const iso = (sec) => (Number.isFinite(sec) ? toIstIso(sec * 1000) : null);

/**
 * One dataset as the API shows it.
 * @param {any} meta
 * @param {{ detail?: boolean, activeJobId?: string | null }} [o]
 */
export function toPublicDataset(meta, { detail = false, activeJobId = null } = {}) {
  const series = Object.values(meta.series ?? {});
  let rows = 0;
  let bytes = 0;
  let gaps = 0;
  for (const s of series) {
    rows += s.rows ?? 0;
    bytes += s.bytes ?? 0;
    gaps += s.holesTotal ?? 0;
  }
  const out = {
    name: meta.name,
    title: meta.title ?? null,
    tags: meta.tags ?? [],
    format: meta.format,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    request: meta.request,
    dataClass: meta.dataClass,
    source: meta.source ?? null,
    official: meta.official ?? null,
    delaySec: meta.delaySec ?? null,
    series: series.length,
    rows,
    bytes,
    gaps,
    lastJobId: meta.lastJobId ?? null,
    activeJobId,
  };
  if (detail) {
    out.files = series.map((s) => ({
      symbol: s.symbol,
      interval: s.interval,
      name: s.file,
      rows: s.rows ?? 0,
      bytes: s.bytes ?? 0,
      firstBar: iso(s.firstBar),
      lastBar: iso(s.lastBar),
      coverage: s.coverage ? { from: iso(s.coverage.from), to: iso(s.coverage.to) } : null,
      sha256: s.sha256 ?? null,
      gaps: (s.holes ?? []).slice(0, 50).map((h) => ({ from: iso(h.from), to: iso(h.to), missing: h.missing, kind: h.kind })),
      gapsTotal: s.holesTotal ?? 0,
    }));
    out.notes = meta.notes ?? [];
  }
  return out;
}

/**
 * @param {{ dataDir: string, now: () => number, logger?: any }} o
 */
export function createDatasets({ dataDir, now }) {
  const store = createLocalStore({ dataDir });
  /** name -> tail of the serialising chain, so two writers never lose each other's change */
  const chains = new Map();
  const dirOf = (name) => join(datasetsRoot(dataDir), name);

  function serial(name, fn) {
    const prev = chains.get(name) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    chains.set(name, run);
    run.then(
      () => chains.get(name) === run && chains.delete(name),
      () => chains.get(name) === run && chains.delete(name),
    );
    return run;
  }

  async function save(meta) {
    meta.updatedAt = new Date(now()).toISOString();
    await writeJsonAtomic(join(dirOf(meta.name), DATASET_META_FILE), meta);
  }

  return {
    store,
    dirOf,
    names: () => store.names(),
    get: (name) => (DATASET_NAME_RE.test(name) ? readDatasetMeta(dataDir, name) : null),
    list({ tag } = {}) {
      const out = [];
      for (const name of store.names()) {
        const m = readDatasetMeta(dataDir, name);
        if (!m) continue;
        if (tag && !(m.tags ?? []).some((t) => t.toLowerCase() === String(tag).toLowerCase())) continue;
        out.push(m);
      }
      return out;
    },
    /** Folder of a series file. */
    filePath: (meta, s) => join(dirOf(meta.name), s.file),

    /**
     * Create the dataset when it does not exist, else merge the request into it (more symbols or intervals may be added;
     * the format cannot change). Returns the metadata.
     */
    ensure(name, { format, request, tags, title }) {
      checkDatasetName(name);
      return serial(name, async () => {
        let meta = readDatasetMeta(dataDir, name);
        if (meta) {
          if (meta.format !== format) {
            throw new BridgeError("VALIDATION_FAILED", `Dataset ${name} is stored as ${meta.format}. A dataset keeps one format; start a new dataset to use ${format}.`, { errors: [{ path: "format", message: `dataset is ${meta.format}` }] });
          }
          const union = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];
          meta.request = {
            ...meta.request,
            ...request,
            symbols: request.symbols ? union(meta.request?.symbols, request.symbols) : meta.request?.symbols,
            intervals: union(meta.request?.intervals, request.intervals),
          };
          if (tags) meta.tags = [...new Set([...(meta.tags ?? []), ...tags])];
        } else {
          await mkdir(dirOf(name), { recursive: true, mode: 0o700 });
          meta = {
            name,
            title: title ?? null,
            tags: tags ?? [],
            format,
            createdAt: new Date(now()).toISOString(),
            updatedAt: null,
            lastJobId: null,
            request,
            dataClass: "realtime",
            source: null,
            official: null,
            delaySec: null,
            notes: [],
            series: {},
          };
        }
        await save(meta);
        return meta;
      });
    },

    /** The series of a dataset for (symbol, interval), created empty when new. Returns { meta, series }. */
    seriesOf(meta, symbol, interval) {
      const key = seriesKey(symbol, interval);
      let s = meta.series[key];
      if (!s) {
        const taken = new Set(Object.values(meta.series).map((x) => x.file.toLowerCase()));
        s = { symbol, interval, file: uniqueName(`${safeFileName(symbol)}_${interval}`, EXTENSIONS[meta.format], taken), rows: 0, bytes: 0, firstBar: null, lastBar: null, coverage: null, holes: [], holesTotal: 0, sha256: null, updatedAt: null };
      }
      return s;
    },

    /**
     * Record a finished stretch of one series (read-modify-write, serialised).
     * @param {string} name
     * @param {object} s the series (from seriesOf) with the new numbers filled in
     * @param {{ dataClass?: string, source?: string | null, official?: boolean | null, delaySec?: number | null, jobId?: string, notes?: string[] }} [label]
     */
    commitSeries(name, s, label = {}) {
      return serial(name, async () => {
        const meta = readDatasetMeta(dataDir, name);
        if (!meta) throw new BridgeError("NOT_FOUND", `There is no dataset "${name}".`);
        const holes = s.holes ?? [];
        meta.series[seriesKey(s.symbol, s.interval)] = { ...s, holes: holes.slice(0, MAX_HOLES), holesTotal: s.holesTotal ?? holes.length, updatedAt: new Date(now()).toISOString() };
        // the dataset's class is the least current class of anything in it
        if (label.dataClass) {
          const rank = { realtime: 0, delayed: 1, eod: 2 };
          if ((rank[label.dataClass] ?? 0) >= (rank[meta.dataClass] ?? 0)) meta.dataClass = label.dataClass;
        }
        if (label.source !== undefined) meta.source = meta.source && label.source && meta.source !== label.source ? [...new Set([...meta.source.split(", "), ...label.source.split(", ")])].join(", ") : (label.source ?? meta.source);
        if (label.official !== undefined && label.official !== null) meta.official = meta.official === false ? false : label.official;
        if (Number.isFinite(label.delaySec)) meta.delaySec = Math.max(meta.delaySec ?? 0, label.delaySec);
        if (label.jobId) meta.lastJobId = label.jobId;
        if (label.notes?.length) meta.notes = [...new Set([...(meta.notes ?? []), ...label.notes])].slice(-20);
        await save(meta);
        return meta;
      });
    },

    /** Change tags and/or title. */
    patch(name, { tags, title }) {
      return serial(name, async () => {
        const meta = readDatasetMeta(dataDir, name);
        if (!meta) throw new BridgeError("NOT_FOUND", `There is no dataset "${name}".`);
        if (tags !== undefined) meta.tags = tags;
        if (title !== undefined) meta.title = title === null || title === "" ? null : String(title).slice(0, 120);
        await save(meta);
        return meta;
      });
    },

    /** Rename the dataset's folder and metadata. */
    rename(name, to) {
      checkDatasetName(to);
      return serial(name, async () => {
        const meta = readDatasetMeta(dataDir, name);
        if (!meta) throw new BridgeError("NOT_FOUND", `There is no dataset "${name}".`);
        if (readDatasetMeta(dataDir, to) || store.names().includes(to)) throw new BridgeError("STATE_CONFLICT", `A dataset named "${to}" already exists.`);
        await rename(dirOf(name), dirOf(to));
        meta.name = to;
        await save(meta);
        return meta;
      });
    },

    /** Delete the dataset and its files. */
    remove(name) {
      return serial(name, async () => {
        if (!readDatasetMeta(dataDir, name)) throw new BridgeError("NOT_FOUND", `There is no dataset "${name}".`);
        await removeQuiet(dirOf(name));
      });
    },
  };
}
