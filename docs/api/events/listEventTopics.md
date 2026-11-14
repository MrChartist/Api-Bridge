# The topics this key may receive

`GET /v1/events/topics`

| | |
|---|---|
| Area | [Events](../README.md#events) |
| Operation | `listEventTopics` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

A read key sees no admin-only topic. A filter may be a topic, a prefix such as `order.*`, or `*`.

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Topics. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | array of `EventTopic` | yes |  |
| `meta` | `Meta` | yes |  |

#### Each item of `data` (`EventTopic`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `topic` | string | yes |  |
| `scope` | one of `read`, `admin` | yes | The lowest scope that receives it. |
| `accountScoped` | boolean | yes | The data names an `accountId`; a key limited to some accounts only receives its own. |
| `description` | string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `UNAUTHENTICATED` | 401 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/events/topics" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/events/topics")
print(response.body)
```
