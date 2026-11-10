/**
 * The live-order gate reads the same session data as the calendar: derivative orders are accepted until the dated close,
 * a verified holiday blocks, and a special session whose timing is unverified refuses live orders. (Order-safety tests on
 * the kill switch and the other limits live in their own files; this one only covers the session data.)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../core/config.mjs";
import { createCallContext } from "../core/context.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeAuditLog } from "./fake.mjs";
import { createSafetyGuard } from "./safetyGuard.mjs";

const config = loadConfig({ raw: { dataDir: "/unused", safety: { liveTrading: true }, accounts: [{ id: "dhan-main", broker: "dhan", live: { enabled: true } }] }, env: {} }).config;

function guardAt(iso) {
  const t = Date.parse(iso);
  const clock = { now: () => t };
  return createSafetyGuard({ config, logger: createNullLogger(), bus: createEventBus(), clock, paths: { dataDir: mkdtempSync(join(tmpdir(), "mcb-mh-")) }, audit: createFakeAuditLog({ clock }), accounts: notImplementedService("accounts") }, { env: {} });
}

const ctx = () => {
  const c = createCallContext({ source: "rest", key: { id: "k1", label: "k1", scopes: ["live", "paper"], accounts: "*" }, log: createNullLogger() });
  c.loopback = true;
  return c;
};

const liveIntent = (symbol, over = {}) => ({ accountId: "dhan-main", mode: "live", action: "place", order: { symbol, side: "BUY", quantity: 1, product: "NRML", orderType: "LIMIT", price: 100 }, source: "rest", keyId: "k1", quantity: 1, value: 100, ltp: 100, ...over });
const marketClosed = async (iso, intent) => (await guardAt(iso).check(ctx(), intent)).reasons.find((r) => r.code === "MARKET_CLOSED") ?? null;

const FUT = "NFO:NIFTY-2026-11-24-FUT";
const CASH = "NSE:RELIANCE";

describe("the gate reads the dated session rules", () => {
  it("a live NFO order at 15:35 is accepted now (derivatives trade to 15:40); 15:40 is the first minute refused", async () => {
    expect(await marketClosed("2026-11-09T15:35:00+05:30", liveIntent(FUT))).toBeNull();
    expect(await marketClosed("2026-11-09T15:39:00+05:30", liveIntent(FUT))).toBeNull();
    expect(await marketClosed("2026-11-09T15:40:00+05:30", liveIntent(FUT))).toMatchObject({ code: "MARKET_CLOSED", rule: "marketHours" });
  });

  it("a live cash order is still refused from 15:30", async () => {
    expect(await marketClosed("2026-11-09T15:29:00+05:30", liveIntent(CASH))).toBeNull();
    expect(await marketClosed("2026-11-09T15:30:00+05:30", liveIntent(CASH))).toMatchObject({ code: "MARKET_CLOSED" });
  });

  it("before the open and at the weekend nothing goes out", async () => {
    expect(await marketClosed("2026-11-09T09:10:00+05:30", liveIntent(FUT))).toMatchObject({ code: "MARKET_CLOSED" });
    expect(await marketClosed("2026-11-07T11:00:00+05:30", liveIntent(FUT))).toMatchObject({ code: "MARKET_CLOSED" });
  });

  it("from 7 Dec 2026 an index contract expiring today stops at 15:30 but a stock contract trades to 15:45", async () => {
    const idx = liveIntent("NFO:NIFTY-2026-12-08-FUT", { underlyingKind: "index", underlying: "NIFTY" });
    const stock = liveIntent("NFO:RELIANCE-2026-12-29-FUT", { underlyingKind: "stock", underlying: "RELIANCE" });
    const t = "2026-12-08T15:35:00+05:30";
    expect(await marketClosed(t, idx)).toMatchObject({ code: "MARKET_CLOSED" });
    expect(await marketClosed(t, stock)).toBeNull();
    expect(await marketClosed(t, liveIntent("NFO:NIFTY-2026-12-15-FUT", { underlyingKind: "index", underlying: "NIFTY" }))).toBeNull();
    expect(await marketClosed("2026-12-08T15:45:00+05:30", stock)).toMatchObject({ code: "MARKET_CLOSED" });
  });
});

describe("holidays and special sessions", () => {
  it("a verified holiday from the shipped list blocks a live order even without a reference service", async () => {
    const r = await marketClosed("2026-11-24T11:00:00+05:30", liveIntent(FUT));
    expect(r).toMatchObject({ code: "MARKET_CLOSED" });
    expect(r.message).toMatch(/closed today \(Prakash Gurpurb/);
    expect(await marketClosed("2026-01-15T11:00:00+05:30", liveIntent(CASH))).toMatchObject({ code: "MARKET_CLOSED" });
  });

  it("a live order in the Muhurat session (timing not verified) is refused, and the reason says why", async () => {
    const r = await marketClosed("2026-11-08T14:30:00+05:30", liveIntent(FUT));
    expect(r).toMatchObject({ code: "MARKET_CLOSED" });
    expect(r.message).toMatch(/timing is not verified/);
  });

  it("a paper order in that session is not refused", async () => {
    const v = await guardAt("2026-11-08T14:30:00+05:30").check(ctx(), { ...liveIntent(FUT), mode: "paper" });
    expect(v.reasons.map((x) => x.code)).not.toContain("MARKET_CLOSED");
  });
});
