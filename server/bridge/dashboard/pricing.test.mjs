/**
 * The pricing core (docs/spec/p1-03-pricing-vol.md §6, §9.1): every worked example as a reference-value test.
 * Holidays here are fixtures, not claims about the real calendar.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as O from "./options.js";
import {
  atmIvAt,
  bands,
  black76,
  calendarYears,
  clockSettings,
  constantMaturity,
  convertIv,
  greeks76,
  impliedVolB76,
  ivRank,
  legIv,
  parityForward,
  parkinsonVol,
  realisedVol,
  sameDteRows,
  smilePoints,
  volTime,
  yangZhangVol,
  yearBasisOf,
} from "./pricing.js";

const SESSION = { open: "09:15", close: "15:30" };
const CTX = { mode: "weighted", nonTradingDayWeight: 0.15, overnightShare: 0.2, settlementWindowMinutes: 30, session: SESSION };
const at = (s) => Date.parse(`${s}+05:30`);
const EXP = "2026-11-03"; // Tue
const RATE = 0.065;
const tick = (p) => Math.round(p / 0.05) * 0.05;
/** ATM call (F = K = 25,150, σ = 12 %) discounted on calendar time and rounded to the 0.05 tick. */
const atmCall = (c) => tick(Math.exp(-RATE * c.Tcal) * black76(25150, 25150, c.T, 12, "CE"));

describe("vol-time clock (§6.1)", () => {
  it("defaults: Y = 252 + 113 × 0.15 = 268.95", () => {
    expect(yearBasisOf(CTX)).toBeCloseTo(268.95, 10);
    expect(yearBasisOf({ ...CTX, mode: "trading" })).toBe(252);
    expect(yearBasisOf({ ...CTX, mode: "calendar" })).toBe(365);
    expect(yearBasisOf({ ...CTX, yearBasis: 250 })).toBe(250);
    expect(clockSettings({})).toMatchObject({ mode: "weighted", nonTradingDayWeight: 0.15, overnightShare: 0.2, settlementWindowMinutes: 30 });
    expect(clockSettings({ settlementWindowMinutes: 0 }).settlementWindowMinutes).toBe(0);
  });

  it("a context without settlementWindowMinutes keeps the 30-minute window (expiry day, example 4 rows)", () => {
    const { settlementWindowMinutes, ...noW } = CTX;
    expect(settlementWindowMinutes).toBe(30);
    for (const [s, u] of [["2026-11-03T14:00:00", 0.14933], ["2026-11-03T15:00:00", 0.02133], ["2026-11-03T15:20:00", 0.00079]]) {
      const c = volTime(noW, at(s), EXP);
      expect(c.units).toBeCloseTo(u, 5);
      expect(c.T).toBe(volTime(CTX, at(s), EXP).T);
    }
  });

  it("example 1: Thu 29 Oct 10:00 → Tue 3 Nov, U = 3.96133 with the block breakdown", () => {
    const c = volTime(CTX, at("2026-10-29T10:00:00"), EXP, { parts: true });
    expect(c.units).toBeCloseTo(3.96133, 5);
    expect(c.T).toBeCloseTo(0.0147289, 7);
    expect(c.Tcal).toBeCloseTo(0.0143265, 7);
    expect(c.Ttd).toBeCloseTo(0.0151852, 7);
    expect(c.unitsTrading).toBeCloseTo(3.82667, 5);
    const byDay = {};
    for (const p of c.parts) byDay[p.date] = (byDay[p.date] ?? 0) + p.units;
    expect(byDay["2026-10-29"]).toBeCloseTo(0.704, 6);
    expect(byDay["2026-10-30"]).toBeCloseTo(1.0, 6);
    expect(byDay["2026-11-02"]).toBeCloseTo(1.3, 6);
    expect(byDay["2026-11-03"]).toBeCloseTo(0.957333, 6);
    expect(c.parts.find((p) => p.date === "2026-11-02" && p.kind === "gap").units).toBeCloseTo(0.5, 10);
  });

  it("example 2: Friday → Monday, T does not move while the market is shut", () => {
    const rows = [
      ["2026-10-30T15:29:00", 2.25947, 0.0084011, 0.0109608],
      ["2026-10-30T15:30:00", 2.25733, 0.0083931, 0.0109589],
      ["2026-10-31T12:00:00", 2.25733, 0.0083931, 0.0086187],
      ["2026-11-02T09:14:00", 2.25733, 0.0083931, 0.0034551],
      ["2026-11-02T09:16:00", 1.7552, 0.0065261, 0.0034513],
    ];
    for (const [s, U, T, Tcal] of rows) {
      const c = volTime(CTX, at(s), EXP);
      expect(c.units).toBeCloseTo(U, 5);
      expect(c.T).toBeCloseTo(T, 7);
      expect(c.Tcal).toBeCloseTo(Tcal, 7);
    }
    // σ = 12 % held fixed: the weighted clock recovers 12.00 % on both sides of the weekend; ACT/365 does not.
    const fri = volTime(CTX, at("2026-10-30T15:29:00"), EXP);
    const mon = volTime(CTX, at("2026-11-02T09:16:00"), EXP);
    expect(atmCall(fri)).toBeCloseTo(110.3, 6);
    // The spec table prints 97.20; Black-76 at these inputs rounds to 97.25 (the IVs below match the spec either way).
    expect(atmCall(mon)).toBeCloseTo(97.25, 6);
    for (const c of [fri, mon]) {
      const df = Math.exp(-RATE * c.Tcal);
      expect(impliedVolB76(atmCall(c), 25150, 25150, c.T, "CE", df)).toBeCloseTo(12.0, 2);
    }
    expect(impliedVolB76(atmCall(fri), 25150, 25150, fri.Tcal, "CE", Math.exp(-RATE * fri.Tcal))).toBeCloseTo(10.51, 2);
    expect(impliedVolB76(atmCall(mon), 25150, 25150, mon.Tcal, "CE", Math.exp(-RATE * mon.Tcal))).toBeCloseTo(16.5, 1);
  });

  it("example 3: long weekend with a fixture holiday (Mon 9 Nov)", () => {
    const c = volTime({ ...CTX, holidays: ["2026-11-09"] }, at("2026-11-06T15:00:00"), "2026-11-10");
    expect(c.units).toBeCloseTo(1.47133, 5);
    expect(c.T).toBeCloseTo(0.0054707, 7);
    expect(c.Tcal).toBeCloseTo(0.011016, 7);
    // An isTradingDay function (the server's reference calendar) gives the same answer.
    const fn = (d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && d !== "2026-11-09";
    expect(volTime({ ...CTX, isTradingDay: fn }, at("2026-11-06T15:00:00"), "2026-11-10").units).toBeCloseTo(1.47133, 5);
  });

  it("example 4: expiry day 14:00 / 15:00 / 15:20 — no blow-up and no floor artefact", () => {
    const rows = [
      ["2026-11-03T14:00:00", 0.14933, 0.000555, 28.35, 11.99, 21.59, 10.8],
      ["2026-11-03T15:00:00", 0.02133, 0.0000793, 10.7, 11.97, 14.12, 4.08],
      ["2026-11-03T15:20:00", 0.00079, 0.0000029, 2.05, 11.92, 4.68, 0.78],
    ];
    for (const [s, U, T, px, ivW, ivC, ivFloor] of rows) {
      const c = volTime(CTX, at(s), EXP);
      expect(c.units).toBeCloseTo(U, 5);
      expect(Math.abs(c.T - T)).toBeLessThan(1e-6);
      expect(atmCall(c)).toBeCloseTo(px, 6);
      const df = Math.exp(-RATE * c.Tcal);
      expect(Math.abs(impliedVolB76(px, 25150, 25150, c.T, "CE", df) - ivW)).toBeLessThan(0.006);
      expect(Math.abs(impliedVolB76(px, 25150, 25150, c.Tcal, "CE", df) - ivC)).toBeLessThan(0.006);
      expect(Math.abs(impliedVolB76(px, 25150, 25150, 0.25 / 365, "CE", df) - ivFloor)).toBeLessThan(0.011);
    }
    expect(volTime(CTX, at("2026-11-03T15:00:00"), EXP).settling).toBe(true);
    expect(volTime(CTX, at("2026-11-03T14:59:00"), EXP).settling).toBe(false);
  });

  it("is 0 at and after settlement, and for a past expiry", () => {
    for (const s of ["2026-11-03T15:30:00", "2026-11-03T16:00:00", "2026-11-05T10:00:00"]) {
      const c = volTime(CTX, at(s), EXP);
      expect([c.units, c.T, c.Tcal, c.Ttd]).toEqual([0, 0, 0, 0]);
    }
  });

  it("calendar and trading modes", () => {
    const now = at("2026-10-29T10:00:00");
    const cal = volTime({ ...CTX, mode: "calendar" }, now, EXP);
    expect(cal.T).toBeCloseTo(0.0143265, 7);
    expect(cal.units).toBeCloseTo(5.22917, 5);
    expect(cal.T).toBe(calendarYears(now, at("2026-11-03T15:30:00")));
    const td = volTime({ ...CTX, mode: "trading" }, now, EXP);
    expect(td.T).toBeCloseTo(0.0151852, 7);
    expect(td.units).toBeCloseTo(3.82667, 5);
  });

  it("an event-day multiplier scales that day's gap and session", () => {
    const base = volTime(CTX, at("2026-10-29T10:00:00"), EXP).units;
    const ev = volTime({ ...CTX, eventDays: { "2026-11-02": 1.5 } }, at("2026-10-29T10:00:00"), EXP).units;
    // Mon: gap 0.2·1.5 + 2 × 0.15 and session 0.8·1.5 → +0.5 units.
    expect(ev - base).toBeCloseTo(0.5, 10);
  });

  it("returns null without a session or with a bad expiry", () => {
    expect(volTime({ mode: "weighted" }, at("2026-10-29T10:00:00"), EXP)).toBeNull();
    expect(volTime(CTX, at("2026-10-29T10:00:00"), "3 Nov")).toBeNull();
  });

  it("is the same under TZ=UTC and TZ=America/New_York (IST maths only)", () => {
    const script = `import("${new URL("./pricing.js", import.meta.url).href}").then((P) => { const c = P.volTime(${JSON.stringify(CTX)}, ${at("2026-10-29T10:00:00")}, "${EXP}"); process.stdout.write(JSON.stringify([c.units, c.T, c.Tcal])); })`;
    const run = (TZ) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
    const utc = JSON.parse(run("UTC"));
    expect(JSON.parse(run("America/New_York"))).toEqual(utc);
    expect(utc[0]).toBeCloseTo(3.96133, 5);
  });
});

describe("clock conversion (§6.2) and constant maturity (§6.6)", () => {
  it("converts through total variance", () => {
    expect(convertIv(12.86, 0.0824242, 0.0794616)).toBeCloseTo(13.1, 2);
    expect(convertIv(null, 1, 1)).toBeNull();
  });

  it("example 6: cm30 at Thu 29 Oct 15:25 = 12.86 % (calendar 13.10 %)", () => {
    const now = at("2026-10-29T15:25:00");
    const c1 = volTime(CTX, now, "2026-11-17");
    const c2 = volTime(CTX, now, "2026-12-01");
    const cs = volTime(CTX, now, "2026-11-27");
    expect(c1.units).toBeCloseTo(13.868, 3);
    expect(c2.units).toBeCloseTo(24.468, 3);
    expect(cs.units).toBeCloseTo(22.168, 3);
    expect(c1.T).toBeCloseTo(0.0515635, 7);
    expect(c2.T).toBeCloseTo(0.090976, 7);
    expect(cs.T).toBeCloseTo(0.0824242, 7);
    expect(cs.Tcal).toBeCloseTo(0.0794616, 7);
    const cm = constantMaturity([{ expiry: "2026-11-17", T: c1.T, iv: 12.6 }, { expiry: "2026-12-01", T: c2.T, iv: 12.9 }], cs.T);
    expect(cm.method).toBe("interpolated");
    expect(cm.expiries).toEqual(["2026-11-17", "2026-12-01"]);
    expect(cm.tv).toBeCloseTo(0.00136306, 8);
    expect(cm.iv).toBeCloseTo(12.86, 2);
    expect(convertIv(cm.iv, cs.T, cs.Tcal)).toBeCloseTo(13.1, 2);
  });

  it("flat-extrapolates at either end and skips an expiry-day row", () => {
    expect(constantMaturity([{ expiry: "a", T: 0.01, iv: 12 }, { expiry: "b", T: 0.03, iv: 13 }], 0.08)).toMatchObject({ iv: 13, method: "flat-extrapolated", expiries: ["b"] });
    expect(constantMaturity([{ expiry: "a", T: 0.1, iv: 12 }, { expiry: "b", T: 0.2, iv: 13 }], 0.08)).toMatchObject({ iv: 12, method: "flat-extrapolated", expiries: ["a"] });
    const r = constantMaturity([{ expiry: "x", T: 0.0001, iv: 30, skip: true }, { expiry: "a", T: 0.05, iv: 12 }, { expiry: "b", T: 0.1, iv: 12 }], 0.02);
    expect(r).toMatchObject({ iv: 12, method: "flat-extrapolated", expiries: ["a"] });
    expect(constantMaturity([], 0.08)).toMatchObject({ iv: null, method: "unavailable" });
  });
});

describe("parity forward (§6.3) and the IV function (§6.4)", () => {
  const legs = (c, p) => ({ ce: { bid: c - 0.05, ask: c + 0.05, ltp: c }, pe: { bid: p - 0.05, ask: p + 0.05, ltp: p } });
  const EX5 = [
    [25050, 205.0, 112.6],
    [25100, 176.1, 133.8],
    [25150, 149.9, 157.3],
    [25200, 126.4, 183.9],
    [25250, 105.7, 213.1],
  ];
  const chain = { underlyingLtp: 25120.5, rows: EX5.map(([k, c, p]) => ({ strike: k, ...legs(c, p) })) };

  it("example 5: median of the 5 nearest two-sided strikes = 25,142.49", () => {
    const f = parityForward(chain, { rate: RATE, Tcal: 0.0147289 });
    expect(f.source).toBe("parity");
    expect(f.strikes).toBe(5);
    const byK = Object.fromEntries(f.values.map((v) => [v.strike, v.F]));
    expect(byK[25050]).toBeCloseTo(25142.49, 2);
    expect(byK[25100]).toBeCloseTo(25142.34, 2);
    expect(byK[25150]).toBeCloseTo(25142.59, 2);
    expect(byK[25200]).toBeCloseTo(25142.44, 2);
    expect(byK[25250]).toBeCloseTo(25142.5, 2);
    expect(f.F).toBeCloseTo(25142.49, 2);
    // On calendar T (0.0143265) every F_k moves by under 0.004.
    const cal = parityForward(chain, { rate: RATE, Tcal: 0.0143265 });
    for (let i = 0; i < 5; i++) expect(Math.abs(cal.values[i].F - f.values[i].F)).toBeLessThan(0.004);
  });

  it("without spot or atmStrike still computes the parity median from two-sided strikes (centred near the forward)", () => {
    const noSpot = { underlyingLtp: null, rows: chain.rows };
    const f = parityForward(noSpot, { rate: RATE, Tcal: 0.0147289 });
    expect(f).toMatchObject({ source: "parity", strikes: 5 });
    expect(f.F).toBeCloseTo(25142.49, 2);
    // A wider chain (11 strikes): the 5 used are the ones around the forward, not the chain's edge.
    const wide = { underlyingLtp: null, atmStrike: null, rows: [24900, 24950, 25000, 25050, 25100, 25150, 25200, 25250, 25300, 25350, 25400].map((k) => {
      const c = Math.max(1, 25142.49 - k) + 120 * Math.exp(-(((k - 25142.49) / 300) ** 2));
      return { strike: k, ...legs(c, c - (25142.49 - k)) };
    }) };
    const w = parityForward(wide, { rate: 0, Tcal: 0 });
    expect(w.values.map((v) => v.strike)).toEqual([25050, 25100, 25150, 25200, 25250]);
    expect(w.F).toBeCloseTo(25142.49, 6);
  });

  it("excludes one-sided strikes and falls back to spot", () => {
    const one = { underlyingLtp: 25120.5, rows: [{ strike: 25100, ce: { bid: 0, ask: 180, ltp: 176 }, pe: { bid: 130, ask: 131, ltp: 130 } }] };
    expect(parityForward(one, { rate: RATE, Tcal: 0.01 })).toMatchObject({ F: 25120.5, source: "spot", strikes: 0 });
    expect(parityForward({ rows: [] })).toMatchObject({ F: null, source: null });
    const mixed = { underlyingLtp: 25120.5, rows: [...chain.rows, { strike: 25125, ce: { bid: 0, ask: 1, ltp: 160 }, pe: { bid: 140, ask: 141 } }] };
    expect(parityForward(mixed, { rate: RATE, Tcal: 0.0147289 }).F).toBeCloseTo(25142.49, 2);
  });

  it("round-trips σ 1–150 %, moneyness 0.7–1.3, T 1e-6–1 to 1e-6", () => {
    let checked = 0;
    for (const sig of [1, 5, 12, 30, 80, 150]) {
      for (const m of [0.7, 0.85, 0.97, 1, 1.03, 1.15, 1.3]) {
        for (const T of [1e-6, 1e-4, 0.01, 0.1, 1]) {
          for (const right of ["CE", "PE"]) {
            const F = 25000;
            const K = F * m;
            const df = 0.995;
            const price = df * black76(F, K, T, sig, right);
            const intrinsic = df * Math.max(0, right === "CE" ? F - K : K - F);
            // Skip prices with no information beyond intrinsic (below float resolution of the time value).
            if (price - intrinsic < 1e-6 * F) continue;
            const iv = impliedVolB76(price, F, K, T, right, df);
            expect(iv, `${sig} ${m} ${T} ${right}`).not.toBeNull();
            expect(Math.abs(iv - sig), `${sig} ${m} ${T} ${right}`).toBeLessThan(1e-6);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("marks a leg SETTLING inside the window when its price is within 2 ticks of intrinsic", () => {
    const T = 0.0000029;
    const deepItm = { bid: 100.0, ask: 100.1, ltp: 100.05 };
    expect(legIv(deepItm, 25150, 25050, "CE", { years: T, df: 1, settling: true }).out).toBe("settling");
    expect(legIv(deepItm, 25150, 25050, "CE", { years: T, df: 1, settling: true }).iv).toBeNull();
    const otm = { bid: 0.05, ask: 0.15, ltp: 0.1 };
    expect(legIv(otm, 25150, 25200, "CE", { years: T, df: 1, settling: true }).out).toBe("settling");
    // Outside the window the same deep ITM price is solved (or judged against intrinsic) as usual.
    expect(legIv(deepItm, 25150, 25050, "CE", { years: 0.01, df: 1 }).out).not.toBe("settling");
    expect(legIv({ bid: 10.6, ask: 10.8 }, 25150, 25150, "CE", { years: 0.0000793, df: 1, settling: true }).out).toBeNull();
  });

  it("smile points: ATM IV at the forward from a Black-76 chain", () => {
    const F = 25142.49;
    const T = 0.0147289;
    const Tcal = 0.0143265;
    const df = Math.exp(-RATE * Tcal);
    const rows = [];
    for (let k = 24800; k <= 25500; k += 50) {
      const sig = 12 + 0.00002 * (k - F) ** 2 / 10;
      const leg = (r) => {
        const p = df * black76(F, k, T, sig, r);
        return { bid: p - 0.025, ask: p + 0.025, ltp: p };
      };
      rows.push({ strike: k, ce: leg("CE"), pe: leg("PE") });
    }
    const pts = smilePoints({ rows }, { F, years: T, rate: RATE, Tcal });
    expect(pts).toHaveLength(rows.length);
    const atm = atmIvAt(pts, F);
    expect(Math.abs(atm - 12)).toBeLessThan(0.02);
    // The options.js wrapper with an explicit Tcal and a T above its floor is the same maths.
    const viaOptions = O.smilePoints({ rows }, { F, years: T, rate: RATE, Tcal });
    expect(viaOptions.map((p) => p.ce?.iv)).toEqual(pts.map((p) => p.ce?.iv));
  });
});

describe("Greeks and theta (§6.5)", () => {
  it("match finite differences of the Black-76 price", () => {
    const F = 25150;
    const T = 0.02;
    for (const K of [24800, 25150, 25500]) {
      for (const right of ["CE", "PE"]) {
        const g = greeks76(F, K, T, 13, right, { yearBasis: 268.95 });
        const h = 0.5;
        expect(g.delta).toBeCloseTo((black76(F + h, K, T, 13, right) - black76(F - h, K, T, 13, right)) / (2 * h), 5);
        // Gamma against the analytic delta (a second difference of prices would amplify the CDF approximation).
        const dd = (greeks76(F + 1, K, T, 13, right).delta - greeks76(F - 1, K, T, 13, right).delta) / 2;
        expect(Math.abs(g.gamma - dd) / g.gamma).toBeLessThan(1e-3);
        expect(g.vega).toBeCloseTo((black76(F, K, T, 13.01, right) - black76(F, K, T, 12.99, right)) / 0.02, 3);
        const dT = 1e-6;
        const fd = -(black76(F, K, T + dT, 13, right) - black76(F, K, T - dT, 13, right)) / (2 * dT);
        expect(Math.abs(g.theta * 268.95 - fd) / Math.abs(fd)).toBeLessThan(1e-5);
      }
    }
  });

  it("decay to the next session: Thu→Fri 21.9 and Fri→Mon 37.6 points (ATM, F = 25,150, σ = 12 %)", () => {
    const px = (s) => black76(25150, 25150, volTime(CTX, at(s), EXP).T, 12, "CE");
    // The spec prints 21.90 and 37.62; the exact Black-76 differences are 21.94 and 37.66.
    expect(Math.abs(px("2026-10-29T15:00:00") - px("2026-10-30T15:00:00") - 21.9)).toBeLessThan(0.05);
    expect(Math.abs(px("2026-10-30T15:00:00") - px("2026-11-02T15:00:00") - 37.62)).toBeLessThan(0.05);
    const dU = volTime(CTX, at("2026-10-30T15:00:00"), EXP).units - volTime(CTX, at("2026-11-02T15:00:00"), EXP).units;
    expect(dU).toBeCloseTo(1.3, 10);
  });

  it("options.js black76Greeks gives theta per trading-day unit of the page's clock through greeks76", () => {
    const a = O.black76Greeks(25150, 25150, 0.02, 12, "CE");
    const b = greeks76(25150, 25150, 0.02, 12, "CE");
    // Default (weighted) clock: Y = 252 + 113 × 0.15 = 268.95 units a year.
    expect(a.theta * 268.95).toBeCloseTo(b.theta, 8);
    expect(a.delta).toBe(b.delta);
    // A calendar context reproduces the per-calendar-day theta.
    const cal = O.black76Greeks(25150, 25150, 0.02, 12, "CE", { mode: "calendar", session: { open: "09:15", close: "15:30" } });
    expect(cal.theta * 365).toBeCloseTo(b.theta, 8);
  });
});

describe("IV rank and percentile (§6.7), bands (§6.8), same-DTE (§6.9)", () => {
  const V = [11.2, 12.5, 14.1, 9.8, 13.0, 15.6, 10.4, 12.0, 16.3, 11.9];

  it("example 7: IVR 55.38, IVP 70", () => {
    const r = ivRank(V, 13.4, { minN: 5 });
    expect(r.n).toBe(10);
    expect(r.ivr).toBeCloseTo(55.38, 2);
    expect(r.ivp).toBe(70);
    expect(r.min.iv).toBe(9.8);
    expect(r.max.iv).toBe(16.3);
  });

  it("n < minimum → COLLECTING; flat → FLAT with IVP", () => {
    expect(ivRank(V, 13.4)).toMatchObject({ n: 10, ivr: null, ivp: null, reason: "COLLECTING" });
    expect(ivRank([12, 12, 12, 12, 12], 13, { minN: 5 })).toMatchObject({ ivr: null, ivp: 100, reason: "FLAT" });
    expect(ivRank([{ iv: 10, date: "2026-01-02" }, { iv: 20, date: "2026-02-03" }], 15, { minN: 2 })).toMatchObject({ ivr: 50, ivp: 50, min: { date: "2026-01-02" }, max: { date: "2026-02-03" } });
  });

  it("bands: 24,779.0 – 25,511.3, move 366.2, expected absolute move 292.2", () => {
    const b = bands(25142.49, 12, 0.0147289);
    expect(b.sdT).toBeCloseTo(0.0145635, 7);
    expect(b.band1[0]).toBeCloseTo(24779.0, 1);
    expect(b.band1[1]).toBeCloseTo(25511.3, 1);
    expect(b.move).toBeCloseTo(366.2, 1);
    expect(b.eam).toBeCloseTo(292.2, 1);
  });

  it("same-DTE: rows within ±0.5 units, one per date (the closest)", () => {
    const rows = [
      { date: "2026-10-01", units: 3.4, iv: 1 },
      { date: "2026-10-01", units: 3.7, iv: 2 },
      { date: "2026-10-02", units: 4.46, iv: 3 },
      { date: "2026-10-03", units: 4.47, iv: 4 },
      { date: "2026-10-04", units: 3.96, iv: 5 },
    ];
    expect(sameDteRows(rows, 3.96, 0.5).map((r) => r.iv)).toEqual([2, 3, 5]);
  });
});

describe("realised vol (§6.11)", () => {
  it("HV5 = 11.75 % on the worked closes", () => {
    expect(realisedVol([25000, 25210, 25080, 25300, 25190, 25420], 5)).toBeCloseTo(11.75, 2);
  });

  it("Parkinson on a hand-computed fixture: ln(H/L) = 0.02 every day → 19.07 %", () => {
    const bars = Array.from({ length: 5 }, () => ({ open: 100, high: 100 * Math.exp(0.01), low: 100 * Math.exp(-0.01), close: 100 }));
    // σ² = 0.02² / (4 ln 2) × 252 = 0.0363562 → 19.067 %
    expect(parkinsonVol(bars, 5)).toBeCloseTo(19.067, 3);
    expect(parkinsonVol(bars.map((b) => ({ ...b, high: 100, low: 100 })), 5)).toBeNull();
  });

  it("Yang-Zhang on a hand-computed 5-day fixture", () => {
    // Open gaps o = [+.01, −.01, +.01, −.01, +.01] (closes back at 100), intraday c = −o, H/L ±1 % around the open.
    const bars = [{ open: 100, high: 101, low: 99, close: 100 }];
    for (const g of [0.01, -0.01, 0.01, -0.01, 0.01]) {
      const open = 100 * Math.exp(g);
      bars.push({ open, high: Math.max(open, 100) * Math.exp(0.01), low: Math.min(open, 100) * Math.exp(-0.01), close: 100 });
    }
    const o = [0.01, -0.01, 0.01, -0.01, 0.01];
    const svar = (xs) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
    };
    // Rogers-Satchell per day: with O > C (gap up, close at 100): H = O·e^.01, L = C·e^−.01.
    const rs = bars.slice(1).map((b) => Math.log(b.high / b.close) * Math.log(b.high / b.open) + Math.log(b.low / b.close) * Math.log(b.low / b.open));
    const k = 0.34 / (1.34 + 6 / 4);
    const expected = Math.sqrt((svar(o) + k * svar(o.map((x) => -x)) + (1 - k) * (rs.reduce((a, b) => a + b, 0) / 5)) * 252) * 100;
    expect(svar(o)).toBeCloseTo(0.00012, 10);
    expect(yangZhangVol(bars, 5)).toBeCloseTo(expected, 10);
    expect(yangZhangVol(bars, 5)).toBeGreaterThan(20);
    expect(yangZhangVol(bars.slice(0, 3), 5)).toBeNull();
  });
});
