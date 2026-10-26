# Scanner

Run a condition over hundreds of symbols and get back the ones that match, with any values you want alongside.

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

Saved scans live in `data/scanner/saved.json`. With `everyMinutes` they run by themselves during market hours (set
`marketHoursOnly: false` to run around the clock). When a run matches symbols the previous run did not, the Bridge
emits a `scan` message with `event: "alert"` and the `newMatches`:

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
  "universes": { "MYWATCH": ["NSE:RELIANCE", "NSE:TCS", "NSE:HDFCBANK"] }
}
```

The `NIFTY50` list ships with the Bridge and changes when the index is rebalanced; `FNO` is always current because
it is read from the instrument master. Scans are analysis tools, not advice.
