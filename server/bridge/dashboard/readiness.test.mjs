/** readiness.js view-model (docs/spec/p1-05-readiness.md §6.2, §10.1): badge, account rows, schedule, history, copy. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSource } from "./copyRules.mjs";
import {
  DEMO_ACTIONS,
  REASON_SHORT,
  automationsFact,
  automationsShort,
  badgeModel,
  egressFact,
  egressModel,
  historyLine,
  istHm,
  istWhen,
  killFact,
  homeSafetyLine,
  lossFact,
  ordersFact,
  rowsModel,
  scheduleLine,
  sessionFact,
} from "./readiness.js";

const NOW = Date.parse("2026-10-29T10:12:40+05:30");

/** One account as GET /v1/readiness returns it (spec §3.4), with overrides. */
function account(over = {}) {
  const base = {
    accountId: "zerodha-main",
    broker: "zerodha",
    brokerName: "Zerodha",
    label: "Main",
    simulated: false,
    live: { globalLiveTrading: true, accountLiveEnabled: true, allowedByConfig: true },
    state: "ready",
    since: "2026-10-29T09:00:12+05:30",
    checkedAt: "2026-10-29T10:12:31+05:30",
    stale: false,
    reasons: [],
    checks: {
      session: { status: "pass", state: "connected", expiresAt: "2026-10-30T06:00:00+05:30", expiresInMinutes: 1187, expirySource: "broker-stated", probe: "ok", probedAt: "2026-10-29T10:12:30+05:30", note: null, message: null },
      egress: { status: "pass", mode: "lookup", matches: true, registered: "set", backup: "not-set", family: "ipv4", detectedAt: "2026-10-29T10:12:29+05:30", seenBy: "api.ipify.org", detectedIp: "203.0.113.10", registeredIp: "203.0.113.10", backupIp: null, message: null },
      orderRate: { status: "pass", perSecond: 5, usedLastSecond: 0, headroom: 5, broker: { remaining: 9, limit: 10, resetMs: 640, source: "brokerPolicies (verified: false)" } },
      dailyOrders: { status: "pass", limit: 100, used: 37, left: 63 },
      dailyLoss: { status: "warn", limit: 10000, pnlToday: -8250, left: 1750 },
      killSwitch: { status: "pass", engaged: false, reason: null, at: null },
    },
    automations: [{ id: "hk_abcdefghijkl", kind: "webhook", label: "ChartInk breakout", mode: "live", state: "ready" }],
  };
  return { ...base, ...over, checks: { ...base.checks, ...(over.checks ?? {}) } };
}
const snap = (accounts, over = {}) => ({
  overall: "ready",
  summary: "The live account is ready",
  checkedAt: "2026-10-29T10:12:31+05:30",
  accounts,
  paperOnly: false,
  schedule: { intervalMinutes: 4, window: { from: "08:45", to: "15:45" }, inWindow: true, tradingDay: true, calendarSource: "reference", nextCheckAt: "2026-10-29T10:16:31+05:30", preOpen: { at: "09:00", lastRunDate: "2026-10-29", nextRunAt: "2026-10-30T09:00:17+05:30" } },
  automations: { total: 1, live: 1, cannotTrade: 0 },
  notifications: { targetsListening: ["phone"], warning: null, demoOff: false },
  method: "Session: …",
  ...over,
});

const IP_MISMATCH = { check: "egress", code: "IP_MISMATCH", severity: "fail", message: "This computer's internet address does not match the static IP registered for Main. Live orders will be refused by Zerodha." };

describe("times (IST, pure)", () => {
  it("prints 24 h IST clock times and relative days", () => {
    expect(istHm("2026-10-29T04:42:31Z")).toBe("10:12");
    expect(istHm(null)).toBe("--");
    expect(istWhen("2026-10-30T06:00:00+05:30", NOW)).toBe("06:00 tomorrow");
    expect(istWhen("2026-10-29T15:00:00+05:30", NOW)).toBe("15:00");
    expect(istWhen("2026-11-02T09:00:00+05:30", NOW)).toBe("09:00 on 2 Nov");
  });
});

describe("badgeModel (spec §6.2)", () => {
  it("ready → ok, 'Ready'", () => {
    const m = badgeModel(snap([account()]));
    expect(m).toMatchObject({ cls: "ok", dot: "ok", text: "Ready", short: "Ready", state: "ready" });
    expect(m.aria).toBe("Trading readiness: Ready");
  });
  it("warn → 'Check: <first reason short>'", () => {
    const a = account({ state: "warn", reasons: [{ check: "dailyLoss", code: "DAILY_LOSS_NEAR", severity: "warn", message: "₹1,750 of ₹10,000 daily loss left." }] });
    expect(badgeModel(snap([a], { overall: "warn" }))).toMatchObject({ cls: "warn", dot: "warn", text: "Check: daily loss near", short: "Check" });
  });
  it("cannot_trade → bad, the broker's name; with 2 or more accounts the count", () => {
    const bad = account({ state: "cannot_trade", reasons: [IP_MISMATCH] });
    expect(badgeModel(snap([bad], { overall: "cannot_trade" }))).toMatchObject({ cls: "bad", dot: "bad", text: "Cannot trade: Zerodha", short: "Cannot trade" });
    const two = [bad, account({ accountId: "dhan-main", broker: "dhan", brokerName: "Dhan", state: "cannot_trade", reasons: [IP_MISMATCH] })];
    expect(badgeModel(snap(two, { overall: "cannot_trade" })).text).toBe("Cannot trade: 2 accounts");
    // A paper-only account in the list does not count.
    const paper = account({ accountId: "p", state: "cannot_trade", live: { allowedByConfig: false } });
    expect(badgeModel(snap([bad, paper], { overall: "cannot_trade" })).text).toBe("Cannot trade: Zerodha");
  });
  it("paper_only → neutral 'Paper only'; unknown → 'Checking…', or 'Not checked since 15:44' when stale", () => {
    expect(badgeModel(snap([], { overall: "paper_only", paperOnly: true }))).toMatchObject({ cls: "", dot: "none", text: "Paper only" });
    expect(badgeModel(snap([account({ state: "unknown" })], { overall: "unknown" }))).toMatchObject({ cls: "", text: "Checking…" });
    const stale = account({ state: "unknown", stale: true, checkedAt: "2026-10-28T15:44:02+05:30" });
    expect(badgeModel(snap([stale], { overall: "unknown" }))).toMatchObject({ cls: "", dot: "none", text: "Not checked since 15:44", short: "Not checked" });
    expect(badgeModel(null)).toMatchObject({ cls: "", text: "Checking…" });
  });
  it("demo adds ' (simulated)' to aria and title only, never to the visible text", () => {
    const sim = account({ simulated: true });
    const m = badgeModel(snap([sim]), { demo: true });
    expect(m.text).toBe("Ready");
    expect(m.short).toBe("Ready");
    expect(m.aria).toBe("Trading readiness: Ready (simulated)");
    expect(m.title).toBe(m.aria);
    expect(badgeModel(snap([account()]), { demo: false }).aria).not.toMatch(/simulated/);
  });
  it("a failed read keeps the last state and says when it was checked", () => {
    const m = badgeModel(snap([account()]), { failedAt: NOW });
    expect(m).toMatchObject({ cls: "ok", text: "Ready (last checked 10:12)" });
  });
  it("gives every state the same model at every width (the CSS picks text, short or the icon)", () => {
    for (const st of ["ready", "warn", "cannot_trade", "paper_only", "unknown"]) {
      const m = badgeModel(snap([account({ state: st, reasons: st === "ready" ? [] : [IP_MISMATCH] })], { overall: st }));
      expect(m.text.length, st).toBeGreaterThan(0);
      expect(m.short.length, st).toBeGreaterThan(0);
      expect(m.short.length, st).toBeLessThanOrEqual(m.text.length);
      expect(m.aria.startsWith("Trading readiness: "), st).toBe(true);
      expect(["ok", "warn", "bad", "none"]).toContain(m.dot);
    }
  });
});

describe("rowsModel facts (spec §6.2 strings)", () => {
  it("Session: stated expiry and the read call", () => {
    const [row] = rowsModel(snap([account()]), { now: NOW });
    expect(row.facts.find((f) => f.key === "session").text).toBe("Until 06:00 tomorrow (broker's stated time) · read call OK at 10:12");
    const noExp = account({ checks: { session: { status: "pass", state: "connected", expiresAt: null, probe: "ok", probedAt: "2026-10-29T10:12:30+05:30", note: "NO_STATED_EXPIRY" } } });
    expect(sessionFact(noExp.checks.session, NOW)).toBe("No stated expiry · read call OK at 10:12");
    expect(sessionFact({ status: "fail", state: "expired", message: "The broker session has expired." }, NOW)).toBe("The broker session has expired.");
  });
  it("IP: match, mismatch, lookup off, not registered; addresses only with canSeeIp", () => {
    const e = account().checks.egress;
    expect(egressFact(e).text).toBe("Matches registered IP");
    const mis = { ...e, status: "fail", matches: false, detectedIp: "198.51.100.23" };
    expect(egressFact(mis).text).toBe("Does not match registered IP (as seen by api.ipify.org)");
    expect(egressFact(mis, { canSeeIp: true }).detail).toBe("198.51.100.23 vs 203.0.113.10");
    expect(egressFact(mis, { canSeeIp: false }).detail).toBeNull();
    // Manual mode: the address is the one entered, not one a service saw.
    const manual = { status: "fail", mode: "manual", registered: "set", backup: "not-set", matches: false, seenBy: "as entered", detectedIp: "198.51.100.23", registeredIp: "203.0.113.10" };
    expect(egressFact(manual).text).toBe("Does not match registered IP (as entered)");
    expect(egressFact(manual, { canSeeIp: true }).detail).toBe("198.51.100.23 vs 203.0.113.10");
    expect(egressFact({ ...manual, status: "pass", matches: true }).text).toBe("Matches registered IP (as entered)");
    expect(egressFact({ status: "n/a", mode: "off", registered: "not-set", backup: "not-set" }).text).toBe("Not checked: lookup is off");
    expect(egressFact({ status: "warn", mode: "lookup", registered: "not-set", backup: "not-set", matches: null }).text).toBe("Registered IP not set");
    // rowsModel passes canSeeIp through, and no address leaks into any fact without it.
    const rows = rowsModel(snap([account({ checks: { egress: mis } })]), { canSeeIp: false, now: NOW });
    expect(JSON.stringify(rows)).not.toMatch(/198\.51\.100\.23|203\.0\.113\.10/);
    const seen = rowsModel(snap([account({ checks: { egress: mis } })]), { canSeeIp: true, now: NOW });
    expect(seen[0].facts.find((f) => f.key === "egress").detail).toMatch(/198\.51\.100\.23 vs 203\.0\.113\.10/);
  });
  it("Orders, Loss (₹ grouped through format.js, like the Bridge's own messages), Kill switch, Automations", () => {
    const a = account();
    expect(ordersFact(a.checks.orderRate, a.checks.dailyOrders)).toBe("5/s cap, 0 used · 63 of 100 orders left");
    expect(lossFact(a.checks.dailyLoss)).toBe("₹1,750 of ₹10,000 daily loss left");
    expect(killFact({ engaged: false })).toBe("Off");
    expect(killFact({ engaged: true, at: "2026-10-29T10:02:00+05:30", reason: "manual" })).toBe("On since 10:02 (manual)");
    expect(automationsFact([{ label: "ChartInk breakout", mode: "live", state: "cannot_trade" }])).toBe("1 live automation cannot trade: ChartInk breakout");
    // Labels can hold commas, so the names are joined with "; ".
    expect(automationsFact([{ label: "Sample guard: NIFTY short strangle, max loss ₹5,000", mode: "live", state: "cannot_trade" }, { label: "Sample webhook: breakout alert", mode: "live", state: "cannot_trade" }])).toBe("2 live automations cannot trade: Sample guard: NIFTY short strangle, max loss ₹5,000; Sample webhook: breakout alert");
    expect(automationsFact([{ label: "A", mode: "live", state: "ready" }, { label: "B", mode: "live", state: "ready" }])).toBe("2 live automations, all ready");
    expect(automationsFact([])).toBe("None");
    expect(automationsShort([{ label: "A", mode: "live", state: "cannot_trade" }, { label: "B", mode: "live", state: "cannot_trade" }])).toEqual({ text: "2 live · cannot trade", detail: "A; B" });
  });
  it("one row per account: title, state pill, at most 3 reasons, the six facts and the source labels", () => {
    const many = [IP_MISMATCH, { ...IP_MISMATCH, code: "SESSION_REJECTED", message: "r2" }, { ...IP_MISMATCH, code: "KILL_SWITCH", message: "r3" }, { ...IP_MISMATCH, code: "DAILY_LOSS_REACHED", message: "r4" }];
    const demoChecks = { dailyLoss: { status: "pass", limit: 10000, pnlToday: 0, left: 10000, source: "paper counters (demo)" } };
    const [row] = rowsModel(snap([account({ state: "cannot_trade", reasons: many, simulated: true, checks: demoChecks })]), { now: NOW });
    expect(row).toMatchObject({ id: "zerodha-main", title: "Main", sub: "Zerodha · zerodha-main", simulated: true, state: { key: "cannot_trade", text: "Cannot trade", tone: "bad" } });
    expect(row.reasons).toHaveLength(3);
    expect(row.more).toBe(1);
    expect(row.codes).toEqual(["IP_MISMATCH", "SESSION_REJECTED", "KILL_SWITCH", "DAILY_LOSS_REACHED"]);
    expect(row.facts.map((f) => f.label)).toEqual(["Session", "Static IP", "Orders", "Daily loss", "Kill switch", "Automations"]);
    expect(row.facts.find((f) => f.key === "loss")).toMatchObject({ status: "pass", tone: "ok", source: "paper counters (demo)" });
  });
});

describe("schedule, history, egress settings, demo actions", () => {
  it("schedule line: checked, next and the pre-open run", () => {
    expect(scheduleLine(snap([account()]), NOW)).toBe("Checked 10:12 · next 10:16 · pre-open 09:00 (ran today)");
    const notYet = snap([account()], { schedule: { ...snap([]).schedule, preOpen: { at: "09:00", lastRunDate: "2026-10-28", nextRunAt: "2026-10-30T09:00:17+05:30" } } });
    expect(scheduleLine(notYet, NOW)).toBe("Checked 10:12 · next 10:16 · pre-open 09:00 (next 09:00 tomorrow)");
  });
  it("history line: '10:12 Main: ready → cannot trade (IP mismatch)'", () => {
    expect(historyLine({ at: "2026-10-29T10:12:31+05:30", accountId: "zerodha-main", from: "ready", to: "cannot_trade", codes: ["IP_MISMATCH"] }, { "zerodha-main": "Main" })).toBe("10:12 Main: ready → cannot trade (IP mismatch)");
  });
  it("every server reason code has short words", () => {
    for (const code of ["LIVE_OFF", "SESSION_EXPIRED", "SESSION_MISSING", "SESSION_ERROR", "SESSION_REJECTED", "SESSION_EXPIRES_SOON", "PROBE_FAILED", "NO_STATED_EXPIRY", "IP_MISMATCH", "IP_NOT_REGISTERED", "IP_INVALID_CONFIG", "IP_FAMILY_DIFFERS", "IP_UNCHECKED", "IP_LOOKUP_FAILED", "RATE_CAP_REACHED", "BROKER_ORDER_BACKOFF", "DAILY_ORDERS_LOW", "DAILY_ORDERS_EXHAUSTED", "DAILY_LOSS_NEAR", "DAILY_LOSS_REACHED", "KILL_SWITCH", "STALE", "CLOCK_SKEW"]) expect(REASON_SHORT[code], code).toBeTruthy();
  });
  it("egress settings: the off-mode copy names the privacy cost", () => {
    const m = egressModel(snap([], { egress: { mode: "off" } }));
    expect(m.note).toBe("Lookup is off, so a changed internet address is found only when the broker refuses an order. Turning it on sends a request to a service you choose every 4 minutes during market hours; that service sees your IP address.");
    expect(JSON.parse(m.snippet).readiness.egressIp.mode).toBe("lookup");
  });
  it("demo actions are exactly the server's scenarios", async () => {
    const { DEMO_SCENARIOS } = await import("../demo/demoReadiness.mjs");
    expect(DEMO_ACTIONS.map(([v]) => v).sort()).toEqual([...DEMO_SCENARIOS].sort());
  });
});

describe("copy and wiring", () => {
  const src = readFileSync(new URL("./readiness.js", import.meta.url), "utf8");
  it("is neutral: no banned words (copyRules.mjs) and no advice phrases (spec §9)", () => {
    expect(checkSource(src, { allow: [] })).toEqual([]);
    const strings = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(strings).not.toMatch(/recommend|\bbest\b|safe to|you should|\bbuy\b|\bsell\b/i);
  });
  it("is served and has its toolbar slot", () => {
    expect(readFileSync(new URL("../core/app.mjs", import.meta.url), "utf8")).toMatch(/"readiness\.js":\s*"text\/javascript/);
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    expect(html).toMatch(/<span id="toolbar-ready" class="toolbar-ready" hidden><\/span>\s*<span id="clock"/);
    expect(html.indexOf('id="toolbar-demo"')).toBeLessThan(html.indexOf('id="toolbar-ready"'));
  });
  it("the badge popover and the Safety page share one kill-switch confirmation", () => {
    const views = readFileSync(new URL("./views.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    expect(app).toMatch(/export async function confirmEngageKillSwitch\(/);
    expect(views).toMatch(/confirmEngageKillSwitch\(\)/);
    expect(src).toMatch(/confirmEngageKillSwitch\(\)/);
    expect(views.match(/title: "Stop all orders\?"/g) ?? []).toHaveLength(0);
  });
  it("draws state with words, not colour alone (the dot always sits beside the word or in aria-label)", () => {
    expect(src).toMatch(/setAttribute\("aria-label", m\.aria\)/);
    const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
    for (const k of ["ok", "warn", "bad"]) expect(css).toMatch(new RegExp(`\\.toolbar-ready\\[data-ready="${k}"\\] \\.pdot \\{ background: hsl\\(var\\(--`));
  });
});

describe("homeSafetyLine", () => {
  it("replaces the Home card's 'Orders pass every safety check' line when readiness has something to say", () => {
    expect(homeSafetyLine({ overall: "cannot_trade", summary: "1 of 1 live account cannot trade" })).toBe("1 of 1 live account cannot trade. Paper orders are unaffected.");
    expect(homeSafetyLine({ overall: "warn", summary: "1 of 2 live accounts needs attention" })).toBe("1 of 2 live accounts needs attention. Paper orders are unaffected.");
    expect(homeSafetyLine({ overall: "ready", summary: "The live account is ready" })).toBeNull();
    expect(homeSafetyLine({ overall: "paper_only", summary: "x" })).toBeNull();
    expect(homeSafetyLine(null)).toBeNull();
  });
});
