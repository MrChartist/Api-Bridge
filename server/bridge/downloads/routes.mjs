/**
 * Download routes (docs/openapi.yaml, tag "Data downloads"). JSON answers are { data, meta }; files are streamed.
 *
 *   POST   /v1/downloads[?dryRun=1]                    start a job (202), or only estimate it (200)
 *   GET    /v1/downloads[?status=&tag=&include=items]  newest first
 *   GET|PATCH /v1/downloads/settings   the budget share and the after-hours switch (this computer, admin, to change)
 *   GET    /v1/downloads/{id}      PATCH /v1/downloads/{id}      DELETE /v1/downloads/{id}
 *   POST   /v1/downloads/{id}/pause | resume | cancel
 *   GET    /v1/downloads/{id}/files        GET /v1/downloads/{id}/files/{name}   (manifest.json is one of them)
 *   GET    /v1/datasets[?tag=]             GET|PATCH|DELETE /v1/datasets/{name}   POST /v1/datasets/{name}/update
 *   GET    /v1/instruments/export?exchange=&kind=&format=csv|jsonl
 *
 * A job, a dataset or a file is named by an id or a name the Bridge made or checked itself; no client-chosen path ever
 * reaches the disk. Every file answer carries its data class, source and delay in headers (X-Data-Class and friends).
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BridgeError } from "../core/errors.mjs";
import { json, toCsv } from "../core/http.mjs";
import { pageParams, paginate } from "../core/paginate.mjs";
import { BASE_HEADERS } from "../core/security.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";
import { istDate } from "../market/time.mjs";
import { toPublicInstrument } from "../symbols/routes.mjs";
import { CONTENT_TYPES } from "./bars.mjs";

const STATUSES = ["queued", "running", "paused", "done", "failed", "cancelled"];
const EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];
const KINDS = ["INDEX", "EQ", "FUT", "OPT"];
const INSTRUMENT_COLUMNS = ["symbol", "exchange", "kind", "underlying", "name", "expiry", "strike", "right", "lotSize", "tickSize", "freezeQty", "isin"];
const PAGE = 500;
/** Most jobs one list answer returns. */
const LIST_MAX = 500;

const opt = (q, name) => {
  const v = q.get(name);
  return v === null || v === "" ? undefined : v;
};
const invalid = (path, detail) => new BridgeError("VALIDATION_FAILED", detail, { errors: [{ path, message: detail }] });

function flag(q, name) {
  const v = opt(q, name);
  if (v === undefined) return false;
  const s = v.toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  throw invalid(name, `${name} must be 1 or true, or 0 or false.`);
}

/**
 * @param {object} deps full deps passed to register()
 * @param {{ downloads: ReturnType<typeof import("./manager.mjs").createDownloadManager> }} o
 */
export function createDownloadRoutes(deps, { downloads }) {
  const meta = (ctx, extra = {}) => ({ requestId: ctx.requestId, ...extra });
  const callOpts = (ctx) => ({ allowedAccounts: allowedAccountsFor(ctx), actor: actorOf(ctx) });
  /** Who is asking: the key's id (or "local" for this computer's control token) and whether it is an admin. Owners and admins may change a job. */
  const actorOf = (ctx) => ({ id: ctx.principal?.kind === "key" ? `key:${ctx.principal.id}` : "local", admin: ctx.scopes?.has("admin") === true });
  /** Deletes, cancels, renames and new jobs are written to the audit log (never the request body). A failed audit write does not undo the action. */
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", requestId: ctx.requestId, data });
    } catch (err) {
      ctx.log?.warn?.("audit append failed for a download action", { type, err });
    }
  };

  /** Headers for a stream the handler writes itself (the pipeline's base headers, this request's id, rate-limit headers). */
  const streamHeaders = (ctx, extra) => ({ ...BASE_HEADERS, "X-Request-Id": ctx.requestId, "Cache-Control": "no-store", ...ctx.responseHeaders, ...extra });

  return {
    async create(ctx) {
      const body = ctx.body ?? {};
      if (body && typeof body === "object" && typeof body.account === "string") ctx.requireAccountAccess(body.account);
      if (flag(ctx.query, "dryRun")) return { data: await downloads.estimate(body, callOpts(ctx)), meta: meta(ctx, { dryRun: true }) };
      const { job } = await downloads.create(body, callOpts(ctx));
      await audit(ctx, "download.created", { id: job.id, name: job.name, dataset: job.dataset, symbols: job.request?.symbols?.length ?? null, intervals: job.request?.intervals ?? null, backup: job.request?.backup === true });
      return json({ data: job, meta: meta(ctx) }, { status: 202, headers: { Location: `/v1/downloads/${job.id}` } });
    },

    getSettings: (ctx) => ({ data: downloads.settings(), meta: meta(ctx) }),
    async patchSettings(ctx) {
      return { data: await downloads.setSettings(ctx.body), meta: meta(ctx) };
    },

    list(ctx) {
      const status = opt(ctx.query, "status");
      if (status !== undefined && !STATUSES.includes(status)) throw invalid("status", `status must be one of ${STATUSES.join(", ")}.`);
      const include = opt(ctx.query, "include");
      if (include !== undefined && include !== "items") throw invalid("include", "include accepts only items.");
      const { limit, cursor } = pageParams(ctx.query, { defaultLimit: 100, maxLimit: LIST_MAX });
      const all = downloads.list({ status, tag: opt(ctx.query, "tag"), items: include === "items" });
      const { items, nextCursor } = paginate(all, { limit, cursor, keyOf: (j) => j.id });
      return { data: items, meta: meta(ctx, { total: all.length, nextCursor }) };
    },

    get: (ctx) => ({ data: downloads.get(ctx.params.downloadId), meta: meta(ctx) }),
    async patch(ctx) {
      const data = await downloads.patchJob(ctx.params.downloadId, ctx.body, { actor: actorOf(ctx) });
      await audit(ctx, "download.changed", { id: data.id });
      return { data, meta: meta(ctx) };
    },
    async pause(ctx) {
      const data = await downloads.pause(ctx.params.downloadId, { actor: actorOf(ctx) });
      await audit(ctx, "download.paused", { id: data.id });
      return { data, meta: meta(ctx) };
    },
    async resume(ctx) {
      const data = await downloads.resume(ctx.params.downloadId, { actor: actorOf(ctx) });
      await audit(ctx, "download.resumed", { id: data.id });
      return { data, meta: meta(ctx) };
    },
    async cancel(ctx) {
      const data = await downloads.cancel(ctx.params.downloadId, { actor: actorOf(ctx) });
      await audit(ctx, "download.cancelled", { id: data.id, createdBy: data.createdBy });
      return { data, meta: meta(ctx) };
    },
    async remove(ctx) {
      const before = downloads.get(ctx.params.downloadId);
      await downloads.remove(ctx.params.downloadId);
      await audit(ctx, "download.deleted", { id: before.id, name: before.name, dataset: before.dataset, createdBy: before.createdBy });
      return undefined;
    },
    files: (ctx) => ({ data: downloads.files(ctx.params.downloadId), meta: meta(ctx, { manifestUrl: `/v1/downloads/${ctx.params.downloadId}/files/manifest.json` }) }),

    async file(ctx) {
      const f = await downloads.fileOf(ctx.params.downloadId, ctx.params.name);
      const { req, res } = ctx;
      const type = f.format === "json" ? "application/json; charset=utf-8" : (CONTENT_TYPES[f.format] ?? "application/octet-stream");
      const headers = streamHeaders(ctx, {
        "Content-Type": type,
        "Content-Length": String(f.size),
        "Content-Disposition": `attachment; filename="${f.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "X-Data-Class": f.job.dataClass,
        ...(f.job.source ? { "X-Data-Source": f.job.source } : {}),
        ...(f.job.official !== null && f.job.official !== undefined ? { "X-Data-Official": String(f.job.official) } : {}),
        ...(Number.isFinite(f.job.delaySec) ? { "X-Data-Delay-Sec": String(f.job.delaySec) } : {}),
      });
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
        return undefined;
      }
      // Only the bytes counted in Content-Length: a file that is still growing must not overrun the answer.
      const stream = f.size > 0 ? createReadStream(f.path, { start: 0, end: f.size - 1 }) : Readable.from([]);
      try {
        await pipeline(stream, res);
      } catch {
        res.destroy();
      }
      return undefined;
    },

    // ── datasets ──
    listDatasets(ctx) {
      const { limit, cursor } = pageParams(ctx.query);
      const all = downloads.listDatasets({ tag: opt(ctx.query, "tag") });
      const { items, nextCursor } = paginate(all, { limit, cursor, keyOf: (d) => d.name });
      return { data: items, meta: meta(ctx, { nextCursor }) };
    },
    getDataset: (ctx) => ({ data: downloads.getDataset(ctx.params.name), meta: meta(ctx) }),
    async patchDataset(ctx) {
      const data = await downloads.patchDataset(ctx.params.name, ctx.body, { actor: actorOf(ctx) });
      await audit(ctx, "dataset.changed", { name: ctx.params.name, newName: data.name !== ctx.params.name ? data.name : undefined });
      return { data, meta: meta(ctx) };
    },
    async removeDataset(ctx) {
      await downloads.removeDataset(ctx.params.name);
      await audit(ctx, "dataset.deleted", { name: ctx.params.name });
      return undefined;
    },
    async updateDataset(ctx) {
      const { job, existing } = await downloads.updateDataset(ctx.params.name, callOpts(ctx));
      if (!existing) await audit(ctx, "download.created", { id: job.id, name: job.name, dataset: job.dataset, update: true });
      return json({ data: job, meta: meta(ctx, { existing }) }, { status: 202, headers: { Location: `/v1/downloads/${job.id}` } });
    },

    // ── instrument master ──
    async instrumentsExport(ctx) {
      const q = ctx.query;
      const exchange = opt(q, "exchange")?.toUpperCase();
      if (exchange !== undefined && !EXCHANGES.includes(exchange)) throw invalid("exchange", `exchange must be one of ${EXCHANGES.join(", ")}.`);
      const kind = opt(q, "kind")?.toUpperCase();
      if (kind !== undefined && !KINDS.includes(kind)) throw invalid("kind", `kind must be one of ${KINDS.join(", ")}.`);
      const format = opt(q, "format") ?? "csv";
      if (format !== "csv" && format !== "jsonl") throw invalid("format", "format must be csv or jsonl.");
      if (typeof deps.symbols?.list !== "function") throw new BridgeError("NOT_IMPLEMENTED", "The instrument master is not built yet.");
      const search = (cursor) => deps.symbols.list({...(exchange ? { exchange } : {}), ...(kind ? { kind } : {}), limit: PAGE, ...(cursor ? { cursor } : {}) });
      // The first page is read before any header is sent, so a problem (no master loaded yet) is a normal error answer.
      let page = await search();
      const { req, res } = ctx;
      const day = istDate(deps.clock.now());
      res.writeHead(
        200,
        streamHeaders(ctx, {
          "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="instruments-${day}.${format}"`,
          "X-Data-Source": "broker instrument master",
        }),
      );
      if (req.method === "HEAD") {
        res.end();
        return undefined;
      }
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const write = async (text) => {
        if (!res.write(text)) await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
      };
      if (format === "csv") await write(toCsv([INSTRUMENT_COLUMNS]));
      for (;;) {
        const items = page.items.map((r) => toPublicInstrument(r));
        if (items.length) await write(format === "csv" ? toCsv(items.map((i) => INSTRUMENT_COLUMNS.map((c) => i[c] ?? null))) : items.map((i) => `${JSON.stringify(Object.fromEntries(INSTRUMENT_COLUMNS.map((c) => [c, i[c] ?? null])))}\n`).join(""));
        if (!page.nextCursor || closed) break;
        page = await search(page.nextCursor);
      }
      res.end();
      return undefined;
    },
  };
}
