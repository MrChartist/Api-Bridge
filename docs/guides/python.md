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
