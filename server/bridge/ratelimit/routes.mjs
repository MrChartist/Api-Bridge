/**
 * Route handlers for the ratelimit module (docs/openapi.yaml, tag Limits): GET /v1/limits and GET /v1/usage.
 * Both answer { data, meta } and only show accounts the caller's key may use.
 */
import { effectiveAccountLimits } from "../core/config.mjs";
import { BridgeError } from "../core/errors.mjs";
import { budgetSummary } from "./budget.mjs";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Account ids the request may see: "*" for all (local callers and "*" keys), else a Set. */
export function visibleAccountIds(ctx) {
  if (ctx.principal?.kind === "local") return "*";
  const allowed = ctx.key?.accounts;
  if (allowed === "*") return "*";
  return new Set(Array.isArray(allowed) ? allowed : []);
}

const canSee = (visible, id) => visible === "*" || visible.has(id);

/** JSON has no Infinity: unlimited (paper) budgets are reported as null. */
const finite = (n) => (Number.isFinite(n) ? n : null);

/**
 * @param {object} deps  register() deps: config and the scheduler (this stream's own service).
 */
export function createLimitRoutes(deps) {
  const { config } = deps;
  const scheduler = deps.scheduler;

  function selectedAccounts(ctx) {
    const param = ctx.query.get("account");
    const visible = visibleAccountIds(ctx);
    if (param !== null) {
      if (!ACCOUNT_ID.test(param)) throw new BridgeError("VALIDATION_FAILED", "account must be 2-32 lowercase letters, digits or hyphens.", { errors: [{ path: "account", message: "invalid account id" }] });
      ctx.requireAccountAccess(param);
      const acc = config.accounts.find((a) => a.id === param);
      if (!acc) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${param}" in bridge.config.json.`);
      return { accountId: param, list: [acc] };
    }
    return { accountId: null, list: config.accounts.filter((a) => canSee(visible, a.id)) };
  }

  function budgets(account) {
    if (account.broker === "paper" || account.enabled === false) return null;
    try {
      const classes = {};
      const policy = scheduler.accountPolicy(account.id);
      for (const cls of Object.keys(policy.limits)) {
        const h = scheduler.headroom(account.id, cls);
        classes[cls] = { remaining: finite(h.remaining), limit: finite(h.limit), resetMs: h.resetMs };
      }
      return { accountId: account.id, broker: account.broker, classes };
    } catch (err) {
      // An account the AccountManager does not know (disabled, broker removed) has no live budget to show.
      if (err?.code === "ACCOUNT_NOT_FOUND" || err?.code === "NOT_IMPLEMENTED") return null;
      throw err;
    }
  }

  return {
    /** GET /v1/limits */
    getLimits(ctx) {
      const { accountId, list } = selectedAccounts(ctx);
      const safety = {};
      const brokers = {};
      const accounts = [];
      for (const a of list) {
        safety[a.id] = effectiveAccountLimits(config, a);
        if (a.broker !== "paper" && !brokers[a.broker]) brokers[a.broker] = scheduler.policyFor(a.broker);
        const b = budgets(a);
        if (b) accounts.push(b);
      }
      const c = scheduler.clientBudget(ctx);
      return {
        data: { safety, brokers, client: { perSecond: c.perSecond, burst: c.burst, remaining: c.remaining }, accounts },
        meta: { requestId: ctx.requestId, accountId },
      };
    },

    /**
     * GET /v1/usage[?series=1][?view=budget]: per account and class the binding window, every window (`windows`: this second, this
     * minute ...) and today's counters; with series=1 each account's calls per second over the last two minutes.
     * `consumers` (what used the budget today) is shown to admin keys and this computer only: it names API keys.
     */
    getUsage(ctx) {
      const visible = visibleAccountIds(ctx);
      if (ctx.query.get("view") === "budget") {
        let feeds = [];
        try {
          feeds = deps.streamHub?.stats?.().upstreams ?? [];
        } catch {
          feeds = [];
        }
        return { data: budgetSummary(scheduler.usage(), visible, { feeds }), meta: { requestId: ctx.requestId } };
      }
      const wantSeries = ["1", "true"].includes(String(ctx.query.get("series") ?? "").toLowerCase());
      const report = scheduler.usage({ series: wantSeries });
      const rows = report.accounts
        .filter((r) => canSee(visible, r.accountId))
        .map((r) => ({
          ...r,
          classes: Object.fromEntries(
            Object.entries(r.classes).map(([k, v]) => [k, { ...v, limit: finite(v.limit), ...(Array.isArray(v.windows) ? { windows: v.windows.map((w) => ({ ...w, limit: finite(w.limit) })) } : {}) }]),
          ),
        }));
      const admin = ctx.principal?.kind === "local" || Boolean(ctx.scopes?.has?.("admin"));
      const data = { accounts: rows, savings: report.savings, generatedAt: report.generatedAt };
      if (admin && Array.isArray(report.consumers)) data.consumers = report.consumers;
      return { data, meta: { requestId: ctx.requestId } };
    },
  };
}
