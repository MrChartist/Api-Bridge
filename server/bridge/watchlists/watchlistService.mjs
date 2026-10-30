/**
 * User watchlists: named lists of symbols in the Bridge home (<dataDir>/watchlists/lists.json, atomic writes), and
 * one read that prices a list for the dashboard: last price, % change, OI and its change today for F&O, and ATM IV.
 *
 * IV is one measure for every row: the front expiry's ATM IV (the mean of the ATM call and put IV), as the Option Chain
 * and Volatility show it, from that expiry's chain (a few strikes, background priority, kept 30 s; at most
 * CHAIN_READS_PER_CALL chains are read per call, the oldest first). IV rank and HV20 come from the stock scanner's
 * facts for stocks (scanner/facts.mjs; demoFacts in demo) and the vol service's memory summary for indices.
 *
 * OI change is the near future's OI against the previous day's OI: stocks from the scanner's facts; indices from the
 * quote's `oiPrev` when it carries one, else the recorder's daily row for the previous recorded day (its near
 * future's last OI, same expiry). Without either it is left blank, never measured from an intraday base.
 *
 * A list may be marked `events` (it feeds Live events' WATCHLIST universe; the dashboard writes the events selection)
 * and `home` (shown on the Home cockpit). Reads and writes only lists: it places nothing.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../core/errors.mjs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { isStub } from "../core/contracts.mjs";
import { chainSummary } from "../dashboard/options.js";
import { frontExpiry, normaliseSymbol, nearFuture, oiChange, prevFutureOi, watchRow } from "../dashboard/watchlist-core.js";
import { scannerFor } from "../scanner/module.mjs";

export const MAX_LISTS = 20;
export const MAX_SYMBOLS = 100;
const NAME_MAX = 40;
const DEMO_LISTS = Object.freeze([
  { name: "Index and F&O", symbols: ["NSE:NIFTY", "NSE:BANKNIFTY", "BSE:SENSEX", "NSE:RELIANCE", "NSE:HDFCBANK", "NSE:INFY", "NSE:TCS", "NSE:ICICIBANK"], events: true, home: true },
  { name: "Banks", symbols: ["NSE:HDFCBANK", "NSE:ICICIBANK", "NSE:SBIN", "NSE:AXISBANK", "NSE:KOTAKBANK"], events: false, home: false },
]);

const istDay = (ms) => new Date(ms + 19_800_000).toISOString().slice(0, 10);
/** How long a front-expiry ATM IV is reused, and how many chains one quotes call may read. */
export const IV_TTL_MS = 30_000;
export const CHAIN_READS_PER_CALL = 8;
const PREV_OI_RETRY_MS = 5 * 60_000;
/** The ATM IV exactly as the Option Chain reads it (dashboard/options.js chainSummary). */
const atmIvOf = (chain) => (chain?.rows?.length ? chainSummary(chain).atmIv : null);

/** @param {object} deps core deps plus marketData and (optional) vol */
export function createWatchlistService(deps, { factsFor = null } = {}) {
  const dir = join(deps.paths.dataDir, "watchlists");
  const file = join(dir, "lists.json");
  const now = () => deps.clock?.now?.() ?? Date.now();
  let state = null;
  /** underlying -> { day, symbol|null, front|null }: the near future and the front expiry, found once a day. */
  const futures = new Map();
  /** underlying -> { at, expiry, iv }: the front expiry's ATM IV, reused for IV_TTL_MS. */
  const ivs = new Map();
  /** underlying -> { day, expiry, prev: { date, oi }|null, at }: the near future's previous-day OI from the recorder. */
  const prevOis = new Map();
  const recorder = () => (deps.recorder && !isStub(deps.recorder) && typeof deps.recorder.daily === "function" ? deps.recorder : null);

  /** Refresh the front-expiry ATM IV of the oldest few underlyings (background chain reads). */
  async function refreshIvs(unders, t) {
    if (typeof deps.marketData?.optionChain !== "function") return;
    const due = unders
      .map((u) => ({ u, front: futures.get(u)?.front ?? null, cur: ivs.get(u) }))
      .filter((x) => x.front && (!x.cur || x.cur.expiry !== x.front || t - x.cur.at >= IV_TTL_MS))
      .sort((a, b) => (a.cur?.at ?? 0) - (b.cur?.at ?? 0))
      .slice(0, CHAIN_READS_PER_CALL);
    await Promise.all(
      due.map(async ({ u, front, cur }) => {
        try {
          const c = await deps.marketData.optionChain({ underlying: u, expiry: front, strikes: 3, greeks: true, ivModel: "b76-forward" }, { priority: "background", maxAgeMs: IV_TTL_MS });
          ivs.set(u, { at: t, expiry: front, iv: atmIvOf(c) });
        } catch {
          // No chain now: keep the last IV of the same expiry, else none (never a different measure).
          ivs.set(u, { at: t, expiry: front, iv: cur?.expiry === front ? cur.iv : null });
        }
      }),
    );
  }

  /** The previous recorded day's OI of an index's near future (recorder daily rows), once a day per expiry. */
  async function prevOiOf(u, futSym, day) {
    const rec = recorder();
    const expiry = /-(\d{4}-\d{2}-\d{2})-FUT$/.exec(String(futSym ?? ""))?.[1] ?? null;
    if (!rec || !expiry) return null;
    const c = prevOis.get(u);
    // A found OI holds for the day; "none yet" is asked again after a few minutes (the recorder may still be filling).
    if (c?.day === day && c.expiry === expiry && (c.prev || now() - c.at < PREV_OI_RETRY_MS)) return c.prev;
    let prev = null;
    try {
      const from = istDay(Date.parse(`${day}T00:00:00Z`) - 10 * 86_400_000);
      prev = prevFutureOi(await rec.daily({ underlying: u, from, to: day }), expiry, day);
    } catch {
      prev = null;
    }
    prevOis.set(u, { day, expiry, prev, at: now() });
    return prev;
  }

  function load() {
    if (state) return state;
    state = { v: 1, seq: 0, lists: [] };
    try {
      if (existsSync(file)) {
        const o = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(o?.lists)) state = { v: 1, seq: Number(o.seq) || o.lists.length, lists: o.lists };
      }
    } catch {
      // A broken file starts empty; it is replaced on the next save.
    }
    if (!state.lists.length && deps.config?.demo) {
      for (const l of DEMO_LISTS) state.lists.push({ id: `w${++state.seq}`, ...l, symbols: [...l.symbols], createdAt: new Date(now()).toISOString() });
    }
    return state;
  }
  function persist() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(state));
  }
  function find(id) {
    const l = load().lists.find((x) => x.id === id);
    if (!l) throw new BridgeError("NOT_FOUND", `No watchlist ${id}.`);
    return l;
  }
  function clean(body, cur = null) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", "Send the watchlist as a JSON object.");
    const extra = Object.keys(body).filter((k) => !["name", "symbols", "events", "home"].includes(k));
    if (extra.length) throw new BridgeError("VALIDATION_FAILED", `Unknown field ${extra[0]}: send name, symbols, events or home.`);
    const name = body.name === undefined ? cur?.name : String(body.name).trim();
    if (!name || name.length > NAME_MAX) throw new BridgeError("VALIDATION_FAILED", `Give the list a name of 1 to ${NAME_MAX} characters.`);
    let symbols = cur?.symbols ?? [];
    if (body.symbols !== undefined) {
      if (!Array.isArray(body.symbols)) throw new BridgeError("VALIDATION_FAILED", "symbols must be a list such as [\"NSE:RELIANCE\"].");
      const bad = [];
      symbols = [];
      for (const s of body.symbols) {
        const n = normaliseSymbol(s);
        if (!n) bad.push(String(s));
        else if (!symbols.includes(n)) symbols.push(n);
      }
      if (bad.length) throw new BridgeError("VALIDATION_FAILED", `Not a symbol: ${bad.slice(0, 3).join(", ")}. Use EXCHANGE:NAME, for example NSE:RELIANCE.`);
      if (symbols.length > MAX_SYMBOLS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_SYMBOLS} symbols in a list.`);
    }
    // Another list with the same name (any case) is refused: lists are picked by name.
    const key = name.toLowerCase();
    if (load().lists.some((o) => o !== cur && String(o.name).toLowerCase() === key)) throw new BridgeError("VALIDATION_FAILED", `A watchlist named ${name} already exists. Choose another name.`, { errors: [{ path: "name", message: `A watchlist named ${name} already exists.` }] });
    return { name, symbols, events: body.events === undefined ? Boolean(cur?.events) : Boolean(body.events), home: body.home === undefined ? Boolean(cur?.home) : Boolean(body.home) };
  }
  /**
   * Symbols new to the list must be in a loaded instrument master (deps.symbols.resolve). When no master is loaded
   * yet (no broker connected), nothing can be checked and the symbols are kept; a symbol already in the list is never
   * re-checked, so an old list stays editable.
   */
  async function checkKnown(symbols, cur) {
    const sym = deps.symbols;
    if (!sym || isStub(sym) || typeof sym.resolve !== "function") return;
    const fresh = symbols.filter((x) => !(cur?.symbols ?? []).includes(x));
    const unknown = [];
    for (const x of fresh) {
      try {
        await sym.resolve(x);
      } catch (err) {
        const why = String(err?.detail ?? err?.message ?? "");
        if (/no broker instrument master is loaded/i.test(why)) return;
        if (err?.code === "SYMBOL_NOT_FOUND" && !/lot size and tick size/i.test(why)) unknown.push(x);
      }
    }
    if (unknown.length) {
      const list = unknown.slice(0, 3).join(", ");
      throw new BridgeError("VALIDATION_FAILED", `Not in the instrument master: ${list}. Check the spelling, for example NSE:RELIANCE or NIFTY.`, { errors: [{ path: "symbols", message: `Not in the instrument master: ${list}.` }] });
    }
  }
  /** One list may drive Live events and one may show on Home: setting the flag clears it elsewhere. */
  function exclusive(l, v) {
    for (const k of ["events", "home"]) if (v[k]) for (const o of load().lists) if (o !== l) o[k] = false;
  }

  return {
    list: () => load().lists.map((l) => ({ ...l, symbols: [...l.symbols] })),
    get: (id) => ({ ...find(id) }),
    async create(body) {
      const s = load();
      if (s.lists.length >= MAX_LISTS) throw new BridgeError("VALIDATION_FAILED", `At most ${MAX_LISTS} watchlists.`);
      const v = clean(body);
      await checkKnown(v.symbols, null);
      const l = { id: `w${++s.seq}`, ...v, createdAt: new Date(now()).toISOString() };
      exclusive(l, v);
      s.lists.push(l);
      persist();
      return { ...l };
    },
    async update(id, body) {
      const l = find(id);
      const v = clean(body, l);
      await checkKnown(v.symbols, l);
      exclusive(l, v);
      Object.assign(l, v, { updatedAt: new Date(now()).toISOString() });
      persist();
      return { ...l };
    },
    remove(id) {
      const l = find(id);
      state.lists = state.lists.filter((x) => x !== l);
      persist();
      return { id, deleted: true };
    },

    /** Price a list: { id, name, rows: [{ symbol, ltp, change, changePct, future, oi, oiChange, oiChangePct, iv, ivr, hv20 }], errors }. */
    async quotes(id) {
      const l = find(id);
      const t = now();
      const day = istDay(t);
      const errors = [];
      // The near future of each F&O underlying, once a day.
      for (const s of l.symbols) {
        const u = s.split(":")[1];
        const f = futures.get(u);
        if (f?.day === day) continue;
        let sym = null;
        let front = null;
        try {
          const ex = await deps.marketData.expiries(u, { priority: "background" });
          sym = nearFuture(s, ex?.expiries ?? [], day);
          front = frontExpiry(ex?.expiries ?? [], day);
        } catch {
          sym = null;
        }
        futures.set(u, { day, symbol: sym, front });
      }
      const futOf = (s) => futures.get(s.split(":")[1])?.symbol ?? null;
      const want = [...new Set([...l.symbols, ...l.symbols.map(futOf).filter(Boolean)])];
      const q = new Map();
      if (want.length) {
        try {
          const r = await deps.marketData.quotes(want, { priority: "interactive" });
          for (const it of r?.items ?? []) q.set(it.symbol, it);
          for (const e of r?.errors ?? []) errors.push({ symbol: e.symbol, message: e.message });
        } catch (err) {
          errors.push({ symbol: null, message: err?.message ?? "Quotes are unavailable." });
        }
      }
      // Stocks: the scanner's facts (previous-day OI base, IV and IV rank).
      let facts = {};
      const scanner = scannerFor(deps);
      const source = factsFor ?? (scanner && typeof scanner.factsFor === "function" ? (syms) => scanner.factsFor(syms) : null);
      const stocks = l.symbols.filter((s) => !watchRow(s, null).index);
      if (source && stocks.length) {
        try {
          facts = (await source(stocks)) ?? {};
        } catch (err) {
          errors.push({ symbol: null, message: `Stock facts unavailable: ${err?.message ?? "error"}` });
        }
      }
      const vol = new Map();
      const unders = [...new Set(l.symbols.map((s) => s.split(":")[1]))].slice(0, 20);
      await refreshIvs([...new Set(l.symbols.map((s) => s.split(":")[1]))], t);
      if (deps.vol && typeof deps.vol.summary === "function" && unders.length) {
        for (const u of unders) {
          try {
            const r = await deps.vol.summary({ underlyings: [u] });
            const it = r?.items?.[0];
            if (it?.available) vol.set(u, it);
          } catch {
            // Not an F&O underlying, or no IV history yet: the IV column stays empty.
          }
        }
      }
      const rows = [];
      for (const s of l.symbols) {
        const u = s.split(":")[1];
        const f = futOf(s);
        const fq = f ? q.get(f) : null;
        let oi = null;
        let oiBase = null;
        const fx = facts[s] ?? null;
        if (fx && fx.fut_oi !== null && fx.fut_oi !== undefined) {
          oi = { oi: fx.fut_oi, change: null, changePct: fx.fut_oi_change_pct };
          oiBase = fx.fut_oi_change_pct === null || fx.fut_oi_change_pct === undefined ? null : "scanner";
        } else if (fq && Number.isFinite(Number(fq.oi))) {
          let prev = Number(fq.oiPrev ?? fq.prevOi);
          oiBase = Number.isFinite(prev) && prev > 0 ? "quote" : null;
          if (!oiBase) {
            const p = await prevOiOf(u, f, day);
            if (p) {
              prev = p.oi;
              oiBase = `recorder ${p.date}`;
            }
          }
          // Without a previous-day OI, the OI shows with no change (never a change from an intraday base).
          oi = oiBase ? oiChange(Number(fq.oi), prev) : { oi: Number(fq.oi), change: null, changePct: null };
        }
        const sv = vol.get(u) ?? null;
        const fiv = ivs.get(u) ?? null;
        const v = { iv: fiv?.iv ?? null, expiry: fiv?.expiry ?? null, ivr: sv?.ivr ?? fx?.iv_rank ?? null, hv20: sv?.hv20 ?? fx?.hv20 ?? null };
        const row = watchRow(s, q.get(s) ?? null, { future: f ?? (fx?.fno ? "near future" : null), oi, vol: v });
        rows.push({ ...row, oiBase, fno: Boolean(f || fx?.fno || row.index) });
      }
      return { id: l.id, name: l.name, at: new Date(t).toISOString(), rows, errors };
    },
  };
}
