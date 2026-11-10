# The concrete symbols of an option universe that is not saved yet

`POST /v1/collections/resolve`

| | |
|---|---|
| Area | [Collections](../README.md#collections) |
| Operation | `resolveCollectionDraft` |
| Scope | `read` |
| This computer only | no |

- An API key with the `read` scope (any key).

The preview behind the collection builder: the same work as `GET /v1/collections/{name}/resolve`, for a universe you
are still editing. Nothing is saved. The price rules are the same: a delayed, end-of-day or stale price for the
at-the-money strike is refused (422 or 503) unless `allowStale=true`, and then the answer says so in `atmSource` and
`warnings`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `allowStale` | query | boolean | no | Accept a stale, delayed or end-of-day price for the ATM (it is labelled). |
| `spot` | query | number | no | Work out the ATM from this price instead of reading one. |
| `account` | query | `AccountId` | no | Pin the request to this account. Without it, market data may be served from any of your accounts that allow pooling. |

## Request body

Required, `application/json`, schema `CollectionResolveDraft`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `kind` | one of `option-universe` | no |  |
| `universe` | `CollectionUniverse` | yes | An option universe: which contracts of one underlying, worked out each time the collection is used. |

Example:

```json
{
  "kind": "option-universe",
  "universe": {
    "underlying": "NIFTY",
    "expiries": "current-weekly",
    "strikes": {
      "around": "atm",
      "count": 10
    },
    "sides": [
      "CE",
      "PE"
    ]
  }
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The symbols for now. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CollectionDraftResolution` | yes | What `CollectionResolution` says, for a universe that is not saved (so it has no id or name). |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CollectionDraftResolution`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `draft` | one of `true` | yes |  |
| `kind` | one of `option-universe` | yes |  |
| `resolvedAt` | string (date-time) | yes |  |
| `rule` | string | yes | The rule that was used, in words (expiry rule, strikes, sides). |
| `symbols` | array of `Symbol` | yes |  |
| `count` | integer | yes |  |
| `atmSource` | `atmSource` | yes | Where the price behind the at-the-money strike came from. `live` is a realtime price with the market open; `last-close` the previous close (market closed or in pre-open); `supplied` the `spot` you passed; `stale`, `delayed` and `eod` only with `allowStale`. |
| `strikeSource` | `strikeSource` | no | `grid`: no listed strikes were found, so the strikes are generated on the usual step (index underlyings only); some may not exist. |
| `underlying` | `underlying` | no |  |
| `expiries` | `expiries` | no |  |
| `warnings` | array of string | yes |  |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `ACCOUNT_FORBIDDEN` | 403 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/collections/resolve" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"option-universe","universe":{"underlying":"NIFTY","expiries":"current-weekly","strikes":{"around":"atm","count":10},"sides":["CE","PE"]}}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/collections/resolve",
    body={
    "kind": "option-universe",
    "universe": {
        "underlying": "NIFTY",
        "expiries": "current-weekly",
        "strikes": {"around": "atm", "count": 10},
        "sides": ["CE", "PE"],
    },
},
)
print(response.body)
```
