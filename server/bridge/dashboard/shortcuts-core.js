// Every keyboard shortcut in the dashboard, in one registry, plus a short options glossary in our own words (pure, no
// DOM; tested in shortcuts-core.test.mjs). shortcuts.js draws the sheet; desk.js draws the chain's key legend from
// CHAIN_KEYS here, so the legend, the chain's own key handler notes and the sheet never disagree.

/** The chain's keys: [keys, short, what] (the legend under the table uses `short`; the sheet uses `what`). */
export const CHAIN_KEYS = Object.freeze([
  [["J", "K"], "strike", "Next / previous strike (↓ ↑ too)"],
  [["←", "→"], "side", "Calls / puts side (H L too)"],
  [["/"], "search", "Search: a symbol (NIFTY, RELIANCE) or a strike (26400, 264, +3, -2σ, atm, mp). Typing any letter that is not a key here (n, f, a…) opens it too"],
  [["[", "]"], "expiry", "Previous / next expiry"],
  [["1–5"], "view", "Columns: OI, Buyer, Seller, Hedger, Arb (Customise has every view)"],
  [["C", "V"], "calls / puts", "Calls only / puts only (again: both)"],
  [["M"], "select", "Select contracts for the Strategy Builder (Space ticks one)"],
  [["↵"], "sheet", "Open the action sheet for the strike"],
  [["B"], "buy", "Order ticket: buy at the ask"],
  [["S"], "sell", "Order ticket: sell at the bid"],
  [["⇧B", "⇧S"], "buy / sell", "Buy / sell the focused contract: the ticket, or sent at once with your order defaults when 1-Tap is on"],
  [["+", "−"], "add to strategy", "Add a buy / sell leg to the strategy"],
  [["T"], "build around", "Build a strategy around the strike: straddle, strangle, condor, spreads, butterfly, calendar (right-click or long-press the strike too)"],
  [["X"], "exit", "Exit the position you hold in this contract"],
  [["G"], "ATM", "Back to ATM (Home too)"],
  [["P"], "pause", "Pause / resume live updates"],
  [["R"], "refresh", "Refresh now"],
  [["I"], "explain", "Explain a cell of the focused row (again: the next column out)"],
  [["?"], "keys", "Keyboard shortcuts"],
  [["Esc"], "clear", "Clear the focus; close the sheet or the search"],
]);

/** Positions (positions.js POSITION_KEYS, plus Shift+B / Shift+S). */
const POSITION_KEYS = [
  [["J", "K"], "Next / previous leg (↓ ↑ too)"],
  [["Space"], "Select the leg for a bulk exit"],
  [["⇧B", "⇧S"], "Buy / sell more of the focused leg's contract: the ticket, or at once when 1-Tap is on"],
  [["I"], "Include or exclude the leg in risk"],
  [["X"], "Exit the focused leg (ticket)"],
  [["⇧X"], "Exit plan for every leg"],
  [["A"], "Analyse the leg's expiry group in the builder"],
  [["H"], "Open the hedge helper"],
  [[",", "."], "Scenario spot −/+ 0.5%"],
  [[";", "'"], "Scenario IV −/+ 1 point"],
  [["[", "]"], "Scenario days −/+ 1"],
  [["0"], "Reset the scenario"],
  [["G"], "Cycle the risk view: Payoff, Scenario, Greeks"],
  [["C"], "Cycle the payoff curves: Now, + Expiry, + Target"],
  [["B"], "Focus the Δ gauge and read Δ against your band"],
  [["P"], "Pause / resume live updates"],
  [["R"], "Refresh now"],
];

/** Strategy Builder (strategy.js KEYS). */
const STRATEGY_KEYS = [
  [["A"], "Add a leg: the strike picker"],
  [["[", "]"], "Shift every strike down / up one step"],
  [["-", "="], "Size: fewer / more of the whole strategy"],
  [["Alt", "‹ ›"], "Jump a strike five steps"],
  [["E"], "Expiry menu of the focused leg"],
  [["G"], "Suggest: the target price"],
  [["1", "2", "3"], "On the chart: curves (expiry / + target / + mid-date)"],
  [["⇧P"], "Place: opens the confirm sheet"],
  [["MOD S"], "Save this strategy"],
  [["MOD Z"], "Undo the last preset, clear, remove, load or adjustment"],
  [["1–5"], "Preset group: Bullish … Hedge & arb"],
  [["T"], "Target-date slider"],
  [["P"], "Pause / resume live prices"],
];

const OI_KEYS = [
  [["W"], "Next time window (⇧W: previous)"],
  [["1–6"], "Pick a time window"],
  [["C"], "Show / hide the chart"],
  [["M"], "Next metric"],
  [["[", "]"], "Narrower / wider strike band"],
  [["U"], "Lots / quantity"],
  [["J", "K"], "Next / previous strike (↓ ↑ too)"],
  [["G"], "Back to ATM (Home too)"],
  [["↵"], "Open the focused strike's detail"],
  [["?"], "How to read this page"],
];

const VOL_KEYS = [
  [["[", "]"], "Previous / next expiry"],
  [["J", "K"], "Next / previous strike"],
  [["G"], "Back to ATM"],
  [["X"], "Next x-axis: strike, moneyness, delta"],
  [["C"], "Compare with: none, the next expiry, the monthly"],
  [["T"], "Next tab on a phone: smile, term, surface"],
];

const ARB_KEYS = [
  [["1", "2", "3"], "Tabs: Parity, Boxes, Futures"],
  [["J", "K"], "Next / previous opportunity (↓ ↑ too)"],
  [["↵"], "Open the selected opportunity"],
  [["O"], "Only opportunities"],
  [["H"], "Hold to: expiry / the close"],
  [["+", "−"], "One lot more / less"],
  [["B"], "The best opportunity"],
  [["M"], "Boxes: matrix / list"],
  [["E"], "Sort by edge"],
  [["C"], "Copy the legs"],
  [["G"], "Back to ATM"],
];

/**
 * The registry. `mod` is "Ctrl" or "⌘"; `pages` are [{ label, key }] (the pages with a MOD+digit shortcut); `goKeys` are
 * [{ keys: "c", label: "Option Chain" }] (g, then the page's letters). Present = what works today; `coming` entries
 * belong to work in progress and are labelled so in the sheet.
 * @returns {Array<{ id: string, group: string, keys: string[], what: string, coming?: boolean }>}
 */
export function shortcutRegistry({ mod = "Ctrl", pages = [], goKeys = [], have = {} } = {}) {
  const out = [];
  const add = (group, keys, what, extra = {}) => out.push({ id: `${group}:${keys.join("+")}:${out.length}`, group, keys: keys.map((k) => k.replace(/^MOD /, `${mod} `)), what, ...extra });
  // Everywhere
  add("Everywhere", [`${mod} K`], "Search pages and actions");
  add("Everywhere", ["/"], "Search (when not typing in a field; on the Options pages, the symbol and strike search)");
  add("Everywhere", ["?"], "Keyboard shortcuts and glossary (this sheet)");
  for (const p of [...pages].filter((x) => Number.isInteger(x.key)).sort((a, b) => a.key - b.key)) add("Everywhere", [`${mod} ${p.key}`], `Go to ${p.label}`);
  for (const g of goKeys) add("Everywhere", ["g", ...[...g.keys]], `Go to ${g.label}`);
  add("Everywhere", ["Esc"], "Close search, a sheet or a dialog");
  add("Everywhere", ["Tab"], "Next control (⇧Tab goes back)");
  // Trading
  add("Trading", ["Ctrl Alt 1"], "1-Tap on / off: buy and sell at once with your order defaults (off on every reload and after 30 minutes idle)");
  add("Trading", ["⇧B"], "Buy the focused contract (a chain row, a position): the ticket, or at once when 1-Tap is on");
  add("Trading", ["⇧S"], "Sell the focused contract: the ticket, or at once when 1-Tap is on");
  // Option Chain
  for (const [keys, , what] of CHAIN_KEYS) if (keys[0] !== "?") add("Option Chain", keys, what);
  for (const [keys, what] of STRATEGY_KEYS) add("Strategy Builder", keys, what);
  for (const [keys, what] of POSITION_KEYS) add("Positions", keys, what);
  for (const [keys, what] of OI_KEYS) add("OI Analysis", keys, what);
  for (const [keys, what] of VOL_KEYS) add("Volatility", keys, what);
  for (const [keys, what] of ARB_KEYS) add("Arbitrage", keys, what);
  add("Live events", ["/"], "Search the events");
  add("Live events", ["P"], "Pause / resume");
  // Search lists (the palette and the symbol search)
  add("Lists and search", ["↑", "↓"], "Move through results");
  add("Lists and search", ["↵"], "Open the selected result");
  // Workspaces (views.js / palette.js, merged into the base): Shift+1…Shift+6 and the Scalper layout.
  add("Workspaces", ["⇧1–⇧6"], "Switch workspace: Scalper, Options Trader, Stocks, Options Seller, Market Watch, Custom");
  add("Workspaces", ["Ctrl Alt L"], "Scalper layout: the index with its call and put, side by side or stacked");
  // Work in progress elsewhere: shown as coming until their own keys exist (`have` says which already do).
  if (!have.chartKeys) {
    add("Charts", ["Alt T"], "Trend line", { coming: true });
    add("Charts", ["Alt H"], "Horizontal line", { coming: true });
    add("Charts", ["Alt F"], "Fibonacci retracement", { coming: true });
    add("Charts", ["/"], "Add an indicator (on a focused chart)", { coming: true });
  }
  return out;
}

/** The group order of the sheet. */
export const SHORTCUT_GROUPS = Object.freeze(["Everywhere", "Trading", "Option Chain", "Strategy Builder", "Positions", "OI Analysis", "Volatility", "Arbitrage", "Live events", "Lists and search", "Workspaces", "Charts"]);

const norm = (s) => String(s ?? "").toLowerCase().replace(/[⇧]/g, "shift ").replace(/\s+/g, " ").trim();
/**
 * Filter entries by a typed query: every word must appear in the group, the description or the keys ("shift b",
 * "⇧b", "ctrl k", "expiry" all work). Empty query: everything.
 */
export function filterShortcuts(entries, query) {
  const words = norm(query).split(" ").filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((e) => {
    const hay = norm(`${e.group} ${e.what} ${e.keys.join(" ")} ${e.keys.join("")}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Entries grouped in SHORTCUT_GROUPS order: [{ group, items }], empty groups dropped. */
export function groupShortcuts(entries) {
  const by = new Map();
  for (const e of entries) {
    if (!by.has(e.group)) by.set(e.group, []);
    by.get(e.group).push(e);
  }
  const order = [...SHORTCUT_GROUPS, ...[...by.keys()].filter((g) => !SHORTCUT_GROUPS.includes(g))];
  return order.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g) }));
}

/** Options terms in plain words: [term, meaning]. Facts and definitions, never a view on what to trade. */
export const GLOSSARY = Object.freeze([
  ["Call (CE)", "A contract that gains when the underlying rises above its strike by expiry. The buyer pays a premium; the seller collects it and takes the risk."],
  ["Put (PE)", "A contract that gains when the underlying falls below its strike by expiry."],
  ["Strike", "The price an option is measured against at expiry."],
  ["Expiry", "The last day an option trades. Weekly and monthly expiries are listed separately."],
  ["Premium", "The price of an option, per unit. Multiply by the lot size for the rupee value of one lot."],
  ["Lot size", "The fixed number of units one contract covers. Orders are in whole lots."],
  ["ATM / ITM / OTM", "At the money: the strike nearest the spot. In the money: a strike with value if it expired now (calls below spot, puts above). Out of the money: no value at expiry if nothing moves."],
  ["Intrinsic and time value", "Intrinsic value is what the option is worth if it expired now; the rest of the premium is time value, which shrinks towards expiry."],
  ["Bid / Ask", "The highest price a buyer is offering (bid) and the lowest a seller is asking (ask). The gap between them is the spread."],
  ["Touch", "The price on the other side that fills at once: the ask when you buy, the bid when you sell."],
  ["Tick", "The smallest price step a contract trades in (₹0.05 for most index options)."],
  ["LTP", "The last traded price."],
  ["Open interest (OI)", "How many contracts are open at a strike. It rises when new positions open and falls when they close."],
  ["OI change", "How much open interest moved today, by strike."],
  ["PCR", "Put-call ratio: put open interest divided by call open interest across the chain."],
  ["Max pain", "The strike where option buyers together would lose the most if the index settled there at expiry."],
  ["IV", "Implied volatility: the yearly move the option's price implies, read back from the price."],
  ["Delta (Δ)", "How much the option's price moves for a one-point move in the underlying."],
  ["Gamma (Γ)", "How fast delta itself changes as the underlying moves."],
  ["Theta (θ)", "How much value the option loses in a day as time passes, all else equal."],
  ["Vega (ν)", "How much the option's price moves for a one-point change in IV."],
  ["Straddle", "A call and a put at the same strike and expiry."],
  ["Strangle", "A call and a put at different strikes, both usually out of the money."],
  ["Spread", "Two or more legs of the same kind at different strikes or expiries, one bought and one sold."],
  ["Margin", "Money the broker blocks while a position is open. Selling options blocks far more than buying them."],
  ["Charges", "Brokerage, STT, exchange and SEBI fees, stamp duty and GST on an order."],
  ["Intraday / Normal (NRML)", "Intraday positions are squared off by the broker before the close; Normal positions carry overnight."],
  ["Limit / Market", "A limit order trades at your price or better; a market order takes what the book offers now."],
  ["Day / IOC", "Day rests until the close. Immediate or cancel fills what it can at once and cancels the rest."],
  ["GTT", "Good till triggered: an order the Bridge holds and sends when the price reaches your trigger."],
  ["Kill switch", "Stops every new order from every tool until it is released on the Safety page."],
  ["Paper / Live", "Paper orders fill against live prices on this computer only. Live orders go to your broker, and only after every live opt-in is on."],
  ["1-Tap", "Sends a buy or sell at once with your order defaults, without the ticket. Off on every reload and after 30 minutes idle."],
]);

/** Glossary rows matching a query (term or meaning). */
export function filterGlossary(query, list = GLOSSARY) {
  const words = norm(query).split(" ").filter(Boolean);
  if (!words.length) return [...list];
  return list.filter(([t, m]) => words.every((w) => norm(`${t} ${m}`).includes(w)));
}
