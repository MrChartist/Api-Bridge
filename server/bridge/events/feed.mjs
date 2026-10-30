/**
 * Live inputs for the events engine (stream S28), outside demo mode. Speed first, budget always:
 *
 *  1. Stream (preferred). The universe is held on the shared stream hub as internal clients "events:0", "events:1" …
 *     in "quote" mode (recorder/streamSource.mjs, the same reference-counted subscriptions the recorder and pages use,
 *     so a symbol someone already streams costs nothing). Every bus "tick" for a tracked symbol goes straight into
 *     engine.ingest, so detection runs as the tick arrives.
 *  2. Recorder chains. Option chains come from the recorder (P1-1): each "recorder.snapshot" is read back from the
 *     recorder's memory (recorder.latest, no broker call) into engine.ingestChain, and option-leg ticks the recorder
 *     streams reach the leg detectors through the same bus "tick". The events engine never reads chains itself.
 *  3. REST fallback. Symbols the hub refused (feed caps) or that have had no tick for `staleAfterMs` are polled with
 *     marketData.quotes in batches at background priority, only when the shared background gate
 *     (ratelimit/backgroundGate.mjs) says the call keeps every window at or above (1 − share) of its limit, and with
 *     `backgroundShare`, so the scheduler re-checks the floor when it takes the budget. A refused poll waits for the
 *     next round; nothing is retried in a loop.
 *  4. Previous-day context (prev close/high/low/volume, 20-day average volume, 52-week range) from daily candles,
 *     once a day per symbol, one at a time at background priority through the same gate, cached on disk for the day.
 */
import { isStub } from "../core/contracts.mjs";
import { MAX_BACKGROUND_SHARE, createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { runAsConsumer } from "../ratelimit/consumer.mjs";
import { createStreamSource } from "../recorder/streamSource.mjs";
import { INDICES, NIFTY50 } from "../scanner/universes.mjs";
import { istDate } from "./engine.mjs";

const INDEX_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"]);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Previous-day context from daily candles (oldest first; the last candle may be today's, which is dropped). */
export function contextFromCandles(candles, today) {
  const rows = (candles ?? []).filter((c) => c && Number.isFinite(Number(c.close)));
  const dayOf = (c) => (typeof c.time === "number" ? istDate(c.time < 1e12 ? c.time * 1000 : c.time) : String(c.time ?? c.date ?? "").slice(0, 10));
  const past = rows.filter((c) => dayOf(c) < today);
  if (!past.length) return null;
  const last = past[past.length - 1];
  const vols = past.slice(-20).map((c) => num(c.volume)).filter((v) => v !== null && v > 0);
  const year = past.slice(-252);
  return {
    prevClose: num(last.close),
    prevHigh: num(last.high),
    prevLow: num(last.low),
    prevVolume: num(last.volume),
    prevDate: dayOf(last),
    avgVolume: vols.length >= 5 ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
    high52: year.length >= 20 ? Math.max(...year.map((c) => num(c.high) ?? -Infinity)) : null,
    low52: year.length >= 20 ? Math.min(...year.map((c) => num(c.low) ?? Infinity)) : null,
    // "All-time" over the history fetched; historyFrom says from when, so a short history is labelled honestly.
    allTimeHigh: past.length >= 20 ? past.reduce((m, c) => Math.max(m, num(c.high) ?? -Infinity), -Infinity) : null,
    allTimeLow: past.length >= 20 ? past.reduce((m, c) => Math.min(m, num(c.low) ?? Infinity), Infinity) : null,
    historyFrom: dayOf(past[0]),
    historyDays: past.length,
  };
}

/**
 * @param {{ engine: object, deps: object, cfg: object, store: object, logger?: object }} o
 */
export function createLiveFeed({ engine, deps, cfg, store, logger }) {
  const hub = deps.streamHub && !isStub(deps.streamHub) ? deps.streamHub : null;
  const gate = deps.scheduler && !isStub(deps.scheduler) ? createBackgroundGate({ scheduler: deps.scheduler }) : null;
  const share = Math.min(cfg.budgetShare, MAX_BACKGROUND_SHARE);
  const source = hub ? createStreamSource({ hub, prefix: "events", maxPerClient: 500, maxPerRequest: 200, logger }) : null;
  const now = () => deps.clock.now();
  /** symbol -> last tick ms */
  const lastSeen = new Map();
  const tracked = new Set();
  const offs = [];
  const timers = [];
  let stopped = false;
  let polling = false;
  let contextRun = null;
  const status = { stream: { held: 0, rejected: 0 }, rest: { polls: 0, symbols: 0, refused: 0, lastAt: null }, context: { loaded: 0, missing: 0, pending: 0 }, chains: { snapshots: 0 }, universe: { stocks: 0, futures: 0, chains: 0 } };

  // ── universe ──

  async function futuresIndex() {
    /** underlying -> { canonical, expiry, lotSize } (front month) */
    const front = new Map();
    if (!deps.symbols || isStub(deps.symbols)) return front;
    let cursor;
    for (let page = 0; page < 60; page += 1) {
      let res;
      try {
        res = await deps.symbols.search({ q: "FUT", kind: "FUT", exchange: "NFO", limit: 500, ...(cursor ? { cursor } : {}) });
      } catch {
        break;
      }
      for (const r of res?.items ?? []) {
        if (!r?.underlying || !r.expiry) continue;
        const cur = front.get(r.underlying);
        if (!cur || r.expiry < cur.expiry) front.set(r.underlying, { canonical: r.canonical, expiry: r.expiry, lotSize: r.lotSize ?? 1, name: r.name ?? null });
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return front;
  }

  async function resolveUniverse() {
    const sel = engine.selection();
    const want = new Set(sel.universes);
    const front = await futuresIndex();
    const fnoStocks = [...front.keys()].filter((u) => !INDEX_UNDERLYINGS.has(u)).map((u) => `NSE:${u}`);
    const nifty = new Set(NIFTY50);
    const watch = new Set(sel.watchlist);
    const out = new Map();
    const add = (sym, tags) => out.set(sym, { ...(out.get(sym) ?? {}), ...tags });
    if (want.has("FNO")) for (const s of fnoStocks) add(s, { fno: true });
    if (want.has("NIFTY50")) for (const s of NIFTY50) add(s, { nifty50: true });
    if (want.has("INDICES")) for (const s of INDICES) add(s, { index: true });
    if (want.has("WATCHLIST")) for (const s of watch) add(s, { watch: true });
    const custom = deps.config?.scanner?.universes ?? {};
    for (const u of want) if (Object.hasOwn(custom, u)) for (const s of custom[u]) add(s, { group: u });
    if (want.has("CASH") && Array.isArray(cfg.cashList)) for (const s of cfg.cashList) add(s, { cash: true });
    const list = [...out.entries()].slice(0, cfg.maxSymbols);
    const fnoSet = new Set(fnoStocks);
    for (const [sym, tags] of list) {
      const tk = sym.split(":")[1];
      engine.register({ symbol: sym, kind: tags.index ? "INDEX" : "EQ", segment: sym.split(":")[0], tags: { ...tags, fno: fnoSet.has(sym) || Boolean(tags.fno), nifty50: nifty.has(sym), watch: watch.has(sym) }, name: front.get(tk)?.name ?? null });
    }
    // Front futures of the F&O stocks in the universe (OI build-up and surges).
    const futs = [];
    if (cfg.futures) {
      for (const [sym] of list) {
        const f = front.get(sym.split(":")[1]);
        if (!f || !fnoSet.has(sym)) continue;
        engine.register({ symbol: f.canonical, kind: "FUT", stock: sym, lot: f.lotSize, segment: "NFO", tags: { fno: true } });
        futs.push(f.canonical);
      }
    }
    status.universe = { stocks: list.length, futures: futs.length, chains: status.universe.chains };
    return [...list.map(([s]) => s), ...futs];
  }

  async function holdUniverse() {
    const symbols = await resolveUniverse();
    tracked.clear();
    for (const s of symbols) tracked.add(s);
    if (source) {
      const r = await source.setDesired(symbols);
      status.stream = { held: source.held().size, rejected: r.rejected.length };
    }
    loadContexts([...tracked].filter((s) => engine.metas().get(s)?.kind !== "FUT"));
  }

  // ── stream ──
  if (deps.bus?.on) {
    offs.push(
      deps.bus.on("tick", (t) => {
        if (!t?.symbol) return;
        if (!tracked.has(t.symbol) && !/^(NFO|BFO):/.test(t.symbol)) return;
        lastSeen.set(t.symbol, t.receivedAt ?? now());
        engine.ingest({ ...t, source: "stream" }, t.exchangeTs ?? t.receivedAt ?? now());
      }),
    );
    // ── recorder chains ──
    offs.push(
      deps.bus.on("recorder.snapshot", (p) => {
        if (!p?.underlying || !p.expiry || !deps.recorder?.latest) return;
        const sel = engine.selection();
        const isIndex = INDEX_UNDERLYINGS.has(p.underlying);
        if ((sel.optionMode === "indices" && !isIndex) || (sel.optionMode === "stocks" && isIndex)) return;
        Promise.resolve(deps.recorder.latest({ underlying: p.underlying, expiry: p.expiry }))
          .then((snap) => {
            if (!snap || stopped) return;
            status.chains.snapshots += 1;
            const spotSymbol = isIndex ? (p.underlying === "SENSEX" || p.underlying === "BANKEX" ? `BSE:${p.underlying}` : `NSE:${p.underlying}`) : `NSE:${p.underlying}`;
            engine.registerChain(p.underlying, p.expiry, { lot: snap.lotSize ?? snap.lot ?? 1, kind: isIndex ? "INDEX" : "EQ", spotSymbol });
            const rows = (snap.k ?? []).map((k, i) => {
              const leg = (side) => {
                const s = snap[side] ?? {};
                const ltp = s.ltp?.[i] ?? null;
                if (ltp === null) return null;
                return { ltp, oi: s.oi?.[i] ?? null, volume: s.vol?.[i] ?? null, iv: s.iv?.[i] ?? null };
              };
              return { strike: k, ce: leg("ce"), pe: leg("pe") };
            });
            engine.ingestChain({ underlying: p.underlying, expiry: p.expiry, spot: snap.spot ?? null, fut: snap.fut ?? null, rows }, Date.parse(p.ts) || now());
            status.universe.chains = engine.stats().chains;
          })
          .catch((err) => logger?.debug?.("events: recorder read failed", { err: err?.message }));
      }),
    );
  }

  // ── REST fallback ──
  function dataAccount() {
    try {
      return deps.accounts?.marketDataCandidates?.({ capability: "quotes" })?.[0] ?? null;
    } catch {
      return null;
    }
  }
  function batchSize(accountId) {
    try {
      const broker = deps.accounts.get(accountId).broker;
      return Math.max(1, Number(deps.scheduler.policyFor(broker)?.maxQuoteBatch) || 50);
    } catch {
      return 50;
    }
  }

  async function poll() {
    if (polling || stopped || !deps.marketData || isStub(deps.marketData)) return;
    polling = true;
    try {
      const t = now();
      const stale = [...tracked].filter((s) => {
        const at = lastSeen.get(s);
        return at === undefined || t - at > cfg.staleAfterMs;
      });
      if (!stale.length) return;
      const acc = dataAccount();
      if (!acc) return;
      const size = Math.min(200, batchSize(acc));
      for (let i = 0; i < stale.length && !stopped; i += size) {
        const part = stale.slice(i, i + size);
        if (gate && !gate.allow(acc, "quote", { share, cost: 1 })) {
          status.rest.refused += 1;
          break; // over the background share: wait for the next round, users first
        }
        let res;
        try {
          res = await runAsConsumer("Live events", () => deps.marketData.quotes(part, { priority: "background", backgroundShare: share, maxWaitMs: 1500, maxAgeMs: cfg.staleAfterMs }));
        } catch (err) {
          logger?.debug?.("events: quotes poll failed", { err: err?.code ?? err?.message });
          break;
        }
        status.rest.polls += 1;
        status.rest.symbols += res?.items?.length ?? 0;
        for (const q of res?.items ?? []) {
          const at = Date.parse(q.freshness?.asOf ?? "") || now();
          if (q.freshness?.source === "stream") continue; // the tick already went through the bus
          engine.ingest({ ...q, source: "rest" }, at);
        }
      }
      status.rest.lastAt = new Date(now()).toISOString();
    } finally {
      polling = false;
    }
  }

  // ── previous-day context ──
  function loadContexts(symbols) {
    const today = istDate(now());
    const cached = store.loadContext(today) ?? {};
    for (const [s, c] of Object.entries(cached)) engine.setContext(s, c);
    const todo = symbols.filter((s) => !Object.hasOwn(cached, s));
    status.context = { loaded: Object.keys(cached).length, missing: 0, pending: todo.length };
    if (!todo.length || contextRun || !deps.marketData || isStub(deps.marketData)) return;
    contextRun = (async () => {
      const acc = dataAccount();
      for (const s of todo) {
        if (stopped) break;
        if (gate && acc) {
          for (let tries = 0; tries < 30 && !stopped && !gate.allow(acc, "history", { share, cost: 1 }); tries += 1) await sleep(Math.min(5000, gate.waitMs(acc, "history", { share }) || 1000));
        }
        try {
          const h = await runAsConsumer("Live events", () => deps.marketData.history({ symbol: s, interval: "1d", countback: 5000 }, { priority: "background", backgroundShare: share, maxWaitMs: 5000 }));
          const ctx = contextFromCandles(h?.candles, today);
          if (ctx) {
            cached[s] = ctx;
            engine.setContext(s, ctx);
            status.context.loaded += 1;
          } else status.context.missing += 1;
        } catch {
          status.context.missing += 1;
        }
        status.context.pending -= 1;
        if (status.context.loaded % 25 === 0) store.saveContext(today, cached);
      }
      store.saveContext(today, cached);
      contextRun = null;
    })();
  }

  const sleep = (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });

  return {
    async start() {
      try {
        await holdUniverse();
      } catch (err) {
        logger?.warn?.("events: could not build the universe", { err: err?.message });
      }
      const pollT = setInterval(() => poll().catch(() => {}), cfg.pollSeconds * 1000);
      pollT.unref?.();
      const uniT = setInterval(() => holdUniverse().catch(() => {}), 10 * 60_000);
      uniT.unref?.();
      timers.push(pollT, uniT);
    },
    stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      for (const off of offs) off();
      source?.clear();
    },
    /** Re-resolve after a selection change. */
    refresh: () => holdUniverse(),
    poll,
    status: () => ({ ...status, tracked: tracked.size }),
  };
}
