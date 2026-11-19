import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeStreamHub } from "../stream/fake.mjs";
import { TICKS_CONFIG_SCHEMA } from "./config.mjs";
import { createTicksModule, pruneTickLog } from "./module.mjs";
import { tickFileName } from "./tickLog.mjs";

const NOW = Date.parse("2026-11-18T10:00:00+05:30");
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ticks-mod-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(ticks) {
  const bus = createEventBus({ logger: createNullLogger() });
  const clock = { now: () => NOW };
  return { bus, clock, config: { ticks }, logger: createNullLogger(), paths: { dataDir: dir }, streamHub: createFakeStreamHub({ bus, clock }), metrics: undefined };
}

describe("ticks module", () => {
  it("is off by default: no folder, no subscription", async () => {
    const d = deps(undefined);
    const m = createTicksModule();
    await m.start(d);
    d.streamHub.pushTick({ symbol: "NSE:NIFTY", ltp: 1 });
    await m.stop(d);
    expect(existsSync(join(dir, "ticks"))).toBe(false);
    expect(d.streamHub.calls).toEqual([]);
  });

  it("records the symbols asked for, subscribing them itself", async () => {
    const d = deps({ record: true, symbols: ["NSE:NIFTY"] });
    const m = createTicksModule();
    await m.start(d);
    expect(d.streamHub.calls[0]).toEqual(["subscribe", "tick-log", ["NSE:NIFTY"], "quote"]);
    d.streamHub.pushTick({ symbol: "NSE:NIFTY", ltp: 24000.5 });
    d.streamHub.pushTick({ symbol: "NSE:INFY", ltp: 1500 }); // not asked for
    await m.stop(d);
    const lines = readFileSync(join(dir, "ticks", tickFileName("2026-11-18")), "utf8").split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ q: 1, s: "NSE:NIFTY", p: 24000.5 })]);
    expect(d.streamHub.calls.at(-1)).toEqual(["dropClient", "tick-log"]);
  });

  it("prunes days older than keepDays", () => {
    const root = join(dir, "ticks");
    mkdirSync(root);
    for (const day of ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18"]) writeFileSync(join(root, tickFileName(day)), "");
    writeFileSync(join(root, "notes.txt"), "");
    expect(pruneTickLog(root, 2, NOW).sort()).toEqual([tickFileName("2026-11-15"), tickFileName("2026-11-16")]);
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
    expect(pruneTickLog(root, null, NOW)).toEqual([]);
  });

  it("validates its config section", () => {
    expect(TICKS_CONFIG_SCHEMA.parse({})).toEqual({ record: false, symbols: null, maxBufferedTicks: 5000, flushEveryMs: 250, keepDays: null });
    expect(() => TICKS_CONFIG_SCHEMA.parse({ record: true, extra: 1 })).toThrow();
    expect(() => TICKS_CONFIG_SCHEMA.parse({ maxBufferedTicks: 1 })).toThrow();
  });
});
