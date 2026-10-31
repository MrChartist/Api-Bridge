// Analytics routes that read several option chains (forward curve, vol cone, event vol, exposure across expiries,
// OI explorer) read them CHAIN_READS at a time: the answers must be exactly those of reading one after another, and
// no more than CHAIN_READS chains may be in flight for one request.
import { describe, expect, it } from "vitest";
import { mapSettledLimit } from "../../lib/batch.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { derivDepthRoutes } from "./derivDepth.mjs";
import { exposureRoutes } from "./exposure.mjs";
import { CHAIN_READS } from "./math.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T04:00:00Z");
const EXPIRIES = ["2026-11-02", "2026-11-04", "2026-11-11", "2026-11-18", "2026-11-25", "2026-12-02", "2026-12-09", "2026-12-30", "2027-01-27"];
const FAILING = new Set(["2026-11-18", "2026-12-09"]);
const leg = (o) => ({ symbol: "x", ltp: 10, bid: 0, ask: 0, oi: 100, oiChange: 0, volume: 1, iv: null, delta: null, gamma: 0.001, theta: null, vega: null, greeksSource: null, ...o });

/** A chain whose figures depend on its expiry, so a mix-up in order shows in the answer. */
function chainFor(i) {
  const S = 25000 + i * 7;
  const iv = 12 + i * 0.6;
  const rows = [-200, -100, 0, 100, 200].map((d) => {
    const K = 25000 + d;
    return { strike: K, ce: leg({ ltp: Math.max(5, S - K) + 40 + i, iv, delta: 0.5 - d / 1000, oi: 1000 + i * 10 + d }), pe: leg({ ltp: Math.max(5, K - S) + 38 + i, iv: iv + 0.4, delta: -0.5 - d / 1000, oi: 900 + i * 10 - d }) };
  });
  return { underlyingLtp: S, lotSize: 75, rows };
}

/**
 * The fake market data with fixed freshness, failing chains and per-chain delays (the later expiries answer first),
 * counting the chains in flight. `serial: true` lets only one chain read run at a time: the sequential reference.
 */
function harness({ serial = false } = {}) {
  const md = createFakeMarketData({ prices: { "NSE:NIFTY": 25000 } });
  md.setExpiries("NIFTY", EXPIRIES);
  EXPIRIES.forEach((e, i) => md.setChain("NIFTY", e, chainFor(i)));
  md.setCandles("NSE:NIFTY", "1d", Array.from({ length: 300 }, (_, i) => ({ time: Math.floor((NOW - (300 - i) * DAY) / 1000), open: 100, high: 100, low: 100, close: i % 2 ? 101 : 100, volume: 1 })));
  const fixed = { source: "test" };
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  let gate = Promise.resolve();
  const read = async (params, opts) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(params.expiry);
    try {
      const i = EXPIRIES.indexOf(params.expiry);
      await new Promise((r) => setTimeout(r, 2 + (EXPIRIES.length - i) * 2));
      if (FAILING.has(params.expiry)) throw Object.assign(new Error(`no chain for ${params.expiry}`), { code: "UPSTREAM_ERROR" });
      return { ...(await md.optionChain(params, opts)), freshness: fixed };
    } finally {
      inFlight -= 1;
    }
  };
  const marketData = {
    expiries: async (u, o) => ({ ...(await md.expiries(u, o)), freshness: fixed }),
    history: async (p, o) => ({ ...(await md.history(p, o)), freshness: fixed }),
    optionChain(params, opts) {
      if (!serial) return read(params, opts);
      const run = gate.then(() => read(params, opts));
      gate = run.catch(() => {});
      return run;
    },
  };
  const deps = { marketData, now: () => NOW };
  const routes = Object.fromEntries([...derivDepthRoutes(deps), ...exposureRoutes(deps)].map(([, p, , h]) => [p, h]));
  return { routes, stats: () => ({ maxInFlight, order: [...order] }) };
}
const ctx = (q) => ({ query: new URLSearchParams(q), requestId: "r1", principal: { kind: "local" }, requireAccountAccess() {} });
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: { code: e?.code, message: e?.message } }));

const CASES = [
  ["/v1/analytics/forward-curve", "underlying=NIFTY&expiries=8"],
  ["/v1/analytics/forward-curve", "underlying=NIFTY&expiries=2"],
  ["/v1/analytics/vol-cone", "underlying=NIFTY&days=250&expiries=5"],
  ["/v1/analytics/vol-cone", "underlying=NIFTY&days=250&expiries=6"],
  ["/v1/analytics/event-vol", "underlying=NIFTY&event=2026-11-28"],
  ["/v1/analytics/event-vol", "underlying=NIFTY&event=2026-11-20"],
  ["/v1/analytics/event-vol", "underlying=NIFTY&event=2026-12-05"],
  ["/v1/analytics/event-vol", "underlying=NIFTY&event=2026-11-02"],
  ["/v1/analytics/exposure/expiries", "underlying=NIFTY&expiries=3"],
  ["/v1/analytics/exposure/expiries", "underlying=NIFTY&expiries=6"],
  ["/v1/analytics/oi-explorer", "underlying=NIFTY&expiries=3"],
  ["/v1/analytics/oi-explorer", "underlying=NIFTY&expiries=8"],
];

describe("analytics chain reads run concurrently, capped, with sequential answers", () => {
  for (const [path, q] of CASES) {
    it(`${path}?${q}: the same answer and chains as one after another, at most ${CHAIN_READS} in flight`, async () => {
      const seq = harness({ serial: true });
      const par = harness();
      const a = await settle(seq.routes[path](ctx(q)));
      const b = await settle(par.routes[path](ctx(q)));
      expect(b).toEqual(a);
      expect(seq.stats().maxInFlight).toBeLessThanOrEqual(1);
      expect(par.stats().maxInFlight).toBeLessThanOrEqual(CHAIN_READS);
      expect([...par.stats().order].sort()).toEqual([...seq.stats().order].sort());
    });
  }

  it("the forward curve's six default chains overlap (about two round trips at 3 in flight, not six)", async () => {
    const par = harness();
    const r = await par.routes["/v1/analytics/forward-curve"](ctx("underlying=NIFTY"));
    expect(r.data.curve).toHaveLength(6);
    expect(par.stats().maxInFlight).toBe(CHAIN_READS);
  });

  it("a failing chain is reported in expiry order, not in the order the reads finished", async () => {
    const r = await harness().routes["/v1/analytics/forward-curve"](ctx("underlying=NIFTY&expiries=9"));
    expect(r.errors.map((e) => e.expiry)).toEqual(["2026-11-18", "2026-12-09"]);
    expect(r.data.curve.map((c) => c.expiry)).toEqual(EXPIRIES);
  });
});

describe("mapSettledLimit", () => {
  it("keeps the items' order, settles every item and never exceeds the cap", async () => {
    for (const cap of [1, 2, 3, 5]) {
      let now = 0;
      let peak = 0;
      const items = Array.from({ length: 11 }, (_, i) => i);
      const out = await mapSettledLimit(items, cap, async (x) => {
        now += 1;
        peak = Math.max(peak, now);
        await new Promise((r) => setTimeout(r, (11 - x) % 4));
        now -= 1;
        if (x % 4 === 3) throw new Error(`bad ${x}`);
        return x * 10;
      });
      expect(peak).toBe(Math.min(cap, items.length));
      expect(out.map((o) => (o.status === "fulfilled" ? o.value : o.reason.message))).toEqual(items.map((x) => (x % 4 === 3 ? `bad ${x}` : x * 10)));
    }
  });
  it("handles no items, a synchronous throw and a bad cap", async () => {
    expect(await mapSettledLimit([], 3, async () => 1)).toEqual([]);
    const out = await mapSettledLimit([1, 2], 0, (x) => {
      if (x === 1) throw new Error("sync");
      return x;
    });
    expect(out).toEqual([{ status: "rejected", reason: new Error("sync") }, { status: "fulfilled", value: 2 }]);
  });
});
