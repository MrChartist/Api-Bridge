/**
 * The order-safety rules of the real SafetyGuard, one row per rule with a "just below, at, just above" case, on a fixed clock
 * with no HTTP. These are the rules the product says protect real money; each assertion here was checked by changing the
 * guard (removing the in-flight reservation, `>=` to `>`, deleting the market-hours refusal, ignoring the boot-time switch) and
 * seeing it fail. Also the boot-time kill switch: environment, config, and damaged state files.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.mjs";
import { createCallContext } from "../core/context.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeAuditLog } from "./fake.mjs";
import { createSafetyGuard } from "./safetyGuard.mjs";

// Monday 19 October 2026, 10:00 IST: the regular NSE session.
const MON_OPEN = Date.UTC(2026, 9, 19, 4, 30);
const at = (day, hh, mm = 0) => Date.UTC(2026, 9, day, hh - 5, mm - 30); // IST wall clock on 2026-10-<day>
const SAT_OPEN = at(24, 10);

function rig({ safety = {}, accounts, t = MON_OPEN, reference, env = {}, dir, marketSession } = {}) {
  const raw = {
    dataDir: "/unused",
    safety: { liveTrading: true, ...safety },
    accounts: accounts ?? [
      { id: "live-acc", broker: "dhan", live: { enabled: true } },
      { id: "paper-acc", broker: "dhan" },
    ],
  };
  const { config } = loadConfig({ raw, env: {} });
  const clock = { t, now: () => clock.t };
  const bus = createEventBus({ logger: createNullLogger() });
  const events = [];
  bus.on("safety.limit", (e) => events.push(e));
  const stateDir = dir ?? mkdtempSync(join(tmpdir(), "mcb-guard-check-"));
  const guard = createSafetyGuard(
    { config, logger: createNullLogger(), bus, clock, paths: { dataDir: stateDir }, audit: createFakeAuditLog({ clock }), accounts: notImplementedService("accounts"), ...(reference ? { reference } : {}) },
    { env, dir: stateDir, ...(marketSession ? { marketSession } : {}) },
  );
  return { guard, clock, config, events, dir: stateDir };
}

const ctx = (scopes = ["paper", "live"], accountsAllowed = "*") => {
  const c = createCallContext({ source: "rest", key: { id: "k1", label: "k1", scopes, accounts: accountsAllowed }, log: createNullLogger() });
  c.loopback = true;
  return c;
};

const place = (over = {}) => ({
  accountId: "live-acc",
  mode: "live",
  action: "place",
  order: { symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "LIMIT", price: 100 },
  source: "rest",
  quantity: 1,
  value: 100,
  ltp: 100,
  ...over,
});
const paperPlace = (over = {}) => place({ accountId: "paper-acc", mode: "paper", ...over });
const modify = (over = {}) => place({ action: "modify", orderId: "o1", ...over });
const cancel = (over = {}) => ({ accountId: "live-acc", mode: "live", action: "cancel", orderId: "o1", order: null, source: "rest", ...over });

const rules = (v) => v.reasons.map((r) => r.rule);

describe("a healthy live order passes (the baseline every refusal below departs from)", () => {
  it("passes in session with a price, and refuses without the live scope", async () => {
    const { guard } = rig();
    const v = await guard.check(ctx(), place());
    expect(v).toMatchObject({ ok: true, mode: "live" });
    expect(rules(await guard.check(ctx(["paper"]), place()))).toEqual(["liveScope"]);
  });
});

describe("daily order count", () => {
  it("refuses at the limit, not one before, and counts paper and live apart", async () => {
    const { guard } = rig({ safety: { dailyMaxOrders: 3 } });
    for (let n = 0; n < 3; n += 1) {
      expect((await guard.check(ctx(), place())).ok, `order ${n + 1} of 3`).toBe(true);
      guard.recordOrderEvent("live-acc", { action: "place", mode: "live" });
    }
    const over = await guard.check(ctx(), place());
    expect(over.ok).toBe(false);
    expect(over.reasons[0]).toMatchObject({ code: "DAILY_LIMIT_REACHED", rule: "dailyMaxOrders" });
    expect((await guard.check(ctx(), paperPlace())).ok).toBe(true); // live orders do not use up the paper day
    expect((await guard.check(ctx(), modify())).ok).toBe(true); // only new orders are counted
    expect((await guard.check(ctx(), cancel())).ok).toBe(true);
  });

  it("concurrent requests cannot all pass at the limit minus one: 5 parallel checks at limit 3 pass exactly 3", async () => {
    const { guard } = rig({ safety: { dailyMaxOrders: 3 } });
    const verdicts = await Promise.all(Array.from({ length: 5 }, () => guard.check(ctx(), place({ reserve: true }))));
    expect(verdicts.filter((v) => v.ok)).toHaveLength(3);
    const refused = verdicts.filter((v) => !v.ok);
    expect(refused).toHaveLength(2);
    expect(refused[0].reasons[0]).toMatchObject({ code: "DAILY_LIMIT_REACHED", rule: "dailyMaxOrders" });
    expect(refused[0].reasons[0].message).toMatch(/3 more are being sent/);
  });

  it("a reservation turns into the real count when the order is recorded, and lapses if the order never is", async () => {
    const { guard, clock } = rig({ safety: { dailyMaxOrders: 2 } });
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(true);
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(true);
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(false);
    guard.recordOrderEvent("live-acc", { action: "place", mode: "live" }); // one reservation becomes a count: still 2 used, not 3
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(false);
    clock.t += 31_000; // the second order never arrived; its reservation lapses (30 s), the recorded one stays
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(true);
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(false);
  });

  it("recording a placed order replaces its reservation: it is never counted twice", async () => {
    const { guard } = rig({ safety: { dailyMaxOrders: 3 } });
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(true);
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(true);
    guard.recordOrderEvent("live-acc", { action: "place", mode: "live" }); // 1 recorded + 1 still in flight = 2 of 3 used
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(true); // the third slot
    expect((await guard.check(ctx(), place({ reserve: true }))).ok).toBe(false);
  });

  it("without reserve the check does not hold a slot (a dry check cannot use up the day)", async () => {
    const { guard } = rig({ safety: { dailyMaxOrders: 1 } });
    for (let n = 0; n < 4; n += 1) expect((await guard.check(ctx(), place())).ok).toBe(true);
  });

  it("starts again at the next IST day", async () => {
    const { guard, clock } = rig({ safety: { dailyMaxOrders: 1 } });
    guard.recordOrderEvent("live-acc", { action: "place", mode: "live" });
    expect((await guard.check(ctx(), place())).ok).toBe(false);
    // Not simply +24 h: the next day after this Monday is Dussehra (an NSE holiday in the shipped calendar), which the guard now refuses for its own reason.
    clock.t += 3 * 24 * 3_600_000;
    expect((await guard.check(ctx(), place())).ok).toBe(true);
  });
});

describe("daily loss", () => {
  it("refuses at exactly the limit (at or above), not just below it", async () => {
    const { guard } = rig({ safety: { dailyMaxLoss: 1000 } });
    guard.recordRealisedPnl("live-acc", "live", -999.99);
    expect((await guard.check(ctx(), place())).ok).toBe(true);
    guard.recordRealisedPnl("live-acc", "live", -0.01); // total loss is now exactly 1000
    const v = await guard.check(ctx(), place());
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toMatchObject({ code: "DAILY_LIMIT_REACHED", rule: "dailyMaxLoss" });
    expect(v.reasons[0].message).toMatch(/at or above the daily limit/);
    guard.recordRealisedPnl("live-acc", "live", -500); // well above
    expect((await guard.check(ctx(), place())).ok).toBe(false);
  });

  it("a profit or a flat day never trips it, a modify and a cancel still work, and paper is separate", async () => {
    const { guard, events } = rig({ safety: { dailyMaxLoss: 1000 } });
    guard.recordRealisedPnl("live-acc", "live", 5000);
    expect((await guard.check(ctx(), place())).ok).toBe(true);
    guard.recordRealisedPnl("live-acc", "live", -6000); // net loss 1000
    expect((await guard.check(ctx(), place())).ok).toBe(false);
    expect((await guard.check(ctx(), modify())).ok).toBe(true);
    expect((await guard.check(ctx(), cancel())).ok).toBe(true);
    expect((await guard.check(ctx(), paperPlace())).ok).toBe(true);
    expect(events.filter((e) => e.limit === "dailyMaxLoss").length).toBeGreaterThan(0);
  });

  it("paper fills count towards the paper day's loss with the same boundary", async () => {
    const { guard } = rig({ safety: { dailyMaxLoss: 1000 } });
    guard.recordRealisedPnl("paper-acc", "paper", -1000);
    const v = await guard.check(ctx(), paperPlace());
    expect(v.reasons[0]).toMatchObject({ code: "DAILY_LIMIT_REACHED", rule: "dailyMaxLoss" });
  });

  it("a per-account limit tighter than the global one wins", async () => {
    const { guard } = rig({
      safety: { dailyMaxLoss: 10_000 },
      accounts: [{ id: "live-acc", broker: "dhan", live: { enabled: true }, limits: { dailyMaxLoss: 100 } }],
    });
    guard.recordRealisedPnl("live-acc", "live", -100);
    expect(rules(await guard.check(ctx(), place()))).toEqual(["dailyMaxLoss"]);
  });
});

describe("order value, lots and the price band at the boundary", () => {
  it("max order value: at the limit passes, a paisa above is refused; live with no value is refused, paper warns", async () => {
    const { guard } = rig({ safety: { maxOrderValue: 5000 } });
    expect((await guard.check(ctx(), place({ value: 5000 }))).ok).toBe(true);
    expect(rules(await guard.check(ctx(), place({ value: 5000.01 })))).toEqual(["maxOrderValue"]);
    expect(rules(await guard.check(ctx(), place({ value: undefined })))).toEqual(["maxOrderValue"]);
    const paper = await guard.check(ctx(), paperPlace({ value: undefined }));
    expect(paper.ok).toBe(true);
    expect(paper.warnings.join(" ")).toMatch(/value could not be worked out/);
  });

  it("price band: at the limit passes, above is refused, for both price and trigger price", async () => {
    const { guard } = rig({ safety: { priceBandPct: 3 } });
    const withPrice = (price, extra = {}) => place({ order: { ...place().order, price, ...extra } });
    expect((await guard.check(ctx(), place({ ltp: 100, ...withPrice(103) }))).ok).toBe(true);
    expect(rules(await guard.check(ctx(), withPrice(103.5)))).toEqual(["priceBandPct"]);
    expect(rules(await guard.check(ctx(), withPrice(96.5)))).toEqual(["priceBandPct"]);
    expect(rules(await guard.check(ctx(), withPrice(100, { triggerPrice: 110, orderType: "SL" })))).toEqual(["priceBandPct"]);
  });

  it("a live MODIFY with a price but no last traded price is refused; a live place only warns; paper modify passes", async () => {
    const { guard } = rig();
    const noLtp = { ltp: undefined };
    const liveModify = await guard.check(ctx(), modify(noLtp));
    expect(liveModify.ok).toBe(false);
    expect(liveModify.reasons[0]).toMatchObject({ code: "INVALID_ORDER", rule: "priceBandPct" });
    expect(liveModify.reasons[0].message).toMatch(/No last traded price/);
    const livePlace = await guard.check(ctx(), place(noLtp));
    expect(livePlace.ok).toBe(true);
    expect(livePlace.warnings.join(" ")).toMatch(/price band was not checked/);
    expect((await guard.check(ctx(), paperPlace({ action: "modify", orderId: "o1", ...noLtp }))).ok).toBe(true);
    // A modify that sends no price (quantity only) has nothing to check against a band.
    expect((await guard.check(ctx(), modify({ ...noLtp, order: { symbol: "NSE:RELIANCE", side: "BUY", quantity: 2, product: "CNC", orderType: "LIMIT" } }))).ok).toBe(true);
  });

  it("market orders are refused when safety.marketOrders is reject", async () => {
    const { guard } = rig({ safety: { marketOrders: "reject" } });
    const mkt = place({ order: { ...place().order, orderType: "MARKET", price: undefined } });
    expect(rules(await guard.check(ctx(), mkt))).toEqual(["marketOrders"]);
  });
});

describe("market hours (live orders are refused when the market is closed; paper is only warned)", () => {
  it("live: refused on a weekend, in pre-open, after the close and at the closing minute; passes at 09:15 and 15:29", async () => {
    const cases = [
      [at(24, 10), false, "weekend"],
      [at(19, 9, 5), false, "pre-open"],
      [at(19, 9, 14), false, "one minute before open"],
      [at(19, 9, 15), true, "at the open"],
      [at(19, 15, 29), true, "last minute"],
      [at(19, 15, 30), false, "at the close"],
      [at(19, 20, 0), false, "evening"],
    ];
    for (const [t, ok, name] of cases) {
      const { guard } = rig({ t });
      const v = await guard.check(ctx(), place());
      expect(v.ok, name).toBe(ok);
      if (!ok) expect(v.reasons[0], name).toMatchObject({ code: "MARKET_CLOSED", rule: "marketHours" });
    }
  });

  it("applies to modify as well and never to a cancel; NSE, BSE and derivatives all follow the equity session", async () => {
    const { guard } = rig({ t: SAT_OPEN });
    expect(rules(await guard.check(ctx(), modify()))).toEqual(["marketHours"]);
    expect((await guard.check(ctx(), cancel())).ok).toBe(true);
    for (const symbol of ["BSE:RELIANCE", "NFO:NIFTY-2026-10-27-25000-CE", "BFO:SENSEX-2026-10-27-80000-PE"]) {
      expect(rules(await guard.check(ctx(), place({ order: { ...place().order, symbol } }))), symbol).toEqual(["marketHours"]);
    }
  });

  it("paper: placed with a warning that names the closed market (not in demo mode)", async () => {
    const { guard } = rig({ t: SAT_OPEN });
    const v = await guard.check(ctx(), paperPlace());
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/NSE market is not open now/);
  });

  it("a verified exchange holiday refuses a live order in session hours; an unverified one only warns", async () => {
    const holiday = (verified) => ({ session: () => ({ state: "HOLIDAY", label: "Holiday", holiday: { label: "Diwali Laxmi Pujan", verified } }) });
    const verified = rig({ reference: holiday(true) });
    const v = await verified.guard.check(ctx(), place());
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toMatchObject({ code: "MARKET_CLOSED", rule: "marketHours" });
    expect(v.reasons[0].message).toMatch(/NSE is closed today \(Diwali Laxmi Pujan\)/);
    expect((await verified.guard.check(ctx(), paperPlace())).ok).toBe(true);
    const bse = await verified.guard.check(ctx(), place({ order: { ...place().order, symbol: "BSE:RELIANCE" } }));
    expect(bse.reasons[0].message).toMatch(/^BSE is closed today/);
    const unverified = rig({ reference: holiday(false) });
    const w = await unverified.guard.check(ctx(), place());
    expect(w.ok).toBe(true);
    expect(w.warnings.join(" ")).toMatch(/may be an exchange holiday .* unverified/);
  });

  it("when the reference calendar says closed although the clock says open, the stricter answer wins", async () => {
    const { guard } = rig({ reference: { session: () => ({ state: "CLOSED", label: "Closed by the configured times" }) } });
    const v = await guard.check(ctx(), place());
    expect(v.reasons[0]).toMatchObject({ code: "MARKET_CLOSED", rule: "marketHours" });
    expect(v.reasons[0].message).toMatch(/Closed by the configured times/);
  });

  it("a calendar that throws does not stop a normal order", async () => {
    const { guard } = rig({ reference: { session: () => { throw new Error("calendar down"); } } });
    expect((await guard.check(ctx(), place())).ok).toBe(true);
  });

  it("a special session (Muhurat) the clock reports as SPECIAL is open for orders", async () => {
    const { guard } = rig({ t: SAT_OPEN, marketSession: () => ({ state: "SPECIAL", label: "Muhurat" }) });
    expect((await guard.check(ctx(), place())).ok).toBe(true);
  });

  it("MCX and CDS follow their own weekday windows: MCX 09:00 to 23:55, CDS 09:00 to 17:00, never at the weekend", async () => {
    const sym = (s) => place({ order: { ...place().order, symbol: s }, ltp: 100 });
    const cases = [
      ["MCX:CRUDEOIL-2026-10-19-FUT", at(19, 8, 59), false],
      ["MCX:CRUDEOIL-2026-10-19-FUT", at(19, 9, 0), true],
      ["MCX:CRUDEOIL-2026-10-19-FUT", at(19, 23, 54), true],
      ["MCX:CRUDEOIL-2026-10-19-FUT", at(19, 23, 55), false],
      ["MCX:CRUDEOIL-2026-10-19-FUT", at(24, 12, 0), false],
      ["CDS:USDINR-2026-10-28-FUT", at(19, 16, 59), true],
      ["CDS:USDINR-2026-10-28-FUT", at(19, 17, 0), false],
      ["CDS:USDINR-2026-10-28-FUT", at(25, 12, 0), false],
    ];
    for (const [symbol, t, ok] of cases) {
      const { guard } = rig({ t });
      const v = await guard.check(ctx(), sym(symbol));
      expect(v.ok, `${symbol} at ${new Date(t).toISOString()}`).toBe(ok);
      if (!ok) expect(v.reasons[0]).toMatchObject({ code: "MARKET_CLOSED", rule: "marketHours" });
      else expect(v.warnings.join(" ")).toMatch(/holidays are not checked/);
    }
    const { guard } = rig({ t: at(24, 12) });
    expect((await guard.check(ctx(), { ...paperPlace(), order: { ...place().order, symbol: "MCX:CRUDEOIL-2026-10-19-FUT" } })).ok).toBe(true); // paper only warns
  });
});

describe("the other layers of a live order", () => {
  it("is paper-only when live trading is off, the account is not enabled for live, or the source is not allowed", async () => {
    expect(rules(await rig({ safety: { liveTrading: false } }).guard.check(ctx(), place()))).toContain("liveTrading");
    expect(rules(await rig().guard.check(ctx(), place({ accountId: "paper-acc" })))).toContain("liveEnabled");
    const v = await rig().guard.check(ctx(), place({ source: "webhook" }));
    expect(rules(v)).toContain("allowedSources");
  });

  it("an unknown account, and an account the key may not use, are refused", async () => {
    const { guard } = rig();
    expect(rules(await guard.check(ctx(), place({ accountId: "nope" })))).toContain("account");
    expect(rules(await guard.check(ctx(["paper", "live"], ["paper-acc"]), place()))).toContain("account");
  });

  it("the order rate cap: the next order inside the window is refused with a retry time", async () => {
    const { guard, clock } = rig({ safety: { orderRatePerSecond: 2 } });
    expect(guard.acquireOrderSlot("live-acc").ok).toBe(true);
    expect(guard.acquireOrderSlot("live-acc").ok).toBe(true);
    const v = await guard.check(ctx(), place());
    expect(v.reasons[0]).toMatchObject({ code: "ORDER_RATE_LIMITED" });
    expect(v.reasons[0].retryAfterMs).toBeGreaterThan(0);
    clock.t += 1001;
    expect((await guard.check(ctx(), place())).ok).toBe(true);
  });
});

describe("boot-time kill switch (fail closed)", () => {
  const engagedAfterBoot = async (guard) => {
    expect(guard.killSwitchStatus().engaged).toBe(true);
    const v = await guard.check(ctx(), paperPlace());
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("KILL_SWITCH_ACTIVE");
    expect((await guard.check(ctx(), modify())).ok).toBe(false);
    expect((await guard.check(ctx(), cancel())).ok).toBe(true); // cancels always pass, so open orders can be closed
  };
  const persisted = (dir) => JSON.parse(readFileSync(join(dir, "kill-switch.json"), "utf8"));

  it("MCB_KILL_SWITCH=1 and =true engage it at start and save that to disk; 0, false and unset do not", async () => {
    for (const value of ["1", "true"]) {
      const { guard, dir } = rig({ env: { MCB_KILL_SWITCH: value } });
      await engagedAfterBoot(guard);
      expect(persisted(dir)).toMatchObject({ engaged: true, by: "system:startup" });
      expect(guard.killSwitchStatus().reason).toMatch(/killSwitchOnStart or MCB_KILL_SWITCH/);
    }
    for (const env of [{ MCB_KILL_SWITCH: "0" }, { MCB_KILL_SWITCH: "false" }, {}]) {
      const { guard } = rig({ env });
      expect(guard.killSwitchStatus().engaged, JSON.stringify(env)).toBe(false);
      expect((await guard.check(ctx(), paperPlace())).ok).toBe(true);
    }
  });

  it("safety.killSwitchOnStart in the config engages it at start", async () => {
    const { guard, dir } = rig({ safety: { killSwitchOnStart: true } });
    await engagedAfterBoot(guard);
    expect(persisted(dir).engaged).toBe(true);
  });

  it("it stays engaged on the next start from the saved file even when neither the env nor the config says so", async () => {
    const first = rig({ safety: { killSwitchOnStart: true } });
    const second = rig({ dir: first.dir });
    await engagedAfterBoot(second.guard);
    expect(second.guard.killSwitchStatus().reason).toMatch(/Engaged at start/);
  });

  it("an unreadable or wrongly shaped kill-switch file engages it (a damaged disk never switches it off)", async () => {
    for (const body of ["{{ not json", "[1,2]", JSON.stringify({ hello: 1 }), JSON.stringify({ engaged: "no" })]) {
      const dir = mkdtempSync(join(tmpdir(), "mcb-guard-ks-"));
      writeFileSync(join(dir, "kill-switch.json"), body);
      const { guard } = rig({ dir });
      await engagedAfterBoot(guard);
      expect(guard.killSwitchStatus().by, body).toBe("system:startup");
    }
  });

  it("an unreadable daily-counters file engages it too (the guard cannot know how many orders went out today)", async () => {
    for (const body of ["{{ not json", JSON.stringify({ accounts: {} })]) {
      const dir = mkdtempSync(join(tmpdir(), "mcb-guard-cnt-"));
      writeFileSync(join(dir, "counters.json"), body);
      const { guard } = rig({ dir });
      await engagedAfterBoot(guard);
      expect(guard.killSwitchStatus().reason, body).toMatch(/counters could not be read/);
      expect(persisted(dir).engaged).toBe(true);
    }
  });

  it("healthy state files do not engage it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-guard-ok-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kill-switch.json"), JSON.stringify({ version: 1, engaged: false, reason: null, by: null, at: null }));
    writeFileSync(join(dir, "counters.json"), JSON.stringify({ version: 1, day: "2026-10-19", accounts: {}, tightened: { global: {}, accounts: {} } }));
    const { guard } = rig({ dir });
    expect(guard.killSwitchStatus().engaged).toBe(false);
    expect((await guard.check(ctx(), paperPlace())).ok).toBe(true);
  });
});

describe("tightening limits for the rest of the day (nothing at runtime can loosen one)", () => {
  it("a tighter value applies at once, to one account or to all, and the account's own limit stays the stricter", async () => {
    const { guard } = rig({ safety: { dailyMaxOrders: 100, maxOrderValue: 100_000 } });
    const limits = await guard.tightenLimits(ctx(), "live-acc", { dailyMaxOrders: 2 });
    expect(limits.dailyMaxOrders).toBe(2);
    for (let n = 0; n < 2; n += 1) guard.recordOrderEvent("live-acc", { action: "place", mode: "live" });
    expect(rules(await guard.check(ctx(), place()))).toEqual(["dailyMaxOrders"]);
    expect((await guard.check(ctx(), paperPlace())).ok).toBe(true); // the other account kept its limit
    const all = await guard.tightenLimits(ctx(), null, { maxOrderValue: 50 });
    expect(all.maxOrderValue).toBe(50);
    expect(rules(await guard.check(ctx(), paperPlace({ value: 51 })))).toEqual(["maxOrderValue"]);
    expect((await guard.check(ctx(), paperPlace({ value: 50 }))).ok).toBe(true);
  });

  it("refuses to loosen a limit, to tighten an unknown one, a bad number or an unknown account, and says what to do", async () => {
    const { guard } = rig({ safety: { dailyMaxOrders: 10 } });
    await expect(guard.tightenLimits(ctx(), "live-acc", { dailyMaxOrders: 11 })).rejects.toMatchObject({ code: "VALIDATION_FAILED", errors: [{ path: "dailyMaxOrders", message: expect.stringMatching(/only be tightened.*edit bridge\.config\.json/) }] });
    await expect(guard.tightenLimits(ctx(), "live-acc", { dailyMaxOrders: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.tightenLimits(ctx(), "live-acc", { dailyMaxLoss: -1 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.tightenLimits(ctx(), "live-acc", { liveTrading: 1 })).rejects.toMatchObject({ errors: [{ path: "liveTrading", message: "not a safety limit" }] });
    await expect(guard.tightenLimits(ctx(), "live-acc", { marketOrders: "allow" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(guard.tightenLimits(ctx(), "nobody", { dailyMaxOrders: 1 })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    await expect(guard.tightenLimits(ctx(), "live-acc", null)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(guard.limits("live-acc").limits.dailyMaxOrders).toBe(10); // nothing was half applied
    // the same value is allowed (not a loosening), and so is turning market orders off
    await guard.tightenLimits(ctx(), "live-acc", { dailyMaxOrders: 10, marketOrders: "reject" });
    const mkt = place({ order: { ...place().order, orderType: "MARKET", price: undefined } });
    expect(rules(await guard.check(ctx(), mkt))).toEqual(["marketOrders"]);
  });

  it("is kept across a restart and dropped at the next IST day", async () => {
    const first = rig({ safety: { dailyMaxOrders: 100 } });
    await first.guard.tightenLimits(ctx(), null, { dailyMaxOrders: 1 });
    const second = rig({ dir: first.dir, safety: { dailyMaxOrders: 100 } });
    expect(second.guard.limits("live-acc").limits.dailyMaxOrders).toBe(1);
    second.clock.t += 24 * 3_600_000;
    expect(second.guard.limits("live-acc").limits.dailyMaxOrders).toBe(100);
  });

  it("when the config is made stricter than today's tightening, the config wins (the stricter of the two)", async () => {
    const first = rig({ safety: { dailyMaxOrders: 100 } });
    await first.guard.tightenLimits(ctx(), null, { dailyMaxOrders: 50 });
    const second = rig({ dir: first.dir, safety: { dailyMaxOrders: 20 } });
    expect(second.guard.limits("live-acc").limits.dailyMaxOrders).toBe(20);
  });
});
