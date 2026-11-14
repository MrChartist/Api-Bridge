/**
 * POST /v1/margin/basket: the margin a set of prospective positions would need, before anything is placed. Read only.
 *
 *  - source "broker": the broker's own margin calculator, used only when the account's adapter implements the optional
 *    `fetchBasketMargin(creds, legs)` (returns { status: "success", data: { total, span?, exposure?, hedgeBenefit? } }).
 *    No shipped adapter does yet, so today every answer is "paper-model".
 *  - source "paper-model": the paper engine's approximate portfolio model (calc/span-margin.js), on the basket by itself
 *    (the basket on its own, hedges between its legs counted). It is not the exchange's SPAN and the response says so.
 *    When the broker call was tried and failed, the paper model answers and `note` says why.
 *  - All figures are JSON numbers in rupees. Nothing is stored and no order is created.
 */
import { z } from "zod";
import { BridgeError, fromBrokerError, fromValidation } from "../core/errors.mjs";
import { canonicaliseOrderInput } from "./aliases.mjs";
import { ACCOUNT_RE, ORDER_TYPES, PRODUCTS } from "./orderValidation.mjs";
import { istIso } from "./time.mjs";

export const MARGIN_BASKET_MAX = 50;

const legSchema = z
  .object({
    symbol: z.string().min(1).max(64),
    side: z.enum(["BUY", "SELL"]),
    quantity: z.number().int().min(1).max(100_000_000).optional(),
    lots: z.number().int().min(1).max(100_000).optional(),
    product: z.enum(PRODUCTS).optional(),
    orderType: z.enum(ORDER_TYPES).optional(),
    price: z.number().finite().gt(0).max(1e9).optional(),
  })
  .strict()
  .refine((l) => (l.quantity === undefined) !== (l.lots === undefined), { message: "Send exactly one of quantity (units) or lots." });

const basketSchema = z
  .object({
    account: z.string().regex(ACCOUNT_RE, "use the account id from your config").optional(),
    positions: z.array(z.unknown()).min(1, "Send at least one position.").max(MARGIN_BASKET_MAX, `Send at most ${MARGIN_BASKET_MAX} positions.`),
  })
  .strict();

const round2 = (n) => Math.round(n * 100) / 100;
const finite = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);

/**
 * @param {{ deps: object, now: () => number }} p
 */
export function createMarginBasket({ deps, now }) {
  /** The account to answer for, or a clear refusal. */
  function chooseAccount(ctx, wanted) {
    if (wanted) {
      ctx.requireAccountAccess(wanted);
      return deps.accounts.get(wanted);
    }
    for (const a of deps.accounts.list()) {
      if (a.enabled === false) continue;
      try {
        ctx.requireAccountAccess(a.id);
      } catch {
        continue;
      }
      if (a.broker === "paper") return a;
    }
    throw new BridgeError("VALIDATION_FAILED", "account is required: the account id whose broker should answer, or a paper account for the paper model.", { errors: [{ path: "account", message: "required" }] });
  }

  /** A paper account the model can run on (the model needs a paper book; a live account's book is never created). */
  function paperHost(ctx, summary) {
    if (summary.broker === "paper") return summary.id;
    for (const a of deps.accounts.list()) {
      if (a.broker !== "paper" || a.enabled === false) continue;
      try {
        ctx.requireAccountAccess(a.id);
        return a.id;
      } catch {
        // not usable by this key
      }
    }
    throw new BridgeError("CAPABILITY_UNSUPPORTED", `${summary.broker} has no margin calculator through the Bridge, and no paper account is available to run the paper model. Add a paper account.`);
  }

  async function brokerMargin(summary, legs) {
    let adapter;
    try {
      adapter = deps.accounts.adapter(summary.id);
    } catch {
      return { unsupported: true };
    }
    if (typeof adapter?.fetchBasketMargin !== "function") return { unsupported: true };
    const rows = [];
    for (const l of legs) {
      const ref = l.resolved.refs?.[summary.broker] ?? (await deps.symbols.toBroker(l.resolved.canonical, summary.broker));
      rows.push({ exchange: ref.exchange ?? l.resolved.exchange, token: ref.token, tradingSymbol: ref.tradingSymbol ?? null, side: l.side, quantity: l.quantity, product: l.product, orderType: l.orderType, price: l.price ?? null });
    }
    try {
      const res = await deps.scheduler.schedule({ accountId: summary.id, endpointClass: "portfolio", priority: "interactive" }, async () => {
        const creds = await deps.accounts.creds(summary.id);
        return adapter.fetchBasketMargin(creds, rows);
      });
      const d = res?.status === "success" ? res.data : null;
      const total = finite(d?.total);
      if (total === null || total < 0) return { failed: "the broker's answer had no total" };
      return { total, span: finite(d.span), exposure: finite(d.exposure), hedgeBenefit: finite(d.hedgeBenefit) };
    } catch (err) {
      const e = fromBrokerError(err, { brokerId: summary.broker });
      return { failed: e.code };
    }
  }

  /**
   * @param {import("../core/context.mjs").RequestContext} ctx
   * @param {unknown} raw
   */
  async function marginBasket(ctx, raw) {
    const parsed = basketSchema.safeParse(raw ?? {});
    if (!parsed.success) throw fromValidation(parsed.error, `Send { "positions": [ ...up to ${MARGIN_BASKET_MAX} ] }.`);
    const legsIn = [];
    parsed.data.positions.forEach((p, i) => {
      const r = legSchema.safeParse(canonicaliseOrderInput(p).input);
      if (!r.success) throw fromValidation(r.error, `positions[${i}] is not valid.`);
      legsIn.push(r.data);
    });
    const summary = chooseAccount(ctx, parsed.data.account);

    const legs = [];
    for (const [i, l] of legsIn.entries()) {
      let resolved;
      try {
        resolved = await deps.symbols.resolve(l.symbol);
      } catch (err) {
        const code = err instanceof BridgeError ? err.code : "SYMBOL_NOT_FOUND";
        throw new BridgeError(code, `positions[${i}]: ${err?.detail ?? `${l.symbol} could not be resolved.`}`, { errors: [{ path: `positions.${i}.symbol`, message: "not usable" }] });
      }
      if (resolved.kind === "INDEX") throw new BridgeError("INVALID_ORDER", `positions[${i}]: ${resolved.canonical} is an index and has no margin. Use its futures or options.`);
      const lot = resolved.lotSize;
      const quantity = l.lots !== undefined ? l.lots * lot : l.quantity;
      if (quantity % lot !== 0) throw new BridgeError("INVALID_ORDER", `positions[${i}]: quantity ${quantity} is not a multiple of the lot size ${lot} for ${resolved.canonical}.`);
      const product = l.product ?? (resolved.kind === "EQ" ? "INTRADAY" : "MARGIN");
      const orderType = l.orderType ?? (l.price === undefined ? "MARKET" : "LIMIT");
      legs.push({ symbol: resolved.canonical, side: l.side, quantity, product, orderType, price: l.price, resolved });
    }

    let note = null;
    if (summary.broker !== "paper") {
      const b = await brokerMargin(summary, legs);
      if (!b.unsupported && !b.failed) {
        return { total: round2(b.total), span: b.span === null ? null : round2(b.span), exposure: b.exposure === null ? null : round2(b.exposure), hedgeBenefit: b.hedgeBenefit === null ? null : round2(b.hedgeBenefit), source: "broker", account: summary.id, legs: legs.length, asOf: istIso(now()), note: null };
      }
      note = b.failed
        ? `The ${summary.broker} margin call failed (${b.failed}), so this is the paper model, which is approximate.`
        : `${summary.broker} has no margin calculator through the Bridge yet, so this is the paper model, which is approximate and not the exchange's SPAN.`;
    }
    const host = paperHost(ctx, summary);
    if (typeof deps.paper?.estimateBasketMargin !== "function") throw new BridgeError("CAPABILITY_UNSUPPORTED", "The paper engine cannot estimate margin.");
    const m = await deps.paper.estimateBasketMargin(host, legs.map((l) => ({ symbol: l.symbol, side: l.side, quantity: l.quantity, product: l.product, orderType: l.orderType, ...(l.price !== undefined ? { price: l.price } : {}), resolved: l.resolved })));
    const total = round2(Number(m.alone));
    const standalone = round2(Number(m.standalone));
    if (!Number.isFinite(total)) throw new BridgeError("INTERNAL", "The margin model returned no figure.");
    return {
      total,
      span: finite(m.breakdown?.span),
      exposure: finite(m.breakdown?.exposure),
      hedgeBenefit: Number.isFinite(standalone) ? Math.max(0, round2(standalone - total)) : null,
      source: "paper-model",
      account: summary.id,
      legs: legs.length,
      asOf: istIso(now()),
      model: m.model ?? null,
      method: m.method ?? null,
      breakdown: m.breakdown ?? null,
      fallback: Array.isArray(m.fallback) ? m.fallback : [],
      note: note ?? "Paper model: approximate, not the exchange's SPAN.",
    };
  }

  return { marginBasket };
}
