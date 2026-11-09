# Recent alerts of one hook, with what happened to each

`GET /v1/hooks/{hookId}/signals`

| | |
|---|---|
| Area | [Webhooks](../README.md#webhooks) |
| Operation | `listHookSignals` |
| Scope | `admin` |
| This computer only | yes |
| Guide | [webhooks.md](../../guides/webhooks.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

Newest first, bounded (`hooks.signalsKept`, memory only: the audit log is the durable record). Each entry has an
`outcome` and, where it applies, the reason and the order id. Alerts refused at the door because they were
unreadable (400) or stale are listed; wrong passphrases, refused addresses and rate limits are only counted.
Never contains an alert body, the URL token or a passphrase. A hook of an account the key may not use answers 404.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `hookId` | path | string, up to 40 characters | yes |  |
| `limit` | query | integer, min 1, max 200 | no | Default `50`. |
| `outcome` | query | `HookSignalOutcome` | no |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Recent alerts and counts. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `HookSignals` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`HookSignals`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `hookId` | string | yes |  |
| `label` | string | no |  |
| `source` | string | no |  |
| `mode` | one of `paper`, `live` | no |  |
| `lastSignalAt` | string (date-time) or null (date-time) | no |  |
| `serverTime` | string (date-time) | no |  |
| `countsSince` | string (date-time) | no | Counts start at this time (when the Bridge started or the hook was first used since). |
| `lastAuthFailureAt` | string (date-time) or null (date-time) | no |  |
| `counts` | object | yes | received, accepted, duplicate, stale, badRequest, authFailed, addressRefused, rateLimited, queueFull, keyRevoked, placed, awaitingConfirmation, rejected, failed, outcomeUnknown, dropped (only those that happened). |
| `queue` | object | no |  |
| `signals` | array of `HookSignal` | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `LOOPBACK_ONLY` | 403 | no |
| `SCOPE_REQUIRED` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/hooks/<hookId>/signals" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/hooks/<hookId>/signals")
print(response.body)
```
