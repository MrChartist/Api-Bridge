/**
 * What a recording or rule means in concrete symbols right now.
 *
 *   symbols: [...]              as given (checked, canonical)
 *   collection: "name"          deps.library?.resolve(name) when the library of collections is there; otherwise a clear refusal
 *   underlying + universe       a small resolver of our own for an index option window: expiries by rule (current-weekly,
 *                               next-weekly, current-monthly, all-weekly or dates), strikes around the ATM or between two
 *                               strikes, CE and PE, the underlying and the future if asked. It reads the expiry list and ONE
 *                               chain per expiry through the market service at background priority (stream and cache first).
 *
 * Honesty: an ATM window needs a real-time spot price. A delayed, stale or missing price gives `ok: false` and a plain
 * reason; the caller records a gap and tries again. A stale ATM is never used silently.
 * Re-resolved every trading day and, for a moving window, every `reResolveMinutes`.
 */
import { BridgeError } from "../core/errors.mjs";
import { formatSymbol, parseSymbol } from "../core/symbolFormat.mjs";
import { atmStrike, defaultOptionExchange, trimStrikes } from "../market/chain.mjs";
import { addDays, istDateOf } from "../reference/calendar.mjs";

const MAX_ALL_WEEKLY = 6;

/** The cash exchange of an underlying's spot price. */
export const cashExchangeOf = (underlying) => (defaultOptionExchange(underlying) === "BFO" ? "BSE" : "NSE");

/**
 * Pick expiries from a sorted list of ISO dates by rule (pure).
 * @param {string[]} list  upcoming expiry dates
 * @param {string | string[]} rule
 * @param {string} today  IST date
 * @returns {{ dates: string[], notes: string[] }}
 */
export function pickExpiries(list, rule, today) {
  const upcoming = [...new Set(list)].filter((d) => d >= today).sort();
  const notes = [];
  if (Array.isArray(rule)) {
    const dates = rule.filter((d) => d >= today);
    for (const d of rule) if (d < today) notes.push(`${d} has already expired and was left out.`);
    for (const d of dates) if (upcoming.length && !upcoming.includes(d)) notes.push(`${d} is not in the exchange's expiry list for this underlying.`);
    return { dates: [...new Set(dates)].sort(), notes };
  }
  if (!upcoming.length) return { dates: [], notes: ["No upcoming expiry is listed."] };
  if (rule === "current-weekly") return { dates: [upcoming[0]], notes };
  if (rule === "next-weekly") return upcoming[1] ? { dates: [upcoming[1]], notes } : { dates: [], notes: ["There is no second upcoming expiry."] };
  if (rule === "current-monthly") {
    const month = upcoming[0].slice(0, 7);
    const inMonth = upcoming.filter((d) => d.startsWith(month));
    return { dates: [inMonth[inMonth.length - 1]], notes };
  }
  if (rule === "all-weekly") {
    const limit = addDays(upcoming[0], 35);
    return { dates: upcoming.filter((d) => d <= limit).slice(0, MAX_ALL_WEEKLY), notes };
  }
  return { dates: [], notes: [`Unknown expiry rule ${rule}.`] };
}

/** Leg symbols of chain rows by side. */
function legsOf(rows, sides) {
  const out = [];
  for (const r of rows) for (const side of sides) {
    const leg = side === "CE" ? r.ce : r.pe;
    if (leg?.symbol) out.push(leg.symbol);
  }
  return out;
}

const canonical = (s) => {
  try {
    return parseSymbol(s).canonical;
  } catch {
    return null;
  }
};

/** Normalise whatever the library of collections answers into { symbols, resolvedAt, rule, ok, reason }. */
export function fromLibraryAnswer(res) {
  const body = res?.data ?? res ?? {};
  const list = Array.isArray(body) ? body : (body.symbols ?? body.items ?? []);
  const symbols = [];
  const notes = [];
  for (const x of list) {
    const raw = typeof x === "string" ? x : x?.symbol;
    const c = raw ? canonical(raw) : null;
    if (c) symbols.push(c);
    else if (raw) notes.push(`${raw} is not a symbol the Bridge understands and was left out.`);
  }
  // The library says where the ATM price came from (atmSource) and warns when it is not a real-time one; a stale ATM
  // normally arrives as an error, but a delayed or end-of-day source is refused here too.
  const src = body.atmSource;
  const srcClass = src && typeof src === "object" ? (src.class ?? src.dataClass ?? null) : null;
  const srcText = typeof src === "string" ? src : src && typeof src === "object" ? JSON.stringify(src) : "";
  const notRealtime = (srcClass && srcClass !== "realtime") || /delayed|eod|end-of-day|stale/i.test(typeof src === "string" ? src : "") || src?.stale === true;
  const warnings = (Array.isArray(body.warnings) ? body.warnings : []).map((x) => (typeof x === "string" ? x : x?.message ?? JSON.stringify(x)));
  if (notRealtime) notes.push(`The ATM price came from a source that is not real-time (${srcText}).`);
  const reason = notRealtime ? `The collection was resolved from a price that is not real-time (${srcText}), so it was not used. A recording never guesses from a delayed or end-of-day price.` : (body.reason ?? body.error ?? null);
  const ok = body.ok !== false && !notRealtime && symbols.length > 0 && !(body.atm && typeof body.atm === "object" && body.atm.ok === false);
  return { ok, symbols: [...new Set(symbols)], resolvedAt: body.resolvedAt ?? null, rule: typeof body.rule === "string" ? body.rule : body.rule ? JSON.stringify(body.rule) : null, notes: [...notes, ...warnings, ...(Array.isArray(body.notes) ? body.notes : [])], reason: ok ? null : (reason ?? (symbols.length ? "The collection could not be resolved honestly right now." : "The collection has no symbols right now.")) };
}

/**
 * @param {{ marketData: any, symbols?: any, library?: () => any, now: () => number, share: () => number, maxWaitMs?: number }} deps
 *   library: a function so a module that starts later can be found when needed.
 */
export function createUniverseResolver({ marketData, symbols, library = () => null, now, share, maxWaitMs = 20_000 }) {
  const readOpts = () => ({ priority: "background", backgroundShare: Math.min(0.8, share()), maxWaitMs, allowBackup: false });

  /** One underlying's window. @returns {Promise<{ symbols: string[], notes: string[], rule: string, failed?: string }>} */
  async function oneUnderlying(underlyingIn, u, ms) {
    const underlying = String(underlyingIn).toUpperCase();
    const today = istDateOf(ms);
    const optEx = defaultOptionExchange(underlying);
    const cash = cashExchangeOf(underlying);
    const notes = [];
    let list;
    try {
      const e = await marketData.expiries(underlying, readOpts());
      list = e.expiries;
    } catch (err) {
      return { symbols: [], notes, rule: `${underlying}`, failed: `The expiry list of ${underlying} could not be read (${err.detail ?? err.message}).` };
    }
    const picked = pickExpiries(list, u.expiries, today);
    notes.push(...picked.notes);
    if (!picked.dates.length) return { symbols: [], notes, rule: `${underlying} ${JSON.stringify(u.expiries)}`, failed: picked.notes[0] ?? `No expiry matches ${JSON.stringify(u.expiries)}.` };
    const out = [];
    const rules = [];
    const atmMode = "around" in u.strikes;
    for (const expiry of picked.dates) {
      let chain;
      try {
        chain = await marketData.optionChain({ underlying, expiry, greeks: false }, readOpts());
      } catch (err) {
        notes.push(`The chain of ${underlying} ${expiry} could not be read (${err.detail ?? err.message}).`);
        continue;
      }
      let rows = chain.rows ?? [];
      if (atmMode) {
        const f = chain.freshness ?? {};
        const spot = chain.underlyingLtp;
        if (!(spot > 0)) {
          notes.push(`No price for ${underlying}, so the strikes around the ATM of ${expiry} cannot be chosen.`);
          continue;
        }
        if (f.class && f.class !== "realtime") {
          notes.push(`The price of ${underlying} is ${f.class}${f.delaySec ? ` (${f.delaySec} s late)` : ""}. A stale ATM is never used: ${expiry} was skipped until a real-time price is available.`);
          continue;
        }
        if (f.stale) {
          notes.push(`The price of ${underlying} is out of date, so ${expiry} was skipped until a fresh price is available.`);
          continue;
        }
        const atm = atmStrike(rows.map((r) => r.strike), spot);
        rows = trimStrikes(rows, atm, u.strikes.count);
        rules.push(`${underlying} ${expiry} ATM ${atm} +/- ${u.strikes.count} strikes (spot ${spot})`);
      } else {
        rows = rows.filter((r) => r.strike >= u.strikes.from && r.strike <= u.strikes.to);
        rules.push(`${underlying} ${expiry} strikes ${u.strikes.from} to ${u.strikes.to}`);
      }
      out.push(...legsOf(rows, u.sides));
    }
    if (!out.length) return { symbols: [], notes, rule: rules.join("; ") || underlying, failed: notes.at(-1) ?? "No option symbols could be chosen." };
    if (u.includeUnderlying) out.push(formatSymbol({ exchange: cash, underlying }));
    if (u.includeFuture) {
      const monthly = pickExpiries(list, "current-monthly", today).dates[0];
      if (monthly) {
        const fut = formatSymbol({ exchange: optEx, underlying, expiry: monthly, kind: "FUT" });
        let known = true;
        if (symbols?.resolve) {
          try {
            await symbols.resolve(fut);
          } catch (err) {
            if (err instanceof BridgeError && err.code === "SYMBOL_NOT_FOUND") known = false;
          }
        }
        if (known) out.push(fut);
        else notes.push(`The future ${fut} is not in the instrument list and was left out.`);
      }
    }
    return { symbols: out, notes, rule: rules.join("; ") };
  }

  /**
   * @param {{ symbols?: string[], collection?: string, underlying?: string | string[], universe?: object, expiry?: string, strikes?: number }} target
   * @returns {Promise<{ ok: boolean, symbols: string[], resolvedAt: string, rule: string, notes: string[], reason: string | null, source: "given"|"library"|"bridge" }>}
   */
  async function resolve(target, ms = now()) {
    const resolvedAt = new Date(ms).toISOString();
    if (target.symbols) {
      const symbolsOut = [];
      const notes = [];
      for (const s of target.symbols) {
        const c = canonical(s);
        if (c) symbolsOut.push(c);
        else notes.push(`${s} is not a symbol the Bridge understands and was left out.`);
      }
      const set = [...new Set(symbolsOut)];
      return { ok: set.length > 0, symbols: set, resolvedAt, rule: "the symbols you listed", notes, reason: set.length ? null : "None of the listed symbols is valid.", source: "given" };
    }
    if (target.collection) {
      const lib = library();
      if (!lib || typeof lib.resolve !== "function") {
        return { ok: false, symbols: [], resolvedAt, rule: `collection ${target.collection}`, notes: [], reason: "The library of collections is not available in this Bridge, so the collection cannot be resolved.", source: "library" };
      }
      try {
        const a = fromLibraryAnswer(await lib.resolve(target.collection));
        return { ok: a.ok, symbols: a.symbols, resolvedAt: a.resolvedAt ?? resolvedAt, rule: a.rule ?? `collection ${target.collection}`, notes: a.notes, reason: a.reason, source: "library" };
      } catch (err) {
        return { ok: false, symbols: [], resolvedAt, rule: `collection ${target.collection}`, notes: [], reason: `Collection ${target.collection} could not be resolved: ${err.detail ?? err.message}`, source: "library" };
      }
    }
    const unders = Array.isArray(target.underlying) ? target.underlying : [target.underlying];
    const universe = target.universe ?? {
      expiries: target.expiry ? [target.expiry] : "current-weekly",
      strikes: { around: "atm", count: target.strikes ?? 10 },
      sides: ["CE", "PE"],
      includeUnderlying: true,
      includeFuture: false,
    };
    const all = [];
    const notes = [];
    const rules = [];
    const failed = [];
    for (const u of unders) {
      const r = await oneUnderlying(u, universe, ms);
      all.push(...r.symbols);
      notes.push(...r.notes);
      if (r.rule) rules.push(r.rule);
      if (r.failed) failed.push(`${String(u).toUpperCase()}: ${r.failed}`);
    }
    const set = [...new Set(all)];
    return { ok: set.length > 0, symbols: set, resolvedAt, rule: rules.join("; "), notes: [...notes, ...(set.length ? failed : [])], reason: set.length ? null : failed.join(" ") || "Nothing could be chosen.", source: "bridge" };
  }

  return { resolve };
}
