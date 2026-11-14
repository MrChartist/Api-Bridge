import { describe, expect, it } from "vitest";
import { applyModuleConfig } from "../core/modules.mjs";
import libraryModule from "./module.mjs";
import { DEFAULT_STRIKE_STEPS, LIBRARY_CONFIG_SCHEMA, parseLibraryConfig } from "./config.mjs";

describe("library config", () => {
  it("{} gives the defaults, with the usual index strike steps", () => {
    const c = parseLibraryConfig({});
    expect(c).toMatchObject({ enabled: true, maxCollections: 200, maxSymbols: 5000, maxWeeklyExpiries: 5, allowStaleAtm: false });
    expect(c.strikeSteps).toEqual(DEFAULT_STRIKE_STEPS);
    expect(c.strikeSteps).toMatchObject({ NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100 });
    expect(parseLibraryConfig(undefined).maxSymbols).toBe(5000);
  });

  it("strikeSteps adds to, and overrides, the defaults; a stock is never in the defaults", () => {
    const c = parseLibraryConfig({ strikeSteps: { NIFTY: 100, RELIANCE: 20 } });
    expect(c.strikeSteps.NIFTY).toBe(100);
    expect(c.strikeSteps.RELIANCE).toBe(20);
    expect(c.strikeSteps.BANKNIFTY).toBe(100);
    expect(DEFAULT_STRIKE_STEPS.RELIANCE).toBeUndefined();
  });

  it("refuses unknown keys and out-of-range values", () => {
    for (const bad of [{ nope: 1 }, { maxCollections: 0 }, { maxSymbols: 100_000 }, { maxWeeklyExpiries: 20 }, { strikeSteps: { nifty: 50 } }, { strikeSteps: { NIFTY: 0 } }, { allowStaleAtm: "yes" }]) {
      expect(LIBRARY_CONFIG_SCHEMA.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the module owns the `library` section: core validates it and fills the defaults", () => {
    const out = applyModuleConfig({ library: { maxSymbols: 100 } }, [libraryModule]);
    expect(out.library).toMatchObject({ maxSymbols: 100, maxCollections: 200 });
    expect(() => applyModuleConfig({ library: { maxSymbols: 0 } }, [libraryModule])).toThrow(/library\.maxSymbols/);
    expect(applyModuleConfig({}, [libraryModule]).library.enabled).toBe(true);
  });
});
