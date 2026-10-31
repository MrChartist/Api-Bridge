/**
 * Route handlers for stream S13 (docs/openapi.yaml, tag "Scanner"). Every route needs only the "read" scope: a scan
 * reads candles and never places an order. A key sees its own scans (an admin key or this computer's operator sees
 * all), and its scans use only the accounts the key may use.
 *
 *   GET    /v1/scanner/language                 fields, functions, operators, examples
 *   GET    /v1/scanner/universes                FNO, NIFTY50, INDICES and config universes
 *   GET    /v1/scanner/universes/:name          the symbols in one
 *   POST   /v1/scanner/plan                     dry run: accounts, pool widths, estimated time
 *   POST   /v1/scanner/jobs[?waitMs=30000]      start a scan; 202 + job (200 with results when it finished in waitMs)
 *   GET    /v1/scanner/jobs                     recent scans (no result rows)
 *   GET    /v1/scanner/jobs/:jobId              one scan with its results
 *   DELETE /v1/scanner/jobs/:jobId              cancel
 *   GET    /v1/scanner/saved   POST /v1/scanner/saved   DELETE /v1/scanner/saved/:savedId   POST /v1/scanner/saved/:savedId/run
 *   PATCH  /v1/scanner/saved/:savedId           rename, change the request, schedule, notify, builder, columns
 *   POST   /v1/scanner/saved/:savedId/duplicate a copy without its run history
 *   GET    /v1/scanner/saved/:savedId/results   the last run's matches (json, csv or text; ?key= for Excel)
 *   GET    /v1/scanner/library                  ready-made scans, the builder's values and the result columns
 *   POST   /v1/scanner/compile                  builder model -> condition, or condition -> builder model
 *   POST   /v1/scanner/count                    live count while editing (no broker call)
 *   GET    /v1/scanner/scan                     run a scan from the query string and wait (json, csv or text; ?key=)
 */
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { owns } from "../core/ownership.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";
import { csv, text } from "../core/http.mjs";
import { COLUMNS, FACTS, GROUPS, OPERANDS, OPS, compileModel } from "../dashboard/scan-builder.js";
import { LIBRARY, LIBRARY_GROUPS } from "../dashboard/scan-library.js";
import { decompile } from "./decompile.mjs";
import { parseExpression } from "./expr.mjs";
import { needsOf } from "./liveFacts.mjs";

const FORMATS = new Set(["json", "csv", "text"]);
/** Columns of a results CSV: symbol, new, then the facts. */
const CSV_FACTS = ["ltp", "change_pct", "vol_pace", "fut_oi_change_pct", "atm_iv", "iv_rank", "pcr", "basis_pct", "mwpl_pct", "sector"];

function formatOf(ctx) {
  const f = (ctx.query.get("format") ?? "json").toLowerCase();
  if (!FORMATS.has(f)) throw new BridgeError("VALIDATION_FAILED", "format is json, csv or text.", { errors: [{ path: "format", message: "unknown" }] });
  return f;
}

/** A finished job's rows in the asked format (text: the symbols joined by commas, for Excel TEXTSPLIT). */
function rowsReply(ctx, rows, format, data) {
  if (format === "text") return text(rows.map((r) => r.symbol.split(":").pop()).join(","));
  if (format === "csv") {
    const extra = [...new Set(rows.flatMap((r) => Object.keys(r.values ?? {})))].filter((k) => !CSV_FACTS.includes(k));
    return csv([["symbol", "new", ...CSV_FACTS, ...extra], ...rows.map((r) => [r.symbol, r.isNew ? 1 : 0, ...CSV_FACTS.map((k) => r.facts?.[k] ?? ""), ...extra.map((k) => r.values?.[k] ?? "")])], { filename: "scan.csv" });
  }
  return { data, meta: { requestId: ctx.requestId } };
}

const MAX_WAIT_MS = 120_000;

function who(ctx) {
  return { allowedAccounts: allowedAccountsFor(ctx), keyId: ctx.key?.id ?? null };
}

function waitParam(ctx) {
  const v = ctx.query.get("waitMs");
  if (v === null || v === "") return 0;
  if (!/^\d+$/.test(v) || Number(v) > MAX_WAIT_MS) {
    throw new BridgeError("VALIDATION_FAILED", `waitMs must be a whole number from 0 to ${MAX_WAIT_MS}.`, { errors: [{ path: "waitMs", message: "out of range" }] });
  }
  return Number(v);
}

export function createScannerRoutes(scanner) {
  const job = (ctx) => {
    const j = scanner.get(ctx.params.jobId);
    if (!j || !owns(ctx, j)) throw new BridgeError("NOT_FOUND", `No scan ${ctx.params.jobId}.`);
    return j;
  };
  const savedFor = (ctx) => scanner.saved().filter((s) => owns(ctx, s));
  const reply = async (ctx, j) => {
    const wait = waitParam(ctx);
    if (wait > 0) await scanner.waitFor(j, wait);
    const done = !["queued", "running"].includes(j.status);
    return json({ data: scanner.view(j), meta: { requestId: ctx.requestId } }, { status: done ? 200 : 202, headers: done ? {} : { Location: `/v1/scanner/jobs/${j.id}` } });
  };

  return {
    async language(ctx) {
      const { languageReference } = await import("./expr.mjs");
      return { data: languageReference(), meta: { requestId: ctx.requestId } };
    },
    async universes(ctx) {
      return { data: scanner.universes(), meta: { requestId: ctx.requestId } };
    },
    async universe(ctx) {
      const symbols = await scanner.universe(ctx.params.name);
      return { data: { name: ctx.params.name.toUpperCase(), symbols }, meta: { requestId: ctx.requestId } };
    },
    async plan(ctx) {
      return { data: await scanner.plan(ctx.body, who(ctx)), meta: { requestId: ctx.requestId } };
    },
    async startJob(ctx) {
      return reply(ctx, await scanner.start(ctx.body, who(ctx)));
    },
    async listJobs(ctx) {
      const data = scanner
        .list()
        .filter((j) => owns(ctx, j))
        .map((j) => scanner.view(j, { results: false }));
      return { data, meta: { requestId: ctx.requestId } };
    },
    async getJob(ctx) {
      return { data: scanner.view(job(ctx)), meta: { requestId: ctx.requestId } };
    },
    async cancelJob(ctx) {
      return { data: scanner.view(scanner.cancel(job(ctx)), { results: false }), meta: { requestId: ctx.requestId } };
    },
    async listSaved(ctx) {
      return { data: savedFor(ctx), meta: { requestId: ctx.requestId } };
    },
    async createSaved(ctx) {
      return json({ data: await scanner.save(ctx.body, who(ctx)), meta: { requestId: ctx.requestId } }, { status: 201 });
    },
    async deleteSaved(ctx) {
      const s = scanner.saved().find((x) => x.id === ctx.params.savedId);
      if (!s || !owns(ctx, s)) throw new BridgeError("NOT_FOUND", `No saved scan ${ctx.params.savedId}.`);
      scanner.removeSaved(s.id);
      return { data: { id: s.id, deleted: true }, meta: { requestId: ctx.requestId } };
    },
    async library(ctx) {
      return { data: { groups: LIBRARY_GROUPS, scans: LIBRARY, values: { groups: GROUPS, operands: OPERANDS, ops: OPS, facts: FACTS }, columns: COLUMNS }, meta: { requestId: ctx.requestId } };
    },
    async compile(ctx) {
      const b = ctx.body ?? {};
      if (b.builder !== undefined) {
        const c = compileModel(b.builder);
        if (c.errors.length) throw new BridgeError("VALIDATION_FAILED", c.errors[0].message, { errors: c.errors });
        if (!c.text) throw new BridgeError("VALIDATION_FAILED", "Add at least one rule.", { errors: [{ path: "builder.rules", message: "empty" }] });
        const back = decompile(c.text);
        return { data: { condition: c.text, model: b.builder, reason: null, needs: [...needsOf([parseExpression(c.text, { fields: FACTS.map((f) => f.id) })])] }, meta: { requestId: ctx.requestId, roundTrip: back.text === c.text } };
      }
      if (typeof b.condition !== "string") throw new BridgeError("VALIDATION_FAILED", "Send { builder } or { condition }.", { errors: [{ path: "condition", message: "required" }] });
      const d = decompile(b.condition);
      return { data: { condition: b.condition.trim(), model: d.model, reason: d.reason, needs: [...needsOf([parseExpression(b.condition, { fields: FACTS.map((f) => f.id) })])] }, meta: { requestId: ctx.requestId } };
    },
    async count(ctx) {
      return { data: await scanner.count(ctx.body), meta: { requestId: ctx.requestId } };
    },
    async updateSaved(ctx) {
      const s = scanner.saved().find((x) => x.id === ctx.params.savedId);
      if (!s || !owns(ctx, s)) throw new BridgeError("NOT_FOUND", `No saved scan ${ctx.params.savedId}.`);
      return { data: await scanner.updateSaved(s.id, ctx.body), meta: { requestId: ctx.requestId } };
    },
    async duplicateSaved(ctx) {
      const s = scanner.saved().find((x) => x.id === ctx.params.savedId);
      if (!s || !owns(ctx, s)) throw new BridgeError("NOT_FOUND", `No saved scan ${ctx.params.savedId}.`);
      return json({ data: scanner.duplicateSaved(s.id, who(ctx)), meta: { requestId: ctx.requestId } }, { status: 201 });
    },
    async savedResults(ctx) {
      const s = scanner.saved().find((x) => x.id === ctx.params.savedId);
      if (!s || !owns(ctx, s)) throw new BridgeError("NOT_FOUND", `No saved scan ${ctx.params.savedId}.`);
      const format = formatOf(ctx);
      const j = s.lastRun?.jobId ? scanner.get(s.lastRun.jobId) : null;
      const rows = j ? j.results : (s.lastRun?.matched ?? []).map((symbol) => ({ symbol, isNew: (s.lastRun?.newMatches ?? []).includes(symbol), values: {}, facts: {} }));
      return rowsReply(ctx, rows, format, { savedId: s.id, name: s.name, at: s.lastRun?.at ?? null, newMatches: s.lastRun?.newMatches ?? [], results: rows, stats: s.lastRun?.stats ?? null });
    },
    async scanFromQuery(ctx) {
      const q = ctx.query;
      const format = formatOf(ctx);
      const req = { interval: q.get("interval") || "live", condition: q.get("condition") ?? "" };
      const symbols = q.get("symbols");
      if (symbols) req.symbols = symbols.split(",").map((x) => x.trim()).filter(Boolean);
      else req.universe = q.get("universe") || "FNO";
      if (q.get("sort")) req.sort = { by: q.get("sort"), order: q.get("order") === "asc" ? "asc" : "desc" };
      if (q.get("limit")) req.limit = Number(q.get("limit"));
      if (q.get("name")) req.name = q.get("name");
      const j = await scanner.start(req, who(ctx));
      await scanner.waitFor(j, Math.min(waitParam(ctx) || 30_000, MAX_WAIT_MS));
      if (["queued", "running"].includes(j.status)) return json({ data: scanner.view(j, { results: false }), meta: { requestId: ctx.requestId } }, { status: 202, headers: { Location: `/v1/scanner/jobs/${j.id}` } });
      return rowsReply(ctx, j.results, format, scanner.view(j));
    },
    async runSaved(ctx) {
      const s = scanner.saved().find((x) => x.id === ctx.params.savedId);
      if (!s || !owns(ctx, s)) throw new BridgeError("NOT_FOUND", `No saved scan ${ctx.params.savedId}.`);
      return reply(ctx, await scanner.runSaved(s.id, who(ctx)));
    },
  };
}
