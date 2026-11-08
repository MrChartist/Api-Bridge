// What to do about a refused or rejected order, in plain words (pure: no DOM, no fetch). The Bridge's own message says
// what happened; this adds the next step a trader can take. Matched on the error code and, where one code covers
// several rules (INVALID_ORDER), on the Bridge's own wording. Null when there is nothing useful to add.

// A fix may depend on the account's mode: a paper user is never pointed at a broker. While the daily gate also stops
// exits, no fix says "close from Positions".
const KILL = (mode) => `Find out why it is on, then release it on the Safety page.${mode === "live" ? " Your broker's app can still close positions." : ""}`;
const RULES = [
  [/kill switch/i, "KILL_SWITCH_ACTIVE", KILL],
  [/loss of .* today|daily limit of ₹|dailyMaxLoss/i, "DAILY_LIMIT_REACHED", (mode) => (mode === "live" ? "To cut risk today, close in your broker's app. The daily loss limit is set on the Safety page." : "Paper orders resume tomorrow (IST). Raise or reset the paper limit on the Safety page.")],
  [/orders today|daily limit \(/i, "DAILY_LIMIT_REACHED", "The count resets at midnight IST; the limit (dailyMaxOrders) is on the Safety page."],
  [/lots is above the per-order limit|order value .* is above the per-order limit/i, "INVALID_ORDER", "Send fewer lots, or split it into several smaller orders to stay inside your per-order limits."],
  [/away from the last traded price/i, "INVALID_ORDER", "Move the limit nearer the last price, or use a market order (sent with protection at LTP ± 2 %)."],
  [/orders are turned off \(safety\.marketOrders/i, "INVALID_ORDER", "Use a limit order."],
  [/not open for orders now|is closed today|market is not open/i, "MARKET_CLOSED", "Send it again when the market opens."],
  [/order rate cap|order-rate cap/i, "ORDER_RATE_LIMITED", "Wait a second and send it again."],
  [/Live trading is off|not enabled for account|are not allowed for account|is a paper account/i, "PAPER_ONLY", "Send it as paper, or turn live trading on in bridge.config.json (safety.liveTrading, the account's live.enabled and live.allowedSources)."],
  [/needs a human confirmation|confirmToken/i, "CONFIRMATION_REQUIRED", "Check and confirm it in Orders › Pending confirmations."],
  [/Insufficient paper funds/i, null, "Use fewer lots, add a hedge (a bought wing lowers the margin), or reset paper funds on the Accounts page."],
  [/trigger price for a stop-loss (buy|sell) must be/i, null, "The price is already past the trigger: use a limit or market order, or move the trigger."],
  [/Intraday orders are not accepted after/i, null, "After the square-off use Carry (NRML)."],
  [/is for equity delivery/i, null, "Choose Intraday or Carry (NRML) for futures and options."],
  [/Not enough .* quantity to sell/i, null, "Sell only what you hold, or use Intraday to sell short."],
  [/in the F&O ban|ban period|MWPL/i, "FNO_BAN", "During a ban only orders that reduce your position are allowed: close or reduce instead."],
  [/Lot size for .* (is from|differs)/i, "LOT_SIZE_STALE", "Tick the lot-size check on the ticket, or send the quantity in units."],
];

/** Codes whose next step does not depend on the wording. */
const BY_CODE = {
  KILL_SWITCH_ACTIVE: KILL,
  ORDER_RATE_LIMITED: "Wait a second and send it again.",
  MARKET_CLOSED: RULES[6][2],
  CONFIRMATION_REQUIRED: RULES[9][2],
  CANNOT_TRADE: "Log in to the broker on the Accounts page, then send it again.",
  SCOPE_REQUIRED: "Sign in with a key that has the scope this needs (live orders need the live scope).",
  FNO_BAN: RULES[15][2],
  LOT_SIZE_STALE: RULES[16][2],
  OUTCOME_UNKNOWN: "Do not send it again: the Bridge is checking the broker's order book and will update the order.",
};

/**
 * The next step for a refusal or a rejected order.
 * @param {{ code?: string, message?: string, detail?: string, statusMessage?: string, mode?: "paper"|"live" } | string | null} e
 *   `mode` is the account's (from the order or the ticket); without it the Bridge's wording decides ("a live loss",
 *   "live orders"), else paper.
 * @returns {string | null}
 */
export function whatToDo(e) {
  if (!e) return null;
  const code = typeof e === "string" ? null : (e.code ?? null);
  const text = typeof e === "string" ? e : String(e.message ?? e.detail ?? e.statusMessage ?? "");
  const mode = (typeof e === "object" && e.mode) || (/\blive (loss|orders)\b/i.test(text) ? "live" : "paper");
  const say = (fix) => (typeof fix === "function" ? fix(mode) : fix);
  for (const [re, c, fix] of RULES) if ((c === null || c === code || code === null) && re.test(text)) return say(fix);
  return code && BY_CODE[code] ? say(BY_CODE[code]) : null;
}
