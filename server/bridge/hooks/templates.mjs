/**
 * Copy-paste alert templates. The hooks UI (and `GET /v1/hooks` callers) show these next to a hook so
 * users do not hand-write alert messages. Each template matches what the receiver parses (receivers/*.mjs).
 */

/**
 * @typedef {{ name: string, contentType: "application/json"|"text/plain", message: string, notes: string[] }} AlertTemplate
 */

const json = (o) => JSON.stringify(o, null, 2);

/**
 * TradingView templates. The placeholders in {{ }} are TradingView's own: it fills them in when the alert fires, then
 * sends the message (as JSON when the filled message is valid JSON, as plain text otherwise). Numbers stay unquoted,
 * text placeholders are quoted. See docs/guides/webhooks.md.
 * @param {any} hook @param {string | null} passphrase
 * @returns {AlertTemplate[]}
 */
function tradingViewTemplates(hook, passphrase) {
  const limit = hook.orderType === "LIMIT" || hook.orderType === "SL";
  const stop = hook.orderType === "SL" || hook.orderType === "SL-M";
  const side = hook.side ? hook.side.toLowerCase() : "buy";
  const live = hook.mode === "live";
  const pass = passphrase ?? "YOUR_PASSPHRASE";
  const q = (v) => JSON.stringify(v);
  const lines = (pairs) => `{\n${pairs.map(([k, v]) => `  "${k}": ${v}`).join(",\n")}\n}`;
  const build = ({ sideValue, lotsValue, priceValue, triggerValue, idValue, position }) =>
    lines([
      ["symbol", q("{{exchange}}:{{ticker}}")],
      ["side", sideValue],
      ["lots", lotsValue],
      ["orderType", q(hook.orderType.toLowerCase())],
      ...(limit ? [["price", priceValue]] : []),
      ...(stop ? [["triggerPrice", triggerValue]] : []),
      ...(hook.product ? [] : [["product", q("MIS")]]),
      ["mode", q(live ? "live" : "paper")],
      ...position,
      ["id", q(idValue)],
      ["time", q("{{timenow}}")],
      ["passphrase", q(pass)],
    ]);
  const plain = build({ sideValue: q(side), lotsValue: "1", priceValue: "{{close}}", triggerValue: "{{close}}", idValue: "my-alert", position: [] });
  const strategy = build({
    sideValue: q("{{strategy.order.action}}"),
    lotsValue: "{{strategy.order.contracts}}",
    priceValue: "{{strategy.order.price}}",
    triggerValue: "{{strategy.order.price}}",
    idValue: "{{strategy.order.id}}",
    position: [["marketPosition", q("{{strategy.market_position}}")], ["positionSize", "{{strategy.market_position_size}}"]],
  });
  const text = `${side.toUpperCase()} {{exchange}}:{{ticker}} 1${limit ? " @ {{close}}" : stop ? "" : " MKT"}${stop ? ` ${hook.orderType} trigger={{close}}` : ""}${hook.product ? "" : " MIS"} mode=${live ? "live" : "paper"} id=my-alert time={{timenow}} passphrase=${pass}`;
  const notes = [
    passphrase ? "The passphrase is shown only now. Copy the message with it before you close this page." : "Replace YOUR_PASSPHRASE with the passphrase shown when the hook was created (only its fingerprint is stored, so it cannot be shown again).",
    "Use {{timenow}} for time: it is the moment the alert fires. {{time}} is the start of the candle and can be hours old.",
    `Alerts older than ${hook.maxAgeSec ?? "the allowed number of"} seconds are refused.`,
    live ? 'This hook places LIVE orders: every alert must say "mode": "live".' : 'This hook places PAPER orders. "mode" may be left out.',
    `At most ${hook.maxLotsPerSignal} lot(s) per alert (for shares, 1 lot = 1 share); bigger alerts are refused, never trimmed.`,
    ...(stop ? ["This hook places stop-loss orders: every alert must carry a triggerPrice, the price at which the order wakes up. Replace the triggerPrice in the message with your own stop level, or with a plot from your script that holds it."] : []),
  ];
  return [
    { name: "Plain alert (indicator or Pine alert())", contentType: "application/json", message: plain, notes: [...notes, "Paste it into the alert's Message box. Change side to sell for a sell alert."] },
    { name: "Strategy alert (every order fill)", contentType: "application/json", message: strategy, notes: [...notes, "TradingView fills in the order's action, size and price. In futures and options strategies the size counts lots, which is why it is sent as lots."] },
    { name: "Plain text alert", contentType: "text/plain", message: text, notes: [...notes, "One order per alert, in this order: side, symbol, size, then the rest in any order."] },
  ];
}

/**
 * Templates for a hook.
 * @param {Pick<import("./hookStore.mjs").HookRecord, "source"|"side"|"orderType"|"product"|"maxLotsPerSignal"> & { mode?: string, maxAgeSec?: number | null }} hook
 * @param {{ passphrase?: string | null }} [opts]  passphrase: only when it was just created (TradingView)
 * @returns {AlertTemplate[]}
 */
export function alertTemplates(hook, { passphrase = null } = {}) {
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
    case "tradingview":
      return tradingViewTemplates(hook, passphrase);
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
            "Reusing an id the same day never creates a second order (an id sent together with a different time counts as a new alert).",
            lotsNote,
          ],
        },
      ];
    }
  }
}
