# Add an auto-record rule

`POST /v1/recordings/rules`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `createRecordingRule` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

For example: every trading day, record NIFTY and BANKNIFTY option chains, ATM +/- 10, current weekly expiry, every 30 seconds, during market hours. The universe is chosen again every day (and every 30 minutes for a moving ATM window); an ATM window is never built from a delayed or stale price.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |

## Request body

Required, `application/json`, schema `RecordingRuleCreate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | no |  |
| `name` | string, up to 60 characters | yes |  |
| `enabled` | boolean | no | Default `true`. |
| `kind` | one of `quotes`, `chain` | yes |  |
| `symbols` | array of `Symbol` | no |  |
| `collection` | string | no |  |
| `underlying` | string or array of string | no |  |
| `universe` | `RecordingUniverse` | no |  |
| `everySec` | integer, min 1 | yes |  |
| `schedule` | `RecordingSchedule` | no | market-hours (the exchange session of each trading day, from the market calendar) or chosen days and hours (IST; trading days only for NSE, BSE, NFO and BFO). |
| `keepDays` | integer or null | no |  |
| `maxDiskMb` | integer or null | no |  |
| `compress` | boolean | no |  |
| `format` | one of `csv`, `jsonl` | no | Default `"csv"`. |

Example:

```json
{
  "name": "watchlist-quotes",
  "kind": "quotes",
  "symbols": [
    "NSE:RELIANCE",
    "NSE:INFY"
  ],
  "everySec": 5
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | Created. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `RecordingRule` | yes | A rule as stored: everything RecordingRuleCreate takes, plus what the Bridge adds. (Written out in full, not as allOf over the create schema, because that one refuses unknown fields.) |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`RecordingRule`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string, up to 60 characters | yes |  |
| `enabled` | boolean | no | Default `true`. |
| `kind` | one of `quotes`, `chain` | yes |  |
| `symbols` | array of `Symbol` | no |  |
| `collection` | string | no |  |
| `underlying` | string or array of string | no |  |
| `universe` | `RecordingUniverse` | no |  |
| `everySec` | integer, min 1 | yes |  |
| `schedule` | `RecordingSchedule` | no | market-hours (the exchange session of each trading day, from the market calendar) or chosen days and hours (IST; trading days only for NSE, BSE, NFO and BFO). |
| `keepDays` | integer or null | no |  |
| `maxDiskMb` | integer or null | no |  |
| `compress` | boolean | no |  |
| `format` | one of `csv`, `jsonl` | no | Default `"csv"`. |
| `source` | one of `user`, `config` | no |  |
| `preset` | string | no |  |
| `recordingId` | string or null | no | The recording that carries this rule's files. |
| `state` | one of `recording`, `waiting`, `paused`, `stopped`, `blocked`, `off` | no |  |
| `statusText` | string | no |  |
| `blockedBy` | string or null | no |  |
| `createdAt` | string or null | no |  |
| `updatedAt` | string or null | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/recordings/rules" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"name":"watchlist-quotes","kind":"quotes","symbols":["NSE:RELIANCE","NSE:INFY"],"everySec":5}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/recordings/rules",
    body={
    "name": "watchlist-quotes",
    "kind": "quotes",
    "symbols": ["NSE:RELIANCE", "NSE:INFY"],
    "everySec": 5,
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
