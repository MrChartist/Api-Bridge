/**
 * GET /v1/orders/drift (docs/openapi.yaml, tag Orders). The last result of the read-only order-book check
 * (orders/drift.mjs). It makes no broker call: it reports what the periodic check found. A key sees only the
 * accounts it may use. The route never changes anything.
 *
 *   GET /v1/orders/drift?account=
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { accountFilter } from "../safety/routes.mjs";
import { ACCOUNT_RE } from "./orderValidation.mjs";

const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

/** @param {{ orderDrift: any, config: any }} deps */
export function createDriftRoutes(deps) {
  return {
    async getDrift(ctx) {
      for (const k of new Set([...ctx.query.keys()])) {
        if (k !== "account") throw new BridgeError("VALIDATION_FAILED", `Unknown query parameter ${k}.`, { errors: [{ path: k, message: "not allowed" }] });
      }
      const accounts = ctx.query.getAll("account");
      if (accounts.length > 1) throw invalid("account", "Send account only once.");
      const only = accounts[0] || undefined;
      if (only !== undefined && !ACCOUNT_RE.test(only)) throw invalid("account", "account is not a valid account id.");
      const canSee = accountFilter(ctx);
      if (only !== undefined) {
        if (!(deps.config.accounts ?? []).some((a) => a.id === only)) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${only}" in bridge.config.json.`);
        if (!canSee(only)) throw new BridgeError("ACCOUNT_FORBIDDEN", `This API key may not use account ${only}.`);
      }
      const svc = deps.orderDrift;
      if (!svc || isStub(svc)) throw new BridgeError("NOT_IMPLEMENTED", "The order-book check is not part of this build.");
      const data = svc.status({ canSee: only ? (id) => id === only : canSee });
      return { data, meta: { requestId: ctx.requestId, accountId: only ?? null } };
    },
  };
}
