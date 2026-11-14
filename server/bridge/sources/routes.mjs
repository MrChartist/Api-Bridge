/**
 * Route handlers for the sources module (docs/openapi.yaml, tag Sources). All answer { data, meta }; the three
 * write routes also repeat the fields of `data` at the top level, so a client reading the documented body shape
 * `{ configured: true }` or `{ ok, latencyMs }` works as well as one reading `data`.
 *
 *  GET   /v1/sources              read    every source with its state, usage and health
 *  PATCH /v1/sources/settings     admin, this computer only   { autoFallback } the use-free-sources-automatically switch
 *  PATCH /v1/sources/:id          admin, this computer only   { enabled?, acknowledge? } switch on or off
 *  PUT   /v1/sources/:id/config   admin, this computer only   { apiKey } save (or, with null, remove) a key
 *  POST  /v1/sources/:id/test     admin, this computer only   ask the source to prove it works
 *
 * Nothing here returns or logs an API key: the key goes from the request body straight to the secrets store.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";

/** [method, path, route options, handler name]. Keep in step with docs/openapi.yaml. */
export const ROUTES = Object.freeze([
  ["GET", "/v1/sources", { scope: "read", summary: "Data sources: state, limits, usage and health" }, "list"],
  ["PATCH", "/v1/sources/settings", { scope: "admin", loopbackOnly: true, bodyLimitBytes: 512, summary: "Change a setting that applies to all data sources" }, "patchSettings"],
  ["PATCH", "/v1/sources/:id", { scope: "admin", loopbackOnly: true, bodyLimitBytes: 1024, summary: "Switch a data source on or off" }, "patch"],
  ["PUT", "/v1/sources/:id/config", { scope: "admin", loopbackOnly: true, bodyLimitBytes: 4096, summary: "Save the API key of a data source (this computer only)" }, "putConfig"],
  ["POST", "/v1/sources/:id/test", { scope: "admin", loopbackOnly: true, body: "none", summary: "Test a data source" }, "test"],
]);

export const SOURCES_NOTICE = "Sources other than your own broker accounts are labelled delayed or end-of-day. They never answer orders, risk checks, paper fills or alerts, and the Bridge does not redistribute their data.";

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });

function sourceId(ctx) {
  const id = ctx.params.id;
  if (!ID_RE.test(String(id ?? ""))) throw new BridgeError("NOT_FOUND", "There is no data source with this id.");
  return id;
}

function bodyObject(ctx, example) {
  const b = ctx.body;
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) throw new BridgeError("VALIDATION_FAILED", `Send a JSON object such as ${example}.`);
  return b;
}

/** Append to the audit log; a missing or failing log is noted, never fatal (the change is already made). */
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

/** @param {{ backupData: ReturnType<import("./service.mjs").createSourcesService> }} deps */
export function createSourcesRoutes(deps) {
  const svc = () => deps.backupData;
  return {
    list(ctx) {
      return { data: svc().list(), meta: meta(ctx, { notice: SOURCES_NOTICE, autoFallback: svc().autoFallback?.() === true, autoFallbackSource: svc().autoFallbackSource?.() ?? "default" }) };
    },
    async patchSettings(ctx) {
      const body = bodyObject(ctx, '{ "autoFallback": true }');
      const unknown = Object.keys(body).filter((k) => k !== "autoFallback");
      if (unknown.length) throw new BridgeError("VALIDATION_FAILED", `Unknown field: ${unknown.slice(0, 5).join(", ")}. Send autoFallback.`, { errors: unknown.slice(0, 5).map((k) => ({ path: String(k).slice(0, 40), message: "unknown field" })) });
      if (typeof body.autoFallback !== "boolean") throw new BridgeError("VALIDATION_FAILED", "autoFallback must be true or false.", { errors: [{ path: "autoFallback", message: "must be true or false" }] });
      const before = svc().autoFallback() === true;
      const data = svc().setAutoFallback(body.autoFallback);
      await audit(deps, ctx, "sources.setting_changed", { setting: "autoFallback", from: before, to: data.autoFallback });
      return { ...data, data, meta: meta(ctx) };
    },
    async patch(ctx) {
      const id = sourceId(ctx);
      const body = bodyObject(ctx, '{ "enabled": true }');
      const unknown = Object.keys(body).filter((k) => k !== "enabled" && k !== "acknowledge");
      if (unknown.length) throw new BridgeError("VALIDATION_FAILED", `Unknown field: ${unknown.join(", ")}. Send enabled and, for a source that asks for it, acknowledge.`, { errors: unknown.map((k) => ({ path: k, message: "unknown field" })) });
      if (typeof body.enabled !== "boolean") throw new BridgeError("VALIDATION_FAILED", "enabled must be true or false.", { errors: [{ path: "enabled", message: "must be true or false" }] });
      if (body.acknowledge !== undefined && typeof body.acknowledge !== "string") throw new BridgeError("VALIDATION_FAILED", "acknowledge must be the notice version as text.", { errors: [{ path: "acknowledge", message: "must be text" }] });
      const data = await svc().setEnabled(id, body.enabled, { acknowledge: body.acknowledge });
      return { ...data, data, meta: meta(ctx) };
    },
    async putConfig(ctx) {
      const id = sourceId(ctx);
      const body = bodyObject(ctx, '{ "apiKey": "..." }');
      // Only the service touches the key. Its answer is { configured }, never the key.
      const data = await svc().setConfig(id, body);
      return { ...data, data, meta: meta(ctx) };
    },
    async test(ctx) {
      const id = sourceId(ctx);
      const data = await svc().test(id);
      return { ...data, data, meta: meta(ctx) };
    },
  };
}
