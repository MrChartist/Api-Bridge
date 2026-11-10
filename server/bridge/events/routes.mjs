/**
 * Event routes (docs/openapi.yaml tags "Events" and "Webhooks out").
 *
 *   GET    /v1/events/stream                      SSE, same credentials as /v1/stream/sse (see clients.mjs)
 *   GET    /v1/events/topics                      read    the topics this key may receive
 *   GET    /v1/events                             read    replay as JSON: ?since=<cursor>&topics=&accounts=&limit=
 *   GET    /v1/events/status                      admin   log, connections, webhook queue
 *   GET    /v1/subscriptions                      admin   webhook subscriptions (URL path and secret never shown)
 *   POST   /v1/subscriptions                      admin, this computer only: { url, topics, secret, active?, label?, accounts? }
 *   GET    /v1/subscriptions/{id}
 *   PATCH  /v1/subscriptions/{id}                 admin, this computer only (a changed URL or secret is a changed target)
 *   DELETE /v1/subscriptions/{id}
 *   POST   /v1/subscriptions/{id}/test            admin, this computer only: one signed test delivery, not retried
 *   GET    /v1/subscriptions/{id}/deliveries      every attempt, newest first
 *   GET    /v1/subscriptions/{id}/dead-letters    events that could not be delivered
 *   POST   /v1/subscriptions/{id}/dead-letters/{deliveryId}/retry
 *   DELETE /v1/subscriptions/{id}/dead-letters
 *
 * Events are read-only notifications. No route here, and no field in any answer, can approve, confirm or place an order,
 * and nothing returns a signing secret or the URL's path.
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { json, noContent } from "../core/http.mjs";
import { pageParams, paginate } from "../core/paginate.mjs";
import { canSee, matchesAny, topicInfo, topicsFor, viewerOf } from "./catalog.mjs";
import { parseStreamQuery } from "./clients.mjs";
import { toEnvelope } from "./eventLog.mjs";
import { SUBSCRIPTION_ID_RE } from "./webhooks.mjs";

const accountsField = z.union([z.literal("*"), z.array(z.string().max(32)).min(1).max(100)]);
const createBody = z
  .object({ url: z.string().max(2048), topics: z.array(z.string().max(64)).min(1).max(50), secret: z.string().max(256), active: z.boolean().optional(), label: z.string().max(60).optional(), accounts: accountsField.optional() })
  .strict();
const patchBody = z
  .object({ url: z.string().max(2048).optional(), topics: z.array(z.string().max(64)).min(1).max(50).optional(), secret: z.string().max(256).optional(), active: z.boolean().optional(), label: z.union([z.string().max(60), z.null()]).optional(), accounts: accountsField.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Send at least one field to change." });

const parse = (schema, value, detail) => {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
};
const NO_STORE = { "Cache-Control": "no-store" };
const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

/** @param {{ eventLog: any, webhooks: any, registry: any, audit?: any, cfg: any }} deps */
export function createEventsRoutes({ eventLog, webhooks, registry, audit, cfg }) {
  const note = async (ctx, type, data) => {
    try {
      await audit?.append?.({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", requestId: ctx.requestId, data });
    } catch {
      /* a missing audit log must not undo a setting */
    }
  };
  const subId = (ctx) => {
    const id = String(ctx.params.subscriptionId ?? "");
    if (!SUBSCRIPTION_ID_RE.test(id)) throw new BridgeError("NOT_FOUND", "No webhook subscription with this id.");
    return id;
  };
  const brief = (s) => ({ id: s.id, host: s.host, topics: s.topics, active: s.active });

  return {
    getTopics(ctx) {
      const viewer = viewerOf(ctx.key);
      return { data: topicsFor(viewer).map((t) => ({ topic: t.topic, scope: t.scope, accountScoped: t.accounts, description: t.description })), meta: meta(ctx, { patterns: 'A filter may be a topic, a prefix such as "order.*", or "*".' }) };
    },

    /** Polling twin of the stream: the same events, filters and cursor, as one JSON answer. */
    listEvents(ctx) {
      const q = parseStreamQuery(ctx.query, undefined);
      const limit = Math.min(500, Math.max(1, Number.parseInt(ctx.query.get("limit") ?? "100", 10) || 100));
      const viewer = viewerOf(ctx.key);
      const pass = (e) => canSee(viewer, e) && matchesAny(q.patterns, e.topic) && (!q.accounts || !topicInfo(e.topic)?.accounts || q.accounts.has(e.data?.accountId));
      let r;
      if (q.since === null) {
        r = eventLog.since(0, { filter: pass, limit: Number.MAX_SAFE_INTEGER });
        r = { ...r, events: r.events.slice(-limit), gap: false, gapReason: null, more: false };
      } else r = eventLog.since(q.since, { filter: pass, limit });
      const cursor = String(r.events.at(-1)?.seq ?? (q.since ?? r.latest));
      return json(
        // nextCursor is the same cursor under the name every list route uses: pass it as `since` for the next page (null when there is no more).
        { data: r.events.map(toEnvelope), meta: meta(ctx, { cursor, nextCursor: r.more ? cursor : null, latest: String(r.latest), oldest: r.oldest === null ? null : String(r.oldest), gap: r.gap, gapReason: r.gapReason, hasMore: r.more }) },
        { headers: NO_STORE },
      );
    },

    getStatus(ctx) {
      return { data: { log: eventLog.stats(), clients: registry.stats(), webhooks: webhooks.status(), limits: { retain: cfg.retain, maxClients: cfg.maxClients, maxClientsPerKey: cfg.maxClientsPerKey } }, meta: meta(ctx) };
    },

    listSubscriptions(ctx) {
      const { limit, cursor } = pageParams(ctx.query);
      const { items, nextCursor } = paginate(webhooks.list(), { limit, cursor, keyOf: (s) => s.id });
      return { data: items, meta: meta(ctx, { nextCursor }) };
    },
    async createSubscription(ctx) {
      const body = parse(createBody, ctx.body, 'Send { "url": "https://...", "topics": ["order.*"], "secret": "<16 to 256 characters>" }.');
      const s = await webhooks.create(body);
      await note(ctx, "subscription.created", brief(s));
      return json({ data: s, meta: meta(ctx) }, { status: 201, headers: NO_STORE });
    },
    getSubscription(ctx) {
      return { data: webhooks.get(subId(ctx)), meta: meta(ctx) };
    },
    async patchSubscription(ctx) {
      const body = parse(patchBody, ctx.body, "Send the fields to change: url, topics, secret, active, label, accounts.");
      const s = await webhooks.update(subId(ctx), body);
      await note(ctx, "subscription.updated", { ...brief(s), changed: Object.keys(body) });
      return json({ data: s, meta: meta(ctx) }, { headers: NO_STORE });
    },
    async deleteSubscription(ctx) {
      const id = subId(ctx);
      await webhooks.remove(id);
      await note(ctx, "subscription.deleted", { id });
      return noContent();
    },
    async testSubscription(ctx) {
      const id = subId(ctx);
      const r = await webhooks.test(id);
      await note(ctx, "subscription.tested", { id, ok: r.ok, code: r.code });
      return json({ data: r, meta: meta(ctx) }, { headers: NO_STORE });
    },
    listDeliveries(ctx) {
      const limit = Math.min(500, Math.max(1, Number.parseInt(ctx.query.get("limit") ?? "100", 10) || 100));
      const outcome = ctx.query.get("outcome") ?? undefined;
      if (outcome !== undefined && !["delivered", "retry", "dead", "failed"].includes(outcome)) throw new BridgeError("VALIDATION_FAILED", "outcome is delivered, retry, dead or failed.");
      return { data: webhooks.deliveries(subId(ctx), { limit, outcome }), meta: meta(ctx) };
    },
    listDeadLetters(ctx) {
      const { limit, cursor } = pageParams(ctx.query);
      const { items, nextCursor } = paginate(webhooks.deadLetters(subId(ctx)), { limit, cursor, keyOf: (d) => d.id });
      return { data: items, meta: meta(ctx, { nextCursor }) };
    },
    async retryDeadLetter(ctx) {
      const id = subId(ctx);
      const r = await webhooks.retryDead(id, ctx.params.deliveryId);
      await note(ctx, "subscription.dead_letter_retried", { id, deliveryId: r.id });
      return json({ data: r, meta: meta(ctx) }, { status: 202 });
    },
    async clearDeadLetters(ctx) {
      const id = subId(ctx);
      const r = webhooks.clearDead(id);
      await note(ctx, "subscription.dead_letters_cleared", { id, removed: r.removed });
      return { data: r, meta: meta(ctx) };
    },
  };
}
