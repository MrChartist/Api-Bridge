/**
 * InstrumentStore: the merged, indexed view of every loaded broker master. Pure and synchronous (no I/O, no clock):
 * SymbolService feeds it contract rows per broker and asks it questions with an explicit IST `today`.
 *
 * Merge rules (one ResolvedInstrument per canonical symbol):
 *  - refs: one BrokerRef per broker (the first row a broker gives for a canonical symbol wins; duplicates are counted).
 *  - lotSize: taken from the first broker in `brokerOrder` that publishes a usable one. A different figure from a
 *    later broker is recorded as a conflict (status() shows it; the service logs it). Never invented: an instrument
 *    with no usable lot size from any broker is kept for token mapping but never resolves.
 *  - tickSize: the LARGEST usable value (every price on a coarser grid is valid on a finer one, not the reverse).
 *  - kind for cash symbols: INDEX when any master says index (parse() alone only knows the well-known names).
 *  - freezeQty: the smallest value any master publishes, else the dated exchange list (freezeQuantities.mjs).
 *  - expired derivatives (expiry before `today`, IST) are dropped at build time and refused at lookup time, because
 *    exchanges reuse tokens after expiry: a token is never an identity on its own.
 */
import { EXCHANGE_RANK, INDEX_NAME_ALIASES, KIND_RANK, mapContractRow } from "./aliases.mjs";
import { INDEX_FREEZE_QUANTITIES, freezeEntryFor } from "./freezeQuantities.mjs";

/**
 * @typedef {import("../core/contracts.mjs").ResolvedInstrument & { freezeQtySource: "master"|"exchange-list"|null }} StoredInstrument
 *   lotSize / tickSize may be null inside the store ("incomplete"); the service never returns such a record.
 * @typedef {{ broker: string, rows: number, instruments: number, skipped: number, duplicates: number,
 *   loadedAt: string | null, source: string | null, day: string | null }} BrokerStats
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const RIGHT_WORDS = Object.freeze({ CE: "CE", CALL: "CE", CALLS: "CE", PE: "PE", PUT: "PE", PUTS: "PE" });
const KIND_WORDS = Object.freeze({ FUT: "FUT", FUTS: "FUT", FUTURE: "FUT", FUTURES: "FUT", OPT: "OPT", OPTION: "OPT", OPTIONS: "OPT", EQ: "EQ", EQUITY: "EQ", STOCK: "EQ", INDEX: "INDEX", INDICES: "INDEX" });
const EXCHANGE_WORDS = new Set(Object.keys(EXCHANGE_RANK));

/** Bounded Levenshtein distance (returns max+1 as soon as the distance must exceed `max`). */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Score one name token against an underlying (and optional display name). 0 = no match. */
export function nameScore(token, underlying, name) {
  if (underlying === token) return 100;
  if (underlying.startsWith(token)) return 70;
  if (underlying.includes(token)) return 40;
  if (name && name.toUpperCase().includes(token)) return 30;
  if (token.length >= 4) {
    const max = token.length >= 7 ? 2 : 1;
    if (editDistance(token, underlying, max) <= max) return 20;
    if (underlying.length > token.length && editDistance(token, underlying.slice(0, token.length), 1) <= 1) return 15;
  }
  return 0;
}

/**
 * Split free text into structured filters and name tokens. "nifty 25000 ce", "banknifty fut", "nifty 50" (index
 * display names are folded to the canonical underlying first), "NFO:NIFTY", "reliance oct".
 * @param {string} q
 */
export function parseSearchText(q) {
  // ISO dates first (they contain "-"), then split on separators including "-" so canonical-looking text
  // ("NIFTY-2026-10-27-25000-CE") becomes name + expiry + strike + right; "BAJAJ-AUTO" still matches by substring.
  const dates = [];
  const rest = String(q ?? "")
    .toUpperCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, (d) => {
      dates.push(d);
      return " ";
    });
  let words = [...rest.replace(/[:,|/-]+/g, " ").trim().split(/\s+/).filter(Boolean), ...dates];
  // Fold multi-word index names ("NIFTY BANK", "NIFTY FIN SERVICE") into one canonical word.
  const folded = [];
  for (let i = 0; i < words.length; ) {
    let taken = 0;
    for (let n = Math.min(4, words.length - i); n >= 2; n--) {
      const alias = INDEX_NAME_ALIASES[words.slice(i, i + n).join(" ")];
      if (alias) {
        folded.push(alias);
        taken = n;
        break;
      }
    }
    if (taken) i += taken;
    else folded.push(words[i++]);
  }
  words = folded;
  const out = { names: [], strike: null, right: null, kind: null, exchange: null, expiry: null, month: null };
  for (const w of words) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(w)) out.expiry = w;
    else if (RIGHT_WORDS[w]) out.right = RIGHT_WORDS[w];
    else if (KIND_WORDS[w]) out.kind = KIND_WORDS[w];
    else if (EXCHANGE_WORDS.has(w)) out.exchange = w;
    else if (MONTHS.includes(w)) out.month = MONTHS.indexOf(w) + 1;
    else if (/^\d+(\.\d+)?$/.test(w) && Number(w) > 0) out.strike = Number(w);
    else out.names.push(w);
  }
  if (out.right && !out.kind) out.kind = "OPT";
  if (out.strike !== null && !out.kind) out.kind = "OPT";
  return out;
}

/** Deterministic order inside one underlying: spot, then futures by expiry, then options by expiry/strike/right. */
export function compareInstruments(a, b) {
  return (
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    EXCHANGE_RANK[a.exchange] - EXCHANGE_RANK[b.exchange] ||
    String(a.expiry ?? "").localeCompare(String(b.expiry ?? "")) ||
    (a.strike ?? 0) - (b.strike ?? 0) ||
    String(a.right ?? "").localeCompare(String(b.right ?? "")) ||
    a.canonical.localeCompare(b.canonical)
  );
}

/**
 * Search ranking: an exact symbol match first (+1000); then per name token 100 exact underlying, 70 prefix,
 * 40 substring, 30 display-name substring, 20/15 fuzzy (edit distance); +40 for spot instruments when the query has
 * no derivative words; ties broken by compareInstruments (spot, futures, options; nearest expiry; strike).
 * @param {{ freezeTable?: Record<string, import("./freezeQuantities.mjs").FreezeEntry> }} [opts]
 */
export function createInstrumentStore({ freezeTable = INDEX_FREEZE_QUANTITIES } = {}) {
  /** broker -> { rows, meta } (raw contract rows as loaded) */
  const masters = new Map();
  /** @type {string[]} */
  let brokerOrder = [];
  /** @type {Map<string, StoredInstrument>} */
  let byCanonical = new Map();
  /** broker -> Map("EXCHANGE|token" -> canonical) */
  let tokenIndex = new Map();
  /** broker -> Map(token -> canonical[]) */
  let bareTokenIndex = new Map();
  /** broker -> Map("EXCHANGE|TRADINGSYMBOL" -> canonical) and Map(TRADINGSYMBOL -> canonical[]) */
  let tsIndex = new Map();
  let bareTsIndex = new Map();
  /** underlying -> StoredInstrument[] (complete records only, sorted with compareInstruments) */
  let byUnderlying = new Map();
  /** "EXCHANGE:UNDERLYING" -> sorted futures expiries */
  let futExpiries = new Map();
  /** @type {Map<string, BrokerStats>} */
  let stats = new Map();
  /** @type {Array<{ canonical: string, field: string, values: Record<string, number> }>} */
  let conflicts = [];
  let builtFor = null;
  let version = 0;

  const push = (map, key, value) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(value)) list.push(value);
    } else map.set(key, [value]);
  };

  /** Rebuild every index from the loaded masters. `today` is the IST day ("YYYY-MM-DD"). */
  function rebuild(today) {
    const merged = new Map();
    const nextToken = new Map();
    const nextBareToken = new Map();
    const nextTs = new Map();
    const nextBareTs = new Map();
    const nextStats = new Map();
    const nextConflicts = [];
    const lotFrom = new Map();
    const order = [...brokerOrder.filter((b) => masters.has(b)), ...[...masters.keys()].filter((b) => !brokerOrder.includes(b)).sort()];

    for (const broker of order) {
      const { rows, meta } = masters.get(broker);
      const st = { broker, rows: rows.length, instruments: 0, skipped: 0, duplicates: 0, expired: 0, loadedAt: meta.loadedAt ?? null, source: meta.source ?? null, day: meta.day ?? null };
      const tIdx = new Map();
      const btIdx = new Map();
      const sIdx = new Map();
      const bsIdx = new Map();
      /** Keys set from a row's own exchange; a canonical-segment alias never overwrites one. */
      const rawT = new Set();
      const rawS = new Set();
      for (const row of rows) {
        const m = mapContractRow(row);
        if ("skip" in m) {
          st.skipped++;
          continue;
        }
        if (m.expiry && m.expiry < today) {
          st.expired++;
          continue;
        }
        let rec = merged.get(m.canonical);
        if (!rec) {
          rec = { canonical: m.canonical, exchange: m.exchange, kind: m.kind, underlying: m.underlying, expiry: m.expiry, strike: m.strike, right: m.right, name: null, lotSize: null, tickSize: null, freezeQty: null, freezeQtySource: null, isin: null, refs: {} };
          merged.set(m.canonical, rec);
        }
        if (rec.refs[broker]) {
          st.duplicates++;
          continue;
        }
        rec.refs[broker] = Object.freeze({ ...m.ref });
        st.instruments++;
        if (m.kind === "INDEX") rec.kind = "INDEX";
        if (!rec.name && m.name) rec.name = m.name;
        if (!rec.isin && m.isin) rec.isin = m.isin;
        if (m.lotSize !== null) {
          if (rec.lotSize === null) {
            rec.lotSize = m.lotSize;
            lotFrom.set(m.canonical, broker);
          } else if (rec.lotSize !== m.lotSize) {
            nextConflicts.push({ canonical: m.canonical, field: "lotSize", values: { [lotFrom.get(m.canonical)]: rec.lotSize, [broker]: m.lotSize } });
          }
        }
        if (m.tickSize !== null && (rec.tickSize === null || m.tickSize > rec.tickSize)) rec.tickSize = m.tickSize;
        if (m.freezeQty !== null && (rec.freezeQty === null || m.freezeQty < rec.freezeQty)) {
          rec.freezeQty = m.freezeQty;
          rec.freezeQtySource = "master";
        }
        // Index under the broker's raw exchange (what the adapter sends) and, when it differs, under the canonical
        // segment too (a derivative row tagged NSE is also findable as NFO). A raw key always wins over an alias.
        const alias = m.exchange !== m.ref.exchange ? m.exchange : null;
        const tKey = `${m.ref.exchange}|${m.ref.token}`;
        tIdx.set(tKey, m.canonical);
        rawT.add(tKey);
        if (alias && !rawT.has(`${alias}|${m.ref.token}`)) tIdx.set(`${alias}|${m.ref.token}`, m.canonical);
        push(btIdx, m.ref.token, m.canonical);
        if (m.ref.tradingSymbol) {
          const ts = m.ref.tradingSymbol.toUpperCase();
          sIdx.set(`${m.ref.exchange}|${ts}`, m.canonical);
          rawS.add(`${m.ref.exchange}|${ts}`);
          if (alias && !rawS.has(`${alias}|${ts}`)) sIdx.set(`${alias}|${ts}`, m.canonical);
          push(bsIdx, ts, m.canonical);
        }
      }
      nextToken.set(broker, tIdx);
      nextBareToken.set(broker, btIdx);
      nextTs.set(broker, sIdx);
      nextBareTs.set(broker, bsIdx);
      nextStats.set(broker, st);
    }

    const nextUnderlying = new Map();
    const nextFut = new Map();
    for (const rec of merged.values()) {
      if (rec.freezeQty === null) {
        const entry = freezeEntryFor(rec, freezeTable);
        if (entry) {
          rec.freezeQty = entry.freezeQty;
          rec.freezeQtySource = "exchange-list";
        }
      }
      rec.refs = Object.freeze(rec.refs);
      Object.freeze(rec);
      if (rec.lotSize === null || rec.tickSize === null) continue;
      push(nextUnderlying, rec.underlying, rec);
      if (rec.kind === "FUT") push(nextFut, `${rec.exchange}:${rec.underlying}`, rec.expiry);
    }
    for (const list of nextUnderlying.values()) list.sort(compareInstruments);
    for (const list of nextFut.values()) list.sort();

    byCanonical = merged;
    tokenIndex = nextToken;
    bareTokenIndex = nextBareToken;
    tsIndex = nextTs;
    bareTsIndex = nextBareTs;
    byUnderlying = nextUnderlying;
    futExpiries = nextFut;
    stats = nextStats;
    conflicts = nextConflicts;
    builtFor = today;
    version++;
  }

  const live = (rec, today) => (rec && (!rec.expiry || rec.expiry >= today) ? rec : null);

  return {
    /** Set the broker priority used for lot-size precedence (config order of accounts). */
    setBrokerOrder(order) {
      brokerOrder = [...order];
    },
    /**
     * Replace one broker's master and rebuild.
     * @param {string} broker
     * @param {object[]} rows  contract Instrument rows
     * @param {{ loadedAt?: string, source?: string, day?: string }} meta
     * @param {string} today IST day
     * @returns {BrokerStats}
     */
    setMaster(broker, rows, meta, today) {
      if (!Array.isArray(rows)) throw new TypeError(`master for ${broker} must be an array`);
      masters.set(broker, { rows, meta: { ...meta } });
      rebuild(today);
      return { ...stats.get(broker) };
    },
    /** Drop a broker's master (e.g. its account was removed). */
    removeMaster(broker, today) {
      if (!masters.delete(broker)) return false;
      rebuild(today);
      return true;
    },
    hasMaster: (broker) => masters.has(broker),
    brokers: () => [...masters.keys()],
    masterMeta: (broker) => (masters.has(broker) ? { ...masters.get(broker).meta } : null),
    /** Re-run the build when the IST day changed (drops contracts that expired overnight). */
    ensureDay(today) {
      if (builtFor !== today && masters.size) rebuild(today);
    },
    /** @returns {StoredInstrument | null} live record (may be incomplete), null when unknown or expired */
    get: (canonical, today) => live(byCanonical.get(canonical), today),
    /** Was this canonical known but expired? (for a clearer error) */
    isExpired: (canonical, today) => {
      const rec = byCanonical.get(canonical);
      return Boolean(rec && rec.expiry && rec.expiry < today);
    },
    /**
     * Canonical symbols for a broker token. With exchange: at most one. Without: every exchange that uses it.
     * @returns {string[]}
     */
    byToken(broker, token, exchange) {
      const t = String(token);
      if (exchange) {
        const hit = tokenIndex.get(broker)?.get(`${String(exchange).toUpperCase()}|${t}`);
        return hit ? [hit] : [];
      }
      return [...(bareTokenIndex.get(broker)?.get(t) ?? [])];
    },
    /** Canonical symbols for a broker trading symbol (case-insensitive). */
    byTradingSymbol(broker, tradingSymbol, exchange) {
      const ts = String(tradingSymbol).toUpperCase();
      if (exchange) {
        const hit = tsIndex.get(broker)?.get(`${String(exchange).toUpperCase()}|${ts}`);
        return hit ? [hit] : [];
      }
      return [...(bareTsIndex.get(broker)?.get(ts) ?? [])];
    },
    /** Sorted, unexpired futures expiries for EXCHANGE:UNDERLYING (for TradingView 1!/2!). */
    futuresExpiries(exchange, underlying, today) {
      return (futExpiries.get(`${exchange}:${underlying}`) ?? []).filter((e) => e >= today);
    },
    /**
     * Every complete, live instrument matching the query, best first.
     * @param {{ q: string, exchange?: string, kind?: string, underlying?: string, expiry?: string, exact?: string | null }} query
     * @param {string} today
     * @returns {StoredInstrument[]}
     */
    search(query, today) {
      const t = parseSearchText(query.q);
      const exchange = query.exchange ?? t.exchange;
      const kind = query.kind ?? t.kind;
      const expiry = query.expiry ?? t.expiry;
      const underlyingFilter = query.underlying ? String(query.underlying).toUpperCase() : null;
      const keep = (r) =>
        (!r.expiry || r.expiry >= today) &&
        (!exchange || r.exchange === exchange) &&
        (!kind || r.kind === kind) &&
        (!expiry || r.expiry === expiry) &&
        (!t.month || (r.expiry && Number(r.expiry.slice(5, 7)) === t.month)) &&
        (t.strike === null || r.strike === t.strike) &&
        (!t.right || r.right === t.right);
      // Without derivative words, spot instruments (index, equity) of any matching name come before derivatives.
      const spotBonus = !kind && !expiry && !t.month && t.strike === null && !t.right ? 40 : 0;
      const scored = [];
      for (const [underlying, list] of byUnderlying) {
        if (underlyingFilter && underlying !== underlyingFilter) continue;
        let groupScore = 0;
        let ok = true;
        for (const tok of t.names) {
          // Name tokens score against the underlying and the display name of the group's first record.
          const s = nameScore(tok, underlying, list[0]?.name ?? null);
          if (!s) {
            ok = false;
            break;
          }
          groupScore += s;
        }
        if (!ok) continue;
        for (const r of list) {
          if (!keep(r)) continue;
          const spot = r.kind === "INDEX" || r.kind === "EQ" ? spotBonus : 0;
          scored.push({ r, s: groupScore + spot + (query.exact && r.canonical === query.exact ? 1000 : 0) });
        }
      }
      scored.sort((a, b) => b.s - a.s || compareInstruments(a.r, b.r));
      const out = scored.map((x) => x.r);
      // An exact symbol always leads, even when the free-text words alone would not have found it.
      const exactRec = query.exact ? live(byCanonical.get(query.exact), today) : null;
      if (exactRec && exactRec.lotSize !== null && exactRec.tickSize !== null && out[0] !== exactRec) {
        return [exactRec, ...out.filter((r) => r !== exactRec)];
      }
      return out;
    },
    /** @returns {BrokerStats[]} */
    stats: () => [...stats.values()].map((s) => ({ ...s })),
    conflicts: () => conflicts.map((c) => ({ ...c, values: { ...c.values } })),
    /** Number of distinct canonical instruments (including incomplete ones). */
    size: () => byCanonical.size,
    /** Increments on every rebuild; part of search cursors so a page never mixes two builds silently. */
    version: () => version,
  };
}
