/**
 * The F&O underlying list (stream S19, docs/spec/p1-06-stocks.md §2.7, §3.3–3.4). Built from data, never from a
 * constant list: indices are the underlyings whose master lists options and whose spot row is an INDEX; stocks come
 * from the reference store's point-in-time universe (NSE market lots) when it is recorded, else from the masters
 * (stocks with NFO futures), and are intersected with the masters so a stock this broker does not list is dropped
 * (counted in missingAtBroker). Contract facts per item: lot (reference, else master), tick size and strike step from
 * the nearest expiry's master legs (inferred step), freeze qty, ban/MWPL band, events, adjusted contracts.
 *
 * The list lives in memory (rebuilt on reference.updated, a master reload, or every 10 minutes) and makes no broker
 * call. Pure helpers are exported for tests.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { settlementOf } from "../dashboard/expiry-costs.js";
import { strikeStepOf } from "../market/chain.mjs";
import { istDate, toIstIso } from "../market/time.mjs";

export { istDate, settlementOf, strikeStepOf };

const PAGE = 500;
const MAX_PAGES = 60;
const REBUILD_MS = 10 * 60_000;

/** The lot most contracts carry (adjusted contracts may differ); ties go to the smaller lot. */
export function modalLot(rows) {
  const counts = new Map();
  for (const r of rows) if (Number.isFinite(r.lotSize) && r.lotSize > 0) counts.set(r.lotSize, (counts.get(r.lotSize) ?? 0) + 1);
  let best = null;
  for (const [lot, n] of counts) if (best === null || n > best[1] || (n === best[1] && lot < best[0])) best = [lot, n];
  return best ? best[0] : null;
}

/**
 * Merge the reference universe with the master underlyings (§2.7).
 * @param {{ coverage: string, items: Array<{ symbol: string, kind: string }> } | null} ref  reference.universe() result
 * @param {Map<string, { kind: "index"|"stock"|null }>} masters  underlying -> facts from the masters
 * @returns {{ source: "reference"|"masters", stocks: string[], indices: string[], missingAtBroker: string[] }}
 */
export function mergeUniverse(ref, masters, { indices = null } = {}) {
  const fromRef = ref && ref.coverage === "recorded" && Array.isArray(ref.items) && ref.items.length > 0;
  const masterStocks = [...masters.entries()].filter(([, m]) => m.kind === "stock").map(([u]) => u);
  const masterIndices = [...masters.entries()].filter(([, m]) => m.kind === "index" && m.hasOptions).map(([u]) => u);
  let stocks;
  const missingAtBroker = [];
  if (fromRef) {
    stocks = [];
    for (const i of ref.items) {
      if (i.kind !== "stock") continue;
      if (masters.has(i.symbol)) stocks.push(i.symbol);
      else missingAtBroker.push(i.symbol);
    }
  } else stocks = masterStocks;
  const idx = Array.isArray(indices) && indices.length ? indices.filter((u) => masters.has(u)) : masterIndices;
  return { source: fromRef ? "reference" : "masters", stocks: [...new Set(stocks)].sort(), indices: [...new Set(idx)], missingAtBroker: missingAtBroker.sort() };
}

/** Index order (§6.12): indices with a weekly expiry first (from data), then alphabetical. */
export function orderIndices(items) {
  return [...items].sort((a, b) => Number(b.weekly) - Number(a.weekly) || (a.underlying < b.underlying ? -1 : a.underlying > b.underlying ? 1 : 0));
}

/** Weekly listing (from data): two listed expiries in one calendar month, or two at most 10 days apart. */
export function hasWeekly(expiries) {
  const xs = [...new Set(expiries ?? [])].sort();
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i].slice(0, 7) === xs[i - 1].slice(0, 7)) return true;
    if ((Date.parse(`${xs[i]}T00:00:00Z`) - Date.parse(`${xs[i - 1]}T00:00:00Z`)) / 86_400_000 <= 10) return true;
  }
  return false;
}

/** The ban object of a list item: null for indices, { available: false, reason } when unknown. */
export function banOf(kind, status) {
  if (kind !== "stock") return null;
  if (!status || status.available === false) return { available: false, reason: status?.reason ?? "NOT_RECORDED" };
  return { inBan: status.inBan === true, mwplPct: status.mwplPct ?? null, band: status.band ?? (status.inBan ? "ban" : null), forDate: status.forDate ?? null, asOf: status.asOf ?? null, ...(status.source === "demo-override" ? { source: "demo-override" } : {}) };
}

/**
 * @param {{ reference?: any, symbols?: any, clock?: { now(): number }, logger?: any, config?: any, cfg: object,
 *   coverageFor?: (underlying: string) => object|null, banOverride?: () => { symbols: Set<string>, until: number } | null }} deps
 */
export function createUniverse(deps) {
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const usable = (s) => Boolean(s) && !isStub(s);
  const reference = (() => {
    try {
      return usable(deps.reference) && typeof deps.reference.universe === "function" ? deps.reference : null;
    } catch {
      return null;
    }
  })();
  const symbols = (() => {
    try {
      return usable(deps.symbols) && typeof deps.symbols.search === "function" ? deps.symbols : null;
    } catch {
      return null;
    }
  })();
  const cfg = deps.cfg;
  let built = null;
  let building = null;
  let builtAt = 0;
  let dirty = true;

  async function searchAll(q) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await symbols.search(cursor ? { ...q, cursor } : q);
      out.push(...(res?.items ?? []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Facts per underlying from the masters (no broker call). */
  async function masterFacts() {
    const facts = new Map();
    if (!symbols) return facts;
    const futs = [];
    for (const exchange of ["NFO", "BFO"]) {
      try {
        futs.push(...(await searchAll({ q: "FUT", kind: "FUT", exchange, limit: PAGE })));
      } catch {
        // that master is not loaded
      }
    }
    const today = istDate(now());
    const unders = new Map();
    for (const r of futs) if (r?.underlying && (!r.expiry || r.expiry >= today)) unders.set(r.underlying, r.exchange);
    for (const [u, exchange] of unders) {
      let spot = null;
      let opts = [];
      try {
        const res = await symbols.search({ q: u, underlying: u, limit: 5 });
        spot = (res?.items ?? []).find((r) => r.underlying === u && (r.kind === "INDEX" || r.kind === "EQ")) ?? null;
        opts = (await searchAll({ q: u, underlying: u, kind: "OPT", limit: PAGE })).filter((r) => r.underlying === u && r.expiry >= today);
      } catch {
        // skip this underlying
      }
      const kind = spot ? (spot.kind === "INDEX" ? "index" : "stock") : null;
      const expiries = [...new Set(opts.map((r) => r.expiry))].sort();
      const nearest = expiries[0] ?? null;
      const near = opts.filter((r) => r.expiry === nearest);
      const lot = modalLot(near);
      const ticks = near.map((r) => r.tickSize).filter((t) => Number.isFinite(t) && t > 0);
      const futRows = futs.filter((r) => r.underlying === u);
      facts.set(u, {
        kind,
        exchange: opts[0]?.exchange ?? exchange,
        spot: spot?.canonical ?? null,
        name: spot?.name ? String(spot.name).replace(/\s*\(Demo\)$/, "") : null,
        hasOptions: opts.length > 0,
        expiries,
        nearest,
        lot: lot ?? modalLot(futRows),
        tickSize: ticks.length ? Math.max(...ticks) : null,
        strikeStep: strikeStepOf(near.map((r) => r.strike)),
        strikes: new Set(near.map((r) => r.strike)).size,
        adjusted: near.filter((r) => lot !== null && r.lotSize !== lot).map((r) => ({ symbol: r.canonical, lot: r.lotSize, reason: `lot differs from the series lot ${lot} (inferred)` })),
        perExpiry: expiries.map((e) => {
          const rows = opts.filter((r) => r.expiry === e);
          const t = rows.map((r) => r.tickSize).filter((x) => Number.isFinite(x) && x > 0);
          return { date: e, lot: modalLot(rows), strikeStep: strikeStepOf(rows.map((r) => r.strike)), strikes: new Set(rows.map((r) => r.strike)).size, tickSize: t.length ? Math.max(...t) : null };
        }),
      });
    }
    return facts;
  }

  async function build() {
    const t = now();
    const masters = await masterFacts();
    let ref = null;
    try {
      ref = reference ? reference.universe({ kind: "all" }) : null;
    } catch {
      ref = null;
    }
    const merged = mergeUniverse(ref, masters, { indices: cfg.universe.indices });
    let inferred = new Set();
    try {
      inferred = new Set((reference?.corporateActions?.({ origin: "inferred" }) ?? []).filter((a) => a.nonStandard || a.quality === "inferred").map((a) => a.symbol));
    } catch {
      inferred = new Set();
    }
    const eventCount = new Map();
    try {
      const ev = await reference?.events?.({ days: 7 });
      for (const e of Array.isArray(ev) ? ev : ev?.items ?? []) {
        const u = e.underlying ?? e.symbol;
        if (u) eventCount.set(u, (eventCount.get(u) ?? 0) + 1);
      }
    } catch {
      // events unknown: 0
    }
    const stocks = merged.stocks.slice(0, cfg.universe.maxStocks);
    const items = [];
    const make = async (u, kind) => {
      const m = masters.get(u) ?? {};
      let lot = m.lot ?? null;
      let nextLot = null;
      if (reference && m.nearest) {
        try {
          const lf = await reference.lotFor(u, m.nearest, { exchange: m.exchange });
          lot = lf?.lot ?? lot;
          const next = m.expiries?.[1] ? await reference.lotFor(u, m.expiries[1], { exchange: m.exchange }) : null;
          if (kind === "stock") nextLot = { lot: next?.lot ?? lot, from: lf?.effectiveFrom ?? next?.effectiveFrom ?? null };
        } catch {
          // master lot stands
        }
      }
      let freezeQty = null;
      if (reference?.freezeFor && m.nearest) {
        try {
          const sample = (await symbols?.search({ q: u, underlying: u, kind: "FUT", limit: 1 }))?.items?.[0]?.canonical;
          freezeQty = sample ? (await reference.freezeFor(sample))?.freezeQty ?? null : null;
        } catch {
          freezeQty = null;
        }
      }
      return {
        underlying: u,
        name: m.name ?? u,
        kind,
        exchange: m.exchange ?? "NFO",
        spot: m.spot ?? `${m.exchange === "BFO" ? "BSE" : "NSE"}:${u}`,
        settlement: settlementOf(kind),
        lot,
        nextLot,
        tickSize: m.tickSize ?? null,
        strikeStep: m.strikeStep ?? null,
        freezeQty,
        weekly: hasWeekly(m.expiries),
        events: eventCount.get(u) ?? 0,
        nonStandard: inferred.has(u) || (m.adjusted?.length ?? 0) > 0,
      };
    };
    const indexItems = [];
    for (const u of merged.indices) indexItems.push(await make(u, "index"));
    items.push(...orderIndices(indexItems));
    for (const u of stocks) items.push(await make(u, "stock"));
    built = {
      at: t,
      source: { universe: merged.source === "reference" ? `reference:${ref?.source === "demo" ? "demo" : "fo_mktlots"}` : "masters", knownSince: merged.source === "reference" ? ref?.knownSince ?? null : null, masters: (() => {
        try {
          return (symbols?.status?.()?.brokers ?? []).map((b) => b.broker);
        } catch {
          return [];
        }
      })(), ...(merged.source === "masters" ? { note: "membership history not recorded" } : {}) },
      items,
      masters,
      missingAtBroker: merged.missingAtBroker,
    };
    builtAt = t;
    dirty = false;
    return built;
  }

  async function ensure() {
    if (built && !dirty && now() - builtAt < REBUILD_MS) return built;
    if (!building) {
      building = build().finally(() => {
        building = null;
      });
    }
    // A stale list is still served while the next one builds (never block a page on a rebuild).
    if (built) {
      building.catch(() => {});
      return built;
    }
    return building;
  }

  /** The ban band right now (reference, plus any demo override). */
  function banFor(u) {
    let st = null;
    try {
      st = reference?.banStatus?.(u) ?? null;
    } catch {
      st = null;
    }
    const o = deps.banOverride?.();
    if (o && o.symbols.has(u)) return { ...(st ?? {}), inBan: true, band: "ban", available: true, forDate: st?.forDate ?? istDate(now()), asOf: st?.asOf ?? istDate(now()), source: "demo-override", mwplPct: st?.mwplPct ?? null };
    return st;
  }

  const withLive = (item) => ({ ...item, ban: banOf(item.kind, banFor(item.underlying)), sweep: deps.coverageFor?.(item.underlying) ?? { covered: false, method: null } });

  return {
    /** Mark the list for a rebuild (reference.updated, master reload). */
    invalidate() {
      dirty = true;
    },
    ensure,
    banFor,
    /** The list (§3.3) with live ban bands and sweep coverage. */
    async list({ kind = "all" } = {}) {
      const b = await ensure();
      const items = b.items.filter((i) => kind === "all" || i.kind === kind).map(withLive);
      const all = b.items.map(withLive);
      return {
        asOf: toIstIso(b.at),
        source: b.source,
        counts: { index: all.filter((i) => i.kind === "index").length, stock: all.filter((i) => i.kind === "stock").length, inBan: all.filter((i) => i.ban?.inBan === true).length, missingAtBroker: b.missingAtBroker.length },
        items,
      };
    },
    /** One item with expiries, adjusted contracts and rules (§3.4); SYMBOL_NOT_FOUND when unknown. */
    async detail(underlying) {
      const b = await ensure();
      const item = b.items.find((i) => i.underlying === underlying);
      if (!item) throw new BridgeError("SYMBOL_NOT_FOUND", `${underlying} is not in the F&O list (reference universe or instrument masters).`);
      const m = b.masters.get(underlying) ?? {};
      return { item: withLive(item), facts: m };
    },
    /** Names of the stocks / indices in the list. */
    async names() {
      const b = await ensure();
      return { indices: b.items.filter((i) => i.kind === "index").map((i) => i.underlying), stocks: b.items.filter((i) => i.kind === "stock").map((i) => i.underlying) };
    },
    /** Master facts of one underlying (expiries, nearest, lot, step), or null. */
    async facts(underlying) {
      const b = await ensure();
      return b.masters.get(underlying) ?? null;
    },
  };
}


/** Edit distance ≤ 1 counting an adjacent swap as one edit (optimal string alignment), for short strings. */
function withinOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= 1;
}

/** Match score of one item for an uppercased query (§6.12); 0 = excluded. */
export function matchScore(item, t) {
  const sym = String(item.underlying ?? "").toUpperCase();
  const name = String(item.name ?? "").toUpperCase();
  if (!t) return 1;
  if (sym === t) return 100;
  if (sym.startsWith(t)) return 70;
  if (name.split(/[^A-Z0-9&]+/).some((w) => w && w.startsWith(t))) return 50;
  if (sym.includes(t)) return 40;
  if (name.includes(t)) return 30;
  if (t.length >= 4 && withinOne(sym.slice(0, t.length), t)) return 15;
  return 0;
}

/**
 * Rank underlyings for a query (docs/spec/p1-06-stocks.md §6.12): score, then indices, then underlyings in positions,
 * then recent ones, then alphabetical. Items scoring 0 are left out.
 * @param {Array<{ underlying: string, name?: string, kind?: string }>} list
 * @param {string} q
 * @param {{ recent?: string[], held?: string[] }} [o]
 */
export function rankUnderlyings(list, q, { recent = [], held = [] } = {}) {
  const t = String(q ?? "").trim().toUpperCase();
  const r = new Set(recent);
  const h = new Set(held);
  return list
    .map((item) => ({ item, s: matchScore(item, t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(b.item.kind === "index") - Number(a.item.kind === "index") || Number(h.has(b.item.underlying)) - Number(h.has(a.item.underlying)) || Number(r.has(b.item.underlying)) - Number(r.has(a.item.underlying)) || (a.item.underlying < b.item.underlying ? -1 : a.item.underlying > b.item.underlying ? 1 : 0))
    .map((x) => x.item);
}
