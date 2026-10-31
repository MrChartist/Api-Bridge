/**
 * Route handlers for stream S8 (docs/openapi.yaml, tag "Paper"). Both answer { data: PaperAccount, meta }.
 *
 *   GET  /v1/paper/accounts/{accountId}          scope read
 *   POST /v1/paper/accounts/{accountId}/reset    scope paper   body: { startingCapital? } (₹10,000 to ₹100,00,00,000)
 *   POST /v1/paper/accounts/{accountId}/reset/undo  scope paper  puts back the book from before the last reset (2 min)
 *   GET  /v1/paper/accounts/{accountId}/daily    scope read    the daily P&L snapshots (end of day, and on demand)
 *   POST /v1/paper/accounts/{accountId}/daily    scope paper   take today's snapshot now
 *   POST /v1/paper/accounts/{accountId}/margin   scope read    body: { legs: [{ symbol, side, quantity|lots, price? }] }
 *        the basket's margin against the book, portfolio model (dashboard/span-margin.js); nothing is placed
 *
 * The key must be allowed to use the account (ctx.requireAccountAccess) before anything else happens. A reset is
 * written to the audit log when the audit service is available (it is optional here so the routes work before S9).
 */
import { z } from "zod";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { CAPITAL_MAX, CAPITAL_MIN } from "./config.mjs";
import { FILL_MODEL_TEXT } from "./fillModel.mjs";

const marginBody = z
  .object({
    legs: z
      .array(
        z
          .object({
            symbol: z.string().min(1).max(64),
            side: z.enum(["BUY", "SELL"]),
            quantity: z.number().int().positive().optional(),
            lots: z.number().int().positive().optional(),
            price: z.number().positive().optional(),
            product: z.enum(["INTRADAY", "MARGIN"]).optional(),
          })
          .strict()
          .refine((l) => l.quantity !== undefined || l.lots !== undefined, { message: "give quantity or lots" }),
      )
      .min(1)
      .max(24),
  })
  .strict();

const resetBody = z
  .object({ startingCapital: z.number().finite().min(CAPITAL_MIN).max(CAPITAL_MAX).optional() })
  .strict();

/**
 * Full PaperAccount (openapi): the engine's summary plus funds and the fill-model text.
 * @param {object} paper PaperEngine
 * @param {string} accountId
 */
export async function paperAccountView(paper, accountId) {
  const [summary, funds] = await Promise.all([paper.account(accountId), paper.funds(accountId)]);
  return { ...summary, funds, fillModel: FILL_MODEL_TEXT };
}

/**
 * @param {object} deps full deps passed to register()
 */
export function createPaperRoutes(deps) {
  const meta = (ctx, accountId) => ({ requestId: ctx.requestId, accountId, mode: "paper" });
  const accountParam = (ctx) => {
    const id = ctx.params.accountId;
    ctx.requireAccountAccess(id);
    return id;
  };

  return {
    async getAccount(ctx) {
      const accountId = accountParam(ctx);
      return { data: await paperAccountView(deps.paper, accountId), meta: meta(ctx, accountId) };
    },

    async margin(ctx) {
      const accountId = accountParam(ctx);
      const parsed = marginBody.safeParse(ctx.body ?? {});
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
        throw new BridgeError("VALIDATION_FAILED", `The margin request is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
      }
      const legs = parsed.data.legs.map((l) => ({ ...l, orderType: l.price === undefined ? "MARKET" : "LIMIT", product: l.product ?? "MARGIN" }));
      return { data: await deps.paper.estimateBasketMargin(accountId, legs), meta: meta(ctx, accountId) };
    },

    async daily(ctx) {
      const accountId = accountParam(ctx);
      return { data: { items: await deps.paper.daily(accountId) }, meta: meta(ctx, accountId) };
    },

    async snapshot(ctx) {
      const accountId = accountParam(ctx);
      return { data: await deps.paper.snapshot(accountId), meta: meta(ctx, accountId) };
    },

    async undoReset(ctx) {
      const accountId = accountParam(ctx);
      await deps.paper.undoReset(accountId);
      const audit = deps.audit;
      if (audit && !isStub(audit)) {
        try {
          await audit.append({ type: "paper.reset.undone", actor: { kind: ctx.principal.kind, id: ctx.principal.id }, source: ctx.source ?? "rest", accountId, requestId: ctx.requestId, data: {} });
        } catch (err) {
          ctx.log?.warn?.("paper reset undo could not be audited", { accountId, code: err?.code });
        }
      }
      return { data: await paperAccountView(deps.paper, accountId), meta: meta(ctx, accountId) };
    },

    async reset(ctx) {
      const accountId = accountParam(ctx);
      const parsed = resetBody.safeParse(ctx.body ?? {});
      if (!parsed.success) {
        const errors = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
        throw new BridgeError("VALIDATION_FAILED", `The reset request is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors });
      }
      await deps.paper.reset(accountId, parsed.data);
      const audit = deps.audit;
      if (audit && !isStub(audit)) {
        try {
          await audit.append({
            type: "paper.reset",
            actor: { kind: ctx.principal.kind, id: ctx.principal.id },
            source: ctx.source ?? "rest",
            accountId,
            requestId: ctx.requestId,
            data: { startingCapital: parsed.data.startingCapital ?? null },
          });
        } catch (err) {
          ctx.log?.warn?.("paper reset could not be audited", { accountId, code: err?.code });
        }
      }
      return { data: await paperAccountView(deps.paper, accountId), meta: meta(ctx, accountId) };
    },
  };
}
