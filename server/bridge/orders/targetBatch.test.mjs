/**
 * Naming tolerance on native orders, POST /v1/orders/to-target and POST /v1/orders/batch, end to end through the real
 * request pipeline: the real OrderService over the published fakes, a stub paper engine and a stub broker adapter.
 * Includes the hostile cases: overflow and non-numeric sizes, huge lists, unknown accounts, a read-only key, live mode
 * without the opt-ins, the kill switch, duplicate and concurrent keys, and an unreadable position.
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeAccountManager } from "../accounts/fake.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { notImplementedService } from "../core/contracts.mjs";
import { createNullLogger } from "../core/logger.mjs";
import { createFakeMarketData } from "../market/fake.mjs";
import { createFakeScheduler, createManualClock } from "../ratelimit/fake.mjs";
import { createFakeSymbolService } from "../symbols/fake.mjs";
import { INSTRUMENTS, KEYS, PRICES, createStubAudit, createStubPaper, createStubSafety, stubOrderAdapter } from "./__fixtures__/helpers.mjs";
import ordersModule, { ROUTES } from "./module.mjs";
import { legKey } from "./batchOrders.mjs";

const RAW = { live: "mcb_livekey0001_x", paper: "mcb_paperkey001_x", read: "mcb_readkey0001_x", mcp: "mcb_mcpkey00001_x" };
const BY_RAW = Object.fromEntries(Object.entries(RAW).map(([name, raw]) => [raw, KEYS[name]]));
const keyStore = { ...notImplementedService("keyStore"), authenticate: async (raw) => BY_RAW[raw] ?? null };

const RELIANCE = "NSE:RELIANCE";
const FUT = "NFO:NIFTY-2026-10-27-FUT";
const CE = "NFO:NIFTY-2026-10-27-25000-CE";

let app;
let port;
let zerodha;
let safety;
let paper;

function call(method, path, { key = RAW.live, body, headers = {} } = {}) {
  const h = { host: `127.0.0.1:${port}`, ...headers };
  if (key) h.authorization = `Bearer ${key}`;
  let payload;
  if (body !== undefined) {
    payload = typeof body === "string" ? body : JSON.stringify(body);
    h["content-type"] = "application/json";
    h["content-length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let keySeq = 0;
const newKey = (p = "tb") => `${p}-key-${String(++keySeq).padStart(5, "0")}`;
const idem = (key) => ({ "idempotency-key": key });
const placedByPaper = () => paper.calls.filter((c) => c[0] === "place");

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mcb-orders-target-"));
  const { config } = loadConfig({
    raw: {
      server: { port: 0 },
      dataDir,
      safety: { liveTrading: true },
      accounts: [
        { id: "zerodha-main", broker: "zerodha", live: { enabled: true, allowedSources: ["rest", "mcp"] } },
        { id: "paper", broker: "paper" },
      ],
      orders: { liveCallTimeoutMs: 5000 },
    },
    env: {},
  });
  const clock = createManualClock();
  zerodha = stubOrderAdapter("zerodha");
  const accounts = createFakeAccountManager({
    accounts: [
      { id: "zerodha-main", broker: "zerodha", adapter: zerodha, creds: { apiKey: "k", accessToken: "t" }, liveAllowedByConfig: true },
      { id: "paper", broker: "paper" },
    ],
  });
  safety = createStubSafety();
  paper = createStubPaper({ clock });
  app = await createApp({
    config,
    modules: [ordersModule],
    logger: createNullLogger(),
    clock,
    overrides: {
      keyStore,
      accounts,
      scheduler: createFakeScheduler(),
      symbols: createFakeSymbolService({ instruments: INSTRUMENTS }),
      marketData: createFakeMarketData({ prices: PRICES, clock }),
      safety,
      audit: createStubAudit(),
      paper,
    },
  });
  ({ port } = await app.listen());
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await paper.reset("paper");
  await paper.reset("zerodha-main");
  paper.calls.length = 0;
  safety.refuse = [];
  zerodha.positions = [];
  zerodha.holdings = [];
  zerodha.placed.length = 0;
  zerodha.next = "ack";
  // Open live orders of earlier tests would block a target-position request on the same symbol.
  await call("POST", "/v1/orders/cancel-all", { body: { account: "zerodha-main", mode: "live" } });
  zerodha.cancelled.length = 0;
  zerodha.placed.length = 0;
});

const seedPos = (account, symbol, product, netQty) => paper.seed(account, { positions: [{ symbol, product, netQty }] });
const target = (over = {}) => ({ account: "paper", symbol: RELIANCE, targetQuantity: 5, product: "INTRADAY", orderType: "LIMIT", price: 1400, ...over });

describe("module", () => {
  it("registers the new routes with the documented scopes", () => {
    const mine = Object.fromEntries(ROUTES.map(([m, p, o]) => [`${m} ${p}`, o.scope]));
    expect(mine["POST /v1/orders/to-target"]).toBe("paper");
    expect(mine["POST /v1/orders/batch"]).toBe("paper");
    expect(mine["POST /v1/margin/basket"]).toBe("read");
  });
});

describe("naming tolerance on POST /v1/orders", () => {
  const order = (over = {}) => ({ account: "paper", symbol: RELIANCE, side: "BUY", quantity: 1, product: "MIS", orderType: "LIMIT", price: 1400, ...over });

  it("MIS is INTRADAY, NRML is MARGIN, and the canonical value is echoed", async () => {
    const r = await call("POST", "/v1/orders", { body: order() });
    expect(r.status).toBe(201);
    expect(r.json.data.product).toBe("INTRADAY");
    expect(r.json.meta.normalised).toEqual([{ field: "product", from: "MIS", to: "INTRADAY" }]);
    const f = await call("POST", "/v1/orders", { body: order({ symbol: FUT, quantity: 65, product: "nrml", price: 25060 }) });
    expect(f.status).toBe(201);
    expect(f.json.data.product).toBe("MARGIN");
    expect(f.json.meta.normalised).toEqual([{ field: "product", from: "nrml", to: "MARGIN" }]);
  });

  it("CNC stays CNC and gets no note; lower-case side and order type are read", async () => {
    const r = await call("POST", "/v1/orders", { body: order({ product: "CNC", side: "buy", orderType: "limit" }) });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ product: "CNC", side: "BUY", orderType: "LIMIT" });
    expect(r.json.meta.normalised.map((n) => n.field).sort()).toEqual(["orderType", "side"]);
    const plain = await call("POST", "/v1/orders", { body: order({ product: "CNC" }) });
    expect(plain.json.meta.normalised).toBeUndefined();
  });

  it("an alias and the canonical word are the same order for idempotency", async () => {
    const key = newKey();
    const a = await call("POST", "/v1/orders", { body: order(), headers: idem(key) });
    const b = await call("POST", "/v1/orders", { body: order({ product: "INTRADAY" }), headers: idem(key) });
    expect(b.status).toBe(201);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(b.json.data.orderId).toBe(a.json.data.orderId);
  });

  it("a word that is not an alias is still refused, and the preview echoes too", async () => {
    const r = await call("POST", "/v1/orders", { body: order({ product: "COVER" }) });
    expect(r.status).toBe(400);
    const pv = await call("POST", "/v1/orders/preview", { body: order() });
    expect(pv.status).toBe(200);
    expect(pv.json.meta.normalised).toEqual([{ field: "product", from: "MIS", to: "INTRADAY" }]);
  });

  it("mode is never normalised: LIVE in capitals is refused, not read as live", async () => {
    const r = await call("POST", "/v1/orders", { body: order({ mode: "LIVE" }) });
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/orders/to-target", () => {
  it("places only the difference: long 3, target 5 buys 2", async () => {
    seedPos("paper", RELIANCE, "INTRADAY", 3);
    const r = await call("POST", "/v1/orders/to-target", { body: target(), headers: idem(newKey()) });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ account: "paper", symbol: RELIANCE, currentQuantity: 3, targetQuantity: 5, delta: 2, action: "BUY", placed: true, dryRun: false, mode: "paper" });
    expect(r.json.data.order).toMatchObject({ side: "BUY", quantity: 2, product: "INTRADAY", mode: "paper" });
    expect(placedByPaper()).toHaveLength(1);
    expect(r.json.meta).toMatchObject({ accountId: "paper", mode: "paper" });
  });

  it("goes flat, goes short, and crosses zero in one order", async () => {
    seedPos("paper", RELIANCE, "INTRADAY", 3);
    const flat = await call("POST", "/v1/orders/to-target", { body: target({ targetQuantity: 0 }) });
    expect(flat.json.data).toMatchObject({ currentQuantity: 3, delta: -3, action: "SELL" });
    expect(flat.json.data.order).toMatchObject({ side: "SELL", quantity: 3 });
    const short = await call("POST", "/v1/orders/to-target", { body: target({ targetQuantity: -2, price: 1401, openOrders: "ignore" }) });
    expect(short.json.data).toMatchObject({ delta: -5, action: "SELL" });
    expect(short.json.data.order.quantity).toBe(5);
  });

  it("already at the target: action NONE, no order, HTTP 200", async () => {
    seedPos("paper", RELIANCE, "INTRADAY", 5);
    const r = await call("POST", "/v1/orders/to-target", { body: target() });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ currentQuantity: 5, delta: 0, action: "NONE", placed: false, order: null });
    expect(placedByPaper()).toHaveLength(0);
  });

  it("targetLots uses the lot size; a flat unknown-free book starts at zero", async () => {
    const r = await call("POST", "/v1/orders/to-target", { body: { account: "paper", symbol: FUT, targetLots: 2, product: "MARGIN", orderType: "LIMIT", price: 25060 } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ lotSize: 65, currentQuantity: 0, targetQuantity: 130, delta: 130, action: "BUY" });
    expect(r.json.data.order.quantity).toBe(130);
  });

  it("a target that is not a lot multiple is refused", async () => {
    const r = await call("POST", "/v1/orders/to-target", { body: { account: "paper", symbol: FUT, targetQuantity: 100, product: "MARGIN", orderType: "LIMIT", price: 25060 } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("INVALID_ORDER");
    expect(placedByPaper()).toHaveLength(0);
  });

  it("sizes against the same product only and reports the others", async () => {
    seedPos("paper", RELIANCE, "CNC", 10);
    const r = await call("POST", "/v1/orders/to-target", { body: target({ targetQuantity: 4 }) });
    expect(r.json.data).toMatchObject({ currentQuantity: 0, delta: 4, otherProducts: [{ product: "CNC", netQty: 10 }] });
  });

  it("MIS and the index-free symbol words are read like on a single order", async () => {
    const r = await call("POST", "/v1/orders/to-target", { body: target({ product: "mis", symbol: "NSE_EQ:RELIANCE" }) });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ symbol: RELIANCE, product: "INTRADAY" });
    expect(r.json.meta.normalised).toEqual([{ field: "product", from: "mis", to: "INTRADAY" }]);
  });

  it("dryRun checks everything and places nothing", async () => {
    seedPos("paper", RELIANCE, "INTRADAY", 3);
    const r = await call("POST", "/v1/orders/to-target", { body: target({ dryRun: true }) });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ dryRun: true, placed: false, delta: 2, action: "BUY", order: null });
    expect(r.json.data.preview).toMatchObject({ ok: true, quantity: 2 });
    expect(placedByPaper()).toHaveLength(0);
  });

  it("a dry run that breaks a rule says so in the preview checks", async () => {
    safety.refuse = [{ code: "DAILY_LIMIT_REACHED", message: "limit" }];
    const r = await call("POST", "/v1/orders/to-target", { body: target({ dryRun: true }) });
    expect(r.status).toBe(200);
    expect(r.json.data.preview.ok).toBe(false);
  });

  describe("an unreadable position places nothing", () => {
    it("paper read fails -> POSITION_UNKNOWN", async () => {
      const original = paper.positions;
      paper.positions = async () => {
        throw new Error("disk gone");
      };
      try {
        const r = await call("POST", "/v1/orders/to-target", { body: target() });
        expect(r.status).toBe(503);
        expect(r.json).toMatchObject({ code: "POSITION_UNKNOWN", retryable: true });
        expect(r.json.detail).toMatch(/Nothing was placed/);
        expect(placedByPaper()).toHaveLength(0);
      } finally {
        paper.positions = original;
      }
    });

    it("live read fails -> POSITION_UNKNOWN, no broker order", async () => {
      const original = zerodha.fetchPositions;
      zerodha.fetchPositions = async () => {
        throw new Error("broker down");
      };
      try {
        const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }), headers: idem(newKey()) });
        expect(r.status).toBe(503);
        expect(r.json.code).toBe("POSITION_UNKNOWN");
        expect(zerodha.placed).toHaveLength(0);
      } finally {
        zerodha.fetchPositions = original;
      }
    });

    it("a malformed positions answer -> POSITION_UNKNOWN", async () => {
      const original = zerodha.fetchPositions;
      zerodha.fetchPositions = async () => ({ status: "error", message: "nope" });
      try {
        const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }), headers: idem(newKey()) });
        expect(r.json.code).toBe("POSITION_UNKNOWN");
        expect(zerodha.placed).toHaveLength(0);
      } finally {
        zerodha.fetchPositions = original;
      }
    });

    it("a row the Bridge cannot name but that looks like the symbol -> POSITION_UNKNOWN; an unrelated one does not block", async () => {
      zerodha.positions = [{ tradingSymbol: "RELIANCE-BE", exchange: "NSE", token: "999999", product: "CNC", netQty: 7, avgPrice: 1, ltp: 1, pnl: 0, realisedPnl: null, unrealisedPnl: 0 }];
      const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }), headers: idem(newKey()) });
      expect(r.json.code).toBe("POSITION_UNKNOWN");
      expect(zerodha.placed).toHaveLength(0);
      zerodha.positions = [{ tradingSymbol: "SOMETHINGELSE", exchange: "NSE", token: "999998", product: "CNC", netQty: 7, avgPrice: 1, ltp: 1, pnl: 0, realisedPnl: null, unrealisedPnl: 0 }];
      const ok = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }), headers: idem(newKey()) });
      expect(ok.status).toBe(201);
    });

    it("a position row with no usable quantity -> POSITION_UNKNOWN", async () => {
      paper.seed("paper", { positions: [{ symbol: RELIANCE, product: "INTRADAY", netQty: "lots" }] });
      const r = await call("POST", "/v1/orders/to-target", { body: target() });
      expect(r.json.code).toBe("POSITION_UNKNOWN");
      expect(placedByPaper()).toHaveLength(0);
    });

    it("live delivery that shows in positions AND holdings -> POSITION_UNKNOWN", async () => {
      zerodha.positions = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", product: "CNC", netQty: 2, avgPrice: 1, ltp: 1, pnl: 0, realisedPnl: null, unrealisedPnl: 0 }];
      zerodha.holdings = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", qty: 10, avgPrice: 1, ltp: 1, pnl: 0 }];
      const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }), headers: idem(newKey()) });
      expect(r.json.code).toBe("POSITION_UNKNOWN");
      expect(r.json.detail).toMatch(/holdings/);
      expect(zerodha.placed).toHaveLength(0);
    });
  });

  it("live: reads the broker position, sends only the delta, with the key", async () => {
    zerodha.positions = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", product: "CNC", netQty: 1, avgPrice: 1, ltp: 1, pnl: 0, realisedPnl: null, unrealisedPnl: 0 }];
    const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore", targetQuantity: 4 }), headers: idem(newKey()) });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ currentQuantity: 1, delta: 3, action: "BUY", mode: "live" });
    expect(zerodha.placed).toHaveLength(1);
    expect(zerodha.placed[0].order.lots).toBe(3);
  });

  it("live: an order of the Bridge that is still open in the same symbol and product blocks the next request", async () => {
    const key = newKey();
    const first = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", targetQuantity: 2, openOrders: "ignore" }), headers: idem(key) });
    expect(first.status).toBe(201);
    const second = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", targetQuantity: 2 }), headers: idem(newKey()) });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("STATE_CONFLICT");
    expect(zerodha.placed).toHaveLength(1);
  });

  it("live delivery held only in the holdings counts", async () => {
    zerodha.holdings = [{ tradingSymbol: "RELIANCE", exchange: "NSE", token: "738561", qty: 10, avgPrice: 1, ltp: 1, pnl: 0 }];
    const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore", targetQuantity: 12 }), headers: idem(newKey()) });
    expect(r.json.data).toMatchObject({ currentQuantity: 10, delta: 2 });
  });

  it("live still needs an Idempotency-Key or clientOrderId (the order service's rule)", async () => {
    const r = await call("POST", "/v1/orders/to-target", { body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }) });
    expect(r.status).toBe(400);
    expect(zerodha.placed).toHaveLength(0);
  });

  describe("the same gates as POST /v1/orders", () => {
    it("kill switch engaged -> 423 and nothing placed", async () => {
      safety.refuse = [{ code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on." }];
      const r = await call("POST", "/v1/orders/to-target", { body: target() });
      expect(r.status).toBe(423);
      expect(r.json.code).toBe("KILL_SWITCH_ACTIVE");
      expect(placedByPaper()).toHaveLength(0);
    });

    it("a safety limit refuses the delta order", async () => {
      safety.refuse = [{ code: "DAILY_LIMIT_REACHED", message: "daily limit" }];
      const r = await call("POST", "/v1/orders/to-target", { body: target() });
      expect(r.status).toBe(403);
      expect(placedByPaper()).toHaveLength(0);
    });

    it("live without the opt-ins: a paper-only key is SCOPE_REQUIRED, a paper account is PAPER_ONLY; nothing placed", async () => {
      const scope = await call("POST", "/v1/orders/to-target", { key: RAW.paper, body: target({ account: "zerodha-main", mode: "live", product: "CNC", openOrders: "ignore" }), headers: idem(newKey()) });
      expect(scope.status).toBe(403);
      expect(scope.json.code).toBe("SCOPE_REQUIRED");
      const onPaper = await call("POST", "/v1/orders/to-target", { body: target({ mode: "live" }), headers: idem(newKey()) });
      expect(onPaper.status).toBe(403);
      expect(onPaper.json.code).toBe("PAPER_ONLY");
      expect(zerodha.placed).toHaveLength(0);
      expect(placedByPaper()).toHaveLength(0);
    });

    it("a price that breaks the tick size is refused by the same pre-trade checks", async () => {
      const r = await call("POST", "/v1/orders/to-target", { body: target({ price: 1400.03 }) });
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("INVALID_ORDER");
    });

    it("an AI-assistant key needs the human confirmation, exactly as on POST /v1/orders", async () => {
      const r = await call("POST", "/v1/orders/to-target", { key: RAW.mcp, body: target() });
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("CONFIRMATION_REQUIRED");
      expect(placedByPaper()).toHaveLength(0);
      const dry = await call("POST", "/v1/orders/to-target", { key: RAW.mcp, body: target({ dryRun: true }) });
      expect(dry.json.data.preview).toMatchObject({ requiresHumanConfirmation: true, ticketId: expect.any(String) });
    });
  });

  describe("hostile input", () => {
    it.each([
      ["a huge unit target", { targetQuantity: 1e12 }],
      ["a huge lot target", { targetQuantity: undefined, targetLots: 1e9 }],
      ["a fractional target", { targetQuantity: 2.5 }],
      ["a string target", { targetQuantity: "5" }],
      ["a null target", { targetQuantity: null }],
      ["an exponent target", { targetQuantity: 1e400 }],
      ["both target fields", { targetLots: 1 }],
      ["no target field", { targetQuantity: undefined }],
      ["an unknown field", { leverage: 5 }],
      ["a negative price", { price: -1 }],
      ["an absurd price", { price: 1e12 }],
      ["a price on a MARKET order", { orderType: "MARKET" }],
      ["no price on a LIMIT order", { price: undefined }],
      ["a bad account id", { account: "../etc" }],
      ["a bad clientOrderId", { clientOrderId: "no spaces allowed" }],
      ["dryRun as a string", { dryRun: "yes" }],
      ["an unknown product", { product: "COVER" }],
    ])("%s is VALIDATION_FAILED and places nothing", async (_name, over) => {
      const r = await call("POST", "/v1/orders/to-target", { body: target(over) });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json.code).toBe("VALIDATION_FAILED");
      expect(placedByPaper()).toHaveLength(0);
    });

    it("not JSON, an array and an empty body are refused", async () => {
      expect((await call("POST", "/v1/orders/to-target", { body: "{nope" })).status).toBe(400);
      expect((await call("POST", "/v1/orders/to-target", { body: [] })).status).toBe(400);
      expect((await call("POST", "/v1/orders/to-target", {})).status).toBe(400);
    });

    it("an unknown account is ACCOUNT_NOT_FOUND, a read-only key is SCOPE_REQUIRED, no key is 401", async () => {
      expect((await call("POST", "/v1/orders/to-target", { body: target({ account: "nobody" }) })).status).toBe(404);
      const ro = await call("POST", "/v1/orders/to-target", { key: RAW.read, body: target() });
      expect(ro.status).toBe(403);
      expect(ro.json.code).toBe("SCOPE_REQUIRED");
      expect((await call("POST", "/v1/orders/to-target", { key: null, body: target() })).status).toBe(401);
      expect(placedByPaper()).toHaveLength(0);
    });

    it("an unknown or ambiguous symbol places nothing", async () => {
      expect((await call("POST", "/v1/orders/to-target", { body: target({ symbol: "NSE:NOPE" }) })).status).toBe(404);
      expect((await call("POST", "/v1/orders/to-target", { body: target({ symbol: "NSE:NIFTY" }) })).status).toBe(422); // an index cannot be traded
      expect(placedByPaper()).toHaveLength(0);
    });
  });

  describe("idempotency", () => {
    it("a retry with the same key and body gets the first answer back (also after the position changed); one order", async () => {
      const key = newKey();
      const first = await call("POST", "/v1/orders/to-target", { body: target(), headers: idem(key) });
      expect(first.status).toBe(201);
      seedPos("paper", RELIANCE, "INTRADAY", 5); // the fill arrived: a fresh read would now say "nothing to do"
      const again = await call("POST", "/v1/orders/to-target", { body: target(), headers: idem(key) });
      expect(again.status).toBe(201);
      expect(again.headers["idempotency-replayed"]).toBe("true");
      expect(again.json.data.replayed).toBe(true);
      expect(again.json.data.order.orderId).toBe(first.json.data.order.orderId);
      expect(placedByPaper()).toHaveLength(1);
    });

    it("the same key with another body is IDEMPOTENCY_KEY_REUSED", async () => {
      const key = newKey();
      await call("POST", "/v1/orders/to-target", { body: target(), headers: idem(key) });
      const other = await call("POST", "/v1/orders/to-target", { body: target({ targetQuantity: 9 }), headers: idem(key) });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("two concurrent requests with one key place one order", async () => {
      const key = newKey();
      const results = await Promise.all([1, 2, 3].map(() => call("POST", "/v1/orders/to-target", { body: target(), headers: idem(key) })));
      expect(placedByPaper()).toHaveLength(1);
      const codes = results.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
      for (const r of results) if (r.status !== 201) expect(r.json.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    });

    it("a request that failed releases its key", async () => {
      const key = newKey();
      safety.refuse = [{ code: "DAILY_LIMIT_REACHED", message: "daily limit" }];
      expect((await call("POST", "/v1/orders/to-target", { body: target(), headers: idem(key) })).status).toBe(403);
      safety.refuse = [];
      expect((await call("POST", "/v1/orders/to-target", { body: target(), headers: idem(key) })).status).toBe(201);
    });

    it("a clientOrderId alone is the key, and a reused one is refused", async () => {
      const body = target({ clientOrderId: "tt-cid-0001" });
      expect((await call("POST", "/v1/orders/to-target", { body })).status).toBe(201);
      const again = await call("POST", "/v1/orders/to-target", { body });
      expect(again.headers["idempotency-replayed"]).toBe("true");
      const other = await call("POST", "/v1/orders/to-target", { body: { ...body, targetQuantity: 7 } });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe("DUPLICATE_CLIENT_ORDER_ID");
      expect(placedByPaper()).toHaveLength(1);
    });

    it("two different keys for the same target do not both place: the second sees the first's open order", async () => {
      const [a, b] = await Promise.all([
        call("POST", "/v1/orders/to-target", { body: target(), headers: idem(newKey()) }),
        call("POST", "/v1/orders/to-target", { body: target(), headers: idem(newKey()) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect([a, b].find((r) => r.status === 409).json.code).toBe("STATE_CONFLICT");
      expect(placedByPaper()).toHaveLength(1);
    });
  });

  describe("open orders", () => {
    it("an open entry order blocks; openOrders: ignore overrides; a resting stop does not block", async () => {
      await call("POST", "/v1/orders", { body: { account: "paper", symbol: RELIANCE, side: "BUY", quantity: 1, product: "INTRADAY", orderType: "LIMIT", price: 1300 } });
      const blocked = await call("POST", "/v1/orders/to-target", { body: target() });
      expect(blocked.status).toBe(409);
      expect(blocked.json.code).toBe("STATE_CONFLICT");
      const forced = await call("POST", "/v1/orders/to-target", { body: target({ openOrders: "ignore" }) });
      expect(forced.status).toBe(201);
      await paper.reset("paper");
      await call("POST", "/v1/orders", { body: { account: "paper", symbol: RELIANCE, side: "SELL", quantity: 1, product: "INTRADAY", orderType: "SL", price: 1290, triggerPrice: 1300 } });
      const stop = await call("POST", "/v1/orders/to-target", { body: target() });
      expect(stop.status).toBe(201);
      expect(stop.json.data.openOrders).toHaveLength(1);
    });
  });
});

describe("POST /v1/orders/batch", () => {
  const leg = (over = {}) => ({ symbol: RELIANCE, side: "BUY", quantity: 1, product: "INTRADAY", orderType: "LIMIT", price: 1400, ...over });
  const batch = (orders, over = {}) => ({ account: "paper", orders, ...over });

  it("places every leg and answers one result per leg in the order sent", async () => {
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg(), leg({ symbol: FUT, quantity: 65, product: "MIS", price: 25060 })]), headers: idem(newKey()) });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ ok: true, summary: { total: 2, placed: 2, rejected: 0, outcomeUnknown: 0, skipped: 0 }, replayed: false });
    expect(r.json.data.results.map((x) => [x.index, x.ok, x.status])).toEqual([[0, true, "placed"], [1, true, "placed"]]);
    expect(r.json.data.results[1].order.product).toBe("INTRADAY");
    expect(placedByPaper()).toHaveLength(2);
  });

  it("each leg uses the request key plus its index", async () => {
    const key = newKey();
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg(), leg({ quantity: 2 })]), headers: idem(key) });
    expect(r.json.data.results.map((x) => x.idempotencyKey)).toEqual([`${key}:0`, `${key}:1`]);
    // so a single-order retry of leg 1 with that key and body replays the same order
    const single = await call("POST", "/v1/orders", { body: { account: "paper", ...leg({ quantity: 2 }) }, headers: idem(`${key}:1`) });
    expect(single.headers["idempotency-replayed"]).toBe("true");
    expect(single.json.data.orderId).toBe(r.json.data.results[1].orderId);
    expect(legKey("k".repeat(300), 3)).toMatch(/^[0-9a-f]{40}:3$/);
  });

  it("a refused leg is its own error and does not hide: 207 with the counts", async () => {
    safety.refuse = (intent) => (intent.order.symbol === FUT ? [{ code: "DAILY_LIMIT_REACHED", message: "daily limit" }] : []);
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg(), leg({ symbol: FUT, quantity: 65, product: "MARGIN", price: 25060 }), leg({ product: "COVER" })]) });
    expect(r.status).toBe(207);
    expect(r.json.data.ok).toBe(false);
    expect(r.json.data.summary).toEqual({ total: 3, placed: 1, rejected: 2, outcomeUnknown: 0, skipped: 0 });
    const [a, b, c] = r.json.data.results;
    expect(a).toMatchObject({ index: 0, ok: true, status: "placed" });
    expect(b).toMatchObject({ index: 1, ok: false, status: "rejected", error: { code: "DAILY_LIMIT_REACHED", status: 403, retryable: false } });
    expect(c).toMatchObject({ index: 2, ok: false, status: "rejected", error: { code: "VALIDATION_FAILED" } });
    expect(placedByPaper()).toHaveLength(1);
  });

  it("no leg went out: 422 with the same envelope", async () => {
    safety.refuse = [{ code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on." }];
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg(), leg({ quantity: 2 })]), headers: idem(newKey()) });
    expect(r.status).toBe(422);
    expect(r.json.data).toMatchObject({ ok: false, summary: { total: 2, placed: 0, rejected: 2 } });
    expect(r.json.data.results.every((x) => x.error.code === "KILL_SWITCH_ACTIVE")).toBe(true);
    expect(placedByPaper()).toHaveLength(0);
  });

  it("stopOnError skips the rest after the first leg that did not go out", async () => {
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg(), leg({ product: "COVER" }), leg({ quantity: 3 })], { stopOnError: true }) });
    expect(r.status).toBe(207);
    expect(r.json.data.results.map((x) => x.status)).toEqual(["placed", "rejected", "skipped"]);
    expect(r.json.data.summary).toMatchObject({ placed: 1, rejected: 1, skipped: 1 });
    expect(r.json.data.results[2].reason).toMatch(/stopOnError/);
    expect(placedByPaper()).toHaveLength(1);
  });

  it("legOrder buys-first sends buys first and still reports in the order sent", async () => {
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg({ side: "SELL", quantity: 2 }), leg({ side: "BUY", quantity: 1 })], { legOrder: "buys-first" }) });
    expect(r.status).toBe(201);
    expect(placedByPaper().map((c) => c[2].side)).toEqual(["BUY", "SELL"]);
    expect(r.json.data.results.map((x) => x.order.side)).toEqual(["SELL", "BUY"]);
  });

  it("a leg may not name another account, and a batch-level mode applies to legs without their own", async () => {
    const r = await call("POST", "/v1/orders/batch", { body: batch([leg({ account: "zerodha-main" }), leg({ account: "paper" })]) });
    expect(r.status).toBe(207);
    expect(r.json.data.results[0].error.code).toBe("VALIDATION_FAILED");
    expect(r.json.data.results[1].ok).toBe(true);
    const live = await call("POST", "/v1/orders/batch", { body: batch([leg()], { mode: "live" }), headers: idem(newKey()) });
    expect(live.json.data.results[0].error.code).toBe("PAPER_ONLY"); // paper account: the batch mode reached the leg
  });

  it("replays the whole batch for the same key and body; another body is refused", async () => {
    const key = newKey();
    const body = batch([leg(), leg({ quantity: 2 })]);
    const first = await call("POST", "/v1/orders/batch", { body, headers: idem(key) });
    const again = await call("POST", "/v1/orders/batch", { body, headers: idem(key) });
    expect(again.status).toBe(201);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.json.data.replayed).toBe(true);
    expect(again.json.data.results.map((x) => x.orderId)).toEqual(first.json.data.results.map((x) => x.orderId));
    expect(placedByPaper()).toHaveLength(2);
    const grown = await call("POST", "/v1/orders/batch", { body: batch([leg(), leg({ quantity: 2 }), leg({ quantity: 3 })]), headers: idem(key) });
    expect(grown.status).toBe(409);
    expect(grown.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(placedByPaper()).toHaveLength(2);
  });

  it("concurrent requests with one key place each leg once", async () => {
    const key = newKey();
    const body = batch([leg(), leg({ quantity: 2 })]);
    const rs = await Promise.all([1, 2, 3].map(() => call("POST", "/v1/orders/batch", { body, headers: idem(key) })));
    expect(placedByPaper()).toHaveLength(2);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    for (const r of rs) if (r.status === 409) expect(r.json.code).toBe("IDEMPOTENCY_IN_PROGRESS");
  });

  it("a batch where nothing went out may be retried with the same key", async () => {
    const key = newKey();
    safety.refuse = [{ code: "DAILY_LIMIT_REACHED", message: "daily limit" }];
    expect((await call("POST", "/v1/orders/batch", { body: batch([leg()]), headers: idem(key) })).status).toBe(422);
    safety.refuse = [];
    expect((await call("POST", "/v1/orders/batch", { body: batch([leg()]), headers: idem(key) })).status).toBe(201);
  });

  it("live legs need the key: without one every live leg is refused and nothing is sent", async () => {
    const live = (over) => leg({ mode: "live", product: "CNC", ...over });
    const noKey = await call("POST", "/v1/orders/batch", { body: { account: "zerodha-main", orders: [live(), live({ quantity: 2 })] } });
    expect(noKey.status).toBe(422);
    expect(noKey.json.data.results.every((x) => x.error.code === "VALIDATION_FAILED")).toBe(true);
    expect(zerodha.placed).toHaveLength(0);
    const key = newKey();
    const ok = await call("POST", "/v1/orders/batch", { body: { account: "zerodha-main", orders: [live(), live({ quantity: 2 })] }, headers: idem(key) });
    expect(ok.status).toBe(201);
    expect(zerodha.placed.map((p) => p.order.lots)).toEqual([1, 2]);
  });

  it("live legs keep the live gates: a paper-only key is SCOPE_REQUIRED per leg", async () => {
    const r = await call("POST", "/v1/orders/batch", { key: RAW.paper, body: { account: "zerodha-main", orders: [leg({ mode: "live", product: "CNC" })] }, headers: idem(newKey()) });
    expect(r.status).toBe(422);
    expect(r.json.data.results[0].error.code).toBe("SCOPE_REQUIRED");
    expect(zerodha.placed).toHaveLength(0);
  });

  describe("hostile input", () => {
    it("more than 20 legs, no legs, a huge list and a non-array are refused before anything is sent", async () => {
      const many = Array.from({ length: 21 }, () => leg());
      expect((await call("POST", "/v1/orders/batch", { body: batch(many) })).status).toBe(400);
      expect((await call("POST", "/v1/orders/batch", { body: batch([]) })).status).toBe(400);
      expect((await call("POST", "/v1/orders/batch", { body: batch(Array.from({ length: 20000 }, () => leg())) })).status).toBeGreaterThanOrEqual(400);
      expect((await call("POST", "/v1/orders/batch", { body: { account: "paper", orders: "nope" } })).status).toBe(400);
      expect((await call("POST", "/v1/orders/batch", { body: { account: "paper" } })).status).toBe(400);
      expect(placedByPaper()).toHaveLength(0);
    });

    it("exactly 20 legs is fine", async () => {
      const r = await call("POST", "/v1/orders/batch", { body: batch(Array.from({ length: 20 }, (_, i) => leg({ price: 1400 + i * 0.1 }))) });
      expect(r.status).toBe(201);
      expect(r.json.data.summary.placed).toBe(20);
    });

    it("leg values that are not orders become that leg's error", async () => {
      const r = await call("POST", "/v1/orders/batch", { body: batch([null, 5, "x", [], leg({ quantity: 1e12 }), leg({ quantity: -1 }), leg({ price: "abc" }), leg({ extra: true })]) });
      expect(r.status).toBe(422);
      expect(r.json.data.results).toHaveLength(8);
      expect(r.json.data.results.every((x) => x.error.code === "VALIDATION_FAILED")).toBe(true);
      expect(placedByPaper()).toHaveLength(0);
    });

    it("an unknown account, a read-only key, no key, an unknown top-level field and a bad key", async () => {
      expect((await call("POST", "/v1/orders/batch", { body: { account: "nobody", orders: [leg()] } })).status).toBe(404);
      expect((await call("POST", "/v1/orders/batch", { key: RAW.read, body: batch([leg()]) })).status).toBe(403);
      expect((await call("POST", "/v1/orders/batch", { key: null, body: batch([leg()]) })).status).toBe(401);
      expect((await call("POST", "/v1/orders/batch", { body: batch([leg()], { extra: 1 }) })).status).toBe(400);
      expect((await call("POST", "/v1/orders/batch", { body: batch([leg()]), headers: idem("x") })).status).toBe(400);
      expect(placedByPaper()).toHaveLength(0);
    });
  });
});

describe("POST /v1/margin/basket", () => {
  const basket = (over = {}) => ({ positions: [{ symbol: FUT, side: "BUY", lots: 1, price: 25060 }], ...over });
  beforeAll(() => {
    paper.estimateBasketMargin = async (_account, legs) => ({ model: "portfolio", alone: 100 * legs.length, standalone: 120 * legs.length, breakdown: { premium: 0, span: 80, exposure: 20, calendar: 0, elm: 0 }, fallback: [], method: "stub" });
  });

  it("a read-only key gets JSON numbers and the source", async () => {
    const r = await call("POST", "/v1/margin/basket", { key: RAW.read, body: basket() });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ total: 100, span: 80, exposure: 20, hedgeBenefit: 20, source: "paper-model", account: "paper", legs: 1 });
    expect(r.json.meta).toMatchObject({ accountId: "paper" });
    expect(placedByPaper()).toHaveLength(0);
  });

  it("MIS is read as INTRADAY", async () => {
    const r = await call("POST", "/v1/margin/basket", { key: RAW.read, body: basket({ positions: [{ symbol: RELIANCE, side: "SELL", quantity: 2, product: "MIS" }] }) });
    expect(r.status).toBe(200);
  });

  it("refuses bad bodies, an unknown account and a missing key", async () => {
    expect((await call("POST", "/v1/margin/basket", { key: RAW.read, body: { positions: [] } })).status).toBe(400);
    expect((await call("POST", "/v1/margin/basket", { key: RAW.read, body: basket({ positions: Array.from({ length: 51 }, () => ({ symbol: FUT, side: "BUY", lots: 1 })) }) })).status).toBe(400);
    expect((await call("POST", "/v1/margin/basket", { key: RAW.read, body: basket({ account: "nobody" }) })).status).toBe(404);
    expect((await call("POST", "/v1/margin/basket", { key: null, body: basket() })).status).toBe(401);
    expect((await call("POST", "/v1/margin/basket", { key: RAW.read, body: "{nope" })).status).toBe(400);
  });
});
