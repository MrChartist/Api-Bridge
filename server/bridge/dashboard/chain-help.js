// The option chain's own help: what every column shows, how it is worked out and what an empty cell means (the cell
// index), the order to read a chain in, and a short self-check. Plain data and pure helpers (no DOM): the help sheet
// and the insight cards (chain-insight.js) both read it, and so do the column headers' explanations, so each column is
// described in one place only. Copy is factual and neutral (copyRules.mjs): it says what a figure is, never what to do.

/** Families, in the order the cell index lists them (and the reading order walks them). */
export const FAMILIES = Object.freeze([
  ["ladder", "The ladder"],
  ["price", "Price"],
  ["quote", "Quote and cost to trade"],
  ["positions", "Positions"],
  ["vol", "Implied volatility"],
  ["greeks", "Greeks"],
  ["value", "Value and distance"],
  ["odds", "Odds at expiry"],
  ["parity", "Parity across the strike"],
]);

/**
 * One entry per chain column (desk.js CHAIN_COLUMNS, plus Strike, Bid and Ask): `label` as the header prints it, `name`
 * in full, `shows` (what the figure is), `how` (how it is worked out), `empty` (what a dash means), `aliases` for search.
 * @type {ReadonlyArray<{ key: string, label: string, name: string, family: string, shows: string, how: string, empty: string, aliases?: string[] }>}
 */
export const CELL_INDEX = Object.freeze([
  {
    key: "strike",
    label: "Strike",
    name: "Strike",
    family: "ladder",
    shows: "The price at which the option can be exercised. Every other cell on the row belongs to this strike; calls sit on the left, puts on the right.",
    how: "Listed by the exchange at fixed steps. The row nearest the forward price is marked ATM, and the spot line sits between the two strikes either side of spot.",
    empty: "Never empty.",
    aliases: ["atm", "at the money", "row", "ladder"],
  },
  {
    key: "ltp",
    label: "LTP",
    name: "Last traded price",
    family: "price",
    shows: "The premium of the last trade in this contract, with its change from the previous close under it.",
    how: "Taken from the feed as it ticks. Change = LTP minus the previous close; change % = that change over the previous close.",
    empty: "No trade yet today. A faded figure means no trade for a while on a live feed, so it may lag the quote.",
    aliases: ["premium", "price", "last price", "change"],
  },
  {
    key: "bid",
    label: "Bid",
    name: "Bid",
    family: "quote",
    shows: "The highest price someone is offering for this contract right now: the price an order to go short, or to close a long, would meet at once.",
    how: "Top of the order book from the feed.",
    empty: "Nobody is bidding at the moment.",
    aliases: ["quote", "touch", "order book", "depth"],
  },
  {
    key: "ask",
    label: "Ask",
    name: "Ask",
    family: "quote",
    shows: "The lowest price anyone is asking for this contract right now: the price an order to go long, or to close a short, would meet at once.",
    how: "Top of the order book from the feed. Under it, the spread appears when it is wide (amber over 5%, red over 10% of the mid).",
    empty: "Nobody is offering at the moment.",
    aliases: ["offer", "quote", "touch", "order book", "depth"],
  },
  {
    key: "spread",
    label: "Spread %",
    name: "Bid-ask spread",
    family: "quote",
    shows: "How far apart the bid and the ask are, as a percent of the mid. A round trip at the touch costs roughly this share of the premium.",
    how: "(Ask − Bid) ÷ Mid × 100, where Mid = (Bid + Ask) ÷ 2.",
    empty: "One side of the quote is missing, so there is no spread to measure.",
    aliases: ["sprd", "cost", "slippage", "liquidity"],
  },
  {
    key: "liq",
    label: "Liquidity",
    name: "Liquidity score",
    family: "quote",
    shows: "A 1 to 5 score of how easy the contract is to trade: five dots is a tight spread and heavy volume for its side.",
    how: "55% from the spread (5 at 1% or less, down to 1 above 10%) and 45% from where its volume ranks among the same side's strikes.",
    empty: "No volume, no open interest and no quote: the contract is not trading.",
    aliases: ["liq", "dots", "spread", "volume rank"],
  },
  {
    key: "costPct",
    label: "Cost %",
    name: "Premium as % of spot",
    family: "quote",
    shows: "The premium as a share of the underlying's price, so strikes and underlyings can be compared on one scale.",
    how: "Mid ÷ Spot × 100.",
    empty: "No premium or no spot.",
    aliases: ["cost", "percent of spot"],
  },
  {
    key: "prem",
    label: "Premium traded",
    name: "Premium traded today",
    family: "quote",
    shows: "The rupee value that changed hands in this contract today.",
    how: "Volume × lot size × LTP. It uses the last price, so it is an estimate of the day's turnover.",
    empty: "No volume or no last price.",
    aliases: ["turnover", "value traded", "money"],
  },
  {
    key: "oi",
    label: "OI",
    name: "Open interest",
    family: "positions",
    shows: "How many contracts are open at this strike: positions still held, not trades. The bar is its share of the largest OI on the chain, both sides on one scale; the brightest bar is the OI wall.",
    how: "From the feed. With lots switched on it is divided by the lot size.",
    empty: "The feed sent no open interest for this contract.",
    aliases: ["open interest", "wall", "positions", "contracts"],
  },
  {
    key: "chg",
    label: "OI chg",
    name: "Change in open interest",
    family: "positions",
    shows: "Contracts added (green) or cut (red) since the baseline: the previous close on Day, a stored snapshot on 1h and 15m.",
    how: "OI now minus OI at the baseline. Change % = that change over the baseline OI. The bar is its share of the largest change on the chain.",
    empty: "No baseline: the feed sent no change, or no snapshot is stored yet for 1h or 15m.",
    aliases: ["oi change", "added", "cut", "fresh positions", "unwound"],
  },
  {
    key: "vol",
    label: "Volume",
    name: "Volume",
    family: "positions",
    shows: "Contracts traded today. Unlike open interest it resets each session. Amber marks volume well above its open interest compared with the rest of the chain.",
    how: "From the feed. The bar is its share of the largest volume on the chain, both sides on one scale.",
    empty: "No trade in this contract today.",
    aliases: ["traded", "activity", "unusual", "vol oi"],
  },
  {
    key: "bu",
    label: "Build-up",
    name: "Build-up",
    family: "positions",
    shows: "What the premium and the open interest did together, named in two letters. LB long build-up and SB short build-up are positions opening (filled tag); SC short covering and LU long unwinding are positions closing (outlined tag).",
    how: "Premium up with OI up: LB. Premium down with OI up: SB. Premium up with OI down: SC. Premium down with OI down: LU. Green when the premium rose, red when it fell, on calls and puts alike.",
    empty: "The premium or the open interest did not change, so there is no pattern to name. The name describes the window, not what happens next.",
    aliases: ["buildup", "lb", "sb", "sc", "lu", "long build-up", "short build-up", "short covering", "long unwinding"],
  },
  {
    key: "pcrK",
    label: "PCR",
    name: "Strike put-call ratio",
    family: "positions",
    shows: "Put open interest over call open interest at this strike: how lopsided the positions are. 1.2 and above is put-heavy, 0.8 and below call-heavy.",
    how: "Put OI ÷ Call OI at the same strike.",
    empty: "No call open interest at this strike to divide by.",
    aliases: ["put call ratio", "balance"],
  },
  {
    key: "iv",
    label: "IV",
    name: "Implied volatility",
    family: "vol",
    shows: "The yearly volatility the premium implies, in percent. It restates the price; it carries no colour because a higher IV is neither a gain nor a loss.",
    how: "From the broker's feed when it sends one; otherwise the Bridge solves Black-76 on the forward for the volatility that gives this premium.",
    empty: "No usable reading: no price, or a price at or below what the model allows (often a stale deep in-the-money print). A dash is not zero volatility.",
    aliases: ["volatility", "implied vol", "smile", "skew"],
  },
  {
    key: "ivx",
    label: "IV−ATM",
    name: "IV over ATM IV",
    family: "vol",
    shows: "This strike's IV minus the at-the-money IV, in vol points: how much more (or less) volatility this premium implies than the centre of the chain.",
    how: "Leg IV − ATM IV. ATM IV is read at the forward from the chain's smile.",
    empty: "No IV for this leg, or no ATM IV for the chain.",
    aliases: ["iv minus atm", "skew", "relative iv"],
  },
  {
    key: "ivskew",
    label: "IV P−C",
    name: "Put IV minus call IV",
    family: "vol",
    shows: "At one strike, how far the put's IV sits above (or below) the call's, in vol points.",
    how: "Put IV − Call IV at the same strike.",
    empty: "One of the two legs has no IV.",
    aliases: ["skew", "put call iv"],
  },
  {
    key: "delta",
    label: "Delta",
    name: "Delta",
    family: "greeks",
    shows: "How much the premium moves for a 1-point move in the underlying. Calls run from 0 to 1, puts from 0 to −1; 16Δ and 30Δ tags mark the strikes nearest those deltas.",
    how: "Black-76 on the forward at the leg's IV (or the broker's figure when it sends Greeks): N(d1) for a call, N(d1) − 1 for a put.",
    empty: "No IV, so no Greeks. A put's negative delta is not a view on direction: its premium simply moves against the underlying.",
    aliases: ["greeks", "hedge ratio", "16 delta", "30 delta"],
  },
  {
    key: "gamma",
    label: "Gamma",
    name: "Gamma",
    family: "greeks",
    shows: "How much delta itself moves for a 1-point move in the underlying. Highest near the money and close to expiry.",
    how: "Black-76: φ(d1) ÷ (F × σ × √T), the same for the call and the put at one IV.",
    empty: "No IV, so no Greeks. A small figure is still real: over 10 points it moves delta ten times as much.",
    aliases: ["greeks", "convexity"],
  },
  {
    key: "theta",
    label: "Theta",
    name: "Theta",
    family: "greeks",
    shows: "How much premium one day takes, all else held still. Negative for a long option: time works against the holder.",
    how: "Black-76 time decay per day on the model clock (or the broker's figure). A rate at this instant, not tomorrow's change.",
    empty: "No IV, so no Greeks.",
    aliases: ["greeks", "decay", "time decay"],
  },
  {
    key: "vega",
    label: "Vega",
    name: "Vega",
    family: "greeks",
    shows: "How much the premium moves for a 1-point change in implied volatility.",
    how: "Black-76: F × φ(d1) × √T ÷ 100, the same for the call and the put at one IV. The effect if IV moves, not a forecast that it will.",
    empty: "No IV, so no Greeks.",
    aliases: ["greeks", "volatility sensitivity"],
  },
  {
    key: "thetaLot",
    label: "θ/lot",
    name: "Theta per lot",
    family: "greeks",
    shows: "Theta in rupees for one lot: what a day's decay is worth on a position of one lot.",
    how: "Theta × lot size.",
    empty: "No theta for this leg.",
    aliases: ["theta per lot", "decay in rupees"],
  },
  {
    key: "hedge",
    label: "Hedge lots",
    name: "Hedge lots",
    family: "greeks",
    shows: "How many lots of this option would offset the delta of your positions on this expiry. With no position, how many lots match one long futures lot.",
    how: "|Position delta| ÷ (|leg delta| × lot size), rounded up. Only legs whose delta runs against the position count.",
    empty: "This leg's delta runs the same way as the position, or is under 0.02.",
    aliases: ["hedge", "delta neutral", "offset"],
  },
  {
    key: "ext",
    label: "Time value",
    name: "Time value",
    family: "value",
    shows: "The part of the premium above intrinsic value: what decays to zero by expiry.",
    how: "Mid − intrinsic, where intrinsic = max(0, F − K) for a call and max(0, K − F) for a put, read on the forward F. Red below zero: the premium sits under intrinsic (a parity break or a stale quote).",
    empty: "No premium or no forward.",
    aliases: ["extrinsic", "intrinsic", "tv"],
  },
  {
    key: "be",
    label: "Breakeven",
    name: "Breakeven at expiry",
    family: "value",
    shows: "Where the underlying must finish at expiry for a long position at today's premium to get its money back. Under it, the move from spot that takes.",
    how: "Call: strike + premium. Put: strike − premium. Premium is the mid.",
    empty: "No premium.",
    aliases: ["b/e", "be", "break even"],
  },
  {
    key: "dist",
    label: "Distance",
    name: "Distance from spot",
    family: "value",
    shows: "How far the strike sits from spot, positive when out of the money. Under it, the same distance in standard deviations to expiry.",
    how: "Call: (K − spot) ÷ spot; put: (spot − K) ÷ spot. σ: ln(K ÷ F) ÷ (ATM IV × √T), signed the same way.",
    empty: "No spot, or no ATM IV for the σ line.",
    aliases: ["dist", "moneyness", "sigma", "otm"],
  },
  {
    key: "premLot",
    label: "Prem/lot",
    name: "Premium per lot",
    family: "value",
    shows: "What one lot costs at the mid.",
    how: "Mid × lot size.",
    empty: "No premium.",
    aliases: ["premium per lot", "cost per lot"],
  },
  {
    key: "strad",
    label: "Straddle",
    name: "Straddle",
    family: "value",
    shows: "The call and the put at this strike together, and that sum as a percent of spot: the move the two premiums price in to expiry.",
    how: "Call mid + put mid.",
    empty: "One of the two legs has no price.",
    aliases: ["straddle", "expected move"],
  },
  {
    key: "pitm",
    label: "P(ITM)",
    name: "Chance of finishing in the money",
    family: "odds",
    shows: "The model's chance that this option finishes in the money at expiry.",
    how: "Black-76 on the forward at the leg's IV: N(d2) for a call, N(−d2) for a put. A log-normal model, not a forecast.",
    empty: "No IV for this leg.",
    aliases: ["probability", "itm"],
  },
  {
    key: "potm",
    label: "P(OTM)",
    name: "Chance of finishing out of the money",
    family: "odds",
    shows: "The model's chance that this option expires worthless.",
    how: "1 − P(ITM).",
    empty: "No IV for this leg.",
    aliases: ["probability", "otm", "expires worthless"],
  },
  {
    key: "pop",
    label: "POP buy",
    name: "Chance of profit, long",
    family: "odds",
    shows: "The model's chance that a long position at today's premium ends in profit at expiry: the underlying finishing beyond the breakeven.",
    how: "P(price beyond the breakeven), log-normal on the forward at the leg's IV (ATM IV when the leg has none).",
    empty: "No premium, or no IV at all.",
    aliases: ["pop", "probability of profit", "long"],
  },
  {
    key: "pops",
    label: "POP sell",
    name: "Chance of profit, short",
    family: "odds",
    shows: "The model's chance that a short position at today's premium keeps a profit at expiry.",
    how: "1 − the long position's chance.",
    empty: "No premium, or no IV at all.",
    aliases: ["pop", "probability of profit", "short", "writer"],
  },
  {
    key: "syn",
    label: "Synthetic",
    name: "Synthetic future",
    family: "parity",
    shows: "The futures price the call and put at this strike imply together. Under it, the two prices the synthetic can be traded at, at the touch.",
    how: "K + (Call − Put) × e^(rT) at mids. The touch line uses the bid of one leg and the ask of the other.",
    empty: "One of the two legs has no price.",
    aliases: ["parity", "conversion", "reversal", "forward"],
  },
  {
    key: "dev",
    label: "Dev",
    name: "Deviation from the future",
    family: "parity",
    shows: "The synthetic minus the same-expiry future (or the chain's forward when no future is listed), in points. The bar puts every strike on one scale.",
    how: "Synthetic mid − future LTP. Rupees per lot in the cell's tooltip.",
    empty: "No synthetic at this strike, or no reference price.",
    aliases: ["deviation", "parity", "basis"],
  },
  {
    key: "edge",
    label: "Edge",
    name: "Parity edge",
    family: "parity",
    shows: "The larger of the two parity trades at the touch, before costs: a conversion (short the synthetic, long the future at its ask) or a reversal (the other way round).",
    how: "Worked from bid and ask on both legs and on the future. The strike with the largest edge carries a tag.",
    empty: "A leg or the future has no two-sided quote.",
    aliases: ["arbitrage", "conversion", "reversal", "parity"],
  },
]);

const BY_KEY = new Map(CELL_INDEX.map((e) => [e.key, e]));
/** The index entry for a column key (null for a column the index does not know yet). */
export const cellHelp = (key) => BY_KEY.get(key) ?? null;
/** A family id's heading. */
export const familyName = (id) => FAMILIES.find((f) => f[0] === id)?.[1] ?? "";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}%()/]+/gu, " ").trim();

/**
 * Search the cell index. Ranks a label match first, then the full name, then an alias, then the body text; ties keep
 * the index order. An empty query returns every entry. Every word of the query must be found somewhere in the entry.
 * @param {string} query
 * @returns {Array<{ key: string, label: string, name: string, family: string, shows: string, how: string, empty: string }>}
 */
export function searchCells(query, index = CELL_INDEX) {
  const q = norm(query);
  if (!q) return [...index];
  const words = q.split(" ");
  const scored = [];
  index.forEach((e, i) => {
    const label = norm(e.label);
    const name = norm(e.name);
    const aliases = (e.aliases ?? []).map(norm);
    const body = norm(`${e.shows} ${e.how} ${e.empty}`);
    const all = `${label} ${name} ${aliases.join(" ")} ${body}`;
    if (!words.every((w) => all.includes(w))) return;
    let score = 1;
    if (label === q || name === q) score = 6;
    else if (label.startsWith(q) || name.startsWith(q)) score = 5;
    else if (label.includes(q) || name.includes(q)) score = 4;
    else if (aliases.some((a) => a === q)) score = 3;
    else if (aliases.some((a) => a.includes(q))) score = 2;
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
}

/**
 * The order to read a chain in: five questions, each answered by a few columns. None of them points to a direction:
 * they say where prices, positions and costs sit.
 */
export const READING_ORDER = Object.freeze([
  {
    step: "Price",
    question: "Does this strike trade, and at what?",
    text: "Start with the last price and the quote. A tight bid and ask with a recent trade means every figure worked out from the premium (IV, time value, breakeven) rests on a real price. A wide spread or a faded LTP weakens all of them at once.",
    keys: ["ltp", "bid", "ask", "spread"],
  },
  {
    step: "Positions",
    question: "Where are contracts held, and what changed?",
    text: "Read open interest for the level and OI change for what moved since the baseline, together. Build-up then names what the premium and the open interest did side by side. A large OI with no change is old positioning; a small one adding fast is new.",
    keys: ["oi", "chg", "vol", "bu"],
  },
  {
    step: "Balance",
    question: "How lopsided is each strike?",
    text: "The strike PCR compares put and call open interest on one row, and the walls and max pain tags summarise the whole ladder. They describe where positions sit; they do not say where the price will go.",
    keys: ["pcrK", "oi"],
  },
  {
    step: "Price of uncertainty",
    question: "How big a move does the premium price in?",
    text: "IV restates the premium as a yearly volatility. Delta, theta and vega then say how the premium reacts to one index point, one day and one vol point. Compare IV across strikes with IV−ATM rather than reading one figure alone.",
    keys: ["iv", "ivx", "delta", "theta", "vega"],
  },
  {
    step: "Cost and distance",
    question: "What does a position need, and how far away is the strike?",
    text: "Time value is what decays by expiry. Breakeven is where the underlying has to finish for a long position to get its premium back, and distance says how far the strike is from spot, in percent and in standard deviations. These are exact arithmetic, but they cannot say whether a premium is fair.",
    keys: ["ext", "be", "dist", "pop"],
  },
]);

/**
 * The self-check: five questions with one right answer each, answered from the chain's own rules. `why` is shown
 * after any answer.
 */
export const QUIZ = Object.freeze([
  {
    id: "atm",
    q: "The forward is at 25137 and strikes are listed 50 points apart. Which row is marked ATM?",
    options: ["25100", "25150", "25200"],
    answer: 1,
    why: "ATM is the listed strike nearest the forward: 25150 is 13 points away, 25100 is 37.",
  },
  {
    id: "spread",
    q: "A far out-of-the-money call shows a bid of 1.80 and an ask of 2.60. What does that mainly tell you?",
    options: ["Open interest at that strike is falling", "Getting in and out at the touch costs a large share of the premium", "The option is unlikely to expire worthless"],
    answer: 1,
    why: "The spread is 0.80 on a mid of 2.20, about 36%. A round trip at the touch gives up roughly that share of the premium. The quote says nothing about open interest or the odds at expiry.",
  },
  {
    id: "buildup",
    q: "On a put, the premium rose while open interest fell. What does the Build-up cell show?",
    options: ["LB, long build-up", "SB, short build-up", "SC, short covering", "LU, long unwinding"],
    answer: 2,
    why: "Premium up with open interest down is SC: short positions are being closed. The rule is the same on calls and puts.",
  },
  {
    id: "vega",
    q: "Which column says how many rupees the premium moves for a 1-point change in implied volatility?",
    options: ["Delta", "Theta", "Vega"],
    answer: 2,
    why: "Vega is the premium's change per vol point. Delta is per index point and theta is per day.",
  },
  {
    id: "tv",
    q: "The forward is 25180 and the 25100 call trades at a mid of 142. What does the Time value cell show?",
    options: ["142.00", "62.00", "80.00"],
    answer: 1,
    why: "Intrinsic on the forward is 25180 − 25100 = 80, so time value is 142 − 80 = 62.",
  },
]);

/**
 * Score the self-check. `answers` maps a question id to the chosen option index (missing = not answered yet).
 * @param {Record<string, number>} answers
 * @returns {{ right: number, answered: number, total: number, results: Array<{ id: string, answered: boolean, ok: boolean, answer: number }> }}
 */
export function scoreQuiz(answers, quiz = QUIZ) {
  const a = answers && typeof answers === "object" ? answers : {};
  const results = quiz.map((item) => {
    const pick = a[item.id];
    const answered = Number.isInteger(pick) && pick >= 0 && pick < item.options.length;
    return { id: item.id, answered, ok: answered && pick === item.answer, answer: item.answer };
  });
  return { right: results.filter((r) => r.ok).length, answered: results.filter((r) => r.answered).length, total: quiz.length, results };
}

/** The line under the self-check: how many right, out of how many answered. */
export function quizSummary(score) {
  if (!score.answered) return `${score.total} questions. Pick an answer to see why it is right or wrong.`;
  if (score.answered < score.total) return `${score.right} of ${score.answered} right so far, ${score.total - score.answered} to go.`;
  return score.right === score.total ? `All ${score.total} right.` : `${score.right} of ${score.total} right. The notes under each question explain the rule.`;
}
