// Option chain and Futures pages: the first draw never waits for the far-month futures' quotes (perf round 5b). The
// recorder streams the two nearest futures of an index; a third is a cold broker read (one round trip) that the pages
// fill in when it arrives.
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router): load it first so the circular import settles as in the browser.
await import("./views.js");
const { NEAR_FUTURES, quotePlan, readQuotes } = await import("./desk.js");
const { futuresView } = await import("./analyticsMore.js");

const FUTS = ["2026-11-24", "2026-12-29", "2027-01-26"].map((expiry) => ({ expiry, symbol: `NFO:NIFTY-${expiry}-FUT` }));
const [F1, F2, F3] = FUTS.map((f) => f.symbol);
const never = () => new Promise(() => {});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("chain quotes: near now, far later", () => {
  it("waits for the index, the two nearest futures and the selected expiry's own; the far month is read later", () => {
    expect(NEAR_FUTURES).toBe(2);
    expect(quotePlan("NSE:NIFTY", FUTS, "2026-11-04")).toEqual({ now: ["NSE:NIFTY", F1, F2], later: [F3] });
    // The selected expiry is the far month: its own future is part of the draw.
    expect(quotePlan("NSE:NIFTY", FUTS, "2027-01-26")).toEqual({ now: ["NSE:NIFTY", F1, F2, F3], later: [] });
    // Once the far month has a quote, one read as before (no extra request per refresh).
    expect(quotePlan("NSE:NIFTY", FUTS, "2026-11-04", (s) => s === F3)).toEqual({ now: ["NSE:NIFTY", F1, F2, F3], later: [] });
    expect(quotePlan("NSE:NIFTY", [], "2026-11-04")).toEqual({ now: ["NSE:NIFTY"], later: [] });
    expect(quotePlan(undefined, FUTS.slice(0, 2), null)).toEqual({ now: [F1, F2], later: [] });
  });

  it("the chain's first render does not await the far-month futures quote", async () => {
    const asked = [];
    let late = null;
    const read = (syms) => {
      asked.push(syms);
      // The near quotes answer from the stream at once; the far month is a cold broker read that has not answered.
      return syms.includes(F3) ? never() : Promise.resolve({ data: { data: syms.map((symbol) => ({ symbol, ltp: 1 })) } });
    };
    const r = await Promise.race([readQuotes(read, quotePlan("NSE:NIFTY", FUTS, "2026-11-04"), (x) => (late = x)), never().then(() => "waited"), tick().then(() => "waited")]);
    expect(r).not.toBe("waited");
    expect(r.data.data.map((q) => q.symbol)).toEqual(["NSE:NIFTY", F1, F2]);
    // Both reads went out together: the far one is not started after the draw.
    expect(asked).toEqual([[F3], ["NSE:NIFTY", F1, F2]]);
    expect(late).toBeNull();
  });

  it("fills the far month in when it arrives, and a failed far read changes nothing", async () => {
    let answer;
    const far = new Promise((r) => (answer = r));
    const read = (syms) => (syms.includes(F3) ? far : Promise.resolve({ data: { data: [] } }));
    const got = [];
    await readQuotes(read, quotePlan("NSE:NIFTY", FUTS, "2026-11-04"), (x) => got.push(x));
    expect(got).toEqual([]);
    answer({ data: { data: [{ symbol: F3, ltp: 25400 }] } });
    await tick();
    expect(got).toEqual([{ data: { data: [{ symbol: F3, ltp: 25400 }] } }]);
    const calls = [];
    await readQuotes((s) => (s.includes(F3) ? Promise.reject(new Error("down")) : Promise.resolve({})), quotePlan("NSE:NIFTY", FUTS, "x"), (x) => calls.push(x));
    await tick();
    expect(calls).toEqual([]);
  });
});

describe("Futures page: near first, far filled in", () => {
  const boxOf = (nodes) => ({ nodes, replaceChildren(...n) { this.nodes = n; } });
  const draw = (res) => res.data.data.futures.map((f) => `${f.expiry}:${f.ltp ?? "–"}`);
  const answer = (pending) => ({ data: { data: { futures: [{ expiry: "a", ltp: 1 }, { expiry: "b", ltp: 2 }, pending ? { expiry: "c", ltp: null, pending: true } : { expiry: "c", ltp: 3 }] } } });

  it("draws from ?wait=near with a dash for the far month, then fills it from the full read", async () => {
    let full;
    const asked = [];
    const read = (path) => {
      asked.push(path);
      return path.includes("wait=near") ? Promise.resolve(answer(true)) : new Promise((r) => (full = r));
    };
    const box = await futuresView(read, { underlying: "NIFTY", expiries: "3" }, draw, boxOf);
    expect(box.nodes).toEqual(["a:1", "b:2", "c:–"]);
    expect(asked).toEqual(["/v1/analytics/futures?underlying=NIFTY&expiries=3&wait=near", "/v1/analytics/futures?underlying=NIFTY&expiries=3"]);
    full(answer(false));
    await box.filled;
    expect(box.nodes).toEqual(["a:1", "b:2", "c:3"]);
  });

  it("makes one read when nothing is pending", async () => {
    const asked = [];
    const box = await futuresView((p) => (asked.push(p), Promise.resolve(answer(false))), { underlying: "NIFTY", expiries: "3" }, draw, boxOf);
    expect(box.nodes).toEqual(["a:1", "b:2", "c:3"]);
    expect(asked).toHaveLength(1);
    expect(box.filled).toBeUndefined();
  });
});
