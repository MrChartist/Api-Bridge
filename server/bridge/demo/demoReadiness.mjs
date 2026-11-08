/**
 * Demo readiness: a SIMULATED live view of the "demo" account so every readiness
 * state, notification and gate can be seen without a broker. It never changes safety.liveTrading (demo forces live off)
 * and no order can follow from it: the readiness monitor only reads, and the demo adapter has no order methods.
 *
 *   live      { globalLiveTrading: "simulated", accountLiveEnabled: "simulated", allowedByConfig: true }
 *   session   connected; expiresAt = the next 06:00 IST (a Zerodha-like stated expiry, expirySource "simulated");
 *             the probe is the demo adapter's local testConnection
 *   IP        registered 203.0.113.10 (TEST-NET-3), seen 203.0.113.10 "demo (simulated lookup)"
 *   headroom  the demo paper account's real counters (placing paper orders in the demo moves them)
 *   kill switch  real (engaging it in the demo flips the state at once)
 *   samples   two "sample" automations on the demo account; they have no rules and never send anything
 *
 * Scenarios (POST /v1/demo/readiness): session-expired, session-expiring, ip-changed, ip-unchecked, daily-loss-near,
 * daily-orders-exhausted, restore. Any scenario reverts by itself after restoreAfterMinutes (10): a scenario is shared
 * by everyone viewing a public demo, so it must not stick.
 */
import { DEMO_MARKET_ACCOUNT, DEMO_PAPER_ACCOUNT } from "./demoMode.mjs";

export const DEMO_SCENARIOS = Object.freeze(["session-expired", "session-expiring", "ip-changed", "ip-unchecked", "daily-loss-near", "daily-orders-exhausted", "restore"]);
/** Documentation ranges only (RFC 5737): never a real address. */
export const DEMO_REGISTERED_IP = "203.0.113.10";
export const DEMO_CHANGED_IP = "198.51.100.23";
export const DEMO_SEEN_BY = "demo (simulated lookup)";
export const DEMO_SAMPLE_AUTOMATIONS = Object.freeze([
  Object.freeze({ id: "sample-guard-strangle", kind: "sample", accountId: DEMO_MARKET_ACCOUNT, mode: "live", label: "Sample guard: NIFTY short strangle, max loss ₹5,000" }),
  Object.freeze({ id: "sample-webhook-breakout", kind: "sample", accountId: DEMO_MARKET_ACCOUNT, mode: "live", label: "Sample webhook: breakout alert" }),
]);

const IST = 19_800_000;
const DAY = 86_400_000;

/** The next 06:00 IST strictly after `now`. */
export function nextSixAmIst(now) {
  const dayStart = Math.floor((now + IST) / DAY) * DAY - IST;
  const six = dayStart + 6 * 3_600_000;
  return six > now ? six : six + DAY;
}

const iso = (ms) => `${new Date(ms + IST).toISOString().slice(0, 19)}+05:30`;

/**
 * @param {{ clock: { now(): number }, safety?: any, restoreAfterMinutes?: number }} opts
 */
export function createDemoReadiness({ clock, safety, restoreAfterMinutes = 10 }) {
  let scenario = null;
  let until = 0;
  const now = () => clock.now();
  const active = () => {
    if (scenario && now() >= until) scenario = null;
    return scenario;
  };
  return {
    accountIds: [DEMO_MARKET_ACCOUNT],
    restoreAfterMinutes,
    isSimulated: (id) => id === DEMO_MARKET_ACCOUNT,
    scenario: () => active(),
    /** When the current scenario reverts (ms), or null. */
    restoresAt: () => (active() ? until : null),
    /** Apply a scenario (or "restore"). Returns the active scenario name or null. */
    apply(name) {
      if (!DEMO_SCENARIOS.includes(name)) throw new TypeError(`unknown demo scenario ${name}`);
      if (name === "restore") {
        scenario = null;
        until = 0;
      } else {
        scenario = name;
        until = now() + restoreAfterMinutes * 60_000;
      }
      return active();
    },
    live: () => ({ globalLiveTrading: "simulated", accountLiveEnabled: "simulated", allowedByConfig: true }),
    /** The simulated session, built on the demo account's real state (connected by demo mode at boot). */
    session(real) {
      const s = active();
      if (s === "session-expired") return { state: "expired", expiresAt: null, message: "Simulated: the session expired." };
      if (real && real.state !== "connected") return { state: real.state, expiresAt: null, message: real.message ?? null };
      if (s === "session-expiring") return { state: "connected", expiresAt: iso(now() + 25 * 60_000), message: null };
      return { state: "connected", expiresAt: iso(nextSixAmIst(now())), message: null };
    },
    /** A probe result that replaces the real (local) probe, or null to run the demo adapter's testConnection. */
    probeOverride: () => (active() === "session-expired" ? "rejected" : null),
    /** Simulated egress view for the demo account. */
    egress() {
      const s = active();
      return {
        mode: s === "ip-unchecked" ? "off" : "lookup",
        registeredIp: DEMO_REGISTERED_IP,
        backupIp: null,
        detected: { ip: s === "ip-changed" ? DEMO_CHANGED_IP : DEMO_REGISTERED_IP, family: "ipv4", at: now(), seenBy: DEMO_SEEN_BY, error: null, clockSkewMs: null },
      };
    },
    /** Order headroom from the demo paper account's real counters, with the scenario overlays. */
    limits() {
      const l = safety.limits(DEMO_PAPER_ACCOUNT);
      const paper = l.usage?.byMode?.paper ?? { orders: 0, realisedPnl: 0 };
      const s = active();
      return {
        perSecond: l.limits.orderRatePerSecond,
        usedLastSecond: l.usage.paperOrdersLastSecond ?? 0,
        dailyMaxOrders: l.limits.dailyMaxOrders,
        ordersToday: s === "daily-orders-exhausted" ? l.limits.dailyMaxOrders : paper.orders,
        dailyMaxLoss: l.limits.dailyMaxLoss,
        pnlToday: s === "daily-loss-near" ? -0.85 * l.limits.dailyMaxLoss : paper.realisedPnl,
        source: "paper counters (demo)",
      };
    },
  };
}
