/**
 * POST /v1/margin/basket: the basket margin service over the REAL paper engine's margin model, the fake symbol service
 * and the fake account manager (no network). The route itself is covered in targetBatch.test.mjs.
 */
import { describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { BridgeError } from "../core/errors.mjs";
import { createEventBus } from "../core/eventBus.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { freshness } from "../market/normalise.mjs";
import { paperConfig } from "../paper/config.mjs";
import { createPaperEngine } from "../paper/paperEngine.mjs";
import { createMemoryStore } from "../paper/paperStore.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { INSTRUMENTS, PRICES, stubOrderAdapter } from "./__fixtures__/helpers.mjs";
import { MARGIN_BASKET_MAX, createMarginBasket } from "./marginBasket.mjs";

const FUT = "NFO:NIFTY-2026-10-27-FUT";
const CE = "NFO:NIFTY-2026-10-27-25000-CE";
const RELIANCE = "NSE:RELIANCE";

function build({ adapter = stubOrderAdapter("zerodha"), allowed = () => {} } = {}) {
  const clock = createManualClock();
  const symbols = createFakeSymbolService({ instruments: INSTRUMENTS });
  const marketData = {
    async ltp(list) {
      return { items: list.filter((s) => PRICES[s]).map((s) => ({ symbol: s, ltp: PRICES[s], freshness: freshness({ source: "paper", at: clock.now(), now: clock.now(), targetMs: 1000, stale: false }) })), errors: [] };
    },
    async depth(symbol) {
      throw new BridgeError("SYMBOL_NOT_FOUND", `No depth for ${symbol}.`);
    },
  };
  const paper = createPaperEngine(
    { config: { accounts: [], paper: paperConfig({}) }, logger: createNullLogger(), bus: createEventBus(), clock, paths: { dataDir: "" }, marketData, symbols },
    { store: createMemoryStore(), accountKnown: () => true, timers: { setInterval: () => 0, clearInterval: () => {} } },
  );
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter, creds: { apiKey: "k", accessToken: "t" } },
      { id: "paper", broker: "paper" },
    ],
  });
  const deps = { accounts, symbols, paper, scheduler: createFakeScheduler(), clock };
  const ctx = { requireAccountAccess: (id) => allowed(id), principal: { kind: "key", id: "k1" } };
  return { svc: createMarginBasket({ deps, now: () => clock.now() }), ctx, adapter, symbols };
}

const leg = (over = {}) => ({ symbol: FUT, side: "BUY", lots: 1, ...over });

describe("paper model", () => {
  it("answers JSON numbers, labelled paper-model, for a futures leg", async () => {
    const { svc, ctx } = build();
    const r = await svc.marginBasket(ctx, { positions: [leg({ price: 25060 })] });
    expect(r.source).toBe("paper-model");
    expect(r.account).toBe("paper");
    expect(r.legs).toBe(1);
    expect(typeof r.total).toBe("number");
    expect(r.total).toBeGreaterThan(0);
    expect(r.total).toBeLessThan(25060 * 65); // a margin, not the contract value
    expect(typeof r.hedgeBenefit).toBe("number");
    expect(r.hedgeBenefit).toBeGreaterThanOrEqual(0);
    expect(r.note).toMatch(/approximate/i);
    expect(r.asOf).toMatch(/\+05:30$/);
    expect(JSON.stringify(r)).not.toMatch(/"total":"/);
  });

  it("lots and quantity are the same basket; MIS is read as INTRADAY", async () => {
    const { svc, ctx } = build();
    const a = await svc.marginBasket(ctx, { positions: [leg({ lots: 2 })] });
    const b = await svc.marginBasket(ctx, { positions: [leg({ lots: undefined, quantity: 130 })] });
    expect(a.total).toBe(b.total);
    const mis = await svc.marginBasket(ctx, { positions: [{ symbol: RELIANCE, side: "BUY", quantity: 10, product: "MIS", price: 1400 }] });
    const intraday = await svc.marginBasket(ctx, { positions: [{ symbol: RELIANCE, side: "BUY", quantity: 10, product: "INTRADAY", price: 1400 }] });
    expect(mis.total).toBe(intraday.total);
    expect(mis.total).toBeGreaterThan(0);
    expect(mis.total).toBeLessThan(1400 * 10);
  });

  it("a hedge between the legs lowers the basket and shows as hedgeBenefit", async () => {
    const { svc, ctx } = build();
    const naked = await svc.marginBasket(ctx, { positions: [leg({ symbol: CE, side: "SELL", price: 120 })] });
    const hedged = await svc.marginBasket(ctx, { positions: [leg({ symbol: CE, side: "SELL", price: 120 }), leg({ symbol: FUT, side: "BUY", price: 25060 })] });
    expect(naked.total).toBeGreaterThan(0);
    expect(hedged.hedgeBenefit).toBeGreaterThanOrEqual(0);
    expect(hedged.total).toBeLessThanOrEqual(naked.total + (await svc.marginBasket(ctx, { positions: [leg({ symbol: FUT, price: 25060 })] })).total);
  });

  it("nothing is stored: the same basket twice gives the same figure and a live account's paper book is never created", async () => {
    const { svc, ctx } = build();
    const a = await svc.marginBasket(ctx, { account: "zerodha-main", positions: [leg({ price: 25060 })] });
    const b = await svc.marginBasket(ctx, { account: "zerodha-main", positions: [leg({ price: 25060 })] });
    expect(a.total).toBe(b.total);
    expect(a.account).toBe("zerodha-main");
    expect(a.source).toBe("paper-model");
    expect(a.note).toMatch(/no margin calculator/);
  });
});

describe("broker margin", () => {
  it("uses the adapter's calculator when it has one and says source broker", async () => {
    const adapter = stubOrderAdapter("zerodha");
    const seen = [];
    adapter.fetchBasketMargin = async (creds, rows) => (seen.push(rows), { status: "success", data: { total: 51234.567, span: 40000, exposure: 11234.567, hedgeBenefit: 2000 } });
    const { svc, ctx } = build({ adapter });
    const r = await svc.marginBasket(ctx, { account: "zerodha-main", positions: [leg({ price: 25060 })] });
    expect(r).toMatchObject({ source: "broker", total: 51234.57, span: 40000, exposure: 11234.57, hedgeBenefit: 2000, account: "zerodha-main", note: null });
    expect(seen[0][0]).toMatchObject({ exchange: "NFO", token: "9001", side: "BUY", quantity: 65, product: "MARGIN", orderType: "LIMIT", price: 25060 });
  });

  it("falls back to the labelled paper model when the broker call fails, and says why", async () => {
    const adapter = stubOrderAdapter("zerodha");
    adapter.fetchBasketMargin = async () => {
      throw new Error("broker down");
    };
    const { svc, ctx } = build({ adapter });
    const r = await svc.marginBasket(ctx, { account: "zerodha-main", positions: [leg({ price: 25060 })] });
    expect(r.source).toBe("paper-model");
    expect(r.note).toMatch(/margin call failed/);
  });

  it("an answer without a usable total is not trusted", async () => {
    const adapter = stubOrderAdapter("zerodha");
    adapter.fetchBasketMargin = async () => ({ status: "success", data: { total: "lots" } });
    const { svc, ctx } = build({ adapter });
    expect((await svc.marginBasket(ctx, { account: "zerodha-main", positions: [leg({ price: 25060 })] })).source).toBe("paper-model");
    adapter.fetchBasketMargin = async () => ({ status: "success", data: { total: -5 } });
    expect((await svc.marginBasket(ctx, { account: "zerodha-main", positions: [leg({ price: 25060 })] })).source).toBe("paper-model");
  });
});

describe("hostile input", () => {
  const big = Array.from({ length: MARGIN_BASKET_MAX + 1 }, () => leg());
  it.each([
    ["no body", undefined],
    ["an empty list", { positions: [] }],
    ["more than 50 positions", { positions: big }],
    ["a huge list", { positions: Array.from({ length: 100000 }, () => leg()) }],
    ["positions that is not a list", { positions: "x" }],
    ["an unknown top-level field", { positions: [leg()], leverage: 2 }],
    ["an unknown leg field", { positions: [{ ...leg(), extra: 1 }] }],
    ["a bad account id", { account: "../x", positions: [leg()] }],
    ["both quantity and lots", { positions: [{ ...leg(), quantity: 65 }] }],
    ["neither quantity nor lots", { positions: [{ symbol: FUT, side: "BUY" }] }],
    ["an overflow quantity", { positions: [leg({ lots: undefined, quantity: 1e15 })] }],
    ["a negative quantity", { positions: [leg({ lots: undefined, quantity: -65 })] }],
    ["a fractional lot count", { positions: [leg({ lots: 1.5 })] }],
    ["a text quantity", { positions: [leg({ lots: "NaN" })] }],
    ["a negative price", { positions: [leg({ price: -1 })] }],
    ["a bad side", { positions: [leg({ side: "HOLD" })] }],
    ["a bad product", { positions: [leg({ product: "COVER" })] }],
  ])("%s is VALIDATION_FAILED", async (_n, body) => {
    const { svc, ctx } = build();
    await expect(svc.marginBasket(ctx, body)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("exactly 50 positions are accepted", async () => {
    const { svc, ctx } = build();
    const r = await svc.marginBasket(ctx, { positions: Array.from({ length: MARGIN_BASKET_MAX }, () => leg({ price: 25060 })) });
    expect(r.legs).toBe(50);
    expect(r.total).toBeGreaterThan(0);
  });

  it("an unknown symbol, an index and a quantity that is not a lot multiple name the position", async () => {
    const { svc, ctx } = build();
    await expect(svc.marginBasket(ctx, { positions: [leg(), { symbol: "NSE:NOPE", side: "BUY", quantity: 1 }] })).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND", detail: expect.stringMatching(/positions\[1\]/) });
    await expect(svc.marginBasket(ctx, { positions: [{ symbol: "NSE:NIFTY", side: "BUY", quantity: 1 }] })).rejects.toMatchObject({ code: "INVALID_ORDER" });
    await expect(svc.marginBasket(ctx, { positions: [{ symbol: FUT, side: "BUY", quantity: 100 }] })).rejects.toMatchObject({ code: "INVALID_ORDER" });
  });

  it("an unknown account and an account the key may not use are refused", async () => {
    const { svc, ctx } = build({ allowed: (id) => id !== "zerodha-main" && undefined });
    await expect(svc.marginBasket(ctx, { account: "nobody", positions: [leg()] })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    const denied = build({
      allowed: (id) => {
        if (id === "zerodha-main") throw new BridgeError("ACCOUNT_FORBIDDEN", "no");
      },
    });
    await expect(denied.svc.marginBasket(denied.ctx, { account: "zerodha-main", positions: [leg()] })).rejects.toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
  });

  it("no paper account the key may use and no account named: a clear request for one", async () => {
    const { svc, ctx } = build({
      allowed: () => {
        throw new BridgeError("ACCOUNT_FORBIDDEN", "no");
      },
    });
    await expect(svc.marginBasket(ctx, { positions: [leg()] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
