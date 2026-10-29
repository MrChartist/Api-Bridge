/**
 * /v1/optionchain ivModel (docs/spec/p1-03-pricing-vol.md §3.9, §10, §9.3): the legacy default is byte-for-byte the
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

describe("ivModel on the service", () => {
  it("the legacy default is unchanged byte for byte", async () => {
    expect(`${JSON.stringify(await chains(null), null, 1)}\n`).toBe(FIXTURE);
    expect(`${JSON.stringify(await chains("legacy-bs-spot"), null, 1)}\n`).toBe(FIXTURE);
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
