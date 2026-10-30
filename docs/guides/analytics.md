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
| `GET /v1/analytics/strategies` (`/build`, `/find`) | 13 strategy templates, built from the live chain, and a ranked finder by market view |
| `POST /v1/analytics/payoff` | Expiry payoff curve, max profit and loss and break-evens for your own legs |
| `GET /v1/analytics/greeks` | Black-Scholes IV and Greeks for one option, from a price or an IV |
| `POST /v1/analytics/position-size` | Lots to trade for a risk budget |
| `POST /v1/analytics/lot-split` | A plan that splits a big order under the exchange freeze limit. It only plans: send each child through `POST /v1/orders` |
| `GET /v1/analytics/position-greeks` | Net delta, gamma, theta and vega of an account's open option positions |
| `/v1/analytics/alert-rules` | Saved rules (PCR, max pain distance, gamma regime, ATM IV, basis, spot level) that notify once per crossing |

## Things to know

- **History is built while the Bridge runs.** OI change, OI spurts and FII/DII keep their snapshots in memory, so
  right after a restart they have little to compare with. Responses say how much they had (`snapshots`, `available`).
- **Computed, not advice.** Gamma exposure assumes dealers are long calls and short puts. The strategy finder's
  probability of profit is a lognormal estimate from ATM IV. Treat both as a guide.
- **Alert rules** are kept per key in `analytics/alert-rules.json` in the data folder and send through the existing
  notification targets.
