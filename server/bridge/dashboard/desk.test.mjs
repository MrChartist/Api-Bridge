/** Option chain settings (desk.js): saved shapes migrate, presets are recognised, the strikes window migrates. */
import { describe, expect, it } from "vitest";

// views.js imports desk.js (the router): load it first so the circular import settles as in the browser.
await import("./views.js");
const { CHAIN_COLUMNS, CHAIN_PRESETS, chainConfig, presetOf, strikesPref } = await import("./desk.js");

describe("chain settings", () => {
  it("fills defaults for an empty or broken save", () => {
    for (const saved of [undefined, null, "x", {}]) {
      const c = chainConfig(saved);
      expect(c.cols).toEqual(CHAIN_PRESETS.oi);
      expect(c.side).toBe("both");
      expect(c.phoneSide).toBe("ce");
      expect(c.preset).toBe("oi");
      expect(c.tags).toEqual({ mp: true, walls: true, em: true, em2: false });
    }
  });

  it("migrates an older saved shape and drops unknown columns", () => {
    const old = { cols: ["ltp", "nope", "iv", "ltp"], side: "pe", quotes: false, bars: { oi: false }, tags: { mp: false } };
    const c = chainConfig(old);
    expect(c.cols).toEqual(["ltp", "iv"]);
    expect(c.side).toBe("pe");
    expect(c.phoneSide).toBe("ce");
    expect(c.quotes).toBe(false);
    expect(c.bars).toEqual({ oi: false, chg: true, vol: true });
    expect(c.tags).toEqual({ mp: false, walls: true, em: true, em2: false });
    expect(c.preset).toBe("custom");
  });

  it("knows the persona presets; Arb always shows bid and ask", () => {
    for (const p of Object.keys(CHAIN_PRESETS)) expect(presetOf(CHAIN_PRESETS[p])).toBe(p);
    const known = new Set(CHAIN_COLUMNS.map((c) => c[0]));
    for (const cols of Object.values(CHAIN_PRESETS)) for (const k of cols) expect(known.has(k), k).toBe(true);
    expect(chainConfig({ cols: CHAIN_PRESETS.arb, quotes: false }).quotes).toBe(true);
    expect(chainConfig({ cols: CHAIN_PRESETS.buyer, quotes: false }).quotes).toBe(false);
  });

  it("migrates the strikes window: ±8 and ±12 become ±10", () => {
    expect(strikesPref("8")).toBe("10");
    expect(strikesPref("12")).toBe("10");
    expect(strikesPref("20")).toBe("20");
    expect(strikesPref("all")).toBe("all");
    expect(strikesPref(undefined)).toBe("10");
  });
});
