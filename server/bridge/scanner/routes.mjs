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
 */
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { owns } from "../core/ownership.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";

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
    async runSaved(ctx) {
      const s = scanner.saved().find((x) => x.id === ctx.params.savedId);
      if (!s || !owns(ctx, s)) throw new BridgeError("NOT_FOUND", `No saved scan ${ctx.params.savedId}.`);
      return reply(ctx, await scanner.runSaved(s.id, who(ctx)));
    },
  };
}
