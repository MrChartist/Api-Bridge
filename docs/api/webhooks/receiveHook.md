# Inbound alert (TradingView, signed generic, ChartInk or GoCharting)

`POST /hooks/{source}/{token}`

| | |
|---|---|
| Area | [Webhooks](../README.md#webhooks) |
| Operation | `receiveHook` |
| Scope | none (no API key) |
| This computer only | no |
| Guide | [webhooks.md](../../guides/webhooks.md) |

- No Bridge key. The hook token in the URL is the credential (generic hooks also need a signature).
- Served on the public ingress listener when it is enabled.

Answers within milliseconds (alert services give up after a few seconds) and processes the signal in the background,
through the same preview and safety checks as any order. The hook decides what an alert may do (account,
symbols, quantity caps, paper or live, whether a human must confirm). `generic` hooks must send
`X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`; requests older than 5 minutes or
replayed are refused. Served on the public ingress listener when it is enabled.

`tradingview` hooks cannot sign (TradingView cannot add headers): the credential is the secret URL plus a
`passphrase` field inside the alert message (a JSON field, or `passphrase=...` in a plain-text alert), checked in
constant time before anything else is read. Wrong or missing: 401. The message is JSON (when TradingView sends
`application/json`) or one line of text (`text/plain`); see the `TradingViewAlert` schema. An alert older than
the hook's `maxAgeSec` (from its `time`) is refused with 400; a repeat of the same id + time + symbol + side is
acknowledged as `duplicate: true`. A rejected order after the 202 is shown in
`GET /v1/hooks/{hookId}/signals` and announced on the event bus as `hook.rejected`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `source` | path | one of `generic`, `chartink`, `gocharting`, `tradingview` | yes |  |
| `token` | path | string, up to 128 characters | yes | The hook's secret token (shown once when the hook is created). It is the credential ChartInk and GoCharting can carry, since they cannot sign requests; TradingView adds a `passphrase` inside the alert message. |
| `X-MCB-Signature` | header | string | no |  |

## Request body

Required, `application/json`.

A JSON object.

Example:

```json
{
  "symbol": "NSE:RELIANCE",
  "side": "BUY",
  "quantity": 1,
  "orderType": "MARKET",
  "id": "sig-1"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 202 | Accepted for processing. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 202 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `accepted` | boolean | yes |  |
| `signalId` | string | yes |  |
| `duplicate` | boolean | no | The same alert was already received (same id and time for TradingView); nothing new was queued. |
| `dropped` | integer | no | Orders in the alert that were dropped before queueing (for example over the per-alert cap). |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/hooks/generic/<hook token>" \
  -H "Content-Type: application/json" \
  -H "X-MCB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>" \
  -d '{"symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"orderType":"MARKET","id":"sig-1"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/hooks/generic/<hook token>",
    body={
    "symbol": "NSE:RELIANCE",
    "side": "BUY",
    "quantity": 1,
    "orderType": "MARKET",
    "id": "sig-1",
},
)
print(response.body)
```
