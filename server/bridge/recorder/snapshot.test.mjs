/**
 * Snapshot builder (docs/spec/p1-01-recorder.md §6.3–6.6): parity forward example, fewer than 3 two-sided strikes,
 * ATM tie rule and straddle, the §6.5 IV/Δ/Γ example through dashboard/pricing.js in calendar mode, missing legs,
 * ages, the columnar layout and field projection.
 */
import { describe, expect, it } from "vitest";
import { clockSettings } from "../vol/config.mjs";
import { buildClockContext } from "../vol/context.mjs";
import { atmOf, buildSnapshot, forwardOf, gapRecord, legGreeks, projectSnapshot, straddleOf } from "./snapshot.mjs";

const IST = (s) => Date.parse(`${s}+05:30`);
/** Thu 29 Oct 2026 15:30 IST → Tue 3 Nov 2026 15:30: calendar T = 5/365. */
const TS = IST("2026-10-29T15:30:00");
const EXPIRY = "2026-11-03";
const RATE = 0.065;
const calendarClock = buildClockContext({ settings: clockSettings({ vol: { clock: { mode: "calendar" } } }), session: { open: "09:15", close: "15:30" } });

const two = (mid) => ({ bid: Math.round((mid - 0.5) * 100) / 100, ask: Math.round((mid + 0.5) * 100) / 100, ltp: mid });
/** §6.3 table: C_mid − P_mid per strike; §6.4: C 148.6 and P 126.3 at 25,150. */
const DIFFS = { 25050: 121.4, 25100: 71.0, 25150: 22.3, 25200: -27.6, 25250: -78.9 };
function exampleRows() {
  const rows = Object.entries(DIFFS).map(([k, d]) => {
    const strike = Number(k);
    const p = strike === 25150 ? 126.3 : 120 + (strike - 25150) / 2;
    const c = strike === 25150 ? 148.6 : p + d;
    return { strike, ce: { ...two(c), oi: 1000 * 75, volume: 50 * 75, bidQty: 750, askQty: 1500, at: TS - 400 }, pe: { ...two(p), oi: 900 * 75, volume: 40 * 75, at: TS - 1200 } };
  });
  // Far strikes with one-sided quotes do not enter the forward.
  rows.unshift({ strike: 24750, ce: { ltp: 410, bid: null, ask: null, oi: 75, at: TS }, pe: { ltp: 18.5, bid: 18.4, ask: null, oi: 150, at: TS } });
  rows.push({ strike: 25550, ce: null, pe: null });
  return rows;
}

describe("forward, ATM and straddle (§6.3, §6.4)", () => {
  it("§6.3: median of K + e^(rT)(C − P) over the 5 two-sided strikes nearest spot = 25,171.51", () => {
    const F = forwardOf(exampleRows(), { spot: 25150.35, rate: RATE, tcal: 5 / 365 });
    expect(Math.round(F * 100) / 100).toBe(25171.51);
  });
  it("fewer than 3 two-sided strikes → null (no fallback)", () => {
    const rows = exampleRows().map((r) => (r.strike === 25150 || r.strike === 25200 || r.strike === 25250 ? { ...r, pe: { ltp: 10 } } : r));
    expect(forwardOf(rows, { spot: 25150, rate: RATE, tcal: 5 / 365 })).toBeNull();
  });
  it("§6.4: ATM = strike nearest F (lower on a tie); straddle = C_mid + P_mid", () => {
    const k = [25100, 25150, 25200];
    expect(atmOf(k, 25171.51)).toBe(25150);
    expect(atmOf(k, 25175)).toBe(25150);
    expect(atmOf(k, 25175.01)).toBe(25200);
    expect(atmOf([], 1)).toBeNull();
    expect(straddleOf(exampleRows(), 25150)).toBeCloseTo(274.9, 9);
  });
  it("straddle uses the LTP when a mid is missing, null when a side has neither", () => {
    const rows = [{ strike: 100, ce: { ltp: 5 }, pe: { bid: 4, ask: 6 } }];
    expect(straddleOf(rows, 100)).toBe(10);
    expect(straddleOf([{ strike: 100, ce: { ltp: 5 }, pe: { oi: 10 } }], 100)).toBeNull();
  });
});

describe("§6.5 Black-76 IV, Δ, Γ through pricing.js (calendar mode)", () => {
  const F = 25171.51;
  const t = 5 / 365;
  const df = Math.exp(-RATE * t);
  it("C_mid 148.6 → IV 11.72 %, Δ_C 0.5271, Γ 0.001151; P_mid 126.3 → IV 11.65 %, Δ_P −0.4720", () => {
    const c = legGreeks({ bid: 148.1, ask: 149.1 }, { forward: F, strike: 25150, right: "CE", t, df });
    const p = legGreeks({ bid: 125.8, ask: 126.8 }, { forward: F, strike: 25150, right: "PE", t, df });
    expect(Math.abs(c.iv - 11.72)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(p.iv - 11.65)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(c.d - 0.5271)).toBeLessThanOrEqual(0.0005);
    expect(Math.abs(c.g - 0.001151) / 0.001151).toBeLessThanOrEqual(0.01);
    // Δ_P at σ = 11.72 % (the spec's single-σ figure): −df·N(−d1).
    const pAtC = legGreeks({ ltp: 0 }, { forward: F, strike: 25150, right: "PE", t, df });
    expect(pAtC.iv).toBeNull();
    expect(Math.abs(p.d - -0.472)).toBeLessThanOrEqual(0.002);
  });
  it("a price below discounted intrinsic has no IV", () => {
    expect(legGreeks({ ltp: 10 }, { forward: F, strike: 25000, right: "CE", t, df })).toEqual({ iv: null, d: null, g: null });
  });
});

describe("buildSnapshot", () => {
  const base = { u: "NIFTY", x: EXPIRY, ex: "NFO", slot: TS - 2000, ts: TS, source: "stream", accountId: "dhan-main", broker: "dhan", quality: "live", oiUnitVerified: true, lot: 75, spot: 25150.35 };
  it("columnar record with forward, ATM, straddle, rate, T and IVs (§3.3)", () => {
    const s = buildSnapshot({ ...base, rows: exampleRows() }, { clock: calendarClock, rate: RATE });
    expect(s).toMatchObject({ v: 1, kind: "snap", u: "NIFTY", x: EXPIRY, slot: TS - 2000, ts: TS, source: "stream", accounts: null, quality: "live", fwd: 25171.51, atm: 25150, straddle: 274.9, rate: 0.065, t: 0.013699, tcal: 0.013699, model: "b76-vt1", oiUnit: "units", lot: 75 });
    expect(s.k).toEqual([24750, 25050, 25100, 25150, 25200, 25250, 25550]);
    for (const side of [s.ce, s.pe]) expect(Object.keys(side)).toEqual(["ltp", "bid", "ask", "bq", "aq", "oi", "vol", "iv", "d", "g", "age"]);
    const i = s.k.indexOf(25150);
    expect(Math.abs(s.ce.iv[i] - 11.72)).toBeLessThanOrEqual(0.01);
    expect(s.ce.bq[i]).toBe(750);
    expect(s.pe.bq[i]).toBeNull();
    expect(s.ce.age[i]).toBe(400);
    expect(s.pe.age[i]).toBe(1200);
  });
  it("missing legs stay null and count; > 5 % missing or no forward → partial", () => {
    const s = buildSnapshot({ ...base, rows: exampleRows() }, { clock: calendarClock, rate: RATE });
    const last = s.k.length - 1;
    expect(s.ce.ltp[last]).toBeNull();
    expect(s.ce.oi[last]).toBeNull();
    expect(s.ce.age[last]).toBeNull();
    expect(s.missingLegs).toBe(2);
    expect(s.partial).toBe(true); // 2 of 14 legs > 5 %
    const full = buildSnapshot({ ...base, rows: exampleRows().slice(0, -1) }, { clock: calendarClock, rate: RATE });
    expect(full).toMatchObject({ missingLegs: 0, partial: false });
    const planned = buildSnapshot({ ...base, rows: exampleRows().slice(0, -1), plannedLegs: 40 }, { clock: calendarClock, rate: RATE });
    expect(planned.missingLegs).toBe(28);
    const noFwd = buildSnapshot({ ...base, rows: exampleRows().slice(0, 3) }, { clock: calendarClock, rate: RATE });
    expect(noFwd).toMatchObject({ fwd: null, partial: true });
    expect(noFwd.ce.iv.every((v) => v === null)).toBe(true);
    expect(noFwd.atm).toBe(25100); // nearest spot when there is no forward
  });
  it("without a clock (expired chain) IV is null, raw prices kept", () => {
    const s = buildSnapshot({ ...base, x: "2026-10-27", rows: exampleRows() }, { clock: calendarClock, rate: RATE });
    expect(s.t).toBeNull();
    expect(s.ce.iv.every((v) => v === null)).toBe(true);
    expect(s.ce.ltp.some((v) => v !== null)).toBe(true);
  });
  it("projection keeps the requested fields and strikes around ATM", () => {
    const s = buildSnapshot({ ...base, rows: exampleRows() }, { clock: calendarClock, rate: RATE });
    const p = projectSnapshot(s, { fields: ["oi", "ltp"], strikesEach: 1 });
    expect(p.k).toEqual([25100, 25150, 25200]);
    expect(Object.keys(p.ce)).toEqual(["oi", "ltp"]);
    expect(p.ce.oi).toEqual([75000, 75000, 75000]);
    expect(projectSnapshot(s, { fields: ["volume"] }).ce.vol).toHaveLength(7);
  });
  it("gap records carry the slot and a reason", () => {
    expect(gapRecord({ u: "NIFTY", x: EXPIRY, slot: 1, reason: "stream-down", detail: "Feed stale for 74 s" })).toEqual({ v: 1, kind: "gap", u: "NIFTY", x: EXPIRY, slot: 1, reason: "stream-down", detail: "Feed stale for 74 s" });
  });
});
