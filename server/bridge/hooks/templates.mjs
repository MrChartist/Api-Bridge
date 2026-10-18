/**
 * Copy-paste alert templates — stream S11. The hooks UI (and `GET /v1/hooks` callers) show these next to a hook so
 * users do not hand-write alert messages. Each template matches what the receiver parses (receivers/*.mjs).
 *
 * TradingView placeholders used (https://www.tradingview.com/support/solutions/43000531021-how-to-use-a-variable-value-in-alert/,
 * needs verification per release): {{exchange}}, {{ticker}}, {{close}}, {{timenow}}, and in strategy alerts
 * {{strategy.order.action}}, {{strategy.order.contracts}}, {{strategy.order.id}}.
 * Note: {{ticker}} for Indian options and futures is TradingView's own naming (for example NIFTY261027C25000); the
 * Bridge converts it, but that conversion needs verification for every contract type, so prefer an allowedSymbols
 * list on hooks that trade derivatives.
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
    case "tradingview": {
      const strategy = { symbol: "{{exchange}}:{{ticker}}", side: "{{strategy.order.action}}", quantity: "{{strategy.order.contracts}}", id: "{{strategy.order.id}}", time: "{{timenow}}" };
      if (hook.orderType === "LIMIT") strategy.price = "{{close}}";
      const indicator = { symbol: "{{exchange}}:{{ticker}}", side: hook.side ?? "BUY", lots: 1, time: "{{timenow}}" };
      if (hook.orderType === "LIMIT") indicator.price = "{{close}}";
      return [
        {
          name: "TradingView strategy alert",
          contentType: "application/json",
          message: json(strategy),
          notes: ["Paste into the alert's Message box and the hook URL into Webhook URL.", "id + time make a TradingView double-fire place one order, not two.", priceNote, productNote, lotsNote],
        },
        {
          name: "TradingView indicator / drawing alert",
          contentType: "application/json",
          message: json(indicator),
          notes: ["Indicator alerts have no strategy placeholders; the side is written in the message.", "Without an id, repeats of the same message within the dedupe window count as one alert.", priceNote, productNote, lotsNote],
        },
      ];
    }
    case "chartink":
      return [
        {
          name: "ChartInk scan alert",
          contentType: "application/json",
          message: "(ChartInk sends its own fixed message; only paste the hook URL into the alert's Webhook URL.)",
          notes: [hook.side ? `Every stock in the scan becomes one ${hook.side} order.` : "Set a side (BUY or SELL) on the hook: ChartInk alerts do not carry one.", "Trigger prices become the LIMIT price.", lotsNote, productNote],
        },
      ];
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
