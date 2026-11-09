# Trading readiness of each live account (cached; no broker call)

`GET /v1/readiness`

| | |
|---|---|
| Area | [Readiness](../README.md#readiness) |
| Operation | `getReadiness` |
| Scope | `read` |
| This computer only | no |
| Guide | [deployment.md](../../guides/deployment.md) |

- An API key with the `read` scope (any key).

One state per account (ready, warn, cannot_trade, paper_only, unknown) with plain-English reasons and the facts each check used. Cached: no broker call and no lookup. IP addresses (egress.ip, checks.egress.detectedIp, registeredIp, backupIp) and the lookup host (seenBy) are present only for callers on this computer or with the admin scope; others see only whether the address matches.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `account` | query | array of `AccountId` | no |  |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | Readiness snapshot. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `Readiness` | yes |  |
| `meta` | `Meta` | yes |  |

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
curl -s "http://127.0.0.1:4300/v1/readiness" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/readiness")
print(response.body)
```
