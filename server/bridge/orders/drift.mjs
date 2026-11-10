/**
 * Order-book drift check. A READ-ONLY, periodic compare of the Bridge's own record of live orders with the broker's
 * order book (docs/guides/orders-drift.md). It finds the cases where the two disagree: an order the Bridge thinks is open
 * that the broker shows as finished or missing, an order at the broker the Bridge did not place, and a different status or
 * quantity. It reports them (GET /v1/orders/drift, a readiness item, the bus topic `orders.drift`, a Telegram line, the
 * Safety page). It NEVER changes a record, places, modifies or cancels anything: acting on a difference is the owner's
 * decision, in the broker app.
 *
 * When it runs
 *   only when live trading is switched on, at least one live account is logged in, and (default) the market is open or
 *   in pre-open; at most once per `orders.drift.intervalMinutes` (default 5) per account; through the rate-limit
 *   scheduler at the lowest priority ("background") and only when the background gate says the account has room.
 *   Paper accounts are never checked. One broker read per account per check: the broker's order book, the same read
 *   the order list already makes.
 *
 * Unknown outcomes (OUTCOME_UNKNOWN): the matching broker order, if there is one, is shown next to the unknown order so the
 * owner can confirm it in the broker app. The Bridge's own reconciliation job (orders/orderService.mjs) is unchanged.
 */
import { isStub } from "../core/contracts.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createBackgroundGate } from "../ratelimit/backgroundGate.mjs";
import { sharedCalendar } from "../reference/sharedCalendar.mjs";
import { ordersConfig } from "./config.mjs";
import { DRIFT_KINDS, compareOrderBook, differenceKey } from "./driftCompare.mjs";
import { istIso } from "./time.mjs";

const MIN = 60_000;
/** A broker read that has not answered in this long is given up on (the next check tries again). */
export const READ_TIMEOUT_MS = 60_000;
/** The most differences one `orders.drift` event carries (the full list is on the route). */
export const EVENT_DIFFERENCES = 10;

const NOTE = "The Bridge only compares and reports. It never changes or cancels an order because of a difference: check the order in your broker app.";

const REASONS = Object.freeze({
  live_trading_off: "Live trading is off, so there are no live orders to compare.",
  no_live_account: "No account is set up for live orders, so there is nothing to compare.",
  not_logged_in: "No live account is logged in, so the broker's order book cannot be read.",
  market_closed: "The market is closed. The check runs again when it opens.",
});

const optional = (deps, name) => {
  try {
    const s = deps[name];
    return s && !isStub(s) ? s : null;
  } catch {
    return null;
  }
};

const countKinds = (differences) => {
  const byKind = Object.fromEntries(DRIFT_KINDS.map((k) => [k, 0]));
  for (const d of differences) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  return byKind;
};

/**
 * @param {any} deps  config, logger, bus, clock, accounts, scheduler, orders (safety is not needed: the check never sends)
 * @param {{ calendar?: { sessionAt(exchange: string, t: number): { state: string } } }} [opts]
 */
export function createOrderDriftService(deps, opts = {}) {
  const { config, bus } = deps;
  const log = deps.logger?.child ? deps.logger.child({ module: "orders-drift" }) : deps.logger;
  const cfg = ordersConfig(config).drift;
  const clock = deps.clock;
  const now = () => clock.now();
  const timers = {
    set: typeof clock.setTimeout === "function" ? (fn, ms) => clock.setTimeout(fn, ms) : (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h;
    },
    clear: typeof clock.clearTimeout === "function" ? (h) => clock.clearTimeout(h) : (h) => clearTimeout(h),
  };
  const calendar = opts.calendar ?? sharedCalendar();
  const intervalMs = cfg.intervalMinutes * MIN;
  const tickMs = Math.min(30_000, Math.max(5_000, Math.floor(intervalMs / 4)));

  /** @type {Map<string, { accountId: string, checkedAt: number, state: "ok"|"drift"|"unavailable", error: { code: string, message: string } | null, differences: object[], counts: object | null, signature: string }>} */
  const results = new Map();
  /** accountId -> signature of the differences last announced on the bus */
  const announced = new Map();
  const inflight = new Set();
  let timer = null;
  let closed = false;
  let lastIdle = null;

  const orders = () => optional(deps, "orders");
  const supported = () => {
    const o = orders();
    return Boolean(o && typeof o.driftLegs === "function" && typeof o.readBrokerBook === "function");
  };

  function marketOpen(t) {
    try {
      const st = calendar.sessionAt("NSE", t).state;
      return st === "OPEN" || st === "PRE_OPEN" || st === "SPECIAL";
    } catch {
      return false;
    }
  }

  /**
   * The accounts to check right now, or the reason none is checked.
   * @returns {{ ids: string[], reason: string | null }}
   */
  function eligible(t) {
    if (!cfg.enabled || !supported()) return { ids: [], reason: null };
    if (!config.safety?.liveTrading) return { ids: [], reason: "live_trading_off" };
    let rows = [];
    try {
      rows = deps.accounts.list();
    } catch {
      rows = [];
    }
    const live = rows.filter((a) => a.broker !== "paper" && a.enabled !== false && a.liveAllowedByConfig === true);
    if (!live.length) return { ids: [], reason: "no_live_account" };
    const connected = live.filter((a) => a.session?.state === "connected");
    if (!connected.length) return { ids: [], reason: "not_logged_in" };
    if (cfg.marketHoursOnly && !marketOpen(t)) return { ids: [], reason: "market_closed" };
    return { ids: connected.map((a) => a.id), reason: null };
  }

  const withTimeout = (promise, ms) =>
    new Promise((resolve, reject) => {
      const h = timers.set(() => reject(new BridgeError("UPSTREAM_TIMEOUT", "The broker did not answer the order-book read in time.")), ms);
      promise.then(
        (v) => {
          timers.clear(h);
          resolve(v);
        },
        (e) => {
          timers.clear(h);
          reject(e);
        },
      );
    });

  const trim = (d) => ({ kind: d.kind, orderId: d.orderId, brokerOrderId: d.brokerOrderId, symbol: d.symbol, side: d.side, message: d.message });

  function announce(accountId, res) {
    const prevSig = announced.get(accountId) ?? "";
    if (res.state === "unavailable") return; // nothing is known: neither "drift" nor "all clear"
    const sig = res.signature;
    if (sig === prevSig) return;
    announced.set(accountId, sig);
    if (!sig && !prevSig) return;
    const state = res.differences.length ? "drift" : "ok";
    const payload = {
      accountId,
      state,
      previous: prevSig ? "drift" : "ok",
      count: res.differences.length,
      kinds: Object.fromEntries(Object.entries(countKinds(res.differences)).filter(([, n]) => n > 0)),
      differences: res.differences.slice(0, EVENT_DIFFERENCES).map(trim),
      checkedAt: istIso(res.checkedAt),
    };
    try {
      bus?.emit("orders.drift", payload);
    } catch (err) {
      log?.warn?.("orders.drift could not be emitted", { err: err?.message });
    }
  }

  async function checkAccount(accountId) {
    const o = orders();
    const t = now();
    const prev = results.get(accountId) ?? null;
    let res;
    try {
      // Taking the legs before and after the read means an order placed while the book was being read is never reported
      // as "unknown at the broker" (its id is in the second list) or "missing" (it is not in the first).
      const before = o.driftLegs(accountId);
      const { rows } = await withTimeout(o.readBrokerBook(accountId, { priority: "background" }), READ_TIMEOUT_MS);
      const after = o.driftLegs(accountId);
      const { differences, counts } = compareOrderBook({
        accountId,
        legs: before.map((l) => after.find((a) => a.orderId === l.orderId && a.leg === l.leg) ?? l),
        book: rows,
        knownBrokerIds: after.map((l) => l.brokerOrderId).filter(Boolean),
      });
      res = { accountId, checkedAt: t, state: differences.length ? "drift" : "ok", error: null, differences, counts, signature: differences.map(differenceKey).sort().join("\n") };
    } catch (err) {
      res = { accountId, checkedAt: t, state: "unavailable", error: { code: err?.code ?? "ERROR", message: err?.detail ?? err?.message ?? "The order book could not be read." }, differences: [], counts: null, signature: prev?.signature ?? "" };
      log?.warn?.("order-book drift check could not read the broker's order book", { accountId, code: res.error.code });
    }
    results.set(accountId, res);
    if (res.state === "drift") log?.warn?.("order-book drift", { accountId, differences: res.differences.length });
    announce(accountId, res);
    return res;
  }

  /** One pass: every eligible account that is due and has room in its budget. Never overlaps itself. */
  async function pass() {
    if (closed) return { checked: [], skipped: [] };
    const t = now();
    const { ids, reason } = eligible(t);
    lastIdle = reason;
    const checked = [];
    const skipped = [];
    let gate = null;
    const sched = optional(deps, "scheduler");
    if (sched && typeof sched.headroom === "function") gate = createBackgroundGate({ scheduler: sched });
    for (const id of ids) {
      if (inflight.has(id)) continue;
      const last = results.get(id)?.checkedAt;
      if (last !== undefined && t - last < intervalMs) continue;
      // The gate keeps background reads off a budget that live use needs: yes when every window keeps its floor, or when
      // one call now shares no second with anyone. Otherwise try again on the next tick.
      if (gate) {
        let ok = true;
        try {
          ok = gate.allow(id, "portfolio") || gate.allowFloor(id, "portfolio");
        } catch {
          ok = true; // an account the scheduler does not know: the read itself will say so
        }
        if (!ok) {
          skipped.push(id);
          continue;
        }
      }
      inflight.add(id);
      try {
        await checkAccount(id);
        checked.push(id);
      } finally {
        inflight.delete(id);
      }
    }
    return { checked, skipped };
  }

  function schedule() {
    if (closed || timer) return;
    timer = timers.set(async () => {
      timer = null;
      try {
        await pass();
      } catch (err) {
        log?.warn?.("order-book drift pass failed", { code: err?.code ?? "ERROR" });
      }
      schedule();
    }, tickMs);
  }

  const visible = (canSee, id) => !canSee || canSee(id);

  /**
   * The last result, shaped for the route, the readiness item and the dashboard.
   * @param {{ canSee?: ((accountId: string) => boolean) | null }} [o] limit to the accounts a key may use
   */
  function status({ canSee = null } = {}) {
    const t = now();
    const { ids, reason } = eligible(t);
    const rows = [...results.values()].filter((r) => visible(canSee, r.accountId));
    const differences = rows.flatMap((r) => r.differences);
    const errored = rows.filter((r) => r.state === "unavailable");
    const latest = rows.reduce((mx, r) => Math.max(mx, r.checkedAt), 0) || null;
    const stale = latest === null ? false : t - latest > Math.max(3 * intervalMs, 15 * MIN);
    let state;
    if (!cfg.enabled || !supported()) state = "off";
    else if (!rows.length) state = reason ? "idle" : "waiting";
    else if (differences.length) state = "drift";
    else if (errored.length) state = "unavailable";
    else state = "ok";
    const due = ids.filter((id) => visible(canSee, id)).map((id) => (results.has(id) ? results.get(id).checkedAt + intervalMs : t));
    const nextAt = !cfg.enabled || reason || !due.length ? null : Math.max(t, Math.min(...due));
    const counts = countKinds(differences);
    const unknownOutcomes = differences.filter((d) => d.kind === "outcome_unknown").length;
    const external = differences.filter((d) => d.kind === "unknown_at_broker").length;
    const idleText = reason ? REASONS[reason] : null;
    let summary;
    if (state === "off") summary = cfg.enabled ? "The order-book check is not available in this setup." : "The order-book check is off (orders.drift.enabled is false).";
    else if (state === "idle") summary = idleText ?? "Not checked yet.";
    else if (state === "waiting") summary = `Waiting for the first check (every ${cfg.intervalMinutes} minutes while the market is open).`;
    else if (state === "drift") summary = `${differences.length} difference${differences.length === 1 ? "" : "s"} between the Bridge's orders and the broker's order book${unknownOutcomes ? `, ${unknownOutcomes} with an unknown outcome` : ""}${external ? `, ${external} order${external === 1 ? "" : "s"} placed outside the Bridge` : ""}. Check your broker app.`;
    else if (state === "unavailable") summary = "The broker's order book could not be read, so the Bridge cannot say whether its orders match.";
    else summary = `The Bridge's live orders match the broker's order book.`;
    if (stale && idleText && (state === "ok" || state === "drift")) summary += ` Last checked ${istIso(latest).slice(11, 16)} IST. ${idleText}`;
    return {
      enabled: cfg.enabled,
      state,
      stale,
      summary,
      paused: reason ? { reason, message: REASONS[reason] } : null,
      readOnly: true,
      note: NOTE,
      intervalMinutes: cfg.intervalMinutes,
      marketHoursOnly: cfg.marketHoursOnly,
      checkedAt: latest ? istIso(latest) : null,
      nextCheckAt: nextAt ? istIso(nextAt) : null,
      counts: { differences: differences.length, ...counts },
      accounts: rows.map((r) => ({
        accountId: r.accountId,
        state: r.state,
        checkedAt: istIso(r.checkedAt),
        error: r.error,
        bridgeOpen: r.counts?.bridgeOpen ?? null,
        brokerOpen: r.counts?.brokerOpen ?? null,
        externalClosed: r.counts?.externalClosed ?? null,
        differences: r.differences.length,
      })),
      differences: differences.map((d) => ({ ...d })),
    };
  }

  return {
    status,
    /** Run a pass now. It still honours the interval and the budget gate: a check never runs more often than configured. */
    checkNow: pass,
    /** The accounts that would be checked right now, and why not (tests, doctor). */
    eligibility: () => eligible(now()),
    start() {
      if (!cfg.enabled || closed) return;
      schedule();
    },
    close() {
      closed = true;
      if (timer) timers.clear(timer);
      timer = null;
    },
    get idleReason() {
      return lastIdle;
    },
  };
}
