/**
 * POST /v1/orders/batch: up to 20 independent orders in one call, for alerts that need two legs (a hedge and a main
 * order). It is a convenience, not a strategy engine: the legs do not know about each other, nothing is rolled back,
 * and a leg that is refused does not undo the legs that went out.
 *
 *  - Every leg goes through the SAME order service as POST /v1/orders: the same checks, safety gates, mode rules, price
 *    checks, confirmation rules and idempotency. Legs run one after another, in the order sent (or buys first when
 *    legOrder is "buys-first"), and each gets its own result in `results[]`, always in the order sent.
 *  - Idempotency: leg i uses the request's Idempotency-Key plus ":" plus i (a key longer than 240 characters is hashed first). A retry of the
 *    whole request with the same body gets the first answer back. A live leg still needs a key or its own clientOrderId.
 *  - Nothing is hidden: HTTP 201 only when every leg went out; 207 when at least one leg went out (or may have) and at
 *    least one did not; 422 when no leg went out. `data.ok`, `data.summary` and every leg's `status` say the same.
 *  - stopOnError: after the first leg that did not go out, the rest are not tried and show status "skipped".
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { BridgeError, fromValidation, toProblem } from "../core/errors.mjs";
import { canonicaliseOrderInput } from "./aliases.mjs";
import { ACCOUNT_RE, fingerprint } from "./orderValidation.mjs";
import { createRequestRecords } from "./requestRecords.mjs";

export const BATCH_MAX_LEGS = 20;

const batchSchema = z
  .object({
    account: z.string().regex(ACCOUNT_RE, "use the account id from your config"),
    orders: z.array(z.unknown()).min(1, "Send at least one order.").max(BATCH_MAX_LEGS, `Send at most ${BATCH_MAX_LEGS} orders per batch.`),
    stopOnError: z.boolean().optional(),
    legOrder: z.enum(["as-sent", "buys-first"]).optional(),
    /** Applies to every leg that does not set its own. */
    mode: z.enum(["paper", "live"]).optional(),
  })
  .strict();

/** The key leg `index` uses: the request key plus the index (hashed first when it would not fit). */
export function legKey(key, index) {
  const base = key.length <= 240 ? key : createHash("sha256").update(key).digest("hex").slice(0, 40);
  return `${base}:${index}`;
}

const errorOf = (err) => {
  const p = toProblem(err instanceof BridgeError ? err : new BridgeError("INTERNAL"));
  const out = { code: p.code, message: p.detail, status: p.status, retryable: p.retryable };
  if (p.errors) out.errors = p.errors;
  if (p.retryAfterMs !== undefined) out.retryAfterMs = p.retryAfterMs;
  return out;
};

/**
 * @param {{ deps: object, svc: object, now: () => number }} p
 */
export function createBatchOrders({ deps, svc, now }) {
  const records = createRequestRecords({ now });

  async function sendLeg(ctx, account, leg, index, { mode, key }) {
    const base = { index, ok: false };
    try {
      if (!leg || typeof leg !== "object" || Array.isArray(leg)) {
        throw new BridgeError("VALIDATION_FAILED", `orders[${index}] must be an order object.`, { errors: [{ path: `orders.${index}`, message: "must be an object" }] });
      }
      if (leg.account !== undefined && leg.account !== account) {
        throw new BridgeError("VALIDATION_FAILED", `orders[${index}].account must be left out or equal the batch account ${account}. One batch uses one account.`, { errors: [{ path: `orders.${index}.account`, message: "differs from the batch account" }] });
      }
      const body = { ...leg, account };
      if (body.mode === undefined && mode !== undefined) body.mode = mode;
      const idempotencyKey = key !== undefined ? legKey(key, index) : undefined;
      const { order, replayed } = await svc.place(ctx, body, { idempotencyKey });
      return { ...base, ok: true, status: "placed", orderId: order.orderId, order, replayed, ...(idempotencyKey ? { idempotencyKey } : {}) };
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError("INTERNAL");
      const unknown = e.code === "OUTCOME_UNKNOWN";
      return { ...base, status: unknown ? "outcome_unknown" : "rejected", error: errorOf(e) };
    }
  }

  /**
   * @param {import("../core/context.mjs").RequestContext} ctx
   * @param {unknown} raw
   * @param {{ idempotencyKey?: string }} [opts]
   * @returns {Promise<{ result: object, status: 201 | 207 | 422, replayed: boolean }>}
   */
  async function batch(ctx, raw, { idempotencyKey } = {}) {
    const parsed = batchSchema.safeParse(raw ?? {});
    if (!parsed.success) throw fromValidation(parsed.error, `Send { "account": ..., "orders": [ ...up to ${BATCH_MAX_LEGS} orders ] }.`);
    const req = parsed.data;
    ctx.requireAccountAccess(req.account);
    deps.accounts.get(req.account); // an unknown account is one error, not one per leg

    // Words such as MIS are read the same way as on a single order, leg by leg.
    const legs = req.orders.map((l) => canonicaliseOrderInput(l).input);
    const principal = `${ctx.principal?.kind ?? "anonymous"}:${ctx.principal?.id ?? "anonymous"}`;
    const scope = idempotencyKey !== undefined ? `key:${principal}:batch:${idempotencyKey}` : null;
    if (scope) {
      const stable = legs.map((l) => (l && typeof l === "object" && !Array.isArray(l) ? Object.fromEntries(Object.entries(l).filter(([k]) => k !== "confirmToken")) : l));
      const b = records.begin(scope, fingerprint({ action: "batch", account: req.account, mode: req.mode ?? null, stopOnError: req.stopOnError === true, legOrder: req.legOrder ?? "as-sent", orders: stable }));
      if (b.replay) return { result: { ...b.result.result, replayed: true }, status: b.result.status, replayed: true };
    }
    try {
      const results = new Array(legs.length);
      const order = legs.map((_, i) => i);
      if (req.legOrder === "buys-first") {
        const side = (i) => (legs[i] && typeof legs[i] === "object" ? String(legs[i].side ?? "").toUpperCase() : "");
        order.sort((a, b) => (side(a) === "SELL" ? 1 : 0) - (side(b) === "SELL" ? 1 : 0) || a - b);
      }
      let stopped = false;
      for (const i of order) {
        if (stopped) {
          results[i] = { index: i, ok: false, status: "skipped", reason: "An earlier leg did not go out and stopOnError is true, so this leg was not tried." };
          continue;
        }
        results[i] = await sendLeg(ctx, req.account, legs[i], i, { mode: req.mode, key: idempotencyKey });
        if (!results[i].ok && req.stopOnError === true) stopped = true;
      }
      const placed = results.filter((r) => r.status === "placed").length;
      const unknown = results.filter((r) => r.status === "outcome_unknown").length;
      const rejected = results.filter((r) => r.status === "rejected").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const ok = placed === results.length;
      const result = {
        account: req.account,
        ok,
        summary: { total: results.length, placed, rejected, outcomeUnknown: unknown, skipped },
        stopOnError: req.stopOnError === true,
        legOrder: req.legOrder ?? "as-sent",
        results,
        replayed: false,
      };
      const status = ok ? 201 : placed + unknown > 0 ? 207 : 422;
      // A batch where nothing went out may be retried with the same key; one where something did is answered from the record.
      if (scope) {
        if (placed + unknown === 0) records.release(scope);
        else records.complete(scope, { result, status });
      }
      return { result, status, replayed: false };
    } catch (err) {
      if (scope) records.release(scope);
      throw err;
    }
  }

  return { batch };
}
