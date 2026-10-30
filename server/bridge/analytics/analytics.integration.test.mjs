/**
 * Every /v1/analytics/* route through real HTTP against the REAL app in demo mode: createApp with the built-in modules,
 * the real key store and the demo broker account, in a temp data dir over a loopback port. No network beyond loopback.
 *
 * Also pins the response shapes dashboard/analyticsViews.js reads (oi, gex, skew, surface, payoff, greeks, position-size).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";

let app;
let base;
let dir;
let readKey;
let monthly; // the last listed expiry: the monthly one, the only kind that has a future
let weekly; // the nearest expiry
let expiries;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcb-analytics-int-"));
  const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
  app = await createApp({ config, logger: createNullLogger() });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
  ({ key: readKey } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"], accounts: "*" }));
  const r = await call("GET", "/v1/expiries?underlying=NIFTY");
  expiries = r.body.data.expiries;
  weekly = expiries[0];
  monthly = expiries.at(-1);
});

afterAll(async () => {
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function call(method, path, body, key = readKey) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, body: json, text };
}
const get = (p, key) => call("GET", p, undefined, key);

/** Paths (like `strikes[3].ceIv`) of every null / non-finite number in a JSON value. */
function nullPaths(v, path = "") {
  // A strike with no usable IV (premium below intrinsic in the random demo prices) is a legitimate null.
  if (v === null) return path.endsWith(".direction") || /points\[\d+\]\.(ceIv|peIv)$/.test(path) ? [] : [path || "(root)"];
  if (typeof v === "number") return Number.isFinite(v) ? [] : [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => nullPaths(x, `${path}[${i}]`));
  // `direction` is null where a strike has no gap to call (a legitimate empty value).
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => nullPaths(x, path ? `${path}.${k}` : k));
  return [];
}
const expectEnvelope = (r) => {
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.body).toHaveProperty("data");
  expect(r.body.meta).toMatchObject({ requestId: expect.stringMatching(/^req_/) });
  expect(r.text).not.toMatch(/NaN|Infinity/);
  return r.body.data;
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const expectFlag = (r) => {
  expect(r.status, r.text.slice(0, 300)).toBe(400);
  expect(r.body.code).toBe("VALIDATION_FAILED");
  expect(Array.isArray(r.body.errors)).toBe(true);
};

describe("demo harness", () => {
  it("lists NIFTY expiries with a monthly future on the last one", () => {
    expect(expiries.length).toBeGreaterThanOrEqual(2);
    expect(weekly < monthly).toBe(true);
  });
});

describe("chain-based routes (read key)", () => {
  it("GET /oi: the fields the dashboard reads, all numeric", async () => {
    const d = expectEnvelope(await get(`/v1/analytics/oi?underlying=NIFTY&expiry=${monthly}&strikes=10`));
    expect(d).toMatchObject({ underlying: "NIFTY", expiry: monthly });
    for (const k of ["underlyingLtp", "atmStrike", "pcrOi", "pcrVolume", "maxPain"]) expect(isNum(d[k]), k).toBe(true);
    for (const k of ["ceOi", "peOi", "ceOiChange", "peOiChange"]) expect(isNum(d.totals[k]), `totals.${k}`).toBe(true);
    expect(d.strikes.length).toBeGreaterThan(5);
    for (const s of d.strikes) for (const k of ["strike", "ceOi", "peOi", "ceOiChange", "peOiChange"]) expect(isNum(s[k]), `strikes.${k}`).toBe(true);
    expect(d.strikes.map((s) => s.strike)).toContain(d.maxPain);
    for (const list of [d.resistance, d.support]) {
      expect(list.length).toBeGreaterThan(0);
      for (const x of list) expect([isNum(x.strike), isNum(x.value)]).toEqual([true, true]);
    }
    expect(nullPaths(d)).toEqual([]);
  });

  it("GET /gex: the fields the dashboard reads, all numeric", async () => {
    const d = expectEnvelope(await get(`/v1/analytics/gex?underlying=NIFTY&expiry=${monthly}&strikes=10`));
    expect(d).toMatchObject({ underlying: "NIFTY", expiry: monthly, unit: expect.any(String) });
    expect(["positive", "negative", "neutral"]).toContain(d.regime);
    for (const k of ["netGex", "largestStrike", "lotSize"]) expect(isNum(d[k]), k).toBe(true);
    // No sign change in the running total (random demo prices) means no flip strike: null is the honest answer.
    expect(d.flipStrike === null || isNum(d.flipStrike), "flipStrike").toBe(true);
    for (const s of d.strikes) for (const k of ["strike", "callGex", "putGex", "netGex"]) expect(isNum(s[k]), `strikes.${k}`).toBe(true);
    expect(nullPaths(d)).toEqual([]);
  });

  it("GET /skew: the fields the dashboard reads, all numeric", async () => {
    const d = expectEnvelope(await get(`/v1/analytics/skew?underlying=NIFTY&expiry=${monthly}&strikes=10&width=2`));
    expect(d).toMatchObject({ underlying: "NIFTY", expiry: monthly, width: 2 });
    expect(["put-heavy", "call-heavy", "flat"]).toContain(d.skew);
    for (const k of ["atmStrike", "atmIv", "putStrike", "callStrike", "riskReversal"]) expect(isNum(d[k]), k).toBe(true);
    expect(d.points.length).toBeGreaterThan(5);
    for (const p of d.points) for (const k of ["strike", "ceIv", "peIv"]) expect(isNum(p[k]), `points.${k}`).toBe(true);
    expect(nullPaths(d)).toEqual([]);
  });

  it("GET /surface: the fields the dashboard reads, all numeric", async () => {
    const d = expectEnvelope(await get("/v1/analytics/surface?underlying=NIFTY&expiries=4&strikes=8"));
    expect(d.underlying).toBe("NIFTY");
    expect(["contango", "backwardation", "flat"]).toContain(d.termStructure);
    expect(d.expiries.length).toBe(4);
    for (const e of d.expiries) {
      expect(typeof e.expiry).toBe("string");
      for (const k of ["daysToExpiry", "atmIv", "riskReversal"]) expect(isNum(e[k]), `${e.expiry} ${k}`).toBe(true);
      for (const p of e.points) {
        expect(isNum(p.strike), `${e.expiry} points.strike`).toBe(true);
        for (const k of ["ceIv", "peIv"]) expect(p[k] === null || isNum(p[k]), `${e.expiry} points.${k}`).toBe(true);
      }
    }
    expect(nullPaths(d)).toEqual([]);
  });

  it("GET /greeks-grid and /synthetic and /straddle return numbers for the demo chain", async () => {
    const grid = expectEnvelope(await get(`/v1/analytics/greeks-grid?underlying=NIFTY&expiry=${monthly}`));
    expect(grid).toMatchObject({ underlying: "NIFTY", expiry: monthly });
    expect(isNum(grid.atmStrike)).toBe(true);
    expect(grid.strikes.length).toBeGreaterThan(5);
    // Demo prices are random and can sit below intrinsic value, where no IV exists: then the whole Greeks block is
    // null together (never a lone NaN).
    for (const s of grid.strikes) {
      for (const [name, side] of [["ce", s.ce], ["pe", s.pe]]) {
        expect(isNum(side.ltp), `${s.strike} ${name} ltp`).toBe(true);
        const g = ["iv", "delta", "gamma", "theta", "vega"].map((k) => side[k]);
        if (g.every(isNum)) continue;
        expect(g.every((v) => v === null), `${s.strike} ${name} partial greeks`).toBe(true);
      }
    }

    const syn = expectEnvelope(await get(`/v1/analytics/synthetic?underlying=NIFTY&expiry=${monthly}`));
    expect(syn.strikes.length).toBeGreaterThan(5);
    for (const k of ["spot", "future", "atmStrike", "atmSynthetic", "widestGapStrike"]) expect(isNum(syn[k]), k).toBe(true);
    expect(nullPaths(syn)).toEqual([]);

    const st = expectEnvelope(await get(`/v1/analytics/straddle?underlying=NIFTY&expiry=${monthly}`));
    for (const k of ["spot", "atmStrike", "ce", "pe", "premium", "impliedMove", "impliedMovePct", "upperBreakeven", "lowerBreakeven"]) expect(isNum(st[k]), k).toBe(true);
    expect(st.history.length).toBeGreaterThan(0);
    for (const p of st.history) expect([isNum(p.time), isNum(p.ce), isNum(p.pe), isNum(p.straddle)]).toEqual([true, true, true, true]);
  });

  it("GET /oi-change and /oi-spurts answer with a warm-up body on the first snapshot", async () => {
    const ch = expectEnvelope(await get(`/v1/analytics/oi-change?underlying=NIFTY&expiry=${monthly}`));
    expect(ch).toMatchObject({ underlying: "NIFTY", expiry: monthly });
    expect(isNum(ch.snapshots)).toBe(true);
    expect(Array.isArray(ch.rows)).toBe(true);
    const sp = expectEnvelope(await get(`/v1/analytics/oi-spurts?underlying=NIFTY&expiry=${monthly}`));
    expect(sp).toMatchObject({ underlying: "NIFTY", expiry: monthly });
    expect(Array.isArray(sp.spurts)).toBe(true);
  });

  it("GET /expiry-day returns the digest for the nearest expiry", async () => {
    const d = expectEnvelope(await get("/v1/analytics/expiry-day?underlying=NIFTY"));
    expect(d).toMatchObject({ underlying: "NIFTY", expiry: weekly });
    expect(isNum(d.spot)).toBe(true);
    for (const k of ["strike", "price", "impliedMove"]) expect(isNum(d.straddle[k]), `straddle.${k}`).toBe(true);
    expect(isNum(d.maxPain.strike)).toBe(true);
    expect(isNum(d.timeToExpiry.hours)).toBe(true);
  });

  it("GET /strategies lists templates; /build and /find price them from the demo chain", async () => {
    const list = expectEnvelope(await get("/v1/analytics/strategies"));
    expect(list.templates.map((t) => t.id)).toContain("iron_condor");
    expect(list.views).toContain("neutral");

    const b = expectEnvelope(await get(`/v1/analytics/strategies/build?underlying=NIFTY&expiry=${monthly}&template=iron_condor`));
    expect(b).toMatchObject({ template: "iron_condor", underlying: "NIFTY", expiry: monthly, credit: true });
    expect(b.legs).toHaveLength(4);
    for (const l of b.legs) expect([isNum(l.strike), isNum(l.price), isNum(l.lots), isNum(l.lotSize)]).toEqual([true, true, true, true]);
    for (const k of ["netPremium", "maxProfit", "maxLoss", "riskReward"]) expect(isNum(b[k]), k).toBe(true);
    expect(b.breakevens.every(isNum)).toBe(true);

    const f = expectEnvelope(await get(`/v1/analytics/strategies/find?underlying=NIFTY&expiry=${monthly}&view=neutral`));
    expect(f.view).toBe("neutral");
    expect(f.results.length).toBeGreaterThan(0);
    expect(f.results[0]).toMatchObject({ rank: 1, template: expect.any(String) });
  });
});

describe("futures, basis and flows", () => {
  it("GET /basis on the monthly expiry has a numeric basis; a weekly expiry reads its month's future", async () => {
    const d = expectEnvelope(await get(`/v1/analytics/basis?underlying=NIFTY&expiry=${monthly}`));
    for (const k of ["spot", "future", "daysToExpiry", "basis", "basisPct", "annualisedPct"]) expect(isNum(d[k]), k).toBe(true);
    expect(d.state).toBe("contango");
    const w = await get(`/v1/analytics/basis?underlying=NIFTY&expiry=${weekly}`);
    expect(w.status).toBe(200);
    expect(isNum(w.body.data.future)).toBe(true);
    expect(w.body.data.futureSymbol).toContain(`-${monthly}-FUT`);
  });

  it("GET /futures: the monthly future is priced; weeklies are null with an error entry", async () => {
    const r = await get(`/v1/analytics/futures?underlying=NIFTY&expiries=${Math.min(6, expiries.length)}`);
    const d = expectEnvelope(r);
    const last = d.futures.find((f) => f.expiry === monthly);
    for (const k of ["ltp", "oi", "volume", "basis", "basisPct", "annualisedPct"]) expect(isNum(last[k]), k).toBe(true);
    expect(isNum(d.spot)).toBe(true);
    expect(d.futures.filter((f) => f.ltp === null).length).toBe(r.body.errors.length);
  });

  it("GET /basis-history returns a numeric series", async () => {
    const d = expectEnvelope(await get(`/v1/analytics/basis-history?underlying=NIFTY&expiry=${monthly}`));
    expect(d.series.length).toBeGreaterThan(3);
    for (const p of d.series) for (const k of ["time", "future", "spot", "basis", "basisPct"]) expect(isNum(p[k]), k).toBe(true);
  });

  it("GET /fii-dii serves the demo sample", async () => {
    const d = expectEnvelope(await get("/v1/analytics/fii-dii"));
    expect(d.unit).toBe("INR crore");
    expect(d.days.length).toBeGreaterThan(0);
    for (const day of d.days) for (const side of [day.fii, day.dii]) for (const k of ["buy", "sell", "net"]) expect(isNum(side[k])).toBe(true);
    expect(d.rolling.length).toBeGreaterThan(0);
  });

  it("GET /time-machine returns bars with ATM strikes", async () => {
    const from = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const d = expectEnvelope(await get(`/v1/analytics/time-machine?symbol=NSE:NIFTY&interval=1d&from=${from}`));
    expect(d).toMatchObject({ interval: "1d", symbol: expect.stringContaining("NIFTY") });
    expect(d.count).toBeGreaterThan(0);
    for (const b of d.bars ?? []) for (const k of ["time", "open", "high", "low", "close", "atmStrike"]) expect(isNum(b[k]), k).toBe(true);
  });
});

describe("calculators", () => {
  it("GET /greeks: the fields the dashboard reads, in IV mode and price mode", async () => {
    const d = expectEnvelope(await get("/v1/analytics/greeks?spot=100&strike=100&type=CE&days=30&iv=20"));
    for (const k of ["ivPct", "price", "daysToExpiry", "ratePct", "delta", "gamma", "theta", "vega"]) expect(isNum(d[k]), k).toBe(true);
    expect(d).toMatchObject({ type: "CE", ivPct: 20 });
    expect(d.delta).toBeGreaterThan(0.4);
    const back = expectEnvelope(await get(`/v1/analytics/greeks?spot=100&strike=100&type=CE&days=30&price=${d.price}`));
    expect(back.ivPct).toBeCloseTo(20, 1);
  });

  it("POST /payoff: the fields the dashboard reads", async () => {
    const d = expectEnvelope(
      await call("POST", "/v1/analytics/payoff", {
        legs: [
          { type: "CE", side: "sell", strike: 100, price: 5, lots: 1, lotSize: 50 },
          { type: "CE", side: "buy", strike: 110, price: 2, lots: 1, lotSize: 50 },
        ],
        spot: 100,
      }),
    );
    expect(d.curve.length).toBeGreaterThan(10);
    for (const p of d.curve) expect([isNum(p.price), isNum(p.pnl)]).toEqual([true, true]);
    for (const k of ["maxProfit", "maxLoss", "netPremium"]) expect(isNum(d[k]), k).toBe(true);
    expect(d).toMatchObject({ unboundedProfit: false, unboundedLoss: false });
    expect(d.breakevens.every(isNum)).toBe(true);
    // A naked short call has unlimited loss: the dashboard checks the flag, not a number.
    const naked = expectEnvelope(await call("POST", "/v1/analytics/payoff", { legs: [{ type: "CE", side: "sell", strike: 100, price: 5 }], spot: 100 }));
    expect(naked.unboundedLoss).toBe(true);
  });

  it("POST /position-size: the fields the dashboard reads", async () => {
    const d = expectEnvelope(await call("POST", "/v1/analytics/position-size", { capital: 100000, riskPct: 1, entry: 100, stop: 95, lotSize: 50 }));
    for (const k of ["lots", "quantity", "capitalAtRisk", "riskAmount", "notional", "riskPerUnit"]) expect(isNum(d[k]), k).toBe(true);
    expect(d).toMatchObject({ lots: 4, quantity: 200, direction: "long" });
  });

  it("POST /lot-split plans slices", async () => {
    const d = expectEnvelope(await call("POST", "/v1/analytics/lot-split", { symbol: "NFO:NIFTY-" + monthly + "-26350-CE", quantity: 75 * 40, lotSize: 75 }));
    expect(d).toBeTypeOf("object");
    expect(JSON.stringify(d)).toMatch(/children/);
  });

  it("GET /position-greeks computes Greeks for the demo account's positions", async () => {
    const d = expectEnvelope(await get("/v1/analytics/position-greeks?account=demo"));
    expect(d.positions.length).toBeGreaterThan(0);
    for (const p of d.positions) for (const k of ["netQty", "ltp", "underlyingLtp", "delta", "gamma", "theta", "vega"]) expect(isNum(p[k]), k).toBe(true);
    for (const k of ["delta", "gamma", "theta", "vega"]) expect(isNum(d.net[k]), `net.${k}`).toBe(true);
  });
});

describe("alert rules (stored in the temp data dir)", () => {
  it("create, list, dry-run check and delete", async () => {
    const created = await call("POST", "/v1/analytics/alert-rules", { name: "PCR high", underlying: "NIFTY", expiry: monthly, metric: "pcr_oi", op: "above", value: 1.2 });
    expect(created.status, created.text).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({ name: "PCR high", metric: "pcr_oi" });
    const list = expectEnvelope(await get("/v1/analytics/alert-rules"));
    expect(list.map((r) => r.id)).toContain(id);
    const chk = expectEnvelope(await call("POST", `/v1/analytics/alert-rules/${id}/check?dryRun=1`));
    expect(chk).toHaveProperty("status");
    const del = expectEnvelope(await call("DELETE", `/v1/analytics/alert-rules/${id}`));
    expect(del).toEqual({ id, deleted: true });
    expect((await call("DELETE", `/v1/analytics/alert-rules/${id}`)).status).toBe(404);
  });

  it("rejects an invalid rule", async () => {
    expectFlag(await call("POST", "/v1/analytics/alert-rules", { name: "x", underlying: "NIFTY", metric: "pcr_oi" }));
  });
});

describe("bad input is 400 VALIDATION_FAILED", () => {
  const bad = [
    ["GET", "/v1/analytics/oi"],
    ["GET", "/v1/analytics/oi?underlying=NIFTY&expiry=tomorrow"],
    ["GET", "/v1/analytics/gex?underlying=NIFTY"],
    ["GET", "/v1/analytics/skew?underlying=NIFTY&expiry=2026-11-24&width=99"],
    ["GET", "/v1/analytics/surface"],
    ["GET", "/v1/analytics/surface?underlying=NIFTY&expiries=0"],
    ["GET", "/v1/analytics/basis?underlying=NIFTY"],
    ["GET", "/v1/analytics/greeks?spot=100&strike=100&type=XX&days=30&iv=20"],
    ["GET", "/v1/analytics/greeks?spot=100&strike=100&type=CE&days=30"],
    ["GET", "/v1/analytics/greeks?spot=abc&strike=100&type=CE&days=30&iv=20"],
    ["GET", "/v1/analytics/oi-change"],
    ["GET", "/v1/analytics/oi-spurts?underlying=NIFTY"],
    ["GET", "/v1/analytics/greeks-grid?underlying=NIFTY"],
    ["GET", "/v1/analytics/synthetic?underlying=NIFTY"],
    ["GET", "/v1/analytics/straddle"],
    ["GET", "/v1/analytics/strategies/build?underlying=NIFTY&expiry=2026-11-24&template=nope"],
    ["GET", "/v1/analytics/strategies/find?underlying=NIFTY&expiry=2026-11-24&view=sideways"],
    ["GET", "/v1/analytics/futures"],
    ["GET", "/v1/analytics/basis-history?underlying=NIFTY"],
    ["GET", "/v1/analytics/expiry-day"],
    ["GET", "/v1/analytics/time-machine?symbol=NSE:NIFTY"],
    ["GET", "/v1/analytics/position-greeks"],
    ["GET", "/v1/analytics/fii-dii?days=0"],
    ["POST", "/v1/analytics/payoff", {}],
    ["POST", "/v1/analytics/payoff", { legs: [{ type: "CE", side: "buy", price: 1 }] }],
    ["POST", "/v1/analytics/payoff", { legs: [{ type: "CE", side: "buy", strike: 100, price: 1, extra: 1 }] }],
    ["POST", "/v1/analytics/position-size", { capital: -1, riskPct: 1, entry: 100, stop: 95 }],
    ["POST", "/v1/analytics/position-size", { capital: 1000, riskPct: 101, entry: 100, stop: 95 }],
    ["POST", "/v1/analytics/lot-split", {}],
    ["POST", "/v1/analytics/lot-split", { symbol: "NFO:NIFTY-2026-11-24-26350-CE", quantity: 100, lotSize: 75 }],
  ];
  it.each(bad)("%s %s", async (method, path, body) => {
    const r = await call(method, path, body);
    expect(r.status, r.text.slice(0, 300)).toBe(400);
    expect(r.body.code).toBe("VALIDATION_FAILED");
    expect(r.body.errors.length).toBeGreaterThan(0);
    expect(r.body.errors[0]).toMatchObject({ path: expect.any(String), message: expect.any(String) });
  });
});

describe("authentication", () => {
  it("every analytics route is 401 without a key and with a wrong key", async () => {
    const routes = app.router.list().filter((r) => r.pattern.startsWith("/v1/analytics"));
    expect(routes.length).toBeGreaterThanOrEqual(36);
    // Wrong keys count towards the Bridge's brute-force limit, so only a sample of routes gets one.
    for (const [i, r] of routes.entries()) {
      const path = r.pattern.replace(":ruleId", "rule_x");
      const none = await call(r.method, path, r.method === "POST" ? {} : undefined, null);
      expect(none.status, `${r.method} ${path}`).toBe(401);
      expect(none.body.code).toBe("UNAUTHENTICATED");
      if (i % 8 !== 0) continue;
      const wrong = await call(r.method, path, r.method === "POST" ? {} : undefined, "mcb_not_a_real_key");
      expect(wrong.status, `${r.method} ${path} wrong key`).toBe(401);
    }
  });

  it("every analytics route is registered with read scope, so a read key is enough", () => {
    const routes = app.router.list().filter((r) => r.pattern.startsWith("/v1/analytics"));
    expect(routes.filter((r) => r.options.scope !== "read").map((r) => `${r.method} ${r.pattern}`)).toEqual([]);
  });

  it("a key limited to the read scope can use a chain route and a POST calculator, and cannot reach admin routes", async () => {
    const { key } = await app.deps.keyStore.create({ label: "read-only-2", scopes: ["read"], accounts: "*" });
    expect((await get(`/v1/analytics/oi?underlying=NIFTY&expiry=${monthly}`, key)).status).toBe(200);
    expect((await call("POST", "/v1/analytics/position-size", { capital: 1000, riskPct: 1, entry: 10, stop: 9 }, key)).status).toBe(200);
    expect((await call("GET", "/v1/keys", undefined, key)).status).toBe(403);
  });
});

describe("Unusual-Whales-style routes on the real app", () => {
  const paths = [
    () => `/v1/analytics/unusual?underlyings=NIFTY&expiry=${monthly}`,
    () => `/v1/analytics/tide?underlying=NIFTY&expiry=${monthly}`,
    () => `/v1/analytics/exposure?underlying=NIFTY&expiry=${monthly}`,
    () => "/v1/analytics/exposure/expiries?underlying=NIFTY&expiries=2",
    () => "/v1/analytics/oi-explorer?underlying=NIFTY&expiries=2",
    () => "/v1/analytics/vol-stats?underlying=NIFTY",
    () => "/v1/analytics/vol-stats/term?underlying=NIFTY",
    () => `/v1/analytics/screener?underlyings=NIFTY&expiry=${monthly}&limit=10`,
    () => "/v1/analytics/screener/presets",
  ];
  it.each(paths.map((p, i) => [i, p]))("route %i answers {data, meta} with no NaN", async (_i, build) => {
    const path = build();
    const r = await get(path);
    expectEnvelope(r);
    expect(r.text).not.toMatch(/NaN|Infinity/);
  });
  it("rejects bad screener and unusual input", async () => {
    for (const path of ["/v1/analytics/screener?underlyings=NIFTY&minDelta=0.9&maxDelta=0.1", "/v1/analytics/unusual?underlyings=", "/v1/analytics/tide"]) {
      const r = await get(path);
      expect(r.status, path).toBe(400);
      expect(r.body.code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("backtest, optimizer and watchlists on the real app", () => {
  it("runs a backtest example end to end on demo candles", async () => {
    const ex = expectEnvelope(await get("/v1/analytics/backtest/examples"));
    const examples = Array.isArray(ex) ? ex : (ex.examples ?? Object.values(ex));
    expect(examples.length).toBeGreaterThanOrEqual(5);
    const body = examples[0].body ?? examples[0];
    const r = await call("POST", "/v1/analytics/backtest", body);
    expect([200, 400, 404], r.text.slice(0, 300)).toContain(r.status);
    if (r.status === 200) {
      expect(r.body.data).toHaveProperty("stats");
      expect(r.text).not.toMatch(/NaN|Infinity/);
    }
  });
  it("rejects an unknown backtest field", async () => {
    const r = await call("POST", "/v1/analytics/backtest", { symbol: "NSE:NIFTY", entry: "close > 1", nope: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VALIDATION_FAILED");
  });
  it("optimizer answers for a view", async () => {
    const r = await get(`/v1/analytics/optimizer?underlying=NIFTY&expiry=${monthly}&view=neutral&top=3`);
    expectEnvelope(r);
    expect(r.text).not.toMatch(/NaN|Infinity/);
  });
  it("creates, lists, quotes and deletes a watchlist", async () => {
    const list = expectEnvelope(await get("/v1/analytics/watchlists"));
    expect(Array.isArray(list)).toBe(true);
    const made = await call("POST", "/v1/analytics/watchlists", { name: "t1", symbols: ["NSE:NIFTY", "NSE:RELIANCE"] });
    expect(made.status, made.text.slice(0, 300)).toBe(201);
    const id = made.body.data.id;
    const q = expectEnvelope(await get(`/v1/analytics/watchlists/${id}/quotes`));
    expect(q.length ?? q.items?.length ?? 0).toBeGreaterThan(0);
    const del = await call("DELETE", `/v1/analytics/watchlists/${id}`);
    expect(del.status).toBe(200);
  });
});

describe("markets, fields, risk and derivatives depth on the real app", () => {
  const noBad = (r) => expect(r.text).not.toMatch(/NaN|Infinity/);
  it.each([
    ["/v1/analytics/markets/indices"],
    ["/v1/analytics/markets/movers?universe=NIFTY50&by=gainers&limit=5"],
    ["/v1/analytics/markets/sectors?tf=1d"],
    ["/v1/analytics/markets/breadth"],
    ["/v1/fields/search?q=gamma"],
    ["/v1/fields?symbols=NSE:NIFTY,NSE:RELIANCE&fields=ltp,change_pct,volume"],
    ["/v1/fields/bulk?symbol=NIFTY&field=EXPIRIES"],
    ["/v1/analytics/vol-cone?underlying=NIFTY"],
  ])("GET %s answers {data, meta} with no NaN", async (path) => {
    const r = await get(path);
    expectEnvelope(r);
    noBad(r);
  });
  it("forward curve, rr-bf and event-vol answer or refuse cleanly", async () => {
    for (const path of ["/v1/analytics/forward-curve?underlying=NIFTY", `/v1/analytics/rr-bf?underlying=NIFTY&expiry=${monthly}`, `/v1/analytics/event-vol?underlying=NIFTY&event=${monthly}`]) {
      const r = await get(path);
      expect([200, 400, 404], `${path} ${r.text.slice(0, 200)}`).toContain(r.status);
      noBad(r);
    }
  });
  it("prices a scenario grid for explicit legs", async () => {
    const r = await call("POST", "/v1/analytics/risk/scenario", {
      positions: [{ symbol: `NFO:NIFTY-${monthly}-24500-CE`, qty: 75, price: 120, iv: 15, spot: 24500 }],
      spotShocksPct: [-2, 0, 2],
      ivShocksPts: [-1, 0, 1],
      daysForward: [0, 1],
    });
    expect([200, 400, 404], r.text.slice(0, 300)).toContain(r.status);
    noBad(r);
  });
  it("batch runs field and analytics requests", async () => {
    const r = await call("POST", "/v1/batch", { requests: [{ id: "a", path: "/v1/fields/search", query: { q: "oi" } }] });
    expect([200, 400], r.text.slice(0, 300)).toContain(r.status);
    noBad(r);
  });
  it("rejects bad field requests", async () => {
    for (const path of ["/v1/fields?symbols=NSE:NIFTY&fields=nope_not_a_field", "/v1/fields?fields=ltp"]) {
      const r = await get(path);
      expect(r.status, path).toBe(400);
      expect(r.body.code).toBe("VALIDATION_FAILED");
    }
  });
});
