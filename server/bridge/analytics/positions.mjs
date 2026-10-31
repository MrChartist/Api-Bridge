/**
 * Position-centric analytics for stream S15 (docs: analytics/positions.openapi.yaml). Read-only and plan-only:
 * nothing here places, changes or cancels an order.
 *
 *   POST /v1/analytics/lot-split                 slices a quantity under the exchange freeze limit; PLAN ONLY
 *   GET  /v1/analytics/position-greeks?account=  per-position and net Greeks, delta-adjusted exposure, per-underlying rollup
 *
 * lot-split returns the child-order quantities (and an optional iceberg schedule) for the caller to send, one by one,
 * through POST /v1/orders, so every safety gate (mode, limits, tickets, idempotency) still applies to each slice.
 * position-greeks reads positions through deps.orders (which enforces account access) and chains through marketData.
 */
import { z } from "zod";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { freezeEntryFor } from "../symbols/freezeQuantities.mjs";
import { ACCOUNT_RE } from "../orders/orderValidation.mjs";
import { autoBackupFor, readOptionsBase } from "../market/routes.mjs";
import { computeIVAndGreeks, daysBetween } from "../../lib/blackScholes.mjs";
import { pinMarketRead } from "./math.mjs";

export const MAX_SLICES = 500;

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

function parseBody(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const errors = r.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
  throw new BridgeError("VALIDATION_FAILED", `The request is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
}

const lotSplitBody = z
  .strictObject({
    symbol: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(100_000_000),
    lotSize: z.number().int().min(1).max(100_000),
    /** Only used when the built-in table has no entry (stock derivatives); with an entry the lower of the two wins. */
    freezeQty: z.number().int().min(1).max(100_000_000).optional(),
    /** Iceberg: send slices of at most `sliceLots` lots, `delayMs` apart. */
    iceberg: z
      .strictObject({
        sliceLots: z.number().int().min(1).max(100_000).optional(),
        delayMs: z.number().int().min(0).max(3_600_000).default(500),
      })
      .optional(),
  });

/**
 * Pure planner. Slices are lot multiples, each at most the freeze limit, summing to `quantity`.
 * @returns {{ maxLotsPerOrder: number, slices: number[] }}
 */
export function planSlices({ quantity, lotSize, freezeQty, sliceLots }) {
  if (quantity % lotSize !== 0) throw invalid("quantity", `quantity ${quantity} is not a multiple of the lot size ${lotSize}.`);
  const maxLotsPerOrder = Math.floor(freezeQty / lotSize);
  if (maxLotsPerOrder < 1) throw invalid("lotSize", `One lot (${lotSize}) is larger than the freeze quantity (${freezeQty}); check the lot size.`);
  const per = Math.min(maxLotsPerOrder, sliceLots ?? maxLotsPerOrder);
  const totalLots = quantity / lotSize;
  // Count before building: a one-lot slice size on a huge quantity would otherwise allocate millions of slices first.
  const count = Math.ceil(totalLots / per);
  if (count > MAX_SLICES) throw invalid("quantity", `That plan needs ${count} orders; the limit is ${MAX_SLICES}. Split the request.`);
  const slices = [];
  for (let left = totalLots; left > 0; left -= per) slices.push(Math.min(left, per));
  return { maxLotsPerOrder, slices };
}

/** Build the lot-split plan for a validated body. */
export function buildLotSplit(b) {
  let parsed;
  try {
    parsed = parseSymbol(b.symbol);
  } catch (e) {
    throw invalid("symbol", e.message);
  }
  const entry = freezeEntryFor(parsed);
  const warnings = [];
  let freezeQty;
  let source;
  if (entry) {
    freezeQty = b.freezeQty === undefined ? entry.freezeQty : Math.min(entry.freezeQty, b.freezeQty);
    source = b.freezeQty !== undefined && b.freezeQty < entry.freezeQty ? "request (lower than table)" : entry.source;
    if (!entry.verified) warnings.push(`Freeze quantity ${entry.freezeQty} is an unverified snapshot dated ${entry.asOf}; check the current exchange circular. A too-low value only causes extra slicing.`);
  } else if (b.freezeQty !== undefined) {
    freezeQty = b.freezeQty;
    source = "request";
    warnings.push("No built-in freeze quantity for this contract; using the value you sent. Confirm it against the exchange list.");
  } else {
    throw invalid("freezeQty", `No built-in freeze quantity for ${parsed.canonical}; send freezeQty (units).`);
  }
  const { maxLotsPerOrder, slices } = planSlices({ quantity: b.quantity, lotSize: b.lotSize, freezeQty, sliceLots: b.iceberg?.sliceLots });
  if (slices.length > MAX_SLICES) throw invalid("quantity", `That plan needs ${slices.length} orders; the limit is ${MAX_SLICES}. Split the request.`);

  const children = slices.map((lots, i) => ({ index: i, lots, quantity: lots * b.lotSize }));
  const data = {
    planOnly: true,
    symbol: parsed.canonical,
    totalQuantity: b.quantity,
    totalLots: b.quantity / b.lotSize,
    lotSize: b.lotSize,
    freezeQty,
    freezeQtySource: source,
    maxLotsPerOrder,
    needsSplit: children.length > 1,
    orderCount: children.length,
    children,
    note: "Nothing was sent. Place each child through POST /v1/orders (own clientOrderId or Idempotency-Key per child); every safety gate applies to each one.",
  };
  if (b.iceberg) {
    const delayMs = b.iceberg.delayMs;
    data.iceberg = {
      sliceLots: Math.max(...slices),
      sliceQuantity: Math.max(...slices) * b.lotSize,
      delayMs,
      totalDurationMs: delayMs * Math.max(0, children.length - 1),
      schedule: children.map((c) => ({ ...c, sendAfterMs: c.index * delayMs })),
    };
  }
  if (warnings.length) data.warnings = warnings;
  return data;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ZERO = () => ({ delta: 0, gamma: 0, theta: 0, vega: 0, deltaExposure: 0 });
const add = (t, p) => {
  t.delta += p.delta;
  t.gamma += p.gamma;
  t.theta += p.theta;
  t.vega += p.vega;
  t.deltaExposure += p.deltaExposure;
};
const rounded = (t) => ({ delta: r2(t.delta), gamma: r4(t.gamma), theta: r2(t.theta), vega: r2(t.vega), deltaExposure: r2(t.deltaExposure) });

/** Greeks of one leg: the chain's own, else Black-Scholes from the leg's LTP. */
function legGreeks(leg, chain, parsed) {
  if (leg && [leg.delta, leg.gamma, leg.theta, leg.vega].every((v) => Number.isFinite(v))) {
    return { delta: leg.delta, gamma: leg.gamma, theta: leg.theta, vega: leg.vega, iv: Number.isFinite(leg.iv) ? leg.iv : null, source: leg.greeksSource ?? "chain" };
  }
  const spot = chain?.underlyingLtp;
  if (leg && leg.ltp > 0 && spot > 0) {
    const g = computeIVAndGreeks({ ltp: leg.ltp, spot, strike: parsed.strike, daysToExpiry: daysBetween(new Date(), parsed.expiry), type: parsed.right });
    if (g.iv > 0) return { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, iv: g.iv, source: "computed" };
  }
  return null;
}

/**
 * Pure aggregation. `positions` are Bridge Position rows; `chains` maps "UNDERLYING|expiry" to a chain (or null).
 * Per-unit Greeks are multiplied by the signed net quantity (units), so shorts come out negative where they should.
 */
export function aggregatePositionGreeks(positions, chains) {
  const rows = [];
  const skipped = [];
  const total = ZERO();
  const byUnderlying = new Map();
  for (const p of positions) {
    if (!p || !Number.isFinite(p.netQty) || p.netQty === 0) continue;
    let parsed;
    try {
      parsed = parseSymbol(p.symbol);
    } catch {
      skipped.push({ symbol: p.symbol, reason: "symbol is not a Bridge option symbol" });
      continue;
    }
    if (parsed.kind !== "OPT") {
      skipped.push({ symbol: p.symbol, reason: "not an option" });
      continue;
    }
    const chain = chains.get(`${parsed.underlying}|${parsed.expiry}`) ?? null;
    const row = chain?.rows?.find((r) => r.strike === parsed.strike);
    const leg = row ? (parsed.right === "CE" ? row.ce : row.pe) : null;
    const g = legGreeks(leg, chain, parsed);
    const base = { symbol: parsed.canonical, underlying: parsed.underlying, expiry: parsed.expiry, strike: parsed.strike, right: parsed.right, product: p.product, netQty: p.netQty, ltp: leg?.ltp ?? p.ltp ?? null, underlyingLtp: chain?.underlyingLtp ?? null };
    if (!g) {
      rows.push({ ...base, greeksAvailable: false });
      continue;
    }
    const spot = chain?.underlyingLtp ?? null;
    const pos = { delta: g.delta * p.netQty, gamma: g.gamma * p.netQty, theta: g.theta * p.netQty, vega: g.vega * p.netQty, deltaExposure: spot ? g.delta * p.netQty * spot : 0 };
    rows.push({ ...base, greeksAvailable: true, greeksSource: g.source, iv: g.iv, perUnit: { delta: r4(g.delta), gamma: r6(g.gamma), theta: r4(g.theta), vega: r4(g.vega) }, ...rounded(pos), deltaExposure: spot ? r2(pos.deltaExposure) : null });
    add(total, pos);
    const u = byUnderlying.get(parsed.underlying) ?? { underlying: parsed.underlying, spot, positions: 0, totals: ZERO() };
    u.positions += 1;
    u.spot = u.spot ?? spot;
    add(u.totals, pos);
    byUnderlying.set(parsed.underlying, u);
  }
  return {
    positions: rows,
    net: rounded(total),
    byUnderlying: [...byUnderlying.values()].map((u) => ({ underlying: u.underlying, spot: u.spot, positions: u.positions, ...rounded(u.totals) })),
    skipped,
    units: { delta: "underlying units", gamma: "delta change per 1 point, summed over units", theta: "currency per calendar day", vega: "currency per 1 vol point", deltaExposure: "delta x quantity x underlying price (currency)" },
  };
}

/** @param {object} deps full deps passed to register() */
export function positionRoutes(deps) {
  const readOptions = (ctx) => readOptionsBase(ctx, { autoBackup: autoBackupFor(deps) });

  async function lotSplit(ctx) {
    const data = buildLotSplit(parseBody(lotSplitBody, ctx.body));
    return { data, meta: { requestId: ctx.requestId } };
  }

  async function positionGreeks(ctx) {
    const account = ctx.query.get("account");
    if (!account) throw invalid("account", "account is required: the account id from your config, such as dhan-main.");
    if (!ACCOUNT_RE.test(account)) throw invalid("account", "account is not a valid account id.");
    const mode = ctx.query.get("mode") || undefined;
    if (mode !== undefined && mode !== "paper" && mode !== "live") throw invalid("mode", "mode must be paper or live.");
    ctx.requireAccountAccess(account);
    const r = await deps.orders.positions(ctx, account, mode ? { mode } : {});
    const items = (r.items ?? []).filter((p) => p && p.netQty !== 0);

    const wanted = new Map();
    for (const p of items) {
      try {
        const s = parseSymbol(p.symbol);
        if (s.kind === "OPT") wanted.set(`${s.underlying}|${s.expiry}`, { underlying: s.underlying, expiry: s.expiry });
      } catch {
        /* reported as skipped */
      }
    }
    // A paper account's chains come from the data accounts (it has no market data of its own).
    const opts = pinMarketRead(readOptions(ctx), deps.config, account, autoBackupFor(deps));
    const chains = new Map();
    const errors = [];
    let freshness;
    for (const [key, w] of wanted) {
      try {
        const chain = await deps.marketData.optionChain({ underlying: w.underlying, expiry: w.expiry, greeks: true }, opts);
        chains.set(key, chain);
        freshness ??= chain.freshness;
      } catch (e) {
        errors.push({ underlying: w.underlying, expiry: w.expiry, code: e?.code ?? "UPSTREAM_ERROR", message: String(e?.message ?? e).slice(0, 200) });
      }
    }
    const data = aggregatePositionGreeks(items, chains);
    return {
      data,
      ...(errors.length ? { errors } : {}),
      meta: { requestId: ctx.requestId, accountId: account, positionsFreshness: r.freshness ?? null, ...(freshness ? { freshness } : {}) },
    };
  }

  return [
    ["POST", "/v1/analytics/lot-split", { scope: "read" }, lotSplit],
    ["GET", "/v1/analytics/position-greeks", { scope: "read" }, positionGreeks],
  ];
}
