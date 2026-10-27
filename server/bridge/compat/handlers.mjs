/**
 * Compatibility REST handlers (stream S14). Each takes the parsed JSON body (with `apikey`) and answers in
 * the style's shapes: { status: "success", ... } or { status: "error", message }.
 *
 * Every call goes through the same Bridge services as /v1: market data is streaming-first and rate-limit aware,
 * orders pass the same validation, idempotency, safety checks and audit log. Nothing here talks to a broker directly.
 */
import { randomUUID } from "node:crypto";
import { BridgeError } from "../core/errors.mjs";
import { parseSymbol } from "../core/symbolFormat.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";
import {
  INTERVALS_OUT,
  INTERVAL_IN,
  PRICE_TYPES,
  PRODUCT_IN,
  PRODUCT_OUT,
  STATUS_OUT,
  expiryToIso,
  fromCanonical,
  instrumentType,
  isoToCompact,
  isoToDashed,
  money,
  num,
  toCanonical,
} from "./mapping.mjs";

const bad = (msg, path) => new BridgeError("VALIDATION_FAILED", msg, path ? { errors: [{ path, message: msg }] } : undefined);
const str = (v) => (v === null || v === undefined ? "" : String(v));
const n2 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {object} deps full deps (orders, marketData, symbols, accounts, config)
 * @param {{ account?: string, analyzer: boolean }} cfg parsed compat config
 */
export function createCompatHandlers(deps, cfg) {
  /** keyId -> analyzer on/off (in memory; restarts go back to the config default) */
  const analyzer = new Map();
  const analyzeOn = (ctx) => analyzer.get(ctx.key?.id ?? "local") ?? cfg.analyzer;
  const mode = (ctx) => (analyzeOn(ctx) ? "paper" : "live");
  const ok = (ctx, body) => ({ status: "success", ...body, ...(analyzeOn(ctx) ? { mode: "analyze" } : {}) });

  /** The account a compat call acts on: body.account (Bridge extension), config compat.account, else the first the key may use. */
  function account(ctx, body) {
    const want = typeof body.account === "string" && body.account ? body.account : cfg.account;
    if (want) {
      ctx.requireAccountAccess(want);
      return want;
    }
    const allowed = allowedAccountsFor(ctx);
    const list = deps.accounts.list().filter((a) => a.enabled !== false && (!allowed || allowed.includes(a.id)));
    const live = list.find((a) => a.broker !== "paper");
    const pick = analyzeOn(ctx) ? list[0] : live;
    if (!pick) throw new BridgeError("ACCOUNT_NOT_FOUND", "No account is configured for compat calls. Set compat.account in bridge.config.json, or add an account.");
    return pick.id;
  }

  /** Read options. forOrder: the result picks or prices an order, so backup (public, possibly delayed) data is never used. */
  const readOpts = (ctx, { forOrder = false } = {}) => {
    const o = { signal: ctx.signal, allowBackup: !forOrder && autoBackup() };
    const allowed = allowedAccountsFor(ctx);
    if (allowed) o.allowedAccounts = allowed;
    return o;
  };
  const autoBackup = () => {
    try {
      return Boolean(deps.backupData?.autoFallback?.());
    } catch {
      return false;
    }
  };

  // ── orders ──

  function orderRequest(ctx, body, { symbol, exchange, action, quantity } = {}) {
    const sym = toCanonical(symbol ?? body.symbol, exchange ?? body.exchange);
    const side = String(action ?? body.action ?? "").toUpperCase();
    if (side !== "BUY" && side !== "SELL") throw bad("action must be BUY or SELL.", "action");
    const pricetype = String(body.pricetype ?? "MARKET").toUpperCase();
    if (!PRICE_TYPES.includes(pricetype)) throw bad(`pricetype must be one of ${PRICE_TYPES.join(", ")}.`, "pricetype");
    const productIn = String(body.product ?? "MIS").toUpperCase();
    const product = PRODUCT_IN[productIn];
    if (!product) throw bad("product must be CNC, MIS or NRML.", "product");
    const qty = quantity ?? num(body.quantity, "quantity", { min: 1, int: true });
    const req = { account: account(ctx, body), symbol: sym, side, quantity: qty, product, orderType: pricetype, mode: mode(ctx) };
    const price = num(body.price, "price", { min: 0, dflt: 0 });
    const trigger = num(body.trigger_price, "trigger_price", { min: 0, dflt: 0 });
    const disclosed = num(body.disclosed_quantity, "disclosed_quantity", { min: 0, int: true, dflt: 0 });
    if (pricetype === "LIMIT" || pricetype === "SL") req.price = price;
    if (pricetype === "SL" || pricetype === "SL-M") req.triggerPrice = trigger;
    if (disclosed > 0) req.disclosedQuantity = disclosed;
    if (typeof body.strategy === "string" && body.strategy) req.tag = body.strategy.slice(0, 20).replace(/[^A-Za-z0-9 _.-]/g, "_");
    return req;
  }

  async function place(ctx, req) {
    const { order } = await deps.orders.place(ctx, req, { idempotencyKey: `oa-${randomUUID()}` });
    return order;
  }

  async function netPosition(ctx, accountId, canonical, product) {
    const { items } = await deps.orders.positions(ctx, accountId, { mode: mode(ctx) });
    return items.filter((p) => p.symbol === canonical && (!product || p.product === product)).reduce((s, p) => s + n2(p.netQty), 0);
  }

  function orderOut(o) {
    const { symbol, exchange } = fromCanonical(o.symbol);
    return {
      orderid: o.orderId,
      symbol,
      exchange,
      action: o.side,
      quantity: String(o.quantity),
      price: n2(o.price),
      trigger_price: n2(o.triggerPrice),
      pricetype: o.orderType,
      product: PRODUCT_OUT[o.product] ?? o.product,
      order_status: STATUS_OUT[o.status] ?? o.status,
      average_price: n2(o.avgPrice),
      timestamp: o.placedAt,
    };
  }

  /** The option symbol for an offset (ATM, ITM3, OTM2) from a chain. */
  async function optionFor(ctx, body, { forOrder = false } = {}) {
    const underlyingIn = String(body.underlying ?? "").toUpperCase();
    if (!underlyingIn) throw bad("underlying is required, for example NIFTY.", "underlying");
    const underlying = underlyingIn.replace(/\d{2}[A-Z]{3}\d{2}FUT$/, "");
    const right = String(body.option_type ?? "").toUpperCase();
    if (right !== "CE" && right !== "PE") throw bad("option_type must be CE or PE.", "option_type");
    const offset = String(body.offset ?? "ATM").toUpperCase();
    const m = /^(ATM)$|^(ITM|OTM)(\d{1,2})$/.exec(offset);
    if (!m) throw bad("offset must be ATM, ITM1-ITM50 or OTM1-OTM50.", "offset");
    const steps = m[1] ? 0 : Number(m[3]);
    if (!m[1] && (steps < 1 || steps > 50)) throw bad("offset must be ATM, ITM1-ITM50 or OTM1-OTM50.", "offset");
    let expiry;
    if (body.expiry_date) expiry = expiryToIso(body.expiry_date);
    else {
      const ex = await deps.marketData.expiries(underlying, readOpts(ctx, { forOrder }));
      expiry = ex.expiries[0];
      if (!expiry) throw new BridgeError("SYMBOL_NOT_FOUND", `No upcoming expiries for ${underlying}.`);
    }
    const chain = await deps.marketData.optionChain({ underlying, expiry, strikes: Math.min(100, steps + 2), greeks: false }, readOpts(ctx, { forOrder }));
    if (forOrder && chain.freshness?.source === "backup") throw new BridgeError("BROKER_UNAVAILABLE", "No broker account can price this option chain right now, so the strike cannot be chosen for an order.");
    const strikes = chain.rows.map((r) => r.strike);
    const atmIdx = strikes.indexOf(chain.atmStrike);
    if (atmIdx < 0) throw new BridgeError("UPSTREAM_ERROR", `Could not find the ATM strike for ${underlying}.`);
    // ITM calls are below the money, ITM puts above it.
    const dir = m[1] ? 0 : (m[2] === "ITM") === (right === "CE") ? -1 : 1;
    const row = chain.rows[atmIdx + dir * steps];
    const leg = row?.[right.toLowerCase()];
    if (!leg) throw new BridgeError("SYMBOL_NOT_FOUND", `No ${offset} ${right} strike for ${underlying} ${expiry}.`);
    const out = fromCanonical(leg.symbol);
    let tick = null;
    let freeze = null;
    try {
      const r = await deps.symbols.resolve(leg.symbol);
      tick = r.tickSize ?? null;
      freeze = r.freezeQty ?? null;
    } catch {
      // master not loaded: leave nulls
    }
    return { canonical: leg.symbol, symbol: out.symbol, exchange: out.exchange, lotsize: chain.lotSize, tick_size: tick, freeze_qty: freeze, underlying_ltp: chain.underlyingLtp, expiry };
  }

  return {
    async ping(ctx) {
      const acc = (() => {
        try {
          return deps.accounts.get(account(ctx, {}));
        } catch {
          return null;
        }
      })();
      return ok(ctx, { data: { message: "pong", broker: acc?.broker ?? null } });
    },

    async analyzer(ctx) {
      return ok(ctx, { data: { analyze_mode: analyzeOn(ctx), mode: analyzeOn(ctx) ? "analyze" : "live", total_logs: 0 } });
    },

    async analyzerToggle(ctx, body) {
      if (typeof body.mode !== "boolean") throw bad("mode must be true (analyzer, paper) or false (live).", "mode");
      if (!body.mode) ctx.requireScope("live");
      analyzer.set(ctx.key?.id ?? "local", body.mode);
      return ok(ctx, {
        data: {
          analyze_mode: body.mode,
          mode: body.mode ? "analyze" : "live",
          total_logs: 0,
          message: body.mode ? "Analyzer mode on: orders are paper orders." : "Analyzer mode off: orders ask for live mode; the Bridge's live-trading settings still decide.",
        },
      });
    },

    async funds(ctx, body) {
      const { funds } = await deps.orders.funds(ctx, account(ctx, body), { mode: mode(ctx) });
      return ok(ctx, {
        data: {
          availablecash: money(funds.availableCash),
          collateral: money(funds.collateral ?? 0),
          m2mrealized: money(funds.realisedPnl ?? 0),
          m2munrealized: money(funds.unrealisedPnl ?? 0),
          utiliseddebits: money(funds.usedMargin),
        },
      });
    },

    async orderbook(ctx, body) {
      const acc = account(ctx, body);
      const page = await deps.orders.list(ctx, { accountId: acc, mode: mode(ctx), limit: 500 });
      const orders = page.items.map(orderOut);
      const count = (f) => orders.filter(f).length;
      return ok(ctx, {
        data: {
          orders,
          statistics: {
            total_buy_orders: count((o) => o.action === "BUY"),
            total_sell_orders: count((o) => o.action === "SELL"),
            total_completed_orders: count((o) => o.order_status === "complete"),
            total_open_orders: count((o) => o.order_status === "open" || o.order_status === "trigger pending"),
            total_rejected_orders: count((o) => o.order_status === "rejected"),
          },
        },
      });
    },

    async tradebook(ctx, body) {
      const page = await deps.orders.trades(ctx, { accountId: account(ctx, body), mode: mode(ctx), limit: 500 });
      return ok(ctx, {
        data: page.items.map((t) => {
          const { symbol, exchange } = fromCanonical(t.symbol);
          return { orderid: t.orderId, symbol, exchange, action: t.side, quantity: n2(t.qty), average_price: n2(t.price), product: PRODUCT_OUT[t.product] ?? t.product ?? "", timestamp: t.tradedAt ?? "", trade_value: n2(t.qty) * n2(t.price) };
        }),
      });
    },

    async positionbook(ctx, body) {
      const { items } = await deps.orders.positions(ctx, account(ctx, body), { mode: mode(ctx) });
      return ok(ctx, {
        data: items.map((p) => {
          const { symbol, exchange } = fromCanonical(p.symbol);
          return { symbol, exchange, product: PRODUCT_OUT[p.product] ?? p.product, quantity: str(p.netQty), average_price: money(p.avgPrice), ltp: money(p.ltp ?? 0), pnl: money(p.pnl) };
        }),
      });
    },

    async holdings(ctx, body) {
      const { items } = await deps.orders.holdings(ctx, account(ctx, body));
      let value = 0;
      let inv = 0;
      const holdings = items.map((h) => {
        const { symbol, exchange } = fromCanonical(h.symbol);
        const cost = n2(h.qty) * n2(h.avgPrice);
        const cur = n2(h.qty) * n2(h.ltp ?? h.avgPrice);
        value += cur;
        inv += cost;
        return { symbol, exchange, product: "CNC", quantity: n2(h.qty), pnl: n2(h.pnl ?? cur - cost), pnlpercent: cost ? Math.round(((cur - cost) / cost) * 10_000) / 100 : 0 };
      });
      return ok(ctx, {
        data: {
          holdings,
          statistics: { totalholdingvalue: Math.round(value * 100) / 100, totalinvvalue: Math.round(inv * 100) / 100, totalprofitandloss: Math.round((value - inv) * 100) / 100, totalpnlpercentage: inv ? Math.round(((value - inv) / inv) * 10_000) / 100 : 0 },
        },
      });
    },

    async placeorder(ctx, body) {
      ctx.requireScope("paper");
      const o = await place(ctx, orderRequest(ctx, body));
      return ok(ctx, { orderid: o.orderId });
    },

    async placesmartorder(ctx, body) {
      ctx.requireScope("paper");
      const target = num(body.position_size, "position_size", { int: true });
      const base = orderRequest(ctx, body, { action: body.action ?? "BUY", quantity: 1 });
      const current = await netPosition(ctx, base.account, base.symbol, base.product);
      const delta = target - current;
      if (delta === 0) return ok(ctx, { message: "No action needed: the position is already at the target size.", orderid: null });
      const o = await place(ctx, { ...base, side: delta > 0 ? "BUY" : "SELL", quantity: Math.abs(delta) });
      return ok(ctx, { orderid: o.orderId });
    },

    async basketorder(ctx, body) {
      ctx.requireScope("paper");
      if (!Array.isArray(body.orders) || !body.orders.length || body.orders.length > 50) throw bad("orders must be a list of 1 to 50 orders.", "orders");
      const results = [];
      for (const raw of body.orders) {
        const merged = { ...raw, strategy: raw.strategy ?? body.strategy, account: raw.account ?? body.account };
        try {
          const o = await place(ctx, orderRequest(ctx, merged));
          results.push({ symbol: raw.symbol, exchange: raw.exchange, product: raw.product, status: "success", orderid: o.orderId });
        } catch (err) {
          results.push({ symbol: raw?.symbol, exchange: raw?.exchange, product: raw?.product, status: "error", message: err instanceof BridgeError ? err.detail : "Internal error." });
        }
      }
      return ok(ctx, { results });
    },

    async splitorder(ctx, body) {
      ctx.requireScope("paper");
      const total = num(body.quantity, "quantity", { min: 1, int: true });
      const size = num(body.splitsize, "splitsize", { min: 1, int: true });
      if (Math.ceil(total / size) > 100) throw bad("That would be more than 100 orders; use a larger splitsize.", "splitsize");
      const results = [];
      let left = total;
      for (let i = 1; left > 0; i += 1) {
        const q = Math.min(size, left);
        left -= q;
        try {
          const o = await place(ctx, orderRequest(ctx, body, { quantity: q }));
          results.push({ order_num: i, orderid: o.orderId, quantity: q, status: "success" });
        } catch (err) {
          results.push({ order_num: i, quantity: q, status: "error", message: err instanceof BridgeError ? err.detail : "Internal error." });
        }
      }
      return ok(ctx, { split_size: size, total_quantity: total, results });
    },

    async modifyorder(ctx, body) {
      ctx.requireScope("paper");
      if (!body.orderid) throw bad("orderid is required.", "orderid");
      const changes = {};
      if (body.quantity !== undefined) changes.quantity = num(body.quantity, "quantity", { min: 1, int: true });
      if (body.price !== undefined && Number(body.price) > 0) changes.price = num(body.price, "price", { min: 0 });
      if (body.trigger_price !== undefined && Number(body.trigger_price) > 0) changes.triggerPrice = num(body.trigger_price, "trigger_price", { min: 0 });
      if (body.pricetype) {
        const t = String(body.pricetype).toUpperCase();
        if (!PRICE_TYPES.includes(t)) throw bad(`pricetype must be one of ${PRICE_TYPES.join(", ")}.`, "pricetype");
        changes.orderType = t;
      }
      const { order } = await deps.orders.modify(ctx, String(body.orderid), changes, { idempotencyKey: `oa-${randomUUID()}` });
      return ok(ctx, { orderid: order.orderId });
    },

    async cancelorder(ctx, body) {
      ctx.requireScope("paper");
      if (!body.orderid) throw bad("orderid is required.", "orderid");
      const { order } = await deps.orders.cancel(ctx, String(body.orderid), { idempotencyKey: `oa-${randomUUID()}` });
      return ok(ctx, { orderid: order.orderId });
    },

    async cancelallorder(ctx, body) {
      ctx.requireScope("paper");
      const r = await deps.orders.cancelAll(ctx, { accountId: account(ctx, body), mode: mode(ctx) });
      return ok(ctx, { message: `Cancelled ${r.cancelled.length} order(s).`, canceled_orders: r.cancelled, failed_cancellations: r.failed.map((f) => f.orderId) });
    },

    async closeposition(ctx, body) {
      ctx.requireScope("paper");
      const acc = account(ctx, body);
      const { items } = await deps.orders.positions(ctx, acc, { mode: mode(ctx) });
      const open = items.filter((p) => n2(p.netQty) !== 0);
      const failed = [];
      for (const p of open) {
        try {
          await place(ctx, { account: acc, symbol: p.symbol, side: n2(p.netQty) > 0 ? "SELL" : "BUY", quantity: Math.abs(n2(p.netQty)), product: p.product, orderType: "MARKET", mode: mode(ctx), tag: "closeposition" });
        } catch (err) {
          failed.push({ symbol: fromCanonical(p.symbol).symbol, message: err instanceof BridgeError ? err.detail : "Internal error." });
        }
      }
      if (failed.length) return { status: "error", message: `Could not close ${failed.length} of ${open.length} position(s).`, failed };
      return ok(ctx, { message: open.length ? "All Open Positions Squared Off" : "No open positions." });
    },

    async orderstatus(ctx, body) {
      if (!body.orderid) throw bad("orderid is required.", "orderid");
      const o = await deps.orders.get(ctx, String(body.orderid));
      return ok(ctx, { data: orderOut(o) });
    },

    async openposition(ctx, body) {
      const sym = toCanonical(body.symbol, body.exchange);
      const product = PRODUCT_IN[String(body.product ?? "").toUpperCase()];
      if (!product) throw bad("product must be CNC, MIS or NRML.", "product");
      const q = await netPosition(ctx, account(ctx, body), sym, product);
      return ok(ctx, { quantity: String(q) });
    },

    async optionsorder(ctx, body) {
      ctx.requireScope("paper");
      const opt = await optionFor(ctx, body, { forOrder: true });
      const product = String(body.product ?? "MIS").toUpperCase();
      if (product !== "MIS" && product !== "NRML") throw bad("product must be MIS or NRML for options.", "product");
      const req = orderRequest(ctx, { ...body, product }, { symbol: opt.symbol, exchange: opt.exchange });
      const o = await place(ctx, req);
      return ok(ctx, { orderid: o.orderId, symbol: opt.symbol, exchange: opt.exchange, underlying: String(body.underlying).toUpperCase(), underlying_ltp: opt.underlying_ltp, offset: String(body.offset ?? "ATM").toUpperCase(), option_type: String(body.option_type).toUpperCase() });
    },

    // ── market data ──

    async quotes(ctx, body) {
      const sym = toCanonical(body.symbol, body.exchange);
      const r = await deps.marketData.quotes([sym], readOpts(ctx));
      if (!r.items.length) throw new BridgeError(r.errors[0]?.code ?? "UPSTREAM_ERROR", r.errors[0]?.message ?? `No quote for ${body.symbol}.`);
      const q = r.items[0];
      return ok(ctx, { data: { open: q.open ?? 0, high: q.high ?? 0, low: q.low ?? 0, ltp: q.ltp, ask: q.ask ?? 0, bid: q.bid ?? 0, prev_close: q.close ?? 0, volume: q.volume ?? 0, oi: q.oi ?? 0 } });
    },

    async multiquotes(ctx, body) {
      if (!Array.isArray(body.symbols) || !body.symbols.length || body.symbols.length > 200) throw bad("symbols must be a list of 1 to 200 { symbol, exchange }.", "symbols");
      const pairs = body.symbols.map((s) => {
        try {
          return { s, canonical: toCanonical(s?.symbol, s?.exchange) };
        } catch (err) {
          return { s, error: err.detail };
        }
      });
      const wanted = pairs.filter((p) => p.canonical).map((p) => p.canonical);
      const r = wanted.length ? await deps.marketData.quotes(wanted, readOpts(ctx)) : { items: [], errors: [] };
      const byId = new Map(r.items.map((q) => [q.symbol, q]));
      const errById = new Map(r.errors.map((e) => [e.symbol, e.message]));
      const failed = [];
      const good = [];
      for (const p of pairs) {
        const q = p.canonical ? byId.get(p.canonical) : null;
        if (!q) failed.push({ symbol: p.s?.symbol, exchange: p.s?.exchange, error: p.error ?? errById.get(p.canonical) ?? "No quote." });
        else good.push({ symbol: p.s.symbol, exchange: p.s.exchange, data: { open: q.open ?? 0, high: q.high ?? 0, low: q.low ?? 0, ltp: q.ltp, ask: q.ask ?? 0, bid: q.bid ?? 0, prev_close: q.close ?? 0, volume: q.volume ?? 0, oi: q.oi ?? 0 } });
      }
      return ok(ctx, { results: [...failed, ...good] });
    },

    async depth(ctx, body) {
      const sym = toCanonical(body.symbol, body.exchange);
      const [d, q] = await Promise.all([deps.marketData.depth(sym, readOpts(ctx)), deps.marketData.quotes([sym], readOpts(ctx)).catch(() => ({ items: [] }))]);
      const qi = q.items[0] ?? {};
      const lvl = (l) => ({ price: l.price, quantity: l.qty });
      return ok(ctx, {
        data: {
          asks: d.asks.map(lvl),
          bids: d.bids.map(lvl),
          open: qi.open ?? 0,
          high: qi.high ?? 0,
          low: qi.low ?? 0,
          ltp: qi.ltp ?? 0,
          ltq: 0,
          prev_close: qi.close ?? 0,
          volume: qi.volume ?? 0,
          oi: qi.oi ?? 0,
          totalbuyqty: d.bids.reduce((s, l) => s + n2(l.qty), 0),
          totalsellqty: d.asks.reduce((s, l) => s + n2(l.qty), 0),
        },
      });
    },

    async history(ctx, body) {
      const sym = toCanonical(body.symbol, body.exchange);
      const interval = INTERVAL_IN[String(body.interval ?? "")];
      if (!interval) throw bad(`interval must be one of ${Object.keys(INTERVAL_IN).join(", ")}.`, "interval");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date ?? ""))) throw bad("start_date must be YYYY-MM-DD.", "start_date");
      const params = { symbol: sym, interval, from: body.start_date };
      if (body.end_date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date))) throw bad("end_date must be YYYY-MM-DD.", "end_date");
        params.to = body.end_date;
      }
      const h = await deps.marketData.history(params, readOpts(ctx));
      return ok(ctx, { data: h.candles.map((c) => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, oi: c.oi ?? 0 })) });
    },

    async intervals(ctx) {
      return ok(ctx, { data: INTERVALS_OUT });
    },

    async symbol(ctx, body) {
      const sym = toCanonical(body.symbol, body.exchange);
      const r = await deps.symbols.resolve(sym);
      return ok(ctx, { data: symbolOut(r) });
    },

    async search(ctx, body) {
      if (typeof body.query !== "string" || !body.query.trim()) throw bad("query is required.", "query");
      const q = { q: body.query.trim().slice(0, 64), limit: 500 };
      if (body.exchange) {
        const ex = String(body.exchange).toUpperCase().replace(/_INDEX$/, "");
        q.exchange = ex;
      }
      const page = await deps.symbols.search(q);
      return ok(ctx, { data: page.items.map(symbolOut) });
    },

    async expiry(ctx, body) {
      const underlying = String(body.symbol ?? "").toUpperCase();
      if (!underlying) throw bad("symbol is required, for example NIFTY.", "symbol");
      const opts = readOpts(ctx);
      if (body.exchange) opts.exchange = String(body.exchange).toUpperCase();
      const r = await deps.marketData.expiries(underlying, opts);
      return ok(ctx, { data: r.expiries.map(isoToDashed) });
    },

    async optionchain(ctx, body) {
      const underlying = String(body.underlying ?? "").toUpperCase();
      if (!underlying) throw bad("underlying is required, for example NIFTY.", "underlying");
      if (!body.expiry_date) throw bad("expiry_date is required, for example 28OCT25.", "expiry_date");
      const expiry = expiryToIso(body.expiry_date);
      const p = { underlying, expiry, greeks: body.with_greeks === true };
      if (body.strike_count !== undefined) p.strikes = num(body.strike_count, "strike_count", { min: 1, int: true });
      const c = await deps.marketData.optionChain(p, readOpts(ctx));
      const leg = (l, strike) => {
        if (!l) return null;
        const { symbol } = fromCanonical(l.symbol);
        const label = c.atmStrike === strike ? "ATM" : null;
        const out = { symbol, label, ltp: l.ltp ?? 0, bid: l.bid ?? 0, ask: l.ask ?? 0, volume: l.volume ?? 0, oi: l.oi ?? 0, lotsize: c.lotSize ?? null };
        if (p.greeks) Object.assign(out, { implied_volatility: l.iv, greeks: { delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega } });
        return out;
      };
      return ok(ctx, {
        underlying,
        underlying_ltp: c.underlyingLtp,
        expiry_date: isoToCompact(expiry),
        atm_strike: c.atmStrike,
        chain: c.rows.map((r) => ({ strike: r.strike, ce: leg(r.ce, r.strike), pe: leg(r.pe, r.strike) })),
      });
    },

    async optionsymbol(ctx, body) {
      const o = await optionFor(ctx, body);
      return ok(ctx, { symbol: o.symbol, exchange: o.exchange, lotsize: o.lotsize, tick_size: o.tick_size, freeze_qty: o.freeze_qty, underlying_ltp: o.underlying_ltp });
    },

    async margin() {
      throw new BridgeError("CAPABILITY_UNSUPPORTED", "Margin calculation is not available through the Bridge yet.");
    },
  };
}

function symbolOut(r) {
  const { symbol, exchange } = fromCanonical(r.canonical);
  const p = parseSymbol(r.canonical);
  const ref = Object.values(r.refs ?? {})[0];
  return {
    symbol,
    name: r.name ?? r.underlying,
    exchange,
    brsymbol: ref?.tradingSymbol ?? symbol,
    brexchange: ref?.exchange ?? exchange,
    instrumenttype: instrumentType(p),
    expiry: p.expiry ? isoToDashed(p.expiry) : "",
    strike: p.strike ?? -1,
    lotsize: r.lotSize ?? 1,
    tick_size: r.tickSize ?? 0.05,
    freeze_qty: r.freezeQty ?? null,
    token: ref?.token ?? null,
  };
}
