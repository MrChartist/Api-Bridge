/**
 * Recorder routes (docs/openapi.yaml, tag "Recordings"). Reading needs a `read` key; anything that starts, changes or
 * deletes a recording or a rule needs an admin key from this computer (a recording uses this computer's disk and your
 * broker's API budget). Files are streamed as they are on disk; every answer says its data class (always realtime).
 *
 *   GET    /v1/recordings                              the recordings, with a plain status line
 *   POST   /v1/recordings                              start a manual recording
 *   GET    /v1/recordings/status                       the plain line: "Recording today: 3 rules, 41 symbols, 18 MB, last write 09:31:02"
 *   GET    /v1/recordings/auto, PUT /v1/recordings/auto   the auto-record switch (off until a person turns it on)
 *   GET    /v1/recordings/presets, POST /v1/recordings/presets/{preset}/apply
 *   GET/POST /v1/recordings/rules, GET/PATCH/DELETE /v1/recordings/rules/{ruleId}
 *   GET    /v1/recordings/{id}, DELETE /v1/recordings/{id}
 *   POST   /v1/recordings/{id}/pause | resume | stop
 *   GET    /v1/recordings/{id}/files, GET /v1/recordings/{id}/files/{name}
 */
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { json, noContent } from "../core/http.mjs";

const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });
const parse = (schema, value, detail) => {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
};
const NO_STORE = { "Cache-Control": "no-store" };
const ID_RE = /^(rec_[a-z0-9]{4,20}|rule-[a-z0-9-]{2,41})$/;
const RULE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const FILE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}__[A-Za-z0-9_&.-]{1,80}\.(csv|jsonl)(\.gz)?$/;

const autoBody = z.object({ enabled: z.boolean() }).strict();
const presetBody = z.object({ collection: z.string().trim().min(1).max(80).optional() }).strict();

/** @param {{ recorder: any, audit?: any }} deps */
export function createRecorderRoutes(deps) {
  const svc = () => deps.recorder;
  const recId = (ctx) => {
    const id = String(ctx.params.id ?? "");
    if (!ID_RE.test(id)) throw new BridgeError("NOT_FOUND", "No recording with this id.");
    return id;
  };
  const ruleId = (ctx) => {
    const id = String(ctx.params.ruleId ?? "");
    if (!RULE_ID_RE.test(id)) throw new BridgeError("NOT_FOUND", "No auto-record rule with this id.");
    return id;
  };
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", requestId: ctx.requestId, data });
    } catch {
      /* the audit log reports its own failure; a recording is not undone by it */
    }
  };

  return {
    async list(ctx) {
      const s = svc().status();
      return { data: svc().list(), meta: meta(ctx, { status: s.line, dataClass: "realtime" }) };
    },
    async create(ctx) {
      const rec = await svc().create(ctx.body ?? {}, { who: ctx.principal?.kind === "key" ? `key:${ctx.principal.id}` : "this-computer" });
      await audit(ctx, "recording.created", { id: rec.id, kind: rec.kind, everySec: rec.everySec });
      return json({ data: rec, meta: meta(ctx) }, { status: 201, headers: NO_STORE });
    },
    async getStatus(ctx) {
      return { data: svc().status(), meta: meta(ctx) };
    },
    async get(ctx) {
      return { data: svc().get(recId(ctx)), meta: meta(ctx, { dataClass: "realtime" }) };
    },
    async pause(ctx) {
      const data = svc().pause(recId(ctx));
      await audit(ctx, "recording.paused", { id: data.id });
      return { data, meta: meta(ctx) };
    },
    async resume(ctx) {
      const data = svc().resume(recId(ctx));
      await audit(ctx, "recording.resumed", { id: data.id });
      return { data, meta: meta(ctx) };
    },
    async stop(ctx) {
      const data = svc().stop(recId(ctx));
      await audit(ctx, "recording.stopped", { id: data.id });
      return { data, meta: meta(ctx) };
    },
    async remove(ctx) {
      const id = recId(ctx);
      svc().remove(id);
      await audit(ctx, "recording.deleted", { id });
      return noContent();
    },
    async files(ctx) {
      const id = recId(ctx);
      return { data: svc().files(id), meta: meta(ctx, { dataClass: "realtime", layout: "one file per symbol per IST trading day" }) };
    },
    async getFile(ctx) {
      const id = recId(ctx);
      const name = String(ctx.params.name ?? "");
      if (!FILE_RE.test(name)) throw new BridgeError("NOT_FOUND", "No such file in this recording.");
      const f = svc().openFile(id, name);
      const type = f.compressed ? "application/gzip" : f.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8";
      ctx.res.writeHead(200, { ...ctx.responseHeaders, "Content-Type": type, "Content-Length": String(f.size), "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Data-Class": "realtime", "X-Content-Type-Options": "nosniff" });
      await pipeline(f.stream(), ctx.res);
      return undefined;
    },

    async getAuto(ctx) {
      return { data: svc().auto(), meta: meta(ctx) };
    },
    async putAuto(ctx) {
      const body = parse(autoBody, ctx.body, 'Send { "enabled": true } or { "enabled": false }.');
      const data = await svc().setAuto(body.enabled);
      await audit(ctx, "recording.auto_changed", { enabled: body.enabled });
      return { data, meta: meta(ctx) };
    },
    async listPresets(ctx) {
      return { data: svc().presets(), meta: meta(ctx) };
    },
    async applyPreset(ctx) {
      const body = parse(presetBody, ctx.body);
      const data = await svc().applyPreset(String(ctx.params.presetId ?? ""), body);
      await audit(ctx, "recording.preset_applied", { preset: data.preset, created: data.created });
      return json({ data, meta: meta(ctx) }, { status: data.created ? 201 : 200, headers: NO_STORE });
    },
    async listRules(ctx) {
      return { data: svc().listRules(), meta: meta(ctx, { auto: svc().auto().enabled }) };
    },
    async createRule(ctx) {
      const data = await svc().createRule(ctx.body ?? {});
      await audit(ctx, "recording.rule_created", { ruleId: data.id, kind: data.kind });
      return json({ data, meta: meta(ctx) }, { status: 201, headers: NO_STORE });
    },
    async getRule(ctx) {
      return { data: svc().getRule(ruleId(ctx)), meta: meta(ctx) };
    },
    async patchRule(ctx) {
      const id = ruleId(ctx);
      const data = await svc().patchRule(id, ctx.body ?? {});
      await audit(ctx, "recording.rule_changed", { ruleId: id });
      return { data, meta: meta(ctx) };
    },
    async deleteRule(ctx) {
      const id = ruleId(ctx);
      const deleteFiles = ctx.query.get("deleteFiles") === "true";
      svc().deleteRule(id, { deleteFiles });
      await audit(ctx, "recording.rule_deleted", { ruleId: id, deleteFiles });
      return noContent();
    },
  };
}
