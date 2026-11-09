/**
 * POST /v1/orders/to-target: "be long 3 lots", "be flat", "be short 50 shares". The Bridge reads the current position,
 * works out the difference and sends only that, through the SAME order service as POST /v1/orders (so the same
 * safety gates, price checks, idempotency, mode rules and human confirmation apply: nothing here places an order by
 * any other path).
 *
 * The rule that matters: a position that cannot be read, or cannot be matched with certainty, is POSITION_UNKNOWN and
 * NOTHING is placed. It is never treated as flat.
 *
 *  - Position = the net quantity of this symbol in this product (an INTRADAY order is sized against the INTRADAY
 *    position; positions in other products are reported in `otherProducts`, never added).
 *  - Live CNC/MTF: delivery shares can show up in both today's positions and the holdings. When both show the symbol the
 *    overlap cannot be resolved here, so it is POSITION_UNKNOWN.
 *  - An open order of this Bridge in the same symbol and product that would itself change the position (MARKET, LIMIT or a
 *    partly filled one) is STATE_CONFLICT unless the caller sends openOrders: "ignore". Resting SL and SL-M orders (stops)
 *    are reported in `openOrders` but do not block.
 *  - Idempotency: the Idempotency-Key (or clientOrderId) covers the whole request. A retry with the same body gets the
 *    first answer back, including "nothing to do"; the placed order inside carries the same key.
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { canonicaliseOrderInput } from "./aliases.mjs";
import { ACCOUNT_RE, CLIENT_ORDER_ID_RE, ORDER_TYPES, PRODUCTS, TAG_RE, TERMINAL_STATUSES, fingerprint, parseOrderRequest } from "./orderValidation.mjs";
import { createRequestRecords } from "./requestRecords.mjs";
import { istDay } from "./time.mjs";

const positivePrice = z.number().finite().gt(0).max(1e9);
const MAX_ORDER_PAGES = 10;

/** Request body of POST /v1/orders/to-target (docs/openapi.yaml TargetOrderRequest). */
export const targetRequestSchema = z
  .object({
    account: z.string().regex(ACCOUNT_RE, "use the account id from your config"),
    symbol: z.string().min(1).max(64),
    /** Signed units: 100 = long 100, 0 = flat, -50 = short 50. */
    targetQuantity: z.number().int().min(-100_000_000).max(100_000_000).optional(),
    /** Signed lots, the same way. */
    targetLots: z.number().int().min(-100_000).max(100_000).optional(),
    product: z.enum(PRODUCTS),
    orderType: z.enum(ORDER_TYPES),
    price: positivePrice.optional(),
    triggerPrice: positivePrice.optional(),
    validity: z.enum(["DAY", "IOC"]).optional(),
    marketProtectionPct: z.number().finite().gt(0).max(10).optional(),
    mode: z.enum(["paper", "live"]).optional(),
    clientOrderId: z.string().regex(CLIENT_ORDER_ID_RE, "use 1-64 letters, digits, '_' or '-'").optional(),
    tag: z.string().regex(TAG_RE, "use 1-20 letters, digits, '_' or '-'").optional(),
    algoId: z.string().min(1).max(32).optional(),
    confirmToken: z.string().min(16).max(256).optional(),
    /** Work everything out and run the checks, place nothing. */
    dryRun: z.boolean().optional(),
    openOrders: z.enum(["refuse", "ignore"]).optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    if ((o.targetQuantity === undefined) === (o.targetLots === undefined)) {
      ctx.addIssue({ code: "custom", path: ["targetQuantity"], message: "Send exactly one of targetQuantity (signed units) or targetLots (signed lots)." });
    }
  });

const unknownPosition = (detail, cause) => new BridgeError("POSITION_UNKNOWN", `${detail} Nothing was placed. Check the position in your broker's app, or try again.`, { cause });

/**
 * @param {{ deps: object, svc: object, now: () => number }} p
 */
export function createTargetOrders({ deps, svc, now }) {
  const records = createRequestRecords({ now });
  /** One target-position request at a time per account, symbol and product, so two alerts cannot both read the old position. */
  const chains = new Map();
  async function serial(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    const mine = prev.then(() => gate);
    chains.set(key, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (chains.get(key) === mine) chains.delete(key);
    }
  }

  /** The held quantity of `canonical` in `product`, or POSITION_UNKNOWN. */
  async function readPosition(ctx, { summary, canonical, underlying, product, readMode }) {
    let res;
    try {
      res = await svc.positions(ctx, summary.id, { mode: readMode });
    } catch (err) {
      throw unknownPosition(`The positions of ${summary.id} could not be read (${err?.code ?? "error"}).`, err);
    }
    if (!res || !Array.isArray(res.items)) throw unknownPosition(`The positions of ${summary.id} came back in a form the Bridge cannot read.`);
    const under = String(underlying ?? "").toUpperCase();
    let current = 0;
    const others = [];
    for (const row of res.items) {
      const sym = String(row?.symbol ?? "");
      if (row?.symbolResolved === false) {
        // A row the Bridge could not name. It matters only if it could be this instrument.
        if (under && sym.toUpperCase().includes(under)) throw unknownPosition(`A position row (${sym.slice(0, 40)}) could not be matched to a symbol and may be ${canonical}.`);
        continue;
      }
      if (sym !== canonical) continue;
      const qty = Number(row.netQty);
      if (!Number.isFinite(qty)) throw unknownPosition(`The position row for ${canonical} has no usable quantity.`);
      if ((row.product ?? "INTRADAY") === product) current += qty;
      else if (qty !== 0) others.push({ product: row.product ?? "INTRADAY", netQty: qty });
    }
    let delivery = 0;
    if (readMode === "live" && (product === "CNC" || product === "MTF")) {
      let held;
      try {
        held = await svc.holdings(ctx, summary.id);
      } catch (err) {
        throw unknownPosition(`The holdings of ${summary.id} could not be read (${err?.code ?? "error"}).`, err);
      }
      if (!held || !Array.isArray(held.items)) throw unknownPosition(`The holdings of ${summary.id} came back in a form the Bridge cannot read.`);
      for (const h of held.items) {
        const sym = String(h?.symbol ?? "");
        if (h?.symbolResolved === false) {
          if (under && sym.toUpperCase().includes(under)) throw unknownPosition(`A holding row (${sym.slice(0, 40)}) could not be matched to a symbol and may be ${canonical}.`);
          continue;
        }
        if (sym !== canonical) continue;
        const qty = Number(h.qty);
        if (!Number.isFinite(qty)) throw unknownPosition(`The holding row for ${canonical} has no usable quantity.`);
        delivery += qty;
      }
      if (delivery !== 0 && current !== 0) {
        throw unknownPosition(`${canonical} shows in today's positions (${current}) and in the holdings (${delivery}); the Bridge cannot tell whether they are the same shares.`);
      }
    }
    return { current: current + delivery, others, freshness: res.freshness ?? null };
  }

  /** Open orders of this Bridge in the same symbol and product. */
  async function readOpenOrders(ctx, { summary, canonical, product, readMode }) {
    const found = [];
    let cursor;
    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      let res;
      try {
        res = await svc.list(ctx, { accountId: summary.id, mode: readMode, limit: 500, cursor });
      } catch (err) {
        throw unknownPosition(`The open orders of ${summary.id} could not be read (${err?.code ?? "error"}).`, err);
      }
      for (const o of res.items) {
        if (TERMINAL_STATUSES.has(o.status) || o.symbol !== canonical || o.product !== product) continue;
        found.push({ orderId: o.orderId, side: o.side, quantity: o.quantity, filledQuantity: o.filledQuantity ?? 0, orderType: o.orderType, status: o.status });
      }
      if (!res.nextCursor) return found;
      cursor = res.nextCursor;
    }
    throw unknownPosition(`${summary.id} has too many orders to check for open ones.`);
  }

  /**
   * @param {import("../core/context.mjs").RequestContext} ctx
   * @param {unknown} raw request body
   * @param {{ idempotencyKey?: string }} [opts]
   * @returns {Promise<{ result: object, replayed: boolean, status: 200 | 201, normalised: Array<object> }>}
   */
  async function toTarget(ctx, raw, { idempotencyKey } = {}) {
    const canon = canonicaliseOrderInput(raw);
    const parsed = targetRequestSchema.safeParse(canon.input ?? {});
    if (!parsed.success) throw fromValidation(parsed.error, "The target-position request is missing fields or has fields that are not valid.");
    const req = parsed.data;
    ctx.requireAccountAccess(req.account);
    // The order fields go through the order schema now, with a placeholder side and size, so a bad price or order type is
    // refused before anything is read.
    const { targetQuantity: _tq, targetLots: _tl, dryRun: _dr, openOrders: _oo, ...orderFields } = req;
    void _tq;
    void _tl;
    void _dr;
    void _oo;
    parseOrderRequest({ ...orderFields, side: "BUY", quantity: 1 });

    const dryRun = req.dryRun === true;
    const day = istDay(now());
    const viaClientId = idempotencyKey === undefined && req.clientOrderId !== undefined;
    const principal = `${ctx.principal?.kind ?? "anonymous"}:${ctx.principal?.id ?? "anonymous"}`;
    const scope = dryRun ? null : idempotencyKey !== undefined ? `key:${principal}:to-target:${idempotencyKey}` : viaClientId ? `coid:${req.account}:${day}:${req.clientOrderId}:${principal}` : null;
    if (scope) {
      const { confirmToken: _ct, ...stable } = req;
      void _ct;
      const b = records.begin(scope, fingerprint({ action: "to-target", body: stable }), viaClientId ? { reuseCode: "DUPLICATE_CLIENT_ORDER_ID", reuseMessage: `clientOrderId ${req.clientOrderId} was already used for a different target-position request today.` } : {});
      if (b.replay) return { result: { ...b.result.result, replayed: true }, replayed: true, status: b.result.status, normalised: canon.notes };
    }
    try {
      const out = await run(ctx, req, { dryRun, idempotencyKey });
      if (scope) records.complete(scope, { result: out.result, status: out.status });
      return { ...out, replayed: false, normalised: canon.notes };
    } catch (err) {
      if (scope) records.release(scope);
      throw err;
    }
  }

  async function run(ctx, req, { dryRun, idempotencyKey }) {
    const summary = deps.accounts.get(req.account);
    let resolved;
    try {
      resolved = await deps.symbols.resolve(req.symbol);
    } catch (err) {
      throw err instanceof BridgeError ? err : new BridgeError("SYMBOL_NOT_FOUND", `${req.symbol} could not be resolved.`);
    }
    const lot = resolved.lotSize;
    if (!(Number.isInteger(lot) && lot > 0)) throw new BridgeError("SYMBOL_NOT_FOUND", `No lot size is known for ${resolved.canonical}, so the order cannot be sized safely.`);
    const target = req.targetLots !== undefined ? req.targetLots * lot : req.targetQuantity;
    if (target % lot !== 0) {
      throw new BridgeError("INVALID_ORDER", `targetQuantity ${target} is not a multiple of the lot size ${lot} for ${resolved.canonical}. Send ${Math.trunc(target / lot) * lot} or use targetLots.`);
    }
    return serial(`${summary.id}|${resolved.canonical}|${req.product}`, () => sized(ctx, req, { summary, resolved, lot, target, dryRun, idempotencyKey }));
  }

  async function sized(ctx, req, { summary, resolved, lot, target, dryRun, idempotencyKey }) {
    // A live request on a paper account is refused by the order service (PAPER_ONLY); read the paper book meanwhile.
    const readMode = req.mode === "live" && summary.broker !== "paper" ? "live" : "paper";
    const pos = await readPosition(ctx, { summary, canonical: resolved.canonical, underlying: resolved.underlying, product: req.product, readMode });
    const open = await readOpenOrders(ctx, { summary, canonical: resolved.canonical, product: req.product, readMode });
    const delta = target - pos.current;
    const action = delta === 0 ? "NONE" : delta > 0 ? "BUY" : "SELL";
    const base = {
      account: summary.id,
      symbol: resolved.canonical,
      product: req.product,
      mode: req.mode ?? "paper",
      lotSize: lot,
      currentQuantity: pos.current,
      targetQuantity: target,
      delta,
      action,
      dryRun,
      placed: false,
      order: null,
      preview: null,
      otherProducts: pos.others,
      openOrders: open,
      positionFreshness: pos.freshness,
    };
    if (action === "NONE") return { result: base, status: 200 };
    if (req.openOrders !== "ignore") {
      const blocking = open.filter((o) => (o.orderType !== "SL" && o.orderType !== "SL-M") || o.filledQuantity > 0 || o.status === "partially_filled" || o.status === "outcome_unknown");
      if (blocking.length) {
        throw new BridgeError(
          "STATE_CONFLICT",
          `${resolved.canonical} (${req.product}) has ${blocking.length} open order${blocking.length === 1 ? "" : "s"} that can change the position (${blocking.map((o) => o.orderId).slice(0, 3).join(", ")}). Wait for ${blocking.length === 1 ? "it" : "them"} to fill, cancel ${blocking.length === 1 ? "it" : "them"}, or send openOrders: "ignore".`,
        );
      }
    }
    const { targetQuantity: _tq, targetLots: _tl, dryRun: _dr, openOrders: _oo, account: _a, symbol: _s, ...orderFields } = req;
    void _tq;
    void _tl;
    void _dr;
    void _oo;
    void _a;
    void _s;
    const body = { ...orderFields, account: summary.id, symbol: resolved.canonical, side: action, quantity: Math.abs(delta) };
    if (dryRun) {
      const preview = await svc.preview(ctx, body);
      return { result: { ...base, preview }, status: 200 };
    }
    const placed = await svc.place(ctx, body, { idempotencyKey });
    return { result: { ...base, placed: true, order: placed.order }, status: 201 };
  }

  return { toTarget };
}
