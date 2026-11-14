/** A real LibraryService over the fakes, with a temp data folder and a recording event bus. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNullLogger } from "../../core/logger.mjs";
import { createLibraryService } from "../service.mjs";
import { NOW, calendarWith, fakeSymbols, standardMarket } from "./fakes.mjs";

const made = [];

/**
 * @param {{ now?: number, holidays?: string[], library?: object, market?: object, symbols?: any, dataDir?: string, niftyExpiries?: string[] }} [o]
 */
export function makeLibrary(o = {}) {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "mcb-lib-"));
  if (!o.dataDir) made.push(dataDir);
  const clock = { t: o.now ?? NOW, now() { return this.t; } };
  const events = [];
  const market = o.market ?? standardMarket({ now: () => clock.t });
  const symbols = o.symbols ?? fakeSymbols(o.niftyExpiries ? { niftyExpiries: o.niftyExpiries } : {});
  const warnings = [];
  const deps = {
    config: { dataDir, library: o.library ?? {} },
    logger: { ...createNullLogger(), warn: (m, f) => warnings.push([m, f]) },
    bus: { emit: (topic, payload) => events.push([topic, payload]) },
    clock,
    marketData: market,
    symbols,
  };
  const lib = createLibraryService(deps, { calendar: calendarWith(o.holidays ?? []) });
  return { lib, dataDir, clock, events, market, symbols, warnings, deps };
}

export function cleanupLibraries() {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
}
