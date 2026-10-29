/**
 * The vol stores (stream S18, docs/spec/p1-03-pricing-vol.md §2.3) under `root` (dataDir/vol/, dataDir/vol-demo/ in
 * demo mode, mode 0700). Every file is append-only JSON lines through server/lib/jsonl.mjs: one record per line, the
 * LAST line for a key wins, a torn or corrupt line is skipped and counted (it never stops the service), and compaction
 * rewrites a file atomically when more than 20 % of its lines are superseded or retention drops rows.
 *
 *   state.json                         scheduler state (last runs, attempts, counters)
 *   daily/<UNDERLYING>/expiries.jsonl  store S2: one row per (date, expiry)
 *   daily/<UNDERLYING>/summary.jsonl   one row per date (cm30, front, VIX, HV) or an explicit missed row
 *   vix.jsonl                          INDIA VIX daily closes { date, o, h, l, c, source }
 *   predictions/<YYYY-MM>.jsonl        store S9
 *
 * Precedence for one key: a live row (or a missed row written by the scheduler) is never replaced by a back-fill row;
 * a back-fill row may fill a missed day; a later live row replaces anything (§2.6 step 5, §1.3).
 *
 * In memory: every summary row, and a slim per-expiry index (date, expiry, units, T, tv, atmIv, quality, plus the few
 * fields the history series read). Full expiry rows are read from disk on request.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendLines, compact as compactFile, readLinesSync, writeFileAtomic } from "../../lib/jsonl.mjs";

const DIR_MODE = 0o700;
const UNDERLYING_RE = /^[A-Z0-9&-]{1,30}$/;
const SUPERSEDED_SHARE = 0.2;
const DAY = 86_400_000;

const isLive = (r) => r?.quality === "live" || r?.quality === "live-snapshot";
const isBackfill = (r) => r?.quality === "backfill-eod";
/** Whether `next` may replace `prev` for the same key. */
export function mayReplace(prev, next) {
  if (!prev) return true;
  if (isBackfill(next) && isLive(prev)) return false;
  if (next?.missed && !prev.missed) return false;
  return true;
}

/** The slim in-memory form of an expiry row. */
export function slimOf(r) {
  return {
    date: r.date,
    expiry: r.expiry,
    units: r.clock?.units ?? null,
    T: r.clock?.T ?? null,
    Tw: r.clock?.Tw ?? r.clock?.T ?? null,
    Tcal: r.clock?.Tcal ?? null,
    Ttd: r.clock?.Ttd ?? null,
    tv: r.tv ?? null,
    atmIv: r.atmIv ?? null,
    quality: r.quality ?? null,
    forward: r.forward ?? null,
    straddle: r.straddle ?? null,
    rr25: r.rr25 ?? null,
    bf25: r.bf25 ?? null,
    flags: r.flags ?? [],
  };
}

const minusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY).toISOString().slice(0, 10);

/**
 * @param {{ root: string, logger?: object, retentionDays?: number, predictionRetentionDays?: number }} opts
 */
export function createVolStore({ root, logger = null, retentionDays = 3650, predictionRetentionDays = 1100 }) {
  /** u -> { summary: Map<date,row>, expiries: Map<"date|expiry", slim>, lines: { summary, expiries } } */
  const byU = new Map();
  /** date -> vix row */
  const vix = new Map();
  let vixLines = 0;
  const health = { corruptLines: 0, tornTails: 0, files: 0 };
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const p = queue.then(fn);
    queue = p.catch((err) => logger?.warn?.("vol store write failed", { err: err?.message }));
    return p;
  };

  const dailyDir = (u) => join(root, "daily", u);
  const expFile = (u) => join(dailyDir(u), "expiries.jsonl");
  const sumFile = (u) => join(dailyDir(u), "summary.jsonl");
  const vixFile = () => join(root, "vix.jsonl");
  const predFile = (month) => join(root, "predictions", `${month}.jsonl`);
  const stateFile = () => join(root, "state.json");

  const entry = (u) => {
    if (!byU.has(u)) byU.set(u, { summary: new Map(), expiries: new Map(), lines: { summary: 0, expiries: 0 } });
    return byU.get(u);
  };
  const read = (file) => {
    const r = readLinesSync(file);
    if (!r.missing) health.files += 1;
    if (r.corrupt || r.tornTail) {
      health.corruptLines += r.corrupt;
      if (r.tornTail) health.tornTails += 1;
      logger?.warn?.("vol store skipped unreadable lines", { file, corrupt: r.corrupt, tornTail: r.tornTail });
    }
    return r.items;
  };

  function load() {
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    byU.clear();
    vix.clear();
    const base = join(root, "daily");
    const dirs = existsSync(base) ? readdirSync(base).filter((d) => UNDERLYING_RE.test(d)) : [];
    for (const u of dirs) {
      const e = entry(u);
      const sums = read(sumFile(u));
      e.lines.summary = sums.length;
      for (const r of sums) if (r?.date && mayReplace(e.summary.get(r.date), r)) e.summary.set(r.date, r);
      const exps = read(expFile(u));
      e.lines.expiries = exps.length;
      for (const r of exps) {
        if (!r?.date || !r?.expiry) continue;
        const k = `${r.date}|${r.expiry}`;
        if (mayReplace(e.expiries.get(k), r)) e.expiries.set(k, slimOf(r));
      }
    }
    const v = read(vixFile());
    vixLines = v.length;
    for (const r of v) if (r?.date) vix.set(r.date, r);
    return { underlyings: dirs.length, ...health };
  }

  /**
   * Store expiry rows of one underlying. Rows a back-fill may not replace are skipped. Returns the rows written.
   */
  function putExpiryRows(u, rows) {
    const e = entry(u);
    const out = [];
    for (const r of rows ?? []) {
      const k = `${r.date}|${r.expiry}`;
      if (!mayReplace(e.expiries.get(k), r)) continue;
      e.expiries.set(k, slimOf(r));
      out.push(r);
    }
    e.lines.expiries += out.length;
    if (out.length) enqueue(() => appendLines(expFile(u), out));
    return out;
  }

  /** Store summary rows (or missed rows). Returns the rows written. */
  function putSummaries(u, rows) {
    const e = entry(u);
    const out = [];
    for (const r of rows ?? []) {
      if (!r?.date || !mayReplace(e.summary.get(r.date), r)) continue;
      e.summary.set(r.date, r);
      out.push(r);
    }
    e.lines.summary += out.length;
    if (out.length) enqueue(() => appendLines(sumFile(u), out));
    return out;
  }

  function putVix(rows) {
    const out = (rows ?? []).filter((r) => r?.date && Number.isFinite(r.c));
    for (const r of out) vix.set(r.date, r);
    vixLines += out.length;
    if (out.length) enqueue(() => appendLines(vixFile(), out));
    return out;
  }

  /** Append S9 prediction rows to their month files. */
  function appendPredictions(rows) {
    const byMonth = new Map();
    for (const r of rows ?? []) {
      const m = String(r.ts ?? "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(r);
    }
    return enqueue(async () => {
      for (const [m, list] of byMonth) await appendLines(predFile(m), list);
      return [...byMonth.values()].flat().length;
    });
  }

  /** S9 rows with ts dates in [from, to], last line per id wins, oldest first. */
  function readPredictions({ from, to }) {
    const dir = join(root, "predictions");
    if (!existsSync(dir)) return [];
    const months = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 7))
      .filter((m) => m >= from.slice(0, 7) && m <= to.slice(0, 7))
      .sort();
    const byId = new Map();
    for (const m of months) for (const r of read(predFile(m))) if (r?.id) byId.set(r.id, r);
    return [...byId.values()].filter((r) => String(r.ts).slice(0, 10) >= from && String(r.ts).slice(0, 10) <= to).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  }

  /** Full expiry rows from disk for [from, to] (and one expiry when given), last line per key wins, by date. */
  function readExpiryRows(u, { from = "0000-00-00", to = "9999-99-99", expiry = null } = {}) {
    const best = new Map();
    for (const r of read(expFile(u))) {
      if (!r?.date || r.date < from || r.date > to || (expiry && r.expiry !== expiry)) continue;
      const k = `${r.date}|${r.expiry}`;
      if (mayReplace(best.get(k), r)) best.set(k, r);
    }
    return [...best.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.expiry < b.expiry ? -1 : 1));
  }

  const sortedValues = (m) => [...m.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  /**
   * Compaction and retention (§2.4 `compact`): rewrite a file when more than 20 % of its lines are superseded or rows
   * older than the retention cut-off exist. Prediction month files older than their retention are deleted.
   */
  async function compactAll({ today }) {
    await queue;
    const cut = minusDays(today, retentionDays);
    const done = [];
    for (const [u, e] of byU) {
      const sums = sortedValues(e.summary);
      const keepS = sums.filter((r) => r.date >= cut);
      if (e.lines.summary > 0 && (keepS.length < sums.length || 1 - sums.length / e.lines.summary > SUPERSEDED_SHARE)) {
        for (const r of sums) if (r.date < cut) e.summary.delete(r.date);
        compactFile(sumFile(u), keepS);
        e.lines.summary = keepS.length;
        done.push(`${u}/summary`);
      }
      if (e.lines.expiries > 0 && (1 - e.expiries.size / e.lines.expiries > SUPERSEDED_SHARE || [...e.expiries.values()].some((r) => r.date < cut))) {
        const keep = readExpiryRows(u, { from: cut });
        for (const [k, r] of e.expiries) if (r.date < cut) e.expiries.delete(k);
        compactFile(expFile(u), keep);
        e.lines.expiries = keep.length;
        done.push(`${u}/expiries`);
      }
    }
    if (vixLines > 0 && 1 - vix.size / vixLines > SUPERSEDED_SHARE) {
      compactFile(vixFile(), sortedValues(vix));
      vixLines = vix.size;
      done.push("vix");
    }
    const pdir = join(root, "predictions");
    if (existsSync(pdir)) {
      const pcut = minusDays(today, predictionRetentionDays).slice(0, 7);
      for (const f of readdirSync(pdir)) {
        if (/^\d{4}-\d{2}\.jsonl$/.test(f) && f.slice(0, 7) < pcut) {
          rmSync(join(pdir, f), { force: true });
          done.push(`predictions/${f}`);
        }
      }
    }
    return done;
  }

  /** Bytes on disk under root. */
  function bytes() {
    let total = 0;
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else total += s.size;
      }
    };
    walk(root);
    return total;
  }

  function readState() {
    const r = readLinesSync(stateFile());
    // state.json is one JSON object (written atomically); readLinesSync parses it as one line.
    return r.items[0] && typeof r.items[0] === "object" ? r.items[0] : {};
  }
  function writeState(s) {
    writeFileAtomic(stateFile(), `${JSON.stringify(s)}\n`);
  }

  return {
    root,
    load,
    putExpiryRows,
    putSummaries,
    putVix,
    appendPredictions,
    readPredictions,
    readExpiryRows,
    compactAll,
    bytes,
    readState,
    writeState,
    /** Wait for queued appends (tests, stop()). */
    flush: () => queue,
    underlyings: () => [...byU.keys()].sort(),
    summaries: (u) => (byU.has(u) ? sortedValues(byU.get(u).summary) : []),
    summaryOn: (u, date) => byU.get(u)?.summary.get(date) ?? null,
    expiryIndex: (u) => (byU.has(u) ? [...byU.get(u).expiries.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.expiry < b.expiry ? -1 : 1)) : []),
    vixRows: () => sortedValues(vix),
    isEmpty: () => byU.size === 0 && vix.size === 0,
    health: () => ({ ...health }),
  };
}
