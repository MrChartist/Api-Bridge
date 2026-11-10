# The session of one date (trading day or not, and the times)

`GET /v1/calendar/sessions`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getCalendarSessions` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

Whether the date is a trading day and why not when it is not (weekend, holiday), the pre-open, open and close
times (IST), a special session such as Muhurat trading, and the neighbouring trading days. The hours come from
dated rules in the data shipped with the Bridge (derivatives close at 15:40 from 3 Aug 2026 and 15:45 from 7 Dec
2026); `sessionTimes.rule` names the rule, its circular and its source, and `sessionTimes.verified: false` says the
hours were not confirmed from a circular. A special session carries its own `verified` flag: while it is false the
timing is unconfirmed, and live orders are refused in it.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `exchange` | query | one of `NSE`, `BSE`, `NFO`, `BFO` | no | Default `"NSE"`. |
| `date` | query | string (date) | no | A real date, YYYY-MM-DD (default today, IST). |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The session. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CalendarSession` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CalendarSession`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `exchange` | one of `NSE`, `BSE`, `NFO`, `BFO` | yes |  |
| `date` | string (date) | yes |  |
| `weekday` | string | yes |  |
| `isTradingDay` | boolean | yes |  |
| `reason` | string | yes |  |
| `preOpen` | object or null | no |  |
| `open` | string or null | no | IST HH:MM; null on a day that does not trade. |
| `close` | string or null | no |  |
| `holiday` | object or null | no |  |
| `specialSession` | object or null | no |  |
| `sessionTimes` | `CalendarSessionTimes` | yes |  |
| `previousTradingDay` | string (date) | no |  |
| `nextTradingDay` | string (date) | no |  |
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
curl -s "http://127.0.0.1:4300/v1/calendar/sessions" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/calendar/sessions")
print(response.body)
```
