# Is the exchange open now, and when does it next open

`GET /v1/calendar/status`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getCalendarStatus` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

`open`, `pre-open` or `closed`, by the Bridge's clock in IST, with the reason (a holiday is named), when it closes
or opens and the next regular or special open. This is the calendar's answer, not the exchange's live state: a
halt or an unlisted closure is not in it. Read `calendar.verified` and `calendar.note`.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `exchange` | query | one of `NSE`, `BSE`, `NFO`, `BFO` | no | Default `"NSE"`. |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The status. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CalendarStatus` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CalendarStatus`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `exchange` | one of `NSE`, `BSE`, `NFO`, `BFO` | yes |  |
| `status` | one of `open`, `pre-open`, `closed` | yes |  |
| `reason` | string | yes |  |
| `closedBecause` | one of `weekend`, `holiday`, `before-open`, `after-close`, `null` | no |  |
| `asOf` | string (date-time) | yes | The Bridge's clock, IST. |
| `date` | string (date) | yes |  |
| `time` | string | yes | IST HH:MM. |
| `opensAt` | string (date-time) or null (date-time) | no | Pre-open only. Today's open. |
| `closesAt` | string (date-time) or null (date-time) | no | Open and pre-open only. |
| `nextOpen` | object or null | no |  |
| `sessionTimes` | `CalendarSessionTimes` | yes |  |
| `calendar` | `CalendarInfo` | yes | What the answer rests on. `verified` is false when the date is outside the covered years or a row used is not verified. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/calendar/status" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/calendar/status")
print(response.body)
```
