/**
 * Readiness checks — stream S20 (docs/spec/p1-05-readiness.md §7). Pure functions: no I/O, no clock, no logger; every
 * input is passed in, so each formula has a reference-value test (checks.test.mjs).
 *
 * Each check returns { check, reasons }: `check` is the API fact object (`status` ∈ pass | warn | fail | unknown | n/a
 * plus the facts it was decided from) and `reasons` the plain-English lines it contributes ({ check, code, severity,
 * message }, severity warn | fail). combine() turns the checks into one account state (§7.1).
 *
 * Which adapters' testConnection is a light call (T4, §8): Dhan GET /v2/fundlimit (funds), Zerodha GET /user/profile,
 * Upstox GET /v2/user/profile, Angel One getProfile, Fyers /profile, the demo adapter answers locally. None downloads a
 * master, so the probe uses testConnection through scheduler.schedule({ endpointClass: "portfolio", priority:
 * "background" }) for every wired broker.
 */
import { normaliseIp } from "./ip.mjs";

export const IST_OFFSET_MS = 19_800_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

// ───────────────────────────── time helpers (IST) ─────────────────────────────

/** "YYYY-MM-DD" of the IST calendar day containing `ms`. */
export const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
/** Minutes past IST midnight. */
export const istMinuteOfDay = (ms) => Math.floor((((ms + IST_OFFSET_MS) % DAY) + DAY) % DAY / MINUTE);
/** "HH:MM" IST. */
export const istClock = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
/** ISO time with the +05:30 offset, to the second ("2026-10-29T10:12:31+05:30"). */
export const istIso = (ms) => (Number.isFinite(ms) ? `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30` : null);
/** The instant of "HH:MM" IST on an IST date. */
export const istInstant = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
export const hhmmMinutes = (s) => Number(String(s).slice(0, 2)) * 60 + Number(String(s).slice(3, 5));
/** 0 = Sunday … 6 = Saturday, for an IST date. */
export const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Weekday rule used until the reference calendar (P1-2) is present: Monday to Friday. */
export const isWeekday = (date) => {
  const d = weekdayOf(date);
  return d >= 1 && d <= 5;
};

/** Inside the IST check window, both ends included, at minute resolution (08:45:00–15:45:59 for the default). */
export function inWindow(now, window) {
  const m = istMinuteOfDay(now);
  return m >= hhmmMinutes(window.from) && m <= hhmmMinutes(window.to);
}

/** A stable 0..30 s jitter from a string (the data folder), so many Bridges do not probe at the same second. */
export function jitterSecondsFor(seed) {
  let h = 5381;
  for (const ch of String(seed ?? "")) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h % 31;
}

// ───────────────────────────── formatting (plain text, no locale APIs) ─────────────────────────────

/** "₹1,750" / "₹10,000" / "₹1,25,000" (Indian grouping, whole rupees). */
export function rupees(n) {
  const v = Math.round(Math.abs(Number(n) || 0));
  const s = String(v);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${n < 0 ? "−" : ""}₹${grouped}`;
}

const reason = (check, code, severity, message) => ({ check, code, severity, message });

// ───────────────────────────── §7.2 session ─────────────────────────────

/**
 * @param {{ session: { state: string, expiresAt: string | null, message?: string | null }, probe: { result: "ok"|"rejected"|"error", at: number, message?: string } | null,
 *   probeRequired?: boolean, now: number, warnMinutes: number, closeMs: number, expirySource?: string, who?: { label?: string } }} input
 *   closeMs: today's session close (reference, else 15:30 IST). probeRequired false when probing is turned off.
 */
export function sessionCheck({ session, probe, probeRequired = true, now, warnMinutes, closeMs, expirySource = "broker-stated" }) {
  const exp = session?.expiresAt ? Date.parse(session.expiresAt) : null;
  const check = {
    status: "pass",
    state: session?.state ?? "unknown",
    expiresAt: session?.expiresAt ?? null,
    expiresInMinutes: Number.isFinite(exp) ? Math.floor((exp - now) / MINUTE) : null,
    expirySource: Number.isFinite(exp) ? expirySource : null,
    probe: probe?.result ?? (probeRequired ? "none" : "off"),
    probedAt: probe ? istIso(probe.at) : null,
    note: null,
    message: null,
  };
  const reasons = [];
  const st = check.state;
  // A probe the broker refused is the most specific evidence (AccountManager then also marks the session expired).
  if (probe?.result === "rejected" && (st === "connected" || st === "expired")) reasons.push(reason("session", "SESSION_REJECTED", "fail", "The broker refused the session on a read call."));
  else if (st === "expired") reasons.push(reason("session", "SESSION_EXPIRED", "fail", "The broker session has expired."));
  else if (st === "missing") reasons.push(reason("session", "SESSION_MISSING", "fail", "There is no broker session for this account (not logged in, or the account is disabled)."));
  else if (st === "error") reasons.push(reason("session", "SESSION_ERROR", "fail", "The broker connection reported an error. Test or reconnect the account."));
  if (reasons.length) {
    check.status = "fail";
    check.message = reasons[0].message;
    return { check, reasons };
  }
  if (st !== "connected" || (probeRequired && !probe)) {
    check.status = "unknown";
    check.message = st === "checking" ? "Still checking" : "Not checked yet";
    return { check, reasons };
  }
  if (probe?.result === "error") {
    reasons.push(reason("session", "PROBE_FAILED", "warn", "A read call to the broker failed (timeout or broker error); the session may still be valid."));
  }
  if (Number.isFinite(exp)) {
    const left = exp - now;
    if (left <= warnMinutes * MINUTE && exp <= closeMs + 15 * MINUTE) {
      reasons.push(reason("session", "SESSION_EXPIRES_SOON", "warn", `Session ends at ${istClock(exp)} (in ${Math.max(0, Math.floor(left / MINUTE))} min), before the market closes.`));
    }
  } else {
    check.note = "NO_STATED_EXPIRY";
  }
  check.status = reasons.length ? "warn" : "pass";
  check.message = reasons[0]?.message ?? null;
  return { check, reasons };
}

// ───────────────────────────── §7.3 egress ─────────────────────────────

/**
 * @param {{ mode: "off"|"lookup"|"manual", registeredIp?: string | null, backupIp?: string | null, manualIp?: string | null,
 *   detected: { ip?: string | null, family?: string | null, at?: number | null, seenBy?: string | null, error?: string | null, clockSkewMs?: number | null } | null,
 *   now: number, intervalMinutes: number, maxSkewMs?: number, who?: { label?: string, brokerName?: string } }} input
 */
export function egressCheck({ mode, registeredIp, backupIp, manualIp, detected, now, intervalMinutes, maxSkewMs = 5000, who = {} }) {
  const reg = registeredIp ? normaliseIp(registeredIp) : null;
  const bak = backupIp ? normaliseIp(backupIp) : null;
  const regState = registeredIp ? (reg ? "set" : "invalid") : "not-set";
  const bakState = backupIp ? (bak ? "set" : "invalid") : "not-set";
  const check = {
    status: "pass",
    mode,
    matches: null,
    registered: regState,
    backup: bakState,
    family: null,
    detectedAt: null,
    seenBy: null,
    detectedIp: null,
    registeredIp: registeredIp ?? null,
    backupIp: backupIp ?? null,
    clockSkewMs: null,
    message: null,
  };
  const reasons = [];
  const done = (status) => {
    check.status = status;
    check.message = reasons[0]?.message ?? null;
    return { check, reasons };
  };
  const name = who.label ?? "this account";
  if (mode === "off") {
    if (registeredIp || backupIp) {
      reasons.push(reason("egress", "IP_UNCHECKED", "warn", "Not checked: the egress IP lookup is off (readiness.egressIp.mode)."));
      return done("unknown");
    }
    check.message = "Not checked: lookup is off";
    return done("n/a");
  }
  if (!registeredIp && !backupIp) {
    reasons.push(reason("egress", "IP_NOT_REGISTERED", "warn", `Set live.registeredIp for ${name} so the Bridge can check the static IP.`));
    return done("warn");
  }
  if ((registeredIp && !reg) || (backupIp && !bak)) {
    reasons.push(reason("egress", "IP_INVALID_CONFIG", "warn", `live.registeredIp or live.backupIp for ${name} is not a valid IP address.`));
    return done("warn");
  }
  let d = detected;
  if (mode === "manual") {
    const m = normaliseIp(manualIp ?? "");
    if (!m) {
      reasons.push(reason("egress", "IP_INVALID_CONFIG", "warn", "readiness.egressIp.manualIp is not a valid IP address."));
      return done("warn");
    }
    d = { ip: m.ip, family: m.family, at: detected?.at ?? null, seenBy: detected?.seenBy ?? "as entered", error: null, clockSkewMs: null };
  }
  const det = d?.ip ? normaliseIp(d.ip) : null;
  check.detectedAt = d?.at ? istIso(d.at) : null;
  check.seenBy = d?.seenBy ?? null;
  check.detectedIp = det?.ip ?? null;
  check.family = det?.family ?? null;
  const tooOld = mode === "lookup" && (!Number.isFinite(d?.at) || now - d.at > 2 * intervalMinutes * MINUTE);
  if (!det || d?.error || tooOld) {
    reasons.push(reason("egress", "IP_LOOKUP_FAILED", "warn", d?.error ? `The egress IP lookup failed (${d.error}).` : "The egress IP has not been looked up recently."));
    return done("warn");
  }
  if (mode === "lookup" && Number.isFinite(d.clockSkewMs)) {
    check.clockSkewMs = d.clockSkewMs;
    if (Math.abs(d.clockSkewMs) > maxSkewMs) {
      reasons.push(reason("egress", "CLOCK_SKEW", "warn", `This computer's clock is off by about ${Math.round(Math.abs(d.clockSkewMs) / 1000)} s. Times in orders and the 09:00 check may be wrong.`));
    }
  }
  const families = [reg?.family, bak?.family].filter(Boolean);
  if (!families.includes(det.family)) {
    reasons.unshift(reason("egress", "IP_FAMILY_DIFFERS", "warn", `Your lookup service answered over ${det.family === "ipv6" ? "IPv6" : "IPv4"}; the registered IP is ${families[0] === "ipv6" ? "IPv6" : "IPv4"}, so they cannot be compared. Choose an ${families[0] === "ipv6" ? "IPv6" : "IPv4"}-only lookup URL.`));
    return done("warn");
  }
  const matches = (reg && reg.ip === det.ip) || (bak && bak.ip === det.ip);
  check.matches = Boolean(matches);
  if (!matches) {
    reasons.unshift(reason("egress", "IP_MISMATCH", "fail", `This computer's internet address does not match the static IP registered for ${name}. Live orders will be refused by ${who.brokerName ?? "the broker"}.`));
    return done("fail");
  }
  return done(reasons.length ? "warn" : "pass");
}

// ───────────────────────────── §7.4 order headroom ─────────────────────────────

/**
 * @param {{ perSecond: number, usedLastSecond: number, broker?: { remaining: number, limit: number, resetMs: number, source?: string } | null, backoffMs?: number }} input
 */
export function rateCheck({ perSecond, usedLastSecond, broker = null, backoffMs = 0 }) {
  const headroom = Math.max(0, perSecond - usedLastSecond);
  const reasons = [];
  if (headroom === 0) reasons.push(reason("orderRate", "RATE_CAP_REACHED", "warn", `The Bridge's order-rate cap (${perSecond}/s) is in use right now.`));
  if (backoffMs > 0) reasons.push(reason("orderRate", "BROKER_ORDER_BACKOFF", "warn", `The broker asked the Bridge to slow down order calls (for about ${Math.ceil(backoffMs / 1000)} s).`));
  return { check: { status: reasons.length ? "warn" : "pass", perSecond, usedLastSecond, headroom, broker: broker ?? null }, reasons };
}

/** @param {{ limit: number, used: number, leftPct: number }} input */
export function dailyOrdersCheck({ limit, used, leftPct }) {
  const left = Math.max(0, limit - used);
  const reasons = [];
  if (left === 0) reasons.push(reason("dailyOrders", "DAILY_ORDERS_EXHAUSTED", "fail", `Today's order limit is used up (${used} of ${limit}).`));
  else if (left <= Math.ceil((limit * leftPct) / 100)) reasons.push(reason("dailyOrders", "DAILY_ORDERS_LOW", "warn", `${left} of ${limit} orders left today.`));
  return { check: { status: left === 0 ? "fail" : reasons.length ? "warn" : "pass", limit, used, left }, reasons };
}

/** @param {{ limit: number, pnlToday: number, leftPct: number, source?: string | null }} input */
export function dailyLossCheck({ limit, pnlToday, leftPct, source = null }) {
  const left = Math.max(0, limit + Math.min(0, pnlToday));
  const reasons = [];
  if (left === 0) reasons.push(reason("dailyLoss", "DAILY_LOSS_REACHED", "fail", `Today's loss limit (${rupees(limit)}) is reached.`));
  else if (left <= (limit * leftPct) / 100) reasons.push(reason("dailyLoss", "DAILY_LOSS_NEAR", "warn", `${rupees(left)} of ${rupees(limit)} daily loss left.`));
  return { check: { status: left === 0 ? "fail" : reasons.length ? "warn" : "pass", limit, pnlToday, left, ...(source ? { source } : {}) }, reasons };
}

/** @param {{ engaged: boolean, reason?: string | null, at?: string | null }} ks */
export function killSwitchCheck(ks) {
  const engaged = Boolean(ks?.engaged);
  const why = ks?.reason ? String(ks.reason).slice(0, 120) : null;
  return {
    check: { status: engaged ? "fail" : "pass", engaged, reason: engaged ? why : null, at: engaged ? ks?.at ?? null : null },
    reasons: engaged ? [reason("killSwitch", "KILL_SWITCH", "fail", `The kill switch is on${why ? ` (${why})` : ""}.`)] : [],
  };
}

/**
 * @param {{ globalLiveTrading: boolean|string, accountLiveEnabled: boolean|string, allowedByConfig: boolean }} live
 */
export function liveConfigCheck(live) {
  if (live.allowedByConfig) return { reasons: [] };
  const why = live.globalLiveTrading !== true && live.globalLiveTrading !== "simulated" ? "safety.liveTrading is off" : "accounts[].live.enabled is off";
  return { reasons: [reason("live", "LIVE_OFF", "warn", `Live trading is off for this account (${why}); it can place paper orders only.`)] };
}

// ───────────────────────────── §7.1 combine ─────────────────────────────

const SEVERITY = { fail: 3, unknown: 2, warn: 1, pass: 0 };
export const STATE_ORDER = Object.freeze({ cannot_trade: 4, unknown: 3, warn: 2, ready: 1, paper_only: 0 });

/** isStale (§7.9). */
export const isStale = (checkedAtMs, now, staleAfterMinutes) => !Number.isFinite(checkedAtMs) || now - checkedAtMs > staleAfterMinutes * MINUTE;

/**
 * @param {{ allowedByConfig: boolean, checks: Record<string, { status: string }>, reasons: Array<{ check, code, severity, message }>,
 *   checkedAt: number, now: number, staleAfterMinutes: number }} input
 * @returns {{ state: "ready"|"warn"|"cannot_trade"|"paper_only"|"unknown", reasons: object[], stale: boolean }}
 */
export function combine({ allowedByConfig, checks, reasons = [], checkedAt, now, staleAfterMinutes }) {
  const stale = isStale(checkedAt, now, staleAfterMinutes);
  const sorted = [...reasons].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
  const statuses = Object.values(checks).map((c) => c?.status).filter((s) => s && s !== "n/a");
  let state;
  if (!allowedByConfig) state = "paper_only";
  else if (statuses.includes("fail")) state = "cannot_trade";
  else if (checks.session?.status === "unknown" || stale) state = "unknown";
  else if (statuses.some((s) => s === "warn" || s === "unknown")) state = "warn";
  else state = "ready";
  const out = state === "unknown" && stale ? [...sorted, reason("readiness", "STALE", "warn", "Not checked recently.")] : sorted;
  return { state, reasons: out, stale };
}

/** Worst state over accounts that count (allowedByConfig); none → paper_only. */
export function worstState(states) {
  const counted = states.filter((s) => s !== "paper_only");
  if (!counted.length) return "paper_only";
  return counted.reduce((w, s) => (STATE_ORDER[s] > STATE_ORDER[w] ? s : w), counted[0]);
}

/** Severity rank of a check status (fail > unknown > warn > pass). */
export const statusRank = (s) => SEVERITY[s] ?? -1;

// ───────────────────────────── §7.7 notification dedupe ─────────────────────────────

/** state + ":" + sorted failing and warning reason codes. */
export function notifyKey(state, reasons) {
  return `${state}:${[...new Set((reasons ?? []).filter((r) => r.severity === "fail" || r.severity === "warn").map((r) => r.code))].sort().join(",")}`;
}

/**
 * Whether a change (state or reason set) is pushed to the notification targets.
 * @param {{ from: string, to: string, key: string, lastKey: string | null, lastAt: number | null, now: number,
 *   cooldownMinutes: number, onRecovery: boolean }} input
 * @returns {{ notify: boolean, kind: "change"|"recovered" }}
 */
export function shouldNotify({ from, to, key, lastKey, lastAt, now, cooldownMinutes, onRecovery }) {
  if (to === "cannot_trade") {
    const notify = key !== lastKey || !Number.isFinite(lastAt) || now - lastAt >= cooldownMinutes * MINUTE;
    return { notify, kind: "change" };
  }
  if (from === "cannot_trade" && (to === "ready" || to === "warn")) return { notify: Boolean(onRecovery), kind: "recovered" };
  return { notify: false, kind: "change" };
}

// ───────────────────────────── §7.8 schedule ─────────────────────────────

/**
 * First instant t > now at preOpenAt + jitter on a trading day whose date is not lastRunDate.
 * @param {number} now
 * @param {{ preOpenAt: string, jitterSeconds: number, isTradingDay: (date: string) => boolean, lastRunDate?: string | null }} o
 */
export function nextPreOpenAt(now, { preOpenAt, jitterSeconds, isTradingDay, lastRunDate = null }) {
  let d = istDate(now);
  for (let i = 0; i < 30; i += 1, d = addDays(d, 1)) {
    const t = istInstant(d, preOpenAt) + jitterSeconds * 1000;
    if (t > now && d !== lastRunDate && isTradingDay(d)) return t;
  }
  return null;
}

/** Whether the pre-open run is due now: a trading day, not yet run today, past preOpenAt + jitter and still inside the window. */
export function preopenDue(now, { preOpenAt, jitterSeconds, window, isTradingDay, lastRunDate }) {
  const d = istDate(now);
  if (lastRunDate === d || !isTradingDay(d)) return false;
  return now >= istInstant(d, preOpenAt) + jitterSeconds * 1000 && istMinuteOfDay(now) <= hhmmMinutes(window.to);
}

/** Whether a continuous cycle is due: trading day, inside the window (after the jittered start), interval elapsed. */
export function cycleDue(now, { window, intervalMinutes, jitterSeconds, isTradingDay, lastCycleAt }) {
  const d = istDate(now);
  if (!isTradingDay(d) || !inWindow(now, window)) return false;
  if (now < istInstant(d, window.from) + jitterSeconds * 1000) return false;
  return !Number.isFinite(lastCycleAt) || now - lastCycleAt >= intervalMinutes * MINUTE - 2000;
}

/** The next cycle instant (for the API's schedule.nextCheckAt), or null when none is due within two weeks. */
export function nextCycleAt(now, { window, intervalMinutes, jitterSeconds, isTradingDay, lastCycleAt }) {
  const d = istDate(now);
  if (isTradingDay(d) && inWindow(now, window)) {
    const start = istInstant(d, window.from) + jitterSeconds * 1000;
    const t = Number.isFinite(lastCycleAt) ? Math.max(lastCycleAt + intervalMinutes * MINUTE, start) : Math.max(now, start);
    if (istMinuteOfDay(t) <= hhmmMinutes(window.to) && istDate(t) === d) return t;
  }
  let day = d;
  for (let i = 0; i < 15; i += 1) {
    day = addDays(day, 1);
    if (isTradingDay(day)) return istInstant(day, window.from) + jitterSeconds * 1000;
  }
  return null;
}

// ───────────────────────────── §8 probe budget ─────────────────────────────

/**
 * Probe cooldown for a broker so one probe per cooldown stays ≤ 1 % of the class's per-minute limit (or ≤ 2 % of
 * per-second × 60 when only a per-second limit is set). Looks at the class's own limit and every group that lists it.
 * @param {{ limits?: Record<string, any>, groups?: Record<string, any> }} policy
 * @param {string} endpointClass
 * @param {number} base  configured cooldown (≥ 30 s)
 */
export function probeCooldownSeconds(policy, endpointClass, base = 30) {
  const specs = [policy?.limits?.[endpointClass], ...Object.values(policy?.groups ?? {}).filter((g) => Array.isArray(g?.classes) && g.classes.includes(endpointClass))].filter(Boolean);
  let need = base;
  for (const s of specs) {
    if (Number.isFinite(s.perMinute) && s.perMinute > 0) need = Math.max(need, Math.ceil(6000 / s.perMinute));
    else if (Number.isFinite(s.perSecond) && s.perSecond > 0) need = Math.max(need, Math.ceil(100 / (2 * s.perSecond)));
  }
  return need;
}
