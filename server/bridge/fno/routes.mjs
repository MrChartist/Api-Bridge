/**
 * Route handlers for stream S19 (docs/openapi.yaml, tag "Options desk"; docs/spec/p1-06-stocks.md §3). Responses are
 * { data, meta }. Unavailable data is not an error: it comes back with available: false and a reason (BRD D5).
 * Nothing here can place an order or enable live trading; the sweep and the expiry costs are read-only.
 *
 * The read helpers (readUnderlyings, readExpiryCosts, readSweep) are shared with the MCP tools, so REST and MCP agree.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { json } from "../core/http.mjs";
import { EXPIRY_COSTS_NOTE, expiryDay, legExpiryCosts } from "../dashboard/expiry-costs.js";
import { istDate } from "../market/time.mjs";
import { rankUnderlyings } from "./universe.mjs";

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });
const usable = (s) => Boolean(s) && !isStub(s);
const UNDERLYING_RE = /^[A-Z0-9&-]{1,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUOTES_TTL_MS = 60_000;

/** "RELIANCE" (any case) or a 400. */
export function underlyingOf(v, path = "underlying") {
  const u = String(v ?? "").trim().toUpperCase();
  if (!UNDERLYING_RE.test(u)) throw invalid(path, `${path} must be an underlying name such as NIFTY or RELIANCE.`);
  return u;
}

/**
 * GET /v1/options/underlyings (and MCP get_option_underlyings).
 * @param {object} f  the fno instance (universe, quotes cache)
 * @param {{ kind?: string, q?: string, withQuotes?: boolean }} p
 */
export async function readUnderlyings(f, p = {}) {
  const kind = p.kind ?? "all";
  if (!["all", "index", "stock"].includes(kind)) throw invalid("kind", "kind must be all, index or stock.");
  if (p.q !== undefined && p.q !== null && (typeof p.q !== "string" || p.q.length > 40)) throw invalid("q", "q is at most 40 characters.");
  const list = await f.universe.list({ kind });
  let items = list.items;
  if (p.q) items = rankUnderlyings(items, p.q);
  let quotes = null;
  if (p.withQuotes) {
    const q = await f.pickerQuotes(items);
    quotes = q.meta;
    items = items.map((i) => ({ ...i, quote: q.byUnderlying.get(i.underlying) ?? null }));
  }
  return { ...list, items, ...(quotes ? { quotes } : {}) };
}

/** GET /v1/options/underlyings/{underlying}. */
export async function readUnderlyingDetail(f, deps, underlying) {
  const { item, facts } = await f.universe.detail(underlying);
  const ref = usable(deps.reference) ? deps.reference : null;
  const expiries = [];
  let refExpiries = null;
  try {
    refExpiries = ref ? await ref.expiries(underlying, { exchange: item.exchange }) : null;
  } catch {
    refExpiries = null;
  }
  for (const e of facts.perExpiry ?? []) {
    const r = refExpiries?.expiries?.find((x) => x.date === e.date) ?? null;
    expiries.push({ date: e.date, kind: r?.kind ?? null, lot: r?.lot ?? e.lot, shifted: r?.shifted ?? false, ...(r?.shifted ? { ruleDate: r.ruleDate } : {}), strikeStep: e.strikeStep, strikes: e.strikes, tickSize: e.tickSize });
  }
  let deliveryMargin;
  if (item.kind !== "stock") deliveryMargin = { available: false, reason: "INDEX_CASH_SETTLED" };
  else if (!facts.nearest || !ref) deliveryMargin = { available: false, reason: "NO_EXPIRY" };
  else {
    const dm = ref.deliveryMargin(facts.nearest, item.exchange);
    const d = expiryDay({ asOf: istDate(f.now()), expiry: facts.nearest, cal: ref.calendar(), warnFrom: f.cfg.expiry.warnFromTradingDays });
    const today = dm.items.find((x) => x.day === d.day) ?? null;
    deliveryMargin = { expiry: facts.nearest, verified: dm.verified, source: dm.source, items: dm.items, today: today ? { day: today.day, pct: today.pct } : null };
  }
  const rules =
    item.kind === "stock"
      ? [`${item.weekly ? "Weekly expiries are listed for this stock." : "No weekly expiry for stock options."}`, "European exercise; physically settled.", "Extra expiry-day ELM applies to index options only."]
      : ["European exercise; cash settled.", "Extra expiry-day ELM applies to short index options (rate from the charges table)."];
  return {
    ...item,
    expiries,
    deliveryMargin,
    settlementPrice:
      item.kind === "stock"
        ? { method: "closing price of the underlying in the cash market (needs verification)", window: "last 30 minutes (vol.clock.settlementWindowMinutes.stock)" }
        : { method: "closing value of the index (needs verification)", window: "last 30 minutes (vol.clock.settlementWindowMinutes.index)" },
    nonStandardContracts: facts.adjusted ?? [],
    rules,
  };
}

/** Validate the POST /v1/options/expiry-costs body. */
export function expiryCostsRequest(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) throw invalid("body", "Send { underlying, legs: [{ symbol, qty, bid?, ask? }], asOf?, spot?, varElmPct?, account? }.");
  for (const k of Object.keys(b)) if (!["underlying", "asOf", "spot", "varElmPct", "account", "legs"].includes(k)) throw invalid(k, `Unknown field ${k}.`);
  const underlying = underlyingOf(b.underlying);
  if (!Array.isArray(b.legs) || b.legs.length === 0) throw invalid("legs", "legs must be a non-empty array.");
  if (b.legs.length > 40) throw invalid("legs", "legs holds at most 40 legs.");
  const legs = b.legs.map((l, i) => {
    if (!l || typeof l !== "object") throw invalid(`legs[${i}]`, "Each leg is { symbol, qty, bid?, ask? }.");
    for (const k of Object.keys(l)) if (!["symbol", "qty", "bid", "ask"].includes(k)) throw invalid(`legs[${i}].${k}`, `Unknown field ${k}.`);
    if (typeof l.symbol !== "string" || !l.symbol || l.symbol.length > 80) throw invalid(`legs[${i}].symbol`, "symbol is an option such as NFO:RELIANCE-2026-11-23-1420-CE.");
    if (!Number.isInteger(l.qty) || l.qty === 0 || Math.abs(l.qty) > 10_000_000) throw invalid(`legs[${i}].qty`, "qty is signed whole units (+ long, − short), not 0.");
    for (const k of ["bid", "ask"]) if (l[k] !== undefined && l[k] !== null && !(typeof l[k] === "number" && Number.isFinite(l[k]) && l[k] >= 0)) throw invalid(`legs[${i}].${k}`, `${k} must be a price ≥ 0.`);
    return { symbol: l.symbol, qty: l.qty, bid: l.bid ?? null, ask: l.ask ?? null };
  });
  if (b.asOf !== undefined && b.asOf !== null && !DATE_RE.test(String(b.asOf))) throw invalid("asOf", "asOf must be a date, YYYY-MM-DD.");
  if (b.spot !== undefined && b.spot !== null && !(typeof b.spot === "number" && b.spot > 0)) throw invalid("spot", "spot must be a price > 0.");
  if (b.varElmPct !== undefined && b.varElmPct !== null && !(typeof b.varElmPct === "number" && b.varElmPct >= 1 && b.varElmPct <= 100)) throw invalid("varElmPct", "varElmPct is your broker's VaR + ELM rate in percent, 1–100.");
  if (b.account !== undefined && b.account !== null && (typeof b.account !== "string" || b.account.length > 64)) throw invalid("account", "account is an account id.");
  return { underlying, legs, asOf: b.asOf ?? null, spot: b.spot ?? null, varElmPct: b.varElmPct ?? null, account: b.account ?? null };
}

/** A cached quote (no broker call): the market service's cache when it exposes one, else null. */
function cachedQuote(marketData, symbol) {
  try {
    const hit = marketData?.cache?.peek?.(`q|${symbol}`);
    const fields = hit?.value?.fields ?? null;
    return fields ? { ltp: fields.ltp ?? null, bid: fields.bid ?? null, ask: fields.ask ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * POST /v1/options/expiry-costs (and MCP get_expiry_costs). Pure maths from dashboard/expiry-costs.js; stores nothing.
 * @param {object} f fno instance
 * @param {object} deps services
 * @param {ReturnType<typeof expiryCostsRequest>} req
 * @param {{ ctx?: any }} [o]
 */
export async function readExpiryCosts(f, deps, req, { ctx = null } = {}) {
  const ref = usable(deps.reference) ? deps.reference : null;
  if (!ref) throw new BridgeError("NOT_IMPLEMENTED", "Expiry costs need the reference data module.");
  const { item, facts } = await f.universe.detail(req.underlying);
  const resolved = [];
  for (const [i, l] of req.legs.entries()) {
    let r;
    try {
      r = await deps.symbols.resolve(l.symbol);
    } catch (err) {
      throw new BridgeError("SYMBOL_NOT_FOUND", `legs[${i}]: ${err?.detail ?? `${l.symbol} could not be resolved.`}`);
    }
    if (r.kind !== "OPT" || r.underlying !== req.underlying) throw invalid(`legs[${i}].symbol`, `${l.symbol} is not an option on ${req.underlying}.`);
    resolved.push({ ...l, r });
  }
  const asOf = req.asOf ?? istDate(f.now());
  const spotSym = item.spot;
  const spot = req.spot ?? cachedQuote(deps.marketData, spotSym)?.ltp ?? null;
  const rates = ref.charges();
  const cal = ref.calendar();
  // Holdings: only to say whether a delivering leg is covered (one read, cached 60 s).
  let heldShares = null;
  if (req.account && ctx && item.kind === "stock") heldShares = await f.heldShares(ctx, req.account, req.underlying, spotSym);
  const legs = [];
  let first = null;
  for (const l of resolved) {
    const q = l.bid === null || l.ask === null ? cachedQuote(deps.marketData, l.r.canonical) : null;
    const d = expiryDay({ asOf, expiry: l.r.expiry, cal, warnFrom: f.cfg.expiry.warnFromTradingDays });
    first ??= { d, expiry: l.r.expiry };
    const schedule = item.kind === "stock" ? ref.deliveryMargin(l.r.expiry, l.r.exchange).items : [];
    const step = facts.perExpiry?.find((e) => e.date === l.r.expiry)?.strikeStep ?? item.strikeStep ?? null;
    const c = legExpiryCosts(
      { symbol: l.r.canonical, strike: l.r.strike, right: l.r.right, qty: l.qty, exchange: l.r.exchange, bid: l.bid ?? q?.bid ?? null, ask: l.ask ?? q?.ask ?? null },
      { kind: item.kind, underlying: req.underlying, spot, step, day: d.day, schedule, varElmPct: req.varElmPct, heldShares, ctmStrikes: f.cfg.expiry.closeToMoneyStrikes, rates },
    );
    legs.push(publicLeg(c, { spot, varElmPct: req.varElmPct, underlying: req.underlying, inWindow: d.inWindow }));
  }
  const notes = [EXPIRY_COSTS_NOTE];
  if (item.kind === "stock") notes.push("Delivery STT basis and rates need verification against the Finance Act schedule.", "Broker's physical-delivery charge not included.");
  if (spot === null) notes.push("No spot price was given or cached: moneyness and delivery figures need spot.");
  if (req.asOf && req.asOf !== istDate(f.now())) notes.push(`What-if as of ${req.asOf}.`);
  return {
    asOf,
    day: first?.d.day ?? null,
    inWindow: first?.d.inWindow ?? false,
    settlement: item.settlement,
    spot,
    strikeStep: facts.perExpiry?.find((e) => e.date === first?.expiry)?.strikeStep ?? item.strikeStep ?? null,
    rates: { asOf: rates.asOf ?? null, verified: rates.physical?.verified === true && rates.verified === true, source: item.kind === "stock" ? rates.physical?.source ?? rates.source : rates.source },
    legs,
    notes,
  };
}

const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

function publicLeg(c, { spot, varElmPct, underlying, inWindow }) {
  const ob = c.obligation;
  return {
    symbol: c.symbol,
    qty: c.qty,
    moneyness: c.moneyness,
    intrinsic: r2(c.intrinsic),
    obligation: ob ? { kind: ob.kind, shares: ob.shares, cash: r2(ob.cash), text: `${ob.text} (₹${Math.round(ob.value)})` } : null,
    deliveryMargin: c.deliveryMargin
      ? {
          pct: c.deliveryMargin.pct,
          indicative: r2(c.deliveryMargin.indicative),
          basis: c.deliveryMargin.indicative !== null ? `${c.deliveryMargin.pct}% × ${varElmPct}% VaR+ELM × ${spot} × ${Math.abs(c.qty)} (your input)` : null,
          inWindow,
        }
      : null,
    settle: c.settle ? { total: r2(c.settle.total), lines: c.settle.lines.map((l) => ({ key: l.key, value: r2(l.value) })), excluded: c.settle.excluded ?? [] } : null,
    squareOff: c.squareOff ? { price: c.squareOff.price, side: c.squareOff.side, total: r2(c.squareOff.total), premium: r2(c.squareOff.premium), lines: (c.squareOff.lines ?? []).map((l) => ({ key: l.key, value: r2(l.value) })) } : null,
    difference: r2(c.difference),
    covered: c.covered,
    underlying,
  };
}

/** GET /v1/options/sweeps/current/chains page (and MCP get_option_sweep). */
export function sweepPage(f, { since, limit }) {
  const s = since === undefined || since === null || since === "" ? 0 : Number(since);
  const n = limit === undefined || limit === null || limit === "" ? 40 : Number(limit);
  if (!Number.isInteger(s) || s < 0) throw invalid("since", "since is a sequence number ≥ 0.");
  if (!Number.isInteger(n) || n < 1 || n > 40) throw invalid("limit", "limit is 1–40.");
  return f.sweeper.chains({ since: s, limit: n });
}

/**
 * @param {object} f  fno instance { universe, sweeper, cfg, now, pickerQuotes, heldShares }
 * @param {object} deps
 */
export function createFnoRoutes(f, deps) {
  const query = (ctx) => Object.fromEntries(ctx.query?.entries?.() ?? []);
  const meta = (ctx) => ({ requestId: ctx.requestId });
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", requestId: ctx.requestId ?? null, data });
    } catch (err) {
      ctx.log?.warn?.("fno audit append failed", { type, code: err?.code });
    }
  };
  const bool = (v, path) => {
    if (v === undefined || v === "" || v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
    throw invalid(path, `${path} must be 1 or 0.`);
  };
  return {
    async list(ctx) {
      const p = query(ctx);
      for (const k of Object.keys(p)) if (!["kind", "q", "withQuotes"].includes(k)) throw invalid(k, `Unknown parameter ${k}.`);
      return { data: await readUnderlyings(f, { kind: p.kind, q: p.q, withQuotes: bool(p.withQuotes, "withQuotes") }), meta: meta(ctx) };
    },
    async detail(ctx) {
      return { data: await readUnderlyingDetail(f, deps, underlyingOf(ctx.params.underlying)), meta: meta(ctx) };
    },
    async expiryCosts(ctx) {
      const req = expiryCostsRequest(ctx.body);
      if (req.account) ctx.requireAccountAccess(req.account);
      return { data: await readExpiryCosts(f, deps, req, { ctx }), meta: meta(ctx) };
    },
    async plan(ctx) {
      return { data: await f.sweeper.plan(ctx.body ?? {}), meta: meta(ctx) };
    },
    async start(ctx) {
      const r = await f.sweeper.start(ctx.body ?? {}, { requestedBy: ctx.source === "mcp" ? "mcp" : ctx.source === "dashboard" || ctx.principal?.kind === "session" ? "dashboard" : ctx.source ?? "rest" });
      return json({ data: r.job, meta: meta(ctx) }, { status: r.created ? 202 : 200 });
    },
    async current(ctx) {
      const p = query(ctx);
      return { data: f.sweeper.current({ lease: bool(p.lease, "lease") }), meta: meta(ctx) };
    },
    async chains(ctx) {
      const p = query(ctx);
      return { data: sweepPage(f, p), meta: meta(ctx) };
    },
    async cancel(ctx) {
      const job = await f.sweeper.cancel();
      await audit(ctx, "fno.sweep.cancelled", { jobId: job.id });
      return { data: job, meta: meta(ctx) };
    },
    async getSettings(ctx) {
      return { data: f.sweeper.settings(), meta: meta(ctx) };
    },
    async putSettings(ctx) {
      const actor = `${ctx.principal?.kind ?? "anonymous"}:${ctx.principal?.id ?? "anonymous"}`;
      const s = await f.sweeper.setSettings(ctx.body, actor);
      await audit(ctx, "fno.settings.updated", { optIn: s.optIn.length, background: s.background, persisted: s.persisted });
      return { data: s, meta: meta(ctx) };
    },
  };
}

/** POST /v1/demo/fno (demo only): force a ban list on top of the demo's own for `minutes` (memory only). */
export function demoFnoHandler(deps) {
  return async (ctx) => {
    const b = ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : null;
    if (!b) throw invalid("body", 'Send { "ban": ["RELIANCE"], "minutes": 30 }.');
    for (const k of Object.keys(b)) if (k !== "ban" && k !== "minutes") throw invalid(k, `Unknown field ${k}.`);
    if (!Array.isArray(b.ban) || b.ban.length > 20) throw invalid("ban", "ban is a list of at most 20 stock names ([] clears it).");
    const ban = b.ban.map((x, i) => underlyingOf(x, `ban[${i}]`));
    const minutes = b.minutes ?? 30;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) throw invalid("minutes", "minutes is 1–600.");
    return { data: deps.reference.setDemoBanOverride({ symbols: ban, minutes }), meta: { requestId: ctx.requestId } };
  };
}

