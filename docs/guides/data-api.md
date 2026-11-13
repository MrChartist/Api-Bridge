# The data API: one place for market data

Point every project at the Bridge and it reads prices, history, option chains and instruments from whichever broker
accounts are connected, through one set of calls. Your projects never hold a broker token, never deal with a
broker's symbol names, and share one rate-limit budget, so two projects cannot push each other over a broker's limit.

This page is the contract for the data calls. The full description of every route is
[`docs/openapi.yaml`](../openapi.yaml), also served by a running Bridge at `/openapi.yaml`.

## Connect

```bash
# .env in your project
MCB_URL=http://127.0.0.1:4300
MCB_API_KEY=            # empty on the computer the Bridge runs on
```

- **Same computer:** no key is needed. A plain request works.
- **Another computer:** create a key in the dashboard (**API → Keys**, read only is enough for data) and send it as
  `Authorization: Bearer <key>`. See [deployment.md](deployment.md) for reaching the Bridge from elsewhere.
- **A web page in a browser** on a different address (for example `http://localhost:3000`) is refused unless that
  address is listed in `cors.allowedOrigins` in `bridge.config.json`. There is no wildcard. A page's backend does
  not need this, only code running in the browser. Never put a key with more than `read` in browser code.

The dashboard has the same thing ready to copy: **API → Integrations → Your project**.

## The calls

All are `GET` and answer JSON as `{ "data": ..., "meta": ... }`.

| What | Call |
|---|---|
| Last price | `/v1/ltp?symbols=NSE:NIFTY,NSE:RELIANCE` |
| Full quote (OHLC, change, volume, OI, best bid and ask) | `/v1/quotes?symbols=NSE:RELIANCE` |
| Market depth (5 levels) | `/v1/depth?symbol=NSE:RELIANCE` |
| Candles | `/v1/history?symbol=NSE:RELIANCE&interval=5m&countback=300` |
| Candles for a date range | `/v1/history?symbol=NSE:RELIANCE&interval=1d&from=2026-01-01&to=2026-06-30` |
| The same as a CSV file | add `&format=csv` |
| Expiry dates | `/v1/expiries?underlying=NIFTY` |
| Option chain with greeks | `/v1/optionchain?underlying=NIFTY&expiry=2026-11-17&strikes=10&greeks=true` |
| Find an instrument | `/v1/instruments/search?q=banknifty fut&limit=5` |
| One instrument (lot size, tick size, expiry) | `/v1/instruments/NSE:RELIANCE` |
| Turn any symbol spelling into the Bridge's | `/v1/symbols/convert?input=NSE:NIFTY1!` |

- **Symbols** are `EXCHANGE:NAME`: `NSE:RELIANCE`, `NSE:NIFTY`, `NFO:NIFTY-2026-11-23-FUT`,
  `NFO:NIFTY-2026-11-17-24500-CE`. The same symbol works whichever broker answers.
- **`symbols`** takes up to 200 per call. Ask for many in one call, not one call each: the Bridge batches them into
  as few broker calls as possible.
- **`interval`** is one of `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `60m`, `1d`, `1w`, `1M`.
- **History** takes either `from` (and optionally `to`), or `countback` (up to 5000 bars ending at `to` or now). A
  long range is fetched from the broker in pieces and returned as one answer. Candle `time` is Unix seconds at the
  start of the bar; the CSV writes dates and times in IST.
- **`account=`** pins a call to one account. Leave it out and the Bridge picks a connected account that can answer.
- **`maxAgeMs=`** says how old an answer you accept (up to one hour). `0` forces a fresh read from the broker;
  leaving it out uses the Bridge's defaults, which serve from the live stream and cache whenever they can.

## Reading an answer

```json
{
  "data": [
    { "symbol": "NSE:RELIANCE", "ltp": 1504.7,
      "freshness": { "source": "broker", "asOf": "2026-11-13T22:45:24.210+05:30", "ageMs": 2, "stale": false, "accountId": "dhan-main", "broker": "dhan" } }
  ],
  "errors": [],
  "meta": { "requestId": "req_959c8cd4b47c4c78a696" }
}
```

- **`freshness`** tells you where a value came from (`broker`, `stream` or `cache`), when, and whether it is
  `stale`. Check `stale` before acting on a price.
- **Calls that take several symbols answer `200` even when some symbols fail.** The good ones are in `data`; each
  failure is in `errors` as `{ symbol, code, message }`. Always read `errors`.
- **In demo mode** `meta.demo` is `true` and `meta.dataNotice` says the prices are samples. A project that must
  never trade on sample data should check `meta.demo`.

## When a call fails

A failed call answers with a problem document and a matching HTTP status:

```json
{ "status": 400, "code": "VALIDATION_FAILED", "title": "The request is not valid",
  "detail": "symbols is required: a comma-separated list such as NSE:NIFTY,NSE:RELIANCE.",
  "retryable": false, "requestId": "req_d4c59e3fe46746c79943",
  "errors": [ { "path": "symbols", "message": "symbols is required: ..." } ] }
```

- Branch on **`code`**, not on the text: codes are stable, wording may improve.
- **`retryable`** says whether trying again can work. On `429` wait for the `Retry-After` header.
- Quote **`requestId`** when asking for help; the dashboard's **API → Activity** finds the call by it.

## Live prices without polling

For prices that change every second, subscribe once instead of calling in a loop: a WebSocket at `/v1/stream` or
server-sent events at `/v1/stream/sse` push ticks and order updates. See [streaming.md](streaming.md).

To be told about **order** changes at a URL in your project, see [forwarding.md](forwarding.md).

## Rate limits

Every broker limits calls per second and per minute. The Bridge keeps one budget per account and shares it between
all your projects: repeated and overlapping reads are answered from the stream and cache, identical calls in flight
are merged, and the rest queue briefly. Responses carry `RateLimit` and `RateLimit-Policy` headers. The dashboard's
**API → Rate limits** shows who is using the budget. See [rate-limits.md](rate-limits.md).

## Collect history in bulk

The dashboard's **Data** page backfills up to 50 symbols at once into one CSV or JSON file, trying the next source
when one cannot answer. From code, loop over `/v1/history` yourself; the rate limiter paces the calls.

## What stays the same

- Paths start with `/v1`. Fields are added over time; a field is not removed or changed in meaning within `/v1`.
  Write clients that ignore fields they do not know.
- Error `code` values, symbol format and the `{ data, meta }` envelope are part of the contract.
- A client library is optional: [python.md](python.md) and [typescript.md](typescript.md) describe the two SDKs, and
  the starters under **Your project** need no packages at all.
