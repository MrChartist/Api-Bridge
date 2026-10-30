# Live events

The Bridge watches a universe of stocks, indices and option chains while the market is open and writes down the
moments that matter: a new day high, a gap, a stock locked at its upper circuit ("only buyers"), volume running at
three times its usual pace, a call wall moving up, an IV spike. It is the idea of a classic "event selector", with
the time of each event, its strength in words, repeats counted instead of repeated, a day history, a stream and an
API. Server module: `server/bridge/events/` (stream S28).

Status: the server engine, REST, stream topic and demo feed are in place. In demo mode the simulated session starts on the first read of `/v1/events*`. The dashboard page (Markets > Screeners >
Live events) is **not built yet**; see "Not done" at the end.

## How it is fed (speed first, inside the broker budget)

- **Stream first.** The universe is held on the shared stream hub in quote mode (the recorder's reference-counted
  subscriptions, hub clients `events:N`), and every bus `tick` goes straight into the engine: detection happens as the
  tick arrives. Each detector keeps a few numbers per symbol or per strike (day high, last change, a minute ring for
  "N minutes ago"), so a tick costs O(1); nothing rescans history.
- **Option chains from the recorder.** Each `recorder.snapshot` is read back from the recorder's memory (no broker
  call) and every leg runs through the leg detectors; option ticks the recorder streams arrive through the same bus.
  Chain-level reads (walls, PCR, max pain, straddle, ATM IV, basis) use `dashboard/options.js` `chainSummary` and run
  at most once a second per chain, off the tick path.
- **REST only as a fallback.** Symbols the hub refused or that have had no tick for `staleAfterMs` are polled in
  batches with `marketData.quotes` at background priority, only when `ratelimit/backgroundGate.mjs` allows it, with
  `backgroundShare` = `events.budgetShare` (default 0.25, never above 0.5). A refused round waits for the next one.
- **Previous-day context** (previous close, high, low, volume, 20-day average volume, 52-week range) comes from daily
  candles, once a day per symbol, one at a time through the same gate, cached in `events/context-<date>.json`.
- **Demo mode** runs a simulated session (`events/demoMarket.mjs`): about 50 F&O stocks with futures, 5 indices, 90
  fictional small caps marked "(Demo)", and 12 option chains. It replays the first 75 minutes on start, then steps
  once a second through the same detectors, so circuits, surges, gaps and option events all appear.

Measured on the demo fixtures (555 symbols, `demoScale: 5`, Node 22): engine p50 0.005 ms and p95 0.014 ms per tick,
about 70,000 quotes and 10,000 events a second through the engine and the bus on one core. The test
`server/bridge/events/events.test.mjs` asserts p95 under 1 ms and more than 2,000 quotes a second.

## Event records

`GET /v1/events` and the stream message `market_event` carry records like:

```json
{ "id": "ev_20261030_1k", "time": "2026-10-30T10:42:07+05:30", "symbol": "NSE:BODALCHEM", "name": "Bodal Chemicals",
  "asset": "stock", "kind": "only_buyers", "label": "Only buyers", "side": "bull", "ltp": 164.52, "changePct": 5,
  "strength": 5, "context": "upper circuit 5 % at 164.52, 182340 bid", "first": true, "count": 1,
  "tags": { "fno": false, "index": false } }
```

Option events add `option: { underlying, expiry, contract, strike, right, premium, oi, dOiLots, iv, lot }`.

Repeats of the same kind (and variant, e.g. the level crossed) on the same symbol inside the cool-down
(`cooldownSeconds`, default 300) do not make a new row: `count` goes up and `lastAt`, `ltp` and `context` move, and an
`update` goes out on the stream with the same id. `first` is true the first time that key fired today.

## Catalogue

Side: `bull`, `bear`, `neutral`; `move` follows the price direction at the time; `pair` depends on the direction of the
event (an up-cross is bull, a down-cross bear).

| Kind | Label | Side | Definition | Parameters (defaults) |
|---|---|---|---|---|
| `day_high` | New day high | bull | The price trades above the day's high so far, once the first minutes of the session have passed. | afterMinutes = 15 min |
| `day_low` | New day low | bear | The price trades below the day's low so far, once the first minutes of the session have passed. | afterMinutes = 15 min |
| `move_pct` | % move | pair | The change from the previous close crosses one of the levels, up or down (each level fires once a day per direction). | levels = 2, 5, 10 % |
| `vwap_cross` | VWAP cross | pair | The price crosses the day's volume-weighted average price by more than the buffer. | afterMinutes = 15 min; bufferPct = 0.1 % |
| `gap_up` | Gap up | bull | The day opens above the previous close by at least the threshold. | minPct = 1 % |
| `gap_down` | Gap down | bear | The day opens below the previous close by at least the threshold. | minPct = 1 % |
| `gap_filled` | Gap filled | pair | A stock that gapped by at least the threshold trades back to the previous close (a filled gap up reads bear, a filled gap down bull). | minPct = 1 % |
| `vol_above_prev` | Volume above prev day | move | Today's volume so far passes the previous day's full volume. | none |
| `vol_surge` | Volume surge | move | Volume so far is a multiple of what an average day (20 days; the previous day when that is missing) has traded by this minute, using the NSE intraday volume curve. | multiple = 2.5 ×; minMinutes = 10 min |
| `only_buyers` | Only buyers | bull | Locked at the upper circuit: the price is at the upper band (broker band, else the 2/5/10/20 % band rounded to the tick) with buyers waiting and no sell quantity. | none |
| `only_sellers` | Only sellers | bear | Locked at the lower circuit: the price is at the lower band with sellers waiting and no buy quantity. | none |
| `circuit_unlocked` | Circuit unlocked | pair | A stock that was locked at a band trades off it with both sides quoted again (an upper unlock reads bear, a lower unlock bull). | none |
| `prev_high_break` | Prev day high break | bull | The price trades above the previous day's high. | none |
| `prev_low_break` | Prev day low break | bear | The price trades below the previous day's low. | none |
| `pivot_cross` | Pivot crossover | pair | The price crosses a classic floor pivot from the previous day: P = (H + L + C) / 3, R1 = 2P − L, S1 = 2P − H. | none |
| `high_52w` | 52-week high | bull | The price trades above the highest high of the last 52 weeks. | none |
| `low_52w` | 52-week low | bear | The price trades below the lowest low of the last 52 weeks. | none |
| `swing_up` | Swing up | bull | After a swing low, the price turns up by at least the reversal size (zigzag on the day's ticks). | reversalPct = 1 % |
| `swing_down` | Swing down | bear | After a swing high, the price turns down by at least the reversal size. | reversalPct = 1 % |
| `oi_buildup` | OI build-up change | pair | The front future's build-up class changes: long build-up (price up, OI up), short build-up (down, up), short covering (up, down) or long unwinding (down, down), with the same noise filter as OI Analysis. | minOiPct = 1 % |
| `oi_surge` | OI surge | move | The front future's open interest changes by at least the threshold within the window. | pct = 3 %; windowMinutes = 15 min |
| `opt_oi_surge` | Strike OI surge | pair | A strike's OI change over the window is a multiple of its own recent pace (and at least the minimum lots). Call writing reads bear, put writing bull. | multiple = 3 ×; windowMinutes = 5 min; minLots = 200 lots |
| `opt_buildup` | Strike build-up change | pair | A strike's build-up class since the previous close changes (long build-up, short build-up, short covering, long unwinding; classifyBuildup from OI Analysis). | minLots = 100 lots |
| `opt_premium_spike` | Premium spike | pair | An option's premium moves by at least the threshold within the window (premiums under the floor are ignored). A call jump reads bull, a put jump bear. | pct = 25 %; windowMinutes = 5 min; minPremium = 2 ₹ |
| `iv_spike` | IV spike | neutral | ATM IV (or a strike's IV) rises by at least the threshold in vol points within the window. | points = 1.5 vol pts; windowMinutes = 15 min |
| `iv_crush` | IV crush | neutral | ATM IV (or a strike's IV) falls by at least the threshold in vol points within the window. | points = 1.5 vol pts; windowMinutes = 15 min |
| `straddle_move` | Straddle expansion or contraction | neutral | The ATM straddle premium changes by at least the threshold within the window. | pct = 8 %; windowMinutes = 15 min |
| `opt_near_band` | Option near price band | pair | An option trades within the distance of its exchange price band (when the feed sends bands). | withinPct = 2 % |
| `wall_shift` | Call or put wall shift | pair | The strike with the most call OI (resistance) or put OI (support) moves to another strike. A wall moving up reads bull, down bear. | none |
| `pcr_cross` | PCR crosses a level | pair | The OI put-call ratio crosses one of the levels (up reads bull: put writing; down bear). | levels = 0.7, 1, 1.3 |
| `pcr_jump` | Sharp PCR change | pair | The OI put-call ratio changes by at least the threshold within the window. | change = 0.1; windowMinutes = 15 min |
| `max_pain_shift` | Max pain shift | pair | The max pain strike (maxPain from the chain maths) moves to another strike. | none |
| `basis_jump` | Futures basis jump | pair | The front future's basis over spot (cost of carry) changes by at least the threshold of spot within the window. | pct = 0.08 % of spot; windowMinutes = 15 min |
| `opt_unusual_volume` | Unusual option volume | pair | A strike's volume today passes a multiple of its open interest (volume / OI), and at least the minimum lots. Calls read bull, puts bear. | ratio = 1.5 ×; minLots = 500 lots |

Presets: Momentum, Reversals, Circuits, Volume, F&O OI (stocks); OI, IV, Walls, Unusual volume (options).

Circuit bands: a band the broker sends wins. Otherwise each NSE band (2, 5, 10, 20 %) of the previous close is tried,
with the band price rounded to the tick down, to the nearest and up (0.05 and 0.01 ticks), so 5 % on 164.52 matches
172.75 and 172.74. "Locked" needs the price at the band and no quantity on the other side.

Volume pace: today's volume divided by the 20-day average volume (the previous day's when that is missing) times the
share of a day's volume the usual NSE intraday curve has traded by this minute.

## API

| Route | What |
|---|---|
| `GET /v1/events` | today's events, newest first. Filters: `since` (seq), `kind`, `side`, `asset` (stock, option), `symbol`, `q`, `minPrice`, `first=1`, `limit`, `date` (a past day from its file) |
| `GET /v1/events/catalogue` | kinds, definitions, parameters, categories, presets, universes |
| `GET /v1/events/selection` / `PUT` | enabled kinds and their parameters, `universes` (FNO, INDICES, NIFTY50, WATCHLIST, CASH, your scanner universes), `optionMode` (indices, stocks, both), `watchlist`, `cooldownSeconds` |
| `GET /v1/events/summary` | counts by kind and side, bull/bear balance |
| `GET /v1/events/symbols/{symbol}` | one symbol's events today with prev high/low, pivots, VWAP, circuit bands, day range, its chains |
| `GET /v1/events/chain` | one strike's chain row (`underlying`, `expiry`, `strike`) |
| `GET /v1/events/status` | sources, symbols tracked, REST fallback use, per-tick timing |

Stream: send `{ "op": "subscribe_events", "asset"?: "stock", "kinds"?: [...], "sides"?: [...] }` on `/v1/stream`
(SSE: `&events=1`, `&events=stock`, `&events=option`). Messages are `market_event` with `action` new or update,
conflated per event id. The bus topic is `market.event`; the planned alerts engine (P1-11) can subscribe to it
instead of detecting the same things again.

Storage: `dataDir/events/YYYY-MM-DD.jsonl` (demo: `events-demo/`), one line per record and per update, kept
`events.keepDays` (30) days; the selection in `events/selection.json`.

## Config

`events`: `enabled`, `maxSymbols` (600), `futures` (true), `budgetShare` (0.25, max 0.5), `pollSeconds` (15),
`staleAfterMs` (20000), `chainEveryMs` (1000), `keepDays` (30), `maxEventsPerDay` (20000), `cashList`, `demoScale`.

## Not done yet

- The dashboard page (Markets > Screeners > Live events: feed, picker, filters, By stock, summary strip, side sheet,
  sound and notification, CSV, phone cards) and its screenshots.
- The MCP tool (`get_market_events` in the opt-in `options` toolset).
- Option volume against "the same time on average days" (needs per-strike volume history from the recorder's daily
  store); today unusual option volume is volume / OI.
