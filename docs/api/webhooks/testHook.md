# Send a test alert through the real pipeline, as a paper order

`POST /v1/hooks/{hookId}/test`

| | |
|---|---|
| Area | [Webhooks](../README.md#webhooks) |
| Operation | `testHook` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [webhooks.md](../../guides/webhooks.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Builds a realistic alert for this hook (or reads the one you paste) and runs it through the same parsing, checks and
order path as a real alert, always as a PAPER order, never needing a confirmation, even on a live hook. Answers 200
with the outcome, because the test ran; a refusal (an unreadable or stale alert) is an outcome too. A test is not a
duplicate of an earlier one, does not touch `lastSignalAt`, and is not announced on the event bus. It does not prove
that TradingView can reach the hook.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `hookId` | path | string, up to 40 characters | yes |  |

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `alert` | string or object | no | An alert to run instead of the generated one: the message text, or its JSON object. A passphrase in it is not needed and is dropped. |
| `symbol` | string | no | Symbol for the generated alert (default: the hook's first allowed symbol, else NSE:RELIANCE). |
| `side` | one of `BUY`, `SELL`, `buy`, `sell` | no |  |
| `price` | number | no | Price for a LIMIT hook's generated alert (default: the current price). |

Example:

```json
{}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The outcome of the test. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `HookTestResult` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`HookTestResult`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `test` | one of `true` | yes |  |
| `mode` | one of `paper` | yes |  |
| `hookId` | string | no |  |
| `signalId` | string or null | no |  |
| `accepted` | boolean | yes | False when the alert was refused before it was queued (unreadable or stale). |
| `outcome` | `HookSignalOutcome` | yes | queued/processing: received, not finished. placed: an order was placed (paper or live). awaiting_confirmation: a person must confirm it in the Bridge. duplicate: seen before, not placed twice. stale: older than maxAgeSec. rejected: the hook's rules, the safety checks or the broker said no (see reason). refused: the alert could not be read, its time is ahead of this computer's clock, or it is against the hook's rules (a 400; see `cause`). failed / outcome_unknown / dropped: see reason. |
| `code` | string or null | no |  |
| `reason` | string or null | no |  |
| `orderId` | string or null | no |  |
| `summary` | string | yes |  |
| `message` | string or object | no | The alert that was run (never with a passphrase). |
| `note` | string | no |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/hooks/<hookId>/test" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/hooks/<hookId>/test", body={})
print(response.body)
```
