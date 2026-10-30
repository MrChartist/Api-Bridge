# Paper margin: how the Bridge estimates it

**Approximate, not the exchange's SPAN.** The paper engine, the order ticket, the Strategy Builder's margin line and
the Positions margin bar all use one function, `portfolioMargin()` in `server/bridge/dashboard/span-margin.js`, so the
four always agree. Your broker's figure is the one that counts for live orders.

## What it does

Legs are grouped by underlying (NIFTY, BANKNIFTY, RELIANCE …). Within a group, longs, shorts and futures offset each
other, which is where a hedge earns its benefit.

1. **Scan risk.** Every leg is revalued one day ahead under 16 scenarios:
   - the underlying moves 0, ±⅓, ±⅔ and ±1 of the price scan range (index 9 %, stock 15 %), each with volatility up and
     down 25 % of the leg's own IV;
   - two extreme moves of twice the range, counted at 35 %.

   Options use Black-76 at the leg's IV (implied from its price), futures move one for one. The scan risk is the worst
   loss over the grid.
2. **Premium.** Option buys pay their premium. The premium already covers a long's loss up to its current value, so
   the scan charge is the scan risk less the current value of the longs (never below zero).
3. **Exposure.** Index 2 %, stock 3.5 % of the notional of short options and futures.
4. **Calendar.** Legs in more than one expiry pay 1 % (index) or 2 % (stock) of the delta one expiry offsets against
   another.
5. **Expiry day.** Legs expiring today are scanned on their own (no offset against later expiries), and short index
   options expiring today carry 2 % extra (ELM).

Without a price for the underlying, its legs fall back to the simple per-leg model (premium for buys, 15 % of strike
value for option sells, 15 % of contract value for futures) and the API lists them in `fallback`.

## Examples (NIFTY at 26344, lot 65, 3 November expiry, demo prices)

| Position | Old per-leg model | Portfolio model |
|---|---|---|
| Short 26150 PE, 1 lot | ₹2.55L | ₹1.63L |
| Iron condor 25950 / 26150 PE, 26550 / 26750 CE | ₹5.33L | ₹87k (premium ₹19k, exposure ₹68k) |
| The same four legs, each on its own (`standalone`) | | ₹3.44L |

## Where you see it

- **Option Chain ticket:** "Margin ≈" for a sell or a future, and "With your positions: adds …" when what the paper
  account holds changes the figure.
- **Strategy Builder:** the margin line ("Paper figure · hedges credited") and "Hedge saves ₹…" against the legs on
  their own.
- **Positions:** "this book" on the margin bar; the tooltip names the hedge saving.
- **API:** `POST /v1/paper/accounts/{accountId}/margin` with `{ legs: [{ symbol, side, lots, price? }] }` answers
  `before`, `after`, `change`, `alone`, `standalone`, a breakdown and the method. Nothing is placed.

## Settings

`paper.margin.model` is `"portfolio"` (default) or `"simple"` (every leg on its own with `futuresPct` and
`optionSellPct`, the model before October 2026). Equity, MCX and CDS always use the percentages.

## What it does not model

Real SPAN risk arrays from the exchange, inter-commodity spread credits (for example NIFTY against BANKNIFTY), the
short-option minimum charge, delivery margins in the expiry week of stock options, and broker-specific add-ons.
