/**
 * Route handlers for the safety module (docs/openapi.yaml, tag Safety). Every handler answers { data, meta }.
 *
 *   GET    /v1/safety               read            kill switch, live switch, today's counters (key's accounts only)
 *   POST   /v1/safety/kill-switch   read            engage; any key may stop trading. An empty body works (reason
 *                                                   "manual"). cancelOpenOrders needs the live scope (or admin on
 *                                                   this computer) and covers only the caller's accounts and orders
 *                                                   the Bridge placed (includeExternal: admin on this computer only)
 *   DELETE /v1/safety/kill-switch   admin, loopback release; body { "confirm": "RELEASE" }
 *   GET    /v1/audit                admin, loopback newest first, cursor pagination
 *   GET    /v1/audit/verify         admin, loopback hash-chain check
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

const engageBody = z
  .object({
    reason: z.string().trim().min(1).max(200).default("manual"),
    cancelOpenOrders: z.boolean().default(false),
    includeExternal: z.boolean().default(false),
  })
  .strict();

const releaseBody = z.object({ confirm: z.string().max(32) }).strict();

const auditQuery = z
  .object({
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    type: z
      .string()
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*(\.\*)?$|^[a-z][a-z0-9_.-]*$/, "use a type like order.placed, or a prefix like order.*")
      .optional(),
    account: z.string().regex(ACCOUNT_ID, "2-32 lowercase letters, digits or hyphens").optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

const verifyQuery = z
  .object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-19").optional() })
  .strict();

/** Accounts the request's key may see: a predicate. Local (CLI) callers and "*" keys see all. */
export function accountFilter(ctx) {
  if (ctx.principal?.kind === "local") return () => true;
  const allowed = ctx.key?.accounts;
  if (allowed === "*") return () => true;
  const set = new Set(Array.isArray(allowed) ? allowed : []);
  return (id) => set.has(id);
}

/** URLSearchParams -> plain object; a repeated parameter is refused rather than silently picking one. */
function queryObject(query) {
  const out = {};
  for (const [k, v] of query) {
    if (Object.hasOwn(out, k)) throw new BridgeError("VALIDATION_FAILED", `Send ${k} only once.`, { errors: [{ path: k, message: "repeated" }] });
    out[k] = v;
  }
  return out;
}

function parseWith(schema, value, detail) {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
}

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/**
 * @param {{ safety: any, audit: any }} deps  register() deps (this stream's own services).
 */
export function createSafetyRoutes(deps) {
  const { safety, audit } = deps;
  return {
    /** GET /v1/safety */
    getSafety(ctx) {
      return { data: safety.status(accountFilter(ctx)), meta: meta(ctx) };
    },

    /** POST /v1/safety/kill-switch */
    async engageKillSwitch(ctx) {
      const body = parseWith(engageBody, ctx.body ?? {}, "Send { \"reason\": \"...\", \"cancelOpenOrders\": true|false } or an empty body.");
      const state = await safety.engageKillSwitch(ctx, body);
      return { data: state, meta: meta(ctx) };
    },

    /** DELETE /v1/safety/kill-switch */
    async releaseKillSwitch(ctx) {
      const body = parseWith(releaseBody, ctx.body, 'To release the kill switch, send { "confirm": "RELEASE" }.');
      const state = await safety.releaseKillSwitch(ctx, body);
      return { data: state, meta: meta(ctx) };
    },

    /** GET /v1/audit */
    async queryAudit(ctx) {
      const q = parseWith(auditQuery, queryObject(ctx.query), "Some audit query parameters are not valid.");
      const page = await audit.query({ from: q.from, to: q.to, type: q.type, accountId: q.account, limit: q.limit, cursor: q.cursor });
      return { data: page.items, meta: meta(ctx, { nextCursor: page.nextCursor }) };
    },

    /** GET /v1/audit/verify */
    async verifyAudit(ctx) {
      const q = parseWith(verifyQuery, queryObject(ctx.query), "day must be a date like 2026-10-19.");
      const result = await audit.verify({ day: q.day });
      return { data: result, meta: meta(ctx) };
    },
  };
}
