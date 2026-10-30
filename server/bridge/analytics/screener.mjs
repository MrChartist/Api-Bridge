/**
 * Contract screener (stream S15). Read-only: filters and sorts every option contract in one to five chains.
 *
 *   GET /v1/analytics/screener?underlyings=NIFTY[,..]&expiry=&type=call|put|both&minDelta=&maxDelta=&minIv=&maxIv=
 *       &minOi=&minVolume=&minPremium=&maxPremium=&minDte=&maxDte=&maxSpreadPct=&moneyness=itm|atm|otm|any
 *       &sort=oi|volume|iv|delta|premium|theta|ltp|spread&dir=asc|desc&limit=
 *   GET /v1/analytics/screener/presets      six ready-made query strings
 *
 * Conventions: delta filters and sort use |delta| (so puts and calls compare); minPremium/maxPremium bound the option
 * price (ltp, INR per unit); sort=premium orders by premium traded (ltp x volume in units, INR); sort=theta orders by
 * theta as a percent of premium per day. A contract missing a field cannot pass a filter on that field and sorts last.
 */
import { BridgeError } from "../core/errors.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { expiryCutoffMs, nowMsOf, unitMultiplier, upcomingExpiries } from "./math.mjs";

export const MAX_UNDERLYINGS = 5;
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;
const SORTS = { oi: "oi", volume: "volume", iv: "iv", delta: "absDelta", premium: "premiumTraded", theta: "thetaPctPerDay", ltp: "ltp", spread: "spreadPct" };
/** A contract is "liquid" when it has this much open interest and volume and a spread no wider than LIQUID_SPREAD_PCT. */
export const LIQUID = { minOi: 1000, minVolume: 100, maxSpreadPct: 5 };

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });
const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v.trim() === "" ? undefined : v.trim();
};
const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** Strict decimal: digits with optional sign and fraction only. No NaN, Infinity, hex, exponent or blanks. */
function numParam(q, name, min, max) {
  const v = opt(q, name);
  if (v === undefined) return undefined;
  const n = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(name, `${name} must be a number from ${min} to ${max}.`);
  return n;
}
function pair(f, lo, hi) {
  if (f[lo] !== undefined && f[hi] !== undefined && f[lo] > f[hi]) throw invalid(lo, `${lo} must not be greater than ${hi}.`);
}
function oneOf(q, name, allowed, dflt) {
  const v = (opt(q, name) ?? dflt).toLowerCase();
  if (!allowed.includes(v)) throw invalid(name, `${name} must be one of ${allowed.join(", ")}.`);
  return v;
}

/** Validate the query string into a normalised request. Throws VALIDATION_FAILED. */
export function parseScreenerQuery(q) {
  const raw = opt(q, "underlyings") ?? opt(q, "underlying");
  if (!raw) throw invalid("underlyings", "underlyings is required, for example NIFTY or NIFTY,BANKNIFTY.");
  const underlyings = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!underlyings.length) throw invalid("underlyings", "underlyings is required, for example NIFTY or NIFTY,BANKNIFTY.");
  if (underlyings.length > MAX_UNDERLYINGS) throw invalid("underlyings", `Give at most ${MAX_UNDERLYINGS} underlyings.`);
  for (const u of underlyings) if (!/^[A-Z0-9&_-]{1,30}$/.test(u)) throw invalid("underlyings", `"${u}" is not a valid underlying name.`);
  const expiry = opt(q, "expiry");
  if (expiry !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`)))) throw invalid("expiry", "expiry must be YYYY-MM-DD.");
  const type = oneOf(q, "type", ["call", "put", "both"], "both");
  const moneyness = oneOf(q, "moneyness", ["itm", "atm", "otm", "any"], "any");
  const sort = oneOf(q, "sort", Object.keys(SORTS), "oi");
  const dir = oneOf(q, "dir", ["asc", "desc"], "desc");
  const limitRaw = opt(q, "limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT) throw invalid("limit", `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    limit = Number(limitRaw);
  }
  const f = {
    minDelta: numParam(q, "minDelta", 0, 1),
    maxDelta: numParam(q, "maxDelta", 0, 1),
    minIv: numParam(q, "minIv", 0, 1000),
    maxIv: numParam(q, "maxIv", 0, 1000),
    minOi: numParam(q, "minOi", 0, 1e12),
    minVolume: numParam(q, "minVolume", 0, 1e12),
    minPremium: numParam(q, "minPremium", 0, 1e9),
    maxPremium: numParam(q, "maxPremium", 0, 1e9),
    minDte: numParam(q, "minDte", 0, 3650),
    maxDte: numParam(q, "maxDte", 0, 3650),
    maxSpreadPct: numParam(q, "maxSpreadPct", 0, 1000),
  };
  pair(f, "minDelta", "maxDelta");
  pair(f, "minIv", "maxIv");
  pair(f, "minPremium", "maxPremium");
  pair(f, "minDte", "maxDte");
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return { underlyings, expiry, type, moneyness, sort, dir, limit, filters: f };
}

/** Computed screener fields for one leg. `ctx` = { underlying, expiry, spot, atm, lotSize, dte }. */
export function contractRow(leg, right, strike, c) {
  const ltp = num(leg.ltp);
  const bid = num(leg.bid);
  const ask = num(leg.ask);
  const oi = num(leg.oi);
  const volume = num(leg.volume);
  const delta = num(leg.delta);
  const theta = num(leg.theta);
  const isCall = right === "CE";
  const spot = c.spot;
  const itmPct = spot > 0 ? ((isCall ? spot - strike : strike - spot) / spot) * 100 : null;
  const moneyness = spot > 0 ? (strike === c.atm || (c.atm === null && Math.abs(itmPct) < 0.1) ? "atm" : itmPct > 0 ? "itm" : "otm") : null;
  const breakeven = ltp === null ? null : isCall ? strike + ltp : strike - ltp;
  const spreadPct = bid > 0 && ask > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
  const lot = c.lotSize > 0 ? c.lotSize : null;
  const premiumTraded = ltp !== null && volume !== null ? ltp * volume * (c.units === "lots" ? (lot ?? 1) : 1) : null;
  const thetaPct = theta !== null && ltp > 0 ? (Math.abs(theta) / ltp) * 100 : null;
  const liquid = oi >= LIQUID.minOi && volume >= LIQUID.minVolume && spreadPct !== null && spreadPct <= LIQUID.maxSpreadPct;
  return {
    symbol: leg.symbol ?? null,
    underlying: c.underlying,
    expiry: c.expiry,
    type: isCall ? "call" : "put",
    strike,
    dte: round(c.dte, 2),
    spot,
    ltp,
    bid,
    ask,
    oi,
    oiChange: num(leg.oiChange),
    volume,
    iv: num(leg.iv),
    delta,
    gamma: num(leg.gamma),
    theta,
    vega: num(leg.vega),
    lotSize: lot,
    moneyness,
    moneynessPct: round(itmPct, 2),
    premiumTraded: round(premiumTraded, 0),
    premiumTradedAssumesLot1: premiumTraded !== null && lot === null,
    breakeven: round(breakeven, 2),
    breakevenPct: breakeven !== null && spot > 0 ? round(((breakeven - spot) / spot) * 100, 2) : null,
    probItm: delta === null ? null : round(Math.abs(delta), 3),
    thetaPctPerDay: round(thetaPct, 2),
    spreadPct: round(spreadPct, 2),
    liquid,
  };
}

/** True when the row passes every filter. A null field never passes a filter that needs it. */
export function passes(row, req) {
  const f = req.filters;
  const within = (v, lo, hi) => (lo === undefined && hi === undefined) || (v !== null && (lo === undefined || v >= lo) && (hi === undefined || v <= hi));
  if (req.type !== "both" && row.type !== req.type) return false;
  if (req.moneyness !== "any" && row.moneyness !== req.moneyness) return false;
  if (!within(row.probItm, f.minDelta, f.maxDelta)) return false;
  if (!within(row.iv, f.minIv, f.maxIv)) return false;
  if (!within(row.oi, f.minOi, undefined)) return false;
  if (!within(row.volume, f.minVolume, undefined)) return false;
  if (!within(row.ltp, f.minPremium, f.maxPremium)) return false;
  if (!within(row.dte, f.minDte, f.maxDte)) return false;
  if (!within(row.spreadPct, undefined, f.maxSpreadPct)) return false;
  return true;
}

const SORT_FIELD = { oi: "oi", volume: "volume", iv: "iv", delta: "probItm", premium: "premiumTraded", theta: "thetaPctPerDay", ltp: "ltp", spread: "spreadPct" };

/** Sort rows by the requested key; missing values always last; ties broken by underlying, expiry, strike, type. */
export function sortRows(rows, sort, dir) {
  const key = SORT_FIELD[sort];
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
    if (x !== null && x !== y) return (x - y) * sign;
    return a.underlying.localeCompare(b.underlying) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.type.localeCompare(b.type);
  });
}

/** Every contract in a chain as screener rows (before filtering). */
export function chainContracts(chain, { underlying, expiry, nowMs }) {
  const spot = num(chain?.underlyingLtp);
  const atm = num(chain?.atmStrike);
  const c = { underlying, expiry, spot: spot > 0 ? spot : null, atm, lotSize: num(chain?.lotSize), units: chain?.units ?? "units", dte: Math.max(0, (expiryCutoffMs(expiry) - nowMs) / DAY_MS) };
  const out = [];
  for (const r of Array.isArray(chain?.rows) ? chain.rows : []) {
    if (r.ce) out.push(contractRow(r.ce, "CE", r.strike, c));
    if (r.pe) out.push(contractRow(r.pe, "PE", r.strike, c));
  }
  return { rows: out, spot: c.spot, atmStrike: atm, lotSize: c.lotSize };
}

const q = (o) => new URLSearchParams(o).toString();
/** Six ready-made screens. `query` is the query string to append to /v1/analytics/screener?. */
export const PRESETS = [
  { id: "high-iv-puts", name: "High-IV puts", description: "OTM puts with implied volatility of 20 or more and real open interest, richest IV first.", query: q({ underlyings: "NIFTY", type: "put", moneyness: "otm", minIv: 20, minOi: 5000, sort: "iv", dir: "desc", limit: 25 }) },
  { id: "liquid-atm-weeklies", name: "Liquid ATM weeklies", description: "At-the-money contracts expiring within 7 days with heavy volume and open interest.", query: q({ underlyings: "NIFTY,BANKNIFTY", moneyness: "atm", maxDte: 7, minOi: 50000, minVolume: 1000, sort: "volume", dir: "desc", limit: 20 }) },
  { id: "cheap-otm-lottery", name: "Cheap OTM lottery", description: "Out-of-the-money options under Rs 10 with a delta of 0.15 or less that still trade actively.", query: q({ underlyings: "NIFTY", moneyness: "otm", maxPremium: 10, minPremium: 0.5, maxDelta: 0.15, minVolume: 500, maxDte: 7, sort: "volume", dir: "desc", limit: 25 }) },
  { id: "high-theta-sellers", name: "High-theta sellers", description: "Mid-delta contracts with 1 to 7 days left, ranked by daily time decay as a percent of premium.", query: q({ underlyings: "NIFTY,BANKNIFTY", minDelta: 0.15, maxDelta: 0.35, minDte: 1, maxDte: 7, minOi: 10000, sort: "theta", dir: "desc", limit: 25 }) },
  { id: "big-oi-walls", name: "Big OI walls", description: "The largest open-interest strikes on the out-of-the-money side: likely support and resistance.", query: q({ underlyings: "NIFTY", moneyness: "otm", minOi: 100000, sort: "oi", dir: "desc", limit: 20 }) },
  { id: "tight-spreads", name: "Tight spreads", description: "Active contracts with a bid-ask spread of 1 percent or less, tightest first.", query: q({ underlyings: "NIFTY,BANKNIFTY", minOi: 10000, minVolume: 500, maxSpreadPct: 1, sort: "spread", dir: "asc", limit: 25 }) },
];

/** @param {object} deps full deps (needs marketData) */
export function screenerRoutes(deps) {
  const md = () => deps.marketData;
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });
  const errOf = (underlying, err) => ({ underlying, code: err?.code ?? "INTERNAL", message: err?.detail ?? err?.message ?? "screener read failed" });

  async function load(underlying, req, opts, nowMs) {
    let expiry = req.expiry;
    if (!expiry) {
      const list = await md().expiries(underlying, opts);
      expiry = upcomingExpiries(list.expiries, nowMs)[0];
      if (!expiry) throw new BridgeError("NOT_FOUND", `${underlying} has no upcoming expiry.`);
    }
    const chain = await md().optionChain({ underlying, expiry, greeks: true }, opts);
    return { expiry, chain, ...chainContracts(chain, { underlying, expiry, nowMs }) };
  }

  return [
    [
      "GET",
      "/v1/analytics/screener/presets",
      { scope: "read" },
      async (ctx) => ({ data: { path: "/v1/analytics/screener", presets: PRESETS.map((p) => ({ ...p, path: `/v1/analytics/screener?${p.query}` })) }, meta: { requestId: ctx.requestId } }),
    ],
    [
      "GET",
      "/v1/analytics/screener",
      { scope: "read" },
      async (ctx) => {
        const req = parseScreenerQuery(ctx.query);
        const opts = readOptions(ctx);
        const nowMs = nowMsOf(deps);
        const settled = await Promise.all(req.underlyings.map((u) => load(u, req, opts, nowMs).then((r) => ({ u, r }), (err) => ({ u, err }))));
        const errors = [];
        const sources = [];
        let all = [];
        let freshness;
        for (const s of settled) {
          if (s.err) {
            errors.push(errOf(s.u, s.err));
            continue;
          }
          freshness ??= s.r.chain.freshness;
          sources.push({ underlying: s.u, expiry: s.r.expiry, spot: s.r.spot, atmStrike: s.r.atmStrike, lotSize: s.r.lotSize, contracts: s.r.rows.length });
          all = all.concat(s.r.rows);
        }
        const matchedRows = sortRows(all.filter((r) => passes(r, req)), req.sort, req.dir);
        const rows = matchedRows.slice(0, req.limit);
        const data = {
          filters: { type: req.type, moneyness: req.moneyness, ...req.filters },
          sort: req.sort,
          dir: req.dir,
          limit: req.limit,
          scanned: all.length,
          matched: matchedRows.length,
          returned: rows.length,
          sources,
          rows,
        };
        return { data, errors, meta: { requestId: ctx.requestId, accountId: opts.accountId ?? null, ...(freshness ? { freshness } : {}) } };
      },
    ],
  ];
}
