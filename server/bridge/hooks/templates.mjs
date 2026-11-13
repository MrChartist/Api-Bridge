/**
 * Copy-paste alert templates — stream S11. The hooks UI (and `GET /v1/hooks` callers) show these next to a hook so
 * users do not hand-write alert messages. Each template matches what the receiver parses (receivers/*.mjs).
 */

/**
 * @typedef {{ name: string, contentType: "application/json"|"text/plain", message: string, notes: string[] }} AlertTemplate
 */

const json = (o) => JSON.stringify(o, null, 2);

/**
 * Templates for a hook.
 * @param {Pick<import("./hookStore.mjs").HookRecord, "source"|"side"|"orderType"|"product"|"maxLotsPerSignal">} hook
 * @returns {AlertTemplate[]}
 */
export function alertTemplates(hook) {
  const limit = hook.orderType === "LIMIT" || hook.orderType === "SL";
  const stop = hook.orderType === "SL" || hook.orderType === "SL-M";
  const priceNote =
    hook.orderType === "LIMIT"
      ? "This hook places LIMIT orders, so the alert must carry a price."
      : hook.orderType === "SL"
        ? "This hook places SL (stop-loss limit) orders: the alert must carry a triggerPrice (where the order wakes up) and a price (its limit after that). For a buy the price must be the trigger or higher; for a sell, the trigger or lower."
        : hook.orderType === "SL-M"
          ? "This hook places SL-M (stop-loss market) orders: the alert must carry a triggerPrice, the price at which the order wakes up and fills at the market."
          : "This hook places MARKET orders with the configured market protection.";
  const stopNote = "Replace the triggerPrice with your own stop level, or with a plot from your script that holds it.";
  const productNote = hook.product ? `Product is fixed to ${hook.product} by the hook.` : "Add \"product\": \"INTRADAY\" (or CNC / MARGIN), or set a product on the hook.";
  const lotsNote = `At most ${hook.maxLotsPerSignal} lot(s) per alert (for cash, 1 lot = 1 share); bigger alerts are refused, never trimmed.`;
  switch (hook.source) {
    case "chartink":
      return [
        {
          name: "ChartInk scan alert",
          contentType: "application/json",
          message: "(ChartInk sends its own fixed message; only paste the hook URL into the alert's Webhook URL.)",
          notes: [hook.side ? `Every stock in the scan becomes one ${hook.side} order.` : "Set a side (BUY or SELL) on the hook: ChartInk alerts do not carry one.", "Trigger prices become the LIMIT price.", lotsNote, productNote],
        },
      ];
    case "tradingview": {
      // TradingView fills the {{placeholders}} when the alert fires. Numbers travel as text; the receiver reads both.
      const strategy = { symbol: "{{exchange}}:{{ticker}}", side: hook.side ?? "{{strategy.order.action}}", quantity: "{{strategy.order.contracts}}" };
      if (limit) strategy.price = "{{strategy.order.price}}";
      if (stop) strategy.triggerPrice = "{{strategy.order.price}}";
      if (!hook.product) strategy.product = "INTRADAY";
      strategy.id = "{{strategy.order.id}}";
      strategy.time = "{{timenow}}";
      const indicator = { symbol: "{{exchange}}:{{ticker}}", side: hook.side ?? "BUY", quantity: 1 };
      if (limit) indicator.price = "{{close}}";
      if (stop) indicator.triggerPrice = "{{close}}";
      if (!hook.product) indicator.product = "INTRADAY";
      const setup = "In the alert: tick Webhook URL under Notifications, paste the hook URL, and paste this into Message.";
      return [
        {
          name: "TradingView strategy alert",
          contentType: "application/json",
          message: json(strategy),
          notes: [setup, "For a strategy's order fills. The order id and time identify each alert, so a resend never places a second order that day.", priceNote, ...(stop ? [stopNote] : []), lotsNote, productNote],
        },
        {
          name: "TradingView indicator or price alert",
          contentType: "application/json",
          message: json(indicator),
          notes: [setup, hook.side ? `Every alert becomes one ${hook.side} order.` : "An indicator alert has no order of its own: write the side (BUY or SELL) and the quantity yourself, one alert per side.", priceNote, ...(stop ? [stopNote] : []), lotsNote],
        },
      ];
    }
    case "gocharting":
      return [
        {
          name: "GoCharting alert",
          contentType: "text/plain",
          message: `${hook.side ?? "BUY"} NSE:RELIANCE 1${limit ? " @ 1402.5" : stop ? "" : " MKT"}${stop ? ` ${hook.orderType} trigger=1400` : ""}${hook.product ? "" : " INTRADAY"}`,
          notes: ["Write one order per alert: side, symbol, quantity, then @ price for LIMIT and SL hooks, and trigger=<price> for SL and SL-M hooks.", "Words the Bridge does not understand refuse the alert instead of guessing.", lotsNote],
        },
      ];
    case "generic":
    default: {
      const body = { symbol: "NSE:RELIANCE", side: hook.side ?? "BUY", quantity: 1, id: "my-signal-0001" };
      if (limit) body.price = 1402.5;
      if (stop) body.triggerPrice = 1400;
      if (!hook.product) body.product = "INTRADAY";
      return [
        {
          name: "Signed JSON (scripts)",
          contentType: "application/json",
          message: json(body),
          notes: [
            'Sign every request: X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signingSecret, "<t>." + raw body)>.',
            "Requests older than 5 minutes, or sent twice, are refused.",
            "Reusing an id the same day never creates a second order.",
            lotsNote,
          ],
        },
      ];
    }
  }
}
