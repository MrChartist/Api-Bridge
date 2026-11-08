import { describe, expect, it } from "vitest";
import {
  combine,
  cycleDue,
  dailyLossCheck,
  dailyOrdersCheck,
  egressCheck,
  inWindow,
  isStale,
  istInstant,
  jitterSecondsFor,
  killSwitchCheck,
  liveConfigCheck,
  nextPreOpenAt,
  notifyFailKey,
  notifyKey,
  preopenDue,
  probeCooldownSeconds,
  rateCheck,
  rupees,
  sessionCheck,
  shouldNotify,
  worstState,
} from "./checks.mjs";

const T = (s) => Date.parse(s);
const MIN = 60_000;
const close = (d) => istInstant(d, "15:30");

describe("combine", () => {
  const pass = { status: "pass" };
  const base = { session: pass, egress: pass, orderRate: pass, dailyOrders: pass, dailyLoss: pass, killSwitch: pass };
  const now = T("2026-10-29T10:00:00+05:30");
  const run = (checks, extra = {}) => combine({ allowedByConfig: true, checks: { ...base, ...checks }, reasons: [], checkedAt: now, now, staleAfterMinutes: 10, ...extra }).state;

  it("paper_only when live is not allowed by config (checks still computed)", () => {
    expect(run({ session: { status: "fail" } }, { allowedByConfig: false })).toBe("paper_only");
  });
  it("cannot_trade when any check fails", () => {
    expect(run({ egress: { status: "fail" } })).toBe("cannot_trade");
    expect(run({ killSwitch: { status: "fail" }, session: { status: "unknown" } })).toBe("cannot_trade");
  });
  it("unknown when the session is unknown or the state is stale", () => {
    expect(run({ session: { status: "unknown" } })).toBe("unknown");
    expect(combine({ allowedByConfig: true, checks: base, reasons: [], checkedAt: now - 11 * MIN, now, staleAfterMinutes: 10 }).state).toBe("unknown");
    expect(combine({ allowedByConfig: true, checks: base, reasons: [], checkedAt: now - 11 * MIN, now, staleAfterMinutes: 10 }).reasons.map((r) => r.code)).toEqual(["STALE"]);
  });
  it("warn when a check is warn, or a non-session check is unknown (an optional aid)", () => {
    expect(run({ dailyLoss: { status: "warn" } })).toBe("warn");
    expect(run({ egress: { status: "unknown" } })).toBe("warn");
  });
  it("ready otherwise; n/a is ignored", () => {
    expect(run({})).toBe("ready");
    expect(run({ egress: { status: "n/a" } })).toBe("ready");
  });
  it("fail reasons come first", () => {
    const c = combine({ allowedByConfig: true, checks: base, reasons: [{ code: "W", severity: "warn" }, { code: "F", severity: "fail" }], checkedAt: now, now, staleAfterMinutes: 10 });
    expect(c.reasons.map((r) => r.code)).toEqual(["F", "W"]);
  });
  it("overall is the worst state over accounts that count; none → paper_only", () => {
    expect(worstState(["ready", "warn"])).toBe("warn");
    expect(worstState(["ready", "unknown", "warn"])).toBe("unknown");
    expect(worstState(["unknown", "cannot_trade", "paper_only"])).toBe("cannot_trade");
    expect(worstState(["paper_only"])).toBe("paper_only");
    expect(worstState([])).toBe("paper_only");
  });
});

describe("session", () => {
  const ok = (at) => ({ result: "ok", at });
  it("worked example 1: Upstox until 03:30 tomorrow at 10:00 → pass, 1,050 min left", () => {
    const now = T("2026-10-29T10:00:00+05:30");
    const r = sessionCheck({ session: { state: "connected", expiresAt: "2026-10-30T03:30:00+05:30" }, probe: ok(now), now, warnMinutes: 60, closeMs: close("2026-10-29") });
    expect(r.check).toMatchObject({ status: "pass", expiresInMinutes: 1050, expirySource: "broker-stated", probe: "ok" });
    expect(r.reasons).toEqual([]);
  });
  it("worked example 2: valid until 15:00, now 14:10 → warn SESSION_EXPIRES_SOON", () => {
    const now = T("2026-10-29T14:10:00+05:30");
    const r = sessionCheck({ session: { state: "connected", expiresAt: "2026-10-29T15:00:00+05:30" }, probe: ok(now), now, warnMinutes: 60, closeMs: close("2026-10-29") });
    expect(r.check.status).toBe("warn");
    expect(r.reasons).toEqual([{ check: "session", code: "SESSION_EXPIRES_SOON", severity: "warn", message: "Session ends at 15:00 (in 50 min), before the market closes." }]);
  });
  it("an expiry after close + 15 min is not 'soon' even within the warn window", () => {
    const now = T("2026-10-29T15:10:00+05:30");
    const r = sessionCheck({ session: { state: "connected", expiresAt: "2026-10-29T16:00:00+05:30" }, probe: ok(now), now, warnMinutes: 60, closeMs: close("2026-10-29") });
    expect(r.check.status).toBe("pass");
  });
  it("no stated expiry → pass with the NO_STATED_EXPIRY note (not a reason)", () => {
    const now = T("2026-10-29T10:00:00+05:30");
    const r = sessionCheck({ session: { state: "connected", expiresAt: null }, probe: ok(now), now, warnMinutes: 60, closeMs: close("2026-10-29") });
    expect(r.check).toMatchObject({ status: "pass", note: "NO_STATED_EXPIRY", expirySource: null, expiresInMinutes: null });
    expect(r.reasons).toEqual([]);
  });
  it("expired, missing, error and a refused probe fail; a refused probe is reported as SESSION_REJECTED", () => {
    const now = T("2026-10-29T10:00:00+05:30");
    const code = (session, probe) => sessionCheck({ session, probe, now, warnMinutes: 60, closeMs: close("2026-10-29") }).reasons[0]?.code;
    expect(code({ state: "expired", expiresAt: null }, null)).toBe("SESSION_EXPIRED");
    expect(code({ state: "missing", expiresAt: null }, null)).toBe("SESSION_MISSING");
    expect(code({ state: "error", expiresAt: null }, null)).toBe("SESSION_ERROR");
    expect(code({ state: "connected", expiresAt: null }, { result: "rejected", at: now })).toBe("SESSION_REJECTED");
    expect(code({ state: "expired", expiresAt: null }, { result: "rejected", at: now })).toBe("SESSION_REJECTED");
  });
  it("a probe error is a warn (a broker hiccup is not proof of expiry); no probe yet is unknown", () => {
    const now = T("2026-10-29T10:00:00+05:30");
    const e = sessionCheck({ session: { state: "connected", expiresAt: null }, probe: { result: "error", at: now }, now, warnMinutes: 60, closeMs: close("2026-10-29") });
    expect(e.check.status).toBe("warn");
    expect(e.reasons[0].code).toBe("PROBE_FAILED");
    expect(sessionCheck({ session: { state: "connected", expiresAt: null }, probe: null, now, warnMinutes: 60, closeMs: close("2026-10-29") }).check.status).toBe("unknown");
    expect(sessionCheck({ session: { state: "checking", expiresAt: null }, probe: ok(now), now, warnMinutes: 60, closeMs: close("2026-10-29") }).check.status).toBe("unknown");
    expect(sessionCheck({ session: { state: "connected", expiresAt: null }, probe: null, probeRequired: false, now, warnMinutes: 60, closeMs: close("2026-10-29") }).check.status).toBe("pass");
  });
});

describe("egress", () => {
  const now = T("2026-10-29T10:12:29+05:30");
  const who = { label: "Main", brokerName: "Zerodha" };
  const lookup = (ip, extra = {}) => egressCheck({ mode: "lookup", registeredIp: "203.0.113.10", detected: { ip, at: now, seenBy: "api.ipify.org" }, now, intervalMinutes: 4, who, ...extra });
  it("worked example: 198.51.100.23 vs registered 203.0.113.10 → fail IP_MISMATCH", () => {
    const r = lookup("198.51.100.23");
    expect(r.check).toMatchObject({ status: "fail", matches: false, registered: "set", backup: "not-set", family: "ipv4", seenBy: "api.ipify.org", detectedIp: "198.51.100.23" });
    expect(r.reasons[0]).toEqual({ check: "egress", code: "IP_MISMATCH", severity: "fail", message: "This computer's internet address does not match the static IP registered for Main. Live orders will be refused by Zerodha." });
  });
  it("worked example: an IPv6 answer against an IPv4 registration → warn IP_FAMILY_DIFFERS", () => {
    const r = lookup("2001:db8::5");
    expect(r.check.status).toBe("warn");
    expect(r.reasons[0].code).toBe("IP_FAMILY_DIFFERS");
  });
  it("matches the registered or the backup address", () => {
    expect(lookup("203.0.113.10").check).toMatchObject({ status: "pass", matches: true });
    expect(lookup("198.51.100.23", { backupIp: "198.51.100.23" }).check.status).toBe("pass");
    expect(lookup("::ffff:203.0.113.10").check.status).toBe("pass");
  });
  it("mode off: unknown with IP_UNCHECKED when a registered IP is set, n/a otherwise", () => {
    const off = egressCheck({ mode: "off", registeredIp: "203.0.113.10", detected: null, now, intervalMinutes: 4 });
    expect(off.check.status).toBe("unknown");
    expect(off.reasons.map((r) => r.code)).toEqual(["IP_UNCHECKED"]);
    const none = egressCheck({ mode: "off", detected: null, now, intervalMinutes: 4 });
    expect(none.check.status).toBe("n/a");
    expect(none.reasons).toEqual([]);
  });
  it("not registered, invalid config, failed or old lookups are warns", () => {
    expect(egressCheck({ mode: "lookup", detected: { ip: "1.2.3.4", at: now }, now, intervalMinutes: 4 }).reasons[0].code).toBe("IP_NOT_REGISTERED");
    expect(egressCheck({ mode: "lookup", registeredIp: "203.0.113.010", detected: { ip: "1.2.3.4", at: now }, now, intervalMinutes: 4 }).reasons[0].code).toBe("IP_INVALID_CONFIG");
    expect(egressCheck({ mode: "lookup", registeredIp: "203.0.113.10", detected: { error: "timed out", at: now }, now, intervalMinutes: 4 }).reasons[0].code).toBe("IP_LOOKUP_FAILED");
    expect(egressCheck({ mode: "lookup", registeredIp: "203.0.113.10", detected: { ip: "203.0.113.10", at: now - 9 * MIN }, now, intervalMinutes: 4 }).reasons[0].code).toBe("IP_LOOKUP_FAILED");
    expect(egressCheck({ mode: "lookup", registeredIp: "203.0.113.10", detected: null, now, intervalMinutes: 4 }).reasons[0].code).toBe("IP_LOOKUP_FAILED");
  });
  it("a failed lookup keeps a fresh mismatch (fail + IP_LOOKUP_FAILED); it never claims the address is back", () => {
    const failed = (okAt) => egressCheck({ mode: "lookup", registeredIp: "203.0.113.10", detected: { ip: "198.51.100.23", at: now, okAt, error: "timed out" }, now, intervalMinutes: 4, who });
    const fresh = failed(now - 4 * MIN);
    expect(fresh.check).toMatchObject({ status: "fail", matches: false });
    expect(fresh.reasons.map((r) => `${r.code}:${r.severity}`)).toEqual(["IP_MISMATCH:fail", "IP_LOOKUP_FAILED:warn"]);
    expect(failed(now - 9 * MIN).check.status).toBe("warn");
    // A matching last answer is not reused as a pass.
    const ok = egressCheck({ mode: "lookup", registeredIp: "203.0.113.10", detected: { ip: "203.0.113.10", at: now, okAt: now - MIN, error: "timed out" }, now, intervalMinutes: 4, who });
    expect(ok.check.status).toBe("warn");
    expect(ok.reasons.map((r) => r.code)).toEqual(["IP_LOOKUP_FAILED"]);
  });
  it("manual mode compares the stated address and never fails on age", () => {
    expect(egressCheck({ mode: "manual", registeredIp: "203.0.113.10", manualIp: "203.0.113.10", detected: null, now, intervalMinutes: 4 }).check).toMatchObject({ status: "pass", seenBy: "as entered" });
    expect(egressCheck({ mode: "manual", registeredIp: "203.0.113.10", manualIp: "198.51.100.23", detected: null, now, intervalMinutes: 4 }).check.status).toBe("fail");
  });
  it("clock skew beyond maxSkewMs is a warn on a matching address", () => {
    const r = lookup("203.0.113.10", { detected: { ip: "203.0.113.10", at: now, clockSkewMs: 7200 }, maxSkewMs: 5000 });
    expect(r.check.status).toBe("warn");
    expect(r.reasons[0]).toMatchObject({ code: "CLOCK_SKEW", message: "This computer's clock is off by about 7 s. Times in orders and the 09:00 check may be wrong." });
  });
});

describe("order headroom", () => {
  it("worked example: 5/s, 37 of 100 orders, P&L −₹8,250 of ₹10,000", () => {
    expect(rateCheck({ perSecond: 5, usedLastSecond: 0 }).check).toMatchObject({ status: "pass", headroom: 5 });
    expect(dailyOrdersCheck({ limit: 100, used: 37, leftPct: 10 }).check).toEqual({ status: "pass", limit: 100, used: 37, left: 63 });
    const loss = dailyLossCheck({ limit: 10000, pnlToday: -8250, leftPct: 20 });
    expect(loss.check).toEqual({ status: "warn", limit: 10000, pnlToday: -8250, left: 1750 });
    expect(loss.reasons[0]).toEqual({ check: "dailyLoss", code: "DAILY_LOSS_NEAR", severity: "warn", message: "₹1,750 of ₹10,000 daily loss left." });
  });
  it("0 boundaries", () => {
    expect(rateCheck({ perSecond: 5, usedLastSecond: 5 }).reasons[0].code).toBe("RATE_CAP_REACHED");
    expect(rateCheck({ perSecond: 5, usedLastSecond: 7 }).check.headroom).toBe(0);
    expect(dailyOrdersCheck({ limit: 100, used: 100, leftPct: 10 }).reasons[0]).toMatchObject({ code: "DAILY_ORDERS_EXHAUSTED", severity: "fail" });
    expect(dailyOrdersCheck({ limit: 100, used: 90, leftPct: 10 }).reasons[0].code).toBe("DAILY_ORDERS_LOW");
    expect(dailyOrdersCheck({ limit: 100, used: 89, leftPct: 10 }).reasons).toEqual([]);
    expect(dailyLossCheck({ limit: 10000, pnlToday: -10000, leftPct: 20 }).check).toMatchObject({ status: "fail", left: 0 });
    expect(dailyLossCheck({ limit: 10000, pnlToday: -12000, leftPct: 20 }).reasons[0].code).toBe("DAILY_LOSS_REACHED");
    expect(dailyLossCheck({ limit: 10000, pnlToday: 5000, leftPct: 20 }).check).toMatchObject({ status: "pass", left: 10000 });
    expect(rateCheck({ perSecond: 5, usedLastSecond: 0, backoffMs: 1500 }).reasons[0].code).toBe("BROKER_ORDER_BACKOFF");
  });
  it("kill switch and live config", () => {
    expect(killSwitchCheck({ engaged: true, reason: "manual", at: "x" })).toMatchObject({ check: { status: "fail", engaged: true }, reasons: [{ code: "KILL_SWITCH" }] });
    expect(killSwitchCheck({ engaged: false }).check.status).toBe("pass");
    expect(liveConfigCheck({ globalLiveTrading: false, accountLiveEnabled: true, allowedByConfig: false }).reasons[0].code).toBe("LIVE_OFF");
    expect(liveConfigCheck({ globalLiveTrading: true, accountLiveEnabled: true, allowedByConfig: true }).reasons).toEqual([]);
  });
  it("rupees uses Indian grouping", () => {
    expect(rupees(1750)).toBe("₹1,750");
    expect(rupees(125000)).toBe("₹1,25,000");
    expect(rupees(-500)).toBe("−₹500");
  });
});

describe("notification dedupe (worked example, step by step)", () => {
  const cfg = { cooldownMinutes: 15, onRecovery: true };
  const at = (hhmm) => T(`2026-10-29T${hhmm}:00+05:30`);
  it("10:12 notify → 10:16 no → 10:20 new reason notify → 10:24 recovered notify", () => {
    const fail = (codes) => codes.map((code) => ({ code, severity: "fail" }));
    let last = { key: null, at: null };
    const step = (from, to, reasons, t) => {
      const key = notifyKey(to, reasons);
      const d = shouldNotify({ from, to, key, lastKey: last.key, lastAt: last.at, now: t, ...cfg });
      // The monitor remembers only cannot_trade notifications (so a flapping account is not pushed again within the cooldown).
      if (d.notify && to === "cannot_trade") last = { key, at: t };
      return d;
    };
    expect(step("ready", "cannot_trade", fail(["IP_MISMATCH"]), at("10:12"))).toEqual({ notify: true, kind: "change" });
    expect(step("cannot_trade", "cannot_trade", fail(["IP_MISMATCH"]), at("10:16"))).toEqual({ notify: false, kind: "change" });
    expect(step("cannot_trade", "cannot_trade", fail(["IP_MISMATCH", "SESSION_REJECTED"]), at("10:20"))).toEqual({ notify: true, kind: "change" });
    expect(step("cannot_trade", "ready", [], at("10:24"))).toEqual({ notify: true, kind: "recovered" });
    // Flapping back within the cooldown with the same key is not pushed again.
    expect(step("ready", "cannot_trade", fail(["IP_MISMATCH", "SESSION_REJECTED"]), at("10:26"))).toEqual({ notify: false, kind: "change" });
    expect(step("ready", "cannot_trade", fail(["IP_MISMATCH", "SESSION_REJECTED"]), at("10:40"))).toEqual({ notify: true, kind: "change" });
  });
  it("staying in cannot_trade with the same fail set is never re-sent, even after the cooldown", () => {
    const k = notifyFailKey("cannot_trade", [{ code: "IP_MISMATCH", severity: "fail" }, { code: "IP_LOOKUP_FAILED", severity: "warn" }]);
    expect(k).toBe("cannot_trade:IP_MISMATCH");
    expect(shouldNotify({ from: "cannot_trade", to: "cannot_trade", key: k, lastKey: k, lastAt: at("10:12"), now: at("11:00"), ...cfg })).toEqual({ notify: false, kind: "change" });
    expect(shouldNotify({ from: "cannot_trade", to: "cannot_trade", key: "cannot_trade:IP_MISMATCH,SESSION_REJECTED", lastKey: k, lastAt: at("10:12"), now: at("10:13"), ...cfg }).notify).toBe(true);
  });
  it("warn is never pushed on change; recovery only when onRecovery", () => {
    expect(shouldNotify({ from: "ready", to: "warn", key: "warn:X", lastKey: null, lastAt: null, now: 0, ...cfg }).notify).toBe(false);
    expect(shouldNotify({ from: "cannot_trade", to: "ready", key: "ready:", lastKey: null, lastAt: null, now: 0, cooldownMinutes: 15, onRecovery: false }).notify).toBe(false);
    expect(notifyKey("cannot_trade", [{ code: "B", severity: "fail" }, { code: "A", severity: "warn" }])).toBe("cannot_trade:A,B");
    expect(notifyFailKey("cannot_trade", [{ code: "B", severity: "fail" }, { code: "A", severity: "warn" }])).toBe("cannot_trade:B");
  });
});

describe("schedule", () => {
  const weekdays = (d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  it("Friday 16:00 → Monday 09:00 + jitter", () => {
    const t = nextPreOpenAt(T("2026-10-30T16:00:00+05:30"), { preOpenAt: "09:00", jitterSeconds: 17, isTradingDay: weekdays });
    expect(t).toBe(T("2026-11-02T09:00:17+05:30"));
  });
  it("a holiday on Monday (injected calendar) → Tuesday", () => {
    const cal = (d) => weekdays(d) && d !== "2026-11-02";
    expect(nextPreOpenAt(T("2026-10-30T16:00:00+05:30"), { preOpenAt: "09:00", jitterSeconds: 0, isTradingDay: cal })).toBe(T("2026-11-03T09:00:00+05:30"));
  });
  it("already ran today → tomorrow; before 09:00 → today", () => {
    expect(nextPreOpenAt(T("2026-10-29T08:00:00+05:30"), { preOpenAt: "09:00", jitterSeconds: 0, isTradingDay: weekdays, lastRunDate: "2026-10-29" })).toBe(T("2026-10-30T09:00:00+05:30"));
    expect(nextPreOpenAt(T("2026-10-29T08:00:00+05:30"), { preOpenAt: "09:00", jitterSeconds: 0, isTradingDay: weekdays })).toBe(T("2026-10-29T09:00:00+05:30"));
  });
  it("pre-open due once per day inside the window; cycles only in the window on trading days", () => {
    const o = { preOpenAt: "09:00", jitterSeconds: 10, window: { from: "08:45", to: "15:45" }, isTradingDay: weekdays };
    expect(preopenDue(T("2026-10-29T09:00:05+05:30"), { ...o, lastRunDate: null })).toBe(false);
    expect(preopenDue(T("2026-10-29T09:00:11+05:30"), { ...o, lastRunDate: null })).toBe(true);
    expect(preopenDue(T("2026-10-29T09:00:11+05:30"), { ...o, lastRunDate: "2026-10-29" })).toBe(false);
    expect(preopenDue(T("2026-10-31T09:00:11+05:30"), { ...o, lastRunDate: null })).toBe(false);
    const c = { window: o.window, intervalMinutes: 4, jitterSeconds: 10, isTradingDay: weekdays };
    expect(cycleDue(T("2026-10-29T08:45:05+05:30"), { ...c, lastCycleAt: null })).toBe(false);
    expect(cycleDue(T("2026-10-29T08:45:20+05:30"), { ...c, lastCycleAt: null })).toBe(true);
    expect(cycleDue(T("2026-10-29T08:48:20+05:30"), { ...c, lastCycleAt: T("2026-10-29T08:45:20+05:30") })).toBe(false);
    expect(cycleDue(T("2026-10-29T08:49:20+05:30"), { ...c, lastCycleAt: T("2026-10-29T08:45:20+05:30") })).toBe(true);
    expect(cycleDue(T("2026-10-29T16:00:00+05:30"), { ...c, lastCycleAt: null })).toBe(false);
    expect(cycleDue(T("2026-10-31T10:00:00+05:30"), { ...c, lastCycleAt: null })).toBe(false);
  });
  it("inWindow at 08:44 / 08:45 / 15:45 / 15:46 IST (independent of the host time zone)", () => {
    const w = { from: "08:45", to: "15:45" };
    expect(inWindow(T("2026-10-29T03:14:00Z"), w)).toBe(false); // 08:44 IST
    expect(inWindow(T("2026-10-29T03:15:00Z"), w)).toBe(true); // 08:45 IST
    expect(inWindow(T("2026-10-29T10:15:00Z"), w)).toBe(true); // 15:45 IST
    expect(inWindow(T("2026-10-29T10:16:00Z"), w)).toBe(false); // 15:46 IST
  });
  it("jitter is a stable 0..30 s", () => {
    expect(jitterSecondsFor("/data/a")).toBe(jitterSecondsFor("/data/a"));
    for (const s of ["a", "b", "/home/x/.mc-bridge/data", ""]) expect(jitterSecondsFor(s)).toBeGreaterThanOrEqual(0);
    for (const s of ["a", "b", "/home/x/.mc-bridge/data", ""]) expect(jitterSecondsFor(s)).toBeLessThanOrEqual(30);
  });
});

describe("staleness", () => {
  it("stale after staleAfterMinutes", () => {
    const now = T("2026-10-29T10:00:00+05:30");
    expect(isStale(now - 10 * MIN, now, 10)).toBe(false);
    expect(isStale(now - 10 * MIN - 1, now, 10)).toBe(true);
    expect(isStale(null, now, 10)).toBe(true);
  });
});

describe("probe cooldown per broker policy", () => {
  it("per-minute limits give 1 %; per-second only gives 2 % of per-second × 60; never below the base", () => {
    expect(probeCooldownSeconds({ limits: { portfolio: { perSecond: 10 } } }, "portfolio", 30)).toBe(30);
    expect(probeCooldownSeconds({ limits: { portfolio: { perSecond: 1 } } }, "portfolio", 30)).toBe(50);
    expect(probeCooldownSeconds({ groups: { breeze: { perMinute: 100, classes: ["portfolio"] } } }, "portfolio", 30)).toBe(60);
    expect(probeCooldownSeconds({ limits: {} }, "portfolio", 45)).toBe(45);
  });
});
