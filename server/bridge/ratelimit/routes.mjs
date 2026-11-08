/**
 * Route handlers for the ratelimit module (docs/openapi.yaml, tag Limits): GET /v1/limits, GET /v1/usage and the per-key
 * quotas (GET /v1/quotas, PUT and DELETE /v1/quotas/{keyId}). All answer { data, meta }; limits and usage only show
 * accounts the caller's key may use.
 *
 * GET /v1/limits?explain=1 adds to the usual answer (which is otherwise unchanged, byte for byte):
 *   pools      the adaptive state of every budget pool the caller may see: { group, accountId, broker, classes, accounts,
 *              spare, remaining, limit, ceiling, backoffFactor, backoffMs, episodesLastHour, frozen }
 *   consumers  who is competing for the broker queue now: { id, label, kind, weight, queued, inFlight, share } (all of
 *              them for admin keys and this computer, else only the caller's own)
 *   you        the caller's own quota: { keyId, source, perSecond, burst, perDay, weight, usage }
 */
import { effectiveAccountLimits } from "../core/config.mjs";
import { BridgeError, NotImplementedError } from "../core/errors.mjs";
import { budgetSummary } from "./budget.mjs";
import { DEFAULT_KIND_WEIGHTS } from "./consumer.mjs";

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

const KEY_ID = /^[a-z0-9]{4,32}$/;
const isAdmin = (ctx) => ctx.principal?.kind === "local" || Boolean(ctx.scopes?.has?.("admin"));
const truthy = (v) => ["1", "true"].includes(String(v ?? "").toLowerCase());

/**
 * @param {object} deps  register() deps: config and the scheduler (this stream's own service).
 */
export function createLimitRoutes(deps) {
  const { config } = deps;
  const scheduler = deps.scheduler;

  function needQuotas() {
    if (!scheduler?.quotas) throw new NotImplementedError("The per-key quotas");
    return scheduler.quotas;
  }

  /** One key's row of GET /v1/quotas. `rec` is a key record ({ id, label, clientKind }). */
  function quotaRow(rec) {
    const q = needQuotas().resolve(rec.id);
    const kinds = scheduler.clientWeights?.() ?? DEFAULT_KIND_WEIGHTS;
    return {
      keyId: rec.id,
      label: rec.label ?? null,
      clientKind: rec.clientKind ?? "other",
      weight: q.weight ?? kinds[rec.clientKind ?? "other"] ?? kinds.other,
      perSecond: q.perSecond,
      burst: q.burst,
      perDay: q.perDay,
      usage: scheduler.clientUsage(rec.id),
      source: q.source,
    };
  }

  /** A usable (not revoked, not expired) key record, or null. */
  async function findKey(keyId) {
    if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return null;
    let rec = null;
    try {
      rec = await deps.keyStore.get(keyId);
    } catch {
      return null; // key store not built: no key can be named
    }
    if (!rec || rec.revokedAt) return null;
    if (rec.expiresAt && Date.parse(rec.expiresAt) <= (deps.clock?.now?.() ?? Date.now())) return null;
    return rec;
  }

  async function audit(ctx, type, data) {
    try {
      await deps.audit.append({ type, actor: { kind: ctx.principal.kind, id: ctx.principal.id }, source: ctx.source, requestId: ctx.requestId, data });
    } catch (err) {
      if (err instanceof NotImplementedError) ctx.log.warn("audit log not built yet; quota change not audited", { type, keyId: data.keyId });
      else ctx.log.error("audit append failed for quota change", { type, keyId: data.keyId, err });
    }
  }

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
      const data = { safety, brokers, client: { perSecond: c.perSecond, burst: c.burst, remaining: c.remaining }, accounts };
      if (truthy(ctx.query.get("explain"))) {
        const ids = list.filter((a) => a.broker !== "paper").map((a) => a.id);
        data.pools = typeof scheduler.pools === "function" ? scheduler.pools({ accountIds: ids }) : [];
        const own = ctx.key?.id ? `key:${ctx.key.id}` : null;
        data.consumers = (typeof scheduler.consumers === "function" ? scheduler.consumers() : []).filter((x) => isAdmin(ctx) || x.id === own);
        if (ctx.key?.id && scheduler.quotas) data.you = quotaRow(ctx.key);
      }
      return { data, meta: { requestId: ctx.requestId, accountId } };
    },

    /**
     * GET /v1/quotas: the default budget, the weight of each client kind and one row per API key (rate, burst, daily cap,
     * fair-queue weight, usage today and which layer set it). Only admin keys and this computer see every key; any
     * other key sees its own row.
     */
    async getQuotas(ctx) {
      const quotas = needQuotas();
      const d = quotas.defaults();
      let records = [];
      try {
        records = await deps.keyStore.list();
      } catch {
        // key store not built: show the keys that have settings
        records = [...new Set([...quotas.configIds(), ...quotas.overrideIds()])].map((id) => ({ id, label: null, clientKind: "other" }));
      }
      const t = deps.clock?.now?.() ?? Date.now();
      const active = records.filter((r) => !r.revokedAt && !(r.expiresAt && Date.parse(r.expiresAt) <= t));
      const shown = isAdmin(ctx) ? active : active.filter((r) => r.id === ctx.key?.id);
      return {
        data: {
          default: { perSecond: d.perSecond, burst: d.burst, perDay: d.perDay, maxConcurrent: d.maxConcurrent ?? scheduler.clientLimits().maxConcurrent },
          kinds: scheduler.clientWeights?.() ?? { ...DEFAULT_KIND_WEIGHTS },
          keys: shown.map(quotaRow),
        },
        meta: { requestId: ctx.requestId },
      };
    },

    /**
     * PUT /v1/quotas/{keyId} (admin, this computer): replace the key's override with { perSecond?, burst?, weight?, perDay? }.
     * Fields left out fall back to the config entry or the default. Persisted in quotas.json; effective at once.
     */
    async putQuota(ctx) {
      const quotas = needQuotas();
      const keyId = ctx.params.keyId;
      const rec = await findKey(keyId);
      if (!rec) throw new BridgeError("NOT_FOUND", `There is no active API key with id "${String(keyId).slice(0, 40)}".`);
      const r = quotas.set(keyId, ctx.body);
      if (!r.ok) throw new BridgeError("VALIDATION_FAILED", "The quota is not valid.", { errors: r.errors });
      await audit(ctx, "quota.set", { keyId, quota: quotas.override(keyId) });
      return { data: quotaRow(rec), meta: { requestId: ctx.requestId } };
    },

    /** DELETE /v1/quotas/{keyId} (admin, this computer): remove the override; the config entry or the default applies again. */
    async deleteQuota(ctx) {
      const quotas = needQuotas();
      const keyId = ctx.params.keyId;
      const rec = await findKey(keyId);
      if (!rec) throw new BridgeError("NOT_FOUND", `There is no active API key with id "${String(keyId).slice(0, 40)}".`);
      const had = quotas.clear(keyId);
      if (had) await audit(ctx, "quota.cleared", { keyId });
      return { data: quotaRow(rec), meta: { requestId: ctx.requestId } };
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
