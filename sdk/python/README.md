# Mr. Chartist API Bridge: Python library

Typed market data with freshness labels, paper-first orders, live streams, asyncio and pandas helpers.
Standard library only (Python 3.9+): HTTP, the WebSocket client and the asyncio client are all built in.

```bash
pip install ./sdk/python                 # from a checkout; add [pandas] for DataFrames
mc-bridge start --demo                   # sample data, paper orders only; no broker needed
mc-bridge keys create --label py --scope read,paper,admin
python -m mrchartist_bridge login        # saves the URL and key for this user (mode 600)
```

## Quickstart (10 lines)

```python
from mrchartist_bridge import Bridge

bridge = Bridge()                                    # finds the URL and key; nothing else to configure
print(bridge.ping())                                 # Ping(ok=True, latency_ms=2.4, version='2.0.0', demo=True ...)

quote = bridge.quote("NSE:RELIANCE")                 # Quote(ltp=..., freshness=Freshness(class='realtime', official=True ...))
quote.require_realtime()                             # raises NotRealtime for delayed, end-of-day, unofficial or stale data

order = bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=quote)   # paper unless live=True
print(bridge.orders.wait_for_fill(order, timeout=30).status)                                  # 'filled'
```

`Bridge()` looks for the URL in the argument, `MCB_BRIDGE_URL`, then the Bridge's own `bridge.config.json`, then
`http://127.0.0.1:4300`; and for the key in the argument, `MCB_API_KEY`, `MCB_API_KEY_FILE`, then `client.json` in the
Bridge folder (`~/.mc-bridge`, or `MCB_HOME`). It never reads the Bridge's data folder or control token. A missing or wrong key,
a Bridge that is not running, a key without the needed scope: each raises a typed error whose message says how to fix it.

## In a notebook

```python
from mrchartist_bridge import Bridge
bridge = Bridge.demo()                               # checks it is a demo Bridge (sample prices, no real accounts)

watch = ["NSE:NIFTY", "NSE:BANKNIFTY", "NSE:RELIANCE", "NSE:INFY"]
prices = bridge.ltp_many(watch)                      # any number of symbols: chunked, waits when rate limited
prices.to_dataframe()                                # one row per symbol, with source / data_class / delay_sec / official / confidence
```

```python
history = bridge.history("NSE:RELIANCE", "1d", countback=250)
df = history.to_dataframe()                          # IST-aware index named "time"; pip install "mrchartist-bridge[pandas]"
df["sma50"] = df["close"].rolling(50).mean()
df[["close", "sma50"]].plot()
```

```python
history.freshness                                    # Freshness(class='eod', delay_sec=86400, official=False, ...) when a free source answered
history.freshness.require_realtime()                 # NotRealtime: this history is fine to chart, never to size an order from
```

```python
import asyncio
from mrchartist_bridge import AsyncBridge

async def main():
    async with AsyncBridge() as b:
        nifty, bank = await asyncio.gather(b.price("NSE:NIFTY"), b.price("NSE:BANKNIFTY"))
        print(nifty.ltp, bank.ltp)

await main()                                         # in a notebook; asyncio.run(main()) in a script
```

## What it does for you

| Need | How |
|---|---|
| Know how current a number is | every `Quote`, `Ltp`, `Depth` and `History` has `.freshness` (`source`, `data_class`, `delay_sec`, `official`, `confidence`, `flags`, `stale`, `is_realtime`) |
| Never size an order from delayed data | `freshness.require_realtime()` raises `NotRealtime`; passing a `Quote` as `price=` or `ref=` runs it for you |
| Paper first | `orders.place(...)` sends `mode="paper"`. Live needs `live=True`; a request dict saying `mode: "live"` without it raises `LiveNotConfirmed` |
| No duplicate orders | every write carries an `Idempotency-Key`; a client order id is generated; the same ids again return the first order (`replayed=True`) |
| An order whose outcome is unknown | `place` looks the order up by client order id and returns it, or raises `OutcomeUnknown` naming the ids to resend. It never sends a second order itself |
| Get to a position | `orders.to_target(symbol, target_quantity=..., product=...)`: one call on a Bridge that has `/v1/orders/to-target`; otherwise the library reads the position first, and an unreadable position is `PositionUnknown`, never "flat" |
| Many orders | `orders.batch([...])`: `/v1/orders/batch` when the Bridge has it, else one by one with derived keys |
| Wait | `orders.wait_for_fill(order, timeout)`; `tickets.wait(ticket_id)` returns `confirmed`, `rejected` or `expired` |
| Streams | `bridge.stream([...])`: sync iterator with reconnect, re-subscribe, `seq` gap detection (`.gaps`), conflation count (`.conflated`), typed events (`.events()`), callbacks (`.on("tick", fn).run()`); `AsyncBridge().stream(...)` for asyncio |
| Rate limits | `batching.retry(fn)` honours `Retry-After` and `RateLimited.scope`; `ltp_many` / `quotes_many` chunk and pace |
| Tables | `to_dataframe()` (pandas, lazily imported) and `frames.to_csv()` (standard library), both keep the freshness columns |
| Spreadsheets | `bridge.xl.ltp(...)`, `.chain(...)`, `.history(...)`, `.formula(...)` for the `/xl` routes |
| Alerts | `alerts.AlertMessage(...)` builds and checks a hook's alert JSON, `alerts.sign(...)`, `bridge.hooks.test(...)` (provisional; see the module) |

## Data you keep, and events (0.3)

Needs a Bridge that has the downloader, recorder, library and events routes; an older one answers 404 and the error says so.

| Need | How |
|---|---|
| Download history in the background | `job = bridge.downloads.create(symbols, "5m", from_="2024-01-01")`, `bridge.downloads.wait(job, on_progress=...)`, `.save(job, "data/")` (each file checked against its SHA-256, `manifest.json` written, a file already there is not fetched again), `.read(job)` (list of dicts; `as_dataframe=True`), `.list()`, `.pause/resume/cancel/delete`, `.export_instruments(...)` |
| Grow a dataset | `downloads.create(..., dataset="nifty-5m")`, later `bridge.datasets.update("nifty-5m", wait=True)` fetches only bars after the last one; `datasets.read(name, symbol, interval)` serves stored bars; `datasets.edit(...)` tags and renames |
| Save option chains and quotes going forward | `bridge.recordings.create("chain", underlying="NIFTY", expiry=..., every_sec=30)`; `bridge.recordings.rules.create(...)` makes it happen every trading day by itself; `.save()`, `.read()` as for downloads |
| Lists of instruments | `bridge.collections` (static lists and `option_universe(...)`), `resolve(name)` (recomputed each time; a delayed or stale price is refused unless `allow_stale=True`, then `warnings` says so; making and changing one needs a `read` key, deleting needs admin), `duplicate`, `tag`, `export`/`import_` (CSV or JSON), `usage`, `estimate` |
| Candles over any range | `bridge.history_all(symbol, "5m", "2024-01-01", local_first=True)`: iterate typed `Candle`s (oldest first, no duplicates), or `.to_dataframe()`, `.records()`, `.to_csv(path)`, `.to_parquet(path)`; `local_first` lets the Bridge answer from data it already stored and saves API calls |
| React to events | `for ev in bridge.events.subscribe(["download.*"]): ...` reconnects and resumes from the last `ev.cursor`; `bridge.subscriptions` manages signed webhooks; `verify_signature(secret, raw_body, request.headers)` checks a delivery (`X-Bridge-Signature` + `X-Bridge-Timestamp`); `bridge.subscriptions.dead_letters(id)` and `retry_dead_letter` handle deliveries that kept failing |
| Parquet | `frames.to_parquet(...)` and `frames.csv_to_parquet(...)` only when `pyarrow` is installed (`pip install "mrchartist-bridge[parquet]"`); the data class is stored in the file's metadata |

Every job, dataset and recording carries its data class, source and delay (`job.label`), and the manifest keeps them with the files.
Delayed and end-of-day files are for analysis only. `AsyncBridge` has the same groups (`await bridge.downloads.wait(job)`,
`async for ev in bridge.events.subscribe(...)`).

Approval of orders that need a person stays on the Bridge's computer. `bridge.tickets` only watches; there is no call that
confirms a ticket, and admin actions (keys, broker sessions, releasing the kill switch) are deliberately not in this library.

## Errors

`BridgeError` is the base. The Bridge's problem codes map onto a tree: `Unauthenticated`, `ScopeRequired`, `RateLimited`
(`.scope`, `.retry_after_ms`), `OrderRefused` (`InvalidOrder`, `KillSwitchActive`, `PaperOnly`, `MarketClosed`, ...),
`OutcomeUnknown` (`PositionUnknown`), `UpstreamError`, and more; no reply at all is `BridgeConnectionError`
(`BridgeNotRunning` when the connection is refused). Unknown codes still arrive as `BridgeApiError` with `.code`.
`mrchartist_bridge/errors.py` lists them all; every error has a `.hint` that says how to fix it.

## Newer Bridge routes

Some calls use routes that arrive in newer Bridges (`orders/to-target`, `orders/batch`, `symbols/resolve`, `calendar/*`,
`hooks/{id}/signals`, `hooks/{id}/test`). The library reads the Bridge's route list (`bridge.features()`) and uses a
client-side fallback where one is safe (`to_target`, `batch`, `symbols.resolve`), or raises `FeatureUnavailable` naming the
missing route (`calendar`, hook signals and tests).

## The original client

`BridgeClient` is unchanged: one method per route, plain dicts back, the Bridge's `{data, meta, errors}` envelope.
`Bridge` wraps one as `bridge.client`; use it, or `bridge.get("/v1/...")`, for anything the typed layer does not cover.

```python
from mrchartist_bridge import BridgeClient
raw = BridgeClient().ltp(["NSE:NIFTY"])["data"]
```

## Command line

```
python -m mrchartist_bridge ping
python -m mrchartist_bridge price NSE:NIFTY NSE:RELIANCE
python -m mrchartist_bridge login
```

## Examples and tests

`examples/` has runnable scripts for prices, a paper order with a fill wait, a reconnecting stream, history to a DataFrame,
sources and freshness, and ticket waiting (see `examples/README.md`).

```
pip install pytest
python -m pytest sdk/python/tests -q
```

The unit tests use the in-process fake Bridge in `tests/fake_bridge.py` and a fake stream server; nothing touches the
network. `tests/test_integration_demo.py` (marked `integration`) starts a real demo-mode Bridge with Node and runs the
library and the examples against it; it is skipped when Node or the repository's dependencies are missing. Personal use
only: broker data terms generally forbid passing market data to other people.
