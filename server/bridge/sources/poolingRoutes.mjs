/**
 * Pooling routes: the consent a person gives before reads are spread over their own accounts.
 *
 *   GET    /v1/pooling          read   the consent, the accounts grouped by holder with each broker's pooling policy, the notice
 *   PUT    /v1/pooling/consent  admin, this computer only (like key creation)   { acknowledge: "<notice version>", accounts: [ids] }
 *   DELETE /v1/pooling/consent  admin, this computer only                       revoke: pooling ends at once
 *
 * The sources module calls `registerPoolingRoutes(app, deps)` when this file exists. Every answer is { data, meta }
 * and carries no credential. Accepting and revoking are audited (pooling.consent_accepted / pooling.consent_revoked)
 * with ids only. A key limited to some accounts sees only those accounts, and may only consent for accounts it may use.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createPoolingService } from "./pooling.mjs";

/** Body cap for accepting consent: an acknowledgement and a list of account ids. */
export const CONSENT_BODY_LIMIT_BYTES = 4 * 1024;

/** [method, path, route options, handler name] */
export const POOLING_ROUTES = Object.freeze([
  ["GET", "/v1/pooling", { scope: "read", summary: "Pooling consent, accounts by holder and the notice" }, "get"],
  ["PUT", "/v1/pooling/consent", { scope: "admin", loopbackOnly: true, bodyLimitBytes: CONSENT_BODY_LIMIT_BYTES, summary: "Accept the pooling notice for named accounts" }, "accept"],
  ["DELETE", "/v1/pooling/consent", { scope: "admin", loopbackOnly: true, body: "none", summary: "Revoke pooling consent; pooling ends at once" }, "revoke"],
]);

const meta = (ctx) => ({ requestId: ctx.requestId });

async function audit(deps, ctx, type, data) {
  const log = deps.audit;
  if (!log || isStub(log)) {
    ctx.log.warn("audit log not available; action not audited", { type });
    return;
  }
  try {
    await log.append({ type, actor: { kind: ctx.principal.kind, id: ctx.principal.id }, source: ctx.source, requestId: ctx.requestId, data });
  } catch (err) {
    ctx.log.error("audit append failed", { type, code: err?.code });
  }
}

/** The status as this caller may see it: only accounts the key may use. */
function visibleStatus(ctx, status) {
  const may = (id) => ctx.canAccessAccounts([id]);
  const groups = status.groups.map((g) => ({ ...g, accounts: g.accounts.filter((a) => may(a.id)) })).filter((g) => g.accounts.length);
  const consent = status.consent ? { ...status.consent, accounts: status.consent.accounts.filter(may) } : null;
  return { ...status, groups, consent };
}

/**
 * @param {object} deps  the full deps object passed to register()
 * @param {ReturnType<typeof createPoolingService>} service
 */
export function createPoolingRoutes(deps, service) {
  return {
    /** GET /v1/pooling */
    get(ctx) {
      return { data: visibleStatus(ctx, service.status()), meta: meta(ctx) };
    },

    /** PUT /v1/pooling/consent */
    async accept(ctx) {
      const body = ctx.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", 'Send { "acknowledge": "<notice version>", "accounts": ["<id>", ...] } as a JSON object.');
      const extra = Object.keys(body).filter((k) => k !== "acknowledge" && k !== "accounts");
      if (extra.length) throw new BridgeError("VALIDATION_FAILED", "Only acknowledge and accounts can be sent.", { errors: extra.slice(0, 5).map((k) => ({ path: String(k).slice(0, 40), message: "unknown field" })) });
      if (Array.isArray(body.accounts) && body.accounts.every((a) => typeof a === "string") && !ctx.canAccessAccounts(body.accounts)) {
        throw new BridgeError("ACCOUNT_FORBIDDEN", "This key may not use every account named here, so it cannot give pooling consent for them.");
      }
      const record = await service.acceptConsent({ acknowledge: body.acknowledge, accounts: body.accounts });
      await audit(deps, ctx, "pooling.consent_accepted", { version: record.version, accounts: [...record.accounts] });
      return { data: visibleStatus(ctx, service.status()), meta: meta(ctx) };
    },

    /** DELETE /v1/pooling/consent */
    async revoke(ctx) {
      const { revoked } = await service.revokeConsent();
      if (revoked) await audit(deps, ctx, "pooling.consent_revoked", {});
      return { data: { revoked, ...visibleStatus(ctx, service.status()) }, meta: meta(ctx) };
    },
  };
}

/**
 * Register the three routes. The service is the one the AccountManager asks on every read (`deps.accounts.pooling`),
 * so accepting and revoking take effect on the next read; `options.service` is for tests.
 * @param {{ route(method: string, path: string, handler: Function, options?: object): void }} app
 * @param {object} deps
 * @param {{ service?: ReturnType<typeof createPoolingService> }} [options]
 */
export function registerPoolingRoutes(app, deps, options = {}) {
  const shared = !deps.accounts || isStub(deps.accounts) ? null : deps.accounts.pooling;
  const service = options.service ?? deps.pooling ?? shared ?? createPoolingService(deps);
  const handlers = createPoolingRoutes(deps, service);
  for (const [method, path, opts, name] of POOLING_ROUTES) app.route(method, path, handlers[name], opts);
  return service;
}
