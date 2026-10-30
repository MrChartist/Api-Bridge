/**
 * Live facts collector for the scanner (outside demo mode). It never adds a fetch path of its own: every number comes
 * from a shared read that already exists, at background priority (users and orders go first).
 *
 *   daily bars      marketData.history (1d), ONCE per symbol per IST day, after the shared background gate and inside
 *                   the scanner's budget share; kept in memory and in <dataDir>/scanner/daily-<date>.json so a restart
 *                   costs nothing
 *   live quotes     marketData.quotes in chunks of 200: the stream first, then the shared quote cache (15 s), then
 *                   one batched broker call per chunk (the batcher packs them per the broker's batch size). Not
 *                   gated: a broker with a 1/s quote window could never pass a 50 % floor, and it is one call per
 *                   200 symbols at background priority
 *   futures         the same quotes read for the near and next month futures (instrument master: no broker call);
 *                   OI change against the previous day's OI from the future's daily bar when asked for, else the
 *                   first OI seen today
 *   option chains   the recorder's memory (recorder.latest) and the option sweep's chains: no broker call
 *   IV history      ATM IV stored once per day per symbol in <dataDir>/scanner/iv-history.json
 *   MWPL and ban    reference.mwplList(): memory
 *
 * What a scan reads decides what is fetched (needsOf): a price scan never reads futures, a PCR scan never reads daily
 * bars. Each collect returns usage counts; broker calls are counted by the scheduler under the consumer "Scanner".
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { isStub } from "../core/contracts.mjs";
import { MAX_BACKGROUND_SHARE, createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { completedBars, dailyFacts, istDay } from "./facts.mjs";
import { symbolMeta } from "./sectors.mjs";

const usable = (s) => Boolean(s) && !isStub(s);
const QUOTE_CHUNK = 200;
const DAILY_BARS = 270;
const IV_DAYS = 260;
/** Wait on the Bridge clock's timers when it has them (tests drive a manual clock), else the real ones. */
const sleeper = (clock) => (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const set = typeof clock?.setTimeout === "function" ? clock.setTimeout.bind(clock) : setTimeout;
    const clear = typeof clock?.clearTimeout === "function" ? clock.clearTimeout.bind(clock) : clearTimeout;
    const t = set(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clear(t);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    });
  });

/** Fields → data parts. Anything with a candle function, an offset or a plain candle field needs daily bars. */
const PART_OF = {
  daily: ["prev_high", "prev_low", "high_52w", "low_52w", "from_52w_high_pct", "nr7", "inside_day", "avg_volume_20", "vol_pace", "hv20", "iv_hv_gap"],
  futures: ["fut_change_pct", "fut_oi", "fut_oi_change_pct", "basis", "basis_pct", "basis_ann_pct", "rollover_pct"],
  futuresPrevOi: ["fut_oi_change_pct"],
  chain: ["pcr", "atm_iv", "iv_rank", "iv_percentile", "iv_hv_gap", "put_skew", "call_skew", "max_pain_dist_pct", "straddle_pct", "expected_move_pct", "straddle_vs_move", "top_oi_chg_pct", "max_vol_oi", "dte"],
  ivHistory: ["iv_rank", "iv_percentile"],
  mwpl: ["mwpl_pct", "in_ban"],
};

/**
 * The data parts a set of trees reads.
 * @param {object[]} trees parsed expressions (scanner/expr.mjs)
 * @returns {Set<string>}
 */
export function needsOf(trees) {
  const parts = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.t === "field") {
      for (const [part, fields] of Object.entries(PART_OF)) if (fields.includes(n.name)) parts.add(part);
    }
    if (n.t === "call" || n.t === "shift") parts.add("daily");
    for (const k of ["l", "r", "x", "src"]) walk(n[k]);
    for (const a of n.args ?? []) walk(a);
  };
  for (const t of trees) walk(t);
  return parts;
}

/**
 * @param {{ marketData: object, accounts?: object, scheduler?: object, symbols?: object, recorder?: object, reference?: object,
 *   fno?: () => object|null, bus?: object, clock: { now(): number }, dataDir?: string|null, share?: number, logger?: object }} deps
 */
export function createLiveFacts(deps) {
  const now = () => deps.clock.now();
  const share = Math.min(deps.share ?? MAX_BACKGROUND_SHARE, MAX_BACKGROUND_SHARE);
  const sleep = sleeper(deps.clock);
  const gate = usable(deps.scheduler) && typeof deps.scheduler.headroom === "function" ? createBackgroundGate({ scheduler: deps.scheduler }) : null;
  const dir = deps.dataDir ? join(deps.dataDir, "scanner") : null;
  const log = deps.logger;

  /** symbol -> { bars: [[t,o,h,l,c,v]], facts } for `day` */
  let day = null;
  let daily = new Map();
  /** future canonical -> first OI seen today (the fallback base) */
  let oiBase = new Map();
  /** future canonical -> previous day's OI from its daily bar */
  let futPrevOi = new Map();
  let futIndex = null;
  let futIndexDay = null;
  /** ticker -> [{ date, iv }] */
  let ivHist = null;
  let ivDirty = false;
  /** underlying -> latest recorder expiry seen */
  const recorderKeys = new Map();
  deps.bus?.on?.("recorder.snapshot", (p) => {
    if (p?.underlying && p.expiry) {
      const cur = recorderKeys.get(p.underlying);
      if (!cur || p.expiry < cur || cur < istDay(now())) recorderKeys.set(p.underlying, p.expiry);
    }
  });

  // ── the day file ──
  const dayFile = (d) => (dir ? join(dir, `daily-${d}.json`) : null);
  function rollDay() {
    const d = istDay(now());
    if (d === day) return;
    day = d;
    daily = new Map();
    oiBase = new Map();
    futPrevOi = new Map();
    const f = dayFile(d);
    if (f && existsSync(f)) {
      try {
        const doc = JSON.parse(readFileSync(f, "utf8"));
        if (doc?.version === 1 && doc.date === d) {
          for (const [s, v] of Object.entries(doc.daily ?? {})) daily.set(s, v);
          for (const [s, v] of Object.entries(doc.oiBase ?? {})) oiBase.set(s, v);
          for (const [s, v] of Object.entries(doc.futPrevOi ?? {})) futPrevOi.set(s, v);
        }
      } catch {
        log?.warn?.("scanner: the daily cache could not be read; starting it again");
      }
    }
    // Keep only today's file.
    if (dir && existsSync(dir)) {
      try {
        for (const name of readdirSync(dir)) if (/^daily-\d{4}-\d{2}-\d{2}\.json$/.test(name) && name !== `daily-${d}.json`) rmSync(join(dir, name), { force: true });
      } catch {
        // best effort
      }
    }
  }
  function saveDay() {
    const f = dayFile(day);
    if (!f) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(f, `${JSON.stringify({ version: 1, date: day, daily: Object.fromEntries(daily), oiBase: Object.fromEntries(oiBase), futPrevOi: Object.fromEntries(futPrevOi) })}\n`);
    } catch (err) {
      log?.warn?.("scanner: could not save the daily cache", { err: err?.message });
    }
  }

  // ── IV history ──
  const ivFile = () => (dir ? join(dir, "iv-history.json") : null);
  function loadIv() {
    if (ivHist) return ivHist;
    ivHist = new Map();
    const f = ivFile();
    if (f && existsSync(f)) {
      try {
        const doc = JSON.parse(readFileSync(f, "utf8"));
        for (const [k, v] of Object.entries(doc?.symbols ?? {})) if (Array.isArray(v)) ivHist.set(k, v);
      } catch {
        log?.warn?.("scanner: the IV history could not be read; starting it again");
      }
    }
    return ivHist;
  }
  function noteIv(ticker, iv) {
    if (!(iv > 0)) return;
    const h = loadIv();
    const list = h.get(ticker) ?? [];
    const d = istDay(now());
    const rounded = Math.round(iv * 100) / 100;
    if (list.length && list[list.length - 1].date === d) list[list.length - 1].iv = rounded;
    else list.push({ date: d, iv: rounded });
    if (list.length > IV_DAYS) list.splice(0, list.length - IV_DAYS);
    h.set(ticker, list);
    ivDirty = true;
  }
  function saveIv() {
    const f = ivFile();
    if (!f || !ivDirty) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(f, `${JSON.stringify({ version: 1, symbols: Object.fromEntries(ivHist) })}\n`);
      ivDirty = false;
    } catch (err) {
      log?.warn?.("scanner: could not save the IV history", { err: err?.message });
    }
  }

  // ── budget ──
  function dataAccount(capability) {
    try {
      return deps.accounts?.marketDataCandidates?.({ capability })?.[0] ?? null;
    } catch {
      return null;
    }
  }
  /** Wait until the background gate lets one call of this class through (or the scan is cancelled). */
  async function admit(cls, capability, signal, usage) {
    if (!gate) return;
    const acc = dataAccount(capability);
    if (!acc) return;
    for (let i = 0; i < 600; i += 1) {
      if (gate.allow(acc, cls, { share })) return;
      usage.gateWaits += 1;
      await sleep(Math.min(5000, Math.max(100, gate.waitMs(acc, cls, { share }))), signal);
    }
  }
  const readOpts = (signal, extra = {}) => ({ priority: "background", backgroundShare: share, allowBackup: true, signal, ...extra });

  // ── parts ──
  async function loadDaily(symbols, { signal, usage, concurrency = 3 }) {
    const missing = symbols.filter((s) => !daily.has(s));
    usage.dailyCached += symbols.length - missing.length;
    const today = istDay(now());
    let changed = false;
    const worker = async () => {
      while (missing.length) {
        if (signal?.aborted) return;
        const s = missing.shift();
        try {
          await admit("history", "historical", signal, usage);
          const h = await deps.marketData.history({ symbol: s, interval: "1d", countback: DAILY_BARS }, readOpts(signal));
          const bars = completedBars(h.candles, today);
          daily.set(s, { bars: bars.map((b) => [b.time, b.open, b.high, b.low, b.close, Number.isFinite(b.volume) ? b.volume : null]), facts: dailyFacts(bars), source: h.freshness?.source ?? null });
          usage.dailyFetched += 1;
          changed = true;
        } catch (err) {
          if (err?.name === "AbortError" || signal?.aborted) return;
          usage.errors.push({ symbol: s, part: "daily", code: err?.code ?? "INTERNAL", message: err?.detail ?? err?.message ?? "failed" });
          daily.set(s, { bars: [], facts: null, error: err?.code ?? "INTERNAL" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    if (changed) saveDay();
  }

  async function readQuotes(symbols, { signal, usage }) {
    const out = new Map();
    for (let i = 0; i < symbols.length; i += QUOTE_CHUNK) {
      if (signal?.aborted) break;
      const chunk = symbols.slice(i, i + QUOTE_CHUNK);
      try {
        const r = await deps.marketData.quotes(chunk, { priority: "background", allowBackup: true, signal, maxAgeMs: 15_000 });
        for (const it of r.items ?? []) {
          out.set(it.symbol, it);
          const src = it.freshness?.source ?? "broker";
          usage.quotes[src] = (usage.quotes[src] ?? 0) + 1;
        }
        for (const e of r.errors ?? []) usage.errors.push({ symbol: e.symbol, part: "quote", code: e.code, message: e.message });
      } catch (err) {
        if (err?.name === "AbortError" || signal?.aborted) break;
        for (const s of chunk) usage.errors.push({ symbol: s, part: "quote", code: err?.code ?? "INTERNAL", message: err?.detail ?? "Quote read failed." });
      }
    }
    return out;
  }

  /** underlying -> [{ canonical, expiry }] sorted by expiry (today and later), from the instrument master. */
  async function futures() {
    const d = istDay(now());
    if (futIndex && futIndexDay === d) return futIndex;
    const idx = new Map();
    if (usable(deps.symbols)) {
      let cursor;
      for (let page = 0; page < 60; page += 1) {
        let res;
        try {
          res = await deps.symbols.search({ q: "FUT", kind: "FUT", exchange: "NFO", limit: 500, ...(cursor ? { cursor } : {}) });
        } catch {
          break;
        }
        for (const r of res?.items ?? []) {
          if (!r?.underlying || !r.expiry || r.expiry < d) continue;
          const list = idx.get(r.underlying) ?? [];
          list.push({ canonical: r.canonical, expiry: r.expiry });
          idx.set(r.underlying, list);
        }
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
    }
    for (const list of idx.values()) list.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
    futIndex = idx;
    futIndexDay = d;
    return idx;
  }

  /** The previous day's OI of a future from its daily bars (once a day), when the scan reads OI change. */
  async function loadFutPrevOi(canonicals, { signal, usage }) {
    const missing = canonicals.filter((c) => !futPrevOi.has(c));
    const today = istDay(now());
    let changed = false;
    for (const c of missing) {
      if (signal?.aborted) break;
      try {
        await admit("history", "historical", signal, usage);
        const h = await deps.marketData.history({ symbol: c, interval: "1d", countback: 3 }, readOpts(signal));
        const bars = completedBars(h.candles, today);
        const oi = bars.length ? Number(bars[bars.length - 1].oi) : NaN;
        futPrevOi.set(c, Number.isFinite(oi) && oi > 0 ? oi : null);
        changed = true;
      } catch (err) {
        if (err?.name === "AbortError" || signal?.aborted) break;
        futPrevOi.set(c, null);
      }
    }
    if (changed) saveDay();
  }

  /** ticker -> standard chain, from the recorder's memory and the option sweep (no broker call). */
  async function chains(tickers) {
    const out = new Map();
    const want = new Set(tickers);
    const sweeper = deps.fno?.()?.sweeper ?? null;
    if (sweeper?.chains) {
      try {
        let since = 0;
        for (let page = 0; page < 40; page += 1) {
          const r = sweeper.chains({ since, limit: 200 });
          for (const it of r.items ?? []) {
            const c = it.chain;
            if (!c?.underlying || !want.has(c.underlying)) continue;
            const cur = out.get(c.underlying);
            if (!cur || (c.expiry && c.expiry < cur.expiry)) out.set(c.underlying, c);
          }
          if (!r.items?.length || r.nextCursor === since) break;
          since = r.nextCursor;
        }
      } catch {
        // no sweep today
      }
    }
    if (usable(deps.recorder) && typeof deps.recorder.latest === "function") {
      for (const [u, expiry] of recorderKeys) {
        if (!want.has(u)) continue;
        try {
          const snap = await deps.recorder.latest({ underlying: u, expiry });
          if (!snap) continue;
          const rows = (snap.k ?? []).map((k, i) => {
            const leg = (side) => {
              const s = snap[side] ?? {};
              const ltp = s.ltp?.[i] ?? null;
              return ltp === null ? null : { ltp, oi: s.oi?.[i] ?? null, oiChange: s.oiChg?.[i] ?? s.doi?.[i] ?? null, volume: s.vol?.[i] ?? null, iv: s.iv?.[i] ?? null };
            };
            return { strike: k, ce: leg("ce"), pe: leg("pe") };
          });
          // The recorder's minute snapshot is fresher than the sweep.
          out.set(u, { underlying: u, expiry, underlyingLtp: snap.spot ?? null, lotSize: snap.lotSize ?? snap.lot ?? null, rows });
        } catch {
          // skip
        }
      }
    }
    return out;
  }

  function mwplMap() {
    const out = new Map();
    if (!usable(deps.reference) || typeof deps.reference.mwplList !== "function") return out;
    try {
      const r = deps.reference.mwplList({});
      for (const it of r?.items ?? []) out.set(it.symbol, { mwplPct: it.mwplPct ?? null, inBan: it.band === "ban" ? true : it.band ? false : null });
    } catch {
      // not available
    }
    return out;
  }

  const unpack = (rows) => rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume: volume ?? NaN }));

  return {
    /**
     * Raw parts per symbol for a scan.
     * @param {string[]} symbols canonical
     * @param {{ needs: Set<string>, signal?: AbortSignal, cacheOnly?: boolean }} o
     * @returns {Promise<{ raw: Map<string, object>, usage: object }>}
     */
    async collect(symbols, { needs, signal, cacheOnly = false }) {
      rollDay();
      const usage = { quotes: {}, dailyCached: 0, dailyFetched: 0, gateWaits: 0, errors: [] };
      if (needs.has("daily") && !cacheOnly) await loadDaily(symbols, { signal, usage });
      const tickers = symbols.map((s) => s.split(":").pop());
      let futMap = new Map();
      const futSymbols = [];
      if (needs.has("futures")) {
        const idx = await futures();
        for (const t of tickers) {
          const list = idx.get(t);
          if (!list?.length) continue;
          futMap.set(t, { near: list[0], next: list[1] ?? null });
          futSymbols.push(list[0].canonical);
          if (list[1]) futSymbols.push(list[1].canonical);
        }
        if (needs.has("futuresPrevOi") && !cacheOnly) await loadFutPrevOi([...futMap.values()].map((f) => f.near.canonical), { signal, usage });
      }
      const quotes = await readQuotes([...symbols, ...futSymbols], { signal, usage });
      const chainMap = needs.has("chain") ? await chains(tickers) : new Map();
      const mw = needs.has("mwpl") ? mwplMap() : new Map();
      const hist = needs.has("ivHistory") ? loadIv() : new Map();
      const today = istDay(now());
      const raw = new Map();
      for (const s of symbols) {
        const t = s.split(":").pop();
        const q = quotes.get(s);
        const d = daily.get(s);
        const f = futMap.get(t);
        let fut = null;
        if (f) {
          const nq = quotes.get(f.near.canonical);
          const xq = f.next ? quotes.get(f.next.canonical) : null;
          if (nq && Number.isFinite(nq.oi) && !oiBase.has(f.near.canonical)) oiBase.set(f.near.canonical, nq.oi);
          fut = { near: nq ?? null, next: xq ?? null, prevOi: futPrevOi.get(f.near.canonical) ?? oiBase.get(f.near.canonical) ?? null, expiry: f.near.expiry };
        }
        const chain = chainMap.get(t) ?? null;
        raw.set(s, {
          symbol: s,
          daily: d?.bars ? unpack(d.bars) : null,
          dailyFacts: d?.facts ?? null,
          quote: q ? { ...q, atMs: Date.parse(q.freshness?.asOf ?? "") || now() } : null,
          fut,
          chain,
          ivHistory: (hist.get(t) ?? []).filter((x) => x.date < today),
          mwpl: mw.get(t) ?? null,
          meta: { ...symbolMeta(s), fno: Boolean(f) || Boolean(chain) },
        });
      }
      return { raw, usage };
    },
    /** Remember today's ATM IV per symbol (the IV history behind IV rank). */
    noteIvs(pairs) {
      for (const [ticker, iv] of pairs) noteIv(ticker, iv);
      saveIv();
    },
    /** Daily cache size (status). */
    status: () => ({ day, dailyCached: daily.size, ivSymbols: loadIv().size }),
  };
}
