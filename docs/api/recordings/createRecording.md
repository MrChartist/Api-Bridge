# Start a recording of quotes or an option chain

`POST /v1/recordings`

| | |
|---|---|
| Area | [Recordings](../README.md#recordings) |
| Operation | `createRecording` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

Real-time class only: a dataClass other than realtime is refused, and a delayed or end-of-day answer is never written. everySec is at least 1 for quotes from the live feed (5 or more to read symbols the feed does not carry) and at least 15 for a chain. With sessionOnly (the default) it records only inside market hours, from the market calendar. One file per symbol per IST trading day.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. Every other write route ignores the header and says so with `Idempotency-Ignored: true` in the answer. |

## Request body

Required, `application/json`, schema `RecordingCreate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string, up to 60 characters | no |  |
| `kind` | one of `quotes`, `chain` | yes |  |
| `symbols` | array of `Symbol` | no |  |
| `collection` | string | no | A collection from the library; resolved again every day. |
| `underlying` | string or array of string | no | An index or stock name, or a list of them. |
| `expiry` | string (date) | no | With underlying: one expiry date (else the current weekly). |
| `strikes` | integer, min 0, max 100 | no | With underlying: strikes each side of the ATM (default 10). |
| `universe` | `RecordingUniverse` | no |  |
| `everySec` | integer, min 1, max 86400 | yes | Seconds between samples. At least 15 for a chain. |
| `sessionOnly` | boolean | no | Record only inside market hours (the market calendar). False records all day and rolls at IST midnight. Default `true`. |
| `format` | one of `csv`, `jsonl` | no | Default `"csv"`. |
| `keepDays` | integer or null | no | Keep this many days of files (today included); older day files are deleted. |
| `maxDiskMb` | integer or null | no | This recording's own disk limit. Writing stops before it is passed. |
| `compress` | boolean | no | Gzip the files of finished days. |
| `dataClass` | one of `realtime` | no | Only realtime is accepted; anything else is refused with the reason. |

Example:

```json
{
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
| 201 | Started. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Recording` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Recording`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `kind` | one of `quotes`, `chain` | yes |  |
| `status` | one of `recording`, `waiting`, `paused`, `stopped`, `blocked` | yes | waiting: outside the session, or no login yet. blocked: a disk limit was reached; nothing is written until there is room. |
| `statusText` | string | yes | The state in a plain sentence. |
| `auto` | boolean | no | True when a rule runs it. |
| `ruleId` | string or null | no |  |
| `target` | object | no |  |
| `everySec` | integer | yes |  |
| `sessionOnly` | boolean | no |  |
| `schedule` | string or object | no | always, market-hours, or chosen days and hours. |
| `format` | one of `csv`, `jsonl` | no |  |
| `createdAt` | string | no |  |
| `dataClass` | one of `realtime` | yes |  |
| `delaySec` | integer | no |  |
| `source` | string | no |  |
| `symbols` | object | no |  |
| `rows` | integer | yes |  |
| `bytes` | integer | yes |  |
| `today` | object | no |  |
| `lastWriteAt` | string or null | no |  |
| `gaps` | object | no |  |
| `refused` | object | no | Answers that were not real-time and so were not written. |
| `apiCalls` | object | no |  |
| `disk` | object | no |  |
| `keepDays` | integer or null | no |  |
| `nextStartAt` | string or null | no |  |
| `issue` | object or null | no |  |
| `problem` | `FailureReason` or null | no | What is wrong right now (a full disk, no login, symbols that could not be chosen, a silent feed): the real text, its code and the fix. null when all is well. |
| `filesUrl` | string | no |  |
| `files` | object | no | On GET /v1/recordings/{recordingId} only. |

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
curl -s -X POST "http://127.0.0.1:4300/v1/recordings" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"kind":"quotes","symbols":["NSE:RELIANCE","NSE:INFY"],"everySec":5}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/recordings",
    body={
    "kind": "quotes",
    "symbols": ["NSE:RELIANCE", "NSE:INFY"],
    "everySec": 5,
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
