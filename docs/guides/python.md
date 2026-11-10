# Python

The Python library uses the standard library only (Python 3.9+): HTTP, a small WebSocket client and an asyncio client are
built in. It is typed (`py.typed`), pleasant in notebooks, and safe by default: orders are paper unless you say
`live=True`, and delayed data cannot feed an order. Full reference: [sdk/python/README.md](../../sdk/python/README.md).

```bash
pip install ./sdk/python                      # add the pandas extra for DataFrames: pip install "./sdk/python[pandas]"
mc-bridge keys create --label py --scope read,paper    # shown once; copy it
python -m mrchartist_bridge login             # saves the URL and key for this user (owner-only file), then pings
```

Or set `MCB_API_KEY` (and `MCB_BRIDGE_URL` when the Bridge is not at `http://127.0.0.1:4300`). Use a read or paper key for
scripts; a key that can trade live or administer the Bridge does not belong in a notebook or a spreadsheet.

## Connect

```python
from mrchartist_bridge import Bridge

bridge = Bridge()            # URL and key found from arguments, MCB_*, the Bridge's config and client.json
print(bridge.ping())         # is it up, how fast, is the key accepted
demo = Bridge.demo()         # the same, but only if the Bridge is in demo mode (sample prices, paper only)
```

Where the URL and key come from, in order, is in `mrchartist_bridge/discovery.py`. The library never reads the Bridge's data
folder or its control token. A missing key, a wrong key, a Bridge that is not running and a key without the needed scope each
raise a typed error with a one-line fix.

## Market data and freshness

```python
quotes = bridge.quotes(["NSE:NIFTY", "NSE:RELIANCE"])         # a list of Quote; quotes.errors holds symbols that failed
for q in quotes:
    f = q.freshness
    print(q.symbol, q.ltp, f.source, f.data_class, f.delay_sec, f.official, f.confidence, f.flags)

q = bridge.quote("NSE:RELIANCE")
q.require_realtime()          # NotRealtime for delayed, end-of-day, unofficial or stale data
```

Real-time data comes from your own broker accounts. Free sources and plugins answer with `class` `delayed` or `eod` and are
fine for charts and analysis, never for orders, risk checks, paper fills or alerts (see [sources](sources.md)).
`history.freshness`, `depth.freshness` and every `Ltp` carry the same label.

## Orders

```python
from mrchartist_bridge import NotRealtime, OrderRefused, OutcomeUnknown

try:
    order = bridge.orders.place("NFO:NIFTY-2026-12-29-FUT", "BUY", lots=1, product="MARGIN", price=bridge.quote("NFO:NIFTY-2026-12-29-FUT"))
    done = bridge.orders.wait_for_fill(order, timeout=30)
except NotRealtime as e:        # the quote was delayed or stale: nothing was sent
    ...
except OrderRefused as e:       # kill switch, market closed, paper only, invalid order ...: e.code says which
    ...
except OutcomeUnknown as e:     # the Bridge cannot tell if the broker took it: use e.idempotency_key and e.client_order_id
    ...
```

- `place` sends `mode="paper"`; live needs `live=True` and everything the Bridge requires for live trading (see [safety](safety.md)).
- Every write has an `Idempotency-Key` and a generated client order id. Calling again with the same two ids returns the first
  order with `replayed=True`.
- An unknown outcome is looked up by client order id. You get the order back, or `OutcomeUnknown`; the library never sends a
  second order for you.
- `orders.preview(...)`, `orders.cancel(...)`, `orders.modify(...)`, `orders.list(...)`, `orders.to_target(...)` and
  `orders.batch(...)` follow the same rules. `to_target` and `batch` use `POST /v1/orders/to-target` and
  `POST /v1/orders/batch` on a Bridge that has them and fall back to the library otherwise; an unreadable position is
  `PositionUnknown`, never treated as flat.
- Orders that need a person (AI assistants, hooks that ask for confirmation) wait as tickets. `bridge.tickets.wait(id)` reports
  `confirmed`, `rejected` or `expired`. Approval itself stays on the Bridge's computer, in the dashboard: there is no call in the
  library that confirms a ticket.

## Streams

```python
with bridge.stream(["NSE:NIFTY", "NSE:RELIANCE"], mode="quote", orders=True) as s:
    for event in s.events():                  # Tick, Snapshot, OrderUpdate, FeedStatus, Heartbeat, GoAway ...
        print(event)
print(s.gaps, s.conflated, s.reconnects)
```

The stream reconnects with a fresh single-use token, re-subscribes everything, waits as `go_away` asks, and counts `seq` gaps
and conflated ticks (a slow reader skips values; the newest always arrives). `s.on("tick", fn).run()` is the callback form.
For asyncio: `async with AsyncBridge().stream([...]) as s: async for event in s.events(): ...`.

## asyncio

```python
async with AsyncBridge() as bridge:
    nifty, bank = await asyncio.gather(bridge.price("NSE:NIFTY"), bridge.price("NSE:BANKNIFTY"))
    order = await bridge.orders.place("NSE:RELIANCE", "BUY", quantity=1, product="CNC", price=nifty)
```

`AsyncBridge` runs the blocking calls in worker threads (up to `max_concurrency`, default 8). For many symbols use
`await bridge.ltp_many(symbols)`.

## pandas, CSV and spreadsheets

```python
df = bridge.history("NSE:RELIANCE", "1d", countback=250).to_dataframe()   # IST index, freshness columns
bridge.quotes(symbols).to_dataframe()
from mrchartist_bridge import frames
frames.to_csv(bridge.history("NSE:RELIANCE", "5m", countback=300), "reliance.csv")
print(bridge.xl.formula("ltp"))                                          # an Excel =WEBSERVICE(...) formula, key left as a placeholder
```

## Downloads, datasets and recordings

The Bridge can fetch history for many symbols in the background and keep it as files, and can record what brokers do not
give you (option chains, open-interest snapshots) going forward from its own live data. The library drives both.

```python
job = bridge.downloads.create(["NSE:RELIANCE", "NSE:TCS"], "5m", from_="2024-01-01", dataset="large-caps-5m")
job = bridge.downloads.wait(job, on_progress=lambda j: print(j.status, j.progress.done, "of", j.progress.total))
bridge.downloads.save(job, "data/")          # checks each file's SHA-256, writes manifest.json, skips files already there
rows = bridge.downloads.read(job)            # list of dicts (as_dataframe=True for pandas)
bridge.datasets.update("large-caps-5m", wait=True)      # later: only the bars after the last stored one
```

- A job runs at the lowest priority on the Bridge, so it never slows live reads or orders, survives a restart, and stops with
  a stated reason (`job.reason`) on a kill switch or a lost login. `wait` raises `DownloadFailed` with that reason, or
  `WaitTimeout` (the job carries on; look again with `downloads.get(id)`).
- Every job, dataset and recording says its data class, source and delay (`job.data_class`, `job.label`) and `save()` keeps
  that in `manifest.json`. `backup=True` lets a free source serve a job; its files are then `delayed` or `eod`, for analysis
  only, never for orders, risk checks, paper fills or alerts.
- `bridge.recordings.create("chain", underlying="NIFTY", expiry="2026-11-12", every_sec=30)` records chains (at least 15 s
  apart) and `create("quotes", symbols, every_sec=1)` quotes. The Bridge records real-time data only. For recording without
  pressing start, `bridge.recordings.rules.create("Index chains", "chain", every_sec=30, collection="index-options")`: the Bridge
  starts and stops it at each trading session, resumes after a restart and notes a gap when the feed was missing.
- Look before you start: `bridge.downloads.estimate(symbols, "5m", from_=...)` takes the same arguments as `create`, starts
  nothing and returns a `DownloadEstimate` (`broker_calls`, `calls_saved` by data already stored, `rows`, `bytes`, `eta_sec` at
  your budget share, `fits_disk`). `bridge.saved_calls()` says how many broker calls the Bridge did not make today
  (`total`, `by_reason`, and `total_today` with the stream, cache and shared calls added).
- How much of the broker's budget background work may use: `bridge.downloads.settings()` and `bridge.recordings.settings()`
  (`max_budget_share`, 0.05 to 0.8). `set_settings(max_budget_share=0.5)` changes it while the Bridge runs and needs an admin
  key from the Bridge's computer; downloads also have `after_hours_only`, recordings do not (they record in market hours).
- `bridge.recordings.status().line` is the plain sentence ("Recording today: 3 rules, 41 symbols, 18 MB, last write 09:31:02").
  `bridge.recordings.presets()` lists the one-click rules and `apply_preset("index-option-chains")` makes the rule once and
  turns auto-record on (admin key from this computer; `apply_preset("my-watchlist", collection="mine")` picks the list).
- A collection is a named, tagged list that downloads, recordings and sheets share: `bridge.collections.create("w", symbols)`
  or `create("nifty-near", universe=option_universe("NIFTY", "current-weekly", count=10))`. `resolve(name)` gives the symbols
  now; for an option universe it recomputes the ATM and the rolling expiry each time and puts a note in `warnings` when
  the price was stale. The Bridge refuses an ATM from a delayed or end-of-day price (422) and from a stale one (503) unless you
  pass `allow_stale=True`, and then labels the answer (`warnings`, `atm_source`). Reading collections needs a `read` key; changing
  them needs the `paper` scope. `export`/`import_` move a collection as CSV or JSON.

## Candles over any range, and saving API calls

```python
candles = bridge.history_all("NSE:RELIANCE", "5m", "2024-01-01", "2024-12-31", local_first=True)
for c in candles:                  # typed Candle objects, oldest first, no duplicates
    ...
df = candles.to_dataframe()        # also .records(), .to_csv(path), .to_history(); freshness columns stay on
print(candles.freshness, candles.local_windows, candles.broker_windows, candles.gaps)
```

One `GET /v1/history` call covers only so much; `history_all` asks for windows that fit (and halves any the Bridge reports as
`partial`). With `local_first=True` the Bridge answers from data it already stored (real-time class, no gaps) and asks the
broker only for what is missing; `local_windows` and `broker_windows` show the split. Parquet is written only when `pyarrow`
is installed: `candles.to_parquet("x.parquet")` or `frames.csv_to_parquet("x.csv")` (the label goes in the file metadata).

## Events and webhooks

```python
for ev in bridge.events.subscribe(["download.*", "recording.gap"], since=saved_cursor):
    print(ev.cursor, ev.topic, ev.data)       # reconnects by itself; asks for events after the last cursor
```

`subscribe` reads `GET /v1/events/stream`, reconnects with growing waits and resumes from the last cursor, so a restart loses
nothing the Bridge still keeps. If the cursor you ask for is older than what the Bridge kept (or newer than it has), `sub.gap`
is true (`sub.gap_reason` is `retention` or `cursor_ahead`; `sub.on_gap` is called): read the current state from the API
again, then carry on. `bridge.events.poll(since=cursor)` is the same as one JSON answer for a script that runs now and then, and
`bridge.events.topics()` lists what your key may receive.

For a URL on your own server use `bridge.subscriptions.create(url, topics, secret=...)` (admin key, from the Bridge's
computer) and check every delivery before you trust it:

```python
from mrchartist_bridge import verify_signature
ok = verify_signature(SECRET, raw_body_bytes, request.headers)        # False: answer 401 and do not process it
```

The Bridge sends `X-Bridge-Signature: v1=<hex>` and `X-Bridge-Timestamp: <unix seconds>` (and `X-Bridge-Event-Id`,
`X-Bridge-Delivery`, `X-Bridge-Attempt`). The hex is the HMAC-SHA256 of `"<timestamp>." + the exact raw body`; a timestamp more
than 5 minutes off fails. Use the raw bytes as received. Delivery is at least once: de-duplicate on the `id` in the verified body (`X-Bridge-Event-Id` is not signed, so a captured copy could change it).
`raise_on_fail=True` raises `SignatureInvalid` with a `reason`. A delivery that keeps failing becomes a dead letter:
`bridge.subscriptions.dead_letters(id)`, `retry_dead_letter(id, letter)`, `retry_all_dead_letters(id)`, `clear_dead_letters(id)`;
`deliveries(id, outcome="dead")` is the attempt log.

## Rate limits and many symbols

`bridge.ltp_many(symbols)` and `quotes_many` split into requests the Bridge accepts and wait when throttled.
`mrchartist_bridge.batching.retry(fn)` retries a read honouring `Retry-After` and the refusal's `scope`
(`client`, `upstream`, `queue`, `consumer-cap`); it never retries an unknown order outcome.

## Alerts

`mrchartist_bridge.alerts` builds and checks the JSON an alert sends to a hook (`AlertMessage`), signs it for `generic` hooks
(`alerts.sign`), and sends it (`alerts.send`: a real alert, so a paper hook places a paper order). `bridge.hooks.test(...)` and
`bridge.hooks.signals(...)` use routes that newer Bridges add and raise `FeatureUnavailable` on older ones. This module follows
[alerts](webhooks.md) and is marked provisional until the message format is final.

## The original client and strategies

`BridgeClient` (one method per route, plain dicts, the Bridge's `{data, meta, errors}` envelope) is unchanged and is
`bridge.client`. `mrchartist_bridge.strategy` is kept as it was (`python -m mrchartist_bridge strategy run file.py`).
Tests: `python -m pytest sdk/python/tests -q`.
