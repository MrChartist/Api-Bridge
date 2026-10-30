/**
 * Live events engine (stream S28). Takes quotes as they arrive (stream ticks first, REST polls as a fallback, the
 * demo simulator in demo mode), runs the selected detectors on in-memory per-symbol and per-strike state (O(1) per
 * tick), and turns hits into event records:
 *
 *   { id, seq, ts, time (IST ISO), date, symbol, segment, name, asset ("stock" | "option"), kind, label, category,
 *     side ("bull" | "bear" | "neutral"), ltp, changePct, strength, context, first, count, lastAt, tags, option? }
 *
 * Repeats of the same kind (and variant) on the same symbol inside the cool-down are not new events: the open record's
 * `count` goes up and `lastAt` / `ltp` move, and an update is emitted. `first` marks the first time that key fired
 * today. New records and updates go to the day store (jsonl) and the bus topic "market.event", which the stream
 * layer forwards to clients that sent subscribe_events. The later alerts engine (P1-11) can listen to the same topic.
 *
 * Chain-level option detectors run off the tick path: a tick marks its chain dirty, and flush() (called by a short
 * timer) evaluates dirty chains at most once per `chainEveryMs`.
 */
import { CATEGORIES, KINDS, KIND_BY_ID, clampParam, defaultSelection, sideOf } from "./catalogue.mjs";
import { createStockState, detectFuture, detectStock, pivots } from "./detectors.mjs";
import { createChainState, detectChain, detectLeg, legOf } from "./optionDetectors.mjs";
import { parseOptionSymbol } from "../dashboard/options.js";
import { DEFAULT_SESSIONS } from "../reference/defaults.mjs";

const IST_OFFSET_MS = 330 * 60_000;
/** The cash session's open in IST minutes, from the reference defaults (special sessions are not modelled here). */
const OPEN_MINUTE = (() => {
  const [hh, mm] = String(DEFAULT_SESSIONS.NSE?.open ?? "").split(":").map(Number);
  return hh * 60 + mm;
})();
const num = (v) => (typeof v === "number" ? (Number.isFinite(v) ? v : null) : v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** IST calendar date (YYYY-MM-DD) of epoch ms. */
export const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
/** IST ISO time with offset, e.g. 2026-10-30T10:42:07+05:30. */
export const istIso = (ms) => `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;
/** Minutes since 09:15 IST on that day (negative before the open). */
export const sessionMinute = (ms) => {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 - OPEN_MINUTE;
};

/** Validate and fill a selection against the catalogue (unknown kinds dropped, params clamped). */
export function normaliseSelection(input) {
  const def = defaultSelection();
  const src = input && typeof input === "object" ? input : {};
  const kinds = {};
  for (const k of KINDS) {
    const want = src.kinds?.[k.kind];
    const params = {};
    for (const spec of k.params) params[spec.key] = clampParam(spec, want?.params?.[spec.key] ?? def.kinds[k.kind].params[spec.key]);
    kinds[k.kind] = { on: want && typeof want.on === "boolean" ? want.on : def.kinds[k.kind].on, params };
  }
  const uni = Array.isArray(src.universes) ? src.universes.map((u) => String(u).toUpperCase()).filter((u) => /^[A-Z0-9_]{2,32}$/.test(u)) : def.universes;
  const watch = Array.isArray(src.watchlist) ? [...new Set(src.watchlist.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z]{2,5}:[A-Z0-9&_.\-]{1,40}$/.test(s)))].slice(0, 500) : def.watchlist;
  const cd = num(src.cooldownSeconds);
  return {
    version: 1,
    kinds,
    universes: [...new Set(uni)].slice(0, 12),
    optionMode: ["indices", "stocks", "both"].includes(src.optionMode) ? src.optionMode : def.optionMode,
    watchlist: watch,
    cooldownSeconds: cd === null ? def.cooldownSeconds : Math.min(3600, Math.max(10, Math.round(cd))),
  };
}

/** The detector view of a selection: a Set of enabled kinds and their params. */
export function compileSelection(sel) {
  const on = new Set();
  const params = {};
  for (const [kind, v] of Object.entries(sel.kinds)) {
    if (v.on) on.add(kind);
    params[kind] = v.params;
  }
  return { on, params };
}

/** Percentiles of a sample (ms). */
export function percentiles(samples) {
  const a = [...samples].sort((x, y) => x - y);
  const at = (p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null);
  return { n: a.length, p50: at(50), p95: at(95), p99: at(99), max: a.length ? a[a.length - 1] : null };
}

/**
 * @param {{ clock: { now(): number }, bus?: object, store?: { append(rec: object): void, appendUpdate(u: object): void },
 *   selection?: object, sessionOf?: (ms: number) => number, maxEvents?: number, chainEveryMs?: number,
 *   logger?: object, now?: () => number }} deps
 */
export function createEventsEngine(deps) {
  const clock = deps.clock;
  const minuteOf = deps.sessionOf ?? sessionMinute;
  const maxEvents = deps.maxEvents ?? 20_000;
  const chainEveryMs = deps.chainEveryMs ?? 1000;
  const perfNow = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

  let selection = normaliseSelection(deps.selection);
  let compiled = compileSelection(selection);
  let day = istDate(clock.now());
  /** symbol -> meta { symbol, name, kind: "EQ"|"INDEX"|"FUT", segment, tags: { fno, index, nifty50, watch, cash }, tick, lot, underlying? } */
  const metas = new Map();
  /** symbol -> stock state */
  const states = new Map();
  /** "UNDERLYING|expiry" -> chain state */
  const chains = new Map();
  /** future symbol -> stock symbol */
  const futOf = new Map();
  /** stock symbol -> chain keys (spot updates) */
  const spotChains = new Map();
  /** stock symbol -> previous-day context */
  const contexts = new Map();
  /** newest last */
  let events = [];
  const byId = new Map();
  /** dedupe key -> open record */
  const openByKey = new Map();
  const firedKeys = new Set();
  let seq = 0;
  const perf = new Float64Array(4096);
  let perfN = 0;
  let ticks = 0;
  let lastTickAt = null;
  const sources = new Map();
  const listeners = new Set();

  function rollDay(ms) {
    const d = istDate(ms);
    if (d === day) return;
    day = d;
    states.clear();
    for (const c of chains.values()) {
      c.legs.clear();
      c.strikes.length = 0;
    }
    chains.clear();
    events = [];
    byId.clear();
    openByKey.clear();
    firedKeys.clear();
  }

  const stateFor = (symbol) => {
    let s = states.get(symbol);
    if (!s) {
      s = createStockState(metas.get(symbol) ?? { symbol }, contexts.get(symbol) ?? {});
      states.set(symbol, s);
    }
    return s;
  };

  function publish(type, rec) {
    deps.bus?.emit?.("market.event", { type, event: rec });
    for (const fn of listeners) {
      try {
        fn(type, rec);
      } catch {
        /* a listener never breaks detection */
      }
    }
  }

  /** Turn one hit into a record (or an update of the open one). */
  function fire(hit, base, ms) {
    const key = `${base.symbol}|${hit.kind}|${hit.variant ?? ""}`;
    const open = openByKey.get(key);
    const cooldown = selection.cooldownSeconds * 1000;
    if (open && ms - open.ts < cooldown) {
      open.count += 1;
      open.lastAt = istIso(ms);
      open.ltp = base.ltp;
      open.changePct = base.changePct;
      open.strength = hit.strength ?? open.strength;
      open.context = hit.text ?? open.context;
      const u = { id: open.id, count: open.count, lastAt: open.lastAt, ltp: open.ltp, changePct: open.changePct, strength: open.strength, context: open.context, update: true };
      deps.store?.appendUpdate?.(u);
      publish("update", { ...open });
      return null;
    }
    const k = KIND_BY_ID.get(hit.kind);
    seq += 1;
    const rec = {
      id: `ev_${day.replace(/-/g, "")}_${seq.toString(36)}`,
      seq,
      ts: ms,
      time: istIso(ms),
      detectedAt: clock.now(),
      date: day,
      symbol: base.symbol,
      segment: base.segment,
      name: base.name ?? null,
      asset: k.asset,
      kind: hit.kind,
      variant: hit.variant ?? "",
      label: k.label,
      category: k.category,
      side: sideOf(hit.kind, hit.dir),
      ltp: base.ltp,
      changePct: base.changePct,
      strength: hit.strength ?? null,
      context: hit.text ?? "",
      first: !firedKeys.has(key),
      count: 1,
      lastAt: istIso(ms),
      tags: base.tags ?? {},
    };
    if (base.option) rec.option = base.option;
    firedKeys.add(key);
    openByKey.set(key, rec);
    events.push(rec);
    byId.set(rec.id, rec);
    if (events.length > maxEvents) {
      const drop = events.splice(0, events.length - maxEvents);
      for (const d of drop) byId.delete(d.id);
    }
    deps.store?.append?.(rec);
    publish("new", rec);
    return rec;
  }

  const metaBase = (sym, ltp, chg) => {
    const m = metas.get(sym) ?? { symbol: sym };
    return { symbol: sym, segment: m.segment ?? sym.split(":")[0], name: m.name ?? null, ltp: ltp === null ? null : Math.round(ltp * 100) / 100, changePct: chg === null ? null : Math.round(chg * 100) / 100, tags: m.tags ?? {} };
  };

  function onStock(sym, q, t) {
    const s = stateFor(sym);
    const hits = detectStock(s, q, compiled, t);
    for (const c of spotChains.get(sym) ?? []) {
      const ch = chains.get(c);
      if (ch && num(q.ltp) !== null) {
        ch.spot = Number(q.ltp);
        ch.dirty = true;
      }
    }
    if (!hits.length) return;
    const base = metaBase(sym, num(q.ltp), s.chg);
    for (const h of hits) fire(h, base, t.ms);
  }

  function onFuture(futSym, q, t) {
    const stock = futOf.get(futSym);
    const m = metas.get(futSym);
    for (const c of m?.chains ?? []) {
      const ch = chains.get(c);
      if (ch && num(q.ltp) !== null) {
        ch.fut = Number(q.ltp);
        ch.dirty = true;
      }
    }
    if (!stock) return;
    const s = stateFor(stock);
    const hits = detectFuture(s, q, compiled, t, m?.lot ?? 1);
    if (!hits.length) return;
    const base = metaBase(stock, s.last, s.chg);
    for (const h of hits) fire(h, base, t.ms);
  }

  function chainFor(underlying, expiry, opts = {}) {
    const key = `${underlying}|${expiry}`;
    let c = chains.get(key);
    if (!c) {
      const spotSymbol = opts.spotSymbol ?? null;
      c = createChainState({ underlying, expiry, lot: opts.lot ?? 1, kind: opts.kind ?? "INDEX", name: opts.name ?? null, spotSymbol });
      chains.set(key, c);
      if (spotSymbol) {
        if (!spotChains.has(spotSymbol)) spotChains.set(spotSymbol, new Set());
        spotChains.get(spotSymbol).add(key);
      }
    }
    if (opts.lot && c.lot === 1) c.lot = opts.lot;
    return c;
  }

  const optionBase = (chain, leg, hit) => {
    const spotMeta = chain.spotSymbol ? metas.get(chain.spotSymbol) : null;
    const symbol = chain.spotSymbol ?? `NSE:${chain.underlying}`;
    const s = chain.spotSymbol ? states.get(chain.spotSymbol) : null;
    const strike = leg?.strike ?? hit.chainStrike ?? null;
    const right = leg?.right ?? hit.right ?? null;
    const l = leg ?? (strike !== null && right ? chain.legs.get(`${strike}|${right}`) : null);
    const lot = chain.lot || 1;
    return {
      symbol,
      segment: (l?.symbol ?? "").split(":")[0] || (chain.kind === "INDEX" && chain.underlying === "SENSEX" ? "BFO" : "NFO"),
      name: spotMeta?.name ?? chain.name ?? null,
      ltp: chain.spot === null ? null : Math.round(chain.spot * 100) / 100,
      changePct: s?.chg === null || s?.chg === undefined ? null : Math.round(s.chg * 100) / 100,
      tags: { ...(spotMeta?.tags ?? {}), fno: true, index: chain.kind === "INDEX" },
      option: {
        underlying: chain.underlying,
        expiry: chain.expiry,
        contract: l?.symbol ?? null,
        strike,
        right,
        premium: l?.ltp ?? null,
        oi: l?.oi ?? null,
        dOiLots: hit.dOi !== undefined ? Math.round(hit.dOi / lot) : l && l.oi !== null && l.oiRef !== null ? Math.round((l.oi - l.oiRef) / lot) : null,
        iv: l?.iv !== null && l?.iv !== undefined ? Math.round(l.iv * 10) / 10 : null,
        lot,
        chain: true,
      },
    };
  };

  function onLeg(sym, q, t, parsed) {
    const m = metas.get(sym);
    const underlying = m?.underlying ?? parsed?.underlying;
    const expiry = m?.expiry ?? parsed?.expiry;
    const strike = num(m?.strike ?? parsed?.strike);
    const right = m?.right ?? parsed?.right;
    if (!underlying || !expiry || strike === null || !right) return;
    const chain = chains.get(`${underlying}|${expiry}`);
    if (!chain) return; // options are tracked only for chains in the options universe
    const leg = legOf(chain, strike, right, sym);
    const hits = detectLeg(chain, leg, q, compiled, t);
    for (const h of hits) {
      const base = optionBase(chain, h.leg, h);
      fire(h, base, t.ms);
    }
  }

  const api = {
    /** Register symbols to track. meta.kind: "EQ" | "INDEX" | "FUT" | "OPT". */
    register(meta) {
      if (!meta?.symbol) return;
      const prev = metas.get(meta.symbol);
      metas.set(meta.symbol, prev ? { ...prev, ...meta, tags: { ...(prev.tags ?? {}), ...(meta.tags ?? {}) } } : meta);
      if (meta.kind === "FUT" && meta.stock) futOf.set(meta.symbol, meta.stock);
      const s = states.get(meta.symbol);
      if (s) s.meta = metas.get(meta.symbol);
    },
    registerChain(underlying, expiry, opts = {}) {
      return chainFor(underlying, expiry, opts);
    },
    unregisterChain(underlying, expiry) {
      chains.delete(`${underlying}|${expiry}`);
    },
    metas: () => metas,
    /** Previous-day context for a stock. */
    setContext(symbol, ctx) {
      contexts.set(symbol, ctx ?? {});
      const s = states.get(symbol);
      if (s) {
        s.ctx = ctx ?? {};
        s.pivots = undefined;
      }
    },
    context: (symbol) => contexts.get(symbol) ?? null,
    hasContext: (symbol) => contexts.has(symbol),

    /**
     * One quote (a stream tick or a REST quote). Returns nothing; events go out through the bus and listeners.
     * @param {object} q { symbol, ltp, ... } canonical symbol
     * @param {number} [atMs] the time the quote describes (default: now)
     */
    ingest(q, atMs) {
      const t0 = perfNow();
      const sym = q?.symbol;
      if (!sym) return;
      const ms = num(atMs) ?? clock.now();
      if (istDate(ms) !== day) rollDay(ms);
      const t = { ms, minute: minuteOf(ms) };
      const m = metas.get(sym);
      ticks += 1;
      lastTickAt = ms;
      if (q.source) sources.set(q.source, (sources.get(q.source) ?? 0) + 1);
      if (m?.kind === "FUT") onFuture(sym, q, t);
      else if (m?.kind === "OPT") onLeg(sym, q, t, null);
      else if (m) onStock(sym, q, t);
      else {
        const parsed = parseOptionSymbol(sym);
        if (parsed) onLeg(sym, q, t, parsed);
      }
      perf[perfN % perf.length] = perfNow() - t0;
      perfN += 1;
    },

    /**
     * A whole chain at once (a recorder snapshot or a REST chain): every leg goes through the leg detectors.
     * @param {{ underlying: string, expiry: string, spot?: number, fut?: number, lot?: number, rows: Array<{ strike: number, ce?: object, pe?: object }> }} c
     */
    ingestChain(c, atMs) {
      const ms = num(atMs) ?? clock.now();
      if (istDate(ms) !== day) rollDay(ms);
      const chain = chains.get(`${c.underlying}|${c.expiry}`);
      if (!chain) return;
      if (num(c.spot) !== null) chain.spot = Number(c.spot);
      if (num(c.fut) !== null) chain.fut = Number(c.fut);
      if (num(c.lot) !== null && chain.lot === 1) chain.lot = Number(c.lot);
      const t = { ms, minute: minuteOf(ms) };
      for (const r of c.rows ?? []) {
        for (const [side, right] of [["ce", "CE"], ["pe", "PE"]]) {
          const q = r[side];
          if (!q) continue;
          const t0 = perfNow();
          const leg = legOf(chain, Number(r.strike), right, q.symbol ?? null);
          const hits = detectLeg(chain, leg, q, compiled, t);
          for (const h of hits) fire(h, optionBase(chain, h.leg, h), ms);
          perf[perfN % perf.length] = perfNow() - t0;
          perfN += 1;
          ticks += 1;
        }
      }
      chain.dirty = true;
    },

    /** Evaluate dirty chains (chain-level detectors). Called by a short timer. */
    flush(atMs) {
      const ms = num(atMs) ?? clock.now();
      const t = { ms, minute: minuteOf(ms) };
      for (const chain of chains.values()) {
        if (!chain.dirty) continue;
        const hits = detectChain(chain, compiled, t, { everyMs: chainEveryMs });
        for (const h of hits) fire(h, optionBase(chain, null, h), ms);
      }
    },

    // ── selection ──
    selection: () => selection,
    setSelection(input) {
      selection = normaliseSelection(input);
      compiled = compileSelection(selection);
      return selection;
    },

    // ── reads ──
    /** Restore today's records from the store after a restart (no events are emitted). */
    restore(records) {
      for (const r of records ?? []) {
        if (!r || typeof r !== "object") continue;
        if (r.update) {
          const o = byId.get(r.id);
          if (o) Object.assign(o, { count: r.count, lastAt: r.lastAt, ltp: r.ltp, changePct: r.changePct, strength: r.strength, context: r.context });
          continue;
        }
        if (!r.id || r.date !== day || byId.has(r.id)) continue;
        events.push(r);
        byId.set(r.id, r);
        seq = Math.max(seq, Number(r.seq) || 0);
        const key = `${r.symbol}|${r.kind}|${r.variant ?? ""}`;
        firedKeys.add(key);
        openByKey.set(key, r);
      }
    },
    /**
     * Records, newest first, after the filters. `since` returns only records with seq > since (and updates are seen
     * through `count`).
     */
    list({ since = 0, kinds = null, sides = null, asset = null, symbol = null, q = null, minPrice = null, limit = 500, firstOnly = false } = {}) {
      const out = [];
      const kindSet = kinds?.length ? new Set(kinds) : null;
      const sideSet = sides?.length ? new Set(sides) : null;
      const needle = q ? String(q).toUpperCase() : null;
      for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const r = events[i];
        if (r.seq <= since) break;
        if (kindSet && !kindSet.has(r.kind)) continue;
        if (sideSet && !sideSet.has(r.side)) continue;
        if (asset && r.asset !== asset) continue;
        if (symbol && r.symbol !== symbol) continue;
        if (firstOnly && !r.first) continue;
        if (minPrice !== null && (r.asset === "stock" ? r.ltp : r.option?.premium ?? r.ltp) < minPrice) continue;
        if (needle && !`${r.symbol} ${r.name ?? ""} ${r.label}`.toUpperCase().includes(needle)) continue;
        out.push(r);
      }
      return out;
    },
    get: (id) => byId.get(id) ?? null,
    /** Counts by kind and side today, and the bull/bear balance. */
    summary({ asset = null } = {}) {
      const byKind = {};
      const bySide = { bull: 0, bear: 0, neutral: 0 };
      const symbols = new Set();
      for (const r of events) {
        if (asset && r.asset !== asset) continue;
        byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
        bySide[r.side] = (bySide[r.side] ?? 0) + 1;
        symbols.add(r.symbol);
      }
      const dir = bySide.bull + bySide.bear;
      return { date: day, total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, bySide, balance: dir ? Math.round(((bySide.bull - bySide.bear) / dir) * 100) / 100 : null, symbols: symbols.size, lastSeq: seq };
    },
    /** One symbol: its events today and its levels (prev H/L, pivots, VWAP, bands, day range). */
    symbolView(symbol) {
      const s = states.get(symbol);
      const ctx = contexts.get(symbol) ?? s?.ctx ?? {};
      const m = metas.get(symbol) ?? null;
      const prev = num(ctx.prevClose);
      const bands = prev
        ? [2, 5, 10, 20].map((b) => ({ pct: b, upper: Math.round(prev * (1 + b / 100) * 20) / 20, lower: Math.round(prev * (1 - b / 100) * 20) / 20 }))
        : [];
      const chainList = [...chains.values()].filter((c) => c.spotSymbol === symbol || `NSE:${c.underlying}` === symbol).map((c) => ({ underlying: c.underlying, expiry: c.expiry, lot: c.lot, atm: c.summary?.atm ?? null, pcr: c.summary?.pcr ?? null, maxPain: c.summary?.maxPain ?? null, callWall: c.summary?.resistance?.strike ?? null, putWall: c.summary?.support?.strike ?? null, straddle: c.summary?.straddle ?? null, atmIv: c.summary?.atmIv ?? null }));
      return {
        symbol,
        name: m?.name ?? null,
        tags: m?.tags ?? {},
        ltp: s?.last ?? null,
        changePct: s?.chg === null || s?.chg === undefined ? null : Math.round(s.chg * 100) / 100,
        levels: {
          dayHigh: s?.hi ?? null,
          dayLow: s?.lo ?? null,
          prevClose: prev,
          prevHigh: num(ctx.prevHigh),
          prevLow: num(ctx.prevLow),
          high52: num(ctx.high52),
          low52: num(ctx.low52),
          vwap: s?.vwap === null || s?.vwap === undefined ? null : Math.round(s.vwap * 100) / 100,
          pivots: pivots(ctx),
          bands,
          lock: s?.lock ?? null,
          lockBand: s?.lockBand ?? null,
        },
        chains: chainList,
        events: events.filter((r) => r.symbol === symbol).reverse(),
      };
    },
    /** The chain row of one strike (side sheet for option events). */
    chainRow(underlying, expiry, strike) {
      const c = chains.get(`${underlying}|${expiry}`);
      if (!c) return null;
      const leg = (right) => {
        const l = c.legs.get(`${strike}|${right}`);
        return l ? { symbol: l.symbol, ltp: l.ltp, oi: l.oi, oiChange: l.oi !== null && l.oiRef !== null ? l.oi - l.oiRef : null, volume: l.vol, iv: l.iv, cls: l.cls } : null;
      };
      return { underlying, expiry, strike, lot: c.lot, spot: c.spot, fut: c.fut, ce: leg("CE"), pe: leg("PE"), summary: c.summary ? { atm: c.summary.atm, pcr: c.summary.pcr, maxPain: c.summary.maxPain, callWall: c.summary.resistance?.strike ?? null, putWall: c.summary.support?.strike ?? null, straddle: c.summary.straddle, atmIv: c.summary.atmIv } : null };
    },
    /** Live tracking and speed numbers. */
    stats() {
      const n = Math.min(perfN, perf.length);
      const p = percentiles(perf.subarray(0, n));
      return {
        date: day,
        symbols: metas.size,
        stocksTracked: states.size,
        chains: chains.size,
        ticks,
        lastTickAt: lastTickAt === null ? null : istIso(lastTickAt),
        events: events.length,
        sources: Object.fromEntries(sources),
        perTickMs: { n: p.n, p50: p.p50, p95: p.p95, p99: p.p99, max: p.max },
      };
    },
    categories: () => CATEGORIES,
    /** Listen to new records and updates in-process (tests, the stream fan-out). Returns an unsubscribe function. */
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    day: () => day,
  };
  return api;
}
