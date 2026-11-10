/**
 * Local-first history: bars this Bridge already holds on disk, so the broker is asked only for what is missing.
 *
 * The bars live in datasets (server/bridge/downloads/datasets.mjs writes them under <dataDir>/downloads/datasets/<name>/).
 * Each series (one symbol and one interval) records its COVERAGE: the stretch of time the Bridge has already asked the
 * broker about and written down, with no hole left by a failed call. readRange() serves bars inside the coverage and
 * lists the rest as gaps:
 *
 *   const store = createLocalStore({ dataDir });
 *   const { bars, gaps, complete, source } = await store.readRange("NSE:NIFTY", "5m", fromSec, toSec);
 *   // bars: the stored bars in [from, to]; gaps: [{ from, to }] still to ask the broker (epoch seconds, inclusive)
 *
 * Honest labels: `source` carries the dataset's own data class, source name, delay and official flag, so a caller never
 * calls stored bars "realtime" unless that is what they were when they were written. Nothing here makes a broker call.
 * `holes` are places inside the coverage where bars are missing (a thin stock may have no bar when nothing traded); they
 * are reported, never filled in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readBars } from "../downloads/bars.mjs";

export const DATASET_META_FILE = "dataset.json";
export const DATASET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Folder that holds every dataset. */
export const datasetsRoot = (dataDir) => join(dataDir, "downloads", "datasets");
/** Series key inside a dataset. */
export const seriesKey = (symbol, interval) => `${symbol}|${interval}`;

/** One dataset's metadata, or null when the folder has none or it cannot be read. */
export function readDatasetMeta(dataDir, name) {
  if (!DATASET_NAME_RE.test(name)) return null;
  try {
    const meta = JSON.parse(readFileSync(join(datasetsRoot(dataDir), name, DATASET_META_FILE), "utf8"));
    return meta && typeof meta === "object" && meta.series && typeof meta.series === "object" ? meta : null;
  } catch {
    return null;
  }
}

/** The part of [from, to] that is not inside `coverage` ({ from, to } or null), as up to two inclusive ranges. */
export function subtractCoverage(from, to, coverage) {
  if (to < from) return [];
  if (!coverage || coverage.to < coverage.from || coverage.to < from || coverage.from > to) return [{ from, to }];
  const out = [];
  if (coverage.from > from) out.push({ from, to: coverage.from - 1 });
  if (coverage.to < to) out.push({ from: coverage.to + 1, to });
  return out;
}

/**
 * @param {{ dataDir: string }} opts
 */
export function createLocalStore({ dataDir }) {
  /** Names of the datasets on disk. */
  function names() {
    try {
      return readdirSync(datasetsRoot(dataDir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && DATASET_NAME_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  return {
    /** Names of the datasets on disk. */
    names,
    /** Metadata of one dataset, or null. */
    meta: (name) => readDatasetMeta(dataDir, name),

    /**
     * Stored bars of one series inside [fromSec, toSec], and the parts of that range the store does not cover.
     * @param {string} symbol canonical
     * @param {string} interval
     * @param {number} fromSec epoch seconds, inclusive
     * @param {number} toSec epoch seconds, inclusive
     * @param {{ dataset?: string }} [opts] read this dataset only; else the dataset that covers most of the range
     * @returns {Promise<{ bars: object[], gaps: Array<{ from: number, to: number }>, complete: boolean, covered: { from: number, to: number } | null, holes: object[],
     *   source: null | { dataset: string, dataClass: string, source: string | null, official: boolean | null, delaySec: number | null, updatedAt: string | null } }>}
     */
    async readRange(symbol, interval, fromSec, toSec, { dataset } = {}) {
      const none = { bars: [], gaps: toSec >= fromSec ? [{ from: fromSec, to: toSec }] : [], complete: toSec < fromSec, covered: null, holes: [], source: null };
      const key = seriesKey(symbol, interval);
      let best = null;
      for (const name of dataset ? [dataset] : names()) {
        const meta = readDatasetMeta(dataDir, name);
        const s = meta?.series?.[key];
        if (!s?.coverage) continue;
        const lo = Math.max(fromSec, s.coverage.from);
        const hi = Math.min(toSec, s.coverage.to);
        const overlap = hi - lo;
        if (hi < lo) continue;
        if (!best || overlap > best.overlap) best = { name, meta, s, lo, hi, overlap };
      }
      if (!best) return none;
      const { name, meta, s, lo, hi } = best;
      const bars = [];
      for await (const { bar } of readBars(join(datasetsRoot(dataDir), name, s.file), { format: meta.format, layout: "per-symbol", interval })) {
        if (bar.time > hi) break;
        if (bar.time >= lo) bars.push(bar);
      }
      const gaps = subtractCoverage(fromSec, toSec, s.coverage);
      return {
        bars,
        gaps,
        complete: gaps.length === 0,
        covered: { from: lo, to: hi },
        holes: (s.holes ?? []).filter((h) => h.to >= lo && h.from <= hi),
        source: { dataset: name, dataClass: meta.dataClass ?? "realtime", source: meta.source ?? null, official: meta.official ?? null, delaySec: meta.delaySec ?? null, updatedAt: s.updatedAt ?? null },
      };
    },
  };
}
