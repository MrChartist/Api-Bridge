/**
 * Acceptance criterion 2 of P1-3 (docs/spec/p1-03-pricing-vol.md §6.4, §9.2): one IV function on server and
 * dashboard. For NIFTY, BANKNIFTY and SENSEX demo chains at six fixed instants (including Friday 15:29, Monday 09:16
 * and expiry day 15:20), the server's GET /v1/optionchain?ivModel=b76-forward and the dashboard's options.js termRow
 * on the same JSON (with the clock context the page builds from the vol clock payload) agree: ATM IV within 0.05 vol
 * points and every leg's IV within 1e-9. The recovered ATM IV matches the demo's own smile at the forward within 0.15
 * vol points (tick rounding), so the demo prices on the same clock.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { termRow } from "../dashboard/options.js";
import { atmIvAt } from "../dashboard/pricing.js";
import { DEMO_UNDERLYINGS, expiriesFor, ivLevel, smileVol } from "../demo/demoAdapter.mjs";
import { createDemoRegistry } from "../demo/demoMode.mjs";

const INSTANTS = [
  "2026-10-29T10:00:00", // Thu: SENSEX expiry day, before the window
  "2026-10-30T15:29:00", // Fri, a minute before the close
  "2026-11-02T09:16:00", // Mon, a minute after the open
  "2026-11-03T15:20:00", // Tue: NIFTY expiry day, inside the settlement window
  "2026-11-05T15:20:00", // Thu: SENSEX expiry day, inside the window
  "2026-11-09T11:00:00", // Mon: NIFTY expiry moved forward by the Tue 10 Nov holiday
].map((s) => Date.parse(`${s}+05:30`));
const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "SENSEX"];

/** The dashboard's clock context, built only from the vol clock payload (what GET /v1/vol/clock returns). */
const clientContext = (clock) => ({
  mode: clock.settings.mode,
  nonTradingDayWeight: clock.settings.nonTradingDayWeight,
  overnightShare: clock.settings.overnightShare,
  eventDays: clock.settings.eventDays,
  yearBasis: clock.settings.yearBasis,
  settlementWindowMinutes: clock.settings.settlementWindowMinutes,
  session: { open: clock.settings.session.open, close: clock.settings.session.close },
  holidays: clock.holidays.map((h) => h.date),
});

describe("server and dashboard agree on IV (acceptance criterion 2)", () => {
  let app;
  let base;
  let key;
  let now = INSTANTS[0];
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-agree-"));
    const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
    const clock = { now: () => now };
    app = await createApp({ config, logger: createNullLogger(), clock, brokers: createDemoRegistry({ now: () => now }) });
    const { port } = await app.listen();
    base = `http://127.0.0.1:${port}`;
    ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["read"], accounts: "*" }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("ATM IV within 0.05 and every leg's IV within 1e-9; the demo smile is recovered within 0.15", async () => {
    let compared = 0;
    let legs = 0;
    let worstAtm = 0;
    let worstSmile = 0;
    for (const t0 of INSTANTS) {
      let step = 0;
      for (const u of UNDERLYINGS) {
        for (const expiry of expiriesFor(u, t0).slice(0, 3)) {
          // The Bridge's rate limiter runs on the same clock: move it 1.2 s per request so the demo budget refills.
          const t = t0 + (step += 1) * 1200;
          now = t;
          const r = await fetch(`${base}/v1/optionchain?underlying=${u}&expiry=${expiry}&ivModel=b76-forward&maxAgeMs=0`, { headers: { Authorization: `Bearer ${key}` } });
          expect(r.status, `${u} ${expiry}`).toBe(200);
          const chain = (await r.json()).data;
          const pricing = chain.pricing;
          expect(pricing.ivModel).toBe("b76-forward");
          if (!(pricing.clock.T > 0)) continue; // settled: nothing to solve
          const clock = await app.deps.vol.clock({ underlying: u, expiries: [expiry], at: t });
          const row = termRow(chain, { now: t, rate: pricing.rate.value, ctx: clientContext(clock) });
          // Same clock, same forward.
          expect(row.years).toBeCloseTo(pricing.clock.T, 9);
          expect(Math.abs(row.F - pricing.forward)).toBeLessThan(1e-3);
          // Carry is interest: on calendar time (Tcal), never on the vol-time T (§6.3).
          expect(row.carryPct / ((Math.log(row.F / chain.underlyingLtp) / pricing.clock.Tcal) * 100)).toBeCloseTo(1, 4);
          // Per leg: the server's IV is the dashboard's IV.
          for (const p of row.points) {
            const srv = chain.rows.find((x) => x.strike === p.strike);
            for (const side of ["ce", "pe"]) {
              const a = srv[side]?.iv ?? null;
              const b = p[side]?.iv ?? null;
              expect(a === null, `${u} ${expiry} ${p.strike} ${side} null-ness`).toBe(b === null);
              if (a !== null) {
                expect(Math.abs(a - b), `${u} ${expiry} ${p.strike} ${side}`).toBeLessThanOrEqual(1e-9);
                legs += 1;
              }
            }
          }
          const serverAtm = atmIvAt(chain.rows.map((x) => ({ strike: x.strike, ce: x.ce, pe: x.pe })), pricing.forward);
          expect(serverAtm, `${u} ${expiry}`).not.toBeNull();
          worstAtm = Math.max(worstAtm, Math.abs(serverAtm - row.atmIv));
          expect(Math.abs(serverAtm - row.atmIv), `${u} ${expiry}`).toBeLessThanOrEqual(0.05);
          // The engine recovers the demo's own smile at the forward (up to tick rounding). Inside the settlement
          // window the ATM premium is a few ticks, so the tick dominates there; the bound is checked outside it.
          const settling = row.points.some((p) => p.out === "settling") || pricing.clock.units < 0.03;
          if (!settling) {
            // ATM IV is linear in strike between the strikes bracketing F, so compare with the demo smile read the same
            // way (the demo smile has a kink at the spot, which a straight line between strikes does not follow).
            const uRow = DEMO_UNDERLYINGS.find((x) => x.symbol === u);
            const sm = (k) => 100 * smileVol(uRow, chain.underlyingLtp, k, pricing.clock.T, ivLevel(u, t));
            const ks = chain.rows.map((x) => x.strike);
            const lo = Math.max(...ks.filter((k) => k <= pricing.forward));
            const hi = Math.min(...ks.filter((k) => k > pricing.forward));
            const want = sm(lo) + ((sm(hi) - sm(lo)) * (pricing.forward - lo)) / (hi - lo);
            worstSmile = Math.max(worstSmile, Math.abs(serverAtm - want));
            expect(Math.abs(serverAtm - want), `${u} ${expiry} smile`).toBeLessThanOrEqual(0.15);
          }
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(40);
    expect(legs).toBeGreaterThan(3000);
    expect(worstAtm).toBeLessThanOrEqual(0.05);
    expect(worstSmile).toBeLessThanOrEqual(0.15);
  }, 60_000);
});
