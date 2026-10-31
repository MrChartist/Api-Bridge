import { describe, expect, it } from "vitest";
import {
  BASE_DEFAULTS,
  ONE_TAP_IDLE_MS,
  armOneTap,
  cancellable,
  capsuleText,
  defaultsSummary,
  isOneTapKey,
  liveCapable,
  lotsFor,
  normalizeDefaults,
  offsetLimit,
  oneTapBody,
  oneTapEligibility,
  oneTapExpired,
  oneTapMinutesLeft,
  oneTapVerdict,
  readDefaults,
  touchOneTap,
} from "./one-tap-core.js";

const paper = { id: "paper", label: "Paper", broker: "paper", enabled: true, capabilities: ["placeOrder"], liveAllowedByConfig: false };
const live = { id: "zer1", label: "Zerodha", broker: "zerodha", enabled: true, capabilities: ["placeOrder"], liveAllowedByConfig: true };
const noLive = { ...live, id: "zer2", liveAllowedByConfig: false };
const T0 = 1_800_000_000_000;
const armed = (a = paper, mode = "paper") => armOneTap({ account: a, mode, ack: true, nowMs: T0 }).state;

describe("order defaults validation", () => {
  it("fills a fresh browser with the base defaults", () => {
    expect(normalizeDefaults(null)).toEqual({ defaults: { ...BASE_DEFAULTS, lots: {} }, problems: [] });
    expect(readDefaults(undefined)).toEqual({ ...BASE_DEFAULTS, lots: {} });
    expect(readDefaults("{not json")).toEqual({ ...BASE_DEFAULTS, lots: {} });
  });
  it("keeps valid fields and replaces only the bad ones", () => {
    const { defaults, problems } = normalizeDefaults({ product: "MARGIN", orderType: "MARKET", validity: "FOK", offsetTicks: 3, anyLots: 2, lots: { NIFTY: 4, BANKNIFTY: 0, "bad key": 2 }, account: "zer1" });
    expect(defaults).toEqual({ product: "MARGIN", orderType: "MARKET", validity: "DAY", offsetTicks: 3, anyLots: 2, lots: { NIFTY: 4 }, account: "zer1" });
    expect(problems.map((p) => p.field)).toEqual(["validity", "lots.BANKNIFTY", "lots.bad key"]);
  });
  it("bounds lots and the offset, and accepts whole numbers typed as text", () => {
    expect(normalizeDefaults({ anyLots: 51 }).problems[0].field).toBe("anyLots");
    expect(normalizeDefaults({ anyLots: 1.5 }).defaults.anyLots).toBe(1);
    expect(normalizeDefaults({ offsetTicks: -21 }).defaults.offsetTicks).toBe(0);
    expect(normalizeDefaults({ offsetTicks: "-5", anyLots: "3" }).defaults).toMatchObject({ offsetTicks: -5, anyLots: 3 });
  });
  it("refuses an account id that is not a plain id", () => {
    expect(normalizeDefaults({ account: "<script>" }).defaults.account).toBe("");
  });
  it("reads lots per underlying, else the any-underlying default", () => {
    const d = normalizeDefaults({ anyLots: 2, lots: { NIFTY: 5 } }).defaults;
    expect(lotsFor(d, "nifty")).toBe(5);
    expect(lotsFor(d, "SENSEX")).toBe(2);
  });
  it("summarises in plain words", () => {
    expect(defaultsSummary(BASE_DEFAULTS)).toBe("Intraday · Limit at the touch · Day");
    expect(defaultsSummary({ ...BASE_DEFAULTS, product: "MARGIN", offsetTicks: -2, validity: "IOC" })).toBe("Normal · Limit −2 ticks from the touch · IOC");
    expect(defaultsSummary({ ...BASE_DEFAULTS, orderType: "MARKET" })).toBe("Intraday · Market · Day");
  });
});

describe("limit offset from the touch", () => {
  const q = { bid: 100, ask: 100.5 };
  it("prices at the touch with no offset", () => {
    expect(offsetLimit({ side: "BUY", ...q, tick: 0.05, offsetTicks: 0 })).toBe(100.5);
    expect(offsetLimit({ side: "SELL", ...q, tick: 0.05, offsetTicks: 0 })).toBe(100);
  });
  it("moves toward a fill for a positive offset and inside the spread for a negative one", () => {
    expect(offsetLimit({ side: "BUY", ...q, tick: 0.05, offsetTicks: 2 })).toBe(100.6);
    expect(offsetLimit({ side: "SELL", ...q, tick: 0.05, offsetTicks: 2 })).toBe(99.9);
    expect(offsetLimit({ side: "BUY", ...q, tick: 0.05, offsetTicks: -3 })).toBe(100.35);
  });
  it("never goes below one tick, and has no price without a touch", () => {
    expect(offsetLimit({ side: "SELL", bid: 0.1, ask: 0.15, tick: 0.05, offsetTicks: 10 })).toBe(0.05);
    expect(offsetLimit({ side: "BUY", bid: 100, ask: null, offsetTicks: 0 })).toBeNull();
    expect(offsetLimit({ side: "SELL", bid: 0, ask: 1, offsetTicks: 0 })).toBeNull();
  });
});

describe("switching 1-Tap on", () => {
  it("arms paper for any account that can place orders", () => {
    const r = armOneTap({ account: paper, nowMs: T0 });
    expect(r.ok).toBe(true);
    expect(r.state).toMatchObject({ on: true, accountId: "paper", mode: "paper", armedAt: T0, lastActive: T0 });
  });
  it("arms live only for a live-capable account with the acknowledgement", () => {
    expect(armOneTap({ account: live, mode: "live", ack: false, nowMs: T0 }).ok).toBe(false);
    expect(armOneTap({ account: noLive, mode: "live", ack: true, nowMs: T0 }).ok).toBe(false);
    expect(armOneTap({ account: paper, mode: "live", ack: true, nowMs: T0 }).ok).toBe(false);
    expect(armOneTap({ account: live, mode: "live", ack: true, nowMs: T0 }).state.mode).toBe("live");
    expect(liveCapable(live)).toBe(true);
    expect(liveCapable(paper)).toBe(false);
  });
  it("refuses an unknown mode, a missing or disabled account", () => {
    expect(armOneTap({ account: paper, mode: "LIVE", nowMs: T0 }).ok).toBe(false);
    expect(armOneTap({ account: null, nowMs: T0 }).ok).toBe(false);
    expect(armOneTap({ account: { ...live, enabled: false }, nowMs: T0 }).ok).toBe(false);
    expect(armOneTap({ account: { ...live, capabilities: [] }, nowMs: T0 }).ok).toBe(false);
  });
});

describe("idle expiry", () => {
  it("expires 30 minutes after the last activity, and activity extends it", () => {
    const s = armed();
    expect(oneTapExpired(s, T0 + ONE_TAP_IDLE_MS - 1)).toBe(false);
    expect(oneTapExpired(s, T0 + ONE_TAP_IDLE_MS)).toBe(true);
    const later = touchOneTap(s, T0 + 20 * 60_000);
    expect(oneTapExpired(later, T0 + ONE_TAP_IDLE_MS + 60_000)).toBe(false);
    expect(oneTapMinutesLeft(later, T0 + 20 * 60_000)).toBe(30);
    expect(oneTapMinutesLeft(s, T0 + ONE_TAP_IDLE_MS)).toBe(0);
  });
  it("never moves activity backwards and ignores an off state", () => {
    const s = touchOneTap(armed(), T0 - 5);
    expect(s.lastActive).toBe(T0);
    expect(touchOneTap(null, T0)).toBeNull();
    expect(oneTapExpired(null, T0)).toBe(false);
    expect(oneTapExpired({ on: true }, T0)).toBe(true);
  });
});

describe("eligibility before every send", () => {
  const base = { nowMs: T0 + 1000, accounts: [paper, live], defaults: BASE_DEFAULTS, side: "BUY", quote: { bid: 10, ask: 10.5 } };
  it("passes an armed, fresh tap with a touch", () => {
    expect(oneTapEligibility({ ...base, state: armed() })).toEqual({ ok: true });
  });
  it("falls back to the ticket when off, expired, an exit, a lot check or no touch", () => {
    expect(oneTapEligibility({ ...base, state: null })).toMatchObject({ ok: false, code: "OFF", ticket: true });
    expect(oneTapEligibility({ ...base, state: armed(), nowMs: T0 + ONE_TAP_IDLE_MS })).toMatchObject({ code: "EXPIRED", ticket: true });
    expect(oneTapEligibility({ ...base, state: armed(), exit: true })).toMatchObject({ code: "EXIT", ticket: true });
    expect(oneTapEligibility({ ...base, state: armed(), lotCheckNeeded: true })).toMatchObject({ code: "LOT_CHECK", ticket: true });
    expect(oneTapEligibility({ ...base, state: armed(), quote: { bid: 10, ask: null } })).toMatchObject({ code: "NO_TOUCH", ticket: true });
  });
  it("a market default needs no touch", () => {
    expect(oneTapEligibility({ ...base, state: armed(), quote: null, defaults: { ...BASE_DEFAULTS, orderType: "MARKET" } }).ok).toBe(true);
  });
  it("stops (no ticket) when the account is gone or no longer allows live", () => {
    expect(oneTapEligibility({ ...base, state: armed(), accounts: [live] })).toMatchObject({ code: "ACCOUNT", ticket: false });
    expect(oneTapEligibility({ ...base, state: armed(live, "live"), accounts: [{ ...live, liveAllowedByConfig: false }] })).toMatchObject({ code: "LIVE_OFF", ticket: false });
    expect(oneTapEligibility({ ...base, state: armed(), orderable: false })).toMatchObject({ code: "CONTRACT" });
  });
});

describe("the order body", () => {
  const d = normalizeDefaults({ product: "MARGIN", lots: { NIFTY: 3 }, offsetTicks: 1, validity: "IOC" }).defaults;
  it("is the ticket's body: account, lots, product, limit at the offset touch, validity", () => {
    expect(oneTapBody({ state: armed(), defaults: d, symbol: "NFO:NIFTY-2026-11-03-26000-CE", side: "BUY", underlying: "NIFTY", quote: { bid: 10, ask: 10.5 }, tick: 0.05 })).toEqual({ account: "paper", symbol: "NFO:NIFTY-2026-11-03-26000-CE", side: "BUY", product: "MARGIN", orderType: "LIMIT", lots: 3, price: 10.55, validity: "IOC" });
  });
  it("asks for live only when armed live, and sends no price for market", () => {
    const b = oneTapBody({ state: armed(live, "live"), defaults: { ...BASE_DEFAULTS, orderType: "MARKET" }, symbol: "S", side: "SELL", underlying: "SENSEX", quote: null });
    expect(b).toEqual({ account: "zer1", symbol: "S", side: "SELL", product: "INTRADAY", orderType: "MARKET", lots: 1, mode: "live" });
    expect(oneTapBody({ state: armed(), defaults: BASE_DEFAULTS, symbol: "S", side: "BUY", underlying: "X", quote: { ask: 5 } }).mode).toBeUndefined();
  });
});

describe("the preview's verdict", () => {
  it("refuses on any block (the kill switch, limits, live opt-ins)", () => {
    const v = oneTapVerdict([{ code: "KILL_SWITCH_ACTIVE", message: "Kill switch is on", severity: "block" }], "paper");
    expect(v).toMatchObject({ ok: false, ticket: false, reason: "Kill switch is on" });
  });
  it("lets paper through with warnings, but stops live on a readiness or safety warning", () => {
    const warn = [{ code: "READINESS", message: "Readiness: warn", severity: "warn" }];
    expect(oneTapVerdict(warn, "paper")).toMatchObject({ ok: true, warns: ["Readiness: warn"] });
    expect(oneTapVerdict(warn, "live")).toMatchObject({ ok: false, ticket: true });
    expect(oneTapVerdict([{ code: "WIDE_SPREAD", message: "w", severity: "warn" }], "live").ok).toBe(true);
    expect(oneTapVerdict(undefined).ok).toBe(true);
  });
});

describe("small helpers", () => {
  it("cancels only working orders", () => {
    expect(cancellable({ orderId: "1", status: "open" })).toBe(true);
    expect(cancellable({ orderId: "1", status: "filled" })).toBe(false);
    expect(cancellable({ status: "open" })).toBe(false);
  });
  it("matches Ctrl+Alt+1 only", () => {
    expect(isOneTapKey({ ctrlKey: true, altKey: true, code: "Digit1", key: "1" })).toBe(true);
    expect(isOneTapKey({ ctrlKey: true, altKey: false, code: "Digit1", key: "1" })).toBe(false);
    expect(isOneTapKey({ ctrlKey: true, altKey: true, shiftKey: true, code: "Digit1", key: "!" })).toBe(false);
    expect(isOneTapKey({ ctrlKey: true, altKey: true, metaKey: true, code: "Digit1" })).toBe(false);
  });
  it("words the capsule", () => {
    expect(capsuleText(null)).toEqual({ main: "1-Tap", sub: "" });
    expect(capsuleText(armed())).toEqual({ main: "1-Tap ON · Paper", sub: "Paper" });
    expect(capsuleText(armed(live, "live"))).toEqual({ main: "1-Tap ON · LIVE", sub: "Zerodha" });
  });
});
