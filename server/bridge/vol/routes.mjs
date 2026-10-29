/**
 * Route handlers for stream S18 (docs/spec/p1-03-pricing-vol.md §3; docs/openapi.yaml tag "Volatility"). Reads need the
 * "read" scope and make no broker call except /snapshot (≤ 3 background chain reads a minute per underlying, cached).
 * POST /v1/vol/capture needs "admin" from this computer and is audited. Nothing here can place an order or change a
 * safety setting. Responses carry `broker`, never an account id.
 *
 * The back-fill writes (POST/DELETE /v1/vol/backfill) land with step P1-3c.
 */
import { BridgeError } from "../core/errors.mjs";
import { csv, json } from "../core/http.mjs";
import { notBuilt } from "../core/modules.mjs";

const q = (ctx, k) => {
  const p = ctx.query;
  const v = typeof p?.get === "function" ? p.get(k) : p?.[k];
  return v === null || v === undefined || v === "" ? undefined : v;
};
const flag = (v) => v === "1" || v === "true" || v === true;
const actorOf = (ctx) => ({ kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" });

/** Remove every `accountId` key, however deep (§8.2: responses carry broker, never the account). */
export function stripAccountIds(v) {
  if (Array.isArray(v)) return v.map(stripAccountIds);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (k !== "accountId") out[k] = stripAccountIds(x);
    return out;
  }
  return v;
}

/** History items as CSV rows (one header row; the same columns as JSON). */
export function historyCsv(h) {
  const cols = ["date", ...h.series, "quality", "roll"];
  return [cols, ...h.items.map((i) => cols.map((c) => (c === "roll" ? (i.roll ? "1" : "0") : (i[c] ?? null))))];
}

/**
 * @param {ReturnType<import("./volService.mjs").createVolService>} vol
 * @param {{ audit?: object, config?: object }} deps
 */
export function createVolRoutes(vol, deps) {
  const demo = Boolean(deps.config?.demo);
  const meta = (ctx) => ({ requestId: ctx.requestId });
  const ok = (ctx, data) => ({ data: stripAccountIds(data), meta: meta(ctx) });
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: actorOf(ctx), source: ctx.source ?? "rest", requestId: ctx.requestId ?? null, data });
    } catch (err) {
      ctx.log?.warn?.("vol audit append failed", { type, code: err?.code });
    }
  };

  return {
    async clock(ctx) {
      const e = q(ctx, "expiry");
      const expiries = e === undefined ? undefined : String(e).split(",").map((x) => x.trim()).filter(Boolean);
      if (expiries && (expiries.length > 10 || expiries.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x)))) {
        throw new BridgeError("VALIDATION_FAILED", "expiry must be up to 10 dates, YYYY-MM-DD, comma separated.", { errors: [{ path: "expiry", message: "bad date list" }] });
      }
      return ok(ctx, await vol.clock({ underlying: q(ctx, "underlying"), expiries, at: q(ctx, "at") }));
    },
    async snapshot(ctx) {
      return ok(ctx, await vol.snapshot({ underlying: q(ctx, "underlying"), demoPartial: demo && flag(q(ctx, "demoPartial")) }));
    },
    async history(ctx) {
      const p = Object.fromEntries(["underlying", "basis", "expiry", "from", "to", "series", "quality", "clock", "limit", "cursor"].map((k) => [k, q(ctx, k)]));
      const format = q(ctx, "format") ?? "json";
      if (!["json", "csv"].includes(format)) throw new BridgeError("VALIDATION_FAILED", "format must be json or csv.", { errors: [{ path: "format", message: "json or csv" }] });
      const h = await vol.history(p);
      if (format === "csv" && h.available) {
        const first = h.items[0]?.date ?? "none";
        const last = h.items.at(-1)?.date ?? "none";
        return csv(historyCsv(h), { filename: `${h.underlying}-vol-${h.basis}-${first}-${last}.csv` });
      }
      return ok(ctx, h);
    },
    async rank(ctx) {
      const p = Object.fromEntries(["underlying", "lookbacks", "basis", "expiry", "quality", "clock"].map((k) => [k, q(ctx, k)]));
      return ok(ctx, await vol.rank({ ...p, demoPartial: demo && flag(q(ctx, "demoPartial")) }));
    },
    async summary(ctx) {
      return ok(ctx, await vol.summary({ underlyings: q(ctx, "underlyings"), lookback: q(ctx, "lookback") }));
    },
    async status(ctx) {
      return ok(ctx, vol.status());
    },
    async predictions(ctx) {
      const p = Object.fromEntries(["from", "to", "underlying", "metric", "cursor", "limit"].map((k) => [k, q(ctx, k)]));
      return ok(ctx, await vol.predictions(p));
    },
    async capture(ctx) {
      const body = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
      const extra = Object.keys(body).filter((k) => !["underlyings", "replace"].includes(k));
      if (extra.length) throw new BridgeError("VALIDATION_FAILED", `Unknown field ${extra[0]}.`, { errors: [{ path: extra[0], message: "unknown field" }] });
      if (body.replace !== undefined && typeof body.replace !== "boolean") throw new BridgeError("VALIDATION_FAILED", "replace must be true or false.", { errors: [{ path: "replace", message: "boolean" }] });
      const job = await vol.capture({ underlyings: body.underlyings, replace: body.replace ?? false }, { wait: false });
      await audit(ctx, "vol.capture.manual", { jobId: job.jobId, underlyings: job.underlyings, replace: Boolean(body.replace) });
      return json({ data: job, meta: meta(ctx) }, { status: 202 });
    },
    backfill: notBuilt("POST /v1/vol/backfill (stream S18, step P1-3c)"),
    cancelBackfill: notBuilt("DELETE /v1/vol/backfill (stream S18, step P1-3c)"),
  };
}
