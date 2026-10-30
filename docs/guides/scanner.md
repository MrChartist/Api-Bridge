# Scanner

Run a condition over hundreds of symbols and get back the ones that match, with any values you want alongside.

There are two kinds of scan:

- **Live scans** (`"interval": "live"`, what Screeners › Stocks runs): number scans for stocks, F&O and options on
  today's prices. They read daily bars (cached once a day) with today's bar live at the end, plus facts per symbol:
  futures OI change, basis, rollover, MWPL, PCR, ATM IV, IV rank, skew, max pain, straddle against the expected move
  and more. See [Live scans](#live-scans).
- **Candle scans** (`1m` to `1M`): a condition over each symbol's candles of that interval. See
  [The condition language](#the-condition-language).

Scans describe numbers. They are not advice, and the library does not include candlestick or chart patterns: the
range scans (NR7, inside day) are about high-low ranges only.

## Live scans

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  "http://127.0.0.1:4300/v1/scanner/jobs?waitMs=30000" \
  -d '{ "universe": "FNO", "interval": "live",
        "condition": "close > highest(20)[1] and volume > 2 * avg_volume(20)[1]",
        "sort": { "by": "vol_pace" } }'
```

The candle functions run on daily bars with today's bar at the end, so `highest(20)[1]` is the 20-day high before
today and `close` is the last price. On top of the candle fields, a live condition can read these facts (one value
per symbol, for today; `x[1]` on a fact is never true):

| Group | Facts |
|---|---|
| Ranges and levels | `range_pct` day range % · `prev_high` `prev_low` · `high_52w` `low_52w` · `from_52w_high_pct` · `upper_circuit` `lower_circuit` and `to_upper_circuit_pct` `to_lower_circuit_pct` (the broker's band when the feed sends one, else 10 % for F&O stocks and 20 % otherwise) · `nr7` (yesterday was the narrowest range of 7 days, 1 or 0) · `inside_day` (1 or 0) |
| Volume | `vol_pace` (volume so far against an average day by this minute, on the NSE intraday curve) · `avg_volume_20` |
| Futures and F&O | `fut_change_pct` · `fut_oi` · `fut_oi_change_pct` (against the previous day's OI) · `basis` · `basis_pct` · `basis_ann_pct` (annualised to the future's expiry) · `rollover_pct` (next month's share of near plus next OI) · `mwpl_pct` · `in_ban` |
| Options and volatility | `pcr` · `atm_iv` · `iv_rank` · `iv_percentile` · `hv20` · `iv_hv_gap` · `put_skew` `call_skew` (5 % out-of-the-money IV minus ATM IV) · `max_pain_dist_pct` · `straddle_pct` · `expected_move_pct` · `straddle_vs_move` · `top_oi_chg_pct` (the strike whose OI changed most) · `max_vol_oi` (the largest strike volume ÷ OI) · `dte` |

A fact that is missing (no futures, no chain yet, fewer than 20 stored IV days) is never a match. Every result row
carries the facts, so a table can show any of them without another run.

### Where the numbers come from, and what a scan costs

A live scan adds no fetch path of its own. It reads:

| Data | From | Cost |
|---|---|---|
| Daily bars | `marketData.history` (1d), once per symbol per IST day, after the shared background gate and inside `scanner.budgetShare` (default and maximum 0.5); kept in `<home>/data/scanner/daily-<date>.json` so a restart costs nothing | 1 call per symbol per day |
| Today's prices, futures | `marketData.quotes` in chunks of 200 at background priority: the stream first, then the shared quote cache (15 s), then one batched broker call per chunk | 1 call per 200 symbols, 0 when streamed or cached |
| Previous day's futures OI | the near future's daily bar, once a day, only for scans that read `fut_oi_change_pct` | 1 call per future per day |
| Option chains | the Data recorder's memory and the option sweep's chains (Screeners › Options) | 0 |
| IV history | ATM IV stored once a day per symbol in `<home>/data/scanner/iv-history.json` | 0 |
| MWPL and the ban list | the reference service (Market calendar) | 0 |

What the condition reads decides what is fetched: a gap scan reads only quotes; `fut_oi_change_pct` adds the
futures; a candle function adds the daily bars. Each run reports `stats`: `ms`, `symbols`, `brokerCalls` (counted
by the rate-limit engine under the consumer "Scanner"; live collects run one at a time so the count is exact), the
quote sources and the daily bars fetched or cached.

Measured on the test rig (Zerodha's limits: history 3/s, quotes 1/s, 500 per quote call), 200 symbols, a
breakout scan that reads daily bars:

| Run | Broker calls | Time |
|---|---|---|
| Cold (first run of the day) | 201: 200 daily reads, paced to keep half of every window free, and 1 quote call | about 220 s |
| Warm (daily bars cached, quotes under 15 s old) | 0 | well under a second |
| Warm, 20 s later | 1 (one batched quote read) | under a second |

A price-only scan (gap, % change, circuits) is 1 call per 200 symbols, cold or warm. Option-chain scans read no
broker at all: run the option sweep (Screeners › Options) or the Data recorder for the chains they need.

### The library

`GET /v1/scanner/library` lists the ready-made scans; each is a builder model you can open and edit.

| Group | Scans |
|---|---|
| Price | Gap up · Gap down · At a 52-week high · At a 52-week low · Near the upper circuit · Near the lower circuit · NR7 · Inside day · Above previous-day high on volume · Below previous-day low on volume · Above 20-day high on volume |
| F&O | Long build-up · Short build-up · Short covering · Long unwinding · OI spike · Near the F&O ban · PCR high · PCR low · IV rank high · IV rank low · IV percentile high · IV percentile low · IV well over HV · IV under HV · Futures at a discount · High rollover · Cash-futures carry |
| Option chain | Largest strike OI change · Unusual option volume · OTM puts priced over ATM · OTM calls priced under ATM · Far from max pain · Straddle under the expected move · Straddle over the expected move |

### The builder and the Advanced text

Screeners › Stocks writes conditions as sentences: "Close is above 20-day high", "Volume is more than 2× 20-day
average volume", "PCR (OI) is at least 1.5", in **All of** or **Any of** groups (one level of groups). Values are
picked from a searchable list; periods are checked as you type (a whole number from 2 to 250). The count of matches
updates as you edit (`POST /v1/scanner/count`, half a second after the last change): it re-evaluates the condition
over the facts the last run collected, so it makes no broker call.

**Advanced** shows the same scan as text. `POST /v1/scanner/compile` turns a builder model into text, or text back
into a model; when the text has parts the builder cannot show (arithmetic between values, `not`, a group in a group)
the model is `null` with the reason, and the scan keeps running as text. Advanced can also scan candles of another
interval (daily, weekly, 60, 15 or 5 minutes) without the live facts.

### Results, Excel and the API

The results table shows LTP, % change, volume pace, OI change, IV and IV rank by default; PCR, basis, MWPL, gap,
rollover, IV minus HV and straddle ÷ move are a click away (Columns). Filter by sector, index (NIFTY 50, NIFTY BANK,
NIFTY IT) or F&O only; sort by any column. A row opens a sheet with the key numbers and links to the Option Chain
(at the scan's strike, or ATM), Strategy Builder (an ATM straddle to start from) and the watchlist.

- CSV: Export › Download CSV (the rows and columns shown).
- Excel: `=TEXTSPLIT(WEBSERVICE("http://127.0.0.1:4300/v1/scanner/saved/<id>/results?format=text&key="&BridgeKey),",")`
  spills the matched tickers, one per cell (put a read-only key in a cell named BridgeKey).
- API: `GET /v1/scanner/scan?condition=gap_pct%20%3E%202&universe=FNO&format=json` runs a scan and waits for it
  (`format=csv` or `text` too; `?key=` works for spreadsheets). `GET /v1/scanner/saved/<id>/results` returns a
  saved scan's last run with its new matches.

### Demo mode

Demo mode scans its own simulated F&O market of about 200 stocks (a year of daily bars, futures with OI, a chain on
a smile, an IV history, MWPL). Every library scan has planted hits, some switching on later in the demo day, so
scheduled scans show new matches. Stocks the demo broker already prices keep its price, so the Option Chain agrees.
Demo runs make no broker call.

## Candle scans

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  "http://127.0.0.1:4300/v1/scanner/jobs?waitMs=60000" \
  -d '{ "universe": "FNO", "interval": "1d",
        "condition": "close crosses above ema(20) and volume > 1.5 * avg_volume(20)",
        "columns": ["rsi(14)", "change_pct"], "sort": { "by": "rsi(14)" } }'
```

A read-only key is enough: a scan only reads candles.

## How it stays inside your limits

- **Background priority.** Scan requests queue behind charts, Option Hub, spreadsheets and orders, so a big scan
  never slows anything interactive.
- **Shared out over your accounts.** When several of your accounts may pool reads (see
  [rate-limits.md](rate-limits.md#spreading-reads-across-your-own-accounts)), each account gets its own worker pool,
  pinned to it and as wide as its history budget (a 3 requests/s account runs 3 workers, a 1/s account 1), all
  pulling from one queue. A faster account simply does more of the work. The rate-limit engine still paces every
  call, so no account goes over its broker's limit.
- **Backup data.** With `source: "auto"` (the default) a symbol no broker can serve is fetched from the
  [backup sources](backup-data.md) when they are on. `source: "backup"` never touches a broker (good for end-of-day
  scans of daily candles); `source: "broker"` never uses backup data.
- **Plan first.** `POST /v1/scanner/plan` with the same body shows which accounts would serve it, each pool's width
  and an estimated run time.

Each match says where its candles came from (`source`, `accountId` or `provider`), and the job's `usage` counts
symbols per account.

## The condition language

Values are series over the candles; the scan matches when the condition is true on the **last** bar.

| Kind | Available |
|---|---|
| Fields | `open high low close volume oi ltp prev_close change change_pct gap_pct hl2 hlc3 range` |
| Averages | `sma(n[, src])`, `ema(n[, src])`, `wma(n[, src])`, `avg_volume(n = 20)` |
| Oscillators | `rsi(n = 14[, src])`, `macd(fast = 12, slow = 26)`, `macd_signal(12, 26, 9)`, `roc(n)` |
| Volatility | `atr(n = 14)`, `stddev(n)`, `bb_upper(n = 20, k = 2)`, `bb_lower(20, 2)` |
| Trend | `supertrend(n = 10, mult = 3)`, `vwap()` (intraday, resets each day) |
| Ranges | `highest(n[, src = high])`, `lowest(n[, src = low])` |
| Maths | `+ - * /`, `abs(x)`, `min(a, b)`, `max(a, b)` |
| Compare | `> >= < <= == !=`, `crosses above`, `crosses below` |
| Logic | `and`, `or`, `not`, brackets |
| Past bars | `x[k]` is `x` k bars ago: `close > highest(20)[1]` |

Examples:

```text
rsi(14) > 60 and close > sma(50)
close > highest(20)[1]                              20-bar breakout
macd() crosses above macd_signal()
close > supertrend(10, 3) and change_pct > 2
close > vwap() and volume > 2 * avg_volume(20)      use an intraday interval
abs(close / sma(200) - 1) < 0.02                    within 2% of the 200-day average
```

Anything that cannot be computed yet (too few bars) is never a match. The number of bars loaded per symbol is worked
out from the condition (with warm-up for EMA, RSI, ATR and MACD), or set it with `lookback`.
`GET /v1/scanner/language` returns the full list.

## Request

| Field | Meaning |
|---|---|
| `universe` or `symbols` | `FNO` (every stock with NSE futures, from your broker's instrument master), `NIFTY50`, `INDICES`, one of your own (`scanner.universes` in the config), or a list of symbols |
| `interval` | `1m 3m 5m 10m 15m 30m 60m 1d 1w 1M` (default `1d`) |
| `condition` | the condition (up to 1,000 characters) |
| `columns` | up to 12 expressions to report for each match (default `close`, `change_pct`, `volume` are always there) |
| `sort` | `{ "by": "<expression>", "order": "desc" }` |
| `limit` | keep only the first N matches |
| `source` | `auto` (default), `broker` or `backup` |

`POST /v1/scanner/jobs` answers `202` with the job (poll `GET /v1/scanner/jobs/{id}`), or `200` with the results
when it finished within `?waitMs=`. `DELETE /v1/scanner/jobs/{id}` cancels it. A key sees its own scans; an admin key
sees all.

## Saved and scheduled scans, with alerts

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" http://127.0.0.1:4300/v1/scanner/saved \
  -d '{ "name": "15m breakouts", "everyMinutes": 15,
        "request": { "universe": "NIFTY50", "interval": "15m", "condition": "close > highest(20)[1]" } }'
```

Saved scans live in `data/scanner/saved.json` in the Bridge home. With `everyMinutes` they run by themselves during
market hours (set `marketHoursOnly: false` to run around the clock); with `atClose: true` they run once a minute after
the close on each trading day. `PATCH /v1/scanner/saved/{id}` renames a scan or changes its request, schedule,
`notify`, `builder` model or `columns` (a changed request starts a fresh baseline); `POST
/v1/scanner/saved/{id}/duplicate` copies it without its history.

When a run matches symbols the previous run did not:

- each new symbol becomes a **Scan hit** row in Live events (the scan's name is the label, up to 20 per run);
- the dashboard shows a toast on whatever page is open;
- the notify module sends it to your notification targets, unless the scan has `notify: false`;
- the results mark those rows **New** (an unsaved scan compares with its own previous run in this session).

The stream carries it as a `scan` message with `event: "alert"` and the `newMatches`:

- WebSocket `/v1/stream`: send `{ "op": "subscribe_scans" }`;
- SSE: add `&scans=1` to `/v1/stream/sse`.

The same channel carries `progress` (at most once a second per scan) and `completed` events.

## Settings

```json
"scanner": {
  "maxSymbols": 1000,
  "maxRunning": 2,
  "keepJobs": 50,
  "perAccountConcurrency": 4,
  "schedule": true,
  "budgetShare": 0.5,
  "universes": { "MYWATCH": ["NSE:RELIANCE", "NSE:TCS", "NSE:HDFCBANK"] }
}
```

`budgetShare` is the most of any broker window a live scan's daily reads may use (never more than half: user and
order calls always come first).

The `NIFTY50` list ships with the Bridge and changes when the index is rebalanced; `FNO` is always current because
it is read from the instrument master. Scans are analysis tools, not advice.
