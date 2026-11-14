# Add a broker or paper account (saved to the config file, usable at once)

`POST /v1/accounts`

| | |
|---|---|
| Area | [Accounts](../README.md#accounts) |
| Operation | `addAccount` |
| Scope | `admin` |
| This computer only | yes |
| Idempotency-Key | send one on every write |
| Guide | [accounts.md](../../guides/accounts.md) |

- An API key with the `admin` scope.
- This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).
- Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.

Adds the account to the config file the Bridge loaded (or creates the per-user bridge.config.json when it started
without one), keeping the file's other content, and starts using it without a restart. New accounts are always
paper only: live trading is turned on only by editing the config file. Without `id` the Bridge picks
`<broker>-main`, then `<broker>-2` ... (`paper`, `paper-2` ... for paper accounts). Log in afterwards with
POST /v1/accounts/{accountId}/session. Admin scope with an admin key that may use every account, this computer
only. Audited as `account.added`.

Demo mode saves a real broker's account for the next normal start instead (`savedForLater: true`,
`account: null`): the same paper-only entry is written to the file, nothing is loaded and no broker is
contacted. `leaveDemo: true` also removes `"demo": true` from the file. Paper accounts are refused in demo mode
(it has its own), and so is everything when the demo dashboard is served to other computers.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `Idempotency-Key` | header | string, up to 255 characters | no | Your unique id for this write (UUID recommended). A retry with the same key and the same body returns the first result with `Idempotency-Replayed: true`; a different body is refused with 409 IDEMPOTENCY_KEY_REUSED; a retry while the first is still running gets 409 IDEMPOTENCY_IN_PROGRESS. Keys are kept until the end of the IST trading day and at least 24 hours. For POST /v1/orders, `clientOrderId` in the body works the same way when the header is absent. The create routes that are not orders honour it too, with the same rules: keys, accounts, hooks, notify targets, collections (create, import, duplicate), downloads, dataset updates, subscriptions, recordings, recording rules and recording presets. For these the stored answer is kept in memory for 24 hours and is forgotten on restart, and a request that failed is forgotten at once so it can be retried. The compat order routes (`/api/v1/placeorder` and the other order writes) honour it too, and a client that cannot set headers may send `idempotency_key` in the body. Every other write route ignores the header, whatever its value, and says so with `Idempotency-Ignored: true` in the answer; a malformed key is a 400 only on a route that uses it. |

## Request body

Required, `application/json`, schema `AccountCreateRequest`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `broker` | string | yes | An adapter id from GET /v1/brokers, or paper. |
| `id` | string | no | Optional; the Bridge picks one when it is left out. |
| `label` | string, up to 60 characters | no | A name you will recognise. Optional. |
| `leaveDemo` | boolean | no | Demo mode only: also remove `"demo": true` from the config file, so the next start is normal. |

Example:

```json
{
  "broker": "paper",
  "id": "paper-2",
  "label": "Second paper account"
}
```

## Responses

| Status | Meaning | Body |
|---|---|---|
| 201 | The account was saved. `restartNeeded` is true only when it could not be loaded into the running Bridge. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 201 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | object | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `account` | `AccountSummary` or null | yes |  |
| `restartNeeded` | boolean | yes |  |
| `configFile` | string | yes | The config file the account was saved to. |
| `savedForLater` | boolean | no | Demo mode: saved to the file only, loaded on the next normal start. |
| `savedId` | string | no | Demo mode: the id the saved account will have. |
| `demoWasInFile` | boolean | no | Demo mode: the file itself turns demo mode on. |
| `demoTurnedOff` | boolean | no | Demo mode: `demo` was removed from the file (leaveDemo). |

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
curl -s -X POST "http://127.0.0.1:4300/v1/accounts" \
  -H "Authorization: Bearer $MCB_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-order-0001" \
  -d '{"broker":"paper","id":"paper-2","label":"Second paper account"}'
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request(
    "POST",
    "/v1/accounts",
    body={"broker": "paper", "id": "paper-2", "label": "Second paper account"},
    idempotency_key="my-order-0001",
)
print(response.body)
```
