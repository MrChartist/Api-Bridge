/**
 * SafetyGuard (docs/ARCHITECTURE.md §8). Contract: SERVICE_CONTRACTS.safety in
 * ../core/contracts.mjs. Every order intent, paper or live, passes check() before anything is sent.
 *
 * check() collects EVERY reason an intent is refused (not just the first), so a caller can fix them all at once:
 *
 *   rule                     place  modify  cancel  notes
 *   account known/allowed      x      x       x     ACCOUNT_NOT_FOUND / ACCOUNT_FORBIDDEN; disabled account refused
 *   kill switch                x      x       -     cancels always pass, so cancelOpenOrders can work
 *   live enablement            x      x       -     safety.liveTrading AND account live.enabled AND allowed source
 *   live key scope             x      x       x     ctx.scopes has "live" for any live action
 *   order-rate cap             x      x       x     sliding window, default 5/s, never above 10/s; paper and live
 *                                                    have separate windows, so a paper strategy meets the cap too
 *   daily order count          x      -       -     per mode, IST day; a passing place reserves its slot at once
 *   daily loss                 x      -       -     per mode, IST day: paper from the paper engine's fill events,
 *                                                    live from the broker's day P&L read before each live order
 *   max order value / lots     x      x       -     a modify is checked on the order after the change (new quantity,
 *                                                    new price, else LTP); live place or modify with an unknown value
 *                                                    is refused, paper warns
 *   price band vs LTP          x      x       -     price and trigger price
 *   market-order policy        x      x       -     "reject" refuses MARKET/SL-M; "protect" warns
 *   market hours               x      x       -     live refused when closed; paper warned (not in demo). NSE/BSE/NFO/BFO
 *                                                    from lib/marketHours; MCX and CDS from a weekday time window
 *                                                    (needs verification; no holiday list for them)
 *   static IP                  warn   warn    -     when registeredIp is set and the detected egress IP differs
 *   F&O ban (fnoBan)           x      x       -     stock derivatives in the exchange ban period:
 *                                                    an order that increases the absolute net position in that
 *                                                    contract is refused (FNO_BAN); closing passes with a warning;
 *                                                    unknown held quantity warns (FNO_BAN_UNCONFIRMED) and the broker
 *                                                    decides. fno.ban.blockOpening false makes it a warning (audited)
 *
 * Paper and live are counted separately: paper orders never use up the live day's budget and vice versa.
 *
 * Limits: the stricter of config.safety and the account's limits (effectiveAccountLimits), then any runtime
 * tightening for today (tightenLimits(), persisted, dropped at IST midnight). Nothing at runtime can loosen a limit;
 * the order rate is clamped to SEBI_UNREGISTERED_OPS_CEILING (10/s) whatever the config says.
 *
 * Kill switch: persisted in <dataDir>/safety/kill-switch.json; engaged at boot by config.safety.killSwitchOnStart
 * (which MCB_KILL_SWITCH=1 sets) or when any safety state file is unreadable. Any authenticated caller may engage
 * it. Release needs: confirm "RELEASE", a loopback caller, the admin scope (or the local CLI), and a source that is
 * not an AI assistant or a webhook. Both actions are audited and emit "safety.kill_switch"; OrderService listens
 * and runs cancelAll when cancelOpenOrders is true (safety does not depend on orders, which would be a cycle).
 *
 * Refusals are audited as "safety.refused" (repeats of the same refusal within a minute are folded into the next
 * record's `suppressed` count, so a runaway script cannot flood the log).
 */
import { join } from "node:path";
import { SEBI_UNREGISTERED_OPS_CEILING, effectiveAccountLimits, liveAllowedByConfig } from "../core/config.mjs";
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { orderSession as libOrderSession } from "../../lib/marketHours.mjs";
import { sharedCalendar } from "../reference/sharedCalendar.mjs";
import { INDEX_NAMES, parseSymbol } from "../core/symbolFormat.mjs";
import { sameIp } from "../readiness/ip.mjs";
import { createDailyCounters } from "./dailyCounters.mjs";
import { createKillSwitchStore } from "./killSwitch.mjs";
import { createOrderRateWindow, windowFor } from "./orderRate.mjs";
import { istIso } from "./time.mjs";

export const ACTIONS = Object.freeze(["place", "modify", "cancel"]);

const dayMonthText = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? ""));
  return m ? `${Number(m[3])} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1]}` : null;
};

/**
 * The F&O ban rule, pure. With held quantity h (signed units in that contract,
 * this account) and the order's signed quantity x, n = h + x is closing iff |n| ≤ |h| and sign(n) ∈ {0, sign(h)};
 * anything else opens (or increases) a position and is refused. A fresh position in another contract of the same
 * stock is refused too (per-contract reading of the exchange rule; needs verification).
 * @param {{ underlying: string, side: "BUY"|"SELL", qty: number, heldQty: number|null, ban: { inBan?: boolean|null, mwplPct?: number|null, forDate?: string|null } | null,
 *   blockOpening?: boolean }} p
 * @returns {{ code: string, severity: "block"|"warn", message: string } | null}
 */
export function fnoBanCheck({ underlying, side, qty, heldQty, ban, blockOpening = true }) {
  if (!ban || ban.inBan !== true) return null;
  const x = side === "BUY" ? Math.abs(qty) : -Math.abs(qty);
  if (heldQty === null || heldQty === undefined || !Number.isFinite(heldQty)) {
    return { code: "FNO_BAN_UNCONFIRMED", severity: "warn", message: `${underlying} is in the F&O ban. This order is allowed only if it reduces a position; the Bridge could not read your positions, so the broker decides.` };
  }
  const h = heldQty;
  const n = h + x;
  const closing = Math.abs(n) <= Math.abs(h) && (n === 0 || Math.sign(n) === Math.sign(h));
  if (closing) return { code: "FNO_BAN_CLOSING", severity: "warn", message: "Closing order in a ban-period stock." };
  const when = [ban.mwplPct !== null && ban.mwplPct !== undefined ? `MWPL ${ban.mwplPct} %` : null, dayMonthText(ban.forDate)].filter(Boolean).join(", ");
  const held = h === 0 ? "You hold none of this contract, so this would be a fresh position." : `You hold ${h} of this contract: you can ${h > 0 ? "sell" : "buy"} up to ${Math.abs(h)}.`;
  const message = `${underlying} is in the F&O ban period${when ? ` (${when})` : ""}. Only orders that reduce your position are allowed. ${held}`;
  return { code: "FNO_BAN", severity: blockOpening ? "block" : "warn", message: blockOpening ? message : `${message} (fno.ban.blockOpening is off: the broker decides.)` };
}
export const NUMERIC_LIMITS = Object.freeze(["dailyMaxOrders", "dailyMaxLoss", "maxOrderValue", "maxLotsPerOrder", "orderRatePerSecond", "priceBandPct", "marketProtectionPct"]);
const EQUITY_SESSION_EXCHANGES = new Set(["NSE", "BSE", "NFO", "BFO"]);
const DERIVATIVE_EXCHANGES = new Set(["NFO", "BFO", "MCX", "CDS"]);
const RELEASE_FORBIDDEN_SOURCES = new Set(["mcp", "webhook"]);
const LIMIT_CODES = new Set(["DAILY_LIMIT_REACHED", "ORDER_RATE_LIMITED"]);
/** The same refusal (account, mode, action, reasons) within this time is one audit record with a count: a script retrying after the daily limit must not add a line per request. */
const REFUSAL_FOLD_MS = 60_000;
/**
 * Weekday trading windows (IST minutes from midnight) for exchanges lib/marketHours.mjs does not cover. Needs
 * verification: MCX closes at 23:30 or 23:55 depending on US daylight saving, so the later time is used (the broker
 * refuses anything in between); exchange holidays are not known here.
 */
const SESSION_WINDOWS = Object.freeze({
  MCX: { open: 9 * 60, close: 23 * 60 + 55, label: "09:00 to 23:55 IST" },
  CDS: { open: 9 * 60, close: 17 * 60, label: "09:00 to 17:00 IST" },
});
const IST_OFFSET_MS = 330 * 60_000;
/** Whether an MCX/CDS window is open at epoch ms t (weekday and time only). */
function windowOpen(exch, t) {
  const w = SESSION_WINDOWS[exch];
  if (!w) return true;
  const d = new Date(t + IST_OFFSET_MS);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= w.open && mins < w.close;
}

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
/** ₹ with Indian digit grouping, e.g. ₹2,00,000. */
export const rupees = (n) => INR.format(n);

/** "key:abc123" style label for who did something. */
export function actorLabel(ctx) {
  const p = ctx?.principal ?? { kind: "anonymous", id: "anonymous" };
  return `${p.kind}:${p.id}`;
}

const actorOf = (ctx) => ({ kind: ctx?.principal?.kind ?? "system", id: ctx?.principal?.id ?? "system" });
const exchangeOf = (symbol) => (typeof symbol === "string" && symbol.includes(":") ? symbol.split(":")[0].toUpperCase() : null);
/**
 * What the session gate needs to know about a contract: { kind: "index"|"stock"|null, expiry } from the canonical symbol and
 * the underlying kind the order service found. Index contracts expiring today close earlier (reference/data/sessions.json).
 */
function instrumentOf(symbol, underlyingKind) {
  let expiry = null;
  let kind = underlyingKind === "index" || underlyingKind === "stock" ? underlyingKind : null;
  try {
    const p = parseSymbol(symbol);
    expiry = p.expiry ?? null;
    if (!kind && INDEX_NAMES.includes(p.underlying)) kind = "index";
  } catch {
    /* an unparsable symbol is left unknown */
  }
  return { kind, expiry };
}
const finitePos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * @param {{ config: any, logger: any, bus: any, clock?: { now(): number }, paths: { dataDir: string }, audit: any, accounts?: any }} deps
 * @param {{ dir?: string, env?: Record<string, string | undefined>, egressIp?: string | null,
 *   marketSession?: (d: Date) => { state: string, label: string } }} [opts]
 *   dir overrides <dataDir>/safety; env is checked for MCB_KILL_SWITCH (default process.env); egressIp seeds the
 *   detected egress address (see setDetectedEgressIp); marketSession replaces lib/marketHours.mjs (tests).
 * @returns {object} SafetyGuard plus helpers: status(ctx), tightenLimits(ctx, accountId, values), setDetectedEgressIp(ip)
 */
export function createSafetyGuard(deps, opts = {}) {
  const { config, logger, bus } = deps;
  const audit = deps.audit;
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const dir = opts.dir ?? join(deps.paths.dataDir, "safety");
  const env = opts.env ?? process.env;
  const sessionAt = opts.marketSession ?? libOrderSession;
  /**
   * Reference calendar: holiday-aware sessions for NSE/BSE/NFO/BFO. A reference service, when one is wired, wins; the
   * default is the shared calendar built from the shipped reference data (the same source as lib/marketHours), so the
   * holiday list applies in every installation. It only tightens: the guard takes the stricter of the two answers.
   */
  const reference = (() => {
    try {
      const r = deps.reference;
      if (r && !isStub(r) && typeof r.session === "function") return r;
    } catch {
      /* fall through to the shipped calendar */
    }
    if (opts.marketSession) return null; // a test that supplies its own session answers for itself
    const cal = sharedCalendar();
    return { session: (exch, t, o) => cal.sessionAt(exch, t, { gate: true, ...(o ?? {}) }) };
  })();
  let egressIp = typeof opts.egressIp === "string" && opts.egressIp ? opts.egressIp : null;

  const killSwitch = createKillSwitchStore({ dir, logger });
  const counters = createDailyCounters({ dir, now, logger });
  const rate = createOrderRateWindow();
  /** Paper orders have their own window (same cap), so a paper strategy meets the cap before it goes live. */
  const rateKey = (accountId, mode) => (mode === "paper" ? `paper:${accountId}` : String(accountId));
  /** Daily-count reservations: passing place checks not yet recorded. accountId|mode -> expiry times (ms). */
  const reserved = new Map();
  const RESERVE_TTL_MS = 30_000;
  const reservedCount = (accountId, mode, t) => {
    const k = `${accountId}|${mode}`;
    const list = (reserved.get(k) ?? []).filter((exp) => exp > t);
    if (list.length) reserved.set(k, list);
    else reserved.delete(k);
    return list.length;
  };
  /** @type {Map<string, { at: number, suppressed: number }>} */
  const refusalFold = new Map();

  const accountById = (id) => config.accounts.find((a) => a.id === id) ?? null;

  /** Append to the audit log without ever throwing. Returns true when written. */
  async function softAudit(input) {
    if (!audit || isStub(audit)) {
      logger.warn("audit log not available; safety event not audited", { type: input.type, accountId: input.accountId });
      return false;
    }
    try {
      await audit.append(input);
      return true;
    } catch (err) {
      logger.error("audit append failed for safety event", { type: input.type, accountId: input.accountId, code: err?.code });
      return false;
    }
  }

  const emit = (topic, payload) => {
    try {
      bus?.emit(topic, payload);
    } catch (err) {
      logger.error("safety event could not be emitted", { topic, err });
    }
  };

  /** Engage without a request (boot, damaged state). */
  function engageSystem(reason) {
    const { state, changed } = killSwitch.engage({ reason, by: "system:startup", at: istIso(now()) });
    logger.warn("kill switch engaged at start", { reason: state.reason });
    void softAudit({ type: "kill_switch.engaged", actor: { kind: "system", id: "startup" }, source: "system", data: { reason: state.reason, cancelOpenOrders: false, alreadyEngaged: !changed } });
    emit("safety.kill_switch", { ...state, cancelOpenOrders: false });
  }

  // ── Boot ──
  const envKill = env?.MCB_KILL_SWITCH === "1" || env?.MCB_KILL_SWITCH === "true";
  if (killSwitch.loadedFrom === "corrupt") engageSystem(killSwitch.state().reason);
  else if (counters.loadedFrom === "corrupt") engageSystem("Today's safety counters could not be read, so the kill switch was engaged to be safe. Check the order book, then release it.");
  else if (config.safety.killSwitchOnStart || envKill) {
    engageSystem(killSwitch.state().engaged ? killSwitch.state().reason : "Engaged at start (safety.killSwitchOnStart or MCB_KILL_SWITCH).");
  }

  // Paper fills carry the P&L they realised (PaperEngine `order.updated`, status "filled"): count it towards today's
  // paper loss, so dailyMaxLoss can trip in paper as it says it does.
  const offFills =
    bus?.on?.("order.updated", (e) => {
      if (e?.mode !== "paper" || e.status !== "filled" || typeof e.accountId !== "string") return;
      try {
        guard.recordRealisedPnl(e.accountId, "paper", e.realisedPnl);
      } catch (err) {
        logger.warn("paper fill P&L not recorded", { accountId: e.accountId, code: err?.code });
      }
    }) ?? (() => {});

  /**
   * Effective limits for an account (or the global ones for an unknown account): config, then today's tightening.
   * @param {string | null} accountId
   */
  function limitsFor(accountId) {
    const account = accountId ? accountById(accountId) : null;
    const s = config.safety;
    const base = { ...effectiveAccountLimits(config, account), priceBandPct: s.priceBandPct, marketProtectionPct: s.marketProtectionPct, marketOrders: s.marketOrders };
    const t = counters.tightened(accountId ?? "");
    for (const layer of [t.global, accountId ? t.account : {}]) {
      for (const k of NUMERIC_LIMITS) if (typeof layer[k] === "number") base[k] = Math.min(base[k], layer[k]);
      if (layer.marketOrders === "reject") base.marketOrders = "reject";
    }
    base.orderRatePerSecond = Math.min(base.orderRatePerSecond, SEBI_UNREGISTERED_OPS_CEILING);
    return Object.freeze(base);
  }

  function usageFor(accountId) {
    const live = counters.get(accountId, "live");
    const paper = counters.get(accountId, "paper");
    return {
      ordersToday: live.orders,
      realisedPnlToday: live.realisedPnl,
      ordersLastSecond: rate.countLastSecond(accountId, now()),
      paperOrdersLastSecond: rate.countLastSecond(rateKey(accountId, "paper"), now()),
      byMode: { live, paper },
      day: counters.day(),
    };
  }

  /** Audit a refusal, folding identical repeats within a second. */
  function auditRefusal(ctx, intent, reasons) {
    const codes = reasons.map((r) => r.code).sort();
    const key = `${intent.accountId}|${intent.mode}|${intent.action}|${codes.join(",")}`;
    const t = now();
    const prev = refusalFold.get(key);
    if (prev && t - prev.at < REFUSAL_FOLD_MS) {
      prev.suppressed += 1;
      return;
    }
    refusalFold.set(key, { at: t, suppressed: 0 });
    if (refusalFold.size > 500) {
      for (const [k, v] of refusalFold) if (t - v.at >= REFUSAL_FOLD_MS) refusalFold.delete(k);
    }
    const o = intent.order ?? {};
    void softAudit({
      type: "safety.refused",
      actor: actorOf(ctx),
      source: intent.source ?? ctx?.source ?? "system",
      accountId: typeof intent.accountId === "string" ? intent.accountId : null,
      requestId: ctx?.requestId ?? null,
      data: {
        action: intent.action,
        mode: intent.mode,
        orderId: intent.orderId ?? null,
        symbol: o.symbol ?? null,
        side: o.side ?? null,
        orderType: o.orderType ?? null,
        quantity: intent.quantity ?? null,
        value: intent.value ?? null,
        keyId: intent.keyId ?? ctx?.key?.id ?? null,
        reasons: reasons.map((r) => ({ code: r.code, rule: r.rule ?? null, message: r.message })),
        suppressed: prev?.suppressed ?? 0,
      },
    });
  }

  /** Emit and audit when today's loss first reaches the limit. */
  function lossCrossed(id, mode, before, after, limits) {
    const lossBefore = -before.realisedPnl;
    const lossAfter = -after.realisedPnl;
    if (lossAfter > 0 && lossAfter >= limits.dailyMaxLoss && !(lossBefore > 0 && lossBefore >= limits.dailyMaxLoss)) {
      emit("safety.limit", { accountId: id, limit: "dailyMaxLoss", value: lossAfter, threshold: limits.dailyMaxLoss });
      void softAudit({ type: "safety.daily_loss_reached", actor: { kind: "system", id: "safety" }, source: "system", accountId: id, data: { mode, realisedPnl: after.realisedPnl, limit: limits.dailyMaxLoss } });
    }
  }

  const guard = {
    /**
     * Decide whether an order intent may go ahead. Never throws for a refusal; returns every reason.
     * @param {import("../core/context.mjs").RequestContext} ctx
     * @param {import("../core/contracts.mjs").SafetyIntent & { lots?: number, lotSize?: number, resolved?: { lotSize?: number } }} intent
     * @returns {Promise<import("../core/contracts.mjs").Verdict>}
     */
    async check(ctx, intent) {
      /** @type {Array<{ code: string, message: string, rule?: string, retryAfterMs?: number }>} */
      const reasons = [];
      const warnings = [];
      /** Warnings with their own check code (the F&O ban rule); `warnings` keeps the plain strings. */
      const coded = [];
      const block = (code, rule, message, extra = {}) => reasons.push({ code, rule, message, ...extra });
      const i = intent && typeof intent === "object" ? intent : {};
      const mode = i.mode === "live" ? "live" : "paper";
      const action = ACTIONS.includes(i.action) ? i.action : null;
      const accountId = typeof i.accountId === "string" ? i.accountId : "";
      const order = i.order && typeof i.order === "object" ? i.order : null;
      const t = now();

      if (i.mode !== "paper" && i.mode !== "live") block("VALIDATION_FAILED", "mode", 'mode must be "paper" or "live".');
      if (!action) block("VALIDATION_FAILED", "action", "action must be place, modify or cancel.");

      // Account
      const account = accountId ? accountById(accountId) : null;
      if (!account) block("ACCOUNT_NOT_FOUND", "account", accountId ? `There is no account "${accountId}" in bridge.config.json.` : "The order does not name an account.");
      if (accountId) {
        try {
          ctx.requireAccountAccess(accountId);
        } catch {
          block("ACCOUNT_FORBIDDEN", "account", `This key may not use account ${accountId}.`);
        }
      }
      if (account && account.enabled === false && action !== "cancel") block("INVALID_ORDER", "accountEnabled", `Account ${accountId} is switched off in bridge.config.json (enabled: false).`);

      // Kill switch
      const ks = killSwitch.state();
      if (ks.engaged && action !== "cancel") {
        block("KILL_SWITCH_ACTIVE", "killSwitch", `The kill switch is on${ks.reason ? ` (${ks.reason})` : ""}. No orders are being sent; cancels still work.`);
      }

      // Live enablement
      if (mode === "live") {
        if (account && action !== "cancel") {
          if (account.broker === "paper") block("PAPER_ONLY", "liveEnabled", `Account ${accountId} is a paper account; it cannot place live orders.`);
          else if (!config.safety.liveTrading) block("PAPER_ONLY", "liveTrading", "Live trading is off for the Bridge (safety.liveTrading in bridge.config.json). The order was not sent.");
          else if (!liveAllowedByConfig(config, account)) block("PAPER_ONLY", "liveEnabled", `Live trading is not enabled for account ${accountId} (accounts[].live.enabled in bridge.config.json).`);
          const allowed = account.live?.allowedSources ?? ["rest"];
          const sources = [...new Set([i.source, ctx?.source].filter((s) => typeof s === "string" && s))];
          for (const s of sources) {
            if (!allowed.includes(s)) block("PAPER_ONLY", "allowedSources", `Live orders from ${s} are not allowed for account ${accountId}. Allowed sources: ${allowed.join(", ") || "none"}.`);
          }
          // Compared after normalising (IPv6 spellings), against the backup IP too. The text carries no address: it
          // reaches order records, MCP results and notifications, where the IP must never appear.
          const reg = account.live?.registeredIp;
          const bak = account.live?.backupIp;
          if ((reg || bak) && egressIp && !sameIp(egressIp, reg) && !sameIp(egressIp, bak)) {
            warnings.push(`This computer's internet address does not match the static IP registered for ${accountId} (see readiness). The broker may refuse the order.`);
          }
        }
        if (!ctx?.scopes?.has?.("live")) block("SCOPE_REQUIRED", "liveScope", 'Live orders need an API key with the "live" scope.');
      }

      const limits = limitsFor(account ? accountId : null);

      // Order rate (every action counts)
      if (accountId) {
        const peek = rate.peek(rateKey(accountId, mode), limits.orderRatePerSecond, t);
        if (!peek.ok) {
          block("ORDER_RATE_LIMITED", "orderRatePerSecond", `Account ${accountId} is at its order rate cap of ${limits.orderRatePerSecond} per second. Try again in ${peek.retryAfterMs} ms.`, { retryAfterMs: peek.retryAfterMs });
        }
      }

      // Daily count and loss (new orders only; modify and cancel manage what is already open)
      if (accountId && action === "place") {
        const c = counters.get(accountId, mode);
        // Orders that passed this check but are not recorded yet count too, so concurrent requests cannot all pass at
        // the limit minus one.
        const inFlight = reservedCount(accountId, mode, t);
        if (c.orders + inFlight >= limits.dailyMaxOrders) {
          block("DAILY_LIMIT_REACHED", "dailyMaxOrders", `Account ${accountId} has placed ${c.orders} ${mode} orders today${inFlight ? ` (and ${inFlight} more are being sent)` : ""}, the daily limit (${limits.dailyMaxOrders}). New orders resume tomorrow.`);
        }
        const loss = -c.realisedPnl;
        if (loss > 0 && loss >= limits.dailyMaxLoss) {
          block("DAILY_LIMIT_REACHED", "dailyMaxLoss", `Account ${accountId} has a ${mode} loss of ${rupees(loss)} today, at or above the daily limit of ${rupees(limits.dailyMaxLoss)}. New orders resume tomorrow.`);
        }
      }

      // Order shape: value, lots, price band, market orders
      if (action === "place" || action === "modify") {
        const value = typeof i.value === "number" && Number.isFinite(i.value) ? i.value : null;
        if (value !== null) {
          if (value > limits.maxOrderValue) block("INVALID_ORDER", "maxOrderValue", `The order value ${rupees(value)} is above the per-order limit of ${rupees(limits.maxOrderValue)}.`);
        } else {
          if (mode === "live") block("INVALID_ORDER", "maxOrderValue", "The order value could not be worked out (no price or LTP), so the per-order value limit cannot be checked. Send a LIMIT price.");
          else warnings.push("The order value could not be worked out, so the per-order value limit was not checked.");
        }

        const lotSize = finitePos(i.lotSize) ? i.lotSize : finitePos(i.resolved?.lotSize) ? i.resolved.lotSize : null;
        const qty = finitePos(i.quantity) ? i.quantity : finitePos(order?.quantity) ? order.quantity : null;
        const lots = finitePos(i.lots) ? i.lots : finitePos(order?.lots) ? order.lots : qty !== null && lotSize ? qty / lotSize : null;
        if (lots !== null) {
          if (lots > limits.maxLotsPerOrder) block("INVALID_ORDER", "maxLotsPerOrder", `${Number(lots.toFixed(4))} lots is above the per-order limit of ${limits.maxLotsPerOrder} lots.`);
        } else if (DERIVATIVE_EXCHANGES.has(exchangeOf(order?.symbol))) {
          warnings.push("The lot size is not known here, so the per-order lots limit was not checked.");
        }

        const ltp = finitePos(i.ltp) ? i.ltp : null;
        const prices = [
          ["price", order?.price],
          ["trigger price", order?.triggerPrice],
        ].filter(([, p]) => finitePos(p));
        if (ltp !== null) {
          for (const [label, p] of prices) {
            const pct = (Math.abs(p - ltp) / ltp) * 100;
            if (pct > limits.priceBandPct) {
              block("INVALID_ORDER", "priceBandPct", `The ${label} ${p} is ${pct.toFixed(2)}% away from the last traded price ${ltp}; the limit is ${limits.priceBandPct}%.`);
            }
          }
        } else if (prices.length && mode === "live" && action === "modify") {
          // A change moves a resting order: without an LTP the band cannot be checked, so refuse rather than let a
          // fat-fingered price through.
          block("INVALID_ORDER", "priceBandPct", "No last traded price was available, so the price band for this change cannot be checked. Try again in a moment.");
        } else if (prices.length && mode === "live") {
          warnings.push("No last traded price was available, so the price band was not checked.");
        }

        const type = order?.orderType;
        if (type === "MARKET" || type === "SL-M") {
          if (limits.marketOrders === "reject") block("INVALID_ORDER", "marketOrders", `${type} orders are turned off (safety.marketOrders is "reject"). Send a LIMIT or SL order instead.`);
          else warnings.push(`${type} orders are sent with market protection of ${order?.marketProtectionPct ?? limits.marketProtectionPct}% (or converted to a LIMIT where the broker has no native protection).`);
        }
      }

      // Market hours. Paper is only warned, and only when the warning is true: the paper engine fills against any
      // recent price whatever the clock says, and demo mode generates prices round the clock, so a demo paper order
      // fills at once and needs no warning. With a real data source a closed market usually means no fresh price.
      const warnClosed = config.demo !== true;
      const PAPER_CLOSED_NOTE = "a paper order fills only against a recent price, so it may stay open until trading resumes";
      if (action === "place" || action === "modify") {
        const exch = exchangeOf(order?.symbol);
        if (exch && EQUITY_SESSION_EXCHANGES.has(exch)) {
          const instrument = instrumentOf(order?.symbol, i.underlyingKind);
          const sess = sessionAt(new Date(t), exch, instrument);
          let ref = null;
          try {
            ref = reference ? reference.session(exch, t, { instrument }) : null;
          } catch {
            ref = null;
          }
          const exchangeName = exch === "BFO" || exch === "BSE" ? "BSE" : "NSE";
          if (sess.state !== "OPEN" && sess.state !== "SPECIAL") {
            if (mode === "live") block("MARKET_CLOSED", "marketHours", `The ${exch} market is not open for orders now (${sess.label}).`);
            else if (warnClosed) warnings.push(`The ${exch} market is not open now (${sess.label}); ${PAPER_CLOSED_NOTE}.`);
          } else if (ref?.state === "HOLIDAY") {
            // A holiday blocks live orders only when the row is verified (user config, a release-verified row, demo);
            // an unverified row warns, because a wrong holiday that blocks trading is worse than none.
            const label = ref.holiday?.label ?? "an exchange holiday";
            if (ref.holiday?.verified) {
              if (mode === "live") block("MARKET_CLOSED", "marketHours", `${exchangeName} is closed today (${label}).`);
              else if (warnClosed) warnings.push(`${exchangeName} is closed today (${label}); ${PAPER_CLOSED_NOTE}.`);
            } else if (mode === "live") {
              warnings.push(`Today may be an exchange holiday (${label}, unverified); the broker will refuse the order if so.`);
            } else if (warnClosed) {
              warnings.push(`Today may be an exchange holiday (${label}, unverified); ${PAPER_CLOSED_NOTE}.`);
            }
          } else if (ref && ref.state !== "OPEN" && ref.state !== "SPECIAL") {
            // The reference session (configured times) is closed although lib/marketHours says open: the stricter wins.
            if (mode === "live") block("MARKET_CLOSED", "marketHours", `The ${exch} market is not open for orders now (${ref.label}).`);
            else if (warnClosed) warnings.push(`The ${exch} market is not open now (${ref.label}); ${PAPER_CLOSED_NOTE}.`);
          }
        } else if (exch === "MCX" || exch === "CDS") {
          if (!windowOpen(exch, t)) {
            const label = `${exch} is outside its usual trading hours (${SESSION_WINDOWS[exch].label}, Monday to Friday; needs verification, holidays not known)`;
            if (mode === "live") block("MARKET_CLOSED", "marketHours", `${label}. The order was not sent.`);
            else if (warnClosed) warnings.push(`${label}; ${PAPER_CLOSED_NOTE}.`);
          } else if (mode === "live") {
            warnings.push(`${exch} holidays are not checked by the Bridge (needs verification); the broker will refuse an order on a holiday.`);
          }
        }
      }

      // F&O ban period (stock derivatives): orders supply heldQty only when the underlying is in ban.
      if ((action === "place" || action === "modify") && i.ban && i.ban.inBan === true && i.underlyingKind === "stock") {
        const side = order?.side === "SELL" ? "SELL" : "BUY";
        // A modify sends banQuantity: the order's unfilled remainder (the filled part is already in heldQty).
        const qty = finitePos(i.banQuantity) ? i.banQuantity : finitePos(i.quantity) ? i.quantity : finitePos(order?.quantity) ? order.quantity : 0;
        const blockOpening = config?.fno?.ban?.blockOpening !== false;
        const c = fnoBanCheck({ underlying: i.underlying ?? order?.symbol ?? "This stock", side, qty, heldQty: i.heldQty ?? null, ban: i.ban, blockOpening });
        if (c?.severity === "block") block("FNO_BAN", "fnoBan", c.message);
        else if (c) {
          coded.push({ code: c.code === "FNO_BAN_CLOSING" ? "SAFETY_WARNING" : c.code, message: c.message });
          if (c.code === "FNO_BAN") {
            void softAudit({ type: "safety.fno_ban_not_blocked", actor: actorOf(ctx), source: i.source ?? ctx?.source ?? "system", accountId: accountId || null, requestId: ctx?.requestId ?? null, data: { symbol: order?.symbol ?? null, side, quantity: qty, heldQty: i.heldQty ?? null, mode } });
          }
        }
      }

      const verdict = { ok: reasons.length === 0, mode, reasons, warnings, ...(coded.length ? { checks: coded } : {}) };
      if (verdict.ok && action === "place" && i.reserve === true && accountId) {
        const k = `${accountId}|${mode}`;
        reserved.set(k, [...(reserved.get(k) ?? []), t + RESERVE_TTL_MS]);
      }
      if (!verdict.ok) {
        if (accountId && account) counters.record(accountId, mode, { action: "refused" });
        auditRefusal(ctx, { ...i, accountId, mode, action }, reasons);
        for (const r of reasons) {
          if (!LIMIT_CODES.has(r.code)) continue;
          const lim = limits[r.rule];
          emit("safety.limit", { accountId, limit: r.rule, value: r.rule === "dailyMaxOrders" ? counters.get(accountId, mode).orders : r.rule === "dailyMaxLoss" ? -counters.get(accountId, mode).realisedPnl : rate.countLastSecond(accountId, t), threshold: lim });
        }
      }
      return verdict;
    },

    /**
     * Take an order-rate slot. Call right before every place, modify and cancel sent to a broker (or the paper engine).
     * @param {string} accountId
     * @returns {{ ok: boolean, retryAfterMs: number }}
     */
    acquireOrderSlot(accountId, { mode = "live" } = {}) {
      const limits = limitsFor(accountById(accountId) ? accountId : null);
      const r = rate.acquire(rateKey(String(accountId), mode), limits.orderRatePerSecond, now());
      if (!r.ok) {
        emit("safety.limit", { accountId, limit: "orderRatePerSecond", value: r.count, threshold: limits.orderRatePerSecond });
        logger.warn("order rate cap reached", { accountId, retryAfterMs: r.retryAfterMs });
      }
      return { ok: r.ok, retryAfterMs: r.retryAfterMs };
    },

    /**
     * Count an order action for today's limits. realisedPnl is the P&L this event realised (e.g. a closing fill),
     * negative for a loss; it is added to today's total for the mode.
     * @param {string} accountId
     * @param {{ action: "place"|"modify"|"cancel", mode: "paper"|"live", status?: string, realisedPnl?: number }} event
     */
    recordOrderEvent(accountId, event) {
      if (!event || !ACTIONS.includes(event.action) || (event.mode !== "paper" && event.mode !== "live")) {
        throw new BridgeError("VALIDATION_FAILED", "recordOrderEvent needs action place|modify|cancel and mode paper|live.");
      }
      const id = String(accountId);
      if (event.action === "place") {
        // The order is now counted: drop its reservation (the oldest one).
        const k = `${id}|${event.mode}`;
        const list = reserved.get(k);
        if (list?.length) {
          list.shift();
          if (!list.length) reserved.delete(k);
        }
      }
      const { before, after } = counters.record(id, event.mode, { action: event.action, realisedPnl: event.realisedPnl });
      const limits = limitsFor(accountById(id) ? id : null);
      if (before.orders < limits.dailyMaxOrders && after.orders >= limits.dailyMaxOrders) {
        emit("safety.limit", { accountId: id, limit: "dailyMaxOrders", value: after.orders, threshold: limits.dailyMaxOrders });
      }
      lossCrossed(id, event.mode, before, after, limits);
    },

    /**
     * Add P&L realised by a fill (negative = loss) to today's total for the mode. The safety module calls this for
     * paper fills from the paper engine's `order.updated` events.
     * @param {string} accountId
     * @param {"paper"|"live"} mode
     * @param {number} amount
     */
    recordRealisedPnl(accountId, mode, amount) {
      if ((mode !== "paper" && mode !== "live") || typeof amount !== "number" || !Number.isFinite(amount) || amount === 0) return;
      const id = String(accountId);
      const { before, after } = counters.record(id, mode, { action: "fill", realisedPnl: amount });
      lossCrossed(id, mode, before, after, limitsFor(accountById(id) ? id : null));
    },

    /**
     * Set today's P&L for an account to a total read from the broker (live: realised plus open mark-to-market, which
     * is stricter than realised alone). OrderService calls it before each live order.
     * @param {string} accountId
     * @param {"paper"|"live"} mode
     * @param {number} total
     */
    syncDayPnl(accountId, mode, total) {
      if ((mode !== "paper" && mode !== "live") || typeof total !== "number" || !Number.isFinite(total)) return;
      const id = String(accountId);
      const delta = Math.round((total - counters.get(id, mode).realisedPnl) * 100) / 100;
      if (delta === 0) return;
      const { before, after } = counters.record(id, mode, { action: "fill", realisedPnl: delta });
      lossCrossed(id, mode, before, after, limitsFor(accountById(id) ? id : null));
    },

    /** @returns {import("../core/contracts.mjs").KillSwitchState} */
    killSwitchStatus() {
      return killSwitch.state();
    },

    /**
     * Engage the kill switch. Any authenticated caller may. Persists, audits, emits "safety.kill_switch".
     * Engaging again keeps the first reason and time, but still emits (so a second call can ask for cancellation).
     * @param {import("../core/context.mjs").RequestContext} ctx
     * @param {{ reason: string, cancelOpenOrders?: boolean }} input
     */
    async engageKillSwitch(ctx, input) {
      const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
      if (!reason || reason.length > 200) throw new BridgeError("VALIDATION_FAILED", "Give a reason of 1 to 200 characters for engaging the kill switch.", { errors: [{ path: "reason", message: "1-200 characters" }] });
      // Stopping trading is open to any key. Cancelling open orders is not: it can remove protective stop-losses, so
      // it needs the live scope (or admin from this computer, or the local CLI), and it covers only the accounts the
      // caller may use. Orders placed outside the Bridge are left alone unless includeExternal is set by an admin.
      const local = ctx?.principal?.kind === "local";
      const admin = Boolean(ctx?.scopes?.has?.("admin") && ctx?.loopback);
      const mayCancel = local || admin || Boolean(ctx?.scopes?.has?.("live"));
      const wantCancel = input?.cancelOpenOrders === true;
      const cancelOpenOrders = wantCancel && mayCancel;
      const warnings = [];
      if (wantCancel && !mayCancel) warnings.push('The kill switch is on, but open orders were NOT cancelled: that needs a key with the "live" scope (or admin on this computer).');
      const includeExternal = cancelOpenOrders && input?.includeExternal === true && (local || admin);
      if (cancelOpenOrders && input?.includeExternal === true && !includeExternal) warnings.push("Only orders placed through the Bridge are being cancelled: includeExternal needs an admin key on this computer.");
      const keyAccounts = local ? "*" : ctx?.key?.accounts === "*" ? "*" : Array.isArray(ctx?.key?.accounts) ? [...ctx.key.accounts] : Array.isArray(ctx?.hookAccounts) ? [...ctx.hookAccounts] : [];
      const cancelScope = { accounts: keyAccounts, includeExternal, requestedBy: actorLabel(ctx) };
      const { state, persisted, changed } = killSwitch.engage({ reason, by: actorLabel(ctx), at: istIso(now()) });
      logger.warn("kill switch engaged", { by: actorLabel(ctx), cancelOpenOrders, alreadyEngaged: !changed });
      await softAudit({
        type: "kill_switch.engaged",
        actor: actorOf(ctx),
        source: ctx?.source ?? "system",
        requestId: ctx?.requestId ?? null,
        data: { reason, cancelOpenOrders, cancelRequested: wantCancel, cancelScope: cancelOpenOrders ? cancelScope : null, alreadyEngaged: !changed, persisted },
      });
      emit("safety.kill_switch", { ...state, cancelOpenOrders, ...(cancelOpenOrders ? { cancelScope } : {}) });
      return warnings.length ? { ...state, warnings } : state;
    },

    /**
     * Release the kill switch: admin (or the local CLI), from this computer, with confirm "RELEASE", never from an AI
     * assistant or a webhook. The release is audited BEFORE it takes effect; if the audit log cannot be written the
     * switch stays on.
     * @param {import("../core/context.mjs").RequestContext} ctx
     * @param {{ confirm: string }} input
     */
    async releaseKillSwitch(ctx, input) {
      if (input?.confirm !== "RELEASE") {
        throw new BridgeError("VALIDATION_FAILED", 'To release the kill switch, send { "confirm": "RELEASE" }.', { errors: [{ path: "confirm", message: 'must be "RELEASE"' }] });
      }
      if (!ctx?.loopback) throw new BridgeError("LOOPBACK_ONLY", "The kill switch can only be released from this computer.");
      if (RELEASE_FORBIDDEN_SOURCES.has(ctx.source)) throw new BridgeError("SCOPE_REQUIRED", "The kill switch can only be released by a person in the Bridge, not by an AI assistant or a webhook.");
      if (!(ctx.scopes?.has?.("admin") || ctx.principal?.kind === "local")) throw new BridgeError("SCOPE_REQUIRED", 'Releasing the kill switch needs an API key with the "admin" scope.');
      const before = killSwitch.state();
      if (!before.engaged) return before;
      const entry = {
        type: "kill_switch.released",
        actor: actorOf(ctx),
        source: ctx.source ?? "system",
        requestId: ctx.requestId ?? null,
        data: { previousReason: before.reason, engagedBy: before.by, engagedAt: before.at },
      };
      if (audit && !isStub(audit)) {
        try {
          await audit.append(entry);
        } catch (err) {
          logger.error("kill switch release not audited; staying engaged", { code: err?.code });
          throw new BridgeError("INTERNAL", "The release could not be written to the audit log, so the kill switch stays on.", { cause: err });
        }
      } else {
        logger.warn("audit log not available; kill switch release not audited");
      }
      let state;
      try {
        state = killSwitch.release();
      } catch (err) {
        logger.error("kill switch release could not be saved; staying engaged", { code: err?.code });
        throw new BridgeError("INTERNAL", "The release could not be saved, so the kill switch stays on.", { cause: err });
      }
      logger.warn("kill switch released", { by: actorLabel(ctx) });
      emit("safety.kill_switch", { ...state, by: actorLabel(ctx), at: istIso(now()), cancelOpenOrders: false });
      return state;
    },

    /**
     * Effective limits and today's usage for an account.
     * @param {string} accountId
     * @returns {{ limits: object, usage: { ordersToday: number, realisedPnlToday: number, ordersLastSecond: number, byMode: object, day: string } }}
     */
    limits(accountId) {
      if (!accountById(accountId)) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${accountId}" in bridge.config.json.`);
      const lim = limitsFor(accountId);
      return { limits: { ...lim, orderWindow: windowFor(lim.orderRatePerSecond) }, usage: usageFor(accountId) };
    },

    // ── Helpers beyond the contract (routes, CLI, tests) ──

    /**
     * GET /v1/safety body: kill switch, global live switch, and each account the caller may see.
     * @param {(accountId: string) => boolean} [canSee]
     */
    status(canSee = () => true) {
      return {
        killSwitch: killSwitch.state(),
        liveTrading: config.safety.liveTrading,
        accounts: config.accounts
          .filter((a) => canSee(a.id))
          .map((a) => {
            const u = usageFor(a.id);
            return {
              accountId: a.id,
              liveAllowedByConfig: liveAllowedByConfig(config, a),
              ordersToday: u.ordersToday,
              realisedPnlToday: u.realisedPnlToday,
              paperOrdersToday: u.byMode.paper.orders,
              paperRealisedPnlToday: u.byMode.paper.realisedPnl,
              ordersLastSecond: u.ordersLastSecond,
              limits: limitsFor(a.id),
            };
          }),
        day: counters.day(),
      };
    },

    /**
     * Tighten limits for the rest of today (IST). Every value must be at or below the current effective value;
     * marketOrders may only move to "reject". Persisted (survives a restart), audited, dropped at IST midnight.
     * @param {import("../core/context.mjs").RequestContext | null} ctx
     * @param {string | null} accountId  null = every account
     * @param {Partial<Record<string, number>> & { marketOrders?: "reject" }} values
     */
    async tightenLimits(ctx, accountId, values) {
      if (accountId !== null && !accountById(accountId)) throw new BridgeError("ACCOUNT_NOT_FOUND", `There is no account "${accountId}" in bridge.config.json.`);
      if (!values || typeof values !== "object") throw new BridgeError("VALIDATION_FAILED", "Send the limits to tighten as an object.");
      const ids = accountId === null ? config.accounts.map((a) => a.id) : [accountId];
      const current = ids.length ? ids.map((id) => limitsFor(id)) : [limitsFor(null)];
      const accepted = {};
      const errors = [];
      for (const [k, v] of Object.entries(values)) {
        if (k === "marketOrders") {
          if (v === "reject") accepted.marketOrders = "reject";
          else errors.push({ path: k, message: 'marketOrders can only be tightened to "reject" while the Bridge runs' });
          continue;
        }
        if (!NUMERIC_LIMITS.includes(k)) {
          errors.push({ path: k, message: "not a safety limit" });
          continue;
        }
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || ((k === "orderRatePerSecond" || k === "dailyMaxOrders" || k === "maxLotsPerOrder") && v <= 0)) {
          errors.push({ path: k, message: "must be a positive number" });
          continue;
        }
        const loosens = current.some((lim) => v > lim[k]);
        if (loosens) {
          errors.push({ path: k, message: `limits can only be tightened while the Bridge runs (current ${Math.min(...current.map((l) => l[k]))}); edit bridge.config.json and restart to loosen` });
          continue;
        }
        accepted[k] = v;
      }
      if (errors.length) throw new BridgeError("VALIDATION_FAILED", "Some limits were not tightened.", { errors });
      counters.setTightened(accountId, accepted);
      await softAudit({ type: "safety.limits_tightened", actor: actorOf(ctx), source: ctx?.source ?? "system", accountId, requestId: ctx?.requestId ?? null, data: { values: accepted } });
      return accountId === null ? limitsFor(null) : limitsFor(accountId);
    },

    /** Stop listening to the bus (module stop, tests). */
    close() {
      offFills();
    },

    /**
     * Record the egress IP a best-effort detector found. Fed by the readiness monitor (readiness/monitor.mjs) when
     * readiness.egressIp is "lookup" or "manual"; null clears it. Warnings only.
     */
    setDetectedEgressIp(ip) {
      egressIp = typeof ip === "string" && ip ? ip : null;
    },
  };

  return guard;
}
