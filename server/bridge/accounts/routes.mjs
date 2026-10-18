/**
 * Route handlers for stream S1 (docs/openapi.yaml, tag Accounts). Every handler answers { data, meta } and never
 * includes a credential: AccountSummary/SessionState carry state and times only, and connect() takes the request
 * body straight to AccountManager without logging or echoing it.
 *
 * Auditing: account.connected / account.disconnected go to deps.audit (S9) with ids, broker and resulting state
 * only. While the audit service is still a stub the action proceeds and a warning is logged.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { BROKER_NAMES, VERIFIED_BROKERS, adapterCapabilities, loadBrokerPolicies } from "./brokerInfo.mjs";

/** Accounts the request's key may use ("*" = all). Local (CLI) callers see everything. */
export function visibleAccountIds(ctx) {
  if (ctx.principal?.kind === "local") return "*";
  const allowed = ctx.key?.accounts;
  if (allowed === "*") return "*";
  return Array.isArray(allowed) ? new Set(allowed) : new Set();
}

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/**
 * Append an audit record; never fails the request because the audit service is missing, but a real audit failure
 * after a credential change is logged loudly.
 */
async function audit(deps, ctx, type, accountId, data) {
  const auditLog = deps.audit;
  if (!auditLog || isStub(auditLog)) {
    ctx.log.warn("audit log not available; action not audited", { type, accountId });
    return;
  }
  try {
    await auditLog.append({
      type,
      actor: { kind: ctx.principal.kind, id: ctx.principal.id },
      source: ctx.source,
      accountId,
      requestId: ctx.requestId,
      data,
    });
  } catch (err) {
    ctx.log.error("audit append failed", { type, accountId, code: err?.code });
  }
}

/**
 * Build the handlers. `deps` is the full deps object passed to register().
 * @param {object} deps
 * @param {{ policies?: Record<string, any> }} [opts]  policies: S3's table, used when the scheduler is still a stub.
 */
export function createAccountRoutes(deps, { policies = {} } = {}) {
  const accounts = deps.accounts;

  function policyFor(brokerId) {
    if (deps.scheduler && !isStub(deps.scheduler)) {
      try {
        return deps.scheduler.policyFor(brokerId) ?? null;
      } catch {
        // fall through to the static table
      }
    }
    return policies[brokerId] ?? null;
  }

  function accountParam(ctx) {
    const id = ctx.params.accountId;
    ctx.requireAccountAccess(id); // before any lookup, so a key cannot probe which ids exist
    return id;
  }

  return {
    /** GET /v1/brokers */
    listBrokers(ctx) {
      const data = deps.brokers
        .list()
        .slice()
        .sort()
        .map((id) => {
          const adapter = deps.brokers.get(id);
          const item = {
            id,
            name: BROKER_NAMES[id] ?? adapter.displayName ?? id,
            ...(adapter.demo ? { demo: true } : {}),
            authKind: adapter.capabilities?.auth?.kind ?? "apiKeyToken",
            capabilities: adapterCapabilities(adapter),
            verified: VERIFIED_BROKERS.includes(id),
            // What a login form needs (field names and labels only; no values ever leave the Bridge).
            credentialFields: Array.isArray(adapter.credentialFields) ? [...adapter.credentialFields] : [],
            loginFields: (adapter.capabilities?.auth?.loginFields ?? []).map((f) => ({ key: f.key, label: f.label ?? f.key, kind: f.kind ?? "secret" })),
            tokenExpiry: adapter.capabilities?.auth?.tokenExpiry ?? null,
          };
          const policy = policyFor(id);
          if (policy) item.policy = policy;
          return item;
        });
      return { data, meta: meta(ctx) };
    },

    /** GET /v1/accounts — only the accounts this key may use. */
    listAccounts(ctx) {
      const visible = visibleAccountIds(ctx);
      const data = accounts.list().filter((a) => visible === "*" || visible.has(a.id));
      return { data, meta: meta(ctx) };
    },

    /** GET /v1/accounts/{accountId} */
    getAccount(ctx) {
      const id = accountParam(ctx);
      return { data: accounts.get(id), meta: meta(ctx, { accountId: id }) };
    },

    /** POST /v1/accounts/{accountId}/session (admin, loopback only) */
    async connect(ctx) {
      const id = accountParam(ctx);
      const body = ctx.body === undefined ? {} : ctx.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("VALIDATION_FAILED", "Send { values, secrets } as a JSON object.");
      const before = safeStatus(accounts, id);
      let state;
      try {
        state = await accounts.connect(id, body);
      } catch (err) {
        await audit(deps, ctx, "account.connect_failed", id, { code: err instanceof BridgeError ? err.code : "INTERNAL", previousState: before });
        throw err;
      }
      await audit(deps, ctx, "account.connected", id, { broker: brokerOf(accounts, id), state: state.state, expiresAt: state.expiresAt, previousState: before });
      return { data: state, meta: meta(ctx, { accountId: id }) };
    },

    /** DELETE /v1/accounts/{accountId}/session (admin, loopback only) */
    async disconnect(ctx) {
      const id = accountParam(ctx);
      const before = safeStatus(accounts, id);
      const state = await accounts.disconnect(id);
      await audit(deps, ctx, "account.disconnected", id, { broker: brokerOf(accounts, id), state: state.state, previousState: before });
      return { data: state, meta: meta(ctx, { accountId: id }) };
    },

    /** POST /v1/accounts/{accountId}/test */
    async test(ctx) {
      const id = accountParam(ctx);
      const r = await accounts.testConnection(id);
      return { data: { ok: Boolean(r.ok), message: String(r.message ?? "") }, meta: meta(ctx, { accountId: id }) };
    },
  };
}

function safeStatus(accounts, id) {
  try {
    return accounts.status(id).state;
  } catch (err) {
    if (err instanceof BridgeError && err.code === "ACCOUNT_NOT_FOUND") throw err;
    return null;
  }
}

function brokerOf(accounts, id) {
  try {
    return accounts.get(id).broker;
  } catch {
    return null;
  }
}

/** S3's policy table for the routes (loaded once per register). */
export const loadRoutePolicies = loadBrokerPolicies;
