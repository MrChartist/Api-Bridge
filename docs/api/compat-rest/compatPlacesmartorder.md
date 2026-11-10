# Order towards a target position size

`POST /api/v1/placesmartorder`

| | |
|---|---|
| Area | [Compat REST](../README.md#compat-rest) |
| Operation | `compatPlacesmartorder` |
| Scope | `apikey` in the body (read for data, paper or live for orders) |
| This computer only | no |
| Idempotency-Key | send one on every write |
| Guide | [compat-api.md](../../guides/compat-api.md) |

- Send your Bridge API key as `apikey` in the JSON body (no Authorization header).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

## Request body

Required, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `apikey` | string | yes | A Bridge API key (read for data, paper or live for orders). |
| `account` | string | no | Bridge extension: the account to act on (default compat.account, then the first the key may use). |

Example:

```json
{
  "apikey": "YOUR_API_KEY",
  "strategy": "my-script",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "action": "BUY",
  "product": "CNC",
  "pricetype": "MARKET",
  "position_size": 1
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Compat-style reply. | application/json: `CompatReply` |
| 4XX | Compat-style error reply. | application/json: `CompatReply` |
| 5XX | Compat-style error reply. | application/json: `CompatReply` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | one of `success`, `error` | yes |  |
| `message` | string | no |  |
| `mode` | one of `analyze` | no | Present while analyzer (paper) mode is on. |
| `data` | any | no |  |
| `orderid` | string or null | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |

## Examples

curl (set `MCB_API_KEY` to your key first; replace `YOUR_API_KEY` in the body):

```bash
curl -s -X POST "http://127.0.0.1:4300/api/v1/placesmartorder" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"apikey":"YOUR_API_KEY","strategy":"my-script","symbol":"RELIANCE","exchange":"NSE","action":"BUY","product":"CNC","pricetype":"MARKET","position_size":1}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
import os

from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/api/v1/placesmartorder",
    body={
    "apikey": os.environ["MCB_API_KEY"],
    "strategy": "my-script",
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "action": "BUY",
    "product": "CNC",
    "pricetype": "MARKET",
    "position_size": 1,
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
