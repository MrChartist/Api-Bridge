import { describe, expect, it } from "vitest";
import { checkedLine, heroModel, killIsOn, limitsModel, liveConditions, methodParts, relAgo, rowsModel, timelineParts, usageTone } from "./readiness.js";
import { matchRanges } from "./palette.js";

const NOW = Date.parse("2026-11-08T11:30:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const live = (state, reasons = []) => ({ accountId: "main", label: "Main", state, reasons, live: { allowedByConfig: true }, checks: {}, automations: [] });

describe("Safety page: relative time", () => {
  it("says just now, seconds, minutes and hours", () => {
    expect(relAgo(ago(2), NOW)).toBe("just now");
    expect(relAgo(ago(42), NOW)).toBe("42 seconds ago");
    expect(relAgo(ago(5 * 60 + 20), NOW)).toBe("5 min ago");
    expect(relAgo(ago(3 * 3600), NOW)).toBe("3 h ago");
    expect(relAgo(null, NOW)).toBe("never");
  });
  it("builds the checked line from the snapshot", () => {
    const snap = { checkedAt: ago(42), schedule: { nextCheckAt: "2026-11-08T17:05:00+05:30" } };
    expect(checkedLine(snap, NOW)).toBe("Last checked 42 seconds ago · next check at 17:05");
    expect(checkedLine(null, NOW)).toBe("Not checked yet");
  });
});

describe("Safety page: the status hero", () => {
  it("is paused whenever the kill switch is on, whatever the readiness says", () => {
    const m = heroModel({ killSwitch: { engaged: true } }, { overall: "ready", accounts: [live("ready")] });
    expect(m).toMatchObject({ state: "paused", tone: "bad", title: "Trading is paused" });
  });
  it("is blocked when a live account cannot trade, and names the reason", () => {
    const snap = { overall: "cannot_trade", accounts: [live("cannot_trade", [{ code: "IP_MISMATCH", severity: "fail", message: "The IP does not match." }])] };
    const m = heroModel({ killSwitch: { engaged: false }, liveTrading: true }, snap);
    expect(m).toMatchObject({ state: "blocked", title: "Trading is blocked", reasons: ["The IP does not match."] });
  });
  it("is allowed with a caution on warn, and says paper only when live trading is off", () => {
    expect(heroModel({ liveTrading: true }, { overall: "warn", accounts: [live("warn", [{ code: "X", message: "Session ends soon." }])] })).toMatchObject({ state: "allowed", tone: "warn" });
    expect(heroModel({ liveTrading: false }, { overall: "paper_only", accounts: [] }).sub).toMatch(/paper/);
    expect(heroModel({ liveTrading: true }, { overall: "ready", accounts: [live("ready")] })).toMatchObject({ state: "allowed", tone: "ok", title: "Trading is allowed" });
  });
});

describe("Safety page: limits and conditions", () => {
  it("tones a limit by how full it is, in words", () => {
    expect(usageTone(10, 100)).toMatchObject({ pct: 10, tone: "ok", word: "" });
    expect(usageTone(75, 100)).toMatchObject({ tone: "warn", word: "Getting close" });
    expect(usageTone(95, 100)).toMatchObject({ tone: "bad", word: "Almost at the limit" });
    expect(usageTone(100, 100)).toMatchObject({ pct: 100, tone: "bad", word: "Limit reached" });
    expect(usageTone(5, 0)).toMatchObject({ pct: 0, tone: "ok" });
  });
  it("adds paper and live and reads loss as the part of the limit used", () => {
    const m = limitsModel({ ordersToday: 2, paperOrdersToday: 3, realisedPnlToday: -2000, paperRealisedPnlToday: -500, limits: { dailyMaxOrders: 100, dailyMaxLoss: 10000, maxOrderValue: 200000, maxLotsPerOrder: 10, orderRatePerSecond: 5, marketOrders: "protect" } });
    expect(m.orders).toMatchObject({ used: 5, text: "5 of 100", pct: 5 });
    expect(m.loss).toMatchObject({ lost: 2500, pnl: -2500, text: "₹2,500 of ₹10,000", pct: 25 });
    expect(m.facts.find(([k]) => k === "Largest order")[1]).toBe("₹2,00,000");
    expect(m.facts.find(([k]) => k === "Market orders")[1]).toBe("Protect");
  });
  it("a profit is not a loss", () => {
    expect(limitsModel({ realisedPnlToday: 900, limits: { dailyMaxLoss: 1000 } }).loss).toMatchObject({ lost: 0, pct: 0 });
  });
  it("lists the five conditions of a live order", () => {
    const c = liveConditions({ liveTrading: false, accounts: [{ liveAllowedByConfig: false }] });
    expect(c).toHaveLength(5);
    expect(c.map((x) => x.value)).toEqual(["no", "no", "per order", "per order", "per order"]);
    expect(liveConditions({ liveTrading: true, accounts: [{ liveAllowedByConfig: true }] }).slice(0, 2).map((x) => x.value)).toEqual(["yes", "yes"]);
  });
});

describe("Safety page: checklist and timeline", () => {
  it("has six rows in the order Session, Static IP, Order headroom, Daily loss, Kill switch, Automations", () => {
    const [row] = rowsModel({ accounts: [{ accountId: "main", label: "Main", state: "ready", checks: {}, automations: [] }] });
    expect(row.facts.map((f) => f.label)).toEqual(["Session", "Static IP", "Order headroom", "Daily loss", "Kill switch", "Automations"]);
    expect(row.facts.at(-1)).toMatchObject({ status: "n/a", statusText: "Off", text: "None" });
  });
  it("every row carries its state in words, not only a tone", () => {
    const [row] = rowsModel({ accounts: [{ accountId: "main", label: "Main", state: "cannot_trade", checks: { killSwitch: { status: "fail", engaged: true, at: ago(5) } }, automations: [{ mode: "live", state: "cannot_trade", label: "Guard" }] }] });
    for (const f of row.facts) expect(f.statusText, f.label).toBeTruthy();
    expect(row.facts.find((f) => f.key === "kill").statusText).toBe("Failing");
    expect(row.facts.at(-1).status).toBe("fail");
  });
  it("words a timeline line", () => {
    expect(timelineParts({ accountId: "main", from: "ready", to: "cannot_trade", at: ago(30), codes: ["IP_MISMATCH"] }, { main: "Main" }, NOW)).toMatchObject({ title: "Main is now cannot trade", note: "Was ready · IP mismatch", tone: "bad" });
  });
  it("splits the method text into named parts", () => {
    const parts = methodParts("Session: the broker's stated expiry. Egress IP: as seen by the lookup service. Order headroom: the Bridge's own caps.");
    expect(parts.map((p) => p.name)).toEqual(["Session", "Egress IP", "Order headroom"]);
    expect(methodParts("")).toEqual([]);
  });
});

describe("Command palette: highlighted matches", () => {
  it("highlights a substring, or the characters of a fuzzy match", () => {
    expect(matchRanges("rate", "Rate limits")).toEqual([[0, 4]]);
    expect(matchRanges("lim", "Rate limits")).toEqual([[5, 8]]);
    expect(matchRanges("rl", "Rate limits")).toEqual([[0, 1], [5, 6]]);
    expect(matchRanges("xqz", "Rate limits")).toEqual([]);
    expect(matchRanges("", "Rate limits")).toEqual([]);
  });
});

describe("the kill switch in the toolbar", () => {
  it("is on when any account's readiness says so, and off when nothing says it", () => {
    expect(killIsOn({ accounts: [{ checks: { killSwitch: { engaged: false } } }, { checks: { killSwitch: { engaged: true } } }] })).toBe(true);
    expect(killIsOn({ accounts: [{ checks: { killSwitch: { engaged: false } } }] })).toBe(false);
    expect(killIsOn({ accounts: [{ checks: {} }] })).toBe(false);
    expect(killIsOn(null)).toBe(false);
  });
});
