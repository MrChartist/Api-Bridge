/**
 * OPS-07: a full disk. The monitor reports it, health says "degraded", readiness says "not ready" when the disk is nearly
 * full, an unhandled ENOSPC becomes DISK_FULL, and a paper order is never accepted unless it was saved.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_MODULES } from "../core/builtinModules.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createPaperEngine } from "../paper/paperEngine.mjs";
import { paperConfig } from "../paper/config.mjs";
import { createFileStore } from "../paper/paperStore.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { noteWriteFailure, resetWriteFailures } from "../../lib/storageHealth.mjs";
import { writeFileAtomic } from "../../lib/jsonl.mjs";
import { createStorageMonitor } from "./monitor.mjs";
import { STORAGE_CONFIG_SCHEMA } from "./config.mjs";
import { createStorageModule } from "./module.mjs";

const MB = 1024 * 1024;
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
const space = (freeMb) => () => ({ bavail: freeMb, bsize: MB, blocks: 10_000 });
const cfg = (o = {}) => STORAGE_CONFIG_SCHEMA.parse(o);

beforeEach(() => resetWriteFailures());

describe("the storage monitor", () => {
  it("goes ok -> low -> critical -> ok on free space, and tells the bus once per change", () => {
    let free = 5000;
    const bus = createEventBus();
    const heard = [];
    bus.on("storage.status", (e) => heard.push(e));
    const m = createStorageMonitor({ dataDir: "/data", cfg: cfg(), bus, statfs: () => space(free)(), now: () => 1 });
    expect(m.check()).toBe("ok");
    expect(heard).toEqual([]);
    free = 900;
    expect(m.check()).toBe("low");
    expect(m.check()).toBe("low"); // no repeat
    free = 150;
    expect(m.check()).toBe("critical");
    free = 5000;
    expect(m.check()).toBe("ok");
    expect(heard.map((e) => [e.previous, e.level, e.freeMb])).toEqual([["ok", "low", 900], ["low", "critical", 150], ["critical", "ok", 5000]]);
    expect(heard[1].message).toMatch(/almost full/);
  });

  it("a write that failed because the disk is full is critical at once, and clears when the file is written again", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-disk-"));
    const m = createStorageMonitor({ dataDir: dir, cfg: cfg(), statfs: () => space(50_000)(), now: () => 1 });
    expect(m.check()).toBe("ok");
    noteWriteFailure(join(dir, "orders", "state.json"), enospc());
    expect(m.check()).toBe("critical");
    expect(m.status().writeErrors).toMatchObject({ open: 1, total: 1, last: { file: "state.json", code: "ENOSPC" } });
    expect(m.problems().map((p) => p.code)).toEqual(["storage_critical", "write_errors"]);
    writeFileAtomic(join(dir, "orders", "state.json"), "{}");
    expect(m.check()).toBe("ok");
    expect(m.problems()).toEqual([]);
  });

  it("another error (permissions) is reported as a write problem but is not 'disk full'", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-disk-"));
    const m = createStorageMonitor({ dataDir: dir, cfg: cfg(), statfs: () => space(50_000)(), now: () => 1 });
    noteWriteFailure(join(dir, "keys.json"), Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(m.check()).toBe("ok");
    expect(m.problems().map((p) => p.code)).toEqual(["write_errors"]);
  });

  it("the thresholds are configurable and checked", () => {
    expect(() => cfg({ hardFreeMb: 5000, minFreeMb: 100 })).toThrow(/hardFreeMb/);
    expect(cfg({ minFreeMb: 500, hardFreeMb: 50 })).toMatchObject({ minFreeMb: 500, hardFreeMb: 50, checkIntervalSec: 30 });
  });
});

describe("health and readiness on a Bridge", () => {
  let app;
  let port;
  let state;
  beforeEach(async () => {
    state = { free: 50_000 };
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-disk-app-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 } }, env: {}, demo: true });
    const modules = BUILTIN_MODULES.map((m) => (m.name === "storage" ? createStorageModule({ statfs: () => space(state.free)() }) : m));
    app = await createApp({ config, modules, logger: createNullLogger() });
    ({ port } = await app.listen());
  });
  afterEach(async () => {
    await app.close();
  });
  const get = async (path) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: await r.json() };
  };

  it("is ok with room to spare", async () => {
    const h = await get("/v1/health");
    expect(h.body).toMatchObject({ status: "ok", problems: [], storage: { level: "ok", freeMb: 50_000 } });
    expect(await get("/v1/ready")).toMatchObject({ status: 200, body: { ready: true } });
  });

  it("says degraded when space is low (still HTTP 200), and not ready when it is critical", async () => {
    state.free = 700;
    app.deps && (await import("./registry.mjs")).storageMonitorOf(app.deps).check();
    let h = await get("/v1/health");
    expect(h).toMatchObject({ status: 200, body: { status: "degraded", storage: { level: "low" } } });
    expect(h.body.problems[0]).toMatchObject({ code: "storage_low" });
    expect(await get("/v1/ready")).toMatchObject({ status: 200, body: { ready: true } });
    state.free = 100;
    (await import("./registry.mjs")).storageMonitorOf(app.deps).check();
    h = await get("/v1/health");
    expect(h.body.problems[0]).toMatchObject({ code: "storage_critical" });
    const r = await get("/v1/ready");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ready: false, reasons: [{ code: "storage_critical" }] });
  });

  it("a damaged file moved aside at start shows up as a problem", async () => {
    const { noteCorruptLines } = await import("../../lib/safeStore.mjs");
    const { writeFileSync } = await import("node:fs");
    const f = join(app.config.dataDir, "x.jsonl");
    writeFileSync(f, "bad\n");
    noteCorruptLines(f, { what: "test journal", corrupt: 1 });
    const h = await get("/v1/health");
    expect(h.body.status).toBe("degraded");
    expect(h.body.problems.some((p) => p.code === "data_quarantined" && /test journal/.test(p.message))).toBe(true);
  });
});

describe("an unhandled ENOSPC", () => {
  it("is answered as DISK_FULL (507) with the fix, not 'Internal error'", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-disk-app-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 } }, env: {}, demo: true });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    try {
      const { key } = await app.deps.keyStore.create({ label: "t", scopes: ["admin"] });
      app.router.add("GET", "/v1/test-enospc", () => {
        throw enospc();
      }, { scope: "read" }, "core");
      const r = await fetch(`http://127.0.0.1:${port}/v1/test-enospc`, { headers: { authorization: `Bearer ${key}` } });
      expect(r.status).toBe(507);
      const body = await r.json();
      expect(body).toMatchObject({ code: "DISK_FULL", retryable: true });
      expect(body.detail).toMatch(/Free some space/);
    } finally {
      await app.close();
    }
  });
});

describe("a paper order is never accepted unless it was saved", () => {
  const RELIANCE = "NSE:RELIANCE";
  const at = Date.parse("2026-10-19T10:00:00+05:30");
  function engineWith(store) {
    const clock = { now: () => at };
    const bus = createEventBus();
    const events = [];
    bus.on("order.updated", (e) => events.push(e));
    const config = { accounts: [{ id: "paper-1", broker: "paper" }], paper: paperConfig({}) };
    const dir = mkdtempSync(join(tmpdir(), "mcb-paper-full-"));
    const engine = createPaperEngine(
      { config, logger: createNullLogger(), bus, clock, paths: { dataDir: dir }, marketData: createFakeMarketData({ prices: { [RELIANCE]: 1400 }, clock }), symbols: createFakeSymbolService() },
      { store: store(dir), timers: { setInterval: () => ({}), clearInterval() {} } },
    );
    engine.start();
    return { engine, events };
  }
  const buy = { symbol: RELIANCE, side: "BUY", quantity: 2, product: "CNC", orderType: "MARKET" };

  it("a full disk: DISK_FULL, no order, no position, no event, the id is not used up; after space is freed the same id is used", async () => {
    let full = false;
    const { engine, events } = engineWith((dir) => {
      const real = createFileStore(join(dir, "paper"));
      return { ...real, save: (id, st) => (full ? (() => { throw enospc(); })() : real.save(id, st)), saveIds: (ids) => (full ? (() => { throw enospc(); })() : real.saveIds(ids)) };
    });
    const first = await engine.place("paper-1", buy);
    expect(first.orderId).toBe("PAPER-20261019-000001");
    expect(events).toHaveLength(1);

    full = true;
    const err = await engine.place("paper-1", buy).catch((e) => e);
    expect(err).toMatchObject({ code: "DISK_FULL", status: 507 });
    expect(err.detail).toMatch(/not accepted/);
    expect((await engine.orders("paper-1", {})).items.map((o) => o.orderId)).toEqual([first.orderId]);
    expect((await engine.positions("paper-1")).find((p) => p.symbol === RELIANCE).quantity ?? 2).toBe(2); // only the first fill
    expect(events).toHaveLength(1); // nothing was announced for the order that was not saved

    full = false;
    const again = await engine.place("paper-1", buy);
    expect(again.orderId).toBe("PAPER-20261019-000002"); // the id of the refused order was not used up
    expect(events).toHaveLength(2);
  });

  it("another write failure (not a full disk) is refused the same way, with INTERNAL", async () => {
    let broken = false;
    const { engine } = engineWith((dir) => {
      const real = createFileStore(join(dir, "paper"));
      return { ...real, save: (id, st) => (broken ? (() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); })() : real.save(id, st)) };
    });
    broken = true;
    expect(await engine.place("paper-1", buy).catch((e) => e)).toMatchObject({ code: "INTERNAL" });
    expect((await engine.orders("paper-1", {})).items).toEqual([]);
  });
});
