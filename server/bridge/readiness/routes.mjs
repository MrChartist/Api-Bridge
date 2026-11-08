/**
 * Readiness routes (docs/openapi.yaml, tag Readiness). { data, meta }.
 *
 *   GET  /v1/readiness            read   cached state of each live account the key may see (no broker call)
 *   POST /v1/readiness/check      read   re-check now (probe and egress lookup, each with a 30 s cooldown); ≤ 12 s
 *   GET  /v1/readiness/history    read   recent transitions, newest first
 *   POST /v1/demo/readiness       read   demo mode only (demo/routes.mjs): simulate a failure on the demo account
 *
 * IP addresses (egress.ip, checks.egress.detectedIp / registeredIp / backupIp, seenBy) are shown only to callers on
 * this computer or with the admin scope. Everyone else sees only whether they match.
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { accountFilter } from "../safety/routes.mjs";
import { DEMO_SCENARIOS } from "../demo/demoReadiness.mjs";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const accountId = z.string().regex(ACCOUNT_ID, "2-32 lowercase letters, digits or hyphens");
const checkBody = z.object({ account: accountId.optional() }).strict();
const demoBody = z.object({ scenario: z.enum(DEMO_SCENARIOS) }).strict();

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/** Whether this caller may see IP addresses: this computer, or a key with the admin scope. */
export const canSeeIp = (ctx) => Boolean(ctx?.loopback || ctx?.principal?.kind === "local" || ctx?.scopes?.has?.("admin"));

/** Remove every IP field (and the lookup host) from a snapshot, for callers that may not see them. */
export function redactSnapshot(snap) {
  const out = { ...snap };
  if (out.egress) {
    const { ip: _ip, seenBy: _s, ...rest } = out.egress;
    out.egress = rest;
  }
  out.accounts = (snap.accounts ?? []).map((a) => {
    if (!a.checks?.egress) return a;
    const { detectedIp: _d, registeredIp: _r, backupIp: _b, seenBy: _sb, ...eg } = a.checks.egress;
    return { ...a, checks: { ...a.checks, egress: eg } };
  });
  return out;
}

function parseWith(schema, value, detail) {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
}

/**
 * @param {{ readiness: any, config: any }} deps
 */
export function createReadinessRoutes(deps) {
  const { readiness, config } = deps;
  const known = (id) => (config.accounts ?? []).some((a) => a.id === id);

  /** Visible tracked account ids for this caller, after checking any requested ids. */
  function visibleIds(ctx, requested) {
    const canSee = accountFilter(ctx);
    for (const id of requested ?? []) {
      if (!known(id)) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${id}" in bridge.config.json.`);
      if (!canSee(id)) throw new BridgeError("ACCOUNT_FORBIDDEN", `This API key may not use account ${id}.`);
    }
    const ids = readiness.trackedIds().filter(canSee);
    return requested?.length ? ids.filter((id) => requested.includes(id)) : ids;
  }

  const shape = (ctx, snap) => (canSeeIp(ctx) ? snap : redactSnapshot(snap));

  function readQuery(ctx, allowed) {
    for (const k of new Set([...ctx.query.keys()])) {
      if (!allowed.includes(k)) throw new BridgeError("VALIDATION_FAILED", `Unknown query parameter ${k}.`, { errors: [{ path: k, message: "not allowed" }] });
    }
  }

  return {
    /** GET /v1/readiness */
    getReadiness(ctx) {
      readQuery(ctx, ["account"]);
      const requested = ctx.query.getAll("account");
      if (requested.length > 20) throw new BridgeError("VALIDATION_FAILED", "Ask for at most 20 accounts.", { errors: [{ path: "account", message: "at most 20" }] });
      for (const id of requested) parseWith(accountId, id, "account must be an account id.");
      const ids = visibleIds(ctx, requested);
      return { data: shape(ctx, readiness.status({ accountIds: ids })), meta: meta(ctx) };
    },

    /** POST /v1/readiness/check */
    async checkReadiness(ctx) {
      const body = parseWith(checkBody, ctx.body ?? {}, 'Send { "account": "<id>" } or an empty body.');
      const ids = visibleIds(ctx, body.account ? [body.account] : []);
      if (body.account && !ids.includes(body.account)) {
        // A known account the monitor does not track (a paper account): nothing to check.
        return { data: shape(ctx, readiness.status({ accountIds: [] })), meta: meta(ctx, { skipped: [] }) };
      }
      // One call over the ids this key may see; its snapshot carries the 12 s "Still checking" overlay, so the
      // answer never shows an earlier probe's result while a probe or lookup is still running.
      const r = await readiness.checkNow(body.account ? { accountId: body.account, reason: "manual" } : { accountIds: ids, reason: "manual" });
      return { data: shape(ctx, r.snapshot), meta: meta(ctx, { skipped: r.skipped }) };
    },

    /** GET /v1/readiness/history */
    getHistory(ctx) {
      readQuery(ctx, ["account", "limit"]);
      const q = parseWith(
        z.object({ account: accountId.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(),
        Object.fromEntries(ctx.query),
        "account must be an account id and limit 1 to 200.",
      );
      if (ctx.query.getAll("account").length > 1) throw new BridgeError("VALIDATION_FAILED", "Send account only once.", { errors: [{ path: "account", message: "repeated" }] });
      const ids = visibleIds(ctx, q.account ? [q.account] : []);
      return { data: readiness.history({ accountIds: ids, limit: q.limit }), meta: meta(ctx, { kept: readiness.transitionsKept }) };
    },

    /** POST /v1/demo/readiness (registered only in demo mode) */
    async demoScenario(ctx) {
      const body = parseWith(demoBody, ctx.body ?? {}, `Send { "scenario": "${DEMO_SCENARIOS.join('" | "')}" }.`);
      await readiness.demoScenario(body.scenario);
      const ids = visibleIds(ctx, []);
      return { data: shape(ctx, readiness.status({ accountIds: ids })), meta: meta(ctx) };
    },
  };
}
