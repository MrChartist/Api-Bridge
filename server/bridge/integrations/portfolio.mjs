/**
 * Your own book as flat tables for spreadsheets (read-only):
 *
 *   GET /xl/positions[?account=][&open=1][&format=csv|tsv|json]
 *   GET /xl/holdings[?account=]
 *   GET /xl/funds[?account=]
 *   GET /xl/orders[?account=][&status=][&mode=paper|live][&limit=]
 *
 * Without `account` the table covers every account this key may use that can answer (paper accounts, and broker
 * accounts that are logged in). One account failing (not logged in, broker down) gives a row with that account's name
 * and a text in `error`; the other accounts' rows are still there. Columns and their order never change.
 *
 * These handlers read through four methods only: orders.positions, orders.holdings, orders.funds and orders.list,
 * and accounts.list. portfolio.test.mjs and noOrders.test.mjs check that nothing else is touched.
 */
import { startupReady } from "../core/startup.mjs";
import { asOfCell } from "./xl.mjs";
import { allowedAccountsFor } from "../market/routes.mjs";
import { ACCOUNT_RE, asBridgeError, boolParam, enumParam, intParam, invalid, opt } from "./params.mjs";
import { FRESHNESS_COLUMNS, cacheParam, errorText, formatParam, tableReply } from "./table.mjs";

export const POSITION_COLUMNS = Object.freeze(["account", "mode", "symbol", "product", "qty", "avg_price", "ltp", "pnl", "realised_pnl", "unrealised_pnl", ...FRESHNESS_COLUMNS, "error"]);
export const HOLDING_COLUMNS = Object.freeze(["account", "mode", "symbol", "isin", "qty", "avg_price", "ltp", "pnl", ...FRESHNESS_COLUMNS, "error"]);
export const FUND_COLUMNS = Object.freeze(["account", "mode", "available_cash", "used_margin", "total_balance", "collateral", "withdrawable", "realised_pnl", "unrealised_pnl", ...FRESHNESS_COLUMNS, "error"]);
export const ORDER_COLUMNS = Object.freeze([
  "account",
  "mode",
  "order_id",
  "client_order_id",
  "symbol",
  "side",
  "product",
  "order_type",
  "qty",
  "filled_qty",
  "avg_price",
  "price",
  "trigger_price",
  "status",
  "status_message",
  "placed_at",
  "updated_at",
  ...FRESHNESS_COLUMNS,
  "error",
]);
const ORDER_STATUSES = ["pending", "open", "trigger_pending", "partially_filled", "filled", "cancelled", "rejected", "expired", "outcome_unknown"];

/** Freshness of a portfolio read as table cells. Portfolio reads are the account's own records, so class is realtime. */
function readCells(f, nowMs) {
  const asOfMs = Date.parse(f?.asOf ?? "");
  return {
    as_of: asOfCell(f?.asOf),
    age_s: Number.isFinite(f?.ageMs) ? Math.round(f.ageMs / 100) / 10 : Number.isFinite(asOfMs) ? Math.max(0, Math.round((nowMs - asOfMs) / 100) / 10) : null,
    class: f?.class ?? "realtime",
    source: f?.source ?? null,
    stale: typeof f?.stale === "boolean" ? f.stale : false,
  };
}

/** IST text of an ISO time, or null. */
const istText = (iso) => (iso ? asOfCell(iso) : null);

/**
 * @param {object} deps
 * @param {ReturnType<typeof import("./config.mjs").parseIntegrationsConfig>} cfg
 * @param {{ demo: boolean }} env
 */
export function createPortfolioRoutes(deps, cfg, { demo = false } = {}) {
  const now = () => (typeof deps.clock?.now === "function" ? deps.clock.now() : Date.now());

  /** Accounts a read may cover: the one asked for, or every account the key may use that can answer this kind of read. */
  function accountsFor(ctx, capability) {
    const asked = opt(ctx.query, "account");
    if (asked !== undefined) {
      if (!ACCOUNT_RE.test(asked)) throw invalid("account", "account is not a valid account id.");
      ctx.requireAccountAccess(asked);
      return [asked];
    }
    const allowed = allowedAccountsFor(ctx);
    const all = deps.accounts.list();
    return all
      .filter((a) => a.enabled !== false && (!allowed || allowed.includes(a.id)))
      .filter((a) => a.broker === "paper" || a.session?.state === "connected")
      .filter((a) => !capability || (a.capabilities ?? []).includes(capability))
      .map((a) => a.id);
  }

  /** One read per account, in parallel; a failing account becomes an error row instead of failing the table. */
  async function perAccount(ctx, capability, read, toRows, columns) {
    const format = formatParam(ctx.query);
    const cache = cacheParam(ctx, cfg.xl.cacheSeconds);
    await startupReady(deps);
    const ids = accountsFor(ctx, capability);
    const parts = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await read(id);
          return toRows(id, r);
        } catch (err) {
          const e = asBridgeError(err);
          return [{ account: id, error: errorText(e.code, e.detail) }];
        }
      }),
    );
    const records = parts.flat();
    if (demo) for (const r of records) r.demo = "DEMO";
    return tableReply({ format, columns: demo ? [...columns, "demo"] : columns, records, cache });
  }

  const modeOf = (f) => (f?.source === "paper" ? "paper" : "live");

  return {
    positions: (ctx) => {
      const onlyOpen = boolParam(ctx.query, "open", false);
      const modeAsked = enumParam(ctx.query, "mode", ["paper", "live"], undefined);
      return perAccount(
        ctx,
        "positions",
        (id) => deps.orders.positions(ctx, id, { mode: modeAsked }),
        (id, r) => {
          const cells = readCells(r.freshness, now());
          return (r.items ?? [])
            .filter((p) => !onlyOpen || Number(p.netQty) !== 0)
            .map((p) => ({
              account: id,
              mode: modeOf(r.freshness),
              symbol: p.symbol,
              product: p.product,
              qty: p.netQty,
              avg_price: p.avgPrice,
              ltp: p.ltp,
              pnl: p.pnl,
              realised_pnl: p.realisedPnl,
              unrealised_pnl: p.unrealisedPnl,
              ...cells,
            }));
        },
        POSITION_COLUMNS,
      );
    },

    holdings: (ctx) =>
      perAccount(
        ctx,
        "holdings",
        (id) => deps.orders.holdings(ctx, id),
        (id, r) => {
          const cells = readCells(r.freshness, now());
          return (r.items ?? []).map((h) => ({ account: id, mode: modeOf(r.freshness), symbol: h.symbol, isin: h.isin, qty: h.qty, avg_price: h.avgPrice, ltp: h.ltp, pnl: h.pnl, ...cells }));
        },
        HOLDING_COLUMNS,
      ),

    funds: (ctx) => {
      const modeAsked = enumParam(ctx.query, "mode", ["paper", "live"], undefined);
      return perAccount(
        ctx,
        "funds",
        (id) => deps.orders.funds(ctx, id, { mode: modeAsked }),
        (id, r) => {
          const f = r.funds ?? {};
          return [
            {
              account: id,
              mode: modeOf(r.freshness),
              available_cash: f.availableCash,
              used_margin: f.usedMargin,
              total_balance: f.totalBalance,
              collateral: f.collateral,
              withdrawable: f.withdrawable,
              realised_pnl: f.realisedPnl,
              unrealised_pnl: f.unrealisedPnl,
              ...readCells(r.freshness, now()),
            },
          ];
        },
        FUND_COLUMNS,
      );
    },

    async orders(ctx) {
      const q = ctx.query;
      const format = formatParam(q);
      const cache = cacheParam(ctx, cfg.xl.cacheSeconds);
      const status = enumParam(q, "status", ORDER_STATUSES, undefined);
      const mode = enumParam(q, "mode", ["paper", "live"], undefined);
      const limit = intParam(q, "limit", 1, 500) ?? 200;
      const asked = opt(q, "account");
      if (asked !== undefined) {
        if (!ACCOUNT_RE.test(asked)) throw invalid("account", "account is not a valid account id.");
        ctx.requireAccountAccess(asked);
      }
      await startupReady(deps);
      const page = await deps.orders.list(ctx, { accountId: asked, status, mode, limit });
      const t = now();
      const records = (page.items ?? []).map((o) => ({
        account: o.accountId,
        mode: o.mode,
        order_id: o.orderId,
        client_order_id: o.clientOrderId,
        symbol: o.symbol,
        side: o.side,
        product: o.product,
        order_type: o.orderType,
        qty: o.quantity,
        filled_qty: o.filledQuantity,
        avg_price: o.avgPrice,
        price: o.price,
        trigger_price: o.triggerPrice,
        status: o.status,
        status_message: o.statusMessage,
        placed_at: istText(o.placedAt),
        updated_at: istText(o.updatedAt),
        ...readCells({ asOf: new Date(t).toISOString(), ageMs: 0, source: o.mode === "paper" ? "paper" : "broker", stale: false }, t),
        ...(demo ? { demo: "DEMO" } : {}),
      }));
      return tableReply({ format, columns: demo ? [...ORDER_COLUMNS, "demo"] : ORDER_COLUMNS, records, cache, headers: page.nextCursor ? { "X-Truncated": "true" } : {} });
    },
  };
}
