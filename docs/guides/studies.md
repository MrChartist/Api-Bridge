# Studies: indicators and candlestick patterns from ChartistScript

The Bridge computes chart studies (moving averages, Bollinger bands, RSI, Supertrend, MACD and 75 more), the 24
candlestick patterns and your own ChartistScript indicators over any symbol's daily, weekly or monthly candles. The
maths is the ChartistScript core from Mr. Chartist's scanner, the same engine the scanner's chart uses, run on this
computer. Nothing here can place an order.

## What is available

`GET /v1/studies` lists everything, with the settings each study takes (type, range, default), what it gives back,
and where a chart draws it (`pane`: `price` on the candles, `panel` in a pane of its own).

- **80 studies** (`ind.<id>` in the language): averages (`sma`, `ema`, `wma`, `hma`, `dema`, `tema`, `rma`, `vwma`,
  `lsma`, `alma`, `kama`, `mcginley`), bands and channels (`bb`, `keltner`, `donchian`, `envelope`, `linregchannel`),
  trend (`supertrend`, `sar`, `ichimoku`, `adx`, `aroon`, `vortex`, `zigzag`, `pivothl`), VWAPs (`vwap`, `vwapbands`,
  `sessionvwap`, `avwap`), oscillators (`rsi`, `macd`, `stoch`, `stochrsi`, `cci`, `mfi`, `williamsr`, `roc`, `tsi`,
  `ppo`, `cmo`, `kdj`, `uo`, `crsi`, `fisher`, `smi`, `rvi`, ...), volatility (`atr`, `bbw`, `percentb`, `stddev`,
  `historicalvol`, `ulcer`, `adr`, `chop`, ...) and volume (`obv`, `cmf`, `adline`, `klinger`, `pvt`, `nvi`, `pvi`,
  `volumema`, `rvol`, ...).
- **8 more are listed but not available yet** (`pivot`, `fractals`, `chandelier`, `cpr`, `prevhl`, `hl52`, `orb`,
  `squeeze`); each says why in `reason`.
- **24 candlestick patterns**: hammer, shooting star, marubozu, five dojis, engulfing, harami, piercing line, dark cloud
  cover, tweezers, inside bar, morning and evening star, three white soldiers, three black crows, three inside up and
  down. Bullish ones are marked under the low, bearish and neutral ones over the high.
- **Causality.** Four studies (`ichimoku`, `avwap`, `pivothl`, `zigzag`) are `noncausal`: their earlier values can change
  as new candles arrive. They are fine to draw, not to trade on.

## Computing

```http
POST /v1/studies/compute?account=<optional>
Authorization: Bearer <read key>

{
  "symbol": "NSE:RELIANCE",
  "interval": "1d",
  "countback": 250,
  "studies": [
    { "id": "sma", "params": { "length": 50 }, "key": "sma50" },
    { "id": "bb" },
    { "id": "rsi", "params": { "length": 14 } },
    { "id": "supertrend", "params": { "period": 10, "mult": 3 } }
  ],
  "patterns": ["hammer", "bullish_engulfing", "bearish_engulfing"]
}
```

- `symbol`, `interval` (`1d`, `1w` or `1M`), and `from` / `to` or `countback`: the same as `GET /v1/history`, which is
  where the candles come from (same accounts, cache, backup sources and `?account=` rules).
- `studies`: up to 16, each `{ id, params?, key? }`. Settings left out take their defaults; a setting outside its range
  is refused. Studies that read the close take `src` (`close`, `open`, `high`, `low`, `volume`, `hl2`, `hlc3`, `ohlc4`).
- `patterns`: pattern ids, or `"all"`.
- Or a `script` (a ChartistScript indicator) with its settings in `inputs`, instead of `studies` and `patterns`:

```json
{
  "symbol": "NSE:RELIANCE", "interval": "1d", "from": "2026-01-01",
  "script": "@indicator(name=\"Cross\", overlay=True)\ndef f(n: int = input(20)):\n    plot(ta.sma(close, n), \"SMA\")\n    mark(ta.crossover(close, ta.sma(close, n)), where=\"below\", text=\"Up\")\n",
  "inputs": { "n": 30 }
}
```

The language itself is documented with the core (`server/vendor/chartist-core/README.md`, and the scanner repository's
`packages/chartist-core/docs/`). Scripts are checked as the chart host: `plot`, `mark`, `bgcolor` and `fill`, no
screeners or strategies, no data beyond the symbol's own candles.

**Warm-up.** By default the Bridge fetches enough earlier candles (the core works out how many) that the first value
you see is already settled; `data.warmup` says how many were needed and used. `"warmup": false` turns it off, and the
first values are then null.

## The answer, and drawing it

```jsonc
{
  "data": {
    "symbol": "NSE:RELIANCE", "interval": "1d", "partial": false, "truncated": false,
    "warmup": { "needed": 49, "used": 49, "short": 0 },
    "time": [1769365800, 1769452200, ...],                 // epoch seconds, one per candle
    "series": [
      { "key": "sma50.value", "study": "sma50", "field": "value", "label": "sma(50)", "pane": "price",
        "style": "line", "type": "float", "values": [2841.2, 2843.9, ...] },   // same length as time; null = unknown
      { "key": "supertrend3.direction", "pane": "price", "type": "int", "values": [1, 1, -1, ...] },
      ...
    ],
    "markers": [
      { "key": "pattern.hammer", "time": 1770057000, "price": 2790.5, "position": "below",
        "shape": "triangle_up", "text": "hammer", "pattern": "hammer", "bias": "bullish" }
    ],
    "fills": [],                                           // scripts: { key, between: ["p1", "p2"] }
    "studies": [ { "key": "sma50", "id": "sma", "params": { "length": 50, "src": "close" }, "pane": "price", ... } ]
  }
}
```

Every series lines up with `time` by index, so a chart series is `time.map((t, i) => ({ time: t, value: values[i] }))`
with null points skipped (a gap). `style` is `line`, `hist`, `area`, `step` (script plots) or `background` (a script's
`bgcolor`, 1 where tinted). `pane: "price"` series go on the candles; group `pane: "panel"` series by `study` into one
pane each. `type` `int` and `bool` series are states (Supertrend direction, SAR up), useful for colouring rather than
as lines on the price scale. Markers carry their own time and price.

## Limits

| Limit | Value | Error |
|---|---|---|
| Studies per request | 16 | `COMPUTE_LIMIT` (422) |
| Candles shown | 5000 (the newest are kept, `truncated: true`) | |
| Script | 12,000 characters, 300 lines, and the core's own limits on nesting, size and look-back | `COMPUTE_LIMIT` or `VALIDATION_FAILED` |
| Work | the core's run budget: 25,000,000 values touched per request | `COMPUTE_LIMIT` (422) |
| Time | 10 s per step (config `studies.timeoutMs`); the worker is stopped | `COMPUTE_TIMEOUT` (504) |
| Body | 64 KiB | `PAYLOAD_TOO_LARGE` (413) |
| Concurrency | 2 workers, 16 waiting (`studies.workers`, `studies.maxQueue`) | `RATE_LIMITED` (429) |
| Interval | `1d`, `1w`, `1M` only: the language reads one candle per session | `VALIDATION_FAILED` |

A script's mistakes come back as `VALIDATION_FAILED`, one entry per problem in `errors`, each with the core's code,
line and column and a hint.

## How it runs, and safety

- The core runs on the server, not in the browser. Each request is checked and compiled, then run, in a **worker
  thread** with a heap limit; a job past its time limit is stopped by terminating the worker.
- A script is never turned into JavaScript: the core compiles it to a graph of known operations and interprets it, with
  no file, network, clock or randomness. Study settings are checked against the core's ranges before any script text
  is written, so a request cannot inject script text through them.
- **No orders.** The core has no order code; the worker receives candles and returns numbers; the module reads only
  the market data service. `server/bridge/studies/noOrders.test.mjs` walks the whole import graph (into the vendored
  core) to prove nothing order-capable is reachable.

## Provenance and updating the copy

The core is the owner's code: **Copyright (c) 2026 Rohit Singh (Mr. Chartist), all rights reserved**. It is not
covered by this repository's MIT licence. It lives in `server/vendor/chartist-core/`, compiled once from
`MrChartist/scanner` `packages/chartist-core` at commit `c2ac504`, with its `COPYRIGHT`, `PROVENANCE.md`,
`THIRD_PARTY_NOTICES.md`, `SECURITY.md` and `README.md` beside it, `VENDORED.md` saying where it came from and
`VENDOR.json` holding the commit, the compiler and a sha256 of every file. The only change is the build: TypeScript to
ES2023 modules, and full file names on relative imports. The core's backtest and derivatives modules are in the copy
(they compile cleanly) but are not used; the Bridge has its own backtest.

To update it, check out the scanner at the commit you want and run:

```sh
npm run vendor:chartist-core -- --core ../scanner        # rewrites server/vendor/chartist-core
node scripts/vendor-chartist-core.mjs --core ../scanner --check   # exit 1 if the copy differs
node scripts/vendor-chartist-core.mjs --core ../scanner --out /tmp/vendor --tests /tmp/core-tests
cd /tmp/core-tests && npx vitest run                     # the core's own test suite, on the compiled code
```

Never edit the copy by hand: `server/bridge/studies/vendor.test.mjs` fails when a file does not match `VENDOR.json`.
