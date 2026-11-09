/**
 * The Sources page logic: the tone scale (thresholds, hysteresis, dwell), the burn-rate forecast, the pooled room, the
 * risk sort, plain-language labels, route traces, quota validation and the pooling consent rules. Pure: no DOM.
 */
import { describe, expect, it } from "vitest";
import * as C from "./sources-core.js";
import * as F from "./sources.fixtures.mjs";

describe("tone scale", () => {
  it("uses 60, 80 and 95 percent and a 60 second forecast", () => {
    expect(C.LIMIT_TONES).toMatchObject({ busy: 0.6, headsUp: 0.8, limit: 0.95, forecastHeadsUpSec: 60 });
  });

  it("maps a share to calm, busy, heads up and at the limit at the edges", () => {
    expect(C.toneForShare(0)).toBe("calm");
    expect(C.toneForShare(0.599)).toBe("calm");
    expect(C.toneForShare(0.6)).toBe("busy");
    expect(C.toneForShare(0.799)).toBe("busy");
    expect(C.toneForShare(0.8)).toBe("headsup");
    expect(C.toneForShare(0.949)).toBe("headsup");
    expect(C.toneForShare(0.95)).toBe("limit");
    expect(C.toneForShare(1)).toBe("limit");
    expect(C.toneForShare(Number.NaN)).toBe("calm");
  });

  it("a forecast under 60 seconds is a heads up whatever the share", () => {
    expect(C.toneForShare(0.2, 59)).toBe("headsup");
    expect(C.toneForShare(0.2, 60)).toBe("calm");
    expect(C.toneForShare(0.2, null)).toBe("calm");
    expect(C.toneForShare(0.97, 10)).toBe("limit");
  });

  it("the words are the ones the page uses", () => {
    expect(C.TONE_SENTENCE).toEqual({ calm: "Plenty of room", busy: "Busy", headsup: "Heads up", limit: "At the limit" });
    expect(C.TONE_WORD.calm).toBe("Calm");
  });
});

describe("tone tracker: hysteresis and dwell", () => {
  it("rises at once", () => {
    const t = C.createToneTracker();
    expect(t.update("a", 0.1, null, 0)).toBe("calm");
    expect(t.update("a", 0.85, null, 100)).toBe("headsup");
    expect(t.update("a", 0.99, null, 200)).toBe("limit");
  });

  it("does not fall before the dwell time has passed, even when the share is low", () => {
    const t = C.createToneTracker();
    t.update("a", 0.97, null, 0);
    expect(t.update("a", 0.1, null, 4999)).toBe("limit");
    expect(t.update("a", 0.1, null, 5000)).toBe("calm");
  });

  it("leaves the limit only when more than 10 percent is back", () => {
    const t = C.createToneTracker();
    t.update("a", 0.97, null, 0);
    expect(t.update("a", 0.93, null, 10_000)).toBe("limit");
    expect(t.update("a", 0.89, null, 11_000)).toBe("headsup");
  });

  it("leaves heads up only below 70 percent with a forecast longer than 120 seconds", () => {
    const t = C.createToneTracker();
    t.update("a", 0.85, null, 0);
    expect(t.update("a", 0.75, null, 10_000)).toBe("headsup");
    expect(t.update("a", 0.65, 90, 11_000)).toBe("headsup");
    expect(t.update("a", 0.65, 121, 12_000)).toBe("busy");
  });

  it("leaves busy below 50 percent", () => {
    const t = C.createToneTracker();
    t.update("a", 0.62, null, 0);
    expect(t.update("a", 0.55, null, 10_000)).toBe("busy");
    expect(t.update("a", 0.49, null, 11_000)).toBe("calm");
  });

  it("a budget that flaps around 80 percent does not strobe", () => {
    const t = C.createToneTracker();
    const seen = [];
    let at = 0;
    for (const share of [0.82, 0.78, 0.82, 0.79, 0.83, 0.77, 0.81, 0.79]) {
      seen.push(t.update("a", share, null, (at += 1000)));
    }
    expect(new Set(seen)).toEqual(new Set(["headsup"]));
  });

  it("keeps each key apart and forgets what is pruned", () => {
    const t = C.createToneTracker();
    t.update("a", 0.9, null, 0);
    t.update("b", 0.1, null, 0);
    expect(t.get("a")).toBe("headsup");
    expect(t.get("b")).toBe("calm");
    t.prune(new Set(["b"]));
    expect(t.get("a")).toBeNull();
  });
});

describe("windows and wording", () => {
  it("reads the window names the Bridge uses", () => {
    expect(C.windowSeconds("1s")).toBe(1);
    expect(C.windowSeconds("1m")).toBe(60);
    expect(C.windowSeconds("60s")).toBe(60);
    expect(C.windowSeconds("30m")).toBe(1800);
    expect(C.windowSeconds("1h")).toBe(3600);
    expect(C.windowSeconds("day")).toBe(86400);
    expect(C.windowSeconds("second")).toBe(1);
    expect(C.windowSeconds("binding")).toBeNull();
    expect(C.windowSeconds(undefined)).toBeNull();
  });

  it("says windows as people do", () => {
    expect(C.perText(1)).toBe("per second");
    expect(C.perText(60)).toBe("per minute");
    expect(C.perText(86400)).toBe("per day");
    expect(C.perText(1800)).toBe("every 30 minutes");
    expect(C.perText(7200)).toBe("every 2 hours");
  });

  it("says a wait in rounded plain words", () => {
    expect(C.waitPhrase(2)).toBe("a few seconds");
    expect(C.waitPhrase(41)).toBe("about 40 seconds");
    expect(C.waitPhrase(240)).toBe("about 4 minutes");
    expect(C.waitPhrase(60 * 70)).toBe("about an hour");
    expect(C.waitPhrase(3600 * 3)).toBe("about 3 hours");
    expect(C.waitPhrase(Number.NaN)).toBe("–");
  });

  it("says short countdowns and ages", () => {
    expect(C.shortWait(8000)).toBe("8 s");
    expect(C.shortWait(61_000)).toBe("2 min");
    expect(C.shortWait(3_900_000)).toBe("1 h 5 min");
    expect(C.agoText(500)).toBe("just now");
    expect(C.agoText(14_000)).toBe("14 s ago");
    expect(C.agoText(190_000)).toBe("3 min ago");
  });

  it("labels the data class with its delay, and never calls a delayed source real-time", () => {
    expect(C.classLabel("realtime")).toBe("Real-time");
    expect(C.classLabel("delayed", 900)).toBe("Delayed 15 min");
    expect(C.classLabel("delayed", null)).toBe("Delayed");
    expect(C.classLabel("eod")).toBe("End of day");
    expect(C.classAdvice("delayed", 900)).toMatch(/15 min behind the market.*never used for orders/);
    expect(C.classAdvice("eod")).toMatch(/never used for orders/);
    expect(C.officialLabel(true)).toBe("Official");
    expect(C.officialLabel(false)).toBe("Unofficial");
  });

  it("lists capabilities in a sentence", () => {
    expect(C.capabilityText(["quotes", "history"])).toBe("quotes and history");
    expect(C.capabilityText(["quotes", "history", "optionChain"])).toBe("quotes, history and option chains");
    expect(C.capabilityText([])).toBe("nothing yet");
  });
});

describe("burn rate", () => {
  it("smooths a rising counter and ignores gaps and resets", () => {
    const r = C.createRateTracker({ alpha: 0.5 });
    expect(r.update("a", 100, 0)).toBeNull();
    expect(r.update("a", 120, 2000)).toBe(10);
    // (0.5 * 20/s) + (0.5 * 10/s)
    expect(r.update("a", 160, 4000)).toBe(15);
    // a long gap restarts the estimate
    expect(r.update("a", 400, 20_000)).toBeNull();
    expect(r.update("a", 410, 22_000)).toBe(5);
    // the counter went down (a new day)
    expect(r.update("a", 3, 24_000)).toBeNull();
  });

  it("keeps keys apart", () => {
    const r = C.createRateTracker();
    r.update("a", 0, 0);
    r.update("b", 0, 0);
    r.update("a", 10, 1000);
    r.update("b", 40, 1000);
    expect(r.get("a")).toBe(10);
    expect(r.get("b")).toBe(40);
  });
});

describe("smoothing", () => {
  it("follows a sustained level and shrugs off one burst", () => {
    const s = C.createSmoother({ alpha: 0.35 });
    expect(s.update("a", 0.2)).toBe(0.2);
    const burst = s.update("a", 1);
    expect(burst).toBeCloseTo(0.48, 5);
    expect(C.toneForShare(burst)).toBe("calm");
    let v = burst;
    for (let i = 0; i < 8; i++) v = s.update("a", 1);
    expect(C.toneForShare(v)).toBe("limit");
  });

  it("a one-second budget uses the smoothed share for its tone, but an empty budget is always at the limit", () => {
    const smooth = C.createSmoother();
    const tones = C.createToneTracker();
    const rates = C.createRateTracker();
    const mk = (used) => C.buildRows({ usage: F.usage([F.usageAccount({ id: "a", quote: [used, 10, 0, 600] })]) });
    C.annotateRows(mk(1), { tones, rates, smooth, at: 0 });
    const [burst] = C.annotateRows(mk(10), { tones, rates, smooth, at: 2000 });
    expect(burst.budget.share).toBe(1);
    expect(burst.tone).toBe("limit");
    // a gentler burst of 9 of 10 after calm is not yet a heads up
    const t2 = C.createToneTracker();
    const s2 = C.createSmoother();
    C.annotateRows(mk(1), { tones: t2, rates, smooth: s2, at: 0 });
    const [soft] = C.annotateRows(mk(9), { tones: t2, rates, smooth: s2, at: 2000 });
    expect(soft.tone).toBe("calm");
  });
});

describe("forecast", () => {
  it("stays calm when the pace is below the refill", () => {
    expect(C.forecastEmpty({ remaining: 300, limit: 600, windowSec: 60, rate: 5 })).toEqual({ kind: "calm", seconds: null });
  });

  it("a token bucket that refills limit/window a second: net pace counts", () => {
    // 600 a minute refills 10/s. Using 20/s nets 10/s: 300 left runs out in 30 s.
    expect(C.forecastEmpty({ remaining: 300, limit: 600, windowSec: 60, rate: 20 })).toEqual({ kind: "runsOut", seconds: 30 });
  });

  it("a fixed window gains nothing until it resets, and a reset before the end means calm", () => {
    expect(C.forecastEmpty({ remaining: 100, limit: 1000, windowSec: 86400, rate: 1, fixed: true, resetInSec: 50 })).toEqual({ kind: "calm", seconds: null });
    expect(C.forecastEmpty({ remaining: 100, limit: 1000, windowSec: 86400, rate: 1, fixed: true, resetInSec: 36000 })).toEqual({ kind: "runsOut", seconds: 100 });
  });

  it("rounds to 5 seconds and says nothing about a distant run-out", () => {
    expect(C.forecastEmpty({ remaining: 94, limit: 600, windowSec: 60, rate: 12 }).seconds).toBe(45);
    // 5 windows is the horizon
    expect(C.forecastEmpty({ remaining: 590, limit: 600, windowSec: 60, rate: 11 })).toEqual({ kind: "calm", seconds: null });
  });

  it("an empty budget is empty now, an unknown pace is calm, no limit is calm", () => {
    expect(C.forecastEmpty({ remaining: 0, limit: 10, windowSec: 1, rate: null })).toEqual({ kind: "empty", seconds: 0 });
    expect(C.forecastEmpty({ remaining: 5, limit: 10, windowSec: 1, rate: null }).kind).toBe("calm");
    expect(C.forecastEmpty({ remaining: 5, limit: 0, windowSec: 1, rate: 3 }).kind).toBe("calm");
  });
});

describe("rows from the Bridge's answers", () => {
  const time = (iso) => iso.slice(11, 19);
  const rows = () => C.buildRows({ sources: F.sources(), usage: F.usage(), time });

  it("makes a row for each broker account and each enabled source, brokers of the sources list not repeated", () => {
    const r = rows();
    expect(r.map((x) => x.key)).toEqual(["acct:dhan-main", "acct:zerodha-main", "src:demo", "src:demo-delayed"]);
  });

  it("an account that is not logged in says it needs a login, not that it is backing off; a real back-off still wins", () => {
    const usage = F.usage([F.usageAccount({ id: "dhan-main", healthy: false })]);
    const [row] = C.buildRows({ usage, labels: { "dhan-main": "Dhan (main)" }, needsLogin: new Set(["dhan-main"]) });
    expect(row.health).toMatchObject({ state: "setup", word: "Log in needed" });
    expect(row.health.detail).toMatch(/Log in to Dhan \(main\) on the Accounts page/);
    const [unknown] = C.buildRows({ usage });
    expect(unknown.health.state).toBe("backoff");
    const waiting = C.buildRows({ usage: F.usage([F.usageAccount({ id: "dhan-main", healthy: false, backoffMs: 5000 })]), needsLogin: new Set(["dhan-main"]) });
    expect(waiting[0].health.state).toBe("backoff");
    expect(C.pooledRoom([{ ...row, enabled: true }]).notCounted[0].reason).toBe("it needs a login");
  });

  it("the Overview headline says what is missing when nothing that is on can answer yet", () => {
    const usage = F.usage([F.usageAccount({ id: "dhan-main", healthy: false })]);
    const rows = C.buildRows({ usage, labels: { "dhan-main": "Dhan (main)" }, needsLogin: new Set(["dhan-main"]) });
    const hero = C.heroText({ pool: C.pooledRoom(rows), tone: "calm", rows });
    expect(hero.sentence).toBe("No source is ready yet");
    expect(hero.waiting).toBe(true);
    expect(hero.detail).toMatch(/Dhan \(main\) needs a login before it can answer\. Open Accounts and log in/);
  });

  it("names an account by its label, and takes its data class from the descriptor when the Bridge lists one", () => {
    const r = C.buildRows({ sources: F.sources(), usage: F.usage(), labels: { "dhan-main": "Dhan (main)" } });
    expect(r[0].name).toBe("Dhan (main)");
    expect(r[1].name).toBe("zerodha-main");
    expect(r[0]).toMatchObject({ cls: "realtime", official: true, delaySec: 0 });
    const delayed = C.buildRows({ sources: [{ id: "dhan-main", kind: "broker", class: "delayed", delaySec: 900, official: false }], usage: F.usage() });
    expect(delayed[0]).toMatchObject({ cls: "delayed", official: false, delaySec: 900 });
  });

  it("can include the sources that are off", () => {
    const r = C.buildRows({ sources: F.sources(), usage: null, onlyEnabled: false });
    expect(r.map((x) => x.id)).toEqual(["demo", "demo-delayed", "demo-eod", "yahoo", "ext-plugin"]);
  });

  it("an account row carries its fullest data budget and the class it belongs to", () => {
    const [dhan] = rows();
    expect(dhan).toMatchObject({ cls: "realtime", official: true, health: { state: "working", word: "Working" } });
    // quote 3/10 per second (30 %), 70/600 per minute: the fullest is the second window
    expect(dhan.budget).toMatchObject({ cls: "quote", used: 3, limit: 10, per: "per second", remaining: 7 });
    expect(dhan.minute.limit).toBe(600);
    expect(dhan.minute.used).toBe(70);
  });

  it("scales a second budget to a minute when there is no minute window", () => {
    const acct = { accountId: "x", broker: "dhan", classes: { quote: { used: 2, limit: 10, window: "1s", windows: [{ window: "1s", used: 2, limit: 10, resetMs: 500 }] } } };
    const [row] = C.buildRows({ usage: { accounts: [acct] } });
    expect(row.minute).toEqual({ used: 120, limit: 600 });
  });

  it("a source's minute budget uses its documented limit and last-minute usage; a day figure is separate", () => {
    const row = rows().find((r) => r.id === "demo-delayed");
    expect(row.minute).toEqual({ used: 22, limit: 30 });
    expect(row.day).toEqual({ used: 260, limit: 1000 });
    expect(row.budget).toMatchObject({ used: 22, limit: 30, per: "per minute" });
    expect(row).toMatchObject({ cls: "delayed", delaySec: 900, official: false });
  });

  it("a perSecond-only limit becomes a minute budget", () => {
    const b = C.sourceBudgets({ limits: { perSecond: 2 }, usage: { lastMinute: 30, today: 100 } });
    expect(b.minute).toMatchObject({ limit: 120, used: 30 });
    expect(b.day).toBeNull();
  });
});

describe("health in words", () => {
  const time = (iso) => iso.slice(11, 19);
  it("off, needs a key, working, slow and paused with the next try", () => {
    expect(C.sourceHealth(F.source({ enabled: false }))).toMatchObject({ state: "off", word: "Off" });
    expect(C.sourceHealth(F.source({ enabled: false, needsKey: true, configured: false }))).toMatchObject({ state: "setup", word: "Needs a key" });
    expect(C.sourceHealth(F.source({ enabled: true, needsKey: true, configured: false }))).toMatchObject({ state: "setup", tone: "warn" });
    expect(C.sourceHealth(F.source({ enabled: true }))).toMatchObject({ state: "working", tone: "ok" });
    // The Bridge never trips a source on a refused key or a vendor limit: the kind of the last error says so.
    expect(C.sourceHealth(F.source({ enabled: true, needsKey: true, configured: true, health: { state: "ok", lastError: "HTTP 401", lastErrorKind: "auth" } }))).toMatchObject({ state: "rejected", tone: "warn", word: "Key rejected" });
    expect(C.sourceHealth(F.source({ enabled: true, health: { state: "ok", lastError: "HTTP 429", lastErrorKind: "rate-limit" } }))).toMatchObject({ state: "limited", tone: "warn" });
    expect(C.sourceHealth(F.source({ enabled: true, health: { state: "ok", lastError: "old", lastErrorKind: "none" } }))).toMatchObject({ state: "working" });
    const slow = C.sourceHealth(F.source({ enabled: true, health: { state: "degraded", lastError: "HTTP 503" } }));
    expect(slow).toMatchObject({ state: "slow", word: "Slow" });
    expect(slow.detail).toMatch(/Last error: HTTP 503\./);
    const paused = C.sourceHealth(F.source({ enabled: true, health: { state: "open", lastError: "timeout", nextTryAt: "2026-11-09T09:50:30+05:30" } }), { time });
    expect(paused).toMatchObject({ state: "paused", word: "Paused", tone: "bad" });
    expect(paused.detail).toMatch(/Trying again at 09:50:30/);
  });

  it("a broker that is backing off says who and for how long", () => {
    const h = C.accountHealth({ broker: "zerodha", classes: [{ backoffMs: 8000 }] });
    expect(h).toMatchObject({ state: "backoff", word: "Backing off" });
    expect(h.detail).toBe("Zerodha asked us to wait. Trying again in 8 s.");
    expect(C.accountHealth({ broker: "x", healthy: false, classes: [] }).state).toBe("backoff");
  });
});

describe("annotate, sort and risk", () => {
  const prep = (usageOver, at = 10_000, trackers = { tones: C.createToneTracker(), rates: C.createRateTracker() }) => {
    const rows = C.buildRows({ sources: [], usage: usageOver ?? F.usage() });
    return C.annotateRows(rows, { ...trackers, at });
  };

  it("sorts the riskiest first: at the limit, then a paused source, then busy, then calm; ties by name", () => {
    const hot = F.usageAccount({ id: "hot", quote: [10, 10, 590, 600] });
    const warm = F.usageAccount({ id: "warm", quote: [7, 10, 100, 600] });
    const rows = prep(F.usage([warm, hot, F.usageAccount({ id: "cool", quote: [1, 10, 10, 600] })]));
    const sorted = C.sortRows(rows, "risk");
    expect(sorted[0].id).toBe("hot");
    expect(sorted[0].tone).toBe("limit");
    expect(sorted[1].id).toBe("warm");
    expect(sorted[1].tone).toBe("busy");
    const names = C.sortRows(rows, "name").map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("a paused source outranks a busy one", () => {
    const rows = prep(F.usage([F.usageAccount({ id: "warm", quote: [7, 10, 100, 600] })]));
    const paused = { ...rows[0], key: "src:p", id: "p", name: "Paused feed", tone: "calm", health: { state: "paused", tone: "bad", word: "Paused" }, budget: { share: 0.1 }, forecast: { kind: "calm" } };
    expect(C.sortRows([rows[0], paused], "risk")[0].id).toBe("p");
  });

  it("sorts by least room left", () => {
    const rows = prep(F.usage([F.usageAccount({ id: "a", quote: [2, 10, 0, 600] }), F.usageAccount({ id: "b", quote: [9, 10, 0, 600] })]));
    expect(C.sortRows(rows, "room").slice(0, 2).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("the forecast follows the pace of the counters", () => {
    const trackers = { tones: C.createToneTracker(), rates: C.createRateTracker() };
    // quote 6 of 10 per second, 360 of 600 per minute used: share 60 % on the second window
    const mk = (calls) => F.usage([F.usageAccount({ id: "dhan-main", quote: [9, 10, 360, 600], calls: { quote: calls, history: 0, order: 0 } })]);
    prep(mk(1000), 0, trackers);
    const rows = prep(mk(1000 + 2 * 25), 2000, trackers);
    const dhan = rows.find((r) => r.id === "dhan-main");
    // 25 calls a second against a refill of 10 a second on the second window: 1 left, net 15/s
    expect(dhan.classRate).toBeCloseTo(25, 5);
    expect(dhan.forecast.kind).toBe("runsOut");
    expect(dhan.tone).toBe("headsup");
  });
});

describe("pooled room", () => {
  const prep = (usage, sources = F.sources()) => C.annotateRows(C.buildRows({ sources, usage }), { tones: C.createToneTracker(), rates: C.createRateTracker(), at: 0 });

  it("adds the minute room of every working account and source", () => {
    const rows = prep(F.usage());
    const pool = C.pooledRoom(rows);
    expect(pool.window).toBe("minute");
    // dhan 70/600, zerodha 12/60, demo 36/400, demo-delayed 22/30
    expect(pool.limit).toBe(600 + 60 + 400 + 30);
    expect(pool.used).toBe(70 + 12 + 36 + 22);
    expect(pool.remaining).toBe(pool.limit - pool.used);
    expect(pool.counted).toHaveLength(4);
    expect(pool.share).toBeCloseTo(140 / 1090, 5);
  });

  it("leaves out a paused source and a backing-off account, and says why", () => {
    const sources = F.sources();
    sources[1] = { ...sources[1], health: { state: "open", lastError: "timeout", nextTryAt: null } };
    const rows = prep(F.usage([F.usageAccount({ id: "dhan-main", backoffMs: 4000 }), F.usageAccount({ id: "zerodha-main", broker: "zerodha" })]), sources);
    const pool = C.pooledRoom(rows);
    expect(pool.notCounted.map((n) => [n.name, n.reason])).toEqual([["dhan-main", "it is backing off"], ["Delayed sample feed", "it is paused"]]);
    expect(pool.counted.map((c) => c.name)).toEqual(["zerodha-main", "Demo broker"]);
  });

  it("falls back to the day figure when no source has a minute budget", () => {
    const only = [{ key: "src:x", name: "X", enabled: true, configured: true, health: { state: "working" }, minute: null, day: { used: 10, limit: 100 } }];
    const pool = C.pooledRoom(only);
    expect(pool).toMatchObject({ window: "day", used: 10, limit: 100, remaining: 90 });
  });

  it("is empty when nothing states a budget", () => {
    expect(C.pooledRoom([]).window).toBeNull();
    expect(C.pooledRoom([{ key: "a", name: "A", enabled: true, configured: true, health: { state: "working" }, minute: null, day: null }]).window).toBeNull();
  });

  it("the headline is the pooled tone's sentence with the room in calls", () => {
    const rows = prep(F.usage());
    const pool = C.pooledRoom(rows);
    const text = C.heroText({ pool, tone: "calm", rows });
    expect(text.sentence).toBe("Plenty of room");
    expect(text.detail).toBe("About 950 calls of room this minute, across 4 sources.");
    expect([text.prefix, text.figure, text.suffix]).toEqual(["About ", "950", " calls of room this minute, across 4 sources."]);
    expect(C.heroText({ pool, tone: "limit", rows }).detail).toMatch(/^Only 950 calls of room left this minute/);
    expect(C.heroText({ pool: C.pooledRoom([]), tone: "calm", rows: [] }).sentence).toBe("Nothing to measure yet");
  });
});

describe("forecast sentence and attention", () => {
  const trackers = () => ({ tones: C.createToneTracker(), rates: C.createRateTracker() });
  const hotRows = () => {
    const t = trackers();
    const mk = (calls) => F.usage([F.usageAccount({ id: "dhan-main", quote: [1, 10, 540, 600], calls: { quote: calls, history: 0, order: 0 } }), F.usageAccount({ id: "zerodha-main", broker: "zerodha", quote: [1, 10, 20, 600] })]);
    C.annotateRows(C.buildRows({ sources: [], usage: mk(100) }), { ...t, at: 0 });
    return C.annotateRows(C.buildRows({ sources: [], usage: mk(100 + 2 * 14) }), { ...t, at: 2000 });
  };

  it("names the budget that runs out first, in words", () => {
    const rows = hotRows();
    const s = C.forecastSentence(rows);
    expect(s.tone).toBe("warn");
    expect(s.text).toMatch(/^At this pace the Dhan quotes budget runs out in about 15 seconds\.$/);
    expect(C.forecastSentence([]).text).toBe("At this pace: stays calm.");
    expect(C.forecastSentence([], "headsup").text).not.toMatch(/calm/);
    expect(C.forecastSentence([], "headsup").tone).toBe("warn");
  });

  it("the banner says where calls go next and that orders are safe", () => {
    const rows = hotRows();
    const [worst] = C.attentionRows(rows);
    expect(worst.id).toBe("dhan-main");
    const t = C.attentionText(worst, rows);
    expect(t.tone).toBe("warn");
    expect(t.title).toMatch(/^dhan-main: the quotes budget will be full in about/);
    expect(t.detail).toBe("New quote calls will go to zerodha-main first. Orders are not affected.");
  });

  it("an order budget at the limit does not claim orders are safe", () => {
    const rows = C.annotateRows(C.buildRows({ usage: F.usage([F.usageAccount({ id: "a", quote: [0, 10, 0, 600], order: [10, 10, 250, 250] })]) }), { ...trackers(), at: 0 });
    // the page shows the fullest DATA budget, so force the order budget the way a row can carry it
    const r = { ...rows[0], budgetClass: "order", tone: "limit", budget: { ...rows[0].budget, clsName: "Orders", resetInSec: 41 } };
    const t = C.attentionText(r, [r]);
    expect(t.tone).toBe("bad");
    expect(t.detail).not.toMatch(/Orders are not affected/);
    expect(t.detail).toMatch(/Calls will wait for room to free up\./);
    expect(t.detail).toMatch(/Room starts coming back in about 40 seconds\./);
  });

  it("a meter's spoken value carries the remaining room, the tone and the forecast", () => {
    const rows = hotRows();
    const dhan = rows.find((r) => r.id === "dhan-main");
    expect(C.meterSpeech(dhan)).toBe("60 of 600 calls left per minute, heads up, runs out in about 15 seconds");
  });
});

describe("recent requests and trace", () => {
  it("reads a path as a question to the router", () => {
    expect(C.capabilityForPath("/v1/ltp?symbols=A")).toBe("quotes");
    expect(C.capabilityForPath("/v1/quotes")).toBe("quotes");
    expect(C.capabilityForPath("/v1/history")).toBe("history");
    expect(C.capabilityForPath("/v1/optionchain")).toBe("optionChain");
    expect(C.capabilityForPath("/v1/expiries")).toBe("expiries");
    expect(C.capabilityForPath("/v1/orders")).toBeNull();
  });

  it("says what the router did when the log knows, and only the status when it does not", () => {
    const [stream, cache, delayed, refused, noRoute] = F.requests();
    expect(C.requestVerdict(stream).text).toBe("Answered from the live stream");
    expect(C.requestVerdict(cache).text).toBe("Served from cache");
    expect(C.requestVerdict(delayed)).toMatchObject({ text: "Used Yahoo, delayed 15 min", tone: "info" });
    expect(C.requestVerdict(refused)).toMatchObject({ text: "Held back: over a limit", tone: "warn" });
    expect(C.requestVerdict(noRoute)).toMatchObject({ text: "Answered", known: false });
    expect(C.requestVerdict({ status: 200, route: { from: "live", sourceName: "Dhan", class: "realtime" } }).text).toBe("Answered from Dhan");
    expect(C.requestVerdict({ status: 200, route: { from: "live", sourceName: "Alpha", class: "eod" } }).text).toBe("Used Alpha, end of day data");
    expect(C.requestVerdict({ status: 200, route: { from: "stale" } }).tone).toBe("warn");
    expect(C.requestVerdict({ status: 503 })).toMatchObject({ text: "Failed", tone: "bad" });
    expect(C.requestVerdict({ status: 403 }).text).toBe("Refused (403)");
  });

  it("builds the trace query and reads symbols", () => {
    expect(C.parseSymbols(" nse:reliance, NSE:TCS nse:reliance ")).toEqual(["NSE:RELIANCE", "NSE:TCS"]);
    expect(C.traceQuery({ capability: "history", symbols: ["NSE:TCS"], purpose: "analysis" })).toBe("capability=history&symbols=NSE%3ATCS&purpose=analysis");
    expect(C.traceQuery({ maxAgeMs: 1500.4 })).toBe("capability=quotes&purpose=display&maxAgeMs=1500");
  });

  it("spells out bare reason tokens and tidies sentences", () => {
    expect(C.reasonText("best-score")).toBe("It had the most room and the best record.");
    expect(C.reasonText("no_spare_budget")).toBe("It has no room left right now.");
    expect(C.reasonText("something-new")).toBe("Something new.");
    expect(C.reasonText("its data is late")).toBe("Its data is late.");
    expect(C.reasonText("Already a sentence.")).toBe("Already a sentence.");
    expect(C.reasonText("")).toBe("");
  });

  it("turns a trace into a headline, a detail and ordered steps", () => {
    const names = { "dhan-main": "Dhan", "zerodha-main": "Zerodha", "demo-delayed": "Yahoo", yahoo: "Yahoo (off)" };
    const m = C.traceModel(F.trace(), (id) => names[id] ?? id);
    expect(m.headline).toBe("Would be answered from Dhan.");
    expect(m.detail).toBe("Real-time sources are preferred for quotes. If it fails, Zerodha is next.");
    expect(m.steps.map((s) => [s.name, s.verdict, s.glyph, s.word])).toEqual([
      ["Dhan", "chosen", "check", "Chosen"],
      ["Zerodha", "fallback", "arrow", "Next in line"],
      ["Yahoo", "skipped", "skip", "Not used"],
      ["Yahoo (off)", "skipped", "skip", "Not used"],
    ]);
    expect(m.steps[0].spare).toBe("88% of its room free");
    expect(m.steps[3].health).toBe("Off");
  });

  it("a delayed choice is never worded as a live answer, and no choice says so", () => {
    const delayed = { class: "delayed", considered: [{ id: "y", verdict: "chosen", reason: "best-score" }] };
    expect(C.traceModel(delayed, () => "Yahoo").headline).toBe("Would use Yahoo, delayed.");
    expect(C.traceModel({ class: "eod", considered: [{ id: "y", verdict: "chosen" }] }, () => "Alpha").headline).toBe("Would use Alpha, end of day data.");
    expect(C.traceModel({ considered: [{ id: "y", verdict: "skipped", reason: "disabled" }] }).headline).toBe("No source can answer this right now.");
    expect(C.traceModel(null).steps).toEqual([]);
  });
});

describe("quota presets and validation", () => {
  const def = { perSecond: 10, burst: 20 };
  const presets = C.quotaPresets(def, 2);

  it("scales Light, Normal and Heavy from the default", () => {
    expect(presets.map((p) => p.id)).toEqual(["light", "normal", "heavy"]);
    expect(presets[0].values).toEqual({ perSecond: 2.5, burst: 5, weight: 1, perDay: null });
    expect(presets[1].values).toEqual({ perSecond: 10, burst: 20, weight: 2, perDay: null });
    expect(presets[2].values).toEqual({ perSecond: 30, burst: 60, weight: 4, perDay: null });
  });

  it("keeps presets inside the limits even for a tiny default", () => {
    for (const p of C.quotaPresets({ perSecond: 1, burst: 1 }, 1)) {
      expect(C.validateQuota(p.values).ok, p.id).toBe(true);
    }
  });

  it("matches the values to a preset, else custom", () => {
    expect(C.matchPreset(presets[2].values, presets)).toBe("heavy");
    expect(C.matchPreset({ perSecond: 10, burst: 20, weight: 2, perDay: null }, presets)).toBe("normal");
    expect(C.matchPreset({ perSecond: 10, burst: 20, weight: 2, perDay: 500 }, presets)).toBe("custom");
  });

  it("accepts good values and returns the body to send", () => {
    expect(C.validateQuota({ perSecond: "5", burst: "10", weight: "2", perDay: "" })).toEqual({ ok: true, body: { perSecond: 5, burst: 10, weight: 2, perDay: null } });
    expect(C.validateQuota({ perSecond: 2.5, burst: 5, weight: 1, perDay: "20000" }).body.perDay).toBe(20000);
  });

  it("says what is wrong in plain words, field by field", () => {
    const bad = C.validateQuota({ perSecond: "", burst: "0", weight: "1.5", perDay: "-3" });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(["burst", "perDay", "perSecond", "weight"]);
    expect(bad.errors.perSecond).toMatch(/more than 0/);
    expect(C.validateQuota({ perSecond: 5000, burst: 10, weight: 1 }).errors.perSecond).toMatch(/more than the Bridge allows/);
    expect(C.validateQuota({ perSecond: 10, burst: 5, weight: 1 }).errors.burst).toMatch(/at least the calls per second/);
    expect(C.validateQuota({ perSecond: 10, burst: 10, weight: 500 }).errors.weight).toMatch(/100 or less/);
    expect(C.validateQuota({ perSecond: 10, burst: 10, weight: 1, perDay: "abc" }).errors.perDay).toMatch(/no daily cap/);
  });

  it("sorts the keys with the most throttled and the busiest first", () => {
    expect(C.sortKeys(F.quotas().keys).map((k) => k.keyId)).toEqual(["key_excel", "key_bot", "key_dash", "key_ai"]);
  });

  it("describes a key and where its numbers come from", () => {
    const [bot, excel] = F.quotas().keys;
    expect(C.quotaLine(bot)).toBe("10 a second, up to 20 at once");
    expect(C.quotaLine(excel)).toBe("5 a second, up to 10 at once, 20000 a day");
    expect(C.dayShare(excel)).toBeCloseTo(0.92, 5);
    expect(C.dayShare(bot)).toBeNull();
    expect(C.quotaSourceText("override")).toBe("Custom for this key");
    expect(C.kindLabel("mcp")).toBe("AI assistant");
    expect(C.kindLabel("something")).toBe("Something");
  });
});

describe("pooling", () => {
  it("reads the consent, the groups and the notice", () => {
    const off = C.poolingModel(F.pooling());
    expect(off).toMatchObject({ on: false, inPoolCount: 0, canPool: true });
    expect(off.groups[0].accounts.map((a) => [a.id, a.policy, a.choosable])).toEqual([["dhan-main", "unknown", true], ["zerodha-main", "unknown", true], ["angel-main", "not-allowed", false]]);
    expect(off.notice.version).toBe("pool-1");
    const on = C.poolingModel(F.pooling({ on: true }));
    expect(on).toMatchObject({ on: true, inPoolCount: 2 });
    expect(C.poolingModel(null)).toMatchObject({ on: false, groups: [], canPool: false });
  });

  it("shows the label the person gave each account, and the id when there is none", () => {
    const m = C.poolingModel(F.pooling());
    expect(m.groups[0].accounts.map((a) => a.label)).toEqual(["Dhan (main)", "Zerodha (family)", "angel-main"]);
    const blank = C.poolingModel({ groups: [{ holder: "A", accounts: [{ id: "a-1", label: "   ", broker: "dhan" }, { id: "a-2", broker: "dhan" }] }] });
    expect(blank.groups[0].accounts.map((a) => a.label)).toEqual(["a-1", "a-2"]);
  });

  it("says what the automatic fallback switch means in each state, never pointing at a config file to edit", () => {
    expect(C.fallbackHintText({ on: false, source: "default", anySourceOn: false })).toMatch(/^Off\./);
    expect(C.fallbackHintText({ on: true, source: "setting", anySourceOn: false })).toMatch(/no free source is turned on/);
    expect(C.fallbackHintText({ on: true, source: "setting", anySourceOn: true })).toMatch(/sources you turned on/);
    expect(C.fallbackHintText({ on: true, source: "config", anySourceOn: true })).toMatch(/replaces that setting/);
    for (const on of [true, false]) expect(C.fallbackHintText({ on, source: "default", anySourceOn: true })).not.toMatch(/set sources\.autoFallback/);
  });

  it("a single account or a group with only one choosable account cannot be pooled", () => {
    const one = C.poolingModel({ groups: [{ holder: "A", accounts: [{ id: "a", broker: "dhan", poolingPolicy: "allowed" }, { id: "b", broker: "x", poolingPolicy: "not-allowed" }] }] });
    expect(one.canPool).toBe(false);
  });

  it("the consent needs two accounts of one holder and a tick", () => {
    const { groups } = C.poolingModel(F.pooling());
    expect(C.consentProblem({ ticked: true, chosen: ["dhan-main"], groups })).toMatch(/at least two/);
    expect(C.consentProblem({ ticked: false, chosen: ["dhan-main", "zerodha-main"], groups })).toMatch(/Tick the box/);
    expect(C.consentProblem({ ticked: true, chosen: ["dhan-main", "zerodha-main"], groups })).toBeNull();
    const two = [...groups, { holder: "Someone else", accounts: [{ id: "z", broker: "x", policy: "allowed", inPool: false, choosable: true }] }];
    expect(C.consentProblem({ ticked: true, chosen: ["dhan-main", "z"], groups: two })).toMatch(/one person only/);
  });
});

describe("provider cards", () => {
  const time = (iso) => iso.slice(11, 19);
  it("an opt-in source that is off asks for the notice; a byok source with no key asks for the key", () => {
    const [, delayed, eod, yahoo, plugin] = F.sources();
    expect(C.providerState({ ...delayed, enabled: false }).action).toBe("notice");
    expect(C.providerState(yahoo).action).toBe("notice");
    expect(C.providerState(eod).action).toBe("key");
    expect(C.providerState({ ...eod, configured: true }).action).toBe("enable");
    expect(C.providerState(plugin)).toMatchObject({ action: "none", canSwitch: false });
    expect(C.providerState(delayed)).toMatchObject({ on: true, action: "none", canSwitch: true, state: "working" });
  });

  it("an ejected source gives the reason and the next try", () => {
    const ejected = F.source({ enabled: true, health: { state: "open", lastError: "HTTP 503", nextTryAt: "2026-11-09T09:50:30+05:30" } });
    const p = C.providerState(ejected, { time });
    expect(p).toMatchObject({ state: "paused", word: "Paused" });
    expect(p.detail).toMatch(/Last error: HTTP 503\. Trying again at 09:50:30\./);
  });

  it("lists what must happen before a source turns on", () => {
    const [, delayed, eod, yahoo] = F.sources();
    expect(C.enableSteps({ ...delayed, enabled: false })).toEqual(["notice"]);
    expect(C.enableSteps(eod)).toEqual(["key"]);
    expect(C.enableSteps({ ...yahoo, needsKey: true, configured: false })).toEqual(["key", "notice"]);
    expect(C.tierText("byok")).toBe("Needs your own key");
  });
});

describe("plain words for quotas and tiers", () => {
  it("says a fair share in parts and a tier chip without a version string", () => {
    expect(C.fairShare(1, 4)).toBe("Fair share: 1 of 4 parts");
    expect(C.fairShare(3, 3)).toBe("Fair share: all of it");
    expect(C.tierChipText({ tier: "opt-in", enabled: true, consent: { acceptedAt: "2026-11-08T10:00:00Z" } })).toBe("Notice accepted 8 Nov");
    expect(C.tierChipText({ tier: "opt-in", enabled: true })).toBe("Notice accepted");
    expect(C.tierChipText({ tier: "opt-in", enabled: false })).toBe("Off until you accept a notice");
    expect(C.tierChipText({ tier: "byok", enabled: true })).toBe("Needs your own key");
  });
});

describe("trace reasons without API jargon", () => {
  it("says the backup rule in words", () => {
    const t = C.reasonText("backup sources are not used for this read (ask with backup=true, or turn on automatic fallback)");
    expect(t).not.toMatch(/backup=/);
    expect(t).toMatch(/automatic fallback/);
    expect(C.reasonText("best-score")).toBe("It had the most room and the best record.");
  });
});

describe("a switch you just made", () => {
  const rows = () => [{ id: "a", enabled: false, health: { state: "disabled" } }, { id: "b", enabled: true, health: { state: "ok" } }];

  it("shows the new state at once, even while the Bridge still reports the old one", () => {
    C.rememberSwitch("a", true, 1000);
    const [a, b] = C.withSwitches(rows(), 1100);
    expect(a).toMatchObject({ enabled: true, health: { state: "ok" } });
    expect(b).toEqual(rows()[1]);
    C.rememberSwitch("b", false, 1000);
    expect(C.withSwitches(rows(), 1100)[1]).toMatchObject({ enabled: false, health: { state: "disabled" } });
    C.forgetSwitch("a");
    C.forgetSwitch("b");
  });

  it("lets go once the Bridge agrees, and corrects itself when the Bridge still disagrees after the grace", () => {
    C.rememberSwitch("a", true, 1000);
    const agreed = [{ id: "a", enabled: true, health: { state: "ok" } }];
    expect(C.withSwitches(agreed, 1200)).toEqual(agreed);
    // Agreement forgot the switch: a later disagreement is the Bridge's own news.
    expect(C.withSwitches(rows(), 1300)[0].enabled).toBe(false);

    C.rememberSwitch("a", true, 1000);
    expect(C.withSwitches(rows(), 1000 + C.SWITCH_GRACE_MS + 1)[0].enabled).toBe(false);
    expect(C.withSwitches(rows(), 1000 + C.SWITCH_GRACE_MS + 2)[0].enabled).toBe(false);
  });

  it("passes a missing list through", () => {
    expect(C.withSwitches(null)).toBeNull();
  });
});
