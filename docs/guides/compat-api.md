# Compat REST and WebSocket API (`/api/v1`)

Many Indian algo tools, SDKs, AmiBroker and Excel add-ins and alert bridges speak one common REST style: `POST` a
JSON body to `/api/v1/<endpoint>` with the API key in the body as `apikey`, and read `{ "status": "success", ... }`
or `{ "status": "error", "message": ... }` back. The Bridge speaks it too, on its own port, so those tools can use
all your broker accounts with the Bridge's rate limiting and safety in between.

Point the tool at `http://127.0.0.1:4300` and give it a **Bridge API key** as its API key:

```bash
curl -X POST http://127.0.0.1:4300/api/v1/quotes -H "content-type: application/json" \
  -d '{ "apikey": "mcb_...", "symbol": "RELIANCE", "exchange": "NSE" }'
```

## Symbols

Compact trading symbols with an exchange code: `RELIANCE` / `NSE`, `NIFTY` / `NSE_INDEX`, `SENSEX` / `BSE_INDEX`,
`NIFTY27OCT2625000CE` / `NFO`, `NIFTY27OCT26FUT` / `NFO`. Products: `CNC`, `MIS` (Bridge `INTRADAY`), `NRML` (Bridge
`MARGIN`). Price types: `MARKET`, `LIMIT`, `SL`, `SL-M`. History intervals: `1m 3m 5m 10m 15m 30m 1h D W M`, dates
`YYYY-MM-DD`.

## Endpoints

| Group | Endpoints |
|---|---|
| Account | `ping`, `funds`, `orderbook`, `tradebook`, `positionbook`, `holdings`, `analyzer`, `analyzer/toggle` |
| Orders | `placeorder`, `placesmartorder` (towards `position_size`), `basketorder`, `splitorder` (`splitsize`), `modifyorder`, `cancelorder`, `cancelallorder`, `closeposition`, `orderstatus`, `openposition`, `optionsorder` (by `offset` ATM / ITMn / OTMn) |
| Market data | `quotes`, `multiquotes`, `depth`, `history`, `intervals` |
| Instruments | `symbol`, `search`, `expiry`, `optionchain`, `optionsymbol` |

`margin` answers with an error for now. Every endpoint is in [openapi.yaml](../openapi.yaml) under "Compat REST".

## Which account

Calls act on `compat.account` from the config, or else the first account the key may use. A Bridge extension: add
`"account": "<id>"` to any request body to pick another (the key must be allowed to use it).

## Orders are paper until you say otherwise

The Bridge starts every key in **analyzer mode**: orders are paper orders (replies carry `"mode": "analyze"`). To
send live orders:

1. turn live trading on the Bridge way: `safety.liveTrading`, the account's `live.enabled` with `"rest"` in
   `allowedSources` (see [safety.md](safety.md));
2. use a key with the `live` scope;
3. call `analyzer/toggle` with `{ "mode": false }`.

Every order still goes through the Bridge's validation, idempotency, safety limits, kill switch and audit log, and
data reads through its rate-limit engine. Market-data calls need a `read` key; order calls a `paper` (or `live`) key.

## WebSocket

`ws://127.0.0.1:4300/api/v1/ws`

```json
{ "action": "authenticate", "api_key": "mcb_..." }
{ "action": "subscribe", "mode": "Quote", "symbols": [{ "exchange": "NSE", "symbol": "RELIANCE" }, { "exchange": "NSE_INDEX", "symbol": "NIFTY" }] }
{ "action": "unsubscribe", "symbols": [{ "exchange": "NSE", "symbol": "RELIANCE" }] }
{ "action": "unsubscribe_all" }
```

Modes: `LTP` (1), `Quote` (2), `Depth` (3). Ticks arrive as
`{ "type": "market_data", "symbol", "exchange", "mode", "data": { "ltp", "open", "high", "low", "close", "volume", "oi", "bid", "ask", "timestamp" } }`.
Authenticate within 15 seconds. All clients share one upstream feed per broker account.

## Settings

```json
"compat": { "enabled": true, "account": "dhan-main", "analyzer": true }
```
