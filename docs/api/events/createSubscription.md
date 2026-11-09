# Send events to a URL, signed (this computer only)

`POST /v1/subscriptions`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `createSubscription` |
| Scope | `admin` |
| This computer only | yes |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).

The target is an outside URL, so this works from this computer only. Only https URLs on public addresses are accepted
(the config file can allow others). The secret is write-only: it is stored encrypted and never returned. Receivers
verify `X-Bridge-Signature` (see docs/guides/events.md).

## Request body

Required, `application/json`, schema `SubscriptionCreate`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string, up to 2048 characters | yes | https:// on a public address. No user name or password. The config file can allow http and private addresses; cloud metadata addresses are always refused. |
| `topics` | array of string | yes | Topics, prefixes such as `order.*`, or `*`. See `GET /v1/events/topics`. |
| `secret` | string, up to 256 characters | yes | The signing secret. Write-only: stored encrypted, never returned. |
| `active` | boolean | no | Default `true`. |
| `label` | string, up to 60 characters | no |  |
| `accounts` | one of `*` or array of `AccountId` | no | Only events about these accounts (default "*"). |

Example:

```json
{
  "url": "<url>",
  "topics": [
    "<topics>"
  ],
  "secret": "xxxxxxxxxxxxxxxx"
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
| `data` | `Subscription` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`Subscription`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `label` | string or null | no |  |
| `target` | string | yes | Scheme and host, with an ellipsis when the URL has a path or query (which may be a secret). |
| `host` | string | yes |  |
| `topics` | array of string | yes |  |
| `accounts` | one of `*` or array of string | yes |  |
| `active` | boolean | yes |  |
| `signing` | object | yes |  |
| `createdAt` | string (date-time) | yes |  |
| `updatedAt` | string (date-time) | yes |  |
| `health` | object | yes |  |
| `pending` | integer | yes | Events waiting to be sent or retried. |
| `deadLetters` | integer | yes |  |

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
curl -s -X POST "http://127.0.0.1:4300/v1/subscriptions" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"<url>","topics":["<topics>"],"secret":"xxxxxxxxxxxxxxxx"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/subscriptions",
    body={"url": "<url>", "topics": ["<topics>"], "secret": "xxxxxxxxxxxxxxxx"},
)
print(response.body)
```
