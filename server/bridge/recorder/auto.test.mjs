/**
 * Auto recording by rules: the session start and end, the daily re-resolve and the expiry roll, a missing login at the
 * start, the presets, the rules store, and the switch that keeps it all off until a person turns it on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeRows } from "./format.mjs";
import { NIFTY, at, bootRecorder, leg } from "./testkit.mjs";

let w;
afterEach(async () => {
  await w?.close();
  w = null;
});

const rec = (id) => join(w.dir, "recordings", id);
const dataFiles = (id) => readdirSync(rec(id)).filter((n) => /^\d{4}-\d{2}-\d{2}__/.test(n)).sort();
const rows = (id, name) => decodeRows(readFileSync(join(rec(id), name), "utf8"), "csv");

const CHAIN_RULE = {
  name: "Nifty chain",
  kind: "chain",
  underlying: "NIFTY",
  universe: { expiries: "current-weekly", strikes: { around: "atm", count: 2 }, sides: ["CE", "PE"], includeUnderlying: true, includeFuture: false },
  everySec: 30,
  schedule: "market-hours",
};

describe("auto recording by rules", () => {
  it("does nothing until a person turns it on, then starts at the session start and stops at the end by itself", async () => {
    w = bootRecorder({ start: at("2026-11-09T08:50:00") });
    await w.svc.start();
    const rule = await w.svc.createRule(CHAIN_RULE);
    expect(rule).toMatchObject({ id: "nifty-chain", enabled: true, state: "off", statusText: "Auto-record is off." });
    await w.run(15 * 60_000, 60_000);
    expect(w.svc.list()).toEqual([]); // off by default: no recording exists, nothing is written
    expect(w.eventsOf("recording.started")).toEqual([]);

    await w.svc.setAuto(true);
    expect(w.svc.list().map((r) => r.id)).toEqual(["rule-nifty-chain"]);
    await w.run(60_000, 10_000);
    expect(w.svc.get("rule-nifty-chain")).toMatchObject({ status: "waiting", auto: true, ruleId: "nifty-chain" });
    expect(w.eventsOf("recording.started")).toEqual([]);

    await w.clock.set(at("2026-11-09T09:15:00"));
    await w.run(40_000, 10_000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 24012 });
    await w.run(80_000, 10_000);
    const started = w.eventsOf("recording.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ id: "rule-nifty-chain", auto: true, ruleId: "nifty-chain", date: "2026-11-09" });
    const v = w.svc.get("rule-nifty-chain");
    expect(v.status).toBe("recording");
    // ATM +/- 2 strikes, CE and PE, plus the underlying
    expect(v.symbols.count).toBe(11);
    expect(v.symbols.rule).toMatch(/NIFTY 2026-11-09 ATM 24000 \+\/- 2 strikes \(spot 24012\)/);
    const files = dataFiles("rule-nifty-chain");
    expect(files).toContain(`2026-11-09__NFO_NIFTY-2026-11-09-24000-CE.csv`);
    expect(files).toContain(`2026-11-09__NSE_NIFTY.csv`);
    const ce = rows("rule-nifty-chain", `2026-11-09__NFO_NIFTY-2026-11-09-24000-CE.csv`);
    expect(ce.length).toBeGreaterThanOrEqual(3);
    expect(ce[0]).toMatchObject({ symbol: leg("NIFTY", "2026-11-09", 24000, "CE"), spot: 24012, class: "realtime" });
    // one chain read per snapshot, at background priority within the share cap, never from a backup source
    const chainCalls = w.md.calls.filter((c) => c[0] === "optionChain" && c[1].greeks !== false);
    expect(chainCalls.length).toBeGreaterThanOrEqual(3);
    expect(chainCalls[0][2]).toMatchObject({ priority: "background", backgroundShare: 0.3, allowBackup: false });

    await w.svc.patchRule("nifty-chain", { everySec: 1800 }); // fewer passes while the clock jumps to the close
    await w.clock.set(at("2026-11-09T15:40:20")); // derivatives close at 15:40 since 3 Aug 2026 (reference/data/sessions.json)
    await w.run(60_000, 10_000);
    expect(w.eventsOf("recording.stopped")).toHaveLength(1);
    expect(w.eventsOf("recording.stopped")[0]).toMatchObject({ id: "rule-nifty-chain", auto: true, reason: "session-end" });
    expect(w.svc.get("rule-nifty-chain").status).toBe("waiting");
    const last = ce.length;
    await w.run(10 * 60_000, 60_000);
    expect(rows("rule-nifty-chain", `2026-11-09__NFO_NIFTY-2026-11-09-24000-CE.csv`).every((r) => r.time.slice(11, 16) < "15:41")).toBe(true);
    expect(last).toBeGreaterThan(0);
  });

  it("re-resolves the universe on the next trading day: the expiry rolls and the strikes follow the price", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:14:00") });
    await w.svc.start();
    await w.svc.createRule({ ...CHAIN_RULE, schedule: "market-hours" });
    await w.svc.setAuto(true);
    await w.run(3 * 60_000, 30_000);
    expect(w.svc.get("rule-nifty-chain").symbols.sample.some((s) => s.includes("2026-11-09"))).toBe(true);
    await w.svc.patchRule("nifty-chain", { everySec: 1800 }); // fewer passes while the clock jumps two days
    // the weekly expiry was today; the market moved up 500 points overnight; Tuesday 10th is a holiday
    w.md.setPrice(NIFTY, 24512);
    await w.clock.set(at("2026-11-11T09:16:00"));
    await w.run(3 * 60_000, 30_000);
    const v = w.svc.get("rule-nifty-chain");
    expect(v.symbols.rule).toMatch(/NIFTY 2026-11-17 ATM 24500/);
    expect(v.symbols.sample.every((s) => !s.includes("2026-11-09"))).toBe(true);
    const files = dataFiles("rule-nifty-chain");
    expect(files).toContain("2026-11-11__NFO_NIFTY-2026-11-17-24500-CE.csv");
    expect(files.some((n) => n.startsWith("2026-11-10"))).toBe(false); // holiday
    expect(w.eventsOf("recording.started").map((e) => e.date)).toEqual(["2026-11-09", "2026-11-11"]);
  });

  it("with no login at the session start it says account.login_needed once, logs a gap, and starts when a login arrives", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:10:00"), accounts: [{ id: "main", broker: "dhan", label: "Main", state: "expired" }] });
    await w.svc.start();
    await w.svc.createRule({ name: "Watch", kind: "quotes", symbols: [NIFTY], everySec: 5, schedule: "market-hours" });
    await w.svc.setAuto(true);
    await w.clock.set(at("2026-11-09T09:15:00"));
    await w.run(10 * 60_000, 15_000);
    const needed = w.eventsOf("account.login_needed");
    expect(needed).toHaveLength(1);
    expect(needed[0]).toMatchObject({ accountId: "main", reason: "expired", source: "recorder" });
    expect(w.svc.get("rule-watch")).toMatchObject({ rows: 0 });
    expect(w.svc.get("rule-watch").gaps.open).toMatchObject({ reason: "login-missing" });
    expect(w.svc.get("rule-watch").statusText).toMatch(/No broker login/);
    // a login arrives
    w.accounts.setState("main", "connected");
    await w.run(10_000, 1000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 24010 });
    await w.run(10_000, 1000);
    const v = w.svc.get("rule-watch");
    expect(v.rows).toBeGreaterThan(0);
    expect(v.gaps.open).toBe(null);
    expect(v.gaps.recent[0]).toMatchObject({ reason: "login-missing", state: "closed" });
    expect(w.eventsOf("account.login_needed")).toHaveLength(1);
  });

  it("resumes the rules by itself after a restart and keeps the day's files", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:15:00") });
    await w.svc.start();
    await w.svc.createRule({ name: "Watch", kind: "quotes", symbols: [NIFTY], everySec: 5, schedule: "market-hours" });
    await w.svc.setAuto(true);
    await w.run(20_000, 5000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(10_000, 5000);
    const before = w.svc.get("rule-watch").rows;
    expect(before).toBeGreaterThan(0);
    await w.svc.close();
    await w.restart();
    expect(w.svc.auto()).toMatchObject({ enabled: true, setBy: "user", rules: 1, activeRules: 1 });
    await w.run(20_000, 5000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 2 });
    await w.run(10_000, 5000);
    expect(w.svc.get("rule-watch").rows).toBeGreaterThan(before);
    expect(w.eventsOf("recording.started")).toHaveLength(1); // a resume is not a new start
    expect(dataFiles("rule-watch")).toEqual(["2026-11-09__NSE_NIFTY.csv"]);
  });

  it("an unresolvable universe (delayed price) is never guessed: it waits, says why and logs a gap", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:15:00") });
    w.label.current = { class: "delayed", delaySec: 900, provider: "free-source", source: "backup", official: false };
    await w.svc.start();
    await w.svc.createRule(CHAIN_RULE);
    await w.svc.setAuto(true);
    await w.run(3 * 60_000, 15_000);
    const v = w.svc.get("rule-nifty-chain");
    expect(v.symbols.count).toBe(0);
    expect(v.symbols.problem).toMatch(/delayed/);
    expect(v.statusText).toMatch(/Waiting to choose the symbols/);
    expect(v.gaps.open).toMatchObject({ reason: "universe-unresolved" });
    expect(dataFiles("rule-nifty-chain")).toEqual([]);
    w.label.current = null;
    await w.run(3 * 60_000, 15_000);
    expect(w.svc.get("rule-nifty-chain").symbols.count).toBe(11);
  });
});

describe("rules and presets", () => {
  it("stores rules, edits them, turns a rule off, and deleting a rule keeps the files unless asked", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:15:00") });
    await w.svc.start();
    await w.svc.setAuto(true);
    const r = await w.svc.createRule({ name: "My list", kind: "quotes", symbols: [NIFTY, "NSE:RELIANCE"], everySec: 5 });
    expect(r.id).toBe("my-list");
    expect(w.svc.listRules().map((x) => x.id)).toEqual(["my-list"]);
    await expect(w.svc.createRule({ name: "My list", kind: "quotes", symbols: [NIFTY], everySec: 5, id: "my-list" })).rejects.toThrow(/already a rule/);
    const patched = await w.svc.patchRule("my-list", { everySec: 10, keepDays: 20 });
    expect(patched).toMatchObject({ everySec: 10, keepDays: 20 });
    await w.run(20_000, 5000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 3 });
    await w.run(10_000, 5000);
    expect(w.svc.get("rule-my-list").rows).toBeGreaterThan(0);
    // turn the rule off: the recording stops, the files stay
    await w.svc.patchRule("my-list", { enabled: false });
    expect(w.svc.get("rule-my-list")).toMatchObject({ status: "stopped" });
    expect(() => w.svc.stop("rule-my-list")).not.toThrow();
    // a rule's recording cannot be stopped or deleted on its own while the rule exists
    await w.svc.patchRule("my-list", { enabled: true });
    expect(() => w.svc.stop("rule-my-list")).toThrow(/belongs to the auto-record rule/);
    expect(() => w.svc.remove("rule-my-list")).toThrow(/Delete the rule instead/);
    w.svc.deleteRule("my-list");
    expect(w.svc.get("rule-my-list").status).toBe("stopped");
    expect(dataFiles("rule-my-list").length).toBeGreaterThan(0);
    await w.svc.createRule({ name: "My list", kind: "quotes", symbols: [NIFTY], everySec: 5 });
    w.svc.deleteRule("my-list", { deleteFiles: true });
    expect(w.svc.list()).toEqual([]);
  });

  it("rules written in the config are read-only through the API and work like any other", async () => {
    w = bootRecorder({
      start: at("2026-11-09T09:15:00"),
      config: { autoRecord: { enabled: true, rules: [{ id: "from-config", name: "Config rule", kind: "quotes", symbols: [NIFTY], everySec: 5 }] } },
    });
    await w.svc.start();
    expect(w.svc.listRules()[0]).toMatchObject({ id: "from-config", source: "config" });
    expect(w.svc.auto()).toMatchObject({ enabled: true, setBy: "config" });
    await expect(w.svc.patchRule("from-config", { enabled: false })).rejects.toThrow(/bridge.config.json/);
    expect(() => w.svc.deleteRule("from-config")).toThrow(/bridge.config.json/);
    await w.svc.setAuto(false);
    expect(w.svc.get("rule-from-config").status).toBe("stopped");
  });

  it("validates rules in plain words", async () => {
    w = bootRecorder();
    await w.svc.start();
    await expect(w.svc.createRule({ name: "x", kind: "chain", underlying: "NIFTY", everySec: 10 })).rejects.toThrow(/at least 15 seconds/);
    await expect(w.svc.createRule({ name: "x", kind: "quotes", everySec: 10 })).rejects.toThrow(/exactly one of symbols, collection or underlying/);
    await expect(w.svc.createRule({ name: "x", kind: "quotes", symbols: [NIFTY], everySec: 10, schedule: { days: ["mon"], start: "15:00", end: "09:00" } })).rejects.toThrow(/start must be earlier/);
    await expect(w.svc.createRule({ name: "x", kind: "quotes", symbols: ["MCX:CRUDEOIL-2026-11-19-FUT"], everySec: 10 })).rejects.toThrow(/own hours/);
    await expect(w.svc.patchRule("nope", { enabled: false })).rejects.toThrow(/No auto-record rule/);
  });

  it("a custom schedule uses the chosen days and hours (IST) on trading days only", async () => {
    w = bootRecorder({ start: at("2026-11-09T10:00:00") });
    await w.svc.start();
    await w.svc.setAuto(true);
    await w.svc.createRule({ name: "Morning", kind: "quotes", symbols: [NIFTY], everySec: 5, schedule: { days: ["mon", "tue", "wed"], start: "09:30", end: "10:30" } });
    await w.run(20_000, 5000);
    w.hub.pushTick({ symbol: NIFTY, ltp: 1 });
    await w.run(10_000, 5000);
    expect(w.svc.get("rule-morning").status).toBe("recording");
    await w.clock.set(at("2026-11-09T10:31:00"));
    await w.run(60_000, 10_000);
    expect(w.svc.get("rule-morning").status).toBe("waiting");
    // tomorrow is a holiday, so the next start is Wednesday
    expect(w.svc.get("rule-morning").nextStartAt).toMatch(/^2026-11-11T09:30/);
  });

  it("presets create a rule, turn auto-record on, and applying twice does not duplicate", async () => {
    w = bootRecorder({ start: at("2026-11-09T08:00:00") });
    await w.svc.start();
    expect(w.svc.presets().map((p) => p.id)).toEqual(["index-option-chains", "my-watchlist"]);
    expect(w.svc.auto().enabled).toBe(false);
    const first = await w.svc.applyPreset("index-option-chains");
    expect(first).toMatchObject({ created: true, auto: { enabled: true } });
    expect(first.rule).toMatchObject({ kind: "chain", everySec: 30, underlying: ["NIFTY", "BANKNIFTY"], schedule: "market-hours" });
    const again = await w.svc.applyPreset("index-option-chains");
    expect(again.created).toBe(false);
    expect(w.svc.listRules()).toHaveLength(1);
    await expect(w.svc.applyPreset("my-watchlist")).rejects.toThrow(/library of collections is not available/);
    await expect(w.svc.applyPreset("nope")).rejects.toThrow(/No preset/);
  });

  it("the watchlist preset reads a collection from the library and re-resolves it each day", async () => {
    const lib = { calls: 0, symbols: [NIFTY], async resolve(name) { this.calls += 1; if (name !== "watchlist") throw Object.assign(new Error("none"), { code: "NOT_FOUND" }); return { symbols: this.symbols, resolvedAt: "x", rule: "static list" }; } };
    w = bootRecorder({ start: at("2026-11-09T09:15:00"), library: lib });
    await w.svc.start();
    await w.svc.applyPreset("my-watchlist");
    await w.run(10_000, 1000);
    expect(w.svc.get("rule-my-watchlist").symbols).toMatchObject({ count: 1, via: "library", rule: "static list" });
    await w.svc.patchRule("my-watchlist", { everySec: 3600 }); // fewer passes while the clock jumps two days
    lib.symbols = [NIFTY, "NSE:RELIANCE"];
    await w.clock.set(at("2026-11-11T09:16:00"));
    await w.run(10_000, 1000);
    expect(w.svc.get("rule-my-watchlist").symbols.count).toBe(2);
    await expect(w.svc.applyPreset("my-watchlist", { collection: "missing" })).resolves.toMatchObject({ created: false });
  });

  it("a stale ATM from the library (an error) or a delayed one is a logged gap, not a silent guess; usage is registered with the library", async () => {
    const providers = [];
    const lib = { mode: "stale", registerUsageProvider: (kind, fn) => providers.push([kind, fn]), async resolve() { if (this.mode === "stale") throw new Error("The ATM price is stale; pass allowStale to use it."); return { symbols: [NIFTY], atmSource: { class: "delayed" } }; } };
    w = bootRecorder({ start: at("2026-11-09T09:15:00"), library: lib });
    await w.svc.start();
    await w.svc.applyPreset("my-watchlist");
    await w.run(2 * 60_000, 15_000);
    let v = w.svc.get("rule-my-watchlist");
    expect(v.symbols.count).toBe(0);
    expect(v.symbols.problem).toMatch(/stale/);
    expect(v.gaps.open).toMatchObject({ reason: "universe-unresolved" });
    lib.mode = "delayed";
    await w.run(2 * 60_000, 15_000);
    v = w.svc.get("rule-my-watchlist");
    expect(v.symbols.problem).toMatch(/not real-time/);
    expect(dataFiles("rule-my-watchlist")).toEqual([]);
    // the library calls a provider as registerUsageProvider(kind, ({ id, name, names }) => rows)
    expect(providers.map(([kind]) => kind)).toEqual(["recordings", "rules"]);
    const rules = providers[1][1];
    expect(rules({ id: "c1", name: "watchlist", names: ["watchlist"] })).toEqual([{ id: "my-watchlist", label: "My watchlist", status: expect.any(String), active: true }]);
    expect(rules({ id: "c1", name: "other", names: ["other"] })).toEqual([]);
    expect(rules({ id: "c1", name: "renamed", names: ["renamed", "watchlist"] })).toHaveLength(1);
    expect(providers[0][1]({ name: "watchlist" })).toEqual([]);
    expect(w.svc.usageOf("watchlist")).toMatchObject([{ type: "recording-rule", id: "my-watchlist", collection: "watchlist", enabled: true }]);
  });

  it("the status line counts rules, symbols, size and the last write", async () => {
    w = bootRecorder({ start: at("2026-11-09T09:15:00") });
    await w.svc.start();
    await w.svc.setAuto(true);
    await w.svc.createRule({ name: "A", kind: "quotes", symbols: [NIFTY], everySec: 5 });
    await w.svc.createRule({ name: "B", kind: "quotes", symbols: ["NSE:RELIANCE", "NSE:INFY"], everySec: 5 });
    await w.run(20_000, 5000);
    for (const s of [NIFTY, "NSE:RELIANCE", "NSE:INFY"]) w.hub.pushTick({ symbol: s, ltp: 10 });
    await w.run(10_000, 5000);
    expect(w.svc.status().line).toMatch(/^Recording today: 2 rules, 3 symbols, \d+ KB, last write 09:\d\d:\d\d\.$/);
  });
});
