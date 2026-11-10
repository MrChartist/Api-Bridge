# Re-check now (probe and egress lookup, each with a 30 s cooldown)

`POST /v1/readiness/check`

| | |
|---|---|
| Area | [Readiness](../README.md#readiness) |
| Operation | `checkReadiness` |
| Scope | `read` |
| This computer only | no |
| Guide | [deployment.md](../../guides/deployment.md) |

- An API key with the `read` scope (any key).

Runs the checks at once for one account (or every account this key may see). The broker read call and the egress lookup each have a 30 s cooldown; skipped parts are listed in meta.skipped. Waits at most 12 s, then answers with what it has.

## Request body

Optional, `application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountId` | no |  |

Example:

```json
{
  "account": "demo-paper"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Readiness snapshot after the check. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Readiness` | yes |  |
| `meta` | `Meta` + object | yes |  |

#### Fields of `data` (`Readiness`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `overall` | `ReadinessState` | yes | Account trading readiness. Open enum: new values may be added. |
| `summary` | string | yes |  |
| `checkedAt` | string (date-time) or null (date-time) | no |  |
| `disabled` | boolean | no | readiness.enabled is false. |
| `accounts` | array of `AccountReadiness` | yes |  |
| `paperOnly` | boolean | yes |  |
| `egress` | object | no | ip and seenBy only for callers on this computer or with the admin scope. |
| `schedule` | object | no |  |
| `automations` | object | no |  |
| `notifications` | object | no |  |
| `method` | string | yes |  |
| `referenceData` | `ReferenceDataFreshness` | no | How current the reference data shipped with the Bridge is (holidays, session hours, special sessions, freeze quantities, charges, delivery margin). It warns when the holiday calendar has no rows for next year or a dataset's asOf is older than six months. A warning never blocks an order. |
| `orderBook` | object | no | The read-only order-book check as one item (details on GET /v1/orders/drift). Only the accounts the key may use. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `INVALID_JSON` | 400 | no |
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | no |
| `RATE_LIMITED` | 429 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s -X POST "http://127.0.0.1:4300/v1/readiness/check" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account":"demo-paper"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("POST", "/v1/readiness/check", body={"account": "demo-paper"})
print(response.body)
```
