# curl starter for the Bridge

Shell scripts that talk to your Bridge at `{{baseUrl}}`. They need `bash` and `curl`; `jq` is used to format JSON
when you have it.

## Three steps

1. {{keyStep}}
2. Run the first call:

   ```bash
   cd {{folder}}
   bash quote.sh
   ```

   You should see the Bridge's health and two prices. In demo mode they are sample prices and it says so.
3. Try the others:

   ```bash
   bash history.sh NSE:RELIANCE 5m 20    # candles
   bash download.sh NSE:RELIANCE 5m      # data files (newer Bridges)
   bash events.sh 30                     # live events (newer Bridges)
   ```

## What is here

| File | What it is |
|---|---|
| `lib.sh` | One function, `bridge METHOD PATH`: reads `.env`, sends the key in a header, retries a read on 429 as long as `Retry-After` says |
| `quote.sh`, `history.sh` | Prices and candles |
| `download.sh`, `events.sh` | Data files and live events. They say so plainly when the Bridge is too old to have them |
| `.env` | The address and the key. It is in `.gitignore`: never commit it, never paste it into a chat |

The plain form, for any call:

```bash
curl -sS -H "Authorization: Bearer $BRIDGE_KEY" "{{baseUrl}}/v1/ltp?symbols=NSE:RELIANCE"
```

Never put the key in the address.

## The key

{{keyNote}}

A `read` key can read prices, history, option chains and your positions. It cannot place an order. If a call answers
`SCOPE_REQUIRED`, the key is too small for it: make a new key with the scope that call needs. The dashboard's
**Developers** page has a scope finder and the full list of error codes; the same list is at `GET {{baseUrl}}/v1/errors`.

For an order, always send an `Idempotency-Key` header. A repeat with the same key and body returns the first result; it
never places a second order.
