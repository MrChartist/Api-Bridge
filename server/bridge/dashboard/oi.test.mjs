/** OI Analysis settings (oi.js): bad values fall back to the defaults; unlisted extra expiries are dropped. */
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router), which imports oi.js: load it first so the circular import settles.
await import("./views.js");
const { OI_DEFAULTS, oiConfig } = await import("./oi.js");

describe("OI page settings", () => {
  it("fills defaults for an empty or broken save", () => {
    for (const saved of [undefined, null, "x", [], {}]) {
      const c = oiConfig(saved);
      expect(c).toEqual({ window: "prev", metric: "oi", band: "10", unit: "lots", scope: "one", extra: {}, th: { ...OI_DEFAULTS.th } });
    }
  });

  it("keeps valid values and replaces bad ones", () => {
    const c = oiConfig({ window: "15", metric: "vol", band: "all", unit: "qty", scope: "all", th: { minLots: 25, minOiPct: 2, minPxPct: 1 } });
    expect(c).toMatchObject({ window: "15", metric: "vol", band: "all", unit: "qty", scope: "all", th: { minLots: 25, minOiPct: 2, minPxPct: 1 } });
    const bad = oiConfig({ window: "7", metric: "x", band: 15, unit: "kg", scope: "both", th: { minLots: -1, minOiPct: "a", minPxPct: 500 } });
    expect(bad).toMatchObject({ window: "prev", metric: "oi", band: "10", unit: "lots", scope: "one", th: { minLots: 10, minOiPct: 1, minPxPct: 0.5 } });
    expect(oiConfig({ band: 20, window: 60 })).toMatchObject({ band: "20", window: "60" });
  });

  it("keeps at most 3 real extra expiries and drops those no longer listed", () => {
    const saved = { extra: { NIFTY: ["2026-11-10", "2026-11-17", "bad", "2026-11-10", "2026-11-24", "2026-12-01"], BANKNIFTY: ["2026-11-24"], "bad key": ["2026-11-10"], SENSEX: "x" } };
    expect(oiConfig(saved).extra).toEqual({ NIFTY: ["2026-11-10", "2026-11-17", "2026-11-24"], BANKNIFTY: ["2026-11-24"] });
    const listed = oiConfig(saved, { underlying: "NIFTY", expiries: ["2026-11-03", "2026-11-17", "2026-12-01"] });
    expect(listed.extra).toEqual({ NIFTY: ["2026-11-17", "2026-12-01"], BANKNIFTY: ["2026-11-24"] });
    expect(oiConfig(saved, { underlying: "NIFTY", expiries: ["2026-11-03"] }).extra).toEqual({ BANKNIFTY: ["2026-11-24"] });
  });
});
