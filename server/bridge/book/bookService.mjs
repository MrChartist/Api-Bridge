/**
 * The unified and family book (stream S27, F2/F11; docs/spec/p1-12-guard-participants.md §3.6, §4.3).
 *
 *   GET /v1/book?view=family
 *     visible accounts (key filter) → holderOf(account) → tags (config > holders.json)
 *     ├─ per account, in parallel (allSettled, 5 s each): orders.positions + orders.funds (cached cacheSeconds)
 *     ├─ per holder: price source (pricing.mjs, the pricing wall) → one quotes batch for spots and legs → priceLeg
 *     └─ book-core.aggregate(): holders[], family, outsideFamily, totals, notes
 *
 * Read-only: nothing here can place, modify or cancel an order (grep test). Per-account failures never fail the whole
 * response; they appear in accounts[].error. Exits always go to a leg's own account (the dashboard opens the ticket
 * with that account preset).
 */
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { aggregate, markOf, priceHolder, priceLeg } from "../dashboard/book-core.js";
import { volTime } from "../dashboard/pricing.js";
import { accountFilter } from "../safety/routes.mjs";
import { toIstIso } from "../symbols/ist.mjs";
import { kindOf, pricingContext } from "../vol/context.mjs";
import { bookConfig } from "./config.mjs";
import { holderOf, tagOf, inFamily, defaultLabel } from "./family.mjs";
import { priceSourceFor, readOptionsFor } from "./pricing.mjs";

const INDEX_SPOT = Object.freeze({ NIFTY: "NSE:NIFTY", BANKNIFTY: "NSE:BANKNIFTY", FINNIFTY: "NSE:FINNIFTY", MIDCPNIFTY: "NSE:MIDCPNIFTY", NIFTYNXT50: "NSE:NIFTYNXT50", SENSEX: "BSE:SENSEX", BANKEX: "BSE:BANKEX", SENSEX50: "BSE:SENSEX50" });
/** The spot symbol an underlying is priced from: its index, else the NSE (BFO: BSE) cash symbol. */
export const spotSymbolOf = (underlying, exchange) => INDEX_SPOT[underlying] ?? `${exchange === "BFO" ? "BSE" : "NSE"}:${underlying}`;

const READ_TIMEOUT_MS = 5000;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new BridgeError("UPSTREAM_TIMEOUT", `${what} took longer than ${ms / 1000} s.`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** A position row's symbol parts, or null for anything that is not a Bridge symbol. */
const parsed = (sym) => {
  try {
    return parseSymbol(String(sym ?? ""));
  } catch {
    return null;
  }
};

const errorOf = (err) => ({ code: err?.code ?? "INTERNAL", message: String(err?.message ?? "Could not read this account.").slice(0, 300) });

/**
 * @param {{ config: any, orders: any, marketData: any, accounts: any, symbols?: any, reference?: any,
 *   holderTags: () => Record<string, { relationship: string, label?: string }>, clock?: { now(): number }, logger?: any }} deps
 */
export function createBookService(deps) {
  const { config, orders, marketData, accounts } = deps;
  const now = () => deps.clock?.now?.() ?? Date.now();
  const book = () => bookConfig(config);
  /** "<account>|<mode>" -> { at, positions: Promise, funds: Promise } */
  const cache = new Map();
  const lots = new Map();

  function cachedRead(ctx, accountId, mode) {
    const key = `${accountId}|${mode}`;
    const ttl = book().cacheSeconds * 1000;
    const hit = cache.get(key);
    const t = now();
    if (hit && t - hit.at < ttl) return hit;
    const entry = {
      at: t,
      positions: withTimeout(Promise.resolve().then(() => orders.positions(ctx, accountId, { mode })), READ_TIMEOUT_MS, "Reading positions"),
      funds: withTimeout(Promise.resolve().then(() => orders.funds(ctx, accountId, { mode })), READ_TIMEOUT_MS, "Reading funds"),
    };
    // A failed read is not kept: the next request asks again.
    Promise.allSettled([entry.positions, entry.funds]).then((r) => {
      if (r.some((x) => x.status === "rejected") && cache.get(key) === entry) cache.delete(key);
    });
    entry.positions.catch(() => {});
    entry.funds.catch(() => {});
    cache.set(key, entry);
    return entry;
  }

  async function lotOf(symbol) {
    if (lots.has(symbol)) return lots.get(symbol);
    let lot = null;
    try {
      const r = await deps.symbols?.resolve?.(symbol);
      lot = num(r?.lotSize);
    } catch {
      lot = null;
    }
    lots.set(symbol, lot);
    return lot;
  }

  /** The accounts this request covers, after checking any named ones. */
  function accountsFor(ctx, requested, mode) {
    const all = (config.accounts ?? []).filter((a) => a.enabled !== false);
    const canSee = accountFilter(ctx);
    for (const id of requested) {
      if (!all.some((a) => a.id === id)) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${id}" in bridge.config.json.`);
      if (!canSee(id)) throw new BridgeError("ACCOUNT_FORBIDDEN", `This API key may not use account ${id}.`);
    }
    let list = all.filter((a) => canSee(a.id));
    const partial = list.length < all.length || (requested.length > 0 && requested.length < list.length);
    if (requested.length) list = list.filter((a) => requested.includes(a.id));
    if (mode === "live") list = list.filter((a) => a.broker !== "paper");
    const max = book().maxAccounts;
    if (list.length > max) throw new BridgeError("VALIDATION_FAILED", `The book reads at most ${max} accounts (book.maxAccounts); name fewer with account=.`);
    return { list, all, canSee, partial };
  }

  /** Read mode for one account: paper accounts are paper; others are live unless the request says paper. */
  const modeFor = (a, mode) => (a.broker === "paper" || mode === "paper" ? "paper" : "live");

  /**
   * GET /v1/book.
   * @param {object} ctx  request context
   * @param {{ view?: "holders"|"family", underlying?: string|null, accounts?: string[], mode?: "live"|"paper"|"all" }} q
   */
  async function read(ctx, { view = "holders", underlying = null, accounts: requested = [], mode = "all" } = {}) {
    const cfg = book();
    const tags = deps.holderTags?.() ?? {};
    const { list, all, canSee, partial } = accountsFor(ctx, requested, mode);
    const summaries = new Map();
    try {
      for (const s of accounts.list()) summaries.set(s.id, s);
    } catch {
      // no summaries: every holder falls back to broker-reported figures or the paper source
    }
    const t = now();

    // Holders in config order of their first visible account.
    const holders = new Map();
    for (const a of list) {
      const h = holderOf(config, a);
      if (!holders.has(h)) holders.set(h, []);
      holders.get(h).push(a);
    }

    // Positions and funds for every account at once.
    const reads = new Map();
    await Promise.all(
      list.map(async (a) => {
        const m = modeFor(a, mode);
        const e = cachedRead(ctx, a.id, m);
        const [p, f] = await Promise.allSettled([e.positions, e.funds]);
        reads.set(a.id, { mode: m, positions: p, funds: f });
      }),
    );

    const ctxCache = new Map();
    const clockCtx = (exchange, u) => {
      const k = `${exchange}|${kindOf(u)}`;
      if (!ctxCache.has(k)) ctxCache.set(k, pricingContext({ config, reference: deps.reference, exchange, kind: kindOf(u), now: t }));
      return ctxCache.get(k);
    };

    const priced = [];
    for (const [holder, accs] of holders) {
      const tag = tagOf(config, tags, holder);
      const label = tag.label ?? defaultLabel(holder, tag.relationship);
      const holderAll = all.filter((a) => holderOf(config, a) === holder);
      const source = priceSourceFor(holderAll, { summaries, canSee, label });
      const accountRows = [];
      const legsByU = new Map();
      for (const a of accs) {
        const r = reads.get(a.id);
        const s = summaries.get(a.id);
        const base = { account: a.id, broker: a.broker, label: a.label ?? s?.label ?? a.id, mode: r.mode, tags: [tag.relationship ?? "untagged", r.mode] };
        if (r.positions.status === "rejected") {
          accountRows.push({ ...base, positions: 0, margin: null, error: errorOf(r.positions.reason) });
          continue;
        }
        const fundsRes = r.funds.status === "fulfilled" ? r.funds.value : null;
        const f = fundsRes?.funds ?? null;
        const margin = f ? { used: num(f.usedMargin), available: num(f.availableCash), asOf: fundsRes.freshness?.asOf ?? toIstIso(t), source: r.mode === "paper" ? "paper" : "broker" } : null;
        let closedRealised = 0;
        for (const row of r.positions.value?.items ?? []) {
          const p = parsed(row.symbol);
          if (!p || !cfg.exchanges.includes(p.exchange) || (p.kind !== "OPT" && p.kind !== "FUT")) continue;
          if (underlying && p.underlying !== underlying) continue;
          const q = num(row.netQty) ?? 0;
          if (!q) {
            closedRealised += num(row.realisedPnl) ?? num(row.pnl) ?? 0;
            continue;
          }
          if (!legsByU.has(p.underlying)) legsByU.set(p.underlying, { exchange: p.exchange, legs: [] });
          legsByU.get(p.underlying).legs.push({
            account: a.id,
            symbol: p.canonical,
            kind: p.kind,
            right: p.right,
            strike: p.strike,
            expiry: p.expiry,
            product: typeof row.product === "string" ? row.product : null,
            q,
            avg: num(row.avgPrice),
            ltp: num(row.ltp),
            realised: num(row.realisedPnl),
            brokerPnl: num(row.pnl),
          });
        }
        accountRows.push({ ...base, margin, closedRealised, error: null });
      }

      // One quotes batch per holder, through the holder's own source only.
      const opts = readOptionsFor(source);
      const spotSyms = [...legsByU.entries()].map(([u, v]) => spotSymbolOf(u, v.exchange));
      const legSyms = [...legsByU.values()].flatMap((v) => v.legs.map((l) => l.symbol));
      const quotes = new Map();
      if (opts && (spotSyms.length || legSyms.length)) {
        try {
          const res = await withTimeout(Promise.resolve().then(() => marketData.quotes([...new Set([...spotSyms, ...legSyms])], opts)), READ_TIMEOUT_MS, "Reading quotes");
          for (const it of res?.items ?? []) quotes.set(it.symbol, it);
        } catch (err) {
          deps.logger?.debug?.("book quotes failed", { holder, code: err?.code ?? "ERROR" });
        }
      }

      const underlyings = [];
      for (const [u, v] of [...legsByU.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const spotQ = quotes.get(spotSymbolOf(u, v.exchange));
        const spot = source.kind === "none" ? null : num(spotQ?.ltp);
        const lot = await lotOf(v.legs[0].symbol);
        const cctx = clockCtx(v.exchange, u);
        const rate = num(cctx?.rate?.value) ?? 0;
        const legs = v.legs.map((l) => {
          const q = quotes.get(l.symbol);
          const m = source.kind === "none" ? { mark: null, basis: null } : markOf(q);
          // A missing quote falls back to the position row's own LTP (same account, so the wall holds).
          const mark = m.mark ?? (source.kind === "none" ? null : l.ltp);
          const markSource = m.basis ?? (mark !== null ? "position" : null);
          let env = null;
          if (l.kind === "OPT" && l.expiry) {
            const vt = volTime(cctx, t, l.expiry);
            env = vt ? { spot, T: vt.T, Tcal: vt.Tcal, rate, yearBasis: vt.yearBasis } : null;
          }
          const p = source.kind === "none" ? { iv: null, greeks: null } : priceLeg({ ...l, mark }, env ?? { spot });
          const { ltp: _ltp, ...rest } = l;
          return { ...rest, mark: mark === null ? null : Math.round(mark * 100) / 100, markSource, bid: source.kind === "none" ? null : num(q?.bid), ask: source.kind === "none" ? null : num(q?.ask), iv: p.iv === null ? null : Math.round(p.iv * 100) / 100, greeks: roundGreeks(p.greeks), guarded: [] };
        });
        underlyings.push({ underlying: u, spot, lot, legs });
      }
      const priceSource = source.kind === "account" ? { kind: "account", broker: source.broker, account: source.accountId } : source.kind === "paper" ? { kind: "paper" } : { kind: "none", code: source.code, reason: source.reason };
      priced.push(priceHolder({ holder, label, relationship: tag.relationship, inFamily: inFamily(config, tag.relationship), tagSource: tag.source, priceSource, accounts: accountRows, underlyings }));
    }

    return aggregate(priced, { view, family: cfg.family, partial, asOf: toIstIso(t) });
  }

  return { read, clearCache: () => cache.clear() };
}

function roundGreeks(g) {
  if (!g) return null;
  const r = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
  return { delta: r(g.delta, 4), gamma: r(g.gamma, 6), theta: r(g.theta, 4), vega: r(g.vega, 4) };
}

/** CSV rows for GET /v1/book?format=csv: one row per leg, with its holder and account. */
export function bookCsv(body) {
  const rows = [["holder", "relationship", "inFamily", "account", "underlying", "symbol", "qty", "avg", "mark", "markSource", "pnl", "iv", "delta", "gamma", "theta", "vega"]];
  for (const h of body.holders) {
    for (const u of h.underlyings) {
      for (const l of u.legs) {
        rows.push([h.label, h.relationship ?? "", h.inFamily ? "yes" : "no", l.account, u.underlying, l.symbol, l.q, l.avg, l.mark, l.markSource ?? "", l.pnl, l.iv, l.greeks?.delta ?? "", l.greeks?.gamma ?? "", l.greeks?.theta ?? "", l.greeks?.vega ?? ""]);
      }
    }
  }
  return rows;
}
