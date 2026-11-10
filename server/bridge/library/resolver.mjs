/**
 * Turn an option universe into concrete symbols for NOW.
 *
 *   expiries   the underlying's listed expiries (deps.marketData.expiries: the instrument master, no extra broker call), then the
 *              rolling rule (expiries.mjs). Recomputed on every resolve, so "current-weekly" moves on by itself.
 *   price      one last-price read of the underlying (deps.marketData.ltp) when the universe is ATM based.
 *   strikes    the listed strikes of each chosen expiry (deps.symbols.search: the instrument master), `count` each side of the
 *              strike nearest to the price (strikes.mjs). No listed strikes: a generated grid for an index, an error for a stock.
 *
 * Honest about the price (`atmSource` in the answer, and an error when the price cannot be trusted):
 *   supplied      the caller gave `spot`: used as is
 *   live          realtime data, not stale, the market is open
 *   last-close    realtime-class data but the market is closed or pre-open: the price is the last close, so the ATM is yesterday's
 *   stale         realtime-class data the Bridge itself marks stale
 *   delayed|eod   a delayed or end-of-day source (never a source for ATM unless the caller allows it)
 *   not-needed    the universe has explicit strikes ({ from, to }), no price was used
 * `stale`, `delayed` and `eod` are refused with an error unless the caller says `allowStale` (the dashboard preview does; a download
 * or recording does not). Every non-live source also adds a plain warning.
 */
import { BridgeError } from "../core/errors.mjs";
import { defaultOptionExchange, legSymbol } from "../market/chain.mjs";
import { formatSymbol } from "../core/symbolFormat.mjs";
import { selectExpiries, upcomingExpiries } from "./expiries.mjs";
import { gridAround, gridBetween, stepOfStrikes, strikesAround, strikesBetween } from "./strikes.mjs";

const PAGE_LIMIT = 500;
const MAX_PAGES = 40;
const MARKET_OPEN_STATES = new Set(["OPEN", "SPECIAL"]);

/** The cash or index symbol that prices an underlying. */
export function spotSymbolOf(underlying) {
  return formatSymbol({ exchange: defaultOptionExchange(underlying) === "BFO" ? "BSE" : "NSE", underlying, kind: "EQ" });
}

/**
 * Where a price came from, and whether an ATM may be built on it.
 * @param {any} f  Freshness label of the price (or undefined)
 * @param {boolean} marketOpen
 * @returns {{ atmSource: "live"|"last-close"|"stale"|"delayed"|"eod", ok: boolean }}
 */
export function classifyPrice(f, marketOpen) {
  const cls = f?.class ?? "realtime";
  if (cls === "delayed") return { atmSource: "delayed", ok: false };
  if (cls === "eod") return { atmSource: "eod", ok: false };
  if (f?.stale === true) return { atmSource: "stale", ok: false };
  return marketOpen ? { atmSource: "live", ok: true } : { atmSource: "last-close", ok: true };
}

const toUnavailable = (underlying, what) => new BridgeError("BROKER_UNAVAILABLE", `The ${underlying} price is not available (${what}), so the at-the-money strike cannot be worked out. Try again in a moment, or give the strikes explicitly ({ from, to }).`);

/**
 * @param {{ deps: { marketData: any, symbols: any }, cfg: ReturnType<typeof import("./config.mjs").parseLibraryConfig>, cal: any, now: () => number }} env
 */
export function createResolver({ deps, cfg, cal, now }) {
  const readOpts = (o) => ({
    priority: o.priority ?? "interactive",
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.accountId ? { accountId: o.accountId } : {}),
    ...(o.allowedAccounts ? { allowedAccounts: o.allowedAccounts } : {}),
  });

  /** Listed contracts of one underlying and expiry from the instrument master: Map(strike -> { CE?, PE? }). */
  async function listedOptions(underlying, expiry, exchange) {
    const byStrike = new Map();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const q = { q: underlying, underlying, kind: "OPT", exchange, expiry, limit: PAGE_LIMIT };
      if (cursor) q.cursor = cursor;
      const res = await deps.symbols.search(q);
      for (const r of res?.items ?? []) {
        if (r?.underlying !== underlying || r.expiry !== expiry || !(r.strike > 0) || (r.right !== "CE" && r.right !== "PE")) continue;
        const row = byStrike.get(r.strike) ?? {};
        row[r.right] = r.canonical;
        byStrike.set(r.strike, row);
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return byStrike;
  }

  async function listedFutures(underlying, exchange) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const q = { q: underlying, underlying, kind: "FUT", exchange, limit: PAGE_LIMIT };
      if (cursor) q.cursor = cursor;
      const res = await deps.symbols.search(q);
      for (const r of res?.items ?? []) if (r?.underlying === underlying && r.expiry) out.push({ expiry: r.expiry, symbol: r.canonical });
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  }

  /** One read of the underlying's price, classified. */
  async function readSpot(underlying, o, allowStale, marketOpen) {
    const symbol = spotSymbolOf(underlying);
    let r;
    try {
      r = await deps.marketData.ltp([symbol], { ...readOpts(o), ...(allowStale ? { allowBackup: true } : {}) });
    } catch (err) {
      if (err instanceof BridgeError && err.code !== "INTERNAL") throw err;
      throw toUnavailable(underlying, "the read failed");
    }
    const item = (r?.items ?? [])[0];
    if (!item || !(item.ltp > 0)) {
      const e = (r?.errors ?? [])[0];
      throw toUnavailable(underlying, e?.message ?? e?.code ?? "no price came back");
    }
    const f = item.freshness ?? {};
    const c = classifyPrice(f, marketOpen);
    if (!c.ok && !allowStale) {
      const when = f.asOf ? ` (last update ${f.asOf})` : "";
      if (c.atmSource === "stale") throw new BridgeError("BROKER_UNAVAILABLE", `The ${underlying} price is stale${when}, so the at-the-money strike would be wrong. Wait for the feed to catch up, give the strikes explicitly ({ from, to }), or allow a stale price for a preview (allowStale).`);
      throw new BridgeError("CAPABILITY_UNSUPPORTED", `Only ${c.atmSource === "eod" ? "an end-of-day" : "a delayed"} ${underlying} price is available${when}, and it is not used to pick the at-the-money strike. Connect a broker feed, give the strikes explicitly ({ from, to }), or allow it for a preview (allowStale).`);
    }
    return { symbol, price: item.ltp, atmSource: c.atmSource, freshness: f };
  }

  /**
   * @param {any} universe  a stored (normalised) universe
   * @param {{ spot?: number, allowStale?: boolean, requireLive?: boolean, priority?: string, signal?: AbortSignal, accountId?: string, allowedAccounts?: string[] }} [o]
   */
  async function resolveUniverse(universe, o = {}) {
    const U = universe.underlying;
    const exchange = defaultOptionExchange(U);
    const nowMs = now();
    const allowStale = o.allowStale ?? cfg.allowStaleAtm;
    const warnings = [];

    // ── expiries ──
    let listed;
    try {
      const e = await deps.marketData.expiries(U, { ...readOpts(o), exchange });
      listed = e?.expiries ?? [];
    } catch (err) {
      if (err instanceof BridgeError && err.code !== "INTERNAL") throw err;
      throw new BridgeError("BROKER_UNAVAILABLE", `The expiries of ${U} could not be read, so the universe cannot be resolved.`);
    }
    const up = upcomingExpiries(listed, { nowMs, cal, exchange });
    const sel = selectExpiries(universe.expiries, up.items, { underlying: U, maxWeekly: cfg.maxWeeklyExpiries, today: up.today, droppedToday: up.droppedToday, close: up.close });
    warnings.push(...sel.warnings);
    if (!sel.picked.length) throw new BridgeError("SYMBOL_NOT_FOUND", `The expiry rule matched no listed expiry of ${U}. ${sel.warnings.join(" ")}`.trim());

    // ── price ──
    const needsPrice = "around" in universe.strikes;
    const spotSym = spotSymbolOf(U);
    const marketOpen = MARKET_OPEN_STATES.has(cal.sessionAt(defaultOptionExchange(U) === "BFO" ? "BSE" : "NSE", nowMs).state);
    let spot = null;
    let atmSource = "not-needed";
    if (needsPrice) {
      if (typeof o.spot === "number" && o.spot > 0) {
        spot = { symbol: spotSym, price: o.spot, atmSource: "supplied", freshness: null };
      } else {
        spot = await readSpot(U, o, allowStale, marketOpen);
      }
      atmSource = spot.atmSource;
      if (o.requireLive && atmSource !== "live" && atmSource !== "supplied") {
        throw new BridgeError("BROKER_UNAVAILABLE", `The ${U} price is not live (${atmSource}); this caller needs a live price to pick the at-the-money strike.`);
      }
      if (atmSource === "last-close") warnings.push(`The market is closed (or in pre-open), so the ${U} price is the last close and the at-the-money strike is yesterday's. It moves with the price once the session opens.`);
      else if (atmSource === "stale") warnings.push(`The ${U} price is stale; the at-the-money strike may be wrong.`);
      else if (atmSource === "delayed" || atmSource === "eod") warnings.push(`The ${U} price comes from a ${atmSource === "eod" ? "end-of-day" : "delayed"} source; the at-the-money strike may be wrong.`);
      else if (atmSource === "supplied") warnings.push(`The at-the-money strike was worked out from the price you supplied (${o.spot}).`);
    }

    // ── contracts ──
    const symbols = [];
    const seen = new Set();
    const add = (s) => {
      if (!seen.has(s)) {
        seen.add(s);
        symbols.push(s);
      }
    };
    if (universe.includeUnderlying) add(spotSym);

    if (universe.includeFuture) {
      let futs = [];
      try {
        futs = (await listedFutures(U, exchange)).filter((f) => f.expiry >= up.today);
      } catch {
        warnings.push(`The futures of ${U} could not be listed.`);
      }
      const chosen = new Set();
      for (const e of sel.picked) {
        const same = futs.find((f) => f.expiry.slice(0, 7) === e.date.slice(0, 7));
        if (same) chosen.add(same.symbol);
      }
      if (!chosen.size && futs.length) {
        chosen.add(futs[0].symbol);
        warnings.push(`No future expires in the month of the chosen expiries; the nearest future (${futs[0].expiry}) is used.`);
      }
      if (!chosen.size) warnings.push(`No future of ${U} is listed.`);
      for (const f of futs) if (chosen.has(f.symbol)) add(f.symbol);
    }

    const perExpiry = [];
    let strikeSource = "listed";
    for (const e of sel.picked) {
      let table = new Map();
      try {
        table = await listedOptions(U, e.date, exchange);
      } catch {
        warnings.push(`The listed options of ${U} for ${e.date} could not be read.`);
      }
      const ladder = [...table.keys()].sort((a, b) => a - b);
      let step = ladder.length >= 3 ? stepOfStrikes(ladder) : null;
      let atm = null;
      let strikes = [];
      let source = "listed";
      if (ladder.length) {
        if (needsPrice) ({ atm, strikes } = strikesAround(ladder, spot.price, universe.strikes.count));
        else strikes = strikesBetween(ladder, universe.strikes.from, universe.strikes.to);
      } else {
        // No listed contracts known: an index grid on the configured step, never a guessed stock grid.
        const gridStep = cfg.strikeSteps[U];
        if (!(gridStep > 0)) {
          throw new BridgeError("SYMBOL_NOT_FOUND", `No listed option strikes were found for ${U} on ${e.date}, and ${U} has no configured strike step (a stock's step depends on its price). Refresh the instrument list, or set library.strikeSteps.${U}.`);
        }
        step = gridStep;
        source = "grid";
        strikeSource = "grid";
        if (needsPrice) ({ atm, strikes } = gridAround(spot.price, gridStep, universe.strikes.count));
        else strikes = gridBetween(universe.strikes.from, universe.strikes.to, gridStep);
        warnings.push(`No listed strikes were found for ${U} on ${e.date}; the strikes are a generated grid on a step of ${gridStep}. Some of these contracts may not exist.`);
      }
      if (!strikes.length) warnings.push(`No strikes matched for ${U} on ${e.date}.`);
      for (const k of strikes) {
        for (const side of universe.sides) {
          const listedSymbol = table.get(k)?.[side];
          if (listedSymbol) add(listedSymbol);
          else if (source === "grid") add(legSymbol(exchange, U, e.date, k, side));
        }
      }
      perExpiry.push({ expiry: e.date, kind: e.kind, shifted: e.shifted === true, ...(e.shifted ? { ruleDate: e.ruleDate, reason: e.reason } : {}), daysAway: e.daysAway, atm, step, strikeSource: source, first: strikes[0] ?? null, last: strikes.at(-1) ?? null, strikes: strikes.length });
    }

    if (symbols.length > cfg.maxSymbols) {
      throw new BridgeError("VALIDATION_FAILED", `This universe resolves to ${symbols.length} symbols, more than library.maxSymbols (${cfg.maxSymbols}). Use fewer strikes or expiries.`, { errors: [{ path: "universe", message: "too many symbols" }] });
    }

    const rule = [
      `${U} options`,
      `expiries: ${sel.rule}`,
      needsPrice ? `strikes: ${universe.strikes.count} each side of the at-the-money strike (the listed strike nearest the ${spot.atmSource === "supplied" ? "supplied price" : "price"})` : `strikes: ${universe.strikes.from} to ${universe.strikes.to}`,
      `sides: ${universe.sides.join(", ")}`,
      ...(universe.includeUnderlying ? [`with ${spotSym}`] : []),
      ...(universe.includeFuture ? ["with the future"] : []),
    ].join("; ");

    return {
      symbols,
      rule,
      atmSource,
      strikeSource,
      underlying: {
        symbol: spotSym,
        price: spot?.price ?? null,
        asOf: spot?.freshness?.asOf ?? null,
        ageMs: spot?.freshness?.ageMs ?? null,
        class: spot?.freshness?.class ?? null,
        source: spot?.freshness?.source ?? (spot?.atmSource === "supplied" ? "supplied" : null),
      },
      expiries: perExpiry,
      warnings,
    };
  }

  return { resolveUniverse, spotSymbolOf };
}
