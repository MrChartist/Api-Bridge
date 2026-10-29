import { describe, expect, it } from "vitest";
import { createBookService, bookCsv } from "./bookService.mjs";
import { priceSourceFor } from "./pricing.mjs";

// 2026-10-29 11:15 IST
const NOW = Date.UTC(2026, 9, 29, 5, 45);

const CONFIG = {
  accounts: [
    { id: "zerodha-main", broker: "zerodha", label: "Main" },
    { id: "dhan-main", broker: "dhan", label: "Dhan" },
    { id: "upstox-asha", broker: "upstox", holder: "spouse", label: "Asha" },
    { id: "paper-asha", broker: "paper", holder: "spouse", label: "Asha paper" },
    { id: "paper-kid", broker: "paper", holder: "kid", label: "Kid paper" },
    { id: "dhan-friend", broker: "dhan", holder: "friend", label: "Friend" },
  ],
};
const TAGS = { spouse: { relationship: "spouse", label: "Asha" }, kid: { relationship: "dependent-child", label: "Kid" }, friend: { relationship: "other" } };

const POSITIONS = {
  "zerodha-main": [{ symbol: "NFO:NIFTY-2026-11-03-25600-CE", netQty: -130, avgPrice: 82.4, ltp: 119, pnl: -4758, realisedPnl: 0 }],
  "dhan-main": [
    { symbol: "NFO:NIFTY-2026-11-24-FUT", netQty: 65, avgPrice: 25150, ltp: 25190, pnl: 2600, realisedPnl: 0 },
    { symbol: "NSE:RELIANCE", netQty: 10, avgPrice: 1400, ltp: 1410, pnl: 100 },
    { symbol: "NFO:NIFTY-2026-11-03-25000-PE", netQty: 0, avgPrice: 0, ltp: 50, pnl: 300, realisedPnl: 300 },
  ],
  "upstox-asha": [{ symbol: "BFO:SENSEX-2026-11-05-83500-CE", netQty: -40, avgPrice: 245, ltp: 211, pnl: 1360, realisedPnl: 0 }],
  "paper-asha": [],
  "paper-kid": [{ symbol: "NFO:NIFTY-2026-11-03-25000-PE", netQty: 65, avgPrice: 90, ltp: 95, pnl: 325, realisedPnl: 0 }],
  "dhan-friend": [{ symbol: "NFO:NIFTY-2026-11-24-FUT", netQty: 65, avgPrice: 25100, ltp: 25190, pnl: 5850, realisedPnl: 0 }],
};
const QUOTES = {
  "NSE:NIFTY": { ltp: 25120 },
  "BSE:SENSEX": { ltp: 82300 },
  "NFO:NIFTY-2026-11-03-25600-CE": { ltp: 120.5, bid: 119.8, ask: 120.2 },
  "NFO:NIFTY-2026-11-24-FUT": { ltp: 25190, bid: 25189, ask: 25191 },
  "BFO:SENSEX-2026-11-05-83500-CE": { ltp: 210, bid: 209, ask: 211 },
  "NFO:NIFTY-2026-11-03-25000-PE": { ltp: 96, bid: 95.5, ask: 96.5 },
};

function fakes({ fail = new Set(), connected = ["zerodha-main", "dhan-main", "upstox-asha", "dhan-friend"], symbols: symbolsIn = null } = {}) {
  const calls = { quotes: [], positions: [], funds: [] };
  let t = NOW;
  const orders = {
    async positions(ctx, id, { mode }) {
      calls.positions.push([id, mode]);
      if (fail.has(id)) throw Object.assign(new Error("broker down"), { code: "BROKER_UNAVAILABLE" });
      return { items: POSITIONS[id] ?? [], freshness: { asOf: "t" } };
    },
    async funds(ctx, id) {
      calls.funds.push(id);
      return { funds: { usedMargin: 1000, availableCash: 5000 }, freshness: { asOf: "2026-10-29T11:15:00+05:30" } };
    },
  };
  const marketData = {
    async quotes(symbols, opts) {
      calls.quotes.push({ symbols, accountId: opts?.accountId });
      return { items: symbols.filter((s) => QUOTES[s]).map((s) => ({ symbol: s, ...QUOTES[s] })), errors: [] };
    },
  };
  const accounts = {
    list: () =>
      CONFIG.accounts.map((a) => ({
        id: a.id,
        broker: a.broker,
        label: a.label,
        session: { state: a.broker === "paper" || connected.includes(a.id) ? "connected" : "expired" },
        capabilities: a.broker === "paper" ? ["positions", "funds"] : ["quotes", "optionChain", "positions", "funds"],
      })),
  };
  const symbols = symbolsIn ?? { resolve: async (s) => ({ lotSize: s.startsWith("BFO") ? 20 : 65 }) };
  const svc = createBookService({ config: CONFIG, orders, marketData, accounts, symbols, holderTags: () => TAGS, clock: { now: () => t } });
  return { svc, calls, advance: (ms) => (t += ms) };
}

const ctxAll = { principal: { kind: "key", id: "k" }, key: { accounts: "*" } };
const ctxSome = { principal: { kind: "key", id: "k" }, key: { accounts: ["zerodha-main", "upstox-asha"] } };
const HOLDER_ACCOUNTS = { self: ["zerodha-main", "dhan-main"], spouse: ["upstox-asha", "paper-asha"], kid: ["paper-kid"], friend: ["dhan-friend"] };

describe("bookService", () => {
  it("pricing wall: every marketData call's accountId belongs to the holder being priced", async () => {
    const { svc, calls } = fakes();
    const body = await svc.read(ctxAll, { view: "holders" });
    const owner = new Map();
    for (const h of body.holders) {
      for (const u of h.underlyings) for (const l of u.legs) owner.set(l.symbol + "|" + l.account, h.holder);
    }
    expect(calls.quotes.length).toBe(4); // one batch per holder that holds F&O (self, spouse, kid, friend)
    for (const c of calls.quotes) {
      if (c.accountId === undefined) continue; // paper source (checked below)
      const holder = Object.entries(HOLDER_ACCOUNTS).find(([, ids]) => ids.includes(c.accountId))[0];
      // Every symbol in the batch is one of that holder's legs or an index spot.
      for (const s of c.symbols) if (!/^(NSE|BSE):/.test(s)) expect([...owner.entries()].some(([k, h]) => k.startsWith(s + "|") && h === holder)).toBe(true);
    }
    // The friend's NIFTY future is priced through the friend's own account, never the self account.
    const friendCall = calls.quotes.find((c) => c.accountId === "dhan-friend");
    expect(friendCall.symbols).toContain("NFO:NIFTY-2026-11-24-FUT");
    expect(calls.quotes.filter((c) => c.accountId === "zerodha-main" || c.accountId === "dhan-main").every((c) => !c.symbols.includes("NFO:NIFTY-2026-11-03-25000-PE"))).toBe(true);
  });

  it("a paper-only holder uses the paper source (unpinned); a holder with a live data account never does", async () => {
    const { svc, calls } = fakes();
    const body = await svc.read(ctxAll, { view: "holders" });
    const kid = body.holders.find((h) => h.holder === "kid");
    expect(kid.priceSource).toEqual({ kind: "paper" });
    expect(calls.quotes.filter((c) => c.accountId === undefined)).toHaveLength(1);
    expect(calls.quotes.find((c) => c.accountId === undefined).symbols).toEqual(["NSE:NIFTY", "NFO:NIFTY-2026-11-03-25000-PE"]);
    // Spouse has a live account and a paper account: priced from her live account.
    expect(body.holders.find((h) => h.holder === "spouse").priceSource).toEqual({ kind: "account", broker: "upstox", account: "upstox-asha" });
  });

  it("a holder whose live account is not connected: broker-reported P&L, no Greeks, the reason", async () => {
    const { svc, calls } = fakes({ connected: ["zerodha-main", "dhan-main", "dhan-friend"] });
    const body = await svc.read(ctxAll, { view: "family" });
    const spouse = body.holders.find((h) => h.holder === "spouse");
    expect(spouse.priceSource).toMatchObject({ kind: "none", code: "NO_DATA_ACCOUNT" });
    expect(spouse.priceSource.reason).toContain("No market-data account for Asha");
    expect(spouse.underlyings[0].greeks).toBeNull();
    expect(spouse.totals.pnl).toBe(1360);
    expect(calls.quotes.some((c) => c.symbols.includes("BFO:SENSEX-2026-11-05-83500-CE"))).toBe(false);
  });

  it("family view: in-family holders only; outsideFamily lists the friend; totals add up; every leg has its account", async () => {
    const { svc } = fakes();
    const body = await svc.read(ctxAll, { view: "family" });
    expect(body.family.holders).toEqual(["self", "spouse", "kid"]);
    expect(body.outsideFamily.map((h) => h.holder)).toEqual(["friend"]);
    const sum = body.holders.reduce((s, h) => s + h.totals.pnl, 0);
    expect(body.family.totals.pnl).toBeCloseTo(sum, 6);
    expect(body.holders.flatMap((h) => h.underlyings.flatMap((u) => u.legs)).every((l) => typeof l.account === "string" && l.account)).toBe(true);
    // Only F&O legs on NFO/BFO; the cash RELIANCE row is not a book leg; the closed PE adds its realised P&L.
    const self = body.holders[0];
    expect(self.underlyings.flatMap((u) => u.legs).map((l) => l.symbol)).toEqual(["NFO:NIFTY-2026-11-03-25600-CE", "NFO:NIFTY-2026-11-24-FUT"]);
    const dhan = self.accounts.find((a) => a.account === "dhan-main");
    expect(dhan.realised).toBe(300);
    expect(dhan.pnl).toBe(300 + 65 * (25190 - 25150));
    // The CE is marked at mid 120.00: −130 × (120 − 82.40) = −4,888.
    expect(self.accounts.find((a) => a.account === "zerodha-main").pnl).toBe(-4888);
    expect(self.underlyings[0].greeks.missing).toBe(0);
    expect(self.underlyings[0].lot).toBe(65);
  });

  it("per-account failures are isolated", async () => {
    const { svc } = fakes({ fail: new Set(["dhan-main"]) });
    const body = await svc.read(ctxAll, { view: "holders" });
    const self = body.holders[0];
    const dhan = self.accounts.find((a) => a.account === "dhan-main");
    expect(dhan.error).toEqual({ code: "BROKER_UNAVAILABLE", message: "broker down" });
    expect(dhan.pnl).toBeNull();
    expect(self.accounts.find((a) => a.account === "zerodha-main").pnl).toBe(-4888);
    expect(self.totals.pnl).toBe(-4888);
  });

  it("a lot-size lookup that fails is not remembered: the next read asks again", async () => {
    let ready = false;
    const symbols = {
      resolve: async (s) => {
        if (!ready) throw new Error("instruments still loading");
        return { lotSize: s.startsWith("BFO") ? 20 : 65 };
      },
    };
    const { svc, advance } = fakes({ symbols });
    const first = await svc.read(ctxAll, { view: "holders" });
    expect(first.holders[0].underlyings[0].lot).toBeNull();
    ready = true;
    advance(11_000);
    const second = await svc.read(ctxAll, { view: "holders" });
    expect(second.holders[0].underlyings[0].lot).toBe(65);
  });

  it("positions and funds are cached for cacheSeconds (10 s) per account", async () => {
    const { svc, calls, advance } = fakes();
    await svc.read(ctxAll, {});
    const n = calls.positions.length;
    advance(9_000);
    await svc.read(ctxAll, {});
    expect(calls.positions.length).toBe(n);
    advance(1_500);
    await svc.read(ctxAll, {});
    expect(calls.positions.length).toBe(2 * n);
  });

  it("a key limited to some accounts: only those, partial totals; named accounts are checked", async () => {
    const { svc, calls } = fakes();
    const body = await svc.read(ctxSome, { view: "family" });
    expect(body.holders.map((h) => [h.holder, h.accounts.map((a) => a.account)])).toEqual([["self", ["zerodha-main"]], ["spouse", ["upstox-asha"]]]);
    expect(body.family.totals.partial).toBe(true);
    // Never spends another account's market data: the data account must be one the key may use.
    expect(calls.quotes.every((c) => c.accountId === undefined || ["zerodha-main", "upstox-asha"].includes(c.accountId))).toBe(true);
    await expect(svc.read(ctxSome, { accounts: ["dhan-main"] })).rejects.toMatchObject({ code: "ACCOUNT_FORBIDDEN" });
    await expect(svc.read(ctxSome, { accounts: ["nope"] })).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("underlying filter, mode=live skips paper accounts, CSV has one row per leg", async () => {
    const { svc } = fakes();
    const body = await svc.read(ctxAll, { underlying: "SENSEX" });
    expect(body.holders.flatMap((h) => h.underlyings.map((u) => u.underlying))).toEqual(["SENSEX"]);
    const live = await svc.read(ctxAll, { mode: "live" });
    expect(live.holders.flatMap((h) => h.accounts.map((a) => a.account))).not.toContain("paper-kid");
    const rows = bookCsv(await svc.read(ctxAll, { view: "holders" }));
    expect(rows[0][0]).toBe("holder");
    expect(rows.length).toBe(1 + 5);
  });
});

describe("price source (pricing wall)", () => {
  const summaries = new Map([
    ["a", { session: { state: "connected" }, capabilities: ["quotes"] }],
    ["b", { session: { state: "connected" }, capabilities: ["quotes", "optionChain"] }],
    ["c", { session: { state: "expired" }, capabilities: ["quotes", "optionChain"] }],
  ]);
  const all = () => true;
  it("prefers a connected account with optionChain, then any with quotes; paper-only → paper; else none", () => {
    expect(priceSourceFor([{ id: "a", broker: "x" }, { id: "b", broker: "y" }], { summaries, canSee: all, label: "Me" })).toEqual({ kind: "account", accountId: "b", broker: "y" });
    expect(priceSourceFor([{ id: "a", broker: "x" }, { id: "c", broker: "y" }], { summaries, canSee: all, label: "Me" })).toEqual({ kind: "account", accountId: "a", broker: "x" });
    expect(priceSourceFor([{ id: "p", broker: "paper" }], { summaries, canSee: all, label: "Me" })).toEqual({ kind: "paper" });
    expect(priceSourceFor([{ id: "c", broker: "y" }, { id: "p", broker: "paper" }], { summaries, canSee: all, label: "Me" })).toMatchObject({ kind: "none", code: "NO_DATA_ACCOUNT" });
    // An account the key may not use is never the data account.
    expect(priceSourceFor([{ id: "b", broker: "y" }], { summaries, canSee: (id) => id !== "b", label: "Me" })).toMatchObject({ kind: "none" });
  });
});
