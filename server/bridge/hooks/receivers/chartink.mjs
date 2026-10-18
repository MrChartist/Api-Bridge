/**
 * ChartInk scan-alert receiver — stream S11.
 *
 * ChartInk posts a fixed JSON body (needs verification against https://chartink.com/articles/alerts/webhook-support-for-alerts/):
 *   { "stocks": "SEPOWER,ASTEC,EDUCOMP", "trigger_prices": "3.75,541.8,2.1", "triggered_at": "2:34 pm",
 *     "scan_name": "Short term breakouts", "scan_url": "short-term-breakouts", "alert_name": "Alert for Short term breakouts" }
 *
 * - `stocks` and `trigger_prices` are comma-joined lists of NSE cash symbols and their trigger prices (same order).
 * - The alert has no side and no quantity: the hook's `side` decides the side (required for ChartInk hooks) and the
 *   quantity is one lot (one share for cash) unless the hook's caps say otherwise.
 * - `triggered_at` has no date; the Bridge stamps it with the IST date on which it arrived, so the same scan firing
 *   on two days is two alerts while a re-delivery the same day is a duplicate.
 * - A scan can list many stocks; at most MAX_SIGNALS_PER_ALERT become signals, the rest are reported as dropped.
 */
import { MAX_SIGNALS_PER_ALERT, invalid, toNumber } from "./common.mjs";

const STOCK_RE = /^[A-Z0-9&_-]{1,30}$/;

/**
 * @param {unknown} body
 * @param {{ istDate: string }} meta  IST date (YYYY-MM-DD) the alert arrived.
 * @returns {import("./common.mjs").ParsedAlert}
 */
export function parseChartInk(body, { istDate }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("A ChartInk alert must be a JSON object.");
  const o = /** @type {Record<string, unknown>} */ (body);
  if (typeof o.stocks !== "string" || !o.stocks.trim()) throw invalid("stocks is missing.", "stocks");
  const stocks = o.stocks.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const prices = typeof o.trigger_prices === "string" ? o.trigger_prices.split(",").map((s) => s.trim()) : [];
  if (prices.length && prices.length !== stocks.length) throw invalid("stocks and trigger_prices have different lengths.", "trigger_prices");
  const triggeredAt = typeof o.triggered_at === "string" ? o.triggered_at.trim().slice(0, 40) : "";
  const scan = String(o.scan_url ?? o.scan_name ?? o.alert_name ?? "").slice(0, 120);
  const signals = [];
  for (const [i, stock] of stocks.entries()) {
    if (signals.length >= MAX_SIGNALS_PER_ALERT) break;
    if (!STOCK_RE.test(stock)) throw invalid(`stocks[${i}] (${stock.slice(0, 30)}) is not an NSE symbol.`, `stocks.${i}`);
    signals.push({
      symbol: `NSE:${stock}`,
      side: null,
      quantity: null,
      lots: null,
      price: prices.length ? toNumber(prices[i], `trigger_prices.${i}`) : null,
      orderType: null,
      product: null,
      ref: stock,
      time: triggeredAt || null,
    });
  }
  const basis = triggeredAt ? `ci|${scan}|${istDate}|${triggeredAt}|${stocks.join(",")}` : null;
  return { signals, basis, dropped: Math.max(0, stocks.length - signals.length) };
}
