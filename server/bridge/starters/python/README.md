# Python starter for the Bridge

A small project that talks to your Bridge at `{{baseUrl}}`. Python 3.9 or newer, nothing to install.

## Three steps

1. {{keyStep}}
2. Run the first call:

   ```bash
   cd {{folder}}
   python3 main.py
   ```

   You should see the Bridge's version and two prices. In demo mode they are sample prices and it says so.
3. Try the others:

   ```bash
   python3 examples/history.py NSE:RELIANCE 5m 20    # candles
   python3 examples/download.py NSE:RELIANCE 5m      # data files (newer Bridges)
   python3 examples/events.py 30                     # live events (newer Bridges)
   ```

On Windows, type `py` where this page says `python3` (for example `py main.py`).

## What is here

| File | What it is |
|---|---|
| `bridge.py` | A small client (standard library only): reads `.env`, sends the key in a header, turns errors into `BridgeError` with a stable `code`, retries only what is safe |
| `main.py` | Health and prices |
| `examples/` | History, data downloads, events. The last two say so plainly when the Bridge is too old to have them |
| `.env` | The address and the key. It is in `.gitignore`: never commit it, never paste it into a chat |

When you want typed candles, data frames and streaming, use the fuller client in the Bridge's `sdk/python` folder
(`pip install <your Bridge folder>/sdk/python`). Everything here keeps working beside it.

## The key

{{keyNote}}

A `read` key can read prices, history, option chains and your positions. It cannot place an order. If a call answers
`SCOPE_REQUIRED`, the key is too small for it: make a new key with the scope that call needs, do not widen one you
shared. The dashboard's **Developers** page has a scope finder and the full list of error codes; the same list is at
`GET {{baseUrl}}/v1/errors`.

## Handling errors

```python
from bridge import Bridge, BridgeError
try:
    Bridge().get("/v1/ltp", {"symbols": "NSE:RELIANCE"})
except BridgeError as err:
    if err.code == "RATE_LIMITED":
        pass  # it already waited and retried 3 times
```

For an order, always send an idempotency key: `bridge.post("/v1/orders", order, idempotency_key=str(uuid.uuid4()))`.
A repeat with the same key and body returns the first result; it never places a second order.
