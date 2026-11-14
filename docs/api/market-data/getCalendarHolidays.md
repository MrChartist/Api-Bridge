# Trading holidays of a year for an exchange

`GET /v1/calendar/holidays`

| | |
|---|---|
| Area | [Market data](../README.md#market-data) |
| Operation | `getCalendarHolidays` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

From the holiday list shipped with the Bridge (the NSE and BSE circulars; the list's date and source are in
`calendar`). Every row keeps its own `verified` flag. A year the list does not cover gives an empty list with
`calendar.covered: false`: that is "no data", not "no holidays". Weekends are not listed. NFO follows NSE and BFO
follows BSE. MCX and CDS have their own hours that this list does not hold (422).

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `exchange` | query | one of `NSE`, `BSE`, `NFO`, `BFO` | no | NSE (default), BSE, NFO or BFO. Default `"NSE"`. |
| `year` | query | integer, min 2000, max 2100 | no | Four-digit year (default this year, IST). |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | The holidays. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `CalendarHolidays` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`CalendarHolidays`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `exchange` | one of `NSE`, `BSE`, `NFO`, `BFO` | yes |  |
| `year` | integer | yes |  |
| `holidays` | array of object | yes |  |
| `specialSessions` | array of object | yes | Sessions on a day that is otherwise closed or has its own hours (Muhurat trading). |
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
curl -s "http://127.0.0.1:4300/v1/calendar/holidays" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/calendar/holidays")
print(response.body)
```
