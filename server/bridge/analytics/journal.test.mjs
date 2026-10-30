import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryPnl, journalRoutes, journalStats, roundTripsFromFills } from "./journal.mjs";

const e = (o = {}) => ({ symbol: "NIFTY", side: "buy", qty: 10, entryPrice: 100, exitPrice: 110, entryAt: "2026-10-26T04:00:00Z", exitAt: "2026-10-26T06:00:00Z", fees: 0, strategy: "s1", tags: [], ...o });

describe("journalStats", () => {
  it("handles empty input", () => {
    const s = journalStats([]);
    expect(s.trades).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.best).toBeNull();
    expect(s.maxDrawdown).toBe(0);
  });

  it("computes the headline numbers", () => {
    // Mon +100, Tue -50 (sell: price up is a loss), Wed +200 less 20 fees, Thu -30
    const s = journalStats([
      e({ exitAt: "2026-10-26T06:00:00Z", tags: ["a"] }),
      e({ side: "sell", exitPrice: 105, exitAt: "2026-10-27T06:00:00Z", strategy: "s2", tags: ["a", "b"] }),
      e({ exitPrice: 120, fees: 20, exitAt: "2026-10-28T06:00:00Z" }),
      e({ exitPrice: 97, exitAt: "2026-10-29T06:00:00Z", strategy: "s2" }),
    ]);
    expect(s.netPnl).toBe(200);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBe(3.5); // 280 / 80
    expect(s.avgWin).toBe(140);
    expect(s.avgLoss).toBe(-40);
    expect(s.expectancy).toBe(50);
    expect(s.maxDrawdown).toBe(50); // 100 -> 50
    expect(s.best.pnl).toBe(180);
    expect(s.worst.pnl).toBe(-50);
    expect(s.byStrategy.find((b) => b.key === "s2")).toEqual({ key: "s2", trades: 2, netPnl: -80, winRate: 0 });
    expect(s.byTag.find((b) => b.key === "a").netPnl).toBe(50);
    expect(s.byTag.find((b) => b.key === "(untagged)").trades).toBe(2);
    expect(s.byWeekday.map((b) => b.key)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday"]);
    expect(s.curve.map((c) => c.cumPnl)).toEqual([100, 50, 230, 200]);
  });

  it("measures drawdown from the running peak in exit order, not input order", () => {
    const s = journalStats([e({ exitPrice: 80, exitAt: "2026-10-27T06:00:00Z" }), e({ exitPrice: 130, exitAt: "2026-10-26T06:00:00Z" })]);
    expect(s.maxDrawdown).toBe(200); // +300 then -200
    expect(s.profitFactor).toBe(1.5); // 300 / 200
  });

  it("uses IST for the weekday", () => {
    const s = journalStats([e({ exitAt: "2026-10-26T20:00:00Z" })]); // 01:30 Tuesday IST
    expect(s.byWeekday[0].key).toBe("Tuesday");
  });

  it("entryPnl subtracts fees for both sides", () => {
    expect(entryPnl(e({ side: "sell", exitPrice: 90, fees: 5 }))).toBe(95);
  });
});

describe("roundTripsFromFills", () => {
  const f = (tradeId, side, qty, price, t, charges = 0) => ({ tradeId, accountId: "paper-1", symbol: "X", side, product: "MIS", qty, price, charges, tradedAt: `2026-10-26T0${t}:00:00+05:30` });
  it("pairs FIFO, splits partial closes and ignores open lots", () => {
    const trips = roundTripsFromFills([f("c", "SELL", 15, 12, 3, 3), f("a", "BUY", 10, 10, 1, 2), f("b", "BUY", 10, 11, 2, 2)]);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ side: "buy", qty: 10, entryPrice: 10, exitPrice: 12, sourceKey: "a>c", fees: 2 + 2 });
    expect(trips[1]).toMatchObject({ qty: 5, entryPrice: 11, sourceKey: "b>c", fees: 1 + 1 });
  });
  it("handles shorts and flips through zero", () => {
    const trips = roundTripsFromFills([f("a", "SELL", 10, 100, 1), f("b", "BUY", 15, 90, 2), f("c", "SELL", 5, 95, 3)]);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ side: "sell", qty: 10, sourceKey: "a>b" });
    expect(trips[1]).toMatchObject({ side: "buy", qty: 5, entryPrice: 90, exitPrice: 95, sourceKey: "b>c" });
  });
});

describe("journal routes", () => {
  let dir;
  let routes;
  let paperCalls;
  const fills = [
    { tradeId: "o2-T1", accountId: "paper-1", symbol: "X", side: "SELL", product: "MIS", qty: 5, price: 12, charges: 1, tradedAt: "2026-10-26T10:00:00+05:30" },
    { tradeId: "o1-T1", accountId: "paper-1", symbol: "X", side: "BUY", product: "MIS", qty: 5, price: 10, charges: 1, tradedAt: "2026-10-26T09:30:00+05:30" },
  ];
  const mk = (extra = {}) => {
    paperCalls = 0;
    return journalRoutes({ paths: { dataDir: dir }, paper: { trades: async () => ((paperCalls += 1), { items: fills, nextCursor: null }) }, ...extra });
  };
  const find = (m, p) => routes.find((r) => r[0] === m && r[1] === p);
  const ctx = (o = {}) => ({ query: new URLSearchParams(o.query ?? ""), body: o.body, params: o.params ?? {}, requestId: "r1", requireAccountAccess() {}, canAccessAccounts: () => true });
  const call = (m, p, o) => find(m, p)[3](ctx(o));
  const body = { symbol: "NIFTY", side: "BUY", qty: 10, entryPrice: 100, exitPrice: 110, entryAt: "2026-10-26T04:00:00Z", exitAt: "2026-10-26T06:00:00Z", strategy: "s1", tags: ["x"] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "journal-"));
    routes = mk();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("declares read scope, DELETE without a body, and exposes no order service", () => {
    expect(routes.map((r) => `${r[0]} ${r[1]}`)).toEqual([
      "GET /v1/analytics/journal",
      "POST /v1/analytics/journal",
      "DELETE /v1/analytics/journal/:entryId",
      "GET /v1/analytics/journal/stats",
      "POST /v1/analytics/journal/import-paper",
    ]);
    expect(find("DELETE", "/v1/analytics/journal/:entryId")[2]).toEqual({ scope: "read", body: "none" });
    expect(routes.every((r) => r[2].scope === "read")).toBe(true);
  });

  it("adds, lists, persists across instances, stats and deletes", async () => {
    const added = await call("POST", "/v1/analytics/journal", { body });
    expect(added.data).toMatchObject({ side: "buy", pnl: 100, source: "manual" });
    expect(added.data.id).toMatch(/^j_/);
    routes = mk(); // fresh instance reads the file
    const list = await call("GET", "/v1/analytics/journal");
    expect(list.data.total).toBe(1);
    expect((await call("GET", "/v1/analytics/journal", { query: "tag=nope" })).data.total).toBe(0);
    expect((await call("GET", "/v1/analytics/journal/stats")).data.netPnl).toBe(100);
    await call("DELETE", "/v1/analytics/journal/:entryId", { params: { entryId: added.data.id } });
    expect((await call("GET", "/v1/analytics/journal")).data.total).toBe(0);
    await expect(call("DELETE", "/v1/analytics/journal/:entryId", { params: { entryId: added.data.id } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(readdirSync(join(dir, "analytics")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects bad entries", async () => {
    for (const bad of [{ ...body, qty: 0 }, { ...body, side: "hold" }, { ...body, exitAt: "2026-10-25T00:00:00Z" }, { ...body, extra: 1 }, { ...body, entryAt: "yesterday" }]) {
      await expect(call("POST", "/v1/analytics/journal", { body: bad })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("moves a corrupt file aside instead of overwriting it", async () => {
    mkdirSync(join(dir, "analytics"), { recursive: true });
    writeFileSync(join(dir, "analytics", "journal.json"), "{nope");
    expect((await call("GET", "/v1/analytics/journal")).data.total).toBe(0);
    expect(readdirSync(join(dir, "analytics")).some((n) => n.startsWith("journal.json.corrupt-"))).toBe(true);
  });

  it("hides entries of accounts the key cannot use", async () => {
    await call("POST", "/v1/analytics/journal", { body: { ...body, account: "paper-1" } });
    const c = { ...ctx(), canAccessAccounts: () => false };
    expect((await find("GET", "/v1/analytics/journal")[3](c)).data.total).toBe(0);
  });

  it("imports closed paper trades once, read-only", async () => {
    const r1 = await call("POST", "/v1/analytics/journal/import-paper", { query: "account=paper-1" });
    expect(r1.data).toMatchObject({ imported: 1, skipped: 0 });
    const r2 = await call("POST", "/v1/analytics/journal/import-paper", { query: "account=paper-1" });
    expect(r2.data).toMatchObject({ imported: 0, skipped: 1 });
    const list = (await call("GET", "/v1/analytics/journal")).data.entries;
    expect(list[0]).toMatchObject({ symbol: "X", account: "paper-1", source: "paper", strategy: "paper", pnl: 8, fees: 2 });
    expect(list[0].sourceKey).toBeUndefined();
    await expect(call("POST", "/v1/analytics/journal/import-paper")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("reports an unavailable paper service", async () => {
    routes = mk({ paper: undefined });
    await expect(call("POST", "/v1/analytics/journal/import-paper", { query: "account=paper-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
