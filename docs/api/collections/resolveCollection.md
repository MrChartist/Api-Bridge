# The concrete symbols of a collection right now

`GET /v1/collections/{name}/resolve`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `resolveCollection` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

A static collection answers its list. An option universe is worked out now: the expiry rule rolls on by itself, and
the at-the-money strike comes from the live price of the underlying. The answer says which price it used
(`atmSource`). A price that is delayed, end-of-day or stale is refused with an error (422 or 503) unless
`allowStale=true`, and then it is labelled and warned about. With the market closed the price is the last close and
`atmSource` is `last-close`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `name` | path | string, up to 64 characters | yes |  |
| `allowStale` | query | boolean | no | Accept a stale, delayed or end-of-day price for the ATM (it is labelled). |
| `requireLive` | query | boolean | no | Refuse any price that is not live (for a caller that records or downloads at once). Default `false`. |
| `spot` | query | number | no | Work out the ATM from this price instead of reading one. |
| `priority` | query | one of `interactive`, `background` | no | Default `"interactive"`. |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The symbols for now. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CollectionResolution` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CollectionResolution`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `name` | string | yes |  |
| `kind` | one of `static`, `option-universe` | yes |  |
| `resolvedAt` | string (date-time) | yes |  |
| `rule` | string | yes | The rule that was used, in words (expiry rule, strikes, sides). |
| `symbols` | array of `Symbol` | yes |  |
| `count` | integer | yes |  |
| `atmSource` | one of `not-needed`, `live`, `last-close`, `supplied`, `stale`, `delayed`, `eod` | yes | Where the price behind the at-the-money strike came from. `live` is a realtime price with the market open; `last-close` the previous close (market closed or in pre-open); `supplied` the `spot` you passed; `stale`, `delayed` and `eod` only with `allowStale`. |
| `strikeSource` | one of `listed`, `grid` | no | `grid`: no listed strikes were found, so the strikes are generated on the usual step (index underlyings only); some may not exist. |
| `underlying` | object | no |  |
| `expiries` | array of object | no |  |
| `viaOldName` | boolean | no |  |
| `warnings` | array of string | yes | Plain sentences: a last-close or stale price, a shifted expiry, an expired contract, a skipped date. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/collections/large-caps/resolve" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/collections/large-caps/resolve")
print(response.body)
```
