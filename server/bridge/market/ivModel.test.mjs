/**
 * /v1/optionchain ivModel: the legacy default is byte-for-byte the
 * output before this change (fixture generated from the p1-integration base with the same helpers); b76-forward
 * reprices every leg through dashboard/pricing.js, keeps the broker's IV as brokerIv and adds `pricing`; the
 * Deprecation and Link headers appear only when the legacy model was the implicit default; config flips the default.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { atmIvAt, greeks76, parityForward, smilePoints, volTime } from "../dashboard/pricing.js";
import { pricingContext } from "../vol/context.mjs";
import { applyB76 } from "./chain.mjs";
import { buildMarket } from "./__fixtures__/helpers.mjs";
import { LEGACY_IV_DEPRECATION } from "./routes.mjs";

const FIXTURE = readFileSync(new URL("./__fixtures__/chain_legacy_ivmodel.json", import.meta.url), "utf8");

async function chains(model, marketCfg = {}) {
  const out = {};
  for (const [name, params, opts] of [
    ["broker", { underlying: "NIFTY", expiry: "2026-10-27" }, {}],
    ["brokerNoGreeks", { underlying: "NIFTY", expiry: "2026-10-27", greeks: false }, {}],
    ["built", { underlying: "NIFTY", expiry: "2026-10-27" }, { market: { chain: { source: "built" } } }],
  ]) {
    const { md, settle } = buildMarket({ ...opts, market: { ...(opts.market ?? {}), ...marketCfg, chain: { ...(opts.market?.chain ?? {}), ...(marketCfg.chain ?? {}) } } });
    out[name] = await settle(md.optionChain(model ? { ...params, ivModel: model } : params), 60);
  }
  return out;
}

/** The contract-fact fields are additive; every legacy byte is still compared. */
const P1_6_FIELDS = ["underlyingKind", "settlement", "strikeStep", "tickSize"];
function legacyOnly(out) {
  const copy = {};
  for (const [k, c] of Object.entries(out)) copy[k] = Object.fromEntries(Object.entries(c).filter(([f]) => !P1_6_FIELDS.includes(f)));
  return copy;
}

describe("ivModel on the service", () => {
  it("the legacy default is unchanged byte for byte", async () => {
    expect(`${JSON.stringify(legacyOnly(await chains(null)), null, 1)}\n`).toBe(FIXTURE);
    expect(`${JSON.stringify(legacyOnly(await chains("legacy-bs-spot")), null, 1)}\n`).toBe(FIXTURE);
  });

  it("b76-forward prices every leg with pricing.js, keeps brokerIv and adds pricing", async () => {
    const { md, clock } = buildMarket();
    const c = await md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", ivModel: "b76-forward" });
    expect(c.pricing).toMatchObject({ model: "black76-parity-forward", ivModel: "b76-forward", priceBasis: "mid", forwardSource: "parity", rate: { value: 0.065, quality: "default" }, clock: { version: "vt1", mode: "weighted" } });
    expect(c.pricing.forwardStrikes).toBe(5);
    const ctx = pricingContext({ config: {}, exchange: "NFO", kind: "index", now: clock.now() });
    const vt = volTime(ctx, clock.now(), "2026-10-27");
    expect(c.pricing.clock.T).toBeCloseTo(vt.T, 9);
    expect(c.pricing.clock.Tcal).toBeCloseTo(vt.Tcal, 9);
    const F = parityForward(c, { rate: 0.065, Tcal: vt.Tcal }).F;
    expect(c.pricing.forward).toBeCloseTo(F, 3);
    const pts = smilePoints(c, { F, years: vt.T, rate: 0.065, Tcal: vt.Tcal });
    for (const row of c.rows) {
      const p = pts.find((x) => x.strike === row.strike);
      for (const side of ["ce", "pe"]) {
        const leg = row[side];
        expect(leg.greeksSource).toBe("computed");
        if (p[side].iv === null) expect(leg.iv).toBeNull();
        else {
          expect(Math.abs(leg.iv - p[side].iv)).toBeLessThan(1e-9);
          const g = greeks76(F, row.strike, vt.T, p[side].iv, side.toUpperCase(), { yearBasis: vt.yearBasis });
          expect(leg.theta).toBeCloseTo(g.theta, 6);
          expect(leg.delta).toBeCloseTo(g.delta, 6);
        }
      }
      // The CE legs carried the broker's 13.5 %; PE legs had none.
      expect(row.ce.brokerIv).toBe(13.5);
      expect(row.pe.brokerIv).toBeNull();
    }
    expect(atmIvAt(pts, F)).not.toBeNull();
  });

  it("greeks=false stays without Greeks under either model", async () => {
    const c = (await chains("b76-forward")).brokerNoGreeks;
    expect(c.pricing).toBeUndefined();
    expect(c.rows[0].ce.greeksSource).toBeNull();
  });

  it("market.chain.ivModelDefault flips the default", async () => {
    const c = (await chains(null, { chain: { ivModelDefault: "b76-forward" } })).broker;
    expect(c.pricing?.ivModel).toBe("b76-forward");
    const legacy = (await chains("legacy-bs-spot", { chain: { ivModelDefault: "b76-forward" } })).broker;
    expect(legacy.pricing).toBeUndefined();
  });

  it("says why a leg has no IV: SETTLING inside the expiry-day settlement window (Tue 3 Nov 15:20), TICK, NOQUOTE", () => {
    const nowMs = Date.parse("2026-11-03T15:20:00+05:30");
    const ctx = pricingContext({ config: {}, exchange: "NFO", kind: "index", now: nowMs });
    const F = 25150;
    const two = (p) => ({ bid: Math.max(0.05, p - 0.05), ask: p + 0.05, ltp: p, greeksSource: null });
    const rows = [25000, 25050, 25100, 25150, 25200, 25250, 25300].map((k) => {
      const atm = k === 25150 ? 2.05 : 0;
      return { strike: k, ce: two(Math.max(0.05, F - k) + atm), pe: two(Math.max(0.05, k - F) + atm) };
    });
    rows[0].pe = { bid: 0.05, ask: 0.05, ltp: 0.05, greeksSource: null };
    rows.push({ strike: 25350, ce: { bid: 0, ask: 0, ltp: null, greeksSource: null }, pe: two(200) });
    const c = applyB76({ underlying: "NIFTY", expiry: "2026-11-03", underlyingLtp: F, rows }, { ctx, nowMs, rate: 0.065 });
    const row = (k) => c.rows.find((r) => r.strike === k);
    expect(c.pricing.clock.T).toBeGreaterThan(0);
    expect(row(25000).ce).toMatchObject({ iv: null, ivReason: "SETTLING" });
    expect(row(25300).pe).toMatchObject({ iv: null, ivReason: "SETTLING" });
    expect(row(25000).pe).toMatchObject({ iv: null, ivReason: "TICK" });
    expect(row(25350).ce).toMatchObject({ iv: null, ivReason: "NOQUOTE" });
    expect(row(25150).ce.iv).toBeGreaterThan(5);
    expect(row(25150).ce.ivReason).toBeNull();
    // After the settlement every leg says SETTLED.
    const after = applyB76({ underlying: "NIFTY", expiry: "2026-11-03", underlyingLtp: F, rows }, { ctx, nowMs: Date.parse("2026-11-03T15:31:00+05:30"), rate: 0.065 });
    expect(after.rows.every((r) => r.ce.ivReason === "SETTLED" && r.pe.ivReason === "SETTLED")).toBe(true);
  });

  it("refuses an unknown model", async () => {
    const { md } = buildMarket();
    await expect(md.optionChain({ underlying: "NIFTY", expiry: "2026-10-27", ivModel: "bs" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("ivModel over HTTP (demo)", () => {
  let app;
  let base;
  let key;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-ivm-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["read"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });

  it("sends Deprecation and Link only when the legacy model was the implicit default", async () => {
    const exp = (await (await get("/v1/expiries?underlying=NIFTY")).json()).data.expiries[0];
    const implicit = await get(`/v1/optionchain?underlying=NIFTY&expiry=${exp}&strikes=5`);
    expect(implicit.status).toBe(200);
    expect(implicit.headers.get("deprecation")).toBe(`@${LEGACY_IV_DEPRECATION}`);
    expect(LEGACY_IV_DEPRECATION).toBe(1809109800);
    expect(implicit.headers.get("link")).toBe('</docs/CHANGELOG.md#optionchain-ivmodel>; rel="deprecation"');
    expect((await implicit.json()).data.pricing).toBeUndefined();
    const explicit = await get(`/v1/optionchain?underlying=NIFTY&expiry=${exp}&strikes=5&ivModel=legacy-bs-spot`);
    expect(explicit.headers.get("deprecation")).toBeNull();
    const b76 = await get(`/v1/optionchain?underlying=NIFTY&expiry=${exp}&strikes=5&ivModel=b76-forward`);
    expect(b76.headers.get("deprecation")).toBeNull();
    const body = await b76.json();
    expect(body.meta.demo).toBe(true);
    expect(body.data.pricing).toMatchObject({ ivModel: "b76-forward", rate: { value: 0.065, quality: "default" } });
    const bad = await get(`/v1/optionchain?underlying=NIFTY&expiry=${exp}&ivModel=nope`);
    expect(bad.status).toBe(400);
  });
});

describe("ivModel over HTTP with market.chain.ivModelDefault = b76-forward (demo)", () => {
  let app;
  let base;
  let key;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-ivm-b76-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" }, market: { chain: { ivModelDefault: "b76-forward" } } }, env: {}, demo: true });
    app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["read"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });
  const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });

  it("sends no Deprecation header when the implicit default is b76-forward, with or without Greeks", async () => {
    const exp = (await (await get("/v1/expiries?underlying=NIFTY")).json()).data.expiries[0];
    const noGreeks = await get(`/v1/optionchain?underlying=NIFTY&expiry=${exp}&strikes=5&greeks=false`);
    expect(noGreeks.status).toBe(200);
    expect(noGreeks.headers.get("deprecation")).toBeNull();
    expect(noGreeks.headers.get("link")).toBeNull();
    expect((await noGreeks.json()).data.pricing).toBeUndefined();
    const withGreeks = await get(`/v1/optionchain?underlying=NIFTY&expiry=${exp}&strikes=5`);
    expect(withGreeks.headers.get("deprecation")).toBeNull();
    expect((await withGreeks.json()).data.pricing?.ivModel).toBe("b76-forward");
  });
});
