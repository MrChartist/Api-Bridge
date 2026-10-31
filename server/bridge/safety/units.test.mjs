/**
 * Small units of S9: the sliding order-rate window, the daily counters file, the kill-switch store, IST helpers
 * and atomic state files.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDailyCounters } from "./dailyCounters.mjs";
import { createKillSwitchStore } from "./killSwitch.mjs";
import { createOrderRateWindow, windowFor } from "./orderRate.mjs";
import { readJsonState, writeJsonState } from "./stateFile.mjs";
import { endOfIstDay, isDayString, istDay, istIso } from "./time.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "mcb-s9u-"));

describe("orderRate", () => {
  it("windowFor handles whole, fractional and sub-1 rates", () => {
    expect(windowFor(5)).toEqual({ n: 5, windowMs: 1000 });
    expect(windowFor(2.5)).toEqual({ n: 2, windowMs: 800 });
    expect(windowFor(0.5)).toEqual({ n: 1, windowMs: 2000 });
    expect(windowFor(0)).toEqual({ n: 1, windowMs: 1000 });
  });

  it("never allows more than n in any sliding window, even across a second boundary", () => {
    const w = createOrderRateWindow();
    let t = 10_000;
    const granted = [];
    // 1,000 attempts every 7 ms.
    for (let i = 0; i < 1000; i += 1, t += 7) if (w.acquire("a", 5, t).ok) granted.push(t);
    for (let i = 5; i < granted.length; i += 1) expect(granted[i] - granted[i - 5]).toBeGreaterThanOrEqual(1000);
    expect(granted.length).toBeGreaterThan(30);
  });

  it("reports retryAfterMs and keeps accounts separate", () => {
    const w = createOrderRateWindow();
    w.acquire("a", 2, 0);
    w.acquire("a", 2, 300);
    expect(w.acquire("a", 2, 400)).toMatchObject({ ok: false, retryAfterMs: 600 });
    expect(w.peek("a", 2, 1000)).toMatchObject({ ok: true });
    expect(w.acquire("b", 2, 400).ok).toBe(true);
    expect(w.countLastSecond("a", 999)).toBe(2);
  });
});

describe("dailyCounters", () => {
  it("records per mode, persists, and rolls at IST midnight but never backwards", () => {
    const dir = tmp();
    const clock = { t: Date.UTC(2026, 9, 19, 10) };
    const c = createDailyCounters({ dir, now: () => clock.t });
    c.record("a", "live", { action: "place", realisedPnl: -12.346 });
    c.record("a", "live", { action: "cancel" });
    c.record("a", "paper", { action: "modify" });
    expect(c.get("a", "live")).toEqual({ orders: 1, modifies: 0, cancels: 1, realisedPnl: -12.35, refused: 0 });
    const again = createDailyCounters({ dir, now: () => clock.t });
    expect(again.get("a", "paper").modifies).toBe(1);
    expect(again.loadedFrom).toBe("ok");
    clock.t -= 24 * 3_600_000;
    expect(again.get("a", "live").orders).toBe(1); // clock went back: same day kept
    clock.t += 48 * 3_600_000;
    expect(again.get("a", "live").orders).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "counters.json"), "utf8")).day).toBe("2026-10-20");
  });

  it("reports a corrupt file and keeps a copy", () => {
    const dir = tmp();
    writeFileSync(join(dir, "counters.json"), "{{");
    const c = createDailyCounters({ dir, now: () => Date.now() });
    expect(c.loadedFrom).toBe("corrupt");
    expect(readdirSync(dir)).toContain("counters.json.corrupt");
  });
});

describe("killSwitch store", () => {
  it("is off when missing, engaged when malformed, and persists", () => {
    const dir = tmp();
    const ks = createKillSwitchStore({ dir });
    expect(ks.loadedFrom).toBe("missing");
    expect(ks.state().engaged).toBe(false);
    expect(ks.engage({ reason: "r", by: "key:k", at: "t" })).toMatchObject({ changed: true, persisted: true });
    expect(createKillSwitchStore({ dir }).state()).toEqual({ engaged: true, reason: "r", by: "key:k", at: "t" });
    ks.release();
    expect(createKillSwitchStore({ dir }).state().engaged).toBe(false);

    const d2 = tmp();
    writeFileSync(join(d2, "kill-switch.json"), JSON.stringify({ hello: 1 }));
    const bad = createKillSwitchStore({ dir: d2 });
    expect(bad.loadedFrom).toBe("corrupt");
    expect(bad.state().engaged).toBe(true);
  });

  it("stays engaged when the release cannot be written", () => {
    const dir = tmp();
    const ks = createKillSwitchStore({ dir: join(dir, "sub") });
    ks.engage({ reason: "r", by: "b", at: "t" });
    // Replace the directory with a file so the write fails.
    const blocked = createKillSwitchStore({ dir: join(dir, "file-not-dir") });
    writeFileSync(join(dir, "file-not-dir"), "x");
    expect(() => blocked.release()).toThrow();
    expect(ks.state().engaged).toBe(true);
  });
});

describe("time and state files", () => {
  it("IST helpers", () => {
    expect(istDay(Date.UTC(2026, 9, 19, 18, 29))).toBe("2026-10-19");
    expect(istDay(Date.UTC(2026, 9, 19, 18, 30))).toBe("2026-10-20");
    expect(istIso(Date.UTC(2026, 9, 19, 4, 30))).toBe("2026-10-19T10:00:00.000+05:30");
    expect(endOfIstDay(Date.UTC(2026, 9, 19, 4, 30))).toBe(Date.UTC(2026, 9, 19, 18, 30));
    expect(isDayString("2026-02-29")).toBe(false);
    expect(isDayString("2028-02-29")).toBe(true);
  });

  it("writes atomically with no temp files left behind", () => {
    const dir = tmp();
    const p = join(dir, "deep", "x.json");
    writeJsonState(p, { a: 1 });
    writeJsonState(p, { a: 2 });
    expect(readJsonState(p)).toEqual({ status: "ok", value: { a: 2 } });
    expect(readdirSync(join(dir, "deep"))).toEqual(["x.json"]);
    mkdirSync(join(dir, "arr"));
    writeFileSync(join(dir, "arr", "y.json"), "[1]");
    expect(readJsonState(join(dir, "arr", "y.json")).status).toBe("corrupt");
    expect(readJsonState(join(dir, "none.json")).status).toBe("missing");
  });
});
