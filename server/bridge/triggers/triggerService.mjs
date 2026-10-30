/**
 * The trigger engine (stream S25, the order side of docs/spec/p1-12): GTT single and OCO, trailing stops, stop and
 * target attached to an entry (bracket-style) and position stops and targets. Checked on the Bridge every second with
 * the browser closed.
 *
 * Safety:
 *  - A trigger places its order only through `orders.place`, exactly like any other order: per-order lots and value,
 *    daily count and loss, the kill switch, price band, market hours, freeze, ban, readiness and every live opt-in.
 *    It never calls a broker adapter or the paper engine itself.
 *  - The order goes out as source "guard" with a "guard" principal that may use only the trigger's account, and with
 *    the scopes of the key that set the trigger (a paper-only key's trigger can never send live). A live trigger also
 *    needs "guard" in the account's live.allowedSources (off unless the owner adds it).
 *  - Exits (origin "bracket" and "position") are reduce-only: never more than is held, never across zero; a flat
 *    position cancels the trigger.
 *  - A refusal is recorded on the trigger in plain words. Only a closed market or the rate cap is retried; a kill
 *    switch, a daily limit or a live gate fails the trigger for good.
 *
 * Restarts: <dataDir>/triggers/triggers.json is written atomically (temp file, then rename) after every change. A
 * trigger that was firing when the Bridge stopped is resolved first by its clientOrderId (the trigger id) and only then
 * sent again, with the same Idempotency-Key, so it can never place two orders.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createCallContext } from "../core/context.mjs";
import { BridgeError } from "../core/errors.mjs";
import { writeFileAtomic } from "../auth/fsUtil.mjs";
import { decideMode } from "../orders/modeDecision.mjs";
import { istIso } from "../orders/time.mjs";
import { OPEN_STATUSES, TRIGGER_ORIGINS, TRIGGER_TYPES, legProblems, opFor, reduceOnlyQty, step, toTick } from "./triggerCore.mjs";
import { marketSession } from "../../lib/marketHours.mjs";
import { defaultSessionFor } from "../reference/defaults.mjs";
import { PAPER_DEFAULTS } from "../paper/config.mjs";

export const MAX_OPEN = 200;
export const KEPT_CLOSED = 300;
const YEAR_MS = 365 * 86_400_000;
/** Refusals worth trying again while the condition still holds. Anything else fails the trigger. */
const RETRYABLE = new Set(["MARKET_CLOSED", "ORDER_RATE_LIMITED", "RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_RATE_LIMITED", "BROKER_UNAVAILABLE"]);
const RETRY_MS = 30_000;
/** Codes from an order preview that mean the order itself is wrong (refuse the trigger now, not at fire time). */
const SHAPE_CODES = new Set(["SYMBOL_NOT_FOUND", "INVALID_ORDER", "CAPABILITY_UNSUPPORTED"]);

const invalid = (path, message) => new BridgeError("VALIDATION_FAILED", message, { errors: [{ path, message }] });

/**
 * After-market orders (origin "amo") are held on this Bridge and sent at 09:15 IST on the next trading day, through
 * every gate (pre-open is not used: 09:15 only). No broker adapter maps a native AMO flag yet, so live AMOs are
 * Bridge-held too and say so (`held: "bridge"`); a native one would be "broker".
 */
/** Session times come from the reference store's defaults (reference/defaults.mjs), never literals here. */
const sessionOf = (exchange) => defaultSessionFor(exchange) ?? defaultSessionFor("NFO");
const istDayOf = (ms) => istIso(ms).slice(0, 10);
const atIst = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The session close on a "YYYY-MM-DD" day (a contract's expiry close), IST. */
const closeOf = (day, exchange = "NFO") => atIst(day, sessionOf(exchange).close);

/**
 * @param {object} deps core deps plus orders, marketData, symbols, accounts
 * @param {{ timers?: { setInterval: Function, clearInterval: Function }, intervalMs?: number }} [opts]
 */
export function createTriggerService(deps, { timers = { setInterval, clearInterval }, intervalMs = 1000 } = {}) {
  const dir = join(deps.paths.dataDir, "triggers");
  const file = join(dir, "triggers.json");
  const now = () => deps.clock?.now?.() ?? Date.now();
  const log = deps.logger?.child?.({ module: "triggers" }) ?? deps.logger;
  let state = { v: 1, items: [] };
  let timer = null;
  let running = false;
  let lastSweep = 0;

  // ── store ──
  function load() {
    try {
      if (existsSync(file)) {
        const s = JSON.parse(readFileSync(file, "utf8"));
        if (s && Array.isArray(s.items)) state = { v: 1, items: s.items.filter((t) => t && typeof t.id === "string" && Array.isArray(t.legs)) };
      }
    } catch (err) {
      // Kept aside (never overwritten by the next save) so the triggers in it can be recovered by hand.
      const aside = `${file}.corrupt-${now()}`;
      try {
        renameSync(file, aside);
      } catch {
        /* nothing more to do */
      }
      log?.error?.("triggers file could not be read; starting empty (the file was kept aside)", { error: String(err?.message ?? err), keptAs: aside });
    }
  }
  function save() {
    const open = state.items.filter((t) => OPEN_STATUSES.has(t.status));
    const closed = state.items.filter((t) => !OPEN_STATUSES.has(t.status)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, KEPT_CLOSED);
    state.items = [...open, ...closed];
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(state, null, 1)}\n`);
  }
  load();

  const find = (id) => {
    const t = state.items.find((x) => x.id === id);
    if (!t) throw new BridgeError("NOT_FOUND", `No trigger ${id}.`);
    return t;
  };
  const touch = (t) => (t.updatedAt = istIso(now()));
  const emit = (t, event) => {
    try {
      deps.bus?.emit?.("strategy.guard", { kind: "trigger", event, id: t.id, accountId: t.account, symbol: t.symbol, status: t.status, mode: t.mode, message: t.result?.message ?? null, orderId: t.result?.orderId ?? null, at: t.updatedAt });
    } catch {
      /* the bus never stops the engine */
    }
  };

  /** The context a trigger's order is sent with: source guard, its own principal, only its account, the owner's scopes. */
  function ctxFor(t) {
    return createCallContext({ source: "guard", principal: { kind: "guard", id: t.id, label: t.name }, scopes: t.owner?.scopes ?? ["paper"], hookAccounts: [t.account], log });
  }

  /** The public shape (no owner scopes). */
  function view(t) {
    const { owner, ...rest } = t;
    return { ...structuredClone(rest), owner: owner ? { label: owner.label ?? null, keyId: owner.keyId ?? null } : null };
  }

  /** The intraday square-off time (the paper engine's setting, HH:MM IST). */
  const squareOffTime = () => deps.config?.paper?.squareOff?.time ?? PAPER_DEFAULTS.squareOffTime;

  /** Whether an IST day is a trading day: the reference calendar when there is one (holidays), else weekdays. */
  function tradingDay(day, exchange) {
    try {
      const cal = deps.reference?.calendar?.();
      if (cal && typeof cal.isTradingDay === "function") return cal.isTradingDay(day, exchange === "BFO" || exchange === "BSE" ? "BFO" : "NFO");
    } catch {
      /* fall through */
    }
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6;
  }
  /** The next session open (09:15 IST) at or after `t`: today's if it is a trading day and not yet open, else the next. */
  function nextOpen(t, exchange) {
    let day = istDayOf(t);
    const open = sessionOf(exchange).open;
    if (tradingDay(day, exchange) && t < atIst(day, open)) return atIst(day, open);
    for (let i = 0; i < 15; i += 1) {
      day = addDays(day, 1);
      if (tradingDay(day, exchange)) return atIst(day, open);
    }
    return atIst(day, open);
  }
  /** Whether the market takes orders now (regular session on a trading day). */
  function marketOpenNow(t, exchange) {
    return tradingDay(istDayOf(t), exchange) && marketSession(new Date(t)).state === "OPEN";
  }

  async function ltpOf(symbol, mode) {
    try {
      const r = await deps.marketData.ltp([symbol], { maxAgeMs: 2000, priority: mode === "live" ? "live" : "interactive" });
      const v = Number(r?.items?.find((x) => x.symbol === symbol)?.ltp ?? r?.items?.[0]?.ltp);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  // ── create / change / cancel ──

  /**
   * @param {import("../core/context.mjs").RequestContext} ctx
   * @param {object} input { account, symbol, type, legs[], product, mode?, origin?, parentOrderId?, name?, expiresAt? }
   */
  async function create(ctx, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("", "Send the trigger as a JSON object.");
    if (ctx.key?.clientKind === "mcp") throw new BridgeError("SCOPE_REQUIRED", "Triggers place orders on their own later, so AI assistant keys cannot set them. Set them from the dashboard or a script.");
    const account = String(input.account ?? "");
    ctx.requireAccountAccess(account);
    const summary = deps.accounts.get(account);
    const type = input.type ?? (Array.isArray(input.legs) && input.legs.length === 2 ? "oco" : "single");
    if (!TRIGGER_TYPES.includes(type)) throw invalid("type", `type must be ${TRIGGER_TYPES.join(" or ")}.`);
    const origin = input.origin ?? "gtt";
    if (!TRIGGER_ORIGINS.includes(origin)) throw invalid("origin", `origin must be ${TRIGGER_ORIGINS.join(", ")}.`);
    const product = input.product;
    if (!["INTRADAY", "MARGIN", "CNC", "MTF"].includes(product)) throw invalid("product", "product must be INTRADAY, MARGIN, CNC or MTF.");
    const mode = input.mode === "live" ? "live" : "paper";
    if (state.items.filter((t) => OPEN_STATUSES.has(t.status)).length >= MAX_OPEN) throw invalid("", `At most ${MAX_OPEN} open triggers. Cancel one first.`);
    if (origin === "bracket" && typeof input.parentOrderId !== "string") throw invalid("parentOrderId", "A bracket trigger needs the entry order's id (parentOrderId).");

    // The owner's scopes travel with the trigger: a paper key's trigger can never send live.
    const scopes = [...ctx.scopes].filter((s) => s === "read" || s === "paper" || s === "live");
    const guardCtx = createCallContext({ source: "guard", principal: { kind: "guard", id: "new" }, scopes, hookAccounts: [account], log });
    if (mode === "live") {
      const accountCfg = (deps.config?.accounts ?? []).find((a) => a.id === account);
      const d = decideMode({ config: deps.config, accountCfg, summary, requested: "live", ctx: guardCtx, confirmPaperFromMcp: true });
      if (d.refusals.length) {
        const why = d.refusals.map((r) => r.message).join(" ");
        throw new BridgeError("PAPER_ONLY", `This trigger cannot send live orders: ${why} Live triggers also need "guard" in accounts[].live.allowedSources.`);
      }
    }

    let resolved;
    try {
      resolved = await deps.symbols.resolve(String(input.symbol ?? ""));
    } catch (err) {
      throw invalid("symbol", err?.detail ?? `${input.symbol} could not be found.`);
    }
    const tick = Number(resolved.tickSize) > 0 ? Number(resolved.tickSize) : 0.05;
    const lotSize = Number(resolved.lotSize) > 0 ? Number(resolved.lotSize) : 1;
    const amo = origin === "amo";
    if (amo) {
      if (type !== "single" || !Array.isArray(input.legs) || input.legs.length !== 1) throw invalid("legs", "An after-market order has one leg.");
      if (marketOpenNow(now(), resolved.exchange)) throw invalid("origin", "The market is open: place the order now instead of as an after-market order.");
    }
    const ltp = origin === "bracket" ? null : await ltpOf(resolved.canonical, mode);
    if (origin !== "bracket" && !amo && ltp === null) throw new BridgeError("BROKER_UNAVAILABLE", `No current price for ${resolved.canonical}, so the trigger side cannot be set. Try again in a moment.`);

    const legs = (Array.isArray(input.legs) ? input.legs : []).map((l, i) => {
      const o = l?.order ?? {};
      const units = Number.isInteger(o.quantity) && o.quantity > 0 ? o.quantity : Number.isInteger(o.lots) && o.lots > 0 ? o.lots * lotSize : null;
      if (units === null) throw invalid(`legs.${i}.order.quantity`, "Each leg needs quantity (units) or lots.");
      if (units % lotSize !== 0) throw invalid(`legs.${i}.order.quantity`, `quantity must be a whole number of lots (lot ${lotSize}).`);
      if (!["BUY", "SELL"].includes(o.side)) throw invalid(`legs.${i}.order.side`, "side must be BUY or SELL.");
      const orderType = o.orderType ?? "MARKET";
      if (!["LIMIT", "MARKET"].includes(orderType)) throw invalid(`legs.${i}.order.orderType`, "A trigger's order is LIMIT or MARKET.");
      if (orderType === "LIMIT" && !(Number(o.price) > 0)) throw invalid(`legs.${i}.order.price`, "A LIMIT leg needs a price above zero.");
      const trigger = amo ? null : toTick(Number(l.trigger), tick);
      const op = amo ? "open" : (l.op ?? (ltp !== null ? opFor(trigger, ltp) : null));
      if (op === null) throw invalid(`legs.${i}.trigger`, `The trigger equals the price now (${ltp}). Place the order instead, or move the trigger.`);
      const trail = l.trail && (Number(l.trail.points) > 0 || Number(l.trail.pct) > 0) ? (Number(l.trail.points) > 0 ? { points: Number(l.trail.points) } : { pct: Number(l.trail.pct) }) : null;
      return {
        role: ["entry", "stop", "target"].includes(l.role) ? l.role : origin === "gtt" || amo ? "entry" : op === (o.side === "SELL" ? "below" : "above") ? "stop" : "target",
        op,
        trigger,
        trail,
        best: null,
        order: { side: o.side, quantity: units, orderType, ...(orderType === "LIMIT" ? { price: toTick(Number(o.price), tick) } : {}) },
      };
    });
    const problems = amo ? [] : legProblems(type, legs, ltp);
    if (problems.length) throw new BridgeError("VALIDATION_FAILED", problems[0].message, { errors: problems });
    if (origin !== "gtt" && !amo && legs.some((l) => l.order.side !== legs[0].order.side)) throw invalid("legs", "An exit's legs close the same position, so they are on the same side.");

    // The order shape is checked now through the normal preview (symbol, lots, tick). Safety limits are checked
    // again when it fires, against that moment's book; here they only become warnings shown on the trigger.
    const warnings = [];
    for (const leg of legs) {
      const body = orderBody({ account, symbol: resolved.canonical, product, mode, id: "preview" }, leg, { tick });
      let pv;
      try {
        pv = await deps.orders.preview(guardCtx, body);
      } catch (err) {
        throw err instanceof BridgeError ? err : invalid("legs", String(err?.message ?? err));
      }
      // A price band refusal is about the price now, not the order: the trigger may sit far from it.
      const bad = (pv.checks ?? []).find((c) => c.severity === "block" && SHAPE_CODES.has(c.code) && !/last traded price|price band/i.test(c.message));
      if (bad) throw new BridgeError("VALIDATION_FAILED", bad.message, { errors: [{ path: "legs", message: bad.message }] });
      // An after-market order goes on a later IST day: today's daily counters (loss, order count) will have reset.
      for (const c of pv.checks ?? []) if (c.severity === "block" && !(amo && c.code === "DAILY_LIMIT_REACHED") && !warnings.includes(c.message)) warnings.push(c.message);
    }

    const t0 = now();
    // Good till: a year, the contract's expiry close, or for intraday the IST day's close.
    let expires = t0 + YEAR_MS;
    if (resolved.expiry) expires = Math.min(expires, closeOf(resolved.expiry));
    if (product === "INTRADAY") {
      // An intraday order sent on a later day would be squared off: an intraday trigger ends at the 15:20 square-off
      // (today's, or the next day's when it is set after it).
      const cut = atIst(istIso(t0).slice(0, 10), squareOffTime());
      expires = Math.min(expires, cut > t0 ? cut : cut + 86_400_000);
    }
    // An after-market order is for the next session only: it goes at 09:15 and lapses at that day's close (15:20 for
    // intraday) if the Bridge could not send it.
    const openAt = amo ? nextOpen(t0, resolved.exchange) : null;
    if (amo) {
      expires = atIst(istDayOf(openAt), product === "INTRADAY" ? squareOffTime() : sessionOf(resolved.exchange).close);
      if (resolved.expiry && closeOf(resolved.expiry) < expires) expires = closeOf(resolved.expiry);
    }
    if (amo && expires <= openAt) throw invalid("symbol", "The contract expires before the next session opens.");
    if (input.expiresAt && !amo) {
      const want = Date.parse(String(input.expiresAt));
      if (!Number.isFinite(want) || want <= t0) throw invalid("expiresAt", "expiresAt must be a future time.");
      expires = Math.min(expires, want);
    }
    const id = `trg_${randomBytes(6).toString("hex")}`;
    const name = String(input.name ?? "").slice(0, 80) || `${resolved.canonical.split(":").pop()} ${amo ? "AMO" : type === "oco" ? "OCO" : "GTT"}`;
    const t = {
      id,
      name,
      account,
      symbol: resolved.canonical,
      tick,
      lotSize,
      product,
      mode,
      type,
      origin,
      reduceOnly: origin !== "gtt" && !amo,
      ...(amo ? { openAt: istIso(openAt), held: "bridge" } : {}),
      parentOrderId: origin === "bracket" ? input.parentOrderId : null,
      legs,
      status: origin === "bracket" ? "waiting" : "active",
      createdAt: istIso(t0),
      updatedAt: istIso(t0),
      expiresAt: istIso(expires),
      ltpAtCreate: ltp,
      lastLtp: ltp,
      firedLeg: null,
      firedAt: null,
      attempts: 0,
      retryAt: null,
      result: null,
      warnings,
      owner: { scopes, keyId: ctx.key?.id ?? null, label: ctx.key?.label ?? ctx.principal?.label ?? null },
    };
    state.items.push(t);
    try {
      save();
    } catch (err) {
      // Not on disk means not set: a trigger the caller was told failed must never fire.
      state.items = state.items.filter((x) => x !== t);
      log?.error?.("trigger could not be saved", { error: String(err?.message ?? err) });
      throw new BridgeError("INTERNAL", "The trigger could not be saved to disk, so it was not set.");
    }
    emit(t, "created");
    return view(t);
  }

  /**
   * Who may change or cancel a trigger: a key that may use its account and, for a live trigger, has the "live" scope
   * (as for changing or cancelling a live order). AI assistant keys cannot change one (they cannot set one either).
   */
  function requireWrite(ctx, t, action) {
    ctx.requireAccountAccess(t.account);
    if (action === "change" && ctx.key?.clientKind === "mcp") throw new BridgeError("SCOPE_REQUIRED", "Triggers place orders on their own later, so AI assistant keys cannot change them. Change them from the dashboard or a script.");
    if (t.mode === "live" && !(ctx.scopes?.has("live") || ctx.principal?.kind === "local")) throw new BridgeError("SCOPE_REQUIRED", `${action === "change" ? "Changing" : "Cancelling"} a live trigger needs a key with the "live" scope.`);
  }

  /** Change a trigger price, a limit price or the trail of an open trigger (not while it is firing). */
  async function update(ctx, id, changes) {
    const t = find(id);
    requireWrite(ctx, t, "change");
    if (!["waiting", "active"].includes(t.status)) throw new BridgeError("STATE_CONFLICT", `Trigger ${id} is ${t.status}; only a waiting or active trigger can be changed.`);
    const legs = Array.isArray(changes?.legs) ? changes.legs : null;
    if (!legs || legs.length !== t.legs.length) throw invalid("legs", `Send legs as a list of ${t.legs.length}, in order, with the fields to change.`);
    const next = structuredClone(t.legs);
    legs.forEach((c, i) => {
      if (c?.trigger !== undefined && t.origin === "amo") throw invalid(`legs.${i}.trigger`, "An after-market order has no trigger; it goes at the open.");
      if (c?.trigger !== undefined) next[i].trigger = toTick(Number(c.trigger), t.tick);
      if (c?.price !== undefined) {
        if (next[i].order.orderType !== "LIMIT") throw invalid(`legs.${i}.price`, "Only a LIMIT leg has a price.");
        next[i].order.price = toTick(Number(c.price), t.tick);
      }
      if (c?.trail !== undefined) next[i].trail = c.trail && (Number(c.trail.points) > 0 || Number(c.trail.pct) > 0) ? (Number(c.trail.points) > 0 ? { points: Number(c.trail.points) } : { pct: Number(c.trail.pct) }) : null;
    });
    const ltp = t.status === "waiting" || t.origin === "amo" ? null : await ltpOf(t.symbol, t.mode);
    const problems = t.origin === "amo" ? [] : legProblems(t.type, next, ltp);
    if (problems.length) throw new BridgeError("VALIDATION_FAILED", problems[0].message, { errors: problems });
    t.legs = next;
    touch(t);
    save();
    emit(t, "updated");
    return view(t);
  }

  function cancel(ctx, id, reason = "Cancelled by you.") {
    const t = find(id);
    requireWrite(ctx, t, "cancel");
    if (!["waiting", "active"].includes(t.status)) throw new BridgeError("STATE_CONFLICT", `Trigger ${id} is ${t.status}; it cannot be cancelled now.`);
    close(t, "cancelled", { message: reason });
    return view(t);
  }

  function close(t, status, result) {
    t.status = status;
    t.result = { ...(t.result ?? {}), ...result };
    touch(t);
    save();
    emit(t, status);
  }

  function list(allowed, { status, account } = {}) {
    return state.items
      .filter((t) => allowed(t.account) && (!account || t.account === account) && (!status || (status === "open" ? OPEN_STATUSES.has(t.status) : t.status === status)))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(view);
  }

  // ── firing ──

  /** The order body a leg sends. */
  function orderBody(t, leg, { tick = t.tick, quantity = leg.order.quantity } = {}) {
    return {
      account: t.account,
      symbol: t.symbol,
      side: leg.order.side,
      quantity,
      product: t.product,
      orderType: leg.order.orderType,
      ...(leg.order.orderType === "LIMIT" ? { price: toTick(leg.order.price, tick) } : {}),
      mode: t.mode,
      clientOrderId: t.id,
      tag: "trigger",
    };
  }

  async function heldQty(t) {
    try {
      const r = await deps.orders.positions(ctxFor(t), t.account, { mode: t.mode });
      const rows = (r?.items ?? []).filter((p) => p.symbol === t.symbol && p.product === t.product);
      return rows.reduce((s, p) => s + Number(p.netQty ?? 0), 0);
    } catch {
      return null;
    }
  }

  /** An order this trigger already placed (restart while firing): found by its clientOrderId. */
  async function placedBefore(t) {
    try {
      return await deps.orders.getByClientId(ctxFor(t), t.id);
    } catch {
      try {
        const page = await deps.orders.list(ctxFor(t), { accountId: t.account, limit: 500 });
        return (page?.items ?? []).find((o) => o.clientOrderId === t.id) ?? null;
      } catch {
        return null;
      }
    }
  }

  async function fire(t, legIndex, ltp) {
    const leg = t.legs[legIndex];
    t.status = "firing";
    t.firedLeg = legIndex;
    t.firedAt ??= istIso(now());
    t.fireLtp = ltp;
    t.attempts += 1;
    touch(t);
    save(); // firing is on disk before the order goes out: a restart resolves it, never sends it blind
    await send(t, leg);
  }

  async function send(t, leg) {
    let quantity = leg.order.quantity;
    if (t.reduceOnly) {
      const r = reduceOnlyQty(quantity, leg.order.side, await heldQty(t));
      if (!r.quantity) return close(t, "cancelled", { message: r.reason, code: "REDUCE_ONLY" });
      quantity = r.quantity;
    }
    try {
      const out = await deps.orders.place(ctxFor(t), orderBody(t, leg, { quantity }), { idempotencyKey: `trigger.${t.id}` });
      const o = out?.order ?? out;
      const refused = o?.status === "rejected";
      close(t, "triggered", { orderId: o?.orderId ?? null, status: o?.status ?? null, message: refused ? o?.statusMessage ?? "The order was rejected." : null, quantity });
    } catch (err) {
      const code = err?.code ?? "INTERNAL";
      const message = err?.detail ?? err?.message ?? "The order was refused.";
      if (RETRYABLE.has(code)) {
        t.status = "active";
        t.retryAt = istIso(now() + RETRY_MS);
        t.result = { code, message: `${message} Trying again while the condition holds.` };
        touch(t);
        save();
        emit(t, "retry");
        return;
      }
      close(t, "failed", { code, message });
    }
  }

  /** After a restart: a trigger left "firing" is resolved by its order, or sent again with the same key. */
  async function recover() {
    for (const t of state.items.filter((x) => x.status === "firing")) {
      const o = await placedBefore(t);
      if (o) close(t, "triggered", { orderId: o.orderId, status: o.status, message: o.status === "rejected" ? o.statusMessage ?? null : null, recovered: true });
      // Its time ran out while the Bridge was stopped (an intraday trigger on a later day, an AMO after its session):
      // the condition it fired on is gone, so nothing is sent.
      else if (Date.parse(t.expiresAt) <= now()) close(t, "expired", { message: "The Bridge stopped while this trigger was firing, and it expired before the Bridge started again. Nothing was sent." });
      else await send(t, t.legs[t.firedLeg ?? 0]);
    }
  }

  /** A bracket's exits arm when its entry fills (with the filled quantity); a cancelled or rejected entry cancels them. */
  async function syncParent(t, order) {
    // Only a bracket still waiting: it may have been cancelled (or armed) while its entry order was being read.
    if (!order || t.status !== "waiting") return;
    if (order.status === "filled") {
      const q = Number(order.filledQuantity ?? order.quantity);
      for (const leg of t.legs) if (q > 0) leg.order.quantity = Math.min(leg.order.quantity, q);
      t.status = "active";
      t.armedAt = istIso(now());
      touch(t);
      save();
      emit(t, "armed");
    } else if (["cancelled", "rejected", "expired"].includes(order.status)) {
      close(t, "cancelled", { message: `The entry order was ${order.status}, so its exits were cancelled.` });
    }
  }

  async function runOnce() {
    if (running) return 0;
    running = true;
    let fired = 0;
    try {
      const t0 = now();
      const open = state.items.filter((t) => t.status === "active" || t.status === "waiting");
      for (const t of open) {
        if (Date.parse(t.expiresAt) <= t0) close(t, "expired", { message: "Expired before the trigger was reached." });
      }
      // Waiting brackets: read the entry order (the bus also tells us; this covers a restart).
      for (const t of state.items.filter((x) => x.status === "waiting")) {
        try {
          await syncParent(t, await deps.orders.get(ctxFor(t), t.parentOrderId));
        } catch (err) {
          if (err?.code === "ORDER_NOT_FOUND" && t.status === "waiting") close(t, "cancelled", { message: "The entry order was not found." });
        }
      }
      // After-market orders: at the open, one gap check for a market order, then the normal fire (every gate).
      for (const t of state.items.filter((x) => x.status === "active" && x.origin === "amo" && Date.parse(x.openAt) <= t0 && (!x.retryAt || Date.parse(x.retryAt) <= t0))) {
        const leg = t.legs[0];
        const px = await ltpOf(t.symbol, t.mode);
        if (t.status !== "active") continue; // cancelled (or expired) while the price was read: never sent
        if (leg.order.orderType === "MARKET") {
          const band = Number(deps.safety?.limits?.(t.account)?.limits?.priceBandPct);
          const ref = Number(t.ltpAtCreate);
          if (px === null) continue; // no opening price yet: wait for one
          if (band > 0 && ref > 0 && (Math.abs(px - ref) / ref) * 100 > band) {
            close(t, "failed", { code: "PRICE_BAND", message: `The market opened ${((Math.abs(px - ref) / ref) * 100).toFixed(2)}% away from ${ref} (the price when it was set), beyond the ${band}% price band, so the after-market market order was not sent.` });
            continue;
          }
        }
        t.lastLtp = px;
        fired += 1;
        await fire(t, 0, px);
      }
      const active = state.items.filter((t) => t.status === "active" && t.origin !== "amo" && (!t.retryAt || Date.parse(t.retryAt) <= t0));
      const bySymbol = new Map();
      for (const t of active) bySymbol.set(`${t.mode}|${t.symbol}`, [...(bySymbol.get(`${t.mode}|${t.symbol}`) ?? []), t]);
      for (const [key, ts] of bySymbol) {
        const ltp = await ltpOf(key.slice(key.indexOf("|") + 1), key.split("|")[0]);
        if (ltp === null) continue;
        for (const t of ts) {
          if (t.status !== "active") continue;
          t.lastLtp = ltp;
          const r = step(t, ltp, t.tick);
          if (r.fire !== null) {
            fired += 1;
            await fire(t, r.fire, ltp);
          } else if (r.moved) {
            touch(t);
            save();
            emit(t, "trailed");
          }
        }
      }
      // Exits whose position went flat (closed by hand) are cancelled, once a minute.
      if (t0 - lastSweep >= 60_000) {
        lastSweep = t0;
        for (const t of state.items.filter((x) => x.status === "active" && x.reduceOnly)) {
          const held = await heldQty(t);
          if (held === 0) close(t, "cancelled", { message: "The position is already closed.", code: "REDUCE_ONLY" });
        }
      }
    } catch (err) {
      log?.warn?.("trigger check failed", { error: String(err?.message ?? err) });
    } finally {
      running = false;
    }
    return fired;
  }

  let offBus = null;
  return {
    create,
    update,
    cancel,
    list,
    get: (ctx, id) => {
      const t = find(id);
      ctx.requireAccountAccess(t.account);
      return view(t);
    },
    runOnce,
    recover,
    async start() {
      await recover();
      const handler = (p) => {
        for (const t of state.items.filter((x) => x.status === "waiting" && x.parentOrderId === p?.orderId)) syncParent(t, p).catch(() => {});
      };
      offBus = deps.bus?.on?.("order.updated", handler) ?? null;
      timer = timers.setInterval(() => runOnce(), intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
      if (typeof offBus === "function") offBus();
      offBus = null;
    },
    /** Tests: the stored items as on disk. */
    _state: () => state,
  };
}
