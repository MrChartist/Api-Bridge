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
