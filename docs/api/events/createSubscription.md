# Send events to a URL, signed (this computer only)

`POST /v1/subscriptions`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `createSubscription` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

The target is an outside URL, so this works from this computer only. Only https URLs on public addresses are accepted
(the config file can allow others). The secret is write-only: it is stored encrypted and never returned. Receivers
verify `X-Bridge-Signature` (see docs/guides/events.md).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

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
  "url": "https://hooks.example.com/bridge",
  "topics": [
    "order.*",
    "download.done"
  ],
  "secret": "replace-with-a-long-random-string"
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
| `IDEMPOTENCY_IN_PROGRESS` | 409 | yes |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/subscriptions" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"url":"https://hooks.example.com/bridge","topics":["order.*","download.done"],"secret":"replace-with-a-long-random-string"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/subscriptions",
    body={
    "url": "https://hooks.example.com/bridge",
    "topics": ["order.*", "download.done"],
    "secret": "replace-with-a-long-random-string",
},
    idempotency_key="my-order-0001",
)
print(response.body)
```
