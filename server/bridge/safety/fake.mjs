/**
 * In-memory fakes published by the safety module for every module's tests. Both satisfy their SERVICE_CONTRACTS entry
 * (assertService passes) and touch no files.
 *
 * 1. createFakeAuditLog(): records in memory with the SAME redaction, hashing and record shape as the real log.
 *
 *      const audit = createFakeAuditLog();
 *      await audit.append({ type: "order.placed", actor: { kind: "key", id: "k1" }, source: "rest", data: { orderId } });
 *      audit.records            // AuditRecord[] (oldest first)
 *      audit.ofType("order.*")  // filter helper
 *      audit.failNext(err)      // the next append rejects with err (test the "audit failed" path)
 *
 * 2. createFakeSafetyGuard(): allows everything by default and records every call. Tell it to refuse:
 *
 *      const safety = createFakeSafetyGuard({ bus });
 *      safety.refuse({ code: "DAILY_LIMIT_REACHED", message: "..." });   // every check() refuses with this reason
 *      safety.refuse({ code: "KILL_SWITCH_ACTIVE", message: "..." }, { actions: ["place"] });
 *      safety.allow();                                                     // back to allowing
 *      safety.warn("Static IP differs");                                   // add a warning to every verdict
 *      safety.setSlot({ ok: false, retryAfterMs: 200 });                   // acquireOrderSlot() answer
 *      safety.checks / safety.events / safety.slots                        // what was asked
 *
 *    engageKillSwitch()/releaseKillSwitch() keep state and emit "safety.kill_switch" on the bus like the real guard;
 *    while engaged, check() refuses place/modify with KILL_SWITCH_ACTIVE (cancels pass), as the real guard does.
 */
import { BridgeError } from "../core/errors.mjs";
import { GENESIS_HASH, encodeCursor, decodeCursor, normaliseInput, parseLimit, parseTimeFilter, recordHash, typeMatcher } from "./auditLog.mjs";
import { istIso } from "./time.mjs";

/**
 * @param {{ bus?: any, clock?: { now(): number } }} [opts]
 */
export function createFakeAuditLog({ bus, clock } = {}) {
  const records = [];
  let pendingFailure = null;
  const now = () => (clock ? clock.now() : Date.now());
  return {
    records,
    /** Records whose type matches exactly or by "prefix.*". */
    ofType(pattern) {
      const m = typeMatcher(pattern);
      return records.filter((r) => m(r.type));
    },
    /** Make the next append reject with `err` (default: a generic INTERNAL BridgeError). */
    failNext(err = new BridgeError("INTERNAL", "The audit log could not be written.")) {
      pendingFailure = err;
    },
    async append(input) {
      if (pendingFailure) {
        const e = pendingFailure;
        pendingFailure = null;
        throw e;
      }
      const body = normaliseInput(input);
      const prevHash = records.length ? records[records.length - 1].hash : GENESIS_HASH;
      const rec = { seq: records.length + 1, at: istIso(now()), ...body, prevHash, hash: "" };
      rec.hash = recordHash(prevHash, rec);
      records.push(rec);
      bus?.emit("audit.appended", { seq: rec.seq, type: rec.type, accountId: rec.accountId ?? undefined });
      return structuredClone(rec);
    },
    async query(q = {}) {
      const fromMs = parseTimeFilter(q.from, "from");
      const toMs = parseTimeFilter(q.to, "to");
      const limit = parseLimit(q.limit);
      const before = q.cursor ? decodeCursor(q.cursor) : Infinity;
      const m = typeMatcher(q.type);
      const hits = records
        .filter((r) => r.seq < before && m(r.type) && (!q.accountId || r.accountId === q.accountId))
        .filter((r) => (fromMs === null || Date.parse(r.at) >= fromMs) && (toMs === null || Date.parse(r.at) <= toMs))
        .reverse();
      const items = hits.slice(0, limit).map((r) => structuredClone(r));
      return { items, nextCursor: hits.length > limit ? encodeCursor(items[items.length - 1].seq) : null };
    },
    async verify() {
      let prev = GENESIS_HASH;
      for (let i = 0; i < records.length; i += 1) {
        const r = records[i];
        if (r.seq !== i + 1 || r.prevHash !== prev || recordHash(prev, r) !== r.hash) {
          return { ok: false, checked: i, brokenAt: i + 1, day: null, line: i + 1, reason: "record does not match the chain" };
        }
        prev = r.hash;
      }
      return { ok: true, checked: records.length, brokenAt: null, day: null, line: null, reason: null };
    },
  };
}

/**
 * @param {{ bus?: any, clock?: { now(): number }, limits?: object }} [opts]
 */
export function createFakeSafetyGuard({ bus, clock, limits: limitOverrides = {} } = {}) {
  const now = () => (clock ? clock.now() : Date.now());
  let ks = { engaged: false, reason: null, by: null, at: null };
  /** @type {null | { reason: { code: string, message: string }, actions: string[] | null }} */
  let refusal = null;
  const extraWarnings = [];
  let slot = { ok: true, retryAfterMs: 0 };
  const checks = [];
  const events = [];
  const slots = [];
  const usage = new Map();
  const limits = {
    dailyMaxOrders: 100,
    dailyMaxLoss: 10_000,
    maxOrderValue: 200_000,
    maxLotsPerOrder: 10,
    orderRatePerSecond: 5,
    priceBandPct: 3,
    marketProtectionPct: 2,
    marketOrders: "protect",
    ...limitOverrides,
  };
  const use = (id) => {
    if (!usage.has(id)) usage.set(id, { ordersToday: 0, realisedPnlToday: 0, ordersLastSecond: 0 });
    return usage.get(id);
  };
  const by = (ctx) => `${ctx?.principal?.kind ?? "system"}:${ctx?.principal?.id ?? "system"}`;

  return {
    checks,
    events,
    slots,
    /** Refuse every check() (optionally only for some actions) with this reason. */
    refuse(reason, { actions = null } = {}) {
      refusal = { reason: { code: reason.code, message: reason.message ?? reason.code }, actions };
    },
    allow() {
      refusal = null;
    },
    warn(message) {
      extraWarnings.push(String(message));
    },
    setSlot(answer) {
      slot = { ok: Boolean(answer.ok), retryAfterMs: Number(answer.retryAfterMs ?? 0) };
    },
    async check(ctx, intent) {
      checks.push({ intent: structuredClone(intent ?? {}), keyId: ctx?.key?.id ?? null, source: ctx?.source ?? null });
      const reasons = [];
      if (ks.engaged && intent?.action !== "cancel") reasons.push({ code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on." });
      if (refusal && (!refusal.actions || refusal.actions.includes(intent?.action))) reasons.push({ ...refusal.reason });
      return { ok: reasons.length === 0, mode: intent?.mode === "live" ? "live" : "paper", reasons, warnings: [...extraWarnings] };
    },
    acquireOrderSlot(accountId) {
      slots.push(accountId);
      return { ...slot };
    },
    recordOrderEvent(accountId, event) {
      events.push({ accountId, ...event });
      const u = use(accountId);
      if (event.action === "place" && event.mode === "live") u.ordersToday += 1;
      if (event.mode === "live" && typeof event.realisedPnl === "number") u.realisedPnlToday += event.realisedPnl;
    },
    killSwitchStatus() {
      return { ...ks };
    },
    async engageKillSwitch(ctx, { reason, cancelOpenOrders = false } = {}) {
      if (!ks.engaged) ks = { engaged: true, reason: String(reason ?? ""), by: by(ctx), at: istIso(now()) };
      bus?.emit("safety.kill_switch", { ...ks, cancelOpenOrders: cancelOpenOrders === true });
      return { ...ks };
    },
    async releaseKillSwitch(ctx, { confirm } = {}) {
      if (confirm !== "RELEASE") throw new BridgeError("VALIDATION_FAILED", 'To release the kill switch, send { "confirm": "RELEASE" }.');
      ks = { engaged: false, reason: null, by: null, at: null };
      bus?.emit("safety.kill_switch", { ...ks, by: by(ctx), at: istIso(now()), cancelOpenOrders: false });
      return { ...ks };
    },
    limits(accountId) {
      return { limits: { ...limits }, usage: { ...use(accountId), byMode: null } };
    },
    /** Same shape as the real guard's status() helper (GET /v1/safety). */
    status(canSee = () => true) {
      return {
        killSwitch: { ...ks },
        liveTrading: false,
        accounts: [...usage.keys()].filter(canSee).map((id) => ({ accountId: id, liveAllowedByConfig: false, ...use(id), limits: { ...limits } })),
      };
    },
  };
}
