# Mr. Chartist API Bridge — Python client

Standard library only (Python 3.9+), including a small built-in WebSocket client for live streams.

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()   # $MCB_BRIDGE_URL or http://127.0.0.1:4300; key from $MCB_API_KEY (or api_key=...)

r = bridge.ltp(["NSE:NIFTY", "NFO:NIFTY-2026-10-27-25000-CE"])
for item in r["data"]:
    print(item["symbol"], item["ltp"], item["freshness"]["source"], item["freshness"]["ageMs"])
print(r.get("errors"))    # symbols that failed, without failing the whole call

chain = bridge.option_chain("NIFTY", "2026-10-27", strikes=10)["data"]
candles = bridge.history("NSE:NIFTY", "5m", countback=300)["data"]["candles"]

# Paper order (the default). Live needs mode="live", a live-scoped key and an account enabled for live trading.
res = bridge.place_order({
    "account": "dhan-main", "symbol": "NFO:NIFTY-2026-10-27-25000-CE", "side": "BUY",
    "lots": 1, "product": "MARGIN", "orderType": "LIMIT", "price": 180,
})
print(res["data"]["orderId"], res["replayed"], res["idempotency_key"])
```

## What it does for you

- **Idempotency keys on every order write.** `place_order`, `modify_order`, `cancel_order` and `cancel_all_orders`
  send an `Idempotency-Key` (a fresh UUID unless you pass `idempotency_key=`). It is returned as
  `idempotency_key` and attached to errors. Sending the same key again returns the first result with
  `replayed=True`, so a retry can never create a second order.
- **Retries only when it is safe.** Retries happen when the Bridge marks an error `retryable` (waiting for
  `Retry-After`) and after network failures of reads. A write that gets no reply raises `BridgeConnectionError` with
  `outcome_unknown=True` and is never retried: check `orders()` / `order_by_client_id()`, or resend with the same
  `idempotency_key`. `OUTCOME_UNKNOWN` from the Bridge is never retried.
- **No proxies, no redirects.** System proxy variables are ignored and redirects are refused, so your key only ever
  goes to the Bridge. The key is not shown by `repr()`.
- **Freshness stays visible.** Methods return the Bridge's envelope `{"data", "meta", "errors"?}`.

Errors: `BridgeApiError` (`status`, `code`, `retryable`, `detail`, `request_id`, `errors`, `idempotency_key`) and
`BridgeConnectionError` (`outcome_unknown`, `timed_out`, `idempotency_key`).

## Live stream

```python
with bridge.stream(["NSE:NIFTY"], mode="quote", orders=True) as s:
    for msg in s:                                   # blocks; reconnects and re-subscribes by itself
        if msg["type"] == "tick":
            print(msg["symbol"], msg["ltp"])
        elif msg["type"] == "order":
            print(msg["order"]["status"])
```

Each connection uses a single-use token from `POST /v1/stream/token`. `s.subscribe([...], "ltp")`,
`s.unsubscribe([...])` and `s.close()` (safe from another thread) are available; `s.gaps` counts conflated
stretches (a slow reader skipped values; the newest value still arrives).

## Strategies

`mrchartist_bridge.strategy` is a small base class for trading strategy scripts:
`on_start`, `on_tick`, `on_bar`, `on_order_update`, `on_stop`, typed `Param`s, `buy` / `sell` / `exit` through the
Bridge's order API, and positions and P&L of the strategy's own orders. Examples in `examples/strategies/`. Tests: `pytest sdk/python/tests`.

## Methods

System `health`, `meta`, `brokers` · accounts `accounts`, `account`, `test_account`, `limits`, `usage` ·
instruments `search_instruments`, `instrument`, `convert_symbol`, `convert_symbols` · market data `ltp`, `quotes`,
`depth`, `history` (`format="csv"` returns text), `expiries`, `option_chain`, `stream_stats` · portfolio
`positions`, `holdings`, `funds` · orders `orders`, `order`, `order_by_client_id`, `trades`, `preview_order`,
`place_order`, `modify_order`, `cancel_order`, `cancel_all_orders` · paper `paper_account`, `reset_paper_account` ·
safety `safety`, `engage_kill_switch` · helpers `paginate`, `stream_token`, `stream_url`, `stream`, `request`.

Admin actions (API keys, broker sessions, the audit log, confirming AI-prepared tickets, releasing the kill switch)
are deliberately not in the SDK: use `mc-bridge` or the dashboard on the same computer.

Typed shapes for editors and type checkers: `mrchartist_bridge/models.py`.

## Tests

```
python3 -m unittest discover -s sdk/python/tests
```

The tests start the fake Bridge in `sdk/node/test/fakeServer.mjs` with Node (they are skipped without it); no broker
or real Bridge is involved.
