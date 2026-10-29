/**
 * Route handlers for stream S16 (docs/openapi.yaml, tag "Reference data"; docs/spec/p1-02-reference.md §3). Reads need
 * the "read" scope. The five writes need "admin" from this computer (loopbackOnly): they change shared reference data
 * that pricing reads. Nothing here can place an order or switch on live trading. Writes are audited.
 *
 * `readReference(service, dataset, params)` is shared with the MCP tool get_reference, so REST and MCP return the
 * same data for the same question.
 */
import { BridgeError } from "../core/errors.mjs";
import { json, noContent } from "../core/http.mjs";
import { calendarDaysBetween, istClockOf, istDateOf, istInstant, isIsoDate } from "./calendar.mjs";

export const READ_DATASETS = Object.freeze(["status", "bundle", "expiries", "sessions", "holidays", "lots", "ban", "mwpl", "fno-universe", "corporate-actions", "rate", "charges", "delivery-margin", "events"]);
const MAX_RANGE_DAYS = 400;
const UNDERLYING_RE = /^[A-Z0-9&-]{1,30}$/;
const ORIGINS = ["shipped", "user", "inferred"];

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

function underlyingOf(v, path = "underlying", required = true) {
  if (v === undefined || v === null || v === "") {
    if (required) throw invalid(path, `${path} is required, for example NIFTY.`);
    return undefined;
  }
  const u = String(v).trim().toUpperCase();
  if (!UNDERLYING_RE.test(u)) throw invalid(path, `${path} must be 1-30 letters, digits, & or -.`);
  return u;
}

function dateOf(v, path) {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isIsoDate(String(v))) throw invalid(path, `${path} must be a real date, YYYY-MM-DD.`);
  return String(v);
}

function exchangeOf(v, allowed) {
  if (v === undefined || v === null || v === "") return undefined;
  const e = String(v).toUpperCase();
  if (!allowed.includes(e)) throw invalid("exchange", `exchange must be one of ${allowed.join(", ")}.`);
  return e;
}

function rangeOf(from, to) {
  if (from && to && from > to) throw invalid("from", "from must not be after to.");
  if (from && to && calendarDaysBetween(from, to) > MAX_RANGE_DAYS) throw invalid("to", `The range is at most ${MAX_RANGE_DAYS} days.`);
}

function intOf(v, path, min, max, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(path, `${path} must be a whole number from ${min} to ${max}.`);
  return n;
}

const notFound = (u) => new BridgeError("SYMBOL_NOT_FOUND", `${u} is not in any loaded instrument master or in the F&O universe.`);

/**
 * One read, shared by REST and MCP.
 * @param {ReturnType<import("./referenceService.mjs").createReferenceService>} service
 * @param {string} dataset
 * @param {Record<string, unknown>} p  query-style parameters
 * @param {{ now: () => number }} env
 */
export async function readReference(service, dataset, p, { now }) {
  switch (dataset) {
    case "status":
      return service.status();
    case "bundle": {
      const underlying = underlyingOf(p.underlying);
      const exchange = exchangeOf(p.exchange, ["NFO", "BFO"]);
      const demoStale = service.isDemo() && (p.demoStale === "1" || p.demoStale === true || p.demoStale === 1);
      return service.bundle({ underlying, exchange, demoStale });
    }
    case "expiries": {
      const underlying = underlyingOf(p.underlying);
      const r = await service.expiries(underlying, { exchange: exchangeOf(p.exchange, ["NFO", "BFO"]) });
      if (!r.found) throw notFound(underlying);
      const { found, ...rest } = r;
      void found;
      return rest;
    }
    case "sessions": {
      const exchange = exchangeOf(p.exchange, ["NFO", "BFO", "NSE", "BSE"]) ?? "NFO";
      const t = now();
      const date = dateOf(p.date, "date") ?? istDateOf(t);
      const s = service.session(exchange, istInstant(date, istClockOf(t)));
      return { date, exchange, state: s.state, label: s.label, preOpen: s.preOpen, open: s.open, close: s.close, holiday: s.holiday, special: s.special, tradingDay: s.tradingDay, source: s.source };
    }
    case "holidays": {
      const year = istDateOf(now()).slice(0, 4);
      const from = dateOf(p.from, "from") ?? `${year}-01-01`;
      const to = dateOf(p.to, "to") ?? `${year}-12-31`;
      rangeOf(from, to);
      return service.holidays({ from, to, exchange: exchangeOf(p.exchange, ["NSE", "BSE", "NFO", "BFO"]) });
    }
    case "lots": {
      const underlying = underlyingOf(p.underlying);
      const r = await service.lots(underlying, { exchange: exchangeOf(p.exchange, ["NFO", "BFO"]), from: dateOf(p.from, "from") });
      if (!r.found) throw notFound(underlying);
      const { found, ...rest } = r;
      void found;
      return rest;
    }
    case "ban":
      return service.banList(dateOf(p.date, "date"));
    case "mwpl": {
      const symbol = underlyingOf(p.symbol, "symbol", false);
      return service.mwplList({ date: dateOf(p.date, "date"), symbol });
    }
    case "fno-universe": {
      const kind = p.kind === undefined || p.kind === null || p.kind === "" ? "all" : String(p.kind);
      if (!["stock", "index", "all"].includes(kind)) throw invalid("kind", "kind must be stock, index or all.");
      return service.universe({ date: dateOf(p.date, "date"), kind });
    }
    case "corporate-actions": {
      const from = dateOf(p.from, "from");
      const to = dateOf(p.to, "to");
      rangeOf(from, to);
      const origin = p.origin === undefined || p.origin === null || p.origin === "" ? undefined : String(p.origin);
      if (origin && !ORIGINS.includes(origin)) throw invalid("origin", `origin must be one of ${ORIGINS.join(", ")}.`);
      return { items: service.corporateActions({ symbol: underlyingOf(p.symbol, "symbol", false), from, to, origin }) };
    }
    case "rate":
      return service.rate();
    case "charges":
      return service.charges();
    case "delivery-margin": {
      const underlying = underlyingOf(p.underlying);
      const expiry = dateOf(p.expiry, "expiry");
      if (!expiry) throw invalid("expiry", "expiry is required, YYYY-MM-DD.");
      const ex = await service.expiries(underlying, {});
      if (!ex.found) throw notFound(underlying);
      if (ex.kind === "index") return { expiry, items: [], available: false, reason: "INDEX_CASH_SETTLED", source: null };
      return service.deliveryMargin(expiry, ex.exchange ?? "NFO");
    }
    case "events": {
      const days = intOf(p.days, "days", 1, 30, 7);
      return { items: await service.events({ days, underlying: underlyingOf(p.underlying, "underlying", false) }) };
    }
    default:
      throw invalid("dataset", `dataset must be one of ${READ_DATASETS.join(", ")}.`);
  }
}

const actorOf = (ctx) => ({ kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" });
const byOf = (ctx) => `${ctx.principal?.kind ?? "anonymous"}:${ctx.principal?.id ?? "anonymous"}`;

/**
 * @param {ReturnType<import("./referenceService.mjs").createReferenceService>} service
 * @param {{ audit?: any, clock?: { now(): number } }} deps
 */
export function createReferenceRoutes(service, deps) {
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: actorOf(ctx), source: ctx.source ?? "rest", requestId: ctx.requestId ?? null, data });
    } catch (err) {
      ctx.log?.warn?.("reference audit append failed", { type, code: err?.code });
    }
  };
  const read = (dataset) => async (ctx) => {
    const p = Object.fromEntries(ctx.query?.entries?.() ?? []);
    return { data: await readReference(service, dataset, p, { now }), meta: { requestId: ctx.requestId } };
  };
  const body = (ctx) => (ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : null);

  return {
    status: read("status"),
    bundle: read("bundle"),
    expiries: read("expiries"),
    sessions: read("sessions"),
    holidays: read("holidays"),
    lots: read("lots"),
    ban: read("ban"),
    mwpl: read("mwpl"),
    universe: read("fno-universe"),
    listActions: read("corporate-actions"),
    rate: read("rate"),
    charges: read("charges"),
    deliveryMargin: read("delivery-margin"),
    events: read("events"),
    async previewAction(ctx) {
      const b = body(ctx);
      if (!b) throw invalid("(root)", "Send { type, ratio | fv | subscriptionPrice + cumPrice | dividend + cumPrice, lot?, strikes?, strikeTick? }.");
      return { data: service.previewAction(b), meta: { requestId: ctx.requestId } };
    },
    async addAction(ctx) {
      const row = service.addAction(body(ctx));
      await audit(ctx, "reference.corporate_action.added", { id: row.id, symbol: row.symbol, type: row.type, exDate: row.exDate, factor: row.factor });
      return json({ data: row, meta: { requestId: ctx.requestId } }, { status: 201 });
    },
    async deleteAction(ctx) {
      const row = service.deleteAction(ctx.params.id);
      await audit(ctx, "reference.corporate_action.deleted", { id: row.id, symbol: row.symbol, type: row.type, exDate: row.exDate });
      return noContent();
    },
    async setRate(ctx) {
      const r = service.setRate(body(ctx), byOf(ctx));
      await audit(ctx, "reference.rate.set", { value: r.value, asOf: r.asOf, source: r.source });
      return { data: r, meta: { requestId: ctx.requestId } };
    },
    async setSources(ctx) {
      const s = service.setSources(body(ctx), byOf(ctx));
      await audit(ctx, "reference.sources.set", { nseArchives: s.nseArchives.enabled });
      return { data: s, meta: { requestId: ctx.requestId } };
    },
    async sync(ctx) {
      const b = body(ctx) ?? {};
      if (b.datasets !== undefined && (!Array.isArray(b.datasets) || b.datasets.length > 10 || !b.datasets.every((d) => typeof d === "string"))) throw invalid("datasets", "datasets must be a list of dataset names.");
      const job = service.startSync({ datasets: b.datasets, reason: "manual" });
      job.promise.catch(() => {});
      await audit(ctx, "reference.sync.started", { jobId: job.jobId, datasets: job.datasets });
      return json({ data: { jobId: job.jobId, datasets: job.datasets, startedAt: job.startedAt }, meta: { requestId: ctx.requestId } }, { status: 202 });
    },
  };
}
