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
  const priceNote = hook.orderType === "LIMIT" ? "This hook places LIMIT orders, so the alert must carry a price." : "This hook places MARKET orders with the configured market protection.";
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
      if (hook.orderType === "LIMIT") strategy.price = "{{strategy.order.price}}";
      if (!hook.product) strategy.product = "INTRADAY";
      strategy.id = "{{strategy.order.id}}";
      strategy.time = "{{timenow}}";
      const indicator = { symbol: "{{exchange}}:{{ticker}}", side: hook.side ?? "BUY", quantity: 1 };
      if (hook.orderType === "LIMIT") indicator.price = "{{close}}";
      if (!hook.product) indicator.product = "INTRADAY";
      const setup = "In the alert: tick Webhook URL under Notifications, paste the hook URL, and paste this into Message.";
      return [
        {
          name: "TradingView strategy alert",
          contentType: "application/json",
          message: json(strategy),
          notes: [setup, "For a strategy's order fills. The order id and time identify each alert, so a resend never places a second order that day.", priceNote, lotsNote, productNote],
        },
        {
          name: "TradingView indicator or price alert",
          contentType: "application/json",
          message: json(indicator),
          notes: [setup, hook.side ? `Every alert becomes one ${hook.side} order.` : "An indicator alert has no order of its own: write the side (BUY or SELL) and the quantity yourself, one alert per side.", priceNote, lotsNote],
        },
      ];
    }
    case "gocharting":
      return [
        {
          name: "GoCharting alert",
          contentType: "text/plain",
          message: `${hook.side ?? "BUY"} NSE:RELIANCE 1${hook.orderType === "LIMIT" ? " @ 1402.5" : " MKT"}${hook.product ? "" : " INTRADAY"}`,
          notes: ["Write one order per alert: side, symbol, quantity, then @ price for LIMIT hooks.", "Words the Bridge does not understand refuse the alert instead of guessing.", lotsNote],
        },
      ];
    case "generic":
    default: {
      const body = { symbol: "NSE:RELIANCE", side: hook.side ?? "BUY", quantity: 1, id: "my-signal-0001" };
      if (hook.orderType === "LIMIT") body.price = 1402.5;
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
