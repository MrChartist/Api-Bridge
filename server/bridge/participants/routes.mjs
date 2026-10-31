/**
 * Route handlers for stream S26 (docs/openapi.yaml, tag "Participant OI"; docs/spec/p1-12-guard-participants.md §4.2).
 * Reads need "read". The one write (sync) needs "admin" from this computer: it makes requests to the NSE archives.
 * Nothing here calls a broker or can place an order.
 *
 * `readParticipantOi(service, params)` is shared with the MCP tool get_participant_oi, so REST and MCP agree.
 */
import { BridgeError } from "../core/errors.mjs";
import { csv, json } from "../core/http.mjs";
import { INSTRUMENTS, PARTICIPANT_ROWS } from "./parser.mjs";

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "FII,PRO" → ["FII", "PRO"] (checked against `allowed`). */
export function listOf(v, allowed, path) {
  if (v === undefined || v === null || v === "") return undefined;
  const items = (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (items.length > allowed.length) throw invalid(path, `${path}: at most ${allowed.length} values.`);
  for (const x of items) if (!allowed.includes(x)) throw invalid(path, `${path} must be from ${allowed.join(", ")}.`);
  return [...new Set(items)];
}

function dateOf(v, path) {
  if (v === undefined || v === null || v === "") return undefined;
  if (!DATE_RE.test(String(v))) throw invalid(path, `${path} must be a date, YYYY-MM-DD.`);
  return String(v);
}

/** The series query from REST query parameters or MCP arguments. */
export function seriesQuery(p) {
  return { from: dateOf(p.from, "from"), to: dateOf(p.to, "to"), participants: listOf(p.participants, PARTICIPANT_ROWS, "participants"), instruments: listOf(p.instruments, INSTRUMENTS, "instruments") };
}

/**
 * One read shared by REST and MCP: the summary, or a series when from/to are given.
 * @param {ReturnType<import("./service.mjs").createParticipantsService>} service
 * @param {{ date?: string, from?: string, to?: string, participants?: string|string[], instruments?: string|string[] }} p
 * @param {{ maxRows?: number }} [o]
 */
export function readParticipantOi(service, p, { maxRows = 250 } = {}) {
  if (p.from || p.to) {
    const days = service.series(seriesQuery(p));
    const truncated = days.length > maxRows;
    return { kind: "series", unit: "contracts", exchange: "NSE", days: truncated ? days.slice(-maxRows) : days, truncated, note: "NSE only; summed over all strikes and expiries; number of contracts." };
  }
  return { kind: "summary", ...service.summary({ date: dateOf(p.date, "date") }) };
}

/**
 * @param {ReturnType<import("./service.mjs").createParticipantsService>} service
 * @param {{ audit?: any }} deps
 */
export function createParticipantRoutes(service, deps = {}) {
  const query = (ctx) => Object.fromEntries(ctx.query?.entries?.() ?? []);
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", requestId: ctx.requestId ?? null, data });
    } catch (err) {
      ctx.log?.warn?.("participants audit append failed", { type, code: err?.code });
    }
  };
  return {
    async oi(ctx) {
      const p = query(ctx);
      const format = String(p.format ?? "json").toLowerCase();
      if (format !== "json" && format !== "csv") throw invalid("format", "format must be json or csv.");
      const q = seriesQuery(p);
      if (format === "csv") {
        const rows = service.seriesCsv(q);
        const from = q.from ?? rows[1]?.[0] ?? "start";
        const to = q.to ?? rows[rows.length - 1]?.[0] ?? "end";
        return csv(rows, { filename: `participant-oi_${from}_${to}.csv` });
      }
      const days = service.series(q);
      return { data: { exchange: "NSE", unit: "contracts", note: "NSE only; summed over all strikes and expiries; number of contracts.", days }, meta: { requestId: ctx.requestId } };
    },
    async summary(ctx) {
      const p = query(ctx);
      return { data: service.summary({ date: dateOf(p.date, "date") }), meta: { requestId: ctx.requestId } };
    },
    async status(ctx) {
      return { data: service.status(), meta: { requestId: ctx.requestId } };
    },
    async sync(ctx) {
      const b = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
      for (const k of Object.keys(b)) if (k !== "date" && k !== "backfill") throw invalid(k, 'Send { "date"?: "YYYY-MM-DD", "backfill"?: true }.');
      if (b.backfill !== undefined && typeof b.backfill !== "boolean") throw invalid("backfill", "backfill must be true or false.");
      const date = dateOf(b.date, "date");
      if (b.backfill) {
        const run = service.sync({ date, backfill: true });
        // Validation and source errors surface now; a long back-fill continues in the background.
        const early = await Promise.race([run.then((r) => ({ r }), (e) => ({ e })), new Promise((r) => setTimeout(() => r(null), 50).unref?.())]);
        if (early?.e) throw early.e;
        await audit(ctx, "participants.sync.started", { date: date ?? null, backfill: true });
        if (early?.r) return { data: { started: true, done: true, ...early.r }, meta: { requestId: ctx.requestId } };
        run.catch(() => {});
        return json({ data: { started: true, done: false, fetched: [], noFile: [], failed: [] }, meta: { requestId: ctx.requestId } }, { status: 202 });
      }
      const r = await service.sync({ date });
      await audit(ctx, "participants.sync", { date: date ?? null, fetched: r.fetched.length, noFile: r.noFile.length, failed: r.failed.length });
      return { data: { started: true, done: true, ...r }, meta: { requestId: ctx.requestId } };
    },
  };
}
