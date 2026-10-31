// Volatility › Forward, RR and BF, Event vol (analyticsDepth.js): the pure parts, the wiring to the menu and the host,
// and the house rules for page code (no inline styles, figures through format.js).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPTH_EXPIRIES, RR_DELTAS, calmestForwardVol, defaultEventDate, eventDateText, eventWindows, forwardRows, rrBfTerm, rrWords, varianceParts } from "./analyticsDepth.js";
import { VIEWS } from "./analytics.js";
import { PAGES, resolveRoute } from "./views.js";
import { eventMove } from "../analytics/derivDepth.mjs";

describe("forward curve rows", () => {
  it("sorts by days, keeps every figure a number or null, and says how many strikes were used", () => {
    const rows = forwardRows([
      { expiry: "2026-11-17", dte: 17.6, forward: 25063.6, basis: 78.45, basisPct: 0.314, carryPct: 6.499, impliedDividendYieldPct: 0.001, strikesUsed: [25000, 24950, 25050], dispersion: 0.01, quality: "ok" },
      { expiry: "2026-11-03", dte: 3.6, forward: 25001.2, basis: 16.07, basisPct: 0.0643, carryPct: 6.504, impliedDividendYieldPct: -0.004, strikesUsed: [25000], dispersion: 0, quality: "ok" },
      { expiry: "2026-11-23", dte: 23.6, forward: null, reason: "chain unavailable" },
      null,
      { dte: 4 },
    ]);
    expect(rows.map((r) => r.expiry)).toEqual(["2026-11-03", "2026-11-17", "2026-11-23"]);
    expect(rows[0]).toMatchObject({ forward: 25001.2, basis: 16.07, carryPct: 6.504, dividendPct: -0.004, strikes: 1, quality: "ok" });
    expect(rows[2]).toMatchObject({ forward: null, basis: null, carryPct: null, strikes: 0, quality: "none", reason: "chain unavailable" });
    expect(forwardRows(undefined)).toEqual([]);
  });
});

describe("risk reversal and butterfly term structure", () => {
  const answer = (expiry, dte, d25, d10) => ({
    expiry,
    data: {
      daysToExpiry: dte,
      smilePoints: 91,
      deltas: [
        { delta: 25, callIvPct: 20.6, putIvPct: 22.4, atmIvPct: 19.7, riskReversal: d25[0], butterfly: d25[1], reason: null },
        { delta: 10, callIvPct: 22.7, putIvPct: 28.5, atmIvPct: 19.7, riskReversal: d10[0], butterfly: d10[1], reason: null },
      ],
    },
  });

  it("one row per answered expiry, nearest first, at the chosen delta with 10 delta beside it", () => {
    const rows = rrBfTerm([answer("2026-11-09", 9.6, [-1.8, 1.79], [-5.8, 5.9]), { expiry: "2026-11-17", data: null }, answer("2026-11-03", 3.6, [-2.1, 2.0], [-6.1, 6.4])], 25);
    expect(rows.map((r) => r.expiry)).toEqual(["2026-11-03", "2026-11-09"]);
    expect(rows[0]).toMatchObject({ dte: 3.6, atm: 19.7, callIv: 20.6, putIv: 22.4, rr: -2.1, bf: 2.0, rr10: -6.1, bf10: 6.4, points: 91 });
  });

  it("a delta the route did not answer stays null rather than borrowing another delta's figure", () => {
    const [row] = rrBfTerm([answer("2026-11-03", 3.6, [-2.1, 2.0], [-6.1, 6.4])], 15);
    expect([row.rr, row.bf, row.callIv]).toEqual([null, null, null]);
    expect(row.rr10).toBe(-6.1);
    expect(row.atm).toBe(19.7); // ATM is the same at every delta
  });

  it("says what a risk reversal means in words", () => {
    expect(rrWords(-1.8)).toBe("Puts dearer than calls");
    expect(rrWords(0.6)).toBe("Calls dearer than puts");
    expect(rrWords(0.1)).toBe("Calls and puts level");
    expect(rrWords(null)).toBe("No reading");
  });

  it("offers deltas the route accepts (1 to 49)", () => {
    for (const d of RR_DELTAS) expect(d >= 1 && d <= 49).toBe(true);
    expect(RR_DELTAS).toContain(25);
    expect(DEPTH_EXPIRIES).toBeLessThanOrEqual(12);
  });
});

describe("event vol", () => {
  it("names the picked day as \"4 Nov\", not in the picker's en-US form", () => {
    expect(eventDateText("2026-11-04")).toBe("Event on 4 Nov");
    expect(eventDateText("2027-01-26")).toBe("Event on 26 Jan");
    expect(eventDateText("")).toBe("");
    expect(eventDateText(null)).toBe("");
    const src = readFileSync(new URL("./analyticsDepth.js", import.meta.url), "utf8");
    expect(src).toContain('H.field("Event date", dateEl, dateText)');
    expect(src).toMatch(/dateEl\.addEventListener\("change", \(\) => \(\(dateText\.textContent = eventDateText\(dateEl\.value\)\), load\(\)\)\);/);
  });

  it("defaults the event to the weekday after the nearest expiry, so an expiry sits on each side", () => {
    expect(defaultEventDate(["2026-11-09", "2026-11-03", "2026-11-17"])).toBe("2026-11-04");
    // A Friday expiry: the next weekday is Monday.
    expect(defaultEventDate(["2026-11-06", "2026-11-13"])).toBe("2026-11-09");
    // Expiries a day apart: the later expiry itself.
    expect(defaultEventDate(["2026-11-05", "2026-11-06"])).toBe("2026-11-06");
    expect(defaultEventDate(["2026-11-03"])).toBeNull();
    expect(defaultEventDate([])).toBeNull();
  });

  it("splits the post-event expiry's variance into before, drift and event, and the parts add up", () => {
    const s1 = 18;
    const s2 = 22;
    const d1 = 5;
    const d2 = 12;
    const m = eventMove({ s1, T1: d1 / 365, s2, T2: d2 / 365, baseline: s1, spot: 25000 });
    const d = {
      preEventExpiry: { daysToExpiry: d1, atmIvPct: s1, totalVariance: (s1 / 100) ** 2 * (d1 / 365) },
      postEventExpiry: { daysToExpiry: d2, atmIvPct: s2, totalVariance: (s2 / 100) ** 2 * (d2 / 365) },
      baseline: { volPct: s1 },
      ...m,
    };
    const p = varianceParts(d);
    expect(p.event).toBeGreaterThan(0);
    expect(p.pre + p.drift + p.event).toBeCloseTo(p.total, 6);
    expect(p.eventShare).toBeGreaterThan(0);
    expect(p.eventShare).toBeLessThan(100);
  });

  it("offers the calmest forward vol as the baseline", () => {
    expect(calmestForwardVol([{ forwardVolPct: 19 }, { forwardVolPct: 17.68 }, { forwardVolPct: null }, { forwardVolPct: 18.38 }])).toBe(17.68);
    expect(calmestForwardVol([{ forwardVolPct: null }])).toBeNull();
    expect(calmestForwardVol(undefined)).toBeNull();
  });

  it("prices each window between expiries the way the route prices a date inside it", () => {
    const term = [
      { expiry: "2026-11-09", daysToExpiry: 9.61, atmIvPct: 19.72 },
      { expiry: "2026-11-03", daysToExpiry: 3.61, atmIvPct: 20.87 },
      { expiry: "2026-11-17", daysToExpiry: 17.61, atmIvPct: 18.82 },
    ];
    const w = eventWindows(term, 17.5);
    expect(w.map((x) => [x.from, x.to])).toEqual([["2026-11-03", "2026-11-09"], ["2026-11-09", "2026-11-17"]]);
    expect(w[0].days).toBe(6);
    // Same numbers as the server's eventMove for an event between the two expiries.
    const m = eventMove({ s1: 20.87, T1: 3.61 / 365, s2: 19.72, T2: 9.61 / 365, baseline: 17.5, spot: 25000 });
    expect(w[0].movePct).toBeCloseTo(m.impliedEventMovePct, 2);
    // Forward vol of each window; no premium over a baseline above it.
    expect(w[1].forwardVolPct).toBeGreaterThan(17);
    expect(eventWindows(term, 30).every((x) => x.movePct === null)).toBe(true);
    expect(eventWindows(term, null).every((x) => x.movePct === null && x.forwardVolPct !== null)).toBe(true);
    expect(eventWindows([term[0]], 15)).toEqual([]);
  });

  it("no premium is an event part of 0, and no post-event expiry is nothing to split", () => {
    const p = varianceParts({ preEventExpiry: { daysToExpiry: 9.6, totalVariance: 0.00102 }, postEventExpiry: { daysToExpiry: 17.6, totalVariance: 0.0017 }, baseline: { volPct: 19.7 }, eventVariance: -0.00017 });
    expect(p.event).toBe(0);
    expect(p.eventShare).toBe(0);
    expect(varianceParts({})).toBeNull();
    expect(varianceParts(null)).toBeNull();
  });
});

describe("wiring", () => {
  it("each view is a Volatility tab drawn by the depth page, and its hash opens it", () => {
    const vol = PAGES.find((p) => p.id === "vol");
    for (const [view, tab, hash] of [["an-forward", "forward", "vol/forward"], ["an-rrbf", "rrbf", "vol/rrbf"], ["an-eventvol", "event", "vol/event"]]) {
      expect(VIEWS[view]?.[0], view).toBe("depth");
      expect(VIEWS[view][1]).toBe(tab);
      expect(vol.tabs.some((t) => t.page === view), view).toBe(true);
      expect(resolveRoute(`#/${hash}`).view, hash).toBe(view);
    }
  });

  it("is served, and keeps the house rules: no inline styles, no external hosts, numbers through format.js", () => {
    const app = readFileSync(new URL("../core/app.mjs", import.meta.url), "utf8");
    expect(app).toMatch(/"analyticsDepth\.js": "text\/javascript/);
    const src = readFileSync(new URL("./analyticsDepth.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/setAttribute\(\s*["']style|\bstyle:|innerHTML|outerHTML|insertAdjacentHTML/);
    expect(src.match(/https?:\/\//g) ?? []).toEqual([]);
    expect(src).not.toMatch(/Intl\.NumberFormat|\.toLocaleString\(|toFixed\(/);
  });
});
