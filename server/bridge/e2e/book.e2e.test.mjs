/**
 * End to end, book (docs/spec/p1-12-guard-participants.md §10.3 step 9): a real demo app on 127.0.0.1 with the seeded
 * holders and paper book. GET /v1/book?view=family → holders demo and demo-spouse only, outsideFamily lists
 * demo-other, every leg has its account, totals equal the sum of the holder totals. Plus the family gate after a
 * relationship change, and the pricing wall in demo (each holder priced from its own source).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookFor, familyGateFor } from "../book/module.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";

let app;
let base;
let key;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcb-book-e2e-"));
  const { config } = loadConfig({ raw: { dataDir: dir, server: { port: 0 }, logging: { level: "silent" } }, env: {}, demo: true });
  app = await createApp({ config, logger: createNullLogger() });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
  ({ key } = await app.deps.keyStore.create({ label: "t", scopes: ["admin", "paper"], accounts: "*" }));
  await bookFor(app.deps).seeding;
}, 30_000);

afterAll(async () => {
  await app?.close();
});

const call = async (path, { method = "GET", body } = {}) => {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

describe("book end to end (demo)", () => {
  it("step 9: the family view across three holders", async () => {
    const r = await call("/v1/book?view=family");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.family.holders).toEqual(["demo", "demo-spouse"]);
    expect(d.holders.map((h) => h.holder)).toEqual(["demo", "demo-spouse"]);
    expect(d.outsideFamily.map((h) => h.holder)).toEqual(["demo-other"]);
    const legs = d.holders.flatMap((h) => h.underlyings.flatMap((u) => u.legs));
    expect(legs.length).toBeGreaterThanOrEqual(8);
    expect(legs.every((l) => typeof l.account === "string" && l.account.startsWith("demo"))).toBe(true);
    const sum = (k) => d.holders.reduce((s, h) => s + (h.totals[k] ?? 0), 0);
    for (const k of ["pnl", "theta", "vega", "rupeeDelta", "marginUsed", "marginAvailable"]) expect(d.family.totals[k]).toBeCloseTo(sum(k), 1);
    // The seeded structures: NIFTY strangle + BANKNIFTY spread on demo-paper, SENSEX condor on demo-paper-spouse.
    const self = d.holders[0];
    expect(self.underlyings.map((u) => u.underlying)).toEqual(expect.arrayContaining(["BANKNIFTY", "NIFTY"]));
    // Every seeded order filled: strangle (2) + spread (2) on demo-paper.
    expect(self.underlyings.flatMap((u) => u.legs).filter((l) => l.account === "demo-paper")).toHaveLength(4);
    const spouse = d.holders[1];
    expect(spouse.relationship).toBe("spouse");
    expect(spouse.underlyings.map((u) => u.underlying)).toEqual(["SENSEX"]);
    expect(spouse.underlyings[0].legs).toHaveLength(4);
    expect(spouse.underlyings[0].legs.every((l) => l.account === "demo-paper-spouse")).toBe(true);
    // Greeks are present (priced) and the method note is there.
    expect(spouse.underlyings[0].greeks).toMatchObject({ missing: 0 });
    expect(typeof d.method).toBe("string");
  });

  it("the pricing wall in demo: self is priced from its own demo data account, the paper-only holders from the paper source", async () => {
    const r = await call("/v1/book?view=holders");
    const src = Object.fromEntries(r.body.data.holders.map((h) => [h.holder, h.priceSource]));
    expect(src.demo).toEqual({ kind: "account", broker: "demo", account: "demo" });
    expect(src["demo-spouse"]).toEqual({ kind: "paper" });
    expect(src["demo-other"]).toEqual({ kind: "paper" });
  });

  it("the family gate follows the holder's relationship (Accounts page change)", async () => {
    const gate = familyGateFor(app.deps);
    expect(gate("demo-paper")).toMatchObject({ ok: true, relationship: "self" });
    expect(gate("demo-paper-spouse")).toMatchObject({ ok: true, relationship: "spouse" });
    expect(gate("demo-paper-other")).toMatchObject({ ok: false, code: "AUTOMATION_NOT_ALLOWED", relationship: "other" });
    const put = await call("/v1/book/holders/demo-other", { method: "PUT", body: { relationship: "spouse", label: "Now family" } });
    expect(put.status).toBe(200);
    expect(gate("demo-paper-other")).toMatchObject({ ok: true, relationship: "spouse" });
    const f = await call("/v1/book?view=family");
    expect(f.body.data.family.holders).toEqual(["demo", "demo-spouse", "demo-other"]);
    expect(f.body.data.outsideFamily).toEqual([]);
    await call("/v1/book/holders/demo-other", { method: "PUT", body: { relationship: "other", label: "Not family (sample)" } });
  });
});
