import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKeyStore, MAX_KEYS } from "../auth/keyStore.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { RingLog, backoffMs, checkParams, childEnv, orderPrefix, parseLine, strategyBook, strategyIdOf } from "./book.mjs";

describe("strategy ids come from file names only", () => {
  it("maps names to ids and refuses the rest", () => {
    expect(strategyIdOf("short_straddle.py")).toBe("short_straddle");
    expect(strategyIdOf("EMA-Cross.py")).toBe("ema_cross");
    expect(strategyIdOf("_helper.py")).toBe(null);
    expect(strategyIdOf(".hidden.py")).toBe(null);
    expect(strategyIdOf("../evil.py")).toBe(null);
    expect(strategyIdOf("a/b.py")).toBe(null);
    expect(strategyIdOf("x.txt")).toBe(null);
    expect(strategyIdOf(`${"a".repeat(33)}.py`)).toBe(null);
    expect(orderPrefix("ema_cross")).toBe("A-ema_cross-");
  });
});

describe("strategyBook (the SDK's build_book rule)", () => {
  const o = (side, q, px, t, symbol = "S") => ({ symbol, side, filledQuantity: q, avgPrice: px, placedAt: t, orderId: t });
  it("average cost, realised on the closing part, flips at the fill price", () => {
    const b = strategyBook([o("SELL", 65, 100, "1"), o("SELL", 65, 110, "2"), o("BUY", 65, 90, "3")], { S: 95 });
    // short 130 at 105, buy back 65 at 90: +975 realised; 65 left short at 105, LTP 95: +650
    expect(b.positions[0]).toMatchObject({ qty: -65, avg: 105, realised: 975, unrealised: 650 });
    expect(b).toMatchObject({ realised: 975, unrealised: 650, total: 1625, open: 1 });
    const flip = strategyBook([o("BUY", 10, 50, "1"), o("SELL", 30, 60, "2")], { S: 55 });
    expect(flip.positions[0]).toMatchObject({ qty: -20, avg: 60, realised: 100, unrealised: 100 });
  });
  it("skips unfilled and unpriced orders; no price means no open P&L", () => {
    const b = strategyBook([o("BUY", 0, 10, "1"), { symbol: "S", side: "BUY", filledQuantity: 5, avgPrice: null }, o("BUY", 5, 10, "2")]);
    expect(b.positions[0]).toMatchObject({ qty: 5, ltp: null, unrealised: 0 });
  });
});

describe("params", () => {
  const declared = [
    { name: "lots", kind: "int", default: 1, min: 1, max: 10 },
    { name: "pct", kind: "float", default: 0.5, min: 0 },
    { name: "on", kind: "bool", default: true },
    { name: "u", kind: "choice", default: "NIFTY", choices: ["NIFTY", "BANKNIFTY"] },
    { name: "t", kind: "str", default: "09:20" },
  ];
  it("checks every value like the SDK and names each problem", () => {
    expect(checkParams(declared, { lots: "3", pct: 1.5, on: "false", u: "BANKNIFTY", t: "10:00" })).toEqual({ values: { lots: 3, pct: 1.5, on: false, u: "BANKNIFTY", t: "10:00" }, errors: [] });
    const r = checkParams(declared, { lots: 1.5, pct: -1, on: 1, u: "X", t: 5, zz: 1 });
    expect(r.errors.map((e) => e.path)).toEqual(["params.lots", "params.pct", "params.on", "params.u", "params.t", "params.zz"]);
    expect(checkParams(declared, { lots: 11 }).errors[0].message).toBe("must be at most 10");
    expect(checkParams(declared, [1]).errors[0].path).toBe("params");
  });
});

describe("runner plumbing", () => {
  it("parses SDK messages and plain lines", () => {
    expect(parseLine('@@mcb {"t":"heartbeat","ticks":3}')).toEqual({ kind: "msg", msg: { t: "heartbeat", ticks: 3 } });
    expect(parseLine("@@mcb not json")).toEqual({ kind: "log", level: "info", text: "@@mcb not json" });
    expect(parseLine('@@mcb {"t":"log"}', "err")).toEqual({ kind: "log", level: "error", text: '@@mcb {"t":"log"}' });
    expect(parseLine("Traceback", "err")).toEqual({ kind: "log", level: "error", text: "Traceback" });
  });
  it("keeps a bounded, numbered log", () => {
    const log = new RingLog(3);
    for (let i = 0; i < 5; i++) log.push({ at: i, level: "info", text: `l${i}` });
    expect(log.since(0).items.map((l) => l.text)).toEqual(["l2", "l3", "l4"]);
    expect(log.since(1)).toMatchObject({ truncated: true, last: 5 });
    expect(log.since(4).items.map((l) => l.seq)).toEqual([5]);
    expect(log.push({ at: 0, level: "weird", text: "x" }).level).toBe("info");
  });
  it("backs off 2, 4, 8 s up to the cap", () => {
    expect([0, 1, 2, 10].map((a) => backoffMs(a))).toEqual([2000, 4000, 8000, 60_000]);
  });
  it("gives a strategy only what Python needs, never the Bridge's secrets", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/h", MCB_MASTER_KEY: "secret", MCB_TELEGRAM_BOT_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "x" }, { MCB_API_KEY: "k" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", MCB_API_KEY: "k" });
  });
});

describe("keys.json never outgrows its own limit (each strategy run mints and revokes a key)", () => {
  it("drops the oldest revoked keys, never an active one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcb-keyprune-"));
    const ks = createKeyStore({ logger: createNullLogger(), paths: { dataDir: dir } }, { scryptParams: { N: 2 ** 14, r: 8, p: 1 } });
    const { record: keep } = await ks.create({ label: "active", scopes: ["read"] });
    const file = join(dir, "keys.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const proto = doc.keys[0];
    const filler = [];
    for (let i = 0; filler.length < MAX_KEYS * 2 - 1; i++) {
      const id = `r${i.toString(32).padStart(9, "a")}`.replace(/[^a-z2-7]/g, "b").slice(0, 10);
      if (id === proto.id || filler.some((k) => k.id === id)) continue;
      filler.push({ ...proto, id, label: `old ${i}`, revokedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }
    writeFileSync(file, JSON.stringify({ ...doc, keys: [proto, ...filler] }));
    expect((await ks.list()).length).toBe(MAX_KEYS * 2);
    const { key } = await ks.create({ label: "new", scopes: ["paper"] });
    const after = await ks.list();
    expect(after.length).toBe(MAX_KEYS * 2);
    expect(after.some((k) => k.id === keep.id && !k.revokedAt)).toBe(true);
    expect(after.some((k) => k.label === "old 0")).toBe(false);
    expect(await ks.authenticate(key)).toMatchObject({ label: "new" });
  });
});
