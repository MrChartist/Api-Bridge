# Options analytics

The Bridge works out the numbers option traders look at, from its own chain, quotes and candles. Nothing here places an
order, so a read-only key is enough. Chain-based routes go through the same account pooling, freshness labels and rate
limits as `/v1/optionchain`, and every answer is `{ data, meta }` with `meta.freshness` where a broker supplied it.

```bash
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:4300/v1/analytics/oi?underlying=NIFTY&expiry=2026-11-03"
```

| Route | What you get |
| --- | --- |
| `GET /v1/analytics/oi` | Put-call ratio (OI, volume, OI change), max pain, support and resistance, OI by strike |
| `GET /v1/analytics/oi-change` | OI change over a window and long/short build-up or unwinding per strike |
| `GET /v1/analytics/oi-spurts` | Strikes whose OI jumped most against a rolling baseline |
| `GET /v1/analytics/gex` | Dealer gamma exposure by strike, net regime and the flip strike |
| `GET /v1/analytics/skew` | IV by strike, ATM IV and the put-minus-call risk reversal |
| `GET /v1/analytics/surface` | ATM IV and skew across the next expiries, with term structure |
| `GET /v1/analytics/greeks-grid` | Delta, gamma, theta, vega and IV by strike, with peak gamma and vega |
| `GET /v1/analytics/synthetic` | Synthetic future per strike from put-call parity and the gap to the future |
| `GET /v1/analytics/straddle` | ATM straddle premium, its history and the implied move |
| `GET /v1/analytics/futures` | Every upcoming future with basis, carry, calendar spreads and roll cost |
| `GET /v1/analytics/basis`, `/basis-history` | Futures basis now, and its series with mean and z-score |
| `GET /v1/analytics/fii-dii` | Daily FII and DII cash flows from NSE, rolling sums and streaks |
| `GET /v1/analytics/expiry-day` | One digest for expiry day: time left, straddle, max pain, OI walls, gamma, flags |
| `GET /v1/analytics/time-machine` | Historical candles with the ATM strike per bar (historical chains are not stored) |
| `GET /v1/analytics/unusual` | Unusual options activity: volume against OI, premium traded in rupees, OTM distance, IV against ATM, a bid/ask aggressor proxy, flags and a 0-100 score (the formula is in the response) |
| `GET /v1/analytics/tide` | Market tide: net call-versus-put premium flow through the session, bought-versus-sold split (a proxy), sentiment and the top strikes |
| `GET /v1/analytics/exposure` (`/expiries`) | Delta, gamma, vanna and charm exposure by strike, call and put walls, zero-gamma level, and how exposure spreads across expiries |
| `GET /v1/analytics/oi-explorer` | Call and put OI by strike and expiry, with totals and the biggest cells |
| `GET /v1/analytics/vol-stats` (`/term`) | HV10/20/30/60, ATM IV, IV against HV, expected move, IV rank and percentile, and the ATM IV term structure |
| `GET /v1/analytics/screener` (`/presets`) | Filter and sort every contract by delta, IV, OI, volume, premium, DTE, moneyness and spread, with six ready-made presets |
| `GET /v1/analytics/deals` | NSE block and bulk deals with top buyers and sellers |
| `GET /v1/analytics/insiders` | NSE insider-trading disclosures with net insider buying |
| `GET /v1/analytics/events` | NSE results and corporate-events calendar |
| `POST /v1/analytics/backtest` (`/examples`) | Test an entry and exit condition on candles: signal on the bar close, fill on the next open, fees and slippage, stop and target, trades, equity curve, drawdown, Sharpe and buy-and-hold. It tests price rules, not multi-leg option strategies |
| `GET /v1/analytics/participants` | FII, DII, Pro and Client open interest by product (index and stock, futures and options), long and short, net and day-on-day change |
| `GET /v1/analytics/optimizer` | Searches every strategy template, strike offset and width on the live chain and ranks by expected value, probability of profit or risk-reward, under your loss and capital limits |
| `/v1/analytics/watchlists` | Saved watchlists per key (a default F&O leaders list is created on first use) and a one-call quotes route per list |
| `GET /v1/analytics/markets/...` | `indices` (with India VIX), `movers`, `sectors` (1D/1W/1M and drill-down), `breadth` (advance/decline, new highs and lows, share above the 50 and 200-day averages, built once after the close), `rotation` and `correlation` |
| `GET /v1/fields`, `/search`, `/history`, `/bulk`, `POST /v1/batch` | Bloomberg-style field access: a symbol-by-field grid (BDP), history by field with day, week or month bars (BDH), bulk chain or expiries (BDS), a searchable field catalogue, overrides, `format=csv` and batch requests |
| `/v1/analytics/risk/...` | `scenario` (full-reprice P&L over spot, IV and days), `exposure`, `concentration`, `var`, `whatif` and `tca`. Read only: nothing here places an order |
| `GET /v1/analytics/forward-curve`, `/rr-bf`, `/vol-cone`, `/event-vol` | Implied forward and carry per expiry, 25 and 10 delta risk reversal and butterfly, the vol cone with IV against realised, and the move implied around an event |
| `GET /v1/analytics/news/regulatory`, `/news/announcements` | SEBI and RBI notices, NSE announcements with keyword filtering |
| `GET /v1/analytics/calendar/central-banks`, `/fno-ban`, `/timeline` | Central-bank dates, F&O ban list changes and one merged timeline of events, expiries and decisions |
| `GET /v1/analytics/strategies` (`/build`, `/find`) | 13 strategy templates, built from the live chain, and a ranked finder by market view |
| `POST /v1/analytics/payoff` | Expiry payoff curve, max profit and loss and break-evens for your own legs |
| `GET /v1/analytics/greeks` | Black-Scholes IV and Greeks for one option, from a price or an IV |
| `POST /v1/analytics/position-size` | Lots to trade for a risk budget |
| `POST /v1/analytics/lot-split` | A plan that splits a big order under the exchange freeze limit. It only plans: send each child through `POST /v1/orders` |
| `GET /v1/analytics/position-greeks` | Net delta, gamma, theta and vega of an account's open option positions |
| `/v1/analytics/alert-rules` | Saved rules (PCR, max pain distance, gamma regime, ATM IV, basis, spot level) that notify once per crossing |

## Things to know

- **History is built while the Bridge runs.** OI change and OI spurts keep their snapshots in memory, so right after a
  restart they have little to compare with. FII/DII sessions are saved to `analytics/fii-dii.json` in the data folder
  (newest 250 sessions) and reloaded after a restart. Responses say how much they had (`snapshots`, `available`).
- **Computed, not advice.** Gamma exposure assumes dealers are long calls and short puts. The strategy finder's
  probability of profit is a lognormal estimate from ATM IV. Treat both as a guide.
- **Alert rules** are kept per key in `analytics/alert-rules.json` in the data folder and send through the existing
  notification targets.
- **There is no trade tape in India.** "Aggressor", "buy" and "sell" in flow, tide and unusual activity are inferred from
  where the last price sits between bid and ask, and say so (`proxy: true`). Premium traded is volume x price x lot size.
- **IV rank builds up.** The Bridge records one ATM IV reading per day. Until it has 20 days, IV rank is empty and the
  HV20 rank is returned instead, labelled as such.
- **NSE deals, insiders and events** read NSE's public pages, which change without notice. If NSE changes a page the
  route says `UPSTREAM_ERROR` instead of guessing, and serves the last good answer when it has one.
- **Gamma exposure assumes OI is in contracts.** It multiplies OI by lot size. If your broker reports OI in units, the
  rupee figures are too large by the lot size, though the sign, the flip level and the shape are unaffected.
- **Backtests are simple on purpose.** One position at a time, signals on the bar close and fills on the next open, and
  fees and slippage default to 0.05 % each. Past results say nothing certain about the future.
- **The optimizer assumes flat IV.** It uses the at-the-money IV for the whole smile and counts capital as the worst
  loss, not exchange margin, so treat the ranking as a guide.
- **Participant OI** reads NSE's daily participant-wise file, whose address and columns are assumed. The route says
  `UPSTREAM_ERROR` if NSE changes it.
- **New alert metrics:** `unusual_count`, `tide_sentiment`, `iv_rank`, `fii_net_streak` and `volume_spike`.
- **Two risk-reversal signs.** `/skew` reports put IV minus call IV (positive means puts are richer); `/rr-bf` follows
  the usual quoting convention, call IV minus put IV. Read the field description before comparing them.
- **Margin is not available from the brokers.** The adapters give funds and used margin but no margin calculator, so
  a what-if reports required margin as null. Paper trades carry no arrival price, so TCA measures slippage against
  the order's limit price and covers paper orders only.
- **Unverified public sources.** The SEBI, RBI and NSE feed addresses, the central-bank dates and the sector index
  symbols are assumptions to confirm against live sources. Responses say so in `meta`.

## Notes for this Bridge (after the PR 17 merge)

- **Units.** OI and volume are units of the underlying (contracts × lot size). Exposure, unusual activity, the screener
  and tide do not multiply by the lot size again; a chain that says `units: "lots"` is converted.
- **Futures are monthly.** A weekly option expiry reads its month's future (basis, synthetics, strategies, optimizer).
- **Aliases.** `/v1/analytics/alert-rules*` = `/v1/alerts/market*`; `/v1/analytics/watchlists*` reads
  `/v1/watchlists`; `/v1/analytics/participants` reads the participant OI store.
- **Risk on a paper account** reads chains and candles through the data accounts.
- **Straddle** takes `width` (0 to 10): a strangle that many strikes either side of the ATM.
- **Market alert metrics** add `strike_oi_change` and `strike_iv` (with `strike` and `right`) and `atm_iv_change`
  (points against the day's first check).
- **Demo.** NSE, SEBI and RBI feeds are demo rows in demo mode; live, their addresses are unverified and a failure says
  so and leaves the rest of the page alone.
